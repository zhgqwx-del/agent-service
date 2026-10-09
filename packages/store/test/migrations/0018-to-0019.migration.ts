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
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0018.sql");
const MIGRATION_NAME = "0019_tenant_credential_physical_revocation.sql";
const MIGRATION_PATH = resolve(HERE, `../../migrations/${MIGRATION_NAME}`);

const JOB_TABLE = "tenant_credential_revocation_jobs";
const RECEIPT_TABLE = "tenant_credential_revocation_receipts";
const CUTOVER_TABLE = "tenant_credential_revocation_cutover";
const NEW_TABLES = [JOB_TABLE, RECEIPT_TABLE, CUTOVER_TABLE] as const;

const FROZEN_0018_MIGRATIONS = [
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
] as const;

const FINAL_TRIGGERS = {
  [JOB_TABLE]: [
    "trg_tenant_credential_jobs_bd",
    "trg_tenant_credential_jobs_bd_guard_a",
    "trg_tenant_credential_jobs_bd_guard_b",
    "trg_tenant_credential_jobs_bu",
    "trg_tenant_credential_jobs_bu_guard_a",
    "trg_tenant_credential_jobs_bu_guard_b",
  ],
  [RECEIPT_TABLE]: [
    "trg_tenant_credential_receipts_bd",
    "trg_tenant_credential_receipts_bd_guard_a",
    "trg_tenant_credential_receipts_bd_guard_b",
    "trg_tenant_credential_receipts_bu",
    "trg_tenant_credential_receipts_bu_guard_a",
    "trg_tenant_credential_receipts_bu_guard_b",
  ],
  [CUTOVER_TABLE]: [
    "trg_tenant_credential_cutover_bd",
    "trg_tenant_credential_cutover_bd_guard_a",
    "trg_tenant_credential_cutover_bd_guard_b",
    "trg_tenant_credential_cutover_bu",
    "trg_tenant_credential_cutover_bu_guard_a",
    "trg_tenant_credential_cutover_bu_guard_b",
  ],
} as const;

const TRIGGER_FAMILIES = [
  "trg_tenant_credential_jobs_bd",
  "trg_tenant_credential_jobs_bu",
  "trg_tenant_credential_receipts_bd",
  "trg_tenant_credential_receipts_bu",
  "trg_tenant_credential_cutover_bd",
  "trg_tenant_credential_cutover_bu",
] as const;

type Row = RowDataPacket;

interface ColumnDefinition {
  name: string;
  type: string;
  nullable: "YES" | "NO";
  collation: string | null;
  default: string | null;
  extra: string;
}

function textColumn(name: string, type: string, nullable: "YES" | "NO" = "NO"): ColumnDefinition {
  return { name, type, nullable, collation: "utf8mb4_0900_as_cs", default: null, extra: "" };
}

function numericColumn(
  name: string,
  type: string,
  nullable: "YES" | "NO" = "NO",
  columnDefault: string | null = null,
): ColumnDefinition {
  return { name, type, nullable, collation: null, default: columnDefault, extra: "" };
}

const EXPECTED_COLUMNS: Record<(typeof NEW_TABLES)[number], ColumnDefinition[]> = {
  [JOB_TABLE]: [
    textColumn("request_id", "varchar(64)"),
    textColumn("tenant_id", "varchar(128)"),
    numericColumn("subject_generation", "bigint unsigned"),
    textColumn("t1_fence_sha256", "char(64)"),
    textColumn("phase", "varchar(32)"),
    numericColumn("available_at_ms", "bigint", "YES"),
    numericColumn("attempts", "int unsigned", "NO", "0"),
    textColumn("claim_token", "varchar(128)", "YES"),
    numericColumn("lease_until_ms", "bigint", "YES"),
    textColumn("last_error_code", "varchar(32)", "YES"),
    numericColumn("created_at_ms", "bigint"),
    numericColumn("updated_at_ms", "bigint"),
    numericColumn("credential_store_revoked_at_ms", "bigint", "YES"),
    numericColumn("completed_claim_attempt", "int unsigned", "YES"),
    textColumn("completed_claim_token_sha256", "char(64)", "YES"),
    numericColumn("blocked_at_ms", "bigint", "YES"),
    textColumn("blocked_reason_code", "varchar(32)", "YES"),
  ],
  [RECEIPT_TABLE]: [
    textColumn("request_id", "varchar(64)"),
    textColumn("tenant_id", "varchar(128)"),
    numericColumn("subject_generation", "bigint unsigned"),
    textColumn("scope", "varchar(64)"),
    textColumn("t1_fence_sha256", "char(64)"),
    numericColumn("api_key_count_before", "bigint unsigned"),
    numericColumn("api_key_count_after", "bigint unsigned"),
    numericColumn("provider_config_count_before", "bigint unsigned"),
    numericColumn("provider_config_count_after", "bigint unsigned"),
    numericColumn("auth_policy_present_before", "tinyint(1)"),
    numericColumn("auth_policy_present_after", "tinyint(1)"),
    numericColumn("auth_secret_cipher_present_before", "tinyint(1)"),
    numericColumn("auth_secret_cipher_present_after", "tinyint(1)"),
    numericColumn("auth_secret_key_id_present_before", "tinyint(1)"),
    numericColumn("auth_secret_key_id_present_after", "tinyint(1)"),
    numericColumn("store_db_timestamp_ms", "bigint"),
    numericColumn("completed_claim_attempt", "int unsigned"),
    textColumn("completed_claim_token_sha256", "char(64)"),
    textColumn("runtime_disposition", "varchar(32)"),
    textColumn("external_disposition", "varchar(32)"),
    numericColumn("content_purge_required", "tinyint(1)"),
    textColumn("receipt_sha256", "char(64)"),
  ],
  [CUTOVER_TABLE]: [
    numericColumn("singleton_id", "tinyint unsigned"),
    numericColumn("control_generation", "bigint unsigned", "NO", "0"),
    numericColumn("activated_at_ms", "bigint", "YES"),
    textColumn("first_receipt_sha256", "char(64)", "YES"),
    textColumn("evidence_sha256", "char(64)", "YES"),
  ],
};

const EXPECTED_INDEXES = {
  [JOB_TABLE]: {
    PRIMARY: { columns: ["request_id"], unique: true },
    idx_tenant_credential_revocation_jobs_claim: {
      columns: ["phase", "available_at_ms", "lease_until_ms", "request_id"], unique: false,
    },
    uk_tenant_credential_revocation_jobs_generation: {
      columns: ["tenant_id", "subject_generation"], unique: true,
    },
    uk_tenant_credential_revocation_jobs_tenant: { columns: ["tenant_id"], unique: true },
  },
  [RECEIPT_TABLE]: {
    PRIMARY: { columns: ["request_id"], unique: true },
    uk_tenant_credential_revocation_receipts_generation: {
      columns: ["tenant_id", "subject_generation"], unique: true,
    },
    uk_tenant_credential_revocation_receipts_hash: { columns: ["receipt_sha256"], unique: true },
    uk_tenant_credential_revocation_receipts_tenant: { columns: ["tenant_id"], unique: true },
  },
  [CUTOVER_TABLE]: {
    PRIMARY: { columns: ["singleton_id"], unique: true },
  },
} as const;

const EXPECTED_CHECKS = {
  [JOB_TABLE]: [
    "chk_tenant_credential_revocation_job_generation",
    "chk_tenant_credential_revocation_job_phase",
    "chk_tenant_credential_revocation_job_timestamps",
  ],
  [RECEIPT_TABLE]: [
    "chk_tenant_credential_receipt_completion",
    "chk_tenant_credential_receipt_disposition",
    "chk_tenant_credential_receipt_generation",
    "chk_tenant_credential_receipt_post_state",
    "chk_tenant_credential_receipt_scope",
  ],
  [CUTOVER_TABLE]: [
    "chk_tenant_credential_revocation_cutover_singleton",
    "chk_tenant_credential_revocation_cutover_state",
  ],
} as const;

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

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

async function tableNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_type='BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((row) => String(row.table_name));
}

async function tableColumns(conn: Connection, table: string): Promise<ColumnDefinition[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            COLLATION_NAME AS collation, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type),
    nullable: String(row.nullable) as "YES" | "NO",
    collation: row.collation == null ? null : String(row.collation),
    default: row.default == null ? null : String(row.default),
    extra: String(row.extra),
  }));
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

async function tableChecks(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT CONSTRAINT_NAME AS constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema=DATABASE() AND table_name=? AND constraint_type='CHECK'
      ORDER BY constraint_name`,
    [table],
  );
  return rows.map((row) => String(row.constraint_name));
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

async function allTriggerNames(conn: Connection): Promise<Set<string>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE()`,
  );
  return new Set(rows.map((row) => String(row.trigger_name)));
}

async function expectEveryPermanentTriggerFamilyGuarded(conn: Connection): Promise<void> {
  const names = await allTriggerNames(conn);
  for (const base of TRIGGER_FAMILIES) {
    expect([
      base,
      `${base}_guard_a`,
      `${base}_guard_b`,
    ].some((name) => names.has(name)), `missing live guard for ${base}`).toBe(true);
  }
}

async function expectExact0019Schema(conn: Connection): Promise<void> {
  for (const table of NEW_TABLES) {
    expect(await tableColumns(conn, table)).toEqual(EXPECTED_COLUMNS[table]);
    expect(await tableIndexes(conn, table)).toEqual(EXPECTED_INDEXES[table]);
    expect(await tableChecks(conn, table)).toEqual(EXPECTED_CHECKS[table]);
    const triggers = await triggerRows(conn, table);
    expect(triggers.map((row) => row.name)).toEqual([...FINAL_TRIGGERS[table]]);
    for (const trigger of triggers) {
      expect(trigger.event).toBe(trigger.name.includes("_bu") ? "UPDATE" : "DELETE");
      if (table === RECEIPT_TABLE) expect(trigger.statement).toMatch(/append-only/i);
      if (table === JOB_TABLE) expect(trigger.statement).toMatch(/immutable|cannot be deleted/i);
      if (table === CUTOVER_TABLE) expect(trigger.statement).toMatch(/write-once|cannot be deleted/i);
    }
  }

  const [collations] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name, TABLE_COLLATION AS table_collation
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN (?,?,?)
      ORDER BY table_name`,
    [...NEW_TABLES],
  );
  expect(collations).toHaveLength(NEW_TABLES.length);
  expect(collations.every((row) => row.table_collation === "utf8mb4_0900_as_cs")).toBe(true);
}

async function credentialSnapshot(conn: Connection): Promise<unknown> {
  const queries = {
    tenants: `SELECT tenant_id, name, created_at_ms, auth_policy, auth_secret_cipher,
                     auth_secret_key_id FROM tenants ORDER BY tenant_id`,
    apiKeys: "SELECT * FROM api_keys ORDER BY key_hash",
    providers: "SELECT * FROM provider_configs ORDER BY tenant_id, provider_id",
    admissions: "SELECT * FROM tenant_erasure_admissions ORDER BY request_id",
    fences: "SELECT * FROM tenant_credential_revocation_fences ORDER BY tenant_id",
  } as const;
  const snapshot: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(queries)) {
    const [rows] = await conn.query<Row[]>(sql);
    snapshot[name] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

async function newTableSnapshot(conn: Connection): Promise<unknown> {
  const [jobs] = await conn.query<Row[]>(`SELECT * FROM ${JOB_TABLE} ORDER BY request_id`);
  const [receipts] = await conn.query<Row[]>(`SELECT * FROM ${RECEIPT_TABLE} ORDER BY request_id`);
  const [cutover] = await conn.query<Row[]>(`SELECT * FROM ${CUTOVER_TABLE} ORDER BY singleton_id`);
  return normalize({ jobs, receipts, cutover });
}

async function insertJob(
  conn: Connection,
  requestId = "erase_10000000-0000-4000-8000-000000000019",
  tenantId = "tenant_partial_0019",
): Promise<void> {
  await conn.query(
    `INSERT INTO ${JOB_TABLE}
       (request_id, tenant_id, subject_generation, t1_fence_sha256, phase,
        available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
        created_at_ms, updated_at_ms, credential_store_revoked_at_ms,
        completed_claim_attempt, completed_claim_token_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, ?, 2, REPEAT('d',64), 'queued', 2000, 0, NULL, NULL, NULL,
             2000, 2000, NULL, NULL, NULL, NULL, NULL)`,
    [requestId, tenantId],
  );
}

async function insertReceipt(
  conn: Connection,
  requestId = "erase_20000000-0000-4000-8000-000000000019",
  tenantId = "tenant_receipt_0019",
  receiptSha256 = "e".repeat(64),
): Promise<void> {
  await conn.query(
    `INSERT INTO ${RECEIPT_TABLE}
       (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
        api_key_count_before, api_key_count_after,
        provider_config_count_before, provider_config_count_after,
        auth_policy_present_before, auth_policy_present_after,
        auth_secret_cipher_present_before, auth_secret_cipher_present_after,
        auth_secret_key_id_present_before, auth_secret_key_id_present_after,
        store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
        runtime_disposition, external_disposition, content_purge_required, receipt_sha256)
     VALUES (?, ?, 2, 'local-db-credential-material-v1', REPEAT('d',64),
             3, 0, 2, 0, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE,
             2100, 1, REPEAT('f',64), 'not_in_scope', 'not_supported', TRUE, ?)`,
    [requestId, tenantId, receiptSha256],
  );
}

async function activateCutover(conn: Connection, receiptSha256 = "e".repeat(64)): Promise<void> {
  await conn.query(
    `UPDATE ${CUTOVER_TABLE}
        SET control_generation=1, activated_at_ms=2100,
            first_receipt_sha256=?, evidence_sha256=REPEAT('9',64)
      WHERE singleton_id=1 AND control_generation=0`,
    [receiptSha256],
  );
}

describe("real MySQL historical upgrade: 0018 -> 0019", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0019: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements).toHaveLength(61);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(3);
    expect(migrationStatements.filter((statement) => statement.startsWith("SELECT"))).toHaveLength(3);
    expect(migrationStatements.filter((statement) => statement.startsWith("INSERT"))).toHaveLength(1);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(24);
    expect(migrationStatements.filter((statement) => statement.startsWith("DROP TRIGGER"))).toHaveLength(30);
    only0019 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0019-"));
    await copyFile(MIGRATION_PATH, join(only0019, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0019) await rm(only0019, { recursive: true, force: true });
  });

  it("loads a frozen 0018 credential-bearing database with no T3a execution substrate", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: databaseUrl(baseUrl, database), multipleStatements: true });
      await conn.query(fixtureSql);
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0018_MIGRATIONS);
      const names = await tableNames(conn);
      expect(NEW_TABLES.filter((table) => names.includes(table))).toEqual([]);
      const before = await credentialSnapshot(conn);
      expect(before).toMatchObject({
        apiKeys: expect.arrayContaining([expect.objectContaining({ key_id: "active_preserved" })]),
        providers: expect.arrayContaining([expect.objectContaining({ provider_id: "provider_preserved" })]),
        admissions: [expect.objectContaining({ tenant_id: "tenant_preserved" })],
        fences: [expect.objectContaining({ tenant_id: "tenant_preserved" })],
      });
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("expands 0018 without deleting credentials, materializing old admissions, or activating cutover", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const credentialBefore = await credentialSnapshot(conn);
      const oldTriggersBefore = await allTriggerNames(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0019!, connectionLimit: 1 });
      await store.close();

      expect(await credentialSnapshot(conn)).toEqual(credentialBefore);
      const oldTriggersAfter = await allTriggerNames(conn);
      for (const name of oldTriggersBefore) expect(oldTriggersAfter.has(name)).toBe(true);
      await expectExact0019Schema(conn);
      const [jobs] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${JOB_TABLE}`);
      const [receipts] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${RECEIPT_TABLE}`);
      const [cutover] = await conn.query<Row[]>(`SELECT * FROM ${CUTOVER_TABLE}`);
      expect(Number(jobs[0]!.count)).toBe(0);
      expect(Number(receipts[0]!.count)).toBe(0);
      expect(cutover).toEqual([expect.objectContaining({
        singleton_id: 1,
        control_generation: 0,
        activated_at_ms: null,
        first_receipt_sha256: null,
        evidence_sha256: null,
      })]);
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

  it("enforces receipt checks and append-only evidence guards", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0019!, connectionLimit: 1 });
      await store.close();
      await insertReceipt(conn);
      const before = await newTableSnapshot(conn);

      await expect(conn.query(
        `UPDATE ${RECEIPT_TABLE} SET store_db_timestamp_ms=store_db_timestamp_ms WHERE request_id=?`,
        ["erase_20000000-0000-4000-8000-000000000019"],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `DELETE FROM ${RECEIPT_TABLE} WHERE request_id=?`,
        ["erase_20000000-0000-4000-8000-000000000019"],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `INSERT INTO ${RECEIPT_TABLE}
           (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
            api_key_count_before, api_key_count_after,
            provider_config_count_before, provider_config_count_after,
            auth_policy_present_before, auth_policy_present_after,
            auth_secret_cipher_present_before, auth_secret_cipher_present_after,
            auth_secret_key_id_present_before, auth_secret_key_id_present_after,
            store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
            runtime_disposition, external_disposition, content_purge_required, receipt_sha256)
         VALUES ('erase_30000000-0000-4000-8000-000000000019', 'tenant_bad_receipt', 1,
                 'local-db-credential-material-v1', REPEAT('1',64), 1, 1, 0, 0,
                 TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, 2200, 1, REPEAT('2',64),
                 'not_in_scope', 'not_supported', TRUE, REPEAT('3',64))`,
      )).rejects.toThrow(/check constraint/i);
      expect(await newTableSnapshot(conn)).toEqual(before);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after partial DDL without rewriting old rows or already-written T3a evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const credentialBefore = await credentialSnapshot(conn);
      for (const statement of migrationStatements.slice(0, 12)) await conn.query(statement);
      await insertJob(conn);
      await insertReceipt(conn);
      const newBefore = await newTableSnapshot(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0019!, connectionLimit: 1 });
      await store.close();

      expect(await credentialSnapshot(conn)).toEqual(credentialBefore);
      expect(await newTableSnapshot(conn)).toEqual(newBefore);
      await expectExact0019Schema(conn);
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

  it("replays after marker loss while every irreversible trigger family remains guarded", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const first = await MysqlSessionStore.connect({ url, migrationsDir: only0019!, connectionLimit: 1 });
      await first.close();
      await insertJob(conn);
      await insertReceipt(conn);
      await activateCutover(conn);
      const credentialBefore = await credentialSnapshot(conn);
      const newBefore = await newTableSnapshot(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);

      for (const statement of migrationStatements) {
        await conn.query(statement);
        await expectEveryPermanentTriggerFamilyGuarded(conn);
      }
      const replay = await MysqlSessionStore.connect({ url, migrationsDir: only0019!, connectionLimit: 1 });
      await replay.close();

      expect(await credentialSnapshot(conn)).toEqual(credentialBefore);
      expect(await newTableSnapshot(conn)).toEqual(newBefore);
      await expectExact0019Schema(conn);
      await expect(conn.query(
        `UPDATE ${CUTOVER_TABLE} SET activated_at_ms=activated_at_ms WHERE singleton_id=1`,
      )).rejects.toThrow(/write-once/i);
      await expect(conn.query(
        `DELETE FROM ${CUTOVER_TABLE} WHERE singleton_id=1`,
      )).rejects.toThrow(/cannot be deleted/i);
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

  it.each([
    { table: JOB_TABLE, setupStatements: 0, failingStatement: 2 },
    { table: RECEIPT_TABLE, setupStatements: 2, failingStatement: 4 },
    { table: CUTOVER_TABLE, setupStatements: 4, failingStatement: 6 },
  ])("fails before trigger installation and migration marker for an incompatible $table", async ({
    table,
    setupStatements,
    failingStatement,
  }) => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const credentialBefore = await credentialSnapshot(conn);
      for (const statement of migrationStatements.slice(0, setupStatements)) await conn.query(statement);
      await conn.query(
        `CREATE TABLE ${table} (
           placeholder VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );

      await expect(MysqlSessionStore.connect({
        url,
        migrationsDir: only0019!,
        connectionLimit: 1,
      })).rejects.toThrow(new RegExp(
        `migration 0019_tenant_credential_physical_revocation\\.sql failed at statement ${failingStatement}\\/61`,
      ));

      expect(await credentialSnapshot(conn)).toEqual(credentialBefore);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
      const triggerNames = await allTriggerNames(conn);
      expect([...triggerNames].some((name) => name.startsWith("trg_tenant_credential_jobs_"))).toBe(false);
      expect([...triggerNames].some((name) => name.startsWith("trg_tenant_credential_receipts_"))).toBe(false);
      expect([...triggerNames].some((name) => name.startsWith("trg_tenant_credential_cutover_"))).toBe(false);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
