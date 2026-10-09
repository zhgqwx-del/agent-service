import { describe, expect, it, vi } from "vitest";
import {
  tenantRuntimeTargetSha256,
  type TenantRuntimeDrainRunnerRequest,
} from "@agent-service/protocol";
import { TenantRuntimeCoordinator } from "@agent-service/core";
import {
  tenantCredentialRevocationReceiptSha256,
  type TenantCredentialRevocationReceipt,
} from "@agent-service/store";
import { LocalTenantRuntimeDrain } from "../src/tenant-runtime-local-drain.js";

const REQUEST: TenantRuntimeDrainRunnerRequest = {
  requestId: "erase_12345678-1234-4123-8123-123456789abc",
  tenantId: "tenant-a",
  subjectGeneration: 2,
  t3aReceiptSha256: "0".repeat(64),
  targetSha256: tenantRuntimeTargetSha256("http://runner-a:8787"),
  expectedRunnerId: "runner-a",
  expectedBootId: "boot-a",
};

function t3aReceipt(): TenantCredentialRevocationReceipt {
  const body: Omit<TenantCredentialRevocationReceipt, "receiptSha256"> = {
    scope: "local-db-credential-material-v1",
    requestId: REQUEST.requestId,
    tenantId: REQUEST.tenantId,
    subjectGeneration: REQUEST.subjectGeneration,
    t1FenceSha256: "1".repeat(64),
    apiKeyCountBefore: 1,
    apiKeyCountAfter: 0,
    providerConfigCountBefore: 1,
    providerConfigCountAfter: 0,
    authPolicyPresentBefore: true,
    authPolicyPresentAfter: false,
    authSecretCipherPresentBefore: true,
    authSecretCipherPresentAfter: false,
    authSecretKeyIdPresentBefore: true,
    authSecretKeyIdPresentAfter: false,
    storeDbTimestampMs: 100,
    completedClaimAttempt: 1,
    completedClaimTokenSha256: "2".repeat(64),
    runtimeDisposition: "not_in_scope",
    externalDisposition: "not_supported",
    contentPurgeRequired: true,
  };
  return { ...body, receiptSha256: tenantCredentialRevocationReceiptSha256(body) };
}

function fixture() {
  const receipt = t3aReceipt();
  const request = { ...REQUEST, t3aReceiptSha256: receipt.receiptSha256 };
  const getReceipt = vi.fn(async () => receipt);
  const runtime = new TenantRuntimeCoordinator();
  const state = { cached: true, purgeCalls: 0 };
  runtime.registerParticipant({
    name: "test-cache",
    snapshotTenant: (tenantId) => ({ policyEntries: tenantId === request.tenantId && state.cached ? 1 : 0 }),
    fenceTenant: () => {},
    purgeTenant: () => {
      state.cached = false;
      state.purgeCalls += 1;
    },
  });
  runtime.sealParticipants();
  const drain = new LocalTenantRuntimeDrain(
    { getTenantCredentialRevocationReceipt: getReceipt },
    runtime,
    { runnerId: "runner-a", bootId: "boot-a", timeoutMs: 1_000 },
  );
  return { drain, getReceipt, request, runtime, state };
}

describe("LocalTenantRuntimeDrain", () => {
  it("binds a successful local drain to the immutable T3a source and exact process identity", async () => {
    const state = fixture();
    const operation = state.runtime.enter(state.request.tenantId, "provider");
    operation.signal.addEventListener("abort", () => operation.release(), { once: true });

    const result = await state.drain.drain(state.request);
    expect(result).toMatchObject({
      targetSha256: state.request.targetSha256,
      runnerId: "runner-a",
      bootId: "boot-a",
      requestId: state.request.requestId,
      tenantId: state.request.tenantId,
      subjectGeneration: state.request.subjectGeneration,
      t3aReceiptSha256: state.request.t3aReceiptSha256,
      cacheEntryCountBefore: 1,
      cacheEntryCountAfter: 0,
      activeOperationCountBefore: 1,
      activeOperationCountAfter: 0,
      activeTurnCountBefore: 0,
      activeTurnCountAfter: 0,
    });
    expect(result.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.getReceipt).toHaveBeenCalledTimes(2);
    expect(state.state.purgeCalls).toBe(1);

    await expect(state.drain.drain(state.request)).resolves.toEqual(result);
    expect(state.getReceipt).toHaveBeenCalledTimes(4);
    expect(state.state.purgeCalls).toBe(1);
  });

  it("rejects a mismatched T3a authority before installing a local fence", async () => {
    const state = fixture();
    await expect(state.drain.drain({
      ...state.request,
      t3aReceiptSha256: "f".repeat(64),
    })).rejects.toThrow(/authority does not match/);
    expect(state.runtime.isFenced(state.request.tenantId)).toBe(false);
    expect(state.state.purgeCalls).toBe(0);
  });

  it("keeps the tenant fenced when the post-drain source read fails and recovers by exact retry", async () => {
    const state = fixture();
    state.getReceipt
      .mockResolvedValueOnce(t3aReceipt())
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockResolvedValue(t3aReceipt());

    await expect(state.drain.drain(state.request)).rejects.toThrow("store unavailable");
    expect(state.runtime.isFenced(state.request.tenantId)).toBe(true);
    expect(state.state.purgeCalls).toBe(1);

    const replay = await state.drain.drain(state.request);
    expect(replay.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.state.purgeCalls).toBe(1);
  });
});
