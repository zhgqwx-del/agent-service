import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  assertEventChain,
  tenantRestoreJournalTargetRootSha256,
  tenantRestoreReplaySealedTargetRootSha256,
  tenantTelemetryCaptureRestoreRuntimeBindingSha256,
  validateScanTenantRestoreJournalRecordsResult,
  validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogHead,
  validateTenantBackupRestoreSourceBinding,
  validateTenantBackupRuntimeReservation,
  validateTenantRestoreJournalControlRecord,
  validateTenantRestoreJournalRemoteHead,
  validateTenantRestoreReplayEntry,
  validateTenantRestoreReplayReceipt,
  validateTenantRestoreReplayRunRecord,
  validateTenantRestoreReplaySealedTarget,
  validateTenantRestoreRuntimeControlRecord,
  validateTenantTelemetryCaptureRestoreHistoryReceipt,
  validateTenantTelemetryCaptureEpochCutoverReceipt,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupCatalogAdapter,
  type TenantBackupCatalogAdapterEvent,
  type TenantBackupRestoreSourceBinding,
  type TenantBackupRuntimeReservation,
  type TenantBackupRuntimeReservationAdapterResult,
  type ResolveTenantBackupRuntimeReservationInput,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalControlRecord,
  type TenantRestoreReplayRunRecord,
  type TenantRestoreReplaySealedTarget,
  type TenantRestoreRuntimeControlRecord,
  type TenantTelemetryCaptureRestoreMaintenance,
} from "@agent-service/store";
import type { VerifiedMySqlBackupArtifact } from "./mysql-backup-artifact.js";
import type { TenantBackupCatalogRuntimeConfig } from "./tenant-backup-catalog-config.js";
import type { TenantRestoreJournalRuntimeConfig } from "./tenant-restore-journal-config.js";

// Shared implementation only, not another application/CLI entrypoint. The caller
// supplies the actually held GCM capability and wraps EVERY I/O in its one
// operation budget plus the target operator's named-lock ownership checks.
export type SelectedRestoreStep = <T>(operation: () => Promise<T>) => Promise<T>;
export type SelectedRestoreErrorCode = "invalid_durable_state" | "catalog_conflict"
  | "catalog_corrupt" | "journal_conflict" | "runtime_head_changed" | "operation_failed";
export class SelectedRestoreError extends Error {
  constructor(readonly code: SelectedRestoreErrorCode) { super(code); this.name = "SelectedRestoreError"; }
}
function fail(code: SelectedRestoreErrorCode = "invalid_durable_state"): never { throw new SelectedRestoreError(code); }
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const asDurable = (validate: () => void) => { try { validate(); } catch { fail(); } };
type ExternalSelection = {
  availability: TenantBackupAvailabilityAdapterResult;
  reservation: TenantBackupRuntimeReservationAdapterResult;
  resolution: "activated" | undefined;
  resolutionProof: ResolveTenantBackupRuntimeReservationInput | undefined;
};

/** Validate the actual sealed authority chain. Historical inspectAvailability
 * alone is insufficient after eviction; this path never mirrors/reserves it. */
export async function readSelectedRestoreCatalog(adapter: TenantBackupCatalogAdapter,
  config: TenantBackupCatalogRuntimeConfig, verified: VerifiedMySqlBackupArtifact,
  restoreRunId: string, runtimeEpochSha256: string, pageSize: number, step: SelectedRestoreStep): Promise<ExternalSelection> {
  const head = await step(() => adapter.readHead());
  validateTenantBackupCatalogHead(head);
  if (head.adapterProtocol !== config.adapterProtocol || head.catalogNamespaceSha256 !== config.catalogNamespaceSha256
    || head.catalogTargetSha256 !== config.catalogTargetSha256 || head.failureDomainSha256 !== config.failureDomainSha256) fail("catalog_conflict");
  const events: TenantBackupCatalogAdapterEvent[] = [];
  let sequence = 0, root = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
  while (sequence < head.catalogSequence) {
    const page = await step(() => adapter.scanEvents({ afterCatalogSequence: sequence,
      afterCatalogEventRootSha256: root, sealedHead: head, limit: pageSize }));
    if (!Array.isArray(page.events) || page.events.length === 0 || page.events.length > pageSize) fail("catalog_corrupt");
    for (const event of page.events) {
      validateTenantBackupCatalogAdapterEvent(event);
      if (event.result.catalogSequence !== sequence + 1 || event.result.previousCatalogEventRootSha256 !== root) fail("catalog_corrupt");
      sequence = event.result.catalogSequence; root = event.result.catalogEventRootSha256;
      events.push(event);
    }
    if (sequence > head.catalogSequence || page.nextCatalogSequence !== sequence || page.nextCatalogEventRootSha256 !== root
      || page.complete !== (sequence === head.catalogSequence)) fail("catalog_corrupt");
  }
  if (sequence !== head.catalogSequence || root !== head.catalogEventRootSha256) fail("catalog_corrupt");
  assertEventChain({ adapterProtocol: head.adapterProtocol, catalogNamespaceSha256: head.catalogNamespaceSha256,
    catalogTargetSha256: head.catalogTargetSha256, failureDomainSha256: head.failureDomainSha256 }, events);
  let availability: TenantBackupAvailabilityAdapterResult | undefined;
  let reservation: TenantBackupRuntimeReservationAdapterResult | undefined;
  let resolution: "activated" | undefined;
  let resolutionProof: ResolveTenantBackupRuntimeReservationInput | undefined;
  for (const event of events) {
    if (event.eventType === "backup_recoverable" && event.result.backupId === verified.manifest.backupId) availability = event.result;
    if (event.eventType === "backup_evicted" && event.result.backupId === verified.manifest.backupId) fail("catalog_conflict");
    if (event.eventType === "restore_reserved" && event.result.restoreRunId === restoreRunId) reservation = event.result;
    if (event.eventType === "restore_resolved" && event.result.restoreRunId === restoreRunId) {
      if (event.result.phase !== "activated") fail("catalog_conflict");
      resolution = "activated";
      resolutionProof = event.result;
    }
  }
  const anchor = verified.manifest.anchor, evidence = verified.evidence;
  if (!availability || !reservation || availability.backupId !== anchor.backupId
    || availability.anchorSha256 !== anchor.anchorSha256 || availability.controlEvidenceSha256 !== anchor.controlEvidenceSha256
    || availability.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || availability.logicalDatabaseNamespaceSha256 !== anchor.logicalDatabaseNamespaceSha256
    || availability.retentionUntilDbMs !== anchor.retentionUntilDbMs || availability.registeredAtDbMs !== anchor.createdAtDbMs
    || availability.sourceSnapshotSha256 !== evidence.sourceSnapshotSha256 || availability.sourceBackupSha256 !== evidence.sourceBackupSha256
    || availability.artifactManifestSha256 !== evidence.artifactManifestSha256 || availability.providerEvidenceSha256 !== evidence.providerEvidenceSha256
    || reservation.backupId !== anchor.backupId || reservation.entrySha256 !== availability.entrySha256
    || reservation.runtimeEpochSha256 !== runtimeEpochSha256) fail("catalog_conflict");
  const fresh = await step(() => adapter.readHead()); validateTenantBackupCatalogHead(fresh);
  if (!equal(fresh, head)) fail("catalog_conflict");
  return { availability, reservation, resolution, resolutionProof };
}

function sameTarget(a: TenantRestoreReplaySealedTarget, b: TenantRestoreReplaySealedTarget): boolean {
  return a.targetOrdinal === b.targetOrdinal && a.targetSha256 === b.targetSha256
    && a.failureDomainSha256 === b.failureDomainSha256 && a.adapterProtocol === b.adapterProtocol
    && a.journalNamespaceSha256 === b.journalNamespaceSha256 && a.logicalDatabaseNamespaceSha256 === b.logicalDatabaseNamespaceSha256
    && a.sealedRemoteSequence === b.sealedRemoteSequence && a.sealedHeadRootSha256 === b.sealedHeadRootSha256;
}
function sameTargets(a: readonly TenantRestoreReplaySealedTarget[], b: readonly TenantRestoreReplaySealedTarget[]): boolean {
  return a.length === b.length && a.every((target, index) => sameTarget(target, b[index]!));
}

export interface SelectedRestoreContext {
  run: TenantRestoreReplayRunRecord;
  binding: TenantBackupRestoreSourceBinding;
  reservation: TenantBackupRuntimeReservation;
  control: TenantRestoreJournalControlRecord;
  targets: TenantRestoreReplaySealedTarget[];
}

export async function readSelectedRestoreContext(store: TenantTelemetryCaptureRestoreMaintenance,
  config: TenantRestoreJournalRuntimeConfig, verified: VerifiedMySqlBackupArtifact, external: ExternalSelection,
  restoreRunId: string, step: SelectedRestoreStep): Promise<SelectedRestoreContext> {
  const run = await step(() => store.getTenantRestoreReplayRun(restoreRunId));
  const binding = await step(() => store.getTenantBackupRestoreSourceBinding(restoreRunId));
  const reservation = await step(() => store.getTenantBackupRuntimeReservation(restoreRunId));
  const control = await step(() => store.getTenantRestoreJournalControl());
  const targets = await step(() => store.getTenantRestoreReplaySealedTargets(restoreRunId));
  const journalTargets = await step(() => store.getTenantRestoreJournalControlTargets());
  if (!run || !binding || !reservation || run.phase === "aborted" || reservation.phase === "aborted") fail();
  asDurable(() => { validateTenantRestoreReplayRunRecord(run); validateTenantBackupRestoreSourceBinding(binding);
    validateTenantBackupRuntimeReservation(reservation); validateTenantRestoreJournalControlRecord(control);
    for (const target of targets) validateTenantRestoreReplaySealedTarget(target); });
  if (control.controlGeneration !== 1 || control.adapterProtocol !== config.adapterProtocol
    || control.journalNamespaceSha256 !== config.journalNamespaceSha256 || control.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256
    || control.targetRootSha256 !== config.targetRootSha256 || control.targetCount !== config.targets.length
    || journalTargets.length !== config.targets.length || targets.length !== config.targets.length
    || tenantRestoreJournalTargetRootSha256(journalTargets) !== config.targetRootSha256) fail();
  for (const [index, target] of targets.entries()) {
    const descriptor = config.targets[index]?.descriptor;
    if (!descriptor || target.targetOrdinal !== index || target.targetSha256 !== descriptor.targetSha256
      || target.failureDomainSha256 !== descriptor.failureDomainSha256 || target.adapterProtocol !== descriptor.adapterProtocol
      || target.journalNamespaceSha256 !== descriptor.journalNamespaceSha256
      || target.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) fail();
  }
  const anchor = verified.manifest.anchor, availability = external.availability;
  for (const field of ["restoreRunId", "backupId", "entrySha256", "runtimeEpochSha256", "reservationOperationSha256",
    "reservationReceiptSha256", "catalogSequence", "previousCatalogEventRootSha256", "catalogEventRootSha256", "catalogEventSha256"] as const) {
    if (reservation[field] !== external.reservation[field]) fail("catalog_conflict");
  }
  for (const field of ["backupId", "anchorSha256", "entrySha256", "sourceSnapshotSha256", "sourceBackupSha256",
    "artifactManifestSha256", "providerEvidenceSha256", "controlEvidenceSha256"] as const) {
    if (binding[field] !== availability[field]) fail("catalog_conflict");
  }
  if (binding.restoreRunId !== restoreRunId || binding.backupId !== verified.manifest.backupId
    || binding.anchorSha256 !== anchor.anchorSha256 || binding.bindingSha256 !== reservation.bindingSha256
    || binding.reservationReceiptSha256 !== reservation.reservationReceiptSha256
    || binding.runtimeEpochSha256 !== config.runtimeEpochSha256 || binding.journalControlEvidenceSha256 !== control.evidenceSha256
    || binding.sealedTargetRootSha256 !== run.sealedTargetRootSha256
    || run.restoreRunId !== restoreRunId || run.runtimeEpochSha256 !== config.runtimeEpochSha256
    || run.sourceBackupSha256 !== verified.evidence.sourceBackupSha256 || run.controlEvidenceSha256 !== control.evidenceSha256
    || run.adapterProtocol !== config.adapterProtocol || run.journalNamespaceSha256 !== config.journalNamespaceSha256
    || run.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256 || run.targetCount !== targets.length
    || run.targetRootSha256 !== config.targetRootSha256 || run.sealedTargetRootSha256 !== tenantRestoreReplaySealedTargetRootSha256(targets)
    || run.expectedEntryCount !== targets.reduce((sum, target) => sum + target.sealedRemoteSequence, 0)
    || (external.resolution === "activated" || reservation.phase === "activated") && run.phase !== "active") fail();
  return { run, binding, reservation, control, targets };
}

type Context = SelectedRestoreContext;
type Receipt = NonNullable<Awaited<ReturnType<TenantTelemetryCaptureRestoreMaintenance["getTenantRestoreReplayReceipt"]>>>;
function sameRunIdentity(run: TenantRestoreReplayRunRecord, expected: TenantRestoreReplayRunRecord): boolean {
  return (["restoreRunId", "sourceBackupSha256", "runtimeEpochSha256", "controlEvidenceSha256", "protocol", "adapterProtocol",
    "journalNamespaceSha256", "logicalDatabaseNamespaceSha256", "targetCount", "targetRootSha256", "sealedTargetRootSha256",
    "expectedEntryCount", "createdAtDbMs"] as const).every((field) => run[field] === expected[field]);
}
function matchesReceipt(run: TenantRestoreReplayRunRecord, receipt: Receipt): boolean {
  if (run.phase !== "replay_sealed" && run.phase !== "active") return false;
  return (["restoreRunId", "sourceBackupSha256", "runtimeEpochSha256", "controlEvidenceSha256", "protocol", "adapterProtocol",
    "journalNamespaceSha256", "logicalDatabaseNamespaceSha256", "targetCount", "targetRootSha256", "sealedTargetRootSha256",
    "entryCount", "entryRootSha256", "fenceCount", "fenceRootSha256"] as const).every((key) => receipt[key] === run[key])
    && receipt.storeDbTimestampMs === run.sealedAtDbMs && receipt.receiptSha256 === run.terminalReceiptSha256
    && run.entryCount === run.expectedEntryCount;
}

export async function replaySelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance, context: Context,
  config: TenantRestoreJournalRuntimeConfig, adapters: readonly TenantRestoreJournalAdapter[], pageSize: number,
  step: SelectedRestoreStep, beforeMutation: () => void): Promise<TenantRestoreReplayRunRecord> {
  if (adapters.length !== context.targets.length) fail();
  if (context.run.phase !== "prepared") return readVerifiedSelectedRestore(store, context.run, step);
  for (const [targetOrdinal, target] of context.targets.entries()) {
    const adapter = adapters[targetOrdinal];
    if (!adapter || adapter.targetSha256 !== target.targetSha256 || adapter.adapterProtocol !== target.adapterProtocol
      || adapter.journalNamespaceSha256 !== target.journalNamespaceSha256 || adapter.failureDomainSha256 !== target.failureDomainSha256
      || adapter.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) fail();
    let sequence = 0, root = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    while (sequence < target.sealedRemoteSequence) {
      const options = { sealedHead: { scope: "tenant-restore-journal-remote-head-v1" as const,
        protocol: "tenant-restore-journal-v1" as const, adapterProtocol: target.adapterProtocol,
        journalNamespaceSha256: target.journalNamespaceSha256, targetSha256: target.targetSha256,
        logicalDatabaseNamespaceSha256: target.logicalDatabaseNamespaceSha256,
        remoteSequence: target.sealedRemoteSequence, headRootSha256: target.sealedHeadRootSha256 },
      afterRemoteSequence: sequence, afterHeadRootSha256: root, limit: pageSize };
      const page = await step(() => adapter.scanRecords(options));
      validateScanTenantRestoreJournalRecordsResult(options, page);
      if (!page.entries.length) fail("journal_conflict");
      for (const entry of page.entries) {
        const input = { restoreRunId: context.run.restoreRunId, targetOrdinal, remoteEntry: entry };
        beforeMutation();
        let recorded;
        try { recorded = await step(() => store.recordTenantRestoreReplayFence(input)); }
        catch (first) {
          // One exact retry only, never a new operation/claim or inferred ACK.
          try { recorded = await step(() => store.recordTenantRestoreReplayFence(input)); } catch { throw first; }
        }
        if (!recorded) fail("operation_failed");
        const durableEntry = recorded;
        asDurable(() => validateTenantRestoreReplayEntry(durableEntry));
        if (durableEntry.restoreRunId !== input.restoreRunId || durableEntry.targetOrdinal !== targetOrdinal
          || durableEntry.remoteSequence !== entry.remoteSequence || durableEntry.targetSha256 !== entry.targetSha256
          || durableEntry.previousHeadRootSha256 !== entry.previousHeadRootSha256 || durableEntry.headRootSha256 !== entry.headRootSha256
          || durableEntry.recordSha256 !== entry.record.recordSha256 || durableEntry.operationSha256 !== entry.record.operationSha256) fail();
      }
      sequence = page.nextRemoteSequence; root = page.nextHeadRootSha256;
    }
    if (sequence !== target.sealedRemoteSequence || root !== target.sealedHeadRootSha256) fail("journal_conflict");
  }
  const run = await step(() => store.getTenantRestoreReplayRun(context.run.restoreRunId));
  if (!run) fail(); asDurable(() => validateTenantRestoreReplayRunRecord(run));
  if (!sameRunIdentity(run, context.run) || run.phase !== "prepared" || run.entryCount !== run.expectedEntryCount) fail();
  return run;
}

export async function readVerifiedSelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance,
  expected: TenantRestoreReplayRunRecord, step: SelectedRestoreStep): Promise<TenantRestoreReplayRunRecord> {
  const run = await step(() => store.getTenantRestoreReplayRun(expected.restoreRunId));
  const receipt = await step(() => store.getTenantRestoreReplayReceipt(expected.restoreRunId));
  if (!run || !receipt) fail();
  asDurable(() => { validateTenantRestoreReplayRunRecord(run); validateTenantRestoreReplayReceipt(receipt); });
  if (!sameRunIdentity(run, expected) || !matchesReceipt(run, receipt)) fail(); return run;
}
export async function verifySelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance, context: Context,
  step: SelectedRestoreStep, beforeMutation: () => void): Promise<TenantRestoreReplayRunRecord> {
  beforeMutation();
  try {
    const receipt = await step(() => store.sealTenantRestoreReplay(context.run.restoreRunId));
    if (!receipt) fail(); asDurable(() => validateTenantRestoreReplayReceipt(receipt));
  } catch (first) {
    try { return await readVerifiedSelectedRestore(store, context.run, step); } catch { throw first; }
  }
  return readVerifiedSelectedRestore(store, context.run, step);
}

export async function assertSelectedRestoreFreshHeads(context: Context, config: TenantRestoreJournalRuntimeConfig,
  adapters: readonly TenantRestoreJournalAdapter[], step: SelectedRestoreStep): Promise<void> {
  if (adapters.length !== context.targets.length) fail();
  const heads: TenantRestoreReplaySealedTarget[] = [];
  for (const [index, target] of context.targets.entries()) {
    const adapter = adapters[index];
    if (!adapter || adapter.targetSha256 !== target.targetSha256 || adapter.adapterProtocol !== target.adapterProtocol
      || adapter.journalNamespaceSha256 !== target.journalNamespaceSha256 || adapter.failureDomainSha256 !== target.failureDomainSha256
      || adapter.logicalDatabaseNamespaceSha256 !== config.logicalDatabaseNamespaceSha256) fail();
    const head = await step(() => adapter.readHead()); validateTenantRestoreJournalRemoteHead(head);
    if (head.adapterProtocol !== target.adapterProtocol || head.journalNamespaceSha256 !== target.journalNamespaceSha256
      || head.targetSha256 !== target.targetSha256 || head.logicalDatabaseNamespaceSha256 !== target.logicalDatabaseNamespaceSha256) fail("journal_conflict");
    heads.push({ ...target, sealedRemoteSequence: head.remoteSequence, sealedHeadRootSha256: head.headRootSha256 });
  }
  if (!sameTargets(heads, context.targets)) fail("runtime_head_changed");
}

/** The store's history getter independently validates immutable activation event
 * plus its lawful current runtime chain. Codec validation alone is NOT authority. */
export async function readActivatedSelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance, context: Context,
  verified: VerifiedMySqlBackupArtifact, key: Uint8Array, step: SelectedRestoreStep,
  previous?: TenantRestoreRuntimeControlRecord): Promise<TenantRestoreReplayRunRecord> {
  if (verified.manifest.version !== 2) fail();
  const control = context.control;
  asDurable(() => validateTenantRestoreJournalControlRecord(control));
  if (control.controlGeneration !== 1) fail();
  const checkpoint = verified.manifest.captureCheckpoint;
  const run = await readVerifiedSelectedRestore(store, context.run, step);
  const runtime = await step(() => store.getTenantRestoreRuntimeControl());
  const heads = await step(() => store.getTenantRestoreRuntimeHeads());
  const history = await step(() => store.getTenantTelemetryCaptureRestoreHistoryReceipt());
  asDurable(() => validateTenantRestoreRuntimeControlRecord(runtime));
  if (run.phase !== "active" || runtime.state !== "active" || runtime.lineageKind !== "restore"
    || runtime.restoreRunId !== run.restoreRunId || runtime.replayReceiptSha256 !== run.terminalReceiptSha256
    || runtime.runtimeEpochSha256 !== run.runtimeEpochSha256 || runtime.controlEvidenceSha256 !== control.evidenceSha256
    || runtime.logicalDatabaseNamespaceSha256 !== run.logicalDatabaseNamespaceSha256
    || runtime.targetCount !== run.targetCount || runtime.targetRootSha256 !== run.targetRootSha256
    || !sameTargets(heads, context.targets) || !history) fail();
  asDurable(() => validateTenantTelemetryCaptureRestoreHistoryReceipt(history, checkpoint, key));
  if (history.restoreRunId !== run.restoreRunId || history.runtimeEpochSha256 !== run.runtimeEpochSha256
    || history.replayReceiptSha256 !== run.terminalReceiptSha256 || history.activatedAtDbMs !== run.activatedAtDbMs
    || history.sourceBindingSha256 !== context.binding.bindingSha256 || history.reservationSha256 !== context.reservation.reservationSha256
    || history.reservationReceiptSha256 !== context.reservation.reservationReceiptSha256
    || history.artifactManifestSha256 !== verified.evidence.artifactManifestSha256
    || history.sourceSnapshotSha256 !== verified.evidence.sourceSnapshotSha256 || history.providerEvidenceSha256 !== verified.evidence.providerEvidenceSha256
    || history.sealedJournalHeadRootSha256 !== run.sealedTargetRootSha256
    || history.runtimeBindingSha256 !== tenantTelemetryCaptureRestoreRuntimeBindingSha256(runtime, control)
    || runtime.controlGeneration < history.runtimeControlGeneration
    || previous !== undefined && history.runtimeControlGeneration !== previous.controlGeneration + 1) fail();
  return run;
}

export async function activateSelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance, context: Context,
  config: TenantRestoreJournalRuntimeConfig, adapters: readonly TenantRestoreJournalAdapter[],
  verified: VerifiedMySqlBackupArtifact, key: Uint8Array, step: SelectedRestoreStep,
  beforeMutation: () => void): Promise<TenantRestoreReplayRunRecord> {
  if (context.run.phase !== "replay_sealed" && context.run.phase !== "active") fail();
  await assertSelectedRestoreFreshHeads(context, config, adapters, step);
  const before = await step(() => store.getTenantRestoreRuntimeControl());
  asDurable(() => validateTenantRestoreRuntimeControlRecord(before));
  if (context.run.phase !== "active") {
    beforeMutation();
    try { await step(() => store.activateTenantRestoreRuntime({ restoreRunId: context.run.restoreRunId,
      expectedControlGeneration: before.controlGeneration })); }
    catch { /* Only full committed reconstruction below can prove response loss. */ }
  }
  const run = await readActivatedSelectedRestore(store, context, verified, key, step,
    context.run.phase === "active" ? undefined : before);
  await assertSelectedRestoreFreshHeads(context, config, adapters, step);
  return run;
}

/** Resolution is a separate explicit operation, never a side effect of runtime
 * or capture activation. Neither an external response nor a caller digest is
 * local authority: authenticate the whole resulting chain, then let the exact
 * maintenance store atomically validate/project its actual terminal run.
 * Response loss is deliberately returned as ambiguous; the same command/IDs
 * must be explicitly retried against the adapters' immutable exact receipts. */
export async function resolveSelectedRestore(store: TenantTelemetryCaptureRestoreMaintenance, context: Context,
  adapter: TenantBackupCatalogAdapter, catalogConfig: TenantBackupCatalogRuntimeConfig,
  journalConfig: TenantRestoreJournalRuntimeConfig, journalAdapters: readonly TenantRestoreJournalAdapter[],
  verified: VerifiedMySqlBackupArtifact, key: Uint8Array, pageSize: number,
  step: SelectedRestoreStep, beforeMutation: () => void,
): Promise<Awaited<ReturnType<TenantTelemetryCaptureRestoreMaintenance["resolveTenantBackupRuntimeReservation"]>>> {
  if (context.run.phase !== "active") fail();
  await readActivatedSelectedRestore(store, context, verified, key, step);
  const history = await step(() => store.getTenantTelemetryCaptureRestoreHistoryReceipt());
  const cutover = await step(() => store.getTenantTelemetryCaptureEpochCutoverReceipt());
  if (verified.manifest.version !== 2 || !history || !cutover) fail();
  const checkpoint = verified.manifest.captureCheckpoint;
  asDurable(() => { validateTenantTelemetryCaptureRestoreHistoryReceipt(history, checkpoint, key);
    validateTenantTelemetryCaptureEpochCutoverReceipt(cutover, history, checkpoint, key); });
  if (history.restoreRunId !== context.run.restoreRunId || history.runtimeEpochSha256 !== context.run.runtimeEpochSha256
    || cutover.restoreRunId !== context.run.restoreRunId || cutover.runtimeEpochSha256 !== context.run.runtimeEpochSha256
    || cutover.historyReceiptSha256 !== history.receiptSha256) fail();
  await assertSelectedRestoreFreshHeads(context, journalConfig, journalAdapters, step);
  beforeMutation();
  const resolution = await step(() => adapter.resolveRestore({ restoreRunId: context.run.restoreRunId,
    reservationReceiptSha256: context.reservation.reservationReceiptSha256, phase: "activated" }));
  asDurable(() => validateTenantBackupCatalogAdapterEvent({ eventType: "restore_resolved", result: resolution }));
  if (resolution.restoreRunId !== context.run.restoreRunId || resolution.phase !== "activated"
    || resolution.reservationReceiptSha256 !== context.reservation.reservationReceiptSha256) fail("catalog_conflict");
  const external = await readSelectedRestoreCatalog(adapter, catalogConfig, verified, context.run.restoreRunId,
    context.run.runtimeEpochSha256, pageSize, step);
  const proof = external.resolutionProof;
  const proofFields = ["restoreRunId", "reservationReceiptSha256", "phase", "resolutionOperationSha256",
    "resolutionReceiptSha256", "catalogSequence", "previousCatalogEventRootSha256", "catalogEventRootSha256", "catalogEventSha256"] as const;
  if (!proof || proofFields.some((field) => proof[field] !== resolution[field])) fail("catalog_conflict");
  const projected = await step(() => store.resolveTenantBackupRuntimeReservation(resolution));
  const current = await step(() => store.getTenantBackupRuntimeReservation(context.run.restoreRunId));
  if (!projected || !current || projected.disposition !== "created" && projected.disposition !== "exact_replay") fail();
  asDurable(() => { validateTenantBackupRuntimeReservation(projected.value); validateTenantBackupRuntimeReservation(current); });
  const sameResolved = (value: TenantBackupRuntimeReservation): boolean => value.phase === "activated"
    && (["scope", "protocol", "restoreRunId", "backupId", "entrySha256", "bindingSha256", "runtimeEpochSha256",
      "reservationOperationSha256", "reservationReceiptSha256", "catalogSequence", "previousCatalogEventRootSha256",
      "catalogEventRootSha256", "catalogEventSha256", "reservedAtDbMs", "reservationSha256"] as const)
      .every((field) => value[field] === context.reservation[field])
    && value.resolutionOperationSha256 === resolution.resolutionOperationSha256
    && value.resolutionReceiptSha256 === resolution.resolutionReceiptSha256
    && value.resolutionCatalogSequence === resolution.catalogSequence
    && value.resolutionPreviousCatalogEventRootSha256 === resolution.previousCatalogEventRootSha256
    && value.resolutionCatalogEventRootSha256 === resolution.catalogEventRootSha256
    && value.resolutionCatalogEventSha256 === resolution.catalogEventSha256;
  if (!sameResolved(projected.value) || !sameResolved(current) || current.phase !== "activated"
    || projected.value.phase !== "activated" || current.resolvedAtDbMs !== projected.value.resolvedAtDbMs) fail();
  return projected;
}
