import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  EndUserTokenHeaderName,
  Event,
  HTTP_STATUS,
  IntrospectionVerifier,
  Item,
  ModelSpec,
  mergeLimits,
  StartTurnRequest,
  idSchema,
} from "../src/index.js";

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

  it("requires every model capability declaration to contain one text entry", () => {
    expect(ModelSpec.parse({ id: "default-text" }).input).toEqual(["text"]);
    for (const input of [["text"], ["text", "image"], ["image", "text"]]) {
      expect(ModelSpec.safeParse({ id: "valid", input }).success, JSON.stringify(input)).toBe(true);
    }
    for (const input of [[], ["image"], ["text", "text"], ["image", "image"]]) {
      expect(ModelSpec.safeParse({ id: "invalid", input }).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("distinguishes persisted and live events", () => {
    const sid = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const tid = "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const iid = "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    expect(Event.safeParse({ type: "heartbeat", sessionId: sid, emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "item/agentMessage/delta", sessionId: sid, turnId: tid, itemId: iid, delta: "x", emittedAtMs: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1 }).success).toBe(false); // needs seq
    expect(Event.safeParse({ type: "session/created", sessionId: sid, emittedAtMs: 1, seq: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/deleted", sessionId: sid, emittedAtMs: 2, seq: 2, deletionGeneration: 1 }).success).toBe(true);
    expect(Event.safeParse({ type: "session/deleted", sessionId: sid, emittedAtMs: 2, seq: 2, deletionGeneration: 0 }).success).toBe(false);
  });

  it("publishes the parent-child deletion conflict as a stable 409", () => {
    expect(ErrorCode.parse("session_has_children")).toBe("session_has_children");
    expect(HTTP_STATUS.session_has_children).toBe(409);
  });

  it("rejects unknown item types", () => {
    expect(Item.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("accepts custom end-user token headers but rejects invalid or reserved HTTP headers", () => {
    for (const valid of ["x-end-user-token", "X-Tenant-Auth", "end.user_token+v2"]) {
      expect(EndUserTokenHeaderName.safeParse(valid).success, valid).toBe(true);
    }
    for (const reserved of [
      "authorization",
      "AUTHORIZATION",
      "x-user-id",
      "Host",
      "content-length",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(EndUserTokenHeaderName.safeParse(reserved).success, reserved).toBe(false);
    }
    for (const invalid of ["", "x token", "x:token", "x-token\nforwarded", "令牌"]) {
      expect(EndUserTokenHeaderName.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    }
  });

  it("keeps Authorization valid for the outbound introspection token header", () => {
    expect(IntrospectionVerifier.parse({ kind: "introspection", endpoint: "https://auth.example/introspect" }).tokenHeader).toBe("authorization");
  });
});
