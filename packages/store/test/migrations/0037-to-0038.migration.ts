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
const MIGRATION_NAME = "0038_tenant_telemetry_artifact_membership.sql";
// Frozen published predecessor chain: a changed 0001..0037 fails before any fixture database
// is created. This is a real 0037 historical upgrade, not a fresh 0038-schema smoke test.
const FROZEN_0037_CHAIN_SHA256 =
  "89fd379bec002e7d73484ff8fa54cc5eee9dd97e902459a16a7b5d5ab2ab8983";
const REF_KEY = Buffer.alloc(32, 0x38);
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
  return `agent_service_migration_test_0038_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
  telemetry.info("runner.runtime.info", {
    ownerRef: telemetry.opaqueRef("tenant", tenantId),
  });
  if (!result) throw new Error("trusted telemetry fixture did not emit a record");
  return result;
}

function writeInput(tenantId: string): EnqueueTenantTelemetryArtifactInput {
  return {
    tenantId, expectedControlGeneration: 1, domain: "logs",
    artifactIdSha256: digest(`0038:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRecord(tenantId)],
    },
  };
}

describe("0037 -> 0038 immutable telemetry artifact membership historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0038Dir: string;
  let through0038Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0038Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0038-"));
    through0038Dir = await mkdtemp(join(tmpdir(), "agent-service-through0038-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 37)
      .sort();
    expect(names).toHaveLength(37);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0037_tenant_telemetry_disposition_grant_guard.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0038Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0038Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0037_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0038Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0038Dir) await rm(pre0038Dir, { recursive: true, force: true });
    if (through0038Dir) await rm(through0038Dir, { recursive: true, force: true });
  });

  async function create0037(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: pre0038Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: through0038Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function newTriggerNames(conn: Connection): Promise<string[]> {
    const [rows] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\\_tt\\_membership\\_%'
        ORDER BY trigger_name`,
    );
    return rows.map((row) => String(row.name));
  }

  it("upgrades frozen 0037 without backfilling a historical job or enabling disposition", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0037(database);
      const tenantId = "tenant-pre0038";
      const before = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0038Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await before.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0038:${domain}:namespace`),
          failureDomainSha256: digest(`0038:${domain}:failure-domain`),
        })),
      });
      await before.createApiKey(tenantId, "key-pre0038", digest("0038:api-key"));
      const historicalJob = await before.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      await before.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      expect(jobsBefore).toHaveLength(1);
      expect(jobsBefore[0]?.write_operation_sha256).toBe(historicalJob.writeOperationSha256);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      expect(jobsAfter).toEqual(jobsBefore);
      const [membership] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM tenant_telemetry_artifact_memberships",
      );
      expect(Number(membership[0]?.n)).toBe(0);
      const legacyInventory = typeof jobsBefore[0]?.inventory_json === "string"
        ? JSON.parse(jobsBefore[0].inventory_json) as Record<string, unknown>
        : jobsBefore[0]?.inventory_json as Record<string, unknown>;
      const unboundOperation = digest("0038:unbound:new-operation");
      const unboundInventory = digest("0038:unbound:new-inventory");
      const unboundArtifact = digest("0038:unbound:new-artifact");
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_write_jobs
           (write_operation_sha256,tenant_id,protocol,phase,domain,target_sha256,
            inventory_sha256,artifact_id_sha256,artifact_generation,payload_sha256,
            manifest_sha256,inventory_json,record_count,payload_byte_length,available_at_ms,
            attempts,claim_token,lease_until_ms,last_error_code,write_ack_receipt_sha256,
            written_at_db_ms,completed_claim_attempt,completed_claim_token_sha256,
            blocked_at_db_ms,blocked_reason_code,created_at_ms,updated_at_ms)
         VALUES (?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
                 NULL,NULL,?,?)`,
        [unboundOperation, tenantId, jobsBefore[0]?.protocol, jobsBefore[0]?.domain,
          jobsBefore[0]?.target_sha256, unboundInventory, unboundArtifact,
          jobsBefore[0]?.artifact_generation, jobsBefore[0]?.payload_sha256,
          jobsBefore[0]?.manifest_sha256,
          JSON.stringify({ ...legacyInventory, inventorySha256: unboundInventory,
            artifactIdSha256: unboundArtifact }),
          jobsBefore[0]?.record_count, jobsBefore[0]?.payload_byte_length,
          jobsBefore[0]?.available_at_ms, jobsBefore[0]?.created_at_ms,
          jobsBefore[0]?.updated_at_ms],
      )).rejects.toThrow(/lacks exact immutable membership/);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      expect(await newTriggerNames(conn)).toEqual([
        "trg_tt_membership_bd", "trg_tt_membership_bi", "trg_tt_membership_bu",
        "trg_tt_membership_write_job_bi",
      ]);
      const [disposition] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_jobs) AS jobs`,
      );
      expect(disposition[0]).toMatchObject({ grants: 0, jobs: 0 });
      // A published pre-0038 binary still expects exactly 83 triggers and must fail closed.
      const oldFingerprint = statements(await readFile(join(
        MIGRATIONS_DIR, "0037_tenant_telemetry_disposition_grant_guard.sql"), "utf8",
      )).find((statement) => statement.startsWith("SET @tt_grant_guard_triggers_ok="));
      expect(oldFingerprint).toBeDefined();
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(oldFingerprint!);
      const [oldGuard] = await conn.query<Row[]>(
        "SELECT @tt_grant_guard_triggers_ok AS ok",
      );
      expect(Number(oldGuard[0]?.ok)).toBe(0);
      await conn.end();
      conn = undefined;
      const after = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: through0038Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      const postTenantId = "tenant-post0038";
      await after.createApiKey(postTenantId, "key-post0038", digest("0038:post:api-key"));
      const newJob = await after.enqueueTenantTelemetryArtifact(writeInput(postTenantId));
      await after.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [newMembership] = await conn.query<Row[]>(
        `SELECT write_operation_sha256 FROM tenant_telemetry_artifact_memberships
          WHERE write_operation_sha256=?`, [newJob.writeOperationSha256],
      );
      expect(newMembership).toHaveLength(1);
      await expect(conn.query(
        `UPDATE tenant_telemetry_artifact_memberships
            SET owner_binding_sha256=owner_binding_sha256 WHERE write_operation_sha256=?`,
        [newJob.writeOperationSha256],
      )).rejects.toThrow(/membership is immutable/);
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_artifact_memberships WHERE write_operation_sha256=?",
        [newJob.writeOperationSha256],
      )).rejects.toThrow(/membership is append-only/);
      const [sourceMembershipRows] = await conn.query<Row[]>(
        `SELECT * FROM tenant_telemetry_artifact_memberships
          WHERE write_operation_sha256=?`, [newJob.writeOperationSha256],
      );
      const [sourceJobRows] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs WHERE write_operation_sha256=?",
        [newJob.writeOperationSha256],
      );
      const cloneOperation = digest("0038:timestamp-drift:operation");
      const cloneInventory = digest("0038:timestamp-drift:inventory");
      const cloneArtifact = digest("0038:timestamp-drift:artifact");
      const clonedMembership = {
        ...sourceMembershipRows[0],
        write_operation_sha256: cloneOperation,
        inventory_sha256: cloneInventory,
        artifact_id_sha256: cloneArtifact,
        membership_sha256: digest("0038:timestamp-drift:membership"),
      };
      const sourceJob = sourceJobRows[0]!;
      const sourceInventory = typeof sourceJob.inventory_json === "string"
        ? JSON.parse(sourceJob.inventory_json) as Record<string, unknown>
        : sourceJob.inventory_json as Record<string, unknown>;
      const clonedJob = {
        ...sourceJob,
        write_operation_sha256: cloneOperation,
        inventory_sha256: cloneInventory,
        artifact_id_sha256: cloneArtifact,
        inventory_json: JSON.stringify({ ...sourceInventory,
          inventorySha256: cloneInventory, artifactIdSha256: cloneArtifact }),
        available_at_ms: Number(sourceJob.available_at_ms) + 1,
        created_at_ms: Number(sourceJob.created_at_ms) + 1,
        updated_at_ms: Number(sourceJob.updated_at_ms) + 1,
      };
      await conn.beginTransaction();
      try {
        const membershipColumns = Object.keys(clonedMembership);
        await conn.query(
          `INSERT INTO tenant_telemetry_artifact_memberships
             (${membershipColumns.join(",")})
           VALUES (${membershipColumns.map(() => "?").join(",")})`,
          membershipColumns.map((column) =>
            (clonedMembership as Record<string, unknown>)[column]),
        );
        const jobColumns = Object.keys(clonedJob);
        await expect(conn.query(
          `INSERT INTO tenant_telemetry_write_jobs
             (${jobColumns.join(",")})
           VALUES (${jobColumns.map(() => "?").join(",")})`,
          jobColumns.map((column) => (clonedJob as Record<string, unknown>)[column]),
        )).rejects.toThrow(/lacks exact immutable membership/);
      } finally {
        await conn.rollback();
      }
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes partial DDL and exact marker-loss replay without rotating the 0035 job guard", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0037(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const first = statements(migrationSql).slice(0, 3);
      expect(first[0]).toMatch(/^CREATE TABLE IF NOT EXISTS tenant_telemetry_artifact_memberships /);
      expect(first[2]).toMatch(/^CREATE TRIGGER trg_tt_membership_bi /);
      for (const statement of first) await conn.query(statement);
      expect(await newTriggerNames(conn)).toEqual(["trg_tt_membership_bi"]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toHaveLength(4);
      const [originalGuard] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS n FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name='trg_managed_telemetry_write_jobs_bi'`,
      );
      expect(Number(originalGuard[0]?.n)).toBe(1);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toHaveLength(4);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a pre-existing malformed table before installing the new job guard", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0037(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(`CREATE TABLE tenant_telemetry_artifact_memberships (
        write_operation_sha256 CHAR(64) PRIMARY KEY) ENGINE=InnoDB`);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toEqual([]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a tampered pre-existing membership trigger without marker or guard rotation", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0037(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      for (const statement of statements(migrationSql).slice(0, 2)) await conn.query(statement);
      await conn.query(`CREATE TRIGGER trg_tt_membership_bi BEFORE INSERT
        ON tenant_telemetry_artifact_memberships FOR EACH ROW
        BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered'; END`);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toEqual(["trg_tt_membership_bi"]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);
});
