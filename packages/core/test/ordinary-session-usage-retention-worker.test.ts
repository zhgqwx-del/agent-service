import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrdinarySessionUsageRetentionCandidate, OrdinarySessionUsageRetentionReceipt,
  OrdinarySessionUsageRetentionStore, UsageLifecycleStore } from "@agent-service/store";
import { MemorySessionStore, ORDINARY_SESSION_DELETE_GRACE_MS, newUsageId } from "@agent-service/store";
import { emptyUsage, type Session } from "@agent-service/protocol";
import { OrdinarySessionUsageRetentionWorker } from "../src/lifecycle/ordinary-session-usage-retention-worker.js";

const a: OrdinarySessionUsageRetentionCandidate = { tenantId: "tenant-a", userId: "user-a", sessionId: "session-a", deletionGeneration: 1 };
const b = { ...a, sessionId: "session-b" };
const checksum = "a".repeat(64);
const receipt: OrdinarySessionUsageRetentionReceipt = { schemaVersion: 1, sourceSha256: checksum,
  sealSha256: checksum, deletionPolicySha256: checksum, currentPolicySha256: checksum,
  currentPolicyVersion: "policy-v1",
  deadlineDbMs: 1, executedAtDbMs: 2, checksum, facts: [], allDomainsComplete: false,
  contentPurgeExecuted: false };

function setup() {
  const store = {
    listOrdinarySessionUsageRetentionCandidates: vi.fn<OrdinarySessionUsageRetentionStore["listOrdinarySessionUsageRetentionCandidates"]>()
      .mockResolvedValue([a]),
    reconcileSessionUsage: vi.fn<UsageLifecycleStore["reconcileSessionUsage"]>()
      .mockImplementation(async (input) => ({ ...a, ...input, status: "verified", verifiedAtMs: input.nowMs,
        rowCount: 0, knownCostRows: 0, checksum, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 })),
    executeOrdinarySessionUsageRetention: vi.fn<OrdinarySessionUsageRetentionStore["executeOrdinarySessionUsageRetention"]>()
      .mockResolvedValue(receipt),
  };
  const canExecute = vi.fn(async () => true);
  const warn = vi.fn();
  const worker = new OrdinarySessionUsageRetentionWorker({ store, canExecute, logger: { warn } }, { batchSize: 2 });
  return { store, canExecute, warn, worker };
}

afterEach(() => vi.useRealTimers());

describe("ordinary session usage retention worker", () => {
  it("requires separate fresh gates before scan, reconciliation and atomic execute", async () => {
    const { worker, store, canExecute } = setup();
    await expect(worker.pollOnce()).resolves.toBe(1);
    expect(canExecute).toHaveBeenCalledTimes(3);
    expect(store.listOrdinarySessionUsageRetentionCandidates).toHaveBeenCalledWith({ limit: 2 });
    expect(store.executeOrdinarySessionUsageRetention).toHaveBeenCalledWith({ ...a, expectedChecksum: checksum, enabled: true });
    expect(store.executeOrdinarySessionUsageRetention.mock.calls[0]![0]).not.toHaveProperty("nowMs");
  });

  it("never scans without a gate, and never executes using the prior reconciliation gate", async () => {
    const { worker, store, canExecute } = setup();
    canExecute.mockResolvedValueOnce(false);
    expect(await worker.pollOnce()).toBe(0);
    expect(store.listOrdinarySessionUsageRetentionCandidates).not.toHaveBeenCalled();
    canExecute.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await worker.pollOnce()).toBe(0);
    expect(store.reconcileSessionUsage).toHaveBeenCalledOnce();
    expect(store.executeOrdinarySessionUsageRetention).not.toHaveBeenCalled();
  });

  it("advances past poison rows, bounds each page and wraps a full pass", async () => {
    const { worker, store, warn } = setup();
    store.listOrdinarySessionUsageRetentionCandidates.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([]).mockResolvedValueOnce([a]);
    store.reconcileSessionUsage.mockRejectedValueOnce(new Error("owner-and-secret-must-not-be-logged"));
    expect(await worker.pollOnce()).toBe(1);
    expect(store.executeOrdinarySessionUsageRetention).toHaveBeenCalledWith({ ...b, expectedChecksum: checksum, enabled: true });
    expect(await worker.pollOnce()).toBe(0);
    expect(store.listOrdinarySessionUsageRetentionCandidates.mock.calls[1]![0]).toEqual({ afterSessionId: b.sessionId, limit: 2 });
    expect(await worker.pollOnce()).toBe(1);
    expect(store.listOrdinarySessionUsageRetentionCandidates.mock.calls[2]![0]).toEqual({ limit: 2 });
    expect(warn.mock.calls).toEqual([["ordinary session usage retention failed"]]);
  });

  it("does not count null policy/hold denials and retries an uncommitted failure on a later pass", async () => {
    const { worker, store } = setup();
    store.executeOrdinarySessionUsageRetention.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("transaction failed before commit"));
    store.listOrdinarySessionUsageRetentionCandidates.mockResolvedValueOnce([a, b]).mockResolvedValueOnce([]).mockResolvedValueOnce([b]);
    expect(await worker.pollOnce()).toBe(0);
    expect(await worker.pollOnce()).toBe(0);
    expect(await worker.pollOnce()).toBe(1);
    expect(store.executeOrdinarySessionUsageRetention.mock.calls[1]![0]).toEqual(store.executeOrdinarySessionUsageRetention.mock.calls[2]![0]);
  });

  it("uses the real MemoryStore receipt to exclude committed response loss from later scans", async () => {
    vi.useFakeTimers();
    let clock = Date.UTC(2026, 9, 1);
    vi.setSystemTime(clock);
    const store = new MemorySessionStore({ now: () => clock });
    const session: Session = { id: "sess_retention_worker", tenantId: "tenant-retention-worker", userId: "user-retention-worker",
      agentId: "agt_retention_worker", agentVersion: 1, status: { type: "idle" }, lastSeq: 0,
      contextEpoch: "e0", fenceToken: 0, usage: emptyUsage(), autoApprovedTools: [],
      createdAtMs: clock, updatedAtMs: clock, metadata: {} };
    await store.putRetentionPolicy({ tenantId: session.tenantId, policyVersion: "worker-policy-v1",
      actorKeyId: "worker-policy-admin", atMs: clock, policy: {
        sessionContentRetentionMs: ORDINARY_SESSION_DELETE_GRACE_MS,
        userErasureGraceMs: ORDINARY_SESSION_DELETE_GRACE_MS,
        operationalUsageRetentionMs: ORDINARY_SESSION_DELETE_GRACE_MS,
        idempotencyReceiptRetentionMs: ORDINARY_SESSION_DELETE_GRACE_MS,
        billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: 3_600_000,
      } });
    await store.activateRetentionPolicy({ tenantId: session.tenantId, policyVersion: "worker-policy-v1",
      expectedControlGeneration: 0, actorKeyId: "worker-policy-admin", atMs: clock });
    await store.createSession(session);
    await store.commit({ sessionId: session.id, fence: 1, usageEntries: [{ usageId: newUsageId(), turnId: "turn_retention_worker", step: 1,
      provider: "provider-fixture", model: "model-fixture", usage: { ...emptyUsage(), inputTokens: 1, totalTokens: 1 }, createdAtMs: clock }] });
    await store.commitOrdinarySessionDelete({ sessionId: session.id, fence: 2,
      lifecycle: { type: "tombstone", tenantId: session.tenantId, userId: session.userId, atMs: clock,
        purgeAfterMs: null, deletionGeneration: 1 },
      events: [{ type: "session/deleted", sessionId: session.id, emittedAtMs: clock, deletionGeneration: 1 }] });
    await store.sealOrdinarySessionDeleteGrace(session.tenantId, session.userId, session.id);
    clock += ORDINARY_SESSION_DELETE_GRACE_MS + 1;
    vi.setSystemTime(clock);
    const execute = store.executeOrdinarySessionUsageRetention.bind(store);
    const lostResponse = vi.spyOn(store, "executeOrdinarySessionUsageRetention").mockImplementationOnce(async (input) => {
      expect(await execute(input)).not.toBeNull();
      throw new Error("committed response lost");
    });
    const warn = vi.fn();
    const worker = new OrdinarySessionUsageRetentionWorker({ store, canExecute: async () => true, logger: { warn } });
    try {
      expect(await worker.pollOnce()).toBe(0); // No successful response, not an uncommitted transaction.
      expect(store.usageLedger).toHaveLength(0);
      expect(store.billingUsageFacts.size).toBe(1);
      expect(await store.listOrdinarySessionUsageRetentionCandidates({ limit: 25 })).toEqual([]);
      expect(await worker.pollOnce()).toBe(0);
      expect(await worker.pollOnce()).toBe(0);
      expect(lostResponse).toHaveBeenCalledOnce();
      const exact = await execute(lostResponse.mock.calls[0]![0]);
      expect(exact).toMatchObject({ allDomainsComplete: false, contentPurgeExecuted: false });
      expect((await store.readEvents(session.id, 0, 10)).map((event) => event.type))
        .toEqual(["session/created", "session/deleted"]);
      expect((await store.getLifecycleOutbox("session.purge", session.id, 1))?.availableAtMs).toBeUndefined();
      expect(warn.mock.calls).toEqual([["ordinary session usage retention failed"]]);
    } finally { await worker.stop(); await store.close(); }
  });

  it("recovers scan/gate failures and swallows logger exceptions", async () => {
    const { store, canExecute } = setup();
    const worker = new OrdinarySessionUsageRetentionWorker({ store, canExecute, logger: { warn: () => { throw new Error("sink failed"); } } });
    canExecute.mockRejectedValueOnce(new Error("private transport detail"));
    expect(await worker.pollOnce()).toBe(0);
    store.listOrdinarySessionUsageRetentionCandidates.mockRejectedValueOnce(new Error("private sql detail"));
    expect(await worker.pollOnce()).toBe(0);
    expect(await worker.pollOnce()).toBe(1);
  });

  it("coalesces concurrent passes and stop prevents the next candidate while waiting for in-flight execute", async () => {
    const { worker, store } = setup();
    store.listOrdinarySessionUsageRetentionCandidates.mockResolvedValue([a, b]);
    let resolve!: (value: OrdinarySessionUsageRetentionReceipt) => void;
    store.executeOrdinarySessionUsageRetention.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const first = worker.pollOnce();
    expect(worker.pollOnce()).toBe(first);
    await vi.waitFor(() => expect(store.executeOrdinarySessionUsageRetention).toHaveBeenCalledOnce());
    let stopped = false;
    const shutdown = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolve(receipt);
    expect(await first).toBe(1);
    await shutdown;
    expect(store.reconcileSessionUsage).toHaveBeenCalledOnce();
    expect(await worker.pollOnce()).toBe(0);
  });

  it("runs a non-overlapping timer loop and stops future polling", async () => {
    vi.useFakeTimers();
    const { store, canExecute } = setup();
    const worker = new OrdinarySessionUsageRetentionWorker({ store, canExecute }, { pollIntervalMs: 5 });
    worker.start(); worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.listOrdinarySessionUsageRetentionCandidates).toHaveBeenCalledOnce();
    await worker.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(store.listOrdinarySessionUsageRetentionCandidates).toHaveBeenCalledOnce();
  });

  it("rejects unbounded and malformed options", () => {
    const { store, canExecute } = setup();
    for (const options of [{ batchSize: 0 }, { batchSize: 101 }, { pollIntervalMs: 0 }, { pollIntervalMs: 300_001 }, { batchSize: 1.5 }]) {
      expect(() => new OrdinarySessionUsageRetentionWorker({ store, canExecute }, options)).toThrow();
    }
  });
});
