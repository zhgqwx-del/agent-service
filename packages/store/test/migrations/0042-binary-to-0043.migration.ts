import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
// Pin the published 0042 source, not HEAD: old product writers must create genuine evidence.
// Replace this SHA with the main-line 0042 commit if the integration cherry-picks it.
const FROZEN_0042_COMMIT = "4feddc8ee0c239f17e427349e1cfcb2ad9e8cba8";
const MIGRATION_0042 = "0042_tenant_telemetry_plan_artifact_target.sql";
const REF_KEY = Buffer.alloc(32, 0x42);
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
  return `agent_service_migration_test_pre0043_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function processEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No inherited provider credentials, .env, or destructive gates reach the historical child.
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
  const exactManifests = [
    "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "packages/core/package.json", "packages/protocol/package.json",
    "packages/providers/package.json", "packages/sdk/package.json",
    "packages/store/package.json", "packages/testkit/package.json",
    "apps/agent-router/package.json", "apps/agent-runner/package.json",
  ];
  for (const manifest of exactManifests) {
    const oldBytes = await readFile(join(oldCheckout, manifest));
    const currentBytes = await readFile(join(ROOT, manifest));
    if (!oldBytes.equals(currentBytes)) {
      throw new Error(`frozen 0042 dependency manifest changed: ${manifest}`);
    }
  }
  // A later named test script may change, but dependency/configuration fields may not.
  const oldRoot = JSON.parse(await readFile(join(oldCheckout, "package.json"), "utf8")) as Record<string, unknown>;
  const currentRoot = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  delete oldRoot.scripts;
  delete currentRoot.scripts;
  if (JSON.stringify(oldRoot) !== JSON.stringify(currentRoot)) {
    throw new Error("frozen 0042 root dependency manifest changed");
  }
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(oldCheckout, "node_modules"), options);
  for (const project of [
    "packages/core", "packages/providers", "packages/protocol", "packages/sdk",
    "packages/store", "apps/agent-router", "apps/agent-runner",
  ]) {
    await cp(join(ROOT, project, "node_modules"), join(oldCheckout, project, "node_modules"), options);
  }
  const virtualStore = await lstat(join(oldCheckout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) {
    throw new Error("frozen 0042 dependency store is not self-contained");
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
        throw new Error("frozen 0042 workspace dependency points outside its archive");
      }
      workspaceLinks += 1;
    }
  }
  if (workspaceLinks === 0) throw new Error("frozen 0042 workspace package links are missing");
}

async function runFixed(
  stage: string, file: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout = 180_000,
): Promise<string> {
  try {
    const result = await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return result.stdout;
  } catch (cause) {
    // Subprocess output may contain a MySQL DSN; never expose it in test output.
    const markers = String((cause as { stderr?: unknown })?.stderr ?? "")
      .match(/PRE0043_STAGE=[a-z0-9_]+/g);
    throw new Error(`frozen 0042 fixture stage failed: ${stage}`
      + (markers?.at(-1) ? ` (${markers.at(-1)})` : ""));
  }
}

async function rowDigest(conn: Connection, table: string, orderBy: string): Promise<string> {
  const allowed = new Set([
    "tenant_purge_plan_jobs", "tenant_purge_plan_entries", "tenant_purge_plan_receipts",
    "tenant_telemetry_source_accounting_entries", "tenant_telemetry_source_accounting_receipts",
    "tenant_telemetry_target_manifest_entries", "tenant_telemetry_target_manifest_receipts",
    "tenant_telemetry_plan_artifact_targets", "tenant_telemetry_plan_artifact_target_receipts",
    "tenant_purge_execution_jobs", "tenant_purge_local_physical_ack_receipts",
    "tenant_database_purge_jobs", "tenant_database_purge_receipts",
    "tenant_telemetry_owner_closure_entries", "tenant_telemetry_owner_closure_receipts",
  ]);
  if (!allowed.has(table)) throw new Error("unsafe historical snapshot table");
  const [rows] = await conn.query<Row[]>(`SELECT * FROM \`${table}\` ORDER BY ${orderBy}`);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const SNAPSHOT_TABLES = [
  ["tenant_purge_plan_jobs", "request_id"],
  ["tenant_purge_plan_entries", "request_id,domain"],
  ["tenant_purge_plan_receipts", "request_id"],
  ["tenant_telemetry_source_accounting_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_source_accounting_receipts", "request_id"],
  ["tenant_telemetry_target_manifest_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_target_manifest_receipts", "request_id"],
  ["tenant_telemetry_plan_artifact_targets", "request_id,artifact_group_sha256"],
  ["tenant_telemetry_plan_artifact_target_receipts", "request_id"],
  ["tenant_purge_execution_jobs", "request_id"],
  ["tenant_purge_local_physical_ack_receipts", "request_id"],
  ["tenant_database_purge_jobs", "request_id"],
  ["tenant_database_purge_receipts", "request_id"],
  ["tenant_telemetry_owner_closure_entries", "request_id,write_operation_sha256"],
  ["tenant_telemetry_owner_closure_receipts", "request_id"],
] as const;

describe("frozen 0042 binary -> code-only 0043 read compatibility", () => {
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
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen-0042-"));
    oldCheckout = join(archiveRoot, "checkout");
    await mkdir(oldCheckout);
    const archive = join(archiveRoot, "frozen-0042.tar");
    const resolvedCommit = (await runFixed(
      "resolve commit", "git", ["rev-parse", FROZEN_0042_COMMIT], ROOT,
      processEnv(archiveRoot), 10_000,
    )).trim();
    expect(resolvedCommit).toBe(FROZEN_0042_COMMIT);
    await runFixed("frozen 0042 ancestry", "git", [
      "merge-base", "--is-ancestor", FROZEN_0042_COMMIT, "HEAD",
    ], ROOT, processEnv(archiveRoot), 10_000);
    await runFixed("archive", "git", [
      "archive", "--format=tar", `--output=${archive}`, FROZEN_0042_COMMIT,
    ], ROOT, processEnv(archiveRoot), 30_000);
    await runFixed("extract", "tar", ["-xf", archive, "-C", oldCheckout],
      ROOT, processEnv(archiveRoot), 30_000);
    const driverDir = join(oldCheckout, "packages/store/test/migrations/fixtures");
    await mkdir(driverDir, { recursive: true });
    await copyFile(join(HERE, "fixtures/pre0043-old-t3f-driver.ts"),
      join(driverDir, "pre0043-old-t3f-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0043-old-zero-plan-driver.ts"),
      join(driverDir, "pre0043-old-zero-plan-driver.ts"));
    await copyFile(join(HERE, "fixtures/pre0043-old-t3e-blocked-probe.ts"),
      join(driverDir, "pre0043-old-t3e-blocked-probe.ts"));
    await copyFile(join(HERE, "fixtures/pre0043-old-verify-probe.ts"),
      join(driverDir, "pre0043-old-verify-probe.ts"));
    await copyInstalledDependencies(oldCheckout);
    await runFixed("old build", "pnpm", ["build"], oldCheckout,
      processEnv(archiveRoot), 180_000);
  }, 420_000);

  afterAll(async () => {
    if (admin) {
      for (const database of databases) {
        if (!/^agent_service_migration_test_pre0043_[0-9]+_[0-9a-f]{8}$/.test(database)) {
          throw new Error("unsafe historical test database cleanup target");
        }
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });

  it("keeps genuine old-code nonempty T3d blocked at T3e and reports unknown source", async () => {
    const database = exactDatabaseName();
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    expect(existing).toHaveLength(0);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);

    // The earlier 0042 plan driver is committed in the frozen archive. The 0043-specific
    // probes are copied into that archive above; their product imports still resolve only
    // to frozen 0042 code and schema, never the current writer.
    const t3dOutput = await runFixed("old 0042 T3d worker", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0042-old-plan-driver.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 180_000);
    let t3d: { requestId: string; tenantId: string; entries: number;
      writtenOperationSha256: string; writtenAckReceiptSha256: string };
    try {
      t3d = JSON.parse(t3dOutput) as typeof t3d;
    } catch {
      throw new Error("frozen 0042 T3d driver output was not valid JSON");
    }
    expect(t3d.entries).toBe(33);
    const oldVerifyBefore = await runFixed("old verify before read", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 30_000);
    expect(oldVerifyBefore).toBe("frozen-0042-verify-accepted");

    // Published 0042 cannot complete T3e for a nonzero telemetry target: its live-source
    // recomputation omitted the 0042 target catalog. Assert the real historical fail-closed
    // behavior; a same-request nonempty T3f terminal would be fabricated evidence.
    const blockedOutput = await runFixed("old 0042 T3e fail-closed", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-t3e-blocked-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, {
      MYSQL_URL: url, HISTORICAL_TENANT_ID: t3d.tenantId,
      HISTORICAL_REQUEST_ID: t3d.requestId,
    }), 180_000);
    let blocked: { requestId: string; tenantId: string; catalogReceiptSha256: string;
      targetReceiptSha256: string; writeOperationSha256: string;
      t3ePhase: string; t3eBlockedReasonCode: string };
    try {
      blocked = JSON.parse(blockedOutput) as typeof blocked;
    } catch {
      throw new Error("frozen 0042 T3e probe output was not valid JSON");
    }
    expect(blocked).toMatchObject({ requestId: t3d.requestId, tenantId: t3d.tenantId,
      writeOperationSha256: t3d.writtenOperationSha256,
      t3ePhase: "blocked", t3eBlockedReasonCode: "integrity_conflict" });
    const oldVerifyAfter = await runFixed("old verify after blocked T3e", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 30_000);
    expect(oldVerifyAfter).toBe("frozen-0042-verify-accepted");

    const before = new Map<string, string>();
    const conn = await mysql.createConnection(url);
    try {
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers).toHaveLength(42);
      expect(markers.at(-1)?.name).toBe(MIGRATION_0042);
      const [triggers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()",
      );
      expect(Number(triggers[0]?.n)).toBe(621);
      const [plan] = await conn.query<Row[]>(
        "SELECT phase,aggregate_receipt_sha256 FROM tenant_purge_plan_jobs WHERE request_id=?",
        [t3d.requestId],
      );
      expect(plan).toHaveLength(1);
      expect(plan[0]?.phase).toBe("plan_sealed");
      const [catalog] = await conn.query<Row[]>(
        "SELECT receipt_sha256,target_count,logs_target_count,execution_ready FROM tenant_telemetry_plan_artifact_target_receipts WHERE request_id=?",
        [t3d.requestId],
      );
      expect(catalog).toMatchObject([{ receipt_sha256: blocked.catalogReceiptSha256,
        target_count: 1, logs_target_count: 1, execution_ready: 0 }]);
      const [execution] = await conn.query<Row[]>(
        "SELECT phase,blocked_reason_code FROM tenant_purge_execution_jobs WHERE request_id=?",
        [t3d.requestId],
      );
      expect(execution).toMatchObject([{ phase: "blocked", blocked_reason_code: "integrity_conflict" }]);
      const [terminal] = await conn.query<Row[]>(
        "SELECT receipt_sha256 FROM tenant_database_purge_receipts WHERE request_id=?",
        [t3d.requestId],
      );
      expect(terminal).toHaveLength(0);
      const [closure] = await conn.query<Row[]>(
        "SELECT receipt_sha256 FROM tenant_telemetry_owner_closure_receipts WHERE request_id=?",
        [t3d.requestId],
      );
      expect(closure).toHaveLength(0);
      for (const [table, orderBy] of SNAPSHOT_TABLES) {
        before.set(table, await rowDigest(conn, table, orderBy));
      }
    } finally {
      await conn.end();
    }

    // 0043 is a pure reader: verify-only startup on the unchanged 0042 schema, with no marker,
    // trigger rotation, backfill, grant, or external deletion side effect.
    const current = await MysqlSessionStore.connect({
      url, migrationMode: "verify", tenantTelemetryRefKey: REF_KEY,
    });
    try {
      expect(await current.getTenantTelemetryPlanArtifactTargetReceipt(
        t3d.tenantId, t3d.requestId,
      )).toMatchObject({ receiptSha256: blocked.catalogReceiptSha256,
        targetCount: 1, executionReady: false });
      expect(await current.getTenantTelemetryPlanArtifactTargets(
        t3d.tenantId, t3d.requestId,
      )).toMatchObject([{ receiptSha256: blocked.targetReceiptSha256,
        writeOperationSha256: t3d.writtenOperationSha256 }]);
      expect(await current.getTenantTelemetryOwnerClosureReceipt(
        t3d.tenantId, t3d.requestId,
      )).toBeNull();
      expect(await current.getTenantTelemetrySourceEligibility(
        t3d.tenantId, t3d.requestId,
      )).toEqual({ status: "unknown", managedArtifactCount: null,
        executionReady: false, externalAuthorityVerified: false });
      expect(await current.getTenantTelemetrySourceEligibility(
        `foreign-${t3d.tenantId}`, t3d.requestId,
      )).toBeNull();
      expect(await current.getTenantTelemetrySourceEligibility(
        t3d.tenantId, `erase_${randomUUID()}`,
      )).toBeNull();
    } finally {
      await current.close();
    }

    const afterConn = await mysql.createConnection(url);
    try {
      const [markers] = await afterConn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers).toHaveLength(42);
      expect(markers.at(-1)?.name).toBe(MIGRATION_0042);
      const [triggers] = await afterConn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()",
      );
      expect(Number(triggers[0]?.n)).toBe(621);
      for (const [table, orderBy] of SNAPSHOT_TABLES) {
        expect(await rowDigest(afterConn, table, orderBy)).toBe(before.get(table));
      }
      const [unsupported] = await afterConn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS events,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts) AS receipts`,
      );
      expect(unsupported[0]).toMatchObject({ grants: 0, events: 0, receipts: 0 });
    } finally {
      await afterConn.end();
    }

    const oldVerifyStillAccepted = await runFixed("old verify after current read", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 30_000);
    expect(oldVerifyStillAccepted).toBe("frozen-0042-verify-accepted");
  }, 300_000);

  it("reads genuine old-code zero-target T3f terminal on the same 0042 schema", async () => {
    const database = exactDatabaseName();
    const [existing] = await admin.query<Row[]>(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
    );
    expect(existing).toHaveLength(0);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    databases.add(database);
    const url = databaseUrl(base, database);

    // The setup and both terminal transitions execute in the frozen 0042 archive. This
    // second request is intentionally empty: it is not a substitute for a nonempty T3f.
    const planOutput = await runFixed("old 0042 zero-target T3d", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-zero-plan-driver.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 180_000);
    let plan: { requestId: string; tenantId: string; planReceiptSha256: string;
      catalogReceiptSha256: string; targetCount: number };
    try {
      plan = JSON.parse(planOutput) as typeof plan;
    } catch {
      throw new Error("frozen 0042 zero-target T3d output was not valid JSON");
    }
    expect(plan.targetCount).toBe(0);
    const terminalOutput = await runFixed("old 0042 zero-target T3f", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-t3f-driver.ts",
    ], oldCheckout, processEnv(archiveRoot, {
      MYSQL_URL: url, HISTORICAL_TENANT_ID: plan.tenantId,
      HISTORICAL_REQUEST_ID: plan.requestId,
    }), 180_000);
    let terminal: { requestId: string; tenantId: string; catalogReceiptSha256: string;
      terminalReceiptSha256: string; closureReceiptSha256: string; closureEntryCount: number };
    try {
      terminal = JSON.parse(terminalOutput) as typeof terminal;
    } catch {
      throw new Error("frozen 0042 zero-target T3f output was not valid JSON");
    }
    expect(terminal).toMatchObject({
      requestId: plan.requestId, tenantId: plan.tenantId,
      catalogReceiptSha256: plan.catalogReceiptSha256, closureEntryCount: 0,
    });
    const oldVerifyBefore = await runFixed("old verify after zero-target T3f", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 30_000);
    expect(oldVerifyBefore).toBe("frozen-0042-verify-accepted");

    const before = new Map<string, string>();
    const conn = await mysql.createConnection(url);
    try {
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers).toHaveLength(42);
      expect(markers.at(-1)?.name).toBe(MIGRATION_0042);
      const [triggers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()",
      );
      expect(Number(triggers[0]?.n)).toBe(621);
      const [catalog] = await conn.query<Row[]>(
        "SELECT receipt_sha256,target_count,unknown_group_count FROM tenant_telemetry_plan_artifact_target_receipts WHERE request_id=?",
        [plan.requestId],
      );
      expect(catalog).toMatchObject([{ receipt_sha256: plan.catalogReceiptSha256,
        target_count: 0, unknown_group_count: 0 }]);
      const [t3f] = await conn.query<Row[]>(
        "SELECT receipt_sha256,all_domains_complete,content_purge_executed FROM tenant_database_purge_receipts WHERE request_id=?",
        [plan.requestId],
      );
      expect(t3f).toMatchObject([{ receipt_sha256: terminal.terminalReceiptSha256,
        all_domains_complete: 0, content_purge_executed: 0 }]);
      const [closure] = await conn.query<Row[]>(
        "SELECT receipt_sha256,entry_count FROM tenant_telemetry_owner_closure_receipts WHERE request_id=?",
        [plan.requestId],
      );
      expect(closure).toMatchObject([{ receipt_sha256: terminal.closureReceiptSha256,
        entry_count: 0 }]);
      for (const [table, orderBy] of SNAPSHOT_TABLES) {
        before.set(table, await rowDigest(conn, table, orderBy));
      }
    } finally {
      await conn.end();
    }

    const current = await MysqlSessionStore.connect({
      url, migrationMode: "verify", tenantTelemetryRefKey: REF_KEY,
    });
    try {
      expect(await current.getTenantTelemetryPlanArtifactTargetReceipt(
        plan.tenantId, plan.requestId,
      )).toMatchObject({ receiptSha256: plan.catalogReceiptSha256, targetCount: 0 });
      expect(await current.getTenantTelemetryPlanArtifactTargets(
        plan.tenantId, plan.requestId,
      )).toEqual([]);
      expect(await current.getTenantTelemetryOwnerClosureReceipt(
        plan.tenantId, plan.requestId,
      )).toMatchObject({ receiptSha256: terminal.closureReceiptSha256, entryCount: 0 });
      expect(await current.getTenantTelemetrySourceEligibility(
        plan.tenantId, plan.requestId,
      )).toEqual({ status: "local_source_candidate", managedArtifactCount: 0,
        executionReady: false, externalAuthorityVerified: false });
      expect(await current.getTenantTelemetrySourceEligibility(
        `foreign-${plan.tenantId}`, plan.requestId,
      )).toBeNull();
      expect(await current.getTenantTelemetrySourceEligibility(
        plan.tenantId, `erase_${randomUUID()}`,
      )).toBeNull();
    } finally {
      await current.close();
    }

    const afterConn = await mysql.createConnection(url);
    try {
      const [markers] = await afterConn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers).toHaveLength(42);
      expect(markers.at(-1)?.name).toBe(MIGRATION_0042);
      const [triggers] = await afterConn.query<Row[]>(
        "SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()",
      );
      expect(Number(triggers[0]?.n)).toBe(621);
      for (const [table, orderBy] of SNAPSHOT_TABLES) {
        expect(await rowDigest(afterConn, table, orderBy)).toBe(before.get(table));
      }
      const [unsupported] = await afterConn.query<Row[]>(
        `SELECT (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants) AS grants,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_external_events) AS events,
                (SELECT COUNT(*) FROM tenant_telemetry_disposition_receipts) AS receipts`,
      );
      expect(unsupported[0]).toMatchObject({ grants: 0, events: 0, receipts: 0 });
    } finally {
      await afterConn.end();
    }

    const oldVerifyStillAccepted = await runFixed("old verify after current zero read", process.execPath, [
      "--import", "tsx", "packages/store/test/migrations/fixtures/pre0043-old-verify-probe.ts",
    ], oldCheckout, processEnv(archiveRoot, { MYSQL_URL: url }), 30_000);
    expect(oldVerifyStillAccepted).toBe("frozen-0042-verify-accepted");
  }, 300_000);
});
