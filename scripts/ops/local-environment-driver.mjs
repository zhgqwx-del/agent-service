import { randomBytes } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  assertListener, pinFile, processAbsent, processIdentity, readPrivateJson,
  safeCode as nativeSafeCode, sameProcess, spawnOwned, stopOwned, writePrivateJson,
} from "./local-environment-native.mjs";
import { assertEnvironmentPortUnbound, assertLocalEnvironmentBootContextUnchanged, bootContextAllowsAbsentController, bootContextAllowsPreviousEntry,
  loadLocalEnvironmentBootContext, sameBootIdentity } from "./local-environment-boot.mjs";

export const LOCAL_ENVIRONMENT_ACTIONS = Object.freeze([
  "start-services", "stop-services", "restart-services",
  "start-infrastructure", "stop-infrastructure", "restart-infrastructure",
]);
const NAMES = Object.freeze(["router", "runner", "mysql", "redis"]);
const DISPLAY = Object.freeze({ owner: "本地管理器", router: "Router", runner: "Runner", mysql: "MySQL", redis: "Redis" });
const HEX64 = /^[a-f0-9]{64}$/;
const SAFE = new Set([
  "environment_profile_invalid", "environment_profile_changed", "environment_directory_changed",
  "environment_file_changed", "environment_abandoned_owner_present", "environment_ledger_invalid",
  "environment_ledger_changed", "environment_persistence_failed_retained", "environment_owner_unknown",
  "environment_action_invalid", "environment_action_disabled", "environment_action_busy",
  "environment_hook_required", "environment_hook_failed_retained", "environment_not_idle",
  "environment_idle_unknown", "environment_process_unknown", "environment_readiness_failed_retained",
  "environment_start_failed_retained", "environment_stop_failed_retained", "environment_generation_failed_retained",
  "environment_boot_proof_invalid", "environment_boot_identity_unavailable", "environment_boot_enrollment_required",
  "environment_boot_recovery_required", "environment_boot_host_changed", "environment_boot_unsettled",
  "environment_boot_bindings_changed", "environment_boot_data_changed", "environment_boot_port_in_use",
]);
const need = (condition, code) => { if (!condition) throw new Error(code); };
const safe = error => SAFE.has(error?.message) ? error.message : nativeSafeCode(error);
const token = () => randomBytes(16).toString("hex");
const now = () => new Date().toISOString();
const samePin = (a, b) => a?.path === b?.path && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha256 === b.sha256;
const absolute = path => typeof path === "string" && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const directoryIdentity = stat => [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
const isPin = value => value && absolute(value.path) && [value.dev, value.ino, value.size].every(Number.isSafeInteger)
  && value.dev >= 0 && value.ino > 0 && value.size > 0 && HEX64.test(value.sha256);
const isWitness = value => value && Number.isSafeInteger(value.pid) && value.pid > 1
  && Number.isSafeInteger(value.pgid) && value.pgid > 1 && value.uid === process.getuid?.()
  && typeof value.started === "string" && value.started.length > 0 && isPin(value.executable);
const isStringMap = value => value && typeof value === "object" && !Array.isArray(value)
  && Object.entries(value).every(([key, text]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof text === "string" && !text.includes("\0"));
const failed = code => new Error(SAFE.has(code) || nativeSafeCode(new Error(code)) === code ? code : "environment_process_unknown");

/** Pure UI capability calculation; a fresh perform() always checks again. */
export function capabilities(snapshot) {
  const rows = Object.fromEntries((snapshot?.components ?? []).map(row => [row.id, row]));
  const allKnown = rows.owner?.state === "ready" && NAMES.every(name => ["ready", "stopped"].includes(rows[name]?.state));
  const servicesStopped = ["router", "runner"].every(name => rows[name]?.state === "stopped");
  const servicesReady = ["router", "runner"].every(name => rows[name]?.state === "ready");
  const infrastructureStopped = ["mysql", "redis"].every(name => rows[name]?.state === "stopped");
  const infrastructureReady = ["mysql", "redis"].every(name => rows[name]?.state === "ready");
  const allowed = {
    "start-services": infrastructureReady && !servicesReady,
    "stop-services": !servicesStopped,
    "restart-services": infrastructureReady && !servicesStopped,
    "start-infrastructure": servicesStopped && !infrastructureReady,
    "stop-infrastructure": servicesStopped && !infrastructureStopped,
    "restart-infrastructure": servicesStopped && !infrastructureStopped,
  };
  return Object.fromEntries(LOCAL_ENVIRONMENT_ACTIONS.map(action => {
    let reason = "";
    if (snapshot?.busy) reason = "已有环境操作正在执行";
    else if (!allKnown) reason = "环境身份或上次操作未确认";
    else if (action.endsWith("infrastructure") && !servicesStopped) reason = "请先停止 Router 和 Runner";
    else if (["start-services", "restart-services"].includes(action) && !infrastructureReady) reason = "请先启动 MySQL 和 Redis";
    else if (!allowed[action]) reason = action.startsWith("start-") ? "目标已经启动" : "目标已经停止";
    return [action, { enabled: reason === "", reason }];
  }));
}

async function observedDirectory(path, expected, privateOnly = false) {
  need(absolute(path), "environment_profile_invalid");
  const stat = await lstat(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path
    && (!privateOnly || stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o700)
    && (expected === undefined || directoryIdentity(stat) === expected), "environment_directory_changed");
  return directoryIdentity(stat);
}

function validateProfile(profile) {
  need(profile && profile.schema === "local-environment-profile-v1"
    && absolute(profile.stateDirectory) && absolute(profile.originalState) && profile.stateDirectory !== profile.originalState
    && isPin(profile.node) && /^[a-f0-9]{40}$/.test(profile.acceptedCommit), "environment_profile_invalid");
  need(Array.isArray(profile.files) && profile.files.length > 0 && profile.files.length <= 10000
    && profile.files.every(file => absolute(file.path) && HEX64.test(file.sha256))
    && new Set(profile.files.map(file => file.path)).size === profile.files.length, "environment_profile_invalid");
  need(Array.isArray(profile.directories) && profile.directories.length > 0
    && profile.directories.every(item => absolute(item.path) && /^\d+:\d+:\d+:\d+$/.test(item.identity))
    && new Set(profile.directories.map(item => item.path)).size === profile.directories.length, "environment_profile_invalid");
  need(Array.isArray(profile.abandonedControllers) && profile.abandonedControllers.length > 0
    && profile.abandonedControllers.every(isWitness), "environment_profile_invalid");
  need(profile.roles && profile.infrastructure, "environment_profile_invalid");
  for (const name of NAMES) {
    const entry = ["router", "runner"].includes(name) ? profile.roles[name] : profile.infrastructure[name];
    need(entry && isWitness(entry.witness) && isPin(entry.executable) && samePin(entry.witness.executable, entry.executable)
      && absolute(entry.cwd) && Array.isArray(entry.args) && entry.args.every(arg => typeof arg === "string" && !arg.includes("\0"))
      && isStringMap(entry.env) && Number.isSafeInteger(entry.port) && entry.port > 0 && entry.port <= 65535,
    "environment_profile_invalid");
    if (["router", "runner"].includes(name)) need(samePin(entry.executable, profile.node), "environment_profile_invalid");
  }
  need(new Set(NAMES.map(name => (profile.roles[name] ?? profile.infrastructure[name]).port)).size === NAMES.length, "environment_profile_invalid");
  need(typeof profile.infrastructure.mysql.uuid === "string" && profile.infrastructure.mysql.uuid.length > 0
    && /^[a-f0-9]{40}$/.test(profile.infrastructure.redis.runId), "environment_profile_invalid");
  if (profile.releaseBindings !== undefined) {
    need(Array.isArray(profile.releaseBindings) && profile.releaseBindings.length === 2
      && profile.releaseBindings.every(binding => ["agent-router", "agent-runner"].includes(binding.role)
        && absolute(binding.directory) && HEX64.test(binding.manifestSha256))
      && new Set(profile.releaseBindings.map(binding => binding.role)).size === 2, "environment_profile_invalid");
  }
}

export async function createLocalEnvironmentDriver({ profilePath }) {
  need(absolute(profilePath), "environment_profile_invalid");
  const selected = await readPrivateJson(profilePath, 16 * 1024 * 1024);
  const profile = selected.value;
  validateProfile(profile);
  const profileSha256 = selected.sha256;
  const configs = Object.fromEntries(NAMES.map(name => [name, profile.roles[name] ?? profile.infrastructure[name]]));
  const stateDirectoryIdentity = await observedDirectory(profile.stateDirectory, undefined, true);
  const ledgerPath = join(profile.stateDirectory, "processes.json");
  const owner = await processIdentity(process.pid, profile.node);
  let ownerFault = null, busy = null, ledgerSha256 = null, infrastructureGeneration = null, activeOperation = null;
  let persistenceTail = Promise.resolve();
  const hooks = {};
  const entries = {};
  let loadedLedger = null;
  try { await lstat(ledgerPath); loadedLedger = await readPrivateJson(ledgerPath, 16 * 1024 * 1024); }
  catch (error) { if (error?.code !== "ENOENT") throw failed("environment_ledger_invalid"); }
  const bootContext = await loadLocalEnvironmentBootContext({ profilePath, profileSha256, profile,
    ledger: loadedLedger?.value ?? null, ledgerSha256: loadedLedger?.sha256 ?? null });
  need(loadedLedger !== null || bootContext.enrollmentSha256 === null, "environment_ledger_invalid");

  async function verifyBindings() {
    need((await readPrivateJson(profilePath, 16 * 1024 * 1024)).sha256 === profileSha256, "environment_profile_changed");
    await observedDirectory(profile.stateDirectory, stateDirectoryIdentity, true);
    await observedDirectory(profile.originalState);
    await assertLocalEnvironmentBootContextUnchanged(bootContext);
    for (const item of profile.directories) await observedDirectory(item.path, item.identity);
    need(samePin(await pinFile(profile.node.path), profile.node), "environment_file_changed");
    for (const file of profile.files) need((await pinFile(file.path)).sha256 === file.sha256, "environment_file_changed");
    for (const name of NAMES) {
      need(samePin(await pinFile(configs[name].executable.path), configs[name].executable), "environment_file_changed");
      await observedDirectory(configs[name].cwd);
    }
    for (const controller of profile.abandonedControllers) {
      // A certified previous-boot PID may now belong to an unrelated process.
      if (!bootContextAllowsAbsentController(bootContext, controller)) {
        need(await processAbsent(controller), "environment_abandoned_owner_present");
      }
    }
    await sameProcess(owner);
  }
  await verifyBindings();

  function serialEntry(entry) {
    return { state: entry.state, witness: entry.witness, attemptId: entry.attemptId ?? null,
      launchOwner: entry.launchOwner ?? null, lastClose: entry.lastClose ?? null,
      runId: entry.runId ?? null, uuid: entry.uuid ?? null,
      unknownSpawnPid: entry.unknownSpawnPid ?? null, lastStop: entry.lastStop ?? null, failure: entry.failure ?? null,
      ...(entry.witnessBoot ? { witnessBoot: entry.witnessBoot } : {}),
      ...(entry.previousBootAbsence ? { previousBootAbsence: entry.previousBootAbsence } : {}) };
  }
  function serialLedger() {
    return { schema: "local-environment-processes-v1", profilePath, profileSha256, originalState: profile.originalState,
      stateDirectory: profile.stateDirectory, owner, acceptedCommit: profile.acceptedCommit, updatedAt: now(),
      failure: ownerFault, activeOperation, infrastructureGeneration,
      ...(bootContext.enrollmentSha256 ? { bootIdentity: bootContext.currentBoot, bootRecovery: bootContext.recovery } : {}),
      entries: Object.fromEntries(NAMES.map(name => [name, serialEntry(entries[name])])) };
  }
  async function assertLedgerUnchanged() {
    need(ledgerSha256 !== null && (await readPrivateJson(ledgerPath, 16 * 1024 * 1024)).sha256 === ledgerSha256, "environment_ledger_changed");
  }
  function persist({ createOnly = false } = {}) {
    const task = persistenceTail.then(async () => {
      try {
        if (!createOnly) await assertLedgerUnchanged();
        const result = await writePrivateJson(ledgerPath, serialLedger(), { createOnly });
        ledgerSha256 = result.sha256;
      } catch {
        ownerFault = "environment_persistence_failed_retained";
        throw new Error(ownerFault);
      }
    });
    persistenceTail = task.catch(() => {});
    return task;
  }

  if (loadedLedger) {
    const loaded = loadedLedger, ledger = loaded.value;
    need(ledger?.schema === "local-environment-processes-v1" && ledger.profileSha256 === profileSha256
      && ledger.profilePath === profilePath && ledger.originalState === profile.originalState
      && ledger.stateDirectory === profile.stateDirectory && ledger.acceptedCommit === profile.acceptedCommit && isWitness(ledger.owner),
    "environment_ledger_invalid");
    if (!bootContext.crossBoot) {
      if (ledger.owner.pid === owner.pid) {
        need(ledger.owner.pgid === owner.pgid && ledger.owner.uid === owner.uid
          && ledger.owner.started === owner.started && samePin(ledger.owner.executable, owner.executable),
        "environment_abandoned_owner_present");
      } else need(await processAbsent(ledger.owner), "environment_abandoned_owner_present");
    }
    if (ledger.failure != null) {
      need(SAFE.has(ledger.failure), "environment_ledger_invalid");
      ownerFault = ledger.failure;
    }
    if (ledger.activeOperation != null) {
      need(typeof ledger.activeOperation.id === "string" && /^[a-f0-9]{32}$/.test(ledger.activeOperation.id)
        && LOCAL_ENVIRONMENT_ACTIONS.includes(ledger.activeOperation.action), "environment_ledger_invalid");
      activeOperation = ledger.activeOperation;
      ownerFault = "environment_process_unknown";
    }
    for (const name of NAMES) {
      const entry = ledger.entries?.[name];
      need(entry && ["observed", "starting", "ready", "stopping", "stopped", "unknown"].includes(entry.state)
        && isWitness(entry.witness) && samePin(entry.witness.executable, configs[name].executable), "environment_ledger_invalid");
      entries[name] = { ...entry, child: undefined, closed: undefined, orphan: true };
      if (bootContext.enrollmentSha256) {
        entries[name].witnessBoot ??= ledger.bootIdentity ?? bootContext.abandonedBoot;
        if (bootContext.crossBoot) {
          entries[name].state = "stopped";
          entries[name].previousBootAbsence = { schema: "local-environment-previous-boot-absence-v1",
            receiptSha256: bootContext.receipt.sha256, originalChildProcessCloseObserved: false };
        } else if (!sameBootIdentity(entries[name].witnessBoot, bootContext.currentBoot)) {
          need(bootContextAllowsPreviousEntry(bootContext, name, entries[name]), "environment_boot_proof_invalid");
        }
      }
      if (name === "redis") need(/^[a-f0-9]{40}$/.test(entry.runId), "environment_ledger_invalid");
      if (name === "mysql") need(entry.uuid === configs.mysql.uuid, "environment_ledger_invalid");
      // An interrupted launch/stop cannot be completed by interpreting stale PIDs.
      if (["starting", "stopping"].includes(entry.state)) {
        entries[name].state = "unknown";
        entries[name].failure = "environment_process_unknown";
      }
    }
    infrastructureGeneration = ledger.infrastructureGeneration ?? null;
    if (infrastructureGeneration !== null) need(Number.isSafeInteger(infrastructureGeneration.sequence)
      && infrastructureGeneration.sequence > 0 && HEX64.test(infrastructureGeneration.receiptSha256), "environment_ledger_invalid");
    const generationFiles = (await readdir(profile.stateDirectory)).filter(name => /^infrastructure-generation-\d{6}\.json$/.test(name)).sort();
    need(generationFiles.length === (infrastructureGeneration?.sequence ?? 0), "environment_ledger_invalid");
    let previousReceiptSha256 = null;
    for (let i = 0; i < generationFiles.length; i++) {
      need(generationFiles[i] === "infrastructure-generation-" + String(i + 1).padStart(6, "0") + ".json", "environment_ledger_invalid");
      const receipt = await readPrivateJson(join(profile.stateDirectory, generationFiles[i]), 16 * 1024 * 1024);
      need(receipt.value?.schema === "local-environment-infrastructure-generation-v1" && receipt.value.sequence === i + 1
        && receipt.value.profileSha256 === profileSha256 && receipt.value.previousReceiptSha256 === previousReceiptSha256,
      "environment_ledger_invalid");
      previousReceiptSha256 = receipt.sha256;
    }
    need(previousReceiptSha256 === (infrastructureGeneration?.receiptSha256 ?? null), "environment_ledger_invalid");
    ledgerSha256 = loaded.sha256;
    await persist();
  } else {
    for (const name of NAMES) entries[name] = { state: "observed", witness: configs[name].witness, orphan: true,
      ...(name === "redis" ? { runId: configs.redis.runId } : {}), ...(name === "mysql" ? { uuid: configs.mysql.uuid } : {}) };
    await persist({ createOnly: true });
  }

  function hookEntry(name) {
    const entry = entries[name];
    return { ...structuredClone(configs[name]), name, witness: structuredClone(entry.witness),
      state: entry.state, child: entry.child, closed: entry.closed, orphan: entry.orphan,
      ...(name === "redis" ? { runId: entry.runId } : {}), ...(name === "mysql" ? { uuid: entry.uuid } : {}),
      launchOwner: entry.launchOwner, lastStop: entry.lastStop, lastClose: entry.lastClose };
  }
  const hookEntries = async () => {
    // The four components are independent. Keep each probe's native witness /
    // listener / witness sequence intact, with at most four probes in flight.
    return Object.fromEntries(await Promise.all(NAMES.map(async name => {
      const entry = hookEntry(name), observed = await probe(name);
      return [name, { ...entry, state: observed.state, code: observed.code ?? null }];
    })));
  };
  async function runHook(name, ...args) {
    need(typeof hooks[name] === "function", "environment_hook_required");
    try { return await hooks[name](...args); }
    catch (error) { throw failed(SAFE.has(error?.message) ? error.message : "environment_hook_failed_retained"); }
  }
  async function probe(name) {
    const entry = entries[name], result = { id: name, name: DISPLAY[name], state: "unknown", port: configs[name].port,
      pid: entry.witness?.pid, originalChildProcessCloseObserved: Boolean(entry.child && entry.lastClose) };
    if (entry.state === "unknown" || ["starting", "stopping"].includes(entry.state)) return { ...result, code: entry.failure ?? "environment_process_unknown" };
    try {
      if (entry.witnessBoot && !sameBootIdentity(entry.witnessBoot, bootContext.currentBoot)) {
        need(bootContextAllowsPreviousEntry(bootContext, name, entry), "environment_boot_proof_invalid");
        await assertEnvironmentPortUnbound(configs[name].port);
        return { ...result, pid: undefined, state: "stopped", previousBoot: true, originalChildProcessCloseObserved: false };
      }
      if (await processAbsent(entry.witness)) {
        if (entry.child && entry.state !== "stopped") return { ...result, code: "environment_process_unknown" };
        return { ...result, state: "stopped" };
      }
      need(entry.state !== "stopped", "environment_process_unknown");
      await assertListener(configs[name].port, entry.witness.pid);
      await sameProcess(entry.witness);
      return { ...result, state: "ready" };
    } catch (error) { return { ...result, code: safe(error) }; }
  }
  async function snapshot() {
    let ownerState = "ready", ownerCode = ownerFault;
    try {
      need(!ownerFault, "environment_owner_unknown");
      await assertLedgerUnchanged();
      need((await readPrivateJson(profilePath, 16 * 1024 * 1024)).sha256 === profileSha256, "environment_profile_changed");
      await sameProcess(owner);
    } catch (error) { ownerState = "unknown"; ownerCode ??= safe(error); }
    const components = [{ id: "owner", name: DISPLAY.owner, state: ownerState, pid: owner.pid, ...(ownerCode ? { code: ownerCode } : {}) }];
    // Component errors remain attached to their own row; concurrency is bounded
    // by this fixed four-component profile and preserves each probe's ordering.
    components.push(...await Promise.all(NAMES.map(name => probe(name))));
    if (!busy && typeof hooks.observe === "function") {
      const observed = await hooks.observe(Object.fromEntries(NAMES.map(name => [name, {
        ...hookEntry(name), state: components.find(row => row.id === name).state,
      }]))).catch(() => ({}));
      for (const row of components.slice(1)) if (row.state === "ready" && observed[row.id] !== true) row.state = "unknown";
    }
    const states = components.slice(1).map(row => row.state);
    const overall = ownerState === "unknown" || states.includes("unknown") ? "unknown"
      : states.every(state => state === "ready") ? "ready" : states.every(state => state === "stopped") ? "stopped" : "partial";
    return { overall, components, busy: busy?.action ?? null };
  }
  async function idleAfterSnapshot(observed) {
    const rows = Object.fromEntries(observed.components.map(row => [row.id, row]));
    if (rows.owner.state !== "ready" || observed.overall === "unknown") return false;
    if (["router", "runner", "mysql"].every(name => rows[name].state === "stopped")) return true;
    try {
      // Observe hooks may take time. Retain the independent native recheck after
      // them rather than treating snapshot readiness as authority for this hook.
      const current = await hookEntries();
      const changed = NAMES.filter(name => current[name].state === "unknown" || current[name].state !== rows[name].state);
      if (changed.length > 0) {
        // Chat admission also consumes the returned snapshot. Publish native
        // drift there, not solely as idle=false (which can mean ordinary work).
        for (const name of changed) Object.assign(rows[name], { state: "unknown", code: current[name].code ?? "environment_process_unknown" });
        observed.overall = "unknown";
        return false;
      }
      return await runHook("checkIdle", current) === true;
    }
    catch { return false; }
  }
  async function inspect() {
    // One invocation owns one display snapshot and its idle check. No result is
    // retained for another request, perform(), or a shutdown boundary.
    const observed = await snapshot();
    return { snapshot: observed, idle: await idleAfterSnapshot(observed) };
  }
  async function checkIdle() { return (await inspect()).idle; }
  async function requireIdle() { need(await checkIdle(), "environment_not_idle"); }
  async function phase(value) {
    if (busy?.phase) {
      try { await busy.phase(value); } catch { throw failed("environment_hook_failed_retained"); }
    }
  }

  async function startOne(name) {
    const observed = await probe(name);
    if (observed.state === "ready") return;
    need(observed.state === "stopped", "environment_process_unknown");
    await phase("starting-" + name);
    const entry = entries[name];
    entry.state = "starting"; entry.attemptId = token(); entry.failure = null; entry.lastClose = null;
    await persist(); // Intent precedes spawn; interrupted intents remain unknown.
    try {
      const launched = await spawnOwned({ executable: configs[name].executable, args: configs[name].args,
        cwd: configs[name].cwd, env: configs[name].env,
        logPath: join(profile.stateDirectory, name + "-" + entry.attemptId + ".log") });
      entry.child = launched.child; entry.closed = launched.closed; entry.witness = launched.witness;
      if (bootContext.enrollmentSha256) entry.witnessBoot = bootContext.currentBoot;
      entry.previousBootAbsence = null;
      entry.orphan = false; entry.launchOwner = owner;
      void launched.closed.then(result => {
        entry.lastClose = result;
        if (!["stopping", "stopped"].includes(entry.state)) {
          entry.state = "unknown"; entry.failure = "environment_process_unknown";
        }
        void persist().catch(() => {});
      }, () => {
        entry.state = "unknown"; entry.failure = "environment_process_unknown";
        void persist().catch(() => {});
      });
      await persist();
      await runHook("ready", name, hookEntry(name));
      need(entry.state === "starting" && !entry.lastClose, "environment_readiness_failed_retained");
      await assertListener(configs[name].port, entry.witness.pid);
      await sameProcess(entry.witness);
      entry.state = "ready";
      await persist();
    } catch (error) {
      if (error?.retained) {
        entry.child = error.retained.child; entry.closed = error.retained.closed;
        entry.unknownSpawnPid = error.retained.pid;
      }
      entry.state = "unknown"; entry.failure = safe(error);
      await persist();
      throw failed("environment_start_failed_retained");
    }
  }
  async function stopOne(name, infrastructure = false) {
    const observed = await probe(name);
    if (observed.state === "stopped") return;
    need(observed.state === "ready", "environment_process_unknown");
    await phase("stopping-" + name);
    const entry = entries[name];
    if (!infrastructure) await requireIdle();
    entry.state = "stopping"; entry.failure = null;
    await persist();
    try {
      await sameProcess(entry.witness);
      if (infrastructure) await runHook("beforeInfrastructureStop", name, hookEntry(name));
      const receipt = await stopOwned({ witness: entry.witness, ...(entry.child ? { child: entry.child, closed: entry.closed } : {}) });
      entry.state = "stopped"; entry.lastStop = receipt;
      await persist();
    } catch (error) {
      entry.state = "unknown"; entry.failure = safe(error);
      await persist();
      throw failed("environment_stop_failed_retained");
    }
  }
  async function stopServices() {
    await requireIdle();
    await stopOne("router");
    // Freeze ingress first, then independently check that no work entered during it.
    await requireIdle();
    await stopOne("runner");
  }
  async function startServices() {
    const mysql = await probe("mysql"), redis = await probe("redis");
    need(mysql.state === "ready" && redis.state === "ready", "environment_action_disabled");
    await startOne("runner");
    await startOne("router");
  }
  async function requireServicesStopped() {
    need((await probe("router")).state === "stopped" && (await probe("runner")).state === "stopped", "environment_action_disabled");
  }
  async function stopInfrastructure() {
    await requireServicesStopped();
    await stopOne("redis", true);
    await stopOne("mysql", true);
  }
  async function startInfrastructure() {
    await requireServicesStopped();
    try {
      await startOne("mysql");
      await startOne("redis");
      const identity = await runHook("afterInfrastructureStart", await hookEntries());
      need(identity && typeof identity === "object" && identity.redis && /^[a-f0-9]{40}$/.test(identity.redis.runId), "environment_generation_failed_retained");
      entries.redis.runId = identity.redis.runId;
      const sequence = (infrastructureGeneration?.sequence ?? 0) + 1;
      need(sequence <= 999999, "environment_generation_failed_retained");
      const path = join(profile.stateDirectory, "infrastructure-generation-" + String(sequence).padStart(6, "0") + ".json");
      const receipt = { schema: "local-environment-infrastructure-generation-v1", sequence, profileSha256,
        originalState: profile.originalState, acceptedCommit: profile.acceptedCommit, previousReceiptSha256: infrastructureGeneration?.receiptSha256 ?? null,
        processes: Object.fromEntries(["mysql", "redis"].map(name => [name, { witness: entries[name].witness,
          ...(name === "redis" ? { runId: entries.redis.runId } : { uuid: entries.mysql.uuid }), lastStop: entries[name].lastStop ?? null }])),
        observedAt: now(), modelCalls: 0, dataInitialized: false, ddlExecuted: false, oldRecordsChanged: false };
      const written = await writePrivateJson(path, receipt, { createOnly: true });
      infrastructureGeneration = { sequence, receiptSha256: written.sha256, path };
      await persist();
    } catch {
      ownerFault = "environment_generation_failed_retained";
      await persist();
      throw failed(ownerFault);
    }
  }
  async function perform(action, { phase: phaseCallback, operation } = {}) {
    need(LOCAL_ENVIRONMENT_ACTIONS.includes(action), "environment_action_invalid");
    need(phaseCallback === undefined || typeof phaseCallback === "function", "environment_action_invalid");
    need(!busy, "environment_action_busy");
    busy = { action, id: token(), phase: phaseCallback, operation };
    let outcome = "failed", code = null;
    try {
      need(!ownerFault, "environment_owner_unknown");
      await phase("verifying-environment");
      await verifyBindings();
      await assertLedgerUnchanged();
      const observed = await snapshot();
      need(capabilities({ ...observed, busy: null })[action].enabled, "environment_action_disabled");
      await runHook("beforeAction", action, await hookEntries());
      // Required hooks are checked before any intent, spawn, signal, or DB mutation.
      const required = ["ready", "checkIdle", ...(action.endsWith("infrastructure") ? ["beforeInfrastructureStop", "afterInfrastructureStart"] : [])];
      need(required.every(name => typeof hooks[name] === "function"), "environment_hook_required");
      activeOperation = { action, id: busy.id };
      await persist();
      if (action === "start-services") await startServices();
      else if (action === "stop-services") await stopServices();
      else if (action === "restart-services") { await stopServices(); await startServices(); }
      else if (action === "start-infrastructure") await startInfrastructure();
      else if (action === "stop-infrastructure") await stopInfrastructure();
      else { await stopInfrastructure(); await startInfrastructure(); }
      activeOperation = null;
      await persist();
      outcome = "completed";
    } catch (error) {
      code = safe(error);
      // This controller still holds every accepted handle; known partial states
      // may be inspected. A crash before this settlement leaves the intent held.
      activeOperation = null;
      try { await persist(); } catch { code = "environment_persistence_failed_retained"; }
    }
    const actionRecord = busy;
    try {
      await writePrivateJson(join(profile.stateDirectory, "action-" + actionRecord.id + ".json"), {
        schema: "local-environment-action-v1", action, id: actionRecord.id, outcome, code, profileSha256,
        acceptedCommit: profile.acceptedCommit, observedAt: now(), dataRetained: true, modelCalls: 0,
      }, { createOnly: true });
    } catch {
      ownerFault = "environment_persistence_failed_retained"; code = ownerFault; outcome = "failed";
      try { await persist(); } catch { /* The held failure remains visible in this controller. */ }
    }
    finally { busy = null; }
    if (outcome !== "completed") throw failed(code ?? "environment_process_unknown");
    return await snapshot();
  }
  function setHooks(next) {
    need(next && typeof next === "object" && !Array.isArray(next)
      && Object.entries(next).every(([name, callback]) => ["observe", "beforeAction", "checkIdle", "ready", "beforeInfrastructureStop", "afterInfrastructureStart"].includes(name)
        && typeof callback === "function"), "environment_hook_required");
    Object.assign(hooks, next);
  }
  function setIdleProbe(callback) { setHooks({ checkIdle: callback }); }
  function detach() { need(!busy, "environment_action_busy"); for (const entry of Object.values(entries)) entry.child?.unref(); }
  return { snapshot, inspect, capabilities, checkIdle, perform, setHooks, setIdleProbe, detach };
}
