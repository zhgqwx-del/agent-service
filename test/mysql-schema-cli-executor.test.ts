import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMysqlSchemaCliExecutor, MysqlSchemaCliExecutorError,
  type MysqlSchemaCliExecutorDependencies } from "./fixtures/mysql-schema-cli.mjs";
import type { MysqlFixtureSchemaOperation } from "./fixtures/mysql-runtime.mjs";

const CANARY = "schema-executor-private-canary";
const URL = `mysql://operator:${CANARY}@127.0.0.1/agent_service_test_cli`;
const ACK = "all-application-writers-stopped-v1" as const;
const metadata = { metadataSchema: "fixture_metadata", trustedDefiner: { user: "fixture_definer", host: "127.0.0.1" } };

class Clock {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  set = (callback: () => void, milliseconds: number) => {
    const id = ++this.next; this.tasks.set(id, { at: this.now + milliseconds, callback }); return id;
  };
  clear = (value: unknown) => { if (typeof value === "number") this.tasks.delete(value); };
  advance(milliseconds: number) {
    const until = this.now + milliseconds;
    for (;;) {
      const due = [...this.tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]); this.now = due[1].at; due[1].callback();
    }
    this.now = until;
  }
}
class Child extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) { this.emit("close", code, signal); }
  success(command: string) { this.stdout.write(JSON.stringify({ status: "ok", command }) + "\n"); this.close(); }
}
function operation(command: MysqlFixtureSchemaOperation["operation"] = "migrate", signal = new AbortController().signal): MysqlFixtureSchemaOperation {
  return { operation: command, url: URL, operationAbortSignal: signal,
    ...(command === "verify" ? {} : { fleetStoppedAck: ACK }),
    ...(command === "install-metadata" ? { schemaMetadata: metadata } : {}) };
}
function fixture(mode: "source" | "dist" = "source") {
  const clock = new Clock(), children: Child[] = [];
  const spawns: { file: string; args: readonly string[]; options: Parameters<MysqlSchemaCliExecutorDependencies["spawn"]>[2] }[] = [];
  let symlink = false, missing = false, alias = false, spawnFailure = false;
  const environment: Record<string, string | undefined> = { PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp",
    MYSQL_URL: CANARY, SCHEMA_MYSQL_URL: CANARY, SCHEMA_METADATA_SCHEMA: CANARY, SCHEMA_FLEET_STOPPED_ACK: CANARY,
    SECRETS_MASTER_KEY: CANARY, AWS_SECRET_ACCESS_KEY: CANARY, NODE_OPTIONS: CANARY, NODE_ENV: "production", AGENT_SERVICE_MIGRATIONS_DIR: CANARY };
  const dependencies: MysqlSchemaCliExecutorDependencies = {
    execPath: "/synthetic/node", environment,
    lstat: path => {
      if (missing) throw new Error(CANARY);
      return { isFile: () => path !== "/synthetic/work", isDirectory: () => path === "/synthetic/work", isSymbolicLink: () => symlink };
    },
    realpath: path => alias ? "/synthetic/alias" : path,
    spawn: (file, args, options) => {
      if (spawnFailure) throw new Error(CANARY);
      const child = new Child(); children.push(child); spawns.push({ file, args, options }); return child;
    },
    setTimer: clock.set, clearTimer: clock.clear,
  };
  const options = { entrypoint: `/synthetic/work/main.${mode === "source" ? "ts" : "js"}`, mode, cwd: "/synthetic/work" };
  return { clock, children, spawns, dependencies, options, environment,
    executor: () => createMysqlSchemaCliExecutor(options, dependencies),
    missing: () => { missing = true; }, symlink: () => { symlink = true; }, alias: () => { alias = true; },
    spawnFailure: () => { spawnFailure = true; } };
}
function observed(promise: Promise<void>) {
  const state = { settled: false };
  void promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}
const flush = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); };
async function fixedFailure(promise: Promise<void>) {
  try { await promise; throw new Error("Synthetic executor unexpectedly accepted failure."); }
  catch (error) {
    expect(error).toBeInstanceOf(MysqlSchemaCliExecutorError);
    expect((error as Error).message).toBe("MySQL schema CLI execution failed.");
    expect(String(error)).not.toContain(CANARY);
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  }
}

describe("schema CLI adapter synthetic dependency ordering (not native process/MySQL evidence)", () => {
  it("uses explicit source arguments and a closed OS/schema environment without ambient authority", async () => {
    const f = fixture(), run = f.executor(), promise = run(operation());
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]?.file).toBe("/synthetic/node");
    expect(f.spawns[0]?.args).toEqual(["--import", "tsx", "/synthetic/work/main.ts", "schema", "migrate"]);
    expect(f.spawns[0]?.options).toEqual({ cwd: "/synthetic/work", shell: false, stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: "/synthetic/bin", HOME: "/synthetic/home", TMPDIR: "/synthetic/tmp",
      SCHEMA_MYSQL_URL: URL, SCHEMA_OPERATION_TIMEOUT_MS: "120000", SCHEMA_FLEET_STOPPED_ACK: ACK,
    } });
    expect(JSON.stringify(f.spawns[0]?.args)).not.toContain(CANARY);
    f.children[0]?.success("migrate"); await promise; expect(f.clock.tasks.size).toBe(0);
  });
  it("runs dist with plain Node and never falls back to source after native failure", async () => {
    const f = fixture("dist"), promise = f.executor()(operation());
    expect(f.spawns[0]?.args).toEqual(["/synthetic/work/main.js", "schema", "migrate"]);
    f.children[0]?.close(1); await fixedFailure(promise); expect(f.spawns).toHaveLength(1);
  });
  it.each(["migrate", "verify"] as const)("never forwards metadata authority for %s", async command => {
    const f = fixture(), promise = f.executor()(operation(command)), env = f.spawns[0]?.options.env;
    expect(Object.keys(env ?? {}).some(key => key.startsWith("SCHEMA_METADATA_"))).toBe(false);
    expect(Object.hasOwn(env ?? {}, "SCHEMA_FLEET_STOPPED_ACK")).toBe(command === "migrate");
    f.children[0]?.success(command); await promise;
  });
  it("forwards only the exact installer metadata fields", async () => {
    const f = fixture(), promise = f.executor()(operation("install-metadata"));
    expect(f.spawns[0]?.options.env).toMatchObject({ SCHEMA_METADATA_SCHEMA: "fixture_metadata",
      SCHEMA_METADATA_DEFINER_USER: "fixture_definer", SCHEMA_METADATA_DEFINER_HOST: "127.0.0.1" });
    expect(Object.keys(f.spawns[0]?.options.env ?? {}).filter(key => key.startsWith("SCHEMA_METADATA_")).sort()).toEqual([
      "SCHEMA_METADATA_DEFINER_HOST", "SCHEMA_METADATA_DEFINER_USER", "SCHEMA_METADATA_SCHEMA",
    ]);
    f.children[0]?.success("install-metadata"); await promise;
  });
  it.each(["missing", "symlink", "alias"] as const)("rejects synthetic %s file evidence before spawn", field => {
    const f = fixture(); f[field](); expect(() => f.executor()).toThrow(MysqlSchemaCliExecutorError); expect(f.spawns).toHaveLength(0);
  });
  it("rechecks file evidence for each invocation", async () => {
    const f = fixture(), run = f.executor(); f.symlink(); await fixedFailure(run(operation())); expect(f.spawns).toHaveLength(0);
  });
  it.each([
    { entrypoint: "relative.ts", mode: "source", cwd: "/synthetic/work" },
    { entrypoint: "/synthetic/work/main.ts", mode: "source", cwd: "relative" },
    { entrypoint: "/synthetic/work/main.ts", mode: "unknown", cwd: "/synthetic/work" },
    { entrypoint: "/synthetic/work/main.ts", mode: "source", cwd: "/synthetic/work", fallback: true },
  ])("rejects non-closed factory configuration", input => {
    const f = fixture(); expect(() => createMysqlSchemaCliExecutor(input as typeof f.options, f.dependencies)).toThrow(MysqlSchemaCliExecutorError);
    expect(f.spawns).toHaveLength(0);
  });
  it.each([
    () => ({ ...operation(), operation: "status" }),
    () => ({ ...operation(), url: "mysql://operator@127.0.0.1/db?multipleStatements=true" }),
    () => ({ ...operation(), url: "mysql://operator@127.0.0.1/db%5Cother" }),
    () => ({ ...operation(), url: `mysql://operator@127.0.0.1/${"x".repeat(65)}` }),
    () => ({ ...operation(), fleetStoppedAck: "1" }),
    () => ({ ...operation("verify"), fleetStoppedAck: ACK }),
    () => ({ ...operation(), schemaMetadata: metadata }),
    () => ({ ...operation("verify"), schemaMetadata: metadata }),
    () => ({ ...operation("install-metadata"), schemaMetadata: { ...metadata, sql: CANARY } }),
    () => ({ ...operation("install-metadata"), schemaMetadata: { ...metadata, trustedDefiner: { user: "x@evil", host: "127.0.0.1" } } }),
    () => ({ ...operation(), operationAbortSignal: {} }),
    () => ({ ...operation(), argv: [CANARY] }),
  ])("rejects synthetic invalid operation authority before spawn", async input => {
    const f = fixture(); await fixedFailure(f.executor()(input() as MysqlFixtureSchemaOperation)); expect(f.spawns).toHaveLength(0);
  });
  it("does not invoke an operation accessor or unrelated ambient getters", async () => {
    const f = fixture(); let reads = 0;
    Object.defineProperty(f.environment, "SECRETS_MASTER_KEY", { enumerable: true, get() { reads++; throw new Error(CANARY); } });
    const run = f.executor(), input = { ...operation() };
    Object.defineProperty(input, "url", { enumerable: true, get() { reads++; throw new Error(CANARY); } });
    await fixedFailure(run(input)); expect(reads).toBe(0); expect(f.spawns).toHaveLength(0);
  });
  it("never spawns for a pre-aborted signal", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await fixedFailure(f.executor()(operation("migrate", abort.signal))); expect(f.spawns).toHaveLength(0); expect(f.clock.tasks.size).toBe(0);
  });
  it("sends TERM then owned KILL after five seconds, but cannot settle before synthetic native close", async () => {
    const f = fixture(), abort = new AbortController(), promise = f.executor()(operation("migrate", abort.signal)), state = observed(promise);
    const child = f.children[0]; if (!child) throw new Error("Synthetic child missing.");
    abort.abort(); expect(child.signals).toEqual(["SIGTERM"]); f.clock.advance(4_999); await flush(); expect(state.settled).toBe(false);
    expect(child.signals).toEqual(["SIGTERM"]); f.clock.advance(1); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await flush(); expect(state.settled).toBe(false); child.close(null, "SIGKILL"); await fixedFailure(promise); expect(f.clock.tasks.size).toBe(0);
  });
  it("starts cancellation by 120 seconds without accepting deadline success", async () => {
    const f = fixture(), promise = f.executor()(operation()), state = observed(promise), child = f.children[0];
    if (!child) throw new Error("Synthetic child missing.");
    f.clock.advance(119_999); expect(child.signals).toEqual([]); f.clock.advance(1); expect(child.signals).toEqual(["SIGTERM"]);
    child.stdout.write('{"status":"ok","command":"migrate"}\n'); await flush(); expect(state.settled).toBe(false);
    child.close(0); await fixedFailure(promise);
  });
  it("does not confuse exit with close or signal a child already known to have exited", async () => {
    const f = fixture(), abort = new AbortController(), promise = f.executor()(operation("migrate", abort.signal)), state = observed(promise);
    const child = f.children[0]; if (!child) throw new Error("Synthetic child missing.");
    child.emit("exit", 0, null); abort.abort(); f.clock.advance(5_000); await flush();
    expect(child.signals).toEqual([]); expect(state.settled).toBe(false); child.success("migrate"); await fixedFailure(promise);
  });
  it("waits for close after a synthetic child error without disclosing the error", async () => {
    const f = fixture(), promise = f.executor()(operation()), state = observed(promise), child = f.children[0];
    if (!child) throw new Error("Synthetic child missing.");
    child.emit("error", new Error(CANARY)); await flush(); expect(state.settled).toBe(false);
    child.close(1); await fixedFailure(promise);
  });
  it("maps a synchronous spawn error to a fixed failure", async () => {
    const f = fixture(); f.spawnFailure(); await fixedFailure(f.executor()(operation())); expect(f.clock.tasks.size).toBe(0);
  });
  it.each([
    { stdout: '{"status":"ok","command":"migrate"}\n', stderr: "", code: 1, signal: null },
    { stdout: '{"status":"ok","command":"migrate"}\n', stderr: "", code: null, signal: "SIGTERM" },
    { stdout: '{"status":"ok","command":"verify"}\n', stderr: "", code: 0, signal: null },
    { stdout: '{"status":"ok","command":"migrate"}', stderr: "", code: 0, signal: null },
    { stdout: '{"status":"ok","command":"migrate"}\r\n', stderr: "", code: 0, signal: null },
    { stdout: '{"status":"ok","command":"migrate"}\n\n', stderr: "", code: 0, signal: null },
    { stdout: '{"status":"ok","command":"migrate","extra":true}\n', stderr: "", code: 0, signal: null },
    { stdout: '{"status":"ok","command":"migrate"}\n', stderr: CANARY, code: 0, signal: null },
  ])("never lets success text override strict output/native outcome", async result => {
    const f = fixture(), promise = f.executor()(operation()), child = f.children[0];
    if (!child) throw new Error("Synthetic child missing.");
    child.stdout.write(result.stdout); child.stderr.write(result.stderr); child.close(result.code, result.signal as NodeJS.Signals | null);
    await fixedFailure(promise);
  });
  it("bounds combined stdout/stderr and still joins the close after overflow", async () => {
    const f = fixture(), promise = f.executor()(operation()), state = observed(promise), child = f.children[0];
    if (!child) throw new Error("Synthetic child missing.");
    child.stdout.write(Buffer.alloc(32_768)); child.stderr.write(Buffer.alloc(32_769));
    expect(child.signals).toEqual(["SIGTERM"]); await flush(); expect(state.settled).toBe(false);
    child.close(1); await fixedFailure(promise);
  });
  it("isolates concurrent synthetic children so one abort does not cancel another invocation", async () => {
    const f = fixture(), run = f.executor(), abort = new AbortController();
    const first = run(operation("migrate", abort.signal)), second = run(operation("verify")); observed(first);
    abort.abort(); expect(f.children[0]?.signals).toEqual(["SIGTERM"]); expect(f.children[1]?.signals).toEqual([]);
    f.children[1]?.success("verify"); await second; f.children[0]?.close(null, "SIGTERM"); await fixedFailure(first);
    expect(f.clock.tasks.size).toBe(0);
  });
});
