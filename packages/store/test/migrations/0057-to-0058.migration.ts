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
  readTenantTelemetryCaptureCheckpointFromMysql, type TenantTelemetryCaptureRestoreMaintenanceSelector } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const SOURCE_COMMIT = "3414b43febd927108ff6e94cab4875499d7d2ea6";
const OLD_MARKER = "0057_tenant_telemetry_capture_epoch_cutover.sql";
const MIGRATION = "0058_tenant_telemetry_capture_repeat_restore.sql";
const REF_KEY = Buffer.alloc(32, 0x43); // Public fixture constant, not operator key input.
const NEW_TABLES = ["tenant_telemetry_capture_checkpoint_lineage_leaves", "tenant_telemetry_capture_recovery_permits_v2"] as const;
const OLD_CHECKPOINT_TABLES = ["tenant_telemetry_capture_backup_checkpoints", "tenant_telemetry_capture_backup_checkpoint_leaves",
  "tenant_telemetry_capture_restore_bindings", "tenant_telemetry_capture_restore_history_receipts"] as const;
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const WRITER_STAGES = ["input", "connect", "legacy", "activate", "source", "claim", "reserve", "ack", "retry", "finish", "anchor", "checkpoint",
  "availability", "preflight", "epoch-reserve", "prepare", "replay", "restore-activate", "cutover", "cold-open", "recover", "proof"];
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"];
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantTelemetryCaptureRestoreIntegrityError", "TenantBackupCatalogConflictError", "TenantBackupCatalogNotReadyError", "TenantErasureIntegrityError",
  "TenantTelemetryWriteIntegrityError"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function disposableBase(raw: string): URL {
  const url = new URL(raw), name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(name)) throw new Error("0058 fixture requires a local disposable MySQL base");
  return url;
}
function databaseUrl(base: URL, database: string): string {
  if (database !== "mysql" && !/^agent_service_migration_test_0058_[0-9]+_[0-9a-f]{8}$/.test(database)) throw new Error("unsafe 0058 database target");
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, TMPDIR: temp, CI: "1", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
function childDiagnostic(error: unknown, kind: "writer" | "verify"): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = `pre0058-frozen-${kind}-diagnostic:`, line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const row = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row)) return "";
    if (kind === "writer") {
      if (Object.keys(row).sort().join(",") !== "code,name,schema,stage" || row.schema !== "pre0058-frozen-writer-diagnostic-v1"
        || typeof row.stage !== "string" || !WRITER_STAGES.includes(row.stage)
        || typeof row.code !== "string" || !WRITER_CODES.includes(row.code) || typeof row.name !== "string" || !WRITER_NAMES.includes(row.name)) return "";
      return ` (writerStage=${row.stage}, code=${row.code}, name=${row.name})`;
    }
    if (Object.keys(row).sort().join(",") !== "errorClass,expected,messageCategory,observed,schema"
      || row.schema !== "pre0058-frozen-verify-diagnostic-v1"
      || !["accepted", "pending", "fingerprint"].includes(String(row.expected))
      || !["accepted", "pending", "fingerprint", "unexpected"].includes(String(row.observed))
      || !["none", "Error", "non_error", "TenantTelemetryWriteIntegrityError", "PersistedProviderCaptureIntegrityError"].includes(String(row.errorClass))
      || !["none", "writer_integrity_default", "capture_integrity_default", "0057_fingerprint", "other"].includes(String(row.messageCategory))) return "";
    return ` (verifyExpected=${String(row.expected)}, observed=${String(row.observed)}, errorClass=${String(row.errorClass)}, messageCategory=${String(row.messageCategory)})`;
  } catch { return ""; }
}
async function runFixed(stage: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const detail = file !== process.execPath ? ""
      : args.includes("packages/store/test/fixtures/pre0058-old-writer-driver.ts") ? childDiagnostic(error, "writer")
        : args.includes("packages/store/test/fixtures/pre0058-old-verify-probe.ts") ? childDiagnostic(error, "verify") : "";
    throw new Error(`frozen 0057 fixture stage failed: ${stage}${detail}`); // Never emit child output, cause, DSN, rows, or key.
  }
}
async function copyIsolatedDependencies(checkout: string): Promise<void> {
  const projects = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk", "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"];
  await installFrozenDependencies(ROOT, checkout);
  const linked = projects.filter((project) => project !== "packages/testkit");
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0057 dependency store is not isolated");
  const realCheckout = await realpath(checkout); let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...linked]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) throw new Error("frozen 0057 workspace dependency escapes source archive");
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0057 workspace dependency links missing");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("historical metadata identifier invalid");
  return `\`${value}\``;
}
async function declaredTableSet(dir: string, names: readonly string[]): Promise<string[]> {
  const tables = new Set(["schema_migrations"]);
  for (const name of names) {
    const sql = (await readFile(join(dir, name), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\r\n]*/g, "");
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
async function tableNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT table_name AS name,table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY BINARY table_name");
  if (!rows.length || rows.some((row) => row.kind !== "BASE TABLE")) throw new Error("historical base tables missing");
  return rows.map((row) => { identifier(row.name); return String(row.name); });
}
/** All old physical business rows, including checkpoint leaves, P1 and original
 * R's complete job envelope. Only schema_migrations may append its new marker. */
async function businessDigests(conn: Connection): Promise<Record<string, { rows: number; sha256: string }>> {
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const table of (await tableNames(conn)).filter((name) => name !== "schema_migrations" && !NEW_TABLES.some((table) => table === name))) {
    const [keys] = await conn.query<RowDataPacket[]>("SELECT column_name AS name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name='PRIMARY' ORDER BY seq_in_index", [table]);
    if (!keys.length) throw new Error("historical table primary key missing");
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${identifier(table)} ORDER BY ${keys.map((key) => identifier(key.name)).join(",")}`);
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
async function assertNoNewEvidence(conn: Connection): Promise<void> {
  for (const table of NEW_TABLES) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${identifier(table)}`);
    expect(rows).toHaveLength(1); expect(Number(rows[0]?.n)).toBe(0);
  }
}
function mysqlMigrationStatements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}
function formalSplitterSource(source: string): string {
  const matches = [...source.matchAll(/^function mysqlMigrationStatements\(sql: string\): string\[\] \{\n[\s\S]*?^\}/gm)];
  if (matches.length !== 1) throw new Error("formal migration splitter source is not unique");
  return matches[0]![0];
}
interface History {
  scope: "frozen0057-repeat-upgrade-v1"; sourceCommit: string; marker: string; profile: "recovered" | "history-only";
  triggerCount: number; tableCount: number; sourceCounts: { queued: number; reserved: number; written: number }; legacyUnknownItemCount: number;
  activationReceiptSha256: string; checkpointSha256: string; checkpointLeafCount: number; historyReceiptSha256: string;
  cutoverReceiptSha256: string | null; permitReceiptSha256: string | null; reservedOperationSha256: string; queuedOperationSha256: string;
  originalReservationReceiptSha256: string; pendingWriteDenied: true; sourceBackupSha256: string; runtimeEpochSha256: string;
  selector: TenantTelemetryCaptureRestoreMaintenanceSelector;
  actualFixtureAckCount: 1; actualSinkWriteCount: 0; sourceSinkDurable: false; catalogProtocolFixture: true;
  artifactBytesAuthenticated: false; physicalRestoreExecuted: false; runtimeActivated: true;
  externalDispositionExecuted: false; freshFleetHttpProven: false; productionAccepted: false;
}

describe("0057 -> 0058 exact frozen-source repeat capture restore historical MySQL upgrade", () => {
  let admin: Connection, base: URL, archiveRoot: string, checkout: string, currentDir: string;
  let oldNames: string[], currentNames: string[], expectedOldTables: string[], expectedCurrentTables: string[], partialPrefix: string[];
  const owned = new Set<string>();
  beforeAll(async () => {
    base = disposableBase(BASE); admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0057-"));
    checkout = join(archiveRoot, "checkout"); currentDir = join(archiveRoot, "current-migrations");
    await mkdir(checkout); await mkdir(currentDir);
    expect((await runFixed("resolve exact published old source", "git", ["rev-parse", SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 10_000)).trim()).toBe(SOURCE_COMMIT);
    const tar = join(archiveRoot, "frozen0057.tar");
    await runFixed("archive exact published source", "git", ["archive", "--format=tar", `--output=${tar}`, SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract own archive", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe(OLD_MARKER);
    currentNames = (await readdir(MIGRATIONS)).filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 58).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    for (const name of oldNames) expect((await readFile(join(checkout, "packages/store/migrations", name))).equals(await readFile(join(MIGRATIONS, name)))).toBe(true);
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    expectedOldTables = await declaredTableSet(join(checkout, "packages/store/migrations"), oldNames);
    expectedCurrentTables = await declaredTableSet(currentDir, currentNames);
    expect(expectedCurrentTables).toEqual([...expectedOldTables, ...NEW_TABLES].sort());
    expect(formalSplitterSource(await readFile(fileURLToPath(import.meta.url), "utf8")))
      .toBe(formalSplitterSource(await readFile(join(ROOT, "packages/store/src/mysql/store.ts"), "utf8")));
    const statements = mysqlMigrationStatements(await readFile(join(currentDir, MIGRATION), "utf8"));
    const firstBootstrap = statements.findIndex((statement) => statement.startsWith("CREATE TRIGGER trg_tt_capture_repeat_bootstrap_permit_bi "));
    expect(firstBootstrap).toBeGreaterThanOrEqual(2);
    partialPrefix = statements.slice(0, firstBootstrap + 1);
    expect(partialPrefix.filter((statement) => statement.startsWith("CREATE TABLE "))).toHaveLength(2);
    expect(partialPrefix.filter((statement) => statement.startsWith("CREATE TRIGGER "))).toHaveLength(8);
    expect(partialPrefix.every((statement) => statement.startsWith("CREATE TABLE ") || statement.startsWith("CREATE TRIGGER "))).toBe(true);
    const fixtures = join(checkout, "packages/store/test/fixtures"); await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0058-old-writer-driver.ts", "pre0058-old-verify-probe.ts"]) await copyFile(join(HERE, "../fixtures", name), join(fixtures, name));
    await copyIsolatedDependencies(checkout);
    await runFixed("offline frozen source compile", process.execPath, ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"], checkout, isolatedEnv(archiveRoot));
  }, 420_000);
  afterAll(async () => {
    if (admin) {
      for (const name of owned) {
        if (!/^agent_service_migration_test_0058_[0-9]+_[0-9a-f]{8}$/.test(name)) throw new Error("unsafe 0058 fixture cleanup target");
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });
  async function history(profile: History["profile"] = "recovered") {
    const name = `agent_service_migration_test_0058_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
    if (existing.length) throw new Error("0058 fixture database already exists");
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url = databaseUrl(base, name);
    const output = await runFixed("actual frozen restored business and pending source", process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0058-old-writer-driver.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, FROZEN_0057_PROFILE: profile }), 120_000);
    let result: History;
    try { result = JSON.parse(output) as History; } catch { throw new Error("frozen 0057 writer output invalid"); }
    expect(result).toMatchObject({ scope: "frozen0057-repeat-upgrade-v1", sourceCommit: SOURCE_COMMIT, profile,
      marker: OLD_MARKER, triggerCount: 728, tableCount: expectedOldTables.length,
      sourceCounts: { queued: 1, reserved: 1, written: 1 }, legacyUnknownItemCount: 1, pendingWriteDenied: true,
      actualFixtureAckCount: 1, actualSinkWriteCount: 0, sourceSinkDurable: false, catalogProtocolFixture: true,
      artifactBytesAuthenticated: false, physicalRestoreExecuted: false, runtimeActivated: true,
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false });
    for (const value of [result.activationReceiptSha256, result.checkpointSha256, result.historyReceiptSha256, result.sourceBackupSha256,
      result.runtimeEpochSha256, result.originalReservationReceiptSha256, result.reservedOperationSha256, result.queuedOperationSha256]) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(result.selector.checkpointSha256).toBe(result.checkpointSha256);
    expect(Number.isSafeInteger(result.checkpointLeafCount) && result.checkpointLeafCount > 0).toBe(true);
    if (profile === "recovered") {
      expect(result.cutoverReceiptSha256).toMatch(/^[0-9a-f]{64}$/); expect(result.permitReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
    } else { expect(result.cutoverReceiptSha256).toBeNull(); expect(result.permitReceiptSha256).toBeNull(); }
    return { url, result };
  }
  async function assertCurrentOpen(url: string, mode: "apply" | "verify", expected: "accepted" | "pending" | string): Promise<void> {
    let store: MysqlSessionStore | undefined;
    try {
      store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode: mode, tenantTelemetryRefKey: REF_KEY,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
      if (expected !== "accepted") throw new Error("expected frozen-source startup rejection absent");
      const proof = await store.getTenantTelemetryPersistedProviderCaptureBinding();
      expect(proof).not.toBeNull();
    } catch (error) {
      const matched = expected === "pending"
        ? error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid"
        : expected !== "accepted" && error instanceof Error && error.message === expected;
      if (!matched) {
        const errorClass = error instanceof TenantTelemetryWriteIntegrityError ? "TenantTelemetryWriteIntegrityError"
          : error instanceof PersistedProviderCaptureIntegrityError ? "PersistedProviderCaptureIntegrityError" : error instanceof Error ? "Error" : "non_error";
        const category = error instanceof Error && error.message === "0058 capture repeat restore fingerprint verification failed" ? "0058_fingerprint"
          : error instanceof Error && error.message === "0058 marker-loss or partial DDL requires controlled forward repair" ? "0058_marker_loss"
            : error instanceof Error && error.message === `database schema is missing required migrations: ${MIGRATION}` ? "0058_missing"
              : error instanceof TenantTelemetryWriteIntegrityError && error.message === "tenant telemetry write evidence is invalid" ? "writer_integrity_default" : "other";
        throw new Error(`pre0058-startup-diagnostic:${JSON.stringify({ schema: "pre0058-startup-diagnostic-v1", mode, expected: expected === "accepted" ? "accepted" : "rejected", errorClass, category })}`);
      }
    } finally { await store?.close(); }
  }
  async function assertCurrentSchema(conn: Connection): Promise<void> {
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    expect(markers.map((row) => row.name)).toEqual(currentNames);
    expect(Number(guards[0]?.n)).toBe(735);
    expect(await tableNames(conn)).toEqual(expectedCurrentTables);
  }
  async function oldVerify(url: string, expected: "accepted" | "pending" | "fingerprint") {
    return runFixed(`exact frozen startup ${expected} oracle`, process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0058-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0057_OUTCOME: expected }), 30_000);
  }
  async function coreEvidence(conn: Connection, result: History) {
    const [headers] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?", [result.selector.backupId]);
    const [histories] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_capture_restore_history_receipts WHERE BINARY restore_run_id=BINARY ?", [result.selector.restoreRunId]);
    const [cutovers] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_capture_epoch_cutovers WHERE BINARY restore_run_id=BINARY ?", [result.selector.restoreRunId]);
    const [permits] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_capture_recovery_permits WHERE BINARY write_operation_sha256=BINARY ? ORDER BY new_claim_attempt", [result.reservedOperationSha256]);
    const [reserved] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?", [result.reservedOperationSha256]);
    expect(headers).toHaveLength(1); expect(histories).toHaveLength(1); expect(reserved).toHaveLength(1);
    expect(cutovers).toHaveLength(result.profile === "recovered" ? 1 : 0); expect(permits).toHaveLength(result.profile === "recovered" ? 1 : 0);
    expect(histories[0]?.history_receipt_sha256).toBe(result.historyReceiptSha256);
    expect(reserved[0]?.phase).toBe("queued");
    expect(reserved[0]?.mutation_reservation_receipt_sha256).toBe(result.originalReservationReceiptSha256);
    if (result.profile === "recovered") {
      expect(cutovers[0]?.cutover_receipt_sha256).toBe(result.cutoverReceiptSha256);
      expect(permits[0]?.permit_receipt_sha256).toBe(result.permitReceiptSha256);
      const raw: unknown = permits[0]?.receipt_json;
      const permit = (typeof raw === "string" ? JSON.parse(raw) : raw) as { reservationAtIssue?: unknown };
      expect(permit.reservationAtIssue).toMatchObject({ origin: "checkpoint", receiptSha256: result.originalReservationReceiptSha256 });
    }
    // Preserve exact complete row envelopes without exposing their body or
    // lease token in an assertion diff; only content-free hashes leave here.
    return { headers: digest(headers), histories: digest(histories), cutovers: digest(cutovers),
      permits: digest(permits), reserved: digest(reserved) };
  }
  it.each(["recovered", "history-only"] as const)("preserves actual frozen0057 %s CP1/history/P1/original-R bytes without historical backfill", async (profile) => {
    const f = await history(profile), conn = await mysql.createConnection(f.url);
    try {
      expect(await oldVerify(f.url, profile === "recovered" ? "accepted" : "pending"))
        .toBe(profile === "recovered" ? "frozen-0057-verify-runtime-accepted" : "frozen-0057-verify-pending-rejected");
      const before = await businessDigests(conn), core = await coreEvidence(conn, f.result);
      expect(await tableNames(conn)).toEqual(expectedOldTables);
      expect(Object.keys(before).sort()).toEqual(expectedOldTables.filter((name) => name !== "schema_migrations"));
      for (const table of OLD_CHECKPOINT_TABLES) expect(before[table]!.rows > 0, table).toBe(true);
      expect(before.tenant_telemetry_capture_v2_failure_commit_receipts?.rows).toBe(3);
      const prior = await readTenantTelemetryCaptureCheckpointFromMysql(conn, f.result.selector.backupId, REF_KEY);
      expect(prior?.checkpoint.scope).toBe("tenant-telemetry-capture-backup-checkpoint-v1");
      expect(prior?.checkpoint.checkpointSha256).toBe(f.result.checkpointSha256);
      expect(prior?.checkpoint.families.find((row) => row.family === "write_job"))
        .toMatchObject({ rowCount: 3, states: { queued: 1, reserved: 1, written: 1 } });
      expect(prior?.checkpoint.families.find((row) => row.family === "write_payload")?.rowCount).toBe(2);
      expect(prior?.checkpoint.families.find((row) => row.family === "write_ack")?.rowCount).toBe(1);
      const oldUnknown = prior?.leaves.filter((leaf) => leaf.family === "legacy_failure");
      expect((oldUnknown?.length ?? 0) > 0).toBe(true);
      expect(oldUnknown?.every((leaf) => leaf.knowledge === "legacy_unknown")).toBe(true);
      await assertCurrentOpen(f.url, "apply", profile === "recovered" ? "accepted" : "pending");
      await assertCurrentSchema(conn); await assertNoNewEvidence(conn);
      expect(await businessDigests(conn)).toEqual(before); expect(await coreEvidence(conn, f.result)).toEqual(core);
      expect(await readTenantTelemetryCaptureCheckpointFromMysql(conn, f.result.selector.backupId, REF_KEY)).toEqual(prior);
      // This must be the exact old strict 0057 schema rejection, not its old
      // pending gate and not a current binary pretending to be an old writer.
      expect(await oldVerify(f.url, "fingerprint")).toBe("frozen-0057-verify-fingerprint-rejected");
      await assertCurrentOpen(f.url, "verify", profile === "recovered" ? "accepted" : "pending");
      const maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
        url: f.url, migrationsDir: currentDir, connectionLimit: 2, tenantTelemetryRefKey: REF_KEY, selector: f.result.selector });
      try {
        expect(Object.isFrozen(maintenance)).toBe(true);
        expect((await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt())?.receiptSha256).toBe(f.result.historyReceiptSha256);
        expect((await maintenance.getTenantTelemetryCaptureEpochCutoverReceipt())?.receiptSha256 ?? null).toBe(f.result.cutoverReceiptSha256);
        expect(await maintenance.getTenantRestoreReplayRun(f.result.selector.restoreRunId))
          .toMatchObject({ phase: "active", runtimeEpochSha256: f.result.runtimeEpochSha256 });
      } finally { await maintenance.close(); }
      expect(await businessDigests(conn)).toEqual(before); expect(await coreEvidence(conn, f.result)).toEqual(core);
      await assertNoNewEvidence(conn);
    } finally { await conn.end(); }
  }, 150_000);
  it.each(["marker-loss", "partial-DDL"] as const)("rejects actual frozen0057 %s and requires controlled forward repair without rewriting old evidence", async (kind) => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      if (kind === "marker-loss") {
        await assertCurrentOpen(f.url, "apply", "accepted"); await assertCurrentSchema(conn); await assertNoNewEvidence(conn);
        await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      } else {
        for (const statement of partialPrefix) await conn.query(statement);
        expect(await tableNames(conn)).toEqual(expectedCurrentTables);
        const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
        expect(markers.map((row) => row.name)).toEqual(oldNames);
        const [bootstrap] = await conn.query<RowDataPacket[]>(`SELECT trigger_name AS name FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_tt_capture_repeat_bootstrap_%' ORDER BY BINARY trigger_name`);
        expect(bootstrap.map((row) => row.name)).toEqual(["trg_tt_capture_repeat_bootstrap_permit_bi"]);
      }
      const schema = await schemaDigest(conn), before = await businessDigests(conn), core = await coreEvidence(conn, f.result);
      await assertCurrentOpen(f.url, "apply", "0058 marker-loss or partial DDL requires controlled forward repair");
      await assertCurrentOpen(f.url, "verify", `database schema is missing required migrations: ${MIGRATION}`);
      expect(await schemaDigest(conn)).toBe(schema); expect(await businessDigests(conn)).toEqual(before);
      expect(await coreEvidence(conn, f.result)).toEqual(core); await assertNoNewEvidence(conn);
    } finally { await conn.end(); }
  }, 150_000);
});
