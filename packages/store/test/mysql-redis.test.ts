import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, RedisEventBus, RedisLeaseStore } from "../src/index.js";
import { eventBusConformance, leaseStoreConformance, sessionStoreConformance } from "./conformance.js";

const MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";

// Integration tests: require deploy/local/infra.sh start. Skipped when AGENT_SERVICE_INTEGRATION is unset.
if (process.env.AGENT_SERVICE_INTEGRATION) {
  sessionStoreConformance("mysql", async () => MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 5 }));
  leaseStoreConformance(
    "redis",
    async () => new RedisLeaseStore(REDIS_URL, "test"),
    async (_l, sid) => {
      const r = new Redis(REDIS_URL);
      await r.del(`test:lease:{${sid}}`);
      await r.quit();
    },
  );
  eventBusConformance("redis", async () => new RedisEventBus(REDIS_URL, { prefix: "test" }));

  describe("mysql migrations", () => {
    it("uses case-sensitive collations for every ownership and logical-id column", async () => {
      const store = await MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 2 });
      const conn = await mysql.createConnection(MYSQL_URL);
      try {
        const expected: Record<string, string[]> = {
          tenants: ["tenant_id", "auth_secret_key_id"],
          api_keys: ["key_hash", "key_id", "tenant_id"],
          agent_versions: ["tenant_id", "agent_id"],
          sessions: ["session_id", "tenant_id", "user_id", "agent_id", "parent_session_id", "context_epoch"],
          turns: ["turn_id", "session_id", "user_id", "idempotency_key"],
          items: ["item_id", "session_id", "user_id", "turn_id"],
          events: ["session_id", "user_id"],
          approvals: ["approval_id", "session_id", "user_id", "turn_id"],
          provider_configs: ["tenant_id", "provider_id", "secret_key_id"],
          idempotency_keys: ["tenant_id", "user_id", "session_id", "idem_key"],
          usage_ledger: ["tenant_id", "user_id", "session_id", "turn_id", "provider", "model"],
        };
        const [rows] = await conn.query<(RowDataPacket & { table_name: string; column_name: string; collation_name: string | null })[]>(
          `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name
             FROM information_schema.columns
            WHERE table_schema = DATABASE()`,
        );
        const byColumn = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r.collation_name]));
        for (const [table, columns] of Object.entries(expected)) {
          for (const column of columns) expect(byColumn.get(`${table}.${column}`)).toBe("utf8mb4_0900_as_cs");
        }
        const [pk] = await conn.query<(RowDataPacket & { column_name: string })[]>(
          `SELECT COLUMN_NAME AS column_name
             FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND index_name = 'PRIMARY'
            ORDER BY seq_in_index`,
        );
        expect(pk.map((r) => r.column_name)).toEqual(["tenant_id", "user_id", "session_id", "idem_key"]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("fails within the configured timeout when another runner owns the migration lock", async () => {
      const blocker = await mysql.createConnection(MYSQL_URL);
      try {
        const [rows] = await blocker.query<(RowDataPacket & { acquired: number })[]>(
          "SELECT GET_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)), 0) AS acquired",
        );
        expect(Number(rows[0]?.acquired)).toBe(1);
        await expect(MysqlSessionStore.connect({ url: MYSQL_URL, connectionLimit: 1, migrationLockTimeoutSeconds: 0 })).rejects.toThrow(
          "timed out after 0s waiting for the MySQL schema migration lock",
        );
      } finally {
        await blocker.query("SELECT RELEASE_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)))").catch(() => {});
        await blocker.end();
      }
    });
  });
} else {
  describe("mysql/redis integration", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with deploy/local/infra.sh running to enable", () => {});
  });
}
