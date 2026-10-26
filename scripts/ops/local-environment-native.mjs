import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readlink, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

// Native observations and process ownership only. This module never reads ambient
// configuration, changes a seal/lock, initializes data, or force kills a process.
const MAX_PRIVATE_BYTES = 1024 * 1024;
const NATIVE_ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hash = value => createHash("sha256").update(value).digest("hex");
const SAFE_CODES = new Set([
  "absolute_path_required", "private_directory_required", "private_directory_changed", "private_file_required",
  "private_file_changed", "private_file_unavailable", "private_json_invalid", "private_json_too_large",
  "private_json_write_failed", "private_json_target_exists", "private_json_target_changed", "file_pin_invalid",
  "file_pin_changed", "file_pin_unavailable", "process_witness_invalid", "process_identity_unavailable",
  "process_identity_mismatch", "process_executable_mismatch", "process_identity_changed", "process_probe_failed",
  "listener_invalid", "listener_identity_unavailable", "listener_identity_mismatch", "spawn_spec_invalid",
  "spawn_failed_retained", "spawn_identity_failed_retained", "spawn_log_unavailable", "owned_process_invalid",
  "process_stop_timeout_retained", "process_signal_failed_retained", "owned_process_close_failed_retained",
  "native_operation_failed",
]);

function fail(code) { throw new Error(code); }
function need(value, code) { if (!value) fail(code); }
export function safeCode(error) {
  return error instanceof Error && SAFE_CODES.has(error.message) ? error.message : "native_operation_failed";
}
function absolute(path) {
  need(typeof path === "string" && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path), "absolute_path_required");
  return path;
}
function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
function directoryIdentity(stat) { return [stat.dev, stat.ino, stat.uid, stat.mode].join(":"); }
function samePin(left, right) {
  return left?.path === right?.path && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.sha256 === right.sha256;
}
function validPin(value) {
  return value && typeof value === "object" && typeof value.path === "string"
    && [value.dev, value.ino, value.size].every(Number.isSafeInteger)
    && value.dev >= 0 && value.ino > 0 && value.size > 0 && /^[a-f0-9]{64}$/.test(value.sha256);
}
function validWitness(value) {
  return value && typeof value === "object" && Number.isSafeInteger(value.pid) && value.pid > 1
    && Number.isSafeInteger(value.pgid) && value.pgid > 1 && Number.isSafeInteger(value.uid)
    && value.uid === process.getuid?.() && typeof value.started === "string" && value.started.length > 0
    && validPin(value.executable);
}
function sameWitness(left, right) {
  return left.pid === right.pid && left.pgid === right.pgid && left.uid === right.uid
    && left.started === right.started && samePin(left.executable, right.executable);
}
async function privateDirectory(path) {
  absolute(path);
  const stat = await lstat(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && (stat.mode & 0o7777) === 0o700 && await realpath(path) === path, "private_directory_required");
  return directoryIdentity(stat);
}
async function privateBytes(path, maxBytes) {
  absolute(path);
  need(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, "private_json_too_large");
  const parent = await privateDirectory(dirname(path));
  const before = await lstat(path);
  need(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid?.()
    && (before.mode & 0o7777) === 0o600 && before.nlink === 1 && before.size > 0
    && before.size <= maxBytes && await realpath(path) === path, "private_file_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await file.stat();
    need(fileIdentity(first) === fileIdentity(before), "private_file_changed");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    need(length <= maxBytes && length === after.size && fileIdentity(first) === fileIdentity(after)
      && fileIdentity(after) === fileIdentity(await lstat(path))
      && parent === await privateDirectory(dirname(path)), "private_file_changed");
    const bytes = buffer.subarray(0, length);
    need(bytes.equals(Buffer.from(bytes.toString("utf8"))), "private_json_invalid");
    return { bytes, sha256: hash(bytes), identity: fileIdentity(after) };
  } finally { await file.close(); }
}

export async function readPrivateJson(path, maxBytes = MAX_PRIVATE_BYTES) {
  try {
    const file = await privateBytes(path, maxBytes);
    let value;
    try { value = JSON.parse(file.bytes.toString("utf8")); } catch { fail("private_json_invalid"); }
    return { value, sha256: file.sha256 };
  } catch (error) {
    if (SAFE_CODES.has(error?.message)) throw error;
    fail("private_file_unavailable");
  }
}
async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function optionalTarget(path) {
  try { return await privateBytes(path, 64 * 1024 * 1024); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function writePrivateJson(path, value, { createOnly = false } = {}) {
  let temporary;
  let temporaryCreated = false;
  try {
    absolute(path);
    need(typeof createOnly === "boolean", "private_json_write_failed");
    const parent = await privateDirectory(dirname(path));
    const prior = await optionalTarget(path);
    need(!createOnly || prior === null, "private_json_target_exists");
    let serialized;
    try { serialized = JSON.stringify(value, null, 2); } catch { fail("private_json_invalid"); }
    need(typeof serialized === "string", "private_json_invalid");
    const bytes = Buffer.from(serialized + "\n");
    need(bytes.length <= 64 * 1024 * 1024, "private_json_too_large");
    temporary = path + "." + randomBytes(16).toString("hex") + ".next";
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try { await file.chmod(0o600); await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    need(parent === await privateDirectory(dirname(path)), "private_directory_changed");
    const current = await optionalTarget(path);
    need(prior === null ? current === null : current?.identity === prior.identity && current.sha256 === prior.sha256,
      "private_json_target_changed");
    if (createOnly) {
      // link is an atomic create-if-absent operation; rename would replace a race winner.
      try { await link(temporary, path); }
      catch (error) { if (error?.code === "EEXIST") fail("private_json_target_exists"); throw error; }
      await unlink(temporary);
    } else await rename(temporary, path);
    temporaryCreated = false;
    await syncDirectory(dirname(path));
    return { sha256: hash(bytes) };
  } catch (error) {
    if (SAFE_CODES.has(error?.message)) throw error;
    fail("private_json_write_failed");
  } finally {
    // Only our unpredictable, create-only temporary file is eligible for cleanup.
    if (temporaryCreated) { try { await unlink(temporary); } catch { /* Retain an unknown write outcome. */ } }
  }
}

export async function pinFile(path) {
  try {
    absolute(path);
    const before = await lstat(path);
    need(before.isFile() && !before.isSymbolicLink() && !(before.mode & 0o022)
      && before.size > 0 && await realpath(path) === path, "file_pin_invalid");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const first = await file.stat();
      need(fileIdentity(before) === fileIdentity(first), "file_pin_changed");
      const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let length = 0;
      for (;;) {
        const result = await file.read(buffer, 0, buffer.length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
        need(length <= before.size, "file_pin_changed");
        digest.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await file.stat();
      need(length === before.size && fileIdentity(before) === fileIdentity(after)
        && fileIdentity(after) === fileIdentity(await lstat(path)) && await realpath(path) === path, "file_pin_changed");
      return { path, dev: after.dev, ino: after.ino, size: after.size, sha256: digest.digest("hex") };
    } finally { await file.close(); }
  } catch (error) {
    if (SAFE_CODES.has(error?.message)) throw error;
    fail("file_pin_unavailable");
  }
}
async function selectedExecutable(value) {
  const path = typeof value === "string" ? value : value?.path;
  const actual = await pinFile(path);
  need(typeof value === "string" || validPin(value) && samePin(value, actual), "file_pin_changed");
  return actual;
}
async function native(file, args, code) {
  return await new Promise((done, reject) => {
    execFile(file, args, { shell: false, env: NATIVE_ENV, timeout: 5000, maxBuffer: 262144, encoding: "utf8" },
      (error, stdout) => error ? reject(new Error(code)) : done(stdout));
  });
}
export async function processIdentity(pid, expectedExecutable) {
  need(Number.isSafeInteger(pid) && pid > 1, "process_witness_invalid");
  const expected = await selectedExecutable(expectedExecutable);
  const text = await native("/bin/ps", ["-p", String(pid), "-o", "pid=,pgid=,uid=,lstart=,comm="], "process_identity_unavailable");
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\r\n]+)\s*$/.exec(text);
  need(match && Number(match[1]) === pid && Number(match[2]) > 1 && Number(match[3]) === process.getuid?.(), "process_identity_mismatch");
  let actualPath;
  try { if (isAbsolute(match[5].trim())) actualPath = await realpath(match[5].trim()); } catch { /* Observe mappings below. */ }
  if (actualPath !== expected.path && process.platform === "linux") {
    try { actualPath = await realpath(await readlink(`/proc/${pid}/exe`)); } catch { /* lsof is the final fallback. */ }
  }
  if (actualPath !== expected.path) {
    const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
    const mappings = await native(lsof, ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"], "process_identity_unavailable");
    need(mappings.split("\n").includes("n" + expected.path), "process_executable_mismatch");
  }
  return { pid, pgid: Number(match[2]), uid: Number(match[3]), started: match[4].replace(/\s+/g, " "), executable: expected };
}
export async function sameProcess(witness) {
  need(validWitness(witness), "process_witness_invalid");
  const actual = await processIdentity(witness.pid, witness.executable);
  need(sameWitness(actual, witness), "process_identity_changed");
  return actual;
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error?.code === "ESRCH") return true; fail("process_probe_failed"); }
}
function groupGone(pgid) {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { if (error?.code === "ESRCH") return true; fail("process_probe_failed"); }
}
export async function processAbsent(witness) {
  need(validWitness(witness), "process_witness_invalid");
  if (pidGone(witness.pid)) return true;
  try { await sameProcess(witness); }
  catch (error) { if (pidGone(witness.pid)) return true; throw error; }
  return false;
}
export async function assertListener(port, pid) {
  need(Number.isSafeInteger(port) && port > 0 && port <= 65535 && Number.isSafeInteger(pid) && pid > 1, "listener_invalid");
  const lsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
  const output = await native(lsof, ["-nP", "-a", "-iTCP:" + port, "-sTCP:LISTEN", "-Fp"], "listener_identity_unavailable");
  const pids = [...new Set(output.split("\n").filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  need(pids.length === 1 && pids[0] === pid, "listener_identity_mismatch");
}

export async function spawnOwned(spec) {
  need(spec && typeof spec === "object", "spawn_spec_invalid");
  const { executable, args, cwd, env, logPath } = spec;
  need(Array.isArray(args) && args.every(value => typeof value === "string" && !value.includes("\0"))
    && env && typeof env === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(env))
    && Object.keys(env).every(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof env[key] === "string" && !env[key].includes("\0")), "spawn_spec_invalid");
  const pin = await selectedExecutable(executable);
  let log, parent;
  try {
    absolute(cwd); absolute(logPath);
    const directory = await lstat(cwd);
    need(directory.isDirectory() && !directory.isSymbolicLink() && !(directory.mode & 0o022) && await realpath(cwd) === cwd, "spawn_spec_invalid");
    parent = await privateDirectory(dirname(logPath));
    log = await open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await log.chmod(0o600);
    const stat = await log.stat();
    need(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.()
      && fileIdentity(stat) === fileIdentity(await lstat(logPath))
      && parent === await privateDirectory(dirname(logPath)), "spawn_log_unavailable");
  } catch (error) {
    try { await log?.close(); } catch { /* No process has been created. */ }
    if (SAFE_CODES.has(error?.message)) throw error;
    fail("spawn_log_unavailable");
  }
  let child, spawnError = false, closed, logCloseFailed = false;
  try {
    child = spawn(pin.path, args, { shell: false, cwd, env: { ...env }, detached: true, stdio: ["ignore", log.fd, log.fd] });
    closed = new Promise(done => {
      child.once("error", () => { spawnError = true; });
      child.once("close", (code, signal) => done({ code, signal }));
    });
  } catch { fail("spawn_failed_retained"); }
  finally { try { await log.close(); } catch { logCloseFailed = true; } }
  try {
    need(Number.isSafeInteger(child.pid) && child.pid > 1 && !spawnError && !logCloseFailed, "spawn_failed_retained");
    const witness = await processIdentity(child.pid, pin);
    need(witness.pgid === child.pid, "process_identity_mismatch");
    return { child, witness, closed };
  } catch (cause) {
    // The caller must retain this handle on an unknown launch; never respawn it.
    const error = new Error(safeCode(cause) === "spawn_failed_retained" ? "spawn_failed_retained" : "spawn_identity_failed_retained");
    Object.defineProperty(error, "retained", { value: { child, closed, pid: child.pid }, enumerable: false });
    throw error;
  }
}

export async function stopOwned(entry, { timeoutMs = 45000 } = {}) {
  need(entry && typeof entry === "object", "owned_process_invalid");
  const { witness, child, closed } = entry;
  need(validWitness(witness) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000, "owned_process_invalid");
  const ownedChild = child !== undefined;
  need(!ownedChild || child && child.pid === witness.pid && closed && typeof closed.then === "function", "owned_process_invalid");
  // Install the close observer before checking native state, even if the child has
  // already exited. A PID probe is never substituted for the accepted child's close.
  let childClosed = !ownedChild, childClose = null, childCloseFailed = false;
  if (ownedChild) void Promise.resolve(closed).then(value => {
    if (!value || !own(value, "code") || !own(value, "signal")) childCloseFailed = true;
    else childClose = { code: value.code, signal: value.signal };
    childClosed = true;
  }, () => { childClosed = true; childCloseFailed = true; });
  const deadline = performance.now() + timeoutMs;
  let signalRequested = false;
  if (!await processAbsent(witness)) {
    let stillPresent = true;
    try { await sameProcess(witness); }
    catch (error) { if (await processAbsent(witness)) stillPresent = false; else throw error; }
    if (stillPresent) {
      try { process.kill(witness.pid, "SIGTERM"); signalRequested = true; }
      catch (error) { if (error?.code !== "ESRCH") fail("process_signal_failed_retained"); }
    }
  }
  for (;;) {
    const absent = await processAbsent(witness), processGroupAbsent = groupGone(witness.pgid);
    if (absent && processGroupAbsent && childClosed) {
      need(!childCloseFailed && (!ownedChild || childClose
        && (childClose.code === 0 && childClose.signal === null || childClose.code === null && childClose.signal === "SIGTERM")), "owned_process_close_failed_retained");
      return { schema: "local-environment-process-stop-v1", witness, signalRequested, signal: signalRequested ? "SIGTERM" : null,
        processAbsent: true, processGroupAbsent: true, originalChildProcessCloseObserved: ownedChild,
        childClose, observedAt: new Date().toISOString() };
    }
    need(performance.now() < deadline, "process_stop_timeout_retained");
    await pause(Math.min(100, Math.max(1, deadline - performance.now())));
  }
}
