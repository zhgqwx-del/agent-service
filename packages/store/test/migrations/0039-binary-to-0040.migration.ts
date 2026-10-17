import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { assertNo0054FrozenLegacyFootprint, captureFrozenLegacyColumns } from "./fixtures/frozen-legacy-row-snapshot.js";
import { installFrozenDependencies } from "./fixtures/frozen-dependencies.js";

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
  await installFrozenDependencies(ROOT, oldCheckout);
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

const FIXTURE_STAGES = [
  "resolve-commit", "archive", "extract", "old-build", "old-worker",
  "target-fingerprint", "full-tail-fingerprint",
] as const;
type FixtureStage = typeof FIXTURE_STAGES[number];
const FIXTURE_SIGNALS = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM",
  "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG",
  "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR",
  "SIGSYS", "SIGINFO",
]);
const FIXTURE_SPAWN_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EAGAIN", "ENOMEM", "EMFILE", "ENFILE", "ENOSPC",
  "EIO", "ENOEXEC", "ENAMETOOLONG", "ENOTDIR",
]);

function ownFailureData(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function fixedFailure(stage: FixtureStage, error: unknown, elapsed: unknown): Error {
  if (!FIXTURE_STAGES.includes(stage)) throw new Error("invalid frozen 0039 fixture stage");
  const code = ownFailureData(error, "code");
  const rawSignal = ownFailureData(error, "signal");
  const signal = typeof rawSignal === "string" && FIXTURE_SIGNALS.has(rawSignal)
    ? rawSignal : null;
  const exitStatus = typeof code === "number" && Number.isSafeInteger(code)
    && code >= 0 && code <= 255 ? code : null;
  const kind = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "max-buffer"
    : typeof code === "string" && FIXTURE_SPAWN_CODES.has(code) ? `spawn-${code}`
    : signal !== null ? "signal"
    : exitStatus !== null ? "exit"
    : ownFailureData(error, "killed") === true ? "killed"
    : "unknown";
  const elapsedMs = typeof elapsed === "number" && Number.isSafeInteger(elapsed)
    && elapsed >= 0 ? elapsed : null;
  // Never copy error.message/stack/cause, command, arguments, stdout, stderr or environment.
  // A killed child is not proof of a timeout; only report observed closed metadata.
  return new Error(`frozen 0039 fixture stage failed: ${stage} ${JSON.stringify({
    exitStatus, signal, kind, elapsedMs,
  })}`);
}

async function runFixed(
  stage: FixtureStage,
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 180_000,
): Promise<string> {
  const startedAt = performance.now();
  try {
    const result = await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    throw fixedFailure(stage, error, Math.floor(performance.now() - startedAt));
  }
}

async function rowDigest(
  conn: Connection, table: string, orderBy: string, columns: readonly string[],
): Promise<string> {
  const allowed = new Set([
    "tenant_erasure_admissions", "tenant_content_inventory_receipts",
    "tenant_purge_plan_jobs", "tenant_purge_plan_entries", "tenant_purge_plan_receipts",
  ]);
  if (!allowed.has(table)) throw new Error("unsafe snapshot table");
  const projection = columns.map((column) => `\`${column}\``).join(",");
  const [rows] = await conn.query<Row[]>(`SELECT ${projection} FROM \`${table}\` ORDER BY ${orderBy}`);
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
  let targetMigrationsDir: string;
  let targetMigrations: string[];
  const databases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen-0039-"));
    targetMigrationsDir = join(archiveRoot, "target-migrations");
    await mkdir(targetMigrationsDir);
    targetMigrations = (await readdir(join(ROOT, "packages/store/migrations")))
      .filter((name) => name.endsWith(".sql") && name <= MIGRATION_0040).sort();
    expect(targetMigrations.at(-1)).toBe(MIGRATION_0040);
    for (const name of targetMigrations) {
      await copyFile(join(ROOT, "packages/store/migrations", name), join(targetMigrationsDir, name));
    }
    oldCheckout = join(archiveRoot, "checkout");
    await mkdir(oldCheckout);
    const archive = join(archiveRoot, "frozen-0039.tar");
    const resolvedCommit = (await runFixed(
      "resolve-commit", "git", ["rev-parse", FROZEN_0039_COMMIT], ROOT,
      processEnv(archiveRoot), 10_000,
    )).trim();
    expect(resolvedCommit).toBe(FROZEN_0039_COMMIT);
    await runFixed("archive", "git", [
      "archive", "--format=tar", `--output=${archive}`, FROZEN_0039_COMMIT,
    ], ROOT, processEnv(archiveRoot), 30_000);
    await runFixed("extract", "tar", ["-xf", archive, "-C", oldCheckout], ROOT,
      processEnv(archiveRoot), 30_000);
    const driverDir = join(oldCheckout, "packages/store/test/migrations/fixtures");
    await mkdir(driverDir, { recursive: true });
    await copyFile(join(HERE, "fixtures/pre0040-old-plan-driver.ts"),
      join(driverDir, "pre0040-old-plan-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0040-old-fingerprint-probe.ts"),
      join(driverDir, "pre0040-old-fingerprint-probe.ts"));
    await copyInstalledDependencies(oldCheckout);
    await runFixed("old-build", "pnpm", ["build"], oldCheckout, processEnv(archiveRoot), 180_000);
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
    const stdout = await runFixed("old-worker", process.execPath,
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
    const frozenColumns = new Map<string, readonly string[]>();
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
        const columns = await captureFrozenLegacyColumns(conn, table);
        frozenColumns.set(table, columns);
        before.set(table, await rowDigest(conn, table, orderBy, columns));
      }
    } finally {
      await conn.end();
    }

    // Preserve the original target-specific old-binary rejection before a later schema
    // change can become the first rejected fingerprint. Only current SQL is used here.
    const targetStore = await MysqlSessionStore.connect({ url, migrationsDir: targetMigrationsDir });
    await targetStore.close();
    const targetConn = await mysql.createConnection(url);
    try {
      const [markers] = await targetConn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => row.name)).toEqual(targetMigrations);
      expect(markers.some((row) => String(row.name).startsWith("0053_"))).toBe(false);
    } finally {
      await targetConn.end();
    }
    const targetProbe = await runFixed("target-fingerprint", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0040-old-fingerprint-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url,
      EXPECT_FINGERPRINT_STAGE: "target" }), 15_000);
    expect(targetProbe).toBe("frozen-0039-fingerprint-rejected");

    const upgraded = await MysqlSessionStore.connect({
      url, migrationsDir: join(ROOT, "packages/store/migrations"),
    });
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
        const columns = frozenColumns.get(table);
        if (!columns) throw new Error(`frozen snapshot columns missing: ${table}`);
        expect(await rowDigest(afterConn, table, orderBy, columns),
          `frozen historical rows changed: ${table}`).toBe(before.get(table));
      }
      await assertNo0054FrozenLegacyFootprint(afterConn);
      const [newRows] = await afterConn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_source_accounting_receipts) AS receipts`,
      );
      expect(newRows[0]).toMatchObject({ entries: 0, receipts: 0 });
    } finally {
      await afterConn.end();
    }

    const oldStoreProbe = await runFixed("full-tail-fingerprint", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0040-old-fingerprint-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url,
      EXPECT_FINGERPRINT_STAGE: "full-tail" }), 15_000);
    // 0053 adds a subject_lifecycle column/CHECK, so genuine old code rejects its
    // strict 0035 schema fingerprint before reaching the already-proven 0039 guard.
    expect(oldStoreProbe).toBe("frozen-0039-0035-fingerprint-rejected");

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

describe("frozen 0039 content-free subprocess failure diagnostics", () => {
  it("does not retain credential-shaped child output or exception content", () => {
    const sensitive = "mysql://fixture-user:fixture-password@127.0.0.1/test?api_key=fixture-key";
    const error = Object.assign(new Error(sensitive), {
      code: 1, signal: null, stdout: sensitive, stderr: sensitive, cmd: sensitive,
      args: [sensitive], cause: new Error(sensitive), env: { API_KEY: sensitive },
    });
    const diagnostic = fixedFailure("old-build", error, 17);
    expect(diagnostic.message).toBe('frozen 0039 fixture stage failed: old-build '
      + '{"exitStatus":1,"signal":null,"kind":"exit","elapsedMs":17}');
    expect(diagnostic.stack?.includes(sensitive)).toBe(false);
    expect(Object.hasOwn(diagnostic, "cause")).toBe(false);
  });

  it("prioritizes the actual max-buffer code over kill or signal observations", () => {
    expect(fixedFailure("old-build", {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGTERM", killed: true,
    }, 12).message).toBe('frozen 0039 fixture stage failed: old-build '
      + '{"exitStatus":null,"signal":"SIGTERM","kind":"max-buffer","elapsedMs":12}');
  });

  it("does not relabel a killed child as a timeout", () => {
    expect(fixedFailure("old-build", { killed: true }, 12).message).toBe(
      'frozen 0039 fixture stage failed: old-build '
      + '{"exitStatus":null,"signal":null,"kind":"killed","elapsedMs":12}',
    );
  });

  it("retains only allowlisted spawn and signal classifications", () => {
    expect(fixedFailure("old-build", { code: "ENOENT" }, 12).message).toContain(
      '"exitStatus":null,"signal":null,"kind":"spawn-ENOENT"',
    );
    expect(fixedFailure("old-build", { signal: "SIGKILL" }, 12).message).toContain(
      '"exitStatus":null,"signal":"SIGKILL","kind":"signal"',
    );
    expect(fixedFailure("old-build", {
      code: "credential-shaped-unknown-code", signal: "credential-shaped-unknown-signal",
    }, 12).message).toBe('frozen 0039 fixture stage failed: old-build '
      + '{"exitStatus":null,"signal":null,"kind":"unknown","elapsedMs":12}');
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "12"])(
    "does not serialize unsafe elapsed observation %s", (elapsed) => {
      expect(fixedFailure("old-build", { code: 1 }, elapsed).message).toContain('"elapsedMs":null');
    },
  );

  it.each([NaN, Infinity, -1, 1.5, 256, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "does not treat unsafe exit observation %s as an exit status", (code) => {
      expect(fixedFailure("old-build", { code }, 12).message).toContain(
        '"exitStatus":null,"signal":null,"kind":"unknown"',
      );
    },
  );

  it("does not invoke error accessors or inherit diagnostic fields", () => {
    let reads = 0;
    const error = Object.create({ code: 1, signal: "SIGTERM", killed: true }) as object;
    for (const key of ["code", "signal", "killed", "message", "stdout", "stderr"]) {
      Object.defineProperty(error, key, { get() { reads += 1; throw new Error("do not read"); } });
    }
    expect(fixedFailure("old-build", error, 12).message).toContain(
      '"exitStatus":null,"signal":null,"kind":"unknown"',
    );
    expect(reads).toBe(0);
    expect(fixedFailure("old-build", Object.create({ code: 1 }), 12).message).toContain(
      '"exitStatus":null,"signal":null,"kind":"unknown"',
    );
  });
});
