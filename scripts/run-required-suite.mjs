import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
if (!requested) throw new Error("usage: run-required-suite.mjs <test-file>");

const testFile = resolve(ROOT, requested);
const relativeTestFile = relative(ROOT, testFile).split(sep).join("/");
if (!(relativeTestFile.startsWith("packages/store/test/")
    || relativeTestFile.startsWith("packages/core/test/")
    || relativeTestFile.startsWith("packages/providers/test/")
    || relativeTestFile.startsWith("packages/protocol/test/")
    || relativeTestFile === "packages/sdk/test/skills.test.ts"
    || relativeTestFile === "packages/sdk/test/mcp.test.ts"
    || relativeTestFile === "packages/sdk/test/sse.test.ts"
    || relativeTestFile === "packages/sdk/test/tenant-hooks.test.ts"
    || relativeTestFile === "packages/sdk/test/subagents.test.ts"
    || relativeTestFile === "packages/sdk/test/record-assistant-reference.test.ts"
    || relativeTestFile.startsWith("apps/agent-runner/test/")
    || relativeTestFile.startsWith("apps/agent-router/test/")
    || relativeTestFile === "test/openapi-contract.test.ts"
    || relativeTestFile === "test/local-service-tool-authority.test.ts"
    || relativeTestFile === "test/local-service-external-infra.test.ts"
    || relativeTestFile === "test/http-experience.test.ts"
    || relativeTestFile === "test/http-experience-fixture.test.ts"
    || relativeTestFile === "test/mysql-runtime-fixture.test.ts"
    || relativeTestFile === "test/mysql-schema-cli-executor.test.ts"
    || relativeTestFile === "test/ci-owned-mysql-authority.test.ts"
    || relativeTestFile === "test/ci-image-runtime.test.ts"
    || relativeTestFile === "test/harness-startup-ownership.test.ts"
    || relativeTestFile === "test/main-coverage-shards.test.ts"
    || relativeTestFile === "test/ci/migration-shards.test.ts"
    || relativeTestFile === "test/ci-required-jobs.test.ts"
    || relativeTestFile === "test/required-coverage-manifest.test.ts"
    || relativeTestFile === "test/required-suite-proof.test.ts"
    || relativeTestFile === "test/vm-release.test.ts"
    || relativeTestFile === "test/vm-release-archive.test.ts"
    || relativeTestFile === "test/vm-release-tool.test.ts"
    || relativeTestFile === "test/vm-release-signature.test.ts"
    || relativeTestFile === "test/vm-release-signed.test.ts"
    || relativeTestFile === "test/vm-release-sign-cli.test.ts")
  || !relativeTestFile.endsWith(".test.ts")) {
  throw new Error(`refusing test suite outside approved package tests: ${relativeTestFile}`);
}

const reportDir = resolve(ROOT, ".local-run");
const reportFile = resolve(reportDir, `${relativeTestFile.split("/").at(-1)}.json`);
await mkdir(reportDir, { recursive: true });

const vitestEntrypoint = resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [
  vitestEntrypoint,
  "run",
  relativeTestFile,
  "--reporter=verbose",
  "--reporter=json",
  `--outputFile.json=${reportFile}`,
], {
  cwd: ROOT,
  env: { ...process.env, AGENT_SERVICE_INTEGRATION: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const report = JSON.parse(await readFile(reportFile, "utf8"));
const expectedSuffix = `/${relativeTestFile}`;
const fileResult = report.testResults?.find((entry) =>
  String(entry.name).split("\\").join("/").endsWith(expectedSuffix),
);
const assertions = fileResult?.assertionResults ?? [];
const passed = assertions.filter((assertion) => assertion.status === "passed").length;
const nonPassed = assertions.filter((assertion) => assertion.status !== "passed");
if (!fileResult || fileResult.status !== "passed" || passed === 0 || nonPassed.length > 0) {
  throw new Error(
    `${relativeTestFile} did not execute cleanly: file=${fileResult?.status ?? "missing"}, `
      + `passed=${passed}, nonPassed=${nonPassed.length}`,
  );
}
console.log(`required suite proof: ${relativeTestFile} executed ${passed} passing tests`);
