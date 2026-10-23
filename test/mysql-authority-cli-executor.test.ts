import { EventEmitter } from "node:events";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMysqlFixtureAuthorityCommand, createMysqlAuthorityCliExecutor, MysqlAuthorityCliExecutorError,
  type MysqlAuthorityCliExecutorDependencies } from "./fixtures/mysql-authority-cli.mjs";
import type { MysqlFixtureAuthorityOperation } from "./fixtures/mysql-runtime.mjs";

const CANARY = "authority-executor-private-canary", URL = `mysql://operator:${CANARY}@127.0.0.1/agent_service_test_cli`;
const directories = new Set<string>(), tasks = new Set<Promise<void>>(), children = new Set<Child>();
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
class Clock {
  now = 0; next = 0; tasks = new Map<number, { at: number; callback(): void }>();
  set = (callback: () => void, ms: number) => { const id = ++this.next; this.tasks.set(id, { at: this.now + ms, callback }); return id; };
  clear = (id: unknown) => { if (typeof id === "number") this.tasks.delete(id); };
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.tasks].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
      this.tasks.delete(next[0]); this.now = next[1].at; next[1].callback();
    }
    this.now = until;
  }
}
class Child extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly signals: NodeJS.Signals[] = []; closed = false;
  kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) { if (!this.closed) { this.closed = true; this.emit("close", code, signal); } }
  success(digest: string) { this.stdout.write(JSON.stringify({ status: "ok", command: "activate", activated: true, commandSha256: digest }) + "\n"); this.close(); }
}
function operation(signal = new AbortController().signal): MysqlFixtureAuthorityOperation {
  return { operation: "activate", url: URL, operationAbortSignal: signal, fleetStoppedAck: "all-application-writers-stopped-v1",
    exclusiveChangeAck: "exclusive-authority-permissions-window-v1",
    schemaMetadata: { metadataSchema: "fixture_metadata", trustedDefiner: { user: "fixture_definer", host: "127.0.0.1" } },
    command: { bindingId: "11111111-1111-4111-8111-111111111111", activationId: "22222222-2222-4222-8222-222222222222",
      expectedBindingId: null, expectedSequence: 0, serverUuid: "33333333-3333-4333-8333-333333333333",
      applicationDatabase: "agent_service_test_cli", newAccounts: [{ user: "fixture_runtime", host: "127.0.0.1" }], oldAccountNames: [],
      activationEvidenceSha256: "a".repeat(64), expectedSource: { kind: "inactive", runtimeControlGeneration: 0,
        runtimeControlEvidenceSha256: null, runtimeEpochSha256: null, restoreRunId: null, replayReceiptSha256: null }, nextEpoch: null } };
}
function fixture(mode: "source" | "dist" = "source") {
  const clock = new Clock(), entered = deferred<void>();
  const spawns: { file: string; args: readonly string[]; options: Parameters<MysqlAuthorityCliExecutorDependencies["spawn"]>[2]; child: Child }[] = [];
  const environment = { PATH: "/synthetic/bin", HOME: "/synthetic/home", MYSQL_URL: CANARY, AUTHORITY_COMMAND_FILE: CANARY,
    AUTHORITY_MYSQL_URL: CANARY, NODE_OPTIONS: CANARY, AWS_SECRET_ACCESS_KEY: CANARY,
    TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: CANARY, TENANT_TELEMETRY_REF_KEY: CANARY };
  const dependencies: MysqlAuthorityCliExecutorDependencies = { execPath: "/synthetic/node", environment,
    lstat: path => ({ isFile: () => path !== "/synthetic/work", isDirectory: () => path === "/synthetic/work", isSymbolicLink: () => false }),
    realpath: path => path, setTimer: clock.set, clearTimer: clock.clear,
    spawn: (file, args, options) => {
      const child = new Child(); children.add(child); directories.add(dirname(options.env.AUTHORITY_COMMAND_FILE!));
      spawns.push({ file, args, options, child }); entered.resolve(); return child;
    } };
  const run = createMysqlAuthorityCliExecutor({ entrypoint: `/synthetic/work/main.${mode === "source" ? "ts" : "js"}`, mode, cwd: "/synthetic/work" }, dependencies);
  const start = (input = operation()) => {
    const task = run(input); tasks.add(task);
    void task.then(() => tasks.delete(task), (error: unknown) => {
      tasks.delete(task); if (error instanceof MysqlAuthorityCliExecutorError && error.evidenceDirectory) directories.add(error.evidenceDirectory);
    }); return task;
  };
  return { clock, entered: entered.promise, spawns, start, dependencies };
}
afterEach(async () => {
  for (const child of children) child.close(1);
  await Promise.allSettled([...tasks]);
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  children.clear(); directories.clear(); tasks.clear();
});

describe("authority CLI adapter (synthetic process ordering; no real activation evidence)", () => {
  it.each(["source", "dist"] as const)("uses only the selected %s entrypoint, private fixed command and closed environment", async mode => {
    const f = fixture(mode), input = operation(), pending = f.start(input); await f.entered;
    const record = f.spawns[0]!, path = record.options.env.AUTHORITY_COMMAND_FILE!;
    expect(record.args).toEqual([...(mode === "source" ? ["--import", "tsx"] : []), `/synthetic/work/main.${mode === "source" ? "ts" : "js"}`, "authority", "activate"]);
    expect(record.options.env).toEqual({ PATH: "/synthetic/bin", HOME: "/synthetic/home", AUTHORITY_MYSQL_URL: URL,
      AUTHORITY_FLEET_STOPPED_ACK: input.fleetStoppedAck, AUTHORITY_EXCLUSIVE_CHANGE_ACK: input.exclusiveChangeAck,
      AUTHORITY_OPERATION_TIMEOUT_MS: "120000", AUTHORITY_METADATA_SCHEMA: "fixture_metadata",
      AUTHORITY_METADATA_DEFINER_USER: "fixture_definer", AUTHORITY_METADATA_DEFINER_HOST: "127.0.0.1", AUTHORITY_COMMAND_FILE: path });
    expect(record.options.shell).toBe(false); expect(record.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(JSON.stringify(record.args)).not.toContain(CANARY);
    expect(await realpath(dirname(path))).toBe(dirname(path));
    expect((await lstat(dirname(path))).mode & 0o7777).toBe(0o700); const stat = await lstat(path);
    expect(stat.mode & 0o7777).toBe(0o600); expect(stat.nlink).toBe(1); expect(stat.uid).toBe(process.getuid?.());
    const bytes = await readFile(path, "utf8"); expect(JSON.parse(bytes)).toEqual(input.command); expect(bytes).not.toContain(CANARY);
    expect(captureMysqlFixtureAuthorityCommand(input.command).commandSha256).toBe("8b44c1c556c931adf3858b06bb4444a734cce2393951c8b7568ac3d3b2814d26");
    record.child.success(captureMysqlFixtureAuthorityCommand(input.command).commandSha256); await pending;
    expect(f.clock.tasks.size).toBe(0); expect(await readFile(path, "utf8")).toBe(bytes);
  });
  it("deep captures the original initial command before the first asynchronous file operation", async () => {
    const f = fixture(), input = operation(), original = JSON.stringify(input.command), pending = f.start(input);
    Object.assign(input.command.newAccounts[0]!, { user: "changed_runtime" });
    Object.assign(input.command.expectedSource, { kind: "changed" });
    await f.entered; const record = f.spawns[0]!;
    expect((await readFile(record.options.env.AUTHORITY_COMMAND_FILE!, "utf8")).trimEnd()).toBe(original);
    record.child.success("8b44c1c556c931adf3858b06bb4444a734cce2393951c8b7568ac3d3b2814d26"); await pending;
  });
  it("captures the command before asynchronous file work and never evaluates a caller getter or custom array method", async () => {
    const input = operation(), getter = vi.fn(() => input.command.bindingId);
    Object.defineProperty(input.command, "bindingId", { get: getter, enumerable: true });
    const f = fixture(); await expect(f.start(input)).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError);
    expect(getter).not.toHaveBeenCalled(); expect(f.spawns).toHaveLength(0);
    const sparse = operation(); Object.defineProperty(sparse.command.newAccounts, "map", { value: getter });
    await expect(f.start(sparse)).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError); expect(getter).not.toHaveBeenCalled();
  });
  it("refuses future epoch intent, noninitial commands, DB drift and missing ACK before process creation", async () => {
    const f = fixture();
    for (const changed of [
      { ...operation(), fleetStoppedAck: "yes" }, { ...operation(), exclusiveChangeAck: "yes" },
      { ...operation(), url: URL.replace("agent_service_test_cli", "another_test") },
      { ...operation(), command: { ...operation().command, nextEpoch: {} } },
      { ...operation(), command: { ...operation().command, expectedSequence: 1 } },
      { ...operation(), command: { ...operation().command, oldAccountNames: ["old"] } },
    ]) await expect(f.start(changed as MysqlFixtureAuthorityOperation)).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError);
    expect(f.spawns).toHaveLength(0);
  });
  it("rejects an aborted operation before private file creation or process startup", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.start(operation(controller.signal))).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError); expect(f.spawns).toHaveLength(0);
  });
  it("waits for actual native close after cancellation, TERM and the unchanged five second KILL grace", async () => {
    const f = fixture(), controller = new AbortController(); let settled = false;
    const pending = f.start(operation(controller.signal)); void pending.then(() => { settled = true; }, () => { settled = true; }); await f.entered;
    const child = f.spawns[0]!.child; controller.abort(); expect(child.signals).toEqual(["SIGTERM"]);
    f.clock.advance(4999); expect(child.signals).toEqual(["SIGTERM"]); f.clock.advance(1); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await Promise.resolve(); expect(settled).toBe(false); child.close(null, "SIGKILL");
    await expect(pending).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError); expect(f.clock.tasks.size).toBe(0);
  });
  it("uses 120 seconds and does not accept process exit as stdio/native close", async () => {
    const f = fixture(); let settled = false; const pending = f.start();
    void pending.then(() => { settled = true; }, () => { settled = true; }); await f.entered;
    const child = f.spawns[0]!.child; f.clock.advance(119999); expect(child.signals).toEqual([]);
    f.clock.advance(1); expect(child.signals).toEqual(["SIGTERM"]); child.emit("exit", 1, null); f.clock.advance(5000);
    expect(child.signals).toEqual(["SIGTERM"]); await Promise.resolve(); expect(settled).toBe(false);
    child.close(1); await expect(pending).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError);
  });
  it("rejects a wrong digest and preserves the exact command instead of retrying activation", async () => {
    const f = fixture(), pending = f.start(); await f.entered; const record = f.spawns[0]!, path = record.options.env.AUTHORITY_COMMAND_FILE!;
    const before = await readFile(path, "utf8"); record.child.success("f".repeat(64));
    const failure: unknown = await pending.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MysqlAuthorityCliExecutorError); expect(String(failure)).not.toContain(CANARY);
    expect(Object.hasOwn(failure as object, "cause")).toBe(false);
    expect((failure as MysqlAuthorityCliExecutorError).evidenceDirectory).toBe(dirname(path));
    expect(await readFile(path, "utf8")).toBe(before); expect(f.spawns).toHaveLength(1);
  });
  it("bounds combined output and joins native close after stream errors without exposing raw diagnostics", async () => {
    const f = fixture(), pending = f.start(); let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; }); await f.entered;
    const child = f.spawns[0]!.child; child.stderr.write(CANARY); child.stdout.write("x".repeat(65_536));
    child.stderr.emit("error", new Error(CANARY)); await Promise.resolve(); expect(settled).toBe(false); expect(child.signals).toEqual(["SIGTERM"]);
    child.close(1); const failure: unknown = await pending.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MysqlAuthorityCliExecutorError); expect(String(failure)).not.toContain(CANARY); expect(f.spawns).toHaveLength(1);
  });
  it("forwards only an explicitly selected protected keyfile without putting key authority in the command", async () => {
    const f = fixture(), input = { ...operation(), tenantTelemetryRefKeyFile: "/synthetic/private/ref-key.bin" };
    const pending = f.start(input); await f.entered;
    const record = f.spawns[0]!, command = await readFile(record.options.env.AUTHORITY_COMMAND_FILE!, "utf8");
    expect(record.options.env.TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE).toBe(input.tenantTelemetryRefKeyFile);
    expect(record.options.env.TENANT_TELEMETRY_REF_KEY).toBeUndefined();
    expect(JSON.parse(command)).toEqual(input.command);
    expect(command).not.toContain("ref-key.bin");
    expect(record.args).toEqual(["--import", "tsx", "/synthetic/work/main.ts", "authority", "activate"]);
    record.child.success(captureMysqlFixtureAuthorityCommand(input.command).commandSha256); await pending;
    expect(f.clock.tasks.size).toBe(0);
  });
  it("rejects invalid or accessor keyfile inputs before command files or native child creation", async () => {
    const f = fixture(), getter = vi.fn(() => "/synthetic/private/ref-key.bin");
    for (const tenantTelemetryRefKeyFile of [undefined, null, "", "relative/key", "/private/../key", "/" + "x".repeat(4096), "/private/\u0000key"]) {
      await expect(f.start({ ...operation(), tenantTelemetryRefKeyFile } as MysqlFixtureAuthorityOperation))
        .rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError);
    }
    const input = operation(); Object.defineProperty(input, "tenantTelemetryRefKeyFile", { get: getter, enumerable: true });
    await expect(f.start(input)).rejects.toBeInstanceOf(MysqlAuthorityCliExecutorError);
    expect(getter).not.toHaveBeenCalled(); expect(f.spawns).toHaveLength(0);
  });

});
