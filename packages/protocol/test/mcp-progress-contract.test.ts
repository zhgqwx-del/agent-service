import { describe, expect, expectTypeOf, it } from "vitest";
import { Event, EventStreamEvent, EXCLUDABLE_EVENT_TYPES, isPersistedEvent, McpToolProgress,
  type EventInput, type LiveEvent } from "../src/index.js";

const uuid = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const base = { type: "item/mcpToolCall/progress" as const, sessionId: `sess_${uuid}`,
  turnId: `turn_${uuid}`, itemId: `item_${uuid}`, toolCallId: "call_mcp", emittedAtMs: 1,
  progress: 1, total: 2, message: "远端进度（不可信数据）" };

describe("MCP live progress protocol", () => {
  it("is typed, item-bound, live-only and independently excludable", () => {
    const event = Event.parse(base);
    expect(event).toEqual(base);
    expect(isPersistedEvent(event)).toBe(false);
    expectTypeOf(base).toMatchTypeOf<LiveEvent>();
    expectTypeOf(base).not.toMatchTypeOf<EventInput>();
    expect(EXCLUDABLE_EVENT_TYPES).toContain(base.type);
    expect(Event.safeParse({ ...base, seq: 1 }).success).toBe(false);
    expect(EventStreamEvent.parse(base)).toEqual(base);
    expect(EventStreamEvent.safeParse({ ...base, seq: 1 }).success).toBe(false);
  });

  it("accepts finite fractional progress without requiring a total or message", () => {
    expect(McpToolProgress.parse({ progress: 0 })).toEqual({ progress: 0 });
    expect(McpToolProgress.parse({ progress: 0.5, total: 1.5 })).toEqual({ progress: 0.5, total: 1.5 });
  });

  it.each([
    { progress: -1 }, { progress: Infinity }, { progress: NaN }, { progress: "1" },
    { total: -1 }, { total: Infinity }, { total: "2" }, { message: "x".repeat(513) },
    { message: "进".repeat(171) }, { message: null }, { toolCallId: "" },
    { toolCallId: "x".repeat(257) }, { itemId: undefined }, { turnId: undefined },
  ])("rejects malformed or unbounded event fields %#", patch => {
    expect(Event.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("checks total against the actual value before a producer can publish", () => {
    expect(McpToolProgress.safeParse({ progress: 2, total: 1 }).success).toBe(false);
    expect(McpToolProgress.parse({ progress: 2, total: 2 })).toEqual({ progress: 2, total: 2 });
    expect(McpToolProgress.parse({ progress: 1, message: "进".repeat(170) + "ab" }).message).toHaveLength(172);
  });

  it.each(["progressToken", "remoteSessionId", "endpoint", "headers", "authorization", "tenantId", "userId", "args", "result", "unknown"])
    ("does not carry private transport or authorization fields: %s", field => {
      expect(Event.safeParse({ ...base, [field]: "private" }).success).toBe(false);
      expect(McpToolProgress.safeParse({ progress: 1, [field]: "private" }).success).toBe(false);
    });
});
