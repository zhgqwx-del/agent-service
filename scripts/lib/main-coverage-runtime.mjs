import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, jsonSha256, sha256 } from "./main-coverage-proof.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const VITEST_VERSION = "4.1.11";
// Every dedicated-profile gate used by the seventeen exact main skip files,
// including mysql-backup-artifact-test-helper's indirect gate. Never inherit an opt-in.
export const MAIN_DISABLED_PROFILE_FLAGS = Object.freeze([
  "AGENT_SERVICE_S3_INTEGRATION",
  "AGENT_SERVICE_REAL_E2E",
  "AGENT_SERVICE_BACKUP_CATALOG_RECONCILE_INTEGRATION",
  "AGENT_SERVICE_BACKUP_CATALOG_RESTORE_ROUNDTRIP_INTEGRATION",
  "AGENT_SERVICE_BACKUP_CATALOG_S3_INTEGRATION",
  "AGENT_SERVICE_RESTORE_JOURNAL_S3_INTEGRATION",
  "AGENT_SERVICE_TELEMETRY_CAPTURE_INTEGRATION",
  "AGENT_SERVICE_TENANT_TELEMETRY_S3_INTEGRATION",
  "AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION",
  "AGENT_SERVICE_MYSQL_BACKUP_ARTIFACT_INTEGRATION",
]);
export function parseArguments(argv, mode, environment = process.env) {
  const allowed = mode === "shard"
    ? ["shard", "run-id", "run-attempt", "source-commit", "artifact-dir"]
    : ["run-id", "run-attempt", "source-commit", "artifacts-dir", "output-dir"];
  const result = {};
  check(argv.length === allowed.length * 2, "argument_count");
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    check(argv[i]?.startsWith("--") && allowed.includes(key) && !Object.hasOwn(result, key), "argument_name");
    result[key] = argv[i + 1];
  }
  check(/^[1-9][0-9]{0,19}$/.test(result["run-id"]) && /^[1-9][0-9]{0,8}$/.test(result["run-attempt"])
    && /^[0-9a-f]{40}$/.test(result["source-commit"]), "argument_identity");
  if (mode === "shard") check(/^[123]$/.test(result.shard), "argument_shard");
  for (const key of allowed.filter((key) => key.endsWith("-dir"))) {
    check(path.isAbsolute(result[key]) && path.resolve(result[key]) === result[key] && result[key] !== ROOT && result[key] !== "/", "argument_directory");
  }
  if (environment.GITHUB_ACTIONS === "true") {
    check(result["run-id"] === environment.GITHUB_RUN_ID && result["run-attempt"] === environment.GITHUB_RUN_ATTEMPT
      && result["source-commit"] === environment.GITHUB_SHA, "github_identity");
  }
  return result;
}
export async function assertNoSymlink(target) {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = await lstat(current);
    check(!stat.isSymbolicLink(), "symlink");
  }
}
export async function createOwnedDirectory(directory) {
  await assertNoSymlink(path.dirname(directory));
  try { await lstat(directory); check(false, "output_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(directory, { mode: 0o700 });
}
export async function createJson(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
}
export async function stableFile(file, maxBytes = 1024 * 1024 * 1024) {
  await assertNoSymlink(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    check(before.isFile() && before.size > 0 && before.size <= maxBytes, "input_file");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    check(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.length === before.size, "input_changed");
    return { bytes, stat: after, digest: { sha256: sha256(bytes), size: bytes.length } };
  } finally { await handle.close(); }
}
export async function stableJson(file) {
  const result = await stableFile(file);
  return { ...result, value: JSON.parse(result.bytes.toString("utf8")) };
}
function git(args) {
  const result = spawnSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" },
  });
  check(result.status === 0 && !result.signal && !result.error, "source_git");
  return result.stdout;
}
export async function sourceIdentity(commit) {
  check(git(["rev-parse", "HEAD"]).trim() === commit, "source_commit");
  check(git(["status", "--porcelain=v1", "--untracked-files=all"]).length === 0, "source_dirty");
  try { await lstat(path.join(ROOT, ".env")); check(false, "dotenv_present"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const tracked = git(["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean).map((entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/.exec(entry);
    check(match, "source_tree_entry");
    return { mode: match[1], oid: match[2], file: match[3] };
  }).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  check(tracked.length > 0, "source_empty");
  const image = [];
  for (const { file, oid, mode } of tracked) {
    const absolute = path.join(ROOT, file);
    const stat = await lstat(absolute);
    check(stat.isFile() && !stat.isSymbolicLink(), "source_file");
    const bytes = await readFile(absolute);
    const actualOid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    check(actualOid === oid && Boolean(stat.mode & 0o111) === (mode === "100755"), "source_blob");
    image.push([file, stat.mode & 0o777, sha256(bytes)]);
  }
  const config = await readFile(path.join(ROOT, "vitest.config.ts"), "utf8");
  check(/testTimeout:\s*30_000/.test(config) && /hookTimeout:\s*60_000/.test(config) && /fileParallelism:\s*false/.test(config)
    && /thresholds:\s*\{\s*statements:\s*72,\s*branches:\s*61,\s*functions:\s*68,\s*lines:\s*76\s*\}/.test(config), "canonical_config");
  const dependencyFiles = ["node_modules/vitest/package.json", "node_modules/vitest/vitest.mjs", "node_modules/vitest/dist/cli.js", "node_modules/@vitest/coverage-v8/package.json", "node_modules/@vitest/coverage-v8/dist/provider.js"];
  const dependencies = [];
  for (const file of dependencyFiles) {
    const bytes = await readFile(path.join(ROOT, file));
    if (file.endsWith("package.json")) check(JSON.parse(bytes).version === VITEST_VERSION, "vitest_version");
    dependencies.push([file, sha256(bytes)]);
  }
  return { schema: "main-coverage-source-v1", sourceCommit: commit, sourceSha256: jsonSha256(image), sourceFiles: image.length,
    configSha256: sha256(config), collectConfigSha256: sha256(await readFile(path.join(ROOT, "vitest.coverage-shard.config.ts"))),
    lockSha256: sha256(await readFile(path.join(ROOT, "pnpm-lock.yaml"))), manifestSha256: sha256(await readFile(path.join(ROOT, "scripts/required-coverage-suites.mjs"))),
    vitestVersion: VITEST_VERSION, dependencySha256: jsonSha256(dependencies), nodeVersion: process.version };
}
export function nativeEnvironment(environment = process.env) {
  const env = { ...environment, AGENT_SERVICE_INTEGRATION: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("VITEST_") || name === "NODE_OPTIONS" || name === "NODE_V8_COVERAGE"
      || name === "API_KEY") delete env[name];
  }
  for (const name of MAIN_DISABLED_PROFILE_FLAGS) env[name] = "0";
  return env;
}
// No custom test list/filter is accepted by either public entry point.
export async function runVitest(args, env) {
  const executable = await realpath(path.join(ROOT, "node_modules/vitest/vitest.mjs"));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd: ROOT, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
export async function assertFreshFile(file, startedAtMs, finishedAtMs) {
  const result = await stableFile(file);
  check(result.stat.mtimeMs >= startedAtMs && result.stat.mtimeMs <= finishedAtMs, "file_window");
  return result;
}
