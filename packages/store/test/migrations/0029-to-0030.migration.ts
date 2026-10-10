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
const MIGRATION_NAME = "0030_tenant_restore_journal.sql";
const EMPTY_REMOTE_HEAD_ROOT_SHA256 =
  "43d0d8350fb8afc557d4454447f3d630440769dc17b6a955454c563f0dbd3056";
const EMPTY_RUNTIME_CONTROL_EVIDENCE_SHA256 =
  "44bf64ec269083713f602ff9de0c936f48e8515f97335290eefd9dd2c61c9590";

const FROZEN_0029_MIGRATIONS = [
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
] as const;

type Row = RowDataPacket;

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

const NEW_TABLES = [
  "tenant_restore_journal_jobs",
  "tenant_restore_journal_targets",
  "tenant_restore_journal_target_acks",
  "tenant_restore_journal_receipts",
  "tenant_restore_fences",
  "tenant_restore_replay_runs",
  "tenant_restore_replay_entries",
  "tenant_restore_runtime_heads",
  "tenant_restore_runtime_known_entries",
  "tenant_restore_runtime_events",
] as const;

describe("0029 -> 0030 tenant restore journal migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0030Dir: string;
  let migrationSql: string;

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0030Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0030-"));
    for (const [file, expectedSha256] of FROZEN_0029_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0030Dir, file));
    }
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0030Dir) await rm(pre0030Dir, { recursive: true, force: true });
  });

  async function create0029(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0030Dir,
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

  async function seedOldCredentialEvidence(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_credential_tracking_subjects
         (tenant_id,tracking_started_at_db_ms,history_status,origin,evidence_sha256)
       VALUES ('tenant-pre0030',1,'legacy_history_unknown','legacy_observed',?)`,
      ["1".repeat(64)],
    );
    await conn.query(
      `INSERT INTO tenant_credential_versions
         (credential_version_id,tenant_id,slot_kind,slot_id_sha256,origin,
          encrypted_secret_present,secret_key_id_present,custom_headers_present,
          endpoint_parameters_present,created_at_db_ms,evidence_sha256)
       VALUES (?, 'tenant-pre0030','provider_binding',?,'legacy_observed',
               TRUE,TRUE,FALSE,FALSE,1,?)`,
      ["2".repeat(64), "3".repeat(64), "4".repeat(64)],
    );
    for (const [domain, disposition, evidence] of [
      ["external_credential", "blocked_legacy_history", "5".repeat(64)],
      ["kms_key", "blocked_legacy_history", "6".repeat(64)],
    ]) {
      await conn.query(
        `INSERT INTO tenant_credential_target_dispositions
           (credential_version_id,tenant_id,domain,disposition,captured_at_db_ms,evidence_sha256)
         VALUES (?, 'tenant-pre0030',?,?,1,?)`,
        ["2".repeat(64), domain, disposition, evidence],
      );
    }
  }

  async function seedHistoricalT3aReceipt(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_credential_revocation_receipts
         (request_id,tenant_id,subject_generation,scope,t1_fence_sha256,
          api_key_count_before,api_key_count_after,
          provider_config_count_before,provider_config_count_after,
          auth_policy_present_before,auth_policy_present_after,
          auth_secret_cipher_present_before,auth_secret_cipher_present_after,
          auth_secret_key_id_present_before,auth_secret_key_id_present_after,
          store_db_timestamp_ms,completed_claim_attempt,completed_claim_token_sha256,
          runtime_disposition,external_disposition,content_purge_required,receipt_sha256)
       VALUES
         ('erase_00000000-0000-4000-8000-000000000030','tenant-pre0030-t3a',1,
          'local-db-credential-material-v1',REPEAT('1',64),1,0,1,0,
          TRUE,FALSE,TRUE,FALSE,TRUE,FALSE,10,1,REPEAT('2',64),
          'not_in_scope','not_supported',TRUE,REPEAT('3',64))`,
    );
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

  async function createSealedReplayRun(
    conn: Connection,
    restoreRunId: string,
    runtimeEpochSha256: string,
    terminalReceiptSha256: string,
    createdAtDbMs: number,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_restore_replay_runs
         (restore_run_id,source_backup_sha256,runtime_epoch_sha256,protocol,
          control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          sealed_target_catalog_json,sealed_target_root_sha256,expected_entry_count,
          entry_count,entry_root_sha256,fence_count,fence_root_sha256,phase,
          created_at_db_ms,updated_at_db_ms,terminal_receipt_sha256,sealed_at_db_ms,
          activated_at_db_ms,aborted_at_db_ms)
       VALUES (?,REPEAT('1',64),?,'tenant-restore-journal-v1',REPEAT('9',64),
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
      [restoreRunId, runtimeEpochSha256, EMPTY_REMOTE_HEAD_ROOT_SHA256,
        createdAtDbMs, createdAtDbMs],
    );
    await conn.query(
      `UPDATE tenant_restore_replay_runs
          SET phase='replay_sealed',updated_at_db_ms=?,terminal_receipt_sha256=?,
              sealed_at_db_ms=?
        WHERE restore_run_id=?`,
      [createdAtDbMs + 1, terminalReceiptSha256, createdAtDbMs + 1, restoreRunId],
    );
  }

  async function createPreparedProofRun(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_restore_replay_runs
         (restore_run_id,source_backup_sha256,runtime_epoch_sha256,protocol,
          control_evidence_sha256,adapter_protocol,journal_namespace_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          sealed_target_catalog_json,sealed_target_root_sha256,expected_entry_count,
          entry_count,entry_root_sha256,fence_count,fence_root_sha256,phase,
          created_at_db_ms,updated_at_db_ms,terminal_receipt_sha256,sealed_at_db_ms,
          activated_at_db_ms,aborted_at_db_ms)
       VALUES ('restore_run_known_entries',REPEAT('1',64),REPEAT('d',64),
               'tenant-restore-journal-v1',REPEAT('9',64),'memory-journal-v1',
               REPEAT('4',64),REPEAT('5',64),1,REPEAT('6',64),
               JSON_ARRAY(JSON_OBJECT('targetOrdinal',0)),REPEAT('b',64),2,0,
               REPEAT('2',64),0,REPEAT('3',64),'prepared',20,20,NULL,NULL,NULL,NULL)`,
    );
  }

  async function createRestoreFence(
    conn: Connection,
    requestId: string,
    tenantId: string,
    t1FenceSha256: string,
    operationSha256: string,
    recordSha256: string,
    fenceSha256: string,
  ): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_restore_fences
         (tenant_id,scope,logical_database_namespace_sha256,request_id,
          subject_generation,t1_fence_sha256,operation_sha256,record_sha256,
          restore_run_id,source_target_sha256,source_remote_sequence,
          source_head_root_sha256,installed_at_db_ms,fence_sha256)
       VALUES (?,'tenant-restore-fence-v1',REPEAT('5',64),?,1,?,?,?,
               'restore_run_known_entries',REPEAT('7',64),1,REPEAT('a',64),20,?)`,
      [tenantId, requestId, t1FenceSha256, operationSha256, recordSha256, fenceSha256],
    );
  }

  async function advanceRuntimeHead(
    conn: Connection,
    input: {
      controlGeneration: number;
      remoteSequence: number;
      previousHeadRootSha256: string;
      headRootSha256: string;
      requestId: string;
      tenantId: string;
      t1FenceSha256: string;
      operationSha256: string;
      recordSha256: string;
      previousControlEvidenceSha256: string;
      evidenceSha256: string;
      updatedAtDbMs: number;
    },
  ): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_restore_runtime_known_entries
         (singleton_id,runtime_epoch_sha256,target_ordinal,target_sha256,remote_sequence,
          previous_head_root_sha256,head_root_sha256,record_scope,record_protocol,
          logical_database_namespace_sha256,request_id,tenant_id,subject_generation,
          t1_fence_sha256,operation_sha256,record_sha256,control_generation,recorded_at_db_ms)
       VALUES (1,REPEAT('a',64),0,REPEAT('7',64),?,?,?,
               'tenant-restore-journal-record-v1','tenant-restore-journal-v1',
               REPEAT('5',64),?,?,1,?,?,?,?,?)`,
      [input.remoteSequence, input.previousHeadRootSha256, input.headRootSha256,
        input.requestId, input.tenantId, input.t1FenceSha256, input.operationSha256,
        input.recordSha256, input.controlGeneration, input.updatedAtDbMs],
    );
    await conn.query(
      `UPDATE tenant_restore_runtime_heads
          SET remote_sequence=?,head_root_sha256=?,checkpoint_control_generation=?,
              updated_at_db_ms=?
        WHERE singleton_id=1 AND target_ordinal=0`,
      [input.remoteSequence, input.headRootSha256, input.controlGeneration, input.updatedAtDbMs],
    );
    await conn.query(
      `INSERT INTO tenant_restore_runtime_events
         (singleton_id,control_generation,update_kind,lineage_kind,
          activated_at_db_ms,updated_at_db_ms,restore_run_id,replay_receipt_sha256,
          runtime_epoch_sha256,activation_epoch_sha256,control_evidence_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256)
       VALUES (1,?,'journal_head_advance','primary',20,?,NULL,NULL,
               REPEAT('a',64),NULL,REPEAT('9',64),REPEAT('5',64),1,REPEAT('6',64),
               ?,?,?)`,
      [input.controlGeneration, input.updatedAtDbMs, input.headRootSha256,
        input.previousControlEvidenceSha256, input.evidenceSha256],
    );
    await conn.query(
      `UPDATE tenant_restore_runtime_control
          SET control_generation=?,update_kind='journal_head_advance',updated_at_db_ms=?,
              verified_head_root_sha256=?,previous_control_evidence_sha256=?,evidence_sha256=?
        WHERE singleton_id=1`,
      [input.controlGeneration, input.updatedAtDbMs, input.headRootSha256,
        input.previousControlEvidenceSha256, input.evidenceSha256],
    );
  }

  async function activateRestoreRuntime(
    conn: Connection,
    input: {
      restoreRunId: string;
      runtimeEpochSha256: string;
      replayReceiptSha256: string;
      controlGeneration: number;
      previousControlEvidenceSha256: string;
      evidenceSha256: string;
      activatedAtDbMs: number;
    },
  ): Promise<void> {
    await conn.query(
      `UPDATE tenant_restore_runtime_heads
          SET remote_sequence=0,head_root_sha256=?,checkpoint_control_generation=?,
              runtime_epoch_sha256=?,updated_at_db_ms=?
        WHERE singleton_id=1 AND target_ordinal=0`,
      [EMPTY_REMOTE_HEAD_ROOT_SHA256, input.controlGeneration,
        input.runtimeEpochSha256, input.activatedAtDbMs],
    );
    await conn.query(
      `INSERT INTO tenant_restore_runtime_events
         (singleton_id,control_generation,update_kind,lineage_kind,
          activated_at_db_ms,updated_at_db_ms,restore_run_id,replay_receipt_sha256,
          runtime_epoch_sha256,activation_epoch_sha256,control_evidence_sha256,
          logical_database_namespace_sha256,target_count,target_root_sha256,
          verified_head_root_sha256,previous_control_evidence_sha256,evidence_sha256)
       VALUES (1,?,'restore_activation','restore',?,?,?, ?,?,?,REPEAT('9',64),
               REPEAT('5',64),1,REPEAT('6',64),REPEAT('b',64),?,?)`,
      [input.controlGeneration, input.activatedAtDbMs, input.activatedAtDbMs,
        input.restoreRunId, input.replayReceiptSha256, input.runtimeEpochSha256,
        input.runtimeEpochSha256, input.previousControlEvidenceSha256, input.evidenceSha256],
    );
    await conn.query(
      `UPDATE tenant_restore_runtime_control
          SET control_generation=?,update_kind='restore_activation',lineage_kind='restore',
              activated_at_db_ms=?,updated_at_db_ms=?,restore_run_id=?,
              replay_receipt_sha256=?,runtime_epoch_sha256=?,
              verified_head_root_sha256=REPEAT('b',64),
              previous_control_evidence_sha256=?,evidence_sha256=?
        WHERE singleton_id=1`,
      [input.controlGeneration, input.activatedAtDbMs, input.activatedAtDbMs,
        input.restoreRunId, input.replayReceiptSha256, input.runtimeEpochSha256,
        input.previousControlEvidenceSha256, input.evidenceSha256],
    );
  }

  it("upgrades a frozen 0029 database dormant and preserves every old seeded field", async () => {
    const database = databaseName();
    await create0029(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await seedOldCredentialEvidence(conn);
      const oldTables = [
        "tenant_credential_tracking_subjects",
        "tenant_credential_versions",
        "tenant_credential_target_dispositions",
      ];
      const before = new Map<string, Row[]>();
      for (const table of oldTables) {
        const [rows] = await conn.query<Row[]>(
          `SELECT * FROM ${table} WHERE tenant_id='tenant-pre0030' ORDER BY 1`,
        );
        before.set(table, rows);
      }

      await upgrade(database);

      for (const table of oldTables) {
        const [rows] = await conn.query<Row[]>(
          `SELECT * FROM ${table} WHERE tenant_id='tenant-pre0030' ORDER BY 1`,
        );
        expect(rows, table).toEqual(before.get(table));
      }
      const [journalControl] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_journal_control WHERE singleton_id=1",
      );
      expect(journalControl[0]).toMatchObject({
        control_generation: 0,
        activated_at_db_ms: null,
        protocol: null,
        adapter_protocol: null,
        journal_namespace_sha256: null,
        logical_database_namespace_sha256: null,
        target_count: 0,
        target_root_sha256: null,
        target_catalog_json: null,
        evidence_sha256: null,
      });
      const [runtimeControl] = await conn.query<Row[]>(
        "SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1",
      );
      expect(runtimeControl[0]).toMatchObject({
        state: "inactive",
        control_generation: 0,
        update_kind: null,
        lineage_kind: null,
        activated_at_db_ms: null,
        updated_at_db_ms: null,
        restore_run_id: null,
        replay_receipt_sha256: null,
        runtime_epoch_sha256: null,
        control_evidence_sha256: null,
        logical_database_namespace_sha256: null,
        target_count: 0,
        target_root_sha256: null,
        verified_head_root_sha256: null,
        previous_control_evidence_sha256: null,
        evidence_sha256: null,
      });
      for (const table of NEW_TABLES) {
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

  it("repairs an owned trigger after marker loss without activating or materializing work", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query("DROP TRIGGER trg_restore_journal_fences_bd");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await upgrade(database);
      const [triggers] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name LIKE 'trg\\_restore\\_journal\\_%'`,
      );
      expect(Number(triggers[0]!.count)).toBe(39);
      const [control] = await conn.query<Row[]>(
        "SELECT control_generation FROM tenant_restore_journal_control",
      );
      expect(Number(control[0]!.control_generation)).toBe(0);
      for (const table of NEW_TABLES) {
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
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TRIGGER trg_restore_journal_unknown_bi
           BEFORE INSERT ON tenant_restore_journal_targets FOR EACH ROW
           SET @restore_journal_unknown = 1`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0030_tenant_restore_journal/);
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

  it.each([
    {
      name: "engine",
      weaken: "ALTER TABLE tenant_restore_journal_control ENGINE=MyISAM",
    },
    {
      name: "collation",
      weaken: "ALTER TABLE tenant_restore_journal_control COLLATE=utf8mb4_0900_ai_ci",
    },
    {
      name: "index",
      weaken: `ALTER TABLE tenant_restore_runtime_heads
                 DROP INDEX idx_restore_runtime_head_checkpoint,
                 ADD INDEX idx_restore_runtime_head_checkpoint (singleton_id,target_ordinal)`,
    },
    {
      name: "CHECK constraint",
      weaken: `ALTER TABLE tenant_restore_runtime_heads
                 DROP CHECK chk_restore_runtime_head_shape`,
    },
    {
      name: "foreign key",
      weaken: `ALTER TABLE tenant_restore_runtime_heads
                 DROP FOREIGN KEY fk_restore_runtime_head_control`,
    },
  ])("rejects marker-loss replay with a weakened $name", async ({ weaken }) => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(weaken);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0030_tenant_restore_journal/);
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

  it("converges from first, middle, and last CREATE TABLE auto-commit boundaries", async () => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_restore_") ? [index] : []
    ));
    expect(createIndexes).toHaveLength(12);
    for (const cutIndex of [createIndexes[0]!, createIndexes[5]!, createIndexes[11]!]) {
      const database = databaseName();
      await create0029(database);
      const conn = await mysql.createConnection(databaseUrl(base, database));
      try {
        for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
        await upgrade(database);
        const [marker] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
          [MIGRATION_NAME],
        );
        expect(Number(marker[0]!.count), `cut ${cutIndex}`).toBe(1);
        const [controls] = await conn.query<Row[]>(
          `SELECT
             (SELECT control_generation FROM tenant_restore_journal_control) AS journal_generation,
             (SELECT control_generation FROM tenant_restore_runtime_control) AS runtime_generation`,
        );
        expect(Number(controls[0]!.journal_generation), `cut ${cutIndex}`).toBe(0);
        expect(Number(controls[0]!.runtime_generation), `cut ${cutIndex}`).toBe(0);
      } finally {
        await conn.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial first table without recording the marker", async () => {
    const database = databaseName();
    await create0029(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TABLE tenant_restore_journal_control
           (singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await expect(upgrade(database)).rejects.toThrow(/0030_tenant_restore_journal/);
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

  it("keeps both dormant controls guarded against delete, duplicate insert, and invalid CAS", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await expect(conn.query(
        "UPDATE tenant_restore_journal_control SET control_generation=2 WHERE singleton_id=1",
      )).rejects.toThrow(/activation is not permitted/);
      await expect(conn.query(
        "DELETE FROM tenant_restore_journal_control WHERE singleton_id=1",
      )).rejects.toThrow(/cannot be deleted/);
      await expect(conn.query(
        "INSERT INTO tenant_restore_runtime_control (singleton_id,control_generation) VALUES (2,0)",
      )).rejects.toThrow(/already exists/);
      await expect(conn.query(
        "UPDATE tenant_restore_runtime_control SET control_generation=1 WHERE singleton_id=1",
      )).rejects.toThrow(/transition is not permitted/);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("atomically activates an exact empty runtime-head catalog and guards its checkpoints", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.beginTransaction();
      await stagePrimaryRuntimeActivation(conn);
      await activateJournalControl(conn);
      await conn.commit();

      const [controls] = await conn.query<Row[]>(
        `SELECT
           (SELECT control_generation FROM tenant_restore_journal_control) AS journal_generation,
           (SELECT control_generation FROM tenant_restore_runtime_control) AS runtime_generation`,
      );
      expect(Number(controls[0]!.journal_generation)).toBe(1);
      expect(Number(controls[0]!.runtime_generation)).toBe(1);
      const [heads] = await conn.query<Row[]>(
        `SELECT target_ordinal,target_sha256,failure_domain_sha256,remote_sequence,
                head_root_sha256,checkpoint_control_generation,runtime_epoch_sha256
           FROM tenant_restore_runtime_heads ORDER BY target_ordinal`,
      );
      expect(heads).toEqual([expect.objectContaining({
        target_ordinal: 0,
        target_sha256: "7".repeat(64),
        failure_domain_sha256: "8".repeat(64),
        remote_sequence: 0,
        head_root_sha256: EMPTY_REMOTE_HEAD_ROOT_SHA256,
        checkpoint_control_generation: 1,
        runtime_epoch_sha256: "a".repeat(64),
      })]);
      await expect(conn.query(
        `UPDATE tenant_restore_runtime_heads
            SET remote_sequence=2,head_root_sha256=REPEAT('d',64),
                checkpoint_control_generation=2,updated_at_db_ms=21
          WHERE singleton_id=1 AND target_ordinal=0`,
      )).rejects.toThrow(/head update is not permitted/);
      await expect(conn.query(
        "DELETE FROM tenant_restore_runtime_heads WHERE singleton_id=1 AND target_ordinal=0",
      )).rejects.toThrow(/head cannot be deleted/);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("proves an older committed head advance exactly after a later advance and rejects conflict", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const first = {
      controlGeneration: 2,
      remoteSequence: 1,
      previousHeadRootSha256: EMPTY_REMOTE_HEAD_ROOT_SHA256,
      headRootSha256: "f".repeat(64),
      requestId: "erase_00000000-0000-4000-8000-000000000031",
      tenantId: "tenant-runtime-known-1",
      t1FenceSha256: "1".repeat(64),
      operationSha256: "2".repeat(64),
      recordSha256: "3".repeat(64),
      previousControlEvidenceSha256: "c".repeat(64),
      evidenceSha256: "d".repeat(64),
      updatedAtDbMs: 21,
    };
    const second = {
      controlGeneration: 3,
      remoteSequence: 2,
      previousHeadRootSha256: first.headRootSha256,
      headRootSha256: "0".repeat(64),
      requestId: "erase_00000000-0000-4000-8000-000000000032",
      tenantId: "tenant-runtime-known-2",
      t1FenceSha256: "4".repeat(64),
      operationSha256: "5".repeat(64),
      recordSha256: "6".repeat(64),
      previousControlEvidenceSha256: first.evidenceSha256,
      evidenceSha256: "e".repeat(64),
      updatedAtDbMs: 22,
    };
    try {
      await conn.beginTransaction();
      await stagePrimaryRuntimeActivation(conn);
      await activateJournalControl(conn);
      await conn.commit();
      await createPreparedProofRun(conn);
      await createRestoreFence(conn, first.requestId, first.tenantId, first.t1FenceSha256,
        first.operationSha256, first.recordSha256, "7".repeat(64));
      await createRestoreFence(conn, second.requestId, second.tenantId, second.t1FenceSha256,
        second.operationSha256, second.recordSha256, "8".repeat(64));

      await conn.beginTransaction();
      await advanceRuntimeHead(conn, first);
      await conn.commit(); // Model a committed response-loss window for A.
      await conn.beginTransaction();
      await advanceRuntimeHead(conn, second);
      await conn.commit(); // B advances the same target before A retries.

      const [known] = await conn.query<Row[]>(
        `SELECT target_ordinal,target_sha256,remote_sequence,previous_head_root_sha256,
                head_root_sha256,request_id,tenant_id,subject_generation,t1_fence_sha256,
                operation_sha256,record_sha256,control_generation
           FROM tenant_restore_runtime_known_entries
          WHERE runtime_epoch_sha256=REPEAT('a',64)
            AND target_sha256=REPEAT('7',64) AND remote_sequence=1`,
      );
      expect(known).toEqual([expect.objectContaining({
        target_ordinal: 0,
        target_sha256: "7".repeat(64),
        remote_sequence: 1,
        previous_head_root_sha256: first.previousHeadRootSha256,
        head_root_sha256: first.headRootSha256,
        request_id: first.requestId,
        tenant_id: first.tenantId,
        subject_generation: 1,
        t1_fence_sha256: first.t1FenceSha256,
        operation_sha256: first.operationSha256,
        record_sha256: first.recordSha256,
        control_generation: 2,
      })]);
      await expect(conn.query(
        `INSERT INTO tenant_restore_runtime_known_entries
           (singleton_id,runtime_epoch_sha256,target_ordinal,target_sha256,remote_sequence,
            previous_head_root_sha256,head_root_sha256,record_scope,record_protocol,
            logical_database_namespace_sha256,request_id,tenant_id,subject_generation,
            t1_fence_sha256,operation_sha256,record_sha256,control_generation,recorded_at_db_ms)
         VALUES (1,REPEAT('a',64),0,REPEAT('7',64),1,?,REPEAT('9',64),
                 'tenant-restore-journal-record-v1','tenant-restore-journal-v1',
                 REPEAT('5',64),?,?,1,?,?,REPEAT('9',64),4,23)`,
        [first.previousHeadRootSha256, first.requestId, first.tenantId,
          first.t1FenceSha256, first.operationSha256],
      )).rejects.toThrow();
      const [head] = await conn.query<Row[]>(
        `SELECT remote_sequence,head_root_sha256,checkpoint_control_generation
           FROM tenant_restore_runtime_heads WHERE singleton_id=1 AND target_ordinal=0`,
      );
      expect(head[0]).toMatchObject({
        remote_sequence: 2,
        head_root_sha256: second.headRootSha256,
        checkpoint_control_generation: 3,
      });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rolls back a known entry and head when the immutable control event is rejected", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const attempted = {
      controlGeneration: 2,
      remoteSequence: 1,
      previousHeadRootSha256: EMPTY_REMOTE_HEAD_ROOT_SHA256,
      headRootSha256: "f".repeat(64),
      requestId: "erase_00000000-0000-4000-8000-000000000033",
      tenantId: "tenant-runtime-event-rollback",
      t1FenceSha256: "1".repeat(64),
      operationSha256: "2".repeat(64),
      recordSha256: "3".repeat(64),
      previousControlEvidenceSha256: "0".repeat(64),
      evidenceSha256: "d".repeat(64),
      updatedAtDbMs: 21,
    };
    try {
      await conn.beginTransaction();
      await stagePrimaryRuntimeActivation(conn);
      await activateJournalControl(conn);
      await conn.commit();
      await createPreparedProofRun(conn);
      await createRestoreFence(conn, attempted.requestId, attempted.tenantId,
        attempted.t1FenceSha256, attempted.operationSha256, attempted.recordSha256,
        "7".repeat(64));

      await conn.beginTransaction();
      await expect(advanceRuntimeHead(conn, attempted)).rejects.toThrow(
        /event is not control-bound/,
      );
      await conn.rollback();
      const [state] = await conn.query<Row[]>(
        `SELECT
           (SELECT control_generation FROM tenant_restore_runtime_control) AS generation,
           (SELECT remote_sequence FROM tenant_restore_runtime_heads
             WHERE singleton_id=1 AND target_ordinal=0) AS remote_sequence,
           (SELECT COUNT(*) FROM tenant_restore_runtime_known_entries) AS known_count,
           (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS event_count`,
      );
      expect(Number(state[0]!.generation)).toBe(1);
      expect(Number(state[0]!.remote_sequence)).toBe(0);
      expect(Number(state[0]!.known_count)).toBe(0);
      expect(Number(state[0]!.event_count)).toBe(1);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("never reuses the original primary runtime epoch after a later restore", async () => {
    const database = databaseName();
    await create0029(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.beginTransaction();
      await stagePrimaryRuntimeActivation(conn);
      await activateJournalControl(conn);
      await conn.commit();

      await createSealedReplayRun(conn, "restore_run_new_epoch", "d".repeat(64),
        "e".repeat(64), 30);
      await conn.beginTransaction();
      await activateRestoreRuntime(conn, {
        restoreRunId: "restore_run_new_epoch",
        runtimeEpochSha256: "d".repeat(64),
        replayReceiptSha256: "e".repeat(64),
        controlGeneration: 2,
        previousControlEvidenceSha256: "c".repeat(64),
        evidenceSha256: "f".repeat(64),
        activatedAtDbMs: 32,
      });
      await conn.commit();

      // replay_runs alone does not know that the primary epoch was already consumed.
      await createSealedReplayRun(conn, "restore_run_reused_primary_epoch", "a".repeat(64),
        "0".repeat(64), 40);
      await conn.beginTransaction();
      await expect(activateRestoreRuntime(conn, {
        restoreRunId: "restore_run_reused_primary_epoch",
        runtimeEpochSha256: "a".repeat(64),
        replayReceiptSha256: "0".repeat(64),
        controlGeneration: 3,
        previousControlEvidenceSha256: "f".repeat(64),
        evidenceSha256: "1".repeat(64),
        activatedAtDbMs: 42,
      })).rejects.toThrow();
      await conn.rollback();

      const [state] = await conn.query<Row[]>(
        `SELECT c.control_generation,c.runtime_epoch_sha256,
                h.checkpoint_control_generation,h.runtime_epoch_sha256 AS head_epoch,
                (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS event_count
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id
          WHERE c.singleton_id=1 AND h.target_ordinal=0`,
      );
      expect(state[0]).toMatchObject({
        control_generation: 2,
        runtime_epoch_sha256: "d".repeat(64),
        checkpoint_control_generation: 2,
        head_epoch: "d".repeat(64),
        event_count: 2,
      });
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rolls back runtime heads and control when frozen 0029 T3a history blocks activation", async () => {
    const database = databaseName();
    await create0029(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await seedHistoricalT3aReceipt(conn);
      await upgrade(database);
      await conn.beginTransaction();
      await stagePrimaryRuntimeActivation(conn);
      await expect(activateJournalControl(conn)).rejects.toThrow(/activation is not permitted/);
      await conn.rollback();
      const [controls] = await conn.query<Row[]>(
        `SELECT
           (SELECT control_generation FROM tenant_restore_journal_control) AS journal_generation,
           (SELECT control_generation FROM tenant_restore_runtime_control) AS runtime_generation,
           (SELECT COUNT(*) FROM tenant_restore_runtime_heads) AS runtime_head_count,
           (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS runtime_event_count`,
      );
      expect(Number(controls[0]!.journal_generation)).toBe(0);
      expect(Number(controls[0]!.runtime_generation)).toBe(0);
      expect(Number(controls[0]!.runtime_head_count)).toBe(0);
      expect(Number(controls[0]!.runtime_event_count)).toBe(0);
      const [jobs] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_restore_journal_jobs",
      );
      expect(Number(jobs[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });
});
