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
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0036_tenant_telemetry_disposition.sql";
// A stable digest over each predecessor's filename and bytes prevents this from silently becoming
// a fresh-schema test when any shipped 0001..0035 migration is rewritten.
const FROZEN_0035_CHAIN_SHA256 =
  "fb73a958948d6316317409d8c2803b54bda7e33a13c7cb668f1fe828f7dcbe87";
const REF_KEY = Buffer.alloc(32, 0x36);
const DISPOSITION_TABLES = [
  "tenant_telemetry_disposition_activation_receipts",
  "tenant_telemetry_disposition_authorization_grants",
  "tenant_telemetry_disposition_control",
  "tenant_telemetry_disposition_external_authorizations",
  "tenant_telemetry_disposition_external_events",
  "tenant_telemetry_disposition_jobs",
  "tenant_telemetry_disposition_receipts",
  "tenant_telemetry_disposition_replay_fences",
  "tenant_telemetry_disposition_tombstone_acks",
] as const;
const DISPOSITION_TRIGGERS = [
  "trg_tt_disposition_activation_bd",
  "trg_tt_disposition_activation_bi",
  "trg_tt_disposition_activation_bu",
  "trg_tt_disposition_authorization_bd",
  "trg_tt_disposition_authorization_bi",
  "trg_tt_disposition_authorization_bu",
  "trg_tt_disposition_control_bd",
  "trg_tt_disposition_control_bi",
  "trg_tt_disposition_control_bu",
  "trg_tt_disposition_event_bd",
  "trg_tt_disposition_event_bi",
  "trg_tt_disposition_event_bu",
  "trg_tt_disposition_grant_bd",
  "trg_tt_disposition_grant_bi",
  "trg_tt_disposition_grant_bu",
  "trg_tt_disposition_job_bd",
  "trg_tt_disposition_job_bi",
  "trg_tt_disposition_job_bu",
  "trg_tt_disposition_legacy_inventory_bi",
  "trg_tt_disposition_legacy_write_bi",
  "trg_tt_disposition_receipt_bd",
  "trg_tt_disposition_receipt_bi",
  "trg_tt_disposition_receipt_bu",
  "trg_tt_disposition_replay_bd",
  "trg_tt_disposition_replay_bi",
  "trg_tt_disposition_replay_bu",
  "trg_tt_disposition_tombstone_bd",
  "trg_tt_disposition_tombstone_bi",
  "trg_tt_disposition_tombstone_bu",
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

function trustedRecord(timestampMs: number, tenantId: string): Readonly<StructuredTelemetryRecord> {
  let record: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner",
    opaqueRefKey: REF_KEY,
    now: () => timestampMs,
    sink: { write(value) { record = value; } },
  });
  telemetry.info("runner.runtime.info", { ownerRef: telemetry.opaqueRef("tenant", tenantId) });
  if (!record) throw new Error("trusted telemetry fixture did not emit a record");
  return record;
}

async function insertSyntheticDispositionJob(
  conn: Connection,
  input: {
    label: string;
    tenantId: string;
    phase: "blocked" | "authorized";
    omitJsonTenantId?: boolean;
    omitAuthorizationReceipt?: boolean;
  },
): Promise<string> {
  const operation = digest(`0036:synthetic:${input.label}:operation`);
  const requestId = `request-${input.label}`;
  const target = digest(`0036:synthetic:${input.label}:target`);
  const artifact = digest(`0036:synthetic:${input.label}:artifact`);
  const jobJson: Record<string, string | number> = {
    dispositionOperationSha256: operation,
    tenantId: input.tenantId,
    requestId,
    domain: "logs",
    targetSha256: target,
    artifactIdSha256: artifact,
    artifactGeneration: 1,
    phase: input.phase,
  };
  if (input.omitJsonTenantId) delete jobJson.tenantId;
  const row: Record<string, string | number | null> = {
    disposition_operation_sha256: operation,
    tenant_id: input.tenantId,
    request_id: requestId,
    scope: "tenant-telemetry-disposition-job-v1",
    protocol: "tenant-telemetry-disposition-v1",
    domain: "logs",
    target_sha256: target,
    artifact_id_sha256: artifact,
    artifact_generation: 1,
    inventory_sha256: digest(`0036:synthetic:${input.label}:inventory`),
    write_operation_sha256: digest(`0036:synthetic:${input.label}:write`),
    t3c_receipt_sha256: digest(`0036:synthetic:${input.label}:t3c`),
    t3d_plan_receipt_sha256: digest(`0036:synthetic:${input.label}:t3d`),
    t3d_plan_entry_receipt_sha256: digest(`0036:synthetic:${input.label}:entry`),
    phase: input.phase,
    attempts: 0,
    available_at_db_ms: input.phase === "authorized" ? 1_000 : null,
    authorization_receipt_sha256:
      input.phase === "authorized" && !input.omitAuthorizationReceipt
        ? digest(`0036:synthetic:${input.label}:auth`) : null,
    blocked_at_db_ms: input.phase === "blocked" ? 1_000 : null,
    blocked_reason_code: input.phase === "blocked" ? "integrity_conflict" : null,
    created_at_db_ms: 1_000,
    updated_at_db_ms: 1_000,
    job_json: JSON.stringify(jobJson),
  };
  const columns = Object.keys(row);
  await conn.query(
    `INSERT INTO tenant_telemetry_disposition_jobs (${columns.join(",")})
     VALUES (${columns.map(() => "?").join(",")})`,
    Object.values(row),
  );
  return operation;
}

describe("0035 -> 0036 tenant telemetry disposition migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0036Dir: string;
  let through0036Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0036Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0036-"));
    through0036Dir = await mkdtemp(join(tmpdir(), "agent-service-through0036-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 35)
      .sort();
    expect(names).toHaveLength(35);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0035_tenant_telemetry_application_capture.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0036Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0036Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0035_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0036Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0036Dir) await rm(pre0036Dir, { recursive: true, force: true });
    if (through0036Dir) await rm(through0036Dir, { recursive: true, force: true });
  });

  async function create0035(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0036Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: through0036Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function seed0035(database: string, tenantId: string, enqueue = true): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0036Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    try {
      await store.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: [
          {
            domain: "logs",
            backendKind: "migration_fixture",
            adapterProtocol: "telemetry-fixture-v1",
            namespaceSha256: digest("0036:logs:namespace"),
            failureDomainSha256: digest("0036:logs:failure-domain"),
          },
          {
            domain: "traces",
            backendKind: "migration_fixture",
            adapterProtocol: "telemetry-fixture-v1",
            namespaceSha256: digest("0036:traces:namespace"),
            failureDomainSha256: digest("0036:traces:failure-domain"),
          },
        ],
      });
      await store.createApiKey(tenantId, `key-${tenantId}`, digest(`key:${tenantId}`));
      if (enqueue) {
        await store.enqueueTenantTelemetryArtifact({
          tenantId,
          expectedControlGeneration: 1,
          domain: "logs",
          artifactIdSha256: digest("0036:pre-cutover:artifact"),
          artifactGeneration: 1,
          ownerKind: "tenant",
          ownerId: tenantId,
          ownerUserId: null,
          sourceSchema: "migration-fixture-v1",
          sourceGeneration: 1,
          sourceHighWaterDbMs: 0,
          payload: {
            schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
            domain: "logs",
            records: [trustedRecord(1_000, tenantId)],
          },
        });
      }
    } finally {
      await store.close();
    }
  }

  async function assertExactSchema(conn: Connection): Promise<void> {
    const [tables] = await conn.query<Row[]>(
      `SELECT table_name AS name,engine AS engine_value,table_collation AS collation_value
         FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name IN (${DISPOSITION_TABLES.map(() => "?").join(",")})
        ORDER BY table_name`,
      [...DISPOSITION_TABLES],
    );
    expect(tables.map((row) => row.name)).toEqual([...DISPOSITION_TABLES]);
    expect(tables.every((row) => row.engine_value === "InnoDB"
      && row.collation_value === "utf8mb4_0900_as_cs")).toBe(true);
    const [triggers] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\\_tt\\_disposition\\_%'
        ORDER BY trigger_name`,
    );
    expect(triggers.map((row) => row.name)).toEqual([...DISPOSITION_TRIGGERS]);
    const [checks] = await conn.query<Row[]>(
      `SELECT tc.table_name AS name,tc.enforced AS enforced_value,
              cc.check_clause AS check_clause
         FROM information_schema.table_constraints tc
         JOIN information_schema.check_constraints cc
           ON cc.constraint_schema=tc.constraint_schema
          AND cc.constraint_name=tc.constraint_name
        WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'
          AND tc.table_name IN (${DISPOSITION_TABLES.map(() => "?").join(",")})`,
      [...DISPOSITION_TABLES],
    );
    expect(checks).toHaveLength(DISPOSITION_TABLES.length);
    expect(checks.every((row) => row.enforced_value === "YES")).toBe(true);
    for (const name of [
      "tenant_telemetry_disposition_jobs",
      "tenant_telemetry_disposition_authorization_grants",
      "tenant_telemetry_disposition_external_authorizations",
      "tenant_telemetry_disposition_tombstone_acks",
      "tenant_telemetry_disposition_receipts",
    ]) {
      const check = checks.find((row) => row.name === name);
      expect(String(check?.check_clause).toLowerCase())
        .toContain("length(convert(`tenant_id` using utf16)) between 2 and 256");
    }
  }

  it("upgrades frozen 0035 data without activating or materializing disposition", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0035(database);
      await seed0035(database, "tenant-租户");
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [beforeJobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [beforeSubjects] = await conn.query<Row[]>(
        "SELECT * FROM subject_lifecycle ORDER BY tenant_id,subject_kind,subject_id",
      );
      expect(beforeJobs).toHaveLength(1);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [control] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_disposition_control",
      );
      expect(control).toEqual([expect.objectContaining({
        singleton_id: 1,
        state: "inactive",
        control_generation: 0,
        activated_at_db_ms: null,
      })]);
      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_activation_receipts) AS activation_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grant_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs) AS job_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations) AS authorization_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS event_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks) AS ack_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts) AS receipt_count,
           (SELECT COUNT(*) FROM tenant_telemetry_disposition_replay_fences) AS fence_count`,
      );
      expect(counts[0]).toMatchObject({
        activation_count: 0,
        grant_count: 0,
        job_count: 0,
        authorization_count: 0,
        event_count: 0,
        ack_count: 0,
        receipt_count: 0,
        fence_count: 0,
      });
      const [afterJobs] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [afterSubjects] = await conn.query<Row[]>(
        "SELECT * FROM subject_lifecycle ORDER BY tenant_id,subject_kind,subject_id",
      );
      expect(afterJobs).toEqual(beforeJobs);
      expect(afterSubjects).toEqual(beforeSubjects);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(1);
      await assertExactSchema(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("replays an interrupted first DDL and a lost 0036 marker without duplicating control", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0035(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const first = statements(migrationSql).find((value) =>
        /^CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_control/.test(value));
      expect(first).toMatch(/^CREATE TABLE IF NOT EXISTS tenant_telemetry_disposition_control/);
      await conn.query(first!);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertExactSchema(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [rows] = await conn.query<Row[]>(
        "SELECT singleton_id,state,control_generation FROM tenant_telemetry_disposition_control",
      );
      expect(rows).toEqual([{ singleton_id: 1, state: "inactive", control_generation: 0 }]);
      await assertExactSchema(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a conflicting pre-existing 0036 table instead of trusting CREATE IF NOT EXISTS", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0035(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        "CREATE TABLE tenant_telemetry_disposition_control (singleton_id TINYINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB",
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow();
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
  }, 120_000);

  it("refuses activation while the historical 0034 payload spool is pending", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0035(database);
      await seed0035(database, "tenant-spool-pending");
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [lifecycle] = await conn.query<Row[]>(
        "SELECT target_root_sha256 FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_disposition_activation_receipts
           (singleton_id,scope,protocol,control_generation,activation_evidence_sha256,
            lifecycle_target_root_sha256,journal_namespace_sha256,journal_target_sha256,
            failure_domain_sha256,logical_database_namespace_sha256,activated_at_db_ms,
            receipt_sha256,receipt_json)
         VALUES (1,'tenant-telemetry-disposition-activation-receipt-v1',
           'tenant-telemetry-disposition-v1',1,?,?,?,?,?,?,1000,?,JSON_OBJECT('fixture',TRUE))`,
        [digest("activation"), lifecycle[0]?.target_root_sha256,
          digest("journal-namespace"), digest("journal-target"),
          digest("failure-domain"), digest("logical-db"), digest("receipt")],
      )).rejects.toThrow("tenant telemetry disposition activation is not source-bound");
      const [control] = await conn.query<Row[]>(
        "SELECT state,control_generation FROM tenant_telemetry_disposition_control",
      );
      expect(control).toEqual([{ state: "inactive", control_generation: 0 }]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("linearizes activation against a paused legacy insert and hard-stops marker-loss replay", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    let writer: MysqlSessionStore | undefined;
    try {
      await create0035(database);
      await seed0035(database, "tenant-active-cutover", false);
      await upgrade(database);
      writer = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0036Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [lifecycle] = await conn.query<Row[]>(
        `SELECT target_root_sha256 AS target_root,activated_at_db_ms AS activated_at
           FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1`,
      );
      const activatedAt = Number(lifecycle[0]?.activated_at) + 1;
      const activationEvidence = digest("0036:active-marker-loss:evidence");
      const journalNamespace = digest("0036:active-marker-loss:journal-namespace");
      const journalTarget = digest("0036:active-marker-loss:journal-target");
      const failureDomain = digest("0036:active-marker-loss:failure-domain");
      const logicalDatabase = digest("0036:active-marker-loss:logical-database");
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO tenant_telemetry_disposition_activation_receipts
           (singleton_id,scope,protocol,control_generation,activation_evidence_sha256,
            lifecycle_target_root_sha256,journal_namespace_sha256,journal_target_sha256,
            failure_domain_sha256,logical_database_namespace_sha256,activated_at_db_ms,
            receipt_sha256,receipt_json)
         VALUES (1,'tenant-telemetry-disposition-activation-receipt-v1',
           'tenant-telemetry-disposition-v1',1,?,?,?,?,?,?,?,?,
           JSON_OBJECT('fixture','active-marker-loss'))`,
        [activationEvidence, lifecycle[0]?.target_root, journalNamespace, journalTarget,
          failureDomain, logicalDatabase, activatedAt, digest("0036:active-marker-loss:receipt")],
      );
      await conn.query(
        `UPDATE tenant_telemetry_disposition_control
            SET state='active',control_generation=1,protocol='tenant-telemetry-disposition-v1',
                lifecycle_control_generation=1,lifecycle_target_root_sha256=?,
                adapter_protocol='telemetry-fixture-v1',journal_namespace_sha256=?,
                journal_target_sha256=?,failure_domain_sha256=?,
                logical_database_namespace_sha256=?,activated_at_db_ms=?,
                activation_evidence_sha256=?
          WHERE singleton_id=1 AND state='inactive'`,
        [lifecycle[0]?.target_root, journalNamespace, journalTarget, failureDomain,
          logicalDatabase, activatedAt, activationEvidence],
      );
      let writeSettled = false;
      const writeOutcome = writer.enqueueTenantTelemetryArtifact({
        tenantId: "tenant-active-cutover",
        expectedControlGeneration: 1,
        domain: "logs",
        artifactIdSha256: digest("0036:paused-legacy-insert:artifact"),
        artifactGeneration: 1,
        ownerKind: "tenant",
        ownerId: "tenant-active-cutover",
        ownerUserId: null,
        sourceSchema: "migration-fixture-v1",
        sourceGeneration: 1,
        sourceHighWaterDbMs: 0,
        payload: {
          schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
          domain: "logs",
          records: [trustedRecord(1_000, "tenant-active-cutover")],
        },
      }).then(
        () => { writeSettled = true; return { succeeded: true, error: null }; },
        (error: unknown) => { writeSettled = true; return { succeeded: false, error }; },
      );
      let controlLockWaitObserved = false;
      const waitDeadline = Date.now() + 10_000;
      while (Date.now() < waitDeadline) {
        const [waits] = await admin.query<Row[]>(
          `SELECT requested.OBJECT_NAME AS object_name
             FROM performance_schema.data_lock_waits waiting
             JOIN performance_schema.data_locks requested
               ON requested.ENGINE_LOCK_ID=waiting.REQUESTING_ENGINE_LOCK_ID
            WHERE requested.OBJECT_SCHEMA=?
              AND requested.OBJECT_NAME='tenant_telemetry_disposition_control'
              AND requested.INDEX_NAME='PRIMARY'
              AND requested.LOCK_TYPE='RECORD'`,
          [database],
        );
        if (waits.length > 0) {
          controlLockWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(controlLockWaitObserved).toBe(true);
      expect(writeSettled).toBe(false);
      await conn.commit();
      const outcome = await writeOutcome;
      expect(outcome.succeeded).toBe(false);
      expect(String(outcome.error)).toContain("cutover blocks legacy writer");
      await expect(insertSyntheticDispositionJob(conn, {
        label: "missing-json-tenant",
        tenantId: "tenant-active-cutover",
        phase: "blocked",
        omitJsonTenantId: true,
      })).rejects.toThrow("tenant telemetry disposition job is not executable-source-bound");
      await expect(insertSyntheticDispositionJob(conn, {
        label: "astral-overlimit",
        tenantId: "🌟".repeat(65),
        phase: "blocked",
      })).rejects.toThrow("chk_tt_disposition_job");
      const [writeCounts] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_write_jobs) AS job_count,
                (SELECT COUNT(*) FROM tenant_telemetry_write_payloads) AS payload_count,
                (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory) AS inventory_count`,
      );
      expect(writeCounts[0]).toMatchObject({
        job_count: 0,
        payload_count: 0,
        inventory_count: 0,
      });
      const [dispositionJobs] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS job_count FROM tenant_telemetry_disposition_jobs",
      );
      expect(Number(dispositionJobs[0]?.job_count)).toBe(0);
      const [before] = await conn.query<Row[]>(
        `SELECT trigger_name AS name,action_statement AS body
           FROM information_schema.triggers WHERE trigger_schema=DATABASE()
             AND trigger_name IN ('trg_tt_disposition_legacy_write_bi',
               'trg_tt_disposition_legacy_inventory_bi') ORDER BY trigger_name`,
      );
      expect(before).toHaveLength(2);
      expect(before.every((row) => /FOR SHARE/i.test(String(row.body)))).toBe(true);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [after] = await conn.query<Row[]>(
        `SELECT trigger_name AS name,action_statement AS body
           FROM information_schema.triggers WHERE trigger_schema=DATABASE()
             AND trigger_name IN ('trg_tt_disposition_legacy_write_bi',
               'trg_tt_disposition_legacy_inventory_bi') ORDER BY trigger_name`,
      );
      expect(after).toEqual(before);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.count)).toBe(0);
    } finally {
      await conn?.rollback().catch(() => {});
      await conn?.end();
      await writer?.close();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects SQL UNKNOWN in active control, job transition, and restore fence guards", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0035(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      // Each dropped BEFORE INSERT/UPDATE trigger isolates its table CHECK on a disposable DB.
      // This does not represent a product activation or deletion authority.
      await conn.query("DROP TRIGGER trg_tt_disposition_control_bu");
      await expect(conn.query(
        `UPDATE tenant_telemetry_disposition_control
            SET state='active',control_generation=1,
                protocol='tenant-telemetry-disposition-v1',
                lifecycle_control_generation=1
          WHERE singleton_id=1`,
      )).rejects.toThrow("chk_tt_disposition_control");
      const [control] = await conn.query<Row[]>(
        "SELECT state,control_generation FROM tenant_telemetry_disposition_control",
      );
      expect(control).toEqual([{ state: "inactive", control_generation: 0 }]);

      await conn.query("DROP TRIGGER trg_tt_disposition_job_bi");
      await expect(insertSyntheticDispositionJob(conn, {
        label: "missing-authorized-receipt",
        tenantId: "tenant-租户",
        phase: "authorized",
        omitAuthorizationReceipt: true,
      })).rejects.toThrow("chk_tt_disposition_job");
      const operation = await insertSyntheticDispositionJob(conn, {
        label: "clear-authorized-receipt",
        tenantId: "tenant-租户",
        phase: "authorized",
      });
      await expect(conn.query(
        `UPDATE tenant_telemetry_disposition_jobs
            SET phase='blocked',available_at_db_ms=NULL,
                authorization_receipt_sha256=NULL,
                blocked_at_db_ms=1001,blocked_reason_code='integrity_conflict',
                updated_at_db_ms=1001
          WHERE disposition_operation_sha256=?`,
        [operation],
      )).rejects.toThrow("tenant telemetry disposition job transition is invalid");
      const [job] = await conn.query<Row[]>(
        `SELECT phase,authorization_receipt_sha256 AS authorization_hash
           FROM tenant_telemetry_disposition_jobs
          WHERE disposition_operation_sha256=?`,
        [operation],
      );
      expect(job).toEqual([expect.objectContaining({
        phase: "authorized",
        authorization_hash: digest("0036:synthetic:clear-authorized-receipt:auth"),
      })]);

      await conn.query("DROP TRIGGER trg_tt_disposition_replay_bi");
      const fence: Record<string, string | number | null> = {
        target_sha256: digest("0036:half-bound:target"),
        artifact_id_sha256: digest("0036:half-bound:artifact"),
        artifact_generation: 1,
        domain: "logs",
        disposition_operation_sha256: digest("0036:half-bound:operation"),
        authorization_receipt_sha256: digest("0036:half-bound:authorization"),
        tombstone_receipt_sha256: digest("0036:half-bound:tombstone"),
        terminal_receipt_sha256: digest("0036:half-bound:terminal"),
        journal_target_sha256: digest("0036:half-bound:journal-target"),
        terminal_journal_sequence: 1,
        terminal_journal_event_root_sha256: digest("0036:half-bound:terminal-root"),
        sealed_journal_sequence: 1,
        sealed_journal_event_root_sha256: digest("0036:half-bound:sealed-root"),
        restore_run_sha256: digest("0036:half-bound:restore-run"),
        runtime_epoch_sha256: null,
        receipt_sha256: digest("0036:half-bound:receipt"),
        fence_json: JSON.stringify({ fixture: "half-bound" }),
      };
      const columns = Object.keys(fence);
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_disposition_replay_fences
           (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        Object.values(fence),
      )).rejects.toThrow("chk_tt_disposition_replay_fence");
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

});
