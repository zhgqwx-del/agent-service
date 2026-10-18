import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export const MIGRATION_SHARD_COUNT = 3;
export const MIGRATION_FILE_COUNT = 57;
export const MIGRATION_DRIVER = "scripts/run-required-migration-suites.mjs";
export const MIGRATION_CONFIG = "packages/store/test/migrations/vitest.config.ts";
const DIRECTORY = "packages/store/test/migrations";
const fail = () => { throw new Error("migration shard proof rejected"); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const normalized = (value) => value.split(sep).join("/");
const exactKeys = (value, keys) => object(value) && same(Object.keys(value).sort(), [...keys].sort());

function migrationPath(value) {
  return typeof value === "string" && /^packages\/store\/test\/migrations\/[A-Za-z0-9_-]+\.migration\.ts$/.test(value)
    && value === posix.normalize(value);
}

/** The old driver's declaration remains the sole manifest; no second copied list can drift. */
export function parseMigrationManifest(source, discovered) {
  if (typeof source !== "string" || !Array.isArray(discovered)) fail();
  const declarations = [...source.matchAll(/const requiredTestFiles = \[([\s\S]*?)\n\];/g)];
  if (declarations.length !== 1) fail();
  const body = declarations[0][1].replace(/^[ \t]*\/\/[^\n]*(?:\n|$)/gm, "");
  const files = [...body.matchAll(/"([^"]+)"\s*,/g)].map((entry) => entry[1]);
  if (body.replace(/\s*"[^"]+"\s*,/g, "").trim() !== ""
      || files.length !== MIGRATION_FILE_COUNT || new Set(files).size !== files.length
      || files.some((file) => !migrationPath(file)) || discovered.some((file) => !migrationPath(file))
      || new Set(discovered).size !== discovered.length
      || !same([...files].sort(), [...discovered].sort())) fail();
  return files;
}

export function migrationShardFiles(files, shard) {
  if (!Array.isArray(files) || files.length !== MIGRATION_FILE_COUNT || new Set(files).size !== files.length
      || files.some((file) => !migrationPath(file)) || ![1, 2, 3].includes(shard)) fail();
  return files.filter((_, index) => index % MIGRATION_SHARD_COUNT === shard - 1);
}

export function migrationCiIdentity(env, root) {
  if (env.GITHUB_ACTIONS !== "true" || env.CI !== "true" || env.GITHUB_WORKSPACE !== root
      || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")
      || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "")
      || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) fail();
  return { headSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT };
}

export function migrationVitestArgs(root, files, shard, reportFile) {
  const assigned = migrationShardFiles(files, shard);
  return [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", resolve(root, MIGRATION_CONFIG),
    ...assigned, "--reporter=verbose", "--reporter=json", `--outputFile.json=${reportFile}`];
}

export async function migrationRegularFile(root, file, maximumBytes = 32 * 1024 * 1024) {
  if (typeof file !== "string" || file.includes("\\") || isAbsolute(file) || file !== posix.normalize(file)
      || file.startsWith("../") || file === ".." || file === ".") fail();
  const absolute = resolve(root, file);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes || await realpath(absolute) !== absolute) fail();
  const bytes = await readFile(absolute);
  const after = await lstat(absolute);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || stat.dev !== after.dev) fail();
  return { bytes, sha256: hash(bytes), mtimeMs: stat.mtimeMs };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") fail();
  return result.stdout;
}

/** All tracked bytes/modes, not just the reported files, bind the actual clean checkout. */
export async function migrationSourceIdentity(root, expected) {
  if (await realpath(root) !== root || git(root, ["rev-parse", "HEAD"]).trim() !== expected.headSha
      || git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") fail();
  const tracked = git(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
  const inputs = [];
  for (const entry of tracked) {
    const match = /^(100644|100755) [a-f0-9]{40} 0\t([^\n]+)$/.exec(entry);
    if (!match) fail();
    const { bytes, sha256 } = await migrationRegularFile(root, match[2]);
    const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob !== entry.slice(7, 47)) fail();
    inputs.push({ file: match[2], mode: match[1], sha256 });
  }
  if (new Set(inputs.map((entry) => entry.file)).size !== inputs.length || inputs.length === 0) fail();
  const driver = await migrationRegularFile(root, MIGRATION_DRIVER);
  const discovered = (await readdir(resolve(root, DIRECTORY), { recursive: true }))
    .filter((name) => name.endsWith(".migration.ts")).map((name) => `${DIRECTORY}/${normalized(name)}`);
  const files = parseMigrationManifest(driver.bytes.toString("utf8"), discovered);
  const config = await migrationRegularFile(root, MIGRATION_CONFIG);
  const configText = config.bytes.toString("utf8");
  if (!/\bfileParallelism:\s*false\s*,/.test(configText)
      || !/\btestTimeout:\s*30_000\s*,/.test(configText) || !/\bhookTimeout:\s*60_000\s*,/.test(configText)) fail();
  const lock = await migrationRegularFile(root, "pnpm-lock.yaml");
  const version = JSON.parse((await readFile(resolve(root, "node_modules/vitest/package.json"), "utf8"))).version;
  if (version !== "4.1.11") fail();
  const fixtures = inputs.filter((entry) => entry.file.startsWith(`${DIRECTORY}/`));
  if (fixtures.length < files.length || files.some((file) => !fixtures.some((entry) => entry.file === file))) fail();
  return {
    files,
    source: { ...expected, sourceSha256: hash(JSON.stringify(inputs)), driverSha256: driver.sha256,
      manifestSha256: hash(JSON.stringify(files)), configSha256: config.sha256,
      fixtureSha256: hash(JSON.stringify(fixtures)), lockSha256: lock.sha256, vitestVersion: version },
  };
}

/** Native status and every file/hook/assertion are checked, not JSON.success alone. */
export function assertMigrationReport(report, { root, files, startedAtMs, finishedAtMs, nativeExitCode }) {
  if (!isAbsolute(root) || !integer(startedAtMs) || !integer(finishedAtMs) || finishedAtMs < startedAtMs
      || nativeExitCode !== 0 || !Array.isArray(files) || files.length === 0
      || new Set(files).size !== files.length || files.some((file) => !migrationPath(file))) fail();
  if (!object(report) || report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0
      || report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numPendingTestSuites !== 0
      || (report.numRuntimeErrorTestSuites !== undefined && report.numRuntimeErrorTestSuites !== 0)
      || !integer(report.numTotalTestSuites) || report.numTotalTestSuites === 0
      || report.numPassedTestSuites !== report.numTotalTestSuites || !integer(report.startTime)
      || report.startTime < startedAtMs || report.startTime > finishedAtMs
      || !Array.isArray(report.testResults) || report.testResults.length !== files.length) fail();
  const rows = new Map();
  let count = 0;
  for (const result of report.testResults) {
    if (!object(result) || typeof result.name !== "string" || !isAbsolute(result.name)
        || result.name.includes("\\") || result.name !== resolve(result.name)) fail();
    const file = normalized(relative(root, result.name));
    if (!files.includes(file) || result.name !== resolve(root, file) || rows.has(file)
        || result.status !== "passed" || result.message !== "" || result.failureMessage || result.testExecError
        || result.failureDetails?.length || result.failureMessages?.length
        || !Number.isFinite(result.startTime) || !Number.isFinite(result.endTime)
        || result.startTime < report.startTime || result.endTime < result.startTime || result.endTime > finishedAtMs
        || !Array.isArray(result.assertionResults) || result.assertionResults.length === 0) fail();
    for (const assertion of result.assertionResults) {
      if (!object(assertion) || assertion.status !== "passed" || typeof assertion.fullName !== "string"
          || assertion.fullName.length === 0 || !Array.isArray(assertion.failureMessages)
          || assertion.failureMessages.length !== 0 || assertion.failureDetails?.length) fail();
    }
    count += result.assertionResults.length;
    rows.set(file, { file, passed: result.assertionResults.length });
  }
  if (report.numTotalTests !== count || report.numPassedTests !== count) fail();
  return files.map((file) => rows.get(file));
}

const SOURCE_KEYS = ["headSha", "runId", "runAttempt", "sourceSha256", "driverSha256", "manifestSha256",
  "configSha256", "fixtureSha256", "lockSha256", "vitestVersion"];
const METADATA_KEYS = ["schema", "kind", "status", "source", "checkoutRoot", "shard", "shardCount", "files",
  "startedAtMs", "finishedAtMs", "nativeExitCode", "reportSha256", "reportBytes", "proof"];

export function assertMigrationShard(metadata, report, { root, files, source, nowMs, reportSha256, reportBytes }) {
  if (!exactKeys(metadata, METADATA_KEYS) || !exactKeys(metadata.source, SOURCE_KEYS)
      || !SOURCE_KEYS.filter((key) => key.endsWith("Sha256")).every((key) => digest(metadata.source[key]))
      || !same(metadata.source, source) || metadata.schema !== "migration-shard-v1" || metadata.kind !== "history"
      || metadata.status !== "passed" || metadata.checkoutRoot !== root || metadata.shardCount !== MIGRATION_SHARD_COUNT
      || !same(metadata.files, migrationShardFiles(files, metadata.shard)) || !integer(nowMs)
      || !integer(metadata.finishedAtMs) || metadata.finishedAtMs > nowMs
      || metadata.reportSha256 !== reportSha256 || !digest(reportSha256) || !integer(reportBytes)
      || reportBytes === 0 || metadata.reportBytes !== reportBytes) fail();
  const proof = assertMigrationReport(report, { root, files: metadata.files, startedAtMs: metadata.startedAtMs,
    finishedAtMs: metadata.finishedAtMs, nativeExitCode: metadata.nativeExitCode });
  if (!same(metadata.proof, proof)) fail();
  return proof;
}

export function assertMigrationAggregate(shards, options) {
  if (!Array.isArray(shards) || shards.length !== MIGRATION_SHARD_COUNT) fail();
  const seen = new Set();
  const rows = [];
  for (const shard of shards) {
    if (!object(shard) || seen.has(shard.metadata?.shard)) fail();
    const proof = assertMigrationShard(shard.metadata, shard.report, { ...options,
      reportSha256: shard.reportSha256, reportBytes: shard.reportBytes });
    seen.add(shard.metadata.shard);
    rows.push(...proof);
  }
  if (!same([...seen].sort(), [1, 2, 3]) || rows.length !== MIGRATION_FILE_COUNT
      || new Set(rows.map((row) => row.file)).size !== MIGRATION_FILE_COUNT
      || !same(rows.map((row) => row.file).sort(), [...options.files].sort())) fail();
  return { schema: "migration-aggregate-v1", execution: "aggregated_three_independent_shards",
    singleProcessExecution: false, source: options.source, shardCount: MIGRATION_SHARD_COUNT,
    fileCount: rows.length, passed: rows.reduce((sum, row) => sum + row.passed, 0), failed: 0, skipped: 0, todo: 0,
    files: options.files.map((file) => rows.find((row) => row.file === file)) };
}
