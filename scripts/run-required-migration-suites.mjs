import { mkdir, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationTestDir = resolve(ROOT, "packages/store/test/migrations");
const reportDir = resolve(ROOT, ".local-run");
const reportFile = resolve(reportDir, "migration-tests.json");
const configFile = resolve(migrationTestDir, "vitest.config.ts");
await mkdir(reportDir, { recursive: true });

const requiredTestFiles = [
  "packages/store/test/migrations/0007-to-0008.migration.ts",
  "packages/store/test/migrations/0008-to-0009.migration.ts",
  "packages/store/test/migrations/0009-to-0010.migration.ts",
  "packages/store/test/migrations/0010-to-0011.migration.ts",
  "packages/store/test/migrations/0011-to-0012.migration.ts",
  "packages/store/test/migrations/0012-to-0013.migration.ts",
  "packages/store/test/migrations/0013-to-0014.migration.ts",
  "packages/store/test/migrations/0014-to-0015.migration.ts",
  "packages/store/test/migrations/0015-to-0016.migration.ts",
  "packages/store/test/migrations/0016-to-0017.migration.ts",
  "packages/store/test/migrations/0017-to-0018.migration.ts",
  "packages/store/test/migrations/0018-to-0019.migration.ts",
  "packages/store/test/migrations/0019-to-0020.migration.ts",
];
const discoveredTestFiles = (await readdir(migrationTestDir, { recursive: true }))
  .filter((name) => name.endsWith(".migration.ts"))
  .sort()
  .map((name) => relative(ROOT, resolve(migrationTestDir, name)).split(sep).join("/"));
const missingTestFiles = requiredTestFiles.filter((name) => !discoveredTestFiles.includes(name));
const unregisteredTestFiles = discoveredTestFiles.filter((name) => !requiredTestFiles.includes(name));
if (missingTestFiles.length > 0 || unregisteredTestFiles.length > 0) {
  throw new Error(
    "required historical migration fixture manifest does not match disk: "
    + `missing=${JSON.stringify(missingTestFiles)}, `
    + `unregistered=${JSON.stringify(unregisteredTestFiles)}`,
  );
}

const vitestEntrypoint = resolve(ROOT, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [
  vitestEntrypoint,
  "run",
  "--config",
  configFile,
  "--reporter=verbose",
  "--reporter=json",
  `--outputFile.json=${reportFile}`,
], {
  cwd: ROOT,
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const report = JSON.parse(await readFile(reportFile, "utf8"));
for (const testFile of requiredTestFiles) {
  const suffix = `/${testFile}`;
  const fileResult = report.testResults?.find((entry) => (
    String(entry.name).split("\\").join("/").endsWith(suffix)
  ));
  const assertions = fileResult?.assertionResults ?? [];
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const nonPassed = assertions.filter((assertion) => assertion.status !== "passed");
  if (!fileResult || fileResult.status !== "passed" || passed === 0 || nonPassed.length > 0) {
    throw new Error(
      `${testFile} did not execute cleanly: file=${fileResult?.status ?? "missing"}, `
      + `passed=${passed}, nonPassed=${nonPassed.length}`,
    );
  }
  console.log(`required migration proof: ${testFile} executed ${passed} passing tests`);
}
