import { copyFile, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { REQUIRED_COVERAGE_GROUPS, REQUIRED_COVERAGE_TEST_FILES } from "./required-coverage-suites.mjs";
import { assertMainCoverage, assertMainMergedAssertions, assertMainShardReport, assertMainShardUnion, assertNativeMergeExit, assertReceipt, assertSameSet, check, discoveryFiles } from "./lib/main-coverage-proof.mjs";
import { ROOT, assertFreshFile, assertNoSymlink, createJson, createOwnedDirectory, nativeEnvironment, parseArguments, runVitest, sourceIdentity, stableFile, stableJson } from "./lib/main-coverage-runtime.mjs";

async function main() {
  const options = parseArguments(process.argv.slice(2), "merge");
  const artifacts = options["artifacts-dir"];
  const output = options["output-dir"];
  await assertNoSymlink(artifacts);
  assertSameSet(await readdir(artifacts), [1, 2, 3].map((n) => `main-coverage-shard-${n}`), "artifact_directories");
  await createOwnedDirectory(output);
  const aggregateStartedAtMs = Date.now();
  const identity = await sourceIdentity(options["source-commit"]);
  const blobDirectory = path.join(output, "native-blobs");
  await mkdir(blobDirectory, { mode: 0o700 });
  const inputs = [];
  const reports = [];
  const rawReports = [];
  let expectedDiscovery;
  for (let shard = 1; shard <= 3; shard++) {
    const directory = path.join(artifacts, `main-coverage-shard-${shard}`);
    await assertNoSymlink(directory);
    assertSameSet(await readdir(directory), ["receipt.json", "tests.json", "blob.json", "discovery.json"], "artifact_files");
    const receiptFile = await stableJson(path.join(directory, "receipt.json"));
    const receipt = receiptFile.value;
    assertReceipt(receipt, { runId: options["run-id"], runAttempt: options["run-attempt"], sourceCommit: options["source-commit"], shard, root: ROOT, identity });
    const bound = {};
    for (const name of ["tests.json", "blob.json", "discovery.json"]) {
      const input = await stableFile(path.join(directory, name));
      const expected = receipt.files[name];
      check(input.digest.sha256 === expected.sha256 && input.digest.size === expected.size, "input_digest");
      // Artifact transport may reset filesystem mtimes. Native freshness was checked
      // before upload and is bound in the receipt; report execution times are checked again.
      bound[name] = input;
    }
    const discovery = discoveryFiles(JSON.parse(bound["discovery.json"].bytes.toString("utf8")), ROOT);
    if (expectedDiscovery) assertSameSet(discovery, expectedDiscovery, "discovery_disagreement");
    else expectedDiscovery = discovery;
    const rawReport = JSON.parse(bound["tests.json"].bytes.toString("utf8"));
    rawReports.push(rawReport);
    reports.push(assertMainShardReport(rawReport, {
      root: ROOT, discovery, requiredFiles: REQUIRED_COVERAGE_TEST_FILES,
      startedAtMs: receipt.startedAtMs, finishedAtMs: receipt.finishedAtMs,
    }));
    const destination = path.join(blobDirectory, `shard-${shard}.json`);
    await copyFile(path.join(directory, "blob.json"), destination, constants.COPYFILE_EXCL);
    check(JSON.stringify((await stableFile(destination)).digest) === JSON.stringify(bound["blob.json"].digest), "blob_copy_changed");
    inputs.push({ shard, receiptSha256: receiptFile.digest.sha256, receipt, directory });
  }
  const discoveryPath = path.join(output, "discovery.json");
  const listed = await runVitest(["list", "--filesOnly", `--json=${discoveryPath}`, "--exclude", "test/cluster/**", "--config", "vitest.config.ts"], nativeEnvironment());
  check(listed.code === 0 && listed.signal === null, "aggregate_discovery_exit");
  const currentDiscovery = await assertFreshFile(discoveryPath, aggregateStartedAtMs, Date.now());
  assertSameSet(discoveryFiles(JSON.parse(currentDiscovery.bytes.toString("utf8")), ROOT), expectedDiscovery, "aggregate_discovery");
  const union = assertMainShardUnion(reports, { discovery: expectedDiscovery, requiredFiles: REQUIRED_COVERAGE_TEST_FILES, groups: REQUIRED_COVERAGE_GROUPS });
  // Merge only the three bound blobs. The official reader treats every file in this folder as a blob.
  const mergeStartedAtMs = Date.now();
  const native = await runVitest(["--merge-reports", blobDirectory, "--config", "vitest.config.ts", "--coverage",
    `--coverage.reportsDirectory=${path.join(output, "coverage")}`, "--reporter=default", "--reporter=json",
    `--outputFile.json=${path.join(output, "tests.json")}`], nativeEnvironment());
  const mergeFinishedAtMs = Date.now();
  // Native JSON is emitted BEFORE native coverage checks: JSON success alone cannot award this gate.
  assertNativeMergeExit(native);
  const merged = await assertFreshFile(path.join(output, "tests.json"), mergeStartedAtMs, mergeFinishedAtMs);
  const mergedReport = JSON.parse(merged.bytes.toString("utf8"));
  const mergedWindowStart = Math.min(...inputs.map((input) => input.receipt.startedAtMs));
  const mergedProof = assertMainShardReport(mergedReport, { root: ROOT, discovery: expectedDiscovery,
    requiredFiles: REQUIRED_COVERAGE_TEST_FILES, startedAtMs: mergedWindowStart, finishedAtMs: mergeFinishedAtMs });
  assertSameSet(mergedProof.files, expectedDiscovery, "merged_discovery");
  check(mergedProof.passed === union.passed && mergedProof.skipped === union.skipped, "merged_counts");
  assertMainMergedAssertions(rawReports, mergedReport, ROOT);
  const summary = await assertFreshFile(path.join(output, "coverage/coverage-summary.json"), mergeStartedAtMs, mergeFinishedAtMs);
  const coverage = JSON.parse(summary.bytes.toString("utf8"));
  assertMainCoverage(coverage, ROOT);
  for (const input of inputs) {
    check((await stableFile(path.join(input.directory, "receipt.json"))).digest.sha256 === input.receiptSha256, "receipt_changed");
    for (const name of ["tests.json", "blob.json", "discovery.json"]) {
      const actual = (await stableFile(path.join(input.directory, name))).digest;
      check(actual.sha256 === input.receipt.files[name].sha256 && actual.size === input.receipt.files[name].size, "input_changed");
    }
  }
  check(JSON.stringify(identity) === JSON.stringify(await sourceIdentity(options["source-commit"])), "source_changed");
  await createJson(path.join(output, "proof.json"), { schema: "main-coverage-aggregate-v1", runId: options["run-id"], runAttempt: options["run-attempt"],
    sourceCommit: options["source-commit"], identity, sourceUnchanged: true, independentShards: 3, nativeMergeExitCode: 0,
    mergeStartedAtMs, mergeFinishedAtMs, coverageGate: "passed", union, inputs: inputs.map(({ directory: _directory, ...input }) => input),
    discovery: currentDiscovery.digest, mergedReport: merged.digest, coverageSummary: summary.digest, globalCoverage: coverage.total });
  console.log(`required main coverage aggregate passed: 3 shards; unique required files=${union.requiredFiles}; groups=${union.groups.length}; coverage gates preserved`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^Main coverage proof rejected: [a-z_]+$/.test(error.message)
    ? error.message : "Main coverage aggregate failed");
  process.exitCode = 1;
});
