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
const MIGRATION_NAME = "0044_tenant_telemetry_pregrant_intent.sql";
// 0043 is code-only; pin the published 0001..0042 schema chain byte-for-byte.
// This is an SQL-shaped upgrade fixture, not a frozen 0042 JavaScript binary or T3f terminal.
const FROZEN_0042_CHAIN_SHA256 =
  "3c5b680edf4069a5b44b1e45dc32246f6327c9738487fe96639aab09a42e3ed1";
const REF_KEY = Buffer.alloc(32, 0x44);
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
  return `agent_service_migration_test_0044_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
    artifactIdSha256: digest(`0044:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: 0,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRecord(tenantId)],
    },
  };
}

describe("0042 -> 0044 default-dormant telemetry pregrant intent historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0044Dir: string;
  let through0044Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0044Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0044-"));
    through0044Dir = await mkdtemp(join(tmpdir(), "agent-service-through0044-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 42)
      .sort();
    expect(names).toHaveLength(42);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0042_tenant_telemetry_plan_artifact_target.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0044Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0044Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0042_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0044Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0044Dir) await rm(pre0044Dir, { recursive: true, force: true });
    if (through0044Dir) await rm(through0044Dir, { recursive: true, force: true });
  });

  async function create0042(database: string): Promise<void> {
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    if (existing.length !== 0) throw new Error("disposable 0044 fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    disposableDatabases.add(database);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: pre0044Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database), migrationsDir: through0044Dir,
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

  async function evaluateFingerprint(
    conn: Connection, sql: string, family: string, variable: string,
  ): Promise<boolean> {
    const prefix = `agent-service-runtime-fingerprint:${family}`;
    const start = sql.indexOf(`-- ${prefix}:start`);
    const end = sql.indexOf(`-- ${prefix}:end`);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const [statement] = statements(sql.slice(start + `-- ${prefix}:start`.length, end));
    expect(statement).toMatch(/^SET @/);
    await conn.query("SET @fixture_previous_group_concat_max_len=@@SESSION.group_concat_max_len");
    try {
      await conn.query("SET SESSION group_concat_max_len=1048576");
      await conn.query(statement!);
      const [rows] = await conn.query<Row[]>(`SELECT @${variable} AS fingerprint_ok`);
      return Number(rows[0]?.fingerprint_ok) === 1;
    } finally {
      await conn.query("SET SESSION group_concat_max_len=@fixture_previous_group_concat_max_len");
    }
  }

  function fingerprint(conn: Connection, sql: string, kind: "schema" | "triggers"): Promise<boolean> {
    return evaluateFingerprint(conn, sql, `tenant-telemetry-pregrant-intent-${kind}`,
      kind === "schema" ? "tt_pregrant_schema_ok" : "tt_pregrant_triggers_ok");
  }

  it("rejects remote or colliding targets before touching an existing database", async () => {
    expect(() => disposableBase("mysql://root@prod.example:3306/agent_service_test"))
      .toThrow("local MySQL");
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    try {
      await expect(create0042(database)).rejects.toThrow("database already exists");
      expect(disposableDatabases.has(database)).toBe(false);
      const [rows] = await admin.query<Row[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
      );
      expect(rows).toHaveLength(1);
    } finally {
      await admin.query(`DROP DATABASE \`${database}\``);
    }
  });

  it("preserves published 0042 managed evidence without backfilling or granting authority", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0042(database);
      const tenantId = "tenant-pre0044";
      const writer = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0044Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await writer.activateTenantTelemetryLifecycle({
        expectedControlGeneration: 0,
        targets: ["logs", "traces"].map((domain) => ({
          domain: domain as "logs" | "traces", backendKind: "migration_fixture",
          adapterProtocol: "telemetry-fixture-v1",
          namespaceSha256: digest(`0044:${domain}:namespace`),
          failureDomainSha256: digest(`0044:${domain}:failure-domain`),
        })),
      });
      await writer.createApiKey(tenantId, "key-pre0044", digest("0044:api-key"));
      await writer.enqueueTenantTelemetryArtifact(writeInput(tenantId));
      await writer.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsBefore] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256");
      const [membershipsBefore] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256");
      const [controlBefore] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1");
      const triggersBefore = await triggerNames(conn);
      const oldSql = await readFile(
        join(pre0044Dir, "0042_tenant_telemetry_plan_artifact_target.sql"), "utf8",
      );
      expect(await evaluateFingerprint(conn, oldSql,
        "tenant-telemetry-plan-artifact-target-triggers", "tt_plan_artifact_target_triggers_ok"))
        .toBe(true);
      expect(jobsBefore).toHaveLength(1);
      expect(membershipsBefore).toHaveLength(1);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [jobsAfter] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_write_jobs ORDER BY write_operation_sha256");
      const [membershipsAfter] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_artifact_memberships ORDER BY write_operation_sha256");
      const [controlAfter] = await conn.query<Row[]>("SELECT * FROM tenant_telemetry_disposition_control WHERE singleton_id=1");
      expect(jobsAfter).toEqual(jobsBefore);
      expect(membershipsAfter).toEqual(membershipsBefore);
      expect(controlAfter).toEqual(controlBefore);
      expect(controlAfter[0]?.state).toBe("inactive");
      const [newEvidence] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_pregrant_intents) AS intents,
                (SELECT COUNT(*) FROM tenant_telemetry_pregrant_claims) AS claims,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS external_events`,
      );
      expect(newEvidence[0]).toMatchObject({ intents: 0, claims: 0, grants: 0, external_events: 0 });
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
      expect((await triggerNames(conn)).length).toBe(triggersBefore.length + 7);
      // A pre-0044 process still expecting the published 119-trigger family must
      // reject this schema; the redundant catalog-receipt guard is the tripwire.
      expect(await evaluateFingerprint(conn, oldSql,
        "tenant-telemetry-plan-artifact-target-triggers", "tt_plan_artifact_target_triggers_ok"))
        .toBe(false);
      expect(await fingerprint(conn, migrationSql, "schema")).toBe(true);
      expect(await fingerprint(conn, migrationSql, "triggers")).toBe(true);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes first-DDL interruption and empty marker-loss replay without duplicate guards", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0042(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const before = await triggerNames(conn);
      const firstTable = statements(migrationSql).find((statement) =>
        statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_pregrant_intents"));
      expect(firstTable).toBeDefined();
      await conn.query(firstTable!);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const complete = await triggerNames(conn);
      expect(complete.length).toBe(before.length + 7);
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

  it("rejects malformed pre-existing tables and marked-schema drift", async () => {
    const malformed = databaseName();
    const drifted = databaseName();
    let conn: Connection | undefined;
    try {
      await create0042(malformed);
      conn = await mysql.createConnection(databaseUrl(base, malformed));
      await conn.query("CREATE TABLE tenant_telemetry_pregrant_intents (request_id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB");
      await conn.end();
      conn = undefined;
      await expect(upgrade(malformed)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
      conn = await mysql.createConnection(databaseUrl(base, malformed));
      const [badMarker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(badMarker[0]?.n)).toBe(0);
      await conn.end();
      conn = undefined;

      await create0042(drifted);
      await upgrade(drifted);
      conn = await mysql.createConnection(databaseUrl(base, drifted));
      await conn.query("ALTER TABLE tenant_telemetry_pregrant_intents ADD COLUMN leaked_locator VARCHAR(255) NULL");
      await conn.end();
      conn = undefined;
      await expect(upgrade(drifted)).rejects.toThrow();
      conn = await mysql.createConnection(databaseUrl(base, drifted));
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await expect(upgrade(drifted)).rejects.toThrow(`migration ${MIGRATION_NAME} failed`);
    } finally {
      await conn?.end();
      await cleanup(malformed);
      await cleanup(drifted);
    }
  }, 120_000);
});
