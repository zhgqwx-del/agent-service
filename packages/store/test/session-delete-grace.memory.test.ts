import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore, ORDINARY_SESSION_DELETE_GRACE_MS, SessionGoneError,
  type RetentionPolicyDocumentV1 } from "../src/index.js";
import { acquireFixtureSessionAuthority, injectGetterAfterFixtureAuthorization } from "./fixtures/session-authority.js";
import { mkSession } from "./conformance.js";

/** Whole Memory durable containers/counters plus the canonical lease tuple and family image.
 * Input admissions are WeakMaps and are intentionally not treated as durable business state. */
function memorySnapshot(store: MemorySessionStore) {
  const authority = store.sessionAuthority.snapshot();
  const state = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(store))
    .flatMap(([key, descriptor]): Array<[string, unknown]> => {
      if (!("value" in descriptor)) return [];
      const value: unknown = descriptor.value;
      return value instanceof Map || value instanceof Set || Array.isArray(value)
        || value === null || ["number", "string", "boolean", "bigint"].includes(typeof value)
        ? [[key, value]] : [];
    }));
  const subagents = Reflect.get(store, "subagents") as { images: Map<string, unknown> };
  return structuredClone({ state, authority, family: subagents.images });
}
async function unchangedMemory(store: MemorySessionStore, work: () => Promise<unknown>) {
  const before = memorySnapshot(store);
  try { await work(); } finally { expect(memorySnapshot(store)).toEqual(before); }
}

type Writer = Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>;

async function tombstone(
  store: MemorySessionStore,
  session: ReturnType<typeof mkSession>,
  ordinaryDeleteGraceOrigin: boolean,
  writer: Writer,
) {
  const atMs = Date.now();
  return (ordinaryDeleteGraceOrigin ? store.commitOrdinarySessionDelete.bind(store)
    : store.commit.bind(store))(writer.admit({
    sessionId: session.id,
    fence: writer.fence,
    lifecycle: {
      type: "tombstone", tenantId: session.tenantId, userId: session.userId,
      atMs, purgeAfterMs: null, deletionGeneration: 1,
    },
    events: [{ type: "session/deleted", sessionId: session.id,
      emittedAtMs: atMs, deletionGeneration: 1 }],
  }));
}

describe("ordinary session DELETE grace MemoryStore", () => {
  it("atomically binds only ordinary origin, then seals a post-commit 30-day floor", async () => {
    let clock = 10_000;
    const store = new MemorySessionStore({ now: () => clock });
    const session = mkSession("tenant-grace-memory", "user-grace-memory");
    await store.createSession(session);
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id)).toBeNull();
    await tombstone(store, session, true, writer);
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
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    await tombstone(store, session, false, writer);
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
      .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace).toBeUndefined();
  });

  it("rejects ordinary provenance forged in a generic lifecycle commit", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant-grace-forge", "user-grace-forge");
    await store.createSession(session);
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    const atMs = Date.now();
    const forged = {
      sessionId: session.id, fence: 1,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1,
        ordinaryDeleteGraceOrigin: true },
      events: [{ type: "session/deleted", sessionId: session.id,
        emittedAtMs: atMs, deletionGeneration: 1 }],
    } as unknown as Parameters<MemorySessionStore["commit"]>[0];
    await unchangedMemory(store, () => expect(store.commit(writer.admit(forged))).rejects.toThrow(/not accepted/));
    expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
      .toEqual(["session/created"]);
    expect(store.deleted.has(session.id)).toBe(false);
    await unchangedMemory(store, () => expect(store.commitOrdinarySessionDelete(writer.admit({
      ...forged,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: "other-user",
        atMs, purgeAfterMs: null, deletionGeneration: 1 },
    }))).rejects.toBeInstanceOf(SessionGoneError));
    expect(store.deleted.has(session.id)).toBe(false);
    await tombstone(store, session, true, writer);
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
    const firstWriter = await acquireFixtureSessionAuthority(store, first, 0);
    await tombstone(store, first, true, firstWriter);
    const secondWriter = await acquireFixtureSessionAuthority(store, second, 0);
    await tombstone(store, second, true, secondWriter);
    const legacyWriter = await acquireFixtureSessionAuthority(store, legacy, 0);
    await tombstone(store, legacy, false, legacyWriter);
    await unchangedMemory(store, () => expect(store.retryUnsealedOrdinarySessionDeleteGraceOrigins(0)).rejects.toThrow(/limit/));
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
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    await tombstone(store, session, true, writer);
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
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    const atMs = Date.now();
    const metadata: Record<string, unknown> = {};
    const batch = writer.admit({
      sessionId: session.id,
      fence: 1,
      lifecycle: {
        type: "tombstone", tenantId: session.tenantId, userId: session.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1,
      },
      events: [{ type: "session/deleted", sessionId: session.id,
        emittedAtMs: atMs, deletionGeneration: 1 }],
      sessionPatch: { metadata },
    });
    const originalCommit = store.commit.bind(store);
    let observedFault = false;
    const commitSpy = vi.spyOn(store, "commit").mockImplementationOnce(async marked => {
      // The ordinary-delete wrapper creates this trusted clone. Keep its genuine transferred
      // admission and both real authorization calls; inject only at its real serializer.
      expect(marked).not.toBe(batch);
      expect(marked.sessionPatch?.metadata).toBe(metadata);
      const fault = injectGetterAfterFixtureAuthorization(store, marked, metadata, "uncloneable", "injected ordinary delete serialization failure");
      try {
        return await originalCommit(marked);
      } finally {
        const stats = fault.stats();
        fault.restore();
        expect(stats).toMatchObject({ validated: 2, installed: true });
        expect(stats.getterReads).toBeGreaterThan(0);
        observedFault = true;
      }
    });
    try {
      await unchangedMemory(store, () => expect(store.commitOrdinarySessionDelete(batch))
        .rejects.toThrow("injected ordinary delete serialization failure"));
      expect(observedFault).toBe(true);
    } finally { commitSpy.mockRestore(); }
    expect(await store.getSessionLifecycle(session.tenantId, session.userId, session.id))
      .toMatchObject({ deletedAtMs: undefined, deletionGeneration: 0 });
    expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
      .toEqual(["session/created"]);
    expect(await store.getLifecycleOutbox("session.purge", session.id, 1)).toBeNull();
    expect(store.deleted.has(session.id)).toBe(false);
    expect((await store.getSession(session.tenantId, session.id))?.fenceToken).toBe(1);
  });

  it("fails closed on clock regression, source drift and safe-integer overflow", async () => {
    let clock = 20_000;
    const store = new MemorySessionStore({ now: () => clock });
    const session = mkSession("tenant-grace-drift", "user-grace-drift");
    await store.createSession(session);
    const writer = await acquireFixtureSessionAuthority(store, session, 0);
    await tombstone(store, session, true, writer);
    clock = 19_999;
    await unchangedMemory(store, () => expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/clock moved/));
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.sealSha256).toBeUndefined();
    clock = Number.MAX_SAFE_INTEGER - ORDINARY_SESSION_DELETE_GRACE_MS;
    await unchangedMemory(store, () => expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/safe integer/));
    expect(store.deleted.get(session.id)?.ordinaryDeleteGrace?.sealSha256).toBeUndefined();
    clock = 25_000;
    const purge = store.lifecycleOutbox.get(JSON.stringify(["session.purge", session.id, 1]));
    if (!purge) throw new Error("missing purge fixture");
    purge.availableAtMs = 1;
    await unchangedMemory(store, () => expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/source is invalid/));
    purge.availableAtMs = undefined;
    const events = (store as unknown as {
      events: Map<string, Array<{ sessionId: string }>>;
    }).events.get(session.id);
    if (!events?.length) throw new Error("missing terminal event fixture");
    events[events.length - 1]!.sessionId = "another-session";
    await unchangedMemory(store, () => expect(store.sealOrdinarySessionDeleteGrace(
      session.tenantId, session.userId, session.id,
    )).rejects.toThrow(/terminal source is invalid/));
  });
});
