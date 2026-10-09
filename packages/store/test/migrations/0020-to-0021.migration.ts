import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0017.sql");
const FROZEN_0020_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0020-delta.sql");
const MIGRATION_NAME = "0021_tenant_content_inventory.sql";
const MIGRATION_PATH = resolve(HERE, `../../migrations/${MIGRATION_NAME}`);

const FROZEN_0020_MIGRATIONS = [
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
] as const;

const CONTENT_TABLES = [
  "tenant_content_inventory_jobs",
  "session_content_receipts",
  "tenant_content_inventory_receipts",
] as const;

const EXPECTED_COLUMNS = {
  tenant_content_inventory_jobs: [
    "request_id", "tenant_id", "subject_generation", "t1_fence_sha256",
    "t3a_receipt_sha256", "t3b_receipt_sha256", "policy_version", "policy_sha256",
    "policy_schema_version", "build_generation", "retention_anchor_db_ms",
    "content_not_before_db_ms", "cursor_session_id", "scan_complete",
    "session_receipt_count", "session_receipt_root_sha256", "phase", "available_at_ms",
    "attempts", "claim_token", "lease_until_ms", "last_error_code", "created_at_ms",
    "updated_at_ms", "sealed_at_ms", "completed_claim_attempt",
    "completed_claim_token_sha256", "aggregate_receipt_sha256", "blocked_at_ms",
    "blocked_reason_code",
  ],
  session_content_receipts: [
    "scope", "request_id", "build_generation", "tenant_id", "subject_generation",
    "session_id", "session_sha256", "turn_count", "turn_root_sha256", "item_count",
    "item_root_sha256", "event_count", "event_root_sha256", "approval_count",
    "approval_root_sha256", "content_record_count", "content_root_sha256",
    "captured_at_db_ms", "receipt_sha256",
  ],
  tenant_content_inventory_receipts: [
    "scope", "request_id", "tenant_id", "subject_generation", "build_generation",
    "t1_fence_sha256", "t3a_receipt_sha256", "t3b_receipt_sha256", "policy_version",
    "policy_sha256", "policy_schema_version", "retention_anchor_db_ms",
    "content_not_before_db_ms", "session_receipt_count", "session_receipt_root_sha256",
    "content_record_count", "hold_control_count", "hold_root_sha256",
    "global_orphan_check", "store_db_timestamp_ms", "completed_claim_attempt",
    "completed_claim_token_sha256", "content_inventory_complete", "content_purge_executed",
    "receipt_sha256",
  ],
} as const;

const EXPECTED_INDEXES = {
  approvals: {
    idx_approvals_session_identity:
      "1:btree:yes:session_id:-:a:-,btree:yes:approval_id:-:a:-",
  },
  tenant_content_inventory_jobs: {
    PRIMARY: "0:btree:yes:request_id:-:a:-",
    uk_tenant_content_jobs_tenant: "0:btree:yes:tenant_id:-:a:-",
    uk_tenant_content_jobs_generation:
      "0:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-",
    idx_tenant_content_jobs_claim:
      "1:btree:yes:phase:-:a:-,btree:yes:available_at_ms:-:a:-,btree:yes:lease_until_ms:-:a:-,btree:yes:request_id:-:a:-",
  },
  session_content_receipts: {
    PRIMARY:
      "0:btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:session_id:-:a:-",
    uk_session_content_receipt_hash:
      "0:btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:receipt_sha256:-:a:-",
    idx_session_content_receipt_owner:
      "1:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-,btree:yes:request_id:-:a:-,btree:yes:build_generation:-:a:-,btree:yes:session_id:-:a:-",
  },
  tenant_content_inventory_receipts: {
    PRIMARY: "0:btree:yes:request_id:-:a:-",
    uk_tenant_content_receipts_tenant: "0:btree:yes:tenant_id:-:a:-",
    uk_tenant_content_receipts_generation:
      "0:btree:yes:tenant_id:-:a:-,btree:yes:subject_generation:-:a:-",
    uk_tenant_content_receipts_hash: "0:btree:yes:receipt_sha256:-:a:-",
  },
} as const;

const EXPECTED_CHECKS = {
  tenant_content_inventory_jobs: [
    "chk_tenant_content_job_anchor",
    "chk_tenant_content_job_cursor",
    "chk_tenant_content_job_generations",
    "chk_tenant_content_job_phase",
    "chk_tenant_content_job_scan_complete",
    "chk_tenant_content_job_timestamps",
  ],
  session_content_receipts: [
    "chk_session_content_receipt_count",
    "chk_session_content_receipt_generation",
    "chk_session_content_receipt_scope",
    "chk_session_content_receipt_time",
  ],
  tenant_content_inventory_receipts: [
    "chk_tenant_content_receipt_anchor",
    "chk_tenant_content_receipt_completion",
    "chk_tenant_content_receipt_counts",
    "chk_tenant_content_receipt_generations",
    "chk_tenant_content_receipt_scope",
  ],
} as const;

const EXPECTED_TRIGGERS = {
  tenant_content_inventory_jobs: [
    "trg_tenant_content_jobs_bd",
    "trg_tenant_content_jobs_bd_guard_a",
    "trg_tenant_content_jobs_bd_guard_b",
    "trg_tenant_content_jobs_bu",
    "trg_tenant_content_jobs_bu_guard_a",
    "trg_tenant_content_jobs_bu_guard_b",
  ],
  session_content_receipts: [
    "trg_session_content_receipts_bd",
    "trg_session_content_receipts_bd_guard_a",
    "trg_session_content_receipts_bd_guard_b",
    "trg_session_content_receipts_bu",
    "trg_session_content_receipts_bu_guard_a",
    "trg_session_content_receipts_bu_guard_b",
  ],
  tenant_content_inventory_receipts: [
    "trg_tenant_content_receipts_bd",
    "trg_tenant_content_receipts_bd_guard_a",
    "trg_tenant_content_receipts_bd_guard_b",
    "trg_tenant_content_receipts_bu",
    "trg_tenant_content_receipts_bu_guard_a",
    "trg_tenant_content_receipts_bu_guard_b",
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

async function installFrozen0020(
  conn: Connection,
  baseFixtureSql: string,
  frozen0020DeltaSql: string,
): Promise<void> {
  await conn.query(baseFixtureSql);
  await conn.query(frozen0020DeltaSql);
  const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0020_MIGRATIONS);
}

async function seedHistoricalT1T3aT3b(conn: Connection): Promise<void> {
  const requestId = "erase_00000000-0000-4000-8000-000000000020";
  await conn.query(
    `INSERT INTO tenant_erasure_admissions
       (request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
        request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
        control_generation)
     VALUES (?, 'tenant_a', 1, 'platform-lifecycle-admin', 'frozen-t3c-upgrade',
             REPEAT('a',64), 2000, 2000, 2000, 'policy-v1', REPEAT('b',64), 1)`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_credential_revocation_fences
       (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
     VALUES ('tenant_a', ?, 1, 2000, REPEAT('c',64))`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_credential_revocation_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256, phase,
        available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
        created_at_ms, updated_at_ms, credential_store_revoked_at_ms,
        completed_claim_attempt, completed_claim_token_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, 'tenant_a', 1, REPEAT('c',64), 'credential_store_revoked',
             NULL, 1, NULL, NULL, NULL, 2001, 2002, 2002, 1, REPEAT('d',64), NULL, NULL)`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_credential_revocation_receipts
       (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
        api_key_count_before, api_key_count_after, provider_config_count_before,
        provider_config_count_after, auth_policy_present_before, auth_policy_present_after,
        auth_secret_cipher_present_before, auth_secret_cipher_present_after,
        auth_secret_key_id_present_before, auth_secret_key_id_present_after,
        store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
        runtime_disposition, external_disposition, content_purge_required, receipt_sha256)
     VALUES (?, 'tenant_a', 1, 'local-db-credential-material-v1', REPEAT('c',64),
             2, 0, 1, 0, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, 2002, 1,
             REPEAT('d',64), 'not_in_scope', 'not_supported', TRUE, REPEAT('e',64))`,
    [requestId],
  );
  await conn.query(
    `UPDATE tenant_credential_revocation_cutover
        SET control_generation=1, activated_at_ms=2002,
            first_receipt_sha256=REPEAT('e',64), evidence_sha256=REPEAT('f',64)
      WHERE singleton_id=1 AND control_generation=0`,
  );
  await conn.query(
    `INSERT INTO tenant_runtime_revocation_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256,
        t3a_receipt_sha256, phase, available_at_ms, attempts, claim_token,
        lease_until_ms, last_error_code, created_at_ms, updated_at_ms,
        configured_fleet_quiesced_at_ms, completed_claim_attempt,
        completed_claim_token_sha256, blocked_at_ms, blocked_reason_code)
     VALUES (?, 'tenant_a', 1, REPEAT('c',64), REPEAT('e',64),
             'configured_fleet_quiesced', NULL, 1, NULL, NULL, NULL,
             2003, 2004, 2004, 1, REPEAT('1',64), NULL, NULL)`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_runtime_revocation_target_receipts
       (request_id, target_sha256, tenant_id, subject_generation, scope,
        runner_id_sha256, boot_id_sha256, t1_fence_sha256, t3a_receipt_sha256,
        fleet_sha256, cache_entry_count_before, cache_entry_count_after,
        active_operation_count_before, active_operation_count_after,
        active_turn_count_before, active_turn_count_after, runner_completed_at_ms,
        local_receipt_sha256, completed_claim_attempt,
        completed_claim_token_sha256, evidence_sha256)
     VALUES (?, REPEAT('2',64), 'tenant_a', 1, 'configured-runner-runtime-v1',
             REPEAT('3',64), REPEAT('4',64), REPEAT('c',64), REPEAT('e',64),
             REPEAT('5',64), 3, 0, 2, 0, 1, 0, 2004, REPEAT('6',64), 1,
             REPEAT('1',64), REPEAT('7',64))`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_runtime_revocation_receipts
       (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
        t3a_receipt_sha256, fleet_sha256, target_count, target_receipts_sha256,
        store_db_timestamp_ms, completed_claim_attempt,
        completed_claim_token_sha256, memory_disposition, external_disposition,
        content_purge_required, receipt_sha256)
     VALUES (?, 'tenant_a', 1, 'configured-fleet-runtime-v1', REPEAT('c',64),
             REPEAT('e',64), REPEAT('5',64), 1, REPEAT('8',64), 2004, 1,
             REPEAT('1',64), 'references_dropped_not_zeroized', 'not_supported',
             TRUE, REPEAT('9',64))`,
    [requestId],
  );
}

async function historicalProofSnapshot(conn: Connection): Promise<unknown> {
  const tables = [
    "tenant_erasure_admissions",
    "tenant_credential_revocation_fences",
    "tenant_credential_revocation_jobs",
    "tenant_credential_revocation_receipts",
    "tenant_credential_revocation_cutover",
    "tenant_runtime_revocation_jobs",
    "tenant_runtime_revocation_target_receipts",
    "tenant_runtime_revocation_receipts",
  ];
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table}`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

async function expectContentTablesEmpty(conn: Connection): Promise<void> {
  for (const table of CONTENT_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
    expect(Number(rows[0]!.count), `${table} must not be backfilled`).toBe(0);
  }
}

async function assert0021Schema(conn: Connection): Promise<void> {
  const [tables] = await conn.query<Row[]>(
    `SELECT table_name, table_type, engine, table_collation
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN (?)
      ORDER BY table_name`,
    [CONTENT_TABLES],
  );
  expect(tables).toHaveLength(CONTENT_TABLES.length);
  for (const row of tables) {
    expect(String(infoSchemaField(row, "table_type"))).toBe("BASE TABLE");
    expect(String(infoSchemaField(row, "engine"))).toBe("InnoDB");
    expect(String(infoSchemaField(row, "table_collation"))).toBe("utf8mb4_0900_as_cs");
  }

  const [columns] = await conn.query<Row[]>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name IN (?)
      ORDER BY table_name, ordinal_position`,
    [CONTENT_TABLES],
  );
  for (const table of CONTENT_TABLES) {
    expect(columns.filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => String(infoSchemaField(row, "column_name"))))
      .toEqual(EXPECTED_COLUMNS[table]);
  }

  const [indexes] = await conn.query<Row[]>(
    `SELECT table_name, index_name, MIN(non_unique) AS non_unique,
            GROUP_CONCAT(CONCAT(
              LOWER(index_type), ':', LOWER(is_visible), ':',
              IFNULL(column_name, '<expression>'), ':',
              IFNULL(CAST(sub_part AS CHAR), '-'), ':',
              LOWER(IFNULL(collation, '-')), ':', IFNULL(expression, '-'))
              ORDER BY seq_in_index SEPARATOR ',') AS columns_fingerprint
       FROM information_schema.statistics
      WHERE table_schema=DATABASE()
        AND table_name IN ('approvals', 'tenant_content_inventory_jobs',
                           'session_content_receipts', 'tenant_content_inventory_receipts')
      GROUP BY table_name, index_name`,
  );
  for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
    const actual = Object.fromEntries(indexes
      .filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .filter((row) => Object.hasOwn(expected, String(infoSchemaField(row, "index_name"))))
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
    [CONTENT_TABLES],
  );
  for (const table of CONTENT_TABLES) {
    const tableChecks = checks.filter(
      (row) => String(infoSchemaField(row, "table_name")) === table,
    );
    expect(tableChecks.map((row) => String(infoSchemaField(row, "constraint_name"))))
      .toEqual(EXPECTED_CHECKS[table]);
    expect(tableChecks.every((row) => String(infoSchemaField(row, "enforced")) === "YES"))
      .toBe(true);
  }

  const [triggers] = await conn.query<Row[]>(
    `SELECT event_object_table AS table_name, trigger_name
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table IN (?)
      ORDER BY event_object_table, trigger_name`,
    [CONTENT_TABLES],
  );
  for (const table of CONTENT_TABLES) {
    expect(triggers.filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => String(infoSchemaField(row, "trigger_name"))))
      .toEqual(EXPECTED_TRIGGERS[table]);
  }

  const receiptColumns = [
    ...EXPECTED_COLUMNS.session_content_receipts,
    ...EXPECTED_COLUMNS.tenant_content_inventory_receipts,
  ];
  for (const forbidden of [
    "body", "title", "metadata", "user_id", "idempotency_key", "blob_sha256",
    "storage_key", "url", "secret", "claim_token",
  ]) {
    expect(receiptColumns).not.toContain(forbidden);
  }
}

async function seedContentInventoryEvidence(conn: Connection): Promise<void> {
  const requestId = "erase_10000000-0000-4000-8000-000000000021";
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
     VALUES (?, 'tenant-replay', 1, REPEAT('1',64), REPEAT('2',64), REPEAT('3',64),
             'policy-v1', REPEAT('4',64), 1, 1, 4000, 4000,
             'sess_10000000-0000-7000-8000-000000000021', TRUE, 1, REPEAT('5',64),
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
     VALUES ('tenant-session-content-v1', ?, 1, 'tenant-replay', 1,
             'sess_10000000-0000-7000-8000-000000000021', REPEAT('8',64),
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
     VALUES ('tenant-content-inventory-v1', ?, 'tenant-replay', 1, 1,
             REPEAT('1',64), REPEAT('2',64), REPEAT('3',64), 'policy-v1',
             REPEAT('4',64), 1, 4000, 4000, 1, REPEAT('5',64), 1, 1,
             REPEAT('f',64), 'passed', 4001, 1, REPEAT('6',64), TRUE, FALSE,
             REPEAT('7',64))`,
    [requestId],
  );
}

async function contentInventorySnapshot(conn: Connection): Promise<unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const table of CONTENT_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table}`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

describe("real MySQL historical upgrade: 0020 -> 0021", () => {
  let baseUrl: URL;
  let admin: Connection;
  let baseFixtureSql: string;
  let frozen0020DeltaSql: string;
  let migrationSql: string;
  let only0021: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    baseFixtureSql = await readFile(BASE_FIXTURE_PATH, "utf8");
    frozen0020DeltaSql = await readFile(FROZEN_0020_DELTA_PATH, "utf8");
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
    expect(baseFixtureSql).toContain("CREATE TABLE approvals");
    expect(frozen0020DeltaSql).toContain("CREATE TABLE IF NOT EXISTS tenant_runtime_revocation_jobs");
    expect(frozen0020DeltaSql).not.toContain("tenant_content_inventory_jobs");
    only0021 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0021-"));
    await copyFile(MIGRATION_PATH, join(only0021, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0021) await rm(only0021, { recursive: true, force: true });
  });

  it("preserves T1/T3a/T3b evidence byte-for-byte and performs no content backfill", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      await seedHistoricalT1T3aT3b(conn);
      const before = await historicalProofSnapshot(conn);

      const migrated = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await migrated.close();

      expect(await historicalProofSnapshot(conn)).toEqual(before);
      await expectContentTablesEmpty(conn);
      await assert0021Schema(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after approval index and the first table auto-commit without a marker", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      expect(boundary).toBeGreaterThan(0);
      // The migration must not inherit a deployment-specific low GROUP_CONCAT limit: its schema
      // fingerprints are intentionally longer than MySQL's small historical defaults.
      await conn.query("SET SESSION group_concat_max_len=16");
      await conn.query(migrationSql.slice(0, boundary));
      const [concatLimit] = await conn.query<Row[]>(
        "SELECT @@SESSION.group_concat_max_len AS value",
      );
      expect(Number(concatLimit[0]!.value)).toBe(1_048_576);
      const [partialTables] = await conn.query<Row[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_name IN (?) ORDER BY table_name`,
        [CONTENT_TABLES],
      );
      expect(partialTables.map((row) => String(infoSchemaField(row, "table_name")))).toEqual([
        "tenant_content_inventory_jobs",
      ]);
      const [beforeMarker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(beforeMarker[0]!.count)).toBe(0);

      const replay = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await replay.close();
      await expectContentTablesEmpty(conn);
      await assert0021Schema(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("rejects an unclaimed queued job whose availability predates its update clock", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const migrated = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await migrated.close();

      await expect(conn.query(
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
         VALUES ('erase_20000000-0000-4000-8000-000000000021', 'tenant-clock-regression',
                 1, REPEAT('1',64), REPEAT('2',64), REPEAT('3',64), 'policy-v1',
                 REPEAT('4',64), 1, 1, 4000, 4000, NULL, FALSE, 0, REPEAT('5',64),
                 'queued', 4000, 0, NULL, NULL, NULL, 4000, 4001,
                 NULL, NULL, NULL, NULL, NULL, NULL)`,
      )).rejects.toMatchObject({
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
        sqlMessage: expect.stringMatching(/chk_tenant_content_job_phase/i),
      });
      await expectContentTablesEmpty(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays after marker loss without rewriting content inventory evidence", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const first = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await first.close();
      await seedContentInventoryEvidence(conn);
      const before = await contentInventorySnapshot(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);

      const replay = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await replay.close();
      expect(await contentInventorySnapshot(conn)).toEqual(before);
      await expect(conn.query(
        "UPDATE session_content_receipts SET turn_count=1 WHERE request_id=?",
        ["erase_10000000-0000-4000-8000-000000000021"],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM tenant_content_inventory_receipts WHERE request_id=?",
        ["erase_10000000-0000-4000-8000-000000000021"],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "UPDATE tenant_content_inventory_jobs SET updated_at_ms=4002 WHERE request_id=?",
        ["erase_10000000-0000-4000-8000-000000000021"],
      )).rejects.toThrow(/not permitted/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when the historical approval index name has the wrong shape", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      await conn.query(
        "ALTER TABLE approvals ADD KEY idx_approvals_session_identity (approval_id, session_id)",
      );

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /migration 0021_tenant_content_inventory\.sql failed at statement \d+\/\d+/,
      );
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_DUP_KEYNAME");
      expect(cause?.sqlMessage ?? cause?.message).toMatch(/idx_approvals_session_identity/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
      const [tables] = await conn.query<Row[]>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?)",
        [CONTENT_TABLES],
      );
      expect(tables).toHaveLength(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a partially-created 0021 job index has the wrong shape", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query(
        `ALTER TABLE tenant_content_inventory_jobs
           DROP INDEX idx_tenant_content_jobs_claim,
           ADD KEY idx_tenant_content_jobs_claim (phase, request_id)`,
      );

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /migration 0021_tenant_content_inventory\.sql failed at statement \d+\/\d+/,
      );
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_jobs_index_shape/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a same-name 0021 index uses a prefix key part", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query(
        `ALTER TABLE tenant_content_inventory_jobs
           DROP INDEX uk_tenant_content_jobs_tenant,
           ADD UNIQUE KEY uk_tenant_content_jobs_tenant (tenant_id(1))`,
      );
      const [prefixParts] = await conn.query<Row[]>(
        `SELECT sub_part
           FROM information_schema.statistics
          WHERE table_schema=DATABASE()
            AND table_name='tenant_content_inventory_jobs'
            AND index_name='uk_tenant_content_jobs_tenant'`,
      );
      expect(Number(infoSchemaField(prefixParts[0]!, "sub_part"))).toBe(1);

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /migration 0021_tenant_content_inventory\.sql failed at statement \d+\/\d+/,
      );
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_jobs_index_shape/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a partially-created 0021 table uses a non-transactional engine", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query("ALTER TABLE tenant_content_inventory_jobs ENGINE=MyISAM");

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /migration 0021_tenant_content_inventory\.sql failed at statement \d+\/\d+/,
      );
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_jobs_schema/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a same-name 0021 CHECK constraint is weakened", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query(
        `ALTER TABLE tenant_content_inventory_jobs
           DROP CHECK chk_tenant_content_job_scan_complete,
           ADD CONSTRAINT chk_tenant_content_job_scan_complete CHECK (TRUE)`,
      );

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_jobs_schema/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a partially-created 0021 table has an extra sensitive column", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable, content-free receipt per exact session identity.",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      await conn.query(
        "ALTER TABLE tenant_content_inventory_jobs ADD COLUMN leaked_body JSON NULL",
      );

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_jobs_schema/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed when a pre-existing extra trigger can alter 0021 insert semantics", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0020(conn, baseFixtureSql, frozen0020DeltaSql);
      const first = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0021!,
        connectionLimit: 1,
      });
      await first.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query(
        `CREATE TRIGGER trg_tenant_content_jobs_unexpected_bi
           BEFORE INSERT ON tenant_content_inventory_jobs FOR EACH ROW
           SET NEW.attempts = NEW.attempts`,
      );

      let failure: unknown;
      try {
        await MysqlSessionStore.connect({
          url,
          migrationsDir: only0021!,
          connectionLimit: 1,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const cause = (failure as Error & {
        cause?: { code?: string; sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.code).toBe("ER_NO_SUCH_TABLE");
      expect(cause?.sqlMessage ?? cause?.message)
        .toMatch(/invalid_tenant_content_inventory_trigger_set/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
