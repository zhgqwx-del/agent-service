import { randomBytes } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, createTenantWebhookAdminAccess } from "@agent-service/store";
import { runTenantHooksVertical } from "./fixtures/tenant-hooks-vertical.js";

function fixtureBases() {
  let sql: URL, redis: URL;
  try { sql = new URL(process.env.MYSQL_TEST_URL ?? ""); redis = new URL(process.env.REDIS_TEST_URL ?? ""); }
  catch { throw new Error("Managed tenant hooks requires explicit loopback MySQL/Redis fixture URLs"); }
  const local = (value: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname) && !value.search && !value.hash;
  if (!local(sql) || sql.protocol !== "mysql:" || !sql.username || !/(?:^|_)test(?:_|$)/i.test(sql.pathname.slice(1))
    || !/^[A-Za-z0-9_]+$/.test(sql.pathname.slice(1)) || !local(redis) || redis.protocol !== "redis:" || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) {
    throw new Error("Managed tenant hooks requires loopback test DBs with no URL options");
  }
  return { sql, redis };
}
function databaseUrl(base: URL, database: string) { const value = new URL(base); value.pathname = `/${database}`; return value.toString(); }
async function ownedKeys(redis: Redis, prefix: string) {
  const keys = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = page[0];
    for (const key of page[1]) { if (!key.startsWith(prefix + ":")) throw new Error("Redis fixture ownership mismatch"); keys.add(key); }
    if (++rounds > 100 || keys.size > 2000) throw new Error("Redis fixture namespace bound exceeded");
  } while (cursor !== "0");
  return [...keys];
}
const suite = process.env.AGENT_SERVICE_INTEGRATION ? describe : describe.skip;
suite("managed tenant observer real dual-runner/MySQL/Redis vertical", () => {
  it("commits pre/post evidence before signed HTTP, preserves unknown without redelivery and cold-replays exact durable calls", async () => {
    const base = fixtureBases(), suffix = randomBytes(12).toString("hex");
    const database = `agent_service_tenant_hooks_test_${suffix}`, prefix = database, mysqlUrl = databaseUrl(base.sql, database);
    const until = performance.now() + 60_000;
    const check = () => { if (performance.now() >= until) throw new Error("Managed tenant hooks wrapper deadline expired; evidence retained"); };
    let admin: Connection | undefined, redis: Redis | undefined, cold: MysqlSessionStore | undefined;
    let created = false, createAttempted = false, redisOwned = false, servicesClosed = false, coldUncertain = false, bodyPassed = false;
    let serverUuid = "", scratch: string | undefined, retainedScratch: string | undefined;
    const failures: string[] = [];
    try {
      admin = await mysql.createConnection({ uri: databaseUrl(base.sql, "mysql"), connectTimeout: 5000 }); check();
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5000 });
      serverUuid = String(identity[0]?.server_uuid); if (!/^[a-f0-9-]{36}$/i.test(serverUuid)) throw new Error("SQL fixture identity unavailable");
      const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", timeout: 5000 }, [database]);
      if (existing.length) throw new Error("SQL fixture database must be absent");
      redis = new Redis(base.redis.toString(), { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2000, commandTimeout: 2000, maxRetriesPerRequest: 1 });
      redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG");
      if ((await ownedKeys(redis, prefix)).length) throw new Error("Redis fixture namespace must be absent"); redisOwned = true;
      check(); createAttempted = true;
      await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5000 }); created = true;
      const result = await runTenantHooksVertical({ mysqlUrl, redisUrl: base.redis.toString(), redisPrefix: prefix,
        redisNamespaceId: `tenant_hooks_test_${suffix}`, onOwnedServicesClosed: () => { servicesClosed = true; },
        onRetainedScratch: directory => { retainedScratch = directory; } });
      scratch = result.scratchDirectory; check(); expect(servicesClosed).toBe(true);
      vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
      coldUncertain = true; cold = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2, migrationMode: "verify" }); coldUncertain = false; check();
      const session = await cold.getSession(result.owner.tenantId, result.sessionId);
      expect(session).toMatchObject({ userId: result.owner.userId, status: { type: "idle" }, lastSeq: result.finalSeq });
      expect(session?.autoApprovedTools).toEqual([result.approvalScope]);
      expect(await cold.getSession("tenant_cross_fixture", result.sessionId)).toBeNull();
      const items = await cold.listItems(result.sessionId, { limit: 100 });
      expect(items.filter(item => item.type === "toolCall").map(item => item.id)).toEqual(result.callItemIds);
      expect(items.filter(item => item.type === "toolResult")).toHaveLength(2);
      for (const turnId of result.turnIds) expect(await cold.getTurn(result.sessionId, turnId)).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
      const events = await cold.readEvents(result.sessionId, 0, 200);
      expect(events.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
      const hookEvents = events.filter(event => event.type === "tenant-hook/completed");
      expect(hookEvents.map(event => event.intentId)).toEqual(result.intentIds);
      expect(hookEvents.map(event => event.outcome)).toEqual(["acknowledged", "acknowledged", "acknowledged", "outcome_unknown"]);
      const access = createTenantWebhookAdminAccess({ tenantId: result.owner.tenantId, apiKeyId: "bootstrap" });
      const deliveryIds: string[] = [];
      for (const name of ["before", "after"]) {
        const registered = await cold.getTenantWebhook({ access, name }); expect(registered?.slot.state).toBe("enabled");
        expect(registered?.version?.signingKey).toMatchObject({ profile: "tenant-webhook-aes-256-gcm-v2", keyId: "fixture-master-v2" });
        expect(registered?.version?.disclosureSha256).toMatch(/^[a-f0-9]{64}$/);
        const page = await cold.listTenantWebhookDeliveries({ access, name, cursor: null, limit: 100 });
        expect(page.items).toHaveLength(2); deliveryIds.push(...page.items.map(intent => intent.intentId));
        for (const intent of page.items) {
          expect(intent.subject).toEqual(result.owner); expect(result.callItemIds).toContain(intent.callItemId);
          if (intent.payload === null) throw new Error("Expected sent fixture intent to retain its encrypted payload");
          expect(intent.payload.profile).toBe("tenant-webhook-aes-256-gcm-v2"); expect(intent.completedAtMs).toBeTypeOf("number");
        }
        if (name === "after") expect(page.items.filter(intent => intent.state === "outcome_unknown")).toHaveLength(1);
      }
      expect(deliveryIds.sort()).toEqual([...result.intentIds].sort());
      await expect(cold.assertTenantWebhookRuntimeGate(false)).rejects.toThrow(); await cold.assertTenantWebhookRuntimeGate(true);
      check(); bodyPassed = true;
    } catch { failures.push("validation_failed"); }
    finally {
      if (cold) { coldUncertain = true; try { await cold.close(); cold = undefined; coldUncertain = false; } catch { failures.push("cold_close_failed"); } }
      vi.unstubAllEnvs();
      if (redis) {
        try {
          if (bodyPassed && !failures.length && servicesClosed && !coldUncertain && redisOwned) {
            check(); const keys = await ownedKeys(redis, prefix);
            for (let index = 0; index < keys.length; index += 100) { check(); await redis.unlink(...keys.slice(index, index + 100)); }
            expect(await ownedKeys(redis, prefix)).toEqual([]);
          }
        } catch { failures.push("redis_cleanup_failed"); }
        try { await redis.quit(); } catch { redis.disconnect(); failures.push("redis_close_failed"); }
      }
      if (admin) {
        try {
          if (created) {
            check();
            if (!bodyPassed || failures.length || !servicesClosed || coldUncertain || cold || retainedScratch) throw new Error("retain");
            const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5000 });
            const [sessions] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5000 }, [database]);
            const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5000 }, [database]);
            const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5000 }, [database]);
            if (String(identity[0]?.server_uuid) !== serverUuid || sessions.length || transactions.length || locks.length
              || !/^agent_service_tenant_hooks_test_[a-f0-9]{24}$/.test(database) || !scratch) throw new Error("retain");
            if (!/^agent-service-tenant-hooks-vertical-[A-Za-z0-9]+$/.test(basename(scratch))) throw new Error("retain");
            const info = await lstat(scratch);
            if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dirname(scratch)) !== await realpath(tmpdir())) throw new Error("retain");
            check(); await rm(scratch, { recursive: true, force: true }); scratch = undefined;
            check(); await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5000 }); created = false;
          } else if (createAttempted) throw new Error("CREATE result uncertain");
        } catch { failures.push("owned_resources_retained"); }
        try { await admin.end(); } catch { failures.push("admin_close_failed"); }
      }
    }
    if (failures.length) throw new Error(`Managed tenant hooks vertical failed (${[...new Set(failures)].join(",")}); exact owned database=${database}; redisPrefix=${prefix}${retainedScratch || scratch ? `; scratch=${retainedScratch ?? scratch}` : ""}`);
  }, 60_000);
});
