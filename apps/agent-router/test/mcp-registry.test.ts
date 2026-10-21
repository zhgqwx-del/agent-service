import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Capabilities, PROTOCOL_VERSION, MANAGED_MCP_REGISTRY_V1, McpRegistryFleetResponse,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, INTERNAL_MCP_REGISTRY_CALLBACK_PATH,
  INTERNAL_MCP_REGISTRY_ACK_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE, INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE,
  INTERNAL_MCP_REGISTRY_READY_PATH, INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER, INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE,
  mcpRegistryCallbackUrlSha256, mcpCoordinationNamespaceSha256,
  MANAGED_MCP_DCR_V1, INTERNAL_MCP_DCR_READY_PATH, INTERNAL_MCP_DCR_FLEET_ACK_VALUE,
} from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

// Actual loopback HTTP runner fixtures prove router transport and all-configured admission, not
// actual OAuth/AS/Redis/MCP tool execution. Those are covered by the independent native vertical.
const internal = "fixture-mcp-private-router-token-0001", operator = "fixture-mcp-platform-operator-token-0001";
const callbackUrl = "https://agent.example.test/v1/mcp/oauth/callback";
const identity = { credentialKeyId: "fixture-key", credentialKeySha256: "a".repeat(64),
  callbackUrlSha256: mcpRegistryCallbackUrlSha256(callbackUrl),
  coordinationNamespaceSha256: mcpCoordinationNamespaceSha256({ prefix: "as", namespaceId: "fixture" }) };
const logger = { info() {}, warn() {}, error() {} }, state = "A".repeat(43), versionId = "11111111-1111-4111-8111-111111111111";
const registries: RunnerRegistry[] = [], servers: Server[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(registries.splice(0).map(r => r.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
const slot = (scope: "user" | "platform" = "user") => ({ scope, name: "review", revision: 1, generation: 1, state: "enabled",
  currentVersionId: versionId, createdAtMs: 1, updatedAtMs: 1 });
const document = (enabled: boolean, actual: typeof identity, dynamic = false) => ({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
  streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
  sessionLifecycle: ["archive", "unarchive", "tombstone"], dynamicTools: true, mcp: ["streamable-http"], skills: false, sandbox: ["none"], byok: true,
  ...(enabled ? { mcpRegistry: [MANAGED_MCP_REGISTRY_V1], mcpRegistryIdentity: actual } : {}),
  ...(dynamic ? { mcpDynamicRegistration: [MANAGED_MCP_DCR_V1] } : {}),
} });
async function runner() {
  const f = { healthy: true, enabled: true, dynamic: false, identity: { ...identity }, ack: true, probes: 0,
    requests: [] as { path: string; method: string; headers: IncomingHttpHeaders; body: string }[],
    callbackBarrier: undefined as Promise<void> | undefined };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/readyz") { f.probes++; res.writeHead(f.healthy ? 200 : 503).end(); return; }
    if (path === "/v1/capabilities") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(document(f.enabled, f.identity, f.dynamic))); return; }
    let body = ""; for await (const chunk of req) body += String(chunk);
    f.requests.push({ path: req.url!, method: req.method!, headers: req.headers, body });
    if (path === INTERNAL_MCP_REGISTRY_CALLBACK_PATH) {
      if (f.callbackBarrier) await f.callbackBarrier;
      if (res.destroyed) return;
      if (f.ack) res.setHeader(INTERNAL_MCP_REGISTRY_ACK_HEADER, INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE);
      res.setHeader("set-cookie", "private-upstream-cookie=1"); res.setHeader("content-type", "text/html");
      res.end(`unsafe upstream reflection ${req.url}`); return;
    }
    const platform = path.startsWith(INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX);
    if (platform && f.ack) res.setHeader(INTERNAL_MCP_REGISTRY_ACK_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE);
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/v1/mcp-servers") || platform) {
      if (path.endsWith("/oauth/client/register") || path.endsWith("/oauth/client/status")) {
        res.end(JSON.stringify({ scope: platform ? "platform" : "user", name: "review", configVersionId: versionId, registration: {
          state: "outcome_unknown", operationId: versionId, createdAtMs: 1, deadlineAtMs: 10, completedAtMs: 11, manualReviewRequired: true, remoteRevocationSupported: false,
        } }));
      } else if (req.method === "POST" && (path === "/v1/mcp-servers" || path === INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX)) {
        res.writeHead(201); res.end(JSON.stringify({ registration: slot(platform ? "platform" : "user"), version: null }));
      } else res.end(JSON.stringify({ data: [], nextCursor: null }));
    } else res.end(JSON.stringify({ ok: true }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return Object.assign(f, { url: `http://127.0.0.1:${address.port}` });
}
async function fixture(count = 2) {
  const targets = await Promise.all(Array.from({ length: count }, runner));
  const registry = new RunnerRegistry({ runners: targets.map(t => t.url), internalRouterToken: internal,
    mcpRegistryCredentialKeyId: identity.credentialKeyId, mcpRegistryCallbackUrlSha256: identity.callbackUrlSha256,
    mcpRegistryCoordinationNamespaceSha256: identity.coordinationNamespaceSha256 });
  registries.push(registry); await registry.refresh();
  let enabled = true;
  const app = createRouterApp({ registry, logger, internalRunnerToken: internal, mcpRegistryEnabled: () => enabled,
    mcpRegistryOperatorToken: operator, skillRegistryOperatorToken: "fixture-separate-skills-operator-token",
    tenantErasureOperatorToken: "fixture-separate-erasure-operator-token" });
  return { targets, registry, app, disable: () => { enabled = false; } };
}
const totalRequests = (f: Awaited<ReturnType<typeof fixture>>) => f.targets.flatMap(t => t.requests);
describe("managed MCP router complete fresh fleet and role isolation", () => {
  it("requires every fresh configured runner to support DCR and binds its private proof", async () => {
    const f = await fixture(), body = { nonce: "e".repeat(64), identity, capability: MANAGED_MCP_DCR_V1 };
    const proof = () => f.app.request(INTERNAL_MCP_DCR_READY_PATH, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: internal, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await proof()).status).toBe(503); expect(f.registry.allConfiguredSupportMcpRegistry()).toBe(true);
    f.targets[0]!.dynamic = true; expect((await proof()).status).toBe(503);
    f.targets[1]!.dynamic = true; const response = await proof(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body); expect(response.headers.get(INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER)).toBe(INTERNAL_MCP_DCR_FLEET_ACK_VALUE);
    f.targets[1]!.dynamic = false; expect((await proof()).status).toBe(503);
    expect(totalRequests(f)).toHaveLength(0);
  });
  it("gates explicit DCR management routes before dispatch and preserves unknown without retries", async () => {
    const f = await fixture(), body = JSON.stringify({ scope: "user", configVersionId: versionId, expectedRevision: 1 });
    const register = () => f.app.request("/v1/mcp-servers/review/oauth/client/register", { method: "POST", headers: {
      authorization: "Bearer runtime", "content-type": "application/json", "idempotency-key": "dcr-register" }, body });
    expect((await register()).status).toBe(503); expect(totalRequests(f)).toHaveLength(0);
    const intent = await f.app.request("/v1/mcp-servers", { method: "POST", headers: { authorization: "Bearer runtime", "content-type": "application/json", "idempotency-key": "new-intent" },
      body: JSON.stringify({ scope: "user", name: "review", expectedRevision: 0, config: { endpoint: "https://mcp.example/", description: "DCR", protocolVersion: "2026-07-28",
        authentication: { kind: "oauth_dynamic", issuer: "https://as.example", clientAuthentication: "none", scopes: [] } } }) });
    expect(intent.status).toBe(503); expect(totalRequests(f)).toHaveLength(0);
    f.targets.forEach(t => { t.dynamic = true; }); const response = await register(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ registration: { state: "outcome_unknown", manualReviewRequired: true } }); expect(totalRequests(f)).toHaveLength(1);
    const platform = await f.app.request(`/v1/platform/mcp-servers/review/oauth/client/status?configVersionId=${versionId}`, { headers: { authorization: `Bearer ${operator}` } });
    expect(platform.status).toBe(200); expect(totalRequests(f)).toHaveLength(2);
    const req = totalRequests(f)[1]!; expect(req.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(internal); expect(req.headers.authorization).toBeUndefined();
  });
  it("probes every configured HTTP runner and rejects old, unavailable and all identity mismatches", async () => {
    const f = await fixture(), second = f.targets[1]!;
    for (const variant of ["old", "down", "keyId", "keyBytes", "callback", "namespace", "active"] as const) {
      second.enabled = variant !== "old"; second.healthy = variant !== "down"; second.identity = { ...identity };
      if (variant === "keyId") second.identity.credentialKeyId = "other-key";
      if (variant === "keyBytes") second.identity.credentialKeySha256 = "b".repeat(64);
      if (variant === "callback") second.identity.callbackUrlSha256 = "c".repeat(64);
      if (variant === "namespace") second.identity.coordinationNamespaceSha256 = "d".repeat(64);
      const before = f.targets.map(t => t.probes), calls = totalRequests(f).length;
      const response = await f.app.request("/v1/mcp-servers?scope=user", { headers: { authorization: "Bearer runtime-key", "x-user-id": "alice" } });
      expect(response.status).toBe(variant === "active" ? 200 : 503);
      expect(f.targets.map(t => t.probes)).toEqual(before.map(n => n + 1));
      expect(totalRequests(f)).toHaveLength(calls + (variant === "active" ? 1 : 0));
    }
    const before = f.targets.map(t => t.probes);
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.mcpRegistry).toEqual([MANAGED_MCP_REGISTRY_V1]); expect(caps.features.mcpRegistryIdentity).toEqual(identity);
    expect(f.targets.map(t => t.probes)).toEqual(before.map(n => n + 1));
  });
  it("fresh-gates explicit selectors and all session/turn admissions while preserving default-off legacy MCP", async () => {
    const f = await fixture(); f.targets[1]!.enabled = false;
    for (const [path, value] of [["/v1/agents", { mcpRegistrations: [{ scope: "user", name: "review" }] }], ["/v1/agents", { mcpServers: ["review"] }],
      ["/v1/sessions", { agentId: "agt_fixture" }], ["/v1/sessions/sess_fixture/turns", { input: [{ type: "text", text: "hello" }] }]] as const) {
      const before = f.targets.map(t => t.probes);
      expect((await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })).status).toBe(503);
      expect(f.targets.map(t => t.probes)).toEqual(before.map(n => n + 1));
    }
    expect(totalRequests(f)).toEqual([]); f.disable();
    expect((await f.app.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpRegistrations: [] }) })).status).toBe(503);
    expect((await f.app.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mcpServers: ["review"] }) })).status).toBe(200);
    expect(totalRequests(f)).toHaveLength(1);
  });
  it("admits each private readiness nonce only with an exact all-configured identity and internal token", async () => {
    const f = await fixture(), body = { nonce: "e".repeat(64), identity };
    const request = (value: unknown, token = internal) => f.app.request(INTERNAL_MCP_REGISTRY_READY_PATH, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" }, body: JSON.stringify(value) });
    expect((await request(body, "ordinary-runtime-key")).status).toBe(404);
    const before = f.targets.map(t => t.probes), response = await request(body);
    expect(response.status).toBe(200); expect(McpRegistryFleetResponse.parse(await response.json())).toEqual(body);
    expect(response.headers.get(INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER)).toBe(INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE);
    expect(f.targets.map(t => t.probes)).toEqual(before.map(n => n + 1));
    expect((await request({ ...body, identity: { ...identity, credentialKeySha256: "f".repeat(64) } })).status).toBe(503);
    expect((await request({ ...body, owner: "forged" })).status).toBe(503);
    expect((await f.app.request(INTERNAL_MCP_REGISTRY_READY_PATH, { headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } })).status).toBe(404);
  });
  it("consumes only the independent platform bearer and strips ambient credentials before the private ACK route", async () => {
    const f = await fixture();
    const response = await f.app.request("/v1/platform/mcp-servers", { headers: { authorization: `Bearer ${operator}`, cookie: "secret-cookie=1",
      "x-user-id": "forged", "x-end-user-token": "private-user-token", [INTERNAL_ROUTER_TOKEN_HEADER]: "forged" } });
    expect(response.status).toBe(200); expect(totalRequests(f)).toHaveLength(1);
    const request = totalRequests(f)[0]!; expect(request.path).toBe(INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX);
    expect(request.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(internal);
    for (const name of ["authorization", "cookie", "x-user-id", "x-end-user-token"]) expect(request.headers[name]).toBeUndefined();
    expect(response.headers.get(INTERNAL_MCP_REGISTRY_ACK_HEADER)).toBeNull();
    for (const [path, token] of [["/v1/platform/mcp-servers", "fixture-separate-erasure-operator-token"], ["/v1/platform/mcp-servers", "fixture-separate-skills-operator-token"],
      ["/v1/mcp-servers?scope=user", operator], ["/v1/sessions", operator], [INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, internal], [INTERNAL_MCP_REGISTRY_CALLBACK_PATH, internal]])
      expect((await f.app.request(path!, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect(totalRequests(f)).toHaveLength(1);
  });
  it("requires the platform ACK and never retries an uncertain registration mutation", async () => {
    const f = await fixture(); for (const target of f.targets) target.ack = false;
    const response = await f.app.request("/v1/platform/mcp-servers", { method: "POST", headers: {
      authorization: `Bearer ${operator}`, "content-type": "application/json", "idempotency-key": "register-one" },
      body: JSON.stringify({ name: "review", expectedRevision: 0, config: {} }) });
    expect(response.status).toBe(503); expect(totalRequests(f)).toHaveLength(1);
  });
  it("validates callback query before probes and never forwards caller credentials or upstream reflected content", async () => {
    const f = await fixture(), before = f.targets.map(t => t.probes);
    for (const suffix of [`state=${state}&state=${state}&code=x`, `state=${state}&code=x&returnTo=https://attacker.example/`, "state=short&code=x"]) {
      const response = await f.app.request(`/v1/mcp/oauth/callback?${suffix}`); expect(response.status).toBe(400); expect(await response.text()).not.toContain("attacker");
    }
    expect(f.targets.map(t => t.probes)).toEqual(before); expect(totalRequests(f)).toEqual([]);
    const response = await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=private-code`, { headers: {
      authorization: "Bearer never-forward-this", cookie: "private-cookie=1", "x-user-id": "mallory", "x-forwarded-host": "attacker.example" } });
    expect(response.status).toBe(200); const text = await response.text(); for (const value of [state, "private-code", "unsafe upstream", "mallory"]) expect(text).not.toContain(value);
    expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const request = totalRequests(f)[0]!; expect(request.path).toContain(INTERNAL_MCP_REGISTRY_CALLBACK_PATH);
    for (const name of ["authorization", "cookie", "x-user-id", "x-forwarded-host"]) expect(request.headers[name]).toBeUndefined();
    expect(request.headers[INTERNAL_ROUTER_TOKEN_HEADER]).toBe(internal);
    for (const target of f.targets) target.ack = false;
    expect((await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=x`)).status).toBe(503);
    f.disable(); const calls = totalRequests(f).length;
    expect((await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=x`)).status).toBe(503); expect(totalRequests(f)).toHaveLength(calls);
  });
  it("caps anonymous callbacks at eight actual operations without an unbounded probe queue", async () => {
    const f = await fixture(), pending: Promise<Response>[] = []; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
    for (const target of f.targets) target.callbackBarrier = barrier;
    try {
      for (let n = 0; n < 8; n++) pending.push(Promise.resolve(f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=code-${n}`)));
      await vi.waitFor(() => expect(totalRequests(f)).toHaveLength(8), { timeout: 3_000 });
      const probes = f.targets.map(t => t.probes), rejected = await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=ninth`);
      expect(rejected.status).toBe(503); expect(f.targets.map(t => t.probes)).toEqual(probes); expect(totalRequests(f)).toHaveLength(8);
    } finally { release(); await Promise.all(pending); }
    expect((await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=after-release`)).status).toBe(200);
  });
  it("tracks native callback work through registry close rather than accepting after shutdown", async () => {
    const f = await fixture(1); let release!: () => void;
    f.targets[0]!.callbackBarrier = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
    const pending = f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=x`);
    try {
      await vi.waitFor(() => expect(totalRequests(f)).toHaveLength(1)); await f.registry.close();
      expect((await pending).status).toBe(503);
      expect((await f.app.request(`/v1/mcp/oauth/callback?state=${state}&code=y`)).status).toBe(503);
      expect(totalRequests(f)).toHaveLength(1);
    } finally { release(); await pending; }
  });
});
