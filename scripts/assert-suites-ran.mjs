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
  ["packages/store/src/redis/purge.ts", 60, "Redis purge — set AGENT_SERVICE_INTEGRATION=1 and REDIS_TEST_URL"],
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
  "packages/protocol/test/telemetry.test.ts",
  "packages/core/test/host.test.ts",
  "packages/core/test/pi-provider-failure.test.ts",
  "packages/core/test/host-persisted-provider-failure.test.ts",
  "packages/core/test/persisted-provider-failure-capture.test.ts",
  "packages/core/test/persisted-provider-capture-worker.test.ts",
  "apps/agent-runner/test/persisted-provider-capture-gate.test.ts",
  "apps/agent-runner/test/persisted-provider-capture-ready.test.ts",
  "apps/agent-router/test/persisted-provider-capture.test.ts",
  "apps/agent-runner/test/telemetry-capture-ref-key.test.ts",
  "apps/agent-runner/test/telemetry-capture-cli.test.ts",
  "apps/agent-runner/test/telemetry-capture-wrapper.test.ts",
  "apps/agent-runner/test/backup-catalog-cli.test.ts",
  "apps/agent-runner/test/restore-ledger-reconcile-cli.test.ts",
  "apps/agent-runner/test/backup-catalog-wrapper.test.ts",
  "apps/agent-runner/test/restore-ledger-reconcile-wrapper.test.ts",
  "packages/store/test/persisted-provider-capture.memory.test.ts",
  "packages/store/test/persisted-provider-capture.mysql.test.ts",
  "apps/agent-runner/test/mysql-backup-artifact.unit.test.ts",
  "packages/store/test/operation-abort.test.ts",
  "packages/store/test/backup-catalog-s3.unit.test.ts",
  "packages/store/test/restore-journal-s3.unit.test.ts",
  "packages/store/test/session-delete-grace.memory.test.ts",
  "packages/store/test/session-delete-grace.mysql.test.ts",
  "packages/core/test/ordinary-session-delete-grace-recovery.test.ts",
  "apps/agent-runner/test/ordinary-session-delete-grace-recovery.mysql.test.ts",
  "packages/store/test/ordinary-usage-retention-proof.test.ts",
  "packages/store/test/ordinary-session-usage-retention.memory.test.ts",
  "packages/store/test/ordinary-session-usage-retention.mysql.test.ts",
  "packages/core/test/ordinary-session-usage-retention-worker.test.ts",
  "apps/agent-runner/test/ordinary-session-usage-retention-gate.test.ts",
  "apps/agent-router/test/ordinary-session-usage-retention.test.ts",
  "apps/agent-runner/test/ordinary-session-usage-retention.mysql.test.ts",
  "apps/agent-router/test/app.test.ts",
  "packages/store/test/blob-lifecycle.mysql.test.ts",
  "packages/store/test/blob-storage-control.memory.test.ts",
  "packages/store/test/blob-storage-control.mysql.test.ts",
  "packages/store/test/tenant-telemetry-adapter-s3.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition.test.ts",
  "packages/store/test/tenant-telemetry-disposition-adapter-memory.test.ts",
  "packages/store/test/tenant-telemetry-disposition-s3.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition.memory.test.ts",
  "packages/store/test/tenant-telemetry-disposition.mysql.test.ts",
  "packages/store/test/tenant-telemetry-disposition-grant-v2-memory-fixture.test.ts",
  "packages/store/test/tenant-telemetry-grant-v2-s3-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition-journal-v3.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition-journal-v3-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-artifact-observer.unit.test.ts",
  "packages/store/test/tenant-telemetry-disposition-grant.mysql.test.ts",
  "packages/store/test/lifecycle-outbox.mysql.test.ts",
  "packages/store/test/usage-lifecycle.mysql.test.ts",
  "packages/store/test/subject-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation.mysql.test.ts",
  "packages/store/test/tenant-credential-revocation-races.mysql.test.ts",
  "packages/store/test/tenant-credential-physical-revocation.mysql.test.ts",
  "packages/store/test/tenant-credential-lifecycle.mysql.test.ts",
  "packages/store/test/tenant-runtime-revocation.mysql.test.ts",
  "packages/store/test/tenant-content-inventory.mysql.test.ts",
  "packages/store/test/tenant-purge-plan.mysql.test.ts",
  "packages/store/test/tenant-purge-execution.mysql.test.ts",
  "packages/store/test/memory-tenant-database-purge.test.ts",
  "packages/store/test/mysql-tenant-database-purge.test.ts",
  "packages/store/test/tenant-redis-purge.test.ts",
  "packages/store/test/mysql-tenant-redis-purge.test.ts",
  "packages/store/test/redis-tenant-purge.test.ts",
  "packages/core/test/tenant-redis-purge-worker.test.ts",
  "apps/agent-runner/test/tenant-redis-purge-gate.test.ts",
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
