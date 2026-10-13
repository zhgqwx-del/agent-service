import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
  let url: URL;
  let database: string;
  try {
    url = new URL(raw);
    database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    throw new Error("MYSQL_MIGRATION_TEST_URL must be a valid disposable MySQL test URL");
  }
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

function processEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Never inherit .env/provider credentials or test-only destructive gates into the old process.
  return {
    PATH: process.env.PATH,
    HOME: temp,
    TMPDIR: temp,
    CI: "1",
    NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0",
    ...extra,
  };
}

async function copyInstalledDependencies(oldCheckout: string): Promise<void> {
  // The frozen revision has the same lockfile and dependency declarations as this checkout.
  // Reuse its already-installed packages without giving old code access to the real HOME,
  // pnpm cache, network, or current source packages through workspace symlinks.
  const frozenLock = await readFile(join(oldCheckout, "pnpm-lock.yaml"));
  const currentLock = await readFile(join(ROOT, "pnpm-lock.yaml"));
  if (!frozenLock.equals(currentLock)) throw new Error("frozen 0039 dependency lock changed");
  for (const manifest of [
    "pnpm-workspace.yaml", "packages/core/package.json", "packages/protocol/package.json",
    "packages/providers/package.json", "packages/sdk/package.json", "packages/store/package.json",
    "packages/testkit/package.json", "apps/agent-router/package.json",
    "apps/agent-runner/package.json",
  ]) {
    const frozen = await readFile(join(oldCheckout, manifest));
    const current = await readFile(join(ROOT, manifest));
    if (!frozen.equals(current)) throw new Error(`frozen 0039 dependency manifest changed: ${manifest}`);
  }
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(oldCheckout, "node_modules"), options);
  for (const project of [
    "packages/core", "packages/providers", "packages/protocol", "packages/sdk",
    "packages/store", "apps/agent-router", "apps/agent-runner",
  ]) {
    await cp(join(ROOT, project, "node_modules"), join(oldCheckout, project, "node_modules"),
      options);
  }
  const virtualStore = await lstat(join(oldCheckout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) {
    throw new Error("frozen 0039 dependency store is not self-contained");
  }
  const realCheckout = await realpath(oldCheckout);
  let workspaceLinks = 0;
  for (const project of [
    "", "node_modules/.pnpm", "packages/core", "packages/providers", "packages/protocol",
    "packages/sdk", "packages/store", "apps/agent-router", "apps/agent-runner",
  ]) {
    const scope = join(oldCheckout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      const link = join(scope, name);
      const target = await readlink(link);
      const resolved = await realpath(link);
      if (target.startsWith("/") || !resolved.startsWith(realCheckout + sep)) {
        throw new Error("frozen 0039 workspace dependency points outside its archive");
      }
      workspaceLinks += 1;
    }
  }
  if (workspaceLinks === 0) throw new Error("frozen 0039 workspace package links are missing");
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

async function assertFrozenRunnerStarts(cwd: string, temp: string, url: string): Promise<void> {
  const child = spawn(process.execPath, ["apps/agent-runner/dist/main.js"], {
    cwd,
    env: processEnv(temp, {
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
      "git", ["rev-parse", FROZEN_0039_COMMIT], ROOT, processEnv(archiveRoot), 10_000,
    )).trim();
    expect(resolvedCommit).toBe(FROZEN_0039_COMMIT);
    await runFixed("git", ["archive", "--format=tar", `--output=${archive}`, FROZEN_0039_COMMIT],
      ROOT, processEnv(archiveRoot), 30_000);
    await runFixed("tar", ["-xf", archive, "-C", oldCheckout], ROOT,
      processEnv(archiveRoot), 30_000);
    const driverDir = join(oldCheckout, "packages/store/test/migrations/fixtures");
    await mkdir(driverDir, { recursive: true });
    await copyFile(join(HERE, "fixtures/pre0040-old-plan-driver.ts"),
      join(driverDir, "pre0040-old-plan-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0040-old-fingerprint-probe.ts"),
      join(driverDir, "pre0040-old-fingerprint-probe.ts"));
    await copyInstalledDependencies(oldCheckout);
    await runFixed("pnpm", ["build"], oldCheckout, processEnv(archiveRoot), 180_000);
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
      processEnv(archiveRoot, { MYSQL_URL: url }), 180_000);
    let oldResult: {
      sourceCommit: string;
      requestId: string;
      tenantId: string;
      planReceiptSha256: string;
      planEntryRootSha256: string;
      entries: number;
      evidenceSha256: string;
    };
    try {
      oldResult = JSON.parse(stdout) as typeof oldResult;
    } catch {
      throw new Error("frozen 0039 fixture returned an invalid result");
    }
    expect(oldResult.sourceCommit === FROZEN_0039_COMMIT).toBe(true);
    expect(oldResult.entries === 33).toBe(true);
    expect(typeof oldResult.evidenceSha256 === "string"
      && /^[0-9a-f]{64}$/.test(oldResult.evidenceSha256)).toBe(true);
    await assertFrozenRunnerStarts(oldCheckout, archiveRoot, url);
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
      expect(await upgraded.getTenantTelemetryPlanArtifactTargetReceipt(
        oldResult.tenantId, oldResult.requestId,
      )).toBeNull();
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
      // The frozen process owns the exact 0039 pre-state; the current store applies every
      // migration in this checkout, including migrations added after this fixture was written.
      const currentMigrations = (await readdir(join(ROOT, "packages/store/migrations")))
        .filter((name) => name.endsWith(".sql")).sort();
      expect(markers.map((row) => row.name)).toEqual(currentMigrations);
      expect(markers.some((row) => row.name === MIGRATION_0040)).toBe(true);
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
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 15_000);
    expect(oldStoreProbe === "frozen-0039-fingerprint-rejected").toBe(true);

    // The frozen runner bundle, not a copied fingerprint SQL statement, must reject the new
    // trigger/schema shape before binding its listener. A bounded child prevents a false pass.
    const frozenStartup = spawnSync(process.execPath, ["apps/agent-runner/dist/main.js"], {
      cwd: oldCheckout,
      env: processEnv(archiveRoot, {
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
