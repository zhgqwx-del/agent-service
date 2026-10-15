#!/usr/bin/env node
// Build a role-specific Node 24 process release. No application configuration or secret is read.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertVmReleaseRole,
  currentVmReleaseTargetRuntime,
  sha256File,
  validateVmReleasePayload,
  verifyVmReleaseDirectory,
  vmReleaseModeHasSpecialBits,
  VM_RELEASE_ENTRYPOINTS,
} from "./lib/vm-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "PNPM_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "COREPACK_HOME", "CI", "SYSTEMROOT", "WINDIR",
  "COMSPEC", "PATHEXT",
];
const CHILD_ENV = Object.fromEntries(CHILD_ENV_KEYS
  .filter((key) => Object.hasOwn(process.env, key))
  .map((key) => [key, process.env[key]]));
CHILD_ENV.COREPACK_ENABLE_NETWORK = "0";
CHILD_ENV.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
CHILD_ENV.NPM_CONFIG_GLOBALCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
const INSTALL_ARGS = ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"];
const DEPLOY_ARGS = (role, destination) => [
  "--filter", `./apps/${role}`, "--prod", "--offline", "--ignore-scripts",
  "--trust-lockfile", "--frozen-lockfile", "deploy", destination,
];
const ROOT_INPUTS = Object.freeze([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
  "tsconfig.base.json", "tsconfig.json", "Dockerfile", ".dockerignore",
  "scripts/build-app.mjs", "scripts/package-vm-release.mjs", "scripts/lib/vm-release.mjs",
  "scripts/vm-release-tool.mjs", "scripts/package-vm-transport.mjs", "scripts/lib/vm-release-archive.mjs",
  "scripts/lib/vm-release-signature.mjs", "scripts/lib/vm-release-signed.mjs",
  "deploy/vm/agent-runner.service.template", "deploy/vm/agent-router.service.template",
]);
const EXCLUDED_SOURCE_SEGMENTS = new Set([
  "node_modules", "dist", ".tsbuild", "coverage", "test", "tests", "docs", ".git", ".local-run", "spikes",
]);

export function parseVmReleaseArgs(args) {
  let role;
  let output;
  let allowDirtyDevelopment = false;
  let seenRole = false;
  let seenOutput = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--role" && !seenRole) { seenRole = true; role = args[++i]; }
    else if (arg === "--output" && !seenOutput) { seenOutput = true; output = args[++i]; }
    else if (arg === "--allow-dirty-development" && !allowDirtyDevelopment) allowDirtyDevelopment = true;
    else throw new Error("usage: package-vm-release.mjs --role agent-runner|agent-router --output <new-absolute-directory> [--allow-dirty-development]");
  }
  assertVmReleaseRole(role);
  if (!output || !isAbsolute(output)) throw new Error("--output must be a new absolute directory");
  return { role, output: resolve(output), allowDirtyDevelopment };
}

async function run(program, args, { capture = false, cwd = ROOT } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    const child = spawn(program, args, {
      cwd,
      env: CHILD_ENV,
      // Child output is deliberately never echoed: inherited package-manager configuration or
      // arbitrary build failures must not reveal credentials in terminal/CI logs.
      stdio: capture ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"],
    });
    if (capture) child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun(stdout.trim());
      else rejectRun(new Error(`${program} failed (${signal ?? code})`));
    });
  });
}

async function assertNoBuildConfigHooks(root) {
  for (const name of [".npmrc", ".pnpmfile.cjs", ".pnpmfile.js"]) {
    try {
      await lstat(join(root, name));
      throw new Error("repository package-manager configuration hooks are forbidden for VM releases");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function assertSourcePath(path) {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f\ufffd]/.test(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("unsafe source input path");
  }
  const names = path.split("/");
  if (names.some((name) => name === ".env" || name.startsWith(".env.") || name === ".npmrc"
    || name === ".pnpmfile.cjs" || name === ".pnpmfile.js"
    || /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db)$/i.test(name)
    || ["id_rsa", "id_ed25519", "credentials"].includes(name))) {
    throw new Error("credential, configuration or database files are forbidden in source snapshot");
  }
}

function selectedSourcePath(path) {
  if (ROOT_INPUTS.includes(path)) return true;
  const names = path.split("/");
  const inApp = names[0] === "apps" && ["agent-runner", "agent-router"].includes(names[1]);
  const inPackage = names[0] === "packages" && names.length >= 3;
  if (!inApp && !inPackage) return false;
  if (names.slice(2).some((name) => EXCLUDED_SOURCE_SEGMENTS.has(name)
    || name === ".DS_Store" || name.endsWith(".tsbuildinfo") || name.endsWith(".log"))) return false;
  assertSourcePath(path);
  return true;
}

async function listWorkingInputPaths(root) {
  const paths = [...ROOT_INPUTS];
  async function visit(path) {
    const stats = await lstat(join(root, path));
    if (stats.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) {
        const child = `${path}/${name}`;
        if (selectedSourcePath(child)) await visit(child);
      }
      return;
    }
    assertSourcePath(path);
    if (!stats.isFile() || vmReleaseModeHasSpecialBits(stats.mode)) {
      throw new Error("source input must be a regular file without special permission bits");
    }
    paths.push(path);
  }
  for (const role of ["agent-runner", "agent-router"]) await visit(`apps/${role}`);
  for (const name of (await readdir(join(root, "packages"))).sort()) {
    const path = `packages/${name}`;
    const stats = await lstat(join(root, path));
    if (stats.isDirectory()) await visit(path);
    else if (stats.isSymbolicLink()) throw new Error("workspace package directory cannot be a symlink");
  }
  for (const path of ROOT_INPUTS) {
    assertSourcePath(path);
    const stats = await lstat(join(root, path));
    if (!stats.isFile() || vmReleaseModeHasSpecialBits(stats.mode)) {
      throw new Error("required source input must be a regular file without special permission bits");
    }
  }
  return [...new Set(paths)].sort();
}

async function writeSnapshotFile(snapshotRoot, path, bytes, executable) {
  assertSourcePath(path);
  const destination = join(snapshotRoot, path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(destination, executable ? 0o555 : 0o444);
}

async function readGitBlob(objectId) {
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) throw new Error("invalid committed input object ID");
  return new Promise((resolveBlob, rejectBlob) => {
    const child = spawn("git", ["cat-file", "blob", objectId], {
      cwd: ROOT, env: CHILD_ENV, stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let length = 0;
    child.stdout.on("data", (bytes) => {
      length += bytes.length;
      if (length > 64 * 1024 * 1024) {
        child.kill();
        rejectBlob(new Error("committed build input exceeds size limit"));
      } else chunks.push(bytes);
    });
    child.once("error", () => rejectBlob(new Error("committed build input could not be read")));
    child.once("close", (code) => {
      if (code === 0) resolveBlob(Buffer.concat(chunks));
      else rejectBlob(new Error("committed build input could not be read"));
    });
  });
}

async function captureCommittedInputs(snapshotRoot, sourceCommit) {
  const tree = await run("git", ["ls-tree", "-rz", "--full-tree", sourceCommit], { capture: true });
  const copied = new Set();
  for (const row of tree.split("\0")) {
    if (!row) continue;
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("unsupported committed source tree entry");
    const [, mode, objectType, objectId, path] = match;
    if (/^packages\/[^/]+$/.test(path) && (mode === "120000" || objectType === "commit")) {
      throw new Error("workspace package directory cannot be a symlink or submodule");
    }
    if (!selectedSourcePath(path)) continue;
    if (objectType !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error("committed build input must be a regular file");
    }
    if (copied.has(path)) throw new Error("duplicate committed source input");
    copied.add(path);
    await writeSnapshotFile(snapshotRoot, path, await readGitBlob(objectId), mode === "100755");
  }
  for (const path of ROOT_INPUTS) {
    if (!copied.has(path)) throw new Error("required committed source input is missing");
  }
}

export async function captureVmReleaseWorkingInputs(sourceRoot, snapshotRoot) {
  if (!isAbsolute(sourceRoot) || !isAbsolute(snapshotRoot)
    || await realpath(sourceRoot) === await realpath(snapshotRoot)
    || (await readdir(snapshotRoot)).length !== 0) {
    throw new Error("source and empty snapshot directories must be separate absolute paths");
  }
  await assertNoBuildConfigHooks(sourceRoot);
  for (const path of await listWorkingInputPaths(sourceRoot)) {
    const sourceHandle = await open(join(sourceRoot, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    let executable;
    try {
      const stats = await sourceHandle.stat();
      if (!stats.isFile() || vmReleaseModeHasSpecialBits(stats.mode) || stats.size > 64 * 1024 * 1024) {
        throw new Error("working build input must be a bounded regular file without special permission bits");
      }
      executable = (stats.mode & 0o111) !== 0;
      bytes = await sourceHandle.readFile();
    } finally {
      await sourceHandle.close();
    }
    await writeSnapshotFile(snapshotRoot, path, bytes, executable);
  }
  return workingBuildInputs(snapshotRoot);
}

async function sourceProvenance(snapshotRoot, allowDirtyDevelopment) {
  const sourceRoot = await run("git", ["rev-parse", "--show-toplevel"], { capture: true });
  if (await realpath(sourceRoot) !== await realpath(ROOT)) {
    throw new Error("release builder must run from its own Git checkout");
  }
  const sourceCommit = await run("git", ["rev-parse", "--verify", "HEAD"], { capture: true });
  const dirty = (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { capture: true })) !== "";
  if (dirty && !allowDirtyDevelopment) {
    throw new Error("working tree is dirty; use --allow-dirty-development only for unpublishable local packages");
  }
  if (dirty) await captureVmReleaseWorkingInputs(ROOT, snapshotRoot);
  else await captureCommittedInputs(snapshotRoot, sourceCommit);
  await assertNoBuildConfigHooks(snapshotRoot);
  const inputs = await workingBuildInputs(snapshotRoot);
  const rootPackage = JSON.parse(await readFile(join(snapshotRoot, "package.json"), "utf8"));
  const packageManager = rootPackage.packageManager;
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error("packageManager must pin an exact pnpm version");
  }
  const pnpmVersion = await run("pnpm", ["--version"], { capture: true, cwd: snapshotRoot });
  if (`pnpm@${pnpmVersion}` !== packageManager) {
    throw new Error("installed pnpm does not match the repository packageManager pin");
  }
  return {
    sourceCommit,
    sourceDirty: dirty,
    lockSha256: await sha256File(join(snapshotRoot, "pnpm-lock.yaml")),
    ...inputs,
    packageManager,
    buildRuntime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

async function workingBuildInputs(root) {
  const paths = await listWorkingInputPaths(root);
  const inputFiles = [];
  for (const path of paths) {
    const absolute = join(root, path);
    const stats = await lstat(absolute);
    if (!stats.isFile()) throw new Error("build input changed while being inventoried");
    inputFiles.push({ path, sha256: await sha256File(absolute), size: stats.size });
  }
  const inputSha256 = createHash("sha256").update(JSON.stringify(inputFiles)).digest("hex");
  return { inputSha256, inputFiles };
}

async function assertNewOutput(output) {
  const parent = dirname(output);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("output parent must be a real existing directory");
  }
  if (output === ROOT || output === parent) throw new Error("output must be a new dedicated directory");
  const resolvedOutput = join(await realpath(parent), basename(output));
  const sourceRelative = relative(await realpath(ROOT), resolvedOutput);
  if (sourceRelative === "" || (sourceRelative !== ".." && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative))) {
    throw new Error("output must be outside the source checkout and its build directories");
  }
  try {
    await lstat(output);
    throw new Error("output already exists; releases are never overwritten");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function assertMigrationsMatchBuild(dist, snapshotRoot) {
  const source = join(snapshotRoot, "packages", "store", "migrations");
  const built = join(dist, "migrations");
  const names = (await readdir(source)).sort();
  if (names.join("\0") !== (await readdir(built)).sort().join("\0")) {
    throw new Error("built migration set differs from source checkout");
  }
  for (const name of names) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(name)
      || await sha256File(join(source, name)) !== await sha256File(join(built, name))) {
      throw new Error("built migration bytes differ from source checkout");
    }
  }
}

export async function buildVmRelease({ role, output, allowDirtyDevelopment = false }) {
  assertVmReleaseRole(role);
  if (typeof output !== "string" || !isAbsolute(output)) throw new Error("output must be an absolute path");
  if (typeof allowDirtyDevelopment !== "boolean") throw new Error("allowDirtyDevelopment must be boolean");
  output = resolve(output);
  const targetRuntime = currentVmReleaseTargetRuntime();
  await assertNoBuildConfigHooks(ROOT);
  await assertNewOutput(output);
  const scratch = await mkdtemp(join(tmpdir(), "agent-service-vm-release-"));
  try {
    await chmod(scratch, 0o700);
    const snapshotRoot = join(scratch, "source");
    await mkdir(snapshotRoot, { mode: 0o700 });
    const provenance = await sourceProvenance(snapshotRoot, allowDirtyDevelopment);

    // All build tools read only the captured source snapshot. The live checkout is never the
    // compilation/dependency input, so an edit-build-restore ABA cannot falsify provenance.
    // pnpm deploy has the Dockerfile's exact frozen, offline, ignore-scripts production closure.
    const deployPath = join(scratch, "deploy");
    await assertNoBuildConfigHooks(snapshotRoot);
    await run("pnpm", INSTALL_ARGS, { cwd: snapshotRoot });
    await run(process.execPath, [join(snapshotRoot, "scripts", "build-app.mjs"), role], { cwd: snapshotRoot });
    const builtDist = join(snapshotRoot, "apps", role, "dist");
    await assertMigrationsMatchBuild(builtDist, snapshotRoot);
    await assertNoBuildConfigHooks(snapshotRoot);
    await run("pnpm", DEPLOY_ARGS(role, deployPath), { cwd: snapshotRoot });
    await assertNoBuildConfigHooks(snapshotRoot);
    const after = await workingBuildInputs(snapshotRoot);
    if (after.inputSha256 !== provenance.inputSha256
      || await sha256File(join(snapshotRoot, "pnpm-lock.yaml")) !== provenance.lockSha256
      || await run("git", ["rev-parse", "--verify", "HEAD"], { capture: true }) !== provenance.sourceCommit) {
      throw new Error("build inputs changed during build/deploy; no release was published");
    }

    // The final directory is created exclusively and never silently replaced. A failure may leave
    // a partial directory, including a manifest if final verification failed. Only a successful
    // verified return supplies a trusted digest eligible for a separate promotion channel.
    await mkdir(output);
    await cp(builtDist, join(output, "dist"), { recursive: true, dereference: false, verbatimSymlinks: true });
    await cp(join(deployPath, "node_modules"), join(output, "node_modules"), {
      recursive: true, dereference: false, verbatimSymlinks: true,
    });
    await mkdir(join(output, "service"));
    const templateName = `${role}.service.template`;
    const templateSource = join(snapshotRoot, "deploy", "vm", templateName);
    const templatePublished = join(output, "service", templateName);
    await cp(templateSource, templatePublished, { errorOnExist: true, force: false });
    if (await sha256File(templateSource) !== await sha256File(templatePublished)) {
      throw new Error("systemd template changed during release publication");
    }
    await assertMigrationsMatchBuild(join(output, "dist"), snapshotRoot);
    await assertNoBuildConfigHooks(snapshotRoot);
    if ((await workingBuildInputs(snapshotRoot)).inputSha256 !== provenance.inputSha256
      || (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { capture: true }) !== "")
        !== provenance.sourceDirty) {
      throw new Error("source checkout changed during release publication");
    }
    const files = await validateVmReleasePayload(output, role, { targetRuntime });
    const manifest = {
      schema: "agent-service-vm-release-v1",
      role,
      releaseKind: "node24-platform-process-directory",
      productionAccepted: false,
      publishable: !provenance.sourceDirty,
      targetRuntime,
      source: provenance,
      build: {
        installContract: "pnpm install --offline --frozen-lockfile --ignore-scripts",
        bundler: "scripts/build-app.mjs",
        dependencyClosure: `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`,
        entrypoints: VM_RELEASE_ENTRYPOINTS[role].map((name) => `dist/${name}`),
        migrationCount: (await readdir(join(output, "dist", "migrations"))).length,
      },
      files,
    };
    const manifestPath = join(output, "release-manifest.json");
    const manifestFile = await open(manifestPath, "wx", 0o644);
    try {
      await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    await chmod(manifestPath, 0o644);
    const manifestSha256 = await sha256File(manifestPath);
    await verifyVmReleaseDirectory(output, role, manifestSha256);
    return { output, role, fileCount: files.length, publishable: manifest.publishable, manifestSha256 };
  } finally {
    // The exact mkdtemp-created scratch directory is the only recursive cleanup target.
    await rm(scratch, { recursive: true, force: true });
  }
}

function isDirectBuilderEntrypoint() {
  if (typeof process.argv[1] !== "string" || process.argv[1] === "") return false;
  try {
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = realpathSync(process.argv[1]);
    return modulePath === invokedPath && statSync(modulePath).isFile();
  } catch {
    return false;
  }
}

if (isDirectBuilderEntrypoint()) {
  Promise.resolve().then(() => parseVmReleaseArgs(process.argv.slice(2))).then(buildVmRelease)
    .then(({ role, output, fileCount, publishable, manifestSha256 }) => {
    console.log(`Created ${role} Node 24 VM process release at ${output} (${fileCount} inventoried entries; publishable=${publishable}; manifestSha256=${manifestSha256})`);
    }).catch((error) => {
    // Do not print child process output, environment values, or arbitrary objects on failure.
    console.error(`VM release build failed: ${error.message}`);
    process.exitCode = 1;
    });
}
