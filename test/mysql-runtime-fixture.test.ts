import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MysqlRuntimeFixtureError, prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase,
  type MysqlFixtureSchemaOperation } from "./fixtures/mysql-runtime.mjs";

// Driver/native-socket doubles only. These tests neither execute schema code nor prove real SQL.
const state = vi.hoisted(() => ({ schemas: new Map<string, boolean>(), users: new Map<string, { host: string; locked: string }>(),
  queries: [] as { sql: string; values: unknown[] }[], sockets: [] as import("node:net").Socket[], uuid: "12345678-1234-1234-1234-123456789abc", host: "localhost",
  appObjects: false, migrated: false, installed: false, config: undefined as MysqlFixtureSchemaOperation["schemaMetadata"], refs: 0,
  partialRevokes: 0, driftGrantMode: false,
  createResponseLoss: false, blockQuery: undefined as undefined | { text: string; entered(): void; pending: Promise<unknown> },
  blockClose: undefined as undefined | { entered(): void; pending: Promise<void> } }));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, createConnection: vi.fn(() => { const socket = new actual.Socket(); state.sockets.push(socket); return socket; }) };
});
vi.mock("mysql2/promise", () => ({ default: {
  escapeId: (value: string) => `\`${value.replaceAll("`", "``")}\``,
  escape: (value: string) => `'${value.replaceAll("'", "''")}'`,
  createConnection: vi.fn(async (options: { uri: string; stream(options: unknown): import("node:net").Socket }) => {
    const url = new globalThis.URL(options.uri), socket = options.stream({ config: { host: url.hostname, port: Number(url.port || 3306) } });
    return {
      async query(input: string | { sql: string }, values: unknown[] = []) {
        const sql = typeof input === "string" ? input : input.sql; state.queries.push({ sql, values });
        if (state.blockQuery && sql.includes(state.blockQuery.text)) { state.blockQuery.entered(); return [await state.blockQuery.pending, []]; }
        if (sql.startsWith("SELECT @@server_uuid")) return [[{ server_uuid: state.uuid, current_database: "mysql", client_host: state.host }], []];
        if (sql === "SELECT @@GLOBAL.partial_revokes AS partial_revokes") return [[{ partial_revokes: state.partialRevokes }], []];
        if (sql.includes("FROM information_schema.SCHEMATA")) return [state.schemas.has(String(values[0]))
          ? [{ SCHEMA_NAME: values[0], DEFAULT_CHARACTER_SET_NAME: "utf8mb4", DEFAULT_COLLATION_NAME: "utf8mb4_0900_ai_ci" }] : [], []];
        if (sql.includes("AS tables_count")) return [[{ tables_count: state.appObjects ? 1 : 0, routines_count: 0, triggers_count: 0, events_count: 0 }], []];
        if (sql.startsWith("SELECT TABLE_NAME")) return [(state.migrated ? ["schema_migrations", "sessions"] : []).map(TABLE_NAME => ({ TABLE_NAME })), []];
        if (sql.startsWith("SELECT name FROM")) return [state.migrated ? [{ name: "0065_mcp_dcr.sql" }] : [], []];
        if (sql.includes("FROM mysql.user")) {
          const user = String(values[0]), value = state.users.get(user);
          return [value ? [{ User: user, Host: value.host, account_locked: value.locked }] : [], []];
        }
        if (sql.includes("FROM information_schema.ROUTINES")) {
          const config = state.config;
          return [state.installed && config ? [{ ROUTINE_NAME: createHash("sha256").update(APP).digest("hex"),
            DEFINER: `${config.trustedDefiner.user}@${config.trustedDefiner.host}`, SECURITY_TYPE: "DEFINER", ROUTINE_TYPE: "PROCEDURE" }] : [], []];
        }
        if (sql.startsWith("CREATE DATABASE ")) {
          const name = /^CREATE DATABASE `([^`]+)`/.exec(sql)?.[1]; if (!name) throw Error(CANARY);
          state.schemas.set(name, true); if (state.createResponseLoss) throw Error(CANARY); return [{}, []];
        }
        if (sql.startsWith("CREATE USER ")) {
          const account = /^CREATE USER '([^']+)'@'([^']+)'/.exec(sql); if (!account) throw Error(CANARY);
          state.users.set(account[1]!, { host: account[2]!, locked: sql.includes("ACCOUNT LOCK") ? "Y" : "N" }); return [{}, []];
        }
        if (sql.startsWith("GRANT ")) { if (state.driftGrantMode && sql.startsWith("GRANT TRIGGER ")) state.partialRevokes = 1 - state.partialRevokes; return [{}, []]; }
        if (sql.startsWith("SELECT COUNT(*) AS n")) return [[{ n: state.refs }], []];
        if (sql.startsWith("DROP DATABASE ")) {
          const name = /^DROP DATABASE `([^`]+)`/.exec(sql)?.[1]; if (!name) throw Error(CANARY); state.schemas.delete(name); return [{}, []];
        }
        if (sql.startsWith("DROP USER ")) {
          const user = /^DROP USER '([^']+)'/.exec(sql)?.[1]; if (!user) throw Error(CANARY); state.users.delete(user); return [{}, []];
        }
        throw Error(CANARY);
      },
      destroy() { socket.destroy(); },
      async end() { if (state.blockClose) { state.blockClose.entered(); await state.blockClose.pending; } socket.destroy(); },
    };
  }),
} }));

const APP = "agent_service_runtime_test_fixture", CANARY = "private-operator-password-canary";
const URL = `mysql://root:${CANARY}@127.0.0.1:3306/${APP}`;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function witness(signal = new AbortController().signal) {
  return witnessAbsentMysqlFixtureDatabase({ operatorUrl: URL, applicationDatabase: APP, operationAbortSignal: signal });
}
function executor(operations: string[] = []) {
  return vi.fn(async (operation: MysqlFixtureSchemaOperation) => {
    operations.push(operation.operation);
    if (operation.operation === "migrate") { state.migrated = true; state.appObjects = true; }
    if (operation.operation === "install-metadata") { state.config = operation.schemaMetadata; state.installed = true; }
  });
}
async function prepared() {
  const original = await witness(); state.schemas.set(APP, true);
  return prepareMysqlRuntimeFixture(original, { schemaExecutor: executor() });
}
beforeEach(() => {
  state.schemas.clear(); state.users.clear(); state.queries.length = 0; state.sockets.length = 0;
  Object.assign(state, { uuid: "12345678-1234-1234-1234-123456789abc", host: "localhost", appObjects: false, migrated: false, installed: false,
    config: undefined, refs: 0, createResponseLoss: false, blockQuery: undefined, blockClose: undefined });
  state.partialRevokes = 0; state.driftGrantMode = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { for (const socket of state.sockets) socket.destroy(); vi.restoreAllMocks(); });

describe("test-only MySQL runtime fixture (driver doubles, no real schema proof)", () => {
  it.each([
    { operatorUrl: "mysql://root@remote.invalid/owned_test", applicationDatabase: APP },
    { operatorUrl: URL, applicationDatabase: "business" },
    { operatorUrl: `${URL}?multipleStatements=true`, applicationDatabase: APP },
    { operatorUrl: URL, applicationDatabase: "agent_test/other" },
  ])("rejects unsafe targets before opening a socket", async input => {
    await expect(witnessAbsentMysqlFixtureDatabase({ ...input, operationAbortSignal: new AbortController().signal })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.sockets.length).toBe(0); expect(state.queries.length).toBe(0);
  });

  it("requires a real live AbortSignal and does not evaluate configuration getters", async () => {
    const getter = vi.fn(() => URL), input = { operatorUrl: URL, applicationDatabase: APP, operationAbortSignal: new AbortController().signal };
    Object.defineProperty(input, "operatorUrl", { get: getter, enumerable: true });
    await expect(witnessAbsentMysqlFixtureDatabase(input)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError); expect(getter).not.toHaveBeenCalled();
    const aborted = new AbortController(); aborted.abort(); await expect(witness(aborted.signal)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    await expect(witnessAbsentMysqlFixtureDatabase({ operatorUrl: URL, applicationDatabase: APP, operationAbortSignal: {} as AbortSignal })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.sockets.length).toBe(0);
  });

  it("witnesses only absence and performs no CREATE or migration", async () => {
    const original = await witness(); expect(Object.isFrozen(original)).toBe(true);
    expect(state.queries.some(query => /^(?:CREATE|GRANT|DROP|ALTER)\b/.test(query.sql))).toBe(false);
    expect(state.sockets.every(socket => socket.closed)).toBe(true);
    state.schemas.set(APP, true); await expect(witness()).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
  });

  it("allows the closed cluster name token without inheriting destructive or remote-target authority", async () => {
    expect(await witnessAbsentMysqlFixtureDatabase({ operatorUrl: URL, applicationDatabase: "agent_service_cluster", operationAbortSignal: new AbortController().signal })).toBeDefined();
    await expect(witnessAbsentMysqlFixtureDatabase({ operatorUrl: URL, applicationDatabase: APP, operationAbortSignal: new AbortController().signal,
      allowDestructive: true } as never)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.queries.some(query => /^(?:CREATE|GRANT|DROP|ALTER)\b/.test(query.sql))).toBe(false);
  });

  it.each(["172.18.0.2", "mysql-client.example.test", "::ffff:172.18.0.2"])("pins the exact native bridge/DNS host %s without widening the loopback operator URL", async host => {
    state.host = host; const original = await witness(); state.schemas.set(APP, true);
    const handle = await prepareMysqlRuntimeFixture(original, { schemaExecutor: executor() });
    expect(handle.runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_HOST).toBe(host); await handle.close({ successful: false });
  });

  it.each(["", "%", "172.18.%", "client_name", "client@host", "client\\host", "client\nhost", "x".repeat(256)])("rejects nonliteral or truncated native host %j", async host => {
    state.host = host; await expect(witness()).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.queries.some(query => /^(?:CREATE|GRANT|DROP|ALTER)\b/.test(query.sql))).toBe(false);
  });

  it("rejects forged witnesses and requires an explicit schema executor", async () => {
    await expect(prepareMysqlRuntimeFixture({} as never, { schemaExecutor: executor() })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    const original = await witness(); state.schemas.set(APP, true);
    await expect(prepareMysqlRuntimeFixture(original, {} as never)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.queries.some(query => /^(?:CREATE|GRANT|DROP|ALTER)\b/.test(query.sql))).toBe(false);
  });

  it.each(["missing", "nonempty", "wrong-server"] as const)("rejects %s after caller CREATE without schema work or cleanup", async kind => {
    const original = await witness(), run = executor(); if (kind !== "missing") state.schemas.set(APP, true);
    if (kind === "nonempty") state.appObjects = true; if (kind === "wrong-server") state.uuid = "87654321-4321-4321-4321-cba987654321";
    await expect(prepareMysqlRuntimeFixture(original, { schemaExecutor: run })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(run).not.toHaveBeenCalled(); expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false);
    await expect(prepareMysqlRuntimeFixture(original, { schemaExecutor: run })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
  });

  it("runs only the supplied migrate/install/verify executor and returns no operator authority", async () => {
    const original = await witness(), operations: string[] = [], run = executor(operations); state.schemas.set(APP, true);
    const handle = await prepareMysqlRuntimeFixture(original, { schemaExecutor: run });
    expect(operations).toEqual(["migrate", "install-metadata", "verify"]);
    expect(run.mock.calls.every(([value]) => value.operationAbortSignal instanceof AbortSignal && Object.isFrozen(value))).toBe(true);
    expect(run.mock.calls[0]?.[0].fleetStoppedAck).toBe("all-application-writers-stopped-v1"); expect(run.mock.calls[2]?.[0].fleetStoppedAck).toBeUndefined();
    expect(Object.keys(handle.runtimeEnv).sort()).toEqual(["MYSQL_SCHEMA_METADATA_DEFINER_HOST", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_URL"]);
    expect(new globalThis.URL(handle.runtimeEnv.MYSQL_URL).password === CANARY).toBe(false);
    expect(handle.runtimeStoreOptions.migrationMode).toBe("verify"); expect(handle.runtimeStoreOptions.url === handle.runtimeEnv.MYSQL_URL).toBe(true);
    const runtime = new globalThis.URL(handle.runtimeEnv.MYSQL_URL).username;
    expect(state.queries.some(query => /^GRANT .* ON `[^`]+`\.\*/.test(query.sql) && query.sql.endsWith(`TO '${runtime}'@'${state.host}'`))).toBe(false);
    expect(state.queries.some(query => /^GRANT TRIGGER ON \*\.\*/.test(query.sql))).toBe(false);
    await handle.close({ successful: false });
  });

  it.each([0, 1])("grants the locked definer the exact app schema for current and unknown triggers with partial_revokes=%i", async mode => {
    state.partialRevokes = mode; const handle = await prepared();
    const schema = mode === 0 ? APP.replace(/[%_]/g, "\\$&") : APP;
    const definer = handle.runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_USER;
    expect(state.queries.filter(query => query.sql.startsWith("GRANT TRIGGER ")).map(query => query.sql))
      .toEqual([`GRANT TRIGGER ON \`${schema}\`.* TO '${definer}'@'${state.host}'`]);
    expect(state.queries.filter(query => query.sql === "SELECT @@GLOBAL.partial_revokes AS partial_revokes")).toHaveLength(2);
    await handle.close({ successful: false });
  });

  it.each([0, 1])("rejects partial_revokes drift from %i immediately after the schema grant without install or cleanup", async mode => {
    state.partialRevokes = mode; state.driftGrantMode = true;
    const original = await witness(), operations: string[] = []; state.schemas.set(APP, true);
    await expect(prepareMysqlRuntimeFixture(original, { schemaExecutor: executor(operations) })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(operations).toEqual(["migrate"]); expect(state.users.size).toBe(2);
    expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false);
    expect(state.queries.some(query => /^GRANT (?:SELECT|SHOW_ROUTINE|EXECUTE)\b/.test(query.sql))).toBe(false);
  });

  it("consumes the witness before awaiting the executor and never repeats preparation", async () => {
    const original = await witness(), entered = deferred<void>(), released = deferred<void>(), normal = executor(); state.schemas.set(APP, true);
    const run = async (operation: MysqlFixtureSchemaOperation) => { if (operation.operation === "migrate") { entered.resolve(); await released.promise; } await normal(operation); };
    const pending = prepareMysqlRuntimeFixture(original, { schemaExecutor: run }); void pending.catch(() => {}); await entered.promise;
    try { await expect(prepareMysqlRuntimeFixture(original, { schemaExecutor: run })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError); }
    finally { released.resolve(); const handle = await pending; await handle.close({ successful: false }); }
    expect(normal.mock.calls.map(([operation]) => operation.operation)).toEqual(["migrate", "install-metadata", "verify"]);
  });

  it("assertReusable is read-only, never repairs missing metadata, and rejects closed handles", async () => {
    const handle = await prepared(); const begin = state.queries.length; await handle.assertReusable(URL);
    expect(state.queries.slice(begin).every(query => query.sql.startsWith("SELECT "))).toBe(true);
    const wrongDatabase = new globalThis.URL(URL); wrongDatabase.pathname = "/different_test_database";
    await expect(handle.assertReusable(wrongDatabase.toString())).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    state.installed = false; await expect(handle.assertReusable(URL)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.queries.slice(begin).every(query => query.sql.startsWith("SELECT "))).toBe(true);
    await handle.close({ successful: false }); const count = state.queries.length;
    await expect(handle.assertReusable(URL)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError); expect(state.queries.length).toBe(count);
  });

  it("failure close retains resources and cannot later become successful cleanup", async () => {
    const handle = await prepared(), count = state.schemas.size; await handle.close({ successful: false }); await handle.close({ successful: true });
    expect(state.schemas.size).toBe(count); expect(state.users.size).toBe(2); expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false);
  });

  it("failure close fences new reuse and drains an already admitted native read without pretending it settled", async () => {
    const handle = await prepared(), entered = deferred<void>(), released = deferred<unknown>();
    state.blockQuery = { text: "SELECT ROUTINE_NAME FROM", entered: () => entered.resolve(), pending: released.promise };
    const reading = handle.assertReusable(URL); void reading.catch(() => {}); await entered.promise;
    let closed = false; const closing = handle.close({ successful: false }).then(() => { closed = true; });
    try { await Promise.resolve(); expect(closed).toBe(false); await expect(handle.assertReusable(URL)).rejects.toBeInstanceOf(MysqlRuntimeFixtureError); }
    finally { released.resolve([{ ROUTINE_NAME: createHash("sha256").update(APP).digest("hex") }]); await reading; await closing; }
    expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false); expect(state.sockets.every(socket => socket.closed)).toBe(true);
  });

  it("successful close removes only its metadata/accounts after zero refs, never the caller app database", async () => {
    const handle = await prepared(); await handle.close({ successful: true });
    expect(state.schemas.has(APP)).toBe(true); expect(state.schemas.size).toBe(1); expect(state.users.size).toBe(0);
    expect(state.queries.filter(query => /^DROP DATABASE\b/.test(query.sql))).toHaveLength(1);
    expect(state.queries.some(query => query.sql === `DROP DATABASE \`${APP}\``)).toBe(false);
    expect(state.sockets.every(socket => socket.closed)).toBe(true);
  });

  it.each(["live-consumer", "wrong-server"] as const)("%s prevents every destructive cleanup statement", async kind => {
    const handle = await prepared();
    if (kind === "live-consumer") state.refs = 1; else state.uuid = "87654321-4321-4321-4321-cba987654321";
    await expect(handle.close({ successful: true })).rejects.toBeInstanceOf(MysqlRuntimeFixtureError);
    expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false); expect(state.users.size).toBe(2);
  });

  it("retains uncertain CREATE outcomes and redacts all native diagnostics without retries or DROP", async () => {
    const original = await witness(); state.schemas.set(APP, true); state.createResponseLoss = true;
    const failure: unknown = await prepareMysqlRuntimeFixture(original, { schemaExecutor: executor() }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MysqlRuntimeFixtureError); expect(String(failure).includes(CANARY)).toBe(false);
    expect(state.schemas.size).toBe(2); expect(state.queries.some(query => /^DROP\b/.test(query.sql))).toBe(false);
    expect(vi.mocked(console.warn).mock.calls.every(call => !String(call[0]).includes(CANARY))).toBe(true);
  });

  it("abort hard-closes the owned socket but waits for the original pending query to settle", async () => {
    const entered = deferred<void>(), released = deferred<unknown>(), controller = new AbortController();
    state.blockQuery = { text: "SELECT @@server_uuid", entered: () => entered.resolve(), pending: released.promise };
    let settled = false; const pending = witness(controller.signal).then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    let outcome: unknown;
    try { await entered.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false); expect(state.sockets.every(socket => socket.destroyed)).toBe(true); }
    finally { released.reject(Error(CANARY)); outcome = await pending; }
    expect(outcome).toBeInstanceOf(MysqlRuntimeFixtureError); expect(state.sockets.every(socket => socket.closed)).toBe(true);
  });

  it("does not return a witness before the actual original connection end and socket close settle", async () => {
    const entered = deferred<void>(), released = deferred<void>(); state.blockClose = { entered: () => entered.resolve(), pending: released.promise };
    let settled = false; const pending = witness().then(value => { settled = true; return value; }); void pending.catch(() => {});
    try { await entered.promise; expect(settled).toBe(false); } finally { released.resolve(); await pending; }
    expect(state.sockets.every(socket => socket.closed)).toBe(true);
  });
});
