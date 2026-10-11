import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0031_authoritative_backup_catalog.sql";
const EMPTY_REMOTE_HEAD_ROOT_SHA256 =
  "43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056";
const EMPTY_RUNTIME_CONTROL_EVIDENCE_SHA256 =
  "44bf64ec269083713f602ff9de0c936f48e8515f97335290eefd9dd2c61c9590";
const EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256 =
  "bab7b17930d82572302c510c686e061ae9bd0de44ff19c83c483f45524b24e81";
const BACKUP_ID = "backup_00000000-0000-4000-8000-000000000031";

const FROZEN_0030_MIGRATIONS = [
  ["0001_init.sql", "4ddae03c6822ae65b8defc65d7c1a96f053f2b56e5442ac7ca9aacb2331d5026"],
  ["0002_auto_approved.sql", "d71b98781d5637762f840e33baeb2f423d7b2275fa309c9a433ec7c75b83b3a9"],
  ["0003_tenant_auth.sql", "7e394446ba094dce0bec563d9e1301f32590ace5080296668fa867e5f9b16d6e"],
  ["0004_compaction.sql", "7dff8f813a82107f76047f8e1d5e00a33784e2225d2ea6ac882ee9cc8bc20db5"],
  ["0005_api_key_scopes.sql", "9e6c3006906c035d13761bb861423a1af6cb91dc2c8eb38471bc8556a16bf68b"],
  ["0006_id_collation.sql", "87b4e8e20b9950ade9a63da4889027abd6ed0763e34efce5c7693a2be777169f"],
  ["0007_strict_ids_and_idempotency_scope.sql", "98a26299739412a3be9ab0c58a09a08819517c32dfd5c1f225dfb3aa11c6f705"],
  ["0008_atomic_turn_writes.sql", "9070634545ab705897ce7cf56a9d794d39b5f3974fcf46dcac7b8c163cecfcb1"],
  ["0009_session_tombstone_outbox.sql", "97e97d2a6c3c3fec75ac28baf8c72ce459df708373b161f9fe4b270a5b2f0d63"],
  ["0010_blob_ownership.sql", "df248cebda2344953e742af74ef87e40fedcae33bf80813c3a44b81b75054129"],
  ["0011_erasure_and_usage_separation.sql", "ef3d5a6931020360f83358159684256ca55bc5346f59c203f049ebcf4469b53e"],
  ["0012_erasure_job_queue.sql", "80de4af2338e18a9cbca69bae21e7414ecef57daeb39c962d61e5a2a520249fb"],
  ["0013_erasure_job_control.sql", "16b99546bec9d3e8b169dd104a5f3c7633db526f438e11043af42ff1ea050334"],
  ["0014_legacy_tombstone_compensation.sql", "609832231836e1ed332b88c77bd95ef86ca8eb7eff7345157ab2541a1289954c"],
  ["0015_retention_policy_and_legal_holds.sql", "5a0eddbaaed07e318d18ea2b6de777d5c0a6e3975168e100a9087d2be8d6eadb"],
  ["0016_erasure_purge_policy_authority.sql", "b7adefcf769adc884dd2efd901fea4767afacf3426dee97771f826cf80d1d3e3"],
  ["0017_user_export_jobs_and_artifacts.sql", "82ad26228fe29051c8d72e1339934420f12d5ee1d7506fea6419b46845a5a189"],
  ["0018_tenant_credential_revocation_fence.sql", "225b1571a990f534211f6c9ae8cc39816a449c13b87e28a67f306e7e7488d4dd"],
  ["0019_tenant_credential_physical_revocation.sql", "0a116472878dbbefeccff6830f836f786adced7384513979e0c600fef5886dfa"],
  ["0020_tenant_runtime_revocation.sql", "f09170eeed0616e5db1283e2761e3a3140c1960bdcf866e133fa9ef03bd3837b"],
  ["0021_tenant_content_inventory.sql", "fe2934d216dfde16f5912af551d387193bbabba4c8903e8484dbc248bfa365c8"],
  ["0022_tenant_purge_plan.sql", "9dcbcfb27a2a307552943da2c8b15df50f64730f9b15eeb4fe1ce055c60ca5f1"],
  ["0023_tenant_purge_execution_ack.sql", "b0535b89012703b89bbfc7cb9cf8dd949a6e750f11421905467f29e4f87295d9"],
  ["0024_tenant_database_purge.sql", "8260d0331d737923fc803cec506de0261d9962d8fce742d21e07bf07f4040e0e"],
  ["0025_tenant_redis_purge.sql", "c93ca46a13965bfbdd79e1d8dab5d4b75cd515d3c66a29cea6c27f1cef643c28"],
  ["0026_credential_lifecycle_inventory.sql", "75c67a6c430189674653d486a3d747c4ba99811c2ec967fc6990e2e40780895e"],
  ["0027_blob_storage_control.sql", "bacd1cddcaac9bb1d8a56b22ade18e7d0c3abb26ec5d41e7769505dd89b51636"],
  ["0028_blob_storage_migration.sql", "f413708b4c3c6e0ded21ccb5e214087bb49fd908a2fa1a3addaa2eb49ddf0057"],
  ["0029_tenant_credential_target_execution.sql", "bc6604cad0a552ddef9c3cd63525e564925f8b4b49d3a808519a58aaf3a29d46"],
  ["0030_tenant_restore_journal.sql", "d4f2b90c0afc3b02314078f8576bf0e3be1771df0a97e10891a434c27b0d361b"],
] as const;

const NEW_TABLES = [
  "backup_catalog_control",
  "backup_catalog_external_events",
  "backup_snapshot_anchors",
  "backup_catalog_entries",
  "backup_restore_source_bindings",
  "backup_runtime_reservations",
  "backup_catalog_evictions",
] as const;

type Row = RowDataPacket;
type LegacyRunPhase = "prepared" | "replay_sealed" | "aborted";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_MIGRATION_TEST_URL must name a test/migration database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseName(): string {
  return `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function statements(sql: string): string[] {
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map((value) => value.trim()).filter(Boolean);
}

describe("0030 -> 0031 authoritative backup catalog migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0031Dir: string;
  let migrationSql: string;

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0031Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0031-"));
    for (const [file, expectedSha256] of FROZEN_0030_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0031Dir, file));
    }
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0031Dir) await rm(pre0031Dir, { recursive: true, force: true });
  });

  async function create0030(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0031Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    await store.close();
  }

  async function stagePrimaryRuntimeActivation(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_restore_runtime_heads
         (singleton_id,target_ordinal,target_sha256,failure_domain_sha256,
          adapter_protocol,journal_namespace_sha256,logical_database_namespace_sha256,
          remote_sequence,head_root_sha256,checkpoint_control_generation,
          runtime_epoch_sha256,updated_at_db_ms)
       VALUES (1,0,REPEAT('7',64),REPEAT('8',64),'memory-journal-v1',REPEAT('4',64),
               REPEAT('5',64),0,?,1,REPEAT('a',64),20)`,
      [EMPTY_REMOTE_HEAD_ROOT_SHA256],
    );
    await conn.query(
      `INSERT INTO tenant_restore_runtime_events
         (singleton_id,control_generation,update_kind,lineage_kind,
          activated_at_db_ms,updated_at_db_ms,restore_run_id,replay_receipt_sha256,
          runtime_epoch_sha256,activation_epoch_sha256,control_evidence_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256)
       VALUES (1,1,'primary_activation','primary',20,20,NULL,NULL,
               REPEAT('a',64),REPEAT('a',64),REPEAT('9',64),REPEAT('5',64),1,
               REPEAT('6',64),REPEAT('b',64),?,REPEAT('c',64))`,
      [EMPTY_RUNTIME_CONTROL_EVIDENCE_SHA256],
    );
    await conn.query(
      `UPDATE tenant_restore_runtime_control
          SET state='active',control_generation=1,update_kind='primary_activation',
              lineage_kind='primary',activated_at_db_ms=20,updated_at_db_ms=20,
              restore_run_id=NULL,replay_receipt_sha256=NULL,
              runtime_epoch_sha256=REPEAT('a',64),control_evidence_sha256=REPEAT('9',64),
              logical_database_namespace_sha256=REPEAT('5',64),target_count=1,
              target_root_sha256=REPEAT('6',64),verified_head_root_sha256=REPEAT('b',64),
              previous_control_evidence_sha256=?,evidence_sha256=REPEAT('c',64)
        WHERE singleton_id=1`,
      [EMPTY_RUNTIME_CONTROL_EVIDENCE_SHA256],
    );
  }

  async function activateJournalControl(conn: Connection): Promise<void> {
    await conn.query(
      `UPDATE tenant_restore_journal_control
          SET control_generation=1,activated_at_db_ms=20,
              protocol='tenant-restore-journal-v1',adapter_protocol='memory-journal-v1',
              journal_namespace_sha256=REPEAT('4',64),
              logical_database_namespace_sha256=REPEAT('5',64),target_count=1,
              target_root_sha256=REPEAT('6',64),
              target_catalog_json=JSON_ARRAY(JSON_OBJECT(
                'targetOrdinal',0,'targetSha256',REPEAT('7',64),
                'failureDomainSha256',REPEAT('8',64),
                'adapterProtocol','memory-journal-v1',
                'journalNamespaceSha256',REPEAT('4',64))),
              evidence_sha256=REPEAT('9',64)
        WHERE singleton_id=1`,
    );
  }

  async function activate0030Controls(conn: Connection): Promise<void> {
    await conn.beginTransaction();
    try {
      await stagePrimaryRuntimeActivation(conn);
      await activateJournalControl(conn);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  }

  async function createLegacyReplayRun(
    conn: Connection,
    input: {
      restoreRunId: string;
      runtimeEpochSha256: string;
      phase?: LegacyRunPhase;
      sourceBackupSha256?: string;
      createdAtDbMs?: number;
    },
  ): Promise<void> {
    const phase = input.phase ?? "prepared";
    const createdAtDbMs = input.createdAtDbMs ?? 30;
    await conn.query(
      `INSERT INTO tenant_restore_replay_runs
         (restore_run_id,source_backup_sha256,runtime_epoch_sha256,protocol,
          control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          sealed_target_catalog_json,sealed_target_root_sha256,expected_entry_count,
          entry_count,entry_root_sha256,fence_count,fence_root_sha256,phase,
          created_at_db_ms,updated_at_db_ms,terminal_receipt_sha256,sealed_at_db_ms,
          activated_at_db_ms,aborted_at_db_ms)
       VALUES (?,?,?,'tenant-restore-journal-v1',REPEAT('9',64),
               'memory-journal-v1',REPEAT('4',64),REPEAT('5',64),1,REPEAT('6',64),
               JSON_ARRAY(JSON_OBJECT(
                 'targetOrdinal',0,'targetSha256',REPEAT('7',64),
                 'failureDomainSha256',REPEAT('8',64),
                 'adapterProtocol','memory-journal-v1',
                 'journalNamespaceSha256',REPEAT('4',64),
                 'logicalDatabaseNamespaceSha256',REPEAT('5',64),
                 'sealedRemoteSequence',0,'sealedHeadRootSha256',?)),
               REPEAT('b',64),0,0,REPEAT('2',64),0,REPEAT('3',64),'prepared',
               ?,?,NULL,NULL,NULL,NULL)`,
      [input.restoreRunId, input.sourceBackupSha256 ?? "1".repeat(64),
        input.runtimeEpochSha256, EMPTY_REMOTE_HEAD_ROOT_SHA256,
        createdAtDbMs, createdAtDbMs],
    );
    if (phase === "replay_sealed") {
      await sealLegacyReplayRun(conn, input.restoreRunId, createdAtDbMs + 1);
    } else if (phase === "aborted") {
      await conn.query(
        `UPDATE tenant_restore_replay_runs
            SET phase='aborted',updated_at_db_ms=?,aborted_at_db_ms=?
          WHERE restore_run_id=?`,
        [createdAtDbMs + 1, createdAtDbMs + 1, input.restoreRunId],
      );
    }
  }

  async function sealLegacyReplayRun(
    conn: Connection,
    restoreRunId: string,
    sealedAtDbMs = 31,
  ): Promise<void> {
    await conn.query(
      `UPDATE tenant_restore_replay_runs
          SET phase='replay_sealed',updated_at_db_ms=?,terminal_receipt_sha256=REPEAT('e',64),
              sealed_at_db_ms=?
        WHERE restore_run_id=?`,
      [sealedAtDbMs, sealedAtDbMs, restoreRunId],
    );
  }

  async function activateCatalogControl(
    conn: Connection,
    protocol: string | null = "tenant-backup-catalog-v1",
  ): Promise<void> {
    await conn.query(
      `UPDATE backup_catalog_control
          SET state='active',control_generation=1,
              protocol=?,adapter_protocol='memory-backup-v1',
              catalog_namespace_sha256=REPEAT('d',64),catalog_target_sha256=REPEAT('e',64),
              failure_domain_sha256=REPEAT('f',64),
              logical_database_namespace_sha256=REPEAT('5',64),
              journal_control_evidence_sha256=REPEAT('9',64),
              retention_policy_sha256=REPEAT('1',64),minimum_retention_ms=10,
              minimum_recoverable_backups=1,
              activated_at_db_ms=40,evidence_sha256=REPEAT('0',64)
        WHERE singleton_id=1`,
      [protocol],
    );
  }

  async function activateBlobStorageControl(conn: Connection): Promise<void> {
    await conn.query(
      `UPDATE blob_storage_control
          SET control_generation=1,storage_backend='filesystem-v1',
              namespace_sha256=REPEAT('6',64),activated_at_db_ms=21,
              evidence_sha256=REPEAT('3',64)
        WHERE singleton_id=1`,
    );
  }

  async function currentSchemaMigrationRoot(conn: Connection): Promise<string> {
    const [rows] = await conn.query<Row[]>(
      "SELECT name FROM schema_migrations ORDER BY BINARY name",
    );
    let root = createHash("sha256").update("agent-service-schema-migrations-v1").digest("hex");
    for (const row of rows) {
      const name = String(row.name);
      const length = Buffer.byteLength(name, "utf8").toString().padStart(10, "0");
      root = createHash("sha256").update(
        `agent-service-schema-migration-v1|${root}|${length}|${name}`,
      ).digest("hex");
    }
    return root;
  }

  async function insertSnapshotAnchor(
    conn: Connection,
    override: {
      schemaMigrationRootSha256?: string;
      blobStorageControlEvidenceSha256?: string;
    } = {},
  ): Promise<void> {
    const schemaMigrationRootSha256 = override.schemaMigrationRootSha256
      ?? await currentSchemaMigrationRoot(conn);
    const blobStorageControlEvidenceSha256 = override.blobStorageControlEvidenceSha256
      ?? "3".repeat(64);
    await conn.query(
      `INSERT INTO backup_snapshot_anchors
         (backup_id,singleton_id,scope,protocol,backup_kind,control_evidence_sha256,
          logical_database_namespace_sha256,journal_control_evidence_sha256,
          source_runtime_epoch_sha256,
          source_runtime_control_generation,source_runtime_control_evidence_sha256,
          source_runtime_target_count,source_runtime_head_catalog_json,
          source_runtime_head_root_sha256,schema_migration_root_sha256,
          blob_storage_control_evidence_sha256,source_catalog_sequence,
          source_catalog_event_root_sha256,retention_until_db_ms,
          created_at_db_ms,anchor_sha256)
       VALUES (?,1,'tenant-backup-snapshot-anchor-v1',
               'tenant-backup-catalog-v1','full',REPEAT('0',64),REPEAT('5',64),
               REPEAT('9',64),REPEAT('a',64),1,REPEAT('c',64),1,
               JSON_ARRAY(JSON_OBJECT(
                 'targetOrdinal',0,'targetSha256',REPEAT('7',64),
                 'failureDomainSha256',REPEAT('8',64),
                 'adapterProtocol','memory-journal-v1',
                 'journalNamespaceSha256',REPEAT('4',64),
                 'logicalDatabaseNamespaceSha256',REPEAT('5',64),
                 'sealedRemoteSequence',0,'sealedHeadRootSha256',?)),
               REPEAT('b',64),?,?,0,?,100,50,REPEAT('4',64))`,
      [BACKUP_ID, EMPTY_REMOTE_HEAD_ROOT_SHA256, schemaMigrationRootSha256,
        blobStorageControlEvidenceSha256, EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256],
    );
  }

  async function insertExternalCatalogEvent(
    conn: Connection,
    input: {
      catalogSequence: number;
      eventType: "backup_recoverable" | "restore_reserved" | "restore_resolved";
      operationSha256: string;
      receiptSha256: string;
      previousCatalogEventRootSha256: string;
      catalogEventRootSha256: string;
      catalogEventSha256: string;
      result: Record<string, unknown>;
    },
  ): Promise<void> {
    const payload = { eventType: input.eventType, result: input.result };
    await conn.query(
      `INSERT INTO backup_catalog_external_events
         (catalog_sequence,singleton_id,scope,protocol,adapter_protocol,
          catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,event_type,
          operation_sha256,receipt_sha256,previous_catalog_event_root_sha256,
          catalog_event_root_sha256,catalog_event_sha256,event_payload_json,event_payload_sha256)
       VALUES (?,1,'tenant-backup-catalog-external-event-v1','tenant-backup-catalog-v1',
               'memory-backup-v1',REPEAT('d',64),REPEAT('e',64),REPEAT('f',64),
               ?,?,?,?,?,?,?,REPEAT('6',64))`,
      [
        input.catalogSequence,
        input.eventType,
        input.operationSha256,
        input.receiptSha256,
        input.previousCatalogEventRootSha256,
        input.catalogEventRootSha256,
        input.catalogEventSha256,
        JSON.stringify(payload),
      ],
    );
  }

  async function seedRecoverableBackup(conn: Connection): Promise<void> {
    await insertSnapshotAnchor(conn);
    await insertExternalCatalogEvent(conn, {
      catalogSequence: 1,
      eventType: "backup_recoverable",
      operationSha256: "8".repeat(64),
      receiptSha256: "9".repeat(64),
      previousCatalogEventRootSha256: EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      catalogEventRootSha256: "b".repeat(64),
      catalogEventSha256: "c".repeat(64),
      result: {
        adapterProtocol: "memory-backup-v1",
        catalogNamespaceSha256: "d".repeat(64),
        catalogTargetSha256: "e".repeat(64),
        failureDomainSha256: "f".repeat(64),
        controlEvidenceSha256: "0".repeat(64),
        logicalDatabaseNamespaceSha256: "5".repeat(64),
        retentionPolicySha256: "1".repeat(64),
        retentionUntilDbMs: 100,
        registeredAtDbMs: 50,
        backupId: BACKUP_ID,
        anchorSha256: "4".repeat(64),
        sourceSnapshotSha256: "5".repeat(64),
        sourceBackupSha256: "3".repeat(64),
        artifactManifestSha256: "6".repeat(64),
        providerEvidenceSha256: "7".repeat(64),
        availabilityOperationSha256: "8".repeat(64),
        availabilityReceiptSha256: "9".repeat(64),
        catalogSequence: 1,
        previousCatalogEventRootSha256: EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256,
        catalogEventRootSha256: "b".repeat(64),
        catalogEventSha256: "c".repeat(64),
        entrySha256: "d".repeat(64),
      },
    });
    await conn.query(
      `INSERT INTO backup_catalog_entries
         (backup_id,scope,protocol,control_evidence_sha256,
          logical_database_namespace_sha256,retention_policy_sha256,
          adapter_protocol,anchor_sha256,source_snapshot_sha256,
          source_backup_sha256,artifact_manifest_sha256,provider_evidence_sha256,
          catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,
          availability_operation_sha256,availability_receipt_sha256,
          catalog_sequence,previous_catalog_event_root_sha256,
          catalog_event_root_sha256,catalog_event_sha256,
          retention_until_db_ms,registered_at_db_ms,entry_sha256)
       VALUES (?,'tenant-backup-catalog-entry-v1','tenant-backup-catalog-v1',
               REPEAT('0',64),REPEAT('5',64),REPEAT('1',64),'memory-backup-v1',
               REPEAT('4',64),REPEAT('5',64),REPEAT('3',64),REPEAT('6',64),
               REPEAT('7',64),REPEAT('d',64),REPEAT('e',64),REPEAT('f',64),
               REPEAT('8',64),REPEAT('9',64),1,?,REPEAT('b',64),
               REPEAT('c',64),100,50,REPEAT('d',64))`,
      [BACKUP_ID, EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256],
    );
  }

  async function seedBindingAndReservation(
    conn: Connection,
    restoreRunId: string,
    runtimeEpochSha256: string,
  ): Promise<void> {
    await insertExternalCatalogEvent(conn, {
      catalogSequence: 2,
      eventType: "restore_reserved",
      operationSha256: "a".repeat(64),
      receiptSha256: "e".repeat(64),
      previousCatalogEventRootSha256: "b".repeat(64),
      catalogEventRootSha256: "c".repeat(64),
      catalogEventSha256: "d".repeat(64),
      result: {
        adapterProtocol: "memory-backup-v1",
        catalogNamespaceSha256: "d".repeat(64),
        catalogTargetSha256: "e".repeat(64),
        backupId: BACKUP_ID,
        restoreRunId,
        entrySha256: "d".repeat(64),
        runtimeEpochSha256,
        reservationOperationSha256: "a".repeat(64),
        reservationReceiptSha256: "e".repeat(64),
        catalogSequence: 2,
        previousCatalogEventRootSha256: "b".repeat(64),
        catalogEventRootSha256: "c".repeat(64),
        catalogEventSha256: "d".repeat(64),
      },
    });
    await conn.query(
      `INSERT INTO backup_restore_source_bindings
         (restore_run_id,backup_id,scope,protocol,anchor_sha256,entry_sha256,
          source_snapshot_sha256,source_backup_sha256,artifact_manifest_sha256,
          provider_evidence_sha256,control_evidence_sha256,
          journal_control_evidence_sha256,sealed_target_root_sha256,
          runtime_epoch_sha256,reservation_receipt_sha256,
          selected_catalog_sequence,selected_catalog_event_root_sha256,
          bound_at_db_ms,binding_sha256)
       VALUES (?,?,'tenant-backup-restore-binding-v1','tenant-backup-catalog-v1',
               REPEAT('4',64),REPEAT('d',64),REPEAT('5',64),REPEAT('3',64),
               REPEAT('6',64),REPEAT('7',64),REPEAT('0',64),REPEAT('9',64),
               REPEAT('b',64),?,REPEAT('e',64),1,REPEAT('b',64),60,REPEAT('f',64))`,
      [restoreRunId, BACKUP_ID, runtimeEpochSha256],
    );
    await conn.query(
      `INSERT INTO backup_runtime_reservations
         (runtime_epoch_sha256,restore_run_id,backup_id,scope,protocol,entry_sha256,
          binding_sha256,reservation_operation_sha256,reservation_receipt_sha256,
          catalog_sequence,previous_catalog_event_root_sha256,
          catalog_event_root_sha256,catalog_event_sha256,phase,reserved_at_db_ms,
          resolution_operation_sha256,resolution_receipt_sha256,
          resolution_catalog_sequence,resolution_previous_catalog_event_root_sha256,
          resolution_catalog_event_root_sha256,resolution_catalog_event_sha256,
          resolved_at_db_ms,reservation_sha256)
       VALUES (?,?,?,'tenant-backup-runtime-reservation-v1',
               'tenant-backup-catalog-v1',REPEAT('d',64),REPEAT('f',64),
               REPEAT('a',64),REPEAT('e',64),2,REPEAT('b',64),REPEAT('c',64),
               REPEAT('d',64),'reserved',61,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
               REPEAT('1',64))`,
      [runtimeEpochSha256, restoreRunId, BACKUP_ID],
    );
  }

  async function activateRestoreRuntime(
    conn: Connection,
    input: { restoreRunId: string; runtimeEpochSha256: string },
  ): Promise<void> {
    await conn.query(
      `UPDATE tenant_restore_runtime_heads
          SET remote_sequence=0,head_root_sha256=?,checkpoint_control_generation=2,
              runtime_epoch_sha256=?,updated_at_db_ms=70
        WHERE singleton_id=1 AND target_ordinal=0`,
      [EMPTY_REMOTE_HEAD_ROOT_SHA256, input.runtimeEpochSha256],
    );
    await conn.query(
      `INSERT INTO tenant_restore_runtime_events
         (singleton_id,control_generation,update_kind,lineage_kind,
          activated_at_db_ms,updated_at_db_ms,restore_run_id,replay_receipt_sha256,
          runtime_epoch_sha256,activation_epoch_sha256,control_evidence_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256)
       VALUES (1,2,'restore_activation','restore',70,70,?,REPEAT('e',64),
               ?,?,REPEAT('9',64),REPEAT('5',64),1,REPEAT('6',64),REPEAT('b',64),
               REPEAT('c',64),REPEAT('d',64))`,
      [input.restoreRunId, input.runtimeEpochSha256, input.runtimeEpochSha256],
    );
    await conn.query(
      `UPDATE tenant_restore_runtime_control
          SET control_generation=2,update_kind='restore_activation',lineage_kind='restore',
              activated_at_db_ms=70,updated_at_db_ms=70,restore_run_id=?,
              replay_receipt_sha256=REPEAT('e',64),runtime_epoch_sha256=?,
              verified_head_root_sha256=REPEAT('b',64),
              previous_control_evidence_sha256=REPEAT('c',64),evidence_sha256=REPEAT('d',64)
        WHERE singleton_id=1`,
      [input.restoreRunId, input.runtimeEpochSha256],
    );
    await conn.query(
      `UPDATE tenant_restore_replay_runs
          SET phase='active',updated_at_db_ms=70,activated_at_db_ms=70
        WHERE restore_run_id=?`,
      [input.restoreRunId],
    );
  }

  async function resolveReservation(
    conn: Connection,
    runtimeEpochSha256: string,
    phase: "activated" | "aborted",
  ): Promise<void> {
    const restoreRunId = (await conn.query<Row[]>(
      "SELECT restore_run_id FROM backup_runtime_reservations WHERE runtime_epoch_sha256=?",
      [runtimeEpochSha256],
    ))[0][0]?.restore_run_id as string | undefined;
    if (!restoreRunId) throw new Error("reservation is missing");
    await insertExternalCatalogEvent(conn, {
      catalogSequence: 3,
      eventType: "restore_resolved",
      operationSha256: "2".repeat(64),
      receiptSha256: "3".repeat(64),
      previousCatalogEventRootSha256: "c".repeat(64),
      catalogEventRootSha256: "4".repeat(64),
      catalogEventSha256: "5".repeat(64),
      result: {
        restoreRunId,
        reservationReceiptSha256: "e".repeat(64),
        phase,
        resolutionOperationSha256: "2".repeat(64),
        resolutionReceiptSha256: "3".repeat(64),
        catalogSequence: 3,
        previousCatalogEventRootSha256: "c".repeat(64),
        catalogEventRootSha256: "4".repeat(64),
        catalogEventSha256: "5".repeat(64),
      },
    });
    await conn.query(
      `UPDATE backup_runtime_reservations
          SET phase=?,resolution_operation_sha256=REPEAT('2',64),
              resolution_receipt_sha256=REPEAT('3',64),resolution_catalog_sequence=3,
              resolution_previous_catalog_event_root_sha256=REPEAT('c',64),
              resolution_catalog_event_root_sha256=REPEAT('4',64),
              resolution_catalog_event_sha256=REPEAT('5',64),resolved_at_db_ms=80
        WHERE runtime_epoch_sha256=?`,
      [phase, runtimeEpochSha256],
    );
  }

  async function injectLegacyAbortedReservation(
    conn: Connection,
    runtimeEpochSha256: string,
  ): Promise<void> {
    // Model a pre-guard/corrupt terminal projection, then restore the current guard before probing
    // the run/runtime gates. Marker-loss replay separately proves this missing trigger is detected.
    const createGuard = statements(migrationSql).find((statement) => (
      statement.startsWith("CREATE TRIGGER trg_backup_catalog_reservations_bu ")
    ));
    if (!createGuard) throw new Error("0031 reservation update guard is missing");
    await conn.query("DROP TRIGGER trg_backup_catalog_reservations_bu");
    await resolveReservation(conn, runtimeEpochSha256, "aborted");
    await conn.query(createGuard);
  }

  it("upgrades a frozen 0030 database dormant and preserves existing restore state", async () => {
    const database = databaseName();
    await create0030(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await activate0030Controls(conn);
      await createLegacyReplayRun(conn, {
        restoreRunId: "restore_legacy_preserved",
        runtimeEpochSha256: "d".repeat(64),
        phase: "aborted",
      });
      const [beforeRun] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_replay_runs WHERE restore_run_id='restore_legacy_preserved'",
      );
      const [beforeJournal] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_journal_control WHERE singleton_id=1",
      );
      const [beforeRuntime] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1",
      );

      await upgrade(database);

      const [afterRun] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_replay_runs WHERE restore_run_id='restore_legacy_preserved'",
      );
      const [afterJournal] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_journal_control WHERE singleton_id=1",
      );
      const [afterRuntime] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1",
      );
      expect(afterRun).toEqual(beforeRun);
      expect(afterJournal).toEqual(beforeJournal);
      expect(afterRuntime).toEqual(beforeRuntime);

      const [control] = await conn.query<Row[]>(
        "SELECT * FROM backup_catalog_control WHERE singleton_id=1",
      );
      expect(control[0]).toMatchObject({ state: "inactive", control_generation: 0 });
      for (const table of NEW_TABLES.slice(1)) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), `${table} must stay empty`).toBe(0);
      }
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("converges from first, middle, and last CREATE TABLE auto-commit boundaries", async () => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS backup_") ? [index] : []
    ));
    expect(createIndexes).toHaveLength(7);
    for (const cutIndex of [createIndexes[0]!, createIndexes[3]!, createIndexes[6]!]) {
      const database = databaseName();
      await create0030(database);
      const conn = await mysql.createConnection(databaseUrl(base, database));
      try {
        for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
        await upgrade(database);
        const [marker] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
          [MIGRATION_NAME],
        );
        expect(Number(marker[0]!.count), `cut ${cutIndex}`).toBe(1);
        const [control] = await conn.query<Row[]>(
          "SELECT state,control_generation FROM backup_catalog_control WHERE singleton_id=1",
        );
        expect(control[0]).toMatchObject({ state: "inactive", control_generation: 0 });
      } finally {
        await conn.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial first table without recording the marker", async () => {
    const database = databaseName();
    await create0030(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TABLE backup_catalog_control
           (singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await expect(upgrade(database)).rejects.toThrow(/0031_authoritative_backup_catalog/);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("repairs an owned trigger after marker loss without activating or materializing work", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query("DROP TRIGGER trg_backup_catalog_bindings_bd");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await upgrade(database);
      const expectedTriggerCount = [...migrationSql.matchAll(
        /CREATE TRIGGER (trg_backup_catalog_[a-z0-9_]+)/g,
      )].length;
      const [triggers] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name LIKE 'trg\\_backup\\_catalog\\_%'`,
      );
      expect(Number(triggers[0]!.count)).toBe(expectedTriggerCount);
      const [control] = await conn.query<Row[]>(
        "SELECT state,control_generation FROM backup_catalog_control WHERE singleton_id=1",
      );
      expect(control[0]).toMatchObject({ state: "inactive", control_generation: 0 });
      for (const table of NEW_TABLES.slice(1)) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), table).toBe(0);
      }
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects marker-loss replay when an unknown same-prefix trigger exists", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TRIGGER trg_backup_catalog_unknown_bi
           BEFORE INSERT ON backup_catalog_entries FOR EACH ROW
           SET @backup_catalog_unknown = 1`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0031_authoritative_backup_catalog/);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects marker-loss replay after the catalog schema is weakened", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        "ALTER TABLE backup_catalog_control DROP CHECK chk_backup_catalog_control_state",
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0031_authoritative_backup_catalog/);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects an external event whose JSON proof field is missing or null", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      for (const shape of ["missing", "null"] as const) {
        const result: Record<string, unknown> = {
          catalogSequence: 1,
          previousCatalogEventRootSha256: EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256,
          catalogEventRootSha256: "b".repeat(64),
          availabilityOperationSha256: "8".repeat(64),
          availabilityReceiptSha256: "9".repeat(64),
        };
        if (shape === "null") result.catalogEventSha256 = null;
        const malformed = { eventType: "backup_recoverable", result };
        await expect(conn.query(
          `INSERT INTO backup_catalog_external_events
             (catalog_sequence,singleton_id,scope,protocol,adapter_protocol,
              catalog_namespace_sha256,catalog_target_sha256,failure_domain_sha256,event_type,
              operation_sha256,receipt_sha256,previous_catalog_event_root_sha256,
              catalog_event_root_sha256,catalog_event_sha256,event_payload_json,event_payload_sha256)
           VALUES (1,1,'tenant-backup-catalog-external-event-v1','tenant-backup-catalog-v1',
                   'memory-backup-v1',REPEAT('d',64),REPEAT('e',64),REPEAT('f',64),
                   'backup_recoverable',REPEAT('8',64),REPEAT('9',64),?,
                   REPEAT('b',64),REPEAT('c',64),?,REPEAT('6',64))`,
          [EMPTY_BACKUP_CATALOG_EVENT_ROOT_SHA256, JSON.stringify(malformed)],
        ), shape).rejects.toThrow(/does not extend the active chain/);
      }
      const [rows] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM backup_catalog_external_events",
      );
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects a NULL protocol during the one-way catalog activation", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await expect(activateCatalogControl(conn, null))
        .rejects.toThrow(/activation is not permitted/);
      const [rows] = await conn.query<Row[]>(
        `SELECT state,control_generation,protocol
           FROM backup_catalog_control WHERE singleton_id=1`,
      );
      expect(rows[0]).toMatchObject({
        state: "inactive",
        control_generation: 0,
        protocol: null,
      });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it.each([
    {
      name: "schema migration root",
      override: { schemaMigrationRootSha256: "f".repeat(64) },
    },
    {
      name: "Blob control evidence",
      override: { blobStorageControlEvidenceSha256: "e".repeat(64) },
    },
  ])("rejects an anchor with the wrong $name without leaving a partial row", async ({ override }) => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      await expect(insertSnapshotAnchor(conn, override))
        .rejects.toThrow(/backup snapshot anchor is not active-source-bound/);
      const [rows] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM backup_snapshot_anchors) AS anchor_count,
           (SELECT control_generation FROM blob_storage_control
             WHERE singleton_id=1) AS blob_generation`,
      );
      expect(rows[0]).toMatchObject({ anchor_count: 0, blob_generation: 1 });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it.each(["prepared", "replay_sealed"] as const)(
    "blocks catalog activation while an unbound legacy %s run exists",
    async (phase) => {
      const database = databaseName();
      await create0030(database);
      const conn = await mysql.createConnection(databaseUrl(base, database));
      try {
        await activate0030Controls(conn);
        await createLegacyReplayRun(conn, {
          restoreRunId: `restore_legacy_unbound_${phase}`,
          runtimeEpochSha256: (phase === "prepared" ? "d" : "e").repeat(64),
          phase,
        });
        await upgrade(database);
        await activateBlobStorageControl(conn);
        await conn.beginTransaction();
        await expect(activateCatalogControl(conn)).rejects.toThrow(/activation is not permitted/);
        await conn.rollback();
        const [control] = await conn.query<Row[]>(
          "SELECT state,control_generation FROM backup_catalog_control WHERE singleton_id=1",
        );
        expect(control[0]).toMatchObject({ state: "inactive", control_generation: 0 });
      } finally {
        await conn.end();
        await cleanup(database);
      }
    },
  );

  it("rejects old unbound restore inserts and rolls back a rejected binding-first transaction", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const restoreRunId = "restore_00000000-0000-4000-8000-000000000031";
    const runtimeEpochSha256 = "d".repeat(64);
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      await seedRecoverableBackup(conn);

      await expect(createLegacyReplayRun(conn, {
        restoreRunId: "restore_old_unbound_insert",
        runtimeEpochSha256: "e".repeat(64),
      })).rejects.toThrow(/active backup catalog requires exact restore source binding/);

      await conn.beginTransaction();
      try {
        await seedBindingAndReservation(conn, restoreRunId, runtimeEpochSha256);
        await expect(createLegacyReplayRun(conn, {
          restoreRunId,
          runtimeEpochSha256,
          sourceBackupSha256: "f".repeat(64),
        })).rejects.toThrow(/active backup catalog requires exact restore source binding/);
      } finally {
        await conn.rollback();
      }
      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM backup_restore_source_bindings
             WHERE restore_run_id=?) AS binding_count,
           (SELECT COUNT(*) FROM backup_runtime_reservations
             WHERE restore_run_id=?) AS reservation_count,
           (SELECT COUNT(*) FROM tenant_restore_replay_runs
             WHERE restore_run_id=?) AS run_count`,
        [restoreRunId, restoreRunId, restoreRunId],
      );
      expect(counts[0]).toMatchObject({ binding_count: 0, reservation_count: 0, run_count: 0 });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects a legacy run update after its exact reservation has been aborted", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const restoreRunId = "restore_00000000-0000-4000-8000-000000000032";
    const runtimeEpochSha256 = "d".repeat(64);
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      await seedRecoverableBackup(conn);
      await conn.beginTransaction();
      await seedBindingAndReservation(conn, restoreRunId, runtimeEpochSha256);
      await createLegacyReplayRun(conn, {
        restoreRunId,
        runtimeEpochSha256,
        sourceBackupSha256: "3".repeat(64),
      });
      await conn.commit();
      await injectLegacyAbortedReservation(conn, runtimeEpochSha256);

      await expect(sealLegacyReplayRun(conn, restoreRunId))
        .rejects.toThrow(/active backup catalog requires exact restore source binding/);
      const [rows] = await conn.query<Row[]>(
        `SELECT r.phase AS run_phase,q.phase AS reservation_phase
           FROM tenant_restore_replay_runs r
           JOIN backup_runtime_reservations q ON q.restore_run_id=r.restore_run_id
          WHERE r.restore_run_id=?`,
        [restoreRunId],
      );
      expect(rows[0]).toMatchObject({ run_phase: "prepared", reservation_phase: "aborted" });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("allows an exact reserved reservation through the 0030 restore activation transaction", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const restoreRunId = "restore_00000000-0000-4000-8000-000000000033";
    const runtimeEpochSha256 = "d".repeat(64);
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      await seedRecoverableBackup(conn);
      await conn.beginTransaction();
      await seedBindingAndReservation(conn, restoreRunId, runtimeEpochSha256);
      await createLegacyReplayRun(conn, {
        restoreRunId,
        runtimeEpochSha256,
        sourceBackupSha256: "3".repeat(64),
        phase: "replay_sealed",
      });
      await conn.commit();

      await conn.beginTransaction();
      await activateRestoreRuntime(conn, { restoreRunId, runtimeEpochSha256 });
      await conn.commit();

      const [state] = await conn.query<Row[]>(
        `SELECT c.control_generation,c.update_kind,c.lineage_kind,c.runtime_epoch_sha256,
                h.checkpoint_control_generation,h.runtime_epoch_sha256 AS head_runtime_epoch,
                (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS event_count,
                (SELECT phase FROM tenant_restore_replay_runs WHERE restore_run_id=?) AS run_phase,
                (SELECT phase FROM backup_runtime_reservations
                  WHERE restore_run_id=?) AS reservation_phase
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id
          WHERE c.singleton_id=1 AND h.target_ordinal=0`,
        [restoreRunId, restoreRunId],
      );
      expect(state[0]).toMatchObject({
        control_generation: 2,
        update_kind: "restore_activation",
        lineage_kind: "restore",
        runtime_epoch_sha256: runtimeEpochSha256,
        checkpoint_control_generation: 2,
        head_runtime_epoch: runtimeEpochSha256,
        event_count: 2,
        run_phase: "active",
        reservation_phase: "reserved",
      });
      await resolveReservation(conn, runtimeEpochSha256, "activated");
      const [resolved] = await conn.query<Row[]>(
        "SELECT phase FROM backup_runtime_reservations WHERE runtime_epoch_sha256=?",
        [runtimeEpochSha256],
      );
      expect(resolved[0]!.phase).toBe("activated");
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rolls back restore runtime state when its exact reservation is aborted", async () => {
    const database = databaseName();
    await create0030(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const restoreRunId = "restore_00000000-0000-4000-8000-000000000034";
    const runtimeEpochSha256 = "d".repeat(64);
    try {
      await activate0030Controls(conn);
      await activateBlobStorageControl(conn);
      await activateCatalogControl(conn);
      await seedRecoverableBackup(conn);
      await conn.beginTransaction();
      await seedBindingAndReservation(conn, restoreRunId, runtimeEpochSha256);
      await createLegacyReplayRun(conn, {
        restoreRunId,
        runtimeEpochSha256,
        sourceBackupSha256: "3".repeat(64),
        phase: "replay_sealed",
      });
      await conn.commit();
      await injectLegacyAbortedReservation(conn, runtimeEpochSha256);

      await conn.beginTransaction();
      try {
        await expect(activateRestoreRuntime(conn, { restoreRunId, runtimeEpochSha256 }))
          .rejects.toThrow(/active backup catalog requires reserved restore activation/);
      } finally {
        await conn.rollback();
      }

      const [state] = await conn.query<Row[]>(
        `SELECT c.control_generation,c.update_kind,c.lineage_kind,c.runtime_epoch_sha256,
                h.checkpoint_control_generation,h.runtime_epoch_sha256 AS head_runtime_epoch,
                (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS event_count,
                (SELECT phase FROM backup_runtime_reservations WHERE restore_run_id=?) AS phase
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id
          WHERE c.singleton_id=1 AND h.target_ordinal=0`,
        [restoreRunId],
      );
      expect(state[0]).toMatchObject({
        control_generation: 1,
        update_kind: "primary_activation",
        lineage_kind: "primary",
        runtime_epoch_sha256: "a".repeat(64),
        checkpoint_control_generation: 1,
        head_runtime_epoch: "a".repeat(64),
        event_count: 1,
        phase: "aborted",
      });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });
});
