import { describe, expect, it, vi } from "vitest";
import {
  TenantDatabasePurgeEvidenceChangedError,
  TenantDatabasePurgeNotReadyError,
  TenantErasureIntegrityError,
  type ClaimTenantDatabasePurgesOptions,
  type TenantDatabasePurgeClaim,
  type TenantDatabasePurgeReceipt,
  type TenantDatabasePurgeStore,
} from "@agent-service/store";
import { TenantDatabasePurgeWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const DIGEST = "a".repeat(64);

function claim(input: ClaimTenantDatabasePurgesOptions): TenantDatabasePurgeClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    planBuildGeneration: 1,
    executionGeneration: 1,
    databasePurgeGeneration: 1,
    t3cReceiptSha256: DIGEST,
    planReceiptSha256: DIGEST,
    localPhysicalAckReceiptSha256: DIGEST,
    policySha256: DIGEST,
    purgeNotBeforeDbMs: 1_000,
    sourceEvidenceDbMs: 1_001,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
  };
}

function fixture() {
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantDatabasePurgesOptions) => [claim(input)]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const execute = vi.fn(async () => ({ receiptSha256: DIGEST }) as TenantDatabasePurgeReceipt);
  const store: TenantDatabasePurgeStore = {
    materializeTenantDatabasePurgeJobs: materialize,
    claimTenantDatabasePurges: claimJobs,
    renewTenantDatabasePurge: renew,
    retryTenantDatabasePurge: retry,
    blockTenantDatabasePurge: block,
    executeTenantDatabasePurge: execute,
    getTenantDatabasePurgeJob: vi.fn(async () => null),
    getTenantDatabasePurgePreDeleteEntries: vi.fn(async () => []),
    getTenantDatabasePurgePreDeleteReceipt: vi.fn(async () => null),
    getTenantDatabasePurgeDomainAcks: vi.fn(async () => []),
    getTenantDatabasePurgeReceipt: vi.fn(async () => null),
    getTenantDatabasePurgeCutover: vi.fn(async () => ({
      singletonId: 1 as const,
      controlGeneration: 0 as const,
    })),
    getTenantPurgeSessionGraveMarker: vi.fn(async () => null),
  };
  return { store, materialize, claimJobs, renew, retry, block, execute };
}

describe("TenantDatabasePurgeWorker", () => {
  it("requires fresh fleet gates around materialize, claim, renew, and destructive execution", async () => {
    const state = fixture();
    const canExecute = vi.fn(async () => true);
    const worker = new TenantDatabasePurgeWorker({ store: state.store, canExecute }, {
      leaseMs: 500,
      batchSize: 3,
      materializeBatchSize: 7,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      leaseMs: 500,
    }));
    expect(state.renew).toHaveBeenCalledOnce();
    expect(state.execute).toHaveBeenCalledOnce();
    expect(canExecute.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("does not touch the queue while either initial fleet barrier is closed", async () => {
    const beforeMaterialize = fixture();
    const first = new TenantDatabasePurgeWorker({
      store: beforeMaterialize.store,
      canExecute: vi.fn(async () => false),
    });
    await expect(first.processOnce()).resolves.toBe(0);
    expect(beforeMaterialize.materialize).not.toHaveBeenCalled();

    const beforeClaim = fixture();
    const gates = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const second = new TenantDatabasePurgeWorker({ store: beforeClaim.store, canExecute: gates });
    await expect(second.processOnce()).resolves.toBe(0);
    expect(beforeClaim.materialize).toHaveBeenCalledOnce();
    expect(beforeClaim.claimJobs).not.toHaveBeenCalled();
  });

  it("releases the claim without deletion when the per-action barrier closes", async () => {
    const state = fixture();
    const gates = [true, true, true, true, false];
    const worker = new TenantDatabasePurgeWorker({
      store: state.store,
      canExecute: vi.fn(async () => gates.shift() ?? false),
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.renew).toHaveBeenCalledOnce();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ errorCode: "temporary_failure" }));
  });

  it("uses a new fleet proof before exact response-loss replay", async () => {
    const state = fixture();
    state.execute
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce({ receiptSha256: DIGEST } as TenantDatabasePurgeReceipt);
    const worker = new TenantDatabasePurgeWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();

    const closed = fixture();
    closed.execute.mockRejectedValueOnce(new Error("outcome unknown"));
    const gates = [true, true, true, true, true, false];
    const stopped = new TenantDatabasePurgeWorker({
      store: closed.store,
      canExecute: vi.fn(async () => gates.shift() ?? false),
    });
    await expect(stopped.processOnce()).resolves.toBe(0);
    expect(closed.execute).toHaveBeenCalledOnce();
    expect(closed.retry).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ errorCode: "temporary_failure" }));
  });

  it("retries dependency waits and blocks deterministic integrity drift", async () => {
    const pending = fixture();
    pending.execute.mockRejectedValue(new TenantDatabasePurgeNotReadyError(
      "lifecycle_outbox_pending",
    ));
    const retrying = new TenantDatabasePurgeWorker({
      store: pending.store,
      canExecute: vi.fn(async () => true),
    }, { retryBaseMs: 10, retryMaxMs: 100 });
    await expect(retrying.processOnce()).resolves.toBe(0);
    expect(pending.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
      delayMs: 20,
      errorCode: "dependency_pending",
    });
    expect(pending.block).not.toHaveBeenCalled();

    for (const error of [
      new TenantErasureIntegrityError(),
      new TenantDatabasePurgeEvidenceChangedError(),
    ]) {
      const state = fixture();
      state.execute.mockRejectedValue(error);
      const worker = new TenantDatabasePurgeWorker({
        store: state.store,
        canExecute: vi.fn(async () => true),
      });
      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
      expect(state.retry).not.toHaveBeenCalled();
    }
  });

  it("fails closed on invalid worker bounds", () => {
    const state = fixture();
    expect(() => new TenantDatabasePurgeWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    }, { batchSize: 101 })).toThrow(/must not exceed 100/);
    expect(() => new TenantDatabasePurgeWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    }, { retryBaseMs: 10, retryMaxMs: 9 })).toThrow(/must be >=/);
  });
});
