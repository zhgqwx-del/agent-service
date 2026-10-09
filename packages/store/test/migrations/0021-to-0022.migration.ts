import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore, TENANT_PURGE_PLAN_DOMAINS } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0017.sql");
const FROZEN_0020_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0020-delta.sql");
const FROZEN_0021_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0021-delta.sql");
const MIGRATION_NAME = "0022_tenant_purge_plan.sql";
const MIGRATION_PATH = resolve(HERE, `../../migrations/${MIGRATION_NAME}`);

const FROZEN_0021_MIGRATIONS = [
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
  "0015_retention_policy_and_legal_holds.sql",
  "0016_erasure_purge_policy_authority.sql",
  "0017_user_export_jobs_and_artifacts.sql",
  "0018_tenant_credential_revocation_fence.sql",
  "0019_tenant_credential_physical_revocation.sql",
  "0020_tenant_runtime_revocation.sql",
  "0021_tenant_content_inventory.sql",
] as const;

const PLAN_TABLES = [
  "tenant_purge_plan_jobs",
  "tenant_purge_plan_entries",
  "tenant_purge_plan_receipts",
] as const;

const EXPECTED_COLUMNS = {
  tenant_purge_plan_jobs: [
    "request_id", "tenant_id", "subject_generation", "t1_fence_sha256",
    "t3a_receipt_sha256", "t3b_receipt_sha256", "t3c_receipt_sha256", "policy_version",
    "policy_sha256", "policy_schema_version", "build_generation", "retention_anchor_db_ms",
    "purge_not_before_db_ms", "source_evidence_db_ms", "cursor_domain", "scan_complete",
    "plan_entry_count", "plan_entry_root_sha256", "blocker_count", "blocker_root_sha256",
    "phase", "available_at_ms", "attempts", "claim_token", "lease_until_ms",
    "last_error_code", "created_at_ms", "updated_at_ms", "sealed_at_ms",
    "completed_claim_attempt", "completed_claim_token_sha256", "aggregate_receipt_sha256",
    "blocked_at_ms", "blocked_reason_code",
  ],
  tenant_purge_plan_entries: [
    "scope", "request_id", "build_generation", "tenant_id", "subject_generation", "domain",
    "target_count", "target_root_sha256", "disposition", "source_sha256",
    "captured_at_db_ms", "receipt_sha256",
  ],
  tenant_purge_plan_receipts: [
    "scope", "request_id", "tenant_id", "subject_generation", "build_generation",
    "t1_fence_sha256", "t3a_receipt_sha256", "t3b_receipt_sha256", "t3c_receipt_sha256",
    "policy_version", "policy_sha256", "policy_schema_version", "retention_anchor_db_ms",
    "purge_not_before_db_ms", "source_evidence_db_ms", "plan_entry_count",
    "plan_entry_root_sha256", "blocker_count", "blocker_root_sha256",
    "store_db_timestamp_ms", "completed_claim_attempt", "completed_claim_token_sha256",
    "plan_complete", "execution_ready", "content_purge_executed", "receipt_sha256",
  ],
} as const;

const EXPECTED_INDEXES = {
  tenant_purge_plan_jobs: {
    PRIMARY: "0:btree:yes:request_id:-:a:-",
    uk_tenant_purge_plan_jobs_tenant: "0:btree:yes:tenant_id:-:a:-",
    uk_tenant_purge_plan_jobs_generation:
      "0:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-",
    idx_tenant_purge_plan_jobs_claim:
      "1:btree:yes:phase:-:a:-,btree:yes:available_at_ms:-:a:-,btree:yes:lease_until_ms:-:a:-,btree:yes:request_id:-:a:-",
  },
  tenant_purge_plan_entries: {
    PRIMARY:
      "0:btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:domain:-:a:-",
    uk_tenant_purge_plan_entries_hash:
      "0:btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:receipt_sha256:-:a:-",
    idx_tenant_purge_plan_entries_owner:
      "1:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-,btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:domain:-:a:-",
  },
  tenant_purge_plan_receipts: {
    PRIMARY: "0:btree:yes:request_id:-:a:-",
    uk_tenant_purge_plan_receipts_tenant: "0:btree:yes:tenant_id:-:a:-",
    uk_tenant_purge_plan_receipts_generation:
      "0:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-",
    uk_tenant_purge_plan_receipts_hash: "0:btree:yes:receipt_sha256:-:a:-",
  },
} as const;

const EXPECTED_CHECKS = {
  tenant_purge_plan_jobs: [
    "chk_tenant_purge_plan_job_clock",
    "chk_tenant_purge_plan_job_cursor",
    "chk_tenant_purge_plan_job_domain",
    "chk_tenant_purge_plan_job_generations",
    "chk_tenant_purge_plan_job_phase",
    "chk_tenant_purge_plan_job_scan",
    "chk_tenant_purge_plan_job_timestamps",
  ],
  tenant_purge_plan_entries: [
    "chk_tenant_purge_plan_entry_count",
    "chk_tenant_purge_plan_entry_disposition",
    "chk_tenant_purge_plan_entry_domain",
    "chk_tenant_purge_plan_entry_generation",
    "chk_tenant_purge_plan_entry_scope",
    "chk_tenant_purge_plan_entry_time",
  ],
  tenant_purge_plan_receipts: [
    "chk_tenant_purge_plan_receipt_clock",
    "chk_tenant_purge_plan_receipt_completion",
    "chk_tenant_purge_plan_receipt_counts",
    "chk_tenant_purge_plan_receipt_generations",
    "chk_tenant_purge_plan_receipt_scope",
  ],
} as const;

const EXPECTED_TRIGGERS = {
  tenant_purge_plan_jobs: [
    "trg_tenant_purge_plan_jobs_bd", "trg_tenant_purge_plan_jobs_bd_guard_a",
    "trg_tenant_purge_plan_jobs_bd_guard_b", "trg_tenant_purge_plan_jobs_bu",
    "trg_tenant_purge_plan_jobs_bu_guard_a", "trg_tenant_purge_plan_jobs_bu_guard_b",
  ],
  tenant_purge_plan_entries: [
    "trg_tenant_purge_plan_entries_bd", "trg_tenant_purge_plan_entries_bd_guard_a",
    "trg_tenant_purge_plan_entries_bd_guard_b", "trg_tenant_purge_plan_entries_bu",
    "trg_tenant_purge_plan_entries_bu_guard_a", "trg_tenant_purge_plan_entries_bu_guard_b",
  ],
  tenant_purge_plan_receipts: [
    "trg_tenant_purge_plan_receipts_bd", "trg_tenant_purge_plan_receipts_bd_guard_a",
    "trg_tenant_purge_plan_receipts_bd_guard_b", "trg_tenant_purge_plan_receipts_bu",
    "trg_tenant_purge_plan_receipts_bu_guard_a", "trg_tenant_purge_plan_receipts_bu_guard_b",
  ],
} as const;

type Row = RowDataPacket;

function assertDisposableMigrationTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_MIGRATION_TEST_URL must name a test/migration database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(): string {
  const name = `agent_service_migration_test_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 8)}`;
  if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error("unsafe generated migration database name");
  }
  return name;
}

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function infoSchemaField(row: Row, name: string): unknown {
  return row[name] ?? row[name.toUpperCase()];
}

async function installFrozen0021(
  conn: Connection,
  baseFixtureSql: string,
  frozen0020DeltaSql: string,
  frozen0021DeltaSql: string,
): Promise<void> {
  await conn.query(baseFixtureSql);
  await conn.query(frozen0020DeltaSql);
  await conn.query(frozen0021DeltaSql);
  const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0021_MIGRATIONS);
}

async function seedHistorical0021Evidence(conn: Connection): Promise<void> {
  const requestId = "erase_21000000-0000-4000-8000-000000000021";
  await conn.query(
    `INSERT INTO tenant_content_inventory_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256,
        t3a_receipt_sha256, t3b_receipt_sha256, policy_version, policy_sha256,
        policy_schema_version, build_generation, retention_anchor_db_ms,
        content_not_before_db_ms, cursor_session_id, scan_complete,
        session_receipt_count, session_receipt_root_sha256, phase, available_at_ms,
        attempts, claim_token, lease_until_ms, last_error_code, created_at_ms,
        updated_at_ms, sealed_at_ms, completed_claim_attempt,
        completed_claim_token_sha256, aggregate_receipt_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, 'tenant-frozen-0021', 1, REPEAT('1',64), REPEAT('2',64), REPEAT('3',64),
             'policy-v1', REPEAT('4',64), 1, 1, 4000, 4000,
             'sess_21000000-0000-7000-8000-000000000021', TRUE, 1, REPEAT('5',64),
             'inventory_sealed', NULL, 1, NULL, NULL, NULL, 4000, 4001, 4001, 1,
             REPEAT('6',64), REPEAT('7',64), NULL, NULL)`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO session_content_receipts
       (scope, request_id, build_generation, tenant_id, subject_generation, session_id,
        session_sha256, turn_count, turn_root_sha256, item_count, item_root_sha256,
        event_count, event_root_sha256, approval_count, approval_root_sha256,
        content_record_count, content_root_sha256, captured_at_db_ms, receipt_sha256)
     VALUES ('tenant-session-content-v1', ?, 1, 'tenant-frozen-0021', 1,
             'sess_21000000-0000-7000-8000-000000000021', REPEAT('8',64),
             0, REPEAT('9',64), 0, REPEAT('a',64), 0, REPEAT('b',64),
             0, REPEAT('c',64), 1, REPEAT('d',64), 4000, REPEAT('e',64))`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_content_inventory_receipts
       (scope, request_id, tenant_id, subject_generation, build_generation,
        t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, policy_version,
        policy_sha256, policy_schema_version, retention_anchor_db_ms,
        content_not_before_db_ms, session_receipt_count, session_receipt_root_sha256,
        content_record_count, hold_control_count, hold_root_sha256, global_orphan_check,
        store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
        content_inventory_complete, content_purge_executed, receipt_sha256)
     VALUES ('tenant-content-inventory-v1', ?, 'tenant-frozen-0021', 1, 1,
             REPEAT('1',64), REPEAT('2',64), REPEAT('3',64), 'policy-v1',
             REPEAT('4',64), 1, 4000, 4000, 1, REPEAT('5',64), 1, 0,
             REPEAT('f',64), 'passed', 4001, 1, REPEAT('6',64), TRUE, FALSE,
             REPEAT('7',64))`,
    [requestId],
  );
}

async function historical0021Snapshot(conn: Connection): Promise<unknown> {
  const tables = [
    "tenant_content_inventory_jobs",
    "session_content_receipts",
    "tenant_content_inventory_receipts",
    "tenant_credential_revocation_receipts",
    "tenant_runtime_revocation_receipts",
    "retention_policy_versions",
    "legal_hold_controls",
  ];
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table}`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

async function expectPlanTablesEmpty(conn: Connection): Promise<void> {
  for (const table of PLAN_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
    expect(Number(rows[0]!.count), `${table} must not be backfilled`).toBe(0);
  }
}

async function assert0022Schema(conn: Connection): Promise<void> {
  const [tables] = await conn.query<Row[]>(
    `SELECT table_name, table_type, engine, table_collation
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN (?) ORDER BY table_name`,
    [PLAN_TABLES],
  );
  expect(tables).toHaveLength(PLAN_TABLES.length);
  for (const row of tables) {
    expect(String(infoSchemaField(row, "table_type"))).toBe("BASE TABLE");
    expect(String(infoSchemaField(row, "engine"))).toBe("InnoDB");
    expect(String(infoSchemaField(row, "table_collation"))).toBe("utf8mb4_0900_as_cs");
  }
  const [columns] = await conn.query<Row[]>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name IN (?)
      ORDER BY table_name, ordinal_position`,
    [PLAN_TABLES],
  );
  for (const table of PLAN_TABLES) {
    expect(columns.filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => String(infoSchemaField(row, "column_name"))))
      .toEqual(EXPECTED_COLUMNS[table]);
  }
  const [indexes] = await conn.query<Row[]>(
    `SELECT table_name, index_name, MIN(non_unique) AS non_unique,
            GROUP_CONCAT(CONCAT(LOWER(index_type), ':', LOWER(is_visible), ':',
              IFNULL(column_name, '<expression>'), ':', IFNULL(CAST(sub_part AS CHAR), '-'), ':',
              LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
              ORDER BY seq_in_index SEPARATOR ',') AS columns_fingerprint
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name IN (?)
      GROUP BY table_name, index_name`,
    [PLAN_TABLES],
  );
  for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
    const actual = Object.fromEntries(indexes
      .filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => [
        String(infoSchemaField(row, "index_name")),
        `${Number(infoSchemaField(row, "non_unique"))}:${String(infoSchemaField(row, "columns_fingerprint"))}`,
      ]));
    expect(actual).toEqual(expected);
  }
  const [checks] = await conn.query<Row[]>(
    `SELECT table_name, constraint_name, enforced
       FROM information_schema.table_constraints
      WHERE table_schema=DATABASE() AND constraint_type='CHECK' AND table_name IN (?)
      ORDER BY table_name, constraint_name`,
    [PLAN_TABLES],
  );
  for (const table of PLAN_TABLES) {
    const actual = checks.filter((row) => String(infoSchemaField(row, "table_name")) === table);
    expect(actual.map((row) => String(infoSchemaField(row, "constraint_name"))))
      .toEqual(EXPECTED_CHECKS[table]);
    expect(actual.every((row) => String(infoSchemaField(row, "enforced")) === "YES")).toBe(true);
  }
  const [triggers] = await conn.query<Row[]>(
    `SELECT event_object_table AS table_name, trigger_name FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table IN (?)
      ORDER BY event_object_table, trigger_name`,
    [PLAN_TABLES],
  );
  for (const table of PLAN_TABLES) {
    expect(triggers.filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => String(infoSchemaField(row, "trigger_name"))))
      .toEqual(EXPECTED_TRIGGERS[table]);
  }
  const entryColumns = EXPECTED_COLUMNS.tenant_purge_plan_entries;
  for (const forbidden of [
    "user_id", "session_id", "storage_key", "locator", "url", "secret", "claim_token",
    "target_id", "target_payload", "error_text",
  ]) expect(entryColumns).not.toContain(forbidden as never);
}

async function seedPlanEvidence(conn: Connection): Promise<void> {
  const requestId = "erase_22000000-0000-4000-8000-000000000022";
  await conn.query(
    `INSERT INTO tenant_purge_plan_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256, t3a_receipt_sha256,
        t3b_receipt_sha256, t3c_receipt_sha256, policy_version, policy_sha256,
        policy_schema_version, build_generation, retention_anchor_db_ms,
        purge_not_before_db_ms, source_evidence_db_ms, cursor_domain, scan_complete,
        plan_entry_count, plan_entry_root_sha256, blocker_count, blocker_root_sha256,
        phase, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
        created_at_ms, updated_at_ms, sealed_at_ms, completed_claim_attempt,
        completed_claim_token_sha256, aggregate_receipt_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, 'tenant-plan-replay', 1, REPEAT('1',64), REPEAT('2',64), REPEAT('3',64),
             REPEAT('4',64), 'policy-v1', REPEAT('5',64), 1, 1, 5000, 5000, 5001,
             'traces', TRUE, 33, REPEAT('6',64), 6, REPEAT('7',64), 'plan_sealed',
             NULL, 1, NULL, NULL, NULL, 5001, 5002, 5002, 1, REPEAT('8',64),
             REPEAT('9',64), NULL, NULL)`,
    [requestId],
  );
  const blocking = new Map<string, string>([
    ["external_provider", "blocked_legacy_external_source_unavailable"],
    ["kms", "blocked_adapter_unconfigured"],
    ["backup_ledger", "blocked_adapter_unconfigured"],
    ["restore_ledger", "blocked_restore_replay_unproven"],
    ["logs", "blocked_adapter_unconfigured"],
    ["traces", "blocked_adapter_unconfigured"],
  ]);
  for (const [index, domain] of TENANT_PURGE_PLAN_DOMAINS.entries()) {
    await conn.query(
      `INSERT INTO tenant_purge_plan_entries
         (scope, request_id, build_generation, tenant_id, subject_generation, domain,
          target_count, target_root_sha256, disposition, source_sha256,
          captured_at_db_ms, receipt_sha256)
       VALUES ('tenant-purge-plan-entry-v1', ?, 1, 'tenant-plan-replay', 1, ?, 0,
               REPEAT('a',64), ?, REPEAT('b',64), 5001, ?)`,
      [requestId, domain, blocking.get(domain) ?? "delete", (index + 1).toString(16).padStart(64, "0")],
    );
  }
  await conn.query(
    `INSERT INTO tenant_purge_plan_receipts
       (scope, request_id, tenant_id, subject_generation, build_generation, t1_fence_sha256,
        t3a_receipt_sha256, t3b_receipt_sha256, t3c_receipt_sha256, policy_version,
        policy_sha256, policy_schema_version, retention_anchor_db_ms, purge_not_before_db_ms,
        source_evidence_db_ms, plan_entry_count, plan_entry_root_sha256, blocker_count,
        blocker_root_sha256, store_db_timestamp_ms, completed_claim_attempt,
        completed_claim_token_sha256, plan_complete, execution_ready,
        content_purge_executed, receipt_sha256)
     VALUES ('tenant-purge-plan-v1', ?, 'tenant-plan-replay', 1, 1, REPEAT('1',64),
             REPEAT('2',64), REPEAT('3',64), REPEAT('4',64), 'policy-v1', REPEAT('5',64),
             1, 5000, 5000, 5001, 33, REPEAT('6',64), 6, REPEAT('7',64), 5002, 1,
             REPEAT('8',64), TRUE, FALSE, FALSE, REPEAT('9',64))`,
    [requestId],
  );
}

async function planSnapshot(conn: Connection): Promise<unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const table of PLAN_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table}`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

async function expectMigrationFailure(
  url: string,
  only0022: string,
  matcher: RegExp,
): Promise<void> {
  let failure: unknown;
  try {
    await MysqlSessionStore.connect({ url, migrationsDir: only0022, connectionLimit: 1 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    /migration 0022_tenant_purge_plan\.sql failed at statement \d+\/\d+/,
  );
  const cause = (failure as Error & {
    cause?: { code?: string; sqlMessage?: string; message?: string };
  }).cause;
  expect(cause?.sqlMessage ?? cause?.message).toMatch(matcher);
}

describe("real MySQL historical upgrade: 0021 -> 0022", () => {
  let baseUrl: URL;
  let admin: Connection;
  let baseFixtureSql: string;
  let frozen0020DeltaSql: string;
  let frozen0021DeltaSql: string;
  let migrationSql: string;
  let only0022: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    baseFixtureSql = await readFile(BASE_FIXTURE_PATH, "utf8");
    frozen0020DeltaSql = await readFile(FROZEN_0020_DELTA_PATH, "utf8");
    frozen0021DeltaSql = await readFile(FROZEN_0021_DELTA_PATH, "utf8");
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
    expect(frozen0021DeltaSql).toContain("CREATE TABLE IF NOT EXISTS tenant_content_inventory_jobs");
    expect(frozen0021DeltaSql).not.toContain("tenant_purge_plan_jobs");
    expect(migrationSql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+tenant_/i);
    only0022 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0022-"));
    await copyFile(MIGRATION_PATH, join(only0022, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0022) await rm(only0022, { recursive: true, force: true });
  });

  it("preserves frozen 0021 evidence byte-for-byte and performs no plan backfill", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      await seedHistorical0021Evidence(conn);
      const before = await historical0021Snapshot(conn);
      const migrated = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await migrated.close();
      expect(await historical0021Snapshot(conn)).toEqual(before);
      await expectPlanTablesEmpty(conn);
      await assert0022Schema(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after the first table auto-commit without a marker", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      const boundary = migrationSql.indexOf("-- Exactly one content-free row per fixed catalog domain.");
      expect(boundary).toBeGreaterThan(0);
      await conn.query("SET SESSION group_concat_max_len=16");
      await conn.query(migrationSql.slice(0, boundary));
      const [partial] = await conn.query<Row[]>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?)",
        [PLAN_TABLES],
      );
      expect(partial.map((row) => String(infoSchemaField(row, "table_name"))))
        .toEqual(["tenant_purge_plan_jobs"]);
      const replay = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await replay.close();
      await expectPlanTablesEmpty(conn);
      await assert0022Schema(conn);
      const [concatLimit] = await conn.query<Row[]>("SELECT @@SESSION.group_concat_max_len AS value");
      // The simulated interrupted connection remains at the migration's explicit fingerprint
      // buffer; the replay connection restores its own previous value before it is returned.
      expect(Number(concatLimit[0]!.value)).toBe(1_048_576);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays marker loss without rewriting plan evidence and keeps blockers non-authoritative", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await first.close();
      await seedPlanEvidence(conn);
      const before = await planSnapshot(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      const replay = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await replay.close();
      expect(await planSnapshot(conn)).toEqual(before);
      const [receipt] = await conn.query<Row[]>(
        "SELECT plan_complete, execution_ready, content_purge_executed FROM tenant_purge_plan_receipts",
      );
      expect(Number(receipt[0]!.plan_complete)).toBe(1);
      expect(Number(receipt[0]!.execution_ready)).toBe(0);
      expect(Number(receipt[0]!.content_purge_executed)).toBe(0);
      await expect(conn.query(
        "UPDATE tenant_purge_plan_entries SET target_count=1 WHERE domain='logs'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM tenant_purge_plan_receipts WHERE tenant_id='tenant-plan-replay'",
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "UPDATE tenant_purge_plan_jobs SET updated_at_ms=5003 WHERE tenant_id='tenant-plan-replay'",
      )).rejects.toThrow(/not permitted/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("rejects execution-ready or content-purged aggregate receipts", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      const migrated = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await migrated.close();
      const insert = (executionReady: boolean, contentPurged: boolean, suffix: string) => conn!.query(
        `INSERT INTO tenant_purge_plan_receipts
           (scope, request_id, tenant_id, subject_generation, build_generation,
            t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, t3c_receipt_sha256,
            policy_version, policy_sha256, policy_schema_version, retention_anchor_db_ms,
            purge_not_before_db_ms, source_evidence_db_ms, plan_entry_count,
            plan_entry_root_sha256, blocker_count, blocker_root_sha256,
            store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
            plan_complete, execution_ready, content_purge_executed, receipt_sha256)
         VALUES ('tenant-purge-plan-v1', ?, ?, 1, 1, REPEAT('1',64), REPEAT('2',64),
                 REPEAT('3',64), REPEAT('4',64), 'policy-v1', REPEAT('5',64), 1,
                 5000, 5000, 5001, 33, REPEAT('6',64), 1, REPEAT('7',64), 5002,
                 1, REPEAT('8',64), TRUE, ?, ?, REPEAT(?,64))`,
        [
          `erase_22000000-0000-4000-8000-0000000000${suffix}`,
          `tenant-non-destructive-${suffix}`,
          executionReady,
          contentPurged,
          suffix.slice(0, 1),
        ],
      );
      await expect(insert(true, false, "2a")).rejects.toMatchObject({
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
        sqlMessage: expect.stringMatching(/chk_tenant_purge_plan_receipt_completion/i),
      });
      await expect(insert(false, true, "2b")).rejects.toMatchObject({
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
        sqlMessage: expect.stringMatching(/chk_tenant_purge_plan_receipt_completion/i),
      });
      await expectPlanTablesEmpty(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed on a wrong same-name job index and extra sensitive column", async () => {
    for (const mutation of [
      `ALTER TABLE tenant_purge_plan_jobs DROP INDEX idx_tenant_purge_plan_jobs_claim,
         ADD KEY idx_tenant_purge_plan_jobs_claim (phase, request_id)`,
      "ALTER TABLE tenant_purge_plan_jobs ADD COLUMN leaked_secret TEXT NULL",
    ]) {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(baseUrl, database);
      let conn: Connection | undefined;
      try {
        conn = await mysql.createConnection({ uri: url, multipleStatements: true });
        await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
        const boundary = migrationSql.indexOf("-- Exactly one content-free row per fixed catalog domain.");
        await conn.query(migrationSql.slice(0, boundary));
        await conn.query(mutation);
        await expectMigrationFailure(url, only0022!, /invalid_tenant_purge_plan_jobs_(?:index_shape|schema)/i);
        const [marker] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
        );
        expect(Number(marker[0]!.count)).toBe(0);
      } finally {
        await conn?.end();
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
    }
  });

  it("fails closed when a same-name CHECK is weakened", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      const boundary = migrationSql.indexOf("-- Exactly one content-free row per fixed catalog domain.");
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query(
        `ALTER TABLE tenant_purge_plan_jobs
           DROP CHECK chk_tenant_purge_plan_job_scan,
           ADD CONSTRAINT chk_tenant_purge_plan_job_scan CHECK (TRUE)`,
      );
      await expectMigrationFailure(url, only0022!, /invalid_tenant_purge_plan_jobs_schema/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when marker-loss replay finds an unknown trigger", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0021(conn, baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0022!, connectionLimit: 1,
      });
      await first.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query(
        `CREATE TRIGGER trg_tenant_purge_plan_jobs_unexpected_bi
           BEFORE INSERT ON tenant_purge_plan_jobs FOR EACH ROW SET NEW.attempts=NEW.attempts`,
      );
      await expectMigrationFailure(url, only0022!, /invalid_tenant_purge_plan_trigger_set/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
