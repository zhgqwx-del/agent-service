import { describe, expect, it, vi } from "vitest";
import {
  TenantErasureIntegrityError,
  TenantPurgePlanEvidenceChangedError,
  TenantPurgePlanNotReadyError,
  type ClaimTenantPurgePlansOptions,
  type TenantPurgePlanClaim,
  type TenantPurgePlanReceipt,
  type TenantPurgePlanStore,
} from "@agent-service/store";
import { TenantPurgePlanWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";

function claim(input: ClaimTenantPurgePlansOptions): TenantPurgePlanClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    buildGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    t3bReceiptSha256: "3".repeat(64),
    t3cReceiptSha256: "4".repeat(64),
    policyVersion: "policy-1",
    policySha256: "5".repeat(64),
    policySchemaVersion: 1,
    retentionAnchorDbMs: 1_000,
    purgeNotBeforeDbMs: 2_000,
    sourceEvidenceDbMs: 2_001,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
  };
}

function receipt(): TenantPurgePlanReceipt {
  return {
    scope: "tenant-purge-plan-v1",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    buildGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    t3bReceiptSha256: "3".repeat(64),
    t3cReceiptSha256: "4".repeat(64),
    policyVersion: "policy-1",
    policySha256: "5".repeat(64),
    policySchemaVersion: 1,
    retentionAnchorDbMs: 1_000,
    purgeNotBeforeDbMs: 2_000,
    sourceEvidenceDbMs: 2_001,
    planEntryCount: 33,
    planEntryRootSha256: "6".repeat(64),
    blockerCount: 9,
    blockerRootSha256: "7".repeat(64),
    storeDbTimestampMs: 2_002,
    completedClaimAttempt: 2,
    completedClaimTokenSha256: "8".repeat(64),
    planComplete: true,
    executionReady: false,
    contentPurgeExecuted: false,
    receiptSha256: "9".repeat(64),
  };
}

function fixture() {
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantPurgePlansOptions) => [claim(input)]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const seal = vi.fn(async () => receipt());
  const store: TenantPurgePlanStore = {
    materializeTenantPurgePlanJobs: materialize,
    claimTenantPurgePlans: claimJobs,
    renewTenantPurgePlan: renew,
    retryTenantPurgePlan: retry,
    blockTenantPurgePlan: block,
    sealTenantPurgePlan: seal,
    getTenantPurgePlanJob: vi.fn(async () => null),
    getTenantPurgePlanEntries: vi.fn(async () => []),
    getTenantPurgePlanReceipt: vi.fn(async () => null),
  };
  return { store, materialize, claimJobs, renew, retry, block, seal };
}

describe("TenantPurgePlanWorker", () => {
  it("materializes, renews, and delegates one-boundary build plus seal to the store", async () => {
    const state = fixture();
    const worker = new TenantPurgePlanWorker({ store: state.store }, {
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
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("treats a complete plan with explicit blockers as planning success, never execution", async () => {
    const state = fixture();
    const worker = new TenantPurgePlanWorker({ store: state.store });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(await state.seal.mock.results[0]?.value).toMatchObject({
      planComplete: true,
      executionReady: false,
      contentPurgeExecuted: false,
      blockerCount: 9,
    });
  });

  it("replays the exact seal after an ambiguous committed response loss", async () => {
    const state = fixture();
    state.seal
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce(receipt());
    const worker = new TenantPurgePlanWorker({ store: state.store });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("retries deadline, hold, and clock not-ready outcomes without blocking", async () => {
    for (const reason of [
      "deadline_not_reached",
      "active_legal_hold",
      "trusted_clock_before_evidence",
    ] as const) {
      const state = fixture();
      state.seal.mockRejectedValue(new TenantPurgePlanNotReadyError(reason));
      const worker = new TenantPurgePlanWorker({ store: state.store }, {
        retryBaseMs: 10,
        retryMaxMs: 100,
      });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
        delayMs: 20,
        errorCode: "temporary_failure",
      });
      expect(state.block).not.toHaveBeenCalled();
      expect(state.seal).toHaveBeenCalledOnce();
    }
  });

  it("blocks immutable source drift and integrity conflicts without retry", async () => {
    for (const error of [
      new TenantErasureIntegrityError(),
      new TenantPurgePlanEvidenceChangedError(),
    ]) {
      const state = fixture();
      state.seal.mockRejectedValue(error);
      const warn = vi.fn();
      const worker = new TenantPurgePlanWorker({ store: state.store, logger: { warn } });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.block).toHaveBeenCalledOnce();
      expect(state.retry).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[tenant-purge-plan-worker] claim failed");
    }
  });

  it("does not seal after database-clock lease renewal loses authority", async () => {
    const state = fixture();
    state.renew.mockResolvedValueOnce(false);
    const worker = new TenantPurgePlanWorker({ store: state.store });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.seal).not.toHaveBeenCalled();
  });
});
