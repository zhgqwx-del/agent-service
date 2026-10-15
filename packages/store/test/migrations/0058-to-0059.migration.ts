import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantRuntimeFleetSha256, tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256, tenantRuntimeTargetSha256, type ProviderConfig } from "@agent-service/protocol";
import { MysqlSessionStore, createProviderByokSecretAdmission, newErasureRequestId,
  tenantErasureRequestHash, type TenantCredentialRevocationClaim,
  type TenantRuntimeRevocationClaim } from "../../src/index.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const SOURCE_COMMIT = "24d5ae4247b356696e984d95e47b99c20388cd2d";
const OLD_MARKER = "0058_tenant_telemetry_capture_repeat_restore.sql";
const MIGRATION = "0059_credential_responsibility.sql";
const NEW_TABLES = ["tenant_credential_responsibility_sources", "tenant_credential_responsibility_entries",
  "tenant_credential_responsibility_receipts"] as const;
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const WRITER_STAGES = ["input", "connect", "activate", "provider", "request", "claim", "t3a", "proof"];
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"];
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "TenantErasureIntegrityError"];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function disposableBase(raw: string): URL {
  const url = new URL(raw), name = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(name)) {
    throw new Error("0059 fixture requires a local disposable MySQL base");
  }
  return url;
}
function databaseUrl(base: URL, database: string): string {
  if (database !== "mysql" && !/^agent_service_migration_test_0059_[0-9]+_[0-9a-f]{8}$/.test(database)) {
    throw new Error("unsafe 0059 database target");
  }
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, TMPDIR: temp, CI: "1", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
function childDiagnostic(error: unknown, kind: "writer" | "verify"): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)
    || typeof error.stderr !== "string" || error.stderr.length > 1024) return "";
  const prefix = `pre0059-frozen-${kind}-diagnostic:`, line = error.stderr.trim();
  if (!line.startsWith(prefix) || line.includes("\n") || line.includes("\r")) return "";
  try {
    const row = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
    if (!row || typeof row !== "object" || Array.isArray(row)) return "";
    if (kind === "writer") {
      if (Object.keys(row).sort().join(",") !== "code,name,schema,stage"
        || row.schema !== "pre0059-frozen-writer-diagnostic-v1"
        || typeof row.stage !== "string" || !WRITER_STAGES.includes(row.stage)
        || typeof row.code !== "string" || !WRITER_CODES.includes(row.code)
        || typeof row.name !== "string" || !WRITER_NAMES.includes(row.name)) return "";
      return ` (writerStage=${row.stage}, code=${row.code}, name=${row.name})`;
    }
    if (Object.keys(row).sort().join(",") !== "errorClass,expected,messageCategory,observed,schema"
      || row.schema !== "pre0059-frozen-verify-diagnostic-v1"
      || !["accepted", "fingerprint"].includes(String(row.expected))
      || !["accepted", "fingerprint", "unexpected"].includes(String(row.observed))
      || !["none", "Error", "other", "non_error"].includes(String(row.errorClass))
      || !["none", "0058_fingerprint", "other"].includes(String(row.messageCategory))) return "";
    return ` (verifyExpected=${String(row.expected)}, observed=${String(row.observed)}, errorClass=${String(row.errorClass)}, messageCategory=${String(row.messageCategory)})`;
  } catch { return ""; }
}
async function runFixed(stage: string, file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    const detail = file !== process.execPath ? ""
      : args.includes("packages/store/test/fixtures/pre0059-old-writer-driver.ts") ? childDiagnostic(error, "writer")
        : args.includes("packages/store/test/fixtures/pre0059-old-verify-probe.ts") ? childDiagnostic(error, "verify") : "";
    throw new Error(`frozen 0058 fixture stage failed: ${stage}${detail}`);
  }
}
async function copyIsolatedDependencies(checkout: string): Promise<void> {
  const projects = ["packages/core", "packages/protocol", "packages/providers", "packages/sdk", "packages/store", "packages/testkit", "apps/agent-router", "apps/agent-runner"];
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ...projects.map((project) => `${project}/package.json`)]) {
    if (!(await readFile(join(checkout, path))).equals(await readFile(join(ROOT, path)))) {
      throw new Error(`frozen 0058 dependency manifest changed: ${path}`);
    }
  }
  const fields = ["name", "private", "type", "version", "engines", "packageManager", "dependencies", "devDependencies",
    "optionalDependencies", "peerDependencies"];
  const old = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as Record<string, unknown>;
  const current = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  if (JSON.stringify(fields.map((field) => old[field] ?? null)) !== JSON.stringify(fields.map((field) => current[field] ?? null))) {
    throw new Error("frozen 0058 root dependency contract changed");
  }
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(checkout, "node_modules"), options);
  const linked = projects.filter((project) => project !== "packages/testkit");
  for (const project of linked) await cp(join(ROOT, project, "node_modules"), join(checkout, project, "node_modules"), options);
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0058 dependency store is not isolated");
  const realCheckout = await realpath(checkout); let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...linked]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) {
        throw new Error("frozen 0058 workspace dependency escapes source archive");
      }
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0058 workspace dependency links missing");
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
async function businessDigests(conn: Connection): Promise<Record<string, { rows: number; sha256: string }>> {
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const table of (await tableNames(conn)).filter((name) => name !== "schema_migrations" && !NEW_TABLES.some((newTable) => newTable === name))) {
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
  scope: "frozen0058-credential-upgrade-v1"; sourceCommit: string; marker: string; triggerCount: number;
  tenantId: string; requestId: string; credentialVersionId: string; t3aReceiptSha256: string;
  inventoryReceiptSha256: string; versionCount: 1; providerDeleted: true;
  externalRevocationExecuted: false; physicalRestoreExecuted: false; productionAccepted: false;
}
function provider(tenantId: string): ProviderConfig {
  const now = Date.now();
  return { tenantId, id: "provider", api: "openai-completions",
    baseUrl: "https://new-byok-fixture.invalid/v1", apiKeyRef: "secret:new-byok-fixture",
    headers: {}, models: [{ id: "model", contextWindow: 1_000, maxOutputTokens: 10,
      input: ["text"], reasoning: false }], quota: {}, fallback: [], createdAtMs: now, updatedAtMs: now };
}
async function newTenantClaim(store: MysqlSessionStore, tenantId: string) {
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "new0059-admin",
    idempotencyKey: `new0059-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const claim = (await store.claimTenantCredentialRevocations({ limit: 100, leaseMs: 120_000,
      claimToken: `new0059-${randomUUID()}` })).find((row) => row.requestId === requestId);
    if (claim) return { requestId, claim };
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("new0059 isolated T3a claim absent");
}
function credentialAuthorization(claim: TenantCredentialRevocationClaim) {
  return { requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
}
function runtimeAuthorization(claim: TenantRuntimeRevocationClaim) {
  return { requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
}
async function completeRuntime(store: MysqlSessionStore, requestId: string) {
  // The frozen tenant also has a legitimate uncompleted T3b. Claiming the
  // new request by exact ID avoids treating that unrelated old job as proof.
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 100 })).toBeGreaterThanOrEqual(1);
  const claim = (await store.claimTenantRuntimeRevocations({ limit: 100, leaseMs: 120_000,
    claimToken: `new0059-runtime-${randomUUID()}` })).find((row) => row.requestId === requestId);
  expect(claim).toBeDefined();
  const targetBody = { targetSha256: tenantRuntimeTargetSha256("http://isolated-runner.invalid:8080"),
    runnerId: "isolated-runner", bootId: "isolated-boot", requestId: claim!.requestId,
    tenantId: claim!.tenantId, subjectGeneration: claim!.subjectGeneration,
    t3aReceiptSha256: claim!.t3aReceiptSha256, cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const, activeOperationCountBefore: 0,
    activeOperationCountAfter: 0 as const, activeTurnCountBefore: 0,
    activeTurnCountAfter: 0 as const, completedAtMs: Date.now() };
  const targets = [{ ...targetBody, receiptSha256: tenantRuntimeLocalReceiptSha256(targetBody) }];
  const receipt = await store.completeTenantRuntimeRevocation(runtimeAuthorization(claim!), {
    targets, fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
  });
  expect(receipt).not.toBeNull();
  return receipt!;
}

describe("0058 -> 0059 exact frozen-source credential responsibility historical MySQL upgrade", () => {
  let admin: Connection, base: URL, archiveRoot: string, checkout: string, currentDir: string;
  let oldNames: string[], currentNames: string[], expectedOldTables: string[], expectedCurrentTables: string[];
  let first0059Table: string;
  const owned = new Set<string>();
  beforeAll(async () => {
    base = disposableBase(BASE); admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0058-"));
    checkout = join(archiveRoot, "checkout"); currentDir = join(archiveRoot, "current-migrations");
    await mkdir(checkout); await mkdir(currentDir);
    expect((await runFixed("resolve exact published old source", "git", ["rev-parse", SOURCE_COMMIT], ROOT,
      isolatedEnv(archiveRoot), 10_000)).trim()).toBe(SOURCE_COMMIT);
    const tar = join(archiveRoot, "frozen0058.tar");
    await runFixed("archive exact published source", "git", ["archive", "--format=tar", `--output=${tar}`, SOURCE_COMMIT],
      ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract own archive", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe(OLD_MARKER);
    currentNames = (await readdir(MIGRATIONS)).filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 59).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    for (const name of oldNames) {
      expect((await readFile(join(checkout, "packages/store/migrations", name))).equals(await readFile(join(MIGRATIONS, name)))).toBe(true);
    }
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    expectedOldTables = await declaredTableSet(join(checkout, "packages/store/migrations"), oldNames);
    expectedCurrentTables = await declaredTableSet(currentDir, currentNames);
    expect(expectedCurrentTables).toEqual([...expectedOldTables, ...NEW_TABLES].sort());
    expect(formalSplitterSource(await readFile(fileURLToPath(import.meta.url), "utf8")))
      .toBe(formalSplitterSource(await readFile(join(ROOT, "packages/store/src/mysql/store.ts"), "utf8")));
    const statements = mysqlMigrationStatements(await readFile(join(currentDir, MIGRATION), "utf8"));
    first0059Table = statements[0]!;
    expect(first0059Table).toMatch(/^CREATE TABLE IF NOT EXISTS tenant_credential_responsibility_sources\s*\(/);
    const fixtures = join(checkout, "packages/store/test/fixtures"); await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0059-old-writer-driver.ts", "pre0059-old-verify-probe.ts"]) {
      await copyFile(join(HERE, "../fixtures", name), join(fixtures, name));
    }
    await copyIsolatedDependencies(checkout);
    await runFixed("offline frozen source compile", process.execPath, ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"],
      checkout, isolatedEnv(archiveRoot));
  }, 420_000);
  afterAll(async () => {
    if (admin) {
      for (const name of owned) {
        if (!/^agent_service_migration_test_0059_[0-9]+_[0-9a-f]{8}$/.test(name)) {
          throw new Error("unsafe 0059 fixture cleanup target");
        }
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)}`);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });
  async function history() {
    const name = `agent_service_migration_test_0059_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
    if (existing.length) throw new Error("0059 fixture database already exists");
    await admin.query(`CREATE DATABASE ${identifier(name)} CHARACTER SET utf8mb4`); owned.add(name);
    const url = databaseUrl(base, name);
    const output = await runFixed("actual frozen provider version and terminal T3a", process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0059-old-writer-driver.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url }), 120_000);
    let result: History;
    try { result = JSON.parse(output) as History; } catch { throw new Error("frozen 0058 writer output invalid"); }
    expect(result).toMatchObject({ scope: "frozen0058-credential-upgrade-v1", sourceCommit: SOURCE_COMMIT,
      marker: OLD_MARKER, triggerCount: 735, versionCount: 1, providerDeleted: true,
      externalRevocationExecuted: false, physicalRestoreExecuted: false, productionAccepted: false });
    for (const value of [result.credentialVersionId, result.t3aReceiptSha256, result.inventoryReceiptSha256]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.tenantId).toMatch(/^frozen-tenant-[0-9a-f-]{36}$/);
    expect(result.requestId).toMatch(/^erase_[0-9a-f-]{36}$/);
    return { url, result };
  }
  async function oldVerify(url: string, result: History, expected: "accepted" | "fingerprint") {
    return runFixed(`exact frozen startup ${expected} oracle`, process.execPath,
      ["--import", "tsx", "packages/store/test/fixtures/pre0059-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0058_OUTCOME: expected,
        FROZEN_0058_TENANT_ID: result.tenantId, FROZEN_0058_REQUEST_ID: result.requestId }), 30_000);
  }
  async function assertCurrentOpen(url: string, mode: "apply" | "verify", expected: "accepted" | string): Promise<void> {
    let store: MysqlSessionStore | undefined;
    try {
      store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode: mode });
      if (expected !== "accepted") throw new Error("expected frozen-source startup rejection absent");
      expect((await store.readTenantCredentialTrackingCutover()).controlGeneration).toBe(1);
    } catch (error) {
      if (expected === "accepted" || !(error instanceof Error) || error.message !== expected) {
        const category = error instanceof Error && error.message === "0059 credential responsibility fingerprint verification failed"
          ? "0059_fingerprint" : error instanceof Error
            && error.message === "0059 marker-loss or partial DDL requires controlled forward repair"
            ? "0059_marker_loss" : error instanceof Error
              && error.message === `database schema is missing required migrations: ${MIGRATION}`
              ? "0059_missing" : "other";
        throw new Error(`pre0059-startup-diagnostic:${JSON.stringify({ schema: "pre0059-startup-diagnostic-v1",
          mode, expected: expected === "accepted" ? "accepted" : "rejected", category })}`);
      }
    } finally { await store?.close(); }
  }
  async function assertCurrentSchema(conn: Connection): Promise<void> {
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    expect(markers.map((row) => row.name)).toEqual(currentNames);
    expect(Number(guards[0]?.n)).toBe(743);
    expect(await tableNames(conn)).toEqual(expectedCurrentTables);
  }
  async function oldEvidence(conn: Connection, result: History) {
    const [versions] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_credential_versions WHERE tenant_id=? AND credential_version_id=?",
      [result.tenantId, result.credentialVersionId]);
    const [targets] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_credential_target_dispositions WHERE tenant_id=? AND credential_version_id=? ORDER BY domain",
      [result.tenantId, result.credentialVersionId]);
    const [inventory] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_credential_inventory_receipts WHERE tenant_id=? AND request_id=?",
      [result.tenantId, result.requestId]);
    const [jobs] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_credential_revocation_jobs WHERE tenant_id=? AND request_id=?",
      [result.tenantId, result.requestId]);
    const [receipts] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_credential_revocation_receipts WHERE tenant_id=? AND request_id=?",
      [result.tenantId, result.requestId]);
    expect(versions).toHaveLength(1); expect(targets.length).toBeGreaterThan(0);
    expect(inventory).toHaveLength(1); expect(jobs).toHaveLength(1); expect(receipts).toHaveLength(1);
    expect(inventory[0]?.receipt_sha256).toBe(result.inventoryReceiptSha256);
    expect(receipts[0]?.receipt_sha256).toBe(result.t3aReceiptSha256);
    return { versions: digest(versions), targets: digest(targets), inventory: digest(inventory),
      jobs: digest(jobs), receipts: digest(receipts) };
  }

  it("keeps actual frozen0058 version/T3a bytes unknown, then records only a new admitted BYOK tenant", async () => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      expect(await oldVerify(f.url, f.result, "accepted")).toBe("frozen-0058-verify-accepted");
      const before = await businessDigests(conn), old = await oldEvidence(conn, f.result);
      expect(await tableNames(conn)).toEqual(expectedOldTables);
      expect(Object.keys(before).sort()).toEqual(expectedOldTables.filter((name) => name !== "schema_migrations"));
      expect(before.tenant_credential_versions?.rows).toBeGreaterThan(0);
      expect(before.tenant_credential_revocation_receipts?.rows).toBeGreaterThan(0);
      await assertCurrentOpen(f.url, "apply", "accepted");
      await assertCurrentSchema(conn); await assertNoNewEvidence(conn);
      expect(await businessDigests(conn)).toEqual(before); expect(await oldEvidence(conn, f.result)).toEqual(old);
      expect(await oldVerify(f.url, f.result, "fingerprint")).toBe("frozen-0058-verify-fingerprint");
      await assertCurrentOpen(f.url, "verify", "accepted");

      const store = await MysqlSessionStore.connect({ url: f.url, migrationsDir: currentDir, migrationMode: "verify" });
      try {
        expect(await store.getTenantCredentialRevocationReceipt(f.result.tenantId, f.result.requestId))
          .toMatchObject({ receiptSha256: f.result.t3aReceiptSha256 });
        expect(await store.getTenantCredentialResponsibilityReadiness(f.result.tenantId, f.result.requestId))
          .toMatchObject({ status: "unknown", localDatabase: "cleared", remoteCredentials: "unknown",
            responsibilityReceiptSha256: null, versionCount: null, allDomainsComplete: false });
        for (const table of NEW_TABLES) {
          const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE tenant_id=?`,
            [f.result.tenantId]);
          expect(Number(rows[0]?.n)).toBe(0);
        }

        const tenantId = `new-byok-${randomUUID()}`, config = provider(tenantId);
        const secret = { ciphertext: Buffer.from("encrypted-new0059-fixture"), keyId: "shared-fixture-key" };
        const admission = createProviderByokSecretAdmission({ tenantId, providerId: config.id,
          expectedSourceRevision: null, secret });
        await store.upsertProviderConfigWithResponsibility({ config, secret,
          expectedSourceRevision: null, secretAdmission: admission });
        const [sources] = await conn.query<RowDataPacket[]>("SELECT source_json FROM tenant_credential_responsibility_sources WHERE tenant_id=?",
          [tenantId]);
        expect(sources).toHaveLength(1);
        const raw: unknown = sources[0]?.source_json;
        const source = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
        expect(source).toMatchObject({ sourceRevision: 1, apiKeySource: "new_byok",
          apiKeyResponsibility: "customer_managed",
          envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" });
        const { requestId, claim } = await newTenantClaim(store, tenantId);
        const t3a = await store.revokeTenantCredentialMaterial(credentialAuthorization(claim));
        expect(t3a).not.toBeNull(); expect(await store.getProviderConfig(tenantId, "provider")).toBeNull();
        const t3b = await completeRuntime(store, requestId);
        expect(await store.getTenantCredentialResponsibilityReadiness(tenantId, requestId))
          .toMatchObject({ status: "local_responsibility_observed", localDatabase: "cleared",
            trackedRuntimeReferences: "dropped_not_zeroized", remoteCredentials: "customer_responsibility_recorded",
            sharedKeys: "platform_shared_not_tenant_deletable", backupCopies: "unknown", otherCopies: "unknown",
            t3aReceiptSha256: t3a!.receiptSha256, t3bReceiptSha256: t3b.receiptSha256,
            versionCount: 1, customerManagedApiKeyCount: 1, unknownMaterialCount: 0,
            allDomainsComplete: false, contentPurgeExecuted: false });
        for (const table of NEW_TABLES) {
          const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${identifier(table)} WHERE tenant_id=?`,
            [tenantId]);
          expect(Number(rows[0]?.n)).toBe(1);
        }
        expect(await oldEvidence(conn, f.result)).toEqual(old);
        expect(await store.getTenantCredentialResponsibilityReadiness(f.result.tenantId, f.result.requestId))
          .toMatchObject({ status: "unknown", remoteCredentials: "unknown", responsibilityReceiptSha256: null });
      } finally { await store.close(); }
    } finally { await conn.end(); }
  }, 150_000);

  it("rejects marker loss without rewriting frozen0058 business rows or backfilling responsibility", async () => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      const old = await oldEvidence(conn, f.result), before = await businessDigests(conn);
      await assertCurrentOpen(f.url, "apply", "accepted"); await assertCurrentSchema(conn); await assertNoNewEvidence(conn);
      expect(await businessDigests(conn)).toEqual(before);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      const schema = await schemaDigest(conn);
      await assertCurrentOpen(f.url, "apply", "0059 marker-loss or partial DDL requires controlled forward repair");
      await assertCurrentOpen(f.url, "verify", `database schema is missing required migrations: ${MIGRATION}`);
      expect(await schemaDigest(conn)).toBe(schema); expect(await businessDigests(conn)).toEqual(before);
      expect(await oldEvidence(conn, f.result)).toEqual(old); await assertNoNewEvidence(conn);
    } finally { await conn.end(); }
  }, 150_000);

  it("rejects partial 0059 DDL and separately rejects a missing installed guard without inventing a marker", async () => {
    const f = await history(), conn = await mysql.createConnection(f.url);
    try {
      const old = await oldEvidence(conn, f.result), before = await businessDigests(conn);
      await conn.query(first0059Table);
      const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
      expect(markers.map((row) => row.name)).toEqual(oldNames);
      expect((await tableNames(conn))).toEqual([...expectedOldTables, NEW_TABLES[0]].sort());
      const partialSchema = await schemaDigest(conn);
      await assertCurrentOpen(f.url, "apply", "0059 marker-loss or partial DDL requires controlled forward repair");
      await assertCurrentOpen(f.url, "verify", `database schema is missing required migrations: ${MIGRATION}`);
      expect(await schemaDigest(conn)).toBe(partialSchema); expect(await businessDigests(conn)).toEqual(before);
      expect(await oldEvidence(conn, f.result)).toEqual(old);
      // Only this empty table was created by this isolated test. Removing it
      // restores the exact old schema; product migration never repairs partial DDL.
      await conn.query(`DROP TABLE ${identifier(NEW_TABLES[0])}`);
      expect(await tableNames(conn)).toEqual(expectedOldTables);
      await assertCurrentOpen(f.url, "apply", "accepted"); await assertCurrentSchema(conn); await assertNoNewEvidence(conn);
      expect(await businessDigests(conn)).toEqual(before);
      await conn.query("DROP TRIGGER trg_credential_responsibility_sources_bi");
      const driftedSchema = await schemaDigest(conn);
      await assertCurrentOpen(f.url, "verify", "0059 credential responsibility fingerprint verification failed");
      await assertCurrentOpen(f.url, "apply", "0059 credential responsibility fingerprint verification failed");
      expect(await schemaDigest(conn)).toBe(driftedSchema); expect(await businessDigests(conn)).toEqual(before);
      expect(await oldEvidence(conn, f.result)).toEqual(old); await assertNoNewEvidence(conn);
    } finally { await conn.end(); }
  }, 150_000);
});
