import { ResolvedSkillContext, ResolvedSkillContexts, type Item } from "@agent-service/protocol";
import type { EngineInputPart, TranscriptMessage } from "../engine/types.js";
import { estimateTokens, renderSkillContext, stableStringify } from "./assemble.js";

/** Reads only typed server-side item metadata, never a user/LLM text marker or a current file. */
export function collectResolvedSkillContexts(items: readonly Item[]): ResolvedSkillContext[] {
  const snapshots = new Map<string, ResolvedSkillContext>();
  const calls = new Map(items.filter(item => item.type === "toolCall").map(item => [`${item.turnId}:${item.toolCallId}`, item]));
  const add = (value: unknown) => {
    const parsed = ResolvedSkillContext.safeParse(value);
    if (!parsed.success) throw new Error("Resolved skill context is invalid.");
    const context = parsed.data, key = `${context.id}:${context.versionSha256}`;
    const previous = snapshots.get(key);
    if (previous && stableStringify(previous) !== stableStringify(context)) throw new Error("Resolved skill context is invalid.");
    snapshots.set(key, context);
  };
  for (const item of items) {
    if (item.type === "userMessage" || item.type === "contextCompaction") {
      if (item.skillContexts !== undefined) {
        const parsed = ResolvedSkillContexts.safeParse(item.skillContexts);
        if (!parsed.success) throw new Error("Resolved skill context is invalid.");
        parsed.data.forEach(add);
      }
    } else if (item.type === "toolResult" && !item.isError
      && calls.get(`${item.turnId}:${item.toolCallId}`)?.kind === "skill") {
      const details = item.details;
      if (details && typeof details === "object" && Object.hasOwn(details, "skillContext")) {
        if (Object.getPrototypeOf(details) !== Object.prototype || Object.keys(details).length !== 1) throw new Error("Resolved skill context is invalid.");
        add((details as { skillContext: unknown }).skillContext);
      }
    }
  }
  const result = ResolvedSkillContexts.safeParse([...snapshots.values()]);
  if (!result.success) throw new Error("Resolved skill context limit exceeded.");
  return result.data;
}

export const RECOVERY_NOT_STARTED =
  "TOOL_NOT_STARTED: the runner restarted before this tool call began. It was never executed. Decide whether to call it again.";
export const RECOVERY_OUTCOME_UNKNOWN =
  "TOOL_OUTCOME_UNKNOWN: the runner restarted while this tool was executing. Its side effects may or may not have happened. Verify before repeating any non-idempotent action.";

export interface ProjectionResult {
  messages: TranscriptMessage[];
  /** tool call ids that were repaired with synthetic results (for logging/metrics) */
  repaired: { toolCallId: string; code: "TOOL_NOT_STARTED" | "TOOL_OUTCOME_UNKNOWN" }[];
}

const planningImagePlaceholder = (blobId: string): EngineInputPart => ({
  type: "text",
  text: `[historical image ${blobId} omitted from lightweight context planning]`,
});

interface ProjectionOptions {
  /** Planning never consumes image bytes; persisted image references become explicit text markers. */
  lightweightImages: boolean;
}

/**
 * Project persisted items (after the last compaction) into an engine transcript.
 *
 * Invariants:
 *  - every toolCall gets exactly one toolResult (missing ones are synthesized with a recovery code,
 *    so the model receives the evidence, not a conclusion);
 *  - the assistant message of a step is rebuilt as reasoning → text → toolCalls;
 *  - compaction summaries lead the transcript as a system message.
 */
export function projectItems(items: Item[]): ProjectionResult {
  return projectItemsWithOptions(items, { lightweightImages: false });
}

/**
 * Project persisted items without requiring Blob bytes.
 *
 * This view is for token planning and compaction input selection only. An image reference becomes
 * an explicit text marker so callers can plan raw persisted history before hydrating the retained
 * tail. The normal `projectItems` path remains strict and rejects unmaterialized images.
 */
export function projectItemsForPlanning(items: Item[]): ProjectionResult {
  return projectItemsWithOptions(items, { lightweightImages: true });
}

function projectItemsWithOptions(items: Item[], options: ProjectionOptions): ProjectionResult {
  const sorted = [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  // Validate authority across the whole retained surface, not merely within one message: a
  // repeated id/version with different bytes must never silently win by projection order.
  collectResolvedSkillContexts(sorted);
  const messages: TranscriptMessage[] = [];
  const repaired: ProjectionResult["repaired"] = [];

  type Group = { key: string; assistant: Extract<TranscriptMessage, { role: "assistant" }>; calls: Extract<Item, { type: "toolCall" }>[] };
  let group: Group | undefined;
  const results = new Map<string, Extract<Item, { type: "toolResult" }>>();
  for (const it of sorted) if (it.type === "toolResult") results.set(it.toolCallId, it);

  const flushGroup = () => {
    if (!group) return;
    const g = group;
    group = undefined;
    if (!g.assistant.text && !g.assistant.reasoning && g.assistant.toolCalls.length === 0) return;
    messages.push(g.assistant);
    for (const call of g.calls) {
      const r = results.get(call.toolCallId);
      if (r) {
        messages.push({
          role: "toolResult",
          toolCallId: r.toolCallId,
          name: r.name,
          content: r.content,
          isError: r.isError,
          ...(r.details === undefined ? {} : { details: r.details }),
        });
      } else {
        const code = call.startedAtMs ? "TOOL_OUTCOME_UNKNOWN" : "TOOL_NOT_STARTED";
        repaired.push({ toolCallId: call.toolCallId, code });
        messages.push({
          role: "toolResult",
          toolCallId: call.toolCallId,
          name: call.name,
          content: [{ type: "text", text: code === "TOOL_NOT_STARTED" ? RECOVERY_NOT_STARTED : RECOVERY_OUTCOME_UNKNOWN }],
          isError: true,
        });
      }
    }
  };

  const stepKey = (it: Item) => `${it.turnId}#${it.step ?? 0}`;

  // A compaction item is written AFTER the turns it summarises, so its seq is higher than the messages
  // it stands in for. It still belongs at the front of the transcript, and anything it covers is dropped.
  const compactions = sorted.filter((it): it is Extract<Item, { type: "contextCompaction" }> => it.type === "contextCompaction");
  const newestCompaction = compactions.at(-1);
  for (const c of compactions) {
    messages.push({ role: "system", text: `Summary of the earlier conversation (older messages were compacted):\n${c.summary}` });
  }
  const carriedSkills = collectResolvedSkillContexts(compactions);
  for (const context of carriedSkills) messages.push({ role: "system", text: renderSkillContext(context) });
  const coveredUpTo = newestCompaction?.replacesUpToSeq ?? -1;

  for (const it of sorted) {
    if (it.seq <= coveredUpTo) continue; // superseded by the summary above
    switch (it.type) {
      case "contextCompaction":
        break; // already emitted as a leading system message
      case "userMessage": {
        flushGroup();
        const contexts = collectResolvedSkillContexts([it]);
        const content = (it.effectiveContent ?? it.content).flatMap((part): EngineInputPart[] => {
            if (part.type === "skill") {
              const context = contexts.find(context => context.name === part.name);
              return [{ type: "text", text: context ? renderSkillContext(context, part.args)
                : "Historical skill input has no resolved snapshot; it was not reloaded." }];
            }
            if (part.type !== "text" && part.type !== "image") return [];
            if (part.type === "image" && typeof (part as { url?: unknown }).url !== "string") {
              if (options.lightweightImages) return [planningImagePlaceholder(part.blobId)];
              throw new Error(`image blob ${part.blobId} was not materialized for model input`);
            }
            return [part as EngineInputPart];
          });
        if (content.length) messages.push({ role: "user", content });
        break;
      }
      case "agentMessage":
      case "reasoning":
      case "toolCall": {
        if (!group || group.key !== stepKey(it)) {
          flushGroup();
          group = { key: stepKey(it), assistant: { role: "assistant", text: "", toolCalls: [] }, calls: [] };
        }
        if (it.type === "agentMessage") group.assistant.text += it.text;
        else if (it.type === "reasoning") group.assistant.reasoning = (group.assistant.reasoning ?? "") + it.text;
        else {
          group.assistant.toolCalls.push({ id: it.toolCallId, name: it.name, args: it.args });
          group.calls.push(it);
        }
        break;
      }
      case "systemNotice":
        flushGroup();
        messages.push({ role: "user", content: [{ type: "text", text: `[system notice: ${it.kind}] ${it.text}` }] });
        break;
      case "toolResult":
      case "approvalRequest":
        // toolResults are emitted with their call; approvalRequests are UI-only
        break;
    }
  }
  flushGroup();
  return { messages: coalesceAssistants(messages), repaired };
}

/**
 * Merge assistant messages that ended up adjacent. This can only happen when the earlier one made no
 * tool calls (otherwise its results sit between them), so merging is lossless. Several OpenAI-compatible
 * endpoints reject two assistant messages in a row, and some of pi's compat switches exist for exactly
 * that, so the transcript we hand over never contains the shape.
 */
function coalesceAssistants(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (m.role === "assistant" && prev?.role === "assistant" && prev.toolCalls.length === 0) {
      prev.text = [prev.text, m.text].filter(Boolean).join("\n");
      if (m.reasoning) prev.reasoning = [prev.reasoning, m.reasoning].filter(Boolean).join("\n");
      prev.toolCalls = m.toolCalls;
      prev.provider = m.provider ?? prev.provider;
      prev.model = m.model ?? prev.model;
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Cheap-tier context control: when the projected transcript exceeds the budget, truncate the
 * content of old tool results (keeping the call/result pairing intact) from oldest to newest
 * until under budget. Never touches the last `keepRecent` steps' results.
 */
export function pruneToolResults(messages: TranscriptMessage[], budgetTokens: number, keepRecent = 2): TranscriptMessage[] {
  const size = (m: TranscriptMessage) =>
    m.role === "user"
      ? estimateTokens(m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
      : m.role === "assistant"
        ? estimateTokens(m.text + (m.reasoning ?? "") + JSON.stringify(m.toolCalls))
        : m.role === "toolResult"
          ? estimateTokens(m.content.map((c) => (c.type === "text" ? c.text : "")).join(""))
          : estimateTokens(m.text);
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budgetTokens) return messages;
  const out = messages.map((m) => ({ ...m }));
  const assistantIdx = out.map((m, i) => (m.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  const protectedFrom = assistantIdx.at(-keepRecent) ?? out.length;
  for (let i = 0; i < protectedFrom && total > budgetTokens; i++) {
    const m = out[i]!;
    // Retention only, not authorization: typed item metadata above is the sole snapshot source.
    if (m.role !== "toolResult" || m.name === "skill") continue;
    const before = size(m);
    if (before < 64) continue;
    out[i] = { ...m, content: [{ type: "text", text: `[tool output truncated by context pruning: ${before} tokens]` }] };
    total -= before - size(out[i]!);
  }
  return out;
}
