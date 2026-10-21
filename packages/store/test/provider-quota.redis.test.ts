import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { Redis } from "ioredis";
import { guardRedisDatabaseSelection } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import { RedisProviderQuotaCoordinator, type RedisProviderQuotaOptions } from "../src/redis/provider-quota.js";
import { captureProviderQuotaRequest } from "../src/provider-quota-memory.js";
import { ProviderQuotaError, type ProviderQuotaLease, type ProviderQuotaRequest } from "../src/provider-quota.js";

const input = (patch: Partial<ProviderQuotaRequest> = {}): ProviderQuotaRequest => ({ tenantId: "tenant-a", userId: "user-a",
  provider: { scope: "platform", id: "provider-a" }, tenant: {}, user: {}, providerLimit: {}, ...patch });
const fail = () => new Error("Provider quota Redis fixture is not proven.");
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = performance.now() + 5_000;
  while (!await predicate()) { if (performance.now() >= end) throw fail(); await pause(10); }
}
function scopes(namespace: string, request: ProviderQuotaRequest): string[] {
  return captureProviderQuotaRequest(request).flatMap(layer => ["rpm", "concurrency"].map(kind => `provider-quota-v1:{${namespace}}:${layer.identitySha256}:${kind}`));
}
async function fixture(signal: AbortSignal, body: (f: {
  admin: Redis; url: URL; options: RedisProviderQuotaOptions;
  quota: (patch?: Partial<RedisProviderQuotaOptions>) => RedisProviderQuotaCoordinator;
  enter: (quota: RedisProviderQuotaCoordinator, request: ProviderQuotaRequest, signal?: AbortSignal) => Promise<ProviderQuotaLease>;
}) => Promise<void>) {
  let url: URL;
  try {
    url = new URL(process.env.REDIS_TEST_URL ?? "");
    if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535 || url.search || url.hash
      || !/^\/(?:0|[1-9][0-9]*)$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))) throw fail();
  } catch { throw fail(); }
  const nonce = randomUUID(), options = { url: url.toString(), prefix: `quota-test-${nonce}`, namespaceId: `quota-${nonce}` };
  const coordinators = new Set<RedisProviderQuotaCoordinator>(), leases = new Set<ProviderQuotaLease>();
  const admin = guardRedisDatabaseSelection(new Redis(options.url, { lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 0,
    connectTimeout: 1000, commandTimeout: 1000, enableReadyCheck: false, disableClientInfo: true, protocol: 2 }));
  const sockets = new Map<Redis["stream"], Promise<void>>();
  const capture = () => { const socket = admin.stream; if (socket && !sockets.has(socket)) sockets.set(socket,
    socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()))); };
  admin.on("connect", capture); admin.on("error", capture); admin.on("close", capture);
  const aborted = () => { for (const quota of coordinators) void quota.close().catch(() => {}); capture();
    try { admin.disconnect(false); } catch { /* The aborted fixture is already failed; still join its sockets. */ }
    finally { for (const socket of sockets.keys()) socket.destroy(); } };
  signal.addEventListener("abort", aborted, { once: true });
  let passed = false, primary: unknown;
  try {
    signal.throwIfAborted(); await admin.connect(); capture(); signal.throwIfAborted();
    const clientInfo: unknown = await admin.client("INFO");
    if (typeof clientInfo !== "string" || Buffer.byteLength(clientInfo) > 16_384
      || clientInfo.match(/(?:^|\s)db=([0-9]+)(?=\s|$)/)?.[1] !== url.pathname.slice(1)) throw fail();
    signal.throwIfAborted();
    await body({ admin, url, options,
      quota: patch => { signal.throwIfAborted(); const value = new RedisProviderQuotaCoordinator({ ...options, ...patch }); coordinators.add(value); return value; },
      enter: async (quota, request, consumerSignal = signal) => { const lease = await quota.enter(request, consumerSignal); leases.add(lease); return lease; },
    });
    signal.throwIfAborted(); passed = true;
  } catch (error) { primary = error; }
  finally {
    const released = await Promise.allSettled([...leases].map(lease => lease.release()));
    const closed = await Promise.allSettled([...coordinators].map(quota => quota.close()));
    if ([...released, ...closed].some(result => result.status === "rejected")) { passed = false; primary ??= fail(); }
    try {
      if (passed && !signal.aborted) {
        for (const namespace of new Set([...coordinators].map(quota => quota.namespaceSha256))) {
          const keys = await admin.keys(`provider-quota-v1:{${namespace}}:*`);
          if (keys.some(key => !key.startsWith(`provider-quota-v1:{${namespace}}:`))) throw fail();
          signal.throwIfAborted(); if (keys.length) await admin.del(...keys);
        }
      }
    } catch (error) { primary ??= error; }
    try { await admin.quit(); }
    catch { primary ??= fail(); }
    finally {
      capture(); try { admin.disconnect(false); } catch { primary ??= fail(); }
      finally { for (const socket of sockets.keys()) socket.destroy(); await Promise.all([...sockets.values()]); signal.removeEventListener("abort", aborted); }
    }
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
async function loseFirstEnterResponse(target: URL, signal: AbortSignal) {
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
          if (!lost && request[0]?.toLowerCase() === "eval" && Array.isArray(next.value) && next.value[0] === 1) {
            lost++; firstEval = request; stop(); return; // Redis actually applied enter; only its RESP is lost.
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

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("real Redis provider quota", () => {
  it("serializes two independent clients and counts every successful request exactly once", async context => {
    await fixture(context.signal, async f => {
      const a = f.quota(), b = f.quota(), request = input({ tenant: { concurrency: 1 } });
      const results = await Promise.allSettled([f.enter(a, request), f.enter(b, request)]);
      expect(results.filter(x => x.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(x => x.status === "rejected").map(x => x.reason)).toEqual([expect.objectContaining({ reason: "concurrency" })]);
      const keys = scopes(a.namespaceSha256, request);
      for (const key of keys.filter(x => x.endsWith(":rpm"))) expect(await f.admin.zcard(key)).toBe(1);
      for (const result of results) if (result.status === "fulfilled") await result.value.release();
    });
  });
  it("a user rejection consumes neither tenant nor provider RPM", async context => {
    await fixture(context.signal, async f => {
      const quota = f.quota(), request = input({ tenant: { rpm: 2 }, user: { rpm: 1 }, providerLimit: { rpm: 2 } });
      const a = await f.enter(quota, request); await a.release();
      await expect(quota.enter(request, context.signal)).rejects.toMatchObject({ reason: "rpm" });
      const b = await f.enter(quota, { ...request, userId: "user-b" }); await b.release();
      for (const key of scopes(quota.namespaceSha256, request).filter(x => x.endsWith(":rpm"))) {
        expect(await f.admin.zcard(key)).toBe(key === scopes(quota.namespaceSha256, request)[2] ? 1 : 2);
      }
    });
  });
  it("shares a platform provider across tenants and separates tenant-scoped providers and users", async context => {
    await fixture(context.signal, async f => {
      const tenantId = "中".repeat(100) + " ", providerId = "模".repeat(100) + " ";
      const a = f.quota(), b = f.quota(), request = input({ tenantId, provider: { scope: "platform", id: providerId }, providerLimit: { concurrency: 1 } });
      const first = await f.enter(a, request);
      await expect(b.enter({ ...request, tenantId: tenantId + "b" }, context.signal)).rejects.toMatchObject({ reason: "concurrency" });
      const localA = await f.enter(a, { ...request, provider: { scope: "tenant", id: providerId } });
      const localB = await f.enter(b, { ...request, tenantId: tenantId + "b", provider: { scope: "tenant", id: providerId } });
      expect(new Set(scopes(a.namespaceSha256, request).map(key => key.match(/\{([a-f0-9]{64})\}/)?.[1]))).toEqual(new Set([a.namespaceSha256]));
      for (const key of await f.admin.keys(`provider-quota-v1:{${a.namespaceSha256}}:*`)) {
        expect(key).not.toContain(tenantId); expect(key).not.toContain("user-a"); expect(key).not.toContain(providerId);
      }
      await first.release(); await localA.release(); await localB.release();
    });
  });
  it("uses native Redis TIME scores and prunes a rolling window rather than a fixed minute bucket", async context => {
    await fixture(context.signal, async f => {
      const quota = f.quota(), request = input({ tenant: { rpm: 1 } }), keys = scopes(quota.namespaceSha256, request);
      const time = await f.admin.time(), now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      for (const key of keys.filter(x => x.endsWith(":rpm"))) await f.admin.zadd(key, now - 60_001, "expired-fixture-member");
      const lease = await f.enter(quota, request); await lease.release();
      const after = await f.admin.time(), upper = Number(after[0]) * 1000 + Math.floor(Number(after[1]) / 1000);
      for (const key of keys.filter(x => x.endsWith(":rpm"))) {
        const rows = await f.admin.zrange(key, "0", "-1", "WITHSCORES"); expect(rows).toHaveLength(2);
        expect(Number(rows[1])).toBeGreaterThanOrEqual(now); expect(Number(rows[1])).toBeLessThanOrEqual(upper);
        await f.admin.zadd(key, upper - 59_000, rows[0]!);
      }
      await expect(quota.enter(request, context.signal)).rejects.toMatchObject({ reason: "rpm" });
    });
  });
  it("renews an actual held member past its first deadline, releases idempotently and never refunds RPM", async context => {
    await fixture(context.signal, async f => {
      const quota = f.quota({ leaseMs: 3000, renewIntervalMs: 500, commandTimeoutMs: 750 });
      const request = input({ tenant: { rpm: 2, concurrency: 1 } }), lease = await f.enter(quota, request);
      await pause(3400); await lease.assertOpen(); expect(lease.signal.aborted).toBe(false);
      await expect(quota.enter(request, context.signal)).rejects.toMatchObject({ reason: "concurrency" });
      await lease.release(); await lease.release();
      const next = await f.enter(quota, request); await next.release();
      await expect(quota.enter(request, context.signal)).rejects.toMatchObject({ reason: "rpm" });
    });
  });
  it("close aborts consumers but cannot delete their concurrency member before real release", async context => {
    await fixture(context.signal, async f => {
      const first = f.quota(), other = f.quota(), request = input({ tenant: { concurrency: 1 } });
      const lease = await f.enter(first, request); let closed = false;
      const closing = first.close().then(() => { closed = true; });
      try {
        expect(lease.signal.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
        await expect(other.enter(request, context.signal)).rejects.toMatchObject({ reason: "concurrency" });
      } finally { await lease.release(); await closing; }
      const next = await f.enter(other, request); await next.release();
    });
  });
  it("external abort holds a slot until release and an owned transport loss aborts all real lease signals", async context => {
    await fixture(context.signal, async f => {
      const quota = f.quota(), controller = new AbortController(), request = input({ tenant: { concurrency: 1 } });
      const lease = await f.enter(quota, request, controller.signal); controller.abort();
      expect(lease.signal.aborted).toBe(true);
      await expect(quota.enter(request, context.signal)).rejects.toMatchObject({ reason: "concurrency" });
      await lease.release();
      const live = await f.enter(quota, request);
      const port = Object.getOwnPropertyDescriptor(quota, "port")?.value as { redis: Redis } | undefined;
      if (!port || !(port.redis instanceof Redis)) throw fail();
      port.redis.disconnect(false); port.redis.stream?.destroy();
      await until(() => live.signal.aborted);
      await expect(live.assertOpen()).rejects.toMatchObject({ reason: "unavailable" });
      await expect(quota.assertReady()).rejects.toMatchObject({ reason: "unavailable" });
      await live.release(); // Fresh cleanup transport, not an in-process authority fallback.
    });
  });
  it("response loss cancels only its member, keeps RPM and cannot resurrect after bounded cancellation expires", async context => {
    await fixture(context.signal, async f => {
      const proxy = await loseFirstEnterResponse(f.url, context.signal);
      try {
        const quota = f.quota({ url: proxy.url, leaseMs: 1500, renewIntervalMs: 300, commandTimeoutMs: 500 }), request = input();
        await expect(quota.enter(request, context.signal)).rejects.toBeInstanceOf(ProviderQuotaError);
        expect(proxy.lost()).toBe(1); expect(proxy.broken()).toBe(false);
        for (const key of scopes(quota.namespaceSha256, request)) expect(await f.admin.zcard(key)).toBe(key.endsWith(":rpm") ? 1 : 0);
        const cancellations = await f.admin.keys(`provider-quota-v1:{${quota.namespaceSha256}}:cancel:*`);
        expect(cancellations).toHaveLength(1); expect(await f.admin.pttl(cancellations[0]!)).toBeGreaterThan(0);
        await until(async () => await f.admin.exists(cancellations[0]!) === 0);
        const command = proxy.command(); if (!command || command[0]?.toLowerCase() !== "eval") throw fail();
        expect(await f.admin.call(command[0], ...command.slice(1))).toEqual([-1]);
        for (const key of scopes(quota.namespaceSha256, request)) expect(await f.admin.zcard(key)).toBe(key.endsWith(":rpm") ? 1 : 0);
        const keys = await f.admin.keys(`provider-quota-v1:{${quota.namespaceSha256}}:*`);
        for (const key of keys) expect(await f.admin.pttl(key)).toBeGreaterThan(0);
      } finally { await proxy.close(); }
    });
  });
  it("readiness consumes no quota and an actual wrong SELECT permanently rejects admission", async context => {
    await fixture(context.signal, async f => {
      const quota = f.quota(); await quota.assertReady();
      expect(await f.admin.keys(`provider-quota-v1:{${quota.namespaceSha256}}:*`)).toEqual([]);
      const configured = await f.admin.config("GET", "databases");
      if (!Array.isArray(configured) || configured.length !== 2 || !/^[1-9][0-9]*$/.test(String(configured[1]))) throw fail();
      const invalid = new URL(f.url); invalid.pathname = "/" + configured[1];
      const bad = f.quota({ url: invalid.toString() });
      await expect(bad.assertReady()).rejects.toMatchObject({ reason: "unavailable" });
      await expect(bad.enter(input(), context.signal)).rejects.toMatchObject({ reason: "unavailable" });
      expect(await f.admin.keys(`provider-quota-v1:{${bad.namespaceSha256}}:*`)).toEqual([]);
    });
  });
});
