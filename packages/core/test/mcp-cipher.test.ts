import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mcpRegistrationId, type McpSecretAad, type McpStoredMaterial } from "@agent-service/store";
import { McpCredentialCipher, McpSecretError, mcpOAuthStateSha256, type McpSecretValue } from "../src/mcp/cipher.js";

const owner = { scope: "tenant" as const, tenantId: "cipher-tenant", userId: null };
function aad(purpose: McpSecretAad["purpose"] = "oauth_tokens"): McpSecretAad {
  return { profile: "mcp-secret-aad-v1", purpose, registrationId: mcpRegistrationId(owner, "fixture"),
    configVersionId: randomUUID(), registrationGeneration: 1, registrationRevision: 1, authorizationEpoch: purpose === "as_client" ? 0 : 1,
    owner, subject: purpose === "as_client" ? null : { tenantId: "cipher-tenant", userId: "alice" },
    materialId: randomUUID(), issuer: "https://issuer.example/", resource: "https://resource.example/mcp", clientId: "fixture-client" };
}
function cipher(keyId = "fixture-v1", byte = 7): McpCredentialCipher { return new McpCredentialCipher({ keyId, key: new Uint8Array(32).fill(byte) }); }
const tokens: McpSecretValue = { purpose: "oauth_tokens", tokenType: "Bearer", accessToken: "fixture-access-material", refreshToken: "fixture-refresh-material" };
function material(c: McpCredentialCipher, binding: McpSecretAad, value = tokens): McpStoredMaterial {
  return { materialId: binding.materialId, aad: binding, envelope: c.encrypt(binding, value) };
}

describe("MCP purpose-bound credential cipher", () => {
  it.each<McpSecretValue>([
    tokens,
    { purpose: "oauth_state", codeVerifier: "v".repeat(43) },
    { purpose: "as_client", clientSecret: "fixture-client-material" },
  ])("roundtrips only its exact purpose and binding ($purpose)", value => {
    const c = cipher(), binding = aad(value.purpose), stored = material(c, binding, value);
    expect(c.open(stored, binding)).toEqual(value);
    expect(JSON.stringify(stored)).not.toContain("fixture-access-material");
    expect(JSON.stringify(stored)).not.toContain("fixture-client-material");
    expect(c.seal(binding, value)).toEqual({ kind: "mcp-encrypted-material-admission-v1" });
    c.close();
  });
  it("uses fresh IVs and canonical AAD despite MySQL JSON key reordering", () => {
    const c = cipher(), binding = aad(), a = material(c, binding), b = material(c, binding);
    expect(a.envelope!.iv).not.toBe(b.envelope!.iv);
    const reordered = Object.fromEntries(Object.entries(binding).reverse()) as unknown as McpSecretAad;
    expect(c.open({ ...a, aad: reordered }, reordered)).toEqual(tokens);
    c.close();
  });
  it.each(["subject", "owner", "purpose", "registrationGeneration", "registrationRevision", "authorizationEpoch", "materialId", "configVersionId", "issuer", "resource", "clientId"] as const)("rejects %s substitution with one fixed error", field => {
    const c = cipher(), binding = aad(), stored = material(c, binding);
    const replacements = { subject: { tenantId: "cipher-tenant", userId: "bob" }, owner: { ...owner, tenantId: "another" }, purpose: "oauth_state",
      registrationGeneration: 2, registrationRevision: 2, authorizationEpoch: 2, materialId: randomUUID(), configVersionId: randomUUID(), issuer: "https://other.example/", resource: "https://other.example/mcp", clientId: "other" };
    expect(() => c.open(stored, { ...binding, [field]: replacements[field] } as McpSecretAad)).toThrow(new McpSecretError());
    c.close();
  });
  it("rejects wrong key, key ID, malformed and tampered envelopes without exposing native diagnostics", () => {
    const c = cipher(), binding = aad(), stored = material(c, binding), wrong = cipher("fixture-v1", 8), renamed = cipher("fixture-v2");
    expect(() => wrong.open(stored, binding)).toThrow(new McpSecretError());
    expect(() => renamed.open(stored, binding)).toThrow(new McpSecretError());
    for (const field of ["iv", "tag", "ciphertext"] as const) {
      expect(() => c.open({ ...stored, envelope: { ...stored.envelope!, [field]: "invalid" } }, binding)).toThrow(new McpSecretError());
    }
    c.close(); wrong.close(); renamed.close();
  });
  it("rejects accessors and cross-purpose plaintext before serialization", () => {
    const c = cipher(), binding = aad(); let touched = false;
    const getter = { purpose: "oauth_tokens", tokenType: "Bearer", refreshToken: null, get accessToken() { touched = true; return "forbidden"; } };
    expect(() => c.encrypt(binding, getter as McpSecretValue)).toThrow(new McpSecretError());
    expect(touched).toBe(false);
    expect(() => c.encrypt(binding, { purpose: "as_client", clientSecret: "fixture" })).toThrow(new McpSecretError());
    c.close();
  });
  it("copies the supplied key, fences after close and derives opaque context-specific state", () => {
    const key = new Uint8Array(32).fill(9), c = new McpCredentialCipher({ keyId: "fixture-v1", key }), binding = aad("oauth_state");
    key.fill(0);
    const stored = material(c, binding, { purpose: "oauth_state", codeVerifier: "v".repeat(43) });
    expect(c.open(stored, binding)).toEqual({ purpose: "oauth_state", codeVerifier: "v".repeat(43) });
    const state = c.authorizationState(binding);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.authorizationState(binding)).toBe(state);
    expect(c.authorizationState({ ...binding, materialId: randomUUID() })).not.toBe(state);
    expect(mcpOAuthStateSha256(state)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => mcpOAuthStateSha256("bad")).toThrow(new McpSecretError());
    c.close(); c.close();
    expect(() => c.open(stored, binding)).toThrow(new McpSecretError());
    expect(() => c.authorizationState(binding)).toThrow(new McpSecretError());
  });
});
