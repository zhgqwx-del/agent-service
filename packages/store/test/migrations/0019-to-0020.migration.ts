import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MysqlSessionStore,
  newErasureRequestId,
  tenantErasureRequestHash,
} from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0018.sql");
const FROZEN_0019_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0019-delta.sql");
const MIGRATION_NAME = "0020_tenant_runtime_revocation.sql";
const MIGRATIONS_PATH = resolve(HERE, "../../migrations");
const MIGRATION_PATH = resolve(MIGRATIONS_PATH, MIGRATION_NAME);

const FROZEN_0019_MIGRATIONS = [
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
] as const;

const NEW_TABLES = [
  "tenant_runtime_revocation_jobs",
  "tenant_runtime_revocation_target_receipts",
  "tenant_runtime_revocation_receipts",
] as const;

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

async function installFrozen0019(
  conn: Connection,
  baseFixtureSql: string,
  frozen0019DeltaSql: string,
): Promise<void> {
  await conn.query(baseFixtureSql);
  await conn.query(frozen0019DeltaSql);
  await conn.query(
    "INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?, 19)",
    ["0019_tenant_credential_physical_revocation.sql"],
  );
  const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0019_MIGRATIONS);
}

async function seedHistoricalTerminalT3a(conn: Connection): Promise<void> {
  const requestId = "erase_00000000-0000-4000-8000-000000000018";
  await conn.query(
    `INSERT INTO tenant_credential_revocation_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256, phase,
        available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
        created_at_ms, updated_at_ms, credential_store_revoked_at_ms,
        completed_claim_attempt, completed_claim_token_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, 'tenant_preserved', 1, REPEAT('c',64), 'credential_store_revoked',
             NULL, 1, NULL, NULL, NULL, 1001, 1002, 1002, 1, REPEAT('d',64), NULL, NULL)`,
    [requestId],
  );
  await conn.query(
    `INSERT INTO tenant_credential_revocation_receipts
       (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
        api_key_count_before, api_key_count_after, provider_config_count_before,
        provider_config_count_after, auth_policy_present_before,
        auth_policy_present_after, auth_secret_cipher_present_before,
        auth_secret_cipher_present_after, auth_secret_key_id_present_before,
        auth_secret_key_id_present_after, store_db_timestamp_ms,
        completed_claim_attempt, completed_claim_token_sha256, runtime_disposition,
        external_disposition, content_purge_required, receipt_sha256)
     VALUES (?, 'tenant_preserved', 1, 'local-db-credential-material-v1', REPEAT('c',64),
             2, 0, 1, 0, TRUE, FALSE, TRUE, FALSE, TRUE, FALSE, 1002, 1,
             REPEAT('d',64), 'not_in_scope', 'not_supported', TRUE, REPEAT('e',64))`,
    [requestId],
  );
  await conn.query(
    `UPDATE tenant_credential_revocation_cutover
        SET control_generation=1, activated_at_ms=1002,
            first_receipt_sha256=REPEAT('e',64), evidence_sha256=REPEAT('f',64)
      WHERE singleton_id=1 AND control_generation=0`,
  );
}

async function t3aSnapshot(conn: Connection): Promise<unknown> {
  const [jobs] = await conn.query<Row[]>(
    "SELECT * FROM tenant_credential_revocation_jobs ORDER BY request_id",
  );
  const [receipts] = await conn.query<Row[]>(
    "SELECT * FROM tenant_credential_revocation_receipts ORDER BY request_id",
  );
  const [cutover] = await conn.query<Row[]>(
    "SELECT * FROM tenant_credential_revocation_cutover ORDER BY singleton_id",
  );
  return normalize({ jobs, receipts, cutover });
}

async function expectRuntimeTablesEmpty(conn: Connection): Promise<void> {
  for (const table of NEW_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
    expect(Number(rows[0]!.count), `${table} must remain inert`).toBe(0);
  }
}

async function runtimeSnapshot(conn: Connection): Promise<unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const table of NEW_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table} ORDER BY request_id`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
}

describe("real MySQL historical upgrade: 0019 -> 0020", () => {
  let baseUrl: URL;
  let admin: Connection;
  let baseFixtureSql: string;
  let frozen0019DeltaSql: string;
  let migrationSql: string;
  let only0020: string | undefined;
  let through0019: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    baseFixtureSql = await readFile(BASE_FIXTURE_PATH, "utf8");
    frozen0019DeltaSql = await readFile(FROZEN_0019_DELTA_PATH, "utf8");
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
    expect(frozen0019DeltaSql).toContain("CREATE TABLE IF NOT EXISTS tenant_credential_revocation_jobs");
    expect(frozen0019DeltaSql).not.toContain("tenant_runtime_revocation_jobs");
    only0020 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0020-"));
    await copyFile(MIGRATION_PATH, join(only0020, MIGRATION_NAME));
    through0019 = await mkdtemp(join(tmpdir(), "agent-service-migration-through-0019-"));
    await Promise.all(FROZEN_0019_MIGRATIONS.map((name) => (
      copyFile(resolve(MIGRATIONS_PATH, name), join(through0019!, name))
    )));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0020) await rm(only0020, { recursive: true, force: true });
    if (through0019) await rm(through0019, { recursive: true, force: true });
  });

  it("preserves terminal T3a evidence byte-for-byte and performs no runtime backfill", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0019(conn, baseFixtureSql, frozen0019DeltaSql);
      await seedHistoricalTerminalT3a(conn);
      const before = await t3aSnapshot(conn);

      const migrated = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0020!,
        connectionLimit: 1,
      });
      await migrated.close();

      expect(await t3aSnapshot(conn)).toEqual(before);
      await expectRuntimeTablesEmpty(conn);
      await expect(conn.query(
        `INSERT INTO tenant_runtime_revocation_receipts
           (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
            t3a_receipt_sha256, fleet_sha256, target_count, target_receipts_sha256,
            store_db_timestamp_ms, completed_claim_attempt,
            completed_claim_token_sha256, memory_disposition, external_disposition,
            content_purge_required, receipt_sha256)
         VALUES ('erase_20000000-0000-4000-8000-000000000020', 'tenant-too-many', 1,
                 'configured-fleet-runtime-v1', REPEAT('1',64), REPEAT('2',64),
                 REPEAT('3',64), 101, REPEAT('4',64), 2000, 1, REPEAT('5',64),
                 'references_dropped_not_zeroized', 'not_supported', TRUE, REPEAT('6',64))`,
      )).rejects.toThrow(/check constraint/i);
      await expectRuntimeTablesEmpty(conn);
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

  it("creates runtime work only through the explicit proof-checking materializer", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      // Build a real production-schema database through 0019, close it, then apply only 0020.
      // Keeping the phases separate prevents a fresh-latest-schema run from masking an upgrade
      // defect while the independent frozen fixture tests above/below guard historical row shape.
      const historical = await MysqlSessionStore.connect({
        url,
        migrationsDir: through0019!,
        connectionLimit: 1,
      });
      await historical.close();
      store = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0020!,
        connectionLimit: 4,
      });
      await expectRuntimeTablesEmpty(conn);

      const tenantId = `tenant-runtime-migration-${randomUUID()}`;
      await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
      const request = {
        requestId: newErasureRequestId(),
        tenantId,
        requestedByKeyId: "platform-lifecycle-admin",
        idempotencyKey: `migration-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      };
      await store.requestTenantErasure(request);
      expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(0);
      const credentialClaim = (await store.claimTenantCredentialRevocations({
        limit: 100,
        leaseMs: 60_000,
        claimToken: "migration-credential-worker",
      })).find((claim) => claim.requestId === request.requestId)!;
      await store.revokeTenantCredentialMaterial({
        requestId: credentialClaim.requestId,
        tenantId: credentialClaim.tenantId,
        subjectGeneration: credentialClaim.subjectGeneration,
        claimAttempt: credentialClaim.claimAttempt,
        claimToken: credentialClaim.claimToken,
      });
      await expectRuntimeTablesEmpty(conn);
      expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
      expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(0);
      expect(await store.getTenantRuntimeRevocationJob(tenantId, request.requestId))
        .toMatchObject({ phase: "queued", attempts: 0 });
      const [receipts] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_runtime_revocation_receipts",
      );
      const [targets] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_runtime_revocation_target_receipts",
      );
      expect(Number(receipts[0]!.count)).toBe(0);
      expect(Number(targets[0]!.count)).toBe(0);
    } finally {
      await store?.close();
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after the first 0020 table auto-commits without a migration marker", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0019(conn, baseFixtureSql, frozen0019DeltaSql);
      const boundary = migrationSql.indexOf(
        "-- One immutable row per router-configured stable target.",
      );
      expect(boundary).toBeGreaterThan(0);
      await conn.query(migrationSql.slice(0, boundary));
      const [partialTables] = await conn.query<Row[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_name LIKE 'tenant_runtime_revocation%'
          ORDER BY table_name`,
      );
      expect(partialTables.map((row) => String(row.TABLE_NAME ?? row.table_name))).toEqual([
        "tenant_runtime_revocation_jobs",
      ]);
      const [beforeMarker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(beforeMarker[0]!.count)).toBe(0);

      const replay = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0020!,
        connectionLimit: 1,
      });
      await replay.close();
      await expectRuntimeTablesEmpty(conn);
      const [afterMarker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(afterMarker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays after marker loss without rewriting jobs or target/aggregate evidence", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0019(conn, baseFixtureSql, frozen0019DeltaSql);
      const first = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0020!,
        connectionLimit: 1,
      });
      await first.close();
      await conn.query(
        `INSERT INTO tenant_runtime_revocation_jobs
           (request_id, tenant_id, subject_generation, t1_fence_sha256,
            t3a_receipt_sha256, phase, available_at_ms, attempts, claim_token,
            lease_until_ms, last_error_code, created_at_ms, updated_at_ms,
            configured_fleet_quiesced_at_ms, completed_claim_attempt,
            completed_claim_token_sha256, blocked_at_ms, blocked_reason_code)
         VALUES ('erase_30000000-0000-4000-8000-000000000020', 'tenant-runtime-replay', 1,
                 REPEAT('1',64), REPEAT('2',64), 'queued', 3000, 0, NULL, NULL, NULL,
                 3000, 3000, NULL, NULL, NULL, NULL, NULL)`,
      );
      await conn.query(
        `INSERT INTO tenant_runtime_revocation_jobs
           (request_id, tenant_id, subject_generation, t1_fence_sha256,
            t3a_receipt_sha256, phase, available_at_ms, attempts, claim_token,
            lease_until_ms, last_error_code, created_at_ms, updated_at_ms,
            configured_fleet_quiesced_at_ms, completed_claim_attempt,
            completed_claim_token_sha256, blocked_at_ms, blocked_reason_code)
         VALUES ('erase_30000000-0000-4000-8000-000000000021', 'tenant-runtime-terminal', 1,
                 REPEAT('1',64), REPEAT('2',64), 'configured_fleet_quiesced', NULL, 1,
                 NULL, NULL, NULL, 3001, 3002, 3002, 1, REPEAT('3',64), NULL, NULL)`,
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
         VALUES ('erase_30000000-0000-4000-8000-000000000021', REPEAT('4',64),
                 'tenant-runtime-terminal', 1, 'configured-runner-runtime-v1',
                 REPEAT('5',64), REPEAT('6',64), REPEAT('1',64), REPEAT('2',64),
                 REPEAT('7',64), 3, 0, 2, 0, 1, 0, 3002, REPEAT('8',64), 1,
                 REPEAT('3',64), REPEAT('9',64))`,
      );
      await conn.query(
        `INSERT INTO tenant_runtime_revocation_receipts
           (request_id, tenant_id, subject_generation, scope, t1_fence_sha256,
            t3a_receipt_sha256, fleet_sha256, target_count, target_receipts_sha256,
            store_db_timestamp_ms, completed_claim_attempt,
            completed_claim_token_sha256, memory_disposition, external_disposition,
            content_purge_required, receipt_sha256)
         VALUES ('erase_30000000-0000-4000-8000-000000000021',
                 'tenant-runtime-terminal', 1, 'configured-fleet-runtime-v1',
                 REPEAT('1',64), REPEAT('2',64), REPEAT('7',64), 1, REPEAT('a',64),
                 3002, 1, REPEAT('3',64), 'references_dropped_not_zeroized',
                 'not_supported', TRUE, REPEAT('b',64))`,
      );
      const t3aBefore = await t3aSnapshot(conn);
      const runtimeBefore = await runtimeSnapshot(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);

      const replay = await MysqlSessionStore.connect({
        url,
        migrationsDir: only0020!,
        connectionLimit: 1,
      });
      await replay.close();
      expect(await t3aSnapshot(conn)).toEqual(t3aBefore);
      expect(await runtimeSnapshot(conn)).toEqual(runtimeBefore);
      await expect(conn.query(
        `UPDATE tenant_runtime_revocation_target_receipts
            SET cache_entry_count_before=4
          WHERE request_id='erase_30000000-0000-4000-8000-000000000021'`,
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        `DELETE FROM tenant_runtime_revocation_receipts
          WHERE request_id='erase_30000000-0000-4000-8000-000000000021'`,
      )).rejects.toThrow(/append-only/i);
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
});
