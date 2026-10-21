import { afterEach, describe, expect, it, vi } from "vitest";
import { PiEngine, SessionHost, StaticToolRegistry } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import {
  Capabilities, PROVIDER_GATEWAY_QUOTA_V1, ProviderGatewayFleetResponse, type ProviderGatewayIdentity,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_PROVIDER_GATEWAY_READY_PATH,
  INTERNAL_PROVIDER_GATEWAY_ACK_HEADER, INTERNAL_PROVIDER_GATEWAY_ACK_VALUE,
} from "@agent-service/protocol";
import { createApp } from "../src/app.js";
import { RouterProviderGatewayGate } from "../src/provider-gateway-gate.js";

const token = "provider-gateway-fixture-internal-token-0001";
const identity: ProviderGatewayIdentity = { namespaceSha256: "a".repeat(64), policySha256: "b".repeat(64) };
const request = { nonce: "c".repeat(64), identity };
const message = "Provider gateway fleet is unavailable.";
const options = { routerBaseUrl: "https://router.example", internalToken: token };
const headers = { "cache-control": "no-store", [INTERNAL_PROVIDER_GATEWAY_ACK_HEADER]: INTERNAL_PROVIDER_GATEWAY_ACK_VALUE };
const signal = () => new AbortController().signal;
function payload(init?: RequestInit): typeof request { return JSON.parse(String(init?.body)); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// Resource-free transport tests. Held promises/readers prove local ownership, not real Redis
// coordination, network cancellation or an actually executing provider request.
describe("provider quota router gate transport", () => {
  it("uses a fresh exact nonce, identity and private token on every manual-redirect request", async () => {
    const calls: RequestInit[] = [];
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async (url, init) => {
      expect(String(url)).toBe(options.routerBaseUrl + INTERNAL_PROVIDER_GATEWAY_READY_PATH);
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("manual");
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ "content-type": "application/json", [INTERNAL_ROUTER_TOKEN_HEADER]: token });
      expect(init?.signal).toBeInstanceOf(AbortSignal); calls.push(init!);
      return Response.json(payload(init), { headers });
    } });
    await gate.requireFreshFleet(identity, signal()); await gate.requireFreshFleet(identity, signal());
    expect(calls).toHaveLength(2);
    expect(payload(calls[0]).identity).toEqual(identity);
    expect(Object.keys(payload(calls[0])).sort()).toEqual(["identity", "nonce"]);
    expect(payload(calls[0]).nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(payload(calls[1]).nonce).not.toBe(payload(calls[0]).nonce);
  });

  it.each([
    { "cache-control": "max-age=60" }, { [INTERNAL_PROVIDER_GATEWAY_ACK_HEADER]: "legacy" },
    { "content-type": "text/plain" }, { "content-type": "application/json;charset=latin1" },
    { "content-length": "2049" }, { "content-length": "1e3" }, { "content-length": "-1" },
  ])("rejects receipt freshness, ACK or framing drift (%#)", async patch => {
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async (_url, init) => Response.json(payload(init), { headers: { ...headers, ...patch } }) });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });

  it("accepts the exact byte cap with explicit UTF8 JSON and an uncached private response", async () => {
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async (_url, init) => {
      const raw = JSON.stringify(payload(init));
      return new Response(raw + " ".repeat(2048 - Buffer.byteLength(raw)), { headers: {
        ...headers, "cache-control": "private, NO-STORE", "content-type": "Application/JSON; charset=utf-8", "content-length": "2048",
      } });
    } });
    await expect(gate.requireFreshFleet(identity, signal())).resolves.toBeUndefined();
  });

  it.each([201, 302, 401, 503])("does not accept or follow HTTP %s", async status => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("", { status, headers: { ...headers, location: "https://elsewhere.invalid" } }));
    await expect(new RouterProviderGatewayGate({ ...options, fetchImpl }).requireFreshFleet(identity, signal())).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["nonce", "namespace", "policy", "extra", "identity-extra"] as const)("rejects closed receipt identity drift: %s", async mode => {
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async (_url, init) => {
      const value = payload(init);
      return Response.json({ ...value, ...(mode === "nonce" ? { nonce: "d".repeat(64) } : {}),
        identity: { ...value.identity, ...(mode === "namespace" ? { namespaceSha256: "d".repeat(64) } : {}),
          ...(mode === "policy" ? { policySha256: "d".repeat(64) } : {}), ...(mode === "identity-extra" ? { extra: true } : {}) },
        ...(mode === "extra" ? { extra: true } : {}) }, { headers });
    } });
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });

  it("rejects a previously valid nonce replay on the next admission", async () => {
    let previous: typeof request | undefined;
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async (_url, init) => {
      previous ??= payload(init); return Response.json(previous, { headers });
    } });
    await gate.requireFreshFleet(identity, signal());
    await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
  });

  it("rejects invalid UTF8, oversized actual bytes and missing bodies", async () => {
    for (const body of [new Uint8Array([0xff]), new Uint8Array(2049).fill(32), null]) {
      const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async () => new Response(body, { headers: { ...headers, "content-type": "application/json" } }) });
      await expect(gate.requireFreshFleet(identity, signal())).rejects.toThrow(message);
    }
  });

  it("awaits cancellation even when invalid response headers avoid reading the body", async () => {
    const entered = deferred(), release = deferred(); let settled = false;
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async () => new Response(new ReadableStream({
      async cancel() { entered.resolve(); await release.promise; },
    }), { headers: { ...headers, "content-type": "text/plain" } }) });
    const pending = gate.requireFreshFleet(identity, signal()).then(() => "unexpected", error => (error as Error).message)
      .finally(() => { settled = true; });
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    expect(await pending).toBe(message);
  });

  it("joins an oversized reader's real cancel promise before rejecting", async () => {
    const entered = deferred(), release = deferred(); let settled = false;
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2049)); }, async cancel() { entered.resolve(); await release.promise; },
    }), { headers: { ...headers, "content-type": "application/json" } }) });
    const pending = gate.requireFreshFleet(identity, signal()).then(() => "unexpected", error => (error as Error).message)
      .finally(() => { settled = true; });
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    expect(await pending).toBe(message);
  });

  it("does not dispatch after caller abort or invalid expected identity, and hides the reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("private-gateway-canary"); });
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl }), abort = new AbortController();
    abort.abort(new Error("private-gateway-canary"));
    await expect(gate.requireFreshFleet(identity, abort.signal)).rejects.toThrow(message);
    for (const expected of [{ ...identity, policySha256: "invalid" }, { ...identity, policySha256: "b".repeat(64) + "\n" },
      { ...identity, namespaceSha256: "a".repeat(64) + "\n" }]) {
      await expect(gate.requireFreshFleet(expected, signal())).rejects.toThrow(message);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains a cancelled non-cooperative fetch and its late response until cancellation settles", async () => {
    let releaseFetch!: (response: Response) => void; const started = deferred(), cancelEntered = deferred(), releaseCancel = deferred();
    const late = new Promise<Response>(resolve => { releaseFetch = resolve; }), abort = new AbortController(); let settled = false;
    const gate = new RouterProviderGatewayGate({ ...options, fetchImpl: async () => { started.resolve(); return late; } });
    const pending = gate.requireFreshFleet(identity, abort.signal).then(() => "unexpected", error => (error as Error).message)
      .finally(() => { settled = true; });
    try {
      await started.promise; abort.abort(); await Promise.resolve(); expect(settled).toBe(false);
      releaseFetch(new Response(new ReadableStream({ async cancel() { cancelEntered.resolve(); await releaseCancel.promise; } }), { headers }));
      await cancelEntered.promise; expect(settled).toBe(false);
    } finally { releaseCancel.resolve(); }
    expect(await pending).toBe(message);
  });

  it("applies the same whole-operation deadline to a held body and awaits cancellation", async () => {
    const cancelEntered = deferred(), release = deferred(); let settled = false;
    const gate = new RouterProviderGatewayGate({ ...options, requestTimeoutMs: 100, fetchImpl: async () => new Response(new ReadableStream({
      async cancel() { cancelEntered.resolve(); await release.promise; },
    }), { headers: { ...headers, "content-type": "application/json" } }) });
    const pending = gate.requireFreshFleet(identity, signal()).then(() => "unexpected", error => (error as Error).message)
      .finally(() => { settled = true; });
    try { await cancelEntered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    expect(await pending).toBe(message);
  });

  it.each(["https://user:private@router.example", "https://router.example/path", "https://router.example?", "https://router.example#", "file:///tmp/router"])(
    "rejects an unsafe private origin (%#)", routerBaseUrl => { expect(() => new RouterProviderGatewayGate({ ...options, routerBaseUrl })).toThrow(message); });
  it.each([0, 99, 5001, NaN, Infinity])("rejects an invalid bounded RPC budget (%#)", requestTimeoutMs => {
    expect(() => new RouterProviderGatewayGate({ ...options, requestTimeoutMs })).toThrow(message);
  });
  it.each(["", "short", "x".repeat(257), "x".repeat(32) + "\n"])("rejects an unsafe internal token (%#)", internalToken => {
    expect(() => new RouterProviderGatewayGate({ ...options, internalToken })).toThrow(message);
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function runnerFixture(enabled = true) {
  const store = new MemorySessionStore(), lease = new MemoryLeaseStore(), bus = new MemoryEventBus(), tools = new StaticToolRegistry([]);
  const cipher = new LocalAesGcmCipher("51".repeat(32)), providers = new ProviderService({ store, cipher, platform: [] });
  const host = new SessionHost({ store, lease, bus, tools, providers, engine: new PiEngine(providers.models),
    config: { runnerId: "quota-http", runnerAddr: "127.0.0.1:1" }, logger: { info() {}, warn() {}, error() {} } });
  const state = { ready: true }, assertReady = vi.fn(async () => {});
  const app = createApp({ store, host, tools, providers, runnerId: "quota-http", internalRouterToken: token,
    ...(enabled ? { providerGateway: { identity, assertReady } } : {}), ready: () => state.ready,
    heartbeatMs: 60_000, maxBodyBytes: 400_000,
    encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }),
    decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId) });
  cleanups.push(async () => { await host.drain(0); await Promise.all([store.close(), bus.close(), lease.close()]); });
  const post = (value: unknown = request, auth = token, path: string = INTERNAL_PROVIDER_GATEWAY_READY_PATH) => app.request(path, {
    method: "POST", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: auth, "content-type": "application/json" }, body: JSON.stringify(value),
  });
  return { app, post, state, assertReady };
}

// Actual source Hono receiver with inert real Memory/Host dependencies, not a Redis/LLM proof.
describe("runner private provider gateway readiness", () => {
  it("advertises only enabled local coordination and returns an exact uncached nonce receipt", async () => {
    const f = runnerFixture(), disabled = runnerFixture(false);
    const caps = Capabilities.parse(await (await f.app.request("/v1/capabilities")).json());
    expect(caps.features.providerGateway).toEqual([PROVIDER_GATEWAY_QUOTA_V1]); expect(caps.features.providerGatewayIdentity).toEqual(identity);
    const off = Capabilities.parse(await (await disabled.app.request("/v1/capabilities")).json());
    expect(off.features.providerGateway).toEqual([]); expect(off.features.providerGatewayIdentity).toBeNull();
    expect((await disabled.post()).status).toBe(503); expect(disabled.assertReady).not.toHaveBeenCalled();
    const response = await f.post(); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBe(INTERNAL_PROVIDER_GATEWAY_ACK_VALUE);
    expect(ProviderGatewayFleetResponse.parse(await response.json())).toEqual(request); expect(f.assertReady).toHaveBeenCalledTimes(1);
  });

  it("authenticates before parsing and keeps wrong methods and subpaths hidden", async () => {
    const f = runnerFixture();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method, headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } });
      expect(response.status).toBe(404); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    }
    for (const auth of [undefined, "wrong-token"]) {
      const response = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", body: "private-gateway-canary:not-json",
        headers: auth === undefined ? {} : { [INTERNAL_ROUTER_TOKEN_HEADER]: auth } });
      expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("private-gateway-canary");
    }
    expect((await f.post(request, token, `${INTERNAL_PROVIDER_GATEWAY_READY_PATH}/extra`)).status).toBe(404);
    expect(f.assertReady).not.toHaveBeenCalled();
  });

  it("does not return an unauthenticated 404 until its unread body cancellation settles", async () => {
    const f = runnerFixture(), cancelEntered = deferred(), release = deferred(); let settled = false, reads = 0;
    const stream = new ReadableStream<Uint8Array>({ pull() { reads++; }, async cancel() { cancelEntered.resolve(); await release.promise; } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } };
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture${INTERNAL_PROVIDER_GATEWAY_READY_PATH}`, init)))
      .then(response => { settled = true; return response; });
    try { await cancelEntered.promise; expect(settled).toBe(false); expect(reads).toBe(0); } finally { release.resolve(); }
    const response = await pending; expect(response.status).toBe(404); expect(f.assertReady).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, nonce: "c".repeat(63) }, { ...request, nonce: "c".repeat(64) + "\n" },
    { ...request, extra: true }, { ...request, identity: { ...identity, extra: true } },
    { ...request, identity: { ...identity, namespaceSha256: "d".repeat(64) } },
    { ...request, identity: { ...identity, policySha256: "d".repeat(64) } }, { ...request, padding: "x".repeat(2048) }, [],
  ])("rejects non-exact bounded requests before consulting coordination (%#)", async value => {
    const f = runnerFixture(), response = await f.post(value);
    expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull(); expect(f.assertReady).not.toHaveBeenCalled();
  });

  it("rejects query/media/UTF8 drift and actual unannounced oversized bytes", async () => {
    const f = runnerFixture();
    expect((await f.post(request, token, `${INTERNAL_PROVIDER_GATEWAY_READY_PATH}?extra=1`)).status).toBe(503);
    for (const body of ["not-json", new Uint8Array([0xff]), new Uint8Array(2049).fill(32)]) {
      const response = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", headers: {
        [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json",
      }, body }); expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    }
    const wrongMedia = await f.app.request(INTERNAL_PROVIDER_GATEWAY_READY_PATH, { method: "POST", headers: {
      [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "text/plain",
    }, body: JSON.stringify(request) });
    expect(wrongMedia.status).toBe(503); expect(f.assertReady).not.toHaveBeenCalled();
  });

  it("rechecks readiness after the real coordinator promise settles and hides its error", async () => {
    const f = runnerFixture(), entered = deferred(), release = deferred();
    f.assertReady.mockImplementationOnce(async () => { entered.resolve(); await release.promise; });
    const pending = f.post(); await entered.promise; f.state.ready = false; release.resolve();
    const response = await pending; expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    f.state.ready = true; f.assertReady.mockRejectedValueOnce(new Error("private-gateway-canary"));
    const failed = await f.post(); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-gateway-canary");
  });

  it("joins cancelled request-reader work before returning an unavailable response", async () => {
    const f = runnerFixture(), entered = deferred(), cancelEntered = deferred(), release = deferred(), abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, async cancel() { cancelEntered.resolve(); await release.promise; } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", signal: abort.signal, body: stream, duplex: "half",
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" } };
    let settled = false;
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture${INTERNAL_PROVIDER_GATEWAY_READY_PATH}`, init)))
      .then(value => { settled = true; return value; });
    try { await entered.promise; abort.abort(); await cancelEntered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    const response = await pending; expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_PROVIDER_GATEWAY_ACK_HEADER)).toBeNull();
    expect(f.assertReady).not.toHaveBeenCalled();
  });
});
