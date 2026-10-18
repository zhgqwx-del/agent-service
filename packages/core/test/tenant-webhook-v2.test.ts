import { describe, expect, it } from "vitest";
import { tenantWebhookCanonicalJson } from "../src/hooks/cipher.js";
import { createTenantWebhookResponse, signTenantWebhookRequest, validateTenantWebhookRequest, verifyTenantWebhookResponse,
  tenantWebhookPromptBody } from "../src/hooks/webhook-v2.js";

const key = Buffer.alloc(32, 9);
function request(phase: "preToolUse" | "postToolUse" = "preToolUse", bodyScopes: Array<"prompt" | "tool_arguments" | "tool_result"> = []) {
  const body: Record<string, unknown> = {};
  if (bodyScopes.includes("prompt")) body.prompt = { profile: "current_turn_user_text_v1", textParts: ["current user text"] };
  if (bodyScopes.includes("tool_arguments")) body.tool_arguments = { selected: "argument" };
  if (bodyScopes.includes("tool_result")) body.tool_result = { content: [{ type: "text", text: "canonical" }] };
  return signTenantWebhookRequest({ schema: "agent-service-tenant-tool-hook-request-v2", webhookId: "a".repeat(64),
    configVersionId: "b".repeat(64), configSha256: "c".repeat(64), phase, invocationId: "d".repeat(64),
    refs: { tenant: "1".repeat(64), user: "2".repeat(64), session: "3".repeat(64), turn: "4".repeat(64), callItem: "5".repeat(64) },
    tool: { name: "echo", kind: "builtin" }, isError: phase === "preToolUse" ? null : false,
    bodyScopes, ...(bodyScopes.length ? { body } : {}) }, key);
}
describe("tenant webhook v2 observer wire (synthetic cryptographic tests)", () => {
  it.each(([[], ["prompt"], ["tool_arguments"], ["prompt", "tool_arguments"]] as const).map(scopes => [scopes] as const))("supports the exact pre scope matrix %j, never the ordinary tool approval", scopes => {
    const value = request("preToolUse", [...scopes]);
    expect(validateTenantWebhookRequest(value, key).bodyScopes).toEqual(scopes);
    expect(Object.hasOwn(value, "body")).toBe(scopes.length > 0);
    expect(Object.hasOwn(value, "approval")).toBe(false);
    const reply = createTenantWebhookResponse(value, key);
    expect(reply.decision).toBe("ack");
    expect(verifyTenantWebhookResponse(tenantWebhookCanonicalJson(reply), value, key)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(([[], ["prompt"], ["tool_arguments"], ["tool_result"], ["prompt", "tool_arguments"], ["prompt", "tool_result"], ["tool_arguments", "tool_result"], ["prompt", "tool_arguments", "tool_result"]] as const).map(scopes => [scopes] as const))("supports the exact post scope matrix %j", scopes => {
    expect(validateTenantWebhookRequest(request("postToolUse", [...scopes]), key).bodyScopes).toEqual(scopes);
  });
  it("rejects pre result scope, extra credential/header fields and modified signed payloads", () => {
    expect(() => validateTenantWebhookRequest(request("preToolUse", ["tool_result"]), key)).toThrow();
    const value = request();
    for (const extra of [{ headers: {} }, { provider: {} }, { authorization: "fixture" }, { body: { tool_result: {} } }]) {
      expect(() => validateTenantWebhookRequest({ ...value, ...extra }, key)).toThrow();
    }
    expect(() => validateTenantWebhookRequest({ ...value, invocationId: "e".repeat(64) }, key)).toThrow();
  });
  it("never treats allow/deny/rewrite as a v2 decision and rejects duplicate/escaped duplicate wire fields", () => {
    const value = request(), response = createTenantWebhookResponse(value, key);
    for (const decision of ["allow", "deny", "rewrite"]) expect(() => verifyTenantWebhookResponse(JSON.stringify({ ...response, decision }), value, key)).toThrow();
    for (const name of ['"decision"', '"decis\\u0069on"']) {
      const raw = `${JSON.stringify(response).slice(0, -1)},${name}:"ack"}`;
      expect(() => verifyTenantWebhookResponse(raw, value, key)).toThrow();
    }
  });
  it("binds every response to the exact invocation/config/request and uses domains disjoint from operator v1", () => {
    const value = request(), response = createTenantWebhookResponse(value, key);
    for (const field of ["invocationId", "configVersionId", "requestSha256", "webhookId"] as const) {
      expect(() => verifyTenantWebhookResponse(JSON.stringify({ ...response, [field]: "e".repeat(64) }), value, key)).toThrow();
    }
    expect(() => validateTenantWebhookRequest({ ...value, schema: "agent-service-tool-hook-request-v1" }, key)).toThrow();
  });
  it("does not silently truncate an oversized selected body", () => {
    const value = request("postToolUse", ["tool_result"]);
    const { requestSha256: _digest, macSha256: _mac, ...base } = value;
    expect(() => signTenantWebhookRequest({ ...base, body: { tool_result: "x".repeat(20_000) } }, key)).toThrow();
  });
  it("projects only the already-selected original text snapshot, never its raw owner/item identities", () => {
    const projected = tenantWebhookPromptBody({ profile: "current_turn_user_text_v1", throughSeq: 9, sha256: "a".repeat(64),
      parts: [{ itemId: "item_private", seq: 3, partIndex: 0, text: "original text", textSha256: "b".repeat(64) }] });
    expect(projected).toEqual({ profile: "current_turn_user_text_v1", textParts: ["original text"] });
    expect(JSON.stringify(projected).includes("item_private")).toBe(false);
  });
});
