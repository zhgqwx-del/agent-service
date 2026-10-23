import { memoryAuthorityStore } from "./session-authority-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, type Principal } from "@agent-service/protocol";
import { MemoryEventBus } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type AgentEngine, type ProviderResolver, type ResolvedModel } from "../src/index.js";
import { ScriptedEngine } from "./fake-engine.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  // Release controlled native substitutes before joining the owning runtime, including on assertion failure.
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const owner: Principal = { tenantId: "shutdown-tenant", userId: "shutdown-user" };
const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 32_000,
  input: ["text"], apiKey: async () => "synthetic-only" };
async function fixture(providers: ProviderResolver = { resolve: async () => model }, suppliedEngine?: AgentEngine) {
  const store = memoryAuthorityStore(), lease = store.sessionAuthority, bus = new MemoryEventBus();
  const engine = new ScriptedEngine([{ text: "must not be dispatched during preflight shutdown" }]);
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "shutdown",
    instructions: "", model: { provider: "fake", model: "fake" }, tools: [], mcpServers: [], skills: [], limits: {},
    approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const host = new SessionHost({ store, lease, bus, engine: suppliedEngine ?? engine, providers,
    tools: new StaticToolRegistry([]), config: { runnerId: "shutdown-runner", runnerAddr: "127.0.0.1:1",
      leaseTtlMs: 90, leaseHoldMs: 1 }, logger: { info() {}, warn() {}, error() {} } });
  const session = await host.createSession(owner, { agentId: agent.id, metadata: {} });
  let expectedSettlement: { reason: unknown } | undefined;
  cleanup.push(async () => {
    let failure: { reason: unknown } | undefined;
    try { await host.drain(0); } catch (reason) { failure = { reason }; }
    try { await host.settle(); } catch (reason) {
      if (!expectedSettlement || reason !== expectedSettlement.reason) failure ??= { reason };
    }
    const closed = await Promise.allSettled([bus.close(), store.close()]);
    for (const result of closed) if (result.status === "rejected") failure ??= { reason: result.reason };
    if (failure) throw failure.reason;
  });
  return { store, lease, bus, engine, host, session,
    allowAssertedSettlementFailure: (reason: unknown) => { expectedSettlement = { reason }; } };
}
const input = { input: [{ type: "text" as const, text: "synthetic" }], stream: false, metadata: {} };

describe("Host process-owner final settlement", () => {
  it("clears its abort-observation timer when an idle host finishes draining immediately", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await fixture();
    expect(vi.getTimerCount()).toBe(0);
    await h.host.drain(30_000);
    // Finishing a bounded observation owns and clears its losing timer; process close must
    // not need the whole ten-second deadline after there is no remaining Host work.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks the first control read before a start enters the serialisation queue", async () => {
    const h = await fixture(), entered = gate(), release = gate(); cleanup.push(async () => release.resolve());
    const original = h.store.getSubagentSessionMember.bind(h.store);
    vi.spyOn(h.store, "getSubagentSessionMember").mockImplementationOnce(async args => {
      entered.resolve(); await release.promise; return original(args);
    });
    const beginning = h.host.beginTurn(owner, h.session.id, input); void beginning.catch(() => {});
    await entered.promise; await h.host.drain(0);
    const closing = h.host.settle(); expect(h.host.settle()).toBe(closing);
    let settled = false; void closing.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); await expect(beginning).rejects.toMatchObject({ code: "draining" }); await closing;
    expect(h.engine.received).toHaveLength(0);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(0);
    await expect(h.host.beginTurn(owner, h.session.id, input)).rejects.toMatchObject({ code: "draining" });
  });

  it("joins original provider work even after guard loss has already rejected beginTurn", async () => {
    const entered = gate(), release = gate();
    const h = await fixture({ resolve: async () => { entered.resolve(); await release.promise; return model; } });
    cleanup.push(async () => release.resolve());
    vi.spyOn(h.lease, "renew").mockResolvedValue(false);
    const beginning = h.host.beginTurn(owner, h.session.id, input); void beginning.catch(() => {});
    await entered.promise; await expect(beginning).rejects.toMatchObject({ code: "session_lease_conflict" });
    await h.host.drain(0);
    let settled = false; const closing = h.host.settle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); await closing;
    expect(h.engine.received).toHaveLength(0);
    // A lost proof is not released early. The genuine authority lease expires on the store clock.
    await vi.waitFor(async () => expect(await h.lease.getOwner(h.session.id)).toBeNull());
  });

  it("tracks an explicit compaction before its first control read returns", async () => {
    const h = await fixture(), entered = gate(), release = gate(); cleanup.push(async () => release.resolve());
    const original = h.store.getSubagentSessionMember.bind(h.store);
    vi.spyOn(h.store, "getSubagentSessionMember").mockImplementationOnce(async args => {
      entered.resolve(); await release.promise; return original(args);
    });
    const compacting = h.host.compactSession(owner, h.session.id); void compacting.catch(() => {});
    await entered.promise; await h.host.drain(0);
    let settled = false; const closing = h.host.settle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); await expect(compacting).rejects.toMatchObject({ code: "draining" }); await closing;
    expect(h.engine.received).toHaveLength(0);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(0);
  });

  it("retains a renewal already in flight after preflight finally stops its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const providerEntered = gate(), providerRelease = gate(), renewalEntered = gate(), renewalRelease = gate();
    const h = await fixture({ resolve: async () => { providerEntered.resolve(); await providerRelease.promise; return model; } });
    cleanup.push(async () => { providerRelease.resolve(); renewalRelease.resolve(); });
    vi.spyOn(h.lease, "renew").mockImplementation(async () => { renewalEntered.resolve(); await renewalRelease.promise; return false; });
    const beginning = h.host.beginTurn(owner, h.session.id, input); void beginning.catch(() => {});
    await providerEntered.promise; await vi.advanceTimersByTimeAsync(30); await renewalEntered.promise; await h.host.drain(0);
    let settled = false; const closing = h.host.settle().then(() => { settled = true; });
    let beginningSettled = false;
    void beginning.then(() => { beginningSettled = true; }, () => { beginningSettled = true; });
    providerRelease.resolve();
    // Join this event-loop turn so preflight actually reaches its original release finally;
    // one microtask is not a receipt that guard.stop has run before the held renewal returns.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((h.host as unknown as { leaseGuards: Set<unknown> }).leaseGuards.size).toBe(0);
    // The authority protocol must join a genuinely pending renewal before releasing this proof.
    // Logical request cancellation is not permission to release or mark the process settled.
    expect(beginningSettled).toBe(false); expect(settled).toBe(false);
    renewalRelease.resolve(); await expect(beginning).rejects.toMatchObject({ code: "draining" });
    await closing; expect(h.engine.received).toHaveLength(0);
  });

  it("keeps the old bounded drain contract while final settlement waits for actual engine completion", async () => {
    const started = gate(), finish = gate(); let aborted = false;
    const engine: AgentEngine = { name: "held-native-substitute", start(params) {
      const onAbort = () => { aborted = true; }; params.signal.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      return { steer() {}, interrupt() { aborted = true; }, done: finish.promise.then(() => {
        params.signal.removeEventListener("abort", onAbort); return { steps: 0, aborted };
      }) };
    } };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await fixture(undefined, engine); cleanup.push(async () => finish.resolve());
    const begun = await h.host.beginTurn(owner, h.session.id, input); begun.run(); await started.promise;
    const draining = h.host.drain(0);
    await vi.advanceTimersByTimeAsync(10_001); await draining; expect(aborted).toBe(true);
    let settled = false; const closing = h.host.settle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    finish.resolve(); await closing; vi.useRealTimers();
    expect(await h.store.getTurn(h.session.id, begun.turn.id)).toMatchObject({ status: "interrupted" });
  });

  it("reports a late shutdown lease-release rejection after the actual engine finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = gate(), finish = gate();
    const engine: AgentEngine = { name: "late-release-substitute", start() {
      started.resolve(); return { steer() {}, interrupt() {}, done: finish.promise.then(() => ({ steps: 0, aborted: true })) };
    } };
    const h = await fixture(undefined, engine); cleanup.push(async () => finish.resolve());
    const begun = await h.host.beginTurn(owner, h.session.id, input); begun.run(); await started.promise;
    const draining = h.host.drain(0); await vi.advanceTimersByTimeAsync(10_001); await draining;
    const failure = new Error("synthetic late lease release failure");
    const release = vi.spyOn(h.lease, "release").mockRejectedValueOnce(failure);
    const closing = h.host.settle(); void closing.catch(() => {});
    finish.resolve(); await expect(closing).rejects.toBe(failure); h.allowAssertedSettlementFailure(failure);
    expect(release).toHaveBeenCalledOnce();
    expect(await h.store.getTurn(h.session.id, begun.turn.id)).toMatchObject({ status: "interrupted" });
    vi.useRealTimers();
  });

});
