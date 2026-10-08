import { describe, expect, it } from "vitest";
import { emptyUsage, type Session } from "@agent-service/protocol";
import {
  MemorySessionStore,
  SessionGoneError,
  UsageAnonymizationDisabledError,
  UsageIdentityConflictError,
  UsageLegalHoldError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  assertBillingUsageFact,
  billingUsageFactFromLedger,
  isUsageId,
  newUsageId,
  subjectLifecycleKey,
  type AnonymizeSessionUsageInput,
  type UsageLedgerEntry,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const MONTH_START = Date.UTC(2026, 9, 1);

async function createSession(
  store: MemorySessionStore,
  tenantId = "tenant-usage",
  userId = "user-usage",
): Promise<Session> {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  return session;
}

async function tombstone(store: MemorySessionStore, session: Session, generation = 1): Promise<void> {
  await store.commit({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId: session.tenantId,
      userId: session.userId,
      deletionGeneration: generation,
      atMs: MONTH_START + 100,
    },
    events: [{
      type: "session/deleted",
      sessionId: session.id,
      deletionGeneration: generation,
      emittedAtMs: MONTH_START + 100,
    }],
  });
}

function legacyUsage(
  session: Session,
  overrides: Partial<UsageLedgerEntry> = {},
): UsageLedgerEntry {
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step: 1,
    provider: "provider-a",
    model: "model-a",
    usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5, costCNY: undefined },
    createdAtMs: MONTH_START,
    ...overrides,
  };
}

describe("MemorySessionStore usage billing lifecycle", () => {
  it("allocates opaque ids before commit and atomically stages operational and billing rows", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store, "tenant-sensitive", "user-sensitive");
    const usageId = newUsageId();
    expect(isUsageId(usageId)).toBe(true);
    expect(usageId).not.toContain(session.tenantId);
    expect(usageId).not.toContain(session.userId);

    await store.commit({
      sessionId: session.id,
      fence: 1,
      usageEntries: [{
        usageId,
        turnId: newId("turn"),
        step: 1,
        provider: "provider-a",
        model: "model-a",
        usage: { ...emptyUsage(), inputTokens: 7, outputTokens: 2, totalTokens: 9, costCNY: 0.1234567896 },
        createdAtMs: MONTH_START,
      }],
      sessionPatch: { title: "committed" },
    });

    expect(store.usageLedger).toHaveLength(1);
    expect(store.usageLedger[0]?.usageId).toBe(usageId);
    const fact = store.billingUsageFacts.get(usageId)!;
    assertBillingUsageFact(fact);
    expect(fact).toMatchObject({
      usageId,
      tenantId: session.tenantId,
      accountingPeriod: "2026-10",
      provider: "provider-a",
      model: "model-a",
      inputTokens: 7,
      outputTokens: 2,
      totalTokens: 9,
      costCNY: 0.12345679,
      currency: "CNY",
    });
    expect(fact).not.toHaveProperty("userId");
    expect(fact).not.toHaveProperty("sessionId");
    expect(fact).not.toHaveProperty("turnId");
    expect(fact).not.toHaveProperty("step");
    expect(fact).not.toHaveProperty("createdAtMs");
    expect(fact).not.toHaveProperty("reconciledAtMs");
    expect(fact).not.toHaveProperty("usage");
    await store.close();
  });

  it("rejects a duplicate usage id before publishing any part of the batch", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store);
    const usageId = newUsageId();
    await store.commit({
      sessionId: session.id,
      fence: 1,
      usageEntries: [{
        usageId,
        turnId: newId("turn"),
        step: 1,
        provider: "p",
        model: "m",
        usage: { ...emptyUsage(), totalTokens: 1 },
        createdAtMs: MONTH_START,
      }],
      sessionPatch: { title: "before-conflict" },
    });
    const before = await store.getSession(session.tenantId, session.id);

    await expect(store.commit({
      sessionId: session.id,
      fence: 2,
      usageEntries: [{
        usageId,
        turnId: newId("turn"),
        step: 2,
        provider: "different",
        model: "different",
        usage: { ...emptyUsage(), totalTokens: 99 },
        createdAtMs: MONTH_START + 1,
      }],
      events: [{ type: "session/created", sessionId: session.id, emittedAtMs: MONTH_START + 1 }],
      sessionPatch: { title: "must-not-publish", usage: { ...emptyUsage(), totalTokens: 99 } },
    })).rejects.toBeInstanceOf(UsageIdentityConflictError);

    expect(store.usageLedger).toHaveLength(1);
    expect(store.billingUsageFacts).toHaveLength(1);
    expect(await store.getSession(session.tenantId, session.id)).toEqual(before);
    expect(await store.readEvents(session.id, 0, 100)).toHaveLength(1);
    await store.close();
  });

  it("keeps unknown cost absent while preserving a known zero", async () => {
    const store = new MemorySessionStore();
    const unknownOnly = await createSession(store, "tenant-cost", "unknown-user");
    const mixed = await createSession(store, "tenant-cost", "mixed-user");
    const unknownId = newUsageId();
    const mixedUnknownId = newUsageId();
    const zeroId = newUsageId();
    await store.commit({
      sessionId: unknownOnly.id,
      fence: 1,
      usageEntries: [{
        usageId: unknownId, turnId: newId("turn"), step: 1, provider: "p", model: "m",
        usage: { ...emptyUsage(), totalTokens: 1, costCNY: undefined }, createdAtMs: MONTH_START,
      }],
    });
    await store.commit({
      sessionId: mixed.id,
      fence: 1,
      usageEntries: [
        {
          usageId: mixedUnknownId, turnId: newId("turn"), step: 1, provider: "p", model: "m",
          // A real provider result may have no tokens and still have unknown pricing. It must not
          // be mistaken for the known-empty aggregation identity.
          usage: { ...emptyUsage(), costCNY: undefined }, createdAtMs: MONTH_START,
        },
        {
          usageId: zeroId, turnId: newId("turn"), step: 2, provider: "p", model: "m",
          usage: { ...emptyUsage(), totalTokens: 1, costCNY: 0 }, createdAtMs: MONTH_START,
        },
      ],
    });

    const unknownQuery = await store.queryUsage("tenant-cost", {
      sessionId: unknownOnly.id, groupBy: "total", limit: 10,
    });
    expect(unknownQuery.data[0]?.usage.costCNY).toBeUndefined();
    const mixedQuery = await store.queryUsage("tenant-cost", {
      sessionId: mixed.id, groupBy: "total", limit: 10,
    });
    expect(mixedQuery.data[0]?.usage.costCNY).toBeUndefined();
    expect(store.billingUsageFacts.get(unknownId)).not.toHaveProperty("costCNY");
    expect(store.billingUsageFacts.get(mixedUnknownId)).not.toHaveProperty("costCNY");
    expect(store.billingUsageFacts.get(zeroId)?.costCNY).toBe(0);
    await store.close();
  });

  it("normalizes a historical null cost to unknown through query, reconciliation, and anonymization", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store, "tenant-null-cost", "user-null-cost");
    store.usageLedger.push(legacyUsage(session, {
      usage: {
        ...emptyUsage(),
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        costCNY: null,
      } as unknown as UsageLedgerEntry["usage"],
    }));

    const queried = await store.queryUsage(session.tenantId, {
      sessionId: session.id, groupBy: "total", limit: 10,
    });
    expect(queried.data[0]?.usage.costCNY).toBeUndefined();

    await tombstone(store, session);
    const verified = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });
    expect(verified).toMatchObject({ rowCount: 1, knownCostRows: 0, totalTokens: 7 });
    expect(verified).not.toHaveProperty("costCNY");
    const usageId = store.usageLedger[0]?.usageId;
    expect(isUsageId(usageId)).toBe(true);
    expect(store.billingUsageFacts.get(usageId!)).not.toHaveProperty("costCNY");

    await expect(store.anonymizeSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 300,
      enabled: true,
    })).resolves.toMatchObject({ status: "anonymized" });
    expect(store.usageLedger).toHaveLength(0);
    expect(store.billingUsageFacts.has(usageId!)).toBe(true);
    await store.close();
  });

  it("assigns legacy ids without turning an ambiguous zero into priced usage", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store);
    store.usageLedger.push(
      legacyUsage(session, {
        usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      }),
      legacyUsage(session, {
        step: 2,
        usage: { ...emptyUsage(), inputTokens: 4, outputTokens: 2, totalTokens: 6, costCNY: 0 },
      }),
    );
    await tombstone(store, session);

    const first = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });
    expect(first).toMatchObject({
      status: "verified",
      rowCount: 2,
      inputTokens: 6,
      outputTokens: 3,
      totalTokens: 9,
      knownCostRows: 0,
      verifiedAtMs: MONTH_START + 200,
    });
    expect(first).not.toHaveProperty("costCNY");
    expect(first.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(store.usageLedger.every((entry) => isUsageId(entry.usageId))).toBe(true);
    expect(store.usageLedger[1]?.usage).not.toHaveProperty("costCNY");
    expect(store.billingUsageFacts).toHaveLength(2);

    const second = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 300,
    });
    expect(second).toEqual(first);
    expect(store.billingUsageFacts).toHaveLength(2);
    await store.close();
  });

  it("rolls back legacy id assignment when any existing billing fact conflicts", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store);
    const conflictingId = newUsageId();
    store.usageLedger.push(
      legacyUsage(session, { usageId: conflictingId }),
      legacyUsage(session, {
        step: 2,
        usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5, costCNY: 0 },
      }),
    );
    const conflicting = billingUsageFactFromLedger(
      { ...legacyUsage(session, { usageId: conflictingId }), usageId: conflictingId, model: "other-model" },
    );
    store.billingUsageFacts.set(conflictingId, conflicting);
    await tombstone(store, session);

    await expect(store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    })).rejects.toBeInstanceOf(UsageIdentityConflictError);
    expect(store.usageLedger[1]?.usageId).toBeUndefined();
    expect(store.usageLedger[1]?.usage.costCNY).toBe(0);
    expect(store.billingUsageFacts).toHaveLength(1);
    expect(store.usageReconciliations).toHaveLength(0);
    await store.close();
  });

  it("fails closed on operational usage whose owner differs from its session", async () => {
    const store = new MemorySessionStore();
    const corruptTenantId = "tenant-corrupt-claim";
    const corruptUserId = "user-corrupt-claim";
    const reconcileTarget = await createSession(store, "tenant-real-owner", "user-real-owner");
    store.usageLedger.push(
      legacyUsage(reconcileTarget, {
        usage: { ...emptyUsage(), inputTokens: 3, outputTokens: 2, totalTokens: 5, costCNY: 0.25 },
      }),
      legacyUsage(reconcileTarget, {
        tenantId: corruptTenantId,
        userId: corruptUserId,
        step: 2,
      }),
      legacyUsage(reconcileTarget, {
        userId: corruptUserId,
        step: 3,
      }),
    );

    const projected = await store.getSession(reconcileTarget.tenantId, reconcileTarget.id);
    expect(projected?.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(projected?.usage).not.toHaveProperty("costCNY");
    expect((await store.listSessions(reconcileTarget.tenantId, {
      userId: reconcileTarget.userId, includeArchived: true, limit: 10,
    })).data.find((session) => session.id === reconcileTarget.id)?.usage)
      .not.toHaveProperty("costCNY");

    // A forged ledger owner must not turn another tenant's visible session into usage disclosure.
    expect((await store.queryUsage(corruptTenantId, {
      sessionId: reconcileTarget.id,
      groupBy: "total",
      limit: 10,
    })).data).toEqual([]);
    expect((await store.queryUsage(reconcileTarget.tenantId, {
      userId: corruptUserId,
      sessionId: reconcileTarget.id,
      groupBy: "total",
      limit: 10,
    })).data).toEqual([]);

    await tombstone(store, reconcileTarget);
    await expect(store.reconcileSessionUsage({
      tenantId: reconcileTarget.tenantId,
      userId: reconcileTarget.userId,
      sessionId: reconcileTarget.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    })).rejects.toBeInstanceOf(UsageReconciliationError);
    expect(store.usageLedger
      .filter((entry) => entry.sessionId === reconcileTarget.id)
      .map((entry) => entry.usageId)).toEqual([undefined, undefined, undefined]);
    expect(store.billingUsageFacts).toHaveLength(0);
    expect(store.usageReconciliations).toHaveLength(0);

    const anonymizeTarget = await createSession(store, "tenant-anonymize-owner", "user-anonymize-owner");
    store.usageLedger.push(legacyUsage(anonymizeTarget));
    await tombstone(store, anonymizeTarget);
    const verified = await store.reconcileSessionUsage({
      tenantId: anonymizeTarget.tenantId,
      userId: anonymizeTarget.userId,
      sessionId: anonymizeTarget.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 300,
    });
    store.usageLedger.push(legacyUsage(anonymizeTarget, {
      tenantId: corruptTenantId,
      userId: corruptUserId,
      step: 2,
    }));

    await expect(store.anonymizeSessionUsage({
      tenantId: anonymizeTarget.tenantId,
      userId: anonymizeTarget.userId,
      sessionId: anonymizeTarget.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 400,
      enabled: true,
    })).rejects.toBeInstanceOf(UsageReconciliationError);
    expect(store.usageLedger.filter((entry) => entry.sessionId === anonymizeTarget.id)).toHaveLength(2);
    expect([...store.usageReconciliations.values()].find(
      (record) => record.sessionId === anonymizeTarget.id,
    )).toMatchObject({ status: "verified" });
    await store.close();
  });

  it("rejects generation zero, a mismatched generation, and a different owner without mutation", async () => {
    const store = new MemorySessionStore();
    const legacy = await createSession(store, "tenant-isolated", "owner");
    store.usageLedger.push(legacyUsage(legacy));
    store.deleted.set(legacy.id, { deletedAtMs: MONTH_START, deletionGeneration: 0 });

    await expect(store.reconcileSessionUsage({
      tenantId: legacy.tenantId,
      userId: legacy.userId,
      sessionId: legacy.id,
      deletionGeneration: 0,
      nowMs: MONTH_START + 1,
    })).rejects.toBeInstanceOf(UsageLifecycleGenerationError);
    await expect(store.reconcileSessionUsage({
      tenantId: "other-tenant",
      userId: legacy.userId,
      sessionId: legacy.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 1,
    })).rejects.toBeInstanceOf(SessionGoneError);
    expect(store.usageLedger[0]?.usageId).toBeUndefined();

    store.deleted.set(legacy.id, { deletedAtMs: MONTH_START, deletionGeneration: 1 });
    await expect(store.reconcileSessionUsage({
      tenantId: legacy.tenantId,
      userId: legacy.userId,
      sessionId: legacy.id,
      deletionGeneration: 2,
      nowMs: MONTH_START + 1,
    })).rejects.toBeInstanceOf(UsageLifecycleGenerationError);
    expect(store.billingUsageFacts).toHaveLength(0);
    await store.close();
  });

  it("does not reveal whether a different owner is under legal hold", async () => {
    const store = new MemorySessionStore();
    const target = await createSession(store, "tenant-owner", "session-owner");
    await tombstone(store, target);
    const held = await createSession(store, "tenant-probe", "held-user");
    const clear = await createSession(store, "tenant-probe", "clear-user");
    const heldKey = subjectLifecycleKey(held.tenantId, "user", held.userId);
    store.subjectLifecycles.set(heldKey, {
      ...store.subjectLifecycles.get(heldKey)!,
      legalHoldAtMs: MONTH_START + 50,
    });

    const errors: unknown[] = [];
    for (const other of [held, clear]) {
      try {
        await store.anonymizeSessionUsage({
          tenantId: other.tenantId,
          userId: other.userId,
          sessionId: target.id,
          deletionGeneration: 1,
          expectedChecksum: "a".repeat(64),
          nowMs: MONTH_START + 200,
          enabled: true,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(SessionGoneError);
    expect(errors[1]).toBeInstanceOf(SessionGoneError);
    expect((errors[0] as Error).message).toBe((errors[1] as Error).message);
    await store.close();
  });

  it("requires explicit enablement and the verified checksum before deleting only operational rows", async () => {
    const store = new MemorySessionStore();
    const target = await createSession(store, "tenant-anon", "target-user");
    const other = await createSession(store, "tenant-anon", "other-user");
    store.usageLedger.push(legacyUsage(target), legacyUsage(other));
    await tombstone(store, target);
    const verified = await store.reconcileSessionUsage({
      tenantId: target.tenantId,
      userId: target.userId,
      sessionId: target.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });
    const factIds = [...store.billingUsageFacts.keys()];

    await expect(store.anonymizeSessionUsage({
      tenantId: target.tenantId,
      userId: target.userId,
      sessionId: target.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 300,
      enabled: false,
    } as unknown as AnonymizeSessionUsageInput)).rejects.toBeInstanceOf(UsageAnonymizationDisabledError);
    await expect(store.anonymizeSessionUsage({
      tenantId: target.tenantId,
      userId: target.userId,
      sessionId: target.id,
      deletionGeneration: 1,
      expectedChecksum: "0".repeat(64),
      nowMs: MONTH_START + 300,
      enabled: true,
    })).rejects.toBeInstanceOf(UsageReconciliationError);
    expect(store.usageLedger).toHaveLength(2);

    const anonymized = await store.anonymizeSessionUsage({
      tenantId: target.tenantId,
      userId: target.userId,
      sessionId: target.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 300,
      enabled: true,
    });
    expect(anonymized).toMatchObject({ status: "anonymized", anonymizedAtMs: MONTH_START + 300 });
    expect(store.usageLedger.map((entry) => entry.sessionId)).toEqual([other.id]);
    expect([...store.billingUsageFacts.keys()]).toEqual(factIds);

    const targetSubjectKey = subjectLifecycleKey(target.tenantId, "user", target.userId);
    store.subjectLifecycles.set(targetSubjectKey, {
      ...store.subjectLifecycles.get(targetSubjectKey)!,
      legalHoldAtMs: MONTH_START + 350,
    });
    const replay = await store.anonymizeSessionUsage({
      tenantId: target.tenantId,
      userId: target.userId,
      sessionId: target.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 400,
      enabled: true,
    });
    // Model commit-success/response-loss followed by a newly installed hold. The completed
    // destructive transition remains idempotent; the hold still protects every future transition.
    expect(replay).toEqual(anonymized);
    await store.close();
  });

  it("fails closed when durable subject lifecycle state is missing", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store, "tenant-missing-gate", "user-missing-gate");
    store.usageLedger.push(legacyUsage(session));
    await tombstone(store, session);
    const verified = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });
    store.subjectLifecycles.delete(subjectLifecycleKey(session.tenantId, "user", session.userId));

    await expect(store.anonymizeSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 300,
      enabled: true,
    })).rejects.toThrow("subject lifecycle state is missing; anonymization is fail-closed");
    expect(store.usageLedger).toHaveLength(1);
    expect(store.usageReconciliations.values().next().value).toMatchObject({ status: "verified" });
    await store.close();
  });

  it("rejects an anonymization timestamp before its verified reconciliation", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store, "tenant-time-order", "user-time-order");
    store.usageLedger.push(legacyUsage(session));
    await tombstone(store, session);
    const verified = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });

    await expect(store.anonymizeSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 199,
      enabled: true,
    })).rejects.toThrow("anonymization cannot precede verification");
    expect(store.usageLedger).toHaveLength(1);
    expect(store.usageReconciliations.values().next().value).toMatchObject({ status: "verified" });
    await store.close();
  });

  it("uses store-owned legal-hold state rather than trusting the destructive caller", async () => {
    const store = new MemorySessionStore();
    const session = await createSession(store, "tenant-held", "user-held");
    const subjectKey = subjectLifecycleKey(session.tenantId, "user", session.userId);
    const subject = store.subjectLifecycles.get(subjectKey)!;
    store.subjectLifecycles.set(subjectKey, { ...subject, legalHoldAtMs: MONTH_START + 50 });
    store.usageLedger.push(legacyUsage(session));
    await tombstone(store, session);
    const verified = await store.reconcileSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      nowMs: MONTH_START + 200,
    });

    await expect(store.anonymizeSessionUsage({
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      deletionGeneration: 1,
      expectedChecksum: verified.checksum,
      nowMs: MONTH_START + 300,
      enabled: true,
    })).rejects.toBeInstanceOf(UsageLegalHoldError);
    expect(store.usageLedger).toHaveLength(1);
    expect(store.billingUsageFacts).toHaveLength(1);
    await store.close();
  });
});
