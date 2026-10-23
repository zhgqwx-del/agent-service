// CI-only preparation inside the selected runner image. This is not a product entrypoint.
// APP, metadata and accounts intentionally survive handoff; disposable job teardown owns them.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createConnection as createSocket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "./mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "./mysql-schema-cli.mjs";
import { createMysqlAuthorityCliExecutor } from "./mysql-authority-cli.mjs";

const LOCATOR = "mysql://root@127.0.0.1:3306/agent_service_test_image_base";
const DIRECTORY = "/fixture";
const DEADLINE_MS = 120_000;
const IO_TIMEOUT_MS = 10_000;
const FILES = ["runtime.env", "database.txt", "ready.json"];
const ENV_KEYS = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CiImageRuntimeError extends Error {
  code = "ci_image_runtime_failed";
  constructor() { super("CI image runtime preparation failed."); this.name = "CiImageRuntimeError"; }
}
function invalid() { throw new CiImageRuntimeError(); }
function active(signal) { if (!(signal instanceof AbortSignal) || signal.aborted) invalid(); }
function value(env, key) {
  const descriptor = Object.getOwnPropertyDescriptor(env, key);
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") invalid();
  return descriptor.value;
}
function configuration(argv, env, nodeMajor) {
  if (!Array.isArray(argv) || argv.length !== 0 || !env || typeof env !== "object" || nodeMajor !== 24) invalid();
  for (const key of Reflect.ownKeys(env)) {
    if (typeof key !== "string" || key === "MYSQL" || key.startsWith("MYSQL_") || key.startsWith("SCHEMA_")
      || key === "AGENT_SERVICE_MIGRATIONS_DIR" || key === "NODE_OPTIONS") invalid();
  }
  const url = value(env, "CI_IMAGE_MYSQL_URL"), uuid = value(env, "CI_IMAGE_MYSQL_SERVER_UUID"), directory = value(env, "CI_IMAGE_RUNTIME_DIRECTORY");
  if (value(env, "GITHUB_ACTIONS") !== "true" || url !== LOCATOR || !UUID.test(uuid) || directory !== DIRECTORY) invalid();
  return { url, uuid, directory };
}

async function inspectDirectory(directory) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700
    || typeof process.getuid === "function" && before.uid !== process.getuid() || await realpath(directory) !== directory) invalid();
  if ((await readdir(directory)).length !== 0) invalid();
}
async function writePrivateFile(directory, name, contents, signal) {
  active(signal);
  if (!FILES.includes(name)) invalid();
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700
    || typeof process.getuid === "function" && parent.uid !== process.getuid() || await realpath(directory) !== directory) invalid();
  const handle = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
      || typeof process.getuid === "function" && stat.uid !== process.getuid()) invalid();
    active(signal); await handle.writeFile(contents, "utf8"); await handle.sync(); active(signal);
  } finally { await handle.close(); }
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Every resolution/rejection joins native close, including cancellation during handshake. */
async function openAdmin(url, signal) {
  active(signal);
  const sockets = new Set(), closes = new Set();
  let connection, closing, closed = false, driverFailed = false;
  const destroy = () => { try { connection?.destroy(); } catch { /* Actual sockets are also owned below. */ } for (const socket of sockets) socket.destroy(); };
  const nativeError = () => { driverFailed = true; destroy(); };
  const stream = ({ config }) => {
    const socket = createSocket({ host: config.host, port: config.port }); sockets.add(socket);
    const done = new Promise(resolve => socket.once("close", resolve)); closes.add(done);
    void done.then(() => { sockets.delete(socket); closes.delete(done); });
    if (closed || signal.aborted) queueMicrotask(destroy);
    return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  const close = () => closing ??= (async () => {
    closed = true;
    const timer = setTimeout(nativeError, IO_TIMEOUT_MS);
    try { await connection?.end(); }
    finally {
      destroy(); while (closes.size) await Promise.all([...closes]);
      clearTimeout(timer); signal.removeEventListener("abort", destroy); connection?.removeListener("error", nativeError);
    }
    if (driverFailed) invalid();
  })();
  const connectTimer = setTimeout(nativeError, IO_TIMEOUT_MS);
  try {
    const adminUrl = new URL(url); adminUrl.pathname = "/mysql";
    connection = await mysql.createConnection({ uri: adminUrl.toString(), stream, connectTimeout: IO_TIMEOUT_MS, multipleStatements: false });
    connection.on("error", nativeError);
    active(signal); if (driverFailed) invalid();
  } catch { await close(); invalid(); }
  finally { clearTimeout(connectTimer); }
  const query = async sql => {
    active(signal); if (closed || driverFailed) invalid();
    const timer = setTimeout(nativeError, IO_TIMEOUT_MS);
    try { const [rows] = await connection.query({ sql, timeout: IO_TIMEOUT_MS }); active(signal); return rows; }
    finally { clearTimeout(timer); }
  };
  return {
    async serverUuid() {
      const rows = await query("SELECT @@server_uuid AS server_uuid,DATABASE() AS current_database");
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].current_database !== "mysql" || !UUID.test(rows[0].server_uuid)) invalid();
      return rows[0].server_uuid;
    },
    async createDatabase(database) {
      if (!/^agent_service_test_image_[0-9a-f]{16}$/.test(database)) invalid();
      await query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    },
    close,
  };
}

export const CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES = Object.freeze({
  nodeMajor: Number(process.versions.node.split(".")[0]),
  inspectDirectory, openAdmin, witness: witnessAbsentMysqlFixtureDatabase,
  prepare: prepareMysqlRuntimeFixture, createSchemaExecutor: createMysqlSchemaCliExecutor,
  createAuthorityExecutor: createMysqlAuthorityCliExecutor,
  nonce: () => randomBytes(8).toString("hex"), writePrivateFile, syncDirectory,
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: timer => clearTimeout(timer),
  installInterrupts: interrupt => {
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    return () => { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); };
  },
  writeLine: line => process.stdout.write(`${line}\n`),
  writeError: line => process.stderr.write(`${line}\n`),
});

function runtimeEnvironment(input, database) {
  if (!input || typeof input !== "object" || Reflect.ownKeys(input).length !== ENV_KEYS.length) invalid();
  const captured = Object.create(null);
  for (const key of ENV_KEYS) {
    const item = value(input, key);
    if (!item || item.includes("\n") || item.includes("\r") || item.includes("\0")) invalid();
    captured[key] = item;
  }
  const url = new URL(captured.MYSQL_URL);
  if (url.protocol !== "mysql:" || url.hostname !== "127.0.0.1" || url.port !== "3306" || url.pathname !== `/${database}`
    || !/^mrt_r_[0-9a-f]{16}$/.test(url.username) || !/^[0-9a-f]{64}$/.test(url.password) || url.search || url.hash
    || captured.MYSQL_URL !== url.toString()
    || !/^agent_service_test_runtime_meta_[0-9a-f]{16}$/.test(captured.MYSQL_SCHEMA_METADATA_SCHEMA)
    || !/^mrt_d_[0-9a-f]{16}$/.test(captured.MYSQL_SCHEMA_METADATA_DEFINER_USER)
    || !/^[a-zA-Z0-9.:\-]{1,253}$/.test(captured.MYSQL_SCHEMA_METADATA_DEFINER_HOST)) invalid();
  return ENV_KEYS.map(key => `${key}=${captured[key]}\n`).join("");
}

/** DI exercises ordering only; fake dependencies are not image, MySQL or permission evidence. */
export async function prepareCiImageRuntime(argv, env, dependencies = CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES) {
  let admin, timer, removeInterrupts;
  try {
    const config = configuration(argv, env, dependencies.nodeMajor);
    const controller = new AbortController();
    timer = dependencies.setTimer(() => controller.abort(), DEADLINE_MS);
    removeInterrupts = dependencies.installInterrupts(() => controller.abort());
    await dependencies.inspectDirectory(config.directory); active(controller.signal);
    const nonce = dependencies.nonce(); if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) invalid();
    const database = `agent_service_test_image_${nonce}`, operatorUrl = new URL(config.url); operatorUrl.pathname = `/${database}`;
    admin = await dependencies.openAdmin(config.url, controller.signal);
    if (await admin.serverUuid() !== config.uuid) invalid(); active(controller.signal);
    const witness = await dependencies.witness({ operatorUrl: operatorUrl.toString(), applicationDatabase: database, operationAbortSignal: controller.signal });
    active(controller.signal); await admin.createDatabase(database); active(controller.signal);
    const schemaExecutor = dependencies.createSchemaExecutor({ entrypoint: "/app/dist/main.js", mode: "dist", cwd: "/app" });
    const authorityExecutor = dependencies.createAuthorityExecutor({ entrypoint: "/app/dist/main.js", mode: "dist", cwd: "/app" });
    const handle = await dependencies.prepare(witness, { schemaExecutor, authorityExecutor }); active(controller.signal);
    if (handle.database !== database || handle.serverUuid !== config.uuid) invalid();
    await handle.assertReusable(operatorUrl.toString()); active(controller.signal);
    const envFile = runtimeEnvironment(handle.runtimeEnv, database);
    await admin.close(); admin = undefined; active(controller.signal);
    const ready = Object.freeze({ schema: "ci-image-mysql-runtime-v1", status: "ready", database, serverUuid: config.uuid,
      nativeConnectionsClosed: true, runtimeEnvFile: "runtime.env", runtimeEnvKeys: [...ENV_KEYS],
      resourceCleanup: "ephemeral-job-service-teardown-only", perResourceCleanupClaimed: false });
    await dependencies.writePrivateFile(config.directory, "runtime.env", envFile, controller.signal);
    await dependencies.writePrivateFile(config.directory, "database.txt", `${database}\n`, controller.signal);
    await dependencies.writePrivateFile(config.directory, "ready.json", `${JSON.stringify(ready)}\n`, controller.signal);
    await dependencies.syncDirectory(config.directory); active(controller.signal);
    // Deliberately do not call handle.close(): the next image container needs these grants.
    return ready;
  } catch { invalid(); }
  finally {
    try { await admin?.close(); }
    catch { invalid(); }
    finally {
      try { if (timer !== undefined) dependencies.clearTimer(timer); removeInterrupts?.(); }
      catch { invalid(); }
    }
  }
}

export async function runCiImageRuntime(argv = process.argv.slice(2), env = process.env, dependencies = CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES) {
  try {
    await prepareCiImageRuntime(argv, env, dependencies);
    dependencies.writeLine('{"status":"ok","command":"ci-image-runtime"}'); return 0;
  } catch {
    // Existing fixture retained notes are content-free; no native error/cause is serialized here.
    try { dependencies.writeError('{"status":"error","code":"ci_image_runtime_failed"}'); } catch { /* Output is not authority. */ }
    return 1;
  }
}
async function isDirectEntrypoint() {
  try { return typeof process.argv[1] === "string" && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (await isDirectEntrypoint()) process.exitCode = await runCiImageRuntime();
