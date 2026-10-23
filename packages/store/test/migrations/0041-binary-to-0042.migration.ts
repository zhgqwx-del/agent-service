import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { HistoricalCurrentRuntimeProfile } from "./fixtures/current-historical-runtime.js";
import { assertNo0054FrozenLegacyFootprint, captureFrozenLegacyColumns } from "./fixtures/frozen-legacy-row-snapshot.js";
import { installFrozenDependencies } from "./fixtures/frozen-dependencies.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const FROZEN_0041_COMMIT = "2cb28ad7d20a06c69380231f7d1fcc5ea9702ce9";
const REF_KEY = Buffer.alloc(32, 0x42);
const MIGRATION_0042 = "0042_tenant_telemetry_plan_artifact_target.sql";
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
  return `agent_service_migration_test_pre0042_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function processEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Historical child receives no provider credentials, .env, or destructive gates.
  return {
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
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
    throw new Error("frozen 0041 dependency store is not self-contained");
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
        throw new Error("frozen 0041 workspace dependency points outside its archive");
      }
      workspaceLinks += 1;
    }
  }
  if (workspaceLinks === 0) throw new Error("frozen 0041 workspace package links are missing");
}

async function runFixed(
  stage: string, file: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout = 180_000,
): Promise<string> {
  try {
    const result = await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch {
    // Subprocess output may include a MySQL DSN; never expose it in Vitest output.
    throw new Error(`frozen 0041 fixture stage failed: ${stage}`);
  }
}

async function rowDigest(
  conn: Connection, table: string, orderBy: string, columns: readonly string[],
): Promise<string> {
  const allowed = new Set([
    "tenant_erasure_admissions", "tenant_content_inventory_receipts",
    "tenant_purge_plan_jobs", "tenant_purge_plan_entries", "tenant_purge_plan_receipts",
    "tenant_telemetry_source_accounting_entries", "tenant_telemetry_source_accounting_receipts",
    "tenant_telemetry_target_manifest_entries", "tenant_telemetry_target_manifest_receipts",
  ]);
  if (!allowed.has(table)) throw new Error("unsafe snapshot table");
  const projection = columns.map((column) => `\`${column}\``).join(",");
  const [rows] = await conn.query<Row[]>(`SELECT ${projection} FROM \`${table}\` ORDER BY ${orderBy}`);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const OLD_TABLES = [
  ["tenant_erasure_admissions", "request_id"],
  ["tenant_content_inventory_receipts", "request_id"],
  ["tenant_purge_plan_jobs", "request_id"],
  ["tenant_purge_plan_entries", "request_id,domain"],
  ["tenant_purge_plan_receipts", "request_id"],
  ["tenant_telemetry_source_accounting_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_source_accounting_receipts", "request_id"],
  ["tenant_telemetry_target_manifest_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_target_manifest_receipts", "request_id"],
] as const;

describe("frozen 0041 T3d terminal -> 0042 real MySQL upgrade", () => {
  let admin: Connection;
  let base: URL;
  let archiveRoot: string;
  let oldCheckout: string;
  let targetMigrationsDir: string;
  let targetMigrations: string[];
  const databases = new Set<string>();
  const currentProfiles = new Map<string, HistoricalCurrentRuntimeProfile>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen-0041-"));
    targetMigrationsDir = join(archiveRoot, "target-migrations");
    await mkdir(targetMigrationsDir);
    targetMigrations = (await readdir(join(ROOT, "packages/store/migrations")))
      .filter((name) => name.endsWith(".sql") && name <= MIGRATION_0042).sort();
    expect(targetMigrations.at(-1)).toBe(MIGRATION_0042);
    for (const name of targetMigrations) {
      await copyFile(join(ROOT, "packages/store/migrations", name), join(targetMigrationsDir, name));
    }
    oldCheckout = join(archiveRoot, "checkout");
    await mkdir(oldCheckout);
    const archive = join(archiveRoot, "frozen-0041.tar");
    const resolvedCommit = (await runFixed(
      "resolve commit", "git", ["rev-parse", FROZEN_0041_COMMIT], ROOT,
      processEnv(archiveRoot), 10_000,
    )).trim();
    expect(resolvedCommit).toBe(FROZEN_0041_COMMIT);
    await runFixed("archive", "git", [
      "archive", "--format=tar", `--output=${archive}`, FROZEN_0041_COMMIT,
    ], ROOT, processEnv(archiveRoot), 30_000);
    await runFixed("extract", "tar", ["-xf", archive, "-C", oldCheckout],
      ROOT, processEnv(archiveRoot), 30_000);
    const driverDir = join(oldCheckout, "packages/store/test/migrations/fixtures");
    await mkdir(driverDir, { recursive: true });
    await copyFile(join(HERE, "fixtures/pre0042-old-plan-driver.ts"),
      join(driverDir, "pre0042-old-plan-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0042-old-verify-probe.ts"),
      join(driverDir, "pre0042-old-verify-probe.ts"));
    await copyInstalledDependencies(oldCheckout);
    await runFixed("old build", "pnpm", ["build"], oldCheckout,
      processEnv(archiveRoot), 180_000);
  }, 420_000);

  afterAll(async () => {
    const closed = await Promise.allSettled([...currentProfiles.values()].map(profile => profile.close(false)));
    let cleanupFailure: { reason: unknown } | undefined;
    for (const result of closed) if (result.status === "rejected") cleanupFailure ??= { reason: result.reason };
    try {
      if (admin) {
        for (const database of databases) {
          if (!/^agent_service_migration_test_pre0042_[0-9]+_[0-9a-f]{8}$/.test(database)) {
            throw new Error("unsafe test database cleanup target");
          }
          if (currentProfiles.get(database) && !currentProfiles.get(database)!.didClean()) continue;
          await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        }
        await admin.end();
      }
      if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
    } catch (reason) { cleanupFailure ??= { reason }; }
    if (cleanupFailure) throw cleanupFailure.reason;
  });

  it("preserves genuine old-worker terminal and records missing 0042 catalog as unknown", async ({ signal }) => {
    const database = exactDatabaseName();
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    expect(existing).toHaveLength(0);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);
    const stdout = await runFixed("old T3d worker", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0042-old-plan-driver.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 180_000);
    let oldResult: {
      sourceCommit: string;
      requestId: string;
      tenantId: string;
      planReceiptSha256: string;
      planEntryRootSha256: string;
      sourceReceiptSha256: string;
      manifestReceiptSha256: string;
      entries: number;
      observedTargets: number;
      writtenOperationSha256: string;
      writtenAckReceiptSha256: string;
      upstreamReceiptsPresent: boolean;
    };
    try {
      oldResult = JSON.parse(stdout) as typeof oldResult;
    } catch {
      throw new Error("frozen 0041 driver output was not valid JSON");
    }
    expect(oldResult.sourceCommit).toBe(FROZEN_0041_COMMIT);
    expect(oldResult.entries).toBe(33);
    expect(oldResult.observedTargets).toBe(1);
    expect(oldResult.upstreamReceiptsPresent).toBe(true);
    const oldVerifyAccepted = await runFixed("old verify accepted", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0042-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url,
      EXPECT_FINGERPRINT_STAGE: "accepted" }), 15_000);
    expect(oldVerifyAccepted).toBe("frozen-0041-verify-accepted");

    const before = new Map<string, string>();
    const frozenColumns = new Map<string, readonly string[]>();
    const conn = await mysql.createConnection(url);
    try {
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers).toHaveLength(41);
      expect(markers.at(-1)?.name).toBe("0041_tenant_telemetry_target_manifest.sql");
      const [oldJob] = await conn.query<Row[]>(
        "SELECT phase,aggregate_receipt_sha256 FROM tenant_purge_plan_jobs WHERE request_id=?",
        [oldResult.requestId],
      );
      expect(oldJob).toHaveLength(1);
      expect(oldJob[0]?.phase).toBe("plan_sealed");
      expect(oldJob[0]?.aggregate_receipt_sha256).toBe(oldResult.planReceiptSha256);
      const [domains] = await conn.query<Row[]>(
        "SELECT domain,target_count,disposition FROM tenant_purge_plan_entries WHERE request_id=? AND domain IN ('logs','traces') ORDER BY domain",
        [oldResult.requestId],
      );
      expect(domains).toMatchObject([
        { domain: "logs", target_count: 0, disposition: "blocked_adapter_unconfigured" },
        { domain: "traces", target_count: 0, disposition: "blocked_adapter_unconfigured" },
      ]);
      const [manifest] = await conn.query<Row[]>(
        "SELECT receipt_sha256,observed_target_count FROM tenant_telemetry_target_manifest_receipts WHERE request_id=?",
        [oldResult.requestId],
      );
      expect(manifest).toHaveLength(1);
      expect(manifest[0]?.receipt_sha256).toBe(oldResult.manifestReceiptSha256);
      expect(Number(manifest[0]?.observed_target_count)).toBe(1);
      const [manifestEntries] = await conn.query<Row[]>(
        "SELECT source_kind,classification,observed_target_sha256 FROM tenant_telemetry_target_manifest_entries WHERE request_id=? ORDER BY source_kind",
        [oldResult.requestId],
      );
      expect(manifestEntries).toHaveLength(5);
      expect(manifestEntries.every((entry) => entry.classification === "accounted"
        && typeof entry.observed_target_sha256 === "string"
        && entry.observed_target_sha256.length === 64)).toBe(true);
      const [written] = await conn.query<Row[]>(
        "SELECT phase,write_ack_receipt_sha256 FROM tenant_telemetry_write_jobs WHERE write_operation_sha256=?",
        [oldResult.writtenOperationSha256],
      );
      expect(written).toHaveLength(1);
      expect(written[0]?.phase).toBe("written");
      expect(written[0]?.write_ack_receipt_sha256).toBe(oldResult.writtenAckReceiptSha256);
      for (const [table, orderBy] of OLD_TABLES) {
        const columns = await captureFrozenLegacyColumns(conn, table);
        frozenColumns.set(table, columns);
        before.set(table, await rowDigest(conn, table, orderBy, columns));
      }
    } finally {
      await conn.end();
    }

    // Keep the original target-specific fingerprint proof independent of later migrations.
    const targetStore = await MysqlSessionStore.connect({
      url, migrationsDir: targetMigrationsDir, tenantTelemetryRefKey: REF_KEY,
    });
    await targetStore.close();
    const targetConn = await mysql.createConnection(url);
    try {
      const [markers] = await targetConn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => row.name)).toEqual(targetMigrations);
      expect(markers.some((row) => String(row.name).startsWith("0053_"))).toBe(false);
    } finally {
      await targetConn.end();
    }
    const targetProbe = await runFixed("old target verify rejected", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0042-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url,
      EXPECT_FINGERPRINT_STAGE: "target" }), 15_000);
    expect(targetProbe).toBe("frozen-0041-verify-fingerprint-rejected");

    const currentProfile = new HistoricalCurrentRuntimeProfile(url, database, signal, REF_KEY);
    currentProfiles.set(database, currentProfile); // Register before its first startup/native await.
    let currentComplete = false;
    let currentFailure: { reason: unknown } | undefined;
    try {
      await currentProfile.prepare();
      const upgraded = await currentProfile.openStore();
      try {
        const plan = await upgraded.getTenantPurgePlanReceipt(oldResult.tenantId, oldResult.requestId);
        expect(plan?.receiptSha256).toBe(oldResult.planReceiptSha256);
        expect(await upgraded.getTenantPurgePlanEntries(
          oldResult.tenantId, oldResult.requestId, 1,
        )).toHaveLength(33);
        const source = await upgraded.getTenantTelemetrySourceAccountingReceipt(
          oldResult.tenantId, oldResult.requestId,
        );
        expect(source?.receiptSha256).toBe(oldResult.sourceReceiptSha256);
        const manifest = await upgraded.getTenantTelemetryTargetManifestReceipt(
          oldResult.tenantId, oldResult.requestId,
        );
        expect(manifest?.receiptSha256).toBe(oldResult.manifestReceiptSha256);
        const observationalReadiness = await upgraded.getTenantTelemetryTargetSourceReadiness(
          oldResult.tenantId, oldResult.requestId,
        );
        expect(observationalReadiness?.executionReady).toBe(false);
        expect(await upgraded.getTenantTelemetryPlanArtifactTargetReceipt(
          oldResult.tenantId, oldResult.requestId,
        )).toBeNull();
        expect(await upgraded.getTenantTelemetryPlanArtifactTargets(
          oldResult.tenantId, oldResult.requestId,
        )).toEqual([]);
        const foreignTenant = `foreign-${oldResult.tenantId}`;
        expect(await upgraded.getTenantPurgePlanReceipt(foreignTenant, oldResult.requestId)).toBeNull();
        expect(await upgraded.getTenantTelemetryPlanArtifactTargetReceipt(
          foreignTenant, oldResult.requestId,
        )).toBeNull();
        expect(await upgraded.getTenantTelemetryPlanArtifactTargets(
          foreignTenant, oldResult.requestId,
        )).toEqual([]);
      } finally {
        await upgraded.close();
      }

      const afterConn = await mysql.createConnection(url);
      try {
        const [markers] = await afterConn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
        // Keep the frozen 0041 pre-state exact; only the current upgrade tail grows over time.
        const currentMigrations = (await readdir(join(ROOT, "packages/store/migrations")))
          .filter((name) => name.endsWith(".sql")).sort();
        expect(markers.map((row) => row.name)).toEqual(currentMigrations);
        expect(markers.some((row) => row.name === MIGRATION_0042)).toBe(true);
        for (const [table, orderBy] of OLD_TABLES) {
          const columns = frozenColumns.get(table);
          if (!columns) throw new Error(`frozen snapshot columns missing: ${table}`);
          expect(await rowDigest(afterConn, table, orderBy, columns),
            `frozen historical rows changed: ${table}`).toBe(before.get(table));
        }
        await assertNo0054FrozenLegacyFootprint(afterConn);
        const [newRows] = await afterConn.query<Row[]>(
          `SELECT (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_targets) AS entries,
                  (SELECT COUNT(*) FROM tenant_telemetry_plan_artifact_target_receipts) AS receipts`,
        );
        expect(newRows[0]).toMatchObject({ entries: 0, receipts: 0 });
      } finally {
        await afterConn.end();
      }

      const oldVerifyRejected = await runFixed("old verify rejected", process.execPath, [
        "--import", "tsx", "packages/store/test/migrations/fixtures/pre0042-old-verify-probe.ts",
      ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url,
        EXPECT_FINGERPRINT_STAGE: "full-tail" }), 15_000);
      // Genuine old code sees the 0053 subject column/CHECK in its strict 0035 fingerprint first.
      expect(oldVerifyRejected).toBe("frozen-0041-verify-0035-fingerprint-rejected");
      currentComplete = true;
    } catch (reason) { currentFailure = { reason }; }
    finally {
      try { await currentProfile.close(currentComplete); } catch (reason) { currentFailure ??= { reason }; }
      if (currentFailure) throw currentFailure.reason;
    }
  }, 240_000);
});
