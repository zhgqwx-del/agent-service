import { describe, expect, it } from "vitest";
import { IdempotencyPendingError, MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "../src/index.js";
import { eventBusConformance, leaseStoreConformance, mkSession, newId, sessionStoreConformance } from "./conformance.js";

sessionStoreConformance("memory", async () => new MemorySessionStore());
leaseStoreConformance("memory", async () => new MemoryLeaseStore(), async (l, sid) => (l as MemoryLeaseStore).expire(sid));
eventBusConformance("memory", async () => new MemoryEventBus());

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
