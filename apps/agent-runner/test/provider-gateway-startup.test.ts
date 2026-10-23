import { MemorySessionAuthority } from "../../../packages/store/src/memory-session-authority.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, RedisEventBus, RedisProviderPoolCoordinator, RedisProviderQuotaCoordinator, RedisSessionStatePurgeAdapter } from "@agent-service/store";
import { Capabilities } from "@agent-service/protocol";
import { startRunner } from "../src/main.js";
import { parseProviderKeyPools } from "../src/provider-key-pool.js";
import { deriveProviderGatewayPolicySha256 } from "../src/provider-gateway-config.js";

const listener = vi.hoisted(() => ({ calls: 0, allow: false }));
vi.mock("@hono/node-server", async () => {
  const actual = await vi.importActual<typeof import("@hono/node-server")>("@hono/node-server");
  return { ...actual, serve: (...args: Parameters<typeof actual.serve>) => {
    listener.calls++; if (!listener.allow) throw new Error("Unexpected startup listener."); return actual.serve(...args);
  } };
});
const fixed = () => new Error("Provider gateway startup fixture was not closed.");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
interface Scope {
  directory: string; successful: boolean; invalid: boolean; pending: Promise<unknown>[];
  clients: Set<Redis>; sockets: Map<Socket, Promise<void>>; detach: (() => void)[]; watch(client: Redis): void;
  runtime?: { close(): Promise<void> };
}
const scopes: Scope[] = [];

function redisTestUrl(): string {
  try {
    const raw = process.env.REDIS_TEST_URL;
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw) || raw.includes("?") || raw.includes("#")) throw fixed();
    const url = new URL(raw);
    if (!["redis:", "rediss:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535
      || !/^\/(?:0|[1-9][0-9]*)$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))) throw fixed();
    return raw;
  } catch { throw new Error("Provider gateway startup Redis fixture is invalid."); }
}

async function fixture(pool = false) {
  const url = redisTestUrl();
  const directory = await mkdtemp(join(tmpdir(), "agent-service-provider-startup-"));
  const scope: Scope = { directory, successful: false, invalid: false, pending: [], clients: new Set(), sockets: new Map(), detach: [],
    watch(client) {
      if (!client || typeof client.on !== "function" || typeof client.off !== "function") throw fixed();
      if (scope.clients.has(client)) return; scope.clients.add(client);
      const observe = () => {
        const stream: unknown = client.stream;
        if (stream === undefined) return;
        if (!(stream instanceof Socket)) { scope.invalid = true; return; }
        if (!scope.sockets.has(stream)) scope.sockets.set(stream, stream.closed ? Promise.resolve()
          : new Promise<void>(resolve => stream.once("close", () => resolve())));
      };
      for (const event of ["connect", "error", "close", "end"] as const) client.on(event, observe);
      scope.detach.push(() => { for (const event of ["connect", "error", "close", "end"] as const) client.off(event, observe); });
      observe();
    } };
  scopes.push(scope); listener.calls = 0; listener.allow = false;
  const nonce = randomBytes(8).toString("hex");
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", STORE: "memory", SECRETS_MASTER_KEY: "43".repeat(32),
    RUNNER_ID: `quota-startup-${nonce}`, RUNNER_ADDR: "127.0.0.1:1", RUNNER_PORT: "0",
    REDIS_URL: url, REDIS_PREFIX: `qstartup-${nonce}`, REDIS_NAMESPACE_ID: `qstartup-${nonce}`,
    PROVIDER_GATEWAY_ENABLED: "1", ERASURE_ROUTER_URL: "http://127.0.0.1:1",
    INTERNAL_ROUTER_TOKEN: "provider-startup-private-token-0001", BLOB_DIR: join(directory, "blobs"),
    BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_CLEANUP_ENABLED: "0", ERASURE_WORKER_ENABLED: "0",
    LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "0", PURGE_POLICY_EVALUATOR_ENABLED: "0",
    DATA_EXPORT_WORKER_ENABLED: "0", DATA_EXPORT_CLEANUP_ENABLED: "0", SESSION_DELETE_GRACE_RECOVERY_ENABLED: "0" };
  if (pool) {
    env.PLATFORM_PROVIDER_KEY_POOL_FILE = join(directory, "provider-pool.json");
    await writeFile(env.PLATFORM_PROVIDER_KEY_POOL_FILE, JSON.stringify({ version: "provider-key-pool-v1", providerId: "dashscope",
      slots: [{ id: "startup-slot", version: "v1", apiKey: "test-only-platform-key" }] }), { mode: 0o600 });
  }
  return { scope, env };
}

function closingSpies(scope: Scope, holdStore?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }, failQuotaClose = false,
  options: { pool?: boolean; failPoolClose?: boolean; normal?: boolean } = {}) {
  const memoryClose = MemorySessionStore.prototype.close, leaseClose = MemorySessionAuthority.prototype.close,
    busClose = RedisEventBus.prototype.close, purgeClose = RedisSessionStatePurgeAdapter.prototype.close,
    quotaClose = RedisProviderQuotaCoordinator.prototype.close, ready = RedisProviderQuotaCoordinator.prototype.assertReady,
    poolClose = RedisProviderPoolCoordinator.prototype.close, poolReady = RedisProviderPoolCoordinator.prototype.assertReady;
  const failure = new Error("fixed quota startup rejection");
  const store = vi.spyOn(MemorySessionStore.prototype, "close").mockImplementation(async function (this: MemorySessionStore) {
    if (holdStore) { holdStore.entered.resolve(); await holdStore.release.promise; }
    await memoryClose.call(this);
  });
  const lease = vi.spyOn(MemorySessionAuthority.prototype, "close").mockImplementation(async function (this: MemorySessionAuthority) {
    await leaseClose.call(this);
  });
  const busBarriers = new Set<Promise<void>>();
  const bus = vi.spyOn(RedisEventBus.prototype, "close").mockImplementation(function (this: RedisEventBus) {
    scope.watch(Reflect.get(this, "pub")); scope.watch(Reflect.get(this, "sub"));
    const barrier = busClose.call(this); busBarriers.add(barrier); return barrier;
  });
  const purge = vi.spyOn(RedisSessionStatePurgeAdapter.prototype, "close").mockImplementation(async function (this: RedisSessionStatePurgeAdapter) {
    scope.watch(Reflect.get(this, "redis")); await purgeClose.call(this);
  });
  const quota = vi.spyOn(RedisProviderQuotaCoordinator.prototype, "close").mockImplementation(async function (this: RedisProviderQuotaCoordinator) {
    scope.watch(Reflect.get(Reflect.get(this, "port"), "redis")); await quotaClose.call(this);
    if (failQuotaClose) throw new Error("fixed secondary quota cleanup rejection");
  });
  const readiness = vi.spyOn(RedisProviderQuotaCoordinator.prototype, "assertReady").mockImplementation(async function (this: RedisProviderQuotaCoordinator) {
    scope.watch(Reflect.get(Reflect.get(this, "port"), "redis")); await ready.call(this); if (!options.pool) throw failure;
  });
  const pool = options.pool ? vi.spyOn(RedisProviderPoolCoordinator.prototype, "close").mockImplementation(async function (this: RedisProviderPoolCoordinator) {
    scope.watch(Reflect.get(Reflect.get(this, "port"), "redis")); await poolClose.call(this);
    if (options.failPoolClose) throw new Error("fixed secondary pool cleanup rejection");
  }) : undefined;
  const poolReadiness = options.pool ? vi.spyOn(RedisProviderPoolCoordinator.prototype, "assertReady").mockImplementation(async function (this: RedisProviderPoolCoordinator) {
    scope.watch(Reflect.get(Reflect.get(this, "port"), "redis")); await poolReady.call(this); if (!options.normal) throw failure;
  }) : undefined;
  return { failure, store, lease, bus, busBarriers, normal: options.normal === true, purge, quota, readiness, pool, poolReadiness };
}

async function assertClosed(scope: Scope, spies: ReturnType<typeof closingSpies>) {
  for (const spy of [spies.store, spies.lease, spies.purge, spies.quota, spies.readiness]) expect(spy).toHaveBeenCalledTimes(1);
  // M4 normal shutdown stops the Redis hint transport before Host join, then closes the same owner.
  expect(spies.bus).toHaveBeenCalledTimes(spies.normal ? 2 : 1);
  expect(spies.busBarriers.size).toBe(1);
  const [barrier] = spies.busBarriers;
  for (const result of spies.bus.mock.results) {
    expect(result.type).toBe("return"); expect(result.value).toBe(barrier);
  }
  for (const spy of [spies.pool, spies.poolReadiness]) if (spy) expect(spy).toHaveBeenCalledTimes(1);
  expect(scope.clients.size).toBe(spies.pool ? 5 : 4); expect(scope.invalid).toBe(false);
  // Authority belongs to Memory here and allocates no Redis lease connection. Observe every
  // remaining actual native stream; ioredis synthetic status alone is not the oracle.
  expect(scope.sockets.size).toBe(spies.pool ? 5 : 4); await Promise.all(scope.sockets.values());
  expect([...scope.sockets.keys()].every(socket => socket.closed)).toBe(true);
  expect([...scope.clients].every(client => client.status === "end")).toBe(true);
}

afterEach(async () => {
  try {
    for (const scope of scopes.splice(0)) {
      await Promise.allSettled(scope.pending);
      await scope.runtime?.close();
      let forced = false;
      for (const client of scope.clients) {
        if (client.status !== "end") { forced = true; try { client.disconnect(false); } catch { scope.invalid = true; } }
      }
      for (const socket of scope.sockets.keys()) if (!socket.closed) { forced = true; try { socket.destroy(); } catch { scope.invalid = true; } }
      await Promise.all(scope.sockets.values());
      for (const detach of scope.detach) detach();
      if (scope.successful && !forced && !scope.invalid) await rm(scope.directory, { recursive: true, force: true });
      else if (scope.successful) throw fixed();
      // Failed assertions keep only this test's scratch; no Redis key, DB or foreign path is deleted.
    }
  } finally { listener.allow = false; vi.restoreAllMocks(); }
});

// Real Memory startup plus the caller's dedicated REDIS_TEST_URL. Redis only uses native
// PING/handshake/QUIT; the normal-close case also owns a real ephemeral loopback listener. No MySQL,
// model/fleet HTTP request or Redis business key is used.
describe.skipIf(process.env.AGENT_SERVICE_INTEGRATION !== "1")("provider gateway startup failure ownership", () => {
  it("joins Memory closure and every allocated native Redis stream before preserving the readiness error", async () => {
    const { scope, env } = await fixture(), entered = deferred(), release = deferred();
    const spies = closingSpies(scope, { entered, release }); let settled = false;
    const pending = startRunner(env).then(() => undefined, error => error).finally(() => { settled = true; }); scope.pending.push(pending);
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    expect(await pending).toBe(spies.failure); expect(listener.calls).toBe(0); await assertClosed(scope, spies); scope.successful = true;
  });

  it("does not let a secondary quota-close rejection skip other owners or replace the original startup error", async () => {
    const { scope, env } = await fixture(), spies = closingSpies(scope, undefined, true);
    const pending = startRunner(env).then(() => undefined, error => error); scope.pending.push(pending);
    expect(await pending).toBe(spies.failure); expect(listener.calls).toBe(0); await assertClosed(scope, spies); scope.successful = true;
  });

  it("joins every allocated owner when the real pool PING succeeds but startup rejects its readiness", async () => {
    const { scope, env } = await fixture(true), entered = deferred(), release = deferred();
    const spies = closingSpies(scope, { entered, release }, false, { pool: true }); let settled = false;
    const pending = startRunner(env).then(() => undefined, error => error).finally(() => { settled = true; }); scope.pending.push(pending);
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); }
    expect(await pending).toBe(spies.failure); expect(listener.calls).toBe(0); await assertClosed(scope, spies); scope.successful = true;
  });

  it("preserves pool startup failure while a secondary pool-close error cannot skip actual native closure", async () => {
    const { scope, env } = await fixture(true), spies = closingSpies(scope, undefined, false, { pool: true, failPoolClose: true });
    const pending = startRunner(env).then(() => undefined, error => error); scope.pending.push(pending);
    expect(await pending).toBe(spies.failure); expect(listener.calls).toBe(0); await assertClosed(scope, spies); scope.successful = true;
  });

  it("closes the normal runner listener and both actual gateway Redis transports without using a model", async context => {
    const { scope, env } = await fixture(true), spies = closingSpies(scope, undefined, false, { pool: true, normal: true });
    listener.allow = true;
    const onAbort = () => {
      if (!scope.runtime) return;
      const closing = scope.runtime.close(); scope.pending.push(closing);
      void closing.catch(() => { scope.invalid = true; });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    const pending = startRunner(env).then(async runtime => {
      scope.runtime = runtime;
      if (context.signal.aborted) await runtime.close();
      return runtime;
    }); scope.pending.push(pending);
    try {
      const runtime = await pending;
      try {
        context.signal.throwIfAborted();
        if (!runtime.server.listening) await once(runtime.server, "listening", { signal: context.signal });
        expect(listener.calls).toBe(1); expect(runtime.server.listening).toBe(true);
      } finally { await runtime.close(); }
      expect(runtime.server.listening).toBe(false); await assertClosed(scope, spies); scope.successful = true;
    } finally { context.signal.removeEventListener("abort", onAbort); }
  });

  it("rejects a metrics credential equal to a protected pool key before gateway transport readiness", async () => {
    const { scope, env } = await fixture(true), spies = closingSpies(scope, undefined, false, { pool: true, normal: true });
    const key = "test-only-distinct-provider-key-00000000001";
    await writeFile(env.PLATFORM_PROVIDER_KEY_POOL_FILE!, JSON.stringify({ version: "provider-key-pool-v1", providerId: "dashscope",
      slots: [{ id: "startup-slot", version: "v2", apiKey: key }] }), { mode: 0o600 });
    env.METRICS_BEARER_TOKEN = key;
    const pending = startRunner(env).then(() => { throw fixed(); }, error => error); scope.pending.push(pending);
    const failure: unknown = await pending;
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain(key);
    expect(String(failure)).not.toContain(env.PLATFORM_PROVIDER_KEY_POOL_FILE);
    expect(spies.readiness).not.toHaveBeenCalled(); expect(spies.poolReadiness).not.toHaveBeenCalled();
    expect(listener.calls).toBe(0); expect(scope.clients.size).toBe(0); scope.successful = true;
  });

  it("owns the real breaker Redis transport when BYOK alone is configured and readiness rejects", async () => {
    const { scope, env } = await fixture(); env.PROVIDER_BYOK_BREAKER_JSON = "{}";
    const spies = closingSpies(scope, undefined, false, { pool: true });
    const pending = startRunner(env).then(() => undefined, error => error); scope.pending.push(pending);
    expect(await pending).toBe(spies.failure); expect(listener.calls).toBe(0); await assertClosed(scope, spies); scope.successful = true;
  });

  it("closes a BYOK-only runner listener and its single shared breaker transport after actual startup", async context => {
    const { scope, env } = await fixture(); env.PROVIDER_BYOK_BREAKER_JSON = "{}";
    const spies = closingSpies(scope, undefined, false, { pool: true, normal: true }); listener.allow = true;
    const onAbort = () => {
      if (!scope.runtime) return;
      const closing = scope.runtime.close(); scope.pending.push(closing); void closing.catch(() => { scope.invalid = true; });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    const pending = startRunner(env).then(async runtime => {
      scope.runtime = runtime; if (context.signal.aborted) await runtime.close(); return runtime;
    }); scope.pending.push(pending);
    try {
      const runtime = await pending;
      try {
        context.signal.throwIfAborted(); if (!runtime.server.listening) await once(runtime.server, "listening", { signal: context.signal });
        expect(listener.calls).toBe(1); expect(runtime.server.listening).toBe(true);
      } finally { await runtime.close(); }
      expect(runtime.server.listening).toBe(false); await assertClosed(scope, spies); scope.successful = true;
    } finally { context.signal.removeEventListener("abort", onAbort); }
  });

  it("starts an explicitly mapped two-platform runner and exposes its v4 identity through real HTTP before native close", async context => {
    const { scope, env } = await fixture(true);
    const raw = JSON.stringify({ version: "provider-key-pools-v2", providers: ["dashscope", "deepseek"].map(providerId => ({
      version: "provider-key-pool-v1", providerId, slots: [{ id: "startup-slot", version: "v1", apiKey: `test-only-${providerId}-startup-key` }],
    })) });
    await writeFile(env.PLATFORM_PROVIDER_KEY_POOL_FILE!, raw, { mode: 0o600 });
    env.PLATFORM_PROVIDER_FALLBACK_JSON = JSON.stringify([{ provider: "dashscope", rules: [{ model: "qwen-plus",
      targets: [{ provider: "deepseek", model: "deepseek-chat" }] }] }]);
    const spies = closingSpies(scope, undefined, false, { pool: true, normal: true }); listener.allow = true;
    const onAbort = () => {
      if (!scope.runtime) return;
      const closing = scope.runtime.close(); scope.pending.push(closing); void closing.catch(() => { scope.invalid = true; });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    const pending = startRunner(env).then(async runtime => {
      scope.runtime = runtime; if (context.signal.aborted) await runtime.close(); return runtime;
    }); scope.pending.push(pending);
    try {
      const runtime = await pending;
      try {
        context.signal.throwIfAborted(); if (!runtime.server.listening) await once(runtime.server, "listening", { signal: context.signal });
        const address = runtime.server.address(); if (!address || typeof address === "string") throw fixed();
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`, { signal: context.signal });
        expect(response.status).toBe(200);
        const body = await response.text(), capabilities = Capabilities.parse(JSON.parse(body));
        expect(capabilities.features.providerGatewayIdentity?.policySha256)
          .toBe(deriveProviderGatewayPolicySha256(runtime.cfg.providerGateway, parseProviderKeyPools(raw).inventory));
        for (const secret of ["test-only-dashscope-startup-key", "test-only-deepseek-startup-key", env.PLATFORM_PROVIDER_KEY_POOL_FILE!]) {
          expect(body.includes(secret)).toBe(false);
        }
        expect(listener.calls).toBe(1); expect(runtime.server.listening).toBe(true);
      } finally { await runtime.close(); }
      expect(runtime.server.listening).toBe(false); await assertClosed(scope, spies); scope.successful = true;
    } finally { context.signal.removeEventListener("abort", onAbort); }
  });
});
