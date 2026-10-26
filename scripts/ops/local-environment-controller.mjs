import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

// This controller admits a closed set of local actions. The independently bound
// driver owns native identity, shutdown ordering and persistence of service data.
export const ENVIRONMENT_ACTIONS = Object.freeze([
  "start-services", "stop-services", "restart-services",
  "start-infrastructure", "stop-infrastructure", "restart-infrastructure",
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PHASE = /^[a-z][a-z0-9_-]{0,79}$/;
const COMPONENT_NAMES = Object.freeze({ owner: "OWNER 管理器", router: "Router", runner: "Runner", mysql: "MySQL", redis: "Redis" });
const STATES = ["ready", "running", "stopped", "unknown", "starting", "stopping", "failed"];
const DETAIL = Object.freeze({ ready: "状态与身份已核对", running: "正在运行", stopped: "已停止，保留原有数据", unknown: "状态尚未核实", starting: "正在启动", stopping: "正在安全停止", failed: "状态检查未通过，保留现场" });
const OVERALL = ["ready", "stopped", "partial", "unknown"];
const OPERATION_STATES = ["running", "succeeded", "failed", "unknown"];
const MAX_JOURNAL_BYTES = 1_048_576;
const copy = value => structuredClone(value);
const now = () => new Date().toISOString();

export class EnvironmentControlError extends Error {
  constructor(code, status = 409) { super(code); this.name = "EnvironmentControlError"; this.code = code; this.status = status; }
}
function fail(code, status) { throw new EnvironmentControlError(code, status); }
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === "string" && names.includes(key) && descriptor?.enumerable && Object.hasOwn(descriptor, "value");
  });
}
function actionInput(value) {
  if (!fields(value, ["action", "idempotencyKey"]) || !ENVIRONMENT_ACTIONS.includes(value.action)
    || typeof value.idempotencyKey !== "string" || !UUID.test(value.idempotencyKey)) fail("environment_action_invalid", 400);
  return { action: value.action, idempotencyKey: value.idempotencyKey.toLowerCase() };
}
function operationMessage(state) {
  return { running: "操作已接受，正在安全执行。", succeeded: "操作已完成，原有数据保留。",
    failed: "操作未完成，请保留现场并核对状态。", unknown: "原操作结果待核对，暂不接受新操作。" }[state];
}
function publicOperation(operation) {
  if (!operation) return null;
  return { ...copy(operation), message: operationMessage(operation.state) };
}
function publicComponents(input) {
  const rows = Array.isArray(input) ? input : [];
  return Object.entries(COMPONENT_NAMES).map(([id, name]) => {
    const row = rows.find(item => item && item.id === id), state = STATES.includes(row?.state) ? row.state : "unknown";
    const result = { id, name, state, detail: DETAIL[state] };
    if (Number.isSafeInteger(row?.pid) && row.pid > 1) result.pid = row.pid;
    if (typeof row?.endpoint === "string" && /^(?:http:\/\/)?127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(row.endpoint)) {
      const port = Number(row.endpoint.replace(/^http:\/\//, "").replace(/\/$/, "").split(":")[1]);
      if (port <= 65_535) result.endpoint = row.endpoint;
    }
    return result;
  });
}
function fileIdentity(stat) { return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
async function privateDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail("environment_journal_invalid", 503);
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
async function readJournal(path) {
  const parent = await privateDirectory(dirname(path));
  let before;
  try { before = await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.nlink !== 1
    || (before.mode & 0o7777) !== 0o600 || before.size > MAX_JOURNAL_BYTES || await realpath(path) !== path) fail("environment_journal_invalid", 503);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await file.stat();
    if (fileIdentity(first) !== fileIdentity(before)) fail("environment_journal_invalid", 503);
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length > MAX_JOURNAL_BYTES || bytes.length !== after.size || fileIdentity(first) !== fileIdentity(after)
      || fileIdentity(after) !== fileIdentity(await lstat(path)) || parent !== await privateDirectory(dirname(path))
      || !bytes.equals(Buffer.from(bytes.toString("utf8")))) fail("environment_journal_invalid", 503);
    return JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
}
async function writeJournal(path, value) {
  const parent = await privateDirectory(dirname(path));
  await readJournal(path); // Refuse a public, replaced, linked or oversized existing file.
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > MAX_JOURNAL_BYTES) fail("environment_journal_unavailable", 503);
  const temporary = join(dirname(path), `.environment-${randomBytes(16).toString("hex")}.next`);
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (parent !== await privateDirectory(dirname(path))) fail("environment_journal_invalid", 503);
    await rename(temporary, path); created = false;
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { if (created) await unlink(temporary).catch(() => {}); }
}
function restoredJournal(value) {
  if (!fields(value, ["schema", "currentId", "operations"]) || value.schema !== "local-environment-journal-v1"
    || !Array.isArray(value.operations) || !(value.currentId === null || typeof value.currentId === "string")) fail("environment_journal_invalid", 503);
  const operations = new Map();
  for (const operation of value.operations) {
    if (!fields(operation, ["id", "action", "state", "phase", "startedAt", "finishedAt", "error"])
      || typeof operation.id !== "string" || !UUID.test(operation.id) || operation.id !== operation.id.toLowerCase()
      || operations.has(operation.id) || !ENVIRONMENT_ACTIONS.includes(operation.action) || !OPERATION_STATES.includes(operation.state)
      || typeof operation.phase !== "string" || !PHASE.test(operation.phase)
      || typeof operation.startedAt !== "string" || !Number.isFinite(Date.parse(operation.startedAt))
      || !(operation.finishedAt === null || typeof operation.finishedAt === "string" && Number.isFinite(Date.parse(operation.finishedAt)))
      || ![null, "environment_operation_failed", "environment_operation_unknown", "environment_journal_unavailable"].includes(operation.error)) fail("environment_journal_invalid", 503);
    operations.set(operation.id, copy(operation));
  }
  if (value.currentId !== null && !operations.has(value.currentId)
    || [...operations.values()].some(operation => ["running", "unknown"].includes(operation.state) && operation.id !== value.currentId)) fail("environment_journal_invalid", 503);
  return { operations, currentId: value.currentId };
}

/** A journal reload never repeats a native action or treats a historical PID as authority. */
export async function createEnvironmentController({ driver, journalPath = null } = {}) {
  if (!driver || ["snapshot", "checkIdle", "perform"].some(method => typeof driver[method] !== "function")
    || !(journalPath === null || typeof journalPath === "string" && isAbsolute(journalPath) && resolve(journalPath) === journalPath
      && !/[\u0000-\u001f\u007f]/.test(journalPath))) fail("environment_controller_invalid", 400);
  let operations = new Map(), currentId = null, closed = false, admitting = false, journalFailed = false;
  let worker = Promise.resolve(), journalTail = Promise.resolve();
  const pendingAdmissions = new Map();
  const current = () => currentId === null ? null : operations.get(currentId);
  const blocked = () => closed || journalFailed || ["running", "unknown"].includes(current()?.state);
  const persist = () => {
    if (journalPath === null) return Promise.resolve();
    const value = { schema: "local-environment-journal-v1", currentId, operations: [...operations.values()].map(copy) };
    const task = journalTail.then(() => writeJournal(journalPath, value));
    journalTail = task.catch(() => { journalFailed = true; });
    return task;
  };
  try {
    if (journalPath !== null) {
      const saved = await readJournal(journalPath);
      if (saved !== null) ({ operations, currentId } = restoredJournal(saved));
      if (current()?.state === "running") {
        Object.assign(current(), { state: "unknown", error: "environment_operation_unknown" });
        await persist();
      }
    }
  } catch { fail("environment_journal_invalid", 503); }

  async function inspect(ownAdmission = false) {
    let snapshot, idle = false, capabilities;
    try {
      snapshot = await driver.snapshot();
      if (!snapshot || typeof snapshot !== "object" || !OVERALL.includes(snapshot.overall)) throw new Error();
      if (!blocked()) {
        idle = await driver.checkIdle() === true;
        if (typeof driver.capabilities === "function") capabilities = await driver.capabilities(snapshot);
      }
    } catch { snapshot = { overall: "unknown", components: [] }; idle = false; }
    const components = publicComponents(snapshot.components);
    const ownerReady = components.some(item => item.id === "owner" && ["ready", "running"].includes(item.state));
    const unavailable = !ownerReady || snapshot.overall === "unknown" || components.some(item => ["unknown", "failed"].includes(item.state));
    const actions = ENVIRONMENT_ACTIONS.map(id => {
      const selected = Array.isArray(capabilities) ? capabilities.find(item => item?.id === id) : capabilities?.[id];
      const permitted = capabilities === undefined || selected === true || selected?.enabled === true;
      const enabled = !blocked() && (!admitting || ownAdmission) && !unavailable && idle && permitted;
      const reason = enabled ? "" : closed ? "本机管理连接已关闭" : journalFailed ? "操作记录待核对，请保留现场"
        : current()?.state === "unknown" ? "原操作结果待核对，请保留现场" : current()?.state === "running" || admitting ? "请等待当前操作完成"
          : unavailable ? "OWNER 管理链尚未就绪" : !idle ? "仍有任务运行或无法确认空闲" : "当前状态不允许此操作";
      return { id, enabled, reason };
    });
    return { enabled: true, checkedAt: now(), overall: current()?.state === "running" ? "transitioning"
      : journalFailed || current()?.state === "unknown" ? "unknown" : snapshot.overall, components, actions, operation: publicOperation(current()) };
  }

  async function execute(operation) {
    const phase = async message => {
      if (typeof message !== "string" || !PHASE.test(message)) fail("environment_phase_invalid", 500);
      if (operation.state !== "running") fail("environment_operation_inactive", 409);
      operation.phase = message;
      await persist();
    };
    try {
      // Recheck idle after durable acceptance and immediately before native work.
      if (await driver.checkIdle() !== true) fail("environment_action_blocked", 409);
      await driver.perform(operation.action, { phase, operation: publicOperation(operation) });
      if (journalFailed) throw new Error();
      Object.assign(operation, { state: "succeeded", phase: "completed", finishedAt: now(), error: null });
    } catch {
      Object.assign(operation, { state: "failed", finishedAt: now(), error: "environment_operation_failed" });
    }
    try { await persist(); }
    catch { Object.assign(operation, { state: "unknown", error: "environment_journal_unavailable" }); }
  }

  async function act(input) {
    const { action, idempotencyKey } = actionInput(input);
    const known = operations.get(idempotencyKey);
    if (known) {
      if (known.action !== action) return Promise.reject(new EnvironmentControlError("environment_idempotency_conflict", 409));
      return Promise.resolve({ operation: publicOperation(known) });
    }
    const pending = pendingAdmissions.get(idempotencyKey);
    if (pending) {
      if (pending.action !== action) return Promise.reject(new EnvironmentControlError("environment_idempotency_conflict", 409));
      return pending.promise.then(copy);
    }
    if (blocked() || admitting) return Promise.reject(new EnvironmentControlError("environment_operation_conflict", 409));
    admitting = true;
    const promise = (async () => {
      // The exclusive admission may inspect its own capability; public status
      // keeps buttons disabled until acceptance or rejection has completed.
      const snapshot = await inspect(true);
      const available = snapshot.actions.find(item => item.id === action);
      if (!available?.enabled || blocked()) fail("environment_action_blocked", 409);
      const operation = { id: idempotencyKey, action, state: "running", phase: "accepted", startedAt: now(), finishedAt: null, error: null };
      operations.set(operation.id, operation); currentId = operation.id;
      try { await persist(); }
      catch {
        Object.assign(operation, { state: "unknown", error: "environment_journal_unavailable" });
        fail("environment_journal_unavailable", 503);
      }
      const result = { operation: publicOperation(operation) };
      worker = Promise.resolve().then(() => execute(operation));
      return result;
    })().catch(error => {
      if (error instanceof EnvironmentControlError) throw error;
      fail("environment_action_blocked", 409);
    }).finally(() => { admitting = false; pendingAdmissions.delete(idempotencyKey); });
    pendingAdmissions.set(idempotencyKey, { action, promise });
    return promise.then(copy);
  }
  return Object.freeze({ status: () => inspect(), act, async close() { closed = true; await Promise.allSettled([...pendingAdmissions.values()].map(item => item.promise)); await worker; await journalTail; } });
}
