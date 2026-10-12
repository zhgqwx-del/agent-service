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
const MIGRATION_NAME = "0039_tenant_telemetry_owner_closure.sql";
// Frozen published predecessor chain. A changed 0001..0038 fails before a fixture DB is made.
const FROZEN_0038_CHAIN_SHA256 =
  "9a41edbe2016ff93678c3daaa1abc4b3aa63678979681d06512677dafc021229";
const REF_KEY = Buffer.alloc(32, 0x39);
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
  return `agent_service_migration_test_0039_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
    artifactIdSha256: digest(`0039:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRecord(tenantId)],
    },
  };
}

describe("0038 -> 0039 immutable telemetry T3f owner closure historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0039Dir: string;
  let through0039Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0039Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0039-"));
    through0039Dir = await mkdtemp(join(tmpdir(), "agent-service-through0039-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 38)
      .sort();
    expect(names).toHaveLength(38);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0038_tenant_telemetry_artifact_membership.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0039Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0039Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0038_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0039Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0039Dir) await rm(pre0039Dir, { recursive: true, force: true });
    if (through0039Dir) await rm(through0039Dir, { recursive: true, force: true });
  });

  async function create0038(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: pre0039Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: through0039Dir,
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
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\\_tt\\_owner\\_closure\\_%'
        ORDER BY trigger_name`,
    );
    return rows.map((row) => String(row.name));
  }

  it("preserves a frozen-0038 telemetry write and leaves 0039 closure empty", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      const tenantId = "tenant-pre0039";
      const before = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0039Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await before.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0039:${domain}:namespace`),
          failureDomainSha256: digest(`0039:${domain}:failure-domain`),
        })),
      });
      await before.createApiKey(tenantId, "key-pre0039", digest("0039:api-key"));
      const historicalJob = await before.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      await before.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [membershipBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256",
      );
      expect(jobsBefore).toHaveLength(1);
      expect(membershipBefore).toHaveLength(1);
      expect(jobsBefore[0]?.write_operation_sha256).toBe(historicalJob.writeOperationSha256);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256",
      );
      const [membershipAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256",
      );
      expect(jobsAfter).toEqual(jobsBefore);
      expect(membershipAfter).toEqual(membershipBefore);
      const [closure] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts) AS receipts,
                (SELECT COUNT(*) FROM tenant_database_purge_receipts) AS t3f_receipts,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants`,
      );
      expect(closure[0]).toMatchObject({ entries: 0, receipts: 0, t3f_receipts: 0, grants: 0 });
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      expect(await newTriggerNames(conn)).toHaveLength(8);
      const oldFingerprint = statements(await readFile(join(
        MIGRATIONS_DIR, "0038_tenant_telemetry_artifact_membership.sql"), "utf8",
      )).find((statement) => statement.startsWith("SET @tt_membership_triggers_ok="));
      expect(oldFingerprint).toBeDefined();
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(oldFingerprint!);
      const [oldGuard] = await conn.query<Row[]>("SELECT @tt_membership_triggers_ok AS ok");
      expect(Number(oldGuard[0]?.ok)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes partial DDL and exact marker-loss replay without duplicate guards", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const first = statements(migrationSql).slice(0, 5);
      expect(first[0]).toMatch(/^CREATE TABLE IF NOT EXISTS tenant_telemetry_owner_closure_entries /);
      expect(first[2]).toMatch(/^CREATE TABLE IF NOT EXISTS tenant_telemetry_owner_closure_receipts /);
      expect(first[4]).toMatch(/^CREATE TRIGGER trg_tt_owner_closure_entry_bi /);
      for (const statement of first) await conn.query(statement);
      expect(await newTriggerNames(conn)).toEqual(["trg_tt_owner_closure_entry_bi"]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toHaveLength(8);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toHaveLength(8);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects marker-loss replay when a committed closure entry has no terminal aggregate", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      await upgrade(database);
      const tenantId = "tenant-0039-orphan";
      const requestId = "request-0039-orphan";
      const predeleteSha256 = digest("0039:orphan:predelete");
      const writer = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: through0039Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      try {
        await writer.activateTenantTelemetryLifecycle({
          expectedControlGeneration: 0,
          targets: ["logs", "traces"].map((domain) => ({
            domain: domain as "logs" | "traces", backendKind: "migration_fixture",
            adapterProtocol: "telemetry-fixture-v1",
            namespaceSha256: digest(`0039:orphan:${domain}:namespace`),
            failureDomainSha256: digest(`0039:orphan:${domain}:failure-domain`),
          })),
        });
        await writer.createApiKey(tenantId, "key-0039-orphan", digest("0039:orphan:api-key"));
        await writer.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      } finally {
        await writer.close();
      }
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [memberships] = await conn.query<Row[]>(
        "SELECT * FROM tenant_telemetry_artifact_memberships WHERE tenant_id=?", [tenantId],
      );
      expect(memberships).toHaveLength(1);
      const membership = memberships[0]!;
      // The upstream T3f job/receipt are synthetic only to create the narrowly scoped
      // impossible committed entry. The entry itself must pass the real 0039 insert guard
      // against a live membership, matching queued job, and pre-delete receipt.
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      try {
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
            digest("0039:orphan:t3c"), digest("0039:orphan:plan"),
            digest("0039:orphan:t3e"), digest("0039:orphan:policy"),
            "863bda0e079e55aa4c751d6a4c18860cac791985c34a27572c9294cf9f7a4396",
            "776cd8a7449522e7b71b04cc502881af1ebc11600627bc15606f90c29fdfe552"],
        );
        await conn.query(
          `INSERT INTO tenant_database_purge_predelete_receipts
             (scope,request_id,tenant_id,subject_generation,plan_build_generation,
              execution_generation,database_purge_generation,t3c_receipt_sha256,
              plan_receipt_sha256,local_physical_ack_receipt_sha256,policy_sha256,
              purge_not_before_db_ms,source_evidence_db_ms,entry_count,entry_root_sha256,
              session_target_count,session_target_root_sha256,retained_billing_fact_count,
              retained_billing_fact_root_sha256,billing_reconciliation_target_count,
              billing_reconciliation_target_root_sha256,store_db_timestamp_ms,
              completed_claim_attempt,completed_claim_token_sha256,predelete_complete,
              destructive_progress,content_purge_executed,receipt_sha256)
           VALUES ('tenant-database-purge-predelete-v1',?,?,1,1,1,1,?,?,?,?,
                   1,1,11,?,0,?,0,?,0,?,20,1,?,TRUE,FALSE,FALSE,?)`,
          [requestId, tenantId, digest("0039:orphan:t3c"), digest("0039:orphan:plan"),
            digest("0039:orphan:t3e"), digest("0039:orphan:policy"),
            "863bda0e079e55aa4c751d6a4c18860cac791985c34a27572c9294cf9f7a4396",
            "dd81e7e406988e57aada0e7d119e4a685b1d289d7ff1ead9731a41b49372807e",
            "486c74f49d51cd39028a367ed6b8e7083999927e9fc7270c88a529a249a30b9f",
            "d521b8dcdbce4a56fa16dfa646449f1bc1b4f089ea4e1a02de49db5cc4472cfe",
            digest("0039:orphan:claim"), predeleteSha256],
        );
        await conn.query(
          `INSERT INTO tenant_telemetry_owner_closure_entries
             (scope,request_id,tenant_id,subject_generation,plan_build_generation,
              execution_generation,database_purge_generation,write_operation_sha256,
              membership_sha256,inventory_sha256,owner_kind,owner_ref_sha256,
              hold_subject_ref_sha256,ref_key_id_sha256,owner_binding_sha256,
              canonical_owner_proof_sha256,session_grave_marker_sha256,
              predelete_receipt_sha256,captured_at_db_ms,receipt_sha256)
           VALUES ('tenant-telemetry-owner-closure-entry-v1',?,?,1,1,1,1,?,?,?,?,?,?,?,?,
                   ?,NULL,?,20,?)`,
          [requestId, tenantId, membership.write_operation_sha256,
            membership.membership_sha256, membership.inventory_sha256,
            membership.owner_kind, membership.owner_ref_sha256,
            membership.hold_subject_ref_sha256, membership.ref_key_id_sha256,
            membership.owner_binding_sha256, digest("0039:orphan:owner-proof"),
            predeleteSha256, digest("0039:orphan:entry")],
        );
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
      }
      const [orphan] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM tenant_telemetry_owner_closure_entries WHERE request_id=?",
        [requestId],
      );
      expect(Number(orphan[0]?.n)).toBe(1);
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
      const cause = (failure as Error & {
        cause?: { sqlMessage?: string; message?: string };
      }).cause;
      expect(cause?.sqlMessage ?? cause?.message).toContain(
        "__invalid_tenant_telemetry_owner_closure_projection__",
      );
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
      expect(await newTriggerNames(conn)).toHaveLength(8);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a malformed pre-existing closure table before installing the terminal guard", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(`CREATE TABLE tenant_telemetry_owner_closure_entries (
        request_id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB`);
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

  it("rejects tampered partial trigger and never records the migration marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      for (const statement of statements(migrationSql).slice(0, 4)) await conn.query(statement);
      await conn.query(`CREATE TRIGGER trg_tt_owner_closure_entry_bi BEFORE INSERT
        ON tenant_telemetry_owner_closure_entries FOR EACH ROW
        BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered'; END`);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await newTriggerNames(conn)).toEqual(["trg_tt_owner_closure_entry_bi"]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("blocks a new T3f terminal transition without its same-transaction closure receipt", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0038(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      // This disposable-only row deliberately bypasses unrelated upstream FKs to exercise
      // the terminal SQL guard itself, not to fabricate a valid T3f authorization proof.
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      await conn.beginTransaction();
      try {
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
          ["request-0039-guard", "tenant-0039-guard", 1, 1, 1, 1,
            digest("0039:t3c"), digest("0039:plan"), digest("0039:t3e"),
            digest("0039:policy"),
            "863bda0e079e55aa4c751d6a4c18860cac791985c34a27572c9294cf9f7a4396",
            "776cd8a7449522e7b71b04cc502881af1ebc11600627bc15606f90c29fdfe552"],
        );
        await expect(conn.query(
          `UPDATE tenant_database_purge_jobs
              SET phase='database_purged',predelete_entry_count=11,
                  predelete_entry_root_sha256=?,domain_ack_count=11,
                  domain_ack_root_sha256=?,predelete_receipt_sha256=?,
                  terminal_receipt_sha256=?,available_at_ms=NULL,claim_token=NULL,
                  lease_until_ms=NULL,last_error_code=NULL,updated_at_ms=20,
                  purged_at_db_ms=20,completed_claim_attempt=1,
                  completed_claim_token_sha256=?
            WHERE request_id='request-0039-guard'`,
          [digest("0039:entries"), digest("0039:acks"), digest("0039:predelete"),
            digest("0039:terminal"), digest("0039:claim")],
        )).rejects.toThrow(/terminal T3f lacks immutable telemetry owner closure/);
      } finally {
        await conn.rollback();
        await conn.query("SET FOREIGN_KEY_CHECKS=1");
      }
      const [rows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM tenant_database_purge_jobs WHERE request_id='request-0039-guard'",
      );
      expect(Number(rows[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);
});
