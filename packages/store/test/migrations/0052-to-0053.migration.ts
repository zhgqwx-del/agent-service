import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyUsage, type Item, type Turn } from "@agent-service/protocol";
import { MysqlSessionStore } from "../../src/index.js";
import { mkSession, newId } from "../conformance.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const MIGRATIONS = join(ROOT, "packages/store/migrations");
const FROZEN_0052_COMMIT = "5d669cf4e7aa71543b01a3eeebb90add77d0c934";
const MIGRATION = "0053_persisted_provider_failure_capture.sql";
const PUBLISHED_0049 = "0049_tenant_telemetry_application_capture_v2.sql";
const REF_KEY = Buffer.alloc(32, 0x53);
const BASE = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) throw new Error("0053 fixture requires local disposable MySQL");
  return url;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base); url.pathname = `/${database}`; return url.toString();
}
function isolatedEnv(temp: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Only the fixture DSN is passed explicitly; no model/cloud credentials or .env enter old code.
  return { PATH: process.env.PATH, HOME: temp, TMPDIR: temp, CI: "1", NO_COLOR: "1",
    COREPACK_ENABLE_NETWORK: "0", ...extra };
}
async function runFixed(stage: string, file: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, timeout = 180_000): Promise<string> {
  try { return (await exec(file, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch { throw new Error(`frozen 0052 fixture stage failed: ${stage}`); } // Never print subprocess DSNs.
}

async function copyIsolatedDependencies(checkout: string): Promise<void> {
  const manifests = ["pnpm-lock.yaml", "pnpm-workspace.yaml", ...[
    "packages/core", "packages/protocol", "packages/providers", "packages/sdk", "packages/store",
    "packages/testkit", "apps/agent-router", "apps/agent-runner",
  ].map((path) => `${path}/package.json`)];
  for (const path of manifests) if (!(await readFile(join(checkout, path))).equals(await readFile(join(ROOT, path)))) {
    throw new Error(`frozen 0052 dependency manifest changed: ${path}`);
  }
  const fields = ["name", "private", "type", "version", "engines", "packageManager", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const oldRoot = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as Record<string, unknown>;
  const liveRoot = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  if (JSON.stringify(fields.map((field) => oldRoot[field] ?? null)) !== JSON.stringify(fields.map((field) => liveRoot[field] ?? null))) {
    throw new Error("frozen 0052 root dependency manifest changed");
  }
  const options = { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true };
  await cp(join(ROOT, "node_modules"), join(checkout, "node_modules"), options);
  const projects = ["packages/core", "packages/providers", "packages/protocol", "packages/sdk", "packages/store", "apps/agent-router", "apps/agent-runner"];
  for (const project of projects) await cp(join(ROOT, project, "node_modules"), join(checkout, project, "node_modules"), options);
  const virtualStore = await lstat(join(checkout, "node_modules/.pnpm"));
  if (!virtualStore.isDirectory() || virtualStore.isSymbolicLink()) throw new Error("frozen 0052 dependency store is not isolated");
  const realCheckout = await realpath(checkout);
  let links = 0;
  for (const project of ["", "node_modules/.pnpm", ...projects]) {
    const scope = join(checkout, project, "node_modules/@agent-service");
    const names = await readdir(scope).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    for (const name of names) {
      const path = join(scope, name);
      if ((await readlink(path)).startsWith("/") || !(await realpath(path)).startsWith(realCheckout + sep)) {
        throw new Error("frozen 0052 workspace dependency escapes its archive");
      }
      links += 1;
    }
  }
  if (!links) throw new Error("frozen 0052 workspace links are missing");
}

const BUSINESS_TABLES = [
  ["sessions", "session_id"], ["turns", "turn_id"], ["items", "item_id"], ["events", "session_id,seq"],
  ["usage_ledger", "usage_id"], ["billing_usage_facts", "usage_id"],
] as const;
async function businessDigests(conn: Connection) {
  const result: Record<string, string> = {};
  for (const [table, order] of BUSINESS_TABLES) {
    // Compare business columns only: ALTER adds nullable private columns without backfilling body.
    const projection = table === "items" ? "item_id,session_id,user_id,turn_id,seq,type,status,body,created_at_ms,completed_at_ms"
      : table === "events" ? "session_id,seq,user_id,type,body,emitted_at_ms" : "*";
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${projection} FROM ${table} ORDER BY ${order}`);
    result[table] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  return result;
}
async function schemaSnapshot(conn: Connection) {
  const [tables] = await conn.query<RowDataPacket[]>("SELECT table_name,table_collation FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name");
  const [columns] = await conn.query<RowDataPacket[]>("SELECT table_name,column_name,column_type,is_nullable,column_default,character_set_name,collation_name,ordinal_position FROM information_schema.columns WHERE table_schema=DATABASE() ORDER BY table_name,ordinal_position");
  const [constraints] = await conn.query<RowDataPacket[]>("SELECT table_name,constraint_name,constraint_type FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() ORDER BY table_name,constraint_name");
  const [checks] = await conn.query<RowDataPacket[]>("SELECT constraint_name,check_clause FROM information_schema.check_constraints WHERE constraint_schema=DATABASE() ORDER BY constraint_name");
  const [indexes] = await conn.query<RowDataPacket[]>("SELECT table_name,index_name,seq_in_index,column_name,non_unique,sub_part FROM information_schema.statistics WHERE table_schema=DATABASE() ORDER BY table_name,index_name,seq_in_index");
  const [foreignKeys] = await conn.query<RowDataPacket[]>("SELECT table_name,constraint_name,referenced_table_name,update_rule,delete_rule FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() ORDER BY table_name,constraint_name");
  const [triggers] = await conn.query<RowDataPacket[]>("SELECT trigger_name AS trigger_name,event_manipulation,event_object_table,action_timing,action_statement FROM information_schema.triggers WHERE trigger_schema=DATABASE() ORDER BY trigger_name");
  const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name");
  return { tables, columns, constraints, checks, indexes, foreignKeys, triggers, markers };
}
async function counts(conn: Connection) {
  const names = ["tenant_telemetry_capture_v2_activation_receipts", "tenant_telemetry_capture_v2_failure_commit_receipts",
    "tenant_telemetry_capture_v2_coverages", "tenant_telemetry_capture_v2_source_bindings", "tenant_telemetry_write_jobs",
    "tenant_telemetry_write_payloads", "tenant_telemetry_artifact_memberships"];
  const result: Record<string, number> = {};
  for (const name of names) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${name}`); result[name] = Number(rows[0]?.n);
  }
  return result;
}

describe("0052 -> 0053 genuine frozen failed-step historical MySQL upgrade", () => {
  let admin: Connection;
  let base: URL;
  let archiveRoot: string;
  let checkout: string;
  let currentDir: string;
  let oldNames: string[];
  let currentNames: string[];
  const databases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE);
    admin = await mysql.createConnection(databaseUrl(base, "mysql"));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0052-"));
    checkout = join(archiveRoot, "checkout"); await mkdir(checkout);
    currentDir = join(archiveRoot, "through0053"); await mkdir(currentDir);
    expect((await runFixed("resolve commit", "git", ["rev-parse", FROZEN_0052_COMMIT], ROOT, isolatedEnv(archiveRoot), 10_000)).trim()).toBe(FROZEN_0052_COMMIT);
    const tar = join(archiveRoot, "frozen0052.tar");
    await runFixed("archive", "git", ["archive", "--format=tar", `--output=${tar}`, FROZEN_0052_COMMIT], ROOT, isolatedEnv(archiveRoot), 30_000);
    await runFixed("extract", "tar", ["-xf", tar, "-C", checkout], ROOT, isolatedEnv(archiveRoot), 30_000);
    oldNames = (await readdir(join(checkout, "packages/store/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    expect(oldNames.at(-1)).toBe("0052_ordinary_session_usage_retention.sql");
    currentNames = (await readdir(MIGRATIONS)).filter((name) => /^00\d\d_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 53).sort();
    expect(currentNames).toEqual([...oldNames, MIGRATION]);
    // All published migration bytes stay immutable, explicitly including 0049's old hard-deny.
    for (const name of oldNames) expect((await readFile(join(MIGRATIONS, name))).equals(await readFile(join(checkout, "packages/store/migrations", name)))).toBe(true);
    for (const name of currentNames) await copyFile(join(MIGRATIONS, name), join(currentDir, name));
    const fixtures = join(checkout, "packages/store/test/migrations/fixtures");
    await mkdir(fixtures, { recursive: true });
    for (const name of ["pre0053-old-failure-driver.ts", "pre0053-old-verify-probe.ts"]) await copyFile(join(HERE, "fixtures", name), join(fixtures, name));
    await copyIsolatedDependencies(checkout);
    // Build/typecheck frozen source with this same Node, avoiding network/corepack auto-install.
    await runFixed("old source build", process.execPath, ["node_modules/typescript/bin/tsc", "-b", "tsconfig.json"], checkout, isolatedEnv(archiveRoot));
  }, 420_000);

  afterAll(async () => {
    if (admin) {
      for (const name of databases) {
        if (!/^agent_service_migration_test_0053_[0-9]+_[0-9a-f]{8}$/.test(name)) throw new Error("unsafe 0053 fixture cleanup target");
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      }
      await admin.end();
    }
    if (archiveRoot) await rm(archiveRoot, { recursive: true, force: true });
  });

  async function history() {
    const name = `agent_service_migration_test_0053_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const [existing] = await admin.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [name]);
    if (existing.length) throw new Error("0053 disposable database already exists");
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`); databases.add(name);
    const url = databaseUrl(base, name);
    const output = await runFixed("real old failed step", process.execPath, ["--import", "tsx", "packages/store/test/migrations/fixtures/pre0053-old-failure-driver.ts"], checkout, isolatedEnv(archiveRoot, { MYSQL_URL: url }));
    let result: { sourceCommit: string; tenantId: string; userId: string; sessionId: string; turnId: string; itemId: string; lastSeq: number };
    try { result = JSON.parse(output) as typeof result; } catch { throw new Error("frozen 0052 driver output is invalid"); }
    expect(result.sourceCommit).toBe(FROZEN_0052_COMMIT); expect(result.lastSeq).toBe(4);
    return { url, result };
  }
  async function upgrade(url: string, migrationMode: "verify" | "apply" = "apply") {
    const store = await MysqlSessionStore.connect({ url, migrationsDir: currentDir, migrationMode, tenantTelemetryRefKey: REF_KEY }); await store.close();
  }
  async function oldVerify(url: string, rejected: boolean) {
    return runFixed(rejected ? "old post-upgrade fingerprint" : "old pre-upgrade fingerprint", process.execPath, ["--import", "tsx", "packages/store/test/migrations/fixtures/pre0053-old-verify-probe.ts"], checkout,
      isolatedEnv(archiveRoot, { MYSQL_URL: url, EXPECT_0052_FINGERPRINT_REJECTION: rejected ? "1" : "0" }), 30_000);
  }

  it("preserves genuine old NULL failures and inactive aware unknown/gen0 without fabricating a source or activation", async () => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      expect(await oldVerify(f.url, false)).toBe("frozen-0052-verify-accepted");
      const before = await businessDigests(conn);
      const beforeTriggers = (await schemaSnapshot(conn)).triggers;
      expect(beforeTriggers).toHaveLength(647);
      expect(beforeTriggers.every((trigger) => typeof trigger.trigger_name === "string")).toBe(true);
      const [oldMarkers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(oldMarkers.map((row) => row.name)).toEqual(oldNames);
      await upgrade(f.url);
      const afterTriggers = (await schemaSnapshot(conn)).triggers;
      expect(afterTriggers).toHaveLength(662);
      expect(afterTriggers).toHaveLength(beforeTriggers.length + 15);
      expect(afterTriggers.filter((trigger) => !beforeTriggers.some((old) => old.trigger_name === trigger.trigger_name))).toHaveLength(15);
      expect(await businessDigests(conn)).toEqual(before);
      const [legacy] = await conn.query<RowDataPacket[]>("SELECT telemetry_failure_classification,telemetry_capture_v2_control_generation FROM items WHERE item_id=?", [f.result.itemId]);
      expect(legacy[0]).toMatchObject({ telemetry_failure_classification: null, telemetry_capture_v2_control_generation: null });
      const store = await MysqlSessionStore.connect({ url: f.url, migrationsDir: currentDir, migrationMode: "verify", tenantTelemetryRefKey: REF_KEY });
      try {
        expect(await store.getTenantTelemetryPersistedProviderCaptureControl()).toEqual({ domain: "logs", state: "inactive", controlGeneration: 0 });
        expect(await store.getTenantTelemetryPersistedProviderCaptureBinding()).toBeNull();
        expect(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).toBeNull();
        expect(await store.getTenantTelemetryPersistedProviderCaptureCoverage(f.result.tenantId)).toBeNull();
        expect(await store.verifyPersistedProviderStepFailureSource({ tenantId: f.result.tenantId, sessionId: f.result.sessionId, turnId: f.result.turnId, itemId: f.result.itemId, stepIndex: 1 })).toMatchObject({ status: "not_found", sourceCount: 0, executionReady: false, allDomainsComplete: false });
        const session = mkSession(`tenant-aware0053-${randomUUID()}`, `user-aware0053-${randomUUID()}`); await store.createSession(session);
        const at = Date.now(); const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", seqStart: 2, steps: 1, toolCalls: 0, usage: emptyUsage(), startedAtMs: at, metadata: {} };
        await store.commit({ sessionId: session.id, fence: 1, turn, events: [{ type: "turn/started", sessionId: session.id, emittedAtMs: at, turn }] });
        const item: Item = { id: newId("item"), sessionId: session.id, turnId: turn.id, seq: 0, step: 1, type: "agentMessage", status: "failed", createdAtMs: at, completedAtMs: at, text: "inactive generic failure", phase: "finalAnswer" };
        await store.commit({ sessionId: session.id, fence: 1, items: [item], events: [{ type: "item/completed", sessionId: session.id, emittedAtMs: at, item }] });
        const [unknown] = await conn.query<RowDataPacket[]>("SELECT telemetry_failure_classification,telemetry_capture_v2_control_generation,telemetry_capture_v2_operation_sha256 FROM items WHERE item_id=?", [item.id]);
        expect(unknown[0]).toMatchObject({ telemetry_failure_classification: "runtime_unknown", telemetry_capture_v2_control_generation: 0, telemetry_capture_v2_operation_sha256: null });
      } finally { await store.close(); }
      const afterInactiveWrites = await businessDigests(conn);
      await upgrade(f.url, "verify"); expect(await businessDigests(conn)).toEqual(afterInactiveWrites);
      expect(Object.values(await counts(conn))).toEqual(Array(7).fill(0));
      const [controls] = await conn.query<RowDataPacket[]>("SELECT domain,state,control_generation,activated_at_db_ms FROM tenant_telemetry_capture_v2_controls ORDER BY domain");
      expect(controls).toEqual([{ domain: "logs", state: "inactive", control_generation: 0, activated_at_db_ms: null }, { domain: "traces", state: "inactive", control_generation: 0, activated_at_db_ms: null }]);
      const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name"); expect(markers.map((row) => row.name)).toEqual(currentNames);
      expect(await oldVerify(f.url, true)).toBe("frozen-0052-verify-fingerprint-rejected");
      expect((await readFile(join(MIGRATIONS, PUBLISHED_0049))).equals(await readFile(join(checkout, "packages/store/migrations", PUBLISHED_0049)))).toBe(true);
    } finally { await conn.end(); }
  }, 120_000);

  it("never replays even exact complete 0053 DDL after marker loss", async () => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url); await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION]);
      const schema = await schemaSnapshot(conn); const business = await businessDigests(conn);
      await expect(upgrade(f.url)).rejects.toThrow("0053 marker-loss or partial DDL requires controlled forward repair");
      await expect(upgrade(f.url, "verify")).rejects.toThrow();
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
      expect(schema.markers.some((row) => row.name === MIGRATION)).toBe(false);
    } finally { await conn.end(); }
  }, 120_000);

  it.each(["table", "private-column", "guard"] as const)("fails closed without replaying a markerless partial 0053 %s", async (kind) => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      if (kind === "table") await conn.query("CREATE TABLE tenant_telemetry_capture_v2_activation_receipts (fixture INT NOT NULL) ENGINE=InnoDB");
      if (kind === "private-column") await conn.query("ALTER TABLE items ADD COLUMN telemetry_failure_classification VARCHAR(32) NULL");
      if (kind === "guard") await conn.query("CREATE TRIGGER trg_tt_capture_v2_items_bi BEFORE INSERT ON items FOR EACH ROW BEGIN SET NEW.status=NEW.status; END");
      const schema = await schemaSnapshot(conn); const business = await businessDigests(conn);
      await expect(upgrade(f.url)).rejects.toThrow("0053 marker-loss or partial DDL requires controlled forward repair");
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
      expect(schema.markers.some((row) => row.name === MIGRATION)).toBe(false);
    } finally { await conn.end(); }
  }, 120_000);

  it.each(["column", "index", "trigger"] as const)("rejects committed 0053 %s drift under the marker without repair", async (kind) => {
    const f = await history(); const conn = await mysql.createConnection(f.url);
    try {
      await upgrade(f.url);
      if (kind === "column") await conn.query("ALTER TABLE items MODIFY telemetry_failure_classification VARCHAR(33) COLLATE utf8mb4_0900_as_cs NULL");
      if (kind === "index") await conn.query("ALTER TABLE tenant_telemetry_capture_v2_failure_commit_receipts DROP INDEX uk_tt_capture_v2_failure_source");
      if (kind === "trigger") {
        await conn.query("DROP TRIGGER trg_tt_capture_v2_items_bi");
        await conn.query("CREATE TRIGGER trg_tt_capture_v2_items_bi BEFORE INSERT ON items FOR EACH ROW BEGIN SET NEW.status=NEW.status; END");
      }
      const schema = await schemaSnapshot(conn); const business = await businessDigests(conn);
      await expect(upgrade(f.url, "verify")).rejects.toThrow(/0053.*fingerprint/);
      await expect(upgrade(f.url)).rejects.toThrow(/0053.*fingerprint/);
      expect(await schemaSnapshot(conn)).toEqual(schema); expect(await businessDigests(conn)).toEqual(business);
    } finally { await conn.end(); }
  }, 120_000);
});
