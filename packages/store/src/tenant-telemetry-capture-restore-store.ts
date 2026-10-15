import type { ExactReplay } from "./backup-catalog.js";
import type { TenantBackupCatalogStore } from "./backup-catalog.js";
import type {
  TenantTelemetryCaptureBackupCheckpoint,
  TenantTelemetryCaptureCheckpointLeaf,
  TenantTelemetryCaptureRestoreHistoryReceipt,
  TenantTelemetryCaptureEpochCutoverReceipt,
} from "./tenant-telemetry-capture-restore.js";
import { TenantTelemetryCaptureRestoreIntegrityError } from "./tenant-telemetry-capture-restore.js";
import type { RestoreReplayStore, TenantRestoreJournalStore } from "./tenant-restore-journal.js";

/** Expected identities from an authenticated artifact and its actual 0031
 * reservation. The store must independently read every durable relation;
 * these digests, by themselves, are never source or activation authority. */
export interface TenantTelemetryCaptureRestoreMaintenanceSelector {
  backupId: string;
  restoreRunId: string;
  checkpointSha256: string;
  artifactManifestSha256: string;
  sourceSnapshotSha256: string;
  providerEvidenceSha256: string;
  reservationSha256: string;
  reservationReceiptSha256: string;
  fleetStoppedAck: "fleet-stopped-v1";
  localOnlyAck: "local-only-v1";
}

export function validateTenantTelemetryCaptureRestoreMaintenanceSelector(
  value: TenantTelemetryCaptureRestoreMaintenanceSelector,
): void {
  const fail: () => never = () => { throw new TenantTelemetryCaptureRestoreIntegrityError(); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = ["backupId", "restoreRunId", "checkpointSha256", "artifactManifestSha256",
    "sourceSnapshotSha256", "providerEvidenceSha256", "reservationSha256",
    "reservationReceiptSha256", "fleetStoppedAck", "localOnlyAck"];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail();
    if (typeof key === "string" && key.endsWith("Sha256")
      && (typeof descriptor.value !== "string" || !/^[0-9a-f]{64}$/.test(descriptor.value))) fail();
  }
  if (typeof value.backupId !== "string"
    || !/^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.backupId)
    || typeof value.restoreRunId !== "string"
    || !/^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.restoreRunId)
    || value.fleetStoppedAck !== "fleet-stopped-v1" || value.localOnlyAck !== "local-only-v1") fail();
}

export interface ActivateTenantTelemetryCaptureRestoredEpochInput {
  expectedRuntimeEpochSha256: string;
  configuredFleetRootSha256: string;
  legacyWritersDrainedAck: "legacy-writers-drained-v1";
  producerReadyAck: "provider-step-error-v2-ready-v1";
}

export function validateActivateTenantTelemetryCaptureRestoredEpochInput(value: ActivateTenantTelemetryCaptureRestoredEpochInput): void {
  function fail(): never { throw new TenantTelemetryCaptureRestoreIntegrityError(); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = ["expectedRuntimeEpochSha256", "configuredFleetRootSha256", "legacyWritersDrainedAck", "producerReadyAck"];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  for (const key of actual) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) fail();
    if (typeof key === "string" && key.endsWith("Sha256")
      && (typeof field.value !== "string" || !/^[0-9a-f]{64}$/.test(field.value))) fail();
  }
  if (value.legacyWritersDrainedAck !== "legacy-writers-drained-v1"
    || value.producerReadyAck !== "provider-step-error-v2-ready-v1") fail();
}

/** Exact-run only: no general SessionStore, prepare, primary activation or
 * deletion methods are exposed. Every run-bearing argument
 * must still match the privately held selector on every call. */
export type TenantTelemetryCaptureRestoreMaintenance = Pick<RestoreReplayStore,
  "getTenantRestoreReplayRun" | "getTenantRestoreReplaySealedTargets"
  | "listTenantRestoreReplayEntries" | "recordTenantRestoreReplayFence"
  | "sealTenantRestoreReplay" | "abortTenantRestoreReplay"
  | "getTenantRestoreReplayReceipt" | "getTenantRestoreRuntimeControl"
  | "getTenantRestoreRuntimeHeads" | "activateTenantRestoreRuntime"
> & Pick<TenantRestoreJournalStore,
  "getTenantRestoreJournalControl" | "getTenantRestoreJournalControlTargets"
> & Pick<TenantBackupCatalogStore,
  "getTenantBackupRestoreSourceBinding" | "getTenantBackupRuntimeReservation"
  | "resolveTenantBackupRuntimeReservation"
> & {
  getTenantTelemetryCaptureRestoreHistoryReceipt(): Promise<TenantTelemetryCaptureRestoreHistoryReceipt | null>;
  activateTenantTelemetryCaptureRestoredEpoch(input: ActivateTenantTelemetryCaptureRestoredEpochInput): Promise<TenantTelemetryCaptureEpochCutoverReceipt>;
  getTenantTelemetryCaptureEpochCutoverReceipt(): Promise<TenantTelemetryCaptureEpochCutoverReceipt | null>;
  close(): Promise<void>;
};

export interface MysqlTenantTelemetryCaptureRestoreMaintenanceOptions {
  url: string;
  connectionLimit?: number;
  migrationsDir?: string;
  tenantTelemetryRefKey: Uint8Array;
  operationAbortSignal?: AbortSignal;
  selector: TenantTelemetryCaptureRestoreMaintenanceSelector;
}

/** Artifact identity is already authenticated by the held GCM reader. The
 * private factory must derive both reservation digests from the actual target,
 * then invoke the full exact-run selector audit; this is not a proof shortcut. */
export type MysqlTenantTelemetryCaptureArtifactRestoreMaintenanceOptions =
  Omit<MysqlTenantTelemetryCaptureRestoreMaintenanceOptions, "selector"> & {
    selection: Omit<TenantTelemetryCaptureRestoreMaintenanceSelector,
      "reservationSha256" | "reservationReceiptSha256">;
  };

/** The store, never the caller, derives these leaves from the complete source. */
export interface TenantTelemetryCaptureBackupCheckpointRecord {
  checkpoint: TenantTelemetryCaptureBackupCheckpoint;
  leaves: readonly TenantTelemetryCaptureCheckpointLeaf[];
}

/**
 * Additional immutable linkage, committed together with 0031 binding/reservation
 * and 0030 prepare. It does not change any previously issued v1 receipt bytes.
 * Every value is read from the locked checkpoint and original catalog records.
 */
export interface TenantTelemetryCaptureRestoreBackupBinding {
  restoreRunId: string;
  backupId: string;
  checkpointSha256: string;
  artifactManifestSha256: string;
  sourceSnapshotSha256: string;
  providerEvidenceSha256: string;
  sourceBindingSha256: string;
  reservationSha256: string;
  reservationReceiptSha256: string;
  boundAtDbMs: number;
}

export interface SealTenantTelemetryCaptureBackupCheckpointInput {
  backupId: string;
  fleetStoppedAck: "fleet-stopped-v1";
  localOnlyAck: "local-only-v1";
}

export interface AssertTenantTelemetryCaptureBackupCheckpointUnchangedInput
  extends SealTenantTelemetryCaptureBackupCheckpointInput {
  checkpointSha256: string;
}

/**
 * A stopped-fleet backup boundary, not runtime activation or deletion authority.
 * seal constructs and durably publishes the header and ALL immutable leaves in
 * one atomic boundary. null means verified inactive capture with no anomalous
 * capture footprint; active capture must never silently fall back to v1 bytes.
 * get validates the historical stored snapshot, not today's mutable source.
 * assertUnchanged is exclusively for the before/after-dump operator window;
 * later artifact verification must not require live state to remain unchanged.
 */
export interface TenantTelemetryCaptureBackupCheckpointStore {
  sealTenantTelemetryCaptureBackupCheckpoint(
    input: SealTenantTelemetryCaptureBackupCheckpointInput,
  ): Promise<ExactReplay<TenantTelemetryCaptureBackupCheckpointRecord> | null>;
  getTenantTelemetryCaptureBackupCheckpoint(
    backupId: string,
  ): Promise<TenantTelemetryCaptureBackupCheckpointRecord | null>;
  assertTenantTelemetryCaptureBackupCheckpointUnchanged(
    input: AssertTenantTelemetryCaptureBackupCheckpointUnchangedInput,
  ): Promise<void>;
}
