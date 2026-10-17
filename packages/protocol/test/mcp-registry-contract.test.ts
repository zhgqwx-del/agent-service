import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  Capabilities, MANAGED_MCP_REGISTRY_V1, MCP_OAUTH_CALLBACK_PATH,
  McpRegistrationRef, McpRegistrationRefs, McpRegistrationScopeQuery, McpRegistryHeaders,
  McpRegistrationConfigRequest, McpRegistrationUpsertRequest, McpRegistrationConfigResponse,
  McpOAuthCallbackQuery, AgentDefinitionRequest, McpAuthorizationStatusResponse,
  mcpRegistryCallbackUrlSha256, McpRegistryIdentityCapability,
  McpRegistryFleetRequest, McpRegistryFleetResponse, mcpCoordinationNamespaceSha256,
  McpOAuthIssuerUrl, McpRegistryUrl,
  PROTOCOL_VERSION,
} from "../src/index.js";

describe("managed MCP registry wire contract", () => {
  it("uses explicit bounded scope/name mounts without reinterpreting operator ids", () => {
    const refs = [{ scope: "user", name: "review" }, { scope: "tenant", name: "review" }];
    expect(McpRegistrationRefs.parse(refs)).toEqual(refs);
    for (const value of ["operator-server", { scope: "user", name: "Review" },
      { scope: "user", name: "x".repeat(65) }, { scope: "user", name: "review", tenantId: "other" },
      { scope: "platform", name: "review", access: "operator" }]) {
      expect(McpRegistrationRef.safeParse(value).success).toBe(false);
    }
    expect(McpRegistrationRefs.safeParse([refs[0], refs[0]]).success).toBe(false);
    expect(McpRegistrationRefs.safeParse(Array.from({ length: 9 }, (_, i) => ({ scope: "user", name: `server-${i}` }))).success).toBe(false);
  });

  it("does not admit platform or caller identity through public management scope", () => {
    expect(McpRegistrationScopeQuery.parse({ scope: "user" })).toEqual({ scope: "user" });
    expect(McpRegistrationScopeQuery.parse({ scope: "tenant" })).toEqual({ scope: "tenant" });
    for (const value of [{ scope: "platform" }, { scope: "user", userId: "other" },
      { scope: "tenant", tenantId: "other" }, { scope: "user", access: {} }]) {
      expect(McpRegistrationScopeQuery.safeParse(value).success).toBe(false);
    }
  });

  it("keeps mutation idempotency bounded and excludes framing characters", () => {
    expect(McpRegistryHeaders.parse({ "idempotency-key": "mcp-operation-1" })).toEqual({ "idempotency-key": "mcp-operation-1" });
    for (const key of ["", "x".repeat(129), "line\nbreak", "line\rbreak", "nul\0value"]) {
      expect(McpRegistryHeaders.safeParse({ "idempotency-key": key }).success).toBe(false);
    }
  });

  it("requires a separate versioned capability instead of legacy transport support", () => {
    const legacy = { protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
      streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
      sessionLifecycle: ["archive", "unarchive", "tombstone"], dynamicTools: true,
      mcp: ["streamable-http"], skills: false, sandbox: ["none"], byok: true,
    } };
    expect(Capabilities.parse(legacy).features.mcpRegistry).toEqual([]);
    expect(Capabilities.parse({ ...legacy, features: { ...legacy.features, mcpRegistry: [MANAGED_MCP_REGISTRY_V1] } }).features.mcpRegistry)
      .toEqual([MANAGED_MCP_REGISTRY_V1]);
    expect(Capabilities.safeParse({ ...legacy, features: { ...legacy.features, mcpRegistry: ["future-v2"] } }).success).toBe(false);
    expect(Capabilities.safeParse({ ...legacy, features: { ...legacy.features, mcpRegistry: [MANAGED_MCP_REGISTRY_V1, MANAGED_MCP_REGISTRY_V1] } }).success).toBe(false);
    expect(MCP_OAUTH_CALLBACK_PATH).toBe("/v1/mcp/oauth/callback");
  });

  it("pins both supported protocols and only accepts explicitly bounded OAuth scopes and write-only secrets", () => {
    const base = { endpoint: "https://mcp.example.test/", description: "MCP", protocolVersion: "2026-07-28", authentication: { kind: "none" } };
    expect(McpRegistrationConfigRequest.parse(base)).toEqual(base);
    expect(McpRegistrationConfigRequest.safeParse({ ...base, protocolVersion: "2025-11-25" }).success).toBe(true);
    expect(McpRegistrationConfigRequest.safeParse({ ...base, protocolVersion: "2025-03-26" }).success).toBe(false);
    const auth = { kind: "oauth", issuer: "https://as.example.test/", clientId: "client", clientAuthentication: "none" };
    expect(McpRegistrationConfigRequest.parse({ ...base, authentication: auth }).authentication).toEqual({ ...auth, scopes: [] });
    for (const scopes of [["read", "read"], ["read write"], ["a\\b"], ['a"b'], ["汉字"], ["x".repeat(129)], Array.from({ length: 33 }, (_, i) => `scope-${i}`)])
      expect(McpRegistrationConfigRequest.safeParse({ ...base, authentication: { ...auth, scopes } }).success).toBe(false);
    expect(McpRegistrationConfigRequest.safeParse({ ...base, authentication: { kind: "none", scopes: [] } }).success).toBe(false);
    expect(McpRegistrationConfigRequest.safeParse({ ...base, authentication: { ...auth, clientSecret: "not-for-public-client" } }).success).toBe(false);
    expect(McpRegistrationConfigRequest.safeParse({ ...base, authentication: { ...auth, clientAuthentication: "client_secret_basic", clientSecret: "fixture-secret" } }).success).toBe(true);
    expect(McpRegistrationConfigResponse.safeParse({ ...base, authentication: { ...auth, scopes: [], clientSecret: "fixture-secret" } }).success).toBe(false);
    for (const field of ["authorizationEndpoint", "tokenEndpoint", "redirectUri", "metadataSha256", "headers", "clientProfileId"])
      expect(McpRegistrationConfigRequest.safeParse({ ...base, authentication: { ...auth, [field]: "forbidden" } }).success).toBe(false);
    expect(McpRegistrationUpsertRequest.safeParse({ scope: "user", name: "review", expectedRevision: -1, config: base }).success).toBe(false);
  });

  it("bounds combined legacy and managed mounts while preserving their distinct namespaces", () => {
    const base = { name: "MCP agent", model: { provider: "test", model: "test" }, mcpServers: ["review"] };
    expect(AgentDefinitionRequest.parse({ ...base, mcpRegistrations: [{ scope: "user", name: "review" }] }).mcpRegistrations).toEqual([{ scope: "user", name: "review" }]);
    expect(AgentDefinitionRequest.parse(base).mcpRegistrations).toEqual([]);
    expect(AgentDefinitionRequest.safeParse({ ...base, mcpServers: Array.from({ length: 8 }, (_, i) => `legacy-${i}`), mcpRegistrations: [{ scope: "user", name: "review" }] }).success).toBe(false);
  });

  it("accepts only the fixed query callback shape and excludes subject/redirect/credential injection", () => {
    const base = { state: "A".repeat(43), code: "bounded-code" };
    expect(McpOAuthCallbackQuery.parse(base)).toEqual(base);
    for (const extra of [{ state: "short" }, { userId: "other" }, { tenantId: "other" }, { returnTo: "https://attacker.example/" },
      { redirectUri: "https://attacker.example/" }, { error: "access_denied" }, { access_token: "forbidden" }])
      expect(McpOAuthCallbackQuery.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(McpAuthorizationStatusResponse.safeParse({ scope: "user", name: "review", authorization: {
      state: "connected", authorizationEpoch: 1, tokenRevision: 1, updatedAtMs: 1, accessToken: "forbidden" } }).success).toBe(false);
  });

  it("binds fleet identity to the exact configured callback without exposing configuration or key bytes", () => {
    const url = "https://agent.example.test/v1/mcp/oauth/callback";
    expect(mcpRegistryCallbackUrlSha256(url)).toBe(createHash("sha256").update("mcp-callback-url-v1\0").update(JSON.stringify(url)).digest("hex"));
    expect(mcpRegistryCallbackUrlSha256(url)).not.toBe(mcpRegistryCallbackUrlSha256(`${url}/`));
    const identity = { credentialKeyId: "mcp-key-v1", credentialKeySha256: "a".repeat(64), callbackUrlSha256: mcpRegistryCallbackUrlSha256(url), coordinationNamespaceSha256: "b".repeat(64) };
    expect(McpRegistryIdentityCapability.parse(identity)).toEqual(identity);
    expect(McpRegistryIdentityCapability.safeParse({ ...identity, key: "never-public" }).success).toBe(false);
  });

  it("uses closed nonce-bound fleet acknowledgements and one Redis namespace encoding", () => {
    const namespace = { prefix: "as.fixture:v1", namespaceId: "shared.redis-1" };
    expect(mcpCoordinationNamespaceSha256(namespace)).toBe(createHash("sha256").update("mcp-coordination-namespace-v1\0")
      .update(JSON.stringify({ namespaceId: namespace.namespaceId, prefix: namespace.prefix })).digest("hex"));
    const value = { nonce: "a".repeat(64), identity: { credentialKeyId: "key-v1", credentialKeySha256: "b".repeat(64),
      callbackUrlSha256: "c".repeat(64), coordinationNamespaceSha256: mcpCoordinationNamespaceSha256(namespace) } };
    expect(McpRegistryFleetRequest.parse(value)).toEqual(value); expect(McpRegistryFleetResponse.parse(value)).toEqual(value);
    for (const bad of [{ ...value, nonce: "A".repeat(64) }, { ...value, principal: "forged" }, { ...value, identity: { ...value.identity, key: "forbidden" } }])
      expect(McpRegistryFleetRequest.safeParse(bad).success).toBe(false);
    expect(() => mcpCoordinationNamespaceSha256({ prefix: "bad prefix", namespaceId: "namespace" })).toThrow();
  });

  it("preserves exact OAuth issuer origins without relaxing endpoint, callback or normalized URL identity", () => {
    for (const issuer of ["https://as.example", "https://as.example/", "https://as.example/tenant"]) {
      expect(McpOAuthIssuerUrl.parse(issuer)).toBe(issuer);
      expect(McpOAuthCallbackQuery.parse({ state: "A".repeat(43), code: "code", iss: issuer }).iss).toBe(issuer);
      expect(McpRegistrationConfigRequest.parse({ endpoint: "https://mcp.example/", description: "MCP", protocolVersion: "2026-07-28",
        authentication: { kind: "oauth", issuer, clientId: "client", clientAuthentication: "none", scopes: [] } }).authentication)
        .toMatchObject({ issuer });
    }
    expect(McpRegistryUrl.safeParse("https://as.example").success).toBe(false);
    expect(McpRegistryUrl.parse("https://as.example/")).toBe("https://as.example/");
    for (const issuer of ["https://AS.example", "HTTPS://as.example", "https://as.example:443", "https://user:secret@as.example/",
      "https://as.example?x=1", "https://as.example#fragment", "https://as.example/?", "https://as.example/#", "https://as.example/one/../two", "https://as.example\n", " https://as.example/", "http://as.example/", "file:///tmp/issuer"])
      expect(McpOAuthIssuerUrl.safeParse(issuer).success, issuer).toBe(false);
  });
});
