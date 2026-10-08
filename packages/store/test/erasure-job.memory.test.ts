import { describe, expect, it } from "vitest";
import {
  ErasureJobTransitionError,
  MemorySessionStore,
  newErasureRequestId,
  subjectLifecycleKey,
  userErasureRequestHash,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
} from "../src/index.js";

function requestInput(tenantId: string, userId: string, atMs = 100) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "admin-key",
    idempotencyKey: `erase-${userId}`,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

function authorization(claim: ErasureJobClaim): ErasureJobAuthorization {
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

describe("MemorySessionStore durable erasure job queue", () => {
  it("makes a new gate immediately claimable and exposes only a least-privilege claim", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-job", "user-job");
    const created = await store.requestUserErasure(input);
    expect(created).toMatchObject({ status: "gated", availableAtMs: 100, attempts: 0 });

    const [first, competing] = await Promise.all([
      store.claimErasureJobs({ nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-a" }),
      store.claimErasureJobs({ nowMs: 100, limit: 1, leaseMs: 20, claimToken: "worker-b" }),
    ]);
    expect(first).toHaveLength(1);
    expect(competing).toEqual([]);
    expect(first[0]).toEqual({
      requestId: input.requestId,
      tenantId: input.tenantId,
      subjectKind: "user",
      subjectId: input.userId,
      subjectGeneration: 1,
      status: "gated",
      availableAtMs: 100,
      attempts: 1,
      claimToken: "worker-a",
      leaseUntilMs: 120,
    });
    expect(first[0]).not.toHaveProperty("idempotencyKey");
    expect(first[0]).not.toHaveProperty("requestedByKeyId");
    expect(first[0]).not.toHaveProperty("requestHash");
  });

  it("takes over at the exact lease boundary and rejects stale renew, transition, and retry", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-lease", "user-lease");
    await store.requestUserErasure(input);
    const first = (await store.claimErasureJobs({
      nowMs: 100, limit: 1, leaseMs: 10, claimToken: "worker-reused",
    }))[0]!;
    expect(await store.claimErasureJobs({
      nowMs: 109, limit: 1, leaseMs: 10, claimToken: "worker-early",
    })).toEqual([]);
    const taken = (await store.claimErasureJobs({
      nowMs: 110, limit: 1, leaseMs: 20, claimToken: "worker-reused",
    }))[0]!;
    expect(taken).toMatchObject({ attempts: 2, claimToken: "worker-reused", leaseUntilMs: 130 });

    expect(await store.renewErasureJobClaim(authorization(first), { nowMs: 110, leaseMs: 50 })).toBe(false);
    expect(await store.transitionErasureJob(authorization(first), {
      fromStatus: "gated", toStatus: "draining", atMs: 110, availableAtMs: 110,
    })).toBe(false);
    expect(await store.retryErasureJob(authorization(first), {
      failedAtMs: 110, availableAtMs: 150, errorCode: "temporary_failure",
    })).toBe(false);

    // Renewing with a shorter requested deadline is still a successful ownership check.
    expect(await store.renewErasureJobClaim(authorization(taken), { nowMs: 111, leaseMs: 1 })).toBe(true);
    expect((await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId))?.leaseUntilMs)
      .toBe(130);
    expect(await store.retryErasureJob(authorization(taken), {
      failedAtMs: 112, availableAtMs: 150, errorCode: "owner_unavailable",
    })).toBe(true);
    expect(await store.claimErasureJobs({
      nowMs: 149, limit: 1, leaseMs: 10, claimToken: "worker-too-soon",
    })).toEqual([]);
    expect((await store.claimErasureJobs({
      nowMs: 150, limit: 1, leaseMs: 10, claimToken: "worker-retry",
    }))[0]).toMatchObject({ attempts: 3, claimToken: "worker-retry" });
  });

  it("enforces the state graph, writes audit atomically, and erases the subject only on completed", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-transition", "user-transition");
    await store.requestUserErasure(input);
    const gated = (await store.claimErasureJobs({
      nowMs: 100, limit: 1, leaseMs: 100, claimToken: "worker-gated",
    }))[0]!;
    await expect(store.transitionErasureJob(authorization(gated), {
      fromStatus: "gated", toStatus: "tombstoning", atMs: 101, availableAtMs: 101,
    })).rejects.toBeInstanceOf(ErasureJobTransitionError);
    expect(await store.transitionErasureJob(authorization(gated), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 101,
      availableAtMs: 101,
      policyVersion: "policy-v1",
      policyHash: "a".repeat(64),
    })).toBe(true);
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId)).toMatchObject({
      state: "deleting", activeRequestId: input.requestId,
    });
    expect(await store.listErasureAuditEvents(input.requestId)).toHaveLength(2);

    // Seed the future policy decision without implementing policy activation in this substrate.
    // The complete legal audit chain is still mandatory and must carry immutable policy identity.
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    const policy = { policyVersion: "policy-v1", policyHash: "a".repeat(64) };
    const futureStates = [
      ["draining", "tombstoning"],
      ["tombstoning", "reconciling_usage"],
      ["reconciling_usage", "awaiting_purge_policy"],
      ["awaiting_purge_policy", "purging"],
    ] as const;
    for (const [index, [fromStatus, status]] of futureStates.entries()) {
      audits.push({
        requestId: input.requestId,
        seq: audits.length + 1,
        type: "erasure/status_changed",
        payload: { fromStatus, status, generation: 1, ...policy },
        emittedAtMs: 102 + index,
      });
    }
    store.erasureRequests.set(input.requestId, {
      ...record,
      status: "purging",
      availableAtMs: 105,
      updatedAtMs: 105,
    });
    delete audits[3]!.payload.policyVersion;
    delete audits[3]!.payload.policyHash;
    await expect(store.claimErasureJobs({
      nowMs: 105, limit: 1, leaseMs: 100, claimToken: "worker-missing-policy",
    })).rejects.toThrow("not carried forward");
    Object.assign(audits[3]!.payload, policy);
    const purging = (await store.claimErasureJobs({
      nowMs: 105, limit: 1, leaseMs: 100, claimToken: "worker-purge",
    }))[0]!;
    expect(await store.transitionErasureJob(authorization(purging), {
      fromStatus: "purging",
      toStatus: "completed",
      atMs: 106,
      counts: { sessions: 2, blobs: 3 },
      checksum: "b".repeat(64),
    })).toBe(true);
    expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId)).toMatchObject({
      status: "completed",
      completedAtMs: 106,
      counts: { sessions: 2, blobs: 3 },
      checksum: "b".repeat(64),
    });
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId)).toMatchObject({
      state: "erased", generation: 1,
    });
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId))
      .not.toHaveProperty("activeRequestId");
    expect((await store.listErasureAuditEvents(input.requestId)).at(-1)).toMatchObject({
      seq: 7,
      type: "erasure/completed",
      payload: {
        fromStatus: "purging",
        status: "completed",
        generation: 1,
        ...policy,
      },
    });
  });

  it("rolls back an audit serialization failure and fails closed on subject corruption", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-corrupt", "user-corrupt");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100, limit: 1, leaseMs: 100, claimToken: "worker-corrupt",
    }))[0]!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    audits[0]!.payload = {
      status: "gated",
      subjectKind: "user",
      generation: 1,
      prompt: () => "must never be audited",
    };
    await expect(store.transitionErasureJob(authorization(claim), {
      fromStatus: "gated", toStatus: "draining", atMs: 101, availableAtMs: 101,
    })).rejects.toThrow();
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated", claimToken: "worker-corrupt", leaseUntilMs: 200,
    });
    expect(audits).toHaveLength(1);

    audits[0]!.payload = { status: "gated", subjectKind: "user", generation: 1 };
    const subjectKey = subjectLifecycleKey(input.tenantId, "user", input.userId);
    const subject = store.subjectLifecycles.get(subjectKey)!;
    store.subjectLifecycles.set(subjectKey, { ...subject, activeRequestId: newErasureRequestId() });
    await expect(store.retryErasureJob(authorization(claim), {
      failedAtMs: 102, availableAtMs: 120, errorCode: "integrity_conflict",
    })).rejects.toThrow("does not match its active subject lifecycle");
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated", claimToken: "worker-corrupt", leaseUntilMs: 200,
    });
  });
});
