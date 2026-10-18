import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMigrationAggregate, migrationCiIdentity, migrationRegularFile,
  migrationSourceIdentity } from "./lib/migration-shard-proof.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--input-dir" || !isAbsolute(args[1]) || resolve(args[1]) !== args[1]) throw new Error();
  const parent = args[1];
  if (parent !== resolve(ROOT, ".local-run/migration-shards") || await realpath(parent) !== parent) throw new Error();
  const expected = migrationCiIdentity(process.env, ROOT);
  const before = await migrationSourceIdentity(ROOT, expected);
  if (JSON.stringify((await readdir(parent)).sort()) !== JSON.stringify(["1", "2", "3"])) throw new Error();
  const shards = [];
  for (const index of [1, 2, 3]) {
    const directory = resolve(parent, String(index));
    if (await realpath(directory) !== directory || JSON.stringify((await readdir(directory)).sort())
        !== JSON.stringify(["metadata.json", "tests.json"])) throw new Error();
    const meta = await migrationRegularFile(directory, "metadata.json", 128 * 1024);
    const raw = await migrationRegularFile(directory, "tests.json");
    const metadata = JSON.parse(meta.bytes.toString("utf8"));
    if (metadata.shard !== index) throw new Error();
    // Download mtimes are not execution clocks. The bound original process window is in metadata
    // and is independently checked against each raw report's timestamps and assertion results.
    shards.push({ metadata, report: JSON.parse(raw.bytes.toString("utf8")),
      reportSha256: raw.sha256, reportBytes: raw.bytes.length, metadataSha256: meta.sha256 });
  }
  const proof = assertMigrationAggregate(shards, { root: ROOT, files: before.files, source: before.source, nowMs: Date.now() });
  const after = await migrationSourceIdentity(ROOT, expected);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error();
  const output = resolve(ROOT, `.local-run/migration-aggregate-${expected.runId}-${expected.runAttempt}`);
  await mkdir(output, { mode: 0o700 });
  await writeFile(resolve(output, "aggregate-proof.json"), `${JSON.stringify({ ...proof, aggregatedAtMs: Date.now(),
    rawReportsRetained: true, shards: shards.map((shard) => ({ shard: shard.metadata.shard,
      startedAtMs: shard.metadata.startedAtMs, finishedAtMs: shard.metadata.finishedAtMs,
      nativeExitCode: shard.metadata.nativeExitCode, reportSha256: shard.reportSha256,
      metadataSha256: shard.metadataSha256 })) }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`aggregated historical migration proof: shards=3 files=${proof.fileCount} passed=${proof.passed} failed=0 skipped=0`);
} catch {
  console.error("historical migration aggregation failed");
  process.exitCode = 1;
}
