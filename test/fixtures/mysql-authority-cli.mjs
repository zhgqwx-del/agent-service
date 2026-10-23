import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const STOPPED_ACK = "all-application-writers-stopped-v1";
const EXCLUSIVE_ACK = "exclusive-authority-permissions-window-v1";
const DEADLINE_MS = 120_000, KILL_AFTER_MS = 5_000, MAX_BYTES = 65_536;
const OS_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"];

export class MysqlAuthorityCliExecutorError extends Error {
  code = "mysql_authority_cli_executor_failed";
  constructor(evidenceDirectory) {
    super("MySQL authority CLI execution failed."); this.name = "MysqlAuthorityCliExecutorError";
    if (evidenceDirectory !== undefined) Object.defineProperty(this, "evidenceDirectory", { value: evidenceDirectory, enumerable: true });
  }
}
function invalid() { throw new MysqlAuthorityCliExecutorError(); }
function object(input, keys) {
  if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const ds = Object.getOwnPropertyDescriptors(input), captured = {};
  if (Reflect.ownKeys(ds).length !== keys.length || Reflect.ownKeys(ds).some(k => typeof k !== "string" || !keys.includes(k))) invalid();
  for (const key of keys) {
    const d = ds[key]; if (!d?.enumerable || !("value" in d)) invalid(); captured[key] = d.value;
  }
  return captured;
}
function array(input, maximum) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const ds = Object.getOwnPropertyDescriptors(input), length = ds.length;
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum
    || Reflect.ownKeys(ds).length !== length.value + 1) invalid();
  const result = [];
  for (let i = 0; i < length.value; i++) {
    const d = ds[String(i)]; if (!d?.enumerable || !("value" in d)) invalid(); result.push(d.value);
  }
  return result;
}
function text(value, bytes) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > bytes || Buffer.from(value).toString("utf8") !== value
    || /[\u0000-\u001f\u007f]/.test(value)) invalid(); return value;
}
function uuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid(); return value;
}
function digest(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(); return value; }
function account(value, maximum) {
  text(value, maximum * 4); if ([...value].length > maximum || value.includes("@")) invalid(); return value;
}
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = value => createHash("sha256").update(value).digest("hex");

/** Initial fresh-fixture command only. Does not admit a restore/epoch transition. */
export function captureMysqlFixtureAuthorityCommand(input) {
  const command = object(input, ["bindingId", "activationId", "expectedBindingId", "expectedSequence", "serverUuid",
    "applicationDatabase", "newAccounts", "oldAccountNames", "activationEvidenceSha256", "expectedSource", "nextEpoch"]);
  uuid(command.bindingId); uuid(command.activationId); uuid(command.serverUuid);
  if (command.expectedBindingId !== null || command.expectedSequence !== 0 || command.nextEpoch !== null) invalid();
  text(command.applicationDatabase, 256);
  if ([...command.applicationDatabase].length > 64 || /[/\\]/.test(command.applicationDatabase)) invalid();
  digest(command.activationEvidenceSha256);
  const source = object(command.expectedSource, ["kind", "runtimeControlGeneration", "runtimeControlEvidenceSha256",
    "runtimeEpochSha256", "restoreRunId", "replayReceiptSha256"]);
  if (source.kind !== "inactive" || source.runtimeControlGeneration !== 0 || source.runtimeControlEvidenceSha256 !== null
    || source.runtimeEpochSha256 !== null || source.restoreRunId !== null || source.replayReceiptSha256 !== null) invalid();
  const newAccounts = array(command.newAccounts, 64).map(value => {
    const a = object(value, ["user", "host"]);
    return Object.freeze({ user: account(a.user, 32), host: account(a.host, 255) });
  });
  if (!newAccounts.length || array(command.oldAccountNames, 256).length !== 0) invalid();
  const sorted = [...newAccounts].sort((a, b) => compare(a.user, b.user) || compare(a.host, b.host));
  const entries = sorted.map(a => `${Buffer.byteLength(a.user)}:${a.user}:${Buffer.byteLength(a.host)}:${a.host}`);
  if (new Set(entries).size !== entries.length) invalid();
  const accountsSha256 = sha(`session-authority-accounts-v1|${entries.join("|")}`);
  const captured = Object.freeze({ ...command, newAccounts: Object.freeze(newAccounts), oldAccountNames: Object.freeze([]),
    expectedSource: Object.freeze(source), nextEpoch: null });
  const commandSha256 = sha(JSON.stringify(["session-authority-binding-command-v3", command.bindingId, command.activationId,
    null, 0, command.serverUuid, command.applicationDatabase, accountsSha256, [], command.activationEvidenceSha256,
    ["inactive", 0, null, null, null, null], null]));
  return Object.freeze({ command: captured, commandSha256 });
}
function operation(input) {
  const hasRefKeyFile = input !== null && typeof input === "object" && Object.hasOwn(input, "tenantTelemetryRefKeyFile");
  const value = object(input, ["operation", "url", "operationAbortSignal", "fleetStoppedAck", "exclusiveChangeAck", "schemaMetadata", "command",
    ...(hasRefKeyFile ? ["tenantTelemetryRefKeyFile"] : [])]);
  const refKeyFile = value.tenantTelemetryRefKeyFile;
  if (hasRefKeyFile && (typeof refKeyFile !== "string" || refKeyFile.length === 0 || refKeyFile.length > 4096
    || !isAbsolute(refKeyFile) || resolve(refKeyFile) !== refKeyFile || /[\u0000-\u001f\u007f]/.test(refKeyFile))) invalid();
  if (value.operation !== "activate" || !(value.operationAbortSignal instanceof AbortSignal)
    || value.fleetStoppedAck !== STOPPED_ACK || value.exclusiveChangeAck !== EXCLUSIVE_ACK) invalid();
  if (typeof value.url !== "string" || value.url.length > 4096 || !value.url.startsWith("mysql://")
    || /[\u0000-\u0020\u007f?#]/.test(value.url)) invalid();
  const url = new URL(value.url), { command, commandSha256 } = captureMysqlFixtureAuthorityCommand(value.command);
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^\/[^/]+$/.test(url.pathname) || decodeURIComponent(url.pathname.slice(1)) !== command.applicationDatabase) invalid();
  const metadata = object(value.schemaMetadata, ["metadataSchema", "trustedDefiner"]), definer = object(metadata.trustedDefiner, ["user", "host"]);
  if (typeof metadata.metadataSchema !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(metadata.metadataSchema)) invalid();
  return { signal: value.operationAbortSignal, command, commandSha256, env: {
    AUTHORITY_MYSQL_URL: value.url, AUTHORITY_FLEET_STOPPED_ACK: STOPPED_ACK, AUTHORITY_EXCLUSIVE_CHANGE_ACK: EXCLUSIVE_ACK,
    AUTHORITY_OPERATION_TIMEOUT_MS: String(DEADLINE_MS), AUTHORITY_METADATA_SCHEMA: metadata.metadataSchema,
    AUTHORITY_METADATA_DEFINER_USER: account(definer.user, 32), AUTHORITY_METADATA_DEFINER_HOST: account(definer.host, 255),
    ...(hasRefKeyFile ? { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: refKeyFile } : {}),
  } };
}
function sameDirectory(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && b.uid === process.getuid?.()
    && b.isDirectory() && !b.isSymbolicLink() && (b.mode & 0o7777) === 0o700;
}
async function saveCommand(command, signal, ownDirectory) {
  if (signal.aborted) invalid();
  const parent = await realpath(tmpdir());
  if (signal.aborted) invalid();
  const directory = await mkdtemp(join(parent, "agent-service-authority-command-"));
  ownDirectory(directory); // Retain partial creation on every failure/unknown outcome.
  await chmod(directory, 0o700);
  const initial = await lstat(directory);
  if (!sameDirectory(initial, initial) || await realpath(directory) !== directory || signal.aborted) invalid();
  const bytes = Buffer.from(JSON.stringify(command) + "\n"); if (bytes.length > MAX_BYTES) invalid();
  const path = join(directory, "command.json");
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || signal.aborted) invalid();
    await file.writeFile(bytes); await file.sync();
  } finally { await file.close(); }
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  const final = await lstat(directory), saved = await lstat(path);
  if (!sameDirectory(initial, final) || await realpath(directory) !== directory || !saved.isFile() || saved.isSymbolicLink()
    || saved.uid !== process.getuid?.() || saved.nlink !== 1 || (saved.mode & 0o7777) !== 0o600 || saved.size !== bytes.length || signal.aborted) invalid();
  return path;
}
const DEFAULT_DEPENDENCIES = Object.freeze({ execPath: process.execPath, environment: process.env, lstat: lstatSync, realpath: realpathSync,
  spawn, setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimer: timer => clearTimeout(timer) });

/** Test-only actual CLI adapter; caller authenticates selected source/artifact bytes separately. */
export function createMysqlAuthorityCliExecutor(input, dependencies = DEFAULT_DEPENDENCIES) {
  try {
    const { entrypoint, mode, cwd } = object(input, ["entrypoint", "mode", "cwd"]);
    const deps = object(dependencies, ["execPath", "environment", "lstat", "realpath", "spawn", "setTimer", "clearTimer"]);
    if (typeof entrypoint !== "string" || !isAbsolute(entrypoint) || resolve(entrypoint) !== entrypoint
      || typeof cwd !== "string" || !isAbsolute(cwd) || resolve(cwd) !== cwd || !["source", "dist"].includes(mode)
      || typeof deps.execPath !== "string" || !isAbsolute(deps.execPath)
      || [deps.lstat, deps.realpath, deps.spawn, deps.setTimer, deps.clearTimer].some(value => typeof value !== "function")) invalid();
    const files = () => {
      const entry = deps.lstat(entrypoint), dir = deps.lstat(cwd);
      if (!entry.isFile() || entry.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink()
        || deps.realpath(entrypoint) !== entrypoint || deps.realpath(cwd) !== cwd) invalid();
    };
    files(); if (!deps.environment || typeof deps.environment !== "object") invalid();
    const os = Object.create(null);
    for (const key of OS_KEYS) {
      const d = Object.getOwnPropertyDescriptor(deps.environment, key); if (d === undefined) continue;
      if (!("value" in d) || !d.enumerable || typeof d.value !== "string" || d.value.includes("\0")) invalid(); os[key] = d.value;
    }
    return async inputOperation => {
      let evidenceDirectory;
      try {
        const admitted = operation(inputOperation); if (admitted.signal.aborted) invalid();
        files();
        const commandPath = await saveCommand(admitted.command, admitted.signal, value => { evidenceDirectory = value; });
        files(); if (admitted.signal.aborted) invalid();
        let failed = false, cancelled = false, closed = false, exited = false, termSent = false;
        let child, deadlineTimer, killTimer, outputBytes = 0;
        const stdout = [], stderr = [];
        const stop = () => {
          cancelled = true;
          if (!child || closed || exited || termSent) return;
          termSent = true; try { child.kill("SIGTERM"); } catch { failed = true; }
          killTimer = deps.setTimer(() => { if (!closed && !exited) { try { child.kill("SIGKILL"); } catch { failed = true; } } }, KILL_AFTER_MS);
        };
        const native = await new Promise(resolveClosed => {
          const cleanup = () => {
            if (deadlineTimer !== undefined) deps.clearTimer(deadlineTimer);
            if (killTimer !== undefined) deps.clearTimer(killTimer);
            admitted.signal.removeEventListener("abort", stop);
          };
          admitted.signal.addEventListener("abort", stop, { once: true });
          deadlineTimer = deps.setTimer(stop, DEADLINE_MS);
          if (admitted.signal.aborted) { cancelled = true; cleanup(); resolveClosed({ code: null, signal: null }); return; }
          try {
            child = deps.spawn(deps.execPath, [...(mode === "source" ? ["--import", "tsx"] : []), entrypoint, "authority", "activate"],
              { cwd, env: { ...os, ...admitted.env, AUTHORITY_COMMAND_FILE: commandPath }, stdio: ["ignore", "pipe", "pipe"], shell: false });
          } catch { failed = true; cleanup(); resolveClosed({ code: null, signal: null }); return; }
          const collect = target => chunk => {
            if (closed) return;
            try {
              const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"); outputBytes += bytes.length;
              if (outputBytes > MAX_BYTES) { failed = true; stop(); return; } target.push(bytes);
            } catch { failed = true; stop(); }
          };
          child.once("error", () => { failed = true; stop(); }); child.once("exit", () => { exited = true; });
          child.once("close", (code, signal) => { closed = true; cleanup(); resolveClosed({ code, signal }); });
          for (const [stream, target] of [[child.stdout, stdout], [child.stderr, stderr]]) {
            if (!stream) { failed = true; stop(); continue; }
            stream.on("data", collect(target)); stream.on("error", () => { if (!closed) { failed = true; stop(); } });
          }
          if (admitted.signal.aborted) stop();
        });
        if (failed || cancelled || admitted.signal.aborted || native.code !== 0 || native.signal !== null || Buffer.concat(stderr).length !== 0
          || Buffer.concat(stdout).toString("utf8") !== JSON.stringify({ status: "ok", command: "activate", activated: true,
            commandSha256: admitted.commandSha256 }) + "\n") invalid();
      } catch { throw new MysqlAuthorityCliExecutorError(evidenceDirectory); }
    };
  } catch { invalid(); }
}
