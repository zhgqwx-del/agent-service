import { afterEach, describe, expect, it } from "vitest";
import { ApiError, emptyUsage, type AgentDefinition, type Event, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import {
  SessionHost,
  StaticToolRegistry,
  newId,
  projectItems,
  type ProviderResolver,
  type ResolvedModel,
  type RunnerTool,
  type SessionHostDeps,
  type Summariser,
} from "../src/index.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

const principal: Principal = { tenantId: "t_a", userId: "u_1" };
const fakeModel: ResolvedModel = { handle: {}, provider: "fake", model: "fake-1", contextWindow: 32_000, apiKey: async () => "k" };
const providers: ProviderResolver = { resolve: async () => fakeModel };

const echoTool: RunnerTool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  kind: "builtin",
  readOnly: true,
  execute: async (args) => ({ content: [{ type: "text", text: `echo:${(args as { text: string }).text}` }] }),
};
const dangerousTool: RunnerTool = { ...echoTool, name: "danger", readOnly: false, needsApproval: true };
const slowTool: RunnerTool = {
  ...echoTool,
  name: "slow",
  execute: async (_a, ctx) => {
    await new Promise((r) => setTimeout(r, 300));
    return { content: [{ type: "text", text: ctx.signal.aborted ? "aborted" : "slow-done" }] };
  },
};

/** Every host a test creates, so timers and subscriptions cannot outlive it. */
const created: { host: SessionHost; unsub: () => void }[] = [];
afterEach(async () => {
  for (const { host, unsub } of created.splice(0)) {
    unsub();
    await host.drain(1_000).catch(() => {});
  }
});

interface SetupExtras {
  lease?: MemoryLeaseStore;
  bus?: MemoryEventBus;
  providers?: ProviderResolver;
  summariser?: Summariser;
}

async function setup(script: ScriptStep[], agentPatch: Partial<AgentDefinition> = {}, cfg: Partial<SessionHostDeps["config"]> = {}, extras: SetupExtras = {}) {
  const store = new MemorySessionStore();
  const lease = extras.lease ?? new MemoryLeaseStore();
  const bus = extras.bus ?? new MemoryEventBus();
  const engine = new ScriptedEngine(script);
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: "t_a", version: 1, name: "test", instructions: "You are a test agent.",
    model: { provider: "fake", model: "fake-1" }, tools: ["echo", "danger", "slow"], mcpServers: [], skills: [],
    limits: {}, approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
    ...agentPatch,
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store, lease, bus, engine, providers: extras.providers ?? providers, summariser: extras.summariser,
    tools: new StaticToolRegistry([echoTool, dangerousTool, slowTool]),
    config: { runnerId: "r1", runnerAddr: "127.0.0.1:1", leaseTtlMs: 2000, leaseHoldMs: 50, approvalTtlMs: 5000, ...cfg },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  const events: Event[] = [];
  const unsub = await host.subscribe(principal, session.id, 0, (e) => events.push(e));
  created.push({ host, unsub });
  return { store, lease, bus, engine, agent, host, session, events, unsub };
}

const waitIdle = async (h: { store: MemorySessionStore; session: { id: string } }, timeoutMs = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await h.store.getSession("t_a", h.session.id);
    if (s?.status.type === "idle" && (await h.store.listTurns(h.session.id, { limit: 1 })).data[0]?.status !== "inProgress") return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("turn did not finish");
};

class CountingLeaseStore extends MemoryLeaseStore {
  renewCalls = 0;

  override async renew(sessionId: string, ownerId: string, ttlMs: number) {
    this.renewCalls += 1;
    return super.renew(sessionId, ownerId, ttlMs);
  }
}

class FailingRenewLeaseStore extends MemoryLeaseStore {
  renewCalls = 0;

  override async renew(_sessionId: string, _ownerId: string, _ttlMs: number) {
    this.renewCalls += 1;
    return false;
  }
}

class DroppingEventBus extends MemoryEventBus {
  dropNextPersisted = false;

  override async publish(sessionId: string, event: Event) {
    if (this.dropNextPersisted && typeof (event as { seq?: number }).seq === "number") {
      this.dropNextPersisted = false;
      return;
    }
    return super.publish(sessionId, event);
  }
}

describe("SessionHost", () => {
  it("runs a multi-step turn: text → tool → final; events are contiguous and items replayable", async () => {
    const h = await setup([
      { text: "let me check", toolCalls: [{ name: "echo", args: { text: "a" } }, { name: "echo", args: { text: "b" } }] },
      { text: "done: a b" },
    ]);
    const { turn } = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "hi" }], stream: true, metadata: {} });
    const s = await waitIdle(h);
    const t = (await h.store.getTurn(h.session.id, turn.id))!;
    expect(t.status).toBe("completed");
    expect(t.stopReason).toBe("end_turn");
    expect(t.steps).toBe(2);
    expect(t.toolCalls).toBe(2);
    expect(t.usage.totalTokens).toBe(30);
    expect(s.usage.totalTokens).toBe(30);

    const persisted = h.events.filter((e) => typeof (e as { seq?: number }).seq === "number").map((e) => (e as { seq: number }).seq);
    expect(persisted).toEqual(Array.from({ length: persisted.length }, (_, i) => i + 1));
    const types = h.events.map((e) => e.type);
    expect(types[0]).toBe("session/created");
    expect(types).toContain("turn/started");
    expect(types).toContain("item/agentMessage/delta");
    expect(types.filter((x) => x === "usage/updated")).toHaveLength(2);
    expect(types.at(-1)).toBe("session/status/changed");
    expect(types.at(-2)).toBe("turn/completed");

    const items = await h.store.listItems(h.session.id, { limit: 100 });
    expect(items.map((i) => i.type)).toEqual(["userMessage", "agentMessage", "toolCall", "toolCall", "toolResult", "toolResult", "agentMessage"]);
    expect(items.every((i) => i.seq > 0)).toBe(true);
    const projected = projectItems(items);
    expect(projected.repaired).toEqual([]);
    expect(projected.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant"]);
    const first = projected.messages[1]!;
    expect(first.role).toBe("assistant");
    expect(first.role === "assistant" ? first.toolCalls.length : 0).toBe(2);
    h.unsub();
  });

  it("second turn sees the first turn's history in the engine transcript", async () => {
    const h = await setup([{ text: "one" }, { text: "two" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "first" }], stream: true, metadata: {} });
    await waitIdle(h);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "second" }], stream: true, metadata: {} });
    await waitIdle(h);
    const second = h.engine.received[1]!;
    expect(second.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(second.input[0]).toEqual({ type: "text", text: "second" });
    expect(second.systemPrompt).toBe("You are a test agent.");
  });

  it("gates tools behind approvals: accept, decline and cancel", async () => {
    // accept
    let h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "ok" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    let approval = await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    const a = (approval as Extract<Event, { type: "approval/requested" }>).approval;
    expect((await h.store.getSession("t_a", h.session.id))?.status).toMatchObject({ type: "active", activeFlags: ["waitingOnApproval"] });
    const resolved = await h.host.resolveApproval(principal, h.session.id, a.id, "accept");
    expect(resolved.status).toBe("resolved");
    await waitIdle(h);
    let items = await h.store.listItems(h.session.id, { limit: 100 });
    expect(items.find((i) => i.type === "toolResult")).toMatchObject({ isError: false });
    expect((await h.store.getTurn(h.session.id, h.host.activeTurn(h.session.id)?.id ?? (await h.store.listTurns(h.session.id, { limit: 1 })).data[0]!.id))?.status).toBe("completed");

    // decline: tool result is an error, turn continues to the next step
    h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "declined-but-continued" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    approval = await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    await h.host.resolveApproval(principal, h.session.id, (approval as Extract<Event, { type: "approval/requested" }>).approval.id, "decline");
    await waitIdle(h);
    items = await h.store.listItems(h.session.id, { limit: 100 });
    expect(items.find((i) => i.type === "toolResult")).toMatchObject({ isError: true });
    expect(items.find((i) => i.type === "toolCall")?.status).toBe("declined");
    expect(items.filter((i) => i.type === "agentMessage").at(-1)).toMatchObject({ text: "declined-but-continued" });

    // cancel: turn is interrupted
    h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "never" }]);
    const { turn } = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    approval = await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    await h.host.resolveApproval(principal, h.session.id, (approval as Extract<Event, { type: "approval/requested" }>).approval.id, "cancel");
    await waitIdle(h);
    expect((await h.store.getTurn(h.session.id, turn.id))?.status).toBe("interrupted");
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some((i) => i.type === "agentMessage" && i.text === "never")).toBe(false);
  });

  it("acceptForSession auto-approves the tool for later turns", async () => {
    const h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "1" } }] }, { text: "ok" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    const approval = await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    await h.host.resolveApproval(principal, h.session.id, (approval as Extract<Event, { type: "approval/requested" }>).approval.id, "acceptForSession");
    await waitIdle(h);
    h.events.length = 0;
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "again" }], stream: true, metadata: {} });
    await waitIdle(h);
    expect(h.events.some((e) => e.type === "approval/requested")).toBe(false);
    expect((await h.store.listApprovals(h.session.id, {})).length).toBe(1);
  });

  it("approval times out to decline", async () => {
    const h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "after" }], {}, { approvalTtlMs: 150 });
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    const ap = (await h.store.listApprovals(h.session.id, {}))[0]!;
    expect(ap.status).toBe("expired");
    expect(ap.decision).toBe("decline");
  });

  it("enforces maxSteps and maxToolCalls (policy can only tighten)", async () => {
    let h = await setup(Array.from({ length: 5 }, (_, i) => ({ text: `s${i}`, toolCalls: [{ name: "echo", args: { text: "x" } }] })), { limits: { maxSteps: 10 } });
    let r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {}, limits: { maxSteps: 2 } });
    await waitIdle(h);
    let t = (await h.store.getTurn(h.session.id, r.turn.id))!;
    expect(t.status).toBe("completed");
    expect(t.stopReason).toBe("max_steps");
    expect(t.steps).toBe(2);
    expect(t.partialText).toBe("s1");

    h = await setup([{ text: "", toolCalls: [{ name: "echo", args: { text: "1" } }, { name: "echo", args: { text: "2" } }, { name: "echo", args: { text: "3" } }] }, { text: "no" }], { limits: { maxToolCalls: 2 } });
    r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    t = (await h.store.getTurn(h.session.id, r.turn.id))!;
    expect(t.stopReason).toBe("max_tool_calls");
    const results = (await h.store.listItems(h.session.id, { limit: 100 })).filter((i) => i.type === "toolResult");
    expect(results.filter((i) => i.type === "toolResult" && !i.isError)).toHaveLength(2);
  });

  it("enforces maxCostCNY and wall clock", async () => {
    let h = await setup([{ text: "a", toolCalls: [{ name: "echo", args: { text: "x" } }], usage: { costCNY: 5 } }, { text: "b" }], { limits: { maxCostCNY: 1 } });
    let r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    expect((await h.store.getTurn(h.session.id, r.turn.id))?.stopReason).toBe("max_cost");

    h = await setup([{ text: "slow", delayMs: 500 }, { text: "b" }], { limits: { maxWallClockMs: 100 } });
    r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    expect((await h.store.getTurn(h.session.id, r.turn.id))?.stopReason).toBe("max_wall_clock");
  });

  it("interrupt ends the turn as interrupted and keeps partial text", async () => {
    const h = await setup([{ text: "partial answer", toolCalls: [{ name: "slow", args: { text: "x" } }] }, { text: "never" }]);
    const r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitFor(() => h.events.find((e) => e.type === "item/started" && e.item.type === "toolCall"));
    const t = await h.host.interrupt(principal, h.session.id, r.turn.id);
    expect(t.status).toBe("interrupted");
    expect(t.partialText).toBe("partial answer");
    expect((await h.store.getSession("t_a", h.session.id))?.status.type).toBe("idle");
  });

  it("steer persists the user message and busyPolicy=steer folds a second request into the running turn", async () => {
    const h = await setup([{ text: "thinking", toolCalls: [{ name: "slow", args: { text: "x" } }] }, { text: "final" }]);
    const first = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    const second = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "also this" }], stream: true, metadata: {} });
    expect(second.steered).toBe(true);
    expect(second.turn.id).toBe(first.turn.id);
    await waitIdle(h);
    expect(h.engine.steers).toHaveLength(1);
    expect(h.events.some((e) => e.type === "turn/steered")).toBe(true);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).filter((i) => i.type === "userMessage")).toHaveLength(2);
  });

  it("concurrent startTurn on the SAME runner must not create two turns", async () => {
    // The lease cannot protect here: both calls are the same owner and get the same fence.
    const h = await setup([{ text: "x", delayMs: 300 }], { busyPolicy: "reject" });
    const results = await Promise.allSettled([
      h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "a" }], stream: true, metadata: {} }),
      h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "b" }], stream: true, metadata: {} }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "session_busy" });
    await waitIdle(h);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(1);
    // one user message, not two
    expect((await h.store.listItems(h.session.id, { limit: 100 })).filter((i) => i.type === "userMessage")).toHaveLength(1);
  });

  it("concurrent startTurn with busyPolicy=steer folds the second into the first turn", async () => {
    const h = await setup([{ text: "x", delayMs: 300 }, { text: "y" }]);
    const [a, b] = await Promise.all([
      h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "a" }], stream: true, metadata: {} }),
      h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "b" }], stream: true, metadata: {} }),
    ]);
    expect(new Set([a.turn.id, b.turn.id]).size).toBe(1);
    expect(a.steered === true || b.steered === true).toBe(true);
    await waitIdle(h);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(1);
  });

  it("renews the lease throughout preflight and fails fast if renewal is lost", async () => {
    const lease = new CountingLeaseStore();
    let resolveProvider!: (model: ResolvedModel) => void;
    const providerGate = new Promise<ResolvedModel>((resolve) => {
      resolveProvider = resolve;
    });
    const slowProviders: ProviderResolver = { resolve: () => providerGate };
    let h = await setup([{ text: "ok" }], {}, { leaseTtlMs: 120 }, { lease, providers: slowProviders });

    const begunPromise = h.host.beginTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    // Four renewals put the preflight beyond the original TTL. It must still own the lease.
    await waitFor(() => (lease.renewCalls >= 4 ? true : undefined), 2000);
    expect((await lease.getOwner(h.session.id))?.ownerId).toBe("r1");
    resolveProvider(fakeModel);
    const begun = await begunPromise;
    begun.run();
    await waitIdle(h);

    const failingLease = new FailingRenewLeaseStore();
    const blockedProviders: ProviderResolver = { resolve: () => new Promise<ResolvedModel>(() => {}) };
    h = await setup([{ text: "never" }], {}, { leaseTtlMs: 90 }, { lease: failingLease, providers: blockedProviders });
    await expect(h.host.beginTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} })).rejects.toMatchObject({ code: "session_lease_conflict" });
    expect(failingLease.renewCalls).toBeGreaterThan(0);
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(0);
  });

  it("serialises explicit compaction with turn start, renews it, publishes it, and returns the summary id", async () => {
    const lease = new CountingLeaseStore();
    let markSummaryStarted!: () => void;
    let releaseSummary!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summariser: Summariser = {
      summarise: async () => {
        markSummaryStarted();
        await summaryGate;
        return { text: "summary of earlier turns", usage: emptyUsage() };
      },
    };
    const h = await setup([{ text: "answer ".repeat(200) }], {}, { leaseTtlMs: 120 }, { lease, summariser });
    for (let i = 0; i < 3; i++) {
      await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: `question ${i} ${"detail ".repeat(200)}` }], stream: true, metadata: {} });
      await waitIdle(h);
    }
    h.events.length = 0;

    const compactPromise = h.host.compactSession(principal, h.session.id);
    await summaryStarted;
    const compactionRenewBaseline = lease.renewCalls;
    let begunSettled = false;
    const begunPromise = h.host
      .beginTurn(principal, h.session.id, { input: [{ type: "text", text: "after compaction" }], stream: true, metadata: {} })
      .then((begun) => {
        begunSettled = true;
        return begun;
      });
    try {
      await waitFor(() => (lease.renewCalls >= compactionRenewBaseline + 4 ? true : undefined), 2000);
      expect((await lease.getOwner(h.session.id))?.ownerId).toBe("r1");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(begunSettled).toBe(false);
    } finally {
      releaseSummary();
    }

    const compacted = await compactPromise;
    expect(compacted.compacted).toBe(true);
    expect(compacted.summaryItemId).toEqual(expect.any(String));
    const summaryItem = (await h.store.listItems(h.session.id, { limit: 100 })).find((item) => item.id === compacted.summaryItemId);
    expect(summaryItem).toMatchObject({ type: "contextCompaction", summary: "summary of earlier turns" });
    await waitFor(() => (h.events.some((event) => event.type === "session/compacted" && event.itemId === compacted.summaryItemId) ? true : undefined));
    expect(h.events.some((event) => event.type === "item/completed" && event.item.id === compacted.summaryItemId)).toBe(true);

    const begun = await begunPromise;
    begun.run();
    await waitIdle(h);
  });

  it("busyPolicy=reject returns session_busy", async () => {
    const h = await setup([{ text: "x", delayMs: 300 }], { busyPolicy: "reject" });
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await expect(h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "again" }], stream: true, metadata: {} })).rejects.toMatchObject({ code: "session_busy" });
    await waitIdle(h);
  });

  it("refuses to run when another runner holds the lease; takes over an orphaned turn once the lease expires", async () => {
    const h = await setup([{ text: "ok" }]);
    await h.lease.acquire(h.session.id, "other-runner", "10.0.0.2:1", 60_000);
    await expect(h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} })).rejects.toMatchObject({ code: "session_lease_conflict" });
    // simulate the other runner dying mid-turn: status active in the store, lease expired
    const orphanTurnId = newId("turn");
    await h.store.commit({
      sessionId: h.session.id, fence: 1,
      turn: { id: orphanTurnId, sessionId: h.session.id, status: "inProgress", seqStart: 2, steps: 1, toolCalls: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }, startedAtMs: 1 },
      sessionPatch: { status: { type: "active", turnId: orphanTurnId, activeFlags: [] } },
    });
    h.lease.expire(h.session.id);
    const r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    expect((await h.store.getTurn(h.session.id, orphanTurnId))?.status).toBe("interrupted");
    expect((await h.store.getTurn(h.session.id, r.turn.id))?.status).toBe("completed");
    // the old runner's fence (1) is now stale
    await expect(h.store.commit({ sessionId: h.session.id, fence: 1, events: [{ type: "session/created", sessionId: h.session.id, emittedAtMs: 1 }] })).rejects.toThrow(/stale fence/);
  });

  it("cross-tenant access is not found", async () => {
    const h = await setup([{ text: "ok" }]);
    await expect(h.host.startTurn({ tenantId: "t_b", userId: "u_9" }, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.host.getSession({ tenantId: "t_b", userId: "u_9" }, h.session.id)).rejects.toBeInstanceOf(ApiError);
  });

  it("provider error fails the turn with an error event", async () => {
    const h = await setup([{ stopReason: "error", errorMessage: "429 rate limited" }]);
    const r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    const t = (await h.store.getTurn(h.session.id, r.turn.id))!;
    expect(t.status).toBe("failed");
    expect(t.error?.message).toContain("429");
    expect(h.events.some((e) => e.type === "error")).toBe(true);
  });

  it("replays events after a seq without duplicates or gaps and excludes filtered types", async () => {
    const h = await setup([{ text: "hello world" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    const all = h.events.filter((e) => typeof (e as { seq?: number }).seq === "number") as { seq: number }[];
    const replayed: Event[] = [];
    const unsub = await h.host.subscribe(principal, h.session.id, 3, (e) => replayed.push(e), { exclude: new Set(["usage/updated"]) });
    unsub();
    const seqs = replayed.map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual(all.map((e) => e.seq).filter((s) => s > 3).filter((s) => all.find((e) => e.seq === s && (e as unknown as Event).type !== "usage/updated")));
    expect(replayed.some((e) => e.type === "usage/updated")).toBe(false);
    expect(replayed.some((e) => e.type === "item/agentMessage/delta")).toBe(false); // deltas are never replayed
  });

  it("backfills a persisted seq gap observed by a live subscriber", async () => {
    const bus = new DroppingEventBus();
    const h = await setup([{ text: "hello" }], {}, {}, { bus });
    bus.dropNextPersisted = true;
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);

    const stored = await h.store.readEvents(h.session.id, 0, 100);
    await waitFor(
      () => (h.events.filter((event) => typeof (event as { seq?: number }).seq === "number").length === stored.length ? true : undefined),
      3000,
    );
    const deliveredSeqs = h.events
      .filter((event) => typeof (event as { seq?: number }).seq === "number")
      .map((event) => (event as { seq: number }).seq);
    expect(deliveredSeqs).toEqual(stored.map((event) => event.seq));
  });

  it("stops the turn when the lease is taken over mid-turn (fence loss must not keep stepping)", async () => {
    // Regression: a rejected commit used to propagate into the engine without setting any stop state,
    // so a stale owner kept calling the model and re-running tools.
    const h = await setup([
      { text: "step1", toolCalls: [{ name: "slow", args: { text: "a" } }] },
      { text: "step2", toolCalls: [{ name: "echo", args: { text: "b" } }] },
      { text: "step3" },
    ]);
    const r = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitFor(() => h.events.find((e) => e.type === "item/started" && e.item.type === "toolCall"));
    // another runner takes over: the lease moves and the fence advances
    h.lease.expire(h.session.id);
    const taken = await h.lease.acquire(h.session.id, "runner-2", "10.0.0.9:1", 60_000);
    expect(taken.ok).toBe(true);
    await h.store.commit({ sessionId: h.session.id, fence: (taken as { fence: number }).fence, sessionPatch: { title: "taken" } });

    await waitFor(() => (h.host as unknown as { active: Map<string, unknown> }).active.size === 0 ? true : undefined, 8000);
    const calls = await h.store.listItems(h.session.id, { limit: 100 });
    // the second step's tool must never have run
    expect(calls.filter((i) => i.type === "toolCall" && i.name === "echo")).toHaveLength(0);
    expect(h.engine.received).toHaveLength(1);
    const turn = await h.store.getTurn(h.session.id, r.turn.id);
    // the row stays as the old owner left it; the next owner repairs it (asserted below)
    expect(turn?.status === "inProgress" || turn?.status === "failed").toBe(true);
  });

  it("drain() does not wait for a pending approval", async () => {
    // Regression: the approval promise ignored the abort signal, so drain blocked for approvalTtlMs.
    const h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "after" }], {}, { approvalTtlMs: 60_000 });
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    const t0 = Date.now();
    await h.host.drain(500);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect((await h.store.getTurn(h.session.id, (await h.store.listTurns(h.session.id, { limit: 1 })).data[0]!.id))?.status).toBe("interrupted");
  });

  it("write-ahead marks a tool as started only after approval, so recovery says NOT_STARTED", async () => {
    // pi emits tool_execution_start BEFORE the approval gate; if we persisted startedAtMs there, a
    // crash while waiting for approval would tell the model the side effect may already have happened.
    const h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "after" }], {}, { approvalTtlMs: 60_000 });
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    const pendingCall = (await h.store.listItems(h.session.id, { limit: 100 })).find((i) => i.type === "toolCall");
    expect(pendingCall && pendingCall.type === "toolCall" && pendingCall.startedAtMs).toBeUndefined();
    const projected = projectItems(await h.store.listItems(h.session.id, { limit: 100 }));
    expect(projected.repaired).toEqual([{ toolCallId: expect.any(String), code: "TOOL_NOT_STARTED" }]);
    await h.host.drain(500);
  });

  it("publishes deltas after their item/started and keeps one seq for the streamed message", async () => {
    const h = await setup([{ text: "hello world this is streamed" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitIdle(h);
    const firstDelta = h.events.findIndex((e) => e.type === "item/agentMessage/delta");
    const started = h.events.findIndex((e) => e.type === "item/started" && e.item.type === "agentMessage");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(firstDelta);
    const deltaItemId = (h.events[firstDelta] as Extract<Event, { type: "item/agentMessage/delta" }>).itemId;
    const startedItem = (h.events[started] as Extract<Event, { type: "item/started" }>).item;
    expect(deltaItemId).toBe(startedItem.id);
    // the same item keeps its seq when completed, so `?afterSeq=` cannot skip the final text
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    const msg = items.filter((i) => i.type === "agentMessage");
    expect(msg).toHaveLength(1);
    expect(msg[0]!.seq).toBe(startedItem.seq);
    expect((await h.store.listItems(h.session.id, { afterSeq: startedItem.seq - 1, limit: 100 })).map((i) => i.id)).toContain(startedItem.id);
  });

  it("a deleted session stops its running turn instead of writing on", async () => {
    const h = await setup([{ text: "a", toolCalls: [{ name: "slow", args: { text: "x" } }] }, { text: "b" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    await waitFor(() => h.events.find((e) => e.type === "item/started" && e.item.type === "toolCall"));
    expect(await h.store.deleteSession("t_a", h.session.id)).toBe(true);
    await waitFor(() => ((h.host as unknown as { active: Map<string, unknown> }).active.size === 0 ? true : undefined), 8000);
    expect(h.engine.received).toHaveLength(1); // never advanced to the second step
  });
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting");
}
