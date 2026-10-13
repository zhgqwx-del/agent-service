import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { createStructuredTelemetry, type StructuredTelemetryRecord } from "@agent-service/protocol";
import {
  MysqlSessionStore, TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  type EnqueueTenantTelemetryArtifactInput,
} from "../../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const REF_KEY = Buffer.alloc(32, 0x49);
type Row = RowDataPacket;
const MIGRATION_NAME = "0049_tenant_telemetry_application_capture_v2.sql";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeInput(tenantId: string): EnqueueTenantTelemetryArtifactInput {
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
    artifactIdSha256: digest(`0049:${tenantId}:artifact`), artifactGeneration: 1,
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

function migrationStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

describe("0044 -> 0049 dormant telemetry capture v2 historical migration", () => {
  it("applies additive dormant schema to real MySQL", async () => {
    const base = safeBase(BASE_URL);
    const name = `agent_service_migration_test_0049_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const partialName =
      `agent_service_migration_test_0049_partial_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    const admin = await mysql.createConnection(adminUrl.toString());
    let conn: Connection | undefined;
    let oldDir: string | undefined;
    let newDir: string | undefined;
    let created = false;
    let partialCreated = false;
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
      const upgraded = await MysqlSessionStore.connect({
        url: databaseUrl(base, name), migrationsDir: newDir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await upgraded.close();
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
            coverage_evidence_sha256,producer_contract_sha256,source_session_id,
            source_turn_id,source_item_id,source_step_index,source_event_seq,
            owner_ref_sha256,payload_sha256,bound_at_db_ms,receipt_sha256)
         VALUES (?,'tenant-telemetry-capture-source-binding-v2',?,'logs',1,
                 ?,?,'session-0049','turn-0049','item-0049',0,1,?,?,1,?)`,
        [digest("v2-operation"),"tenant-pre0049",digest("v2-coverage"),
          digest("contract"),digest("owner"),digest("payload"),digest("binding")],
      )).rejects.toThrow("telemetry capture v2 source binding is disabled");
      const [footprint] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_coverages) AS coverages,
                (SELECT COUNT(*) FROM tenant_telemetry_capture_v2_source_bindings) AS bindings`,
      );
      expect(Number(footprint[0]?.coverages)).toBe(0);
      expect(Number(footprint[0]?.bindings)).toBe(0);

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
    } finally {
      if (conn) await conn.end();
      if (oldDir) await rm(oldDir, { recursive: true, force: true });
      if (newDir) await rm(newDir, { recursive: true, force: true });
      if (created) await admin.query(`DROP DATABASE \`${name}\``);
      if (partialCreated) await admin.query(`DROP DATABASE \`${partialName}\``);
      await admin.end();
    }
  }, 90_000);
});
