import { randomUUID, createHash } from "node:crypto";
import { lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pauseDefault } from "node:timers/promises";
import { createServer } from "node:net";
import { assertListener, pinFile, processAbsent, readPrivateJson,
  sameProcess, spawnOwned, writePrivateJson } from "./local-environment-native.mjs";
import { connectEnvironmentController } from "./local-environment-owner.mjs";

// Explicit local launcher. It never reads .env, submits a turn, initializes data,
// replaces old OWNER evidence, takes over a port, or installs login/startup jobs.
const CONFIG_KEYS = ["schema", "profilePath", "clientConfigPath", "initialControlConfigPath",
  "stateDirectory", "port", "controlParentDirectory"];
const ROLES = ["router", "runner"], INFRA = ["mysql", "redis"];
const NOW = () => new Date().toISOString();
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const samePin = (a, b) => a?.path === b?.path && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha256 === b.sha256;
const SAFE_CODES = new Set(["chat_experience_config_invalid", "chat_experience_bindings_changed",
  "chat_experience_state_invalid", "chat_experience_start_in_progress", "chat_experience_unknown_retained",
  "chat_experience_port_in_use", "chat_experience_owner_unavailable", "chat_experience_environment_unknown",
  "chat_experience_action_blocked", "chat_experience_action_failed_retained", "chat_experience_action_timeout_retained",
  "chat_experience_h5_unavailable", "chat_experience_start_failed_retained", "chat_experience_start_cancelled_retained",
  "chat_experience_boot_unavailable"]);
export const experienceFailure = code => { const error = new Error(code); error.code = code; return error; };
const need = (value, code) => { if (!value) throw experienceFailure(code); };
const absolute = value => typeof value === "string" && isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
const isRecord = value => value && typeof value === "object" && !Array.isArray(value);
export const safeExperienceCode = error => SAFE_CODES.has(error?.code ?? error?.message)
  ? error.code ?? error.message : "chat_experience_start_failed_retained";
export function assertExperienceStartupAllowed(shouldCancel = () => false) {
  need(typeof shouldCancel === "function", "chat_experience_config_invalid");
  need(shouldCancel() !== true, "chat_experience_start_cancelled_retained");
}

export function validateLaunchConfig(value) {
  need(isRecord(value) && Object.keys(value).length === CONFIG_KEYS.length && CONFIG_KEYS.every(key => Object.hasOwn(value, key))
    && value.schema === "chat-experience-launch-v1" && ["profilePath", "clientConfigPath", "initialControlConfigPath", "stateDirectory"]
      .every(key => absolute(value[key])) && absolute(value.controlParentDirectory)
    && Buffer.byteLength(join(value.controlParentDirectory, "agent-chat-XXXXXX", "owner.sock")) < 100
    && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535,
  "chat_experience_config_invalid");
  need(new Set([value.profilePath, value.clientConfigPath, value.initialControlConfigPath]).size === 3
    && ![value.profilePath, value.clientConfigPath, value.initialControlConfigPath].includes(value.stateDirectory), "chat_experience_config_invalid");
  return value;
}

function knownEnvironment(status) {
  need(isRecord(status) && status.enabled === true && ["ready", "partial", "stopped"].includes(status.overall)
    && Array.isArray(status.components) && Array.isArray(status.actions), "chat_experience_environment_unknown");
  const names = ["owner", ...ROLES, ...INFRA], rows = Object.fromEntries(status.components.map(row => [row?.id, row]));
  need(names.every(name => rows[name]) && rows.owner.state === "ready"
    && [...ROLES, ...INFRA].every(name => ["ready", "stopped"].includes(rows[name].state)), "chat_experience_environment_unknown");
  need(status.operation == null || status.operation.state === "succeeded", "chat_experience_unknown_retained");
  return rows;
}

export async function ensureServicesReady(controller, { recordAction = async () => {}, pause = pauseDefault,
  pollIntervalMs = 250, timeoutMs = 120000, shouldCancel = () => false } = {}) {
  need(controller && typeof controller.status === "function" && typeof controller.act === "function"
    && typeof recordAction === "function" && typeof pause === "function"
    && Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
  "chat_experience_config_invalid");
  assertExperienceStartupAllowed(shouldCancel);
  let status = await controller.status();
  for (const [action, targets] of [["start-infrastructure", INFRA], ["start-services", ROLES]]) {
    assertExperienceStartupAllowed(shouldCancel);
    const rows = knownEnvironment(status);
    if (targets.every(name => rows[name].state === "ready")) continue;
    need(status.actions.find(item => item?.id === action)?.enabled === true, "chat_experience_action_blocked");
    const idempotencyKey = randomUUID();
    // A lost acceptance or timeout remains an explicit unresolved intent. It is
    // never converted into another key or repeated act() invocation.
    await recordAction({ action, idempotencyKey, state: "intent", at: NOW() });
    assertExperienceStartupAllowed(shouldCancel);
    const accepted = await controller.act({ action, idempotencyKey });
    need(accepted?.operation?.id === idempotencyKey && accepted.operation.action === action
      && ["running", "succeeded"].includes(accepted.operation.state), "chat_experience_unknown_retained");
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      status = await controller.status();
      const operation = status?.operation;
      need(operation?.id === idempotencyKey && operation.action === action, "chat_experience_unknown_retained");
      if (operation.state === "succeeded") break;
      need(operation.state === "running", "chat_experience_action_failed_retained");
      need(performance.now() < deadline, "chat_experience_action_timeout_retained");
      await pause(pollIntervalMs);
    }
    await recordAction({ action, idempotencyKey, state: "succeeded", at: NOW() });
    // Cancellation after acceptance still observes the exact operation to its
    // terminal state. It prevents the next action, never interrupts native work.
    assertExperienceStartupAllowed(shouldCancel);
    need(targets.every(name => knownEnvironment(status)[name].state === "ready"), "chat_experience_environment_unknown");
  }
  assertExperienceStartupAllowed(shouldCancel);
  need([...ROLES, ...INFRA].every(name => knownEnvironment(status)[name].state === "ready") && status.overall === "ready",
    "chat_experience_environment_unknown");
  return status;
}

export async function privateExperienceDirectory(path) {
  need(absolute(path), "chat_experience_config_invalid");
  const stat = await lstat(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && (stat.mode & 0o7777) === 0o700 && await realpath(path) === path, "chat_experience_config_invalid");
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}

export async function verifyExperienceControlParent(path) {
  need(absolute(path), "chat_experience_config_invalid");
  const stat = await lstat(path);
  need(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path
    && [0, process.getuid?.()].includes(stat.uid)
    && (!(stat.mode & 0o022) || (stat.mode & 0o1000) !== 0), "chat_experience_config_invalid");
}

async function optionalPrivate(path) {
  try { await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  return await readPrivateJson(path, 16 * 1024 * 1024);
}

export async function assertExperiencePortFree(port) {
  // This is only a refusal probe. The eventual bind must still succeed itself;
  // no listener, PID or process group is ever stopped to obtain this port.
  await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", () => reject(experienceFailure("chat_experience_port_in_use")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(error =>
      error ? reject(experienceFailure("chat_experience_port_in_use")) : done()));
  });
}

async function getJson(url, token) {
  const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
    ...(token ? { headers: { "X-Chat-Token": token } } : {}) });
  need(response.status === 200, "chat_experience_h5_unavailable");
  const reader = response.body?.getReader();
  need(reader, "chat_experience_h5_unavailable");
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length; need(size <= 65536, "chat_experience_h5_unavailable"); chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw experienceFailure("chat_experience_h5_unavailable"); }
}

export async function verifyExperienceH5({ witness, port, client, owner }, { requireReady = true } = {}) {
  await sameProcess(witness); await assertListener(port, witness.pid); await sameProcess(witness);
  const origin = "http://127.0.0.1:" + port;
  const config = await getJson(origin + "/api/config");
  need(config.baseUrl === client.baseUrl && config.userId === client.userId && config.agentId === client.agentId
    && config.agentVersion === client.agentVersion && typeof config.csrfToken === "string" && /^[a-f0-9]{64}$/.test(config.csrfToken),
  "chat_experience_h5_unavailable");
  const environment = await getJson(origin + "/api/environment", config.csrfToken);
  need(environment?.enabled === true && environment.components?.find(row => row.id === "owner")?.pid === owner.pid,
    "chat_experience_h5_unavailable");
  if (requireReady) {
    need(environment.overall === "ready" && ["owner", ...ROLES, ...INFRA]
      .every(name => environment.components.find(row => row.id === name)?.state === "ready")
      && (await getJson(origin + "/api/health", config.csrfToken)).ready === true, "chat_experience_h5_unavailable");
  }
  await sameProcess(witness); await assertListener(port, witness.pid);
  return { url: origin + "/" };
}

export async function readExperienceBindings(configPath) {
  const selected = await readPrivateJson(configPath);
  const config = validateLaunchConfig(selected.value);
  await privateExperienceDirectory(config.stateDirectory);
  await verifyExperienceControlParent(config.controlParentDirectory);
  const profile = await readPrivateJson(config.profilePath, 16 * 1024 * 1024);
  const client = await readPrivateJson(config.clientConfigPath);
  const { parseHttpExperienceConfig } = await import("./http-experience.mjs");
  const clientConfig = parseHttpExperienceConfig(JSON.stringify(client.value));
  need(profile.value?.schema === "local-environment-profile-v1" && absolute(profile.value.node?.path), "chat_experience_config_invalid");
  need(samePin(await pinFile(profile.value.node.path), profile.value.node), "chat_experience_bindings_changed");
  return { config, launchSha256: selected.sha256, profile: profile.value, profileSha256: profile.sha256,
    client: clientConfig, clientSha256: client.sha256 };
}

function validateReceipt(receipt, binding) {
  need(isRecord(receipt) && ["chat-experience-registration-v1", "chat-experience-ready-v1"].includes(receipt.schema)
    && receipt.launchSha256 === binding.launchSha256 && receipt.profileSha256 === binding.profileSha256
    && receipt.clientSha256 === binding.clientSha256 && receipt.port === binding.config.port
    && absolute(receipt.controlConfigPath) && validBootIdentity(receipt.bootIdentity)
    && isRecord(receipt.owner) && isRecord(receipt.h5)
    && samePin(receipt.owner.executable, binding.profile.node) && samePin(receipt.h5.executable, binding.profile.node),
  "chat_experience_state_invalid");
  return receipt;
}

async function reusableReceipt(binding, bootIdentity) {
  const { config } = binding;
  const saved = await optionalPrivate(join(config.stateDirectory, "current.json"))
    ?? await optionalPrivate(join(config.stateDirectory, "registration.json"));
  if (saved === null) return null;
  const receipt = validateReceipt(saved.value, binding);
  if (receipt.schema === "chat-experience-registration-v1") need(receipt.controlConfigPath === config.initialControlConfigPath,
    "chat_experience_bindings_changed");
  if (!sameJson(receipt.bootIdentity, bootIdentity)) return null;
  // A dead same-boot process can be deliberately restored only when the separate
  // driver proves its journal settled. Reused PIDs fail instead of being absent.
  const ownerAbsent = await processAbsent(receipt.owner), h5Absent = await processAbsent(receipt.h5);
  if (ownerAbsent || h5Absent) {
    need(!ownerAbsent || h5Absent, "chat_experience_unknown_retained");
    if (ownerAbsent) return null;
  }
  await sameProcess(receipt.owner);
  const control = await readPrivateJson(receipt.controlConfigPath);
  need(sameJson(control.value.owner, receipt.owner), "chat_experience_bindings_changed");
  if (!h5Absent) await verifyExperienceH5({ witness: receipt.h5, port: config.port, client: binding.client, owner: receipt.owner }, { requireReady: false });
  const controller = await connectEnvironmentController(receipt.controlConfigPath);
  return { receipt, controller, h5Present: !h5Absent };
}

export function validBootIdentity(value) {
  return isRecord(value) && value.schema === "local-environment-boot-identity-v1"
    && ["darwin", "linux"].includes(value.platform) && Number.isSafeInteger(value.uid) && value.uid >= 0
    && /^[a-f0-9]{64}$/.test(value.hostSha256) && typeof value.bootId === "string" && value.bootId.length > 0 && value.bootId.length <= 256;
}

export async function startChatExperience({ configPath }, dependencies = {}) {
  process.umask(0o077);
  const binding = await readExperienceBindings(configPath), { config } = binding;
  const bootIdentity = await (dependencies.readBootIdentity ?? readBootIdentityDefault)();
  need(validBootIdentity(bootIdentity), "chat_experience_boot_unavailable");
  const bootKey = createHash("sha256").update(JSON.stringify(bootIdentity)).digest("hex").slice(0, 24);
  const lockPath = join(config.stateDirectory, "start-" + bootKey + ".lock");
  let locked = false;
  try { await mkdir(lockPath, { mode: 0o700 }); locked = true; }
  catch (error) { if (error?.code === "EEXIST") throw experienceFailure("chat_experience_start_in_progress"); throw error; }
  const lockIdentity = await privateExperienceDirectory(lockPath);
  let settled = false, unknownEffects = false;
  try {
    await writePrivateJson(join(lockPath, "intent.json"), { schema: "chat-experience-invocation-v1", bootIdentity,
      launchSha256: binding.launchSha256, at: NOW(), pid: process.pid }, { createOnly: true });
    const pending = await optionalPrivate(join(config.stateDirectory, "pending.json"));
    need(pending === null || pending.value?.schema === "chat-experience-pending-v1" && pending.value.state === "ready",
      "chat_experience_unknown_retained");
    const reused = await reusableReceipt(binding, bootIdentity);
    if (reused?.h5Present) {
      unknownEffects = true;
      let recordedAction = false;
      await ensureServicesReady(reused.controller, { recordAction: async value => {
        await writePrivateJson(join(lockPath, "action.json"), value);
        if (value.state === "intent") {
          recordedAction = true;
          await writePrivateJson(join(config.stateDirectory, "pending.json"), { schema: "chat-experience-pending-v1",
            kind: "existing-owner-action", bootIdentity, invocationDirectory: lockPath, action: value, state: "intent", at: NOW() });
        }
      } });
      const result = await verifyExperienceH5({ witness: reused.receipt.h5, port: config.port, client: binding.client,
        owner: reused.receipt.owner });
      if (recordedAction) await writePrivateJson(join(config.stateDirectory, "pending.json"), {
        schema: "chat-experience-pending-v1", kind: "existing-owner-action", bootIdentity,
        invocationDirectory: lockPath, state: "ready", at: NOW() });
      settled = true; return { ...result, reused: true, controlConfigPath: reused.receipt.controlConfigPath };
    }
    await assertExperiencePortFree(config.port);
    const attemptId = randomUUID(), attemptDirectory = join(config.stateDirectory, "attempt-" + attemptId);
    await mkdir(attemptDirectory, { mode: 0o700 }); await privateExperienceDirectory(attemptDirectory);
    const requestPath = join(attemptDirectory, "request.json");
    await writePrivateJson(requestPath, { schema: "chat-experience-attempt-v1", configPath,
      launchSha256: binding.launchSha256, profileSha256: binding.profileSha256, clientSha256: binding.clientSha256,
      attemptId, attemptDirectory, bootIdentity, existingControlConfigPath: reused?.receipt.controlConfigPath ?? null,
      existingOwner: reused?.receipt.owner ?? null, at: NOW() }, { createOnly: true });
    unknownEffects = true;
    await writePrivateJson(join(config.stateDirectory, "pending.json"), { schema: "chat-experience-pending-v1",
      attemptDirectory, requestPath, bootIdentity, state: "intent", at: NOW() });
    const runtimePath = fileURLToPath(new URL("./chat-experience-runtime.mjs", import.meta.url));
    let launched;
    try {
      launched = await (dependencies.spawnRuntime ?? spawnOwned)({ executable: binding.profile.node, args: [runtimePath, "--request", requestPath],
        cwd: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, logPath: join(attemptDirectory, "runtime.log") });
    } catch (error) {
      // The retained child is intentionally detached; the next invocation sees
      // the unresolved pending intent and cannot repeat this launch.
      error.retained?.child?.unref(); throw error;
    }
    await writePrivateJson(join(attemptDirectory, "runtime.json"), { schema: "chat-experience-runtime-v1",
      bootIdentity, witness: launched.witness, at: NOW() }, { createOnly: true });
    launched.child.unref();
    const deadline = performance.now() + 180000;
    for (;;) {
      const result = await optionalPrivate(join(attemptDirectory, "result.json"));
      if (result) {
        need(result.value?.state === "ready", "chat_experience_start_failed_retained");
        const ready = validateReceipt(result.value.receipt, binding);
        need(sameJson(ready.bootIdentity, bootIdentity) && sameJson(ready.h5, launched.witness),
          "chat_experience_bindings_changed");
        const verified = await verifyExperienceH5({ witness: ready.h5, port: config.port, client: binding.client, owner: ready.owner });
        await writePrivateJson(join(config.stateDirectory, "current.json"), ready);
        await writePrivateJson(join(config.stateDirectory, "pending.json"), { schema: "chat-experience-pending-v1",
          attemptDirectory, requestPath, bootIdentity, state: "ready", at: NOW() });
        settled = true; return { ...verified, reused: false, controlConfigPath: ready.controlConfigPath };
      }
      need(!await processAbsent(launched.witness) && performance.now() < deadline, "chat_experience_start_failed_retained");
      await pauseDefault(250);
    }
  } finally {
    // Only a fully verified successful invocation removes its own transient lock.
    // An interruption/failure keeps both the lock and startup intent for review.
    if (locked && (settled || !unknownEffects) && await privateExperienceDirectory(lockPath) === lockIdentity) {
      const action = join(lockPath, "action.json");
      if (await optionalPrivate(action)) await unlink(action);
      await unlink(join(lockPath, "intent.json")); await rmdir(lockPath);
    }
  }
}

async function readBootIdentityDefault() {
  const { readLocalBootIdentity } = await import("./local-environment-boot.mjs");
  return await readLocalBootIdentity();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("pnpm experience:up [--config /ABS/private/launch.json]\n"
      + "Manually restore the registered local OWNER, existing database/services and H5 after reboot.\n"
      + "No login startup job, .env discovery, model calls, initialization, migration, upgrade or data reset.\n"); return;
  }
  need(args.length === 0 || args.length === 2 && args[0] === "--config" && absolute(args[1]), "chat_experience_config_invalid");
  const result = await startChatExperience({ configPath: args[1] ?? resolve(".local-run/chat-experience/launch.json") });
  process.stdout.write("Chat H5: " + result.url + "\n" + (result.reused ? "已复用当前测试环境。\n" : "测试环境已启动，原数据保留。\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) { process.stderr.write(safeExperienceCode(error) + "\n"); process.exitCode = 1; }
}
