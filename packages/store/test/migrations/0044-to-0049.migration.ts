import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import {
  createStructuredTelemetry, telemetryCaptureLogsSourceRefSha256,
  type StructuredTelemetryRecord,
} from "@agent-service/protocol";
import {
  MysqlSessionStore, TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  type EnqueueTenantTelemetryArtifactInput,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REF_KEY = Buffer.alloc(32, 0x49);
const SOURCE_UUID = "0199f7a6-1234-7abc-8def-0123456789ab";
type Row = RowDataPacket;
const MIGRATION_NAME = "0049_tenant_telemetry_application_capture_v2.sql";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeInput(
  tenantId: string, artifactLabel = "artifact",
): EnqueueTenantTelemetryArtifactInput {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner", opaqueRefKey: REF_KEY, now: () => 1_000,
    sink: { write(value) { record = value; } },
  });
  telemetry.info("runner.runtime.info", {
    ownerRef: telemetry.opaqueRef("tenant", tenantId),
  });
  if (!record) throw new Error("trusted 0049 telemetry fixture did not emit");
  return {
    tenantId, expectedControlGeneration: 1, domain: "logs",
    artifactIdSha256: digest(`0049:${tenantId}:${artifactLabel}`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [record],
    },
  };
}

function safeBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("0049 fixture requires a local disposable MySQL test URL");
  }
  return url;
}

function databaseUrl(base: URL, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function assertDisposableDatabaseName(name: string): void {
  if (!/^agent_service_migration_test_0049_(?:partial_)?[0-9]+_[0-9a-f]{8}$/.test(name)) {
    throw new Error("0049 fixture database name is not a disposable random target");
  }
}

function migrationStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

async function recreateFixtureTrigger(
  conn: Connection, migration: string, trigger: string,
): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, migration), "utf8");
  const statement = migrationStatements(sql).find(
    (value) => value.startsWith(`CREATE TRIGGER ${trigger} `),
  );
  if (!statement) throw new Error(`fixture trigger ${trigger} is missing from ${migration}`);
  await conn.query(statement);
}

async function seedClaimedPlanJob(
  conn: Connection, requestId: string, tenantId: string,
): Promise<void> {
  // Synthetic content-free jobs only exercise the SQL transition guard. They
  // are rolled back and never represent upstream T1/T3 authorization.
  await conn.query(
    `INSERT INTO tenant_purge_plan_jobs (
       request_id,tenant_id,subject_generation,t1_fence_sha256,t3a_receipt_sha256,
       t3b_receipt_sha256,t3c_receipt_sha256,policy_version,policy_sha256,
       policy_schema_version,build_generation,retention_anchor_db_ms,purge_not_before_db_ms,
       source_evidence_db_ms,cursor_domain,scan_complete,plan_entry_count,
       plan_entry_root_sha256,blocker_count,blocker_root_sha256,phase,available_at_ms,
       attempts,claim_token,lease_until_ms,created_at_ms,updated_at_ms
     ) VALUES (?,?,1,?,?,?,?,'policy-v1',?,1,1,1,1,1,'traces',TRUE,33,?,2,?,
               'queued',10,1,'fixture-claim',100,1,10)`,
    [requestId, tenantId, digest(`${requestId}:t1`), digest(`${requestId}:t3a`),
      digest(`${requestId}:t3b`), digest(`${requestId}:t3c`),
      digest(`${requestId}:policy`), digest(`${requestId}:entry-root`),
      digest(`${requestId}:blocker-root`)],
  );
}

async function sealPlanJob(conn: Connection, requestId: string): Promise<void> {
  await conn.query(
    `UPDATE tenant_purge_plan_jobs
        SET phase='plan_sealed',available_at_ms=NULL,claim_token=NULL,lease_until_ms=NULL,
            updated_at_ms=20,sealed_at_ms=20,completed_claim_attempt=1,
            completed_claim_token_sha256=?,aggregate_receipt_sha256=?
      WHERE request_id=?`,
    [digest(`${requestId}:claim`), digest(`${requestId}:aggregate`), requestId],
  );
}

async function seedClaimedDatabasePurgeJob(
  conn: Connection, requestId: string, tenantId: string,
): Promise<void> {
  await conn.query(
    `INSERT INTO tenant_database_purge_jobs
       (request_id,tenant_id,subject_generation,plan_build_generation,
        execution_generation,database_purge_generation,t3c_receipt_sha256,
        plan_receipt_sha256,local_physical_ack_receipt_sha256,policy_sha256,
        purge_not_before_db_ms,source_evidence_db_ms,phase,domain_count,
        predelete_entry_count,predelete_entry_root_sha256,domain_ack_count,
        domain_ack_root_sha256,unresolved_blocker_count,available_at_ms,
        attempts,claim_token,lease_until_ms,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?, ?,1,1,'queued',11,0,?,0,?,0,10,1,'fixture-claim',100,1,10)`,
    [requestId, tenantId, 1, 1, 1, 1,
      digest(`${requestId}:t3c`), digest(`${requestId}:plan`),
      digest(`${requestId}:t3e`), digest(`${requestId}:policy`),
      "863bda0e079e55aa4c751d6a4c18860cac791985c34a27572c9294cf9f7a4396",
      "776cd8a7449522e7b71b04cc502881af1ebc11600627bc15606f90c29fdfe552"],
  );
}

async function sealDatabasePurgeJob(
  conn: Connection, requestId: string,
): Promise<void> {
  await conn.query(
    `UPDATE tenant_database_purge_jobs
        SET phase='database_purged',predelete_entry_count=11,
            predelete_entry_root_sha256=?,domain_ack_count=11,
            domain_ack_root_sha256=?,predelete_receipt_sha256=?,
            terminal_receipt_sha256=?,available_at_ms=NULL,claim_token=NULL,
            lease_until_ms=NULL,last_error_code=NULL,updated_at_ms=20,
            purged_at_db_ms=20,completed_claim_attempt=1,
            completed_claim_token_sha256=?
      WHERE request_id=?`,
    [digest(`${requestId}:entries`), digest(`${requestId}:acks`),
      digest(`${requestId}:predelete`), digest(`${requestId}:terminal`),
      digest(`${requestId}:claim`), requestId],
  );
}

describe("0044 -> 0049 dormant telemetry capture v2 historical migration", () => {
  it("applies additive dormant schema to real MySQL", async () => {
    const base = safeBase(BASE_URL);
    const name = `agent_service_migration_test_0049_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const partialName =
      `agent_service_migration_test_0049_partial_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    assertDisposableDatabaseName(name);
    assertDisposableDatabaseName(partialName);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    const admin = await mysql.createConnection(adminUrl.toString());
    let conn: Connection | undefined;
    let upgraded: MysqlSessionStore | undefined;
    let oldDir: string | undefined;
    let newDir: string | undefined;
    let created = false;
    let partialCreated = false;
    let bodyFailed = false;
    let bodyFailure: unknown;
    try {
      const [collision] = await admin.query<Row[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name],
      );
      expect(collision).toHaveLength(0);
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
      created = true;
      oldDir = await mkdtemp(join(tmpdir(), "agent-service-pre0049-"));
      newDir = await mkdtemp(join(tmpdir(), "agent-service-through0049-"));
      const names = (await readdir(MIGRATIONS_DIR))
        .filter((file) => /^00\d\d_.*\.sql$/.test(file) && Number(file.slice(0, 4)) <= 44)
        .sort();
      expect(names.at(-1)).toBe("0044_tenant_telemetry_pregrant_intent.sql");
      expect(names).toHaveLength(43);
      const frozen = createHash("sha256");
      for (const file of names) {
        const bytes = await readFile(join(MIGRATIONS_DIR, file));
        frozen.update(file).update("\0")
          .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
        await copyFile(join(MIGRATIONS_DIR, file), join(oldDir, file));
        await copyFile(join(MIGRATIONS_DIR, file), join(newDir, file));
      }
      expect(frozen.digest("hex"))
        .toBe("730f65a9cfb1e43809e28a45eb84a8ccac520243e51f877d58921668c0cd1ab5");
      await copyFile(
        join(MIGRATIONS_DIR, MIGRATION_NAME), join(newDir, MIGRATION_NAME),
      );
      const oldStore = await MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: oldDir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await oldStore.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0049:${domain}:namespace`),
          failureDomainSha256: digest(`0049:${domain}:failure-domain`),
        })),
      });
      await oldStore.createApiKey("tenant-pre0049", "key-pre0049",
        digest("0049-old-key"));
      await oldStore.enqueueTenantTelemetryArtifact(writeInput("tenant-pre0049"));
      await oldStore.close();
      conn = await mysql.createConnection(databaseUrl(base, name));
      const [oldRows] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id,key_hash FROM api_keys WHERE tenant_id='tenant-pre0049'",
      );
      expect(oldRows).toHaveLength(1);
      const [oldJobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs WHERE tenant_id='tenant-pre0049'",
      );
      const [oldMembership] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships WHERE tenant_id='tenant-pre0049'",
      );
      expect(oldJobs).toHaveLength(1);
      expect(oldMembership).toHaveLength(1);
      await conn.end();
      conn = undefined;
      upgraded = await MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await upgraded.createApiKey("tenant-pre0049-other", "key-pre0049-other",
        digest("0049-other-key"));
      conn = await mysql.createConnection(databaseUrl(base, name));
      const [oldRowsAfter] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id,key_hash FROM api_keys WHERE tenant_id='tenant-pre0049'",
      );
      expect(oldRowsAfter).toEqual(oldRows);
      const [oldJobsAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs WHERE tenant_id='tenant-pre0049'",
      );
      const [oldMembershipAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships WHERE tenant_id='tenant-pre0049'",
      );
      expect(oldJobsAfter).toEqual(oldJobs);
      expect(oldMembershipAfter).toEqual(oldMembership);
      const [controls] = await conn.query<Row[]>(
        "SELECT domain,state,control_generation FROM tenant_telemetry_capture_v2_controls ORDER BY domain",
      );
      expect(controls.map((row) => [row.domain,row.state,row.control_generation]))
        .toEqual([["logs","inactive",0],["traces","inactive",0]]);
      const [tables] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('tenant_telemetry_capture_v2_controls','tenant_telemetry_capture_v2_coverages','tenant_telemetry_capture_v2_source_bindings')",
      );
      expect(Number(tables[0]?.n)).toBe(3);
      const [sourceColumns] = await conn.query<Row[]>(
        `SELECT column_name AS source_name FROM information_schema.columns
           WHERE table_schema=DATABASE()
             AND table_name='tenant_telemetry_capture_v2_source_bindings'
             AND column_name IN
               ('source_session_id','source_turn_id','source_item_id',
                'source_session_ref_sha256','source_turn_ref_sha256',
                'source_item_ref_sha256') ORDER BY column_name`,
      );
      expect(sourceColumns.map((row) => row.source_name)).toEqual([
        "source_item_ref_sha256", "source_session_ref_sha256", "source_turn_ref_sha256",
      ]);
      const [markers] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(markers).toHaveLength(1);
      const oldSql = await readFile(
        join(oldDir, "0044_tenant_telemetry_pregrant_intent.sql"), "utf8",
      );
      const marker = "-- agent-service-runtime-fingerprint:tenant-telemetry-pregrant-intent-triggers:";
      const start = oldSql.indexOf(marker + "start");
      const end = oldSql.indexOf(marker + "end");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const oldFingerprint = oldSql.slice(start + (marker + "start").length, end)
        .replace(/^\s*--.*$/gm, "").trim().replace(/;$/, "");
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(oldFingerprint);
      const [oldFingerprintResult] = await conn.query<Row[]>(
        "SELECT @tt_pregrant_triggers_ok AS ok",
      );
      expect(Number(oldFingerprintResult[0]?.ok)).toBe(0);
      await expect(conn.query(
        "UPDATE tenant_telemetry_capture_v2_controls SET state='active' WHERE domain='logs'",
      )).rejects.toThrow("telemetry capture v2 activation is disabled");
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_capture_v2_coverages
           (tenant_id,domain,scope,control_generation,capture_status,
            pre_cutover_history_status,lifecycle_coverage_evidence_sha256,
            subject_ref_sha256,producer_contract_sha256,
            coverage_started_at_db_ms,evidence_sha256)
         VALUES (?,'logs','tenant-telemetry-capture-coverage-v2',1,
                 'capture_since_cutover','pre_cutover_history_unknown',
                 ?,?,?,1,?)`,
        ["tenant-pre0049",digest("coverage"),digest("subject"),
          digest("contract"),digest("v2-coverage")],
      )).rejects.toThrow("telemetry capture v2 coverage is disabled");
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_capture_v2_source_bindings
           (write_operation_sha256,scope,tenant_id,domain,control_generation,
            coverage_evidence_sha256,producer_contract_sha256,source_session_ref_sha256,
            source_turn_ref_sha256,source_item_ref_sha256,source_step_index,source_event_seq,
            owner_ref_sha256,payload_sha256,bound_at_db_ms,receipt_sha256)
         VALUES (?,'tenant-telemetry-capture-source-binding-v2',?,'logs',1,
                 ?,?,?,?,?,0,1,?,?,1,?)`,
        [digest("v2-operation"),"tenant-pre0049",digest("v2-coverage"),
          digest("contract"),
          telemetryCaptureLogsSourceRefSha256("session", "tenant-pre0049", `sess_${SOURCE_UUID}`, REF_KEY),
          telemetryCaptureLogsSourceRefSha256("turn", "tenant-pre0049", `turn_${SOURCE_UUID}`, REF_KEY),
          telemetryCaptureLogsSourceRefSha256("item", "tenant-pre0049", `item_${SOURCE_UUID}`, REF_KEY),
          digest("owner"),digest("payload"),digest("binding")],
      )).rejects.toThrow("telemetry capture v2 source binding is disabled");
      const [footprint] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_coverages) AS coverages,
                (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_source_bindings) AS bindings`,
      );
      expect(Number(footprint[0]?.coverages)).toBe(0);
      expect(Number(footprint[0]?.bindings)).toBe(0);

      // All tampering below is confined to this disposable historical database.
      // Temporarily remove only the listed fixture guards, then restore their
      // exact published definitions and prove verify-only startup accepts them.
      // The older terminal receipt guards must be absent to isolate the new
      // 0049 blocker; synthetic terminal rows are rolled back, not published.
      const dropped: Array<[string, string]> = [];
      const dropFixtureTrigger = async (trigger: string, migration: string) => {
        await conn!.query(`DROP TRIGGER \`${trigger}\``);
        dropped.push([trigger, migration]);
      };
      let relaxedControlCheck = false;
      try {
        for (const [trigger, migration] of [
          ["trg_tt_source_accounting_t3d_terminal_bu", "0040_tenant_telemetry_source_accounting.sql"],
          ["trg_tt_target_manifest_t3d_terminal_bu", "0041_tenant_telemetry_target_manifest.sql"],
          ["trg_tt_plan_artifact_target_t3d_terminal_bu", "0042_tenant_telemetry_plan_artifact_target.sql"],
          ["trg_tt_owner_closure_t3f_terminal_bu", "0039_tenant_telemetry_owner_closure.sql"],
          ["trg_tt_capture_v2_coverage_bi", MIGRATION_NAME],
          ["trg_tt_capture_v2_coverage_bd", MIGRATION_NAME],
          ["trg_tt_capture_v2_binding_bi", MIGRATION_NAME],
          ["trg_tt_capture_v2_binding_bd", MIGRATION_NAME],
          ["trg_tt_capture_v2_control_bu", MIGRATION_NAME],
        ] as const) await dropFixtureTrigger(trigger, migration);
        const [lifecycleCoverage] = await conn.query<Row[]>(
          `SELECT evidence_sha256,subject_ref_sha256,history_status,coverage_started_at_db_ms
             FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id=?`,
          ["tenant-pre0049"],
        );
        expect(lifecycleCoverage).toHaveLength(1);
        expect(lifecycleCoverage[0]?.history_status).toBe("complete_since_creation");
        const captureCoverageSha = digest("0049:injected:v2-coverage");
        const producerContractSha = digest(
          "provider.upstream_request_failed:durable-failed-step:v2",
        );
        await conn.query(
          `INSERT INTO tenant_telemetry_capture_v2_coverages
             (tenant_id,domain,scope,control_generation,capture_status,
              pre_cutover_history_status,lifecycle_coverage_evidence_sha256,
              subject_ref_sha256,producer_contract_sha256,
              coverage_started_at_db_ms,evidence_sha256)
           VALUES (?,'logs','tenant-telemetry-capture-coverage-v2',1,
                   'capture_since_tenant_creation','pre_cutover_not_applicable',?,?,?,?,?)`,
          ["tenant-pre0049", lifecycleCoverage[0]!.evidence_sha256,
            lifecycleCoverage[0]!.subject_ref_sha256, producerContractSha,
            lifecycleCoverage[0]!.coverage_started_at_db_ms, captureCoverageSha],
        );
        // Coverage is itself an unaccounted v2 footprint. Even without any
        // source binding, it must stop T3d/T3f and the old v1 job writer.
        const [coverageOnlyWriteBefore] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        await expect(upgraded.enqueueTenantTelemetryArtifact(
          writeInput("tenant-pre0049", "coverage-only-probe"),
        )).rejects.toThrow("capture v2 job path is disabled");
        const [coverageOnlyWriteAfter] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        expect(coverageOnlyWriteAfter).toEqual(coverageOnlyWriteBefore);
        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        await conn.beginTransaction();
        try {
          await seedClaimedPlanJob(conn, "request-0049-coverage-plan", "tenant-pre0049");
          await seedClaimedDatabasePurgeJob(conn, "request-0049-coverage-t3f", "tenant-pre0049");
          await expect(sealPlanJob(conn, "request-0049-coverage-plan"))
            .rejects.toThrow("T3d cannot account for capture v2 source");
          await expect(sealDatabasePurgeJob(conn, "request-0049-coverage-t3f"))
            .rejects.toThrow("T3f cannot close capture v2 owner source");
        } finally {
          try {
            await conn.rollback();
          } finally {
            await conn.query("SET FOREIGN_KEY_CHECKS=1");
          }
        }
        await conn.query(
          `INSERT INTO tenant_telemetry_capture_v2_source_bindings
             (write_operation_sha256,scope,tenant_id,domain,control_generation,
              coverage_evidence_sha256,producer_contract_sha256,source_session_ref_sha256,
              source_turn_ref_sha256,source_item_ref_sha256,source_step_index,source_event_seq,
              owner_ref_sha256,payload_sha256,bound_at_db_ms,receipt_sha256)
           VALUES (?,'tenant-telemetry-capture-source-binding-v2',?,'logs',1,
                   ?,?,?,?,?,0,1,?,?,1,?)`,
          [oldJobs[0]!.write_operation_sha256, "tenant-pre0049",
            captureCoverageSha, producerContractSha,
            telemetryCaptureLogsSourceRefSha256("session", "tenant-pre0049", `sess_${SOURCE_UUID}`, REF_KEY),
            telemetryCaptureLogsSourceRefSha256("turn", "tenant-pre0049", `turn_${SOURCE_UUID}`, REF_KEY),
            telemetryCaptureLogsSourceRefSha256("item", "tenant-pre0049", `item_${SOURCE_UUID}`, REF_KEY),
            oldMembership[0]!.owner_ref_sha256, oldJobs[0]!.payload_sha256,
            digest("0049:injected:v2-binding")],
        );

        // Simulate a privileged, orphaned binding on the disposable database.
        // Each live guard must reject that source even without its FK coverage
        // row; another tenant's normal v1 write remains unaffected.
        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        try {
          await conn.query(
            "DELETE FROM tenant_telemetry_capture_v2_coverages WHERE tenant_id=? AND domain='logs'",
            ["tenant-pre0049"],
          );
        } finally {
          await conn.query("SET FOREIGN_KEY_CHECKS=1");
        }
        const [bindingOnlyFootprint] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_coverages
                    WHERE tenant_id='tenant-pre0049') AS coverages,
                  (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_source_bindings
                    WHERE tenant_id='tenant-pre0049') AS bindings`,
        );
        expect(Number(bindingOnlyFootprint[0]?.coverages)).toBe(0);
        expect(Number(bindingOnlyFootprint[0]?.bindings)).toBe(1);
        const [bindingOnlyWriteBefore] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        await expect(upgraded.enqueueTenantTelemetryArtifact(
          writeInput("tenant-pre0049", "binding-only-probe"),
        )).rejects.toThrow("capture v2 job path is disabled");
        const [bindingOnlyWriteAfter] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        expect(bindingOnlyWriteAfter).toEqual(bindingOnlyWriteBefore);
        await upgraded.enqueueTenantTelemetryArtifact(
          writeInput("tenant-pre0049-other", "binding-only-other"),
        );
        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        await conn.beginTransaction();
        try {
          await seedClaimedPlanJob(conn, "request-0049-binding-only-plan", "tenant-pre0049");
          await seedClaimedDatabasePurgeJob(conn, "request-0049-binding-only-t3f", "tenant-pre0049");
          await expect(sealPlanJob(conn, "request-0049-binding-only-plan"))
            .rejects.toThrow("T3d cannot account for capture v2 source");
          await expect(sealDatabasePurgeJob(conn, "request-0049-binding-only-t3f"))
            .rejects.toThrow("T3f cannot close capture v2 owner source");
        } finally {
          try {
            await conn.rollback();
          } finally {
            await conn.query("SET FOREIGN_KEY_CHECKS=1");
          }
        }
        await conn.query(
          `INSERT INTO tenant_telemetry_capture_v2_coverages
             (tenant_id,domain,scope,control_generation,capture_status,
              pre_cutover_history_status,lifecycle_coverage_evidence_sha256,
              subject_ref_sha256,producer_contract_sha256,
              coverage_started_at_db_ms,evidence_sha256)
           VALUES (?,'logs','tenant-telemetry-capture-coverage-v2',1,
                   'capture_since_tenant_creation','pre_cutover_not_applicable',?,?,?,?,?)`,
          ["tenant-pre0049", lifecycleCoverage[0]!.evidence_sha256,
            lifecycleCoverage[0]!.subject_ref_sha256, producerContractSha,
            lifecycleCoverage[0]!.coverage_started_at_db_ms, captureCoverageSha],
        );

        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        await conn.beginTransaction();
        try {
          for (const tenant of ["tenant-pre0049", "tenant-pre0049-other"]) {
            await seedClaimedPlanJob(conn, `request-0049-plan-${tenant}`, tenant);
            await seedClaimedDatabasePurgeJob(conn, `request-0049-t3f-${tenant}`, tenant);
          }
          await expect(sealPlanJob(conn, "request-0049-plan-tenant-pre0049"))
            .rejects.toThrow("T3d cannot account for capture v2 source");
          await sealPlanJob(conn, "request-0049-plan-tenant-pre0049-other");
          await expect(sealDatabasePurgeJob(conn, "request-0049-t3f-tenant-pre0049"))
            .rejects.toThrow("T3f cannot close capture v2 owner source");
          await sealDatabasePurgeJob(conn, "request-0049-t3f-tenant-pre0049-other");
          const [phases] = await conn.query<Row[]>(
            `SELECT tenant_id,phase FROM tenant_purge_plan_jobs
               WHERE request_id LIKE 'request-0049-plan-%' ORDER BY tenant_id`,
          );
          expect(phases.map((row) => [row.tenant_id, row.phase]))
            .toEqual([["tenant-pre0049", "queued"],
              ["tenant-pre0049-other", "plan_sealed"]]);
          const [dbPhases] = await conn.query<Row[]>(
            `SELECT tenant_id,phase FROM tenant_database_purge_jobs
               WHERE request_id LIKE 'request-0049-t3f-%' ORDER BY tenant_id`,
          );
          expect(dbPhases.map((row) => [row.tenant_id, row.phase]))
            .toEqual([["tenant-pre0049", "queued"],
              ["tenant-pre0049-other", "database_purged"]]);
        } finally {
          try {
            await conn.rollback();
          } finally {
            await conn.query("SET FOREIGN_KEY_CHECKS=1");
          }
        }
        const [rolledBack] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_purge_plan_jobs
                    WHERE request_id LIKE 'request-0049-plan-%') AS plans,
                  (SELECT COUNT(*) FROM tenant_database_purge_jobs
                    WHERE request_id LIKE 'request-0049-t3f-%') AS purges`,
        );
        expect(Number(rolledBack[0]?.plans)).toBe(0);
        expect(Number(rolledBack[0]?.purges)).toBe(0);

        // A binding for one tenant does not suppress another tenant's normal
        // managed write. An active v2 control, however, must stop every v1 job.
        await upgraded.enqueueTenantTelemetryArtifact(writeInput("tenant-pre0049-other"));
        await conn.query(
          `ALTER TABLE tenant_telemetry_capture_v2_controls
             ALTER CHECK chk_tt_capture_v2_control_shape NOT ENFORCED`,
        );
        relaxedControlCheck = true;
        await conn.query(
          `UPDATE tenant_telemetry_capture_v2_controls
              SET state='active',control_generation=1,activated_at_db_ms=1
            WHERE domain='logs'`,
        );
        const [writeCountsBefore] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        await expect(upgraded.enqueueTenantTelemetryArtifact(
          writeInput("tenant-pre0049", "active-control-probe"),
        )).rejects.toThrow("capture v2 job path is disabled");
        const [writeCountsAfter] = await conn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs
                    WHERE tenant_id='tenant-pre0049') AS jobs,
                  (SELECT COUNT(*) FROM tenant_telemetry_artifact_memberships
                    WHERE tenant_id='tenant-pre0049') AS memberships,
                  (SELECT COUNT(*) FROM tenant_telemetry_write_payloads
                    WHERE tenant_id='tenant-pre0049') AS payloads`,
        );
        expect(writeCountsAfter).toEqual(writeCountsBefore);
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
        if (relaxedControlCheck) {
          await conn.query(
            `UPDATE tenant_telemetry_capture_v2_controls
                SET state='inactive',control_generation=0,activated_at_db_ms=NULL
              WHERE domain='logs'`,
          );
          await conn.query(
            `ALTER TABLE tenant_telemetry_capture_v2_controls
               ALTER CHECK chk_tt_capture_v2_control_shape ENFORCED`,
          );
        }
        await conn.query("DELETE FROM tenant_telemetry_capture_v2_source_bindings");
        await conn.query("DELETE FROM tenant_telemetry_capture_v2_coverages");
        for (const [trigger, migration] of dropped.reverse()) {
          await recreateFixtureTrigger(conn, migration, trigger);
        }
      }
      const restored = await MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY, migrationMode: "verify",
      });
      await restored.close();

      await conn.query("DROP TRIGGER trg_tt_capture_v2_binding_bi");
      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY, migrationMode: "verify",
      })).rejects.toThrow("0049 capture v2 fingerprint verification failed");
      const migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
      const triggerStatement = migrationStatements(migrationSql).find(
        (statement) => statement.startsWith(
          "CREATE TRIGGER trg_tt_capture_v2_binding_bi ",
        ),
      );
      if (!triggerStatement) throw new Error("0049 binding guard is missing from migration");
      await conn.query(triggerStatement);
      const repaired = await MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY, migrationMode: "verify",
      });
      await repaired.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY, migrationMode: "verify",
      })).rejects.toThrow("0049");

      const [partialCollision] = await admin.query<Row[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
        [partialName],
      );
      expect(partialCollision).toHaveLength(0);
      await admin.query(`CREATE DATABASE \`${partialName}\` CHARACTER SET utf8mb4`);
      partialCreated = true;
      const partialOld = await MysqlSessionStore.connect({
        url: databaseUrl(base, partialName), migrationsDir: oldDir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await partialOld.close();
      const partialConn = await mysql.createConnection(databaseUrl(base, partialName));
      try {
        const firstDdl = migrationStatements(migrationSql).find(
          (statement) => statement.startsWith(
            "CREATE TABLE IF NOT EXISTS tenant_telemetry_capture_v2_controls ",
          ),
        );
        if (!firstDdl) throw new Error("0049 first DDL is missing");
        await partialConn.query(firstDdl);
      } finally {
        await partialConn.end();
      }
      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, partialName), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY,
      })).rejects.toThrow("0049 marker-loss or partial DDL");
    } catch (error) {
      bodyFailed = true;
      bodyFailure = error;
    } finally {
      const cleanupFailures: Error[] = [];
      const attemptCleanup = async (label: string, operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (cause) {
          cleanupFailures.push(new Error(`0049 fixture ${label} failed`, { cause }));
        }
      };
      if (upgraded) {
        const store = upgraded;
        await attemptCleanup("store close", () => store.close());
      }
      if (conn) {
        const connection = conn;
        await attemptCleanup("connection close", () => connection.end());
      }
      if (oldDir) {
        const directory = oldDir;
        await attemptCleanup("old migration directory cleanup",
          () => rm(directory, { recursive: true, force: true }));
      }
      if (newDir) {
        const directory = newDir;
        await attemptCleanup("new migration directory cleanup",
          () => rm(directory, { recursive: true, force: true }));
      }
      // These two names were generated and strictly validated above, and only
      // databases successfully created by this fixture may be dropped. Each
      // DROP is independent of every earlier cleanup failure.
      if (created) await attemptCleanup("historical database drop",
        () => admin.query(`DROP DATABASE \`${name}\``));
      if (partialCreated) await attemptCleanup("partial-DDL database drop",
        () => admin.query(`DROP DATABASE \`${partialName}\``));
      await attemptCleanup("admin connection close", () => admin.end());
      if (bodyFailed && cleanupFailures.length > 0) {
        throw new AggregateError([bodyFailure, ...cleanupFailures],
          "0049 fixture and cleanup both failed");
      }
      if (bodyFailed) throw bodyFailure;
      if (cleanupFailures.length > 0) {
        throw new AggregateError(cleanupFailures, "0049 fixture cleanup failed");
      }
    }
  }, 90_000);
});
