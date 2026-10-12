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
  TenantErasureIntegrityError,
  type EnqueueTenantTelemetryArtifactInput,
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0041_tenant_telemetry_target_manifest.sql";
// Frozen published 0001..0040 chain: changing a predecessor is not an upgrade test.
const FROZEN_0040_CHAIN_SHA256 =
  "3fc1bacb0b23836eddee6e6a1292ea97c485bc49c7471c72164070aeb7dc5818";
const REF_KEY = Buffer.alloc(32, 0x40);
type Row = RowDataPacket;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function disposableBase(raw: string): URL {
  let url: URL;
  let database: string;
  try {
    url = new URL(raw);
    database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    throw new Error("MYSQL_MIGRATION_TEST_URL must be a valid disposable MySQL test URL");
  }
  if (url.protocol !== "mysql:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_MIGRATION_TEST_URL must target local MySQL and a test/migration database");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(): string {
  return `agent_service_migration_test_0041_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
    artifactIdSha256: digest(`0041:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRecord(tenantId)],
    },
  };
}

describe("0040 -> 0041 immutable telemetry T3d target-manifest historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0041Dir: string;
  let through0041Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0041Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0041-"));
    through0041Dir = await mkdtemp(join(tmpdir(), "agent-service-through0041-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 40)
      .sort();
    expect(names).toHaveLength(40);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0040_tenant_telemetry_source_accounting.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0041Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0041Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0040_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0041Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0041Dir) await rm(pre0041Dir, { recursive: true, force: true });
    if (through0041Dir) await rm(through0041Dir, { recursive: true, force: true });
  });

  async function create0040(database: string): Promise<void> {
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
      [database],
    );
    if (existing.length !== 0) throw new Error("disposable 0041 fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    disposableDatabases.add(database);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: pre0041Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: through0041Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    if (!disposableDatabases.has(database)) return;
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function triggerNames(conn: Connection): Promise<string[]> {
    const [rows] = await conn.query<Row[]>(
      "SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name",
    );
    return rows.map((row) => String(row.name));
  }

  async function frozen0040StartupTriggerFingerprint(conn: Connection): Promise<boolean> {
    const sql = await readFile(join(pre0041Dir, "0040_tenant_telemetry_source_accounting.sql"), "utf8");
    const prefix = "agent-service-runtime-fingerprint:tenant-telemetry-source-accounting-triggers";
    const start = sql.indexOf(`-- ${prefix}:start`);
    const end = sql.indexOf(`-- ${prefix}:end`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const [statement] = statements(sql.slice(start + `-- ${prefix}:start`.length, end));
    expect(statement).toMatch(/^SET @tt_source_accounting_triggers_ok=/);
    await conn.query("SET @fixture_previous_group_concat_max_len=@@SESSION.group_concat_max_len");
    try {
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(statement!);
      const [rows] = await conn.query<Row[]>(
        "SELECT @tt_source_accounting_triggers_ok AS fingerprint_ok",
      );
      return Number(rows[0]?.fingerprint_ok) === 1;
    } finally {
      await conn.query("SET SESSION group_concat_max_len=@fixture_previous_group_concat_max_len");
    }
  }

  async function current0042StartupTriggerFingerprint(conn: Connection): Promise<boolean> {
    const sql = await readFile(join(MIGRATIONS_DIR,
      "0042_tenant_telemetry_plan_artifact_target.sql"), "utf8");
    const prefix = "agent-service-runtime-fingerprint:tenant-telemetry-plan-artifact-target-triggers";
    const start = sql.indexOf(`-- ${prefix}:start`);
    const end = sql.indexOf(`-- ${prefix}:end`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const [statement] = statements(sql.slice(start + `-- ${prefix}:start`.length, end));
    expect(statement).toMatch(/^SET @tt_plan_artifact_target_triggers_ok=/);
    await conn.query("SET @fixture_previous_group_concat_max_len=@@SESSION.group_concat_max_len");
    try {
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(statement!);
      const [rows] = await conn.query<Row[]>(
        "SELECT @tt_plan_artifact_target_triggers_ok AS fingerprint_ok",
      );
      return Number(rows[0]?.fingerprint_ok) === 1;
    } finally {
      await conn.query("SET SESSION group_concat_max_len=@fixture_previous_group_concat_max_len");
    }
  }

  it("refuses remote targets and never registers a pre-existing database for cleanup", async () => {
    expect(() => disposableBase("mysql://user:fixture-only@["))
      .toThrow("MYSQL_MIGRATION_TEST_URL must be a valid disposable MySQL test URL");
    expect(() => disposableBase("mysql://root@prod.example:3306/agent_service_test"))
      .toThrow("must target local MySQL");
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    try {
      await expect(create0040(database)).rejects.toThrow("database already exists");
      expect(disposableDatabases.has(database)).toBe(false);
      const [rows] = await admin.query<Row[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
        [database],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await admin.query(`DROP DATABASE \`${database}\``);
    }
  });

  it("preserves a frozen-0040 managed write without backfilling 0041 evidence", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0040(database);
      const tenantId = "tenant-pre0041";
      const writer = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0041Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await writer.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0041:${domain}:namespace`),
          failureDomainSha256: digest(`0041:${domain}:failure-domain`),
        })),
      });
      await writer.createApiKey(tenantId, "key-pre0041", digest("0041:api-key"));
      const historicalJob = await writer.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      await writer.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [membershipsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256",
      );
      const [controlBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      const [sourceBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_source_accounting_receipts ORDER BY request_id",
      );
      const [dispositionBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1",
      );
      const guardsBefore = await triggerNames(conn);
      expect(await frozen0040StartupTriggerFingerprint(conn)).toBe(true);
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
      const [controlAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      const [sourceAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_source_accounting_receipts ORDER BY request_id",
      );
      const [dispositionAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1",
      );
      expect(jobsAfter).toEqual(jobsBefore);
      expect(membershipsAfter).toEqual(membershipsBefore);
      expect(controlAfter).toEqual(controlBefore);
      expect(sourceAfter).toEqual(sourceBefore);
      expect(dispositionAfter).toEqual(dispositionBefore);
      expect(dispositionAfter[0]?.state).toBe("inactive");
      const [newEvidence] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_target_manifest_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_target_manifest_receipts) AS receipts,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS external_events`,
      );
      expect(newEvidence[0]).toMatchObject({ entries: 0, receipts: 0, grants: 0, external_events: 0 });
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      const guardsAfter = await triggerNames(conn);
      expect(guardsAfter).toHaveLength(guardsBefore.length + 8);
      expect(guardsAfter.filter((name) => name.startsWith("trg_tt_target_manifest_")))
        .toHaveLength(8);
      expect(guardsAfter).toContain("trg_tt_target_manifest_source_receipt_bu");
      // This executes the exact frozen 0040 startup fingerprint; it is not an
      // emulated old binary. Rejection proves the no-mixed-writer tripwire.
      expect(await frozen0040StartupTriggerFingerprint(conn)).toBe(false);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes partial DDL and marker-loss replay without duplicate guards", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0040(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const before = await triggerNames(conn);
      const firstTable = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_target_manifest_entries"));
      expect(firstTable).toBeDefined();
      await conn.query(firstTable!);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const complete = await triggerNames(conn);
      expect(complete.length).toBe(before.length + 8);
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

  it("rejects a malformed pre-existing target-manifest table", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0040(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(`CREATE TABLE tenant_telemetry_target_manifest_entries (
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

  it("rejects marker-loss replay after a privileged target-manifest trigger replacement", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0040(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [guards] = await conn.query<Row[]>(
        `SELECT trigger_name AS name,event_object_table AS table_name,
                action_timing AS timing,event_manipulation AS event_name
           FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND LEFT(trigger_name,LENGTH('trg_tt_target_manifest_'))
                ='trg_tt_target_manifest_'
          ORDER BY trigger_name LIMIT 1`,
      );
      expect(guards).toHaveLength(1);
      const guard = guards[0]!;
      const name = String(guard.name);
      const table = String(guard.table_name);
      const timing = String(guard.timing);
      const event = String(guard.event_name);
      expect(name).toMatch(/^trg_tt_target_manifest_[a-z0-9_]+$/);
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

  it("rejects marked-schema startup after an extra target-manifest column", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0040(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        "ALTER TABLE tenant_telemetry_target_manifest_entries ADD COLUMN leaked_locator VARCHAR(255) NULL",
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

  it("audits orphan 0041 projection on inactive 0042 startup with the exact 119-trigger fingerprint", async () => {
    const database = databaseName();
    const url = databaseUrl(base, database);
    let conn: Connection | undefined;
    try {
      await create0040(database);
      await upgrade(database);
      // The current binary requires 0042; advance only this disposable database after
      // the frozen 0040 -> 0041 upgrade before testing the retained 0041 projection.
      const healthy = await MysqlSessionStore.connect({ url, tenantTelemetryRefKey: REF_KEY });
      await healthy.close();
      conn = await mysql.createConnection(url);
      const [control] = await conn.query<Row[]>(
        "SELECT control_generation FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
      );
      expect(Number(control[0]?.control_generation)).toBe(0);
      const insertGuard = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TRIGGER trg_tt_target_manifest_receipt_bi "));
      expect(insertGuard).toBeDefined();
      await conn.query("DROP TRIGGER trg_tt_target_manifest_receipt_bi");
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      try {
        await conn.query(
          `INSERT INTO tenant_telemetry_target_manifest_receipts
             (scope,request_id,tenant_id,subject_generation,build_generation,
              plan_receipt_sha256,source_accounting_receipt_sha256,entry_count,
              entry_root_sha256,artifact_group_count,artifact_group_root_sha256,
              observed_target_count,observed_target_root_sha256,unknown_group_count,
              unknown_group_root_sha256,store_db_timestamp_ms,completed_claim_attempt,
              completed_claim_token_sha256,receipt_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ["tenant-telemetry-target-manifest-receipt-v1", `orphan-${randomUUID()}`,
            "tenant-orphan-manifest", 1, 1, "a".repeat(64), "b".repeat(64), 0,
            "c".repeat(64), 0, "d".repeat(64), 0, "e".repeat(64), 0,
            "f".repeat(64), 1, 1, "0".repeat(64), "1".repeat(64)],
        );
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
        await conn.query(insertGuard!);
      }
      expect(await current0042StartupTriggerFingerprint(conn)).toBe(true);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      await conn.end();
      conn = undefined;
      await expect(MysqlSessionStore.connect({ url, migrationMode: "verify" }))
        .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);
});
