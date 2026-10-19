import { createHash, randomBytes } from "node:crypto";
import { createConnection as createSocket, isIP } from "node:net";
import mysql from "mysql2/promise";

const witnesses = new WeakMap();
const STOPPED_ACK = "all-application-writers-stopped-v1";
const IO_TIMEOUT_MS = 10_000;

export class MysqlRuntimeFixtureError extends Error {
  code = "mysql_runtime_fixture_invalid";
  constructor() { super("MySQL runtime fixture is not proven."); this.name = "MysqlRuntimeFixtureError"; }
}
function invalid() { throw new MysqlRuntimeFixtureError(); }
function active(signal) { if (!(signal instanceof AbortSignal) || signal.aborted) invalid(); }
function object(input, keys) {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function databaseName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)
    || !/(?:^|[_-])(?:test|cluster)(?:$|[_-])/i.test(value)) invalid();
  return value;
}
function operator(value) {
  if (typeof value !== "string" || value.length > 4096) invalid();
  let url; try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash) invalid();
  url.pathname = "/mysql"; return url.toString();
}
function at(url, database, user, password) {
  const result = new URL(url); result.pathname = `/${database}`;
  if (user !== undefined) { result.username = user; result.password = password; }
  return result.toString();
}
const identifier = value => mysql.escapeId(value);
const account = (user, host) => `${mysql.escape(user)}@${mysql.escape(host)}`;
function literalHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253 || /[\u0000-\u0020\u007f%_@\\/]/.test(value)) return false;
  return isIP(value) !== 0 || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(value);
}
function rowset(value) { if (!Array.isArray(value)) invalid(); return value; }
function one(value) { const rows = rowset(value); if (rows.length !== 1) invalid(); return rows[0]; }
function zero(value) { if (value !== 0 && value !== "0") invalid(); }
async function partialRevokes(query) {
  const value = one(await query("SELECT @@GLOBAL.partial_revokes AS partial_revokes")).partial_revokes;
  if (value === 0 || value === "0") return 0;
  if (value === 1 || value === "1") return 1;
  invalid();
}

/** Every connection and command is awaited; abort destroys the actual owned native sockets. */
async function native(url, signal, work) {
  active(signal);
  const sockets = new Set(), closes = new Set(); let connection, failed = false, result;
  const destroy = () => {
    try { connection?.destroy(); } catch { failed = true; }
    for (const socket of sockets) socket.destroy();
  };
  const stream = ({ config }) => {
    const socket = config.socketPath ? createSocket(config.socketPath) : createSocket({ host: config.host, port: config.port });
    sockets.add(socket);
    const closed = new Promise(resolve => { socket.once("close", resolve); }); closes.add(closed);
    void closed.then(() => { sockets.delete(socket); closes.delete(closed); });
    if (failed || signal.aborted) queueMicrotask(destroy);
    return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  let timer = setTimeout(() => { failed = true; destroy(); }, IO_TIMEOUT_MS);
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: IO_TIMEOUT_MS, stream });
    clearTimeout(timer); active(signal);
    const query = async (sql, values = []) => {
      active(signal); let expired = false;
      const queryTimer = setTimeout(() => { expired = true; destroy(); }, IO_TIMEOUT_MS);
      try {
        const [rows] = await connection.query({ sql, timeout: IO_TIMEOUT_MS }, values);
        if (expired) invalid(); active(signal); return rows;
      } finally { clearTimeout(queryTimer); }
    };
    result = await work(query); active(signal);
  } catch { failed = true; }
  finally {
    clearTimeout(timer);
    timer = setTimeout(() => { failed = true; destroy(); }, IO_TIMEOUT_MS);
    try { await connection?.end(); } catch { failed = true; }
    finally {
      // end() can finish before socket.close. Do not return or release ownership early.
      for (const socket of sockets) socket.destroy();
      while (closes.size) await Promise.all([...closes]);
      clearTimeout(timer); signal.removeEventListener("abort", destroy);
    }
  }
  if (failed || signal.aborted) invalid(); return result;
}
async function identity(query, expected) {
  const value = one(await query("SELECT @@server_uuid AS server_uuid,DATABASE() AS current_database,SUBSTRING_INDEX(USER(),'@',-1) AS client_host"));
  if (typeof value.server_uuid !== "string" || !/^[a-f0-9-]{36}$/i.test(value.server_uuid) || value.current_database !== "mysql"
    || !literalHost(value.client_host)) invalid();
  const result = { uuid: value.server_uuid.toLowerCase(), host: value.client_host };
  if (expected && (result.uuid !== expected.uuid || result.host !== expected.host)) invalid(); return result;
}
async function schema(query, name) {
  return rowset(await query("SELECT SCHEMA_NAME,DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [name]));
}
async function emptyApplication(query, name) {
  if ((await schema(query, name)).length !== 1) invalid();
  const counts = rowset(await query("SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ?) AS tables_count,(SELECT COUNT(*) FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?) AS routines_count,(SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA=BINARY ?) AS triggers_count,(SELECT COUNT(*) FROM information_schema.EVENTS WHERE BINARY EVENT_SCHEMA=BINARY ?) AS events_count", [name, name, name, name]));
  const value = one(counts);
  for (const key of ["tables_count", "routines_count", "triggers_count", "events_count"]) zero(value[key]);
}
function retained(state) {
  // Test-only opaque resource labels, never URLs, passwords, SQL or native error text.
  console.warn(JSON.stringify({ schema: "mysql-runtime-fixture-retained-v1", applicationDatabase: state.database,
    metadataSchema: state.metadataSchema, accounts: state.accounts ?? [], status: "retained_or_unknown" }));
}

/** Caller owns CREATE DATABASE. This original-object witness must precede that CREATE. */
export async function witnessAbsentMysqlFixtureDatabase(input) {
  try {
    const options = object(input, ["operatorUrl", "applicationDatabase", "operationAbortSignal"]);
    const url = operator(options.operatorUrl), database = databaseName(options.applicationDatabase), signal = options.operationAbortSignal;
    active(signal);
    const actual = await native(url, signal, async query => {
      const value = await identity(query); if ((await schema(query, database)).length !== 0) invalid(); return value;
    });
    const witness = Object.freeze({}); witnesses.set(witness, { url, database, signal, ...actual, phase: "absent" }); return witness;
  } catch { invalid(); }
}

/** No source/dist fallback: the caller must await the actual selected product schema executor. */
export async function prepareMysqlRuntimeFixture(witness, input) {
  let state;
  try {
    const options = object(input, ["schemaExecutor"]); state = witnesses.get(witness);
    if (!state || state.phase !== "absent" || typeof options.schemaExecutor !== "function") invalid();
    active(state.signal); state.phase = "preparing"; // Single use, including failed/partial preparations.
    await native(state.url, state.signal, async query => { await identity(query, state); await emptyApplication(query, state.database); });
    const execute = async (operation, schemaMetadata) => {
      active(state.signal);
      const result = await options.schemaExecutor(Object.freeze({ operation, url: at(state.url, state.database), operationAbortSignal: state.signal,
        ...(operation === "verify" ? {} : { fleetStoppedAck: STOPPED_ACK }), ...(schemaMetadata ? { schemaMetadata } : {}) }));
      if (result !== undefined) invalid(); active(state.signal);
    };
    await execute("migrate");
    const suffix = randomBytes(8).toString("hex");
    state.metadataSchema = `agent_service_test_runtime_meta_${suffix}`;
    const definer = `mrt_d_${suffix}`, runtime = `mrt_r_${suffix}`;
    state.accounts = [definer, runtime];
    const runtimePassword = randomBytes(32).toString("hex"), definerPassword = randomBytes(32).toString("hex");
    const config = Object.freeze({ metadataSchema: state.metadataSchema, trustedDefiner: Object.freeze({ user: definer, host: state.host }) });
    const routineName = createHash("sha256").update(state.database, "utf8").digest("hex");
    await native(state.url, state.signal, async query => {
      await identity(query, state);
      const tables = rowset(await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE BINARY TABLE_SCHEMA=BINARY ? AND TABLE_TYPE='BASE TABLE' ORDER BY BINARY TABLE_NAME", [state.database]));
      const names = tables.map(value => value.TABLE_NAME);
      if (!names.length || names.length > 16_384 || !names.includes("schema_migrations") || new Set(names).size !== names.length
        || names.some(name => typeof name !== "string" || name.length < 1 || name.length > 64 || name.includes("\0"))) invalid();
      if (rowset(await query(`SELECT name FROM ${identifier(state.database)}.schema_migrations`)).length === 0) invalid();
      if ((await schema(query, state.metadataSchema)).length !== 0) invalid();
      for (const user of state.accounts) if (rowset(await query("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, state.host])).length !== 0) invalid();
      // Any CREATE response loss is retained, never guessed absent and never automatically cleaned.
      await query(`CREATE DATABASE ${identifier(state.metadataSchema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      await query(`CREATE USER ${account(definer, state.host)} IDENTIFIED BY ? ACCOUNT LOCK`, [definerPassword]);
      await query(`CREATE USER ${account(runtime, state.host)} IDENTIFIED BY ?`, [runtimePassword]);
      // The locked readonly definer must also see future/unknown triggers. With
      // partial_revokes=0, database grants use patterns even inside backticks.
      const grantMode = await partialRevokes(query);
      const definerSchema = grantMode === 0 ? state.database.replace(/[%_]/g, "\\$&") : state.database;
      await query(`GRANT TRIGGER ON ${identifier(definerSchema)}.* TO ${account(definer, state.host)}`);
      if (await partialRevokes(query) !== grantMode) invalid();
      for (const name of names) {
        const target = `${identifier(state.database)}.${identifier(name)}`;
        await query(`GRANT ${name === "schema_migrations" ? "SELECT" : "SELECT,INSERT,UPDATE,DELETE"} ON ${target} TO ${account(runtime, state.host)}`);
      }
      await query(`GRANT SHOW_ROUTINE ON *.* TO ${account(runtime, state.host)}`);
    });
    await execute("install-metadata", config);
    await native(state.url, state.signal, async query => {
      await identity(query, state);
      const installed = rowset(await query("SELECT ROUTINE_NAME,DEFINER,SECURITY_TYPE,ROUTINE_TYPE FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?", [state.metadataSchema]));
      const routine = one(installed);
      if (routine.ROUTINE_NAME !== routineName || routine.DEFINER !== `${definer}@${state.host}` || routine.SECURITY_TYPE !== "DEFINER" || routine.ROUTINE_TYPE !== "PROCEDURE") invalid();
      for (const user of state.accounts) await query(`GRANT EXECUTE ON PROCEDURE ${identifier(state.metadataSchema)}.${identifier(routineName)} TO ${account(user, state.host)}`);
    });
    await execute("verify");
    state.phase = "live";
    const runtimeUrl = at(state.url, state.database, runtime, runtimePassword);
    const runtimeEnv = Object.freeze({ MYSQL_URL: runtimeUrl, MYSQL_SCHEMA_METADATA_SCHEMA: state.metadataSchema,
      MYSQL_SCHEMA_METADATA_DEFINER_USER: definer, MYSQL_SCHEMA_METADATA_DEFINER_HOST: state.host });
    const runtimeStoreOptions = Object.freeze({ url: runtimeUrl, migrationMode: "verify", schemaMetadata: config });
    const assertResources = async (url, query) => {
      await identity(query, state);
      if ((await schema(query, state.database)).length !== 1) invalid();
      const metadata = one(await schema(query, state.metadataSchema));
      if (metadata.DEFAULT_CHARACTER_SET_NAME !== "utf8mb4" || metadata.DEFAULT_COLLATION_NAME !== "utf8mb4_0900_ai_ci") invalid();
      const routines = rowset(await query("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE BINARY ROUTINE_SCHEMA=BINARY ?", [state.metadataSchema]));
      if (routines.length !== 1 || routines[0].ROUTINE_NAME !== routineName) invalid();
      for (const user of state.accounts) {
        const value = one(await query("SELECT User,Host,account_locked FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, state.host]));
        if (value.User !== user || value.Host !== state.host || value.account_locked !== (user === definer ? "Y" : "N")) invalid();
      }
    };
    const pending = new Set(); let closing;
    const handle = Object.freeze({ runtimeEnv, runtimeStoreOptions, database: state.database, serverUuid: state.uuid,
      assertReusable(operatorUrl) {
        try {
          if (state.phase !== "live" || decodeURIComponent(new URL(operatorUrl).pathname.slice(1)) !== state.database) invalid();
          const url = operator(operatorUrl), task = native(url, state.signal, query => assertResources(url, query)).catch(() => invalid());
          pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task;
        }
        catch { return Promise.reject(new MysqlRuntimeFixtureError()); }
      },
      close(input) {
        if (closing) return closing;
        closing = (async () => {
          try {
            const { successful } = object(input, ["successful"]); if (typeof successful !== "boolean" || state.phase !== "live") invalid();
            state.phase = "closing";
            const drained = await Promise.allSettled([...pending]);
            if (!successful) { state.phase = "retained"; retained(state); return; }
            if (drained.some(result => result.status !== "fulfilled")) invalid();
            await native(state.url, state.signal, async query => {
              await assertResources(state.url, query);
              for (const name of [state.database, state.metadataSchema]) {
                for (const [sql, values] of [
                  ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [name]],
                  ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [name]],
                  ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [name, name]],
                ]) zero(one(await query(sql, values)).n);
              }
              for (const user of state.accounts) zero(one(await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [user])).n);
              // Caller must have stopped and awaited every consumer. A zero-ref snapshot is not
              // a promise that an unclosed process cannot reconnect after this check.
              await identity(query, state);
              await query(`DROP DATABASE ${identifier(state.metadataSchema)}`);
              if ((await schema(query, state.metadataSchema)).length !== 0) invalid();
              for (const user of state.accounts) {
                await query(`DROP USER ${account(user, state.host)}`);
                if (rowset(await query("SELECT User FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ?", [user, state.host])).length !== 0) invalid();
              }
            });
            state.phase = "closed";
          } catch { state.phase = "retained"; retained(state); invalid(); }
        })();
        return closing;
      },
    });
    return handle;
  } catch { if (state?.phase === "preparing") { state.phase = "retained"; retained(state); } invalid(); }
}
