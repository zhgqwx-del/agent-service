import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import net from "node:net";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ACK = "dedicated-disposable-server-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NATIVE_SQL = `SELECT @@server_uuid AS server_uuid, @@GLOBAL.mandatory_roles AS mandatory_roles,
(SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND COMMAND<>'Daemon') AS external_clients`;

export class CiMysqlAuthorityError extends Error {
  constructor() { super("Dedicated MySQL test authority could not be established."); this.name = "CiMysqlAuthorityError"; this.code = "mysql_test_authority_unproven"; }
}
function invalid() { throw new CiMysqlAuthorityError(); }
function field(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return descriptor.value;
}
function closed(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== names.length) invalid();
  return Object.fromEntries(names.map(name => [name, field(value, name)]));
}
function input(argv, env) {
  if (!Array.isArray(argv) || argv.length !== 0 || !env || typeof env !== "object") invalid();
  if (Object.hasOwn(env, "MYSQL_TEST_AUTHORITY_ACK") || Object.hasOwn(env, "MYSQL_TEST_OWNED_SERVER_UUID")) invalid();
  if (field(env, "GITHUB_ACTIONS") !== "true") invalid();
  const id = field(env, "MYSQL_TEST_SERVICE_CONTAINER_ID"), url = field(env, "MYSQL_TEST_URL"), file = field(env, "GITHUB_ENV");
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id) || typeof file !== "string" || !isAbsolute(file)
    || resolve(file) !== file || /[\u0000-\u001f\u007f]/.test(file) || typeof url !== "string"
    || !/^mysql:\/\/root@(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/agent_service_test(?:_[a-z0-9_]+)?$/.test(url)) invalid();
  const parsed = new URL(url), port = Number(parsed.port), database = parsed.pathname.slice(1);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || database.length > 64 || parsed.search || parsed.hash) invalid();
  return Object.freeze({ id, file, host: parsed.hostname === "[::1]" ? "::1" : parsed.hostname, port });
}
function container(value, expected) {
  if (!Array.isArray(value) || value.length !== 1) invalid();
  const row = value[0];
  if (field(row, "Id") !== expected.id || field(field(row, "State"), "Running") !== true
    || field(field(row, "Config"), "Image") !== "mysql:8.0.26") invalid();
  const ports = field(field(row, "NetworkSettings"), "Ports"), bindings = field(ports, "3306/tcp");
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 16) invalid();
  let matchingFamily = false;
  for (const candidate of bindings) {
    const binding = closed(candidate, ["HostIp", "HostPort"]);
    if (binding.HostPort !== String(expected.port) || !["0.0.0.0", "::", "127.0.0.1", "::1"].includes(binding.HostIp)) invalid();
    if (expected.host === "127.0.0.1" && ["0.0.0.0", "127.0.0.1"].includes(binding.HostIp)
      || expected.host === "::1" && ["::", "::1"].includes(binding.HostIp)) matchingFamily = true;
  }
  if (!matchingFamily) invalid();
}

/** Own only this direct Docker client process. Raw inspect/stdout/stderr never leave this module. */
async function docker(args) {
  return new Promise((yes, no) => {
    let child;
    try { child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], shell: false }); }
    catch { no(new CiMysqlAuthorityError()); return; }
    let failed = false, bytes = 0;
    const output = [];
    const stop = () => {
      failed = true;
      if (Number.isSafeInteger(child.pid) && child.pid > 1 && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* retain ownership until actual close, never report proof */ }
      }
    };
    const timer = setTimeout(stop, 5000);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop(); else output.push(chunk); });
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) stop(); });
    child.on("error", () => { failed = true; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || code !== 0 || signal !== null) no(new CiMysqlAuthorityError());
      else {
        const raw = Buffer.concat(output), text = raw.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(raw)) no(new CiMysqlAuthorityError()); else yes(text);
      }
    });
  });
}

/** One owned native connection. A timeout destroys actual transport, then awaits original work/close. */
async function nativeIdentity({ host, port }) {
  let socket, connection, timedOut = false, socketClosed = Promise.resolve();
  const timer = setTimeout(() => { timedOut = true; socket?.destroy(new CiMysqlAuthorityError()); }, 5000);
  try {
    const mysql = await import("mysql2/promise");
    if (timedOut) invalid();
    connection = await mysql.createConnection({ host, port, user: "root", password: "", connectTimeout: 5000,
      supportBigNumbers: true, bigNumberStrings: false, multipleStatements: false,
      stream: () => {
        socket = net.createConnection({ host, port });
        socketClosed = new Promise(done => socket.once("close", done));
        // The driver still receives the same native error; do not emit an unhandled socket error.
        socket.on("error", () => {});
        return socket;
      } });
    if (timedOut) invalid();
    const [rows] = await connection.query({ sql: NATIVE_SQL, timeout: 5000 });
    if (timedOut || !Array.isArray(rows) || rows.length !== 1) invalid();
    return closed(rows[0], ["server_uuid", "mandatory_roles", "external_clients"]);
  } finally {
    let failed = false;
    try { connection?.destroy(); } catch { failed = true; }
    try { socket?.destroy(); } catch { failed = true; }
    try { await socketClosed; } finally { clearTimeout(timer); }
    if (failed || timedOut) invalid();
  }
}

async function githubFile(path) {
  if (!Number.isSafeInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) invalid();
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await realpath(path) !== path) invalid();
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino) invalid();
    return {
      async append(text) {
        const current = await lstat(path), descriptor = await handle.stat();
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || descriptor.nlink !== 1
          || current.dev !== actual.dev || current.ino !== actual.ino || descriptor.dev !== actual.dev || descriptor.ino !== actual.ino
          || await realpath(path) !== path) invalid();
        await handle.appendFile(text, "utf8"); await handle.sync();
      },
      async close() { await handle.close(); },
    };
  } catch (error) { await handle.close(); throw error; }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  openGithubEnv: githubFile,
  inspectContainer: async id => JSON.parse(await docker(["inspect", "--type", "container", id])),
  containerUuid: id => docker(["exec", id, "mysql", "--protocol=socket", "-N", "-uroot", "-e", "SELECT @@server_uuid"]),
  nativeIdentity,
});

/**
 * Test injection is for pure rejection/ordering tests, never a Docker/MySQL ownership proof.
 * Only the direct CLI uses these real adapters. No GLOBAL, CREATE, GRANT, or business SQL runs.
 */
export async function attestCiOwnedMysqlAuthority(argv, env, dependencies = DEFAULT_DEPENDENCIES) {
  let file;
  try {
    const expected = input(argv, env);
    file = await dependencies.openGithubEnv(expected.file);
    container(await dependencies.inspectContainer(expected.id), expected);
    const rawUuid = await dependencies.containerUuid(expected.id);
    if (typeof rawUuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\r?\n)?$/.test(rawUuid)) invalid();
    const uuid = rawUuid.replace(/\r?\n$/, "");
    const native = closed(await dependencies.nativeIdentity({ host: expected.host, port: expected.port }), ["server_uuid", "mandatory_roles", "external_clients"]);
    if (!UUID.test(uuid) || native.server_uuid !== uuid || native.mandatory_roles !== ""
      || native.external_clients !== 0 && native.external_clients !== "0") invalid();
    await file.append(`MYSQL_TEST_OWNED_SERVER_UUID=${uuid}\nMYSQL_TEST_AUTHORITY_ACK=${ACK}\n`);
  } catch {
    throw new CiMysqlAuthorityError();
  } finally {
    if (file) {
      try { await file.close(); } catch { throw new CiMysqlAuthorityError(); }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  attestCiOwnedMysqlAuthority(process.argv.slice(2), process.env).then(
    () => { process.stdout.write('{"status":"ok","proof":"dedicated_disposable_mysql"}\n'); },
    () => { process.stderr.write('{"status":"error","code":"mysql_test_authority_unproven"}\n'); process.exitCode = 1; },
  );
}
