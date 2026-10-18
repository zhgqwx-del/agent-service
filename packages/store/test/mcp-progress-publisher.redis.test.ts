import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@agent-service/protocol";
import { MemoryEventBus } from "../src/memory.js";
import { RedisEventBus } from "../src/redis/bus.js";
import { redisSessionKeys } from "../src/redis/keys.js";
import { RedisSessionPurgedError } from "../src/redis/purge.js";
import type { McpProgressEvent, McpProgressPublisher } from "../src/types.js";
import { newId } from "./conformance.js";

const unavailable = "MCP progress publisher is unavailable.";
const event = (sessionId: string, progress = 1): McpProgressEvent => ({
  type: "item/mcpToolCall/progress", sessionId, emittedAtMs: Date.now(),
  turnId: newId("turn"), itemId: newId("item"), toolCallId: "actual-tool-call", progress, total: 3,
});
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 4000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error("MCP progress fixture did not settle."); await pause(5); }
}

describe("Memory MCP progress publisher", () => {
  it("uses actual synchronous fan-out rather than a subclass's unbounded publish override, and never hot-replays progress", async () => {
    let overridden = 0;
    class RecordingBus extends MemoryEventBus {
      override publish(_sessionId: string, _event: Event): Promise<void> { overridden++; return new Promise<void>(() => {}); }
    }
    const bus = new RecordingBus(), sessionId = newId("sess"), observed: Event[] = [], replayed: Event[] = [];
    const off = await bus.subscribe(sessionId, value => observed.push(value));
    const publisher = bus.openMcpProgressPublisher(sessionId, { signal: new AbortController().signal, timeoutMs: 2000 });
    try {
      const value = event(sessionId); await publisher.publish(value);
      expect(observed).toEqual([value]); expect(overridden).toBe(0);
      const offReplay = await bus.subscribe(sessionId, value => replayed.push(value), { afterSeq: 0 });
      offReplay(); expect(replayed).toEqual([]);
      await publisher.close(); await expect(publisher.publish(event(sessionId))).rejects.toThrow(unavailable);
    } finally { off(); await publisher.close(); await bus.close(); }
  });
  it("rejects cross-session, durable and malformed progress before any listener receives it", async () => {
    const bus = new MemoryEventBus(), sessionId = newId("sess"), observed = vi.fn();
    const off = await bus.subscribe(sessionId, observed);
    try {
      const wrong = [event(newId("sess")), { ...event(sessionId), seq: 1 },
        { ...event(sessionId), total: 0 }, { ...event(sessionId), progress: Infinity },
        { ...event(sessionId), message: "界".repeat(171) }, { ...event(sessionId), type: "heartbeat" }];
      for (const value of wrong) {
        const publisher = bus.openMcpProgressPublisher(sessionId, { signal: new AbortController().signal, timeoutMs: 2000 });
        await expect(publisher.publish(value as McpProgressEvent)).rejects.toThrow(unavailable); await publisher.close();
      }
      expect(observed).not.toHaveBeenCalled();
    } finally { off(); await bus.close(); }
  });
  it("fences on abort and bus close without treating void listeners' return values as cancellable I/O", async () => {
    const bus = new MemoryEventBus(), sessionId = newId("sess"), abort = new AbortController(), called = vi.fn();
    await bus.subscribe(sessionId, () => { called(); return new Promise<void>(() => {}); });
    const publisher = bus.openMcpProgressPublisher(sessionId, { signal: abort.signal, timeoutMs: 2000 });
    await publisher.publish(event(sessionId)); expect(called).toHaveBeenCalledTimes(1);
    abort.abort(); await publisher.close(); await expect(publisher.publish(event(sessionId))).rejects.toThrow(unavailable);
    const other = bus.openMcpProgressPublisher(sessionId, { signal: new AbortController().signal, timeoutMs: 2000 });
    await bus.close(); await expect(other.publish(event(sessionId))).rejects.toThrow(unavailable);
    expect(() => bus.openMcpProgressPublisher(sessionId, { signal: abort.signal, timeoutMs: 2000 })).toThrow(unavailable);
  });
});

/** A real TCP forwarder. Only the publisher duplicate is routed here; ordinary bus I/O stays direct. */
async function proxy(target: URL, mode: "hold-eval" | "hold-handshake" | "close-eval" | "pass") {
  const native = new Map<Socket, Promise<void>>();
  let connections = 0, evals = 0, discardedResponses = 0, parserFailed = false;
  const held: { socket: Socket; bytes: Buffer }[] = [];
  const watch = (socket: Socket) => {
    const closed = new Promise<void>(resolve => socket.once("close", () => { native.delete(socket); resolve(); }));
    native.set(socket, closed);
  };
  const server = createServer(front => {
    connections++; watch(front);
    const back = createConnection({ host: target.hostname === "[::1]" ? "::1" : target.hostname, port: Number(target.port || 6379) }); watch(back);
    let buffered = Buffer.alloc(0), holding = mode === "hold-handshake";
    const destroy = () => { front.destroy(); back.destroy(); };
    front.on("error", destroy); back.on("error", destroy);
    front.once("close", () => back.destroy()); back.once("close", () => front.destroy());
    front.on("data", bytes => {
      try {
        buffered = Buffer.concat([buffered, bytes]); if (buffered.length > 65536) throw new Error();
        let consumed = 0;
        while (consumed < buffered.length) {
          const start = consumed, headEnd = buffered.indexOf("\r\n", start);
          if (headEnd < 0) break;
          const head = buffered.subarray(start, headEnd).toString("ascii");
          if (!/^\*[1-9][0-9]*$/.test(head)) throw new Error();
          const count = Number(head.slice(1)); if (count > 32) throw new Error();
          let cursor = headEnd + 2, command: string | undefined, complete = true;
          for (let index = 0; index < count; index++) {
            const end = buffered.indexOf("\r\n", cursor); if (end < 0) { complete = false; break; }
            const length = buffered.subarray(cursor, end).toString("ascii");
            if (!/^\$[0-9]+$/.test(length)) throw new Error();
            const size = Number(length.slice(1)); if (size > 32768) throw new Error();
            cursor = end + 2;
            if (cursor + size + 2 > buffered.length) { complete = false; break; }
            if (buffered[cursor + size] !== 13 || buffered[cursor + size + 1] !== 10) throw new Error();
            if (index === 0) command = buffered.subarray(cursor, cursor + size).toString("ascii").toLowerCase();
            cursor += size + 2;
          }
          if (!complete) break;
          consumed = cursor;
          if (command === "eval") { evals++; if (mode === "hold-eval") holding = true; if (mode === "close-eval") { destroy(); return; } }
        }
        buffered = buffered.subarray(consumed);
        back.write(bytes);
      } catch { parserFailed = true; destroy(); }
    });
    back.on("data", bytes => {
      if (holding) { discardedResponses++; if (mode === "hold-handshake") held.push({ socket: front, bytes: Buffer.from(bytes) }); }
      else front.write(bytes);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    stats: () => ({ connections, evals, discardedResponses, parserFailed, openSockets: native.size }),
    releaseLateResponses: () => { for (const value of held.splice(0)) if (!value.socket.destroyed) value.socket.write(value.bytes); },
    close: async () => {
      const ended = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const sockets = [...native.values()]; for (const socket of native.keys()) socket.destroy();
      await Promise.all([ended, ...sockets]);
    },
  };
}
const configured = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
type ProxyMode = Parameters<typeof proxy>[1];
async function fixture(mode: ProxyMode, work: (value: {
  bus: RedisEventBus; admin: Redis; sessionId: string; observed: Event[];
  keys: ReturnType<typeof redisSessionKeys>;
  closeBus: () => Promise<void>;
  network: Awaited<ReturnType<typeof proxy>>; keep: (publisher: McpProgressPublisher) => McpProgressPublisher;
}) => Promise<void>) {
  const target = new URL(configured);
  if (target.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) throw new Error("MCP progress fixture requires loopback Redis.");
  const network = await proxy(target, mode), admin = new Redis(configured, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const prefix = `test-mcp-progress-${randomUUID()}`, sessionId = newId("sess"), keys = redisSessionKeys(sessionId, prefix);
  const bus = new RedisEventBus(configured, { prefix }), observed: Event[] = [], publishers: McpProgressPublisher[] = [];
  const duplicate = Redis.prototype.duplicate;
  const routing = vi.spyOn(Redis.prototype, "duplicate").mockImplementation(function (this: Redis, options) {
    return duplicate.call(this, { ...options, host: "127.0.0.1", port: network.port, path: undefined, tls: undefined });
  });
  let off: (() => void) | undefined;
  let busClosed = false;
  const closeBus = async () => { if (!busClosed) { await bus.close(); busClosed = true; } };
  try {
    expect(await admin.ping()).toBe("PONG"); expect(await admin.exists(keys.stream, keys.purgeMarker)).toBe(0);
    off = await bus.subscribe(sessionId, value => observed.push(value));
    await work({ bus, admin, sessionId, observed, keys, closeBus, network, keep: publisher => { publishers.push(publisher); return publisher; } });
    expect(network.stats().parserFailed).toBe(false);
  } finally {
    off?.();
    await Promise.all(publishers.map(publisher => publisher.close())); await closeBus(); routing.mockRestore();
    try { await admin.del(keys.stream, keys.purgeMarker); } finally { await admin.quit(); await network.close(); }
  }
}
describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("MCP progress actual Redis owned connection", () => {
  it("bounds a TCP-ACK/RESP blackhole to 2s, waits for actual socket close, and leaves shared durable pub/sub usable", async () => fixture("hold-eval", async f => {
    const publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: new AbortController().signal, timeoutMs: 2000 }));
    const started = performance.now(), pending = publisher.publish(event(f.sessionId));
    const rejected = expect(pending).rejects.toThrow(unavailable);
    await until(() => f.network.stats().evals === 1 && f.observed.length === 1);
    expect(f.network.stats().openSockets).toBeGreaterThan(0); expect(f.network.stats().discardedResponses).toBeGreaterThan(0);
    await rejected; await publisher.close(); await until(() => f.network.stats().openSockets === 0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1800);
    expect(performance.now() - started).toBeLessThan(4000);
    await expect(publisher.publish(event(f.sessionId, 2))).rejects.toThrow(unavailable);
    expect(f.network.stats()).toMatchObject({ connections: 1, evals: 1 });
    expect(await f.admin.exists(f.keys.stream)).toBe(0);
    await f.bus.publish(f.sessionId, { type: "session/created", sessionId: f.sessionId, seq: 1, emittedAtMs: Date.now() });
    await until(() => f.observed.some(value => value.type === "session/created"));
    expect(await f.admin.ping()).toBe("PONG");
  }));
  it.each(["abort", "bus-close"] as const)("actually closes only its pending observation connection on %s", async mode => fixture("hold-eval", async f => {
    const abort = new AbortController(), publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: abort.signal, timeoutMs: 2000 }));
    const rejected = expect(publisher.publish(event(f.sessionId))).rejects.toThrow(unavailable);
    await until(() => f.network.stats().evals === 1 && f.observed.length === 1);
    const closing = mode === "abort" ? (abort.abort(), publisher.close()) : f.closeBus();
    await Promise.all([rejected, closing]); await until(() => f.network.stats().openSockets === 0);
    expect(f.network.stats()).toMatchObject({ connections: 1, evals: 1 });
    expect(await f.admin.ping()).toBe("PONG");
    if (mode === "abort") {
      await f.bus.publish(f.sessionId, { type: "session/created", sessionId: f.sessionId, seq: 1, emittedAtMs: Date.now() });
      await until(() => f.observed.some(value => value.type === "session/created"));
    }
  }));
  it("settles an abort during the real TCP handshake and cannot connect or publish when delayed replies are released later", async () => fixture("hold-handshake", async f => {
    const abort = new AbortController(), publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: abort.signal, timeoutMs: 2000 }));
    const rejected = expect(publisher.publish(event(f.sessionId))).rejects.toThrow(unavailable);
    await until(() => f.network.stats().connections === 1 && f.network.stats().discardedResponses > 0);
    abort.abort(); await Promise.all([rejected, publisher.close()]); await until(() => f.network.stats().openSockets === 0);
    f.network.releaseLateResponses(); await pause(30);
    expect(f.network.stats()).toMatchObject({ connections: 1, evals: 0, openSockets: 0 }); expect(f.observed).toEqual([]);
    await expect(publisher.publish(event(f.sessionId))).rejects.toThrow(unavailable);
  }));
  it("settles an immediate pre-connect abort without late native connections or a queued EVAL", async () => fixture("pass", async f => {
    const abort = new AbortController(), publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: abort.signal, timeoutMs: 2000 }));
    const rejected = expect(publisher.publish(event(f.sessionId))).rejects.toThrow(unavailable);
    abort.abort(); await Promise.all([rejected, publisher.close()]); await pause(30);
    expect(f.network.stats()).toMatchObject({ connections: 0, evals: 0, openSockets: 0 }); expect(f.observed).toEqual([]);
  }));
  it("rejects another session or any seq before opening its owned Redis connection", async () => fixture("pass", async f => {
    for (const value of [event(newId("sess")), { ...event(f.sessionId), seq: undefined }, { ...event(f.sessionId), total: 0 }]) {
      const publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: new AbortController().signal, timeoutMs: 2000 }));
      await expect(publisher.publish(value as McpProgressEvent)).rejects.toThrow(unavailable); await publisher.close();
    }
    expect(f.network.stats()).toMatchObject({ connections: 0, evals: 0, openSockets: 0 }); expect(f.observed).toEqual([]);
  }));
  it("does not reconnect or replay after the real progress socket is closed by its peer", async () => fixture("close-eval", async f => {
    const publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: new AbortController().signal, timeoutMs: 2000 }));
    await expect(publisher.publish(event(f.sessionId))).rejects.toThrow(unavailable); await publisher.close();
    await until(() => f.network.stats().openSockets === 0); await pause(30);
    expect(f.network.stats()).toMatchObject({ connections: 1, evals: 1 }); expect(f.observed).toEqual([]);
    expect(await f.admin.ping()).toBe("PONG");
  }));
  it("keeps a healthy long call observable after 2s while preserving the exact permanent purge Lua gate and no Stream writes", async () => fixture("pass", async f => {
    const publisher = f.keep(f.bus.openMcpProgressPublisher(f.sessionId, { signal: new AbortController().signal, timeoutMs: 2000 }));
    await publisher.publish(event(f.sessionId)); await until(() => f.observed.length === 1); await pause(2050);
    await publisher.publish(event(f.sessionId, 2)); await until(() => f.observed.length === 2);
    expect(await f.admin.exists(f.keys.stream)).toBe(0);
    await f.admin.set(f.keys.purgeMarker, "fixture-purge-marker");
    await expect(publisher.publish(event(f.sessionId, 3))).rejects.toBeInstanceOf(RedisSessionPurgedError);
    await publisher.close(); await until(() => f.network.stats().openSockets === 0);
    expect(f.observed).toHaveLength(2); expect(await f.admin.exists(f.keys.stream)).toBe(0);
    expect(f.network.stats()).toMatchObject({ connections: 1, evals: 3 });
  }));
});
