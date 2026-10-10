import { createHash, randomUUID } from "node:crypto";
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
const FROZEN_DELTA_PATHS = [20, 21, 22, 23, 24].map((version) => (
  resolve(HERE, `../fixtures/mysql-00${version}-delta.sql`)
));
const FROZEN_T3F_EVIDENCE_PATH = resolve(HERE, "../fixtures/mysql-0024-t3f-evidence.sql");
const MIGRATION_NAME = "0025_tenant_redis_purge.sql";
const MIGRATION_PATH = resolve(HERE, `../../migrations/${MIGRATION_NAME}`);
const FROZEN_0024_FIXTURE_SHA256 = [
  "1b567f8e5c9e618696fb2228a00ed07fd459945bd1170eda108db8e11659a50a",
  "69364658c7c29cf88785043c5b3c5ad0a6854f60f4cbbc84d1d30dd241b9fa61",
  "3242930b8bbf4e14c1d41ccea28f95aacd25af4f6bc80c29a667ea021f43de73",
  "b0c0f354ee2c7ad834c327593a9b002500a8c3381ffe1754020204f844f6dbdd",
  "b5561406bad4498ad1881d3944778c3c13583a8ce446f419b1201f96f719a801",
  "2ac0218a7aef7012a2c8acb9290dfc0feeec57d2b57e257cce3ed8f73057b121",
] as const;
const FROZEN_T3F_EVIDENCE_SHA256 =
  "daebb08a1318666d67771ae0c46408f63913fdc5d48acf2ca8e7cfc2fc98cb29";
const FROZEN_T3F_REQUEST_ID = "erase_9eee127e-a759-41b6-87a7-e4e744f17d4c";
const FROZEN_T3F_TENANT_ID =
  "tenant-pre0025-t3f-dc40fed1-5e4b-4374-abec-297e016857ad";
const FROZEN_T3F_SESSION_ID = "sess_01a12386-b794-7a03-8947-c64b0661e17f";
const REDIS_NAMESPACE_SHA256 = "7".repeat(64);

const FROZEN_0024_MIGRATIONS = [
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
  "0022_tenant_purge_plan.sql",
  "0023_tenant_purge_execution_ack.sql",
  "0024_tenant_database_purge.sql",
] as const;

const REDIS_PURGE_TABLES = [
  "tenant_redis_purge_jobs",
  "tenant_redis_purge_targets",
  "tenant_redis_purge_restore_sequence",
  "tenant_redis_purge_target_acks",
  "tenant_redis_purge_domain_acks",
  "tenant_redis_purge_receipts",
  "tenant_redis_purge_cutover",
];

const DATABASE_PURGE_TABLES = [
  "tenant_database_purge_jobs",
  "tenant_database_purge_predelete_entries",
  "tenant_database_purge_predelete_receipts",
  "tenant_database_purge_domain_acks",
  "tenant_database_purge_receipts",
  "tenant_purge_session_grave_markers",
  "tenant_database_purge_cutover",
] as const;

const DATABASE_PURGE_ORDER_BY: Record<(typeof DATABASE_PURGE_TABLES)[number], string> = {
  tenant_database_purge_jobs: "request_id",
  tenant_database_purge_predelete_entries:
    "request_id,database_purge_generation,domain_ordinal",
  tenant_database_purge_predelete_receipts: "request_id",
  tenant_database_purge_domain_acks:
    "request_id,database_purge_generation,global_ack_seq",
  tenant_database_purge_receipts: "request_id",
  tenant_purge_session_grave_markers: "session_id",
  tenant_database_purge_cutover: "singleton_id",
};

const EXPECTED_COLUMN_COUNTS: Record<string, number> = {
  tenant_redis_purge_jobs: 42,
  tenant_redis_purge_targets: 18,
  tenant_redis_purge_restore_sequence: 2,
  tenant_redis_purge_target_acks: 23,
  tenant_redis_purge_domain_acks: 26,
  tenant_redis_purge_receipts: 36,
  tenant_redis_purge_cutover: 7,
};

const EXPECTED_INDEX_NAMES: Record<string, string[]> = {
  tenant_redis_purge_jobs: [
    "PRIMARY", "idx_tenant_redis_purge_jobs_claim", "idx_tenant_redis_purge_jobs_source",
    "uk_tenant_redis_purge_jobs_generation", "uk_tenant_redis_purge_jobs_identity",
    "uk_tenant_redis_purge_jobs_tenant",
  ],
  tenant_redis_purge_targets: [
    "PRIMARY", "idx_tenant_redis_purge_targets_grave",
    "uk_tenant_redis_purge_targets_ack_fk", "uk_tenant_redis_purge_targets_operation",
    "uk_tenant_redis_purge_targets_receipt", "uk_tenant_redis_purge_targets_session",
  ],
  tenant_redis_purge_restore_sequence: ["PRIMARY"],
  tenant_redis_purge_target_acks: [
    "PRIMARY", "idx_tenant_redis_purge_target_acks_target",
    "uk_tenant_redis_purge_target_acks_marker",
    "uk_tenant_redis_purge_target_acks_operation",
    "uk_tenant_redis_purge_target_acks_receipt",
    "uk_tenant_redis_purge_target_acks_restore_seq",
    "uk_tenant_redis_purge_target_acks_session",
  ],
  tenant_redis_purge_domain_acks: [
    "PRIMARY", "idx_tenant_redis_purge_domain_acks_job",
    "idx_tenant_redis_purge_domain_acks_plan",
    "uk_tenant_redis_purge_domain_acks_domain",
    "uk_tenant_redis_purge_domain_acks_ordinal",
    "uk_tenant_redis_purge_domain_acks_receipt",
  ],
  tenant_redis_purge_receipts: [
    "PRIMARY", "idx_tenant_redis_purge_receipts_job",
    "uk_tenant_redis_purge_receipts_generation", "uk_tenant_redis_purge_receipts_hash",
    "uk_tenant_redis_purge_receipts_request_hash",
    "uk_tenant_redis_purge_receipts_tenant",
  ],
  tenant_redis_purge_cutover: ["PRIMARY", "idx_tenant_redis_purge_cutover_receipt"],
};

type Row = RowDataPacket;

function infoSchemaField(row: Row, name: string): unknown {
  return row[name] ?? row[name.toUpperCase()];
}

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

async function installFrozen0024(conn: Connection, fixtures: readonly string[]): Promise<void> {
  for (const fixture of fixtures) await conn.query(fixture);
  const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0024_MIGRATIONS);
}

async function seedHistoricalBusinessRow(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO sessions
       (session_id,tenant_id,user_id,agent_id,agent_version,status,title,parent_session_id,
        last_seq,fence_token,context_epoch,usage_json,metadata,created_at_ms,updated_at_ms,
        archived_at_ms,deleted_at_ms,purge_after_ms,deletion_generation,
        auto_approved_tools,last_compaction_seq)
     VALUES ('sess_0199aabb-ccdd-7005-8000-000000000025','tenant-frozen-0024',
             'user-frozen-0024','agent-frozen-0024',1,'{"type":"idle"}',
             'preserved across 0025',NULL,0,0,'epoch-frozen-0024','{}','{}',
             24000,24000,NULL,NULL,NULL,0,'[]',NULL)`,
  );
}

async function databasePurgeSnapshot(conn: Connection): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const table of DATABASE_PURGE_TABLES) {
    const [rows] = await conn.query<Row[]>(
      `SELECT * FROM ${table} ORDER BY ${DATABASE_PURGE_ORDER_BY[table]}`,
    );
    result[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return result;
}

async function expectRedisPurgeDormant(conn: Connection): Promise<void> {
  for (const table of REDIS_PURGE_TABLES.filter((candidate) => (
    candidate !== "tenant_redis_purge_restore_sequence"
      && candidate !== "tenant_redis_purge_cutover"
  ))) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
    expect(Number(rows[0]!.count), table).toBe(0);
  }
  const [sequenceRows] = await conn.query<Row[]>(
    "SELECT singleton_id,next_restore_seq FROM tenant_redis_purge_restore_sequence",
  );
  expect(sequenceRows).toHaveLength(1);
  expect(Number(sequenceRows[0]!.singleton_id)).toBe(1);
  expect(Number(sequenceRows[0]!.next_restore_seq)).toBe(1);
  const [cutoverRows] = await conn.query<Row[]>(
    `SELECT singleton_id,control_generation,activated_at_db_ms,first_request_id,
            first_receipt_sha256,redis_namespace_sha256,evidence_sha256
       FROM tenant_redis_purge_cutover`,
  );
  expect(cutoverRows).toHaveLength(1);
  expect(Number(cutoverRows[0]!.singleton_id)).toBe(1);
  expect(Number(cutoverRows[0]!.control_generation)).toBe(0);
  expect(cutoverRows[0]!.activated_at_db_ms).toBeNull();
  expect(cutoverRows[0]!.first_request_id).toBeNull();
  expect(cutoverRows[0]!.first_receipt_sha256).toBeNull();
  expect(cutoverRows[0]!.redis_namespace_sha256).toBeNull();
  expect(cutoverRows[0]!.evidence_sha256).toBeNull();
}

async function assert0025Schema(conn: Connection): Promise<void> {
  const [columnRows] = await conn.query<Row[]>(
    `SELECT table_name,COUNT(*) AS count
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name IN (${REDIS_PURGE_TABLES.map(() => "?").join(",")})
      GROUP BY table_name ORDER BY table_name`,
    REDIS_PURGE_TABLES,
  );
  expect(Object.fromEntries(columnRows.map((row) => [
    String(infoSchemaField(row, "table_name")),
    Number(infoSchemaField(row, "count")),
  ])))
    .toEqual(EXPECTED_COLUMN_COUNTS);

  const [restoreSequenceRows] = await conn.query<Row[]>(
    `SELECT column_type,is_nullable,column_default,extra
       FROM information_schema.columns
      WHERE table_schema=DATABASE()
        AND table_name='tenant_redis_purge_target_acks'
        AND column_name='restore_seq'`,
  );
  expect(restoreSequenceRows).toHaveLength(1);
  expect(String(infoSchemaField(restoreSequenceRows[0]!, "column_type"))).toBe("bigint unsigned");
  expect(String(infoSchemaField(restoreSequenceRows[0]!, "is_nullable"))).toBe("NO");
  expect(String(infoSchemaField(restoreSequenceRows[0]!, "column_default"))).toBe("0");
  expect(String(infoSchemaField(restoreSequenceRows[0]!, "extra"))).toBe("");

  const [indexRows] = await conn.query<Row[]>(
    `SELECT table_name,index_name
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name IN (${REDIS_PURGE_TABLES.map(() => "?").join(",")})
      GROUP BY table_name,index_name ORDER BY table_name,index_name`,
    REDIS_PURGE_TABLES,
  );
  const indexes: Record<string, string[]> = {};
  for (const row of indexRows) {
    const table = String(infoSchemaField(row, "table_name"));
    (indexes[table] ??= []).push(String(infoSchemaField(row, "index_name")));
  }
  for (const names of Object.values(indexes)) names.sort();
  expect(indexes).toEqual(Object.fromEntries(
    Object.entries(EXPECTED_INDEX_NAMES).map(([table, names]) => [table, [...names].sort()]),
  ));

  const [foreignKeys] = await conn.query<Row[]>(
    `SELECT COUNT(DISTINCT CONCAT(table_name,'~',constraint_name)) AS count,
            COUNT(*) AS columns
       FROM information_schema.key_column_usage
      WHERE table_schema=DATABASE() AND referenced_table_name IS NOT NULL
        AND table_name IN (${REDIS_PURGE_TABLES.map(() => "?").join(",")})`,
    REDIS_PURGE_TABLES,
  );
  expect(Number(foreignKeys[0]!.count)).toBe(8);
  expect(Number(foreignKeys[0]!.columns)).toBe(40);

  const [triggers] = await conn.query<Row[]>(
    `SELECT COUNT(*) AS count FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_tenant_redis_purge_%'`,
  );
  expect(Number(triggers[0]!.count)).toBe(15);
}

async function expectMigrationFailure(
  url: string,
  only0025: string,
  matcher: RegExp,
): Promise<void> {
  let failure: unknown;
  try {
    await MysqlSessionStore.connect({ url, migrationsDir: only0025, connectionLimit: 1 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    /migration 0025_tenant_redis_purge\.sql failed at statement \d+\/\d+/,
  );
  const cause = (failure as Error & {
    cause?: { code?: string; sqlMessage?: string; message?: string };
  }).cause;
  expect(cause?.sqlMessage ?? cause?.message).toMatch(matcher);
}

describe("real MySQL historical upgrade: frozen 0024 -> 0025", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtures: string[];
  let frozenT3fEvidence: string;
  let migrationSql: string;
  let only0025: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    const [baseFixture, frozenEvidence, ...frozenDeltas] = await Promise.all([
      readFile(BASE_FIXTURE_PATH, "utf8"),
      readFile(FROZEN_T3F_EVIDENCE_PATH, "utf8"),
      ...FROZEN_DELTA_PATHS.map((path) => readFile(path, "utf8")),
    ]);
    fixtures = [baseFixture!, ...frozenDeltas];
    frozenT3fEvidence = frozenEvidence!;
    const frozen0024 = frozenDeltas.at(-1)!;
    expect(fixtures.map((fixture) => createHash("sha256").update(fixture).digest("hex")))
      .toEqual(FROZEN_0024_FIXTURE_SHA256);
    expect(createHash("sha256").update(frozenT3fEvidence).digest("hex"))
      .toBe(FROZEN_T3F_EVIDENCE_SHA256);
    expect(frozenT3fEvidence).toContain("INSERT INTO `tenant_database_purge_receipts`");
    expect(frozenT3fEvidence).not.toMatch(/^\s*(?:INSERT|UPDATE).*tenant_redis_purge_/im);
    expect(frozen0024).toContain("CREATE TABLE IF NOT EXISTS tenant_database_purge_jobs");
    expect(frozen0024).not.toContain("tenant_redis_purge_jobs");
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
    expect(migrationSql).not.toMatch(
      /INSERT\s+INTO\s+tenant_redis_purge_(?:jobs|targets|target_acks|domain_acks|receipts)/i,
    );
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\s+tenant_/i);
    only0025 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0025-"));
    await copyFile(MIGRATION_PATH, join(only0025, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0025) await rm(only0025, { recursive: true, force: true });
  });

  it("preserves a frozen 0024 database and installs dormant exact 0025 state", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0024(conn, fixtures);
      await seedHistoricalBusinessRow(conn);
      const migrated = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await migrated.close();
      const [session] = await conn.query<Row[]>(
        "SELECT tenant_id,title FROM sessions WHERE session_id='sess_0199aabb-ccdd-7005-8000-000000000025'",
      );
      expect(session).toHaveLength(1);
      expect(String(session[0]!.tenant_id)).toBe("tenant-frozen-0024");
      expect(String(session[0]!.title)).toBe("preserved across 0025");
      await expectRedisPurgeDormant(conn);
      await assert0025Schema(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("preserves complete pre-0025 T3f evidence field-for-field and materializes T3g from it", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let migrated: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0024(conn, fixtures);
      await conn.query(frozenT3fEvidence);
      const before = await databasePurgeSnapshot(conn);
      const [cardinality] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_database_purge_jobs) AS jobs,
           (SELECT COUNT(*) FROM tenant_database_purge_predelete_entries) AS entries,
           (SELECT COUNT(*) FROM tenant_database_purge_predelete_receipts) AS predelete_receipts,
           (SELECT COUNT(*) FROM tenant_database_purge_domain_acks) AS domain_acks,
           (SELECT COUNT(*) FROM tenant_database_purge_receipts) AS receipts,
           (SELECT COUNT(*) FROM tenant_purge_session_grave_markers) AS graves,
           (SELECT COUNT(*) FROM tenant_database_purge_cutover) AS cutovers`,
      );
      expect(cardinality[0]).toMatchObject({
        jobs: 1,
        entries: 11,
        predelete_receipts: 1,
        domain_acks: 11,
        receipts: 1,
        graves: 1,
        cutovers: 1,
      });
      const [beforeReceiptRows] = await conn.query<Row[]>(
        `SELECT receipt_sha256,grave_marker_count,grave_marker_root_sha256,
                local_database_purge_complete,all_domains_complete,content_purge_executed
           FROM tenant_database_purge_receipts
          WHERE request_id=? AND tenant_id=?`,
        [FROZEN_T3F_REQUEST_ID, FROZEN_T3F_TENANT_ID],
      );
      expect(beforeReceiptRows).toHaveLength(1);
      expect(Number(beforeReceiptRows[0]!.grave_marker_count)).toBe(1);
      expect(Number(beforeReceiptRows[0]!.local_database_purge_complete)).toBe(1);
      expect(Number(beforeReceiptRows[0]!.all_domains_complete)).toBe(0);
      expect(Number(beforeReceiptRows[0]!.content_purge_executed)).toBe(0);
      migrated = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0025!,
        connectionLimit: 4,
        tenantRedisPurgeNamespaceSha256: REDIS_NAMESPACE_SHA256,
      });
      expect(await databasePurgeSnapshot(conn)).toEqual(before);
      await expectRedisPurgeDormant(conn);

      expect(await migrated.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
      const job = await migrated.getTenantRedisPurgeJob(
        FROZEN_T3F_TENANT_ID,
        FROZEN_T3F_REQUEST_ID,
      );
      expect(job).toMatchObject({
        requestId: FROZEN_T3F_REQUEST_ID,
        tenantId: FROZEN_T3F_TENANT_ID,
        phase: "queued",
        redisPurgeGeneration: 1,
        targetCount: 1,
        graveMarkerCount: 1,
        redisNamespaceSha256: REDIS_NAMESPACE_SHA256,
        databasePurgeReceiptSha256: String(beforeReceiptRows[0]!.receipt_sha256),
        graveMarkerRootSha256: String(beforeReceiptRows[0]!.grave_marker_root_sha256),
      });
      const targets = await migrated.getTenantRedisPurgeTargets(
        FROZEN_T3F_TENANT_ID,
        FROZEN_T3F_REQUEST_ID,
        1,
      );
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        tenantId: FROZEN_T3F_TENANT_ID,
        requestId: FROZEN_T3F_REQUEST_ID,
        sessionId: FROZEN_T3F_SESSION_ID,
        redisNamespaceSha256: REDIS_NAMESPACE_SHA256,
      });
      // T3g publication is append-only in its own tables and must not rewrite any T3f byte.
      expect(await databasePurgeSnapshot(conn)).toEqual(before);
    } finally {
      await migrated?.close();
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after an independent DDL auto-commit boundary", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0024(conn, fixtures);
      const boundary = migrationSql.indexOf(
        "CREATE TABLE IF NOT EXISTS tenant_redis_purge_target_acks",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      const replay = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await replay.close();
      await expectRedisPurgeDormant(conn);
      await assert0025Schema(conn);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays marker loss and preserves write-once guards", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0024(conn, fixtures);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await first.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      const replay = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await replay.close();
      await expectRedisPurgeDormant(conn);
      await expect(conn.query(
        "UPDATE tenant_redis_purge_cutover SET evidence_sha256=REPEAT('a',64) WHERE singleton_id=1",
      )).rejects.toThrow(/write-once/i);
      await expect(conn.query(
        "DELETE FROM tenant_redis_purge_cutover WHERE singleton_id=1",
      )).rejects.toThrow(/cannot be deleted/i);
      await expect(conn.query(
        "UPDATE tenant_redis_purge_restore_sequence SET next_restore_seq=next_restore_seq+2 WHERE singleton_id=1",
      )).rejects.toThrow(/advance exactly once/i);
      await expect(conn.query(
        "DELETE FROM tenant_redis_purge_restore_sequence WHERE singleton_id=1",
      )).rejects.toThrow(/cannot be deleted/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed on a same-name weak table or post-install schema weakening", async () => {
    for (const postInstall of [false, true]) {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(baseUrl, database);
      let conn: Connection | undefined;
      try {
        conn = await mysql.createConnection({ uri: url, multipleStatements: true });
        await installFrozen0024(conn, fixtures);
        if (!postInstall) {
          await conn.query(
            "CREATE TABLE tenant_redis_purge_jobs (request_id VARCHAR(64) PRIMARY KEY)",
          );
          await expectMigrationFailure(url, only0025!, /unknown column|key .* doesn't exist/i);
        } else {
          const first = await MysqlSessionStore.connect({
            url, migrationsDir: only0025!, connectionLimit: 1,
          });
          await first.close();
          await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
          await conn.query(
            `ALTER TABLE tenant_redis_purge_jobs
               DROP INDEX idx_tenant_redis_purge_jobs_claim,
               ADD KEY idx_tenant_redis_purge_jobs_claim (phase,request_id)`,
          );
          await expectMigrationFailure(url, only0025!, /invalid_tenant_redis_purge_schema/i);
        }
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

  it("repairs known triggers but rejects an unknown extra trigger", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0024(conn, fixtures);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await first.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query("DROP TRIGGER trg_tenant_redis_purge_targets_bu");
      await conn.query(
        `CREATE TRIGGER trg_tenant_redis_purge_targets_bu
           BEFORE UPDATE ON tenant_redis_purge_targets
           FOR EACH ROW SET NEW.target_ordinal=NEW.target_ordinal`,
      );
      const repaired = await MysqlSessionStore.connect({
        url, migrationsDir: only0025!, connectionLimit: 1,
      });
      await repaired.close();
      await assert0025Schema(conn);

      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query(
        `CREATE TRIGGER trg_tenant_redis_purge_unexpected_bi
           BEFORE INSERT ON tenant_redis_purge_jobs
           FOR EACH ROW SET NEW.attempts=NEW.attempts`,
      );
      await expectMigrationFailure(url, only0025!, /invalid_tenant_redis_purge_trigger_set/i);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
