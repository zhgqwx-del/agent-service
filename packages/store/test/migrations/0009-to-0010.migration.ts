import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0009.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0010_blob_ownership.sql");
const THROUGH_0009 = [
  "0001_init.sql",
  "0002_auto_approved.sql",
  "0003_tenant_auth.sql",
  "0004_compaction.sql",
  "0005_api_key_scopes.sql",
  "0006_id_collation.sql",
  "0007_strict_ids_and_idempotency_scope.sql",
  "0008_atomic_turn_writes.sql",
  "0009_session_tombstone_outbox.sql",
] as const;

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

async function tableColumns(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => String(row.column_name));
}

async function indexColumns(
  conn: Connection,
  table: string,
  index: string,
): Promise<{ columns: string[]; unique: boolean }> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name=? AND index_name=?
      ORDER BY seq_in_index`,
    [table, index],
  );
  return {
    columns: rows.map((row) => String(row.column_name)),
    unique: rows.length > 0 && rows.every((row) => Number(row.non_unique) === 0),
  };
}

describe("real MySQL historical upgrade: 0009 -> 0010", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let migrationStatements: string[];

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements).toHaveLength(2);
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("restarts safely after only the first 0010 table auto-commits", async () => {
    const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) throw new Error("unsafe generated fixture database name");

    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);

      // MySQL DDL auto-commits. Simulate a process dying after statement 1 but before statement 2
      // and before schema_migrations is marked. The retry must retain the already-created table and
      // any row another process could have written after the crash.
      await conn.query(migrationStatements[0]!);
      await conn.query(
        `INSERT INTO blob_objects
          (blob_id, tenant_id, user_id, session_id, purpose, storage_backend, storage_format,
           storage_key, upload_token, state, staging_expires_at_ms, deletion_generation, created_at_ms)
         VALUES
          ('blob_partial_restart', 'tenant_partial', 'user_partial', 'sess_partial', 'tool_output',
           'filesystem', 'asblob2-envelope', 'objects/partial-restart', 'upload-partial-restart',
           'staging', 2000, 0, 1000)`,
      );
      const [beforeRestart] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name='blob_objects') AS manifest_tables,
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name='blob_delete_outbox') AS outbox_tables,
          (SELECT COUNT(*) FROM schema_migrations WHERE name='0010_blob_ownership.sql') AS applied`,
      );
      expect({
        manifestTables: Number(beforeRestart[0]?.manifest_tables),
        outboxTables: Number(beforeRestart[0]?.outbox_tables),
        applied: Number(beforeRestart[0]?.applied),
      }).toEqual({ manifestTables: 1, outboxTables: 0, applied: 0 });

      const restarted = await MysqlSessionStore.connect({ url, connectionLimit: 1 });
      await restarted.close();

      const [afterRestart] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM blob_objects WHERE blob_id='blob_partial_restart') AS manifest_rows,
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name='blob_delete_outbox') AS outbox_tables,
          (SELECT COUNT(*) FROM schema_migrations WHERE name='0010_blob_ownership.sql') AS applied`,
      );
      expect({
        manifestRows: Number(afterRestart[0]?.manifest_rows),
        outboxTables: Number(afterRestart[0]?.outbox_tables),
        applied: Number(afterRestart[0]?.applied),
      }).toEqual({ manifestRows: 1, outboxTables: 1, applied: 1 });
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("adds an empty case-sensitive ownership manifest and dedicated delete queue without changing historical rows", async () => {
    const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) throw new Error("unsafe generated fixture database name");

    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });

      // Restore a frozen 0009 database snapshot. Do not rebuild this baseline from today's live
      // migrations: the fixture must keep detecting accidental edits to already-deployed history.
      await conn.query(fixtureSql);
      await conn.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation)
         VALUES
          ('sess_existing', 'tenant_existing', 'user_existing', 'agent_existing', 1,
           '{"type":"idle"}', NULL, 4, 9, 'epoch_existing', '{}', '{"kept":true}',
           100, 200, NULL, 300, NULL, 3)`,
      );
      await conn.query(
        `INSERT INTO lifecycle_outbox
          (topic, aggregate_id, generation, payload, available_at_ms, attempts, claim_token,
           lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms)
         VALUES
          ('session.tombstoned', 'sess_existing', 3, '{"sessionId":"sess_existing","seq":4}',
           301, 2, NULL, NULL, 'retry later', NULL, NULL, 300)`,
      );

      const [historicalMigrations] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(historicalMigrations.map((row) => row.name)).toEqual([...THROUGH_0009]);
      const [beforeTables] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count
           FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_name IN ('blob_objects', 'blob_delete_outbox')`,
      );
      expect(Number(beforeTables[0]?.count)).toBe(0);

      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1 });
      await upgraded.close();

      expect(await tableColumns(conn, "blob_objects")).toEqual([
        "blob_id",
        "tenant_id",
        "user_id",
        "session_id",
        "item_id",
        "purpose",
        "storage_backend",
        "storage_format",
        "storage_key",
        "upload_token",
        "state",
        "sha256",
        "size_bytes",
        "content_type",
        "uploaded_at_ms",
        "ready_at_ms",
        "staging_expires_at_ms",
        "delete_after_ms",
        "deleted_at_ms",
        "deletion_generation",
        "created_at_ms",
      ]);
      expect(await tableColumns(conn, "blob_delete_outbox")).toEqual([
        "outbox_id",
        "blob_id",
        "generation",
        "available_at_ms",
        "attempts",
        "claim_token",
        "lease_until_ms",
        "last_error",
        "completed_at_ms",
        "dead_lettered_at_ms",
        "created_at_ms",
      ]);
      expect(await indexColumns(conn, "blob_objects", "uk_blob_objects_storage_key")).toEqual({
        columns: ["storage_key"],
        unique: true,
      });
      expect(await indexColumns(conn, "blob_objects", "idx_blob_objects_staging")).toEqual({
        columns: ["state", "staging_expires_at_ms", "blob_id"],
        unique: false,
      });
      expect(await indexColumns(conn, "blob_objects", "idx_blob_objects_owner_session")).toEqual({
        columns: ["tenant_id", "user_id", "session_id", "blob_id"],
        unique: false,
      });
      expect(await indexColumns(conn, "blob_objects", "idx_blob_objects_session_item_state")).toEqual({
        columns: ["session_id", "item_id", "state", "blob_id"],
        unique: false,
      });
      expect(await indexColumns(conn, "blob_delete_outbox", "uk_blob_delete_outbox_identity")).toEqual({
        columns: ["blob_id", "generation"],
        unique: true,
      });
      expect(await indexColumns(conn, "blob_delete_outbox", "idx_blob_delete_outbox_claim")).toEqual({
        columns: ["completed_at_ms", "dead_lettered_at_ms", "available_at_ms", "outbox_id", "lease_until_ms"],
        unique: false,
      });

      const [columnCollations] = await conn.query<Row[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE()
            AND ((table_name='blob_objects' AND column_name IN
                  ('blob_id','tenant_id','user_id','session_id','item_id','storage_key','upload_token','state'))
              OR (table_name='blob_delete_outbox' AND column_name IN ('blob_id','claim_token')))
          ORDER BY table_name, ordinal_position`,
      );
      expect(columnCollations.every((row) => row.collation_name === "utf8mb4_0900_as_cs")).toBe(true);
      expect(columnCollations).toHaveLength(10);
      const [blobColumnShapes] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable
           FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='blob_objects'
            AND column_name IN
              ('item_id','upload_token','sha256','size_bytes','staging_expires_at_ms','deletion_generation')
          ORDER BY ordinal_position`,
      );
      expect(blobColumnShapes.map((row) => ({
        name: row.column_name,
        type: row.column_type,
        nullable: row.is_nullable,
      }))).toEqual([
        { name: "item_id", type: "varchar(64)", nullable: "YES" },
        { name: "upload_token", type: "varchar(64)", nullable: "NO" },
        { name: "sha256", type: "binary(32)", nullable: "YES" },
        { name: "size_bytes", type: "bigint unsigned", nullable: "YES" },
        { name: "staging_expires_at_ms", type: "bigint", nullable: "YES" },
        { name: "deletion_generation", type: "bigint", nullable: "NO" },
      ]);

      const [preserved] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM blob_objects) AS blob_rows,
          (SELECT COUNT(*) FROM blob_delete_outbox) AS blob_outbox_rows,
          (SELECT COUNT(*) FROM schema_migrations WHERE name='0010_blob_ownership.sql') AS applied,
          (SELECT COUNT(*) FROM sessions
            WHERE session_id='sess_existing' AND tenant_id='tenant_existing' AND user_id='user_existing'
              AND last_seq=4 AND fence_token=9 AND deletion_generation=3
              AND JSON_EXTRACT(metadata, '$.kept')=true) AS session_rows,
          (SELECT COUNT(*) FROM lifecycle_outbox
            WHERE topic='session.tombstoned' AND aggregate_id='sess_existing' AND generation=3
              AND attempts=2 AND last_error='retry later') AS lifecycle_rows`,
      );
      expect({
        blobRows: Number(preserved[0]?.blob_rows),
        blobOutboxRows: Number(preserved[0]?.blob_outbox_rows),
        applied: Number(preserved[0]?.applied),
        sessionRows: Number(preserved[0]?.session_rows),
        lifecycleRows: Number(preserved[0]?.lifecycle_rows),
      }).toEqual({ blobRows: 0, blobOutboxRows: 0, applied: 1, sessionRows: 1, lifecycleRows: 1 });

      // The manifest and queue identities must keep byte-sensitive semantics, matching the in-memory
      // store and Redis fencing keys. A case-insensitive collation would collapse these two rows.
      await conn.query(
        `INSERT INTO blob_objects
          (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend,
           storage_format, storage_key, upload_token, state, sha256, size_bytes, content_type, uploaded_at_ms,
           ready_at_ms, staging_expires_at_ms, delete_after_ms, deleted_at_ms,
           deletion_generation, created_at_ms)
         VALUES
          ('blob_Case', 'tenant_existing', 'user_existing', 'sess_existing', 'item_Case',
           'tool_output', 'filesystem', 'asblob2-envelope', 'objects/Case', 'upload-token-case1', 'staging',
           UNHEX(REPEAT('a', 64)), 2, 'application/json', 400, NULL, 1000, NULL, NULL, 1, 399),
          ('blob_case', 'tenant_existing', 'user_existing', 'sess_existing', 'item_case',
           'tool_output', 'filesystem', 'asblob2-envelope', 'objects/case', 'upload-token-case2', 'staging',
           UNHEX(REPEAT('b', 64)), 3, 'application/json', 401, NULL, 1001, NULL, NULL, 1, 400)`,
      );
      await conn.query(
        `INSERT INTO blob_delete_outbox
          (blob_id, generation, available_at_ms, attempts, created_at_ms)
         VALUES ('blob_Case', 1, 500, 0, 500), ('blob_case', 1, 501, 0, 501)`,
      );
      await expect(conn.query(
        `INSERT INTO blob_objects
          (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend,
           storage_format, storage_key, upload_token, state, sha256, size_bytes, content_type,
           staging_expires_at_ms, deletion_generation, created_at_ms)
         VALUES
          ('blob_duplicate_key', 'tenant_existing', 'user_existing', 'sess_existing', 'item_other',
           'tool_output', 'filesystem', 'asblob2-envelope', 'objects/Case', 'upload-token-case3', 'staging',
           UNHEX(REPEAT('c', 64)), 1, 'application/json', 1002, 1, 401)`,
      )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

      // Model a process dying after both CREATE TABLE statements auto-committed but before the
      // schema_migrations marker was durable. Replaying must preserve all manifest and queue rows.
      await conn.query("DELETE FROM schema_migrations WHERE name='0010_blob_ownership.sql'");
      const retried = await MysqlSessionStore.connect({ url, connectionLimit: 1 });
      await retried.close();
      const [replayed] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations WHERE name='0010_blob_ownership.sql') AS applied,
          (SELECT COUNT(*) FROM blob_objects) AS blob_rows,
          (SELECT COUNT(*) FROM blob_delete_outbox) AS outbox_rows,
          (SELECT COUNT(*) FROM sessions WHERE session_id='sess_existing') AS session_rows,
          (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id='sess_existing') AS lifecycle_rows`,
      );
      expect({
        applied: Number(replayed[0]?.applied),
        blobRows: Number(replayed[0]?.blob_rows),
        outboxRows: Number(replayed[0]?.outbox_rows),
        sessionRows: Number(replayed[0]?.session_rows),
        lifecycleRows: Number(replayed[0]?.lifecycle_rows),
      }).toEqual({ applied: 1, blobRows: 2, outboxRows: 2, sessionRows: 1, lifecycleRows: 1 });
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
