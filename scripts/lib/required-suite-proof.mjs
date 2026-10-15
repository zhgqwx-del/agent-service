import { isAbsolute, relative, resolve } from "node:path";

const normalize = (value) => value.replaceAll("\\", "/");
const fail = (reason) => { throw new Error(`required suite proof rejected: ${reason}`); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate a single, run-owned Vitest report; never infer execution from coverage or a suffix. */
export function assertRequiredTestResults(report, { root, requiredFiles, startedAtMs, finishedAtMs }) {
  if (typeof root !== "string" || !isAbsolute(root)) fail("invalid repository root");
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(finishedAtMs)
      || startedAtMs < 0 || finishedAtMs < startedAtMs) fail("invalid execution window");
  if (!Array.isArray(requiredFiles) || requiredFiles.length === 0) fail("empty required manifest");
  const expected = new Set();
  for (const file of requiredFiles) {
    if (typeof file !== "string" || file.includes("\\") || isAbsolute(file)
        || !/^(?:packages|apps|test)\/.+\.test\.ts$/.test(file)
        || normalize(relative(root, resolve(root, file))) !== file || expected.has(file)) {
      fail("invalid or duplicate required manifest path");
    }
    expected.add(file);
  }
  if (!object(report) || report.success !== true || report.numFailedTests !== 0
      || report.numFailedTestSuites !== 0 || !Number.isSafeInteger(report.startTime)
      || report.startTime < startedAtMs || report.startTime > finishedAtMs
      || !Array.isArray(report.testResults)) fail("unsuccessful, malformed or stale report");
  const actual = new Map();
  for (const entry of report.testResults) {
    if (!object(entry) || typeof entry.name !== "string" || !isAbsolute(entry.name)) {
      fail("malformed test result");
    }
    const path = normalize(entry.name);
    const file = normalize(relative(root, resolve(root, path)));
    if (file.startsWith("../") || isAbsolute(file) || file === ".."
        || !file.endsWith(".test.ts") || actual.has(file)) fail("foreign or duplicate test result");
    // Do not normalize aliases (a/../b, double separators) into a required identity.
    if (path !== file && path !== normalize(resolve(root, file))) fail("noncanonical test result path");
    if (!Array.isArray(entry.assertionResults)) fail("missing assertion results");
    if (!["passed", "skipped", "pending"].includes(entry.status) || entry.assertionResults.some((item) =>
      !object(item) || !["passed", "skipped", "pending", "todo"].includes(item.status))) {
      fail("invalid or failed test result");
    }
    actual.set(file, entry);
  }
  return requiredFiles.map((file) => {
    const entry = actual.get(file);
    if (!entry || entry.status !== "passed" || entry.assertionResults.length === 0
        || entry.assertionResults.some((item) => !object(item) || item.status !== "passed")) {
      fail(`${file} missing, empty, skipped or non-passing`);
    }
    return { file, passed: entry.assertionResults.length };
  });
}

/** These per-implementation floors supplement, not replace, Vitest's global thresholds. */
export function assertRequiredCoverage(summary, root) {
  if (!object(summary)) fail("malformed coverage summary");
  return [
    ["packages/store/src/mysql/store.ts", 40],
    ["packages/store/src/redis/lease.ts", 40],
    ["packages/store/src/redis/purge.ts", 60],
    ["packages/core/src/engine/pi.ts", 30],
  ].map(([file, minimum]) => {
    const entries = Object.entries(summary).filter(([key]) => resolve(root, key) === resolve(root, file));
    const pct = entries.length === 1 ? entries[0][1]?.lines?.pct : undefined;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < minimum || pct > 100) {
      fail(`${file} coverage missing or below ${minimum}%`);
    }
    return { file, pct };
  });
}
