import { randomBytes } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { Event, type Event as RuntimeEvent } from "@agent-service/protocol";
import { createMcpRegistryAccess, MysqlSessionStore, redisSessionKeys } from "@agent-service/store";
import { runMcpProgressVertical } from "./fixtures/mcp-progress-vertical.js";

const PROGRESS_TYPE = "item/mcpToolCall/progress";
function localBases() {
  const sqlRaw = process.env.MYSQL_TEST_URL, redisRaw = process.env.REDIS_TEST_URL;
  if (!sqlRaw || !redisRaw) throw new Error("MCP progress SQL profile requires explicit disposable MySQL and Redis URLs");
  let sql: URL, redis: URL;
  try { sql = new URL(sqlRaw); redis = new URL(redisRaw); } catch { throw new Error("MCP progress SQL fixture URLs invalid"); }
  const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
  const database = decodeURIComponent(sql.pathname.slice(1));
  if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
    || redis.protocol !== "redis:" || !local(redis) || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) {
    throw new Error("MCP progress fixtures require loopback MySQL test database and explicit Redis DB 0..15");
  }
  return { sql, redis };
}
function databaseUrl(base: URL, name: string) { const url = new URL(base); url.pathname = `/${name}`; return url.toString(); }
async function scopedKeys(redis: Redis, prefix: string): Promise<string[]> {
  const found = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = next;
    for (const key of keys) { if (!key.startsWith(`${prefix}:`)) throw new Error("MCP progress Redis ownership mismatch"); found.add(key); }
    if (++rounds > 100 || found.size > 2_000) throw new Error("MCP progress owned Redis namespace exceeded bound");
  } while (cursor !== "0");
  return [...found];
}
function persistedStreamEvents(rows: [string, string[]][]): RuntimeEvent[] {
  if (rows.length > 256) throw new Error("MCP progress owned Stream exceeded bound");
  return rows.map(([, fields]) => {
    const at = fields.indexOf("e");
    if (at < 0 || typeof fields[at + 1] !== "string" || Buffer.byteLength(fields[at + 1]!) > 131_072) throw new Error("MCP progress owned Stream shape invalid");
    return Event.parse(JSON.parse(fields[at + 1]!));
  });
}
function expectSameDurableEvents(hot: RuntimeEvent[], durable: RuntimeEvent[]) {
  expect(hot).toHaveLength(durable.length);
  const comparable = structuredClone(hot);
  const bits = (value: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    return view.getBigUint64(0, false);
  };
  for (let index = 0; index < comparable.length; index++) {
    const actual = comparable[index]!, expected = durable[index]!;
    if (actual.type !== "usage/updated" || expected.type !== "usage/updated") continue;
    for (const field of ["stepUsage", "turnUsage", "sessionUsage"] as const) {
      expect(Object.hasOwn(actual[field], "costCNY")).toBe(Object.hasOwn(expected[field], "costCNY"));
      if (!Object.hasOwn(actual[field], "costCNY")) continue;
      const a = actual[field].costCNY, b = expected[field].costCNY;
      if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
        throw new Error("MCP progress usage cost must remain a finite nonnegative number");
      }
      // MySQL JSON's binary64/decimal round trip may choose one adjacent double.
      // Only these cost leaves may differ by one ULP; all other fields still compare below.
      const aBits = bits(a), bBits = bits(b), distance = aBits > bBits ? aBits - bBits : bBits - aBits;
      expect(distance <= 1n).toBe(true);
      actual[field].costCNY = b;
    }
  }
  expect(comparable).toEqual(durable);
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("official 2025 stateful MCP progress through real two-main/MySQL/Redis/router/SDK", () => {
    it("receives live progress via Redis pubsub but never persists or cold-replays it", async context => {
      const bases = localBases(), suffix = randomBytes(12).toString("hex");
      const database = `agent_service_mcp_progress_test_${suffix}`, prefix = `mcp_progress_test_${suffix}`, namespace = `mcp_progress_${suffix}`;
      const sqlUrl = databaseUrl(bases.sql, database), deadline = performance.now() + 60_000;
      let expired = false;
      const timer = setTimeout(() => { expired = true; }, 60_000);
      const check = () => { if (expired || context.signal.aborted || performance.now() >= deadline) throw new Error("MCP progress SQL deadline expired; retain owned evidence"); };
      let admin: Connection | undefined, redis: Redis | undefined, subscriber: Redis | undefined, cold: MysqlSessionStore | undefined;
      let createAttempted = false, created = false, namespaceOwned = false, servicesClosed = false, coldUncertain = false, bodyPassed = false;
      let serverUuid = "", retainedScratch: string | undefined, scratch: string | undefined;
      let watchedChannel: string | undefined, watchedStream: string | undefined, subscriberFailure = false;
      const observed: RuntimeEvent[] = [], failures: unknown[] = [];
      const assertStream = async () => {
        check(); if (!redis || !watchedStream) throw new Error("MCP progress exact Stream unavailable");
        const events = persistedStreamEvents(await redis.xrange(watchedStream, "-", "+"));
        expect(events.length).toBeGreaterThan(0);
        expect(events.every(event => typeof event.seq === "number")).toBe(true);
        expect(events.some(event => event.type === PROGRESS_TYPE)).toBe(false);
        return events;
      };
      try {
        admin = await mysql.createConnection({ uri: databaseUrl(bases.sql, "mysql"), connectTimeout: 5_000 });
        const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
        serverUuid = String(identity[0]?.server_uuid);
        if (identity.length !== 1 || identity[0]?.db !== "mysql" || !/^[0-9a-f-]{36}$/i.test(serverUuid)) throw new Error("MCP progress SQL server identity unavailable");
        const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", timeout: 5_000 }, [database]);
        if (existing.length) throw new Error("MCP progress new owned database unexpectedly exists");
        const redisOptions = { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 };
        redis = new Redis(bases.redis.toString(), redisOptions); redis.on("error", () => {}); await redis.connect();
        expect(await redis.ping()).toBe("PONG");
        if ((await scopedKeys(redis, prefix)).length) throw new Error("MCP progress new owned Redis namespace unexpectedly exists");
        namespaceOwned = true;
        subscriber = new Redis(bases.redis.toString(), redisOptions); subscriber.on("error", () => { subscriberFailure = true; }); await subscriber.connect();
        subscriber.on("message", (channel, raw) => {
          if (channel !== watchedChannel || observed.length >= 256 || Buffer.byteLength(raw) > 131_072) { subscriberFailure = true; return; }
          try { observed.push(Event.parse(JSON.parse(raw))); } catch { subscriberFailure = true; }
        });
        check(); createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
        const result = await runMcpProgressVertical({ mysqlUrl: sqlUrl,
          managed: { redisUrl: bases.redis.toString(), redisPrefix: prefix, redisNamespaceId: namespace },
          onOwnedServicesClosed: () => { servicesClosed = true; }, onRetainedScratch: value => { retainedScratch = value; },
          beforeTurn: async ({ sessionId }) => {
            const keys = redisSessionKeys(sessionId, prefix); watchedChannel = keys.eventChannel; watchedStream = keys.stream;
            check(); await subscriber!.subscribe(watchedChannel);
          },
          afterProgress: async ({ sessionId, signal }) => {
            const until = Math.min(deadline, performance.now() + 5_000);
            while (!observed.some(event => event.type === PROGRESS_TYPE) && !signal.aborted && performance.now() < until) {
              check(); await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(subscriberFailure).toBe(false);
            const progress = observed.filter(event => event.type === PROGRESS_TYPE);
            expect(progress).toHaveLength(1); expect(progress[0]).toMatchObject({ sessionId, progress: 1, total: 2 });
            expect(progress[0]!.seq).toBeUndefined(); await assertStream();
          },
        });
        scratch = result.scratchDirectory; check(); expect(servicesClosed).toBe(true); expect(subscriberFailure).toBe(false);
        expect(observed.filter(event => event.type === PROGRESS_TYPE)).toHaveLength(1);
        const hot = await assertStream();
        expect(hot.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
        vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
        coldUncertain = true; cold = await MysqlSessionStore.connect({ url: sqlUrl, connectionLimit: 2, migrationMode: "verify" }); coldUncertain = false; check();
        expect(await cold.getSession(result.owner.tenantId, result.sessionId)).toMatchObject({ userId: result.owner.userId, lastSeq: result.finalSeq, status: { type: "idle" }, autoApprovedTools: [result.approvalScope] });
        expect(await cold.getSession("t_other_progress", result.sessionId)).toBeNull();
        expect(await cold.getApproval(result.sessionId, result.approvalId)).toMatchObject({ status: "resolved", decision: "acceptForSession", decidedBy: result.owner.userId });
        expect(await cold.getTurn(result.sessionId, result.turnId)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
        const items = await cold.listItems(result.sessionId, { limit: 100 });
        expect(items.filter(item => item.type === "toolCall")).toEqual([expect.objectContaining({ id: result.callItemId, kind: "mcp", name: result.toolName, status: "completed", startedAtMs: expect.any(Number) })]);
        expect(items.filter(item => item.type === "toolResult")).toEqual([expect.objectContaining({ name: result.toolName, isError: false, content: [{ type: "text", text: result.toolResult }] })]);
        const durable = await cold.readEvents(result.sessionId, 0, 100);
        expect(durable.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
        expect(durable.some(event => (event as { type: string }).type === PROGRESS_TYPE)).toBe(false);
        expectSameDurableEvents(hot, durable);
        // Exercise the narrow oracle against copies of this real run's events, not synthetic
        // event shapes: non-cost drift, two ULPs and missing known cost must still be rejected.
        const otherFieldDrift = structuredClone(hot);
        otherFieldDrift[0]!.emittedAtMs += 1;
        expect(() => expectSameDurableEvents(otherFieldDrift, durable)).toThrow();
        const usageIndex = durable.findIndex(event => event.type === "usage/updated" && Object.hasOwn(event.turnUsage, "costCNY"));
        expect(usageIndex).toBeGreaterThanOrEqual(0);
        const expectedUsage = durable[usageIndex]!;
        if (expectedUsage.type !== "usage/updated" || typeof expectedUsage.turnUsage.costCNY !== "number"
          || !Number.isFinite(expectedUsage.turnUsage.costCNY) || expectedUsage.turnUsage.costCNY < 0) {
          throw new Error("MCP progress SQL fixture requires a known finite usage cost");
        }
        const twoUlpDrift = structuredClone(hot), missingCost = structuredClone(hot);
        const changedUsage = twoUlpDrift[usageIndex]!, missingUsage = missingCost[usageIndex]!;
        if (changedUsage.type !== "usage/updated" || missingUsage.type !== "usage/updated") throw new Error("MCP progress usage event identity changed");
        const costBits = new DataView(new ArrayBuffer(8));
        costBits.setFloat64(0, expectedUsage.turnUsage.costCNY, false);
        costBits.setBigUint64(0, costBits.getBigUint64(0, false) + 2n, false);
        changedUsage.turnUsage.costCNY = costBits.getFloat64(0, false);
        expect(() => expectSameDurableEvents(twoUlpDrift, durable)).toThrow();
        delete missingUsage.turnUsage.costCNY;
        expect(() => expectSameDurableEvents(missingCost, durable)).toThrow();
        const owner = { scope: "user" as const, tenantId: result.owner.tenantId, userId: result.owner.userId };
        const access = createMcpRegistryAccess({ owner, principal: result.owner, authority: "user_self", access: "manage" });
        const registration = await cold.getMcpRegistration({ owner, name: "alpha", access });
        expect(registration?.slot).toMatchObject({ owner, state: "enabled", revision: 1, currentVersionId: result.managedRegistrationVersionId });
        expect(registration?.version?.config.protocolVersion).toBe("2025-11-25");
        expect(registration?.version?.config.authentication).toEqual({ kind: "none" });
        check(); bodyPassed = true;
      } catch (error) { failures.push(error); }
      finally {
        if (cold) { coldUncertain = true; try { await cold.close(); cold = undefined; coldUncertain = false; } catch (error) { failures.push(error); } }
        vi.unstubAllEnvs();
        if (subscriber) {
          try { if (watchedChannel) await subscriber.unsubscribe(watchedChannel); await subscriber.quit(); }
          catch (error) { subscriber.disconnect(); failures.push(error); }
        }
        if (admin && created && bodyPassed && failures.length === 0 && servicesClosed && !coldUncertain && !cold && !retainedScratch) {
          try {
            check(); const [same] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
            if (same.length !== 1 || String(same[0]?.server_uuid) !== serverUuid || same[0]?.db !== "mysql") throw new Error("MCP progress SQL server changed");
            const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5_000 }, [database]);
            const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5_000 }, [database]);
            const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5_000 }, [database]);
            if (connections.length || transactions.length || locks.length || !/^agent_service_mcp_progress_test_[0-9a-f]{24}$/.test(database)) throw new Error("MCP progress SQL owned schema remains referenced");
            if (!redis || !namespaceOwned || !scratch || !/^agent-service-mcp-progress-[A-Za-z0-9]+$/.test(basename(scratch))) throw new Error("MCP progress resource ownership not proven");
            const metadata = await lstat(scratch);
            if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(dirname(scratch)) !== await realpath(tmpdir())) throw new Error("MCP progress scratch ownership mismatch");
            check(); const keys = await scopedKeys(redis, prefix);
            for (let index = 0; index < keys.length; index += 100) await redis.unlink(...keys.slice(index, index + 100));
            if ((await scopedKeys(redis, prefix)).length) throw new Error("MCP progress owned Redis namespace was not cleared");
            await redis.quit(); redis = undefined;
            check(); await rm(scratch, { recursive: true, force: true }); scratch = undefined;
            check(); await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); created = false;
          } catch (error) { failures.push(error); }
        }
        if (redis) { try { await redis.quit(); } catch (error) { redis.disconnect(); failures.push(error); } }
        if (admin) { try { await admin.end(); } catch (error) { failures.push(error); } }
        clearTimeout(timer);
        if (created || createAttempted && !bodyPassed) failures.push(new Error(`MCP progress failed or uncertain validation retained owned scope: ${database}; ${prefix}`));
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "MCP progress real SQL/Redis vertical or owned cleanup failed");
    }, 60_000);
  });
} else {
  describe("official 2025 stateful MCP progress through real two-main/MySQL/Redis/router/SDK", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with explicit loopback MYSQL_TEST_URL and REDIS_TEST_URL", () => {});
  });
}
