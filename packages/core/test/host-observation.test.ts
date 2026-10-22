import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, emptyUsage, type AgentDefinition, type Event, type EventInput, type PersistedEvent, type Principal } from "@agent-service/protocol";
import { MemoryLeaseStore, MemorySessionStore, type EventBus, type EventListener, type EventSubscriptionOptions } from "@agent-service/store";
import { DEFAULT_SSE_LIMITS, resolveSseLimits, SessionHost, StaticToolRegistry, newId, type SseResourceLimits } from "../src/index.js";
import { ScriptedEngine } from "./fake-engine.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

class ObservationBus implements EventBus {
  readonly listeners = new Set<EventListener>();
  readonly attachEntered = deferred();
  attachGate: Promise<void> | undefined;
  removeGate: Promise<void> | undefined;
  removals = 0;
  reconnect: (() => void | Promise<void>) | undefined;
  async publish(_sessionId: string, event: Event) { for (const listener of this.listeners) listener(event); }
  async subscribe(_sessionId: string, listener: EventListener, opts?: EventSubscriptionOptions) {
    this.attachEntered.resolve(); await this.attachGate;
    this.listeners.add(listener); this.reconnect = opts?.onReconnect;
    let removing: Promise<void> | undefined;
    return () => {
      if (removing) return removing;
      this.listeners.delete(listener); this.removals++;
      return removing = Promise.resolve(this.removeGate);
    };
  }
  async close() { this.listeners.clear(); }
}

const owner: Principal = { tenantId: "observation-tenant", userId: "observation-user" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function fixture(sseLimits?: Partial<SseResourceLimits>) {
  const store = new MemorySessionStore(), lease = new MemoryLeaseStore(), bus = new ObservationBus();
  const engine = new ScriptedEngine([{ text: "synthetic reply" }]);
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "observation",
    instructions: "", model: { provider: "fake", model: "fake" }, tools: [], mcpServers: [], skills: [], limits: {},
    approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const host = new SessionHost({ store, lease, bus, engine, tools: new StaticToolRegistry([]),
    providers: { resolve: async () => ({ handle: {}, provider: "fake", model: "fake", contextWindow: 32_000, input: ["text"], apiKey: async () => "fixture-only" }) },
    config: { runnerId: "observation-runner", runnerAddr: "127.0.0.1:1", leaseHoldMs: 1, sseLimits },
    logger: { info() {}, warn() {}, error() {} } });
  const session = await host.createSession(owner, { agentId: agent.id, metadata: {} });
  cleanup.push(async () => { await host.drain(1_000); await bus.close(); });
  const warnings = async (messages: string[]) => store.commit({ sessionId: session.id, fence: 0,
    events: messages.map(message => ({ type: "warning", sessionId: session.id, emittedAtMs: 1, code: "fixture", message })) });
  return { store, lease, bus, engine, agent, host, session, warnings };
}

describe("bounded session observations and resource configuration", () => {
  it("freezes the shared finite defaults and rejects unsafe limits and native timer overflow", () => {
    expect(DEFAULT_SSE_LIMITS).toEqual({ maxQueuedEvents: 256, maxQueuedBytes: 4_194_304, maxFrameBytes: 2_097_152,
      maxReplayEvents: 10_000, maxReplayBytes: 33_554_432, replayTimeoutMs: 30_000, writeStallMs: 30_000,
      maxConnections: 128, maxConnectionsPerTenant: 32 });
    expect(Object.isFrozen(DEFAULT_SSE_LIMITS)).toBe(true);
    const supplied = { maxQueuedEvents: 7 }, resolved = resolveSseLimits(supplied); supplied.maxQueuedEvents = 99;
    expect(resolved.maxQueuedEvents).toBe(7); expect(Object.isFrozen(resolved)).toBe(true);
    for (const key of Object.keys(DEFAULT_SSE_LIMITS)) for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveSseLimits({ [key]: value })).toThrow();
    }
    expect(() => resolveSseLimits({ maxFrameBytes: 4_194_305 })).toThrow();
    expect(() => resolveSseLimits({ maxConnections: 31 })).toThrow();
    for (const key of ["replayTimeoutMs", "writeStallMs"] as const) {
      expect(() => resolveSseLimits({ [key]: 2_147_483_648 })).toThrow("native timer range");
    }
  });

  it("paces the initial replay behind an awaited listener without dropping its durable order", async () => {
    const h = await fixture(); await h.warnings(["one", "two", "three"]);
    const started = deferred(), release = deferred(), seen: number[] = [];
    cleanup.push(async () => { release.resolve(); });
    let returned = false;
    const subscribing = h.host.subscribe(owner, h.session.id, 0, async event => {
      seen.push((event as { seq: number }).seq);
      if (seen.length === 1) { started.resolve(); await release.promise; }
    }).then(close => { returned = true; return close; });
    await started.promise; expect(returned).toBe(false); expect(seen).toEqual([1]);
    release.resolve(); const close = await subscribing; cleanup.push(close);
    expect(seen).toEqual([1, 2, 3, 4]); await close(); expect(h.bus.removals).toBe(1);
  });

  it("fences a live burst during a hung read and waits for both real read and unsubscribe settlement", async () => {
    const h = await fixture({ maxQueuedEvents: 2 });
    const readEntered = deferred(), readGate = deferred(), removeGate = deferred(); h.bus.removeGate = removeGate.promise;
    const original = h.store.readEvents.bind(h.store);
    const reading = vi.spyOn(h.store, "readEvents").mockImplementation(async (...args) => {
      readEntered.resolve(); await readGate.promise; return original(...args);
    });
    cleanup.push(async () => { readGate.resolve(); removeGate.resolve(); });
    const ended = vi.fn(), seen: Event[] = []; let returned = false;
    const subscribing = h.host.subscribe(owner, h.session.id, 0, event => seen.push(event), { onClose: ended })
      .then(close => { returned = true; return close; });
    await readEntered.promise;
    for (let i = 0; i < 3; i++) await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: i });
    expect(ended).toHaveBeenCalledOnce(); expect(returned).toBe(false); expect(seen).toEqual([]);
    await vi.waitFor(() => expect(h.bus.removals).toBe(1));
    readGate.resolve(); await Promise.resolve(); expect(returned).toBe(false);
    removeGate.resolve(); const close = await subscribing; await close();
    expect(reading).toHaveBeenCalledOnce(); expect(h.bus.listeners.size).toBe(0); expect(seen).toEqual([]);
  });

  it("disposes a late subscription after cancellation and never reports its pending remove as closed", async () => {
    const h = await fixture(), attaching = deferred(), removing = deferred(), signal = new AbortController();
    h.bus.attachGate = attaching.promise; h.bus.removeGate = removing.promise;
    cleanup.push(async () => { attaching.resolve(); removing.resolve(); });
    const ended = vi.fn(), delivered = vi.fn(); let returned = false;
    const subscribing = h.host.subscribe(owner, h.session.id, 0, delivered, { signal: signal.signal, onClose: ended })
      .then(close => { returned = true; return close; });
    await h.bus.attachEntered.promise; signal.abort(); expect(returned).toBe(false); expect(ended).not.toHaveBeenCalled();
    attaching.resolve(); await vi.waitFor(() => expect(h.bus.removals).toBe(1)); expect(returned).toBe(false);
    removing.resolve(); const close = await subscribing; const first = close(); expect(close()).toBe(first); await first;
    expect(delivered).not.toHaveBeenCalled(); expect(h.bus.listeners.size).toBe(0); expect(h.bus.removals).toBe(1);
  });

  it("keeps the last triggering event until a temporarily failed durable gap is completely repaired", async () => {
    const h = await fixture(), seen: number[] = [];
    const close = await h.host.subscribe(owner, h.session.id, 1, event => seen.push((event as { seq: number }).seq)); cleanup.push(close);
    const events = (await h.warnings(["missing", "last"])).events;
    const original = h.store.readEvents.bind(h.store);
    vi.spyOn(h.store, "readEvents").mockRejectedValueOnce(new Error("transient one"))
      .mockRejectedValueOnce(new Error("transient two")).mockImplementation(original);
    await h.bus.publish(h.session.id, events[1]!);
    await vi.waitFor(() => expect(seen).toEqual([2, 3]));
    await close(); expect(h.bus.removals).toBe(1);
  });

  for (const recovery of ["gap", "reconnect"] as const) {
    it(`bounds the whole ${recovery} retry episode and clears its timers when the durable store stays unavailable`, async () => {
      const h = await fixture({ replayTimeoutMs: 100 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const ended = vi.fn(), close = await h.host.subscribe(owner, h.session.id, 1, () => {}, { onClose: ended }); cleanup.push(close);
      const entered = deferred(); vi.spyOn(h.store, "readEvents").mockImplementation(async () => { entered.resolve(); throw new Error("unavailable"); });
      let retry: void | Promise<void> = undefined;
      if (recovery === "gap") {
        await h.bus.publish(h.session.id, { type: "warning", seq: 3, sessionId: h.session.id, emittedAtMs: 1, code: "fixture", message: "last" });
      } else { retry = h.bus.reconnect!(); void Promise.resolve(retry).catch(() => {}); }
      await entered.promise; await vi.advanceTimersByTimeAsync(101);
      expect(ended).toHaveBeenCalledOnce(); await close(); await Promise.resolve(retry).catch(() => {});
      expect(h.bus.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("includes the processing event in the queue bound while its listener is blocked", async () => {
    const h = await fixture({ maxQueuedEvents: 2 }), entered = deferred(), release = deferred(), ended = vi.fn();
    cleanup.push(async () => { release.resolve(); });
    const close = await h.host.subscribe(owner, h.session.id, 1, async () => { entered.resolve(); await release.promise; }, { onClose: ended });
    cleanup.push(async () => { release.resolve(); await close(); });
    await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: 1 }); await entered.promise;
    await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: 2 }); expect(ended).not.toHaveBeenCalled();
    await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: 3 }); expect(ended).toHaveBeenCalledOnce();
    let disposed = false; const disposing = close().then(() => { disposed = true; }); await Promise.resolve(); expect(disposed).toBe(false);
    release.resolve(); await disposing; expect(h.bus.removals).toBe(1);
  });

  it("applies the queued-byte ceiling before the event-count ceiling, including the processing frame", async () => {
    const h = await fixture({ maxQueuedEvents: 100, maxQueuedBytes: 180, maxFrameBytes: 180 });
    const entered = deferred(), release = deferred(), ended = vi.fn();
    cleanup.push(async () => { release.resolve(); });
    const close = await h.host.subscribe(owner, h.session.id, 1, async () => { entered.resolve(); await release.promise; }, { onClose: ended });
    cleanup.push(async () => { release.resolve(); await close(); });
    await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: 1 });
    await entered.promise; expect(ended).not.toHaveBeenCalled();
    await h.bus.publish(h.session.id, { type: "heartbeat", sessionId: h.session.id, emittedAtMs: 2 });
    expect(ended).toHaveBeenCalledOnce(); release.resolve(); await close();
  });

  it("ends a replay below its first frame byte cost without sending a synthetic cursor", async () => {
    const h = await fixture({ maxReplayBytes: 1 }), delivered = vi.fn(), ended = vi.fn();
    const close = await h.host.subscribe(owner, h.session.id, 0, delivered, { onClose: ended });
    await close(); expect(ended).toHaveBeenCalledOnce(); expect(delivered).not.toHaveBeenCalled();
    expect((await h.store.readEvents(h.session.id, 0, 10)).map(event => event.seq)).toEqual([1]);
  });

  it("delivers finite durable prefixes whose explicit reconnects cover the complete history exactly once", async () => {
    const h = await fixture({ maxReplayEvents: 2 }); await h.warnings(["two", "three", "four", "five"]);
    const seen: number[] = []; let cursor = 0;
    for (let i = 0; i < 3; i++) {
      const close = await h.host.subscribe(owner, h.session.id, cursor, event => {
        const seq = (event as { seq: number }).seq; seen.push(seq); cursor = seq;
      });
      await close();
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]); expect(h.bus.removals).toBe(3);
  });

  it("closes an excluded-only prefix without inventing an id or exposing the excluded payload", async () => {
    const h = await fixture({ maxReplayEvents: 2 }), turnId = newId("turn");
    const usage: EventInput = { type: "usage/updated", sessionId: h.session.id, turnId, step: 1, emittedAtMs: 1,
      stepUsage: emptyUsage(), turnUsage: emptyUsage(), sessionUsage: emptyUsage(), runtime: { provider: "fake", model: "fake" } };
    // This is an observation-only read fixture. It does not pretend to establish usage/billing
    // facts or a real provider step merely to construct three adjacent excluded source rows.
    const rows: PersistedEvent[] = [2, 3, 4].map(seq => ({ ...usage, seq }));
    vi.spyOn(h.store, "readEvents").mockImplementation(async (_session, after, limit) => rows.filter(event => event.seq > after).slice(0, limit));
    const delivered = vi.fn(), ended = vi.fn();
    const close = await h.host.subscribe(owner, h.session.id, 1, delivered, { exclude: new Set(["usage/updated"]), onClose: ended });
    await close(); expect(ended).toHaveBeenCalledOnce(); expect(delivered).not.toHaveBeenCalled();
    // There is no client-visible cursor progress here. A client must stop reconnecting with the
    // same filter/cursor and change exclude or query durable state; EOF is not proof of catch-up.
    expect((await h.store.readEvents(h.session.id, 1, 10)).map(event => event.seq)).toEqual([2, 3, 4]);
  });

  it("counts UTF-8 frame bytes and stops an oversized excluded event without sending it", async () => {
    const h = await fixture({ maxFrameBytes: 256, maxQueuedBytes: 1_024 }), ended = vi.fn(), delivered = vi.fn();
    const close = await h.host.subscribe(owner, h.session.id, 1, delivered, { exclude: new Set(["warning"]), onClose: ended }); cleanup.push(close);
    await h.bus.publish(h.session.id, { type: "warning", seq: 2, sessionId: h.session.id, emittedAtMs: 1,
      code: "fixture", message: "中".repeat(60) });
    expect(ended).toHaveBeenCalledOnce(); await close(); expect(delivered).not.toHaveBeenCalled();
  });

  it("admits before new-turn or steer mutation and leaves exact receipt replay independent of stream admission", async () => {
    const h = await fixture(), request = { input: [{ type: "text" as const, text: "first" }], stream: true, metadata: {} };
    const denied = vi.fn(() => { throw new ApiError("quota_exceeded", "SSE observation limit reached"); });
    await expect(h.host.beginTurn(owner, h.session.id, request, { admitStream: denied })).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(denied).toHaveBeenCalledOnce(); expect(h.engine.received).toHaveLength(0);
    expect((await h.store.getSession(owner.tenantId, h.session.id))?.lastSeq).toBe(1);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(0);
    const begun = await h.host.beginTurn(owner, h.session.id, request, { idempotencyKey: "same-request" });
    const beforeSteer = (await h.store.getSession(owner.tenantId, h.session.id))!.lastSeq;
    await expect(h.host.beginTurn(owner, h.session.id, { ...request, input: [{ type: "text", text: "steer" }] }, { admitStream: denied }))
      .rejects.toMatchObject({ code: "quota_exceeded" });
    expect((await h.store.getSession(owner.tenantId, h.session.id))?.lastSeq).toBe(beforeSteer);
    const replayInProgress = await h.host.beginTurn(owner, h.session.id, request, { idempotencyKey: "same-request", admitStream: denied });
    expect(replayInProgress.replayed).toBe(true); expect(denied).toHaveBeenCalledTimes(2);
    begun.run(); await vi.waitFor(async () => expect((await h.store.getTurn(h.session.id, begun.turn.id))?.status).toBe("completed"));
    const replay = await h.host.beginTurn(owner, h.session.id, request, { idempotencyKey: "same-request", admitStream: denied });
    expect(replay.replayed).toBe(true); expect(denied).toHaveBeenCalledTimes(2); expect(h.engine.received).toHaveLength(1);
  });
});
