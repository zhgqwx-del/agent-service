import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MemorySessionStore,
  TenantPurgeExecutionNotReadyError,
  TenantPurgeExecutionPhysicalAckDeadLetterError,
  newErasureRequestId,
  newUserDataExportRequestId,
  subjectLifecycleKey,
  tenantErasureRequestHash,
  userDataExportRequestHash,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const NOW = 20_000;

interface CredentialRolloutClock {
  advance(): void;
  release(): void;
}

const credentialRolloutClocks = new WeakMap<MemorySessionStore, CredentialRolloutClock>();

function memoryStoreWithCredentialRolloutClock(
  storeClock: { now(): number },
): MemorySessionStore {
  const initialNowMs = storeClock.now();
  let floorMs = initialNowMs - 2;
  let released = false;
  const clock = {
    now: () => released ? Math.max(floorMs, storeClock.now()) : floorMs,
  };
  const store = new MemorySessionStore(clock);
  credentialRolloutClocks.set(store, {
    advance: () => { floorMs += 1; },
    release: () => { released = true; },
  });
  return store;
}

function credentialRolloutClock(store: MemorySessionStore): CredentialRolloutClock {
  const clock = credentialRolloutClocks.get(store);
  if (!clock) throw new Error("expected credential-rollout test clock");
  return clock;
}

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null,
    lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
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

function inventoryAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantContentInventories"]>>[number],
): TenantContentInventoryAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function planAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgePlans"]>>[number],
): TenantPurgePlanAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function executionAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgeExecutions"]>>[number],
): TenantPurgeExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(
  source: { requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string },
): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-1.internal:8080"),
    runnerId: "runner-1",
    bootId: "boot-1",
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    t3aReceiptSha256: source.t3aReceiptSha256,
    cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: 900,
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

async function installPolicy(store: MemorySessionStore, tenantId: string): Promise<void> {
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(),
    actorKeyId: "policy-admin",
    atMs: 10,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "policy-admin",
    atMs: 11,
  });
}

async function advanceToExecutionClaim(
  store: MemorySessionStore,
  tenantId: string,
  options: {
    claimToken?: string;
    leaseMs?: number;
    beforeTenantErasure?: () => Promise<void>;
  } = {},
) {
  const rolloutClock = credentialRolloutClock(store);
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId);
  await options.beforeTenantErasure?.();
  if ((await store.readTenantCredentialTrackingCutover()).controlGeneration === 0) {
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  }
  rolloutClock.advance();
  const request = {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `execution-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: 100,
  };
  await store.requestTenantErasure(request);
  const credentialClaim = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 100_000,
    claimToken: `credential-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  expect(await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credentialClaim),
  )).not.toBeNull();
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtimeClaim = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 100_000,
    claimToken: `runtime-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  expect(await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtimeClaim),
    fleetProof(runtimeClaim),
  )).not.toBeNull();
  rolloutClock.advance();
  rolloutClock.release();
  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const inventoryClaim = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 100_000,
    claimToken: `inventory-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const inventoryAuth = inventoryAuthorization(inventoryClaim);
  await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 });
  expect(await store.sealTenantContentInventory(inventoryAuth)).not.toBeNull();
  expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
  const planClaim = (await store.claimTenantPurgePlans({
    limit: 10,
    leaseMs: 100_000,
    claimToken: `plan-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  expect(await store.sealTenantPurgePlan(planAuthorization(planClaim))).not.toBeNull();
  expect(await store.materializeTenantPurgeExecutionJobs({ limit: 10 })).toBe(1);
  const executionClaim = (await store.claimTenantPurgeExecutions({
    limit: 10,
    leaseMs: options.leaseMs ?? 100_000,
    claimToken: options.claimToken ?? `execution-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  return { request, claim: executionClaim, authorization: executionAuthorization(executionClaim) };
}

async function installLocalTargets(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  store.usageLedger.push({
    tenantId,
    userId,
    sessionId: session.id,
    turnId: newId("turn"),
    step: 0,
    provider: "provider-a",
    model: "model-a",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 15,
    },
    createdAtMs: 1_000,
  });
  const blobId = newId("blob");
  store.blobManifests.set(blobId, {
    blobId,
    tenantId,
    userId,
    sessionId: session.id,
    purpose: "tool_output",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: `objects/${blobId.slice(5)}`,
    uploadToken: `upload-${blobId.slice(5)}`,
    state: "ready",
    sha256: "a".repeat(64),
    sizeBytes: 10,
    contentType: "application/octet-stream",
    uploadedAtMs: 1_001,
    readyAtMs: 1_002,
    deletionGeneration: 0,
    createdAtMs: 1_000,
  });

  const exportRequestId = newUserDataExportRequestId();
  const request = await store.requestUserDataExport({
    requestId: exportRequestId,
    tenantId,
    userId,
    requestedByKeyId: "export-admin",
    idempotencyKeySha256: "b".repeat(64),
    requestHash: userDataExportRequestHash(tenantId, userId),
  });
  const artifactId = `xart_${randomUUID()}`;
  store.userDataExportRequests.set(exportRequestId, {
    ...request,
    status: "ready",
    currentBuildGeneration: 1,
    currentArtifactId: artifactId,
    snapshotAtMs: 1_100,
    readyAtMs: 1_101,
    expiresAtMs: 50_000,
    artifactSha256: "c".repeat(64),
    artifactSizeBytes: 10,
    recordCount: 1,
    updatedAtMs: 1_101,
  });
  store.userDataExportJobs.set(exportRequestId, {
    requestId: exportRequestId,
    status: "completed",
    buildGeneration: 1,
    attempts: 1,
    currentArtifactId: artifactId,
    completedAtMs: 1_101,
    createdAtMs: 1_000,
    updatedAtMs: 1_101,
  });
  store.userDataExportArtifacts.set(artifactId, {
    artifactId,
    requestId: exportRequestId,
    tenantId,
    userId,
    subjectGeneration: request.subjectGeneration,
    buildGeneration: 1,
    state: "ready",
    format: "ndjson-v1",
    schemaVersion: 1,
    contentType: "application/vnd.agent-service.user-export+ndjson",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    policyVersion: request.policyVersion,
    policySha256: request.policySha256,
    snapshotRootSha256: "d".repeat(64),
    artifactTtlMs: request.artifactTtlMs,
    partCount: 1,
    recordCount: 1,
    totalSizeBytes: 10,
    contentSha256: "c".repeat(64),
    manifestSha256: "e".repeat(64),
    snapshotAtMs: 1_100,
    stagingExpiresAtMs: 2_000,
    readyAtMs: 1_101,
    expiresAtMs: 50_000,
    deletionGeneration: 0,
    createdAtMs: 1_000,
  });
  store.userDataExportParts.set(JSON.stringify([artifactId, 0]), {
    artifactId,
    requestId: exportRequestId,
    buildGeneration: 1,
    partNumber: 0,
    state: "uploaded",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: `exports/${artifactId}/0`,
    uploadToken: "export-upload-token",
    sha256: "c".repeat(64),
    sizeBytes: 10,
    contentType: "application/vnd.agent-service.user-export+ndjson",
    uploadedAtMs: 1_100,
    deletionGeneration: 0,
    createdAtMs: 1_000,
  });
  store.userDataExportDownloadLeases.set(JSON.stringify([artifactId, "download-token"]), {
    artifactId,
    requestId: exportRequestId,
    tenantId,
    userId,
    leaseToken: "download-token",
    leaseUntilMs: 40_000,
    createdAtMs: 1_200,
  });
  return { session, blobId, exportRequestId, artifactId };
}

class FailOnceMap<K, V> extends Map<K, V> {
  private failed = false;

  override set(key: K, value: V): this {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected execution publication failure");
    }
    return super.set(key, value);
  }
}

describe("MemorySessionStore tenant purge execution", () => {
  it("materializes all 33 domains and seals a zero-target local execution without claiming completion", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-empty";
    const source = await advanceToExecutionClaim(store, tenantId);
    expect(await store.getTenantPurgeExecutionDomains(
      tenantId,
      source.request.requestId,
      1,
    )).toHaveLength(33);

    const [first, second] = await Promise.all([
      store.executeTenantPurgeLocalCutover(source.authorization),
      store.executeTenantPurgeLocalCutover(source.authorization),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      operationalUsageTargetCount: 0,
      blobBytesTargetCount: 0,
      exportBytesTargetCount: 0,
      localDestructiveProgress: true,
      physicalAcksComplete: false,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });
    expect((await store.getTenantPurgeExecutionDomainAcks(
      tenantId,
      source.request.requestId,
      1,
    )).map((ack) => [ack.domain, ack.ackKind, ack.final])).toEqual([
      ["operational_usage", "anonymized", true],
      ["blob_bytes", "blocker_resolution", true],
      ["user_export_control", "applied", true],
      ["user_export_snapshots", "applied", true],
      ["user_export_bytes", "blocker_resolution", true],
    ]);
    await expect(store.sealTenantPurgeLocalPhysicalAcks(source.authorization)).resolves.toMatchObject({
      blobPhysicalAckCount: 0,
      exportPhysicalAckCount: 0,
      localPhysicalAcksComplete: true,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
    });
    expect(await store.getTenantPurgeExecutionJob(tenantId, source.request.requestId)).toMatchObject({
      phase: "local_physical_acks_sealed",
      unresolvedBlockerCount: 7,
    });
  });

  it("atomically anonymizes usage, revokes exports, and binds exact Blob/export outboxes", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-local";
    const userId = "tenant-execution-user";
    let targets: Awaited<ReturnType<typeof installLocalTargets>> | undefined;
    const source = await advanceToExecutionClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        targets = await installLocalTargets(store, tenantId, userId);
      },
    });
    if (!targets) throw new Error("expected local targets");
    const receipt = await store.executeTenantPurgeLocalCutover(source.authorization);
    expect(receipt).toMatchObject({
      operationalUsageTargetCount: 1,
      blobBytesTargetCount: 1,
      blobDeleteOutboxCount: 1,
      exportBytesTargetCount: 1,
      exportDeleteOutboxCount: 1,
      allDomainsComplete: false,
    });
    expect(store.usageLedger).toHaveLength(0);
    expect([...store.billingUsageFacts.values()]).toHaveLength(1);
    expect(store.blobManifests.get(targets.blobId)).toMatchObject({
      state: "delete_pending",
      deletionGeneration: 1,
    });
    expect(store.userDataExportRequests.get(targets.exportRequestId)).toMatchObject({
      status: "revoked",
    });
    expect(store.userDataExportArtifacts.get(targets.artifactId)).toMatchObject({
      state: "delete_pending",
      deletionGeneration: 1,
    });
    expect(store.userDataExportDownloadLeases).toHaveLength(0);

    await expect(store.sealTenantPurgeLocalPhysicalAcks(source.authorization))
      .rejects.toBeInstanceOf(TenantPurgeExecutionNotReadyError);
    const [blobOutbox] = await store.claimBlobDeletes({
      nowMs: NOW,
      limit: 10,
      leaseMs: 1_000,
      claimToken: "blob-delete",
    });
    expect(await store.completeBlobDelete(blobOutbox!.outboxId, "blob-delete", NOW)).toBe(true);
    const [exportOutbox] = await store.claimUserDataExportDeletes({
      limit: 10,
      leaseMs: 1_000,
      claimToken: "export-delete",
    });
    expect(await store.completeUserDataExportDelete(exportOutbox!.outboxId, "export-delete")).toBe(true);
    const physical = await store.sealTenantPurgeLocalPhysicalAcks(source.authorization);
    expect(physical).toMatchObject({
      blobPhysicalAckCount: 1,
      exportPhysicalAckCount: 1,
      localPhysicalAcksComplete: true,
      allDomainsComplete: false,
    });
    const physicalAcks = (await store.getTenantPurgeExecutionDomainAcks(
      tenantId,
      source.request.requestId,
      1,
    )).filter((ack) => ack.ackKind === "physical_delete");
    expect(physicalAcks).toHaveLength(2);
    expect(physicalAcks.every((ack) => ack.scheduledAckSha256 !== undefined && ack.final)).toBe(true);
  });

  it("rolls every destructive map back on publication failure and lease loss", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-rollback";
    const userId = "rollback-user";
    let targets: Awaited<ReturnType<typeof installLocalTargets>> | undefined;
    const source = await advanceToExecutionClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        targets = await installLocalTargets(store, tenantId, userId);
      },
    });
    if (!targets) throw new Error("expected rollback targets");
    store.tenantPurgeLocalCutoverReceipts = new FailOnceMap();
    await expect(store.executeTenantPurgeLocalCutover(source.authorization))
      .rejects.toThrow("injected execution publication failure");
    expect(store.usageLedger).toHaveLength(1);
    expect(store.billingUsageFacts).toHaveLength(0);
    expect(store.blobManifests.get(targets.blobId)).toMatchObject({ state: "ready" });
    expect(store.userDataExportRequests.get(targets.exportRequestId)).toMatchObject({ status: "ready" });
    expect(store.tenantPurgeExecutionDomainAcks).toHaveLength(0);
    expect(store.tenantPurgeExecutionJobs.get(source.request.requestId))
      .not.toHaveProperty("localCutoverReceiptSha256");

    let clockCalls = 0;
    let expire = false;
    const leaseStore = memoryStoreWithCredentialRolloutClock({
      now: () => expire && ++clockCalls >= 3 ? NOW + 6 : NOW,
    });
    const leaseSource = await advanceToExecutionClaim(leaseStore, "tenant-execution-lease", {
      claimToken: "short-execution-lease",
      leaseMs: 5,
    });
    clockCalls = 0;
    expire = true;
    await expect(leaseStore.executeTenantPurgeLocalCutover(leaseSource.authorization)).resolves.toBeNull();
    expect(leaseStore.tenantPurgeExecutionDomainAcks).toHaveLength(0);
    expect(leaseStore.tenantPurgeLocalCutoverReceipts).toHaveLength(0);
  });

  it("rechecks a canonical hold at the irreversible boundary and leaves zero partial state", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-hold-race";
    const source = await advanceToExecutionClaim(store, tenantId);
    const lifecycleKey = subjectLifecycleKey(tenantId, "tenant", tenantId);
    const deleting = structuredClone(store.subjectLifecycles.get(lifecycleKey)!);
    const admission = store.tenantErasureAdmissions.get(source.request.requestId)!;
    const fence = store.tenantCredentialRevocationFences.get(tenantId)!;
    store.tenantErasureAdmissions.delete(source.request.requestId);
    store.tenantCredentialRevocationFences.delete(tenantId);
    store.subjectLifecycles.set(lifecycleKey, {
      ...deleting,
      state: "active",
      activeRequestId: undefined,
    });
    const hold = await store.setLegalHold({
      tenantId,
      holdId: "hold_at_execution_boundary",
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: NOW,
    });
    store.tenantErasureAdmissions.set(source.request.requestId, admission);
    store.tenantCredentialRevocationFences.set(tenantId, fence);
    store.subjectLifecycles.set(lifecycleKey, {
      ...deleting,
      legalHoldAtMs: hold.createdAtMs,
    });

    await expect(store.executeTenantPurgeLocalCutover(source.authorization))
      .rejects.toMatchObject({ reason: "active_legal_hold" });
    expect(store.tenantPurgeExecutionDomainAcks).toHaveLength(0);
    expect(store.tenantPurgeLocalCutoverReceipts).toHaveLength(0);
    expect(store.tenantPurgeExecutionJobs.get(source.request.requestId))
      .not.toHaveProperty("localCutoverReceiptSha256");
  });

  it("atomically blocks an exact dead-lettered physical intent", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-deadletter";
    const userId = "deadletter-user";
    const source = await advanceToExecutionClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        await installLocalTargets(store, tenantId, userId);
      },
    });
    await store.executeTenantPurgeLocalCutover(source.authorization);
    const [blobOutbox] = await store.claimBlobDeletes({
      nowMs: NOW,
      limit: 10,
      leaseMs: 1_000,
      claimToken: "blob-deadletter",
    });
    expect(await store.retryBlobDelete(blobOutbox!.outboxId, "blob-deadletter", {
      failedAtMs: NOW + 1,
      availableAtMs: NOW + 2,
      maxAttempts: 1,
      error: new Error("physical delete failed"),
    })).toBe(true);
    await expect(store.sealTenantPurgeLocalPhysicalAcks(source.authorization))
      .rejects.toBeInstanceOf(TenantPurgeExecutionPhysicalAckDeadLetterError);
    expect(store.tenantPurgeExecutionJobs.get(source.request.requestId)).toMatchObject({
      phase: "blocked",
      blockedReasonCode: "physical_ack_dead_lettered",
    });
    expect(store.tenantPurgeLocalPhysicalAckReceipts).toHaveLength(0);
  });

  it("does not cross tenant boundaries and exposes pending as a typed retry boundary", async () => {
    const store = memoryStoreWithCredentialRolloutClock({ now: () => NOW });
    const tenantId = "tenant-execution-isolation";
    const source = await advanceToExecutionClaim(store, tenantId);
    expect(await store.getTenantPurgeExecutionJob("foreign-tenant", source.request.requestId)).toBeNull();
    expect(await store.getTenantPurgeExecutionDomains("foreign-tenant", source.request.requestId, 1))
      .toEqual([]);
    await store.executeTenantPurgeLocalCutover(source.authorization);
    await store.sealTenantPurgeLocalPhysicalAcks(source.authorization);
    await expect(store.sealTenantPurgeLocalPhysicalAcks({
      ...source.authorization,
      tenantId: "foreign-tenant",
    })).resolves.toBeNull();
  });
});
