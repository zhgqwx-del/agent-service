import { describe, expect, it } from "vitest";
import type { Item } from "@agent-service/protocol";
import {
  RECOVERY_NOT_STARTED,
  RECOVERY_OUTCOME_UNKNOWN,
  computeContextEpoch,
  estimateTokens,
  projectItems,
  pruneToolResults,
  stableStringify,
  toolSetFingerprint,
  type RunnerTool,
} from "../src/index.js";

/**
 * Covers the context-assembly and crash-recovery invariants from design §6.2/§6.4 and the production
 * pitfalls catalogued in docs/research/01 §3.1 (#1 stable ids, #4 crash tri-state, #8 compaction pairing).
 */

import type { TranscriptMessage } from "../src/index.js";

/** narrow a projected message to the assistant variant, failing the test if it is not one */
const asAssistant = (m: TranscriptMessage | undefined) => {
  if (!m || m.role !== "assistant") throw new Error(`expected an assistant message, got ${m?.role ?? "none"}`);
  return m;
};
const asToolResult = (m: TranscriptMessage | undefined) => {
  if (!m || m.role !== "toolResult") throw new Error(`expected a toolResult message, got ${m?.role ?? "none"}`);
  return m;
};
const asSystem = (m: TranscriptMessage | undefined) => {
  if (!m || m.role !== "system") throw new Error(`expected a system message, got ${m?.role ?? "none"}`);
  return m;
};

const SID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const T1 = "turn_019a2b3c-4d5e-7f00-8a9b-000000000001";
const T2 = "turn_019a2b3c-4d5e-7f00-8a9b-000000000002";
let n = 0;
const iid = () => `item_019a2b3c-4d5e-7f00-8a9b-${String(++n).padStart(12, "0")}`;

const base = (seq: number, turnId = T1, step?: number) => ({
  id: iid(), sessionId: SID, turnId, seq, step, status: "completed" as const, createdAtMs: seq,
});
const user = (seq: number, text: string, turnId = T1): Item => ({ ...base(seq, turnId), type: "userMessage", content: [{ type: "text", text }] });
const say = (seq: number, text: string, step = 1, turnId = T1): Item => ({ ...base(seq, turnId, step), type: "agentMessage", text, phase: "finalAnswer" });
const think = (seq: number, text: string, step = 1, turnId = T1): Item => ({ ...base(seq, turnId, step), type: "reasoning", text });
const call = (seq: number, id: string, name: string, args: unknown, step = 1, turnId = T1, started = true): Item => ({
  ...base(seq, turnId, step), type: "toolCall", status: "completed", toolCallId: id, name, kind: "builtin", args,
  ...(started ? { startedAtMs: seq } : {}),
});
const result = (seq: number, id: string, name: string, text: string, step = 1, turnId = T1): Item => ({
  ...base(seq, turnId, step), type: "toolResult", toolCallId: id, name, content: [{ type: "text", text }], isError: false,
});

describe("projectItems", () => {
  it("groups one step into a single assistant message with its tool calls, then the results", () => {
    const items = [
      user(1, "weather?"),
      think(2, "need a tool"),
      say(3, "checking"),
      call(4, "c1", "get_weather", { city: "SH" }),
      call(5, "c2", "get_time", { city: "SH" }),
      result(6, "c1", "get_weather", "22C"),
      result(7, "c2", "get_time", "15:04"),
      say(8, "22C at 15:04", 2),
    ];
    const { messages, repaired } = projectItems(items);
    expect(repaired).toEqual([]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
    const first = asAssistant(messages[1]);
    expect(first.text).toBe("checking");
    expect(first.reasoning).toBe("need a tool");
    expect(first.toolCalls.map((t) => t.id)).toEqual(["c1", "c2"]);
  });

  it("never produces two adjacent assistant messages and always pairs a result to its call", () => {
    // random-ish streams: the invariants must hold for every shape we can persist
    const shapes: Item[][] = [
      [user(1, "a"), say(2, "x"), user(3, "b"), say(4, "y", 1, T2)],
      [user(1, "a"), call(2, "c1", "t", {}), result(3, "c1", "t", "r"), say(4, "done", 2)],
      [user(1, "a"), think(2, "t"), call(3, "c1", "t", {}), result(4, "c1", "t", "r"), think(5, "t2", 2), say(6, "end", 2)],
      [user(1, "a"), say(2, "one", 1), say(3, "two", 2), say(4, "three", 3)],
    ];
    for (const items of shapes) {
      const { messages } = projectItems(items);
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i - 1]!.role === "assistant" && messages[i]!.role === "assistant").toBe(false);
      }
      const calls = messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((t) => t.id) : []));
      const results = messages.filter((m) => m.role === "toolResult").map((m) => asToolResult(m).toolCallId);
      expect(results.sort()).toEqual(calls.sort());
      // every result comes after its call
      for (const id of calls) {
        const ci = messages.findIndex((m) => m.role === "assistant" && m.toolCalls.some((t) => t.id === id));
        const ri = messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === id);
        expect(ri).toBeGreaterThan(ci);
      }
    }
  });

  it("synthesises TOOL_NOT_STARTED for a call that never began and TOOL_OUTCOME_UNKNOWN for one that did", () => {
    // Pitfall #4: the model gets the evidence, not a conclusion.
    const items = [
      user(1, "do two things"),
      call(2, "never", "tag", {}, 1, T1, false),
      call(3, "maybe", "charge", {}, 1, T1, true),
    ];
    const { messages, repaired } = projectItems(items);
    expect(repaired).toEqual([
      { toolCallId: "never", code: "TOOL_NOT_STARTED" },
      { toolCallId: "maybe", code: "TOOL_OUTCOME_UNKNOWN" },
    ]);
    const texts = messages.filter((m) => m.role === "toolResult").map((m) => asToolResult(m).content[0]);
    expect(texts[0]).toMatchObject({ text: RECOVERY_NOT_STARTED });
    expect(texts[1]).toMatchObject({ text: RECOVERY_OUTCOME_UNKNOWN });
    expect(messages.filter((m) => m.role === "toolResult").every((m) => asToolResult(m).isError)).toBe(true);
  });

  it("a compaction summary leads the transcript and replaces what came before it", () => {
    const items: Item[] = [
      { ...base(5), type: "contextCompaction", replacesUpToSeq: 4, summary: "user asked about weather twice" },
      user(6, "and now?"),
      say(7, "now it is sunny"),
    ];
    const { messages } = projectItems(items);
    expect(asSystem(messages[0]).text).toContain("weather twice");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("keeps a steered user message between the two assistant turns instead of splitting a step", () => {
    const items = [
      user(1, "first"),
      call(2, "c1", "slow", {}),
      result(3, "c1", "slow", "done"),
      user(4, "also this"), // steered mid-turn
      say(5, "answer to both", 2),
    ];
    const { messages } = projectItems(items);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
  });

  it("orders by seq, not by insertion, and is stable for equal seqs", () => {
    const shuffled = [say(8, "last", 2), user(1, "a"), result(7, "c1", "t", "r"), call(6, "c1", "t", {})];
    const { messages } = projectItems(shuffled);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });
});

describe("pruneToolResults", () => {
  it("truncates the oldest tool outputs first and keeps the recent steps intact", () => {
    const big = "x".repeat(4000);
    const items = [
      user(1, "go"),
      call(2, "c1", "t", {}, 1),
      result(3, "c1", "t", big, 1),
      say(4, "mid", 2),
      call(5, "c2", "t", {}, 2),
      result(6, "c2", "t", big, 2),
      say(7, "recent", 3),
      call(8, "c3", "t", {}, 3),
      result(9, "c3", "t", big, 3),
    ];
    const { messages } = projectItems(items);
    const pruned = pruneToolResults(messages, 800, 2);
    const texts = pruned.filter((m) => m.role === "toolResult").map((m) => {
      const c = asToolResult(m).content[0]!;
      return c.type === "text" ? c.text : "";
    });
    expect(texts[0]).toContain("truncated");
    expect(texts.at(-1)).toBe(big); // the most recent results survive
    // pairing is preserved: same number of results as before
    expect(pruned.filter((m) => m.role === "toolResult")).toHaveLength(3);
    expect(pruned.map((m) => m.role)).toEqual(messages.map((m) => m.role));
  });

  it("is a no-op when already under budget", () => {
    const { messages } = projectItems([user(1, "hi"), say(2, "there")]);
    expect(pruneToolResults(messages, 10_000)).toEqual(messages);
  });
});

describe("prefix stability (pitfall #1: cache hits depend on byte-identical prefixes)", () => {
  const tool = (name: string): RunnerTool => ({
    name, description: `d-${name}`, parameters: { type: "object", properties: { a: { type: "string" } } },
    kind: "builtin", readOnly: true, execute: async () => ({ content: [] }),
  });

  it("stableStringify sorts keys at every level", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("the tool fingerprint ignores declaration order and execute identity", () => {
    const a = toolSetFingerprint([tool("x"), tool("y")]);
    const b = toolSetFingerprint([tool("y"), tool("x")]);
    expect(a).toBe(b);
  });

  it("the epoch changes only when something the model sees changes", () => {
    const agent = { agentId: "agt_1", agentVersion: 1, systemPrompt: "be brief", tools: [tool("x")], skills: [{ name: "s", description: "d" }] };
    const baseEpoch = computeContextEpoch(agent);
    expect(computeContextEpoch({ ...agent })).toBe(baseEpoch);
    expect(computeContextEpoch({ ...agent, tools: [tool("x"), tool("y")] })).not.toBe(baseEpoch);
    expect(computeContextEpoch({ ...agent, systemPrompt: "be brief " })).not.toBe(baseEpoch);
    expect(computeContextEpoch({ ...agent, agentVersion: 2 })).not.toBe(baseEpoch);
    expect(computeContextEpoch({ ...agent, skills: [] })).not.toBe(baseEpoch);
    // reordering skills must not change it
    expect(computeContextEpoch({ ...agent, skills: [{ name: "s", description: "other text" }] })).toBe(baseEpoch);
  });
});

describe("estimateTokens", () => {
  it("counts CJK per character and latin per ~4 characters", () => {
    expect(estimateTokens("中文测试")).toBe(4);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });
});
