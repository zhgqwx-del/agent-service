import { spawnSync } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigrationReport, migrationCiIdentity, migrationRegularFile, migrationShardFiles,
  migrationSourceIdentity, migrationVitestArgs } from "./lib/migration-shard-proof.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let output;
let metadata;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--shard" || !/^[123]\/3$/.test(args[1])) throw new Error();
  const shard = Number(args[1][0]);
  const expected = migrationCiIdentity(process.env, ROOT);
  const before = await migrationSourceIdentity(ROOT, expected);
  const parent = resolve(ROOT, ".local-run/migration-shards");
  await mkdir(parent, { recursive: true });
  if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error();
  output = resolve(parent, String(shard));
  // A retry must use a fresh workflow attempt; an old green directory is never reused.
  await mkdir(output, { mode: 0o700 });
  const reportFile = resolve(output, "tests.json");
  const startedAtMs = Date.now();
  metadata = { schema: "migration-shard-v1", kind: "history", status: "failed", source: before.source,
    checkoutRoot: ROOT, shard, shardCount: 3, files: migrationShardFiles(before.files, shard),
    startedAtMs, finishedAtMs: startedAtMs, nativeExitCode: null, reportSha256: null, reportBytes: 0, proof: [] };
  const result = spawnSync(process.execPath, migrationVitestArgs(ROOT, before.files, shard, reportFile), {
    cwd: ROOT, env: process.env, stdio: "inherit",
  });
  metadata.finishedAtMs = Date.now();
  metadata.nativeExitCode = result.status;
  if (result.error || result.signal || result.status !== 0) throw new Error();
  const reportInput = await migrationRegularFile(output, "tests.json");
  metadata.reportSha256 = reportInput.sha256;
  metadata.reportBytes = reportInput.bytes.length;
  if (Math.floor(reportInput.mtimeMs) < startedAtMs || Math.floor(reportInput.mtimeMs) > metadata.finishedAtMs) throw new Error();
  metadata.proof = assertMigrationReport(JSON.parse(reportInput.bytes.toString("utf8")), {
    root: ROOT, files: metadata.files, startedAtMs, finishedAtMs: metadata.finishedAtMs, nativeExitCode: result.status,
  });
  const after = await migrationSourceIdentity(ROOT, expected);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error();
  metadata.status = "passed";
  await writeFile(resolve(output, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const cases = metadata.proof.reduce((sum, row) => sum + row.passed, 0);
  console.log(`historical shard proof: shard=${shard}/3 files=${metadata.files.length} passed=${cases} native=0`);
} catch {
  if (output && metadata) {
    metadata.status = "failed";
    // Preserve a native failure receipt if possible. Never promote a JSON emitted before exit1.
    await writeFile(resolve(output, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: "wx", mode: 0o600,
    }).catch(() => {});
  }
  console.error("historical migration shard failed");
  process.exitCode = 1;
}
