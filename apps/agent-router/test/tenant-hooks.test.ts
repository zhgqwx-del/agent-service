import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Capabilities, PROTOCOL_VERSION, MANAGED_TENANT_HOOKS_V1, TenantHooksFleetResponse,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_TENANT_HOOKS_READY_PATH, INTERNAL_TENANT_HOOKS_ACK_HEADER,
  INTERNAL_TENANT_HOOKS_ACK_VALUE } from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

// Real HTTP targets and registry probes. Product auth, durable delivery and SQL use independent tests.
const internal = "fixture-tenant-hooks-private-router-token";
const identity = { keyId: "fixture-hooks", keySha256: "a".repeat(64) };
const servers: Server[] = [], registries: RunnerRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
async function runner() {
  const state = { enabled: true, healthy: true, identity: { ...identity }, probes: 0, calls: [] as string[], invalidResponse: false };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/readyz") { state.probes++; res.writeHead(state.healthy ? 200 : 503).end(); return; }
    if (path === "/v1/capabilities") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
        streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [], dynamicTools: true,
        mcp: [], skills: false, hooks: true, sandbox: ["none"], byok: true,
        ...(state.enabled ? { tenantHooks: [MANAGED_TENANT_HOOKS_V1], tenantHooksIdentity: state.identity } : {}),
      } })); return;
    }
    for await (const _chunk of req) { /* Consume the request without storing signing material. */ }
    state.calls.push(path); res.setHeader("content-type", "application/json");
    if (state.invalidResponse) { res.end(JSON.stringify({ data: [], nextCursor: null, signingKey: "fixture-private-canary" })); return; }
    if (path === "/v1/tenant-hooks" && req.method === "POST") {
      res.writeHead(201); res.end(JSON.stringify({ registration: { name: "audit", revision: 1, generation: 1,
        state: "enabled", currentVersionId: "b".repeat(64), createdAtMs: 1, updatedAtMs: 1 }, version: null }));
    } else res.end(JSON.stringify({ data: [], nextCursor: null }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return Object.assign(state, { url: `http://127.0.0.1:${address.port}` });
}
async function fixture() {
  const targets = await Promise.all([runner(), runner()]);
  const registry = new RunnerRegistry({ runners: targets.map(target => target.url), internalRouterToken: internal,
    tenantHooksMasterKeyId: identity.keyId });
  registries.push(registry); await registry.refresh();
  const app = createRouterApp({ registry, internalRunnerToken: internal, tenantHooksEnabled: () => true,
    logger: { info() {}, warn() {}, error() {} } });
  return { targets, registry, app };
}
describe("managed tenant hooks router all-configured admission", () => {
  it("rejects legacy-only, unhealthy and key-divergent targets rather than selecting a healthy subset", async () => {
    const f = await fixture(), second = f.targets[1]!;
    for (const variant of ["legacy", "down", "keyId", "keyBytes", "valid"] as const) {
      second.enabled = variant !== "legacy"; second.healthy = variant !== "down"; second.identity = { ...identity };
      if (variant === "keyId") second.identity.keyId = "different-key";
      if (variant === "keyBytes") second.identity.keySha256 = "c".repeat(64);
      const before = f.targets.map(target => target.probes), calls = f.targets.flatMap(target => target.calls).length;
      const response = await f.app.request("/v1/tenant-hooks", { headers: { authorization: "Bearer fixture-admin" } });
      expect(response.status).toBe(variant === "valid" ? 200 : 503);
      expect(f.targets.map(target => target.probes)).toEqual(before.map(count => count + 1));
      expect(f.targets.flatMap(target => target.calls)).toHaveLength(calls + (variant === "valid" ? 1 : 0));
    }
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.tenantHooks).toEqual([MANAGED_TENANT_HOOKS_V1]); expect(caps.features.tenantHooksIdentity).toEqual(identity);
  });
  it("requires the exact private token and request nonce/identity for each fresh fleet acknowledgement", async () => {
    const f = await fixture(), value = { nonce: "d".repeat(64), identity };
    const request = (body: unknown, token = internal) => f.app.request(INTERNAL_TENANT_HOOKS_READY_PATH, {
      method: "POST", headers: { "content-type": "application/json", [INTERNAL_ROUTER_TOKEN_HEADER]: token }, body: JSON.stringify(body),
    });
    expect((await request(value, "wrong-token")).status).toBe(404);
    expect((await request({ ...value, identity: { ...identity, keySha256: "e".repeat(64) } })).status).toBe(503);
    const response = await request(value); expect(response.status).toBe(200);
    expect(response.headers.get(INTERNAL_TENANT_HOOKS_ACK_HEADER)).toBe(INTERNAL_TENANT_HOOKS_ACK_VALUE);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(TenantHooksFleetResponse.parse(await response.json())).toEqual(value);
    expect((await request({ ...value, tenantId: "forged" })).status).toBe(503);
    expect((await f.app.request(INTERNAL_TENANT_HOOKS_READY_PATH)).status).toBe(404);
  });
  it("gates actual session/turn admissions when enabled, and rejects upstream response secret fields", async () => {
    const f = await fixture(); f.targets[1]!.enabled = false;
    for (const path of ["/v1/sessions", "/v1/sessions/sess_fixture/turns"]) {
      expect((await f.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    }
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    f.targets[1]!.enabled = true; for (const target of f.targets) target.invalidResponse = true;
    const response = await f.app.request("/v1/tenant-hooks"); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("fixture-private-canary");
  });
});
