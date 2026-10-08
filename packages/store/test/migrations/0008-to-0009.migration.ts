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
const MIGRATION_0009 = resolve(HERE, "../../migrations/0009_session_tombstone_outbox.sql");

type Row = RowDataPacket;

function assertDisposableMigrationTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create migration fixture databases from base database "${database}": `
      + "MYSQL_MIGRATION_TEST_URL must name a test/migration database",
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
      WHERE table_schema = DATABASE() AND table_name=? AND index_name=?`,
    [table, index],
  );
  return Number(rows[0]?.count) > 0;
}

async function indexColumns(conn: Connection, table: string, index: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name=? AND index_name=?
      ORDER BY seq_in_index`,
    [table, index],
  );
  return rows.map((row) => String(row.column_name));
}

describe("real MySQL historical upgrade: 0008 -> 0009", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("expands historical lifecycle rows without scheduling purge and is restart-safe", async () => {
    const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) throw new Error("unsafe generated fixture database name");
    const only0008 = await mkdtemp(join(tmpdir(), "agent-service-migration-0008-"));
    const only0009 = await mkdtemp(join(tmpdir(), "agent-service-migration-0009-"));
    await copyFile(MIGRATION_0008, join(only0008, "0008_atomic_turn_writes.sql"));
    await copyFile(MIGRATION_0009, join(only0009, "0009_session_tombstone_outbox.sql"));

    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);

      // Materialize a genuine 0008 database using the production migration runner, then freeze
      // representative pre-0009 rows before allowing 0009 to run.
      const at0008 = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0008 });
      await at0008.close();
      await conn.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms)
         VALUES
          ('sess_parent',  'tenant', 'user', 'agent', 1, '{"type":"idle"}', NULL,
           1, 0, 'epoch', '{}', '{}', 1, 1, NULL, NULL),
          ('sess_child',   'tenant', 'user', 'agent', 1, '{"type":"idle"}', 'sess_parent',
           1, 0, 'epoch', '{}', '{}', 2, 2, NULL, NULL),
          ('sess_deleted', 'tenant', 'user', 'agent', 1, '{"type":"idle"}', NULL,
           1, 7, 'epoch', '{}', '{}', 3, 3, 99, 123)`,
      );

      const [beforeColumns] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='sessions'
            AND column_name IN ('purge_after_ms', 'deletion_generation')`,
      );
      expect(Number(beforeColumns[0]?.count)).toBe(0);

      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0009 });
      await upgraded.close();

      const [sessions] = await conn.query<Row[]>(
        `SELECT session_id, archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation
           FROM sessions WHERE session_id IN ('sess_parent', 'sess_child', 'sess_deleted')
          ORDER BY session_id`,
      );
      expect(sessions.map((row) => ({
        id: row.session_id,
        archivedAtMs: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
        deletedAtMs: row.deleted_at_ms == null ? null : Number(row.deleted_at_ms),
        purgeAfterMs: row.purge_after_ms == null ? null : Number(row.purge_after_ms),
        deletionGeneration: Number(row.deletion_generation),
      }))).toEqual([
        { id: "sess_child", archivedAtMs: null, deletedAtMs: null, purgeAfterMs: null, deletionGeneration: 0 },
        { id: "sess_deleted", archivedAtMs: 99, deletedAtMs: 123, purgeAfterMs: null, deletionGeneration: 0 },
        { id: "sess_parent", archivedAtMs: null, deletedAtMs: null, purgeAfterMs: null, deletionGeneration: 0 },
      ]);
      expect(await hasIndex(conn, "sessions", "idx_sessions_parent_lifecycle")).toBe(true);
      expect(await hasIndex(conn, "lifecycle_outbox", "uk_lifecycle_outbox_identity")).toBe(true);
      expect(await hasIndex(conn, "lifecycle_outbox", "idx_lifecycle_outbox_claim")).toBe(true);
      expect(await indexColumns(conn, "lifecycle_outbox", "idx_lifecycle_outbox_claim")).toEqual([
        "topic",
        "completed_at_ms",
        "dead_lettered_at_ms",
        "available_at_ms",
        "outbox_id",
        "lease_until_ms",
      ]);
      const [state] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations WHERE name='0009_session_tombstone_outbox.sql') AS applied,
          (SELECT COUNT(*) FROM lifecycle_outbox) AS outbox_rows`,
      );
      expect(state[0]).toMatchObject({ applied: 1, outbox_rows: 0 });

      // Model a crash after auto-committed DDL but before recording schema_migrations. Every expand
      // statement must converge when the same migration is replayed.
      await conn.query(
        `ALTER TABLE lifecycle_outbox
           DROP INDEX idx_lifecycle_outbox_claim,
           ADD KEY idx_lifecycle_outbox_claim
             (completed_at_ms, dead_lettered_at_ms, available_at_ms, lease_until_ms, outbox_id)`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name='0009_session_tombstone_outbox.sql'");
      const retried = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0009 });
      await retried.close();
      const [retriedState] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0009_session_tombstone_outbox.sql'",
      );
      expect(Number(retriedState[0]?.count)).toBe(1);
      expect(await hasIndex(conn, "sessions", "idx_sessions_parent_lifecycle")).toBe(true);
      expect(await indexColumns(conn, "lifecycle_outbox", "idx_lifecycle_outbox_claim")).toEqual([
        "topic",
        "completed_at_ms",
        "dead_lettered_at_ms",
        "available_at_ms",
        "outbox_id",
        "lease_until_ms",
      ]);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await rm(only0008, { recursive: true, force: true });
      await rm(only0009, { recursive: true, force: true });
    }
  });
});
