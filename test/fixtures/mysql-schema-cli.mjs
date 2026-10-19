import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const ACK = "all-application-writers-stopped-v1";
const DEADLINE_MS = 120_000;
const KILL_AFTER_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;
const OS_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"];

export class MysqlSchemaCliExecutorError extends Error {
  code = "mysql_schema_cli_executor_failed";
  constructor() { super("MySQL schema CLI execution failed."); this.name = "MysqlSchemaCliExecutorError"; }
}
function invalid() { throw new MysqlSchemaCliExecutorError(); }
function object(input, allowed, required = allowed) {
  if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), captured = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor?.enumerable || !("value" in descriptor)) invalid();
    captured[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(captured, key))) invalid();
  return captured;
}
function mysqlUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value.trim() !== value || !value.startsWith("mysql://") || /[\u0000-\u0020\u007f]/.test(value)
    || value.includes("?") || value.includes("#")) invalid();
  try {
    const url = new URL(value), database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !url.hostname || !/^\/[^/]+$/.test(url.pathname)
      || !database || database.length > 64 || database.trim() !== database
      || /[\\/\u0000-\u001f\u007f]/.test(database) || database === "." || database === "..") invalid();
  } catch { invalid(); }
  return value;
}
function account(value, max) {
  if (typeof value !== "string" || [...value].length < 1 || [...value].length > max
    || Buffer.byteLength(value, "utf8") > max * 4 || Buffer.from(value, "utf8").toString("utf8") !== value
    || /[\u0000-\u001f\u007f@]/.test(value)) invalid();
  return value;
}
function operation(input) {
  const value = object(input, ["operation", "url", "operationAbortSignal", "fleetStoppedAck", "schemaMetadata"],
    ["operation", "url", "operationAbortSignal"]);
  if (!["migrate", "verify", "install-metadata"].includes(value.operation)
    || !(value.operationAbortSignal instanceof AbortSignal)) invalid();
  const env = { SCHEMA_MYSQL_URL: mysqlUrl(value.url), SCHEMA_OPERATION_TIMEOUT_MS: String(DEADLINE_MS) };
  if (value.operation === "verify") {
    if (value.fleetStoppedAck !== undefined || value.schemaMetadata !== undefined) invalid();
  } else {
    if (value.fleetStoppedAck !== ACK) invalid();
    env.SCHEMA_FLEET_STOPPED_ACK = ACK;
    if (value.operation === "migrate") {
      if (value.schemaMetadata !== undefined) invalid();
    } else {
      const config = object(value.schemaMetadata, ["metadataSchema", "trustedDefiner"]);
      const definer = object(config.trustedDefiner, ["user", "host"]);
      if (typeof config.metadataSchema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(config.metadataSchema)) invalid();
      env.SCHEMA_METADATA_SCHEMA = config.metadataSchema;
      env.SCHEMA_METADATA_DEFINER_USER = account(definer.user, 32);
      env.SCHEMA_METADATA_DEFINER_HOST = account(definer.host, 255);
    }
  }
  return { command: value.operation, signal: value.operationAbortSignal, env };
}
const DEFAULT_DEPENDENCIES = Object.freeze({
  execPath: process.execPath,
  environment: process.env,
  lstat: lstatSync,
  realpath: realpathSync,
  spawn,
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: timer => clearTimeout(timer),
});

/** Test-only process adapter. The caller separately authenticates source/artifact bytes and identity. */
export function createMysqlSchemaCliExecutor(input, dependencies = DEFAULT_DEPENDENCIES) {
  try {
    const { entrypoint, mode, cwd } = object(input, ["entrypoint", "mode", "cwd"]);
    const deps = object(dependencies, ["execPath", "environment", "lstat", "realpath", "spawn", "setTimer", "clearTimer"]);
    if (typeof entrypoint !== "string" || !isAbsolute(entrypoint) || resolve(entrypoint) !== entrypoint
      || typeof cwd !== "string" || !isAbsolute(cwd) || resolve(cwd) !== cwd
      || mode !== "source" && mode !== "dist" || typeof deps.execPath !== "string" || !isAbsolute(deps.execPath)
      || [deps.lstat, deps.realpath, deps.spawn, deps.setTimer, deps.clearTimer].some(value => typeof value !== "function")) invalid();
    const files = () => {
      const entry = deps.lstat(entrypoint), directory = deps.lstat(cwd);
      if (!entry.isFile() || entry.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()
        || deps.realpath(entrypoint) !== entrypoint) invalid();
    };
    files();
    if (deps.environment === null || typeof deps.environment !== "object") invalid();
    const os = Object.create(null);
    for (const key of OS_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(deps.environment, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string" || descriptor.value.includes("\0")) invalid();
      os[key] = descriptor.value;
    }
    return async inputOperation => {
      try {
        const admitted = operation(inputOperation);
        if (admitted.signal.aborted) invalid();
        files(); // A later path replacement never enables a symlink/source fallback.
        let failed = false, cancelled = false, closed = false, exited = false, termSent = false;
        let child, deadlineTimer, killTimer, outputBytes = 0;
        const stdout = [], stderr = [];
        const stop = () => {
          cancelled = true;
          if (!child || closed || exited || termSent) return;
          termSent = true;
          try { child.kill("SIGTERM"); } catch { failed = true; }
          killTimer = deps.setTimer(() => {
            if (!closed && !exited) { try { child.kill("SIGKILL"); } catch { failed = true; } }
          }, KILL_AFTER_MS);
        };
        const native = await new Promise(resolveClosed => {
          const cleanup = () => {
            if (deadlineTimer !== undefined) deps.clearTimer(deadlineTimer);
            if (killTimer !== undefined) deps.clearTimer(killTimer);
            admitted.signal.removeEventListener("abort", stop);
          };
          admitted.signal.addEventListener("abort", stop, { once: true });
          deadlineTimer = deps.setTimer(stop, DEADLINE_MS);
          const args = [...(mode === "source" ? ["--import", "tsx"] : []), entrypoint, "schema", admitted.command];
          try {
            child = deps.spawn(deps.execPath, args, { cwd, env: { ...os, ...admitted.env },
              stdio: ["ignore", "pipe", "pipe"], shell: false });
          } catch { failed = true; cleanup(); resolveClosed({ code: null, signal: null }); return; }
          const collect = target => chunk => {
            if (closed) return;
            try {
              const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
              outputBytes += bytes.length;
              if (outputBytes > MAX_OUTPUT_BYTES) { failed = true; stop(); return; }
              target.push(bytes);
            } catch { failed = true; stop(); }
          };
          child.once("error", () => { failed = true; stop(); });
          child.once("exit", () => { exited = true; });
          child.once("close", (code, signal) => {
            closed = true; cleanup(); resolveClosed({ code, signal });
          });
          for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) {
            if (!stream) { failed = true; stop(); continue; }
            stream.on("data", collect(target));
            stream.on("error", () => { if (!closed) { failed = true; stop(); } });
          }
          if (cancelled || admitted.signal.aborted) stop();
        });
        // Native close includes the child's stdio lifecycle. Never race it with cancellation.
        if (failed || cancelled || admitted.signal.aborted || native.code !== 0 || native.signal !== null
          || Buffer.concat(stderr).length !== 0
          || Buffer.concat(stdout).toString("utf8") !== JSON.stringify({ status: "ok", command: admitted.command }) + "\n") invalid();
      } catch { invalid(); }
    };
  } catch { invalid(); }
}
