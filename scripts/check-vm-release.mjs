// Build independent role directories and execute only their production dependency closure.
// This gate does not load .env, connect to a database, install a service, or contact a provider.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVmRelease } from "./package-vm-release.mjs";
import { verifyVmReleaseDirectory, VM_RELEASE_ENTRYPOINTS } from "./lib/vm-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--allow-dirty-development")) {
  throw new Error("usage: check-vm-release.mjs [--allow-dirty-development]");
}
const allowDirtyDevelopment = args.length === 1;
const TEST_MASTER_KEY = "77".repeat(32); // deterministic test-only key, never a configured credential
const childEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
let failureDetail;
const canonicalOpenApi = JSON.parse(await readFile(join(ROOT, "packages/protocol/openapi.json"), "utf8"));

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("fixture port unavailable")));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function startRelease(release, env, invocationDirectory = release.output) {
  const child = spawn(process.execPath, [join(invocationDirectory, "dist/main.js")], {
    cwd: invocationDirectory,
    env: { ...childEnv, ...env },
    // Runtime diagnostics are never echoed; this is a closed, credential-free test environment.
    stdio: "ignore",
  });
  const proc = { child, failed: false, closed: false, finished: undefined };
  proc.finished = new Promise((resolveExit) => {
    child.once("error", () => { proc.failed = true; });
    child.once("close", () => { proc.closed = true; resolveExit(); });
  });
  return proc;
}

async function waitReady(url, proc) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.failed || proc.closed) throw new Error("VM process exited before readiness");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch { /* readiness polling is bounded and does not expose diagnostics */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("VM process readiness deadline exceeded");
}

async function stopProcess(proc) {
  if (!proc || proc.closed) return;
  const waitClosed = async (ms) => {
    let timer;
    try {
      return await Promise.race([
        proc.finished.then(() => true),
        new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  proc.child.kill("SIGTERM");
  if (await waitClosed(5_000)) return;
  proc.child.kill("SIGKILL");
  if (!await waitClosed(5_000)) throw new Error("VM process did not terminate");
}

async function checkOpenApi(base) {
  const response = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(2_000) });
  if (response.status !== 200 || JSON.stringify(await response.json()) !== JSON.stringify(canonicalOpenApi)) {
    throw new Error("VM release OpenAPI differs from canonical protocol");
  }
}

function checkOneShot(release, entrypoint, invocationDirectory = release.output) {
  const name = entrypoint.slice(0, -3);
  const result = spawnSync(process.execPath, [join(invocationDirectory, "dist", entrypoint), "--help"], {
    cwd: invocationDirectory,
    env: childEnv,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr !== ""
    || !result.stdout.includes(`Usage: ${name}`)) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    failureDetail = {
      entrypoint, status: result.status, signal: result.signal,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      usageMarker: stdout.includes(`Usage: ${name}`),
      nodeErrorCode: /\b(ERR_[A-Z0-9_]+)\b/.exec(stderr)?.[1] ?? null,
      spawnErrorCode: /^[A-Z0-9_]+$/.test(result.error?.code ?? "") ? result.error.code : null,
    };
    throw new Error("VM release one-shot entrypoint failed plain Node verification");
  }
}

const scratch = await mkdtemp(join(tmpdir(), "agent-service-vm-check-"));
let runner;
let router;
let phase = "build-agent-runner";
try {
  const releases = [];
  // Serial builds avoid simultaneous pnpm/store writes and keep resource usage bounded.
  for (const role of ["agent-runner", "agent-router"]) {
    phase = `build-${role}`;
    const release = await buildVmRelease({ role, output: join(scratch, role), allowDirtyDevelopment });
    phase = `verify-${role}`;
    const manifest = await verifyVmReleaseDirectory(release.output, role, release.manifestSha256);
    if (!allowDirtyDevelopment && (!release.publishable || manifest.source.sourceDirty)) {
      throw new Error("CI VM release is not a clean committed build");
    }
    releases.push({ ...release, sourceCommit: manifest.source.sourceCommit, sourceDirty: manifest.source.sourceDirty,
      inputSha256: manifest.source.inputSha256, lockSha256: manifest.source.lockSha256,
      targetRuntime: manifest.targetRuntime,
      nativeFiles: manifest.files.filter((entry) => entry.kind === "file" && entry.nativeFormat !== undefined).length });
  }
  if (releases[0].sourceCommit !== releases[1].sourceCommit || releases[0].sourceDirty !== releases[1].sourceDirty
    || releases[0].inputSha256 !== releases[1].inputSha256 || releases[0].lockSha256 !== releases[1].lockSha256
    || JSON.stringify(releases[0].targetRuntime) !== JSON.stringify(releases[1].targetRuntime)) {
    throw new Error("VM role releases do not share the same source state");
  }
  const runnerRelease = releases[0];
  const routerRelease = releases[1];
  phase = "plain-node-one-shots";
  const oneShots = VM_RELEASE_ENTRYPOINTS["agent-runner"].filter((name) => name !== "main.js");
  const canonicalRunner = await realpath(runnerRelease.output);
  const current = join(scratch, "runner-current");
  await symlink(canonicalRunner, current, "dir");
  const routerCurrent = join(scratch, "router-current");
  await symlink(await realpath(routerRelease.output), routerCurrent, "dir");
  for (const entrypoint of oneShots) {
    checkOneShot(runnerRelease, entrypoint, canonicalRunner);
    // Prove the same command is actually invoked through the VM-style current directory alias.
    checkOneShot(runnerRelease, entrypoint, current);
  }
  const runnerPort = await freePort();
  let routerPort = await freePort();
  while (routerPort === runnerPort) routerPort = await freePort();
  const runnerBase = `http://127.0.0.1:${runnerPort}`;
  const routerBase = `http://127.0.0.1:${routerPort}`;
  const state = join(scratch, "fixture-state");
  await mkdir(state, { mode: 0o700 });
  phase = "runner-memory-boot";
  runner = startRelease(runnerRelease, {
    STORE: "memory", SECRETS_MASTER_KEY: TEST_MASTER_KEY,
    RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort), RUNNER_ADDR: `127.0.0.1:${runnerPort}`,
    BLOB_STORE: "filesystem", BLOB_DIR: join(state, "blobs"), SHUTDOWN_GRACE_MS: "0",
  }, current);
  await waitReady(`${runnerBase}/readyz`, runner);
  await checkOpenApi(runnerBase);
  phase = "router-loopback-boot";
  router = startRelease(routerRelease, {
    ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: runnerBase,
    HEALTH_INTERVAL_MS: "100", SHUTDOWN_GRACE_MS: "0",
  }, routerCurrent);
  await waitReady(`${routerBase}/readyz`, router);
  phase = "protocol-auth-forwarding";
  const capabilities = await fetch(`${routerBase}/v1/capabilities`, { signal: AbortSignal.timeout(2_000) });
  if (capabilities.status !== 200) throw new Error("VM router protocol discovery failed");
  for (const [path, method] of [["/v1/agents", "GET"], ["/v1/tenant-erasure-requests", "POST"]]) {
    const response = await fetch(`${routerBase}${path}`, { method, signal: AbortSignal.timeout(2_000) });
    if (response.status !== 401 || (await response.json())?.error?.code !== "unauthorized") {
      throw new Error("VM router changed tenant/platform authentication boundary");
    }
  }
  await checkOpenApi(routerBase);
  await stopProcess(router); router = undefined;
  await stopProcess(runner); runner = undefined;
  phase = "immutable-after-stop";
  for (const release of releases) {
    // Runtime state must remain outside the immutable release directories.
    await verifyVmReleaseDirectory(release.output, release.role, release.manifestSha256);
  }
  const report = {
    schema: "agent-service-vm-release-check-v1", completedAt: new Date().toISOString(),
    productionAccepted: false, allowDirtyDevelopment,
    roles: releases.map(({ role, sourceCommit, sourceDirty, inputSha256, lockSha256, targetRuntime, nativeFiles, publishable, manifestSha256, fileCount }) => (
      { role, sourceCommit, sourceDirty, inputSha256, lockSha256, targetRuntime, nativeFiles, publishable, manifestSha256, fileCount }
    )),
    oneShots, oneShotInvocations: ["canonical", "current-directory-symlink"],
    mainInvocations: ["current-directory-symlink"],
    runtime: ["runner-ready", "router-ready", "protocol-discovery", "tenant-auth", "platform-auth", "forwarding", "canonical-openapi", "immutable-after-stop"],
  };
  await mkdir(join(ROOT, ".local-run"), { recursive: true });
  await writeFile(join(ROOT, ".local-run/vm-release-proof.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("VM process releases passed: two independent dependency closures, four plain Node one-shots, readiness/auth/forwarding/OpenAPI and unchanged payloads");
} catch {
  // Closed phase names aid diagnosis without exposing arbitrary subprocess output or errors.
  console.error(`VM release verification failed (operation_failed, phase=${phase})`);
  try {
    await mkdir(join(ROOT, ".local-run"), { recursive: true });
    await writeFile(join(ROOT, ".local-run/vm-release-last-failure.json"), `${JSON.stringify({
      schema: "agent-service-vm-release-failure-v1", completedAt: new Date().toISOString(),
      productionAccepted: false, allowDirtyDevelopment, phase, failureDetail,
    }, null, 2)}\n`);
  } catch { /* a report I/O failure cannot hide the original failed verification */ }
  process.exitCode = 1;
} finally {
  try { await stopProcess(router); } finally {
    try { await stopProcess(runner); } finally {
      // Only this invocation's exact mkdtemp-created fixtures are removed, never an operator release.
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
