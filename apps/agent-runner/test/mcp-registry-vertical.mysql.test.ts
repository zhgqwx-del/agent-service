import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { MysqlSessionStore, createMcpRegistryAccess } from "@agent-service/store";
import { runMcpVertical } from "./fixtures/mcp-vertical.js";

function bases(): { mysql: URL; redis: URL } {
  const mysqlRaw = process.env.MYSQL_TEST_URL, redisRaw = process.env.REDIS_TEST_URL;
  if (!mysqlRaw || !redisRaw) throw new Error("Managed MCP vertical requires explicit MYSQL_TEST_URL and REDIS_TEST_URL");
  let sql: URL, redis: URL, database: string;
  try { sql = new URL(mysqlRaw); redis = new URL(redisRaw); database = decodeURIComponent(sql.pathname.slice(1)); }
  catch { throw new Error("Managed MCP fixture URLs are invalid"); }
  const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
  if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)test(?:$|_)/i.test(database)
    || redis.protocol !== "redis:" || !local(redis) || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) {
    throw new Error("Managed MCP fixture URLs must identify loopback MySQL test DB and explicit Redis DB 0..15 without URL options");
  }
  return { mysql: sql, redis };
}
function databaseUrl(base: URL, database: string): string { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
async function scopedKeys(redis: Redis, prefix: string): Promise<string[]> {
  const found = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const page = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = page[0];
    for (const key of page[1]) { if (!key.startsWith(`${prefix}:`)) throw new Error("Redis fixture ownership check failed"); found.add(key); }
    if (++rounds > 100 || found.size > 2_000) throw new Error("Redis fixture scan exceeded its exact namespace bound");
  } while (cursor !== "0");
  return [...found];
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("managed no-auth MCP real two-runner/MySQL/Redis vertical", () => {
    it("uses public user registration and fresh whole-fleet runtime, approval, durable second step and cold replay", async () => {
      const base = bases(), suffix = randomBytes(12).toString("hex");
      const database = `agent_service_mcp_registry_test_${suffix}`, prefix = `agent_service_mcp_registry_test_${suffix}`;
      const mysqlUrl = databaseUrl(base.mysql, database), namespaceId = `mcp_registry_test_${suffix}`;
      const deadline = performance.now() + 60_000;
      const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Managed MCP fixture deadline expired; retain owned evidence"); };
      let admin: Connection | undefined, redis: Redis | undefined, cold: MysqlSessionStore | undefined;
      let created = false, createAttempted = false, namespaceOwned = false, servicesClosed = false, coldUncertain = false, bodyPassed = false;
      let serverUuid: string | undefined, retainedScratch: string | undefined, managedScratch: string | undefined;
      const failures: unknown[] = [];
      try {
        admin = await mysql.createConnection({ uri: databaseUrl(base.mysql, "mysql"), connectTimeout: 5_000 });
        const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5_000 });
        serverUuid = String(identity[0]?.server_uuid); if (!/^[0-9a-f-]{36}$/i.test(serverUuid)) throw new Error("MySQL fixture identity unavailable");
        const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", timeout: 5_000 }, [database]);
        if (existing.length) throw new Error("Managed MCP fixture database unexpectedly exists; ownership rejected");
        redis = new Redis(base.redis.toString(), { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 });
        redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG");
        if ((await scopedKeys(redis, prefix)).length) throw new Error("Managed MCP fixture Redis namespace unexpectedly exists");
        namespaceOwned = true; checkDeadline(); createAttempted = true;
        await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
        const result = await runMcpVertical({ mysqlUrl, managed: { redisUrl: base.redis.toString(), redisPrefix: prefix, redisNamespaceId: namespaceId },
          approvalDecision: "acceptForSession", onOwnedServicesClosed: () => { servicesClosed = true; },
          onRetainedScratch: directory => { retainedScratch = directory; } });
        managedScratch = result.managedScratchDirectory;
        checkDeadline(); expect(servicesClosed).toBe(true);
        // Cold validation is DDL-free. The explicit local MCP fixture flag is still necessary to
        // decode its persisted loopback endpoint; it cannot authorize a production destination.
        vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
        coldUncertain = true; cold = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2, migrationMode: "verify" }); coldUncertain = false;
        checkDeadline();
        const session = await cold.getSession(result.owner.tenantId, result.sessionId);
        expect(session).toMatchObject({ userId: result.owner.userId, status: { type: "idle" }, lastSeq: result.finalSeq });
        expect(session?.autoApprovedTools).toEqual([result.approvalScope]); expect(session?.autoApprovedTools).not.toContain(result.toolName);
        expect(await cold.getSession("t_other_mcp_vertical", result.sessionId)).toBeNull();
        expect(await cold.getApproval(result.sessionId, result.approvalId)).toMatchObject({ status: "resolved", decision: "acceptForSession", toolName: result.toolName, decidedBy: result.owner.userId });
        expect(await cold.getTurn(result.sessionId, result.turnId)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
        const items = await cold.listItems(result.sessionId, { limit: 100 });
        expect(items.filter(item => item.type === "toolCall")).toEqual([expect.objectContaining({ kind: "mcp", name: result.toolName, status: "completed", startedAtMs: expect.any(Number) })]);
        expect(items.filter(item => item.type === "toolResult")).toEqual([expect.objectContaining({ name: result.toolName, isError: false, content: [{ type: "text", text: result.toolResult }] })]);
        const events = await cold.readEvents(result.sessionId, 0, 100);
        expect(events.map(event => event.seq)).toEqual(Array.from({ length: result.finalSeq }, (_, index) => index + 1));
        expect(events.some(event => event.type === "approval/resolved" && event.approval.id === result.approvalId && event.approval.decision === "acceptForSession")).toBe(true);
        expect(events.some(event => event.type === "item/completed" && event.item.type === "toolResult" && event.item.name === result.toolName && !event.item.isError)).toBe(true);
        expect(events.slice(-2)).toMatchObject([{ type: "turn/completed", turn: { id: result.turnId, status: "completed" } }, { type: "session/status/changed", status: { type: "idle" } }]);
        const owner = { scope: "user" as const, tenantId: result.owner.tenantId, userId: result.owner.userId };
        const access = createMcpRegistryAccess({ owner, principal: result.owner, authority: "user_self", access: "manage" });
        const registration = await cold.getMcpRegistration({ owner, name: "alpha", access });
        expect(registration?.slot).toMatchObject({ owner, state: "enabled", revision: 1, currentVersionId: result.managedRegistrationVersionId });
        expect(result.managedRegistrationVersionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(registration?.version?.configVersionId).toBe(result.managedRegistrationVersionId);
        expect(registration?.version?.config.authentication).toEqual({ kind: "none" });
        expect(registration?.version?.clientSecretCommitmentSha256).toBeNull();
        checkDeadline(); bodyPassed = true;
      } catch (error) { failures.push(error); }
      finally {
        if (cold) { coldUncertain = true; try { await cold.close(); cold = undefined; coldUncertain = false; } catch (error) { failures.push(error); } }
        vi.unstubAllEnvs();
        if (redis) {
          try {
            if (bodyPassed && failures.length === 0 && servicesClosed && !coldUncertain && namespaceOwned) {
              checkDeadline(); const keys = await scopedKeys(redis, prefix);
              for (let index = 0; index < keys.length; index += 100) await redis.unlink(...keys.slice(index, index + 100));
              if ((await scopedKeys(redis, prefix)).length) throw new Error("Managed MCP owned Redis namespace was not cleared");
            }
          } catch (error) { failures.push(error); }
          try { await redis.quit(); } catch (error) { redis.disconnect(); failures.push(error); }
        }
        if (admin) {
          try {
            if (created) {
              if (!bodyPassed || failures.length || !servicesClosed || coldUncertain || cold || retainedScratch) {
                throw new Error(`Managed MCP owned database/namespace retained for failed or uncertain validation: ${database}; ${prefix}${retainedScratch || managedScratch ? `; scratch=${retainedScratch ?? managedScratch}` : ""}`);
              }
              checkDeadline();
              const [same] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid", timeout: 5_000 });
              if (String(same[0]?.server_uuid) !== serverUuid) throw new Error("Managed MCP fixture database server identity changed");
              const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5_000 }, [database]);
              const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5_000 }, [database]);
              const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5_000 }, [database]);
              if (connections.length || transactions.length || locks.length || !/^agent_service_mcp_registry_test_[0-9a-f]{24}$/.test(database)) throw new Error("Managed MCP owned database remains referenced; retain evidence");
              if (!managedScratch || !/^agent-service-mcp-vertical-[A-Za-z0-9]+$/.test(basename(managedScratch))) throw new Error("Managed MCP scratch ownership is not proven");
              const scratchMetadata = await lstat(managedScratch);
              if (!scratchMetadata.isDirectory() || scratchMetadata.isSymbolicLink() || await realpath(dirname(managedScratch)) !== await realpath(tmpdir())) throw new Error("Managed MCP scratch path is not an exact owned local directory");
              checkDeadline(); await rm(managedScratch, { recursive: true, force: true }); managedScratch = undefined;
              checkDeadline(); await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); created = false;
            } else if (createAttempted) throw new Error(`Managed MCP CREATE outcome is uncertain; retain if present: ${database}`);
          } catch (error) { failures.push(error); }
          try { await admin.end(); } catch (error) { failures.push(error); }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Managed MCP MySQL/Redis vertical or owned-resource cleanup failed");
    }, 60_000);
  });
} else {
  describe("managed no-auth MCP real two-runner/MySQL/Redis vertical", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with loopback MYSQL_TEST_URL and REDIS_TEST_URL", () => {});
  });
}
