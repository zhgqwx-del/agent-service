import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyUsage, type Approval, type Item, type Session, type Turn } from "@agent-service/protocol";
import {
  attachSessionWriteAdmission, createSessionAcquireCommand, type SessionLeaseProof, type SessionStore,
  FenceError,
  MemorySessionStore,
  SessionGoneError,
  SessionHasChildrenError,
  SessionLifecycleBusyError,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobClaim,
  type ErasureWriteAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { captureSessionLeaseProof } from "../src/session-authority.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";

/** Fixed erasure command, separate from ordinary setup. No DB-floor read or proof by number. */
async function acquireErasureLease(store: SessionStore, session: Pick<Session, "id" | "tenantId" | "userId">,
  authority: ErasureWriteAuthorization, expectedFence: number, predecessor?: SessionLeaseProof) {
  const previous = predecessor ? captureSessionLeaseProof(predecessor) : undefined;
  const command = createSessionAcquireCommand({ sessionId: session.id,
    principal: { tenantId: session.tenantId, userId: session.userId }, expectedFence,
    runnerId: previous?.runnerId ?? "erasure-fixture", runnerAddr: previous?.runnerAddr ?? "127.0.0.1:1",
    bootId: previous?.bootId ?? randomUUID(), acquisitionId: randomUUID(), ttlMs: 30_000 });
  const result = await store.sessionAuthority.acquireForErasure(command, authority, predecessor);
  expect(result).toMatchObject({ ok: true, fence: expectedFence + 1 });
  if (!result.ok) throw Error("fixture_erasure_authority_not_acquired");
  return { command, proof: result.proof, fence: result.fence,
    admit<T extends object>(input: T): T { return attachSessionWriteAdmission(input, result.proof); },
    release: () => store.sessionAuthority.release(result.proof) };
}


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

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user claim");
  return {
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    requestId: claim.requestId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimDraining(store: MemorySessionStore, session: Session): Promise<ErasureJobClaim> {
  const now = Date.now();
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "admin-memory",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs: now,
  });
  const gated = (await store.claimErasureJobs({
    nowMs: now,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "memory-gated",
  }))[0]!;
  expect(await store.transitionErasureJob(jobAuthorization(gated), {
    fromStatus: "gated",
    toStatus: "draining",
    atMs: now + 1,
    availableAtMs: now + 1,
  })).toBe(true);
  return (await store.claimErasureJobs({
    nowMs: now + 1,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "memory-draining",
  }))[0]!;
}

async function claimTombstoning(store: MemorySessionStore, session: Session): Promise<ErasureJobClaim> {
  const draining = await claimDraining(store, session);
  const atMs = Math.max(Date.now(), draining.availableAtMs + 1);
  expect(await store.transitionErasureJob(jobAuthorization(draining), {
    fromStatus: "draining",
    toStatus: "tombstoning",
    atMs,
    availableAtMs: atMs,
  })).toBe(true);
  return (await store.claimErasureJobs({
    nowMs: atMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "memory-tombstoning",
  }))[0]!;
}

async function seedActiveApproval(store: MemorySessionStore, session: Session) {
  const now = Date.now();
  const turn: Turn = {
    id: newId("turn"),
    sessionId: session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 1,
    usage: emptyUsage(),
    partialText: "preserved partial",
    metadata: { source: "existing" },
    startedAtMs: now,
  };
  const approvalRequestId = newId("item");
  const historicalToolItem: Item = {
    id: newId("item"),
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    createdAtMs: now,
    completedAtMs: now,
    type: "toolCall",
    toolCallId: "tool-call-existing",
    name: "danger",
    kind: "builtin",
    args: { value: "preserve" },
    startedAtMs: now,
  };
  const approval: Approval = {
    id: newId("apr"),
    sessionId: session.id,
    turnId: turn.id,
    // Historical writers could point this field at the tool-call item. Erasure must associate the
    // approvalRequest through its approvalId instead of trusting this legacy field.
    itemId: historicalToolItem.id,
    status: "pending",
    toolCallId: historicalToolItem.toolCallId,
    toolName: historicalToolItem.name,
    args: historicalToolItem.args,
    availableDecisions: ["accept", "decline", "cancel"],
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  };
  const approvalRequest: Item = {
    id: approvalRequestId,
    sessionId: session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "inProgress",
    createdAtMs: now,
    type: "approvalRequest",
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    name: approval.toolName,
    args: approval.args,
  };
  const lease = await acquireFixtureSessionAuthority(store, session, 0);
  await store.commit(lease.admit({
    sessionId: session.id,
    fence: 1,
    turn,
    approvals: [approval],
    items: [historicalToolItem, approvalRequest],
    sessionPatch: {
      status: { type: "active", turnId: turn.id, activeFlags: ["waitingOnApproval"] },
      autoApprovedTools: ["already-approved"],
    },
  }));
  return { turn, approval, historicalToolItem, approvalRequest, lease };
}

function stateProof(store: MemorySessionStore, sessionId: string) {
  return structuredClone({
    session: store.sessions.get(sessionId),
    turns: [...store.turns.entries()],
    items: [...store.items.entries()],
    approvals: [...store.approvals.entries()],
    events: store.events.get(sessionId),
    deleted: store.deleted.get(sessionId),
    outbox: [...store.lifecycleOutbox.entries()],
    nextOutboxId: (store as unknown as { nextLifecycleOutboxId: number }).nextLifecycleOutboxId,
    authority: { bindingId: (store.sessionAuthority as unknown as { bindingId: string }).bindingId,
      tuples: (store.sessionAuthority as unknown as { tuples: Map<string, unknown> }).tuples },
  });
}

describe("MemorySessionStore fixed erasure session actions", () => {
  it("keeps the head minimal and derives settlement, tombstone and both outboxes from existing rows", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-memory", "u_memory_target");
    await store.createSession(session);
    const seeded = await seedActiveApproval(store, session);
    const claim = await claimTombstoning(store, session);
    const authority = writeAuthorization(claim);

    const head = await store.getErasureSessionHead(authority, session.id);
    expect(head).toEqual({
      sessionId: session.id,
      fenceToken: 1,
      tenantId: session.tenantId,
      userId: session.userId,
      activeTurnId: seeded.turn.id,
      deleted: false,
      deletionGeneration: 0,
    });
    expect(Object.keys(head!).sort()).toEqual([
      "activeTurnId",
      "deleted",
      "deletionGeneration",
      "fenceToken",
      "sessionId",
      "tenantId",
      "userId",
    ]);

    const beforeRemote=stateProof(store,session.id);
    const remote=createSessionAcquireCommand({sessionId:session.id,principal:{tenantId:session.tenantId,userId:session.userId},
      expectedFence:1,runnerId:"remote-erasure-fixture",runnerAddr:"127.0.0.1:2",bootId:randomUUID(),acquisitionId:randomUUID(),ttlMs:30_000});
    expect(await store.sessionAuthority.acquireForErasure(remote,authority)).toMatchObject({ok:false,reason:"busy"});
    expect(stateProof(store,session.id)).toEqual(beforeRemote);
    const lease = await acquireErasureLease(store, session, authority, 1, seeded.lease.proof);
    expect(lease.fence).toBe(2);
    const beforeFence = structuredClone(store.sessions.get(session.id)!);
    expect(await store.applyErasureSessionAction(lease.admit({
      authority,
      sessionId: session.id,
      fence: 2,
      action: "fence",
    }))).toEqual({ events: [], lastSeq: 1 });
    expect(store.sessions.get(session.id)).toEqual({ ...beforeFence, fenceToken: 2 });

    const settledAtMs = Math.max(seeded.turn.startedAtMs, store.sessions.get(session.id)!.updatedAtMs);
    const settled = await store.applyErasureSessionAction(lease.admit({
      authority,
      sessionId: session.id,
      fence: 2,
      action: "settle",
      atMs: seeded.turn.startedAtMs - 1,
    }));
    expect(settled.events.map((event) => event.type)).toEqual([
      "approval/resolved",
      "item/completed",
      "turn/completed",
      "session/status/changed",
    ]);
    expect(settled.events.map((event) => event.seq)).toEqual([2, 3, 4, 5]);
    expect(store.turns.get(seeded.turn.id)).toMatchObject({
      status: "interrupted",
      stopReason: "interrupted",
      partialText: "preserved partial",
      metadata: { source: "existing" },
      completedAtMs: settledAtMs,
      seqEnd: 5,
      error: { code: "erasure", message: "turn interrupted for user erasure" },
    });
    expect(store.approvals.get(seeded.approval.id)).toMatchObject({
      itemId: seeded.historicalToolItem.id,
      status: "expired",
      decision: "cancel",
      decidedBy: "system:erasure",
      resolvedAtMs: settledAtMs,
    });
    expect(store.items.get(seeded.approvalRequest.id)).toMatchObject({
      status: "declined",
      completedAtMs: settledAtMs,
    });
    expect(store.items.get(seeded.historicalToolItem.id)).toEqual(seeded.historicalToolItem);
    expect(store.sessions.get(session.id)).toMatchObject({
      status: { type: "idle" },
      autoApprovedTools: ["already-approved"],
      fenceToken: 2,
      lastSeq: 5,
    });

    const tombstoned = await store.applyErasureSessionAction(lease.admit({
      authority,
      sessionId: session.id,
      fence: 2,
      action: "tombstone",
      atMs: seeded.turn.startedAtMs - 2,
    }));
    expect(tombstoned).toMatchObject({ lastSeq: 6, lifecycleGeneration: 1 });
    expect(tombstoned.events).toEqual([expect.objectContaining({
      type: "session/deleted",
      seq: 6,
      deletionGeneration: 1,
    })]);
    expect(store.sessions.get(session.id)).toMatchObject({ autoApprovedTools: [], lastSeq: 6 });
    expect(store.deleted.get(session.id)).toMatchObject({ deletionGeneration: 1 });

    const delivered = await store.getLifecycleOutbox("session.tombstoned", session.id, 1);
    const purge = await store.getLifecycleOutbox("session.purge", session.id, 1);
    expect(delivered).toMatchObject({
      topic: "session.tombstoned",
      payload: { sessionId: session.id, deletionGeneration: 1, eventSeq: 6 },
      availableAtMs: expect.any(Number),
    });
    expect(purge).toMatchObject({
      topic: "session.purge",
      payload: { sessionId: session.id, deletionGeneration: 1 },
    });
    expect(purge).not.toHaveProperty("availableAtMs");
    await expect(store.claimLifecycleOutbox({
      topics: ["session.purge"],
      nowMs: Date.now() + 10,
      limit: 10,
      leaseMs: 1_000,
      claimToken: "memory-purge-must-remain-disabled",
    })).rejects.toThrow("not claimable by this store");
    if (!purge) throw new Error("missing dormant purge intent");
    const dormantPurge = [...store.lifecycleOutbox.values()].find(
      (row) => row.outboxId === purge.outboxId,
    );
    if (!dormantPurge) throw new Error("missing raw dormant purge intent");
    const ackAtMs = Date.now();
    dormantPurge.attempts = 1;
    dormantPurge.claimToken = "legacy-purge-claim";
    dormantPurge.leaseUntilMs = ackAtMs + 1_000;
    expect(await store.renewLifecycleOutboxClaim(
      purge.outboxId,
      "legacy-purge-claim",
      { nowMs: ackAtMs, leaseMs: 2_000 },
    )).toBe(false);
    expect(await store.completeLifecycleOutbox(
      purge.outboxId,
      "legacy-purge-claim",
      ackAtMs,
    )).toBe(false);
    expect(await store.retryLifecycleOutbox(purge.outboxId, "legacy-purge-claim", {
      failedAtMs: ackAtMs,
      availableAtMs: ackAtMs + 100,
      error: "must stay dormant",
      maxAttempts: 2,
    })).toBe(false);
    expect(dormantPurge).toMatchObject({
      topic: "session.purge",
      attempts: 1,
      claimToken: "legacy-purge-claim",
      leaseUntilMs: ackAtMs + 1_000,
    });
    expect(dormantPurge).not.toHaveProperty("availableAtMs");
    expect(dormantPurge).not.toHaveProperty("completedAtMs");
    expect(dormantPurge).not.toHaveProperty("deadLetteredAtMs");
    delete dormantPurge.claimToken;
    delete dormantPurge.leaseUntilMs;
    dormantPurge.attempts = 0;
    expect(await store.claimLifecycleOutbox({
      topics: ["session.tombstoned"],
      nowMs: Date.now() + 10,
      limit: 10,
      leaseMs: 1_000,
      claimToken: "memory-outbox-worker",
    })).toEqual([expect.objectContaining({ topic: "session.tombstoned" })]);

    expect(await store.getErasureSessionHead(authority, session.id)).toEqual({
      sessionId: session.id,
      fenceToken: 2,
      tenantId: session.tenantId,
      userId: session.userId,
      deleted: true,
      deletionGeneration: 1,
    });
    const beforeRetry = stateProof(store, session.id);
    expect(await store.applyErasureSessionAction(lease.admit({
      authority,
      sessionId: session.id,
      fence: 2,
      action: "tombstone",
      atMs: Date.now(),
    }))).toEqual({ events: [], lastSeq: 6, lifecycleGeneration: 1 });
    expect(stateProof(store, session.id)).toEqual(beforeRetry);
  });

  it("enforces phase, exact lease boundary and claimAttempt ABA without partial writes", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-authority", "u_authority");
    await store.createSession(session);
    const drainingClaim = await claimDraining(store, session);
    const drainingAuthority = writeAuthorization(drainingClaim);
    const drainingLease = await acquireErasureLease(store, session, drainingAuthority, 0);
    await store.applyErasureSessionAction(drainingLease.admit({
      authority: drainingAuthority,
      sessionId: session.id,
      fence: 1,
      action: "fence",
    }));
    const afterFence = stateProof(store, session.id);
    await expect(store.applyErasureSessionAction(drainingLease.admit({
      authority: drainingAuthority,
      sessionId: session.id,
      fence: 1,
      action: "settle",
      atMs: Date.now(),
    }))).rejects.toThrow("stale erasure authority");
    expect(stateProof(store, session.id)).toEqual(afterFence);

    const transitionAt = Date.now();
    expect(await store.transitionErasureJob(jobAuthorization(drainingClaim), {
      fromStatus: "draining",
      toStatus: "tombstoning",
      atMs: transitionAt,
      availableAtMs: transitionAt,
    })).toBe(true);
    const first = (await store.claimErasureJobs({
      nowMs: transitionAt,
      limit: 1,
      leaseMs: 10_000,
      claimToken: "memory-aba-token",
    }))[0]!;
    const firstAuthority = writeAuthorization(first);
    const firstLease = await acquireErasureLease(store, session, firstAuthority, 1, drainingLease.proof);
    const request = store.erasureRequests.get(first.requestId)!;
    const takeoverAt = Math.max(Date.now() + 2, request.availableAtMs!);
    request.leaseUntilMs = takeoverAt;
    const second = (await store.claimErasureJobs({
      nowMs: takeoverAt,
      limit: 1,
      leaseMs: 120_000,
      claimToken: "memory-aba-token",
    }))[0]!;
    expect(second.attempts).toBe(first.attempts + 1);
    const secondAuthority = writeAuthorization(second);
    const secondLease = await acquireErasureLease(store, session, secondAuthority, 2, firstLease.proof);
    const beforeStale = stateProof(store, session.id);
    await expect(store.applyErasureSessionAction(firstLease.admit({
      authority: firstAuthority,
      sessionId: session.id,
      fence: 2,
      action: "fence",
    }))).rejects.toThrow("stale erasure authority");
    expect(stateProof(store, session.id)).toEqual(beforeStale);

    await store.applyErasureSessionAction(secondLease.admit({
      authority: secondAuthority,
      sessionId: session.id,
      fence: 3,
      action: "fence",
    }));
    const afterTakeoverFence = stateProof(store, session.id);
    store.erasureRequests.get(second.requestId)!.leaseUntilMs = Date.now();
    await expect(store.applyErasureSessionAction(secondLease.admit({
      authority: secondAuthority,
      sessionId: session.id,
      fence: 3,
      action: "fence",
    }))).rejects.toThrow("stale erasure authority");
    expect(stateProof(store, session.id)).toEqual(afterTakeoverFence);
  });

  it("fails closed on missing/terminal turns, orphaned approvals and clone failure", async () => {
    const missingStore = new MemorySessionStore();
    const missingSession = mkSession("tenant-erasure-corrupt", "u_missing_turn");
    await missingStore.createSession(missingSession);
    const missingSeed = await seedActiveApproval(missingStore, missingSession);
    const missingAuthority = writeAuthorization(await claimTombstoning(missingStore, missingSession));
    const missingLease = await acquireErasureLease(missingStore, missingSession, missingAuthority, 1, missingSeed.lease.proof);
    await missingStore.applyErasureSessionAction(missingLease.admit({
      authority: missingAuthority, sessionId: missingSession.id, fence: 2, action: "fence",
    }));
    missingStore.turns.delete(missingSeed.turn.id);
    const beforeMissing = stateProof(missingStore, missingSession.id);
    await expect(missingStore.applyErasureSessionAction(missingLease.admit({
      authority: missingAuthority,
      sessionId: missingSession.id,
      fence: 2,
      action: "settle",
      atMs: Date.now(),
    }))).rejects.toThrow("missing or not in progress");
    expect(stateProof(missingStore, missingSession.id)).toEqual(beforeMissing);

    const orphanStore = new MemorySessionStore();
    const orphanSession = mkSession("tenant-erasure-corrupt", "u_orphan_item");
    await orphanStore.createSession(orphanSession);
    const orphanSeed = await seedActiveApproval(orphanStore, orphanSession);
    const orphanAuthority = writeAuthorization(await claimTombstoning(orphanStore, orphanSession));
    const orphanLease = await acquireErasureLease(orphanStore, orphanSession, orphanAuthority, 1, orphanSeed.lease.proof);
    await orphanStore.applyErasureSessionAction(orphanLease.admit({
      authority: orphanAuthority, sessionId: orphanSession.id, fence: 2, action: "fence",
    }));
    orphanStore.approvals.get(orphanSeed.approval.id)!.status = "resolved";
    const beforeOrphan = stateProof(orphanStore, orphanSession.id);
    await expect(orphanStore.applyErasureSessionAction(orphanLease.admit({
      authority: orphanAuthority,
      sessionId: orphanSession.id,
      fence: 2,
      action: "settle",
      atMs: Date.now(),
    }))).rejects.toThrow("orphaned");
    expect(stateProof(orphanStore, orphanSession.id)).toEqual(beforeOrphan);

    const cloneStore = new MemorySessionStore();
    const cloneSession = mkSession("tenant-erasure-corrupt", "u_clone_failure");
    await cloneStore.createSession(cloneSession);
    const cloneAuthority = writeAuthorization(await claimTombstoning(cloneStore, cloneSession));
    const cloneLease = await acquireErasureLease(cloneStore, cloneSession, cloneAuthority, 0);
    await cloneStore.applyErasureSessionAction(cloneLease.admit({
      authority: cloneAuthority, sessionId: cloneSession.id, fence: 1, action: "fence",
    }));
    const beforeClone = {
      fence: cloneStore.sessions.get(cloneSession.id)!.fenceToken,
      lastSeq: cloneStore.sessions.get(cloneSession.id)!.lastSeq,
      eventCount: cloneStore.events.get(cloneSession.id)!.length,
      deleted: cloneStore.deleted.size,
      outboxes: cloneStore.lifecycleOutbox.size,
      nextOutboxId: (cloneStore as unknown as { nextLifecycleOutboxId: number }).nextLifecycleOutboxId,
    };
    const metadataBefore=cloneStore.sessions.get(cloneSession.id)!.metadata;
    const fullBeforeClone=stateProof(cloneStore,cloneSession.id);
    cloneStore.sessions.get(cloneSession.id)!.metadata = { impossible: () => "not cloneable" };
    try {
      const pending=cloneStore.applyErasureSessionAction(cloneLease.admit({
        authority: cloneAuthority, sessionId: cloneSession.id, fence: cloneLease.fence,
        action: "tombstone", atMs: Date.now(),
      }));
      await expect(pending).rejects.toThrow();
      await expect(pending).rejects.toMatchObject({name:"DataCloneError"});
    } finally { cloneStore.sessions.get(cloneSession.id)!.metadata=metadataBefore; }
    expect(stateProof(cloneStore,cloneSession.id)).toEqual(fullBeforeClone);
    expect({
      fence: cloneStore.sessions.get(cloneSession.id)!.fenceToken,
      lastSeq: cloneStore.sessions.get(cloneSession.id)!.lastSeq,
      eventCount: cloneStore.events.get(cloneSession.id)!.length,
      deleted: cloneStore.deleted.size,
      outboxes: cloneStore.lifecycleOutbox.size,
      nextOutboxId: (cloneStore as unknown as { nextLifecycleOutboxId: number }).nextLifecycleOutboxId,
    }).toEqual(beforeClone);
  });

  it("blocks a live child, then permits child-first tombstones and concurrent idempotent retry", async () => {
    const store = new MemorySessionStore();
    const parent = mkSession("tenant-erasure-tree", "u_tree");
    const child = { ...mkSession(parent.tenantId, parent.userId), parentSessionId: parent.id };
    await store.createSession(parent);
    await store.createSession(child);
    const authority = writeAuthorization(await claimTombstoning(store, parent));
    const parentLease = await acquireErasureLease(store, parent, authority, 0);
    const childLease = await acquireErasureLease(store, child, authority, 0);

    const beforeParent = stateProof(store, parent.id);
    await expect(store.applyErasureSessionAction(parentLease.admit({
      authority,
      sessionId: parent.id,
      fence: 1,
      action: "tombstone",
      atMs: Date.now(),
    }))).rejects.toBeInstanceOf(SessionHasChildrenError);
    expect(stateProof(store, parent.id)).toEqual(beforeParent);

    await store.applyErasureSessionAction(childLease.admit({
      authority,
      sessionId: child.id,
      fence: 1,
      action: "tombstone",
      atMs: Date.now(),
    }));
    const action = {
      authority,
      sessionId: parent.id,
      fence: 1,
      action: "tombstone" as const,
      atMs: Date.now(),
    };
    const outcomes = await Promise.all([
      store.applyErasureSessionAction(parentLease.admit(action)),
      store.applyErasureSessionAction(parentLease.admit(action)),
    ]);
    expect(outcomes.filter((result) => result.events.length === 1)).toHaveLength(1);
    expect(outcomes.filter((result) => result.events.length === 0)).toHaveLength(1);
    expect(store.deleted.get(parent.id)).toMatchObject({ deletionGeneration: 1 });
    expect((store.events.get(parent.id) ?? []).filter((event) => event.type === "session/deleted"))
      .toHaveLength(1);
    expect(await store.getLifecycleOutbox("session.tombstoned", parent.id, 1)).not.toBeNull();
    expect(await store.getLifecycleOutbox("session.purge", parent.id, 1)).not.toBeNull();
  });

  it("keeps tenant/user/session isolation and stale fences fail-closed", async () => {
    const store = new MemorySessionStore();
    const target = mkSession("tenant-erasure-isolation", "u_target");
    const neighbor = mkSession(target.tenantId, "u_neighbor");
    await store.createSession(target);
    await store.createSession(neighbor);
    const authority = writeAuthorization(await claimTombstoning(store, target));
    const firstLease = await acquireErasureLease(store, target, authority, 0);
    await firstLease.release();
    const lease = await acquireErasureLease(store, target, authority, 1);

    expect(await store.getErasureSessionHead(authority, neighbor.id)).toBeNull();
    const neighborBefore = stateProof(store, neighbor.id);
    await expect(store.applyErasureSessionAction(lease.admit({
      authority,
      sessionId: neighbor.id,
      fence: 1,
      action: "tombstone",
      atMs: Date.now(),
    }))).rejects.toBeInstanceOf(SessionGoneError);
    expect(stateProof(store, neighbor.id)).toEqual(neighborBefore);

    await store.applyErasureSessionAction(lease.admit({
      authority, sessionId: target.id, fence: 2, action: "fence",
    }));
    const targetBefore = stateProof(store, target.id);
    await expect(store.applyErasureSessionAction(lease.admit({
      authority, sessionId: target.id, fence: 1, action: "tombstone", atMs: Date.now(),
    }))).rejects.toBeInstanceOf(FenceError);
    expect(stateProof(store, target.id)).toEqual(targetBefore);
  });

  it("rejects tombstone while active even when no settlement was requested", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-busy", "u_busy");
    await store.createSession(session);
    const seeded = await seedActiveApproval(store, session);
    const authority = writeAuthorization(await claimTombstoning(store, session));
    const lease = await acquireErasureLease(store, session, authority, 1, seeded.lease.proof);
    const before = stateProof(store, session.id);
    await expect(store.applyErasureSessionAction(lease.admit({
      authority, sessionId: session.id, fence: 2, action: "tombstone", atMs: Date.now(),
    }))).rejects.toBeInstanceOf(SessionLifecycleBusyError);
    expect(stateProof(store, session.id)).toEqual(before);
  });
});
