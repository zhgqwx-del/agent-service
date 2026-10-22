import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Env = Record<string, string>;
type RunOptions = { runnerEnv: string; routerEnv: string; stateDir: string };
type Child = EventEmitter & { pid?: number; kill(signal: string): boolean };
type SpawnOptions = { env: Env; cwd: string; shell: false; detached: false; stdio: [string, number, number] };
type Dependencies = { signal?: AbortSignal; spawn?: (file: string, args: string[], options: SpawnOptions) => Child;
  validateProductConfigs?: (runner: Env, router: Env) => Promise<void> };
let module: {
  parseExternalInfraArgs(argv: string[]): RunOptions | { help: true };
  parseRoleJson(value: string): Env;
  validateExternalInfraEnvs(runner: unknown, router: unknown, state: string): { runner: Env; router: Env };
  runExternalInfra(options: RunOptions, deps?: Dependencies): Promise<void>;
};
beforeAll(async () => {
  module = await import(new URL("../scripts/ops/external-infra.mjs", import.meta.url).href) as typeof module;
});

function roles(stateDir: string) {
  const shared = { NODE_ENV: "test", REDIS_URL: "redis://127.0.0.1:62001/4", REDIS_PREFIX: "fixture_external",
    REDIS_NAMESPACE_ID: "fixture-external-isolated", INTERNAL_ROUTER_TOKEN: "fixture-internal-" + "x".repeat(32),
    BLOB_STORE: "filesystem", BLOB_NAMESPACE_ID: "fixture-external-blobs", BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
    BLOB_STORAGE_CONTROL_ENABLED: "0", BLOB_ATTACHMENTS_ENABLED: "0" };
  return {
    runner: { ...shared, STORE: "mysql", MYSQL_URL: "mysql://fixture_runtime:fixture-only@127.0.0.1:62000/fixture_test",
      MYSQL_SCHEMA_METADATA_SCHEMA: "fixture_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "fixture_definer",
      MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost", RUNNER_HOST: "127.0.0.1", RUNNER_PORT: "62002",
      RUNNER_ID: "fixture-external-runner", RUNNER_ADDR: "127.0.0.1:62002", SECRETS_MASTER_KEY: "66".repeat(32),
      BLOB_DIR: join(dirname(stateDir), "stable-blobs"), BLOB_CLEANUP_ENABLED: "0" } as Env,
    router: { ...shared, ROUTER_HOST: "127.0.0.1", ROUTER_PORT: "62003", RUNNERS: "http://127.0.0.1:62002" } as Env,
  };
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-external-infra-")));
  await chmod(directory, 0o700);
  const options = { runnerEnv: join(directory, "runner.json"), routerEnv: join(directory, "router.json"), stateDir: join(directory, "state") };
  const env = roles(options.stateDir);
  await mkdir(env.runner.BLOB_DIR!, { mode: 0o700 });
  await writeFile(options.runnerEnv, JSON.stringify(env.runner), { mode: 0o600 });
  await writeFile(options.routerEnv, JSON.stringify(env.router), { mode: 0o600 });
  return { directory, options, ...env, async close() { await rm(directory, { recursive: true, force: true }); } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) { if (predicate()) return; await new Promise<void>(done => setTimeout(done, 1)); }
  throw new Error("controlled startup boundary was not reached");
}
function driver(autoClose = true) {
  const calls: { file: string; args: string[]; options: SpawnOptions; child: Child; signals: string[] }[] = [];
  const spawn = vi.fn((file: string, args: string[], options: SpawnOptions): Child => {
    const child = new EventEmitter() as Child, signals: string[] = [];
    child.pid = 50_000 + calls.length;
    child.kill = signal => { signals.push(signal); if (autoClose) queueMicrotask(() => child.emit("close", 0, null)); return true; };
    calls.push({ file, args, options, child, signals }); return child;
  });
  return { calls, spawn };
}
const accepted = async () => {};
const invalid = { code: "external_infra_invalid", message: "external_infra_invalid" };

describe("explicit external-infra local foreground supervisor", () => {
  it("accepts only help or the exact run shape, with no other command or duplicate authority", () => {
    expect(module.parseExternalInfraArgs(["--help"])).toEqual({ help: true });
    const args = ["run", "--runner-env", "/private/runner.json", "--router-env", "/private/router.json", "--state-dir", "/private/state"];
    expect(module.parseExternalInfraArgs(args)).toEqual({ runnerEnv: args[2], routerEnv: args[4], stateDir: args[6] });
    for (const command of ["start", "stop", "status", "logs", "down", "restart", "schema", "verify", "verify-s3"])
      expect(() => module.parseExternalInfraArgs([command])).toThrow("external_infra_invalid");
    for (const values of [[], [...args, "extra"], [...args.slice(0, 3), "--runner-env", ...args.slice(4)],
      [...args.slice(0, 1), "toString", ...args.slice(2)], args.map(x => x === "/private/runner.json" ? "relative.json" : x)])
      expect(() => module.parseExternalInfraArgs(values)).toThrow("external_infra_invalid");
  });

  it.each(['{"X":"a","X":"b"}', '{"X":1}', '{"X":null}', '{"X":{}}', '[]', '{"X":"a",}', '{} trailing'])
    ("rejects non-closed string-map JSON %s", value => { expect(() => module.parseRoleJson(value)).toThrow("external_infra_invalid"); });

  it("copies and freezes exact role maps without borrowing ambient or inherited authority", () => {
    const { runner, router } = roles("/private/state"), before = { ...runner };
    const result = module.validateExternalInfraEnvs(runner, router, "/private/state");
    expect(result.runner).toEqual(runner); expect(Object.isFrozen(result.runner)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    runner.RUNNER_ID = "changed"; expect(result.runner.RUNNER_ID).toBe(before.RUNNER_ID);
    const getter = vi.fn(() => "secret");
    Object.defineProperty(runner, "NODE_OPTIONS", { get: getter, enumerable: true });
    expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
    expect(getter).not.toHaveBeenCalled();
    expect(() => module.validateExternalInfraEnvs(Object.create(before), router, "/private/state")).toThrow("external_infra_invalid");
  });

  it.each(["NODE_OPTIONS", "NODE_PATH", "PATH", "HOME", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "SCHEMA_MYSQL_URL",
    "SCHEMA_FLEET_STOPPED_ACK", "AGENT_SERVICE_MIGRATIONS_DIR", "BOOTSTRAP_API_KEY", "BOOTSTRAP_TENANT_ID",
    "ADMIN_BOOTSTRAP_TENANT", "ADMIN_BOOTSTRAP_OUTPUT_FILE", "MCP_REGISTRY_OPERATOR_TOKEN", "FUTURE_AUTHORITY"])
    ("rejects runner-carried %s even empty instead of silently scrubbing explicit role mistakes", key => {
      const { runner, router } = roles("/private/state"); runner[key] = "";
      expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
    });

  it.each(["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "API_KEY", "API_BASE_URL", "SECRETS_MASTER_KEY", "BLOB_DIR", "HOOKS_ENABLED", "SSE_MAX_CONNECTIONS", "SSE_WRITE_STALL_MS"])
    ("never gives the router runner-only %s authority", key => {
      const { runner, router } = roles("/private/state"); router[key] = "fixture-sensitive-value";
      expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
    });

  it("passes only explicitly configured SSE budgets to the runner and preserves closed role maps", () => {
    const { runner, router } = roles("/private/state");
    const limits = { SSE_HEARTBEAT_MS: "5000", SSE_MAX_QUEUED_EVENTS: "32", SSE_MAX_QUEUED_BYTES: "8192",
      SSE_MAX_FRAME_BYTES: "4096", SSE_MAX_REPLAY_EVENTS: "256", SSE_MAX_REPLAY_BYTES: "32768",
      SSE_REPLAY_TIMEOUT_MS: "10000", SSE_WRITE_STALL_MS: "15000", SSE_MAX_CONNECTIONS: "16",
      SSE_MAX_CONNECTIONS_PER_TENANT: "4" };
    Object.assign(runner, limits);
    const accepted = module.validateExternalInfraEnvs(runner, router, "/private/state");
    expect(accepted.runner).toMatchObject(limits);
    for (const key of Object.keys(limits)) expect(accepted.router).not.toHaveProperty(key);
    runner.SSE_UNKNOWN_BOUND = "1";
    expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
  });

  it.each(["RUNNER_PORT", "REDIS_URL", "REDIS_PREFIX", "REDIS_NAMESPACE_ID", "MYSQL_SCHEMA_METADATA_SCHEMA"])
    ("requires explicit runner %s rather than shared defaults", key => {
      const { runner, router } = roles("/private/state"); delete runner[key];
      expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
    });

  it.each(["MYSQL_URL", "REDIS_URL"] as const)("rejects explicit port zero for %s rather than using default infrastructure", key => {
    const { runner, router } = roles("/private/state");
    runner[key] = key === "MYSQL_URL" ? "mysql://fixture@127.0.0.1:0/fixture_test" : "redis://127.0.0.1:0/4";
    if (key === "REDIS_URL") router[key] = runner[key]!;
    expect(() => module.validateExternalInfraEnvs(runner, router, "/private/state")).toThrow("external_infra_invalid");
  });

  it("rejects topology, namespace, local-storage and optional activation mismatches", () => {
    for (const [role, key, value] of [["router", "REDIS_NAMESPACE_ID", "different"], ["router", "REDIS_URL", "redis://127.0.0.1:62009/4"],
      ["router", "ROUTER_PORT", "62002"], ["router", "RUNNERS", "http://127.0.0.1:8787"], ["runner", "RUNNER_ADDR", "0.0.0.0:62002"],
      ["runner", "MYSQL_URL", "mysql://fixture@127.0.0.1/fixture_test"], ["runner", "BLOB_DIR", "relative"],
      ["runner", "MCP_REGISTRY_ENABLED", "1"]] as const) {
      const env = roles("/private/state"); env[role][key] = value;
      expect(() => module.validateExternalInfraEnvs(env.runner, env.router, "/private/state")).toThrow("external_infra_invalid");
    }
  });

  it("uses real product parsers, closed child environments and new private state, then waits for native close rather than exit", async context => {
    const f = await fixture(), d = driver(false), controller = new AbortController();
    let pending: Promise<void> | undefined;
    let reachedSecondSpawn!: () => void, startupFailed!: (error: unknown) => void;
    const secondSpawn = new Promise<void>((resolve, reject) => { reachedSecondSpawn = resolve; startupFailed = reject; });
    const cancel = () => { controller.abort(); startupFailed(context.signal.reason); };
    context.signal.addEventListener("abort", cancel, { once: true });
    const ambient = { NODE_OPTIONS: "fixture-preload", SCHEMA_MYSQL_URL: "fixture-operator", AWS_PROFILE: "fixture-profile", ADMIN_BOOTSTRAP_TENANT: "fixture-admin" };
    const old = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]])); Object.assign(process.env, ambient);
    try {
      context.signal.throwIfAborted();
      const spawn = (file: string, args: string[], options: SpawnOptions) => {
        const child = d.spawn(file, args, options); if (d.calls.length === 2) reachedSecondSpawn(); return child;
      };
      pending = module.runExternalInfra(f.options, { spawn, signal: controller.signal }); let settled = false;
      void pending.then(() => { settled = true; startupFailed(new Error("controlled supervisor settled before its second spawn")); },
        error => { settled = true; startupFailed(error); });
      await secondSpawn;
      for (const call of d.calls) {
        expect(call.file).toBe(process.execPath); expect(call.args).toEqual(["--import", "tsx", expect.stringMatching(/^apps\/agent-(runner|router)\/src\/main\.ts$/)]);
        expect(call.options).toMatchObject({ shell: false, detached: false });
        for (const key of Object.keys(ambient)) expect(call.options.env).not.toHaveProperty(key);
        expect(call.options.env.HOME).toBe(join(f.options.stateDir, "home")); expect(call.options.env.XDG_CONFIG_HOME).toBe(join(f.options.stateDir, "home/.config"));
      }
      expect(d.calls[1]!.options.env).not.toHaveProperty("MYSQL_URL");
      expect((await lstat(f.options.stateDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(f.options.stateDir, "runner.log"))).mode & 0o777).toBe(0o600);
      controller.abort(); expect(d.calls.map(call => call.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
      for (const call of d.calls) call.child.emit("exit", 0, null);
      await new Promise<void>(done => setImmediate(done)); expect(settled).toBe(false);
      for (const call of d.calls) call.child.emit("close", 0, null);
      await pending; expect(settled).toBe(true);
      expect(await readFile(f.options.runnerEnv, "utf8")).toBe(JSON.stringify(f.runner));
    } finally {
      context.signal.removeEventListener("abort", cancel);
      controller.abort();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      for (const call of d.calls) call.child.emit("close", 0, null);
      await pending?.catch(() => {});
      await f.close();
    }
  });

  it.each(["public_file", "public_parent", "symlink", "existing_state", "drift", "unsafe_blob", "symlink_blob"] as const)
    ("refuses %s before any child spawn and retains owned evidence", async fault => {
      const f = await fixture(), d = driver();
      try {
        if (fault === "public_file") await chmod(f.options.runnerEnv, 0o644);
        if (fault === "public_parent") await chmod(f.directory, 0o755);
        if (fault === "symlink") { const target = join(f.directory, "other.json"); await copyFile(f.options.runnerEnv, target); await rm(f.options.runnerEnv); await symlink(target, f.options.runnerEnv); }
        if (fault === "existing_state") await mkdir(f.options.stateDir, { mode: 0o700 });
        if (fault === "unsafe_blob") await chmod(f.runner.BLOB_DIR!, 0o755);
        if (fault === "symlink_blob") {
          const target = join(f.directory, "other-blobs"); await mkdir(target, { mode: 0o700 });
          await rm(f.runner.BLOB_DIR!, { recursive: true }); await symlink(target, f.runner.BLOB_DIR!);
        }
        const validateProductConfigs = async () => { if (fault === "drift") await writeFile(f.options.runnerEnv, JSON.stringify(f.runner) + " "); };
        await expect(module.runExternalInfra(f.options, { spawn: d.spawn, validateProductConfigs })).rejects.toMatchObject(invalid);
        expect(d.calls).toHaveLength(0); expect(await lstat(f.directory)).toBeDefined();
      } finally { await f.close(); }
    });

  it("reuses one stable private Blob path across fresh state directories without migrating or deleting its data", async () => {
    const f = await fixture(), runs: { controller: AbortController; driver: ReturnType<typeof driver>; pending: Promise<void> }[] = [];
    const retained = join(f.runner.BLOB_DIR!, "fixture-retained-data");
    try {
      await writeFile(retained, "fixture-existing-blob-bytes", { mode: 0o600 });
      for (const stateDir of [f.options.stateDir, join(f.directory, "state-second")]) {
        const controller = new AbortController(), d = driver(false);
        const pending = module.runExternalInfra({ ...f.options, stateDir }, { signal: controller.signal, spawn: d.spawn, validateProductConfigs: accepted });
        runs.push({ controller, driver: d, pending }); void pending.catch(() => {});
        await until(() => d.calls.length === 2);
        expect(d.calls[0]!.options.env.BLOB_DIR).toBe(f.runner.BLOB_DIR);
        controller.abort(); for (const call of d.calls) call.child.emit("close", 0, null); await pending;
        expect(await readFile(retained, "utf8")).toBe("fixture-existing-blob-bytes");
        expect((await lstat(stateDir)).mode & 0o777).toBe(0o700);
      }
      expect(runs[0]!.driver.calls[0]!.options.env.HOME).not.toBe(runs[1]!.driver.calls[0]!.options.env.HOME);
    } finally {
      for (const run of runs) { run.controller.abort(); for (const call of run.driver.calls) call.child.emit("close", 0, null); }
      await Promise.allSettled(runs.map(run => run.pending)); await f.close();
    }
  });

  it("does not create state or spawn after cancellation during an awaited validation", async () => {
    const f = await fixture(), d = driver(), controller = new AbortController(), entered = deferred(), release = deferred();
    let pending: Promise<void> | undefined;
    try {
      pending = module.runExternalInfra(f.options, { spawn: d.spawn, signal: controller.signal,
        validateProductConfigs: async () => { entered.resolve(); await release.promise; } });
      const outcome = pending.catch(error => error); await entered.promise; controller.abort(); release.resolve();
      expect(await outcome).toMatchObject(invalid); expect(d.calls).toHaveLength(0);
      await expect(lstat(f.options.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { controller.abort(); release.resolve(); await pending?.catch(() => {}); await f.close(); }
  });

  it("cancels the just-spawned owned child before admitting the second role", async () => {
    const f = await fixture(), d = driver(false), controller = new AbortController();
    let pending: Promise<void> | undefined;
    try {
      const spawn = (file: string, args: string[], options: SpawnOptions) => {
        const child = d.spawn(file, args, options); controller.abort(); return child;
      };
      pending = module.runExternalInfra(f.options, { spawn, signal: controller.signal, validateProductConfigs: accepted });
      const outcome = pending.catch(error => error);
      await until(() => d.calls[0]?.signals.length === 1);
      expect(d.calls).toHaveLength(1); expect(d.calls[0]!.signals).toEqual(["SIGTERM"]);
      d.calls[0]!.child.emit("close", 0, null); expect(await outcome).toMatchObject(invalid);
    } finally { controller.abort(); for (const call of d.calls) call.child.emit("close", 0, null); await pending?.catch(() => {}); await f.close(); }
  });

  it("closes its first child on between-spawn drift, never spawning or signaling another process", async () => {
    const f = await fixture(), d = driver(false), controller = new AbortController();
    let pending: Promise<void> | undefined;
    try {
      const spawn = (file: string, args: string[], options: SpawnOptions) => {
        const child = d.spawn(file, args, options); writeFileSync(f.options.routerEnv, JSON.stringify(f.router) + " "); return child;
      };
      pending = module.runExternalInfra(f.options, { spawn, signal: controller.signal, validateProductConfigs: accepted }); let settled = false;
      const outcome = pending.catch(error => error); void outcome.then(() => { settled = true; });
      await until(() => d.calls[0]?.signals.length === 1); expect(d.calls).toHaveLength(1); expect(settled).toBe(false);
      d.calls[0]!.child.emit("close", 0, null); expect(await outcome).toMatchObject(invalid);
      expect(d.calls[0]!.signals).toEqual(["SIGTERM"]);
    } finally { controller.abort(); for (const call of d.calls) call.child.emit("close", 0, null); await pending?.catch(() => {}); await f.close(); }
  });

  it("owns spawn-error close without requiring exit and stops only the surviving child", async () => {
    const f = await fixture(), d = driver(false), controller = new AbortController();
    let pending: Promise<void> | undefined;
    try {
      const spawn = (file: string, args: string[], options: SpawnOptions) => {
        const child = d.spawn(file, args, options); if (d.calls.length === 2) child.pid = undefined; return child;
      };
      pending = module.runExternalInfra(f.options, { spawn, signal: controller.signal, validateProductConfigs: accepted }); let settled = false;
      const outcome = pending.catch(error => error); void outcome.then(() => { settled = true; });
      await until(() => d.calls.length === 2);
      d.calls[1]!.child.emit("error", new Error("fixture native error must not escape"));
      expect(settled).toBe(false); expect(d.calls[0]!.signals).toEqual(["SIGTERM"]);
      d.calls[1]!.child.emit("close", -1, null); d.calls[0]!.child.emit("close", 0, null);
      expect(await outcome).toMatchObject(invalid); expect(d.calls).toHaveLength(2);
    } finally { controller.abort(); for (const call of d.calls) call.child.emit("close", 0, null); await pending?.catch(() => {}); await f.close(); }
  });

  it("dispatches before a poison .env or infra, with ambient Node preloads removed before Node starts", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "agent-external-dispatch-")));
    try {
      await mkdir(join(directory, "scripts")); await mkdir(join(directory, "bin")); await mkdir(join(directory, "deploy/local"), { recursive: true });
      const wrapper = join(directory, "scripts/local-service.sh"), marker = join(directory, "dispatch-result");
      await copyFile(fileURLToPath(new URL("../scripts/local-service.sh", import.meta.url)), wrapper);
      await writeFile(join(directory, ".env"), "printf 'poison-dotenv' >&2; exit 91\n");
      await writeFile(join(directory, "deploy/local/infra.sh"), "#!/bin/bash\nexit 92\n", { mode: 0o755 });
      await writeFile(join(directory, "bin/node"), `#!/bin/bash\nset -eu\ntest "\${NODE_OPTIONS+x}" != x\ntest "\${NODE_PATH+x}" != x\ntest "\${SCHEMA_MYSQL_URL+x}" != x\ntest "$#" = 4 && test "$1" = --import && test "$2" = tsx && test "$3" = scripts/ops/external-infra.mjs && test "$4" = --help\nprintf 'dispatched' >'${marker}'\n`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", [wrapper, "--external-infra", "--help"], { cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { PATH: `${join(directory, "bin")}:/usr/bin:/bin`, NODE_OPTIONS: "fixture-preload", NODE_PATH: "fixture-path", SCHEMA_MYSQL_URL: "fixture-operator" } });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("dispatched"); expect(result.stdout).not.toContain("fixture"); expect(result.stderr).toBe("");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
