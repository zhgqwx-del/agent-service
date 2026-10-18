import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Capabilities, PROTOCOL_VERSION, RUNTIME_EXTENSIONS_V1,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_RUNTIME_EXTENSIONS_READY_PATH,
  INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER, INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE,
  INTERNAL_TOMBSTONE_ACK_HEADER, INTERNAL_SUBAGENT_TOMBSTONE_ACK_VALUE,
  RuntimeExtensionsFleetRequest, RuntimeExtensionsFleetResponse, type RuntimeExtensionsIdentity } from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

const token = "fixture-runtime-extensions-internal-token";
const identity: RuntimeExtensionsIdentity = { lifecycleHooksSha256: "a".repeat(64), subagentsSha256: "b".repeat(64) };
const root = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const servers: Server[] = [], registries: RunnerRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
async function runner() {
  const state = { aware: true, healthy: true, probes: 0, identity: { ...identity }, calls: [] as string[],
    lifecycle: [] as string[], deleteAck: true, privateDeleteProof: [] as boolean[],
    privateMode: "valid" as "valid" | "missing" | "wrong_nonce" | "wrong_token" | "down" | "digest" | "extra" | "wrong_ack" | "cacheable" | "type" | "oversize" | "hold",
    privateNonces: [] as string[], privateTokens: [] as boolean[], privateBodyStarted: false, privateBodyClosed: false };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/readyz") { state.probes++; res.writeHead(state.healthy ? 200 : 503).end(); return; }
    if (path === "/v1/capabilities") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
        streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: state.lifecycle,
        dynamicTools: true, mcp: [], skills: false, hooks: true, sandbox: ["none"], byok: true,
        ...(state.aware ? { runtimeExtensions: [RUNTIME_EXTENSIONS_V1], runtimeExtensionsIdentity: state.identity } : {}),
      } })); return;
    }
    if (path === INTERNAL_RUNTIME_EXTENSIONS_READY_PATH) {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
      const request = RuntimeExtensionsFleetRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      state.privateNonces.push(request.nonce); state.privateTokens.push(req.headers[INTERNAL_ROUTER_TOKEN_HEADER] === token);
      if (req.headers[INTERNAL_ROUTER_TOKEN_HEADER] !== token || state.privateMode === "wrong_token") { res.writeHead(404).end(); return; }
      if (state.privateMode === "missing" || state.privateMode === "down") { res.writeHead(state.privateMode === "missing" ? 404 : 503).end(); return; }
      res.setHeader("content-type", state.privateMode === "type" ? "text/plain" : "application/json");
      res.setHeader("cache-control", state.privateMode === "cacheable" ? "public,max-age=60" : "no-store");
      res.setHeader(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER, state.privateMode === "wrong_ack" ? "wrong" : INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE);
      if (state.privateMode === "hold") {
        state.privateBodyStarted = true; res.once("close", () => { state.privateBodyClosed = true; }); res.write('{"nonce":"'); return;
      }
      res.end(JSON.stringify({ nonce: state.privateMode === "wrong_nonce" ? "f".repeat(64) : request.nonce,
        identity: state.privateMode === "digest" ? { ...state.identity, subagentsSha256: "f".repeat(64) } : state.identity,
        ...(state.privateMode === "extra" ? { extra: true } : {}), ...(state.privateMode === "oversize" ? { padding: "x".repeat(2048) } : {}) })); return;
    }
    for await (const _chunk of req) { /* No stored prompt, authorization or control token. */ }
    state.calls.push(path);
    if (req.method === "DELETE" && path.endsWith("/session")) {
      state.privateDeleteProof.push(req.headers[INTERNAL_ROUTER_TOKEN_HEADER] === token);
      if (state.deleteAck) res.setHeader(INTERNAL_TOMBSTONE_ACK_HEADER, INTERNAL_SUBAGENT_TOMBSTONE_ACK_VALUE);
      res.writeHead(204).end(); return;
    }
    res.setHeader("content-type", "application/json"); res.end("{}");
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return Object.assign(state, { url: `http://127.0.0.1:${address.port}` });
}
async function fixture(flags = { lifecycleHooks: true, subagents: true }) {
  const targets = await Promise.all([runner(), runner()]);
  const registry = new RunnerRegistry({ runners: targets.map(target => target.url), internalRouterToken: token, runtimeExtensions: flags });
  const controls = { tombstone: false };
  registries.push(registry); await registry.refresh();
  const app = createRouterApp({ registry, internalRunnerToken: token,
    lifecycleHooksEnabled: () => flags.lifecycleHooks, subagentsEnabled: () => flags.subagents,
    tombstoneEnabled: () => controls.tombstone,
    logger: { info() {}, warn() {}, error() {} } });
  return { app, targets, registry, flags, controls };
}

// Real HTTP fleet probes, not a substitute for the separate root-lease/MySQL product vertical.
describe("lifecycle/root-lease router configured-fleet admission", () => {
  it("uses the independent tombstone gate and private child-delete ACK, never the subagent flag alone", async () => {
    const f = await fixture(), path = `/v1/sessions/${root}/subagents/sat_fixture/session`;
    for (const target of f.targets) target.lifecycle = ["tombstone"];
    await f.registry.refresh();
    expect((await f.app.request(path, { method: "DELETE" })).status).toBe(503);
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    f.controls.tombstone = true;
    const response = await f.app.request(path, { method: "DELETE", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: "forged-external-value" } });
    expect(response.status).toBe(204); expect(response.headers.get(INTERNAL_TOMBSTONE_ACK_HEADER)).toBeNull();
    expect(f.targets.flatMap(target => target.privateDeleteProof)).toEqual([true]);
    for (const target of f.targets) target.deleteAck = false;
    expect((await f.app.request(path, { method: "DELETE" })).status).toBe(503);
    // Missing ACK cannot retract a request the upstream already received; there is no automatic replay.
    expect(f.targets.flatMap(target => target.privateDeleteProof)).toEqual([true, true]);
  });
  it("refuses a legacy, unhealthy or mismatched configured member without sending a mutation", async () => {
    const f = await fixture(), second = f.targets[1]!;
    for (const variant of ["legacy", "down", "lifecycle", "subagents", "off", "valid"] as const) {
      second.aware = variant !== "legacy"; second.healthy = variant !== "down"; second.identity = { ...identity };
      if (variant === "lifecycle") second.identity.lifecycleHooksSha256 = "c".repeat(64);
      if (variant === "subagents") second.identity.subagentsSha256 = "c".repeat(64);
      if (variant === "off") second.identity.subagentsSha256 = null;
      const before = f.targets.map(target => target.probes), calls = f.targets.flatMap(target => target.calls).length;
      const response = await f.app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(variant === "valid" ? 200 : 503);
      expect(f.targets.map(target => target.probes)).toEqual(before.map(count => count + 1));
      expect(f.targets.flatMap(target => target.calls)).toHaveLength(calls + (variant === "valid" ? 1 : 0));
    }
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.runtimeExtensions).toEqual([RUNTIME_EXTENSIONS_V1]); expect(caps.features.runtimeExtensionsIdentity).toEqual(identity);
  });
  it("binds a private uncached acknowledgement to the exact token, nonce and entire configuration", async () => {
    const f = await fixture(), request = { nonce: "d".repeat(64), identity };
    const post = (body: unknown, auth = token) => f.app.request(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, {
      method: "POST", headers: { "content-type": "application/json", [INTERNAL_ROUTER_TOKEN_HEADER]: auth }, body: JSON.stringify(body),
    });
    expect((await post(request, "wrong-token")).status).toBe(404);
    expect((await post({ ...request, identity: { ...identity, subagentsSha256: null } })).status).toBe(503);
    const response = await post(request); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBe(INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE);
    expect(RuntimeExtensionsFleetResponse.parse(await response.json())).toEqual(request);
    expect((await post({ ...request, userId: "forged" })).status).toBe(503);
    expect((await f.app.request(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH)).status).toBe(404);
  });
  it("performs a new full probe for each turn or root-addressed task control, without treating legacy hooks as support", async () => {
    const f = await fixture(); f.targets[1]!.aware = false;
    for (const [path, method] of [[`/v1/sessions/${root}/turns`, "POST"], [`/v1/sessions/${root}/subagents`, "GET"],
      [`/v1/sessions/${root}/subagents/sat_fixture/interrupt`, "POST"]]) {
      const before = f.targets.map(target => target.probes);
      expect((await f.app.request(path!, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) })).status).toBe(503);
      expect(f.targets.map(target => target.probes)).toEqual(before.map(count => count + 1));
    }
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
  });
  it("keeps the root session id as the routing key rather than guessing a child owner", async () => {
    const f = await fixture(), seen: string[] = [];
    f.registry.owner = async id => { seen.push(id); return f.targets[1]!.url; };
    const path = `/v1/sessions/${root}/subagents/sat_fixture`;
    expect((await f.app.request(path)).status).toBe(200); expect(seen).toEqual([root]);
    expect(f.targets[0]!.calls).toEqual([]); expect(f.targets[1]!.calls).toEqual([path]);
  });
  it("does not project or authorize disabled features even when an upstream advertises them", async () => {
    const f = await fixture({ lifecycleHooks: false, subagents: false });
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.runtimeExtensions).toEqual([]); expect(caps.features.runtimeExtensionsIdentity).toBeNull();
    expect((await f.app.request(`/v1/sessions/${root}/subagents`)).status).toBe(503);
    expect((await f.app.request("/v1/agents", { method: "POST", body: JSON.stringify({ subagents: {} }), headers: { "content-type": "application/json" } })).status).toBe(503);
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    expect(f.targets.flatMap(target => target.privateNonces)).toEqual([]);
  });
  it.each(["missing", "wrong_nonce", "wrong_token", "down", "digest", "extra", "wrong_ack", "cacheable", "type", "oversize"] as const)(
    "revokes cached public capabilities when one configured private attestation is %s", async mode => {
      const f = await fixture(); expect(f.registry.allConfiguredSupportRuntimeExtensions()).toBe(true);
      f.targets[1]!.privateMode = mode;
      const response = await f.app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(503); expect(f.targets.flatMap(target => target.calls)).toEqual([]);
      expect(f.registry.list()[1]!.healthy).toBe(false); expect(f.registry.list()[1]!.capabilities).toBeUndefined();
      expect(f.registry.allConfiguredSupportRuntimeExtensions()).toBe(false);
    });
  it("uses a different authenticated nonce for each exact member and every admission boundary", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) expect((await f.app.request(`/v1/sessions/${root}/subagents/sat_fixture`)).status).toBe(200);
    expect(f.targets.map(target => target.privateNonces.length)).toEqual([3, 3]);
    const nonces = f.targets.flatMap(target => target.privateNonces);
    expect(new Set(nonces).size).toBe(6); expect(nonces.every(nonce => /^[a-f0-9]{64}$/.test(nonce))).toBe(true);
    expect(f.targets.flatMap(target => target.privateTokens)).toEqual(Array(6).fill(true));
  });
  it("waits for a cancelled private response body to really close during shutdown", async () => {
    const f = await fixture(), target = f.targets[1]!; target.privateMode = "hold";
    const abort = new AbortController(), refresh = f.registry.refreshRuntimeExtensions(abort.signal); refresh.catch(() => {});
    const until = performance.now() + 1000;
    while (!target.privateBodyStarted && performance.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    expect(target.privateBodyStarted).toBe(true);
    let closed = false; const closing = f.registry.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 0)); expect(closed).toBe(false);
    abort.abort();
    await Promise.allSettled([refresh]); await closing;
    // Server-side native close is observed, rather than dropping a still-running reader promise.
    const closeUntil = performance.now() + 1000;
    while (!target.privateBodyClosed && performance.now() < closeUntil) await new Promise(resolve => setTimeout(resolve, 5));
    expect(target.privateBodyClosed).toBe(true); expect(f.registry.allConfiguredSupportRuntimeExtensions()).toBe(false);
  });
});
