import { describe, expect, it, vi } from "vitest";
import { MemorySessionStore, ORDINARY_SESSION_DELETE_GRACE_MS } from "@agent-service/store";
import { OrdinarySessionDeleteGraceRecovery } from "../src/index.js";
import { mkSession } from "../../store/test/conformance.js";

async function ordinaryDelete(store: MemorySessionStore, session: ReturnType<typeof mkSession>) {
  const atMs = Date.now();
  return store.commitOrdinarySessionDelete({
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

describe("ordinary session DELETE grace recovery", () => {
  it("validates a bounded batch and poll interval", () => {
    const store = new MemorySessionStore();
    expect(() => new OrdinarySessionDeleteGraceRecovery({ store }, { batchSize: 0 }))
      .toThrow(/batch size/);
    expect(() => new OrdinarySessionDeleteGraceRecovery({ store }, { batchSize: 101 }))
      .toThrow(/batch size/);
    expect(() => new OrdinarySessionDeleteGraceRecovery({ store }, { pollIntervalMs: 0 }))
      .toThrow(/poll interval/);
  });

  it("seals only committed ordinary origins through the Memory store and never schedules purge", async () => {
    let clock = 100_000;
    const store = new MemorySessionStore({ now: () => clock });
    const first = mkSession("tenant-recovery", "user-recovery");
    const second = mkSession("tenant-recovery", "user-recovery");
    const legacy = mkSession("tenant-recovery", "user-recovery");
    for (const session of [first, second, legacy]) await store.createSession(session);
    await ordinaryDelete(store, first);
    await ordinaryDelete(store, second);
    const atMs = Date.now();
    await store.commit({
      sessionId: legacy.id, fence: 1,
      lifecycle: { type: "tombstone", tenantId: legacy.tenantId, userId: legacy.userId,
        atMs, purgeAfterMs: null, deletionGeneration: 1 },
      events: [{ type: "session/deleted", sessionId: legacy.id,
        emittedAtMs: atMs, deletionGeneration: 1 }],
    });

    const recovery = new OrdinarySessionDeleteGraceRecovery({ store }, { batchSize: 1 });
    clock = 110_000;
    expect(await recovery.recoverOnce()).toBe(1);
    expect(await recovery.recoverOnce()).toBe(1);
    expect(await recovery.recoverOnce()).toBe(0);
    for (const session of [first, second]) {
      expect(await store.getOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id))
        .toEqual({ state: "sealed", graceFloorDbMs: 110_001 + ORDINARY_SESSION_DELETE_GRACE_MS,
          executionReady: false, physicalPurgeEnabled: false });
      expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs)
        .toBeUndefined();
    }
    expect(await store.getOrdinarySessionDeleteGrace(legacy.tenantId, legacy.userId, legacy.id))
      .toEqual({ state: "unknown", executionReady: false, physicalPurgeEnabled: false });
    expect(store.deleted.get(legacy.id)?.ordinaryDeleteGrace).toBeUndefined();
  });

  it("starts at most one pass and waits for an in-flight pass before stop", async () => {
    let finish: ((value: number) => void) | undefined;
    const retry = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const recovery = new OrdinarySessionDeleteGraceRecovery({
      store: { retryUnsealedOrdinarySessionDeleteGraceOrigins: retry },
    }, { pollIntervalMs: 1, batchSize: 3 });
    recovery.start();
    recovery.start();
    await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(retry).toHaveBeenCalledWith(3);
    const stopping = recovery.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.(1);
    await stopping;
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("redacts recovery errors and keeps polling without changing store authority", async () => {
    const warn = vi.fn(() => { throw new Error("logging sink unavailable"); });
    const retry = vi.fn()
      .mockRejectedValueOnce(new Error("mysql://secret@host/private-owner"))
      .mockResolvedValue(0);
    const recovery = new OrdinarySessionDeleteGraceRecovery({
      store: { retryUnsealedOrdinarySessionDeleteGraceOrigins: retry }, logger: { warn },
    }, { pollIntervalMs: 10, batchSize: 2 });
    recovery.start();
    try {
      await vi.waitFor(() => expect(retry.mock.calls.length).toBeGreaterThanOrEqual(2));
      expect(warn).toHaveBeenCalledWith("ordinary DELETE grace recovery failed");
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|private-owner/);
    } finally {
      await recovery.stop();
    }
  });
});
