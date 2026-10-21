import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../packages/protocol/src/index.js";
import { projectRunnerLoadHttpErrorCode } from "../scripts/benchmark-runner.js";

// These tests exercise only real CLI boundaries; no ACK/configuration here can create resources.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts/benchmark-runner.ts");
const CANARY = "BENCHMARK_CREDENTIAL_CANARY_0001";
const FAILURE = "Runner load benchmark failed (operation_failed)\n";
const owned = new Set<string>();
afterEach(async () => {
  for (const directory of owned) { await rm(directory, { recursive: true, force: true }); owned.delete(directory); }
});
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), "agent-service-runner-load-cli-test-"));
  owned.add(directory); return directory;
}
async function reports() {
  try { return (await readdir(join(ROOT, ".local-run"))).filter((name) => name.startsWith("runner-load-")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function invoke(cwd: string, args: string[], explicit: Record<string, string> = {}, script = SCRIPT) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    // tsx is a trusted installed dev dependency; cwd stays in the repository for loader resolution.
    cwd: ROOT, env: { NODE_ENV: "test", PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TMPDIR: cwd, ...explicit }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
}
function rejected(result: ReturnType<typeof invoke>) {
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
  expect(result.stdout).toBe(""); expect(result.stderr).toBe(FAILURE);
  expect(result.stderr.includes(CANARY)).toBe(false);
}

describe("local runner benchmark resource-free CLI", () => {
  it("shows standalone help without ACK, database, Redis binary or application configuration", async () => {
    const directory = await temp(), before = await reports();
    const result = invoke(directory, ["--help"], { NODE_ENV: "production",
      MYSQL_URL: `mysql://${CANARY}@example.invalid/business`, API_KEY: CANARY });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
    expect(result.stderr).toBe(""); expect(result.stdout).toContain("Usage: benchmark-runner");
    expect(result.stdout).toContain("RUNNER_BENCH_LOCAL_ONLY_ACK=1");
    expect(result.stdout).toContain("Start-event latency is not model TTFT");
    expect(result.stdout).toContain("No deployment or production acceptance");
    expect(result.stdout).toContain("--provider-gateway");
    expect(result.stdout).toContain("Only platform I/O capacity is assessed");
    expect(result.stdout.includes(CANARY)).toBe(false);
    expect(await reports()).toEqual(before);
  });

  it.each([
    ["--mysql-url", `mysql://${CANARY}@127.0.0.1/mysql`],
    ["--api-key", CANARY], ["--redis-url", `redis://${CANARY}@127.0.0.1:6379`],
    ["--turns", "0"], ["--turns", "2001"], ["--concurrency", "1001"],
    ["--turns", "1", "--concurrency", "2"], ["--turns", "1", "--turns", ""],
    ["--help", "--turns", "1"], ["--vendor-worker"],
  ].map((args) => ({ args })))("rejects unknown/unsafe/private arguments without external resources $args", async ({ args }) => {
    const directory = await temp(), before = await reports();
    rejected(invoke(directory, args, { RUNNER_BENCH_LOCAL_ONLY_ACK: "1",
      RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@example.invalid/mysql`,
      RUNNER_BENCH_REDIS_BINARY: "/absent/redis-server" }));
    expect(await reports()).toEqual(before);
  });

  it("does not inherit ordinary application URLs, credentials or destructive gates as benchmark authority", async () => {
    const directory = await temp(), before = await reports();
    rejected(invoke(directory, ["--turns", "1"], { STORE: "mysql", MYSQL_URL: `mysql://${CANARY}@example.invalid/business`,
      REDIS_URL: `redis://${CANARY}@example.invalid/0`, API_KEY: CANARY,
      RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@127.0.0.1/mysql`,
      RUNNER_BENCH_REDIS_BINARY: "/absent/redis-server", TENANT_DATABASE_PURGE_ENABLED: "1" }));
    expect(await reports()).toEqual(before);
  });

  const invalidEnvironments: Record<string, string>[] = [
    { NODE_ENV: "production", RUNNER_BENCH_MYSQL_ADMIN_URL: "mysql://root@127.0.0.1/mysql" },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@example.invalid/mysql` },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@127.0.0.1/business` },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@127.0.0.1/mysql?socketPath=/untrusted` },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@127.0.0.1/mysql` },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `mysql://${CANARY}@127.0.0.1:0/mysql` },
    { RUNNER_BENCH_MYSQL_ADMIN_URL: `http://${CANARY}@127.0.0.1/mysql` },
    { RUNNER_BENCH_REDIS_BINARY: "relative/redis-server" },
  ];
  it.each(invalidEnvironments)("rejects reachable-shape environment violations before IO", async (invalid) => {
    const directory = await temp(), before = await reports();
    rejected(invoke(directory, ["--turns", "1"], { RUNNER_BENCH_LOCAL_ONLY_ACK: "1",
      RUNNER_BENCH_MYSQL_ADMIN_URL: "mysql://root@127.0.0.1:3307/mysql", RUNNER_BENCH_REDIS_BINARY: "/absent/redis-server", ...invalid }));
    expect(await reports()).toEqual(before);
  });

  it("imports silently without opening benchmark resources", async () => {
    const directory = await temp(), before = await reports();
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "await import(process.argv[1]);", pathToFileURL(SCRIPT).href], {
      cwd: ROOT, env: { NODE_ENV: "test", PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: directory },
      encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe(""); expect(result.stderr).toBe(""); expect(await reports()).toEqual(before);
  });

  it("honors a real current-file alias rather than silently skipping the CLI guard", async () => {
    const directory = await temp(), before = await reports();
    const alias = join(directory, "current benchmark # %.ts"); await symlink(SCRIPT, alias);
    const result = invoke(directory, ["--help"], {}, alias);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: benchmark-runner"); expect(await reports()).toEqual(before);
  });
});

describe("runner load content-free HTTP error projection", () => {
  it.each(ErrorCode.options)("allows only the protocol's fixed error code %s", (code) => {
    const projected = projectRunnerLoadHttpErrorCode({ error: { code, message: CANARY,
      details: { authorization: CANARY, url: `https://${CANARY}.invalid/` } }, body: CANARY });
    expect(projected).toBe(code); expect(JSON.stringify({ code: projected })).not.toContain(CANARY);
  });

  it.each([undefined, null, true, 42, CANARY, [], {}, { error: null }, { error: [] },
    { error: CANARY }, { code: "internal_error" }, { error: { code: CANARY } },
    { error: { code: "unknown" } }, { error: { code: ["internal_error"] } },
    { error: { code: null } }, { error: { code: { toString: () => "internal_error" } } },
  ].map((value) => ({ value })))("maps malformed/primitive/unrecognized error bodies to unknown %#", ({ value }) => {
    expect(projectRunnerLoadHttpErrorCode(value)).toBe("unknown");
  });

  it("does not invoke error/code/message/details accessors", () => {
    let calls = 0;
    const accessor = () => { calls += 1; throw new Error(CANARY); };
    expect(projectRunnerLoadHttpErrorCode(Object.defineProperty({}, "error", { get: accessor }))).toBe("unknown");
    expect(projectRunnerLoadHttpErrorCode({ error: Object.defineProperty({}, "code", { get: accessor }) })).toBe("unknown");
    const error = { code: "internal_error" };
    Object.defineProperties(error, { message: { get: accessor }, details: { get: accessor } });
    expect(projectRunnerLoadHttpErrorCode({ error })).toBe("internal_error"); expect(calls).toBe(0);
  });

  it("does not accept inherited error/code properties or expose proxy errors", () => {
    expect(projectRunnerLoadHttpErrorCode(Object.create({ error: { code: "internal_error" } }))).toBe("unknown");
    expect(projectRunnerLoadHttpErrorCode({ error: Object.create({ code: "internal_error" }) })).toBe("unknown");
    expect(projectRunnerLoadHttpErrorCode(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(CANARY); } }))).toBe("unknown");
  });
});
