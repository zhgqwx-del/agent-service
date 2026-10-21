import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  ApiError, McpRegistrationResponse, McpAuthorizationStatusResponse,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, INTERNAL_MCP_REGISTRY_CALLBACK_PATH,
  INTERNAL_MCP_REGISTRY_ACK_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE, INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE,
} from "@agent-service/protocol";
import { MemorySessionStore, assertMcpRegistryAccess, type McpRegistrationOwner,
  type McpRegistrationSlot, type McpRegistrationVersion, type McpRegistrationConfig, type McpUserAuthorization } from "@agent-service/store";
import { authMiddleware, hashApiKey, type AuthEnv } from "../src/auth.js";
import { registerMcpRegistryRoutes, type McpRegistryRouteService } from "../src/mcp-registry-routes.js";

// Real Hono/auth/access issuers with a deliberately explicit service fixture. This is permission /
// projection proof, not transport, OAuth exchange, Redis or MySQL evidence.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const internal = "mcp-http-fixture-private-router-token", state = "A".repeat(43);
const config = { endpoint: "https://mcp.example.test/", description: "Fixture MCP", protocolVersion: "2026-07-28" as const,
  authentication: { kind: "none" as const } };
const versionId = "11111111-1111-4111-8111-111111111111";
async function fixture(enabled = true) {
  const store = new MemorySessionStore(); cleanup.push(() => store.close());
  for (const [tenant, key, scopes] of [["tenant-a", "runtime-a", ["runtime"]], ["tenant-a", "admin-a", ["admin", "runtime"]],
    ["tenant-b", "runtime-b", ["runtime"]]] as const) await store.createApiKey(tenant, key, hashApiKey(key), [...scopes]);
  const entries = new Map<string, { slot: McpRegistrationSlot; version: McpRegistrationVersion }>();
  const calls: { method: string; subject?: { tenantId: string; userId: string }; owner?: McpRegistrationOwner; input?: unknown }[] = [];
  const id = (owner: McpRegistrationOwner, name: string) => JSON.stringify([owner, name]);
  let consumed = false;
  const authorization = (subject: { tenantId: string; userId: string }): McpUserAuthorization => ({ authorizationKey: "private-authorization-key",
    registrationId: "private-registration-id", subject, configVersionId: versionId, registrationGeneration: 1, registrationRevision: 1, authorizationEpoch: 2,
    tokenRevision: 1, state: "connected", credentialVersionId: versionId, updatedAtMs: 10 });
  const service: McpRegistryRouteService = {
    async upsert(owner, input) {
      const access = assertMcpRegistryAccess(input.access, owner, "manage"); calls.push({ method: "upsert", owner, subject: access.principal, input });
      const auth = input.config.authentication;
      const storedConfig: McpRegistrationConfig = { endpoint: input.config.endpoint, description: input.config.description,
        protocolVersion: input.config.protocolVersion, authentication: auth.kind === "none" ? { kind: "none" } : auth.kind === "oauth_dynamic" ? {
        kind: "oauth_dynamic", issuer: auth.issuer, clientAuthentication: auth.clientAuthentication, scopes: auth.scopes,
        authorizationEndpoint: "https://as.example.test/authorize", tokenEndpoint: "https://as.example.test/token", registrationEndpoint: "https://as.example.test/register",
        resource: input.config.endpoint, redirectUri: "https://agent.example.test/v1/mcp/oauth/callback", metadataSha256: "a".repeat(64), authorizationResponseIssParameterSupported: true,
      } : {
        kind: "oauth", issuer: auth.issuer, clientId: auth.clientId, clientAuthentication: auth.clientAuthentication,
        scopes: auth.scopes, authorizationEndpoint: "https://as.example.test/authorize", tokenEndpoint: "https://as.example.test/token",
        resource: input.config.endpoint, redirectUri: "https://agent.example.test/v1/mcp/oauth/callback", metadataSha256: "a".repeat(64),
        authorizationResponseIssParameterSupported: true,
      } };
      const slot: McpRegistrationSlot = { registrationId: "b".repeat(64), owner, name: input.name, revision: 1, generation: 1,
        state: "enabled", currentVersionId: versionId, createdAtMs: 1, updatedAtMs: 1 };
      const version: McpRegistrationVersion = { registrationId: slot.registrationId, owner, name: input.name, configVersionId: versionId,
        configSha256: "c".repeat(64), revision: 1, generation: 1, config: storedConfig, createdAtMs: 1,
        clientSecretCommitmentSha256: auth.kind === "oauth" && auth.clientAuthentication === "client_secret_basic" ? "d".repeat(64) : null };
      const result = { slot, version }; entries.set(id(owner, input.name), result); return result;
    },
    async listInstalled(owner, input) {
      assertMcpRegistryAccess(input.access, owner, "manage"); return { items: [...entries.values()].filter(e => JSON.stringify(e.slot.owner) === JSON.stringify(owner)).map(e => e.slot), nextCursor: null };
    },
    async getInstalled(owner, name, input) { assertMcpRegistryAccess(input.access, owner, "manage"); return entries.get(id(owner, name)) ?? null; },
    async setState(owner, name, input) {
      assertMcpRegistryAccess(input.access, owner, "manage"); const entry = entries.get(id(owner, name));
      if (!entry) throw new ApiError("not_found", "MCP server not found.");
      entry.slot = { ...entry.slot, state: input.state, revision: entry.slot.revision + 1 }; return entry.slot;
    },
    async discover(subject, ref) { calls.push({ method: "discover", subject, input: ref }); return []; },
    async refresh(subject, ref) { calls.push({ method: "refresh", subject, input: ref }); return []; },
    async beginAuthorization(subject, ref, input) {
      calls.push({ method: "begin", subject, input: { ...ref, ...input } });
      return { authorizationId: versionId, authorizationUrl: `https://as.example.test/authorize?state=${state}`, expiresAtMs: 100 };
    },
    async registerDynamicClient(owner, name, input) {
      const access = assertMcpRegistryAccess(input.access, owner, "manage"); calls.push({ method: "dcr-register", owner, subject: access.principal, input });
      return { scope: owner.scope, name, configVersionId: input.configVersionId, registration: { state: "ready" as const, operationId: versionId,
        createdAtMs: 1, deadlineAtMs: 100, completedAtMs: 2, manualReviewRequired: false, remoteRevocationSupported: false as const } };
    },
    async getDynamicClientStatus(owner, name, input) {
      const access = assertMcpRegistryAccess(input.access, owner, "manage"); calls.push({ method: "dcr-status", owner, subject: access.principal, input });
      return { scope: owner.scope, name, configVersionId: input.configVersionId, registration: { state: "outcome_unknown" as const, operationId: versionId,
        createdAtMs: 1, deadlineAtMs: 100, completedAtMs: 101, manualReviewRequired: true, remoteRevocationSupported: false as const } };
    },
    async getAuthorization(subject, ref) { calls.push({ method: "status", subject, input: ref }); return authorization(subject); },
    async disconnect(subject, ref, input) { calls.push({ method: "disconnect", subject, input: { ...ref, ...input } });
      return { ...authorization(subject), state: "disconnected", authorizationEpoch: 3 }; },
    async completeAuthorization(input) {
      calls.push({ method: "complete", input });
      if (consumed || input.state !== state) throw new ApiError("not_found", "MCP authorization unavailable.");
      consumed = true; return { status: input.error ? "reauthorization_required" : "connected" };
    },
  };
  const app = new Hono<AuthEnv>(), v1 = new Hono<AuthEnv>();
  app.onError((error, c) => error instanceof ApiError ? c.json(error.toBody(), error.status as 400) : c.json({ error: { code: "internal_error", message: "request failed" } }, 500));
  v1.use("*", authMiddleware({ store, decryptSecret: async () => "unused" }));
  const deps = { service, enabled, maxBodyBytes: 65_536, internalTokenMatches: (value: string | undefined) => value === internal };
  registerMcpRegistryRoutes(v1, app, deps); app.route("/v1", v1);
  const request = (path: string, method = "GET", value?: unknown, options: { key?: string; user?: string | null; idem?: string } = {}) => app.request(path, {
    method, headers: { authorization: `Bearer ${options.key ?? "runtime-a"}`, ...(options.user === null ? {} : { "x-user-id": options.user ?? "alice" }),
      ...(value === undefined ? {} : { "content-type": "application/json" }), ...(options.idem ? { "idempotency-key": options.idem } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const upsert = (scope = "user", options: Parameters<typeof request>[3] = {}, extra = {}) => request("/v1/mcp-servers", "POST",
    { scope, name: "review", expectedRevision: 0, config, ...extra }, { idem: "upsert-review", ...options });
  return { app, request, upsert, calls, deps };
}
describe("managed MCP HTTP authority and safe projections", () => {
  it("uses scope management authority for explicit DCR and retained status, with closed inputs", async () => {
    const f = await fixture(), input = { scope: "user", configVersionId: versionId, expectedRevision: 1 };
    const response = await f.request("/v1/mcp-servers/review/oauth/client/register", "POST", input, { idem: "register-client" });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ scope: "user", registration: { state: "ready", remoteRevocationSupported: false } });
    expect(f.calls[0]).toMatchObject({ method: "dcr-register", owner: { scope: "user", tenantId: "tenant-a", userId: "alice" } });
    expect((await f.request("/v1/mcp-servers/review/oauth/client/register", "POST", { ...input, scope: "tenant" }, { idem: "forbidden" })).status).toBe(403);
    expect((await f.request("/v1/mcp-servers/review/oauth/client/register", "POST", { ...input, scope: "platform" }, { idem: "forbidden" })).status).toBe(400);
    expect((await f.request("/v1/mcp-servers/review/oauth/client/register", "POST", { ...input, userId: "mallory" }, { idem: "forged" })).status).toBe(400);
    const status = await f.request(`/v1/mcp-servers/review/oauth/client/status?scope=tenant&configVersionId=${versionId}`, "GET", undefined, { key: "admin-a" });
    expect(status.status).toBe(200); const value = await status.json() as { registration: unknown }; expect(value.registration).toMatchObject({ state: "outcome_unknown", manualReviewRequired: true });
    expect(JSON.stringify(value)).not.toMatch(/clientSecret|clientId|https:|claimToken|envelope/);
    expect(f.calls).toHaveLength(2); expect(f.calls[1]).toMatchObject({ method: "dcr-status", owner: { scope: "tenant", tenantId: "tenant-a", userId: null } });
  });
  it("keeps platform DCR on the internal operator route", async () => {
    const f = await fixture(), path = `${INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX}/review/oauth/client/register`;
    const input = { configVersionId: versionId, expectedRevision: 1 };
    expect((await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(404);
    const response = await f.app.request(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "operator-register", [INTERNAL_ROUTER_TOKEN_HEADER]: internal }, body: JSON.stringify(input) });
    expect(response.status).toBe(200); expect(response.headers.get(INTERNAL_MCP_REGISTRY_ACK_HEADER)).toBe(INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE);
    expect(f.calls[0]).toMatchObject({ method: "dcr-register", owner: { scope: "platform", tenantId: null, userId: null } });
  });
  it("binds user registration CRUD to the actual tenant/user without requiring admin", async () => {
    const f = await fixture(), response = await f.upsert(); expect(response.status).toBe(201);
    expect(McpRegistrationResponse.parse(await response.json()).registration).toMatchObject({ scope: "user", name: "review", revision: 1 });
    expect(f.calls[0]).toMatchObject({ owner: { scope: "user", tenantId: "tenant-a", userId: "alice" }, subject: { tenantId: "tenant-a", userId: "alice" } });
    expect((await f.request("/v1/mcp-servers/review?scope=user")).status).toBe(200);
    for (const options of [{ user: "bob" }, { key: "runtime-b" }]) expect((await f.request("/v1/mcp-servers/review?scope=user", "GET", undefined, options)).status).toBe(404);
    const deleted = await f.request("/v1/mcp-servers/review", "DELETE", { scope: "user", expectedRevision: 1 }, { idem: "delete" });
    expect(deleted.status).toBe(200); expect(await deleted.json()).toMatchObject({ state: "deleted", revision: 2 });
  });
  it("requires admin for tenant management and rejects scope/identity authority injection", async () => {
    const f = await fixture(); expect((await f.upsert("tenant")).status).toBe(403);
    expect((await f.upsert("tenant", { key: "admin-a", user: null })).status).toBe(201);
    expect((await f.request("/v1/mcp-servers?scope=tenant")).status).toBe(403);
    expect((await f.upsert("platform", { key: "admin-a" })).status).toBe(400);
    for (const extra of [{ userId: "bob" }, { tenantId: "tenant-b" }, { access: { authority: "platform_operator" } }]) expect((await f.upsert("user", {}, extra)).status).toBe(400);
    expect((await f.upsert("user", { user: null })).status).toBe(400);
  });
  it("keeps OAuth client secrets and derived metadata out of every registration response", async () => {
    const f = await fixture(), response = await f.upsert("user", {}, { config: { ...config, authentication: {
      kind: "oauth", issuer: "https://as.example.test/", clientId: "fixture-client", clientAuthentication: "client_secret_basic", clientSecret: "fixture-only-write-secret", scopes: ["read"] } } });
    expect(response.status).toBe(201); const wire = await response.text(); expect(McpRegistrationResponse.parse(JSON.parse(wire)).version!.config.authentication).toEqual({
      kind: "oauth", issuer: "https://as.example.test/", clientId: "fixture-client", clientAuthentication: "client_secret_basic", scopes: ["read"] });
    for (const forbidden of ["clientSecret", "fixture-only-write-secret", "authorizationEndpoint", "tokenEndpoint", "redirectUri", "metadataSha256", "clientSecretCommitmentSha256", "tenantId", "userId"])
      expect(wire).not.toContain(forbidden);
  });
  it("rejects missing idempotency, duplicate queries and forbidden OAuth configuration before service execution", async () => {
    const f = await fixture();
    expect((await f.request("/v1/mcp-servers", "POST", { scope: "user", name: "review", expectedRevision: 0, config })).status).toBe(400);
    expect((await f.request("/v1/mcp-servers?scope=user&scope=tenant")).status).toBe(400);
    for (const extra of [{ redirectUri: "https://attacker.example/" }, { tokenEndpoint: "https://attacker.example/" }, { headers: { authorization: "x" } }])
      expect((await f.upsert("user", {}, { config: { ...config, ...extra } })).status).toBe(400);
    expect(f.calls).toEqual([]);
  });
  it("keeps registration ownership separate from the actual OAuth credential subject", async () => {
    const f = await fixture();
    const status = await f.request("/v1/mcp-servers/review/oauth/status?scope=tenant", "GET", undefined, { key: "admin-a", user: "alice" });
    expect(status.status).toBe(200); const wire = await status.text(); expect(McpAuthorizationStatusResponse.parse(JSON.parse(wire)).authorization!.state).toBe("connected");
    expect(f.calls[0]).toMatchObject({ method: "status", subject: { tenantId: "tenant-a", userId: "alice" }, input: { scope: "tenant", name: "review" } });
    for (const field of ["authorizationKey", "registrationId", "credentialVersionId", "subject", "tenantId", "userId"]) expect(wire).not.toContain(field);
    expect((await f.request("/v1/mcp-servers/review/oauth/status?scope=tenant", "GET", undefined, { key: "admin-a", user: null })).status).toBe(400);
    expect((await f.request("/v1/mcp-servers/review/oauth/begin", "POST", { scope: "tenant", userId: "bob" }, { idem: "begin" })).status).toBe(400);
    expect((await f.request("/v1/mcp-servers/review/oauth/begin", "POST", { scope: "platform" }, { idem: "begin" })).status).toBe(200);
    expect((await f.request("/v1/mcp-servers/review/oauth/disconnect", "POST", { scope: "platform", expectedAuthorizationEpoch: 2 }, { idem: "disconnect" })).status).toBe(200);
    expect((await f.request("/v1/mcp-servers/review/tools?scope=user")).status).toBe(200);
    expect((await f.request("/v1/mcp-servers/review/refresh", "POST", { scope: "user" })).status).toBe(200);
    expect(f.calls.filter(c => c.method === "refresh")).toHaveLength(1);
  });
  it("admits platform operations only through a private versioned router token and ACK", async () => {
    const f = await fixture(); expect((await f.request("/v1/platform/mcp-servers")).status).toBe(404);
    expect((await f.request(INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX)).status).toBe(404);
    const response = await f.app.request(INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: internal, "content-type": "application/json", "idempotency-key": "platform-upsert" },
      body: JSON.stringify({ name: "review", expectedRevision: 0, config }) });
    expect(response.status).toBe(201); expect(response.headers.get(INTERNAL_MCP_REGISTRY_ACK_HEADER)).toBe(INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE);
    expect(McpRegistrationResponse.parse(await response.json()).registration.scope).toBe("platform");
    expect(f.calls[0]).toMatchObject({ owner: { scope: "platform", tenantId: null, userId: null } });
  });
  it("has no public runner callback and uses persistent state rather than caller identity on the private callback", async () => {
    const f = await fixture();
    // The ordinary v1 authentication middleware also protects unknown paths. Prove absence after
    // successful ordinary authentication rather than mistaking its earlier 401 for a callback.
    expect((await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=code`)).status).toBe(401);
    expect((await f.request(`/v1/mcp/oauth/callback?state=${state}&code=code`)).status).toBe(404);
    expect(f.calls).toEqual([]);
    expect((await f.app.request(`${INTERNAL_MCP_REGISTRY_CALLBACK_PATH}?state=${state}&code=code`)).status).toBe(404);
    const callback = () => f.app.request(`${INTERNAL_MCP_REGISTRY_CALLBACK_PATH}?state=${state}&code=fixture-code&iss=https%3A%2F%2Fas.example.test%2F`, { headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: internal, "x-user-id": "mallory", host: "attacker.example", "x-forwarded-host": "attacker.example" } });
    const response = await callback(); expect(response.status).toBe(200);
    expect(response.headers.get(INTERNAL_MCP_REGISTRY_ACK_HEADER)).toBe(INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const wire = await response.text(); for (const value of [state, "fixture-code", "mallory", "attacker.example"]) expect(wire).not.toContain(value);
    expect(f.calls).toEqual([{ method: "complete", input: { state, code: "fixture-code", iss: "https://as.example.test/", error: undefined } }]);
    const replay = await callback(); expect(replay.status).toBe(400); expect(await replay.text()).not.toContain(state);
  });
  it("rejects duplicate or injected callback parameters and never reflects a remote error description", async () => {
    const f = await fixture();
    for (const suffix of [`state=${state}&state=${state}&code=code`, `state=${state}&code=a&code=b`, `state=${state}&code=x&returnTo=https://attacker.example/`,
      `state=${state}&code=x&userId=mallory`, `state=${state}&code=x&error=access_denied`]) {
      const response = await f.app.request(`${INTERNAL_MCP_REGISTRY_CALLBACK_PATH}?${suffix}`, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } });
      expect(response.status).toBe(400); expect(await response.text()).not.toContain("attacker");
    }
    expect(f.calls).toEqual([]);
    const response = await f.app.request(`${INTERNAL_MCP_REGISTRY_CALLBACK_PATH}?state=${state}&error=access_denied&error_description=private-remote-description`, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-remote-description");
    expect(f.calls[0]).toEqual({ method: "complete", input: { state, error: "access_denied", code: undefined, iss: undefined } });
  });
  it("fails closed with the gate off, including a late callback, without invoking service operations", async () => {
    const f = await fixture(false); expect((await f.upsert()).status).toBe(503);
    const response = await f.app.request(`${INTERNAL_MCP_REGISTRY_CALLBACK_PATH}?state=${state}&code=code`, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } });
    expect(response.status).toBe(400); expect(f.calls).toEqual([]);
  });
});
