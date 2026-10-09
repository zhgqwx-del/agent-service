import { describe, expect, it, vi } from "vitest";
import {
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import {
  TenantErasureIntegrityError,
  type ClaimTenantRuntimeRevocationsOptions,
  type TenantRuntimeRevocationClaim,
  type TenantRuntimeRevocationReceipt,
  type TenantRuntimeRevocationStore,
} from "@agent-service/store";
import { TenantRuntimeRevocationWorker } from "../src/index.js";

const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";

function claim(input: ClaimTenantRuntimeRevocationsOptions): TenantRuntimeRevocationClaim {
  return {
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    phase: "queued",
    claimAttempt: 2,
    claimToken: input.claimToken,
    leaseUntilMs: 100_000,
  };
}

function fleetProof(): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-a:8787"),
    runnerId: "runner-a",
    bootId: "boot-a",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    t3aReceiptSha256: "2".repeat(64),
    cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: 100,
  };
  const local = { ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) };
  return {
    fleetSha256: tenantRuntimeFleetSha256([local]),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256([local]),
    targets: [local],
  };
}

function receipt(): TenantRuntimeRevocationReceipt {
  return {
    scope: "configured-fleet-runtime-v1",
    requestId: REQUEST_ID,
    tenantId: "tenant-a",
    subjectGeneration: 2,
    t1FenceSha256: "1".repeat(64),
    t3aReceiptSha256: "2".repeat(64),
    fleetSha256: fleetProof().fleetSha256,
    targetCount: 1,
    targetReceiptsSha256: fleetProof().targetReceiptsSha256,
    storeDbTimestampMs: 200,
    completedClaimAttempt: 2,
    completedClaimTokenSha256: "3".repeat(64),
    memoryDisposition: "references_dropped_not_zeroized",
    externalDisposition: "not_supported",
    contentPurgeRequired: true,
    receiptSha256: "4".repeat(64),
  };
}

function fixture() {
  const materialize = vi.fn(async () => 1);
  const claimJobs = vi.fn(async (input: ClaimTenantRuntimeRevocationsOptions) => [claim(input)]);
  const renew = vi.fn(async () => true);
  const retry = vi.fn(async () => true);
  const block = vi.fn(async () => true);
  const complete = vi.fn(async () => receipt());
  const store: TenantRuntimeRevocationStore = {
    materializeTenantRuntimeRevocationJobs: materialize,
    claimTenantRuntimeRevocations: claimJobs,
    renewTenantRuntimeRevocation: renew,
    retryTenantRuntimeRevocation: retry,
    blockTenantRuntimeRevocation: block,
    completeTenantRuntimeRevocation: complete,
    getTenantRuntimeRevocationJob: vi.fn(async () => null),
    getTenantRuntimeRevocationTargetReceipts: vi.fn(async () => []),
    getTenantRuntimeRevocationReceipt: vi.fn(async () => null),
  };
  const drainFleet = vi.fn(async (): Promise<TenantRuntimeRevocationFleetProof | null> => fleetProof());
  return { store, materialize, claimJobs, renew, retry, block, complete, drainFleet };
}

describe("TenantRuntimeRevocationWorker", () => {
  it("materializes, claims, renews around the bounded fleet call and commits its proof", async () => {
    const state = fixture();
    const worker = new TenantRuntimeRevocationWorker({
      store: state.store,
      drainFleet: state.drainFleet,
    }, { leaseMs: 500, batchSize: 3, materializeBatchSize: 7 });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.materialize).toHaveBeenCalledWith({ limit: 7 });
    expect(state.claimJobs).toHaveBeenCalledWith(expect.objectContaining({ limit: 3, leaseMs: 500 }));
    expect(state.renew).toHaveBeenCalledTimes(2);
    expect(state.drainFleet).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      tenantId: "tenant-a",
      subjectGeneration: 2,
      t3aReceiptSha256: "2".repeat(64),
    });
    expect(state.complete).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_ID,
      tenantId: "tenant-a",
      subjectGeneration: 2,
      claimAttempt: 2,
    }), fleetProof());
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("releases the claim with database-relative backoff when no complete fleet proof exists", async () => {
    const state = fixture();
    state.drainFleet.mockResolvedValueOnce(null);
    const worker = new TenantRuntimeRevocationWorker({
      store: state.store,
      drainFleet: state.drainFleet,
    }, { retryBaseMs: 10, retryMaxMs: 100 });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.complete).not.toHaveBeenCalled();
    expect(state.retry).toHaveBeenCalledWith(expect.objectContaining({ claimAttempt: 2 }), {
      delayMs: 20,
      errorCode: "temporary_failure",
    });
  });

  it("replays the exact completion after an ambiguous response loss", async () => {
    const state = fixture();
    state.complete
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce(receipt());
    const worker = new TenantRuntimeRevocationWorker({
      store: state.store,
      drainFleet: state.drainFleet,
    });

    await expect(worker.processOnce()).resolves.toBe(1);
    expect(state.complete).toHaveBeenCalledTimes(2);
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.block).not.toHaveBeenCalled();
  });

  it("blocks when either completion attempt exposes an immutable proof conflict", async () => {
    const state = fixture();
    state.complete
      .mockRejectedValueOnce(new Error("connection closed"))
      .mockRejectedValueOnce(new TenantErasureIntegrityError());
    const warn = vi.fn();
    const worker = new TenantRuntimeRevocationWorker({
      store: state.store,
      drainFleet: state.drainFleet,
      logger: { warn },
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.block).toHaveBeenCalledOnce();
    expect(state.retry).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[tenant-runtime-revocation-worker] claim failed");
  });

  it("does not begin a fleet drain after lease renewal loses authority", async () => {
    const state = fixture();
    state.renew.mockResolvedValueOnce(false);
    const worker = new TenantRuntimeRevocationWorker({
      store: state.store,
      drainFleet: state.drainFleet,
    });

    await expect(worker.processOnce()).resolves.toBe(0);
    expect(state.drainFleet).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
  });
});
