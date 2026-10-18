import { describe, expect, it } from "vitest";
import { tenantWebhookAad, type TenantWebhookVersion } from "@agent-service/store";
import { TenantWebhookCipher, tenantWebhookCanonicalJson } from "../src/hooks/cipher.js";

const version: Pick<TenantWebhookVersion, "tenantId" | "webhookId" | "configVersionId" | "generation" | "config" | "keyVersionId"> = {
  tenantId: "tenant_hooks", webhookId: "a".repeat(64), configVersionId: "b".repeat(64), generation: 1, keyVersionId: "b".repeat(64),
  config: { endpoint: "https://hooks.example.test/receiver", phase: "preToolUse", bodyScopes: [] },
};
const context = { principal: { tenantId: version.tenantId, userId: "user_a" }, sessionId: "sess_fixture", turnId: "turn_fixture", callItemId: "item_fixture" };
describe("dedicated tenant webhook purpose-bound cipher", () => {
  it("copies the independent master key, encrypts an exact raw32 signing key, and has content-free identity", () => {
    const bytes = Buffer.alloc(32, 7), cipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: bytes }); bytes.fill(0);
    try {
      const aad = tenantWebhookAad(version, "signing_key"), value = { purpose: "signing_key" as const, signingKeyHex: "c".repeat(64) };
      const encrypted = cipher.encrypt(aad, value);
      expect(Buffer.from(encrypted.ciphertext, "base64")).toHaveLength(32);
      expect(JSON.stringify(cipher.open(aad, encrypted)) === JSON.stringify(value)).toBe(true);
      expect(Object.keys(cipher.identity).sort()).toEqual(["keyId", "keySha256"]);
      expect(cipher.identity.keySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(cipher.signingKeyCommitment(value.signingKeyHex)).toBe(cipher.signingKeyCommitment(value.signingKeyHex));
    } finally { cipher.close(); }
  });
  it.each(["tenant", "subject", "session", "turn", "call", "version", "generation", "endpoint", "scope", "key"])("rejects %s drift without returning native crypto errors", kind => {
    const cipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
    try {
      const aad = tenantWebhookAad(version, "delivery_payload", context), encrypted = cipher.encrypt(aad, { purpose: "delivery_payload", request: { only: "fixture" } });
      const changed = structuredClone(aad);
      if (kind === "tenant") Reflect.set(changed, "tenantId", "another_tenant");
      if (kind === "subject") Reflect.set(changed.subject!, "userId", "another_user");
      if (kind === "session") Reflect.set(changed, "sessionId", "sess_other");
      if (kind === "turn") Reflect.set(changed, "turnId", "turn_other");
      if (kind === "call") Reflect.set(changed, "callItemId", "item_other");
      if (kind === "version") Reflect.set(changed, "configVersionId", "d".repeat(64));
      if (kind === "generation") Reflect.set(changed, "generation", changed.generation + 1);
      if (kind === "endpoint") Reflect.set(changed, "endpointSha256", "d".repeat(64));
      if (kind === "scope") Reflect.set(changed, "bodyScopesSha256", "d".repeat(64));
      expect(() => cipher.open(changed, kind === "key" ? { ...encrypted, keyId: "other_key" } : encrypted)).toThrow("Tenant webhook material is unavailable.");
    } finally { cipher.close(); }
  });
  it("does not accept cross-purpose or MCP/ref/artifact envelopes, and rejects after close", () => {
    const cipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
    const aad = tenantWebhookAad(version, "delivery_payload", context), envelope = cipher.encrypt(aad, { purpose: "delivery_payload", request: {} });
    expect(() => cipher.open(tenantWebhookAad(version, "invocation_snapshot", context), envelope)).toThrow();
    expect(() => cipher.open(aad, { ...envelope, profile: "mcp-aes-256-gcm-v1" } as never)).toThrow();
    cipher.close(); expect(() => cipher.open(aad, envelope)).toThrow();
  });
  it("rejects known credential-shaped purpose values, getters, cycles and unsupported JSON", () => {
    const cipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
    try {
      const aad = tenantWebhookAad(version, "delivery_payload", context);
      expect(() => cipher.encrypt(aad, { purpose: "oauth_tokens", accessToken: "fixture-only" } as never)).toThrow();
      const getter = { get value() { throw new Error("getter must not run"); } };
      expect(() => tenantWebhookCanonicalJson(getter)).toThrow("Tenant webhook material is unavailable.");
      const cycle: unknown[] = []; cycle.push(cycle);
      const sparseWithExtra: unknown[] = ["first"]; sparseWithExtra.length = 2; Object.assign(sparseWithExtra, { other: "not-an-index" });
      for (const value of [cycle, sparseWithExtra, undefined, Number.POSITIVE_INFINITY, new Date(), { toJSON: () => ({}) }]) expect(() => tenantWebhookCanonicalJson(value)).toThrow();
    } finally { cipher.close(); }
  });
});
