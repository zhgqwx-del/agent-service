// Build independent role directories and execute only their production dependency closure.
// This gate does not load .env, connect to a database, install a service, or contact a provider.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, lstat, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVmRelease } from "./package-vm-release.mjs";
import { packageVmTransport } from "./package-vm-transport.mjs";
import { sha256File, verifyVmReleaseDirectory, VM_RELEASE_ENTRYPOINTS } from "./lib/vm-release.mjs";
import { vmReleasePublicKeySha256 } from "./lib/vm-release-signature.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let allowDirtyDevelopment = false;
let artifactDirectory;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--allow-dirty-development" && !allowDirtyDevelopment) allowDirtyDevelopment = true;
  else if (args[i] === "--artifacts" && artifactDirectory === undefined && isAbsolute(args[i + 1] ?? "")) {
    artifactDirectory = resolve(args[++i]);
  } else throw new Error("usage: check-vm-release.mjs [--allow-dirty-development] [--artifacts <new-absolute-directory>]");
}
if (artifactDirectory !== undefined) {
  try {
    const parent = await realpath(dirname(artifactDirectory));
    artifactDirectory = join(parent, artifactDirectory.slice(artifactDirectory.lastIndexOf(sep) + 1));
    const fromRoot = relative(await realpath(ROOT), artifactDirectory);
    if (fromRoot === "" || !fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot)) {
      throw new Error("VM transport artifact directory must be outside the source checkout");
    }
    // Reserve only a fresh directory. A failed invocation never overwrites an earlier release.
    await mkdir(artifactDirectory, { mode: 0o700 });
  } catch {
    console.error("VM release verification failed (operation_failed, phase=artifact-directory)");
    process.exit(1);
  }
}
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

async function checkSchemaMain(invocationDirectory, args) {
  // This is main.js one-shot mode, not a fifth standalone CLI. The verified release
  // contains no .env and the closed child environment carries no service/DSN authority.
  const child = spawn(process.execPath, [join(invocationDirectory, "dist/main.js"), ...args], {
    cwd: invocationDirectory, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [], stderr = []; let bytes = 0, overflow = false, timedOut = false, failed = false, closed = false;
  const terminate = () => { if (!closed) child.kill("SIGKILL"); };
  const capture = output => chunk => {
    bytes += chunk.length;
    if (bytes > 64 * 1024) { overflow = true; terminate(); } else output.push(chunk);
  };
  child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
  const finished = new Promise(resolveClose => {
    child.once("error", () => { failed = true; });
    child.once("close", (status, signal) => { closed = true; resolveClose({ status, signal }); });
  });
  const timer = setTimeout(() => { timedOut = true; terminate(); }, 5_000);
  let result; try { result = await finished; } finally { clearTimeout(timer); }
  const out = Buffer.concat(stdout).toString("utf8"), err = Buffer.concat(stderr).toString("utf8");
  const help = args.length === 2 && args[1] === "--help";
  const valid = help ? result.status === 0 && err === ""
    && out.startsWith("Usage: agent-runner schema <command>\n\n")
    && out.includes("This command never creates a database, starts a service or activates runtime controls.\n")
    && out.endsWith("  schema -h, schema --help  Show this help without opening resources.\n\n")
    : result.status === 1 && out === "" && err === '{"status":"error","code":"invalid_arguments"}\n';
  // The original five-second small CLI budget kills on failure but still joins native close.
  if (failed || timedOut || overflow || result.signal || !valid) throw new Error("VM main schema mode failed its closed plain Node contract");
}

function offlineCommand(script, args, cwd, succeeds = true) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd, env: childEnv, encoding: "utf8", timeout: 135_000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.signal || result.status !== (succeeds ? 0 : 1)
    || succeeds && result.stderr !== "" || !succeeds && (result.stdout !== ""
      || result.stderr !== "vm-release-tool failed (operation_failed)\n")) {
    throw new Error("VM signed transport command failed its closed contract");
  }
  return succeeds ? JSON.parse(result.stdout) : undefined;
}

async function requireAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("rejected signed transport created output");
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
  const transports = [];
  const signatureChecks = [];
  // Ephemeral validation keys are never a release/CI signing authority and are not retained in
  // --artifacts. No production key is generated, loaded from ambient config, or printed.
  let signing;
  if (!allowDirtyDevelopment) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privatePath = join(scratch, "test-signing-private.pem"), publicPath = join(scratch, "test-signing-public.pem");
    const privateBytes = privateKey.export({ type: "pkcs8", format: "pem" });
    try { await writeFile(privatePath, privateBytes, { flag: "wx", mode: 0o600 }); }
    finally { if (Buffer.isBuffer(privateBytes)) privateBytes.fill(0); }
    await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o600 });
    signing = { privatePath, publicPath, publicKeySha256: vmReleasePublicKeySha256(publicKey) };
  }
  const transportRoot = artifactDirectory ?? join(scratch, "transport-artifacts");
  if (artifactDirectory === undefined) await mkdir(transportRoot, { mode: 0o700 });
  for (const release of releases) {
    phase = `archive-${release.role}`;
    const transportOutput = join(transportRoot, release.role);
    const proof = await packageVmTransport({ release: release.output, role: release.role,
      manifestSha256: release.manifestSha256, output: transportOutput });
    const archivePath = join(transportOutput, "release.tar");
    const toolPath = join(transportOutput, "vm-release-tool.mjs");
    // This expected digest comes directly from the trusted builder, not the archive or sidecar.
    if (await sha256File(toolPath) !== proof.toolSha256) throw new Error("standalone VM verifier differs from trusted build bytes");
    const unpacked = join(scratch, `unpacked-${release.role}`);
    phase = `standalone-unpack-${release.role}`;
    const invocation = spawnSync(process.execPath, [toolPath, "unpack", "--archive", archivePath,
      "--role", release.role, "--archive-sha256", proof.archiveSha256,
      "--manifest-sha256", release.manifestSha256, "--output", unpacked], {
      // No source checkout, package manager, dependency tree or application configuration here.
      cwd: scratch, env: childEnv, encoding: "utf8", timeout: 135_000, maxBuffer: 64 * 1024,
    });
    if (invocation.error || invocation.signal || invocation.status !== 0 || invocation.stderr !== "") {
      throw new Error("standalone VM archive extraction failed");
    }
    const extractedProof = JSON.parse(invocation.stdout);
    if (extractedProof.archiveSha256 !== proof.archiveSha256
      || extractedProof.manifestSha256 !== release.manifestSha256
      || extractedProof.role !== release.role || extractedProof.productionAccepted !== false) {
      throw new Error("standalone VM extraction proof does not match trusted inputs");
    }
    await verifyVmReleaseDirectory(unpacked, release.role, release.manifestSha256);
    let executableOutput = unpacked;
    if (signing !== undefined) {
      phase = `sign-${release.role}`;
      const signature = join(scratch, `test-${release.role}-signature.json`);
      const signed = offlineCommand(join(ROOT, "scripts/sign-vm-release.mjs"), [
        "--release", release.output, "--role", release.role,
        "--manifest-sha256", release.manifestSha256, "--archive", archivePath,
        "--tool", toolPath, "--private-key", signing.privatePath,
        "--public-key-sha256", signing.publicKeySha256, "--output", signature,
      ], scratch);
      if (signed.schema !== "agent-service-vm-release-signing-receipt-v1"
        || signed.sourceCommit !== release.sourceCommit || signed.role !== release.role
        || signed.publicKeySha256 !== signing.publicKeySha256
        || signed.toolSha256 !== proof.toolSha256 || signed.archiveSha256 !== proof.archiveSha256
        || signed.manifestSha256 !== release.manifestSha256 || signed.productionAccepted !== false) {
        throw new Error("VM signature receipt differs from trusted build inputs");
      }
      const selectors = ["--archive", archivePath, "--role", release.role, "--signature", signature,
        "--public-key", signing.publicPath, "--public-key-sha256", signing.publicKeySha256,
        "--source-commit", release.sourceCommit];
      phase = `standalone-signed-inspect-${release.role}`;
      const inspected = offlineCommand(toolPath, ["inspect-signed", ...selectors], scratch);
      const signedOutput = join(scratch, `signed-unpacked-${release.role}`);
      phase = `standalone-signed-unpack-${release.role}`;
      const extracted = offlineCommand(toolPath, ["unpack-signed", ...selectors, "--output", signedOutput], scratch);
      for (const receipt of [inspected, extracted]) {
        if (receipt.signatureVerified !== true || receipt.productionAccepted !== false
          || receipt.publicKeySha256 !== signing.publicKeySha256
          || receipt.signatureSha256 !== signed.signatureSha256
          || receipt.statement.sourceCommit !== release.sourceCommit || receipt.statement.role !== release.role
          || receipt.statement.toolSha256 !== proof.toolSha256
          || receipt.receipt.archiveSha256 !== proof.archiveSha256
          || receipt.receipt.manifestSha256 !== release.manifestSha256) {
          throw new Error("VM signed consumer receipt differs from trusted selection");
        }
      }
      phase = `standalone-signed-rejection-${release.role}`;
      for (const [field, value] of [["--public-key-sha256", "0".repeat(64)],
        ["--source-commit", release.sourceCommit === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40)]]) {
        const wrong = [...selectors]; wrong[wrong.indexOf(field) + 1] = value;
        const rejectedOutput = join(scratch, `rejected-${release.role}-${field.slice(2)}`);
        offlineCommand(toolPath, ["unpack-signed", ...wrong, "--output", rejectedOutput], scratch, false);
        await requireAbsent(rejectedOutput);
      }
      await verifyVmReleaseDirectory(signedOutput, release.role, release.manifestSha256);
      executableOutput = signedOutput;
      signatureChecks.push({ role: release.role, authority: "ephemeral-test-only", signatureVerified: true,
        signatureSha256: signed.signatureSha256, publicKeySha256: signing.publicKeySha256,
        selectedCommit: release.sourceCommit, consumerToolSha256: proof.toolSha256,
        productionAccepted: false });
    }
    // All following executable checks must use transported bytes, not the original build.
    release.output = executableOutput;
    transports.push(proof);
  }
  if (transports[0].toolSha256 !== transports[1].toolSha256
    || transports.some((proof, index) => proof.sourceCommit !== releases[index].sourceCommit
      || proof.sourceDirty !== releases[index].sourceDirty
      || proof.publishable !== releases[index].publishable
      || proof.compiler.boundLockSha256 !== releases[index].lockSha256)) {
    throw new Error("VM transports do not share the exact source/compiler-bound tool");
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
  phase = "plain-node-main-schema-modes";
  for (const invocationDirectory of [canonicalRunner, current]) {
    for (const args of [["schema", "--help"], ["schema", "unknown"], ["schema", "--help", "extra"]]) {
      await checkSchemaMain(invocationDirectory, args);
    }
  }
  console.log("VM main schema mode: help and closed unknown/extra argument rejection passed under canonical and current-directory-symlink invocations");
  phase = "plain-node-one-shots";
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
  for (const proof of transports) {
    const output = join(transportRoot, proof.role);
    if (await sha256File(join(output, "release.tar")) !== proof.archiveSha256
      || await sha256File(join(output, "vm-release-tool.mjs")) !== proof.toolSha256) {
      throw new Error("VM transport artifacts changed during runtime verification");
    }
  }
  const report = {
    schema: "agent-service-vm-release-check-v1", completedAt: new Date().toISOString(),
    productionAccepted: false, allowDirtyDevelopment,
    roles: releases.map(({ role, sourceCommit, sourceDirty, inputSha256, lockSha256, targetRuntime, nativeFiles, publishable, manifestSha256, fileCount }) => (
      { role, sourceCommit, sourceDirty, inputSha256, lockSha256, targetRuntime, nativeFiles, publishable, manifestSha256, fileCount }
    )),
    transports,
    signatureChecks,
    signatureProfile: signing === undefined ? "not-executed-dirty-development" : "ephemeral-test-only",
    oneShots, oneShotInvocations: ["canonical", "current-directory-symlink"],
    mainInvocations: ["current-directory-symlink"],
    runtime: ["runner-ready", "router-ready", "protocol-discovery", "tenant-auth", "platform-auth", "forwarding", "canonical-openapi", "immutable-after-stop"],
  };
  await mkdir(join(ROOT, ".local-run"), { recursive: true });
  await writeFile(join(ROOT, ".local-run/vm-release-proof.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`VM transport trusted build proof: ${JSON.stringify(transports)}`);
  console.log(`VM process releases passed: two transported dependency closures, standalone digest-bound extraction, signature profile ${report.signatureProfile}, four plain Node one-shots, readiness/auth/forwarding/OpenAPI and unchanged payloads`);
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
