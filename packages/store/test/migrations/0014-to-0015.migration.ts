import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legalHoldControlSha256,
  legalHoldProjectionSha256,
  MysqlSessionStore,
  retentionPolicyControlSha256,
  retentionPolicySha256,
} from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0014.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0015_retention_policy_and_legal_holds.sql");
const MIGRATION_0018_PATH = resolve(HERE, "../../migrations/0018_tenant_credential_revocation_fence.sql");
const EMPTY_PROJECTION_SHA256 = "d336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f";
const EMPTY_RETENTION_POLICY = {
  sessionContentRetentionMs: null,
  userErasureGraceMs: null,
  operationalUsageRetentionMs: null,
  idempotencyReceiptRetentionMs: null,
  billingFactRetentionMs: null,
  lifecycleAuditRetentionMs: null,
  exportArtifactTtlMs: null,
} as const;

type Row = RowDataPacket;

const APPEND_ONLY_TRIGGER_TABLES = [
  "retention_policy_versions",
  "retention_policy_activation_events",
  "legal_hold_events",
] as const;

const ERASURE_POLICY_TRIGGERS = [
  "trg_erasure_requests_policy_bi",
  "trg_erasure_requests_policy_bi_guard_a",
  "trg_erasure_requests_policy_bi_guard_b",
] as const;

const MIGRATION_0015_TABLES = [
  "retention_policy_versions",
  "retention_policy_controls",
  "retention_policy_activation_events",
  "legal_hold_controls",
  "legal_holds",
  "legal_hold_events",
] as const;

const FROZEN_0014_MIGRATIONS = [
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
  "0011_erasure_and_usage_separation.sql",
  "0012_erasure_job_queue.sql",
  "0013_erasure_job_control.sql",
  "0014_legacy_tombstone_compensation.sql",
] as const;

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

function legacyHoldId(tenantId: string, subjectKind: string, subjectId: string, atMs: number): string {
  const digest = createHash("sha256").update(JSON.stringify([
    "agent-service/legal-hold-legacy/v1",
    tenantId,
    subjectKind,
    subjectId,
    atMs,
  ])).digest("hex");
  return `hold_legacy_${digest.slice(0, 48)}`;
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

async function triggerNames(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table=?
      ORDER BY trigger_name`,
    [table],
  );
  return rows.map((row) => String(row.trigger_name));
}

function expectedGuardNames(table: string): string[] {
  return [
    `trg_${table}_bd`,
    `trg_${table}_bd_guard_a`,
    `trg_${table}_bd_guard_b`,
    `trg_${table}_bu`,
    `trg_${table}_bu_guard_a`,
    `trg_${table}_bu_guard_b`,
  ].sort();
}

async function expectFinalTriggers(conn: Connection): Promise<void> {
  for (const table of APPEND_ONLY_TRIGGER_TABLES) {
    expect(await triggerNames(conn, table)).toEqual(expectedGuardNames(table));
  }
  expect(await triggerNames(conn, "legal_holds")).toEqual(expectedGuardNames("legal_holds"));
  const requestTriggers = await triggerNames(conn, "erasure_requests");
  expect(requestTriggers).toContain("trg_erasure_requests_job_bi");
  expect(requestTriggers.filter((name) => (
    name.startsWith("trg_erasure_requests_policy_bi")
  ))).toEqual([...ERASURE_POLICY_TRIGGERS]);
}

async function insertRawErasureRequest(
  conn: Connection,
  input: {
    requestId: string;
    tenantId: string;
    userId: string;
    atMs: number;
    policyVersion?: string;
    policyHash?: string;
  },
): Promise<unknown> {
  return await conn.query(
    `INSERT INTO erasure_requests
      (request_id, tenant_id, subject_kind, subject_id, generation, status,
       requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
       updated_at_ms, available_at_ms, policy_version, policy_hash)
     VALUES (?,?,'user',?,1,'gated','legacy-writer',?,REPEAT('7',64),?,?,?,?,?,?)`,
    [
      input.requestId,
      input.tenantId,
      input.userId,
      `idem-${input.requestId}`,
      input.atMs,
      input.atMs,
      input.atMs,
      input.atMs,
      input.policyVersion ?? null,
      input.policyHash ?? null,
    ],
  );
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return settled;
}

async function expectDormantPurgeAndPolicy(conn: Connection): Promise<void> {
  const [policyCounts] = await conn.query<Row[]>(
    `SELECT
       (SELECT COUNT(*) FROM retention_policy_versions) AS versions_count,
       (SELECT COUNT(*) FROM retention_policy_activation_events) AS activation_count,
       (SELECT COUNT(*) FROM retention_policy_controls
         WHERE control_generation <> 0 OR active_policy_version IS NOT NULL
            OR active_policy_sha256 IS NOT NULL OR effective_at_ms IS NOT NULL) AS active_controls,
       (SELECT COUNT(*) FROM lifecycle_outbox
         WHERE topic='session.purge'
           AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL
             OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL)) AS available_purge`,
  );
  expect(policyCounts[0]).toMatchObject({
    versions_count: 0,
    activation_count: 0,
    active_controls: 0,
    available_purge: 0,
  });
}

async function expectPurgeUnavailable(conn: Connection): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COUNT(*) AS available_purge
       FROM lifecycle_outbox
      WHERE topic='session.purge'
        AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL
          OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL)`,
  );
  expect(Number(rows[0]!.available_purge)).toBe(0);
}

describe("real MySQL historical upgrade: 0014 -> 0015", () => {
  let admin: Connection;
  let baseUrl: URL;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0015: string;
  let runtime0015And0018: string;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.length).toBeGreaterThan(80);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(6);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(36);
    only0015 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0015-"));
    await copyFile(MIGRATION_PATH, join(only0015, "0015_retention_policy_and_legal_holds.sql"));
    runtime0015And0018 = await mkdtemp(join(tmpdir(), "agent-service-migration-runtime-0015-0018-"));
    await copyFile(MIGRATION_PATH, join(runtime0015And0018, "0015_retention_policy_and_legal_holds.sql"));
    await copyFile(
      MIGRATION_0018_PATH,
      join(runtime0015And0018, "0018_tenant_credential_revocation_fence.sql"),
    );
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    await rm(only0015, { recursive: true, force: true });
    await rm(runtime0015And0018, { recursive: true, force: true });
  });

  it("loads a frozen 0014 database before any 0015 schema exists", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({
        uri: databaseUrl(baseUrl, database),
        multipleStatements: true,
      });
      await conn.query(fixtureSql);

      const [markers] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0014_MIGRATIONS);

      const [newTables] = await conn.query<Row[]>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema=DATABASE()
            AND table_name IN (${MIGRATION_0015_TABLES.map(() => "?").join(",")})
          ORDER BY table_name`,
        [...MIGRATION_0015_TABLES],
      );
      expect(newTables).toEqual([]);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("backfills exact legacy holds while leaving policy and purge dormant", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await store.close();

      expect(await tableColumns(conn, "retention_policy_versions")).toEqual([
        "tenant_id", "policy_version", "schema_version", "session_content_retention_ms",
        "user_erasure_grace_ms", "operational_usage_retention_ms",
        "idempotency_receipt_retention_ms", "billing_fact_retention_ms",
        "lifecycle_audit_retention_ms", "export_artifact_ttl_ms", "policy_sha256",
        "created_by_key_id", "created_at_ms",
      ]);
      expect(await tableColumns(conn, "retention_policy_controls")).toEqual([
        "tenant_id", "control_generation", "active_policy_version", "active_policy_sha256",
        "effective_at_ms", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "retention_policy_activation_events")).toEqual([
        "event_id", "tenant_id", "control_generation", "policy_version", "policy_sha256",
        "effective_at_ms", "actor_key_id", "before_sha256", "after_sha256", "emitted_at_ms",
      ]);
      expect(await tableColumns(conn, "legal_hold_controls")).toEqual([
        "tenant_id", "subject_kind", "subject_id", "control_generation", "active_hold_count",
        "active_projection_sha256", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "legal_holds")).toEqual([
        "tenant_id", "hold_id", "subject_kind", "subject_id", "state", "reason_code",
        "external_reference_sha256", "created_control_generation", "created_by_key_id",
        "created_at_ms", "released_control_generation", "released_by_key_id", "released_at_ms",
        "release_reason_code",
      ]);
      expect(await tableColumns(conn, "legal_hold_events")).toEqual([
        "event_id", "tenant_id", "subject_kind", "subject_id", "control_generation", "hold_id",
        "event_type", "reason_code", "external_reference_sha256", "actor_key_id", "before_sha256",
        "after_sha256", "emitted_at_ms",
      ]);

      const versionIndexes = await tableIndexes(conn, "retention_policy_versions");
      expect(versionIndexes.PRIMARY).toEqual({ columns: ["tenant_id", "policy_version"], unique: true });
      expect(versionIndexes.uk_retention_policy_versions_hash).toEqual({
        columns: ["tenant_id", "policy_sha256"], unique: true,
      });
      const holdIndexes = await tableIndexes(conn, "legal_holds");
      expect(holdIndexes.PRIMARY).toEqual({ columns: ["tenant_id", "hold_id"], unique: true });
      expect(holdIndexes.uk_legal_holds_subject_generation).toEqual({
        columns: ["tenant_id", "subject_kind", "subject_id", "created_control_generation"],
        unique: true,
      });

      const [policyControls] = await conn.query<Row[]>(
        `SELECT tenant_id, control_generation, active_policy_version, active_policy_sha256,
                effective_at_ms, updated_at_ms
           FROM retention_policy_controls ORDER BY tenant_id`,
      );
      expect(policyControls).toEqual([
        {
          tenant_id: "tenant_a", control_generation: 0, active_policy_version: null,
          active_policy_sha256: null, effective_at_ms: null, updated_at_ms: 0,
        },
        {
          tenant_id: "tenant_b", control_generation: 0, active_policy_version: null,
          active_policy_sha256: null, effective_at_ms: null, updated_at_ms: 0,
        },
      ]);

      const [holds] = await conn.query<Row[]>(
        `SELECT tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
                external_reference_sha256, created_control_generation, created_by_key_id,
                created_at_ms, released_control_generation, released_by_key_id, released_at_ms,
                release_reason_code
           FROM legal_holds ORDER BY tenant_id, subject_kind, subject_id`,
      );
      expect(holds).toHaveLength(2);
      for (const row of holds) {
        const expectedId = legacyHoldId(
          String(row.tenant_id),
          String(row.subject_kind),
          String(row.subject_id),
          Number(row.created_at_ms),
        );
        expect(row).toMatchObject({
          hold_id: expectedId,
          state: "active",
          reason_code: "legacy_unattributed",
          external_reference_sha256: null,
          created_control_generation: 1,
          created_by_key_id: "migration-0015",
          released_control_generation: null,
          released_by_key_id: null,
          released_at_ms: null,
          release_reason_code: null,
        });

        const projected = legalHoldProjectionSha256([{
          tenantId: String(row.tenant_id),
          holdId: expectedId,
          subjectKind: String(row.subject_kind) as "tenant" | "user",
          subjectId: String(row.subject_id),
          state: "active",
          reasonCode: "legacy_unattributed",
          createdControlGeneration: 1,
          createdByKeyId: "migration-0015",
          createdAtMs: Number(row.created_at_ms),
        }]);
        const [controls] = await conn.query<Row[]>(
          `SELECT control_generation, active_hold_count, active_projection_sha256, updated_at_ms
             FROM legal_hold_controls
            WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
          [row.tenant_id, row.subject_kind, row.subject_id],
        );
        expect(controls[0]).toMatchObject({
          control_generation: 1,
          active_hold_count: 1,
          active_projection_sha256: projected,
        });
        const [events] = await conn.query<Row[]>(
          `SELECT control_generation, hold_id, event_type, reason_code, actor_key_id,
                  before_sha256, after_sha256, emitted_at_ms
             FROM legal_hold_events
            WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
          [row.tenant_id, row.subject_kind, row.subject_id],
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          control_generation: 1,
          hold_id: expectedId,
          event_type: "legal_hold/set",
          reason_code: "legacy_unattributed",
          actor_key_id: "migration-0015",
        });
        expect(events[0]!.before_sha256).toBe(legalHoldControlSha256({
          tenantId: String(row.tenant_id),
          subjectKind: String(row.subject_kind) as "tenant" | "user",
          subjectId: String(row.subject_id),
          controlGeneration: 0,
          activeHoldCount: 0,
          activeProjectionSha256: EMPTY_PROJECTION_SHA256,
          updatedAtMs: 0,
        }));
        expect(events[0]!.after_sha256).toBe(legalHoldControlSha256({
          tenantId: String(row.tenant_id),
          subjectKind: String(row.subject_kind) as "tenant" | "user",
          subjectId: String(row.subject_id),
          controlGeneration: 1,
          activeHoldCount: 1,
          activeProjectionSha256: projected,
          updatedAtMs: Number(controls[0]!.updated_at_ms),
        }));
      }

      const [emptyControls] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM legal_hold_controls
          WHERE control_generation=0 AND active_hold_count=0 AND active_projection_sha256=?
            AND updated_at_ms=0`,
        [EMPTY_PROJECTION_SHA256],
      );
      expect(Number(emptyControls[0]!.count)).toBe(3);
      const [subjects] = await conn.query<Row[]>(
        `SELECT tenant_id, subject_kind, subject_id, legal_hold_at_ms
           FROM subject_lifecycle ORDER BY tenant_id, subject_kind, subject_id`,
      );
      expect(subjects.map((row) => row.legal_hold_at_ms == null ? null : Number(row.legal_hold_at_ms)))
        .toEqual([null, 220, null, 250, null]);

      const [requestRows] = await conn.query<Row[]>(
        `SELECT status, available_at_ms, policy_version, policy_hash
           FROM erasure_requests WHERE request_id='erase_11111111-1111-4111-8111-111111111111'`,
      );
      expect(requestRows[0]).toMatchObject({
        status: "awaiting_purge_policy",
        available_at_ms: null,
        policy_version: "legacy-policy-v1",
        policy_hash: "a".repeat(64),
      });
      const [historicalCounts] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM legacy_tombstone_cutover WHERE control_generation=1) AS cutovers,
          (SELECT COUNT(*) FROM legacy_tombstone_compensation_jobs WHERE status='completed') AS jobs,
          (SELECT COUNT(*) FROM legacy_tombstone_compensation_events) AS events`,
      );
      expect(historicalCounts[0]).toMatchObject({ cutovers: 1, jobs: 1, events: 1 });
      await expectDormantPurgeAndPolicy(conn);
      await expectFinalTriggers(conn);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0015_retention_policy_and_legal_holds.sql'",
      );
      expect(Number(markers[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after partial DDL and marker-loss trigger replay without duplicate evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      for (const statement of migrationStatements.slice(0, 4)) await conn.query(statement);
      const [before] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE() AND table_name LIKE 'retention_policy_%') AS policy_tables,
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0015_retention_policy_and_legal_holds.sql') AS marker_count`,
      );
      expect(before[0]).toMatchObject({ policy_tables: 3, marker_count: 0 });

      const first = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await first.close();
      const [firstCounts] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM legal_holds) AS holds,
          (SELECT COUNT(*) FROM legal_hold_events) AS events`,
      );
      expect(firstCounts[0]).toMatchObject({ holds: 2, events: 2 });

      await conn.query("DROP TRIGGER trg_legal_hold_events_bu_guard_a");
      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0015_retention_policy_and_legal_holds.sql'",
      );
      const replay = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await replay.close();

      const [afterCounts] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM legal_holds) AS holds,
          (SELECT COUNT(*) FROM legal_hold_events) AS events,
          (SELECT COUNT(*) FROM retention_policy_versions) AS versions,
          (SELECT COUNT(*) FROM retention_policy_activation_events) AS activations,
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0015_retention_policy_and_legal_holds.sql') AS marker_count`,
      );
      expect(afterCounts[0]).toMatchObject({
        holds: 2, events: 2, versions: 0, activations: 0, marker_count: 1,
      });
      await expectDormantPurgeAndPolicy(conn);
      await expectFinalTriggers(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays after later legal hold writes change the legacy compatibility shadow", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      // Latest runtime code requires the additive 0018 fence schema to be installed before code
      // rollout. The tables remain empty, so this still isolates 0015's legal-hold replay behavior.
      store = await MysqlSessionStore.connect({
        url,
        migrationsDir: runtime0015And0018,
        connectionLimit: 1,
      });

      const importedLegacyHoldId = legacyHoldId("tenant_a", "user", "user_a", 220);
      const successorHoldId = "hold_marker_loss_successor";
      await store.setLegalHold({
        tenantId: "tenant_a",
        holdId: successorHoldId,
        subjectKind: "user",
        subjectId: "user_a",
        reasonCode: "litigation",
        expectedControlGeneration: 1,
        actorKeyId: "migration-admin",
        atMs: 300,
      });
      await store.releaseLegalHold({
        tenantId: "tenant_a",
        holdId: importedLegacyHoldId,
        expectedControlGeneration: 2,
        reasonCode: "matter_closed",
        actorKeyId: "migration-admin",
        atMs: 310,
      });
      await store.close();
      store = undefined;

      const [beforeReplay] = await conn.query<Row[]>(
        `SELECT lifecycle.legal_hold_at_ms, controls.control_generation,
                controls.active_hold_count
           FROM subject_lifecycle lifecycle
           JOIN legal_hold_controls controls
             ON controls.tenant_id=lifecycle.tenant_id
            AND controls.subject_kind=lifecycle.subject_kind
            AND controls.subject_id=lifecycle.subject_id
          WHERE lifecycle.tenant_id='tenant_a'
            AND lifecycle.subject_kind='user' AND lifecycle.subject_id='user_a'`,
      );
      expect(beforeReplay[0]).toMatchObject({
        legal_hold_at_ms: 300,
        control_generation: 3,
        active_hold_count: 1,
      });

      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0015_retention_policy_and_legal_holds.sql'",
      );
      store = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await store.close();
      store = undefined;

      const [afterReplay] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM legal_holds
            WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a') AS holds,
          (SELECT COUNT(*) FROM legal_hold_events
            WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a') AS events,
          (SELECT legal_hold_at_ms FROM subject_lifecycle
            WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a') AS shadow,
          (SELECT control_generation FROM legal_hold_controls
            WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a') AS generation,
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0015_retention_policy_and_legal_holds.sql') AS marker_count`,
      );
      expect(afterReplay[0]).toMatchObject({
        holds: 2,
        events: 3,
        shadow: 300,
        generation: 3,
        marker_count: 1,
      });
      const [holdStates] = await conn.query<Row[]>(
        `SELECT hold_id, state FROM legal_holds
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a'
          ORDER BY hold_id`,
      );
      expect(holdStates).toEqual(expect.arrayContaining([
        { hold_id: importedLegacyHoldId, state: "released" },
        { hold_id: successorHoldId, state: "active" },
      ]));
      await expectPurgeUnavailable(conn);
      await expectFinalTriggers(conn);
    } finally {
      await store?.close();
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("blocks a conflicting deterministic legacy hold and converges after the conflict is removed", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      for (const statement of migrationStatements.slice(0, 6)) await conn.query(statement);
      const holdId = legacyHoldId("tenant_a", "user", "user_a", 220);
      await conn.query(
        `INSERT INTO legal_holds
          (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
           external_reference_sha256, created_control_generation, created_by_key_id, created_at_ms,
           released_control_generation, released_by_key_id, released_at_ms, release_reason_code)
         VALUES ('tenant_a', ?, 'user', 'user_a', 'active', 'litigation',
                 NULL, 1, 'conflicting-import', 220, NULL, NULL, NULL, NULL)`,
        [holdId],
      );

      await expect(MysqlSessionStore.connect({
        url, migrationsDir: only0015, connectionLimit: 1,
      })).rejects.toThrow(/0015_retention_policy_and_legal_holds|Duplicate entry/i);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0015_retention_policy_and_legal_holds.sql'",
      );
      expect(Number(markers[0]!.count)).toBe(0);
      const [purge] = await conn.query<Row[]>(
        "SELECT available_at_ms, claim_token, lease_until_ms FROM lifecycle_outbox WHERE topic='session.purge'",
      );
      expect(purge[0]).toMatchObject({ available_at_ms: null, claim_token: null, lease_until_ms: null });

      await conn.query("DELETE FROM legal_holds WHERE tenant_id='tenant_a' AND hold_id=?", [holdId]);
      const repaired = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await repaired.close();
      const [holds] = await conn.query<Row[]>(
        "SELECT reason_code, created_by_key_id FROM legal_holds WHERE tenant_id='tenant_a' AND hold_id=?",
        [holdId],
      );
      expect(holds[0]).toMatchObject({
        reason_code: "legacy_unattributed",
        created_by_key_id: "migration-0015",
      });
      await expectDormantPurgeAndPolicy(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("blocks a corrupt generation-one control before creating first-event evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      for (const statement of migrationStatements.slice(0, 6)) await conn.query(statement);
      await conn.query(
        `INSERT INTO legal_hold_controls
          (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
           active_projection_sha256, updated_at_ms)
         VALUES ('tenant_a', 'user', 'user_a', 1, 1, REPEAT('9', 64), 999)`,
      );

      await expect(MysqlSessionStore.connect({
        url, migrationsDir: only0015, connectionLimit: 1,
      })).rejects.toThrow(/0015_retention_policy_and_legal_holds|Duplicate entry/i);
      const [failedState] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0015_retention_policy_and_legal_holds.sql') AS marker_count,
          (SELECT COUNT(*) FROM legal_hold_events
            WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a') AS events`,
      );
      expect(failedState[0]).toMatchObject({ marker_count: 0, events: 0 });
      await expectPurgeUnavailable(conn);

      await conn.query(
        `DELETE FROM legal_hold_controls
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a'`,
      );
      const repaired = await MysqlSessionStore.connect({
        url, migrationsDir: only0015, connectionLimit: 1,
      });
      await repaired.close();

      const holdId = legacyHoldId("tenant_a", "user", "user_a", 220);
      const projection = legalHoldProjectionSha256([{
        tenantId: "tenant_a",
        holdId,
        subjectKind: "user",
        subjectId: "user_a",
        state: "active",
        reasonCode: "legacy_unattributed",
        createdControlGeneration: 1,
        createdByKeyId: "migration-0015",
        createdAtMs: 220,
      }]);
      const [controls] = await conn.query<Row[]>(
        `SELECT control_generation, active_hold_count, active_projection_sha256, updated_at_ms
           FROM legal_hold_controls
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a'`,
      );
      expect(controls[0]).toMatchObject({
        control_generation: 1,
        active_hold_count: 1,
        active_projection_sha256: projection,
        updated_at_ms: 220,
      });
      const [events] = await conn.query<Row[]>(
        `SELECT before_sha256, after_sha256
           FROM legal_hold_events
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_a'
            AND control_generation=1`,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.before_sha256).toBe(legalHoldControlSha256({
        tenantId: "tenant_a",
        subjectKind: "user",
        subjectId: "user_a",
        controlGeneration: 0,
        activeHoldCount: 0,
        activeProjectionSha256: EMPTY_PROJECTION_SHA256,
        updatedAtMs: 0,
      }));
      expect(events[0]!.after_sha256).toBe(legalHoldControlSha256({
        tenantId: "tenant_a",
        subjectKind: "user",
        subjectId: "user_a",
        controlGeneration: 1,
        activeHoldCount: 1,
        activeProjectionSha256: projection,
        updatedAtMs: 220,
      }));
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("guards raw erasure admission against the active policy and restores guards on replay", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      store = await MysqlSessionStore.connect({
        url,
        migrationsDir: runtime0015And0018,
        connectionLimit: 4,
      });
      await expectFinalTriggers(conn);

      // A genuinely absent control and a migrated-but-dormant control both remain compatible with
      // an old writer's NULL/NULL policy pair.
      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000010",
        tenantId: "tenant_without_control",
        userId: "user_without_control",
        atMs: 310,
      })).resolves.toBeDefined();
      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000011",
        tenantId: "tenant_b",
        userId: "user_b",
        atMs: 311,
      })).resolves.toBeDefined();
      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000012",
        tenantId: "tenant_a",
        userId: "user_pre_activation_backlog",
        atMs: 312,
      })).resolves.toBeDefined();

      const version = await store.putRetentionPolicy({
        tenantId: "tenant_a",
        policyVersion: "policy-v1",
        policy: EMPTY_RETENTION_POLICY,
        actorKeyId: "migration-test",
        atMs: 320,
      });
      await store.activateRetentionPolicy({
        tenantId: "tenant_a",
        policyVersion: version.policyVersion,
        expectedControlGeneration: 0,
        actorKeyId: "migration-test",
        atMs: 321,
      });

      const [subjectBefore] = await conn.query<Row[]>(
        `SELECT state, generation, active_request_id, updated_at_ms
           FROM subject_lifecycle
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_clear'`,
      );
      const rejected = [
        {
          requestId: "erase_00000000-0000-4000-8000-000000000020",
        },
        {
          requestId: "erase_00000000-0000-4000-8000-000000000021",
          policyVersion: version.policyVersion,
        },
        {
          requestId: "erase_00000000-0000-4000-8000-000000000022",
          policyHash: version.policySha256,
        },
        {
          requestId: "erase_00000000-0000-4000-8000-000000000023",
          policyVersion: "Policy-v1",
          policyHash: version.policySha256,
        },
        {
          requestId: "erase_00000000-0000-4000-8000-000000000024",
          policyVersion: version.policyVersion,
          policyHash: "b".repeat(64),
        },
      ];
      for (const candidate of rejected) {
        await expect(insertRawErasureRequest(conn, {
          ...candidate,
          tenantId: "tenant_a",
          userId: "user_clear",
          atMs: 330,
        })).rejects.toThrow(/erasure request policy binding rejected/i);
      }
      const [failedState] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM erasure_requests
            WHERE request_id IN (${rejected.map(() => "?").join(",")})) AS requests,
          (SELECT COUNT(*) FROM erasure_audit_events
            WHERE request_id IN (${rejected.map(() => "?").join(",")})) AS audits`,
        [...rejected.map(({ requestId }) => requestId), ...rejected.map(({ requestId }) => requestId)],
      );
      expect(failedState[0]).toMatchObject({ requests: 0, audits: 0 });
      const [subjectAfter] = await conn.query<Row[]>(
        `SELECT state, generation, active_request_id, updated_at_ms
           FROM subject_lifecycle
          WHERE tenant_id='tenant_a' AND subject_kind='user' AND subject_id='user_clear'`,
      );
      expect(subjectAfter).toEqual(subjectBefore);

      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000025",
        tenantId: "tenant_a",
        userId: "user_clear",
        atMs: 331,
        policyVersion: version.policyVersion,
        policyHash: version.policySha256,
      })).resolves.toBeDefined();
      const [matching] = await conn.query<Row[]>(
        `SELECT policy_version, policy_hash, available_at_ms
           FROM erasure_requests
          WHERE request_id='erase_00000000-0000-4000-8000-000000000025'`,
      );
      expect(matching[0]).toMatchObject({
        policy_version: version.policyVersion,
        policy_hash: version.policySha256,
        available_at_ms: 331,
      });

      // Activation does not retroactively reject or rewrite historical work. The INSERT-only guard
      // must leave both a NULL/NULL old-writer row and a differently-bound historical row updateable.
      await expect(conn.query(
        `UPDATE erasure_requests
            SET attempts=attempts+1, updated_at_ms=updated_at_ms+1
          WHERE request_id='erase_00000000-0000-4000-8000-000000000012'`,
      )).resolves.toBeDefined();
      const [nullBacklog] = await conn.query<Row[]>(
        `SELECT attempts, policy_version, policy_hash
           FROM erasure_requests
          WHERE request_id='erase_00000000-0000-4000-8000-000000000012'`,
      );
      expect(nullBacklog[0]).toMatchObject({
        attempts: 1,
        policy_version: null,
        policy_hash: null,
      });
      await expect(conn.query(
        `UPDATE erasure_requests
            SET attempts=attempts+1, updated_at_ms=updated_at_ms+1
          WHERE request_id='erase_11111111-1111-4111-8111-111111111111'`,
      )).resolves.toBeDefined();
      const [backlog] = await conn.query<Row[]>(
        `SELECT attempts, policy_version, policy_hash
           FROM erasure_requests
          WHERE request_id='erase_11111111-1111-4111-8111-111111111111'`,
      );
      expect(backlog[0]).toMatchObject({
        attempts: 5,
        policy_version: "legacy-policy-v1",
        policy_hash: "a".repeat(64),
      });

      await store.close();
      store = undefined;
      await conn.query("DROP TRIGGER trg_erasure_requests_policy_bi_guard_a");
      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0015_retention_policy_and_legal_holds.sql'",
      );
      const replayed = await MysqlSessionStore.connect({
        url, migrationsDir: only0015, connectionLimit: 1,
      });
      await replayed.close();
      await expectFinalTriggers(conn);
      const active = await MysqlSessionStore.connect({
        url, migrationsDir: only0015, connectionLimit: 1,
      });
      expect(await active.getActiveRetentionPolicy("tenant_a")).toMatchObject({
        control: {
          controlGeneration: 1,
          activePolicyVersion: version.policyVersion,
          activePolicySha256: version.policySha256,
        },
      });
      await active.close();
      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000026",
        tenantId: "tenant_a",
        userId: "user_after_replay",
        atMs: 340,
      })).rejects.toThrow(/erasure request policy binding rejected/i);
      await expect(insertRawErasureRequest(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000027",
        tenantId: "tenant_a",
        userId: "user_after_replay",
        atMs: 341,
        policyVersion: version.policyVersion,
        policyHash: version.policySha256,
      })).resolves.toBeDefined();
      await expectPurgeUnavailable(conn);
    } finally {
      await store?.close();
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("linearizes raw legacy admission with retention policy activation in both orders", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let writer: Connection | undefined;
    let activator: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      const setup = await mysql.createConnection({ uri: url, multipleStatements: true });
      await setup.query(fixtureSql);
      await setup.end();
      store = await MysqlSessionStore.connect({
        url,
        migrationsDir: runtime0015And0018,
        connectionLimit: 4,
      });
      writer = await mysql.createConnection(url);
      activator = await mysql.createConnection(url);

      const policyA = await store.putRetentionPolicy({
        tenantId: "tenant_a",
        policyVersion: "policy-a",
        policy: EMPTY_RETENTION_POLICY,
        actorKeyId: "migration-test",
        atMs: 400,
      });
      const policyB = await store.putRetentionPolicy({
        tenantId: "tenant_b",
        policyVersion: "policy-b",
        policy: EMPTY_RETENTION_POLICY,
        actorKeyId: "migration-test",
        atMs: 401,
      });

      // Old admission takes the shared control lock first. Activation cannot commit around it, so
      // the complete NULL/NULL row is visible before the policy becomes active.
      await writer.beginTransaction();
      await insertRawErasureRequest(writer, {
        requestId: "erase_00000000-0000-4000-8000-000000000030",
        tenantId: "tenant_a",
        userId: "user_clear",
        atMs: 410,
      });
      const activateAfterInsert = store.activateRetentionPolicy({
        tenantId: "tenant_a",
        policyVersion: policyA.policyVersion,
        expectedControlGeneration: 0,
        actorKeyId: "migration-test",
        atMs: 411,
      });
      expect(await settlesWithin(activateAfterInsert, 100)).toBe(false);
      await writer.commit();
      await expect(activateAfterInsert).resolves.toMatchObject({
        controlGeneration: 1,
        activePolicyVersion: policyA.policyVersion,
      });
      const [insertFirst] = await writer.query<Row[]>(
        `SELECT policy_version, policy_hash
           FROM erasure_requests
          WHERE request_id='erase_00000000-0000-4000-8000-000000000030'`,
      );
      expect(insertFirst[0]).toMatchObject({ policy_version: null, policy_hash: null });

      // Hold the activation's exclusive control lock through its valid audit write. A legacy insert
      // waits, then observes the committed policy and fails atomically without leaving a request.
      await activator.beginTransaction();
      const [beforeRows] = await activator.query<Row[]>(
        `SELECT control_generation, active_policy_version, active_policy_sha256,
                effective_at_ms, updated_at_ms
           FROM retention_policy_controls
          WHERE tenant_id='tenant_b'
          FOR UPDATE`,
      );
      expect(beforeRows[0]).toMatchObject({
        control_generation: 0,
        active_policy_version: null,
        active_policy_sha256: null,
        effective_at_ms: null,
        updated_at_ms: 0,
      });
      const before = {
        tenantId: "tenant_b",
        controlGeneration: 0,
        updatedAtMs: 0,
      } as const;
      const after = {
        tenantId: "tenant_b",
        controlGeneration: 1,
        activePolicyVersion: policyB.policyVersion,
        activePolicySha256: policyB.policySha256,
        effectiveAtMs: 421,
        updatedAtMs: 421,
      } as const;
      await activator.query(
        `UPDATE retention_policy_controls
            SET control_generation=1, active_policy_version=?, active_policy_sha256=?,
                effective_at_ms=421, updated_at_ms=421
          WHERE tenant_id='tenant_b' AND control_generation=0`,
        [policyB.policyVersion, policyB.policySha256],
      );
      await activator.query(
        `INSERT INTO retention_policy_activation_events
          (tenant_id, control_generation, policy_version, policy_sha256, effective_at_ms,
           actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES ('tenant_b',1,?,?,421,'migration-test',?,?,421)`,
        [
          policyB.policyVersion,
          policyB.policySha256,
          retentionPolicyControlSha256(before),
          retentionPolicyControlSha256(after),
        ],
      );
      const insertAfterActivation = insertRawErasureRequest(writer, {
        requestId: "erase_00000000-0000-4000-8000-000000000031",
        tenantId: "tenant_b",
        userId: "user_b",
        atMs: 422,
      });
      expect(await settlesWithin(insertAfterActivation, 100)).toBe(false);
      await activator.commit();
      await expect(insertAfterActivation).rejects.toThrow(/erasure request policy binding rejected/i);
      const [insertAfter] = await writer.query<Row[]>(
        `SELECT COUNT(*) AS count
           FROM erasure_requests
          WHERE request_id='erase_00000000-0000-4000-8000-000000000031'`,
      );
      expect(Number(insertAfter[0]!.count)).toBe(0);
      expect(await store.getActiveRetentionPolicy("tenant_b")).toMatchObject({
        control: {
          controlGeneration: 1,
          activePolicyVersion: policyB.policyVersion,
          activePolicySha256: policyB.policySha256,
        },
      });
    } finally {
      await writer?.rollback().catch(() => {});
      await activator?.rollback().catch(() => {});
      await writer?.end();
      await activator?.end();
      await store?.close();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  }, 60_000);

  it("enforces append-only evidence and permits only one immutable legal-hold release", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0015, connectionLimit: 1 });
      await store.close();

      const policy = {
        sessionContentRetentionMs: null,
        userErasureGraceMs: null,
        operationalUsageRetentionMs: null,
        idempotencyReceiptRetentionMs: null,
        billingFactRetentionMs: null,
        lifecycleAuditRetentionMs: null,
        exportArtifactTtlMs: null,
      } as const;
      const policyHash = retentionPolicySha256("tenant_a", "policy-v1", policy);
      await conn.query(
        `INSERT INTO retention_policy_versions
          (tenant_id, policy_version, schema_version, session_content_retention_ms,
           user_erasure_grace_ms, operational_usage_retention_ms,
           idempotency_receipt_retention_ms, billing_fact_retention_ms,
           lifecycle_audit_retention_ms, export_artifact_ttl_ms, policy_sha256,
           created_by_key_id, created_at_ms)
         VALUES ('tenant_a','policy-v1',1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,'admin',400)`,
        [policyHash],
      );
      await conn.query(
        `INSERT INTO retention_policy_activation_events
          (tenant_id, control_generation, policy_version, policy_sha256, effective_at_ms,
           actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES ('tenant_a',1,'policy-v1',?,400,'admin',REPEAT('1',64),REPEAT('2',64),400)`,
        [policyHash],
      );

      await expect(conn.query(
        "UPDATE retention_policy_versions SET created_at_ms=401 WHERE tenant_id='tenant_a' AND policy_version='policy-v1'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM retention_policy_versions WHERE tenant_id='tenant_a' AND policy_version='policy-v1'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "UPDATE retention_policy_activation_events SET emitted_at_ms=401 WHERE tenant_id='tenant_a'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM retention_policy_activation_events WHERE tenant_id='tenant_a'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "UPDATE legal_hold_events SET emitted_at_ms=emitted_at_ms WHERE tenant_id='tenant_a'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM legal_hold_events WHERE tenant_id='tenant_a'",
      )).rejects.toThrow(/append-only/i);

      const holdId = legacyHoldId("tenant_a", "user", "user_a", 220);
      await expect(conn.query(
        "UPDATE legal_holds SET subject_id='user_clear' WHERE tenant_id='tenant_a' AND hold_id=?",
        [holdId],
      )).rejects.toThrow(/active-to-released/i);
      await expect(conn.query(
        `UPDATE legal_holds
            SET state='released', released_control_generation=2, released_by_key_id='admin',
                released_at_ms=410, release_reason_code='matter_closed'
          WHERE tenant_id='tenant_a' AND hold_id=?`,
        [holdId],
      )).resolves.toBeDefined();
      await expect(conn.query(
        "UPDATE legal_holds SET released_at_ms=411 WHERE tenant_id='tenant_a' AND hold_id=?",
        [holdId],
      )).rejects.toThrow(/active-to-released/i);
      await expect(conn.query(
        "DELETE FROM legal_holds WHERE tenant_id='tenant_a' AND hold_id=?",
        [holdId],
      )).rejects.toThrow(/cannot be deleted/i);

      const [activeControls] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM retention_policy_controls
          WHERE control_generation <> 0 OR active_policy_version IS NOT NULL
             OR active_policy_sha256 IS NOT NULL OR effective_at_ms IS NOT NULL`,
      );
      expect(Number(activeControls[0]!.count)).toBe(0);
      await expectPurgeUnavailable(conn);
      await expectFinalTriggers(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
