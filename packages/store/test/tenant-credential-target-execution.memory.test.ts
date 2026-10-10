import { createHash, randomUUID } from "node:crypto";
import type { ProviderConfig } from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TenantErasureIntegrityError,
  newErasureRequestId,
  tenantCredentialTargetExecutionAdapterEvidenceSha256,
  tenantErasureRequestHash,
  validateTenantCredentialTargetExecutionJobRecord,
  type ProviderCredentialTargetReferenceWrite,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialTargetExecutionAdapterResult,
  type TenantCredentialTargetExecutionAuthorization,
  type TenantCredentialTargetExecutionClaim,
  type TenantCredentialTargetExecutionJobRecord,
  type TenantCredentialTargetExecutionTarget,
} from "../src/index.js";

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function provider(tenantId: string, providerId = "managed-provider"): ProviderConfig {
  return {
    tenantId,
    id: providerId,
    api: "openai-completions",
    baseUrl: "https://provider.invalid/v1",
    apiKeyRef: `secret:${tenantId}:${providerId}`,
    headers: {},
    models: [{
      id: "fixture-model",
      contextWindow: 1_000,
      maxOutputTokens: 100,
      input: ["text"],
      reasoning: false,
    }],
    quota: {},
    fallback: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function protectedReference(
  locator = "server-owned-management-id",
): ProviderCredentialTargetReferenceWrite {
  const plaintext = Buffer.from(locator);
  const ciphertext = Buffer.concat([Buffer.from("sealed:"), plaintext]);
  return {
    domain: "external_credential",
    disposition: "executable_ref",
    adapterProtocol: "fixture-provider-revoke-v1",
    targetReferenceCipher: ciphertext,
    targetReferenceKeyId: "target-reference-key-v1",
    targetReferenceCipherSha256: sha256(ciphertext),
    targetReferenceSha256: sha256(plaintext),
  };
}

function revocationAuthorization(claim: {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  claimAttempt: number;
  claimToken: string;
}): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function executionAuthorization(
  claim: TenantCredentialTargetExecutionClaim,
): TenantCredentialTargetExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    targetExecutionGeneration: claim.targetExecutionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterResult(
  target: TenantCredentialTargetExecutionTarget,
  outcome: "revoked" | "already_absent" = "revoked",
): TenantCredentialTargetExecutionAdapterResult {
  if (target.domain !== "external_credential") {
    throw new Error("fixture only supports external credential targets");
  }
  const body = {
    adapterProtocol: target.adapterProtocol,
    domain: target.domain,
    operationIdSha256: target.operationIdSha256,
    targetReferenceSha256: target.targetReferenceSha256,
    outcome,
  };
  return {
    ...body,
    evidenceSha256: tenantCredentialTargetExecutionAdapterEvidenceSha256(body),
    replayed: false,
  };
}

async function terminalInventory(
  store: MemorySessionStore,
  tenantId: string,
  now: () => number,
  reference?: ProviderCredentialTargetReferenceWrite,
): Promise<string> {
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  await store.upsertProviderConfig(
    provider(tenantId),
    { ciphertext: Buffer.from("tenant-api-key-envelope"), keyId: "byok-key-v1" },
    null,
    reference,
  );
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "credential-target-execution-test",
    idempotencyKey: randomUUID(),
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: now(),
  });
  const claim = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 1_000,
    claimToken: `t3a-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("expected T3a claim");
  await store.revokeTenantCredentialMaterial(revocationAuthorization(claim));
  return requestId;
}

describe("MemorySessionStore credential target execution", () => {
  it("atomically captures a trusted locator and seals replay-safe external ACK evidence", async () => {
    let nowMs = 10_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "target-execution-success";
    const targetReference = protectedReference();
    const requestId = await terminalInventory(store, tenantId, () => nowMs, targetReference);

    expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 })).toBe(1);
    nowMs += 10;
    const claims = await store.claimTenantCredentialTargetExecutions({
      limit: 10,
      leaseMs: 1_000,
      claimToken: `execute-${randomUUID()}`,
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    const auth = executionAuthorization(claim);
    const activeJob = await store.getTenantCredentialTargetExecutionJob(tenantId, requestId);
    if (!activeJob || activeJob.phase !== "queued") throw new Error("expected active job");
    expect(() => validateTenantCredentialTargetExecutionJobRecord({
      ...activeJob,
      lastErrorCode: "temporary_failure",
    })).toThrow(/active claim is invalid/);
    const targets = await store.getTenantCredentialTargetExecutionTargets(
      tenantId,
      requestId,
      claim.targetExecutionGeneration,
    );
    expect(targets).toHaveLength(1);
    expect(JSON.stringify(targets)).not.toContain("server-owned-management-id");
    const encrypted = await store.getTenantCredentialTargetExecutionReference(auth, 0);
    expect(encrypted).toMatchObject({
      tenantId,
      credentialVersionId: targets[0]!.credentialVersionId,
      targetReferenceCipherSha256: targetReference.targetReferenceCipherSha256,
    });
    expect(Buffer.from(encrypted!.targetReferenceCipher)).toEqual(
      targetReference.targetReferenceCipher,
    );

    const result = adapterResult(targets[0]!);
    const validAckNowMs = nowMs + 1;
    nowMs = Math.min(
      activeJob.sourceEvidenceDbMs,
      activeJob.createdAtMs,
      targets[0]!.capturedAtDbMs,
    ) - 1;
    await expect(store.recordTenantCredentialTargetExecutionTargetAck(auth, result))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await store.getTenantCredentialTargetExecutionTargetAcks(
      tenantId,
      requestId,
      claim.targetExecutionGeneration,
    )).toEqual([]);
    expect(await store.getTenantCredentialTargetExecutionJob(tenantId, requestId))
      .toMatchObject({ phase: "queued", targetAckCount: 0 });
    nowMs = validAckNowMs;
    const ack = await store.recordTenantCredentialTargetExecutionTargetAck(auth, result);
    expect(ack).toMatchObject({ outcome: "revoked", targetOrdinal: 0 });
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(auth, result)).toEqual(ack);
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(
      { ...auth, subjectGeneration: auth.subjectGeneration + 1 },
      result,
    )).toBeNull();
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(
      { ...auth, targetExecutionGeneration: auth.targetExecutionGeneration + 1 },
      result,
    )).toBeNull();
    if (!ack) throw new Error("expected target ACK");
    const validSealNowMs = ack.storeDbTimestampMs + 1;
    nowMs = ack.storeDbTimestampMs - 1;
    await expect(store.sealTenantCredentialTargetExecution(auth))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(await store.getTenantCredentialTargetExecutionReceipt(tenantId, requestId))
      .toBeNull();
    expect(await store.getTenantCredentialTargetExecutionCutover())
      .toEqual({ singletonId: 1, controlGeneration: 0 });
    expect(await store.getTenantCredentialTargetExecutionJob(tenantId, requestId))
      .toMatchObject({ phase: "queued", targetAckCount: 1 });
    nowMs = validSealNowMs;
    const receipt = await store.sealTenantCredentialTargetExecution(auth);
    expect(receipt).toMatchObject({
      externalCredentialExecutionComplete: true,
      kmsKeyExecutionComplete: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
      targetCount: 1,
      targetAckCount: 1,
      unresolvedBlockerCount: 1,
    });
    expect(await store.sealTenantCredentialTargetExecution(auth)).toEqual(receipt);
    expect(await store.sealTenantCredentialTargetExecution({
      ...auth,
      subjectGeneration: auth.subjectGeneration + 1,
    })).toBeNull();
    expect(await store.sealTenantCredentialTargetExecution({
      ...auth,
      targetExecutionGeneration: auth.targetExecutionGeneration + 1,
    })).toBeNull();
    expect(await store.getTenantCredentialTargetExecutionReceipt(tenantId, requestId))
      .toEqual(receipt);
    const sealedJob = await store.getTenantCredentialTargetExecutionJob(tenantId, requestId);
    if (!sealedJob || sealedJob.phase !== "external_credential_sealed") {
      throw new Error("expected sealed job");
    }
    expect(() => validateTenantCredentialTargetExecutionJobRecord({
      ...sealedJob,
      sealedAtDbMs: sealedJob.updatedAtMs + 1,
    })).toThrow(/evidence is incomplete/);
    expect(await store.getTenantCredentialTargetExecutionCutover()).toMatchObject({
      controlGeneration: 1,
      firstRequestId: requestId,
      externalCredentialExecutionEnabled: true,
      kmsKeyExecutionEnabled: false,
    });
  });

  it("atomically materializes versions whose source dispositions have different capture times", async () => {
    let nowMs = 15_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "target-execution-multiple-capture-times";
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    await store.upsertProviderConfig(
      provider(tenantId, "managed-provider-a"),
      { ciphertext: Buffer.from("tenant-api-key-envelope-a"), keyId: "byok-key-v1" },
      null,
      protectedReference("management-id-a"),
    );
    nowMs += 7;
    await store.upsertProviderConfig(
      provider(tenantId, "managed-provider-b"),
      { ciphertext: Buffer.from("tenant-api-key-envelope-b"), keyId: "byok-key-v1" },
      null,
      protectedReference("management-id-b"),
    );
    const sourceCaptureTimes = new Set(
      [...store.tenantCredentialTargetDispositions.values()]
        .filter((target) => target.tenantId === tenantId
          && target.domain === "external_credential"
          && target.disposition === "executable_ref")
        .map((target) => target.capturedAtDbMs),
    );
    expect(sourceCaptureTimes).toEqual(new Set([15_000, 15_007]));
    const requestId = newErasureRequestId();
    await store.requestTenantErasure({
      requestId,
      tenantId,
      requestedByKeyId: "credential-target-execution-test",
      idempotencyKey: randomUUID(),
      requestHash: tenantErasureRequestHash(tenantId),
      atMs: nowMs,
    });
    const claim = (await store.claimTenantCredentialRevocations({
      limit: 10,
      leaseMs: 1_000,
      claimToken: `t3a-${randomUUID()}`,
    })).find((candidate) => candidate.requestId === requestId);
    if (!claim) throw new Error("expected T3a claim");
    await store.revokeTenantCredentialMaterial(revocationAuthorization(claim));

    expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 })).toBe(1);
    const targets = await store.getTenantCredentialTargetExecutionTargets(
      tenantId,
      requestId,
      1,
    );
    expect(targets).toHaveLength(2);
    expect(new Set(targets.map((target) => target.capturedAtDbMs)).size).toBe(1);
    expect(targets[0]!.capturedAtDbMs).toBeGreaterThanOrEqual(15_007);
  });

  it("atomically rejects duplicate tenant identities staged in one materialization batch", async () => {
    const store = new MemorySessionStore({ now: () => 17_000 });
    const tenantId = "target-execution-duplicate-staged-tenant";
    await terminalInventory(
      store,
      tenantId,
      () => 17_000,
      protectedReference("duplicate-staged-management-id"),
    );
    const inventory = [...store.tenantCredentialInventoryReceipts.values()]
      .find((candidate) => candidate.tenantId === tenantId);
    if (!inventory) throw new Error("expected credential inventory");
    const unsafe = store as unknown as {
      assertTenantCredentialInventoryReceipt: (
        value: NonNullable<typeof inventory>,
      ) => unknown;
    };
    const snapshot = unsafe.assertTenantCredentialInventoryReceipt.call(store, inventory);
    unsafe.assertTenantCredentialInventoryReceipt = () => snapshot;
    const duplicateRequestId = newErasureRequestId();
    store.tenantCredentialInventoryReceipts.set(duplicateRequestId, {
      ...inventory,
      requestId: duplicateRequestId,
    });

    await expect(store.materializeTenantCredentialTargetExecutionJobs({ limit: 10 }))
      .rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.tenantCredentialTargetExecutionJobs.size).toBe(0);
    expect(store.tenantCredentialTargetExecutionTargets.size).toBe(0);
  });

  it("keeps blocker-only sources terminally blocked without exposing a locator", async () => {
    let nowMs = 20_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "target-execution-blocked";
    const requestId = await terminalInventory(store, tenantId, () => nowMs);
    expect(await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 })).toBe(1);
    expect(await store.claimTenantCredentialTargetExecutions({
      limit: 1,
      leaseMs: 100,
      claimToken: "must-not-claim",
    })).toEqual([]);
    const blockedJob = await store.getTenantCredentialTargetExecutionJob(tenantId, requestId);
    expect(blockedJob).toMatchObject({
        phase: "blocked",
        blockedReasonCode: "source_blocked",
        externalCredentialBlockerCount: 1,
      });
    if (!blockedJob || blockedJob.phase !== "blocked") throw new Error("expected blocked job");
    const { blockedAtDbMs: _blockedAtDbMs, blockedReasonCode: _blockedReasonCode,
      ...blockedBase } = blockedJob;
    expect(() => validateTenantCredentialTargetExecutionJobRecord({
      ...blockedBase,
      phase: "queued",
      availableAtMs: blockedJob.updatedAtMs,
    } as TenantCredentialTargetExecutionJobRecord)).toThrow(/retains a source blocker/);
    expect(() => validateTenantCredentialTargetExecutionJobRecord({
      ...blockedJob,
      blockedAtDbMs: blockedJob.sourceEvidenceDbMs - 1,
    })).toThrow(/block time is invalid/);
    expect(() => validateTenantCredentialTargetExecutionJobRecord({
      ...blockedJob,
      blockedAtDbMs: blockedJob.updatedAtMs + 1,
    })).toThrow(/block time is invalid/);
    expect(await store.getTenantCredentialTargetExecutionTargets(tenantId, requestId, 1))
      .toEqual([]);
  });

  it("fences stale claims, preserves exact ACK replay, and isolates tenants", async () => {
    let nowMs = 30_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "target-execution-fencing";
    const requestId = await terminalInventory(
      store,
      tenantId,
      () => nowMs,
      protectedReference("fencing-locator"),
    );
    await store.materializeTenantCredentialTargetExecutionJobs({ limit: 1 });
    nowMs += 10;
    const first = (await store.claimTenantCredentialTargetExecutions({
      limit: 1,
      leaseMs: 5,
      claimToken: "first-claim",
    }))[0]!;
    nowMs += 5;
    const second = (await store.claimTenantCredentialTargetExecutions({
      limit: 1,
      leaseMs: 100,
      claimToken: "second-claim",
    }))[0]!;
    const target = (await store.getTenantCredentialTargetExecutionTargets(
      tenantId,
      requestId,
      1,
    ))[0]!;
    const result = adapterResult(target, "already_absent");
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(
      executionAuthorization(first),
      result,
    )).toBeNull();
    const ack = await store.recordTenantCredentialTargetExecutionTargetAck(
      executionAuthorization(second),
      result,
    );
    expect(ack?.outcome).toBe("already_absent");
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(
      { ...executionAuthorization(second), claimToken: "foreign-claim-token" },
      result,
    )).toBeNull();
    nowMs = second.leaseUntilMs;
    expect(await store.recordTenantCredentialTargetExecutionTargetAck(
      executionAuthorization(second),
      result,
    )).toEqual(ack);
    expect(await store.getTenantCredentialTargetExecutionJob("neighbor", requestId)).toBeNull();
    expect(await store.getTenantCredentialTargetExecutionTargets("neighbor", requestId, 1))
      .toEqual([]);
    expect(await store.getTenantCredentialTargetExecutionTargetAcks("neighbor", requestId, 1))
      .toEqual([]);
  });

  it("rejects malformed capture and rolls back reference publication failures", async () => {
    const store = new MemorySessionStore({ now: () => 40_000 });
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const malformed = protectedReference("bad-digest");
    malformed.targetReferenceCipherSha256 = "0".repeat(64);
    await expect(store.upsertProviderConfig(
      provider("malformed-target-reference"),
      { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
      null,
      malformed,
    )).rejects.toThrow(/ciphertext hash mismatch/);
    expect(store.providers).toHaveLength(0);
    expect(store.tenantCredentialVersions).toHaveLength(0);

    const references = store.tenantCredentialTargetReferenceCiphers;
    const originalSet = references.set;
    references.set = function injected(key, value) {
      originalSet.call(this, key, value);
      throw new Error("injected target-reference publication failure");
    };
    await expect(store.upsertProviderConfig(
      provider("target-reference-rollback"),
      { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
      null,
      protectedReference("rollback-locator"),
    )).rejects.toThrow("injected target-reference publication failure");
    delete (references as unknown as { set?: unknown }).set;
    expect(store.providers).toHaveLength(0);
    expect(store.tenantCredentialProviderSlots).toHaveLength(0);
    expect(store.tenantCredentialVersions).toHaveLength(0);
    expect(store.tenantCredentialTargetDispositions).toHaveLength(0);
    expect(store.tenantCredentialTargetReferenceCiphers).toHaveLength(0);
  });

  it("fails closed when a trusted locator is supplied before tracking cutover", async () => {
    const store = new MemorySessionStore({ now: () => 50_000 });
    await expect(store.upsertProviderConfig(
      provider("pre-cutover-reference"),
      { ciphertext: Buffer.from("secret"), keyId: "byok-v1" },
      null,
      protectedReference("pre-cutover-locator"),
    )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
    expect(store.providers).toHaveLength(0);
  });
});
