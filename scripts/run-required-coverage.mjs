import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.length !== 2) throw new Error("usage: node scripts/run-required-coverage.mjs (no filtering options)");
const stateDir = resolve(ROOT, ".local-run");
await mkdir(stateDir, { recursive: true });
const attemptDir = await mkdtemp(resolve(stateDir, "coverage-attempt-"));
const reportFile = resolve(attemptDir, "tests.json");
const startedAtMs = Date.now();
const env = { ...process.env, AGENT_SERVICE_INTEGRATION: "1" };
console.log(`main coverage execution report: ${reportFile}`);
// A fresh, run-owned path and the immediate child exit status prevent reuse of an old green JSON.
// Keep normal Vitest discovery, serial DB semantics and all coverage thresholds unchanged.
const result = spawnSync(process.execPath, [
  resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--coverage", "--exclude", "test/cluster/**",
  "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`,
], { cwd: ROOT, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const finishedAtMs = Date.now();
const proof = spawnSync(process.execPath, [resolve(ROOT, "scripts/assert-suites-ran.mjs")], {
  cwd: ROOT,
  env: {
    ...env,
    AGENT_SERVICE_TEST_REPORT: reportFile,
    AGENT_SERVICE_TEST_STARTED_AT_MS: String(startedAtMs),
    AGENT_SERVICE_TEST_FINISHED_AT_MS: String(finishedAtMs),
  },
  stdio: "inherit",
});
if (proof.error) throw proof.error;
if (proof.status !== 0) process.exit(proof.status ?? 1);
// Keep the documented convenience path; the attempt report above is the authoritative original.
await copyFile(reportFile, resolve(stateDir, "verify-tests.json"));
