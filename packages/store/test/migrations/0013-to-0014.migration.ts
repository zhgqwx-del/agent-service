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
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0013.sql");
const LEGACY_0008_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0008-legacy-tombstones.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0014_legacy_tombstone_compensation.sql");
const MIGRATION_CHAIN = [
  "0009_session_tombstone_outbox.sql",
  "0010_blob_ownership.sql",
  "0011_erasure_and_usage_separation.sql",
  "0012_erasure_job_queue.sql",
  "0013_erasure_job_control.sql",
  "0014_legacy_tombstone_compensation.sql",
] as const;

const CUTOVER_TRIGGERS = [
  "trg_legacy_tombstone_cutover_bd",
  "trg_legacy_tombstone_cutover_bd_guard_a",
  "trg_legacy_tombstone_cutover_bd_guard_b",
  "trg_legacy_tombstone_cutover_bu",
  "trg_legacy_tombstone_cutover_bu_guard_a",
  "trg_legacy_tombstone_cutover_bu_guard_b",
] as const;
const RESULT_TRIGGERS = [
  "trg_legacy_tombstone_compensation_events_bd",
  "trg_legacy_tombstone_compensation_events_bd_guard_a",
  "trg_legacy_tombstone_compensation_events_bd_guard_b",
  "trg_legacy_tombstone_compensation_events_bu",
  "trg_legacy_tombstone_compensation_events_bu_guard_a",
  "trg_legacy_tombstone_compensation_events_bu_guard_b",
] as const;
const SESSION_TRIGGERS = [
  "trg_sessions_legacy_tombstone_guard_bi",
  "trg_sessions_legacy_tombstone_guard_bu",
] as const;

type Row = RowDataPacket;

interface IndexDefinition {
  columns: string[];
  unique: boolean;
}

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

function fixtureDatabaseName(): string {
  const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error("unsafe generated fixture database name");
  }
  return database;
}

async function tableIndexes(conn: Connection, table: string): Promise<Record<string, IndexDefinition>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
            NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY index_name, seq_in_index`,
    [table],
  );
  const result: Record<string, IndexDefinition> = {};
  for (const row of rows) {
    const name = String(row.index_name);
    const entry = result[name] ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(String(row.column_name));
    result[name] = entry;
  }
  return result;
}

async function triggerRows(conn: Connection, table: string): Promise<Array<{
  name: string;
  event: string;
  statement: string;
}>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event_manipulation,
            ACTION_STATEMENT AS action_statement
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table=?
      ORDER BY trigger_name`,
    [table],
  );
  return rows.map((row) => ({
    name: String(row.trigger_name),
    event: String(row.event_manipulation),
    statement: String(row.action_statement),
  }));
}

async function expectFinalTriggers(conn: Connection): Promise<void> {
  const cutover = await triggerRows(conn, "legacy_tombstone_cutover");
  expect(cutover.map((row) => row.name)).toEqual([...CUTOVER_TRIGGERS]);
  for (const row of cutover) {
    expect(row.event).toBe(row.name.includes("_bu") ? "UPDATE" : "DELETE");
    expect(row.statement).toMatch(/write-once|cannot be deleted/i);
  }

  const results = await triggerRows(conn, "legacy_tombstone_compensation_events");
  expect(results.map((row) => row.name)).toEqual([...RESULT_TRIGGERS]);
  for (const row of results) {
    expect(row.event).toBe(row.name.includes("_bu") ? "UPDATE" : "DELETE");
    expect(row.statement).toMatch(/append-only/i);
  }

  const sessions = (await triggerRows(conn, "sessions"))
    .filter((row) => row.name.startsWith("trg_sessions_legacy_tombstone_guard"));
  expect(sessions.map((row) => row.name)).toEqual([...SESSION_TRIGGERS]);
  for (const row of sessions) {
    expect(row.event).toBe(row.name.endsWith("_bi") ? "INSERT" : "UPDATE");
    expect(row.statement).toMatch(/FOR SHARE/i);
    expect(row.statement).toMatch(/legacy session tombstone write rejected after cutover/i);
  }
}

async function expectResultAppendOnly(conn: Connection, jobId: string): Promise<void> {
  await expect(conn.query(
    "UPDATE legacy_tombstone_compensation_events SET emitted_at_ms=emitted_at_ms WHERE job_id=?",
    [jobId],
  )).rejects.toThrow(/append-only/i);
  await expect(conn.query(
    "DELETE FROM legacy_tombstone_compensation_events WHERE job_id=?",
    [jobId],
  )).rejects.toThrow(/append-only/i);
}

async function activateCutover(conn: Connection, atMs = 1_000): Promise<void> {
  const [result] = await conn.query<mysql.ResultSetHeader>(
    `UPDATE legacy_tombstone_cutover
        SET control_generation=1, activated_at_ms=?, actor_key_id='migration-admin',
            evidence_sha256=?
      WHERE singleton_id=1 AND control_generation=0 AND activated_at_ms IS NULL`,
    [atMs, "c".repeat(64)],
  );
  expect(result.affectedRows).toBe(1);
}

async function sessionResourceSnapshot(conn: Connection): Promise<Record<string, unknown>> {
  const [sessions] = await conn.query<Row[]>(
    `SELECT session_id, status, last_seq, fence_token, updated_at_ms, archived_at_ms,
            deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools
       FROM sessions ORDER BY session_id`,
  );
  const [counts] = await conn.query<Row[]>(
    `SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM turns) AS turns,
      (SELECT COUNT(*) FROM items) AS items,
      (SELECT COUNT(*) FROM approvals) AS approvals,
      (SELECT COUNT(*) FROM idempotency_keys) AS receipts,
      (SELECT COUNT(*) FROM usage_ledger) AS usage_rows,
      (SELECT COUNT(*) FROM lifecycle_outbox) AS lifecycle_rows,
      (SELECT COUNT(*) FROM blob_objects) AS blob_rows`,
  );
  return {
    sessions: sessions.map((row) => ({
      ...row,
      last_seq: Number(row.last_seq),
      fence_token: Number(row.fence_token),
      updated_at_ms: Number(row.updated_at_ms),
      archived_at_ms: row.archived_at_ms == null ? null : Number(row.archived_at_ms),
      deleted_at_ms: row.deleted_at_ms == null ? null : Number(row.deleted_at_ms),
      purge_after_ms: row.purge_after_ms == null ? null : Number(row.purge_after_ms),
      deletion_generation: Number(row.deletion_generation),
    })),
    counts: counts[0],
  };
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return settled;
}

describe("real MySQL historical upgrade: 0013 -> 0014", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let legacy0008FixtureSql: string;
  let migrationStatements: string[];
  let only0014: string;
  let through0014: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    legacy0008FixtureSql = await readFile(LEGACY_0008_FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.length).toBeGreaterThan(60);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TRIGGER")))
      .toHaveLength(20);
    only0014 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0014-"));
    await copyFile(MIGRATION_PATH, join(only0014, "0014_legacy_tombstone_compensation.sql"));
    through0014 = await mkdtemp(join(tmpdir(), "agent-service-migration-0009-through-0014-"));
    for (const name of MIGRATION_CHAIN) {
      await copyFile(resolve(HERE, `../../migrations/${name}`), join(through0014, name));
    }
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0014, { recursive: true, force: true });
    await rm(through0014, { recursive: true, force: true });
  });

  it("preserves genuine 0008 active/pending legacy deletions through the production 0009-0014 chain", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(legacy0008FixtureSql);
      const [beforeColumns] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='sessions'
            AND column_name IN ('purge_after_ms','deletion_generation')`,
      );
      expect(beforeColumns).toEqual([]);

      const upgraded = await MysqlSessionStore.connect({
        url,
        connectionLimit: 1,
        migrationsDir: through0014,
      });
      await upgraded.close();

      const [sessions] = await conn.query<Row[]>(
        `SELECT session_id, status, last_seq, fence_token, auto_approved_tools,
                deleted_at_ms, purge_after_ms, deletion_generation
           FROM sessions ORDER BY session_id`,
      );
      expect(sessions.map((row) => ({
        id: row.session_id,
        status: typeof row.status === "string" ? JSON.parse(row.status) : row.status,
        lastSeq: Number(row.last_seq),
        fence: Number(row.fence_token),
        grants: typeof row.auto_approved_tools === "string"
          ? JSON.parse(row.auto_approved_tools)
          : row.auto_approved_tools,
        deletedAtMs: row.deleted_at_ms == null ? null : Number(row.deleted_at_ms),
        purgeAfterMs: row.purge_after_ms == null ? null : Number(row.purge_after_ms),
        generation: Number(row.deletion_generation),
      }))).toEqual([
        {
          id: "sess_0008_deleted_active",
          status: { type: "active", turnId: "turn_0008_active", activeFlags: [] },
          lastSeq: 4,
          fence: 7,
          grants: ["danger"],
          deletedAtMs: 90,
          purgeAfterMs: null,
          generation: 0,
        },
        {
          id: "sess_0008_deleted_idle",
          status: { type: "idle" },
          lastSeq: 1,
          fence: 3,
          grants: ["legacy-tool"],
          deletedAtMs: 50,
          purgeAfterMs: null,
          generation: 0,
        },
        {
          id: "sess_0008_live",
          status: { type: "idle" },
          lastSeq: 1,
          fence: 0,
          grants: [],
          deletedAtMs: null,
          purgeAfterMs: null,
          generation: 0,
        },
      ]);

      const [resources] = await conn.query<Row[]>(
        `SELECT
          (SELECT status FROM turns WHERE turn_id='turn_0008_active') AS turn_status,
          (SELECT status FROM items WHERE item_id='item_0008_approval') AS item_status,
          (SELECT status FROM approvals WHERE approval_id='approval_0008') AS approval_status,
          (SELECT COUNT(*) FROM idempotency_keys
            WHERE session_id='sess_0008_deleted_active' AND value IS NULL AND request_hash IS NULL) AS pending_receipts,
          (SELECT COUNT(*) FROM idempotency_keys
            WHERE session_id='sess_0008_deleted_active' AND value IS NOT NULL) AS completed_receipts,
          (SELECT COUNT(*) FROM usage_ledger
            WHERE session_id='sess_0008_deleted_active' AND usage_id IS NULL) AS legacy_usage,
          (SELECT COUNT(*) FROM events
            WHERE session_id IN ('sess_0008_deleted_idle','sess_0008_deleted_active')
              AND type='session/deleted') AS terminal_events,
          (SELECT COUNT(*) FROM lifecycle_outbox
            WHERE aggregate_id IN ('sess_0008_deleted_idle','sess_0008_deleted_active')) AS lifecycle_intents,
          (SELECT COUNT(*) FROM legacy_tombstone_compensation_jobs) AS compensation_jobs`,
      );
      expect(resources[0]).toMatchObject({
        turn_status: "inProgress",
        item_status: "inProgress",
        approval_status: "pending",
        pending_receipts: 1,
        completed_receipts: 1,
        legacy_usage: 1,
        terminal_events: 0,
        lifecycle_intents: 0,
        compensation_jobs: 0,
      });

      const [cutover] = await conn.query<Row[]>("SELECT * FROM legacy_tombstone_cutover");
      expect(cutover).toEqual([expect.objectContaining({
        singleton_id: 1,
        control_generation: 0,
        activated_at_ms: null,
      })]);
      const [markers] = await conn.query<Row[]>(
        `SELECT name FROM schema_migrations
          WHERE name IN (${MIGRATION_CHAIN.map(() => "?").join(",")})
          ORDER BY name`,
        [...MIGRATION_CHAIN],
      );
      expect(markers.map((row) => String(row.name))).toEqual([...MIGRATION_CHAIN]);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("adds dormant compensation infrastructure without rewriting historical resources", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const before = await sessionResourceSnapshot(conn);

      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0014 });
      await upgraded.close();

      expect(await sessionResourceSnapshot(conn)).toEqual(before);
      const [cutover] = await conn.query<Row[]>(
        `SELECT singleton_id, control_generation, activated_at_ms, actor_key_id, evidence_sha256
           FROM legacy_tombstone_cutover`,
      );
      expect(cutover).toEqual([expect.objectContaining({
        singleton_id: 1,
        control_generation: 0,
        activated_at_ms: null,
        actor_key_id: null,
        evidence_sha256: null,
      })]);
      const [empty] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM legacy_tombstone_compensation_jobs) AS jobs,
          (SELECT COUNT(*) FROM legacy_tombstone_compensation_events) AS events`,
      );
      expect(empty[0]).toMatchObject({ jobs: 0, events: 0 });

      const [jobColumns] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
                IS_NULLABLE AS is_nullable, COLLATION_NAME AS collation_name,
                EXTRA AS extra
           FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='legacy_tombstone_compensation_jobs'
          ORDER BY ordinal_position`,
      );
      expect(jobColumns.map((row) => String(row.column_name))).toEqual([
        "job_id", "session_id", "tenant_id", "user_id", "source_kind", "source_request_id",
        "source_subject_generation", "source_claim_attempt", "source_claim_token_sha256",
        "maintenance_actor_key_id", "source_deleted_at_ms", "source_last_seq", "candidate_sha256",
        "status", "control_generation", "available_at_ms", "attempts", "claim_token",
        "lease_until_ms", "last_error_code", "created_at_ms", "updated_at_ms", "completed_at_ms",
        "completed_event_seq", "completed_claim_attempt", "completed_claim_token_sha256",
        "terminal_at_ms", "terminal_reason_code", "terminal_evidence_sha256",
      ]);
      expect(jobColumns[0]).toMatchObject({
        column_type: "varchar(64)", is_nullable: "NO", collation_name: "utf8mb4_0900_as_cs", extra: "",
      });
      const [eventColumns] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
                IS_NULLABLE AS is_nullable, COLLATION_NAME AS collation_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='legacy_tombstone_compensation_events'
          ORDER BY ordinal_position`,
      );
      expect(eventColumns.map((row) => String(row.column_name))).toEqual([
        "result_event_id", "job_id", "session_id", "control_generation", "event_type",
        "reason_code", "actor_key_id", "claim_attempt", "source_deleted_at_ms",
        "target_deletion_generation", "terminal_event_seq", "before_sha256", "after_sha256",
        "emitted_at_ms",
      ]);
      expect(eventColumns[1]).toMatchObject({
        column_type: "varchar(64)", is_nullable: "NO", collation_name: "utf8mb4_0900_as_cs",
      });

      const sessionIndexes = await tableIndexes(conn, "sessions");
      expect(sessionIndexes.idx_sessions_legacy_tombstone_candidate).toEqual({
        columns: ["deletion_generation", "deleted_at_ms", "session_id"],
        unique: false,
      });
      expect(await tableIndexes(conn, "legacy_tombstone_compensation_jobs")).toEqual({
        PRIMARY: { columns: ["job_id"], unique: true },
        idx_legacy_tombstone_compensation_jobs_claim: {
          columns: ["status", "available_at_ms", "lease_until_ms", "job_id"], unique: false,
        },
        idx_legacy_tombstone_compensation_jobs_owner: {
          columns: ["tenant_id", "user_id", "session_id"], unique: false,
        },
        idx_legacy_tombstone_compensation_jobs_source: {
          columns: ["source_request_id", "session_id"], unique: false,
        },
        uk_legacy_tombstone_compensation_job_session: {
          columns: ["session_id"], unique: true,
        },
      });
      expect((await tableIndexes(conn, "legacy_tombstone_compensation_events"))
        .uk_legacy_tombstone_compensation_event_generation).toEqual({
        columns: ["job_id", "control_generation"], unique: true,
      });
      await expectFinalTriggers(conn);

      // Expand is compatible with a drained-but-not-yet-exited legacy writer until activation.
      const [legacyDelete] = await conn.query<mysql.ResultSetHeader>(
        "UPDATE sessions SET deleted_at_ms=130 WHERE session_id='sess_live_0013'",
      );
      expect(legacyDelete.affectedRows).toBe(1);
      const [legacyRow] = await conn.query<Row[]>(
        "SELECT deleted_at_ms, deletion_generation FROM sessions WHERE session_id='sess_live_0013'",
      );
      expect(legacyRow[0]).toMatchObject({ deleted_at_ms: 130, deletion_generation: 0 });

      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
          (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
           source_subject_generation, source_claim_attempt, source_claim_token_sha256,
           maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
           status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
           last_error_code, created_at_ms, updated_at_ms, completed_at_ms, completed_event_seq,
           completed_claim_attempt, completed_claim_token_sha256, terminal_at_ms,
           terminal_reason_code, terminal_evidence_sha256)
         VALUES
          ('ltc_00000000-0000-4000-8000-000000000001', 'sess_legacy_idle_0013', 'tenant_a', 'user_a', 'maintenance',
           NULL, NULL, NULL, NULL, 'migration-admin', 50, 1, ?, 'pending', 1, 140, 0,
           NULL, NULL, NULL, 140, 140, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('ltc_00000000-0000-4000-8000-000000000002', 'sess_legacy_active_0013', 'tenant_a', 'user_a', 'erasure_claim',
           'erase_00000000-0000-4000-8000-000000000001', 2, 7, ?, NULL, 90, 4, ?, 'pending', 1, 140, 0,
           NULL, NULL, NULL, 140, 140, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        ["a".repeat(64), "b".repeat(64), "d".repeat(64)],
      );
      await expect(conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
          (job_id, session_id, tenant_id, user_id, source_kind, maintenance_actor_key_id,
           source_deleted_at_ms, source_last_seq, candidate_sha256, status,
           created_at_ms, updated_at_ms)
         VALUES ('ltc_00000000-0000-4000-8000-000000000003', 'sess_native_0013', 'tenant_a', 'user_a',
                 'maintenance', NULL, 120, 2, ?, 'pending', 140, 140)`,
        ["e".repeat(64)],
      )).rejects.toThrow();

      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_events
          (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
           claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
           before_sha256, after_sha256, emitted_at_ms)
         VALUES ('ltc_00000000-0000-4000-8000-000000000001', 'sess_legacy_idle_0013', 1,
                 'legacy_tombstone/compensated', NULL, 'migration-admin', 1, 50, 1, 2, ?, ?, 150)`,
        ["a".repeat(64), "f".repeat(64)],
      );
      await expectResultAppendOnly(conn, "ltc_00000000-0000-4000-8000-000000000001");

      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0014_legacy_tombstone_compensation.sql'",
      );
      expect(Number(marker[0]?.count)).toBe(1);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("linearizes activation with legacy writes and rejects invalid session markers afterwards", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let writer: Connection | undefined;
    let activator: Connection | undefined;
    try {
      writer = await mysql.createConnection({ uri: url, multipleStatements: true });
      await writer.query(fixtureSql);
      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0014 });
      await upgraded.close();
      activator = await mysql.createConnection(url);

      // A write that acquired the inactive singleton's shared lock linearizes before activation.
      await writer.beginTransaction();
      await writer.query("UPDATE sessions SET deleted_at_ms=131 WHERE session_id='sess_live_0013'");
      const activation = activateCutover(activator, 1_100);
      expect(await settlesWithin(activation, 100)).toBe(false);
      await writer.commit();
      await activation;

      await expect(activator.query(
        `UPDATE legacy_tombstone_cutover SET actor_key_id='other'
          WHERE singleton_id=1`,
      )).rejects.toThrow(/write-once/i);
      await expect(activator.query(
        "DELETE FROM legacy_tombstone_cutover WHERE singleton_id=1",
      )).rejects.toThrow(/cannot be deleted/i);

      // Live generation zero remains valid after cutover, but the old one-column DELETE cannot
      // create a new legacy marker. A native atomic generation-one tombstone still passes.
      await writer.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools)
         VALUES ('sess_after_cutover_0013','tenant_a','user_a','agent_a',1,'{"type":"idle"}',NULL,
                 1,0,'epoch_after','{}','{}',1200,1200,NULL,NULL,NULL,0,'[]')`,
      );
      await expect(writer.query(
        "UPDATE sessions SET deleted_at_ms=1210 WHERE session_id='sess_after_cutover_0013'",
      )).rejects.toThrow(/legacy session tombstone write rejected/i);
      await writer.query(
        `UPDATE sessions
            SET deleted_at_ms=1210, purge_after_ms=NULL, deletion_generation=1
          WHERE session_id='sess_after_cutover_0013'`,
      );
      await expect(writer.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools)
         VALUES ('sess_bad_deleted_0013','tenant_a','user_a','agent_a',1,'{"type":"idle"}',NULL,
                 1,0,'epoch_bad','{}','{}',1220,1220,NULL,1220,NULL,0,'[]')`,
      )).rejects.toThrow(/legacy session tombstone write rejected/i);
      await expect(writer.query(
        `INSERT INTO sessions
          (session_id, tenant_id, user_id, agent_id, agent_version, status, parent_session_id,
           last_seq, fence_token, context_epoch, usage_json, metadata, created_at_ms, updated_at_ms,
           archived_at_ms, deleted_at_ms, purge_after_ms, deletion_generation, auto_approved_tools)
         VALUES ('sess_bad_live_0013','tenant_a','user_a','agent_a',1,'{"type":"idle"}',NULL,
                 1,0,'epoch_bad_live','{}','{}',1230,1230,NULL,NULL,NULL,1,'[]')`,
      )).rejects.toThrow(/legacy session tombstone write rejected/i);

      // Existing legacy rows are precisely what the future worker must move to generation one.
      await writer.query(
        "UPDATE sessions SET deletion_generation=1 WHERE session_id='sess_legacy_idle_0013'",
      );
    } finally {
      await writer?.rollback().catch(() => {});
      await writer?.end().catch(() => {});
      await activator?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("makes an old delete wait for an uncommitted activation and then fail closed", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let writer: Connection | undefined;
    let activator: Connection | undefined;
    try {
      writer = await mysql.createConnection({ uri: url, multipleStatements: true });
      await writer.query(fixtureSql);
      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0014 });
      await upgraded.close();
      activator = await mysql.createConnection(url);

      await activator.beginTransaction();
      await activator.query(
        `UPDATE legacy_tombstone_cutover
            SET control_generation=1, activated_at_ms=1300, actor_key_id='migration-admin',
                evidence_sha256=?
          WHERE singleton_id=1 AND control_generation=0`,
        ["9".repeat(64)],
      );
      const lateLegacyWrite = writer.query(
        "UPDATE sessions SET deleted_at_ms=1310 WHERE session_id='sess_live_0013'",
      );
      expect(await settlesWithin(lateLegacyWrite, 100)).toBe(false);
      await activator.commit();
      await expect(lateLegacyWrite).rejects.toThrow(/legacy session tombstone write rejected/i);

      const [session] = await writer.query<Row[]>(
        "SELECT deleted_at_ms, deletion_generation FROM sessions WHERE session_id='sess_live_0013'",
      );
      expect(session[0]).toMatchObject({ deleted_at_ms: null, deletion_generation: 0 });
    } finally {
      await activator?.rollback().catch(() => {});
      await writer?.end().catch(() => {});
      await activator?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("recovers from partial DDL and marker-loss replay without losing cutover or evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);

      const eventTableIndex = migrationStatements.findIndex((statement) => (
        statement.startsWith("CREATE TABLE IF NOT EXISTS legacy_tombstone_compensation_events")
      ));
      expect(eventTableIndex).toBeGreaterThan(1);
      for (const statement of migrationStatements.slice(0, eventTableIndex)) {
        await conn.query(statement);
      }
      const [partialTables] = await conn.query<Row[]>(
        `SELECT TABLE_NAME AS table_name FROM information_schema.tables
          WHERE table_schema=DATABASE()
            AND table_name LIKE 'legacy_tombstone%'
          ORDER BY table_name`,
      );
      expect(partialTables.map((row) => String(row.table_name))).toEqual([
        "legacy_tombstone_compensation_jobs",
        "legacy_tombstone_cutover",
      ]);

      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0014 });
      await recovered.close();
      await activateCutover(conn, 1_400);
      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
          (job_id, session_id, tenant_id, user_id, source_kind, maintenance_actor_key_id,
           source_deleted_at_ms, source_last_seq, candidate_sha256, status,
           control_generation, available_at_ms, attempts, created_at_ms, updated_at_ms)
         VALUES ('ltc_00000000-0000-4000-8000-000000000004','sess_legacy_idle_0013','tenant_a','user_a','maintenance',
                 'migration-admin',50,1,?,'pending',1,1400,0,1400,1400)`,
        ["1".repeat(64)],
      );
      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_events
          (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
           claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
           before_sha256, after_sha256, emitted_at_ms)
         VALUES ('ltc_00000000-0000-4000-8000-000000000004','sess_legacy_idle_0013',1,
                 'legacy_tombstone/blocked','integrity_conflict','migration-admin',
                 1,50,NULL,NULL,?,NULL,1410)`,
        ["1".repeat(64)],
      );

      await conn.query(
        `ALTER TABLE sessions
           DROP INDEX idx_sessions_legacy_tombstone_candidate,
           ADD UNIQUE KEY idx_sessions_legacy_tombstone_candidate (session_id)`,
      );
      await conn.query(
        `ALTER TABLE legacy_tombstone_compensation_jobs
           DROP INDEX idx_legacy_tombstone_compensation_jobs_claim,
           ADD UNIQUE KEY idx_legacy_tombstone_compensation_jobs_claim (job_id)`,
      );
      await conn.query("DROP TRIGGER trg_sessions_legacy_tombstone_guard_bu");
      await conn.query("DROP TRIGGER trg_legacy_tombstone_compensation_events_bu_guard_a");
      await conn.query("DELETE FROM schema_migrations WHERE name='0014_legacy_tombstone_compensation.sql'");

      const replayed = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0014 });
      await replayed.close();

      const [cutover] = await conn.query<Row[]>("SELECT * FROM legacy_tombstone_cutover");
      expect(cutover).toEqual([expect.objectContaining({
        singleton_id: 1,
        control_generation: 1,
        activated_at_ms: 1400,
        actor_key_id: "migration-admin",
        evidence_sha256: "c".repeat(64),
      })]);
      expect((await tableIndexes(conn, "sessions")).idx_sessions_legacy_tombstone_candidate)
        .toEqual({
          columns: ["deletion_generation", "deleted_at_ms", "session_id"], unique: false,
        });
      expect((await tableIndexes(conn, "legacy_tombstone_compensation_jobs"))
        .idx_legacy_tombstone_compensation_jobs_claim).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "job_id"], unique: false,
      });
      await expectFinalTriggers(conn);
      await expectResultAppendOnly(conn, "ltc_00000000-0000-4000-8000-000000000004");
      await expect(conn.query(
        "UPDATE sessions SET deleted_at_ms=1500 WHERE session_id='sess_live_0013'",
      )).rejects.toThrow(/legacy session tombstone write rejected/i);
      const [evidence] = await conn.query<Row[]>(
        `SELECT job_id, session_id, control_generation, event_type, reason_code, claim_attempt,
                before_sha256, after_sha256, emitted_at_ms
           FROM legacy_tombstone_compensation_events`,
      );
      expect(evidence).toEqual([expect.objectContaining({
        job_id: "ltc_00000000-0000-4000-8000-000000000004",
        session_id: "sess_legacy_idle_0013",
        control_generation: 1,
        event_type: "legacy_tombstone/blocked",
        reason_code: "integrity_conflict",
        claim_attempt: 1,
        before_sha256: "1".repeat(64),
        after_sha256: null,
        emitted_at_ms: 1410,
      })]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0014_legacy_tombstone_compensation.sql'",
      );
      expect(Number(marker[0]?.count)).toBe(1);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);
});
