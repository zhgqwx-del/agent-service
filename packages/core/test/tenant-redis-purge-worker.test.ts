import { describe, expect, it, vi } from "vitest";
import {
  TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
  TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE,
  TenantRedisPurgeEvidenceChangedError,
  tenantRedisPurgeMarkerSha256,
  tenantRedisPurgeRestoreFenceSha256,
  type ClaimTenantRedisPurgesOptions,
  type ListTenantRedisPurgeRestoreFencesResult,
  type TenantRedisPurgeAdapter,
  type TenantRedisPurgeAdapterResult,
  type TenantRedisPurgeClaim,
  type TenantRedisPurgeReceipt,
  type TenantRedisPurgeRestoreFence,
  type TenantRedisPurgeStore,
  type TenantRedisPurgeTarget,
  type TenantRedisPurgeTargetAck,
} from "@agent-service/store";
import { TenantRedisPurgeWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const SESSION_ID = "sess_0199aabb-ccdd-7004-8000-000000000025";
const DIGEST = "a".repeat(64);
const NAMESPACE = "b".repeat(64);
const OPERATION = "c".repeat(64);

function claim(input: ClaimTenantRedisPurgesOptions): TenantRedisPurgeClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    planBuildGeneration: 1,
    executionGeneration: 1,
    databasePurgeGeneration: 1,
    redisPurgeGeneration: 1,
    t3cReceiptSha256: DIGEST,
    planReceiptSha256: DIGEST,
    redisPlanEntryCount: 3,
    redisPlanEntryRootSha256: DIGEST,
    databasePurgeReceiptSha256: DIGEST,
    graveMarkerCount: 1,
    graveMarkerRootSha256: DIGEST,
    redisNamespaceSha256: NAMESPACE,
    policySha256: DIGEST,
    purgeNotBeforeDbMs: 1_000,
    sourceEvidenceDbMs: 1_001,
    sourceUnresolvedBlockerCount: 9,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
    targetCount: 1,
    targetRootSha256: DIGEST,
  };
}

function target(): TenantRedisPurgeTarget {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    planBuildGeneration: 1,
    executionGeneration: 1,
    databasePurgeGeneration: 1,
    redisPurgeGeneration: 1,
    scope: "tenant-redis-purge-target-v1",
    targetOrdinal: 0,
    sessionId: SESSION_ID,
    graveMarkerSha256: DIGEST,
    redisNamespaceSha256: NAMESPACE,
    leasePlanTargetSha256: DIGEST,
    fencePlanTargetSha256: DIGEST,
    streamPlanTargetSha256: DIGEST,
    operationSha256: OPERATION,
    capturedAtDbMs: 1_001,
    receiptSha256: DIGEST,
  };
}

function result(overrides: Partial<TenantRedisPurgeAdapterResult> = {}): TenantRedisPurgeAdapterResult {
  const { markerSha256: _markerSha256, replayed = false, ...evidenceOverrides } = overrides;
  const evidence = {
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: NAMESPACE,
    sessionId: SESSION_ID,
    operationSha256: OPERATION,
    leaseExisted: true,
    fenceExisted: true,
    streamExisted: false,
    ...evidenceOverrides,
  };
  const markerSha256 = tenantRedisPurgeMarkerSha256(evidence);
  return { ...evidence, markerSha256, replayed };
}

function targetAck(adapterResult = result()): TenantRedisPurgeTargetAck {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    planBuildGeneration: 1,
    executionGeneration: 1,
    databasePurgeGeneration: 1,
    redisPurgeGeneration: 1,
    scope: "tenant-redis-purge-target-ack-v1",
    targetOrdinal: 0,
    sessionId: SESSION_ID,
    targetReceiptSha256: DIGEST,
    operationSha256: OPERATION,
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: NAMESPACE,
    leaseExisted: adapterResult.leaseExisted,
    fenceExisted: adapterResult.fenceExisted,
    streamExisted: adapterResult.streamExisted,
    markerSha256: adapterResult.markerSha256,
    completedClaimAttempt: 2,
    completedClaimTokenSha256: DIGEST,
    storeDbTimestampMs: 2_000,
    receiptSha256: DIGEST,
  };
}

function restoreFence(
  jobPhase: TenantRedisPurgeRestoreFence["jobPhase"] = "queued",
): TenantRedisPurgeRestoreFence {
  const adapterResult = result();
  const body = {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 1,
    planBuildGeneration: 1,
    executionGeneration: 1,
    databasePurgeGeneration: 1,
    redisPurgeGeneration: 1,
    scope: TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE,
    jobPhase,
    targetOrdinal: 0,
    sessionId: SESSION_ID,
    targetReceiptSha256: DIGEST,
    targetAckReceiptSha256: DIGEST,
    terminalReceiptSha256: jobPhase === "redis_purge_sealed" ? DIGEST : null,
    operationSha256: OPERATION,
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: NAMESPACE,
    leaseExisted: adapterResult.leaseExisted,
    fenceExisted: adapterResult.fenceExisted,
    streamExisted: adapterResult.streamExisted,
    markerSha256: adapterResult.markerSha256,
  };
  return { ...body, fenceSha256: tenantRedisPurgeRestoreFenceSha256(body) };
}

function fixture(options: { restoreFences?: TenantRedisPurgeRestoreFence[] } = {}) {
  let acks: TenantRedisPurgeTargetAck[] = [];
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantRedisPurgesOptions) => [claim(input)]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const record = vi.fn(async (_authorization, adapterResult: TenantRedisPurgeAdapterResult) => {
    const ack = targetAck(adapterResult);
    acks = [ack];
    return ack;
  });
  const seal = vi.fn(async () => ({ receiptSha256: DIGEST }) as TenantRedisPurgeReceipt);
  const listRestore = vi.fn(async (): Promise<ListTenantRedisPurgeRestoreFencesResult> => ({
    fences: options.restoreFences ?? [],
  }));
  const store = {
    materializeTenantRedisPurgeJobs: materialize,
    claimTenantRedisPurges: claimJobs,
    renewTenantRedisPurge: renew,
    retryTenantRedisPurge: retry,
    blockTenantRedisPurge: block,
    recordTenantRedisPurgeTargetAck: record,
    sealTenantRedisPurge: seal,
    getTenantRedisPurgeJob: vi.fn(async () => null),
    getTenantRedisPurgeTargets: vi.fn(async () => [target()]),
    getTenantRedisPurgeTargetAcks: vi.fn(async () => [...acks]),
    getTenantRedisPurgeDomainAcks: vi.fn(async () => []),
    getTenantRedisPurgeReceipt: vi.fn(async () => null),
    getTenantRedisPurgeCutover: vi.fn(async () => ({ singletonId: 1 as const, controlGeneration: 0 as const })),
    hasTenantRedisPurgeJobs: vi.fn(async () => false),
    listTenantRedisPurgeRestoreFences: listRestore,
  } as TenantRedisPurgeStore;
  const purge = vi.fn(async () => result());
  const inspect = vi.fn<TenantRedisPurgeAdapter["inspectSessionPurge"]>(async () => null);
  const replayExisting = vi.fn<TenantRedisPurgeAdapter["replayExistingSessionPurge"]>(
    async () => null,
  );
  const restore = vi.fn(async () => result({ replayed: true }));
  const adapter = {
    redisNamespaceSha256: NAMESPACE,
    purgeSessionState: purge,
    inspectSessionPurge: inspect,
    replayExistingSessionPurge: replayExisting,
    restoreSessionPurgeFence: restore,
    close: vi.fn(async () => {}),
  } satisfies TenantRedisPurgeAdapter;
  return {
    store,
    adapter,
    materialize,
    claimJobs,
    renew,
    retry,
    block,
    record,
    seal,
    listRestore,
    purge,
    replayExisting,
    restore,
    getAcks: () => [...acks],
  };
}

describe("TenantRedisPurgeWorker", () => {
  it("uses fresh gates for materialization and Redis mutation, not marker ACK or seal", async () => {
    const state = fixture();
    const canExecute = vi.fn(async () => true);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    }, { leaseMs: 500, batchSize: 3, materializeBatchSize: 7 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.listRestore).toHaveBeenCalledOnce();
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, leaseMs: 500 }));
    expect(state.purge).toHaveBeenCalledWith({ sessionId: SESSION_ID, operationSha256: OPERATION });
    expect(state.record).toHaveBeenCalledOnce();
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(canExecute).toHaveBeenCalledTimes(3);
  });

  it("rechecks ambiguous Redis apply but replays target ACK and seal without new fleet proofs", async () => {
    const state = fixture();
    state.purge
      .mockRejectedValueOnce(new Error("Redis response lost after script commit"))
      .mockResolvedValueOnce(result({ replayed: true }));
    const originalRecord = state.record.getMockImplementation()!;
    state.record
      .mockImplementationOnce(async (...args) => {
        await originalRecord(...args);
        throw new Error("MySQL ACK response lost");
      })
      .mockImplementation(originalRecord);
    let sealCommitted = false;
    state.renew.mockImplementation(async () => !sealCommitted);
    state.seal
      .mockImplementationOnce(async () => {
        sealCommitted = true;
        throw new Error("seal response lost");
      })
      .mockResolvedValueOnce({ receiptSha256: DIGEST } as TenantRedisPurgeReceipt);
    const canExecute = vi.fn(async () => true);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.purge).toHaveBeenCalledTimes(2);
    expect(state.replayExisting).toHaveBeenCalledTimes(2);
    expect(state.record).toHaveBeenCalledTimes(2);
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
    expect(canExecute).toHaveBeenCalledTimes(5);
  });

  it("records and seals an applied marker after the destructive gate closes", async () => {
    const state = fixture();
    const originalRecord = state.record.getMockImplementation()!;
    state.record
      .mockImplementationOnce(async (...args) => {
        await originalRecord(...args);
        throw new Error("MySQL ACK response lost after commit");
      })
      .mockImplementation(originalRecord);
    let gateOpen = true;
    state.purge.mockImplementationOnce(async () => {
      gateOpen = false;
      return result();
    });
    const canExecute = vi.fn(async () => gateOpen);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.purge).toHaveBeenCalledOnce();
    expect(state.record).toHaveBeenCalledTimes(2);
    expect(state.seal).toHaveBeenCalledOnce();
    expect(canExecute).toHaveBeenCalledTimes(3);
  });

  it("recovers a hard-crash marker window with the destructive gate closed", async () => {
    const state = fixture();
    state.replayExisting.mockResolvedValue(result({ replayed: true }));
    const canExecute = vi.fn(async () => false);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.claimJobs).toHaveBeenCalledOnce();
    expect(state.purge).not.toHaveBeenCalled();
    expect(state.record).toHaveBeenCalledOnce();
    expect(state.seal).toHaveBeenCalledOnce();
    expect(canExecute).toHaveBeenCalledOnce();
  });

  it("does not delete when no marker exists and the destructive gate is closed", async () => {
    const state = fixture();
    const canExecute = vi.fn(async () => false);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.claimJobs).toHaveBeenCalledOnce();
    expect(state.replayExisting).toHaveBeenCalledOnce();
    expect(state.purge).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.any(Object), {
      delayMs: 2_000,
      errorCode: "temporary_failure",
    });
    expect(canExecute).toHaveBeenCalledTimes(2);
  });

  it("does not mutate Redis when a slow second fleet proof consumes the renewed lease budget", async () => {
    const state = fixture();
    const now = vi.spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_301);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    }, { leaseMs: 600 });
    try {
      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.purge).not.toHaveBeenCalled();
      expect(state.record).not.toHaveBeenCalled();
      expect(state.retry).toHaveBeenCalledWith(expect.any(Object), {
        delayMs: 2_000,
        errorCode: "temporary_failure",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("fails closed on inspected marker or durable ACK conflicts", async () => {
    const markerConflict = fixture();
    markerConflict.replayExisting
      .mockRejectedValue(new TenantRedisPurgeEvidenceChangedError());
    const markerWorker = new TenantRedisPurgeWorker({
      store: markerConflict.store,
      adapter: markerConflict.adapter,
      canExecute: vi.fn(async () => false),
    });
    await expect(markerWorker.processOnce()).resolves.toBe(0);
    expect(markerConflict.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
    expect(markerConflict.purge).not.toHaveBeenCalled();

    const ackConflict = fixture();
    ackConflict.replayExisting.mockResolvedValue(result({ replayed: true }));
    ackConflict.record.mockRejectedValue(new TenantRedisPurgeEvidenceChangedError());
    const ackWorker = new TenantRedisPurgeWorker({
      store: ackConflict.store,
      adapter: ackConflict.adapter,
      canExecute: vi.fn(async () => false),
    });
    await expect(ackWorker.processOnce()).resolves.toBe(0);
    expect(ackConflict.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
    expect(ackConflict.retry).not.toHaveBeenCalled();
  });

  it("releases a partially ACKed page for a later claim instead of sealing it", async () => {
    const state = fixture();
    const second = { ...target(), targetOrdinal: 1, sessionId: "sess_0199aabb-ccdd-7004-8000-000000000026" };
    vi.mocked(state.store.getTenantRedisPurgeTargets).mockResolvedValue([target(), second]);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    }, { targetPageSize: 1, retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.record).toHaveBeenCalledOnce();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
      delayMs: 20,
      errorCode: "dependency_pending",
    });
  });

  it("drains a successful Redis apply through its first durable ACK during shutdown", async () => {
    const state = fixture();
    let resolvePurge: ((value: TenantRedisPurgeAdapterResult) => void) | undefined;
    state.purge.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePurge = resolve;
    }));
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    }, { pollIntervalMs: 10 });

    worker.start();
    await vi.waitFor(() => expect(state.purge).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolvePurge?.(result());
    await stopping;

    expect(state.record).toHaveBeenCalledOnce();
    expect(state.getAcks()).toHaveLength(1);
    expect(state.seal).not.toHaveBeenCalled();
  });

  it("restores partial and terminal durable fences without consulting the router gate", async () => {
    const queued = restoreFence("queued");
    const sealed = restoreFence("redis_purge_sealed");
    const state = fixture();
    state.listRestore
      .mockResolvedValueOnce({ fences: [queued], nextCursor: queued.targetReceiptSha256 })
      .mockResolvedValueOnce({ fences: [sealed] });
    const canExecute = vi.fn(async () => false);
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute,
    }, { restorePageSize: 1 });

    await expect(worker.replayDurableRestoreFences()).resolves.toBe(2);
    expect(state.restore).toHaveBeenCalledTimes(2);
    expect(canExecute).not.toHaveBeenCalled();
  });

  it("fails restore closed on namespace drift and does not rescan every poll", async () => {
    const drift = { ...restoreFence(), redisNamespaceSha256: "d".repeat(64) };
    const failed = fixture({ restoreFences: [drift] });
    const worker = new TenantRedisPurgeWorker({
      store: failed.store,
      adapter: failed.adapter,
      canExecute: vi.fn(async () => true),
    });
    await expect(worker.replayDurableRestoreFences())
      .rejects.toBeInstanceOf(TenantRedisPurgeEvidenceChangedError);
    expect(failed.restore).not.toHaveBeenCalled();

    const bounded = fixture();
    const closedGate = vi.fn(async () => false);
    const periodic = new TenantRedisPurgeWorker({
      store: bounded.store,
      adapter: bounded.adapter,
      canExecute: closedGate,
    }, { restoreIntervalMs: 60_000 });
    await expect(periodic.processOnce()).resolves.toBe(0);
    await expect(periodic.processOnce()).resolves.toBe(0);
    expect(bounded.listRestore).toHaveBeenCalledOnce();
    expect(bounded.materialize).not.toHaveBeenCalled();
  });

  it("blocks deterministic evidence drift and validates worker bounds", async () => {
    const state = fixture();
    state.purge.mockRejectedValue(new TenantRedisPurgeEvidenceChangedError());
    const worker = new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    });
    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
    expect(state.retry).not.toHaveBeenCalled();

    expect(() => new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    }, { targetPageSize: 1_001 })).toThrow(/must not exceed 1000/);
    expect(() => new TenantRedisPurgeWorker({
      store: state.store,
      adapter: state.adapter,
      canExecute: vi.fn(async () => true),
    }, { retryBaseMs: 10, retryMaxMs: 9 })).toThrow(/must be >=/);
  });
});
