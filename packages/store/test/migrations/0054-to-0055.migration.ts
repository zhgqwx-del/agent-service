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
import { MysqlSessionStore, newTenantBackupId, readTenantTelemetryCaptureCheckpointFromMysql,
  TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const SOURCE_COMMIT = "2932318f31a75e5a8f328165b2daf436f4ec5bc1";
const MIGRATION = "0055_tenant_telemetry_capture_backup_checkpoint.sql";
const REF_KEY = Buffer.alloc(32, 0x43); // Public fixture key, never production input.
const NEW_TABLES = ["tenant_telemetry_capture_backup_checkpoints", "tenant_telemetry_capture_backup_checkpoint_leaves", "tenant_telemetry_capture_restore_bindings"];
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const WRITER_STAGES = ["input", "connect", "legacy", "activate", "tenant", "source", "claim", "reserve", "ack", "finish", "t1", "proof",
  "proof-schema", "proof-legacy", "proof-phases", "proof-publication"];
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"];
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantErasureIntegrityError", "TenantRestoreJournalPublicationDependencyPendingError"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function disposableBase(raw: string): URL {
  const url = new URL(raw), name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(name)) throw new Error("0055 fixture requires a local disposable MySQL base");
  return url;
}
function databaseUrl(base: URL, database: string): string {
  if (database !== "mysql" && !/^agent_service_migration_test_0055_[0-9]+_[0-9a-f]{8}$/.test(database)) throw new Error("unsafe 0055 database target");
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // No .env/model/cloud credentials are inherited by the frozen subprocess.
  return { PATH: process.env.PATH, TMPDIR: temp, CI: "1", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
function writerDiagnostic(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error) || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = "pre0055-frozen-writer-diagnostic:", line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const row = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "code,name,schema,stage"
      || row.schema !== "pre0055-frozen-writer-diagnostic-v1" || typeof row.stage !== "string" || !WRITER_STAGES.includes(row.stage)
      || typeof row.code !== "string" || !WRITER_CODES.includes(row.code) || typeof row.name !== "string" || !WRITER_NAMES.includes(row.name)) return "";
    return ` (writerStage=${row.stage}, code=${row.code}, name=${row.name})`;
  } catch { return ""; }
}
async function runFixed(stage: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const detail = file === process.execPath && args.includes("packages/store/test/fixtures/pre0055-old-writer-driver.ts") ? writerDiagnostic(error) : "";
    throw new Error(`frozen 0054 fixture stage failed: ${stage}${detail}`); // Never attach child stdout/stderr/cause/DSN.
  }
}
async function copyIsolatedDependencies(checkout: string): Promise<void> {
  const projects = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk", "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"];
  await installFrozenDependencies(ROOT, checkout);
  const linked = projects.filter((project) => project !== "packages/testkit");
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0054 dependency store is not isolated");
  const realCheckout = await realpath(checkout); let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...linked]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) throw new Error("frozen 0054 workspace dependency escapes source archive");
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0054 workspace dependency links missing");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("historical metadata identifier invalid");
  return `\`${value}\``;
}
async function tableNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<RowDataPacket[]>("SELECT table_name AS name,table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY BINARY table_name");
  if (!rows.length || rows.some((row) => row.kind !== "BASE TABLE")) throw new Error("historical base tables missing");
  return rows.map((row) => { identifier(row.name); return String(row.name); });
}
/** Complete old physical tables, including all nine 0054 evidence tables. Only hashes leave this helper. */
async function businessDigests(conn: Connection): Promise<Record<string, { rows: number; sha256: string }>> {
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const table of (await tableNames(conn)).filter((name) => name !== "schema_migrations" && !NEW_TABLES.includes(name))) {
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
async function assertNoAutomaticEvidence(conn: Connection): Promise<void> {
  for (const table of NEW_TABLES) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${identifier(table)}`);
    expect(rows).toHaveLength(1); expect(rows[0]!.n === 0 || rows[0]!.n === "0").toBe(true);
  }
}
interface History {
  scope: "frozen0054-upgrade-history-v1"; sourceCommit: string; mode: "active" | "inactive"; marker: string; triggerCount: number;
  legacyUnknownItemCount: number; sourceCounts: { queued: number; reserved: number; written: number };
  activationReceiptSha256: string | null; retainedT1ReceiptSha256: string | null; publicationPending: boolean; sourceOperationRootSha256: string;
  sourceSink: "local-store-ack-fixture"; sourceSinkDurable: false; actualFixtureAckCount: number; actualSinkWriteCount: 0;
  externalDispositionExecuted: false; freshFleetHttpProven: false; productionAccepted: false;
}

describe("0054 -> 0055 exact frozen-source historical MySQL upgrade", () => {
  let admin: Connection, base: URL, archiveRoot: string, checkout: string, currentDir: string;
  let oldNames: string[], currentNames: string[];
  const owned = new Set<string>();
  beforeAll(async () => {
    base = disposableBase(BASE); admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0054-"));
    checkout = join(archiveRoot, "checkout"); currentDir = join(archiveRoot, "current-migrations");
    await mkdir(checkout); await mkdir(currentDir);
    expect((await runFixed("resolve published source", "git", ["rev-parse", SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 10_000)).trim()).toBe(SOURCE_COMMIT);
    const tar = join(archiveRoot, "frozen0054.tar");
    await runFixed("archive exact source", "git", ["archive", "--format=tar", `--output=${tar}`, SOURCE_COMMIT], ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract own archive", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe("0054_tenant_telemetry_retained_source.sql");
    // Preserve this exact 0055 boundary when later migrations are appended.
    currentNames = (await readdir(MIGRATIONS))
      .filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 55).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    for (const name of oldNames) expect((await readFile(join(checkout, "packages/store/migrations", name))).equals(await readFile(join(MIGRATIONS, name)))).toBe(true);
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    const fixtures = join(checkout, "packages/store/test/fixtures"); await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0055-old-writer-driver.ts", "pre0055-old-verify-probe.ts"]) await copyFile(join(HERE, "../fixtures", name), join(fixtures, name));
    await copyIsolatedDependencies(checkout);
    // A failed offline build is a failed historical fixture, never a skip.
    await runFixed("offline frozen source compile", process.execPath, ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"], checkout, isolatedEnv(archiveRoot));
  }, 420_000);
  afterAll(async () => {
    if (admin) {
      for (const name of owned) {
        if (!/^agent_service_migration_test_0055_[0-9]+_[0-9a-f]{8}$/.test(name)) throw new Error("unsafe 0055 fixture cleanup target");
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });
  async function history(mode: "active" | "inactive") {
    const name = `agent_service_migration_test_0055_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
    if (existing.length) throw new Error("0055 fixture database already exists");
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url = databaseUrl(base, name);
    const output = await runFixed(`actual frozen ${mode} business`, process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0055-old-writer-driver.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, PRE0055_FIXTURE_MODE: mode }), 120_000);
    let result: History;
    try { result = JSON.parse(output) as History; } catch { throw new Error("frozen 0054 writer output invalid"); }
    expect(result).toMatchObject({ scope: "frozen0054-upgrade-history-v1", sourceCommit: SOURCE_COMMIT, mode,
      marker: "0054_tenant_telemetry_retained_source.sql", triggerCount: 712, legacyUnknownItemCount: 1,
      sourceSink: "local-store-ack-fixture", sourceSinkDurable: false, actualSinkWriteCount: 0,
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false });
    expect(result.sourceOperationRootSha256).toMatch(/^[0-9a-f]{64}$/);
    return { url, result };
  }
  async function connect(url: string, migrationMode: "apply" | "verify" = "apply") {
    return MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode, tenantTelemetryRefKey: REF_KEY,
      tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  }
  async function upgrade(url: string, mode: "apply" | "verify" = "apply") { const store = await connect(url, mode); await store.close(); }
  async function assertCurrentSchema(conn: Connection) {
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    expect(markers.map((row) => row.name)).toEqual(currentNames); expect(Number(guards[0]?.n)).toBe(718);
  }
  async function oldVerify(url: string, rejected: boolean) {
    return runFixed("exact frozen startup oracle", process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0055-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0054_FINGERPRINT_REJECTION: rejected ? "1" : "0" }), 30_000);
  }
  it("preserves frozen active queued/reserved/written, legacy unknown and 0054 T1 before explicit new backup seal", async () => {
    const f = await history("active"), conn = await mysql.createConnection(f.url);
    try {
      expect(f.result.sourceCounts).toEqual({ queued: 1, reserved: 1, written: 1 });
      expect(f.result.actualFixtureAckCount).toBe(1); expect(f.result.publicationPending).toBe(true);
      expect(f.result.activationReceiptSha256).toMatch(/^[0-9a-f]{64}$/); expect(f.result.retainedT1ReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(await oldVerify(f.url, false)).toBe("frozen-0054-verify-accepted");
      const before = await businessDigests(conn);
      expect(before.tenant_telemetry_capture_v2_failure_commit_receipts?.rows).toBe(3);
      expect(before.tenant_telemetry_retained_source_t1_receipts?.rows).toBe(1);
      await upgrade(f.url); await assertCurrentSchema(conn); expect(await businessDigests(conn)).toEqual(before); await assertNoAutomaticEvidence(conn);
      expect(await oldVerify(f.url, true)).toBe("frozen-0054-verify-fingerprint-rejected");
      const store = await connect(f.url, "verify");
      try {
        expect((await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt())?.receiptSha256).toBe(f.result.activationReceiptSha256);
        const [oldReceipt] = await conn.query<RowDataPacket[]>("SELECT receipt_sha256 FROM tenant_telemetry_retained_source_t1_receipts");
        expect(oldReceipt).toHaveLength(1); expect(oldReceipt[0]!.receipt_sha256).toBe(f.result.retainedT1ReceiptSha256);
        const backupId = newTenantBackupId(), control = await store.getTenantBackupCatalogControl();
        if (control.state !== "active") throw new Error("historical backup catalog unexpectedly inactive");
        await store.createTenantBackupSnapshotAnchor({ backupId, controlEvidenceSha256: control.evidenceSha256 });
        const sealed = await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId, fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
        expect(sealed?.disposition).toBe("created");
        const checkpoint = sealed!.value.checkpoint;
        expect(checkpoint.families.map((row) => row.family)).toEqual(TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES);
        expect(checkpoint.families.find((row) => row.family === "write_job")).toMatchObject({ rowCount: 3, states: { queued: 1, reserved: 1, written: 1 } });
        expect(checkpoint.families.find((row) => row.family === "write_payload")?.rowCount).toBe(2);
        expect(checkpoint.families.find((row) => row.family === "write_ack")?.rowCount).toBe(1);
        expect(checkpoint.families.find((row) => row.family === "legacy_failure")).toMatchObject({ rowCount: 2, legacyUnknownCount: 2 });
        expect(checkpoint.families.find((row) => row.family === "retained_t1_receipt")?.rowCount).toBe(1);
        expect(checkpoint).toMatchObject({ executionReady: false, erasureAuthorized: false, externalAuthorityVerified: false,
          allDomainsComplete: false, contentPurgeExecuted: false });
        expect(await readTenantTelemetryCaptureCheckpointFromMysql(conn, backupId, REF_KEY)).toEqual(sealed!.value);
        const [sidecars] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM tenant_telemetry_capture_restore_bindings");
        expect(Number(sidecars[0]?.n)).toBe(0);
      } finally { await store.close(); }
      // Explicit backup additions must not rewrite old business/source/0054 evidence.
      const afterSeal = await businessDigests(conn);
      for (const [table, proof] of Object.entries(before)) if (table !== "backup_snapshot_anchors") expect(afterSeal[table], table).toEqual(proof);
    } finally { await conn.end(); }
  }, 150_000);
  it("preserves frozen inactive gen0 as unknown and does not materialize or activate capture/checkpoint on upgrade", async () => {
    const f = await history("inactive"), conn = await mysql.createConnection(f.url);
    try {
      expect(f.result.sourceCounts).toEqual({ queued: 0, reserved: 0, written: 0 });
      expect(f.result.activationReceiptSha256).toBeNull(); expect(f.result.retainedT1ReceiptSha256).toBeNull();
      expect(await oldVerify(f.url, false)).toBe("frozen-0054-verify-accepted");
      const before = await businessDigests(conn); await upgrade(f.url);
      await assertCurrentSchema(conn); expect(await businessDigests(conn)).toEqual(before); await assertNoAutomaticEvidence(conn);
      const store = await connect(f.url, "verify");
      try {
        expect(await store.getTenantTelemetryPersistedProviderCaptureControl()).toEqual({ domain: "logs", state: "inactive", controlGeneration: 0 });
        expect(await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId: newTenantBackupId(), fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).toBeNull();
      } finally { await store.close(); }
      await assertNoAutomaticEvidence(conn); expect(await oldVerify(f.url, true)).toBe("frozen-0054-verify-fingerprint-rejected");
    } finally { await conn.end(); }
  }, 150_000);
  it.each(["marker-loss", "trigger-drift"] as const)("rejects %s without replay, repair or business mutation", async (kind) => {
    const f = await history("inactive"), conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url); await assertNoAutomaticEvidence(conn);
      if (kind === "marker-loss") await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      else await conn.query("DROP TRIGGER trg_tt_capture_checkpoint_leaf_immutable_update");
      const schema = await schemaDigest(conn), business = await businessDigests(conn);
      if (kind === "marker-loss") await expect(upgrade(f.url)).rejects.toThrow("0055 marker-loss or partial DDL requires controlled forward repair");
      else await expect(upgrade(f.url)).rejects.toThrow("0055 capture checkpoint fingerprint verification failed");
      await expect(upgrade(f.url, "verify")).rejects.toThrow();
      expect(await schemaDigest(conn)).toBe(schema); expect(await businessDigests(conn)).toEqual(business);
      await assertNoAutomaticEvidence(conn);
    } finally { await conn.end(); }
  }, 150_000);
});
