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
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0012.sql");
const CONFLICT_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0013-control-generation-conflict.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0013_erasure_job_control.sql");
const CONTROL_UPDATE_TRIGGERS = [
  "trg_erasure_job_control_events_bu",
  "trg_erasure_job_control_events_bu_guard_a",
  "trg_erasure_job_control_events_bu_guard_b",
] as const;
const CONTROL_DELETE_TRIGGERS = [
  "trg_erasure_job_control_events_bd",
  "trg_erasure_job_control_events_bd_guard_a",
  "trg_erasure_job_control_events_bd_guard_b",
] as const;
const CONTROL_TRIGGERS = [...CONTROL_UPDATE_TRIGGERS, ...CONTROL_DELETE_TRIGGERS] as const;
const TERMINAL_INCIDENT_UPDATE_TRIGGERS = [
  "trg_erasure_job_terminal_incidents_bu",
  "trg_erasure_job_terminal_incidents_bu_guard_a",
  "trg_erasure_job_terminal_incidents_bu_guard_b",
] as const;
const TERMINAL_INCIDENT_DELETE_TRIGGERS = [
  "trg_erasure_job_terminal_incidents_bd",
  "trg_erasure_job_terminal_incidents_bd_guard_a",
  "trg_erasure_job_terminal_incidents_bd_guard_b",
] as const;
const TERMINAL_INCIDENT_TRIGGERS = [
  ...TERMINAL_INCIDENT_UPDATE_TRIGGERS,
  ...TERMINAL_INCIDENT_DELETE_TRIGGERS,
] as const;

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

interface RequestSeed {
  status: HistoricalStatus;
  updatedAtMs: number;
  availableAtMs?: number | null;
  attempts?: number;
  claimToken?: string | null;
  leaseUntilMs?: number | null;
  lastErrorCode?: string | null;
  policyVersion?: string | null;
  policyHash?: string | null;
}

interface ColumnDefinition {
  name: string;
  dataType: string;
  columnType: string;
  nullable: string;
  defaultValue: string | null;
  collation: string | null;
  extra: string;
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

async function columnDefinitions(
  conn: Connection,
  table: string,
  columns?: string[],
): Promise<ColumnDefinition[]> {
  const params: string[] = [table];
  const columnFilter = columns && columns.length > 0
    ? ` AND column_name IN (${columns.map(() => "?").join(",")})`
    : "";
  if (columns) params.push(...columns);
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
            COLLATION_NAME AS collation_name, EXTRA AS extra
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=?${columnFilter}
      ORDER BY ordinal_position`,
    params,
  );
  return rows.map((row) => ({
    name: String(row.column_name),
    dataType: String(row.data_type),
    columnType: String(row.column_type),
    nullable: String(row.is_nullable),
    defaultValue: row.column_default === null ? null : String(row.column_default),
    collation: row.collation_name === null ? null : String(row.collation_name),
    extra: String(row.extra),
  }));
}

async function indexDefinition(conn: Connection, name: string): Promise<{
  columns: string[];
  unique: boolean;
  indexType: string | null;
}> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, INDEX_TYPE AS index_type
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name='erasure_requests' AND index_name=?
      ORDER BY seq_in_index`,
    [name],
  );
  return {
    columns: rows.map((row) => String(row.column_name)),
    unique: rows.length > 0 && rows.every((row) => Number(row.non_unique) === 0),
    indexType: rows[0] ? String(rows[0].index_type) : null,
  };
}

async function controlIndexes(conn: Connection): Promise<Record<string, { columns: string[]; unique: boolean }>> {
  return tableIndexes(conn, "erasure_job_control_events");
}

async function terminalIncidentIndexes(
  conn: Connection,
): Promise<Record<string, { columns: string[]; unique: boolean }>> {
  return tableIndexes(conn, "erasure_job_terminal_incidents");
}

async function tableIndexes(
  conn: Connection,
  table: string,
): Promise<Record<string, { columns: string[]; unique: boolean }>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
            NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY index_name, seq_in_index`,
    [table],
  );
  const result: Record<string, { columns: string[]; unique: boolean }> = {};
  for (const row of rows) {
    const name = String(row.index_name);
    const entry = result[name] ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(String(row.column_name));
    result[name] = entry;
  }
  return result;
}

async function controlTriggers(conn: Connection): Promise<Array<{
  name: string;
  event: string;
  timing: string;
  orientation: string;
  statement: string;
}>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event_manipulation,
            ACTION_TIMING AS action_timing, ACTION_ORIENTATION AS action_orientation,
            ACTION_STATEMENT AS action_statement
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table='erasure_job_control_events'
      ORDER BY trigger_name`,
  );
  return rows.map((row) => ({
    name: String(row.trigger_name),
    event: String(row.event_manipulation),
    timing: String(row.action_timing),
    orientation: String(row.action_orientation),
    statement: String(row.action_statement),
  }));
}

async function terminalIncidentTriggers(conn: Connection): Promise<Array<{
  name: string;
  event: string;
  timing: string;
  orientation: string;
  statement: string;
}>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event_manipulation,
            ACTION_TIMING AS action_timing, ACTION_ORIENTATION AS action_orientation,
            ACTION_STATEMENT AS action_statement
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table='erasure_job_terminal_incidents'
      ORDER BY trigger_name`,
  );
  return rows.map((row) => ({
    name: String(row.trigger_name),
    event: String(row.event_manipulation),
    timing: String(row.action_timing),
    orientation: String(row.action_orientation),
    statement: String(row.action_statement),
  }));
}

async function expectCompleteAppendOnlyTriggers(conn: Connection): Promise<void> {
  const triggers = await controlTriggers(conn);
  expect(triggers.map((trigger) => trigger.name)).toEqual([...CONTROL_TRIGGERS].sort());
  for (const trigger of triggers) {
    expect(trigger.timing).toBe("BEFORE");
    expect(trigger.orientation).toBe("ROW");
    expect(trigger.event).toBe(trigger.name.includes("_bu") ? "UPDATE" : "DELETE");
    expect(trigger.statement).toMatch(
      /SIGNAL\s+SQLSTATE(?:\s+VALUE)?\s+'45000'.*erasure job control events are append-only/is,
    );
  }
}

async function expectCompleteTerminalIncidentTriggers(conn: Connection): Promise<void> {
  const triggers = await terminalIncidentTriggers(conn);
  expect(triggers.map((trigger) => trigger.name)).toEqual([...TERMINAL_INCIDENT_TRIGGERS].sort());
  for (const trigger of triggers) {
    expect(trigger.timing).toBe("BEFORE");
    expect(trigger.orientation).toBe("ROW");
    expect(trigger.event).toBe(trigger.name.includes("_bu") ? "UPDATE" : "DELETE");
    expect(trigger.statement).toMatch(
      /SIGNAL\s+SQLSTATE(?:\s+VALUE)?\s+'45000'.*erasure job terminal incidents are append-only/is,
    );
  }
}

async function expectControlEvidenceIsAppendOnly(conn: Connection, requestId: string): Promise<void> {
  await expect(conn.query(
    "UPDATE erasure_job_control_events SET emitted_at_ms=emitted_at_ms WHERE request_id=?",
    [requestId],
  )).rejects.toThrow(/append-only/i);
  await expect(conn.query(
    "DELETE FROM erasure_job_control_events WHERE request_id=?",
    [requestId],
  )).rejects.toThrow(/append-only/i);
}

async function expectTerminalIncidentIsAppendOnly(conn: Connection, requestId: string): Promise<void> {
  await expect(conn.query(
    "UPDATE erasure_job_terminal_incidents SET emitted_at_ms=emitted_at_ms WHERE request_id=?",
    [requestId],
  )).rejects.toThrow(/append-only/i);
  await expect(conn.query(
    "DELETE FROM erasure_job_terminal_incidents WHERE request_id=?",
    [requestId],
  )).rejects.toThrow(/append-only/i);
}

async function insertHistoricalRequest(conn: Connection, seed: RequestSeed): Promise<string> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const requestId = `erase_${suffix}`;
  const tenantId = `tenant_${suffix}`;
  const userId = `user_${suffix}`;
  const completed = seed.status === "completed";
  await conn.query(
    `INSERT INTO subject_lifecycle
       (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
        legal_hold_at_ms, created_at_ms, updated_at_ms)
     VALUES
       (?, 'tenant', ?, 'active', 0, NULL, NULL, ?, ?),
       (?, 'user', ?, ?, 1, ?, NULL, ?, ?)`,
    [
      tenantId, tenantId, seed.updatedAtMs, seed.updatedAtMs,
      tenantId, userId, completed ? "erased" : "deleting", completed ? null : requestId,
      seed.updatedAtMs, seed.updatedAtMs,
    ],
  );
  await conn.query(
    `INSERT INTO erasure_requests
       (request_id, tenant_id, subject_kind, subject_id, generation, status,
        requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
        updated_at_ms, completed_at_ms, counts_json, checksum, available_at_ms, attempts,
        claim_token, lease_until_ms, last_error_code, policy_version, policy_hash)
     VALUES (?, ?, 'user', ?, 1, ?, 'historical-admin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestId,
      tenantId,
      userId,
      seed.status,
      `idem-${suffix}`,
      "a".repeat(64),
      seed.updatedAtMs,
      seed.updatedAtMs,
      seed.updatedAtMs,
      completed ? seed.updatedAtMs : null,
      completed ? JSON.stringify({ sessions: 2 }) : null,
      completed ? "b".repeat(64) : null,
      seed.availableAtMs === undefined ? seed.updatedAtMs : seed.availableAtMs,
      seed.attempts ?? 0,
      seed.claimToken ?? null,
      seed.leaseUntilMs ?? null,
      seed.lastErrorCode ?? null,
      seed.policyVersion ?? null,
      seed.policyHash ?? null,
    ],
  );
  await conn.query(
    `INSERT INTO erasure_audit_events (request_id, seq, event_type, payload, emitted_at_ms)
     VALUES (?, 1, 'erasure/gated', ?, ?)`,
    [requestId, JSON.stringify({ status: "gated", subjectKind: "user", generation: 1 }), seed.updatedAtMs],
  );
  return requestId;
}

async function requestControlSnapshot(conn: Connection, requestIds: string[]): Promise<Record<string, Row>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT request_id, status, available_at_ms, attempts, claim_token, lease_until_ms,
            last_error_code, policy_version, policy_hash, completed_at_ms, counts_json, checksum
       FROM erasure_requests
      WHERE request_id IN (${requestIds.map(() => "?").join(",")})
      ORDER BY request_id`,
    requestIds,
  );
  return Object.fromEntries(rows.map((row) => [String(row.request_id), row]));
}

describe("real MySQL historical upgrade: 0012 -> 0013", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let conflictFixtureSql: string;
  let migrationStatements: string[];
  let only0013: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    conflictFixtureSql = await readFile(CONFLICT_FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.length).toBeGreaterThan(35);
    only0013 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0013-"));
    await copyFile(MIGRATION_PATH, join(only0013, "0013_erasure_job_control.sql"));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0013, { recursive: true, force: true });
  });

  it("adds the quarantine/control/terminal-incident schema without rewriting 0012 state", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      expect(await columnDefinitions(conn, "erasure_requests", [
        "control_generation",
        "quarantined_at_ms",
        "quarantine_reason_code",
        "quarantine_evidence_sha256",
      ])).toEqual([]);
      const [pre0013Tables] = await conn.query<Row[]>(
        `SELECT TABLE_NAME AS table_name FROM information_schema.tables
          WHERE table_schema=DATABASE()
            AND table_name IN ('erasure_job_control_events','erasure_job_terminal_incidents')`,
      );
      expect(pre0013Tables).toEqual([]);
      const policyHash = "c".repeat(64);
      const requestIds = [
        await insertHistoricalRequest(conn, {
          status: "draining", updatedAtMs: 100, availableAtMs: 900, attempts: 2,
          lastErrorCode: "owner_unavailable", policyVersion: "policy-v1", policyHash,
        }),
        await insertHistoricalRequest(conn, {
          status: "tombstoning", updatedAtMs: 110, availableAtMs: 110, attempts: 7,
          claimToken: "live-worker", leaseUntilMs: 880, policyVersion: "policy-v1", policyHash,
        }),
        await insertHistoricalRequest(conn, {
          status: "purging", updatedAtMs: 120, availableAtMs: 120, attempts: 3,
          claimToken: "legacy-purge-worker", leaseUntilMs: 920,
          policyVersion: "policy-v1", policyHash,
        }),
        await insertHistoricalRequest(conn, {
          status: "blocked", updatedAtMs: 130, availableAtMs: null, attempts: 4,
          lastErrorCode: "integrity_conflict", policyVersion: "policy-v1", policyHash,
        }),
        await insertHistoricalRequest(conn, {
          status: "completed", updatedAtMs: 140, availableAtMs: null, attempts: 5,
          policyVersion: "policy-v1", policyHash,
        }),
      ];
      await conn.query(
        `INSERT INTO lifecycle_outbox
           (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
         VALUES ('session.purge', 'sess_frozen_0012', 7, '{"sessionId":"sess_frozen_0012"}', NULL, 0, 150)`,
      );
      const before = await requestControlSnapshot(conn, requestIds);

      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await upgraded.close();

      expect(await columnDefinitions(conn, "erasure_requests", [
        "control_generation",
        "quarantined_at_ms",
        "quarantine_reason_code",
        "quarantine_evidence_sha256",
      ])).toEqual([
        {
          name: "control_generation", dataType: "bigint", columnType: "bigint unsigned",
          nullable: "NO", defaultValue: "0", collation: null, extra: "",
        },
        {
          name: "quarantined_at_ms", dataType: "bigint", columnType: "bigint",
          nullable: "YES", defaultValue: null, collation: null, extra: "",
        },
        {
          name: "quarantine_reason_code", dataType: "varchar", columnType: "varchar(32)",
          nullable: "YES", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "quarantine_evidence_sha256", dataType: "char", columnType: "char(64)",
          nullable: "YES", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
      ]);
      expect(await columnDefinitions(conn, "erasure_job_control_events")).toEqual([
        {
          name: "control_event_id", dataType: "bigint", columnType: "bigint unsigned",
          nullable: "NO", defaultValue: null, collation: null, extra: "auto_increment",
        },
        {
          name: "request_id", dataType: "varchar", columnType: "varchar(64)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "control_generation", dataType: "bigint", columnType: "bigint unsigned",
          nullable: "NO", defaultValue: null, collation: null, extra: "",
        },
        {
          name: "event_type", dataType: "varchar", columnType: "varchar(64)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "phase", dataType: "varchar", columnType: "varchar(32)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "reason_code", dataType: "varchar", columnType: "varchar(32)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "action_code", dataType: "varchar", columnType: "varchar(32)",
          nullable: "YES", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "actor_key_id", dataType: "varchar", columnType: "varchar(64)",
          nullable: "YES", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "before_sha256", dataType: "char", columnType: "char(64)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "after_sha256", dataType: "char", columnType: "char(64)",
          nullable: "YES", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "emitted_at_ms", dataType: "bigint", columnType: "bigint",
          nullable: "NO", defaultValue: null, collation: null, extra: "",
        },
      ]);
      expect(await columnDefinitions(conn, "erasure_job_terminal_incidents")).toEqual([
        {
          name: "terminal_incident_id", dataType: "bigint", columnType: "bigint unsigned",
          nullable: "NO", defaultValue: null, collation: null, extra: "auto_increment",
        },
        {
          name: "request_id", dataType: "varchar", columnType: "varchar(64)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "raw_control_generation", dataType: "bigint", columnType: "bigint unsigned",
          nullable: "NO", defaultValue: null, collation: null, extra: "",
        },
        {
          name: "reason_code", dataType: "varchar", columnType: "varchar(32)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "evidence_sha256", dataType: "char", columnType: "char(64)",
          nullable: "NO", defaultValue: null, collation: "utf8mb4_0900_as_cs", extra: "",
        },
        {
          name: "emitted_at_ms", dataType: "bigint", columnType: "bigint",
          nullable: "NO", defaultValue: null, collation: null, extra: "",
        },
      ]);
      const [controlTable] = await conn.query<Row[]>(
        `SELECT TABLE_COLLATION AS table_collation, ENGINE AS engine
           FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_name='erasure_job_control_events'`,
      );
      expect(controlTable).toEqual([expect.objectContaining({
        table_collation: "utf8mb4_0900_as_cs",
        engine: "InnoDB",
      })]);
      const [terminalIncidentTable] = await conn.query<Row[]>(
        `SELECT TABLE_COLLATION AS table_collation, ENGINE AS engine
           FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_name='erasure_job_terminal_incidents'`,
      );
      expect(terminalIncidentTable).toEqual([expect.objectContaining({
        table_collation: "utf8mb4_0900_as_cs",
        engine: "InnoDB",
      })]);
      expect(await controlIndexes(conn)).toEqual({
        PRIMARY: { columns: ["control_event_id"], unique: true },
        idx_erasure_job_control_events_emitted: {
          columns: ["event_type", "emitted_at_ms", "control_event_id"], unique: false,
        },
        idx_erasure_job_control_events_request: {
          columns: ["request_id", "control_event_id"], unique: false,
        },
        uk_erasure_job_control_event_generation: {
          columns: ["request_id", "control_generation"], unique: true,
        },
      });
      expect(await terminalIncidentIndexes(conn)).toEqual({
        PRIMARY: { columns: ["terminal_incident_id"], unique: true },
        idx_erasure_job_terminal_incidents_emitted: {
          columns: ["reason_code", "emitted_at_ms", "terminal_incident_id"], unique: false,
        },
        uk_erasure_job_terminal_incident_request: {
          columns: ["request_id"], unique: true,
        },
      });
      await expectCompleteAppendOnlyTriggers(conn);
      await expectCompleteTerminalIncidentTriggers(conn);
      expect(await indexDefinition(conn, "idx_erasure_requests_claim")).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
      });
      expect(await indexDefinition(conn, "idx_erasure_requests_claim_v2")).toEqual({
        columns: ["quarantined_at_ms", "status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
      });

      expect(await requestControlSnapshot(conn, requestIds)).toEqual(before);
      const [newControl] = await conn.query<Row[]>(
        `SELECT control_generation, quarantined_at_ms, quarantine_reason_code,
                quarantine_evidence_sha256
           FROM erasure_requests
          WHERE request_id IN (${requestIds.map(() => "?").join(",")})`,
        requestIds,
      );
      expect(newControl).toHaveLength(requestIds.length);
      expect(newControl.every((row) => (
        Number(row.control_generation) === 0
        && row.quarantined_at_ms === null
        && row.quarantine_reason_code === null
        && row.quarantine_evidence_sha256 === null
      ))).toBe(true);
      const [terminalIncidents] = await conn.query<Row[]>(
        "SELECT terminal_incident_id FROM erasure_job_terminal_incidents",
      );
      expect(terminalIncidents).toEqual([]);
      const [purgeRows] = await conn.query<Row[]>(
        `SELECT available_at_ms, attempts, claim_token, lease_until_ms, completed_at_ms
           FROM lifecycle_outbox WHERE topic='session.purge'`,
      );
      expect(purgeRows).toEqual([expect.objectContaining({
        available_at_ms: null,
        attempts: 0,
        claim_token: null,
        lease_until_ms: null,
        completed_at_ms: null,
      })]);

      // A still-running 0012 writer omits every 0013 field. Safe defaults must not fabricate a
      // quarantine or control event, while the existing 0012 trigger still schedules the job.
      const oldWriterRequest = await insertHistoricalRequest(conn, { status: "gated", updatedAtMs: 200 });
      const [oldWriterRows] = await conn.query<Row[]>(
        `SELECT available_at_ms, attempts, control_generation, quarantined_at_ms,
                quarantine_reason_code, quarantine_evidence_sha256
           FROM erasure_requests WHERE request_id=?`,
        [oldWriterRequest],
      );
      expect(oldWriterRows[0]).toMatchObject({
        available_at_ms: 200,
        attempts: 0,
        control_generation: 0,
        quarantined_at_ms: null,
        quarantine_reason_code: null,
        quarantine_evidence_sha256: null,
      });

      await conn.query(
        `INSERT INTO erasure_job_control_events
           (request_id, control_generation, event_type, phase, reason_code, action_code,
            actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES (?, 1, 'erasure_job/quarantined', 'gated', 'queue_control_invalid', NULL,
                 NULL, ?, NULL, 201)`,
        [oldWriterRequest, "d".repeat(64)],
      );
      await expect(conn.query(
        "UPDATE erasure_job_control_events SET emitted_at_ms=202 WHERE request_id=?",
        [oldWriterRequest],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM erasure_job_control_events WHERE request_id=?",
        [oldWriterRequest],
      )).rejects.toThrow(/append-only/i);
      const [controlRows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM erasure_job_control_events WHERE request_id=?",
        [oldWriterRequest],
      );
      expect(Number(controlRows[0]?.count)).toBe(1);

      const terminalIncidentRequest = await insertHistoricalRequest(conn, {
        status: "gated",
        updatedAtMs: 202,
      });
      const rawControlGeneration = "9007199254740992";
      const terminalEvidence = "e".repeat(64);
      await conn.query(
        `INSERT INTO erasure_job_terminal_incidents
           (request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms)
         VALUES (?, ?, 'unsafe_quarantine_envelope', ?, 203)`,
        [terminalIncidentRequest, rawControlGeneration, terminalEvidence],
      );
      const [incidentRows] = await conn.query<Row[]>(
        `SELECT request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms
           FROM erasure_job_terminal_incidents WHERE request_id=?`,
        [terminalIncidentRequest],
      );
      expect(incidentRows).toEqual([expect.objectContaining({
        request_id: terminalIncidentRequest,
        reason_code: "unsafe_quarantine_envelope",
        evidence_sha256: terminalEvidence,
        emitted_at_ms: 203,
      })]);
      expect(String(incidentRows[0]?.raw_control_generation)).toBe(rawControlGeneration);
      await expect(conn.query(
        `INSERT INTO erasure_job_terminal_incidents
           (request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms)
         VALUES (?, 0, 'unsafe_quarantine_envelope', ?, 204)`,
        [terminalIncidentRequest, "0".repeat(64)],
      )).rejects.toThrow(/duplicate/i);
      await expectTerminalIncidentIsAppendOnly(conn, terminalIncidentRequest);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("recovers when DDL stops after the control table but before the terminal incident table", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const requestId = await insertHistoricalRequest(conn, {
        status: "draining",
        updatedAtMs: 250,
        availableAtMs: 1250,
        attempts: 3,
      });
      const before = await requestControlSnapshot(conn, [requestId]);
      const terminalTableStatement = migrationStatements.findIndex((statement) => (
        statement.startsWith("CREATE TABLE IF NOT EXISTS erasure_job_terminal_incidents")
      ));
      expect(terminalTableStatement).toBeGreaterThan(0);
      for (const statement of migrationStatements.slice(0, terminalTableStatement)) {
        await conn.query(statement);
      }
      const [beforeRecovery] = await conn.query<Row[]>(
        `SELECT TABLE_NAME AS table_name FROM information_schema.tables
          WHERE table_schema=DATABASE()
            AND table_name IN ('erasure_job_control_events','erasure_job_terminal_incidents')
          ORDER BY table_name`,
      );
      expect(beforeRecovery.map((row) => String(row.table_name))).toEqual([
        "erasure_job_control_events",
      ]);

      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await recovered.close();
      expect(await requestControlSnapshot(conn, [requestId])).toEqual(before);
      expect(await terminalIncidentIndexes(conn)).toEqual({
        PRIMARY: { columns: ["terminal_incident_id"], unique: true },
        idx_erasure_job_terminal_incidents_emitted: {
          columns: ["reason_code", "emitted_at_ms", "terminal_incident_id"], unique: false,
        },
        uk_erasure_job_terminal_incident_request: { columns: ["request_id"], unique: true },
      });
      await expectCompleteTerminalIncidentTriggers(conn);
      const [incidents] = await conn.query<Row[]>(
        "SELECT terminal_incident_id FROM erasure_job_terminal_incidents",
      );
      expect(incidents).toEqual([]);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0013_erasure_job_control.sql'",
      );
      expect(Number(markers[0]?.count)).toBe(1);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("converges after partial DDL and marker-loss replay without changing authority or evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const policyHash = "e".repeat(64);
      const future = await insertHistoricalRequest(conn, {
        status: "draining", updatedAtMs: 300, availableAtMs: 1900, attempts: 6,
        lastErrorCode: "owner_unavailable", policyVersion: "policy-v2", policyHash,
      });
      const live = await insertHistoricalRequest(conn, {
        status: "reconciling_usage", updatedAtMs: 310, availableAtMs: 310, attempts: 8,
        claimToken: "live-before-ddl", leaseUntilMs: 2000,
        policyVersion: "policy-v2", policyHash,
      });
      const blocked = await insertHistoricalRequest(conn, {
        status: "blocked", updatedAtMs: 320, availableAtMs: null, attempts: 9,
        lastErrorCode: "legacy_blocked", policyVersion: "policy-v2", policyHash,
      });
      const completed = await insertHistoricalRequest(conn, {
        status: "completed", updatedAtMs: 330, availableAtMs: null, attempts: 10,
        policyVersion: "policy-v2", policyHash,
      });
      await conn.query(
        `INSERT INTO lifecycle_outbox
           (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
         VALUES ('session.purge', 'sess_partial_0013', 8, '{"sessionId":"sess_partial_0013"}', NULL, 0, 340)`,
      );
      const preservedIds = [future, live, blocked, completed];
      const before = await requestControlSnapshot(conn, preservedIds);

      // Model an early-0013 crash after the columns/table auto-commit but before its index-shape
      // guard, append-only triggers and schema marker. That build used the weaker triple key.
      const controlIndexRepairIndex = migrationStatements.findIndex((statement) => (
        statement.startsWith("SET @erasure_control_generation_columns")
      ));
      expect(controlIndexRepairIndex).toBeGreaterThan(0);
      for (const statement of migrationStatements.slice(0, controlIndexRepairIndex)) {
        await conn.query(statement);
      }
      await conn.query(
        `ALTER TABLE erasure_job_control_events
           DROP INDEX uk_erasure_job_control_event_generation,
           ADD UNIQUE KEY uk_erasure_job_control_event_generation
             (request_id, control_generation, event_type)`,
      );
      const insertedDuringGap = await insertHistoricalRequest(conn, {
        status: "gated", updatedAtMs: 350, availableAtMs: 1350,
      });
      const terminalDuringGap = await insertHistoricalRequest(conn, {
        status: "gated", updatedAtMs: 351, availableAtMs: 1351,
      });
      const terminalEvidence = "9".repeat(64);
      await conn.query(
        `INSERT INTO erasure_job_terminal_incidents
           (request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms)
         VALUES (?, 0, 'unsafe_quarantine_envelope', ?, 351)`,
        [terminalDuringGap, terminalEvidence],
      );
      const [terminalBeforeRecovery] = await conn.query<Row[]>(
        `SELECT request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms
           FROM erasure_job_terminal_incidents WHERE request_id=?`,
        [terminalDuringGap],
      );
      await conn.query(
        "ALTER TABLE erasure_requests ADD UNIQUE KEY idx_erasure_requests_claim_v2 (request_id)",
      );

      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await recovered.close();
      expect(await requestControlSnapshot(conn, preservedIds)).toEqual(before);
      const [gapRows] = await conn.query<Row[]>(
        `SELECT available_at_ms, attempts, control_generation, quarantined_at_ms,
                quarantine_reason_code, quarantine_evidence_sha256
           FROM erasure_requests WHERE request_id=?`,
        [insertedDuringGap],
      );
      expect(gapRows[0]).toMatchObject({
        available_at_ms: 1350,
        attempts: 0,
        control_generation: 0,
        quarantined_at_ms: null,
        quarantine_reason_code: null,
        quarantine_evidence_sha256: null,
      });
      expect(await indexDefinition(conn, "idx_erasure_requests_claim_v2")).toEqual({
        columns: ["quarantined_at_ms", "status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
      });
      expect((await controlIndexes(conn)).uk_erasure_job_control_event_generation).toEqual({
        columns: ["request_id", "control_generation"],
        unique: true,
      });
      expect(await terminalIncidentIndexes(conn)).toEqual({
        PRIMARY: { columns: ["terminal_incident_id"], unique: true },
        idx_erasure_job_terminal_incidents_emitted: {
          columns: ["reason_code", "emitted_at_ms", "terminal_incident_id"], unique: false,
        },
        uk_erasure_job_terminal_incident_request: { columns: ["request_id"], unique: true },
      });
      await expectCompleteAppendOnlyTriggers(conn);
      await expectCompleteTerminalIncidentTriggers(conn);
      const [terminalAfterRecovery] = await conn.query<Row[]>(
        `SELECT request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms
           FROM erasure_job_terminal_incidents WHERE request_id=?`,
        [terminalDuringGap],
      );
      expect(terminalAfterRecovery).toEqual(terminalBeforeRecovery);

      const evidence = "f".repeat(64);
      await conn.query(
        `UPDATE erasure_requests
            SET control_generation=1, quarantined_at_ms=360,
                quarantine_reason_code='queue_control_invalid',
                quarantine_evidence_sha256=?, available_at_ms=NULL,
                claim_token=NULL, lease_until_ms=NULL
          WHERE request_id=?`,
        [evidence, insertedDuringGap],
      );
      await conn.query(
        `INSERT INTO erasure_job_control_events
           (request_id, control_generation, event_type, phase, reason_code, action_code,
            actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES (?, 1, 'erasure_job/quarantined', 'gated', 'queue_control_invalid', NULL,
                 NULL, ?, NULL, 360)`,
        [insertedDuringGap, evidence],
      );

      // Lose the marker after a complete migration and restore the early triple-key shape as well
      // as damaging the additive claim index/triggers. Replay must converge without rewriting rows.
      await conn.query("DROP TRIGGER trg_erasure_job_control_events_bu");
      await conn.query("DROP TRIGGER trg_erasure_job_control_events_bd");
      await conn.query("DROP TRIGGER trg_erasure_job_terminal_incidents_bu");
      await conn.query("DROP TRIGGER trg_erasure_job_terminal_incidents_bd");
      await conn.query(
        `ALTER TABLE erasure_job_control_events
           DROP INDEX uk_erasure_job_control_event_generation,
           ADD UNIQUE KEY uk_erasure_job_control_event_generation
             (request_id, control_generation, event_type)`,
      );
      await conn.query(
        `ALTER TABLE erasure_requests
           DROP INDEX idx_erasure_requests_claim_v2,
           ADD UNIQUE KEY idx_erasure_requests_claim_v2 (request_id)`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name='0013_erasure_job_control.sql'");

      const replayed = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await replayed.close();
      expect(await requestControlSnapshot(conn, preservedIds)).toEqual(before);
      const [quarantinedRows] = await conn.query<Row[]>(
        `SELECT status, available_at_ms, attempts, claim_token, lease_until_ms,
                control_generation, quarantined_at_ms, quarantine_reason_code,
                quarantine_evidence_sha256
           FROM erasure_requests WHERE request_id=?`,
        [insertedDuringGap],
      );
      expect(quarantinedRows[0]).toMatchObject({
        status: "gated",
        available_at_ms: null,
        attempts: 0,
        claim_token: null,
        lease_until_ms: null,
        control_generation: 1,
        quarantined_at_ms: 360,
        quarantine_reason_code: "queue_control_invalid",
        quarantine_evidence_sha256: evidence,
      });
      const [eventRows] = await conn.query<Row[]>(
        `SELECT request_id, control_generation, event_type, phase, reason_code, action_code,
                actor_key_id, before_sha256, after_sha256, emitted_at_ms
           FROM erasure_job_control_events WHERE request_id=?`,
        [insertedDuringGap],
      );
      expect(eventRows).toEqual([expect.objectContaining({
        request_id: insertedDuringGap,
        control_generation: 1,
        event_type: "erasure_job/quarantined",
        phase: "gated",
        reason_code: "queue_control_invalid",
        action_code: null,
        actor_key_id: null,
        before_sha256: evidence,
        after_sha256: null,
        emitted_at_ms: 360,
      })]);
      expect(await indexDefinition(conn, "idx_erasure_requests_claim")).toEqual({
        columns: ["status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
      });
      expect(await indexDefinition(conn, "idx_erasure_requests_claim_v2")).toEqual({
        columns: ["quarantined_at_ms", "status", "available_at_ms", "lease_until_ms", "request_id"],
        unique: false,
        indexType: "BTREE",
      });
      expect((await controlIndexes(conn)).uk_erasure_job_control_event_generation).toEqual({
        columns: ["request_id", "control_generation"],
        unique: true,
      });
      await expectCompleteAppendOnlyTriggers(conn);
      expect(await terminalIncidentIndexes(conn)).toEqual({
        PRIMARY: { columns: ["terminal_incident_id"], unique: true },
        idx_erasure_job_terminal_incidents_emitted: {
          columns: ["reason_code", "emitted_at_ms", "terminal_incident_id"], unique: false,
        },
        uk_erasure_job_terminal_incident_request: { columns: ["request_id"], unique: true },
      });
      await expectCompleteTerminalIncidentTriggers(conn);
      const [terminalAfterReplay] = await conn.query<Row[]>(
        `SELECT request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms
           FROM erasure_job_terminal_incidents WHERE request_id=?`,
        [terminalDuringGap],
      );
      expect(terminalAfterReplay).toEqual(terminalBeforeRecovery);
      const [purgeRows] = await conn.query<Row[]>(
        "SELECT available_at_ms, claim_token, lease_until_ms FROM lifecycle_outbox WHERE topic='session.purge'",
      );
      expect(purgeRows).toEqual([expect.objectContaining({
        available_at_ms: null,
        claim_token: null,
        lease_until_ms: null,
      })]);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0013_erasure_job_control.sql'",
      );
      expect(Number(markers[0]?.count)).toBe(1);
      await expect(conn.query(
        "DELETE FROM erasure_job_control_events WHERE request_id=?",
        [insertedDuringGap],
      )).rejects.toThrow(/append-only/i);
      await expectTerminalIncidentIsAppendOnly(conn, terminalDuringGap);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("converges from both implicit-commit index handoff breakpoints without losing evidence", async () => {
    const breakpoints = [
      {
        name: "temporary pair key added before old triple key drop",
        prepare: async (conn: Connection) => {
          await conn.query(
            `ALTER TABLE erasure_job_control_events
               ADD UNIQUE KEY uk_erasure_job_control_event_generation_v2
                 (request_id, control_generation)`,
          );
        },
        expectedBefore: {
          canonical: {
            columns: ["request_id", "control_generation", "event_type"],
            unique: true,
          },
          temporary: {
            columns: ["request_id", "control_generation"],
            unique: true,
          },
        },
      },
      {
        name: "old triple key dropped before temporary pair key rename",
        prepare: async (conn: Connection) => {
          await conn.query(
            `ALTER TABLE erasure_job_control_events
               ADD UNIQUE KEY uk_erasure_job_control_event_generation_v2
                 (request_id, control_generation),
               DROP INDEX uk_erasure_job_control_event_generation`,
          );
        },
        expectedBefore: {
          canonical: undefined,
          temporary: {
            columns: ["request_id", "control_generation"],
            unique: true,
          },
        },
      },
    ] as const;

    for (const breakpoint of breakpoints) {
      const database = fixtureDatabaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(baseUrl, database);
      let conn: Connection | undefined;
      try {
        conn = await mysql.createConnection({ uri: url, multipleStatements: true });
        await conn.query(fixtureSql);
        const requestId = await insertHistoricalRequest(conn, {
          status: "gated",
          updatedAtMs: 900,
          availableAtMs: 900,
        });

        const controlIndexRepairIndex = migrationStatements.findIndex((statement) => (
          statement.startsWith("SET @erasure_control_generation_columns")
        ));
        expect(controlIndexRepairIndex).toBeGreaterThan(0);
        for (const statement of migrationStatements.slice(0, controlIndexRepairIndex)) {
          await conn.query(statement);
        }
        await conn.query(
          `ALTER TABLE erasure_job_control_events
             DROP INDEX uk_erasure_job_control_event_generation,
             ADD UNIQUE KEY uk_erasure_job_control_event_generation
               (request_id, control_generation, event_type)`,
        );

        const evidence = "4".repeat(64);
        await conn.query(
          `UPDATE erasure_requests
              SET control_generation=1, quarantined_at_ms=901,
                  quarantine_reason_code='queue_control_invalid',
                  quarantine_evidence_sha256=?, available_at_ms=NULL,
                  claim_token=NULL, lease_until_ms=NULL, updated_at_ms=901
            WHERE request_id=?`,
          [evidence, requestId],
        );
        await conn.query(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,1,'erasure_job/quarantined','gated','queue_control_invalid',
                   NULL,NULL,?,NULL,901)`,
          [requestId, evidence],
        );
        await breakpoint.prepare(conn);

        const indexesBefore = await controlIndexes(conn);
        expect(indexesBefore.uk_erasure_job_control_event_generation, breakpoint.name)
          .toEqual(breakpoint.expectedBefore.canonical);
        expect(indexesBefore.uk_erasure_job_control_event_generation_v2, breakpoint.name)
          .toEqual(breakpoint.expectedBefore.temporary);
        const [requestBefore] = await conn.query<Row[]>(
          `SELECT status, available_at_ms, attempts, claim_token, lease_until_ms,
                  control_generation, quarantined_at_ms, quarantine_reason_code,
                  quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [requestId],
        );
        const [evidenceBefore] = await conn.query<Row[]>(
          `SELECT request_id, control_generation, event_type, phase, reason_code, action_code,
                  actor_key_id, before_sha256, after_sha256, emitted_at_ms
             FROM erasure_job_control_events WHERE request_id=? ORDER BY control_event_id`,
          [requestId],
        );

        const replayed = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
        await replayed.close();

        const indexesAfter = await controlIndexes(conn);
        expect(indexesAfter.uk_erasure_job_control_event_generation, breakpoint.name).toEqual({
          columns: ["request_id", "control_generation"],
          unique: true,
        });
        expect(indexesAfter.uk_erasure_job_control_event_generation_v2, breakpoint.name).toBeUndefined();
        const [requestAfter] = await conn.query<Row[]>(
          `SELECT status, available_at_ms, attempts, claim_token, lease_until_ms,
                  control_generation, quarantined_at_ms, quarantine_reason_code,
                  quarantine_evidence_sha256
             FROM erasure_requests WHERE request_id=?`,
          [requestId],
        );
        const [evidenceAfter] = await conn.query<Row[]>(
          `SELECT request_id, control_generation, event_type, phase, reason_code, action_code,
                  actor_key_id, before_sha256, after_sha256, emitted_at_ms
             FROM erasure_job_control_events WHERE request_id=? ORDER BY control_event_id`,
          [requestId],
        );
        expect(requestAfter, breakpoint.name).toEqual(requestBefore);
        expect(evidenceAfter, breakpoint.name).toEqual(evidenceBefore);
        const [markers] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0013_erasure_job_control.sql'",
        );
        expect(Number(markers[0]?.count), breakpoint.name).toBe(1);
        await expectCompleteAppendOnlyTriggers(conn);
        await expectCompleteTerminalIncidentTriggers(conn);
      } finally {
        await conn?.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
    }
  }, 60_000);

  it("keeps update and delete evidence protected while replay rotates partial trigger sets", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const upgraded = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await upgraded.close();
      const requestId = await insertHistoricalRequest(conn, { status: "gated", updatedAtMs: 800 });
      await conn.query(
        `INSERT INTO erasure_job_control_events
           (request_id, control_generation, event_type, phase, reason_code, action_code,
            actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES (?,1,'erasure_job/quarantined','gated','queue_control_invalid',NULL,NULL,?,NULL,801)`,
        [requestId, "3".repeat(64)],
      );
      const incidentRequestId = await insertHistoricalRequest(conn, {
        status: "gated",
        updatedAtMs: 802,
      });
      await conn.query(
        `INSERT INTO erasure_job_terminal_incidents
           (request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms)
         VALUES (?, 7, 'unsafe_quarantine_envelope', ?, 803)`,
        [incidentRequestId, "7".repeat(64)],
      );

      const triggerStart = migrationStatements.findIndex((statement) => (
        statement === "DROP TRIGGER IF EXISTS trg_erasure_job_control_events_bu_bootstrap"
      ));
      expect(triggerStart).toBeGreaterThan(0);
      const triggerReplay = migrationStatements.slice(triggerStart);
      const partialStates = [
        {
          name: "canonical-only",
          keepControl: new Set<string>([
            "trg_erasure_job_control_events_bu",
            "trg_erasure_job_control_events_bd",
          ]),
          keepTerminal: new Set<string>([
            "trg_erasure_job_terminal_incidents_bu",
            "trg_erasure_job_terminal_incidents_bd",
          ]),
        },
        {
          name: "guards-only",
          keepControl: new Set<string>([
            "trg_erasure_job_control_events_bu_guard_a",
            "trg_erasure_job_control_events_bu_guard_b",
            "trg_erasure_job_control_events_bd_guard_a",
            "trg_erasure_job_control_events_bd_guard_b",
          ]),
          keepTerminal: new Set<string>([
            "trg_erasure_job_terminal_incidents_bu_guard_a",
            "trg_erasure_job_terminal_incidents_bu_guard_b",
            "trg_erasure_job_terminal_incidents_bd_guard_a",
            "trg_erasure_job_terminal_incidents_bd_guard_b",
          ]),
        },
        {
          name: "mixed-partial",
          keepControl: new Set<string>([
            "trg_erasure_job_control_events_bu",
            "trg_erasure_job_control_events_bu_guard_b",
            "trg_erasure_job_control_events_bd_guard_a",
          ]),
          keepTerminal: new Set<string>([
            "trg_erasure_job_terminal_incidents_bu_guard_a",
            "trg_erasure_job_terminal_incidents_bd",
            "trg_erasure_job_terminal_incidents_bd_guard_b",
          ]),
        },
      ];

      for (const state of partialStates) {
        for (const trigger of CONTROL_TRIGGERS) {
          if (!state.keepControl.has(trigger)) await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`);
        }
        for (const trigger of TERMINAL_INCIDENT_TRIGGERS) {
          if (!state.keepTerminal.has(trigger)) await conn.query(`DROP TRIGGER IF EXISTS ${trigger}`);
        }
        const presentControl = await controlTriggers(conn);
        expect(presentControl.map((trigger) => trigger.name).sort(), state.name)
          .toEqual([...state.keepControl].sort());
        const presentTerminal = await terminalIncidentTriggers(conn);
        expect(presentTerminal.map((trigger) => trigger.name).sort(), state.name)
          .toEqual([...state.keepTerminal].sort());
        await expectControlEvidenceIsAppendOnly(conn, requestId);
        await expectTerminalIncidentIsAppendOnly(conn, incidentRequestId);

        for (const [index, statement] of triggerReplay.entries()) {
          await conn.query(statement);
          await expectControlEvidenceIsAppendOnly(conn, requestId).catch((error) => {
            throw new Error(`${state.name} lost append-only protection after trigger statement ${index + 1}`, {
              cause: error,
            });
          });
          await expectTerminalIncidentIsAppendOnly(conn, incidentRequestId).catch((error) => {
            throw new Error(
              `${state.name} lost terminal-incident protection after trigger statement ${index + 1}`,
              { cause: error },
            );
          });
        }
        await expectCompleteAppendOnlyTriggers(conn);
        await expectCompleteTerminalIncidentTriggers(conn);
      }
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("blocks conflicting same-generation evidence and succeeds only after explicit remediation", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      await conn.query(conflictFixtureSql);

      await expect(MysqlSessionStore.connect({
        url,
        connectionLimit: 1,
        migrationsDir: only0013,
      })).rejects.toThrow(/migration 0013_erasure_job_control\.sql failed/);

      const [preserved] = await conn.query<Row[]>(
        `SELECT control_event_id, request_id, control_generation, event_type, before_sha256,
                after_sha256, emitted_at_ms
           FROM erasure_job_control_events
          WHERE request_id='erase_0013_conflict'
          ORDER BY control_event_id`,
      );
      expect(preserved).toEqual([
        expect.objectContaining({
          request_id: "erase_0013_conflict",
          control_generation: 1,
          event_type: "erasure_job/quarantined",
          before_sha256: "1".repeat(64),
          after_sha256: null,
          emitted_at_ms: 701,
        }),
        expect.objectContaining({
          request_id: "erase_0013_conflict",
          control_generation: 1,
          event_type: "erasure_job/quarantine_repaired",
          before_sha256: "1".repeat(64),
          after_sha256: "2".repeat(64),
          emitted_at_ms: 702,
        }),
      ]);
      const failedIndexes = await controlIndexes(conn);
      expect(failedIndexes.uk_erasure_job_control_event_generation).toEqual({
        columns: ["request_id", "control_generation", "event_type"],
        unique: true,
      });
      expect(failedIndexes.uk_erasure_job_control_event_generation_v2).toBeUndefined();
      const [failedMarkers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0013_erasure_job_control.sql'",
      );
      expect(Number(failedMarkers[0]?.count)).toBe(0);

      // This deletion models an explicit operator decision after preserving and investigating both
      // facts. The migration itself must never choose which conflicting evidence to discard.
      await conn.query(
        `DELETE FROM erasure_job_control_events
          WHERE request_id='erase_0013_conflict'
            AND event_type='erasure_job/quarantine_repaired'`,
      );
      const recovered = await MysqlSessionStore.connect({ url, connectionLimit: 1, migrationsDir: only0013 });
      await recovered.close();

      expect((await controlIndexes(conn)).uk_erasure_job_control_event_generation).toEqual({
        columns: ["request_id", "control_generation"],
        unique: true,
      });
      await expectCompleteAppendOnlyTriggers(conn);
      await expectCompleteTerminalIncidentTriggers(conn);
      const [survivors] = await conn.query<Row[]>(
        `SELECT event_type, before_sha256, after_sha256
           FROM erasure_job_control_events WHERE request_id='erase_0013_conflict'`,
      );
      expect(survivors).toEqual([{
        event_type: "erasure_job/quarantined",
        before_sha256: "1".repeat(64),
        after_sha256: null,
      }]);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0013_erasure_job_control.sql'",
      );
      expect(Number(markers[0]?.count)).toBe(1);
      await expect(conn.query(
        "DELETE FROM erasure_job_control_events WHERE request_id='erase_0013_conflict'",
      )).rejects.toThrow(/append-only/i);
    } finally {
      await conn?.end().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);
});
