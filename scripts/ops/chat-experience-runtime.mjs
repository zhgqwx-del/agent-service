import { mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureServicesReady, assertExperiencePortFree, experienceFailure, privateExperienceDirectory,
  readExperienceBindings, safeExperienceCode, validBootIdentity, verifyExperienceH5,
  assertExperienceStartupAllowed } from "./chat-experience.mjs";
import { processIdentity, readPrivateJson, sameProcess, writePrivateJson } from "./local-environment-native.mjs";
import { connectEnvironmentController, runEnvironmentOwner } from "./local-environment-owner.mjs";
import { createChatH5Server } from "./chat-h5.mjs";

// The same ordering is used by the detached runtime and the finite fake-server
// tests: the test page is published only after the existing environment is ready.
export async function runExperienceStartup({ controller, startH5, recordPhase = async () => {},
  recordAction = async () => {}, pause, pollIntervalMs, timeoutMs, shouldCancel = () => false }) {
  if (typeof startH5 !== "function" || typeof recordPhase !== "function") {
    throw new Error("chat_experience_config_invalid");
  }
  assertExperienceStartupAllowed(shouldCancel);
  await recordPhase("checking_environment");
  const status = await ensureServicesReady(controller, { recordAction, pause, pollIntervalMs, timeoutMs, shouldCancel });
  assertExperienceStartupAllowed(shouldCancel);
  await recordPhase("starting_h5");
  assertExperienceStartupAllowed(shouldCancel);
  const h5 = await startH5();
  assertExperienceStartupAllowed(shouldCancel);
  await recordPhase("ready");
  assertExperienceStartupAllowed(shouldCancel);
  return { h5, status };
}

export async function runChatExperienceRuntime({ requestPath }, dependencies = {}) {
  process.umask(0o077);
  const selected = await readPrivateJson(requestPath), request = selected.value;
  if (request?.schema !== "chat-experience-attempt-v1" || request.attemptDirectory !== dirname(requestPath)
    || typeof request.attemptId !== "string" || !validBootIdentity(request.bootIdentity)) {
    throw experienceFailure("chat_experience_config_invalid");
  }
  const attemptDirectory = request.attemptDirectory;
  await privateExperienceDirectory(attemptDirectory);
  const binding = await readExperienceBindings(request.configPath), { config } = binding;
  if (binding.launchSha256 !== request.launchSha256 || binding.profileSha256 !== request.profileSha256
    || binding.clientSha256 !== request.clientSha256 || dirname(attemptDirectory) !== config.stateDirectory
    || attemptDirectory !== join(config.stateDirectory, "attempt-" + request.attemptId)) {
    throw experienceFailure("chat_experience_bindings_changed");
  }
  const { readLocalBootIdentity, prepareLocalEnvironmentBootRecovery } = await import("./local-environment-boot.mjs");
  const bootIdentity = await (dependencies.readBootIdentity ?? readLocalBootIdentity)();
  if (JSON.stringify(bootIdentity) !== JSON.stringify(request.bootIdentity)) throw experienceFailure("chat_experience_boot_unavailable");
  const pending = (await readPrivateJson(join(config.stateDirectory, "pending.json"))).value;
  if (pending?.schema !== "chat-experience-pending-v1" || pending.requestPath !== requestPath
    || pending.attemptDirectory !== attemptDirectory || pending.state !== "intent") throw experienceFailure("chat_experience_unknown_retained");
  const runtime = await processIdentity(process.pid, binding.profile.node);
  // A failed start retains this process and every accepted child handle. There
  // is no retry or implicit signal in the failure path; evidence remains local.
  const keepAlive = setInterval(() => {}, 60000);
  let ownerApplication, h5, closing = false, resultWritten = false, committed = false;
  let releaseStartup;
  const startupSettled = new Promise(done => { releaseStartup = done; });
  let closePromise;
  const shouldCancel = () => !committed && (closing || dependencies.shouldCancel?.() === true);
  const assertAllowed = () => assertExperienceStartupAllowed(shouldCancel);
  let phase = "checking_bindings", controlConfigPath, owner;
  const recordPhase = async value => {
    assertAllowed();
    phase = value;
    await writePrivateJson(join(attemptDirectory, "phase.json"), { schema: "chat-experience-phase-v1", phase,
      bootIdentity, at: new Date().toISOString() });
    assertAllowed();
  };
  const close = () => {
    closing = true;
    closePromise ??= (async () => {
      // An accepted action settles before resource cleanup. Resources returned
      // after the signal are included; none can escape a previous close() call.
      await startupSettled;
      await h5?.close();
      await ownerApplication?.close();
      clearInterval(keepAlive);
      process.off("SIGINT", signalClose); process.off("SIGTERM", signalClose);
    })();
    return closePromise;
  };
  const signalClose = () => { void close().catch(() => { process.stderr.write("chat_experience_close_failed_retained\n"); }); };
  process.once("SIGINT", signalClose); process.once("SIGTERM", signalClose);
  try {
    assertAllowed();
    await assertExperiencePortFree(config.port);
    assertAllowed();
    let controller;
    if (request.existingControlConfigPath !== null) {
      controlConfigPath = request.existingControlConfigPath;
      const control = (await readPrivateJson(controlConfigPath)).value;
      if (JSON.stringify(control.owner) !== JSON.stringify(request.existingOwner)) throw experienceFailure("chat_experience_bindings_changed");
      await sameProcess(control.owner); owner = control.owner;
      controller = await connectEnvironmentController(controlConfigPath);
      assertAllowed();
    } else {
      await recordPhase("checking_boot_recovery");
      await (dependencies.prepareBoot ?? prepareLocalEnvironmentBootRecovery)({ profilePath: config.profilePath });
      assertAllowed();
      await recordPhase("starting_owner");
      // A fresh short private directory keeps Unix socket length bounded and
      // preserves every former control lock/socket as historical evidence.
      const controlDirectory = await mkdtemp(join(config.controlParentDirectory, "agent-chat-"));
      await privateExperienceDirectory(controlDirectory);
      if (Buffer.byteLength(join(controlDirectory, "owner.sock")) >= 100) throw experienceFailure("chat_experience_config_invalid");
      controlConfigPath = join(attemptDirectory, "control.json");
      assertAllowed();
      ownerApplication = await (dependencies.runOwner ?? runEnvironmentOwner)({ profilePath: config.profilePath,
        clientPath: controlConfigPath, controlDirectory, handleSignals: false });
      assertAllowed();
      const control = (await readPrivateJson(controlConfigPath)).value;
      owner = control.owner;
      if (JSON.stringify(owner) !== JSON.stringify(runtime)) throw experienceFailure("chat_experience_bindings_changed");
      controller = ownerApplication.controller;
    }
    const started = await runExperienceStartup({ controller, recordPhase, shouldCancel,
      recordAction: action => writePrivateJson(join(attemptDirectory, "action-" + action.idempotencyKey + ".json"), action),
      startH5: async () => {
        assertAllowed();
        await assertExperiencePortFree(config.port);
        assertAllowed();
        h5 = await (dependencies.startH5 ?? createChatH5Server)({ configPath: config.clientConfigPath,
          port: config.port, environmentController: controller });
        assertAllowed();
        await verifyExperienceH5({ witness: runtime, port: config.port, client: binding.client, owner });
        assertAllowed();
        return h5;
      } });
    const receipt = { schema: "chat-experience-ready-v1", launchSha256: binding.launchSha256,
      profileSha256: binding.profileSha256, clientSha256: binding.clientSha256, bootIdentity,
      controlConfigPath, owner, h5: runtime, port: config.port, attemptDirectory,
      url: started.h5.url, readyAt: new Date().toISOString(), modelCalls: 0, dataRetained: true };
    assertAllowed();
    // Readiness commits after all startup work and cancellation guards. A later
    // signal is ordinary daemon shutdown and waits for publication to settle.
    committed = true;
    await writePrivateJson(join(attemptDirectory, "result.json"), { state: "ready", receipt }, { createOnly: true });
    resultWritten = true;
    return { close, receipt };
  } catch (error) {
    if (!resultWritten) await writePrivateJson(join(attemptDirectory, "result.json"), {
      state: "failed", code: safeExperienceCode(error), phase, runtime, bootIdentity, at: new Date().toISOString(),
      originalRecordsRetained: true, dataRetained: true, modelCalls: 0,
    }, { createOnly: true }).catch(() => {});
    // Returning a retained handle is useful to finite tests, while the CLI keeps
    // the same process alive for explicit review instead of orphaning children.
    Object.defineProperty(error, "retainedRuntime", { value: { close, runtime, ownerApplication, h5 }, enumerable: false });
    throw error;
  } finally {
    releaseStartup();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--request") throw experienceFailure("chat_experience_config_invalid");
    await runChatExperienceRuntime({ requestPath: process.argv[3] });
  } catch (error) { process.stderr.write(safeExperienceCode(error) + "\n"); process.exitCode = 1; }
}
