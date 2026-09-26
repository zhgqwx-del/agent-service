import type { Item } from "@agent-service/protocol";
import type { TranscriptMessage } from "../engine/types.js";
import { estimateTokens } from "./assemble.js";

export const RECOVERY_NOT_STARTED =
  "TOOL_NOT_STARTED: the runner restarted before this tool call began. It was never executed. Decide whether to call it again.";
export const RECOVERY_OUTCOME_UNKNOWN =
  "TOOL_OUTCOME_UNKNOWN: the runner restarted while this tool was executing. Its side effects may or may not have happened. Verify before repeating any non-idempotent action.";

export interface ProjectionResult {
  messages: TranscriptMessage[];
  /** tool call ids that were repaired with synthetic results (for logging/metrics) */
  repaired: { toolCallId: string; code: "TOOL_NOT_STARTED" | "TOOL_OUTCOME_UNKNOWN" }[];
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
  const sorted = [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
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
        messages.push({ role: "toolResult", toolCallId: r.toolCallId, name: r.name, content: r.content, isError: r.isError });
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
  const coveredUpTo = newestCompaction?.replacesUpToSeq ?? -1;

  for (const it of sorted) {
    if (it.seq <= coveredUpTo) continue; // superseded by the summary above
    switch (it.type) {
      case "contextCompaction":
        break; // already emitted as a leading system message
      case "userMessage": {
        flushGroup();
        const content = it.content.filter((p): p is Extract<typeof p, { type: "text" | "image" }> => p.type === "text" || p.type === "image");
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
    if (m.role !== "toolResult") continue;
    const before = size(m);
    if (before < 64) continue;
    out[i] = { ...m, content: [{ type: "text", text: `[tool output truncated by context pruning: ${before} tokens]` }] };
    total -= before - size(out[i]!);
  }
  return out;
}
