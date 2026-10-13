import { describe, expect, it } from "vitest";
import { MemorySessionStore, ORDINARY_SESSION_DELETE_GRACE_MS, SessionGoneError,
  type RetentionPolicyDocumentV1 } from "../src/index.js";
import { mkSession } from "./conformance.js";

async function tombstone(
  store: MemorySessionStore,
  session: ReturnType<typeof mkSession>,
  ordinaryDeleteGraceOrigin: boolean,
) {
  const atMs = Date.now();
  return (ordinaryDeleteGraceOrigin ? store.commitOrdinarySessionDelete.bind(store)
    : store.commit.bind(store))({
    sessionId: session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone", tenantId: session.tenantId, userId: session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1,
    },
    events: [{ type: "session/deleted", sessionId: session.id,
      emittedAtMs: atMs, deletionGeneration: 1 }],
  });
}

describe("ordinary session DELETE grace MemoryStore", () => {
  it("atomically binds only ordinary origin, then seals a post-commit 30-day floor", async () => {
    let clock = 10_000;
    const store = new MemorySessionStore({ now: () => clock });
    const session = mkSession("tenant-grace-memory", "user-grace-memory");
    await store.createSession(session);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id)).toBeNull();
    await tombstone(store, session, true);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, "other-user", session.id)).toBeNull();
    expect(await store.getOrdinarySessionDeleteGrace("other-tenant", session.userId, session.id)).toBeNull();
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.originObservedDbMs).toBe(10_000);
    expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs).toBeUndefined();

    clock = 12_000;
    await store.sealOrdinarySessionDeleteGrace("other-tenant", session.userId, session.id);
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.sealObservedDbMs).toBeUndefined();
    await Promise.all([
      store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id),
      store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id),
    ]);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toEqual({
        state: "sealed", graceFloorDbMs: 12_001 + ORDINARY_SESSION_DELETE_GRACE_MS,
        executionReady: false, physicalPurgeEnabled: false,
      });
    clock = 1; // exact replay does not shorten a durable seal after clock rollback
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs).toBeUndefined();
  });

  it("keeps legacy and erasure-shaped tombstones unknown and cannot infer ordinary origin", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-grace-legacy", "user-grace-legacy");
    await store.createSession(session);
    await tombstone(store, session, false);
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace).toBeUndefined();
  });

  it("rejects ordinary provenance forged in a generic lifecycle commit", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-grace-forge", "user-grace-forge");
    await store.createSession(session);
    const atMs = Date.now();
    const forged = {
      sessionId: session.id, fence: 1,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1,
        ordinaryDeleteGraceOrigin: true },
      events: [{ type: "session/deleted", sessionId: session.id,
        emittedAtMs: atMs, deletionGeneration: 1 }],
    } as unknown as Parameters<MemorySessionStore["commit"]>[0];
    await expect(store.commit(forged)).rejects.toThrow(/not accepted/);
    expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
      .toEqual(["session/created"]);
    expect(store.deleted.has(session.id)).toBe(false);
    await expect(store.commitOrdinarySessionDelete({
      ...forged,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: "other-user",
        atMs, purgeAfterMs: null, deletionGeneration: 1 },
    })).rejects.toBeInstanceOf(SessionGoneError);
    expect(store.deleted.has(session.id)).toBe(false);
    await tombstone(store, session, true);
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.originSha256)
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it("offers bounded, default-unwired recovery only for committed ordinary origins", async () => {
    let clock = 100_000;
    const store = new MemorySessionStore({ now: () => clock });
    const first = mkSession("tenant-grace-recover", "user-grace-recover");
    const second = mkSession("tenant-grace-recover", "user-grace-recover");
    const legacy = mkSession("tenant-grace-recover", "user-grace-recover");
    for (const session of [first, second, legacy]) await store.createSession(session);
    await tombstone(store, first, true);
    await tombstone(store, second, true);
    await tombstone(store, legacy, false);
    await expect(store.retryUnsealedOrdinarySessionDeleteGraceOrigins(0)).rejects.toThrow(/limit/);
    clock = 110_000;
    expect(await store.retryUnsealedOrdinarySessionDeleteGraceOrigins(1)).toBe(1);
    expect(await store.retryUnsealedOrdinarySessionDeleteGraceOrigins(1)).toBe(1);
    expect(await store.retryUnsealedOrdinarySessionDeleteGraceOrigins(1)).toBe(0);
    expect(await store.getOrdinarySessionDeleteGrace(legacy.tenantId, legacy.userId, legacy.id))
      .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    for (const session of [first, second]) {
      expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
        .toEqual({ state: "sealed", graceFloorDbMs: 110_001 + ORDINARY_SESSION_DELETE_GRACE_MS,
          executionReady: false, physicalPurgeEnabled: false });
    }
  });

  it("never turns the 30-day floor into permission under 90-day, NULL or legal-hold policy", async () => {
    let clock = 10_000;
    const store = new MemorySessionStore({ now: () => clock });
    const session = mkSession("tenant-grace-policy", "user-grace-policy");
    const policy: RetentionPolicyDocumentV1 = {
      sessionContentRetentionMs: 90 * 24 * 60 * 60 * 1000,
      userErasureGraceMs: 7 * 24 * 60 * 60 * 1000,
      operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: 24 * 60 * 60 * 1000,
      billingFactRetentionMs: null,
      lifecycleAuditRetentionMs: null,
      exportArtifactTtlMs: 60 * 60 * 1000,
    };
    await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: "policy-90d",
      policy, actorKeyId: "policy-admin", atMs: clock });
    await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: "policy-90d",
      expectedControlGeneration: 0, actorKeyId: "policy-admin", atMs: clock });
    await store.setLegalHold({ tenantId: session.tenantId, holdId: "hold_grace_policy",
      subjectKind: "user", subjectId: session.userId, reasonCode: "litigation",
      expectedControlGeneration: 0, actorKeyId: "policy-admin", atMs: clock });
    await store.createSession(session);
    await tombstone(store, session, true);
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toMatchObject({ state: "sealed", executionReady: false, physicalPurgeEnabled: false });
    expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs).toBeUndefined();
    await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: "policy-null",
      policy: { ...policy, sessionContentRetentionMs: null },
      actorKeyId: "policy-admin", atMs: clock });
    await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: "policy-null",
      expectedControlGeneration: 1, actorKeyId: "policy-admin", atMs: clock });
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toMatchObject({ state: "sealed", executionReady: false, physicalPurgeEnabled: false });
    expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs).toBeUndefined();
  });

  it("does not publish an origin, event, outbox or fence after serialization failure", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-grace-rollback", "user-grace-rollback");
    await store.createSession(session);
    const atMs = Date.now();
    await expect(store.commitOrdinarySessionDelete({
      sessionId: session.id,
      fence: 1,
      lifecycle: {
        type: "tombstone", tenantId: session.tenantId, userId: session.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1,
      },
      events: [{ type: "session/deleted", sessionId: session.id,
        emittedAtMs: atMs, deletionGeneration: 1 }],
      sessionPatch: { metadata: { uncloneable: () => 1 } },
    })).rejects.toThrow();
    expect(await store.getSessionLifecycle(session.tenantId, session.userId, session.id))
      .toMatchObject({ deletedAtMs: undefined, deletionGeneration: 0 });
    expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
      .toEqual(["session/created"]);
    expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
    expect(store.deleted.has(session.id)).toBe(false);
    expect((await store.getSession(session.tenantId, session.id))?.fenceToken).toBe(0);
  });

  it("fails closed on clock regression, source drift and safe-integer overflow", async () => {
    let clock = 20_000;
    const store = new MemorySessionStore({ now: () => clock });
    const session = mkSession("tenant-grace-drift", "user-grace-drift");
    await store.createSession(session);
    await tombstone(store, session, true);
    clock = 19_999;
    await expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/clock moved/);
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.sealSha256).toBeUndefined();
    clock = Number.MAX_SAFE_INTEGER - ORDINARY_SESSION_DELETE_GRACE_MS;
    await expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/safe integer/);
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.sealSha256).toBeUndefined();
    clock = 25_000;
    const purge = store.lifecycleOutbox.get(JSON.stringify(["session.purge", session.id, 1]));
    if (!purge) throw new Error("missing purge fixture");
    purge.availableAtMs = 1;
    await expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/source is invalid/);
  });
});
