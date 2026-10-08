import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0016.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0017_user_export_jobs_and_artifacts.sql");

type Row = RowDataPacket;

const MIGRATION_0017_TABLES = [
  "user_export_requests",
  "user_export_jobs",
  "user_export_artifacts",
  "user_export_artifact_parts",
  "user_export_artifact_delete_outbox",
  "user_export_snapshot_records",
  "user_export_snapshot_blobs",
  "user_export_download_leases",
] as const;

const FROZEN_0016_MIGRATIONS = [
  "0001_init.sql",
  "0002_auto_approved.sql",
  "0003_tenant_auth.sql",
  "0004_compaction.sql",
  "0005_api_key_scopes.sql",
  "0006_id_collation.sql",
  "0007_strict_ids_and_idempotency_scope.sql",
  "0008_atomic_turn_writes.sql",
  "0009_session_tombstone_outbox.sql",
  "0010_blob_ownership.sql",
  "0011_erasure_and_usage_separation.sql",
  "0012_erasure_job_queue.sql",
  "0013_erasure_job_control.sql",
  "0014_legacy_tombstone_compensation.sql",
  "0015_retention_policy_and_legal_holds.sql",
  "0016_erasure_purge_policy_authority.sql",
] as const;

const EXPECTED_COLUMNS: Record<(typeof MIGRATION_0017_TABLES)[number], string[]> = {
  user_export_requests: [
    "request_id", "tenant_id", "user_id", "subject_generation", "requested_by_key_id",
    "idempotency_key_sha256", "request_sha256", "export_format", "export_schema_version",
    "policy_version", "policy_sha256", "artifact_ttl_ms", "status",
    "active_build_generation", "active_artifact_id", "last_error_code", "created_at_ms",
    "updated_at_ms", "snapshot_at_ms", "ready_at_ms", "expires_at_ms", "revoked_at_ms",
  ],
  user_export_jobs: [
    "request_id", "tenant_id", "user_id", "subject_generation", "build_generation", "status",
    "active_artifact_id", "available_at_ms", "attempts", "claim_token", "lease_until_ms",
    "last_error_code", "snapshot_at_ms", "snapshot_record_count", "snapshot_blob_count",
    "snapshot_root_sha256", "snapshot_sealed_at_ms", "created_at_ms", "updated_at_ms",
    "completed_at_ms",
  ],
  user_export_artifacts: [
    "artifact_id", "request_id", "tenant_id", "user_id", "subject_generation",
    "build_generation", "export_format", "export_schema_version", "content_type",
    "content_encoding", "storage_backend", "storage_format", "state", "part_count",
    "record_count", "total_size_bytes",
    "manifest_sha256", "content_sha256", "snapshot_root_sha256", "policy_version",
    "policy_sha256", "artifact_ttl_ms", "snapshot_at_ms", "staging_expires_at_ms", "ready_at_ms",
    "expires_at_ms", "delete_after_ms", "deleted_at_ms", "deletion_generation",
    "created_at_ms", "updated_at_ms",
  ],
  user_export_artifact_parts: [
    "artifact_id", "part_number", "request_id", "build_generation", "tenant_id", "user_id",
    "subject_generation", "state", "storage_backend", "storage_format", "storage_key",
    "upload_token", "content_type", "content_encoding", "sha256", "size_bytes",
    "record_count", "staging_expires_at_ms", "uploaded_at_ms", "delete_after_ms",
    "deleted_at_ms", "deletion_generation", "created_at_ms", "updated_at_ms",
  ],
  user_export_artifact_delete_outbox: [
    "outbox_id", "artifact_id", "part_number", "request_id", "build_generation",
    "deletion_generation", "storage_backend", "storage_format", "storage_key", "upload_token",
    "expected_sha256", "expected_size_bytes", "available_at_ms", "attempts", "claim_token",
    "lease_until_ms", "last_error", "completed_at_ms", "dead_lettered_at_ms", "created_at_ms",
  ],
  user_export_snapshot_records: [
    "request_id", "build_generation", "ordinal", "tenant_id", "user_id",
    "subject_generation", "record_kind", "logical_key", "canonical_utf8_bytes",
    "record_sha256", "size_bytes", "captured_at_ms",
  ],
  user_export_snapshot_blobs: [
    "request_id", "build_generation", "ordinal", "blob_id", "tenant_id", "user_id",
    "subject_generation", "session_id", "item_id", "purpose", "storage_backend",
    "storage_format", "storage_key", "upload_token", "source_deletion_generation",
    "source_sha256", "source_size_bytes", "source_content_type", "pin_token",
    "pinned_at_ms", "released_at_ms",
  ],
  user_export_download_leases: [
    "artifact_id", "lease_token", "tenant_id", "user_id", "request_id",
    "build_generation", "artifact_deletion_generation", "lease_until_ms", "created_at_ms",
    "updated_at_ms",
  ],
};

const EXPECTED_INDEXES: Record<
  (typeof MIGRATION_0017_TABLES)[number],
  Record<string, { columns: string[]; unique: boolean }>
> = {
  user_export_requests: {
    PRIMARY: { columns: ["request_id"], unique: true },
    idx_user_export_requests_owner: {
      columns: ["tenant_id", "user_id", "created_at_ms", "request_id"], unique: false,
    },
    idx_user_export_requests_status: {
      columns: ["status", "updated_at_ms", "request_id"], unique: false,
    },
    uk_user_export_requests_active_artifact: { columns: ["active_artifact_id"], unique: true },
    uk_user_export_requests_idempotency: {
      columns: ["tenant_id", "user_id", "idempotency_key_sha256"], unique: true,
    },
  },
  user_export_jobs: {
    PRIMARY: { columns: ["request_id"], unique: true },
    idx_user_export_jobs_claim: {
      columns: ["status", "available_at_ms", "lease_until_ms", "request_id"], unique: false,
    },
    idx_user_export_jobs_owner: { columns: ["tenant_id", "user_id", "request_id"], unique: false },
    uk_user_export_jobs_active_artifact: { columns: ["active_artifact_id"], unique: true },
  },
  user_export_artifacts: {
    PRIMARY: { columns: ["artifact_id"], unique: true },
    idx_user_export_artifacts_expiry: {
      columns: ["state", "expires_at_ms", "artifact_id"], unique: false,
    },
    idx_user_export_artifacts_owner: {
      columns: ["tenant_id", "user_id", "state", "artifact_id"], unique: false,
    },
    idx_user_export_artifacts_staging: {
      columns: ["state", "staging_expires_at_ms", "artifact_id"], unique: false,
    },
    uk_user_export_artifacts_build: { columns: ["request_id", "build_generation"], unique: true },
  },
  user_export_artifact_parts: {
    PRIMARY: { columns: ["artifact_id", "part_number"], unique: true },
    idx_user_export_parts_delete: {
      columns: ["state", "delete_after_ms", "artifact_id", "part_number"], unique: false,
    },
    idx_user_export_parts_owner: {
      columns: ["tenant_id", "user_id", "artifact_id", "part_number"], unique: false,
    },
    idx_user_export_parts_staging: {
      columns: ["state", "staging_expires_at_ms", "artifact_id", "part_number"], unique: false,
    },
    uk_user_export_parts_build: {
      columns: ["request_id", "build_generation", "part_number"], unique: true,
    },
    uk_user_export_parts_storage_key: { columns: ["storage_key"], unique: true },
  },
  user_export_artifact_delete_outbox: {
    PRIMARY: { columns: ["outbox_id"], unique: true },
    idx_user_export_delete_claim: {
      columns: ["completed_at_ms", "dead_lettered_at_ms", "available_at_ms", "outbox_id", "lease_until_ms"],
      unique: false,
    },
    idx_user_export_delete_request: {
      columns: ["request_id", "build_generation", "artifact_id", "part_number"], unique: false,
    },
    uk_user_export_delete_identity: {
      columns: ["artifact_id", "part_number", "deletion_generation"], unique: true,
    },
  },
  user_export_snapshot_records: {
    PRIMARY: { columns: ["request_id", "build_generation", "ordinal"], unique: true },
    idx_user_export_snapshot_records_owner: {
      columns: ["tenant_id", "user_id", "request_id", "build_generation", "ordinal"],
      unique: false,
    },
    uk_user_export_snapshot_record_key: {
      columns: ["request_id", "build_generation", "record_kind", "logical_key"],
      unique: true,
    },
  },
  user_export_snapshot_blobs: {
    PRIMARY: { columns: ["request_id", "build_generation", "ordinal"], unique: true },
    idx_user_export_snapshot_blobs_owner: {
      columns: ["tenant_id", "user_id", "request_id", "build_generation", "ordinal"],
      unique: false,
    },
    idx_user_export_snapshot_blobs_release: {
      columns: ["released_at_ms", "request_id", "build_generation", "ordinal"],
      unique: false,
    },
    idx_user_export_snapshot_blobs_source: {
      columns: ["blob_id", "source_deletion_generation", "request_id", "build_generation"],
      unique: false,
    },
    uk_user_export_snapshot_blob_id: {
      columns: ["request_id", "build_generation", "blob_id"], unique: true,
    },
  },
  user_export_download_leases: {
    PRIMARY: { columns: ["artifact_id", "lease_token"], unique: true },
    idx_user_export_download_leases_artifact: {
      columns: ["artifact_id", "lease_until_ms", "lease_token"], unique: false,
    },
    idx_user_export_download_leases_expiry: {
      columns: ["lease_until_ms", "artifact_id", "lease_token"], unique: false,
    },
    idx_user_export_download_leases_owner: {
      columns: ["tenant_id", "user_id", "request_id", "artifact_id"], unique: false,
    },
  },
};

const EXPECTED_CHECKS: Record<(typeof MIGRATION_0017_TABLES)[number], string[]> = {
  user_export_requests: ["chk_user_export_requests_format", "chk_user_export_requests_status"],
  user_export_jobs: ["chk_user_export_jobs_status"],
  user_export_artifacts: ["chk_user_export_artifacts_format", "chk_user_export_artifacts_state"],
  user_export_artifact_parts: ["chk_user_export_parts_number", "chk_user_export_parts_state"],
  user_export_artifact_delete_outbox: [
    "chk_user_export_delete_generation", "chk_user_export_delete_part_number",
  ],
  user_export_snapshot_records: [
    "chk_user_export_snapshot_record_ordinal", "chk_user_export_snapshot_record_size",
  ],
  user_export_snapshot_blobs: ["chk_user_export_snapshot_blob_ordinal"],
  user_export_download_leases: ["chk_user_export_download_lease_time"],
};

function assertDisposableMigrationTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])(test|migration)(?:$|[_-])/i.test(database)) {
    throw new Error(
      `refusing to create migration fixture databases from base database "${database}": `
      + "MYSQL_MIGRATION_TEST_URL must name a test/migration database",
    );
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function fixtureDatabaseName(): string {
  const database = `agent_service_migration_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error("unsafe generated fixture database name");
  }
  return database;
}

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

async function tableNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_type='BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((row) => String(row.table_name));
}

async function snapshotTables(conn: Connection, tables: readonly string[]): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const table of [...tables].sort()) {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`unsafe fixture table name ${table}`);
    const [rows] = await conn.query<Row[]>(`SELECT * FROM \`${table}\``);
    const normalized = rows.map((row) => normalize({ ...row }));
    normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    snapshot[table] = normalized;
  }
  return snapshot;
}

async function snapshotTriggers(conn: Connection): Promise<unknown> {
  const [rows] = await conn.query<Row[]>(
    `SELECT trigger_name, event_manipulation, event_object_table, action_timing, action_statement
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE()
      ORDER BY trigger_name`,
  );
  return normalize(rows.map((row) => ({ ...row })));
}

async function tableColumns(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT COLUMN_NAME AS column_name
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => String(row.column_name));
}

async function tableIndexes(
  conn: Connection,
  table: string,
): Promise<Record<string, { columns: string[]; unique: boolean }>> {
  const [rows] = await conn.query<Row[]>(
    `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY index_name, seq_in_index`,
    [table],
  );
  const indexes: Record<string, { columns: string[]; unique: boolean }> = {};
  for (const row of rows) {
    const name = String(row.index_name);
    const entry = indexes[name] ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(String(row.column_name));
    indexes[name] = entry;
  }
  return indexes;
}

async function tableChecks(conn: Connection, table: string): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT CONSTRAINT_NAME AS constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema=DATABASE() AND table_name=? AND constraint_type='CHECK'
      ORDER BY constraint_name`,
    [table],
  );
  return rows.map((row) => String(row.constraint_name));
}

async function expectExactExportSchema(conn: Connection): Promise<void> {
  for (const table of MIGRATION_0017_TABLES) {
    expect(await tableColumns(conn, table)).toEqual(EXPECTED_COLUMNS[table]);
    expect(await tableIndexes(conn, table)).toEqual(EXPECTED_INDEXES[table]);
    expect(await tableChecks(conn, table)).toEqual(EXPECTED_CHECKS[table]);
  }
  const [badCollations] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLLATION_NAME AS collation_name
       FROM information_schema.columns
      WHERE table_schema=DATABASE()
        AND table_name IN (${MIGRATION_0017_TABLES.map(() => "?").join(",")})
        AND collation_name IS NOT NULL
        AND collation_name <> 'utf8mb4_0900_as_cs'`,
    [...MIGRATION_0017_TABLES],
  );
  expect(badCollations).toEqual([]);
  const [tableCollations] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name, TABLE_COLLATION AS table_collation
       FROM information_schema.tables
      WHERE table_schema=DATABASE()
        AND table_name IN (${MIGRATION_0017_TABLES.map(() => "?").join(",")})
      ORDER BY table_name`,
    [...MIGRATION_0017_TABLES],
  );
  expect(tableCollations).toHaveLength(MIGRATION_0017_TABLES.length);
  expect(tableCollations.every((row) => row.table_collation === "utf8mb4_0900_as_cs")).toBe(true);

  const [critical] = await conn.query<Row[]>(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra
       FROM information_schema.columns
      WHERE table_schema=DATABASE() AND (
        (table_name='user_export_requests' AND column_name IN
          ('idempotency_key_sha256','artifact_ttl_ms','active_build_generation','snapshot_at_ms'))
        OR (table_name='user_export_jobs' AND column_name IN
          ('build_generation','attempts','claim_token','lease_until_ms'))
        OR (table_name='user_export_artifacts' AND column_name IN
          ('storage_backend','storage_format','manifest_sha256','content_sha256',
           'snapshot_root_sha256','deletion_generation'))
        OR (table_name='user_export_artifact_parts' AND column_name IN
          ('storage_key','upload_token','content_type','sha256','deletion_generation'))
        OR (table_name='user_export_artifact_delete_outbox' AND column_name IN
          ('outbox_id','deletion_generation','expected_sha256','expected_size_bytes','claim_token','lease_until_ms'))
        OR (table_name='user_export_snapshot_records' AND column_name IN
          ('ordinal','canonical_utf8_bytes','record_sha256','size_bytes'))
        OR (table_name='user_export_snapshot_blobs' AND column_name IN
          ('source_deletion_generation','source_sha256','source_content_type','pin_token',
           'released_at_ms'))
        OR (table_name='user_export_download_leases' AND column_name IN
          ('lease_token','artifact_deletion_generation','lease_until_ms'))
      )
      ORDER BY table_name, column_name`,
  );
  expect(critical).toEqual(expect.arrayContaining([
    expect.objectContaining({
      table_name: "user_export_requests", column_name: "idempotency_key_sha256",
      column_type: "char(64)", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_requests", column_name: "artifact_ttl_ms",
      column_type: "bigint unsigned", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_jobs", column_name: "claim_token",
      column_type: "varchar(128)", is_nullable: "YES",
    }),
    expect.objectContaining({
      table_name: "user_export_artifacts", column_name: "snapshot_root_sha256",
      column_type: "char(64)", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_artifacts", column_name: "storage_backend",
      column_type: "varchar(32)", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_artifact_parts", column_name: "content_type",
      column_type: "varchar(255)", is_nullable: "YES",
    }),
    expect.objectContaining({
      table_name: "user_export_artifact_delete_outbox", column_name: "outbox_id",
      column_type: "bigint unsigned", is_nullable: "NO", extra: "auto_increment",
    }),
    expect.objectContaining({
      table_name: "user_export_snapshot_records", column_name: "canonical_utf8_bytes",
      column_type: "longblob", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_snapshot_blobs", column_name: "pin_token",
      column_type: "varchar(128)", is_nullable: "NO",
    }),
    expect.objectContaining({
      table_name: "user_export_snapshot_blobs", column_name: "source_content_type",
      column_type: "varchar(255)", is_nullable: "YES",
    }),
    expect.objectContaining({
      table_name: "user_export_download_leases", column_name: "lease_token",
      column_type: "varchar(128)", is_nullable: "NO",
    }),
  ]));
}

async function expectEmptyExportTables(conn: Connection): Promise<void> {
  for (const table of MIGRATION_0017_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM \`${table}\``);
    expect(Number(rows[0]!.count), table).toBe(0);
  }
}

async function insertPartialExportRows(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_requests
      (request_id, tenant_id, user_id, subject_generation, requested_by_key_id,
       idempotency_key_sha256, request_sha256, export_format, export_schema_version,
       policy_version, policy_sha256, artifact_ttl_ms, status, active_build_generation,
       active_artifact_id, created_at_ms, updated_at_ms)
     VALUES
      ('export_00000000-0000-4000-8000-000000000017','tenant_a','user_partial',2,
       'fixture-admin',REPEAT('1',64),REPEAT('2',64),'ndjson-v1',1,
       'policy-v1',REPEAT('3',64),0,'building',1,
       'artifact_00000000-0000-4000-8000-000000000017',2000,2001)`,
  );
  await conn.query(
    `INSERT INTO user_export_jobs
      (request_id, tenant_id, user_id, subject_generation, build_generation, status,
       active_artifact_id, available_at_ms, attempts, claim_token, lease_until_ms,
       created_at_ms, updated_at_ms)
     VALUES
      ('export_00000000-0000-4000-8000-000000000017','tenant_a','user_partial',2,1,
       'building','artifact_00000000-0000-4000-8000-000000000017',2000,2,
       'partial-claim-0017',5000,2000,2001)`,
  );
  await conn.query(
    `INSERT INTO user_export_artifacts
      (artifact_id, request_id, tenant_id, user_id, subject_generation, build_generation,
       export_format, export_schema_version, content_type, content_encoding, state,
       storage_backend, storage_format, snapshot_root_sha256, policy_version, policy_sha256,
       artifact_ttl_ms, staging_expires_at_ms,
       created_at_ms, updated_at_ms)
     VALUES
      ('artifact_00000000-0000-4000-8000-000000000017',
       'export_00000000-0000-4000-8000-000000000017','tenant_a','user_partial',2,1,
       'ndjson-v1',1,'application/vnd.agent-service.user-export+ndjson','identity','staging',
       'filesystem','asblob2-envelope',
       REPEAT('9',64),'policy-v1',REPEAT('3',64),0,5000,2000,2001)`,
  );
}

async function insertReplayGraph(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO user_export_requests
      (request_id, tenant_id, user_id, subject_generation, requested_by_key_id,
       idempotency_key_sha256, request_sha256, export_format, export_schema_version,
       policy_version, policy_sha256, artifact_ttl_ms, status, active_build_generation,
       active_artifact_id, created_at_ms, updated_at_ms, snapshot_at_ms, ready_at_ms,
       expires_at_ms)
     VALUES
      ('export_00000000-0000-4000-8000-000000000018','tenant_a','user_replay',3,
       'fixture-admin',REPEAT('4',64),REPEAT('5',64),'ndjson-v1',1,
       'policy-v1',REPEAT('6',64),100,'expired',2,
       'artifact_00000000-0000-4000-8000-000000000018',3000,3300,3100,3200,3300)`,
  );
  await conn.query(
    `INSERT INTO user_export_jobs
      (request_id, tenant_id, user_id, subject_generation, build_generation, status,
       active_artifact_id, attempts, snapshot_at_ms, snapshot_record_count,
       snapshot_blob_count, snapshot_root_sha256, snapshot_sealed_at_ms,
       created_at_ms, updated_at_ms, completed_at_ms)
     VALUES
      ('export_00000000-0000-4000-8000-000000000018','tenant_a','user_replay',3,2,
       'completed','artifact_00000000-0000-4000-8000-000000000018',3,3100,1,1,
       REPEAT('9',64),3120,3000,3200,3200)`,
  );
  await conn.query(
    `INSERT INTO user_export_artifacts
      (artifact_id, request_id, tenant_id, user_id, subject_generation, build_generation,
       export_format, export_schema_version, content_type, content_encoding, state, part_count,
       storage_backend, storage_format, record_count, total_size_bytes, manifest_sha256,
       content_sha256, snapshot_root_sha256,
       policy_version, policy_sha256, artifact_ttl_ms, snapshot_at_ms, staging_expires_at_ms, ready_at_ms,
       expires_at_ms, delete_after_ms, deletion_generation, created_at_ms, updated_at_ms)
     VALUES
      ('artifact_00000000-0000-4000-8000-000000000018',
       'export_00000000-0000-4000-8000-000000000018','tenant_a','user_replay',3,2,
       'ndjson-v1',1,'application/vnd.agent-service.user-export+ndjson','identity',
       'delete_pending',1,'filesystem','asblob2-envelope',4,128,REPEAT('7',64),REPEAT('8',64),
       REPEAT('9',64),
       'policy-v1',REPEAT('6',64),
       100,3100,3050,3200,3300,3300,1,3000,3300)`,
  );
  const canonicalRecord = Buffer.from('{"kind":"profile","value":"fixture"}\n', "utf8");
  await conn.query(
    `INSERT INTO user_export_snapshot_records
      (request_id, build_generation, ordinal, tenant_id, user_id, subject_generation,
       record_kind, logical_key, canonical_utf8_bytes, record_sha256, size_bytes,
       captured_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      "export_00000000-0000-4000-8000-000000000018",
      2,
      0,
      "tenant_a",
      "user_replay",
      3,
      "profile",
      "profile/user_replay",
      canonicalRecord,
      "a".repeat(64),
      canonicalRecord.byteLength,
      3100,
    ],
  );
  await conn.query(
    `INSERT INTO user_export_snapshot_blobs
      (request_id, build_generation, ordinal, blob_id, tenant_id, user_id, subject_generation,
       session_id, item_id, purpose, storage_backend, storage_format, storage_key,
       upload_token, source_deletion_generation, source_sha256, source_size_bytes,
       source_content_type, pin_token, pinned_at_ms, released_at_ms)
     VALUES
      ('export_00000000-0000-4000-8000-000000000018',2,0,
       'blob_00000000-0000-4000-8000-000000000018','tenant_a','user_replay',3,
       'sess_00000000-0000-4000-8000-000000000018',NULL,'user_attachment',
       'filesystem','asblob2-envelope','objects/export-source/replay','source-upload-0017',0,
       REPEAT('b',64),64,'application/octet-stream','snapshot-pin-replay-0017',3100,3200)`,
  );
  await conn.query(
    `INSERT INTO user_export_artifact_parts
      (artifact_id, part_number, request_id, build_generation, tenant_id, user_id,
       subject_generation, state, storage_backend, storage_format, storage_key, upload_token,
       content_type, content_encoding, sha256, size_bytes, record_count, staging_expires_at_ms,
       uploaded_at_ms, delete_after_ms, deletion_generation, created_at_ms, updated_at_ms)
     VALUES
      ('artifact_00000000-0000-4000-8000-000000000018',0,
       'export_00000000-0000-4000-8000-000000000018',2,'tenant_a','user_replay',3,
       'delete_pending','filesystem','asblob2-envelope','exports/replay/part-000000',
       'upload-replay-0017','application/vnd.agent-service.user-export+ndjson','identity',
       REPEAT('8',64),128,4,3050,3150,3300,1,3000,3300)`,
  );
  await conn.query(
    `INSERT INTO user_export_artifact_delete_outbox
      (artifact_id, part_number, request_id, build_generation, deletion_generation,
       storage_backend, storage_format, storage_key, upload_token, expected_sha256,
       expected_size_bytes, available_at_ms, attempts, claim_token, lease_until_ms,
       last_error, created_at_ms)
     VALUES
      ('artifact_00000000-0000-4000-8000-000000000018',0,
       'export_00000000-0000-4000-8000-000000000018',2,1,
       'filesystem','asblob2-envelope','exports/replay/part-000000','upload-replay-0017',
       REPEAT('8',64),128,3300,2,'delete-claim-replay-0017',5000,
       'transient fixture failure',3300)`,
  );
  await conn.query(
    `INSERT INTO user_export_download_leases
      (artifact_id, lease_token, tenant_id, user_id, request_id, build_generation,
       artifact_deletion_generation, lease_until_ms, created_at_ms, updated_at_ms)
     VALUES
      ('artifact_00000000-0000-4000-8000-000000000018','download-lease-replay-0017',
       'tenant_a','user_replay','export_00000000-0000-4000-8000-000000000018',2,1,
       3250,3200,3220)`,
  );
}

describe("real MySQL historical upgrade: 0016 -> 0017", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0017: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(8);
    expect(migrationStatements.filter((statement) => statement.startsWith("SELECT"))).toHaveLength(8);
    expect(migrationStatements.every((statement) => (
      statement.startsWith("CREATE TABLE IF NOT EXISTS") || statement.startsWith("SELECT")
    ))).toBe(true);
    only0017 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0017-"));
    await copyFile(MIGRATION_PATH, join(only0017, "0017_user_export_jobs_and_artifacts.sql"));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0017) await rm(only0017, { recursive: true, force: true });
  });

  it("loads a frozen 0016 database with evaluator evidence and no export tables", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: databaseUrl(baseUrl, database), multipleStatements: true });
      await conn.query(fixtureSql);
      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0016_MIGRATIONS);
      const names = await tableNames(conn);
      expect(MIGRATION_0017_TABLES.filter((table) => names.includes(table))).toEqual([]);
      const [evidence] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM erasure_policy_evaluation_jobs) AS jobs,
          (SELECT COUNT(*) FROM erasure_purge_targets) AS targets,
          (SELECT COUNT(*) FROM erasure_policy_evaluation_decisions) AS decisions,
          (SELECT COUNT(*) FROM erasure_purge_authority_controls) AS controls,
          (SELECT COUNT(*) FROM erasure_purge_authorities) AS authorities,
          (SELECT export_artifact_disposition FROM erasure_purge_targets LIMIT 1) AS export_disposition`,
      );
      expect(evidence[0]).toMatchObject({
        jobs: 1,
        targets: 1,
        decisions: 1,
        controls: 1,
        authorities: 1,
        export_disposition: "not_applicable",
      });
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("expands the full 0016 fixture without changing any old row, trigger, or purge meaning", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const oldTables = (await tableNames(conn)).filter((table) => table !== "schema_migrations");
      const before = await snapshotTables(conn, oldTables);
      const triggersBefore = await snapshotTriggers(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0017!, connectionLimit: 1 });
      await store.close();

      expect(await snapshotTables(conn, oldTables)).toEqual(before);
      expect(await snapshotTriggers(conn)).toEqual(triggersBefore);
      await expectExactExportSchema(conn);
      await expectEmptyExportTables(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0017_user_export_jobs_and_artifacts.sql'",
      );
      expect(Number(marker[0]!.count)).toBe(1);
      const [targets] = await conn.query<Row[]>(
        "SELECT export_artifact_disposition FROM erasure_purge_targets ORDER BY request_id, build_generation, session_id",
      );
      expect(targets.map((row) => row.export_artifact_disposition)).toEqual(["not_applicable"]);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after partial DDL while preserving rows already written to completed new tables", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const oldTables = (await tableNames(conn)).filter((table) => table !== "schema_migrations");
      const oldBefore = await snapshotTables(conn, oldTables);
      for (const statement of migrationStatements.slice(0, 6)) await conn.query(statement);
      expect((await tableNames(conn)).filter((table) => MIGRATION_0017_TABLES.includes(
        table as (typeof MIGRATION_0017_TABLES)[number],
      )).sort()).toEqual([
        "user_export_artifacts", "user_export_jobs", "user_export_requests",
      ]);
      await insertPartialExportRows(conn);
      const partialTables = ["user_export_requests", "user_export_jobs", "user_export_artifacts"];
      const partialBefore = await snapshotTables(conn, partialTables);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0017!, connectionLimit: 1 });
      await store.close();

      expect(await snapshotTables(conn, oldTables)).toEqual(oldBefore);
      expect(await snapshotTables(conn, partialTables)).toEqual(partialBefore);
      await expectExactExportSchema(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0017_user_export_jobs_and_artifacts.sql'",
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("replays after marker loss without changing request, claim, artifact, part, or delete work", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const first = await MysqlSessionStore.connect({ url, migrationsDir: only0017!, connectionLimit: 1 });
      await first.close();
      await insertReplayGraph(conn);
      const oldTables = (await tableNames(conn)).filter((table) => (
        table !== "schema_migrations" && !MIGRATION_0017_TABLES.includes(
          table as (typeof MIGRATION_0017_TABLES)[number],
        )
      ));
      const oldBefore = await snapshotTables(conn, oldTables);
      const exportBefore = await snapshotTables(conn, MIGRATION_0017_TABLES);
      const triggersBefore = await snapshotTriggers(conn);
      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0017_user_export_jobs_and_artifacts.sql'",
      );

      const replay = await MysqlSessionStore.connect({ url, migrationsDir: only0017!, connectionLimit: 1 });
      await replay.close();

      expect(await snapshotTables(conn, oldTables)).toEqual(oldBefore);
      expect(await snapshotTables(conn, MIGRATION_0017_TABLES)).toEqual(exportBefore);
      expect(await snapshotTriggers(conn)).toEqual(triggersBefore);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0017_user_export_jobs_and_artifacts.sql'",
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed without a marker when an incompatible same-name table already exists", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      await conn.query(
        `CREATE TABLE user_export_requests (
           request_id VARCHAR(64) COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs`,
      );

      await expect(MysqlSessionStore.connect({
        url,
        migrationsDir: only0017!,
        connectionLimit: 1,
      })).rejects.toThrow(/migration 0017_user_export_jobs_and_artifacts\.sql failed at statement 2\/16/);

      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0017_user_export_jobs_and_artifacts.sql'",
      );
      expect(Number(marker[0]!.count)).toBe(0);
      const names = await tableNames(conn);
      expect(names).not.toContain("user_export_jobs");
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
