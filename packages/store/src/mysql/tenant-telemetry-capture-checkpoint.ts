import type { Connection, Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import * as CaptureRestore from "../tenant-telemetry-capture-restore.js";
import type { TenantTelemetryCaptureBackupCheckpointRecord } from "../tenant-telemetry-capture-restore-store.js";

type Executor = Connection | Pool | PoolConnection;
type Row = RowDataPacket;

/**
 * Read an immutable checkpoint from the *actual* MySQL source, rather than
 * accepting a caller-owned projection. The published v1 record keeps its
 * original 49-family bytes. A v2 record additionally requires every sealed
 * lineage leaf and its separate 27-family protected root. Neither historical
 * root claims that today's mutable source is still the pre-dump snapshot;
 * the producer must independently compare the locked current source.
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
  // A v1 checkpoint must not silently ignore an orphan 0058 lineage row, and
  // a missing header must not hide one either. The metadata probe permits the
  // published pre-0058 schema to keep reading its unchanged v1 bytes.
  const [lineageTables] = await executor.query<Row[]>(`SELECT COUNT(*) AS n FROM information_schema.tables
    WHERE table_schema=DATABASE() AND BINARY table_name=BINARY 'tenant_telemetry_capture_checkpoint_lineage_leaves'
      AND table_type='BASE TABLE'`);
  const lineageInstalled = Number(lineageTables[0]?.n) === 1;
  const [lineageRows] = lineageInstalled ? await executor.query<Row[]>(
    `SELECT backup_id,family,identity_ref_sha256,record_hmac_sha256,source_high_water_db_ms
       FROM tenant_telemetry_capture_checkpoint_lineage_leaves
      WHERE BINARY backup_id=BINARY ? ORDER BY family,identity_ref_sha256
      LIMIT ${CaptureRestore.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES + 1} ${lock}`,
    [backupId],
  ) : [[] as Row[]];
  if (!headers.length && !leafRows.length && !lineageRows.length) return null;
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
  if (checkpoint.scope !== CaptureRestore.TENANT_TELEMETRY_CAPTURE_CHECKPOINT_V2_SCOPE) {
    if (lineageRows.length !== 0) throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
    return { checkpoint: structuredClone(checkpoint), leaves: structuredClone(leaves) };
  }
  if (!lineageInstalled || lineageRows.length > CaptureRestore.TENANT_TELEMETRY_CAPTURE_RESTORE_MAX_LEAVES) {
    throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
  }
  const lineageLeaves: CaptureRestore.TenantTelemetryCaptureLineageLeaf[] = lineageRows.map((row) => {
    if (row.backup_id !== backupId) throw new CaptureRestore.TenantTelemetryCaptureRestoreIntegrityError();
    return {
      family: row.family as CaptureRestore.TenantTelemetryCaptureLineageFamily,
      identityRefSha256: String(row.identity_ref_sha256),
      recordHmacSha256: String(row.record_hmac_sha256),
      sourceHighWaterDbMs: Number(row.source_high_water_db_ms),
    };
  });
  CaptureRestore.assertTenantTelemetryCaptureLineageLeaves(checkpoint.lineage, lineageLeaves, refKey);
  return { checkpoint: structuredClone(checkpoint), leaves: structuredClone(leaves),
    lineageLeaves: structuredClone(lineageLeaves) };
}
