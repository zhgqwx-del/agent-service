import { describe, expect, it, vi } from "vitest";
import {
  TenantContentInventoryEvidenceChangedError,
  TenantContentInventoryNotReadyError,
  TenantErasureIntegrityError,
  type ClaimTenantContentInventoriesOptions,
  type TenantContentInventoryClaim,
  type TenantContentInventoryReceipt,
  type TenantContentInventoryStore,
} from "@agent-service/store";
import { TenantContentInventoryWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";

function claim(input: ClaimTenantContentInventoriesOptions): TenantContentInventoryClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    buildGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    t3bReceiptSha256: "3".repeat(64),
    policyVersion: "policy-1",
    policySha256: "4".repeat(64),
    policySchemaVersion: 1,
    retentionAnchorDbMs: 1_000,
    contentNotBeforeDbMs: 2_000,
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
  };
}

function receipt(): TenantContentInventoryReceipt {
  return {
    scope: "tenant-content-inventory-v1",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    buildGeneration: 1,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    t3bReceiptSha256: "3".repeat(64),
    policyVersion: "policy-1",
    policySha256: "4".repeat(64),
    policySchemaVersion: 1,
    retentionAnchorDbMs: 1_000,
    contentNotBeforeDbMs: 2_000,
    sessionReceiptCount: 1,
    sessionReceiptRootSha256: "5".repeat(64),
    contentRecordCount: 5,
    holdControlCount: 1,
    holdControlRootSha256: "6".repeat(64),
    globalOrphanCheck: "passed",
    storeDbTimestampMs: 2_001,
    completedClaimAttempt: 2,
    completedClaimTokenSha256: "7".repeat(64),
    contentInventoryComplete: true,
    contentPurgeExecuted: false,
    receiptSha256: "8".repeat(64),
  };
}

function fixture() {
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantContentInventoriesOptions) => [claim(input)]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const build = vi.fn()
    .mockResolvedValueOnce({
      built: 1,
      done: false,
      cursorSessionId: "sess_00000000-0000-7000-8000-000000000001",
      sessionReceiptCount: 1,
      sessionReceiptRootSha256: "5".repeat(64),
      contentRecordCount: 5,
    })
    .mockResolvedValueOnce({
      built: 0,
      done: true,
      cursorSessionId: "sess_00000000-0000-7000-8000-000000000001",
      sessionReceiptCount: 1,
      sessionReceiptRootSha256: "5".repeat(64),
      contentRecordCount: 5,
    });
  const seal = vi.fn(async () => receipt());
  const store: TenantContentInventoryStore = {
    materializeTenantContentInventoryJobs: materialize,
    claimTenantContentInventories: claimJobs,
    renewTenantContentInventory: renew,
    retryTenantContentInventory: retry,
    blockTenantContentInventory: block,
    buildTenantContentInventoryPage: build,
    sealTenantContentInventory: seal,
    getTenantContentInventoryJob: vi.fn(async () => null),
    getTenantSessionContentReceipts: vi.fn(async () => []),
    getTenantContentInventoryReceipt: vi.fn(async () => null),
  };
  return { store, materialize, claimJobs, renew, retry, block, build, seal };
}

describe("TenantContentInventoryWorker", () => {
  it("materializes, builds bounded pages, renews and seals without caller time", async () => {
    const state = fixture();
    const worker = new TenantContentInventoryWorker({ store: state.store }, {
      leaseMs: 500,
      batchSize: 3,
      materializeBatchSize: 7,
      sessionPageSize: 11,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({
      limit: 3,
      leaseMs: 500,
    }));
    expect(state.renew).toHaveBeenCalledTimes(3);
    expect(state.build).toHaveBeenCalledTimes(2);
    expect(state.build).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_ID,
      buildGeneration: 1,
      claimAttempt: 2,
    }), { limit: 11 });
    expect(state.seal).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("replays the exact seal after an ambiguous committed response loss", async () => {
    const state = fixture();
    state.build.mockReset().mockResolvedValue({
      built: 0,
      done: true,
      sessionReceiptCount: 0,
      sessionReceiptRootSha256: "5".repeat(64),
      contentRecordCount: 0,
    });
    state.seal
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce(receipt());
    const worker = new TenantContentInventoryWorker({ store: state.store });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.seal).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("retries a trusted-deadline or legal-hold not-ready result without blocking", async () => {
    for (const reason of ["deadline_not_reached", "active_legal_hold"] as const) {
      const state = fixture();
      state.build.mockReset().mockResolvedValue({
        built: 0,
        done: true,
        sessionReceiptCount: 0,
        sessionReceiptRootSha256: "5".repeat(64),
        contentRecordCount: 0,
      });
      state.seal.mockRejectedValue(new TenantContentInventoryNotReadyError(reason));
      const worker = new TenantContentInventoryWorker({ store: state.store }, {
        retryBaseMs: 10,
        retryMaxMs: 100,
      });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.seal).toHaveBeenCalledOnce();
      expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
        delayMs: 20,
        errorCode: "temporary_failure",
      });
      expect(state.block).not.toHaveBeenCalled();
    }
  });

  it("blocks immutable source/inventory conflicts and never retries them", async () => {
    for (const error of [
      new TenantErasureIntegrityError(),
      new TenantContentInventoryEvidenceChangedError(),
    ]) {
      const state = fixture();
      state.build.mockReset().mockRejectedValue(error);
      const warn = vi.fn();
      const worker = new TenantContentInventoryWorker({
        store: state.store,
        logger: { warn },
      });

      await expect(worker.processOnce()).resolves.toBe(0);
      expect(state.block).toHaveBeenCalledOnce();
      expect(state.retry).not.toHaveBeenCalled();
      expect(state.seal).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[tenant-content-inventory-worker] claim failed");
    }
  });

  it("retries a non-progressing partial page and never seals partial evidence", async () => {
    const state = fixture();
    state.build.mockReset().mockResolvedValue({
      built: 0,
      done: false,
      sessionReceiptCount: 0,
      sessionReceiptRootSha256: "5".repeat(64),
      contentRecordCount: 0,
    });
    const worker = new TenantContentInventoryWorker({ store: state.store }, {
      retryBaseMs: 10,
      retryMaxMs: 100,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.retry).toHaveBeenCalledOnce();
    expect(state.seal).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("does not scan after database-clock lease renewal loses authority", async () => {
    const state = fixture();
    state.renew.mockResolvedValueOnce(false);
    const worker = new TenantContentInventoryWorker({ store: state.store });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.seal).not.toHaveBeenCalled();
  });
});
