import { describe, expect, it } from "vitest";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  ErasureTombstoneIntegrityError,
  MemorySessionStore,
  UsageIdentityConflictError,
  billingUsageFactFromLedger,
  newErasureRequestId,
  newUsageId,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureRequestStatus,
  type ErasureWriteAuthorization,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization {
  if (claim.subjectKind !== "user") throw new Error("test requires a user erasure claim");
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

async function claimReconciling(
  store: MemorySessionStore,
  session: Session,
  tokenPrefix: string,
  atMs = Date.now(),
): Promise<{ requestId: string; claim: ErasureJobClaim; authority: ErasureWriteAuthorization; nowMs: number }> {
  const requestId = newErasureRequestId();
  await store.requestUserErasure({
    requestId,
    tenantId: session.tenantId,
    userId: session.userId,
    requestedByKeyId: "admin-erasure-usage",
    idempotencyKey: requestId,
    requestHash: userErasureRequestHash(session.tenantId, session.userId),
    atMs,
  });
  let nowMs = atMs;
  let claim = (await store.claimErasureJobs({
    nowMs,
    limit: 1,
    leaseMs: 600_000,
    claimToken: `${tokenPrefix}-gated`,
  }))[0]!;
  for (const status of ["draining", "tombstoning", "reconciling_usage"] as const satisfies readonly ErasureRequestStatus[]) {
    nowMs += 1;
    expect(await store.transitionErasureJob(jobAuthorization(claim), {
      fromStatus: claim.status,
      toStatus: status,
      atMs: nowMs,
      availableAtMs: nowMs,
    })).toBe(true);
    claim = (await store.claimErasureJobs({
      nowMs,
      limit: 1,
      leaseMs: 600_000,
      claimToken: `${tokenPrefix}-${status}`,
    }))[0]!;
  }
  return { requestId, claim, authority: writeAuthorization(claim), nowMs };
}

function legacyUsage(session: Session, overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step: 1,
    provider: "legacy-provider",
    model: "legacy-model",
    usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    createdAtMs: Date.UTC(2026, 9, 1),
    ...overrides,
  };
}

async function tombstone(store: MemorySessionStore, session: Session, generation = 1): Promise<void> {
  const atMs = Date.now();
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: generation,
      atMs,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: generation,
      emittedAtMs: atMs,
    }],
  });
}

describe("MemorySessionStore claim-bound erasure usage reconciliation", () => {
  it("revalidates the reconciling claim and publishes legacy identity, billing fact and proof together", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-usage-success", "u_erasure_usage_success");
    await store.createSession(session);
    await tombstone(store, session);
    const fixture = await claimReconciling(store, session, "usage-success");
    store.usageLedger.push(legacyUsage(session));

    const result = await store.reconcileErasureSessionUsage(fixture.authority, {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: fixture.nowMs,
    });

    expect(result).toMatchObject({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      status: "verified",
      rowCount: 1,
      totalTokens: 3,
    });
    expect(store.usageLedger[0]?.usageId).toMatch(/^usg_/);
    expect(store.billingUsageFacts.has(store.usageLedger[0]!.usageId!)).toBe(true);
    expect(store.usageReconciliations.get(JSON.stringify([session.id, 1]))).toEqual(result);
  });

  it("rejects expired, wrong-phase and same-token ABA authority before any usage write", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-usage-stale", "u_erasure_usage_stale");
    await store.createSession(session);
    await tombstone(store, session);
    const fixture = await claimReconciling(store, session, "usage-stale");
    store.usageLedger.push(legacyUsage(session));

    const request = store.erasureRequests.get(fixture.requestId)!;
    const takeoverAt = fixture.nowMs + 10;
    request.leaseUntilMs = takeoverAt;
    await expect(store.reconcileErasureSessionUsage(fixture.authority, {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: takeoverAt,
    })).rejects.toThrow("stale erasure authority");

    const replacement = (await store.claimErasureJobs({
      nowMs: takeoverAt,
      limit: 1,
      leaseMs: 600_000,
      // Reusing the token proves claimAttempt, rather than token alone, prevents ABA.
      claimToken: fixture.claim.claimToken,
    }))[0]!;
    expect(replacement.attempts).toBe(fixture.claim.attempts + 1);
    await expect(store.reconcileErasureSessionUsage(fixture.authority, {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: takeoverAt + 1,
    })).rejects.toThrow("stale erasure authority");

    expect(store.usageLedger[0]).not.toHaveProperty("usageId");
    expect(store.billingUsageFacts.size).toBe(0);
    expect(store.usageReconciliations.size).toBe(0);

    expect(await store.transitionErasureJob(jobAuthorization(replacement), {
      fromStatus: "reconciling_usage",
      toStatus: "awaiting_purge_policy",
      atMs: takeoverAt + 2,
    })).toBe(true);
    await expect(store.reconcileErasureSessionUsage(writeAuthorization(replacement), {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: takeoverAt + 2,
    })).rejects.toThrow("stale erasure authority");
    expect(store.usageLedger[0]).not.toHaveProperty("usageId");
    expect(store.billingUsageFacts.size).toBe(0);
    expect(store.usageReconciliations.size).toBe(0);
  });

  it("rolls back every staged write when a later billing identity conflicts", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-usage-rollback", "u_erasure_usage_rollback");
    await store.createSession(session);
    await tombstone(store, session);
    const fixture = await claimReconciling(store, session, "usage-rollback");

    const sortedUsageIds = [newUsageId(), newUsageId()].sort();
    const firstId = sortedUsageIds[0]!;
    const conflictId = sortedUsageIds[1]!;
    const first = legacyUsage(session, { usageId: firstId, step: 1 });
    const legacy = legacyUsage(session, { step: 2 });
    const conflict = legacyUsage(session, { usageId: conflictId, step: 3 });
    store.usageLedger.push(first, legacy, conflict);
    const conflictingFact = billingUsageFactFromLedger({
      ...conflict,
      usageId: conflictId,
      model: "different-model",
    });
    store.billingUsageFacts.set(conflictId, conflictingFact);
    const beforeLedger = structuredClone(store.usageLedger);
    const beforeFacts = structuredClone([...store.billingUsageFacts]);

    await expect(store.reconcileErasureSessionUsage(fixture.authority, {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: fixture.nowMs,
    })).rejects.toBeInstanceOf(UsageIdentityConflictError);

    expect(store.usageLedger).toEqual(beforeLedger);
    expect([...store.billingUsageFacts]).toEqual(beforeFacts);
    expect(store.billingUsageFacts.has(firstId)).toBe(false);
    expect(store.usageLedger[1]).not.toHaveProperty("usageId");
    expect(store.usageReconciliations.size).toBe(0);
  });

  it("revalidates the tombstone proof in the same critical section before any usage write", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-erasure-proof-race", "u_erasure_proof_race");
    await store.createSession(session);
    await tombstone(store, session);
    const fixture = await claimReconciling(store, session, "usage-proof-race");
    store.usageLedger.push(legacyUsage(session));
    const purge = [...store.lifecycleOutbox.values()].find((row) => (
      row.topic === "session.purge" && row.aggregateId === session.id
    ));
    if (!purge) throw new Error("missing purge proof fixture");
    purge.attempts = 1;
    const beforeLedger = structuredClone(store.usageLedger);

    await expect(store.reconcileErasureSessionUsage(fixture.authority, {
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: fixture.nowMs,
    })).rejects.toBeInstanceOf(ErasureTombstoneIntegrityError);

    expect(store.usageLedger).toEqual(beforeLedger);
    expect(store.billingUsageFacts.size).toBe(0);
    expect(store.usageReconciliations.size).toBe(0);
  });
});
