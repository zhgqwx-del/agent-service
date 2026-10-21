import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  Capabilities, PROTOCOL_VERSION, PROVIDER_GATEWAY_QUOTA_V1, ProviderGatewayFleetRequest,
  ProviderGatewayFleetResponse, type ProviderGatewayIdentity, INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_PROVIDER_GATEWAY_READY_PATH, INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, INTERNAL_PROVIDER_GATEWAY_ACK_VALUE,
} from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

const token = "provider-gateway-fleet-private-token-0001";
const identity: ProviderGatewayIdentity = { namespaceSha256: "a".repeat(64), policySha256: "b".repeat(64) };
const root = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const servers: Server[] = [], registries: RunnerRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map(registry => registry.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  })));
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function runner() {
  const bodyStarted = deferred(), bodyClosed = deferred();
  const state = { aware: true, healthy: true, probes: 0, identity: { ...identity }, calls: [] as string[],
    beforeReady: undefined as undefined | (() => Promise<void>),
    privateMode: "valid" as "valid" | "missing" | "down" | "nonce" | "replay" | "namespace" | "policy" | "extra" | "ack" | "cacheable" | "type" | "oversize" | "utf8" | "redirect" | "hold",
    privateNonces: [] as string[], privateTokens: [] as boolean[], previousNonce: undefined as string | undefined,
    mutationReply: undefined as undefined | (() => Promise<{ status: number; owner?: string }>),
    bodyStarted, bodyClosed, closedBodies: 0 };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://fixture").pathname;
      if (path === "/readyz") {
        state.probes++;
        if (state.beforeReady) await state.beforeReady();
        res.writeHead(state.healthy ? 200 : 503).end(); return;
      }
      if (path === "/v1/capabilities") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
          streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, sessionLifecycle: [],
          dynamicTools: true, mcp: [], skills: false, hooks: false, sandbox: ["none"], byok: true,
          ...(state.aware ? { providerGateway: [PROVIDER_GATEWAY_QUOTA_V1], providerGatewayIdentity: state.identity } : {}),
        } })); return;
      }
      if (path === INTERNAL_PROVIDER_GATEWAY_READY_PATH) {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
        const request = ProviderGatewayFleetRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        state.privateNonces.push(request.nonce); state.privateTokens.push(req.headers[INTERNAL_ROUTER_TOKEN_HEADER] === token);
        if (req.method !== "POST" || req.headers[INTERNAL_ROUTER_TOKEN_HEADER] !== token || state.privateMode === "missing") { res.writeHead(404).end(); return; }
        if (state.privateMode === "down") { res.writeHead(503).end(); return; }
        if (state.privateMode === "redirect") { res.writeHead(302, { location: "/unexpected-private-redirect" }).end(); return; }
        res.setHeader("content-type", state.privateMode === "type" ? "text/plain" : "application/json");
        res.setHeader("cache-control", state.privateMode === "cacheable" ? "public,max-age=60" : "no-store");
        res.setHeader(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, state.privateMode === "ack" ? "wrong" : INTERNAL_PROVIDER_GATEWAY_ACK_VALUE);
        if (state.privateMode === "hold") {
          res.once("close", () => { state.closedBodies++; bodyClosed.resolve(); }); res.write('{"nonce":"'); bodyStarted.resolve(); return;
        }
        if (state.privateMode === "utf8") { res.end(Buffer.from([0xff])); return; }
        const nonce = state.privateMode === "replay" ? state.previousNonce : state.privateMode === "nonce" ? "f".repeat(64) : request.nonce;
        state.previousNonce ??= request.nonce;
        res.end(JSON.stringify({ nonce, identity: { ...state.identity,
          ...(state.privateMode === "namespace" ? { namespaceSha256: "f".repeat(64) } : {}),
          ...(state.privateMode === "policy" ? { policySha256: "f".repeat(64) } : {}) },
          ...(state.privateMode === "extra" ? { extra: true } : {}), ...(state.privateMode === "oversize" ? { padding: "x".repeat(2048) } : {}) })); return;
      }
      for await (const _chunk of req) { /* No prompt, API key or private control token is retained. */ }
      state.calls.push(`${req.method} ${path}`);
      const reply = state.mutationReply ? await state.mutationReply() : undefined;
      if (reply) { res.statusCode = reply.status; if (reply.owner !== undefined) res.setHeader("x-owner", reply.owner); }
      res.setHeader("content-type", "application/json"); res.end("{}");
    } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return Object.assign(state, { url: `http://127.0.0.1:${address.port}` });
}

async function fixture(settings: { enabled?: boolean; token?: boolean } = {}) {
  const flags = { enabled: settings.enabled ?? true, ready: true }, targets = await Promise.all([runner(), runner()]);
  const registry = new RunnerRegistry({ runners: targets.map(target => target.url),
    ...(settings.token === false ? {} : { internalRouterToken: token }), ...(flags.enabled ? { providerGatewayIdentity: identity } : {}) });
  registries.push(registry); await registry.refresh();
  const app = createRouterApp({ registry, ...(settings.token === false ? {} : { internalRunnerToken: token }),
    providerGatewayEnabled: () => flags.enabled, ready: () => flags.ready, logger: { info() {}, warn() {}, error() {} } });
  const post = (value: unknown = { nonce: "d".repeat(64), identity }, auth: string | undefined = token, path: string = INTERNAL_PROVIDER_GATEWAY_READY_PATH) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", ...(auth === undefined ? {} : { [INTERNAL_ROUTER_TOKEN_HEADER]: auth }) }, body: JSON.stringify(value),
  });
  return { targets, registry, app, flags, post };
}

// Actual Hono router and two native local HTTP peers. The peers intentionally simulate only
// readiness/capability/nonce contracts, not real Redis quota or provider billing execution.
describe("provider quota router configured-fleet admission", () => {
  it("requires every configured runner, not a healthy subset or a legacy capability", async ({ signal }) => {
    const f = await fixture(), second = f.targets[1]!;
    for (const variant of ["legacy", "down", "namespace", "policy", "valid"] as const) {
      second.aware = variant !== "legacy"; second.healthy = variant !== "down"; second.identity = { ...identity };
      if (variant === "namespace") second.identity.namespaceSha256 = "e".repeat(64);
      if (variant === "policy") second.identity.policySha256 = "e".repeat(64);
      const before = f.targets.map(target => target.probes), sent = f.targets.flatMap(target => target.calls).length;
      // Count both actual native arrivals before a fast negative response can cancel its sibling.
      // All readiness/capability/attestation outcomes and the product's sibling abort stay real.
      const ready = deferred(), arrivals = new Set<typeof second>(), releaseReady = () => ready.resolve();
      for (const target of f.targets) target.beforeReady = async () => {
        arrivals.add(target); if (arrivals.size === f.targets.length) releaseReady();
        await ready.promise;
      };
      signal.addEventListener("abort", releaseReady, { once: true });
      try {
        signal.throwIfAborted();
        const response = await f.app.request("/v1/sessions", { method: "POST", signal, headers: { "content-type": "application/json" }, body: "{}" });
        expect(response.status).toBe(variant === "valid" ? 200 : 503);
        expect(f.targets.map(target => target.probes)).toEqual(before.map(count => count + 1));
        expect(f.targets.flatMap(target => target.calls)).toHaveLength(sent + (variant === "valid" ? 1 : 0));
        if (variant !== "valid") {
          expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
          expect(f.registry.list().filter(target => target.healthy)).toHaveLength(1);
        }
      } finally {
        releaseReady();
        for (const target of f.targets) target.beforeReady = undefined;
        signal.removeEventListener("abort", releaseReady);
      }
    }
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.providerGateway).toEqual([PROVIDER_GATEWAY_QUOTA_V1]); expect(caps.features.providerGatewayIdentity).toEqual(identity);
  });

  it("performs a new full private probe for each session and provider mutation", async () => {
    const f = await fixture();
    for (const [path, method] of [["/v1/sessions", "POST"], [`/v1/sessions/${root}/turns`, "POST"],
      ["/v1/providers", "POST"], ["/v1/providers/platform-fixture", "PUT"], ["/v1/providers/platform-fixture", "DELETE"]] as const) {
      const before = f.targets.map(target => target.privateNonces.length);
      const response = await f.app.request(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(200);
      expect(f.targets.map(target => target.privateNonces.length)).toEqual(before.map(count => count + 1));
    }
    const nonces = f.targets.flatMap(target => target.privateNonces);
    expect(nonces).toHaveLength(12); expect(new Set(nonces).size).toBe(12);
    expect(f.targets.flatMap(target => target.privateTokens)).toEqual(Array(12).fill(true));
  });

  it("blocks public session and provider mutations when one exact private receiver is absent", async () => {
    const f = await fixture(); f.targets[1]!.privateMode = "missing";
    for (const [path, method] of [["/v1/sessions", "POST"], [`/v1/sessions/${root}/turns`, "POST"],
      ["/v1/providers", "POST"], ["/v1/providers/p1", "PUT"], ["/v1/providers/p1", "DELETE"]] as const) {
      const response = await f.app.request(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(503); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
  });

  it.each(["missing", "down", "nonce", "replay", "namespace", "policy", "extra", "ack", "cacheable", "type", "oversize", "utf8", "redirect"] as const)(
    "does not accept cached public claims when a configured private attestation is %s", async mode => {
      const f = await fixture(); expect(f.registry.allConfiguredSupportProviderGateway()).toBe(true);
      f.targets[1]!.privateMode = mode;
      expect((await f.app.request("/v1/providers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
      expect(f.registry.list()[1]!.healthy).toBe(false); expect(f.registry.list()[1]!.capabilities).toBeUndefined();
      expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false); expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    });

  it("fails closed without a private token even when both public capability documents claim support", async () => {
    const f = await fixture({ token: false });
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
    expect((await f.app.request("/v1/sessions", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await f.post()).status).toBe(404); expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    expect(f.targets.flatMap(target => target.privateNonces)).toEqual([]);
  });

  it("does not advertise or attest disabled coordination by borrowing an upstream claim", async () => {
    const f = await fixture({ enabled: false });
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.providerGateway).toEqual([]); expect(caps.features.providerGatewayIdentity).toBeNull();
    expect((await f.post()).status).toBe(503); expect(f.targets.flatMap(target => target.privateNonces)).toEqual([]);
    expect((await f.app.request("/v1/providers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  });

  it("authenticates before parsing, hides private paths and returns only exact uncached receipts", async () => {
    const f = await fixture(), value = { nonce: "d".repeat(64), identity };
    for (const auth of [undefined, "wrong-token"]) {
      const response = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", body: "private-gateway-canary:not-json",
        headers: auth === undefined ? {} : { [INTERNAL_ROUTER_TOKEN_HEADER]: auth } });
      expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text(); expect(text).not.toContain("private-gateway-canary"); expect(text).not.toContain(token);
      expect(text).not.toContain(identity.policySha256); expect(text).not.toContain(identity.namespaceSha256);
    }
    for (const method of ["GET", "PUT", "DELETE"]) expect((await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method })).status).toBe(404);
    expect((await f.post(value, token, `${INTERNAL_PROVIDER_GATEWAY_READY_PATH}/extra`)).status).toBe(404);
    const response = await f.post(value); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBe(INTERNAL_PROVIDER_GATEWAY_ACK_VALUE);
    expect(ProviderGatewayFleetResponse.parse(await response.json())).toEqual(value);
  });

  it("joins unread unauthorized body cancellation without probing the configured fleet", async () => {
    const f = await fixture(), before = f.targets.map(target => target.privateNonces.length), entered = deferred(), release = deferred();
    let settled = false, reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, async cancel() { entered.resolve(); await release.promise; } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } };
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture${INTERNAL_PROVIDER_GATEWAY_READY_PATH}`, init)))
      .then(response => { settled = true; return response; });
    try { await entered.promise; expect(settled).toBe(false); expect(reads).toBe(0); } finally { release.resolve(); }
    expect((await pending).status).toBe(404); expect(f.targets.map(target => target.privateNonces.length)).toEqual(before);
  });

  it("rejects bounded request, exact identity and media drift without returning an ACK", async () => {
    const f = await fixture();
    for (const value of [{ nonce: "d".repeat(63), identity }, { nonce: "d".repeat(64) + "\n", identity }, { nonce: "d".repeat(64), identity, extra: true },
      { nonce: "d".repeat(64), identity: { ...identity, namespaceSha256: "e".repeat(64) } },
      { nonce: "d".repeat(64), identity: { ...identity, policySha256: "e".repeat(64) } }]) {
      const response = await f.post(value); expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    }
    for (const body of ["not-json", new Uint8Array([0xff]), new Uint8Array(2049).fill(32)]) {
      const response = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", body,
        headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" } });
      expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    }
    expect((await f.post(undefined, token, `${INTERNAL_PROVIDER_GATEWAY_READY_PATH}?extra=1`)).status).toBe(503);
    expect((await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "text/plain",
    }, body: JSON.stringify({ nonce: "d".repeat(64), identity }) })).status).toBe(503);
  });

  it("rechecks the activation flag after owner resolution before sending a public mutation", async () => {
    const f = await fixture();
    f.registry.owner = async () => { f.flags.enabled = false; return f.targets[0]!.url; };
    expect((await f.app.request(`/v1/sessions/${root}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
  });

  it("retains an authenticated incoming body reader through cancellation and registry shutdown", async () => {
    const f = await fixture(), before = f.targets.map(target => target.privateNonces.length);
    const entered = deferred(), cancelEntered = deferred(), release = deferred(), abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, async cancel() { cancelEntered.resolve(); await release.promise; } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, duplex: "half", signal: abort.signal,
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" } };
    let settled = false, closed = false;
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture${INTERNAL_PROVIDER_GATEWAY_READY_PATH}`, init)))
      .then(response => { settled = true; return response; });
    await entered.promise; abort.abort(); await cancelEntered.promise;
    const closing = f.registry.close().then(() => { closed = true; });
    try { await Promise.resolve(); expect(settled).toBe(false); expect(closed).toBe(false); } finally { release.resolve(); }
    expect((await pending).status).toBe(503); await closing;
    expect(f.targets.map(target => target.privateNonces.length)).toEqual(before);
  });

  it("waits for actual configured-peer response close when an aborted probe is drained", async () => {
    const f = await fixture(), target = f.targets[1]!; target.privateMode = "hold";
    const abort = new AbortController(), refresh = f.registry.refreshProviderGateway(abort.signal);
    const observed = refresh.then(() => "completed", () => "aborted");
    await target.bodyStarted.promise;
    let closed = false; const closing = f.registry.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); abort.abort();
    expect(await observed).toBe("aborted"); await closing; await target.bodyClosed.promise;
    expect(target.closedBodies).toBe(1); expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
  });

  it("invalidates the request's proof when an actual later configured-peer downgrade completes during owner lookup", async context => {
    const f = await fixture(), ownerEntered = deferred(), ownerReleased = deferred();
    const abortOwner = () => { ownerEntered.resolve(); ownerReleased.resolve(); };
    context.signal.addEventListener("abort", abortOwner, { once: true });
    f.registry.owner = async () => {
      context.signal.throwIfAborted(); ownerEntered.resolve(); await ownerReleased.promise;
      context.signal.throwIfAborted(); return f.targets[0]!.url;
    };
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture/v1/sessions/${root}/turns`, {
      method: "POST", signal: context.signal, headers: { "content-type": "application/json" }, body: "{}",
    })));
    void pending.catch(() => {});
    try {
      await ownerEntered.promise;
      f.targets[1]!.aware = false;
      await expect(f.registry.refreshProviderGateway(context.signal)).rejects.toThrow();
      expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
      expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    } finally { ownerReleased.resolve(); try { await pending; } finally { context.signal.removeEventListener("abort", abortOwner); } }
    expect((await pending).status).toBe(503);
    expect(f.targets.flatMap(target => target.calls)).toEqual([]);
  });

  it("does not send a proof-gated mutation to an owner outside the exact configured fleet", async context => {
    const f = await fixture(), unconfigured = await runner();
    f.registry.owner = async () => unconfigured.url;
    const response = await f.app.request(new Request(`http://fixture/v1/sessions/${root}/turns`, {
      method: "POST", signal: context.signal, headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(503); expect(f.targets.flatMap(target => target.calls)).toEqual([]);
    expect(unconfigured.probes).toBe(0); expect(unconfigured.privateNonces).toEqual([]); expect(unconfigured.calls).toEqual([]);
  });

  it("preserves a real 409 without sending to its configured owner after that owner becomes unrouteable", async context => {
    const f = await fixture(), first = f.targets[0]!, next = f.targets[1]!;
    let denialObserved = false;
    f.registry.owner = async () => first.url;
    first.mutationReply = async () => {
      next.aware = false;
      try { f.registry.releaseProviderGatewayProof(await f.registry.refreshProviderGateway(context.signal)); }
      catch { denialObserved = true; }
      return { status: 409, owner: next.url };
    };
    const response = await f.app.request(new Request(`http://fixture/v1/sessions/${root}/turns`, {
      method: "POST", signal: context.signal, headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(409); expect(denialObserved).toBe(true);
    expect(first.calls).toEqual([`POST /v1/sessions/${root}/turns`]); expect(next.calls).toEqual([]);
    expect(f.registry.routeableUrl(next.url)).toBeUndefined();
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
  });

  it("rejects a 409 reroute to a still-routeable configured owner when a later peer denial invalidated the same proof", async context => {
    const f = await fixture(), first = f.targets[0]!, next = f.targets[1]!;
    let denialObserved = false;
    f.registry.owner = async () => first.url;
    first.mutationReply = async () => {
      first.aware = false;
      try { f.registry.releaseProviderGatewayProof(await f.registry.refreshProviderGateway(context.signal)); }
      catch { denialObserved = true; }
      return { status: 409, owner: next.url };
    };
    const response = await f.app.request(new Request(`http://fixture/v1/sessions/${root}/turns`, {
      method: "POST", signal: context.signal, headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(503); expect(denialObserved).toBe(true);
    expect(f.registry.routeableUrl(next.url)).toBe(next.url);
    expect(first.calls).toEqual([`POST /v1/sessions/${root}/turns`]); expect(next.calls).toEqual([]);
    expect(f.registry.allConfiguredSupportProviderGateway()).toBe(false);
  });

  it("does not follow an unconfigured 409 owner or turn that response into a new fleet proof", async context => {
    const f = await fixture(), first = f.targets[0]!, unconfigured = await runner();
    f.registry.owner = async () => first.url;
    first.mutationReply = async () => ({ status: 409, owner: unconfigured.url });
    const before = f.targets.map(target => target.privateNonces.length);
    const response = await f.app.request(new Request(`http://fixture/v1/sessions/${root}/turns`, {
      method: "POST", signal: context.signal, headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(409);
    expect(first.calls).toEqual([`POST /v1/sessions/${root}/turns`]); expect(f.targets[1]!.calls).toEqual([]);
    expect(f.targets.map(target => target.privateNonces.length)).toEqual(before.map(count => count + 1));
    expect(unconfigured.probes).toBe(0); expect(unconfigured.privateNonces).toEqual([]); expect(unconfigured.calls).toEqual([]);
  });
});
