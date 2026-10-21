import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface ProofApi {
  MIGRATION_SHARD_COUNT: number;
  MIGRATION_FILE_COUNT: number;
  parseMigrationManifest(source: string, discovered: readonly string[]): string[];
  migrationShardFiles(files: readonly string[], shard: number): string[];
  migrationCiIdentity(env: Record<string, string | undefined>, root: string): Record<string, string>;
  migrationVitestArgs(root: string, files: readonly string[], shard: number, report: string): string[];
  migrationRegularFile(root: string, file: string, maximumBytes?: number): Promise<{ bytes: Buffer; sha256: string }>;
  assertMigrationReport(report: unknown, options: Record<string, unknown>): Array<{ file: string; passed: number }>;
  assertMigrationShard(metadata: unknown, report: unknown, options: Record<string, unknown>): Array<{ file: string; passed: number }>;
  assertMigrationAggregate(shards: unknown, options: Record<string, unknown>): {
    execution: string; singleProcessExecution: boolean; fileCount: number; passed: number;
  };
}
let api: ProofApi;
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = resolve(tmpdir(), "migration-shard-proof-checkout");
const START = 1_790_000_000_000;
const END = START + 20_000;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const FILES = Array.from({ length: 58 }, (_, index) =>
  `packages/store/test/migrations/proof-${String(index).padStart(2, "0")}.migration.ts`);
const SOURCE = {
  headSha: "a".repeat(40), runId: "123456", runAttempt: "2", sourceSha256: sha("source"),
  driverSha256: sha("driver"), manifestSha256: sha("manifest"), configSha256: sha("config"),
  fixtureSha256: sha("fixtures"), lockSha256: sha("lock"), vitestVersion: "4.1.11",
};
const INVALID_MANIFESTS: Array<[string, string[]]> = [
  ["missing", FILES.slice(1)], ["extra", [...FILES, "packages/store/test/migrations/extra.migration.ts"]],
  ["duplicate", [...FILES.slice(1), FILES[1]!]], ["escape", [...FILES.slice(1), "../foreign.migration.ts"]],
];

beforeAll(async () => {
  const module: unknown = await import(new URL("../../scripts/lib/migration-shard-proof.mjs", import.meta.url).href);
  api = module as ProofApi;
});

function report(files: readonly string[], perFile = 2) {
  const count = files.length * perFile;
  return { success: true, startTime: START + 1, numFailedTests: 0, numFailedTestSuites: 0,
    numPendingTests: 0, numTodoTests: 0, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0,
    numTotalTestSuites: files.length, numPassedTestSuites: files.length,
    numTotalTests: count, numPassedTests: count,
    testResults: files.map((file) => ({ name: resolve(ROOT, file), status: "passed", startTime: START + 2,
      endTime: END - 1, message: "", assertionResults: Array.from({ length: perFile }, (_, index) => ({
        fullName: `synthetic proof ${file} case ${index}`, status: "passed", failureMessages: [],
      })) })) };
}
function reportOptions(files: readonly string[]) {
  return { root: ROOT, files, startedAtMs: START, finishedAtMs: END, nativeExitCode: 0 };
}
function shard(index: number, perFile = 2) {
  const files = api.migrationShardFiles(FILES, index);
  const raw = report(files, perFile);
  const bytes = Buffer.from(JSON.stringify(raw));
  return { metadata: { schema: "migration-shard-v1", kind: "history", status: "passed", source: { ...SOURCE },
    checkoutRoot: ROOT, shard: index, shardCount: 3, files, startedAtMs: START, finishedAtMs: END,
    nativeExitCode: 0, reportSha256: sha(bytes), reportBytes: bytes.length,
    proof: api.assertMigrationReport(raw, reportOptions(files)) }, report: raw,
  reportSha256: sha(bytes), reportBytes: bytes.length };
}
function options() { return { root: ROOT, files: FILES, source: SOURCE, nowMs: END + 1 }; }
function refreshRaw(value: ReturnType<typeof shard>) {
  const bytes = Buffer.from(JSON.stringify(value.report));
  value.reportSha256 = sha(bytes); value.reportBytes = bytes.length;
  value.metadata.reportSha256 = value.reportSha256; value.metadata.reportBytes = value.reportBytes;
}
function declaration(files: readonly string[]) {
  return `const requiredTestFiles = [\n${files.map((file) => `  "${file}",`).join("\n")}\n];`;
}

describe("historical CI shards (synthetic proof only; never starts MySQL)", () => {
  it("uses the unchanged complete driver's single manifest and exact disk discovery", async () => {
    const source = await readFile(resolve(REPOSITORY, "scripts/run-required-migration-suites.mjs"), "utf8");
    const { readdir } = await import("node:fs/promises");
    const directory = "packages/store/test/migrations";
    const discovered = (await readdir(resolve(REPOSITORY, directory), { recursive: true }))
      .filter((file) => file.endsWith(".migration.ts")).map((file) => `${directory}/${file}`);
    const files = api.parseMigrationManifest(source, discovered);
    expect(files).toHaveLength(58);
    expect(files).toContain(`${directory}/0061-to-0062.migration.ts`);
    expect(files).toContain(`${directory}/0062-to-0063.migration.ts`);
    expect(files).toContain(`${directory}/0063-to-0064.migration.ts`);
    expect(files).toContain(`${directory}/0064-to-0065.migration.ts`);
    expect(source).not.toContain("run-migration-shard");
    expect(source).toContain('"--reporter=verbose"');
  });

  it("deterministically partitions all 58 complete files 20/19/19, exactly once", () => {
    const parts = [1, 2, 3].map((index) => api.migrationShardFiles(FILES, index));
    expect(parts.map((part) => part.length)).toEqual([20, 19, 19]);
    expect(new Set(parts.flat()).size).toBe(58);
    for (const [shard, part] of parts.entries()) expect(part).toEqual(FILES.filter((_, index) => index % 3 === shard));
    expect([...parts.flat()].sort()).toEqual([...FILES].sort());
  });

  it.each(INVALID_MANIFESTS)("rejects a %s manifest/discovery", (_label, files) => {
    expect(() => api.parseMigrationManifest(declaration(FILES), files)).toThrow("migration shard proof rejected");
  });

  it("rejects nonliteral, repeated, or duplicate declarations rather than evaluating source", () => {
    for (const source of [declaration(FILES).replace('"packages', 'process.env.EXTRA, "packages'),
      `${declaration(FILES)}\n${declaration(FILES)}`, declaration([...FILES.slice(1), FILES[1]!])]) {
      expect(() => api.parseMigrationManifest(source, FILES)).toThrow("migration shard proof rejected");
    }
  });

  it("uses the original migration config and file-serial budget, with no skip/filter/timeout override", async () => {
    const args = api.migrationVitestArgs(ROOT, FILES, 2, resolve(ROOT, "tests.json"));
    expect(args).toEqual([resolve(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config",
      resolve(ROOT, "packages/store/test/migrations/vitest.config.ts"), ...api.migrationShardFiles(FILES, 2),
      "--reporter=verbose", "--reporter=json", `--outputFile.json=${resolve(ROOT, "tests.json")}`]);
    const config = await readFile(resolve(REPOSITORY, "packages/store/test/migrations/vitest.config.ts"), "utf8");
    expect(config).toContain("fileParallelism: false");
    expect(config).toContain("testTimeout: 30_000"); expect(config).toContain("hookTimeout: 60_000");
  });

  it("takes run/attempt/commit from actual CI environment rather than sidecars", () => {
    const env = { CI: "true", GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: ROOT, GITHUB_SHA: SOURCE.headSha,
      GITHUB_RUN_ID: SOURCE.runId, GITHUB_RUN_ATTEMPT: SOURCE.runAttempt };
    expect(api.migrationCiIdentity(env, ROOT)).toEqual({ headSha: SOURCE.headSha, runId: "123456", runAttempt: "2" });
    for (const key of Object.keys(env)) expect(() => api.migrationCiIdentity({ ...env, [key]: "" }, ROOT)).toThrow();
  });

  it("proves only three independent executions, deriving actual cases instead of a historical 337", () => {
    const proof = api.assertMigrationAggregate([shard(3, 3), shard(1, 1), shard(2, 2)], options());
    expect(proof.execution).toBe("aggregated_three_independent_shards");
    expect(proof.singleProcessExecution).toBe(false);
    expect(proof.fileCount).toBe(58); expect(proof.passed).toBe(20 + 38 + 57);
  });

  it("accepts the real v4 JSON shape without inventing a runtime-error count field", () => {
    const raw = report([FILES[0]!]);
    Reflect.deleteProperty(raw, "numRuntimeErrorTestSuites");
    expect(api.assertMigrationReport(raw, reportOptions([FILES[0]!]))).toEqual([{ file: FILES[0], passed: 2 }]);
  });

  it.each(["missing", "duplicate", "wrong shard count", "foreign file", "missing file"])("rejects %s aggregation", (kind) => {
    const parts = [shard(1), shard(2), shard(3)];
    if (kind === "missing") parts.pop();
    if (kind === "duplicate") parts[2] = shard(1);
    if (kind === "wrong shard count") parts[0]!.metadata.shardCount = 2;
    if (kind === "foreign file") parts[0]!.metadata.files[0] = "packages/store/test/migrations/foreign.migration.ts";
    if (kind === "missing file") parts[0]!.report.testResults.pop();
    expect(() => api.assertMigrationAggregate(parts, options())).toThrow("migration shard proof rejected");
  });

  it.each(["headSha", "runId", "runAttempt", "sourceSha256", "configSha256", "fixtureSha256", "manifestSha256", "lockSha256", "vitestVersion"])(
    "rejects mixed/stale %s", (field) => {
      const parts = [shard(1), shard(2), shard(3)];
      Reflect.set(parts[1]!.metadata.source, field, field.endsWith("Sha256") ? sha("other") : "other");
      expect(() => api.assertMigrationAggregate(parts, options())).toThrow("migration shard proof rejected");
    },
  );

  it.each(["native exit", "failure receipt", "JSON success", "failed count", "hook error", "file error", "zero cases", "skipped", "todo", "all skipped", "runtime error", "duplicate file", "stale", "future", "case count"])(
    "rejects %s even if other evidence claims green", (kind) => {
      const part = shard(1);
      const first = part.report.testResults[0]!;
      if (kind === "native exit") part.metadata.nativeExitCode = 1;
      if (kind === "failure receipt") part.metadata.status = "failed";
      if (kind === "JSON success") part.report.success = false;
      if (kind === "failed count") part.report.numFailedTests = 1;
      if (kind === "hook error") Reflect.set(first, "message", "hook failure");
      if (kind === "file error") Reflect.set(first, "testExecError", { message: "error" });
      if (kind === "zero cases") first.assertionResults = [];
      if (kind === "skipped") first.assertionResults[0]!.status = "skipped";
      if (kind === "todo") part.report.numTodoTests = 1;
      if (kind === "all skipped") for (const item of part.report.testResults) item.status = "skipped";
      if (kind === "runtime error") part.report.numRuntimeErrorTestSuites = 1;
      if (kind === "duplicate file") part.report.testResults[1] = first;
      if (kind === "stale") part.report.startTime = START - 1;
      if (kind === "future") part.metadata.finishedAtMs = END + 2;
      if (kind === "case count") part.report.numTotalTests++;
      refreshRaw(part);
      expect(() => api.assertMigrationAggregate([part, shard(2), shard(3)], options())).toThrow("migration shard proof rejected");
    },
  );

  it.each(["raw bytes", "byte count", "stored proof", "path alias", "foreign absolute"])("rejects tampered %s", (kind) => {
    const part = shard(1);
    if (kind === "raw bytes") part.reportSha256 = sha("tampered");
    if (kind === "byte count") part.reportBytes++;
    if (kind === "stored proof") part.metadata.proof[0]!.passed++;
    if (kind === "path alias") part.report.testResults[0]!.name = `${ROOT}/packages/../${FILES[0]}`;
    if (kind === "foreign absolute") part.report.testResults[0]!.name = resolve(tmpdir(), FILES[0]!);
    expect(() => api.assertMigrationAggregate([part, shard(2), shard(3)], options())).toThrow("migration shard proof rejected");
  });

  it("rejects symlink files/ancestor aliases, escape paths and oversized artifacts", async () => {
    const scratch = await realpath(await mkdtemp(resolve(tmpdir(), "migration-shard-artifacts-")));
    try {
      await mkdir(resolve(scratch, "real"));
      await writeFile(resolve(scratch, "real/report.json"), "{}");
      await symlink(resolve(scratch, "real/report.json"), resolve(scratch, "link.json"));
      await symlink(resolve(scratch, "real"), resolve(scratch, "alias"));
      expect((await api.migrationRegularFile(scratch, "real/report.json")).sha256).toBe(sha("{}"));
      for (const path of ["link.json", "alias/report.json", "../report.json", "real/../real/report.json", "real\\report.json"]) {
        await expect(api.migrationRegularFile(scratch, path)).rejects.toThrow();
      }
      await expect(api.migrationRegularFile(scratch, "real/report.json", 1)).rejects.toThrow();
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
