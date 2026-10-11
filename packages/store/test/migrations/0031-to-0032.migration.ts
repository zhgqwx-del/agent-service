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
const MIGRATION_NAME = "0032_tenant_telemetry_lifecycle.sql";
const MIGRATION_SHA256 = "cce4794c74ed4cee7e0b7d57a4e90c44abc0f078e26a70b6c558e40ab3fba4a9";

const FROZEN_0031_MIGRATIONS = [
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
] as const;

const NEW_TABLES = [
  "tenant_telemetry_lifecycle_control",
  "tenant_telemetry_lifecycle_targets",
  "tenant_telemetry_lifecycle_coverages",
  "tenant_telemetry_lifecycle_subjects",
] as const;

const EXPECTED_TRIGGERS = [
  ["trg_tenant_telemetry_control_bd", "tenant_telemetry_lifecycle_control", "DELETE"],
  ["trg_tenant_telemetry_control_bi", "tenant_telemetry_lifecycle_control", "INSERT"],
  ["trg_tenant_telemetry_control_bu", "tenant_telemetry_lifecycle_control", "UPDATE"],
  ["trg_tenant_telemetry_coverages_bd", "tenant_telemetry_lifecycle_coverages", "DELETE"],
  ["trg_tenant_telemetry_coverages_bu", "tenant_telemetry_lifecycle_coverages", "UPDATE"],
  ["trg_tenant_telemetry_subjects_bd", "tenant_telemetry_lifecycle_subjects", "DELETE"],
  ["trg_tenant_telemetry_subjects_bi", "tenant_telemetry_lifecycle_subjects", "INSERT"],
  ["trg_tenant_telemetry_subjects_bu", "tenant_telemetry_lifecycle_subjects", "UPDATE"],
  ["trg_tenant_telemetry_targets_bd", "tenant_telemetry_lifecycle_targets", "DELETE"],
  ["trg_tenant_telemetry_targets_bu", "tenant_telemetry_lifecycle_targets", "UPDATE"],
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

describe("0031 -> 0032 tenant telemetry lifecycle migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0032Dir: string;
  let through0032Dir: string;
  let migrationSql: string;
  const disposableDatabases = new Set<string>();

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0032Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0032-"));
    through0032Dir = await mkdtemp(join(tmpdir(), "agent-service-through0032-"));
    for (const [file, expectedSha256] of FROZEN_0031_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0032Dir, file));
      await copyFile(join(MIGRATIONS_DIR, file), join(through0032Dir, file));
    }
    const migrationBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME));
    expect(createHash("sha256").update(migrationBytes).digest("hex"), MIGRATION_NAME)
      .toBe(MIGRATION_SHA256);
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0032Dir, MIGRATION_NAME));
    migrationSql = migrationBytes.toString("utf8");
  });

  afterAll(async () => {
    if (admin) {
      for (const database of disposableDatabases) {
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await admin.end();
    }
    if (pre0032Dir) await rm(pre0032Dir, { recursive: true, force: true });
    if (through0032Dir) await rm(through0032Dir, { recursive: true, force: true });
  });

  async function create0031(database: string): Promise<void> {
    disposableDatabases.add(database);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0032Dir,
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
      migrationsDir: through0032Dir,
    });
    await store.close();
  }

  async function seedLegacyRows(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenants (tenant_id,name,created_at_ms)
       VALUES ('tenant-pre0032','pre-0032 tenant',32)`,
    );
    await conn.query(
      `INSERT INTO tenant_erasure_admissions
         (request_id,tenant_id,subject_generation,requested_by_key_id,idempotency_key,
          request_hash,created_at_ms,gated_at_ms,updated_at_ms,policy_version,policy_hash,
          control_generation)
       VALUES ('erase_00000000-0000-4000-8000-000000000032','tenant-pre0032',1,
               'key-pre0032','idem-pre0032',REPEAT('a',64),32,33,33,NULL,NULL,0)`,
    );
    await conn.query(
      `INSERT INTO tenant_credential_revocation_fences
       (tenant_id,request_id,subject_generation,fenced_at_ms,evidence_sha256)
       VALUES ('tenant-pre0032','erase_00000000-0000-4000-8000-000000000032',1,
               33,REPEAT('8',64))`,
    );
  }

  async function seedActiveTelemetryAuthority(conn: Connection): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_telemetry_lifecycle_targets
         (singleton_id,control_generation,domain,target_ordinal,scope,backend_kind,
          adapter_protocol,namespace_sha256,failure_domain_sha256,target_sha256,
          created_at_db_ms,receipt_sha256)
       VALUES
         (1,1,'logs',0,'tenant-telemetry-lifecycle-target-v1','fixture','fixture-v1',
          REPEAT('1',64),REPEAT('2',64),REPEAT('3',64),32,REPEAT('4',64)),
         (1,1,'traces',1,'tenant-telemetry-lifecycle-target-v1','fixture','fixture-v1',
          REPEAT('a',64),REPEAT('b',64),REPEAT('c',64),33,REPEAT('d',64))`,
    );
    await conn.query(
      `UPDATE tenant_telemetry_lifecycle_control
          SET control_generation=1,activated_at_db_ms=34,
              lifecycle_protocol='tenant-telemetry-lifecycle-v1',
              writer_protocol='structured-telemetry-v1',ref_key_id_sha256=REPEAT('e',64),
              target_count=2,target_root_sha256=REPEAT('6',64),
              activation_evidence_sha256=REPEAT('f',64)
        WHERE singleton_id=1`,
    );
    await conn.query(
      `INSERT INTO tenant_telemetry_lifecycle_coverages
         (tenant_id,control_generation,scope,history_status,subject_ref_sha256,
          target_count,target_root_sha256,coverage_started_at_db_ms,evidence_sha256)
       VALUES ('tenant-pre0032',1,'tenant-telemetry-lifecycle-coverage-v1',
               'legacy_history_unknown',REPEAT('5',64),2,REPEAT('6',64),35,
               REPEAT('7',64))`,
    );
  }

  async function insertTelemetrySubject(
    conn: Connection,
    overrides: Partial<{
      requestId: string;
      tenantId: string;
      subjectGeneration: number;
      t1FenceSha256: string;
      coverageEvidenceSha256: string;
      historyStatus: string;
      subjectRefSha256: string;
      targetCount: number;
      targetRootSha256: string;
      boundAtDbMs: number;
      receiptSha256: string;
    }> = {},
  ): Promise<void> {
    await conn.query(
      `INSERT INTO tenant_telemetry_lifecycle_subjects
         (request_id,tenant_id,subject_generation,control_generation,scope,t1_fence_sha256,
          coverage_evidence_sha256,history_status,subject_ref_sha256,target_count,
          target_root_sha256,bound_at_db_ms,receipt_sha256)
       VALUES (?,?,?,1,'tenant-telemetry-lifecycle-subject-v1',?,?,?,?,?,?,?,?)`,
      [
        overrides.requestId ?? "erase_00000000-0000-4000-8000-000000000032",
        overrides.tenantId ?? "tenant-pre0032",
        overrides.subjectGeneration ?? 1,
        overrides.t1FenceSha256 ?? "8".repeat(64),
        overrides.coverageEvidenceSha256 ?? "7".repeat(64),
        overrides.historyStatus ?? "legacy_history_unknown",
        overrides.subjectRefSha256 ?? "5".repeat(64),
        overrides.targetCount ?? 2,
        overrides.targetRootSha256 ?? "6".repeat(64),
        overrides.boundAtDbMs ?? 36,
        overrides.receiptSha256 ?? "9".repeat(64),
      ],
    );
  }

  async function assertDormantAndEmpty(conn: Connection): Promise<void> {
    const [control] = await conn.query<Row[]>(
      "SELECT * FROM tenant_telemetry_lifecycle_control WHERE singleton_id=1",
    );
    expect(control).toHaveLength(1);
    expect(control[0]).toMatchObject({
      singleton_id: 1,
      control_generation: 0,
      activated_at_db_ms: null,
      lifecycle_protocol: null,
      writer_protocol: null,
      ref_key_id_sha256: null,
      target_count: null,
      target_root_sha256: null,
      activation_evidence_sha256: null,
    });
    for (const table of NEW_TABLES.slice(1)) {
      const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
      expect(Number(rows[0]!.count), `${table} must stay empty`).toBe(0);
    }
  }

  async function assertSchemaAndTriggers(conn: Connection): Promise<void> {
    const [tables] = await conn.query<Row[]>(
      `SELECT table_name AS table_name_value,engine AS engine_value,
              table_collation AS table_collation_value
         FROM information_schema.tables
        WHERE table_schema=DATABASE() AND table_name LIKE 'tenant\\_telemetry\\_lifecycle\\_%'
        ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name_value)).toEqual([...NEW_TABLES].sort());
    expect(tables.every((row) => row.engine_value === "InnoDB"
      && row.table_collation_value === "utf8mb4_0900_as_cs")).toBe(true);

    const [shape] = await conn.query<Row[]>(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema=DATABASE()
             AND table_name LIKE 'tenant\\_telemetry\\_lifecycle\\_%') AS column_count,
         (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema=DATABASE()
             AND table_name LIKE 'tenant\\_telemetry\\_lifecycle\\_%') AS index_column_count,
         (SELECT COUNT(*) FROM information_schema.table_constraints
           WHERE table_schema=DATABASE() AND constraint_type='CHECK'
             AND table_name LIKE 'tenant\\_telemetry\\_lifecycle\\_%') AS check_count,
         (SELECT COUNT(*) FROM information_schema.referential_constraints
           WHERE constraint_schema=DATABASE()
             AND table_name LIKE 'tenant\\_telemetry\\_lifecycle\\_%') AS foreign_key_count`,
    );
    expect(shape[0]).toMatchObject({
      column_count: 43,
      index_column_count: 31,
      check_count: 5,
      foreign_key_count: 3,
    });

    const [triggers] = await conn.query<Row[]>(
      `SELECT trigger_name AS trigger_name_value,
              event_object_table AS event_object_table_value,
              event_manipulation AS event_manipulation_value
         FROM information_schema.triggers
        WHERE trigger_schema=DATABASE()
          AND trigger_name LIKE 'trg\\_tenant\\_telemetry\\_%'
        ORDER BY trigger_name`,
    );
    expect(triggers.map((row) => [
      row.trigger_name_value,
      row.event_object_table_value,
      row.event_manipulation_value,
    ])).toEqual(EXPECTED_TRIGGERS);
  }

  it("preserves 0031 rows and installs a dormant, empty, exact schema", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0031(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyRows(conn);
      const [tenantBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenants WHERE tenant_id='tenant-pre0032'",
      );
      const [admissionBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_erasure_admissions WHERE tenant_id='tenant-pre0032'",
      );
      const [fenceBefore] = await conn.query<Row[]>(
        "SELECT * FROM tenant_credential_revocation_fences WHERE tenant_id='tenant-pre0032'",
      );
      const [catalogBefore] = await conn.query<Row[]>(
        "SELECT * FROM backup_catalog_control WHERE singleton_id=1",
      );

      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));

      const [tenantAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenants WHERE tenant_id='tenant-pre0032'",
      );
      const [admissionAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_erasure_admissions WHERE tenant_id='tenant-pre0032'",
      );
      const [fenceAfter] = await conn.query<Row[]>(
        "SELECT * FROM tenant_credential_revocation_fences WHERE tenant_id='tenant-pre0032'",
      );
      const [catalogAfter] = await conn.query<Row[]>(
        "SELECT * FROM backup_catalog_control WHERE singleton_id=1",
      );
      expect(tenantAfter).toEqual(tenantBefore);
      expect(admissionAfter).toEqual(admissionBefore);
      expect(fenceAfter).toEqual(fenceBefore);
      expect(catalogAfter).toEqual(catalogBefore);
      await assertDormantAndEmpty(conn);
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

  it("converges from first, middle, and last CREATE TABLE auto-commit boundaries", async () => {
    const all = statements(migrationSql);
    const createIndexes = all.flatMap((statement, index) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS tenant_telemetry_lifecycle_") ? [index] : []
    ));
    expect(createIndexes).toHaveLength(4);
    for (const cutIndex of [createIndexes[0]!, createIndexes[1]!, createIndexes[3]!]) {
      const database = databaseName();
      let conn: Connection | undefined;
      try {
        await create0031(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        for (const statement of all.slice(0, cutIndex + 1)) await conn.query(statement);
        await conn.end();
        conn = undefined;
        await upgrade(database);
        conn = await mysql.createConnection(databaseUrl(base, database));
        await assertDormantAndEmpty(conn);
        await assertSchemaAndTriggers(conn);
        const [marker] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
          [MIGRATION_NAME],
        );
        expect(Number(marker[0]!.count), `cut ${cutIndex}`).toBe(1);
      } finally {
        await conn?.end();
        await cleanup(database);
      }
    }
  });

  it("rejects an incompatible partial first table without recording the marker", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0031(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query(
        `CREATE TABLE tenant_telemetry_lifecycle_control
           (singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await conn.end();
      conn = undefined;
      await expect(upgrade(database)).rejects.toThrow(/0032_tenant_telemetry_lifecycle/);
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

  it("repairs an owned trigger after marker loss without activating or backfilling", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0031(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyRows(conn);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await conn.query("DROP TRIGGER trg_tenant_telemetry_subjects_bi");
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.end();
      conn = undefined;

      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await assertDormantAndEmpty(conn);
      await assertSchemaAndTriggers(conn);
      const [legacy] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenants WHERE tenant_id='tenant-pre0032') AS tenant_count,
           (SELECT COUNT(*) FROM tenant_erasure_admissions
             WHERE tenant_id='tenant-pre0032') AS admission_count`,
      );
      expect(legacy[0]).toMatchObject({ tenant_count: 1, admission_count: 1 });
      await expect(insertTelemetrySubject(conn)).rejects.toThrow(/not active-source-bound/);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("keeps target, coverage, and subject evidence append-only", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0031(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyRows(conn);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));

      await seedActiveTelemetryAuthority(conn);
      await insertTelemetrySubject(conn);

      await expect(conn.query(
        "UPDATE tenant_telemetry_lifecycle_targets SET created_at_db_ms=33 WHERE domain='logs'",
      )).rejects.toThrow(/target is immutable/);
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_lifecycle_targets WHERE domain='logs'",
      )).rejects.toThrow(/target is append-only/);
      await expect(conn.query(
        `UPDATE tenant_telemetry_lifecycle_coverages
            SET coverage_started_at_db_ms=33 WHERE tenant_id='tenant-pre0032'`,
      )).rejects.toThrow(/coverage is immutable/);
      await expect(conn.query(
        "DELETE FROM tenant_telemetry_lifecycle_coverages WHERE tenant_id='tenant-pre0032'",
      )).rejects.toThrow(/coverage is append-only/);
      await expect(conn.query(
        `UPDATE tenant_telemetry_lifecycle_subjects
            SET bound_at_db_ms=34
          WHERE request_id='erase_00000000-0000-4000-8000-000000000032'`,
      )).rejects.toThrow(/subject is immutable/);
      await expect(conn.query(
        `DELETE FROM tenant_telemetry_lifecycle_subjects
          WHERE request_id='erase_00000000-0000-4000-8000-000000000032'`,
      )).rejects.toThrow(/subject is append-only/);

      const [counts] = await conn.query<Row[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_targets) AS target_count,
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_coverages) AS coverage_count,
           (SELECT COUNT(*) FROM tenant_telemetry_lifecycle_subjects) AS subject_count`,
      );
      expect(counts[0]).toMatchObject({ target_count: 2, coverage_count: 1, subject_count: 1 });
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });

  it("binds a subject to the exact admission, T1 fence, coverage, and active control", async () => {
    const database = databaseName();
    let conn: Connection | undefined;
    try {
      await create0031(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedLegacyRows(conn);
      await conn.end();
      conn = undefined;
      await upgrade(database);
      conn = await mysql.createConnection(databaseUrl(base, database));
      await seedActiveTelemetryAuthority(conn);
      await conn.query(
        `INSERT INTO tenant_telemetry_lifecycle_coverages
           (tenant_id,control_generation,scope,history_status,subject_ref_sha256,
            target_count,target_root_sha256,coverage_started_at_db_ms,evidence_sha256)
         VALUES ('tenant-other',1,'tenant-telemetry-lifecycle-coverage-v1',
                 'legacy_history_unknown',REPEAT('a',64),2,REPEAT('6',64),35,
                 REPEAT('b',64))`,
      );
      await conn.query(
        `INSERT INTO tenants (tenant_id,name,created_at_ms) VALUES
           ('tenant-bad-time','bad T1 time fixture',32),
           ('tenant-bad-control','bad T1 control fixture',32)`,
      );
      await conn.query(
        `INSERT INTO tenant_erasure_admissions
           (request_id,tenant_id,subject_generation,requested_by_key_id,idempotency_key,
            request_hash,created_at_ms,gated_at_ms,updated_at_ms,policy_version,policy_hash,
            control_generation)
         VALUES
           ('erase_00000000-0000-4000-8000-000000000033','tenant-bad-time',1,
            'key-bad-time','idem-bad-time',REPEAT('c',64),32,33,33,NULL,NULL,0),
           ('erase_00000000-0000-4000-8000-000000000034','tenant-bad-control',1,
            'key-bad-control','idem-bad-control',REPEAT('d',64),32,33,33,NULL,NULL,1)`,
      );
      await conn.query(
        `INSERT INTO tenant_credential_revocation_fences
           (tenant_id,request_id,subject_generation,fenced_at_ms,evidence_sha256)
         VALUES
           ('tenant-bad-time','erase_00000000-0000-4000-8000-000000000033',1,34,
            REPEAT('c',64)),
           ('tenant-bad-control','erase_00000000-0000-4000-8000-000000000034',1,33,
            REPEAT('d',64))`,
      );
      await conn.query(
        `INSERT INTO tenant_telemetry_lifecycle_coverages
           (tenant_id,control_generation,scope,history_status,subject_ref_sha256,
            target_count,target_root_sha256,coverage_started_at_db_ms,evidence_sha256)
         VALUES
           ('tenant-bad-time',1,'tenant-telemetry-lifecycle-coverage-v1',
            'legacy_history_unknown',REPEAT('c',64),2,REPEAT('6',64),35,REPEAT('d',64)),
           ('tenant-bad-control',1,'tenant-telemetry-lifecycle-coverage-v1',
            'legacy_history_unknown',REPEAT('e',64),2,REPEAT('6',64),35,REPEAT('f',64))`,
      );

      await expect(insertTelemetrySubject(conn, {
        tenantId: "tenant-other",
        coverageEvidenceSha256: "b".repeat(64),
        subjectRefSha256: "a".repeat(64),
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        subjectGeneration: 2,
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        t1FenceSha256: "0".repeat(64),
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        historyStatus: "complete_since_creation",
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        boundAtDbMs: 34,
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000033",
        tenantId: "tenant-bad-time",
        t1FenceSha256: "c".repeat(64),
        coverageEvidenceSha256: "d".repeat(64),
        subjectRefSha256: "c".repeat(64),
      })).rejects.toThrow(/not active-source-bound/);
      await expect(insertTelemetrySubject(conn, {
        requestId: "erase_00000000-0000-4000-8000-000000000034",
        tenantId: "tenant-bad-control",
        t1FenceSha256: "d".repeat(64),
        coverageEvidenceSha256: "f".repeat(64),
        subjectRefSha256: "e".repeat(64),
      })).rejects.toThrow(/not active-source-bound/);

      const [before] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
      );
      expect(Number(before[0]!.count)).toBe(0);
      await insertTelemetrySubject(conn);
      const [after] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenant_telemetry_lifecycle_subjects",
      );
      expect(Number(after[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await cleanup(database);
    }
  });
});
