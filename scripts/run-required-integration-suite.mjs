import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
if (!requested) throw new Error("usage: run-required-integration-suite.mjs <test-file>");

const testFile = resolve(ROOT, requested);
const relativeTestFile = relative(ROOT, testFile).split(sep).join("/");
if (!relativeTestFile.startsWith("packages/store/test/") || !relativeTestFile.endsWith(".mysql.test.ts")) {
  throw new Error(`refusing non-MySQL integration suite: ${relativeTestFile}`);
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
console.log(`required integration proof: ${relativeTestFile} executed ${passed} passing tests`);
