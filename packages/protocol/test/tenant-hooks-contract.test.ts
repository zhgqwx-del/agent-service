import { describe, expect, it } from "vitest";
import {
  Capabilities, PROTOCOL_VERSION, Event, EventStreamEvent, TenantHookUpsertRequest, TenantHookHeaders,
  TenantHookListQuery, TenantHookResponse, TenantHookDeliveryResponse, TenantHooksFleetRequest,
} from "../src/index.js";

const config = { endpoint: "https://observer.example.test/receive", phase: "preToolUse", bodyScopes: [] };
const input = { name: "observer", expectedRevision: 0, config, signingKey: "6a".repeat(32) };
describe("managed tenant hook closed public contract", () => {
  it("defaults disclosure scopes to empty but never defaults explicit body consent", () => {
    expect(TenantHookUpsertRequest.parse({ ...input, config: { endpoint: config.endpoint, phase: config.phase } }).config.bodyScopes).toEqual([]);
    for (const scope of ["prompt", "tool_arguments"] as const) {
      const value = { ...input, config: { ...config, bodyScopes: [scope] } };
      expect(TenantHookUpsertRequest.safeParse(value).success).toBe(false);
      expect(TenantHookUpsertRequest.safeParse({ ...value, disclosureAck: "tenant-admin-body-disclosure-v1" }).success).toBe(true);
    }
    expect(TenantHookUpsertRequest.safeParse({ ...input, disclosureAck: "tenant-admin-body-disclosure-v1" }).success).toBe(false);
  });
  it("accepts result disclosure only after tool result and rejects duplicate or unknown scopes", () => {
    const value = { ...input, disclosureAck: "tenant-admin-body-disclosure-v1" };
    expect(TenantHookUpsertRequest.safeParse({ ...value, config: { ...config, bodyScopes: ["tool_result"] } }).success).toBe(false);
    expect(TenantHookUpsertRequest.safeParse({ ...value, config: { ...config, phase: "postToolUse", bodyScopes: ["tool_result"] } }).success).toBe(true);
    for (const bodyScopes of [["prompt", "prompt"], ["history"], ["system"], ["reasoning"], ["attachments"], ["headers"]]) {
      expect(TenantHookUpsertRequest.safeParse({ ...value, config: { ...config, bodyScopes } }).success).toBe(false);
    }
  });
  it.each(["tenantId", "userId", "apiKeyId", "adminApiKeyId", "scope", "generation", "configVersionId", "ciphertext"])(
    "rejects caller authority or internal field %s", field => {
      expect(TenantHookUpsertRequest.safeParse({ ...input, [field]: "fixture-private" }).success).toBe(false);
    });
  it.each(["headers", "dispatcher", "proxy", "keyFile", "timeoutMs", "redirect", "deny", "rewrite"])(
    "rejects arbitrary configuration %s", field => {
      expect(TenantHookUpsertRequest.safeParse({ ...input, config: { ...config, [field]: "fixture-private" } }).success).toBe(false);
    });
  it.each(["", "ab".repeat(31), "ab".repeat(33), "AB".repeat(32), "zz".repeat(32), "/private/key", "ab".repeat(32) + "\n"])(
    "requires exact lowerhex write-only signing material (%#)", signingKey => {
      expect(TenantHookUpsertRequest.safeParse({ ...input, signingKey }).success).toBe(false);
    });
  it.each(["https://user:fixture-private@observer.example/receive", "https://observer.example/receive?", "https://observer.example/receive#",
    "https://observer.example/receive?q=private", "https://OBSERVER.example/receive", "https://observer.example:443/receive",
    "http://observer.example/receive", "file:///private/key", "https://observer.example/receive\n"])(
    "rejects URL credential and normalization ambiguity (%#)", endpoint => {
      expect(TenantHookUpsertRequest.safeParse({ ...input, config: { ...config, endpoint } }).success).toBe(false);
    });
  it("retains literal loopback shape for separately gated real fixtures, not localhost aliases", () => {
    for (const host of ["127.0.0.1", "[::1]"]) expect(TenantHookUpsertRequest.safeParse({ ...input,
      config: { ...config, endpoint: `http://${host}:8080/receive` } }).success).toBe(true);
    expect(TenantHookUpsertRequest.safeParse({ ...input, config: { ...config, endpoint: "http://localhost:8080/receive" } }).success).toBe(false);
  });
  it("keeps revision, cursor, idempotency UTF8 and query shapes bounded", () => {
    for (const expectedRevision of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(TenantHookUpsertRequest.safeParse({ ...input, expectedRevision }).success).toBe(false);
    expect(TenantHookHeaders.safeParse({ "idempotency-key": "界".repeat(42) }).success).toBe(true);
    expect(TenantHookHeaders.safeParse({ "idempotency-key": "界".repeat(43) }).success).toBe(false);
    expect(TenantHookHeaders.safeParse({ "idempotency-key": "line\nbreak" }).success).toBe(false);
    expect(TenantHookListQuery.parse({ limit: "100" })).toEqual({ limit: 100 });
    for (const query of [{ limit: "101" }, { limit: "0" }, { cursor: "x".repeat(64) }, { tenantId: "other" }]) expect(TenantHookListQuery.safeParse(query).success).toBe(false);
  });
  it("does not admit secrets or observed bodies in safe registration and delivery responses", () => {
    const registration = { name: "observer", revision: 1, generation: 1, state: "enabled", currentVersionId: "a".repeat(64), createdAtMs: 1, updatedAtMs: 1 };
    const value = { registration, version: { configVersionId: "a".repeat(64), revision: 1, generation: 1, config, createdAtMs: 1 } };
    expect(TenantHookResponse.safeParse(value).success).toBe(true);
    expect(TenantHookResponse.safeParse({ ...value, version: { ...value.version, signingKey: "fixture-private" } }).success).toBe(false);
    const status = { intentId: "b".repeat(64), configVersionId: "a".repeat(64), phase: "postToolUse", state: "outcome_unknown", createdAtMs: 1, completedAtMs: 2 };
    expect(TenantHookDeliveryResponse.safeParse(status).success).toBe(true);
    for (const field of ["payload", "ciphertext", "prompt", "arguments", "result", "tenantId", "userId", "sessionId", "claimToken"])
      expect(TenantHookDeliveryResponse.safeParse({ ...status, [field]: "fixture-private" }).success).toBe(false);
  });
  it("does not elevate a legacy hook bit into managed fleet support", () => {
    const value = Capabilities.parse({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
      streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [],
      dynamicTools: true, mcp: [], skills: false, hooks: true, sandbox: ["none"], byok: true,
    } });
    expect(value.features.tenantHooks).toEqual([]); expect(value.features.tenantHooksIdentity).toBeNull();
    expect(TenantHooksFleetRequest.safeParse({ nonce: "a".repeat(64), identity: { keyId: "fixture", keySha256: "b".repeat(64) }, tenantId: "other" }).success).toBe(false);
  });
  it("keeps content-free completion durable and binds the actual call item rather than only a reused call ID", () => {
    const value = { type: "tenant-hook/completed", sessionId: "sess_00000000-0000-7000-8000-000000000001",
      turnId: "turn_00000000-0000-7000-8000-000000000002", callItemId: "item_00000000-0000-7000-8000-000000000003",
      toolCallId: "reused-model-call", emittedAtMs: 1, seq: 2, intentId: "a".repeat(64), webhookId: "b".repeat(64),
      configVersionId: "c".repeat(64), phase: "preToolUse", outcome: "acknowledged" };
    expect(Event.safeParse(value).success).toBe(true); expect(EventStreamEvent.safeParse(value).success).toBe(true);
    expect(Event.safeParse({ ...value, callItemId: undefined }).success).toBe(false);
    expect(Event.safeParse({ ...value, intentId: null }).success).toBe(false);
    expect(Event.safeParse({ ...value, payload: "fixture-private" }).success).toBe(false);
  });
});
