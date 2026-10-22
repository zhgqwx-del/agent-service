import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../../test/fixtures/mysql-runtime.mjs";
import { MysqlSessionStore } from "../../src/mysql/store.js";
import { MCP_DCR_MIGRATION, MCP_DCR_TABLES, MCP_DCR_TRIGGERS } from "../../src/mysql/mcp-dcr.js";
import { McpRegistryIntegrityError } from "../../src/mcp-registry.js";
import { SkillRegistryIntegrityError } from "../../src/skills.js";
import { mcpFixtureExchange, mcpFixtureWrite } from "../fixtures/mcp-registry.js";
import { mcpDcrWrite } from "../fixtures/mcp-dcr.js";
import { installFrozenDependencies } from "./fixtures/frozen-dependencies.js";

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FROZEN_0064_SHA = "3a5f1026347bc01622a0bd68c135e457e4d528bd";
const ACK = "all-application-writers-stopped-v1" as const, exec = promisify(execFile);
function fail(): never { throw new Error("0065 historical fixture is not proven; retain evidence"); }
function identifier(value: string) { if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) fail(); return `\`${value}\``; }
function base() {
  const result = new URL(process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? "mysql://invalid/");
  if (result.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(result.hostname) || result.search || result.hash
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(result.pathname.slice(1)))) fail(); return result;
}
function at(url: URL, database: string) { const result = new URL(url); result.pathname = `/${database}`; return result.toString(); }
function remaining(deadline: number, signal?: AbortSignal) { const left = Math.floor(deadline - performance.now()); if (left <= 0 || signal?.aborted) fail(); return left; }
function env(scratch: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CI: "1", NODE_ENV: "test", NO_COLOR: "1", COREPACK_ENABLE_NETWORK: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...extra };
}
async function processCall(file: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, deadline: number, signal?: AbortSignal) {
  try {
    const result = await exec(file, args, { cwd, env: environment, timeout: remaining(deadline, signal), killSignal: "SIGKILL", maxBuffer: 1048576 });
    remaining(deadline, signal); if (result.stderr !== "") fail(); return result.stdout.trim();
  } catch { throw new Error("Frozen 0064 process did not prove its exact expected result"); }
}
const frozenProbe = `
import { MysqlSessionStore } from './packages/store/src/mysql/store.ts';
import { SkillRegistryIntegrityError } from './packages/store/src/skills.ts';
const mode=process.env.FROZEN_MODE;
const schemaMetadata={metadataSchema:process.env.FROZEN_META_SCHEMA,trustedDefiner:{user:process.env.FROZEN_META_USER,host:process.env.FROZEN_META_HOST}};
let store;
try {
  if(!['verify','migrate'].includes(mode)) throw new Error('mode');
  try {
    if(mode==='verify') store=await MysqlSessionStore.connect({url:process.env.FROZEN_RUNTIME_URL,migrationMode:'verify',schemaMetadata});
    else await MysqlSessionStore.runSchemaOperation({url:process.env.FROZEN_OPERATOR_URL,operation:'migrate',operationAbortSignal:AbortSignal.timeout(20000),fleetStoppedAck:'all-application-writers-stopped-v1'});
    throw new Error('old-binary-accepted');
  } catch(error) {
    if(!(error instanceof SkillRegistryIntegrityError)) throw new Error('wrong-old-binary-oracle');
    process.stdout.write('frozen-0064-'+mode+'-rejected\\n');
  }
} catch { process.stderr.write('frozen-0064-proof-failed\\n'); process.exitCode=1; }
finally { if(store) { try { await store.close(); } catch { process.exitCode=1; } } }
`;
async function snapshot(conn: Connection) {
  const [tables] = await conn.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME");
  const data: unknown[] = [];
  for (const row of tables) {
    const name = String(row.name); if (name === "schema_migrations" || MCP_DCR_TABLES.includes(name as typeof MCP_DCR_TABLES[number])) continue;
    const [keys] = await conn.query<RowDataPacket[]>("SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name]);
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${identifier(name)}${keys.length ? ` ORDER BY ${keys.map(k => identifier(String(k.name))).join(",")}` : ""}`);
    data.push([name, rows]);
  }
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
describe("0064 nonempty OAuth to immutable 0065 DCR historical migration", () => {
  let source: URL, admin: Connection, oldDirectory = "", targetDirectory = "", archiveRoot = "", frozenSource = "", serverUuid = "";
  let caseDeadline = 0, caseSignal: AbortSignal | undefined;
  beforeAll(async () => {
    const deadline = performance.now() + 120000; source = base(); admin = await mysql.createConnection({ uri: at(source, "mysql"), connectTimeout: 5000 });
    const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS uuid,DATABASE() AS db", timeout: 5000 });
    serverUuid = String(identity[0]?.uuid).toLowerCase(); if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(serverUuid) || identity[0]?.db !== "mysql") fail();
    oldDirectory = await mkdtemp(join(tmpdir(), "agent-service-before-dcr-")); targetDirectory = await mkdtemp(join(tmpdir(), "agent-service-through-dcr-"));
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql") && n < MCP_DCR_MIGRATION)) await copyFile(join(migrations, name), join(oldDirectory, name));
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql") && n <= MCP_DCR_MIGRATION)) await copyFile(join(migrations, name), join(targetDirectory, name));
    archiveRoot = await mkdtemp(join(tmpdir(), "agent-service-frozen0064-")); frozenSource = join(archiveRoot, "source"); await mkdir(frozenSource);
    const environment = env(archiveRoot), archive = join(archiveRoot, "source.tar");
    expect(await processCall("git", ["rev-parse", "--verify", `${FROZEN_0064_SHA}^{commit}`], repository, environment, deadline)).toBe(FROZEN_0064_SHA);
    await processCall("git", ["merge-base", "--is-ancestor", FROZEN_0064_SHA, "HEAD"], repository, environment, deadline);
    await processCall("git", ["archive", "--format=tar", `--output=${archive}`, FROZEN_0064_SHA], repository, environment, deadline);
    await processCall("tar", ["-xf", archive, "-C", frozenSource], repository, environment, deadline); await installFrozenDependencies(repository, frozenSource); remaining(deadline);
  }, 120000);
  beforeEach(context => { caseDeadline = performance.now() + (context.task.timeout ?? 30_000); caseSignal = context.signal; });
  afterAll(async () => { await admin?.end(); }, 120000);
  async function fixture(work: (ctx: { conn: Connection; operatorUrl: string; runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>>; before: string; upgrade(): Promise<void> }) => Promise<void>) {
    const signal = caseSignal; if (!signal) fail(); remaining(caseDeadline, signal);
    const lifetime = new AbortController(), database = `agent_service_migration_test_0065_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const abort = () => lifetime.abort(); signal.addEventListener("abort", abort, { once: true });
    let runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined, old: MysqlSessionStore | undefined, conn: Connection | undefined;
    try {
      const operatorUrl = at(source, database), witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl, applicationDatabase: database, operationAbortSignal: lifetime.signal });
      await admin.query({ sql: `CREATE DATABASE ${identifier(database)} CHARACTER SET utf8mb4`, timeout: remaining(caseDeadline, signal) });
      runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: options => MysqlSessionStore.runSchemaOperation({ ...options, migrationsDir: oldDirectory }) });
      old = await MysqlSessionStore.connect({ ...runtime.runtimeStoreOptions, migrationsDir: oldDirectory });
      const subject = { tenantId: `history-${randomUUID()}`, userId: "alice" }, owner = { scope: "user" as const, tenantId: subject.tenantId, userId: subject.userId };
      await old.upsertMcpRegistration(mcpFixtureWrite(owner, subject)); await mcpFixtureExchange(old, owner, subject); await old.close(); old = undefined;
      conn = await mysql.createConnection({ uri: operatorUrl, connectTimeout: 5000 });
      const [identity] = await conn.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
      if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== serverUuid || identity[0]?.db !== database) fail();
      const before = await snapshot(conn), selectedRuntime = runtime;
      const upgrade = async () => {
        remaining(caseDeadline, signal);
        await MysqlSessionStore.runSchemaOperation({ operation: "migrate", url: operatorUrl, migrationsDir: targetDirectory, operationAbortSignal: lifetime.signal, fleetStoppedAck: ACK });
        const user = decodeURIComponent(new URL(selectedRuntime.runtimeStoreOptions.url).username), host = selectedRuntime.runtimeStoreOptions.schemaMetadata.trustedDefiner.host;
        await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${identifier(database)}.mcp_registry_dynamic_clients TO ${mysql.escape(user)}@${mysql.escape(host)}`);
        await MysqlSessionStore.runSchemaOperation({ operation: "verify", url: operatorUrl, migrationsDir: targetDirectory, operationAbortSignal: lifetime.signal });
        remaining(caseDeadline, signal);
      };
      await work({ conn, operatorUrl, runtime, before, upgrade }); remaining(caseDeadline, signal);
    } finally {
      const closed = await Promise.allSettled([old?.close(), conn?.end()]);
      try { if (runtime) await runtime.close({ successful: false }); if (closed.some(r => r.status !== "fulfilled")) fail(); }
      finally { signal.removeEventListener("abort", abort); lifetime.abort(); }
    }
  }
  it("preserves nonempty pre-registered OAuth bytes and all 842 native guards while adding exactly eleven guards", async () => {
    await fixture(async c => {
      const [beforeGuards] = await c.conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME"); expect(beforeGuards).toHaveLength(842);
      await c.upgrade(); expect(await snapshot(c.conn)).toBe(c.before);
      const [after] = await c.conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      expect(after).toHaveLength(853); expect(after.filter(row => !MCP_DCR_TRIGGERS.includes(String(row.TRIGGER_NAME) as typeof MCP_DCR_TRIGGERS[number]))).toEqual(beforeGuards);
      const [newRows] = await c.conn.query<RowDataPacket[]>("SELECT operation_id FROM mcp_registry_dynamic_clients"); expect(newRows).toEqual([]);
      const cold = await MysqlSessionStore.connect({ ...c.runtime.runtimeStoreOptions, migrationsDir: targetDirectory }); await cold.close();
    });
  });
  it("refuses dynamic intent publication on an explicit pre-0065 schema", async () => {
    await fixture(async c => {
      const old = await MysqlSessionStore.connect({ ...c.runtime.runtimeStoreOptions, migrationsDir: oldDirectory });
      try { const subject = { tenantId: "pre-dcr-new-owner", userId: "alice" }, owner = { scope: "user" as const, tenantId: subject.tenantId, userId: subject.userId };
        await expect(old.upsertMcpRegistration(mcpDcrWrite(owner, subject))).rejects.toThrow(McpRegistryIntegrityError); }
      finally { await old.close(); }
      expect(await snapshot(c.conn)).toBe(c.before);
    });
  }, 60_000);
  it("rejects marker loss before reapplying any CREATE and retains every original row and guard", async () => {
    await fixture(async c => {
      await c.upgrade(); await c.conn.query("DELETE FROM schema_migrations WHERE name=?", [MCP_DCR_MIGRATION]);
      const [guards] = await c.conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      await expect(c.upgrade()).rejects.toThrow(SkillRegistryIntegrityError);
      const [after] = await c.conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME"); expect(after).toEqual(guards); expect(await snapshot(c.conn)).toBe(c.before);
    });
  }, 60_000);
  it("rejects a table-only auto-committed partial installation with no automatic DDL replay", async () => {
    await fixture(async c => {
      const sql = await readFile(join(targetDirectory, MCP_DCR_MIGRATION), "utf8"), statement = sql.split(/;\s*\n/).map(v => v.replace(/^\s*--.*$/gm, "").trim()).find(v => v.startsWith("CREATE TABLE mcp_registry_dynamic_clients "));
      if (!statement) fail(); await c.conn.query(statement); await expect(c.upgrade()).rejects.toThrow(SkillRegistryIntegrityError);
      const [tables] = await c.conn.query<RowDataPacket[]>("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mcp_registry_dynamic_clients'"); expect(tables).toHaveLength(1); expect(await snapshot(c.conn)).toBe(c.before);
    });
  }, 60_000);
  it("missing dynamic-ready native guard fails verify without replacing the guard or changing predecessor rows", async () => {
    await fixture(async c => {
      await c.upgrade(); await c.conn.query("DROP TRIGGER trg_mcp_dcr_pending_bi");
      await expect(MysqlSessionStore.connect({ ...c.runtime.runtimeStoreOptions, migrationsDir: targetDirectory })).rejects.toThrow(SkillRegistryIntegrityError);
      const [guards] = await c.conn.query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='trg_mcp_dcr_pending_bi'"); expect(guards).toEqual([]); expect(await snapshot(c.conn)).toBe(c.before);
    });
  }, 60_000);
  it("actual published 0064 binary rejects verify and explicit migrate on 0065 without changing historical bytes", async () => {
    await fixture(async c => {
      await c.upgrade(); const [markers] = await c.conn.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY name"), [guards] = await c.conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      const meta = c.runtime.runtimeStoreOptions.schemaMetadata;
      for (const mode of ["verify", "migrate"] as const) {
        const result = await processCall(process.execPath, ["--import", "tsx", "--input-type=module", "-e", frozenProbe], frozenSource,
          env(archiveRoot, { FROZEN_MODE: mode, FROZEN_RUNTIME_URL: c.runtime.runtimeStoreOptions.url, FROZEN_OPERATOR_URL: c.operatorUrl,
            FROZEN_META_SCHEMA: meta.metadataSchema, FROZEN_META_USER: meta.trustedDefiner.user, FROZEN_META_HOST: meta.trustedDefiner.host }), caseDeadline, caseSignal);
        expect(result).toBe(`frozen-0064-${mode}-rejected`);
      }
      const [afterMarkers] = await c.conn.query<RowDataPacket[]>("SELECT * FROM schema_migrations ORDER BY name"), [afterGuards] = await c.conn.query<RowDataPacket[]>("SELECT * FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY TRIGGER_NAME");
      expect(afterMarkers).toEqual(markers); expect(afterGuards).toEqual(guards); expect(await snapshot(c.conn)).toBe(c.before);
    });
  }, 60_000);
});
