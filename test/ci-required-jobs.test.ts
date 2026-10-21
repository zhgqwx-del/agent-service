import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const PINNED_NODE_VERSION = "24.21.0";
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
const RUNTIME_COMMANDS = ["pnpm run test:blob-s3", "pnpm run test:skills-s3", "pnpm run test:restore-journal-s3",
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
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0060_skill_registry.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0061_skill_registry_native_lookup.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0062_mcp_registry.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0063_tenant_webhooks.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0064_subagents.sql'\" | grep -Fxq 1",
  "mysql -h 127.0.0.1 -uroot \"$CI_IMAGE_DATABASE\" -Nse \"SELECT COUNT(*) FROM schema_migrations WHERE name = '0065_mcp_dcr.sql'\" | grep -Fxq 1",
] as const;

const RUNTIME_CONTRACT_SHA256 = "7d73d4b733136ab5df4bdb2fcdd1fa8021ab5d696f60aa706d019befad02a467";
// The reviewed M4 image contract explicitly prepares schema with the same image ID, then boots
// with a private runtime-only env file. Marker/bootstrap/health assertions and the 20m budget remain.
const IMAGE_CONTRACT_SHA256 = "eecf5207a0c4a039fb114b782994c93a70629ad4d2173bd4e3f03907e1ad3797";
// Only the explicitly reviewed VM artifact attempt suffix is normalized; all other original runtime/image bytes remain pinned.
const contractSha256 = (job: Block): string => createHash("sha256").update(["  " + job.name + ":", ...job.lines].filter(meaningful).join("\n")
  .replace("          name: vm-process-releases-linux-x64-attempt-${{ github.run_attempt }}", "          name: vm-process-releases-linux-x64")).digest("hex");
const MAIN_COLLECT = 'node scripts/run-main-coverage-shard.mjs --shard ${{ matrix.shard }} --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" --source-commit "$GITHUB_SHA" --artifact-dir "$RUNNER_TEMP/main-coverage-shard-${{ matrix.shard }}"';
const MAIN_MERGE = 'node scripts/merge-main-coverage.mjs --run-id "$GITHUB_RUN_ID" --run-attempt "$GITHUB_RUN_ATTEMPT" --source-commit "$GITHUB_SHA" --artifacts-dir "$RUNNER_TEMP/main-coverage-inputs" --output-dir "$RUNNER_TEMP/main-coverage-aggregate"';
const HISTORY_COLLECT = 'node scripts/run-migration-shard.mjs --shard ${{ matrix.shard }}/3';
const HISTORY_MERGE = 'node scripts/merge-migration-shards.mjs --input-dir "$GITHUB_WORKSPACE/.local-run/migration-shards"';
const JOB_NAMES = ["image", "test", "test-core", "test-history", "test-history-shard", "test-main", "test-main-merge", "test-runtime"];
const ALWAYS = /^(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?$/;
function checkedSettings(step: Step): Map<string, string> {
  return fieldsAt(section(step.lines, "with", 8), 10);
}
function setting(step: Step, key: string): string {
  const value = checkedSettings(step).get(key);
  if (value !== "|") return scalar(value);
  return section(step.lines.map(line => line === "          " + key + ": |" ? "          " + key + ":" : line), key, 10)
    .filter(meaningful).map(line => line.trim()).join("\n");
}
function namedStep(job: Block, name: string): Step {
  const found = steps(job).filter(step => step.fields.get("name") === name);
  if (found.length !== 1) invalidWorkflow(); return found[0]!;
}
function exactEnv(job: Block, step: Step, expected: Record<string, string>): void {
  const values = env(job, step);
  if (JSON.stringify([...values.keys()].sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.entries(expected).some(([key, value]) => scalar(values.get(key)) !== value)) invalidWorkflow();
}
function aggregate(job: Block, needs: string, budget: string): void {
  const fields = fieldsAt(job.lines, 4);
  if (!ALWAYS.test(fields.get("if") ?? "") || fields.get("needs") !== needs
    || fields.get("timeout-minutes") !== budget || fields.has("services") || fields.has("strategy")) invalidWorkflow();
}
function shardMatrix(job: Block): void {
  const matrix = section(job.lines, "strategy", 4).filter(meaningful);
  if (JSON.stringify(matrix) !== JSON.stringify(["      fail-fast: false", "      matrix:", "        shard: [1, 2, 3]"])) invalidWorkflow();
}
function setupNode(all: Step[], cached: boolean): void {
  const settings = checkedSettings(action(all, "actions/setup-node@v4"));
  if (settings.get("node-version-file") !== ".node-version" || settings.size !== (cached ? 2 : 1)
    || cached && settings.get("cache") !== "pnpm") invalidWorkflow();
}
function setup(job: Block, frozen = true): void {
  const all = steps(job);
  if (fieldsAt(section(action(all, "actions/checkout@v4").lines, "with", 8), 10).get("fetch-depth") !== "0"
    || fieldsAt(section(action(all, "pnpm/action-setup@v4").lines, "with", 8), 10).get("version") !== "12.5.1") invalidWorkflow();
  setupNode(all, true);
  if (frozen && exactCommand(all, "pnpm install --frozen-lockfile").run.length !== 1) invalidWorkflow();
}
function services(job: Block, names: string[]): void {
  const entries = blocksAt(section(job.lines, "services", 4), 6);
  if (JSON.stringify(entries.map(entry => entry.name).sort()) !== JSON.stringify([...names].sort())) invalidWorkflow();
  for (const name of names) {
    const service = entries.find(entry => entry.name === name)!;
    const fields = fieldsAt(service.lines, 8);
    if (fields.get("image") !== (name === "mysql" ? "mysql:8.0.26" : "redis:8")
      || fields.get("ports") !== (name === "mysql" ? '["3306:3306"]' : '["6379:6379"]')) invalidWorkflow();
  }
}
function uploads(job: Block, expected: { step: string; name: string; path: string; hidden?: boolean; always?: boolean; retention: string }[]): void {
  const actual = steps(job).filter(step => step.fields.get("uses") === "actions/upload-artifact@v4");
  if (actual.length !== expected.length) invalidWorkflow();
  for (const entry of expected) {
    const step = namedStep(job, entry.step), fields = checkedSettings(step);
    if (!actual.includes(step) && !actual.some(candidate => JSON.stringify(candidate.lines) === JSON.stringify(step.lines))) invalidWorkflow();
    if (setting(step, "name") !== entry.name || setting(step, "path") !== entry.path
      || setting(step, "if-no-files-found") !== "error" || setting(step, "retention-days") !== entry.retention
      || entry.hidden && setting(step, "include-hidden-files") !== "true"
      || (entry.always ? step.fields.get("if") !== "always()" : step.fields.has("if"))
      || [...fields.keys()].some(key => !["name", "path", "include-hidden-files", "if-no-files-found", "retention-days"].includes(key))) invalidWorkflow();
  }
}
/** Close this repository's reviewed workflow grammar; no permissive YAML/control fallback. */
function assertWorkflow(source: string, version: string) {
  if (source.includes("\t") || version.trim() !== PINNED_NODE_VERSION || /^\s*continue-on-error:/m.test(source)
    || /^\s*(?:<<:|[A-Za-z_-]+: [*&])/m.test(source)) invalidWorkflow();
  const lines = source.split(/\r?\n/); if (lines.filter(line => line === "jobs:").length !== 1) invalidWorkflow();
  const jobs = blocksAt(section(lines, "jobs", 0), 2);
  if (JSON.stringify(jobs.map(job => job.name).sort()) !== JSON.stringify(JOB_NAMES)) invalidWorkflow();
  const byName = (name: string) => { const job = jobs.find(entry => entry.name === name); if (!job) invalidWorkflow(); return job; };
  const main = byName("test-main"), merged = byName("test-main-merge"), runtime = byName("test-runtime");
  const historyShard = byName("test-history-shard"), history = byName("test-history"), core = byName("test-core"), gate = byName("test"), image = byName("image");
  const aggregated = ["test-main-merge", "test-history", "test-core", "test"];
  const allowedAlways = new Set(["test-main:Preserve original main shard evidence (even on failure)", "test-main-merge:Upload coverage",
    "test-main-merge:Preserve merged main execution proof", "test-history-shard:Preserve original historical shard evidence (even on failure)", "test-history:Preserve historical execution proof"]);
  for (const job of jobs) {
    const fields = fieldsAt(job.lines, 4);
    if ([...fields.keys()].some(key => !["name", "runs-on", "timeout-minutes", "env", "services", "steps", "strategy", "needs", "if", "permissions"].includes(key))
      || fields.get("runs-on") !== "ubuntu-latest") invalidWorkflow();
    if (!aggregated.includes(job.name) && (fields.has("if") || fields.has("needs"))) invalidWorkflow();
    if ([main.name, runtime.name, historyShard.name].includes(job.name) && fields.get("timeout-minutes") !== "180") invalidWorkflow();
    for (const step of steps(job)) {
      if (!step.fields.has("if")) continue;
      if (job.name === "image" && step.fields.get("if") === "matrix.app == 'agent-runner'") continue;
      if (job.name === "image" && step.fields.get("name") === "Remove only this job's private runtime credential file"
        && step.fields.get("if") === "${{ always() && matrix.app == 'agent-runner' }}") continue;
      if (allowedAlways.has(job.name + ":" + step.fields.get("name")) && step.fields.get("if") === "always()"
        && step.fields.get("uses") === "actions/upload-artifact@v4") continue;
      invalidWorkflow();
    }
  }
  for (const job of [main, merged, runtime, historyShard, history]) setup(job);
  services(main, ["mysql", "redis"]); services(runtime, ["mysql", "redis"]); services(historyShard, ["mysql"]);
  shardMatrix(main); shardMatrix(historyShard);
  const mainSteps = steps(main), mainCollection = exactCommand(mainSteps, MAIN_COLLECT);
  if (mainCollection.run.length !== 1 || mainSteps.some(step => step.run.some(line => /test:coverage|test:migrations|\b(?:vitest|merge-main-coverage)\b/.test(line)))) invalidWorkflow();
  exactEnv(main, mainCollection, { AGENT_SERVICE_INTEGRATION: "1", MYSQL_TEST_URL: "mysql://root@127.0.0.1:3306/agent_service_test_main", REDIS_TEST_URL: "redis://127.0.0.1:6379/1" });
  const mainDatabase = exactCommand(mainSteps, 'mysql -h 127.0.0.1 -uroot -e "CREATE DATABASE agent_service_test_main CHARACTER SET utf8mb4;"');
  const mysqlAuthority = exactCommand(mainSteps, "node scripts/ci-owned-mysql-authority.mjs");
  exactEnv(main, mysqlAuthority, { MYSQL_TEST_SERVICE_CONTAINER_ID: "${{ job.services.mysql.id }}",
    MYSQL_TEST_URL: "mysql://root@127.0.0.1:3306/agent_service_test_main" });
  if (mysqlAuthority.run.length !== 1 || mainSteps.indexOf(mysqlAuthority) <= mainSteps.indexOf(mainDatabase)
    || mainSteps.indexOf(mysqlAuthority) >= mainSteps.indexOf(mainCollection)) invalidWorkflow();
  uploads(main, [{ step: "Preserve original main shard evidence (even on failure)", name: "main-coverage-shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/main-coverage-shard-${{ matrix.shard }}/", hidden: true, always: true, retention: "7" }]);
  aggregate(merged, "[test-main]", "180");
  const mergedSteps = steps(merged), mainGuard = exactCommand(mergedSteps, 'test "$MAIN_SHARDS_RESULT" = success');
  exactEnv(merged, mainGuard, { MAIN_SHARDS_RESULT: "${{ needs.test-main.result }}" });
  if (mergedSteps.indexOf(mainGuard) !== 0 || exactCommand(mergedSteps, MAIN_MERGE).run.length !== 1) invalidWorkflow();
  const mainDownloads = mergedSteps.filter(step => step.fields.get("uses") === "actions/download-artifact@v4");
  if (mainDownloads.length !== 3) invalidWorkflow();
  for (const index of [1, 2, 3]) {
    const download = namedStep(merged, "Download original main shard " + index);
    if (download.fields.has("if") || download.fields.get("uses") !== "actions/download-artifact@v4"
      || JSON.stringify([...checkedSettings(download)]) !== JSON.stringify([["name", "main-coverage-shard-" + index + "-attempt-${{ github.run_attempt }}"], ["path", "${{ runner.temp }}/main-coverage-inputs/main-coverage-shard-" + index]])) invalidWorkflow();
  }
  uploads(merged, [
    { step: "Upload coverage", name: "coverage-attempt-${{ github.run_attempt }}", path: "${{ runner.temp }}/main-coverage-aggregate/coverage/", always: true, retention: "7" },
    { step: "Preserve merged main execution proof", name: "main-coverage-proof-attempt-${{ github.run_attempt }}", path: "${{ runner.temp }}/main-coverage-aggregate/tests.json\n${{ runner.temp }}/main-coverage-aggregate/proof.json\n${{ runner.temp }}/main-coverage-aggregate/discovery.json", always: true, retention: "7" },
  ]);
  const historySteps = steps(historyShard), historyCollection = exactCommand(historySteps, HISTORY_COLLECT);
  if (historyCollection.run.length !== 1 || historySteps.some(step => step.run.some(line => /test:migrations|test:coverage|\bvitest\b/.test(line)))) invalidWorkflow();
  exactEnv(historyShard, historyCollection, { MYSQL_MIGRATION_TEST_URL: "mysql://root@127.0.0.1:3306/agent_service_test_history" });
  exactCommand(historySteps, 'mysql -h 127.0.0.1 -uroot -e "CREATE DATABASE agent_service_test_history CHARACTER SET utf8mb4;"');
  uploads(historyShard, [{ step: "Preserve original historical shard evidence (even on failure)", name: "migration-shard-${{ matrix.shard }}-attempt-${{ github.run_attempt }}",
    path: ".local-run/migration-shards/${{ matrix.shard }}/", hidden: true, always: true, retention: "7" }]);
  aggregate(history, "[test-history-shard]", "180");
  const historyAggregateSteps = steps(history), historyGuard = exactCommand(historyAggregateSteps, 'test "$HISTORY_SHARDS_RESULT" = success');
  exactEnv(history, historyGuard, { HISTORY_SHARDS_RESULT: "${{ needs.test-history-shard.result }}" });
  if (historyAggregateSteps.indexOf(historyGuard) !== 0 || exactCommand(historyAggregateSteps, HISTORY_MERGE).run.length !== 1) invalidWorkflow();
  const downloads = historyAggregateSteps.filter(step => step.fields.get("uses") === "actions/download-artifact@v4");
  if (downloads.length !== 3) invalidWorkflow();
  for (const index of [1, 2, 3]) {
    const download = namedStep(history, "Download original historical shard " + index);
    if (download.fields.has("if") || download.fields.get("uses") !== "actions/download-artifact@v4"
      || JSON.stringify([...checkedSettings(download)]) !== JSON.stringify([["name", "migration-shard-" + index + "-attempt-${{ github.run_attempt }}"], ["path", "${{ github.workspace }}/.local-run/migration-shards/" + index]])) invalidWorkflow();
  }
  uploads(history, [{ step: "Preserve historical execution proof", name: "historical-migration-proof-attempt-${{ github.run_attempt }}",
    path: ".local-run/migration-shards/1/tests.json\n.local-run/migration-shards/1/metadata.json\n.local-run/migration-shards/2/tests.json\n.local-run/migration-shards/2/metadata.json\n.local-run/migration-shards/3/tests.json\n.local-run/migration-shards/3/metadata.json\n.local-run/migration-aggregate-${{ github.run_id }}-${{ github.run_attempt }}/aggregate-proof.json", hidden: true, always: true, retention: "7" }]);
  if (contractSha256(runtime) !== RUNTIME_CONTRACT_SHA256 || contractSha256(image) !== IMAGE_CONTRACT_SHA256) invalidWorkflow();
  const runtimeSteps = steps(runtime);
  for (const command of RUNTIME_COMMANDS) {
    const step = exactCommand(runtimeSteps, command);
    if (step.run.some(line => !RUNTIME_COMMANDS.includes(line))) invalidWorkflow();
  }
  for (const command of ["node scripts/check-secrets.mjs", "pnpm run check:api", "pnpm typecheck"]) exactCommand(runtimeSteps, command);
  if (runtimeSteps.some(step => step.run.some(line => /test:coverage|test:migrations|run-main-coverage-shard|run-migration-shard/.test(line)))) invalidWorkflow();
  const cluster = exactCommand(runtimeSteps, "pnpm vitest run test/cluster"), rollout = exactCommand(runtimeSteps, "pnpm run test:tenant-redis-purge-cluster");
  if (!(runtimeSteps.indexOf(cluster) < runtimeSteps.indexOf(rollout) && runtimeSteps.indexOf(rollout) < runtimeSteps.indexOf(exactCommand(runtimeSteps, "pnpm run test:blob-s3")))) invalidWorkflow();
  for (const step of [cluster, rollout]) {
    if (scalar(env(runtime, step).get("CLUSTER_MYSQL_URL")) !== "mysql://root@127.0.0.1:3306/agent_service_cluster"
      || scalar(env(runtime, step).get("CLUSTER_REDIS_URL")) !== "redis://127.0.0.1:6379/3") invalidWorkflow();
  }
  if (scalar(env(runtime, cluster).get("AGENT_SERVICE_CLUSTER")) !== "1") invalidWorkflow();
  uploads(runtime, [{ step: "Preserve verified Node 24 VM transport candidates", name: "vm-process-releases-linux-x64-attempt-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/agent-service-vm-releases/", retention: "14" }]);
  aggregate(core, "[test-main-merge, test-runtime]", "5");
  const coreSteps = steps(core);
  if (coreSteps.length !== 1 || JSON.stringify(coreSteps[0]!.run) !== JSON.stringify(['set -euo pipefail', 'test "$MAIN_MERGE_RESULT" = success', 'test "$RUNTIME_RESULT" = success'])) invalidWorkflow();
  exactEnv(core, coreSteps[0]!, { MAIN_MERGE_RESULT: "${{ needs.test-main-merge.result }}", RUNTIME_RESULT: "${{ needs.test-runtime.result }}" });
  const matrix = section(image.lines, "strategy", 4).filter(meaningful);
  if (JSON.stringify(matrix) !== JSON.stringify(["      matrix:", "        app: [agent-runner, agent-router]"])) invalidWorkflow();
  if (fieldsAt(blocksAt(section(image.lines, "services", 4), 6).find(entry => entry.name === "mysql")!.lines, 8).get("image") !== "mysql:8.0") invalidWorkflow();
  const imageSteps = steps(image), imageSmoke = exactCommand(imageSteps, SKILL_REGISTRY_IMAGE_MARKERS[0]);
  const imagePreparation = imageSteps.find(step => step.fields.get("name") === "Prepare explicit schema and runtime authority with the selected runner image");
  if (!imagePreparation) invalidWorkflow();
  exactEnv(image, imagePreparation, { CI_IMAGE_MYSQL_SERVICE_CONTAINER_ID: "${{ job.services.mysql.id }}" });
  if (imagePreparation.fields.get("if") !== "matrix.app == 'agent-runner'"
    || imageSteps.indexOf(imagePreparation) >= imageSteps.indexOf(imageSmoke)
    || !imagePreparation.run.includes('RUNNER_IMAGE_ID="$(docker image inspect --format \'{{.Id}}\' agent-service/agent-runner:ci)"')
    || !imagePreparation.run.includes('--entrypoint node "$RUNNER_IMAGE_ID" /app/ci/ci-image-runtime.mjs')
    || !imagePreparation.run.includes('-e CI_IMAGE_MYSQL_URL=mysql://root@127.0.0.1:3306/agent_service_test_image_base \\')
    || !imagePreparation.run.includes('CI_IMAGE_DATABASE="$(<"$FIXTURE_DIRECTORY/database.txt")"')) invalidWorkflow();
  const privatePathPublication = imagePreparation.run.indexOf('printf \'CI_IMAGE_RUNTIME_ENV_FILE=%s\\n\' "$FIXTURE_DIRECTORY/runtime.env" >> "$GITHUB_ENV"');
  if (privatePathPublication < 0 || privatePathPublication >= imagePreparation.run.findIndex(line => line.startsWith("docker run --rm"))) invalidWorkflow();
  const runnerStart = imageSmoke.run.slice(imageSmoke.run.indexOf('if [ "${{ matrix.app }}" = "agent-runner" ]; then'), imageSmoke.run.indexOf("else"));
  if (!runnerStart.includes('--env-file "$CI_IMAGE_RUNTIME_ENV_FILE" \\')
    || !runnerStart.includes('"$CI_RUNNER_IMAGE_ID"')
    || !runnerStart.includes('test "$(docker inspect -f \'{{.Image}}\' app)" = "$CI_RUNNER_IMAGE_ID"')
    || runnerStart.some(line => /-e (?:MYSQL_URL|SCHEMA_)/.test(line))) invalidWorkflow();
  const imageCredentialCleanup = imageSteps.find(step => step.fields.get("name") === "Remove only this job's private runtime credential file");
  if (!imageCredentialCleanup) invalidWorkflow();
  if (imageCredentialCleanup.fields.get("if") !== "${{ always() && matrix.app == 'agent-runner' }}"
    || imageSteps.indexOf(imageCredentialCleanup) <= imageSteps.indexOf(imageSmoke)
    || !imageCredentialCleanup.run.includes('rm -f -- "$CI_IMAGE_RUNTIME_ENV_FILE"')) invalidWorkflow();
  for (const marker of SKILL_REGISTRY_IMAGE_MARKERS) {
    const markerIndex = imageSmoke.run.indexOf(marker);
    const runnerBranchIndex = imageSmoke.run.lastIndexOf('if [ "${{ matrix.app }}" = "agent-runner" ]; then', markerIndex);
    if (exactCommand(imageSteps, marker) !== imageSmoke || imageSmoke.fields.get("name") !== "Run the container and reach it from outside"
      || imageSmoke.run[0] !== "set -euo pipefail" || runnerBranchIndex < 0
      || !imageSmoke.run.slice(runnerBranchIndex + 1, markerIndex).every(line => line.startsWith("mysql "))) invalidWorkflow();
  }
  aggregate(gate, "[test-core, test-history, image]", "5");
  const gateSteps = steps(gate), checked = exactCommand(gateSteps, "node scripts/assert-ci-required-jobs.mjs");
  action(gateSteps, "actions/checkout@v4");
  setupNode(gateSteps, false);
  if (checked.run.length !== 1 || scalar(env(gate, checked).get("AGENT_SERVICE_CI_NEEDS_JSON")) !== "${{ toJSON(needs) }}"
    || gateSteps.filter(step => step.fields.has("run")).length !== 1) invalidWorkflow();
}

describe("repository native shards cannot skip required work", () => {
  it("keeps three isolated native main/history shards, strict merges and stable mandatory checks", () => {
    expect(() => assertWorkflow(workflow, nodeVersion)).not.toThrow();
  });
  it.each(["24", "24.x", "24.21", "24.22.0", "latest", "lts/*"])("rejects a floating or different Node version: %s", version => {
    expect(() => assertWorkflow(workflow, version)).toThrow();
  });
  it.each(["test-main", "test-main-merge", "test-runtime", "test-history-shard", "test-history", "test"])("rejects independent Node selection in %s", name => {
    const index = workflow.indexOf("\n  " + name + ":\n"); expect(index).toBeGreaterThan(0);
    for (const setting of ["node-version: 24.22.0", "check-latest: true", "node-version-file: .alternate-node-version"]) {
      const changed = workflow.slice(0, index) + workflow.slice(index).replace("          node-version-file: .node-version",
        setting.startsWith("node-version-file:") ? "          " + setting : "          node-version-file: .node-version\n          " + setting);
      expect(changed).not.toBe(workflow); expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
    }
  });
  it("pins the unchanged runtime and explicitly reviewed M4 image commands, environment, services and budgets", () => {
    const jobs = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2);
    expect(contractSha256(jobs.find(job => job.name === "test-runtime")!)).toBe(RUNTIME_CONTRACT_SHA256);
    expect(contractSha256(jobs.find(job => job.name === "image")!)).toBe(IMAGE_CONTRACT_SHA256);
  });
  it("runs unchanged cluster gates before S3 while main and history have no runtime dependency", () => {
    const jobs = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2);
    const runtime = jobs.find(job => job.name === "test-runtime")!, all = steps(runtime);
    expect(all.indexOf(exactCommand(all, "pnpm vitest run test/cluster"))).toBeLessThan(all.indexOf(exactCommand(all, "pnpm run test:tenant-redis-purge-cluster")));
    expect(all.indexOf(exactCommand(all, "pnpm run test:tenant-redis-purge-cluster"))).toBeLessThan(all.indexOf(exactCommand(all, "pnpm run test:blob-s3")));
    for (const name of ["test-main", "test-history-shard", "test-runtime"]) expect(fieldsAt(jobs.find(job => job.name === name)!.lines, 4).has("needs")).toBe(false);
  });
  it.each(RESULTS.flatMap(main => RESULTS.map(runtime => ({ main, runtime })) ))("actual core shell fails closed: main=$main runtime=$runtime", ({ main, runtime }) => {
    const job = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2).find(job => job.name === "test-core")!;
    const checked = steps(job)[0]!;
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", checked.run.join("\n")], {
      env: { PATH: "", MAIN_MERGE_RESULT: main, RUNTIME_RESULT: runtime }, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
    expect(result.status).toBe(main === "success" && runtime === "success" ? 0 : 1);
  });
  it.each(["test-main-merge", "test-history"] as const)("actual %s shell rejects failed, cancelled and skipped matrix results", (name) => {
    const job = blocksAt(section(workflow.split(/\r?\n/), "jobs", 0), 2).find(job => job.name === name)!;
    const guard = steps(job)[0]!, key = name === "test-history" ? "HISTORY_SHARDS_RESULT" : "MAIN_SHARDS_RESULT";
    for (const value of RESULTS) {
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", guard.run.join("\n")], {
        env: { PATH: "", [key]: value }, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024,
      });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(value === "success" ? 0 : 1);
      expect(result.stdout).toBe(""); expect(result.stderr).toBe("");
    }
  });
  it.each(SKILL_REGISTRY_IMAGE_MARKERS)("requires exact current marker checks inside the real runner image: %s", marker => {
    const changed = workflow.replace("            " + marker + "\n", "");
    expect(changed).not.toBe(workflow); expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
  it.each([
    ["main job false", (text: string) => text.replace("  test-main:\n", "  test-main:\n    if: false\n")],
    ["history shard false", (text: string) => text.replace("  test-history-shard:\n", "  test-history-shard:\n    if: false\n")],
    ["runtime job false", (text: string) => text.replace("  test-runtime:\n", "  test-runtime:\n    if: false\n")],
    ["core no always", (text: string) => text.replace("    needs: [test-main-merge, test-runtime]", "    needs: [test-runtime]")],
    ["main depends on runtime", (text: string) => text.replace("  test-main:\n", "  test-main:\n    needs: [test-runtime]\n")],
    ["history depends on core", (text: string) => text.replace("    needs: [test-history-shard]", "    needs: [test-core]")],
    ["fast cancels failed shards", (text: string) => text.replaceAll("fail-fast: false", "fail-fast: true")],
    ["missing third shard", (text: string) => text.replaceAll("shard: [1, 2, 3]", "shard: [1, 2]")],
    ["duplicate shard", (text: string) => text.replaceAll("shard: [1, 2, 3]", "shard: [1, 1, 3]")],
    ["unsupported MySQL floor", (text: string) => text.replaceAll("image: mysql:8.0.26", "image: mysql:8.0")],
    ["shallow frozen fixtures", (text: string) => text.replaceAll("fetch-depth: 0", "fetch-depth: 1")],
    ["unpinned pnpm", (text: string) => text.replaceAll("version: 12.5.1", "version: latest")],
    ["nonfrozen install", (text: string) => text.replaceAll("pnpm install --frozen-lockfile", "pnpm install")],
    ["main runtime filter", (text: string) => text.replace(MAIN_COLLECT, MAIN_COLLECT + " -t selected")],
    ["main fake source identity", (text: string) => text.replace(' --source-commit "$GITHUB_SHA"', ' --source-commit "$GITHUB_REF"')],
    ["main wrong run attempt", (text: string) => text.replace(' --run-attempt "$GITHUB_RUN_ATTEMPT"', ' --run-attempt "1"')],
    ["main ignores collection failure", (text: string) => text.replace(MAIN_COLLECT, MAIN_COLLECT + " || true")],
    ["main omits disposable MySQL authority", (text: string) => text.replace("node scripts/ci-owned-mysql-authority.mjs", "node scripts/unused-mysql-authority.mjs")],
    ["main fakes the service container identity", (text: string) => text.replace("MYSQL_TEST_SERVICE_CONTAINER_ID: ${{ job.services.mysql.id }}", "MYSQL_TEST_SERVICE_CONTAINER_ID: caller-selected-container")],
    ["main collector step false", (text: string) => text.replace("        run: |\n          " + MAIN_COLLECT, "        if: false\n        run: |\n          " + MAIN_COLLECT)],
    ["main merge bypass", (text: string) => text.replace(MAIN_MERGE, MAIN_MERGE + " --coverage.thresholds.lines=0")],
    ["main flat download", (text: string) => text.replace("path: ${{ runner.temp }}/main-coverage-inputs/main-coverage-shard-3", "path: ${{ runner.temp }}/main-coverage-inputs")],
    ["main missing third artifact", (text: string) => text.replace("name: main-coverage-shard-3-attempt-", "name: main-coverage-shard-2-attempt-")],
    ["main previous attempt artifact", (text: string) => text.replace("name: main-coverage-shard-3-attempt-${{ github.run_attempt }}", "name: main-coverage-shard-3-attempt-1")],
    ["VM artifact lacks attempt", (text: string) => text.replace("name: vm-process-releases-linux-x64-attempt-${{ github.run_attempt }}", "name: vm-process-releases-linux-x64")],
    ["history previous attempt artifact", (text: string) => text.replace("name: migration-shard-3-attempt-${{ github.run_attempt }}", "name: migration-shard-3-attempt-1")],
    ["main wrong input parent", (text: string) => text.replace(' --artifacts-dir "$RUNNER_TEMP/main-coverage-inputs"', ' --artifacts-dir "$RUNNER_TEMP/old-run"')],
    ["history filters native files", (text: string) => text.replace(HISTORY_COLLECT, HISTORY_COLLECT + " -t selected")],
    ["history ignores native failure", (text: string) => text.replace(HISTORY_COLLECT, HISTORY_COLLECT + " || true")],
    ["history collector step false", (text: string) => text.replace("        run: " + HISTORY_COLLECT, "        if: false\n        run: " + HISTORY_COLLECT)],
    ["history merge step false", (text: string) => text.replace("        run: " + HISTORY_MERGE, "        if: false\n        run: " + HISTORY_MERGE)],
    ["history missing artifact", (text: string) => text.replace("name: migration-shard-3", "name: migration-shard-2")],
    ["history flattened input", (text: string) => text.replace("path: ${{ github.workspace }}/.local-run/migration-shards/3", "path: ${{ github.workspace }}/.local-run/migration-shards")],
    ["missing history environment", (text: string) => text.replace("MYSQL_MIGRATION_TEST_URL:", "UNUSED_MIGRATION_TEST_URL:")],
    ["shared logical history base", (text: string) => text.replaceAll("agent_service_test_history", "agent_service_test_main")],
    ["artifact silent absence", (text: string) => text.replaceAll("if-no-files-found: error", "if-no-files-found: ignore")],
    ["failed raw evidence not retained", (text: string) => text.replace("        if: always()", "        if: success()")],
    ["caller selected main success", (text: string) => text.replace("MAIN_SHARDS_RESULT: ${{ needs.test-main.result }}", "MAIN_SHARDS_RESULT: success")],
    ["caller selected core success", (text: string) => text.replace("MAIN_MERGE_RESULT: ${{ needs.test-main-merge.result }}", "MAIN_MERGE_RESULT: success")],
    ["missing main core need", (text: string) => text.replace("needs: [test-main-merge, test-runtime]", "needs: [test-runtime]")],
    ["missing stable final history need", (text: string) => text.replace("needs: [test-core, test-history, image]", "needs: [test-core, image]")],
    ["final step false", (text: string) => text.replace("        run: node scripts/assert-ci-required-jobs.mjs", "        if: false\n        run: node scripts/assert-ci-required-jobs.mjs")],
    ["fake final results", (text: string) => text.replace("AGENT_SERVICE_CI_NEEDS_JSON: ${{ toJSON(needs) }}", "AGENT_SERVICE_CI_NEEDS_JSON: '{}'")],
    ["continue on error", (text: string) => text.replace("  test-history:\n", "  test-history:\n    continue-on-error: true\n")],
    ["missing S3 profile", (text: string) => text.replace("run: pnpm run test:blob-s3", "run: true")],
    ["missing managed skills S3", (text: string) => text.replace("run: pnpm run test:skills-s3", "run: true")],
    ["managed skills S3 false", (text: string) => text.replace("        run: pnpm run test:skills-s3", "        if: false\n        run: pnpm run test:skills-s3")],
    ["missing capture restore", (text: string) => text.replace("run: pnpm run test:telemetry-capture-restore-mysql-s3", "run: true")],
    ["missing VM assembly", (text: string) => text.replace('run: pnpm run check:vm-release --artifacts "$RUNNER_TEMP/agent-service-vm-releases"', "run: true")],
    ["one image role", (text: string) => text.replace("app: [agent-runner, agent-router]", "app: [agent-runner]")],
    ["image omits actual schema preparation", (text: string) => text.replace("/app/ci/ci-image-runtime.mjs", "/app/ci/unused-runtime.mjs")],
    ["image fakes service identity", (text: string) => text.replace("CI_IMAGE_MYSQL_SERVICE_CONTAINER_ID: ${{ job.services.mysql.id }}", "CI_IMAGE_MYSQL_SERVICE_CONTAINER_ID: caller-selected-container")],
    ["image runtime inherits operator URL", (text: string) => text.replace('-e STORE=mysql \\', '-e STORE=mysql -e MYSQL_URL=mysql://root@127.0.0.1:3306/agent_service_test_image_base \\')],
    ["image runtime bypasses private authority file", (text: string) => text.replace('--env-file "$CI_IMAGE_RUNTIME_ENV_FILE" \\', '--env-file "$RUNNER_TEMP/unverified.env" \\')],
    ["image selects mutable runtime after preparation", (text: string) => text.replace('              "$CI_RUNNER_IMAGE_ID"\n', '              agent-service/agent-runner:ci\n')],
    ["image loses actual image identity comparison", (text: string) => text.replace('test "$(docker inspect -f \'{{.Image}}\' app)" = "$CI_RUNNER_IMAGE_ID"', 'test -n "$CI_RUNNER_IMAGE_ID"')],
    ["image marker reads a different database", (text: string) => text.replaceAll('-uroot "$CI_IMAGE_DATABASE"', '-uroot agent_service_test_image_base')],
    ["image weakens private credential deletion ownership", (text: string) => text.replace('"$RUNNER_TEMP"/agent-service-image-runtime-??????/runtime.env)', '*)')],
    ["image cannot clean a partially written credential file", (text: string) => text.replace("CI_IMAGE_RUNTIME_ENV_FILE=%s", "UNUSED_IMAGE_RUNTIME_FILE=%s")],
    ["duplicate job", (text: string) => text + "\n  test-history:\n    runs-on: ubuntu-latest\n"],
  ] as const)("rejects workflow bypass: %s", (_name, mutate) => {
    const changed = mutate(workflow); expect(changed).not.toBe(workflow); expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
  it.each(["test-main-merge", "test-history", "test-core", "test"])("rejects a %s aggregate that can skip cancelled dependencies", name => {
    const index = workflow.indexOf("\n  " + name + ":\n"); expect(index).toBeGreaterThan(0);
    const changed = workflow.slice(0, index) + workflow.slice(index).replace(/if: (?:\$\{\{\s*)?always\(\)(?:\s*\}\})?/, "if: success()");
    expect(changed).not.toBe(workflow); expect(() => assertWorkflow(changed, nodeVersion)).toThrow();
  });
});
