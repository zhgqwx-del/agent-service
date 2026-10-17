import { describe, expect, expectTypeOf, it } from "vitest";
import { Event, isPersistedEvent, ToolHookStatus, type EventInput } from "../src/index.js";

const UUID = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const base = { type: "hook/completed" as const, sessionId: `sess_${UUID}`, turnId: `turn_${UUID}`,
  toolCallId: "call_tool_hook", emittedAtMs: 1, seq: 2,
  hookId: "Operator_policy-1", phase: "preToolUse" as const, kind: "webhook" as const,
  outcome: "allowed" as const, configSha256: "ab".repeat(32) };

describe("bounded content-free tool hook event protocol", () => {
  it("is a durable typed event with the normal session seq, not an execution grant", () => {
    const event = Event.parse(base);
    expect(event).toEqual(base); expect(isPersistedEvent(event)).toBe(true);
    const { seq: _seq, ...input } = base;
    expectTypeOf(input).toMatchTypeOf<EventInput>();
    expect(Event.safeParse(input).success).toBe(false);
  });

  it.each(["allowed", "denied", "tool_success", "tool_error", "acknowledged", "failed", "cancelled", "skipped", "timed_out"])
    ("retains the closed outcome vocabulary: %s", outcome => {
      expect(Event.parse({ ...base, phase: "postToolUse", outcome })).toMatchObject({ outcome });
    });

  it.each([
    { hookId: "../policy" }, { hookId: "x".repeat(65) }, { configSha256: "AB".repeat(32) },
    { configSha256: "ab".repeat(31) }, { phase: "PermissionRequest" }, { kind: "uploaded-code" },
    { outcome: "grant_approved" }, { toolCallId: "" }, { toolCallId: "x".repeat(257) }, { seq: -1 },
  ])("rejects invalid status identities or unimplemented contracts %#", patch => {
    expect(Event.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it.each(["args", "result", "body", "reason", "headers", "endpoint", "signingKey", "owner", "tenantId", "userId"])
    ("never carries business material or hook authority: %s", field => {
      expect(Event.safeParse({ ...base, [field]: "must-not-be-carried" }).success).toBe(false);
      const { hookId, phase, kind, outcome, configSha256 } = base;
      expect(ToolHookStatus.safeParse({ hookId, phase, kind, outcome, configSha256, [field]: "must-not-be-carried" }).success).toBe(false);
    });
});
