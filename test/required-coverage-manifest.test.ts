import { beforeAll, describe, expect, it } from "vitest";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface CoverageManifestApi {
  REQUIRED_COVERAGE_TEST_FILES: readonly string[];
  REQUIRED_COVERAGE_GROUPS: Readonly<Record<string, readonly string[]>>;
}
interface CommandLine {
  name: string;
  args: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let manifest: CoverageManifestApi;
let packageScripts: Readonly<Record<string, string>>;
let ciSource: string;
let localSource: string;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalTestPath(value: unknown): value is string {
  return typeof value === "string"
    && /^(?:packages|apps|test)\/[A-Za-z0-9/._-]+\.test\.ts$/.test(value)
    && !isAbsolute(value)
    && value === posix.normalize(value)
    && value.split("/").every((part) => part !== "." && part !== ".." && part !== "");
}

/** No shell execution or permissive shell parsing: focused scripts have one closed grammar. */
function requiredScriptFiles(script: string): string[] {
  const parts = script.split(" && ");
  return parts.map((part) => {
    const match = /^node scripts\/run-required-(?:integration-)?suite\.mjs ([A-Za-z0-9/._-]+\.test\.ts)$/.exec(part);
    if (!match || !canonicalTestPath(match[1])) {
      throw new Error("named coverage script does not have the closed required-suite grammar");
    }
    return match[1];
  });
}

/** Inspect command lines, not comments or arbitrary mentions of a command in prose. */
function pnpmCommands(source: string): CommandLine[] {
  const commands: CommandLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("run:")) line = line.slice("run:".length).trim();
    for (const segment of line.split(/ && | \|\| |;[ \t]*/)) {
      // local verify-s3 passes its controlled environment array on the same command line.
      const command = segment.trim().replace(/^env[ \t]+"\$\{s3_test_env\[@\]\}"[ \t]+/, "");
      const match = /^pnpm[ \t]+(?:run[ \t]+)?([A-Za-z0-9:_-]+)(?=[ \t]|$)(.*)$/.exec(command);
      if (match) commands.push({ name: match[1]!, args: match[2]! });
    }
  }
  return commands;
}

/** Inspect only actual node command lines and this workflow's explicit job boundaries. */
function nodeLines(source: string): string[] {
  return source.split(/\r?\n/).map(line => line.trim().replace(/^run: /, ""))
    .filter(line => /^node scripts\/[a-z-]+\.mjs(?: |$)/.test(line));
}
function ciJob(name: string): string {
  const lines = ciSource.split(/\r?\n/), header = "  " + name + ":";
  const matches = lines.map((line, index) => line === header ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) throw new Error("missing or duplicate required CI job");
  let end = matches[0]! + 1;
  while (end < lines.length && !/^ {2}[a-z][a-z0-9-]*:$/.test(lines[end]!)) end++;
  return lines.slice(matches[0], end).join("\n");
}

beforeAll(async () => {
  // Repository .mjs imports cross an explicit unknown boundary, rather than unchecked any.
  const imported: unknown = await import(new URL("../scripts/required-coverage-suites.mjs", import.meta.url).href);
  if (!record(imported) || !Array.isArray(imported.REQUIRED_COVERAGE_TEST_FILES)
    || !record(imported.REQUIRED_COVERAGE_GROUPS)) {
    throw new Error("required coverage manifest exports are missing");
  }
  manifest = imported as unknown as CoverageManifestApi;
  const parsed: unknown = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
  if (!record(parsed) || !record(parsed.scripts)
    || Object.values(parsed.scripts).some((value) => typeof value !== "string")) {
    throw new Error("package scripts are not a string-valued object");
  }
  packageScripts = parsed.scripts as Record<string, string>;
  [ciSource, localSource] = await Promise.all([
    readFile(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(ROOT, "scripts/local-service.sh"), "utf8"),
  ]);
});

describe("required main-coverage manifest", () => {
  it("has nonempty, unique, canonical repository test paths, including both proof regressions", () => {
    const files = manifest.REQUIRED_COVERAGE_TEST_FILES;
    expect(files.length).toBeGreaterThan(0);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) expect(canonicalTestPath(file), file).toBe(true);
    expect(files).toContain("test/required-suite-proof.test.ts");
    expect(files).toContain("test/required-coverage-manifest.test.ts");
  });

  it("resolves every registered path to the exact regular file inside this checkout", async () => {
    const canonicalRoot = await realpath(ROOT);
    for (const file of manifest.REQUIRED_COVERAGE_TEST_FILES) {
      if (!canonicalTestPath(file)) throw new Error("noncanonical required file");
      const absolute = resolve(ROOT, file);
      const metadata = await lstat(absolute);
      expect(metadata.isFile(), file).toBe(true);
      expect(metadata.isSymbolicLink(), file).toBe(false);
      const resolved = await realpath(absolute);
      expect(relative(canonicalRoot, resolved).split(sep).join("/"), file).toBe(file);
    }
  });

  it("does not misclassify specialized profiles as main required coverage", () => {
    for (const file of manifest.REQUIRED_COVERAGE_TEST_FILES) {
      expect(file, file).not.toMatch(/\/migrations\/|\/cluster\/|\.minio\.test\.ts$|\.mysql-s3\.test\.ts$|\/e2e-qwen\.test\.ts$/);
    }
  });

  it("retains unique, nonempty group membership entirely within the main manifest", () => {
    const files = new Set(manifest.REQUIRED_COVERAGE_TEST_FILES);
    const groups = Object.entries(manifest.REQUIRED_COVERAGE_GROUPS);
    expect(groups.length).toBeGreaterThan(0);
    for (const [name, members] of groups) {
      expect(name).toMatch(/^test:[a-z0-9:-]+$/);
      expect(Array.isArray(members), name).toBe(true);
      expect(members.length, name).toBeGreaterThan(0);
      expect(new Set(members).size, name).toBe(members.length);
      for (const file of members) {
        expect(canonicalTestPath(file), name).toBe(true);
        expect(files.has(file), `${name}: ${file}`).toBe(true);
      }
    }
  });

  it("binds every removed named command to the same ordered exact standalone files", () => {
    for (const [name, members] of Object.entries(manifest.REQUIRED_COVERAGE_GROUPS)) {
      const script = packageScripts[name];
      expect(typeof script, name).toBe("string");
      if (script === undefined) throw new Error("registered named script is missing");
      expect(requiredScriptFiles(script), name).toEqual([...members]);
    }
  });

  it("registers every package script using the equivalent main required-suite runners", () => {
    const equivalent = Object.entries(packageScripts)
      .filter(([, script]) => /^node scripts\/run-required-(?:integration-)?suite\.mjs /.test(script))
      .map(([name]) => name).sort();
    expect(Object.keys(manifest.REQUIRED_COVERAGE_GROUPS).sort()).toEqual(equivalent);
  });

  it("registers every required runner MySQL suite in the formal integration driver's closed allowlist", async () => {
    const source = await readFile(resolve(ROOT, "scripts/run-required-integration-suite.mjs"), "utf8");
    const allowed = new Set([...source.matchAll(/relativeTestFile\s*===\s*"([^"]+)"/g)].map(match => match[1]));
    const runners = manifest.REQUIRED_COVERAGE_TEST_FILES.filter(file =>
      file.startsWith("apps/agent-runner/test/") && file.endsWith(".mysql.test.ts"));
    expect(runners.length).toBeGreaterThan(0);
    for (const file of runners) expect(allowed.has(file), `formal integration driver must admit ${file}`).toBe(true);
  });

  it.each(["test:mcp", "test:mcp-progress", "test:mcp-dcr", "test:skills", "test:hooks", "test:tenant-hooks"])("keeps the public OpenAPI contract in the %s focused gate", async (name) => {
    expect(manifest.REQUIRED_COVERAGE_TEST_FILES).toContain("test/openapi-contract.test.ts");
    expect(manifest.REQUIRED_COVERAGE_GROUPS[name]).toContain("test/openapi-contract.test.ts");
    const driver = await readFile(resolve(ROOT, "scripts/run-required-suite.mjs"), "utf8");
    expect(driver).toContain('relativeTestFile === "test/openapi-contract.test.ts"');
  });

  it("admits exact focused skills/MCP/hooks/subagent SDK and signed VM suites without opening other paths", async () => {
    const file = "packages/sdk/test/skills.test.ts", mcpFile = "packages/sdk/test/mcp.test.ts";
    const signedVm = ["test/vm-release-signature.test.ts", "test/vm-release-signed.test.ts", "test/vm-release-sign-cli.test.ts"];
    const hookFile = "packages/sdk/test/tenant-hooks.test.ts", sseFile = "packages/sdk/test/sse.test.ts";
    const startupFile = "test/harness-startup-ownership.test.ts";
    const httpExperienceFiles = ["test/http-experience.test.ts", "test/http-experience-fixture.test.ts"];
    expect(requiredScriptFiles(packageScripts["test:http-experience"]!)).toEqual(httpExperienceFiles);
    expect(manifest.REQUIRED_COVERAGE_GROUPS["test:http-experience"]).toEqual(httpExperienceFiles);
    const sseObservationFiles = ["packages/core/test/host-observation.test.ts",
      "apps/agent-runner/test/sse-bounds.test.ts", "apps/agent-runner/test/mcp-progress-sse.test.ts"];
    expect(requiredScriptFiles(packageScripts["test:sse-observation"]!)).toEqual(sseObservationFiles);
    expect(manifest.REQUIRED_COVERAGE_GROUPS["test:sse-observation"]).toEqual(sseObservationFiles);
    for (const [command, expected] of [["test:skills", [file]], ["test:mcp-registry", [mcpFile]], ["test:mcp-dcr", [mcpFile]], ["test:mcp-progress", [sseFile]], ["test:tenant-hooks", [hookFile]], ["test:vm-release", signedVm], ["test:cluster-harness-startup", [startupFile]]] as const) {
      for (const target of expected) {
        expect(requiredScriptFiles(packageScripts[command]!)).toContain(target);
        expect(manifest.REQUIRED_COVERAGE_GROUPS[command]).toContain(target);
      }
    }
    const driver = await readFile(resolve(ROOT, "scripts/run-required-suite.mjs"), "utf8");
    // Evaluate only the real driver's closed path clauses, without spawning Vitest or executing it.
    const guard = /\nif \(!\(([\s\S]+?)\)\s*\|\| !relativeTestFile\.endsWith\("\.test\.ts"\)\) \{/.exec(driver);
    if (!guard) throw new Error("required-suite path guard is not the expected closed policy");
    const clauses = guard[1]!.split(/\s*\|\|\s*/).map((source) => {
      const prefix = /^relativeTestFile\.startsWith\("([^"]+)"\)$/.exec(source.trim());
      const exact = /^relativeTestFile === "([^"]+)"$/.exec(source.trim());
      if (!prefix && !exact) throw new Error("required-suite path clause is not a literal policy");
      return { prefix: prefix?.[1], exact: exact?.[1] };
    });
    const admitted = (path: string) => path.endsWith(".test.ts") && clauses.some(clause =>
      clause.prefix !== undefined ? path.startsWith(clause.prefix) : path === clause.exact);
    const subagentFile = "packages/sdk/test/subagents.test.ts";
    const recordReferenceFile = "packages/sdk/test/record-assistant-reference.test.ts";
    for (const target of [file, mcpFile, sseFile, hookFile, subagentFile, recordReferenceFile, startupFile, ...signedVm, ...httpExperienceFiles]) expect(admitted(target), target).toBe(true);
    for (const other of ["packages/sdk/test/client.test.ts", "packages/sdk/test/other.test.ts",
      "packages/sdk/test/skills-extra.test.ts", "packages/sdk/test/nested/skills.test.ts", "packages/sdk/test/skills.test.ts.extra",
      "packages/sdk/test/mcp-extra.test.ts", "packages/sdk/test/nested/mcp.test.ts", "packages/sdk/test/mcp.test.ts.extra",
      "packages/sdk/test/sse-extra.test.ts", "packages/sdk/test/nested/sse.test.ts", "packages/sdk/test/sse.test.ts.extra",
      "packages/sdk/test/tenant-hooks-extra.test.ts", "packages/sdk/test/nested/tenant-hooks.test.ts", "packages/sdk/test/tenant-hooks.test.ts.extra",
      "packages/sdk/test/subagents-extra.test.ts", "packages/sdk/test/nested/subagents.test.ts", "packages/sdk/test/subagents.test.ts.extra",
      "packages/sdk/test/record-assistant-reference-extra.test.ts", "packages/sdk/test/nested/record-assistant-reference.test.ts",
      "packages/sdk/test/record-assistant-reference.test.ts.extra",
      "test/vm-release-signature-extra.test.ts", "test/vm-release-signed-copy.test.ts", "test/vm-release-sign-cli-extra.test.ts",
      "test/nested/vm-release-signature.test.ts", "test/unknown.test.ts",
      "test/http-experience-extra.test.ts", "test/nested/http-experience.test.ts", "test/http-experience.test.ts.extra",
      "test/http-experience-fixture-extra.test.ts", "test/nested/http-experience-fixture.test.ts", "test/http-experience-fixture.test.ts.extra",
      "test/harness-startup-ownership-extra.test.ts", "test/nested/harness-startup-ownership.test.ts", "test/harness-startup-ownership.test.ts.extra"]) {
      expect(admitted(other), other).toBe(false);
    }
    expect(clauses.filter(clause => clause.exact?.startsWith("packages/sdk/"))).toEqual([
      { prefix: undefined, exact: file }, { prefix: undefined, exact: mcpFile },
      { prefix: undefined, exact: sseFile },
      { prefix: undefined, exact: hookFile },
      { prefix: undefined, exact: subagentFile },
      { prefix: undefined, exact: recordReferenceFile },
    ]);
    for (const target of [...signedVm, startupFile, ...httpExperienceFiles]) expect(clauses.filter(clause => clause.exact === target)).toEqual([{ prefix: undefined, exact: target }]);
    // All literal focused-driver destinations must satisfy the same real policy, not just this gate.
    const allLiteralTargets = Object.values(packageScripts).flatMap(script =>
      [...script.matchAll(/(?:^|[\s&])node scripts\/run-required-suite\.mjs ([A-Za-z0-9/._-]+\.test\.ts)(?=\s|$)/g)].map(match => match[1]!));
    expect(allLiteralTargets.length).toBeGreaterThan(0);
    for (const target of allLiteralTargets) expect(admitted(target), target).toBe(true);
  });

  it("local runs main coverage once without re-executing equivalent groups", () => {
    const commands = pnpmCommands(localSource);
    expect(commands.filter(command => command.name === "test:coverage")).toHaveLength(1);
    expect(commands.filter(command => Object.hasOwn(manifest.REQUIRED_COVERAGE_GROUPS, command.name))).toEqual([]);
  });

  it("CI collects three native shards and requires one official merge, never duplicate focused groups", () => {
    const commands = pnpmCommands(ciSource);
    expect(commands.filter(command => command.name === "test:coverage" || command.name === "test:migrations")).toEqual([]);
    expect(commands.filter(command => Object.hasOwn(manifest.REQUIRED_COVERAGE_GROUPS, command.name))).toEqual([]);
    const main = ciJob("test-main"), merge = ciJob("test-main-merge");
    expect(main).toMatch(/^ {6}fail-fast: false$/m);
    expect(main).toMatch(/^ {8}shard: \[1, 2, 3\]$/m);
    expect(nodeLines(main)).toContain('node scripts/run-main-coverage-shard.mjs --shard ${{ matrix.shard }} --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" --source-commit "$GITHUB_SHA" --artifact-dir "$RUNNER_TEMP/main-coverage-shard-${{ matrix.shard }}"');
    expect(nodeLines(ciSource).filter(line => line.startsWith("node scripts/run-main-coverage-shard.mjs "))).toHaveLength(1);
    expect(nodeLines(merge)).toContain('node scripts/merge-main-coverage.mjs --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" --source-commit "$GITHUB_SHA" --artifacts-dir "$RUNNER_TEMP/main-coverage-inputs" --output-dir "$RUNNER_TEMP/main-coverage-aggregate"');
    expect(nodeLines(ciSource).filter(line => line.startsWith("node scripts/merge-main-coverage.mjs "))).toHaveLength(1);
    expect(merge).toMatch(/^ {4}needs: \[test-main\]$/m);
    expect(ciJob("test-core")).toMatch(/^ {4}needs: \[test-main-merge, test-runtime\]$/m);
  });

  it("keeps integration, supported-floor MySQL and Redis on every isolated CI main shard", () => {
    const main = ciJob("test-main");
    expect(main).toMatch(/^ {8}image: mysql:8\.0\.26$/m);
    expect(main).toMatch(/^ {8}image: redis:8$/m);
    expect(main).toMatch(/^ {10}AGENT_SERVICE_INTEGRATION: "1"$/m);
    expect(main).toMatch(/^ {10}MYSQL_TEST_URL: mysql:\/\/root@127\.0\.0\.1:3306\/agent_service_test_main$/m);
    expect(main).toMatch(/^ {10}REDIS_TEST_URL: redis:\/\/127\.0\.0\.1:6379\/1$/m);
    expect(main).not.toMatch(/^ {4}needs:/m);
    expect(main).not.toContain("MINIO_SOURCE_COMMIT");
  });

  it("keeps integration, MySQL and Redis configuration on the single local coverage invocation", () => {
    const lines = localSource.split(/\r?\n/);
    const index = lines.findIndex((line) => /^\s*pnpm run test:coverage\s*$/.test(line));
    expect(index).toBeGreaterThanOrEqual(3);
    const prefix = lines.slice(index - 3, index).join("\n");
    expect(prefix).toMatch(/^\s*AGENT_SERVICE_INTEGRATION=1 \\$/m);
    expect(prefix).toMatch(/^\s*MYSQL_TEST_URL="\$\{MYSQL_TEST_URL:-[^\r\n]+\}" \\$/m);
    expect(prefix).toMatch(/^\s*REDIS_TEST_URL="\$\{REDIS_TEST_URL:-[^\r\n]+\}" \\$/m);
  });

  it.each(["CI", "local"] as const)("%s retains history, process clusters, actual build and VM assembly", (surface) => {
    const commands = pnpmCommands(surface === "CI" ? ciSource : localSource);
    for (const name of [...(surface === "local" ? ["test:migrations"] : []), "test:tenant-redis-purge-cluster", "build:check", "check:vm-release"]) {
      expect(commands.filter((command) => command.name === name), `${surface}: ${name}`).toHaveLength(1);
    }
    expect(commands.some((command) => command.name === "test:cluster"
      || (command.name === "vitest" && /^\s+run\s+test\/cluster(?:\s|$)/.test(command.args)))).toBe(true);
  });

  it("CI retains the full zero-skip historical manifest through three original shards and strict union", () => {
    const collect = ciJob("test-history-shard"), aggregate = ciJob("test-history");
    expect(collect).toMatch(/^ {6}fail-fast: false$/m);
    expect(collect).toMatch(/^ {8}shard: \[1, 2, 3\]$/m);
    expect(nodeLines(collect)).toContain("node scripts/run-migration-shard.mjs --shard ${{ matrix.shard }}/3");
    expect(nodeLines(ciSource).filter(line => line.startsWith("node scripts/run-migration-shard.mjs "))).toHaveLength(1);
    expect(collect).toMatch(/^ {10}MYSQL_MIGRATION_TEST_URL: mysql:\/\/root@127\.0\.0\.1:3306\/agent_service_test_history$/m);
    expect(aggregate).toMatch(/^ {4}needs: \[test-history-shard\]$/m);
    expect(nodeLines(aggregate)).toContain('node scripts/merge-migration-shards.mjs --input-dir "$GITHUB_WORKSPACE/.local-run/migration-shards"');
    expect(nodeLines(ciSource).filter(line => line.startsWith("node scripts/merge-migration-shards.mjs "))).toHaveLength(1);
    for (const index of [1, 2, 3]) expect(aggregate).toContain("name: migration-shard-" + index + "-attempt-${{ github.run_attempt }}");
    expect(aggregate).toContain("name: historical-migration-proof-attempt-${{ github.run_attempt }}");
    expect(aggregate).toContain(".local-run/migration-aggregate-${{ github.run_id }}-${{ github.run_attempt }}/aggregate-proof.json");
  });

  it.each(["CI", "local"] as const)("%s retains every separately configured S3 profile command", (surface) => {
    const commands = pnpmCommands(surface === "CI" ? ciSource : localSource);
    const special = Object.keys(packageScripts).filter((name) => name.startsWith("test:") && /(?:^|-)s3(?:-|$)/.test(name.slice(5)));
    expect(special.length).toBeGreaterThan(0);
    for (const name of special) {
      expect(Object.hasOwn(manifest.REQUIRED_COVERAGE_GROUPS, name), name).toBe(false);
      expect(commands.filter((command) => command.name === name), `${surface}: ${name}`).toHaveLength(1);
    }
  });
});

describe("closed named-command audit grammar", () => {
  const FILE = "packages/store/test/session-delete-grace.mysql.test.ts";
  it("accepts only exact node required-suite or required-integration-suite chains", () => {
    expect(requiredScriptFiles(`node scripts/run-required-suite.mjs ${FILE} && node scripts/run-required-integration-suite.mjs ${FILE}`)).toEqual([FILE, FILE]);
  });

  it.each([
    `vitest run ${FILE}`,
    "node scripts/run-required-suite.mjs",
    `node scripts/run-required-cluster-suite.mjs ${FILE}`,
    `node scripts/run-required-suite.mjs --passWithNoTests ${FILE}`,
    `node scripts/run-required-suite.mjs --testNamePattern skip ${FILE}`,
    "node scripts/run-required-suite.mjs ../outside.test.ts",
    "node scripts/run-required-suite.mjs packages/store/test/../session.test.ts",
    "node scripts/run-required-suite.mjs /tmp/foreign.test.ts",
    `AGENT_SERVICE_INTEGRATION=0 node scripts/run-required-suite.mjs ${FILE}`,
  ])("rejects a changed runner, flags, environment override or noncanonical input: %s", (script) => {
    expect(() => requiredScriptFiles(script)).toThrow("closed required-suite grammar");
  });

  it.each([" --passWithNoTests", " -t skip", " || true", "; true", " && echo skipped", "\ntrue"])("rejects appended shell or runner behavior %j", (suffix) => {
    expect(() => requiredScriptFiles(`node scripts/run-required-suite.mjs ${FILE}${suffix}`)).toThrow("closed required-suite grammar");
  });

  it("does not count comments, echoed strings or similar command suffixes as execution", () => {
    const commands = pnpmCommands([
      "# pnpm run test:coverage",
      'echo "pnpm run test:coverage"',
      "pnpm run test:coverage-extra",
      "run: pnpm run test:coverage",
      'env "${s3_test_env[@]}" pnpm run test:blob-s3',
      "pnpm run test:coverage && pnpm run test:blob-mysql",
    ].join("\n"));
    expect(commands).toEqual([
      { name: "test:coverage-extra", args: "" },
      { name: "test:coverage", args: "" },
      { name: "test:blob-s3", args: "" },
      { name: "test:coverage", args: "" },
      { name: "test:blob-mysql", args: "" },
    ]);
  });
});
