import { createHash } from "node:crypto";
import path from "node:path";
import { assertRequiredCoverage, assertRequiredTestResults } from "./required-suite-proof.mjs";

export const MAIN_SHARD_COUNT = 3;
export const MAIN_GLOBAL_THRESHOLDS = Object.freeze({ statements: 72, branches: 61, functions: 68, lines: 76 });
export const EXPECTED_MAIN_SKIPS = Object.freeze({
  "apps/agent-runner/test/mysql-backup-artifact.mysql-s3.test.ts": [21, "a6fba78b68d874279c26a95a6e58a727e8483feed9d45a1a33768bc02c304aa2"],
  "packages/core/test/skills-registered.s3.test.ts": [1, "be483945bfdee994bc04c891b1b6f29281ce24e800da091063a4c2e62455a848"],
  "packages/providers/test/e2e-qwen.test.ts": [1, "a981cbb01ea24f4fb963de5b67f9c5a809ab7cde45a3381fbd40232fe403d430"],
  "packages/store/test/backup-catalog-reconcile.mysql-s3.test.ts": [1, "990d5faf36864bb348c1a73c448aa187eac7c8a0ac5f1d3d9aafc2a582cf8444"],
  "packages/store/test/backup-catalog-restore-roundtrip.mysql-s3.test.ts": [1, "b2272d548936214e2e75a026b392b8915269762f0ecdf2f3de8b19b3ad68e72d"],
  "packages/store/test/backup-catalog-s3.minio.test.ts": [6, "efd6060f1ba4baf47ff4c9f109890a83adeac6a6756b08e532ee6dc01a6a86b7"],
  "packages/store/test/blob-s3.minio.test.ts": [10, "9437efc9c7139c6470eb97aa4ecf2cd98a599f2522fc2d5e53a8b591623788d1"],
  "packages/store/test/blob-storage-migration.mysql-s3.test.ts": [11, "ec5c20c1647c4430ab44c3843434f4828e03f3563f0e07e3b200d9c7c627dd7f"],
  "packages/store/test/restore-journal-s3.minio.test.ts": [4, "bcaeb6f2fa109451bcdeb2cb8fe5ac5b027be8c8731320b7d8b95364e20c59c6"],
  "packages/store/test/telemetry-capture-restore.mysql-s3.test.ts": [2, "e920e1da0ad092b002994863cfda7010eb6c33c40cde61d8808f47771965729c"],
  "packages/store/test/telemetry-capture.mysql-s3.test.ts": [7, "a1d946b6c6633bbf2f861cd068a15814eeec3fb52e866004e89eeee411162119"],
  "packages/store/test/tenant-telemetry-adapter-s3.minio.test.ts": [5, "ea48980adc1c55f51d89e8c77a6a0a14fb1b3a283288007f0fd88abf80bab29e"],
  "packages/store/test/tenant-telemetry-artifact-observer.minio.test.ts": [4, "e38abd46f94f0c15c753714cd0a3ef742e262b79be393abd1a86ad233430cffb"],
  "packages/store/test/tenant-telemetry-disposition-journal-v3-observer.minio.test.ts": [3, "25a353156a6c811c4d57356d9afdbb0fbe1d9df648d9079018887db376856b60"],
  "packages/store/test/tenant-telemetry-disposition-journal-v3.minio.test.ts": [4, "1ad13d598b5f41c190ddfb96bf6b89b570bb208e975f557e52636422dfc5e02f"],
  "packages/store/test/tenant-telemetry-disposition-s3.minio.test.ts": [3, "d0103381cb11b3c795b7b6036896f8ed9aa1b751bae1b029ea4d20cb3db6b976"],
  "packages/store/test/tenant-telemetry-grant-v2-s3-observer.minio.test.ts": [3, "4b61e08486daee2a745660d575d88b1ba9e6f315f9aafc97de0e7d589c3abd3b"],
});

export function check(condition, code) {
  if (!condition) throw new Error(`Main coverage proof rejected: ${code}`);
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function jsonSha256(value) { return sha256(JSON.stringify(value)); }
export function canonicalFile(file, root) {
  check(typeof file === "string" && path.isAbsolute(file), "absolute_test_path");
  const relative = path.relative(root, file).split(path.sep).join("/");
  check(relative && !relative.startsWith("../") && !path.isAbsolute(relative) && relative.endsWith(".test.ts")
    && path.resolve(root, relative) === file && !relative.startsWith("test/cluster/"), "canonical_test_path");
  return relative;
}
export function discoveryFiles(discovery, root) {
  check(Array.isArray(discovery) && discovery.length > 0, "discovery_empty");
  const files = discovery.map((entry) => {
    check(entry && Object.keys(entry).length === 1 && Object.hasOwn(entry, "file"), "discovery_shape");
    return canonicalFile(entry.file, root);
  });
  check(new Set(files).size === files.length, "discovery_duplicate");
  return files.sort();
}
export function assertSameSet(actual, expected, code) {
  check(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), code);
}
export function assertMainShardReport(report, options) {
  const { root, discovery, requiredFiles, startedAtMs, finishedAtMs, expectedSkips = EXPECTED_MAIN_SKIPS } = options;
  const allFiles = new Set(discovery);
  check(report && report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0
    && report.numTodoTests === 0 && (report.numRuntimeErrorTestSuites ?? 0) === 0, "report_failure");
  check(Array.isArray(report.testResults) && report.testResults.length > 0, "report_empty");
  check(Number.isInteger(startedAtMs) && Number.isInteger(finishedAtMs) && finishedAtMs >= startedAtMs
    && Number.isFinite(report.startTime) && report.startTime >= startedAtMs && report.startTime <= finishedAtMs, "report_window");
  if (report.testExecError != null || report.unhandledErrors?.length || report.errors?.length) check(false, "report_unhandled");
  const seen = new Set();
  let passed = 0;
  let skipped = 0;
  for (const suite of report.testResults) {
    const file = canonicalFile(suite.name, root);
    check(allFiles.has(file) && !seen.has(file), "report_file_set");
    seen.add(file);
    check(Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0, "empty_suite");
    check(Number.isFinite(suite.startTime) && Number.isFinite(suite.endTime) && suite.startTime >= startedAtMs
      && suite.endTime >= suite.startTime && suite.endTime <= finishedAtMs, "suite_window");
    check(!suite.message && suite.failureMessage == null && suite.testExecError == null, "suite_error");
    const titles = [];
    for (const assertion of suite.assertionResults) {
      check(Array.isArray(assertion.failureMessages) && assertion.failureMessages.length === 0
        && (assertion.failureDetails == null || assertion.failureDetails.length === 0), "assertion_error");
      check(typeof assertion.fullName === "string" && assertion.fullName.length > 0, "assertion_title");
      check(assertion.status === "passed" || assertion.status === "pending" || assertion.status === "skipped", "assertion_status");
      if (assertion.status === "passed") passed++;
      else { titles.push(assertion.fullName); skipped++; }
    }
    if (titles.length > 0) {
      const expected = expectedSkips[file];
      check(expected && titles.length === suite.assertionResults.length && titles.length === expected[0]
        && jsonSha256(titles.sort()) === expected[1] && !requiredFiles.includes(file)
        && ["passed", "pending", "skipped"].includes(suite.status), "unexpected_skip");
    } else check(suite.status === "passed" && !expectedSkips[file], "suite_status");
  }
  check(report.numPassedTests === passed && report.numPendingTests === skipped && report.numTotalTests === passed + skipped, "report_counts");
  const assignedRequired = requiredFiles.filter((file) => seen.has(file));
  const required = assignedRequired.length ? assertRequiredTestResults(report, {
    root, requiredFiles: assignedRequired, startedAtMs, finishedAtMs,
  }) : [];
  return { files: [...seen].sort(), required, passed, skipped };
}
export function assertMainShardUnion(shards, options) {
  const { discovery, requiredFiles, groups, expectedSkips = EXPECTED_MAIN_SKIPS } = options;
  check(shards.length === MAIN_SHARD_COUNT, "shard_count");
  const seen = new Set();
  const required = new Map();
  let passed = 0;
  let skipped = 0;
  for (const shard of shards) {
    for (const file of shard.files) { check(!seen.has(file), "shard_overlap"); seen.add(file); }
    for (const item of shard.required) { check(!required.has(item.file), "required_duplicate"); required.set(item.file, item.passed); }
    passed += shard.passed;
    skipped += shard.skipped;
  }
  assertSameSet([...seen], discovery, "discovery_union");
  assertSameSet([...required.keys()], requiredFiles, "required_union");
  check(Object.keys(expectedSkips).every((file) => seen.has(file)), "skip_inventory_missing");
  check(skipped === Object.values(expectedSkips).reduce((sum, [count]) => sum + count, 0), "skip_total");
  const groupProof = Object.entries(groups).map(([name, files]) => {
    check(files.length > 0 && new Set(files).size === files.length && files.every((file) => required.has(file)), "group_subset");
    return { name, files: files.length, passed: files.reduce((sum, file) => sum + required.get(file), 0) };
  });
  return { discoveredFiles: seen.size, requiredFiles: required.size, requiredAssertions: [...required.values()].reduce((a, b) => a + b, 0), passed, skipped, groups: groupProof };
}
export function assertMainCoverage(summary, root) {
  for (const [metric, floor] of Object.entries(MAIN_GLOBAL_THRESHOLDS)) {
    check(Number.isFinite(summary?.total?.[metric]?.pct) && summary.total[metric].pct >= floor, `global_${metric}`);
  }
  assertRequiredCoverage(summary, root);
}
export function assertMainMergedAssertions(rawReports, mergedReport, root) {
  function assertionSets(reports) {
    const files = new Map();
    for (const report of reports) {
      check(Array.isArray(report?.testResults), "assertion_report");
      for (const suite of report.testResults) {
        const file = canonicalFile(suite.name, root);
        check(!files.has(file) && Array.isArray(suite.assertionResults), "assertion_file_duplicate");
        // A sorted list, not a Set: two equal titles still represent two real test cases.
        const assertions = suite.assertionResults.map((assertion) => {
          check(typeof assertion.fullName === "string" && typeof assertion.status === "string", "assertion_identity");
          return JSON.stringify([assertion.fullName, assertion.status]);
        }).sort();
        files.set(file, assertions);
      }
    }
    return files;
  }
  const original = assertionSets(rawReports);
  const merged = assertionSets([mergedReport]);
  assertSameSet([...merged.keys()], [...original.keys()], "merged_assertion_files");
  for (const [file, assertions] of original) {
    check(JSON.stringify(merged.get(file)) === JSON.stringify(assertions), "merged_assertion_multiset");
  }
}
export function assertNativeMergeExit(native) {
  // JSON reporter success does not imply that the later native coverage phase passed.
  check(native?.code === 0 && native?.signal === null, "merge_native_exit");
}
export function assertReceipt(receipt, expected) {
  const keys = ["schema", "runId", "runAttempt", "sourceCommit", "shard", "shardCount", "root", "identity", "startedAtMs", "finishedAtMs", "nativeExitCode", "sourceUnchanged", "collectionValid", "coverageGate", "files"];
  assertSameSet(Object.keys(receipt), keys, "receipt_fields");
  check(receipt.schema === "main-coverage-shard-v1" && receipt.shardCount === 3 && receipt.coverageGate === "pending"
    && receipt.nativeExitCode === 0 && receipt.sourceUnchanged === true && receipt.collectionValid === true, "receipt_state");
  for (const key of ["runId", "runAttempt", "sourceCommit", "shard", "root"]) check(receipt[key] === expected[key], `receipt_${key}`);
  check(JSON.stringify(receipt.identity) === JSON.stringify(expected.identity), "receipt_identity");
  check(Number.isInteger(receipt.startedAtMs) && Number.isInteger(receipt.finishedAtMs)
    && receipt.startedAtMs <= receipt.finishedAtMs && receipt.finishedAtMs <= Date.now(), "receipt_window");
  assertSameSet(Object.keys(receipt.files), ["tests.json", "blob.json", "discovery.json"], "receipt_files");
  for (const value of Object.values(receipt.files)) {
    assertSameSet(Object.keys(value), ["sha256", "size", "mtimeMs"], "receipt_file_fields");
    check(/^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0
      && Number.isFinite(value.mtimeMs) && value.mtimeMs >= receipt.startedAtMs && value.mtimeMs <= receipt.finishedAtMs, "receipt_file_window");
  }
}
