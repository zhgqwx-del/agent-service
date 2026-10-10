import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStorageControlConflictError,
  MysqlSessionStore,
} from "../../src/index.js";

const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../migrations");
const MIGRATION_NAME = "0027_blob_storage_control.sql";
const BACKEND = `s3v1-${"a".repeat(24)}`;
const NAMESPACE = "b".repeat(64);
const FROZEN_0026_MIGRATIONS = [
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

async function insertLegacyBlob(
  conn: Connection,
  suffix: string,
  storageBackend: string,
  state: "ready" | "deleted" = "ready",
): Promise<void> {
  await conn.query(
    `INSERT INTO blob_objects
       (blob_id,tenant_id,user_id,session_id,item_id,purpose,storage_backend,storage_format,
        storage_key,upload_token,state,deletion_generation,created_at_ms,deleted_at_ms)
     VALUES (?,?,?,?,NULL,'tool_output',?,?,?, ?,?,0,1,?)`,
    [
      `blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      `objects/${suffix}`,
      `upload-${suffix}`,
      state,
      state === "deleted" ? 2 : null,
    ],
  );
}

async function insertLegacyArtifact(conn: Connection, suffix: string, storageBackend: string): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_artifacts
       (artifact_id,request_id,tenant_id,user_id,subject_generation,build_generation,
        export_format,export_schema_version,content_type,content_encoding,storage_backend,
        storage_format,state,part_count,record_count,total_size_bytes,snapshot_root_sha256,
        policy_version,policy_sha256,artifact_ttl_ms,staging_expires_at_ms,deleted_at_ms,
        deletion_generation,created_at_ms,updated_at_ms)
     VALUES (?,?,?,?,1,1,'ndjson-v1',1,'application/x-ndjson','identity',?,?,'staging',
             0,0,0,?,'policy-v1',?,1000,2000,NULL,0,1,1)`,
    [
      `artifact-${suffix}`,
      `request-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      "c".repeat(64),
      "d".repeat(64),
    ],
  );
  await conn.query(
    `INSERT INTO user_export_artifact_parts
       (artifact_id,part_number,request_id,build_generation,tenant_id,user_id,
        subject_generation,state,storage_backend,storage_format,storage_key,upload_token,
        content_encoding,staging_expires_at_ms,deleted_at_ms,deletion_generation,
        created_at_ms,updated_at_ms)
     VALUES (?,0,?,1,?,?,1,'uploaded',?,?,?,?,'identity',2000,NULL,0,1,1)`,
    [
      `artifact-${suffix}`,
      `request-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      `data_exports/${suffix}`,
      `upload-${suffix}`,
    ],
  );
}

async function insertLegacySnapshot(
  conn: Connection,
  suffix: string,
  storageBackend: string,
  releasedAtMs: number | null,
): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_snapshot_blobs
       (request_id,build_generation,ordinal,blob_id,tenant_id,user_id,subject_generation,
        session_id,item_id,purpose,storage_backend,storage_format,storage_key,upload_token,
        source_deletion_generation,source_sha256,source_size_bytes,pin_token,pinned_at_ms,
        released_at_ms)
     VALUES (?,1,0,?,?,?,1,?,NULL,'tool_output',?,?,?,?,0,?,1,?,1,?)`,
    [
      `snapshot-request-${suffix}`,
      `snapshot-blob-${suffix}`,
      `tenant-${suffix}`,
      `user-${suffix}`,
      `session-${suffix}`,
      storageBackend,
      BLOB_STORAGE_FORMAT,
      `objects/snapshot-${suffix}`,
      `upload-snapshot-${suffix}`,
      "e".repeat(64),
      `pin-${suffix}`,
      releasedAtMs,
    ],
  );
}

describe("0026 -> 0027 Blob storage control migration", () => {
  let admin: Connection;
  let base: URL;
  let pre0027Dir: string;
  let through0027Dir: string;

  beforeAll(async () => {
    base = disposableBase(BASE_URL);
    const adminUrl = new URL(base);
    adminUrl.pathname = "/";
    admin = await mysql.createConnection(adminUrl.toString());
    pre0027Dir = await mkdtemp(join(tmpdir(), "agent-service-pre0027-"));
    through0027Dir = await mkdtemp(join(tmpdir(), "agent-service-through0027-"));
    // Keep this historical replay pinned at 0027: later migrations intentionally replace some
    // shared Blob-control triggers, so deleting an older marker from a newer schema is corruption,
    // not the partial-DDL recovery boundary this fixture proves.
    for (const [file, expectedSha256] of FROZEN_0026_MIGRATIONS) {
      const bytes = await readFile(join(MIGRATIONS_DIR, file));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expectedSha256);
      await copyFile(join(MIGRATIONS_DIR, file), join(pre0027Dir, file));
      await copyFile(join(MIGRATIONS_DIR, file), join(through0027Dir, file));
    }
    await copyFile(join(MIGRATIONS_DIR, MIGRATION_NAME), join(through0027Dir, MIGRATION_NAME));
  });

  afterAll(async () => {
    await admin?.end();
    if (pre0027Dir) await rm(pre0027Dir, { recursive: true, force: true });
    if (through0027Dir) await rm(through0027Dir, { recursive: true, force: true });
  });

  async function create0026(database: string): Promise<void> {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const store = await MysqlSessionStore.connect({
      url: databaseUrl(base, database),
      migrationsDir: pre0027Dir,
    });
    await store.close();
  }

  async function cleanup(database: string): Promise<void> {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }

  async function expectInstalled(conn: Connection): Promise<void> {
    const [markers] = await conn.query<Row[]>(
      "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
      [MIGRATION_NAME],
    );
    expect(Number(markers[0]!.count)).toBe(1);
    const [triggers] = await conn.query<Row[]>(
      `SELECT COUNT(*) AS count FROM information_schema.triggers
        WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_blob_storage\\_%'`,
    );
    expect(Number(triggers[0]!.count)).toBe(51);
  }

  it("preserves 0026 Blob/export state, activates safely, and survives marker-loss replay", async () => {
    const database = databaseName();
    await create0026(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    let store: MysqlSessionStore | undefined;
    try {
      await insertLegacyBlob(conn, "live", BACKEND);
      await insertLegacyBlob(conn, "pending-delete", BACKEND, "deleted");
      await insertLegacyArtifact(conn, "live", BACKEND);
      await insertLegacySnapshot(conn, "released", BACKEND, 2);
      await conn.query(
        `INSERT INTO blob_delete_outbox
           (blob_id,generation,available_at_ms,attempts,created_at_ms)
         VALUES ('blob-pending-delete',1,1,0,1)`,
      );
      await conn.query(
        `INSERT INTO user_export_artifact_delete_outbox
           (artifact_id,part_number,request_id,build_generation,deletion_generation,
            storage_backend,storage_format,storage_key,upload_token,available_at_ms,
            attempts,created_at_ms)
         VALUES ('artifact-delete',0,'request-delete',1,1,?,?,
                 'data_exports/delete','upload-delete',1,0,1)`,
        [BACKEND, BLOB_STORAGE_FORMAT],
      );

      store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0027Dir,
      });
      expect(await store.getBlobStorageControl()).toEqual({
        singletonId: 1,
        controlGeneration: 0,
      });
      const [snapshot] = await conn.query<Row[]>(
        `SELECT storage_backend,storage_namespace_sha256,released_at_ms
           FROM user_export_snapshot_blobs WHERE request_id='snapshot-request-released'`,
      );
      expect(snapshot[0]).toMatchObject({
        storage_backend: BACKEND,
        storage_namespace_sha256: null,
        released_at_ms: 2,
      });
      const [blobs] = await conn.query<Row[]>(
        `SELECT blob_id,storage_backend,storage_key,state FROM blob_objects ORDER BY blob_id`,
      );
      expect(blobs.map((row) => ({ ...row }))).toEqual([
        {
          blob_id: "blob-live",
          storage_backend: BACKEND,
          storage_key: "objects/live",
          state: "ready",
        },
        {
          blob_id: "blob-pending-delete",
          storage_backend: BACKEND,
          storage_key: "objects/pending-delete",
          state: "deleted",
        },
      ]);
      const [parts] = await conn.query<Row[]>(
        `SELECT artifact_id,storage_backend,storage_key,state
           FROM user_export_artifact_parts ORDER BY artifact_id,part_number`,
      );
      expect(parts[0]).toMatchObject({
        artifact_id: "artifact-live",
        storage_backend: BACKEND,
        storage_key: "data_exports/live",
        state: "uploaded",
      });
      const [deleteWork] = await conn.query<Row[]>(
        `SELECT artifact_id,storage_backend,storage_key,completed_at_ms,dead_lettered_at_ms
           FROM user_export_artifact_delete_outbox`,
      );
      expect(deleteWork[0]).toMatchObject({
        artifact_id: "artifact-delete",
        storage_backend: BACKEND,
        storage_key: "data_exports/delete",
        completed_at_ms: null,
        dead_lettered_at_ms: null,
      });
      for (const [table, count] of [
        ["blob_objects", 2],
        ["user_export_artifacts", 1],
        ["user_export_artifact_parts", 1],
        ["user_export_snapshot_blobs", 1],
        ["blob_delete_outbox", 1],
        ["user_export_artifact_delete_outbox", 1],
      ] as const) {
        const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
        expect(Number(rows[0]!.count), table).toBe(count);
      }

      const active = await store.activateBlobStorageControl({
        expectedControlGeneration: 0,
        storageBackend: BACKEND,
        namespaceSha256: NAMESPACE,
      });
      expect(active).toMatchObject({ controlGeneration: 1, storageBackend: BACKEND });
      await expect(insertLegacyBlob(conn, "wrong-after-active", "filesystem-v1"))
        .rejects.toThrow(/rejects backend/);

      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await store.migrate(through0027Dir);
      await expectInstalled(conn);
      expect(await store.getBlobStorageControl()).toEqual(active);
      const [preserved] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM user_export_artifact_delete_outbox",
      );
      expect(Number(preserved[0]!.count)).toBe(1);
    } finally {
      await store?.close();
      await conn.end();
      await cleanup(database);
    }
  });

  it("fails closed on conflicting legacy manifests, pins, and dead-letter delete work", async () => {
    const arrangements: Array<(conn: Connection) => Promise<void>> = [
      (conn) => insertLegacyBlob(conn, "foreign", "filesystem-v1"),
      (conn) => insertLegacySnapshot(conn, "unreleased", BACKEND, null),
      async (conn) => {
        await conn.query(
          `INSERT INTO user_export_artifact_delete_outbox
             (artifact_id,part_number,request_id,build_generation,deletion_generation,
              storage_backend,storage_format,storage_key,upload_token,available_at_ms,
              attempts,last_error,dead_lettered_at_ms,created_at_ms)
           VALUES ('legacy-dead-letter-export',0,'legacy-dead-letter-request',1,1,
                   'filesystem-v1',?,'data_exports/legacy-dead-letter',
                   'upload-legacy-dead-letter',1,1,'legacy retry exhausted',2,1)`,
          [BLOB_STORAGE_FORMAT],
        );
      },
    ];
    for (const arrange of arrangements) {
      const database = databaseName();
      await create0026(database);
      const conn = await mysql.createConnection(databaseUrl(base, database));
      let store: MysqlSessionStore | undefined;
      try {
        await arrange(conn);
        store = await MysqlSessionStore.connect({
          url: databaseUrl(base, database),
          migrationsDir: through0027Dir,
        });
        await expect(store.activateBlobStorageControl({
          expectedControlGeneration: 0,
          storageBackend: BACKEND,
          namespaceSha256: NAMESPACE,
        })).rejects.toBeInstanceOf(BlobStorageControlConflictError);
        const [control] = await conn.query<Row[]>(
          `SELECT control_generation,storage_backend,namespace_sha256,
                  activated_at_db_ms,evidence_sha256
             FROM blob_storage_control WHERE singleton_id=1`,
        );
        expect(control[0]).toMatchObject({
          control_generation: 0,
          storage_backend: null,
          namespace_sha256: null,
          activated_at_db_ms: null,
          evidence_sha256: null,
        });
      } finally {
        await store?.close();
        await conn.end();
        await cleanup(database);
      }
    }
  });

  it("converges after the first DDL auto-commit boundary without a migration marker", async () => {
    const database = databaseName();
    await create0026(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    let store: MysqlSessionStore | undefined;
    try {
      const migration = await readFile(join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8");
      const createStart = migration.indexOf("CREATE TABLE IF NOT EXISTS blob_storage_control (");
      const createEnd = migration.indexOf(";", createStart);
      expect(createStart).toBeGreaterThanOrEqual(0);
      expect(createEnd).toBeGreaterThan(createStart);
      await conn.query(migration.slice(createStart, createEnd + 1));

      const [before] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(before[0]!.count)).toBe(0);
      store = await MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0027Dir,
      });
      await expectInstalled(conn);
      expect(await store.getBlobStorageControl()).toEqual({
        singletonId: 1,
        controlGeneration: 0,
      });
      const [column] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='user_export_snapshot_blobs'
            AND column_name='storage_namespace_sha256'`,
      );
      expect(Number(column[0]!.count)).toBe(1);
    } finally {
      await store?.close();
      await conn.end();
      await cleanup(database);
    }
  });

  it("rejects a weaker same-name control table without recording the migration marker", async () => {
    const database = databaseName();
    await create0026(database);
    const conn = await mysql.createConnection(databaseUrl(base, database));
    try {
      await conn.query(
        `CREATE TABLE blob_storage_control (
           singleton_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
           control_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
           storage_backend VARCHAR(32) COLLATE utf8mb4_0900_as_cs NULL,
           namespace_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL,
           activated_at_db_ms BIGINT NULL,
           evidence_sha256 CHAR(64) COLLATE utf8mb4_0900_as_cs NULL
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );
      await expect(MysqlSessionStore.connect({
        url: databaseUrl(base, database),
        migrationsDir: through0027Dir,
      }))
        .rejects.toThrow(/migration 0027_blob_storage_control\.sql failed/);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?",
        [MIGRATION_NAME],
      );
      expect(Number(markers[0]!.count)).toBe(0);
      const [triggers] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS count FROM information_schema.triggers
          WHERE trigger_schema=DATABASE() AND trigger_name LIKE 'trg_blob_storage\\_%'`,
      );
      expect(Number(triggers[0]!.count)).toBe(0);
    } finally {
      await conn.end();
      await cleanup(database);
    }
  });
});
