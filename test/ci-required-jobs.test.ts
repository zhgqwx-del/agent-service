import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface CiJobsApi {
  CI_REQUIRED_JOBS: readonly string[];
  assertCiRequiredJobs(value: unknown): readonly string[];
  parseCiRequiredJobsResults(value: unknown): readonly string[];
}
type NeedsRow = { result: string; outputs: Record<string, string> };
const NAMES = ["test-core", "test-history", "image"] as const;
const RESULTS = ["success", "failure", "cancelled", "skipped"] as const;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/assert-ci-required-jobs.mjs");
const OUTPUT_MARKER = "fixture-outputs-must-not-be-printed";
const owned = new Set<string>();
let api: CiJobsApi;
let workflow: string;
let nodeVersion: string;
beforeAll(async () => {
  const imported: unknown = await import(new URL("../scripts/assert-ci-required-jobs.mjs", import.meta.url).href);
  api = imported as CiJobsApi;
  [workflow, nodeVersion] = await Promise.all([
    readFile(join(ROOT, ".github/workflows/ci.yml"), "utf8"), readFile(join(ROOT, ".node-version"), "utf8"),
  ]);
});
afterEach(async () => {
  for (const root of owned) { await rm(root, { recursive: true, force: true }); owned.delete(root); }
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "agent-service-ci-required-test-")); owned.add(root); return root;
}
function needs(): Record<string, NeedsRow> {
  return Object.fromEntries(NAMES.map((name) => [name, { result: "success", outputs: { proof: OUTPUT_MARKER } }]));
}
function invoke(cwd: string, value: string | undefined, args: string[] = [], script = SCRIPT) {
  return spawnSync(process.execPath, [script, ...args], { cwd,
    env: { PATH: "", NODE_ENV: "test", ...(value === undefined ? {} : { AGENT_SERVICE_CI_NEEDS_JSON: value }) },
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 });
}

describe("closed required CI job results", () => {
  it("exports and returns only the exact frozen required job names", () => {
    expect(api.CI_REQUIRED_JOBS).toEqual(NAMES); expect(Object.isFrozen(api.CI_REQUIRED_JOBS)).toBe(true);
    const result = api.assertCiRequiredJobs(needs());
    expect(result).toEqual(NAMES); expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(OUTPUT_MARKER);
  });
  it.each(RESULTS.flatMap((core) => RESULTS.flatMap((history) => RESULTS.map((image) => ({ core, history, image }))))) (
    "requires all three results: core=$core history=$history image=$image", ({ core, history, image }) => {
      const input = needs(); input["test-core"]!.result = core; input["test-history"]!.result = history; input.image!.result = image;
      if ([core, history, image].every((value) => value === "success")) {
        expect(api.assertCiRequiredJobs(input)).toEqual(NAMES);
        expect(api.parseCiRequiredJobsResults(JSON.stringify(input))).toEqual(NAMES);
      } else {
        expect(() => api.assertCiRequiredJobs(input)).toThrow();
        expect(() => api.parseCiRequiredJobsResults(JSON.stringify(input))).toThrow();
      }
    });
  it("accepts ordinary toJSON formatting, arbitrary key order, and explicit empty outputs", () => {
    const input = { image: { outputs: {}, result: "success" }, "test-history": { outputs: { a: "", unicode: "结果" }, result: "success" },
      "test-core": { result: "success", outputs: {} } };
    expect(api.parseCiRequiredJobsResults(JSON.stringify(input, null, 2))).toEqual(NAMES);
    const nullPrototype = Object.assign(Object.create(null), needs());
    for (const name of NAMES) nullPrototype[name] = Object.assign(Object.create(null), { result: "success", outputs: Object.create(null) });
    expect(api.assertCiRequiredJobs(nullPrototype)).toEqual(NAMES);
  });
  it.each(NAMES)("rejects missing %s rather than accepting the remaining successes", (name) => {
    const input = needs(); delete input[name]; expect(() => api.assertCiRequiredJobs(input)).toThrow();
  });
  it("rejects extra jobs, including matrix child names instead of the aggregate image result", () => {
    expect(() => api.assertCiRequiredJobs({ ...needs(), extra: { result: "success", outputs: {} } })).toThrow();
    const input = needs(); delete input.image;
    expect(() => api.assertCiRequiredJobs({ ...input, "image (agent-runner)": { result: "success", outputs: {} },
      "image (agent-router)": { result: "success", outputs: {} } })).toThrow();
  });
  it.each([null, [], "success", 1, new Map(), Object.create({ inherited: true })].map((value) => ({ value })))(
    "rejects non-record needs $value", ({ value }) => { expect(() => api.assertCiRequiredJobs(value)).toThrow(); });
  it.each([
    null, [], "success", { result: "success" }, { outputs: {} }, { result: "success", outputs: {}, extra: true },
    { result: ["success"], outputs: {} }, { result: true, outputs: {} }, { result: "Success", outputs: {} },
    { result: "success", outputs: null }, { result: "success", outputs: [] }, { result: "success", outputs: "" },
    { result: "success", outputs: { count: 1 } }, { result: "success", outputs: { nested: {} } },
    { result: "success", outputs: { absent: undefined } },
  ].map((row) => ({ row })))("rejects nonclosed/coercible result row $row", ({ row }) => {
    expect(() => api.assertCiRequiredJobs({ ...needs(), "test-core": row })).toThrow();
  });
  it.each(["needs", "row", "outputs"] as const)("rejects %s accessors without executing them", (scope) => {
    let calls = 0; const input = needs();
    const target = scope === "needs" ? input : scope === "row" ? input["test-core"]! : input["test-core"]!.outputs;
    const key = scope === "needs" ? "test-core" : scope === "row" ? "result" : "proof";
    Object.defineProperty(target, key, { enumerable: true, get() { calls += 1; throw new Error(OUTPUT_MARKER); } });
    expect(() => api.assertCiRequiredJobs(input)).toThrow(); expect(calls).toBe(0);
  });
  it.each(["needs", "row", "outputs"] as const)("rejects %s custom prototype, symbol and hidden/unsafe own fields", (scope) => {
    for (const kind of ["prototype", "symbol", "hidden", "proto-key"] as const) {
      const input = needs();
      const target = scope === "needs" ? input : scope === "row" ? input["test-core"]! : input["test-core"]!.outputs;
      if (kind === "prototype") Object.setPrototypeOf(target, { inherited: true });
      else if (kind === "symbol") Object.defineProperty(target, Symbol("not-json"), { value: "hidden", enumerable: true });
      else Object.defineProperty(target, kind === "hidden" ? "hidden" : "__proto__", { value: "unsafe", enumerable: kind !== "hidden" });
      expect(() => api.assertCiRequiredJobs(input)).toThrow();
    }
  });
});

describe("bounded needs JSON and actual CLI", () => {
  it.each([undefined, null, {}, [], 1, Buffer.from("{}"), "", "{", "null", "[]"].map((value) => ({ value })))(
    "rejects absent/non-string/malformed JSON $value", ({ value }) => { expect(() => api.parseCiRequiredJobsResults(value)).toThrow(); });
  it("enforces the 16KiB UTF8 budget, not UTF16 character length", () => {
    const input = needs(); input.image!.outputs.proof = "界".repeat(6000);
    const text = JSON.stringify(input); expect(text.length).toBeLessThan(16 * 1024); expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1024);
    expect(() => api.parseCiRequiredJobsResults(text)).toThrow();
    expect(() => api.parseCiRequiredJobsResults(" ".repeat(16 * 1024 + 1))).toThrow();
  });
  it.each([
    ["root", (text: string) => text.replace('{"test-core":', '{"test-core":{"result":"failure","outputs":{}},"test-core":')],
    ["escaped-root", (text: string) => text.replace('{"test-core":', '{"test-\\u0063ore":{"result":"failure","outputs":{}},"test-core":')],
    ["row", (text: string) => text.replace('"result":"success"', '"result":"failure","result":"success"')],
    ["escaped-row", (text: string) => text.replace('"result":"success"', '"res\\u0075lt":"failure","result":"success"')],
    ["outputs", (text: string) => text.replace('"proof":', '"proof":"discarded","proof":')],
    ["escaped-outputs", (text: string) => text.replace('"proof":', '"pr\\u006fof":"discarded","proof":')],
  ] as const)("rejects duplicate %s keys rather than accepting JSON last-wins", (_name, mutate) => {
    const text = mutate(JSON.stringify(needs()));
    expect(JSON.parse(text)).toEqual(needs());
    expect(() => api.parseCiRequiredJobsResults(text)).toThrow();
  });
  it("prints only the controlled success line in a real Node CLI process", async () => {
    const cwd = await temp(); const result = invoke(cwd, JSON.stringify(needs(), null, 2));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).toBe("CI required jobs passed\n"); expect(result.stdout).not.toContain(OUTPUT_MARKER);
    expect(await readdir(cwd)).toEqual([]);
  });
  it.each(["missing-env", "malformed", "failed-job", "cancelled-job", "skipped-job", "unknown-arg"] as const)("closes actual CLI %s without dumping needs/outputs", async (kind) => {
    const cwd = await temp(); const input = needs();
    input["test-history"]!.result = kind === "cancelled-job" ? "cancelled" : kind === "skipped-job" ? "skipped" : "failure";
    const result = invoke(cwd, kind === "missing-env" ? undefined : kind === "malformed" ? `{${OUTPUT_MARKER}`
      : JSON.stringify(kind.endsWith("-job") ? input : needs()), kind === "unknown-arg" ? ["--help"] : []);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toBe("CI required jobs failed\n"); expect(result.stderr).not.toContain(OUTPUT_MARKER);
    expect(await readdir(cwd)).toEqual([]);
  });
  it("is silent when imported, but executes through a current-directory file alias", async () => {
    const cwd = await temp();
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.argv[1]);", pathToFileURL(SCRIPT).href], {
      cwd, env: { PATH: "", NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
    });
    expect(imported.error).toBeUndefined(); expect(imported.status).toBe(0); expect(imported.stdout).toBe(""); expect(imported.stderr).toBe("");
    await mkdir(join(cwd, "version")); await symlink(SCRIPT, join(cwd, "version", "gate.mjs"));
    await symlink(join(cwd, "version"), join(cwd, "current"), "dir");
    const result = invoke(cwd, JSON.stringify(needs()), [], join(cwd, "current", "gate.mjs"));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stdout).toBe("CI required jobs passed\n"); expect(result.stderr).toBe("");
  });
});

type Block = { name: string; lines: string[] };
type Step = { lines: string[]; fields: Map<string, string>; run: string[] };
function invalidWorkflow(): never { throw new Error("invalid repository required CI workflow"); }
function meaningful(line: string) { return line.trim() !== "" && !line.trimStart().startsWith("#"); }
function indentation(line: string) { return line.length - line.trimStart().length; }
function fieldsAt(lines: string[], indent: number): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = new RegExp(`^ {${indent}}([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$`);
  for (const line of lines.filter(meaningful)) {
    if (indentation(line) !== indent) continue;
    const match = pattern.exec(line); if (!match || result.has(match[1]!)) invalidWorkflow();
    result.set(match[1]!, match[2] ?? "");
  }
  return result;
}
function section(lines: string[], name: string, indent: number): string[] {
  const header = `${" ".repeat(indent)}${name}:`;
  const index = lines.findIndex((line) => line === header);
  if (index < 0) invalidWorkflow();
  let end = index + 1;
  while (end < lines.length && (!meaningful(lines[end]!) || indentation(lines[end]!) > indent)) end += 1;
  return lines.slice(index + 1, end);
}
function blocksAt(lines: string[], indent: number): Block[] {
  const pattern = new RegExp(`^ {${indent}}([a-z][a-z0-9-]*):$`);
  const blocks: Block[] = []; let current: Block | undefined;
  for (const line of lines) {
    if (!meaningful(line)) { current?.lines.push(line); continue; }
    if (indentation(line) === indent) {
      const match = pattern.exec(line); if (!match || blocks.some((block) => block.name === match[1])) invalidWorkflow();
      current = { name: match[1]!, lines: [] }; blocks.push(current);
    } else { if (!current || indentation(line) < indent) invalidWorkflow(); current.lines.push(line); }
  }
  return blocks;
}
function scalar(value: string | undefined): string {
  if (value === undefined) invalidWorkflow();
  if (/^"[^"\\]*"$|^'[^']*'$/.test(value)) return value.slice(1, -1);
  return value;
}
function steps(job: Block): Step[] {
  const raw = section(job.lines, "steps", 4); const groups: string[][] = [];
  for (const line of raw) {
    if (!meaningful(line)) { groups.at(-1)?.push(line); continue; }
    if (/^ {6}- (?:name|uses|run):/.test(line)) groups.push([line]);
    else { if (!groups.length || indentation(line) < 8) invalidWorkflow(); groups.at(-1)!.push(line); }
  }
  return groups.map((group) => {
    const normalized = group.map((line, index) => index === 0 ? `        ${line.slice(8)}` : line);
    const fields = fieldsAt(normalized, 8);
    if ([...fields.keys()].some((key) => !["name", "uses", "run", "with", "env", "if"].includes(key))) invalidWorkflow();
    const value = fields.get("run"); let run: string[] = [];
    if (value === "|") run = section(normalized.map((line) => line === "        run: |" ? "        run:" : line), "run", 8)
      .filter(meaningful).map((line) => line.trim());
    else if (value !== undefined) run = [value];
    return { lines: normalized, fields, run };
  });
}
function env(job: Block, step: Step): Map<string, string> {
  const values = job.lines.includes("    env:") ? fieldsAt(section(job.lines, "env", 4), 6) : new Map<string, string>();
  if (step.lines.includes("        env:")) for (const [key, value] of fieldsAt(section(step.lines, "env", 8), 10)) values.set(key, value);
  return values;
}
function exactCommand(all: Step[], command: string): Step {
  const found = all.filter((step) => step.run.includes(command));
  if (found.length !== 1 || found[0]!.fields.has("if")) invalidWorkflow();
  return found[0]!;
}
function action(all: Step[], uses: string): Step {
  const found = all.filter((step) => step.fields.get("uses") === uses);
  if (found.length !== 1 || found[0]!.fields.has("if")) invalidWorkflow(); return found[0]!;
}
const CORE_COMMANDS = ["pnpm run test:coverage", "pnpm run test:blob-s3", "pnpm run test:skills-s3", "pnpm run test:restore-journal-s3",
  "pnpm run test:backup-catalog-s3", "pnpm run test:tenant-telemetry-writer-s3", "pnpm run test:telemetry-capture-mysql-s3",
  "pnpm run test:tenant-telemetry-disposition-s3", "pnpm run test:tenant-telemetry-disposition-journal-v3-s3",
  "pnpm run test:tenant-telemetry-disposition-journal-v3-observer-s3", "pnpm run test:tenant-telemetry-artifact-observer-s3",
  "pnpm run test:backup-catalog-reconcile-mysql-s3", "pnpm run test:backup-catalog-restore-roundtrip-mysql-s3",
  "pnpm run test:mysql-backup-artifact-mysql-s3", "pnpm run test:telemetry-capture-restore-mysql-s3",
  "pnpm run test:blob-storage-migration-mysql-s3",
  "pnpm vitest run test/cluster", "pnpm run test:tenant-redis-purge-cluster", "pnpm run build:check",
  'pnpm run check:vm-release --artifacts "$RUNNER_TEMP/agent-service-vm-releases"',
  "pnpm run check:blob-storage-migrate-artifact", "pnpm run check:restore-ledger-reconcile-artifact",
  "pnpm run check:telemetry-capture-artifact", "pnpm run check:backup-catalog-artifact", "pnpm run test:app-s3-smoke"];
const SKILL_REGISTRY_IMAGE_MARKERS = [
  "mysql -h 127.0.0.1 -uroot agent_service -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0060_skill_registry.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot agent_service -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0061_skill_registry_native_lookup.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot agent_service -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0062_mcp_registry.sql'\" | grep -Fxq 1",
] as const;

/** Deliberately NOT a YAML parser: close this repository's fixed indentation/layout.
 * New YAML forms require reviewing this grammar, not silently ignoring control keys. */
function assertWorkflow(source: string, version: string) {
  if (source.includes("\t") || version.trim() !== "24"
    || /^\s*continue-on-error:/m.test(source) || /^\s*(?:<<:|[A-Za-z_-]+: [*&])/m.test(source)) invalidWorkflow();
  const lines = source.split(/\r?\n/); if (lines.filter((line) => line === "jobs:").length !== 1) invalidWorkflow();
  const jobs = blocksAt(section(lines, "jobs", 0), 2);
  if (JSON.stringify(jobs.map((job) => job.name).sort()) !== JSON.stringify(["image", "test", "test-core", "test-history"])) invalidWorkflow();
  const byName = (name: string) => { const job = jobs.find((entry) => entry.name === name); if (!job) invalidWorkflow(); return job; };
  for (const job of jobs) {
    const data = fieldsAt(job.lines, 4);
    if ([...data.keys()].some((key) => !["name", "runs-on", "timeout-minutes", "env", "services", "steps", "strategy", "needs", "if", "permissions"].includes(key))
      || data.get("runs-on") !== "ubuntu-latest") invalidWorkflow();
    if (job.name !== "test" && (data.has("if") || data.has("needs"))) invalidWorkflow();
    for (const step of steps(job)) {
      if (!step.fields.has("if")) continue;
      if (job.name === "image" && step.fields.get("if") === "matrix.app == 'agent-runner'") continue;
      if (job.name === "test-core" && step.fields.get("if") === "always()"
        && step.fields.get("uses") === "actions/upload-artifact@v4" && step.fields.get("name") === "Upload coverage") continue;
      if (job.name === "test-history" && step.fields.get("if") === "always()"
        && step.fields.get("uses") === "actions/upload-artifact@v4" && step.fields.get("name") === "Preserve historical execution proof") continue;
      invalidWorkflow();
    }
  }
  const core = byName("test-core"), history = byName("test-history"), gate = byName("test"), image = byName("image");
  for (const job of [core, history]) {
    const all = steps(job);
    if (fieldsAt(section(action(all, "actions/checkout@v4").lines, "with", 8), 10).get("fetch-depth") !== "0"
      || fieldsAt(section(action(all, "pnpm/action-setup@v4").lines, "with", 8), 10).get("version") !== "12.5.1"
      || fieldsAt(section(action(all, "actions/setup-node@v4").lines, "with", 8), 10).get("node-version-file") !== ".node-version") invalidWorkflow();
    const install = exactCommand(all, "pnpm install --frozen-lockfile"); if (install.run.length !== 1) invalidWorkflow();
    const services = blocksAt(section(job.lines, "services", 4), 6);
    if (JSON.stringify(services.map((entry) => entry.name).sort()) !== JSON.stringify(["mysql", "redis"])) invalidWorkflow();
    for (const [name, expected] of [["mysql", "mysql:8.0.26"], ["redis", "redis:8"]]) {
      if (fieldsAt(services.find((entry) => entry.name === name)!.lines, 8).get("image") !== expected) invalidWorkflow();
    }
  }
  const coreSteps = steps(core), historySteps = steps(history);
  for (const command of CORE_COMMANDS) {
    const step = exactCommand(coreSteps, command);
    if (step.run.some((line) => !CORE_COMMANDS.includes(line))) invalidWorkflow();
  }
  if (coreSteps.some((step) => step.run.some((line) => /\btest:migrations\b/.test(line)))) invalidWorkflow();
  const migration = exactCommand(historySteps, "pnpm run test:migrations");
  if (migration.run.length !== 1 || historySteps.filter((step) => step.run.some((line) => /\btest:migrations\b/.test(line))).length !== 1) invalidWorkflow();
  const migrationUrl = new URL(scalar(env(history, migration).get("MYSQL_MIGRATION_TEST_URL")));
  const coverage = exactCommand(coreSteps, "pnpm run test:coverage"), coverageEnv = env(core, coverage);
  const coreUrl = new URL(scalar(coverageEnv.get("MYSQL_TEST_URL")));
  if (scalar(coverageEnv.get("AGENT_SERVICE_INTEGRATION")) !== "1" || !/^redis:\/\/127\.0\.0\.1:6379\/[0-9]+$/.test(scalar(coverageEnv.get("REDIS_TEST_URL")))
    || migrationUrl.protocol !== "mysql:" || migrationUrl.hostname !== "127.0.0.1" || migrationUrl.port !== "3306"
    || coreUrl.protocol !== "mysql:" || migrationUrl.pathname === coreUrl.pathname
    || !/^\/[A-Za-z0-9_]+$/.test(migrationUrl.pathname) || !/(?:^|_)test(?:$|_)/.test(migrationUrl.pathname.slice(1))) invalidWorkflow();
  const schema = migrationUrl.pathname.slice(1);
  if (!historySteps.some((step) => step.run.some((line) => new RegExp(`CREATE DATABASE(?: IF NOT EXISTS)? ${schema} CHARACTER SET utf8mb4`).test(line)))) invalidWorkflow();
  const matrix = section(image.lines, "strategy", 4).filter(meaningful);
  if (JSON.stringify(matrix) !== JSON.stringify(["      matrix:", "        app: [agent-runner, agent-router]"])) invalidWorkflow();
  if (fieldsAt(blocksAt(section(image.lines, "services", 4), 6).find((entry) => entry.name === "mysql")!.lines, 8).get("image") !== "mysql:8.0") invalidWorkflow();
  const imageSteps = steps(image), imageSmoke = exactCommand(imageSteps, SKILL_REGISTRY_IMAGE_MARKERS[0]);
  for (const marker of SKILL_REGISTRY_IMAGE_MARKERS) {
    const markerIndex = imageSmoke.run.indexOf(marker);
    const runnerBranchIndex = imageSmoke.run.lastIndexOf('if [ "${{ matrix.app }}" = "agent-runner" ]; then', markerIndex);
    if (exactCommand(imageSteps, marker) !== imageSmoke || imageSmoke.fields.get("name") !== "Run the container and reach it from outside"
      || imageSmoke.run[0] !== "set -euo pipefail" || runnerBranchIndex < 0
      || !imageSmoke.run.slice(runnerBranchIndex + 1, markerIndex).every((line) => line.startsWith("mysql "))) invalidWorkflow();
  }
  const gateFields = fieldsAt(gate.lines, 4);
  if (!/^(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?$/.test(gateFields.get("if") ?? "")
    || gateFields.get("needs") !== "[test-core, test-history, image]") invalidWorkflow();
  const gateSteps = steps(gate), checked = exactCommand(gateSteps, "node scripts/assert-ci-required-jobs.mjs");
  action(gateSteps, "actions/checkout@v4");
  if (fieldsAt(section(action(gateSteps, "actions/setup-node@v4").lines, "with", 8), 10).get("node-version-file") !== ".node-version") invalidWorkflow();
  if (checked.run.length !== 1 || scalar(env(gate, checked).get("AGENT_SERVICE_CI_NEEDS_JSON")) !== "${{ toJSON(needs) }}"
    || gateSteps.filter((step) => step.fields.has("run")).length !== 1) invalidWorkflow();
}

describe("repository CI job split cannot skip required work", () => {
  it("keeps independent supported-floor core/history jobs and an always-running exact final gate", () => {
    expect(() => assertWorkflow(workflow, nodeVersion)).not.toThrow();
  });
  it("runs both unchanged cluster gates before the long coverage and S3 matrix", () => {
    const core = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2).find((job) => job.name === "test-core")!;
    const all = steps(core);
    const cluster = exactCommand(all, "pnpm vitest run test/cluster");
    const rollout = exactCommand(all, "pnpm run test:tenant-redis-purge-cluster");
    const coverage = exactCommand(all, "pnpm run test:coverage");
    expect(all.indexOf(cluster)).toBeLessThan(all.indexOf(rollout));
    expect(all.indexOf(rollout)).toBeLessThan(all.indexOf(coverage));
    expect(all.indexOf(coverage)).toBeLessThan(all.indexOf(exactCommand(all, "pnpm run test:blob-s3")));
    expect(scalar(env(core, cluster).get("AGENT_SERVICE_CLUSTER"))).toBe("1");
    for (const step of [cluster, rollout]) {
      expect(scalar(env(core, step).get("CLUSTER_MYSQL_URL"))).toBe("mysql://root@127.0.0.1:3306/agent_service_cluster");
      expect(scalar(env(core, step).get("CLUSTER_REDIS_URL"))).toBe("redis://127.0.0.1:6379/3");
    }
    expect(scalar(env(core, coverage).get("MYSQL_TEST_URL"))).toBe("mysql://root@127.0.0.1:3306/agent_service_test");
    expect(scalar(env(core, coverage).get("REDIS_TEST_URL"))).toBe("redis://127.0.0.1:6379/1");
  });
  it.each(SKILL_REGISTRY_IMAGE_MARKERS)("requires the exact skills marker inside the actual runner image smoke: %s", (marker) => {
    const image = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2).find((job) => job.name === "image")!;
    const smoke = exactCommand(steps(image), marker);
    expect(smoke.fields.get("name")).toBe("Run the container and reach it from outside");
    const changed = workflow.replace(`            ${marker}\n`, "");
    expect(changed).not.toBe(workflow);
    expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
  it.each([
    ["core job false", (text: string) => text.replace("  test-core:\n", "  test-core:\n    if: false\n")],
    ["history job false", (text: string) => text.replace("  test-history:\n", "  test-history:\n    if: false\n")],
    ["history step false", (text: string) => text.replace("        run: pnpm run test:migrations", "        if: false\n        run: pnpm run test:migrations")],
    ["history depends on core", (text: string) => text.replace("  test-history:\n", "  test-history:\n    needs: [test-core]\n")],
    ["core depends on history", (text: string) => text.replace("  test-core:\n", "  test-core:\n    needs: [test-history]\n")],
    ["ignore history failure", (text: string) => text.replace("        run: pnpm run test:migrations", "        run: pnpm run test:migrations || true")],
    ["history filter", (text: string) => text.replace("        run: pnpm run test:migrations", "        run: pnpm run test:migrations -t selected")],
    ["continue on error", (text: string) => text.replace("  test-history:\n", "  test-history:\n    continue-on-error: true\n")],
    ["unsupported floor", (text: string) => text.replaceAll("image: mysql:8.0.26", "image: mysql:8.0")],
    ["shallow frozen fixture checkout", (text: string) => text.replaceAll("fetch-depth: 0", "fetch-depth: 1")],
    ["unpinned pnpm", (text: string) => text.replaceAll("version: 12.5.1", "version: latest")],
    ["nonfrozen install", (text: string) => text.replaceAll("pnpm install --frozen-lockfile", "pnpm install")],
    ["missing history need", (text: string) => text.replace("needs: [test-core, test-history, image]", "needs: [test-core, image]")],
    ["final step false", (text: string) => text.replace("        run: node scripts/assert-ci-required-jobs.mjs", "        if: false\n        run: node scripts/assert-ci-required-jobs.mjs")],
    ["caller-selected fake results", (text: string) => text.replace("AGENT_SERVICE_CI_NEEDS_JSON: ${{ toJSON(needs) }}", "AGENT_SERVICE_CI_NEEDS_JSON: '{}'")],
    ["missing MinIO profile", (text: string) => text.replace("run: pnpm run test:blob-s3", "run: true")],
    ["missing managed skills MinIO profile", (text: string) => text.replace("run: pnpm run test:skills-s3", "run: true")],
    ["managed skills MinIO profile false", (text: string) => text.replace("        run: pnpm run test:skills-s3", "        if: false\n        run: pnpm run test:skills-s3")],
    ["missing actual capture restore", (text: string) => text.replace("run: pnpm run test:telemetry-capture-restore-mysql-s3", "run: true")],
    ["missing VM assembly", (text: string) => text.replace('run: pnpm run check:vm-release --artifacts "$RUNNER_TEMP/agent-service-vm-releases"', "run: true")],
    ["one-role image matrix", (text: string) => text.replace("app: [agent-runner, agent-router]", "app: [agent-runner]")],
    ["missing migration environment", (text: string) => text.replace("MYSQL_MIGRATION_TEST_URL:", "UNUSED_MIGRATION_TEST_URL:")],
    ["shared test database", (text: string) => text.replaceAll("agent_service_test_history", "agent_service_test")],
    ["duplicate job", (text: string) => text + "\n  test-history:\n    runs-on: ubuntu-latest\n"],
  ] as const)("rejects workflow bypass: %s", (_name, mutate) => {
    const changed = mutate(workflow); expect(changed).not.toBe(workflow);
    expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
  it("rejects a final gate that only runs after success instead of always", () => {
    const gateIndex = workflow.indexOf("\n  test:\n"); expect(gateIndex).toBeGreaterThan(0);
    const changed = workflow.slice(0, gateIndex) + workflow.slice(gateIndex).replace(/if: (?:\$\{\{\s*)?always\(\)(?:\s*\}\})?/, "if: success()");
    expect(changed).not.toBe(workflow); expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
});
