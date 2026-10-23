import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Item,
} from "@agent-service/protocol";
import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MemorySessionStore,
  newErasureRequestId,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantTelemetryWriteAdapterResult,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantDatabasePurgeAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRuntimeRevocationAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { activateCaptureFixture, captureRefKey, captureCurrentStepFixture as captureStepFixture } from "./persisted-provider-capture.fixture.js";
import { admitCaptureFixtureInput, currentCaptureMemorySnapshot } from "./fixtures/capture-current-authority.js";
import { tenantTelemetryDispositionInventoryTargetRootSha256 } from "../src/tenant-telemetry-disposition.js";
import * as RetainedSource from "../src/tenant-telemetry-retained-source.js";
import * as PersistedCapture from "../src/tenant-telemetry-persisted-provider-capture.js";

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0, userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0, idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null, lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
  };
}

const authorization = {
  publication(claim: Awaited<ReturnType<MemorySessionStore["claimTenantRestoreJournalPublications"]>>[number]): TenantRestoreJournalPublicationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, publicationGeneration: claim.publicationGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  credential(claim: Awaited<ReturnType<MemorySessionStore["claimTenantCredentialRevocations"]>>[number]): TenantCredentialRevocationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  runtime(claim: Awaited<ReturnType<MemorySessionStore["claimTenantRuntimeRevocations"]>>[number]): TenantRuntimeRevocationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  inventory(claim: Awaited<ReturnType<MemorySessionStore["claimTenantContentInventories"]>>[number]): TenantContentInventoryAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  plan(claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgePlans"]>>[number]): TenantPurgePlanAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  execution(claim: Awaited<ReturnType<MemorySessionStore["claimTenantPurgeExecutions"]>>[number]): TenantPurgeExecutionAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, planBuildGeneration: claim.planBuildGeneration,
      executionGeneration: claim.executionGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  database(claim: Awaited<ReturnType<MemorySessionStore["claimTenantDatabasePurges"]>>[number]): TenantDatabasePurgeAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, planBuildGeneration: claim.planBuildGeneration,
      executionGeneration: claim.executionGeneration, databasePurgeGeneration: claim.databasePurgeGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
};

async function publicationAck(store: MemorySessionStore, requestId: string) {
  const claim = (await store.claimTenantRestoreJournalPublications({
    limit: 1, leaseMs: 60_000, claimToken: `retained-publication-${randomUUID()}`,
  })).find((row) => row.requestId === requestId);
  if (!claim) throw new Error("missing genuine T1 publication claim");
  const auth = authorization.publication(claim);
  const pending = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
  if (!pending) throw new Error("missing genuine T1 publication record");
  const previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
  const result = {
    adapterProtocol: pending.target.adapterProtocol,
    journalNamespaceSha256: pending.target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: pending.target.logicalDatabaseNamespaceSha256,
    targetSha256: pending.target.targetSha256,
    remoteSequence: 1, previousHeadRootSha256,
    headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
      previousHeadRootSha256, targetSha256: pending.target.targetSha256,
      remoteSequence: 1, operationSha256: pending.record.operationSha256,
      recordSha256: pending.record.recordSha256,
    }),
    record: pending.record, replayed: false,
  };
  expect(await store.recordTenantRestoreJournalPublicationTargetAck(auth, result)).not.toBeNull();
  expect(await store.sealTenantRestoreJournalPublication(auth))
    .toMatchObject({ restoreFencePublicationComplete: true });
}

function fleetProof(source: {
  requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string;
}) {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://runner-1.internal:8080"),
    runnerId: "runner-1", bootId: "boot-1",
    requestId: source.requestId, tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration, t3aReceiptSha256: source.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return { fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets), targets };
}

async function capturedTenant(
  mode: "written" | "pending" | "reserved" = "written",
  withBlob = false,
) {
  const store = new MemorySessionStore(
    { now: () => Date.now() },
    { tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true,
      tenantRedisPurgeNamespaceSha256: "8".repeat(64) },
  );
  await activateCaptureFixture(store);
  const tenantId = `retained-vertical-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  await store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({ tenantId, policyVersion: "retained-zero-day", policy: policy(),
    actorKeyId: "retained-policy-admin", atMs: Date.now() });
  await store.activateRetentionPolicy({ tenantId, policyVersion: "retained-zero-day",
    expectedControlGeneration: 0, actorKeyId: "retained-policy-admin", atMs: Date.now() });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  const capture = await captureStepFixture(store, { tenantId, userId });
  const committed = await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(capture));
  let lateAck: (() => Promise<unknown>) | null = null;
  if (mode !== "pending") {
    const claim = (await store.claimTenantTelemetryWriteJobs({
      limit: 1, leaseMs: 60_000, claimToken: `retained-write-${randomUUID()}`,
      adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: capture.proof,
    })).find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256);
    if (!claim) throw new Error("missing genuine captured writer claim");
    const writeAuthorization = { tenantId, writeOperationSha256: claim.writeOperationSha256,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
    expect(await store.reserveTenantTelemetryExternalMutation(
      writeAuthorization, "telemetry-s3-object-v1", capture.proof,
    )).not.toBeNull();
    const result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
      writeOperationSha256: claim.writeOperationSha256,
      target: claim.target, inventory: claim.inventory, payload: claim.payload,
    }, "already_present", true);
    lateAck = () => store.completeTenantTelemetryWrite(writeAuthorization, result, capture.proof);
    if (mode === "written") expect(await lateAck()).not.toBeNull();
  }
  await store.commit(capture.lease.admit({
    sessionId: capture.session.id, fence: 1,
    turn: { ...capture.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
    sessionPatch: { status: { type: "idle" } },
  }));
  if (withBlob) {
    const blobId = newId("blob");
    const uploadToken = `retained-upload-${randomUUID()}`;
    const createdAtMs = Date.now();
    const owner = { tenantId, userId };
    await store.stageBlob(capture.lease.admit({ owner, sessionId: capture.session.id, fence: 1,
      blobId, purpose: "tool_output", storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT, storageKey: `objects/${blobId.slice(5)}`,
      uploadToken, createdAtMs, stagingExpiresAtMs: createdAtMs + 60_000 }));
    await store.markBlobUploaded(capture.lease.admit({ owner, sessionId: capture.session.id, fence: 1,
      blobId, uploadToken, sha256: "a".repeat(64), sizeBytes: 128,
      contentType: "application/json", uploadedAtMs: createdAtMs + 1 }));
    const item: Item = { id: newId("item"), sessionId: capture.session.id,
      turnId: capture.batch.turn!.id, seq: 0, status: "completed", createdAtMs,
      completedAtMs: createdAtMs + 1, type: "toolResult",
      toolCallId: "retained-blob-call", name: "retained-blob",
      content: [{ type: "text", text: "stored externally" }],
      isError: false, outputRef: blobId };
    await store.commit(capture.lease.admit({ sessionId: capture.session.id, fence: 1,
      items: [item], blobBindings: [{ blobId, itemId: item.id, purpose: "tool_output" }],
      events: [{ type: "item/completed", sessionId: capture.session.id,
        emittedAtMs: createdAtMs + 1, item }] }));
    expect(await store.getBlobManifest(blobId)).toMatchObject({ state: "ready" });
  }
  const request = { requestId: newErasureRequestId(), tenantId,
    requestedByKeyId: "retained-source-unit-admin", idempotencyKey: `retained-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() };
  await store.requestTenantErasure(request);
  expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
    .toMatchObject({ eligibility: mode === "written" ? "eligible_retained" : "blocked_source",
      writtenAckCount: mode === "written" ? 1 : 0 });
  await publicationAck(store, request.requestId);
  return { store, tenantId, userId, capture, committed, request, lateAck };
}

async function throughPlanClaim(
  mode: "written" | "pending" | "reserved" = "written",
  withBlob = false,
) {
  const source = await capturedTenant(mode, withBlob);
  const { store, request } = source;
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 1, leaseMs: 60_000, claimToken: `retained-credential-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!credential) throw new Error("missing T3a claim");
  expect(await store.revokeTenantCredentialMaterial(authorization.credential(credential))).not.toBeNull();
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 1 })).toBe(1);
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 1, leaseMs: 60_000, claimToken: `retained-runtime-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!runtime) throw new Error("missing T3b claim");
  expect(await store.completeTenantRuntimeRevocation(authorization.runtime(runtime), fleetProof(runtime)))
    .not.toBeNull();
  expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
  const inventory = (await store.claimTenantContentInventories({
    limit: 1, leaseMs: 60_000, claimToken: `retained-inventory-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!inventory) throw new Error("missing T3c claim");
  const inventoryAuth = authorization.inventory(inventory);
  await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 });
  expect(await store.sealTenantContentInventory(inventoryAuth)).not.toBeNull();
  expect(await store.materializeTenantPurgePlanJobs({ limit: 1 })).toBe(1);
  const plan = (await store.claimTenantPurgePlans({
    limit: 1, leaseMs: 60_000, claimToken: `retained-plan-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!plan) throw new Error("missing T3d claim");
  const planAuth = authorization.plan(plan);
  return { ...source, planAuth };
}

async function throughPlan(withBlob = false) {
  const source = await throughPlanClaim("written", withBlob);
  const { store, request, planAuth } = source;
  expect(await store.sealTenantPurgePlan(planAuth)).not.toBeNull();
  expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(source.tenantId, request.requestId))
    .toMatchObject({ entryCount: 1, persistedProviderV2Count: 1, unknownGroupCount: 0 });
  return { ...source, planAuth };
}

async function claimExecution(source: Awaited<ReturnType<typeof throughPlan>>) {
  const { store, request, tenantId } = source;
  expect(await store.materializeTenantPurgeExecutionJobs({ limit: 1 })).toBe(1);
  const execution = (await store.claimTenantPurgeExecutions({
    limit: 1, leaseMs: 60_000, claimToken: `retained-execution-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!execution) throw new Error("missing T3e claim");
  const executionAuth = authorization.execution(execution);
  return { ...source, executionAuth };
}

async function throughUsage() {
  const source = await claimExecution(await throughPlan());
  const { store, request, tenantId, executionAuth } = source;
  const cutover = await store.executeTenantPurgeLocalCutover(executionAuth);
  expect(cutover).not.toBeNull();
  expect(store.usageLedger.filter((row) => row.tenantId === tenantId)).toEqual([]);
  expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
    .toMatchObject({ entryCount: 1, retainedBillingFactCount: 1,
      executionReady: false, allDomainsComplete: false, contentPurgeExecuted: false });
  return { ...source, executionAuth, cutover };
}

async function claimDatabase(source: Awaited<ReturnType<typeof throughUsage>>) {
  const { store, request, executionAuth } = source;
  // This fixture has no Blob or export target; no external-object deletion is performed.
  expect(await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).not.toBeNull();
  expect(await store.materializeTenantDatabasePurgeJobs({ limit: 1 })).toBe(1);
  const claim = (await store.claimTenantDatabasePurges({
    limit: 1, leaseMs: 60_000, claimToken: `retained-database-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!claim) throw new Error("missing T3f claim");
  return { ...source, databaseAuth: authorization.database(claim) };
}

async function throughCanonical() {
  const source = await claimDatabase(await throughUsage());
  expect(await source.store.executeTenantDatabasePurge(source.databaseAuth)).not.toBeNull();
  return source;
}

describe("0054 retained-source Memory destructive local bridge", () => {
  it.each([
    ["aggregate", "retainedSourceCatalogReceipts"],
    ["target", "retainedSourceCatalogTargets"],
    ["provider-binding backlink", "retainedSourceCatalogSources"],
  ] as const)("old live source getters reject a lost sealed %s without falling back to canonical live rows", async (_kind, mapName) => {
    const source = await throughPlan();
    const { store, tenantId, request, capture, committed } = source;
    const operation = committed.failureCommitReceipt.writeOperationSha256;
    const originalBinding = await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation);
    const originalFailure = await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(capture.lookup);
    expect(originalBinding).not.toBeNull();
    expect(originalFailure).toEqual(committed.failureCommitReceipt);
    expect(await store.verifyPersistedProviderStepFailureSource(capture.lookup))
      .toMatchObject({ status: "source_verified_written", sourceCount: 1 });
    const maps = store as unknown as Record<typeof mapName,
      Map<string, { requestId: string; sourceKind?: string }>>;
    const rows = maps[mapName];
    const removed = [...rows.entries()].filter(([, row]) => row.requestId === request.requestId
      && (mapName !== "retainedSourceCatalogSources" || row.sourceKind === "provider_source_binding"));
    expect(removed).toHaveLength(1);
    for (const [key] of removed) expect(rows.delete(key)).toBe(true);
    try {
      // These unchanged business rows would satisfy the old live-only verifier.
      // Rejection must depend on the independently sealed new-family evidence.
      expect(store.sessions.has(capture.session.id)).toBe(true);
      expect(store.items.has(capture.item.id)).toBe(true);
      expect(store.usageLedger.filter((row) => row.tenantId === tenantId)).toHaveLength(1);
      await expect(store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation))
        .rejects.toThrow();
      await expect(store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(capture.lookup))
        .rejects.toThrow();
      await expect(store.verifyPersistedProviderStepFailureSource(capture.lookup)).rejects.toThrow();
      await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
        .rejects.toThrow();
      // Another tenant's opaque operation remains owner-hidden, even if this
      // tenant's catalog is corrupt. It is never permission to inspect the row.
      expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding("different-tenant", operation))
        .toBeNull();
    } finally {
      for (const [key, row] of removed) rows.set(key, row);
    }
    expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation))
      .toEqual(originalBinding);
    expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(capture.lookup))
      .toEqual(originalFailure);
    expect(await store.verifyPersistedProviderStepFailureSource(capture.lookup))
      .toMatchObject({ status: "source_verified_written", sourceCount: 1 });
  });

  it.each(["live", "usage_released", "canonical_closed"] as const)(
    "retains independently audited old source reads and owner isolation in %s", async (phase) => {
      const source = phase === "live" ? await throughPlan()
        : phase === "usage_released" ? await throughUsage() : await throughCanonical();
      const { store, tenantId, capture, committed } = source;
      const operation = committed.failureCommitReceipt.writeOperationSha256;
      expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation))
        .toMatchObject({ tenantId, writeOperationSha256: operation,
          receiptSha256: committed.failureCommitReceipt.bindingReceiptSha256 });
      expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(capture.lookup))
        .toEqual(committed.failureCommitReceipt);
      expect(await store.verifyPersistedProviderStepFailureSource(capture.lookup))
        .toMatchObject({ status: "source_verified_written", sourceCount: 1,
          executionReady: false, allDomainsComplete: false });
      const otherLookup = { ...capture.lookup, tenantId: "different-tenant" };
      expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding("different-tenant", operation))
        .toBeNull();
      expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(otherLookup))
        .toBeNull();
      expect(await store.verifyPersistedProviderStepFailureSource(otherLookup))
        .toMatchObject({ status: "not_found", sourceCount: 0 });
      // Read-only historical verification never authorizes a new external create;
      // the live phase is fenced by T1 too, independently of its intact source.
      await expect(store.verifyPersistedProviderStepFailureWrite(tenantId, operation, capture.proof, "create"))
        .rejects.toThrow();
    },
  );

  it.each(["missing", "wrong-tenant", "wrong-binding"] as const)(
    "does not return an otherwise valid source binding with a %s actual failure receipt", async (kind) => {
      const source = await capturedTenant();
      const { store, tenantId, capture, committed } = source;
      const operation = committed.failureCommitReceipt.writeOperationSha256;
      const originalBinding = await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation);
      expect(originalBinding).not.toBeNull();
      const failures = (store as unknown as {
        persistedProviderFailureReceipts: Map<string, PersistedCapture.PersistedProviderStepFailureCommitReceipt>;
      }).persistedProviderFailureReceipts;
      const original = failures.get(operation);
      if (!original) throw new Error("genuine captured failure receipt is missing");
      if (kind === "missing") expect(failures.delete(operation)).toBe(true);
      else {
        const { receiptSha256: _oldHash, ...originalBody } = original;
        const body = kind === "wrong-tenant" ? { ...originalBody, tenantId: "different-tenant" }
          : { ...originalBody, bindingReceiptSha256: originalBody.bindingReceiptSha256 === "f".repeat(64)
            ? "e".repeat(64) : "f".repeat(64) };
        const replacement = { ...body, receiptSha256: PersistedCapture.persistedProviderCaptureReceiptSha256(body) };
        PersistedCapture.validatePersistedProviderFailureCommitReceipt(replacement);
        failures.set(operation, replacement);
      }
      try {
        await expect(store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation))
          .rejects.toThrow();
        expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding("different-tenant", operation))
          .toBeNull();
      } finally { failures.set(operation, original); }
      expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation))
        .toEqual(originalBinding);
      expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(capture.lookup))
        .toEqual(original);
    },
  );

  it("rejects an orphan T1 cohort when the explicit admission family marker is lost", async () => {
    const { store, tenantId, request } = await throughPlanClaim();
    const cohort = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId);
    const families = (store as unknown as {
      retainedSourceAdmissionFamilies: Map<string, unknown>;
    }).retainedSourceAdmissionFamilies;
    const family = families.get(request.requestId);
    expect(family).toBeDefined();
    families.delete(request.requestId);
    await expect(store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    await expect(store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, request.requestId))
      .rejects.toThrow();
    if (family) families.set(request.requestId, family);
    expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
      .toEqual(cohort);
  });

  it("keeps pending and reserved T1 cohorts blocked even when a reserved write later ACKs", async () => {
    for (const mode of ["pending", "reserved"] as const) {
      const source = await throughPlanClaim(mode);
      const { store, tenantId, request, lateAck, planAuth } = source;
      const cohort = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId);
      expect(cohort).toMatchObject({ eligibility: "blocked_source", entryCount: 1 });
      if (lateAck) expect(await lateAck()).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
        .toEqual(cohort);
      await expect(store.sealTenantPurgePlan(planAuth)).rejects.toThrow();
      expect(await store.getTenantPurgePlanReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
        .toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
        .toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
        .toBeNull();
      const planJob = await store.getTenantPurgePlanJob(tenantId, request.requestId);
      expect(planJob?.phase).toBe("queued");
    }
  });

  it("seals real captured source through T3e usage release and T3f canonical closure with historical reads", async () => {
    const usageSource = await throughUsage();
    expect(await usageSource.store.executeTenantPurgeLocalCutover(usageSource.executionAuth))
      .toEqual(usageSource.cutover);
    const source = await claimDatabase(usageSource);
    const { store, tenantId, request, capture, executionAuth, cutover, databaseAuth } = source;
    const usage = await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId);
    const usageEntries = await store.getTenantTelemetryRetainedSourceUsageReleaseEntries(tenantId, request.requestId);
    expect(usageEntries).toHaveLength(1);
    expect(await store.executeTenantDatabasePurge({ ...databaseAuth, tenantId: "different-tenant" }))
      .toBeNull();
    expect(await store.executeTenantDatabasePurge({ ...databaseAuth, requestId: newErasureRequestId() }))
      .toBeNull();
    expect(store.sessions.has(capture.session.id)).toBe(true);
    expect(await store.executeTenantPurgeLocalCutover(executionAuth)).toBeNull();
    expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toEqual(cutover);
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toEqual(usage);
    const terminal = await store.executeTenantDatabasePurge(databaseAuth);
    expect(terminal).toMatchObject({ contentPurgeExecuted: false, allDomainsComplete: false });
    expect(store.sessions.has(capture.session.id)).toBe(false);
    expect(store.items.has(capture.item.id)).toBe(false);
    expect(store.events.has(capture.session.id)).toBe(false);
    const canonical = await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId);
    expect(canonical).toMatchObject({ entryCount: 1, usageReleaseReceiptSha256: usage?.receiptSha256,
      executionReady: false, externalAuthorityVerified: false,
      allDomainsComplete: false, contentPurgeExecuted: false });
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureEntries(tenantId, request.requestId))
      .toHaveLength(1);
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toEqual(usage);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toMatchObject({ entryCount: 1 });
    expect(await store.executeTenantDatabasePurge(databaseAuth)).toEqual(terminal);
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toEqual(canonical);
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt("different-tenant", request.requestId))
      .toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureEntries("different-tenant", request.requestId))
      .toEqual([]);
  });

  it("restores usage, billing and both old/new publication maps when T3e late publication fails", async () => {
    const source = await claimExecution(await throughPlan());
    const { store, tenantId, request, executionAuth } = source;
    const completeBefore = currentCaptureMemorySnapshot(store);
    const originalUsage = structuredClone(store.usageLedger.filter((row) => row.tenantId === tenantId));
    const billingFacts = (store as unknown as { billingUsageFacts: Map<string, unknown> }).billingUsageFacts;
    const originalBillingCount = billingFacts.size;
    const receipts = (store as unknown as {
      retainedSourceUsageReceipts: Map<string, unknown>;
    }).retainedSourceUsageReceipts;
    const originalSet = receipts.set.bind(receipts);
    let failOnce = true;
    Object.defineProperty(receipts, "set", { configurable: true,
      value: (key: string, value: unknown) => {
        if (failOnce) { failOnce = false; throw new Error("injected T3e publication failure"); }
        return originalSet(key, value);
      } });
    await expect(store.executeTenantPurgeLocalCutover(executionAuth))
      .rejects.toThrow("injected T3e publication failure");
    expect(store.usageLedger.filter((row) => row.tenantId === tenantId)).toEqual(originalUsage);
    expect(billingFacts.size).toBe(originalBillingCount);
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
      .toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseEntries(tenantId, request.requestId))
      .toEqual([]);
    expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toBeNull();
    expect(currentCaptureMemorySnapshot(store)).toEqual(completeBefore);
    expect(await store.executeTenantPurgeLocalCutover(executionAuth)).not.toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
      .toMatchObject({ entryCount: 1 });
  });

  it("restores canonical owner, source class, graves and both terminal receipts after T3f failure", async () => {
    const source = await claimDatabase(await throughUsage());
    const { store, tenantId, request, capture, databaseAuth } = source;
    const completeBefore = currentCaptureMemorySnapshot(store);
    const originalSession = structuredClone(store.sessions.get(capture.session.id));
    const originalItem = structuredClone(store.items.get(capture.item.id));
    const originalEvents = structuredClone(store.events.get(capture.session.id));
    const classes = (store as unknown as {
      persistedProviderFailureClasses: Map<string, unknown>;
    }).persistedProviderFailureClasses;
    const originalClass = structuredClone(classes.get(capture.item.id));
    const receipts = (store as unknown as {
      retainedSourceCanonicalReceipts: Map<string, unknown>;
    }).retainedSourceCanonicalReceipts;
    const originalSet = receipts.set.bind(receipts);
    let failOnce = true;
    Object.defineProperty(receipts, "set", { configurable: true,
      value: (key: string, value: unknown) => {
        if (failOnce) { failOnce = false; throw new Error("injected T3f publication failure"); }
        return originalSet(key, value);
      } });
    await expect(store.executeTenantDatabasePurge(databaseAuth))
      .rejects.toThrow("injected T3f publication failure");
    expect(store.sessions.get(capture.session.id)).toEqual(originalSession);
    expect(store.items.get(capture.item.id)).toEqual(originalItem);
    expect(store.events.get(capture.session.id)).toEqual(originalEvents);
    expect(classes.get(capture.item.id)).toEqual(originalClass);
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toBeNull();
    expect(await store.getTenantDatabasePurgeReceipt(tenantId, request.requestId)).toBeNull();
    expect(currentCaptureMemorySnapshot(store)).toEqual(completeBefore);
    expect(await store.executeTenantDatabasePurge(databaseAuth)).not.toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toMatchObject({ entryCount: 1 });
  });

  it("rechecks the independently retained billing fact bytes, usage id and tenant after operational DELETE", async () => {
    const { store, tenantId, request } = await throughUsage();
    const catalog = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
    const facts = (store as unknown as { billingUsageFacts: Map<string, Record<string, unknown>> }).billingUsageFacts;
    const [usageId, fact] = [...facts.entries()][0] ?? [];
    if (!usageId || !fact) throw new Error("missing real retained billing fact");
    for (const replacement of [
      { ...fact, provider: "changed-provider" },
      { ...fact, usageId: `changed-${usageId}` },
      { ...fact, tenantId: "cross-tenant" },
    ]) {
      facts.set(usageId, replacement);
      await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
        .rejects.toThrow();
      facts.set(usageId, fact);
    }
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toEqual(catalog);
  });

  it("rejects a fully re-signed v2 catalog whose owner tuple or manifest differs from raw rows", async () => {
    const { store, tenantId, request } = await throughPlan();
    const planJob = await store.getTenantPurgePlanJob(tenantId, request.requestId);
    const planReceipt = await store.getTenantPurgePlanReceipt(tenantId, request.requestId);
    if (!planJob || !planReceipt) throw new Error("missing real sealed plan");
    const original = (store as unknown as {
      retainedSourceCatalogProof: (...args: unknown[]) => unknown;
    }).retainedSourceCatalogProof(planJob, planReceipt, "live") as {
      receipt: RetainedSource.TenantTelemetryRetainedSourceCatalogReceipt;
      entries: RetainedSource.TenantTelemetryRetainedSourceCatalogEntry[];
      sources: RetainedSource.TenantTelemetryRetainedSourceCatalogSourceEntry[];
      proof: RetainedSource.TenantTelemetryRetainedSourceCatalogProof;
    };
    const [target] = original.entries;
    if (!target || original.entries.length !== 1 || original.sources.length !== 6
      || target.source.kind !== "persisted-provider-v2") {
      throw new Error("missing genuine six-source v2 catalog");
    }
    const maps = store as unknown as {
      retainedSourceCatalogTargets: Map<string, RetainedSource.TenantTelemetryRetainedSourceCatalogEntry>;
      retainedSourceCatalogSources: Map<string, RetainedSource.TenantTelemetryRetainedSourceCatalogSourceEntry>;
      retainedSourceCatalogReceipts: Map<string, RetainedSource.TenantTelemetryRetainedSourceCatalogReceipt>;
    };
    const targetKey = JSON.stringify([request.requestId, target.artifactGroupSha256]);
    const sourceKey = (row: RetainedSource.TenantTelemetryRetainedSourceCatalogSourceEntry) =>
      JSON.stringify([row.requestId, row.sourceKind, row.sourceIdentitySha256]);
    const replaceDigest = (digest: string) => `${digest[0] === "a" ? "b" : "a"}${digest.slice(1)}`;
    for (const field of ["ownerBindingSha256", "manifestSha256"] as const) {
      const { receiptSha256: ignoredTargetHash, ...targetBody } = target;
      void ignoredTargetHash;
      const changed = RetainedSource.buildTenantTelemetryRetainedSourceCatalogEntry({
        ...targetBody, [field]: replaceDigest(target[field]),
      });
      const changedSources = original.sources.map((row) => {
        const { receiptSha256: ignoredSourceHash, ...body } = row;
        void ignoredSourceHash;
        return RetainedSource.buildTenantTelemetryRetainedSourceCatalogSourceEntry({
          ...body, catalogTargetEntryReceiptSha256: changed.receiptSha256,
        });
      });
      const { receiptSha256: ignoredCatalogHash, ...receiptBody } = original.receipt;
      void ignoredCatalogHash;
      const changedEntries = [changed];
      const changedReceipt = RetainedSource.buildTenantTelemetryRetainedSourceCatalogReceipt({
        ...receiptBody,
        entryRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogRootSha256(changedEntries),
        applicationV1RootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogRootSha256(changedEntries, "application-v1"),
        persistedProviderV2RootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogRootSha256(changedEntries, "persisted-provider-v2"),
        logsTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256(
          "logs", RetainedSource.tenantTelemetryRetainedSourceCatalogPlanTargets(changedEntries, "logs"),
        ),
        tracesTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256(
          "traces", RetainedSource.tenantTelemetryRetainedSourceCatalogPlanTargets(changedEntries, "traces"),
        ),
        sourceRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources),
        inventoryRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "inventory"),
        writeJobRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "write_job"),
        writeAckRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "write_ack"),
        membershipRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "membership"),
        applicationBindingRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "application_binding"),
        providerSourceBindingRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "provider_source_binding"),
        providerFailureCommitRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "provider_failure_commit"),
        unknownSourceRootSha256: RetainedSource.tenantTelemetryRetainedSourceCatalogSourceRootSha256(changedSources, "unknown"),
      }, changedEntries, changedSources, original.proof);
      expect(() => RetainedSource.validateTenantTelemetryRetainedSourceCatalogProof(
        changedReceipt, changedEntries, changedSources, original.proof,
      )).not.toThrow();
      try {
        maps.retainedSourceCatalogTargets.set(targetKey, changed);
        for (const row of changedSources) maps.retainedSourceCatalogSources.set(sourceKey(row), row);
        maps.retainedSourceCatalogReceipts.set(request.requestId, changedReceipt);
        await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
          .rejects.toThrow();
      } finally {
        maps.retainedSourceCatalogTargets.set(targetKey, target);
        for (const row of original.sources) maps.retainedSourceCatalogSources.set(sourceKey(row), row);
        maps.retainedSourceCatalogReceipts.set(request.requestId, original.receipt);
      }
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
        .toEqual(original.receipt);
    }
  });

  it("rejects a new same-tenant canonical session ID after T3f instead of checking only old graves", async () => {
    const { store, tenantId, userId, request, databaseAuth } = await claimDatabase(await throughUsage());
    expect(await store.executeTenantDatabasePurge(databaseAuth)).not.toBeNull();
    const canonical = await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId);
    const recreated = mkSession(tenantId, userId);
    store.sessions.set(recreated.id, recreated);
    await expect(store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    store.sessions.delete(recreated.id);
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toEqual(canonical);
  });

  it("does not treat a missing phase receipt as legacy and still audits retained raw source", async () => {
    const source = await claimDatabase(await throughUsage());
    const { store, tenantId, request, capture, committed, databaseAuth } = source;
    const operation = committed.failureCommitReceipt.writeOperationSha256;
    const originalItem = store.items.get(capture.item.id);
    if (!originalItem || originalItem.type !== "agentMessage") throw new Error("missing real failed item");
    store.items.set(originalItem.id, { ...originalItem, text: "tampered after usage release" });
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    store.items.set(originalItem.id, originalItem);
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toMatchObject({ entryCount: 1 });
    const usageReceipts = (store as unknown as {
      retainedSourceUsageReceipts: Map<string, unknown>;
    }).retainedSourceUsageReceipts;
    const usage = usageReceipts.get(request.requestId);
    usageReceipts.delete(request.requestId);
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    if (usage) usageReceipts.set(request.requestId, usage);
    const terminal = await store.executeTenantDatabasePurge(databaseAuth);
    expect(terminal).not.toBeNull();
    const canonicalReceipts = (store as unknown as {
      retainedSourceCanonicalReceipts: Map<string, unknown>;
    }).retainedSourceCanonicalReceipts;
    const canonical = canonicalReceipts.get(request.requestId);
    canonicalReceipts.delete(request.requestId);
    await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    if (canonical) canonicalReceipts.set(request.requestId, canonical);
    const bindings = (store as unknown as {
      persistedProviderCaptureBindings: Map<string, unknown>;
    }).persistedProviderCaptureBindings;
    const binding = bindings.get(operation);
    bindings.delete(operation);
    await expect(store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    if (binding) bindings.set(operation, binding);
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toEqual(canonical);
  });

  it("refuses old T3e APIs when new usage proof or immutable plan family is lost", async () => {
    const { store, tenantId, request, executionAuth, cutover } = await throughUsage();
    const usageReceipts = (store as unknown as {
      retainedSourceUsageReceipts: Map<string, unknown>;
    }).retainedSourceUsageReceipts;
    const planFamilies = (store as unknown as {
      retainedSourcePlanFamilies: Map<string, unknown>;
    }).retainedSourcePlanFamilies;
    const usage = usageReceipts.get(request.requestId);
    const family = planFamilies.get(request.requestId);
    if (!usage || !family) throw new Error("missing genuine retained publication");
    usageReceipts.delete(request.requestId);
    await expect(store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).rejects.toThrow();
    await expect(store.getTenantPurgeExecutionJob(tenantId, request.requestId)).rejects.toThrow();
    await expect(store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).rejects.toThrow();
    expect(await store.getTenantPurgeLocalPhysicalAckReceipt(tenantId, request.requestId)).toBeNull();
    usageReceipts.set(request.requestId, usage);
    planFamilies.delete(request.requestId);
    await expect(store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).rejects.toThrow();
    await expect(store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).rejects.toThrow();
    planFamilies.set(request.requestId, family);
    expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toEqual(cutover);
    expect(await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).not.toBeNull();
  });

  it("does not schedule external deletion or release usage for a genuinely bound Blob target", async () => {
    const source = await claimExecution(await throughPlan(true));
    const { store, tenantId, request, executionAuth } = source;
    const planEntries = await store.getTenantPurgePlanEntries(tenantId, request.requestId, 1);
    expect(planEntries.find((entry) => entry.domain === "blob_bytes")?.targetCount).toBeGreaterThan(0);
    const usageBefore = structuredClone(store.usageLedger.filter((row) => row.tenantId === tenantId));
    const blobOutboxBefore = store.blobDeleteOutbox.size;
    const exportOutboxBefore = store.userDataExportDeleteOutbox.size;
    const billingBefore = store.billingUsageFacts.size;
    await expect(store.executeTenantPurgeLocalCutover(executionAuth)).rejects.toThrow();
    expect(store.usageLedger.filter((row) => row.tenantId === tenantId)).toEqual(usageBefore);
    expect(store.blobDeleteOutbox.size).toBe(blobOutboxBefore);
    expect(store.userDataExportDeleteOutbox.size).toBe(exportOutboxBefore);
    expect(store.billingUsageFacts.size).toBe(billingBefore);
    expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
      .toBeNull();
  });

  it("refuses old T3f replay, getters, grave and T3g source when new closure is lost", async () => {
    const { store, tenantId, request, capture, databaseAuth } = await claimDatabase(await throughUsage());
    const terminal = await store.executeTenantDatabasePurge(databaseAuth);
    expect(terminal).not.toBeNull();
    const canonicalReceipts = (store as unknown as {
      retainedSourceCanonicalReceipts: Map<string, unknown>;
    }).retainedSourceCanonicalReceipts;
    const canonical = canonicalReceipts.get(request.requestId);
    if (!canonical) throw new Error("missing genuine retained canonical publication");
    canonicalReceipts.delete(request.requestId);
    await expect(store.executeTenantDatabasePurge(databaseAuth)).rejects.toThrow();
    await expect(store.getTenantDatabasePurgeJob(tenantId, request.requestId)).rejects.toThrow();
    await expect(store.getTenantDatabasePurgePreDeleteEntries(tenantId, request.requestId, 1))
      .rejects.toThrow();
    await expect(store.getTenantDatabasePurgeDomainAcks(tenantId, request.requestId, 1))
      .rejects.toThrow();
    await expect(store.getTenantDatabasePurgeReceipt(tenantId, request.requestId)).rejects.toThrow();
    await expect(store.getTenantTelemetryOwnerClosureReceipt(tenantId, request.requestId))
      .rejects.toThrow();
    await expect(store.getTenantPurgeSessionGraveMarker(tenantId, capture.session.id))
      .rejects.toThrow();
    await expect(store.materializeTenantRedisPurgeJobs({ limit: 1 })).rejects.toThrow();
    canonicalReceipts.set(request.requestId, canonical);
    expect(await store.executeTenantDatabasePurge(databaseAuth)).toEqual(terminal);
    expect(await store.getTenantPurgeSessionGraveMarker(tenantId, capture.session.id)).not.toBeNull();
    expect(await store.materializeTenantRedisPurgeJobs({ limit: 1 })).toBe(1);
    canonicalReceipts.delete(request.requestId);
    await expect(store.claimTenantRedisPurges({ limit: 1, leaseMs: 60_000,
      claimToken: `retained-redis-${randomUUID()}` })).rejects.toThrow();
    canonicalReceipts.set(request.requestId, canonical);
  });

  it("rolls back T3e and T3f when the final publication advances the clock past the claim lease", async () => {
    const usageSource = await claimExecution(await throughPlan());
    const { store, tenantId, request, capture, executionAuth } = usageSource;
    const clock = (store as unknown as { storeClock: { now: () => number } }).storeClock;
    const originalNow = clock.now;
    const usageReceipts = (store as unknown as {
      retainedSourceUsageReceipts: Map<string, unknown>;
    }).retainedSourceUsageReceipts;
    const originalUsageSet = usageReceipts.set.bind(usageReceipts);
    let jumpOnce = true;
    Object.defineProperty(usageReceipts, "set", { configurable: true,
      value: (key: string, value: unknown) => {
        const result = originalUsageSet(key, value);
        if (jumpOnce) { jumpOnce = false; clock.now = () => Date.now() + 120_000; }
        return result;
      } });
    const originalUsage = structuredClone(store.usageLedger.filter((row) => row.tenantId === tenantId));
    expect(await store.executeTenantPurgeLocalCutover(executionAuth)).toBeNull();
    clock.now = originalNow;
    expect(store.usageLedger.filter((row) => row.tenantId === tenantId)).toEqual(originalUsage);
    expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
      .toBeNull();
    expect(await store.executeTenantPurgeLocalCutover(executionAuth)).not.toBeNull();

    const databaseSource = await claimDatabase({ ...usageSource, cutover: null });
    const databaseAuth = databaseSource.databaseAuth;
    const canonicalReceipts = (store as unknown as {
      retainedSourceCanonicalReceipts: Map<string, unknown>;
    }).retainedSourceCanonicalReceipts;
    const originalCanonicalSet = canonicalReceipts.set.bind(canonicalReceipts);
    jumpOnce = true;
    Object.defineProperty(canonicalReceipts, "set", { configurable: true,
      value: (key: string, value: unknown) => {
        const result = originalCanonicalSet(key, value);
        if (jumpOnce) { jumpOnce = false; clock.now = () => Date.now() + 120_000; }
        return result;
      } });
    expect(await store.executeTenantDatabasePurge(databaseAuth)).toBeNull();
    clock.now = originalNow;
    expect(store.sessions.has(capture.session.id)).toBe(true);
    expect(await store.getTenantDatabasePurgeReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
      .toBeNull();
    expect(await store.executeTenantDatabasePurge(databaseAuth)).not.toBeNull();
  });

  it("rolls back every old and new T3d map if the last catalog publication outlives its lease", async () => {
    const { store, tenantId, request, planAuth } = await throughPlanClaim();
    const clock = (store as unknown as { storeClock: { now: () => number } }).storeClock;
    const originalNow = clock.now;
    const catalogs = (store as unknown as {
      retainedSourceCatalogReceipts: Map<string, unknown>;
    }).retainedSourceCatalogReceipts;
    const originalSet = catalogs.set.bind(catalogs);
    let jumpOnce = true;
    Object.defineProperty(catalogs, "set", { configurable: true,
      value: (key: string, value: unknown) => {
        const result = originalSet(key, value);
        if (jumpOnce) { jumpOnce = false; clock.now = () => Date.now() + 120_000; }
        return result;
      } });
    expect(await store.sealTenantPurgePlan(planAuth)).toBeNull();
    clock.now = originalNow;
    expect(await store.getTenantPurgePlanJob(tenantId, request.requestId))
      .toMatchObject({ phase: "queued" });
    expect(await store.getTenantPurgePlanReceipt(tenantId, request.requestId)).toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
      .toBeNull();
    expect(await store.getTenantTelemetryRetainedSourceCatalogSourceEntries(tenantId, request.requestId))
      .toEqual([]);
    expect(await store.sealTenantPurgePlan(planAuth)).not.toBeNull();
  });
});
