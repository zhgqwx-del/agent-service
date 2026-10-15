import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface RequiredSuiteProofApi {
  assertRequiredTestResults(
    report: unknown,
    options: {
      root: string;
      requiredFiles: readonly string[];
      startedAtMs: number;
      finishedAtMs: number;
    },
  ): Array<{ file: string; passed: number }>;
  assertRequiredCoverage(summary: unknown, root: string): Array<{ file: string; pct: number }>;
}

let proof: RequiredSuiteProofApi;
beforeAll(async () => {
  // The repository .mjs implementation is untyped; keep its boundary explicit.
  const module: unknown = await import(new URL("../scripts/lib/required-suite-proof.mjs", import.meta.url).href);
  proof = module as RequiredSuiteProofApi;
});

const ROOT = resolve(tmpdir(), "agent-service-required-suite-proof-unit-root");
const FIRST = "packages/store/test/proof-a.test.ts";
const SECOND = "apps/agent-runner/test/proof-b.test.ts";
const OPTIONAL = "packages/core/test/optional.test.ts";
const STARTED = 1_700_000_000_000;
const FINISHED = STARTED + 10_000;
const COVERAGE_REQUIREMENTS = [
  ["packages/store/src/mysql/store.ts", 40],
  ["packages/store/src/redis/lease.ts", 40],
  ["packages/store/src/redis/purge.ts", 60],
  ["packages/core/src/engine/pi.ts", 30],
] as const;

function coverageSummary(): Record<string, { lines: { pct: unknown } }> {
  return Object.fromEntries(COVERAGE_REQUIREMENTS.map(([file, pct]) => [file, { lines: { pct } }]));
}

function checkCoverage(summary: unknown) {
  return proof.assertRequiredCoverage(summary, ROOT);
}

function options(requiredFiles: readonly string[] = [FIRST]) {
  return { root: ROOT, requiredFiles, startedAtMs: STARTED, finishedAtMs: FINISHED };
}

function result(file: string, statuses: readonly string[] = ["passed"], status = "passed") {
  return {
    name: join(ROOT, file), status,
    assertionResults: statuses.map((assertionStatus) => ({ status: assertionStatus })),
  };
}

function report(testResults: unknown = [result(FIRST)], extra: Record<string, unknown> = {}) {
  return {
    success: true,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    startTime: STARTED + 1,
    testResults,
    ...extra,
  };
}

function check(input: unknown, requiredFiles: readonly string[] = [FIRST]) {
  return proof.assertRequiredTestResults(input, options(requiredFiles));
}

describe("required-suite JSON report proof (synthetic unit data only)", () => {
  it("counts one fully passing required file exactly once", () => {
    expect(check(report([result(FIRST, ["passed", "passed", "passed"])])))
      .toEqual([{ file: FIRST, passed: 3 }]);
  });

  it("counts each required file without depending on report or return order", () => {
    const actual = check(report([result(SECOND, ["passed", "passed"]), result(FIRST)]), [FIRST, SECOND]);
    expect(actual).toHaveLength(2);
    expect(actual).toEqual(expect.arrayContaining([
      { file: FIRST, passed: 1 }, { file: SECOND, passed: 2 },
    ]));
  });

  it("allows an explicitly non-required skipped file without counting it", () => {
    expect(check(report([result(OPTIONAL, [], "skipped"), result(FIRST, ["passed", "passed"])])))
      .toEqual([{ file: FIRST, passed: 2 }]);
  });

  it("accepts a report created at either inclusive run boundary", () => {
    expect(check(report(undefined, { startTime: STARTED }))).toEqual([{ file: FIRST, passed: 1 }]);
    expect(check(report(undefined, { startTime: FINISHED }))).toEqual([{ file: FIRST, passed: 1 }]);
  });

  for (const [name, build] of [
    ["missing required file", () => report([result(SECOND)])],
    ["all required assertions skipped", () => report([result(FIRST, ["skipped"], "skipped")])],
    ["partial required skip", () => report([result(FIRST, ["passed", "skipped"])])],
    ["failed required assertion", () => report([result(FIRST, ["passed", "failed"])])],
    ["todo required assertion", () => report([result(FIRST, ["todo"])])],
    ["pending required assertion", () => report([result(FIRST, ["pending"])])],
    ["zero assertions in a passed required file", () => report([result(FIRST, [])])],
    ["required file status failed despite passed assertions", () => report([result(FIRST, ["passed"], "failed")])],
    ["required file status skipped despite passed assertions", () => report([result(FIRST, ["passed"], "skipped")])],
    ["duplicate actual result", () => report([result(FIRST), result(FIRST)])],
    ["noncanonical alias of a required result", () => report([{
      ...result(FIRST), name: `${ROOT}/packages/store/test/./proof-a.test.ts`,
    }])],
    ["failed non-required result hidden by inconsistent top-level counts", () => report([
      result(FIRST), result(OPTIONAL, ["failed"], "failed"),
    ])],
    ["suffix-matching file under a different directory", () => report([{
      ...result(FIRST), name: join(ROOT, "shadow", FIRST),
    }])],
    ["same basename under another package", () => report([{
      ...result(FIRST), name: join(ROOT, "apps/agent-router/test/proof-a.test.ts"),
    }])],
    ["cross-root absolute result", () => report([{
      ...result(FIRST), name: join(ROOT + "-other", FIRST),
    }])],
    ["parent traversal result", () => report([{
      ...result(FIRST), name: `${ROOT}/../outside/${FIRST}`,
    }])],
    ["relative actual result", () => report([{ ...result(FIRST), name: FIRST }])],
    ["file URL masquerading as an absolute path", () => report([{
      ...result(FIRST), name: new URL(`file://${join(ROOT, FIRST)}`).href,
    }])],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() => check(build())).toThrow(Error);
    });
  }

  for (const [name, input] of [
    ["missing report", undefined],
    ["null report", null],
    ["string report", "success"],
    ["array report", []],
    ["missing testResults", report(undefined, { testResults: undefined })],
    ["non-array testResults", report("not-an-array")],
    ["null test result", report([null])],
    ["non-string result name", report([{ ...result(FIRST), name: 42 }])],
    ["missing assertionResults", report([{ ...result(FIRST), assertionResults: undefined }])],
    ["non-array assertionResults", report([{ ...result(FIRST), assertionResults: "passed" }])],
    ["null assertion", report([{ ...result(FIRST), assertionResults: [null] }])],
    ["non-string assertion status", report([{ ...result(FIRST), assertionResults: [{ status: 1 }] }])],
    ["non-required result with non-string status", report([
      result(FIRST), { ...result(OPTIONAL, [], "skipped"), status: 42 },
    ])],
    ["non-required assertion with non-string status", report([
      result(FIRST), { ...result(OPTIONAL, ["skipped"], "skipped"), assertionResults: [{ status: 42 }] },
    ])],
  ] as const) {
    it(`rejects malformed ${name}`, () => {
      expect(() => check(input)).toThrow(Error);
    });
  }

  for (const [name, extra] of [
    ["unsuccessful report", { success: false }],
    ["non-boolean success", { success: "true" }],
    ["failed-test count", { numFailedTests: 1 }],
    ["failed-suite count", { numFailedTestSuites: 1 }],
    ["string failed-test count", { numFailedTests: "0" }],
    ["negative failed-suite count", { numFailedTestSuites: -1 }],
    ["stale report", { startTime: STARTED - 1 }],
    ["future report", { startTime: FINISHED + 1 }],
    ["fractional report time", { startTime: STARTED + 0.5 }],
    ["non-number report time", { startTime: String(STARTED) }],
    ["unsafe report time", { startTime: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing report time", { startTime: undefined }],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() => check(report(undefined, extra))).toThrow(Error);
    });
  }

  for (const [name, requiredFiles] of [
    ["empty expected list", []],
    ["duplicate expected list", [FIRST, FIRST]],
    ["absolute expected file", [join(ROOT, FIRST)]],
    ["parent traversal expected file", [`../${FIRST}`]],
    ["noncanonical expected file", ["packages/store/test/../test/proof-a.test.ts"]],
    ["double-separator expected file", ["packages//store/test/proof-a.test.ts"]],
    ["backslash expected file", ["packages\\store\\test\\proof-a.test.ts"]],
    ["non-test expected file", ["packages/store/test/proof-a.ts"]],
    ["empty expected file", [""]],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(() => check(report(), requiredFiles)).toThrow(Error);
    });
  }

  it("rejects malformed expected file types and invalid run bounds", () => {
    expect(() => check(report(), [42] as unknown as readonly string[])).toThrow(Error);
    expect(() => proof.assertRequiredTestResults(report(), { ...options(), root: "relative/root" }))
      .toThrow(Error);
    expect(() => proof.assertRequiredTestResults(report(), { ...options(), finishedAtMs: STARTED - 1 }))
      .toThrow(Error);
    expect(() => proof.assertRequiredTestResults(report(), { ...options(), startedAtMs: NaN }))
      .toThrow(Error);
  });
});

describe("coverage proof CLI fail-closed entrypoints (no test subprocess is launched)", () => {
  for (const argument of ["--exclude", "--passWithNoTests", "--testNamePattern", "--help"]) {
    it(`rejects caller filtering or replacement options: ${argument}`, () => {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL("../scripts/run-required-coverage.mjs", import.meta.url)), argument,
      ], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no filtering options");
      expect(result.stdout).not.toContain("main coverage execution report:");
    });
  }
  it("does not accept the convenience JSON without a driver execution window", () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/assert-suites-ran.mjs", import.meta.url)),
    ], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fresh execution-bound report");
    expect(result.stdout).not.toContain("required main proof:");
  });
});

describe("required source coverage proof (synthetic unit data only)", () => {
  it("accepts exactly the four floor values and returns one proof per source", () => {
    const summary: Record<string, unknown> = { ...coverageSummary(), total: { lines: { pct: 100 } } };
    expect(checkCoverage(summary)).toEqual(COVERAGE_REQUIREMENTS.map(([file, pct]) => ({ file, pct })));
  });

  it("accepts absolute source keys and finite percentages up to 100", () => {
    const summary = Object.fromEntries(COVERAGE_REQUIREMENTS.map(([file]) => [
      join(ROOT, file), { lines: { pct: 100 } },
    ]));
    expect(checkCoverage(summary)).toEqual(COVERAGE_REQUIREMENTS.map(([file]) => ({ file, pct: 100 })));
  });

  for (const [file, minimum] of COVERAGE_REQUIREMENTS) {
    it(`rejects missing exact source ${file}`, () => {
      const summary = coverageSummary();
      delete summary[file];
      expect(() => checkCoverage(summary)).toThrow(Error);
    });

    it(`rejects ${file} below its ${minimum}% floor`, () => {
      const summary = coverageSummary();
      summary[file] = { lines: { pct: minimum - 0.01 } };
      expect(() => checkCoverage(summary)).toThrow(Error);
    });
  }

  for (const [name, pct] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["string percentage", "40"],
    ["null percentage", null],
    ["missing percentage", undefined],
    ["over 100 percent", 100.01],
  ] as const) {
    it(`rejects ${name}`, () => {
      const summary = coverageSummary();
      summary[COVERAGE_REQUIREMENTS[0][0]] = { lines: { pct } };
      expect(() => checkCoverage(summary)).toThrow(Error);
    });
  }

  for (const [name, value] of [
    ["missing summary", undefined],
    ["null summary", null],
    ["array summary", []],
    ["string summary", "covered"],
    ["numeric summary", 40],
  ] as const) {
    it(`rejects malformed ${name}`, () => {
      expect(() => checkCoverage(value)).toThrow(Error);
    });
  }

  it("does not accept a matching suffix under a foreign root", () => {
    const summary = coverageSummary();
    const file = COVERAGE_REQUIREMENTS[0][0];
    const entry = summary[file];
    delete summary[file];
    summary[join(ROOT + "-foreign", file)] = entry!;
    expect(() => checkCoverage(summary)).toThrow(Error);
  });

  it("rejects duplicate relative and absolute keys for one source", () => {
    const summary = coverageSummary();
    const file = COVERAGE_REQUIREMENTS[0][0];
    summary[join(ROOT, file)] = { lines: { pct: 100 } };
    expect(() => checkCoverage(summary)).toThrow(Error);
  });

  it("rejects a second relative spelling that resolves to the same source", () => {
    const summary = coverageSummary();
    const file = COVERAGE_REQUIREMENTS[0][0];
    summary[`./${file}`] = { lines: { pct: 100 } };
    expect(() => checkCoverage(summary)).toThrow(Error);
  });
});
