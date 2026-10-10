import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import { createHash } from "node:crypto";
import {
  BLOB_STORAGE_MIGRATION_SINGLETON_ID,
  BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
  BlobStorageMigrationConflictError,
  BlobStorageMigrationIntegrityError,
  BlobStorageMigrationNotReadyError,
  appendBlobStorageMigrationRoot,
  blobStorageMigrationControlEvidenceSha256,
  blobStorageMigrationDescriptorSha256,
  blobStorageMigrationEventSha256,
  blobStorageMigrationInventoryEntrySha256,
  blobStorageMigrationObjectAckSha256,
  blobStorageMigrationReceiptSha256,
  blobStorageMigrationSourceCleanupAckSha256,
  blobStorageMigrationSourceRecordSha256,
  blobStorageMigrationTargetCleanupAckSha256,
  blobStorageMigrationTargetOwnerSha256,
  blobStorageMigrationUploadTokenSha256,
  emptyBlobStorageMigrationRoot,
  validateBeginBlobStorageMigrationInput,
  type BeginBlobStorageMigrationInput,
  type BlobStorageMigrationControlRecord,
  type BlobStorageMigrationEvent,
  type BlobStorageMigrationInventoryEntry,
  type BlobStorageMigrationObjectAck,
  type BlobStorageMigrationObjectDisposition,
  type BlobStorageMigrationPhysicalObject,
  type BlobStorageMigrationReceipt,
} from "../blob-storage-migration.js";
import {
  BLOB_STORAGE_CONTROL_SINGLETON_ID,
  blobStorageControlEvidenceSha256,
} from "../blob-storage-control.js";
import {
  BlobConflictError,
  BlobTooLargeError,
  type BlobDescriptor,
  type BlobExactInspection,
  type BlobMigrationStore,
} from "../types.js";

type Row = RowDataPacket;

const MIGRATION_NAME = "0028_blob_storage_migration.sql";
const CONTROL_COLUMNS = `singleton_id,control_generation,migration_id,phase,source_backend,
  source_namespace_sha256,target_backend,target_namespace_sha256,rollback_window_ms,
  source_cleanup_delay_ms,cutover_not_before_db_ms,source_cleanup_not_before_db_ms,
  inventory_entry_count,inventory_root_sha256,object_ack_count,object_ack_root_sha256,
  source_cleanup_ack_count,source_cleanup_ack_root_sha256,
  target_cleanup_ack_count,target_cleanup_ack_root_sha256,
  started_at_db_ms,inventory_sealed_at_db_ms,verified_at_db_ms,completed_at_db_ms,
  terminal_receipt_sha256,fleet_drained_evidence_sha256,evidence_sha256`;

function safeInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new BlobStorageMigrationIntegrityError(`${name} is outside the safe integer range`);
  }
  return parsed as number;
}

function nullableString(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

function nullableInteger(value: unknown, name: string): number | undefined {
  return value == null ? undefined : safeInteger(value, name);
}

function rowToControl(row: Row | undefined): BlobStorageMigrationControlRecord {
  if (!row) throw new BlobStorageMigrationIntegrityError("blob migration control is missing");
  const record: BlobStorageMigrationControlRecord = {
    singletonId: safeInteger(row.singleton_id, "blob migration singleton") as 1,
    controlGeneration: safeInteger(row.control_generation, "blob migration generation"),
    phase: String(row.phase) as BlobStorageMigrationControlRecord["phase"],
    inventoryEntryCount: safeInteger(row.inventory_entry_count, "blob migration inventory count"),
    objectAckCount: safeInteger(row.object_ack_count, "blob migration object ACK count"),
    sourceCleanupAckCount: safeInteger(
      row.source_cleanup_ack_count,
      "blob migration source cleanup ACK count",
    ),
    targetCleanupAckCount: safeInteger(
      row.target_cleanup_ack_count,
      "blob migration target cleanup ACK count",
    ),
    ...(nullableString(row.migration_id) === undefined
      ? {} : { migrationId: String(row.migration_id) }),
    ...(nullableString(row.source_backend) === undefined
      ? {} : { sourceBackend: String(row.source_backend) as typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND }),
    ...(nullableString(row.source_namespace_sha256) === undefined
      ? {} : { sourceNamespaceSha256: String(row.source_namespace_sha256) }),
    ...(nullableString(row.target_backend) === undefined
      ? {} : { targetBackend: String(row.target_backend) }),
    ...(nullableString(row.target_namespace_sha256) === undefined
      ? {} : { targetNamespaceSha256: String(row.target_namespace_sha256) }),
    ...(nullableInteger(row.rollback_window_ms, "blob migration rollback window") === undefined
      ? {} : { rollbackWindowMs: safeInteger(row.rollback_window_ms, "blob migration rollback window") }),
    ...(nullableInteger(row.source_cleanup_delay_ms, "blob migration cleanup delay") === undefined
      ? {} : { sourceCleanupDelayMs: safeInteger(row.source_cleanup_delay_ms, "blob migration cleanup delay") }),
    ...(nullableInteger(row.cutover_not_before_db_ms, "blob migration cutover deadline") === undefined
      ? {} : { cutoverNotBeforeDbMs: safeInteger(row.cutover_not_before_db_ms, "blob migration cutover deadline") }),
    ...(nullableInteger(row.source_cleanup_not_before_db_ms, "blob migration cleanup deadline") === undefined
      ? {} : { sourceCleanupNotBeforeDbMs: safeInteger(row.source_cleanup_not_before_db_ms, "blob migration cleanup deadline") }),
    ...(nullableString(row.inventory_root_sha256) === undefined
      ? {} : { inventoryRootSha256: String(row.inventory_root_sha256) }),
    ...(nullableString(row.object_ack_root_sha256) === undefined
      ? {} : { objectAckRootSha256: String(row.object_ack_root_sha256) }),
    ...(nullableString(row.source_cleanup_ack_root_sha256) === undefined
      ? {} : { sourceCleanupAckRootSha256: String(row.source_cleanup_ack_root_sha256) }),
    ...(nullableString(row.target_cleanup_ack_root_sha256) === undefined
      ? {} : { targetCleanupAckRootSha256: String(row.target_cleanup_ack_root_sha256) }),
    ...(nullableInteger(row.started_at_db_ms, "blob migration start time") === undefined
      ? {} : { startedAtDbMs: safeInteger(row.started_at_db_ms, "blob migration start time") }),
    ...(nullableInteger(row.inventory_sealed_at_db_ms, "blob migration inventory time") === undefined
      ? {} : { inventorySealedAtDbMs: safeInteger(row.inventory_sealed_at_db_ms, "blob migration inventory time") }),
    ...(nullableInteger(row.verified_at_db_ms, "blob migration verification time") === undefined
      ? {} : { verifiedAtDbMs: safeInteger(row.verified_at_db_ms, "blob migration verification time") }),
    ...(nullableInteger(row.completed_at_db_ms, "blob migration completion time") === undefined
      ? {} : { completedAtDbMs: safeInteger(row.completed_at_db_ms, "blob migration completion time") }),
    ...(nullableString(row.terminal_receipt_sha256) === undefined
      ? {} : { terminalReceiptSha256: String(row.terminal_receipt_sha256) }),
    ...(nullableString(row.fleet_drained_evidence_sha256) === undefined
      ? {} : { fleetDrainedEvidenceSha256: String(row.fleet_drained_evidence_sha256) }),
    ...(nullableString(row.evidence_sha256) === undefined
      ? {} : { evidenceSha256: String(row.evidence_sha256) }),
  };
  if (record.singletonId !== BLOB_STORAGE_MIGRATION_SINGLETON_ID) {
    throw new BlobStorageMigrationIntegrityError("blob migration singleton is invalid");
  }
  const expected = blobStorageMigrationControlEvidenceSha256({
    ...record,
    evidenceSha256: undefined,
  } as Omit<BlobStorageMigrationControlRecord, "evidenceSha256">);
  if (record.controlGeneration === 0) {
    if (record.phase !== "inactive" || record.evidenceSha256 !== undefined) {
      throw new BlobStorageMigrationIntegrityError();
    }
  } else if (record.evidenceSha256 !== expected) {
    throw new BlobStorageMigrationIntegrityError();
  }
  return record;
}

function descriptorEqual(left: BlobDescriptor, right: BlobDescriptor): boolean {
  return left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.contentType === right.contentType;
}

function descriptorMatchesKnown(
  expected: BlobDescriptor,
  actual: BlobDescriptor,
): boolean {
  return expected.storageKey === actual.storageKey
    && expected.sha256 === actual.sha256
    && expected.sizeBytes === actual.sizeBytes
    && (expected.contentType === undefined || expected.contentType === actual.contentType);
}

function descriptorsCompatible(left: BlobDescriptor, right: BlobDescriptor): boolean {
  return left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && (left.contentType === undefined || right.contentType === undefined
      || left.contentType === right.contentType);
}

function expectedDescriptor(
  storageKey: string,
  sha256: string | undefined,
  sizeBytes: number | undefined,
  contentType: string | undefined,
): BlobDescriptor | undefined {
  if (sha256 === undefined && sizeBytes === undefined) return undefined;
  if (sha256 === undefined || sizeBytes === undefined) {
    throw new BlobStorageMigrationIntegrityError("partial blob descriptor in migration inventory");
  }
  return { storageKey, sha256, sizeBytes, ...(contentType === undefined ? {} : { contentType }) };
}

function maxReadBytes(expected: BlobDescriptor | undefined, configured: number): number {
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error("blob storage migration max object bytes must be positive");
  }
  if (expected && expected.sizeBytes > configured) {
    throw new BlobTooLargeError(expected.storageKey, configured, expected.sizeBytes);
  }
  return configured;
}

async function databaseNow(conn: PoolConnection): Promise<number> {
  const [rows] = await conn.query<Row[]>(
    "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms",
  );
  return safeInteger(rows[0]?.now_ms, "database time");
}

interface Candidate {
  recordKind: BlobStorageMigrationInventoryEntry["recordKind"];
  recordId: string;
  recordSubId: number;
  recordAuxId: number;
  storageKey?: string;
  storageFormat?: string;
  uploadToken?: string;
  disposition: BlobStorageMigrationObjectDisposition;
  expected?: BlobDescriptor;
  sourceRecordSha256: string;
}

export interface MysqlBlobStorageMigrationCoordinatorOptions {
  url: string;
  connectionLimit?: number;
  /** Status/startup readers opt out; every mutating operator process holds the database-wide lock. */
  exclusive?: boolean;
}

/**
 * Offline filesystem-to-S3 coordinator. It never starts HTTP listeners or background workers and
 * is intentionally separate from MysqlSessionStore's runtime surface.
 */
export class MysqlBlobStorageMigrationCoordinator {
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    private readonly operatorLock?: { connection: PoolConnection; name: string },
  ) {}

  static async connect(
    options: MysqlBlobStorageMigrationCoordinatorOptions,
  ): Promise<MysqlBlobStorageMigrationCoordinator> {
    const connectionLimit = options.connectionLimit ?? 2;
    if (!Number.isSafeInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 32
      || (options.exclusive !== false && connectionLimit < 2)) {
      throw new Error("invalid blob migration coordinator connection limit");
    }
    const pool = mysql.createPool({
      uri: options.url,
      connectionLimit,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
    let operatorLock: { connection: PoolConnection; name: string } | undefined;
    try {
      const [markers] = await pool.query<Row[]>(
        "SELECT name FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      if (markers.length !== 1) {
        throw new BlobStorageMigrationNotReadyError("schema_0028_not_installed");
      }
      if (options.exclusive !== false) {
        const connection = await pool.getConnection();
        try {
          const [databaseRows] = await connection.query<Row[]>("SELECT DATABASE() AS database_name");
          const databaseName = nullableString(databaseRows[0]?.database_name);
          if (!databaseName) throw new BlobStorageMigrationIntegrityError("database name is unavailable");
          const databaseSha256 = createHash("sha256").update(databaseName).digest("hex");
          const name = `agent-service:blob-mover:${databaseSha256.slice(0, 32)}`;
          const [lockRows] = await connection.query<Row[]>("SELECT GET_LOCK(?,0) AS acquired", [name]);
          if (safeInteger(lockRows[0]?.acquired, "blob migration operator lock") !== 1) {
            throw new BlobStorageMigrationConflictError("another blob migration operator is active");
          }
          operatorLock = { connection, name };
        } catch (error) {
          connection.release();
          throw error;
        }
      }
      const coordinator = new MysqlBlobStorageMigrationCoordinator(pool, operatorLock);
      await coordinator.getControl();
      return coordinator;
    } catch (error) {
      if (operatorLock) {
        try {
          await operatorLock.connection.query("SELECT RELEASE_LOCK(?)", [operatorLock.name]);
        } catch {
          // pool.end() below closes the owning connection and therefore releases the server lock.
        } finally {
          operatorLock.connection.release();
        }
      }
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let releaseError: unknown;
    if (this.operatorLock) {
      try {
        const [rows] = await this.operatorLock.connection.query<Row[]>(
          "SELECT RELEASE_LOCK(?) AS released",
          [this.operatorLock.name],
        );
        if (safeInteger(rows[0]?.released, "blob migration operator lock release") !== 1) {
          throw new BlobStorageMigrationIntegrityError("blob migration operator lock was lost");
        }
      } catch (error) {
        releaseError = error;
      } finally {
        this.operatorLock.connection.release();
      }
    }
    await this.pool.end();
    if (releaseError !== undefined) throw releaseError;
  }

  private async readControl(
    executor: Pool | PoolConnection,
    lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
  ): Promise<BlobStorageMigrationControlRecord> {
    const [rows] = await executor.query<Row[]>(
      `SELECT ${CONTROL_COLUMNS} FROM blob_storage_migration_control
        WHERE singleton_id=1 ${lock}`,
    );
    if (rows.length !== 1) throw new BlobStorageMigrationIntegrityError();
    return rowToControl(rows[0]);
  }

  async getControl(): Promise<BlobStorageMigrationControlRecord> {
    return this.readControl(this.pool);
  }

  private async assertExclusiveOperator(): Promise<void> {
    if (!this.operatorLock) {
      throw new BlobStorageMigrationConflictError(
        "blob migration mutation requires the exclusive operator lock",
      );
    }
    try {
      const [rows] = await this.operatorLock.connection.query<Row[]>(
        "SELECT CONNECTION_ID() AS connection_id,IS_USED_LOCK(?) AS lock_owner_id",
        [this.operatorLock.name],
      );
      const connectionId = safeInteger(rows[0]?.connection_id, "blob migration lock connection");
      const lockOwnerId = nullableInteger(
        rows[0]?.lock_owner_id,
        "blob migration operator lock owner",
      );
      if (lockOwnerId === undefined || connectionId !== lockOwnerId) {
        throw new BlobStorageMigrationConflictError("blob migration operator lock was lost");
      }
    } catch (error) {
      if (error instanceof BlobStorageMigrationConflictError) throw error;
      throw new BlobStorageMigrationConflictError("blob migration operator lock was lost");
    }
  }

  /**
   * Keep the durable phase stable while one irreversible storage mutation is in flight. If the
   * dedicated named-lock connection disappears, a replacement operator may acquire GET_LOCK, but
   * its phase transition/terminal seal must wait for this shared row lock. The post-mutation owner
   * check then fails and releases the row lock, allowing that operator to reconcile the exact
   * owner-fenced storage result before it advances the control record.
   */
  private async withExternalMutationAuthority<T>(
    expected: BlobStorageMigrationControlRecord,
    phase: "copying" | "abort_cleaning" | "committed",
    mutation: () => Promise<T>,
  ): Promise<T> {
    if (!expected.migrationId) {
      throw new BlobStorageMigrationIntegrityError("blob migration mutation has no identity");
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR SHARE");
      if (current.phase !== phase || current.migrationId !== expected.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration storage authority was lost");
      }
      await this.assertExclusiveOperator();
      const result = await mutation();
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async appendEvent(
    conn: PoolConnection,
    event: Omit<BlobStorageMigrationEvent, "eventSeq" | "eventSha256">,
  ): Promise<void> {
    const [rows] = await conn.query<Row[]>(
      `SELECT COALESCE(MAX(event_seq),0)+1 AS next_seq
         FROM blob_storage_migration_events WHERE migration_id=? FOR UPDATE`,
      [event.migrationId],
    );
    const eventSeq = safeInteger(rows[0]?.next_seq, "blob migration event sequence");
    const body = { ...event, eventSeq };
    const eventSha256 = blobStorageMigrationEventSha256(body);
    await conn.query(
      `INSERT INTO blob_storage_migration_events
         (migration_id,event_seq,control_generation,event_type,from_phase,to_phase,
          inventory_entry_count,inventory_root_sha256,object_ack_count,object_ack_root_sha256,
          occurred_at_db_ms,evidence_sha256,event_sha256)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        body.migrationId,
        body.eventSeq,
        body.controlGeneration,
        body.eventType,
        body.fromPhase,
        body.toPhase,
        body.inventoryEntryCount,
        body.inventoryRootSha256 ?? null,
        body.objectAckCount,
        body.objectAckRootSha256 ?? null,
        body.occurredAtDbMs,
        body.evidenceSha256,
        eventSha256,
      ],
    );
  }

  private async lockRuntimeInventory(conn: PoolConnection): Promise<void> {
    // Full-range locks establish the freeze linearization point against every guarded old writer.
    const locks = [
      "SELECT blob_id FROM blob_objects ORDER BY blob_id FOR UPDATE",
      "SELECT outbox_id FROM blob_delete_outbox ORDER BY outbox_id FOR UPDATE",
      "SELECT artifact_id FROM user_export_artifacts ORDER BY artifact_id FOR UPDATE",
      "SELECT artifact_id,part_number FROM user_export_artifact_parts ORDER BY artifact_id,part_number FOR UPDATE",
      "SELECT request_id,build_generation,ordinal FROM user_export_snapshot_blobs ORDER BY request_id,build_generation,ordinal FOR UPDATE",
      "SELECT outbox_id FROM user_export_artifact_delete_outbox ORDER BY outbox_id FOR UPDATE",
      "SELECT artifact_id,lease_token FROM user_export_download_leases ORDER BY artifact_id,lease_token FOR UPDATE",
    ];
    for (const sql of locks) await conn.query(sql);
  }

  async freeze(input: BeginBlobStorageMigrationInput): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    validateBeginBlobStorageMigrationInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR UPDATE");
      if (current.controlGeneration !== input.expectedControlGeneration) {
        throw new BlobStorageMigrationConflictError("blob migration generation changed");
      }
      if (current.phase !== "inactive" && current.phase !== "aborted") {
        if (current.migrationId === input.migrationId) {
          if (current.sourceBackend !== input.sourceBackend
            || current.sourceNamespaceSha256 !== input.sourceNamespaceSha256
            || current.targetBackend !== input.targetBackend
            || current.targetNamespaceSha256 !== input.targetNamespaceSha256
            || current.rollbackWindowMs !== input.rollbackWindowMs
            || current.sourceCleanupDelayMs !== input.sourceCleanupDelayMs
            || current.fleetDrainedEvidenceSha256 !== input.fleetDrainedEvidenceSha256) {
            throw new BlobStorageMigrationConflictError(
              "blob migration replay changed its durable commitments",
            );
          }
          await conn.commit();
          return current;
        }
        throw new BlobStorageMigrationConflictError("another blob migration is active");
      }
      await this.assertExclusiveOperator();
      const [blobControls] = await conn.query<Row[]>(
        "SELECT control_generation FROM blob_storage_control WHERE singleton_id=1 FOR UPDATE",
      );
      if (blobControls.length !== 1 || safeInteger(blobControls[0]?.control_generation, "blob control generation") !== 0) {
        throw new BlobStorageMigrationConflictError("blob storage generation 1 is already active");
      }
      await this.lockRuntimeInventory(conn);
      const nowMs = await databaseNow(conn);
      const [activeWork] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM blob_delete_outbox
            WHERE completed_at_ms IS NULL AND claim_token IS NOT NULL AND lease_until_ms>?)
          + (SELECT COUNT(*) FROM user_export_artifact_delete_outbox
            WHERE completed_at_ms IS NULL AND claim_token IS NOT NULL AND lease_until_ms>?)
          + (SELECT COUNT(*) FROM user_export_download_leases WHERE lease_until_ms>?) AS active_count`,
        [nowMs, nowMs, nowMs],
      );
      if (safeInteger(activeWork[0]?.active_count, "active blob migration work") !== 0) {
        throw new BlobStorageMigrationNotReadyError("active_claim_or_download_lease");
      }
      const [namespaceHistory] = await conn.query<Row[]>(
        `SELECT (
           EXISTS(SELECT 1 FROM blob_storage_migration_inventory
             WHERE BINARY target_namespace_sha256=BINARY ?)
           OR EXISTS(SELECT 1 FROM blob_storage_migration_receipts
             WHERE BINARY target_namespace_sha256=BINARY ?)
         ) AS attempted`,
        [input.targetNamespaceSha256, input.targetNamespaceSha256],
      );
      if (safeInteger(namespaceHistory[0]?.attempted, "target namespace history") !== 0
        || (current.targetNamespaceSha256 === input.targetNamespaceSha256)) {
        throw new BlobStorageMigrationConflictError("target namespace was already attempted");
      }
      const generation = current.controlGeneration + 1;
      const body: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        singletonId: 1,
        controlGeneration: generation,
        phase: "frozen",
        migrationId: input.migrationId,
        sourceBackend: input.sourceBackend,
        sourceNamespaceSha256: input.sourceNamespaceSha256,
        targetBackend: input.targetBackend,
        targetNamespaceSha256: input.targetNamespaceSha256,
        fleetDrainedEvidenceSha256: input.fleetDrainedEvidenceSha256,
        rollbackWindowMs: input.rollbackWindowMs,
        sourceCleanupDelayMs: input.sourceCleanupDelayMs,
        cutoverNotBeforeDbMs: nowMs + input.rollbackWindowMs,
        inventoryEntryCount: 0,
        objectAckCount: 0,
        sourceCleanupAckCount: 0,
        targetCleanupAckCount: 0,
        startedAtDbMs: nowMs,
      };
      if (!Number.isSafeInteger(body.cutoverNotBeforeDbMs)) {
        throw new Error("blob migration cutover deadline exceeds the safe integer range");
      }
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(body);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET
           control_generation=?,migration_id=?,phase='frozen',source_backend=?,
           source_namespace_sha256=?,target_backend=?,target_namespace_sha256=?,
           rollback_window_ms=?,source_cleanup_delay_ms=?,cutover_not_before_db_ms=?,
           source_cleanup_not_before_db_ms=NULL,inventory_entry_count=0,
           inventory_root_sha256=NULL,object_ack_count=0,object_ack_root_sha256=NULL,
           source_cleanup_ack_count=0,source_cleanup_ack_root_sha256=NULL,
           target_cleanup_ack_count=0,target_cleanup_ack_root_sha256=NULL,
           started_at_db_ms=?,inventory_sealed_at_db_ms=NULL,verified_at_db_ms=NULL,
           completed_at_db_ms=NULL,terminal_receipt_sha256=NULL,
           fleet_drained_evidence_sha256=?,evidence_sha256=?
         WHERE singleton_id=1 AND control_generation=? AND phase=?`,
        [
          generation,
          input.migrationId,
          input.sourceBackend,
          input.sourceNamespaceSha256,
          input.targetBackend,
          input.targetNamespaceSha256,
          input.rollbackWindowMs,
          input.sourceCleanupDelayMs,
          body.cutoverNotBeforeDbMs,
          nowMs,
          input.fleetDrainedEvidenceSha256,
          evidenceSha256,
          current.controlGeneration,
          current.phase,
        ],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: input.migrationId,
        controlGeneration: generation,
        eventType: "frozen",
        fromPhase: current.phase,
        toPhase: "frozen",
        inventoryEntryCount: 0,
        objectAckCount: 0,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const frozen = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return frozen;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async loadCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    const [blobs] = await this.pool.query<Row[]>(
      `SELECT b.*,
          EXISTS(SELECT 1 FROM blob_delete_outbox o
            WHERE o.blob_id=b.blob_id AND o.completed_at_ms IS NULL) AS has_open_delete
         FROM blob_objects b
        WHERE b.state<>'deleted'
           OR EXISTS(SELECT 1 FROM blob_delete_outbox o
                WHERE o.blob_id=b.blob_id AND o.completed_at_ms IS NULL)
        ORDER BY b.blob_id`,
    );
    for (const row of blobs) {
      const state = String(row.state);
      const storageKey = String(row.storage_key);
      const sha = nullableString(row.sha256 instanceof Buffer
        ? row.sha256.toString("hex") : row.sha256);
      const size = nullableInteger(row.size_bytes, "blob size");
      const contentType = nullableString(row.content_type);
      const descriptor = expectedDescriptor(storageKey, sha, size, contentType);
      let disposition: Candidate["disposition"];
      if (state === "delete_pending" || state === "deleted" || Boolean(row.has_open_delete)) {
        disposition = "tombstone";
      } else if (state === "ready" || descriptor !== undefined) {
        if (!descriptor) throw new BlobStorageMigrationIntegrityError("ready blob has no descriptor");
        disposition = "data";
      } else if (state === "staging") {
        disposition = "absent";
      } else {
        throw new BlobStorageMigrationIntegrityError("blob has an unknown lifecycle state");
      }
      candidates.push({
        recordKind: "blob_object",
        recordId: String(row.blob_id),
        recordSubId: safeInteger(row.deletion_generation, "blob deletion generation"),
        recordAuxId: 0,
        storageKey,
        storageFormat: String(row.storage_format),
        uploadToken: String(row.upload_token),
        disposition,
        ...(descriptor === undefined ? {} : { expected: descriptor }),
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("blob_object", [
          row.blob_id,
          row.tenant_id,
          row.user_id,
          row.session_id,
          row.item_id ?? null,
          row.purpose,
          row.storage_backend,
          row.storage_format,
          row.storage_key,
          row.upload_token,
          row.state,
          sha ?? null,
          size ?? null,
          contentType ?? null,
          nullableInteger(row.uploaded_at_ms, "blob uploaded time") ?? null,
          nullableInteger(row.ready_at_ms, "blob ready time") ?? null,
          nullableInteger(row.staging_expires_at_ms, "blob staging deadline") ?? null,
          nullableInteger(row.delete_after_ms, "blob delete deadline") ?? null,
          nullableInteger(row.deleted_at_ms, "blob deleted time") ?? null,
          safeInteger(row.deletion_generation, "blob deletion generation"),
          safeInteger(row.created_at_ms, "blob created time"),
        ]),
      });
    }

    const [blobIntents] = await this.pool.query<Row[]>(
      `SELECT o.*,b.tenant_id,b.user_id,b.session_id,b.storage_backend,b.storage_format,
              b.storage_key,b.upload_token,b.sha256,b.size_bytes,b.content_type,b.state
         FROM blob_delete_outbox o
         LEFT JOIN blob_objects b ON b.blob_id=o.blob_id
        WHERE o.completed_at_ms IS NULL ORDER BY o.outbox_id`,
    );
    for (const row of blobIntents) {
      if (row.storage_key == null) {
        throw new BlobStorageMigrationIntegrityError("blob delete intent has no manifest");
      }
      const storageKey = String(row.storage_key);
      const sha = nullableString(row.sha256 instanceof Buffer
        ? row.sha256.toString("hex") : row.sha256);
      const size = nullableInteger(row.size_bytes, "blob delete size");
      const contentType = nullableString(row.content_type);
      const descriptor = expectedDescriptor(storageKey, sha, size, contentType);
      candidates.push({
        recordKind: "blob_delete_intent",
        recordId: String(row.outbox_id),
        recordSubId: safeInteger(row.generation, "blob delete generation"),
        recordAuxId: 0,
        storageKey,
        storageFormat: String(row.storage_format),
        uploadToken: String(row.upload_token),
        disposition: "tombstone",
        ...(descriptor === undefined ? {} : { expected: descriptor }),
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("blob_delete_intent", [
          String(row.outbox_id),
          row.blob_id,
          row.tenant_id,
          row.user_id,
          row.session_id,
          row.storage_backend,
          row.storage_format,
          row.storage_key,
          row.upload_token,
          row.state,
          sha ?? null,
          size ?? null,
          contentType ?? null,
          safeInteger(row.generation, "blob delete generation"),
          nullableInteger(row.available_at_ms, "blob delete availability") ?? null,
          safeInteger(row.attempts, "blob delete attempts"),
          row.claim_token ?? null,
          nullableInteger(row.lease_until_ms, "blob delete lease") ?? null,
          row.dead_lettered_at_ms == null ? null : safeInteger(row.dead_lettered_at_ms, "blob delete dead letter time"),
          safeInteger(row.created_at_ms, "blob delete created time"),
        ]),
      });
    }

    const [artifacts] = await this.pool.query<Row[]>(
      "SELECT * FROM user_export_artifacts WHERE state<>'deleted' ORDER BY artifact_id",
    );
    for (const row of artifacts) {
      candidates.push({
        recordKind: "export_artifact",
        recordId: String(row.artifact_id),
        recordSubId: safeInteger(row.build_generation, "export build generation"),
        recordAuxId: 0,
        disposition: "metadata",
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("export_artifact", [
          row.artifact_id,
          row.request_id,
          row.tenant_id,
          row.user_id,
          safeInteger(row.subject_generation, "export subject generation"),
          safeInteger(row.build_generation, "export build generation"),
          row.export_format,
          safeInteger(row.export_schema_version, "export schema version"),
          row.content_type,
          row.content_encoding,
          row.storage_backend,
          row.storage_format,
          row.state,
          safeInteger(row.part_count, "export part count"),
          String(row.record_count),
          String(row.total_size_bytes),
          row.manifest_sha256 ?? null,
          row.content_sha256 ?? null,
          row.snapshot_root_sha256,
          row.policy_version,
          row.policy_sha256,
          String(row.deletion_generation),
        ]),
      });
    }

    const [parts] = await this.pool.query<Row[]>(
      `SELECT p.*,
          EXISTS(SELECT 1 FROM user_export_artifact_delete_outbox o
            WHERE o.artifact_id=p.artifact_id AND o.part_number=p.part_number
              AND o.completed_at_ms IS NULL) AS has_open_delete
         FROM user_export_artifact_parts p
        WHERE p.state<>'deleted'
           OR EXISTS(SELECT 1 FROM user_export_artifact_delete_outbox o
                WHERE o.artifact_id=p.artifact_id AND o.part_number=p.part_number
                  AND o.completed_at_ms IS NULL)
        ORDER BY p.artifact_id,p.part_number`,
    );
    for (const row of parts) {
      const state = String(row.state);
      const storageKey = String(row.storage_key);
      const descriptor = expectedDescriptor(
        storageKey,
        nullableString(row.sha256),
        nullableInteger(row.size_bytes, "export part size"),
        nullableString(row.content_type),
      );
      let disposition: Candidate["disposition"];
      if (state === "delete_pending" || state === "deleted" || Boolean(row.has_open_delete)) {
        disposition = "tombstone";
      } else if (state === "uploaded" || descriptor !== undefined) {
        if (!descriptor) throw new BlobStorageMigrationIntegrityError("uploaded export part has no descriptor");
        disposition = "data";
      } else if (state === "staging") {
        disposition = "absent";
      } else {
        throw new BlobStorageMigrationIntegrityError("export part has an unknown lifecycle state");
      }
      candidates.push({
        recordKind: "export_part",
        recordId: String(row.artifact_id),
        recordSubId: safeInteger(row.part_number, "export part number"),
        recordAuxId: safeInteger(row.build_generation, "export part build generation"),
        storageKey,
        storageFormat: String(row.storage_format),
        uploadToken: String(row.upload_token),
        disposition,
        ...(descriptor === undefined ? {} : { expected: descriptor }),
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("export_part", [
          row.artifact_id,
          safeInteger(row.part_number, "export part number"),
          row.request_id,
          safeInteger(row.build_generation, "export part build generation"),
          row.tenant_id,
          row.user_id,
          safeInteger(row.subject_generation, "export subject generation"),
          row.state,
          row.storage_backend,
          row.storage_format,
          row.storage_key,
          row.upload_token,
          row.content_type ?? null,
          row.content_encoding,
          row.sha256 ?? null,
          row.size_bytes == null ? null : String(row.size_bytes),
          row.record_count == null ? null : String(row.record_count),
          String(row.deletion_generation),
        ]),
      });
    }

    const [pins] = await this.pool.query<Row[]>(
      `SELECT * FROM user_export_snapshot_blobs
        WHERE released_at_ms IS NULL ORDER BY request_id,build_generation,ordinal`,
    );
    for (const row of pins) {
      const storageKey = String(row.storage_key);
      const descriptor = expectedDescriptor(
        storageKey,
        String(row.source_sha256),
        safeInteger(row.source_size_bytes, "snapshot blob size"),
        nullableString(row.source_content_type),
      );
      if (!descriptor) throw new BlobStorageMigrationIntegrityError("snapshot pin has no descriptor");
      candidates.push({
        recordKind: "export_snapshot_pin",
        recordId: String(row.request_id),
        recordSubId: safeInteger(row.build_generation, "snapshot build generation"),
        recordAuxId: safeInteger(row.ordinal, "snapshot ordinal"),
        storageKey,
        storageFormat: String(row.storage_format),
        uploadToken: String(row.upload_token),
        disposition: "data",
        expected: descriptor,
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("export_snapshot_pin", [
          row.request_id,
          String(row.build_generation),
          String(row.ordinal),
          row.blob_id,
          row.tenant_id,
          row.user_id,
          String(row.subject_generation),
          row.session_id,
          row.item_id ?? null,
          row.purpose,
          row.storage_backend,
          row.storage_namespace_sha256 ?? null,
          row.storage_format,
          row.storage_key,
          row.upload_token,
          String(row.source_deletion_generation),
          row.source_sha256,
          String(row.source_size_bytes),
          row.source_content_type ?? null,
          row.pin_token,
        ]),
      });
    }

    const [exportIntents] = await this.pool.query<Row[]>(
      `SELECT o.*,p.artifact_id AS part_artifact_id,p.request_id AS part_request_id,
              p.build_generation AS part_build_generation,
              p.deletion_generation AS part_deletion_generation,
              p.storage_backend AS part_storage_backend,p.storage_format AS part_storage_format,
              p.storage_key AS part_storage_key,p.upload_token AS part_upload_token,
              p.sha256 AS part_sha256,p.size_bytes AS part_size_bytes,
              p.content_type AS part_content_type
         FROM user_export_artifact_delete_outbox o
         LEFT JOIN user_export_artifact_parts p
           ON BINARY p.artifact_id=BINARY o.artifact_id AND p.part_number=o.part_number
        WHERE o.completed_at_ms IS NULL ORDER BY o.outbox_id`,
    );
    for (const row of exportIntents) {
      if (row.part_artifact_id != null && (
        String(row.part_request_id) !== String(row.request_id)
        || safeInteger(row.part_build_generation, "export part build generation")
          !== safeInteger(row.build_generation, "export delete build generation")
        || safeInteger(row.part_deletion_generation, "export part deletion generation")
          !== safeInteger(row.deletion_generation, "export delete generation")
        || String(row.part_storage_backend) !== String(row.storage_backend)
        || String(row.part_storage_format) !== String(row.storage_format)
        || String(row.part_storage_key) !== String(row.storage_key)
        || String(row.part_upload_token) !== String(row.upload_token)
        || nullableString(row.part_sha256) !== nullableString(row.expected_sha256)
        || nullableInteger(row.part_size_bytes, "export part size")
          !== nullableInteger(row.expected_size_bytes, "export delete expected size")
      )) {
        throw new BlobStorageMigrationIntegrityError(
          "export delete intent does not match its artifact part",
        );
      }
      const storageKey = String(row.storage_key);
      const descriptor = expectedDescriptor(
        storageKey,
        nullableString(row.expected_sha256),
        nullableInteger(row.expected_size_bytes, "export delete expected size"),
        nullableString(row.part_content_type),
      );
      candidates.push({
        recordKind: "export_delete_intent",
        recordId: String(row.outbox_id),
        recordSubId: safeInteger(row.deletion_generation, "export delete generation"),
        recordAuxId: safeInteger(row.part_number, "export delete part number"),
        storageKey,
        storageFormat: String(row.storage_format),
        uploadToken: String(row.upload_token),
        disposition: "tombstone",
        ...(descriptor === undefined ? {} : { expected: descriptor }),
        sourceRecordSha256: blobStorageMigrationSourceRecordSha256("export_delete_intent", [
          String(row.outbox_id),
          row.artifact_id,
          String(row.part_number),
          row.request_id,
          String(row.build_generation),
          String(row.deletion_generation),
          row.storage_backend,
          row.storage_format,
          row.storage_key,
          row.upload_token,
          row.expected_sha256 ?? null,
          row.expected_size_bytes == null ? null : String(row.expected_size_bytes),
          String(row.attempts),
          row.claim_token ?? null,
          row.lease_until_ms == null ? null : String(row.lease_until_ms),
          row.dead_lettered_at_ms == null ? null : String(row.dead_lettered_at_ms),
        ]),
      });
    }
    return candidates;
  }

  private async resolveCandidateObjects(
    candidates: Candidate[],
    source: BlobMigrationStore,
    maxBytes: number,
  ): Promise<void> {
    const inspections = new Map<string, BlobExactInspection>();
    for (const candidate of candidates) {
      if (!candidate.storageKey) continue;
      let inspection = inspections.get(candidate.storageKey);
      if (!inspection) {
        inspection = await source.inspectExact(candidate.storageKey, {
          maxBytes: maxReadBytes(candidate.expected, maxBytes),
        });
        inspections.set(candidate.storageKey, inspection);
      }
      if (candidate.disposition === "absent") {
        if (inspection.kind === "missing") continue;
        if (inspection.kind === "tombstone") {
          throw new BlobStorageMigrationConflictError("staging source is cancellation-fenced");
        }
        candidate.disposition = "data";
        candidate.expected = inspection.descriptor;
      } else if (candidate.disposition === "data") {
        if (inspection.kind !== "data" || !candidate.expected
          || !descriptorEqual(inspection.descriptor, candidate.expected)) {
          throw new BlobStorageMigrationConflictError("source object does not match its manifest");
        }
      } else if (candidate.disposition === "tombstone"
        && inspection.kind === "data" && candidate.expected
      ) {
        if (!descriptorMatchesKnown(candidate.expected, inspection.descriptor)) {
          throw new BlobStorageMigrationConflictError("delete source object does not match its manifest");
        }
        candidate.expected = inspection.descriptor;
      } else if (candidate.disposition === "tombstone"
        && inspection.kind === "data" && !candidate.expected) {
        candidate.expected = inspection.descriptor;
      }
    }

    const byKey = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      if (!candidate.storageKey) continue;
      const rows = byKey.get(candidate.storageKey) ?? [];
      rows.push(candidate);
      byKey.set(candidate.storageKey, rows);
    }
    for (const rows of byKey.values()) {
      const first = rows[0]!;
      let mergedExpected = first.expected;
      for (const candidate of rows.slice(1)) {
        if (candidate.disposition !== first.disposition
          || candidate.storageFormat !== first.storageFormat
          || blobStorageMigrationUploadTokenSha256(candidate.uploadToken!)
            !== blobStorageMigrationUploadTokenSha256(first.uploadToken!)) {
          throw new BlobStorageMigrationConflictError("storage key has conflicting owners or dispositions");
        }
        if (candidate.expected) {
          if (mergedExpected) {
            if (!descriptorsCompatible(mergedExpected, candidate.expected)) {
              throw new BlobStorageMigrationConflictError("storage key has conflicting descriptors");
            }
            if (mergedExpected.contentType === undefined
              && candidate.expected.contentType !== undefined) {
              mergedExpected = candidate.expected;
            }
          } else {
            mergedExpected = candidate.expected;
          }
        }
      }
      if (first.disposition === "data" && !mergedExpected) {
        throw new BlobStorageMigrationConflictError("storage key has a partial descriptor conflict");
      }
      if (mergedExpected) {
        for (const candidate of rows) candidate.expected = mergedExpected;
      }
    }
  }

  async sealInventory(
    source: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const before = await this.getControl();
    if (source.backend !== before.sourceBackend
      || source.namespaceSha256 !== before.sourceNamespaceSha256) {
      throw new BlobStorageMigrationConflictError("filesystem source identity changed");
    }
    if (before.phase === "inventory_sealed" || before.phase === "copying"
      || before.phase === "verified") return before;
    if (before.phase !== "frozen" || !before.migrationId
      || !before.sourceNamespaceSha256 || !before.targetBackend
      || !before.targetNamespaceSha256) {
      throw new BlobStorageMigrationConflictError("blob migration is not frozen");
    }
    const candidates = await this.loadCandidates();
    await this.resolveCandidateObjects(candidates, source, maxBytes);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const control = await this.readControl(conn, "FOR UPDATE");
      if (control.phase !== "frozen" || control.migrationId !== before.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration phase changed while inventorying");
      }
      await this.assertExclusiveOperator();
      const createdAtDbMs = await databaseNow(conn);
      let root = emptyBlobStorageMigrationRoot("inventory");
      let ordinal = 0;
      for (const candidate of candidates) {
        ordinal += 1;
        const base: Omit<BlobStorageMigrationInventoryEntry, "entrySha256"> = {
          migrationId: control.migrationId!,
          entryOrdinal: ordinal,
          recordKind: candidate.recordKind,
          recordId: candidate.recordId,
          recordSubId: candidate.recordSubId,
          recordAuxId: candidate.recordAuxId,
          ...(candidate.storageKey === undefined ? {} : { storageKey: candidate.storageKey }),
          sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
          sourceNamespaceSha256: control.sourceNamespaceSha256!,
          targetBackend: control.targetBackend!,
          targetNamespaceSha256: control.targetNamespaceSha256!,
          ...(candidate.storageFormat === undefined ? {} : { storageFormat: candidate.storageFormat }),
          objectDisposition: candidate.disposition,
          ...(candidate.expected === undefined ? {} : {
            expectedSha256: candidate.expected.sha256,
            expectedSizeBytes: candidate.expected.sizeBytes,
            ...(candidate.expected.contentType === undefined
              ? {} : { expectedContentType: candidate.expected.contentType }),
          }),
          ...(candidate.uploadToken === undefined ? {} : {
            sourceUploadTokenSha256: blobStorageMigrationUploadTokenSha256(candidate.uploadToken),
          }),
          sourceRecordSha256: candidate.sourceRecordSha256,
          createdAtDbMs,
        };
        const entrySha256 = blobStorageMigrationInventoryEntrySha256(base);
        root = appendBlobStorageMigrationRoot("inventory", root, ordinal, entrySha256);
        await conn.query(
          `INSERT INTO blob_storage_migration_inventory
             (migration_id,entry_ordinal,record_kind,record_id,record_sub_id,record_aux_id,
              storage_key,source_backend,source_namespace_sha256,target_backend,
              target_namespace_sha256,storage_format,object_disposition,expected_sha256,
              expected_size_bytes,expected_content_type,source_upload_token_sha256,
              source_record_sha256,entry_sha256,created_at_db_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            base.migrationId,
            base.entryOrdinal,
            base.recordKind,
            base.recordId,
            base.recordSubId,
            base.recordAuxId,
            base.storageKey ?? null,
            base.sourceBackend,
            base.sourceNamespaceSha256,
            base.targetBackend,
            base.targetNamespaceSha256,
            base.storageFormat ?? null,
            base.objectDisposition,
            base.expectedSha256 ?? null,
            base.expectedSizeBytes ?? null,
            base.expectedContentType ?? null,
            base.sourceUploadTokenSha256 ?? null,
            base.sourceRecordSha256,
            entrySha256,
            base.createdAtDbMs,
          ],
        );
      }
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...control,
        phase: "inventory_sealed",
        inventoryEntryCount: candidates.length,
        inventoryRootSha256: root,
        inventorySealedAtDbMs: createdAtDbMs,
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='inventory_sealed',
            inventory_entry_count=?,inventory_root_sha256=?,inventory_sealed_at_db_ms=?,
            evidence_sha256=?
          WHERE singleton_id=1 AND phase='frozen' AND migration_id=?`,
        [candidates.length, root, createdAtDbMs, evidenceSha256, control.migrationId],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: control.migrationId!,
        controlGeneration: control.controlGeneration,
        eventType: "inventory_sealed",
        fromPhase: "frozen",
        toPhase: "inventory_sealed",
        inventoryEntryCount: candidates.length,
        inventoryRootSha256: root,
        objectAckCount: 0,
        occurredAtDbMs: createdAtDbMs,
        evidenceSha256,
      });
      const sealed = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return sealed;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async loadUploadTokens(): Promise<Map<string, string>> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT storage_key,upload_token FROM blob_objects
       UNION ALL SELECT storage_key,upload_token FROM user_export_artifact_parts
       UNION ALL SELECT storage_key,upload_token FROM user_export_snapshot_blobs
       UNION ALL SELECT storage_key,upload_token FROM user_export_artifact_delete_outbox`,
    );
    const tokens = new Map<string, string>();
    for (const row of rows) {
      const key = String(row.storage_key);
      const token = String(row.upload_token);
      const existing = tokens.get(key);
      if (existing !== undefined
        && blobStorageMigrationUploadTokenSha256(existing)
          !== blobStorageMigrationUploadTokenSha256(token)) {
        throw new BlobStorageMigrationIntegrityError("storage key has multiple upload tokens");
      }
      tokens.set(key, token);
    }
    return tokens;
  }

  private async loadPhysicalObjects(
    control: BlobStorageMigrationControlRecord,
  ): Promise<BlobStorageMigrationPhysicalObject[]> {
    if (!control.migrationId || !control.inventoryRootSha256) {
      throw new BlobStorageMigrationIntegrityError("blob migration inventory is not sealed");
    }
    const [rows] = await this.pool.query<Row[]>(
      `SELECT migration_id,entry_ordinal,record_kind,record_id,record_sub_id,record_aux_id,
              storage_key,source_backend,source_namespace_sha256,target_backend,
              target_namespace_sha256,storage_format,object_disposition,expected_sha256,
              expected_size_bytes,expected_content_type,source_upload_token_sha256,
              source_record_sha256,entry_sha256,created_at_db_ms
         FROM blob_storage_migration_inventory
        WHERE migration_id=? ORDER BY entry_ordinal`,
      [control.migrationId],
    );
    if (rows.length !== control.inventoryEntryCount) {
      throw new BlobStorageMigrationIntegrityError("blob migration inventory count changed");
    }
    let root = emptyBlobStorageMigrationRoot("inventory");
    const physical = new Map<string, {
      disposition: BlobStorageMigrationPhysicalObject["objectDisposition"];
      expected?: BlobDescriptor;
      tokenSha256: string;
    }>();
    for (const row of rows) {
      const entry: Omit<BlobStorageMigrationInventoryEntry, "entrySha256"> = {
        migrationId: String(row.migration_id),
        entryOrdinal: safeInteger(row.entry_ordinal, "blob inventory ordinal"),
        recordKind: String(row.record_kind) as BlobStorageMigrationInventoryEntry["recordKind"],
        recordId: String(row.record_id),
        recordSubId: safeInteger(row.record_sub_id, "blob inventory record sub id"),
        recordAuxId: safeInteger(row.record_aux_id, "blob inventory record aux id"),
        ...(row.storage_key == null ? {} : { storageKey: String(row.storage_key) }),
        sourceBackend: String(row.source_backend) as typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
        sourceNamespaceSha256: String(row.source_namespace_sha256),
        targetBackend: String(row.target_backend),
        targetNamespaceSha256: String(row.target_namespace_sha256),
        ...(row.storage_format == null ? {} : { storageFormat: String(row.storage_format) }),
        objectDisposition: String(row.object_disposition) as BlobStorageMigrationObjectDisposition,
        ...(row.expected_sha256 == null ? {} : { expectedSha256: String(row.expected_sha256) }),
        ...(row.expected_size_bytes == null ? {} : {
          expectedSizeBytes: safeInteger(row.expected_size_bytes, "blob inventory expected size"),
        }),
        ...(row.expected_content_type == null ? {} : {
          expectedContentType: String(row.expected_content_type),
        }),
        ...(row.source_upload_token_sha256 == null ? {} : {
          sourceUploadTokenSha256: String(row.source_upload_token_sha256),
        }),
        sourceRecordSha256: String(row.source_record_sha256),
        createdAtDbMs: safeInteger(row.created_at_db_ms, "blob inventory creation time"),
      };
      const entrySha256 = blobStorageMigrationInventoryEntrySha256(entry);
      if (entrySha256 !== String(row.entry_sha256)) {
        throw new BlobStorageMigrationIntegrityError("blob migration inventory entry changed");
      }
      root = appendBlobStorageMigrationRoot("inventory", root, entry.entryOrdinal, entrySha256);
      if (entry.objectDisposition === "metadata") continue;
      if (!entry.storageKey || !entry.sourceUploadTokenSha256) {
        throw new BlobStorageMigrationIntegrityError("physical inventory entry is incomplete");
      }
      const descriptor = expectedDescriptor(
        entry.storageKey,
        entry.expectedSha256,
        entry.expectedSizeBytes,
        entry.expectedContentType,
      );
      const existing = physical.get(entry.storageKey);
      if (existing) {
        if (existing.disposition !== entry.objectDisposition
          || existing.tokenSha256 !== entry.sourceUploadTokenSha256
          || (existing.expected && descriptor && !descriptorEqual(existing.expected, descriptor))
          || ((existing.expected === undefined) !== (descriptor === undefined)
            && entry.objectDisposition === "data")) {
          throw new BlobStorageMigrationIntegrityError("physical inventory is internally inconsistent");
        }
      } else {
        physical.set(entry.storageKey, {
          disposition: entry.objectDisposition,
          ...(descriptor === undefined ? {} : { expected: descriptor }),
          tokenSha256: entry.sourceUploadTokenSha256,
        });
      }
    }
    if (root !== control.inventoryRootSha256) {
      throw new BlobStorageMigrationIntegrityError("blob migration inventory root changed");
    }
    const tokens = await this.loadUploadTokens();
    return [...physical.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([storageKey, object]) => {
        const sourceUploadToken = tokens.get(storageKey);
        if (!sourceUploadToken
          || blobStorageMigrationUploadTokenSha256(sourceUploadToken) !== object.tokenSha256) {
          throw new BlobStorageMigrationIntegrityError("physical inventory upload token changed");
        }
        return {
          migrationId: control.migrationId!,
          storageKey,
          objectDisposition: object.disposition,
          ...(object.expected === undefined ? {} : { expectedDescriptor: object.expected }),
          sourceUploadToken,
        };
      },
    );
  }

  private async transitionToCopying(): Promise<BlobStorageMigrationControlRecord> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const control = await this.readControl(conn, "FOR UPDATE");
      if (["copying", "verified", "committed", "source_cleaned"].includes(control.phase)) {
        await conn.commit();
        return control;
      }
      if (control.phase !== "inventory_sealed" || !control.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration inventory is not ready to copy");
      }
      await this.assertExclusiveOperator();
      const nowMs = await databaseNow(conn);
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...control,
        phase: "copying",
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='copying',evidence_sha256=?
          WHERE singleton_id=1 AND phase='inventory_sealed' AND migration_id=?`,
        [evidenceSha256, control.migrationId],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: control.migrationId,
        controlGeneration: control.controlGeneration,
        eventType: "copying",
        fromPhase: "inventory_sealed",
        toPhase: "copying",
        inventoryEntryCount: control.inventoryEntryCount,
        inventoryRootSha256: control.inventoryRootSha256,
        objectAckCount: 0,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const result = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async writeObjectAck(
    control: BlobStorageMigrationControlRecord,
    input: Omit<BlobStorageMigrationObjectAck, "verifiedAtDbMs" | "ackSha256">,
  ): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR SHARE");
      if (current.phase !== "copying" || current.migrationId !== input.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration copy authority was lost");
      }
      await this.assertExclusiveOperator();
      const verifiedAtDbMs = await databaseNow(conn);
      const body = { ...input, verifiedAtDbMs };
      const ackSha256 = blobStorageMigrationObjectAckSha256(body);
      try {
        await conn.query(
          `INSERT INTO blob_storage_migration_object_acks
             (migration_id,storage_key,object_disposition,target_backend,target_namespace_sha256,
              expected_sha256,expected_size_bytes,expected_content_type,source_observed_kind,
              target_observed_kind,source_descriptor_sha256,target_descriptor_sha256,
              verified_at_db_ms,ack_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            body.migrationId,
            body.storageKey,
            body.objectDisposition,
            body.targetBackend,
            body.targetNamespaceSha256,
            body.expectedSha256 ?? null,
            body.expectedSizeBytes ?? null,
            body.expectedContentType ?? null,
            body.sourceObservedKind,
            body.targetObservedKind,
            body.sourceDescriptorSha256 ?? null,
            body.targetDescriptorSha256 ?? null,
            body.verifiedAtDbMs,
            ackSha256,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        const [rows] = await conn.query<Row[]>(
          `SELECT object_disposition,target_backend,target_namespace_sha256,expected_sha256,
                  expected_size_bytes,expected_content_type,source_observed_kind,
                  target_observed_kind,source_descriptor_sha256,target_descriptor_sha256,
                  verified_at_db_ms,ack_sha256
             FROM blob_storage_migration_object_acks
            WHERE migration_id=? AND storage_key=? FOR SHARE`,
          [body.migrationId, body.storageKey],
        );
        const row = rows[0];
        if (!row
          || String(row.object_disposition) !== body.objectDisposition
          || String(row.target_backend) !== body.targetBackend
          || String(row.target_namespace_sha256) !== body.targetNamespaceSha256
          || nullableString(row.expected_sha256) !== body.expectedSha256
          || nullableInteger(row.expected_size_bytes, "object ACK expected size") !== body.expectedSizeBytes
          || nullableString(row.expected_content_type) !== body.expectedContentType
          || String(row.source_observed_kind) !== body.sourceObservedKind
          || String(row.target_observed_kind) !== body.targetObservedKind
          || nullableString(row.source_descriptor_sha256) !== body.sourceDescriptorSha256
          || nullableString(row.target_descriptor_sha256) !== body.targetDescriptorSha256) {
          throw new BlobStorageMigrationConflictError("object ACK replay conflicts");
        }
        const replayBody: Omit<BlobStorageMigrationObjectAck, "ackSha256"> = {
          ...input,
          verifiedAtDbMs: safeInteger(row.verified_at_db_ms, "object ACK verification time"),
        };
        if (blobStorageMigrationObjectAckSha256(replayBody) !== String(row.ack_sha256)) {
          throw new BlobStorageMigrationIntegrityError("object ACK evidence changed");
        }
      }
      await this.assertExclusiveOperator();
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private assertStoreIdentities(
    control: BlobStorageMigrationControlRecord,
    source: BlobMigrationStore,
    target: BlobMigrationStore,
  ): void {
    if (source.backend !== control.sourceBackend
      || source.namespaceSha256 !== control.sourceNamespaceSha256) {
      throw new BlobStorageMigrationConflictError("filesystem source identity changed");
    }
    if (target.backend !== control.targetBackend
      || target.namespaceSha256 !== control.targetNamespaceSha256
      || target.shared !== true) {
      throw new BlobStorageMigrationConflictError("S3 target identity changed");
    }
  }

  private async observeAndConvergeObject(
    control: BlobStorageMigrationControlRecord,
    object: BlobStorageMigrationPhysicalObject,
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
    mutateTarget: boolean,
  ): Promise<Omit<BlobStorageMigrationObjectAck, "verifiedAtDbMs" | "ackSha256">> {
    const limit = maxReadBytes(object.expectedDescriptor, maxBytes);
    const migrationOwnerSha256 = blobStorageMigrationTargetOwnerSha256(
      object.migrationId,
      control.targetNamespaceSha256!,
      object.storageKey,
    );
    let sourceState = await source.inspectExact(object.storageKey, { maxBytes: limit });
    let targetState = await target.inspectExact(object.storageKey, { maxBytes: limit });

    if (object.objectDisposition === "data") {
      const expected = object.expectedDescriptor;
      if (!expected || sourceState.kind !== "data"
        || !descriptorEqual(sourceState.descriptor, expected)) {
        throw new BlobStorageMigrationConflictError("source data changed after inventory seal");
      }
      if (targetState.kind === "missing" && mutateTarget) {
        const sourceObject = await source.getExact(object.storageKey, { maxBytes: limit });
        if (!sourceObject || !descriptorEqual(sourceObject, expected)) {
          throw new BlobStorageMigrationConflictError("source data changed during copy");
        }
        await this.withExternalMutationAuthority(control, "copying", () => target.putIfAbsent(
          object.storageKey,
          sourceObject.data,
          {
            uploadToken: object.sourceUploadToken,
            maxBytes: limit,
            migrationOwnerSha256,
            ...(expected.contentType === undefined ? {} : { contentType: expected.contentType }),
          },
        ));
        targetState = await target.inspectExact(object.storageKey, { maxBytes: limit });
        sourceState = await source.inspectExact(object.storageKey, { maxBytes: limit });
      }
      if (sourceState.kind !== "data" || targetState.kind !== "data"
        || !descriptorEqual(sourceState.descriptor, expected)
        || !descriptorEqual(targetState.descriptor, expected)
        || targetState.migrationOwnerSha256 !== migrationOwnerSha256) {
        throw new BlobStorageMigrationConflictError("target data is missing or conflicts");
      }
      const descriptorSha256 = blobStorageMigrationDescriptorSha256(expected);
      return {
        migrationId: object.migrationId,
        storageKey: object.storageKey,
        objectDisposition: "data",
        targetBackend: control.targetBackend!,
        targetNamespaceSha256: control.targetNamespaceSha256!,
        expectedSha256: expected.sha256,
        expectedSizeBytes: expected.sizeBytes,
        ...(expected.contentType === undefined ? {} : { expectedContentType: expected.contentType }),
        sourceObservedKind: "data",
        targetObservedKind: "data",
        sourceDescriptorSha256: descriptorSha256,
        targetDescriptorSha256: descriptorSha256,
      };
    }

    if (object.objectDisposition === "absent") {
      if (sourceState.kind !== "missing" || targetState.kind !== "missing") {
        throw new BlobStorageMigrationConflictError("absent staging object appeared during migration");
      }
      return {
        migrationId: object.migrationId,
        storageKey: object.storageKey,
        objectDisposition: "absent",
        targetBackend: control.targetBackend!,
        targetNamespaceSha256: control.targetNamespaceSha256!,
        sourceObservedKind: "missing",
        targetObservedKind: "missing",
      };
    }

    if (sourceState.kind === "data" && object.expectedDescriptor
      && !descriptorEqual(sourceState.descriptor, object.expectedDescriptor)) {
      throw new BlobStorageMigrationConflictError("delete source data changed after inventory seal");
    }
    if (targetState.kind === "data") {
      throw new BlobStorageMigrationConflictError("target tombstone key is occupied by data");
    }
    if (targetState.kind === "missing" && mutateTarget) {
      await this.withExternalMutationAuthority(control, "copying", () => target.delete(
        object.storageKey,
        {
          uploadToken: object.sourceUploadToken,
          migrationOwnerSha256,
        },
      ));
      targetState = await target.inspectExact(object.storageKey, { maxBytes: limit });
      sourceState = await source.inspectExact(object.storageKey, { maxBytes: limit });
    }
    if (targetState.kind !== "tombstone"
      || targetState.migrationOwnerSha256 !== migrationOwnerSha256) {
      throw new BlobStorageMigrationConflictError("target tombstone was not established");
    }
    return {
      migrationId: object.migrationId,
      storageKey: object.storageKey,
      objectDisposition: "tombstone",
      targetBackend: control.targetBackend!,
      targetNamespaceSha256: control.targetNamespaceSha256!,
      ...(object.expectedDescriptor === undefined ? {} : {
        expectedSha256: object.expectedDescriptor.sha256,
        expectedSizeBytes: object.expectedDescriptor.sizeBytes,
        ...(object.expectedDescriptor.contentType === undefined
          ? {} : { expectedContentType: object.expectedDescriptor.contentType }),
      }),
      sourceObservedKind: sourceState.kind,
      targetObservedKind: "tombstone",
      ...(sourceState.kind === "data"
        ? { sourceDescriptorSha256: blobStorageMigrationDescriptorSha256(sourceState.descriptor) }
        : {}),
    };
  }

  async prepare(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    input: BeginBlobStorageMigrationInput,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    if (source.backend !== BLOB_STORAGE_MIGRATION_SOURCE_BACKEND
      || source.namespaceSha256 !== input.sourceNamespaceSha256
      || target.backend !== input.targetBackend
      || target.namespaceSha256 !== input.targetNamespaceSha256
      || target.shared !== true) {
      throw new BlobStorageMigrationConflictError("configured stores do not match migration input");
    }
    const frozen = await this.freeze(input);
    this.assertStoreIdentities(frozen, source, target);
    if (frozen.phase === "committed" || frozen.phase === "source_cleaned") return frozen;
    return this.sealInventory(source, maxBytes);
  }

  async copy(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const before = await this.getControl();
    this.assertStoreIdentities(before, source, target);
    const control = await this.transitionToCopying();
    this.assertStoreIdentities(control, source, target);
    if (control.phase !== "copying") return control;
    const objects = await this.loadPhysicalObjects(control);
    for (const object of objects) {
      const ack = await this.observeAndConvergeObject(
        control,
        object,
        source,
        target,
        maxBytes,
        true,
      );
      await this.writeObjectAck(control, ack);
    }
    return this.getControl();
  }

  private async readObjectAcks(
    control: BlobStorageMigrationControlRecord,
  ): Promise<Array<BlobStorageMigrationObjectAck>> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT migration_id,storage_key,object_disposition,target_backend,target_namespace_sha256,
              expected_sha256,expected_size_bytes,expected_content_type,source_observed_kind,
              target_observed_kind,source_descriptor_sha256,target_descriptor_sha256,
              verified_at_db_ms,ack_sha256
         FROM blob_storage_migration_object_acks
        WHERE migration_id=? ORDER BY storage_key`,
      [control.migrationId],
    );
    return rows.map((row) => {
      const body: Omit<BlobStorageMigrationObjectAck, "ackSha256"> = {
        migrationId: String(row.migration_id),
        storageKey: String(row.storage_key),
        objectDisposition: String(row.object_disposition) as BlobStorageMigrationObjectAck["objectDisposition"],
        targetBackend: String(row.target_backend),
        targetNamespaceSha256: String(row.target_namespace_sha256),
        ...(row.expected_sha256 == null ? {} : { expectedSha256: String(row.expected_sha256) }),
        ...(row.expected_size_bytes == null ? {} : {
          expectedSizeBytes: safeInteger(row.expected_size_bytes, "object ACK expected size"),
        }),
        ...(row.expected_content_type == null ? {} : {
          expectedContentType: String(row.expected_content_type),
        }),
        sourceObservedKind: String(row.source_observed_kind) as BlobStorageMigrationObjectAck["sourceObservedKind"],
        targetObservedKind: String(row.target_observed_kind) as BlobStorageMigrationObjectAck["targetObservedKind"],
        ...(row.source_descriptor_sha256 == null ? {} : {
          sourceDescriptorSha256: String(row.source_descriptor_sha256),
        }),
        ...(row.target_descriptor_sha256 == null ? {} : {
          targetDescriptorSha256: String(row.target_descriptor_sha256),
        }),
        verifiedAtDbMs: safeInteger(row.verified_at_db_ms, "object ACK verification time"),
      };
      const ackSha256 = blobStorageMigrationObjectAckSha256(body);
      if (ackSha256 !== String(row.ack_sha256)) {
        throw new BlobStorageMigrationIntegrityError("object ACK evidence changed");
      }
      return { ...body, ackSha256 };
    });
  }

  async verify(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const control = await this.getControl();
    if (["verified", "committed", "source_cleaned"].includes(control.phase)) {
      this.assertStoreIdentities(control, source, target);
      return control;
    }
    if (control.phase !== "copying" || !control.migrationId) {
      throw new BlobStorageMigrationConflictError("blob migration is not copying");
    }
    this.assertStoreIdentities(control, source, target);
    const objects = await this.loadPhysicalObjects(control);
    const acks = await this.readObjectAcks(control);
    const ackByKey = new Map(acks.map((ack) => [ack.storageKey, ack]));
    if (acks.length !== objects.length) {
      throw new BlobStorageMigrationNotReadyError("object_ack_count_mismatch");
    }
    for (const object of objects) {
      const observed = await this.observeAndConvergeObject(
        control,
        object,
        source,
        target,
        maxBytes,
        false,
      );
      const ack = ackByKey.get(object.storageKey);
      if (!ack
        || ack.objectDisposition !== observed.objectDisposition
        || ack.targetBackend !== observed.targetBackend
        || ack.targetNamespaceSha256 !== observed.targetNamespaceSha256
        || ack.expectedSha256 !== observed.expectedSha256
        || ack.expectedSizeBytes !== observed.expectedSizeBytes
        || ack.expectedContentType !== observed.expectedContentType
        || ack.sourceObservedKind !== observed.sourceObservedKind
        || ack.targetObservedKind !== observed.targetObservedKind
        || ack.sourceDescriptorSha256 !== observed.sourceDescriptorSha256
        || ack.targetDescriptorSha256 !== observed.targetDescriptorSha256) {
        throw new BlobStorageMigrationConflictError("object changed after its copy ACK");
      }
    }
    let root = emptyBlobStorageMigrationRoot("object-acks");
    acks.forEach((ack, index) => {
      root = appendBlobStorageMigrationRoot("object-acks", root, index + 1, ack.ackSha256);
    });

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR UPDATE");
      if (current.phase !== "copying" || current.migrationId !== control.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration phase changed during verification");
      }
      await this.assertExclusiveOperator();
      const nowMs = await databaseNow(conn);
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...current,
        phase: "verified",
        objectAckCount: acks.length,
        objectAckRootSha256: root,
        verifiedAtDbMs: nowMs,
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='verified',object_ack_count=?,
            object_ack_root_sha256=?,verified_at_db_ms=?,evidence_sha256=?
          WHERE singleton_id=1 AND phase='copying' AND migration_id=?`,
        [acks.length, root, nowMs, evidenceSha256, current.migrationId],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: current.migrationId!,
        controlGeneration: current.controlGeneration,
        eventType: "verified",
        fromPhase: "copying",
        toPhase: "verified",
        inventoryEntryCount: current.inventoryEntryCount,
        inventoryRootSha256: current.inventoryRootSha256,
        objectAckCount: acks.length,
        objectAckRootSha256: root,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const verified = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return verified;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async reverifyPhysicalEvidence(
    control: BlobStorageMigrationControlRecord,
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<void> {
    this.assertStoreIdentities(control, source, target);
    const objects = await this.loadPhysicalObjects(control);
    const acks = await this.readObjectAcks(control);
    const byKey = new Map(acks.map((ack) => [ack.storageKey, ack]));
    if (acks.length !== objects.length || acks.length !== control.objectAckCount) {
      throw new BlobStorageMigrationIntegrityError("verified object ACK count changed");
    }
    let root = emptyBlobStorageMigrationRoot("object-acks");
    acks.forEach((ack, index) => {
      root = appendBlobStorageMigrationRoot("object-acks", root, index + 1, ack.ackSha256);
    });
    if (root !== control.objectAckRootSha256) {
      throw new BlobStorageMigrationIntegrityError("verified object ACK root changed");
    }
    for (const object of objects) {
      const observed = await this.observeAndConvergeObject(
        control,
        object,
        source,
        target,
        maxBytes,
        false,
      );
      const ack = byKey.get(object.storageKey);
      if (!ack
        || ack.objectDisposition !== observed.objectDisposition
        || ack.targetBackend !== observed.targetBackend
        || ack.targetNamespaceSha256 !== observed.targetNamespaceSha256
        || ack.expectedSha256 !== observed.expectedSha256
        || ack.expectedSizeBytes !== observed.expectedSizeBytes
        || ack.expectedContentType !== observed.expectedContentType
        || ack.sourceObservedKind !== observed.sourceObservedKind
        || ack.targetObservedKind !== observed.targetObservedKind
        || ack.sourceDescriptorSha256 !== observed.sourceDescriptorSha256
        || ack.targetDescriptorSha256 !== observed.targetDescriptorSha256) {
        throw new BlobStorageMigrationConflictError("physical evidence changed after verification");
      }
    }
  }

  private async assertCutoverInventory(
    conn: PoolConnection,
    control: BlobStorageMigrationControlRecord,
    backend: "source" | "target",
  ): Promise<void> {
    const expectedBackend = backend === "source" ? control.sourceBackend : control.targetBackend;
    const expectedNamespace = backend === "source" ? undefined : control.targetNamespaceSha256;
    const probes: Array<[string, unknown[]]> = [
      [
        `SELECT i.entry_ordinal FROM blob_storage_migration_inventory i
          LEFT JOIN blob_objects b ON i.record_kind='blob_object'
           AND BINARY b.blob_id=BINARY i.record_id
         WHERE i.migration_id=? AND i.record_kind='blob_object'
           AND (b.blob_id IS NULL OR BINARY b.storage_backend<>BINARY ?)
         LIMIT 1 FOR SHARE`,
        [control.migrationId, expectedBackend],
      ],
      [
        `SELECT i.entry_ordinal FROM blob_storage_migration_inventory i
          LEFT JOIN user_export_artifacts a
            ON i.record_kind='export_artifact'
           AND BINARY a.artifact_id=BINARY i.record_id
         WHERE i.migration_id=? AND i.record_kind='export_artifact'
           AND (a.artifact_id IS NULL OR BINARY a.storage_backend<>BINARY ?)
         LIMIT 1 FOR SHARE`,
        [control.migrationId, expectedBackend],
      ],
      [
        `SELECT i.entry_ordinal FROM blob_storage_migration_inventory i
          LEFT JOIN user_export_artifact_parts p
            ON i.record_kind='export_part'
           AND BINARY p.artifact_id=BINARY i.record_id
             AND p.part_number=i.record_sub_id
         WHERE i.migration_id=? AND i.record_kind='export_part'
           AND (p.artifact_id IS NULL OR BINARY p.storage_backend<>BINARY ?)
         LIMIT 1 FOR SHARE`,
        [control.migrationId, expectedBackend],
      ],
      [
        `SELECT i.entry_ordinal FROM blob_storage_migration_inventory i
          LEFT JOIN user_export_snapshot_blobs s
            ON i.record_kind='export_snapshot_pin'
           AND BINARY s.request_id=BINARY i.record_id
             AND s.build_generation=i.record_sub_id AND s.ordinal=i.record_aux_id
         WHERE i.migration_id=? AND i.record_kind='export_snapshot_pin'
           AND (s.request_id IS NULL OR BINARY s.storage_backend<>BINARY ?
             ${backend === "target"
               ? "OR s.storage_namespace_sha256 IS NULL OR BINARY s.storage_namespace_sha256<>BINARY ?"
               : ""})
         LIMIT 1 FOR SHARE`,
        backend === "target"
          ? [control.migrationId, expectedBackend, expectedNamespace]
          : [control.migrationId, expectedBackend],
      ],
      [
        `SELECT i.entry_ordinal FROM blob_storage_migration_inventory i
          LEFT JOIN user_export_artifact_delete_outbox o
            ON i.record_kind='export_delete_intent'
           AND BINARY i.record_id=BINARY CAST(o.outbox_id AS CHAR)
         WHERE i.migration_id=? AND i.record_kind='export_delete_intent'
           AND (o.outbox_id IS NULL OR BINARY o.storage_backend<>BINARY ?)
         LIMIT 1 FOR SHARE`,
        [control.migrationId, expectedBackend],
      ],
    ];
    for (const [sql, params] of probes) {
      const [rows] = await conn.query<Row[]>(sql, params);
      if (rows.length > 0) {
        throw new BlobStorageMigrationIntegrityError(`database ${backend} inventory changed`);
      }
    }
  }

  async cutover(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const before = await this.getControl();
    if (before.phase === "committed" || before.phase === "source_cleaned") {
      this.assertStoreIdentities(before, source, target);
      return before;
    }
    if (before.phase !== "verified" || !before.migrationId
      || !before.inventoryRootSha256 || !before.objectAckRootSha256
      || !before.sourceNamespaceSha256 || !before.targetBackend
      || !before.targetNamespaceSha256 || before.rollbackWindowMs === undefined
      || before.sourceCleanupDelayMs === undefined || before.cutoverNotBeforeDbMs === undefined
      || !before.fleetDrainedEvidenceSha256) {
      throw new BlobStorageMigrationConflictError("blob migration is not verified");
    }
    await this.reverifyPhysicalEvidence(before, source, target, maxBytes);

    const conn = await this.pool.getConnection();
    let released = false;
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await conn.beginTransaction();
      const control = await this.readControl(conn, "FOR UPDATE");
      if (control.phase !== "verified" || control.migrationId !== before.migrationId
        || !control.migrationId || !control.sourceBackend
        || !control.sourceNamespaceSha256 || !control.targetBackend
        || !control.targetNamespaceSha256 || !control.inventoryRootSha256
        || !control.objectAckRootSha256 || control.rollbackWindowMs === undefined
        || control.sourceCleanupDelayMs === undefined || control.cutoverNotBeforeDbMs === undefined
        || !control.fleetDrainedEvidenceSha256) {
        throw new BlobStorageMigrationConflictError("blob migration phase changed before cutover");
      }
      await this.assertExclusiveOperator();
      const [blobRows] = await conn.query<Row[]>(
        `SELECT control_generation FROM blob_storage_control
          WHERE singleton_id=1 FOR UPDATE`,
      );
      if (blobRows.length !== 1
        || safeInteger(blobRows[0]?.control_generation, "blob control generation") !== 0) {
        throw new BlobStorageMigrationConflictError("blob storage control changed before cutover");
      }
      await this.lockRuntimeInventory(conn);
      await this.assertCutoverInventory(conn, control, "source");
      const nowMs = await databaseNow(conn);
      if (control.cutoverNotBeforeDbMs === undefined || nowMs < control.cutoverNotBeforeDbMs) {
        throw new BlobStorageMigrationNotReadyError("rollback_window_open");
      }
      const sourceCleanupNotBeforeDbMs = nowMs + control.sourceCleanupDelayMs;
      if (!Number.isSafeInteger(sourceCleanupNotBeforeDbMs)) {
        throw new Error("blob migration source cleanup deadline exceeds the safe integer range");
      }

      const cuttingBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...control,
        phase: "cutting_over",
      };
      delete (cuttingBody as { evidenceSha256?: string }).evidenceSha256;
      const cuttingEvidence = blobStorageMigrationControlEvidenceSha256(cuttingBody);
      const [cutting] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='cutting_over',evidence_sha256=?
          WHERE singleton_id=1 AND phase='verified' AND migration_id=?`,
        [cuttingEvidence, control.migrationId],
      );
      if (cutting.affectedRows !== 1) throw new BlobStorageMigrationConflictError();

      await conn.query(
        `UPDATE blob_objects b
          JOIN blob_storage_migration_inventory i
            ON i.migration_id=? AND i.record_kind='blob_object'
           AND BINARY i.record_id=BINARY b.blob_id
           SET b.storage_backend=?
         WHERE BINARY b.storage_backend=BINARY ?`,
        [control.migrationId, control.targetBackend, control.sourceBackend],
      );
      await conn.query(
        `UPDATE user_export_artifacts a
          JOIN blob_storage_migration_inventory i
            ON i.migration_id=? AND i.record_kind='export_artifact'
           AND BINARY i.record_id=BINARY a.artifact_id
           SET a.storage_backend=?
         WHERE BINARY a.storage_backend=BINARY ?`,
        [control.migrationId, control.targetBackend, control.sourceBackend],
      );
      await conn.query(
        `UPDATE user_export_artifact_parts p
          JOIN blob_storage_migration_inventory i
            ON i.migration_id=? AND i.record_kind='export_part'
           AND BINARY i.record_id=BINARY p.artifact_id AND i.record_sub_id=p.part_number
           SET p.storage_backend=?
         WHERE BINARY p.storage_backend=BINARY ?`,
        [control.migrationId, control.targetBackend, control.sourceBackend],
      );
      await conn.query(
        `UPDATE user_export_snapshot_blobs s
          JOIN blob_storage_migration_inventory i
            ON i.migration_id=? AND i.record_kind='export_snapshot_pin'
           AND BINARY i.record_id=BINARY s.request_id AND i.record_sub_id=s.build_generation
           AND i.record_aux_id=s.ordinal
           SET s.storage_backend=?,s.storage_namespace_sha256=?
         WHERE BINARY s.storage_backend=BINARY ? AND s.released_at_ms IS NULL`,
        [
          control.migrationId,
          control.targetBackend,
          control.targetNamespaceSha256,
          control.sourceBackend,
        ],
      );
      await conn.query(
        `UPDATE user_export_artifact_delete_outbox o
          JOIN blob_storage_migration_inventory i
            ON i.migration_id=? AND i.record_kind='export_delete_intent'
           AND BINARY i.record_id=BINARY CAST(o.outbox_id AS CHAR)
           SET o.storage_backend=?
         WHERE BINARY o.storage_backend=BINARY ? AND o.completed_at_ms IS NULL`,
        [control.migrationId, control.targetBackend, control.sourceBackend],
      );
      await this.assertCutoverInventory(conn, control, "target");

      const blobControlBody = {
        singletonId: BLOB_STORAGE_CONTROL_SINGLETON_ID,
        controlGeneration: 1 as const,
        storageBackend: control.targetBackend,
        namespaceSha256: control.targetNamespaceSha256,
        activatedAtDbMs: nowMs,
      };
      const blobControlEvidence = blobStorageControlEvidenceSha256(blobControlBody);
      const [activated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_control SET control_generation=1,storage_backend=?,
            namespace_sha256=?,activated_at_db_ms=?,evidence_sha256=?
          WHERE singleton_id=1 AND control_generation=0`,
        [control.targetBackend, control.targetNamespaceSha256, nowMs, blobControlEvidence],
      );
      if (activated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();

      const receiptBody: Omit<BlobStorageMigrationReceipt, "receiptSha256"> = {
        migrationId: control.migrationId,
        receiptKind: "committed",
        controlGeneration: control.controlGeneration,
        sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
        sourceNamespaceSha256: control.sourceNamespaceSha256,
        targetBackend: control.targetBackend,
        targetNamespaceSha256: control.targetNamespaceSha256,
        rollbackWindowMs: control.rollbackWindowMs,
        sourceCleanupDelayMs: control.sourceCleanupDelayMs,
        cutoverNotBeforeDbMs: control.cutoverNotBeforeDbMs,
        sourceCleanupNotBeforeDbMs,
        inventoryEntryCount: control.inventoryEntryCount,
        inventoryRootSha256: control.inventoryRootSha256,
        objectAckCount: control.objectAckCount,
        objectAckRootSha256: control.objectAckRootSha256,
        sourceCleanupAckCount: 0,
        targetCleanupAckCount: 0,
        fleetDrainedEvidenceSha256: control.fleetDrainedEvidenceSha256,
        blobControlEvidenceSha256: blobControlEvidence,
        occurredAtDbMs: nowMs,
      };
      const receiptSha256 = blobStorageMigrationReceiptSha256(receiptBody);
      await conn.query(
        `INSERT INTO blob_storage_migration_receipts
           (migration_id,receipt_kind,control_generation,source_backend,
            source_namespace_sha256,target_backend,target_namespace_sha256,
            rollback_window_ms,source_cleanup_delay_ms,cutover_not_before_db_ms,
            source_cleanup_not_before_db_ms,
            inventory_entry_count,inventory_root_sha256,object_ack_count,
            object_ack_root_sha256,source_cleanup_ack_count,source_cleanup_ack_root_sha256,
            target_cleanup_ack_count,target_cleanup_ack_root_sha256,
            fleet_drained_evidence_sha256,blob_control_evidence_sha256,
            occurred_at_db_ms,receipt_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          receiptBody.migrationId,
          receiptBody.receiptKind,
          receiptBody.controlGeneration,
          receiptBody.sourceBackend,
          receiptBody.sourceNamespaceSha256,
          receiptBody.targetBackend,
          receiptBody.targetNamespaceSha256,
          receiptBody.rollbackWindowMs,
          receiptBody.sourceCleanupDelayMs,
          receiptBody.cutoverNotBeforeDbMs,
          receiptBody.sourceCleanupNotBeforeDbMs,
          receiptBody.inventoryEntryCount,
          receiptBody.inventoryRootSha256,
          receiptBody.objectAckCount,
          receiptBody.objectAckRootSha256,
          receiptBody.sourceCleanupAckCount,
          null,
          receiptBody.targetCleanupAckCount,
          null,
          receiptBody.fleetDrainedEvidenceSha256,
          receiptBody.blobControlEvidenceSha256,
          receiptBody.occurredAtDbMs,
          receiptSha256,
        ],
      );
      const committedBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...control,
        phase: "committed",
        sourceCleanupNotBeforeDbMs,
        completedAtDbMs: nowMs,
        terminalReceiptSha256: receiptSha256,
      };
      delete (committedBody as { evidenceSha256?: string }).evidenceSha256;
      const committedEvidence = blobStorageMigrationControlEvidenceSha256(committedBody);
      const [committed] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='committed',
            source_cleanup_not_before_db_ms=?,completed_at_db_ms=?,
            terminal_receipt_sha256=?,evidence_sha256=?
          WHERE singleton_id=1 AND phase='cutting_over' AND migration_id=?`,
        [
          sourceCleanupNotBeforeDbMs,
          nowMs,
          receiptSha256,
          committedEvidence,
          control.migrationId,
        ],
      );
      if (committed.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: control.migrationId,
        controlGeneration: control.controlGeneration,
        eventType: "committed",
        fromPhase: "verified",
        toPhase: "committed",
        inventoryEntryCount: control.inventoryEntryCount,
        inventoryRootSha256: control.inventoryRootSha256,
        objectAckCount: control.objectAckCount,
        objectAckRootSha256: control.objectAckRootSha256,
        occurredAtDbMs: nowMs,
        evidenceSha256: committedEvidence,
      });
      const result = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      conn.release();
      released = true;
      const reconciled = await this.getControl().catch(() => undefined);
      if (reconciled && reconciled.migrationId === before.migrationId
        && (reconciled.phase === "committed" || reconciled.phase === "source_cleaned")) {
        return reconciled;
      }
      throw error;
    } finally {
      if (!released) conn.release();
    }
  }

  private async beginAbort(): Promise<BlobStorageMigrationControlRecord> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const control = await this.readControl(conn, "FOR UPDATE");
      if (control.phase === "aborted" || control.phase === "abort_cleaning") {
        await conn.commit();
        return control;
      }
      if (!["frozen", "inventory_sealed", "copying", "verified"].includes(control.phase)
        || !control.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration can no longer be aborted");
      }
      await this.assertExclusiveOperator();
      const [inventoryRows] = await conn.query<Row[]>(
        `SELECT entry_ordinal,entry_sha256 FROM blob_storage_migration_inventory
          WHERE migration_id=? ORDER BY entry_ordinal FOR SHARE`,
        [control.migrationId],
      );
      let inventoryRoot = emptyBlobStorageMigrationRoot("inventory");
      inventoryRows.forEach((row) => {
        inventoryRoot = appendBlobStorageMigrationRoot(
          "inventory",
          inventoryRoot,
          safeInteger(row.entry_ordinal, "abort inventory ordinal"),
          String(row.entry_sha256),
        );
      });
      const [ackRows] = await conn.query<Row[]>(
        `SELECT ack_sha256 FROM blob_storage_migration_object_acks
          WHERE migration_id=? ORDER BY storage_key FOR SHARE`,
        [control.migrationId],
      );
      let objectAckRoot = emptyBlobStorageMigrationRoot("object-acks");
      ackRows.forEach((row, index) => {
        objectAckRoot = appendBlobStorageMigrationRoot(
          "object-acks",
          objectAckRoot,
          index + 1,
          String(row.ack_sha256),
        );
      });
      const nowMs = await databaseNow(conn);
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...control,
        phase: "abort_cleaning",
        inventoryEntryCount: inventoryRows.length,
        inventoryRootSha256: inventoryRoot,
        objectAckCount: ackRows.length,
        objectAckRootSha256: objectAckRoot,
        ...(control.inventorySealedAtDbMs === undefined
          ? { inventorySealedAtDbMs: nowMs }
          : {}),
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='abort_cleaning',
            inventory_entry_count=?,inventory_root_sha256=?,object_ack_count=?,
            object_ack_root_sha256=?,inventory_sealed_at_db_ms=COALESCE(inventory_sealed_at_db_ms,?),
            evidence_sha256=?
          WHERE singleton_id=1 AND migration_id=? AND phase=?`,
        [
          inventoryRows.length,
          inventoryRoot,
          ackRows.length,
          objectAckRoot,
          nowMs,
          evidenceSha256,
          control.migrationId,
          control.phase,
        ],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: control.migrationId,
        controlGeneration: control.controlGeneration,
        eventType: "abort_cleaning",
        fromPhase: control.phase,
        toPhase: "abort_cleaning",
        inventoryEntryCount: inventoryRows.length,
        inventoryRootSha256: inventoryRoot,
        objectAckCount: ackRows.length,
        objectAckRootSha256: objectAckRoot,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const result = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async writeTargetCleanupAck(
    control: BlobStorageMigrationControlRecord,
    object: BlobStorageMigrationPhysicalObject,
    cleanupResult: "missing" | "fenced_tombstone" | "preserved_conflict",
    observation: BlobExactInspection,
  ): Promise<string> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR SHARE");
      if (current.phase !== "abort_cleaning" || current.migrationId !== control.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration abort authority was lost");
      }
      await this.assertExclusiveOperator();
      const cleanedAtDbMs = await databaseNow(conn);
      const body = {
        migrationId: control.migrationId!,
        storageKey: object.storageKey,
        objectDisposition: object.objectDisposition,
        targetBackend: control.targetBackend!,
        targetNamespaceSha256: control.targetNamespaceSha256!,
        cleanupResult,
        targetObservedKind: observation.kind,
        ...(observation.kind === "data" ? {
          targetDescriptorSha256: blobStorageMigrationDescriptorSha256(observation.descriptor),
        } : {}),
        ...(observation.kind === "missing" || observation.migrationOwnerSha256 === undefined
          ? {}
          : { targetMigrationOwnerSha256: observation.migrationOwnerSha256 }),
        cleanedAtDbMs,
      };
      const ackSha256 = blobStorageMigrationTargetCleanupAckSha256(body);
      try {
        await conn.query(
          `INSERT INTO blob_storage_migration_target_cleanup_acks
             (migration_id,storage_key,object_disposition,target_backend,
              target_namespace_sha256,cleanup_result,target_observed_kind,
              target_descriptor_sha256,target_migration_owner_sha256,
              cleaned_at_db_ms,ack_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            body.migrationId,
            body.storageKey,
            body.objectDisposition,
            body.targetBackend,
            body.targetNamespaceSha256,
            body.cleanupResult,
            body.targetObservedKind,
            body.targetDescriptorSha256 ?? null,
            body.targetMigrationOwnerSha256 ?? null,
            body.cleanedAtDbMs,
            ackSha256,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        const [rows] = await conn.query<Row[]>(
          `SELECT object_disposition,target_backend,target_namespace_sha256,cleanup_result,
                  target_observed_kind,target_descriptor_sha256,target_migration_owner_sha256,
                  cleaned_at_db_ms,ack_sha256
             FROM blob_storage_migration_target_cleanup_acks
            WHERE migration_id=? AND storage_key=? FOR SHARE`,
          [body.migrationId, body.storageKey],
        );
        const row = rows[0];
        if (!row || String(row.object_disposition) !== body.objectDisposition
          || String(row.target_backend) !== body.targetBackend
          || String(row.target_namespace_sha256) !== body.targetNamespaceSha256
          || String(row.cleanup_result) !== body.cleanupResult
          || String(row.target_observed_kind) !== body.targetObservedKind
          || nullableString(row.target_descriptor_sha256) !== body.targetDescriptorSha256
          || nullableString(row.target_migration_owner_sha256)
            !== body.targetMigrationOwnerSha256) {
          throw new BlobStorageMigrationConflictError("target cleanup ACK replay conflicts");
        }
        const replayBody = {
          migrationId: body.migrationId,
          storageKey: body.storageKey,
          objectDisposition: body.objectDisposition,
          targetBackend: body.targetBackend,
          targetNamespaceSha256: body.targetNamespaceSha256,
          cleanupResult: body.cleanupResult,
          targetObservedKind: body.targetObservedKind,
          ...(body.targetDescriptorSha256 === undefined
            ? {} : { targetDescriptorSha256: body.targetDescriptorSha256 }),
          ...(body.targetMigrationOwnerSha256 === undefined
            ? {} : { targetMigrationOwnerSha256: body.targetMigrationOwnerSha256 }),
          cleanedAtDbMs: safeInteger(row.cleaned_at_db_ms, "target cleanup ACK time"),
        };
        if (blobStorageMigrationTargetCleanupAckSha256(replayBody) !== String(row.ack_sha256)) {
          throw new BlobStorageMigrationIntegrityError("target cleanup ACK evidence changed");
        }
        await this.assertExclusiveOperator();
        await conn.commit();
        return String(row.ack_sha256);
      }
      await this.assertExclusiveOperator();
      await conn.commit();
      return ackSha256;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  async abort(
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const before = await this.getControl();
    if (!before.migrationId || !before.targetBackend || !before.targetNamespaceSha256
      || target.backend !== before.targetBackend
      || target.namespaceSha256 !== before.targetNamespaceSha256
      || target.shared !== true) {
      throw new BlobStorageMigrationConflictError("abort target identity changed");
    }
    const control = await this.beginAbort();
    if (!control.migrationId || !control.targetBackend || !control.targetNamespaceSha256
      || target.backend !== control.targetBackend
      || target.namespaceSha256 !== control.targetNamespaceSha256
      || target.shared !== true) {
      throw new BlobStorageMigrationConflictError("abort target identity changed");
    }
    if (control.phase === "aborted") return control;
    const objects = await this.loadPhysicalObjects(control);
    for (const object of objects) {
      const limit = maxReadBytes(object.expectedDescriptor, maxBytes);
      const migrationOwnerSha256 = blobStorageMigrationTargetOwnerSha256(
        object.migrationId,
        control.targetNamespaceSha256,
        object.storageKey,
      );
      let state = await target.inspectExact(object.storageKey, { maxBytes: limit });
      let cleanupResult: "missing" | "fenced_tombstone" | "preserved_conflict";
      if (object.objectDisposition === "absent") {
        cleanupResult = state.kind === "missing" ? "missing" : "preserved_conflict";
      } else {
        cleanupResult = "preserved_conflict";
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if (state.kind === "tombstone"
            && state.migrationOwnerSha256 === migrationOwnerSha256) {
            cleanupResult = "fenced_tombstone";
            break;
          }
          if (state.kind === "missing") {
            try {
              await this.withExternalMutationAuthority(
                control,
                "abort_cleaning",
                () => target.delete(object.storageKey, {
                  uploadToken: object.sourceUploadToken,
                  migrationOwnerSha256,
                }),
              );
            } catch (error) {
              if (!(error instanceof BlobConflictError)) throw error;
            }
            state = await target.inspectExact(object.storageKey, { maxBytes: limit });
            continue;
          }
          const exactOwnedData = object.objectDisposition === "data"
            && state.kind === "data"
            && state.migrationOwnerSha256 === migrationOwnerSha256
            && object.expectedDescriptor !== undefined
            && descriptorEqual(state.descriptor, object.expectedDescriptor);
          if (!exactOwnedData) break;
          try {
            await this.withExternalMutationAuthority(
              control,
              "abort_cleaning",
              () => target.discardUncommittedTarget(object.storageKey, {
                expectedState: { kind: "data", descriptor: object.expectedDescriptor! },
                uploadToken: object.sourceUploadToken,
                migrationOwnerSha256,
              }),
            );
          } catch (error) {
            if (!(error instanceof BlobConflictError)) throw error;
          }
          state = await target.inspectExact(object.storageKey, { maxBytes: limit });
        }
        if (state.kind === "tombstone"
          && state.migrationOwnerSha256 === migrationOwnerSha256) {
          cleanupResult = "fenced_tombstone";
        }
        if (cleanupResult !== "fenced_tombstone"
          && (state.kind === "missing"
            || (state.kind === "data"
              && state.migrationOwnerSha256 === migrationOwnerSha256
              && object.objectDisposition === "data"
              && object.expectedDescriptor !== undefined
              && descriptorEqual(state.descriptor, object.expectedDescriptor)))) {
          throw new BlobStorageMigrationConflictError("target cleanup did not establish its fence");
        }
      }
      await this.writeTargetCleanupAck(control, object, cleanupResult, state);
    }
    const [cleanupRows] = await this.pool.query<Row[]>(
      `SELECT storage_key,cleanup_result,target_observed_kind,target_descriptor_sha256,
              target_migration_owner_sha256,ack_sha256
         FROM blob_storage_migration_target_cleanup_acks
        WHERE migration_id=? ORDER BY storage_key`,
      [control.migrationId],
    );
    if (cleanupRows.length !== objects.length) {
      throw new BlobStorageMigrationIntegrityError("target cleanup ACK coverage is incomplete");
    }
    const objectsByKey = new Map(objects.map((object) => [object.storageKey, object]));
    for (const row of cleanupRows) {
      const object = objectsByKey.get(String(row.storage_key));
      if (!object) throw new BlobStorageMigrationIntegrityError("target cleanup ACK has no inventory");
      const state = await target.inspectExact(object.storageKey, {
        maxBytes: maxReadBytes(object.expectedDescriptor, maxBytes),
      });
      const result = String(row.cleanup_result);
      const observedKind = String(row.target_observed_kind);
      const descriptorSha256 = nullableString(row.target_descriptor_sha256);
      const observedMigrationOwnerSha256 = nullableString(row.target_migration_owner_sha256);
      if ((result === "missing" && state.kind !== "missing")
        || (result === "fenced_tombstone"
          && (state.kind !== "tombstone"
            || state.migrationOwnerSha256 !== blobStorageMigrationTargetOwnerSha256(
              object.migrationId,
              control.targetNamespaceSha256,
              object.storageKey,
            )))
        || (result === "preserved_conflict" && state.kind !== observedKind)
        || (result === "preserved_conflict" && state.kind === "data"
          && descriptorSha256 !== blobStorageMigrationDescriptorSha256(state.descriptor))
        || observedMigrationOwnerSha256 !== (state.kind === "missing"
          ? undefined
          : state.migrationOwnerSha256)) {
        throw new BlobStorageMigrationConflictError("target changed after cleanup ACK");
      }
    }
    let cleanupRoot = emptyBlobStorageMigrationRoot("target-cleanup");
    cleanupRows.forEach((row, index) => {
      cleanupRoot = appendBlobStorageMigrationRoot(
        "target-cleanup",
        cleanupRoot,
        index + 1,
        String(row.ack_sha256),
      );
    });

    const conn = await this.pool.getConnection();
    let released = false;
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR UPDATE");
      if (current.phase !== "abort_cleaning" || current.migrationId !== control.migrationId
        || !current.migrationId || !current.sourceNamespaceSha256
        || !current.targetBackend || !current.targetNamespaceSha256
        || current.rollbackWindowMs === undefined || current.sourceCleanupDelayMs === undefined
        || current.cutoverNotBeforeDbMs === undefined || !current.fleetDrainedEvidenceSha256
        || !current.inventoryRootSha256 || !current.objectAckRootSha256) {
        throw new BlobStorageMigrationConflictError("blob migration abort phase changed");
      }
      await this.assertExclusiveOperator();
      const nowMs = await databaseNow(conn);
      const receiptBody: Omit<BlobStorageMigrationReceipt, "receiptSha256"> = {
        migrationId: current.migrationId,
        receiptKind: "aborted",
        controlGeneration: current.controlGeneration,
        sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
        sourceNamespaceSha256: current.sourceNamespaceSha256,
        targetBackend: current.targetBackend,
        targetNamespaceSha256: current.targetNamespaceSha256,
        rollbackWindowMs: current.rollbackWindowMs,
        sourceCleanupDelayMs: current.sourceCleanupDelayMs,
        cutoverNotBeforeDbMs: current.cutoverNotBeforeDbMs,
        inventoryEntryCount: current.inventoryEntryCount,
        inventoryRootSha256: current.inventoryRootSha256,
        objectAckCount: current.objectAckCount,
        objectAckRootSha256: current.objectAckRootSha256,
        sourceCleanupAckCount: 0,
        targetCleanupAckCount: cleanupRows.length,
        targetCleanupAckRootSha256: cleanupRoot,
        fleetDrainedEvidenceSha256: current.fleetDrainedEvidenceSha256,
        occurredAtDbMs: nowMs,
      };
      const receiptSha256 = blobStorageMigrationReceiptSha256(receiptBody);
      await conn.query(
        `INSERT INTO blob_storage_migration_receipts
           (migration_id,receipt_kind,control_generation,source_backend,
            source_namespace_sha256,target_backend,target_namespace_sha256,
            rollback_window_ms,source_cleanup_delay_ms,cutover_not_before_db_ms,
            source_cleanup_not_before_db_ms,
            inventory_entry_count,inventory_root_sha256,object_ack_count,
            object_ack_root_sha256,
            source_cleanup_ack_count,source_cleanup_ack_root_sha256,
            target_cleanup_ack_count,target_cleanup_ack_root_sha256,
            fleet_drained_evidence_sha256,blob_control_evidence_sha256,
            occurred_at_db_ms,receipt_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          receiptBody.migrationId,
          receiptBody.receiptKind,
          receiptBody.controlGeneration,
          receiptBody.sourceBackend,
          receiptBody.sourceNamespaceSha256,
          receiptBody.targetBackend,
          receiptBody.targetNamespaceSha256,
          receiptBody.rollbackWindowMs,
          receiptBody.sourceCleanupDelayMs,
          receiptBody.cutoverNotBeforeDbMs,
          null,
          receiptBody.inventoryEntryCount,
          receiptBody.inventoryRootSha256,
          receiptBody.objectAckCount,
          receiptBody.objectAckRootSha256,
          receiptBody.sourceCleanupAckCount,
          null,
          receiptBody.targetCleanupAckCount,
          receiptBody.targetCleanupAckRootSha256,
          receiptBody.fleetDrainedEvidenceSha256,
          null,
          receiptBody.occurredAtDbMs,
          receiptSha256,
        ],
      );
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...current,
        phase: "aborted",
        targetCleanupAckCount: cleanupRows.length,
        targetCleanupAckRootSha256: cleanupRoot,
        completedAtDbMs: nowMs,
        terminalReceiptSha256: receiptSha256,
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='aborted',
            target_cleanup_ack_count=?,target_cleanup_ack_root_sha256=?,completed_at_db_ms=?,
            terminal_receipt_sha256=?,evidence_sha256=?
          WHERE singleton_id=1 AND phase='abort_cleaning' AND migration_id=?`,
        [cleanupRows.length, cleanupRoot, nowMs, receiptSha256, evidenceSha256, current.migrationId],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: current.migrationId!,
        controlGeneration: current.controlGeneration,
        eventType: "aborted",
        fromPhase: "abort_cleaning",
        toPhase: "aborted",
        inventoryEntryCount: current.inventoryEntryCount,
        inventoryRootSha256: current.inventoryRootSha256,
        objectAckCount: current.objectAckCount,
        objectAckRootSha256: current.objectAckRootSha256,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const result = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      conn.release();
      released = true;
      const reconciled = await this.getControl().catch(() => undefined);
      if (reconciled?.migrationId === control.migrationId && reconciled.phase === "aborted") {
        return reconciled;
      }
      throw error;
    } finally {
      if (!released) conn.release();
    }
  }

  private async assertSourceCleanupReady(
    control: BlobStorageMigrationControlRecord,
  ): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR SHARE");
      if (current.phase === "source_cleaned") {
        await conn.commit();
        return;
      }
      if (current.phase !== "committed" || current.migrationId !== control.migrationId
        || current.sourceCleanupNotBeforeDbMs === undefined) {
        throw new BlobStorageMigrationConflictError("blob migration is not awaiting source cleanup");
      }
      if (await databaseNow(conn) < current.sourceCleanupNotBeforeDbMs) {
        throw new BlobStorageMigrationNotReadyError("source_retention_window_open");
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async writeSourceCleanupAck(
    control: BlobStorageMigrationControlRecord,
    object: BlobStorageMigrationPhysicalObject,
    sourceDescriptorSha256?: string,
  ): Promise<string> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR SHARE");
      if (current.phase !== "committed" || current.migrationId !== control.migrationId) {
        throw new BlobStorageMigrationConflictError("blob migration source cleanup authority was lost");
      }
      await this.assertExclusiveOperator();
      const cleanedAtDbMs = await databaseNow(conn);
      if (current.sourceCleanupNotBeforeDbMs === undefined
        || cleanedAtDbMs < current.sourceCleanupNotBeforeDbMs) {
        throw new BlobStorageMigrationNotReadyError("source_retention_window_open");
      }
      const body = {
        migrationId: control.migrationId!,
        storageKey: object.storageKey,
        objectDisposition: object.objectDisposition,
        sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
        sourceNamespaceSha256: control.sourceNamespaceSha256!,
        sourceObservedKind: "tombstone" as const,
        ...(sourceDescriptorSha256 === undefined ? {} : { sourceDescriptorSha256 }),
        cleanedAtDbMs,
      };
      const ackSha256 = blobStorageMigrationSourceCleanupAckSha256(body);
      try {
        await conn.query(
          `INSERT INTO blob_storage_migration_source_cleanup_acks
             (migration_id,storage_key,object_disposition,source_backend,
              source_namespace_sha256,source_observed_kind,source_descriptor_sha256,
              cleaned_at_db_ms,ack_sha256)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            body.migrationId,
            body.storageKey,
            body.objectDisposition,
            body.sourceBackend,
            body.sourceNamespaceSha256,
            body.sourceObservedKind,
            body.sourceDescriptorSha256 ?? null,
            body.cleanedAtDbMs,
            ackSha256,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        const [rows] = await conn.query<Row[]>(
          `SELECT object_disposition,source_backend,source_namespace_sha256,
                  source_observed_kind,source_descriptor_sha256,cleaned_at_db_ms,ack_sha256
             FROM blob_storage_migration_source_cleanup_acks
            WHERE migration_id=? AND storage_key=? FOR SHARE`,
          [body.migrationId, body.storageKey],
        );
        const row = rows[0];
        if (!row || String(row.object_disposition) !== body.objectDisposition
          || String(row.source_backend) !== body.sourceBackend
          || String(row.source_namespace_sha256) !== body.sourceNamespaceSha256
          || String(row.source_observed_kind) !== body.sourceObservedKind
          || nullableString(row.source_descriptor_sha256) !== body.sourceDescriptorSha256) {
          throw new BlobStorageMigrationConflictError("source cleanup ACK replay conflicts");
        }
        const replayBody = {
          migrationId: body.migrationId,
          storageKey: body.storageKey,
          objectDisposition: body.objectDisposition,
          sourceBackend: body.sourceBackend,
          sourceNamespaceSha256: body.sourceNamespaceSha256,
          sourceObservedKind: body.sourceObservedKind,
          ...(body.sourceDescriptorSha256 === undefined
            ? {} : { sourceDescriptorSha256: body.sourceDescriptorSha256 }),
          cleanedAtDbMs: safeInteger(row.cleaned_at_db_ms, "source cleanup ACK time"),
        };
        if (blobStorageMigrationSourceCleanupAckSha256(replayBody) !== String(row.ack_sha256)) {
          throw new BlobStorageMigrationIntegrityError("source cleanup ACK evidence changed");
        }
        await this.assertExclusiveOperator();
        await conn.commit();
        return String(row.ack_sha256);
      }
      await this.assertExclusiveOperator();
      await conn.commit();
      return ackSha256;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }

  private async assertTargetCleanupEvidence(
    control: BlobStorageMigrationControlRecord,
    object: BlobStorageMigrationPhysicalObject,
    ack: BlobStorageMigrationObjectAck,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<void> {
    const expected = object.expectedDescriptor;
    if (ack.migrationId !== object.migrationId
      || ack.storageKey !== object.storageKey
      || ack.objectDisposition !== object.objectDisposition
      || ack.targetBackend !== control.targetBackend
      || ack.targetNamespaceSha256 !== control.targetNamespaceSha256
      || ack.expectedSha256 !== expected?.sha256
      || ack.expectedSizeBytes !== expected?.sizeBytes
      || ack.expectedContentType !== expected?.contentType) {
      throw new BlobStorageMigrationIntegrityError("source cleanup object ACK does not match inventory");
    }
    const state = await target.inspectExact(object.storageKey, {
      maxBytes: maxReadBytes(expected, maxBytes),
    });
    const migrationOwnerSha256 = blobStorageMigrationTargetOwnerSha256(
      object.migrationId,
      control.targetNamespaceSha256!,
      object.storageKey,
    );
    if (object.objectDisposition === "data") {
      if (!expected || state.kind !== "data"
        || !descriptorEqual(state.descriptor, expected)
        || state.migrationOwnerSha256 !== migrationOwnerSha256
        || ack.targetObservedKind !== "data"
        || ack.targetDescriptorSha256 !== blobStorageMigrationDescriptorSha256(expected)) {
        throw new BlobStorageMigrationConflictError("target data changed before source cleanup");
      }
      return;
    }
    if (object.objectDisposition === "tombstone") {
      if (state.kind !== "tombstone"
        || state.migrationOwnerSha256 !== migrationOwnerSha256
        || ack.targetObservedKind !== "tombstone"
        || ack.targetDescriptorSha256 !== undefined) {
        throw new BlobStorageMigrationConflictError("target tombstone changed before source cleanup");
      }
      return;
    }
    if (state.kind !== "missing"
      || ack.targetObservedKind !== "missing"
      || ack.targetDescriptorSha256 !== undefined) {
      throw new BlobStorageMigrationConflictError("absent target changed before source cleanup");
    }
  }

  async cleanupSource(
    source: BlobMigrationStore,
    target: BlobMigrationStore,
    maxBytes: number,
  ): Promise<BlobStorageMigrationControlRecord> {
    await this.assertExclusiveOperator();
    const control = await this.getControl();
    if (control.phase === "source_cleaned") {
      this.assertStoreIdentities(control, source, target);
      return control;
    }
    if (control.phase !== "committed" || !control.migrationId) {
      throw new BlobStorageMigrationConflictError("source cleanup identity or phase changed");
    }
    this.assertStoreIdentities(control, source, target);
    await this.assertSourceCleanupReady(control);
    const objects = await this.loadPhysicalObjects(control);
    const objectAcks = await this.readObjectAcks(control);
    if (objectAcks.length !== objects.length) {
      throw new BlobStorageMigrationIntegrityError("source cleanup object ACK coverage changed");
    }
    let objectAckRoot = emptyBlobStorageMigrationRoot("object-acks");
    objectAcks.forEach((ack, index) => {
      objectAckRoot = appendBlobStorageMigrationRoot(
        "object-acks",
        objectAckRoot,
        index + 1,
        ack.ackSha256,
      );
    });
    if (objectAcks.length !== control.objectAckCount
      || objectAckRoot !== control.objectAckRootSha256) {
      throw new BlobStorageMigrationIntegrityError("source cleanup object ACK root changed");
    }
    const objectAckByKey = new Map(objectAcks.map((ack) => [ack.storageKey, ack]));
    for (const object of objects) {
      const limit = maxReadBytes(object.expectedDescriptor, maxBytes);
      const objectAck = objectAckByKey.get(object.storageKey);
      if (!objectAck) {
        throw new BlobStorageMigrationIntegrityError("source cleanup object ACK does not match inventory");
      }
      await this.assertTargetCleanupEvidence(control, object, objectAck, target, maxBytes);
      let state = await source.inspectExact(object.storageKey, { maxBytes: limit });
      const descriptorSha256 = objectAck.sourceDescriptorSha256;
      if (state.kind === "data") {
        const observedDescriptorSha256 = blobStorageMigrationDescriptorSha256(state.descriptor);
        if (objectAck.sourceObservedKind !== "data"
          || descriptorSha256 !== observedDescriptorSha256) {
          throw new BlobStorageMigrationConflictError("source data changed after copy verification");
        }
      }
      if (object.objectDisposition === "data") {
        const expected = object.expectedDescriptor;
        if (!expected) throw new BlobStorageMigrationIntegrityError("data cleanup has no descriptor");
        if (state.kind === "data" && !descriptorEqual(state.descriptor, expected)) {
          throw new BlobStorageMigrationConflictError("source data changed before cleanup");
        }
        if (state.kind === "missing") {
          throw new BlobStorageMigrationConflictError("source data disappeared without its fence");
        }
      } else if (object.objectDisposition === "tombstone" && state.kind === "data") {
        if (object.expectedDescriptor
          && !descriptorEqual(state.descriptor, object.expectedDescriptor)) {
          throw new BlobStorageMigrationConflictError("delete source changed before cleanup");
        }
      } else if (object.objectDisposition === "absent" && state.kind === "data") {
        throw new BlobStorageMigrationConflictError("absent source appeared before cleanup");
      }
      // Replay the token-bound delete even when inspection already reports its cancellation fence.
      // Filesystem inspection deliberately lets that fence mask a residual final file; only a
      // successful delete call proves temporary and final paths were unlinked after the fence.
      await this.withExternalMutationAuthority(
        control,
        "committed",
        () => source.delete(object.storageKey, { uploadToken: object.sourceUploadToken }),
      );
      state = await source.inspectExact(object.storageKey, { maxBytes: limit });
      if (state.kind !== "tombstone") {
        throw new BlobStorageMigrationConflictError("filesystem source cleanup did not establish a fence");
      }
      await this.writeSourceCleanupAck(control, object, descriptorSha256);
    }

    const [cleanupRows] = await this.pool.query<Row[]>(
      `SELECT ack_sha256 FROM blob_storage_migration_source_cleanup_acks
        WHERE migration_id=? ORDER BY storage_key`,
      [control.migrationId],
    );
    if (cleanupRows.length !== objects.length) {
      throw new BlobStorageMigrationIntegrityError("source cleanup ACK coverage is incomplete");
    }
    let cleanupRoot = emptyBlobStorageMigrationRoot("source-cleanup");
    cleanupRows.forEach((row, index) => {
      cleanupRoot = appendBlobStorageMigrationRoot(
        "source-cleanup",
        cleanupRoot,
        index + 1,
        String(row.ack_sha256),
      );
    });

    const conn = await this.pool.getConnection();
    let released = false;
    try {
      await conn.beginTransaction();
      const current = await this.readControl(conn, "FOR UPDATE");
      if (current.phase !== "committed" || current.migrationId !== control.migrationId
        || !current.migrationId || !current.sourceNamespaceSha256
        || !current.targetBackend || !current.targetNamespaceSha256
        || current.rollbackWindowMs === undefined || current.sourceCleanupDelayMs === undefined
        || current.cutoverNotBeforeDbMs === undefined
        || current.sourceCleanupNotBeforeDbMs === undefined
        || !current.fleetDrainedEvidenceSha256 || !current.inventoryRootSha256
        || !current.objectAckRootSha256) {
        throw new BlobStorageMigrationConflictError("blob migration phase changed during source cleanup");
      }
      await this.assertExclusiveOperator();
      const nowMs = await databaseNow(conn);
      if (nowMs < current.sourceCleanupNotBeforeDbMs) {
        throw new BlobStorageMigrationNotReadyError("source_retention_window_open");
      }
      const [blobControlRows] = await conn.query<Row[]>(
        `SELECT evidence_sha256 FROM blob_storage_control
          WHERE singleton_id=1 AND control_generation=1
            AND BINARY storage_backend=BINARY ? AND BINARY namespace_sha256=BINARY ? FOR SHARE`,
        [current.targetBackend, current.targetNamespaceSha256],
      );
      const blobControlEvidence = nullableString(blobControlRows[0]?.evidence_sha256);
      if (blobControlRows.length !== 1 || !blobControlEvidence) {
        throw new BlobStorageMigrationIntegrityError("active blob control evidence is missing");
      }
      const receiptBody: Omit<BlobStorageMigrationReceipt, "receiptSha256"> = {
        migrationId: current.migrationId,
        receiptKind: "source_cleaned",
        controlGeneration: current.controlGeneration,
        sourceBackend: BLOB_STORAGE_MIGRATION_SOURCE_BACKEND,
        sourceNamespaceSha256: current.sourceNamespaceSha256,
        targetBackend: current.targetBackend,
        targetNamespaceSha256: current.targetNamespaceSha256,
        rollbackWindowMs: current.rollbackWindowMs,
        sourceCleanupDelayMs: current.sourceCleanupDelayMs,
        cutoverNotBeforeDbMs: current.cutoverNotBeforeDbMs,
        sourceCleanupNotBeforeDbMs: current.sourceCleanupNotBeforeDbMs,
        inventoryEntryCount: current.inventoryEntryCount,
        inventoryRootSha256: current.inventoryRootSha256,
        objectAckCount: current.objectAckCount,
        objectAckRootSha256: current.objectAckRootSha256,
        sourceCleanupAckCount: cleanupRows.length,
        sourceCleanupAckRootSha256: cleanupRoot,
        targetCleanupAckCount: 0,
        fleetDrainedEvidenceSha256: current.fleetDrainedEvidenceSha256,
        blobControlEvidenceSha256: blobControlEvidence,
        occurredAtDbMs: nowMs,
      };
      const receiptSha256 = blobStorageMigrationReceiptSha256(receiptBody);
      await conn.query(
        `INSERT INTO blob_storage_migration_receipts
           (migration_id,receipt_kind,control_generation,source_backend,
            source_namespace_sha256,target_backend,target_namespace_sha256,
            rollback_window_ms,source_cleanup_delay_ms,cutover_not_before_db_ms,
            source_cleanup_not_before_db_ms,
            inventory_entry_count,inventory_root_sha256,object_ack_count,
            object_ack_root_sha256,source_cleanup_ack_count,source_cleanup_ack_root_sha256,
            target_cleanup_ack_count,target_cleanup_ack_root_sha256,
            fleet_drained_evidence_sha256,blob_control_evidence_sha256,
            occurred_at_db_ms,receipt_sha256)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          receiptBody.migrationId,
          receiptBody.receiptKind,
          receiptBody.controlGeneration,
          receiptBody.sourceBackend,
          receiptBody.sourceNamespaceSha256,
          receiptBody.targetBackend,
          receiptBody.targetNamespaceSha256,
          receiptBody.rollbackWindowMs,
          receiptBody.sourceCleanupDelayMs,
          receiptBody.cutoverNotBeforeDbMs,
          receiptBody.sourceCleanupNotBeforeDbMs,
          receiptBody.inventoryEntryCount,
          receiptBody.inventoryRootSha256,
          receiptBody.objectAckCount,
          receiptBody.objectAckRootSha256,
          receiptBody.sourceCleanupAckCount,
          receiptBody.sourceCleanupAckRootSha256,
          receiptBody.targetCleanupAckCount,
          null,
          receiptBody.fleetDrainedEvidenceSha256,
          receiptBody.blobControlEvidenceSha256,
          receiptBody.occurredAtDbMs,
          receiptSha256,
        ],
      );
      // MySQL trigger subqueries can otherwise retain the transaction's earlier read view and
      // miss this just-inserted terminal receipt. A locking current read both proves the exact
      // immutable receipt is present in this transaction and makes it visible to the following
      // control-transition trigger without weakening that trigger's database-side authority.
      const [persistedReceipts] = await conn.query<Row[]>(
        `SELECT receipt_sha256 FROM blob_storage_migration_receipts
          WHERE migration_id=? AND receipt_kind='source_cleaned'
            AND BINARY receipt_sha256=BINARY ? FOR SHARE`,
        [receiptBody.migrationId, receiptSha256],
      );
      if (persistedReceipts.length !== 1
        || String(persistedReceipts[0]?.receipt_sha256) !== receiptSha256) {
        throw new BlobStorageMigrationIntegrityError(
          "source cleanup terminal receipt was not persisted",
        );
      }
      const nextBody: Omit<BlobStorageMigrationControlRecord, "evidenceSha256"> = {
        ...current,
        phase: "source_cleaned",
        sourceCleanupAckCount: cleanupRows.length,
        sourceCleanupAckRootSha256: cleanupRoot,
        terminalReceiptSha256: receiptSha256,
      };
      delete (nextBody as { evidenceSha256?: string }).evidenceSha256;
      const evidenceSha256 = blobStorageMigrationControlEvidenceSha256(nextBody);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE blob_storage_migration_control SET phase='source_cleaned',
            source_cleanup_ack_count=?,source_cleanup_ack_root_sha256=?,
            terminal_receipt_sha256=?,evidence_sha256=?
          WHERE singleton_id=1 AND phase='committed' AND migration_id=?`,
        [cleanupRows.length, cleanupRoot, receiptSha256, evidenceSha256, current.migrationId],
      );
      if (updated.affectedRows !== 1) throw new BlobStorageMigrationConflictError();
      await this.appendEvent(conn, {
        migrationId: current.migrationId!,
        controlGeneration: current.controlGeneration,
        eventType: "source_cleaned",
        fromPhase: "committed",
        toPhase: "source_cleaned",
        inventoryEntryCount: current.inventoryEntryCount,
        inventoryRootSha256: current.inventoryRootSha256,
        objectAckCount: current.objectAckCount,
        objectAckRootSha256: current.objectAckRootSha256,
        occurredAtDbMs: nowMs,
        evidenceSha256,
      });
      const result = await this.readControl(conn);
      await this.assertExclusiveOperator();
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      conn.release();
      released = true;
      const reconciled = await this.getControl().catch(() => undefined);
      if (reconciled?.migrationId === control.migrationId
        && reconciled.phase === "source_cleaned") return reconciled;
      throw error;
    } finally {
      if (!released) conn.release();
    }
  }
}
