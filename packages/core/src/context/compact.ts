import type { Item } from "@agent-service/protocol";
import type { TranscriptMessage } from "../engine/types.js";
import { estimateTokens } from "./assemble.js";

/**
 * Summary-tier compaction.
 *
 * The cheap tier (`pruneToolResults`) only shortens tool output. Once a conversation is long enough that
 * even the messages themselves do not fit, some of them have to be replaced by a summary. Two rules make
 * that safe:
 *
 *  1. **Cut only at a turn boundary.** A tool call and its result must stay together, and an assistant
 *     message must stay with the results it provoked; cutting inside a step would hand the model a call
 *     with no result (or worse, a result with no call, which several providers reject).
 *  2. **Keep the tail.** The most recent exchanges carry the intent; the summary stands in for the past.
 */

export interface CompactionPlan {
  /** items to summarise (everything before the cut) */
  summarise: Item[];
  /** seq of the first item kept verbatim; becomes the session's projection watermark */
  keepFromSeq: number;
  /** estimated tokens of the summarised slice, for logging and for deciding whether it is worth the call */
  droppedTokens: number;
}

export interface CompactionOptions {
  /** total budget for the projected transcript */
  budgetTokens: number;
  /** fraction of the budget the kept tail may occupy (the rest is left for the summary and the new turn) */
  keepRatio?: number;
  /** never compact below this many messages: a short conversation is not worth a summary */
  minMessages?: number;
}

export const messageTokens = (m: TranscriptMessage): number => {
  switch (m.role) {
    case "user":
      return estimateTokens(m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""));
    case "assistant":
      return estimateTokens(m.text + (m.reasoning ?? "") + JSON.stringify(m.toolCalls));
    case "toolResult":
      return estimateTokens(m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""));
    case "system":
      return estimateTokens(m.text);
  }
};

export const transcriptTokens = (messages: TranscriptMessage[]): number => messages.reduce((n, m) => n + messageTokens(m), 0);

/** Rough token size of a persisted item, used only to choose a cut point. */
export function itemTokens(it: Item): number {
  switch (it.type) {
    case "userMessage":
      return estimateTokens(it.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""));
    case "agentMessage":
    case "reasoning":
    case "systemNotice":
      return estimateTokens(it.text);
    case "toolCall":
      return estimateTokens(it.name + JSON.stringify(it.args ?? {}));
    case "toolResult":
      return estimateTokens(it.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(""));
    case "contextCompaction":
      return estimateTokens(it.summary);
    case "approvalRequest":
      return 0;
  }
}

/**
 * Plan at the ITEM level, not the message level.
 *
 * The persisted watermark is a seq, so the cut has to be expressible as one. Planning on the projected
 * messages instead looks equivalent but is not: the messages that a message-level plan wanted to keep sit
 * BEFORE the summary item in seq order, so the next projection would drop exactly the recent history the
 * plan meant to preserve. (That is not hypothetical — it happened, and the model then denied knowing a
 * topic discussed two turns earlier.)
 *
 * A cut is only allowed immediately before a `userMessage`, which is a turn boundary: it never separates
 * a tool call from its result, nor an assistant message from the results it provoked.
 */
export function planCompaction(items: Item[], opts: CompactionOptions): CompactionPlan | undefined {
  const sorted = [...items].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  if (sorted.length < (opts.minMessages ?? 6)) return undefined;
  const total = sorted.reduce((n, i) => n + itemTokens(i), 0);
  if (total <= opts.budgetTokens) return undefined;

  const keepBudget = Math.floor(opts.budgetTokens * (opts.keepRatio ?? 0.6));
  const boundaries = sorted.map((it, i) => (it.type === "userMessage" ? i : -1)).filter((i) => i > 0);
  if (!boundaries.length) return undefined;

  const tailTokens = (from: number) => sorted.slice(from).reduce((n, i) => n + itemTokens(i), 0);
  let cut = boundaries.at(-1)!;
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const candidate = boundaries[i]!;
    if (tailTokens(candidate) > keepBudget) break;
    cut = candidate;
  }

  const summarise = sorted.slice(0, cut);
  if (!summarise.length) return undefined;
  return { summarise, keepFromSeq: sorted[cut]!.seq, droppedTokens: summarise.reduce((n, i) => n + itemTokens(i), 0) };
}

export const COMPACTION_SYSTEM_PROMPT =
  "You compress conversation history. Produce a factual summary that preserves: what the user asked for, " +
  "decisions and conclusions reached, values and identifiers that were established, and any task still " +
  "outstanding. Drop pleasantries and superseded intermediate steps. Never invent anything that is not in " +
  "the transcript. Write in the language the conversation is in. Be concise but complete.";

/** Renders the slice being summarised as plain text for the summarising model call. */
export function renderForSummary(messages: TranscriptMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        lines.push(`[earlier summary] ${m.text}`);
        break;
      case "user":
        lines.push(`User: ${m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ")}`);
        break;
      case "assistant": {
        if (m.text) lines.push(`Assistant: ${m.text}`);
        for (const tc of m.toolCalls) lines.push(`Assistant called ${tc.name}(${JSON.stringify(tc.args).slice(0, 500)})`);
        break;
      }
      case "toolResult":
        lines.push(`Result of ${m.name}: ${m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ").slice(0, 1_000)}`);
        break;
    }
  }
  const text = lines.join("\n");
  // keep the END of the slice when it is enormous: it is closer to the present
  return text.length <= maxChars ? text : `…(truncated)\n${text.slice(text.length - maxChars)}`;
}
