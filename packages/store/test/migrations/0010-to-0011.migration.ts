import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, newErasureRequestId, newUsageId, userErasureRequestHash } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0010.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0011_erasure_and_usage_separation.sql");
const THROUGH_0010 = [
  "0001_init.sql",
  "0002_auto_approved.sql",
  "0003_tenant_auth.sql",
  "0004_compaction.sql",
  "0005_api_key_scopes.sql",
  "0006_id_collation.sql",
  "0007_strict_ids_and_idempotency_scope.sql",
  "0008_atomic_turn_writes.sql",
  "0009_session_tombstone_outbox.sql",
  "0010_blob_ownership.sql",
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

function fixtureDatabaseName(): string {
  const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error("unsafe generated fixture database name");
  }
  return database;
}

async function insertHistoricalRows(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO tenants (tenant_id, name, created_at_ms)
     VALUES ('tenant_Case', 'upper', 100), ('tenant_case', 'lower', 101)`,
  );
  await conn.query(
    `INSERT INTO sessions
      (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
       last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
       archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation)
     VALUES
      ('sess_Case', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       4, 9, 'epoch', '{"inputTokens":3}', '{"kept":true}', 110, 120, NULL, NULL, NULL, 0),
      ('sess_case', 'tenant_case', 'user_case', 'agent', 1, '{"type":"idle"}', NULL,
       5, 10, 'epoch', '{"inputTokens":7}', '{"kept":true}', 111, 121, NULL, 119, NULL, 3),
      ('sess_orphan', 'tenant_orphan', 'user_orphan', 'agent', 1, '{"type":"idle"}', NULL,
       1, 0, 'epoch', '{}', '{"kept":true}', 112, 122, NULL, NULL, NULL, 0),
      ('sess_mixed_known_first', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       4, 0, 'epoch', '{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25}', '{}', 113, 123, NULL, NULL, NULL, 0),
      ('sess_mixed_unknown_first', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       4, 0, 'epoch', '{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25}', '{}', 114, 124, NULL, NULL, NULL, 0),
      ('sess_legacy_zero', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       1, 0, 'epoch', '{"inputTokens":1,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":1,"costCNY":0}', '{}', 115, 125, NULL, NULL, NULL, 0),
      ('sess_compaction', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       2, 0, 'epoch', '{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0}', '{}', 116, 126, NULL, NULL, NULL, 0),
      ('sess_new_zero', 'tenant_Case', 'user_Case', 'agent', 1, '{"type":"idle"}', NULL,
       0, 0, 'epoch', '{}', '{}', 117, 127, NULL, NULL, NULL, 0)`,
  );
  await conn.query(
    `INSERT INTO usage_ledger
      (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
     VALUES
      ('tenant_Case', 'user_Case', 'sess_Case', 'turn_Case', 1, 'provider', 'model',
       '{"inputTokens":3,"outputTokens":5,"cacheReadTokens":1,"cacheWriteTokens":0,"reasoningTokens":2,"totalTokens":11,"costCNY":0.25}', 115),
      ('tenant_case', 'user_case', 'sess_case', 'turn_case', 1, 'provider', 'model',
       '{"inputTokens":7,"outputTokens":11,"cacheReadTokens":0,"cacheWriteTokens":2,"reasoningTokens":3,"totalTokens":23}', 116),
      ('tenant_Case', 'user_Case', 'sess_mixed_known_first', 'turn_mixed_known_first', 1, 'provider', 'model',
       '{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0.25}', 117),
      ('tenant_Case', 'user_Case', 'sess_mixed_known_first', 'turn_mixed_known_first', 2, 'provider', 'model',
       '{"inputTokens":3,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":5}', 118),
      ('tenant_Case', 'user_Case', 'sess_mixed_unknown_first', 'turn_mixed_unknown_first', 1, 'provider', 'model',
       '{"inputTokens":3,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":5}', 119),
      ('tenant_Case', 'user_Case', 'sess_mixed_unknown_first', 'turn_mixed_unknown_first', 2, 'provider', 'model',
       '{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0.25}', 120),
      ('tenant_Case', 'user_Case', 'sess_legacy_zero', 'turn_legacy_zero', 1, 'provider', 'legacy-unpriced',
       '{"inputTokens":1,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":1,"costCNY":0}', 121),
      ('tenant_Case', 'user_Case', 'sess_compaction', 'turn_compaction', 0, 'provider', 'legacy-unpriced',
       '{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0}', 122)`,
  );
  await conn.query(
    `INSERT INTO turns
      (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
       idempotency_key, started_at_ms, completed_at_ms)
     VALUES
      ('turn_mixed_known_first', 'sess_mixed_known_first', 'user_Case', 'completed', 'end_turn', 2, 4,
       '{"id":"turn_mixed_known_first","sessionId":"sess_mixed_known_first","status":"completed","stopReason":"end_turn","seqStart":2,"seqEnd":4,"steps":2,"toolCalls":0,"usage":{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25},"startedAtMs":117,"completedAtMs":119}',
       NULL, 117, 119),
      ('turn_mixed_unknown_first', 'sess_mixed_unknown_first', 'user_Case', 'completed', 'end_turn', 2, 4,
       '{"id":"turn_mixed_unknown_first","sessionId":"sess_mixed_unknown_first","status":"completed","stopReason":"end_turn","seqStart":2,"seqEnd":4,"steps":2,"toolCalls":0,"usage":{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25},"startedAtMs":119,"completedAtMs":121}',
       NULL, 119, 121)`,
  );
  await conn.query(
    `INSERT INTO items
      (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
     VALUES
      ('item_compaction', 'sess_compaction', 'user_Case', 'turn_compaction', 2,
       'contextCompaction', 'completed',
       '{"id":"item_compaction","sessionId":"sess_compaction","turnId":"turn_compaction","seq":2,"status":"completed","createdAtMs":122,"completedAtMs":122,"type":"contextCompaction","replacesUpToSeq":1,"summary":"legacy summary","usageSnapshot":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0}}',
       122, 122)`,
  );
  await conn.query(
    `INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES
      ('sess_mixed_known_first', 2, 'user_Case', 'usage/updated',
       '{"type":"usage/updated","sessionId":"sess_mixed_known_first","seq":2,"emittedAtMs":117,"turnId":"turn_mixed_known_first","step":1,"stepUsage":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0.25},"turnUsage":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0.25},"sessionUsage":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0.25},"runtime":{"provider":"provider","model":"model"}}', 117),
      ('sess_mixed_known_first', 3, 'user_Case', 'usage/updated',
       '{"type":"usage/updated","sessionId":"sess_mixed_known_first","seq":3,"emittedAtMs":118,"turnId":"turn_mixed_known_first","step":2,"stepUsage":{"inputTokens":3,"outputTokens":2,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":5},"turnUsage":{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25},"sessionUsage":{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25},"runtime":{"provider":"provider","model":"model"}}', 118),
      ('sess_mixed_known_first', 4, 'user_Case', 'turn/completed',
       '{"type":"turn/completed","sessionId":"sess_mixed_known_first","seq":4,"emittedAtMs":119,"turn":{"id":"turn_mixed_known_first","sessionId":"sess_mixed_known_first","status":"completed","stopReason":"end_turn","seqStart":2,"seqEnd":4,"steps":2,"toolCalls":0,"usage":{"inputTokens":5,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":8,"costCNY":0.25},"startedAtMs":117,"completedAtMs":119},"stopReason":"end_turn"}', 119),
      ('sess_compaction', 2, 'user_Case', 'item/completed',
       '{"type":"item/completed","sessionId":"sess_compaction","seq":2,"emittedAtMs":122,"item":{"id":"item_compaction","sessionId":"sess_compaction","turnId":"turn_compaction","seq":2,"status":"completed","createdAtMs":122,"completedAtMs":122,"type":"contextCompaction","replacesUpToSeq":1,"summary":"legacy summary","usageSnapshot":{"inputTokens":2,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":3,"costCNY":0}}}', 122)`,
  );
  await conn.query(
    `INSERT INTO lifecycle_outbox
      (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
     VALUES ('session.tombstoned', 'sess_case', 3, '{"sessionId":"sess_case","seq":5}', 120, 2, 119)`,
  );
  await conn.query(
    `INSERT INTO blob_objects
      (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend, storage_format,
       storage_key, upload_token, state, sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
       deletion_generation, created_at_ms)
     VALUES
      ('blob_existing', 'tenant_Case', 'user_Case', 'sess_Case', 'item_existing', 'tool_output',
       'filesystem', 'asblob2-envelope', 'objects/existing', 'upload-existing', 'ready',
       UNHEX(REPEAT('a', 64)), 17, 'application/json', 117, 118, 0, 116)`,
  );
}

describe("real MySQL historical upgrade: 0010 -> 0011", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0011: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.length).toBeGreaterThan(20);
    expect(migrationStatements.filter((statement) => (
      statement.startsWith("CREATE TRIGGER trg_sessions_subject_lifecycle_ai")
    ))).toHaveLength(1);
    only0011 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0011-"));
    await copyFile(MIGRATION_PATH, join(only0011, "0011_erasure_and_usage_separation.sql"));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0011, { recursive: true, force: true });
  });

  it("converges after usage identity and the first 0011 table auto-commit", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      await insertHistoricalRows(conn);

      const firstTable = migrationStatements.findIndex((statement) =>
        statement.startsWith("CREATE TABLE IF NOT EXISTS billing_usage_facts"));
      expect(firstTable).toBeGreaterThan(0);
      for (const statement of migrationStatements.slice(0, firstTable + 1)) {
        await conn.query(statement);
      }
      await conn.query(
        `INSERT INTO billing_usage_facts
          (usage_id, tenant_id, accounting_period, provider, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny,
           currency, fact_sha256)
         VALUES
          ('usg_partial', 'tenant_Case', '2026-10', 'provider', 'model', 3, 5, 1, 0, 2, 11,
           0.250000000, 'CNY', REPEAT('b', 64))`,
      );

      // Also model a stale interrupted attempt that left our reserved index name with the wrong
      // shape. Replay owns that name and must restore the byte-sensitive unique usage identity.
      await conn.query(
        `ALTER TABLE usage_ledger
           DROP INDEX uk_usage_ledger_usage_id,
           ADD KEY uk_usage_ledger_usage_id (tenant_id, usage_id)`,
      );
      const [beforeRestart] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0011_erasure_and_usage_separation.sql') AS applied,
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name='billing_usage_facts') AS billing_tables,
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name='usage_reconciliations') AS reconciliation_tables`,
      );
      expect({
        applied: Number(beforeRestart[0]?.applied),
        billingTables: Number(beforeRestart[0]?.billing_tables),
        reconciliationTables: Number(beforeRestart[0]?.reconciliation_tables),
      }).toEqual({ applied: 0, billingTables: 1, reconciliationTables: 0 });

      const restarted = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0011 });
      await restarted.close();

      expect(await indexColumns(conn, "usage_ledger", "uk_usage_ledger_usage_id")).toEqual({
        columns: ["usage_id"],
        unique: true,
      });
      const [afterRestart] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0011_erasure_and_usage_separation.sql') AS applied,
          (SELECT COUNT(*) FROM billing_usage_facts WHERE usage_id='usg_partial'
            AND cost_cny=0.250000000) AS billing_rows,
          (SELECT COUNT(*) FROM subject_lifecycle WHERE state='active' AND generation=0) AS subjects,
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name IN
              ('billing_usage_facts','usage_reconciliations','subject_lifecycle',
               'erasure_requests','erasure_audit_events')) AS lifecycle_tables`,
      );
      expect({
        applied: Number(afterRestart[0]?.applied),
        billingRows: Number(afterRestart[0]?.billing_rows),
        subjects: Number(afterRestart[0]?.subjects),
        lifecycleTables: Number(afterRestart[0]?.lifecycle_tables),
      }).toEqual({ applied: 1, billingRows: 1, subjects: 6, lifecycleTables: 5 });
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("adds case-sensitive erasure and financial-fact foundations without rewriting 0010 data", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let postMigrationStore: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      await insertHistoricalRows(conn);

      const [historicalMigrations] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(historicalMigrations.map((row) => row.name)).toEqual([...THROUGH_0010]);

      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0011 });
      await upgraded.close();

      expect(await tableColumns(conn, "billing_usage_facts")).toEqual([
        "usage_id", "tenant_id", "accounting_period", "provider", "model", "input_tokens",
        "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
        "total_tokens", "cost_cny", "currency", "fact_sha256",
      ]);
      expect(await tableColumns(conn, "usage_reconciliations")).toEqual([
        "tenant_id", "user_id", "session_id", "deletion_generation", "status", "row_count",
        "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
        "reasoning_tokens", "total_tokens", "known_cost_rows", "cost_cny", "checksum",
        "verified_at_ms", "anonymized_at_ms", "created_at_ms", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "subject_lifecycle")).toEqual([
        "tenant_id", "subject_kind", "subject_id", "state", "generation", "active_request_id",
        "legal_hold_at_ms", "created_at_ms", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "erasure_requests")).toEqual([
        "request_id", "tenant_id", "subject_kind", "subject_id", "generation", "status",
        "requested_by_key_id", "idempotency_key", "request_hash", "created_at_ms", "gated_at_ms",
        "updated_at_ms", "completed_at_ms", "counts_json", "checksum",
      ]);
      expect(await tableColumns(conn, "erasure_audit_events")).toEqual([
        "request_id", "seq", "event_type", "payload", "emitted_at_ms",
      ]);

      // Billing facts are a strict whitelist. Long-lived rows cannot retain direct owner/content
      // attribution even if later application code accidentally tries to depend on it.
      const billingColumns = await tableColumns(conn, "billing_usage_facts");
      for (const forbidden of ["user_id", "session_id", "turn_id", "step", "usage_json", "payload"]) {
        expect(billingColumns).not.toContain(forbidden);
      }

      expect(await indexColumns(conn, "usage_ledger", "uk_usage_ledger_usage_id")).toEqual({
        columns: ["usage_id"], unique: true,
      });
      expect(await indexColumns(conn, "billing_usage_facts", "idx_billing_usage_tenant_period")).toEqual({
        columns: ["tenant_id", "accounting_period", "provider", "model", "usage_id"], unique: false,
      });
      expect(await indexColumns(conn, "usage_reconciliations", "idx_usage_reconciliations_owner")).toEqual({
        columns: ["tenant_id", "user_id", "session_id", "deletion_generation"], unique: false,
      });
      expect(await indexColumns(conn, "usage_reconciliations", "idx_usage_reconciliations_status")).toEqual({
        columns: ["status", "updated_at_ms", "session_id", "deletion_generation"], unique: false,
      });
      expect(await indexColumns(conn, "subject_lifecycle", "uk_subject_lifecycle_active_request")).toEqual({
        columns: ["active_request_id"], unique: true,
      });
      expect(await indexColumns(conn, "subject_lifecycle", "idx_subject_lifecycle_state")).toEqual({
        columns: ["state", "updated_at_ms", "tenant_id", "subject_kind", "subject_id"], unique: false,
      });
      expect(await indexColumns(conn, "erasure_requests", "uk_erasure_requests_subject_generation")).toEqual({
        columns: ["tenant_id", "subject_kind", "subject_id", "generation"], unique: true,
      });
      expect(await indexColumns(conn, "erasure_requests", "uk_erasure_requests_idempotency")).toEqual({
        columns: ["tenant_id", "subject_kind", "subject_id", "idempotency_key"], unique: true,
      });
      expect(await indexColumns(conn, "erasure_requests", "idx_erasure_requests_status")).toEqual({
        columns: ["status", "updated_at_ms", "request_id"], unique: false,
      });
      expect(await indexColumns(conn, "erasure_audit_events", "idx_erasure_audit_events_emitted")).toEqual({
        columns: ["emitted_at_ms", "request_id", "seq"], unique: false,
      });

      const [usageIdShape] = await conn.query<Row[]>(
        `SELECT COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLLATION_NAME AS collation_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='usage_ledger' AND column_name='usage_id'`,
      );
      expect(usageIdShape[0]).toMatchObject({
        column_type: "varchar(64)", is_nullable: "YES", collation_name: "utf8mb4_0900_as_cs",
      });
      const [identityCollations] = await conn.query<Row[]>(
        `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE()
            AND ((table_name='billing_usage_facts' AND column_name IN
                  ('usage_id','tenant_id','accounting_period','provider','model','currency','fact_sha256'))
              OR (table_name='usage_reconciliations' AND column_name IN
                  ('tenant_id','user_id','session_id','status','checksum'))
              OR (table_name='subject_lifecycle' AND column_name IN
                  ('tenant_id','subject_kind','subject_id','state','active_request_id'))
              OR (table_name='erasure_requests' AND column_name IN
                  ('request_id','tenant_id','subject_kind','subject_id','status','requested_by_key_id',
                   'idempotency_key','request_hash','checksum'))
              OR (table_name='erasure_audit_events' AND column_name IN
                  ('request_id','event_type')))
          ORDER BY table_name, ordinal_position`,
      );
      expect(identityCollations).toHaveLength(28);
      expect(identityCollations.every((row) => row.collation_name === "utf8mb4_0900_as_cs")).toBe(true);

      const [preserved] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0011_erasure_and_usage_separation.sql') AS applied,
          (SELECT COUNT(*) FROM usage_ledger WHERE usage_id IS NULL) AS null_usage_ids,
          (SELECT COUNT(*) FROM usage_ledger WHERE id=1 AND tenant_id='tenant_Case'
            AND JSON_EXTRACT(usage_json, '$.costCNY')=0.25 AND created_at_ms=115) AS usage_rows,
          (SELECT COUNT(*) FROM sessions WHERE session_id='sess_case' AND deletion_generation=3
            AND deleted_at_ms=119 AND JSON_EXTRACT(metadata, '$.kept')=true) AS session_rows,
          (SELECT COUNT(*) FROM lifecycle_outbox WHERE aggregate_id='sess_case'
            AND generation=3 AND attempts=2) AS lifecycle_rows,
          (SELECT COUNT(*) FROM blob_objects WHERE blob_id='blob_existing' AND state='ready'
            AND size_bytes=17 AND deletion_generation=0) AS blob_rows,
          (SELECT COUNT(*) FROM billing_usage_facts) AS billing_rows,
          (SELECT COUNT(*) FROM usage_reconciliations) AS reconciliation_rows,
          (SELECT COUNT(*) FROM erasure_requests) AS erasure_rows,
          (SELECT COUNT(*) FROM erasure_audit_events) AS audit_rows`,
      );
      expect({
        applied: Number(preserved[0]?.applied),
        nullUsageIds: Number(preserved[0]?.null_usage_ids),
        usageRows: Number(preserved[0]?.usage_rows),
        sessionRows: Number(preserved[0]?.session_rows),
        lifecycleRows: Number(preserved[0]?.lifecycle_rows),
        blobRows: Number(preserved[0]?.blob_rows),
        billingRows: Number(preserved[0]?.billing_rows),
        reconciliationRows: Number(preserved[0]?.reconciliation_rows),
        erasureRows: Number(preserved[0]?.erasure_rows),
        auditRows: Number(preserved[0]?.audit_rows),
      }).toEqual({
        applied: 1, nullUsageIds: 8, usageRows: 1, sessionRows: 1, lifecycleRows: 1,
        blobRows: 1, billingRows: 0, reconciliationRows: 0, erasureRows: 0, auditRows: 0,
      });

      // Runtime projections after a historical upgrade are rebuilt from the operational ledger,
      // not trusted from stale 0010 JSON. Exercise both mixed-cost orders, rowless identity,
      // ambiguous legacy zero, exact event prefixes, and compaction snapshots.
      postMigrationStore = await MysqlSessionStore.connect({ url, connectionLimit: 2, migrationsDir: only0011 });
      const allPriced = await postMigrationStore.getSession("tenant_Case", "sess_Case");
      expect(allPriced?.usage).toEqual({
        inputTokens: 3,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
        totalTokens: 11,
        costCNY: 0.25,
      });
      const empty = await postMigrationStore.getSession("tenant_orphan", "sess_orphan");
      expect(empty?.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        costCNY: 0,
      });
      for (const sessionId of ["sess_mixed_known_first", "sess_mixed_unknown_first"]) {
        const session = await postMigrationStore.getSession("tenant_Case", sessionId);
        expect(session?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
        expect(session?.usage).not.toHaveProperty("costCNY");
      }
      const mixedList = await postMigrationStore.listSessions("tenant_Case", {
        userId: "user_Case",
        includeArchived: true,
        limit: 20,
      });
      expect(mixedList.data.find((session) => session.id === "sess_mixed_known_first")?.usage)
        .not.toHaveProperty("costCNY");

      const historicalTurn = await postMigrationStore.getTurn(
        "sess_mixed_known_first",
        "turn_mixed_known_first",
      );
      expect(historicalTurn?.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
      expect(historicalTurn?.usage).not.toHaveProperty("costCNY");
      expect((await postMigrationStore.listTurns("sess_mixed_known_first", { limit: 10 })).data[0]?.usage)
        .not.toHaveProperty("costCNY");
      const historicalEvents = await postMigrationStore.readEvents("sess_mixed_known_first", 0, 10);
      const firstUsageEvent = historicalEvents.find((event) => event.type === "usage/updated" && event.step === 1);
      const secondUsageEvent = historicalEvents.find((event) => event.type === "usage/updated" && event.step === 2);
      const completedEvent = historicalEvents.find((event) => event.type === "turn/completed");
      expect(firstUsageEvent).toMatchObject({
        type: "usage/updated",
        stepUsage: { costCNY: 0.25 },
        turnUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: 0.25 },
      });
      if (firstUsageEvent?.type === "usage/updated") {
        expect(firstUsageEvent.sessionUsage).not.toHaveProperty("costCNY");
      }
      if (secondUsageEvent?.type === "usage/updated") {
        expect(secondUsageEvent.stepUsage).not.toHaveProperty("costCNY");
        expect(secondUsageEvent.turnUsage).not.toHaveProperty("costCNY");
        expect(secondUsageEvent.sessionUsage).not.toHaveProperty("costCNY");
      }
      if (completedEvent?.type === "turn/completed") {
        expect(completedEvent.turn.usage).not.toHaveProperty("costCNY");
      }

      const legacyZero = await postMigrationStore.getSession("tenant_Case", "sess_legacy_zero");
      expect(legacyZero?.usage).not.toHaveProperty("costCNY");
      expect((await postMigrationStore.queryUsage("tenant_Case", {
        sessionId: "sess_legacy_zero", groupBy: "total", limit: 10,
      })).data[0]?.usage).not.toHaveProperty("costCNY");
      const compaction = await postMigrationStore.getItem("sess_compaction", "item_compaction");
      if (compaction?.type !== "contextCompaction") throw new Error("historical compaction item missing");
      expect(compaction.usageSnapshot).not.toHaveProperty("costCNY");
      const listedCompaction = (await postMigrationStore.listItems("sess_compaction", { limit: 10 }))[0];
      if (listedCompaction?.type !== "contextCompaction") throw new Error("historical compaction list missing");
      expect(listedCompaction.usageSnapshot).not.toHaveProperty("costCNY");
      const compactionEvent = (await postMigrationStore.readEvents("sess_compaction", 0, 10))[0];
      if (compactionEvent?.type !== "item/completed" || compactionEvent.item.type !== "contextCompaction") {
        throw new Error("historical compaction event missing");
      }
      expect(compactionEvent.item.usageSnapshot).not.toHaveProperty("costCNY");

      await postMigrationStore.commit({
        sessionId: "sess_orphan",
        fence: 1,
        usageEntries: [{
          usageId: newUsageId(),
          turnId: "turn_first_priced",
          step: 1,
          provider: "provider",
          model: "priced",
          usage: {
            inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
            reasoningTokens: 0, totalTokens: 5, costCNY: 0.5,
          },
          createdAtMs: 130,
        }],
      });
      expect((await postMigrationStore.getSession("tenant_orphan", "sess_orphan"))?.usage)
        .toMatchObject({ totalTokens: 5, costCNY: 0.5 });

      await postMigrationStore.commit({
        sessionId: "sess_new_zero",
        fence: 1,
        usageEntries: [{
          usageId: newUsageId(),
          turnId: "turn_new_known_zero",
          step: 1,
          provider: "provider",
          model: "free",
          usage: {
            inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
            reasoningTokens: 0, totalTokens: 1, costCNY: 0,
          },
          createdAtMs: 131,
        }],
      });
      expect((await postMigrationStore.getSession("tenant_Case", "sess_new_zero"))?.usage.costCNY).toBe(0);
      expect((await postMigrationStore.queryUsage("tenant_Case", {
        sessionId: "sess_new_zero", groupBy: "total", limit: 10,
      })).data[0]?.usage.costCNY).toBe(0);
      await postMigrationStore.close();
      postMigrationStore = undefined;

      const [subjects] = await conn.query<Row[]>(
        `SELECT tenant_id, subject_kind, subject_id, state, generation, active_request_id,
                legal_hold_at_ms, created_at_ms, updated_at_ms
           FROM subject_lifecycle
          ORDER BY BINARY tenant_id, BINARY subject_kind, BINARY subject_id`,
      );
      expect(subjects.map((row) => ({
        tenantId: row.tenant_id,
        kind: row.subject_kind,
        subjectId: row.subject_id,
        state: row.state,
        generation: Number(row.generation),
        activeRequestId: row.active_request_id,
        legalHoldAtMs: row.legal_hold_at_ms,
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
      }))).toEqual([
        { tenantId: "tenant_Case", kind: "tenant", subjectId: "tenant_Case", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 100, updatedAtMs: 100 },
        { tenantId: "tenant_Case", kind: "user", subjectId: "user_Case", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 110, updatedAtMs: 127 },
        { tenantId: "tenant_case", kind: "tenant", subjectId: "tenant_case", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 101, updatedAtMs: 101 },
        { tenantId: "tenant_case", kind: "user", subjectId: "user_case", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 111, updatedAtMs: 121 },
        { tenantId: "tenant_orphan", kind: "tenant", subjectId: "tenant_orphan", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 112, updatedAtMs: 122 },
        { tenantId: "tenant_orphan", kind: "user", subjectId: "user_orphan", state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null, createdAtMs: 112, updatedAtMs: 122 },
      ]);

      // Legacy 0010 writers omit usage_id. Multiple NULL values must remain valid while new IDs are
      // byte-sensitive and unique rather than collapsing case variants.
      await conn.query(
        `INSERT INTO usage_ledger
          (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES ('tenant_Case','user_Case','sess_Case','turn_legacy',1,'provider','model',
                 '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 140)`,
      );
      await conn.query("UPDATE usage_ledger SET usage_id='usg_Case' WHERE id=1");
      await conn.query("UPDATE usage_ledger SET usage_id='usg_case' WHERE id=2");
      await expect(conn.query(
        "UPDATE usage_ledger SET usage_id='usg_Case' WHERE turn_id='turn_legacy'",
      )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
      const [legacyRows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM usage_ledger WHERE usage_id IS NULL AND turn_id='turn_legacy'",
      );
      expect(Number(legacyRows[0]?.count)).toBe(1);

      // An old 0010 writer can remain live during the expand window. Its session INSERT knows
      // nothing about subject_lifecycle and its usage INSERT omits usage_id, so the database trigger
      // must materialize both active lifecycle rows before a new reader can see the session/usage.
      const legacyTenantId = "tenant_post_migration";
      const legacyUserId = "user_post_migration";
      const legacySessionId = "sess_post_migration";
      await conn.query(
        `INSERT INTO tenants (tenant_id, name, created_at_ms)
         VALUES (?, 'post-migration legacy tenant', 200)`,
        [legacyTenantId],
      );
      await conn.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation)
         VALUES (?, ?, ?, 'agent', 1, '{"type":"idle"}', NULL,
                 0, 0, 'epoch', '{}', '{"legacy":true}', 210, 211, NULL, NULL, NULL, 0)`,
        [legacySessionId, legacyTenantId, legacyUserId],
      );
      await conn.query(
        `INSERT INTO usage_ledger
          (tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
         VALUES (?, ?, ?, 'turn_post_migration', 1, 'provider', 'legacy-model',
                 '{"inputTokens":13,"outputTokens":5,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":18}', 212)`,
        [legacyTenantId, legacyUserId, legacySessionId],
      );

      const [triggerRows] = await conn.query<Row[]>(
        `SELECT ACTION_TIMING AS action_timing, EVENT_MANIPULATION AS event_manipulation,
                EVENT_OBJECT_TABLE AS event_object_table
           FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name='trg_sessions_subject_lifecycle_ai'`,
      );
      expect(triggerRows).toEqual([expect.objectContaining({
        action_timing: "AFTER", event_manipulation: "INSERT", event_object_table: "sessions",
      })]);
      const [legacySubjects] = await conn.query<Row[]>(
        `SELECT subject_kind, subject_id, state, generation, active_request_id, legal_hold_at_ms
           FROM subject_lifecycle
          WHERE tenant_id=?
          ORDER BY subject_kind, subject_id`,
        [legacyTenantId],
      );
      expect(legacySubjects.map((row) => ({
        kind: row.subject_kind,
        subjectId: row.subject_id,
        state: row.state,
        generation: Number(row.generation),
        activeRequestId: row.active_request_id,
        legalHoldAtMs: row.legal_hold_at_ms,
      }))).toEqual([
        { kind: "tenant", subjectId: legacyTenantId, state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null },
        { kind: "user", subjectId: legacyUserId, state: "active", generation: 0,
          activeRequestId: null, legalHoldAtMs: null },
      ]);
      const [legacyUsageIdentity] = await conn.query<Row[]>(
        "SELECT usage_id FROM usage_ledger WHERE session_id=? AND turn_id='turn_post_migration'",
        [legacySessionId],
      );
      expect(legacyUsageIdentity).toEqual([expect.objectContaining({ usage_id: null })]);

      postMigrationStore = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0011 });
      expect(await postMigrationStore.getSession(legacyTenantId, legacySessionId)).toMatchObject({
        id: legacySessionId,
        tenantId: legacyTenantId,
        userId: legacyUserId,
        metadata: { legacy: true },
      });
      expect(await postMigrationStore.queryUsage(legacyTenantId, {
        userId: legacyUserId,
        groupBy: "total",
        limit: 10,
      })).toEqual({
        data: [{
          key: "total",
          turns: 1,
          steps: 1,
          usage: {
            inputTokens: 13,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            totalTokens: 18,
          },
        }],
      });

      const legacyRequestId = newErasureRequestId();
      await expect(postMigrationStore.requestUserErasure({
        requestId: legacyRequestId,
        tenantId: legacyTenantId,
        userId: legacyUserId,
        requestedByKeyId: "migration-test-admin",
        idempotencyKey: "post-migration-legacy-gate",
        requestHash: userErasureRequestHash(legacyTenantId, legacyUserId),
        atMs: 220,
      })).resolves.toMatchObject({
        requestId: legacyRequestId,
        generation: 1,
        status: "gated",
      });
      await conn.query(
        `UPDATE subject_lifecycle SET legal_hold_at_ms=221, updated_at_ms=221
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
        [legacyTenantId, legacyUserId],
      );
      await postMigrationStore.close();
      postMigrationStore = undefined;

      // Replaying after the marker is lost replaces the compatibility trigger and reruns the
      // backfill. Neither operation may reset a historical or trigger-created gate/legal hold.
      await conn.query(
        `UPDATE subject_lifecycle
            SET state='deleting', generation=4, active_request_id='erase_keep', legal_hold_at_ms=150,
                updated_at_ms=151
          WHERE tenant_id='tenant_Case' AND subject_kind='user' AND subject_id='user_Case'`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name='0011_erasure_and_usage_separation.sql'");
      const replayed = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0011 });
      await replayed.close();
      const [gateAfterReplay] = await conn.query<Row[]>(
        `SELECT state, generation, active_request_id, legal_hold_at_ms, updated_at_ms
           FROM subject_lifecycle
          WHERE tenant_id='tenant_Case' AND subject_kind='user' AND subject_id='user_Case'`,
      );
      expect(gateAfterReplay[0]).toMatchObject({
        state: "deleting", generation: 4, active_request_id: "erase_keep",
        legal_hold_at_ms: 150, updated_at_ms: 151,
      });
      const [legacyGateAfterReplay] = await conn.query<Row[]>(
        `SELECT state, generation, active_request_id, legal_hold_at_ms, updated_at_ms
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
        [legacyTenantId, legacyUserId],
      );
      expect(legacyGateAfterReplay[0]).toMatchObject({
        state: "deleting",
        generation: 1,
        active_request_id: legacyRequestId,
        legal_hold_at_ms: 221,
        updated_at_ms: 221,
      });
      postMigrationStore = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0011 });
      expect((await postMigrationStore.getSessionLifecycle(
        "tenant_orphan", "user_orphan", "sess_orphan",
      ))?.session.usage).toMatchObject({ totalTokens: 5, costCNY: 0.5 });
      expect((await postMigrationStore.getSessionLifecycle(
        "tenant_Case", "user_Case", "sess_new_zero",
      ))?.session.usage).toMatchObject({ totalTokens: 1, costCNY: 0 });
      const [noDoubleUsage] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM usage_ledger
            WHERE session_id='sess_orphan' AND turn_id='turn_first_priced') AS first_priced_rows,
          (SELECT COUNT(*) FROM usage_ledger
            WHERE session_id='sess_new_zero' AND turn_id='turn_new_known_zero') AS known_zero_rows,
          (SELECT COUNT(*) FROM billing_usage_facts) AS billing_rows`,
      );
      expect({
        firstPricedRows: Number(noDoubleUsage[0]?.first_priced_rows),
        knownZeroRows: Number(noDoubleUsage[0]?.known_zero_rows),
        billingRows: Number(noDoubleUsage[0]?.billing_rows),
      }).toEqual({ firstPricedRows: 1, knownZeroRows: 1, billingRows: 2 });
      await postMigrationStore.close();
      postMigrationStore = undefined;
      const [triggerAfterReplay] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count
           FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name='trg_sessions_subject_lifecycle_ai'
            AND action_timing='AFTER' AND event_manipulation='INSERT'
            AND event_object_table='sessions'`,
      );
      expect(Number(triggerAfterReplay[0]?.count)).toBe(1);
    } finally {
      await postMigrationStore?.close().catch(() => {});
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
