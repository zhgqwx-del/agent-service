import { describe, expect, it } from "vitest";
import { emptyUsage, type Event, type Session } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore, type EventBus, type EventListener } from "@agent-service/store";
import { LifecycleOutboxDispatcher, newId } from "../src/index.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function session(): Session {
  const now = Date.now();
  return {
    id: newId("sess"),
    tenantId: "tenant_dispatcher",
    userId: "user_dispatcher",
    agentId: newId("agt"),
    agentVersion: 1,
    status: { type: "idle" },
    lastSeq: 0,
    contextEpoch: "dispatcher",
    fenceToken: 0,
    usage: emptyUsage(),
    autoApprovedTools: [],
    metadata: {},
    createdAtMs: now,
    updatedAtMs: now,
  };
}

async function tombstone(store: MemorySessionStore) {
  const value = session();
  const atMs = Date.now();
  await store.createSession(value);
  await store.commit({
    sessionId: value.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      atMs,
      deletionGeneration: 1,
      tenantId: value.tenantId,
      userId: value.userId,
    },
    events: [{
      type: "session/deleted",
      sessionId: value.id,
      emittedAtMs: atMs,
      deletionGeneration: 1,
    }],
  });
  return { session: value, atMs };
}

class FlakyBus implements EventBus {
  readonly inner = new MemoryEventBus();
  failures = 1;

  async publish(sessionId: string, event: Event) {
    if (this.failures-- > 0) throw new Error("Bearer should-never-be-persisted");
    await this.inner.publish(sessionId, event);
  }

  subscribe(sessionId: string, listener: EventListener, opts?: { afterSeq?: number }) {
    return this.inner.subscribe(sessionId, listener, opts);
  }

  close() {
    return this.inner.close();
  }
}

class LostAckStore extends MemorySessionStore {
  loseNextCompletion = true;

  override async completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number) {
    if (this.loseNextCompletion) {
      this.loseNextCompletion = false;
      return false;
    }
    return super.completeLifecycleOutbox(outboxId, claimToken, completedAtMs);
  }
}

describe("LifecycleOutboxDispatcher", () => {
  it("publishes the exact durable terminal event and completes its intent", async () => {
    const store = new MemorySessionStore();
    const bus = new MemoryEventBus();
    const created = await tombstone(store);
    const received: Event[] = [];
    await bus.subscribe(created.session.id, (event) => received.push(event));
    const dispatcher = new LifecycleOutboxDispatcher({ store, bus, logger: silent });

    expect(await dispatcher.dispatchOnce(created.atMs)).toBe(1);
    expect(received).toEqual([
      expect.objectContaining({
        type: "session/deleted",
        sessionId: created.session.id,
        seq: 2,
        deletionGeneration: 1,
      }),
    ]);
    const completed = await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1);
    expect(completed).toMatchObject({
      attempts: 1,
      completedAtMs: expect.any(Number),
    });
    expect(completed).not.toHaveProperty("claimToken");
    expect(completed).not.toHaveProperty("leaseUntilMs");
    const purge = await store.getLifecycleOutbox("session.purge", created.session.id, 1);
    expect(purge).toMatchObject({ attempts: 0 });
    expect(purge).not.toHaveProperty("availableAtMs");
  });

  it("retries a transient bus failure without persisting credentials", async () => {
    const store = new MemorySessionStore();
    const bus = new FlakyBus();
    const created = await tombstone(store);
    const received: Event[] = [];
    await bus.subscribe(created.session.id, (event) => received.push(event));
    const dispatcher = new LifecycleOutboxDispatcher({ store, bus, logger: silent }, { retryBaseMs: 1, retryMaxMs: 1 });

    expect(await dispatcher.dispatchOnce(created.atMs)).toBe(0);
    const retry = await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1);
    expect(retry).toMatchObject({ attempts: 1, lastError: "Bearer [REDACTED]" });
    expect(retry?.lastError).not.toContain("should-never-be-persisted");

    expect(await dispatcher.dispatchOnce(retry!.availableAtMs!)).toBe(1);
    expect(received.filter((event) => event.type === "session/deleted")).toHaveLength(1);
    expect(await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1)).toMatchObject({
      attempts: 2,
      completedAtMs: expect.any(Number),
    });
  });

  it("delivers at least once and uses seq as the duplicate identity after a lost acknowledgement", async () => {
    const store = new LostAckStore();
    const bus = new MemoryEventBus();
    const created = await tombstone(store);
    const received: Event[] = [];
    await bus.subscribe(created.session.id, (event) => received.push(event));
    const dispatcher = new LifecycleOutboxDispatcher({ store, bus, logger: silent }, { leaseMs: 100 });

    expect(await dispatcher.dispatchOnce(created.atMs)).toBe(0);
    const claimed = await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1);
    expect(await dispatcher.dispatchOnce(claimed!.leaseUntilMs!)).toBe(1);

    const deletions = received.filter((event) => event.type === "session/deleted");
    expect(deletions).toHaveLength(2);
    expect(deletions.map((event) => event.seq)).toEqual([2, 2]);
  });

  it("dead-letters a poison intent and never widens into physical purge", async () => {
    const store = new MemorySessionStore();
    const bus = new MemoryEventBus();
    const created = await tombstone(store);
    store.events.get(created.session.id)!.pop();
    const dispatcher = new LifecycleOutboxDispatcher({ store, bus, logger: silent });

    expect(await dispatcher.dispatchOnce(created.atMs)).toBe(0);
    const deadLettered = await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1);
    expect(deadLettered).toMatchObject({
      attempts: 1,
      deadLetteredAtMs: expect.any(Number),
    });
    expect(deadLettered).not.toHaveProperty("availableAtMs");
    expect(await store.getLifecycleOutbox("session.purge", created.session.id, 1)).toMatchObject({ attempts: 0 });
  });

  it("keeps transient delivery failures retryable beyond the former finite attempt cap", async () => {
    const store = new MemorySessionStore();
    const bus = new FlakyBus();
    bus.failures = 21;
    const created = await tombstone(store);
    const dispatcher = new LifecycleOutboxDispatcher(
      { store, bus, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1 },
    );

    let nowMs = created.atMs;
    for (let attempt = 1; attempt <= 21; attempt += 1) {
      expect(await dispatcher.dispatchOnce(nowMs)).toBe(0);
      const pending = await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1);
      expect(pending).toMatchObject({ attempts: attempt, availableAtMs: expect.any(Number) });
      expect(pending).not.toHaveProperty("deadLetteredAtMs");
      nowMs = pending!.availableAtMs!;
    }

    expect(await dispatcher.dispatchOnce(nowMs)).toBe(1);
    expect(await store.getLifecycleOutbox("session.tombstoned", created.session.id, 1)).toMatchObject({
      attempts: 22,
      completedAtMs: expect.any(Number),
    });
  });

  it("lets only one concurrent dispatcher claim a row", async () => {
    const store = new MemorySessionStore();
    const bus = new MemoryEventBus();
    const created = await tombstone(store);
    const received: Event[] = [];
    await bus.subscribe(created.session.id, (event) => received.push(event));
    const first = new LifecycleOutboxDispatcher({ store, bus, logger: silent });
    const second = new LifecycleOutboxDispatcher({ store, bus, logger: silent });

    expect((await Promise.all([first.dispatchOnce(created.atMs), second.dispatchOnce(created.atMs)])).sort()).toEqual([0, 1]);
    expect(received.filter((event) => event.type === "session/deleted")).toHaveLength(1);
  });
});
