import { createServer, createConnection } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, open, chmod, unlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPrivateJson, writePrivateJson, processIdentity, sameProcess } from "./local-environment-native.mjs";

// Explicit, local development supervisor. The private socket and profile never
// come from browser input. Disconnecting the H5 client does not stop its children.
const fail = (code, status = 503) => { const e = new Error(code); e.code = code; e.status = status; throw e; };
const CODES = new Set(["invalid_action", "invalid_idempotency_key", "operation_conflict", "idempotency_conflict",
  "environment_not_ready", "environment_unavailable", "journal_unavailable", "controller_closed"]);
const CORE_CODES = Object.freeze({ environment_action_invalid: "invalid_action",
  environment_idempotency_conflict: "idempotency_conflict", environment_operation_conflict: "operation_conflict",
  environment_action_blocked: "environment_not_ready", environment_journal_unavailable: "journal_unavailable" });
const safeError = e => { const code = CORE_CODES[e?.code] ?? e?.code;
  return { error: CODES.has(code) ? code : "environment_unavailable",
    status: CODES.has(code) && [400, 409, 503].includes(e?.status) ? e.status : 503 }; };

export async function connectEnvironmentController(configPath) {
  const { value: config } = await readPrivateJson(configPath);
  if (config.schema !== "local-environment-client-v1" || typeof config.socketPath !== "string"
    || !/^[a-f0-9]{64}$/.test(config.token)) fail("environment_unavailable");
  async function call(method, input) {
    try { await sameProcess(config.owner); } catch { fail("environment_unavailable"); }
    return await new Promise((done, reject) => {
      const socket = createConnection(config.socketPath); let data = "", settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : done(result); };
      socket.setTimeout(30_000, () => finish(Object.assign(new Error("environment_unavailable"), { code: "environment_unavailable", status: 503 })));
      socket.on("error", () => finish(Object.assign(new Error("environment_unavailable"), { code: "environment_unavailable", status: 503 })));
      socket.on("end", () => { if (!settled) finish(Object.assign(new Error("environment_unavailable"), { code: "environment_unavailable", status: 503 })); });
      socket.on("connect", () => socket.write(JSON.stringify({ token: config.token, method, ...(input ? { input } : {}) }) + "\n"));
      socket.on("data", chunk => {
        data += chunk.toString("utf8");
        if (data.length > 65536) return finish(Object.assign(new Error("environment_unavailable"), { code: "environment_unavailable", status: 503 }));
        if (!data.includes("\n")) return;
        try { const result = JSON.parse(data.trim());
          if (result.error) { const safe = safeError({ code: result.error, status: result.status });
            finish(Object.assign(new Error(safe.error), { code: safe.error, status: safe.status })); }
          else finish(null, result.result);
        } catch { finish(Object.assign(new Error("environment_unavailable"), { code: "environment_unavailable", status: 503 })); }
      });
    });
  }
  return { status: () => call("status"), act: input => call("act", input), close: async () => {} };
}

export async function runEnvironmentOwner({ profilePath, clientPath, controlDirectory, driverFactory, hooksFactory, handleSignals = true }) {
  process.umask(0o077);
  if (typeof handleSignals !== "boolean") fail("environment_unavailable");
  const { value: profile } = await readPrivateJson(profilePath);
  const control = controlDirectory ?? profile.controlDirectory, stat = await lstat(control);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(control) !== control
    || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) fail("environment_unavailable");
  // A retained lock requires a separate, explicit recovery review. No stale-lock deletion.
  const lockPath = join(control, "owner.lock"), lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n"); await lock.sync(); await lock.close();
  const lockStat = await lstat(lockPath);
  const { createLocalEnvironmentDriver } = await import("./local-environment-driver.mjs");
  const { createLocalEnvironmentHooks } = await import("./local-environment-health.mjs");
  const { createEnvironmentController } = await import("./local-environment-controller.mjs");
  const driver = await (driverFactory ?? createLocalEnvironmentDriver)({ profilePath });
  driver.setHooks(await (hooksFactory ?? createLocalEnvironmentHooks)(profile));
  const controller = await createEnvironmentController({ driver, journalPath: join(profile.stateDirectory, "operations.json") });
  const token = randomBytes(32).toString("hex"), socketPath = join(control, "owner.sock");
  const server = createServer(socket => {
    let data = "", used = false;
    socket.setTimeout(35_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      if (used) return; data += chunk.toString("utf8");
      if (data.length > 4096) { used = true; socket.destroy(); return; }
      if (!data.includes("\n")) return; used = true;
      void (async () => {
        let request; try { request = JSON.parse(data.trim()); } catch { fail("environment_unavailable"); }
        if (typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token)
          || !timingSafeEqual(Buffer.from(token), Buffer.from(request.token))) fail("environment_unavailable");
        if (request.method === "status" && Object.keys(request).length === 2) return controller.status();
        if (request.method === "act" && Object.keys(request).length === 3 && request.input
          && Object.keys(request.input).length === 2 && Object.hasOwn(request.input, "action")
          && Object.hasOwn(request.input, "idempotencyKey")) return controller.act(request.input);
        fail("invalid_action", 400);
      })().then(result => socket.end(JSON.stringify({ result }) + "\n"), error => socket.end(JSON.stringify(safeError(error)) + "\n"));
    });
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(socketPath, done); });
  await chmod(socketPath, 0o600);
  const owner = await processIdentity(process.pid, profile.node);
  const socketStat = await lstat(socketPath);
  const recordPath = join(profile.stateDirectory, "owner-" + process.pid + "-" + randomBytes(8).toString("hex") + ".json");
  try {
    await writePrivateJson(clientPath, { schema: "local-environment-client-v1", socketPath, token, owner }, { createOnly: true });
    await writePrivateJson(recordPath, { schema: "local-environment-owner-v1", owner,
      profilePath, clientPath, originalRecordsRetained: true, modelCalls: 0 }, { createOnly: true });
  } catch {
    await controller.close();
    const beforeClose = await lstat(socketPath);
    if (beforeClose.dev !== socketStat.dev || beforeClose.ino !== socketStat.ino) fail("environment_unavailable");
    await new Promise(done => server.close(done));
    // Publication failed: preserve the lock/socket and all evidence for review.
    fail("environment_unavailable");
  }
  process.stdout.write("local_environment_owner_ready\n");
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    // Ending this control process never implicitly stops or restarts services/data.
    await controller.close();
    const beforeClose = await lstat(socketPath);
    if (beforeClose.dev !== socketStat.dev || beforeClose.ino !== socketStat.ino) fail("environment_unavailable");
    await new Promise(done => server.close(done));
    for (const [path, before] of [[socketPath, socketStat], [lockPath, lockStat]]) {
      let actual; try { actual = await lstat(path); } catch (error) {
        if (path === socketPath && error.code === "ENOENT") continue; throw error;
      }
      if (actual.dev !== before.dev || actual.ino !== before.ino || actual.uid !== before.uid) fail("environment_unavailable");
      await unlink(path);
    }
    driver.detach();
    if (handleSignals) { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
  };
  const stop = () => { void close().catch(() => { process.stderr.write("local_environment_owner_close_failed_retained\n"); process.exitCode = 1; }); };
  if (handleSignals) { process.once("SIGTERM", stop); process.once("SIGINT", stop); }
  return { controller, driver, close, recordPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 2 && args[0] === "--status") {
      const client = await connectEnvironmentController(args[1]);
      process.stdout.write(JSON.stringify(await client.status()) + "\n");
    } else {
    if (![4, 6].includes(args.length) || args[0] !== "--profile" || args[2] !== "--client"
      || args.length === 6 && args[4] !== "--control-directory") fail("invalid_action", 400);
    await runEnvironmentOwner({ profilePath: args[1], clientPath: args[3], controlDirectory: args[5] });
    }
  } catch { process.stderr.write("local_environment_owner_failed_retained\n"); process.exitCode = 1; }
}
