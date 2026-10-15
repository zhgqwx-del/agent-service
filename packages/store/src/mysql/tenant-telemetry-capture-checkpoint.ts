import type { Connection, Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import * as CaptureRestore from "../tenant-telemetry-capture-restore.js";
import type { TenantTelemetryCaptureBackupCheckpointRecord } from "../tenant-telemetry-capture-restore-store.js";

type Executor = Connection | Pool | PoolConnection;
type Row = RowDataPacket;

/**
 * Read the immutable 0055 snapshot from the *actual* MySQL source, rather
 * than accepting a checkpoint returned by an unrelated caller-owned store.
 * This validates historical rows, all 49 family roots and the protected ref
 * key, but intentionally makes no claim that today's mutable source is the
 * same as the pre-dump snapshot. The producer must compare that separately.
 */
export async function readTenantTelemetryCaptureCheckpointFromMysql(
  executor: Executor,
  backupId: string,
  refKey: Uint8Array,
  lock: "" | "FOR SHARE" = "",
): Promise<TenantTelemetryCaptureBackupCheckpointRecord | null> {
  if (typeof backupId !== "string" || !/^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(backupId)
    || !(refKey instanceof Uint8Array) || refKey.byteLength !== 32) {
    throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
  }
  const [headers] = await executor.query<Row[]>(
    `SELECT backup_id,anchor_sha256,checkpoint_sha256,ref_key_id_sha256,sealed_at_db_ms,checkpoint_json
       FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ? ${lock}`,
    [backupId],
  );
  const [leafRows] = await executor.query<Row[]>(
    `SELECT backup_id,family,identity_ref_sha256,record_hmac_sha256,knowledge,state,source_high_water_db_ms
       FROM tenant_telemetry_capture_backup_checkpoint_leaves
      WHERE BINARY backup_id=BINARY ? ORDER BY family,identity_ref_sha256
      LIMIT ${CaptureRestore.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1} ${lock}`,
    [backupId],
  );
  if (!headers.length && !leafRows.length) return null;
  if (headers.length !== 1 || leafRows.length > CaptureRestore.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES) {
    throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
  }
  const header = headers[0]!;
  let checkpoint: CaptureRestore.TenantTelemetryCaptureBackupCheckpoint;
  try {
    checkpoint = typeof header.checkpoint_json === "string"
      ? JSON.parse(header.checkpoint_json) as CaptureRestore.TenantTelemetryCaptureBackupCheckpoint
      : header.checkpoint_json as CaptureRestore.TenantTelemetryCaptureBackupCheckpoint;
    CaptureRestore.validateTenantTelemetryCaptureBackupCheckpoint(checkpoint, refKey);
  } catch {
    throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
  }
  if (header.backup_id !== backupId || checkpoint.backupId !== backupId
    || header.anchor_sha256 !== checkpoint.anchorSha256
    || header.checkpoint_sha256 !== checkpoint.checkpointSha256
    || header.ref_key_id_sha256 !== checkpoint.refKeyIdSha256
    || Number(header.sealed_at_db_ms) !== checkpoint.sealedAtDbMs) {
    throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
  }
  const leaves: CaptureRestore.TenantTelemetryCaptureCheckpointLeaf[] = leafRows.map((row) => {
    if (row.backup_id !== backupId) throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
    return {
      family: row.family as CaptureRestore.TenantTelemetryCaptureCheckpointFamily,
      identityRefSha256: String(row.identity_ref_sha256),
      recordHmacSha256: String(row.record_hmac_sha256),
      knowledge: row.knowledge as CaptureRestore.TenantTelemetryCaptureCheckpointKnowledge,
      state: row.state as CaptureRestore.TenantTelemetryCaptureCheckpointState,
      sourceHighWaterDbMs: Number(row.source_high_water_db_ms),
    };
  });
  CaptureRestore.assertTenantTelemetryCaptureCheckpointLeaves(checkpoint, leaves, refKey);
  return { checkpoint: structuredClone(checkpoint), leaves: structuredClone(leaves) };
}
