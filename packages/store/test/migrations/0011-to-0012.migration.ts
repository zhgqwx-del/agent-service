import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  newErasureRequestId,
  userErasureRequestHash,
} from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0011.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0012_erasure_job_queue.sql");
const MIGRATION_0013_PATH = resolve(HERE, "../../migrations/0013_erasure_job_control.sql");

type Row = RowDataPacket;
type HistoricalStatus =
  | "gated"
  | "draining"
  | "tombstoning"
  | "reconciling_usage"
  | "awaiting_purge_policy"
  | "purging"
  | "blocked"
  | "completed";

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

async function queueColumnDefinitions(conn: Connection): Promise<Array<{
  name: string;
  dataType: string;
  columnType: string;
  nullable: string;
  defaultValue: string | null;
  collation: string | null;
}>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
            COLLATION_NAME AS collation_name
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name='erasure_requests'
        AND column_name IN
          ('available_at_ms','attempts','claim_token','lease_until_ms','last_error_code',
           'policy_version','policy_hash')
      ORDER BY ordinal_position`,
  );
  return rows.map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type),
    columnType: String(row.column_type),
    nullable: String(row.is_nullable),
    defaultValue: row.column_default === null ? null : String(row.column_default),
    collation: row.collation_name === null ? null : String(row.collation_name),
  }));
}

async function claimIndex(conn: Connection): Promise<{
  columns: string[];
  unique: boolean;
  indexType: string | null;
  directions: string[];
}> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique,
            INDEX_TYPE AS index_type, COLLATION AS index_direction
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name='erasure_requests'
        AND index_name='idx_erasure_requests_claim'
      ORDER BY seq_in_index`,
  );
  return {
    columns: rows.map((row) => String(row.column_name)),
    unique: rows.length > 0 && rows.every((row) => Number(row.non_unique) === 0),
    indexType: rows[0] ? String(rows[0].index_type) : null,
    directions: rows.map((row) => String(row.index_direction)),
  };
}

async function triggerDefinition(conn: Connection): Promise<Row[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT ACTION_TIMING AS action_timing, EVENT_MANIPULATION AS event_manipulation,
            EVENT_OBJECT_TABLE AS event_object_table
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND trigger_name='trg_erasure_requests_job_bi'`,
  );
  return rows;
}

async function insertLegacyRequest(
  conn: Connection,
  status: HistoricalStatus,
  updatedAtMs: number,
  options: { legalHoldAtMs?: number } = {},
): Promise<{ requestId: string; tenantId: string; userId: string }> {
  const requestId = newErasureRequestId();
  const suffix = requestId.replaceAll("-", "").slice(-12);
  const tenantId = `tenant_${suffix}`;
  const userId = `user_${suffix}`;
  const userState = status === "completed" ? "erased" : "deleting";
  const activeRequestId = status === "completed" ? null : requestId;
  await conn.query(
    `INSERT INTO subject_lifecycle
       (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
        legal_hold_at_ms, created_at_ms, updated_at_ms)
     VALUES
       (?, 'tenant', ?, 'active', 0, NULL, NULL, ?, ?),
       (?, 'user', ?, ?, 1, ?, ?, ?, ?)`,
    [
      tenantId, tenantId, updatedAtMs, updatedAtMs,
      tenantId, userId, userState, activeRequestId,
      options.legalHoldAtMs ?? null, updatedAtMs, updatedAtMs,
    ],
  );
  await conn.query(
    `INSERT INTO erasure_requests
       (request_id, tenant_id, subject_kind, subject_id, generation, status,
        requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
        updated_at_ms, completed_at_ms, counts_json, checksum)
     VALUES (?, ?, 'user', ?, 1, ?, 'legacy-admin', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      tenantId,
      userId,
      status,
      `legacy-${status}-${suffix}`,
      userErasureRequestHash(tenantId, userId),
      updatedAtMs,
      updatedAtMs,
      updatedAtMs,
      status === "completed" ? updatedAtMs : null,
      status === "completed" ? JSON.stringify({ sessions: 1 }) : null,
      status === "completed" ? "b".repeat(64) : null,
    ],
  );
  await conn.query(
    `INSERT INTO erasure_audit_events (request_id, seq, event_type, payload, emitted_at_ms)
     VALUES (?, 1, 'erasure/gated', ?, ?)`,
    [requestId, JSON.stringify({ status: "gated", subjectKind: "user", generation: 1 }), updatedAtMs],
  );
  return { requestId, tenantId, userId };
}

async function insertTriggerProbe(
  conn: Connection,
  status: HistoricalStatus,
  updatedAtMs: number,
  availableAtMs?: number,
): Promise<string> {
  const requestId = newErasureRequestId();
  const suffix = requestId.replaceAll("-", "").slice(-12);
  const columns = availableAtMs === undefined ? "" : ", available_at_ms";
  const values = availableAtMs === undefined ? "" : ", ?";
  await conn.query(
    `INSERT INTO erasure_requests
       (request_id, tenant_id, subject_kind, subject_id, generation, status,
        requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
        updated_at_ms, completed_at_ms, counts_json, checksum${columns})
     VALUES (?, ?, 'user', ?, 1, ?, 'trigger-probe', ?, ?, ?, ?, ?, ?, ?, ?${values})`,
    [
      requestId,
      `tenant_probe_${suffix}`,
      `user_probe_${suffix}`,
      status,
      `trigger-probe-${suffix}`,
      "d".repeat(64),
      updatedAtMs,
      updatedAtMs,
      updatedAtMs,
      status === "completed" ? updatedAtMs : null,
      status === "completed" ? JSON.stringify({ sessions: 0 }) : null,
      status === "completed" ? "e".repeat(64) : null,
      ...(availableAtMs === undefined ? [] : [availableAtMs]),
    ],
  );
  return requestId;
}

describe("real MySQL historical upgrade: 0011 -> 0012", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0012: string;
  let only0013: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.length).toBeGreaterThan(30);
    only0012 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0012-"));
    await copyFile(MIGRATION_PATH, join(only0012, "0012_erasure_job_queue.sql"));
    only0013 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0013-"));
    await copyFile(MIGRATION_0013_PATH, join(only0013, "0013_erasure_job_control.sql"));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0012, { recursive: true, force: true });
    await rm(only0013, { recursive: true, force: true });
  });

  it("upgrades a frozen 0011 gated request and normalizes synthetic SQL-only state shapes", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let upgraded: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const frozen0011Statuses: HistoricalStatus[] = ["gated"];
      // Frozen 0011 only admitted `gated`; it had no worker that could produce later states. These
      // synthetic rows deliberately exercise 0012's SQL normalization matrix only. They are not
      // presented to the current runtime validator because their single gated audit is not a
      // fabricated historical transition chain.
      const syntheticShapeOnlyStatuses: HistoricalStatus[] = [
        "draining",
        "tombstoning",
        "reconciling_usage",
        "awaiting_purge_policy",
        "purging",
        "blocked",
        "completed",
      ];
      const statuses = [...frozen0011Statuses, ...syntheticShapeOnlyStatuses];
      const inserted = new Map<HistoricalStatus, Awaited<ReturnType<typeof insertLegacyRequest>>>();
      for (const [index, status] of statuses.entries()) {
        inserted.set(status, await insertLegacyRequest(
          conn,
          status,
          100 + index,
          status === "gated" ? { legalHoldAtMs: 99 } : {},
        ));
      }
      await conn.query(
        `INSERT INTO lifecycle_outbox
           (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
         VALUES ('session.purge', 'sess_legacy', 4, '{"sessionId":"sess_legacy"}', NULL, 0, 200)`,
      );

      upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0012 });

      expect((await tableColumns(conn, "erasure_requests")).slice(-7)).toEqual([
        "available_at_ms",
        "attempts",
        "claim_token",
        "lease_until_ms",
        "last_error_code",
        "policy_version",
        "policy_hash",
      ]);
      expect(await queueColumnDefinitions(conn)).toEqual([
        {
          name: "available_at_ms", dataType: "bigint", columnType: "bigint", nullable: "YES",
          defaultValue: null, collation: null,
        },
        {
          name: "attempts", dataType: "int", columnType: "int unsigned", nullable: "NO",
          defaultValue: "0", collation: null,
        },
        {
          name: "claim_token", dataType: "varchar", columnType: "varchar(64)", nullable: "YES",
          defaultValue: null, collation: "utf8mb4_0900_as_cs",
        },
        {
          name: "lease_until_ms", dataType: "bigint", columnType: "bigint", nullable: "YES",
          defaultValue: null, collation: null,
        },
        {
          name: "last_error_code", dataType: "varchar", columnType: "varchar(32)", nullable: "YES",
          defaultValue: null, collation: "utf8mb4_0900_as_cs",
        },
        {
          name: "policy_version", dataType: "varchar", columnType: "varchar(64)", nullable: "YES",
          defaultValue: null, collation: "utf8mb4_0900_as_cs",
        },
        {
          name: "policy_hash", dataType: "char", columnType: "char(64)", nullable: "YES",
          defaultValue: null, collation: "utf8mb4_0900_as_cs",
        },
      ]);
      expect(await claimIndex(conn)).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
        directions: ["A", "A", "A", "A"],
      });
      expect(await triggerDefinition(conn)).toEqual([{
        action_timing: "BEFORE",
        event_manipulation: "INSERT",
        event_object_table: "erasure_requests",
      }]);
      const [rows] = await conn.query<Row[]>(
        `SELECT status, updated_at_ms, available_at_ms, attempts, claim_token, lease_until_ms,
                last_error_code
           FROM erasure_requests`,
      );
      const byStatus = new Map(rows.map((row) => [String(row.status), row]));
      for (const status of ["gated", "draining", "tombstoning", "reconciling_usage", "purging"]) {
        expect(Number(byStatus.get(status)?.available_at_ms)).toBe(Number(byStatus.get(status)?.updated_at_ms));
      }
      for (const status of ["awaiting_purge_policy", "blocked", "completed"]) {
        expect(byStatus.get(status)?.available_at_ms).toBeNull();
        expect(byStatus.get(status)?.claim_token).toBeNull();
        expect(byStatus.get(status)?.lease_until_ms).toBeNull();
      }
      expect(byStatus.get("blocked")?.last_error_code).toBe("legacy_blocked");
      expect(rows.every((row) => Number(row.attempts) === 0)).toBe(true);

      const gated = inserted.get("gated")!;
      const [preserved] = await conn.query<Row[]>(
        `SELECT legal_hold_at_ms, state, generation, active_request_id
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=?`,
        [gated.tenantId, gated.userId],
      );
      expect(preserved[0]).toMatchObject({
        legal_hold_at_ms: 99,
        state: "deleting",
        generation: 1,
        active_request_id: gated.requestId,
      });
      const [purge] = await conn.query<Row[]>(
        "SELECT available_at_ms, claim_token, lease_until_ms FROM lifecycle_outbox WHERE topic='session.purge'",
      );
      expect(purge[0]).toMatchObject({ available_at_ms: null, claim_token: null, lease_until_ms: null });

      // The checks above prove the frozen 0011 -> 0012 result. Apply the next expand migration
      // before loading that row through the current runtime; new binaries require the additive
      // quarantine columns even though this test remains focused on 0012 normalization.
      await upgraded.close();
      upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      // Prove that the historical row remains consumable after the forward-compatible expand.
      // The earliest gated row is the only selected row.
      const runtimeClaims = await upgraded.claimErasureJobs({
        nowMs: 100,
        limit: 1,
        leaseMs: 20,
        claimToken: "migration-worker",
      });
      expect(runtimeClaims).toEqual([expect.objectContaining({
        requestId: gated.requestId,
        attempts: 1,
        claimToken: "migration-worker",
        leaseUntilMs: 120,
      })]);
      await upgraded.close();
      upgraded = undefined;

      // Exercise trigger behavior, including a legacy writer that omits queue columns, every
      // queue/terminal status branch, and preservation of an explicit current-writer due time.
      const triggerStatuses: HistoricalStatus[] = [
        "gated", "draining", "tombstoning", "reconciling_usage",
        "awaiting_purge_policy", "purging", "blocked", "completed",
      ];
      const triggerProbes = new Map<HistoricalStatus, { requestId: string; updatedAtMs: number }>();
      for (const [index, status] of triggerStatuses.entries()) {
        const updatedAtMs = 300 + index;
        triggerProbes.set(status, {
          requestId: await insertTriggerProbe(conn, status, updatedAtMs),
          updatedAtMs,
        });
      }
      const explicitActive = await insertTriggerProbe(conn, "gated", 400, 900);
      const explicitTerminal = await insertTriggerProbe(conn, "completed", 401, 901);
      const [triggeredRows] = await conn.query<Row[]>(
        `SELECT request_id, status, updated_at_ms, available_at_ms, attempts
           FROM erasure_requests
          WHERE requested_by_key_id='trigger-probe'`,
      );
      const triggeredById = new Map(triggeredRows.map((row) => [String(row.request_id), row]));
      for (const status of ["gated", "draining", "tombstoning", "reconciling_usage", "purging"] as const) {
        const probe = triggerProbes.get(status)!;
        expect(triggeredById.get(probe.requestId)).toMatchObject({
          status,
          updated_at_ms: probe.updatedAtMs,
          available_at_ms: probe.updatedAtMs,
          attempts: 0,
        });
      }
      for (const status of ["awaiting_purge_policy", "blocked", "completed"] as const) {
        const probe = triggerProbes.get(status)!;
        expect(triggeredById.get(probe.requestId)).toMatchObject({
          status,
          updated_at_ms: probe.updatedAtMs,
          available_at_ms: null,
          attempts: 0,
        });
      }
      expect(triggeredById.get(explicitActive)).toMatchObject({ available_at_ms: 900, attempts: 0 });
      expect(triggeredById.get(explicitTerminal)).toMatchObject({ available_at_ms: null, attempts: 0 });

      // A normal restart sees the marker and leaves the historical rows untouched.
      const restarted = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0012 });
      await restarted.close();
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0012_erasure_job_queue.sql'",
      );
      expect(Number(markers[0]?.count)).toBe(1);
    } finally {
      await upgraded?.close().catch(() => {});
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("converges after partial DDL and marker-loss replay without stealing retry or lease state", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);

      // Model MySQL auto-committing every ADD COLUMN before the process exits, but before the
      // compatibility trigger/backfill and schema marker are durable.
      const beforeIndex = migrationStatements.findIndex((statement) => (
        statement.startsWith("SET @erasure_claim_columns")
      ));
      expect(beforeIndex).toBeGreaterThan(0);
      for (const statement of migrationStatements.slice(0, beforeIndex)) await conn.query(statement);
      expect((await tableColumns(conn, "erasure_requests")).slice(-7)).toEqual([
        "available_at_ms", "attempts", "claim_token", "lease_until_ms", "last_error_code",
        "policy_version", "policy_hash",
      ]);

      const gap = await insertLegacyRequest(conn, "gated", 500);
      const retry = await insertLegacyRequest(conn, "gated", 510);
      const live = await insertLegacyRequest(conn, "gated", 520);
      const terminal = await insertLegacyRequest(conn, "awaiting_purge_policy", 530);
      const partial = await insertLegacyRequest(conn, "gated", 540);
      await conn.query(
        `UPDATE erasure_requests
            SET available_at_ms=900, last_error_code='owner_unavailable',
                policy_version='policy-v1', policy_hash=?
          WHERE request_id=?`,
        ["c".repeat(64), retry.requestId],
      );
      await conn.query(
        `UPDATE erasure_requests
            SET available_at_ms=520, attempts=7, claim_token='live-worker', lease_until_ms=880
          WHERE request_id=?`,
        [live.requestId],
      );
      await conn.query(
        `UPDATE erasure_requests
            SET available_at_ms=530, attempts=4, claim_token='unsafe-terminal', lease_until_ms=900
          WHERE request_id=?`,
        [terminal.requestId],
      );
      await conn.query(
        `UPDATE erasure_requests
            SET available_at_ms=540, attempts=2, claim_token='half-claim', lease_until_ms=NULL
          WHERE request_id=?`,
        [partial.requestId],
      );
      await conn.query(
        "ALTER TABLE erasure_requests ADD UNIQUE KEY idx_erasure_requests_claim (request_id)",
      );

      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0012 });
      await recovered.close();
      const [firstPass] = await conn.query<Row[]>(
        `SELECT request_id, available_at_ms, attempts, claim_token, lease_until_ms,
                last_error_code, policy_version, policy_hash
           FROM erasure_requests`,
      );
      const firstById = new Map(firstPass.map((row) => [String(row.request_id), row]));
      expect(firstById.get(gap.requestId)).toMatchObject({ available_at_ms: 500, attempts: 0 });
      expect(firstById.get(retry.requestId)).toMatchObject({
        available_at_ms: 900,
        last_error_code: "owner_unavailable",
        policy_version: "policy-v1",
        policy_hash: "c".repeat(64),
      });
      expect(firstById.get(live.requestId)).toMatchObject({
        available_at_ms: 520,
        attempts: 7,
        claim_token: "live-worker",
        lease_until_ms: 880,
      });
      expect(firstById.get(terminal.requestId)).toMatchObject({
        available_at_ms: null,
        attempts: 4,
        claim_token: null,
        lease_until_ms: null,
      });
      expect(firstById.get(partial.requestId)).toMatchObject({
        available_at_ms: 540,
        attempts: 2,
        claim_token: null,
        lease_until_ms: null,
      });
      expect(await claimIndex(conn)).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
        directions: ["A", "A", "A", "A"],
      });

      // Lose the marker and trigger, then allow another drained 0011 writer to insert in that gap.
      // Replay must backfill only the missing due time while preserving future retry/live authority.
      await conn.query("DROP TRIGGER trg_erasure_requests_job_bi");
      const replayGap = await insertLegacyRequest(conn, "gated", 550);
      await conn.query(
        "UPDATE erasure_requests SET available_at_ms=1900 WHERE request_id=?",
        [retry.requestId],
      );
      await conn.query(
        `ALTER TABLE erasure_requests
           DROP INDEX idx_erasure_requests_claim,
           ADD UNIQUE KEY idx_erasure_requests_claim (request_id)`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name='0012_erasure_job_queue.sql'");

      const replayed = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0012 });
      await replayed.close();
      const [afterReplay] = await conn.query<Row[]>(
        `SELECT request_id, available_at_ms, attempts, claim_token, lease_until_ms,
                last_error_code, policy_version, policy_hash
           FROM erasure_requests
          WHERE request_id IN (?,?,?)`,
        [replayGap.requestId, retry.requestId, live.requestId],
      );
      const replayById = new Map(afterReplay.map((row) => [String(row.request_id), row]));
      expect(replayById.get(replayGap.requestId)).toMatchObject({ available_at_ms: 550, attempts: 0 });
      expect(replayById.get(retry.requestId)).toMatchObject({
        available_at_ms: 1900,
        last_error_code: "owner_unavailable",
        policy_version: "policy-v1",
        policy_hash: "c".repeat(64),
      });
      expect(replayById.get(live.requestId)).toMatchObject({
        available_at_ms: 520,
        attempts: 7,
        claim_token: "live-worker",
        lease_until_ms: 880,
      });
      expect(await claimIndex(conn)).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
        directions: ["A", "A", "A", "A"],
      });

      const postReplay = await insertLegacyRequest(conn, "gated", 560);
      const [triggered] = await conn.query<Row[]>(
        "SELECT available_at_ms, attempts FROM erasure_requests WHERE request_id=?",
        [postReplay.requestId],
      );
      expect(triggered[0]).toMatchObject({ available_at_ms: 560, attempts: 0 });
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0012_erasure_job_queue.sql'",
      );
      expect(Number(markers[0]?.count)).toBe(1);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);
});
