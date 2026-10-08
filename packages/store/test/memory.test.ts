import { describe, expect, it } from "vitest";
import { IdempotencyPendingError, MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "../src/index.js";
import {
  eventBusConformance,
  leaseStoreConformance,
  lifecycleOutboxStoreConformance,
  mkSession,
  newId,
  sessionStoreConformance,
} from "./conformance.js";

sessionStoreConformance("memory", async () => new MemorySessionStore());
lifecycleOutboxStoreConformance("memory", async () => new MemorySessionStore());
leaseStoreConformance("memory", async () => new MemoryLeaseStore(), async (l, sid) => (l as MemoryLeaseStore).expire(sid));
eventBusConformance("memory", async () => new MemoryEventBus());

describe("MemorySessionStore session creation publication", () => {
  it("rolls back lifecycle and session maps when the final creation-event publication fails", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant_create_publish_rollback", "user_create_publish_rollback");
    const originalSet = store.events.set.bind(store.events);
    let fail = true;
    Object.defineProperty(store.events, "set", {
      configurable: true,
      value: (key: string, value: Parameters<typeof store.events.set>[1]) => {
        if (fail) {
          fail = false;
          throw new Error("injected creation event publication failure");
        }
        return originalSet(key, value);
      },
    });

    await expect(store.createSession(session))
      .rejects.toThrow("injected creation event publication failure");
    expect(store.sessions.has(session.id)).toBe(false);
    expect(store.events.has(session.id)).toBe(false);
    expect(store.subjectLifecycles).toHaveLength(0);
    expect(await store.getSession(session.tenantId, session.id)).toBeNull();
    expect(await store.readEvents(session.id, 0, 10)).toEqual([]);

    await expect(store.createSession(session)).resolves.toEqual({
      events: [{
        type: "session/created",
        sessionId: session.id,
        emittedAtMs: session.createdAtMs,
        seq: 1,
      }],
      lastSeq: 1,
    });
    expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ lastSeq: 1 });
    expect(await store.readEvents(session.id, 0, 10)).toHaveLength(1);
    await store.close();
  });
});

describe("MemorySessionStore legacy idempotency compatibility", () => {
  it.each([
    ["unexpired", 60_000],
    ["expired", -60_000],
  ])("does not replace an %s legacy pending reservation", async (_label, expiryOffsetMs) => {
    const store = new MemorySessionStore();
    const session = mkSession();
    await store.createSession(session);
    const key = `legacy-${newId("key")}`;
    const scope = { tenantId: session.tenantId, userId: session.userId, sessionId: session.id };
    const mapKey = JSON.stringify([scope.tenantId, scope.userId, scope.sessionId, key]);
    const expiresAt = Date.now() + expiryOffsetMs;
    store.idem.set(mapKey, { value: null, expiresAt });

    await expect(store.commit({
      sessionId: session.id,
      fence: 1,
      events: [{ type: "session/created", sessionId: session.id, emittedAtMs: 1 }],
      sessionPatch: { title: "must not commit" },
      idempotency: {
        scope,
        key,
        requestHash: "a".repeat(64),
        value: { sessionId: session.id, turnId: newId("turn") },
        expiresAtMs: Date.now() + 60_000,
      },
    })).rejects.toMatchObject({ name: "IdempotencyPendingError", expiresAtMs: expiresAt });

    expect(store.idem.get(mapKey)).toEqual({ value: null, expiresAt });
    expect(await store.getSession(session.tenantId, session.id)).toMatchObject({ fenceToken: 0, lastSeq: 1 });
    expect((await store.getSession(session.tenantId, session.id))?.title).toBeUndefined();
    expect(await store.readEvents(session.id, 0, 10)).toEqual([
      { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
    ]);
    await store.close();
  });

  it("exposes a typed error for host/API translation", () => {
    expect(new IdempotencyPendingError(123)).toMatchObject({ name: "IdempotencyPendingError", expiresAtMs: 123 });
  });
});

describe("MemorySessionStore lifecycle outbox validation", () => {
  it("ignores additive payload fields while preserving the known delivery identity", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant_additive_outbox", "user_additive_outbox");
    await store.createSession(session);
    await store.commit({
      sessionId: session.id,
      fence: 1,
      lifecycle: {
        type: "tombstone",
        atMs: 1,
        deletionGeneration: 1,
        tenantId: session.tenantId,
        userId: session.userId,
      },
      events: [{
        type: "session/deleted",
        sessionId: session.id,
        emittedAtMs: 1,
        deletionGeneration: 1,
      }],
    });
    const row = [...store.lifecycleOutbox.values()].find((candidate) => candidate.topic === "session.tombstoned")!;
    (row as { payload: Record<string, unknown> }).payload.futureOptionalField = "ignored-by-old-worker";

    const claimed = await store.claimLifecycleOutbox({
      topics: ["session.tombstoned"], nowMs: 1, limit: 1, leaseMs: 100, claimToken: "additive-worker",
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload).toEqual({ sessionId: session.id, deletionGeneration: 1, eventSeq: 2 });
    await store.close();
  });

  it("quarantines a topic/payload mismatch instead of repeatedly blocking claims", async () => {
    const store = new MemorySessionStore();
    const session = mkSession("tenant_corrupt_outbox", "user_corrupt_outbox");
    await store.createSession(session);
    await store.commit({
      sessionId: session.id,
      fence: 1,
      lifecycle: {
        type: "tombstone",
        atMs: 1,
        deletionGeneration: 1,
        tenantId: session.tenantId,
        userId: session.userId,
      },
      events: [{
        type: "session/deleted",
        sessionId: session.id,
        emittedAtMs: 1,
        deletionGeneration: 1,
      }],
    });
    const row = [...store.lifecycleOutbox.values()].find((candidate) => candidate.topic === "session.tombstoned")!;
    (row as { payload: unknown }).payload = { sessionId: session.id, deletionGeneration: 1 };

    await expect(store.getLifecycleOutbox("session.tombstoned", session.id, 1)).rejects.toThrow("eventSeq");
    expect(await store.claimLifecycleOutbox({
      topics: ["session.tombstoned"], nowMs: 1, limit: 1, leaseMs: 100, claimToken: "must-not-claim",
    })).toEqual([]);
    const quarantined = [...store.lifecycleOutbox.values()].find(
      (candidate) => candidate.topic === "session.tombstoned",
    );
    expect(quarantined).toMatchObject({
      attempts: 1,
      deadLetteredAtMs: 1,
      lastError: "invalid lifecycle outbox envelope",
    });
    expect(quarantined).not.toHaveProperty("availableAtMs");
    expect(quarantined).not.toHaveProperty("claimToken");
    await store.close();
  });
});
