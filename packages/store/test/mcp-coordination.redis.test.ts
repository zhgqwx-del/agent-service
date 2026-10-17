import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { RedisMcpCoordination, mcpCoordinationNamespaceSha256, mcpCoordinationSubjectSha256, type McpCoordinationLease, type McpCoordinationInvalidation } from "../src/redis/mcp.js";

const configured = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
const subject = { tenantId: "mcp-coordination-tenant", userId: "user" };
async function until(check: () => boolean) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() >= deadline) throw new Error("MCP Redis fixture observation missing"); await new Promise<void>(r => setTimeout(r, 5)); } }
async function fixture(work: (f: { redis: Redis; first: RedisMcpCoordination; second: RedisMcpCoordination; prefix: string; namespaceId: string; keep: (lease: McpCoordinationLease) => McpCoordinationLease }) => Promise<void>, breakerCooldownMs = 100) {
  const url = new URL(configured); if (url.protocol !== "redis:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("MCP coordination fixture requires local Redis");
  const redis = new Redis(configured), prefix = `test-mcp-${randomUUID()}`, namespaceId = `fixture-${randomUUID()}`;
  const options = { redis, prefix, namespaceId, breakerFailureThreshold: 1, breakerCooldownMs, leaseMs: 1000 };
  const first = new RedisMcpCoordination(options), second = new RedisMcpCoordination(options), leases: McpCoordinationLease[] = [];
  let passed = false;
  try { await work({ redis, first, second, prefix, namespaceId, keep: lease => { leases.push(lease); return lease; } }); passed = true; }
  finally {
    const released = await Promise.allSettled(leases.map(lease => lease.release("success"))); const closed = await Promise.allSettled([first.close(), second.close()]);
    try {
      if (passed && released.every(r => r.status === "fulfilled") && closed.every(r => r.status === "fulfilled")) {
        let cursor = "0"; const keys = new Set<string>(); do { const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = page[0]; for (const key of page[1]) { if (!key.startsWith(`${prefix}:`)) throw new Error("MCP Redis cleanup ownership is invalid"); keys.add(key); } } while (cursor !== "0");
        if (keys.size) await redis.del(...keys);
      }
    } finally { await redis.quit(); }
    if (released.some(r => r.status !== "fulfilled") || closed.some(r => r.status !== "fulfilled")) throw new Error("MCP Redis fixture close is not proven");
  }
}
const admission = (user = subject) => ({ subject: user, operationId: randomUUID(), timeoutMs: 10000, maxConcurrent: 1 });
describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("MCP actual Redis cross-runner coordination", () => {
  it("shares actual-user quota across adapters without sharing another user's slot", async () => fixture(async f => {
    expect(f.first.namespaceSha256).toBe(mcpCoordinationNamespaceSha256({ prefix: f.prefix, namespaceId: f.namespaceId }));
    const first = f.keep(await f.first.enter(admission(), new AbortController().signal)); await first.assertOpen();
    await expect(f.second.enter(admission(), new AbortController().signal)).rejects.toThrow("MCP coordination is unavailable");
    const other = f.keep(await f.second.enter(admission({ ...subject, userId: "other" }), new AbortController().signal)); await other.assertOpen();
    await first.release("success"); const next = f.keep(await f.second.enter(admission(), new AbortController().signal)); await next.assertOpen();
  }));
  it("uses server-time breaker and does not release a cancelled operation until its owner settles", async () => fixture(async f => {
    const first = f.keep(await f.first.enter(admission(), new AbortController().signal)); await first.release("failure");
    await expect(f.second.enter(admission(), new AbortController().signal)).rejects.toThrow("MCP coordination is unavailable");
    await new Promise<void>(r => setTimeout(r, 140));
    const abort = new AbortController(), held = f.keep(await f.first.enter(admission(), abort.signal)); abort.abort();
    expect(held.signal.aborted).toBe(true); await expect(held.assertOpen()).rejects.toThrow("MCP coordination is unavailable");
    await expect(f.second.enter(admission(), new AbortController().signal)).rejects.toThrow("MCP coordination is unavailable");
    await held.release("success"); const next = f.keep(await f.second.enter(admission(), new AbortController().signal)); await next.assertOpen();
  }));
  it("propagates exact opaque invalidation and treats malformed messages as fence-all, never authority", async () => fixture(async f => {
    const ready = f.keep(await f.first.enter(admission(), new AbortController().signal)); await ready.release("success");
    const other = f.keep(await f.second.enter(admission(), new AbortController().signal)); await other.release("success");
    const messages: McpCoordinationInvalidation[] = [], off = f.second.onInvalidation(m => messages.push(m));
    try {
      await f.first.publishInvalidation({ registrationId: "a".repeat(64), subject });
      await until(() => messages.some(m => m.registrationId === "a".repeat(64)));
      expect(messages.find(m => m.registrationId === "a".repeat(64))?.subjectSha256).toBe(mcpCoordinationSubjectSha256(f.first.namespaceSha256, subject));
      await f.redis.publish(`${f.prefix}:mcp:invalidate:${f.first.namespaceSha256}`, "{}"); await until(() => messages.some(m => m.registrationId === null && m.subjectSha256 === null));
      await expect(f.second.enter(admission(), new AbortController().signal)).rejects.toThrow("MCP coordination is unavailable");
    } finally { off(); }
  }));
  it("close fences new entries and waits for actual leased work while retaining caller Redis ownership", async () => fixture(async f => {
    const held = f.keep(await f.first.enter(admission(), new AbortController().signal)); let closed = false;
    const closing = f.first.close().then(() => { closed = true; }); expect(held.signal.aborted).toBe(true);
    await new Promise<void>(r => setTimeout(r, 20)); expect(closed).toBe(false);
    await expect(f.first.enter(admission(), new AbortController().signal)).rejects.toThrow("MCP coordination is unavailable");
    await held.release("success"); await closing; expect(closed).toBe(true); expect(await f.redis.ping()).toBe("PONG");
  }));
});
