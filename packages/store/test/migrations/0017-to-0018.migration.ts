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
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0017.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0018_tenant_credential_revocation_fence.sql");
const MIGRATION_NAME = "0018_tenant_credential_revocation_fence.sql";
const ADMISSION_TABLE = "tenant_erasure_admissions";
const FENCE_TABLE = "tenant_credential_revocation_fences";

type Row = RowDataPacket;

const FROZEN_0017_MIGRATIONS = [
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
] as const;

const IMMUTABLE_TRIGGERS = {
  [ADMISSION_TABLE]: [
    "trg_tenant_erasure_admissions_bd",
    "trg_tenant_erasure_admissions_bd_guard_a",
    "trg_tenant_erasure_admissions_bd_guard_b",
    "trg_tenant_erasure_admissions_bu",
    "trg_tenant_erasure_admissions_bu_guard_a",
    "trg_tenant_erasure_admissions_bu_guard_b",
  ],
  [FENCE_TABLE]: [
    "trg_tenant_credential_fences_bd",
    "trg_tenant_credential_fences_bd_guard_a",
    "trg_tenant_credential_fences_bd_guard_b",
    "trg_tenant_credential_fences_bu",
    "trg_tenant_credential_fences_bu_guard_a",
    "trg_tenant_credential_fences_bu_guard_b",
  ],
} as const;

const IMMUTABLE_TRIGGER_FAMILIES = [
  "trg_tenant_erasure_admissions_bd",
  "trg_tenant_erasure_admissions_bu",
  "trg_tenant_credential_fences_bd",
  "trg_tenant_credential_fences_bu",
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

async function historicalSnapshot(conn: Connection): Promise<Record<string, unknown>> {
  const queries = {
    tenants: "SELECT * FROM tenants ORDER BY tenant_id",
    apiKeys: "SELECT * FROM api_keys ORDER BY key_hash",
    providers: "SELECT * FROM provider_configs ORDER BY tenant_id, provider_id",
    subjectLifecycle: "SELECT * FROM subject_lifecycle ORDER BY tenant_id, subject_kind, subject_id",
    erasureRequests: "SELECT * FROM erasure_requests ORDER BY request_id",
    erasureAudit: "SELECT * FROM erasure_audit_events ORDER BY request_id, seq",
    exportRequests: "SELECT * FROM user_export_requests ORDER BY request_id",
  } as const;
  const snapshot: Record<string, unknown> = {};
  for (const [name, sql] of Object.entries(queries)) {
    const [rows] = await conn.query<Row[]>(sql);
    snapshot[name] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
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

async function tableColumns(conn: Connection, table: string): Promise<Array<Record<string, unknown>>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLLATION_NAME AS collation_name,
            COLUMN_DEFAULT AS column_default
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY ordinal_position`,
    [table],
  );
  return normalize(rows.map((row) => ({ ...row }))) as Array<Record<string, unknown>>;
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

async function historicalTriggerSnapshot(conn: Connection): Promise<unknown> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name, EVENT_MANIPULATION AS event_manipulation,
            ACTION_TIMING AS action_timing, EVENT_OBJECT_TABLE AS event_object_table,
            ACTION_ORDER AS action_order, ACTION_STATEMENT AS action_statement
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE()
        AND event_object_table NOT IN (?, ?)
      ORDER BY trigger_name`,
    [ADMISSION_TABLE, FENCE_TABLE],
  );
  return normalize(rows.map((row) => ({ ...row })));
}

async function expectEveryImmutableTriggerFamilyGuarded(conn: Connection): Promise<void> {
  const names = new Set([
    ...await triggerNames(conn, ADMISSION_TABLE),
    ...await triggerNames(conn, FENCE_TABLE),
  ]);
  for (const base of IMMUTABLE_TRIGGER_FAMILIES) {
    expect([
      base,
      `${base}_guard_a`,
      `${base}_guard_b`,
    ].some((name) => names.has(name)), `missing live append-only guard for ${base}`).toBe(true);
  }
}

async function expectExact0018Schema(conn: Connection): Promise<void> {
  expect(await tableColumns(conn, ADMISSION_TABLE)).toEqual([
    { column_name: "request_id", column_type: "varchar(64)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "tenant_id", column_type: "varchar(128)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "subject_generation", column_type: "bigint unsigned", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "requested_by_key_id", column_type: "varchar(64)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "idempotency_key", column_type: "varchar(256)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "request_hash", column_type: "char(64)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "created_at_ms", column_type: "bigint", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "gated_at_ms", column_type: "bigint", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "updated_at_ms", column_type: "bigint", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "policy_version", column_type: "varchar(64)", is_nullable: "YES",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "policy_hash", column_type: "char(64)", is_nullable: "YES",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "control_generation", column_type: "bigint unsigned", is_nullable: "NO",
      collation_name: null, column_default: "0" },
  ]);
  expect(await tableIndexes(conn, ADMISSION_TABLE)).toEqual({
    PRIMARY: { columns: ["request_id"], unique: true },
    uk_tenant_erasure_admissions_idempotency: {
      columns: ["tenant_id", "idempotency_key"], unique: true,
    },
    uk_tenant_erasure_admissions_tenant: { columns: ["tenant_id"], unique: true },
    uk_tenant_erasure_admissions_tenant_generation: {
      columns: ["tenant_id", "subject_generation"], unique: true,
    },
  });
  expect(await tableColumns(conn, FENCE_TABLE)).toEqual([
    { column_name: "tenant_id", column_type: "varchar(128)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "request_id", column_type: "varchar(64)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
    { column_name: "subject_generation", column_type: "bigint unsigned", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "fenced_at_ms", column_type: "bigint", is_nullable: "NO",
      collation_name: null, column_default: null },
    { column_name: "evidence_sha256", column_type: "char(64)", is_nullable: "NO",
      collation_name: "utf8mb4_0900_as_cs", column_default: null },
  ]);
  expect(await tableIndexes(conn, FENCE_TABLE)).toEqual({
    PRIMARY: { columns: ["tenant_id"], unique: true },
    uk_tenant_credential_fences_generation: {
      columns: ["tenant_id", "subject_generation"], unique: true,
    },
    uk_tenant_credential_fences_request: { columns: ["request_id"], unique: true },
  });
  expect(await triggerNames(conn, ADMISSION_TABLE)).toEqual([...IMMUTABLE_TRIGGERS[ADMISSION_TABLE]]);
  expect(await triggerNames(conn, FENCE_TABLE)).toEqual([...IMMUTABLE_TRIGGERS[FENCE_TABLE]]);
}

async function insertAdmission(
  conn: Connection,
  tenantId = "tenant_admission_a",
  requestId = "erase_tenant_admission_0018",
  subjectGeneration = 1,
  idempotencyKey = "tenant-erase-once",
): Promise<void> {
  await conn.query(
    `INSERT INTO tenant_erasure_admissions
       (request_id, tenant_id, subject_generation, requested_by_key_id, idempotency_key,
        request_hash, created_at_ms, gated_at_ms, updated_at_ms, policy_version, policy_hash,
        control_generation)
     VALUES (?, ?, ?, 'platform-lifecycle-admin', ?, REPEAT('8',64),
             1000, 1000, 1000, 'policy-v1', REPEAT('7',64), 0)`,
    [requestId, tenantId, subjectGeneration, idempotencyKey],
  );
}

async function insertFence(
  conn: Connection,
  tenantId = "tenant_admission_a",
  requestId = "erase_tenant_admission_0018",
): Promise<void> {
  await conn.query(
    `INSERT INTO tenant_credential_revocation_fences
       (tenant_id, request_id, subject_generation, fenced_at_ms, evidence_sha256)
     VALUES (?, ?, 1, 1000, REPEAT('a',64))`,
    [tenantId, requestId],
  );
}

async function insertRawUserGatedRequest(conn: Connection, requestId: string, updatedAtMs: number): Promise<void> {
  await conn.query(
    `INSERT INTO erasure_requests
       (request_id, tenant_id, subject_kind, subject_id, generation, status,
        requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
        updated_at_ms, available_at_ms)
     VALUES (?, 'tenant_a', 'user', ?, 1, 'gated', 'fixture-admin', ?, REPEAT('9',64),
             ?, ?, ?, NULL)`,
    [requestId, `user_${requestId}`, `idem_${requestId}`, updatedAtMs - 1, updatedAtMs, updatedAtMs],
  );
}

async function snapshot0018Rows(conn: Connection): Promise<unknown> {
  const [admissions] = await conn.query<Row[]>(`SELECT * FROM ${ADMISSION_TABLE} ORDER BY request_id`);
  const [fences] = await conn.query<Row[]>(`SELECT * FROM ${FENCE_TABLE} ORDER BY tenant_id`);
  return normalize({ admissions, fences });
}

describe("real MySQL historical upgrade: 0017 -> 0018", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0018: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements).toHaveLength(40);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(migrationStatements.filter((statement) => statement.startsWith("SELECT"))).toHaveLength(2);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TRIGGER"))).toHaveLength(16);
    expect(migrationStatements.filter((statement) => statement.startsWith("DROP TRIGGER"))).toHaveLength(20);
    only0018 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0018-"));
    await copyFile(MIGRATION_PATH, join(only0018, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0018) await rm(only0018, { recursive: true, force: true });
  });

  it("loads a frozen 0017 database with the legacy user scheduler and no 0018 tables", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: databaseUrl(baseUrl, database), multipleStatements: true });
      await conn.query(fixtureSql);
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0017_MIGRATIONS);
      const names = await tableNames(conn);
      expect(names).not.toContain(ADMISSION_TABLE);
      expect(names).not.toContain(FENCE_TABLE);
      const triggers = await historicalTriggerSnapshot(conn) as Array<Record<string, unknown>>;
      expect(triggers.some((trigger) => trigger.trigger_name === "trg_erasure_requests_job_bi")).toBe(true);
      await insertRawUserGatedRequest(conn, "raw_user_before_0018", 7000);
      const [scheduled] = await conn.query<Row[]>(
        "SELECT available_at_ms FROM erasure_requests WHERE request_id='raw_user_before_0018'",
      );
      expect(Number(scheduled[0]!.available_at_ms)).toBe(7000);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("expands 0017 without changing historical rows or triggers", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const rowsBefore = await historicalSnapshot(conn);
      const triggersBefore = await historicalTriggerSnapshot(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await store.close();

      expect(await historicalSnapshot(conn)).toEqual(rowsBefore);
      expect(await historicalTriggerSnapshot(conn)).toEqual(triggersBefore);
      await expectExact0018Schema(conn);
      expect(await snapshot0018Rows(conn)).toEqual({ admissions: [], fences: [] });
      const [tenantRequests] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM erasure_requests WHERE subject_kind='tenant'",
      );
      expect(Number(tenantRequests[0]!.count)).toBe(0);
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

  it("keeps tenant admission outside the frozen 0017 claim scan while user scheduling remains", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const triggersBefore = await historicalTriggerSnapshot(conn);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await store.close();
      await insertAdmission(conn);
      await insertRawUserGatedRequest(conn, "raw_user_after_0018", 7100);

      // This intentionally models the frozen worker's erasure_requests-only poison/candidate
      // surface. The admission cannot appear because it is not represented in that table at all.
      const [candidates] = await conn.query<Row[]>(
        `SELECT request_id FROM erasure_requests
          WHERE status IN ('gated','draining','tombstoning','reconciling_usage','purging')
            AND (available_at_ms IS NULL OR available_at_ms<=7200)
          ORDER BY request_id`,
      );
      const candidateIds = candidates.map((row) => String(row.request_id));
      expect(candidateIds).toContain("raw_user_after_0018");
      expect(candidateIds).not.toContain("erase_tenant_admission_0018");
      const [user] = await conn.query<Row[]>(
        "SELECT available_at_ms FROM erasure_requests WHERE request_id='raw_user_after_0018'",
      );
      expect(Number(user[0]!.available_at_ms)).toBe(7100);
      const [tenantRows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM erasure_requests WHERE subject_kind='tenant'",
      );
      expect(Number(tenantRows[0]!.count)).toBe(0);
      expect(await historicalTriggerSnapshot(conn)).toEqual(triggersBefore);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("enforces admission identities and append-only guards on both new tables", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await store.close();
      await insertAdmission(conn);
      await insertFence(conn);
      const before = await snapshot0018Rows(conn);

      await expect(insertAdmission(
        conn,
        "tenant_admission_a",
        "erase_duplicate_tenant",
        2,
        "tenant-erase-again",
      ))
        .rejects.toThrow(/duplicate/i);
      await expect(conn.query(
        `UPDATE ${ADMISSION_TABLE} SET updated_at_ms=1001 WHERE request_id='erase_tenant_admission_0018'`,
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `DELETE FROM ${ADMISSION_TABLE} WHERE request_id='erase_tenant_admission_0018'`,
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `UPDATE ${FENCE_TABLE} SET fenced_at_ms=1001 WHERE tenant_id='tenant_admission_a'`,
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `DELETE FROM ${FENCE_TABLE} WHERE tenant_id='tenant_admission_a'`,
      )).rejects.toThrow(/append-only/i);
      expect(await snapshot0018Rows(conn)).toEqual(before);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after partial DDL without rewriting evidence or historical state", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const historicalBefore = await historicalSnapshot(conn);
      const triggersBefore = await historicalTriggerSnapshot(conn);
      const partialEnd = migrationStatements.findIndex((statement) => (
        statement.startsWith("DROP TRIGGER IF EXISTS trg_tenant_erasure_admissions_bu_guard_a")
      ));
      expect(partialEnd).toBeGreaterThan(3);
      for (const statement of migrationStatements.slice(0, partialEnd + 1)) await conn.query(statement);
      await insertAdmission(conn);
      await insertFence(conn);
      const evidenceBefore = await snapshot0018Rows(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await store.close();

      expect(await historicalSnapshot(conn)).toEqual(historicalBefore);
      expect(await historicalTriggerSnapshot(conn)).toEqual(triggersBefore);
      expect(await snapshot0018Rows(conn)).toEqual(evidenceBefore);
      await expectExact0018Schema(conn);
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

  it("replays after marker loss while every append-only trigger prefix remains guarded", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const first = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await first.close();
      await insertAdmission(conn);
      await insertFence(conn);
      const historicalBefore = await historicalSnapshot(conn);
      const triggersBefore = await historicalTriggerSnapshot(conn);
      const evidenceBefore = await snapshot0018Rows(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);

      for (const statement of migrationStatements) {
        await conn.query(statement);
        await expectEveryImmutableTriggerFamilyGuarded(conn);
      }
      const replay = await MysqlSessionStore.connect({ url, migrationsDir: only0018!, connectionLimit: 1 });
      await replay.close();

      expect(await historicalSnapshot(conn)).toEqual(historicalBefore);
      expect(await historicalTriggerSnapshot(conn)).toEqual(triggersBefore);
      expect(await snapshot0018Rows(conn)).toEqual(evidenceBefore);
      await expectExact0018Schema(conn);
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
    { table: ADMISSION_TABLE, statement: 2 },
    { table: FENCE_TABLE, statement: 4 },
  ])("fails closed before trigger rotation for an incompatible $table", async ({ table, statement }) => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const historicalBefore = await historicalSnapshot(conn);
      const triggersBefore = await historicalTriggerSnapshot(conn);
      if (table === FENCE_TABLE) {
        for (const migrationStatement of migrationStatements.slice(0, 2)) {
          await conn.query(migrationStatement);
        }
      }
      await conn.query(
        `CREATE TABLE ${table} (
           placeholder VARCHAR(16) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );

      await expect(MysqlSessionStore.connect({
        url,
        migrationsDir: only0018!,
        connectionLimit: 1,
      })).rejects.toThrow(new RegExp(
        `migration 0018_tenant_credential_revocation_fence\\.sql failed at statement ${statement}\\/40`,
      ));

      expect(await historicalSnapshot(conn)).toEqual(historicalBefore);
      expect(await historicalTriggerSnapshot(conn)).toEqual(triggersBefore);
      expect(await triggerNames(conn, ADMISSION_TABLE)).toEqual([]);
      expect(await triggerNames(conn, FENCE_TABLE)).toEqual([]);
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
