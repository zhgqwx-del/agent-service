import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
  type TenantRuntimeRevocationLocalReceipt,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  subjectLifecycleKey,
  tenantErasureRequestHash,
  type TenantCredentialRevocationAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";

function tenantRequest(tenantId: string, atMs: number) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `runtime-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs,
  };
}

function credentialAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantCredentialRevocations"]>>[number],
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function runtimeAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantRuntimeRevocations"]>>[number],
): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(
  source: { requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string },
  count = 2,
): TenantRuntimeRevocationFleetProof {
  const targets = Array.from({ length: count }, (_, index) => {
    const body = {
      targetSha256: tenantRuntimeTargetSha256(`http://runner-${index + 1}.internal:8080`),
      runnerId: `runner-${index + 1}`,
      bootId: `boot-${index + 1}`,
      requestId: source.requestId,
      tenantId: source.tenantId,
      subjectGeneration: source.subjectGeneration,
      t3aReceiptSha256: source.t3aReceiptSha256,
      cacheEntryCountBefore: index + 1,
      cacheEntryCountAfter: 0 as const,
      activeOperationCountBefore: index,
      activeOperationCountAfter: 0 as const,
      activeTurnCountBefore: index + 2,
      activeTurnCountAfter: 0 as const,
      completedAtMs: 2_100 + index,
    };
    return { ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) };
  }).sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

function conflictingReplayProof(
  proof: TenantRuntimeRevocationFleetProof,
): TenantRuntimeRevocationFleetProof {
  const changed = structuredClone(proof);
  changed.targets[0]!.completedAtMs += 1;
  changed.targets[0]!.receiptSha256 = tenantRuntimeLocalReceiptSha256(changed.targets[0]!);
  changed.targetReceiptsSha256 = tenantRuntimeTargetReceiptsSha256(changed.targets);
  return changed;
}

async function advanceThroughT3a(
  store: MemorySessionStore,
  tenantId: string,
  atMs: number,
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  const request = tenantRequest(tenantId, atMs);
  await store.requestTenantErasure(request);
  const credentialClaims = await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 1_000,
    claimToken: `credential-${tenantId}`,
  });
  const credentialClaim = credentialClaims.find((claim) => claim.requestId === request.requestId)!;
  const credentialReceipt = await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credentialClaim),
  );
  expect(credentialReceipt).not.toBeNull();
  return { request, credentialReceipt: credentialReceipt! };
}

describe("MemorySessionStore tenant runtime revocation", () => {
  it("materializes only terminal T3a evidence and atomically completes a canonical fleet", async () => {
    let nowMs = 2_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-runtime-success";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    const request = tenantRequest(tenantId, 1_900);
    await store.requestTenantErasure(request);
    expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(0);

    const credentialClaim = (await store.claimTenantCredentialRevocations({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "credential-success",
    }))[0]!;
    const credentialReceipt = await store.revokeTenantCredentialMaterial(
      credentialAuthorization(credentialClaim),
    );
    expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
    expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(0);

    const [claim] = await store.claimTenantRuntimeRevocations({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "runtime-success",
    });
    const authorization = runtimeAuthorization(claim!);
    const proof = fleetProof({ ...claim!, t3aReceiptSha256: credentialReceipt!.receiptSha256 });
    nowMs = 2_010;
    const receipt = await store.completeTenantRuntimeRevocation(authorization, proof);
    expect(receipt).toMatchObject({
      scope: "configured-fleet-runtime-v1",
      requestId: request.requestId,
      tenantId,
      targetCount: 2,
      memoryDisposition: "references_dropped_not_zeroized",
      externalDisposition: "not_supported",
      contentPurgeRequired: true,
      completedClaimAttempt: 1,
    });
    expect(await store.getTenantRuntimeRevocationTargetReceipts(tenantId, request.requestId))
      .toHaveLength(2);
    expect(await store.getTenantRuntimeRevocationReceipt(tenantId, request.requestId))
      .toEqual(receipt);
    expect(await store.getTenantRuntimeRevocationReceipt("tenant-neighbor", request.requestId))
      .toBeNull();
  });

  it("allows only one concurrent claim and exact response-loss replay", async () => {
    let nowMs = 3_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const source = await advanceThroughT3a(store, "tenant-runtime-replay", 2_900);
    await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
    const [left, right] = await Promise.all([
      store.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 1_000, claimToken: "worker-left" }),
      store.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 1_000, claimToken: "worker-right" }),
    ]);
    expect(left.length + right.length).toBe(1);
    const claim = (left[0] ?? right[0])!;
    const auth = runtimeAuthorization(claim);
    const proof = fleetProof(claim);
    nowMs = 3_010;
    const receipt = await store.completeTenantRuntimeRevocation(auth, proof);
    expect(await store.completeTenantRuntimeRevocation(auth, proof)).toEqual(receipt);
    await expect(store.completeTenantRuntimeRevocation(
      auth,
      conflictingReplayProof(proof),
    )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await store.completeTenantRuntimeRevocation({ ...auth, claimToken: "other-token" }, proof))
      .toBeNull();

    store.subjectLifecycles.delete(subjectLifecycleKey(
      source.request.tenantId,
      "tenant",
      source.request.tenantId,
    ));
    expect(await store.getTenantRuntimeRevocationReceipt(
      source.request.tenantId,
      source.request.requestId,
    )).toEqual(receipt);
    expect(await store.completeTenantRuntimeRevocation(auth, proof)).toEqual(receipt);
  });

  it("requires a live deleting source for queue control and first completion", async () => {
    const store = new MemorySessionStore({ now: () => 4_000 });
    const source = await advanceThroughT3a(store, "tenant-runtime-live-gate", 3_900);
    await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
    store.subjectLifecycles.delete(subjectLifecycleKey(
      source.request.tenantId,
      "tenant",
      source.request.tenantId,
    ));
    await expect(store.claimTenantRuntimeRevocations({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "must-fail-closed",
    })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
  });

  it("rejects malformed proof before publication and rolls every map back on a late failure", async () => {
    const store = new MemorySessionStore({ now: () => 5_000 });
    await advanceThroughT3a(store, "tenant-runtime-rollback", 4_900);
    await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
    const [claim] = await store.claimTenantRuntimeRevocations({
      limit: 1,
      leaseMs: 1_000,
      claimToken: "runtime-rollback",
    });
    const auth = runtimeAuthorization(claim!);
    const validProof = fleetProof(claim!);
    const uncloneable = validProof as TenantRuntimeRevocationFleetProof & { failClone?: () => void };
    uncloneable.failClone = () => {};
    await expect(store.completeTenantRuntimeRevocation(auth, uncloneable)).rejects.toBeDefined();
    delete uncloneable.failClone;
    expect(store.tenantRuntimeRevocationTargetReceipts).toHaveLength(0);
    expect(store.tenantRuntimeRevocationReceipts).toHaveLength(0);
    const malformed = structuredClone(validProof);
    (malformed.targets[0] as TenantRuntimeRevocationLocalReceipt).activeTurnCountAfter = 1 as 0;
    await expect(store.completeTenantRuntimeRevocation(auth, malformed))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantRuntimeRevocationTargetReceipts).toHaveLength(0);
    expect(store.tenantRuntimeRevocationReceipts).toHaveLength(0);

    const targets = store.tenantRuntimeRevocationTargetReceipts;
    const originalSet = targets.set;
    let calls = 0;
    targets.set = function injected(key, value) {
      originalSet.call(this, key, value);
      calls += 1;
      if (calls === 2) throw new Error("injected target publication failure");
      return this;
    };
    await expect(store.completeTenantRuntimeRevocation(auth, validProof))
      .rejects.toThrow("injected target publication failure");
    delete (targets as unknown as { set?: unknown }).set;
    expect(store.tenantRuntimeRevocationTargetReceipts).toHaveLength(0);
    expect(store.tenantRuntimeRevocationReceipts).toHaveLength(0);
    expect(store.tenantRuntimeRevocationJobs.get(claim!.requestId))
      .toMatchObject({ phase: "queued", claimToken: auth.claimToken });
  });
});
