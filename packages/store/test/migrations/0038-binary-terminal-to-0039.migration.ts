import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

// A published pre-0039 revision, not a copy of the current implementation. CI checkout must
// retain history so git archive can obtain exactly these old source bytes without network access.
const FROZEN_0038_COMMIT = "eb35256c93a3adba138670f4feb95c40bb72b34f";
const OLD_TEST = "packages/store/test/mysql-tenant-database-purge.test.ts";
const OLD_SUCCESS_NAME =
  "atomically deletes local database targets, retains billing, and replays concurrently";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = resolve(ROOT, "packages/store/migrations");
type Row = RowDataPacket;

function safeBase(raw: string): URL {
  let url: URL;
  let database: string;
  try {
    url = new URL(raw);
    database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    throw new Error("historical T3f fixture requires a valid disposable MySQL test URL");
  }
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("historical T3f fixture requires a loopback disposable MySQL test database");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function replaceOnce(source: string, before: string, after: string): string {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) {
    throw new Error("frozen 0038 test harness no longer matches the pinned revision");
  }
  return source.slice(0, at) + after + source.slice(at + before.length);
}

function childEnvironment(temp: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Never inherit .env, AWS/provider credentials, arbitrary hooks, or an operator's settings.
  return {
    PATH: process.env.PATH ?? "",
    HOME: temp,
    TMPDIR: temp,
    CI: "1",
    NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 0x11).toString("hex"), // fixed test-only key
    ...overrides,
  };
}

async function run(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    // Drain, but never echo child output: MySQL test URLs may carry credentials.
    child.stdout?.resume();
    child.stderr?.resume();
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectRun(new Error(`${label} could not start`));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (timedOut) rejectRun(new Error(`${label} timed out`));
        else if (code === 0) resolveRun();
        else rejectRun(new Error(`${label} failed with exit ${code ?? "signal"}`));
      }
    });
  });
}

async function frozenWorkspace(directory: string, temp: string): Promise<void> {
  const env = childEnvironment(temp);
  await run("pinned 0038 ancestry", "git", [
    "merge-base", "--is-ancestor", FROZEN_0038_COMMIT, "HEAD",
  ], ROOT, env, 15_000);
  const archive = join(temp, "frozen-0038.tar");
  await run("pinned 0038 archive", "git", [
    "archive", "--format=tar", `--output=${archive}`, FROZEN_0038_COMMIT,
  ], ROOT, env, 30_000);
  await run("pinned 0038 extraction", "tar", ["-xf", archive, "-C", directory],
    ROOT, env, 30_000);
  await rm(archive);

  const frozenManifests = [
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json",
    "packages/core/package.json", "packages/protocol/package.json",
    "packages/providers/package.json", "packages/sdk/package.json",
    "packages/store/package.json", "packages/testkit/package.json",
    "apps/agent-router/package.json", "apps/agent-runner/package.json",
  ];
  for (const manifest of frozenManifests) {
    const oldBytes = await readFile(join(directory, manifest));
    const currentBytes = await readFile(join(ROOT, manifest));
    if (!oldBytes.equals(currentBytes)) {
      throw new Error(`frozen 0038 dependency manifest ${manifest} has changed`);
    }
  }
  const oldPackage = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  if (oldPackage.packageManager !== "pnpm@12.5.1") {
    throw new Error("frozen 0038 dependencies no longer match the installed 0039 workspace");
  }

  // The frozen success test already drives the real 0038 MysqlSessionStore through T1, T3a-e,
  // then executes and replays a terminal T3f. Only its disposable test harness is adapted to
  // preserve one exact database for the subsequent upgrade assertions; product code is untouched.
  const file = join(directory, OLD_TEST);
  let source = await readFile(file, "utf8");
  const oldName = "database = `agent_service_database_purge_test_${process.pid}_${randomUUID()\n"
    + "        .replaceAll(\"-\", \"\").slice(0, 8)}`;";
  source = replaceOnce(source, oldName,
    `database = process.env.AGENT_SERVICE_HISTORICAL_DB ?? \`agent_service_database_purge_test_\${process.pid}_\${randomUUID().replaceAll("-", "").slice(0, 8)}\`;`);
  const oldCreate = "await admin!.query(`CREATE DATABASE \\`${database}\\` CHARACTER SET utf8mb4`);";
  source = replaceOnce(source, oldCreate,
    `if (!process.env.AGENT_SERVICE_HISTORICAL_DB) ${oldCreate}`);
  const oldCleanup = "if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \\`${database}\\``);";
  source = replaceOnce(source, oldCleanup,
    `if (process.env.AGENT_SERVICE_HISTORICAL_KEEP_DB !== "1" && admin && database) `
      + "await admin.query(`DROP DATABASE IF EXISTS \\`${database}\\``);");
  await writeFile(file, source);

  // The same old store must open cleanly before the upgrade and reject the new strict trigger
  // fingerprint afterward. The script deliberately reports only fixed, content-free outcomes.
  await writeFile(join(directory, "scripts/historical-t3f-startup.mjs"), `
import { MysqlSessionStore } from "../packages/store/src/index.ts";
const expectedRejection = process.env.AGENT_SERVICE_HISTORICAL_EXPECT_REJECTION === "1";
let rejected = false;
try {
  const store = await MysqlSessionStore.connect({
    url: process.env.MYSQL_TEST_URL,
    migrationMode: "verify",
  });
  await store.close();
} catch (error) {
  if (!expectedRejection || !String(error).includes(
    "0038 tenant telemetry membership fingerprint verification failed",
  )) throw new Error("frozen 0038 startup failed for an unexpected reason");
  rejected = true;
}
if (rejected !== expectedRejection) {
  throw new Error("frozen 0038 startup did not enforce the expected schema fingerprint");
}
`);

  // Current and frozen predecessor migrations must be byte-identical. This avoids proving an
  // upgrade against a recreated/fabricated predecessor schema.
  const oldMigrationNames = await readdir(join(directory, "packages/store/migrations"));
  const currentMigrationNames = await readdir(MIGRATIONS);
  for (let index = 1; index <= 38; index += 1) {
    const prefix = String(index).padStart(4, "0") + "_";
    const current = currentMigrationNames.find((name) => name.startsWith(prefix));
    if (!current || !oldMigrationNames.includes(current)) {
      throw new Error("frozen predecessor migration chain is incomplete");
    }
    const oldBytes = await readFile(join(directory, "packages/store/migrations", current));
    const currentBytes = await readFile(join(MIGRATIONS, current));
    if (!oldBytes.equals(currentBytes)) {
      throw new Error(`frozen 0038 predecessor migration ${prefix} has changed`);
    }
  }
}

async function copyInstalledDependencies(directory: string): Promise<void> {
  // CI installs the current lockfile normally. Both lockfile bytes and packageManager are checked
  // above, so copy only installed dependencies into the archived tree without network or install
  // scripts. Preserve relative workspace symlinks: frozen source imports must resolve within that
  // archived tree, never through current source packages.
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(directory, "node_modules"), options);
  for (const project of [
    "packages/core", "packages/providers", "packages/protocol", "packages/sdk",
    "packages/store", "apps/agent-router", "apps/agent-runner",
  ]) {
    await cp(join(ROOT, project, "node_modules"), join(directory, project, "node_modules"),
      options);
  }
  const virtualStore = await lstat(join(directory, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) {
    throw new Error("frozen 0038 dependency store is not self-contained");
  }
  const realDirectory = await realpath(directory);
  let workspaceLinks = 0;
  for (const project of [
    "", "node_modules/.pnpm", "packages/core", "packages/providers",
    "packages/protocol", "packages/sdk",
    "packages/store", "apps/agent-router", "apps/agent-runner",
  ]) {
    const scopeDir = join(directory, project, "node_modules/@agent-service");
    const names = await readdir(scopeDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      const link = join(scopeDir, name);
      const target = await readlink(link);
      const resolved = await realpath(link);
      if (target.startsWith("/") || !resolved.startsWith(realDirectory + sep)) {
        throw new Error("frozen 0038 workspace dependency points outside its archive");
      }
      workspaceLinks += 1;
    }
  }
  if (workspaceLinks === 0) {
    throw new Error("frozen 0038 workspace package links are missing");
  }
}

describe("genuine frozen-0038 T3f terminal -> 0039 historical upgrade", () => {
  it("preserves an old-code terminal as unknown and makes old-code startup fail closed", async () => {
    const base = safeBase(BASE_URL);
    const database = `agent_service_database_purge_test_old_${process.pid}_${randomUUID()
      .replaceAll("-", "").slice(0, 8)}`;
    expect(database).toMatch(/^agent_service_database_purge_test_old_[a-zA-Z0-9_]+$/);
    expect(database.length).toBeLessThanOrEqual(64);
    const url = databaseUrl(base, database);
    const temp = await mkdtemp(join(tmpdir(), "agent-service-pre0039-binary-"));
    const oldRoot = join(temp, "old");
    const through0039 = join(temp, "through0039");
    let admin: Connection | undefined;
    let conn: Connection | undefined;
    let fixtureMayOwnDatabase = false;
    try {
      admin = await mysql.createConnection(databaseUrl(base, "mysql"));
      const [existing] = await admin.query<Row[]>(
        "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?",
        [database],
      );
      expect(existing).toHaveLength(0);
      await mkdir(oldRoot);
      await mkdir(through0039);
      await frozenWorkspace(oldRoot, temp);
      const migrationNames = (await readdir(MIGRATIONS))
        .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 39)
        .sort();
      expect(migrationNames).toHaveLength(39);
      for (const name of migrationNames) {
        await copyFile(join(MIGRATIONS, name), join(through0039, name));
      }

      await copyInstalledDependencies(oldRoot);
      // Ownership begins only after our exact CREATE succeeds. If another process wins the
      // database-name race, CREATE fails and finally must never delete that process's schema.
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      fixtureMayOwnDatabase = true;
      const oldEnv = childEnvironment(temp, {
        MYSQL_TEST_URL: base.toString(),
        AGENT_SERVICE_INTEGRATION: "1",
        AGENT_SERVICE_HISTORICAL_DB: database,
        AGENT_SERVICE_HISTORICAL_KEEP_DB: "1",
      });
      const oldReport = join(temp, "old-test-report.json");
      await run("frozen 0038 real T3f terminal test", process.execPath, [
        "node_modules/vitest/vitest.mjs", "run", OLD_TEST,
        "--config", "vitest.config.ts", "--testNamePattern", OLD_SUCCESS_NAME,
        "--reporter=json", `--outputFile.json=${oldReport}`,
      ], oldRoot, oldEnv, 240_000);
      const report = JSON.parse(await readFile(oldReport, "utf8")) as {
        testResults?: { assertionResults?: { fullName?: string; status?: string }[] }[];
      };
      const assertions = report.testResults?.flatMap((test) => test.assertionResults ?? []) ?? [];
      expect(assertions.filter((assertion) => assertion.status === "passed"
        && assertion.fullName?.includes(OLD_SUCCESS_NAME))).toHaveLength(1);
      expect(assertions.filter((assertion) => assertion.status === "failed")).toHaveLength(0);

      conn = await mysql.createConnection(url);
      const [before] = await conn.query<Row[]>(
        `SELECT r.request_id,r.tenant_id,r.receipt_sha256,
                r.local_database_purge_complete,r.session_content_deleted,
                r.all_domains_complete,r.content_purge_executed,
                j.phase,j.terminal_receipt_sha256,
                (SELECT COUNT(*) FROM tenant_purge_session_grave_markers) AS graves,
                (SELECT COUNT(*) FROM sessions) AS sessions,
                (SELECT COUNT(*) FROM billing_usage_facts) AS billing
           FROM tenant_database_purge_receipts r
           JOIN tenant_database_purge_jobs j ON j.request_id=r.request_id`,
      );
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        phase: "database_purged", graves: 1, sessions: 0, billing: 1,
        local_database_purge_complete: 1, session_content_deleted: 1,
        all_domains_complete: 0, content_purge_executed: 0,
      });
      expect(before[0]?.terminal_receipt_sha256).toBe(before[0]?.receipt_sha256);
      const [oldMarker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='0038_tenant_telemetry_artifact_membership.sql'",
      );
      expect(Number(oldMarker[0]?.n)).toBe(1);
      const [newMarkerBefore] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='0039_tenant_telemetry_owner_closure.sql'",
      );
      expect(Number(newMarkerBefore[0]?.n)).toBe(0);
      await conn.end();
      conn = undefined;

      await run("pre-upgrade frozen 0038 verify-only startup", process.execPath, [
        "--import", "tsx", "scripts/historical-t3f-startup.mjs",
      ], oldRoot, childEnvironment(temp, { MYSQL_TEST_URL: url }), 60_000);
      const upgraded = await MysqlSessionStore.connect({ url, migrationsDir: through0039 });
      const receipt = await upgraded.getTenantDatabasePurgeReceipt(
        String(before[0]?.tenant_id), String(before[0]?.request_id),
      );
      expect(receipt?.receiptSha256).toBe(before[0]?.receipt_sha256);
      expect(await upgraded.getTenantTelemetryOwnerClosureReceipt(
        String(before[0]?.tenant_id), String(before[0]?.request_id),
      )).toBeNull(); // unknown, never a synthetic empty-set proof
      await upgraded.close();

      conn = await mysql.createConnection(url);
      const [after] = await conn.query<Row[]>(
        `SELECT r.request_id,r.tenant_id,r.receipt_sha256,
                r.local_database_purge_complete,r.session_content_deleted,
                r.all_domains_complete,r.content_purge_executed,
                j.phase,j.terminal_receipt_sha256,
                (SELECT COUNT(*) FROM tenant_purge_session_grave_markers) AS graves,
                (SELECT COUNT(*) FROM sessions) AS sessions,
                (SELECT COUNT(*) FROM billing_usage_facts) AS billing
           FROM tenant_database_purge_receipts r
           JOIN tenant_database_purge_jobs j ON j.request_id=r.request_id`,
      );
      expect(after).toEqual(before);
      const [closure] = await conn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries) AS entries,
                (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts) AS receipts,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants`,
      );
      expect(closure[0]).toMatchObject({ entries: 0, receipts: 0, grants: 0 });
      const [newMarkerAfter] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='0039_tenant_telemetry_owner_closure.sql'",
      );
      expect(Number(newMarkerAfter[0]?.n)).toBe(1);
      await conn.end();
      conn = undefined;

      await run("post-upgrade frozen 0038 fingerprint rejection", process.execPath, [
        "--import", "tsx", "scripts/historical-t3f-startup.mjs",
      ], oldRoot, childEnvironment(temp, {
        MYSQL_TEST_URL: url, AGENT_SERVICE_HISTORICAL_EXPECT_REJECTION: "1",
      }), 60_000);
    } finally {
      await conn?.end().catch(() => {});
      try {
        if (fixtureMayOwnDatabase && admin) {
          if (!/^agent_service_database_purge_test_old_[a-zA-Z0-9_]+$/.test(database)
            || database.length > 64) {
            throw new Error("historical T3f cleanup database name is unsafe");
          }
          await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        }
      } finally {
        await admin?.end().catch(() => {});
        await rm(temp, { recursive: true, force: true });
      }
    }
  }, 720_000);
});
