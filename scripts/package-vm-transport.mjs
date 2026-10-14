#!/usr/bin/env node
// Package already-verified release bytes; never rebuild/reinstall the application or install a
// service. The bundled consumer is a separate artifact whose digest needs its own trusted channel.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packVmReleaseArchive } from "./lib/vm-release-archive.mjs";
import { verifyVmReleaseDirectory } from "./lib/vm-release.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VM_TRANSPORT_FILES = Object.freeze({ archive: "release.tar", tool: "vm-release-tool.mjs", proof: "transport-proof.json" });
const SOURCE_PATHS = Object.freeze([
  "scripts/lib/vm-release-archive.mjs", "scripts/lib/vm-release.mjs",
  "scripts/package-vm-transport.mjs", "scripts/vm-release-tool.mjs",
]);
const BUILD_INPUT_PATHS = Object.freeze(["package.json", "pnpm-lock.yaml"]);
const COMPILER_SPECIFIER = "^0.28.2";
const COMPILER_VERSION = "0.28.2";
const SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const TOOL_BYTES = 4 * 1024 * 1024;
const CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;
const CHILD_INPUT_BYTES = 24 * 1024 * 1024;
const BUNDLE_DEADLINE_MS = 120_000;
const HELP = `Usage: package-vm-transport --release <absolute-directory> --role agent-runner|agent-router
                            --manifest-sha256 <trusted-sha256> --output <new-absolute-directory>

Package an already verified target-specific Node 24 release without rebuilding the application.
The new private directory contains release.tar, vm-release-tool.mjs and transport-proof.json.
The tool and all four source inputs must exactly match the verified release's frozen input hashes.
Obtain tool, archive and manifest digests through an independent trusted channel; the proof does
not authenticate itself. Never overwrites output or installs/starts a service. Production remains
unaccepted. -h/--help opens no release, output or build resource.
`;

function failed() { return new Error("VM transport failed (operation_failed)"); }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function digest(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function absolute(value) {
  return typeof value === "string" && value !== "" && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
}
function validate(input) {
  if (!exact(input, ["release", "role", "manifestSha256", "output"])
    || !absolute(input.release) || !absolute(input.output) || !digest(input.manifestSha256)
    || typeof input.role !== "string" || !["agent-runner", "agent-router"].includes(input.role)
    || Number(process.versions.node.split(".")[0]) !== 24) throw failed();
}

function compilerText(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > SOURCE_FILE_BYTES) throw failed();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// This only detects duplicate JSON object keys (including escaped spellings); JSON.parse remains
// the grammar/shape authority. No custom general JSON decoder or YAML loader is introduced.
function uniqueJsonKeys(text) {
  const tokens = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\s+/gy;
  const stack = [];
  let at = 0;
  while (at < text.length) {
    tokens.lastIndex = at;
    const token = tokens.exec(text)?.[0];
    if (token === undefined) throw failed();
    at = tokens.lastIndex;
    if (/^\s+$/.test(token)) continue;
    if (token === "{" || token === "[") {
      if (stack.length >= 128) throw failed();
      stack.push({ object: token === "{", keyExpected: token === "{", keys: new Set() });
    } else if (token === "}" || token === "]") {
      if (stack.pop()?.object !== (token === "}")) throw failed();
    } else if (token === ",") {
      if (stack.at(-1)?.object) stack.at(-1).keyExpected = true;
    } else if (token.startsWith('"') && stack.at(-1)?.object && stack.at(-1).keyExpected) {
      const key = JSON.parse(token), frame = stack.at(-1);
      if (frame.keys.has(key)) throw failed();
      frame.keys.add(key); frame.keyExpected = false;
    }
  }
  if (stack.length !== 0) throw failed();
}

function lockMappingKey(line, spaces) {
  const prefix = " ".repeat(spaces);
  if (!line.startsWith(prefix) || line[spaces] === " " || !line.endsWith(":")) throw failed();
  const raw = line.slice(spaces, -1);
  const key = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
  if (!/^[A-Za-z0-9@_./-]+$/.test(key)) throw failed();
  return key;
}

/** Only the currently tested pnpm9 root importer/compiler contract is supported. */
export function deriveVmTransportCompilerContract(packageBytes, lockBytes) {
  try {
    const packageText = compilerText(packageBytes), lockText = compilerText(lockBytes);
    uniqueJsonKeys(packageText);
    const pkg = JSON.parse(packageText);
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)
      || pkg.devDependencies === null || typeof pkg.devDependencies !== "object" || Array.isArray(pkg.devDependencies)
      || pkg.devDependencies.esbuild !== COMPILER_SPECIFIER
      || Object.hasOwn(pkg.dependencies ?? {}, "esbuild") || Object.hasOwn(pkg.optionalDependencies ?? {}, "esbuild")) throw failed();
    if (/[\r\t\u0000]/.test(lockText)) throw failed();
    const lines = lockText.split("\n");
    const topKeys = new Set();
    for (const line of lines) {
      if (line === "" || line.startsWith(" ")) continue;
      const key = /^([A-Za-z][A-Za-z0-9]*):(?: .*)?$/.exec(line)?.[1];
      if (!key || !["lockfileVersion", "settings", "importers", "packages", "snapshots"].includes(key)
        || topKeys.has(key) || key !== "lockfileVersion" && line !== `${key}:`) throw failed();
      topKeys.add(key);
    }
    if (lines[0] !== "lockfileVersion: '9.0'"
      || lines.filter((line) => line.startsWith("lockfileVersion:")).length !== 1
      || lines.filter((line) => line === "importers:").length !== 1) throw failed();
    const importerStart = lines.indexOf("importers:");
    let importerEnd = importerStart + 1;
    while (importerEnd < lines.length && (lines[importerEnd] === "" || lines[importerEnd].startsWith(" "))) importerEnd += 1;
    const importerNames = new Set(); let root;
    for (let at = importerStart + 1; at < importerEnd;) {
      if (lines[at] === "") { at += 1; continue; }
      // pnpm9 emits a canonical '{}'-only importer for a workspace with no dependencies.
      // This exception is only for a non-root empty importer, never general flow YAML.
      const empty = lines[at].endsWith(": {}");
      const name = lockMappingKey(empty ? lines[at].slice(0, -3) : lines[at], 2);
      if (importerNames.has(name)) throw failed();
      importerNames.add(name);
      const start = ++at;
      while (at < importerEnd && (lines[at] === "" || lines[at].startsWith("    "))) at += 1;
      if (empty && (name === "." || lines.slice(start, at).some((line) => line !== ""))) throw failed();
      if (name === ".") root = lines.slice(start, at);
    }
    if (root === undefined) throw failed();
    const sections = new Map();
    for (let at = 0; at < root.length;) {
      if (root[at] === "") { at += 1; continue; }
      const name = lockMappingKey(root[at], 4);
      if (!["dependencies", "devDependencies", "optionalDependencies"].includes(name) || sections.has(name)) throw failed();
      const start = ++at;
      while (at < root.length && (root[at] === "" || root[at].startsWith("      "))) at += 1;
      sections.set(name, root.slice(start, at));
    }
    const dependencies = new Map();
    for (const [section, body] of sections) {
      const names = new Set();
      for (let at = 0; at < body.length;) {
        if (body[at] === "") { at += 1; continue; }
        const name = lockMappingKey(body[at], 6);
        if (names.has(name)) throw failed();
        names.add(name);
        const fields = Object.create(null); at += 1;
        while (at < body.length && body[at].startsWith("        ")) {
          const match = /^        (specifier|version): (\S+)$/.exec(body[at]);
          if (!match || Object.hasOwn(fields, match[1]) || /^[&*!]|[{}\[\]]/.test(match[2])) throw failed();
          fields[match[1]] = match[2]; at += 1;
        }
        if (!exact(fields, ["specifier", "version"])) throw failed();
        if (name === "esbuild") {
          if (section !== "devDependencies" || dependencies.has(name)) throw failed();
          dependencies.set(name, fields);
        }
      }
    }
    const compiler = dependencies.get("esbuild");
    if (!compiler || compiler.specifier !== COMPILER_SPECIFIER || compiler.version !== COMPILER_VERSION) throw failed();
    return Object.freeze({ name: "esbuild", specifier: COMPILER_SPECIFIER, version: COMPILER_VERSION,
      boundPackageSha256: sha(packageBytes), boundLockSha256: sha(lockBytes) });
  } catch { throw failed(); }
}

export function parseVmTransportArgs(args) {
  if (!Array.isArray(args) || args.length !== 8 || Array.from(args).some((arg) => typeof arg !== "string")) throw failed();
  const flags = { "--release": "release", "--role": "role", "--manifest-sha256": "manifestSha256", "--output": "output" };
  const input = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!Object.hasOwn(flags, args[i]) || Object.hasOwn(input, flags[args[i]])) throw failed();
    input[flags[args[i]]] = args[i + 1];
  }
  validate(input); return input;
}

async function assertNewOutput(output, release) {
  const parent = dirname(output);
  const stats = await lstat(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o7000) !== 0) throw failed();
  const candidate = join(await realpath(parent), basename(output));
  for (const forbidden of [await realpath(ROOT), await realpath(release)]) {
    const rel = relative(forbidden, candidate);
    if (rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) throw failed();
  }
  if (candidate === await realpath(parent)) throw failed();
  try { await lstat(output); } catch (error) { if (error.code === "ENOENT") return; throw failed(); }
  throw failed();
}

/** Each file is read exactly once from its O_NOFOLLOW fd; those bytes, not live paths, compile. */
async function readBoundedRegular(path, expectedSize) {
  const before = await lstat(path);
  const size = expectedSize ?? before.size;
  if (!Number.isSafeInteger(size) || size < 1 || size > SOURCE_FILE_BYTES
    || !before.isFile() || before.isSymbolicLink() || (before.mode & 0o7000) !== 0 || before.size !== size) throw failed();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o7000) !== 0 || stats.size !== size) throw failed();
    const bytes = Buffer.alloc(size); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw failed();
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0) throw failed();
    return bytes;
  } finally { await handle.close(); }
}

async function captureSources(manifest) {
  for (const dir of [ROOT, join(ROOT, "scripts"), join(ROOT, "scripts/lib")]) {
    const stats = await lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o7000) !== 0) throw failed();
  }
  const sources = [], buildInputs = new Map();
  for (const path of [...SOURCE_PATHS, ...BUILD_INPUT_PATHS]) {
    const expected = manifest.source.inputFiles.find((entry) => entry.path === path);
    if (!expected || !digest(expected.sha256) || !Number.isSafeInteger(expected.size)
      || expected.size < 1 || expected.size > SOURCE_FILE_BYTES) throw failed();
    const bytes = await readBoundedRegular(join(ROOT, path), expected.size);
    if (sha(bytes) !== expected.sha256) throw failed();
    compilerText(bytes);
    if (BUILD_INPUT_PATHS.includes(path)) buildInputs.set(path, bytes);
    else sources.push({ path, sha256: expected.sha256, size: expected.size, bytes });
  }
  const compiler = deriveVmTransportCompilerContract(buildInputs.get("package.json"), buildInputs.get("pnpm-lock.yaml"));
  if (compiler.boundLockSha256 !== manifest.source.lockSha256) throw failed();
  return { sources, compiler };
}

// Constant driver receives frozen bytes as data, not JavaScript from a caller or live source path.
// A minimal environment also reaches esbuild's native service; parent process.env is never changed.
const BUNDLE_DRIVER = String.raw`
import { builtinModules } from "node:module";
import { posix } from "node:path";
const names = ["scripts/lib/vm-release-archive.mjs", "scripts/lib/vm-release.mjs", "scripts/package-vm-transport.mjs", "scripts/vm-release-tool.mjs"];
const chunks = []; let total = 0;
for await (const part of process.stdin) { total += part.length; if (total > 25165824) throw new Error("input bounded"); chunks.push(part); }
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (input === null || typeof input !== "object" || Array.isArray(input)
  || Object.keys(input).sort().join("\0") !== ["esbuildModuleUrl", "expectedCompilerVersion", "sources"].sort().join("\0")
  || typeof input.esbuildModuleUrl !== "string" || input.expectedCompilerVersion !== "0.28.2"
  || !Array.isArray(input.sources) || input.sources.length !== 4) throw new Error("input invalid");
const url = new URL(input.esbuildModuleUrl);
if (url.protocol !== "file:" || url.search || url.hash) throw new Error("compiler invalid");
const sources = new Map();
for (let i = 0; i < names.length; i++) {
  const row = input.sources[i];
  if (row === null || typeof row !== "object" || Array.isArray(row)
    || Object.keys(row).sort().join("\0") !== ["path", "base64"].sort().join("\0")
    || row.path !== names[i] || typeof row.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.base64)) throw new Error("source invalid");
  const bytes = Buffer.from(row.base64, "base64");
  if (bytes.length < 1 || bytes.length > 4194304 || bytes.toString("base64") !== row.base64) throw new Error("source bounded");
  sources.set(row.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
const builtin = new Set(builtinModules.map(name => name.startsWith("node:") ? name : "node:" + name));
const esbuild = await import(url.href);
if (esbuild.version !== input.expectedCompilerVersion) throw new Error("compiler version does not match bound lock");
const result = await esbuild.build({
  entryPoints: ["scripts/vm-release-tool.mjs"], outfile: "/vm-release-tool.mjs", absWorkingDir: "/",
  bundle: true, write: false, target: "node24", platform: "node", format: "esm",
  sourcemap: false, sourcesContent: false, legalComments: "none", logLevel: "silent", metafile: true,
  plugins: [{ name: "frozen-vm-transport", setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (builtin.has(args.path)) return { path: args.path, external: true };
      const path = args.kind === "entry-point" ? args.path
        : args.path.startsWith(".") ? posix.normalize(posix.join(posix.dirname(args.importer), args.path)) : "";
      if (!sources.has(path)) throw new Error("non-frozen import forbidden");
      return { path, namespace: "frozen-vm-transport" };
    });
    build.onLoad({ filter: /.*/, namespace: "frozen-vm-transport" }, args => {
      if (!sources.has(args.path)) throw new Error("source unavailable");
      return { contents: sources.get(args.path), loader: "js" };
    });
  } }],
}).finally(() => esbuild.stop());
if (result.outputFiles.length !== 1 || result.outputFiles[0].contents.length < 1
  || result.outputFiles[0].contents.length > 4194304 || Object.keys(result.metafile.outputs).length !== 1) throw new Error("output bounded");
const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap(row => row.imports)
  .filter(row => row.external).map(row => row.path))].sort();
if (externalImports.some(path => !builtin.has(path))) throw new Error("runtime dependency forbidden");
const inputPaths = Object.keys(result.metafile.inputs).map(path => path.replace(/^frozen-vm-transport:/, "")).sort();
if (inputPaths.some(path => !names.includes(path)) || !inputPaths.includes("scripts/vm-release-tool.mjs")) throw new Error("source closure invalid");
process.stdout.write(JSON.stringify({ toolBase64: Buffer.from(result.outputFiles[0].contents).toString("base64"), externalImports, inputPaths, compilerVersion: esbuild.version }));
`;

async function bundleTool(sources, compiler) {
  const esbuildPath = await realpath(createRequire(import.meta.url).resolve("esbuild"));
  // Observed entry bytes are an audit fact about a trusted local install, not vendor authentication
  // or a promise that a hostile same-UID mutator cannot replace the compiler before its import.
  const observedEntrySha256 = sha(await readBoundedRegular(esbuildPath));
  const input = Buffer.from(JSON.stringify({
    esbuildModuleUrl: pathToFileURL(esbuildPath).href, expectedCompilerVersion: compiler.version,
    sources: sources.map(({ path, bytes }) => ({ path, base64: bytes.toString("base64") })),
  }));
  if (input.length > CHILD_INPUT_BYTES) throw failed();
  const childEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"]
    .filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]]));
  const bytes = await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", BUNDLE_DRIVER], {
      cwd: "/", env: childEnv, stdio: ["pipe", "pipe", "ignore"],
    });
    const parts = []; let size = 0; let rejected = false; let spawnFailed = false;
    const timer = setTimeout(() => { rejected = true; child.kill("SIGKILL"); }, BUNDLE_DEADLINE_MS);
    child.stdout.on("data", (part) => {
      size += part.length;
      if (size > CHILD_OUTPUT_BYTES) { rejected = true; child.kill("SIGKILL"); } else parts.push(part);
    });
    child.once("error", () => { spawnFailed = true; });
    child.stdin.once("error", () => { rejected = true; child.kill("SIGKILL"); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnFailed || rejected || signal || code !== 0) rejectChild(failed());
      else resolveChild(Buffer.concat(parts));
    });
    child.stdin.end(input);
  });
  let result;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw failed(); }
  const builtin = new Set(builtinModules.map((name) => name.startsWith("node:") ? name : `node:${name}`));
  const closure = SOURCE_PATHS.filter((path) => path !== "scripts/package-vm-transport.mjs");
  if (!exact(result, ["toolBase64", "externalImports", "inputPaths", "compilerVersion"])
    || result.compilerVersion !== compiler.version
    || typeof result.toolBase64 !== "string" || !Array.isArray(result.externalImports)
    || result.externalImports.some((value) => typeof value !== "string" || !builtin.has(value))
    || !Array.isArray(result.inputPaths) || JSON.stringify(result.inputPaths) !== JSON.stringify(closure)) throw failed();
  const tool = Buffer.from(result.toolBase64, "base64");
  if (tool.length < 1 || tool.length > TOOL_BYTES || tool.toString("base64") !== result.toolBase64
    || tool.includes(Buffer.from(ROOT))) throw failed();
  return { tool, compiler: { name: "esbuild", version: result.compilerVersion,
    boundPackageSha256: compiler.boundPackageSha256, boundLockSha256: compiler.boundLockSha256,
    observedEntrySha256, toolchainTrust: "trusted-local-install" } };
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o644); }
  finally { await handle.close(); }
}

/** Only successful exact proof is returned; a failed new output remains isolated and non-reusable. */
export async function packageVmTransport(input) {
  let created = false;
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw failed();
    input = { ...input };
    validate(input);
    const manifest = await verifyVmReleaseDirectory(input.release, input.role, input.manifestSha256);
    await assertNewOutput(input.output, input.release);
    const { sources, compiler } = await captureSources(manifest);
    const built = await bundleTool(sources, compiler);
    const { tool } = built;
    await mkdir(input.output, { mode: 0o700 }); created = true;
    await chmod(input.output, 0o700);
    const receipt = await packVmReleaseArchive({
      release: input.release, role: input.role, manifestSha256: input.manifestSha256,
      archive: join(input.output, VM_TRANSPORT_FILES.archive),
    });
    if (!exact(receipt, ["schema", "role", "targetRuntime", "manifestSha256", "archiveSha256", "archiveBytes", "entryCount", "productionAccepted"])
      || receipt.schema !== "agent-service-vm-release-archive-v1" || receipt.role !== input.role
      || receipt.manifestSha256 !== input.manifestSha256 || !digest(receipt.archiveSha256)
      || !Number.isSafeInteger(receipt.archiveBytes) || receipt.archiveBytes <= 0
      || !Number.isSafeInteger(receipt.entryCount) || receipt.entryCount <= 0
      || receipt.productionAccepted !== false
      || JSON.stringify(receipt.targetRuntime) !== JSON.stringify(manifest.targetRuntime)) throw failed();
    const proof = {
      schema: "agent-service-vm-release-transport-v1", role: input.role,
      targetRuntime: { nodeMajor: 24, platform: manifest.targetRuntime.platform, arch: manifest.targetRuntime.arch },
      archiveSha256: receipt.archiveSha256, manifestSha256: input.manifestSha256, toolSha256: sha(tool),
      archiveBytes: receipt.archiveBytes, entryCount: receipt.entryCount,
      sourceCommit: manifest.source.sourceCommit, sourceDirty: manifest.source.sourceDirty,
      publishable: manifest.publishable,
      toolSources: sources.map(({ path, sha256, size }) => ({ path, sha256, size })),
      compiler: built.compiler,
      productionAccepted: false,
    };
    await writeExclusive(join(input.output, VM_TRANSPORT_FILES.tool), tool);
    await writeExclusive(join(input.output, VM_TRANSPORT_FILES.proof), Buffer.from(`${JSON.stringify(proof, null, 2)}\n`));
    return proof;
  } catch {
    if (created) { try { await chmod(input.output, 0o700); } catch { /* no success proof is returned */ } }
    throw failed();
  }
}

export function isDirectVmTransportEntrypoint(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof importMetaUrl !== "string" || typeof argv1 !== "string" || argv1 === "") return false;
  try {
    const url = new URL(importMetaUrl);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    const modulePath = realpathSync(fileURLToPath(url)), invokedPath = realpathSync(argv1);
    return modulePath === invokedPath && statSync(modulePath).isFile() && statSync(invokedPath).isFile();
  } catch { return false; }
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (Number(process.versions.node.split(".")[0]) !== 24) throw failed();
    if (Array.isArray(args) && args.length === 1 && ["-h", "--help"].includes(args[0])) {
      process.stdout.write(HELP); return 0;
    }
    process.stdout.write(`${JSON.stringify(await packageVmTransport(parseVmTransportArgs(args)))}\n`); return 0;
  } catch { process.stderr.write("package-vm-transport failed (operation_failed)\n"); return 1; }
}
if (isDirectVmTransportEntrypoint(import.meta.url)) {
  main().then((status) => { process.exitCode = status; }, () => {
    process.stderr.write("package-vm-transport failed (operation_failed)\n"); process.exitCode = 1;
  });
}
