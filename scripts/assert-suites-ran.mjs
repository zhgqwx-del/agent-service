// The MySQL/Redis conformance suite and the dialect suite skip themselves when their environment is
// missing. A misconfigured CI job would then pass with a large part of the suite silently absent, so
// assert both the exercised implementation coverage and the exact required test-file results.
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summary = JSON.parse(await readFile(resolve(ROOT, "coverage/coverage-summary.json"), "utf8"));
const testReportPath = resolve(
  ROOT,
  process.env.AGENT_SERVICE_TEST_REPORT ?? ".local-run/verify-tests.json",
);
const testReport = JSON.parse(await readFile(testReportPath, "utf8"));

const required = [
  ["packages/store/src/mysql/store.ts", 40, "MySQL store — set AGENT_SERVICE_INTEGRATION=1 and MYSQL_TEST_URL"],
  ["packages/store/src/redis/lease.ts", 40, "Redis lease — set AGENT_SERVICE_INTEGRATION=1 and REDIS_TEST_URL"],
  ["packages/core/src/engine/pi.ts", 30, "PiEngine — the dialect tests against the fake vendor must run"],
];

let failed = false;
for (const [file, minLines, hint] of required) {
  const key = Object.keys(summary).find((k) => k.endsWith(file));
  const pct = key ? summary[key].lines.pct : 0;
  if (pct < minLines) {
    console.error(`✗ ${file}: ${pct}% line coverage (expected ≥ ${minLines}%). ${hint}`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${pct}%`);
  }
}

const requiredTestFiles = [
  "packages/store/test/blob-lifecycle.mysql.test.ts",
  "packages/store/test/usage-lifecycle.mysql.test.ts",
  "packages/store/test/subject-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation-races.mysql.test.ts",
  "packages/store/test/retention-policy.mysql.test.ts",
  "packages/store/test/erasure-purge-policy.mysql.test.ts",
  "packages/store/test/erasure-job.mysql.test.ts",
  "packages/store/test/erasure-session.mysql.test.ts",
  "packages/store/test/erasure-catalog.mysql.test.ts",
  "packages/store/test/erasure-usage.mysql.test.ts",
  "packages/store/test/legacy-tombstone-compensation.mysql.test.ts",
  "packages/store/test/user-data-export.mysql.test.ts",
  "packages/core/test/erasure-worker.mysql.test.ts",
];
for (const file of requiredTestFiles) {
  const suffix = `/${file}`;
  const result = testReport.testResults?.find((entry) =>
    String(entry.name).split("\\").join("/").endsWith(suffix),
  );
  const assertions = result?.assertionResults ?? [];
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const nonPassed = assertions.filter((assertion) => assertion.status !== "passed").length;
  if (!result || result.status !== "passed" || passed === 0 || nonPassed > 0) {
    console.error(
      `✗ ${file}: required test file did not execute cleanly `
      + `(file=${result?.status ?? "missing"}, passed=${passed}, nonPassed=${nonPassed})`,
    );
    failed = true;
  } else {
    console.log(`✓ ${file}: ${passed} tests executed and passed`);
  }
}
process.exit(failed ? 1 : 0);
