import { afterEach, describe, expect, it, vi } from "vitest";
import { PiEngine, SessionHost, StaticToolRegistry } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import {
  Capabilities, RUNTIME_EXTENSIONS_V1, INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER,
  INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE, RuntimeExtensionsFleetResponse, type RuntimeExtensionsIdentity,
} from "@agent-service/protocol";
import { createApp } from "../src/app.js";

const token = "runtime-extension-source-http-private-token";
const identity: RuntimeExtensionsIdentity = { lifecycleHooksSha256: "a".repeat(64), subagentsSha256: "b".repeat(64) };
const request = { nonce: "c".repeat(64), identity };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture(local: RuntimeExtensionsIdentity | null = identity) {
  const store = new MemorySessionStore(), lease = new MemoryLeaseStore(), bus = new MemoryEventBus(), tools = new StaticToolRegistry([]);
  const cipher = new LocalAesGcmCipher("51".repeat(32)), providers = new ProviderService({ store, cipher, platform: [] });
  // The private receiver may not call this back into its router or start any Host operation.
  const recursiveAuthority = vi.fn(async () => { throw new Error("Unexpected authority recursion"); });
  const host = new SessionHost({ store, lease, bus, tools, providers, engine: new PiEngine(providers.models),
    authorizeRuntimeExtensions: recursiveAuthority, config: { runnerId: "private-http", runnerAddr: "127.0.0.1:1" },
    logger: { info() {}, warn() {}, error() {} } });
  const state = { ready: true };
  const app = createApp({ store, host, tools, providers, runnerId: "private-http", internalRouterToken: token,
    runtimeExtensionsIdentity: local ?? undefined, ready: () => state.ready, heartbeatMs: 60_000, maxBodyBytes: 400_000,
    encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }),
    decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId) });
  cleanups.push(async () => { await host.drain(0); await Promise.all([store.close(), bus.close(), lease.close()]); });
  const post = (value: unknown = request, auth = token, path: string = INTERNAL_RUNTIME_EXTENSIONS_READY_PATH) => app.request(path, {
    method: "POST", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: auth, "content-type": "application/json" }, body: JSON.stringify(value),
  });
  return { app, post, state, recursiveAuthority };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// This is the actual source App HTTP contract with real inert Memory/Host dependencies; no
// network/fleet attestation, SQL coordinator, or child producer is being simulated as executed.
describe("runner private runtime-extension nonce attestation", () => {
  it("separates code awareness from local enablement and does not recursively ask the router", async () => {
    const f = fixture(), disabled = fixture(null);
    const caps = Capabilities.parse(await (await disabled.app.request("/v1/capabilities")).json());
    expect(caps.features.runtimeExtensions).toEqual([RUNTIME_EXTENSIONS_V1]);
    expect((await disabled.post()).status).toBe(503); expect(disabled.recursiveAuthority).not.toHaveBeenCalled();
    expect((await fixture({ lifecycleHooksSha256: null, subagentsSha256: null }).post()).status).toBe(503);
    const response = await f.post(); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBe(INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE);
    expect(RuntimeExtensionsFleetResponse.parse(await response.json())).toEqual(request); expect(f.recursiveAuthority).not.toHaveBeenCalled();
  });
  it.each([
    { value: { ...request, extra: true } },
    { value: { ...request, identity: { ...identity, extra: true } } },
    { value: { ...request, nonce: "c".repeat(63) } },
    { value: { ...request, identity: { ...identity, subagentsSha256: "d".repeat(64) } } },
    { value: { ...request, identity: { ...identity, lifecycleHooksSha256: null } } },
    { value: { ...request, padding: "x".repeat(2048) } },
    { value: [] },
  ])("refuses a non-exact request without issuing an ACK %#", async ({ value }) => {
    const f = fixture(), response = await f.post(value); expect(response.status).toBe(503);
    expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBeNull(); expect(f.recursiveAuthority).not.toHaveBeenCalled();
  });
  it("authenticates before parsing and rejects wrong methods, queries, malformed bytes and not-ready state", async () => {
    const f = fixture();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await f.app.request(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, { method, headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token } });
      expect(response.status).toBe(404); expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBeNull();
    }
    const unauthorized = await f.app.request(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, { method: "POST", body: "not-json" });
    expect(unauthorized.status).toBe(404); expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect((await f.post(request, "wrong-token")).status).toBe(404);
    expect((await f.post(request, token, `${INTERNAL_RUNTIME_EXTENSIONS_READY_PATH}?extra=1`)).status).toBe(503);
    expect((await f.post(request, token, `${INTERNAL_RUNTIME_EXTENSIONS_READY_PATH}/extra`)).status).toBe(404);
    for (const body of ["not-json", new Uint8Array([0xff])]) {
      const response = await f.app.request(INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, { method: "POST", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" }, body });
      expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBeNull();
    }
    f.state.ready = false; expect((await f.post()).status).toBe(503); expect(f.recursiveAuthority).not.toHaveBeenCalled();
  });
  it("rechecks local readiness after actually reading the body", async () => {
    const f = fixture(), entered = deferred(), release = deferred();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify(request))); controller.close();
    } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" }, body: stream, duplex: "half" };
    const pending = f.app.request(new Request(`http://fixture${INTERNAL_RUNTIME_EXTENSIONS_READY_PATH}`, init));
    await entered.promise; f.state.ready = false; release.resolve();
    const response = await pending; expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBeNull();
  });
  it("awaits real request-reader cancellation instead of abandoning its pending task", async () => {
    const f = fixture(), entered = deferred(), cancelEntered = deferred(), release = deferred(), abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { entered.resolve(); }, async cancel() { cancelEntered.resolve(); await release.promise; } }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", signal: abort.signal,
      headers: { [INTERNAL_ROUTER_TOKEN_HEADER]: token, "content-type": "application/json" }, body: stream, duplex: "half" };
    let settled = false;
    const pending = Promise.resolve(f.app.request(new Request(`http://fixture${INTERNAL_RUNTIME_EXTENSIONS_READY_PATH}`, init))).then(value => { settled = true; return value; });
    try {
      await entered.promise; abort.abort(); await cancelEntered.promise; expect(settled).toBe(false);
    } finally { release.resolve(); }
    const response = await pending; expect(response.status).toBe(503); expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBeNull();
  });
});
