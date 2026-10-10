import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type AgentDefinition,
  type Approval,
  type Item,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256,
  MemorySessionStore,
  SessionGoneError,
  TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
  TenantDatabasePurgeEvidenceChangedError,
  TenantDatabasePurgeNotReadyError,
  computeBillingUsageFactSha256,
  newErasureRequestId,
  newUserDataExportRequestId,
  newUsageId,
  subjectLifecycleKey,
  tenantDatabasePurgeBillingFactRootSha256,
  tenantDatabasePurgeBridgeSha256,
  tenantDatabasePurgeCutoverEvidenceSha256,
  tenantDatabasePurgeDomainAckRootSha256,
  tenantDatabasePurgeDomainAckSha256,
  tenantDatabasePurgeNextDomainAckRootSha256,
  tenantDatabasePurgeOperationSha256,
  tenantDatabasePurgePhysicalProofSha256,
  tenantDatabasePurgePreDeleteEntryRootSha256,
  tenantDatabasePurgePreDeleteEntrySha256,
  tenantDatabasePurgePreDeleteReceiptSha256,
  tenantDatabasePurgeReceiptSha256,
  tenantDatabasePurgeSessionGraveMarkerRootSha256,
  tenantDatabasePurgeSessionGraveMarkerSha256,
  tenantDatabasePurgeTargetRootSha256,
  tenantDatabasePurgeTargetSha256,
  tenantErasureRequestHash,
  tenantRedisPurgeMarkerSha256,
  userDataExportRequestHash,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantDatabasePurgeAuthorization,
  type TenantDatabasePurgeDomainAck,
  type TenantDatabasePurgeJobRecord,
  type TenantDatabasePurgePreDeleteEntry,
  type TenantDatabasePurgePreDeleteReceipt,
  type TenantDatabasePurgeReceipt,
  type TenantPurgeSessionGraveMarker,
  type TenantRedisPurgeAdapterResult,
  type TenantRedisPurgeAuthorization,
  type TenantRedisPurgeJobRecord,
  type TenantRedisPurgeTarget,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const NOW = 40_000;

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

function databaseAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantDatabasePurges"]>>[number],
): TenantDatabasePurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function redisAuthorization(
  claim: Awaited<ReturnType<MemorySessionStore["claimTenantRedisPurges"]>>[number],
): TenantRedisPurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    redisPurgeGeneration: claim.redisPurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function redisResult(
  target: TenantRedisPurgeTarget,
  bits: { leaseExisted: boolean; fenceExisted: boolean; streamExisted: boolean } = {
    leaseExisted: true,
    fenceExisted: true,
    streamExisted: true,
  },
): TenantRedisPurgeAdapterResult {
  const evidence = {
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: target.redisNamespaceSha256,
    sessionId: target.sessionId,
    operationSha256: target.operationSha256,
    ...bits,
  };
  return {
    ...evidence,
    markerSha256: tenantRedisPurgeMarkerSha256(evidence),
    replayed: false,
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

async function advanceToDatabaseClaim(
  store: MemorySessionStore,
  tenantId: string,
  options: {
    beforeTenantErasure?: () => Promise<void>;
    databaseLeaseMs?: number;
    databaseClaimToken?: string;
  } = {},
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId);
  await options.beforeTenantErasure?.();
  const lifecycleNotifications = await store.claimLifecycleOutbox({
    topics: ["session.tombstoned"],
    nowMs: NOW,
    limit: 100,
    leaseMs: 10_000,
    claimToken: `lifecycle-${tenantId}`,
  });
  for (const notification of lifecycleNotifications) {
    expect(await store.completeLifecycleOutbox(
      notification.outboxId,
      `lifecycle-${tenantId}`,
      NOW,
    )).toBe(true);
  }
  const request = {
    requestId: newErasureRequestId(),
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `database-${randomUUID()}`,
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
    leaseMs: 100_000,
    claimToken: `execution-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  const executionAuth = executionAuthorization(executionClaim);
  expect(await store.executeTenantPurgeLocalCutover(executionAuth)).not.toBeNull();
  const blobDeletes = await store.claimBlobDeletes({
    nowMs: NOW,
    limit: 100,
    leaseMs: 10_000,
    claimToken: `blob-delete-${tenantId}`,
  });
  for (const row of blobDeletes) {
    expect(await store.completeBlobDelete(
      row.outboxId,
      `blob-delete-${tenantId}`,
      NOW,
    )).toBe(true);
  }
  const exportDeletes = await store.claimUserDataExportDeletes({
    limit: 100,
    leaseMs: 10_000,
    claimToken: `export-delete-${tenantId}`,
  });
  for (const row of exportDeletes) {
    expect(await store.completeUserDataExportDelete(
      row.outboxId,
      `export-delete-${tenantId}`,
    )).toBe(true);
  }
  expect(await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).not.toBeNull();
  expect(await store.materializeTenantDatabasePurgeJobs({ limit: 10 })).toBe(1);
  const databaseClaim = (await store.claimTenantDatabasePurges({
    limit: 10,
    leaseMs: options.databaseLeaseMs ?? 100_000,
    claimToken: options.databaseClaimToken ?? `database-${tenantId}`,
  })).find((claim) => claim.requestId === request.requestId)!;
  return {
    request,
    claim: databaseClaim,
    authorization: databaseAuthorization(databaseClaim),
  };
}

function installSession(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
  withUsage = false,
) {
  const session = {
    ...mkSession(tenantId, userId),
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const install = async () => {
    await store.createSession(session);
    if (withUsage) {
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
        createdAtMs: 1_100,
      });
    }
  };
  return { session, install };
}

async function installBlob(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const target = installSession(store, tenantId, userId);
  await target.install();
  const blobId = newId("blob");
  store.blobManifests.set(blobId, {
    blobId,
    tenantId,
    userId,
    sessionId: target.session.id,
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
  return { ...target, blobId };
}

async function installExport(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const requestId = newUserDataExportRequestId();
  const requested = await store.requestUserDataExport({
    requestId,
    tenantId,
    userId,
    requestedByKeyId: "export-admin",
    idempotencyKeySha256: "b".repeat(64),
    requestHash: userDataExportRequestHash(tenantId, userId),
  });
  const artifactId = `xart_${randomUUID()}`;
  store.userDataExportRequests.set(requestId, {
    ...requested,
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
  store.userDataExportJobs.set(requestId, {
    requestId,
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
    requestId,
    tenantId,
    userId,
    subjectGeneration: requested.subjectGeneration,
    buildGeneration: 1,
    state: "ready",
    format: "ndjson-v1",
    schemaVersion: 1,
    contentType: "application/vnd.agent-service.user-export+ndjson",
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    policyVersion: requested.policyVersion,
    policySha256: requested.policySha256,
    snapshotRootSha256: "d".repeat(64),
    artifactTtlMs: requested.artifactTtlMs,
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
    requestId,
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
  return { requestId, artifactId };
}

function agent(tenantId: string): AgentDefinition {
  return {
    id: newId("agt"),
    tenantId,
    version: 1,
    name: "tenant database purge fixture",
    instructions: "fixture",
    model: { provider: "provider-a", model: "model-a" },
    tools: [],
    mcpServers: [],
    skills: [],
    limits: {},
    approvalPolicy: "on-request",
    busyPolicy: "steer",
    sandbox: "none",
    metadata: { fixture: true },
    createdAtMs: 1_000,
  };
}

async function installSessionGraph(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const target = installSession(store, tenantId, userId, true);
  await target.install();
  const turn: Turn = {
    id: newId("turn"),
    sessionId: target.session.id,
    status: "inProgress",
    seqStart: 2,
    steps: 1,
    toolCalls: 0,
    usage: emptyUsage(),
    startedAtMs: 1_100,
  };
  const approvalId = newId("apr");
  const approvalRequest: Item = {
    id: newId("item"),
    sessionId: target.session.id,
    turnId: turn.id,
    seq: 0,
    step: 1,
    status: "completed",
    type: "approvalRequest",
    approvalId,
    toolCallId: `tool-${target.session.id}`,
    name: "fixture-tool",
    args: { fixture: true },
    completedAtMs: 1_101,
    createdAtMs: 1_100,
  };
  const approval: Approval = {
    id: approvalId,
    sessionId: target.session.id,
    turnId: turn.id,
    itemId: newId("item"),
    status: "pending",
    toolCallId: approvalRequest.toolCallId,
    toolName: approvalRequest.name,
    args: approvalRequest.args,
    availableDecisions: ["accept", "decline", "cancel"],
    createdAtMs: 1_100,
    expiresAtMs: 30_000,
  };
  await store.commit({
    sessionId: target.session.id,
    fence: 1,
    turn,
    items: [approvalRequest],
    approvals: [approval],
    events: [
      { type: "turn/started", sessionId: target.session.id, emittedAtMs: 1_100, turn },
      {
        type: "item/completed",
        sessionId: target.session.id,
        emittedAtMs: 1_101,
        item: approvalRequest,
      },
      {
        type: "approval/requested",
        sessionId: target.session.id,
        emittedAtMs: 1_101,
        approval,
      },
    ],
  });
  const stored = store.sessions.get(target.session.id)!;
  store.sessions.set(target.session.id, { ...stored, updatedAtMs: 1_101 });
  const idempotencyKey = JSON.stringify([
    tenantId,
    userId,
    target.session.id,
    "fixture-pending",
  ]);
  store.idem.set(idempotencyKey, { value: null, expiresAt: 50_000 });
  return { ...target, turn, approval, approvalRequest, idempotencyKey };
}

async function installTombstonedReconciliation(
  store: MemorySessionStore,
  tenantId: string,
  userId: string,
) {
  const target = installSession(store, tenantId, userId);
  await target.install();
  const deletedAtMs = 1_200;
  await store.commit({
    sessionId: target.session.id,
    fence: 1,
    lifecycle: {
      type: "tombstone",
      tenantId,
      userId,
      deletionGeneration: 1,
      atMs: deletedAtMs,
    },
    events: [{
      type: "session/deleted",
      sessionId: target.session.id,
      deletionGeneration: 1,
      emittedAtMs: deletedAtMs,
    }],
  });
  const stored = store.sessions.get(target.session.id)!;
  store.sessions.set(target.session.id, { ...stored, updatedAtMs: deletedAtMs });
  await store.reconcileSessionUsage({
    tenantId,
    userId,
    sessionId: target.session.id,
    deletionGeneration: 1,
    nowMs: deletedAtMs + 1,
  });
  return target;
}

async function installBusinessProjectionFixture(
  store: MemorySessionStore,
  tenantId: string,
) {
  const definition = agent(tenantId);
  await store.createAgent(definition);
  const graph = await installSessionGraph(store, tenantId, `${tenantId}-graph-user`);
  const tombstoned = await installTombstonedReconciliation(
    store,
    tenantId,
    `${tenantId}-deleted-user`,
  );
  const blob = await installBlob(store, tenantId, `${tenantId}-blob-user`);
  const exported = await installExport(store, tenantId, `${tenantId}-export-user`);
  return { definition, graph, tombstoned, blob, exported };
}

function tenantBusinessProjectionState(store: MemorySessionStore, tenantId: string) {
  const sessionIds = new Set(
    [...store.sessions.values()]
      .filter((session) => session.tenantId === tenantId)
      .map((session) => session.id),
  );
  const requestIds = new Set(
    [...store.userDataExportRequests.values()]
      .filter((request) => request.tenantId === tenantId)
      .map((request) => request.requestId),
  );
  const artifactIds = new Set(
    [...store.userDataExportArtifacts.values()]
      .filter((artifact) => artifact.tenantId === tenantId)
      .map((artifact) => artifact.artifactId),
  );
  const blobIds = new Set(
    [...store.blobManifests.values()]
      .filter((manifest) => manifest.tenantId === tenantId)
      .map((manifest) => manifest.blobId),
  );
  const exportIdempotency = (store as unknown as {
    userDataExportIdempotency: Map<string, string>;
  }).userDataExportIdempotency;
  return structuredClone({
    tenant: store.tenants.get(tenantId),
    agents: [...store.agents].filter(([, row]) => row.tenantId === tenantId),
    sessions: [...store.sessions].filter(([key]) => sessionIds.has(key)),
    turns: [...store.turns].filter(([, row]) => sessionIds.has(row.sessionId)),
    items: [...store.items].filter(([, row]) => sessionIds.has(row.sessionId)),
    approvals: [...store.approvals].filter(([, row]) => sessionIds.has(row.sessionId)),
    events: [...store.events].filter(([key]) => sessionIds.has(key)),
    deleted: [...store.deleted].filter(([key]) => sessionIds.has(key)),
    idempotency: [...store.idem].filter(([key]) => {
      try {
        const scope: unknown = JSON.parse(key);
        return Array.isArray(scope) && scope[0] === tenantId;
      } catch {
        return false;
      }
    }),
    usageLedger: store.usageLedger.filter((row) => row.tenantId === tenantId),
    billingUsageFacts: [...store.billingUsageFacts]
      .filter(([, row]) => row.tenantId === tenantId),
    usageReconciliations: [...store.usageReconciliations]
      .filter(([, row]) => row.tenantId === tenantId),
    blobManifests: [...store.blobManifests]
      .filter(([key]) => blobIds.has(key)),
    blobDeleteOutbox: [...store.blobDeleteOutbox]
      .filter(([, row]) => blobIds.has(row.blobId)),
    lifecycleOutbox: [...store.lifecycleOutbox]
      .filter(([, row]) => sessionIds.has(row.aggregateId)),
    exportRequests: [...store.userDataExportRequests]
      .filter(([key]) => requestIds.has(key)),
    exportJobs: [...store.userDataExportJobs]
      .filter(([key]) => requestIds.has(key)),
    exportArtifacts: [...store.userDataExportArtifacts]
      .filter(([key]) => artifactIds.has(key)),
    exportParts: [...store.userDataExportParts]
      .filter(([, row]) => artifactIds.has(row.artifactId)),
    exportSnapshotRecords: [...store.userDataExportSnapshotRecords]
      .filter(([key]) => requestIds.has(key)),
    exportSnapshotBlobs: [...store.userDataExportSnapshotBlobs]
      .filter(([key]) => requestIds.has(key)),
    exportDeleteOutbox: [...store.userDataExportDeleteOutbox]
      .filter(([, row]) => artifactIds.has(row.artifactId)),
    exportDownloadLeases: [...store.userDataExportDownloadLeases]
      .filter(([, row]) => row.tenantId === tenantId),
    exportIdempotency: [...exportIdempotency]
      .filter(([, requestId]) => requestIds.has(requestId)),
  });
}

class FailOnceMap<K, V> extends Map<K, V> {
  private failed = false;

  override set(key: K, value: V): this {
    if (!this.failed) {
      this.failed = true;
      throw new Error("injected database purge publication failure");
    }
    return super.set(key, value);
  }
}

function fullyRehashT3fEvidence(
  store: MemorySessionStore,
  requestId: string,
  options: {
    spliceGrave?: boolean;
    retainedBillingFactRootSha256?: string;
  },
): void {
  const job = store.tenantDatabasePurgeJobs.get(requestId);
  const oldPreDeleteReceipt = store.tenantDatabasePurgePreDeleteReceipts.get(requestId);
  const oldReceipt = store.tenantDatabasePurgeReceipts.get(requestId);
  if (!job || job.phase !== "database_purged" || !oldPreDeleteReceipt || !oldReceipt) {
    throw new Error("expected completed database purge evidence");
  }
  const entries = [...store.tenantDatabasePurgePreDeleteEntries.values()]
    .filter((entry) => entry.requestId === requestId)
    .sort((left, right) => left.domainOrdinal - right.domainOrdinal);
  const oldMarkers = [...store.tenantPurgeSessionGraveMarkers.values()]
    .filter((marker) => marker.requestId === requestId)
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  if (options.spliceGrave && oldMarkers.length !== 2) {
    throw new Error("expected two grave markers");
  }
  const first = oldMarkers[0]!;
  const second = oldMarkers[1]!;

  const sessionEntryIndex = entries.findIndex((entry) => entry.domain === "session_content");
  const oldSessionEntry = entries[sessionEntryIndex]!;
  const splicedSessionTargets = oldMarkers.map((marker) => tenantDatabasePurgeTargetSha256(
    "session_content",
    [
      marker.sessionId,
      options.spliceGrave && marker.sessionId === first.sessionId
        ? second.t3cSessionReceiptSha256
        : marker.t3cSessionReceiptSha256,
    ],
  ));
  const sessionTargetRootSha256 = tenantDatabasePurgeTargetRootSha256(
    "session_content",
    splicedSessionTargets,
  );
  const { receiptSha256: _oldSessionEntrySha, ...oldSessionEntryBody } = oldSessionEntry;
  const sessionEntryBody = {
    ...oldSessionEntryBody,
    preDeleteTargetRootSha256: sessionTargetRootSha256,
    bridgeSha256: tenantDatabasePurgeBridgeSha256({
      bridgeKind: "direct_plan",
      domain: "session_content",
      planEntryReceiptSha256: oldSessionEntry.planEntryReceiptSha256,
      planTargetCount: oldSessionEntry.planTargetCount,
      planTargetRootSha256: oldSessionEntry.planTargetRootSha256,
      preDeleteTargetCount: oldSessionEntry.preDeleteTargetCount,
      preDeleteTargetRootSha256: sessionTargetRootSha256,
    }),
  };
  const sessionEntry: TenantDatabasePurgePreDeleteEntry = {
    ...sessionEntryBody,
    receiptSha256: tenantDatabasePurgePreDeleteEntrySha256(sessionEntryBody),
  };
  entries[sessionEntryIndex] = sessionEntry;
  const entryRootSha256 = tenantDatabasePurgePreDeleteEntryRootSha256(entries);
  const { receiptSha256: _oldPreDeleteSha, ...oldPreDeleteBody } = oldPreDeleteReceipt;
  const preDeleteBody = {
    ...oldPreDeleteBody,
    entryRootSha256,
    sessionTargetRootSha256,
    retainedBillingFactRootSha256: options.retainedBillingFactRootSha256
      ?? oldPreDeleteReceipt.retainedBillingFactRootSha256,
  };
  const preDeleteReceipt: TenantDatabasePurgePreDeleteReceipt = {
    ...preDeleteBody,
    receiptSha256: tenantDatabasePurgePreDeleteReceiptSha256(preDeleteBody),
  };
  const markers = oldMarkers.map((marker): TenantPurgeSessionGraveMarker => {
    const { markerSha256: _oldMarkerSha, ...oldMarkerBody } = marker;
    const markerBody = {
      ...oldMarkerBody,
      t3cSessionReceiptSha256: options.spliceGrave && marker.sessionId === first.sessionId
        ? second.t3cSessionReceiptSha256
        : marker.t3cSessionReceiptSha256,
      preDeleteReceiptSha256: preDeleteReceipt.receiptSha256,
    };
    return {
      ...markerBody,
      markerSha256: tenantDatabasePurgeSessionGraveMarkerSha256(markerBody),
    };
  });
  const graveMarkerRootSha256 = tenantDatabasePurgeSessionGraveMarkerRootSha256(markers);
  const entryByDomain = new Map(entries.map((entry) => [entry.domain, entry] as const));
  const oldAcks = [...store.tenantDatabasePurgeDomainAcks.values()]
    .filter((ack) => ack.requestId === requestId)
    .sort((left, right) => left.globalAckSeq - right.globalAckSeq);
  const acks: TenantDatabasePurgeDomainAck[] = [];
  let previousGlobalAckSha256 = EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256;
  for (const oldAck of oldAcks) {
    const entry = entryByDomain.get(oldAck.domain)!;
    const retainedEvidenceRootSha256 = oldAck.domain === "session_content"
      ? graveMarkerRootSha256
      : oldAck.retainedEvidenceRootSha256;
    const operationSha256 = tenantDatabasePurgeOperationSha256({
      identity: job,
      domain: oldAck.domain,
      action: oldAck.action,
      preDeleteTargetCount: entry.preDeleteTargetCount,
      preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
      affectedCount: oldAck.affectedCount,
      resultTargetCount: oldAck.resultTargetCount,
      resultTargetRootSha256: oldAck.resultTargetRootSha256,
      retainedEvidenceCount: oldAck.retainedEvidenceCount,
      retainedEvidenceRootSha256,
    });
    const {
      receiptSha256: _oldAckSha,
      operationSha256: _oldOperation,
      physicalProofSha256: _oldPhysical,
      ...oldAckBody
    } = oldAck;
    const ackWithoutProof = {
      ...oldAckBody,
      previousGlobalAckSha256,
      preDeleteEntryReceiptSha256: entry.receiptSha256,
      preDeleteTargetCount: entry.preDeleteTargetCount,
      preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
      retainedEvidenceRootSha256,
      operationSha256,
    };
    const ackBody = {
      ...ackWithoutProof,
      physicalProofSha256: tenantDatabasePurgePhysicalProofSha256({
        identity: job,
        domain: oldAck.domain,
        action: oldAck.action,
        adapterProtocol: oldAck.adapterProtocol,
        previousGlobalAckSha256,
        preDeleteEntryReceiptSha256: entry.receiptSha256,
        operationSha256,
        storeDbTimestampMs: oldAck.storeDbTimestampMs,
        completedClaimAttempt: oldAck.completedClaimAttempt,
        completedClaimTokenSha256: oldAck.completedClaimTokenSha256,
      }),
    };
    const ack: TenantDatabasePurgeDomainAck = {
      ...ackBody,
      receiptSha256: tenantDatabasePurgeDomainAckSha256(ackBody),
    };
    acks.push(ack);
    previousGlobalAckSha256 = tenantDatabasePurgeNextDomainAckRootSha256(
      previousGlobalAckSha256,
      ack.globalAckSeq,
      ack.domain,
      ack.receiptSha256,
    );
  }
  const domainAckRootSha256 = tenantDatabasePurgeDomainAckRootSha256(acks);
  const { receiptSha256: _oldTerminalSha, ...oldTerminalBody } = oldReceipt;
  const terminalBody = {
    ...oldTerminalBody,
    preDeleteReceiptSha256: preDeleteReceipt.receiptSha256,
    preDeleteEntryRootSha256: entryRootSha256,
    domainAckRootSha256,
    graveMarkerRootSha256,
    retainedBillingFactRootSha256: options.retainedBillingFactRootSha256
      ?? oldReceipt.retainedBillingFactRootSha256,
  };
  const receipt: TenantDatabasePurgeReceipt = {
    ...terminalBody,
    receiptSha256: tenantDatabasePurgeReceiptSha256(terminalBody),
  };
  const terminal: TenantDatabasePurgeJobRecord = {
    ...job,
    preDeleteReceiptSha256: preDeleteReceipt.receiptSha256,
    preDeleteEntryRootSha256: entryRootSha256,
    domainAckRootSha256,
    terminalReceiptSha256: receipt.receiptSha256,
  };
  for (const entry of entries) {
    store.tenantDatabasePurgePreDeleteEntries.set(JSON.stringify([
      entry.requestId,
      entry.databasePurgeGeneration,
      entry.domain,
    ]), entry);
  }
  store.tenantDatabasePurgePreDeleteReceipts.set(requestId, preDeleteReceipt);
  for (const marker of markers) store.tenantPurgeSessionGraveMarkers.set(marker.sessionId, marker);
  store.tenantDatabasePurgeDomainAcks.clear();
  for (const ack of acks) {
    store.tenantDatabasePurgeDomainAcks.set(JSON.stringify([
      ack.requestId,
      ack.databasePurgeGeneration,
      ack.globalAckSeq,
    ]), ack);
  }
  store.tenantDatabasePurgeReceipts.set(requestId, receipt);
  store.tenantDatabasePurgeJobs.set(requestId, terminal);
  const cutover = store.tenantDatabasePurgeCutovers.get(1);
  if (!cutover || cutover.controlGeneration !== 1) throw new Error("expected active cutover");
  const cutoverBody = {
    singletonId: 1 as const,
    controlGeneration: 1 as const,
    activatedAtDbMs: cutover.activatedAtDbMs,
    firstRequestId: cutover.firstRequestId,
    firstReceiptSha256: receipt.receiptSha256,
  };
  store.tenantDatabasePurgeCutovers.set(1, {
    ...cutoverBody,
    evidenceSha256: tenantDatabasePurgeCutoverEvidenceSha256(cutoverBody),
  });
}

describe("MemorySessionStore tenant database purge", () => {
  it("publishes the fixed zero-target catalog and exact replay without claiming global completion", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-empty";
    const source = await advanceToDatabaseClaim(store, tenantId);
    const [first, replay] = await Promise.all([
      store.executeTenantDatabasePurge(source.authorization),
      store.executeTenantDatabasePurge(source.authorization),
    ]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      localDatabasePurgeComplete: true,
      sessionContentDeleted: true,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
      graveMarkerCount: 0,
      domainAckCount: 11,
      preDeleteEntryCount: 11,
    });
    expect(await store.getTenantDatabasePurgePreDeleteEntries(
      tenantId,
      source.request.requestId,
      1,
    )).toHaveLength(11);
    expect(await store.getTenantDatabasePurgeDomainAcks(
      tenantId,
      source.request.requestId,
      1,
    )).toHaveLength(11);
    expect(await store.getTenantDatabasePurgeJob("other-tenant", source.request.requestId))
      .toBeNull();
    expect(await store.getTenantDatabasePurgeReceipt("other-tenant", source.request.requestId))
      .toBeNull();
    expect(await store.getTenantDatabasePurgePreDeleteEntries(
      "other-tenant",
      source.request.requestId,
      1,
    )).toEqual([]);
  });

  it("deletes session content, retains exact billing facts, and globally fences session ID reuse", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-content";
    const target = installSession(store, tenantId, "user-a", true);
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: target.install,
    });
    const [first, replay] = await Promise.all([
      store.executeTenantDatabasePurge(source.authorization),
      store.executeTenantDatabasePurge(source.authorization),
    ]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ graveMarkerCount: 1, retainedBillingFactCount: 1 });
    expect(store.sessions.has(target.session.id)).toBe(false);
    expect(store.events.has(target.session.id)).toBe(false);
    expect(store.billingUsageFacts).toHaveLength(1);
    expect(await store.getTenantPurgeSessionGraveMarker(tenantId, target.session.id))
      .toMatchObject({ deletionGeneration: 1, deletedAtDbMs: NOW, markedAtDbMs: NOW });
    expect(await store.getTenantPurgeSessionGraveMarker("other-tenant", target.session.id))
      .toBeNull();
    await expect(store.createSession({
      ...target.session,
      tenantId: "other-tenant",
      userId: "other-user",
    })).rejects.toBeInstanceOf(SessionGoneError);
  });

  it("preserves every neighboring tenant business projection during destructive execution", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-isolated-target";
    const neighborTenantId = "tenant-database-isolated-neighbor";
    await store.setTenantAuth(neighborTenantId, DEFAULT_AUTH_POLICY);
    await installPolicy(store, neighborTenantId);
    await installBusinessProjectionFixture(store, neighborTenantId);
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        await installBusinessProjectionFixture(store, tenantId);
      },
    });
    const neighborBefore = tenantBusinessProjectionState(store, neighborTenantId);

    await expect(store.executeTenantDatabasePurge(source.authorization)).resolves.toMatchObject({
      localDatabasePurgeComplete: true,
    });

    expect(tenantBusinessProjectionState(store, neighborTenantId)).toEqual(neighborBefore);
    expect([...store.agents.values()].some((row) => row.tenantId === tenantId)).toBe(false);
    expect([...store.sessions.values()].some((row) => row.tenantId === tenantId)).toBe(false);
    expect([...store.blobManifests.values()].some((row) => row.tenantId === tenantId)).toBe(false);
    expect([...store.userDataExportRequests.values()].some((row) => row.tenantId === tenantId))
      .toBe(false);
  });

  it("rolls back every business/evidence map on publication failure and final lease loss", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-rollback";
    let fixture: Awaited<ReturnType<typeof installBusinessProjectionFixture>> | undefined;
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        fixture = await installBusinessProjectionFixture(store, tenantId);
      },
    });
    if (!fixture) throw new Error("expected rollback fixture");
    const businessBefore = tenantBusinessProjectionState(store, tenantId);
    expect(businessBefore.agents).toHaveLength(1);
    expect(businessBefore.sessions.length).toBeGreaterThanOrEqual(3);
    expect(businessBefore.turns).toHaveLength(1);
    expect(businessBefore.items).toHaveLength(1);
    expect(businessBefore.approvals).toHaveLength(1);
    expect(businessBefore.events.length).toBeGreaterThanOrEqual(3);
    expect(businessBefore.deleted).toHaveLength(1);
    expect(businessBefore.idempotency).toHaveLength(1);
    expect(businessBefore.billingUsageFacts).toHaveLength(1);
    expect(businessBefore.usageReconciliations).toHaveLength(1);
    expect(businessBefore.blobManifests).toHaveLength(1);
    expect(businessBefore.blobDeleteOutbox).toHaveLength(1);
    expect(businessBefore.lifecycleOutbox).toHaveLength(2);
    expect(businessBefore.exportRequests).toHaveLength(1);
    expect(businessBefore.exportJobs).toHaveLength(1);
    expect(businessBefore.exportArtifacts).toHaveLength(1);
    expect(businessBefore.exportParts).toHaveLength(1);
    expect(businessBefore.exportDeleteOutbox).toHaveLength(1);
    store.tenantDatabasePurgeDomainAcks = new FailOnceMap();
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toThrow("injected database purge publication failure");
    expect(tenantBusinessProjectionState(store, tenantId)).toEqual(businessBefore);
    expect(store.tenantDatabasePurgePreDeleteEntries).toHaveLength(0);
    expect(store.tenantDatabasePurgePreDeleteReceipts).toHaveLength(0);
    expect(store.tenantDatabasePurgeDomainAcks).toHaveLength(0);
    expect(store.tenantDatabasePurgeReceipts).toHaveLength(0);
    expect(store.tenantPurgeSessionGraveMarkers).toHaveLength(0);

    let clockCalls = 0;
    let expire = false;
    const leaseStore = new MemorySessionStore({
      now: () => expire && ++clockCalls >= 3 ? NOW + 6 : NOW,
    });
    const leaseTarget = installSession(leaseStore, "tenant-database-lease", "lease-user");
    const leaseSource = await advanceToDatabaseClaim(leaseStore, "tenant-database-lease", {
      beforeTenantErasure: leaseTarget.install,
      databaseLeaseMs: 5,
      databaseClaimToken: "short-database-lease",
    });
    clockCalls = 0;
    expire = true;
    await expect(leaseStore.executeTenantDatabasePurge(leaseSource.authorization))
      .resolves.toBeNull();
    expect(leaseStore.sessions.has(leaseTarget.session.id)).toBe(true);
    expect(leaseStore.tenantDatabasePurgeReceipts).toHaveLength(0);
    expect(leaseStore.tenantPurgeSessionGraveMarkers).toHaveLength(0);
  });

  it("rejects added/replaced billing facts at the destructive boundary", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-billing-drift";
    const target = installSession(store, tenantId, "billing-user", true);
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: target.install,
    });
    const original = [...store.billingUsageFacts.values()][0]!;
    const { factSha256: _ignored, ...originalBody } = original;
    const extraUsageId = newUsageId();
    const extraBody = { ...originalBody, usageId: extraUsageId };
    store.billingUsageFacts.set(extraUsageId, {
      ...extraBody,
      factSha256: computeBillingUsageFactSha256(extraBody),
    });
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
    store.billingUsageFacts.delete(extraUsageId);
    const replacedBody = { ...originalBody, model: "replacement-model" };
    store.billingUsageFacts.set(original.usageId, {
      ...replacedBody,
      factSha256: computeBillingUsageFactSha256(replacedBody),
    });
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
    expect(store.sessions.has(target.session.id)).toBe(true);
    expect(store.tenantDatabasePurgeReceipts).toHaveLength(0);
  });

  it("fails closed for pending/dead-lettered physical projections and canonical holds", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-physical";
    let target: Awaited<ReturnType<typeof installBlob>> | undefined;
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        target = await installBlob(store, tenantId, "blob-user");
      },
    });
    if (!target) throw new Error("expected Blob target");
    const outboxEntry = [...store.blobDeleteOutbox.entries()].find(([, row]) => (
      row.blobId === target!.blobId
    ))!;
    const completed = structuredClone(outboxEntry[1]);
    const pending = structuredClone(completed);
    delete pending.completedAtMs;
    store.blobDeleteOutbox.set(outboxEntry[0], pending);
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toMatchObject({ reason: "physical_projection_pending" });
    const dead = structuredClone(pending);
    dead.deadLetteredAtMs = NOW;
    store.blobDeleteOutbox.set(outboxEntry[0], dead);
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toBeInstanceOf(TenantDatabasePurgeNotReadyError);
    store.blobDeleteOutbox.set(outboxEntry[0], completed);

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
      holdId: "hold_at_database_boundary",
      subjectKind: "tenant",
      subjectId: tenantId,
      reasonCode: "litigation",
      expectedControlGeneration: 0,
      actorKeyId: "legal-admin",
      atMs: NOW,
    });
    store.tenantErasureAdmissions.set(source.request.requestId, admission);
    store.tenantCredentialRevocationFences.set(tenantId, fence);
    store.subjectLifecycles.set(lifecycleKey, { ...deleting, legalHoldAtMs: hold.createdAtMs });
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toMatchObject({ reason: "active_legal_hold" });
    expect(store.sessions.has(target.session.id)).toBe(true);
    expect(store.tenantDatabasePurgeReceipts).toHaveLength(0);
  });

  it("refuses completed replay when the write-once cutover is missing or corrupt", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const source = await advanceToDatabaseClaim(store, "tenant-database-cutover");
    const receipt = await store.executeTenantDatabasePurge(source.authorization);
    expect(receipt).not.toBeNull();
    store.tenantDatabasePurgeCutovers.set(1, { singletonId: 1, controlGeneration: 0 });
    await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
  });

  it("rejects a fully rehashed grave/session splice against the immutable T3c catalog", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-grave-splice";
    const first = installSession(store, tenantId, "user-first");
    const second = installSession(store, tenantId, "user-second");
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        await first.install();
        await second.install();
      },
    });
    expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
    fullyRehashT3fEvidence(store, source.request.requestId, { spliceGrave: true });
    await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
    await expect(store.getTenantDatabasePurgeReceipt(tenantId, source.request.requestId))
      .rejects.toThrow();
  });

  it("rejects a valid billing-fact replacement after every T3f hash is recomputed", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-billing-rehash";
    const first = installSession(store, tenantId, "billing-first", true);
    const second = installSession(store, tenantId, "billing-second");
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        await first.install();
        await second.install();
      },
    });
    expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
    const original = [...store.billingUsageFacts.values()][0]!;
    const { factSha256: _oldFactSha, ...originalBody } = original;
    const replacementBody = { ...originalBody, model: "post-completion-replacement" };
    const replacement = {
      ...replacementBody,
      factSha256: computeBillingUsageFactSha256(replacementBody),
    };
    store.billingUsageFacts.set(replacement.usageId, replacement);
    fullyRehashT3fEvidence(store, source.request.requestId, {
      retainedBillingFactRootSha256: tenantDatabasePurgeBillingFactRootSha256([
        replacement.factSha256,
      ]),
    });
    await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
    await expect(store.getTenantDatabasePurgeReceipt(tenantId, source.request.requestId))
      .rejects.toThrow();
  });

  it("rejects a live Blob/outbox replacement even when its post-delete shape is self-consistent", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-blob-splice";
    let target: Awaited<ReturnType<typeof installBlob>> | undefined;
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        target = await installBlob(store, tenantId, "blob-splice-user");
      },
    });
    if (!target) throw new Error("expected Blob target");
    const original = store.blobManifests.get(target.blobId)!;
    const replacementBlobId = newId("blob");
    store.blobManifests.delete(target.blobId);
    store.blobManifests.set(replacementBlobId, {
      ...original,
      blobId: replacementBlobId,
      storageKey: `objects/${replacementBlobId.slice(5)}`,
    });
    const outboxEntry = [...store.blobDeleteOutbox.entries()].find(([, row]) => (
      row.blobId === target!.blobId
    ))!;
    store.blobDeleteOutbox.set(outboxEntry[0], {
      ...outboxEntry[1],
      blobId: replacementBlobId,
      storageKey: `objects/${replacementBlobId.slice(5)}`,
    });
    await expect(store.executeTenantDatabasePurge(source.authorization))
      .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
    expect(store.sessions.has(target.session.id)).toBe(true);
    expect(store.tenantDatabasePurgeReceipts).toHaveLength(0);
  });

  it("rejects a live export artifact/part/outbox replacement outside the T3e ACK identities", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-export-splice";
    let target: Awaited<ReturnType<typeof installExport>> | undefined;
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        target = await installExport(store, tenantId, "export-splice-user");
      },
    });
    if (!target) throw new Error("expected export target");
    const artifact = store.userDataExportArtifacts.get(target.artifactId)!;
    const partKey = JSON.stringify([target.artifactId, 0]);
    const part = store.userDataExportParts.get(partKey)!;
    const outboxEntry = [...store.userDataExportDeleteOutbox.entries()].find(([, row]) => (
      row.artifactId === target!.artifactId
    ))!;
    const replacementArtifactId = `xart_${randomUUID()}`;
    store.userDataExportArtifacts.delete(target.artifactId);
    store.userDataExportArtifacts.set(replacementArtifactId, {
      ...artifact,
      artifactId: replacementArtifactId,
    });
    store.userDataExportParts.delete(partKey);
    store.userDataExportParts.set(JSON.stringify([replacementArtifactId, 0]), {
      ...part,
      artifactId: replacementArtifactId,
      storageKey: `exports/${replacementArtifactId}/0`,
    });
    store.userDataExportDeleteOutbox.set(outboxEntry[0], {
      ...outboxEntry[1],
      artifactId: replacementArtifactId,
      storageKey: `exports/${replacementArtifactId}/0`,
    });
    await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
    expect(store.tenantDatabasePurgeReceipts).toHaveLength(0);
  });

  it("accepts an exact T3e export successor and removes its completed control/artifact rows", async () => {
    const store = new MemorySessionStore({ now: () => NOW });
    const tenantId = "tenant-database-export-successor";
    let target: Awaited<ReturnType<typeof installExport>> | undefined;
    const source = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        target = await installExport(store, tenantId, "export-successor-user");
      },
    });
    if (!target) throw new Error("expected export target");
    await expect(store.executeTenantDatabasePurge(source.authorization)).resolves.toMatchObject({
      localDatabasePurgeComplete: true,
    });
    expect(store.userDataExportRequests.has(target.requestId)).toBe(false);
    expect(store.userDataExportArtifacts.has(target.artifactId)).toBe(false);
    expect(store.userDataExportParts).toHaveLength(0);
    expect(store.userDataExportDeleteOutbox).toHaveLength(0);
  });
});

describe("MemorySessionStore tenant Redis purge", () => {
  const namespaceSha256 = "7".repeat(64);

  it("reuses an exact partial ACK across lease takeover, seals once, and isolates tenants", async () => {
    let nowMs = NOW;
    const store = new MemorySessionStore(
      { now: () => nowMs },
      { tenantRedisPurgeNamespaceSha256: namespaceSha256 },
    );
    const tenantId = "tenant-redis-takeover";
    const session = installSession(store, tenantId, "redis-user");
    const database = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: session.install,
    });
    expect(await store.executeTenantDatabasePurge(database.authorization)).not.toBeNull();
    expect(await store.hasTenantRedisPurgeJobs()).toBe(false);
    expect(await store.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
    expect(await store.hasTenantRedisPurgeJobs()).toBe(true);

    const firstClaim = (await store.claimTenantRedisPurges({
      limit: 10,
      leaseMs: 100,
      claimToken: "redis-first",
    }))[0]!;
    const firstAuthorization = redisAuthorization(firstClaim);
    const [target] = await store.getTenantRedisPurgeTargets(
      tenantId,
      database.request.requestId,
      1,
    );
    if (!target) throw new Error("expected Redis purge target");
    const adapterResult = redisResult(target);
    expect(await store.recordTenantRedisPurgeTargetAck(
      { ...firstAuthorization, tenantId: "foreign-tenant" },
      adapterResult,
    )).toBeNull();
    expect(await store.sealTenantRedisPurge({
      ...firstAuthorization,
      tenantId: "foreign-tenant",
    })).toBeNull();
    const [firstAck, concurrentReplay] = await Promise.all([
      store.recordTenantRedisPurgeTargetAck(firstAuthorization, adapterResult),
      store.recordTenantRedisPurgeTargetAck(firstAuthorization, adapterResult),
    ]);
    expect(firstAck).toEqual(concurrentReplay);
    expect(store.tenantRedisPurgeTargetAcks).toHaveLength(1);

    const [partialFence] = (await store.listTenantRedisPurgeRestoreFences({ limit: 10 })).fences;
    expect(partialFence).toMatchObject({
      jobPhase: "queued",
      terminalReceiptSha256: null,
      markerSha256: adapterResult.markerSha256,
    });
    expect(await store.retryTenantRedisPurge(firstAuthorization, {
      delayMs: 0,
      errorCode: "temporary_failure",
    })).toBe(true);
    nowMs += 1;
    const secondClaim = (await store.claimTenantRedisPurges({
      limit: 10,
      leaseMs: 100,
      claimToken: "redis-second",
    }))[0]!;
    const secondAuthorization = redisAuthorization(secondClaim);
    expect(await store.renewTenantRedisPurge(firstAuthorization, { leaseMs: 100 })).toBe(false);
    expect(await store.recordTenantRedisPurgeTargetAck(firstAuthorization, adapterResult)).toBeNull();
    const reused = await store.recordTenantRedisPurgeTargetAck(
      secondAuthorization,
      { ...adapterResult, replayed: true },
    );
    expect(reused).toEqual(firstAck);
    expect(reused?.completedClaimAttempt).toBe(firstClaim.claimAttempt);

    const receipt = await store.sealTenantRedisPurge(secondAuthorization);
    expect(receipt).toMatchObject({
      redisPurgeComplete: true,
      allDomainsComplete: false,
      contentPurgeExecuted: false,
      targetAckCount: 1,
      markerCount: 1,
      domainAckCount: 3,
      completedClaimAttempt: secondClaim.claimAttempt,
    });
    expect(await store.sealTenantRedisPurge(secondAuthorization)).toEqual(receipt);
    expect(await store.getTenantRedisPurgeJob("foreign-tenant", database.request.requestId))
      .toBeNull();
    expect(await store.getTenantRedisPurgeTargets("foreign-tenant", database.request.requestId, 1))
      .toEqual([]);
    const [terminalFence] = (await store.listTenantRedisPurgeRestoreFences({ limit: 10 })).fences;
    expect(terminalFence).toMatchObject({
      jobPhase: "redis_purge_sealed",
      terminalReceiptSha256: receipt?.receiptSha256,
      targetAckReceiptSha256: firstAck?.receiptSha256,
    });
  });

  it("freezes each restore scan while later ACKs append to the in-memory ledger", async () => {
    const store = new MemorySessionStore(
      { now: () => NOW },
      { tenantRedisPurgeNamespaceSha256: namespaceSha256 },
    );
    const tenantId = "tenant-redis-restore-snapshot";
    const sessions = ["one", "two", "three"].map((suffix) => (
      installSession(store, tenantId, `restore-${suffix}`)
    ));
    const database = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: async () => {
        for (const session of sessions) await session.install();
      },
    });
    expect(await store.executeTenantDatabasePurge(database.authorization)).not.toBeNull();
    expect(await store.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
    const claim = (await store.claimTenantRedisPurges({
      limit: 10,
      leaseMs: 100,
      claimToken: "redis-restore-snapshot",
    }))[0]!;
    const authorization = redisAuthorization(claim);
    const targets = await store.getTenantRedisPurgeTargets(
      tenantId,
      database.request.requestId,
      1,
    );
    expect(targets).toHaveLength(3);
    for (const target of targets.slice(0, 2)) {
      expect(await store.recordTenantRedisPurgeTargetAck(
        authorization,
        redisResult(target),
      )).not.toBeNull();
    }

    const firstPage = await store.listTenantRedisPurgeRestoreFences({ limit: 1 });
    expect(firstPage.fences).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();

    expect(await store.recordTenantRedisPurgeTargetAck(
      authorization,
      redisResult(targets[2]!),
    )).not.toBeNull();
    const frozenRemainder = await store.listTenantRedisPurgeRestoreFences({
      limit: 10,
      cursor: firstPage.nextCursor,
    });
    expect(frozenRemainder.fences).toHaveLength(1);
    expect(frozenRemainder.nextCursor).toBeUndefined();

    const nextScan = await store.listTenantRedisPurgeRestoreFences({ limit: 10 });
    expect(nextScan.fences).toHaveLength(3);
  });

  it("rolls back staged publication failures without losing prior target ACKs", async () => {
    const store = new MemorySessionStore(
      { now: () => NOW },
      { tenantRedisPurgeNamespaceSha256: namespaceSha256 },
    );
    const tenantId = "tenant-redis-rollback";
    const session = installSession(store, tenantId, "rollback-user");
    const database = await advanceToDatabaseClaim(store, tenantId, {
      beforeTenantErasure: session.install,
    });
    expect(await store.executeTenantDatabasePurge(database.authorization)).not.toBeNull();

    store.tenantRedisPurgeTargets = new FailOnceMap();
    await expect(store.materializeTenantRedisPurgeJobs({ limit: 10 }))
      .rejects.toThrow("injected database purge publication failure");
    expect(store.tenantRedisPurgeJobs).toHaveLength(0);
    expect(store.tenantRedisPurgeTargets).toHaveLength(0);
    store.tenantRedisPurgeTargets = new Map();
    expect(await store.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);

    const failingJobs = new FailOnceMap<string, TenantRedisPurgeJobRecord>();
    for (const [key, value] of store.tenantRedisPurgeJobs) {
      Map.prototype.set.call(failingJobs, key, value);
    }
    store.tenantRedisPurgeJobs = failingJobs;
    await expect(store.claimTenantRedisPurges({
      limit: 10,
      leaseMs: 100,
      claimToken: "redis-claim-rollback",
    })).rejects.toThrow("injected database purge publication failure");
    expect([...store.tenantRedisPurgeJobs.values()][0]).toMatchObject({
      phase: "queued",
      attempts: 0,
    });
    expect([...store.tenantRedisPurgeJobs.values()][0]).not.toHaveProperty("claimToken");

    const claim = (await store.claimTenantRedisPurges({
      limit: 10,
      leaseMs: 100,
      claimToken: "redis-rollback",
    }))[0]!;
    const auth = redisAuthorization(claim);
    const [target] = await store.getTenantRedisPurgeTargets(
      tenantId,
      database.request.requestId,
      1,
    );
    if (!target) throw new Error("expected Redis purge target");
    const adapterResult = redisResult(target);
    store.tenantRedisPurgeTargetAcks = new FailOnceMap();
    await expect(store.recordTenantRedisPurgeTargetAck(auth, adapterResult))
      .rejects.toThrow("injected database purge publication failure");
    expect(store.tenantRedisPurgeTargetAcks).toHaveLength(0);
    expect((await store.getTenantRedisPurgeJob(tenantId, database.request.requestId))
      ?.targetAckCount).toBe(0);
    expect(await store.recordTenantRedisPurgeTargetAck(auth, adapterResult)).not.toBeNull();

    store.tenantRedisPurgeDomainAcks = new FailOnceMap();
    await expect(store.sealTenantRedisPurge(auth))
      .rejects.toThrow("injected database purge publication failure");
    expect(store.tenantRedisPurgeDomainAcks).toHaveLength(0);
    expect(store.tenantRedisPurgeReceipts).toHaveLength(0);
    expect(store.tenantRedisPurgeTargetAcks).toHaveLength(1);
    expect((await store.getTenantRedisPurgeJob(tenantId, database.request.requestId))?.phase)
      .toBe("queued");
    const [partialFence] = (await store.listTenantRedisPurgeRestoreFences({ limit: 10 })).fences;
    expect(partialFence).toMatchObject({
      jobPhase: "queued",
      terminalReceiptSha256: null,
      markerSha256: adapterResult.markerSha256,
    });
  });
});
