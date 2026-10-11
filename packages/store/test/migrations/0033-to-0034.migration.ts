import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStructuredTelemetry,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  MysqlSessionStore,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE,
  newErasureRequestId,
  tenantCredentialRevocationFenceSha256,
  tenantErasureRequestHash,
  tenantTelemetryLifecycleSubjectReceiptSha256,
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0034_tenant_telemetry_durable_writer.sql";
// Updated whenever the migration changes; this makes the predecessor fixture a frozen database,
// not an accidental fresh-schema test against whatever happens to be on disk.
const MIGRATION_SHA256 = "a2e2a7c766909e5aca161208c4bd2c8d13cb5aff8a76362ee312ba9ab158f0e3";
const REF_KEY = Buffer.alloc(32, 0x34);
const RECONCILE_ACKNOWLEDGEMENTS = {
  admissionClosedAck: "tenant-erasure-admission-closed-v1",
  legacyWriterDrainedAck: "pre-0034-telemetry-writers-drained-v1",
  fleetStoppedAck: "all-application-writers-stopped-v1",
} as const;

function trustedRecord(
  timestampMs: number,
  ownerKind: "tenant" | "user" | "session",
  ownerId: string,
): Readonly<StructuredTelemetryRecord> {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner",
    opaqueRefKey: REF_KEY,
    now: () => timestampMs,
    sink: { write(value) { record = value; } },
  });
  telemetry.info("runner.runtime.info", {
    ownerRef: telemetry.opaqueRef(ownerKind, ownerId),
  });
  if (!record) throw new Error("trusted telemetry fixture did not emit a record");
  return record;
}

const FROZEN_0033_MIGRATIONS = [
  ["0001_init.sql", "4ddae03c6822ae65b8defc65d7c1a96f053f2b56e5442ac7ca9aacb2331d5026"],
  ["0002_auto_approved.sql", "d71b98781d5637762f840e33baeb2f423d7b2275fa309c9a433ec7c75b83b3a9"],
  ["0003_tenant_auth.sql", "7e394446ba094dce0bec563d9e1301f32590ace5080296668fa867e5f9b16d6e"],
  ["0004_compaction.sql", "7dff8f813a82107f76047f8e1d5e00a33784e2225d2ea6ac882ee9cc8bc20db5"],
  ["0005_api_key_scopes.sql", "9e6c3006906c035d13761bb861423a1af6cb91dc2c8eb38471bc8556a16bf68b"],
  ["0006_id_collation.sql", "87b4e8e20b9950ade9a63da4889027abd6ed0763e34efce5c7693a2be777169f"],
  ["0007_strict_ids_and_idempotency_scope.sql", "98a26299739412a3be9ab0c58a09a08819517c32dfd5c1f225dfb3aa11c6f705"],
  ["0008_atomic_turn_writes.sql", "9070634545ab705897ce7cf56a9d794d39b5f3974fcf46dcac7b8c163cecfcb1"],
  ["0009_session_tombstone_outbox.sql", "97e97d2a6c3c3fec75ac28baf8c72ce459df708373b161f9fe4b270a5b2f0d63"],
  ["0010_blob_ownership.sql", "df248cebda2344953e742af74ef87e40fedcae33bf80813c3a44b81b75054129"],
  ["0011_erasure_and_usage_separation.sql", "ef3d5a6931020360f83358159684256ca55bc5346f59c203f049ebcf4469b53e"],
  ["0012_erasure_job_queue.sql", "80de4af2338e18a9cbca69bae21e7414ecef57daeb39c962d61e5a2a520249fb"],
  ["0013_erasure_job_control.sql", "16b99546bec9d3e8b169dd104a5f3c7633db526f438e11043af42ff1ea050334"],
  ["0014_legacy_tombstone_compensation.sql", "609832231836e1ed332b88c77bd95ef86ca8eb7eff7345157ab2541a1289954c"],
  ["0015_retention_policy_and_legal_holds.sql", "5a0eddbaaed07e318d18ea2b6de777d5c0a6e3975168e100a9087d2be8d6eadb"],
  ["0016_erasure_purge_policy_authority.sql", "b7adefcf769adc884dd2efd901fea4767afacf3426dee97771f826cf80d1d3e3"],
  ["0017_user_export_jobs_and_artifacts.sql", "82ad26228fe29051c8d72e1339934420f12d5ee1d7506fea6419b46845a5a189"],
  ["0018_tenant_credential_revocation_fence.sql", "225b1571a990f534211f6c9ae8cc39816a449c13b87e28a67f306e7e7488d4dd"],
  ["0019_tenant_credential_physical_revocation.sql", "0a116472878dbbefeccff6830f836f786adced7384513979e0c600fef5886dfa"],
  ["0020_tenant_runtime_revocation.sql", "f09170eeed0616e5db1283e2761e3a3140c1960bdcf866e133fa9ef03bd3837b"],
  ["0021_tenant_content_inventory.sql", "fe2934d216dfde16f5912af551d387193bbabba4c8903e8484dbc248bfa365c8"],
  ["0022_tenant_purge_plan.sql", "9dcbcfb27a2a307552943da2c8b15df50f64730f9b15eeb4fe1ce055c60ca5f1"],
  ["0023_tenant_purge_execution_ack.sql", "b0535b89012703b89bbfc7cb9cf8dd949a6e750f11421905467f29e4f87295d9"],
  ["0024_tenant_database_purge.sql", "8260d0331d737923fc803cec506de0261d9962d8fce742d21e07bf07f4040e0e"],
  ["0025_tenant_redis_purge.sql", "c93ca46a13965bfbdd79e1d8dab5d4b75cd515d3c66a29cea6c27f1cef643c28"],
  ["0026_credential_lifecycle_inventory.sql", "75c67a6c430189674653d486a3d747c4ba99811c2ec967fc6990e2e40780895e"],
  ["0027_blob_storage_control.sql", "bacd1cddcaac9bb1d8a56b22ade18e7d0c3abb26ec5d41e7769505dd89b51636"],
  ["0028_blob_storage_migration.sql", "f413708b4c3c6e0ded21ccb5e214087bb49fd908a2fa1a3addaa2eb49ddf0057"],
  ["0029_tenant_credential_target_execution.sql", "bc6604cad0a552ddef9c3cd63525e564925f8b4b49d3a808519a58aaf3a29d46"],
  ["0030_tenant_restore_journal.sql", "d4f2b90c0afc3b02314078f8576bf0e3be1771df0a97e10891a434c27b0d361b"],
  ["0031_authoritative_backup_catalog.sql", "c3122ebbbed285c97e096ae751cfbe1107e9cd535405bd1585bb348f557f94c0"],
  ["0032_tenant_telemetry_lifecycle.sql", "cce4794c74ed4cee7e0b7d57a4e90c44abc0f078e26a70b6c558e40ab3fba4a9"],
  ["0033_tenant_telemetry_activation_inventory.sql", "8bb2f9c7f2a287ea15c40906c9e877f462d6d67deae76f7e0748b9e0954c2a98"],
] as const;

const WRITER_TABLES = [
  "tenant_telemetry_write_acks",
  "tenant_telemetry_write_jobs",
  "tenant_telemetry_write_payloads",
] as const;

const PROTECTED_TELEMETRY_TABLES = [
  "tenant_telemetry_activation_receipts",
  "tenant_telemetry_artifact_inventory",
  "tenant_telemetry_lifecycle_control",
  "tenant_telemetry_lifecycle_coverages",
  "tenant_telemetry_lifecycle_subjects",
  "tenant_telemetry_lifecycle_targets",
  ...WRITER_TABLES,
] as const;

const EXPECTED_TRIGGERS = [
  "trg_managed_telemetry_artifact_reservation_bi",
  "trg_managed_telemetry_write_acks_bd",
  "trg_managed_telemetry_write_acks_bi",
  "trg_managed_telemetry_write_acks_bu",
  "trg_managed_telemetry_write_acks_reservation_bi",
  "trg_managed_telemetry_write_jobs_bd",
  "trg_managed_telemetry_write_jobs_bi",
  "trg_managed_telemetry_write_jobs_bu",
  "trg_managed_telemetry_write_jobs_reservation_bi",
  "trg_managed_telemetry_write_jobs_reservation_bu",
  "trg_managed_telemetry_write_jobs_terminal_reservation_bu",
  "trg_managed_telemetry_write_payloads_bd",
  "trg_managed_telemetry_write_payloads_bi",
  "trg_managed_telemetry_write_payloads_bu",
  "trg_tenant_telemetry_activation_bd",
  "trg_tenant_telemetry_activation_bi",
  "trg_tenant_telemetry_activation_bu",
  "trg_tenant_telemetry_artifact_bd",
  "trg_tenant_telemetry_artifact_bi",
  "trg_tenant_telemetry_artifact_bu",
  "trg_tenant_telemetry_control_bd",
  "trg_tenant_telemetry_control_bi",
  "trg_tenant_telemetry_control_bu",
  "trg_tenant_telemetry_coverages_bd",
  "trg_tenant_telemetry_coverages_bi",
  "trg_tenant_telemetry_coverages_bu",
  "trg_tenant_telemetry_subjects_bd",
  "trg_tenant_telemetry_subjects_bi",
  "trg_tenant_telemetry_subjects_bu",
  "trg_tenant_telemetry_t1_job_bi",
  "trg_tenant_telemetry_targets_bd",
  "trg_tenant_telemetry_targets_bi",
  "trg_tenant_telemetry_targets_bu",
] as const;

type Row = RowDataPacket;

function errorChainMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return messages;
}

function disposableBase(raw: string): URL {
  const url = new URL(raw);
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
  return `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function activation() {
  return {
    expectedControlGeneration: 0 as const,
    targets: [
      {
        domain: "logs" as const,
        backendKind: "migration_fixture",
        adapterProtocol: "telemetry-fixture-v1",
        namespaceSha256: digest("0034:logs:namespace"),
        failureDomainSha256: digest("0034:logs:failure-domain"),
      },
      {
        domain: "traces" as const,
        backendKind: "migration_fixture",
        adapterProtocol: "telemetry-fixture-v1",
        namespaceSha256: digest("0034:traces:namespace"),
        failureDomainSha256: digest("0034:traces:failure-domain"),
      },
    ],
  };
}

describe("0033 -> 0034 durable tenant telemetry writer migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0034Dir: string;
  let through0034Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0034Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0034-"));
    through0034Dir = await mkdtemp(join(tmpdir(), "agent-service-through0034-"));
    for (const [file, expectedSha256] of FROZEN_0033_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0034Dir, file));
      await copyFile(join(MIGRATIONS_DIR, file), join(through0034Dir, file));
    }
    const migrationBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME));
    expect(createHash("sha256").update(migrationBytes).digest("hex"), MIGRATION_NAME)
      .toBe(MIGRATION_SHA256);
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0034Dir, MIGRATION_NAME));
    migrationSql = migrationBytes.toString("utf8");
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0034Dir) await rm(pre0034Dir, { recursive: true, force: true });
    if (through0034Dir) await rm(through0034Dir, { recursive: true, force: true });
  });

  async function create0033(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0034Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function upgrade(database: string, withRefKey = false): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: through0034Dir,
      ...(withRefKey ? { tenantTelemetryRefKey: REF_KEY } : {}),
    });
    await store.close();
  }

  async function reconcileLegacySubjects(
    database: string,
    refKey: Uint8Array = REF_KEY,
  ): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: through0034Dir,
      migrationMode: "reconcile-telemetry-subjects",
      tenantTelemetryRefKey: refKey,
      tenantTelemetryLegacySubjectReconcile: RECONCILE_ACKNOWLEDGEMENTS,
    });
    await store.close();
  }

  async function insertLegacyAdmissionRows(
    conn: Connection,
    tenantId: string,
    atMs: number,
    corruptAudit = false,
  ): Promise<{ tenantId: string; requestId: string; fenceSha256: string }> {
    const requestId = newErasureRequestId();
    const generation = 1;
    const fenceSha256 = tenantCredentialRevocationFenceSha256({
      tenantId,
      requestId,
      subjectGeneration: generation,
      fencedAtMs: atMs,
    });
    await conn.query(
      `INSERT INTO tenant_erasure_admissions
         (request_id,tenant_id,subject_generation,requested_by_key_id,idempotency_key,
          request_hash,created_at_ms,gated_at_ms,updated_at_ms,policy_version,policy_hash,
          control_generation)
       VALUES (?,?,?,'migration-fixture',?,?,?,?,?,NULL,NULL,0)`,
      [requestId, tenantId, generation, `legacy-${requestId}`,
        tenantErasureRequestHash(tenantId), atMs, atMs, atMs],
    );
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE subject_lifecycle
          SET state='deleting',generation=?,active_request_id=?,updated_at_ms=?
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?
          AND state='active' AND generation=0`,
      [generation, requestId, atMs, tenantId, tenantId],
    );
    expect(updated.affectedRows).toBe(1);
    await conn.query(
      `INSERT INTO erasure_audit_events
         (request_id,seq,event_type,payload,emitted_at_ms)
       VALUES (?,1,'erasure/gated',?,?)`,
      [requestId, JSON.stringify({
        status: "gated",
        subjectKind: "tenant",
        generation,
        credentialFence: corruptAudit ? "damaged-v1" : "logical-v1",
      }), atMs],
    );
    await conn.query(
      `INSERT INTO tenant_credential_revocation_fences
         (tenant_id,request_id,subject_generation,fenced_at_ms,evidence_sha256)
       VALUES (?,?,?,?,?)`,
      [tenantId, requestId, generation, atMs, fenceSha256],
    );
    await conn.query(
      `INSERT INTO tenant_credential_revocation_jobs
         (request_id,tenant_id,subject_generation,t1_fence_sha256,phase,
          available_at_ms,attempts,claim_token,lease_until_ms,last_error_code,
          created_at_ms,updated_at_ms,credential_store_revoked_at_ms,
          completed_claim_attempt,completed_claim_token_sha256,blocked_at_ms,
          blocked_reason_code)
       VALUES (?,?,?,?,'queued',?,0,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL,NULL)`,
      [requestId, tenantId, generation, fenceSha256, atMs, atMs, atMs],
    );
    return { tenantId, requestId, fenceSha256 };
  }

  async function seedFrozen0033ActiveAdmissions(
    database: string,
    tenantIds: readonly string[],
    corruptAuditTenantId?: string,
  ): Promise<Array<{ tenantId: string; requestId: string; fenceSha256: string }>> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0034Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    try {
      for (const tenantId of tenantIds) {
        await store.createApiKey(tenantId, `key-${tenantId}`, digest(`key-${tenantId}`));
      }
      await store.activateTenantTelemetryLifecycle(activation());
    } finally {
      await store.close();
    }

    const conn = await mysql.createConnection(databaseUrl(base, database));
    const seeded: Array<{ tenantId: string; requestId: string; fenceSha256: string }> = [];
    try {
      await conn.beginTransaction();
      for (const [index, tenantId] of tenantIds.entries()) {
        seeded.push(await insertLegacyAdmissionRows(
          conn,
          tenantId,
          Date.now() + index,
          corruptAuditTenantId === tenantId,
        ));
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      await conn.end();
    }
    return seeded;
  }

  async function assertDormant(conn: Connection): Promise<void> {
    for (const table of WRITER_TABLES) {
      const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]?.count), `${table} must stay empty`).toBe(0);
    }
  }

  async function assertSchemaAndTriggers(conn: Connection): Promise<void> {
    const [tables] = await conn.query<Row[]>(
      `SELECT table_name AS name,engine AS engine_value,table_collation AS collation_value
         FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name IN (${WRITER_TABLES.map(() => "?").join(",")})
        ORDER BY table_name`,
      [...WRITER_TABLES],
    );
    expect(tables.map((row) => row.name)).toEqual([...WRITER_TABLES]);
    expect(tables.every((row) => row.engine_value === "InnoDB"
      && row.collation_value === "utf8mb4_0900_as_cs")).toBe(true);
    const [shape] = await conn.query<Row[]>(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema=DATABASE() AND table_name IN (${WRITER_TABLES.map(() => "?").join(",")})) AS columns_count,
         (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name IN (${WRITER_TABLES.map(() => "?").join(",")})) AS index_columns_count,
         (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND constraint_type='CHECK'
             AND table_name IN (${WRITER_TABLES.map(() => "?").join(",")})) AS checks_count`,
      [...WRITER_TABLES, ...WRITER_TABLES, ...WRITER_TABLES],
    );
    expect(shape[0]).toMatchObject({
      columns_count: 65,
      index_columns_count: 29,
      checks_count: 3,
    });
    const [triggers] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND (event_object_table IN (${PROTECTED_TELEMETRY_TABLES.map(() => "?").join(",")})
            OR (event_object_table='tenant_credential_revocation_jobs'
              AND action_timing='BEFORE' AND event_manipulation='INSERT'))
        ORDER BY trigger_name`,
      [...PROTECTED_TELEMETRY_TABLES],
    );
    expect(triggers.map((row) => row.name)).toEqual([...EXPECTED_TRIGGERS]);
  }

  it("preserves a frozen 0033 database and installs an exact empty spool", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      const legacyStore = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: pre0034Dir,
      });
      await legacyStore.createApiKey("tenant-pre0034", "legacy-key", digest("legacy-key"));
      await legacyStore.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [before] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id,key_hash,revoked_at_ms FROM api_keys ORDER BY tenant_id,key_id",
      );
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [after] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id,key_hash,revoked_at_ms FROM api_keys ORDER BY tenant_id,key_id",
      );
      expect(after).toEqual(before);
      await assertDormant(conn);
      await assertSchemaAndTriggers(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("fail-closes an active frozen-0033 subject gap, then explicitly reconciles exact evidence", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      const [legacy] = await seedFrozen0033ActiveAdmissions(database, [
        "tenant-0033-active-gap",
      ]);
      expect(legacy).toBeDefined();

      await expect(upgrade(database, true))
        .rejects.toThrow("tenant telemetry lifecycle subject set is incomplete");
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [before] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM schema_migrations WHERE name=?) AS marker_count,
           (SELECT COUNT(*) FROM tenant_erasure_admissions) AS admission_count,
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects) AS subject_count`,
        [MIGRATION_NAME],
      );
      expect(before[0]).toMatchObject({ marker_count: 1, admission_count: 1, subject_count: 0 });
      await conn.end();
      conn = undefined;

      await reconcileLegacySubjects(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [subjectRows] = await conn.query<Row[]>(
        `SELECT s.*,v.evidence_sha256 AS expected_coverage_evidence_sha256,
                v.history_status AS expected_history_status,
                v.subject_ref_sha256 AS expected_subject_ref_sha256,
                v.target_root_sha256 AS expected_target_root_sha256
           FROM tenant_telemetry_lifecycle_subjects s
           JOIN tenant_telemetry_lifecycle_coverages v
             ON BINARY v.tenant_id=BINARY s.tenant_id
          WHERE s.request_id=?`,
        [legacy!.requestId],
      );
      expect(subjectRows).toHaveLength(1);
      const subject = subjectRows[0]!;
      const expectedBody = {
        requestId: legacy!.requestId,
        tenantId: legacy!.tenantId,
        subjectGeneration: Number(subject.subject_generation),
        controlGeneration: 1 as const,
        scope: TENANT_TELEMETRY_LIFECYCLE_SUBJECT_SCOPE,
        t1FenceSha256: legacy!.fenceSha256,
        coverageEvidenceSha256: String(subject.expected_coverage_evidence_sha256),
        historyStatus: String(subject.expected_history_status) as "legacy_history_unknown",
        subjectRefSha256: String(subject.expected_subject_ref_sha256),
        targetCount: 2 as const,
        targetRootSha256: String(subject.expected_target_root_sha256),
        boundAtDbMs: Number(subject.bound_at_db_ms),
      };
      expect(subject).toMatchObject({
        request_id: expectedBody.requestId,
        tenant_id: expectedBody.tenantId,
        subject_generation: expectedBody.subjectGeneration,
        control_generation: expectedBody.controlGeneration,
        scope: expectedBody.scope,
        t1_fence_sha256: expectedBody.t1FenceSha256,
        receipt_sha256: tenantTelemetryLifecycleSubjectReceiptSha256(expectedBody),
      });
      const exactRow = { ...subject };
      await conn.end();
      conn = undefined;

      // Response-loss/operator replay is read-validate-only for an already exact row.
      await reconcileLegacySubjects(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [replayedRows] = await conn.query<Row[]>(
        `SELECT s.*,v.evidence_sha256 AS expected_coverage_evidence_sha256,
                v.history_status AS expected_history_status,
                v.subject_ref_sha256 AS expected_subject_ref_sha256,
                v.target_root_sha256 AS expected_target_root_sha256
           FROM tenant_telemetry_lifecycle_subjects s
           JOIN tenant_telemetry_lifecycle_coverages v
             ON BINARY v.tenant_id=BINARY s.tenant_id
          WHERE s.request_id=?`,
        [legacy!.requestId],
      );
      expect(replayedRows).toEqual([exactRow]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("rejects a wrong key and damaged T1 proof without partially reconciling", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await seedFrozen0033ActiveAdmissions(
        database,
        ["tenant-0033-valid-gap", "tenant-0033-damaged-gap"],
        "tenant-0033-damaged-gap",
      );
      await expect(upgrade(database, true))
        .rejects.toThrow("tenant telemetry lifecycle subject set is incomplete");

      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
        migrationMode: "reconcile-telemetry-subjects",
        tenantTelemetryRefKey: REF_KEY,
        tenantTelemetryLegacySubjectReconcile: {
          ...RECONCILE_ACKNOWLEDGEMENTS,
          fleetStoppedAck: "wrong-ack",
          unexpectedAck: true,
        } as never,
      })).rejects.toThrow("tenant telemetry legacy subject reconcile acknowledgements are invalid");

      await expect(reconcileLegacySubjects(database, Buffer.alloc(32, 0x35)))
        .rejects.toThrow("tenant telemetry legacy subject reconcile requires the exact active ref key");
      conn = await mysql.createConnection(databaseUrl(base, database));
      let [counts] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
      );
      expect(Number(counts[0]?.count)).toBe(0);
      await conn.end();
      conn = undefined;

      await expect(reconcileLegacySubjects(database)).rejects.toThrow();
      conn = await mysql.createConnection(databaseUrl(base, database));
      [counts] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
      );
      expect(Number(counts[0]?.count)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("accepts the 0034 subject-before-job writer and rolls back a stale 0033 writer", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      const legacyStore = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: pre0034Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await legacyStore.createApiKey(
        "tenant-current-0034-writer",
        "current-key",
        digest("current-key"),
      );
      await legacyStore.activateTenantTelemetryLifecycle(activation());
      await legacyStore.close();
      await upgrade(database, true);

      const currentStore = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      const currentRequestId = newErasureRequestId();
      await currentStore.requestTenantErasure({
        requestId: currentRequestId,
        tenantId: "tenant-current-0034-writer",
        requestedByKeyId: "migration-fixture",
        idempotencyKey: `current-${currentRequestId}`,
        requestHash: tenantErasureRequestHash("tenant-current-0034-writer"),
        atMs: Date.now(),
      });
      await currentStore.createApiKey(
        "tenant-stale-0033-writer",
        "stale-key",
        digest("stale-key"),
      );
      await currentStore.close();

      conn = await mysql.createConnection(databaseUrl(base, database));
      const [currentRows] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects
             WHERE request_id=?) AS subject_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_jobs
             WHERE request_id=?) AS job_count`,
        [currentRequestId, currentRequestId],
      );
      expect(currentRows[0]).toMatchObject({ subject_count: 1, job_count: 1 });

      await conn.beginTransaction();
      await expect(insertLegacyAdmissionRows(
        conn,
        "tenant-stale-0033-writer",
        Date.now(),
      )).rejects.toThrow("tenant telemetry lifecycle subject must precede T1 job");
      await conn.rollback();
      const [staleRows] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_erasure_admissions
             WHERE tenant_id='tenant-stale-0033-writer') AS admission_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_fences
             WHERE tenant_id='tenant-stale-0033-writer') AS fence_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_jobs
             WHERE tenant_id='tenant-stale-0033-writer') AS job_count,
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects
             WHERE tenant_id='tenant-stale-0033-writer') AS subject_count,
           (SELECT state FROM subject_lifecycle
             WHERE tenant_id='tenant-stale-0033-writer'
               AND subject_kind='tenant' AND subject_id='tenant-stale-0033-writer')
             AS lifecycle_state`,
      );
      expect(staleRows[0]).toMatchObject({
        admission_count: 0,
        fence_count: 0,
        job_count: 0,
        subject_count: 0,
        lifecycle_state: "active",
      });
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("rolls back inserted subjects when the final global closure check fails", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await seedFrozen0033ActiveAdmissions(database, ["tenant-0033-postcheck-gap"]);
      await expect(upgrade(database, true))
        .rejects.toThrow("tenant telemetry lifecycle subject set is incomplete");
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `INSERT INTO agent_versions (tenant_id,agent_id,version,definition,created_at_ms)
         VALUES ('tenant-0033-orphan-source','agent-default',1,?,?)`,
        [JSON.stringify({}), Date.now()],
      );
      await conn.end();
      conn = undefined;

      await expect(reconcileLegacySubjects(database))
        .rejects.toBeInstanceOf(Error);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [rows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("retains the bootstrap guard while replaying a crash after dropping the primary T1 guard", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    let replayDir: string | undefined;
    let replayGateHeld = false;
    let upgradeResult: Promise<{
      ok: boolean;
      error: unknown;
    }> | undefined;
    const replayGateName = `as0034_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    try {
      await create0033(database);
      const legacyStore = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: pre0034Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await legacyStore.createApiKey(
        "tenant-0034-trigger-replay",
        "trigger-replay-key",
        digest("trigger-replay-key"),
      );
      await legacyStore.activateTenantTelemetryLifecycle(activation());
      await legacyStore.close();

      const all = statements(migrationSql);
      const bootstrapCreateIndex = all.findIndex((statement) => statement.startsWith(
        "CREATE TRIGGER trg_tenant_telemetry_t1_job_bi_bootstrap ",
      ));
      const primaryDropIndex = all.findIndex((statement) => (
        statement === "DROP TRIGGER IF EXISTS trg_tenant_telemetry_t1_job_bi"
      ));
      expect(bootstrapCreateIndex).toBeGreaterThan(-1);
      expect(primaryDropIndex).toBe(bootstrapCreateIndex + 1);

      // Model process death after the primary was dropped but while the bootstrap twin survived.
      conn = await mysql.createConnection(databaseUrl(base, database));
      for (const statement of all.slice(0, primaryDropIndex + 1)) await conn.query(statement);
      const [interruptedTriggers] = await conn.query<Row[]>(
        `SELECT trigger_name AS name FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name IN (
              'trg_tenant_telemetry_t1_job_bi',
              'trg_tenant_telemetry_t1_job_bi_bootstrap')
          ORDER BY trigger_name`,
      );
      expect(interruptedTriggers.map((row) => row.name)).toEqual([
        "trg_tenant_telemetry_t1_job_bi_bootstrap",
      ]);
      await conn.query(
        `CREATE TABLE migration_0034_replay_probe (
           probe_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
           reached TINYINT UNSIGNED NOT NULL
         ) ENGINE=InnoDB`,
      );
      await conn.query(
        "INSERT INTO migration_0034_replay_probe (probe_id,reached) VALUES (1,0)",
      );

      // A test-only migration copy pauses immediately after the replayed DROP primary.  The
      // production SQL on either side is unchanged; this makes the exact auto-commit boundary
      // observable while a concurrent frozen writer attempts its whole T1 transaction.
      replayDir = await mkdtemp(join(tmpdir(), "agent-service-replay0034-"));
      for (const [file] of FROZEN_0033_MIGRATIONS) {
        await copyFile(join(MIGRATIONS_DIR, file), join(replayDir, file));
      }
      const primaryDropSql = "DROP TRIGGER IF EXISTS trg_tenant_telemetry_t1_job_bi;\n";
      expect(migrationSql.split(primaryDropSql)).toHaveLength(2);
      const replayGateSql =
        "UPDATE migration_0034_replay_probe SET reached=1 WHERE probe_id=1;\n"
        + `SELECT GET_LOCK('${replayGateName}',30);\n`;
      await writeFile(
        join(replayDir, MIGRATION_NAME),
        migrationSql.replace(primaryDropSql, primaryDropSql + replayGateSql),
      );
      const [gateRows] = await admin.query<Row[]>(
        "SELECT GET_LOCK(?,30) AS acquired",
        [replayGateName],
      );
      expect(Number(gateRows[0]?.acquired)).toBe(1);
      replayGateHeld = true;

      upgradeResult = MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: replayDir,
        tenantTelemetryRefKey: REF_KEY,
      }).then(async (store) => {
        await store.close();
        return { ok: true as const, error: undefined };
      },
        (error: unknown) => ({ ok: false as const, error }),
      );
      let observedReplayGateWait = false;
      for (let attempt = 0; attempt < 1_000 && !observedReplayGateWait; attempt += 1) {
        const [probeRows] = await conn.query<Row[]>(
          "SELECT reached FROM migration_0034_replay_probe WHERE probe_id=1",
        );
        observedReplayGateWait = Number(probeRows[0]?.reached) === 1;
        if (!observedReplayGateWait) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      }
      if (!observedReplayGateWait) {
        await admin.query("SELECT RELEASE_LOCK(?)", [replayGateName]);
        replayGateHeld = false;
        const earlyResult = await upgradeResult;
        if (!earlyResult.ok) {
          throw new Error("0034 replay failed before reaching the injected trigger gate", {
            cause: earlyResult.error,
          });
        }
      }
      expect(observedReplayGateWait).toBe(true);
      const [replayingTriggers] = await admin.query<Row[]>(
        `SELECT trigger_name AS name FROM information_schema.triggers
          WHERE trigger_schema=?
            AND trigger_name IN (
              'trg_tenant_telemetry_t1_job_bi',
              'trg_tenant_telemetry_t1_job_bi_bootstrap')
          ORDER BY trigger_name`,
        [database],
      );
      expect(replayingTriggers.map((row) => row.name)).toEqual([
        "trg_tenant_telemetry_t1_job_bi_bootstrap",
      ]);

      await conn.beginTransaction();
      await expect(insertLegacyAdmissionRows(
        conn,
        "tenant-0034-trigger-replay",
        Date.now(),
      )).rejects.toThrow("tenant telemetry lifecycle subject must precede T1 job");
      await conn.rollback();
      await conn.end();
      conn = undefined;
      await admin.query("SELECT RELEASE_LOCK(?)", [replayGateName]);
      replayGateHeld = false;
      const result = await upgradeResult;
      expect(result).toEqual({ ok: true, error: undefined });

      conn = await mysql.createConnection(databaseUrl(base, database));
      const [rows] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_erasure_admissions
             WHERE tenant_id='tenant-0034-trigger-replay') AS admission_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_fences
             WHERE tenant_id='tenant-0034-trigger-replay') AS fence_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_jobs
             WHERE tenant_id='tenant-0034-trigger-replay') AS job_count,
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects
             WHERE tenant_id='tenant-0034-trigger-replay') AS subject_count,
           (SELECT state FROM subject_lifecycle
             WHERE tenant_id='tenant-0034-trigger-replay'
               AND subject_kind='tenant' AND subject_id='tenant-0034-trigger-replay')
             AS lifecycle_state`,
      );
      expect(rows[0]).toMatchObject({
        admission_count: 0,
        fence_count: 0,
        job_count: 0,
        subject_count: 0,
        lifecycle_state: "active",
      });
      await assertDormant(conn);
      await assertSchemaAndTriggers(conn);
    } finally {
      await conn?.rollback().catch(() => {});
      await conn?.end();
      if (replayGateHeld) {
        await admin.query("SELECT RELEASE_LOCK(?)", [replayGateName]).catch(() => {});
      }
      await upgradeResult?.catch(() => {});
      if (replayDir) await rm(replayDir, { recursive: true, force: true });
      await cleanup(database);
    }
  });

  it("converges from each CREATE TABLE auto-commit boundary", async () => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_write_") ? [index] : []
    ));
    expect(createIndexes).toHaveLength(3);
    for (const cutIndex of createIndexes) {
      const database = databaseName();
      let conn: Connection | undefined;
      try {
        await create0033(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
        await conn.end();
        conn = undefined;
        await upgrade(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        await assertDormant(conn);
        await assertSchemaAndTriggers(conn);
      } finally {
        await conn?.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial table without recording the marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TABLE tenant_telemetry_write_jobs
           (write_operation_sha256 CHAR(64) NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(/0034_tenant_telemetry_durable_writer/);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("repairs owned triggers after marker loss without materializing jobs", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_managed_telemetry_write_payloads_bu");
      await conn.query("DROP TRIGGER trg_tenant_telemetry_t1_job_bi");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertDormant(conn);
      await assertSchemaAndTriggers(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("fails startup when an unchanged 0033 trigger drifts after the 0034 marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_tenant_telemetry_targets_bu");
      const [driftedTriggers] = await conn.query<Row[]>(
        `SELECT trigger_name AS name FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND (event_object_table IN (${PROTECTED_TELEMETRY_TABLES.map(() => "?").join(",")})
              OR (event_object_table='tenant_credential_revocation_jobs'
                AND action_timing='BEFORE' AND event_manipulation='INSERT'))
          ORDER BY trigger_name`,
        [...PROTECTED_TELEMETRY_TABLES],
      );
      expect(driftedTriggers.map((row) => row.name)).toEqual(
        EXPECTED_TRIGGERS.filter((name) => name !== "trg_tenant_telemetry_targets_bu"),
      );
      await conn.end();
      conn = undefined;

      const startupError = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
      }).then(async (store) => {
        await store.close();
        return null;
      }, (error: unknown) => error);
      expect(startupError).toBeInstanceOf(Error);
      expect(errorChainMessages(startupError)).toEqual([
        "0034 tenant telemetry writer schema fingerprint verification failed",
        "stored schema does not match the 0034 fingerprint",
      ]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("fails startup when the stale-writer T1 job guard is removed after the marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_tenant_telemetry_t1_job_bi");
      await conn.end();
      conn = undefined;

      const startupError = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
      }).then(async (store) => {
        await store.close();
        return null;
      }, (error: unknown) => error);
      expect(startupError).toBeInstanceOf(Error);
      expect(errorChainMessages(startupError)).toEqual([
        "0034 tenant telemetry writer schema fingerprint verification failed",
        "stored schema does not match the 0034 fingerprint",
      ]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("fails startup when a differently named trigger is added to a protected table", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      // MySQL executes this later-created BEFORE trigger after the owned guard by default.  It
      // therefore models a privileged trigger that can rewrite NEW after validation while avoiding
      // both of the owned trigger-name prefixes.
      await conn.query(
        `CREATE TRIGGER alternate_writer_after_guard_bi
           BEFORE INSERT ON tenant_telemetry_write_jobs
           FOR EACH ROW SET NEW.tenant_id=CONCAT(NEW.tenant_id,'-rewritten')`,
      );
      const [extra] = await conn.query<Row[]>(
        `SELECT trigger_name AS name,event_object_table AS table_name
           FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name='alternate_writer_after_guard_bi'`,
      );
      expect(extra).toEqual([{
        name: "alternate_writer_after_guard_bi",
        table_name: "tenant_telemetry_write_jobs",
      }]);
      await conn.end();
      conn = undefined;

      const startupError = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
      }).then(async (store) => {
        await store.close();
        return null;
      }, (error: unknown) => error);
      expect(startupError).toBeInstanceOf(Error);
      expect(errorChainMessages(startupError)).toEqual([
        "0034 tenant telemetry writer schema fingerprint verification failed",
        "stored schema does not match the 0034 fingerprint",
      ]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("rejects an additional differently named BEFORE INSERT trigger on the T1 job table", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TRIGGER alternate_t1_job_before_insert
           BEFORE INSERT ON tenant_credential_revocation_jobs
           FOR EACH ROW SET NEW.updated_at_ms=NEW.updated_at_ms`,
      );
      await conn.end();
      conn = undefined;

      const startupError = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
      }).then(async (store) => {
        await store.close();
        return null;
      }, (error: unknown) => error);
      expect(startupError).toBeInstanceOf(Error);
      expect(errorChainMessages(startupError)).toEqual([
        "0034 tenant telemetry writer schema fingerprint verification failed",
        "stored schema does not match the 0034 fingerprint",
      ]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("allows an unrelated-table trigger after the 0034 marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TABLE unrelated_trigger_fixture (
           fixture_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
           fixture_value BIGINT UNSIGNED NOT NULL
         ) ENGINE=InnoDB`,
      );
      await conn.query(
        `CREATE TRIGGER alternate_unrelated_bi
           BEFORE INSERT ON unrelated_trigger_fixture
           FOR EACH ROW SET NEW.fixture_value=NEW.fixture_value+1`,
      );
      await conn.end();
      conn = undefined;

      const store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
      });
      await store.close();
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("blocks marker-loss replay when a queued payload projection is incomplete", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0033(database);
      const store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0034Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await store.activateTenantTelemetryLifecycle(activation());
      await store.createApiKey("tenant-0034-damaged", "key", digest("tenant-0034-damaged"));
      const queued = await store.enqueueTenantTelemetryArtifact({
        tenantId: "tenant-0034-damaged",
        expectedControlGeneration: 1,
        domain: "logs",
        artifactIdSha256: digest("tenant-0034-damaged:artifact"),
        artifactGeneration: 1,
        ownerKind: "tenant",
        ownerId: "tenant-0034-damaged",
        ownerUserId: null,
        sourceSchema: "migration-fixture-v1",
        sourceGeneration: 0,
        sourceHighWaterDbMs: 1,
        payload: {
          schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
          domain: "logs",
          records: [trustedRecord(1, "tenant", "tenant-0034-damaged")],
        },
      });
      await store.close();

      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_managed_telemetry_write_payloads_bd");
      await conn.query(
        "DELETE FROM tenant_telemetry_write_payloads WHERE write_operation_sha256=?",
        [queued.writeOperationSha256],
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;

      await expect(upgrade(database, true))
        .rejects.toThrow(/0034_tenant_telemetry_durable_writer/);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });
});
