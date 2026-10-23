import { constants } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CiImageRuntimeError, CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES, prepareCiImageRuntime, runCiImageRuntime,
  type CiImageRuntimeDependencies } from "./fixtures/ci-image-runtime.mjs";
import type { MysqlFixtureDatabaseWitness, MysqlFixtureSchemaOperation, MysqlFixtureAuthorityOperation, MysqlRuntimeFixture } from "./fixtures/mysql-runtime.mjs";

// Files, driver and sockets below are synthetic. No Docker process, database or real ACL is used.
const state = vi.hoisted(() => ({
  events: [] as string[], files: new Map<string, { flags: number; mode: number | undefined; contents: string }>(),
  uid: 0, mode: 0o700, symlink: false, alias: false, writeFailure: false, fileCloseFailure: false,
  uuid: "12345678-1234-1234-1234-123456789abc", queries: [] as string[],
  socketCloseHeld: false, sockets: [] as { destroyed: boolean; release(): void }[],
  connectHeld: false, finishConnect: undefined as undefined | (() => void),
  onConnect: undefined as undefined | (() => void), onSocketDestroy: undefined as undefined | (() => void), onEnd: undefined as undefined | (() => void),
  nativeError: undefined as undefined | (() => void),
}));
vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(async () => { state.events.push("directory:lstat"); return { isDirectory: () => true, isSymbolicLink: () => state.symlink, mode: state.mode, uid: state.uid }; }),
  readdir: vi.fn(async () => { state.events.push("directory:readdir"); return [...state.files.keys()]; }),
  realpath: vi.fn(async (path: string) => { state.events.push("directory:realpath"); return state.alias ? `/alias${path}` : path; }),
  open: vi.fn(async (path: string, flags: number, mode?: number) => {
    state.events.push(`open:${path}`);
    if (path === "/fixture") return { async sync() { state.events.push("directory:fsync"); }, async close() { state.events.push("directory:close"); } };
    if (state.files.has(path)) throw Object.assign(new Error("synthetic collision"), { code: "EEXIST" });
    const file = { flags, mode, contents: "" }; state.files.set(path, file);
    return {
      async stat() { return { isFile: () => true, mode: mode ?? 0, nlink: 1, uid: state.uid }; },
      async writeFile(contents: string) { if (state.writeFailure) throw Error("private-driver-canary"); file.contents = contents; state.events.push(`write:${path}`); },
      async sync() { state.events.push(`fsync:${path}`); },
      async close() { state.events.push(`close:${path}`); if (state.fileCloseFailure) throw Error("private-driver-canary"); },
    };
  }),
}));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, createConnection: vi.fn(() => {
    const socket = new EventEmitter() as InstanceType<typeof EventEmitter> & { destroyed: boolean; destroy(): void; release(): void };
    socket.destroyed = false;
    let released = false;
    socket.release = () => { if (!released) { released = true; socket.emit("close"); state.events.push("socket:closed"); } };
    socket.destroy = () => { socket.destroyed = true; state.events.push("socket:destroy"); state.onSocketDestroy?.(); if (!state.socketCloseHeld) queueMicrotask(socket.release); };
    state.sockets.push(socket); return socket;
  }) };
});
vi.mock("mysql2/promise", () => ({ default: {
  createConnection: vi.fn(async (options: { stream(options: unknown): unknown }) => {
    options.stream({ config: { host: "127.0.0.1", port: 3306 } }); state.events.push("native:connect"); state.onConnect?.();
    if (state.connectHeld) await new Promise<void>(resolve => { state.finishConnect = resolve; });
    return {
      on(event: string, listener: () => void) { if (event === "error") state.nativeError = listener; return this; },
      removeListener(event: string, listener: () => void) { if (event === "error" && state.nativeError === listener) state.nativeError = undefined; return this; },
      async query(input: { sql: string }) {
        state.queries.push(input.sql);
        if (input.sql.startsWith("SELECT @@server_uuid")) return [[{ server_uuid: state.uuid, current_database: "mysql" }], []];
        if (input.sql.startsWith("CREATE DATABASE `agent_service_test_image_")) return [{}, []];
        throw Error("private-driver-canary");
      },
      destroy() { state.events.push("native:destroy"); },
      async end() { state.events.push("native:end"); state.onEnd?.(); },
    };
  }),
} }));

const UUID = "12345678-1234-1234-1234-123456789abc", NONCE = "0123456789abcdef";
const APP = `agent_service_test_image_${NONCE}`, CANARY = "private-driver-canary";
const ENV = { GITHUB_ACTIONS: "true", CI_IMAGE_MYSQL_URL: "mysql://root@127.0.0.1:3306/agent_service_test_image_base",
  CI_IMAGE_MYSQL_SERVER_UUID: UUID, CI_IMAGE_RUNTIME_DIRECTORY: "/fixture" };
const runtimeEnv = { MYSQL_URL: `mysql://mrt_r_${NONCE}:${"b".repeat(64)}@127.0.0.1:3306/${APP}`,
  MYSQL_SCHEMA_METADATA_SCHEMA: `agent_service_test_runtime_meta_${NONCE}`, MYSQL_SCHEMA_METADATA_DEFINER_USER: `mrt_d_${NONCE}`,
  MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" };
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve };
}
class Clock {
  tasks = new Map<number, () => void>(); next = 0;
  set = (callback: () => void, milliseconds: number) => { expect(milliseconds).toBe(120_000); const id = ++this.next; this.tasks.set(id, callback); return id; };
  clear = (id: unknown) => { if (typeof id === "number") this.tasks.delete(id); };
  expire() { for (const callback of [...this.tasks.values()]) callback(); }
}
function fixture(nativeAdmin = false) {
  const order: string[] = [], operations: MysqlFixtureSchemaOperation[] = [], stdout: string[] = [], stderr: string[] = [];
  const clock = new Clock(), closeGate = deferred(), cliGate = deferred(), closeEntered = deferred(), cliEntered = deferred();
  let holdClose = false, holdCli = false, prepareFailure = false, failAfterCli: number | undefined;
  let preparationSignal: AbortSignal | undefined;
  let interrupt: (() => void) | undefined, removed = false;
  const witness = Object.freeze({}) as MysqlFixtureDatabaseWitness;
  // Only checks that the selected dist authority port reaches the real fixture
  // adapter. This synthetic prepare never claims activation or native SQL proof.
  const authorityExecutor = vi.fn(async (_operation: MysqlFixtureAuthorityOperation) => {});
  const resourceClose = vi.fn(async () => { throw Error("Prepared resources must survive the CI handoff."); });
  const handle: MysqlRuntimeFixture = { database: APP, serverUuid: UUID, runtimeEnv,
    runtimeStoreOptions: { url: runtimeEnv.MYSQL_URL, migrationMode: "verify", schemaMetadata: {
      metadataSchema: runtimeEnv.MYSQL_SCHEMA_METADATA_SCHEMA, trustedDefiner: { user: runtimeEnv.MYSQL_SCHEMA_METADATA_DEFINER_USER, host: "localhost" } } },
    assertReusable: async () => { order.push("reusable"); }, close: resourceClose };
  const deps: CiImageRuntimeDependencies = {
    ...CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES, nodeMajor: 24,
    openAdmin: nativeAdmin ? CI_IMAGE_RUNTIME_DEFAULT_DEPENDENCIES.openAdmin : async (url, signal) => {
      expect(url).toBe(ENV.CI_IMAGE_MYSQL_URL); expect(signal).toBeInstanceOf(AbortSignal); order.push("connect");
      return { serverUuid: async () => { order.push("uuid"); return state.uuid; },
        createDatabase: async name => { expect(name).toBe(APP); order.push("CREATE"); },
        close: async () => { order.push("close-enter"); closeEntered.resolve(); if (holdClose) await closeGate.promise; order.push("closed"); } };
    },
    witness: async input => { expect(input.applicationDatabase).toBe(APP); expect(new URL(input.operatorUrl).pathname).toBe(`/${APP}`);
      expect(input.operationAbortSignal).toBeInstanceOf(AbortSignal); preparationSignal = input.operationAbortSignal; order.push("witness"); return witness; },
    nonce: () => NONCE,
    createSchemaExecutor: input => {
      expect(input).toEqual({ entrypoint: "/app/dist/main.js", mode: "dist", cwd: "/app" }); order.push("actual-dist-executor");
      return async operation => { operations.push(operation); order.push(operation.operation); cliEntered.resolve();
        if (holdCli && operation.operation === "migrate") await cliGate.promise;
        if (operations.length === failAfterCli) throw Error(CANARY); };
    },
    createAuthorityExecutor: input => {
      expect(input).toEqual({ entrypoint: "/app/dist/main.js", mode: "dist", cwd: "/app" });
      order.push("actual-dist-authority-executor"); return authorityExecutor;
    },
    prepare: async (actual, { schemaExecutor, authorityExecutor: actualAuthorityExecutor }) => {
      expect(actual).toBe(witness); order.push("prepare");
      expect(actualAuthorityExecutor).toBe(authorityExecutor);
      if (prepareFailure) {
        console.warn(JSON.stringify({ schema: "mysql-runtime-fixture-retained-v1", applicationDatabase: APP, status: "retained_or_unknown" }));
        throw Error(CANARY);
      }
      for (const operation of ["migrate", "install-metadata", "verify"] as const) {
        if (!preparationSignal || preparationSignal.aborted) throw Error(CANARY);
        await schemaExecutor({ operation, url: `mysql://root@127.0.0.1:3306/${APP}`, operationAbortSignal: preparationSignal,
          ...(operation === "verify" ? {} : { fleetStoppedAck: "all-application-writers-stopped-v1" }) });
      }
      return handle;
    },
    setTimer: clock.set, clearTimer: clock.clear,
    installInterrupts: callback => { interrupt = callback; return () => { removed = true; }; },
    writeLine: line => { stdout.push(line); }, writeError: line => { stderr.push(line); },
  };
  return { deps, order, operations, stdout, stderr, clock, resourceClose, handle, closeGate, cliGate, closeEntered, cliEntered,
    holdClose: () => { holdClose = true; }, failPrepare: () => { prepareFailure = true; }, failCli: (at: number) => { failAfterCli = at; },
    holdCli: () => { holdCli = true; },
    interrupt: () => interrupt?.(), removed: () => removed };
}
async function flush() { for (let i = 0; i < 4; i++) await Promise.resolve(); }
function observe(promise: Promise<unknown>) { const status = { settled: false }; void promise.then(() => { status.settled = true; }, () => { status.settled = true; }); return status; }
beforeEach(() => {
  state.events.length = 0; state.files.clear(); state.queries.length = 0; state.sockets.length = 0;
  Object.assign(state, { uid: process.getuid?.() ?? 0, mode: 0o700, symlink: false, alias: false, writeFailure: false, fileCloseFailure: false,
    uuid: UUID, socketCloseHeld: false, connectHeld: false, finishConnect: undefined, onConnect: undefined, onSocketDestroy: undefined, onEnd: undefined, nativeError: undefined });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("CI image runtime orchestration (synthetic adapters, not Docker/MySQL evidence)", () => {
  it.each([
    { GITHUB_ACTIONS: "false" }, { CI_IMAGE_MYSQL_URL: "mysql://root@127.0.0.1:3306/business" },
    { CI_IMAGE_MYSQL_URL: `mysql://root:${CANARY}@127.0.0.1:3306/agent_service_test_image_base` },
    { CI_IMAGE_MYSQL_SERVER_UUID: "unknown" }, { CI_IMAGE_RUNTIME_DIRECTORY: "/other" },
    { MYSQL_URL: CANARY }, { MYSQL_HOST: CANARY }, { SCHEMA_MYSQL_URL: CANARY },
    { AGENT_SERVICE_MIGRATIONS_DIR: CANARY }, { NODE_OPTIONS: CANARY },
  ])("rejects invalid context before filesystem/native I/O %#", async patch => {
    const f = fixture(); expect(await runCiImageRuntime([], { ...ENV, ...patch }, f.deps)).toBe(1);
    expect(state.events).toEqual([]); expect(f.order).toEqual([]); expect(f.clock.tasks.size).toBe(0);
    expect(f.stdout).toEqual([]); expect(f.stderr).toEqual(['{"status":"error","code":"ci_image_runtime_failed"}']);
  });
  it("rejects arguments, wrong Node and getters without evaluating supplied secret values", async () => {
    const f = fixture(); expect(await runCiImageRuntime(["--url", CANARY], ENV, f.deps)).toBe(1);
    expect(await runCiImageRuntime([], ENV, { ...f.deps, nodeMajor: 22 })).toBe(1);
    const getter = vi.fn(() => CANARY), env = { ...ENV }; Object.defineProperty(env, "CI_IMAGE_MYSQL_URL", { get: getter });
    expect(await runCiImageRuntime([], env, f.deps)).toBe(1); expect(getter).not.toHaveBeenCalled(); expect(f.order).toEqual([]);
  });
  it.each(["symlink", "alias", "mode", "owner", "existing"])("rejects non-private output evidence %s before SQL", async kind => {
    if (kind === "symlink") state.symlink = true;
    if (kind === "alias") state.alias = true;
    if (kind === "mode") state.mode = 0o755;
    if (kind === "owner") state.uid++;
    if (kind === "existing") state.files.set("/fixture/runtime.env", { flags: 0, mode: 0o600, contents: CANARY });
    const f = fixture(); expect(await runCiImageRuntime([], ENV, f.deps)).toBe(1); expect(f.order).toEqual([]);
  });
  it("rejects the externally observed UUID mismatch before witness/CREATE and closes the admin", async () => {
    state.uuid = "87654321-4321-4321-4321-cba987654321";
    const f = fixture(); expect(await runCiImageRuntime([], ENV, f.deps)).toBe(1);
    expect(f.order).toEqual(["connect", "uuid", "close-enter", "closed"]); expect(state.files.size).toBe(0);
  });
  it("orders witness, CREATE, exact dist CLI and native close before create-only handoff", async () => {
    const f = fixture(), ready = await prepareCiImageRuntime([], ENV, f.deps);
    expect(f.order).toEqual(["connect", "uuid", "witness", "CREATE", "actual-dist-executor", "actual-dist-authority-executor", "prepare", "migrate", "install-metadata", "verify", "reusable", "close-enter", "closed"]);
    expect([...state.files.keys()]).toEqual(["/fixture/runtime.env", "/fixture/database.txt", "/fixture/ready.json"]);
    expect(state.files.get("/fixture/runtime.env")?.contents).toBe(Object.entries(runtimeEnv).map(([key, item]) => `${key}=${item}\n`).join(""));
    expect(state.files.get("/fixture/database.txt")?.contents).toBe(`${APP}\n`);
    expect(JSON.parse(state.files.get("/fixture/ready.json")?.contents ?? "null")).toEqual(ready);
    expect(ready.nativeConnectionsClosed).toBe(true); expect(ready.resourceCleanup).toBe("ephemeral-job-service-teardown-only");
    expect(ready.perResourceCleanupClaimed).toBe(false); expect(JSON.stringify(ready)).not.toContain("b".repeat(64));
    for (const [path, file] of state.files) {
      expect(file.mode).toBe(0o600); expect(file.flags).toBe(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW);
      expect(state.events.indexOf(`fsync:${path}`)).toBeGreaterThan(state.events.indexOf(`write:${path}`));
      expect(state.events.indexOf(`close:${path}`)).toBeGreaterThan(state.events.indexOf(`fsync:${path}`));
    }
    expect(state.events.slice(-2)).toEqual(["directory:fsync", "directory:close"]);
    expect(f.resourceClose).not.toHaveBeenCalled(); expect(f.clock.tasks.size).toBe(0); expect(f.removed()).toBe(true);
  });
  it("refuses an authority executor construction failure before preparation or credential handoff", async () => {
    const f = fixture();
    expect(await runCiImageRuntime([], ENV, { ...f.deps,
      createAuthorityExecutor: () => { throw Error(CANARY); } })).toBe(1);
    expect(f.order).toEqual(["connect", "uuid", "witness", "CREATE", "actual-dist-executor", "close-enter", "closed"]);
    expect(state.files.size).toBe(0); expect(f.resourceClose).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]); expect(f.stderr).toEqual(['{"status":"error","code":"ci_image_runtime_failed"}']);
    expect(f.clock.tasks.size).toBe(0); expect(f.removed()).toBe(true);
  });
  it("prints only the fixed success record, never runtime credentials or GITHUB_ENV", async () => {
    const f = fixture(); expect(await runCiImageRuntime([], { ...ENV, GITHUB_ENV: "/not-written" }, f.deps)).toBe(0);
    expect(f.stdout).toEqual(['{"status":"ok","command":"ci-image-runtime"}']); expect(f.stderr).toEqual([]);
    expect([...state.files.keys()].every(path => path.startsWith("/fixture/"))).toBe(true);
  });
  it("retains resources and accepts only the existing content-free retained diagnostic on preparation failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {}), f = fixture(); f.failPrepare();
    expect(await runCiImageRuntime([], ENV, f.deps)).toBe(1); expect(f.resourceClose).not.toHaveBeenCalled();
    expect(f.order).toContain("CREATE"); expect(f.order.at(-1)).toBe("closed"); expect(state.files.size).toBe(0);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({ schema: "mysql-runtime-fixture-retained-v1", applicationDatabase: APP, status: "retained_or_unknown" }));
    expect(f.stderr).toEqual(['{"status":"error","code":"ci_image_runtime_failed"}']); expect(JSON.stringify(f.stderr)).not.toContain(CANARY);
  });
  it("does not DROP or clean grants after failed CLI or a partial file write", async () => {
    const first = fixture(); first.failCli(2); expect(await runCiImageRuntime([], ENV, first.deps)).toBe(1);
    expect(first.operations.map(item => item.operation)).toEqual(["migrate", "install-metadata"]); expect(first.resourceClose).not.toHaveBeenCalled();
    const second = fixture(); state.writeFailure = true; expect(await runCiImageRuntime([], ENV, second.deps)).toBe(1);
    expect(state.files.has("/fixture/runtime.env")).toBe(true); expect(state.files.has("/fixture/ready.json")).toBe(false);
    expect(state.queries.some(sql => /^DROP\b/.test(sql))).toBe(false); expect(second.resourceClose).not.toHaveBeenCalled();
  });
  it("waits for close acknowledgment after cancellation instead of publishing ready early", async () => {
    const f = fixture(); f.holdClose(); const pending = runCiImageRuntime([], ENV, f.deps), seen = observe(pending);
    await f.closeEntered.promise; expect(f.order).toContain("close-enter"); expect(seen.settled).toBe(false); expect(state.files.size).toBe(0);
    f.clock.expire(); await flush(); expect(seen.settled).toBe(false); f.closeGate.resolve();
    expect(await pending).toBe(1); expect(state.files.size).toBe(0); expect(f.resourceClose).not.toHaveBeenCalled();
  });
  it("awaits the original CLI operation after interruption, without retry or early native close", async () => {
    const f = fixture(); f.holdCli(); const pending = runCiImageRuntime([], ENV, f.deps), seen = observe(pending);
    await f.cliEntered.promise; expect(f.operations.map(item => item.operation)).toEqual(["migrate"]);
    f.interrupt(); await flush(); expect(f.operations[0]?.operationAbortSignal.aborted).toBe(true);
    expect(seen.settled).toBe(false); expect(f.order).not.toContain("close-enter"); expect(state.files.size).toBe(0);
    f.cliGate.resolve(); expect(await pending).toBe(1); expect(f.order.at(-1)).toBe("closed");
    expect(f.operations.map(item => item.operation)).toEqual(["migrate"]); expect(state.files.size).toBe(0);
  });
  it("joins the owned synthetic native socket close after end(), not merely destroy()", async () => {
    const f = fixture(true), destroyed = deferred(); state.socketCloseHeld = true; state.onSocketDestroy = destroyed.resolve;
    const pending = runCiImageRuntime([], ENV, f.deps), seen = observe(pending);
    await destroyed.promise; expect(state.events).toContain("native:end"); expect(state.sockets[0]?.destroyed).toBe(true);
    expect(seen.settled).toBe(false); expect(state.files.size).toBe(0);
    state.sockets[0]?.release(); expect(await pending).toBe(0); expect(state.files.size).toBe(3);
  });
  it("awaits late handshake and native socket closure after the single 120s cancellation", async () => {
    const f = fixture(true), connected = deferred(), destroyed = deferred(), ended = deferred(); state.connectHeld = true; state.socketCloseHeld = true;
    state.onConnect = connected.resolve; state.onSocketDestroy = destroyed.resolve; state.onEnd = ended.resolve;
    const pending = runCiImageRuntime([], ENV, f.deps), seen = observe(pending); await connected.promise;
    f.clock.expire(); await destroyed.promise; expect(state.sockets[0]?.destroyed).toBe(true); expect(seen.settled).toBe(false);
    state.finishConnect?.(); await ended.promise; expect(seen.settled).toBe(false); state.sockets[0]?.release();
    expect(await pending).toBe(1); expect(state.queries).toEqual([]); expect(state.files.size).toBe(0);
  });
  it("handles an idle native connection error without raw output or a ready handoff", async () => {
    const f = fixture(true); f.holdCli(); const pending = runCiImageRuntime([], ENV, f.deps);
    await f.cliEntered.promise; expect(state.nativeError).toBeTypeOf("function"); state.nativeError?.();
    f.cliGate.resolve(); expect(await pending).toBe(1); expect(state.files.size).toBe(0);
    expect(f.stderr).toEqual(['{"status":"error","code":"ci_image_runtime_failed"}']); expect(state.nativeError).toBeUndefined();
  });
  it("exports fixed errors without native message or cause", async () => {
    const f = fixture(); f.failCli(1);
    await expect(prepareCiImageRuntime([], ENV, f.deps)).rejects.toMatchObject({ name: "CiImageRuntimeError", code: "ci_image_runtime_failed", message: "CI image runtime preparation failed." });
    try { await prepareCiImageRuntime([CANARY], ENV, f.deps); }
    catch (error) { expect(error).toBeInstanceOf(CiImageRuntimeError); expect(Object.hasOwn(error as object, "cause")).toBe(false); expect(String(error)).not.toContain(CANARY); }
  });
});
