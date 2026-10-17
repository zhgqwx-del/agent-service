import { createHash, randomUUID } from "node:crypto";
import mysql, { type Connection, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Item,
  type Turn,
} from "@agent-service/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  buildTenantTelemetryRetainedSourceCatalogEntry,
  buildTenantTelemetryRetainedSourceCanonicalClosureEntry,
  createTenantTelemetryOwnerClosureReceipt,
  TenantDatabasePurgeEvidenceChangedError,
  TenantTelemetryRetainedSourceIntegrityError,
  TenantPurgeExecutionEvidenceChangedError,
  TenantPurgePlanEvidenceChangedError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantTelemetryCanonicalOwnerProofSha256,
  tenantTelemetryOwnerClosureEntrySha256,
  tenantTelemetryOwnerClosureEntryRootSha256,
  tenantTelemetryOwnerRefSha256,
  tenantTelemetryRetainedSourceCanonicalClosureRootSha256,
  tenantTelemetryRetainedSourceReceiptSha256,
  validateTenantTelemetryRetainedSourceCanonicalClosureProof,
  tenantTelemetryWriteAdapterResult,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantDatabasePurgeAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRuntimeRevocationAuthorization,
  type TenantTelemetryRetainedSourceCatalogEntry,
  type TenantTelemetryRetainedSourceCanonicalProof,
  type TenantTelemetryRetainedSourceCanonicalClosureEntry,
  type TenantTelemetryRetainedSourceUsageProof,
  type TenantTelemetryRetainedSourceUsageReleaseEntry,
  type TenantTelemetryRetainedSourceUsageReleaseReceipt,
} from "../src/index.js";
import { activateCaptureFixture, captureRefKey, captureStepFixture } from "./persisted-provider-capture.fixture.js";
import { newId } from "./conformance.js";

// No .env loading, remote adapter, worker gate, or business database is used here.
// A fixture ACK proves only the local store protocol, never external deletion.
const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const INJECTED_FAILURE = "0054 fixture late rollback";
const RELEASE_TABLES = [
  "tenant_telemetry_retained_source_t1_entries",
  "tenant_telemetry_retained_source_t1_receipts",
  "tenant_telemetry_retained_source_catalog_sources",
  "tenant_telemetry_retained_source_catalog_targets",
  "tenant_telemetry_retained_source_catalog_receipts",
  "tenant_telemetry_retained_source_usage_entries",
  "tenant_telemetry_retained_source_usage_receipts",
  "tenant_telemetry_retained_source_canonical_entries",
  "tenant_telemetry_retained_source_canonical_receipts",
] as const;
const MARKER_UPDATE_TRIGGERS = {
  tenant_erasure_admissions: [
    "trg_tenant_erasure_admissions_bu",
    "trg_tenant_erasure_admissions_bu_guard_a",
    "trg_tenant_erasure_admissions_bu_guard_b",
    "trg_tt_retained_admission_bu",
  ],
  tenant_purge_plan_jobs: [
    "trg_tenant_purge_plan_jobs_bu",
    "trg_tenant_purge_plan_jobs_bu_guard_a",
    "trg_tenant_purge_plan_jobs_bu_guard_b",
    "trg_tt_source_accounting_t3d_terminal_bu",
    "trg_tt_target_manifest_t3d_terminal_bu",
    "trg_tt_plan_artifact_target_t3d_terminal_bu",
    "trg_tt_capture_v2_t3d_bu",
    "trg_tt_retained_plan_bu",
    "trg_skill_registry_t3d_bu",
  ],
} as const;
const EVIDENCE_DELETE_GUARDS = {
  tenant_telemetry_retained_source_catalog_receipts: "trg_tt_retained_catalog_receipts_bd",
  tenant_telemetry_retained_source_catalog_targets: "trg_tt_retained_catalog_targets_bd",
  tenant_telemetry_retained_source_catalog_sources: "trg_tt_retained_catalog_sources_bd",
  tenant_telemetry_retained_source_usage_receipts: "trg_tt_retained_usage_receipts_bd",
  tenant_telemetry_retained_source_canonical_receipts: "trg_tt_retained_canonical_receipts_bd",
} as const;
const CANONICAL_UPDATE_GUARDS = {
  tenant_telemetry_owner_closure_entries: ["trg_tt_owner_closure_entry_bu"],
  tenant_telemetry_owner_closure_receipts: [
    "trg_tt_owner_closure_receipt_bu",
    "trg_tt_source_accounting_owner_closure_receipt_bu",
  ],
  tenant_telemetry_retained_source_canonical_entries: ["trg_tt_retained_canonical_entries_bu"],
  tenant_telemetry_retained_source_canonical_receipts: ["trg_tt_retained_canonical_receipts_bu"],
} as const;

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(name)) {
    throw new Error("MYSQL_TEST_URL must name a local disposable test database");
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0, userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0, idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null, lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000,
  };
}

const authorization = {
  publication(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantRestoreJournalPublications"]>>[number]): TenantRestoreJournalPublicationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, publicationGeneration: claim.publicationGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  credential(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantCredentialRevocations"]>>[number]): TenantCredentialRevocationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  runtime(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantRuntimeRevocations"]>>[number]): TenantRuntimeRevocationAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  inventory(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantContentInventories"]>>[number]): TenantContentInventoryAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  plan(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgePlans"]>>[number]): TenantPurgePlanAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  execution(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgeExecutions"]>>[number]): TenantPurgeExecutionAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, planBuildGeneration: claim.planBuildGeneration,
      executionGeneration: claim.executionGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
  database(claim: Awaited<ReturnType<MysqlSessionStore["claimTenantDatabasePurges"]>>[number]): TenantDatabasePurgeAuthorization {
    return { requestId: claim.requestId, tenantId: claim.tenantId,
      subjectGeneration: claim.subjectGeneration, planBuildGeneration: claim.planBuildGeneration,
      executionGeneration: claim.executionGeneration, databasePurgeGeneration: claim.databasePurgeGeneration,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
  },
};

function fleetProof(source: {
  requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string;
}) {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://retained-mysql-fixture.internal:8080"),
    runnerId: "retained-mysql-fixture-runner", bootId: "retained-mysql-fixture-boot",
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

type Step = Awaited<ReturnType<typeof captureStepFixture>>;
type Fixture = { store: MysqlSessionStore; conn: Connection; tenantId: string; userId: string;
  step: Step; committed: Awaited<ReturnType<MysqlSessionStore["commitPersistedProviderStepFailure"]>>;
  request: { requestId: string; tenantId: string; requestedByKeyId: string;
    idempotencyKey: string; requestHash: string; atMs: number };
  lateAck: (() => Promise<unknown>) | null };

async function publicationAck(store: MysqlSessionStore, requestId: string): Promise<void> {
  const claim = (await store.claimTenantRestoreJournalPublications({
    limit: 10, leaseMs: 120_000, claimToken: `retained-journal-${randomUUID()}`,
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

async function finishFailedTurn(store: MysqlSessionStore, step: Step): Promise<void> {
  const turn: Turn = { ...step.turn, usage: step.batch.turn!.usage, status: "failed",
    completedAtMs: Date.now(), stopReason: "error" };
  const completed = await store.commit({
    sessionId: step.session.id, fence: 1, expectedLastSeq: 4, turn,
    events: [
      { type: "error", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
        code: "provider_error", message: "Provider request failed." },
      { type: "turn/completed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
        turn, stopReason: "error" },
      { type: "session/status/changed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
        status: { type: "idle" } },
    ],
    sessionPatch: { status: { type: "idle" } },
  });
  expect(completed.lastSeq).toBe(7);
}

async function completeOrdinaryTombstoneOutbox(store: MysqlSessionStore, sessionId: string): Promise<void> {
  const outbox = await store.getLifecycleOutbox("session.tombstoned", sessionId, 1);
  if (!outbox) throw new Error("genuine ordinary tombstone outbox is missing");
  const nowMs = Math.max(Date.now(), outbox.availableAtMs ?? 0) + 1;
  const claimToken = `retained-ordinary-outbox-${randomUUID()}`;
  const claimed = await store.claimLifecycleOutbox({
    topics: ["session.tombstoned"], nowMs, limit: 100, leaseMs: 60_000, claimToken,
  });
  const exact = claimed.find((candidate) => candidate.outboxId === outbox.outboxId);
  if (!exact || !await store.completeLifecycleOutbox(exact.outboxId, claimToken, nowMs)) {
    throw new Error("genuine ordinary tombstone outbox could not be completed");
  }
}

async function preparedTenant(store: MysqlSessionStore, conn: Connection,
  mode: "written" | "pending" | "reserved" = "written", withBlob = false): Promise<Fixture> {
  const tenantId = `retained-mysql-${randomUUID()}`;
  const userId = `retained-user-${randomUUID()}`;
  await store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({ tenantId, policyVersion: "retained-zero-day", policy: policy(),
    actorKeyId: "retained-mysql-policy-admin", atMs: Date.now() });
  await store.activateRetentionPolicy({ tenantId, policyVersion: "retained-zero-day",
    expectedControlGeneration: 0, actorKeyId: "retained-mysql-policy-admin", atMs: Date.now() });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  const step = await captureStepFixture(store, { tenantId, userId });
  const committed = await store.commitPersistedProviderStepFailure(step.input);
  expect(committed).toMatchObject({ lastSeq: 4, replayed: false });
  let lateAck: (() => Promise<unknown>) | null = null;
  if (mode !== "pending") {
    const claim = (await store.claimTenantTelemetryWriteJobs({ limit: 10, leaseMs: 120_000,
      claimToken: `retained-write-${randomUUID()}`,
      adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: step.proof,
    })).find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256);
    if (!claim) throw new Error("missing genuine captured writer claim");
    const auth = { tenantId, writeOperationSha256: claim.writeOperationSha256,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
    expect(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", step.proof))
      .not.toBeNull();
    const result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
      writeOperationSha256: claim.writeOperationSha256,
      target: claim.target, inventory: claim.inventory, payload: claim.payload,
    }, "already_present", true);
    lateAck = () => store.completeTenantTelemetryWrite(auth, result, step.proof);
    if (mode === "written") expect(await lateAck()).not.toBeNull();
  }
  await finishFailedTurn(store, step);
  if (withBlob) {
    const blobId = newId("blob");
    const uploadToken = `retained-upload-${randomUUID()}`;
    const createdAtMs = Date.now();
    const owner = { tenantId, userId };
    await store.stageBlob({ owner, sessionId: step.session.id, fence: 1,
      blobId, purpose: "tool_output", storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT, storageKey: `objects/${blobId.slice(5)}`,
      uploadToken, createdAtMs, stagingExpiresAtMs: createdAtMs + 60_000 });
    await store.markBlobUploaded({ owner, sessionId: step.session.id, fence: 1,
      blobId, uploadToken, sha256: "a".repeat(64), sizeBytes: 128,
      contentType: "application/json", uploadedAtMs: createdAtMs + 1 });
    const item: Item = { id: newId("item"), sessionId: step.session.id,
      turnId: step.turn.id, seq: 0, status: "completed", createdAtMs,
      completedAtMs: createdAtMs + 1, type: "toolResult",
      toolCallId: "retained-blob-call", name: "retained-blob",
      content: [{ type: "text", text: "stored externally" }],
      isError: false, outputRef: blobId };
    await store.commit({ sessionId: step.session.id, fence: 1,
      items: [item], blobBindings: [{ blobId, itemId: item.id, purpose: "tool_output" }],
      events: [{ type: "item/completed", sessionId: step.session.id,
        emittedAtMs: createdAtMs + 1, item }] });
    expect(await store.getBlobManifest(blobId)).toMatchObject({ state: "ready" });
  }
  const request = { requestId: newErasureRequestId(), tenantId,
    requestedByKeyId: "retained-mysql-admin", idempotencyKey: `retained-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() };
  return { store, conn, tenantId, userId, step, committed, request, lateAck };
}

async function capturedTenant(store: MysqlSessionStore, conn: Connection,
  mode: "written" | "pending" | "reserved" = "written", withBlob = false): Promise<Fixture> {
  const prepared = await preparedTenant(store, conn, mode, withBlob);
  const { request, tenantId } = prepared;
  await store.requestTenantErasure(request);
  expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
    .toMatchObject({ eligibility: mode === "written" ? "eligible_retained" : "blocked_source",
      entryCount: 1, writtenAckCount: mode === "written" ? 1 : 0 });
  await publicationAck(store, request.requestId);
  return prepared;
}

async function preparedTenantWithReadyExport(store: MysqlSessionStore, conn: Connection): Promise<Fixture> {
  const prepared = await preparedTenant(store, conn);
  const { tenantId, userId, request } = prepared;
  const exportRequestId = newUserDataExportRequestId();
  await store.requestUserDataExport({
    requestId: exportRequestId, tenantId, userId,
    requestedByKeyId: "retained-mysql-export-admin",
    idempotencyKeySha256: userDataExportIdempotencyKeySha256(`retained-export-${randomUUID()}`),
    requestHash: userDataExportRequestHash(tenantId, userId),
  });
  const claim = (await store.claimUserDataExports({
    limit: 10, leaseMs: 120_000, claimToken: `retained-export-${randomUUID()}`,
  })).find((row) => row.requestId === exportRequestId);
  if (!claim) throw new Error("missing genuine export claim");
  const auth = userDataExportAuthorization(claim);
  const summary = await store.captureAndSealUserDataExportSnapshot(auth);
  const artifactId = newUserDataExportArtifactId();
  await store.startUserDataExportArtifact(auth, {
    artifactId, storageBackend: "memory-v1", storageFormat: BLOB_STORAGE_FORMAT,
    stagingTtlMs: 60_000,
  });
  const storageKey = userDataExportStorageKey({ tenantId, userId }, exportRequestId, artifactId, 0);
  await store.stageUserDataExportPart(auth, {
    artifactId, partNumber: 0, storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT, storageKey, uploadToken: `upload-${randomUUID()}`,
  });
  const bytes = Buffer.from("retained-source export fixture\n", "utf8");
  const part = await store.markUserDataExportPartUploaded(auth, {
    artifactId, partNumber: 0,
    descriptor: { storageKey, sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength, contentType: USER_DATA_EXPORT_CONTENT_TYPE },
  });
  expect(await store.completeUserDataExportArtifact(auth, {
    artifactId, snapshotAtMs: summary.snapshotAtMs, partCount: 1,
    recordCount: summary.recordCount, totalSizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: userDataExportManifestSha256([part]),
  })).not.toBeNull();
  await store.requestTenantErasure(request);
  await publicationAck(store, request.requestId);
  return prepared;
}

async function throughPlanClaim(source: Fixture, leaseMs = 120_000) {
  const { store, request } = source;
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `retained-credential-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!credential) throw new Error("missing T3a claim");
  expect(await store.revokeTenantCredentialMaterial(authorization.credential(credential))).not.toBeNull();
  expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `retained-runtime-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!runtime) throw new Error("missing T3b claim");
  expect(await store.completeTenantRuntimeRevocation(authorization.runtime(runtime), fleetProof(runtime)))
    .not.toBeNull();
  expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
  const inventory = (await store.claimTenantContentInventories({
    limit: 10, leaseMs: 120_000, claimToken: `retained-inventory-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!inventory) throw new Error("missing T3c claim");
  const inventoryAuth = authorization.inventory(inventory);
  let done = false;
  while (!done) done = (await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 })).done;
  expect(await store.sealTenantContentInventory(inventoryAuth)).not.toBeNull();
  expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
  const plan = (await store.claimTenantPurgePlans({
    limit: 10, leaseMs, claimToken: `retained-plan-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!plan) throw new Error("missing T3d claim");
  return { ...source, planAuth: authorization.plan(plan) };
}

async function throughPlan(source: Fixture) {
  const claimed = await throughPlanClaim(source);
  // Existing MySQL T3d contract uses a DB millisecond floor after materialization.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(await claimed.store.sealTenantPurgePlan(claimed.planAuth)).not.toBeNull();
  expect(await claimed.store.getTenantTelemetryRetainedSourceCatalogReceipt(
    claimed.tenantId, claimed.request.requestId,
  )).toMatchObject({ sourceCount: 6, entryCount: 1, persistedProviderV2Count: 1,
    applicationV1Count: 0, unknownGroupCount: 0 });
  return claimed;
}

async function claimExecution(source: Awaited<ReturnType<typeof throughPlan>>, leaseMs = 120_000) {
  const { store, request } = source;
  expect(await store.materializeTenantPurgeExecutionJobs({ limit: 10 })).toBe(1);
  const claim = (await store.claimTenantPurgeExecutions({
    limit: 10, leaseMs, claimToken: `retained-execution-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!claim) throw new Error("missing T3e claim");
  return { ...source, executionAuth: authorization.execution(claim) };
}

async function throughUsage(source: Fixture, planned?: Awaited<ReturnType<typeof throughPlan>>) {
  const claimed = await claimExecution(planned ?? await throughPlan(source));
  const cutover = await claimed.store.executeTenantPurgeLocalCutover(claimed.executionAuth);
  expect(cutover).not.toBeNull();
  expect(await count(claimed.conn, "usage_ledger", "tenant_id", claimed.tenantId)).toBe(0);
  expect(await claimed.store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
    claimed.tenantId, claimed.request.requestId,
  )).toMatchObject({ entryCount: 1, retainedBillingFactCount: 1,
    executionReady: false, allDomainsComplete: false, contentPurgeExecuted: false });
  return { ...claimed, cutover };
}

async function claimDatabase(source: Awaited<ReturnType<typeof throughUsage>>, leaseMs = 120_000) {
  const { store, request } = source;
  expect(await store.sealTenantPurgeLocalPhysicalAcks(source.executionAuth)).not.toBeNull();
  expect(await store.materializeTenantDatabasePurgeJobs({ limit: 10 })).toBe(1);
  const claim = (await store.claimTenantDatabasePurges({
    limit: 10, leaseMs, claimToken: `retained-database-${randomUUID()}`,
  })).find((row) => row.requestId === request.requestId);
  if (!claim) throw new Error("missing T3f claim");
  return { ...source, databaseAuth: authorization.database(claim) };
}

async function count(conn: Connection, table: string, column: string, value: string): Promise<number> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column)) {
    throw new Error("unsafe fixture SQL identifier");
  }
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${column}\`=?`, [value],
  );
  return Number(rows[0]?.count);
}

async function outboxCounts(conn: Connection): Promise<{ blob: number; exportArtifact: number }> {
  const [blob] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM blob_delete_outbox");
  const [exportArtifact] = await conn.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM user_export_artifact_delete_outbox",
  );
  return { blob: Number(blob[0]?.count), exportArtifact: Number(exportArtifact[0]?.count) };
}

// Hash every actual base-table row in this one-test database. Assertion failures show
// only hashes, never model content, credential material, or test DB connection URLs.
async function databaseRowsSha256(conn: Connection): Promise<string> {
  const [tables] = await conn.query<RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
  );
  const hash = createHash("sha256");
  for (const table of tables) {
    const name = String(table.name);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error("unsafe fixture table name");
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM \`${name}\``);
    hash.update(name).update("\0");
    for (const row of rows.map((value) => JSON.stringify(value)).sort()) hash.update(row).update("\0");
  }
  return hash.digest("hex");
}

async function withLateReceiptFailure(conn: Connection, table: string,
  action: () => Promise<unknown>): Promise<void> {
  if (!RELEASE_TABLES.includes(table as typeof RELEASE_TABLES[number])) {
    throw new Error("not a retained-source fixture table");
  }
  const trigger = `fixture_0054_fail_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='${INJECTED_FAILURE}'`);
  try {
    await expect(action()).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: INJECTED_FAILURE });
  } finally {
    await conn.query(`DROP TRIGGER \`${trigger}\``);
  }
}

type LateReceiptOutcome = { state: "fulfilled"; value: unknown } | { state: "rejected"; error: unknown };
async function withLateReceiptSleep(conn: Connection, database: string, table: string,
  action: () => Promise<unknown>): Promise<{ outcome: LateReceiptOutcome; elapsedMs: number; reached: boolean }> {
  if (!RELEASE_TABLES.includes(table as typeof RELEASE_TABLES[number])) {
    throw new Error("not a retained-source fixture table");
  }
  if (!/^agent_service_retained_test_[0-9]+_[a-f0-9]{12}$/.test(database)) {
    throw new Error("unsafe late-receipt fixture database name");
  }
  const [context] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS activeDb");
  if (context[0]?.activeDb !== database) {
    throw new Error("late-receipt probe must use its own exact isolated database");
  }
  // This test-only MEMORY row survives the writer's InnoDB rollback and is read
  // from a different connection. It proves the exact final INSERT was reached;
  // it is removed before the business-table rollback hash is compared.
  const probe = "fixture_0054_late_receipt_probe";
  const token = randomUUID().replaceAll("-", "");
  const trigger = `fixture_0054_sleep_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await conn.query(`CREATE TABLE \`${probe}\` (token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY) ENGINE=MEMORY`);
  let triggerCreated = false;
  try {
    await conn.query(`CREATE TRIGGER \`${trigger}\` BEFORE INSERT ON \`${table}\` FOR EACH ROW BEGIN
      INSERT INTO \`${probe}\` (token) VALUES ('${token}');
      DO SLEEP(3.2);
    END`);
    triggerCreated = true;
    const start = Date.now();
    let outcome: LateReceiptOutcome;
    try { outcome = { state: "fulfilled", value: await action() }; }
    catch (error) { outcome = { state: "rejected", error }; }
    const elapsedMs = Date.now() - start;
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT token FROM \`${probe}\` WHERE token=?`, [token]);
    return { outcome, elapsedMs, reached: rows.length === 1 };
  } finally {
    try { if (triggerCreated) await conn.query(`DROP TRIGGER \`${trigger}\``); }
    finally { await conn.query(`DROP TABLE \`${probe}\``); }
  }
}

type MarkerTable = keyof typeof MARKER_UPDATE_TRIGGERS;
async function markerUpdateTriggerFingerprint(conn: Connection, table: MarkerTable) {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT TRIGGER_NAME AS name,ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,
            SQL_MODE AS sqlMode,DEFINER AS definer
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?
        AND ACTION_TIMING='BEFORE' AND EVENT_MANIPULATION='UPDATE'
      ORDER BY ACTION_ORDER`, [table],
  );
  const names = rows.map((row) => String(row.name));
  expect([...names].sort()).toEqual([...MARKER_UPDATE_TRIGGERS[table]].sort());
  const fingerprint = createHash("sha256").update(JSON.stringify(rows.map((row) => ({
    name: row.name, actionOrder: row.actionOrder, body: row.body,
    sqlMode: row.sqlMode, definer: row.definer,
  })))).digest("hex");
  return { rows, fingerprint };
}

async function withOnlyIsolatedMarkerUpdateGuardsRemoved(
  conn: Connection, database: string, table: MarkerTable, action: () => Promise<void>,
): Promise<void> {
  if (!/^agent_service_retained_test_[0-9]+_[a-f0-9]{12}$/.test(database)) {
    throw new Error("unsafe marker-corruption fixture database name");
  }
  const [context] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS activeDb,@@SESSION.sql_mode AS sqlMode");
  if (context[0]?.activeDb !== database || typeof context[0]?.sqlMode !== "string") {
    throw new Error("marker-corruption fixture must use its own exact isolated database");
  }
  const originalMode = context[0].sqlMode as string;
  const before = await markerUpdateTriggerFingerprint(conn, table);
  const originals: { name: string; order: number; createSql: string; sqlMode: string }[] = [];
  for (const row of before.rows) {
    const name = String(row.name);
    const [definition] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${name}\``);
    const createSql = definition[0]?.["SQL Original Statement"];
    const sqlMode = definition[0]?.sql_mode;
    if (typeof createSql !== "string" || typeof sqlMode !== "string"
      || !createSql.includes(name)) {
      throw new Error("could not bind exact marker guard definition");
    }
    originals.push({ name, order: Number(row.actionOrder), createSql, sqlMode });
  }
  const dropped: typeof originals = [];
  try {
    for (const original of [...originals].reverse()) {
      await conn.query(`DROP TRIGGER \`${original.name}\``);
      dropped.push(original);
    }
    await action();
  } finally {
    try {
      for (const original of [...dropped].sort((a, b) => a.order - b.order)) {
        await conn.query("SET SESSION sql_mode=?", [original.sqlMode]);
        await conn.query(original.createSql);
      }
    } finally {
      await conn.query("SET SESSION sql_mode=?", [originalMode]);
    }
  }
  const after = await markerUpdateTriggerFingerprint(conn, table);
  expect(after.fingerprint).toBe(before.fingerprint);
}

type EvidenceDeleteTable = keyof typeof EVIDENCE_DELETE_GUARDS;
async function withOnlyIsolatedEvidenceDeleteGuardRemoved(
  conn: Connection, database: string, table: EvidenceDeleteTable, action: () => Promise<void>,
): Promise<void> {
  if (!/^agent_service_retained_test_[0-9]+_[a-f0-9]{12}$/.test(database)) {
    throw new Error("unsafe catalog-corruption fixture database name");
  }
  const [context] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS activeDb,@@SESSION.sql_mode AS sqlMode");
  if (context[0]?.activeDb !== database || typeof context[0]?.sqlMode !== "string") {
    throw new Error("catalog-corruption fixture must use its own exact isolated database");
  }
  const originalMode = context[0].sqlMode as string;
  const query = `SELECT TRIGGER_NAME AS name,ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,
                        SQL_MODE AS sqlMode,DEFINER AS definer
                   FROM information_schema.TRIGGERS
                  WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?
                    AND ACTION_TIMING='BEFORE' AND EVENT_MANIPULATION='DELETE'
                  ORDER BY ACTION_ORDER`;
  const [before] = await conn.query<RowDataPacket[]>(query, [table]);
  const guard = EVIDENCE_DELETE_GUARDS[table];
  expect(before.map((row) => row.name)).toEqual([guard]);
  const fingerprint = createHash("sha256").update(JSON.stringify(before.map((row) => ({
    name: row.name, actionOrder: row.actionOrder, body: row.body,
    sqlMode: row.sqlMode, definer: row.definer,
  })))).digest("hex");
  const [definition] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${guard}\``);
  const createSql = definition[0]?.["SQL Original Statement"];
  const sqlMode = definition[0]?.sql_mode;
  if (typeof createSql !== "string" || typeof sqlMode !== "string" || !createSql.includes(guard)) {
    throw new Error("could not bind exact catalog guard definition");
  }
  await conn.query(`DROP TRIGGER \`${guard}\``);
  try {
    await action();
  } finally {
    try {
      await conn.query("SET SESSION sql_mode=?", [sqlMode]);
      await conn.query(createSql);
    } finally {
      await conn.query("SET SESSION sql_mode=?", [originalMode]);
    }
  }
  const [after] = await conn.query<RowDataPacket[]>(query, [table]);
  expect(createHash("sha256").update(JSON.stringify(after.map((row) => ({
    name: row.name, actionOrder: row.actionOrder, body: row.body,
    sqlMode: row.sqlMode, definer: row.definer,
  })))).digest("hex")).toBe(fingerprint);
}

// A privileged corruption fixture, never an application write path. Only the five exact
// immutable UPDATE guards on these four tables in this newly-created test database are removed, and their
// original definitions, SQL modes, definers and action orders are checked after restoration.
async function withOnlyIsolatedCanonicalUpdateGuardsRemoved(
  conn: Connection, database: string, action: () => Promise<void>,
): Promise<void> {
  if (!/^agent_service_retained_test_[0-9]+_[a-f0-9]{12}$/.test(database)) {
    throw new Error("unsafe canonical-corruption fixture database name");
  }
  const [context] = await conn.query<RowDataPacket[]>("SELECT DATABASE() AS activeDb,@@SESSION.sql_mode AS sqlMode");
  if (context[0]?.activeDb !== database || typeof context[0]?.sqlMode !== "string") {
    throw new Error("canonical-corruption fixture must use its own exact isolated database");
  }
  const originalMode = context[0].sqlMode as string;
  const originals: Array<{ table: keyof typeof CANONICAL_UPDATE_GUARDS; name: string;
    order: number; createSql: string; sqlMode: string }> = [];
  const fingerprints: string[] = [];
  const query = `SELECT TRIGGER_NAME AS name,ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,
                        SQL_MODE AS sqlMode,DEFINER AS definer
                   FROM information_schema.TRIGGERS
                  WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?
                    AND ACTION_TIMING='BEFORE' AND EVENT_MANIPULATION='UPDATE'
                  ORDER BY ACTION_ORDER`;
  const fingerprint = (rows: readonly RowDataPacket[]) => createHash("sha256")
    .update(JSON.stringify(rows.map((row) => ({ name: row.name, actionOrder: row.actionOrder,
      body: row.body, sqlMode: row.sqlMode, definer: row.definer })))).digest("hex");
  for (const table of Object.keys(CANONICAL_UPDATE_GUARDS) as Array<keyof typeof CANONICAL_UPDATE_GUARDS>) {
    const [rows] = await conn.query<RowDataPacket[]>(query, [table]);
    const names: readonly string[] = CANONICAL_UPDATE_GUARDS[table];
    expect(rows.map((row) => row.name)).toEqual(names);
    fingerprints.push(fingerprint(rows));
    for (const row of rows) {
      const name = String(row.name);
      const [definition] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${name}\``);
      const createSql = definition[0]?.["SQL Original Statement"];
      const sqlMode = definition[0]?.sql_mode;
      if (typeof createSql !== "string" || typeof sqlMode !== "string"
        || !createSql.includes(name)) throw new Error("could not bind exact canonical guard definition");
      originals.push({ table, name, order: Number(row.actionOrder), createSql, sqlMode });
    }
  }
  const dropped: typeof originals = [];
  let failure: unknown;
  try {
    for (const original of [...originals].reverse()) {
      await conn.query(`DROP TRIGGER \`${original.name}\``);
      dropped.push(original);
    }
    await action();
  } catch (error) {
    failure = error;
  } finally {
    let restoreFailure: unknown;
    try {
      // Dropped in reverse original order, so reverse again to restore each
      // table's PRECEDES/FOLLOWS action order without inventing a new order.
      for (const original of [...dropped].reverse()) {
        try {
          await conn.query("SET SESSION sql_mode=?", [original.sqlMode]);
          await conn.query(original.createSql);
        } catch (error) {
          restoreFailure ??= error;
        }
      }
    } finally {
      try { await conn.query("SET SESSION sql_mode=?", [originalMode]); }
      catch (error) { restoreFailure ??= error; }
    }
    if (restoreFailure) failure = failure ? new AggregateError([failure, restoreFailure],
      "canonical fixture action and guard restoration failed") : restoreFailure;
  }
  for (const [index, table] of (Object.keys(CANONICAL_UPDATE_GUARDS) as Array<keyof typeof CANONICAL_UPDATE_GUARDS>).entries()) {
    const [rows] = await conn.query<RowDataPacket[]>(query, [table]);
    const names: readonly string[] = CANONICAL_UPDATE_GUARDS[table];
    expect(rows.map((row) => row.name)).toEqual(names);
    expect(fingerprint(rows)).toBe(fingerprints[index]);
  }
  if (failure) throw failure;
}

// Pause precisely after the reader's RR snapshot START has completed, before its
// first evidence query. A separate store/pool then commits the whole writer
// boundary. The timeout is only a deadlock watchdog; it does not create the race.
async function readAcrossCommittedBoundary<T>(
  readerStore: MysqlSessionStore, read: () => Promise<T>, write: () => Promise<unknown>,
): Promise<{ readResult: T; writeResult: unknown }> {
  const pool = (readerStore as unknown as { pool: { getConnection: () => Promise<PoolConnection> } }).pool;
  const originalGetConnection = pool.getConnection;
  const getConnection = originalGetConnection.bind(pool);
  let startedResolve!: () => void;
  let resumeResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
  let intercepted = false;
  let restoreQuery: (() => void) | undefined;
  pool.getConnection = async () => {
    const connection = await getConnection();
    if (intercepted) return connection;
    intercepted = true;
    const surface = connection as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = surface.query;
    surface.query = async (...args: unknown[]) => {
      const result = await originalQuery.apply(connection, args);
      if (args[0] === "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY") {
        startedResolve();
        await resume;
      }
      return result;
    };
    restoreQuery = () => { surface.query = originalQuery; };
    return connection;
  };
  const observed = read().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      started.then(() => "started" as const),
      observed.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => { watchdog = setTimeout(() => resolve("timeout"), 15_000); }),
    ]);
    if (ready !== "started") throw new Error(`reader failed to reach RR START barrier (${ready})`);
    const writeResult = await write();
    resumeResolve();
    const outcome = await observed;
    if (!outcome.ok) throw outcome.error;
    return { readResult: outcome.value, writeResult };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    resumeResolve();
    await observed;
    restoreQuery?.();
    pool.getConnection = originalGetConnection;
    expect(intercepted).toBe(true);
  }
}

type UsageReceiptTimeRelations = {
  ackExactOne: boolean;
  cutoverExactOne: boolean;
  leafExactOne: boolean;
  ackNotAfterCutover: boolean;
  ackEqualsCutover: boolean;
  cutoverEqualsNewReceipt: boolean;
  leafNotAfterAck: boolean;
};

// Observe the uncommitted T3e publication on the writer's own connection.
// This never rewrites the INSERT or suppresses its original SQL error.
async function withUsageReceiptTimeProbe<T>(store: MysqlSessionStore, independentConn: Connection,
  tenantId: string, requestId: string, action: () => Promise<T>): Promise<T> {
  const pool = (store as unknown as { pool: { getConnection: () => Promise<PoolConnection> } }).pool;
  const originalGetConnection = pool.getConnection;
  const getConnection = originalGetConnection.bind(pool);
  const originalQueries = new Map<PoolConnection, (...args: unknown[]) => Promise<unknown>>();
  let hits = 0;
  let readFailed = false;
  let relations: UsageReceiptTimeRelations | null = null;
  let rollback: { ledgerRetained: boolean; oldCutoverAbsent: boolean;
    newUsageAbsent: boolean; executionQueued: boolean } | null = null;
  pool.getConnection = async () => {
    const connection = await getConnection();
    if (originalQueries.has(connection)) return connection;
    const surface = connection as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = surface.query;
    originalQueries.set(connection, originalQuery);
    surface.query = async (...args: unknown[]) => {
      if (typeof args[0] === "string"
        && /^\s*INSERT INTO tenant_telemetry_retained_source_usage_receipts\s*\(/.test(args[0])) {
        hits++;
        try {
          const values = args[1];
          const receiptJson = Array.isArray(values) ? values.at(-1) : undefined;
          if (typeof receiptJson !== "string") {
            throw new Error("usage receipt INSERT parameters are not a closed fixture shape");
          }
          const receipt = JSON.parse(receiptJson) as Record<string, unknown>;
          if (typeof receipt.requestId !== "string"
            || typeof receipt.storeDbTimestampMs !== "number"
            || !Number.isSafeInteger(receipt.storeDbTimestampMs)) {
            throw new Error("usage receipt JSON lacks its closed time identity");
          }
          const [rows] = await originalQuery.call(connection,
            `WITH old_ack AS (
               SELECT store_db_timestamp_ms FROM tenant_purge_execution_domain_acks
                WHERE BINARY request_id=BINARY ? AND domain='operational_usage'
             ), old_cutover AS (
               SELECT store_db_timestamp_ms FROM tenant_purge_local_cutover_receipts
                WHERE BINARY request_id=BINARY ?
             ), new_leaf AS (
               SELECT released_at_db_ms FROM tenant_telemetry_retained_source_usage_entries
                WHERE BINARY request_id=BINARY ?
             )
             SELECT
               IF((SELECT COUNT(*) FROM old_ack)=1,1,0) AS ackExactOne,
               IF((SELECT COUNT(*) FROM old_cutover)=1,1,0) AS cutoverExactOne,
               IF((SELECT COUNT(*) FROM new_leaf)=1,1,0) AS leafExactOne,
               IF((SELECT store_db_timestamp_ms FROM old_ack LIMIT 1)
                    <=(SELECT store_db_timestamp_ms FROM old_cutover LIMIT 1),1,0)
                    AS ackNotAfterCutover,
               IF((SELECT store_db_timestamp_ms FROM old_ack LIMIT 1)
                    =(SELECT store_db_timestamp_ms FROM old_cutover LIMIT 1),1,0)
                    AS ackEqualsCutover,
               IF((SELECT store_db_timestamp_ms FROM old_cutover LIMIT 1)=?,1,0)
                    AS cutoverEqualsNewReceipt,
               IF((SELECT released_at_db_ms FROM new_leaf LIMIT 1)
                    <=(SELECT store_db_timestamp_ms FROM old_ack LIMIT 1),1,0)
                    AS leafNotAfterAck`,
            [receipt.requestId, receipt.requestId, receipt.requestId, receipt.storeDbTimestampMs],
          ) as [RowDataPacket[], unknown];
          const row = rows[0];
          if (rows.length !== 1 || !row) throw new Error("usage time relation query lacked one row");
          relations = {
            ackExactOne: row.ackExactOne === 1,
            cutoverExactOne: row.cutoverExactOne === 1,
            leafExactOne: row.leafExactOne === 1,
            ackNotAfterCutover: row.ackNotAfterCutover === 1,
            ackEqualsCutover: row.ackEqualsCutover === 1,
            cutoverEqualsNewReceipt: row.cutoverEqualsNewReceipt === 1,
            leafNotAfterAck: row.leafNotAfterAck === 1,
          };
        } catch {
          // Diagnostic failure must not alter the product INSERT or its error.
          readFailed = true;
        }
      }
      return originalQuery.apply(connection, args);
    };
    return connection;
  };
  try {
    let result: T;
    try {
      result = await action();
    } catch (originalError) {
      // The store rolls its transaction back before returning an error. Read
      // its durable result through a separate autocommit connection.
      try {
        const [rows] = await independentConn.query<RowDataPacket[]>(
          `SELECT
             IF((SELECT COUNT(*) FROM usage_ledger WHERE BINARY tenant_id=BINARY ?)=1,1,0)
               AS ledgerRetained,
             IF((SELECT COUNT(*) FROM tenant_purge_local_cutover_receipts
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS oldCutoverAbsent,
             IF((SELECT COUNT(*) FROM tenant_telemetry_retained_source_usage_receipts
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS newUsageAbsent,
             IF((SELECT COUNT(*) FROM tenant_purge_execution_jobs
                  WHERE BINARY request_id=BINARY ? AND phase='queued')=1,1,0)
               AS executionQueued`,
          [tenantId, requestId, requestId, requestId],
        );
        const row = rows[0];
        if (rows.length !== 1 || !row) throw new Error("usage rollback relation query lacked one row");
        rollback = {
          ledgerRetained: row.ledgerRetained === 1,
          oldCutoverAbsent: row.oldCutoverAbsent === 1,
          newUsageAbsent: row.newUsageAbsent === 1,
          executionQueued: row.executionQueued === 1,
        };
        expect(hits).toBe(1);
        expect(readFailed).toBe(false);
        expect(relations).not.toBeNull();
        expect(rollback).toEqual({ ledgerRetained: true, oldCutoverAbsent: true,
          newUsageAbsent: true, executionQueued: true });
      } catch (probeError) {
        throw new AggregateError([originalError, probeError],
          "usage receipt failed and its same-connection diagnostic was incomplete");
      }
      throw originalError;
    }
    expect(hits).toBe(1);
    expect(readFailed).toBe(false);
    expect(relations).not.toBeNull();
    expect(relations).toMatchObject({ ackExactOne: true, cutoverExactOne: true,
      leafExactOne: true, ackNotAfterCutover: true,
      cutoverEqualsNewReceipt: true, leafNotAfterAck: true });
    return result;
  } finally {
    for (const [connection, originalQuery] of originalQueries) {
      (connection as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = originalQuery;
    }
    pool.getConnection = originalGetConnection;
    console.log(JSON.stringify({ probe: "0054-usage-receipt-time", hitExactlyOnce: hits === 1,
      readFailed, ...(relations ?? {}), ...(rollback ?? {}) }));
  }
}

type CanonicalEntryBirthRelations = {
  sourceExactOne: boolean;
  liveSourceGenerationZeroAndUndeleted: boolean;
  graveGenerationOneAndDeletedAtPublication: boolean;
  oldGenerationEqualsGrave: boolean;
  oldDeletedAtEqualsGraveIsTrue: boolean;
  publishedTwoBranchTransformValid: boolean;
};

// Observe the live source and newly staged grave before the first canonical
// entry INSERT, on the writer's connection. The wrapper leaves that INSERT
// and any original SQL error completely untouched.
async function withCanonicalEntryBirthProbe<T>(store: MysqlSessionStore,
  independentConn: Connection, tenantId: string, requestId: string, sessionId: string,
  action: () => Promise<T>): Promise<T> {
  const pool = (store as unknown as { pool: { getConnection: () => Promise<PoolConnection> } }).pool;
  const originalGetConnection = pool.getConnection;
  const getConnection = originalGetConnection.bind(pool);
  const originalQueries = new Map<PoolConnection, (...args: unknown[]) => Promise<unknown>>();
  let hits = 0;
  let readFailed = false;
  let relations: CanonicalEntryBirthRelations | null = null;
  let rollback: { sessionRetained: boolean; newLeafAbsent: boolean;
    oldT3fAbsent: boolean; newAggregateAbsent: boolean; ownerAggregateAbsent: boolean;
    graveAbsent: boolean; databaseJobQueued: boolean } | null = null;
  pool.getConnection = async () => {
    const connection = await getConnection();
    if (originalQueries.has(connection)) return connection;
    const surface = connection as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = surface.query;
    originalQueries.set(connection, originalQuery);
    surface.query = async (...args: unknown[]) => {
      if (typeof args[0] === "string"
        && /^\s*INSERT INTO tenant_telemetry_retained_source_canonical_entries\s*\(/.test(args[0])) {
        hits++;
        try {
          const values = args[1];
          const receiptJson = Array.isArray(values) ? values.at(-1) : undefined;
          if (typeof receiptJson !== "string") {
            throw new Error("canonical entry INSERT parameters are not a closed fixture shape");
          }
          const entry = JSON.parse(receiptJson) as Record<string, unknown>;
          if (typeof entry.requestId !== "string"
            || typeof entry.sessionGraveMarkerSha256 !== "string"
            || !/^[0-9a-f]{64}$/.test(entry.sessionGraveMarkerSha256)
            || typeof entry.capturedAtDbMs !== "number"
            || !Number.isSafeInteger(entry.capturedAtDbMs)) {
            throw new Error("canonical entry JSON lacks its closed grave identity");
          }
          const [rows] = await originalQuery.call(connection,
            `SELECT
               IF(COUNT(*)=1,1,0) AS sourceExactOne,
               IF(COUNT(*)=1 AND MIN(s.deletion_generation)=0
                    AND SUM(s.deleted_at_ms IS NULL)=1,1,0)
                    AS liveSourceGenerationZeroAndUndeleted,
               IF(COUNT(*)=1 AND MIN(g.deletion_generation)=1
                    AND MIN(g.deleted_at_db_ms)=? AND MIN(g.marked_at_db_ms)=?,1,0)
                    AS graveGenerationOneAndDeletedAtPublication,
               IF(COUNT(*)=1 AND MIN(s.deletion_generation)=MIN(g.deletion_generation),1,0)
                    AS oldGenerationEqualsGrave,
               IF(COUNT(*)=1 AND (MIN(s.deleted_at_ms)=MIN(g.deleted_at_db_ms)) IS TRUE,1,0)
                    AS oldDeletedAtEqualsGraveIsTrue,
               IF(COUNT(*)=1 AND MIN(IF(
                    g.deletion_generation=IF(s.deletion_generation=0,1,s.deletion_generation)
                    AND g.deleted_at_db_ms=COALESCE(s.deleted_at_ms,g.marked_at_db_ms)
                    AND g.marked_at_db_ms=?
                    AND ((s.deletion_generation=0 AND s.deleted_at_ms IS NULL)
                      OR (s.deletion_generation>0 AND s.deleted_at_ms IS NOT NULL)),1,0))=1,1,0)
                    AS publishedTwoBranchTransformValid
             FROM tenant_purge_session_grave_markers g
             JOIN sessions s ON BINARY s.session_id=BINARY g.session_id
             WHERE BINARY g.request_id=BINARY ? AND BINARY g.marker_sha256=BINARY ?`,
            [entry.capturedAtDbMs, entry.capturedAtDbMs, entry.capturedAtDbMs,
              entry.requestId, entry.sessionGraveMarkerSha256],
          ) as [RowDataPacket[], unknown];
          const row = rows[0];
          if (rows.length !== 1 || !row) throw new Error("canonical birth relation query lacked one row");
          relations = {
            sourceExactOne: row.sourceExactOne === 1,
            liveSourceGenerationZeroAndUndeleted: row.liveSourceGenerationZeroAndUndeleted === 1,
            graveGenerationOneAndDeletedAtPublication: row.graveGenerationOneAndDeletedAtPublication === 1,
            oldGenerationEqualsGrave: row.oldGenerationEqualsGrave === 1,
            oldDeletedAtEqualsGraveIsTrue: row.oldDeletedAtEqualsGraveIsTrue === 1,
            publishedTwoBranchTransformValid: row.publishedTwoBranchTransformValid === 1,
          };
        } catch {
          // A failed diagnostic must not replace the original product INSERT.
          readFailed = true;
        }
      }
      return originalQuery.apply(connection, args);
    };
    return connection;
  };
  try {
    let result: T;
    try {
      result = await action();
    } catch (originalError) {
      // Store rollback has finished. Check durable effects on the independent
      // autocommit connection before per-test database cleanup can run.
      try {
        const [rows] = await independentConn.query<RowDataPacket[]>(
          `SELECT
             IF((SELECT COUNT(*) FROM sessions
                  WHERE BINARY session_id=BINARY ? AND BINARY tenant_id=BINARY ?)=1,1,0)
                  AS sessionRetained,
             IF((SELECT COUNT(*) FROM tenant_telemetry_retained_source_canonical_entries
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS newLeafAbsent,
             IF((SELECT COUNT(*) FROM tenant_database_purge_receipts
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS oldT3fAbsent,
             IF((SELECT COUNT(*) FROM tenant_telemetry_retained_source_canonical_receipts
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS newAggregateAbsent,
             IF((SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS ownerAggregateAbsent,
             IF((SELECT COUNT(*) FROM tenant_purge_session_grave_markers
                  WHERE BINARY request_id=BINARY ?)=0,1,0) AS graveAbsent,
             IF((SELECT COUNT(*) FROM tenant_database_purge_jobs
                  WHERE BINARY request_id=BINARY ? AND phase='queued')=1,1,0)
                  AS databaseJobQueued`,
          [sessionId, tenantId, requestId, requestId, requestId, requestId, requestId, requestId],
        );
        const row = rows[0];
        if (rows.length !== 1 || !row) throw new Error("canonical rollback relation query lacked one row");
        rollback = {
          sessionRetained: row.sessionRetained === 1,
          newLeafAbsent: row.newLeafAbsent === 1,
          oldT3fAbsent: row.oldT3fAbsent === 1,
          newAggregateAbsent: row.newAggregateAbsent === 1,
          ownerAggregateAbsent: row.ownerAggregateAbsent === 1,
          graveAbsent: row.graveAbsent === 1,
          databaseJobQueued: row.databaseJobQueued === 1,
        };
        expect(hits).toBe(1);
        expect(readFailed).toBe(false);
        expect(relations).not.toBeNull();
        expect(rollback).toEqual({ sessionRetained: true, newLeafAbsent: true,
          oldT3fAbsent: true, newAggregateAbsent: true, ownerAggregateAbsent: true,
          graveAbsent: true, databaseJobQueued: true });
      } catch (probeError) {
        throw new AggregateError([originalError, probeError],
          "canonical entry failed and its same-connection diagnostic was incomplete");
      }
      throw originalError;
    }
    expect(hits).toBe(1);
    expect(readFailed).toBe(false);
    expect(relations).toMatchObject({ sourceExactOne: true,
      liveSourceGenerationZeroAndUndeleted: true,
      graveGenerationOneAndDeletedAtPublication: true,
      publishedTwoBranchTransformValid: true });
    return result;
  } finally {
    for (const [connection, originalQuery] of originalQueries) {
      (connection as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = originalQuery;
    }
    pool.getConnection = originalGetConnection;
    console.log(JSON.stringify({ probe: "0054-canonical-entry-birth", hitExactlyOnce: hits === 1,
      readFailed, ...(relations ?? {}), ...(rollback ?? {}) }));
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0054 retained-source: isolated real MySQL vertical", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";
    let created = false;
    let store: MysqlSessionStore;
    let conn: Connection;
    const otherStores: MysqlSessionStore[] = [];

    beforeAll(async () => {
      baseUrl = disposableBase(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });
    beforeEach(async () => {
      database = `agent_service_retained_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      if (!/^agent_service_retained_test_[0-9]+_[a-f0-9]{12}$/.test(database)) {
        throw new Error("unsafe retained-source fixture database name");
      }
      const [existing] = await admin!.query<RowDataPacket[]>(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", [database],
      );
      if (existing.length) throw new Error("retained-source fixture database already exists");
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      created = true;
      mysqlUrl = databaseUrl(baseUrl, database);
      store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      conn = await mysql.createConnection(mysqlUrl);
      await activateCaptureFixture(store);
    }, 120_000);
    afterEach(async () => {
      await Promise.allSettled([...otherStores.splice(0).map((value) => value.close()),
        store?.close(), conn?.end()]);
      if (created && admin) await admin.query(`DROP DATABASE \`${database}\``);
      created = false;
      database = "";
      mysqlUrl = "";
    });
    afterAll(async () => { await admin?.end(); });

    it("binds new-tenant lifecycle and capture coverage to canonical subject birth, not later profile creation", async () => {
      const { tenantId } = await preparedTenant(store, conn);
      const [rows] = await conn.query<(RowDataPacket & {
        lifecycleMatchesSubjectBirth: number;
        captureMatchesSubjectBirth: number;
        lifecycleAfterLifecycleActivation: number;
        lifecycleAfterCaptureActivation: number;
        captureAfterLifecycleActivation: number;
        captureAfterCaptureActivation: number;
        profileAfterLifecycleActivation: number;
        profileAfterCaptureActivation: number;
        profileStrictlyAfterCoverageDiagnostic: number;
      })[]>(
        `SELECT
           IF(lifecycle.coverage_started_at_db_ms=subject.created_at_ms,1,0)
             AS lifecycleMatchesSubjectBirth,
           IF(capture.coverage_started_at_db_ms=subject.created_at_ms,1,0)
             AS captureMatchesSubjectBirth,
           IF(lifecycle.coverage_started_at_db_ms>=lifecycle_control.activated_at_db_ms,1,0)
             AS lifecycleAfterLifecycleActivation,
           IF(lifecycle.coverage_started_at_db_ms>=capture_control.activated_at_db_ms,1,0)
             AS lifecycleAfterCaptureActivation,
           IF(capture.coverage_started_at_db_ms>=lifecycle_control.activated_at_db_ms,1,0)
             AS captureAfterLifecycleActivation,
           IF(capture.coverage_started_at_db_ms>=capture_control.activated_at_db_ms,1,0)
             AS captureAfterCaptureActivation,
           IF(profile.created_at_ms>=lifecycle_control.activated_at_db_ms,1,0)
             AS profileAfterLifecycleActivation,
           IF(profile.created_at_ms>=capture_control.activated_at_db_ms,1,0)
             AS profileAfterCaptureActivation,
           IF(profile.created_at_ms>lifecycle.coverage_started_at_db_ms,1,0)
             AS profileStrictlyAfterCoverageDiagnostic
         FROM subject_lifecycle AS subject
         JOIN tenants AS profile ON BINARY profile.tenant_id=BINARY subject.tenant_id
         JOIN tenant_telemetry_lifecycle_coverages AS lifecycle
           ON BINARY lifecycle.tenant_id=BINARY subject.tenant_id
         JOIN tenant_telemetry_capture_v2_coverages AS capture
           ON BINARY capture.tenant_id=BINARY subject.tenant_id AND capture.domain='logs'
         JOIN tenant_telemetry_lifecycle_control AS lifecycle_control
           ON lifecycle_control.singleton_id=1
         JOIN tenant_telemetry_capture_v2_controls AS capture_control
           ON capture_control.domain='logs'
         WHERE BINARY subject.tenant_id=BINARY ? AND subject.subject_kind='tenant'
           AND BINARY subject.subject_id=BINARY subject.tenant_id`,
        [tenantId],
      );
      expect(rows).toHaveLength(1);
      const relations = rows[0];
      if (!relations) throw new Error("missing canonical new-tenant birth relation");
      expect(relations).toMatchObject({
        lifecycleMatchesSubjectBirth: 1,
        captureMatchesSubjectBirth: 1,
        lifecycleAfterLifecycleActivation: 1,
        lifecycleAfterCaptureActivation: 1,
        captureAfterLifecycleActivation: 1,
        captureAfterCaptureActivation: 1,
        profileAfterLifecycleActivation: 1,
        profileAfterCaptureActivation: 1,
      });
      // The profile can be inserted later in the same transaction. This is
      // diagnostic only; coverage >= profile is not a birth-time invariant.
      expect([0, 1]).toContain(relations.profileStrictlyAfterCoverageDiagnostic);
    }, 120_000);

    it("publishes four genuine boundaries atomically, then verifies historical reads and exact replay after reconnect", async () => {
      const source = await capturedTenant(store, conn);
      const { tenantId, request, step } = source;
      const cohort = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId);
      expect(cohort).toMatchObject({ eligibility: "eligible_retained", entryCount: 1, writtenAckCount: 1 });
      expect(await store.getTenantTelemetryRetainedSourceT1CohortEntries(tenantId, request.requestId))
        .toHaveLength(1);
      // Genuine T1 evidence is not permission to infer an unmaterialized T3d catalog.
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId)).toBeNull();
      expect(await count(conn, "tenant_erasure_admissions", "request_id", request.requestId)).toBe(1);
      expect(await count(conn, RELEASE_TABLES[1], "request_id", request.requestId)).toBe(1);
      const planned = await throughPlan(source);
      const catalog = await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId);
      const catalogSources = await store.getTenantTelemetryRetainedSourceCatalogSourceEntries(tenantId, request.requestId);
      expect(new Set(catalogSources.map((row) => row.sourceKind))).toEqual(new Set([
        "inventory", "write_job", "write_ack", "membership", "provider_source_binding", "provider_failure_commit",
      ]));
      expect(await store.getTenantTelemetryRetainedSourceCatalogTargets(tenantId, request.requestId))
        .toHaveLength(1);
      expect(await store.getTenantTelemetrySourceAccountingReceipt(tenantId, request.requestId))
        .not.toBeNull();
      expect(await store.getTenantTelemetryTargetManifestReceipt(tenantId, request.requestId))
        .not.toBeNull();
      // The new protocol binds the old 0040/0041 sources, but does not forge
      // an old-family 0042 catalog receipt.
      expect(await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, request.requestId))
        .toBeNull();
      expect(await count(conn, RELEASE_TABLES[4], "request_id", request.requestId)).toBe(1);
      const used = await withUsageReceiptTimeProbe(store, conn, tenantId, request.requestId,
        () => throughUsage(source, planned));
      const usage = await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId);
      expect(await count(conn, "billing_usage_facts", "tenant_id", tenantId)).toBe(1);
      expect(await count(conn, RELEASE_TABLES[6], "request_id", request.requestId)).toBe(1);
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseEntries(tenantId, request.requestId))
        .toHaveLength(1);
      const databaseSource = await claimDatabase(used);
      expect(await withCanonicalEntryBirthProbe(store, conn, tenantId, request.requestId,
        step.session.id, () => store.executeTenantDatabasePurge(databaseSource.databaseAuth)))
        .toMatchObject({ allDomainsComplete: false, contentPurgeExecuted: false });
      const canonical = await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId);
      expect(canonical).toMatchObject({ entryCount: 1, executionReady: false,
        externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false });
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureEntries(tenantId, request.requestId))
        .toHaveLength(1);
      for (const table of ["sessions", "items", "events", "usage_ledger"] as const) {
        expect(await count(conn, table, table === "items" || table === "events" ? "session_id" :
          table === "sessions" ? "session_id" : "tenant_id",
        table === "usage_ledger" ? tenantId : step.session.id)).toBe(0);
      }
      expect(await count(conn, RELEASE_TABLES[8], "request_id", request.requestId)).toBe(1);
      expect(await count(conn, "billing_usage_facts", "tenant_id", tenantId)).toBe(1);
      expect(await store.getTenantTelemetryOwnerClosureReceipt(tenantId, request.requestId))
        .toMatchObject({ entryCount: 1 });
      expect(await store.getTenantPurgeSessionGraveMarker(tenantId, step.session.id))
        .toMatchObject({ sessionId: step.session.id });
      expect(await store.executeTenantDatabasePurge(databaseSource.databaseAuth))
        .toEqual(await store.getTenantDatabasePurgeReceipt(tenantId, request.requestId));
      const fresh = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      otherStores.push(fresh);
      expect(await fresh.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId)).toEqual(cohort);
      expect(await fresh.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toEqual(catalog);
      expect(await fresh.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toEqual(usage);
      expect(await fresh.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId)).toEqual(canonical);
      expect(await fresh.verifyPersistedProviderStepFailureSource(step.lookup))
        .toMatchObject({ sourceCount: 1, status: "source_verified_written" });
      expect(await fresh.getTenantTelemetryRetainedSourceCanonicalClosureReceipt("wrong-tenant", request.requestId))
        .toBeNull();
      expect(await fresh.getTenantTelemetryRetainedSourceCanonicalClosureEntries("wrong-tenant", request.requestId))
        .toEqual([]);
      expect(planned.planAuth.requestId).toBe(request.requestId);
    }, 120_000);

    it("preserves a genuine ordinary tombstone generation and time through the complete retained-source T3f bridge", async () => {
      const source = await preparedTenant(store, conn);
      const { tenantId, userId, request, step } = source;
      const atMs = Date.now();
      const ordinary = await store.commitOrdinarySessionDelete({
        sessionId: step.session.id, fence: 1, expectedLastSeq: 7,
        lifecycle: { type: "tombstone", tenantId, userId, atMs,
          purgeAfterMs: null, deletionGeneration: 1 },
        events: [{ type: "session/deleted", sessionId: step.session.id,
          emittedAtMs: atMs, deletionGeneration: 1 }],
      });
      expect(ordinary.lastSeq).toBe(8);
      await store.sealOrdinarySessionDeleteGrace(tenantId, userId, step.session.id);
      expect(await store.getOrdinarySessionDeleteGrace(tenantId, userId, step.session.id))
        .toMatchObject({ state: "sealed", executionReady: false });
      const [beforeRows] = await conn.query<RowDataPacket[]>(
        `SELECT deletion_generation AS generation,deleted_at_ms AS deletedAt,
                last_seq AS lastSeq,ordinary_delete_origin_sha256 AS originSha256,
                ordinary_delete_seal_sha256 AS sealSha256,
                ordinary_delete_grace_floor_db_ms AS graceFloor
           FROM sessions WHERE BINARY session_id=BINARY ? AND BINARY tenant_id=BINARY ?`,
        [step.session.id, tenantId],
      );
      expect(beforeRows).toHaveLength(1);
      const before = beforeRows[0];
      if (!before) throw new Error("genuine ordinary tombstone session is missing");
      const originalGeneration = Number(before.generation);
      const originalDeletedAtMs = Number(before.deletedAt);
      expect(originalGeneration).toBe(1);
      expect(Number.isSafeInteger(originalDeletedAtMs)).toBe(true);
      expect(Number(before.lastSeq)).toBe(8);
      expect(typeof before.originSha256 === "string" && /^[0-9a-f]{64}$/.test(before.originSha256))
        .toBe(true);
      expect(typeof before.sealSha256 === "string" && /^[0-9a-f]{64}$/.test(before.sealSha256))
        .toBe(true);
      expect(Number(before.graceFloor) > originalDeletedAtMs).toBe(true);
      const [originRows] = await conn.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE BINARY session_id=BINARY ?
              AND type='session/deleted' AND seq=8) AS deletedEventCount,
           (SELECT COUNT(*) FROM lifecycle_outbox WHERE BINARY aggregate_id=BINARY ?
              AND generation=1) AS ordinaryOutboxCount`,
        [step.session.id, step.session.id],
      );
      expect(Number(originRows[0]?.deletedEventCount)).toBe(1);
      expect(Number(originRows[0]?.ordinaryOutboxCount)).toBe(2);
      const purgeOutbox = await store.getLifecycleOutbox("session.purge", step.session.id, 1);
      expect(purgeOutbox).not.toBeNull();
      // The public codec omits nullable fields; separately prove the durable row is still NULL.
      expect(purgeOutbox?.availableAtMs).toBeUndefined();
      expect(purgeOutbox?.claimToken).toBeUndefined();
      const [purgeOutboxRows] = await conn.query<RowDataPacket[]>(
        `SELECT available_at_ms IS NULL AS unscheduled,claim_token IS NULL AS unclaimed
           FROM lifecycle_outbox WHERE topic='session.purge'
            AND BINARY aggregate_id=BINARY ? AND generation=1`,
        [step.session.id],
      );
      expect(purgeOutboxRows).toHaveLength(1);
      expect(Number(purgeOutboxRows[0]?.unscheduled)).toBe(1);
      expect(Number(purgeOutboxRows[0]?.unclaimed)).toBe(1);
      await completeOrdinaryTombstoneOutbox(store, step.session.id);

      expect(await store.requestTenantErasure(request)).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
        .toMatchObject({ eligibility: "eligible_retained", entryCount: 1, writtenAckCount: 1 });
      await publicationAck(store, request.requestId);
      const planned = await throughPlan(source);
      const used = await throughUsage(source, planned);
      const databaseSource = await claimDatabase(used);
      const terminal = await store.executeTenantDatabasePurge(databaseSource.databaseAuth);
      expect(terminal).toMatchObject({ localDatabasePurgeComplete: true,
        sessionContentDeleted: true, allDomainsComplete: false, contentPurgeExecuted: false });
      const grave = await store.getTenantPurgeSessionGraveMarker(tenantId, step.session.id);
      expect(grave).toMatchObject({ sessionId: step.session.id,
        deletionGeneration: originalGeneration, deletedAtDbMs: originalDeletedAtMs });
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(
        tenantId, request.requestId,
      )).toMatchObject({ entryCount: 1, allDomainsComplete: false, contentPurgeExecuted: false });
      expect(await store.getTenantTelemetryOwnerClosureReceipt(tenantId, request.requestId))
        .toMatchObject({ entryCount: 1 });
      expect(await count(conn, "tenant_telemetry_retained_source_canonical_entries",
        "request_id", request.requestId)).toBe(1);
      expect(await count(conn, "tenant_database_purge_receipts", "request_id", request.requestId)).toBe(1);
      expect(await count(conn, "billing_usage_facts", "tenant_id", tenantId)).toBe(1);
      expect(await count(conn, "sessions", "session_id", step.session.id)).toBe(0);
      expect(await store.verifyPersistedProviderStepFailureSource(step.lookup))
        .toMatchObject({ sourceCount: 1, status: "source_verified_written" });
      expect(await store.executeTenantDatabasePurge(databaseSource.databaseAuth)).toEqual(terminal);
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(
        "wrong-tenant", request.requestId,
      )).toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureEntries(
        "wrong-tenant", request.requestId,
      )).toEqual([]);
      expect(await store.getTenantPurgeSessionGraveMarker("wrong-tenant", step.session.id)).toBeNull();
    }, 120_000);

    it("rejects two-source historical grave reassignment even when every old and new digest is re-signed", async () => {
      const first = await preparedTenant(store, conn);
      const second = await captureStepFixture(store, { tenantId: first.tenantId, userId: first.userId });
      const secondCommitted = await store.commitPersistedProviderStepFailure(second.input);
      expect(secondCommitted).toMatchObject({ lastSeq: 4, replayed: false });
      const secondOperation = secondCommitted.failureCommitReceipt.writeOperationSha256;
      const writerClaim = (await store.claimTenantTelemetryWriteJobs({ limit: 10, leaseMs: 120_000,
        claimToken: `retained-second-write-${randomUUID()}`,
        adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: second.proof,
      })).find((row) => row.writeOperationSha256 === secondOperation);
      if (!writerClaim) throw new Error("second genuine captured writer claim is missing");
      const writerAuth = { tenantId: first.tenantId, writeOperationSha256: secondOperation,
        claimAttempt: writerClaim.claimAttempt, claimToken: writerClaim.claimToken };
      expect(await store.reserveTenantTelemetryExternalMutation(writerAuth, "telemetry-s3-object-v1", second.proof))
        .not.toBeNull();
      const writeResult = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
        writeOperationSha256: secondOperation, target: writerClaim.target,
        inventory: writerClaim.inventory, payload: writerClaim.payload,
      }, "already_present", true);
      expect(await store.completeTenantTelemetryWrite(writerAuth, writeResult, second.proof)).not.toBeNull();
      await finishFailedTurn(store, second);

      const source: Fixture = { ...first, request: { ...first.request, atMs: Date.now() } };
      const { tenantId, request } = source;
      expect(first.step.session.id).not.toBe(second.session.id);
      expect(await store.requestTenantErasure(request)).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
        .toMatchObject({ eligibility: "eligible_retained", entryCount: 2, writtenAckCount: 2 });
      await publicationAck(store, request.requestId);
      const planned = await throughPlanClaim(source);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(await store.sealTenantPurgePlan(planned.planAuth)).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId))
        .toMatchObject({ sourceCount: 12, entryCount: 2, persistedProviderV2Count: 2,
          unknownSourceCount: 0, unknownGroupCount: 0 });
      const execution = await claimExecution(planned);
      const cutover = await store.executeTenantPurgeLocalCutover(execution.executionAuth);
      expect(cutover).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId))
        .toMatchObject({ entryCount: 2, retainedBillingFactCount: 2 });
      const databaseClaim = await claimDatabase({ ...execution, cutover });
      expect(await store.executeTenantDatabasePurge(databaseClaim.databaseAuth))
        .toMatchObject({ localDatabasePurgeComplete: true, allDomainsComplete: false,
          contentPurgeExecuted: false });
      const firstOperation = first.committed.failureCommitReceipt.writeOperationSha256;
      const graveA = await store.getTenantPurgeSessionGraveMarker(tenantId, first.step.session.id);
      const graveB = await store.getTenantPurgeSessionGraveMarker(tenantId, second.session.id);
      const oldOwners = await store.getTenantTelemetryOwnerClosureEntries(tenantId, request.requestId);
      const oldReceipt = await store.getTenantTelemetryOwnerClosureReceipt(tenantId, request.requestId);
      const canonicalEntries = await store.getTenantTelemetryRetainedSourceCanonicalClosureEntries(tenantId, request.requestId);
      const canonicalReceipt = await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId);
      const oldA = oldOwners.find((entry) => entry.writeOperationSha256 === firstOperation);
      const oldB = oldOwners.find((entry) => entry.writeOperationSha256 === secondOperation);
      const canonicalA = canonicalEntries.find((entry) => entry.writeOperationSha256 === firstOperation);
      const canonicalB = canonicalEntries.find((entry) => entry.writeOperationSha256 === secondOperation);
      expect(oldOwners).toHaveLength(2);
      expect(canonicalEntries).toHaveLength(2);
      if (!graveA || !graveB || !oldA || !oldB || !oldReceipt
        || !canonicalA || !canonicalB || !canonicalReceipt) {
        throw new Error("two independent genuine grave and owner closure rows are required");
      }
      expect(graveA.markerSha256).not.toBe(graveB.markerSha256);
      expect(oldA.sessionGraveMarkerSha256).toBe(graveA.markerSha256);
      expect(oldB.sessionGraveMarkerSha256).toBe(graveB.markerSha256);
      expect(tenantTelemetryOwnerRefSha256("session", graveA.sessionId, captureRefKey)).toBe(oldA.ownerRefSha256);
      expect(tenantTelemetryOwnerRefSha256("session", graveB.sessionId, captureRefKey)).not.toBe(oldA.ownerRefSha256);

      // Preserve the full previously verified 7-source/0040/0041/usage proof while live
      // evidence still reads cleanly. No deleted canonical owner is reconstructed later.
      const internal = store as unknown as {
        withConsistentRead<T>(read: (dbConn: PoolConnection) => Promise<T>): Promise<T>;
        readRetainedSourceUsageForLookup(dbConn: PoolConnection, ownerTenant: string, ownerRequest: string):
          Promise<{ receipt: TenantTelemetryRetainedSourceUsageReleaseReceipt;
            entries: TenantTelemetryRetainedSourceUsageReleaseEntry[];
            proof: TenantTelemetryRetainedSourceUsageProof } | null>;
      };
      const sealedUsage = await internal.withConsistentRead((dbConn) =>
        internal.readRetainedSourceUsageForLookup(dbConn, tenantId, request.requestId));
      if (!sealedUsage) throw new Error("complete pre-corruption usage proof is missing");
      expect(sealedUsage.entries).toHaveLength(2);

      const { receiptSha256: _oldLeafHash, ...oldBody } = oldA;
      const alteredOwnerBody = { ...oldBody, sessionGraveMarkerSha256: graveB.markerSha256 };
      const forgedOldBody = { ...alteredOwnerBody,
        canonicalOwnerProofSha256: tenantTelemetryCanonicalOwnerProofSha256(alteredOwnerBody) };
      const forgedOldA = { ...forgedOldBody,
        receiptSha256: tenantTelemetryOwnerClosureEntrySha256(forgedOldBody) };
      const forgedOwners = [forgedOldA, oldB];
      const { receiptSha256: _oldAggregateHash, ...oldReceiptBody } = oldReceipt;
      const forgedOldReceipt = createTenantTelemetryOwnerClosureReceipt({
        ...oldReceiptBody, entryCount: 2,
        entryRootSha256: tenantTelemetryOwnerClosureEntryRootSha256(forgedOwners),
        entries: forgedOwners,
      });
      const { receiptSha256: _canonicalLeafHash, ...canonicalBody } = canonicalA;
      const forgedCanonicalA = buildTenantTelemetryRetainedSourceCanonicalClosureEntry({
        ...canonicalBody, canonicalOwnerProofSha256: forgedOldA.canonicalOwnerProofSha256,
        ownerClosureEntryReceiptSha256: forgedOldA.receiptSha256,
        sessionGraveMarkerSha256: graveB.markerSha256,
      });
      const forgedCanonicalEntries = [forgedCanonicalA, canonicalB];
      const { receiptSha256: _canonicalAggregateHash, ...canonicalReceiptBody } = canonicalReceipt;
      const forgedCanonicalBody = { ...canonicalReceiptBody,
        ownerClosureReceiptSha256: forgedOldReceipt.receiptSha256,
        entryRootSha256: tenantTelemetryRetainedSourceCanonicalClosureRootSha256(forgedCanonicalEntries) };
      const forgedCanonicalReceipt = { ...forgedCanonicalBody,
        receiptSha256: tenantTelemetryRetainedSourceReceiptSha256(forgedCanonicalBody) };
      const pureProof: TenantTelemetryRetainedSourceCanonicalProof = {
        usageProof: sealedUsage.proof, usageReceipt: sealedUsage.receipt, usageEntries: sealedUsage.entries,
        ownerClosureEntries: forgedOwners, graveMarkers: [graveA, graveB],
        anchors: { planBuildGeneration: canonicalReceipt.planBuildGeneration,
          executionGeneration: canonicalReceipt.executionGeneration,
          databasePurgeGeneration: canonicalReceipt.databasePurgeGeneration,
          planReceiptSha256: canonicalReceipt.planReceiptSha256,
          localPhysicalAckReceiptSha256: canonicalReceipt.localPhysicalAckReceiptSha256,
          preDeleteReceiptSha256: canonicalReceipt.preDeleteReceiptSha256,
          t3fReceiptSha256: canonicalReceipt.t3fReceiptSha256,
          ownerClosureReceiptSha256: forgedOldReceipt.receiptSha256,
          graveMarkerRootSha256: canonicalReceipt.graveMarkerRootSha256,
          completedClaimAttempt: canonicalReceipt.completedClaimAttempt,
          completedClaimTokenSha256: canonicalReceipt.completedClaimTokenSha256,
          storeDbTimestampMs: canonicalReceipt.storeDbTimestampMs },
      };
      // This full public proof intentionally passes: the remaining independent fact is
      // the protected HMAC relation between each ownerRef and its actual grave sessionId.
      expect(() => validateTenantTelemetryRetainedSourceCanonicalClosureProof(
        forgedCanonicalReceipt, forgedCanonicalEntries, pureProof)).not.toThrow();

      type EvidenceSet = { ownerEntry: typeof oldA; ownerReceipt: typeof oldReceipt;
        canonicalEntry: TenantTelemetryRetainedSourceCanonicalClosureEntry;
        canonicalReceipt: typeof canonicalReceipt };
      const original: EvidenceSet = { ownerEntry: oldA, ownerReceipt: oldReceipt,
        canonicalEntry: canonicalA, canonicalReceipt };
      const forged: EvidenceSet = { ownerEntry: forgedOldA, ownerReceipt: forgedOldReceipt,
        canonicalEntry: forgedCanonicalA, canonicalReceipt: forgedCanonicalReceipt };
      const rewrite = async (from: EvidenceSet, to: EvidenceSet) => {
        await conn.beginTransaction();
        try {
          const update = async (sql: string, params: readonly unknown[]) => {
            const [result] = await conn.query<mysql.ResultSetHeader>(sql, [...params]);
            expect(result.affectedRows).toBe(1);
          };
          await update(`UPDATE tenant_telemetry_owner_closure_entries
                         SET canonical_owner_proof_sha256=?,session_grave_marker_sha256=?,receipt_sha256=?
                       WHERE BINARY request_id=BINARY ? AND BINARY write_operation_sha256=BINARY ?
                         AND BINARY receipt_sha256=BINARY ?`,
            [to.ownerEntry.canonicalOwnerProofSha256, to.ownerEntry.sessionGraveMarkerSha256,
              to.ownerEntry.receiptSha256, request.requestId, firstOperation, from.ownerEntry.receiptSha256]);
          await update(`UPDATE tenant_telemetry_owner_closure_receipts
                         SET entry_root_sha256=?,receipt_sha256=?
                       WHERE BINARY request_id=BINARY ? AND BINARY receipt_sha256=BINARY ?`,
            [to.ownerReceipt.entryRootSha256, to.ownerReceipt.receiptSha256,
              request.requestId, from.ownerReceipt.receiptSha256]);
          await update(`UPDATE tenant_telemetry_retained_source_canonical_entries
                         SET canonical_owner_proof_sha256=?,owner_closure_entry_receipt_sha256=?,
                             session_grave_marker_sha256=?,receipt_sha256=?,receipt_json=?
                       WHERE BINARY request_id=BINARY ? AND BINARY write_operation_sha256=BINARY ?
                         AND BINARY receipt_sha256=BINARY ?`,
            [to.canonicalEntry.canonicalOwnerProofSha256, to.canonicalEntry.ownerClosureEntryReceiptSha256,
              to.canonicalEntry.sessionGraveMarkerSha256, to.canonicalEntry.receiptSha256,
              JSON.stringify(to.canonicalEntry), request.requestId, firstOperation, from.canonicalEntry.receiptSha256]);
          await update(`UPDATE tenant_telemetry_retained_source_canonical_receipts
                         SET owner_closure_receipt_sha256=?,entry_root_sha256=?,receipt_sha256=?,receipt_json=?
                       WHERE BINARY request_id=BINARY ? AND BINARY receipt_sha256=BINARY ?`,
            [to.canonicalReceipt.ownerClosureReceiptSha256, to.canonicalReceipt.entryRootSha256,
              to.canonicalReceipt.receiptSha256, JSON.stringify(to.canonicalReceipt),
              request.requestId, from.canonicalReceipt.receiptSha256]);
          await conn.commit();
        } catch (error) {
          await conn.rollback();
          throw error;
        }
      };
      let forgedPublished = false;
      try {
        await withOnlyIsolatedCanonicalUpdateGuardsRemoved(conn, database, () => rewrite(original, forged));
        forgedPublished = true;
        expect(await count(conn, "tenant_telemetry_owner_closure_entries", "request_id", request.requestId)).toBe(2);
        expect(await count(conn, "tenant_telemetry_retained_source_canonical_entries", "request_id", request.requestId)).toBe(2);
        await expect(store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
          .rejects.toBeInstanceOf(TenantTelemetryRetainedSourceIntegrityError);
      } finally {
        if (forgedPublished) {
          await withOnlyIsolatedCanonicalUpdateGuardsRemoved(conn, database, () => rewrite(forged, original));
        }
      }
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId))
        .toEqual(canonicalReceipt);
      expect(await store.verifyPersistedProviderStepFailureSource(first.step.lookup))
        .toMatchObject({ sourceCount: 1, status: "source_verified_written" });
      expect(await store.verifyPersistedProviderStepFailureSource(second.lookup))
        .toMatchObject({ sourceCount: 1, status: "source_verified_written" });
    }, 180_000);

    it("rejects a fully re-signed wrong live-owner claim at the real catalog target INSERT", async () => {
      const source = await capturedTenant(store, conn);
      const claimed = await throughPlanClaim(source);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const before = await databaseRowsSha256(conn);
      const pool = (store as unknown as { pool: { getConnection: () => Promise<PoolConnection> } }).pool;
      const originalGetConnection = pool.getConnection;
      const getConnection = originalGetConnection.bind(pool);
      const originalQueries = new Map<PoolConnection, (...args: unknown[]) => Promise<unknown>>();
      let hookHits = 0;
      let publicBuilderPassed = false;
      let submittedToSql = false;
      pool.getConnection = async () => {
        const connection = await getConnection();
        if (originalQueries.has(connection)) return connection;
        const surface = connection as unknown as { query: (...args: unknown[]) => Promise<unknown> };
        const originalQuery = surface.query;
        originalQueries.set(connection, originalQuery);
        surface.query = async (...args: unknown[]) => {
          if (typeof args[0] !== "string"
            || !/^\s*INSERT INTO tenant_telemetry_retained_source_catalog_targets\s*\(/.test(args[0])) {
            return originalQuery.apply(connection, args);
          }
          hookHits++;
          const sql = args[0];
          const columnsMatch = /^\s*INSERT INTO tenant_telemetry_retained_source_catalog_targets\s*\(([^)]+)\)\s*VALUES\s*\(/.exec(sql);
          const values = args[1];
          if (!columnsMatch || !Array.isArray(values)) throw new Error("catalog target SQL fixture shape changed");
          const columns = columnsMatch[1]!.split(",").map((column) => column.trim());
          const receiptIndex = columns.indexOf("receipt_json");
          const claimIndex = columns.indexOf("live_owner_claim_sha256");
          const shaIndex = columns.indexOf("receipt_sha256");
          if (columns.length !== values.length || receiptIndex !== columns.length - 1
            || claimIndex < 0 || shaIndex < 0 || new Set(columns).size !== columns.length
            || typeof values[receiptIndex] !== "string") {
            throw new Error("catalog target SQL columns are not the closed fixture projection");
          }
          const original = JSON.parse(values[receiptIndex]) as TenantTelemetryRetainedSourceCatalogEntry;
          const { receiptSha256: oldReceiptSha256, ...body } = original;
          const oldClaim = original.liveOwnerClaimSha256;
          const wrongClaim = `${oldClaim[0] === "0" ? "1" : "0"}${oldClaim.slice(1)}`;
          const forged = buildTenantTelemetryRetainedSourceCatalogEntry({
            ...body, liveOwnerClaimSha256: wrongClaim,
          });
          publicBuilderPassed = forged.receiptSha256 !== oldReceiptSha256
            && forged.liveOwnerClaimSha256 !== oldClaim;
          const forgedValues = [...values];
          forgedValues[claimIndex] = forged.liveOwnerClaimSha256;
          forgedValues[shaIndex] = forged.receiptSha256;
          forgedValues[receiptIndex] = JSON.stringify(forged);
          submittedToSql = true;
          return originalQuery.apply(connection, [sql, forgedValues, ...args.slice(2)]);
        };
        return connection;
      };
      try {
        await expect(store.sealTenantPurgePlan(claimed.planAuth)).rejects.toMatchObject({
          code: "ER_SIGNAL_EXCEPTION", sqlMessage: "retained-source target lacks exact written graph",
        });
      } finally {
        for (const [connection, originalQuery] of originalQueries) {
          (connection as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = originalQuery;
        }
        pool.getConnection = originalGetConnection;
      }
      expect(hookHits).toBe(1);
      expect(publicBuilderPassed).toBe(true);
      expect(submittedToSql).toBe(true);
      expect(await databaseRowsSha256(conn)).toBe(before);
      expect(await store.getTenantPurgePlanJob(source.tenantId, source.request.requestId))
        .toMatchObject({ phase: "queued" });
      expect(await store.getTenantPurgePlanReceipt(source.tenantId, source.request.requestId)).toBeNull();
      for (const table of ["tenant_telemetry_source_accounting_entries",
        "tenant_telemetry_source_accounting_receipts", "tenant_telemetry_target_manifest_entries",
        "tenant_telemetry_target_manifest_receipts", ...RELEASE_TABLES.slice(2, 5)]) {
        expect(await count(conn, table, "request_id", source.request.requestId)).toBe(0);
      }
      expect(await store.sealTenantPurgePlan(claimed.planAuth)).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(
        source.tenantId, source.request.requestId,
      )).toMatchObject({ entryCount: 1, unknownSourceCount: 0 });
    }, 120_000);

    it.each(["pending", "reserved"] as const)(
      "freezes %s T1 source as blocked; a late ACK never upgrades it or seals T3d", async (mode) => {
        const source = await capturedTenant(store, conn, mode);
        const claimed = await throughPlanClaim(source);
        const { tenantId, request } = source;
        const original = await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId);
        if (source.lateAck) expect(await source.lateAck()).not.toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId))
          .toEqual(original);
        const before = await databaseRowsSha256(conn);
        await expect(store.sealTenantPurgePlan(claimed.planAuth)).rejects.toThrow();
        expect(await databaseRowsSha256(conn)).toBe(before);
        expect(await store.getTenantPurgePlanJob(tenantId, request.requestId)).toMatchObject({ phase: "queued" });
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId)).toBeNull();
      },
    );

    it.each([
      ["t1", RELEASE_TABLES[1]], ["t3d", RELEASE_TABLES[4]],
      ["t3e", RELEASE_TABLES[6]], ["t3f", RELEASE_TABLES[8]],
    ] as const)("rolls back old and new %s publications after a real late receipt trigger", async (boundary, table) => {
      if (boundary === "t1") {
        const { tenantId, request } = await preparedTenant(store, conn);
        const before = await databaseRowsSha256(conn);
        await withLateReceiptFailure(conn, table, () => store.requestTenantErasure(request));
        expect(await databaseRowsSha256(conn)).toBe(before);
        expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, request.requestId)).toBeNull();
        expect(await count(conn, "tenant_erasure_admissions", "request_id", request.requestId)).toBe(0);
        expect(await store.requestTenantErasure(request)).not.toBeNull();
        return;
      }
      const source = await capturedTenant(store, conn);
      const planClaim = boundary === "t3d" ? await throughPlanClaim(source) : null;
      const planned = boundary === "t3e" ? await throughPlan(source) : null;
      const executionClaim = boundary === "t3e" ? await claimExecution(planned!) : null;
      const used = boundary === "t3f" ? await throughUsage(source) : null;
      const databaseClaim = used ? await claimDatabase(used) : null;
      const before = await databaseRowsSha256(conn);
      const action = boundary === "t3d" ? () => store.sealTenantPurgePlan(planClaim!.planAuth)
        : boundary === "t3e" ? () => store.executeTenantPurgeLocalCutover(executionClaim!.executionAuth)
          : () => store.executeTenantDatabasePurge(databaseClaim!.databaseAuth);
      await withLateReceiptFailure(conn, table, action);
      expect(await databaseRowsSha256(conn)).toBe(before);
      const { tenantId, request } = source;
      if (boundary === "t3d") {
        expect(await store.getTenantPurgePlanReceipt(tenantId, request.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(tenantId, request.requestId)).toBeNull();
      } else if (boundary === "t3e") {
        expect(await count(conn, "usage_ledger", "tenant_id", tenantId)).toBe(1);
        expect(await store.getTenantPurgeLocalCutoverReceipt(tenantId, request.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId, request.requestId)).toBeNull();
      } else {
        expect(await count(conn, "sessions", "session_id", source.step.session.id)).toBe(1);
        expect(await store.getTenantDatabasePurgeReceipt(tenantId, request.requestId)).toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId, request.requestId)).toBeNull();
      }
      // The original claim/auth remains unchanged after the injected rollback.
      expect(await action()).not.toBeNull();
    }, 120_000);

    it.each(["blob", "export"] as const)(
      "never releases usage or schedules external deletion when a genuine %s plan domain is nonzero", async (kind) => {
      const source = kind === "blob" ? await capturedTenant(store, conn, "written", true)
        : await preparedTenantWithReadyExport(store, conn);
      const claimed = await claimExecution(await throughPlan(source));
      const entries = await store.getTenantPurgePlanEntries(source.tenantId, source.request.requestId, 1);
      expect(entries.find((row) => row.domain === (kind === "blob" ? "blob_bytes" : "user_export_artifacts"))
        ?.targetCount).toBeGreaterThan(0);
      const before = await databaseRowsSha256(conn);
      const beforeOutbox = await outboxCounts(conn);
      await expect(store.executeTenantPurgeLocalCutover(claimed.executionAuth)).rejects.toThrow();
      expect(await databaseRowsSha256(conn)).toBe(before);
      expect(await outboxCounts(conn)).toEqual(beforeOutbox);
      expect(await count(conn, "usage_ledger", "tenant_id", source.tenantId)).toBe(1);
      expect(await store.getTenantPurgeLocalCutoverReceipt(source.tenantId, source.request.requestId))
        .toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
        source.tenantId, source.request.requestId,
      )).toBeNull();
      }, 120_000,
    );

    it.each(["admission", "plan"] as const)(
      "rejects an ordinary attempt to clear the immutable %s family marker", async (location) => {
        const source = await capturedTenant(store, conn);
        await throughPlan(source);
        const table: MarkerTable = location === "admission"
          ? "tenant_erasure_admissions" : "tenant_purge_plan_jobs";
        await expect(conn.query(
          `UPDATE \`${table}\` SET telemetry_retained_source_protocol=NULL WHERE request_id=?`,
          [source.request.requestId],
        )).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT telemetry_retained_source_protocol AS protocol FROM \`${table}\` WHERE request_id=?`,
          [source.request.requestId],
        );
        expect(rows[0]?.protocol).not.toBeNull();
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        )).toMatchObject({ entryCount: 1 });
      },
    );

    it.each(["admission", "plan"] as const)(
      "rejects a genuinely lost %s marker after exact guard restoration in its isolated database", async (location) => {
        const source = await capturedTenant(store, conn);
        await throughPlan(source);
        const table: MarkerTable = location === "admission"
          ? "tenant_erasure_admissions" : "tenant_purge_plan_jobs";
        await withOnlyIsolatedMarkerUpdateGuardsRemoved(conn, database, table, async () => {
          await conn.query(`UPDATE \`${table}\` SET telemetry_retained_source_protocol=NULL WHERE request_id=?`,
            [source.request.requestId]);
          const [inside] = await conn.query<RowDataPacket[]>(
            `SELECT telemetry_retained_source_protocol AS protocol FROM \`${table}\` WHERE request_id=?`,
            [source.request.requestId],
          );
          expect(inside).toHaveLength(1);
          expect(inside[0]?.protocol).toBeNull();
        });
        // The exact trigger bodies and action order were restored and fingerprinted above;
        // these refusals therefore cannot be attributed merely to missing-schema drift.
        await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        )).rejects.toThrow();
        await expect(store.getTenantPurgePlanReceipt(source.tenantId, source.request.requestId))
          .rejects.toThrow();
        const startup = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1,
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true,
        }).then(async (connected) => { await connected.close(); return "accepted"; }, () => "rejected");
        expect(startup).toBe("rejected");
      },
    );

    it("rejects live item text drift, even if a fixture operator tries a direct SQL update", async () => {
      const source = await capturedTenant(store, conn);
      await throughPlan(source);
      let guarded = false;
      try {
        await conn.query("UPDATE items SET body=JSON_SET(body,'$.text','changed') WHERE item_id=?",
          [source.step.item.id]);
      } catch (error) {
        expect(error).toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        guarded = true;
      }
      if (guarded) {
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        )).toMatchObject({ entryCount: 1 });
      } else {
        await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        )).rejects.toThrow();
      }
    }, 120_000);

    it("checks independently retained billing fact bytes after operational usage deletion", async () => {
      const source = await throughUsage(await capturedTenant(store, conn));
      const before = await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
        source.tenantId, source.request.requestId,
      );
      expect(before).toMatchObject({ retainedBillingFactCount: 1 });
      let guarded = false;
      try {
        await conn.query("UPDATE billing_usage_facts SET provider='changed-provider' WHERE tenant_id=?",
          [source.tenantId]);
      } catch (error) {
        expect(error).toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
        guarded = true;
      }
      if (guarded) {
        expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
          source.tenantId, source.request.requestId,
        )).toEqual(before);
      } else {
        await expect(store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
          source.tenantId, source.request.requestId,
        )).rejects.toThrow();
      }
    }, 120_000);

    it.each([
      ["aggregate", "tenant_telemetry_retained_source_catalog_receipts"],
      ["target", "tenant_telemetry_retained_source_catalog_targets"],
      ["provider-binding backlink", "tenant_telemetry_retained_source_catalog_sources"],
    ] as const)("old live source getters audit the complete new catalog after %s loss", async (_kind, table) => {
      const source = await capturedTenant(store, conn);
      await throughPlan(source);
      const operation = source.committed.failureCommitReceipt.writeOperationSha256;
      const binding = await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(
        source.tenantId, operation,
      );
      const failure = await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(
        source.step.lookup,
      );
      expect(binding).not.toBeNull();
      expect(failure).toEqual(source.committed.failureCommitReceipt);
      const where = table === "tenant_telemetry_retained_source_catalog_sources"
        ? "tenant_id=? AND request_id=? AND source_kind='provider_source_binding'"
        : "tenant_id=? AND request_id=?";
      const removeOne = () => conn.query(`DELETE FROM \`${table}\` WHERE ${where}`,
        [source.tenantId, source.request.requestId]);
      // First prove the ordinary SQL path cannot erase the evidence.
      await expect(removeOne()).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      expect(await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(
        source.tenantId, operation,
      )).toEqual(binding);
      expect(await store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(
        source.step.lookup,
      )).toEqual(failure);
      // Only the exact, already validated test database's one DELETE trigger is
      // temporarily removed. Its original body/mode/order is restored and
      // fingerprinted before either hot getter is invoked.
      await withOnlyIsolatedEvidenceDeleteGuardRemoved(conn, database, table, async () => {
        await removeOne();
        const column = table === "tenant_telemetry_retained_source_catalog_sources"
          ? "source_kind" : "request_id";
        const value = table === "tenant_telemetry_retained_source_catalog_sources"
          ? "provider_source_binding" : source.request.requestId;
        expect(await count(conn, table, column, value)).toBe(0);
      });
      await expect(store.getTenantTelemetryPersistedProviderCaptureSourceBinding(
        source.tenantId, operation,
      )).rejects.toThrow();
      await expect(store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(
        source.step.lookup,
      )).rejects.toThrow();
      await expect(store.getTenantTelemetryRetainedSourceCatalogReceipt(
        source.tenantId, source.request.requestId,
      )).rejects.toThrow();
    }, 120_000);

    it("does not let old T3e cutover, physical ACK, or exact replay outlive a lost new usage receipt", async () => {
      const source = await throughUsage(await capturedTenant(store, conn));
      const table = RELEASE_TABLES[6];
      const oldCutover = await store.getTenantPurgeLocalCutoverReceipt(
        source.tenantId, source.request.requestId,
      );
      expect(oldCutover).not.toBeNull();
      const removeOne = () => conn.query(`DELETE FROM \`${table}\` WHERE tenant_id=? AND request_id=?`,
        [source.tenantId, source.request.requestId]);
      await expect(removeOne()).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      expect(await store.getTenantPurgeLocalCutoverReceipt(
        source.tenantId, source.request.requestId,
      )).toEqual(oldCutover);
      await withOnlyIsolatedEvidenceDeleteGuardRemoved(conn, database, table, async () => {
        await removeOne();
        expect(await count(conn, table, "request_id", source.request.requestId)).toBe(0);
      });
      // The exact product guard has been restored and fingerprinted. The
      // rejection now depends on the missing new-family bridge, not DDL drift.
      await expect(store.getTenantPurgeLocalCutoverReceipt(
        source.tenantId, source.request.requestId,
      )).rejects.toThrow();
      await expect(store.sealTenantPurgeLocalPhysicalAcks(source.executionAuth)).rejects.toThrow();
      await expect(store.executeTenantPurgeLocalCutover(source.executionAuth)).rejects.toThrow();
      expect(await count(conn, "tenant_purge_local_cutover_receipts", "request_id",
        source.request.requestId)).toBe(1);
      expect(await count(conn, "usage_ledger", "tenant_id", source.tenantId)).toBe(0);
    }, 120_000);

    it("does not let old T3f reads, exact replay, or T3g consume a lost new canonical receipt", async () => {
      const source = await claimDatabase(await throughUsage(await capturedTenant(store, conn)));
      const terminal = await store.executeTenantDatabasePurge(source.databaseAuth);
      expect(terminal).not.toBeNull();
      expect(await store.getTenantDatabasePurgeReceipt(
        source.tenantId, source.request.requestId,
      )).toEqual(terminal);
      // Connect while evidence is intact so a later T3g rejection cannot be
      // mislabeled as a cold startup fingerprint failure.
      const redisConsumer = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true,
        tenantRedisPurgeNamespaceSha256: "8".repeat(64) });
      otherStores.push(redisConsumer);
      const table = RELEASE_TABLES[8];
      const removeOne = () => conn.query(`DELETE FROM \`${table}\` WHERE tenant_id=? AND request_id=?`,
        [source.tenantId, source.request.requestId]);
      await expect(removeOne()).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION" });
      expect(await redisConsumer.getTenantDatabasePurgeReceipt(
        source.tenantId, source.request.requestId,
      )).toEqual(terminal);
      await withOnlyIsolatedEvidenceDeleteGuardRemoved(conn, database, table, async () => {
        await removeOne();
        expect(await count(conn, table, "request_id", source.request.requestId)).toBe(0);
      });
      await expect(store.getTenantDatabasePurgeReceipt(
        source.tenantId, source.request.requestId,
      )).rejects.toThrow();
      await expect(store.executeTenantDatabasePurge(source.databaseAuth)).rejects.toThrow();
      await expect(redisConsumer.materializeTenantRedisPurgeJobs({ limit: 1 })).rejects.toThrow();
      expect(await count(conn, "tenant_redis_purge_jobs", "request_id", source.request.requestId)).toBe(0);
      expect(await count(conn, "tenant_database_purge_receipts", "request_id",
        source.request.requestId)).toBe(1);
    }, 120_000);

    it("observes a complete T1 cohort committed after the reader's RR snapshot START", async () => {
      const source = await preparedTenant(store, conn);
      const writer = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      otherStores.push(writer);
      const { readResult, writeResult } = await readAcrossCommittedBoundary(
        store,
        () => store.getTenantTelemetryRetainedSourceT1CohortReceipt(
          source.tenantId, source.request.requestId,
        ),
        async () => {
          const admitted = await writer.requestTenantErasure(source.request);
          expect(admitted).not.toBeNull();
          // A separate connection observes the committed durable row before
          // the paused RR reader runs its first evidence query.
          expect(await count(conn, RELEASE_TABLES[1], "request_id", source.request.requestId)).toBe(1);
          return admitted;
        },
      );
      expect(writeResult).not.toBeNull();
      expect(readResult).toMatchObject({ eligibility: "eligible_retained", entryCount: 1 });
      expect(readResult).toEqual(await writer.getTenantTelemetryRetainedSourceT1CohortReceipt(
        source.tenantId, source.request.requestId,
      ));
    }, 120_000);

    it("observes one complete T3d catalog committed after the reader's RR snapshot START", async () => {
      const source = await capturedTenant(store, conn);
      const claimed = await throughPlanClaim(source);
      // The pre-existing T3d materialization floor is independent of the
      // snapshot race. The barrier below, not this floor wait, orders commits.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const writer = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      otherStores.push(writer);
      const { readResult, writeResult } = await readAcrossCommittedBoundary(
        store,
        () => store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        ),
        async () => {
          const sealed = await writer.sealTenantPurgePlan(claimed.planAuth);
          expect(sealed).not.toBeNull();
          expect(await count(conn, RELEASE_TABLES[4], "request_id", source.request.requestId)).toBe(1);
          return sealed;
        },
      );
      expect(writeResult).not.toBeNull();
      expect(readResult).toMatchObject({ sourceCount: 6, entryCount: 1 });
      expect(readResult).toEqual(await writer.getTenantTelemetryRetainedSourceCatalogReceipt(
        source.tenantId, source.request.requestId,
      ));
    }, 120_000);

    it.each(["binding", "failure"] as const)(
      "old %s source getter sees the same newly sealed T3d manifest through a stale RR snapshot", async (kind) => {
        const source = await capturedTenant(store, conn);
        const claimed = await throughPlanClaim(source);
        // Satisfy the ordinary T3d DB-time floor before arranging the race.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        const writer = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 2,
          tenantTelemetryRefKey: captureRefKey,
          tenantTelemetryPersistedProviderCaptureLocalOnly: true });
        otherStores.push(writer);
        const operation = source.committed.failureCommitReceipt.writeOperationSha256;
        const read: () => Promise<unknown> = kind === "binding"
          ? () => store.getTenantTelemetryPersistedProviderCaptureSourceBinding(source.tenantId, operation)
          : () => store.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(source.step.lookup);
        const { readResult } = await readAcrossCommittedBoundary(store, read, async () => {
          const sealed = await writer.sealTenantPurgePlan(claimed.planAuth);
          expect(sealed).not.toBeNull();
          expect(await count(conn, RELEASE_TABLES[4], "request_id", source.request.requestId)).toBe(1);
          return sealed;
        });
        expect(readResult).toEqual(kind === "binding"
          ? await writer.getTenantTelemetryPersistedProviderCaptureSourceBinding(source.tenantId, operation)
          : await writer.getTenantTelemetryPersistedProviderCaptureFailureCommitReceipt(source.step.lookup));
      }, 120_000,
    );

    it.each([
      ["t3d", RELEASE_TABLES[4]], ["t3e", RELEASE_TABLES[6]],
      ["t3f", RELEASE_TABLES[8]],
    ] as const)("rolls back %s when the final SQL receipt exceeds the same claim lease", async (boundary, table) => {
      const source = await capturedTenant(store, conn);
      const plan = boundary === "t3d" ? await throughPlanClaim(source, 2_500) : null;
      const planned = boundary === "t3e" ? await throughPlan(source) : null;
      const execution = planned ? await claimExecution(planned, 2_500) : null;
      const used = boundary === "t3f" ? await throughUsage(source) : null;
      const databaseClaim = used ? await claimDatabase(used, 2_500) : null;
      // The exact row snapshot is captured before the claim lease elapses. The
      // fixture trigger itself must then execute (elapsed oracle), otherwise
      // an already expired claim would be a false positive for the final check.
      const before = await databaseRowsSha256(conn);
      const action = boundary === "t3d" ? () => store.sealTenantPurgePlan(plan!.planAuth)
        : boundary === "t3e" ? () => store.executeTenantPurgeLocalCutover(execution!.executionAuth)
          : () => store.executeTenantDatabasePurge(databaseClaim!.databaseAuth);
      const { outcome, elapsedMs, reached } = await withLateReceiptSleep(conn, database, table, action);
      expect(reached).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
      expect(outcome.state).toBe("rejected");
      if (outcome.state !== "rejected") throw new Error("expired claim unexpectedly published a receipt");
      const evidenceChanged = boundary === "t3d" ? TenantPurgePlanEvidenceChangedError
        : boundary === "t3e" ? TenantPurgeExecutionEvidenceChangedError
          : TenantDatabasePurgeEvidenceChangedError;
      const leaseExpired = boundary === "t3d" ? /^tenant purge plan lease expired /i
        : boundary === "t3e" ? /^tenant purge execution lease expired /i
          : /^tenant database purge lease expired /i;
      if (!(outcome.error instanceof evidenceChanged)) {
        expect(outcome.error).toBeInstanceOf(Error);
        if (!(outcome.error instanceof Error)) throw new Error("late lease returned a non-Error");
        expect(outcome.error.message).toMatch(leaseExpired);
      }
      expect(await databaseRowsSha256(conn)).toBe(before);
      if (boundary === "t3d") {
        expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(
          source.tenantId, source.request.requestId,
        )).toBeNull();
      } else if (boundary === "t3e") {
        expect(await count(conn, "usage_ledger", "tenant_id", source.tenantId)).toBe(1);
        expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
          source.tenantId, source.request.requestId,
        )).toBeNull();
      } else {
        expect(await count(conn, "sessions", "session_id", source.step.session.id)).toBe(1);
        expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(
          source.tenantId, source.request.requestId,
        )).toBeNull();
      }
    }, 120_000);

    it("serializes concurrent exact T3f claims and reads one immutable terminal publication", async () => {
      const source = await claimDatabase(await throughUsage(await capturedTenant(store, conn)));
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 4,
        tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      otherStores.push(second);
      expect(await store.executeTenantDatabasePurge({ ...source.databaseAuth,
        tenantId: `wrong-${source.tenantId}` })).toBeNull();
      expect(await count(conn, "sessions", "session_id", source.step.session.id)).toBe(1);
      const [left, right] = await Promise.all([
        store.executeTenantDatabasePurge(source.databaseAuth),
        second.executeTenantDatabasePurge(source.databaseAuth),
      ]);
      expect(left).not.toBeNull();
      expect(right).toEqual(left);
      expect(await count(conn, RELEASE_TABLES[8], "request_id", source.request.requestId)).toBe(1);
      expect(await count(conn, "tenant_database_purge_receipts", "request_id", source.request.requestId))
        .toBe(1);
      expect(await count(conn, "sessions", "session_id", source.step.session.id)).toBe(0);
      expect(await second.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(
        source.tenantId, source.request.requestId,
      )).toMatchObject({ allDomainsComplete: false, contentPurgeExecuted: false });
    }, 120_000);
  });
}
