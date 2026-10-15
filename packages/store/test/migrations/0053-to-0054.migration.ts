import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";
import { derive0054SourcePlan } from "../fixtures/derive0054-fingerprint.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const SOURCE_COMMIT = "e41114392e028efff474b2c5ac13df3784b83228";
const MIGRATION = "0054_tenant_telemetry_retained_source.sql";
const REF_KEY = Buffer.alloc(32, 0x43); // Fixed, non-secret fixture key; never production input.
const NEW_TABLES = ["t1_entries", "t1_receipts", "catalog_sources", "catalog_targets", "catalog_receipts",
  "usage_entries", "usage_receipts", "canonical_entries", "canonical_receipts"]
  .map((suffix) => `tenant_telemetry_retained_source_${suffix}`);
const ROTATIONS = [
  { kind: "t3d_catalog", primary: "trg_tt_plan_artifact_target_t3d_terminal_bu" },
  { kind: "t3d_capture", primary: "trg_tt_capture_v2_t3d_bu" },
  { kind: "t3f_capture", primary: "trg_tt_capture_v2_t3f_bu" },
  { kind: "usage_delete", primary: "trg_tt_capture_v2_usage_bd" },
] as const;
const BOOTSTRAPS = ROTATIONS.flatMap(({ kind }) => ["a", "b"]
  .map((suffix) => `trg_tt_retained_${kind}_bootstrap_${suffix}`));
const TAIL_GUARDS = [
  "trg_tt_retained_items_bd", "trg_tt_retained_events_bd", "trg_tt_retained_turns_bd",
  "trg_tt_retained_sessions_bd", "trg_tt_retained_tenants_bd",
  "trg_tt_retained_t1_roots_bi", "trg_tt_retained_catalog_roots_bi",
  "trg_tt_retained_usage_roots_bi", "trg_tt_retained_canonical_roots_bi",
] as const;
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error("0054 fixture requires a local disposable MySQL base");
  }
  return url;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, CI: "1", NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0", ...extra };
}
const WRITER_STAGES = [
  "input", "legacy-connect-pre53", "legacy-failed-step-pre53", "legacy-schema-proof",
  "legacy-connect53", "legacy-failed-step-gen0", "terminal-connect", "terminal-tenant-setup",
  "terminal-t1", "terminal-t3a", "terminal-t3b", "terminal-t3c", "terminal-t3d",
  "terminal-t3d-seal", "terminal-t3d-receipts", "terminal-t3e",
  "terminal-t3f", "terminal-proof", "active-connect", "active-journal", "active-lifecycle",
  "active-capture-activation", "active-tenant-setup", "active-source-fixture", "active-source-commit",
  "active-source-claim", "active-source-reserve", "active-source-write", "active-source-ack",
  "active-source-finish", "active-t1", "active-t1-proof",
] as const;
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE",
  "ER_PARSE_ERROR", "ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "AssertionError",
  "PersistedProviderCaptureConflictError", "PersistedProviderCaptureIntegrityError",
  "TenantErasureIntegrityError", "TenantPurgePlanNotReadyError", "TenantPurgePlanEvidenceChangedError",
  "TenantPurgeExecutionNotReadyError", "TenantPurgeExecutionEvidenceChangedError",
  "TenantDatabasePurgeNotReadyError", "TenantDatabasePurgeEvidenceChangedError",
  "TenantRestoreJournalPublicationDependencyPendingError"] as const;
function writerDiagnostic(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)
    || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = "pre0054-frozen-writer-diagnostic:";
  const line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "code,name,schema,stage") return "";
    const row = value as Record<string, unknown>;
    if (row.schema !== "pre0054-frozen-writer-diagnostic-v1"
      || !WRITER_STAGES.some((stage) => stage === row.stage)
      || !WRITER_CODES.some((code) => code === row.code)
      || !WRITER_NAMES.some((name) => name === row.name)) return "";
    return ` (writerStage=${String(row.stage)}, code=${String(row.code)}, name=${String(row.name)})`;
  } catch { return ""; }
}
async function runFixed(stage: string, file: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const diagnostic = file === process.execPath
      && args.includes("packages/store/test/fixtures/pre0054-old-writer-driver.ts") ? writerDiagnostic(error) : "";
    // Never attach the child error/cause or dump its stdout/stderr: only the
    // exact closed writer diagnostic is allowed into a test failure message.
    throw new Error(`frozen 0053 fixture stage failed: ${stage}${diagnostic}`);
  }
}
async function copyIsolatedDependencies(checkout: string) {
  const projects = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk",
    "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"];
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ...projects.map((path) => `${path}/package.json`)]) {
    if (!(await readFile(join(checkout, path))).equals(await readFile(join(ROOT, path)))) {
      throw new Error(`frozen 0053 dependency manifest changed: ${path}`);
    }
  }
  const fields = ["name", "private", "type", "version", "engines", "packageManager", "dependencies",
    "devDependencies", "optionalDependencies", "peerDependencies"];
  const oldRoot = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as Record<string, unknown>;
  const currentRoot = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  if (JSON.stringify(fields.map((field) => oldRoot[field] ?? null))
    !== JSON.stringify(fields.map((field) => currentRoot[field] ?? null))) {
    throw new Error("frozen 0053 root dependency contract changed");
  }
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(checkout, "node_modules"), options);
  const linkedProjects = projects.filter((project) => project !== "packages/testkit");
  for (const project of linkedProjects) await cp(join(ROOT, project, "node_modules"), join(checkout, project, "node_modules"), options);
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0053 dependencies are not isolated");
  const realCheckout = await realpath(checkout);
  let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...linkedProjects]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) {
        throw new Error("frozen 0053 workspace dependency escapes the source archive");
      }
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0053 workspace links are missing");
}
const BUSINESS_TABLES = [
  ["sessions", "session_id"], ["turns", "turn_id"], ["items", "item_id"], ["events", "session_id,seq"],
  ["usage_ledger", "usage_id"], ["billing_usage_facts", "usage_id"],
  ["tenant_erasure_admissions", "request_id"], ["tenant_purge_plan_jobs", "request_id"],
  ["tenant_telemetry_lifecycle_control", "singleton_id"],
  ["tenant_telemetry_lifecycle_targets", "singleton_id,domain"],
  ["tenant_telemetry_lifecycle_coverages", "tenant_id"],
  ["tenant_telemetry_lifecycle_subjects", "request_id"],
  ["tenant_telemetry_activation_receipts", "singleton_id"],
  ["tenant_telemetry_application_domain_controls", "domain"],
  ["tenant_telemetry_application_activation_receipts", "domain"],
  ["tenant_telemetry_application_coverages", "tenant_id,domain"],
  ["tenant_telemetry_application_write_bindings", "write_operation_sha256"],
  ["tenant_telemetry_capture_v2_controls", "domain"],
  ["tenant_telemetry_capture_v2_coverages", "tenant_id,domain"],
  ["tenant_telemetry_capture_v2_activation_receipts", "domain"],
  ["tenant_telemetry_artifact_inventory", "inventory_sha256"],
  ["tenant_telemetry_capture_v2_source_bindings", "write_operation_sha256"],
  ["tenant_telemetry_capture_v2_failure_commit_receipts", "write_operation_sha256"],
  ["tenant_telemetry_write_jobs", "write_operation_sha256"], ["tenant_telemetry_write_payloads", "write_operation_sha256"],
  ["tenant_telemetry_write_acks", "write_operation_sha256"], ["tenant_telemetry_artifact_memberships", "write_operation_sha256"],
  ["tenant_purge_plan_receipts", "request_id"], ["tenant_telemetry_source_accounting_receipts", "request_id"],
  ["tenant_purge_plan_entries", "request_id,build_generation,domain"],
  ["tenant_telemetry_source_accounting_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_target_manifest_entries", "request_id,source_kind,source_identity_sha256"],
  ["tenant_telemetry_plan_artifact_targets", "request_id,artifact_group_sha256"],
  ["tenant_telemetry_target_manifest_receipts", "request_id"], ["tenant_telemetry_plan_artifact_target_receipts", "request_id"],
  ["tenant_database_purge_receipts", "request_id"], ["tenant_telemetry_owner_closure_receipts", "request_id"],
  ["tenant_telemetry_owner_closure_entries", "request_id,write_operation_sha256"],
  ["tenant_purge_session_grave_markers", "session_id"],
] as const;
async function businessDigests(conn: Connection) {
  const result: Record<string, string> = {};
  for (const [table, order] of BUSINESS_TABLES) {
    const [columns] = await conn.query<RowDataPacket[]>("SELECT column_name AS column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position", [table]);
    const names = columns.map((column) => {
      if (Object.keys(column).length !== 1 || typeof column.column_name !== "string"
        || !/^[a-z][a-z0-9_]{0,63}$/.test(column.column_name)) {
        throw new Error("historical business column metadata is invalid");
      }
      return column.column_name;
    });
    if (new Set(names).size !== names.length) throw new Error("historical business column metadata is duplicated");
    const projection = names.filter((name) => name !== "telemetry_retained_source_protocol")
      .map((name) => `\`${name}\``).join(",");
    if (!projection) throw new Error("historical business projection is absent");
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${projection} FROM ${table} ORDER BY ${order}`);
    result[table] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  return result;
}
async function schemaSnapshot(conn: Connection) {
  const [columns] = await conn.query<RowDataPacket[]>("SELECT table_name AS table_name,column_name AS column_name,column_type AS column_type,is_nullable AS is_nullable,column_default AS column_default,collation_name AS collation_name,ordinal_position AS ordinal_position FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position");
  const [tables] = await conn.query<RowDataPacket[]>("SELECT table_name AS table_name,table_collation AS table_collation FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name");
  const [checks] = await conn.query<RowDataPacket[]>("SELECT constraint_name AS constraint_name,check_clause AS check_clause FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() ORDER BY constraint_name");
  const [indexes] = await conn.query<RowDataPacket[]>("SELECT table_name AS table_name,index_name AS index_name,seq_in_index AS seq_in_index,column_name AS column_name,non_unique AS non_unique,sub_part AS sub_part FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index");
  const [foreignKeys] = await conn.query<RowDataPacket[]>("SELECT table_name AS table_name,constraint_name AS constraint_name,referenced_table_name AS referenced_table_name,update_rule AS update_rule,delete_rule AS delete_rule FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() ORDER BY table_name,constraint_name");
  const [triggers] = await conn.query<RowDataPacket[]>("SELECT trigger_name AS trigger_name,event_manipulation AS event_manipulation,event_object_table AS event_object_table,action_timing AS action_timing,action_orientation AS action_orientation,action_condition AS action_condition,action_statement AS action_statement FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name");
  const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name");
  return { columns, tables, checks, indexes, foreignKeys, triggers, markers };
}
type GuardShape = {
  name: string; table: string; manipulation: string; timing: string;
  orientation: string; condition: string | null; action: string;
};
function normalizedAction(value: string): string {
  return value.replaceAll(/\s/g, "").replaceAll("`", "").replaceAll("_utf8mb4", "").toLowerCase();
}
function guardInventory(rows: readonly RowDataPacket[]): Map<string, GuardShape> {
  const guards = new Map<string, GuardShape>();
  for (const row of rows) {
    for (const field of ["trigger_name", "event_object_table", "event_manipulation", "action_timing",
      "action_orientation", "action_statement"] as const) {
      if (typeof row[field] !== "string") throw new Error("historical trigger metadata is invalid");
    }
    if (row.action_condition !== null && typeof row.action_condition !== "string") {
      throw new Error("historical trigger condition metadata is invalid");
    }
    const guard: GuardShape = {
      name: row.trigger_name, table: row.event_object_table, manipulation: row.event_manipulation,
      timing: row.action_timing, orientation: row.action_orientation, condition: row.action_condition,
      action: normalizedAction(row.action_statement),
    };
    if (guards.has(guard.name)) throw new Error("historical trigger inventory contains a duplicate");
    guards.set(guard.name, guard);
  }
  return guards;
}
function createdGuard(statement: string): GuardShape | null {
  const match = /^CREATE TRIGGER (\w+) BEFORE (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW ([\s\S]+)$/.exec(statement);
  if (!match) return null;
  return { name: match[1]!, table: match[3]!, manipulation: match[2]!, timing: "BEFORE",
    orientation: "ROW", condition: null, action: normalizedAction(match[4]!) };
}
function sortedGuards(guards: ReadonlyMap<string, GuardShape>) {
  return [...guards.entries()].sort(([left], [right]) => left.localeCompare(right));
}
function formalSplitterSource(source: string): string {
  const matches = [...source.matchAll(/^function mysqlMigrationStatements\(sql: string\): string\[\] \{\n[\s\S]*?^\}/gm)];
  if (matches.length !== 1) throw new Error("formal migration splitter source is not unique");
  return matches[0]![0];
}
function uniqueStatementIndex(statements: readonly string[], predicate: (statement: string) => boolean): number {
  const indexes = statements.flatMap((statement, index) => predicate(statement) ? [index] : []);
  if (indexes.length !== 1) throw new Error("0054 rotation source statement is not unique");
  return indexes[0]!;
}
async function assertNoNewEvidence(conn: Connection) {
  for (const table of NEW_TABLES) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`);
    expect(Number(rows[0]?.n)).toBe(0);
  }
  for (const table of ["tenant_erasure_admissions", "tenant_purge_plan_jobs"]) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table} WHERE telemetry_retained_source_protocol IS NOT NULL`);
    expect(Number(rows[0]?.n)).toBe(0);
  }
}
type LegacyHistory = { mode: "legacy"; sourceCommit: string; tenantId: string; userId: string;
  legacyPrivateColumnCount: number; legacyLastMarker: string; legacyTriggerCount: number;
  pre53: { tenantId: string; sessionId: string; turnId: string; itemId: string; stepIndex: number };
  gen0: { tenantId: string; sessionId: string; turnId: string; itemId: string; stepIndex: number } };
type ActiveHistory = { mode: "active"; sourceCommit: string; tenantId: string; userId: string; requestId: string;
  sources: { mode: string; sessionId: string; turnId: string; itemId: string; stepIndex: number; writeOperationSha256: string }[];
  sourceSink: "local-store-ack-fixture"; sourceSinkDurable: false; actualSinkWriteCount: 0;
  actualFixtureAckCount: number; externalDispositionExecuted: false; freshFleetHttpProven: false };
type TerminalHistory = { mode: "terminal"; sourceCommit: string; tenantId: string; requestId: string;
  planReceiptSha256: string; sourceReceiptSha256: string; manifestReceiptSha256: string; catalogReceiptSha256: string;
  terminalReceiptSha256: string; closureReceiptSha256: string; allDomainsComplete: false; externalDispositionExecuted: false };

describe("0053 -> 0054 exact frozen-source historical MySQL upgrade", () => {
  let admin: Connection;
  let base: URL;
  let archiveRoot: string;
  let checkout: string;
  let through0052: string;
  let currentDir: string;
  let oldNames: string[];
  let currentNames: string[];
  let installation: string[];
  const databases = new Set<string>();
  beforeAll(async () => {
    base = disposableBase(BASE);
    admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0053-"));
    checkout = join(archiveRoot, "checkout"); await mkdir(checkout);
    through0052 = join(archiveRoot, "through0052"); await mkdir(through0052);
    currentDir = join(archiveRoot, "current-migrations"); await mkdir(currentDir);
    expect((await runFixed("resolve published source", "git", ["rev-parse", SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 10_000)).trim()).toBe(SOURCE_COMMIT);
    const tar = join(archiveRoot, "frozen0053.tar");
    await runFixed("archive exact source", "git", ["archive", "--format=tar", `--output=${tar}`, SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract own archive", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe("0053_persisted_provider_failure_capture.sql");
    // This fixture proves the exact 0054 boundary (including its 712 guards),
    // not a later tail. Newer boundaries have their own historical fixtures.
    currentNames = (await readdir(MIGRATIONS))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 54).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    for (const name of oldNames) {
      const frozen = await readFile(join(checkout, "packages/store/migrations", name));
      expect(frozen.equals(await readFile(join(MIGRATIONS, name)))).toBe(true);
      if (Number(name.slice(0, 4)) <= 52) await copyFile(join(checkout, "packages/store/migrations", name), join(through0052, name));
    }
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    // Use the same finite, complete installation grammar as the independent
    // fingerprint fixture, with the actual formal executor's splitter unchanged.
    // This is not a hand-picked one-trigger approximation of a migration prefix.
    const executor = await readFile(join(ROOT, "packages/store/src/mysql/store.ts"), "utf8");
    const sourcePlanFixture = await readFile(join(HERE, "../fixtures/derive0054-fingerprint.ts"), "utf8");
    expect(formalSplitterSource(sourcePlanFixture)).toBe(formalSplitterSource(executor));
    installation = derive0054SourcePlan(await readFile(join(currentDir, MIGRATION), "utf8")).install;
    const firstRemoval = Math.min(...BOOTSTRAPS.map((name) => uniqueStatementIndex(installation,
      (statement) => statement === `DROP TRIGGER ${name}`)));
    for (const name of TAIL_GUARDS) {
      expect(uniqueStatementIndex(installation, (statement) => createdGuard(statement)?.name === name))
        .toBeLessThan(firstRemoval);
    }
    const fixtures = join(checkout, "packages/store/test/fixtures"); await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0054-old-writer-driver.ts", "pre0054-old-verify-probe.ts"]) {
      await copyFile(join(HERE, "../fixtures", name), join(fixtures, name));
    }
    await copyIsolatedDependencies(checkout);
    await runFixed("offline frozen source compile", process.execPath,
      ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"], checkout, isolatedEnv(archiveRoot));
  }, 420_000);
  afterAll(async () => {
    if (admin) {
      for (const name of databases) {
        if (!/^agent_service_migration_test_0054_[0-9]+_[0-9a-f]{8}$/.test(name)) throw new Error("unsafe 0054 fixture cleanup target");
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });
  async function history<M extends "legacy" | "active" | "terminal">(mode: M) {
    const database = `agent_service_migration_test_0054_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database]);
    if (existing.length) throw new Error("0054 fixture database already exists");
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); databases.add(database);
    const url = databaseUrl(base, database);
    const output = await runFixed(`actual frozen ${mode} business`, process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0054-old-writer-driver.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, PRE0054_FIXTURE_MODE: mode, PRE0054_THROUGH0052_DIR: through0052 }));
    type Result = M extends "legacy" ? LegacyHistory : M extends "active" ? ActiveHistory : TerminalHistory;
    let result: Result;
    try { result = JSON.parse(output) as Result; } catch { throw new Error("frozen 0053 writer output is invalid"); }
    expect(result.sourceCommit).toBe(SOURCE_COMMIT); expect(result.mode).toBe(mode);
    return { url, result };
  }
  async function connect(url: string, migrationMode: "apply" | "verify" = "apply") {
    return MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode,
      tenantTelemetryRefKey: REF_KEY, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  }
  async function upgrade(url: string, mode: "apply" | "verify" = "apply") {
    const store = await connect(url, mode); await store.close();
  }
  async function oldVerify(url: string, rejected: boolean) {
    return runFixed("exact frozen startup oracle", process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0054-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0053_FINGERPRINT_REJECTION: rejected ? "1" : "0" }), 30_000);
  }

  it("preserves actual pre53 NULL and inactive gen0 failures without backfill or activation", async () => {
    const f = await history("legacy"); const conn = await mysql.createConnection(f.url);
    try {
      expect(f.result).toMatchObject({ legacyPrivateColumnCount: 0,
        legacyLastMarker: "0052_ordinary_session_usage_retention.sql", legacyTriggerCount: 647 });
      expect(await oldVerify(f.url, false)).toBe("frozen-0053-verify-accepted");
      const before = await businessDigests(conn); const schema = await schemaSnapshot(conn);
      expect(schema.triggers).toHaveLength(662);
      expect(schema.markers.map((row) => row.name)).toEqual(oldNames);
      const [beforePrivate] = await conn.query<RowDataPacket[]>("SELECT item_id,telemetry_failure_classification,telemetry_capture_v2_control_generation FROM items WHERE item_id IN (?,?) ORDER BY item_id", [f.result.pre53.itemId, f.result.gen0.itemId]);
      expect(beforePrivate.find((row) => row.item_id === f.result.pre53.itemId)).toMatchObject({ telemetry_failure_classification: null, telemetry_capture_v2_control_generation: null });
      expect(beforePrivate.find((row) => row.item_id === f.result.gen0.itemId)).toMatchObject({ telemetry_failure_classification: "runtime_unknown", telemetry_capture_v2_control_generation: 0 });
      await upgrade(f.url);
      expect(await businessDigests(conn)).toEqual(before); await assertNoNewEvidence(conn);
      const [afterPrivate] = await conn.query<RowDataPacket[]>("SELECT item_id,telemetry_failure_classification,telemetry_capture_v2_control_generation FROM items WHERE item_id IN (?,?) ORDER BY item_id", [f.result.pre53.itemId, f.result.gen0.itemId]);
      expect(afterPrivate).toEqual(beforePrivate);
      const after = await schemaSnapshot(conn);
      expect(after.markers.map((row) => row.name)).toEqual(currentNames);
      expect(after.tables.filter((row) => NEW_TABLES.includes(String(row.table_name)))).toHaveLength(9);
      expect(after.columns.filter((row) => row.column_name === "telemetry_retained_source_protocol")).toHaveLength(2);
      expect(after.triggers).toHaveLength(712);
      expect(after.triggers.filter((row) => String(row.trigger_name).startsWith("trg_tt_retained_") && String(row.trigger_name).includes("bootstrap"))).toEqual([]);
      const store = await connect(f.url, "verify");
      try {
        expect(await store.getTenantTelemetryPersistedProviderCaptureBinding()).toBeNull();
        expect(await store.getTenantTelemetryPersistedProviderCaptureControl()).toEqual({ domain: "logs", state: "inactive", controlGeneration: 0 });
        expect(await store.verifyPersistedProviderStepFailureSource(f.result.pre53)).toMatchObject({ status: "not_found", sourceCount: 0, executionReady: false });
      } finally { await store.close(); }
      expect(await oldVerify(f.url, true)).toBe("frozen-0053-verify-fingerprint-rejected");
    } finally { await conn.end(); }
  }, 150_000);

  it("retains genuine old inactive T3d/T3f hashes and NULL protocol as historical unknown", async () => {
    const f = await history("terminal"); const conn = await mysql.createConnection(f.url);
    try {
      expect(await oldVerify(f.url, false)).toBe("frozen-0053-verify-accepted");
      const before = await businessDigests(conn);
      await upgrade(f.url); expect(await businessDigests(conn)).toEqual(before); await assertNoNewEvidence(conn);
      const store = await connect(f.url, "verify");
      try {
        expect((await store.getTenantPurgePlanReceipt(f.result.tenantId, f.result.requestId))?.receiptSha256).toBe(f.result.planReceiptSha256);
        expect((await store.getTenantTelemetrySourceAccountingReceipt(f.result.tenantId, f.result.requestId))?.receiptSha256).toBe(f.result.sourceReceiptSha256);
        expect((await store.getTenantTelemetryTargetManifestReceipt(f.result.tenantId, f.result.requestId))?.receiptSha256).toBe(f.result.manifestReceiptSha256);
        expect((await store.getTenantTelemetryPlanArtifactTargetReceipt(f.result.tenantId, f.result.requestId))?.receiptSha256).toBe(f.result.catalogReceiptSha256);
        expect((await store.getTenantTelemetryOwnerClosureReceipt(f.result.tenantId, f.result.requestId))?.receiptSha256).toBe(f.result.closureReceiptSha256);
        expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        const receipt = await store.getTenantDatabasePurgeReceipt(f.result.tenantId, f.result.requestId);
        expect(receipt).toMatchObject({ receiptSha256: f.result.terminalReceiptSha256,
          localDatabasePurgeComplete: true, allDomainsComplete: false, contentPurgeExecuted: false });
      } finally { await store.close(); }
      expect(await oldVerify(f.url, true)).toBe("frozen-0053-verify-fingerprint-rejected");
    } finally { await conn.end(); }
  }, 150_000);

  it("preserves actual old active written/reserved/pending sources and T1 without creating a late cohort", async () => {
    const f = await history("active"); const conn = await mysql.createConnection(f.url);
    try {
      expect(f.result).toMatchObject({ sourceSink: "local-store-ack-fixture", sourceSinkDurable: false,
        actualSinkWriteCount: 0, actualFixtureAckCount: 1,
        externalDispositionExecuted: false, freshFleetHttpProven: false });
      expect(f.result.sources.map((source) => source.mode).sort()).toEqual(["pending", "reserved", "written"]);
      expect(await oldVerify(f.url, false)).toBe("frozen-0053-verify-accepted");
      const before = await businessDigests(conn); await upgrade(f.url);
      expect(await businessDigests(conn)).toEqual(before); await assertNoNewEvidence(conn);
      const store = await connect(f.url, "verify");
      try {
        expect(await store.getTenantTelemetryPersistedProviderCaptureBinding()).not.toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
        expect(await store.getTenantPurgePlanReceipt(f.result.tenantId, f.result.requestId)).toBeNull();
      } finally { await store.close(); }
      await expect(conn.query("UPDATE tenant_erasure_admissions SET telemetry_retained_source_protocol='tenant-telemetry-retained-source-v1' WHERE request_id=?", [f.result.requestId])).rejects.toThrow();
      const written = f.result.sources.find((source) => source.mode === "written")!;
      await expect(conn.query("DELETE FROM usage_ledger WHERE session_id=?", [written.sessionId])).rejects.toThrow("persisted provider failure usage source is retained");
      await expect(conn.query("DELETE FROM items WHERE item_id=?", [written.itemId])).rejects.toThrow("canonical item deletion lacks retained-source pre-delete bridge");
      await expect(conn.query("DELETE FROM sessions WHERE session_id=?", [written.sessionId])).rejects.toThrow("canonical session parent deletion lacks retained-source bridge");
      expect(await businessDigests(conn)).toEqual(before); await assertNoNewEvidence(conn);
      expect(await oldVerify(f.url, true)).toBe("frozen-0053-verify-fingerprint-rejected");
    } finally { await conn.end(); }
  }, 150_000);

  it("never replays complete 0054 DDL after marker loss", async () => {
    const f = await history("legacy"); const conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url); await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      const schema = await schemaSnapshot(conn), business = await businessDigests(conn);
      await expect(upgrade(f.url)).rejects.toThrow("0054 marker-loss or partial DDL requires controlled forward repair");
      await expect(upgrade(f.url, "verify")).rejects.toThrow();
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
    } finally { await conn.end(); }
  }, 150_000);

  it.each(["table", "private-column", "guard"] as const)("refuses markerless partial 0054 %s before replay", async (kind) => {
    const f = await history("legacy"); const conn = await mysql.createConnection(f.url);
    try {
      if (kind === "table") await conn.query("CREATE TABLE tenant_telemetry_retained_source_t1_receipts (fixture INT NOT NULL) ENGINE=InnoDB");
      if (kind === "private-column") await conn.query("ALTER TABLE tenant_erasure_admissions ADD COLUMN telemetry_retained_source_protocol VARCHAR(64) NULL");
      if (kind === "guard") await conn.query("CREATE TRIGGER trg_tt_retained_admission_bi BEFORE INSERT ON tenant_erasure_admissions FOR EACH ROW BEGIN SET NEW.subject_generation=NEW.subject_generation; END");
      const schema = await schemaSnapshot(conn), business = await businessDigests(conn);
      await expect(upgrade(f.url)).rejects.toThrow("0054 marker-loss or partial DDL requires controlled forward repair");
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
    } finally { await conn.end(); }
  }, 150_000);

  // Four independent frozen-active databases; each advances through six real
  // auto-commit prefixes in source order. These are 24 observations, not 24
  // independent tests or SIGKILL/crash-process simulations.
  it.each(ROTATIONS)("keeps exact $kind rotation protection at all six markerless DDL cuts", async (rotation) => {
    const f = await history("active"); const conn = await mysql.createConnection(f.url);
    try {
      expect(f.result).toMatchObject({ sourceSink: "local-store-ack-fixture", sourceSinkDurable: false,
        actualSinkWriteCount: 0, actualFixtureAckCount: 1,
        externalDispositionExecuted: false, freshFleetHttpProven: false });
      expect(f.result.sources.map((source) => source.mode).sort()).toEqual(["pending", "reserved", "written"]);
      expect(await oldVerify(f.url, false)).toBe("frozen-0053-verify-accepted");
      const before = await businessDigests(conn);
      const initial = await schemaSnapshot(conn);
      expect(initial.triggers).toHaveLength(662);
      expect(initial.markers.map((row) => row.name)).toEqual(oldNames);
      const expected = guardInventory(initial.triggers);
      expect(expected.has(rotation.primary)).toBe(true);
      const a = `trg_tt_retained_${rotation.kind}_bootstrap_a`;
      const b = `trg_tt_retained_${rotation.kind}_bootstrap_b`;
      const cuts = [
        { label: "CREATE_A", index: uniqueStatementIndex(installation, (statement) => createdGuard(statement)?.name === a), names: [rotation.primary, a] },
        { label: "CREATE_B", index: uniqueStatementIndex(installation, (statement) => createdGuard(statement)?.name === b), names: [rotation.primary, a, b] },
        { label: "DROP_OLD", index: uniqueStatementIndex(installation, (statement) => statement === `DROP TRIGGER ${rotation.primary}`), names: [a, b] },
        { label: "CREATE_NEW", index: uniqueStatementIndex(installation, (statement) => createdGuard(statement)?.name === rotation.primary), names: [rotation.primary, a, b] },
        { label: "DROP_A", index: uniqueStatementIndex(installation, (statement) => statement === `DROP TRIGGER ${a}`), names: [rotation.primary, b] },
        { label: "DROP_B", index: uniqueStatementIndex(installation, (statement) => statement === `DROP TRIGGER ${b}`), names: [rotation.primary] },
      ] as const;
      expect(cuts.map((cut) => cut.index)).toEqual(cuts.map((cut) => cut.index).sort((left, right) => left - right));
      expect(new Set(cuts.map((cut) => cut.index)).size).toBe(6);
      let observations = 0;
      for (const [index, statement] of installation.entries()) {
        if (index > cuts[5].index) break;
        const drop = /^DROP TRIGGER (?:IF EXISTS )?(\w+)$/.exec(statement);
        if (drop && BOOTSTRAPS.includes(drop[1]!)) {
          // Every parent DELETE guard and bottom-up root guard must be present
          // before ANY of the eight temporary fences is removed.
          const installed = guardInventory((await schemaSnapshot(conn)).triggers);
          expect(sortedGuards(installed)).toEqual(sortedGuards(expected));
          for (const name of TAIL_GUARDS) {
            const definition = createdGuard(installation[uniqueStatementIndex(installation,
              (candidate) => createdGuard(candidate)?.name === name)]!);
            expect(installed.get(name)).toEqual(definition);
          }
        }
        await conn.query(statement);
        const created = createdGuard(statement);
        if (created) {
          expect(expected.has(created.name)).toBe(false);
          expected.set(created.name, created);
        } else if (drop) {
          const existed = expected.delete(drop[1]!);
          // The formal plan includes optional removal of not-yet-installed new
          // guards. Only explicit IF EXISTS may observe absence; every actual
          // rotation/fence DROP remains unconditional and must be inventoried.
          if (!statement.startsWith("DROP TRIGGER IF EXISTS ")) expect(existed).toBe(true);
        }
        const cut = cuts.find((candidate) => candidate.index === index);
        if (!cut) continue;
        const schema = await schemaSnapshot(conn);
        const installed = guardInventory(schema.triggers);
        expect(sortedGuards(installed), cut.label).toEqual(sortedGuards(expected));
        const present = [rotation.primary, a, b].filter((name) => installed.has(name)).sort();
        expect(present, cut.label).toEqual([...cut.names].sort());
        expect(present.length, cut.label).toBeGreaterThanOrEqual(1);
        expect(schema.markers.map((row) => row.name), cut.label).toEqual(oldNames);
        expect(await businessDigests(conn), cut.label).toEqual(before);
        await assertNoNewEvidence(conn);
        await expect(upgrade(f.url)).rejects.toThrow(new Error("0054 marker-loss or partial DDL requires controlled forward repair"));
        expect(await schemaSnapshot(conn), cut.label).toEqual(schema);
        expect(await businessDigests(conn), cut.label).toEqual(before);
        await assertNoNewEvidence(conn);
        await expect(upgrade(f.url, "verify")).rejects.toThrow(new Error(`database schema is missing required migrations: ${MIGRATION}`));
        expect(await schemaSnapshot(conn), cut.label).toEqual(schema);
        expect(await businessDigests(conn), cut.label).toEqual(before);
        await assertNoNewEvidence(conn);
        observations += 1;
      }
      expect(observations).toBe(6);
    } finally { await conn.end(); }
  }, 150_000);

  it.each(["column", "index", "trigger"] as const)("rejects committed 0054 %s drift without repair", async (kind) => {
    const f = await history("legacy"); const conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url);
      if (kind === "column") await conn.query("ALTER TABLE tenant_erasure_admissions MODIFY telemetry_retained_source_protocol VARCHAR(65) COLLATE utf8mb4_0900_as_cs NULL");
      if (kind === "index") await conn.query("ALTER TABLE tenant_telemetry_retained_source_t1_entries ADD INDEX fixture_drift_index (tenant_id)");
      if (kind === "trigger") {
        await conn.query("DROP TRIGGER trg_tt_retained_items_bd");
        await conn.query("CREATE TRIGGER trg_tt_retained_items_bd BEFORE DELETE ON items FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture drift'; END");
      }
      const schema = await schemaSnapshot(conn), business = await businessDigests(conn);
      await expect(upgrade(f.url, "verify")).rejects.toThrow("0054 retained telemetry source fingerprint verification failed");
      await expect(upgrade(f.url)).rejects.toThrow("0054 retained telemetry source fingerprint verification failed");
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
    } finally { await conn.end(); }
  }, 150_000);
});
