import { describe, expect, it } from "vitest";
import { Event, Item, mergeLimits, StartTurnRequest, idSchema } from "../src/index.js";

describe("protocol schemas", () => {
  it("validates ids", () => {
    expect(idSchema("sess").safeParse("sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b").success).toBe(true);
    expect(idSchema("sess").safeParse("sess_not-a-uuid").success).toBe(false);
    expect(idSchema("sess").safeParse("turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b").success).toBe(false);
  });

  it("merges limits by min (policy can only tighten)", () => {
    const m = mergeLimits({ maxSteps: 30 }, { maxSteps: 5, maxCostCNY: 1 }, undefined, { maxSteps: 10 });
    expect(m.maxSteps).toBe(5);
    expect(m.maxCostCNY).toBe(1);
    expect(m.maxToolCalls).toBe(50);
  });

  it("applies defaults on StartTurnRequest", () => {
    const r = StartTurnRequest.parse({ input: [{ type: "text", text: "hi" }] });
    expect(r.stream).toBe(true);
    expect(r.metadata).toEqual({});
  });

  it("distinguishes persisted and live events", () => {
    const sid = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const tid = "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const iid = "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    expect(Event.safeParse({ type: "heartbeat", sessionId: sid, emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "item/agentMessage/delta", sessionId: sid, turnId: tid, itemId: iid, delta: "x", emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1 }).success).toBe(false); // needs seq
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1, seq: 1 }).success).toBe(true);
  });

  it("rejects unknown item types", () => {
    expect(Item.safeParse({ type: "nope" }).success).toBe(false);
  });
});
