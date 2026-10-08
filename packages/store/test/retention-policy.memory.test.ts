import { describe, expect, it } from "vitest";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  LegalHoldConflictError,
  LegalHoldGenerationConflictError,
  LegalHoldIntegrityError,
  MemorySessionStore,
  RetentionPolicyGenerationConflictError,
  RetentionPolicyVersionConflictError,
  UsageLegalHoldError,
  compareLegalHoldIds,
  legalHoldProjectionSha256,
  newErasureRequestId,
  subjectLifecycleKey,
  userErasureRequestHash,
  validateErasureAuditChain,
  type ErasureAuditEvent,
  type LegalHoldRecord,
  type RetentionPolicyDocumentV1,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE = Date.UTC(2026, 9, 9);

function policy(overrides: Partial<RetentionPolicyDocumentV1> = {}): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    userErasureGraceMs: 7 * 24 * 60 * 60 * 1_000,
    operationalUsageRetentionMs: null,
    idempotencyReceiptRetentionMs: 24 * 60 * 60 * 1_000,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60 * 60 * 1_000,
    ...overrides,
  };
}

async function putPolicy(
  store: MemorySessionStore,
  tenantId: string,
  policyVersion = "policy-v1",
  atMs = BASE,
) {
  return await store.putRetentionPolicy({
    tenantId,
    policyVersion,
    policy: policy(),
    actorKeyId: "policy-admin",
    atMs,
  });
}

function erasureInput(tenantId: string, userId: string, atMs: number, key: string) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "erasure-admin",
    idempotencyKey: key,
    requestHash: userErasureRequestHash(tenantId, userId),
    atMs,
  };
}

async function tombstoneAndReconcile(store: MemorySessionStore, session: Session) {
  store.usageLedger.push({
    tenantId: session.tenantId,
    userId: session.userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step: 1,
    provider: "provider-a",
    model: "model-a",
    usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    createdAtMs: BASE,
  } satisfies UsageLedgerEntry);
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: 1,
      atMs: BASE + 100,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: 1,
      emittedAtMs: BASE + 100,
    }],
  });
  return await store.reconcileSessionUsage({
    tenantId: session.tenantId,
    userId: session.userId,
    sessionId: session.id,
    deletionGeneration: 1,
    nowMs: BASE + 200,
  });
}

describe("canonical legal-hold hashing", () => {
  it("uses locale-independent code-unit ordering for case and punctuation", () => {
    const ids = [
      "hold_aA",
      "hold_A_",
      "hold_Aa",
      "hold_A-",
      "hold_AA",
      "hold_A0",
      "hold_A.",
    ];
    expect([...ids].sort(compareLegalHoldIds)).toEqual([
      "hold_A-",
      "hold_A.",
      "hold_A0",
      "hold_AA",
      "hold_A_",
      "hold_Aa",
      "hold_aA",
    ]);
    const holds = ids.map((holdId): LegalHoldRecord => ({
      tenantId: "tenant-sort",
      holdId,
      subjectKind: "user",
      subjectId: "user-sort",
      state: "active",
      reasonCode: "litigation",
      createdControlGeneration: 1,
      createdByKeyId: "sort-test",
      createdAtMs: 100,
    }));
    expect(legalHoldProjectionSha256(holds)).toBe(
      "4f0f5bbdbc870ddc5f56d840c542b618fa83ccf2d8435aed66b4e0b8564f1272",
    );
    expect(legalHoldProjectionSha256([...holds].reverse()))
      .toBe(legalHoldProjectionSha256(holds));
  });
});

describe("MemorySessionStore canonical retention policy", () => {
  it("puts immutable versions idempotently and isolates the same version across tenants", async () => {
    const store = new MemorySessionStore();
    await expect(putPolicy(store, "tenant-policy-a", "active")).rejects.toThrow(
      "invalid retention policy version",
    );
    const first = await putPolicy(store, "tenant-policy-a");
    const replay = await store.putRetentionPolicy({
      tenantId: first.tenantId,
      policyVersion: first.policyVersion,
      policy: policy(),
      actorKeyId: "different-retry-actor",
      atMs: BASE + 10,
    });
    expect(replay).toEqual(first);
    await expect(store.putRetentionPolicy({
      tenantId: first.tenantId,
      policyVersion: first.policyVersion,
      policy: policy({ sessionContentRetentionMs: 1 }),
      actorKeyId: "policy-admin",
      atMs: BASE + 20,
    })).rejects.toBeInstanceOf(RetentionPolicyVersionConflictError);

    const isolated = await putPolicy(store, "tenant-policy-b");
    expect(isolated.policyVersion).toBe(first.policyVersion);
    expect(await store.getRetentionPolicy("tenant-policy-a", first.policyVersion)).toEqual(first);
    expect(await store.getRetentionPolicy("tenant-policy-missing", first.policyVersion)).toBeNull();
  });

  it("uses generation CAS, exact lost-response replay, append-only events and ABA rejection", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-policy-cas";
    await putPolicy(store, tenantId, "policy-v1", BASE);
    await store.putRetentionPolicy({
      tenantId,
      policyVersion: "policy-v2",
      policy: policy({ userErasureGraceMs: 123 }),
      actorKeyId: "policy-admin",
      atMs: BASE + 1,
    });
    const firstInput = {
      tenantId,
      policyVersion: "policy-v1",
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: BASE + 10,
    };
    const first = await store.activateRetentionPolicy(firstInput);
    expect(first).toMatchObject({ controlGeneration: 1, activePolicyVersion: "policy-v1" });
    expect(await store.activateRetentionPolicy({
      ...firstInput,
      actorKeyId: "retrying-policy-admin",
      atMs: BASE + 999,
    })).toEqual(first);
    expect(await store.activateRetentionPolicy({
      ...firstInput,
      expectedControlGeneration: 1,
      actorKeyId: "no-op-actor",
      atMs: BASE + 11,
    })).toEqual(first);

    const raced = await Promise.allSettled([
      store.activateRetentionPolicy({
        tenantId,
        policyVersion: "policy-v2",
        expectedControlGeneration: 1,
        actorKeyId: "policy-a",
        atMs: BASE + 20,
      }),
      store.activateRetentionPolicy({
        tenantId,
        policyVersion: "policy-v1",
        expectedControlGeneration: 1,
        actorKeyId: "policy-b",
        atMs: BASE + 21,
      }),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((raced.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toBeInstanceOf(RetentionPolicyGenerationConflictError);
    expect(await store.listRetentionPolicyActivationEvents(tenantId)).toHaveLength(2);
    await expect(store.activateRetentionPolicy({
      tenantId,
      policyVersion: "policy-v1",
      expectedControlGeneration: 0,
      actorKeyId: "stale-aba",
      atMs: BASE + 30,
    })).rejects.toBeInstanceOf(RetentionPolicyGenerationConflictError);
  });

  it("clamps activation audit time when the next causal writer has a clock behind", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-policy-clock-skew";
    await putPolicy(store, tenantId, "policy-v1", BASE);
    await putPolicy(store, tenantId, "policy-v2", BASE + 1);

    const first = await store.activateRetentionPolicy({
      tenantId,
      policyVersion: "policy-v1",
      expectedControlGeneration: 0,
      actorKeyId: "runner-a",
      atMs: BASE + 100,
    });
    const clockBehind = await store.activateRetentionPolicy({
      tenantId,
      policyVersion: "policy-v2",
      expectedControlGeneration: 1,
      actorKeyId: "runner-b",
      atMs: BASE + 50,
    });

    expect(first).toMatchObject({
      controlGeneration: 1,
      effectiveAtMs: BASE + 100,
      updatedAtMs: BASE + 100,
    });
    expect(clockBehind).toMatchObject({
      controlGeneration: 2,
      activePolicyVersion: "policy-v2",
      effectiveAtMs: BASE + 100,
      updatedAtMs: BASE + 100,
    });
    expect((await store.listRetentionPolicyActivationEvents(tenantId)).map((event) => ({
      generation: event.controlGeneration,
      effectiveAtMs: event.effectiveAtMs,
      emittedAtMs: event.emittedAtMs,
    }))).toEqual([
      { generation: 1, effectiveAtMs: BASE + 100, emittedAtMs: BASE + 100 },
      { generation: 2, effectiveAtMs: BASE + 100, emittedAtMs: BASE + 100 },
    ]);
  });

  it("rolls back activation state and event identity when publication fails", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-policy-rollback";
    await putPolicy(store, tenantId);
    const events = store.retentionPolicyActivationEvents;
    const originalSet = events.set.bind(events);
    let fail = true;
    Object.defineProperty(events, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected activation audit failure");
        }
        return originalSet(key, value as never);
      },
    });
    const input = {
      tenantId,
      policyVersion: "policy-v1",
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: BASE + 1,
    };
    await expect(store.activateRetentionPolicy(input)).rejects.toThrow("injected activation audit failure");
    expect(store.retentionPolicyControls).toHaveLength(0);
    expect(store.retentionPolicyActivationEvents).toHaveLength(0);
    expect((await store.activateRetentionPolicy(input)).controlGeneration).toBe(1);
    expect((await store.listRetentionPolicyActivationEvents(tenantId))[0]?.eventId).toBe(1);
  });

  it("binds the policy observed at admission regardless of runner clock skew", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-policy-binding";
    const backlogInput = erasureInput(tenantId, "user-backlog", BASE, "backlog-key");
    const backlog = await store.requestUserErasure(backlogInput);
    expect(backlog).not.toHaveProperty("policyVersion");

    const version = await putPolicy(store, tenantId, "policy-v1", BASE + 10);
    await store.activateRetentionPolicy({
      tenantId,
      policyVersion: version.policyVersion,
      expectedControlGeneration: 0,
      actorKeyId: "policy-admin",
      atMs: BASE + 20,
    });
    const replay = await store.requestUserErasure({
      ...backlogInput,
      requestId: newErasureRequestId(),
      atMs: BASE + 30,
    });
    expect(replay).toEqual(backlog);
    expect((await store.listErasureAuditEvents(backlog.requestId))[0]?.payload)
      .toEqual({ status: "gated", subjectKind: "user", generation: 1 });
    const backlogClaim = (await store.claimErasureJobs({
      nowMs: BASE + 30,
      limit: 1,
      leaseMs: 1_000,
      claimToken: "backlog-worker",
    }))[0]!;
    await expect(store.transitionErasureJob({
      tenantId: backlogClaim.tenantId,
      subjectKind: backlogClaim.subjectKind,
      subjectId: backlogClaim.subjectId,
      requestId: backlogClaim.requestId,
      subjectGeneration: backlogClaim.subjectGeneration,
      claimToken: backlogClaim.claimToken,
      claimAttempt: backlogClaim.attempts,
    }, {
      fromStatus: "gated",
      toStatus: "draining",
      atMs: BASE + 31,
      availableAtMs: BASE + 31,
      policyVersion: version.policyVersion,
      policyHash: version.policySha256,
    })).rejects.toThrow("cannot be assigned after admission");

    const clockBehind = await store.requestUserErasure(erasureInput(
      tenantId,
      "user-clock-behind",
      BASE + 19,
      "clock-behind-key",
    ));
    expect(clockBehind).toMatchObject({
      policyVersion: version.policyVersion,
      policyHash: version.policySha256,
    });

    const currentInput = erasureInput(tenantId, "user-current", BASE + 30, "current-key");
    const current = await store.requestUserErasure(currentInput);
    expect(current).toMatchObject({
      policyVersion: version.policyVersion,
      policyHash: version.policySha256,
    });
    const audits = await store.listErasureAuditEvents(current.requestId);
    expect(audits[0]?.payload).toMatchObject({
      status: "gated",
      policyVersion: version.policyVersion,
      policyHash: version.policySha256,
    });
    expect(() => validateErasureAuditChain(current, audits)).not.toThrow();

    const incomplete = structuredClone(audits);
    delete incomplete[0]!.payload.policyHash;
    expect(() => validateErasureAuditChain(current, incomplete)).toThrow();
    const changed = structuredClone(audits);
    changed.push({
      requestId: current.requestId,
      seq: 2,
      type: "erasure/status_changed",
      payload: {
        fromStatus: "gated",
        status: "draining",
        generation: 1,
        policyVersion: "policy-rewritten",
        policyHash: "f".repeat(64),
      },
      emittedAtMs: BASE + 31,
    } satisfies ErasureAuditEvent);
    expect(() => validateErasureAuditChain({
      ...current,
      status: "draining",
      updatedAtMs: BASE + 31,
      availableAtMs: BASE + 31,
    }, changed)).toThrow("policy identity changed");
    const removed = structuredClone(changed);
    delete removed[1]!.payload.policyVersion;
    delete removed[1]!.payload.policyHash;
    expect(() => validateErasureAuditChain({
      ...current,
      status: "draining",
      updatedAtMs: BASE + 31,
      availableAtMs: BASE + 31,
    }, removed)).toThrow("not carried forward");
  });
});

describe("MemorySessionStore canonical legal holds", () => {
  it("clamps set and release audit time when a later causal writer has a clock behind", async () => {
    const store = new MemorySessionStore();
    const tenantId = "tenant-hold-clock-skew";
    const userId = "user-hold-clock-skew";
    const first = await store.setLegalHold({
      tenantId,
      holdId: "hold_clock_first",
      subjectKind: "user",
      subjectId: userId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "runner-a",
      atMs: BASE + 100,
    });
    const second = await store.setLegalHold({
      tenantId,
      holdId: "hold_clock_second",
      subjectKind: "user",
      subjectId: userId,
      reasonCode: "regulatory",
      expectedControlGeneration: 1,
      actorKeyId: "runner-b",
      atMs: BASE + 50,
    });
    const released = await store.releaseLegalHold({
      tenantId,
      holdId: first.holdId,
      expectedControlGeneration: 2,
      reasonCode: "matter_closed",
      actorKeyId: "runner-c",
      atMs: BASE + 40,
    });

    expect(first.createdAtMs).toBe(BASE + 100);
    expect(second.createdAtMs).toBe(BASE + 100);
    expect(released.releasedAtMs).toBe(BASE + 100);
    expect(await store.getLegalHoldControl(tenantId, "user", userId)).toMatchObject({
      controlGeneration: 3,
      updatedAtMs: BASE + 100,
    });
    expect((await store.listLegalHoldEvents(tenantId, "user", userId)).map((event) => ({
      generation: event.controlGeneration,
      emittedAtMs: event.emittedAtMs,
    }))).toEqual([
      { generation: 1, emittedAtMs: BASE + 100 },
      { generation: 2, emittedAtMs: BASE + 100 },
      { generation: 3, emittedAtMs: BASE + 100 },
    ]);
  });

  it("uses subject CAS, keeps multiple holds independently, retains shadow and isolates tenants/users", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-hold", "user-hold");
    const neighbor = mkSession(session.tenantId, "user-neighbor");
    await store.createSession(session);
    await store.createSession(neighbor);
    const firstInput = {
      tenantId: session.tenantId,
      holdId: "hold_first",
      subjectKind: "user" as const,
      subjectId: session.userId,
      reasonCode: "litigation" as const,
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 10,
    };
    const first = await store.setLegalHold(firstInput);
    expect(await store.setLegalHold({
      ...firstInput,
      actorKeyId: "retrying-legal-admin",
      atMs: BASE + 999,
    })).toEqual(first);

    const raced = await Promise.allSettled([
      store.setLegalHold({
        ...firstInput,
        holdId: "hold_second",
        reasonCode: "regulatory",
        expectedControlGeneration: 1,
        atMs: BASE + 20,
      }),
      store.setLegalHold({
        ...firstInput,
        holdId: "hold_third",
        reasonCode: "security_incident",
        expectedControlGeneration: 1,
        atMs: BASE + 21,
      }),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((raced.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toBeInstanceOf(LegalHoldGenerationConflictError);
    let state = await store.getActiveLegalHoldState(session.tenantId, "user", session.userId);
    expect(state.control).toMatchObject({ controlGeneration: 2, activeHoldCount: 2 });
    expect(state.holds).toHaveLength(2);

    const second = state.holds.find((hold) => hold.holdId !== first.holdId)!;
    const released = await store.releaseLegalHold({
      tenantId: session.tenantId,
      holdId: first.holdId,
      expectedControlGeneration: 2,
      reasonCode: "matter_closed",
      actorKeyId: "legal-admin",
      atMs: BASE + 30,
    });
    state = await store.getActiveLegalHoldState(session.tenantId, "user", session.userId);
    expect(state.control).toMatchObject({ controlGeneration: 3, activeHoldCount: 1 });
    expect(state.holds.map((hold) => hold.holdId)).toEqual([second.holdId]);
    expect((await store.getSubjectLifecycle(session.tenantId, "user", session.userId))?.legalHoldAtMs)
      .toBe(second.createdAtMs);
    await expect(store.setLegalHold({
      ...firstInput,
      actorKeyId: "stale-aba-admin",
      atMs: BASE + 31,
    })).rejects.toBeInstanceOf(LegalHoldConflictError);

    // An unrelated later generation does not make an exact lost-response release retry unsafe.
    await store.setLegalHold({
      ...firstInput,
      holdId: "hold_later",
      reasonCode: "billing_dispute",
      expectedControlGeneration: 3,
      atMs: BASE + 40,
    });
    expect(await store.releaseLegalHold({
      tenantId: session.tenantId,
      holdId: first.holdId,
      expectedControlGeneration: 2,
      reasonCode: "matter_closed",
      actorKeyId: "retrying-legal-admin",
      atMs: BASE + 999,
    })).toEqual(released);

    expect((await store.getActiveLegalHoldState(session.tenantId, "user", neighbor.userId)).holds)
      .toEqual([]);
    expect(await store.getLegalHold("other-tenant", first.holdId)).toBeNull();
    await store.setLegalHold({
      ...firstInput,
      tenantId: "other-tenant",
      subjectId: session.userId,
      expectedControlGeneration: 0,
    });
    expect(await store.getLegalHold("other-tenant", first.holdId)).toMatchObject({
      tenantId: "other-tenant",
    });
  });

  it("rolls back ledger, control, audit and shadow on publication failure", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-hold-rollback", "user-hold-rollback");
    await store.createSession(session);
    const events = store.legalHoldEvents;
    const originalSet = events.set.bind(events);
    let fail = true;
    Object.defineProperty(events, "set", {
      configurable: true,
      value: (key: string, value: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("injected hold audit failure");
        }
        return originalSet(key, value as never);
      },
    });
    const input = {
      tenantId: session.tenantId,
      holdId: "hold_rollback",
      subjectKind: "user" as const,
      subjectId: session.userId,
      reasonCode: "litigation" as const,
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 10,
    };
    await expect(store.setLegalHold(input)).rejects.toThrow("injected hold audit failure");
    expect(store.legalHolds).toHaveLength(0);
    expect(store.legalHoldControls).toHaveLength(0);
    expect(store.legalHoldEvents).toHaveLength(0);
    expect((await store.getSubjectLifecycle(session.tenantId, "user", session.userId))?.legalHoldAtMs)
      .toBeUndefined();
    expect((await store.setLegalHold(input)).createdControlGeneration).toBe(1);
    expect((await store.listLegalHoldEvents(session.tenantId, "user", session.userId))[0]?.eventId)
      .toBe(1);
  });

  it("fails closed for legacy shadow, ledger/control corruption and shadow disagreement", async () => {
    const legacy = new MemorySessionStore();
    const legacySession = mkSession("tenant-legacy-hold", "user-legacy-hold");
    await legacy.createSession(legacySession);
    const legacyKey = subjectLifecycleKey(legacySession.tenantId, "user", legacySession.userId);
    legacy.subjectLifecycles.get(legacyKey)!.legalHoldAtMs = BASE;
    await expect(legacy.getActiveLegalHoldState(
      legacySession.tenantId,
      "user",
      legacySession.userId,
    )).rejects.toBeInstanceOf(LegalHoldIntegrityError);

    const corrupt = new MemorySessionStore();
    const session = mkSession("tenant-corrupt-hold", "user-corrupt-hold");
    await corrupt.createSession(session);
    await corrupt.setLegalHold({
      tenantId: session.tenantId,
      holdId: "hold_corrupt",
      subjectKind: "user",
      subjectId: session.userId,
      reasonCode: "regulatory",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 10,
    });
    corrupt.subjectLifecycles.get(subjectLifecycleKey(session.tenantId, "user", session.userId))!
      .legalHoldAtMs = BASE + 11;
    await expect(corrupt.listActiveLegalHolds(session.tenantId, "user", session.userId))
      .rejects.toBeInstanceOf(LegalHoldIntegrityError);
  });

  it("linearizes hold versus anonymization and preserves committed retry semantics", async () => {
    const store = new MemorySessionStore();
    const held = mkSession("tenant-usage-hold", "user-held-first");
    await store.createSession(held);
    const verified = await tombstoneAndReconcile(store, held);
    await store.setLegalHold({
      tenantId: held.tenantId,
      holdId: "hold_usage_first",
      subjectKind: "user",
      subjectId: held.userId,
      reasonCode: "billing_dispute",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 250,
    });
    await expect(store.anonymizeSessionUsage({
      tenantId: held.tenantId,
      userId: held.userId,
      sessionId: held.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: BASE + 300,
      enabled: true,
    })).rejects.toBeInstanceOf(UsageLegalHoldError);
    expect(store.usageLedger.some((entry) => entry.sessionId === held.id)).toBe(true);

    const committed = mkSession("tenant-usage-hold", "user-delete-first");
    await store.createSession(committed);
    const committedVerification = await tombstoneAndReconcile(store, committed);
    const anonymized = await store.anonymizeSessionUsage({
      tenantId: committed.tenantId,
      userId: committed.userId,
      sessionId: committed.id,
      deletionGeneration: 1,
      expectedChecksum: committedVerification.checksum,
      nowMs: BASE + 300,
      enabled: true,
    });
    await store.setLegalHold({
      tenantId: committed.tenantId,
      holdId: "hold_after_commit",
      subjectKind: "user",
      subjectId: committed.userId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: BASE + 350,
    });
    await expect(store.anonymizeSessionUsage({
      tenantId: committed.tenantId,
      userId: committed.userId,
      sessionId: committed.id,
      deletionGeneration: 1,
      expectedChecksum: committedVerification.checksum,
      nowMs: BASE + 400,
      enabled: true,
    })).resolves.toEqual(anonymized);
  });
});
