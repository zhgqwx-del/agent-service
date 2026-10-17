import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFrozenDependencies } from "./fixtures/frozen-dependencies.js";
import { MysqlSessionStore, PersistedProviderCaptureIntegrityError, TenantTelemetryWriteIntegrityError,
  readTenantTelemetryCaptureCheckpointFromMysql,
  type TenantTelemetryCaptureRestoreMaintenanceSelector } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const SOURCE_COMMIT = "bbe5ab86152c244537d5a296c8f99bfb1a6b95f4";
const OLD_MARKER = "0055_tenant_telemetry_capture_backup_checkpoint.sql";
const MIGRATION = "0056_tenant_telemetry_capture_restore_history.sql";
const REF_KEY = Buffer.alloc(32, 0x43); // Public fixture key, not operator input.
const NEW_TABLE = "tenant_telemetry_capture_restore_history_receipts";
const OLD_CHECKPOINT_TABLES = ["tenant_telemetry_capture_backup_checkpoints",
  "tenant_telemetry_capture_backup_checkpoint_leaves", "tenant_telemetry_capture_restore_bindings"] as const;
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const WRITER_STAGES = ["input", "connect", "legacy", "activate", "source", "claim", "reserve", "ack", "finish",
  "anchor", "checkpoint", "availability", "preflight", "epoch-reserve", "prepare", "proof"];
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"];
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantTelemetryCaptureRestoreIntegrityError", "TenantBackupCatalogConflictError", "TenantBackupCatalogNotReadyError", "TenantErasureIntegrityError"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function disposableBase(raw: string): URL {
  const url = new URL(raw), name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(name)) throw new Error("0056 fixture requires a local disposable MySQL base");
  return url;
}
function databaseUrl(base: URL, database: string): string {
  if (database !== "mysql" && !/^agent_service_migration_test_0056_[0-9]+_[0-9a-f]{8}$/.test(database)) throw new Error("unsafe 0056 database target");
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Never inherit .env/model/cloud credentials into the frozen subprocess.
  return { PATH: process.env.PATH, TMPDIR: temp, CI: "1", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
function writerDiagnostic(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = "pre0056-frozen-writer-diagnostic:", line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const row = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "code,name,schema,stage"
      || row.schema !== "pre0056-frozen-writer-diagnostic-v1" || typeof row.stage !== "string" || !WRITER_STAGES.includes(row.stage)
      || typeof row.code !== "string" || !WRITER_CODES.includes(row.code) || typeof row.name !== "string" || !WRITER_NAMES.includes(row.name)) return "";
    return ` (writerStage=${row.stage}, code=${row.code}, name=${row.name})`;
  } catch { return ""; }
}
function verifyDiagnostic(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = "pre0056-frozen-verify-diagnostic:", line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const row = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).sort().join(",") !== "errorClass,expected,messageCategory,observed,schema"
      || row.schema !== "pre0056-frozen-verify-diagnostic-v1"
      || !["pending", "fingerprint"].includes(String(row.expected))
      || !["accepted", "pending", "fingerprint", "unexpected"].includes(String(row.observed))
      || !["none", "Error", "non_error", "TenantTelemetryWriteIntegrityError", "PersistedProviderCaptureIntegrityError"].includes(String(row.errorClass))
      || !["none", "writer_integrity_default", "capture_integrity_default", "0055_fingerprint", "other"].includes(String(row.messageCategory))) return "";
    return ` (verifyExpected=${String(row.expected)}, observed=${String(row.observed)}, errorClass=${String(row.errorClass)}, messageCategory=${String(row.messageCategory)})`;
  } catch { return ""; }
}
async function runFixed(stage: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const detail = file !== process.execPath ? ""
      : args.includes("packages/store/test/fixtures/pre0056-old-writer-driver.ts") ? writerDiagnostic(error)
        : args.includes("packages/store/test/fixtures/pre0056-old-verify-probe.ts") ? verifyDiagnostic(error) : "";
    throw new Error(`frozen 0055 fixture stage failed: ${stage}${detail}`); // No child output/cause/DSN.
  }
}
async function copyIsolatedDependencies(checkout: string): Promise<void> {
  const projects = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk", "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"];
  await installFrozenDependencies(ROOT, checkout);
  const linked = projects.filter((project) => project !== "packages/testkit");
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0055 dependency store is not isolated");
  const realCheckout = await realpath(checkout); let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...linked]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) throw new Error("frozen 0055 workspace dependency escapes source archive");
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0055 workspace dependency links missing");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("historical metadata identifier invalid");
  return `\`${value}\``;
}
/** Closed parser for this frozen append-only migration set, not a generic SQL
 * interpreter. Refuse unsupported CREATE/DROP/RENAME shapes rather than silently
 * omit a physical table. schema_migrations is created by the product migrator. */
async function declaredTableSet(dir: string, names: readonly string[]): Promise<string[]> {
  const tables = new Set(["schema_migrations"]);
  for (const name of names) {
    const sql = (await readFile(join(dir, name), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\r\n]*/g, "");
    if (/\b(?:DROP|RENAME)\s+TABLE\b|\bRENAME\s+TO\b/i.test(sql)) throw new Error("frozen table-set parser rejects non-additive DDL");
    const heads = [...sql.matchAll(/\bCREATE\s+TABLE\b/gi)];
    const declarations = [...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`([a-z][a-z0-9_]*)`|([a-z][a-z0-9_]*))\s*\(/gi)];
    if (heads.length !== declarations.length) throw new Error("frozen table-set parser rejects unrecognized CREATE TABLE");
    for (const declaration of declarations) {
      const table = declaration[1] ?? declaration[2]; identifier(table);
      if (table === undefined || tables.has(table)) throw new Error("frozen table-set parser rejects duplicate table");
      tables.add(table);
    }
  }
  if (tables.size <= 1) throw new Error("frozen table-set declarations missing");
  return [...tables].sort();
}
type TableProofStage = "old-writer" | "old-schema" | "old-business" | "new-schema" | "new-declarations";
function assertTableCount(stage: TableProofStage, actual: unknown, expected: number): void {
  if (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 1) throw new Error("frozen table-count proof is invalid");
  if (actual !== expected) throw new Error(`pre0056-table-count:${JSON.stringify({ schema: "pre0056-table-count-v1", stage, actual, expected })}`);
}
function assertTableSet(stage: TableProofStage, actual: readonly string[], expected: readonly string[]): void {
  const actualNames = [...actual].sort(), expectedNames = [...expected].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    // Fixed schema/counts/roots only: no row, owner, SQL, URL or key diagnostics.
    throw new Error(`pre0056-table-set:${JSON.stringify({ schema: "pre0056-table-set-v1", stage,
      actual: actualNames.length, expected: expectedNames.length,
      missing: expectedNames.filter((name) => !actualNames.includes(name)).length,
      extra: actualNames.filter((name) => !expectedNames.includes(name)).length,
      actualRoot: digest(actualNames), expectedRoot: digest(expectedNames) })}`);
  }
}
async function tableNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT table_name AS name,table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY BINARY table_name");
  if (!rows.length || rows.some((row) => row.kind !== "BASE TABLE")) throw new Error("historical base tables missing");
  return rows.map((row) => { identifier(row.name); return String(row.name); });
}
/** Every old physical business table, including the three nonempty 0055
 * checkpoint/leaf/binding tables. Only full-row hashes leave this helper. */
async function businessDigests(conn: Connection): Promise<Record<string, { rows: number; sha256: string }>> {
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const table of (await tableNames(conn)).filter((name) => name !== "schema_migrations" && name !== NEW_TABLE)) {
    const [keys] = await conn.query<RowDataPacket[]>("SELECT column_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name='PRIMARY' ORDER BY seq_in_index", [table]);
    if (!keys.length) throw new Error("historical table primary key missing");
    const order = keys.map((key) => identifier(key.name)).join(",");
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${identifier(table)} ORDER BY ${order}`);
    result[table] = { rows: rows.length, sha256: digest(rows) };
  }
  return result;
}
async function schemaDigest(conn: Connection): Promise<string> {
  const projections = [
    "SELECT table_name,table_type,engine,table_collation FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name",
    "SELECT table_name,column_name,column_type,is_nullable,column_default,collation_name,ordinal_position FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position",
    "SELECT table_name,index_name,seq_in_index,column_name,non_unique,sub_part FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index",
    "SELECT constraint_name,check_clause FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() ORDER BY constraint_name",
    "SELECT table_name,constraint_name,referenced_table_name,update_rule,delete_rule FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() ORDER BY table_name,constraint_name",
    "SELECT trigger_name,event_manipulation,event_object_table,action_timing,action_orientation,action_condition,action_statement FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name",
    "SELECT name FROM schema_migrations ORDER BY BINARY name",
  ];
  const results: RowDataPacket[][] = [];
  for (const sql of projections) results.push((await conn.query<RowDataPacket[]>(sql))[0]);
  return digest(results);
}
async function assertNoAutomaticHistory(conn: Connection): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${identifier(NEW_TABLE)}`);
  expect(rows).toHaveLength(1); expect(rows[0]!.n === 0 || rows[0]!.n === "0").toBe(true);
}
interface History {
  scope: "frozen0055-prepared-upgrade-v1"; sourceCommit: string; marker: string; triggerCount: number; tableCount: number;
  sourceCounts: { queued: number; reserved: number; written: number }; legacyUnknownItemCount: number;
  activationReceiptSha256: string; checkpointSha256: string; checkpointLeafCount: number; pendingWriteDenied: true;
  sourceBackupSha256: string; runtimeEpochSha256: string; sourceBindingSha256: string;
  selector: TenantTelemetryCaptureRestoreMaintenanceSelector;
  actualFixtureAckCount: 1; actualSinkWriteCount: 0; sourceSinkDurable: false; catalogProtocolFixture: true;
  artifactBytesAuthenticated: false; physicalRestoreExecuted: false; runtimeActivated: false;
  externalDispositionExecuted: false; freshFleetHttpProven: false; productionAccepted: false;
}

describe("0055 -> 0056 exact frozen-source prepared historical MySQL upgrade", () => {
  let admin: Connection, base: URL, archiveRoot: string, checkout: string, currentDir: string;
  let oldNames: string[], currentNames: string[], expectedOldTables: string[], expectedCurrentTables: string[];
  const owned = new Set<string>();
  beforeAll(async () => {
    base = disposableBase(BASE); admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0055-"));
    checkout = join(archiveRoot, "checkout"); currentDir = join(archiveRoot, "current-migrations");
    await mkdir(checkout); await mkdir(currentDir);
    expect((await runFixed("resolve exact old source", "git", ["rev-parse", SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 10_000)).trim()).toBe(SOURCE_COMMIT);
    const tar = join(archiveRoot, "frozen0055.tar");
    await runFixed("archive exact source", "git", ["archive", "--format=tar", `--output=${tar}`, SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract own archive", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe(OLD_MARKER);
    // Later migrations must not turn this exact historical boundary into a chain rerun.
    currentNames = (await readdir(MIGRATIONS)).filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 56).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    for (const name of oldNames) expect((await readFile(join(checkout, "packages/store/migrations", name))).equals(await readFile(join(MIGRATIONS, name)))).toBe(true);
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    expectedOldTables = await declaredTableSet(join(checkout, "packages/store/migrations"), oldNames);
    expectedCurrentTables = await declaredTableSet(currentDir, currentNames);
    assertTableSet("new-declarations", expectedCurrentTables, [...expectedOldTables, NEW_TABLE]);
    const fixtures = join(checkout, "packages/store/test/fixtures"); await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0056-old-writer-driver.ts", "pre0056-old-verify-probe.ts"]) await copyFile(join(HERE, "../fixtures", name), join(fixtures, name));
    await copyIsolatedDependencies(checkout);
    // Offline old product build failure is a hard failure, never a skip/fallback.
    await runFixed("offline frozen source compile", process.execPath, ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"], checkout, isolatedEnv(archiveRoot));
  }, 420_000);
  afterAll(async () => {
    if (admin) {
      for (const name of owned) {
        if (!/^agent_service_migration_test_0056_[0-9]+_[0-9a-f]{8}$/.test(name)) throw new Error("unsafe 0056 fixture cleanup target");
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });
  async function history() {
    const name = `agent_service_migration_test_0056_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
    if (existing.length) throw new Error("0056 fixture database already exists");
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url = databaseUrl(base, name);
    const output = await runFixed("actual frozen active prepared business", process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0056-old-writer-driver.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url }), 120_000);
    let result: History;
    try { result = JSON.parse(output) as History; } catch { throw new Error("frozen 0055 writer output invalid"); }
    // Count disagreement gets its own content-free oracle; never infer the old
    // physical set from a historical prose count or from the live DB itself.
    assertTableCount("old-writer", result.tableCount, expectedOldTables.length);
    expect(result).toMatchObject({ scope: "frozen0055-prepared-upgrade-v1", sourceCommit: SOURCE_COMMIT,
      marker: OLD_MARKER, triggerCount: 718, legacyUnknownItemCount: 1,
      sourceCounts: { queued: 1, reserved: 1, written: 1 }, pendingWriteDenied: true,
      actualFixtureAckCount: 1, actualSinkWriteCount: 0, sourceSinkDurable: false, catalogProtocolFixture: true,
      artifactBytesAuthenticated: false, physicalRestoreExecuted: false, runtimeActivated: false,
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false });
    for (const value of [result.activationReceiptSha256, result.checkpointSha256, result.sourceBackupSha256,
      result.runtimeEpochSha256, result.sourceBindingSha256]) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(result.selector.checkpointSha256).toBe(result.checkpointSha256);
    expect(Number.isSafeInteger(result.checkpointLeafCount) && result.checkpointLeafCount > 0).toBe(true);
    return { url, result };
  }
  async function connect(url: string, migrationMode: "apply" | "verify") {
    return MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode, tenantTelemetryRefKey: REF_KEY,
      tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  }
  async function assertRejected(url: string, mode: "apply" | "verify", expected: "pending" | string) {
    let matched = false, observed: unknown;
    try { const store = await connect(url, mode); await store.close(); }
    catch (error) {
      observed = error;
      // Cold startup audits durable write jobs BEFORE connect's direct capture
      // audit. assertTenantTelemetryWriteJobRelations wraps capturePrerequisites'
      // pending-run rejection in this exact default writer integrity error.
      // The old writer's same-instance getBinding has no such wrapper.
      matched = expected === "pending"
        ? error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid"
        : error instanceof Error && error.message === expected;
    }
    // Do not print an unexpected driver error/cause containing SQL or private rows.
    if (!matched) {
      const category = (error: unknown): string => {
        if (error === undefined) return "none";
        if (error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid") return "writer_integrity_default";
        if (error instanceof PersistedProviderCaptureIntegrityError && error.message === "persisted provider capture evidence is invalid") return "capture_integrity_default";
        if (error instanceof Error && error.message === "0055 capture checkpoint fingerprint verification failed") return "0055_fingerprint";
        if (error instanceof Error && error.message === "0056 restore history fingerprint verification failed") return "0056_fingerprint";
        if (error instanceof Error && error.message === "0056 marker-loss or partial DDL requires controlled forward repair") return "0056_marker_loss";
        if (error instanceof Error && error.message === `database schema is missing required migrations: ${MIGRATION}`) return "0056_missing";
        return "other";
      };
      const errorClass = observed === undefined ? "none"
        : observed instanceof TenantTelemetryWriteIntegrityError ? "TenantTelemetryWriteIntegrityError"
          : observed instanceof PersistedProviderCaptureIntegrityError ? "PersistedProviderCaptureIntegrityError"
            : observed instanceof Error ? "Error" : "non_error";
      const expectedCategory = expected === "pending" ? "writer_integrity_default" : category(new Error(expected));
      throw new Error(`pre0056-startup-diagnostic:${JSON.stringify({ schema: "pre0056-startup-diagnostic-v1",
        mode, expected: expectedCategory, errorClass, messageCategory: category(observed) })}`);
    }
  }
  async function assertCurrentSchema(conn: Connection) {
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    expect(markers.map((row) => row.name)).toEqual(currentNames);
    expect(Number(guards[0]?.n)).toBe(720);
    assertTableSet("new-schema", await tableNames(conn), expectedCurrentTables);
  }
  async function oldVerify(url: string, expected: "pending" | "fingerprint") {
    return runFixed(`exact frozen startup ${expected} oracle`, process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0056-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0055_REJECTION: expected }), 30_000);
  }
  it("preserves every old row and exact 0055 selected checkpoint while enabling only prepared maintenance cold-read", async () => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      // Before the upgrade old startup must fail pending, not schema verification.
      expect(await oldVerify(f.url, "pending")).toBe("frozen-0055-verify-pending-rejected");
      const oldTables = await tableNames(conn), before = await businessDigests(conn);
      assertTableSet("old-schema", oldTables, expectedOldTables);
      assertTableSet("old-business", Object.keys(before), expectedOldTables.filter((name) => name !== "schema_migrations"));
      for (const table of OLD_CHECKPOINT_TABLES) expect(before[table]!.rows > 0, table).toBe(true);
      expect(before.tenant_telemetry_capture_backup_checkpoints?.rows).toBe(1);
      expect(before.tenant_telemetry_capture_backup_checkpoint_leaves?.rows).toBe(f.result.checkpointLeafCount);
      expect(before.tenant_telemetry_capture_restore_bindings?.rows).toBe(1);
      expect(before.tenant_telemetry_capture_v2_failure_commit_receipts?.rows).toBe(3);
      expect(before.tenant_telemetry_capture_v2_activation_receipts?.rows).toBe(1);
      const priorCheckpoint = await readTenantTelemetryCaptureCheckpointFromMysql(conn, f.result.selector.backupId, REF_KEY);
      expect(priorCheckpoint?.checkpoint.checkpointSha256).toBe(f.result.checkpointSha256);
      expect(priorCheckpoint?.checkpoint.families.find((row) => row.family === "write_job"))
        .toMatchObject({ rowCount: 3, states: { queued: 1, reserved: 1, written: 1 } });
      expect(priorCheckpoint?.checkpoint.families.find((row) => row.family === "write_payload")?.rowCount).toBe(2);
      expect(priorCheckpoint?.checkpoint.families.find((row) => row.family === "write_ack")?.rowCount).toBe(1);
      expect((priorCheckpoint?.checkpoint.families.find((row) => row.family === "legacy_failure")?.legacyUnknownCount ?? 0) > 0).toBe(true);
      expect(priorCheckpoint?.checkpoint).toMatchObject({ executionReady: false, erasureAuthorized: false,
        externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
      // apply commits the new expand-only DDL/marker, then ordinary primary-only
      // capture startup must STILL reject the existing prepared restore run.
      await assertRejected(f.url, "apply", "pending");
      await assertCurrentSchema(conn);
      assertTableSet("new-schema", await tableNames(conn), [...oldTables, NEW_TABLE]);
      expect(await businessDigests(conn)).toEqual(before); await assertNoAutomaticHistory(conn);
      expect(await readTenantTelemetryCaptureCheckpointFromMysql(conn, f.result.selector.backupId, REF_KEY)).toEqual(priorCheckpoint);
      // It is not enough to observe ANY rejection: frozen 0055 must now reject
      // the new strict schema, rather than pass schema and hit its prior gate.
      expect(await oldVerify(f.url, "fingerprint")).toBe("frozen-0055-verify-fingerprint-rejected");
      await assertRejected(f.url, "verify", "pending");
      const maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
        url: f.url, migrationsDir: currentDir, connectionLimit: 2,
        tenantTelemetryRefKey: REF_KEY, selector: f.result.selector });
      try {
        expect(Object.isFrozen(maintenance)).toBe(true);
        const run = await maintenance.getTenantRestoreReplayRun(f.result.selector.restoreRunId);
        expect(run).toMatchObject({ restoreRunId: f.result.selector.restoreRunId, phase: "prepared",
          runtimeEpochSha256: f.result.runtimeEpochSha256 });
        expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toBeNull();
        const runtime = await maintenance.getTenantRestoreRuntimeControl();
        expect(runtime.state).toBe("active");
        if (runtime.state !== "active") throw new Error("historical primary runtime missing");
        expect(runtime.lineageKind).toBe("primary");
        expect(runtime.runtimeEpochSha256).not.toBe(f.result.runtimeEpochSha256);
      } finally { await maintenance.close(); }
      // Cold open/read must not materialize receipts, rewrite activation/source,
      // prepare another run, or silently switch the primary runtime epoch.
      expect(await businessDigests(conn)).toEqual(before); await assertNoAutomaticHistory(conn);
      await assertRejected(f.url, "verify", "pending");
    } finally { await conn.end(); }
  }, 150_000);
  it.each(["marker-loss", "trigger-drift"] as const)("rejects historical %s without repair, activation or old-row mutation", async (kind) => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      await assertRejected(f.url, "apply", "pending"); await assertCurrentSchema(conn); await assertNoAutomaticHistory(conn);
      if (kind === "marker-loss") await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      else await conn.query("DROP TRIGGER trg_tt_capture_restore_history_immutable_update");
      const schema = await schemaDigest(conn), business = await businessDigests(conn);
      await assertRejected(f.url, "apply", kind === "marker-loss"
        ? "0056 marker-loss or partial DDL requires controlled forward repair"
        : "0056 restore history fingerprint verification failed");
      // verify-only must also refuse this exact drift before pending-runtime audit.
      await assertRejected(f.url, "verify", kind === "marker-loss"
        ? `database schema is missing required migrations: ${MIGRATION}`
        : "0056 restore history fingerprint verification failed");
      expect(await schemaDigest(conn)).toBe(schema); expect(await businessDigests(conn)).toEqual(business);
      await assertNoAutomaticHistory(conn);
    } finally { await conn.end(); }
  }, 150_000);
});
