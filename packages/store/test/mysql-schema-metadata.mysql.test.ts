import { randomBytes, randomUUID } from "node:crypto";
import { isIP, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type PoolConnection, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../src/index.js";
import {
  buildSchemaMetadataProcedure, SCHEMA_TRIGGER_METADATA_RELATION, SCHEMA_TRIGGER_METADATA_VARIABLE,
  rewriteSchemaMetadataVerifierSql, type SchemaMetadataProcedure,
} from "../src/mysql/schema-metadata-codec.js";
import { readSchemaTriggerMetadata, SchemaMetadataReadError, type SchemaMetadataReaderConfig } from "../src/mysql/schema-metadata.js";
import { withSchemaTriggerMetadataVerifier } from "../src/mysql/schema-metadata-verifier.js";
import { readMysqlSkillRegistryFingerprintStatements } from "../src/mysql/skills-registry.js";
import { mkSession } from "./conformance.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const SQL_MODE = "STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const ACK = "all-application-writers-stopped-v1" as const;
const ACTIVE_REF_KEY = Buffer.alloc(32, 0x63); // Fixture-only; never logged or used outside this owned app database.
const CASE_COUNT = 17;
function fail(): never { throw new Error("Schema metadata isolated MySQL fixture is not proven."); }
function literalClientHost(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[%_@\\/\u0000-\u0020\u007f]/.test(value)
    && (isIP(value) !== 0 || value.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)));
}
function base(): URL {
  let url: URL;
  try { url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/"); } catch { return fail(); }
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.search || url.hash || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) fail();
  return url;
}
function at(source: URL, database: string, user?: string, password?: string): string {
  const url = new URL(source); url.pathname = `/${database}`;
  if (user !== undefined) { url.username = user; url.password = password ?? ""; }
  return url.toString();
}
function account(user: string, host: string) { return `${mysql.escape(user)}@${mysql.escape(host)}`; }
function errno(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value: unknown = Reflect.get(error, "errno"); return Number.isSafeInteger(value) ? Number(value) : null;
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("least-privilege schema trigger metadata on actual isolated MySQL", () => {
  let source: URL, admin: Connection | undefined, native: Connection | undefined, store: MysqlSessionStore | undefined;
  let database = "", metadataSchema = "", uuid = "", adminId = 0, host = "", ready = false;
  let grantMode: 0 | 1;
  let runtimeUser = "", noShowUser = "", definerUser = "", otherDefinerUser = "", password = "";
  let procedure: SchemaMetadataProcedure, config: SchemaMetadataReaderConfig;
  const ownedDatabases = new Set<string>(), ownedAccounts = new Set<string>();
  const connections = new Map<Connection, { socket: Socket; closed: Promise<void> }>();
  function owner() { if (!admin) return fail(); return admin; }
  function inspector() { if (!native) return fail(); return native; }
  async function connect(url: string): Promise<Connection> {
    let conn: Connection;
    try { conn = await mysql.createConnection(url); } catch { return fail(); }
    const raw: unknown = Reflect.get(conn, "connection");
    const socket: unknown = raw && typeof raw === "object" ? Reflect.get(raw, "stream") : undefined;
    if (!(socket instanceof Socket)) { conn.destroy(); return fail(); }
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => { socket.once("close", () => resolve()); });
    connections.set(conn, { socket, closed }); return conn;
  }
  async function close(conn: Connection): Promise<void> {
    const entry = connections.get(conn); if (!entry) return fail();
    let failed = false;
    const timer = setTimeout(() => { failed = true; entry.socket.destroy(); }, 2_000);
    try { try { await conn.end(); } catch { failed = true; entry.socket.destroy(); } await entry.closed; }
    finally { clearTimeout(timer); connections.delete(conn); }
    if (failed) fail();
  }
  async function execute(conn: Connection, sql: string, values: unknown[] = []): Promise<void> {
    try { await conn.query({ sql, timeout: 10_000 }, values); } catch { return fail(); }
  }
  async function rows(conn: Connection, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
    try {
      const [result] = await conn.query<RowDataPacket[]>({ sql, timeout: 10_000 }, values);
      if (!Array.isArray(result)) return fail(); return result;
    } catch { return fail(); }
  }
  async function partialRevokes(): Promise<0 | 1> {
    const result = await rows(owner(), "SELECT @@GLOBAL.partial_revokes AS partial_revokes");
    const value: unknown = result[0]?.partial_revokes;
    if (result.length !== 1 || value !== 0 && value !== 1) return fail();
    return value;
  }
  async function grantSchemaTrigger(user: string): Promise<void> {
    if (await partialRevokes() !== grantMode) fail();
    const name = grantMode === 0 ? database.replaceAll("_", "\\_").replaceAll("%", "\\%") : database;
    await execute(owner(), `GRANT TRIGGER ON ${mysql.escapeId(name)}.* TO ${account(user, host)}`);
    if (await partialRevokes() !== grantMode) fail();
  }
  async function runtime<T>(work: (conn: Connection) => Promise<T>, user = runtimeUser): Promise<T> {
    const conn = await connect(at(source, database, user, password)), entry = connections.get(conn);
    if (!entry) return fail();
    // This is a local fixture cancellation barrier, not a product timeout extension.
    const timer = setTimeout(() => { conn.destroy(); entry.socket.destroy(); }, 25_000);
    try { return await work(conn); } finally { clearTimeout(timer); await close(conn); }
  }
  async function installRoutine(change: "body" | "security" | "definer" | "parameter" | null = null): Promise<void> {
    let sql = procedure.createSql;
    if (change === "body") sql = sql.replace("SELECT\n", "SELECT DISTINCT\n");
    if (change === "security") sql = sql.replace("SQL SECURITY DEFINER", "SQL SECURITY INVOKER");
    if (change === "parameter") sql = sql.replace("()\nLANGUAGE SQL", "(IN fixture_unused INT)\nLANGUAGE SQL");
    sql = sql.replace("CREATE PROCEDURE", `CREATE DEFINER=${account(change === "definer" ? otherDefinerUser : definerUser, host)} PROCEDURE`);
    await execute(owner(), "SET SESSION sql_mode=?", [SQL_MODE]);
    await execute(owner(), "SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
    await execute(owner(), `DROP PROCEDURE IF EXISTS \`${metadataSchema}\`.\`${procedure.routineName}\``);
    await execute(owner(), sql);
    // DROP/CREATE can remove routine-specific grants. A DEFINER also needs exact EXECUTE;
    // neither locked account receives login capability or any other routine authority.
    for (const user of [runtimeUser, noShowUser, definerUser, otherDefinerUser]) await execute(owner(),
      `GRANT EXECUTE ON PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\` TO ${account(user, host)}`);
  }
  async function assertReaderRejected(conn: Connection): Promise<void> {
    const sent: string[] = [];
    const recorder = { query: async (sql: string, values?: QueryValues) => {
      sent.push(sql); return conn.query(sql, values);
    } } as Pick<PoolConnection, "query">;
    const error: unknown = await readSchemaTriggerMetadata(recorder, config).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaMetadataReadError);
    expect(error).toMatchObject({ name: "SchemaMetadataReadError", code: "schema_metadata_invalid", message: "Schema trigger metadata is invalid." });
    expect(error instanceof Error && Object.hasOwn(error, "cause")).toBe(false);
    expect(sent.some(sql => /^\s*CALL\b/i.test(sql))).toBe(false);
  }
  async function calibratedWarnings(conn: Connection): Promise<void> {
    const counts = await rows(conn, "SHOW COUNT(*) WARNINGS"), count = Number(counts[0]?.["@@session.warning_count"]);
    if (counts.length !== 1 || !Number.isSafeInteger(count) || count < 0 || count > 64) fail();
    if (count === 0) return;
    const warnings = await rows(conn, "SHOW WARNINGS");
    expect(warnings).toHaveLength(count);
    expect(warnings.every(row => row.Level === "Warning" && [3719, 3778].includes(Number(row.Code)))).toBe(true);
  }
  async function rootFlag(conn: Connection, snapshot: readonly unknown[]): Promise<number> {
    const selected = await readMysqlSkillRegistryFingerprintStatements(conn, MIGRATIONS);
    try {
      await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=?`, [JSON.stringify(snapshot)]);
      await execute(conn, "SET @schema_metadata_fixture_gcml=@@SESSION.group_concat_max_len");
      await execute(conn, "SET SESSION group_concat_max_len=1048576");
      await execute(conn, rewriteSchemaMetadataVerifierSql(selected.triggers));
      await calibratedWarnings(conn);
      const result = await rows(conn, "SELECT @skill_registry_triggers_ok AS ok");
      if (result.length !== 1) return fail(); return Number(result[0]?.ok);
    } finally {
      await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=NULL`);
      await execute(conn, "SET SESSION group_concat_max_len=@schema_metadata_fixture_gcml");
      await execute(conn, "SET @schema_metadata_fixture_gcml=NULL");
    }
  }

  beforeAll(async () => {
    source = base(); admin = await connect(at(source, "mysql"));
    const identity = await rows(admin, "SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS client_host");
    uuid = String(identity[0]?.uuid).toLowerCase(); adminId = Number(identity[0]?.id); host = String(identity[0]?.client_host);
    if (identity.length !== 1 || !/^[a-f0-9-]{36}$/.test(uuid) || !Number.isSafeInteger(adminId) || adminId < 1
      // The transport target remains loopback. Docker may report its bridge IP
      // or exact DNS name in USER(); never turn that observation into a host pattern.
      || identity[0]?.db !== "mysql" || !literalClientHost(host)) fail();
    grantMode = await partialRevokes();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    database = `agent_service_schema_metadata_test_${suffix}`; metadataSchema = `${database}_meta`;
    for (const name of [database, metadataSchema]) {
      if (!/^agent_service_schema_metadata_test_[a-f0-9]{12}(?:_meta)?$/.test(name)) fail();
      if ((await rows(admin, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length) fail();
      await execute(admin, `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); ownedDatabases.add(name);
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110_000);
    try { await MysqlSessionStore.runSchemaOperation({ url: at(source, database), operation: "migrate",
      operationAbortSignal: controller.signal, fleetStoppedAck: ACK, migrationLockTimeoutSeconds: 1 }); }
    finally { clearTimeout(timer); }
    native = await connect(at(source, database));
    const actual = await rows(native, "SELECT @@server_uuid AS uuid,DATABASE() AS db");
    if (actual.length !== 1 || String(actual[0]?.uuid).toLowerCase() !== uuid || actual[0]?.db !== database) fail();
    runtimeUser = `sm_rt_${suffix}`; noShowUser = `sm_ns_${suffix}`;
    definerUser = `sm_df_${suffix}`; otherDefinerUser = `sm_da_${suffix}`; password = randomBytes(32).toString("hex");
    for (const user of [runtimeUser, noShowUser, definerUser, otherDefinerUser]) {
      if (!/^sm_(?:rt|ns|df|da)_[a-f0-9]{12}$/.test(user)) fail();
      if ((await rows(admin, "SELECT User,Host FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, host])).length) fail();
      await execute(admin, `CREATE USER ${account(user, host)} ${user === runtimeUser || user === noShowUser ? "IDENTIFIED BY ?" : "ACCOUNT LOCK"}`,
        user === runtimeUser || user === noShowUser ? [password] : []); ownedAccounts.add(user);
    }
    const tables = await rows(admin, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [database]);
    for (const table of tables) {
      const target = `\`${database}\`.${mysql.escapeId(String(table.TABLE_NAME))}`;
      for (const user of [definerUser, otherDefinerUser]) await execute(admin, `GRANT SELECT ON ${target} TO ${account(user, host)}`);
      for (const user of [runtimeUser, noShowUser]) await execute(admin,
        `GRANT ${user === runtimeUser && table.TABLE_NAME !== "schema_migrations" ? "SELECT,INSERT,UPDATE,DELETE" : "SELECT"} ON ${target} TO ${account(user, host)}`);
    }
    // The locked definer must also observe future unknown app tables, not only this initial set.
    for (const user of [definerUser, otherDefinerUser]) await grantSchemaTrigger(user);
    await execute(admin, `GRANT SHOW_ROUTINE ON *.* TO ${account(runtimeUser, host)}`);
    procedure = buildSchemaMetadataProcedure(database, metadataSchema);
    config = { metadataSchema, trustedDefiner: { user: definerUser, host } };
    await installRoutine();
    try { store = await MysqlSessionStore.connect({ url: at(source, database), migrationMode: "verify", connectionLimit: 1 }); }
    catch { fail(); }
    ready = true;
  }, 120_000);

  afterAll(async ({}, suite) => {
    const deadline = performance.now() + 120_000, removedDatabases = new Set<string>(), removedAccounts = new Set<string>();
    const passed = ready && suite.tasks.length === CASE_COUNT && suite.tasks.every(task => task.type === "test" && task.mode === "run"
      && task.result?.state === "pass" && !task.result.errors?.length && (task.result.retryCount ?? 0) === 0
      && (task.result.repeatCount ?? 0) === 0 && typeof task.result.duration === "number" && task.result.duration <= 30_000);
    let settled = true;
    try {
      try { await store?.close(); store = undefined; } catch { settled = false; }
      for (const conn of [...connections.keys()]) if (conn !== admin) { try { await close(conn); } catch { settled = false; } }
      native = undefined;
      if (passed && settled) {
        const identity = await rows(owner(), "SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db");
        if (identity.length !== 1 || String(identity[0]?.uuid).toLowerCase() !== uuid || Number(identity[0]?.id) !== adminId || identity[0]?.db !== "mysql") fail();
        for (;;) {
          const counts: number[] = [];
          for (const name of ownedDatabases) {
            if (name !== database && name !== metadataSchema || !/^agent_service_schema_metadata_test_[a-f0-9]{12}(?:_meta)?$/.test(name)) fail();
            for (const [sql, values] of [
              ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [name]],
              ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [name]],
              ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [name, name]],
            ] as const) {
              const result = await rows(owner(), sql, [...values]); if (result.length !== 1) fail(); counts.push(Number(result[0]?.n));
            }
          }
          for (const user of ownedAccounts) {
            const result = await rows(owner(), "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [user]);
            if (result.length !== 1) fail(); counts.push(Number(result[0]?.n));
          }
          if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) fail();
          if (counts.every(n => n === 0)) break;
          if (performance.now() >= deadline) fail(); await new Promise(resolve => setTimeout(resolve, 10));
        }
        // Remove the routine schema before its locked DEFINER accounts; never touch the supplied base database.
        for (const name of [metadataSchema, database]) {
          if (!ownedDatabases.has(name) || performance.now() >= deadline) fail();
          if ((await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length !== 1) fail();
          await execute(owner(), `DROP DATABASE \`${name}\``);
          if ((await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length) fail();
          removedDatabases.add(name);
        }
        for (const user of ownedAccounts) {
          if (![runtimeUser, noShowUser, definerUser, otherDefinerUser].includes(user) || performance.now() >= deadline) fail();
          await execute(owner(), `DROP USER ${account(user, host)}`);
          if ((await rows(owner(), "SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, host])).length) fail();
          removedAccounts.add(user);
        }
      }
    } finally {
      if (admin) await close(admin); admin = undefined;
      const databases = [...ownedDatabases].filter(name => !removedDatabases.has(name));
      const accounts = [...ownedAccounts].filter(name => !removedAccounts.has(name));
      if (databases.length || accounts.length) console.warn(JSON.stringify({ schema: "schema-metadata-fixture-cleanup-v1", status: "retained_or_unknown", databases, accounts }));
      if (!settled) fail();
    }
  }, 120_000);

  it("reads all 842 actual native trigger rows through the locked DEFINER and preserves every JSON_TABLE field", async () => runtime(async conn => {
    expect(await rows(conn, "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()")).toEqual([]);
    const snapshot = await readSchemaTriggerMetadata(conn, config), expected = await rows(inspector(), procedure.expectedDefinition);
    expect(snapshot.applicationDatabase).toBe(database); expect(snapshot.rows).toHaveLength(842); expect(snapshot.rows).toEqual(expected);
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.rows) && snapshot.rows.every(Object.isFrozen)).toBe(true);
    try {
      await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=?`, [JSON.stringify(snapshot.rows)]);
      const actual = await rows(conn, `SELECT * FROM ${SCHEMA_TRIGGER_METADATA_RELATION} AS metadata_rows ORDER BY BINARY TRIGGER_NAME`);
      await calibratedWarnings(conn); expect(actual).toEqual(expected);
    } finally { await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=NULL`); }
  }));

  it("observes a real unknown table trigger without a new table grant and rejects the changed complete native root", async () => runtime(async conn => {
    const table = "schema_metadata_unknown_fixture", trigger = "trg_schema_metadata_unknown_fixture";
    const baseline = await readSchemaTriggerMetadata(conn, config), nativeBefore = await rows(inspector(), procedure.expectedDefinition);
    expect(baseline.rows).toHaveLength(842); expect(baseline.rows).toEqual(nativeBefore);
    expect(await rootFlag(conn, baseline.rows)).toBe(1);
    expect(await rows(inspector(), "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ?", [table])).toEqual([]);
    expect(await rows(inspector(), "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND BINARY TRIGGER_NAME=BINARY ?", [trigger])).toEqual([]);
    let tableAttempted = false, triggerAttempted = false;
    try {
      tableAttempted = true;
      await execute(inspector(), `CREATE TABLE ${mysql.escapeId(table)} (id INT PRIMARY KEY) ENGINE=InnoDB`);
      triggerAttempted = true;
      await execute(inspector(), `CREATE TRIGGER ${mysql.escapeId(trigger)} BEFORE INSERT ON ${mysql.escapeId(table)} FOR EACH ROW SET NEW.id = NEW.id`);
      const snapshot = await readSchemaTriggerMetadata(conn, config), nativeAfter = await rows(inspector(), procedure.expectedDefinition);
      expect(snapshot.rows).toHaveLength(843); expect(snapshot.rows).toEqual(nativeAfter);
      expect(snapshot.rows.filter(row => row.TRIGGER_NAME === trigger)).toEqual([{
        TRIGGER_SCHEMA: database, TRIGGER_NAME: trigger, EVENT_MANIPULATION: "INSERT", EVENT_OBJECT_TABLE: table,
        ACTION_ORDER: 1, ACTION_CONDITION: null, ACTION_STATEMENT: "SET NEW.id = NEW.id", ACTION_ORIENTATION: "ROW", ACTION_TIMING: "BEFORE",
      }]);
      expect(await rootFlag(conn, snapshot.rows)).toBe(0);
    } finally {
      if (triggerAttempted) await execute(inspector(), `DROP TRIGGER IF EXISTS ${mysql.escapeId(trigger)}`);
      if (tableAttempted) await execute(inspector(), `DROP TABLE IF EXISTS ${mysql.escapeId(table)}`);
      const restored = await readSchemaTriggerMetadata(conn, config);
      expect(restored.rows).toHaveLength(842); expect(restored.rows).toEqual(baseline.rows);
      expect(await rows(inspector(), procedure.expectedDefinition)).toEqual(nativeBefore);
      expect(await rootFlag(conn, restored.rows)).toBe(1);
    }
  }));

  it("preserves a separate 70000-byte Unicode action statement without TEXT truncation or NULL substitution", async () => runtime(async conn => {
    const snapshot = await readSchemaTriggerMetadata(conn, config), first = snapshot.rows[0]; if (!first) return fail();
    const text = `${"汉".repeat(23_333)}a`; expect(Buffer.byteLength(text, "utf8")).toBe(70_000);
    const input = [{ ...first, ACTION_STATEMENT: text }];
    try {
      await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=?`, [JSON.stringify(input)]);
      const actual = await rows(conn, `SELECT * FROM ${SCHEMA_TRIGGER_METADATA_RELATION} AS metadata_rows`);
      await calibratedWarnings(conn); expect(actual).toEqual(input);
      expect(actual[0]?.ACTION_CONDITION).toBeNull(); expect(Buffer.byteLength(String(actual[0]?.ACTION_STATEMENT), "utf8")).toBe(70_000);
    } finally { await execute(conn, `SET ${SCHEMA_TRIGGER_METADATA_VARIABLE}=NULL`); }
  }));

  it("natively denies runtime CREATE, ALTER and DROP TRIGGER despite normal app-table IUD grants", async () => runtime(async conn => {
    for (const sql of ["CREATE TABLE schema_metadata_forbidden_fixture(id INT)", "ALTER TABLE sessions ADD COLUMN schema_metadata_forbidden_fixture INT", "DROP TRIGGER trg_subagent_root_turns_bd"]) {
      const failure: unknown = await conn.query(sql).then(() => null, (error: unknown) => error); expect(errno(failure)).toBe(1142);
    }
  }));

  it("natively keeps schema_migrations read-only for runtime INSERT, UPDATE and DELETE", async () => runtime(async conn => {
    for (const sql of ["INSERT INTO schema_migrations(name,applied_at_ms) VALUES('schema_metadata_forbidden_fixture.sql',0)",
      "UPDATE schema_migrations SET applied_at_ms=applied_at_ms", "DELETE FROM schema_migrations WHERE name='0064_subagents.sql'"]) {
      const failure: unknown = await conn.query(sql).then(() => null, (error: unknown) => error); expect(errno(failure)).toBe(1142);
    }
  }));

  it("fails closed on a fresh EXECUTE-capable connection without SHOW_ROUTINE", async () => runtime(async conn => {
    await assertReaderRejected(conn);
  }, noShowUser));

  it.each(["body", "security", "definer", "parameter"] as const)("rejects exact routine %s drift before dispatch and accepts only its restored definition", async change => {
    try { await installRoutine(change); await runtime(assertReaderRejected); }
    finally { await installRoutine(); }
    await runtime(async conn => { expect((await readSchemaTriggerMetadata(conn, config)).rows).toHaveLength(842); });
  });

  it("starts the public verify-only Store and atomically creates a session with least-privilege metadata access", async () => {
    let opened: MysqlSessionStore | undefined;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25_000);
    try {
      opened = await MysqlSessionStore.connect({ url: at(source, database, runtimeUser, password),
        migrationMode: "verify", schemaMetadata: config, connectionLimit: 1, operationAbortSignal: controller.signal });
      await expect(opened.migrate()).rejects.toThrow("verify-only schema metadata runtime cannot apply migrations");
      const session = mkSession(`schema_metadata_${randomUUID()}`, "fixture_user");
      const committed = await opened.createSession(session);
      expect(committed.lastSeq).toBe(1);
      expect(committed.events).toEqual([{ type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 }]);
      expect(await opened.getSession(session.tenantId, session.id)).toMatchObject({ id: session.id, lastSeq: 1 });
      expect(await opened.getSession("other_fixture_tenant", session.id)).toBeNull();
      expect(await opened.readEvents(session.id, 0, 10)).toEqual(committed.events);
    } catch { fail(); }
    finally { try { await opened?.close(); } finally { clearTimeout(timer); } }
    const remaining = await rows(owner(), "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [runtimeUser]);
    expect(remaining).toEqual([{ n: 0 }]);
  });

  it("runs the complete original current verifier with the product facade and matches every native result row", async () => {
    if (!store) return fail();
    const verifier: unknown = Object.getOwnPropertyDescriptor(MysqlSessionStore.prototype, "verifyMigrations")?.value;
    if (typeof verifier !== "function") return fail();
    const transcript: { sql: string; values: unknown; rows: unknown }[] = [];
    const capture = { query: async (sql: string, values?: QueryValues) => {
      const result = await inspector().query(sql, values); transcript.push({ sql, values: structuredClone(values), rows: structuredClone(result[0]) }); return result;
    } } as Pick<PoolConnection, "query">;
    await Reflect.apply(verifier, store, [MIGRATIONS, true, capture]);
    expect(transcript.length).toBeGreaterThan(0);
    await runtime(async conn => {
      let index = 0;
      await withSchemaTriggerMetadataVerifier(conn, config, async facade => {
        const checked = { query: async (sql: string, values?: QueryValues) => {
          const expected = transcript[index++]; if (!expected) return fail();
          expect(sql).toBe(expected.sql); expect(values).toEqual(expected.values);
          const result = await facade.query(sql, values);
          if (Array.isArray(result[0])) expect(result[0]).toEqual(expected.rows);
          else {
            if (!result[0] || typeof result[0] !== "object" || !expected.rows || typeof expected.rows !== "object") return fail();
            for (const field of ["fieldCount", "affectedRows", "insertId", "info", "changedRows"]) {
              expect(Reflect.get(result[0], field)).toEqual(Reflect.get(expected.rows, field));
            }
            // The product facade independently checks every warning; packet prototype identity
            // and the two calibrated native parser-deprecation warnings are not schema rows.
          }
          return result;
        } } as Pick<PoolConnection, "query">;
        await Reflect.apply(verifier, store, [MIGRATIONS, true, checked]);
      });
      expect(index).toBe(transcript.length);
      const cleared = await rows(conn, `SELECT ${SCHEMA_TRIGGER_METADATA_VARIABLE} AS payload`); expect(cleared).toEqual([{ payload: null }]);
    });
  });

  it.each(["missing", "extra", "body", "null-to-empty"] as const)("the actual full 842-trigger root rejects %s snapshot drift without changing native DDL", async kind => runtime(async conn => {
    const snapshot = await readSchemaTriggerMetadata(conn, config), first = snapshot.rows[0]; if (!first) return fail();
    const before = await rows(inspector(), procedure.expectedDefinition);
    expect(await rootFlag(conn, snapshot.rows)).toBe(1);
    const changed: readonly unknown[] = kind === "missing" ? snapshot.rows.slice(1)
      : kind === "extra" ? [...snapshot.rows, { ...first, TRIGGER_NAME: "trg_schema_metadata_extra_fixture" }]
      : snapshot.rows.map((row, index) => index !== 0 ? row : kind === "body"
        ? { ...row, ACTION_STATEMENT: `${row.ACTION_STATEMENT} SELECT 2;` }
        // This deliberately bypasses the strict reader to exercise the unchanged SQL NULL guard.
        : { ...row, ACTION_CONDITION: "" });
    expect(await rootFlag(conn, changed)).not.toBe(1);
    expect(await rows(inspector(), procedure.expectedDefinition)).toEqual(before);
    expect(await rootFlag(conn, snapshot.rows)).toBe(1);
  }));

  it("retains native active-ref-key startup admission through the metadata bridge without changing durable rows", async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25_000);
    const session = mkSession(`schema_metadata_active_${randomUUID()}`, "schema_metadata_active_owner");
    let activating: MysqlSessionStore | undefined, accepted: MysqlSessionStore | undefined;
    try {
      activating = await MysqlSessionStore.connect({ url: at(source, database), migrationMode: "verify",
        tenantTelemetryRefKey: ACTIVE_REF_KEY, connectionLimit: 1, operationAbortSignal: controller.signal });
      await activating.createSession(session);
      await activating.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0,
        targets: (["logs", "traces"] as const).map((domain, index) => ({ domain, backendKind: "test_sink", adapterProtocol: "telemetry-test-v1",
          namespaceSha256: Buffer.alloc(32, 0x41 + index).toString("hex"), failureDomainSha256: Buffer.alloc(32, 0x51 + index).toString("hex") })) });
      await activating.close(); activating = undefined;

      const tables = ["tenant_telemetry_lifecycle_control", "tenant_telemetry_lifecycle_targets", "tenant_telemetry_lifecycle_coverages",
        "tenant_telemetry_activation_receipts", "sessions", "events"];
      const ordered: { table: string; order: string }[] = [];
      for (const table of tables) {
        const primary = await rows(inspector(), "SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [table]);
        if (primary.length === 0 || primary.some(row => typeof row.COLUMN_NAME !== "string")) fail();
        ordered.push({ table, order: primary.map(row => mysql.escapeId(String(row.COLUMN_NAME))).join(",") });
      }
      const image = async () => {
        const result: { table: string; rows: RowDataPacket[] }[] = [];
        for (const { table, order } of ordered) result.push({ table, rows: await rows(inspector(), `SELECT * FROM ${mysql.escapeId(table)} ORDER BY ${order}`) });
        return result;
      };
      const before = await image();
      for (const key of [undefined, Buffer.alloc(32, 0x64)]) {
        let unexpected: MysqlSessionStore | undefined, failure: unknown;
        try {
          unexpected = await MysqlSessionStore.connect({ url: at(source, database, runtimeUser, password), migrationMode: "verify",
            schemaMetadata: config, connectionLimit: 1, operationAbortSignal: controller.signal,
            ...(key === undefined ? {} : { tenantTelemetryRefKey: key }) });
        } catch (error) { failure = error; }
        finally { await unexpected?.close(); }
        expect(unexpected === undefined).toBe(true);
        expect(failure instanceof Error && failure.message === "active tenant telemetry lifecycle requires the exact stable ref key").toBe(true);
        expect(await image()).toEqual(before);
      }
      accepted = await MysqlSessionStore.connect({ url: at(source, database, runtimeUser, password), migrationMode: "verify",
        schemaMetadata: config, tenantTelemetryRefKey: ACTIVE_REF_KEY, connectionLimit: 1, operationAbortSignal: controller.signal });
      expect(await accepted.getSession(session.tenantId, session.id)).toMatchObject({ id: session.id, lastSeq: 1 });
      expect(await accepted.readEvents(session.id, 0, 10)).toEqual([{ type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 }]);
      await accepted.close(); accepted = undefined;
      expect(await image()).toEqual(before);
    } finally {
      try { await activating?.close(); await accepted?.close(); } finally { clearTimeout(timer); }
    }
  });
});
