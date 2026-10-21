import { randomBytes, randomUUID } from "node:crypto";
import { isIP, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type PoolConnection, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../src/index.js";
import { buildSchemaMetadataProcedure, type SchemaMetadataProcedure } from "../src/mysql/schema-metadata-codec.js";
import { installSchemaMetadataProcedure, SchemaMetadataInstallError } from "../src/mysql/schema-metadata-install.js";
import { readSchemaTriggerMetadata, type SchemaMetadataReaderConfig } from "../src/mysql/schema-metadata.js";
import { assertSchemaRuntimePrivileges, SchemaRuntimePrivilegesError } from "../src/mysql/schema-runtime-privileges.js";
import { mkSession } from "./conformance.js";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const ACK = "dedicated-disposable-server-v1";
const CASE_COUNT = 19;
const SESSION_SQL = "SELECT @@SESSION.sql_mode AS sql_mode,@@SESSION.character_set_client AS character_set_client,@@SESSION.character_set_results AS character_set_results,@@SESSION.character_set_connection AS character_set_connection,@@SESSION.collation_connection AS collation_connection";
function fail(): never { throw new Error("Schema authority dedicated MySQL fixture is not proven."); }
function literalClientHost(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[%_@\\/\u0000-\u0020\u007f]/.test(value)
    && (isIP(value) !== 0 || value.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)));
}
function base(): URL {
  let url: URL; try { url = new URL(process.env.MYSQL_TEST_URL ?? "mysql://invalid/"); } catch { return fail(); }
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash
    || !/(?:^|[_-])test(?:$|[_-])/i.test(decodeURIComponent(url.pathname.slice(1)))) fail();
  return url;
}
function at(source: URL, database: string, user?: string, password?: string): string {
  const url = new URL(source); url.pathname = `/${database}`;
  if (user !== undefined) { url.username = user; url.password = password ?? ""; }
  return url.toString();
}
function account(user: string, host: string) { return `${mysql.escape(user)}@${mysql.escape(host)}`; }
function nativeErrno(error: unknown): number | null {
  const value: unknown = error && typeof error === "object" ? Reflect.get(error, "errno") : null;
  return Number.isSafeInteger(value) ? Number(value) : null;
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("schema installer and runtime authority on a dedicated disposable MySQL", () => {
  let source: URL, admin: Connection | undefined, inspect: Connection | undefined;
  let database = "", metadataSchema = "", similarDatabase = "", uuid = "", host = "", adminId = 0, ready = false;
  let grantMode: 0 | 1;
  let runtimeUser = "", installerUser = "", lowInstallerUser = "", definerUser = "", roleUser = "", proxyActorUser = "", password = "";
  let procedure: SchemaMetadataProcedure, config: SchemaMetadataReaderConfig, originalMandatory = "", globalDirty = false;
  const ownedDatabases = new Set<string>(), ownedAccounts = new Map<string, "user" | "role">();
  const connections = new Map<Connection, { socket: Socket; closed: Promise<void>; id: number }>();
  function owner() { if (!admin) return fail(); return admin; }
  function inspector() { if (!inspect) return fail(); return inspect; }
  function acct(user: string) { return account(user, host); }
  async function connect(url: string): Promise<Connection> {
    let conn: Connection; try { conn = await mysql.createConnection(url); } catch { return fail(); }
    const raw: unknown = Reflect.get(conn, "connection");
    const socket: unknown = raw && typeof raw === "object" ? Reflect.get(raw, "stream") : undefined;
    if (!(socket instanceof Socket)) { conn.destroy(); return fail(); }
    const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => { socket.once("close", () => resolve()); });
    connections.set(conn, { socket, closed, id: 0 });
    const identity = await rows(conn, "SELECT CONNECTION_ID() AS id,@@server_uuid AS uuid");
    const id = Number(identity[0]?.id);
    if (identity.length !== 1 || !Number.isSafeInteger(id) || id < 1 || uuid && String(identity[0]?.uuid).toLowerCase() !== uuid) fail();
    connections.set(conn, { socket, closed, id }); return conn;
  }
  async function close(conn: Connection): Promise<void> {
    const entry = connections.get(conn); if (!entry) return fail();
    let failed = false; const timer = setTimeout(() => { failed = true; entry.socket.destroy(); }, 2_000);
    try { try { await conn.end(); } catch { failed = true; entry.socket.destroy(); } await entry.closed; }
    finally { clearTimeout(timer); connections.delete(conn); }
    if (failed) fail();
  }
  async function execute(conn: Connection, sql: string, values: QueryValues = []): Promise<void> {
    try { await conn.query({ sql, timeout: 10_000 }, values); } catch { return fail(); }
  }
  async function rows(conn: Connection, sql: string, values: QueryValues = []): Promise<RowDataPacket[]> {
    try { const [result] = await conn.query<RowDataPacket[]>({ sql, timeout: 10_000 }, values); if (!Array.isArray(result)) return fail(); return result; }
    catch { return fail(); }
  }
  async function partialRevokes(): Promise<0 | 1> {
    const result = await rows(owner(), "SELECT @@GLOBAL.partial_revokes AS partial_revokes");
    const value: unknown = result[0]?.partial_revokes;
    if (result.length !== 1 || value !== 0 && value !== 1) return fail();
    return value;
  }
  async function grantSchema(privilege: "TRIGGER" | "CREATE ROUTINE", name: string, user: string): Promise<void> {
    if (await partialRevokes() !== grantMode) fail();
    const target = grantMode === 0 ? name.replaceAll("_", "\\_").replaceAll("%", "\\%") : name;
    await execute(owner(), `GRANT ${privilege} ON ${mysql.escapeId(target)}.* TO ${acct(user)}`);
    if (await partialRevokes() !== grantMode) fail();
  }
  async function caller<T>(user: string, work: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await connect(at(source, database, user, password)), entry = connections.get(conn); if (!entry) return fail();
    const timer = setTimeout(() => { conn.destroy(); entry.socket.destroy(); }, 20_000);
    try { return await work(conn); } finally { clearTimeout(timer); await close(conn); }
  }
  function accountForms(user: string): string[] {
    return [acct(user), `${mysql.escapeId(user, true)}@${mysql.escapeId(host, true)}`];
  }
  async function proxyActor<T>(work: (conn: Connection) => Promise<T>): Promise<T> {
    // USAGE-only identities cannot select the application (or mysql) database.
    const conn = await connect(at(source, "", proxyActorUser, password)), entry = connections.get(conn); if (!entry) return fail();
    const timer = setTimeout(() => { conn.destroy(); entry.socket.destroy(); }, 20_000);
    let failed = false;
    try {
      const identity = await rows(conn, "SELECT DATABASE() AS db,USER() AS user_identity,CURRENT_USER() AS effective_identity,CURRENT_ROLE() AS active_roles,@@GLOBAL.mandatory_roles AS mandatory_roles,@@SESSION.proxy_user AS proxy_account");
      expect(identity.length === 1 && identity[0]?.db === null && identity[0]?.user_identity === `${proxyActorUser}@${host}`
        && identity[0]?.effective_identity === identity[0]?.user_identity && identity[0]?.active_roles === "NONE"
        && identity[0]?.mandatory_roles === "" && identity[0]?.proxy_account === null).toBe(true);
      const grants = await rows(conn, "SHOW GRANTS"), values = grants.flatMap(row => Object.values(row));
      expect(grants.length === 1 && values.length === 1 && accountForms(proxyActorUser).some(account => values[0] === `GRANT USAGE ON *.* TO ${account}`)).toBe(true);
      return await work(conn);
    } catch (error) { failed = true; throw error; }
    finally {
      clearTimeout(timer);
      // A real close failure still fails a successful operation, never masks its first error.
      try { await close(conn); } catch (error) { if (!failed) throw error; }
    }
  }
  async function proxyMutation(conn: Connection, operation: "grant" | "revoke"): Promise<void> {
    const sql = operation === "grant"
      ? `GRANT PROXY ON ${acct(proxyActorUser)} TO ${acct(runtimeUser)}`
      : `REVOKE PROXY ON ${acct(proxyActorUser)} FROM ${acct(runtimeUser)}`;
    try { await conn.query({ sql, timeout: 10_000 }); }
    catch (error) {
      // Preserve the first native stage without exposing mysql2's SQL/message/cause.
      const value: unknown = error && typeof error === "object" ? Reflect.get(error, "code") : null;
      const state: unknown = error && typeof error === "object" ? Reflect.get(error, "sqlState") : null;
      const code = typeof value === "string" && /^ER_[A-Z0-9_]+$/.test(value) ? value : "unclassified";
      const sqlState = typeof state === "string" && /^[0-9A-Z]{5}$/.test(state) ? state : "unclassified";
      throw new Error(`Schema authority PROXY ${operation} failed: ${code}; errno=${nativeErrno(error) ?? "unclassified"}; sqlState=${sqlState}.`);
    }
  }
  async function sameServer(conn = owner()): Promise<void> {
    const result = await rows(conn, "SELECT @@server_uuid AS uuid");
    if (result.length !== 1 || String(result[0]?.uuid).toLowerCase() !== uuid
      || process.env.MYSQL_TEST_AUTHORITY_ACK !== ACK || process.env.MYSQL_TEST_OWNED_SERVER_UUID?.toLowerCase() !== uuid) fail();
  }
  async function externalConnections(): Promise<number[]> {
    await sameServer(); const allowed = new Set([...connections.values()].map(value => value.id));
    const result = await rows(owner(), "SELECT ID FROM information_schema.PROCESSLIST WHERE COMMAND<>'Daemon'");
    const ids = result.map(row => Number(row.ID)); if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) fail();
    return ids.filter(id => !allowed.has(id));
  }
  async function restoreMandatory(): Promise<void> {
    if (!globalDirty) return;
    // Undo this fixture's own change even if an unexpected client has appeared. Never restore
    // into another server; a restore failure keeps globalDirty true and fails the fixture.
    const restore = async (conn: Connection) => {
      await sameServer(conn); await execute(conn, "SET GLOBAL mandatory_roles=?", [originalMandatory]);
      const actual = await rows(conn, "SELECT @@GLOBAL.mandatory_roles AS value");
      if (actual.length !== 1 || actual[0]?.value !== originalMandatory) fail(); globalDirty = false;
    };
    try { await restore(owner()); }
    catch {
      // A failed original admin socket must not suppress the safety rollback. This is only an
      // exact replay of the original empty value on the UUID-bound disposable server.
      const recovery = await connect(at(source, "mysql"));
      try { await restore(recovery); } finally { await close(recovery); }
    }
  }
  async function grantExactExecute(user: string): Promise<void> {
    await execute(owner(), `GRANT EXECUTE ON PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\` TO ${acct(user)}`);
  }
  async function grantsAfterCreate(): Promise<void> { for (const user of [runtimeUser, installerUser, definerUser]) await grantExactExecute(user); }
  async function dropRoutine(): Promise<void> { await execute(owner(), `DROP PROCEDURE IF EXISTS \`${metadataSchema}\`.\`${procedure.routineName}\``); }
  async function installExact(): Promise<void> {
    await caller(installerUser, conn => installSchemaMetadataProcedure(conn, config)); await grantsAfterCreate();
  }
  async function restoredRoutine(): Promise<void> { await dropRoutine(); await installExact(); }
  function recorder(conn: Connection, sent: string[], createFailures: number[] = []): Pick<PoolConnection, "query"> {
    return { query: async (sql: string, values?: QueryValues) => {
      sent.push(sql);
      try { return await conn.query(sql, values); }
      catch (error) { if (/^\s*CREATE\b/i.test(sql)) createFailures.push(nativeErrno(error) ?? -1); throw error; }
    } } as Pick<PoolConnection, "query">;
  }
  async function installRejected(conn: Connection, input = config, createFailures: number[] = []): Promise<string[]> {
    const sent: string[] = [];
    const failure: unknown = await installSchemaMetadataProcedure(recorder(conn, sent, createFailures), input).then(() => null, (error: unknown) => error);
    expect(failure instanceof SchemaMetadataInstallError && failure.code === "schema_metadata_install_failed"
      && failure.message === "Schema metadata procedure installation failed.").toBe(true);
    expect(sent.some(sql => /^\s*(?:DROP|CALL)\b/i.test(sql))).toBe(false); return sent;
  }
  async function privilegesRejected(conn: Connection): Promise<void> {
    const failure: unknown = await assertSchemaRuntimePrivileges(conn, config).then(() => null, (error: unknown) => error);
    expect(failure instanceof SchemaRuntimePrivilegesError && failure.code === "schema_runtime_privileges_invalid"
      && failure.message === "Schema runtime privileges are invalid.").toBe(true);
  }
  async function positivePrivileges(): Promise<void> { await caller(runtimeUser, conn => assertSchemaRuntimePrivileges(conn, config)); }

  beforeAll(async () => {
    if (process.env.MYSQL_TEST_AUTHORITY_ACK !== ACK || !/^[a-f0-9-]{36}$/i.test(process.env.MYSQL_TEST_OWNED_SERVER_UUID ?? "")) fail();
    source = base(); admin = await connect(at(source, "mysql"));
    const identity = await rows(admin, "SELECT @@server_uuid AS uuid,CONNECTION_ID() AS id,DATABASE() AS db,SUBSTRING_INDEX(USER(),'@',-1) AS client_host,@@GLOBAL.mandatory_roles AS mandatory_roles");
    uuid = String(identity[0]?.uuid).toLowerCase(); adminId = Number(identity[0]?.id); host = String(identity[0]?.client_host);
    if (identity.length !== 1 || identity[0]?.db !== "mysql" || !literalClientHost(host)
      || uuid !== process.env.MYSQL_TEST_OWNED_SERVER_UUID?.toLowerCase() || !Number.isSafeInteger(adminId) || adminId < 1
      || identity[0]?.mandatory_roles !== "") fail();
    originalMandatory = ""; if ((await externalConnections()).length !== 0) fail();
    grantMode = await partialRevokes();
    // All checks above precede the first CREATE/GRANT or other persistent fixture mutation.
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    database = `agent_service_schema_authority_test_${suffix}`; metadataSchema = `${database}_meta`; similarDatabase = `${database}_similar`;
    for (const name of [database, metadataSchema, similarDatabase]) {
      if (!/^agent_service_schema_authority_test_[a-f0-9]{12}(?:_meta|_similar)?$/.test(name)) fail();
      if ((await rows(admin, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length) fail();
      await execute(admin, `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); ownedDatabases.add(name);
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110_000);
    try { await MysqlSessionStore.runSchemaOperation({ url: at(source, database), operation: "migrate", operationAbortSignal: controller.signal,
      fleetStoppedAck: "all-application-writers-stopped-v1", migrationLockTimeoutSeconds: 1, migrationsDir: MIGRATIONS }); }
    finally { clearTimeout(timer); }
    inspect = await connect(at(source, database));
    await execute(admin, `CREATE TABLE \`${similarDatabase}\`.foreign_table(id INT PRIMARY KEY) ENGINE=InnoDB`);
    runtimeUser = `sa_rt_${suffix}`; installerUser = `sa_in_${suffix}`; lowInstallerUser = `sa_lo_${suffix}`;
    definerUser = `sa_df_${suffix}`; roleUser = `sa_ro_${suffix}`; proxyActorUser = `sa_px_${suffix}`; password = randomBytes(32).toString("hex");
    for (const user of [runtimeUser, installerUser, lowInstallerUser, definerUser, roleUser, proxyActorUser]) {
      if (!/^sa_(?:rt|in|lo|df|ro|px)_[a-f0-9]{12}$/.test(user)) fail();
      if ((await rows(admin, "SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, host])).length) fail();
      if (user === roleUser) { await execute(admin, `CREATE ROLE ${acct(user)}`); ownedAccounts.set(user, "role"); }
      else { await execute(admin, `CREATE USER ${acct(user)} IDENTIFIED BY ?${user === definerUser ? " ACCOUNT LOCK" : ""}`, [password]); ownedAccounts.set(user, "user"); }
    }
    const tables = await rows(admin, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [database]);
    for (const table of tables) {
      const target = `\`${database}\`.${mysql.escapeId(String(table.TABLE_NAME))}`;
      await execute(admin, `GRANT ${table.TABLE_NAME === "schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${target} TO ${acct(runtimeUser)}`);
      for (const user of [installerUser, lowInstallerUser]) await execute(admin, `GRANT SELECT ON ${target} TO ${acct(user)}`);
    }
    for (const user of [definerUser, installerUser, lowInstallerUser]) await grantSchema("TRIGGER", database, user);
    await execute(admin, `GRANT SHOW_ROUTINE ON *.* TO ${acct(runtimeUser)}`);
    for (const user of [installerUser, lowInstallerUser]) {
      await execute(admin, `GRANT SELECT (User,Host,account_locked) ON mysql.user TO ${acct(user)}`);
      await grantSchema("CREATE ROUTINE", metadataSchema, user);
      await execute(admin, `GRANT SELECT ON \`${database}\`.schema_migrations TO ${acct(user)}`);
      await execute(admin, `GRANT SHOW_ROUTINE ON *.* TO ${acct(user)}`);
    }
    await execute(admin, `GRANT SET_USER_ID ON *.* TO ${acct(installerUser)}`);
    procedure = buildSchemaMetadataProcedure(database, metadataSchema); config = { metadataSchema, trustedDefiner: { user: definerUser, host } };
    if ((await rows(admin, "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ? AND BINARY ROUTINE_NAME=BINARY ?", [metadataSchema, procedure.routineName])).length) fail();
    ready = true;
  }, 120_000);

  afterAll(async ({}, suite) => {
    const deadline = performance.now() + 120_000, removedDatabases = new Set<string>(), removedAccounts = new Set<string>();
    let settled = true;
    const passed = ready && suite.tasks.length === CASE_COUNT && suite.tasks.every(task => task.type === "test" && task.mode === "run"
      && task.result?.state === "pass" && !task.result.errors?.length && (task.result.retryCount ?? 0) === 0
      && (task.result.repeatCount ?? 0) === 0 && typeof task.result.duration === "number" && task.result.duration <= 30_000);
    try {
      // This safety rollback is required even when the mandatory-role test or a hook failed.
      try { await restoreMandatory(); } catch { settled = false; }
      for (const conn of [...connections.keys()]) if (conn !== admin) { try { await close(conn); } catch { settled = false; } }
      inspect = undefined;
      if (passed && settled) {
        await sameServer();
        const identity = await rows(owner(), "SELECT CONNECTION_ID() AS id,DATABASE() AS db,@@GLOBAL.mandatory_roles AS mandatory_roles");
        if (identity.length !== 1 || Number(identity[0]?.id) !== adminId || identity[0]?.db !== "mysql" || identity[0]?.mandatory_roles !== ""
          || (await externalConnections()).length !== 0) fail();
        for (;;) {
          const counts: number[] = [];
          for (const name of ownedDatabases) {
            if (![database, metadataSchema, similarDatabase].includes(name) || !/^agent_service_schema_authority_test_[a-f0-9]{12}(?:_meta|_similar)?$/.test(name)) fail();
            for (const [sql, values] of [
              ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [name]],
              ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [name]],
              ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [name, name]],
            ] as const) { const result = await rows(owner(), sql, [...values]); if (result.length !== 1) fail(); counts.push(Number(result[0]?.n)); }
          }
          for (const user of ownedAccounts.keys()) {
            const result = await rows(owner(), "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [user]);
            if (result.length !== 1) fail(); counts.push(Number(result[0]?.n));
          }
          if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) fail(); if (counts.every(count => count === 0)) break;
          if (performance.now() >= deadline) fail(); await new Promise(resolve => setTimeout(resolve, 10));
        }
        for (const name of [metadataSchema, database, similarDatabase]) {
          if (!ownedDatabases.has(name) || performance.now() >= deadline) fail();
          if ((await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length !== 1) fail();
          await execute(owner(), `DROP DATABASE \`${name}\``);
          if ((await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name])).length) fail(); removedDatabases.add(name);
        }
        for (const [user, kind] of ownedAccounts) {
          if (![runtimeUser, installerUser, lowInstallerUser, definerUser, roleUser, proxyActorUser].includes(user) || performance.now() >= deadline) fail();
          await execute(owner(), `DROP ${kind === "role" ? "ROLE" : "USER"} ${acct(user)}`);
          if ((await rows(owner(), "SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, host])).length) fail(); removedAccounts.add(user);
        }
      }
    } finally {
      const databases = [...ownedDatabases].filter(name => !removedDatabases.has(name)), accounts = [...ownedAccounts.keys()].filter(name => !removedAccounts.has(name));
      if (databases.length || accounts.length) console.warn(JSON.stringify({ schema: "schema-authority-fixture-cleanup-v1", status: "retained_or_unknown", databases, accounts, globalRestored: !globalDirty }));
      if (admin) await close(admin); admin = undefined; if (!settled || globalDirty) fail();
    }
  }, 120_000);

  it("installs an absent procedure, exactly replays it and restores all five actual caller session settings", async () => caller(installerUser, async conn => {
    await execute(conn, "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'"); await execute(conn, "SET NAMES latin1 COLLATE latin1_swedish_ci");
    await execute(conn, "SET SESSION character_set_results=NULL"); const before = await rows(conn, SESSION_SQL), sent: string[] = [];
    await installSchemaMetadataProcedure(recorder(conn, sent), config);
    expect(sent.filter(sql => /^\s*CREATE\b/i.test(sql))).toHaveLength(1); expect(sent.some(sql => /^\s*(?:DROP|CALL)\b/i.test(sql))).toBe(false);
    expect(await rows(conn, SESSION_SQL)).toEqual(before); sent.length = 0;
    await installSchemaMetadataProcedure(recorder(conn, sent), config);
    expect(sent.some(sql => /^\s*(?:CREATE|DROP|CALL|SET)\b/i.test(sql))).toBe(false); expect(await rows(conn, SESSION_SQL)).toEqual(before);
    await grantsAfterCreate();
    await caller(runtimeUser, async runtime => { expect((await readSchemaTriggerMetadata(runtime, config)).rows).toHaveLength(853); });
  }));

  it("replays the actual public stopped-fleet install one-shot with the operator and preserves native schema evidence", async () => {
    const before = { routine: await rows(owner(), `SHOW CREATE PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\``),
      markers: await rows(inspector(), "SELECT name,applied_at_ms FROM schema_migrations ORDER BY BINARY name"),
      triggers: await rows(inspector(), procedure.expectedDefinition) };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25_000);
    try {
      expect(await MysqlSessionStore.runSchemaOperation({ url: at(source, database, installerUser, password), operation: "install-metadata",
        schemaMetadata: config, operationAbortSignal: controller.signal, fleetStoppedAck: "all-application-writers-stopped-v1",
        migrationLockTimeoutSeconds: 1, migrationsDir: MIGRATIONS })).toBeUndefined();
    } catch { fail(); }
    finally { clearTimeout(timer); }
    expect(await rows(owner(), "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [installerUser])).toEqual([{ n: 0 }]);
    expect(await rows(owner(), `SHOW CREATE PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\``)).toEqual(before.routine);
    expect(await rows(inspector(), "SELECT name,applied_at_ms FROM schema_migrations ORDER BY BINARY name")).toEqual(before.markers);
    expect(await rows(inspector(), procedure.expectedDefinition)).toEqual(before.triggers);
    await caller(runtimeUser, async conn => { expect((await readSchemaTriggerMetadata(conn, config)).rows).toHaveLength(853); });
  });

  it("rejects an existing changed procedure body without dropping or replacing its native definition", async () => {
    try {
      await dropRoutine();
      const changed = procedure.createSql.replace("SELECT\n", "SELECT DISTINCT\n").replace("CREATE PROCEDURE", `CREATE DEFINER=${acct(definerUser)} PROCEDURE`);
      await execute(inspector(), "SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
      await execute(inspector(), "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
      await execute(inspector(), changed);
      const before = await rows(owner(), `SHOW CREATE PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\``);
      await caller(installerUser, async conn => { const sent = await installRejected(conn); expect(sent.some(sql => /^\s*CREATE\b/i.test(sql))).toBe(false); });
      expect(await rows(owner(), `SHOW CREATE PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\``)).toEqual(before);
    } finally { await restoredRoutine(); }
  });

  it("rejects the actual unlocked DEFINER account without changing or recreating the routine", async () => {
    try { await execute(owner(), `ALTER USER ${acct(definerUser)} ACCOUNT UNLOCK`); await caller(installerUser, async conn => { await installRejected(conn); }); }
    finally { await execute(owner(), `ALTER USER ${acct(definerUser)} ACCOUNT LOCK`); }
  });

  it("rejects a genuinely absent DEFINER account without provisioning one", async () => {
    const missing = `${definerUser}_x`;
    expect(await rows(owner(), "SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [missing, host])).toEqual([]);
    await caller(installerUser, async conn => { await installRejected(conn, { ...config, trustedDefiner: { user: missing, host } }); });
    expect(await rows(owner(), "SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [missing, host])).toEqual([]);
  });

  it("rejects a genuinely absent metadata schema without creating it", async () => {
    const missing = `${metadataSchema}_x`;
    expect(await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [missing])).toEqual([]);
    await caller(installerUser, async conn => { await installRejected(conn, { ...config, metadataSchema: missing }); });
    expect(await rows(owner(), "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [missing])).toEqual([]);
  });

  it("natively rejects CREATE-as-DEFINER without SET_USER_ID and leaves no procedure behind", async () => {
    try {
      await dropRoutine();
      await caller(lowInstallerUser, async conn => { const failures: number[] = []; await installRejected(conn, config, failures); expect(failures).toEqual([1227]); });
      expect(await rows(owner(), "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ? AND BINARY ROUTINE_NAME=BINARY ?", [metadataSchema, procedure.routineName])).toEqual([]);
    } finally { await restoredRoutine(); }
  });

  it("replays an existing exact procedure without EXECUTE, then reads only after an explicit operator grant", async () => {
    try {
      await execute(owner(), `REVOKE EXECUTE ON PROCEDURE \`${metadataSchema}\`.\`${procedure.routineName}\` FROM ${acct(installerUser)}`);
      await caller(installerUser, async conn => {
        const nativeFailure: unknown = await conn.query(procedure.callSql).then(() => null, (error: unknown) => error); expect(nativeErrno(nativeFailure)).toBe(1370);
        const sent: string[] = []; await installSchemaMetadataProcedure(recorder(conn, sent), config);
        expect(sent.some(sql => /^\s*(?:CREATE|DROP|CALL)\b/i.test(sql))).toBe(false);
        await grantExactExecute(installerUser); expect((await readSchemaTriggerMetadata(conn, config)).rows).toHaveLength(853);
      });
    } finally { await grantExactExecute(installerUser); }
  });

  it("accepts only actual per-table runtime rights with native NONE roles, empty mandatory roles and NULL proxy identity", async () => caller(runtimeUser, async conn => {
    const identity = await rows(conn, "SELECT CURRENT_USER() AS effective_account,CURRENT_ROLE() AS active_roles,@@GLOBAL.mandatory_roles AS mandatory_roles,@@SESSION.proxy_user AS proxy_account");
    expect(identity).toEqual([{ effective_account: `${runtimeUser}@${host}`, active_roles: "NONE", mandatory_roles: "", proxy_account: null }]);
    expect(await assertSchemaRuntimePrivileges(conn, config)).toBeUndefined();
  }));

  it("rejects a missing required UPDATE right on an actual visible application table", async () => {
    try { await execute(owner(), `REVOKE UPDATE ON \`${database}\`.sessions FROM ${acct(runtimeUser)}`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `GRANT UPDATE ON \`${database}\`.sessions TO ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects an extra native CREATE privilege", async () => {
    try { await execute(owner(), `GRANT CREATE ON \`${database}\`.* TO ${acct(runtimeUser)}`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `REVOKE CREATE ON \`${database}\`.* FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects an extra native table TRIGGER privilege", async () => {
    try { await execute(owner(), `GRANT TRIGGER ON \`${database}\`.sessions TO ${acct(runtimeUser)}`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `REVOKE TRIGGER ON \`${database}\`.sessions FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects native GRANT OPTION even when every required runtime right remains present", async () => {
    try { await execute(owner(), `GRANT SELECT ON \`${database}\`.sessions TO ${acct(runtimeUser)} WITH GRANT OPTION`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `REVOKE GRANT OPTION ON \`${database}\`.sessions FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects schema-wide SELECT rather than trusting underscore or percent grant patterns", async () => {
    try { await execute(owner(), `GRANT SELECT ON \`${database}\`.* TO ${acct(runtimeUser)}`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `REVOKE SELECT ON \`${database}\`.* FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects a table privilege in a different similarly named owned database", async () => {
    try { await execute(owner(), `GRANT SELECT ON \`${similarDatabase}\`.foreign_table TO ${acct(runtimeUser)}`); await caller(runtimeUser, privilegesRejected); }
    finally { await execute(owner(), `REVOKE SELECT ON \`${similarDatabase}\`.foreign_table FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects an actually granted role even while the fresh caller has explicitly disabled it", async () => {
    try {
      await execute(owner(), `GRANT ${acct(roleUser)} TO ${acct(runtimeUser)}`);
      await caller(runtimeUser, async conn => { await execute(conn, "SET ROLE NONE"); expect(await rows(conn, "SELECT CURRENT_ROLE() AS active_roles")).toEqual([{ active_roles: "NONE" }]); await privilegesRejected(conn); });
    } finally { await execute(owner(), `REVOKE ${acct(roleUser)} FROM ${acct(runtimeUser)}`); }
    await positivePrivileges();
  });

  it("rejects a native PROXY grant even when no proxy authentication is currently active", async () => {
    await positivePrivileges();
    const proxyRows = () => rows(owner(), "SELECT Host,User,Proxied_host,Proxied_user,With_grant FROM mysql.proxies_priv WHERE BINARY Host=BINARY ? AND BINARY User=BINARY ? AND BINARY Proxied_host=BINARY ? AND BINARY Proxied_user=BINARY ?", [host, runtimeUser, host, proxyActorUser]);
    expect((await proxyRows()).length).toBe(0);
    let grantAttempted = false, grantSucceeded = false, firstFailure: { error: unknown } | undefined;
    try {
      await proxyActor(async conn => {
        grantAttempted = true; // A failed/unknown response is not proof the grant did not commit.
        await proxyMutation(conn, "grant"); grantSucceeded = true;
      });
      await caller(runtimeUser, async conn => {
        try {
          expect(await rows(conn, "SELECT @@SESSION.proxy_user AS proxy_account")).toEqual([{ proxy_account: null }]);
          const grants = await rows(conn, "SHOW GRANTS"); expect(grants.some(row => Object.values(row).some(value => typeof value === "string" && /^GRANT PROXY\b/.test(value)))).toBe(true);
          const proxies = grants.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string" && /^GRANT PROXY\b/.test(value)));
          expect(proxies.length === 1 && accountForms(proxyActorUser).some(from => accountForms(runtimeUser).some(to => proxies[0] === `GRANT PROXY ON ${from} TO ${to}`))).toBe(true);
          await privilegesRejected(conn);
        } catch (error) { firstFailure ??= { error }; throw error; }
      });
    } catch (error) { firstFailure ??= { error }; }
    finally {
      if (grantAttempted) {
        try {
          const actual = await proxyRows();
          expect(actual.length <= 1 && (!grantSucceeded || actual.length === 1)).toBe(true);
          if (actual.length === 1) {
            expect(actual[0]?.Host === host && actual[0]?.User === runtimeUser && actual[0]?.Proxied_host === host
              && actual[0]?.Proxied_user === proxyActorUser && Number(actual[0]?.With_grant) === 0).toBe(true);
            await proxyActor(conn => proxyMutation(conn, "revoke"));
          }
          expect((await proxyRows()).length).toBe(0);
        } catch (error) { firstFailure ??= { error }; }
      }
    }
    if (firstFailure) throw firstFailure.error;
    await positivePrivileges();
  });

  it("starts the public metadata Store with the exact runtime account and performs real owner-scoped business writes", async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25_000); let opened: MysqlSessionStore | undefined;
    try {
      opened = await MysqlSessionStore.connect({ url: at(source, database, runtimeUser, password), migrationMode: "verify", schemaMetadata: config,
        connectionLimit: 1, operationAbortSignal: controller.signal });
      const session = mkSession(`schema_authority_${randomUUID()}`, "schema_authority_owner"), committed = await opened.createSession(session);
      expect(committed.lastSeq).toBe(1); expect(committed.events).toEqual([{ type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 }]);
      expect(await opened.getSession(session.tenantId, session.id)).toMatchObject({ id: session.id, lastSeq: 1 });
      expect(await opened.getSession("schema_authority_other_tenant", session.id)).toBeNull(); expect(await opened.readEvents(session.id, 0, 10)).toEqual(committed.events);
    } finally { try { await opened?.close(); } finally { clearTimeout(timer); } }
  });

  it("rejects an actual mandatory role and always restores the original empty GLOBAL setting on the same dedicated server", async () => {
    await sameServer(); expect(await externalConnections()).toEqual([]);
    const before = await rows(owner(), "SELECT @@GLOBAL.mandatory_roles AS value"); if (before.length !== 1 || before[0]?.value !== originalMandatory || originalMandatory !== "") fail();
    let unexpectedClient = false;
    try {
      // Set before awaiting: response loss is not proof that the GLOBAL statement did not run.
      globalDirty = true; await execute(owner(), "SET GLOBAL mandatory_roles=?", [acct(roleUser)]);
      const active = await rows(owner(), "SELECT @@GLOBAL.mandatory_roles AS value"); expect(active.length === 1 && typeof active[0]?.value === "string" && active[0]?.value !== "").toBe(true);
      await caller(runtimeUser, privilegesRejected);
      unexpectedClient = (await externalConnections()).length !== 0;
    } finally {
      // Restoration takes precedence over preserving this fixture's own temporary global change.
      // An unexpected external connection still makes the case fail, never suppresses rollback.
      try { unexpectedClient ||= (await externalConnections()).length !== 0; }
      finally { await restoreMandatory(); }
    }
    expect(unexpectedClient).toBe(false); expect(await rows(owner(), "SELECT @@GLOBAL.mandatory_roles AS value")).toEqual([{ value: "" }]);
    await positivePrivileges();
  });
});
