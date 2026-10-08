import { describe, expect, it } from "vitest";
import { emptyUsage, type Approval, type Item, type Session, type Turn } from "@agent-service/protocol";
import {
  LEGACY_TOMBSTONE_CUTOVER_ID,
  LegacyTombstoneChildPendingError,
  LegacyTombstoneCutoverConflictError,
  LegacyTombstoneCutoverRequiredError,
  MemorySessionStore,
  legacyTombstoneCompensationJobIdForSession,
  legacyTombstoneUnsafeJobEnvelopeEvidenceSha256,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobClaim,
  type ErasureWriteAuthorization,
  type LegacyTombstoneCompensationAuthorization,
  type LegacyTombstoneCompensationClaim,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

function jobAuthorization(claim: ErasureJobClaim) {
  return {
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function erasureWriteAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires user claim");
  return {
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function compensationAuthorization(
  claim: LegacyTombstoneCompensationClaim,
): LegacyTombstoneCompensationAuthorization {
  return {
    jobId: claim.jobId,
    tenantId: claim.tenantId,
    userId: claim.userId,
    sessionId: claim.sessionId,
    cutoverGeneration: claim.cutoverGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function activate(store: MemorySessionStore, atMs = 250) {
  return store.activateLegacyTombstoneCutover({
    cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
    expectedGeneration: 0,
    actorKeyId: "legacy-maintenance",
    atMs,
  });
}

async function seedLegacySession(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  options: { parentSessionId?: string; createdAtMs?: number; deletedAtMs?: number } = {},
) {
  const createdAtMs = options.createdAtMs ?? 100;
  const deletedAtMs = options.deletedAtMs ?? 200;
  const session: Session = {
    ...mkSession(tenantId, userId),
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
  await store.createSession(session);
  store.deleted.set(session.id, { deletedAtMs, deletionGeneration: 0 });
  return { session, deletedAtMs };
}

async function scheduleAndClaim(
  store: MemorySessionStore,
  nowMs = 300,
  claimToken = "legacy-worker",
) {
  const jobs = await store.scheduleLegacyTombstoneCandidates({
    cutoverGeneration: 1,
    actorKeyId: "legacy-maintenance",
    nowMs,
    limit: 100,
  });
  const claims = await store.claimLegacyTombstoneCompensations({
    nowMs,
    limit: 100,
    leaseMs: 100,
    claimToken,
  });
  return { jobs, claims };
}

async function claimReconcilingUsage(
  store: MemorySessionStore,
  session: Session,
  atMs: number,
): Promise<ErasureJobClaim> {
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "legacy-requester",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs,
  });
  const gated = (await store.claimErasureJobs({
    nowMs: atMs,
    limit: 1,
    leaseMs: 1_000,
    claimToken: "legacy-gated",
  }))[0]!;
  expect(await store.transitionErasureJob(jobAuthorization(gated), {
    fromStatus: "gated",
    toStatus: "draining",
    atMs: atMs + 1,
    availableAtMs: atMs + 1,
  })).toBe(true);
  const draining = (await store.claimErasureJobs({
    nowMs: atMs + 1,
    limit: 1,
    leaseMs: 1_000,
    claimToken: "legacy-draining",
  }))[0]!;
  expect(await store.transitionErasureJob(jobAuthorization(draining), {
    fromStatus: "draining",
    toStatus: "tombstoning",
    atMs: atMs + 2,
    availableAtMs: atMs + 2,
  })).toBe(true);
  const tombstoning = (await store.claimErasureJobs({
    nowMs: atMs + 2,
    limit: 1,
    leaseMs: 1_000,
    claimToken: "legacy-tombstoning",
  }))[0]!;
  expect(await store.transitionErasureJob(jobAuthorization(tombstoning), {
    fromStatus: "tombstoning",
    toStatus: "reconciling_usage",
    atMs: atMs + 3,
    availableAtMs: atMs + 3,
  })).toBe(true);
  return (await store.claimErasureJobs({
    nowMs: atMs + 3,
    limit: 1,
    leaseMs: 1_000,
    claimToken: "legacy-reconciling",
  }))[0]!;
}

async function retryErasureClaim(
  store: MemorySessionStore,
  claim: ErasureJobClaim,
  failedAtMs: number,
): Promise<ErasureJobClaim> {
  expect(await store.retryErasureJob(jobAuthorization(claim), {
    failedAtMs,
    availableAtMs: failedAtMs + 1,
    errorCode: "legacy_blocked",
  })).toBe(true);
  return (await store.claimErasureJobs({
    nowMs: failedAtMs + 1,
    limit: 1,
    leaseMs: 1_000,
    claimToken: `legacy-replay-${failedAtMs}`,
  }))[0]!;
}

async function seedActiveApproval(store: MemorySessionStore, session: Session, nowMs: number) {
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 1,
    usage: emptyUsage(),
    partialText: "historical partial text",
    startedAtMs: nowMs,
  };
  const toolItem: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: nowMs,
    completedAtMs: nowMs,
    type: "toolCall",
    toolCallId: "legacy-tool-call",
    name: "legacy-tool",
    kind: "builtin",
    args: { retained: "only in the business row" },
    startedAtMs: nowMs,
  };
  const approval: Approval = {
    id: newId("apr"),
    sessionId: session.id,
    turnId: turn.id,
    itemId: toolItem.id,
    status: "pending",
    toolCallId: toolItem.toolCallId,
    toolName: toolItem.name,
    args: toolItem.args,
    availableDecisions: ["accept", "decline", "cancel"],
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 10_000,
  };
  const approvalItem: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "inProgress",
    createdAtMs: nowMs,
    type: "approvalRequest",
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    name: approval.toolName,
    args: approval.args,
  };
  await store.commit({
    sessionId: session.id,
    fence: 1,
    turn,
    items: [toolItem, approvalItem],
    approvals: [approval],
    sessionPatch: {
      status: { type: "active", turnId: turn.id, activeFlags: ["waitingOnApproval"] },
      autoApprovedTools: ["legacy-tool"],
    },
  });
  return { turn, approval, approvalItem };
}

async function seedTargetedCompensation(
  userId: string,
): Promise<{
  store: MemorySessionStore;
  session: Session;
  sourceClaim: ErasureJobClaim;
  input: { jobId: string; sessionId: string; atMs: number; availableAtMs: number };
}> {
  const store = new MemorySessionStore();
  const { session } = await seedLegacySession(store, "tenant-targeted-replay", userId);
  await activate(store);
  const sourceClaim = await claimReconcilingUsage(store, session, 300);
  const input = {
    jobId: legacyTombstoneCompensationJobIdForSession(session.id),
    sessionId: session.id,
    atMs: 304,
    availableAtMs: 304,
  };
  await store.scheduleLegacyTombstoneCompensation(erasureWriteAuthorization(sourceClaim), input);
  return { store, session, sourceClaim, input };
}

describe("MemorySessionStore legacy tombstone compensation", () => {
  it("activates the singleton exactly once and refuses scheduling before cutover", async () => {
    const store = new MemorySessionStore();
    await seedLegacySession(store, "tenant-cutover", "u_cutover");
    await expect(store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 10,
    })).rejects.toBeInstanceOf(LegacyTombstoneCutoverRequiredError);

    const first = await activate(store);
    expect(await activate(store)).toEqual(first);
    await expect(store.activateLegacyTombstoneCutover({
      cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
      expectedGeneration: 0,
      actorKeyId: "different-actor",
      atMs: 250,
    })).rejects.toBeInstanceOf(LegacyTombstoneCutoverConflictError);
    expect(await store.getLegacyTombstoneCutover()).toEqual(first);
  });

  it("globally schedules historical gen0 rows without an erasure request and isolates owners", async () => {
    const store = new MemorySessionStore();
    const first = await seedLegacySession(store, "tenant-global-a", "u_global_a");
    const second = await seedLegacySession(store, "tenant-global-b", "historical delegated user");
    await activate(store);

    const jobs = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 100,
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.sourceKind === "maintenance")).toBe(true);
    expect(await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 301,
      limit: 100,
    })).toEqual([]);
    const firstJob = jobs.find((job) => job.sessionId === first.session.id)!;
    expect(await store.getLegacyTombstoneCompensationJob(
      first.session.tenantId,
      first.session.userId,
      firstJob.jobId,
    )).toEqual(firstJob);
    expect(await store.getLegacyTombstoneCompensationJob(
      second.session.tenantId,
      second.session.userId,
      firstJob.jobId,
    )).toBeNull();
  });

  it("terminally isolates a corrupt global candidate without starving its neighbour", async () => {
    const store = new MemorySessionStore();
    const poison = await seedLegacySession(store, "tenant-candidate-poison", "u_poison");
    const neighbor = await seedLegacySession(store, "tenant-candidate-poison", "u_neighbor");
    store.sessions.get(poison.session.id)!.updatedAtMs = poison.deletedAtMs + 1;
    await activate(store);

    const jobs = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    });
    expect(jobs.map((job) => job.sessionId)).toEqual([neighbor.session.id]);
    const poisonJobId = legacyTombstoneCompensationJobIdForSession(poison.session.id);
    expect(store.legacyTombstoneCompensationJobs.get(poisonJobId)).toMatchObject({
      sessionId: poison.session.id,
      status: "terminal_incident",
      terminalReasonCode: "session_integrity_conflict",
    });
    expect(await store.listLegacyTombstoneCompensationAudits(poisonJobId)).toEqual([
      expect.objectContaining({
        type: "legacy_tombstone/terminal_incident",
        reasonCode: "session_integrity_conflict",
      }),
    ]);
    expect(await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 301,
      limit: 10,
    })).toEqual([]);
  });

  it("rolls back a multi-candidate schedule if publication fails", async () => {
    const store = new MemorySessionStore();
    await seedLegacySession(store, "tenant-schedule-rollback", "u_schedule_a");
    await seedLegacySession(store, "tenant-schedule-rollback", "u_schedule_b");
    await activate(store);
    const jobs = store.legacyTombstoneCompensationJobs;
    const originalSet = jobs.set;
    let calls = 0;
    jobs.set = function injected(key, value) {
      calls += 1;
      if (calls === 2) throw new Error("injected schedule publication failure");
      return originalSet.call(this, key, value);
    };
    await expect(store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    })).rejects.toThrow("injected schedule publication failure");
    delete (jobs as unknown as { set?: unknown }).set;
    expect(store.legacyTombstoneCompensationJobs.size).toBe(0);
    expect(await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    })).toHaveLength(2);
  });

  it("preserves deletedAt, appends one continuous terminal event, publishes both intents and audit atomically", async () => {
    const store = new MemorySessionStore();
    const { session, deletedAtMs } = await seedLegacySession(
      store,
      "tenant-success",
      "u_success",
    );
    await activate(store);
    const { claims } = await scheduleAndClaim(store);
    const claim = claims[0]!;
    const authorization = compensationAuthorization(claim);

    const [first, concurrentReplay] = await Promise.all([
      store.completeLegacyTombstoneCompensation(authorization, { completedAtMs: 310 }),
      store.completeLegacyTombstoneCompensation(authorization, { completedAtMs: 310 }),
    ]);
    expect([first?.outcome, concurrentReplay?.outcome].sort()).toEqual([
      "already_compensated",
      "compensated",
    ]);
    expect(store.deleted.get(session.id)).toEqual({ deletedAtMs, deletionGeneration: 1 });
    expect(store.events.get(session.id)?.slice(-1)).toEqual([{
      type: "session/deleted",
      sessionId: session.id,
      emittedAtMs: deletedAtMs,
      deletionGeneration: 1,
      seq: 2,
    }]);
    expect(store.sessions.get(session.id)).toMatchObject({ lastSeq: 2, autoApprovedTools: [] });
    expect(await store.getLifecycleOutbox("session.tombstoned", session.id, 1)).toMatchObject({
      payload: { sessionId: session.id, deletionGeneration: 1, eventSeq: 2 },
      availableAtMs: 310,
      attempts: 0,
    });
    expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toMatchObject({
      payload: { sessionId: session.id, deletionGeneration: 1 },
      attempts: 0,
    });
    expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).not.toHaveProperty(
      "availableAtMs",
    );
    const audits = await store.listLegacyTombstoneCompensationAudits(claim.jobId);
    expect(audits).toEqual([expect.objectContaining({
      type: "legacy_tombstone/compensated",
      sessionId: session.id,
      eventSeq: 2,
      claimAttempt: 1,
    })]);
    expect(audits[0]).not.toHaveProperty("tenantId");
    expect(audits[0]).not.toHaveProperty("userId");
    expect(audits[0]).not.toHaveProperty("payload");
    expect(await store.completeLegacyTombstoneCompensation(authorization, {
      completedAtMs: 999,
    })).toMatchObject({ outcome: "already_compensated", eventSeq: 2 });
  });

  it("fixed-settles an active turn and pending approval in the same publication", async () => {
    const store = new MemorySessionStore();
    const now = Date.now();
    const session: Session = {
      ...mkSession("tenant-active-legacy", "u_active_legacy"),
      createdAtMs: now,
      updatedAtMs: now,
    };
    await store.createSession(session);
    const seeded = await seedActiveApproval(store, session, now + 1);
    const deletedAtMs = Date.now() + 1_000;
    store.deleted.set(session.id, { deletedAtMs, deletionGeneration: 0 });
    await activate(store, deletedAtMs + 1);
    const { claims } = await scheduleAndClaim(store, deletedAtMs + 2);
    const result = await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claims[0]!),
      { completedAtMs: deletedAtMs + 3 },
    );
    expect(result?.outcome).toBe("compensated");
    expect(store.turns.get(seeded.turn.id)).toMatchObject({
      status: "interrupted",
      stopReason: "interrupted",
      completedAtMs: deletedAtMs,
      error: { code: "legacy_tombstone_compensation" },
    });
    expect(store.approvals.get(seeded.approval.id)).toMatchObject({
      status: "expired",
      decision: "cancel",
      decidedBy: "system:erasure",
      resolvedAtMs: deletedAtMs,
    });
    expect(store.items.get(seeded.approvalItem.id)).toMatchObject({
      status: "declined",
      completedAtMs: deletedAtMs,
    });
    expect(store.events.get(session.id)?.slice(-5).map((event) => event.type)).toEqual([
      "approval/resolved",
      "item/completed",
      "turn/completed",
      "session/status/changed",
      "session/deleted",
    ]);
    expect(store.sessions.get(session.id)).toMatchObject({ status: { type: "idle" } });
  });

  it("preserves a non-active error projection like the normal tombstone path", async () => {
    const store = new MemorySessionStore();
    const { session } = await seedLegacySession(store, "tenant-error-legacy", "u_error_legacy");
    store.sessions.get(session.id)!.status = { type: "error", message: "historical failure" };
    await activate(store);
    const { claims } = await scheduleAndClaim(store);
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claims[0]!),
      { completedAtMs: 310 },
    )).toMatchObject({ outcome: "compensated" });
    expect(store.sessions.get(session.id)?.status).toEqual({
      type: "error",
      message: "historical failure",
    });
  });

  it("schedules and claims children before parents and cannot complete a parent early", async () => {
    const store = new MemorySessionStore();
    const parent = await seedLegacySession(store, "tenant-tree-legacy", "u_tree_legacy");
    // Recreate a visible parent just long enough to satisfy the historical child create invariant.
    store.deleted.delete(parent.session.id);
    const child = await seedLegacySession(store, "tenant-tree-legacy", "u_tree_legacy", {
      parentSessionId: parent.session.id,
      createdAtMs: 110,
      deletedAtMs: 210,
    });
    store.deleted.set(parent.session.id, { deletedAtMs: parent.deletedAtMs, deletionGeneration: 0 });
    await activate(store);

    const firstBatch = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    });
    expect(firstBatch.map((job) => job.sessionId)).toEqual([child.session.id]);
    const secondBatch = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    });
    expect(secondBatch.map((job) => job.sessionId)).toEqual([parent.session.id]);

    // Force the parent to the front to prove completion itself still enforces the dependency.
    store.legacyTombstoneCompensationJobs.get(firstBatch[0]!.jobId)!.availableAtMs = 301;
    const parentClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "parent-early",
    }))[0]!;
    expect(parentClaim.sessionId).toBe(parent.session.id);
    await expect(store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 301 },
    )).rejects.toBeInstanceOf(LegacyTombstoneChildPendingError);
    expect(store.deleted.get(parent.session.id)?.deletionGeneration).toBe(0);

    const childClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 301,
      limit: 1,
      leaseMs: 100,
      claimToken: "child-first",
    }))[0]!;
    expect(childClaim.sessionId).toBe(child.session.id);
    await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(childClaim),
      { completedAtMs: 302 },
    );
    await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 303 },
    );
    expect(store.deleted.get(parent.session.id)?.deletionGeneration).toBe(1);
  });

  it("terminally isolates a parent when its generation-zero child is permanently terminal", async () => {
    const store = new MemorySessionStore();
    const parent = await seedLegacySession(store, "tenant-terminal-child", "u_terminal_child");
    store.deleted.delete(parent.session.id);
    const child = await seedLegacySession(store, "tenant-terminal-child", "u_terminal_child", {
      parentSessionId: parent.session.id,
      createdAtMs: 110,
      deletedAtMs: 210,
    });
    store.deleted.set(parent.session.id, { deletedAtMs: 200, deletionGeneration: 0 });
    // Keep the child identity/owner valid, but make its historical marker impossible. The global
    // sweep must isolate that child and the parent must not retry child_pending forever.
    store.deleted.set(child.session.id, { deletedAtMs: 105, deletionGeneration: 0 });
    await activate(store);

    const jobs = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    });
    expect(jobs.map((job) => job.sessionId)).toEqual([parent.session.id]);
    const childJobId = legacyTombstoneCompensationJobIdForSession(child.session.id);
    expect(store.legacyTombstoneCompensationJobs.get(childJobId)).toMatchObject({
      status: "terminal_incident",
      terminalReasonCode: "session_integrity_conflict",
    });

    const parentClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "terminal-child-parent",
    }))[0]!;
    const parentEventsBefore = structuredClone(store.events.get(parent.session.id));
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 301 },
    )).toMatchObject({
      outcome: "terminal_incident",
      reasonCode: "child_dependency_invalid",
    });
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 302 },
    )).toBeNull();
    expect(store.deleted.get(parent.session.id)?.deletionGeneration).toBe(0);
    expect(store.events.get(parent.session.id)).toEqual(parentEventsBefore);
    expect([...store.lifecycleOutbox.values()].filter((intent) => (
      intent.aggregateId === parent.session.id
    ))).toEqual([]);
  });

  it("terminally isolates a legacy parent with a live child that compensation cannot resolve", async () => {
    const store = new MemorySessionStore();
    const parent = await seedLegacySession(store, "tenant-live-child", "u_live_child");
    store.deleted.delete(parent.session.id);
    const child = mkSession("tenant-live-child", "u_live_child");
    child.parentSessionId = parent.session.id;
    child.createdAtMs = 110;
    child.updatedAtMs = 110;
    await store.createSession(child);
    store.deleted.set(parent.session.id, { deletedAtMs: 200, deletionGeneration: 0 });
    await activate(store);

    const parentJob = (await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    }))[0]!;
    expect(parentJob.sessionId).toBe(parent.session.id);
    const parentClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "live-child-parent",
    }))[0]!;

    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 301 },
    )).toMatchObject({
      outcome: "terminal_incident",
      reasonCode: "child_dependency_invalid",
    });
    expect(store.deleted.get(parent.session.id)?.deletionGeneration).toBe(0);
    expect(store.events.get(parent.session.id)).toHaveLength(1);
    expect(store.sessions.get(child.id)?.status).toEqual({ type: "idle" });
  });

  it("terminally isolates a cross-owner child instead of accepting its tombstone proof", async () => {
    const store = new MemorySessionStore();
    const parent = await seedLegacySession(store, "tenant-parent-owner", "u_parent_owner");
    const child: Session = {
      ...mkSession("tenant-child-owner", "u_child_owner"),
      createdAtMs: 100,
      updatedAtMs: 100,
    };
    await store.createSession(child);
    await store.commit({
      sessionId: child.id,
      fence: 1,
      lifecycle: {
        type: "tombstone",
        atMs: 200,
        purgeAfterMs: null,
        deletionGeneration: 1,
        tenantId: child.tenantId,
        userId: child.userId,
      },
      events: [{
        type: "session/deleted",
        sessionId: child.id,
        emittedAtMs: 200,
        deletionGeneration: 1,
      }],
      sessionPatch: { autoApprovedTools: [] },
    });
    store.sessions.get(child.id)!.parentSessionId = parent.session.id;
    await activate(store);
    const jobs = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    });
    expect(jobs.map((job) => job.sessionId)).toEqual([parent.session.id]);
    const parentClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "cross-owner-parent",
    }))[0]!;
    expect(parentClaim.sessionId).toBe(parent.session.id);
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(parentClaim),
      { completedAtMs: 301 },
    )).toMatchObject({
      outcome: "terminal_incident",
      reasonCode: "child_dependency_invalid",
    });
    expect(store.deleted.get(parent.session.id)?.deletionGeneration).toBe(0);
  });

  it("turns an ancestry cycle into a terminal incident rather than permanent child_pending", async () => {
    const store = new MemorySessionStore();
    const parent = await seedLegacySession(store, "tenant-cycle", "u_cycle");
    store.deleted.delete(parent.session.id);
    const child = await seedLegacySession(store, "tenant-cycle", "u_cycle", {
      parentSessionId: parent.session.id,
      createdAtMs: 110,
      deletedAtMs: 210,
    });
    store.deleted.set(parent.session.id, { deletedAtMs: 200, deletionGeneration: 0 });
    store.sessions.get(parent.session.id)!.parentSessionId = child.session.id;
    await activate(store);
    expect(await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    })).toHaveLength(2);
    const claim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "cycle-worker",
    }))[0]!;
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claim),
      { completedAtMs: 301 },
    )).toMatchObject({
      outcome: "terminal_incident",
      reasonCode: "child_dependency_invalid",
    });
  });

  it("supports a live erasure-claim-bound enqueue without allowing cross-owner scheduling", async () => {
    const store = new MemorySessionStore();
    const target = await seedLegacySession(store, "tenant-claimed", "u_claimed");
    const neighbor = await seedLegacySession(store, "tenant-claimed", "u_neighbor");
    await activate(store);
    const claim = await claimReconcilingUsage(store, target.session, 300);
    const authority = erasureWriteAuthorization(claim);
    await expect(store.scheduleLegacyTombstoneCompensation(authority, {
      jobId: legacyTombstoneCompensationJobIdForSession(neighbor.session.id),
      sessionId: neighbor.session.id,
      atMs: 304,
      availableAtMs: 304,
    })).rejects.toThrow();
    const input = {
      jobId: legacyTombstoneCompensationJobIdForSession(target.session.id),
      sessionId: target.session.id,
      atMs: 304,
      availableAtMs: 304,
    };
    const scheduled = await store.scheduleLegacyTombstoneCompensation(authority, input);
    expect(scheduled).toMatchObject({
      sourceKind: "erasure_claim",
      sourceRequestId: authority.requestId,
      sourceSubjectGeneration: authority.subjectGeneration,
      sourceClaimAttempt: authority.claimAttempt,
    });
    expect(await store.scheduleLegacyTombstoneCompensation(authority, input)).toEqual(scheduled);
  });

  it("replays a pending targeted job across source claim attempts without rewriting first proof", async () => {
    const { store, sourceClaim, input } = await seedTargetedCompensation("u_target_pending");
    const first = structuredClone(store.legacyTombstoneCompensationJobs.get(input.jobId)!);
    const nextClaim = await retryErasureClaim(store, sourceClaim, 305);
    const replay = await store.scheduleLegacyTombstoneCompensation(
      erasureWriteAuthorization(nextClaim),
      { ...input, atMs: 307, availableAtMs: 320 },
    );
    expect(replay).toEqual(first);
    expect(replay).toMatchObject({
      sourceKind: "erasure_claim",
      sourceClaimAttempt: sourceClaim.attempts,
      createdAtMs: 304,
      availableAtMs: 304,
    });
    const stored = store.legacyTombstoneCompensationJobs.get(input.jobId)!;
    if (stored.sourceKind !== "erasure_claim") throw new Error("expected erasure source");
    stored.sourceRequestId = newErasureRequestId();
    await expect(store.scheduleLegacyTombstoneCompensation(
      erasureWriteAuthorization(nextClaim),
      { ...input, atMs: 307, availableAtMs: 320 },
    )).rejects.toThrow("identity conflicts");
  });

  it("replays a completed targeted job across source claim attempts", async () => {
    const { store, sourceClaim, input } = await seedTargetedCompensation("u_target_completed");
    const compensation = (await store.claimLegacyTombstoneCompensations({
      nowMs: 304,
      limit: 1,
      leaseMs: 100,
      claimToken: "complete-targeted",
    }))[0]!;
    await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(compensation),
      { completedAtMs: 305 },
    );
    const completed = structuredClone(store.legacyTombstoneCompensationJobs.get(input.jobId)!);
    const nextClaim = await retryErasureClaim(store, sourceClaim, 306);
    expect(await store.scheduleLegacyTombstoneCompensation(
      erasureWriteAuthorization(nextClaim),
      { ...input, atMs: 308, availableAtMs: 308 },
    )).toEqual(completed);
    expect(completed.status).toBe("completed");
  });

  it("replays a terminal targeted job across source claim attempts", async () => {
    const { store, session, sourceClaim, input } = await seedTargetedCompensation("u_target_terminal");
    const compensation = (await store.claimLegacyTombstoneCompensations({
      nowMs: 304,
      limit: 1,
      leaseMs: 100,
      claimToken: "terminal-targeted",
    }))[0]!;
    store.deleted.get(session.id)!.purgeAfterMs = 999;
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(compensation),
      { completedAtMs: 305 },
    )).toMatchObject({ outcome: "terminal_incident" });
    const terminal = structuredClone(store.legacyTombstoneCompensationJobs.get(input.jobId)!);
    const nextClaim = await retryErasureClaim(store, sourceClaim, 306);
    expect(await store.scheduleLegacyTombstoneCompensation(
      erasureWriteAuthorization(nextClaim),
      { ...input, atMs: 308, availableAtMs: 308 },
    )).toEqual(terminal);
    expect(terminal.status).toBe("terminal_incident");
  });

  it("returns an existing terminal maintenance job to a later targeted request without changing provenance", async () => {
    const store = new MemorySessionStore();
    const { session } = await seedLegacySession(store, "tenant-maint-target", "u_maint_target");
    await activate(store);
    const maintenance = (await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    }))[0]!;
    const maintenanceClaim = (await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 100,
      claimToken: "maintenance-terminal",
    }))[0]!;
    store.deleted.get(session.id)!.purgeAfterMs = 999;
    await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(maintenanceClaim),
      { completedAtMs: 301 },
    );
    const terminalMaintenance = structuredClone(
      store.legacyTombstoneCompensationJobs.get(maintenance.jobId)!,
    );
    const sourceClaim = await claimReconcilingUsage(store, session, 310);
    const replay = await store.scheduleLegacyTombstoneCompensation(
      erasureWriteAuthorization(sourceClaim),
      {
        jobId: legacyTombstoneCompensationJobIdForSession(session.id),
        sessionId: session.id,
        atMs: 314,
        availableAtMs: 314,
      },
    );
    expect(replay).toEqual(terminalMaintenance);
    expect(replay).toMatchObject({
      sourceKind: "maintenance",
      maintenanceActorKeyId: "legacy-maintenance",
      status: "terminal_incident",
    });
  });

  it("uses token plus attempt CAS for takeover, renew, retry and completion", async () => {
    const store = new MemorySessionStore();
    await seedLegacySession(store, "tenant-aba-legacy", "u_aba_legacy");
    await activate(store);
    await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 1,
    });
    const [firstRace, competingRace] = await Promise.all([
      store.claimLegacyTombstoneCompensations({
        nowMs: 300,
        limit: 1,
        leaseMs: 10,
        claimToken: "reused-token",
      }),
      store.claimLegacyTombstoneCompensations({
        nowMs: 300,
        limit: 1,
        leaseMs: 10,
        claimToken: "competing-token",
      }),
    ]);
    expect([firstRace.length, competingRace.length].sort()).toEqual([0, 1]);
    const first = (firstRace[0] ?? competingRace[0])!;
    expect(await store.renewLegacyTombstoneCompensation(
      compensationAuthorization(first),
      { nowMs: 301, leaseMs: 1 },
    )).toBe(true);
    expect(store.legacyTombstoneCompensationJobs.get(first.jobId)?.leaseUntilMs).toBe(310);
    const taken = (await store.claimLegacyTombstoneCompensations({
      nowMs: 310,
      limit: 1,
      leaseMs: 20,
      claimToken: "reused-token",
    }))[0]!;
    expect(taken.attempts).toBe(2);
    expect(await store.renewLegacyTombstoneCompensation(
      compensationAuthorization(first),
      { nowMs: 310, leaseMs: 100 },
    )).toBe(false);
    expect(await store.retryLegacyTombstoneCompensation(
      compensationAuthorization(first),
      { failedAtMs: 310, availableAtMs: 311, errorCode: "temporary_failure" },
    )).toBe(false);
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(first),
      { completedAtMs: 310 },
    )).toBeNull();
    expect(await store.renewLegacyTombstoneCompensation(
      compensationAuthorization(taken),
      { nowMs: 311, leaseMs: 50 },
    )).toBe(true);
    expect(await store.retryLegacyTombstoneCompensation(
      compensationAuthorization(taken),
      { failedAtMs: 312, availableAtMs: 320, errorCode: "owner_unavailable" },
    )).toBe(true);
    expect(await store.claimLegacyTombstoneCompensations({
      nowMs: 319,
      limit: 1,
      leaseMs: 20,
      claimToken: "too-early",
    })).toEqual([]);
    const retried = (await store.claimLegacyTombstoneCompensations({
      nowMs: 320,
      limit: 1,
      leaseMs: 20,
      claimToken: "retry-owner",
    }))[0]!;
    expect(retried.attempts).toBe(3);
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(taken),
      { completedAtMs: 320 },
    )).toBeNull();
    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(retried),
      { completedAtMs: 321 },
    )).toMatchObject({ outcome: "compensated" });
  });

  it("terminally isolates an unsafe job envelope and still claims its neighbour", async () => {
    const store = new MemorySessionStore();
    await seedLegacySession(store, "tenant-poison-legacy", "u_poison_a");
    await seedLegacySession(store, "tenant-poison-legacy", "u_poison_b");
    await seedLegacySession(store, "tenant-poison-legacy", "u_poison_c");
    await activate(store);
    const jobs = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 300,
      limit: 2,
    });
    const poison = store.legacyTombstoneCompensationJobs.get(jobs[0]!.jobId)!;
    poison.attempts = Number.NaN;
    poison.availableAtMs = Number.NaN;

    const claimed = await store.claimLegacyTombstoneCompensations({
      nowMs: 300,
      limit: 1,
      leaseMs: 50,
      claimToken: "surviving-worker",
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.jobId).toBe(jobs[1]!.jobId);
    const incidents = store.legacyTombstoneCompensationAudits.get(jobs[0]!.jobId)!;
    expect(incidents).toEqual([expect.objectContaining({
      type: "legacy_tombstone/terminal_incident",
      reasonCode: "unsafe_job_envelope",
    })]);
    const expected = legacyTombstoneUnsafeJobEnvelopeEvidenceSha256({
      locatorJobId: jobs[0]!.jobId,
      jobId: poison.jobId,
      tenantId: poison.tenantId,
      userId: poison.userId,
      sessionId: poison.sessionId,
      sourceRequestId: null,
      sourceKind: "maintenance",
      rawSourceSubjectGeneration: null,
      rawSourceClaimAttempt: null,
      sourceClaimTokenSha256: null,
      maintenanceActorKeyId: "legacy-maintenance",
      rawCutoverGeneration: "1",
      rawLegacyDeletedAtMs: "200",
      status: "pending",
      rawCreatedAtMs: "300",
      rawUpdatedAtMs: "300",
      rawAvailableAtMs: "NaN",
      rawAttempts: "NaN",
      claimToken: null,
      rawLeaseUntilMs: null,
    });
    expect(incidents[0]!.evidenceSha256).toBe(expected);
    const later = await store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: "legacy-maintenance",
      nowMs: 301,
      limit: 10,
    });
    expect(later).toHaveLength(1);
    expect(later[0]!.jobId).not.toBe(jobs[0]!.jobId);
  });

  it("writes a terminal incident for deterministic proof corruption without fabricating success", async () => {
    const store = new MemorySessionStore();
    const { session } = await seedLegacySession(store, "tenant-proof-legacy", "u_proof_legacy");
    await activate(store);
    const { claims } = await scheduleAndClaim(store);
    const beforeEvents = structuredClone(store.events.get(session.id));
    store.deleted.get(session.id)!.purgeAfterMs = 999;

    const result = await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claims[0]!),
      { completedAtMs: 310 },
    );
    expect(result).toMatchObject({ outcome: "terminal_incident", reasonCode: "proof_conflict" });
    const terminalAuthorization = compensationAuthorization(claims[0]!);
    expect(await store.completeLegacyTombstoneCompensation(
      terminalAuthorization,
      { completedAtMs: 311 },
    )).toBeNull();
    expect(await store.completeLegacyTombstoneCompensation(
      { ...terminalAuthorization, claimToken: "terminal-replay-token" },
      { completedAtMs: 311 },
    )).toBeNull();
    expect(await store.completeLegacyTombstoneCompensation(
      {
        ...terminalAuthorization,
        claimToken: "terminal-next-attempt",
        claimAttempt: terminalAuthorization.claimAttempt + 1,
      },
      { completedAtMs: 311 },
    )).toBeNull();
    expect(store.deleted.get(session.id)).toEqual({
      deletedAtMs: 200,
      deletionGeneration: 0,
      purgeAfterMs: 999,
    });
    expect(store.events.get(session.id)).toEqual(beforeEvents);
    expect(store.lifecycleOutbox.size).toBe(0);
    expect(store.legacyTombstoneCompensationJobs.get(claims[0]!.jobId)).toMatchObject({
      status: "terminal_incident",
      terminalReasonCode: "proof_conflict",
    });
  });

  it("rejects an event log that claims activity after the historical deletion", async () => {
    const store = new MemorySessionStore();
    const { session, deletedAtMs } = await seedLegacySession(
      store,
      "tenant-event-time-legacy",
      "u_event_time_legacy",
    );
    store.events.get(session.id)![0]!.emittedAtMs = deletedAtMs + 1;
    await activate(store);
    const { claims } = await scheduleAndClaim(store);

    expect(await store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claims[0]!),
      { completedAtMs: 310 },
    )).toMatchObject({
      outcome: "terminal_incident",
      reasonCode: "session_integrity_conflict",
    });
    expect(store.deleted.get(session.id)?.deletionGeneration).toBe(0);
    expect(store.lifecycleOutbox.size).toBe(0);
  });

  it("rolls back every publication on an injected Map failure", async () => {
    const store = new MemorySessionStore();
    const { session } = await seedLegacySession(store, "tenant-rollback-legacy", "u_rollback_legacy");
    await activate(store);
    const { claims } = await scheduleAndClaim(store);
    const authorization = compensationAuthorization(claims[0]!);
    const before = structuredClone({
      session: store.sessions.get(session.id),
      events: store.events.get(session.id),
      marker: store.deleted.get(session.id),
      job: store.legacyTombstoneCompensationJobs.get(claims[0]!.jobId),
      outboxes: [...store.lifecycleOutbox.entries()],
      audits: [...store.legacyTombstoneCompensationAudits.entries()],
      nextOutboxId: (store as unknown as { nextLifecycleOutboxId: number }).nextLifecycleOutboxId,
      nextAuditId: (store as unknown as { nextLegacyTombstoneAuditId: number }).nextLegacyTombstoneAuditId,
    });
    const outbox = store.lifecycleOutbox as Map<string, typeof store.lifecycleOutbox extends Map<string, infer V> ? V : never>;
    const originalSet = outbox.set;
    let calls = 0;
    outbox.set = function injected(key, value) {
      calls += 1;
      if (calls === 2) throw new Error("injected outbox publication failure");
      return originalSet.call(this, key, value);
    };
    await expect(store.completeLegacyTombstoneCompensation(authorization, {
      completedAtMs: 310,
    })).rejects.toThrow("injected outbox publication failure");
    delete (outbox as unknown as { set?: unknown }).set;
    expect(structuredClone({
      session: store.sessions.get(session.id),
      events: store.events.get(session.id),
      marker: store.deleted.get(session.id),
      job: store.legacyTombstoneCompensationJobs.get(claims[0]!.jobId),
      outboxes: [...store.lifecycleOutbox.entries()],
      audits: [...store.legacyTombstoneCompensationAudits.entries()],
      nextOutboxId: (store as unknown as { nextLifecycleOutboxId: number }).nextLifecycleOutboxId,
      nextAuditId: (store as unknown as { nextLegacyTombstoneAuditId: number }).nextLegacyTombstoneAuditId,
    })).toEqual(before);
  });

  it("does not turn an unknown serialization failure into a terminal incident", async () => {
    const store = new MemorySessionStore();
    const { session } = await seedLegacySession(store, "tenant-unknown-legacy", "u_unknown_legacy");
    await activate(store);
    const { claims } = await scheduleAndClaim(store);
    const jobBefore = structuredClone(store.legacyTombstoneCompensationJobs.get(claims[0]!.jobId));
    store.events.get(session.id)!.push({
      type: "warning",
      sessionId: session.id,
      emittedAtMs: 200,
      seq: 2,
      code: "corrupt",
      message: "corrupt",
      uncloneable: () => undefined,
    } as never);

    await expect(store.completeLegacyTombstoneCompensation(
      compensationAuthorization(claims[0]!),
      { completedAtMs: 310 },
    )).rejects.toThrow();
    expect(store.deleted.get(session.id)?.deletionGeneration).toBe(0);
    expect(store.lifecycleOutbox.size).toBe(0);
    expect(store.legacyTombstoneCompensationAudits.size).toBe(0);
    expect(store.legacyTombstoneCompensationJobs.get(claims[0]!.jobId)).toEqual(jobBefore);
  });
});
