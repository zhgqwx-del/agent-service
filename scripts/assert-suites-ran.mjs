import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRequiredCoverage, assertRequiredTestResults } from "./lib/required-suite-proof.mjs";
import { REQUIRED_COVERAGE_GROUPS, REQUIRED_COVERAGE_TEST_FILES } from "./required-coverage-suites.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const startedAtMs = Number(process.env.AGENT_SERVICE_TEST_STARTED_AT_MS);
const finishedAtMs = Number(process.env.AGENT_SERVICE_TEST_FINISHED_AT_MS);
if (!process.env.AGENT_SERVICE_TEST_REPORT || !Number.isSafeInteger(startedAtMs)
    || !Number.isSafeInteger(finishedAtMs)) {
  throw new Error("use scripts/run-required-coverage.mjs to generate a fresh execution-bound report");
}
const reportPath = resolve(ROOT, process.env.AGENT_SERVICE_TEST_REPORT);
const summaryPath = resolve(ROOT, "coverage/coverage-summary.json");
const [reportBytes, summaryBytes, reportInfo, summaryInfo] = await Promise.all([
  readFile(reportPath, "utf8"), readFile(summaryPath, "utf8"), stat(reportPath), stat(summaryPath),
]);
if (reportInfo.mtimeMs < startedAtMs || summaryInfo.mtimeMs < startedAtMs) {
  throw new Error("required suite proof rejected: stale report or coverage output");
}
const report = JSON.parse(reportBytes);
const files = assertRequiredTestResults(report, {
  root: ROOT, requiredFiles: REQUIRED_COVERAGE_TEST_FILES, startedAtMs, finishedAtMs,
});
for (const { file, pct } of assertRequiredCoverage(JSON.parse(summaryBytes), ROOT)) {
  console.log(`required implementation coverage: ${file}: ${pct}%`);
}
const byFile = new Map(files.map((entry) => [entry.file, entry.passed]));
for (const { file, passed } of files) console.log(`required suite proof: ${file}: ${passed} passing test cases`);
for (const [command, group] of Object.entries(REQUIRED_COVERAGE_GROUPS)) {
  if (new Set(group).size !== group.length || group.some((file) => !byFile.has(file))) {
    throw new Error(`required suite proof rejected: unregistered or duplicate group member: ${command}`);
  }
  const passed = group.reduce((total, file) => total + byFile.get(file), 0);
  console.log(`required group proof (same execution, subset): ${command}: ${group.length} files / ${passed} passing test cases`);
}
console.log(`required main proof: ${files.length} unique files / ${files.reduce((sum, file) => sum + file.passed, 0)} passing test cases; groups are subsets, not extra executions`);
