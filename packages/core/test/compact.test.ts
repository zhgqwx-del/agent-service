import { describe, expect, it } from "vitest";
import type { Item } from "@agent-service/protocol";
import { itemTokens, planCompaction, projectItems, renderForSummary } from "../src/index.js";

const SID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const T = (n: number) => `turn_019a2b3c-4d5e-7f00-8a9b-${String(n).padStart(12, "0")}`;
let n = 0;
const iid = () => `item_019a2b3c-4d5e-7f00-8a9b-${String(++n).padStart(12, "0")}`;
const base = (seq: number, turn: number) => ({ id: iid(), sessionId: SID, turnId: T(turn), seq, step: 1, status: "completed" as const, createdAtMs: seq });
const user = (seq: number, turn: number, text: string): Item => ({ ...base(seq, turn), type: "userMessage", content: [{ type: "text", text }] });
const say = (seq: number, turn: number, text: string): Item => ({ ...base(seq, turn), type: "agentMessage", text, phase: "finalAnswer" });
const call = (seq: number, turn: number, id: string): Item => ({ ...base(seq, turn), type: "toolCall", toolCallId: id, name: "t", kind: "builtin", args: {}, startedAtMs: seq });
const result = (seq: number, turn: number, id: string, text: string): Item => ({ ...base(seq, turn), type: "toolResult", toolCallId: id, name: "t", content: [{ type: "text", text }], isError: false });

/** three complete turns, each with a tool round trip */
function conversation(): Item[] {
  const out: Item[] = [];
  let seq = 1;
  for (let t = 1; t <= 3; t++) {
    out.push(user(seq++, t, `question ${t} `.repeat(20)));
    out.push(call(seq++, t, `c${t}`));
    out.push(result(seq++, t, `c${t}`, `tool output ${t} `.repeat(40)));
    out.push(say(seq++, t, `answer ${t} `.repeat(30)));
  }
  return out;
}

describe("planCompaction", () => {
  it("does nothing when the conversation fits", () => {
    expect(planCompaction(conversation(), { budgetTokens: 1_000_000 })).toBeUndefined();
  });

  it("does nothing for a conversation too short to be worth a summary", () => {
    expect(planCompaction([user(1, 1, "hi"), say(2, 1, "hello")], { budgetTokens: 1 })).toBeUndefined();
  });

  it("cuts only at a turn boundary, never between a tool call and its result", () => {
    const items = conversation();
    for (const budget of [50, 100, 200, 400, 800]) {
      const plan = planCompaction(items, { budgetTokens: budget, keepRatio: 0.5 });
      if (!plan) continue;
      const cutItem = items.find((i) => i.seq === plan.keepFromSeq)!;
      expect(cutItem.type, `budget=${budget}`).toBe("userMessage");
      // the summarised slice ends with a complete turn: its last item is not a toolCall awaiting a result
      expect(plan.summarise.at(-1)!.type, `budget=${budget}`).not.toBe("toolCall");
    }
  });

  it("keeps the newest turn and summarises the older ones", () => {
    const items = conversation();
    const plan = planCompaction(items, { budgetTokens: Math.floor(items.reduce((s, i) => s + itemTokens(i), 0) / 2), keepRatio: 0.5 })!;
    expect(plan).toBeDefined();
    const keptTurns = new Set(items.filter((i) => i.seq >= plan.keepFromSeq).map((i) => i.turnId));
    const droppedTurns = new Set(plan.summarise.map((i) => i.turnId));
    expect(keptTurns.has(T(3))).toBe(true);
    expect(droppedTurns.has(T(1))).toBe(true);
    // no turn is split across the boundary
    for (const t of keptTurns) expect(droppedTurns.has(t)).toBe(false);
  });
});

describe("projection after compaction", () => {
  /**
   * The regression this guards: the watermark used to point at the summary item, whose seq is HIGHER than
   * the turns the plan wanted to keep — so the next projection dropped them and the model lost recent
   * context it had just been told to keep.
   */
  it("keeps the turns after the cut and replaces only what the summary covers", () => {
    const items = conversation();
    const plan = planCompaction(items, { budgetTokens: 120, keepRatio: 0.5 })!;
    const summaryItem: Item = {
      id: iid(), sessionId: SID, turnId: T(99), seq: 99, status: "completed", createdAtMs: 99,
      type: "contextCompaction", replacesUpToSeq: plan.keepFromSeq - 1, summary: "the user asked three questions",
    };
    // what a later turn reads: items from the watermark on, which includes the summary item
    const visible = [...items.filter((i) => i.seq >= plan.keepFromSeq), summaryItem];
    const { messages } = projectItems(visible);

    // the summary leads, despite having the highest seq
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.role === "system" && messages[0]!.text).toContain("three questions");
    // and the kept turn's own user message survived
    const users = messages.filter((m) => m.role === "user");
    expect(users.length).toBeGreaterThan(0);
    // pairing still holds
    const calls = messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((t) => t.id) : []));
    const results = messages.filter((m) => m.role === "toolResult").map((m) => (m.role === "toolResult" ? m.toolCallId : ""));
    expect(results.sort()).toEqual(calls.sort());
  });

  it("drops items the summary covers even if they are still readable", () => {
    const items = conversation();
    const summaryItem: Item = {
      id: iid(), sessionId: SID, turnId: T(99), seq: 99, status: "completed", createdAtMs: 99,
      type: "contextCompaction", replacesUpToSeq: 8, summary: "covered turns 1 and 2",
    };
    const { messages } = projectItems([...items, summaryItem]);
    const rendered = JSON.stringify(messages);
    expect(rendered).toContain("covered turns 1 and 2");
    expect(rendered).not.toContain("question 1");
    expect(rendered).not.toContain("question 2");
    expect(rendered).toContain("question 3");
  });
});

describe("renderForSummary", () => {
  it("includes every turn it is given, with tool calls and results", () => {
    const { messages } = projectItems(conversation());
    const text = renderForSummary(messages);
    for (const t of [1, 2, 3]) {
      expect(text).toContain(`question ${t}`);
      expect(text).toContain(`answer ${t}`);
      expect(text).toContain(`tool output ${t}`);
    }
  });

  it("keeps the most recent part when the slice is enormous", () => {
    const { messages } = projectItems(conversation());
    const full = renderForSummary(messages);
    const text = renderForSummary(messages, 200);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("truncated");
    // the tail is preserved verbatim, the head is what gets dropped
    expect(full.endsWith(text.slice(text.indexOf("\n") + 1))).toBe(true);
    expect(text).not.toContain("question 1");
  });
});
