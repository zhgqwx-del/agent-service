import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
  EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_PURGE_PLAN_DOMAINS,
} from "../../src/index.js";

const DEFAULT_MYSQL_URL = "mysql://root@127.0.0.1:3306/agent_service_test";
const BASE_URL = process.env.MYSQL_MIGRATION_TEST_URL ?? process.env.MYSQL_TEST_URL
  ?? DEFAULT_MYSQL_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0017.sql");
const FROZEN_0020_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0020-delta.sql");
const FROZEN_0021_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0021-delta.sql");
const FROZEN_0022_DELTA_PATH = resolve(HERE, "../fixtures/mysql-0022-delta.sql");
const MIGRATION_NAME = "0023_tenant_purge_execution_ack.sql";
const MIGRATION_PATH = resolve(HERE, `../../migrations/${MIGRATION_NAME}`);
const FROZEN_0022_SHA256 = "b0c0f354ee2c7ad834c327593a9b002500a8c3381ffe1754020204f844f6dbdd";
const TRIGGER_BODY_SHA256 = "13266d178324cc3a32fa9ac5c2c9e8f83477a03096c2f861418d6cb2e4bd0832";
const REQUEST_ID = "erase_23000000-0000-4000-8000-000000000023";
const TENANT_ID = "tenant-frozen-0022";

const FROZEN_0022_MIGRATIONS = [
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
  "0017_user_export_jobs_and_artifacts.sql",
  "0018_tenant_credential_revocation_fence.sql",
  "0019_tenant_credential_physical_revocation.sql",
  "0020_tenant_runtime_revocation.sql",
  "0021_tenant_content_inventory.sql",
  "0022_tenant_purge_plan.sql",
] as const;

const EXECUTION_TABLES = [
  "tenant_purge_execution_jobs",
  "tenant_purge_execution_domains",
  "tenant_purge_execution_domain_acks",
  "tenant_purge_local_cutover_receipts",
  "tenant_purge_local_physical_ack_receipts",
  "tenant_purge_execution_cutover",
] as const;

const EVIDENCE_TABLES = EXECUTION_TABLES.slice(0, 5);

const EXPECTED_COLUMN_COUNTS: Record<string, number> = {
  tenant_purge_execution_jobs: 32,
  tenant_purge_execution_domains: 17,
  tenant_purge_execution_domain_acks: 29,
  tenant_purge_local_cutover_receipts: 34,
  tenant_purge_local_physical_ack_receipts: 29,
  tenant_purge_execution_cutover: 6,
};

const EXPECTED_INDEX_NAMES: Record<string, string[]> = {
  tenant_purge_execution_jobs: [
    "PRIMARY", "idx_tenant_purge_exec_jobs_claim",
    "uk_tenant_purge_exec_jobs_generation", "uk_tenant_purge_exec_jobs_identity",
    "uk_tenant_purge_exec_jobs_tenant",
  ],
  tenant_purge_execution_domains: [
    "PRIMARY", "fk_tenant_purge_exec_domain_plan_entry",
    "idx_tenant_purge_exec_domains_owner", "uk_tenant_purge_exec_domains_identity",
    "uk_tenant_purge_exec_domains_ordinal",
  ],
  tenant_purge_execution_domain_acks: [
    "PRIMARY", "idx_tenant_purge_exec_acks_domain_fk",
    "idx_tenant_purge_exec_acks_owner", "idx_tenant_purge_exec_acks_scheduled_fk",
    "uk_tenant_purge_exec_acks_domain_seq", "uk_tenant_purge_exec_acks_operation",
    "uk_tenant_purge_exec_acks_outbox", "uk_tenant_purge_exec_acks_receipt",
  ],
  tenant_purge_local_cutover_receipts: [
    "PRIMARY", "idx_tenant_purge_local_cutover_job_fk",
    "uk_tenant_purge_local_cutover_generation", "uk_tenant_purge_local_cutover_hash",
    "uk_tenant_purge_local_cutover_request_hash", "uk_tenant_purge_local_cutover_tenant",
  ],
  tenant_purge_local_physical_ack_receipts: [
    "PRIMARY", "idx_tenant_purge_local_physical_cutover_fk",
    "idx_tenant_purge_local_physical_job_fk", "uk_tenant_purge_local_physical_generation",
    "uk_tenant_purge_local_physical_hash", "uk_tenant_purge_local_physical_tenant",
  ],
  tenant_purge_execution_cutover: [
    "PRIMARY", "idx_tenant_purge_exec_cutover_receipt_fk",
  ],
};

const EXPECTED_CHECK_NAMES: Record<string, string[]> = {
  tenant_purge_execution_jobs: [
    "chk_tenant_purge_exec_job_clock", "chk_tenant_purge_exec_job_generations",
    "chk_tenant_purge_exec_job_phase", "chk_tenant_purge_exec_job_progress",
  ],
  tenant_purge_execution_domains: [
    "chk_tenant_purge_exec_domain_disposition", "chk_tenant_purge_exec_domain_generation",
    "chk_tenant_purge_exec_domain_name", "chk_tenant_purge_exec_domain_ordinal",
    "chk_tenant_purge_exec_domain_phase",
  ],
  tenant_purge_execution_domain_acks: [
    "chk_tenant_purge_exec_ack_generation", "chk_tenant_purge_exec_ack_kind",
    "chk_tenant_purge_exec_ack_outbox", "chk_tenant_purge_exec_ack_protocol",
    "chk_tenant_purge_exec_ack_scope",
  ],
  tenant_purge_local_cutover_receipts: [
    "chk_tenant_purge_local_cutover_clock", "chk_tenant_purge_local_cutover_flags",
    "chk_tenant_purge_local_cutover_generation", "chk_tenant_purge_local_cutover_outbox",
    "chk_tenant_purge_local_cutover_scope",
  ],
  tenant_purge_local_physical_ack_receipts: [
    "chk_tenant_purge_local_physical_blocker", "chk_tenant_purge_local_physical_clock",
    "chk_tenant_purge_local_physical_flags", "chk_tenant_purge_local_physical_generation",
    "chk_tenant_purge_local_physical_scope",
  ],
  tenant_purge_execution_cutover: [
    "chk_tenant_purge_execution_cutover_singleton",
    "chk_tenant_purge_execution_cutover_state",
  ],
};

const EXPECTED_FOREIGN_KEYS = [
  "fk_tenant_purge_exec_ack_domain",
  "fk_tenant_purge_exec_ack_scheduled",
  "fk_tenant_purge_exec_domain_job",
  "fk_tenant_purge_exec_domain_plan_entry",
  "fk_tenant_purge_exec_job_inventory",
  "fk_tenant_purge_exec_job_plan",
  "fk_tenant_purge_execution_cutover_receipt",
  "fk_tenant_purge_local_cutover_job",
  "fk_tenant_purge_local_physical_cutover",
  "fk_tenant_purge_local_physical_job",
] as const;

type Row = RowDataPacket;

function assertDisposableMigrationTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
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
  const name = `agent_service_migration_test_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 8)}`;
  if (!/^agent_service_migration_test_[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error("unsafe generated migration database name");
  }
  return name;
}

function normalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function infoSchemaField(row: Row, name: string): unknown {
  return row[name] ?? row[name.toUpperCase()];
}

async function installFrozen0022(
  conn: Connection,
  fixtures: readonly string[],
): Promise<void> {
  for (const fixture of fixtures) await conn.query(fixture);
  const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
  expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0022_MIGRATIONS);
}

async function seedFrozen0022Evidence(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO tenant_content_inventory_receipts
       (scope, request_id, tenant_id, subject_generation, build_generation,
        t1_fence_sha256, t3a_receipt_sha256, t3b_receipt_sha256, policy_version,
        policy_sha256, policy_schema_version, retention_anchor_db_ms,
        content_not_before_db_ms, session_receipt_count, session_receipt_root_sha256,
        content_record_count, hold_control_count, hold_root_sha256, global_orphan_check,
        store_db_timestamp_ms, completed_claim_attempt, completed_claim_token_sha256,
        content_inventory_complete, content_purge_executed, receipt_sha256)
     VALUES ('tenant-content-inventory-v1', ?, ?, 1, 1, REPEAT('1',64),
             REPEAT('2',64), REPEAT('3',64), 'policy-v1', REPEAT('4',64), 1,
             5000, 5000, 0, REPEAT('5',64), 0, 0, REPEAT('6',64), 'passed',
             5001, 1, REPEAT('a',64), TRUE, FALSE, REPEAT('7',64))`,
    [REQUEST_ID, TENANT_ID],
  );
  await conn.query(
    `INSERT INTO tenant_purge_plan_jobs
       (request_id, tenant_id, subject_generation, t1_fence_sha256, t3a_receipt_sha256,
        t3b_receipt_sha256, t3c_receipt_sha256, policy_version, policy_sha256,
        policy_schema_version, build_generation, retention_anchor_db_ms,
        purge_not_before_db_ms, source_evidence_db_ms, cursor_domain, scan_complete,
        plan_entry_count, plan_entry_root_sha256, blocker_count, blocker_root_sha256,
        phase, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
        created_at_ms, updated_at_ms, sealed_at_ms, completed_claim_attempt,
        completed_claim_token_sha256, aggregate_receipt_sha256, blocked_at_ms,
        blocked_reason_code)
     VALUES (?, ?, 1, REPEAT('1',64), REPEAT('2',64), REPEAT('3',64),
             REPEAT('7',64), 'policy-v1', REPEAT('4',64), 1, 1, 5000, 5000, 5001,
             'traces', TRUE, 33, REPEAT('6',64), 0, REPEAT('8',64), 'plan_sealed',
             NULL, 1, NULL, NULL, NULL, 5001, 5002, 5002, 1, REPEAT('a',64),
             REPEAT('9',64), NULL, NULL)`,
    [REQUEST_ID, TENANT_ID],
  );
  for (const [index, domain] of TENANT_PURGE_PLAN_DOMAINS.entries()) {
    await conn.query(
      `INSERT INTO tenant_purge_plan_entries
         (scope, request_id, build_generation, tenant_id, subject_generation, domain,
          target_count, target_root_sha256, disposition, source_sha256,
          captured_at_db_ms, receipt_sha256)
       VALUES ('tenant-purge-plan-entry-v1', ?, 1, ?, 1, ?, 0, REPEAT('b',64),
               'delete', REPEAT('c',64), 5001, ?)`,
      [REQUEST_ID, TENANT_ID, domain, (index + 1).toString(16).padStart(64, "0")],
    );
  }
  await conn.query(
    `INSERT INTO tenant_purge_plan_receipts
       (scope, request_id, tenant_id, subject_generation, build_generation, t1_fence_sha256,
        t3a_receipt_sha256, t3b_receipt_sha256, t3c_receipt_sha256, policy_version,
        policy_sha256, policy_schema_version, retention_anchor_db_ms, purge_not_before_db_ms,
        source_evidence_db_ms, plan_entry_count, plan_entry_root_sha256, blocker_count,
        blocker_root_sha256, store_db_timestamp_ms, completed_claim_attempt,
        completed_claim_token_sha256, plan_complete, execution_ready,
        content_purge_executed, receipt_sha256)
     VALUES ('tenant-purge-plan-v1', ?, ?, 1, 1, REPEAT('1',64), REPEAT('2',64),
             REPEAT('3',64), REPEAT('7',64), 'policy-v1', REPEAT('4',64), 1,
             5000, 5000, 5001, 33, REPEAT('6',64), 0, REPEAT('8',64), 5002,
             1, REPEAT('a',64), TRUE, FALSE, FALSE, REPEAT('9',64))`,
    [REQUEST_ID, TENANT_ID],
  );
}

async function frozenEvidenceSnapshot(conn: Connection): Promise<unknown> {
  const queries: Record<string, string> = {
    tenant_content_inventory_receipts:
      "SELECT * FROM tenant_content_inventory_receipts ORDER BY request_id",
    tenant_purge_plan_jobs: "SELECT * FROM tenant_purge_plan_jobs ORDER BY request_id",
    tenant_purge_plan_entries:
      "SELECT * FROM tenant_purge_plan_entries ORDER BY request_id,build_generation,domain",
    tenant_purge_plan_receipts:
      "SELECT * FROM tenant_purge_plan_receipts ORDER BY request_id",
  };
  const result: Record<string, unknown> = {};
  for (const [table, query] of Object.entries(queries)) {
    const [rows] = await conn.query<Row[]>(query);
    result[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return result;
}

async function expectExecutionDormant(conn: Connection): Promise<void> {
  for (const table of EVIDENCE_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT COUNT(*) AS count FROM ${table}`);
    expect(Number(rows[0]!.count), `${table} must not be backfilled`).toBe(0);
  }
  const [cutover] = await conn.query<Row[]>("SELECT * FROM tenant_purge_execution_cutover");
  expect(cutover).toHaveLength(1);
  expect(normalize({ ...cutover[0] })).toEqual({
    activated_at_ms: null,
    control_generation: 0,
    evidence_sha256: null,
    first_receipt_sha256: null,
    first_request_id: null,
    singleton_id: 1,
  });
}

async function assert0023Schema(conn: Connection): Promise<void> {
  const [tables] = await conn.query<Row[]>(
    `SELECT table_name, table_type, engine, table_collation
       FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name IN (?) ORDER BY table_name`,
    [EXECUTION_TABLES],
  );
  expect(tables.map((row) => String(infoSchemaField(row, "table_name"))))
    .toEqual([...EXECUTION_TABLES].sort());
  expect(tables.every((row) => String(infoSchemaField(row, "table_type")) === "BASE TABLE"
    && String(infoSchemaField(row, "engine")) === "InnoDB"
    && String(infoSchemaField(row, "table_collation")) === "utf8mb4_0900_as_cs")).toBe(true);

  const [columns] = await conn.query<Row[]>(
    `SELECT table_name, COUNT(*) AS count FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name IN (?) GROUP BY table_name`,
    [EXECUTION_TABLES],
  );
  expect(Object.fromEntries(columns.map((row) => [
    String(infoSchemaField(row, "table_name")), Number(infoSchemaField(row, "count")),
  ]))).toEqual(EXPECTED_COLUMN_COUNTS);

  const [indexes] = await conn.query<Row[]>(
    `SELECT DISTINCT table_name,index_name FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name IN (?) ORDER BY table_name,index_name`,
    [EXECUTION_TABLES],
  );
  for (const table of EXECUTION_TABLES) {
    expect(indexes.filter((row) => String(infoSchemaField(row, "table_name")) === table)
      .map((row) => String(infoSchemaField(row, "index_name"))).sort())
      .toEqual([...EXPECTED_INDEX_NAMES[table]!].sort());
  }

  const [checks] = await conn.query<Row[]>(
    `SELECT table_name,constraint_name,enforced FROM information_schema.table_constraints
      WHERE table_schema=DATABASE() AND constraint_type='CHECK' AND table_name IN (?)
      ORDER BY table_name,constraint_name`,
    [EXECUTION_TABLES],
  );
  for (const table of EXECUTION_TABLES) {
    const actual = checks.filter((row) => String(infoSchemaField(row, "table_name")) === table);
    expect(actual.map((row) => String(infoSchemaField(row, "constraint_name"))))
      .toEqual(EXPECTED_CHECK_NAMES[table]);
    expect(actual.every((row) => String(infoSchemaField(row, "enforced")) === "YES")).toBe(true);
  }

  const [foreignKeys] = await conn.query<Row[]>(
    `SELECT constraint_name,update_rule,delete_rule
       FROM information_schema.referential_constraints
      WHERE constraint_schema=DATABASE()
        AND table_name IN (?) ORDER BY constraint_name`,
    [EXECUTION_TABLES],
  );
  expect(foreignKeys.map((row) => String(infoSchemaField(row, "constraint_name"))))
    .toEqual(EXPECTED_FOREIGN_KEYS);
  expect(foreignKeys.every((row) => String(infoSchemaField(row, "update_rule")) === "RESTRICT"
    && String(infoSchemaField(row, "delete_rule")) === "RESTRICT")).toBe(true);

  const [triggers] = await conn.query<Row[]>(
    `SELECT event_object_table,trigger_name FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table IN (?)
      ORDER BY event_object_table,trigger_name`,
    [EXECUTION_TABLES],
  );
  const triggerPrefixes: Record<string, string> = {
    tenant_purge_execution_jobs: "trg_tenant_purge_exec_jobs",
    tenant_purge_execution_domains: "trg_tenant_purge_exec_domains",
    tenant_purge_execution_domain_acks: "trg_tenant_purge_exec_acks",
    tenant_purge_local_cutover_receipts: "trg_tenant_purge_local_cutover",
    tenant_purge_local_physical_ack_receipts: "trg_tenant_purge_local_physical",
    tenant_purge_execution_cutover: "trg_tenant_purge_exec_cutover",
  };
  const suffixes = ["bd", "bd_guard_a", "bd_guard_b", "bu", "bu_guard_a", "bu_guard_b"];
  for (const table of EXECUTION_TABLES) {
    expect(triggers.filter((row) => String(infoSchemaField(row, "event_object_table")) === table)
      .map((row) => String(infoSchemaField(row, "trigger_name"))))
      .toEqual(suffixes.map((suffix) => `${triggerPrefixes[table]}_${suffix}`));
  }
  await conn.query("SET SESSION group_concat_max_len=1048576");
  const [triggerHash] = await conn.query<Row[]>(
    `SELECT COUNT(*) AS count,
            SHA2(GROUP_CONCAT(CONCAT_WS('~',event_object_table,trigger_name,
              action_timing,event_manipulation,action_orientation,
              IFNULL(action_condition,'<NULL>'),
              LOWER(REGEXP_REPLACE(action_statement,'[[:space:]]','')))
              ORDER BY event_object_table,trigger_name SEPARATOR '|'),256) AS digest
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_object_table IN (?)`,
    [EXECUTION_TABLES],
  );
  expect(Number(triggerHash[0]!.count)).toBe(36);
  expect(String(triggerHash[0]!.digest)).toBe(TRIGGER_BODY_SHA256);
}

async function insertExecutionJob(conn: Connection, domainCount = 33): Promise<void> {
  await conn.query(
    `INSERT INTO tenant_purge_execution_jobs
       (request_id,tenant_id,subject_generation,plan_build_generation,
        execution_generation,t3c_receipt_sha256,plan_receipt_sha256,
        plan_entry_root_sha256,plan_blocker_count,plan_blocker_root_sha256,
        policy_sha256,purge_not_before_db_ms,source_evidence_db_ms,phase,
        domain_count,domain_ack_count,domain_ack_root_sha256,unresolved_blocker_count,
        local_cutover_receipt_sha256,available_at_ms,attempts,claim_token,
        lease_until_ms,last_error_code,created_at_ms,updated_at_ms,
        local_physical_ack_receipt_sha256,local_physical_acks_sealed_at_ms,
        completed_claim_attempt,completed_claim_token_sha256,blocked_at_ms,
        blocked_reason_code)
     VALUES (?,?,1,1,1,REPEAT('7',64),REPEAT('9',64),REPEAT('6',64),0,
             REPEAT('8',64),REPEAT('4',64),5000,5001,'queued',?,0,?,0,NULL,
             6000,0,NULL,NULL,NULL,6000,6000,NULL,NULL,NULL,NULL,NULL,NULL)`,
    [REQUEST_ID, TENANT_ID, domainCount, EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256],
  );
}

async function insertExecutionDomain(
  conn: Connection,
  domain: (typeof TENANT_PURGE_PLAN_DOMAINS)[number] = TENANT_PURGE_PLAN_DOMAINS[0],
  tenantId = TENANT_ID,
): Promise<void> {
  const ordinal = TENANT_PURGE_PLAN_DOMAINS.indexOf(domain);
  await conn.query(
    `INSERT INTO tenant_purge_execution_domains
       (request_id,tenant_id,subject_generation,plan_build_generation,
        execution_generation,domain,execution_ordinal,plan_disposition,
        plan_target_count,plan_target_root_sha256,plan_source_sha256,
        plan_entry_receipt_sha256,phase,ack_count,ack_root_sha256,
        final_ack_sha256,updated_at_ms)
     VALUES (?,?,1,1,1,?,?,'delete',0,REPEAT('b',64),REPEAT('c',64),?,
             'pending',0,?,NULL,6000)`,
    [
      REQUEST_ID,
      tenantId,
      domain,
      ordinal,
      (ordinal + 1).toString(16).padStart(64, "0"),
      EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
    ],
  );
}

async function seedExecutionEvidence(conn: Connection): Promise<void> {
  await insertExecutionJob(conn);
  for (const domain of TENANT_PURGE_PLAN_DOMAINS) await insertExecutionDomain(conn, domain);
  const domain = TENANT_PURGE_PLAN_DOMAINS[0]!;
  await conn.query(
    `INSERT INTO tenant_purge_execution_domain_acks
       (scope,request_id,tenant_id,subject_generation,plan_build_generation,
        execution_generation,domain,global_ack_seq,domain_ack_seq,
        previous_domain_ack_sha256,previous_global_ack_sha256,ack_kind,
        plan_entry_receipt_sha256,affected_count,result_count,result_root_sha256,
        adapter_protocol,operation_sha256,physical_proof_sha256,
        completed_claim_attempt,completed_claim_token_sha256,store_db_timestamp_ms,
        final,outbox_kind,outbox_id,deletion_generation,target_sha256,
        scheduled_ack_sha256,receipt_sha256)
     VALUES ('tenant-purge-execution-domain-ack-v1',?,?,1,1,1,?,1,1,?,?,'applied',
             LPAD('1',64,'0'),0,0,REPEAT('d',64),'mysql-local-v1',REPEAT('e',64),
             REPEAT('f',64),1,REPEAT('a',64),6001,TRUE,NULL,NULL,NULL,NULL,NULL,
             REPEAT('1',64))`,
    [
      REQUEST_ID,
      TENANT_ID,
      domain,
      EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
      EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
    ],
  );
  await conn.query(
    `INSERT INTO tenant_purge_local_cutover_receipts
       (scope,request_id,tenant_id,subject_generation,plan_build_generation,
        execution_generation,t3c_receipt_sha256,plan_receipt_sha256,
        plan_entry_root_sha256,plan_blocker_count,plan_blocker_root_sha256,
        policy_sha256,purge_not_before_db_ms,source_evidence_db_ms,
        operational_usage_target_count,operational_usage_target_root_sha256,
        blob_bytes_target_count,blob_bytes_target_root_sha256,
        blob_delete_outbox_count,blob_delete_outbox_root_sha256,
        export_bytes_target_count,export_bytes_target_root_sha256,
        export_delete_outbox_count,export_delete_outbox_root_sha256,
        domain_ack_count,domain_ack_root_sha256,store_db_timestamp_ms,
        completed_claim_attempt,completed_claim_token_sha256,
        local_destructive_progress,physical_acks_complete,all_domains_complete,
        content_purge_executed,receipt_sha256)
     VALUES ('tenant-purge-local-cutover-v1',?,?,1,1,1,REPEAT('7',64),
             REPEAT('9',64),REPEAT('6',64),0,REPEAT('8',64),REPEAT('4',64),
             5000,5001,0,REPEAT('2',64),0,REPEAT('3',64),0,REPEAT('4',64),
             0,REPEAT('5',64),0,REPEAT('6',64),1,REPEAT('1',64),6002,1,
             REPEAT('a',64),TRUE,FALSE,FALSE,FALSE,REPEAT('2',64))`,
    [REQUEST_ID, TENANT_ID],
  );
  await conn.query(
    `UPDATE tenant_purge_execution_cutover
        SET control_generation=1,activated_at_ms=6002,first_request_id=?,
            first_receipt_sha256=REPEAT('2',64),evidence_sha256=REPEAT('3',64)
      WHERE singleton_id=1`,
    [REQUEST_ID],
  );
}

async function executionSnapshot(conn: Connection): Promise<unknown> {
  const orderBy: Record<string, string> = {
    tenant_purge_execution_jobs: "request_id",
    tenant_purge_execution_domains: "request_id,execution_generation,execution_ordinal",
    tenant_purge_execution_domain_acks: "request_id,execution_generation,global_ack_seq",
    tenant_purge_local_cutover_receipts: "request_id",
    tenant_purge_local_physical_ack_receipts: "request_id",
    tenant_purge_execution_cutover: "singleton_id",
  };
  const result: Record<string, unknown> = {};
  for (const table of EXECUTION_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM ${table} ORDER BY ${orderBy[table]}`);
    result[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return result;
}

async function expectMigrationFailure(
  url: string,
  only0023: string,
  matcher: RegExp,
): Promise<void> {
  let failure: unknown;
  try {
    await MysqlSessionStore.connect({ url, migrationsDir: only0023, connectionLimit: 1 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(
    /migration 0023_tenant_purge_execution_ack\.sql failed at statement \d+\/\d+/,
  );
  const cause = (failure as Error & {
    cause?: { code?: string; sqlMessage?: string; message?: string };
  }).cause;
  expect(cause?.sqlMessage ?? cause?.message).toMatch(matcher);
}

describe("real MySQL historical upgrade: frozen 0022 -> 0023", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtures: string[];
  let frozen0022DeltaSql: string;
  let migrationSql: string;
  let only0023: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    const [baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql, frozen0022Sql] =
      await Promise.all([
        readFile(BASE_FIXTURE_PATH, "utf8"),
        readFile(FROZEN_0020_DELTA_PATH, "utf8"),
        readFile(FROZEN_0021_DELTA_PATH, "utf8"),
        readFile(FROZEN_0022_DELTA_PATH, "utf8"),
      ]);
    frozen0022DeltaSql = frozen0022Sql;
    fixtures = [baseFixtureSql, frozen0020DeltaSql, frozen0021DeltaSql, frozen0022DeltaSql];
    migrationSql = await readFile(MIGRATION_PATH, "utf8");
    expect(createHash("sha256").update(frozen0022DeltaSql).digest("hex"))
      .toBe(FROZEN_0022_SHA256);
    expect(frozen0022DeltaSql).toContain("CREATE TABLE IF NOT EXISTS `tenant_purge_plan_jobs`");
    expect(frozen0022DeltaSql).not.toContain("tenant_purge_execution_jobs");
    expect(migrationSql).not.toMatch(
      /INSERT\s+INTO\s+tenant_purge_(?:execution_jobs|execution_domains|execution_domain_acks|local_cutover_receipts|local_physical_ack_receipts)/i,
    );
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\s+tenant_/i);
    only0023 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0023-"));
    await copyFile(MIGRATION_PATH, join(only0023, MIGRATION_NAME));
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0023) await rm(only0023, { recursive: true, force: true });
  });

  it("preserves frozen 0022 evidence, installs the exact schema, and performs no backfill", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0022(conn, fixtures);
      await seedFrozen0022Evidence(conn);
      const before = await frozenEvidenceSnapshot(conn);
      const migrated = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await migrated.close();
      expect(await frozenEvidenceSnapshot(conn)).toEqual(before);
      await expectExecutionDormant(conn);
      await assert0023Schema(conn);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges from independent MySQL DDL auto-commit boundaries without a marker", async () => {
    const boundaries = [
      "CREATE TABLE IF NOT EXISTS tenant_purge_execution_domains",
      "CREATE TABLE IF NOT EXISTS tenant_purge_execution_cutover",
    ];
    for (const boundaryText of boundaries) {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(baseUrl, database);
      let conn: Connection | undefined;
      try {
        conn = await mysql.createConnection({ uri: url, multipleStatements: true });
        await installFrozen0022(conn, fixtures);
        const boundary = migrationSql.indexOf(boundaryText);
        expect(boundary).toBeGreaterThan(0);
        await conn.query(migrationSql.slice(0, boundary));
        const [markerBefore] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
        );
        expect(Number(markerBefore[0]!.count)).toBe(0);
        const replay = await MysqlSessionStore.connect({
          url, migrationsDir: only0023!, connectionLimit: 1,
        });
        await replay.close();
        await expectExecutionDormant(conn);
        await assert0023Schema(conn);
      } finally {
        await conn?.end();
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
    }
  });

  it("replays marker loss byte-for-byte and preserves write-once evidence and cutover", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0022(conn, fixtures);
      await seedFrozen0022Evidence(conn);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await first.close();
      await seedExecutionEvidence(conn);
      const before = await executionSnapshot(conn);
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      const replay = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await replay.close();
      const repeated = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await repeated.close();
      expect(await executionSnapshot(conn)).toEqual(before);
      await expect(conn.query(
        "UPDATE tenant_purge_execution_domain_acks SET affected_count=1 WHERE request_id=?",
        [REQUEST_ID],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "DELETE FROM tenant_purge_local_cutover_receipts WHERE request_id=?", [REQUEST_ID],
      )).rejects.toThrow(/append-only/i);
      await expect(conn.query(
        "UPDATE tenant_purge_execution_cutover SET activated_at_ms=6003 WHERE singleton_id=1",
      )).rejects.toThrow(/write-once/i);
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("repairs a same-name weak trigger and rejects an unknown extra trigger on replay", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0022(conn, fixtures);
      const first = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await first.close();
      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query("DROP TRIGGER trg_tenant_purge_exec_acks_bu");
      await conn.query(
        `CREATE TRIGGER trg_tenant_purge_exec_acks_bu
           BEFORE UPDATE ON tenant_purge_execution_domain_acks
           FOR EACH ROW SET NEW.affected_count=NEW.affected_count`,
      );
      const repaired = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await repaired.close();
      await assert0023Schema(conn);

      await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
      await conn.query(
        `CREATE TRIGGER trg_tenant_purge_exec_jobs_unexpected_bi
           BEFORE INSERT ON tenant_purge_execution_jobs
           FOR EACH ROW SET NEW.attempts=NEW.attempts`,
      );
      await expectMigrationFailure(
        url, only0023!, /invalid_tenant_purge_execution_trigger_set/i,
      );
      const [marker] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
      );
      expect(Number(marker[0]!.count)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("fails closed on a wrong same-name index, extra column, or weakened CHECK", async () => {
    const mutations = [
      `ALTER TABLE tenant_purge_execution_jobs
         DROP INDEX idx_tenant_purge_exec_jobs_claim,
         ADD KEY idx_tenant_purge_exec_jobs_claim (phase,request_id)`,
      "ALTER TABLE tenant_purge_execution_domain_acks ADD COLUMN leaked_secret TEXT NULL",
      `ALTER TABLE tenant_purge_execution_jobs
         DROP CHECK chk_tenant_purge_exec_job_progress,
         ADD CONSTRAINT chk_tenant_purge_exec_job_progress CHECK (TRUE)`,
    ];
    for (const mutation of mutations) {
      const database = databaseName();
      await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      const url = databaseUrl(baseUrl, database);
      let conn: Connection | undefined;
      try {
        conn = await mysql.createConnection({ uri: url, multipleStatements: true });
        await installFrozen0022(conn, fixtures);
        const first = await MysqlSessionStore.connect({
          url, migrationsDir: only0023!, connectionLimit: 1,
        });
        await first.close();
        await conn.query("DELETE FROM schema_migrations WHERE name=?", [MIGRATION_NAME]);
        await conn.query(mutation);
        await expectMigrationFailure(url, only0023!, /invalid_tenant_purge_execution_schema/i);
        const [marker] = await conn.query<Row[]>(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name=?", [MIGRATION_NAME],
        );
        expect(Number(marker[0]!.count)).toBe(0);
      } finally {
        await conn?.end();
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
    }
  });

  it("enforces 33-domain progress, ACK shape, and strict owner/generation foreign keys", async () => {
    const database = databaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await installFrozen0022(conn, fixtures);
      await seedFrozen0022Evidence(conn);
      const migrated = await MysqlSessionStore.connect({
        url, migrationsDir: only0023!, connectionLimit: 1,
      });
      await migrated.close();
      await expect(insertExecutionJob(conn, 32)).rejects.toMatchObject({
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
        sqlMessage: expect.stringMatching(/chk_tenant_purge_exec_job_progress/i),
      });
      await insertExecutionJob(conn);
      await expect(insertExecutionDomain(conn, TENANT_PURGE_PLAN_DOMAINS[0], "tenant-cross-owner"))
        .rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
      await insertExecutionDomain(conn);

      const invalidAck = (kind: string, outboxFields: string) => conn!.query(
        `INSERT INTO tenant_purge_execution_domain_acks
           (scope,request_id,tenant_id,subject_generation,plan_build_generation,
            execution_generation,domain,global_ack_seq,domain_ack_seq,
            previous_domain_ack_sha256,previous_global_ack_sha256,ack_kind,
            plan_entry_receipt_sha256,affected_count,result_count,result_root_sha256,
            adapter_protocol,operation_sha256,physical_proof_sha256,
            completed_claim_attempt,completed_claim_token_sha256,store_db_timestamp_ms,
            final,outbox_kind,outbox_id,deletion_generation,target_sha256,
            scheduled_ack_sha256,receipt_sha256)
         VALUES ('tenant-purge-execution-domain-ack-v1',?,?,1,1,1,?,1,1,?,?,?,
                 LPAD('1',64,'0'),0,0,REPEAT('d',64),'mysql-local-v1',REPEAT('e',64),
                 REPEAT('f',64),1,REPEAT('a',64),6001,FALSE,${outboxFields},REPEAT('1',64))`,
        [
          REQUEST_ID,
          TENANT_ID,
          TENANT_PURGE_PLAN_DOMAINS[0],
          EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
          EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
          kind,
        ],
      );
      await expect(invalidAck("outbox_scheduled", "NULL,NULL,NULL,NULL,NULL"))
        .rejects.toMatchObject({
          code: "ER_CHECK_CONSTRAINT_VIOLATED",
          sqlMessage: expect.stringMatching(/chk_tenant_purge_exec_ack_outbox/i),
        });
      await expect(invalidAck(
        "physical_delete", "'blob_delete',1,1,REPEAT('2',64),NULL",
      )).rejects.toMatchObject({
        code: "ER_CHECK_CONSTRAINT_VIOLATED",
        sqlMessage: expect.stringMatching(/chk_tenant_purge_exec_ack_outbox/i),
      });
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
