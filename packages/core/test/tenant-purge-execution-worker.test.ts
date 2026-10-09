import { describe, expect, it, vi } from "vitest";
import {
  TenantErasureIntegrityError,
  TenantPurgeExecutionEvidenceChangedError,
  TenantPurgeExecutionNotReadyError,
  TenantPurgeExecutionPhysicalAckDeadLetterError,
  type ClaimTenantPurgeExecutionsOptions,
  type TenantPurgeExecutionClaim,
  type TenantPurgeExecutionStore,
  type TenantPurgeLocalCutoverReceipt,
  type TenantPurgeLocalPhysicalAckReceipt,
} from "@agent-service/store";
import { TenantPurgeExecutionWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const DIGEST = "a".repeat(64);

function claim(
  input: ClaimTenantPurgeExecutionsOptions,
  localCutoverCommitted = false,
): TenantPurgeExecutionClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    planBuildGeneration: 1,
    executionGeneration: 1,
    t3cReceiptSha256: DIGEST,
    planReceiptSha256: DIGEST,
    planEntryRootSha256: DIGEST,
    planBlockerCount: 9,
    planBlockerRootSha256: DIGEST,
    policySha256: DIGEST,
    purgeNotBeforeDbMs: 1_000,
    sourceEvidenceDbMs: 1_001,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
    localCutoverCommitted,
  };
}

function fixture(options: { localCutoverCommitted?: boolean } = {}) {
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantPurgeExecutionsOptions) => [
    claim(input, options.localCutoverCommitted),
  ]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const cutover = vi.fn(async () => ({ receiptSha256: DIGEST }) as TenantPurgeLocalCutoverReceipt);
  const seal = vi.fn(async () => ({ receiptSha256: DIGEST }) as TenantPurgeLocalPhysicalAckReceipt);
  const store: TenantPurgeExecutionStore = {
    materializeTenantPurgeExecutionJobs: materialize,
    claimTenantPurgeExecutions: claimJobs,
    renewTenantPurgeExecution: renew,
    retryTenantPurgeExecution: retry,
    blockTenantPurgeExecution: block,
    executeTenantPurgeLocalCutover: cutover,
    sealTenantPurgeLocalPhysicalAcks: seal,
    getTenantPurgeExecutionJob: vi.fn(async () => null),
    getTenantPurgeExecutionDomains: vi.fn(async () => []),
    getTenantPurgeExecutionDomainAcks: vi.fn(async () => []),
    getTenantPurgeLocalCutoverReceipt: vi.fn(async () => null),
    getTenantPurgeLocalPhysicalAckReceipt: vi.fn(async () => null),
    getTenantPurgeExecutionCutover: vi.fn(async () => ({
      singletonId: 1 as const,
      controlGeneration: 0 as const,
    })),
  };
  return { store, materialize, claimJobs, renew, retry, block, cutover, seal };
}

describe("TenantPurgeExecutionWorker", () => {
  it("requires fresh fleet gates and advances cutover plus physical ACK seal", async () => {
    const state = fixture();
    const canExecute = vi.fn(async () => true);
    const worker = new TenantPurgeExecutionWorker({ store: state.store, canExecute }, {
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
    expect(state.renew).toHaveBeenCalledTimes(2);
    expect(state.cutover).toHaveBeenCalledOnce();
    expect(state.seal).toHaveBeenCalledOnce();
    expect(canExecute.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("does not materialize or claim while the router barrier is closed", async () => {
    const state = fixture();
    const worker = new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => false),
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.materialize).not.toHaveBeenCalled();
    expect(state.claimJobs).not.toHaveBeenCalled();
  });

  it("uses a new gate before claiming even after materialization succeeded", async () => {
    const state = fixture();
    const canExecute = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const worker = new TenantPurgeExecutionWorker({ store: state.store, canExecute });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.materialize).toHaveBeenCalledOnce();
    expect(state.claimJobs).not.toHaveBeenCalled();
  });

  it("releases authority without an irreversible action when the per-action gate closes", async () => {
    const state = fixture();
    const gates = [true, true, true, true, false];
    const canExecute = vi.fn(async () => gates.shift() ?? false);
    const worker = new TenantPurgeExecutionWorker({ store: state.store, canExecute });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.renew).toHaveBeenCalledOnce();
    expect(state.cutover).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_ID,
    }), expect.objectContaining({ errorCode: "temporary_failure" }));
  });

  it("skips a committed cutover on a later claim and waits only for physical ACKs", async () => {
    const state = fixture({ localCutoverCommitted: true });
    const worker = new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.cutover).not.toHaveBeenCalled();
    expect(state.seal).toHaveBeenCalledOnce();
  });

  it("replays exact cutover and seal calls after ambiguous response loss", async () => {
    const state = fixture();
    state.cutover
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce({ receiptSha256: DIGEST } as TenantPurgeLocalCutoverReceipt);
    state.seal
      .mockRejectedValueOnce(new Error("connection closed after physical seal"))
      .mockResolvedValueOnce({ receiptSha256: DIGEST } as TenantPurgeLocalPhysicalAckReceipt);
    const worker = new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.cutover).toHaveBeenCalledTimes(2);
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("requires a new fleet proof before an ambiguous destructive replay", async () => {
    const state = fixture();
    state.cutover.mockRejectedValueOnce(new Error("connection closed before outcome was known"));
    const gates = [true, true, true, true, true, false];
    const worker = new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => gates.shift() ?? false),
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.cutover).toHaveBeenCalledOnce();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.any(Object),
      expect.objectContaining({ errorCode: "temporary_failure" }));
  });

  it("retries pending physical ACKs with their distinct bounded status", async () => {
    const state = fixture();
    state.seal.mockRejectedValue(new TenantPurgeExecutionNotReadyError("physical_ack_pending"));
    const worker = new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
      delayMs: 20,
      errorCode: "physical_ack_pending",
    });
    expect(state.block).not.toHaveBeenCalled();
  });

  it("blocks integrity drift but does not duplicate an atomic dead-letter transition", async () => {
    for (const error of [
      new TenantErasureIntegrityError(),
      new TenantPurgeExecutionEvidenceChangedError(),
    ]) {
      const state = fixture();
      state.cutover.mockRejectedValue(error);
      const worker = new TenantPurgeExecutionWorker({
        store: state.store,
        canExecute: vi.fn(async () => true),
      });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.block).toHaveBeenCalledWith(expect.any(Object), "integrity_conflict");
      expect(state.retry).not.toHaveBeenCalled();
    }

    const deadLetter = fixture();
    deadLetter.seal.mockRejectedValue(new TenantPurgeExecutionPhysicalAckDeadLetterError());
    const worker = new TenantPurgeExecutionWorker({
      store: deadLetter.store,
      canExecute: vi.fn(async () => true),
    });
    await expect(worker.processOnce()).resolves.toBe(0);
    expect(deadLetter.block).not.toHaveBeenCalled();
    expect(deadLetter.retry).not.toHaveBeenCalled();
  });

  it("fails closed on invalid worker bounds", () => {
    const state = fixture();
    expect(() => new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    }, { batchSize: 101 })).toThrow(/must not exceed 100/);
    expect(() => new TenantPurgeExecutionWorker({
      store: state.store,
      canExecute: vi.fn(async () => true),
    }, { retryBaseMs: 10, retryMaxMs: 9 })).toThrow(/must be >=/);
  });
});
