import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0007.sql");
const MIGRATION_0008 = resolve(HERE, "../../migrations/0008_atomic_turn_writes.sql");

type Row = RowDataPacket;

function assertDisposableMigrationTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create migration fixture databases from base database "${database}": ` +
      "MYSQL_MIGRATION_TEST_URL must name a test/migration database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function hasIndex(conn: Connection, table: string, index: string): Promise<boolean> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COUNT(*) AS count
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index],
  );
  return Number(rows[0]?.count) > 0;
}

async function assertHistorical0007(conn: Connection): Promise<void> {
  const [migrations] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(migrations.map((row) => row.name)).toEqual([
    "0001_init.sql",
    "0002_auto_approved.sql",
    "0003_tenant_auth.sql",
    "0004_compaction.sql",
    "0005_api_key_scopes.sql",
    "0006_id_collation.sql",
    "0007_strict_ids_and_idempotency_scope.sql",
  ]);
  const [columns] = await conn.query<Row[]>(
    `SELECT COUNT(*) AS count
       FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'idempotency_keys' AND column_name = 'request_hash'`,
  );
  expect(Number(columns[0]?.count)).toBe(0);
  expect(await hasIndex(conn, "idempotency_keys", "idx_idempotency_expires")).toBe(false);
  expect(await hasIndex(conn, "usage_ledger", "uk_usage_session_turn_step")).toBe(false);
}

describe("real MySQL historical upgrade: 0007 -> 0008", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let only0008: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    only0008 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0008-"));
    await copyFile(MIGRATION_0008, join(only0008, "0008_atomic_turn_writes.sql"));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0008, { recursive: true, force: true });
  });

  async function withHistoricalDatabase(run: (url: string, conn: Connection) => Promise<void>): Promise<void> {
    // Never derive the DROP target from user input. It is generated here, validated, and scoped to
    // this process so parallel CI jobs cannot collide.
    const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) throw new Error("unsafe generated fixture database name");

    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      await assertHistorical0007(conn);
      await run(url, conn);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }

  async function expectUsageIdentityConflict(url: string): Promise<void> {
    let failure: unknown;
    try {
      const store = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0008 });
      await store.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/migration 0008_atomic_turn_writes\.sql failed/);
    // This proves a restart reached the final unique-index DDL again. A duplicate-column/index-name
    // error would mean the guards around the earlier, already auto-committed DDL are not re-entrant.
    const cause = (failure as Error & { cause?: { code?: string; sqlMessage?: string; message?: string } }).cause;
    expect(cause).toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(cause?.sqlMessage ?? cause?.message).toContain("uk_usage_session_turn_step");
  }

  it("merges identical usage duplicates and preserves an expired legacy pending receipt", async () => {
    await withHistoricalDatabase(async (url, conn) => {
      const usage = JSON.stringify({ inputTokens: 10, outputTokens: 4, totalTokens: 14, costCNY: 0.02 });
      await conn.query(
        `INSERT INTO usage_ledger
          (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES
          ('t1', 'u1', 'sess_same', 'turn_same', 1, 'dashscope', 'qwen-plus', ?, 1000),
          ('t1', 'u1', 'sess_same', 'turn_same', 1, 'dashscope', 'qwen-plus', ?, 1000)`,
        [usage, usage],
      );
      await conn.query(
        `INSERT INTO idempotency_keys
          (tenant_id, user_id, session_id, idem_key, value, expires_at_ms)
         VALUES ('t1', 'u1', 'sess_same', 'legacy-pending', NULL, 1)`,
      );

      const store = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0008 });
      await store.close();

      const [usageRows] = await conn.query<Row[]>(
        `SELECT id, CAST(usage_json AS CHAR) AS usage_json
           FROM usage_ledger
          WHERE session_id = 'sess_same' AND turn_id = 'turn_same' AND step = 1
          ORDER BY id`,
      );
      expect(usageRows).toHaveLength(1);
      expect(Number(usageRows[0]?.id)).toBe(1);
      expect(JSON.parse(String(usageRows[0]?.usage_json))).toEqual(JSON.parse(usage));

      const [pending] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms
           FROM idempotency_keys WHERE idem_key = 'legacy-pending'`,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        tenant_id: "t1",
        user_id: "u1",
        session_id: "sess_same",
        idem_key: "legacy-pending",
        request_hash: null,
        value: null,
        expires_at_ms: 1,
      });

      expect(await hasIndex(conn, "idempotency_keys", "idx_idempotency_expires")).toBe(true);
      expect(await hasIndex(conn, "usage_ledger", "uk_usage_session_turn_step")).toBe(true);
      const [applied] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '0008_atomic_turn_writes.sql'",
      );
      expect(Number(applied[0]?.count)).toBe(1);

      await expect(conn.query(
        `INSERT INTO usage_ledger
          (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES ('t1', 'u1', 'sess_same', 'turn_same', 1, 'dashscope', 'qwen-plus', ?, 1000)`,
        [usage],
      )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    });
  });

  it("blocks conflicting usage duplicates without deleting either accounting row", async () => {
    await withHistoricalDatabase(async (url, conn) => {
      const first = JSON.stringify({ inputTokens: 10, outputTokens: 4, totalTokens: 14, costCNY: 0.02 });
      const second = JSON.stringify({ inputTokens: 11, outputTokens: 4, totalTokens: 15, costCNY: 0.03 });
      await conn.query(
        `INSERT INTO usage_ledger
          (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES
          ('t1', 'u1', 'sess_conflict', 'turn_conflict', 2, 'dashscope', 'qwen-plus', ?, 2000),
          ('t1', 'u1', 'sess_conflict', 'turn_conflict', 2, 'dashscope', 'qwen-plus', ?, 2000),
          ('t1', 'u1', 'sess_attribution', 'turn_attribution', 3, 'dashscope', 'qwen-plus', ?, 3000),
          ('t2', 'u2', 'sess_attribution', 'turn_attribution', 3, 'dashscope', 'qwen-plus', ?, 3000)`,
        [first, second, first, first],
      );

      // MySQL DDL auto-commits: the first attempt may have installed request_hash/the expiry index.
      // A second attempt must still fail safely and leave both billable rows available for audit.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expectUsageIdentityConflict(url);
        const [rows] = await conn.query<Row[]>(
          `SELECT id, CAST(usage_json AS CHAR) AS usage_json
             FROM usage_ledger
            WHERE session_id = 'sess_conflict' AND turn_id = 'turn_conflict' AND step = 2
            ORDER BY id`,
        );
        expect(rows.map((row) => JSON.parse(String(row.usage_json)))).toEqual([
          JSON.parse(first),
          JSON.parse(second),
        ]);
        const [attributionRows] = await conn.query<Row[]>(
          `SELECT id, tenant_id, user_id, CAST(usage_json AS CHAR) AS usage_json
             FROM usage_ledger
            WHERE session_id = 'sess_attribution' AND turn_id = 'turn_attribution' AND step = 3
            ORDER BY id`,
        );
        expect(attributionRows.map((row) => ({
          tenantId: row.tenant_id,
          userId: row.user_id,
          usage: JSON.parse(String(row.usage_json)),
        }))).toEqual([
          { tenantId: "t1", userId: "u1", usage: JSON.parse(first) },
          { tenantId: "t2", userId: "u2", usage: JSON.parse(first) },
        ]);
        const [applied] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '0008_atomic_turn_writes.sql'",
        );
        expect(Number(applied[0]?.count)).toBe(0);
        const [requestHash] = await conn.query<Row[]>(
          `SELECT COUNT(*) AS count
             FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'idempotency_keys'
              AND column_name = 'request_hash'`,
        );
        expect(Number(requestHash[0]?.count)).toBe(1);
        expect(await hasIndex(conn, "idempotency_keys", "idx_idempotency_expires")).toBe(true);
        expect(await hasIndex(conn, "usage_ledger", "uk_usage_session_turn_step")).toBe(false);
      }

      // Model the documented operator path: audit the conflicting rows, remove only the two rejected
      // duplicates, then retry. The partially applied DDL must converge to a fully recorded migration.
      await conn.query(
        `DELETE FROM usage_ledger
          WHERE (session_id = 'sess_conflict' AND turn_id = 'turn_conflict' AND step = 2
                 AND JSON_EXTRACT(usage_json, '$.totalTokens') = 15)
             OR (session_id = 'sess_attribution' AND turn_id = 'turn_attribution' AND step = 3
                 AND tenant_id = 't2' AND user_id = 'u2')`,
      );
      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0008 });
      await recovered.close();
      expect(await hasIndex(conn, "usage_ledger", "uk_usage_session_turn_step")).toBe(true);
      const [recoveryState] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM schema_migrations WHERE name = '0008_atomic_turn_writes.sql') AS applied,
           (SELECT COUNT(*) FROM usage_ledger) AS usage_rows`,
      );
      expect(recoveryState[0]).toMatchObject({ applied: 1, usage_rows: 2 });
    });
  });
});
