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
const MIGRATION_NAME = "0026_credential_lifecycle_inventory.sql";
const FROZEN_0025_MIGRATIONS = [
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

async function expectReject(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}

describe("0025 -> 0026 credential lifecycle migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0026Dir: string;

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0026Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0026-"));
    for (const [file, expectedSha256] of FROZEN_0025_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0026Dir, file));
    }
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0026Dir) await rm(pre0026Dir, { recursive: true, force: true });
  });

  async function create0025(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0026Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }

  it("is dormant, preserves legacy sources, and replays after marker loss", async () => {
    const database = databaseName();
    await create0025(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `INSERT INTO tenants
           (tenant_id,name,created_at_ms,auth_policy,auth_secret_cipher,auth_secret_key_id)
         VALUES ('tenant-pre0026','legacy',1,'{"mode":"hs256"}',X'0102','legacy-key')`,
      );
      await conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,secret_cipher,secret_key_id,created_at_ms,updated_at_ms)
         VALUES ('tenant-pre0026','provider-pre0026','{"type":"openai-compatible"}',
                 X'0304','legacy-key',1,1)`,
      );

      const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
      const [cutover] = await conn.query<Row[]>(
        "SELECT * FROM tenant_credential_tracking_cutover WHERE singleton_id=1",
      );
      expect(Number(cutover[0]!.control_generation)).toBe(0);
      for (const table of [
        "tenant_credential_tracking_subjects",
        "tenant_credential_provider_slots",
        "tenant_credential_versions",
        "tenant_credential_target_dispositions",
        "tenant_credential_inventory_receipts",
      ]) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), table).toBe(0);
      }
      const [provider] = await conn.query<Row[]>(
        `SELECT credential_slot_id_sha256,credential_write_generation,credential_version_id
           FROM provider_configs WHERE tenant_id='tenant-pre0026'`,
      );
      expect(provider[0]).toMatchObject({
        credential_slot_id_sha256: null,
        credential_write_generation: null,
        credential_version_id: null,
      });
      const [tenant] = await conn.query<Row[]>(
        `SELECT auth_write_generation,auth_credential_version_id,
                auth_credential_updated_at_db_ms
           FROM tenants WHERE tenant_id='tenant-pre0026'`,
      );
      expect(Number(tenant[0]!.auth_write_generation)).toBe(0);
      expect(tenant[0]!.auth_credential_version_id).toBeNull();
      expect(Number(tenant[0]!.auth_credential_updated_at_db_ms)).toBe(0);

      // Inactive expand remains compatible with the old writer.
      await conn.query(
        `UPDATE provider_configs SET updated_at_ms=2
          WHERE tenant_id='tenant-pre0026' AND provider_id='provider-pre0026'`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await store.migrate(MIGRATIONS_DIR);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(1);
      const [bootstrap] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name LIKE '%\\_bootstrap'
            AND (trigger_name LIKE 'trg_credential\\_%'
              OR trigger_name LIKE 'trg_provider_credential\\_%'
              OR trigger_name LIKE 'trg_tenant_auth_credential\\_%')`,
      );
      expect(Number(bootstrap[0]!.count)).toBe(19);
      const [guardA] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name LIKE '%\\_guard_a'
            AND (trigger_name LIKE 'trg_credential\\_%'
              OR trigger_name LIKE 'trg_provider_credential\\_%'
              OR trigger_name LIKE 'trg_tenant_auth_credential\\_%')`,
      );
      expect(Number(guardA[0]!.count)).toBe(19);
      const [allCredentialTriggers] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND (trigger_name LIKE 'trg_credential\\_%'
              OR trigger_name LIKE 'trg_provider_credential\\_%'
              OR trigger_name LIKE 'trg_tenant_auth_credential\\_%')`,
      );
      expect(Number(allCredentialTriggers[0]!.count)).toBe(57);
      await store.close();
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });

  it("allows an active-cutover queued T3a claim without evaluating receipt collations", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `UPDATE tenant_credential_tracking_cutover
            SET control_generation=1,activated_at_db_ms=1,
                subject_count=0,subject_root_sha256=?,provider_slot_count=0,
                provider_slot_root_sha256=?,auth_slot_count=0,auth_slot_root_sha256=?,
                version_count=0,version_root_sha256=?,target_disposition_count=0,
                target_disposition_root_sha256=?,evidence_sha256=?
          WHERE singleton_id=1`,
        ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64),
          "5".repeat(64), "6".repeat(64)],
      );
      await conn.query(
        `INSERT INTO tenant_credential_revocation_jobs
           (request_id,tenant_id,subject_generation,t1_fence_sha256,phase,
            available_at_ms,attempts,created_at_ms,updated_at_ms)
         VALUES ('request-queued-0026','tenant-queued-0026',1,?,'queued',10,0,10,10)`,
        ["a".repeat(64)],
      );
      await conn.query(
        `UPDATE tenant_credential_revocation_jobs
            SET attempts=1,claim_token='claim-0026',lease_until_ms=100,updated_at_ms=11
          WHERE request_id='request-queued-0026'`,
      );
      const [rows] = await conn.query<Row[]>(
        `SELECT phase,attempts,claim_token,lease_until_ms
           FROM tenant_credential_revocation_jobs
          WHERE request_id='request-queued-0026'`,
      );
      expect(rows[0]).toMatchObject({
        phase: "queued",
        attempts: 1,
        claim_token: "claim-0026",
        lease_until_ms: 100,
      });
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("uses a locking cutover read instead of a stale repeatable-read snapshot", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const oldWriter = await mysql.createConnection(databaseUrl(base, database));
    const activator = await mysql.createConnection(databaseUrl(base, database));
    try {
      await oldWriter.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await oldWriter.beginTransaction();
      const [before] = await oldWriter.query<Row[]>(
        `SELECT control_generation FROM tenant_credential_tracking_cutover
          WHERE singleton_id=1`,
      );
      expect(Number(before[0]!.control_generation)).toBe(0);

      await activator.query(
        `UPDATE tenant_credential_tracking_cutover
            SET control_generation=1,activated_at_db_ms=1,
                subject_count=0,subject_root_sha256=?,provider_slot_count=0,
                provider_slot_root_sha256=?,auth_slot_count=0,auth_slot_root_sha256=?,
                version_count=0,version_root_sha256=?,target_disposition_count=0,
                target_disposition_root_sha256=?,evidence_sha256=?
          WHERE singleton_id=1`,
        ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64),
          "5".repeat(64), "6".repeat(64)],
      );
      const [stale] = await oldWriter.query<Row[]>(
        `SELECT control_generation FROM tenant_credential_tracking_cutover
          WHERE singleton_id=1`,
      );
      expect(Number(stale[0]!.control_generation)).toBe(0);

      await expectReject(oldWriter.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES ('tenant-stale-provider','provider-old','{}',1,1)`,
      ), /untracked provider insert/);
      await expectReject(oldWriter.query(
        `INSERT INTO tenants
           (tenant_id,name,created_at_ms,auth_policy,auth_secret_cipher,auth_secret_key_id)
         VALUES ('tenant-stale-auth','legacy',1,'{"mode":"hs256"}',X'01','old-key')`,
      ), /untracked auth insert/);
      await oldWriter.rollback();

      const [providerRows] = await activator.query<Row[]>(
        "SELECT COUNT(*) AS count FROM provider_configs WHERE tenant_id='tenant-stale-provider'",
      );
      const [tenantRows] = await activator.query<Row[]>(
        "SELECT COUNT(*) AS count FROM tenants WHERE tenant_id='tenant-stale-auth'",
      );
      expect(Number(providerRows[0]!.count)).toBe(0);
      expect(Number(tenantRows[0]!.count)).toBe(0);
    } finally {
      await oldWriter.rollback();
      await oldWriter.end();
      await activator.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("rejects a weakened same-name CHECK constraint before recording a replay marker", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        "ALTER TABLE tenant_credential_versions DROP CHECK chk_credential_version_material",
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expectReject(
        store.migrate(MIGRATIONS_DIR),
        /0026_credential_lifecycle_inventory\.sql failed/,
      );
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("rejects a retired credential version without a retirement reason", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `INSERT INTO tenant_credential_tracking_subjects
           (tenant_id,tracking_started_at_db_ms,history_status,origin,evidence_sha256)
         VALUES ('tenant-invalid-retirement',1,'complete_since_creation','managed_v1',?)`,
        ["a".repeat(64)],
      );
      await expectReject(conn.query(
        `INSERT INTO tenant_credential_versions
           (credential_version_id,tenant_id,slot_kind,slot_id_sha256,origin,
            encrypted_secret_present,secret_key_id_present,custom_headers_present,
            endpoint_parameters_present,created_at_db_ms,retired_at_db_ms,retire_reason,
            evidence_sha256)
         VALUES (?,'tenant-invalid-retirement','provider_binding',?,'managed_v1',
                 FALSE,FALSE,TRUE,FALSE,1,2,NULL,?)`,
        ["b".repeat(64), "c".repeat(64), "d".repeat(64)],
      ), /chk_credential_version_retirement/);
      const [versions] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM tenant_credential_versions
          WHERE tenant_id='tenant-invalid-retirement'`,
      );
      expect(Number(versions[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("rejects a same-name foreign key with a weakened delete rule", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        "ALTER TABLE provider_configs DROP FOREIGN KEY fk_provider_config_credential_slot",
      );
      await conn.query(
        `ALTER TABLE provider_configs
           ADD CONSTRAINT fk_provider_config_credential_slot
           FOREIGN KEY (tenant_id,credential_slot_id_sha256)
           REFERENCES tenant_credential_provider_slots (tenant_id,slot_id_sha256)
           ON UPDATE RESTRICT ON DELETE CASCADE`,
      );
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await expectReject(
        store.migrate(MIGRATIONS_DIR),
        /0026_credential_lifecycle_inventory\.sql failed/,
      );
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
      const [constraints] = await conn.query<Row[]>(
        `SELECT delete_rule FROM information_schema.referential_constraints
          WHERE constraint_schema=DATABASE() AND table_name='provider_configs'
            AND constraint_name='fk_provider_config_credential_slot'`,
      );
      expect(String(constraints[0]!.delete_rule ?? constraints[0]!.DELETE_RULE)).toBe("CASCADE");
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("remains fail-closed and repairs a same-name trigger body on marker-loss replay", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `UPDATE tenant_credential_tracking_cutover
            SET control_generation=1,activated_at_db_ms=1,
                subject_count=0,subject_root_sha256=?,provider_slot_count=0,
                provider_slot_root_sha256=?,auth_slot_count=0,auth_slot_root_sha256=?,
                version_count=0,version_root_sha256=?,target_disposition_count=0,
                target_disposition_root_sha256=?,evidence_sha256=?
          WHERE singleton_id=1`,
        ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64),
          "5".repeat(64), "6".repeat(64)],
      );
      await conn.query("DROP TRIGGER trg_provider_credential_bi");
      await conn.query(
        `CREATE TRIGGER trg_provider_credential_bi BEFORE INSERT ON provider_configs
           FOR EACH ROW SET NEW.updated_at_ms=NEW.updated_at_ms`,
      );
      await expectReject(conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES ('tenant-tampered-trigger-before','provider-old','{}',1,1)`,
      ), /untracked provider insert/);

      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await store.migrate(MIGRATIONS_DIR);
      const [canonical] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE()
            AND trigger_name IN ('trg_provider_credential_bi_bootstrap',
                                 'trg_provider_credential_bi',
                                 'trg_provider_credential_bi_guard_a')
            AND action_statement LIKE '%active credential cutover rejects untracked provider insert%'`,
      );
      expect(Number(canonical[0]!.count)).toBe(3);
      await expectReject(conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES ('tenant-tampered-trigger-after','provider-old','{}',1,1)`,
      ), /untracked provider insert/);
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("keeps an active source guard at each marker-loss trigger rotation boundary", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    const rejectOldProvider = async (tenant: string): Promise<void> => {
      await expectReject(conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES (?,'provider-old','{}',1,1)`,
        [tenant],
      ), /untracked provider insert/);
    };
    try {
      await conn.query(
        `UPDATE tenant_credential_tracking_cutover
            SET control_generation=1,activated_at_db_ms=1,
                subject_count=0,subject_root_sha256=?,provider_slot_count=0,
                provider_slot_root_sha256=?,auth_slot_count=0,auth_slot_root_sha256=?,
                version_count=0,version_root_sha256=?,target_disposition_count=0,
                target_disposition_root_sha256=?,evidence_sha256=?
          WHERE singleton_id=1`,
        ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64),
          "5".repeat(64), "6".repeat(64)],
      );
      for (const [trigger, tenant] of [
        ["trg_provider_credential_bi_bootstrap", "tenant-boundary-bootstrap-drop"],
        ["trg_provider_credential_bi", "tenant-boundary-final-drop"],
        ["trg_provider_credential_bi_guard_a", "tenant-boundary-guard-drop"],
      ] as const) {
        await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
        await conn.query(`DROP TRIGGER IF EXISTS \`${trigger}\``);
        await rejectOldProvider(tenant);

        // A restart replays the complete migration from the exact DDL auto-commit boundary.
        await store.migrate(MIGRATIONS_DIR);
        const [markers] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
        );
        expect(Number(markers[0]!.count), trigger).toBe(1);
        const [guards] = await conn.query<Row[]>(
          `SELECT COUNT(*) AS count FROM information_schema.triggers
            WHERE trigger_schema=DATABASE()
              AND trigger_name IN ('trg_provider_credential_bi_bootstrap',
                                   'trg_provider_credential_bi',
                                   'trg_provider_credential_bi_guard_a')`,
        );
        expect(Number(guards[0]!.count), trigger).toBe(3);
      }
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("keeps active cutover write-once and rejects the old provider/auth writers after replay", async () => {
    const database = databaseName();
    await create0025(database);
    const store = await MysqlSessionStore.connect({ url: databaseUrl(base, database) });
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `UPDATE tenant_credential_tracking_cutover
            SET control_generation=1,activated_at_db_ms=1,
                subject_count=0,subject_root_sha256=?,provider_slot_count=0,
                provider_slot_root_sha256=?,auth_slot_count=0,auth_slot_root_sha256=?,
                version_count=0,version_root_sha256=?,target_disposition_count=0,
                target_disposition_root_sha256=?,evidence_sha256=?
          WHERE singleton_id=1`,
        ["1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64),
          "5".repeat(64), "6".repeat(64)],
      );
      await expectReject(conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES ('tenant-old-writer','provider-old','{}',1,1)`,
      ), /untracked provider insert/);
      await expectReject(conn.query(
        `INSERT INTO tenants
           (tenant_id,name,created_at_ms,auth_policy,auth_secret_cipher,auth_secret_key_id)
         VALUES ('tenant-old-writer','legacy',1,'{"mode":"hs256"}',X'01','old-key')`,
      ), /untracked auth insert/);
      await expectReject(conn.query(
        "UPDATE tenant_credential_tracking_cutover SET activated_at_db_ms=2 WHERE singleton_id=1",
      ), /write-once/);

      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await store.migrate(MIGRATIONS_DIR);
      const [cutover] = await conn.query<Row[]>(
        "SELECT control_generation,activated_at_db_ms FROM tenant_credential_tracking_cutover",
      );
      expect(Number(cutover[0]!.control_generation)).toBe(1);
      expect(Number(cutover[0]!.activated_at_db_ms)).toBe(1);
      await expectReject(conn.query(
        `INSERT INTO provider_configs
           (tenant_id,provider_id,config,created_at_ms,updated_at_ms)
         VALUES ('tenant-after-replay','provider-old','{}',1,1)`,
      ), /untracked provider insert/);

      // Replay must also reinstall the immutable ledger and monotonic CAS guards.
      await conn.query(
        `INSERT INTO tenant_credential_tracking_subjects
           (tenant_id,tracking_started_at_db_ms,history_status,origin,evidence_sha256)
         VALUES ('tenant-ledger',2,'complete_since_creation','managed_v1',?)`,
        ["a".repeat(64)],
      );
      await conn.query(
        `INSERT INTO tenant_credential_versions
           (credential_version_id,tenant_id,slot_kind,slot_id_sha256,origin,
            encrypted_secret_present,secret_key_id_present,custom_headers_present,
            endpoint_parameters_present,created_at_db_ms,evidence_sha256)
         VALUES (?,'tenant-ledger','provider_binding',?,'managed_v1',
                 FALSE,FALSE,TRUE,FALSE,2,?)`,
        ["b".repeat(64), "c".repeat(64), "d".repeat(64)],
      );
      await conn.query(
        `INSERT INTO tenant_credential_target_dispositions
           (credential_version_id,tenant_id,domain,disposition,captured_at_db_ms,evidence_sha256)
         VALUES (?,'tenant-ledger','external_credential','blocked_no_locator',2,?),
                (?,'tenant-ledger','kms_key','not_applicable',2,?)`,
        ["b".repeat(64), "e".repeat(64), "b".repeat(64), "f".repeat(64)],
      );
      await conn.query(
        `INSERT INTO tenant_credential_provider_slots
           (tenant_id,slot_id_sha256,write_generation,source_present,
            current_credential_version_id,updated_at_db_ms,evidence_sha256)
         VALUES ('tenant-ledger',?,1,FALSE,NULL,2,?)`,
        ["c".repeat(64), "0".repeat(64)],
      );
      await expectReject(conn.query(
        "UPDATE tenant_credential_tracking_subjects SET tracking_started_at_db_ms=3 WHERE tenant_id='tenant-ledger'",
      ), /subjects are immutable/);
      await expectReject(conn.query(
        `UPDATE tenant_credential_target_dispositions SET captured_at_db_ms=3
          WHERE credential_version_id=? AND domain='external_credential'`,
        ["b".repeat(64)],
      ), /dispositions are immutable/);
      await expectReject(conn.query(
        `UPDATE tenant_credential_provider_slots
            SET write_generation=3,updated_at_db_ms=3,evidence_sha256=?
          WHERE tenant_id='tenant-ledger' AND slot_id_sha256=?`,
        ["1".repeat(64), "c".repeat(64)],
      ), /advance exactly once/);
      await conn.query(
        `UPDATE tenant_credential_provider_slots
            SET write_generation=2,updated_at_db_ms=3,evidence_sha256=?
          WHERE tenant_id='tenant-ledger' AND slot_id_sha256=?`,
        ["1".repeat(64), "c".repeat(64)],
      );
      await expectReject(conn.query(
        `DELETE FROM tenant_credential_provider_slots
          WHERE tenant_id='tenant-ledger' AND slot_id_sha256=?`,
        ["c".repeat(64)],
      ), /slots are permanent/);
      await conn.query(
        `UPDATE tenant_credential_versions
            SET retired_at_db_ms=3,retire_reason='deleted',evidence_sha256=?
          WHERE credential_version_id=?`,
        ["2".repeat(64), "b".repeat(64)],
      );
      await expectReject(conn.query(
        `UPDATE tenant_credential_versions
            SET retired_at_db_ms=4,retire_reason='tenant_erasure',evidence_sha256=?
          WHERE credential_version_id=?`,
        ["3".repeat(64), "b".repeat(64)],
      ), /except one retirement/);
      await expectReject(conn.query(
        "DELETE FROM tenant_credential_versions WHERE credential_version_id=?",
        ["b".repeat(64)],
      ), /versions cannot be deleted/);
    } finally {
      await conn.end();
      await store.close();
      await cleanup(database);
    }
  });

  it("fails closed on an incompatible partial column and never records the marker", async () => {
    const database = databaseName();
    await create0025(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        "ALTER TABLE provider_configs ADD COLUMN credential_slot_id_sha256 VARCHAR(63) NULL",
      );
      await expectReject(
        MysqlSessionStore.connect({ url: databaseUrl(base, database) }),
        /0026_credential_lifecycle_inventory\.sql failed/,
      );
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
      const [column] = await conn.query<Row[]>(
        `SELECT column_type FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='provider_configs'
            AND column_name='credential_slot_id_sha256'`,
      );
      expect(String(column[0]!.column_type ?? column[0]!.COLUMN_TYPE)).toBe("varchar(63)");
      await expectReject(
        MysqlSessionStore.connect({ url: databaseUrl(base, database) }),
        /0026_credential_lifecycle_inventory\.sql failed/,
      );
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });
});
