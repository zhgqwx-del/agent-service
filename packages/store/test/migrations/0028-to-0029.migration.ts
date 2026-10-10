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
const MIGRATION_NAME = "0029_tenant_credential_target_execution.sql";

const FROZEN_0028_MIGRATIONS = [
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

describe("0028 -> 0029 tenant credential target execution migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0029Dir: string;
  let migrationSql: string;

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0029Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0029-"));
    for (const [file, expectedSha256] of FROZEN_0028_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0029Dir, file));
    }
    migrationSql = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0029Dir) await rm(pre0029Dir, { recursive: true, force: true });
  });

  async function create0028(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0029Dir,
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
       VALUES ('tenant-pre0029',1,'legacy_history_unknown','legacy_observed',?)`,
      ["1".repeat(64)],
    );
    await conn.query(
      `INSERT INTO tenant_credential_versions
         (credential_version_id,tenant_id,slot_kind,slot_id_sha256,origin,
          encrypted_secret_present,secret_key_id_present,custom_headers_present,
          endpoint_parameters_present,created_at_db_ms,evidence_sha256)
       VALUES (?, 'tenant-pre0029','provider_binding',?,'legacy_observed',
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
         VALUES (?, 'tenant-pre0029',?,?,1,?)`,
        ["2".repeat(64), domain, disposition, evidence],
      );
    }
  }

  it("upgrades a frozen 0028 database dormant and preserves old credential evidence", async () => {
    const database = databaseName();
    await create0028(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await seedOldCredentialEvidence(conn);
      const [before] = await conn.query<Row[]>(
        `SELECT domain,disposition,evidence_sha256
           FROM tenant_credential_target_dispositions
          WHERE tenant_id='tenant-pre0029' ORDER BY domain`,
      );
      await upgrade(database);
      const [after] = await conn.query<Row[]>(
        `SELECT domain,disposition,evidence_sha256
           FROM tenant_credential_target_dispositions
          WHERE tenant_id='tenant-pre0029' ORDER BY domain`,
      );
      expect(after).toEqual(before);

      const [control] = await conn.query<Row[]>(
        "SELECT * FROM tenant_credential_target_execution_cutover WHERE singleton_id=1",
      );
      expect(control[0]).toMatchObject({
        control_generation: 0,
        activated_at_db_ms: null,
        first_request_id: null,
        first_receipt_sha256: null,
        execution_protocol: null,
        external_credential_execution_enabled: null,
        kms_key_execution_enabled: null,
      });
      const [jobColumns] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE()
            AND table_name='tenant_credential_target_execution_jobs'
          ORDER BY ordinal_position`,
      );
      const columnNames = jobColumns.map((row) => String(row.column_name));
      expect(columnNames).toContain("target_execution_generation");
      expect(columnNames).toContain("external_credential_target_root_sha256");
      expect(columnNames).toContain("kms_key_executable_target_count");
      expect(columnNames).not.toContain("purge_plan_receipt_sha256");
      const [receiptColumns] = await conn.query<Row[]>(
        `SELECT COLUMN_NAME AS column_name
           FROM information_schema.columns
          WHERE table_schema=DATABASE()
            AND table_name='tenant_credential_target_execution_receipts'`,
      );
      expect(receiptColumns.map((row) => String(row.column_name))).toEqual(
        expect.arrayContaining([
          "target_ack_count",
          "adapter_evidence_count",
          "unresolved_blocker_count",
          "kms_key_execution_complete",
        ]),
      );
      for (const table of [
        "tenant_credential_target_execution_jobs",
        "tenant_credential_target_execution_targets",
        "tenant_credential_target_execution_acks",
        "tenant_credential_target_execution_receipts",
      ]) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), `${table} must stay dormant`).toBe(0);
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

  it("replays after marker loss, repairs an owned trigger, and remains dormant", async () => {
    const database = databaseName();
    await create0028(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query("DROP TRIGGER trg_target_exec_acks_bd");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await upgrade(database);
      const [triggers] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name LIKE 'trg\\_target\\_exec\\_%'`,
      );
      expect(Number(triggers[0]!.count)).toBe(11);
      const [control] = await conn.query<Row[]>(
        "SELECT control_generation FROM tenant_credential_target_execution_cutover",
      );
      expect(Number(control[0]!.control_generation)).toBe(0);
      const [jobs] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_credential_target_execution_jobs",
      );
      expect(Number(jobs[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects marker-loss replay when an unknown same-prefix trigger exists", async () => {
    const database = databaseName();
    await create0028(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TRIGGER trg_target_exec_unknown_bi
           BEFORE INSERT ON tenant_credential_target_execution_targets FOR EACH ROW
           SET @credential_target_exec_unknown = 1`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0029_tenant_credential_target_execution/);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
      const [unknown] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name='trg_target_exec_unknown_bi'`,
      );
      expect(Number(unknown[0]!.count)).toBe(1);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it.each([
    {
      name: "engine",
      weaken: "ALTER TABLE tenant_credential_target_execution_cutover ENGINE=MyISAM",
    },
    {
      name: "CHECK constraint",
      weaken: `ALTER TABLE tenant_credential_target_execution_jobs
                 DROP CHECK chk_credential_target_exec_job_counts`,
    },
    {
      name: "column type",
      weaken: `ALTER TABLE tenant_credential_target_execution_cutover
                 MODIFY execution_protocol VARCHAR(65)
                   COLLATE utf8mb4_0900_as_cs NULL`,
    },
    {
      name: "foreign key",
      weaken: `ALTER TABLE tenant_credential_target_execution_receipts
                 DROP FOREIGN KEY fk_credential_target_exec_receipt_job`,
    },
  ])("rejects marker-loss replay with a weakened $name", async ({ weaken }) => {
    const database = databaseName();
    await create0028(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(weaken);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expect(upgrade(database)).rejects.toThrow(/0029_tenant_credential_target_execution/);
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
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_credential_target_execution_")
        ? [index]
        : []
    ));
    expect(createIndexes).toHaveLength(5);
    for (const cutIndex of [createIndexes[0]!, createIndexes[2]!, createIndexes[4]!]) {
      const database = databaseName();
      await create0028(database);
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
          "SELECT control_generation FROM tenant_credential_target_execution_cutover",
        );
        expect(Number(control[0]!.control_generation), `cut ${cutIndex}`).toBe(0);
      } finally {
        await conn.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial control table without recording the marker", async () => {
    const database = databaseName();
    await create0028(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TABLE tenant_credential_target_execution_cutover
           (singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await expect(upgrade(database)).rejects.toThrow(/0029_tenant_credential_target_execution/);
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

  it("keeps the cutover write-once and append-only while inactive", async () => {
    const database = databaseName();
    await create0028(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await expect(conn.query(
        "UPDATE tenant_credential_target_execution_cutover SET control_generation=1 WHERE singleton_id=1",
      )).rejects.toThrow(/cutover transition is not permitted/);
      await expect(conn.query(
        "DELETE FROM tenant_credential_target_execution_cutover WHERE singleton_id=1",
      )).rejects.toThrow(/cutover cannot be deleted/);
      await expect(conn.query(
        `INSERT INTO tenant_credential_target_execution_cutover
           (singleton_id,control_generation) VALUES (2,0)`,
      )).rejects.toThrow(/cutover already exists/);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("keeps target ordinals zero-based and cannot represent KMS execution completion", async () => {
    const database = databaseName();
    await create0028(database);
    await upgrade(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query("SET FOREIGN_KEY_CHECKS=0");
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO tenant_credential_target_execution_targets
           (request_id,tenant_id,subject_generation,target_execution_generation,scope,
            target_ordinal,credential_version_id,domain,source_disposition,
            target_disposition_evidence_sha256,adapter_protocol,
            target_reference_cipher_sha256,target_reference_key_id,target_reference_sha256,
            operation_id_sha256,captured_at_db_ms,receipt_sha256)
         VALUES
           ('erase_00000000-0000-4000-8000-000000000029','tenant-contract',1,1,
            'tenant-credential-target-execution-target-v1',0,REPEAT('1',64),
            'external_credential','executable_ref',REPEAT('2',64),'provider-v1',
            REPEAT('3',64),'key-v1',REPEAT('4',64),REPEAT('5',64),0,REPEAT('6',64))`,
      );
      await expect(conn.query(
        `INSERT INTO tenant_credential_target_execution_targets
           (request_id,tenant_id,subject_generation,target_execution_generation,scope,
            target_ordinal,credential_version_id,domain,source_disposition,
            target_disposition_evidence_sha256,adapter_protocol,
            target_reference_cipher_sha256,target_reference_key_id,target_reference_sha256,
            operation_id_sha256,captured_at_db_ms,receipt_sha256)
         VALUES
           ('erase_00000000-0000-4000-8000-000000000030','tenant-contract',1,1,
            'tenant-credential-target-execution-target-v1',0,REPEAT('7',64),
            'kms_key','executable_ref',REPEAT('8',64),'kms-v1',
            REPEAT('9',64),'key-v1',REPEAT('a',64),REPEAT('b',64),0,REPEAT('c',64))`,
      )).rejects.toThrow();

      const insertReceipt = (requestId: string, kmsComplete: boolean) => conn.query(
        `INSERT INTO tenant_credential_target_execution_receipts
           (request_id,tenant_id,subject_generation,target_execution_generation,
            t3a_receipt_sha256,inventory_receipt_sha256,
            tracking_cutover_evidence_sha256,version_count,version_root_sha256,
            target_disposition_count,target_disposition_root_sha256,
            external_credential_target_count,external_credential_target_root_sha256,
            external_credential_blocker_count,kms_key_blocker_count,
            kms_key_executable_target_count,source_evidence_db_ms,scope,
            target_count,target_root_sha256,target_ack_count,target_ack_root_sha256,
            adapter_evidence_count,adapter_evidence_root_sha256,
            external_credential_execution_complete,kms_key_execution_complete,
            all_domains_complete,content_purge_executed,unresolved_blocker_count,
            completed_claim_attempt,completed_claim_token_sha256,
            store_db_timestamp_ms,receipt_sha256)
         VALUES
           (?,'tenant-contract',1,1,REPEAT('1',64),REPEAT('2',64),REPEAT('3',64),
            1,REPEAT('4',64),2,REPEAT('5',64),0,REPEAT('6',64),0,1,0,0,
            'tenant-credential-target-execution-v1',0,REPEAT('7',64),0,REPEAT('8',64),
            0,REPEAT('9',64),TRUE,?,FALSE,FALSE,1,1,REPEAT('a',64),0,REPEAT('b',64))`,
        [requestId, kmsComplete],
      );
      await insertReceipt("erase_00000000-0000-4000-8000-000000000031", false);
      await expect(insertReceipt(
        "erase_00000000-0000-4000-8000-000000000032",
        true,
      )).rejects.toThrow();
      await conn.rollback();
    } finally {
      await conn.query("SET FOREIGN_KEY_CHECKS=1");
      await conn.end();
      await cleanup(database);
    }
  });
});
