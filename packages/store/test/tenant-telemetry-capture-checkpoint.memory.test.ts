import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, newTenantBackupId, tenantTelemetryWriteAdapterResult } from "../src/index.js";
import * as BackupCatalog from "../src/backup-catalog.js";
import { tenantBackupAvailabilityReceiptSha256, tenantBackupReservationReceiptSha256 } from "../src/backup-catalog-adapter/common.js";
import { EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 } from "../src/tenant-restore-journal.js";
import { TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES, assertTenantTelemetryCaptureCheckpointLeaves,
  tenantTelemetryCaptureCheckpointOpaqueDigest, type TenantTelemetryCaptureCheckpointFamily } from "../src/tenant-telemetry-capture-restore.js";
import type { TenantTelemetryCaptureBackupCheckpointRecord, TenantTelemetryCaptureRestoreBackupBinding } from "../src/tenant-telemetry-capture-restore-store.js";
import { activateCaptureFixture, captureRefKey, captureCurrentStepFixture as captureStepFixture, uncapturedCurrentStepFixture as uncapturedStepFixture } from "./persisted-provider-capture.fixture.js";
import { admitCaptureFixtureInput, currentCaptureMemorySnapshot } from "./fixtures/capture-current-authority.js";
import { mkSession, newId } from "./conformance.js";

// Memory reference semantics only. Fake journal/catalog descriptors and ACK below do not prove
// MySQL rows, physical backup bytes, real S3 durability, stopped-fleet reachability or restoration.
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function checkpointMap(store: MemorySessionStore): Map<string, TenantTelemetryCaptureBackupCheckpointRecord> {
  const value: unknown = Reflect.get(store, "tenantTelemetryCaptureBackupCheckpoints");
  if (!(value instanceof Map)) throw new Error("checkpoint reference map missing");
  return value as Map<string, TenantTelemetryCaptureBackupCheckpointRecord>;
}
function failureClassMap(store: MemorySessionStore): Map<string, {
  classification: "runtime_unknown" | "provider_step_error"; generation: 0 | 1; operationSha256?: string;
}> {
  const value: unknown = Reflect.get(store, "persistedProviderFailureClasses");
  if (!(value instanceof Map)) throw new Error("checkpoint failure classification reference map missing");
  return value as Map<string, { classification: "runtime_unknown" | "provider_step_error";
    generation: 0 | 1; operationSha256?: string }>;
}
async function fixture(options: { enabled?: boolean; legacy?: boolean; legacyUsage?: boolean; capture?: boolean } = {}) {
  let clockFloor = 0;
  const store = new MemorySessionStore({ now: () => Math.max(Date.now(), clockFloor) }, {
    tenantTelemetryRefKey: captureRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true,
    ...(options.enabled === false ? {} : { tenantTelemetryCaptureRestoreLocalOnly: true }),
  });
  if (options.legacy || options.legacyUsage) {
    const old = await uncapturedStepFixture(store, { tenantId: "legacy-checkpoint-tenant", userId: "legacy-checkpoint-user" });
    await store.commit(old.lease.admit({ ...old.batch }));
    await old.lease.release();
    if (options.legacyUsage) {
      // Reference-only historical NULL usage-id shape, not a frozen old-binary/SQL migration proof.
      const row = store.usageLedger[0]!;
      if (row.usageId) store.billingUsageFacts.delete(row.usageId);
      delete row.usageId;
    }
  }
  if (options.capture !== false) await activateCaptureFixture(store);
  else {
    const target = { targetOrdinal: 0, targetSha256: sha("inactive-journal-target"), failureDomainSha256: sha("inactive-journal-domain"),
      adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: sha("inactive-journal-namespace") };
    const logicalDatabaseNamespaceSha256 = sha("inactive-journal-database");
    await store.activateTenantRestoreJournalControl({ adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256, logicalDatabaseNamespaceSha256,
      runtimeEpochSha256: sha("inactive-primary-epoch"), targets: [target], observedHeads: [{ ...target,
        logicalDatabaseNamespaceSha256, sealedRemoteSequence: 0, sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
  }
  const journal = await store.getTenantRestoreJournalControl();
  if (journal.controlGeneration !== 1) throw new Error("checkpoint journal fixture inactive");
  await store.activateBlobStorageControl({ expectedControlGeneration: 0, storageBackend: "memory-v1", namespaceSha256: sha("checkpoint-memory-blob") });
  const catalog = await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
    adapterProtocol: "memory-tenant-backup-catalog-v1", catalogNamespaceSha256: sha("checkpoint-catalog-namespace"),
    catalogTargetSha256: sha("checkpoint-catalog-target"), failureDomainSha256: sha("checkpoint-catalog-domain"),
    logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: journal.evidenceSha256,
    retentionPolicySha256: sha("checkpoint-retention"), minimumRetentionMs: 1_000, minimumRecoverableBackups: 1 });
  async function anchor() {
    const backupId = newTenantBackupId();
    await store.createTenantBackupSnapshotAnchor({ backupId, controlEvidenceSha256: catalog.value.evidenceSha256 });
    return { backupId, fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const };
  }
  return { store, anchor, journal, catalog: catalog.value, advance() { clockFloor = Math.max(Date.now(), clockFloor) + 1_000; } };
}
type CheckpointFixture = Awaited<ReturnType<typeof fixture>>;
function restoreBindingMap(store: MemorySessionStore): Map<string, TenantTelemetryCaptureRestoreBackupBinding> {
  const value: unknown = Reflect.get(store, "tenantTelemetryCaptureRestoreBackupBindings");
  if (!(value instanceof Map)) throw new Error("checkpoint restore binding reference map missing");
  return value as Map<string, TenantTelemetryCaptureRestoreBackupBinding>;
}
function eventProof(eventType: "backup_recoverable" | "restore_reserved", operationSha256: string, receiptSha256: string,
  catalogSequence: number, previousCatalogEventRootSha256: string) {
  const catalogEventSha256 = BackupCatalog.tenantBackupCatalogEventSha256({ eventType, operationSha256, receiptSha256 });
  return { catalogSequence, previousCatalogEventRootSha256, catalogEventSha256,
    catalogEventRootSha256: BackupCatalog.tenantBackupCatalogNextEventRootSha256({ catalogSequence,
      previousCatalogEventRootSha256, catalogEventSha256 }) };
}
async function selectedBackup(f: CheckpointFixture, seal = true) {
  const input = await f.anchor();
  const checkpoint = seal ? await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input) : null;
  const anchor = (await f.store.getTenantBackupSnapshotAnchor(input.backupId))!;
  const control = f.catalog;
  const adapter = { adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
    catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256 };
  // Explicit nonproduction metadata adapter fixture: no encrypted SQL bytes or v2 manifest is
  // generated here. The real artifact reader must authenticate its explicit checkpoint field.
  const availability = { backupId: anchor.backupId, anchorSha256: anchor.anchorSha256,
    sourceSnapshotSha256: sha("checkpoint-selected-snapshot"), sourceBackupSha256: sha("checkpoint-selected-backup"),
    artifactManifestSha256: sha("checkpoint-selected-manifest"), providerEvidenceSha256: sha("checkpoint-selected-provider"),
    controlEvidenceSha256: control.evidenceSha256, logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
    retentionPolicySha256: control.retentionPolicySha256, retentionUntilDbMs: anchor.retentionUntilDbMs,
    registeredAtDbMs: anchor.createdAtDbMs, catalogNamespaceSha256: control.catalogNamespaceSha256,
    catalogTargetSha256: control.catalogTargetSha256 };
  const operation = BackupCatalog.tenantBackupAvailabilityOperationSha256(availability);
  const receipt = tenantBackupAvailabilityReceiptSha256(adapter, availability, operation);
  const availabilityEvidence = { ...adapter, ...availability,
    availabilityOperationSha256: operation, availabilityReceiptSha256: receipt,
    ...eventProof("backup_recoverable", operation, receipt, anchor.sourceCatalogSequence + 1, anchor.sourceCatalogEventRootSha256) };
  const availabilityResult: BackupCatalog.TenantBackupAvailabilityAdapterResult = { ...availabilityEvidence,
    entrySha256: BackupCatalog.tenantBackupCatalogEntrySha256({
      scope: BackupCatalog.TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
      protocol: BackupCatalog.TENANT_BACKUP_CATALOG_PROTOCOL, ...availabilityEvidence,
    }) };
  const entry = (await f.store.recordTenantBackupCatalogAvailability(availabilityResult)).value;
  const restoreRunId = `restore_${randomUUID()}`, runtimeEpochSha256 = sha(`checkpoint-restored-${randomUUID()}`);
  const identity = { backupId: entry.backupId, restoreRunId, entrySha256: entry.entrySha256, runtimeEpochSha256 };
  const reservationOperationSha256 = BackupCatalog.tenantBackupRuntimeReservationOperationSha256(identity);
  const reservationReceiptSha256 = tenantBackupReservationReceiptSha256(adapter, identity, reservationOperationSha256);
  const prepare: BackupCatalog.PrepareTenantRestoreReplayFromBackupInput = {
    backupId: entry.backupId, restoreRunId, runtimeEpochSha256, controlEvidenceSha256: f.journal.evidenceSha256,
    sealedTargets: structuredClone(anchor.sourceRuntimeHeads), reservation: { adapterProtocol: adapter.adapterProtocol,
      catalogNamespaceSha256: adapter.catalogNamespaceSha256, catalogTargetSha256: adapter.catalogTargetSha256, ...identity,
      reservationOperationSha256, reservationReceiptSha256,
      ...eventProof("restore_reserved", reservationOperationSha256, reservationReceiptSha256, entry.catalogSequence + 1, entry.catalogEventRootSha256) },
    ...(checkpoint ? { captureCheckpointSha256: checkpoint.value.checkpoint.checkpointSha256 } : {}),
  };
  const preflight: BackupCatalog.PreflightTenantRestoreReplayFromBackupInput = { backupId: prepare.backupId,
    restoreRunId, runtimeEpochSha256, ...(checkpoint ? { captureCheckpointSha256: checkpoint.value.checkpoint.checkpointSha256 } : {}) };
  return { input, checkpoint, anchor, entry, prepare, preflight };
}
function family(record: TenantTelemetryCaptureBackupCheckpointRecord, wanted: TenantTelemetryCaptureCheckpointFamily) {
  const found = record.checkpoint.families.find((row) => row.family === wanted);
  if (!found) throw new Error("fixed checkpoint family missing");
  return found;
}
async function sourceState(store: MemorySessionStore, phase: "queued" | "reserved" | "written") {
  const h = await captureStepFixture(store, { tenantId: `checkpoint-${phase}-tenant`, userId: `checkpoint-${phase}-user` });
  const committed = await store.commitPersistedProviderStepFailure(admitCaptureFixtureInput(h));
  if (phase !== "queued") {
    const [claim] = await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000, claimToken: `checkpoint-${phase}-claim`,
      adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: h.proof });
    if (!claim) throw new Error("checkpoint write claim missing");
    const auth = { tenantId: claim.tenantId, writeOperationSha256: claim.writeOperationSha256,
      claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
    expect(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", h.proof)).not.toBeNull();
    if (phase === "written") expect(await store.completeTenantTelemetryWrite(auth, tenantTelemetryWriteAdapterResult(
      "telemetry-s3-object-v1", { writeOperationSha256: claim.writeOperationSha256, target: claim.target,
        inventory: claim.inventory, payload: claim.payload }, "already_present", true), h.proof)).not.toBeNull();
  }
  return { ...h, committed };
}

describe("Memory active-capture checkpoint actual consumer", () => {
  it("returns null for verified inactive default configuration without publishing evidence", async () => {
    const store = new MemorySessionStore();
    expect(await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId: newTenantBackupId(),
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).toBeNull();
    expect(checkpointMap(store).size).toBe(0);
  });
  it("keeps active capture checkpoint permission default-off", async () => {
    const f = await fixture({ enabled: false });
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(await f.anchor())).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("seals all 49 families including explicit empties and fixed false authority", async () => {
    const f = await fixture(), input = await f.anchor();
    const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input);
    expect(sealed?.disposition).toBe("created");
    const record = sealed!.value;
    expect(record.checkpoint.families.map((row) => row.family)).toEqual(TENANT_TELEMETRY_CAPTURE_CHECKPOINT_FAMILIES);
    expect(record.checkpoint).toMatchObject({ sourceRuntimeLineageKind: "primary", sourceHistoryReceiptSha256: null,
      sourceCaptureCutoverReceiptSha256: null, executionReady: false, externalAuthorityVerified: false,
      erasureAuthorized: false, allDomainsComplete: false, contentPurgeExecuted: false });
    expect(family(record, "capture_control")).toMatchObject({ rowCount: 2, states: { active: 1, inactive: 1 } });
    expect(family(record, "write_job")).toMatchObject({ rowCount: 0, sourceHighWaterDbMs: 0 });
    expect(family(record, "retained_canonical_receipt").rowCount).toBe(0);
    assertTenantTelemetryCaptureCheckpointLeaves(record.checkpoint, record.leaves, captureRefKey);
    const control = f.store.tenantTelemetryLifecycleControls.get(1)!;
    // Independently prove this backend's actual envelope. It deliberately cannot authenticate
    // mysql-v1 physical bytes even if they happen to have the same logical control fields.
    const canonical = (value: unknown): string => {
      const normalized = JSON.parse(JSON.stringify(value)) as unknown;
      const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([key, field]) => [key, sort(field)])) : v;
      return JSON.stringify(sort(normalized));
    };
    const leaf = record.leaves.find((row) => row.family === "lifecycle_control")!;
    expect(leaf.recordHmacSha256).toBe(tenantTelemetryCaptureCheckpointOpaqueDigest("lifecycle_control", "record",
      Buffer.from(canonical({ backend: "memory-v1", physicalKey: 1, record: control })), captureRefKey));
    expect(leaf.recordHmacSha256).not.toBe(tenantTelemetryCaptureCheckpointOpaqueDigest("lifecycle_control", "record",
      Buffer.from(canonical({ backend: "mysql-v1", physicalKey: 1, record: control })), captureRefKey));
  });
  it.each(["queued", "reserved", "written"] as const)("preserves actual %s graph rather than requiring all ACKs", async (phase) => {
    const f = await fixture();
    const source = await sourceState(f.store, phase);
    const input = await f.anchor(), sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input);
    const record = sealed!.value;
    expect(family(record, "write_job")).toMatchObject({ rowCount: 1, states: { [phase]: 1 } });
    expect(family(record, "write_payload").rowCount).toBe(phase === "written" ? 0 : 1);
    expect(family(record, "write_reservation").rowCount).toBe(phase === "queued" ? 0 : 1);
    expect(family(record, "write_ack").rowCount).toBe(phase === "written" ? 1 : 0);
    expect(family(record, "provider_source_binding").rowCount).toBe(1);
    expect(family(record, "provider_failure_commit").rowCount).toBe(1);
    expect(family(record, "canonical_item").rowCount).toBe(1);
    expect(family(record, "canonical_event").rowCount).toBe(4);
    const bytes = JSON.stringify(record);
    for (const forbidden of [source.session.id, source.session.tenantId, source.session.userId, source.turn.id,
      source.item.id, "private partial assistant content", "unit"]) expect(bytes).not.toContain(forbidden);
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toEqual(record);
  });
  it("retains real legacy NULL/gen0 item and completion event as unknown without manufacturing managed sources", async () => {
    const f = await fixture({ legacy: true });
    const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(await f.anchor());
    expect(family(sealed!.value, "legacy_failure")).toMatchObject({ rowCount: 2, legacyUnknownCount: 2, states: { legacy_unknown: 2 } });
    expect(family(sealed!.value, "provider_source_binding").rowCount).toBe(0);
    expect(family(sealed!.value, "lifecycle_coverage").legacyUnknownCount).toBe(1);
  });
  it("keeps an owner-correct legacy usage row without a usage ID as explicit unknown", async () => {
    const f = await fixture({ legacyUsage: true });
    expect(f.store.usageLedger[0]?.usageId).toBeUndefined();
    const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(await f.anchor());
    expect(family(sealed!.value, "operational_usage")).toMatchObject({ rowCount: 1, legacyUnknownCount: 1 });
    expect(family(sealed!.value, "legacy_failure").rowCount).toBe(2);
  });
  it("preserves same-owner legacy usage with a synthetic missing turn as unknown", async () => {
    const f = await fixture({ legacyUsage: true });
    const row = f.store.usageLedger[0]!;
    row.turnId = newId("turn");
    expect(f.store.turns.has(row.turnId)).toBe(false);
    expect(f.store.sessions.get(row.sessionId)).toMatchObject({ tenantId: row.tenantId, userId: row.userId });
    const sealed = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(await f.anchor());
    expect(family(sealed!.value, "operational_usage")).toMatchObject({ rowCount: 1, legacyUnknownCount: 1 });
  });
  it("rejects a modern usage user mismatch even though its anonymous billing fact is unchanged", async () => {
    const f = await fixture(); await sourceState(f.store, "queued");
    const facts = structuredClone([...f.store.billingUsageFacts]);
    f.store.usageLedger[0]!.userId = "foreign-usage-user";
    const input = await f.anchor();
    expect([...f.store.billingUsageFacts]).toEqual(facts);
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("rejects a legacy usage tenant mismatch rather than sealing the orphan as valid unknown", async () => {
    const f = await fixture({ legacyUsage: true });
    f.store.usageLedger[0]!.tenantId = "foreign-legacy-usage-tenant";
    const input = await f.anchor();
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("replays the exact stored checkpoint when only observation time advances", async () => {
    const f = await fixture(), input = await f.anchor();
    const original = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input);
    f.advance();
    expect(await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).toEqual({ disposition: "exact_replay", value: original!.value });
    await f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...input, checkpointSha256: original!.value.checkpoint.checkpointSha256 });
  });
  it("rejects before/after-dump drift while historical get remains independently readable", async () => {
    const f = await fixture(), input = await f.anchor();
    const original = await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input);
    await f.store.createSession(mkSession("checkpoint-later-tenant", "checkpoint-later-user"));
    await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...input,
      checkpointSha256: original!.value.checkpoint.checkpointSha256 })).rejects.toThrow();
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toEqual(original!.value);
  });
  it("rejects an orphan provider classification rather than silently omitting it from the physical families", async () => {
    const f = await fixture(), input = await f.anchor();
    const itemId = newId("item"), operationSha256 = sha("checkpoint-ghost-provider-operation");
    failureClassMap(f.store).set(itemId, { classification: "provider_step_error", generation: 1, operationSha256 });
    expect(f.store.items.has(itemId)).toBe(false);
    expect(f.store.tenantTelemetryWriteJobs.has(operationSha256)).toBe(false);
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("rejects a post-seal orphan classification as source drift while preserving the immutable historical read", async () => {
    const f = await fixture(), input = await f.anchor();
    const original = (await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input))!.value;
    failureClassMap(f.store).set(newId("item"), { classification: "provider_step_error", generation: 1,
      operationSha256: sha("checkpoint-later-ghost-provider-operation") });
    await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...input,
      checkpointSha256: original.checkpoint.checkpointSha256 })).rejects.toThrow();
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toEqual(original);
    expect(checkpointMap(f.store).size).toBe(1);
  });
  it("does not accept a caller-supplied header or leaves", async () => {
    const f = await fixture(), input = await f.anchor();
    const callerLeaves = { ...input, leaves: [] }, callerHeader = { ...input, checkpoint: {} };
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(callerLeaves)).rejects.toThrow();
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(callerHeader)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("rejects a missing anchor and a wrong checkpoint digest", async () => {
    const f = await fixture();
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId: newTenantBackupId(),
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).rejects.toThrow();
    const input = await f.anchor(); await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input);
    await expect(f.store.assertTenantTelemetryCaptureBackupCheckpointUnchanged({ ...input, checkpointSha256: sha("wrong") })).rejects.toThrow();
  });
  it("atomically rolls back a throw after checkpoint map publication", async () => {
    const f = await fixture(), input = await f.anchor(), map = checkpointMap(f.store);
    const original = map.set.bind(map);
    vi.spyOn(map, "set").mockImplementationOnce((key, value) => { original(key, value); throw new Error("checkpoint fixture late publication failure"); });
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow("checkpoint fixture late publication failure");
    expect(map.size).toBe(0); expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toBeNull();
    expect((await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input))?.disposition).toBe("created");
  });
  it("does not publish when the second checkpoint clone fails while preparing the outbound result", async () => {
    const f = await fixture(), input = await f.anchor(), map = checkpointMap(f.store);
    const originalClone = globalThis.structuredClone;
    let checkpointClones = 0;
    const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation(function <T>(value: T): T {
      if (value !== null && typeof value === "object" && Object.hasOwn(value, "checkpoint") && Object.hasOwn(value, "leaves")) {
        checkpointClones++;
        if (checkpointClones === 2) throw new Error("checkpoint fixture outbound clone failure");
      }
      return originalClone(value);
    });
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow("checkpoint fixture outbound clone failure");
    expect(checkpointClones).toBe(2);
    expect(map.size).toBe(0); expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toBeNull();
    spy.mockRestore();
    expect((await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input))?.disposition).toBe("created");
  });
  it("serializes concurrent seals into one created value and one exact replay", async () => {
    const f = await fixture(), input = await f.anchor();
    const values = await Promise.all([f.store.sealTenantTelemetryCaptureBackupCheckpoint(input), f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)]);
    expect(values.map((row) => row?.disposition).sort()).toEqual(["created", "exact_replay"]);
    expect(values[0]!.value).toEqual(values[1]!.value); expect(checkpointMap(f.store).size).toBe(1);
  });
  it("returns defensive historical clones and rejects stored leaf corruption or key replacement", async () => {
    const f = await fixture(), input = await f.anchor();
    const original = (await f.store.sealTenantTelemetryCaptureBackupCheckpoint(input))!.value;
    const returned = (await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId))!;
    returned.leaves[0]!.recordHmacSha256 = sha("caller-only-change");
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).toEqual(original);
    checkpointMap(f.store).get(input.backupId)!.leaves[0]!.recordHmacSha256 = sha("stored-corruption");
    await expect(f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).rejects.toThrow();
    checkpointMap(f.store).set(input.backupId, structuredClone(original));
    Reflect.set(f.store, "tenantTelemetryRefKey", new Uint8Array(32).fill(4));
    await expect(f.store.getTenantTelemetryCaptureBackupCheckpoint(input.backupId)).rejects.toThrow();
  });
  it.each(["owner", "canonical_item", "payload"] as const)("rejects actual %s source corruption before publication", async (kind) => {
    const f = await fixture(), source = await sourceState(f.store, "queued"), input = await f.anchor();
    if (kind === "owner") f.store.sessions.get(source.session.id)!.userId = "foreign-checkpoint-user";
    if (kind === "canonical_item") {
      const item = f.store.items.get(source.item.id)!;
      if (item.type !== "agentMessage") throw new Error("checkpoint fixture failed item missing");
      item.text = "altered without changing sealed source";
    }
    if (kind === "payload") f.store.tenantTelemetryWritePayloads.delete(source.committed.failureCommitReceipt.writeOperationSha256);
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("does not downgrade missing active capture evidence to an inactive checkpoint", async () => {
    const f = await fixture(); await sourceState(f.store, "queued"); const input = await f.anchor();
    Reflect.set(f.store, "persistedProviderCaptureActivation", undefined);
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
  it("refuses production despite explicit local-only ACKs and option", async () => {
    const f = await fixture(), input = await f.anchor(); vi.stubEnv("NODE_ENV", "production");
    await expect(f.store.sealTenantTelemetryCaptureBackupCheckpoint(input)).rejects.toThrow();
    expect(checkpointMap(f.store).size).toBe(0);
  });
});

describe("Memory selected checkpoint / 0031 / 0030 atomic consumer", () => {
  it("requires explicit selection then atomically binds the immutable checkpoint to the real prepared reservation/run", async () => {
    const f = await fixture(), s = await selectedBackup(f);
    const captureBefore: unknown = structuredClone(Reflect.get(f.store, "persistedProviderCaptureActivation"));
    expect(await f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).toEqual(s.entry);
    const prepared = await f.store.prepareTenantRestoreReplayFromBackup(s.prepare);
    expect(prepared.disposition).toBe("created");
    expect(prepared.value.replayRun.phase).toBe("prepared");
    expect(restoreBindingMap(f.store).get(s.prepare.restoreRunId)).toEqual({ restoreRunId: s.prepare.restoreRunId,
      backupId: s.entry.backupId, checkpointSha256: s.checkpoint!.value.checkpoint.checkpointSha256,
      artifactManifestSha256: s.entry.artifactManifestSha256, sourceSnapshotSha256: s.entry.sourceSnapshotSha256,
      providerEvidenceSha256: s.entry.providerEvidenceSha256, sourceBindingSha256: prepared.value.binding.bindingSha256,
      reservationSha256: prepared.value.reservation.reservationSha256,
      reservationReceiptSha256: prepared.value.reservation.reservationReceiptSha256,
      boundAtDbMs: prepared.value.binding.boundAtDbMs });
    expect(await f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).toEqual({ disposition: "exact_replay", value: prepared.value });
    expect(await f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).toEqual(s.entry);
    expect(await f.store.getTenantTelemetryCaptureBackupCheckpoint(s.entry.backupId)).toEqual(s.checkpoint!.value);
    expect(Reflect.get(f.store, "persistedProviderCaptureActivation")).toEqual(captureBefore);
    // Preparing is not activation or live capture permission. The old pending fence still rejects.
    await expect(f.store.getTenantTelemetryPersistedProviderCaptureBinding()).rejects.toThrow();
  });

  it.each(["missing", "wrong"] as const)("rejects %s selected hash even when a valid checkpoint is discoverable", async (kind) => {
    const f = await fixture(), s = await selectedBackup(f);
    const { captureCheckpointSha256: ignoredA, ...oldPrepare } = s.prepare;
    const { captureCheckpointSha256: ignoredB, ...oldPreflight } = s.preflight;
    void ignoredA; void ignoredB;
    const prepare = kind === "wrong" ? { ...oldPrepare, captureCheckpointSha256: sha("wrong-selected-checkpoint") } : oldPrepare;
    const preflight = kind === "wrong" ? { ...oldPreflight, captureCheckpointSha256: sha("wrong-selected-checkpoint") } : oldPreflight;
    const before = [...f.store.tenantBackupCatalogExternalEvents];
    await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).rejects.toThrow();
    await expect(f.store.prepareTenantRestoreReplayFromBackup(prepare)).rejects.toThrow();
    expect([...f.store.tenantBackupCatalogExternalEvents]).toEqual(before);
    expect(f.store.tenantBackupRestoreSourceBindings.size).toBe(0); expect(f.store.tenantBackupRuntimeReservations.size).toBe(0);
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0); expect(restoreBindingMap(f.store).size).toBe(0);
  });

  it("does not reinterpret an active-capture v1 selection as a v2 backup", async () => {
    const f = await fixture(), s = await selectedBackup(f, false);
    expect(checkpointMap(f.store).size).toBe(0);
    await expect(f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).rejects.toThrow();
    await expect(f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).rejects.toThrow();
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0);
  });

  it("preserves the genuine inactive-capture v1 path without a new sidecar", async () => {
    const f = await fixture({ capture: false }), s = await selectedBackup(f, false);
    expect(await f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).toEqual(s.entry);
    const prepared = await f.store.prepareTenantRestoreReplayFromBackup(s.prepare);
    expect(prepared.disposition).toBe("created");
    expect(await f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).toEqual({ disposition: "exact_replay", value: prepared.value });
    expect(restoreBindingMap(f.store).size).toBe(0);
  });

  it("does not accept a v2 field on the inactive v1 source path", async () => {
    const f = await fixture({ capture: false }), s = await selectedBackup(f, false);
    await expect(f.store.preflightTenantRestoreReplayFromBackup({ ...s.preflight, captureCheckpointSha256: sha("no-v2-source") })).rejects.toThrow();
    await expect(f.store.prepareTenantRestoreReplayFromBackup({ ...s.prepare, captureCheckpointSha256: sha("no-v2-source") })).rejects.toThrow();
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0);
  });

  it("rolls a late sidecar publication failure back with the reservation, source binding, external projection and run", async () => {
    const f = await fixture(), s = await selectedBackup(f), map = restoreBindingMap(f.store);
    const set = map.set.bind(map), eventsBefore = [...f.store.tenantBackupCatalogExternalEvents];
    const completeBefore = currentCaptureMemorySnapshot(f.store);
    vi.spyOn(map, "set").mockImplementationOnce((key, value) => { set(key, value); throw new Error("checkpoint sidecar late failure"); });
    await expect(f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).rejects.toThrow("checkpoint sidecar late failure");
    expect([...f.store.tenantBackupCatalogExternalEvents]).toEqual(eventsBefore);
    expect(f.store.tenantBackupRestoreSourceBindings.size).toBe(0); expect(f.store.tenantBackupRuntimeReservations.size).toBe(0);
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0); expect(f.store.tenantRestoreReplaySealedTargets.size).toBe(0);
    expect(map.size).toBe(0);
    expect(currentCaptureMemorySnapshot(f.store)).toEqual(completeBefore);
    expect((await f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).disposition).toBe("created");
  });

  it("converges concurrent exact prepare calls without issuing a second run or sidecar", async () => {
    const f = await fixture(), s = await selectedBackup(f);
    const results = await Promise.all([f.store.prepareTenantRestoreReplayFromBackup(s.prepare), f.store.prepareTenantRestoreReplayFromBackup(s.prepare)]);
    expect(results.map((row) => row.disposition).sort()).toEqual(["created", "exact_replay"]);
    expect(results[0]!.value).toEqual(results[1]!.value);
    expect(f.store.tenantRestoreReplayRuns.size).toBe(1); expect(restoreBindingMap(f.store).size).toBe(1);
  });

  it("does not repair or silently backfill a missing sidecar on exact replay", async () => {
    const f = await fixture(), s = await selectedBackup(f);
    await f.store.prepareTenantRestoreReplayFromBackup(s.prepare);
    restoreBindingMap(f.store).delete(s.prepare.restoreRunId);
    const eventsBefore = [...f.store.tenantBackupCatalogExternalEvents];
    await expect(f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).rejects.toThrow();
    await expect(f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).rejects.toThrow();
    expect(restoreBindingMap(f.store).size).toBe(0);
    expect([...f.store.tenantBackupCatalogExternalEvents]).toEqual(eventsBefore);
  });

  it.each(["restoreRunId", "backupId", "checkpointSha256", "artifactManifestSha256", "sourceSnapshotSha256",
    "providerEvidenceSha256", "sourceBindingSha256", "reservationSha256", "reservationReceiptSha256", "boundAtDbMs"] as const)(
    "checks exact replay sidecar %s against actual catalog/binding/reservation", async (field) => {
      const f = await fixture(), s = await selectedBackup(f);
      await f.store.prepareTenantRestoreReplayFromBackup(s.prepare);
      const binding = restoreBindingMap(f.store).get(s.prepare.restoreRunId)!;
      const before = [...f.store.tenantBackupCatalogExternalEvents];
      if (field === "boundAtDbMs") binding.boundAtDbMs += 1;
      else binding[field] = sha(`wrong-${field}`);
      await expect(f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).rejects.toThrow();
      await expect(f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).rejects.toThrow();
      expect([...f.store.tenantBackupCatalogExternalEvents]).toEqual(before);
    });

  it("authenticates actual stored leaves before consuming a selected hash", async () => {
    const f = await fixture(), s = await selectedBackup(f);
    checkpointMap(f.store).get(s.entry.backupId)!.leaves[0]!.recordHmacSha256 = sha("tampered-checkpoint-source");
    await expect(f.store.preflightTenantRestoreReplayFromBackup(s.preflight)).rejects.toThrow();
    await expect(f.store.prepareTenantRestoreReplayFromBackup(s.prepare)).rejects.toThrow();
    expect(f.store.tenantRestoreReplayRuns.size).toBe(0);
  });
});
