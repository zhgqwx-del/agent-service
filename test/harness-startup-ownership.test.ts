import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChildDouble = EventEmitter & { pid: number; env: Record<string, string>; stdout: EventEmitter; stderr: EventEmitter;
  kill: (signal?: string) => boolean; exitSeen: boolean; spawnFailed: boolean };
type SocketDouble = EventEmitter & { destroy: () => void };
type RedisDouble = EventEmitter & { status: string; quit: () => Promise<void>; disconnect: () => void };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const io = vi.hoisted(() => ({
  trace: [] as string[], children: [] as ChildDouble[], sockets: [] as SocketDouble[], redis: undefined as RedisDouble | undefined,
  gates: new Map<string, ReturnType<typeof deferred>>(), connectGate: undefined as ReturnType<typeof deferred> | undefined,
  holdChildClose: false, holdNativeClose: false, holdRedisEnd: false, spawnFailureFor: "", nextPort: 21000,
  routerReadyCount: undefined as number | undefined,
  preparationSignal: undefined as AbortSignal | undefined, mysqlClose: vi.fn(), reusable: vi.fn(), schema: vi.fn(),
}));
vi.mock("node:net", async importOriginal => {
  const actual = await importOriginal<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual,
    createServer: () => {
      const server = new EventEmitter(), port = ++io.nextPort;
      return Object.assign(server, { listen: (_port: number, _host: string, done: () => void) => queueMicrotask(done),
        address: () => ({ port }), close: (done: () => void) => queueMicrotask(done) });
    },
    createConnection: () => {
      const socket = new EventEmitter() as SocketDouble; let closed = false;
      socket.destroy = () => {
        io.trace.push("native:destroy");
        if (!closed && !io.holdNativeClose) { closed = true; queueMicrotask(() => socket.emit("close")); }
      };
      io.sockets.push(socket); return socket;
    },
  };
});
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return { spawn: (_executable: string, _args: string[], options: { env: Record<string, string> }) => {
    const name = options.env.RUNNER_ID ?? "router", child = new EventEmitter() as ChildDouble;
    Object.assign(child, { pid: 31000 + io.children.length, env: options.env, stdout: new EventEmitter(), stderr: new EventEmitter(),
      exitSeen: false, spawnFailed: name === io.spawnFailureFor });
    let closed = false;
    child.kill = () => {
      io.trace.push("kill:" + name);
      if (child.spawnFailed) return false;
      if (!child.exitSeen) { child.exitSeen = true; child.emit("exit", null); }
      if (!closed && !io.holdChildClose) { closed = true; queueMicrotask(() => { io.trace.push("close:" + name); child.emit("close"); }); }
      return true;
    };
    io.children.push(child); io.trace.push("spawn:" + name);
    if (child.spawnFailed) queueMicrotask(() => { child.emit("error", new Error("controlled spawn failure")); child.emit("close"); });
    return child;
  } };
});
vi.mock("mysql2/promise", () => ({ default: { createConnection: async (options: {
  stream: (input: { config: { host: string; port: number } }) => SocketDouble;
}) => {
  const socket = options.stream({ config: { host: "127.0.0.1", port: 1 } });
  io.trace.push("native:connect"); await io.connectGate?.promise;
  return { query: async () => { io.trace.push("native:query"); return [{}, []]; },
    end: async () => { io.trace.push("native:end"); }, destroy: () => socket.destroy() };
} } }));
vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  return { Redis: class extends EventEmitter {
    status = "ready";
    constructor() { super(); io.redis = this; }
    async flushdb() { io.trace.push("redis:flush"); }
    async quit() { io.trace.push("redis:quit"); this.finish(); }
    disconnect() { io.trace.push("redis:disconnect"); this.finish(); }
    private finish() { if (this.status !== "end" && !io.holdRedisEnd) {
      this.status = "end"; queueMicrotask(() => { io.trace.push("redis:end"); this.emit("end"); });
    } }
  } };
});
vi.mock("@agent-service/testkit", () => ({ FakeVendor: class {
  script() {}
  async start() { io.trace.push("vendor:start"); return "http://fixture-vendor.invalid"; }
  async stop() { io.trace.push("vendor:stop"); }
} }));
vi.mock("../packages/store/src/index.js", () => ({ MysqlSessionStore: { runSchemaOperation: io.schema } }));
vi.mock("./fixtures/mysql-runtime.mjs", () => ({
  witnessAbsentMysqlFixtureDatabase: async (input: { operationAbortSignal: AbortSignal }) => {
    io.preparationSignal = input.operationAbortSignal; io.trace.push("mysql:witness"); return Object.freeze({});
  },
  prepareMysqlRuntimeFixture: async () => ({ runtimeEnv: Object.freeze({ MYSQL_URL: "mysql://fixture-runtime.invalid/cluster",
    MYSQL_SCHEMA_METADATA_SCHEMA: "fixture_metadata", MYSQL_SCHEMA_METADATA_DEFINER_USER: "fixture_definer", MYSQL_SCHEMA_METADATA_DEFINER_HOST: "localhost" }),
    runtimeStoreOptions: {}, assertReusable: io.reusable, close: io.mysqlClose }),
}));
import { startCluster, type Cluster } from "./cluster/harness.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await Promise.resolve(); }
  throw new Error("controlled driver boundary was not reached");
}
function nameOf(child: ChildDouble): string { return child.env.RUNNER_ID ?? "router"; }
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input)), child = io.children.find(entry => String(entry.env.RUNNER_PORT ?? entry.env.ROUTER_PORT) === url.port);
  if (!child) throw new Error("unexpected driver-double request");
  const name = nameOf(child), configured = child.env.RUNNERS;
  if (name === "router" && configured === undefined) throw new Error("router driver double has no configured list");
  io.trace.push("ready:start:" + name);
  return await new Promise<Response>((resolve, reject) => {
    let finished = false;
    const signal = init?.signal, abort = () => {
      if (finished) return; finished = true; signal?.removeEventListener("abort", abort); reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const complete = () => {
      if (finished) return; finished = true;
      signal?.removeEventListener("abort", abort); io.trace.push("ready:done:" + name);
      const body = name === "router" ? `ready (${io.routerReadyCount ?? configured!.split(",").length} runners)` : "ready";
      resolve(new Response(body));
    };
    const gate = io.gates.get(name); if (gate) void gate.promise.then(complete); else queueMicrotask(complete);
  });
}

describe("cluster startup ownership (complete IO driver doubles, not native process/SQL proof)", () => {
  let cluster: Cluster | undefined;
  let pendingStart: Promise<Cluster> | undefined;
  function begin(options: Parameters<typeof startCluster>[0] = {}) {
    const pending = startCluster(options); pendingStart = pending; void pending.catch(() => {}); return pending;
  }
  beforeEach(() => {
    io.trace.length = 0; io.children.length = 0; io.sockets.length = 0; io.gates.clear(); io.redis = undefined;
    io.connectGate = undefined; io.holdChildClose = false; io.holdNativeClose = false; io.holdRedisEnd = false;
    io.spawnFailureFor = ""; io.nextPort = 21000; io.preparationSignal = undefined; io.routerReadyCount = undefined;
    io.mysqlClose.mockReset().mockImplementation(async () => { io.trace.push("mysql:close"); });
    io.reusable.mockReset().mockResolvedValue(undefined); io.schema.mockReset().mockResolvedValue(undefined);
    vi.spyOn(process, "kill").mockImplementation(pid => { io.children.find(child => child.pid === Math.abs(pid))?.kill("SIGKILL"); return true; });
    vi.spyOn(console, "warn").mockImplementation(() => {}); vi.stubGlobal("fetch", vi.fn(fakeFetch));
  });
  afterEach(async () => {
    // Release only driver-double barriers if an assertion fails, so this pure file cannot leak work.
    io.holdChildClose = false; io.holdNativeClose = false; io.holdRedisEnd = false;
    io.routerReadyCount = undefined;
    io.connectGate?.resolve(); for (const gate of io.gates.values()) gate.resolve();
    for (const socket of io.sockets) socket.emit("close");
    for (const child of io.children) child.emit("close");
    if (io.redis) { io.redis.status = "end"; io.redis.emit("end"); }
    try {
      const prepared = await pendingStart?.catch(() => undefined);
      await (cluster ?? prepared)?.stop({ successful: false });
    } finally { pendingStart = undefined; cluster = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it("keeps first bootstrap serial, overlaps only remaining runners/router, and awaits the complete fixed list", async () => {
    for (const name of ["runner-1", "runner-2", "router"]) io.gates.set(name, deferred());
    io.routerReadyCount = 1;
    const pending = begin({ runners: 2 }); let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    await until(() => io.trace.includes("ready:start:runner-1"));
    expect(io.children.map(nameOf)).toEqual(["runner-1"]);
    io.gates.get("runner-1")!.resolve();
    await until(() => io.trace.includes("ready:start:router") && io.trace.includes("ready:start:runner-2"));
    expect(io.children.map(nameOf)).toEqual(["runner-1", "runner-2", "router"]);
    const router = io.children.find(child => nameOf(child) === "router")!;
    expect(router.env.RUNNERS).toBe(io.children.filter(child => child.env.RUNNER_ID).map(child => "http://127.0.0.1:" + child.env.RUNNER_PORT).join(","));
    io.gates.get("router")!.resolve(); io.gates.get("runner-2")!.resolve();
    await until(() => io.trace.includes("ready:done:router") && io.trace.includes("ready:done:runner-2"));
    expect(settled).toBe(false);
    io.routerReadyCount = 2; cluster = await pending;
    expect(cluster.runners.map(proc => proc.name)).toEqual(["runner-1", "runner-2"]);
  });

  it("rejects an already-aborted caller before any preparation or spawn", async () => {
    const controller = new AbortController(), reason = new Error("controlled caller cancellation"); controller.abort(reason);
    await expect(begin({ signal: controller.signal })).rejects.toBe(reason);
    expect(io.trace).toEqual([]); expect(io.children).toEqual([]);
  });

  it("owns a late connect after cancellation until end and the original native socket close", async () => {
    io.connectGate = deferred(); io.holdNativeClose = true;
    const controller = new AbortController(), reason = new Error("controlled late-connect cancellation");
    const pending = begin({ signal: controller.signal }); let settled = false;
    const outcome = pending.then(value => ({ value }), error => { settled = true; return { error }; });
    await until(() => io.trace.includes("native:connect")); controller.abort(reason);
    io.connectGate.resolve(); await until(() => io.trace.includes("native:end"));
    expect(settled).toBe(false); expect(io.children).toEqual([]);
    io.sockets[0]!.emit("close"); expect(await outcome).toEqual({ error: reason });
    expect(io.trace).not.toContain("native:query"); expect(io.trace).not.toContain("mysql:witness");
  });

  it("cancels readiness synchronously but retains only after actual child close and Redis end", async () => {
    io.gates.set("runner-1", deferred()); io.holdChildClose = true; io.holdRedisEnd = true;
    const controller = new AbortController(), reason = new Error("controlled readiness cancellation");
    const pending = begin({ signal: controller.signal }); let settled = false;
    const outcome = pending.then(value => ({ value }), error => { settled = true; return { error }; });
    await until(() => io.trace.includes("ready:start:runner-1")); controller.abort(reason);
    await until(() => io.children[0]?.exitSeen === true);
    expect(settled).toBe(false); expect(io.trace).not.toContain("vendor:stop"); expect(io.children).toHaveLength(1);
    io.children[0]!.emit("close"); await until(() => io.trace.includes("redis:quit"));
    expect(settled).toBe(false); expect(io.mysqlClose).not.toHaveBeenCalled();
    io.redis!.status = "end"; io.redis!.emit("end");
    expect(await outcome).toEqual({ error: reason }); expect(io.mysqlClose).toHaveBeenCalledExactlyOnceWith({ successful: false });
  });

  it("settles a failed spawn using close without waiting for an exit that never occurs, even when diagnostics throw", async () => {
    io.spawnFailureFor = "runner-1"; vi.mocked(console.warn).mockImplementation(() => { throw new Error("diagnostic sink canary"); });
    const failure = await begin().then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error); expect(String(failure)).not.toContain("diagnostic sink canary");
    expect(io.children).toHaveLength(1); expect(io.children[0]!.exitSeen).toBe(false);
    expect(io.trace).toContain("vendor:stop"); expect(io.trace).toContain("redis:end");
    expect(io.mysqlClose).toHaveBeenCalledExactlyOnceWith({ successful: false });
  });

  it("preserves reuse signal on normal retained stop and keeps additional runner readiness serial", async () => {
    const controller = new AbortController(); cluster = await begin({ runners: 1, signal: controller.signal });
    io.gates.set("runner-2", deferred()); const additional = cluster.addRunner(); let settled = false;
    void additional.then(() => { settled = true; }, () => { settled = true; }); await until(() => io.trace.includes("ready:start:runner-2"));
    expect(settled).toBe(false); io.gates.get("runner-2")!.resolve(); await additional;
    await cluster.stop({ retainMysqlRuntime: true });
    expect(controller.signal.aborted).toBe(false); expect(io.preparationSignal?.aborted).toBe(false);
    expect(io.mysqlClose).not.toHaveBeenCalled();
    cluster = await begin({ runners: 1, signal: controller.signal, resetDatabase: false, mysqlRuntime: cluster.mysqlRuntime });
    expect(io.reusable).toHaveBeenCalledOnce(); await cluster.stop({ successful: true });
    expect(io.trace.indexOf("redis:end")).toBeLessThan(io.trace.lastIndexOf("mysql:close"));
    expect(io.mysqlClose).toHaveBeenCalledExactlyOnceWith({ successful: true });
  });
});
