import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const FROZEN_0039_COMMIT = "53aece04d785f7d832312cf32f697b44979861db";
const MIGRATION_0040 = "0040_tenant_telemetry_source_accounting.sql";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
type Row = RowDataPacket;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:"
    || !new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_MIGRATION_TEST_URL must target loopback MySQL and a test/migration database");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function exactDatabaseName(): string {
  return `agent_service_migration_test_pre0040_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function processEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Never inherit .env/provider credentials or test-only destructive gates into the old process.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: process.env.CI,
    ...extra,
  };
}

async function runFixed(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 180_000,
): Promise<string> {
  try {
    const result = await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch {
    // A failed package manager or frozen process may include DSN/credential material in stderr.
    // Keep diagnostic output fixed and content-free in CI logs.
    throw new Error(`frozen 0039 fixture stage failed: ${file} ${args[0] ?? ""}`);
  }
}

async function rowDigest(conn: Connection, table: string, orderBy: string): Promise<string> {
  const allowed = new Set([
    "tenant_erasure_admissions", "tenant_content_inventory_receipts",
    "tenant_purge_plan_jobs", "tenant_purge_plan_entries", "tenant_purge_plan_receipts",
  ]);
  if (!allowed.has(table)) throw new Error("unsafe snapshot table");
  const [rows] = await conn.query<Row[]>(`SELECT * FROM \`${table}\` ORDER BY ${orderBy}`);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function assertFrozenRunnerStarts(cwd: string, url: string): Promise<void> {
  const child = spawn(process.execPath, ["apps/agent-runner/dist/main.js"], {
    cwd,
    env: processEnv({
      STORE: "mysql", MYSQL_URL: url,
      SECRETS_MASTER_KEY: "0".repeat(64),
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      RUNNER_PORT: "0",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let started = false;
  const collect = (chunk: Buffer) => {
    // Process logs are held in memory only; a failure must never print raw child output.
    output = (output + chunk.toString("utf8")).slice(-1024 * 1024);
    if (!started && output.includes('"code":"runner.lifecycle.started"')) {
      started = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("frozen 0039 runner could not launch")));
      child.once("close", () => resolve());
    });
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
  }
  if (!started) throw new Error("frozen 0039 runner did not start on 0039 schema");
}

describe("frozen 0039 worker terminal -> 0040 real MySQL upgrade", () => {
  let admin: Connection;
  let base: URL;
  let archiveRoot: string;
  let oldCheckout: string;
  const databases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen-0039-"));
    oldCheckout = join(archiveRoot, "checkout");
    await mkdir(oldCheckout);
    const archive = join(archiveRoot, "frozen-0039.tar");
    const resolvedCommit = (await runFixed(
      "git", ["rev-parse", FROZEN_0039_COMMIT], ROOT, processEnv(), 10_000,
    )).trim();
    expect(resolvedCommit).toBe(FROZEN_0039_COMMIT);
    await runFixed("git", ["archive", "--format=tar", `--output=${archive}`, FROZEN_0039_COMMIT],
      ROOT, processEnv(), 30_000);
    await runFixed("tar", ["-xf", archive, "-C", oldCheckout], ROOT, processEnv(), 30_000);
    const driverDir = join(oldCheckout, "packages/store/test/migrations/fixtures");
    await mkdir(driverDir, { recursive: true });
    await copyFile(join(HERE, "fixtures/pre0040-old-plan-driver.ts"),
      join(driverDir, "pre0040-old-plan-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0040-old-fingerprint-probe.ts"),
      join(driverDir, "pre0040-old-fingerprint-probe.ts"));
    await runFixed("pnpm", ["install", "--offline", "--frozen-lockfile"], oldCheckout,
      processEnv(), 180_000);
    await runFixed("pnpm", ["build"], oldCheckout, processEnv(), 180_000);
  }, 420_000);

  afterAll(async () => {
    if (admin) {
      for (const database of databases) {
        if (!/^agent_service_migration_test_pre0040_[0-9]+_[0-9a-f]{8}$/.test(database)) {
          throw new Error("unsafe test database cleanup target");
        }
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });

  it("preserves a true old-worker 33-domain terminal and leaves missing 0040 proof unknown", async () => {
    const database = exactDatabaseName();
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
      [database],
    );
    expect(existing).toHaveLength(0);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);
    const stdout = await runFixed(process.execPath,
      ["--import", "tsx", "packages/store/test/migrations/fixtures/pre0040-old-plan-driver.ts"],
      oldCheckout,
      processEnv({ MYSQL_URL: url }), 180_000);
    const oldResult = JSON.parse(stdout) as {
      sourceCommit: string;
      requestId: string;
      tenantId: string;
      planReceiptSha256: string;
      planEntryRootSha256: string;
      entries: number;
      evidenceSha256: string;
    };
    expect(oldResult.sourceCommit).toBe(FROZEN_0039_COMMIT);
    expect(oldResult.entries).toBe(33);
    expect(oldResult.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    await assertFrozenRunnerStarts(oldCheckout, url);
    const conn = await mysql.createConnection(url);
    const before = new Map<string, string>();
    try {
      const [markers] = await conn.query<Row[]>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(markers).toHaveLength(39);
      expect(markers.at(-1)?.name).toBe("0039_tenant_telemetry_owner_closure.sql");
      const [oldJob] = await conn.query<Row[]>(
        "SELECT phase,aggregate_receipt_sha256 FROM tenant_purge_plan_jobs WHERE request_id=?",
        [oldResult.requestId],
      );
      expect(oldJob).toHaveLength(1);
      expect(oldJob[0]?.phase).toBe("plan_sealed");
      expect(oldJob[0]?.aggregate_receipt_sha256).toBe(oldResult.planReceiptSha256);
      for (const [table, orderBy] of [
        ["tenant_erasure_admissions", "request_id"],
        ["tenant_content_inventory_receipts", "request_id"],
        ["tenant_purge_plan_jobs", "request_id"],
        ["tenant_purge_plan_entries", "request_id,domain"],
        ["tenant_purge_plan_receipts", "request_id"],
      ] as const) {
        before.set(table, await rowDigest(conn, table, orderBy));
      }
    } finally {
      await conn.end();
    }

    const upgraded = await MysqlSessionStore.connect({ url });
    try {
      const plan = await upgraded.getTenantPurgePlanReceipt(
        oldResult.tenantId, oldResult.requestId,
      );
      expect(plan?.receiptSha256).toBe(oldResult.planReceiptSha256);
      expect(plan?.planEntryRootSha256).toBe(oldResult.planEntryRootSha256);
      expect(await upgraded.getTenantPurgePlanEntries(
        oldResult.tenantId, oldResult.requestId, 1,
      )).toHaveLength(33);
      expect(await upgraded.getTenantTelemetrySourceAccountingReceipt(
        oldResult.tenantId, oldResult.requestId,
      )).toBeNull();
      expect(await upgraded.getTenantTelemetrySourceAccountingEntries(
        oldResult.tenantId, oldResult.requestId,
      )).toEqual([]);
      const foreignTenant = `foreign-${oldResult.tenantId}`;
      expect(await upgraded.getTenantPurgePlanReceipt(
        foreignTenant, oldResult.requestId,
      )).toBeNull();
      expect(await upgraded.getTenantTelemetrySourceAccountingReceipt(
        foreignTenant, oldResult.requestId,
      )).toBeNull();
    } finally {
      await upgraded.close();
    }

    const afterConn = await mysql.createConnection(url);
    try {
      const [markers] = await afterConn.query<Row[]>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      expect(markers).toHaveLength(40);
      expect(markers.at(-1)?.name).toBe(MIGRATION_0040);
      for (const [table, orderBy] of [
        ["tenant_erasure_admissions", "request_id"],
        ["tenant_content_inventory_receipts", "request_id"],
        ["tenant_purge_plan_jobs", "request_id"],
        ["tenant_purge_plan_entries", "request_id,domain"],
        ["tenant_purge_plan_receipts", "request_id"],
      ] as const) {
        expect(await rowDigest(afterConn, table, orderBy)).toBe(before.get(table));
      }
      const [newRows] = await afterConn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_receipts) AS receipts`,
      );
      expect(newRows[0]).toMatchObject({ entries: 0, receipts: 0 });
    } finally {
      await afterConn.end();
    }

    const oldStoreProbe = await runFixed(process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0040-old-fingerprint-probe.ts",
    ], oldCheckout, processEnv({ MYSQL_URL: url }), 15_000);
    expect(oldStoreProbe).toBe("frozen-0039-fingerprint-rejected");

    // The frozen runner bundle, not a copied fingerprint SQL statement, must reject the new
    // trigger/schema shape before binding its listener. A bounded child prevents a false pass.
    const frozenStartup = spawnSync(process.execPath, ["apps/agent-runner/dist/main.js"], {
      cwd: oldCheckout,
      env: processEnv({
        STORE: "mysql", MYSQL_URL: url,
        SECRETS_MASTER_KEY: "0".repeat(64),
        BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        RUNNER_PORT: "0",
      }),
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    // A timeout would mean the old runner reached a listener and must fail this proof.
    expect(frozenStartup.error).toBeUndefined();
    expect(frozenStartup.signal).toBeNull();
    expect(frozenStartup.status).not.toBe(0);
    // Keep child output out of Vitest assertion diagnostics: a database URL may carry credentials.
    expect(`${frozenStartup.stdout}${frozenStartup.stderr}`
      .includes('"code":"runner.process.start_failed"')).toBe(true);
  }, 240_000);
});
