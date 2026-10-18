import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface ShardResult { files: string[]; required: Array<{ file: string; passed: number }>; passed: number; skipped: number }
interface MainProof {
  EXPECTED_MAIN_SKIPS: Record<string, [number, string]>;
  jsonSha256(value: unknown): string;
  discoveryFiles(value: unknown, root: string): string[];
  assertMainShardReport(value: unknown, options: Record<string, unknown>): ShardResult;
  assertMainShardUnion(value: ShardResult[], options: Record<string, unknown>): { discoveredFiles: number; requiredFiles: number; requiredAssertions: number; groups: Array<{ name: string; files: number; passed: number }>; passed: number; skipped: number };
  assertMainCoverage(value: unknown, root: string): void;
  assertMainMergedAssertions(reports: unknown[], merged: unknown, root: string): void;
  assertNativeMergeExit(value: unknown): void;
  assertReceipt(value: unknown, expected: Record<string, unknown>): void;
}
interface MainRuntime { parseArguments(args: string[], mode: string, environment?: NodeJS.ProcessEnv): Record<string, string>; nativeEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv }
let proof: MainProof;
let runtime: MainRuntime;
beforeAll(async () => {
  proof = await import(new URL("../scripts/lib/main-coverage-proof.mjs", import.meta.url).href) as MainProof;
  runtime = await import(new URL("../scripts/lib/main-coverage-runtime.mjs", import.meta.url).href) as MainRuntime;
});

const ROOT = resolve(tmpdir(), "agent-service-main-shards-unit");
const START = 1_700_000_000_000;
const END = START + 10_000;
const A = "packages/core/test/a.test.ts";
const B = "apps/agent-runner/test/b.test.ts";
const C = "test/optional.test.ts";
const S = "packages/core/test/dedicated-profile.test.ts";
const TITLE = "dedicated profile native skipped case";
const DISCOVERY = [A, B, C, S].sort();
function skippedInventory() { return { [S]: [1, proof.jsonSha256([TITLE])] }; }
function suite(file: string, statuses = ["passed"], titles = statuses.map((_, i) => `${file} ${i}`)) {
  return { name: join(ROOT, file), status: "passed", startTime: START + 2, endTime: START + 3, message: "",
    assertionResults: statuses.map((status, i) => ({ status, fullName: titles[i], failureMessages: [] as string[] })) };
}
function report(suites = [suite(A)]) {
  const assertions = suites.flatMap((entry) => entry.assertionResults);
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numTodoTests: 0,
    numPassedTests: assertions.filter((entry) => entry.status === "passed").length,
    numPendingTests: assertions.filter((entry) => entry.status === "skipped").length,
    numTotalTests: assertions.length, startTime: START + 1, testResults: suites };
}
function checkReport(value: unknown, extra: Record<string, unknown> = {}) {
  return proof.assertMainShardReport(value, { root: ROOT, discovery: DISCOVERY, requiredFiles: [A, B],
    startedAtMs: START, finishedAtMs: END, expectedSkips: skippedInventory(), ...extra });
}
function shards() {
  return [checkReport(report([suite(A)])), checkReport(report([suite(B), suite(C)])),
    checkReport(report([suite(S, ["skipped"], [TITLE])]))];
}
function union(value = shards(), extra: Record<string, unknown> = {}) {
  return proof.assertMainShardUnion(value, { discovery: DISCOVERY, requiredFiles: [A, B], groups: { both: [A, B], overlap: [B] },
    expectedSkips: skippedInventory(), ...extra });
}
function coverage() {
  return { total: { statements: { pct: 72 }, branches: { pct: 61 }, functions: { pct: 68 }, lines: { pct: 76 } },
    [join(ROOT, "packages/store/src/mysql/store.ts")]: { lines: { pct: 40 } },
    [join(ROOT, "packages/store/src/redis/lease.ts")]: { lines: { pct: 40 } },
    [join(ROOT, "packages/store/src/redis/purge.ts")]: { lines: { pct: 60 } },
    [join(ROOT, "packages/core/src/engine/pi.ts")]: { lines: { pct: 30 } } };
}
function receipt() {
  const digest = { sha256: "a".repeat(64), size: 100, mtimeMs: START + 5 };
  return { schema: "main-coverage-shard-v1", runId: "10", runAttempt: "2", sourceCommit: "b".repeat(40), shard: 1, shardCount: 3,
    root: ROOT, identity: { sourceSha256: "c".repeat(64) }, startedAtMs: START, finishedAtMs: END, nativeExitCode: 0,
    sourceUnchanged: true, collectionValid: true, coverageGate: "pending", files: { "tests.json": { ...digest }, "blob.json": { ...digest }, "discovery.json": { ...digest } } };
}
function checkReceipt(value: unknown) {
  const expected = receipt();
  proof.assertReceipt(value, { runId: expected.runId, runAttempt: expected.runAttempt, sourceCommit: expected.sourceCommit,
    shard: expected.shard, root: ROOT, identity: expected.identity });
}

describe("native main coverage shard proof (synthetic pure data, not integration evidence)", () => {
  it("uses the whole default discovery set rather than only required files, and counts overlapping groups as subsets", () => {
    expect(proof.discoveryFiles(DISCOVERY.map((file) => ({ file: join(ROOT, file) })), ROOT)).toEqual(DISCOVERY);
    expect(union()).toEqual({ discoveredFiles: 4, requiredFiles: 2, requiredAssertions: 2, passed: 3, skipped: 1,
      groups: [{ name: "both", files: 2, passed: 2 }, { name: "overlap", files: 1, passed: 1 }] });
  });
  it.each(["duplicate", "escape", "cluster", "project"])("rejects noncanonical discovery: %s", (kind) => {
    const entries: unknown[] = [{ file: join(ROOT, A) }];
    if (kind === "duplicate") entries.push(entries[0]);
    if (kind === "escape") entries.push({ file: resolve(ROOT, "../outside.test.ts") });
    if (kind === "cluster") entries.push({ file: join(ROOT, "test/cluster/actual.test.ts") });
    if (kind === "project") entries.push({ file: join(ROOT, B), projectName: "alternate" });
    expect(() => proof.discoveryFiles(entries, ROOT)).toThrow();
  });
  it.each(["missing", "overlap", "duplicate", "missingRequired", "groupOutside"])("rejects incomplete or ambiguous aggregation: %s", (kind) => {
    const input = shards();
    if (kind === "missing") input.pop();
    if (kind === "overlap") input[1]!.files.push(A);
    if (kind === "duplicate") input[2] = input[1]!;
    if (kind === "missingRequired") input[1]!.required = [];
    expect(() => union(input, kind === "groupOutside" ? { groups: { invalid: [C] } } : {})).toThrow();
  });
  it.each(["failed", "todo", "hook", "unhandled", "stale", "empty", "count", "outside"])("does not infer successful execution from a registered name: %s", (kind) => {
    const input = report();
    if (kind === "failed") input.success = false;
    if (kind === "todo") input.numTodoTests = 1;
    if (kind === "hook") input.testResults[0]!.message = "hook failed";
    if (kind === "unhandled") Object.assign(input, { errors: [{}] });
    if (kind === "stale") input.startTime = START - 1;
    if (kind === "empty") input.testResults[0]!.assertionResults = [];
    if (kind === "count") input.numPassedTests++;
    if (kind === "outside") input.testResults[0]!.name = join(ROOT, "test/unlisted.test.ts");
    expect(() => checkReport(input)).toThrow();
  });
  it("allows only the exact dedicated profile titles, never a wildcard suffix or skipped required assertion", () => {
    expect(() => checkReport(report([suite(S, ["skipped"], [TITLE])]))).not.toThrow();
    expect(() => checkReport(report([suite(S, ["skipped"], ["renamed title"])]))).toThrow("unexpected_skip");
    expect(() => checkReport(report([suite(A, ["skipped"], [TITLE])]))).toThrow("unexpected_skip");
    expect(() => checkReport(report([suite(S, ["passed"], [TITLE])]))).toThrow("suite_status");
  });
  it("pins the current seventeen dedicated profile title sets (86 S3 plus one paid model), not arbitrary skipped tests", () => {
    const entries = Object.entries(proof.EXPECTED_MAIN_SKIPS);
    expect(entries).toHaveLength(17);
    expect(entries.reduce((sum, [, [count]]) => sum + count, 0)).toBe(87);
    expect(proof.EXPECTED_MAIN_SKIPS["packages/providers/test/e2e-qwen.test.ts"]?.[0]).toBe(1);
    expect(entries.every(([, [count, hash]]) => count > 0 && /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });
  it("accepts a merged report with original shard case timestamps instead of pretending the cases reran during merge", () => {
    const input = report([suite(A), suite(B), suite(C), suite(S, ["skipped"], [TITLE])]);
    input.startTime = START + 9_000;
    expect(checkReport(input).passed).toBe(3);
  });
  it("requires native merge exit zero even when the JSON reporter already said success", () => {
    expect(() => proof.assertNativeMergeExit({ code: 0, signal: null })).not.toThrow();
    expect(() => proof.assertNativeMergeExit({ code: 1, signal: null, success: true })).toThrow("merge_native_exit");
    expect(() => proof.assertNativeMergeExit({ code: null, signal: "SIGTERM" })).toThrow("merge_native_exit");
  });
  it("matches each original file's assertion multiset, retaining legitimate duplicate title multiplicity", () => {
    const raw = [report([suite(A, ["passed", "passed"], ["same title", "same title"])]), report([suite(B)])];
    const merged = structuredClone(report([...raw[1]!.testResults, ...raw[0]!.testResults]));
    expect(() => proof.assertMainMergedAssertions(raw, merged, ROOT)).not.toThrow();
    merged.testResults[1]!.assertionResults.pop();
    expect(() => proof.assertMainMergedAssertions(raw, merged, ROOT)).toThrow("merged_assertion_multiset");
  });
  it.each(["missing", "extra", "duplicate replacement", "cross-file transfer", "status"])("rejects a native-merged assertion %s even when aggregate file/count checks could match", (kind) => {
    const raw = [report([suite(A, ["passed", "passed"], ["first", "second"])]), report([suite(B, ["passed"], ["third"])])];
    const merged = structuredClone(report(raw.flatMap((entry) => entry.testResults)));
    const first = merged.testResults[0]!;
    const second = merged.testResults[1]!;
    if (kind === "missing") first.assertionResults.pop();
    if (kind === "extra") first.assertionResults.push({ ...first.assertionResults[0]! });
    if (kind === "duplicate replacement") first.assertionResults[1] = { ...first.assertionResults[0]! };
    if (kind === "cross-file transfer") second.assertionResults.push(first.assertionResults.pop()!);
    if (kind === "status") first.assertionResults[0]!.status = "skipped";
    expect(() => proof.assertMainMergedAssertions(raw, merged, ROOT)).toThrow("merged_assertion_multiset");
  });
  it.each(["statements", "branches", "functions", "lines"] as const)("preserves the global %s threshold at the aggregate", (metric) => {
    const input = coverage();
    expect(() => proof.assertMainCoverage(input, ROOT)).not.toThrow();
    input.total[metric].pct -= 0.01;
    expect(() => proof.assertMainCoverage(input, ROOT)).toThrow(`global_${metric}`);
  });
  it.each(["packages/store/src/mysql/store.ts", "packages/store/src/redis/lease.ts", "packages/store/src/redis/purge.ts", "packages/core/src/engine/pi.ts"])("preserves the implementation line floor for %s", (file) => {
    const input = coverage() as Record<string, { lines: { pct: number } }>;
    input[join(ROOT, file)]!.lines.pct -= 0.01;
    expect(() => proof.assertMainCoverage(input, ROOT)).toThrow();
  });
  it.each(["run", "attempt", "sha", "shard", "identity", "native", "collectOnly", "source", "staleBlob", "extra"])("rejects cross-run, stale or failed receipts: %s", (kind) => {
    const input = receipt();
    expect(() => checkReceipt(input)).not.toThrow();
    if (kind === "run") input.runId = "11";
    if (kind === "attempt") input.runAttempt = "3";
    if (kind === "sha") input.sourceCommit = "d".repeat(40);
    if (kind === "shard") input.shard = 2;
    if (kind === "identity") input.identity.sourceSha256 = "d".repeat(64);
    if (kind === "native") input.nativeExitCode = 1;
    if (kind === "collectOnly") input.coverageGate = "passed";
    if (kind === "source") input.sourceUnchanged = false;
    if (kind === "staleBlob") input.files["blob.json"].mtimeMs = START - 1;
    if (kind === "extra") Object.assign(input, { silentlyIgnored: true });
    expect(() => checkReceipt(input)).toThrow();
  });
  it("has a closed command line with no test filters, alternative config or selectable shard count", () => {
    const base = ["--shard", "1", "--run-id", "10", "--run-attempt", "2", "--source-commit", "b".repeat(40), "--artifact-dir", join(ROOT, "artifact")];
    expect(runtime.parseArguments(base, "shard", {}).shard).toBe("1");
    expect(() => runtime.parseArguments([...base, "--filter", A], "shard", {})).toThrow();
    expect(() => runtime.parseArguments(base.map((arg) => arg === "1" ? "4" : arg), "shard", {})).toThrow();
    expect(() => runtime.parseArguments(base.map((arg) => arg === "--shard" ? "--config" : arg), "shard", {})).toThrow();
    expect(() => runtime.parseArguments(base, "shard", { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "other" })).toThrow("github_identity");
    const env = runtime.nativeEnvironment();
    expect(env.AGENT_SERVICE_INTEGRATION).toBe("1");
    expect(env.AGENT_SERVICE_S3_INTEGRATION).toBe("0");
    expect(env.AGENT_SERVICE_REAL_E2E).toBe("0");
  });
  it("disables every dedicated S3/backup/capture/paid profile before discovery can import any test fixture", () => {
    const flags = ["AGENT_SERVICE_S3_INTEGRATION", "AGENT_SERVICE_REAL_E2E",
      "AGENT_SERVICE_BACKUP_CATALOG_RECONCILE_INTEGRATION", "AGENT_SERVICE_BACKUP_CATALOG_RESTORE_ROUNDTRIP_INTEGRATION",
      "AGENT_SERVICE_BACKUP_CATALOG_S3_INTEGRATION", "AGENT_SERVICE_RESTORE_JOURNAL_S3_INTEGRATION",
      "AGENT_SERVICE_TELEMETRY_CAPTURE_INTEGRATION", "AGENT_SERVICE_TENANT_TELEMETRY_S3_INTEGRATION",
      "AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION", "AGENT_SERVICE_MYSQL_BACKUP_ARTIFACT_INTEGRATION"];
    const inherited = { ...Object.fromEntries(flags.map((flag) => [flag, "1"])), API_KEY: "not-a-real-unit-key",
      AGENT_SERVICE_INTEGRATION: "0", AGENT_SERVICE_UNRELATED_PRODUCT_SETTING: "preserve" };
    const env = runtime.nativeEnvironment(inherited);
    expect(flags.every((flag) => env[flag] === "0")).toBe(true);
    expect(env.API_KEY === undefined).toBe(true);
    expect(env.AGENT_SERVICE_INTEGRATION).toBe("1");
    expect(env.AGENT_SERVICE_UNRELATED_PRODUCT_SETTING).toBe("preserve");
    expect(flags.every((flag) => inherited[flag as keyof typeof inherited] === "1")).toBe(true);
  });
  it("uses official blob collection and canonical native merging, without changing the local serial command or timeouts", async () => {
    const [collect, merge, config, canonical] = await Promise.all([
      readFile(new URL("../scripts/run-main-coverage-shard.mjs", import.meta.url), "utf8"),
      readFile(new URL("../scripts/merge-main-coverage.mjs", import.meta.url), "utf8"),
      readFile(new URL("../vitest.coverage-shard.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../vitest.config.ts", import.meta.url), "utf8"),
    ]);
    expect(collect).toContain('"--reporter=blob"');
    expect(collect).toContain('`--shard=${options.shard}/3`');
    expect(merge).toContain('["--merge-reports", blobDirectory, "--config", "vitest.config.ts", "--coverage"');
    expect(merge).toContain("assertNativeMergeExit(native)");
    expect(merge).toContain("assertMainMergedAssertions(rawReports, mergedReport, ROOT)");
    expect(config).toContain("thresholds: undefined");
    expect(config).toContain("envDir: false");
    expect(canonical).toContain("testTimeout: 30_000");
    expect(canonical).toContain("hookTimeout: 60_000");
    expect(canonical).toContain("fileParallelism: false");
    expect(canonical).toContain("thresholds: { statements: 72, branches: 61, functions: 68, lines: 76 }");
  });
  it("exports a collection config with actual Vite environment-file loading disabled", async () => {
    const module: unknown = await import(new URL("../vitest.coverage-shard.config.ts", import.meta.url).href);
    expect((module as { default: { envDir?: unknown } }).default.envDir).toBe(false);
  });
});
