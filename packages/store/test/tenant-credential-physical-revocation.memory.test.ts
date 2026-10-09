import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  type ProviderConfig,
  type TenantAuthPolicy,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  newErasureRequestId,
  subjectLifecycleKey,
  tenantCredentialRevocationClaimTokenSha256,
  tenantErasureRequestHash,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
  type TenantCredentialRevocationJobRecord,
} from "../src/index.js";

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function provider(tenantId: string, id = "provider"): ProviderConfig {
  return {
    tenantId,
    id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    headers: { Authorization: "Bearer local-test-secret" },
    models: [{
      id: "model",
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

function requestInput(tenantId: string, atMs: number) {
  return {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `tenant-physical-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs,
  };
}

function authorization(claim: TenantCredentialRevocationClaim): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

async function seedTenantCredentials(
  store: MemorySessionStore,
  tenantId: string,
  suffix: string,
): Promise<void> {
  await store.setTenantAuth(tenantId, AUTH_POLICY, {
    ciphertext: Buffer.from(`tenant-auth-${suffix}`),
    keyId: `tenant-auth-key-${suffix}`,
  });
  await store.createApiKey(tenantId, `active-${suffix}`, `active-hash-${suffix}`);
  await store.createApiKey(tenantId, `revoked-${suffix}`, `revoked-hash-${suffix}`);
  await store.revokeApiKey(tenantId, `revoked-${suffix}`);
  await store.upsertProviderConfig(provider(tenantId, `provider-${suffix}`), {
    ciphertext: Buffer.from(`provider-secret-${suffix}`),
    keyId: `provider-key-${suffix}`,
  });
}

async function claimOne(
  store: MemorySessionStore,
  claimToken: string,
  leaseMs = 100,
): Promise<TenantCredentialRevocationClaim> {
  const claims = await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs,
    claimToken,
  });
  expect(claims).toHaveLength(1);
  return claims[0]!;
}

describe("MemorySessionStore tenant credential physical revocation", () => {
  it("atomically clears every local credential family and preserves the neighbor tenant", async () => {
    let nowMs = 1_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-physical-target";
    const neighborId = "tenant-physical-neighbor";
    await seedTenantCredentials(store, tenantId, "target");
    await seedTenantCredentials(store, neighborId, "neighbor");
    const request = requestInput(tenantId, 900);
    await store.requestTenantErasure(request);

    expect(await store.getTenantCredentialRevocationJob(tenantId, request.requestId))
      .toMatchObject({ phase: "queued", attempts: 0, availableAtMs: 1_000 });
    const claim = await claimOne(store, "physical-success-token");
    nowMs = 1_010;
    const receipt = await store.revokeTenantCredentialMaterial(authorization(claim));

    expect(receipt).toMatchObject({
      scope: "local-db-credential-material-v1",
      tenantId,
      requestId: request.requestId,
      apiKeyCountBefore: 2,
      apiKeyCountAfter: 0,
      providerConfigCountBefore: 1,
      providerConfigCountAfter: 0,
      authPolicyPresentBefore: true,
      authPolicyPresentAfter: false,
      authSecretCipherPresentBefore: true,
      authSecretCipherPresentAfter: false,
      authSecretKeyIdPresentBefore: true,
      authSecretKeyIdPresentAfter: false,
      storeDbTimestampMs: 1_010,
      completedClaimAttempt: 1,
      runtimeDisposition: "not_in_scope",
      externalDisposition: "not_supported",
      contentPurgeRequired: true,
    });
    expect(receipt?.completedClaimTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt?.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...store.apiKeys.values()].some((key) => key.tenantId === tenantId)).toBe(false);
    expect([...store.providers.values()].some((row) => row.config.tenantId === tenantId)).toBe(false);
    expect(store.tenants.get(tenantId)).toEqual({ tenantId, createdAtMs: expect.any(Number) });

    expect(await store.resolveApiKey("active-hash-neighbor")).toMatchObject({
      tenantId: neighborId,
      keyId: "active-neighbor",
    });
    expect(await store.getProviderConfig(neighborId, "provider-neighbor"))
      .toMatchObject({ config: { tenantId: neighborId, id: "provider-neighbor" } });
    expect((await store.getTenant(neighborId))?.authSecret?.keyId).toBe("tenant-auth-key-neighbor");
    expect(await store.getTenantCredentialRevocationJob(tenantId, request.requestId))
      .toMatchObject({
        phase: "credential_store_revoked",
        completedClaimAttempt: 1,
        completedClaimTokenSha256: receipt?.completedClaimTokenSha256,
      });
    expect(await store.getTenantCredentialRevocationReceipt(tenantId, request.requestId))
      .toEqual(receipt);
    expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
      singletonId: 1,
      controlGeneration: 1,
      activatedAtMs: 1_010,
      firstReceiptSha256: receipt?.receiptSha256,
    });
    expect(await store.getTenantCredentialRevocationReceipt(neighborId, request.requestId))
      .toBeNull();
  });

  it("keeps terminal proof valid after lifecycle completion and permits the next tenant", async () => {
    let nowMs = 1_500;
    const store = new MemorySessionStore({ now: () => nowMs });
    const firstTenantId = "tenant-physical-erased-first";
    const nextTenantId = "tenant-physical-erased-next";
    await seedTenantCredentials(store, firstTenantId, "erased-first");
    await seedTenantCredentials(store, nextTenantId, "erased-next");

    const firstRequest = requestInput(firstTenantId, 1_400);
    await store.requestTenantErasure(firstRequest);
    const firstClaim = await claimOne(store, "erased-first-token");
    nowMs = 1_501;
    const firstReceipt = await store.revokeTenantCredentialMaterial(authorization(firstClaim));
    expect(firstReceipt).not.toBeNull();

    const firstLifecycleKey = subjectLifecycleKey(
      firstTenantId,
      "tenant",
      firstTenantId,
    );
    const firstLifecycle = store.subjectLifecycles.get(firstLifecycleKey)!;
    store.subjectLifecycles.set(firstLifecycleKey, {
      ...firstLifecycle,
      state: "erased",
      activeRequestId: undefined,
      updatedAtMs: Math.max(firstLifecycle.updatedAtMs, 1_502),
    });

    expect(await store.getTenantCredentialRevocationJob(firstTenantId, firstRequest.requestId))
      .toMatchObject({ phase: "credential_store_revoked" });
    expect(await store.getTenantCredentialRevocationReceipt(firstTenantId, firstRequest.requestId))
      .toEqual(firstReceipt);
    expect(await store.revokeTenantCredentialMaterial(authorization(firstClaim)))
      .toEqual(firstReceipt);
    expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
      controlGeneration: 1,
      firstReceiptSha256: firstReceipt?.receiptSha256,
    });

    const nextRequest = requestInput(nextTenantId, 1_503);
    await store.requestTenantErasure(nextRequest);
    const nextClaim = await claimOne(store, "erased-next-token");
    nowMs = 1_504;
    await expect(store.revokeTenantCredentialMaterial(authorization(nextClaim)))
      .resolves.toMatchObject({ tenantId: nextTenantId });
    expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
      controlGeneration: 1,
      firstReceiptSha256: firstReceipt?.receiptSha256,
    });

    // A later T3b projection cleanup must not erase the append-only T1/T3a proof chain.
    store.subjectLifecycles.delete(firstLifecycleKey);
    expect(await store.getTenantCredentialRevocationReceipt(firstTenantId, firstRequest.requestId))
      .toEqual(firstReceipt);
    expect(await store.revokeTenantCredentialMaterial(authorization(firstClaim)))
      .toEqual(firstReceipt);
    expect(await store.getTenantCredentialRevocationCutover()).toMatchObject({
      controlGeneration: 1,
      firstReceiptSha256: firstReceipt?.receiptSha256,
    });
  });

  it("never grants queued or blocked authority after the lifecycle gate is reset", async () => {
    const store = new MemorySessionStore({ now: () => 1_700 });
    const tenantId = "tenant-physical-live-proof";
    await seedTenantCredentials(store, tenantId, "live-proof");
    const request = requestInput(tenantId, 1_600);
    await store.requestTenantErasure(request);
    const lifecycleKey = subjectLifecycleKey(tenantId, "tenant", tenantId);
    const deleting = structuredClone(store.subjectLifecycles.get(lifecycleKey)!);
    const resetLifecycle = {
      ...deleting,
      state: "active" as const,
      activeRequestId: undefined,
      updatedAtMs: Math.max(deleting.updatedAtMs, 1_601),
    };
    store.subjectLifecycles.set(lifecycleKey, resetLifecycle);

    await expect(store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 100,
      claimToken: "must-not-claim-reset-gate",
    })).rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
    expect(store.tenantCredentialRevocationJobs.get(request.requestId))
      .toMatchObject({ phase: "queued", attempts: 0 });

    store.subjectLifecycles.set(lifecycleKey, deleting);
    const claim = await claimOne(store, "live-proof-claim");
    store.subjectLifecycles.set(lifecycleKey, resetLifecycle);
    await expect(store.revokeTenantCredentialMaterial(authorization(claim)))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
    expect([...store.apiKeys.values()].filter((key) => key.tenantId === tenantId)).toHaveLength(2);

    store.subjectLifecycles.set(lifecycleKey, deleting);
    expect(await store.blockTenantCredentialRevocation(authorization(claim))).toBe(true);
    store.subjectLifecycles.set(lifecycleKey, resetLifecycle);
    await expect(store.getTenantCredentialRevocationJob(tenantId, request.requestId))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
  });

  it("uses lease+attempt authority to prevent ABA and replays only the exact completed claim", async () => {
    let nowMs = 2_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-physical-aba";
    await seedTenantCredentials(store, tenantId, "aba");
    const request = requestInput(tenantId, 1_900);
    await store.requestTenantErasure(request);
    const first = await claimOne(store, "reused-claim-token", 20);
    expect(await store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 20,
      claimToken: "other-token",
    })).toEqual([]);

    nowMs = 2_020;
    const second = await claimOne(store, "reused-claim-token", 20);
    expect(second.claimAttempt).toBe(2);
    expect(await store.renewTenantCredentialRevocation(authorization(first), { leaseMs: 50 }))
      .toBe(false);
    expect(await store.retryTenantCredentialRevocation(authorization(first), {
      delayMs: 0,
      errorCode: "temporary_failure",
    })).toBe(false);
    expect(await store.blockTenantCredentialRevocation(authorization(first))).toBe(false);
    expect(await store.revokeTenantCredentialMaterial(authorization(first))).toBeNull();

    nowMs = 2_021;
    const completed = await store.revokeTenantCredentialMaterial(authorization(second));
    expect(completed?.apiKeyCountBefore).toBe(2);
    nowMs = 9_999;
    expect(await store.revokeTenantCredentialMaterial(authorization(second))).toEqual(completed);
    expect(await store.revokeTenantCredentialMaterial({
      ...authorization(second),
      claimAttempt: second.claimAttempt + 1,
    })).toBeNull();
    expect(await store.revokeTenantCredentialMaterial({
      ...authorization(second),
      claimToken: "different-completion-token",
    })).toBeNull();
    expect(await store.revokeTenantCredentialMaterial({
      ...authorization(second),
      tenantId: "tenant-physical-other",
    })).toBeNull();
  });

  it("renews, retries and durably blocks with database-clock-equivalent deadlines", async () => {
    let nowMs = 3_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-physical-control";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    await store.requestTenantErasure(requestInput(tenantId, 2_900));
    const first = await claimOne(store, "control-first", 20);
    nowMs = 3_010;
    expect(await store.renewTenantCredentialRevocation(authorization(first), { leaseMs: 50 }))
      .toBe(true);
    nowMs = 3_020;
    expect(await store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 10,
      claimToken: "too-early",
    })).toEqual([]);
    expect(await store.retryTenantCredentialRevocation(authorization(first), {
      delayMs: 30,
      errorCode: "temporary_failure",
    })).toBe(true);
    expect((await store.getTenantCredentialRevocationJob(tenantId, first.requestId)))
      .toMatchObject({ phase: "queued", attempts: 1, availableAtMs: 3_050 });
    expect(await store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 10,
      claimToken: "still-too-early",
    })).toEqual([]);
    nowMs = 3_050;
    const second = await claimOne(store, "control-second", 20);
    expect(second.claimAttempt).toBe(2);
    expect(await store.blockTenantCredentialRevocation(authorization(second))).toBe(true);
    expect(await store.revokeTenantCredentialMaterial(authorization(second))).toBeNull();
    expect(await store.claimTenantCredentialRevocations({
      limit: 1,
      leaseMs: 10,
      claimToken: "after-block",
    })).toEqual([]);
    expect(await store.getTenantCredentialRevocationJob(tenantId, second.requestId))
      .toMatchObject({
        phase: "blocked",
        attempts: 2,
        blockedAtMs: 3_050,
        blockedReasonCode: "integrity_conflict",
      });
  });

  it("materializes legacy admissions atomically and is idempotent", async () => {
    let nowMs = 4_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    for (const suffix of ["a", "b"] as const) {
      const tenantId = `tenant-physical-legacy-${suffix}`;
      await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
      const request = requestInput(tenantId, 3_900);
      await store.requestTenantErasure(request);
      // Simulate an admission committed by the frozen 0018 writer, before the 0019 job existed.
      store.tenantCredentialRevocationJobs.delete(request.requestId);
    }
    const jobs = store.tenantCredentialRevocationJobs;
    const originalSet = jobs.set;
    let calls = 0;
    jobs.set = function injected(key, value) {
      calls += 1;
      if (calls === 2) throw new Error("injected materialization publication failure");
      return originalSet.call(this, key, value);
    };
    await expect(store.materializeTenantCredentialRevocationJobs({ limit: 10 }))
      .rejects.toThrow("injected materialization publication failure");
    delete (jobs as unknown as { set?: unknown }).set;
    expect(store.tenantCredentialRevocationJobs).toHaveLength(0);

    nowMs = 4_010;
    expect(await store.materializeTenantCredentialRevocationJobs({ limit: 10 })).toBe(2);
    expect(store.tenantCredentialRevocationJobs).toHaveLength(2);
    expect([...store.tenantCredentialRevocationJobs.values()]).toEqual([
      expect.objectContaining({ phase: "queued", availableAtMs: 4_010, createdAtMs: 4_010 }),
      expect.objectContaining({ phase: "queued", availableAtMs: 4_010, createdAtMs: 4_010 }),
    ]);
    expect(await store.materializeTenantCredentialRevocationJobs({ limit: 10 })).toBe(0);
  });

  it("publishes a new admission and its queued credential job as one rollback boundary", async () => {
    const store = new MemorySessionStore({ now: () => 5_000 });
    const tenantId = "tenant-physical-admission-rollback";
    await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
    const input = requestInput(tenantId, 4_900);
    const jobs = store.tenantCredentialRevocationJobs;
    const originalSet = jobs.set;
    jobs.set = function injected(key, value) {
      originalSet.call(this, key, value);
      throw new Error("injected queued-job publication failure");
    };
    await expect(store.requestTenantErasure(input))
      .rejects.toThrow("injected queued-job publication failure");
    delete (jobs as unknown as { set?: unknown }).set;

    expect(store.tenantErasureAdmissions).toHaveLength(0);
    expect(store.tenantCredentialRevocationFences).toHaveLength(0);
    expect(store.erasureAuditEvents).toHaveLength(0);
    expect(store.tenantCredentialRevocationJobs).toHaveLength(0);
    expect(store.subjectLifecycles).toHaveLength(0);
    expect(await store.getTenantRuntimeState(tenantId)).toEqual({
      tenantId,
      state: "active",
      generation: 0,
    });

    expect(await store.replayTenantErasure({
      tenantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    })).toBeNull();
    expect(store.tenantCredentialRevocationJobs).toHaveLength(0);
  });

  it("rolls back physical deletion, proof and cutover on serialization or late Map failure", async () => {
    let nowMs = 6_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const tenantId = "tenant-physical-revoke-rollback";
    await seedTenantCredentials(store, tenantId, "rollback");
    const request = requestInput(tenantId, 5_900);
    await store.requestTenantErasure(request);
    const claim = await claimOne(store, "physical-rollback-token");
    const providerRow = [...store.providers.values()].find(
      (row) => row.config.tenantId === tenantId,
    )!;
    (providerRow.config as ProviderConfig & { uncloneable?: () => void }).uncloneable = () => {};
    const beforeSerialization = structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      job: store.tenantCredentialRevocationJobs.get(request.requestId),
      receipts: [...store.tenantCredentialRevocationReceipts.entries()],
      cutover: [...store.tenantCredentialRevocationCutovers.entries()],
    });
    nowMs = 6_001;
    await expect(store.revokeTenantCredentialMaterial(authorization(claim))).rejects.toBeDefined();
    expect(structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      job: store.tenantCredentialRevocationJobs.get(request.requestId),
      receipts: [...store.tenantCredentialRevocationReceipts.entries()],
      cutover: [...store.tenantCredentialRevocationCutovers.entries()],
    })).toEqual(beforeSerialization);
    delete (providerRow.config as ProviderConfig & { uncloneable?: () => void }).uncloneable;

    const beforeMapFailure = structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      providers: [...store.providers.entries()],
      tenant: store.tenants.get(tenantId),
      job: store.tenantCredentialRevocationJobs.get(request.requestId),
      receipts: [...store.tenantCredentialRevocationReceipts.entries()],
      cutover: [...store.tenantCredentialRevocationCutovers.entries()],
    });
    const receipts = store.tenantCredentialRevocationReceipts;
    const originalSet = receipts.set;
    receipts.set = function injected(key, value) {
      originalSet.call(this, key, value);
      throw new Error("injected receipt publication failure");
    };
    await expect(store.revokeTenantCredentialMaterial(authorization(claim)))
      .rejects.toThrow("injected receipt publication failure");
    delete (receipts as unknown as { set?: unknown }).set;
    expect(structuredClone({
      apiKeys: [...store.apiKeys.entries()],
      providers: [...store.providers.entries()],
      tenant: store.tenants.get(tenantId),
      job: store.tenantCredentialRevocationJobs.get(request.requestId),
      receipts: [...store.tenantCredentialRevocationReceipts.entries()],
      cutover: [...store.tenantCredentialRevocationCutovers.entries()],
    })).toEqual(beforeMapFailure);

    const receipt = await store.revokeTenantCredentialMaterial(authorization(claim));
    expect(receipt?.apiKeyCountBefore).toBe(2);
    expect(await store.getTenantCredentialRevocationCutover())
      .toMatchObject({ controlGeneration: 1, firstReceiptSha256: receipt?.receiptSha256 });
  });

  it("rejects an inactive cutover with an orphan terminal job before deleting another tenant", async () => {
    let nowMs = 7_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const orphanTenantId = "tenant-physical-inactive-orphan";
    await seedTenantCredentials(store, orphanTenantId, "inactive-orphan");
    const orphanRequest = requestInput(orphanTenantId, 6_900);
    await store.requestTenantErasure(orphanRequest);
    const orphanClaim = await claimOne(store, "inactive-orphan-token");
    const claimedJob = store.tenantCredentialRevocationJobs.get(orphanRequest.requestId)!;
    const orphanTerminalJob: TenantCredentialRevocationJobRecord = {
      requestId: claimedJob.requestId,
      tenantId: claimedJob.tenantId,
      subjectGeneration: claimedJob.subjectGeneration,
      t1FenceSha256: claimedJob.t1FenceSha256,
      phase: "credential_store_revoked",
      attempts: claimedJob.attempts,
      createdAtMs: claimedJob.createdAtMs,
      updatedAtMs: nowMs,
      credentialStoreRevokedAtMs: nowMs,
      completedClaimAttempt: orphanClaim.claimAttempt,
      completedClaimTokenSha256: tenantCredentialRevocationClaimTokenSha256(
        orphanClaim.claimToken,
      ),
    };
    store.tenantCredentialRevocationJobs.set(orphanRequest.requestId, orphanTerminalJob);

    const targetTenantId = "tenant-physical-after-inactive-orphan";
    await seedTenantCredentials(store, targetTenantId, "after-inactive-orphan");
    const targetRequest = requestInput(targetTenantId, 6_901);
    await store.requestTenantErasure(targetRequest);
    const targetClaim = await claimOne(store, "after-inactive-orphan-token");
    nowMs = 7_001;

    await expect(store.getTenantCredentialRevocationCutover()).rejects.toMatchObject({
      name: "TenantErasureIntegrityError",
    });
    await expect(store.revokeTenantCredentialMaterial(authorization(targetClaim)))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
    expect([...store.apiKeys.values()].filter((key) => key.tenantId === targetTenantId))
      .toHaveLength(2);
    expect([...store.providers.values()].filter(
      (row) => row.config.tenantId === targetTenantId,
    )).toHaveLength(1);
    expect(store.tenants.get(targetTenantId)).toMatchObject({
      authPolicy: AUTH_POLICY,
      authSecret: { keyId: "tenant-auth-key-after-inactive-orphan" },
    });
    expect(store.tenantCredentialRevocationReceipts).toHaveLength(0);
  });

  it("rejects an active cutover whose first receipt has no terminal job before deletion", async () => {
    let nowMs = 8_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const firstTenantId = "tenant-physical-first-job-missing";
    await seedTenantCredentials(store, firstTenantId, "first-job-missing");
    const firstRequest = requestInput(firstTenantId, 7_900);
    await store.requestTenantErasure(firstRequest);
    const firstClaim = await claimOne(store, "first-job-missing-token");
    await store.revokeTenantCredentialMaterial(authorization(firstClaim));
    store.tenantCredentialRevocationJobs.delete(firstRequest.requestId);

    const targetTenantId = "tenant-physical-after-missing-first-job";
    await seedTenantCredentials(store, targetTenantId, "after-missing-first-job");
    const targetRequest = requestInput(targetTenantId, 7_901);
    await store.requestTenantErasure(targetRequest);
    const targetClaim = await claimOne(store, "after-missing-first-job-token");
    nowMs = 8_001;

    await expect(store.getTenantCredentialRevocationCutover()).rejects.toMatchObject({
      name: "TenantErasureIntegrityError",
    });
    await expect(store.revokeTenantCredentialMaterial(authorization(targetClaim)))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
    expect([...store.apiKeys.values()].filter((key) => key.tenantId === targetTenantId))
      .toHaveLength(2);
    expect([...store.providers.values()].filter(
      (row) => row.config.tenantId === targetTenantId,
    )).toHaveLength(1);
    expect(store.tenants.get(targetTenantId)).toMatchObject({
      authPolicy: AUTH_POLICY,
      authSecret: { keyId: "tenant-auth-key-after-missing-first-job" },
    });
    expect(store.tenantCredentialRevocationReceipts.has(targetRequest.requestId)).toBe(false);
  });

  it("revalidates the first terminal job's T1 source before a later tenant is deleted", async () => {
    let nowMs = 9_000;
    const store = new MemorySessionStore({ now: () => nowMs });
    const firstTenantId = "tenant-physical-first-source-missing";
    await seedTenantCredentials(store, firstTenantId, "first-source-missing");
    const firstRequest = requestInput(firstTenantId, 8_900);
    await store.requestTenantErasure(firstRequest);
    const firstClaim = await claimOne(store, "first-source-missing-token");
    await store.revokeTenantCredentialMaterial(authorization(firstClaim));
    store.tenantCredentialRevocationFences.delete(firstTenantId);

    const targetTenantId = "tenant-physical-after-missing-first-source";
    await seedTenantCredentials(store, targetTenantId, "after-missing-first-source");
    const targetRequest = requestInput(targetTenantId, 8_901);
    await store.requestTenantErasure(targetRequest);
    const targetClaim = await claimOne(store, "after-missing-first-source-token");
    nowMs = 9_001;

    await expect(store.getTenantCredentialRevocationCutover()).rejects.toMatchObject({
      name: "TenantErasureIntegrityError",
    });
    await expect(store.revokeTenantCredentialMaterial(authorization(targetClaim)))
      .rejects.toMatchObject({ name: "TenantErasureIntegrityError" });
    expect([...store.apiKeys.values()].filter((key) => key.tenantId === targetTenantId))
      .toHaveLength(2);
    expect([...store.providers.values()].filter(
      (row) => row.config.tenantId === targetTenantId,
    )).toHaveLength(1);
    expect(store.tenants.get(targetTenantId)).toMatchObject({
      authPolicy: AUTH_POLICY,
      authSecret: { keyId: "tenant-auth-key-after-missing-first-source" },
    });
    expect(store.tenantCredentialRevocationReceipts.has(targetRequest.requestId)).toBe(false);
  });
});
