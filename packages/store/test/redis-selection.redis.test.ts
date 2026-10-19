import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { Redis, ReplyError, type RedisOptions } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { guardRedisDatabaseSelection, type PersistedEvent } from "@agent-service/protocol";
import { RedisEventBus } from "../src/redis/bus.js";
import { redisSessionKeys } from "../src/redis/keys.js";
import { RedisLeaseStore } from "../src/redis/lease.js";
import { newId } from "./conformance.js";

const unavailable = "Redis selection fixture is not proven.";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(unavailable);
    await pause(5);
  }
}
type Result<T> = { ok: true; value: T } | { ok: false };
interface Observed<T> { result?: Result<T>; settled: Promise<Result<T>> }
interface ClientObservation {
  client: Redis;
  connects: number;
  ready: number;
  reconnects: number;
  selectReplyErrors: number;
  sockets: Map<Socket, { closed: boolean; settled: Promise<void> }>;
}
function selectReplyError(error: unknown): boolean {
  if (!(error instanceof ReplyError)) return false;
  const command = Object.getOwnPropertyDescriptor(error, "command");
  if (!command || !("value" in command) || command.value === null || typeof command.value !== "object") return false;
  const name = Object.getOwnPropertyDescriptor(command.value, "name");
  return !!name && "value" in name && typeof name.value === "string" && name.value.toLowerCase() === "select";
}
function selectedDatabase(value: unknown): number {
  if (typeof value !== "string") throw new Error(unavailable);
  const entries = value.trim().split(/\s+/).filter(part => part.startsWith("db="));
  if (entries.length !== 1 || !/^db=(?:0|[1-9][0-9]*)$/.test(entries[0]!)) throw new Error(unavailable);
  const database = Number(entries[0]!.slice(3));
  if (!Number.isSafeInteger(database)) throw new Error(unavailable);
  return database;
}
function storeClient(store: object, name: "redis" | "pub" | "sub"): Redis {
  const descriptor = Object.getOwnPropertyDescriptor(store, name);
  if (!descriptor || !("value" in descriptor) || !(descriptor.value instanceof Redis)) throw new Error(unavailable);
  return descriptor.value;
}

/** No fallback to a developer's default Redis. Every case reads the actual server DB count. */
async function fixture(signal: AbortSignal, work: (f: {
  invalidDatabase: number; validDatabase: number; prefix: string; admin: Redis;
  url: (database: number) => string;
  client: (database: number, guarded?: boolean, options?: RedisOptions) => ClientObservation;
  watch: (client: Redis) => ClientObservation;
  observe: <T>(promise: Promise<T>) => Observed<T>;
  io: <T>(promise: Promise<T>) => Promise<T>;
  own: (key: string, database?: number) => string;
  rejected: <T>(operation: Observed<T>) => Promise<void>;
  ended: (observation: ClientObservation) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const configured = process.env.REDIS_TEST_URL;
  let target: URL;
  try {
    if (!configured) throw new Error();
    target = new URL(configured);
    if (target.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
      || !/^[1-9][0-9]*$/.test(target.port) || Number(target.port) > 65_535
      || target.search || target.hash || !/^\/(?:0|[1-9][0-9]*)$/.test(target.pathname)) throw new Error();
  } catch { throw new Error(unavailable); }
  const prefix = `rs-select-${randomUUID()}`;
  const observations = new Map<Redis, ClientObservation>();
  const pending = new Set<Promise<unknown>>();
  const ownedKeys = new Map<number, Set<string>>();
  let nativeInvalid = false, teardownFailed = false, passed = false;
  let failure: unknown;
  const observe = <T>(promise: Promise<T>): Observed<T> => {
    const operation: Observed<T> = { settled: undefined! };
    // Install rejection handling immediately; never print a native error, command args or URL.
    operation.settled = promise.then<Result<T>, Result<T>>(
      value => operation.result = { ok: true, value },
      () => operation.result = { ok: false },
    );
    pending.add(operation.settled);
    return operation;
  };
  const io = async <T>(promise: Promise<T>): Promise<T> => {
    const operation = observe(promise);
    await until(() => operation.result !== undefined);
    const result = await operation.settled;
    if (!result.ok) throw new Error(unavailable);
    return result.value;
  };
  const capture = (observation: ClientObservation): void => {
    const socket = observation.client.stream;
    if (socket === undefined) return;
    if (!(socket instanceof Socket)) { nativeInvalid = true; return; }
    if (observation.sockets.has(socket)) return;
    const record = { closed: socket.closed, settled: Promise.resolve() };
    if (!record.closed) record.settled = new Promise<void>(resolve => socket.once("close", () => { record.closed = true; resolve(); }));
    observation.sockets.set(socket, record);
  };
  const watch = (client: Redis): ClientObservation => {
    const existing = observations.get(client); if (existing) return existing;
    const observation: ClientObservation = { client, connects: 0, ready: 0, reconnects: 0, selectReplyErrors: 0, sockets: new Map() };
    observations.set(client, observation);
    client.on("connect", () => { observation.connects++; capture(observation); });
    client.on("ready", () => { observation.ready++; capture(observation); });
    client.on("reconnecting", () => { observation.reconnects++; capture(observation); });
    client.on("error", error => { capture(observation); if (selectReplyError(error)) observation.selectReplyErrors++; });
    client.on("end", () => capture(observation));
    capture(observation);
    return observation;
  };
  const url = (database: number): string => { const value = new URL(target); value.pathname = `/${database}`; return value.href; };
  const client = (database: number, guarded = true, options: RedisOptions = {}): ClientObservation => {
    const value = new Redis(url(database), { lazyConnect: true, connectTimeout: 5_000, commandTimeout: 5_000,
      maxRetriesPerRequest: 1, retryStrategy: () => null, ...options });
    const observation = watch(value);
    if (guarded) expect(guardRedisDatabaseSelection(value) === value).toBe(true);
    return observation;
  };
  const stop = (observation: ClientObservation): void => {
    capture(observation);
    try { observation.client.disconnect(false); } catch { teardownFailed = true; }
    finally {
      capture(observation);
      for (const socket of observation.sockets.keys()) try { socket.destroy(); } catch { teardownFailed = true; }
    }
  };
  const abort = () => { for (const observation of observations.values()) stop(observation); };
  signal.addEventListener("abort", abort, { once: true });
  const adminObservation = client(0), admin = adminObservation.client;
  const own = (key: string, database = 0): string => {
    if (!key.startsWith(`${prefix}:`)) throw new Error(unavailable);
    let keys = ownedKeys.get(database); if (!keys) ownedKeys.set(database, keys = new Set());
    keys.add(key); return key;
  };
  const ended = async (observation: ClientObservation): Promise<void> => {
    await until(() => observation.client.status === "end" && observation.sockets.size > 0
      && [...observation.sockets.values()].every(record => record.closed));
    await Promise.all([...observation.sockets.values()].map(record => record.settled));
  };
  try {
    if (signal.aborted) throw new Error(unavailable);
    await io(admin.connect());
    expect(selectedDatabase(await io(admin.client("INFO")))).toBe(0);
    const databases: unknown = await io(admin.config("GET", "databases"));
    if (!Array.isArray(databases) || databases.length !== 2 || databases[0] !== "databases"
      || typeof databases[1] !== "string" || !/^[1-9][0-9]*$/.test(databases[1])) throw new Error(unavailable);
    const count = Number(databases[1]), configuredDatabase = Number(target.pathname.slice(1));
    if (!Number.isSafeInteger(count) || count < 2 || !Number.isSafeInteger(configuredDatabase)
      || configuredDatabase >= count) throw new Error(unavailable);
    const validDatabase = configuredDatabase === 0 ? 1 : configuredDatabase;
    await work({ invalidDatabase: count, validDatabase, prefix, admin, url, client, watch, observe, io, own,
      rejected: async operation => {
        await until(() => operation.result !== undefined);
        expect((await operation.settled).ok).toBe(false);
      }, ended });
    passed = true;
  } catch (error) { failure = error; }
  finally {
    // Disconnect only test-owned clients and join every original command and native stream.
    for (const observation of observations.values()) if (observation !== adminObservation) stop(observation);
    try {
      await Promise.all([...pending]);
      for (const observation of observations.values()) if (observation !== adminObservation) {
        if (observation.sockets.size) await ended(observation);
        else if (observation.client.status !== "end") throw new Error(unavailable);
      }
      if (passed && !signal.aborted && !teardownFailed && !nativeInvalid) {
        for (const [database, keys] of ownedKeys) {
          expect(await io(admin.select(database))).toBe("OK");
          if (keys.size) await io(admin.del(...keys));
        }
      }
    } catch (error) { if (failure === undefined) failure = error; }
    finally {
      stop(adminObservation);
      try { await Promise.all([...pending]); await ended(adminObservation); }
      catch (error) { if (failure === undefined) failure = error; }
      signal.removeEventListener("abort", abort);
    }
    if (failure === undefined && (signal.aborted || teardownFailed || nativeInvalid)) failure = new Error(unavailable);
  }
  if (failure !== undefined) throw failure;
}

describe("actual Redis database selection failure", () => {
  it("shows the raw driver's rejected SELECT can still become ready in DB0 without writing data", async ctx => fixture(ctx.signal, async f => {
    const raw = f.client(f.invalidDatabase, false);
    await f.io(raw.client.connect());
    expect(raw.selectReplyErrors).toBe(1);
    expect(raw.connects).toBe(1); expect(raw.ready).toBe(1);
    expect(selectedDatabase(await f.io(raw.client.client("INFO")))).toBe(0);
  }));

  it("rejects a queued SET after actual SELECT failure instead of creating its owned key in DB0", async ctx => fixture(ctx.signal, async f => {
    const selected = f.client(f.invalidDatabase), key = f.own(`${f.prefix}:queued`);
    expect(await f.io(f.admin.exists(key))).toBe(0);
    const queued = f.observe(selected.client.set(key, "must-not-land-in-db0"));
    await f.rejected(queued); await f.ended(selected);
    expect(selected.selectReplyErrors).toBe(1);
    expect(selected.connects).toBe(1); expect(selected.ready).toBe(0);
    expect(await f.io(f.admin.exists(key))).toBe(0);
  }));

  it("keeps successful selected-DB writes in the actual valid nonzero database", async ctx => fixture(ctx.signal, async f => {
    const selected = f.client(f.validDatabase), key = f.own(`${f.prefix}:valid`, f.validDatabase);
    await f.io(selected.client.connect());
    expect(selectedDatabase(await f.io(selected.client.client("INFO")))).toBe(f.validDatabase);
    expect(await f.io(f.admin.exists(key))).toBe(0);
    expect(await f.io(selected.client.set(key, "selected-only"))).toBe("OK");
    expect(await f.io(selected.client.get(key))).toBe("selected-only");
    expect(await f.io(f.admin.exists(key))).toBe(0);
    expect(selected.selectReplyErrors).toBe(0);
  }));

  it("permanently disconnects a real reconnect whose new handshake SELECT fails before old condition restoration", async ctx => fixture(ctx.signal, async f => {
    const selected = f.client(f.validDatabase, true, { retryStrategy: () => 20, autoResendUnfulfilledCommands: false });
    await f.io(selected.client.connect());
    expect(selectedDatabase(await f.io(selected.client.client("INFO")))).toBe(f.validDatabase);
    const oldSocket = selected.client.stream, key = f.own(`${f.prefix}:reconnect`);
    if (!(oldSocket instanceof Socket)) throw new Error(unavailable);
    let queued: Observed<string> | undefined;
    selected.client.once("reconnecting", () => { queued = f.observe(selected.client.set(key, "must-not-replay-in-db0")); });
    // ioredis 6 rebuilds condition from options.db on actual reconnect. Do not edit condition:
    // a failed new SELECT must close before readyHandler can restore the previous valid DB.
    selected.client.options.db = f.invalidDatabase;
    oldSocket.destroy();
    await until(() => queued !== undefined);
    await f.rejected(queued!); await f.ended(selected);
    expect(selected.reconnects).toBe(1); expect(selected.connects).toBe(2);
    expect(selected.sockets.size).toBe(2); expect(oldSocket.closed).toBe(true);
    expect(selected.ready).toBe(1); expect(selected.selectReplyErrors).toBe(1);
    expect(await f.io(f.admin.exists(key))).toBe(0);
  }));

  it("guards actual lease, event pub/sub and owned progress duplicate clients without DB0 store writes", async ctx => fixture(ctx.signal, async f => {
    const sessionId = newId("sess"), keys = redisSessionKeys(sessionId, f.prefix);
    for (const key of [keys.lease, keys.fence, keys.stream, keys.purgeMarker]) f.own(key);
    expect(await f.io(f.admin.exists(keys.lease, keys.fence, keys.stream, keys.purgeMarker))).toBe(0);
    const readyKey = f.own(f.prefix + ":ready-queued");
    expect(await f.io(f.admin.exists(readyKey))).toBe(0);
    const lease = new RedisLeaseStore(f.url(f.invalidDatabase), f.prefix);
    const bus = new RedisEventBus(f.url(f.invalidDatabase), { prefix: f.prefix });
    const actual = [f.watch(storeClient(lease, "redis")), f.watch(storeClient(bus, "pub")), f.watch(storeClient(bus, "sub"))];
    const originalDuplicate = Redis.prototype.duplicate;
    const duplicates: ClientObservation[] = [];
    type DuplicateEvent = { phase: "select_reply_error" | "ready"; order: number; socket?: Socket; destroyed: boolean; writable: boolean };
    const duplicateEvidence: { observation: ClientObservation; timeline: DuplicateEvent[]; readyWrites: Observed<unknown>[];
      evalCalls: () => number; restoreEval: () => void }[] = [];
    let duplicateOrder = 0, callbackFailed = false;
    const spy = vi.spyOn(Redis.prototype, "duplicate").mockImplementation(function (this: Redis, options) {
      const duplicate = originalDuplicate.call(this, options), observation = f.watch(duplicate);
      duplicates.push(observation);
      // Default spy behavior calls the actual method. No synthetic successful/rejected EVAL.
      const evalSpy = vi.spyOn(duplicate, "eval"), timeline: DuplicateEvent[] = [], readyWrites: Observed<unknown>[] = [];
      duplicateEvidence.push({ observation, timeline, readyWrites, evalCalls: () => evalSpy.mock.calls.length, restoreEval: () => evalSpy.mockRestore() });
      const record = (phase: DuplicateEvent["phase"]) => {
        if (timeline.length >= 4) { callbackFailed = true; return; }
        const socket = duplicate.stream;
        timeline.push({ phase, order: ++duplicateOrder, socket: socket instanceof Socket ? socket : undefined,
          destroyed: socket instanceof Socket && socket.destroyed, writable: socket instanceof Socket && socket.writable });
      };
      duplicate.on("error", error => { try { if (selectReplyError(error)) record("select_reply_error"); } catch { callbackFailed = true; } });
      duplicate.on("ready", () => {
        try {
          record("ready");
          // Own rejection immediately, from inside the actual ready callback, without throwing there.
          readyWrites.push(f.observe(duplicate.set(readyKey, "must-not-land-in-db0")));
        } catch { callbackFailed = true; }
      });
      return duplicate;
    });
    let publisher: ReturnType<RedisEventBus["openMcpProgressPublisher"]> | undefined;
    try {
      publisher = bus.openMcpProgressPublisher(sessionId, { signal: new AbortController().signal, timeoutMs: 2_000 });
      const persisted: PersistedEvent = { type: "session/created", sessionId, seq: 1, emittedAtMs: Date.now() };
      const progress = { type: "item/mcpToolCall/progress" as const, sessionId,
        turnId: newId("turn"), itemId: newId("item"), toolCallId: "owned-call", emittedAtMs: Date.now(), progress: 1 };
      const acquiring = f.observe(lease.acquire(sessionId, "owned-runner", "127.0.0.1:1", 5_000));
      const publishing = f.observe(bus.publish(sessionId, persisted));
      const progressing = f.observe(publisher.publish(progress));
      await Promise.all([f.rejected(acquiring), f.rejected(publishing), f.rejected(progressing)]);
      expect(duplicates.length).toBe(1); expect(duplicateEvidence.length).toBe(1);
      for (const observation of actual) {
        await f.ended(observation);
        expect(observation.selectReplyErrors).toBe(1); expect(observation.ready).toBe(0);
        expect(observation.connects).toBe(1); expect(observation.reconnects).toBe(0); expect(observation.sockets.size).toBe(1);
      }
      for (const evidence of duplicateEvidence) {
        const observation = evidence.observation;
        await f.ended(observation);
        expect(observation.selectReplyErrors).toBe(1); expect(observation.ready).toBeLessThanOrEqual(1);
        expect(observation.connects).toBe(1); expect(observation.reconnects).toBe(0); expect(observation.sockets.size).toBe(1);
        expect(evidence.timeline.map(event => event.phase)).toEqual(observation.ready === 0 ? ["select_reply_error"] : ["select_reply_error", "ready"]);
        const selected = evidence.timeline.find(event => event.phase === "select_reply_error");
        if (!selected || !(selected.socket instanceof Socket)) throw new Error(unavailable);
        expect(observation.sockets.has(selected.socket)).toBe(true);
        const readyEvents = evidence.timeline.filter(event => event.phase === "ready");
        expect(readyEvents.length).toBe(observation.ready); expect(evidence.readyWrites.length).toBe(readyEvents.length);
        for (const ready of readyEvents) {
          expect(selected.order < ready.order).toBe(true); expect(ready.socket === selected.socket).toBe(true);
          expect(ready.destroyed).toBe(true); expect(ready.writable).toBe(false);
        }
        await Promise.all(evidence.readyWrites.map(write => f.rejected(write)));
        expect(evidence.evalCalls()).toBe(0);
      }
      expect(callbackFailed).toBe(false);
      const latePublishing = f.observe(bus.publish(sessionId, persisted));
      const lateProgressing = f.observe(publisher.publish({ ...progress, progress: 2 }));
      await Promise.all([f.rejected(latePublishing), f.rejected(lateProgressing)]);
      for (const evidence of duplicateEvidence) expect(evidence.evalCalls()).toBe(0);
      expect(await f.io(f.admin.exists(keys.lease, keys.fence, keys.stream, keys.purgeMarker))).toBe(0);
      expect(await f.io(f.admin.exists(readyKey))).toBe(0);
    } finally {
      spy.mockRestore();
      const closed = [f.observe(lease.close()), f.observe(bus.close())];
      if (publisher) closed.push(f.observe(publisher.close()));
      // Invalid setup may make QUIT reject because the guarded clients are already ended.
      // Native stream closure, not synthetic ready/end or successful QUIT, is the oracle above.
      try { await Promise.all(closed.map(operation => operation.settled)); }
      finally { for (const evidence of duplicateEvidence) evidence.restoreEval(); }
    }
  }));
});
