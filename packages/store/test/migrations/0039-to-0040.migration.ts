import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStructuredTelemetry, type StructuredTelemetryRecord } from "@agent-service/protocol";
import {
  MysqlSessionStore,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  type EnqueueTenantTelemetryArtifactInput,
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0040_tenant_telemetry_source_accounting.sql";
// Frozen published 0001..0039 chain: a predecessor edit is not an upgrade fixture.
const FROZEN_0039_CHAIN_SHA256 =
  "80574896e0acbde0f966ab9cc5a5aa5eac5225b5e2e80b5ee52ed3b9e6647346";
const REF_KEY = Buffer.alloc(32, 0x40);
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
  return `agent_service_migration_test_0040_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

function trustedRecord(tenantId: string): Readonly<StructuredTelemetryRecord> {
  let result: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner", opaqueRefKey: REF_KEY, now: () => 1_000,
    sink: { write(value) { result = value; } },
  });
  telemetry.info("runner.runtime.info", { ownerRef: telemetry.opaqueRef("tenant", tenantId) });
  if (!result) throw new Error("trusted telemetry fixture did not emit a record");
  return result;
}

function writeInput(tenantId: string): EnqueueTenantTelemetryArtifactInput {
  return {
    tenantId, expectedControlGeneration: 1, domain: "logs",
    artifactIdSha256: digest(`0040:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRecord(tenantId)],
    },
  };
}

describe("0039 -> 0040 immutable telemetry T3d source-accounting historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0040Dir: string;
  let through0040Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0040Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0040-"));
    through0040Dir = await mkdtemp(join(tmpdir(), "agent-service-through0040-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 39)
      .sort();
    expect(names).toHaveLength(39);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0039_tenant_telemetry_owner_closure.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0040Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0040Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0039_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0040Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0040Dir) await rm(pre0040Dir, { recursive: true, force: true });
    if (through0040Dir) await rm(through0040Dir, { recursive: true, force: true });
  });

  async function create0039(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: pre0040Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: through0040Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function triggerNames(conn: Connection): Promise<string[]> {
    const [rows] = await conn.query<Row[]>(
      "SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name",
    );
    return rows.map((row) => String(row.name));
  }

  async function frozen0039StartupTriggerFingerprint(conn: Connection): Promise<boolean> {
    const sql = await readFile(join(pre0040Dir, "0039_tenant_telemetry_owner_closure.sql"), "utf8");
    const prefix = "agent-service-runtime-fingerprint:tenant-telemetry-owner-closure-triggers";
    const start = sql.indexOf(`-- ${prefix}:start`);
    const end = sql.indexOf(`-- ${prefix}:end`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const [statement] = statements(sql.slice(start + `-- ${prefix}:start`.length, end));
    expect(statement).toMatch(/^SET @tt_owner_closure_triggers_ok=/);
    await conn.query("SET @fixture_previous_group_concat_max_len=@@SESSION.group_concat_max_len");
    try {
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(statement!);
      const [rows] = await conn.query<Row[]>(
        "SELECT @tt_owner_closure_triggers_ok AS fingerprint_ok",
      );
      return Number(rows[0]?.fingerprint_ok) === 1;
    } finally {
      await conn.query("SET SESSION group_concat_max_len=@fixture_previous_group_concat_max_len");
    }
  }

  async function seedClaimedPlanJob(conn: Connection, requestId: string, tenantId: string): Promise<void> {
    // The row is deliberately content-free and isolated in a disposable database.
    // It exercises the SQL transition guard, not upstream T1/T3a/T3b/T3c authorization.
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

  async function terminalTransition(conn: Connection, requestId: string): Promise<void> {
    await conn.query(
      `UPDATE tenant_purge_plan_jobs
          SET phase='plan_sealed',available_at_ms=NULL,claim_token=NULL,lease_until_ms=NULL,
              updated_at_ms=20,sealed_at_ms=20,completed_claim_attempt=1,
              completed_claim_token_sha256=?,aggregate_receipt_sha256=?
        WHERE request_id=?`,
      [digest(`${requestId}:claim`), digest(`${requestId}:aggregate`), requestId],
    );
  }

  it("preserves a frozen-0039 managed write and leaves 0040 evidence empty", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      const tenantId = "tenant-pre0040";
      const writer = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0040Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await writer.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0040:${domain}:namespace`),
          failureDomainSha256: digest(`0040:${domain}:failure-domain`),
        })),
      });
      await writer.createApiKey(tenantId, "key-pre0040", digest("0040:api-key"));
      const historicalJob = await writer.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      await writer.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [membershipsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256",
      );
      const [closureBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_owner_closure_receipts ORDER BY request_id",
      );
      const [lifecycleBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      const [dispositionBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1",
      );
      const guardsBefore = await triggerNames(conn);
      expect(await frozen0039StartupTriggerFingerprint(conn)).toBe(true);
      expect(jobsBefore).toHaveLength(1);
      expect(jobsBefore[0]?.write_operation_sha256).toBe(historicalJob.writeOperationSha256);
      expect(membershipsBefore).toHaveLength(1);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [membershipsAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256",
      );
      const [closureAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_owner_closure_receipts ORDER BY request_id",
      );
      const [lifecycleAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      const [dispositionAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1",
      );
      expect(jobsAfter).toEqual(jobsBefore);
      expect(membershipsAfter).toEqual(membershipsBefore);
      expect(closureAfter).toEqual(closureBefore);
      expect(lifecycleAfter).toEqual(lifecycleBefore);
      expect(dispositionAfter).toEqual(dispositionBefore);
      expect(dispositionAfter[0]?.state).toBe("inactive");
      const [newEvidence] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_receipts) AS receipts,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS external_events,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks) AS tombstones`,
      );
      expect(newEvidence[0]).toMatchObject({
        entries: 0, receipts: 0, grants: 0, external_events: 0, tombstones: 0,
      });
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      const guardsAfter = await triggerNames(conn);
      expect(guardsAfter).toHaveLength(guardsBefore.length + 8);
      expect(guardsAfter.filter((name) => name.startsWith("trg_tt_source_accounting_")))
        .toHaveLength(8);
      // This is the exact published 0039 startup fingerprint, not an emulated
      // pre-0040 process. Its rejection proves the additive old-writer tripwire.
      expect(await frozen0039StartupTriggerFingerprint(conn)).toBe(false);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes partial DDL and marker-loss replay without duplicate guards", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const before = await triggerNames(conn);
      const firstTable = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_source_accounting_entries"));
      expect(firstTable).toBeDefined();
      await conn.query(firstTable!);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const complete = await triggerNames(conn);
      expect(complete.length).toBeGreaterThan(before.length);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await triggerNames(conn)).toEqual(complete);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a malformed pre-existing source-accounting table", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(`CREATE TABLE tenant_telemetry_source_accounting_entries (
        request_id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB`);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects marker-loss replay after a privileged trigger-body replacement", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [guards] = await conn.query<Row[]>(
        `SELECT trigger_name AS name,event_object_table AS table_name,
                action_timing AS timing,event_manipulation AS event_name
           FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND LEFT(trigger_name,LENGTH('trg_tt_source_accounting_'))
                ='trg_tt_source_accounting_'
          ORDER BY trigger_name LIMIT 1`,
      );
      expect(guards).toHaveLength(1);
      const guard = guards[0]!;
      const name = String(guard.name);
      const table = String(guard.table_name);
      const timing = String(guard.timing);
      const event = String(guard.event_name);
      expect(name).toMatch(/^trg_tt_source_accounting_[a-z0-9_]+$/);
      expect(table).toMatch(/^[a-z0-9_]+$/);
      expect(timing).toMatch(/^(BEFORE|AFTER)$/);
      expect(event).toMatch(/^(INSERT|UPDATE|DELETE)$/);
      await conn.query(`DROP TRIGGER \`${name}\``);
      await conn.query(`CREATE TRIGGER \`${name}\` ${timing} ${event}
        ON \`${table}\` FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered fixture trigger'`);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects marked-schema startup after an extra source-accounting column", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        "ALTER TABLE tenant_telemetry_source_accounting_entries ADD COLUMN leaked_locator VARCHAR(255) NULL",
      );
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow();
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("keeps a pre-0040 SQL terminal as unknown instead of backfilling source accounting", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedClaimedPlanJob(conn, "request-pre0040-terminal", "tenant-pre0040-terminal");
      await terminalTransition(conn, "request-pre0040-terminal");
      const [before] = await conn.query<Row[]>(
        "SELECT * FROM tenant_purge_plan_jobs WHERE request_id='request-pre0040-terminal'",
      );
      expect(before[0]?.phase).toBe("plan_sealed");
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [after] = await conn.query<Row[]>(
        "SELECT * FROM tenant_purge_plan_jobs WHERE request_id='request-pre0040-terminal'",
      );
      expect(after).toEqual(before);
      const [newEvidence] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries
                  WHERE request_id='request-pre0040-terminal') AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_receipts
                  WHERE request_id='request-pre0040-terminal') AS receipts`,
      );
      expect(newEvidence[0]).toMatchObject({ entries: 0, receipts: 0 });
      // This is an SQL-shape historical fixture, not a full pre-0040 worker binary run.
      // Its synthetic job has no valid plan receipt, so it must not be presented as a
      // product read-API test. It proves only that migration preserves the terminal
      // marker and leaves missing 0040 evidence unknown rather than backfilling zero.
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a wrong-tenant source projection on startup and marker-loss replay", async () => {
    const database = databaseName();
    const requestId = "request-0040-wrong-tenant";
    const tenantId = "tenant-canonical-0040";
    const wrongTenantId = "tenant-foreign-0040";
    let conn: Connection | undefined;
    try {
      await create0039(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedClaimedPlanJob(conn, requestId, tenantId);
      await terminalTransition(conn, requestId);
      await conn.end();
      conn = undefined;
      await upgrade(database);

      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_purge_plan_jobs WHERE request_id=?", [requestId],
      );
      expect(jobs).toHaveLength(1);
      const job = jobs[0]!;
      expect(job.tenant_id).toBe(tenantId);
      expect(job.phase).toBe("plan_sealed");
      const entryTrigger = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TRIGGER trg_tt_source_accounting_entry_bi "));
      const receiptTrigger = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TRIGGER trg_tt_source_accounting_receipt_bi "));
      expect(entryTrigger).toBeDefined();
      expect(receiptTrigger).toBeDefined();

      // Privileged, isolated corruption fixture: normal DML cannot create this footprint.
      // Restore the exact published trigger bodies before either startup/replay assertion,
      // so rejection is attributable to owner projection rather than missing guards.
      await conn.query("DROP TRIGGER trg_tt_source_accounting_entry_bi");
      await conn.query("DROP TRIGGER trg_tt_source_accounting_receipt_bi");
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      try {
        await conn.query(
          `INSERT INTO tenant_telemetry_source_accounting_entries
             (scope,request_id,tenant_id,subject_generation,build_generation,source_kind,
              source_identity_sha256,write_operation_sha256,domain,source_evidence_sha256,
              classification,reason,captured_at_db_ms,receipt_sha256)
           VALUES ('tenant-telemetry-source-accounting-entry-v1',?,?,1,1,'inventory',
                   ?,NULL,'logs',?,'unknown','orphan_source',20,?)`,
          [requestId, wrongTenantId, digest("0040:wrong-tenant:inventory"),
            digest("0040:wrong-tenant:source"), digest("0040:wrong-tenant:entry")],
        );
        await conn.query(
          `INSERT INTO tenant_telemetry_source_accounting_receipts
             (scope,request_id,tenant_id,subject_generation,build_generation,
              t1_fence_sha256,t3c_receipt_sha256,plan_receipt_sha256,
              inventory_count,write_job_count,write_ack_count,membership_count,
              application_binding_count,entry_count,entry_root_sha256,unknown_count,
              unknown_root_sha256,store_db_timestamp_ms,completed_claim_attempt,
              completed_claim_token_sha256,receipt_sha256)
           VALUES ('tenant-telemetry-source-accounting-receipt-v1',?,?,1,1,
                   ?,?,?,1,0,0,0,0,1,?,1,?,20,1,?,?)`,
          [requestId, wrongTenantId, job.t1_fence_sha256, job.t3c_receipt_sha256,
            job.aggregate_receipt_sha256, digest("0040:wrong-tenant:entry-root"),
            digest("0040:wrong-tenant:unknown-root"), job.completed_claim_token_sha256,
            digest("0040:wrong-tenant:receipt")],
        );
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
        await conn.query(entryTrigger!);
        await conn.query(receiptTrigger!);
      }

      // The pre-fix request-only joins would have accepted the paired foreign-tenant
      // rows because request ID and aggregate hash still match the canonical job.
      const [unsafe] = await conn.query<Row[]>(
        `SELECT
           NOT EXISTS (
             SELECT 1 FROM tenant_telemetry_source_accounting_entries e
             LEFT JOIN tenant_telemetry_source_accounting_receipts r
               ON BINARY r.request_id=BINARY e.request_id
             LEFT JOIN tenant_purge_plan_jobs j
               ON BINARY j.request_id=BINARY e.request_id
             WHERE r.request_id IS NULL OR j.request_id IS NULL OR j.phase<>'plan_sealed'
               OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256
           ) AND NOT EXISTS (
             SELECT 1 FROM tenant_telemetry_source_accounting_receipts r
             LEFT JOIN tenant_purge_plan_jobs j
               ON BINARY j.request_id=BINARY r.request_id
             WHERE j.request_id IS NULL OR j.phase<>'plan_sealed'
               OR BINARY j.aggregate_receipt_sha256<>BINARY r.plan_receipt_sha256
           ) AS unsafe_old_join_passes`,
      );
      expect(Number(unsafe[0]?.unsafe_old_join_passes)).toBe(1);
      const projectionCheck = statements(migrationSql).find((statement) =>
        statement.startsWith("SET @tt_source_accounting_projection_ok="));
      expect(projectionCheck).toBeDefined();
      await conn.query(projectionCheck!);
      const [projection] = await conn.query<Row[]>(
        "SELECT @tt_source_accounting_projection_ok AS projection_ok",
      );
      expect(Number(projection[0]?.projection_ok)).toBe(0);
      await conn.end();
      conn = undefined;

      await expect(upgrade(database)).rejects.toThrow(/integrity/);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      let failure: unknown;
      try {
        await upgrade(database);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`migration ${MIGRATION_NAME} failed`);
      expect(String((failure as Error & { cause?: Error }).cause?.message))
        .toContain("__invalid_tenant_telemetry_source_accounting_projection__");
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("blocks a new T3d terminal transition without its same-transaction source receipt", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0039(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.beginTransaction();
      try {
        await seedClaimedPlanJob(conn, "request-0040-guard", "tenant-0040-guard");
        await expect(terminalTransition(conn, "request-0040-guard")).rejects.toThrow(
          /terminal T3d lacks immutable telemetry source accounting/,
        );
      } finally {
        await conn.rollback();
      }
      const [jobs] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM tenant_purge_plan_jobs WHERE request_id='request-0040-guard'",
      );
      expect(Number(jobs[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);
});
