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
const MIGRATION_NAME = "0033_tenant_telemetry_activation_inventory.sql";
const MIGRATION_SHA256 = "8bb2f9c7f2a287ea15c40906c9e877f462d6d67deae76f7e0748b9e0954c2a98";
const EMPTY_HOLD_ROOT = "d336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f";

const FROZEN_0032_MIGRATIONS = [
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
  ["0031_authoritative_backup_catalog.sql", "c3122ebbbed285c97e096ae751cfbe1107e9cd535405bd1585bb348f557f94c0"],
  ["0032_tenant_telemetry_lifecycle.sql", "cce4794c74ed4cee7e0b7d57a4e90c44abc0f078e26a70b6c558e40ab3fba4a9"],
] as const;

const TELEMETRY_TABLES = [
  "tenant_telemetry_activation_receipts",
  "tenant_telemetry_artifact_inventory",
  "tenant_telemetry_lifecycle_control",
  "tenant_telemetry_lifecycle_coverages",
  "tenant_telemetry_lifecycle_subjects",
  "tenant_telemetry_lifecycle_targets",
] as const;

const EXPECTED_TRIGGERS = [
  "trg_tenant_telemetry_activation_bd",
  "trg_tenant_telemetry_activation_bi",
  "trg_tenant_telemetry_activation_bu",
  "trg_tenant_telemetry_artifact_bd",
  "trg_tenant_telemetry_artifact_bi",
  "trg_tenant_telemetry_artifact_bu",
  "trg_tenant_telemetry_control_bd",
  "trg_tenant_telemetry_control_bi",
  "trg_tenant_telemetry_control_bu",
  "trg_tenant_telemetry_coverages_bd",
  "trg_tenant_telemetry_coverages_bi",
  "trg_tenant_telemetry_coverages_bu",
  "trg_tenant_telemetry_subjects_bd",
  "trg_tenant_telemetry_subjects_bi",
  "trg_tenant_telemetry_subjects_bu",
  "trg_tenant_telemetry_targets_bd",
  "trg_tenant_telemetry_targets_bi",
  "trg_tenant_telemetry_targets_bu",
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
  return sql.replace(/^\s*--.*$/gm, "").split(/;\s*\n/)
    .map((value) => value.trim()).filter(Boolean);
}

describe("0032 -> 0033 tenant telemetry activation/inventory migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0033Dir: string;
  let through0033Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0033Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0033-"));
    through0033Dir = await mkdtemp(join(tmpdir(), "agent-service-through0033-"));
    for (const [file, expectedSha256] of FROZEN_0032_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0033Dir, file));
      await copyFile(join(MIGRATIONS_DIR, file), join(through0033Dir, file));
    }
    const migrationBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME));
    expect(createHash("sha256").update(migrationBytes).digest("hex"), MIGRATION_NAME)
      .toBe(MIGRATION_SHA256);
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0033Dir, MIGRATION_NAME));
    migrationSql = migrationBytes.toString("utf8");
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0033Dir) await rm(pre0033Dir, { recursive: true, force: true });
    if (through0033Dir) await rm(through0033Dir, { recursive: true, force: true });
  });

  async function create0032(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0033Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    disposableDatabases.delete(database);
  }

  async function upgrade(database: string): Promise<void> {
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: through0033Dir,
    });
    await store.close();
  }

  async function seedLegacyTenant(conn: Connection): Promise<void> {
    await conn.query(
      "INSERT INTO tenants (tenant_id,name,created_at_ms) VALUES ('tenant-pre0033','pre-0033',32)",
    );
    await conn.query(
      `INSERT INTO subject_lifecycle
         (tenant_id,subject_kind,subject_id,state,generation,active_request_id,
          legal_hold_at_ms,created_at_ms,updated_at_ms)
       VALUES ('tenant-pre0033','tenant','tenant-pre0033','active',0,NULL,NULL,32,32)`,
    );
    await conn.query(
      `INSERT INTO retention_policy_controls
         (tenant_id,control_generation,active_policy_version,active_policy_sha256,
          effective_at_ms,updated_at_ms)
       VALUES ('tenant-pre0033',0,NULL,NULL,NULL,32)`,
    );
    await conn.query(
      `INSERT INTO legal_hold_controls
         (tenant_id,subject_kind,subject_id,control_generation,active_hold_count,
          active_projection_sha256,updated_at_ms)
       VALUES ('tenant-pre0033','tenant','tenant-pre0033',0,0,?,32)`,
      [EMPTY_HOLD_ROOT],
    );
  }

  async function assertDormant(conn: Connection): Promise<void> {
    const [control] = await conn.query<Row[]>(
      "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
    );
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({ control_generation: 0, activated_at_db_ms: null });
    for (const table of TELEMETRY_TABLES.filter((table) => (
      table !== "tenant_telemetry_lifecycle_control"
    ))) {
      const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]!.count), `${table} must stay empty`).toBe(0);
    }
  }

  async function assertSchemaAndTriggers(conn: Connection): Promise<void> {
    const [tables] = await conn.query<Row[]>(
      `SELECT table_name AS name,engine AS engine_value,
              table_collation AS collation_value
         FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name IN (${TELEMETRY_TABLES.map(() => "?").join(",")})
        ORDER BY table_name`,
      [...TELEMETRY_TABLES],
    );
    expect(tables.map((row) => row.name)).toEqual([...TELEMETRY_TABLES]);
    expect(tables.every((row) => row.engine_value === "InnoDB"
      && row.collation_value === "utf8mb4_0900_as_cs")).toBe(true);
    const [shape] = await conn.query<Row[]>(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema=DATABASE() AND table_name IN (${TELEMETRY_TABLES.map(() => "?").join(",")})) AS columns_count,
         (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE() AND table_name IN (${TELEMETRY_TABLES.map(() => "?").join(",")})) AS index_columns_count,
         (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND constraint_type='CHECK'
             AND table_name IN (${TELEMETRY_TABLES.map(() => "?").join(",")})) AS checks_count`,
      [...TELEMETRY_TABLES, ...TELEMETRY_TABLES, ...TELEMETRY_TABLES],
    );
    expect(shape[0]).toMatchObject({
      columns_count: 90,
      index_columns_count: 56,
      checks_count: 7,
    });
    const [triggers] = await conn.query<Row[]>(
      `SELECT trigger_name AS name FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg\\_tenant\\_telemetry\\_%'
        ORDER BY trigger_name`,
    );
    expect(triggers.map((row) => row.name)).toEqual([...EXPECTED_TRIGGERS]);
  }

  it("preserves a frozen 0032 database and installs an exact dormant schema", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0032(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyTenant(conn);
      const [before] = await conn.query<Row[]>(
        "SELECT * FROM subject_lifecycle WHERE tenant_id='tenant-pre0033'",
      );
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [after] = await conn.query<Row[]>(
        "SELECT * FROM subject_lifecycle WHERE tenant_id='tenant-pre0033'",
      );
      expect(after).toEqual(before);
      await assertDormant(conn);
      await assertSchemaAndTriggers(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("converges from both CREATE TABLE auto-commit boundaries", async () => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_") ? [index] : []
    ));
    expect(createIndexes).toHaveLength(2);
    for (const cutIndex of createIndexes) {
      const database = databaseName();
      let conn: Connection | undefined;
      try {
        await create0032(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
        await conn.end();
        conn = undefined;
        await upgrade(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        await assertDormant(conn);
        await assertSchemaAndTriggers(conn);
      } finally {
        await conn?.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial table without recording the marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0032(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TABLE tenant_telemetry_activation_receipts
           (singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(/0033_tenant_telemetry_activation_inventory/);
      conn = await mysql.createConnection(databaseUrl(base, database));
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("blocks an unreceipted pre-0033 active control instead of inventing provenance", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0032(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `INSERT INTO tenant_telemetry_lifecycle_targets
           (singleton_id,control_generation,domain,target_ordinal,scope,backend_kind,
            adapter_protocol,namespace_sha256,failure_domain_sha256,target_sha256,
            created_at_db_ms,receipt_sha256)
         VALUES
           (1,1,'logs',0,'tenant-telemetry-lifecycle-target-v1','legacy','legacy-v1',
            REPEAT('1',64),REPEAT('2',64),REPEAT('3',64),40,REPEAT('4',64)),
           (1,1,'traces',1,'tenant-telemetry-lifecycle-target-v1','legacy','legacy-v1',
            REPEAT('a',64),REPEAT('b',64),REPEAT('c',64),40,REPEAT('d',64))`,
      );
      await conn.query(
        `UPDATE tenant_telemetry_lifecycle_control
            SET control_generation=1,activated_at_db_ms=40,
                lifecycle_protocol='tenant-telemetry-lifecycle-v1',
                writer_protocol='structured-telemetry-v1',ref_key_id_sha256=REPEAT('e',64),
                target_count=2,target_root_sha256=REPEAT('6',64),
                activation_evidence_sha256=REPEAT('f',64)
          WHERE singleton_id=1`,
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(/0033_tenant_telemetry_activation_inventory/);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_activation_receipts
           (singleton_id,control_generation,scope,request_sha256,ref_key_id_sha256,
            target_count,target_root_sha256,coverage_count,coverage_root_sha256,
            control_evidence_sha256,activated_at_db_ms,receipt_sha256)
         VALUES (1,1,'tenant-telemetry-lifecycle-activation-v1',REPEAT('a',64),
                 REPEAT('e',64),2,REPEAT('6',64),0,REPEAT('8',64),REPEAT('f',64),
                 40,REPEAT('9',64))`,
      )).rejects.toThrow(/activation receipt is not complete/);
      const [state] = await conn.query<Row[]>(
        `SELECT
           (SELECT control_generation FROM tenant_telemetry_lifecycle_control
             WHERE singleton_id=1) AS control_generation,
           (SELECT COUNT(*) FROM tenant_telemetry_activation_receipts) AS receipt_count,
           (SELECT COUNT(*) FROM schema_migrations WHERE name=?) AS marker_count`,
        [MIGRATION_NAME],
      );
      expect(state[0]).toMatchObject({
        control_generation: 1,
        receipt_count: 0,
        marker_count: 0,
      });
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(/0033_tenant_telemetry_activation_inventory/);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("repairs an owned trigger after marker loss without activation or backfill", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0032(database);
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_tenant_telemetry_artifact_bi");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertDormant(conn);
      await assertSchemaAndTriggers(conn);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("requires a complete activation receipt and keeps receipt/inventory evidence append-only", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0032(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyTenant(conn);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `INSERT INTO tenant_telemetry_lifecycle_targets
           (singleton_id,control_generation,domain,target_ordinal,scope,backend_kind,
            adapter_protocol,namespace_sha256,failure_domain_sha256,target_sha256,
            created_at_db_ms,receipt_sha256)
         VALUES
           (1,1,'logs',0,'tenant-telemetry-lifecycle-target-v1','fixture','fixture-v1',
            REPEAT('1',64),REPEAT('2',64),REPEAT('3',64),100,REPEAT('4',64)),
           (1,1,'traces',1,'tenant-telemetry-lifecycle-target-v1','fixture','fixture-v1',
            REPEAT('a',64),REPEAT('b',64),REPEAT('c',64),100,REPEAT('d',64))`,
      );
      await conn.query(
        `INSERT INTO tenant_telemetry_lifecycle_coverages
           (tenant_id,control_generation,scope,history_status,subject_ref_sha256,
            target_count,target_root_sha256,coverage_started_at_db_ms,evidence_sha256)
         VALUES ('tenant-pre0033',1,'tenant-telemetry-lifecycle-coverage-v1',
                 'legacy_history_unknown',REPEAT('5',64),2,REPEAT('6',64),100,
                 REPEAT('7',64))`,
      );
      await expect(conn.query(
        `UPDATE tenant_telemetry_lifecycle_control
            SET control_generation=1,activated_at_db_ms=100,
                lifecycle_protocol='tenant-telemetry-lifecycle-v1',
                writer_protocol='structured-telemetry-v1',ref_key_id_sha256=REPEAT('e',64),
                target_count=2,target_root_sha256=REPEAT('6',64),
                activation_evidence_sha256=REPEAT('f',64)
          WHERE singleton_id=1`,
      )).rejects.toThrow(/not receipt-bound/);
      await conn.query(
        `INSERT INTO tenant_telemetry_activation_receipts
           (singleton_id,control_generation,scope,request_sha256,ref_key_id_sha256,
            target_count,target_root_sha256,coverage_count,coverage_root_sha256,
            control_evidence_sha256,activated_at_db_ms,receipt_sha256)
         VALUES (1,1,'tenant-telemetry-lifecycle-activation-v1',REPEAT('a',64),
                 REPEAT('e',64),2,REPEAT('6',64),1,REPEAT('8',64),REPEAT('f',64),
                 100,REPEAT('9',64))`,
      );
      await conn.query(
        `UPDATE tenant_telemetry_lifecycle_control
            SET control_generation=1,activated_at_db_ms=100,
                lifecycle_protocol='tenant-telemetry-lifecycle-v1',
                writer_protocol='structured-telemetry-v1',ref_key_id_sha256=REPEAT('e',64),
                target_count=2,target_root_sha256=REPEAT('6',64),
                activation_evidence_sha256=REPEAT('f',64)
          WHERE singleton_id=1`,
      );
      await conn.query(
        `INSERT INTO tenant_telemetry_artifact_inventory
           (inventory_sha256,tenant_id,control_generation,scope,domain,target_sha256,
            artifact_id_sha256,artifact_generation,owner_kind,tenant_ref_sha256,
            owner_ref_sha256,hold_subject_ref_sha256,coverage_evidence_sha256,history_status,
            writer_protocol,writer_generation,source_schema,source_generation,
            source_high_water_db_ms,payload_sha256,manifest_sha256,retention_class,
            retention_policy_control_generation,retention_policy_sha256,dispose_after_db_ms,
            tenant_hold_control_generation,tenant_hold_projection_sha256,
            owner_hold_control_generation,owner_hold_projection_sha256,
            restore_control_generation,restore_lineage_kind,restore_updated_at_db_ms,
            runtime_epoch_sha256,created_at_db_ms,receipt_sha256)
         VALUES (REPEAT('0',64),'tenant-pre0033',1,'tenant-telemetry-artifact-inventory-v1',
                 'logs',REPEAT('3',64),REPEAT('1',64),1,'tenant',REPEAT('5',64),
                 REPEAT('5',64),REPEAT('5',64),REPEAT('7',64),'legacy_history_unknown',
                 'structured-telemetry-v1',1,'fixture-v1',0,100,REPEAT('a',64),
                 REPEAT('b',64),'telemetry_policy_unconfigured',0,NULL,NULL,0,?,0,?,
                 0,'inactive',0,NULL,100,REPEAT('c',64))`,
        [EMPTY_HOLD_ROOT, EMPTY_HOLD_ROOT],
      );

      await expect(conn.query(
        "UPDATE tenant_telemetry_activation_receipts SET activated_at_db_ms=101 WHERE singleton_id=1",
      )).rejects.toThrow(/activation receipt is immutable/);
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_activation_receipts WHERE singleton_id=1",
      )).rejects.toThrow(/activation receipt is append-only/);
      await expect(conn.query(
        "UPDATE tenant_telemetry_artifact_inventory SET created_at_db_ms=101",
      )).rejects.toThrow(/artifact inventory is immutable/);
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_artifact_inventory",
      )).rejects.toThrow(/artifact inventory is append-only/);
      await expect(conn.query(
        `INSERT INTO tenant_telemetry_artifact_inventory
           (inventory_sha256,tenant_id,control_generation,scope,domain,target_sha256,
            artifact_id_sha256,artifact_generation,owner_kind,tenant_ref_sha256,
            owner_ref_sha256,hold_subject_ref_sha256,coverage_evidence_sha256,history_status,
            writer_protocol,writer_generation,source_schema,source_generation,
            source_high_water_db_ms,payload_sha256,manifest_sha256,retention_class,
            retention_policy_control_generation,retention_policy_sha256,dispose_after_db_ms,
            tenant_hold_control_generation,tenant_hold_projection_sha256,
            owner_hold_control_generation,owner_hold_projection_sha256,
            restore_control_generation,restore_lineage_kind,restore_updated_at_db_ms,
            runtime_epoch_sha256,created_at_db_ms,receipt_sha256)
         VALUES (REPEAT('d',64),'tenant-pre0033',1,'tenant-telemetry-artifact-inventory-v1',
                 'logs',REPEAT('3',64),REPEAT('1',64),1,'user',REPEAT('5',64),
                 REPEAT('e',64),REPEAT('e',64),REPEAT('7',64),'legacy_history_unknown',
                 'structured-telemetry-v1',1,'fixture-v1',0,100,REPEAT('a',64),
                 REPEAT('b',64),'telemetry_policy_unconfigured',0,NULL,NULL,0,?,0,?,
                 0,'inactive',0,NULL,100,REPEAT('f',64))`,
        [EMPTY_HOLD_ROOT, EMPTY_HOLD_ROOT],
      )).rejects.toThrow();
      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_activation_receipts) AS receipt_count,
           (SELECT COUNT(*) FROM tenant_telemetry_artifact_inventory) AS artifact_count`,
      );
      expect(counts[0]).toMatchObject({ receipt_count: 1, artifact_count: 1 });
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });
});
