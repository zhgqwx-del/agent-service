import { afterEach, describe, expect, it } from "vitest";
import {
  emptyUsage,
  type AgentDefinition,
  type Principal,
  type Session,
  type Turn,
} from "@agent-service/protocol";
import {
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
  newErasureRequestId,
  userErasureRequestHash,
  validateErasureSessionAction,
  type ErasureJobAuthorization,
  type ErasureSessionAction,
  type ErasureSessionHead,
  type ErasureSessionStore,
  type ErasureWriteAuthorization,
} from "@agent-service/store";
import {
  SessionHost,
  StaticToolRegistry,
  newId,
  type ProviderResolver,
  type ResolvedModel,
  type RunnerTool,
} from "../src/index.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

const principal: Principal & { userId: string } = { tenantId: "t_erasure", userId: "u_erasure" };
const model: ResolvedModel = {
  handle: {},
  provider: "fake",
  model: "fake-1",
  contextWindow: 32_000,
  input: ["text"],
  apiKey: async () => "unused",
};
const providers: ProviderResolver = { resolve: async () => model };
const dangerousTool: RunnerTool = {
  name: "danger",
  description: "requires approval",
  parameters: { type: "object", properties: {} },
  kind: "builtin",
  readOnly: false,
  needsApproval: true,
  execute: async () => ({ content: [{ type: "text", text: "done" }] }),
};

const clone = <T>(value: T): T => structuredClone(value);

const erasureSessionCommitKind = (action: ErasureSessionAction) => (
  action.action === "settle" ? "settlement" : action.action
);

/** Actual Memory erasure semantics plus narrow observability/fault injection for Host ordering. */
class ErasureSessionStoreDouble extends MemorySessionStore implements ErasureSessionStore {
  erasureCommits: ErasureSessionAction[] = [];
  invalidateAfterNextRead = false;

  override async getErasureSessionHead(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<ErasureSessionHead | null> {
    const result = await super.getErasureSessionHead(authority, sessionId);
    if (this.invalidateAfterNextRead) {
      this.invalidateAfterNextRead = false;
      const request = this.erasureRequests.get(authority.requestId)!;
      request.claimToken = "replacement-claim";
    }
    return result;
  }

  override async applyErasureSessionAction(action: ErasureSessionAction) {
    const result = await super.applyErasureSessionAction(action);
    this.erasureCommits.push(clone(action));
    return result;
  }
}

class WedgedEngine extends ScriptedEngine {
  private releaseDone!: () => void;
  private readonly blocked: Promise<void>;
  private signalStarted!: () => void;
  readonly started: Promise<void>;

  constructor() {
    super([]);
    this.blocked = new Promise<void>((resolve) => { this.releaseDone = resolve; });
    this.started = new Promise<void>((resolve) => { this.signalStarted = resolve; });
  }

  release() {
    this.releaseDone();
  }

  override start(..._args: Parameters<ScriptedEngine["start"]>): ReturnType<ScriptedEngine["start"]> {
    this.signalStarted();
    return {
      steer: () => {},
      interrupt: () => {},
      done: this.blocked.then(() => ({ steps: 0, aborted: true })),
    };
  }
}

interface Harness {
  store: ErasureSessionStoreDouble;
  lease: MemoryLeaseStore;
  host: SessionHost;
  engine: ScriptedEngine;
  session: Session;
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.drain(200).catch(() => {});
});

async function setup(
  script: ScriptStep[] = [],
  extras: { engine?: ScriptedEngine; config?: { leaseTtlMs?: number; erasureDrainTimeoutMs?: number } } = {},
): Promise<Harness> {
  const store = new ErasureSessionStoreDouble();
  const lease = new MemoryLeaseStore();
  const bus = new MemoryEventBus();
  const engine = extras.engine ?? new ScriptedEngine(script);
  const agent: AgentDefinition = {
    id: newId("agt"),
    tenantId: principal.tenantId,
    version: 1,
    name: "erasure-test",
    instructions: "test",
    model: { provider: "fake", model: "fake-1" },
    tools: ["danger"],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "on-request",
    busyPolicy: "reject",
    sandbox: "none",
    metadata: {},
    createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store,
    erasureStore: store,
    lease,
    bus,
    engine,
    providers,
    tools: new StaticToolRegistry([dangerousTool]),
    config: {
      runnerId: "erasure-runner",
      runnerAddr: "127.0.0.1:4010",
      leaseTtlMs: 2_000,
      leaseHoldMs: 20,
      approvalTtlMs: 5_000,
      erasureDrainTimeoutMs: 1_000,
      ...extras.config,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  hosts.push(host);
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  return { store, lease, host, engine, session };
}

function jobAuthorization(record: {
  tenantId: string;
  subjectKind: "tenant" | "user";
  subjectId: string;
  requestId: string;
  subjectGeneration: number;
  claimToken?: string;
  attempts: number;
}): ErasureJobAuthorization {
  return {
    tenantId: record.tenantId,
    subjectKind: record.subjectKind,
    subjectId: record.subjectId,
    requestId: record.requestId,
    subjectGeneration: record.subjectGeneration,
    claimToken: record.claimToken!,
    claimAttempt: record.attempts,
  };
}

async function gateAtDraining(h: Harness): Promise<ErasureWriteAuthorization> {
  const now = Date.now();
  const requestId = newErasureRequestId();
  await h.store.requestUserErasure({
    requestId,
    tenantId: principal.tenantId,
    userId: principal.userId,
    requestedByKeyId: "admin-test",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(principal.tenantId, principal.userId),
    atMs: now,
  });

  let [job] = await h.store.claimErasureJobs({ nowMs: now, limit: 1, leaseMs: 60_000, claimToken: "claim-gated" });
  await h.store.transitionErasureJob(jobAuthorization(job!), {
    fromStatus: "gated",
    toStatus: "draining",
    atMs: now + 1,
    availableAtMs: now + 1,
  });
  [job] = await h.store.claimErasureJobs({ nowMs: now + 1, limit: 1, leaseMs: 60_000, claimToken: "claim-draining" });
  return {
    tenantId: job!.tenantId,
    userId: job!.subjectId,
    requestId: job!.requestId,
    subjectGeneration: job!.subjectGeneration,
    claimToken: job!.claimToken!,
    claimAttempt: job!.attempts,
  };
}

async function gateAtTombstoning(h: Harness): Promise<ErasureWriteAuthorization> {
  const draining = await gateAtDraining(h);
  const now = Date.now();
  await h.store.transitionErasureJob({
    tenantId: draining.tenantId,
    subjectKind: "user",
    subjectId: draining.userId,
    requestId: draining.requestId,
    subjectGeneration: draining.subjectGeneration,
    claimToken: draining.claimToken,
    claimAttempt: draining.claimAttempt,
  }, {
    fromStatus: "draining",
    toStatus: "tombstoning",
    atMs: now,
    availableAtMs: now,
  });
  const [job] = await h.store.claimErasureJobs({ nowMs: now, limit: 1, leaseMs: 60_000, claimToken: "claim-tombstone" });
  return {
    tenantId: job!.tenantId,
    userId: job!.subjectId,
    requestId: job!.requestId,
    subjectGeneration: job!.subjectGeneration,
    claimToken: job!.claimToken!,
    claimAttempt: job!.attempts,
  };
}

async function retryDrainingClaim(
  h: Harness,
  authority: ErasureWriteAuthorization,
): Promise<ErasureWriteAuthorization> {
  const now = Date.now();
  const authorization: ErasureJobAuthorization = {
    tenantId: authority.tenantId,
    subjectKind: "user",
    subjectId: authority.userId,
    requestId: authority.requestId,
    subjectGeneration: authority.subjectGeneration,
    claimToken: authority.claimToken,
    claimAttempt: authority.claimAttempt,
  };
  expect(await h.store.retryErasureJob(authorization, {
    failedAtMs: now,
    availableAtMs: now,
    errorCode: "drain_timeout",
  })).toBe(true);
  const [job] = await h.store.claimErasureJobs({
    nowMs: now,
    limit: 1,
    leaseMs: 60_000,
    claimToken: `claim-draining-${authority.claimAttempt + 1}`,
  });
  expect(job?.attempts).toBe(authority.claimAttempt + 1);
  return {
    tenantId: job!.tenantId,
    userId: job!.subjectId,
    requestId: job!.requestId,
    subjectGeneration: job!.subjectGeneration,
    claimToken: job!.claimToken,
    claimAttempt: job!.attempts,
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("SessionHost draining-phase erasure", () => {
  it("stops a reserved local turn after one claim-bound fence without repairing durable state", async () => {
    const h = await setup([]);
    const begun = await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "reserved drain" }],
      stream: false,
      metadata: {},
    });
    const authority = await gateAtDraining(h);

    await h.host.drainSessionForErasure(authority, h.session.id);

    expect(h.host.activeTurn(h.session.id)).toBeUndefined();
    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual(["fence"]);
    expect(h.store.erasureCommits[0]).toMatchObject({ authority });
    expect(h.store.erasureCommits[0]).not.toHaveProperty("events");
    expect(h.store.erasureCommits[0]).not.toHaveProperty("lifecycle");
    expect(h.store.erasureCommits[0]).not.toHaveProperty("sessionPatch");
    expect(h.store.sessions.get(h.session.id)).toMatchObject({
      status: { type: "active", turnId: begun.turn.id },
    });
    expect(h.store.turns.get(begun.turn.id)).toMatchObject({ status: "inProgress" });
    expect(await h.lease.getOwner(h.session.id)).toBeNull();
  });

  it("does not abort during draining when the claim becomes stale after snapshot read", async () => {
    const h = await setup([]);
    await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "still reserved" }],
      stream: false,
      metadata: {},
    });
    const authority = await gateAtDraining(h);
    h.store.invalidateAfterNextRead = true;

    await expect(h.host.drainSessionForErasure(authority, h.session.id)).rejects.toThrow(
      "stale erasure authority",
    );

    expect(h.host.activeTurn(h.session.id)).toBeDefined();
    expect(h.store.erasureCommits).toEqual([]);
    expect(await h.lease.getOwner(h.session.id)).toMatchObject({ ownerId: "erasure-runner" });
  });

  it("returns the remote owner conflict for worker/internal-route delegation", async () => {
    const h = await setup([]);
    const authority = await gateAtDraining(h);
    await h.lease.acquire(h.session.id, "remote-runner", "10.0.0.8:4010", 30_000);

    await expect(h.host.drainSessionForErasure(authority, h.session.id)).rejects.toMatchObject({
      code: "session_lease_conflict",
      details: { ownerId: "remote-runner", ownerAddr: "10.0.0.8:4010" },
    });
    expect(h.store.erasureCommits).toEqual([]);
  });

  it("never refreshes a timed-out drain lease for a queued duplicate or a new claim attempt", async () => {
    const engine = new WedgedEngine();
    const h = await setup([], {
      engine,
      config: { leaseTtlMs: 300, erasureDrainTimeoutMs: 20 },
    });
    await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "wedged drain" }],
      stream: false,
      metadata: {},
    });
    await engine.started;
    const authority = await gateAtDraining(h);

    const first = h.host.drainSessionForErasure(authority, h.session.id);
    await waitFor(() => h.store.erasureCommits.length === 1);
    const ownerBefore = await h.lease.getOwner(h.session.id);
    const expiresAt = h.lease.leases.get(h.session.id)!.expiresAt;
    const queuedDuplicate = h.host.drainSessionForErasure(authority, h.session.id);

    await expect(first).rejects.toMatchObject({
      code: "session_busy",
    });
    await expect(queuedDuplicate).rejects.toMatchObject({
      name: "ErasureLocalTurnFencedError",
      code: "session_busy",
    });

    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual(["fence"]);
    expect(await h.lease.getOwner(h.session.id)).toMatchObject({ ownerId: "erasure-runner" });
    expect(h.lease.leases.get(h.session.id)?.expiresAt).toBe(expiresAt);

    const nextAuthority = await retryDrainingClaim(h, authority);
    const staleFailure = await h.host.drainSessionForErasure(authority, h.session.id)
      .catch((error: unknown) => error);
    expect(staleFailure).toBeInstanceOf(Error);
    expect(staleFailure).not.toMatchObject({ name: "ErasureLocalTurnFencedError" });
    expect(String(staleFailure)).toContain("stale erasure authority");
    await expect(h.host.drainSessionForErasure(nextAuthority, h.session.id)).rejects.toMatchObject({
      name: "ErasureLocalTurnFencedError",
      code: "session_busy",
    });
    expect(h.lease.leases.get(h.session.id)?.expiresAt).toBe(expiresAt);

    await waitFor(async () => (await h.lease.getOwner(h.session.id)) === null, 1_000);
    const takeover = await h.lease.acquire(h.session.id, "takeover-runner", "127.0.0.1:4011", 300);
    expect(takeover.ok).toBe(true);
    if (takeover.ok) expect(takeover.fence).toBeGreaterThan(ownerBefore!.fence);

    engine.release();
    await waitFor(() => h.host.activeTurn(h.session.id) === undefined);
    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual(["fence"]);
    expect(h.store.turns.values().next().value).toMatchObject({ status: "inProgress" });
  });
});

describe("SessionHost claim-bound erasure", () => {
  it("claims before aborting a reserved local turn, repairs it, and commits a terminal tombstone", async () => {
    const h = await setup([]);
    const begun = await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "reserved" }],
      stream: false,
      metadata: {},
    });
    const authority = await gateAtTombstoning(h);

    await h.host.eraseSessionForErasure(authority, h.session.id);

    expect(h.host.activeTurn(h.session.id)).toBeUndefined();
    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual([
      "fence",
      "settlement",
      "tombstone",
    ]);
    expect(h.store.erasureCommits[1]).toMatchObject({ authority, action: "settle" });
    expect(h.store.turns.get(begun.turn.id)).toMatchObject({
      status: "interrupted",
      stopReason: "interrupted",
      error: { code: "erasure", message: "turn interrupted for user erasure" },
    });
    expect((await h.store.readEvents(h.session.id, 0, 100)).at(-1)).toMatchObject({
      type: "session/deleted",
      deletionGeneration: 1,
    });
  });

  it("aborts a running provider step only after the claim-bound fence succeeds", async () => {
    const h = await setup([{ text: "late answer", delayMs: 80 }]);
    await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "run" }],
      stream: false,
      metadata: {},
    });
    await waitFor(() => h.engine.startedSteps === 1);
    const authority = await gateAtTombstoning(h);

    await h.host.eraseSessionForErasure(authority, h.session.id);

    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual([
      "fence",
      "settlement",
      "tombstone",
    ]);
    const activeTurn = [...h.store.turns.values()].find((turn) => turn.sessionId === h.session.id);
    expect(activeTurn).toMatchObject({ status: "interrupted" });
  });

  it("cancels an approval wait and normalizes only its existing approval and item", async () => {
    const h = await setup([
      { toolCalls: [{ name: "danger", args: { value: "existing" } }] },
      { text: "must not run" },
    ]);
    await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "approve" }],
      stream: false,
      metadata: {},
    });
    await waitFor(async () => (await h.store.listApprovals(h.session.id, { pendingOnly: true })).length === 1);
    const pending = [...h.store.approvals.values()].find((approval) => (
      approval.sessionId === h.session.id && approval.status === "pending"
    ))!;
    const approvalItem = [...h.store.items.values()].find((item) => (
      item.sessionId === h.session.id
      && item.type === "approvalRequest"
      && item.approvalId === pending.id
    ))!;
    const authority = await gateAtTombstoning(h);

    // Ordinary gated reads hide these rows; the fixed Store action finds only existing resources.
    expect(await h.store.listApprovals(h.session.id, { pendingOnly: true })).toEqual([]);
    await h.host.eraseSessionForErasure(authority, h.session.id);

    const settlement = h.store.erasureCommits.find((batch) => erasureSessionCommitKind(batch) === "settlement")!;
    expect(settlement).toMatchObject({ action: "settle", authority });
    expect(h.store.approvals.get(pending.id)).toMatchObject({
      status: "expired",
      decision: "cancel",
      decidedBy: "system:erasure",
    });
    expect(h.store.items.get(approvalItem.id)).toMatchObject({
      type: "approvalRequest",
      status: "declined",
    });
    expect((await h.store.readEvents(h.session.id, 0, 100)).map((event) => event.type).slice(-5, -1)).toEqual([
      "approval/resolved",
      "item/completed",
      "turn/completed",
      "session/status/changed",
    ]);
  });

  it("does not abort a local turn when the authority becomes stale after the initial snapshot", async () => {
    const h = await setup([]);
    await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "keep reserved" }],
      stream: false,
      metadata: {},
    });
    const authority = await gateAtTombstoning(h);
    h.store.invalidateAfterNextRead = true;

    await expect(h.host.eraseSessionForErasure(authority, h.session.id)).rejects.toThrow("stale erasure authority");

    expect(h.host.activeTurn(h.session.id)).toBeDefined();
    expect(h.store.erasureCommits).toEqual([]);
    expect(await h.lease.getOwner(h.session.id)).toMatchObject({ ownerId: "erasure-runner" });
  });

  it("does not release the session lease when an abort-ignoring provider exceeds the drain bound", async () => {
    const engine = new WedgedEngine();
    const h = await setup([], {
      engine,
      config: { leaseTtlMs: 500, erasureDrainTimeoutMs: 20 },
    });
    await h.host.startTurn(principal, h.session.id, {
      input: [{ type: "text", text: "wedged" }],
      stream: false,
      metadata: {},
    });
    await engine.started;
    const authority = await gateAtTombstoning(h);

    await expect(h.host.eraseSessionForErasure(authority, h.session.id)).rejects.toMatchObject({
      code: "session_busy",
    });

    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual(["fence"]);
    expect(await h.lease.getOwner(h.session.id)).toMatchObject({ ownerId: "erasure-runner" });
    engine.release();
    await waitFor(() => h.host.activeTurn(h.session.id) === undefined);
    h.lease.expire(h.session.id);
    expect(await h.lease.getOwner(h.session.id)).toBeNull();
  });

  it("reports a remote owner without attempting an erasure commit", async () => {
    const h = await setup([]);
    const authority = await gateAtTombstoning(h);
    await h.lease.acquire(h.session.id, "remote-runner", "10.0.0.9:4010", 30_000);

    await expect(h.host.eraseSessionForErasure(authority, h.session.id)).rejects.toMatchObject({
      code: "session_lease_conflict",
      details: { ownerId: "remote-runner", ownerAddr: "10.0.0.9:4010" },
    });
    expect(h.store.erasureCommits).toEqual([]);
  });

  it("keeps the public delete path gated and uses authority only through the separate store method", async () => {
    const h = await setup([]);
    const authority = await gateAtTombstoning(h);

    await expect(h.host.deleteSession(principal, h.session.id)).rejects.toMatchObject({ code: "not_found" });
    expect(h.store.erasureCommits).toEqual([]);

    await h.host.eraseSessionForErasure(authority, h.session.id);
    expect(h.store.erasureCommits.map(erasureSessionCommitKind)).toEqual(["fence", "tombstone"]);
  });

  it("repairs a legacy archived-active projection without adding an archive bypass to the batch", async () => {
    const h = await setup([]);
    const now = Date.now();
    const turn: Turn = {
      id: newId("turn"),
      sessionId: h.session.id,
      status: "inProgress",
      seqStart: 2,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: now,
    };
    const active = { type: "active" as const, turnId: turn.id, activeFlags: [] };
    await h.store.commit({
      sessionId: h.session.id,
      fence: 0,
      turn,
      events: [
        { type: "turn/started", sessionId: h.session.id, emittedAtMs: now, turn },
        { type: "session/status/changed", sessionId: h.session.id, emittedAtMs: now, status: active },
      ],
      sessionPatch: { status: active },
    });
    h.store.sessions.get(h.session.id)!.archivedAtMs = now;
    const authority = await gateAtTombstoning(h);

    await h.host.eraseSessionForErasure(authority, h.session.id);

    const settlement = h.store.erasureCommits[1]!;
    expect(erasureSessionCommitKind(settlement)).toBe("settlement");
    expect(settlement).not.toHaveProperty("lifecycle");
    expect(h.store.turns.get(turn.id)).toMatchObject({ id: turn.id, status: "interrupted" });
    expect(h.store.erasureCommits.at(-1)).toMatchObject({ action: "tombstone" });
  });
});

describe("erasure session action shape", () => {
  it("rejects user content, accounting, and scheduled purge from the privileged path", () => {
    const authority: ErasureWriteAuthorization = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      requestId: newErasureRequestId(),
      subjectGeneration: 1,
      claimToken: "claim",
      claimAttempt: 1,
    };
    const sessionId = newId("sess");
    const base = { authority, sessionId, fence: 1, action: "tombstone", atMs: Date.now() } as const;
    expect(() => validateErasureSessionAction({
      ...base,
      usageEntries: [],
    } as unknown as ErasureSessionAction)).toThrow(/must not contain usageEntries/);
    expect(() => validateErasureSessionAction({
      ...base,
      purgeAfterMs: Date.now() + 1,
    } as unknown as ErasureSessionAction)).toThrow(/must not contain purgeAfterMs/);
    expect(() => validateErasureSessionAction({
      ...base,
      items: [{ content: "must not pass" }],
      events: [{ type: "session\/deleted" }],
      sessionPatch: { status: { type: "idle" } },
    } as unknown as ErasureSessionAction)).toThrow(/must not contain items/);
  });

  it("rejects malformed drain timeout configuration", async () => {
    const h = await setup([]);
    expect(() => new SessionHost({
      store: h.store,
      erasureStore: h.store,
      lease: h.lease,
      bus: new MemoryEventBus(),
      engine: h.engine,
      providers,
      tools: new StaticToolRegistry([dangerousTool]),
      config: { runnerId: "bad", runnerAddr: "local", erasureDrainTimeoutMs: 0 },
    })).toThrow(/positive safe integer/);
  });

  it("reserves the local-fenced retry signal for an actual erasure drain timeout", async () => {
    const h = await setup([]);
    const begun = await h.host.beginTurn(principal, h.session.id, {
      input: [{ type: "text", text: "ordinary fence" }],
      stream: false,
      metadata: {},
    });
    const internals = h.host as unknown as {
      active: Map<string, {
        fenced: boolean;
        closingRequested: boolean;
        erasureDrainTimedOut?: boolean;
      }>;
      assertNoFencedLocalErasureTurn: (sessionId: string) => void;
    };
    const active = internals.active.get(h.session.id)!;
    active.fenced = true;
    active.closingRequested = true;

    expect(() => internals.assertNoFencedLocalErasureTurn(h.session.id)).not.toThrow();
    active.erasureDrainTimedOut = true;
    expect(() => internals.assertNoFencedLocalErasureTurn(h.session.id)).toThrow(
      "local execution is already fenced and still draining",
    );

    active.erasureDrainTimedOut = false;
    active.fenced = false;
    active.closingRequested = false;
    begun.run();
    await waitFor(() => h.host.activeTurn(h.session.id) === undefined);
  });
});
