import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHARED = ["NODE_ENV", "REDIS_URL", "REDIS_PREFIX", "REDIS_NAMESPACE_ID", "INTERNAL_ROUTER_TOKEN",
  "BLOB_STORE", "BLOB_NAMESPACE_ID", "BLOB_FILESYSTEM_SINGLE_RUNNER", "BLOB_STORAGE_CONTROL_ENABLED", "BLOB_ATTACHMENTS_ENABLED"];
const RUNNER_REQUIRED = [...SHARED, "STORE", "MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA",
  "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST", "RUNNER_HOST", "RUNNER_PORT",
  "RUNNER_ID", "RUNNER_ADDR", "SECRETS_MASTER_KEY", "BLOB_DIR", "BLOB_CLEANUP_ENABLED"];
const ROUTER_REQUIRED = [...SHARED, "ROUTER_HOST", "ROUTER_PORT", "RUNNERS"];
const OPTIONAL = ["LOG_LEVEL", "MAX_BODY_BYTES"];
const RUNNER_OPTIONAL = [...OPTIONAL, "API_KEY", "API_BASE_URL", "DEFAULT_MODEL", "PLATFORM_PROVIDER",
  "SSE_HEARTBEAT_MS", "SSE_MAX_QUEUED_EVENTS", "SSE_MAX_QUEUED_BYTES", "SSE_MAX_FRAME_BYTES",
  "SSE_MAX_REPLAY_EVENTS", "SSE_MAX_REPLAY_BYTES", "SSE_REPLAY_TIMEOUT_MS", "SSE_WRITE_STALL_MS",
  "SSE_MAX_CONNECTIONS", "SSE_MAX_CONNECTIONS_PER_TENANT"];
const OFF_SHARED = ["MCP_REGISTRY_ENABLED", "SKILL_REGISTRY_ENABLED", "TENANT_HOOKS_ENABLED", "LIFECYCLE_HOOKS_ENABLED", "SUBAGENTS_ENABLED"];
const OFF_RUNNER = [...OFF_SHARED, "HOOKS_ENABLED", "SKILLS_ENABLED"];
const MAX_FILE_BYTES = 65_536;
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

export class ExternalInfraError extends Error {
  code = "external_infra_invalid";
  constructor() { super("external_infra_invalid"); this.name = "ExternalInfraError"; }
}
function invalid() { throw new ExternalInfraError(); }
function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value
    || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function object(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor?.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function stringMap(input, allowed, required) {
  const result = object(input, allowed);
  if (required.some(key => !Object.hasOwn(result, key))) invalid();
  for (const value of Object.values(result)) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value) > 16_384
      || Buffer.from(value).toString("utf8") !== value || /[\u0000\r\n]/.test(value)) invalid();
  }
  return Object.freeze(result);
}

/** Closed string-map grammar, including rejection of duplicate JSON keys. Never shell source. */
export function parseRoleJson(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_FILE_BYTES
      || Buffer.from(text).toString("utf8") !== text) invalid();
    let offset = 0;
    const whitespace = () => { while (/[ \t\r\n]/.test(text[offset] ?? "!") && offset < text.length) offset++; };
    const take = token => { whitespace(); if (text[offset++] !== token) invalid(); };
    const string = () => {
      whitespace(); STRING.lastIndex = offset;
      const match = STRING.exec(text); if (!match) invalid();
      offset = STRING.lastIndex; return JSON.parse(match[0]);
    };
    const result = Object.create(null); take("{"); whitespace();
    if (text[offset] !== "}") for (;;) {
      const key = string(); if (Object.hasOwn(result, key)) invalid();
      take(":"); result[key] = string(); whitespace();
      if (text[offset] !== ",") break;
      offset++;
    }
    take("}"); whitespace(); if (offset !== text.length) invalid();
    return result;
  } catch { invalid(); }
}

export function parseExternalInfraArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) invalid();
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  if (argv.length !== 7 || argv[0] !== "run") invalid();
  const result = Object.create(null), names = { "--runner-env": "runnerEnv", "--router-env": "routerEnv", "--state-dir": "stateDir" };
  for (let i = 1; i < argv.length; i += 2) {
    if (!Object.hasOwn(names, argv[i])) invalid();
    const key = names[argv[i]];
    if (!key || Object.hasOwn(result, key)) invalid();
    result[key] = absolute(argv[i + 1]);
  }
  if (Object.keys(result).length !== 3 || !result.runnerEnv.endsWith(".json") || !result.routerEnv.endsWith(".json")
    || result.runnerEnv === result.routerEnv) invalid();
  return Object.freeze(result);
}

function port(value) {
  if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65_535) invalid();
  return value;
}
function infrastructureUrl(value, protocol, database) {
  const url = new URL(value);
  // mysql2 treats numeric zero as an omitted port and falls back to 3306.
  // Never let an explicit external-infra selection acquire implicit authority.
  port(url.port);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || !url.port || url.search || url.hash
    || !database.test(url.pathname) || value.includes("?") || value.includes("#")
    || protocol === "mysql:" && !url.username
    || protocol === "redis:" && !Number.isSafeInteger(Number(url.pathname.slice(1)))) invalid();
}

/** This local topology does not attest that caller-selected external infrastructure is dedicated. */
export function validateExternalInfraEnvs(runnerInput, routerInput, stateDir) {
  try {
    absolute(stateDir);
    const runner = stringMap(runnerInput, [...RUNNER_REQUIRED, ...RUNNER_OPTIONAL, ...OFF_RUNNER], RUNNER_REQUIRED);
    const router = stringMap(routerInput, [...ROUTER_REQUIRED, ...OPTIONAL, ...OFF_SHARED], ROUTER_REQUIRED);
    if (!["development", "test"].includes(runner.NODE_ENV)) invalid();
    for (const key of SHARED) if (runner[key] !== router[key]) invalid();
    for (const env of [runner, router]) {
      if (env.BLOB_STORE !== "filesystem" || env.BLOB_FILESYSTEM_SINGLE_RUNNER !== "1"
        || env.BLOB_STORAGE_CONTROL_ENABLED !== "0" || env.BLOB_ATTACHMENTS_ENABLED !== "0"
        || !/^[A-Za-z0-9._:-]{1,64}$/.test(env.REDIS_PREFIX)
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.REDIS_NAMESPACE_ID)
        || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.BLOB_NAMESPACE_ID)
        || !/^[A-Za-z0-9._~-]{32,256}$/.test(env.INTERNAL_ROUTER_TOKEN)) invalid();
      for (const key of OFF_RUNNER) if (Object.hasOwn(env, key) && env[key] !== "0") invalid();
    }
    if (runner.STORE !== "mysql" || runner.RUNNER_HOST !== "127.0.0.1" || router.ROUTER_HOST !== "127.0.0.1"
      || port(runner.RUNNER_PORT) === port(router.ROUTER_PORT)
      || runner.RUNNER_ADDR !== `127.0.0.1:${runner.RUNNER_PORT}`
      || router.RUNNERS !== `http://127.0.0.1:${runner.RUNNER_PORT}`
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(runner.RUNNER_ID)
      || absolute(runner.BLOB_DIR) === stateDir || runner.BLOB_CLEANUP_ENABLED !== "0"
      || !/^[0-9a-f]{64}$/i.test(runner.SECRETS_MASTER_KEY)
      || (runner.MAX_BODY_BYTES ?? "1000000") !== (router.MAX_BODY_BYTES ?? "1000000")) invalid();
    infrastructureUrl(runner.MYSQL_URL, "mysql:", /^\/[A-Za-z0-9_]{1,64}$/);
    infrastructureUrl(runner.REDIS_URL, "redis:", /^\/(?:0|[1-9][0-9]*)$/);
    return Object.freeze({ runner, router });
  } catch { invalid(); }
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) invalid();
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
async function protectedFile(path) {
  absolute(path);
  const parent = dirname(path), beforeParent = await privateDirectory(parent);
  const beforePath = await lstat(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) invalid();
  if (await realpath(path) !== path) invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o600
      || before.nlink !== 1 || before.size < 2 || before.size > MAX_FILE_BYTES || identity(before) !== identity(beforePath)) invalid();
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_FILE_BYTES) invalid();
    const bytes = buffer.subarray(0, length), after = await file.stat(), pathStat = await lstat(path);
    if (identity(before) !== identity(after) || identity(after) !== identity(pathStat)
      || beforeParent !== await privateDirectory(parent) || bytes.length !== after.size
      || !bytes.equals(Buffer.from(bytes.toString("utf8")))) invalid();
    return Object.freeze({ path, identity: identity(after), parent: beforeParent,
      sha256: createHash("sha256").update(bytes).digest("hex"), values: parseRoleJson(bytes.toString("utf8")) });
  } finally { await file.close(); }
}
async function unchanged(witness) {
  const actual = await protectedFile(witness.path);
  if (actual.identity !== witness.identity || actual.parent !== witness.parent || actual.sha256 !== witness.sha256) invalid();
}
async function productConfigs(runner, router) {
  const [{ loadConfig }, { loadRouterConfig }] = await Promise.all([
    import("../../apps/agent-runner/src/config.ts"), import("../../apps/agent-router/src/config.ts"),
  ]);
  loadConfig(runner); loadRouterConfig(router);
}
function active(signal) { if (signal.aborted) invalid(); }

/** Test dependencies model process ordering only; they are not native process/infrastructure proof. */
export async function runExternalInfra(options, dependencies = {}) {
  const config = object(options, ["runnerEnv", "routerEnv", "stateDir"]);
  if (Object.keys(config).length !== 3) invalid();
  for (const value of Object.values(config)) absolute(value);
  const signal = dependencies.signal ?? new AbortController().signal;
  const spawnChild = dependencies.spawn ?? spawn;
  const validateConfigs = dependencies.validateProductConfigs ?? productConfigs;
  const children = [], logs = [];
  let stopping = false, childFailed = false, cleanupFailed = false;
  const stop = () => {
    stopping = true;
    for (const entry of children) if (!entry.closed && !entry.exited && !entry.termSent) {
      entry.termSent = true;
      if (entry.pid === undefined) continue; // Failed native spawn: still wait for its close event.
      if (!Number.isSafeInteger(entry.pid) || entry.pid <= 1 || entry.child.pid !== entry.pid) { cleanupFailed = true; continue; }
      try { entry.child.kill("SIGTERM"); } catch { cleanupFailed = true; }
    }
  };
  const launch = (role, env, log) => {
    active(signal);
    if (stopping) invalid();
    const child = spawnChild(process.execPath, ["--import", "tsx", `apps/agent-${role}/src/main.ts`],
      { cwd: ROOT, env, shell: false, detached: false, stdio: ["ignore", log.fd, log.fd] });
    const entry = { child, pid: child.pid, closed: false, exited: false, termSent: false, settled: undefined };
    children.push(entry);
    entry.settled = new Promise(resolveClosed => {
      child.once("error", () => { childFailed = true; stop(); });
      child.once("exit", () => { entry.exited = true; });
      child.once("close", () => { entry.closed = true; if (!stopping) { childFailed = true; stop(); } resolveClosed(); });
    });
    if (signal.aborted) stop();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    active(signal);
    const runnerFile = await protectedFile(config.runnerEnv), routerFile = await protectedFile(config.routerEnv);
    const roles = validateExternalInfraEnvs(runnerFile.values, routerFile.values, config.stateDir);
    await validateConfigs(roles.runner, roles.router); active(signal);
    const blobIdentity = await privateDirectory(roles.runner.BLOB_DIR);
    const parent = dirname(config.stateDir), parentIdentity = await privateDirectory(parent);
    active(signal);
    await mkdir(config.stateDir, { mode: 0o700 });
    const stateIdentity = await privateDirectory(config.stateDir);
    if (await privateDirectory(parent) !== parentIdentity) invalid();
    for (const name of ["home", "home/.config", "home/.cache", "tmp"]) {
      active(signal);
      await mkdir(join(config.stateDir, name), { mode: 0o700 });
    }
    const base = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(config.stateDir, "home"),
      XDG_CONFIG_HOME: join(config.stateDir, "home/.config"), XDG_CACHE_HOME: join(config.stateDir, "home/.cache"),
      TMPDIR: join(config.stateDir, "tmp"), TMP: join(config.stateDir, "tmp"), TEMP: join(config.stateDir, "tmp"),
      AWS_EC2_METADATA_DISABLED: "true" };
    for (const role of ["runner", "router"]) {
      active(signal);
      logs.push(await open(join(config.stateDir, `${role}.log`), "wx", 0o600));
    }
    await unchanged(runnerFile); await unchanged(routerFile); active(signal);
    if (await privateDirectory(roles.runner.BLOB_DIR) !== blobIdentity) invalid();
    if (await privateDirectory(config.stateDir) !== stateIdentity) invalid();
    launch("runner", { ...base, ...roles.runner }, logs[0]);
    await unchanged(runnerFile); await unchanged(routerFile); active(signal);
    if (await privateDirectory(roles.runner.BLOB_DIR) !== blobIdentity) invalid();
    if (await privateDirectory(config.stateDir) !== stateIdentity) invalid();
    launch("router", { ...base, ...roles.router }, logs[1]);
    await Promise.all(children.map(entry => entry.settled));
    if (childFailed || !signal.aborted) invalid();
  } catch { throw new ExternalInfraError(); }
  finally {
    stop();
    await Promise.all(children.map(entry => entry.settled));
    signal.removeEventListener("abort", stop);
    for (const log of logs) {
      try { await log.sync(); } catch { cleanupFailed = true; }
      try { await log.close(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new ExternalInfraError();
  }
}

export const EXTERNAL_INFRA_HELP = "local-service.sh --external-infra run --runner-env ABS_JSON --router-env ABS_JSON --state-dir ABS_NEW_DIR\n"
  + "Foreground source runner/router only; Ctrl-C/TERM drains owned children. No .env, infrastructure, bootstrap, schema, build, status or down operation.\n"
  + "Role JSON files must be owner-only 0600 in private 0700 directories; state directory must be new. BLOB_DIR must be a separate existing private 0700 directory, kept stable across runs.\n"
  + "External infrastructure is operator-selected, not attested dedicated; no Blob migration or deletion is performed.\n";

async function main() {
  let interrupted;
  const controller = new AbortController();
  const onInt = () => { interrupted = 130; controller.abort(); };
  const onTerm = () => { interrupted = 143; controller.abort(); };
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const options = parseExternalInfraArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(EXTERNAL_INFRA_HELP); return; }
    if (Number(process.versions.node.split(".")[0]) < 24) invalid();
    await runExternalInfra(options, { signal: controller.signal });
    process.exitCode = interrupted ?? 0;
  } catch { process.stderr.write("external_infra_invalid\n"); process.exitCode = interrupted ?? 1; }
  finally { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
