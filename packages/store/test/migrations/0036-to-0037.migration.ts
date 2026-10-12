import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { tenantTelemetryDispositionClaimTokenSha256 } from
  "../../src/tenant-telemetry-disposition.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0037_tenant_telemetry_disposition_grant_guard.sql";
// A fixed filename+byte chain proves that this suite starts with published 0001..0036,
// rather than silently exercising the fresh 0037 schema after an earlier SQL rewrite.
const FROZEN_0036_CHAIN_SHA256 =
  "129b2aefc4a31238ecff15e9ee4ffabbabbfc22b9e3196823248ab0649c1269f";
const REF_KEY = Buffer.alloc(32, 0x37);
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

describe("0036 -> 0037 telemetry grant-guard historical migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0037Dir: string;
  let through0037Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0037Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0037-"));
    through0037Dir = await mkdtemp(join(tmpdir(), "agent-service-through0037-"));
    const names = (await readdir(MIGRATIONS_DIR))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 36)
      .sort();
    expect(names).toHaveLength(36);
    expect(names[0]).toBe("0001_init.sql");
    expect(names.at(-1)).toBe("0036_tenant_telemetry_disposition.sql");
    const frozenChain = createHash("sha256");
    for (const name of names) {
      const bytes = await readFile(join(MIGRATIONS_DIR, name));
      frozenChain.update(name).update("\0")
        .update(createHash("sha256").update(bytes).digest("hex")).update("\n");
      await copyFile(join(MIGRATIONS_DIR, name), join(pre0037Dir, name));
      await copyFile(join(MIGRATIONS_DIR, name), join(through0037Dir, name));
    }
    expect(frozenChain.digest("hex")).toBe(FROZEN_0036_CHAIN_SHA256);
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0037Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0037Dir) await rm(pre0037Dir, { recursive: true, force: true });
    if (through0037Dir) await rm(through0037Dir, { recursive: true, force: true });
  });

  async function create0036(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0037Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: through0037Dir,
      tenantTelemetryRefKey: REF_KEY,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function guardNames(conn: Connection): Promise<string[]> {
    const [rows] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND BINARY trigger_name IN ('trg_tt_disposition_grant_bi',
            'trg_tt_disposition_grant_bi_v2') ORDER BY trigger_name`,
    );
    return rows.map((row) => String(row.name));
  }

  async function assertDormant(conn: Connection): Promise<void> {
    const [rows] = await conn.query<Row[]>(
      `SELECT (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
              (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_authorizations) AS authorizations,
              (SELECT COUNT(*) FROM tenant_telemetry_disposition_tombstone_acks) AS acks,
              (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts) AS receipts`,
    );
    expect(rows[0]).toMatchObject({ grants: 0, authorizations: 0, acks: 0, receipts: 0 });
    await expect(conn.query(
      `INSERT INTO tenant_telemetry_disposition_authorization_grants
         (disposition_operation_sha256,tenant_id,grant_receipt_sha256,claim_token_sha256,
          granted_at_db_ms,lease_until_db_ms,grant_json)
       VALUES (?,?,?,?,?,?,JSON_OBJECT('fixture',TRUE))`,
      [digest("0037:missing:operation"), "tenant-0037", digest("0037:missing:receipt"),
        tenantTelemetryDispositionClaimTokenSha256("fixture-token"), 1, 2],
    )).rejects.toThrow(/tenant telemetry disposition grant lacks (exact live claim|live executable source)/);
    const [after] = await conn.query<Row[]>(
      "SELECT COUNT(*) AS grants FROM tenant_telemetry_disposition_authorization_grants",
    );
    expect(Number(after[0]?.grants)).toBe(0);
  }

  it("upgrades frozen 0036 without granting authority and matches TS claim hash bytes", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0036(database);
      const before = await MysqlSessionStore.connect({
        url: databaseUrl(base, database), migrationsDir: pre0037Dir,
        tenantTelemetryRefKey: REF_KEY,
      });
      await before.createApiKey("tenant-0037", "key-0037", digest("0037:api-key"));
      await before.close();
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [beforeKeys] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id FROM api_keys ORDER BY tenant_id,key_id",
      );
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual(["trg_tt_disposition_grant_bi_v2"]);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(markers[0]?.n)).toBe(1);
      const [afterKeys] = await conn.query<Row[]>(
        "SELECT tenant_id,key_id FROM api_keys ORDER BY tenant_id,key_id",
      );
      expect(afterKeys).toEqual(beforeKeys);
      const [control] = await conn.query<Row[]>(
        "SELECT state,control_generation FROM tenant_telemetry_disposition_control",
      );
      expect(control).toEqual([{ state: "inactive", control_generation: 0 }]);
      for (const token of ["fixture-token", "A._:~-09", "z".repeat(128)]) {
        const [hash] = await conn.query<Row[]>(
          `SELECT SHA2(CONCAT('["tenant-telemetry-disposition-claim-token-v1","',?, '"]'),256)
             AS digest`, [token],
        );
        expect(hash[0]?.digest).toBe(tenantTelemetryDispositionClaimTokenSha256(token));
      }
      await assertDormant(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("resumes after v2 CREATE auto-commit and replays a missing 0037 marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0036(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const first = statements(migrationSql)[0];
      expect(first).toMatch(/^CREATE TRIGGER trg_tt_disposition_grant_bi_v2 /);
      await conn.query(first!);
      expect(await guardNames(conn)).toEqual([
        "trg_tt_disposition_grant_bi", "trg_tt_disposition_grant_bi_v2",
      ]);
      await assertDormant(conn);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual(["trg_tt_disposition_grant_bi_v2"]);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual(["trg_tt_disposition_grant_bi_v2"]);
      await assertDormant(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a tampered pre-existing v2 twin before removing the published guard", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0036(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TRIGGER trg_tt_disposition_grant_bi_v2 BEFORE INSERT
           ON tenant_telemetry_disposition_authorization_grants FOR EACH ROW
         BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='tampered'; END`,
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(
        "migration 0037_tenant_telemetry_disposition_grant_guard.sql failed at statement 1",
      );
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual([
        "trg_tt_disposition_grant_bi", "trg_tt_disposition_grant_bi_v2",
      ]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("does not mark a 0036 database with unsupported execution footprint upgraded", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0036(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      // Privileged test tamper only. Restore the exact 0036 guard before migration so the
      // failure is caused by the durable footprint, not by a missing trigger fingerprint.
      await conn.query("DROP TRIGGER trg_tt_disposition_job_bi");
      const operation = digest("0037:legacy-execution:operation");
      await conn.query(
        `INSERT INTO tenant_telemetry_disposition_jobs
           (disposition_operation_sha256,tenant_id,request_id,scope,protocol,domain,
            target_sha256,artifact_id_sha256,artifact_generation,inventory_sha256,
            write_operation_sha256,t3c_receipt_sha256,t3d_plan_receipt_sha256,
            t3d_plan_entry_receipt_sha256,phase,attempts,blocked_at_db_ms,
            blocked_reason_code,created_at_db_ms,updated_at_db_ms,job_json)
         VALUES (?,?,?,'tenant-telemetry-disposition-job-v1',
            'tenant-telemetry-disposition-v1','logs',?,?,?,?,?,?,?,?,
            'blocked',0,1000,'integrity_conflict',1000,1000,
            JSON_OBJECT('fixture',TRUE))`,
        [operation, "tenant-legacy-execution", "request-legacy-execution",
          digest("0037:legacy:target"), digest("0037:legacy:artifact"), 1,
          digest("0037:legacy:inventory"), digest("0037:legacy:write"),
          digest("0037:legacy:t3c"), digest("0037:legacy:t3d"),
          digest("0037:legacy:entry")],
      );
      const publishedSql = await readFile(join(
        MIGRATIONS_DIR, "0036_tenant_telemetry_disposition.sql",
      ), "utf8");
      const jobGuard = statements(publishedSql).find((statement) =>
        statement.startsWith("CREATE TRIGGER trg_tt_disposition_job_bi "));
      expect(jobGuard).toBeDefined();
      await conn.query(jobGuard!);
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(
        "migration 0037_tenant_telemetry_disposition_grant_guard.sql failed",
      );
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual(["trg_tt_disposition_grant_bi_v2"]);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]?.n)).toBe(0);
      const [jobs] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM tenant_telemetry_disposition_jobs",
      );
      expect(Number(jobs[0]?.n)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);

  it("rejects a missing 0036 predecessor marker after 0037 without replaying old DDL", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0036(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0036_tenant_telemetry_disposition.sql'",
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(
        "0037 grant guard marker is missing its 0036 predecessor",
      );
      conn = await mysql.createConnection(databaseUrl(base, database));
      expect(await guardNames(conn)).toEqual(["trg_tt_disposition_grant_bi_v2"]);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  }, 120_000);
});
