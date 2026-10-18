import path from "node:path";
import { REQUIRED_COVERAGE_TEST_FILES } from "./required-coverage-suites.mjs";
import { assertMainShardReport, check, discoveryFiles } from "./lib/main-coverage-proof.mjs";
import { ROOT, assertFreshFile, createJson, createOwnedDirectory, nativeEnvironment, parseArguments, runVitest, sourceIdentity, stableJson } from "./lib/main-coverage-runtime.mjs";

async function main() {
  const options = parseArguments(process.argv.slice(2), "shard");
  const directory = options["artifact-dir"];
  await createOwnedDirectory(directory);
  const startedAtMs = Date.now();
  const identity = await sourceIdentity(options["source-commit"]);
  const files = {};
  let nativeExitCode = null;
  let sourceUnchanged = false;
  let collectionValid = false;
  let failure;
  try {
    const env = nativeEnvironment();
    const discoveryPath = path.join(directory, "discovery.json");
    const listed = await runVitest(["list", "--filesOnly", `--json=${discoveryPath}`, "--exclude", "test/cluster/**", "--config", "vitest.coverage-shard.config.ts"], env);
    check(listed.code === 0 && listed.signal === null, "discovery_native_exit");
    const discovery = discoveryFiles((await stableJson(discoveryPath)).value, ROOT);
    check(REQUIRED_COVERAGE_TEST_FILES.every((file) => discovery.includes(file)), "required_discovery");
    const native = await runVitest(["run", "--config", "vitest.coverage-shard.config.ts", "--coverage", `--shard=${options.shard}/3`,
      "--exclude", "test/cluster/**", "--reporter=default", "--reporter=json", "--reporter=blob",
      `--outputFile.json=${path.join(directory, "tests.json")}`, `--outputFile.blob=${path.join(directory, "blob.json")}`], env);
    nativeExitCode = native.code;
    check(native.code === 0 && native.signal === null, "collection_native_exit");
    const finishedAtMs = Date.now();
    assertMainShardReport((await stableJson(path.join(directory, "tests.json"))).value, {
      root: ROOT, discovery, requiredFiles: REQUIRED_COVERAGE_TEST_FILES, startedAtMs, finishedAtMs,
    });
    for (const name of ["tests.json", "blob.json", "discovery.json"]) {
      const input = await assertFreshFile(path.join(directory, name), startedAtMs, finishedAtMs);
      files[name] = { ...input.digest, mtimeMs: input.stat.mtimeMs };
    }
    sourceUnchanged = JSON.stringify(identity) === JSON.stringify(await sourceIdentity(options["source-commit"]));
    check(sourceUnchanged, "source_changed");
    collectionValid = true;
  } catch (error) { failure = error; }
  const finishedAtMs = Date.now();
  await createJson(path.join(directory, "receipt.json"), {
    schema: "main-coverage-shard-v1", runId: options["run-id"], runAttempt: options["run-attempt"],
    sourceCommit: options["source-commit"], shard: Number(options.shard), shardCount: 3, root: ROOT, identity,
    startedAtMs, finishedAtMs, nativeExitCode, sourceUnchanged, collectionValid, coverageGate: "pending", files,
  });
  if (failure) throw failure;
  console.log(`main coverage shard collection passed: ${options.shard}/3 (coverage gate pending)`);
}

main().catch((error) => {
  // Never echo native error objects, environment URLs or raw test bodies.
  console.error(error instanceof Error && /^Main coverage proof rejected: [a-z_]+$/.test(error.message)
    ? error.message : "Main coverage shard collection failed");
  process.exitCode = 1;
});
