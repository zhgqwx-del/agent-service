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
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  tenantTelemetryWriteAdapterEvidenceSha256,
  type ActivateTenantTelemetryApplicationCaptureInput,
  type EnqueueTenantTelemetryArtifactInput,
  type TenantTelemetryDomain,
  type TenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteAuthorization,
  type TenantTelemetryWriteClaim,
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0035_tenant_telemetry_application_capture.sql";
const MIGRATION_SHA256 = "64ef573ed24160d1e2395ca4ca5d0c3106abd445b16bd9941a11966953d4c7b6";
const REF_KEY = Buffer.alloc(32, 0x35);
const PRODUCER_PROTOCOL = "application-dual-write-v1";
const PRODUCER_CONTRACT_SHA256 = "9".repeat(64);

// Pin the predecessor bytes so this suite proves a real 0034 -> 0035 upgrade instead of quietly
// becoming another fresh-schema test when an older migration is edited.
const FROZEN_0034_MIGRATIONS = [
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
  ["0034_tenant_telemetry_durable_writer.sql", "a2e2a7c766909e5aca161208c4bd2c8d13cb5aff8a76362ee312ba9ab158f0e3"],
] as const;

const APPLICATION_TABLES = [
  "tenant_telemetry_application_activation_receipts",
  "tenant_telemetry_application_coverages",
  "tenant_telemetry_application_domain_controls",
  "tenant_telemetry_application_write_bindings",
] as const;

const APPLICATION_TRIGGERS = [
  "trg_tt_app_activation_bd",
  "trg_tt_app_activation_bi",
  "trg_tt_app_activation_bu",
  "trg_tt_app_artifact_bi",
  "trg_tt_app_coverage_bd",
  "trg_tt_app_coverage_bi",
  "trg_tt_app_coverage_bu",
  "trg_tt_app_domain_control_bd",
  "trg_tt_app_domain_control_bi",
  "trg_tt_app_domain_control_bu",
  "trg_tt_app_subject_capture_bi",
  "trg_tt_app_subject_capture_bu",
  "trg_tt_app_write_binding_bd",
  "trg_tt_app_write_binding_bi",
  "trg_tt_app_write_binding_bu",
] as const;

type Row = RowDataPacket;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function lifecycleActivation() {
  return {
    expectedControlGeneration: 0 as const,
    targets: [
      {
        domain: "logs" as const,
        backendKind: "migration_fixture",
        adapterProtocol: "telemetry-fixture-v1",
        namespaceSha256: digest("0035:logs:namespace"),
        failureDomainSha256: digest("0035:logs:failure-domain"),
      },
      {
        domain: "traces" as const,
        backendKind: "migration_fixture",
        adapterProtocol: "telemetry-fixture-v1",
        namespaceSha256: digest("0035:traces:namespace"),
        failureDomainSha256: digest("0035:traces:failure-domain"),
      },
    ],
  };
}

function trustedRecord(timestampMs: number, tenantId: string): Readonly<StructuredTelemetryRecord> {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner",
    opaqueRefKey: REF_KEY,
    now: () => timestampMs,
    sink: { write(value) { record = value; } },
  });
  telemetry.info("runner.runtime.info", {
    ownerRef: telemetry.opaqueRef("tenant", tenantId),
  });
  if (!record) throw new Error("trusted telemetry fixture did not emit a record");
  return record;
}

function writeInput(
  tenantId: string,
  identity: string,
  producerBound = false,
): EnqueueTenantTelemetryArtifactInput {
  return {
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: digest(`0035:${identity}:artifact`),
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "migration-fixture-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    ...(producerBound ? {
      producerProtocol: PRODUCER_PROTOCOL,
      producerContractSha256: PRODUCER_CONTRACT_SHA256,
    } : {}),
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRecord(1_000, tenantId)],
    },
  };
}

function authorization(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAuthorization {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterResult(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAdapterResult {
  const evidence = {
    adapterProtocol: claim.target.adapterProtocol,
    domain: claim.inventory.domain,
    targetSha256: claim.target.targetSha256,
    writeOperationSha256: claim.writeOperationSha256,
    artifactIdSha256: claim.inventory.artifactIdSha256,
    artifactGeneration: claim.inventory.artifactGeneration,
    payloadSha256: claim.inventory.payloadSha256,
    manifestSha256: claim.inventory.manifestSha256,
    outcome: "written" as const,
    replayed: false,
  };
  return {
    ...evidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
  };
}

async function captureActivation(
  store: MysqlSessionStore,
  domain: TenantTelemetryDomain,
): Promise<ActivateTenantTelemetryApplicationCaptureInput> {
  const control = await store.getTenantTelemetryLifecycleControl();
  if (control.state !== "active") throw new Error("fixture lifecycle is inactive");
  const target = (await store.listTenantTelemetryLifecycleTargets())
    .find((candidate) => candidate.domain === domain);
  if (!target) throw new Error("fixture target is missing");
  return {
    domain,
    expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: control.activationEvidenceSha256,
    lifecycleTargetSha256: target.targetSha256,
    lifecycleTargetReceiptSha256: target.receiptSha256,
    producerProtocol: PRODUCER_PROTOCOL,
    producerContractSha256: PRODUCER_CONTRACT_SHA256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  };
}

describe("0034 -> 0035 tenant telemetry application capture migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0035Dir: string;
  let through0035Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0035Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0035-"));
    through0035Dir = await mkdtemp(join(tmpdir(), "agent-service-through0035-"));
    for (const [file, expectedSha256] of FROZEN_0034_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0035Dir, file));
      await copyFile(join(MIGRATIONS_DIR, file), join(through0035Dir, file));
    }
    const migrationBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME));
    expect(createHash("sha256").update(migrationBytes).digest("hex"), MIGRATION_NAME)
      .toBe(MIGRATION_SHA256);
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0035Dir, MIGRATION_NAME));
    migrationSql = migrationBytes.toString("utf8");
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0035Dir) await rm(pre0035Dir, { recursive: true, force: true });
    if (through0035Dir) await rm(through0035Dir, { recursive: true, force: true });
  });

  async function create0034(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0035Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function upgrade(database: string, migrationsDir = through0035Dir): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function seed0034(database: string, tenantId: string) {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0035Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    try {
      await store.activateTenantTelemetryLifecycle(lifecycleActivation());
      // Creating the tenant after lifecycle activation gives 0034's writer the required
      // complete-since-creation lifecycle coverage while application capture is still absent.
      await store.createApiKey(tenantId, `key-${tenantId}`, digest(`key:${tenantId}`));
      return await store.enqueueTenantTelemetryArtifact(writeInput(tenantId, "pre-cutover"));
    } finally {
      await store.close();
    }
  }

  async function assertExactApplicationSchema(conn: Connection): Promise<void> {
    const [tables] = await conn.query<Row[]>(
      `SELECT table_name AS name,engine AS engine_value,table_collation AS collation_value
         FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name IN (${APPLICATION_TABLES.map(() => "?").join(",")})
        ORDER BY table_name`,
      [...APPLICATION_TABLES],
    );
    expect(tables.map((row) => row.name)).toEqual([...APPLICATION_TABLES]);
    expect(tables.every((row) => row.engine_value === "InnoDB"
      && row.collation_value === "utf8mb4_0900_as_cs")).toBe(true);
    const [columns] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.columns
        WHERE table_schema=DATABASE() AND table_name IN (${APPLICATION_TABLES.map(() => "?").join(",")})`,
      [...APPLICATION_TABLES],
    );
    expect(Number(columns[0]?.count)).toBe(71);
    const [triggers] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\\_tt\\_app\\_%'
        ORDER BY trigger_name`,
    );
    expect(triggers.map((row) => row.name)).toEqual([...APPLICATION_TRIGGERS]);
  }

  it("expands a frozen 0034 database dormantly without backfilling an old job", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0034(database);
      const oldJob = await seed0034(database, "tenant-pre0035");
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [beforeJobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [controls] = await conn.query<Row[]>(
        `SELECT domain,control_generation,state,activated_at_db_ms
           FROM tenant_telemetry_application_domain_controls ORDER BY domain`,
      );
      expect(controls).toEqual([
        { domain: "logs", control_generation: 0, state: "inactive", activated_at_db_ms: null },
        { domain: "traces", control_generation: 0, state: "inactive", activated_at_db_ms: null },
      ]);
      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_application_activation_receipts) AS receipt_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_coverages) AS coverage_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_write_bindings) AS binding_count,
           (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS job_count`,
      );
      expect(counts[0]).toMatchObject({
        receipt_count: 0,
        coverage_count: 0,
        binding_count: 0,
        job_count: 1,
      });
      const [afterJobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      expect(afterJobs).toEqual(beforeJobs);
      expect(afterJobs[0]?.write_operation_sha256).toBe(oldJob.writeOperationSha256);
      const [subject] = await conn.query<Row[]>(
        `SELECT telemetry_logs_capture_generation,telemetry_traces_capture_generation
           FROM subject_lifecycle
          WHERE tenant_id='tenant-pre0035' AND subject_kind='tenant'
            AND subject_id='tenant-pre0035'`,
      );
      expect(subject).toEqual([{
        telemetry_logs_capture_generation: 0,
        telemetry_traces_capture_generation: 0,
      }]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(1);
      await assertExactApplicationSchema(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("rejects stale tenant writers and unbound jobs after cutover and keeps evidence append-only", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      await create0034(database);
      const oldJob = await seed0034(database, "tenant-cutover");
      await upgrade(database);

      store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0035Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      const activated = await store.activateTenantTelemetryApplicationCapture(
        await captureActivation(store, "logs"),
      );
      expect(activated.control).toMatchObject({
        domain: "logs",
        state: "active",
        controlGeneration: 1,
        coverageCount: 1,
        preCutoverWriteCount: 1,
      });
      await expect(store.getTenantTelemetryApplicationWriteBinding(
        "tenant-cutover",
        oldJob.writeOperationSha256,
      )).resolves.toBeNull();

      const [legacyClaim] = await store.claimTenantTelemetryWriteJobs({
        limit: 1,
        leaseMs: 60_000,
        claimToken: "migration-0035-pre-cutover-claim",
        adapterProtocol: "telemetry-fixture-v1",
      });
      expect(legacyClaim?.writeOperationSha256).toBe(oldJob.writeOperationSha256);
      const legacyAuthorization = authorization(legacyClaim!);
      await store.reserveTenantTelemetryExternalMutation(
        legacyAuthorization,
        legacyClaim!.target.adapterProtocol,
      );
      const legacyAck = await store.completeTenantTelemetryWrite(
        legacyAuthorization,
        adapterResult(legacyClaim!),
      );
      expect(legacyAck).toMatchObject({
        writeOperationSha256: oldJob.writeOperationSha256,
        inventorySha256: oldJob.inventory.inventorySha256,
      });
      await expect(store.getTenantTelemetryArtifact(
        "tenant-cutover",
        "logs",
        oldJob.inventory.artifactIdSha256,
        oldJob.inventory.artifactGeneration,
      )).resolves.toMatchObject({ inventorySha256: oldJob.inventory.inventorySha256 });
      await expect(store.getTenantTelemetryApplicationWriteBinding(
        "tenant-cutover",
        oldJob.writeOperationSha256,
      )).resolves.toBeNull();

      await expect(store.enqueueTenantTelemetryArtifact(
        writeInput("tenant-cutover", "stale-writer"),
      )).rejects.toThrow();
      const postCutover = await store.enqueueTenantTelemetryArtifact(
        writeInput("tenant-cutover", "bound-writer", true),
      );
      await expect(store.getTenantTelemetryApplicationWriteBinding(
        "tenant-cutover",
        postCutover.writeOperationSha256,
      )).resolves.toMatchObject({
        writeOperationSha256: postCutover.writeOperationSha256,
        producerProtocol: PRODUCER_PROTOCOL,
        producerContractSha256: PRODUCER_CONTRACT_SHA256,
      });
      await store.close();
      store = undefined;

      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.beginTransaction();
      await conn.query(
        "INSERT INTO tenants (tenant_id,name,created_at_ms) VALUES ('stale-tenant','stale',1000)",
      );
      await expect(conn.query(
        `INSERT INTO subject_lifecycle
           (tenant_id,subject_kind,subject_id,state,generation,active_request_id,
            legal_hold_at_ms,created_at_ms,updated_at_ms)
         VALUES ('stale-tenant','tenant','stale-tenant','active',0,NULL,NULL,1000,1000)`,
      )).rejects.toThrow("tenant telemetry application capture generation is stale");
      await conn.rollback();

      const [templates] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs WHERE write_operation_sha256=?",
        [oldJob.writeOperationSha256],
      );
      const template = templates[0];
      if (!template) throw new Error("pre-cutover job template is missing");
      const inventory = typeof template.inventory_json === "string"
        ? JSON.parse(template.inventory_json) as Record<string, unknown>
        : template.inventory_json as Record<string, unknown>;
      const operationSha256 = digest("0035:raw-unbound:operation");
      const inventorySha256 = digest("0035:raw-unbound:inventory");
      const artifactIdSha256 = digest("0035:raw-unbound:artifact");
      const payloadSha256 = digest("0035:raw-unbound:payload");
      const manifestSha256 = digest("0035:raw-unbound:manifest");
      const unbound: Record<string, unknown> = {
        ...template,
        write_operation_sha256: operationSha256,
        phase: "queued",
        inventory_sha256: inventorySha256,
        artifact_id_sha256: artifactIdSha256,
        payload_sha256: payloadSha256,
        manifest_sha256: manifestSha256,
        available_at_ms: template.created_at_ms,
        attempts: 0,
        claim_token: null,
        lease_until_ms: null,
        last_error_code: null,
        mutation_adapter_protocol: null,
        mutation_started_at_db_ms: null,
        mutation_started_claim_attempt: null,
        mutation_started_claim_token_sha256: null,
        mutation_reservation_receipt_sha256: null,
        write_ack_receipt_sha256: null,
        written_at_db_ms: null,
        completed_claim_attempt: null,
        completed_claim_token_sha256: null,
        blocked_at_db_ms: null,
        blocked_reason_code: null,
        updated_at_ms: template.created_at_ms,
        inventory_json: JSON.stringify({
          ...inventory,
          inventorySha256,
          artifactIdSha256,
          payloadSha256,
          manifestSha256,
        }),
      };
      const columns = Object.keys(unbound);
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_write_jobs (${columns.map((name) => `\`${name}\``).join(",")})
         VALUES (${columns.map(() => "?").join(",")})`,
        columns.map((name) => unbound[name]),
      )).rejects.toThrow("tenant telemetry write job is not application-capture-bound");

      const [inventoryTemplates] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_inventory WHERE inventory_sha256=?",
        [oldJob.inventory.inventorySha256],
      );
      const inventoryTemplate = inventoryTemplates[0];
      if (!inventoryTemplate) throw new Error("pre-cutover terminal inventory is missing");
      const rawInventory: Record<string, unknown> = {
        ...inventoryTemplate,
        inventory_sha256: digest("0035:raw-orphan-inventory:inventory"),
        artifact_id_sha256: digest("0035:raw-orphan-inventory:artifact"),
        payload_sha256: digest("0035:raw-orphan-inventory:payload"),
        manifest_sha256: digest("0035:raw-orphan-inventory:manifest"),
        receipt_sha256: digest("0035:raw-orphan-inventory:receipt"),
      };
      const inventoryColumns = Object.keys(rawInventory);
      const [inventoryCountBefore] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_artifact_inventory",
      );

      // A valid 0035 binding alone is not publication authority.  The worker must first claim the
      // queued job and publish its immutable external-mutation reservation.  The test turns the
      // exact in-memory inventory into its SQL row form so every other legacy 0033 guard matches.
      const preclaimInventory = Object.fromEntries(Object.entries(postCutover.inventory).map(
        ([key, value]) => [
          key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
          value,
        ],
      ));
      const preclaimInventoryColumns = Object.keys(preclaimInventory);
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_artifact_inventory
           (${preclaimInventoryColumns.map((name) => `\`${name}\``).join(",")})
         VALUES (${preclaimInventoryColumns.map(() => "?").join(",")})`,
        preclaimInventoryColumns.map((name) => preclaimInventory[name]),
      )).rejects.toThrow("tenant telemetry artifact is not application-capture-bound");

      await expect(conn.query(
        `INSERT INTO tenant_telemetry_artifact_inventory
           (${inventoryColumns.map((name) => `\`${name}\``).join(",")})
         VALUES (${inventoryColumns.map(() => "?").join(",")})`,
        inventoryColumns.map((name) => rawInventory[name]),
      )).rejects.toThrow("tenant telemetry artifact is not application-capture-bound");
      const [inventoryCountAfter] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_artifact_inventory",
      );
      expect(Number(inventoryCountAfter[0]?.count))
        .toBe(Number(inventoryCountBefore[0]?.count));

      await expect(conn.query(
        "UPDATE tenant_telemetry_application_coverages SET coverage_started_at_db_ms=coverage_started_at_db_ms+1 WHERE domain='logs'",
      )).rejects.toThrow("tenant telemetry application coverage is immutable");
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_application_activation_receipts WHERE domain='logs'",
      )).rejects.toThrow("tenant telemetry application activation receipt is append-only");
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_application_write_bindings WHERE write_operation_sha256=?",
        [postCutover.writeOperationSha256],
      )).rejects.toThrow("tenant telemetry application write binding is append-only");
      const [survivors] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenants WHERE tenant_id='stale-tenant') AS stale_tenant_count,
           (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
             WHERE write_operation_sha256=?) AS unbound_job_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_write_bindings
             WHERE write_operation_sha256=?) AS binding_count`,
        [operationSha256, postCutover.writeOperationSha256],
      );
      expect(survivors[0]).toMatchObject({
        stale_tenant_count: 0,
        unbound_job_count: 0,
        binding_count: 1,
      });
    } finally {
      await conn?.rollback().catch(() => {});
      await conn?.end();
      await store?.close().catch(() => {});
      await cleanup(database);
    }
  });

  it("rolls back coverage and receipt publication when activation fails mid-transaction", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      await create0034(database);
      await seed0034(database, "tenant-activation-rollback");
      await upgrade(database);
      store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0035Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      const activation = await captureActivation(store, "logs");
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TRIGGER migration_0035_activation_failure_bi
           BEFORE INSERT ON tenant_telemetry_application_activation_receipts
           FOR EACH ROW SIGNAL SQLSTATE '45000'
             SET MESSAGE_TEXT='injected 0035 activation publication failure'`,
      );

      await expect(store.activateTenantTelemetryApplicationCapture(activation)).rejects.toThrow();
      const [projection] = await conn.query<Row[]>(
        `SELECT
           (SELECT state FROM tenant_telemetry_application_domain_controls
             WHERE domain='logs') AS control_state,
           (SELECT control_generation FROM tenant_telemetry_application_domain_controls
             WHERE domain='logs') AS control_generation,
           (SELECT COUNT(*) FROM tenant_telemetry_application_coverages
             WHERE domain='logs') AS coverage_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_activation_receipts
             WHERE domain='logs') AS receipt_count`,
      );
      expect(projection[0]).toMatchObject({
        control_state: "inactive",
        control_generation: 0,
        coverage_count: 0,
        receipt_count: 0,
      });
      await conn.query("DROP TRIGGER migration_0035_activation_failure_bi");
    } finally {
      await conn?.end();
      await store?.close();
      await cleanup(database);
    }
  });

  it("repairs an owned trigger after marker loss without materializing capture evidence", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0034(database);
      await seed0034(database, "tenant-marker-loss");
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_tt_app_coverage_bu");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertExactApplicationSchema(conn);
      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_application_activation_receipts) AS receipt_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_coverages) AS coverage_count,
           (SELECT COUNT(*) FROM tenant_telemetry_application_write_bindings) AS binding_count,
           (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS job_count`,
      );
      expect(counts[0]).toMatchObject({
        receipt_count: 0,
        coverage_count: 0,
        binding_count: 0,
        job_count: 1,
      });
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("replays an active marker loss without opening a writer-guard window and rejects drift", async () => {
    const database = databaseName();
    const replayDir = await mkdtemp(join(tmpdir(), "agent-service-active-0035-replay-"));
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    let pendingUpgrade: Promise<void> | undefined;
    try {
      for (const [file] of FROZEN_0034_MIGRATIONS) {
        await copyFile(join(MIGRATIONS_DIR, file), join(replayDir, file));
      }
      const delayedMigrationSql = migrationSql.replace(
        "DROP TRIGGER IF EXISTS trg_sessions_subject_lifecycle_ai;",
        "DROP TRIGGER IF EXISTS trg_sessions_subject_lifecycle_ai;\nDO SLEEP(1);",
      );
      expect(delayedMigrationSql).not.toBe(migrationSql);
      await writeFile(join(replayDir, MIGRATION_NAME), delayedMigrationSql);

      await create0034(database);
      await seed0034(database, "tenant-active-marker-loss");
      await upgrade(database);
      store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0035Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await store.activateTenantTelemetryApplicationCapture(
        await captureActivation(store, "logs"),
      );
      await store.close();
      store = undefined;

      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      pendingUpgrade = upgrade(database, replayDir);

      const waitUntil = Date.now() + 5_000;
      let observedDelay = false;
      while (Date.now() < waitUntil) {
        const [processes] = await admin.query<Row[]>("SHOW FULL PROCESSLIST");
        if (processes.some((row) => String(row.Info ?? "").includes("DO SLEEP(1)"))) {
          observedDelay = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(observedDelay).toBe(true);
      await expect(conn.query(
        `INSERT INTO sessions
           (session_id,tenant_id,user_id,agent_id,agent_version,status,title,parent_session_id,
            last_seq,fence_token,context_epoch,usage_json,auto_approved_tools,metadata,
            created_at_ms,updated_at_ms,archived_at_ms)
         VALUES ('sess_active_marker_loss','raw-active-marker-loss','raw-user','agent-default',1,
                 JSON_OBJECT('type','idle'),NULL,NULL,0,0,'epoch',JSON_OBJECT(),JSON_ARRAY(),
                 JSON_OBJECT(),1,1,NULL)`,
      )).rejects.toThrow("session tenant lacks atomic application capture coverage");
      await pendingUpgrade;
      pendingUpgrade = undefined;
      await assertExactApplicationSchema(conn);
      const [postReplay] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM sessions
             WHERE session_id='sess_active_marker_loss') AS stale_session_count,
           (SELECT COUNT(*) FROM schema_migrations WHERE name=?) AS marker_count`,
        [MIGRATION_NAME],
      );
      expect(postReplay[0]).toMatchObject({ stale_session_count: 0, marker_count: 1 });

      // Once a domain is active, marker loss is only repairable when the complete latest
      // fingerprint is already exact.  A privileged trigger drift must fail before rotating any
      // still-valid guard.
      await conn.query("DROP TRIGGER trg_tt_app_coverage_bu");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      let driftFailure: unknown;
      try {
        await upgrade(database, replayDir);
      } catch (error) {
        driftFailure = error;
      }
      expect(driftFailure).toBeInstanceOf(Error);
      expect((driftFailure as Error).message).toMatch(/migration 0035.*failed at statement/i);
      expect(String((driftFailure as Error & { cause?: Error }).cause?.message)).toMatch(
        /active 0035 marker-loss replay requires the exact trigger\/schema fingerprint/i,
      );
      const [guardRows] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name='trg_sessions_subject_lifecycle_ai'`,
      );
      expect(Number(guardRows[0]?.count)).toBe(1);
      await expect(conn.query(
        `INSERT INTO sessions
           (session_id,tenant_id,user_id,agent_id,agent_version,status,title,parent_session_id,
            last_seq,fence_token,context_epoch,usage_json,auto_approved_tools,metadata,
            created_at_ms,updated_at_ms,archived_at_ms)
         VALUES ('sess_active_marker_drift','raw-active-marker-drift','raw-user','agent-default',1,
                 JSON_OBJECT('type','idle'),NULL,NULL,0,0,'epoch',JSON_OBJECT(),JSON_ARRAY(),
                 JSON_OBJECT(),1,1,NULL)`,
      )).rejects.toThrow("session tenant lacks atomic application capture coverage");
    } finally {
      await pendingUpgrade?.catch(() => {});
      await conn?.end();
      await store?.close().catch(() => {});
      await cleanup(database);
      await rm(replayDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["tenant_telemetry_application_domain_controls", 0],
    ["tenant_telemetry_application_activation_receipts", 1],
    ["tenant_telemetry_application_coverages", 2],
    ["tenant_telemetry_application_write_bindings", 3],
  ] as const)("converges from application-table CREATE auto-commit boundary at %s", async (_table, boundaryIndex) => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_application_")
        ? [index]
        : []
    ));
    expect(createIndexes).toHaveLength(4);
    const cutIndex = createIndexes[boundaryIndex]!;
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0034(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertExactApplicationSchema(conn);
      const [controls] = await conn.query<Row[]>(
        `SELECT domain,state,control_generation
           FROM tenant_telemetry_application_domain_controls ORDER BY domain`,
      );
      expect(controls).toEqual([
        { domain: "logs", state: "inactive", control_generation: 0 },
        { domain: "traces", state: "inactive", control_generation: 0 },
      ]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it.each(["trigger", "schema"] as const)("fails startup on marker-present %s drift", async (drift) => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0034(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      if (drift === "trigger") {
        await conn.query("DROP TRIGGER trg_tt_app_write_binding_bu");
      } else {
        await conn.query(
          "ALTER TABLE tenant_telemetry_application_coverages ADD COLUMN privileged_drift BIGINT NULL",
        );
      }
      await conn.end();
      conn = undefined;

      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0035Dir,
        tenantTelemetryRefKey: REF_KEY,
      })).rejects.toThrow(/0035|application capture|fingerprint/i);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });
});
