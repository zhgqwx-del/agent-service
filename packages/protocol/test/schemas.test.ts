import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ErasureRequest,
  ErasureRequestHeaders,
  ErasureRequestParams,
  Capabilities,
  EndUserTokenHeaderName,
  Event,
  HTTP_STATUS,
  IntrospectionVerifier,
  Item,
  ModelSpec,
  OPENAPI_DOCUMENT,
  addUsage,
  emptyUsage,
  emptyUsageAccumulator,
  mergeLimits,
  StartTurnRequest,
  UserErasureDrainRequest,
  idSchema,
  PROTOCOL_VERSION,
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

  it("keeps a known-empty accumulator as the cost identity and makes an actual unknown cost sticky", () => {
    const priced = { ...emptyUsage(), totalTokens: 1, costCNY: 0.25 };
    expect(addUsage(emptyUsageAccumulator(), priced)).toEqual(priced);

    // Token counters cannot identify the accumulator identity: a real zero-token provider result
    // may still have unknown cost.
    const zeroTokenUnknown = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    const unknownTotal = addUsage(priced, zeroTokenUnknown);
    expect(unknownTotal).toMatchObject({ totalTokens: 1 });
    expect(unknownTotal).not.toHaveProperty("costCNY");
    expect(addUsage(unknownTotal, emptyUsageAccumulator())).not.toHaveProperty("costCNY");
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

  it("publishes lifecycle write barriers as stable 409 errors", () => {
    expect(ErrorCode.parse("session_has_children")).toBe("session_has_children");
    expect(HTTP_STATUS.session_has_children).toBe(409);
    expect(ErrorCode.parse("subject_deleting")).toBe("subject_deleting");
    expect(HTTP_STATUS.subject_deleting).toBe(409);
  });

  it("validates public erasure status without exposing internal idempotency or audit material", () => {
    const value = ErasureRequest.parse({
      id: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
      scope: "user",
      userId: "u_1",
      generation: 1,
      status: "gated",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    expect(value.status).toBe("gated");
    expect(ErasureRequest.safeParse({ ...value, status: "done" }).success).toBe(false);
    expect(ErasureRequest.safeParse({ ...value, generation: 0 }).success).toBe(false);
    expect(ErasureRequestParams.safeParse({ requestId: value.id.toUpperCase() }).success).toBe(false);
  });

  it("requires a bounded non-blank idempotency key for erasure requests", () => {
    expect(ErasureRequestHeaders.parse({
      "x-user-id": "u_1",
      "idempotency-key": " erasure-1 ",
    })["idempotency-key"]).toBe("erasure-1");
    expect(ErasureRequestHeaders.safeParse({ "x-user-id": "u_1" }).success).toBe(false);
    expect(ErasureRequestHeaders.safeParse({ "x-user-id": "u_1", "idempotency-key": "   " }).success).toBe(false);
    expect(ErasureRequestHeaders.safeParse({
      "x-user-id": "u_1",
      "idempotency-key": "x".repeat(257),
    }).success).toBe(false);
  });

  it("declares private response headers for every erasure success and error response", () => {
    const post = OPENAPI_DOCUMENT.paths["/v1/data-erasure-requests"].post.responses;
    const get = OPENAPI_DOCUMENT.paths["/v1/data-erasure-requests/{requestId}"].get.responses;
    for (const response of [post["202"], post.default, get["200"], get.default]) {
      expect(response.headers["Cache-Control"].schema.enum).toEqual(["no-store"]);
      expect(response.headers["X-Content-Type-Options"].schema.enum).toEqual(["nosniff"]);
    }
  });

  it("normalizes missing additive erasure capability to false for mixed fleets", () => {
    const parsed = Capabilities.parse({
      protocolVersion: PROTOCOL_VERSION,
      service: "agent-runner",
      features: {
        streaming: true,
        replay: { persistedEvents: true, hotWindowMs: 1 },
        approvals: true,
        sessionLifecycle: ["archive"],
        blobAttachments: false,
        dynamicTools: true,
        mcp: [],
        skills: false,
        sandbox: ["none"],
        byok: true,
      },
    });
    expect(parsed.features.dataErasureRequests).toBe(false);
    expect(parsed.features.userErasureWorker).toEqual([]);
    expect(parsed.features.erasureJobControl).toEqual([]);
  });

  it("keeps the internal erasure drain contract claim-only and strict", () => {
    const authority = {
      tenantId: "tenant-a",
      userId: "user-a",
      requestId: "erase_019a2b3c-4d5e-4f00-8a9b-0c1d2e3f4a5b",
      subjectGeneration: 1,
      claimToken: "worker.claim-1",
      claimAttempt: 2,
    };
    expect(UserErasureDrainRequest.parse(authority)).toEqual(authority);
    expect(UserErasureDrainRequest.safeParse({ ...authority, phase: "tombstoning" }).success).toBe(false);
    expect(UserErasureDrainRequest.safeParse({ ...authority, claimToken: "unsafe token" }).success).toBe(false);
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
