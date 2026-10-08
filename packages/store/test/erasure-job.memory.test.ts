import { describe, expect, it } from "vitest";
import {
  ErasureJobTransitionError,
  MemorySessionStore,
  newErasureRequestId,
  subjectLifecycleKey,
  userErasureRequestHash,
  validateTransitionErasureJobOptions,
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
  it("cannot use the generic transition API to mint purge or caller-supplied completion proof", () => {
    expect(() => validateTransitionErasureJobOptions({
      fromStatus: "awaiting_purge_policy",
      toStatus: "purging",
      atMs: 1,
    } as never)).toThrow("unavailable purge executor");
    expect(() => validateTransitionErasureJobOptions({
      fromStatus: "purging",
      toStatus: "completed",
      atMs: 2,
      counts: { sessions: 0, turns: 0, items: 0, blobs: 0, usageRows: 0 },
      checksum: "a".repeat(64),
    } as never)).toThrow("unavailable purge executor");
    expect(() => validateTransitionErasureJobOptions({
      fromStatus: "purging",
      toStatus: "blocked",
      atMs: 3,
      errorCode: "integrity_conflict",
    } as never)).toThrow("unavailable purge executor");
    expect(() => validateTransitionErasureJobOptions({
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 4,
      availableAtMs: 4,
      counts: { sessions: 0 },
    } as never)).toThrow("caller-supplied erasure completion proof is unavailable");
  });

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

  it("returns an already committed claim before a later unknown candidate failure", async () => {
    const store = new MemorySessionStore();
    const first = requestInput("tenant-partial-claim", "user-first", 100);
    const later = requestInput("tenant-partial-claim", "user-later", 101);
    await store.requestUserErasure(first);
    await store.requestUserErasure(later);

    const internal = store as unknown as {
      assertErasureJobIntegrity: (record: { requestId: string }) => unknown;
    };
    const originalAssert = internal.assertErasureJobIntegrity.bind(store);
    internal.assertErasureJobIntegrity = (record) => {
      if (record.requestId === later.requestId) throw new TypeError("injected later failure");
      return originalAssert(record);
    };

    expect(await store.claimErasureJobs({
      nowMs: 101,
      limit: 2,
      leaseMs: 20,
      claimToken: "worker-partial-success",
    })).toEqual([expect.objectContaining({
      requestId: first.requestId,
      attempts: 1,
      claimToken: "worker-partial-success",
    })]);
    expect(store.erasureRequests.get(first.requestId)).toMatchObject({
      attempts: 1,
      claimToken: "worker-partial-success",
      leaseUntilMs: 121,
    });
    expect(store.erasureRequests.get(later.requestId)).toMatchObject({
      attempts: 0,
      availableAtMs: 101,
    });

    await expect(store.claimErasureJobs({
      nowMs: 101,
      limit: 1,
      leaseMs: 20,
      claimToken: "worker-no-prior-success",
    })).rejects.toThrow("injected later failure");
  });

  it("rejects user claim authority after the parent tenant stops being active", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-parent-gate", "user-parent-gate");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100, limit: 1, leaseMs: 50, claimToken: "worker-parent-gate",
    }))[0]!;
    const tenantKey = subjectLifecycleKey(input.tenantId, "tenant", input.tenantId);
    const tenant = store.subjectLifecycles.get(tenantKey)!;

    store.subjectLifecycles.set(tenantKey, {
      ...tenant,
      state: "deleting",
      generation: 1,
      activeRequestId: newErasureRequestId(),
      updatedAtMs: 101,
    });
    expect(await store.renewErasureJobClaim(authorization(claim), {
      nowMs: 101,
      leaseMs: 50,
    })).toBe(false);

    store.subjectLifecycles.set(tenantKey, {
      ...tenant,
      state: "erased",
      generation: 1,
      updatedAtMs: 102,
    });
    expect(await store.transitionErasureJob(authorization(claim), {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: 102,
      availableAtMs: 102,
    })).toBe(false);
    expect(await store.retryErasureJob(authorization(claim), {
      failedAtMs: 102,
      availableAtMs: 110,
      errorCode: "temporary_failure",
    })).toBe(false);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated",
      attempts: 1,
      claimToken: "worker-parent-gate",
      leaseUntilMs: 150,
    });
  });

  it("enforces the state graph and keeps rolling-upgrade purging rows outside the normal worker", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-transition", "user-transition");
    const policyDocument = {
      sessionContentRetentionMs: null,
      userErasureGraceMs: null,
      operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: null,
      billingFactRetentionMs: null,
      lifecycleAuditRetentionMs: null,
      exportArtifactTtlMs: null,
    } as const;
    const admittedPolicy = await store.putRetentionPolicy({
      tenantId: input.tenantId,
      policyVersion: "policy-v1",
      policy: policyDocument,
      actorKeyId: "policy-admin",
      atMs: 90,
    });
    await store.activateRetentionPolicy({
      tenantId: input.tenantId,
      policyVersion: admittedPolicy.policyVersion,
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: 90,
    });
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
      policyVersion: admittedPolicy.policyVersion,
      policyHash: admittedPolicy.policySha256,
    })).toBe(true);
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId)).toMatchObject({
      state: "deleting", activeRequestId: input.requestId,
    });
    expect(await store.listErasureAuditEvents(input.requestId)).toHaveLength(2);

    // Seed a rolling-upgrade purging row. Its policy was selected at admission and every later
    // audit must carry that same immutable identity.
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    const policy = {
      policyVersion: admittedPolicy.policyVersion,
      policyHash: admittedPolicy.policySha256,
    };
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
    expect(await store.claimErasureJobs({
      nowMs: 105, limit: 1, leaseMs: 100, claimToken: "worker-purge",
    })).toEqual([]);
    expect(await store.getUserErasureRequest(input.tenantId, input.userId, input.requestId)).toMatchObject({
      status: "purging",
      availableAtMs: 105,
      attempts: 1,
    });
    expect(await store.getSubjectLifecycle(input.tenantId, "user", input.userId)).toMatchObject({
      state: "deleting", generation: 1, activeRequestId: input.requestId,
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
    })).rejects.toMatchObject({ reasonCode: "subject_binding_invalid" });
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({
      status: "gated", claimToken: "worker-corrupt", leaseUntilMs: 200,
    });
  });

  it("rolls back the request when the following audit publication fails", async () => {
    const store = new MemorySessionStore();
    const input = requestInput("tenant-transition-rollback", "user-transition-rollback");
    await store.requestUserErasure(input);
    const claim = (await store.claimErasureJobs({
      nowMs: 100,
      limit: 1,
      leaseMs: 100,
      claimToken: "worker-transition-rollback",
    }))[0]!;
    const record = store.erasureRequests.get(input.requestId)!;
    const audits = store.erasureAuditEvents.get(input.requestId)!;
    const subjectKey = subjectLifecycleKey(input.tenantId, "user", input.userId);
    const auditMap = store.erasureAuditEvents;
    const originalSet = auditMap.set.bind(auditMap);
    let fail = true;
    Object.defineProperty(auditMap, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof auditMap.set>[1]) => {
        if (key === input.requestId && fail) {
          fail = false;
          throw new Error("injected transition audit publication failure");
        }
        return originalSet(key, value);
      },
    });

    const transition = {
      fromStatus: "gated" as const,
      toStatus: "draining" as const,
      atMs: 101,
      availableAtMs: 101,
    };
    await expect(store.transitionErasureJob(authorization(claim), transition))
      .rejects.toThrow("injected transition audit publication failure");
    expect(store.erasureRequests.get(input.requestId)).toBe(record);
    expect(record).toMatchObject({
      status: "gated",
      claimToken: claim.claimToken,
      leaseUntilMs: 200,
    });
    expect(store.erasureAuditEvents.get(input.requestId)).toBe(audits);
    expect(audits).toHaveLength(1);
    expect(store.subjectLifecycles.get(subjectKey)).toMatchObject({
      state: "deleting",
      activeRequestId: input.requestId,
    });

    await expect(store.transitionErasureJob(authorization(claim), transition)).resolves.toBe(true);
    expect(store.erasureRequests.get(input.requestId)).toMatchObject({ status: "draining" });
    expect(store.erasureAuditEvents.get(input.requestId)).toHaveLength(2);
    expect(store.subjectLifecycles.get(subjectKey)).toMatchObject({
      state: "deleting",
      activeRequestId: input.requestId,
    });
  });
});
