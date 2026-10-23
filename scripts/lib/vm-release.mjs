import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VM_RELEASE_ROLES = Object.freeze(["agent-router", "agent-runner"]);
export const VM_RELEASE_ENTRYPOINTS = Object.freeze({
  "agent-router": Object.freeze(["main.js"]),
  "agent-runner": Object.freeze([
    "main.js",
    "blob-storage-migrate.js",
    "restore-ledger-reconcile.js",
    "backup-catalog.js",
    "telemetry-capture.js",
  ]),
});

export function currentVmReleaseTargetRuntime() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const targetRuntime = { nodeMajor, platform: process.platform, arch: process.arch };
  assertTargetRuntime(targetRuntime);
  return targetRuntime;
}

export function assertVmReleaseRole(role) {
  if (typeof role !== "string" || !Object.hasOwn(VM_RELEASE_ENTRYPOINTS, role)) {
    throw new Error("role must be exactly agent-router or agent-runner");
  }
  return role;
}

function isInside(root, candidate) {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
const EMPTY_SHA256 = sha256(Buffer.alloc(0));

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function assertTargetRuntime(value) {
  if (!hasExactKeys(value, ["nodeMajor", "platform", "arch"])
    || value.nodeMajor !== 24
    || !["linux", "darwin"].includes(value.platform)
    || !["x64", "arm64"].includes(value.arch)) {
    throw new Error("VM release target must be Node 24 on Linux or Darwin x64/arm64");
  }
  return value;
}

function safeRelativePath(path) {
  return typeof path === "string" && path !== "" && !path.startsWith("/")
    && !path.includes("\\") && !path.includes("\0")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

function assertSafePayloadPath(path, stats) {
  const segments = path.split("/");
  if (/\.(?:exe|dll)$/i.test(path)) {
    throw new Error(`Windows binary is unsupported in VM release: ${path}`);
  }
  if (segments.some((part) => part === ".env" || part.startsWith(".env.") || part === ".npmrc")) {
    throw new Error(`environment file is forbidden in VM release payload: ${path}`);
  }
  if (segments.some((part) => [".git", ".local-run", "coverage", "__data__"].includes(part))) {
    throw new Error(`non-runtime data is forbidden in VM release payload: ${path}`);
  }
  if (/\.(?:pem|p12|pfx|key|sqlite|sqlite3|db)$/i.test(path)
    || segments.some((part) => part.toLowerCase() === "id_rsa" || part.toLowerCase() === "id_ed25519")
    || segments.some((part, index) => part.toLowerCase() === "credentials"
      && (segments[0] !== "node_modules" || index === segments.length - 1 && !stats.isDirectory()))) {
    throw new Error(`credential or database file is forbidden in VM release payload: ${path}`);
  }
}

async function readAt(handle, length, offset) {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(bytes, read, length - read, offset + read);
    if (result.bytesRead === 0) throw new Error("native executable is truncated");
    read += result.bytesRead;
  }
  return bytes;
}

function insideFile(offset, length, size) {
  return offset >= 0n && length >= 0n && offset + length <= BigInt(size);
}

async function inspectElf64(handle, fileSize, targetRuntime) {
  if (targetRuntime.platform !== "linux" || fileSize < 64) throw new Error("ELF64 target or header mismatch");
  const header = await readAt(handle, 64, 0);
  if (header[4] !== 2 || header[5] !== 1 || header[6] !== 1
    || ![2, 3].includes(header.readUInt16LE(16))
    || header.readUInt16LE(18) !== (targetRuntime.arch === "x64" ? 62 : 183)
    || header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) {
    throw new Error("ELF64 header does not match target runtime");
  }
  const programOffset = header.readBigUInt64LE(32);
  const sectionOffset = header.readBigUInt64LE(40);
  const programEntrySize = header.readUInt16LE(54);
  const programCount = header.readUInt16LE(56);
  const sectionEntrySize = header.readUInt16LE(58);
  const sectionCount = header.readUInt16LE(60);
  if (programCount < 1 || programEntrySize !== 56 || programOffset < 64n
    || !insideFile(programOffset, BigInt(programCount * 56), fileSize)
    || (sectionCount > 0 && (sectionEntrySize !== 64 || sectionOffset < 64n
      || !insideFile(sectionOffset, BigInt(sectionCount * 64), fileSize)))) {
    throw new Error("ELF64 program or section table is malformed");
  }
  const programs = await readAt(handle, programCount * 56, Number(programOffset));
  let loadSegment = false;
  for (let i = 0; i < programCount; i += 1) {
    const base = i * 56;
    const type = programs.readUInt32LE(base);
    if (type === 0) continue;
    const fileOffset = programs.readBigUInt64LE(base + 8);
    const fileLength = programs.readBigUInt64LE(base + 32);
    if (!insideFile(fileOffset, fileLength, fileSize)) {
      throw new Error("ELF64 segment extends past executable bytes");
    }
    if (type === 1 && fileLength > 0n) loadSegment = true;
  }
  if (!loadSegment) throw new Error("ELF64 has no loadable file segment");
  return { nativeFormat: "elf64", nativeArch: targetRuntime.arch };
}

async function inspectMachO64(handle, fileSize, targetRuntime) {
  if (targetRuntime.platform !== "darwin" || fileSize < 32) throw new Error("Mach-O64 target or header mismatch");
  const header = await readAt(handle, 32, 0);
  const cpu = targetRuntime.arch === "x64" ? 0x01000007 : 0x0100000c;
  const fileType = header.readUInt32LE(12);
  const commandCount = header.readUInt32LE(16);
  const commandsSize = header.readUInt32LE(20);
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu
    || ![2, 6, 8].includes(fileType) || commandCount < 1
    || commandsSize < commandCount * 8 || commandsSize > 16 * 1024 * 1024
    || 32 + commandsSize > fileSize) {
    throw new Error("Mach-O64 header does not match target runtime");
  }
  const commands = await readAt(handle, commandsSize, 32);
  let offset = 0;
  let loadSegment = false;
  for (let i = 0; i < commandCount; i += 1) {
    if (offset + 8 > commandsSize) throw new Error("Mach-O64 load commands are truncated");
    const command = commands.readUInt32LE(offset);
    const commandSize = commands.readUInt32LE(offset + 4);
    if (commandSize < 8 || commandSize % 8 !== 0 || offset + commandSize > commandsSize) {
      throw new Error("Mach-O64 load command size is invalid");
    }
    if (command === 0x19) { // LC_SEGMENT_64
      if (commandSize < 72) throw new Error("Mach-O64 segment command is truncated");
      const sectionCount = commands.readUInt32LE(offset + 64);
      if (72 + sectionCount * 80 > commandSize) throw new Error("Mach-O64 sections exceed command size");
      const fileOffset = commands.readBigUInt64LE(offset + 40);
      const fileLength = commands.readBigUInt64LE(offset + 48);
      if (!insideFile(fileOffset, fileLength, fileSize)) {
        throw new Error("Mach-O64 segment extends past executable bytes");
      }
      if (fileLength > 0n) loadSegment = true;
    }
    offset += commandSize;
  }
  if (offset !== commandsSize || !loadSegment) {
    throw new Error("Mach-O64 load commands or segments are incomplete");
  }
  return { nativeFormat: "macho64", nativeArch: targetRuntime.arch };
}

async function inspectNativeFile(path, stats, targetRuntime) {
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`VM release file size is unsupported: ${path}`);
  }
  if (/\.(?:exe|dll)$/i.test(path)) throw new Error(`Windows binary is unsupported in VM release: ${path}`);
  const nativeExtension = /\.(?:node|so(?:\.\d+)*|dylib)$/i.test(path);
  const handle = await open(path, "r");
  try {
    const first = await readAt(handle, Math.min(8, stats.size), 0);
    const bytesRead = first.length;
    if (bytesRead >= 4 && first.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      return await inspectElf64(handle, stats.size, targetRuntime);
    }
    if (bytesRead >= 4 && first.readUInt32LE(0) === 0xfeedfacf) {
      return await inspectMachO64(handle, stats.size, targetRuntime);
    }
    const magic = bytesRead >= 4 ? first.readUInt32BE(0) : 0;
    if ((bytesRead >= 2 && first[0] === 0x4d && first[1] === 0x5a)
      || [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)
      || (bytesRead >= 4 && first.readUInt32LE(0) === 0xfeedface)
      || (bytesRead >= 8 && first.subarray(0, 8).toString("ascii") === "!<arch>\n")
      || nativeExtension) {
      throw new Error(`unsupported or malformed native executable in VM release: ${path}`);
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Pure mode check, also usable when a host filesystem refuses to retain a special bit. */
export function vmReleaseModeHasSpecialBits(mode) {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0xffffffff) {
    throw new Error("invalid VM release filesystem mode");
  }
  return (mode & 0o7000) !== 0;
}

function payloadMode(stats, path) {
  if (vmReleaseModeHasSpecialBits(stats.mode)) {
    throw new Error(`special permission bits are forbidden in VM release payload: ${path}`);
  }
  return (stats.mode & 0o777).toString(8).padStart(4, "0");
}

/**
 * Enumerate every file and symlink without following directory links. Symlink targets must be
 * relative, resolve inside the copied payload and exist; this also rejects loops and dangling
 * references. The manifest deliberately does not hash itself.
 */
export async function inventoryVmReleasePayload(root, {
  excludeManifest = false,
  targetRuntime = currentVmReleaseTargetRuntime(),
} = {}) {
  assertTargetRuntime(targetRuntime);
  const actualRoot = await realpath(root);
  const entries = [];
  // Limit whole regular-file checks, not just opens. Every admitted check retains its original
  // native inspection, complete streaming SHA and actual handle cleanup before ownership ends.
  const fileWork = new Set();
  let failed = false, firstFailure;
  const recordFailure = (error) => {
    if (!failed) { failed = true; firstFailure = error; }
  };
  const assertHealthy = () => { if (failed) throw firstFailure; };
  async function scheduleFile(absolute, path, stats, mode) {
    assertHealthy();
    while (fileWork.size >= 4) {
      await Promise.race(fileWork);
      assertHealthy();
    }
    const work = (async () => {
      try {
        const native = await inspectNativeFile(absolute, stats, targetRuntime);
        entries.push({ path, kind: "file", sha256: await sha256File(absolute), size: stats.size, mode, ...native });
      } catch (error) { recordFailure(error); }
    })();
    fileWork.add(work);
    void work.then(() => fileWork.delete(work));
  }
  async function visit(directory, prefix) {
    assertHealthy();
    const directoryStats = await lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw new Error(`VM release payload directory is not a real directory: ${prefix || "."}`);
    }
    entries.push({
      path: prefix || ".", kind: "directory", sha256: EMPTY_SHA256, size: 0,
      mode: payloadMode(directoryStats, prefix || "."),
    });
    const children = await readdir(directory);
    children.sort();
    for (const name of children) {
      assertHealthy();
      const path = prefix ? `${prefix}/${name}` : name;
      if (excludeManifest && path === "release-manifest.json") continue;
      const absolute = join(directory, name);
      const stats = await lstat(absolute);
      assertSafePayloadPath(path, stats);
      if (stats.isDirectory()) {
        await visit(absolute, path);
        continue;
      }
      const mode = payloadMode(stats, path);
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\")) {
          throw new Error(`absolute symlink is forbidden: ${path}`);
        }
        const lexicalTarget = resolve(dirname(absolute), target);
        if (!isInside(actualRoot, lexicalTarget)) {
          throw new Error(`symlink escapes VM release payload: ${path}`);
        }
        const effectiveTarget = await realpath(absolute);
        if (!isInside(actualRoot, effectiveTarget)) {
          throw new Error(`symlink resolves outside VM release payload: ${path}`);
        }
        if (/\.(?:node|so(?:\.\d+)*|dylib)$/i.test(path)) {
          const targetStats = await lstat(effectiveTarget);
          if (!targetStats.isFile() || !(await inspectNativeFile(effectiveTarget, targetStats, targetRuntime))) {
            throw new Error(`native module symlink does not resolve to a matching binary: ${path}`);
          }
        }
        const targetBytes = Buffer.from(target, "utf8");
        entries.push({ path, kind: "symlink", target, sha256: sha256(targetBytes), size: targetBytes.length, mode });
      } else if (stats.isFile()) {
        if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
          throw new Error(`VM release file size is unsupported: ${path}`);
        }
        await scheduleFile(absolute, path, stats, mode);
      } else {
        throw new Error(`unsupported filesystem entry in VM release payload: ${path}`);
      }
    }
  }
  try { await visit(actualRoot, ""); }
  catch (error) { recordFailure(error); }
  // A traversal error must not return while another admitted read/hash still owns a file handle.
  // Work records failures itself, including undefined; join every actual started task before throw.
  await Promise.allSettled([...fileWork]);
  assertHealthy();
  return entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function validateVmReleasePayload(root, role, {
  sealed = false,
  targetRuntime = currentVmReleaseTargetRuntime(),
} = {}) {
  assertVmReleaseRole(role);
  assertTargetRuntime(targetRuntime);
  const topLevel = (await readdir(root)).sort();
  const expectedTop = sealed
    ? ["dist", "node_modules", "release-manifest.json", "service"]
    : ["dist", "node_modules", "service"];
  if (topLevel.join("\0") !== expectedTop.join("\0")) {
    throw new Error("VM release payload has unexpected top-level entries");
  }
  for (const name of ["dist", "node_modules", "service"]) {
    const stats = await lstat(join(root, name));
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`VM release ${name}/ must be a real directory`);
    }
  }
  const serviceEntries = await readdir(join(root, "service"));
  if (serviceEntries.length !== 1 || serviceEntries[0] !== `${role}.service.template`) {
    throw new Error("VM release must contain exactly its own Linux systemd template");
  }
  const dist = join(root, "dist");
  const migrationStats = await lstat(join(dist, "migrations"));
  if (!migrationStats.isDirectory() || migrationStats.isSymbolicLink()) {
    throw new Error("dist/migrations/ must be a real directory");
  }
  const distEntries = (await readdir(dist)).sort();
  const expectedTopLevel = ["migrations", "package.json"];
  for (const entrypoint of VM_RELEASE_ENTRYPOINTS[role]) {
    expectedTopLevel.push(entrypoint, `${entrypoint}.map`);
  }
  if (distEntries.join("\0") !== expectedTopLevel.sort().join("\0")) {
    throw new Error("dist/ does not match the exact role entrypoint set");
  }
  const distPackageStats = await lstat(join(dist, "package.json"));
  if (!distPackageStats.isFile() || distPackageStats.isSymbolicLink()) {
    throw new Error("dist/package.json must be a regular file");
  }
  const distPackage = JSON.parse(await readFile(join(dist, "package.json"), "utf8"));
  if (Object.keys(distPackage).length !== 1 || distPackage.type !== "module") {
    throw new Error("dist/package.json must contain only type=module");
  }
  const migrations = await readdir(join(dist, "migrations"));
  if (migrations.length === 0 || migrations.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error("dist/migrations must contain the complete SQL migration set");
  }
  for (const name of migrations) {
    const stats = await lstat(join(dist, "migrations", name));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("dist/migrations contains a non-file SQL entry");
    }
  }
  const inventory = await inventoryVmReleasePayload(root, { excludeManifest: sealed, targetRuntime });
  for (const entrypoint of VM_RELEASE_ENTRYPOINTS[role]) {
    const file = inventory.find((entry) => entry.path === `dist/${entrypoint}`);
    if (file?.kind !== "file" || file.size === 0) {
      throw new Error(`missing executable role entrypoint: ${entrypoint}`);
    }
  }
  if (!inventory.some((entry) => entry.path.startsWith("node_modules/") && entry.kind === "file")) {
    throw new Error("production node_modules is empty");
  }
  return inventory;
}

/**
 * Verify without source checkout, pnpm, network or application startup. The digest MUST come from
 * an independent trusted build/promotion channel; a self-contained manifest cannot authenticate
 * its own provenance after an attacker has changed both it and the payload.
 */
export async function verifyVmReleaseDirectory(root, expectedRole, expectedManifestSha256) {
  return verifyVmReleaseDirectoryInternal(root, expectedRole, expectedManifestSha256, false);
}

/**
 * Complete verification while a newly extracted directory is still isolated at root mode 0700.
 * Only that root mode differs from the independently authenticated inventory. The caller must
 * separately restore and check its authenticated root mode before publishing a successful copy.
 * This does not relax normal verification, alter the manifest, or authorize application startup.
 */
export async function verifyVmReleaseQuarantinedDirectory(root, expectedRole, expectedManifestSha256) {
  return verifyVmReleaseDirectoryInternal(root, expectedRole, expectedManifestSha256, true);
}

async function verifyVmReleaseDirectoryInternal(root, expectedRole, expectedManifestSha256, quarantined) {
  const role = assertVmReleaseRole(expectedRole);
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
    throw new Error("trusted external manifest SHA-256 is required");
  }
  const manifestPath = join(root, "release-manifest.json");
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("release manifest must be a regular file");
  }
  if (payloadMode(manifestStat, "release-manifest.json") !== "0644") {
    throw new Error("release manifest must have mode 0644");
  }
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error("release manifest differs from trusted external digest");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!hasExactKeys(manifest, ["schema", "role", "releaseKind", "productionAccepted", "publishable", "targetRuntime", "source", "build", "files"])
    || !hasExactKeys(manifest.targetRuntime, ["nodeMajor", "platform", "arch"])
    || !hasExactKeys(manifest.source, ["sourceCommit", "sourceDirty", "lockSha256", "inputSha256", "inputFiles", "packageManager", "buildRuntime"])
    || !hasExactKeys(manifest.source?.buildRuntime, ["node", "platform", "arch"])
    || !hasExactKeys(manifest.build, ["installContract", "bundler", "dependencyClosure", "entrypoints", "migrationCount"])
    || manifest.schema !== "agent-service-vm-release-v1"
    || manifest.role !== role
    || manifest.releaseKind !== "node24-platform-process-directory"
    || manifest.targetRuntime.nodeMajor !== 24
    || !["linux", "darwin"].includes(manifest.targetRuntime.platform)
    || !["x64", "arm64"].includes(manifest.targetRuntime.arch)
    || manifest.targetRuntime.nodeMajor !== Number(process.versions.node.split(".")[0])
    || manifest.targetRuntime.platform !== process.platform
    || manifest.targetRuntime.arch !== process.arch
    || manifest.productionAccepted !== false
    || typeof manifest.publishable !== "boolean"
    || typeof manifest.source.sourceDirty !== "boolean"
    || manifest.publishable !== !manifest.source?.sourceDirty
    || typeof manifest.source?.sourceCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(manifest.source.sourceCommit)
    || typeof manifest.source?.lockSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.source.lockSha256)
    || typeof manifest.source?.inputSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.source.inputSha256)
    || typeof manifest.source?.buildRuntime?.node !== "string"
    || !/^24\.\d+\.\d+$/.test(manifest.source.buildRuntime.node)
    || manifest.source?.buildRuntime?.platform !== manifest.targetRuntime.platform
    || manifest.source?.buildRuntime?.arch !== manifest.targetRuntime.arch
    || typeof manifest.source?.packageManager !== "string"
    || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.source.packageManager)
    || !Number.isSafeInteger(manifest.build?.migrationCount)
    || manifest.build.migrationCount < 1) {
    throw new Error("invalid VM release provenance");
  }
  const inputFiles = manifest.source.inputFiles;
  if (!Array.isArray(inputFiles) || inputFiles.length === 0
    || inputFiles.some((entry) => !hasExactKeys(entry, ["path", "sha256", "size"])
      || !safeRelativePath(entry.path)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0)
    || inputFiles.map((entry) => entry.path).join("\0")
      !== [...new Set(inputFiles.map((entry) => entry.path))].sort().join("\0")
    || inputFiles.find((entry) => entry.path === "pnpm-lock.yaml")?.sha256 !== manifest.source.lockSha256
    || sha256(Buffer.from(JSON.stringify(inputFiles))) !== manifest.source.inputSha256) {
    throw new Error("invalid working build input inventory");
  }
  if (!Array.isArray(manifest.files)
    || manifest.files.some((entry) => !hasExactKeys(entry,
      entry?.kind === "symlink"
        ? ["path", "kind", "target", "sha256", "size", "mode"]
        : entry?.kind === "file" && Object.hasOwn(entry, "nativeFormat")
          ? ["path", "kind", "sha256", "size", "mode", "nativeFormat", "nativeArch"]
          : ["path", "kind", "sha256", "size", "mode"])
      || !(entry.kind === "directory" && entry.path === "." || safeRelativePath(entry.path))
      || !(entry.kind === "directory" && entry.path === "."
        || ["dist", "node_modules", "service"].includes(entry.path.split("/")[0]))
      || !["directory", "file", "symlink"].includes(entry.kind)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || typeof entry.mode !== "string" || !/^0[0-7]{3}$/.test(entry.mode)
      || !Number.isSafeInteger(entry.size) || entry.size < 0
      || (entry.kind === "file" && Object.hasOwn(entry, "nativeFormat")
        && (entry.nativeFormat !== (manifest.targetRuntime.platform === "linux" ? "elf64" : "macho64")
          || entry.nativeArch !== manifest.targetRuntime.arch))
      || (entry.kind === "directory" && (entry.sha256 !== EMPTY_SHA256 || entry.size !== 0))
      || (entry.kind === "symlink" && (typeof entry.target !== "string" || entry.target === "")))) {
    throw new Error("invalid VM release file inventory");
  }
  const expectedEntrypoints = VM_RELEASE_ENTRYPOINTS[role].map((name) => `dist/${name}`);
  if (JSON.stringify(manifest.build?.entrypoints) !== JSON.stringify(expectedEntrypoints)
    || manifest.build?.installContract !== "pnpm install --offline --frozen-lockfile --ignore-scripts"
    || manifest.build?.bundler !== "scripts/build-app.mjs"
    || manifest.build?.dependencyClosure
      !== `pnpm --filter ./apps/${role} --prod --offline --ignore-scripts --trust-lockfile --frozen-lockfile deploy`) {
    throw new Error("invalid VM release build contract");
  }
  if (quarantined) {
    const isolatedRoot = await lstat(root);
    if (!isolatedRoot.isDirectory() || isolatedRoot.isSymbolicLink()
      || payloadMode(isolatedRoot, ".") !== "0700") {
      throw new Error("quarantined VM release root must remain a real 0700 directory");
    }
  }
  const actual = await validateVmReleasePayload(root, role, { sealed: true, targetRuntime: manifest.targetRuntime });
  let comparable = actual;
  if (quarantined) {
    const actualRoot = actual.find((entry) => entry.path === ".");
    const expectedRoot = manifest.files.find((entry) => entry.path === ".");
    if (actualRoot?.kind !== "directory" || actualRoot.mode !== "0700"
      || expectedRoot?.kind !== "directory") {
      throw new Error("quarantined VM release root must remain a real 0700 directory");
    }
    comparable = actual.map((entry) => entry.path === "." ? { ...entry, mode: expectedRoot.mode } : entry);
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(comparable)) {
    throw new Error("VM release payload differs from complete manifest inventory");
  }
  const migrationCount = actual.filter((entry) => entry.path.startsWith("dist/migrations/") && entry.kind === "file").length;
  if (manifest.build.migrationCount !== migrationCount) {
    throw new Error("VM release migration count differs from manifest");
  }
  return manifest;
}
