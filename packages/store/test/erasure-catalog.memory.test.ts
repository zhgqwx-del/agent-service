import { describe, expect, it } from "vitest";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  MemorySessionStore,
  newErasureRequestId,
  userErasureRequestHash,
  type ErasureJobClaim,
  type LifecycleOutboxRecord,
  type ErasureScanPhase,
  type ErasureWriteAuthorization,
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

async function claimPhase(
  store: MemorySessionStore,
  session: Session,
  target: ErasureScanPhase,
): Promise<{ claim: ErasureJobClaim; authority: ErasureWriteAuthorization; nowMs: number }> {
  let nowMs = Date.now();
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "admin-catalog",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs: nowMs,
  });
  let claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "catalog-gated",
  }))[0]!;
  expect(await store.transitionErasureJob(jobAuthorization(claim), {
    fromStatus: "gated",
    toStatus: "draining",
    atMs: ++nowMs,
    availableAtMs: nowMs,
  })).toBe(true);
  claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "catalog-draining",
  }))[0]!;
  if (target === "draining") return { claim, authority: writeAuthorization(claim), nowMs };

  expect(await store.transitionErasureJob(jobAuthorization(claim), {
    fromStatus: "draining",
    toStatus: "tombstoning",
    atMs: ++nowMs,
    availableAtMs: nowMs,
  })).toBe(true);
  claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "catalog-tombstoning",
  }))[0]!;
  if (target === "tombstoning") return { claim, authority: writeAuthorization(claim), nowMs };

  expect(await store.transitionErasureJob(jobAuthorization(claim), {
    fromStatus: "tombstoning",
    toStatus: "reconciling_usage",
    atMs: ++nowMs,
    availableAtMs: nowMs,
  })).toBe(true);
  claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 120_000,
    claimToken: "catalog-reconciling",
  }))[0]!;
  return { claim, authority: writeAuthorization(claim), nowMs };
}

async function readAll(
  store: MemorySessionStore,
  authority: ErasureWriteAuthorization,
  phase: ErasureScanPhase,
  nowMs: number,
  limit: number,
) {
  const rows = [];
  let afterSessionId: string | undefined;
  do {
    const page = await store.listErasureSessions(authority, {
      phase,
      ...(afterSessionId === undefined ? {} : { afterSessionId }),
      limit,
      nowMs,
    });
    rows.push(...page.data);
    afterSessionId = page.nextCursor;
  } while (afterSessionId !== undefined);
  return rows;
}

function tombstone(store: MemorySessionStore, session: Session, generation: number, atMs = Date.now()) {
  store.deleted.set(session.id, { deletedAtMs: atMs, deletionGeneration: generation });
}

async function commitTombstone(store: MemorySessionStore, session: Session, atMs = Date.now()): Promise<void> {
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: 1,
      atMs,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: atMs,
    }],
  });
}

function outbox<Topic extends LifecycleOutboxRecord["topic"]>(
  store: MemorySessionStore,
  sessionId: string,
  topic: Topic,
): Extract<LifecycleOutboxRecord, { topic: Topic }> {
  const row = [...store.lifecycleOutbox.values()].find((candidate) => (
    candidate.topic === topic && candidate.aggregateId === sessionId && candidate.generation === 1
  ));
  if (!row || row.topic !== topic) throw new Error(`missing ${topic} fixture`);
  return row as Extract<LifecycleOutboxRecord, { topic: Topic }>;
}

describe("MemorySessionStore erasure session catalog", () => {
  it("paginates every live session in ascending order, including archived rows", async () => {
    const store = new MemorySessionStore();
    const sessions = Array.from({ length: 5 }, () => mkSession("tenant-catalog-pages", "u_pages"));
    for (const session of sessions) await store.createSession(session);
    store.sessions.get(sessions[2]!.id)!.archivedAtMs = Date.now();
    const neighbor = mkSession(sessions[0]!.tenantId, "u_neighbor");
    await store.createSession(neighbor);
    const { authority, nowMs } = await claimPhase(store, sessions[0]!, "draining");

    const rows = await readAll(store, authority, "draining", nowMs, 2);
    const expected = sessions.map((session) => session.id).sort();
    expect(rows.map((row) => row.sessionId)).toEqual(expected);
    expect(rows.every((row) => !row.deleted && row.deletionGeneration === 0)).toBe(true);
    expect(rows.map((row) => row.sessionId)).toContain(sessions[2]!.id);
    expect(rows.map((row) => row.sessionId)).not.toContain(neighbor.id);

    await expect(store.listErasureSessions(authority, {
      phase: "tombstoning",
      limit: 10,
      nowMs,
    })).rejects.toThrow("stale erasure authority");
    await expect(store.inspectErasureSubjectProgress(authority, {
      phase: "tombstoning",
      nowMs,
    })).rejects.toThrow("stale erasure authority");
  });

  it("uses query.nowMs for exact expiry and rejects same-token ABA instead of returning empty", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-catalog-claim", "u_claim");
    await store.createSession(session);
    const first = await claimPhase(store, session, "draining");
    const request = store.erasureRequests.get(first.claim.requestId)!;
    const takeoverAt = Math.max(first.nowMs + 1, Date.now() + 1);
    request.leaseUntilMs = takeoverAt;
    const secondClaim = (await store.claimErasureJobs({
      nowMs: takeoverAt,
      limit: 1,
      leaseMs: 120_000,
      // Deliberately reuse the token: claimAttempt is the ABA discriminator.
      claimToken: first.claim.claimToken,
    }))[0]!;
    const secondAuthority = writeAuthorization(secondClaim);

    await expect(store.listErasureSessions(first.authority, {
      phase: "draining",
      limit: 10,
      nowMs: takeoverAt,
    })).rejects.toThrow("stale erasure authority");
    expect((await store.listErasureSessions(secondAuthority, {
      phase: "draining",
      limit: 10,
      nowMs: takeoverAt,
    })).data).toHaveLength(1);

    store.erasureRequests.get(secondClaim.requestId)!.leaseUntilMs = takeoverAt + 10;
    await expect(store.inspectErasureSubjectProgress(secondAuthority, {
      phase: "draining",
      nowMs: takeoverAt + 10,
    })).rejects.toThrow("stale erasure authority");
  });

  it("lists only live leaves and lets cross-owner children and cycles expose no false leaf", async () => {
    const store = new MemorySessionStore();
    const owner = { tenantId: "tenant-catalog-tree", userId: "u_tree" };
    const root = mkSession(owner.tenantId, owner.userId);
    await store.createSession(root);
    const child = { ...mkSession(owner.tenantId, owner.userId), parentSessionId: root.id };
    await store.createSession(child);
    const crossOwnerRoot = mkSession(owner.tenantId, owner.userId);
    const cycleA = mkSession(owner.tenantId, owner.userId);
    const cycleB = mkSession(owner.tenantId, owner.userId);
    const archivedLeaf = mkSession(owner.tenantId, owner.userId);
    for (const session of [crossOwnerRoot, cycleA, cycleB, archivedLeaf]) await store.createSession(session);
    store.sessions.get(archivedLeaf.id)!.archivedAtMs = Date.now();

    const foreignChild = mkSession(owner.tenantId, "u_foreign");
    await store.createSession(foreignChild);
    store.sessions.get(foreignChild.id)!.parentSessionId = crossOwnerRoot.id;
    store.sessions.get(cycleA.id)!.parentSessionId = cycleB.id;
    store.sessions.get(cycleB.id)!.parentSessionId = cycleA.id;

    const { authority, nowMs } = await claimPhase(store, root, "tombstoning");
    const rows = await readAll(store, authority, "tombstoning", nowMs, 1);
    expect(rows.map((row) => row.sessionId)).toEqual([child.id, archivedLeaf.id].sort());
    expect(rows.find((row) => row.sessionId === child.id)).toMatchObject({ parentSessionId: root.id });
    expect(rows.map((row) => row.sessionId)).not.toContain(crossOwnerRoot.id);
    expect(rows.map((row) => row.sessionId)).not.toContain(cycleA.id);
    expect(rows.map((row) => row.sessionId)).not.toContain(cycleB.id);

    expect(await store.inspectErasureSubjectProgress(authority, {
      phase: "tombstoning",
      nowMs,
    })).toMatchObject({
      totalSessions: 6,
      liveSessions: 6,
      liveLeafSessions: 2,
      tombstonedSessions: 0,
    });
  });

  it("includes legacy tombstones and reports reconciliation plus usage owner corruption exactly", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-catalog-progress";
    const userId = "u_progress";
    const live = mkSession(tenantId, userId);
    const legacy = mkSession(tenantId, userId);
    const verified = mkSession(tenantId, userId);
    const anonymized = mkSession(tenantId, userId);
    const unreconciled = mkSession(tenantId, userId);
    for (const session of [live, legacy, verified, anonymized, unreconciled]) {
      await store.createSession(session);
    }
    const neighbor = mkSession(tenantId, "u_other");
    await store.createSession(neighbor);
    tombstone(store, legacy, 0);
    tombstone(store, verified, 1);
    tombstone(store, anonymized, 2);
    tombstone(store, unreconciled, 1);

    const reconciliation = (session: Session, generation: number, status: "verified" | "anonymized") => ({
      tenantId,
      userId,
      sessionId: session.id,
      deletionGeneration: generation,
      status,
      rowCount: 0,
      knownCostRows: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      checksum: "a".repeat(64),
      verifiedAtMs: Date.now(),
      ...(status === "anonymized" ? { anonymizedAtMs: Date.now() } : {}),
    });
    store.usageReconciliations.set(
      JSON.stringify([verified.id, 1]),
      reconciliation(verified, 1, "verified"),
    );
    store.usageReconciliations.set(
      JSON.stringify([anonymized.id, 2]),
      reconciliation(anonymized, 2, "anonymized"),
    );
    store.usageReconciliations.set(
      JSON.stringify([unreconciled.id, 1]),
      { ...reconciliation(unreconciled, 1, "verified"), userId: "u_wrong" },
    );

    const usage = (overrides: Partial<(typeof store.usageLedger)[number]> = {}) => ({
      tenantId,
      userId,
      sessionId: live.id,
      turnId: newId("turn"),
      step: 1,
      provider: "fake",
      model: "fake-1",
      usage: emptyUsage(),
      createdAtMs: Date.now(),
      ...overrides,
    });
    store.usageLedger.push(
      usage(),
      usage({ sessionId: newId("sess") }),
      usage({ sessionId: neighbor.id }),
      usage({ userId: "u_wrong" }),
      usage({ tenantId: "tenant-unrelated", userId: "u_unrelated", sessionId: newId("sess") }),
    );

    const { authority, nowMs } = await claimPhase(store, live, "reconciling_usage");
    const tombstones = await readAll(store, authority, "reconciling_usage", nowMs, 2);
    expect(tombstones.map((row) => row.sessionId)).toEqual(
      [legacy.id, verified.id, anonymized.id, unreconciled.id].sort(),
    );
    expect(tombstones.find((row) => row.sessionId === legacy.id)).toMatchObject({
      deleted: true,
      deletionGeneration: 0,
      tombstoneProofValid: false,
    });
    expect(tombstones.every((row) => row.tombstoneProofValid === false)).toBe(true);

    expect(await store.inspectErasureSubjectProgress(authority, {
      phase: "reconciling_usage",
      nowMs,
    })).toEqual({
      totalSessions: 5,
      liveSessions: 1,
      liveLeafSessions: 1,
      tombstonedSessions: 4,
      legacyGenerationZeroSessions: 1,
      reconciledUsageSessions: 2,
      unreconciledUsageSessions: 1,
      orphanOrMismatchedUsageRows: 3,
    });
  });

  it("returns a claim-bound proof only for a complete, internally consistent tombstone", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-catalog-proof", "u_proof");
    await store.createSession(session);
    await commitTombstone(store, session);
    const { authority, nowMs } = await claimPhase(store, session, "reconciling_usage");

    await expect(store.listErasureSessions(authority, {
      phase: "reconciling_usage",
      nowMs,
      limit: 10,
    })).resolves.toEqual({
      data: [{
        sessionId: session.id,
        deleted: true,
        deletionGeneration: 1,
        tombstoneProofValid: true,
      }],
    });
  });

  it.each([
    ["marker purge schedule", (store: MemorySessionStore, session: Session) => {
      store.deleted.get(session.id)!.purgeAfterMs = Date.now();
    }],
    ["marker/event timestamp mismatch", (store: MemorySessionStore, session: Session) => {
      store.deleted.get(session.id)!.deletedAtMs += 1;
    }],
    ["terminal event generation", (store: MemorySessionStore, session: Session) => {
      const event = store.events.get(session.id)!.at(-1)!;
      if (event.type !== "session/deleted") throw new Error("invalid fixture event");
      event.deletionGeneration += 1;
    }],
    ["missing session.tombstoned intent", (store: MemorySessionStore, session: Session) => {
      const row = outbox(store, session.id, "session.tombstoned");
      const key = [...store.lifecycleOutbox.entries()].find(([, candidate]) => candidate === row)?.[0];
      if (!key) throw new Error("invalid fixture outbox key");
      store.lifecycleOutbox.delete(key);
    }],
    ["session.tombstoned event sequence", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.tombstoned").payload.eventSeq += 1;
    }],
    ["dead-lettered session.tombstoned intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.tombstoned").deadLetteredAtMs = Date.now();
    }],
    ["activated session.purge intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.purge").availableAtMs = Date.now();
    }],
    ["attempted session.purge intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.purge").attempts = 1;
    }],
    ["claimed session.purge intent", (store: MemorySessionStore, session: Session) => {
      const row = outbox(store, session.id, "session.purge");
      row.claimToken = "unexpected-claim";
      row.leaseUntilMs = Date.now() + 1_000;
    }],
    ["failed session.purge intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.purge").lastError = "unexpected";
    }],
    ["completed session.purge intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.purge").completedAtMs = Date.now();
    }],
    ["dead-lettered session.purge intent", (store: MemorySessionStore, session: Session) => {
      outbox(store, session.id, "session.purge").deadLetteredAtMs = Date.now();
    }],
  ] as const)("marks %s corruption as an invalid proof without returning content", async (_name, corrupt) => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-catalog-proof-corrupt", `u_${newId("sess")}`);
    await store.createSession(session);
    await commitTombstone(store, session);
    corrupt(store, session);
    const { authority, nowMs } = await claimPhase(store, session, "reconciling_usage");

    const page = await store.listErasureSessions(authority, {
      phase: "reconciling_usage",
      nowMs,
      limit: 10,
    });
    expect(page.data).toEqual([{
      sessionId: session.id,
      deleted: true,
      deletionGeneration: 1,
      tombstoneProofValid: false,
    }]);
  });
});
