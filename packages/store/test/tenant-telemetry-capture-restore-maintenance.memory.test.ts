import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY, tenantRuntimeFleetSha256, tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256, tenantRuntimeTargetSha256 } from "@agent-service/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, MemoryTenantBackupCatalogAdapter, newErasureRequestId, newTenantBackupId,
  tenantErasureRequestHash, tenantRestoreJournalNextRemoteHeadRootSha256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256, tenantTelemetryWriteAdapterResult,
  TenantTelemetryCaptureRestoreIntegrityError, type TenantTelemetryCaptureRestoreMaintenanceSelector,
  type TenantTelemetryCaptureRestoreHistoryReceipt } from "../src/index.js";
import { activateCaptureFixture, captureRefKey, captureStepFixture, uncapturedStepFixture } from "./persisted-provider-capture.fixture.js";

// Actual Memory atomic consumers; journal/catalog/fleet/sink descriptors below
// are explicitly non-production fixtures, not MySQL/GCM/S3/stopped-fleet proof.
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const must = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error("maintenance fixture source missing");
  return value;
};
const baseAuth = (claim: { requestId: string; tenantId: string; subjectGeneration: number; claimAttempt: number; claimToken: string }) => ({
  requestId: claim.requestId, tenantId: claim.tenantId, subjectGeneration: claim.subjectGeneration,
  claimAttempt: claim.claimAttempt, claimToken: claim.claimToken,
});
type Phase = "queued" | "reserved" | "live" | "usage_released" | "canonical_closed";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function journalPublication(store: MemorySessionStore, requestId: string, acknowledge = true) {
  const claim = must((await store.claimTenantRestoreJournalPublications({ limit: 10, leaseMs: 60_000,
    claimToken: `maintenance-publication-${randomUUID()}` })).find((row) => row.requestId === requestId));
  const authorization = { ...baseAuth(claim), publicationGeneration: claim.publicationGeneration };
  const pending = must(await store.getTenantRestoreJournalPublicationRecord(authorization, 0));
  const previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
  const result = { adapterProtocol: pending.target.adapterProtocol,
    journalNamespaceSha256: pending.target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: pending.target.logicalDatabaseNamespaceSha256,
    targetSha256: pending.target.targetSha256, remoteSequence: 1, previousHeadRootSha256,
    headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({ previousHeadRootSha256,
      targetSha256: pending.target.targetSha256, remoteSequence: 1,
      operationSha256: pending.record.operationSha256, recordSha256: pending.record.recordSha256 }),
    record: pending.record, replayed: false };
  if (acknowledge) {
    expect(await store.recordTenantRestoreJournalPublicationTargetAck(authorization, result)).not.toBeNull();
    expect(await store.sealTenantRestoreJournalPublication(authorization)).not.toBeNull();
  }
  return { targetSha256: result.targetSha256, remoteSequence: result.remoteSequence,
    previousHeadRootSha256: result.previousHeadRootSha256, headRootSha256: result.headRootSha256, record: result.record };
}

function runtimeProof(claim: { requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string }) {
  const body = { targetSha256: tenantRuntimeTargetSha256("http://maintenance-runner.internal:8080"),
    runnerId: "maintenance-runner", bootId: "maintenance-boot", requestId: claim.requestId,
    tenantId: claim.tenantId, subjectGeneration: claim.subjectGeneration, t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 0, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 0, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 0, activeTurnCountAfter: 0 as const, completedAtMs: Date.now() };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return { fleetSha256: tenantRuntimeFleetSha256(targets), targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets), targets };
}

async function fixture(phase: Phase = "queued", options: { legacy?: boolean; unpublishedFence?: boolean } = {}) {
  const store = new MemorySessionStore({ now: () => Date.now() }, { tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  if (options.legacy) {
    const legacy = await uncapturedStepFixture(store, { tenantId: "maintenance-legacy", userId: "legacy-user" });
    await store.commit(legacy.batch);
  }
  await activateCaptureFixture(store);
  const tenantId = `maintenance-tenant-${randomUUID()}`, userId = `maintenance-user-${randomUUID()}`;
  await store.createApiKey(tenantId, `key-${randomUUID()}`, `fake-hash-${randomUUID()}`);
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({ tenantId, policyVersion: "maintenance-zero-day", actorKeyId: "fixture-admin", atMs: Date.now(),
    policy: { sessionContentRetentionMs: 0, userErasureGraceMs: 0, operationalUsageRetentionMs: 0,
      idempotencyReceiptRetentionMs: 0, billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: 60_000 } });
  await store.activateRetentionPolicy({ tenantId, policyVersion: "maintenance-zero-day", expectedControlGeneration: 0,
    actorKeyId: "fixture-admin", atMs: Date.now() });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  const captured = await captureStepFixture(store, { tenantId, userId });
  const committed = await store.commitPersistedProviderStepFailure(captured.input);
  if (phase !== "queued") {
    const claim = must((await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 60_000,
      claimToken: `maintenance-write-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
      captureMode: "include_v2", freshProof: captured.proof }))[0]);
    const authorization = { tenantId, writeOperationSha256: claim.writeOperationSha256,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
    expect(await store.reserveTenantTelemetryExternalMutation(authorization, "telemetry-s3-object-v1", captured.proof)).not.toBeNull();
    if (phase !== "reserved") expect(await store.completeTenantTelemetryWrite(authorization,
      tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", { writeOperationSha256: claim.writeOperationSha256,
        target: claim.target, inventory: claim.inventory, payload: claim.payload }, "already_present", true), captured.proof)).not.toBeNull();
  }
  await store.commit({ sessionId: captured.session.id, fence: 1,
    turn: { ...captured.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
    sessionPatch: { status: { type: "idle" } } });
  const remoteEntries: Awaited<ReturnType<typeof journalPublication>>[] = [];
  let unpublished: Awaited<ReturnType<typeof journalPublication>> | undefined;
  if (phase === "live" || phase === "usage_released" || phase === "canonical_closed") {
    const requestId = newErasureRequestId();
    await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "fixture-admin",
      idempotencyKey: `maintenance-erasure-${randomUUID()}`, requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
    remoteEntries.push(await journalPublication(store, requestId));
    const credential = must((await store.claimTenantCredentialRevocations({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-credential" }))[0]);
    expect(await store.revokeTenantCredentialMaterial(baseAuth(credential))).not.toBeNull();
    expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 1 })).toBe(1);
    const runtime = must((await store.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-runtime" }))[0]);
    expect(await store.completeTenantRuntimeRevocation(baseAuth(runtime), runtimeProof(runtime))).not.toBeNull();
    expect(await store.materializeTenantContentInventoryJobs({ limit: 1 })).toBe(1);
    const inventory = must((await store.claimTenantContentInventories({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-inventory" }))[0]);
    const inventoryAuth = { ...baseAuth(inventory), buildGeneration: inventory.buildGeneration };
    await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 });
    expect(await store.sealTenantContentInventory(inventoryAuth)).not.toBeNull();
    expect(await store.materializeTenantPurgePlanJobs({ limit: 1 })).toBe(1);
    const plan = must((await store.claimTenantPurgePlans({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-plan" }))[0]);
    expect(await store.sealTenantPurgePlan({ ...baseAuth(plan), buildGeneration: plan.buildGeneration })).not.toBeNull();
    if (phase !== "live") {
      expect(await store.materializeTenantPurgeExecutionJobs({ limit: 1 })).toBe(1);
      const execution = must((await store.claimTenantPurgeExecutions({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-execution" }))[0]);
      const executionAuth = { ...baseAuth(execution), planBuildGeneration: execution.planBuildGeneration,
        executionGeneration: execution.executionGeneration };
      expect(await store.executeTenantPurgeLocalCutover(executionAuth)).not.toBeNull();
      if (phase === "canonical_closed") {
        expect(await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).not.toBeNull();
        expect(await store.materializeTenantDatabasePurgeJobs({ limit: 1 })).toBe(1);
        const database = must((await store.claimTenantDatabasePurges({ limit: 1, leaseMs: 60_000, claimToken: "maintenance-database" }))[0]);
        expect(await store.executeTenantDatabasePurge({ ...baseAuth(database), planBuildGeneration: database.planBuildGeneration,
          executionGeneration: database.executionGeneration, databasePurgeGeneration: database.databasePurgeGeneration })).not.toBeNull();
      }
    }
  }
  if (options.unpublishedFence) {
    const extraTenant = `maintenance-extra-${randomUUID()}`;
    await store.createApiKey(extraTenant, `key-${randomUUID()}`, `fake-hash-${randomUUID()}`);
    const requestId = newErasureRequestId();
    await store.requestTenantErasure({ requestId, tenantId: extraTenant, requestedByKeyId: "fixture-admin",
      idempotencyKey: `maintenance-extra-${randomUUID()}`, requestHash: tenantErasureRequestHash(extraTenant), atMs: Date.now() });
    unpublished = await journalPublication(store, requestId, false);
  }
  await store.activateBlobStorageControl({ expectedControlGeneration: 0, storageBackend: "memory-v1", namespaceSha256: sha("maintenance-blob") });
  const adapter = new MemoryTenantBackupCatalogAdapter({ nonProductionFixture: true,
    namespaceId: "maintenance-catalog", targetId: "maintenance-target", failureDomainId: "in-process-not-durable" });
  const journal = await store.getTenantRestoreJournalControl();
  if (journal.controlGeneration !== 1) throw new Error("maintenance fixture journal inactive");
  const control = (await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
    adapterProtocol: adapter.adapterProtocol, catalogNamespaceSha256: adapter.catalogNamespaceSha256,
    catalogTargetSha256: adapter.catalogTargetSha256, failureDomainSha256: adapter.failureDomainSha256,
    logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: journal.evidenceSha256,
    retentionPolicySha256: sha("maintenance-backup-retention"), minimumRetentionMs: 1_000, minimumRecoverableBackups: 1 })).value;
  const backupId = newTenantBackupId();
  const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId, controlEvidenceSha256: control.evidenceSha256 })).value;
  const record = must(await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
    fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).value;
  const entry = (await store.recordTenantBackupCatalogAvailability(await adapter.publishAvailability({
    backupId, anchorSha256: anchor.anchorSha256, sourceSnapshotSha256: sha("maintenance-snapshot"),
    sourceBackupSha256: sha("maintenance-backup"), artifactManifestSha256: sha("maintenance-manifest"),
    providerEvidenceSha256: sha("maintenance-provider"), controlEvidenceSha256: control.evidenceSha256,
    logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, retentionPolicySha256: control.retentionPolicySha256,
    retentionUntilDbMs: anchor.retentionUntilDbMs, registeredAtDbMs: anchor.createdAtDbMs }))).value;
  const restoreRunId = `restore_${randomUUID()}`, runtimeEpochSha256 = sha(`maintenance-new-${restoreRunId}`);
  const reservation = await adapter.reserveRestore({ backupId, restoreRunId, entrySha256: entry.entrySha256, runtimeEpochSha256 });
  const prepared = await store.prepareTenantRestoreReplayFromBackup({ backupId, restoreRunId, runtimeEpochSha256,
    controlEvidenceSha256: journal.evidenceSha256, sealedTargets: await store.getTenantRestoreRuntimeHeads(), reservation,
    captureCheckpointSha256: record.checkpoint.checkpointSha256 });
  const selector: TenantTelemetryCaptureRestoreMaintenanceSelector = { backupId, restoreRunId,
    checkpointSha256: record.checkpoint.checkpointSha256, artifactManifestSha256: entry.artifactManifestSha256,
    sourceSnapshotSha256: entry.sourceSnapshotSha256, providerEvidenceSha256: entry.providerEvidenceSha256,
    reservationSha256: prepared.value.reservation.reservationSha256,
    reservationReceiptSha256: reservation.reservationReceiptSha256,
    fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" };
  return { store, adapter, selector, record, captured, committed, remoteEntries, unpublished };
}

async function sealed(f: Awaited<ReturnType<typeof fixture>>) {
  const maintenance = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
  for (const entry of f.remoteEntries) expect(await maintenance.recordTenantRestoreReplayFence({
    restoreRunId: f.selector.restoreRunId, targetOrdinal: 0, remoteEntry: entry })).not.toBeNull();
  expect(await maintenance.sealTenantRestoreReplay(f.selector.restoreRunId)).not.toBeNull();
  return maintenance;
}
function histories(store: MemorySessionStore): Map<string, TenantTelemetryCaptureRestoreHistoryReceipt> {
  const value: unknown = Reflect.get(store, "tenantTelemetryCaptureRestoreHistories");
  if (!(value instanceof Map)) throw new Error("maintenance fixture history map missing");
  return value as Map<string, TenantTelemetryCaptureRestoreHistoryReceipt>;
}
function atomicState(store: MemorySessionStore) {
  return structuredClone({ controls: [...store.tenantRestoreRuntimeControls], heads: [...store.tenantRestoreRuntimeHeads],
    events: [...store.tenantRestoreRuntimeControlEvents], runs: [...store.tenantRestoreReplayRuns], histories: [...histories(store)] });
}

describe("Memory exact capture restore maintenance consumer", () => {
  it.each(["live", "usage_released", "canonical_closed"] as const)("atomically restores %s history through actual prepare/replay/activate without writer permission", async (phase) => {
    const f = await fixture(phase), oldActivation: unknown = structuredClone(Reflect.get(f.store, "persistedProviderCaptureActivation"));
    const maintenance = await sealed(f);
    expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toBeNull();
    const before = await maintenance.getTenantRestoreRuntimeControl();
    await expect(f.store.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration })).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
    const activated = await maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration });
    expect(activated).toMatchObject({ state: "active", lineageKind: "restore", restoreRunId: f.selector.restoreRunId });
    const history = must(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt());
    expect(history).toMatchObject({ checkpointSha256: f.selector.checkpointSha256,
      sourceProjectionRootSha256: f.record.checkpoint.projectionRootSha256,
      preservedRowCount: f.record.checkpoint.observedRowCount,
      preservedLegacyUnknownCount: f.record.checkpoint.legacyUnknownCount,
      historyReadOnly: true, writeAuthorized: false, erasureAuthorized: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(Reflect.get(f.store, "persistedProviderCaptureActivation")).toEqual(oldActivation);
    expect(await maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration })).toEqual(activated);
    expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(history);
    const reopened = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
    expect(await reopened.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(history);
    await expect(f.store.getTenantTelemetryPersistedProviderCaptureBinding()).rejects.toThrow();
    await expect(f.store.verifyPersistedProviderStepFailureSource(f.captured.lookup)).rejects.toThrow();
    expect(Object.keys(maintenance)).not.toContain("commitPersistedProviderStepFailure");
    expect(Object.keys(maintenance)).not.toContain("claimTenantTelemetryWriteJobs");
    await reopened.close(); await maintenance.close(); await f.adapter.close();
  });

  it.each(["queued", "reserved"] as const)("preserves %s and genuine legacy-unknown facts while ordinary pending writes remain rejected", async (phase) => {
    const f = await fixture(phase, { legacy: true });
    expect(f.record.checkpoint.legacyUnknownCount).toBeGreaterThan(0);
    const before = structuredClone([...f.store.tenantTelemetryWriteJobs]);
    await expect(f.store.getTenantTelemetryPersistedProviderCaptureBinding()).rejects.toThrow();
    await expect(f.store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 1_000, claimToken: "forbidden-pending-claim",
      adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: f.captured.proof })).rejects.toThrow();
    expect([...f.store.tenantTelemetryWriteJobs]).toEqual(before);
    const maintenance = await sealed(f);
    const runtime = await maintenance.getTenantRestoreRuntimeControl();
    await maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId, expectedControlGeneration: runtime.controlGeneration });
    expect((await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt())?.preservedLegacyUnknownCount)
      .toBe(f.record.checkpoint.legacyUnknownCount);
    expect([...f.store.tenantTelemetryWriteJobs]).toEqual(before);
    await maintenance.close(); await f.adapter.close();
  });

  it.each(["backupId", "restoreRunId", "checkpointSha256", "artifactManifestSha256", "sourceSnapshotSha256",
    "providerEvidenceSha256", "reservationSha256", "reservationReceiptSha256"] as const)("rejects a foreign selector %s without advancing durable state", async (field) => {
    const f = await fixture(), before = atomicState(f.store);
    const selector = { ...f.selector, [field]: field === "backupId" ? newTenantBackupId()
      : field === "restoreRunId" ? `restore_${randomUUID()}` : sha(`foreign-${field}`) };
    await expect(f.store.openTenantTelemetryCaptureRestoreMaintenance(selector)).rejects.toThrow();
    expect(atomicState(f.store)).toEqual(before);
    await f.adapter.close();
  });

  it("keeps every run-bearing method bound to the private selector and closes only the facade", async () => {
    const f = await fixture("live"), maintenance = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
    const foreign = `restore_${randomUUID()}`, before = atomicState(f.store);
    await expect(maintenance.getTenantRestoreReplayRun(foreign)).rejects.toThrow();
    await expect(maintenance.getTenantRestoreReplaySealedTargets(foreign)).rejects.toThrow();
    await expect(maintenance.listTenantRestoreReplayEntries(foreign, { limit: 1 })).rejects.toThrow();
    await expect(maintenance.recordTenantRestoreReplayFence({ restoreRunId: foreign, targetOrdinal: 0,
      remoteEntry: must(f.remoteEntries[0]) })).rejects.toThrow();
    await expect(maintenance.sealTenantRestoreReplay(foreign)).rejects.toThrow();
    await expect(maintenance.abortTenantRestoreReplay(foreign)).rejects.toThrow();
    await expect(maintenance.getTenantRestoreReplayReceipt(foreign)).rejects.toThrow();
    await expect(maintenance.activateTenantRestoreRuntime({ restoreRunId: foreign, expectedControlGeneration: 1 })).rejects.toThrow();
    expect(atomicState(f.store)).toEqual(before);
    await maintenance.close(); await maintenance.close();
    await expect(maintenance.getTenantRestoreRuntimeControl()).rejects.toThrow();
    expect(await f.store.getTenantRestoreReplayRun(f.selector.restoreRunId)).not.toBeNull();
    await f.adapter.close();
  });

  it("clones a first-selected/second-foreign run getter once before checking and forwarding a replay-fence input", async () => {
    const f = await fixture("live"), maintenance = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
    const foreign = `restore_${randomUUID()}`, remoteEntry = structuredClone(must(f.remoteEntries[0]));
    const originalHead = remoteEntry.headRootSha256;
    let runReads = 0;
    const input = { get restoreRunId() { runReads++; return runReads === 1 ? f.selector.restoreRunId : foreign; },
      targetOrdinal: 0, remoteEntry };
    const forwarded = vi.spyOn(f.store, "recordTenantRestoreReplayFence");
    const pending = maintenance.recordTenantRestoreReplayFence(input);
    remoteEntry.headRootSha256 = sha("caller-changed-after-clone");
    const recorded = must(await pending);
    expect(runReads).toBe(1);
    expect(recorded.restoreRunId).toBe(f.selector.restoreRunId);
    expect(recorded.headRootSha256).toBe(originalHead);
    expect(forwarded).toHaveBeenCalledTimes(1);
    const staged = must(forwarded.mock.calls[0]?.[0]);
    expect(staged).not.toBe(input);
    const descriptor = must(Object.getOwnPropertyDescriptor(staged, "restoreRunId"));
    expect(descriptor.value).toBe(f.selector.restoreRunId);
    expect("get" in descriptor).toBe(false);
    expect(staged.remoteEntry).not.toBe(remoteEntry);
    expect(staged.remoteEntry.headRootSha256).toBe(originalHead);
    expect(await f.store.getTenantRestoreReplayRun(foreign)).toBeNull();
    expect((await maintenance.getTenantRestoreReplayRun(f.selector.restoreRunId))?.entryCount).toBe(1);
    await maintenance.close(); await f.adapter.close();
  });

  it("clones a first-selected/second-foreign run getter once before checking and activating its bound run", async () => {
    const f = await fixture(), maintenance = await sealed(f), before = await maintenance.getTenantRestoreRuntimeControl();
    const foreign = `restore_${randomUUID()}`;
    let runReads = 0;
    const input = { get restoreRunId() { runReads++; return runReads === 1 ? f.selector.restoreRunId : foreign; },
      expectedControlGeneration: before.controlGeneration };
    const pending = maintenance.activateTenantRestoreRuntime(input);
    input.expectedControlGeneration = Number.MAX_SAFE_INTEGER;
    const activated = await pending;
    expect(runReads).toBe(1);
    expect(activated).toMatchObject({ state: "active", lineageKind: "restore", restoreRunId: f.selector.restoreRunId,
      controlGeneration: before.controlGeneration + 1 });
    expect(await f.store.getTenantRestoreReplayRun(foreign)).toBeNull();
    expect([...histories(f.store).keys()]).toEqual([f.selector.restoreRunId]);
    expect((await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt())?.restoreRunId).toBe(f.selector.restoreRunId);
    await maintenance.close(); await f.adapter.close();
  });

  it("rolls a late history-map publication failure back with all runtime maps and permits exact retry", async () => {
    const f = await fixture(), maintenance = await sealed(f), map = histories(f.store);
    const before = atomicState(f.store), runtime = await maintenance.getTenantRestoreRuntimeControl();
    const set = map.set.bind(map);
    vi.spyOn(map, "set").mockImplementationOnce((key, value) => { set(key, value); throw new Error("maintenance late history publication"); });
    const input = { restoreRunId: f.selector.restoreRunId, expectedControlGeneration: runtime.controlGeneration };
    await expect(maintenance.activateTenantRestoreRuntime(input)).rejects.toThrow("maintenance late history publication");
    expect(atomicState(f.store)).toEqual(before);
    expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toBeNull();
    expect(await maintenance.activateTenantRestoreRuntime(input)).toMatchObject({ lineageKind: "restore" });
    await maintenance.close(); await f.adapter.close();
  });

  it("converges two exact maintenance activations into one immutable history and runtime event", async () => {
    const f = await fixture(), first = await sealed(f), second = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
    const before = await first.getTenantRestoreRuntimeControl(), eventCount = f.store.tenantRestoreRuntimeControlEvents.size;
    const input = { restoreRunId: f.selector.restoreRunId, expectedControlGeneration: before.controlGeneration };
    const results = await Promise.all([first.activateTenantRestoreRuntime(input), second.activateTenantRestoreRuntime(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(histories(f.store).size).toBe(1);
    expect(f.store.tenantRestoreRuntimeControlEvents.size).toBe(eventCount + 1);
    expect(await first.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(await second.getTenantTelemetryCaptureRestoreHistoryReceipt());
    await first.close(); await second.close(); await f.adapter.close();
  });

  it("does not reconstruct a deleted history receipt from an already active runtime", async () => {
    const f = await fixture(), maintenance = await sealed(f), before = await maintenance.getTenantRestoreRuntimeControl();
    await maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration });
    expect(histories(f.store).delete(f.selector.restoreRunId)).toBe(true);
    const state = atomicState(f.store);
    await expect(maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).rejects.toThrow();
    await expect(f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector)).rejects.toThrow();
    await expect(maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration })).rejects.toThrow();
    expect(atomicState(f.store)).toEqual(state);
    await maintenance.close(); await f.adapter.close();
  });

  it("can abort only its actual prepared run without issuing history or write permission", async () => {
    const f = await fixture(), maintenance = await f.store.openTenantTelemetryCaptureRestoreMaintenance(f.selector);
    expect(await maintenance.abortTenantRestoreReplay(f.selector.restoreRunId)).toBe(true);
    expect(await f.store.getTenantRestoreReplayRun(f.selector.restoreRunId)).toMatchObject({ phase: "aborted" });
    expect(histories(f.store).size).toBe(0);
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(f.selector.backupId)).toEqual(f.record);
    await expect(maintenance.getTenantRestoreRuntimeControl()).rejects.toThrow();
    await maintenance.close(); await f.adapter.close();
  });

  it.each(["history", "outbound-runtime"] as const)("publishes nothing when preparing the %s clone fails", async (kind) => {
    const f = await fixture(), maintenance = await sealed(f), before = atomicState(f.store);
    const runtime = await maintenance.getTenantRestoreRuntimeControl(), original = globalThis.structuredClone;
    let runtimeClones = 0;
    const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation(function <T>(value: T): T {
      if (value !== null && typeof value === "object") {
        const scope: unknown = Reflect.get(value, "scope"), lineage: unknown = Reflect.get(value, "lineageKind"),
          update: unknown = Reflect.get(value, "updateKind");
        if (lineage === "restore" && update === "restore_activation") runtimeClones++;
        if ((kind === "history" && scope === "tenant-telemetry-capture-restore-history-v1")
          || (kind === "outbound-runtime" && runtimeClones === 2)) throw new Error("maintenance outbound clone failure");
      }
      return original(value);
    });
    await expect(maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: runtime.controlGeneration })).rejects.toThrow("maintenance outbound clone failure");
    spy.mockRestore();
    expect(atomicState(f.store)).toEqual(before);
    expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toBeNull();
    await maintenance.close(); await f.adapter.close();
  });

  it("revalidates immutable source bytes and binding sidecars on every maintenance read", async () => {
    const f = await fixture(), maintenance = await sealed(f), item = must(f.store.items.get(f.captured.item.id));
    if (item.type !== "agentMessage") throw new Error("maintenance fixture source item missing");
    const text = item.text; item.text = "changed after checkpoint";
    await expect(maintenance.getTenantRestoreReplayRun(f.selector.restoreRunId)).rejects.toThrow();
    item.text = text;
    const bindings: unknown = Reflect.get(f.store, "tenantTelemetryCaptureRestoreBackupBindings");
    if (!(bindings instanceof Map)) throw new Error("maintenance fixture sidecar map missing");
    const original: unknown = bindings.get(f.selector.restoreRunId);
    expect(bindings.delete(f.selector.restoreRunId)).toBe(true);
    await expect(maintenance.getTenantRestoreRuntimeHeads()).rejects.toThrow();
    bindings.set(f.selector.restoreRunId, original);
    expect(await maintenance.getTenantRestoreReplayRun(f.selector.restoreRunId)).toMatchObject({ phase: "replay_sealed" });
    await maintenance.close(); await f.adapter.close();
  });

  it("binds history to the immutable activation event rather than a legally advanced current head", async () => {
    const f = await fixture("queued", { unpublishedFence: true }), maintenance = await sealed(f);
    const before = await maintenance.getTenantRestoreRuntimeControl();
    const activated = await maintenance.activateTenantRestoreRuntime({ restoreRunId: f.selector.restoreRunId,
      expectedControlGeneration: before.controlGeneration });
    if (activated.state !== "active") throw new Error("maintenance fixture runtime inactive");
    const history = must(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt());
    // The remote metadata fixture contains a genuine local T1 record captured
    // before backup, but this is not a real external journal durability proof.
    const advanced = await f.store.assertTenantRestoreRuntimeJournalEntryKnown({
      runtimeEpochSha256: activated.runtimeEpochSha256, controlEvidenceSha256: activated.controlEvidenceSha256,
      expectedControlGeneration: activated.controlGeneration, targetOrdinal: 0, remoteEntry: must(f.unpublished) });
    expect(advanced.controlGeneration).toBeGreaterThan(activated.controlGeneration);
    expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(history);
    expect((await maintenance.getTenantRestoreRuntimeControl()).controlGeneration).toBe(advanced.controlGeneration);
    await maintenance.close(); await f.adapter.close();
  });
});
