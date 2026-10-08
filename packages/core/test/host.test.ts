import { afterEach, describe, expect, it } from "vitest";
import { addUsage, ApiError, emptyUsage, type AgentDefinition, type Approval, type Event, type Item, type Principal, type Turn, type Usage } from "@agent-service/protocol";
import { FenceError, IdempotencyPendingError, MemoryEventBus, MemoryLeaseStore, MemorySessionStore, SessionVersionError, type CommitBatch } from "@agent-service/store";
import {
  SessionHost,
  StaticToolRegistry,
  newId,
  projectItems,
  sha256,
  stableStringify,
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
  store?: MemorySessionStore;
  lease?: MemoryLeaseStore;
  bus?: MemoryEventBus;
  providers?: ProviderResolver;
  summariser?: Summariser;
}

async function setup(script: ScriptStep[], agentPatch: Partial<AgentDefinition> = {}, cfg: Partial<SessionHostDeps["config"]> = {}, extras: SetupExtras = {}) {
  const store = extras.store ?? new MemorySessionStore();
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

class RecordingStore extends MemorySessionStore {
  commits: CommitBatch[] = [];

  override async commit(batch: CommitBatch) {
    this.commits.push(structuredClone(batch));
    return super.commit(batch);
  }
}

class FailingCompactionStore extends MemorySessionStore {
  override async commit(batch: CommitBatch) {
    if (batch.items?.some((item) => item.type === "contextCompaction")) throw new Error("injected compaction write failure");
    return super.commit(batch);
  }
}

class LifecycleFenceStore extends MemorySessionStore {
  override async commit(batch: CommitBatch) {
    if (batch.lifecycle) throw new FenceError(batch.sessionId, batch.fence, batch.fence + 1);
    return super.commit(batch);
  }
}

class ChangedOwnerLeaseStore extends MemoryLeaseStore {
  override async getOwner(_sessionId: string) {
    return { ownerId: "runner-new", ownerAddr: "127.0.0.1:9999", fence: 2 };
  }
}

class AmbiguousIdempotencyStore extends MemorySessionStore {
  failOnce = true;

  override async commit(batch: CommitBatch) {
    const result = await super.commit(batch);
    if (batch.idempotency && this.failOnce) {
      this.failOnce = false;
      throw new Error("injected lost commit acknowledgement");
    }
    return result;
  }
}

class BlockingTurnEndStore extends MemorySessionStore {
  private releaseEnd!: () => void;
  readonly endGate = new Promise<void>((resolve) => { this.releaseEnd = resolve; });
  private markEnding!: () => void;
  readonly ending = new Promise<void>((resolve) => { this.markEnding = resolve; });

  release() {
    this.releaseEnd();
  }

  override async commit(batch: CommitBatch) {
    if (batch.events?.some((event) => event.type === "turn/completed")) {
      this.markEnding();
      await this.endGate;
    }
    return super.commit(batch);
  }
}

class BlockingSteerCommitStore extends MemorySessionStore {
  private releaseSteer!: () => void;
  private readonly steerGate = new Promise<void>((resolve) => { this.releaseSteer = resolve; });
  private markSteerCommitted!: () => void;
  readonly steerCommitted = new Promise<void>((resolve) => { this.markSteerCommitted = resolve; });

  release() {
    this.releaseSteer();
  }

  override async commit(batch: CommitBatch) {
    const result = await super.commit(batch);
    if (batch.events?.some((event) => event.type === "turn/steered")) {
      this.markSteerCommitted();
      await this.steerGate;
    }
    return result;
  }
}

class PendingIdempotencyStore extends MemorySessionStore {
  override async commit(batch: CommitBatch) {
    if (batch.idempotency?.key === "legacy-pending") throw new IdempotencyPendingError(Date.now() + 60_000);
    return super.commit(batch);
  }
}

class GatedAgentLookupStore extends MemorySessionStore {
  private shouldBlock = false;
  private releaseLookup!: () => void;
  private readonly lookupGate = new Promise<void>((resolve) => { this.releaseLookup = resolve; });
  private markLookupBlocked!: () => void;
  readonly lookupBlocked = new Promise<void>((resolve) => { this.markLookupBlocked = resolve; });

  blockNextLookup() {
    this.shouldBlock = true;
  }

  release() {
    this.releaseLookup();
  }

  override async getAgent(tenantId: string, agentId: string, version?: number) {
    if (this.shouldBlock) {
      this.shouldBlock = false;
      this.markLookupBlocked();
      await this.lookupGate;
    }
    return super.getAgent(tenantId, agentId, version);
  }
}

describe("SessionHost", () => {
  it("keeps parent-session links inside the target tenant and user", async () => {
    const h = await setup([{ text: "unused" }]);
    const delegatedParent = await h.host.createSession(principal, {
      agentId: h.agent.id,
      userId: "u_delegated",
      metadata: {},
    });
    const delegatedChild = await h.host.createSession(principal, {
      agentId: h.agent.id,
      userId: "u_delegated",
      parentSessionId: delegatedParent.id,
      metadata: {},
    });
    expect(delegatedChild).toMatchObject({ userId: "u_delegated", parentSessionId: delegatedParent.id });

    await expect(h.host.createSession(principal, {
      agentId: h.agent.id,
      userId: "u_delegated",
      parentSessionId: h.session.id,
      metadata: {},
    })).rejects.toMatchObject({ code: "not_found" });

    const foreignParent = {
      ...delegatedParent,
      id: newId("sess"),
      tenantId: "t_foreign",
      lastSeq: 0,
      fenceToken: 0,
    };
    await h.store.createSession(foreignParent);
    await expect(h.host.createSession(principal, {
      agentId: h.agent.id,
      userId: "u_delegated",
      parentSessionId: foreignParent.id,
      metadata: {},
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("archives and unarchives through the fenced host path, expiring session grants and stale approvals", async () => {
    const h = await setup([{ text: "after restore" }]);
    const approval: Approval = {
      id: newId("apr"),
      sessionId: h.session.id,
      turnId: newId("turn"),
      itemId: newId("item"),
      status: "pending",
      toolCallId: "legacy-call",
      toolName: "danger",
      args: {},
      availableDecisions: ["accept", "decline"],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const approvalItem: Item = {
      id: approval.itemId,
      sessionId: h.session.id,
      turnId: approval.turnId,
      seq: 0,
      status: "inProgress",
      createdAtMs: approval.createdAtMs,
      type: "approvalRequest",
      approvalId: approval.id,
      toolCallId: approval.toolCallId,
      name: approval.toolName,
      args: approval.args,
    };
    await h.store.commit({
      sessionId: h.session.id,
      fence: 1,
      approvals: [approval],
      items: [approvalItem],
      sessionPatch: { autoApprovedTools: ["danger"] },
    });

    await expect(h.host.archiveSession({ tenantId: "t_a", userId: "u_other" }, h.session.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(h.host.archiveSession({ tenantId: "t_other", userId: principal.userId }, h.session.id)).rejects.toMatchObject({ code: "not_found" });

    const archived = await h.host.archiveSession(principal, h.session.id);
    expect(archived.archivedAtMs).toEqual(expect.any(Number));
    expect(archived.autoApprovedTools).toEqual([]);
    expect((await h.store.getApproval(h.session.id, approval.id))).toMatchObject({
      status: "expired",
      decision: "cancel",
      decidedBy: "system:archive",
    });
    expect(await h.store.getItem(h.session.id, approval.itemId)).toMatchObject({ status: "declined" });
    const afterArchiveEvents = await h.store.readEvents(h.session.id, 0, 100);
    expect(afterArchiveEvents.map((event) => event.type).slice(-3)).toEqual([
      "approval/resolved",
      "item/completed",
      "session/archived",
    ]);

    const archiveSeq = archived.lastSeq;
    expect((await h.host.archiveSession(principal, h.session.id)).lastSeq).toBe(archiveSeq);
    expect((await h.store.readEvents(h.session.id, 0, 100)).at(-1)?.type).toBe("session/archived");
    await expect(h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "blocked" }],
      stream: false,
      metadata: {},
    })).rejects.toMatchObject({ code: "session_archived" });
    await expect(h.host.compactSession(principal, h.session.id)).rejects.toMatchObject({ code: "session_archived" });
    await expect(h.host.resolveApproval(principal, h.session.id, approval.id, "accept")).rejects.toMatchObject({ code: "session_archived" });
    await expect(h.host.submitDynamicToolResultOrThrow(principal, h.session.id, "legacy-call", {
      content: [{ type: "text", text: "blocked" }],
      isError: false,
    })).rejects.toMatchObject({ code: "session_archived" });
    await expect(h.host.unarchiveSession({ tenantId: "t_a", userId: "u_other" }, h.session.id)).rejects.toMatchObject({ code: "not_found" });

    const unarchived = await h.host.unarchiveSession(principal, h.session.id);
    expect(unarchived.archivedAtMs).toBeUndefined();
    expect(unarchived.autoApprovedTools).toEqual([]);
    expect((await h.store.readEvents(h.session.id, archiveSeq, 10)).map((event) => event.type)).toEqual(["session/unarchived"]);
    const started = await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "restored" }],
      stream: false,
      metadata: {},
    });
    expect(started.turn.status).toBe("inProgress");
    await waitIdle(h);
  });

  it("returns busy when archive loses the race to an active turn", async () => {
    const h = await setup([
      { text: "working", toolCalls: [{ name: "slow", args: { text: "x" } }] },
      { text: "done" },
    ]);
    const { turn } = await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "run" }],
      stream: false,
      metadata: {},
    });
    await expect(h.host.archiveSession(principal, h.session.id)).rejects.toMatchObject({ code: "session_busy" });
    await h.host.interrupt(principal, h.session.id, turn.id);
    await waitIdle(h);
    expect((await h.host.archiveSession(principal, h.session.id)).archivedAtMs).toEqual(expect.any(Number));
  });

  it("serialises concurrent archive/unarchive calls and leases even an idempotent no-op", async () => {
    const lease = new MemoryLeaseStore();
    const h = await setup([], {}, {}, { lease });

    const [archived, unarchived] = await Promise.all([
      h.host.archiveSession(principal, h.session.id),
      h.host.unarchiveSession(principal, h.session.id),
    ]);
    expect(archived.archivedAtMs).toEqual(expect.any(Number));
    expect(unarchived.archivedAtMs).toBeUndefined();
    expect((await h.store.readEvents(h.session.id, 0, 20)).map((event) => event.type).slice(-2)).toEqual([
      "session/archived",
      "session/unarchived",
    ]);

    const seqBeforeNoop = unarchived.lastSeq;
    const fenceBeforeNoop = lease.fences.get(h.session.id);
    const noopResult = await h.host.unarchiveSession(principal, h.session.id);
    expect(noopResult.lastSeq).toBe(seqBeforeNoop);
    expect(lease.fences.get(h.session.id)).toBe((fenceBeforeNoop ?? 0) + 1);
    expect(noopResult.fenceToken).toBe(lease.fences.get(h.session.id));
    await expect(h.store.commit({
      sessionId: h.session.id,
      fence: fenceBeforeNoop ?? 0,
      sessionPatch: { title: "stale writer" },
    })).rejects.toBeInstanceOf(FenceError);
    expect(await lease.getOwner(h.session.id)).toBeNull();
  });

  it("reports a lifecycle stale fence as an owner-aware lease conflict", async () => {
    const h = await setup([], {}, {}, {
      store: new LifecycleFenceStore(),
      lease: new ChangedOwnerLeaseStore(),
    });

    await expect(h.host.archiveSession(principal, h.session.id)).rejects.toMatchObject({
      code: "session_lease_conflict",
      details: { ownerId: "runner-new", ownerAddr: "127.0.0.1:9999" },
    });
  });

  it("normalizes grants and approvals while unarchiving a legacy archived-active projection", async () => {
    const store = new MemorySessionStore();
    const h = await setup([], {}, {}, { store });
    const legacyTurnId = newId("turn");
    const approval: Approval = {
      id: newId("apr"),
      sessionId: h.session.id,
      turnId: legacyTurnId,
      itemId: newId("item"),
      status: "pending",
      toolCallId: "legacy-call",
      toolName: "danger",
      args: {},
      availableDecisions: ["accept", "decline"],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const approvalItem: Item = {
      id: approval.itemId,
      sessionId: h.session.id,
      turnId: legacyTurnId,
      seq: 0,
      status: "inProgress",
      createdAtMs: approval.createdAtMs,
      type: "approvalRequest",
      approvalId: approval.id,
      toolCallId: approval.toolCallId,
      name: approval.toolName,
      args: approval.args,
    };
    const legacyTurn: Turn = {
      id: legacyTurnId,
      sessionId: h.session.id,
      status: "inProgress",
      seqStart: 2,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: approval.createdAtMs,
    };
    const activeStatus = { type: "active" as const, turnId: legacyTurnId, activeFlags: ["waitingOnApproval" as const] };
    await store.commit({
      sessionId: h.session.id,
      fence: 0,
      approvals: [approval],
      items: [approvalItem],
      turn: legacyTurn,
      events: [
        { type: "turn/started", sessionId: h.session.id, emittedAtMs: approval.createdAtMs, turn: legacyTurn },
        { type: "item/started", sessionId: h.session.id, emittedAtMs: approval.createdAtMs, item: approvalItem },
        { type: "approval/requested", sessionId: h.session.id, emittedAtMs: approval.createdAtMs, approval },
        { type: "session/status/changed", sessionId: h.session.id, emittedAtMs: approval.createdAtMs, status: activeStatus },
      ],
      sessionPatch: { status: activeStatus, autoApprovedTools: ["danger"] },
    });
    const persisted = store.sessions.get(h.session.id)!;
    persisted.archivedAtMs = Date.now();

    const repaired = await h.host.unarchiveSession(principal, h.session.id);
    expect(repaired.archivedAtMs).toBeUndefined();
    expect(repaired.status).toEqual({ type: "idle" });
    expect(repaired.autoApprovedTools).toEqual([]);
    expect(repaired.fenceToken).toBe(1);
    expect(await store.getApproval(h.session.id, approval.id)).toMatchObject({ status: "expired", decision: "cancel" });
    expect(await store.getItem(h.session.id, approval.itemId)).toMatchObject({ status: "declined" });
    expect(await store.getTurn(h.session.id, legacyTurnId)).toMatchObject({ status: "interrupted", stopReason: "interrupted" });
    expect((await store.readEvents(h.session.id, 0, 20)).map((event) => event.type).slice(-5)).toEqual([
      "approval/resolved",
      "item/completed",
      "turn/completed",
      "session/status/changed",
      "session/unarchived",
    ]);
  });

  it("runs a multi-step turn: text → tool → final; events are contiguous and items replayable", async () => {
    const h = await setup([
      { text: "let me check", toolCalls: [{ name: "echo", args: { text: "a" } }, { name: "echo", args: { text: "b" } }] },
      { text: "done: a b" },
    ]);
    const { turn } = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "hi" }], stream: true, metadata: { traceId: "trace-1" } });
    const s = await waitIdle(h);
    const t = (await h.store.getTurn(h.session.id, turn.id))!;
    expect(t.status).toBe("completed");
    expect(t.stopReason).toBe("end_turn");
    expect(t.steps).toBe(2);
    expect(t.toolCalls).toBe(2);
    expect(t.metadata).toEqual({ traceId: "trace-1" });
    expect(t.usage.totalTokens).toBe(30);
    expect(s.usage.totalTokens).toBe(30);
    expect(t.seqEnd).toBe(s.lastSeq);
    expect(h.store.usageLedger).toHaveLength(2);
    expect((await h.store.queryUsage(principal.tenantId, { sessionId: h.session.id, groupBy: "total", limit: 10 })).data[0]).toMatchObject({
      turns: 1,
      steps: 2,
      usage: { totalTokens: 30 },
    });

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

  it("never executes an approval accepted after its deadline", async () => {
    const h = await setup([{ text: "", toolCalls: [{ name: "danger", args: { text: "x" } }] }, { text: "after" }], {}, { approvalTtlMs: 200 });
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    const event = await waitFor(() => h.events.find((e) => e.type === "approval/requested"));
    const approval = (event as Extract<Event, { type: "approval/requested" }>).approval;

    // Block the timer callback past the deadline, then race a nominal accept against it. The stored
    // deadline remains authoritative even if the user callback reaches the microtask queue first.
    while (Date.now() <= approval.expiresAtMs + 5) { /* deliberate event-loop stall */ }
    const resolved = await h.host.resolveApproval(principal, h.session.id, approval.id, "accept");
    expect(resolved).toMatchObject({ status: "expired", decision: "decline", decidedBy: "system:timeout" });

    await waitIdle(h);
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    expect(items.find((item) => item.type === "toolCall")).toMatchObject({ status: "declined" });
    expect(items.find((item) => item.type === "toolResult")).toMatchObject({ isError: true });
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
    const steerRequest = { input: [{ type: "text" as const, text: "also this" }], stream: true, metadata: {} };
    const second = await h.host.startTurn(principal, h.session.id, steerRequest, { idempotencyKey: "steer-once" });
    expect(second.steered).toBe(true);
    expect(second.turn.id).toBe(first.turn.id);
    const replay = await h.host.startTurn(principal, h.session.id, steerRequest, { idempotencyKey: "steer-once" });
    expect(replay.replayed).toBe(true);
    expect(replay.turn.id).toBe(first.turn.id);
    await expect(h.host.startTurn(
      principal,
      h.session.id,
      { ...steerRequest, input: [{ type: "text", text: "different" }] },
      { idempotencyKey: "steer-once" },
    )).rejects.toMatchObject({ code: "idempotency_conflict" });
    await waitIdle(h);
    expect(h.engine.steers).toHaveLength(1);
    expect(h.events.some((e) => e.type === "turn/steered")).toBe(true);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).filter((i) => i.type === "userMessage")).toHaveLength(2);
  });

  it("queues a steer accepted in the beginTurn/run gap and injects it once the engine attaches", async () => {
    const h = await setup([{ text: "first" }, { text: "after steer" }]);
    const first = await h.host.beginTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: true, metadata: {} });
    const second = await h.host.startTurn(
      principal,
      h.session.id,
      { input: [{ type: "text", text: "queued before run" }], stream: false, metadata: {} },
      { idempotencyKey: "pre-run-steer" },
    );

    expect(second.steered).toBe(true);
    expect(h.engine.received).toHaveLength(0);
    expect(h.engine.steers).toHaveLength(0);
    first.run();
    await waitIdle(h);

    expect(h.engine.steers).toEqual([[{ type: "text", text: "queued before run" }]]);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).filter((item) => item.type === "userMessage")).toHaveLength(2);
  });

  it("drains an admitted steer into the engine before interrupting the turn", async () => {
    const store = new BlockingSteerCommitStore();
    const h = await setup([
      { text: "working", toolCalls: [{ name: "slow", args: { text: "x" } }] },
      { text: "after steer" },
    ], {}, {}, { store });
    const first = await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "go" }], stream: false, metadata: {},
    });
    await waitFor(() => h.events.find((event) => event.type === "item/started" && event.item.type === "toolCall"));

    const steer = h.host.startTurn(
      principal,
      h.session.id,
      { input: [{ type: "text", text: "accepted before interrupt" }], stream: false, metadata: {} },
      { idempotencyKey: "interrupt-barrier" },
    );
    await store.steerCommitted;
    let interruptSettled = false;
    const interrupt = h.host.interrupt(principal, h.session.id, first.turn.id).finally(() => { interruptSettled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(interruptSettled).toBe(false);
    } finally {
      store.release();
    }

    expect((await steer).steered).toBe(true);
    const stopped = await interrupt;
    expect(stopped.status).toBe("interrupted");
    expect(h.engine.steers).toEqual([[{ type: "text", text: "accepted before interrupt" }]]);
  });

  it("maps a legacy pending idempotency row to conflict without fencing the healthy active turn", async () => {
    const store = new PendingIdempotencyStore();
    const h = await setup([
      { text: "working", toolCalls: [{ name: "slow", args: { text: "x" } }] },
      { text: "still healthy" },
    ], {}, {}, { store });
    const first = await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "go" }], stream: false, metadata: {},
    });
    await waitFor(() => h.events.find((event) => event.type === "item/started" && event.item.type === "toolCall"));

    await expect(h.host.startTurn(
      principal,
      h.session.id,
      { input: [{ type: "text", text: "must conflict" }], stream: false, metadata: {} },
      { idempotencyKey: "legacy-pending" },
    )).rejects.toMatchObject({ code: "idempotency_conflict" });

    await waitIdle(h);
    expect(await store.getTurn(h.session.id, first.turn.id)).toMatchObject({ status: "completed", stopReason: "end_turn" });
    expect(h.engine.steers).toHaveLength(0);
  });

  it("closes a reserved turn at its wall-clock deadline even when run() is never called", async () => {
    const h = await setup([{ text: "must not start" }], {}, { leaseHoldMs: 10 });
    const begun = await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "go" }], stream: true, metadata: {}, limits: { maxWallClockMs: 50 },
    });

    const session = await waitIdle(h);
    const turn = await h.store.getTurn(h.session.id, begun.turn.id);
    expect(turn).toMatchObject({ status: "completed", stopReason: "max_wall_clock", steps: 0 });
    expect(session.status.type).toBe("idle");
    expect(h.engine.received).toHaveLength(0);
    expect((h.host as unknown as { active: Map<string, unknown> }).active.size).toBe(0);
    await waitFor(async () => ((await h.lease.getOwner(h.session.id)) === null ? true : undefined));
  });

  it("rejects late steer admission once turn completion has begun", async () => {
    const store = new BlockingTurnEndStore();
    const h = await setup([{ text: "done" }], {}, {}, { store });
    const first = await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: false, metadata: {} });
    await store.ending;
    try {
      await expect(h.host.startTurn(
        principal,
        h.session.id,
        { input: [{ type: "text", text: "too late" }], stream: false, metadata: {} },
        { idempotencyKey: "late-steer" },
      )).rejects.toMatchObject({ code: "session_busy" });
      expect(await store.getIdempotencyKey(
        { tenantId: principal.tenantId, userId: principal.userId!, sessionId: h.session.id },
        "late-steer",
      )).toBeNull();
    } finally {
      store.release();
    }
    await waitIdle(h);
    expect((await store.listItems(h.session.id, { limit: 100 })).filter((item) => item.type === "userMessage")).toHaveLength(1);
    expect((await store.getTurn(h.session.id, first.turn.id))?.status).toBe("completed");
  });

  it("validates unsupported input before busyPolicy=steer can persist an idempotency receipt", async () => {
    const h = await setup([{ text: "thinking", delayMs: 200 }, { text: "after" }]);
    await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: "go" }], stream: false, metadata: {} });

    await expect(h.host.startTurn(
      principal,
      h.session.id,
      { input: [{ type: "skill", name: "not-supported" }], stream: false, metadata: {} },
      { idempotencyKey: "unsupported-steer" },
    )).rejects.toMatchObject({ code: "invalid_request" });
    expect(await h.store.getIdempotencyKey(
      { tenantId: principal.tenantId, userId: principal.userId!, sessionId: h.session.id },
      "unsupported-steer",
    )).toBeNull();

    const accepted = await h.host.startTurn(
      principal,
      h.session.id,
      { input: [{ type: "text", text: "valid retry" }], stream: false, metadata: {} },
      { idempotencyKey: "unsupported-steer" },
    );
    expect(accepted.steered).toBe(true);
    await waitIdle(h);
    expect(h.engine.steers).toEqual([[{ type: "text", text: "valid retry" }]]);
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

  it("replays and repairs the single durable turn when its atomic idempotency commit acknowledgement is lost", async () => {
    const store = new AmbiguousIdempotencyStore();
    const h = await setup([{ text: "must not run" }], {}, {}, { store });
    const req = { input: [{ type: "text" as const, text: "go" }], stream: false, metadata: {} };

    await expect(h.host.beginTurn(principal, h.session.id, req, { idempotencyKey: "lost-ack" })).rejects.toThrow("injected lost commit acknowledgement");
    const replay = await h.host.beginTurn(principal, h.session.id, req, { idempotencyKey: "lost-ack" });

    expect(replay.replayed).toBe(true);
    expect(replay.turn.status).toBe("interrupted");
    expect((await store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(1);
    expect((await store.listItems(h.session.id, { limit: 100 })).filter((item) => item.type === "userMessage")).toHaveLength(1);
  });

  it("replays an in-progress idempotent turn while another runner owns its lease even when draining", async () => {
    const store = new AmbiguousIdempotencyStore();
    const h = await setup([{ text: "must not run" }], {}, {}, { store });
    const req = { input: [{ type: "text" as const, text: "go" }], stream: false, metadata: {} };

    await expect(h.host.beginTurn(principal, h.session.id, req, { idempotencyKey: "remote-in-progress" }))
      .rejects.toThrow("injected lost commit acknowledgement");
    const remote = await h.lease.acquire(h.session.id, "runner-2", "10.0.0.9:1", 60_000);
    expect(remote.ok).toBe(true);
    await h.host.drain(0);

    const replay = await h.host.beginTurn(principal, h.session.id, req, { idempotencyKey: "remote-in-progress" });
    expect(replay.replayed).toBe(true);
    expect(replay.turn.status).toBe("inProgress");
    expect(h.engine.received).toHaveLength(0);
    expect((await h.lease.getOwner(h.session.id))?.ownerId).toBe("runner-2");
  });

  it("rechecks idempotency after lease conflict when another runner commits after the first lookup", async () => {
    const store = new GatedAgentLookupStore();
    const h = await setup([{ text: "must not run" }], {}, {}, { store });
    const req = { input: [{ type: "text" as const, text: "go" }], stream: false, metadata: {} };
    store.blockNextLookup();

    const beginning = h.host.beginTurn(principal, h.session.id, req, { idempotencyKey: "raced-start" });
    await store.lookupBlocked;
    const remote = await h.lease.acquire(h.session.id, "runner-2", "10.0.0.9:1", 60_000);
    expect(remote.ok).toBe(true);
    const turn = {
      id: newId("turn"), sessionId: h.session.id, status: "inProgress" as const,
      seqStart: h.session.lastSeq + 1, steps: 0, toolCalls: 0, usage: emptyUsage(), startedAtMs: Date.now(),
    };
    const { stream: _stream, ...resource } = req;
    await store.commit({
      sessionId: h.session.id,
      fence: (remote as { ok: true; fence: number }).fence,
      turn,
      idempotency: {
        scope: { tenantId: principal.tenantId, userId: principal.userId!, sessionId: h.session.id },
        key: "raced-start",
        requestHash: sha256(stableStringify(resource)),
        value: { turnId: turn.id, sessionId: h.session.id },
        expiresAtMs: Date.now() + 60_000,
      },
      events: [{ type: "turn/started", sessionId: h.session.id, emittedAtMs: Date.now(), turn }],
      sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } },
    });
    store.release();

    const replay = await beginning;
    expect(replay).toMatchObject({ replayed: true, turn: { id: turn.id, status: "inProgress" } });
    expect(h.engine.received).toHaveLength(0);
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

  it("does not register or commit a turn when drain finishes during provider preflight", async () => {
    let markProviderStarted!: () => void;
    let releaseProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const gatedProviders: ProviderResolver = {
      resolve: async () => {
        markProviderStarted();
        await providerGate;
        return fakeModel;
      },
    };
    const h = await setup([{ text: "must not run" }], {}, {}, { providers: gatedProviders });
    const beginning = h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "go" }], stream: false, metadata: {},
    });
    await providerStarted;
    await h.host.drain(0);
    releaseProvider();

    await expect(beginning).rejects.toMatchObject({ code: "draining" });
    expect((await h.store.listTurns(h.session.id, { limit: 10 })).data).toHaveLength(0);
    expect((h.host as unknown as { active: Map<string, unknown> }).active.size).toBe(0);
    expect(await h.lease.getOwner(h.session.id)).toBeNull();
  });

  it("serialises explicit compaction with turn start, renews it, publishes it, and returns the summary id", async () => {
    const store = new RecordingStore();
    const lease = new CountingLeaseStore();
    let markSummaryStarted!: () => void;
    let releaseSummary!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryUsage: Usage = { ...emptyUsage(), inputTokens: 7, outputTokens: 3, totalTokens: 10, costCNY: 0.02 };
    const summariser: Summariser = {
      summarise: async () => {
        markSummaryStarted();
        await summaryGate;
        return { text: "summary of earlier turns", usage: summaryUsage };
      },
    };
    const h = await setup([{ text: "answer ".repeat(200) }], {}, { leaseTtlMs: 120 }, { store, lease, summariser });
    for (let i = 0; i < 3; i++) {
      await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: `question ${i} ${"detail ".repeat(200)}` }], stream: true, metadata: {} });
      await waitIdle(h);
    }
    const usageBeforeCompaction = (await store.getSession(principal.tenantId, h.session.id))!.usage;
    h.events.length = 0;
    store.commits.length = 0;

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
    const atomicBatches = store.commits.filter((batch) => batch.items?.some((item) => item.id === compacted.summaryItemId));
    expect(atomicBatches).toHaveLength(1);
    expect(atomicBatches[0]?.events?.map((event) => event.type)).toEqual(["item/completed", "session/compacted"]);
    expect(atomicBatches[0]?.sessionPatch?.lastCompactionSeq).toEqual(expect.any(Number));
    expect(atomicBatches[0]?.sessionPatch?.usage).toEqual(addUsage(usageBeforeCompaction, summaryUsage));
    expect(atomicBatches[0]?.usageEntries).toHaveLength(1);
    expect(store.usageLedger.some((entry) => entry.turnId === summaryItem?.turnId && entry.step === 0)).toBe(true);
    const usageAfterCompaction = (await store.getSession(principal.tenantId, h.session.id))!.usage;
    expect(usageAfterCompaction).toEqual(addUsage(usageBeforeCompaction, summaryUsage));
    expect((await store.queryUsage(principal.tenantId, { sessionId: h.session.id, groupBy: "total", limit: 10 })).data[0]?.usage).toEqual(usageAfterCompaction);
    await waitFor(() => (h.events.some((event) => event.type === "session/compacted" && event.itemId === compacted.summaryItemId) ? true : undefined));
    expect(h.events.some((event) => event.type === "item/completed" && event.item.id === compacted.summaryItemId)).toBe(true);

    const begun = await begunPromise;
    begun.run();
    await waitIdle(h);
  });

  it("leaves no summary, event, watermark, or usage when the atomic compaction write fails", async () => {
    const store = new FailingCompactionStore();
    const summariser: Summariser = { summarise: async () => ({ text: "must not persist", usage: { ...emptyUsage(), totalTokens: 7 } }) };
    const h = await setup([{ text: "answer ".repeat(200) }], {}, {}, { store, summariser });
    for (let i = 0; i < 3; i++) {
      await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: `question ${i} ${"detail ".repeat(200)}` }], stream: true, metadata: {} });
      await waitIdle(h);
    }
    const before = await store.getSession(principal.tenantId, h.session.id);
    const beforeUsageRows = store.usageLedger.length;
    const beforeEvents = await store.readEvents(h.session.id, 0, 1_000);

    await expect(h.host.compactSession(principal, h.session.id)).rejects.toThrow("injected compaction write failure");

    const after = await store.getSession(principal.tenantId, h.session.id);
    expect(after?.lastCompactionSeq).toBe(before?.lastCompactionSeq);
    expect(store.usageLedger).toHaveLength(beforeUsageRows);
    expect((await store.listItems(h.session.id, { limit: 1_000 })).some((item) => item.type === "contextCompaction")).toBe(false);
    expect(await store.readEvents(h.session.id, 0, 1_000)).toEqual(beforeEvents);
  });

  it("discards a prepared summary when the durable session surface changes during summarisation", async () => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const summariser: Summariser = {
      summarise: async () => {
        markStarted();
        await gate;
        return { text: "stale summary", usage: emptyUsage() };
      },
    };
    const h = await setup([{ text: "answer ".repeat(200) }], {}, {}, { summariser });
    for (let i = 0; i < 3; i++) {
      await h.host.startTurn(principal, h.session.id, { input: [{ type: "text", text: `question ${i} ${"detail ".repeat(200)}` }], stream: true, metadata: {} });
      await waitIdle(h);
    }

    const compacting = h.host.compactSession(principal, h.session.id);
    await started;
    const current = (await h.store.getSession(principal.tenantId, h.session.id))!;
    await h.store.commit({
      sessionId: h.session.id,
      fence: current.fenceToken,
      events: [{ type: "warning", sessionId: h.session.id, emittedAtMs: Date.now(), code: "test_surface_change", message: "test" }],
    });
    release();

    await expect(compacting).rejects.toBeInstanceOf(SessionVersionError);
    expect((await h.store.listItems(h.session.id, { limit: 1_000 })).some((item) => item.type === "contextCompaction")).toBe(false);
    expect((await h.store.readEvents(h.session.id, 0, 1_000)).some((event) => event.type === "session/compacted")).toBe(false);
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

  it("lets a running turn complete all steps inside the drain grace window", async () => {
    const h = await setup([
      { text: "step one", toolCalls: [{ name: "slow", args: { text: "x" } }] },
      { text: "graceful final" },
    ]);
    const started = await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "go" }], stream: false, metadata: {},
    });
    await waitFor(() => h.events.find((event) => event.type === "item/started" && event.item.type === "toolCall"));

    await h.host.drain(2_000);

    expect(await h.store.getTurn(h.session.id, started.turn.id)).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
      steps: 2,
    });
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some(
      (item) => item.type === "agentMessage" && item.text === "graceful final",
    )).toBe(true);
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

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting");
}
