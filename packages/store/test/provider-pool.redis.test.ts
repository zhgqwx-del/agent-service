import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { Redis } from "ioredis";
import { guardRedisDatabaseSelection } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import { RedisProviderPoolCoordinator, type RedisProviderPoolOptions } from "../src/redis/provider-pool.js";
import { providerPoolSlotKey } from "../src/provider-pool-memory.js";
import { ProviderPoolError, type ProviderPoolInventory, type ProviderPoolLease, type ProviderPoolOutcome, type ProviderPoolPolicy } from "../src/provider-pool.js";

const inventory = (slots = ["a", "b"], version = "v1", providerId = "platform-provider"): ProviderPoolInventory => ({
  version: "provider-key-pool-v1", providerId, slots: slots.map(id => ({ id, version })),
});
const fail = () => new Error("Provider pool Redis fixture is not proven.");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5000; while (!await predicate()) { if (performance.now() >= end) throw fail(); await pause(10); }
}
function stateKey(pool: RedisProviderPoolCoordinator, source = inventory(["a"])) {
  return `provider-pool-v1:{${pool.namespaceSha256}}:state:${providerPoolSlotKey(source, source.slots[0]!)}`;
}
async function fixture(signal: AbortSignal, body: (f: { admin: Redis; url: URL; options: RedisProviderPoolOptions;
  pool: (patch?: Partial<RedisProviderPoolOptions>) => RedisProviderPoolCoordinator;
  lease: (pool: RedisProviderPoolCoordinator, source?: ProviderPoolInventory, policy?: ProviderPoolPolicy, consumerSignal?: AbortSignal) => Promise<ProviderPoolLease>;
}) => Promise<void>) {
  let url: URL;
  try {
    url = new URL(process.env.REDIS_TEST_URL ?? "");
    if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535 || url.search || url.hash
      || !/^\/(?:0|[1-9][0-9]*)$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))) throw fail();
  } catch { throw fail(); }
  const nonce = randomUUID(), options = { url: url.toString(), prefix: `pool-test-${nonce}`, namespaceId: `pool-${nonce}` };
  const pools = new Set<RedisProviderPoolCoordinator>(), leases = new Set<ProviderPoolLease>();
  const firstReleases = new Map<ProviderPoolLease, Promise<void>>();
  const admin = guardRedisDatabaseSelection(new Redis(options.url, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0,
    connectTimeout: 1000, commandTimeout: 1000, enableReadyCheck: false, disableClientInfo: true, protocol: 2 }));
  const sockets = new Map<Redis["stream"], Promise<void>>();
  const capture = () => { const socket = admin.stream; if (socket && !sockets.has(socket)) sockets.set(socket,
    socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()))); };
  admin.on("connect", capture); admin.on("error", capture); admin.on("close", capture);
  const abort = () => { for (const pool of pools) void pool.close().catch(() => {}); capture();
    try { admin.disconnect(false); } catch { /* Still join all observed native sockets. */ }
    finally { for (const socket of sockets.keys()) socket.destroy(); } };
  signal.addEventListener("abort", abort, { once: true });
  let passed = false, primary: unknown;
  try {
    signal.throwIfAborted(); await admin.connect(); capture(); signal.throwIfAborted();
    const info: unknown = await admin.client("INFO");
    if (typeof info !== "string" || Buffer.byteLength(info) > 16384 || info.match(/(?:^|\s)db=([0-9]+)(?=\s|$)/)?.[1] !== url.pathname.slice(1)) throw fail();
    signal.throwIfAborted();
    await body({ admin, url, options,
      pool: patch => { signal.throwIfAborted(); const pool = new RedisProviderPoolCoordinator({ ...options, ...patch }); pools.add(pool); return pool; },
      lease: async (pool, source = inventory(), policy = {}, consumerSignal = signal) => {
        const actual = await pool.acquire(await pool.select(source, policy, consumerSignal), consumerSignal);
        const lease: ProviderPoolLease = Object.freeze({ signal: actual.signal, assertOpen: () => actual.assertOpen(), release: (outcome: ProviderPoolOutcome) => {
          const work = actual.release(outcome); if (!firstReleases.has(lease)) firstReleases.set(lease, work); return work;
        } }); leases.add(lease); return lease;
      },
    }); signal.throwIfAborted(); passed = true;
  } catch (error) { primary = error; }
  finally {
    const released = await Promise.allSettled([...leases].map(lease => firstReleases.get(lease) ?? lease.release({ kind: "neutral" })));
    const closed = await Promise.allSettled([...pools].map(pool => pool.close()));
    if ([...released, ...closed].some(result => result.status === "rejected")) { passed = false; primary ??= fail(); }
    try {
      if (passed && !signal.aborted) for (const namespace of new Set([...pools].map(pool => pool.namespaceSha256))) {
        const prefix = `provider-pool-v1:{${namespace}}:`, keys = await admin.keys(prefix + "*");
        if (keys.some(key => !key.startsWith(prefix))) throw fail(); signal.throwIfAborted(); if (keys.length) await admin.del(...keys);
      }
    } catch (error) { primary ??= error; }
    try { await admin.quit(); } catch { primary ??= fail(); }
    finally { capture(); try { admin.disconnect(false); } catch { primary ??= fail(); }
      finally { for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]); signal.removeEventListener("abort", abort); } }
  }
  if (primary !== undefined) throw primary;
}

/** Closed RESP2 framing for a real TCP response-loss fixture; no downloaded/evaluated JS. */
function frame(bytes: Buffer, at = 0): { end: number; value: unknown } | undefined {
  const end = bytes.indexOf("\r\n", at); if (end < 0) return;
  const kind = bytes[at], word = bytes.subarray(at + 1, end).toString("utf8");
  if (kind === 43 || kind === 45 || kind === 58) return { end: end + 2, value: kind === 58 ? Number(word) : word };
  if (kind === 36) {
    const length = Number(word); if (!Number.isInteger(length) || length < -1 || length > 1_048_576) throw fail();
    if (length === -1) return { end: end + 2, value: null };
    if (bytes.length < end + 2 + length + 2) return;
    if (bytes.subarray(end + 2 + length, end + 4 + length).toString("ascii") !== "\r\n") throw fail();
    return { end: end + 4 + length, value: bytes.subarray(end + 2, end + 2 + length).toString("utf8") };
  }
  if (kind !== 42 || !/^[0-9]+$/.test(word) || Number(word) > 64) throw fail();
  let cursor = end + 2; const values: unknown[] = [];
  for (let n = 0; n < Number(word); n++) { const next = frame(bytes, cursor); if (!next) return; cursor = next.end; values.push(next.value); }
  return { end: cursor, value: values };
}
async function loseFirstAcquireResponse(target: URL, signal: AbortSignal) {
  const sockets = new Map<Socket, Promise<void>>(); let lost = 0, broken = false, firstEval: string[] | undefined, closing: Promise<void> | undefined;
  const watch = (socket: Socket) => sockets.set(socket, new Promise<void>(resolve => socket.once("close", () => resolve())));
  const server = createServer(front => {
    watch(front); if (signal.aborted || closing) { front.destroy(); return; }
    const back = createConnection({ host: target.hostname === "[::1]" ? "::1" : target.hostname, port: Number(target.port) }); watch(back);
    let incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0); const requests: string[][] = [];
    const stop = () => { front.destroy(); back.destroy(); };
    front.on("error", stop); back.on("error", stop); front.once("close", () => back.destroy()); back.once("close", () => front.destroy());
    front.on("data", bytes => {
      try {
        incoming = Buffer.concat([incoming, bytes]); if (incoming.length > 1_048_576) throw fail();
        while (incoming.length) { const next = frame(incoming); if (!next) break;
          if (!Array.isArray(next.value) || next.value.some(x => typeof x !== "string")) throw fail();
          requests.push(next.value as string[]); incoming = incoming.subarray(next.end); }
        back.write(bytes);
      } catch { broken = true; stop(); }
    });
    back.on("data", bytes => {
      try {
        outgoing = Buffer.concat([outgoing, bytes]); if (outgoing.length > 1_048_576) throw fail();
        while (outgoing.length) { const next = frame(outgoing); if (!next) break; const request = requests.shift(); if (!request) throw fail();
          const original = outgoing.subarray(0, next.end); outgoing = outgoing.subarray(next.end);
          if (!lost && request[0]?.toLowerCase() === "eval" && request[Number(request[2]) + 3] === "acquire" && Array.isArray(next.value) && next.value[0] === 1) {
            lost++; firstEval = request; stop(); return; // Redis actually applied acquire; only its RESP is lost.
          }
          front.write(original);
        }
      } catch { broken = true; stop(); }
    });
  });
  const cancel = () => { for (const socket of sockets.keys()) socket.destroy(); closing ??= new Promise<void>(resolve => server.close(() => resolve())); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    signal.throwIfAborted(); const address = server.address(); if (!address || typeof address === "string") throw fail();
    const url = new URL(target); url.hostname = "127.0.0.1"; url.port = String(address.port);
    return { url: url.toString(), lost: () => lost, broken: () => broken, command: () => firstEval,
      close: async () => { cancel(); await closing; await Promise.all([...sockets.values()]); signal.removeEventListener("abort", cancel); } };
  } catch { cancel(); await closing; await Promise.all([...sockets.values()]); signal.removeEventListener("abort", cancel); throw fail(); }
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("real Redis platform provider pool", () => {
  it("two independent runners share a bounded cursor without holding any permit", async context => {
    await fixture(context.signal, async f => {
      const a = f.pool(), b = f.pool(), source = inventory(); await a.assertReady();
      expect(await f.admin.keys(`provider-pool-v1:{${a.namespaceSha256}}:*`)).toEqual([]);
      const selected = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? a : b).select(source, {}, context.signal)));
      expect(selected.filter(value => value.slot.id === "a")).toHaveLength(6); expect(selected.filter(value => value.slot.id === "b")).toHaveLength(6);
      const keys = await f.admin.keys(`provider-pool-v1:{${a.namespaceSha256}}:*`); expect(keys).toHaveLength(1);
      expect(keys[0]).toContain(":cursor:"); expect(await f.admin.get(keys[0]!)).toBe("0"); expect(await f.admin.pttl(keys[0]!)).toBeGreaterThan(0);
      expect(new Set(keys.map(key => key.match(/\{([a-f0-9]{64})\}/)?.[1]))).toEqual(new Set([a.namespaceSha256]));
      await expect(a.acquire(selected[0]!, context.signal)).rejects.toBeInstanceOf(ProviderPoolError);
      await expect(b.acquire({ ...selected[0]! }, context.signal)).rejects.toBeInstanceOf(ProviderPoolError);
    });
  });
  it("atomically admits one half-open probe across runners and fences old closed completions", async context => {
    await fixture(context.signal, async f => {
      const a = f.pool(), b = f.pool(), source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      const old = await f.lease(a, source, policy); await (await f.lease(b, source, policy)).release({ kind: "failure" });
      await expect(a.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" }); await pause(120);
      const x = await a.select(source, policy, context.signal), y = await b.select(source, policy, context.signal);
      const result = await Promise.allSettled([a.acquire(x, context.signal), b.acquire(y, context.signal)]);
      try {
        expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
        expect(result.filter(value => value.status === "rejected").map(value => value.reason)).toEqual([expect.objectContaining({ reason: "open" })]);
        await old.release({ kind: "success" }); await expect(a.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" });
      }
      finally { await Promise.all(result.filter(value => value.status === "fulfilled").map(value => value.value.release({ kind: "success" }))); }
      await (await f.lease(a, source, policy)).release({ kind: "success" });
    });
  });
  it("a single cancelled or neutral probe never declares the key healthy", async context => {
    await fixture(context.signal, async f => { const pool = f.pool(), source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      await (await f.lease(pool, source, policy)).release({ kind: "failure" });
      for (const kind of ["cancelled", "neutral"] as const) { await pause(120); await (await f.lease(pool, source, policy)).release({ kind });
        await expect(pool.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" }); }
    });
  });
  it("tracks a rolling consecutive threshold and success reset, not a fixed bucket", async context => {
    await fixture(context.signal, async f => { const pool = f.pool(), source = inventory(["a"]), policy = { threshold: 2, windowMs: 100, cooldownMs: 100 };
      await (await f.lease(pool, source, policy)).release({ kind: "failure" }); await pause(120);
      await (await f.lease(pool, source, policy)).release({ kind: "failure" }); await (await f.lease(pool, source, policy)).release({ kind: "success" });
      await (await f.lease(pool, source, policy)).release({ kind: "failure" }); await (await f.lease(pool, source, policy)).release({ kind: "failure" });
      await expect(pool.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" });
    });
  });
  it("keeps only the exact provider-slot-version disabled, with a persistent operator tombstone", async context => {
    await fixture(context.signal, async f => { const a = f.pool(), b = f.pool(), source = inventory(["a"]);
      await (await f.lease(a, source)).release({ kind: "credential_rejected" });
      await expect(b.select(source, {}, context.signal)).rejects.toMatchObject({ reason: "disabled" }); expect(await f.admin.pttl(stateKey(a, source))).toBe(-1);
      expect((await b.select(inventory(), {}, context.signal)).slot.id).toBe("b");
      await (await f.lease(b, inventory(["a"], "v2"))).release({ kind: "success" });
      const unicode = "中".repeat(100) + " "; await (await f.lease(a, inventory(["a"], "v1", unicode))).release({ kind: "success" });
      for (const key of await f.admin.keys(`provider-pool-v1:{${a.namespaceSha256}}:*`)) { expect(key).not.toContain(unicode); expect(key).not.toContain("platform-provider"); }
    });
  });
  it("uses server TIME for absolute retry and clamps huge hints to an hour", async context => {
    await fixture(context.signal, async f => { const pool = f.pool(), source = inventory(["a"]), policy = { rateLimitCooldownMs: 100 };
      const time = await f.admin.time(), before = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      await (await f.lease(pool, source, policy)).release({ kind: "rate_limited", retryAtMs: 1 });
      const first = JSON.parse((await f.admin.get(stateKey(pool)))!) as unknown[];
      expect(Number(first[2])).toBeGreaterThanOrEqual(before + 100); await pause(120);
      await (await f.lease(pool, source, policy)).release({ kind: "rate_limited", retryDelayMs: Number.MAX_SAFE_INTEGER });
      const after = await f.admin.time(), upper = Number(after[0]) * 1000 + Math.floor(Number(after[1]) / 1000);
      const second = JSON.parse((await f.admin.get(stateKey(pool)))!) as unknown[];
      expect(Number(second[2])).toBeGreaterThanOrEqual(before + 3600000); expect(Number(second[2])).toBeLessThanOrEqual(upper + 3600000);
    });
  });
  it("valid concurrent 401/403 outcome disables the version even after another permit opened its breaker", async context => {
    await fixture(context.signal, async f => { const a = f.pool(), b = f.pool(), source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      const failure = await f.lease(a, source, policy), rejected = await f.lease(b, source, policy);
      await failure.release({ kind: "failure" }); await rejected.release({ kind: "credential_rejected" });
      await expect(a.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "disabled" });
      expect(await f.admin.pttl(stateKey(a, source))).toBe(-1); await (await f.lease(b, inventory(["a"], "v2"), policy)).release({ kind: "success" });
    });
  });
  it("renews a real half-open token past its initial deadline and releases only the same outcome", async context => {
    await fixture(context.signal, async f => { const pool = f.pool({ leaseMs: 1500, renewIntervalMs: 200, commandTimeoutMs: 500 });
      const source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 }; await (await f.lease(pool, source, policy)).release({ kind: "failure" });
      await pause(120); const probe = await f.lease(pool, source, policy); await pause(1800); await probe.assertOpen(); expect(probe.signal.aborted).toBe(false);
      await expect(pool.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" });
      await probe.release({ kind: "success" }); await probe.release({ kind: "success" });
      await expect(probe.release({ kind: "failure" })).rejects.toBeInstanceOf(ProviderPoolError);
      await (await f.lease(pool, source, policy)).release({ kind: "success" });
    });
  });
  it("close aborts real I/O consumers but cannot release the half-open token before them", async context => {
    await fixture(context.signal, async f => { const a = f.pool(), b = f.pool(), source = inventory(["a"]), policy = { threshold: 1, cooldownMs: 100 };
      await (await f.lease(a, source, policy)).release({ kind: "failure" }); await pause(120); const probe = await f.lease(a, source, policy);
      let closed = false; const closing = a.close().then(() => { closed = true; });
      try { expect(probe.signal.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
        await expect(b.select(source, policy, context.signal)).rejects.toMatchObject({ reason: "open" }); }
      finally { await probe.release({ kind: "cancelled" }); await closing; } expect(closed).toBe(true);
    });
  });
  it("unknown acquire response cancels its own token and cannot resurrect after its marker expires", async context => {
    await fixture(context.signal, async f => { const proxy = await loseFirstAcquireResponse(f.url, context.signal);
      try { const pool = f.pool({ url: proxy.url, leaseMs: 900, renewIntervalMs: 100, commandTimeoutMs: 300 });
        const selection = await pool.select(inventory(["a"]), {}, context.signal);
        await expect(pool.acquire(selection, context.signal)).rejects.toBeInstanceOf(ProviderPoolError); expect(proxy.lost()).toBe(1); expect(proxy.broken()).toBe(false);
        const permits = await f.admin.keys(`provider-pool-v1:{${pool.namespaceSha256}}:permit:*`); expect(permits).toHaveLength(1);
        expect((JSON.parse((await f.admin.get(permits[0]!))!) as unknown[])[0]).toBe(2); expect(await f.admin.pttl(permits[0]!)).toBeGreaterThan(0);
        await until(async () => await f.admin.exists(permits[0]!) === 0);
        const command = proxy.command(); if (!command || command[0]?.toLowerCase() !== "eval") throw fail();
        expect(await f.admin.call(command[0], ...command.slice(1))).toEqual([-1]);
        expect(await f.admin.exists(permits[0]!)).toBe(0);
        for (const key of await f.admin.keys(`provider-pool-v1:{${pool.namespaceSha256}}:*`)) expect(await f.admin.pttl(key)).toBeGreaterThan(0);
      } finally { await proxy.close(); }
    });
  });
  it("actual Redis loss aborts consumers, fails closed and settles its owned native connection", async context => {
    await fixture(context.signal, async f => { const pool = f.pool(), lease = await f.lease(pool);
      const port = Object.getOwnPropertyDescriptor(pool, "port")?.value as { redis: Redis } | undefined; if (!port || !(port.redis instanceof Redis)) throw fail();
      const socket = port.redis.stream; if (!socket) throw fail(); const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
      port.redis.disconnect(false); socket.destroy(); await until(() => lease.signal.aborted);
      await expect(pool.assertReady()).rejects.toMatchObject({ reason: "unavailable" }); await closed; expect(socket.closed).toBe(true);
      await expect(lease.assertOpen()).rejects.toMatchObject({ reason: "unavailable" }); await lease.release({ kind: "neutral" });
    });
  });
  it("wrong SELECT cannot fall back to DB0 or create any pool state", async context => {
    await fixture(context.signal, async f => { const configured = await f.admin.config("GET", "databases");
      if (!Array.isArray(configured) || configured.length !== 2 || !/^[1-9][0-9]*$/.test(String(configured[1]))) throw fail();
      const url = new URL(f.url); url.pathname = "/" + configured[1]; const pool = f.pool({ url: url.toString() });
      await expect(pool.assertReady()).rejects.toBeInstanceOf(ProviderPoolError);
      await expect(pool.select(inventory(), {}, context.signal)).rejects.toBeInstanceOf(ProviderPoolError);
      expect(await f.admin.keys(`provider-pool-v1:{${pool.namespaceSha256}}:*`)).toEqual([]);
    });
  });
});
