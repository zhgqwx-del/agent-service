import type { ExactReplay } from "./backup-catalog.js";
import type {
  TenantTelemetryCaptureBackupCheckpoint,
  TenantTelemetryCaptureCheckpointLeaf,
} from "./tenant-telemetry-capture-restore.js";

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
