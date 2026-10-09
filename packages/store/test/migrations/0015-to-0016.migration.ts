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
const FIXTURE_PATH = resolve(HERE, "../fixtures/mysql-0015.sql");
const MIGRATION_PATH = resolve(HERE, "../../migrations/0016_erasure_purge_policy_authority.sql");
const MIGRATION_0018_PATH = resolve(HERE, "../../migrations/0018_tenant_credential_revocation_fence.sql");

type Row = RowDataPacket;

const MIGRATION_0016_TABLES = [
  "erasure_policy_evaluation_jobs",
  "erasure_purge_targets",
  "erasure_policy_evaluation_decisions",
  "erasure_purge_authority_controls",
  "erasure_purge_authorities",
] as const;

const IMMUTABLE_0016_TRIGGERS = [
  "trg_erasure_policy_decisions_bd",
  "trg_erasure_policy_decisions_bd_guard_a",
  "trg_erasure_policy_decisions_bd_guard_b",
  "trg_erasure_policy_decisions_bu",
  "trg_erasure_policy_decisions_bu_guard_a",
  "trg_erasure_policy_decisions_bu_guard_b",
  "trg_erasure_purge_authorities_bd",
  "trg_erasure_purge_authorities_bd_guard_a",
  "trg_erasure_purge_authorities_bd_guard_b",
  "trg_erasure_purge_authorities_bu",
  "trg_erasure_purge_authorities_bu_guard_a",
  "trg_erasure_purge_authorities_bu_guard_b",
  "trg_erasure_purge_targets_bd",
  "trg_erasure_purge_targets_bd_guard_a",
  "trg_erasure_purge_targets_bd_guard_b",
  "trg_erasure_purge_targets_bu",
  "trg_erasure_purge_targets_bu_guard_a",
  "trg_erasure_purge_targets_bu_guard_b",
] as const;

const IMMUTABLE_TRIGGER_FAMILIES = [
  "trg_erasure_policy_decisions_bd",
  "trg_erasure_policy_decisions_bu",
  "trg_erasure_purge_authorities_bd",
  "trg_erasure_purge_authorities_bu",
  "trg_erasure_purge_targets_bd",
  "trg_erasure_purge_targets_bu",
] as const;

const FROZEN_0015_MIGRATIONS = [
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
] as const;

const PRESERVED_TABLES = [
  ["sessions", "session_id"],
  ["turns", "turn_id"],
  ["items", "item_id"],
  ["events", "session_id, seq"],
  ["approvals", "approval_id"],
  ["idempotency_keys", "tenant_id, user_id, session_id, idem_key"],
  ["usage_ledger", "id"],
  ["billing_usage_facts", "usage_id"],
  ["usage_reconciliations", "session_id, deletion_generation"],
  ["lifecycle_outbox", "outbox_id"],
  ["blob_objects", "blob_id"],
  ["subject_lifecycle", "tenant_id, subject_kind, subject_id"],
  ["erasure_requests", "request_id"],
  ["erasure_audit_events", "request_id, seq"],
  ["erasure_job_control_events", "control_event_id"],
  ["erasure_job_terminal_incidents", "terminal_incident_id"],
  ["retention_policy_versions", "tenant_id, policy_version"],
  ["retention_policy_controls", "tenant_id"],
  ["retention_policy_activation_events", "event_id"],
  ["legal_hold_controls", "tenant_id, subject_kind, subject_id"],
  ["legal_holds", "tenant_id, hold_id"],
  ["legal_hold_events", "event_id"],
] as const;

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

async function preservedSnapshot(conn: Connection): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const [table, orderBy] of PRESERVED_TABLES) {
    const [rows] = await conn.query<Row[]>(`SELECT * FROM \`${table}\` ORDER BY ${orderBy}`);
    snapshot[table] = normalize(rows.map((row) => ({ ...row })));
  }
  return snapshot;
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
    `SELECT INDEX_NAME AS index_name, COLUMN_NAME AS column_name,
            NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq_in_index
       FROM information_schema.statistics
      WHERE table_schema=DATABASE() AND table_name=?
      ORDER BY index_name, seq_in_index`,
    [table],
  );
  const result: Record<string, { columns: string[]; unique: boolean }> = {};
  for (const row of rows) {
    const name = String(row.index_name);
    const entry = result[name] ?? { columns: [], unique: Number(row.non_unique) === 0 };
    entry.columns.push(String(row.column_name));
    result[name] = entry;
  }
  return result;
}

async function triggerNames(conn: Connection): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    `SELECT TRIGGER_NAME AS trigger_name
       FROM information_schema.triggers
      WHERE trigger_schema=DATABASE()
        AND event_object_table IN (
          'erasure_purge_targets',
          'erasure_policy_evaluation_decisions',
          'erasure_purge_authorities'
        )
      ORDER BY trigger_name`,
  );
  return rows.map((row) => String(row.trigger_name));
}

async function expectEveryImmutableTriggerFamilyGuarded(conn: Connection): Promise<void> {
  const names = new Set(await triggerNames(conn));
  for (const base of IMMUTABLE_TRIGGER_FAMILIES) {
    expect([
      base,
      `${base}_guard_a`,
      `${base}_guard_b`,
    ].some((name) => names.has(name)), `missing live append-only guard for ${base}`).toBe(true);
  }
}

async function expectDestructiveDormancy(conn: Connection): Promise<void> {
  const [rows] = await conn.query<Row[]>(
    `SELECT
       (SELECT COUNT(*) FROM erasure_policy_evaluation_jobs) AS jobs,
       (SELECT COUNT(*) FROM erasure_purge_targets) AS targets,
       (SELECT COUNT(*) FROM erasure_policy_evaluation_decisions) AS decisions,
       (SELECT COUNT(*) FROM erasure_purge_authority_controls) AS authority_controls,
       (SELECT COUNT(*) FROM erasure_purge_authorities) AS authorities,
       (SELECT COUNT(*) FROM sessions WHERE purge_after_ms IS NOT NULL) AS scheduled_sessions,
       (SELECT COUNT(*) FROM blob_objects WHERE delete_after_ms IS NOT NULL) AS scheduled_blobs,
       (SELECT COUNT(*) FROM lifecycle_outbox
         WHERE topic='session.purge'
           AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL
             OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL
             OR dead_lettered_at_ms IS NOT NULL)) AS claimable_purge_intents`,
  );
  expect(rows[0]).toMatchObject({
    jobs: 0,
    targets: 0,
    decisions: 0,
    authority_controls: 0,
    authorities: 0,
    scheduled_sessions: 0,
    scheduled_blobs: 0,
    claimable_purge_intents: 0,
  });
}

async function insertTargetEvidence(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO erasure_purge_targets
      (request_id, build_generation, tenant_id, user_id, session_id, deletion_generation,
       deleted_at_ms, session_content_deadline_ms, ready_blob_count, ready_blob_root_sha256,
       ready_blob_deadline_ms, operational_usage_status, operational_usage_verified_at_ms,
       operational_usage_checksum, operational_usage_deadline_ms, idempotency_receipt_count,
       idempotency_receipt_deadline_ms, export_artifact_disposition, billing_fact_disposition,
       lifecycle_audit_disposition, issue_codes, evidence_sha256)
     VALUES
      ('erase_00000000-0000-4000-8000-000000000015',1,'tenant_a','user_bound','sess_0199aabb-ccdd-7001-8000-000000000015',1,
       900,1900,1,REPEAT('1',64),1900,'verified',905,
       REPEAT('3',64),2905,2,3900,'not_applicable','retained','retained',
       JSON_ARRAY(),REPEAT('4',64))`,
  );
}

async function insertDecisionEvidence(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO erasure_policy_evaluation_decisions
      (request_id, decision_seq, build_generation, decision, policy_version, policy_sha256,
       user_grace_deadline_ms, eligibility_deadline_ms, target_count, target_root_sha256,
       tenant_hold_control_generation, tenant_hold_projection_sha256,
       user_hold_control_generation, user_hold_projection_sha256,
       before_sha256, after_sha256, decided_at_ms)
     VALUES
      ('erase_00000000-0000-4000-8000-000000000015',1,1,'held','policy-v1',REPEAT('a',64),
       1300,3900,1,REPEAT('4',64),0,
       'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f',
       1,REPEAT('d',64),REPEAT('0',64),REPEAT('5',64),1000)`,
  );
}

async function insertAuthorityEvidence(conn: Connection): Promise<void> {
  await conn.query(
    `INSERT INTO erasure_purge_authorities
      (request_id, authority_generation, tenant_id, subject_kind, subject_id,
       subject_generation, build_generation, policy_version, policy_sha256, policy_schema_version,
       user_grace_deadline_ms, eligibility_deadline_ms, target_count, target_root_sha256,
       tenant_hold_control_generation, tenant_hold_projection_sha256,
       user_hold_control_generation, user_hold_projection_sha256, decision_sha256,
       authority_sha256, created_at_ms)
     VALUES
      ('erase_00000000-0000-4000-8000-000000000015',1,'tenant_a','user','user_bound',1,1,'policy-v1',REPEAT('a',64),1,
       1300,3900,1,REPEAT('4',64),0,
       'd336a3d705ffe91a7158c28e0e39f45cbc278d4a8890c738d9da03a164fd140f',
       1,REPEAT('d',64),REPEAT('5',64),REPEAT('6',64),1000)`,
  );
}

describe("real MySQL historical upgrade: 0015 -> 0016", () => {
  let baseUrl: URL;
  let admin: Connection;
  let fixtureSql: string;
  let migrationStatements: string[];
  let only0016: string | undefined;
  let runtime0016And0018: string | undefined;

  beforeAll(async () => {
    baseUrl = assertDisposableMigrationTarget(BASE_URL);
    fixtureSql = await readFile(FIXTURE_PATH, "utf8");
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    migrationStatements = migrationSql
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*\n/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TABLE")))
      .toHaveLength(5);
    expect(migrationStatements.filter((statement) => statement.startsWith("CREATE TRIGGER")))
      .toHaveLength(24);
    only0016 = await mkdtemp(join(tmpdir(), "agent-service-migration-only-0016-"));
    await copyFile(MIGRATION_PATH, join(only0016, "0016_erasure_purge_policy_authority.sql"));
    runtime0016And0018 = await mkdtemp(join(tmpdir(), "agent-service-migration-runtime-0016-0018-"));
    await copyFile(MIGRATION_PATH, join(runtime0016And0018, "0016_erasure_purge_policy_authority.sql"));
    await copyFile(
      MIGRATION_0018_PATH,
      join(runtime0016And0018, "0018_tenant_credential_revocation_fence.sql"),
    );
    admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
  });

  afterAll(async () => {
    await admin?.end();
    if (only0016) await rm(only0016, { recursive: true, force: true });
    if (runtime0016And0018) await rm(runtime0016And0018, { recursive: true, force: true });
  });

  it("loads the frozen 0015 lifecycle states before any 0016 schema exists", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({
        uri: databaseUrl(baseUrl, database),
        multipleStatements: true,
      });
      await conn.query(fixtureSql);

      const [markers] = await conn.query<Row[]>("SELECT name FROM schema_migrations ORDER BY name");
      expect(markers.map((row) => String(row.name))).toEqual(FROZEN_0015_MIGRATIONS);
      const [newTables] = await conn.query<Row[]>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema=DATABASE()
            AND table_name IN (${MIGRATION_0016_TABLES.map(() => "?").join(",")})`,
        [...MIGRATION_0016_TABLES],
      );
      expect(newTables).toEqual([]);

      const [requests] = await conn.query<Row[]>(
        `SELECT request_id, status, policy_version, policy_hash, available_at_ms,
                attempts, claim_token, lease_until_ms
           FROM erasure_requests ORDER BY request_id`,
      );
      expect(requests).toEqual([
        expect.objectContaining({
          request_id: "erase_00000000-0000-4000-8000-000000000015",
          status: "awaiting_purge_policy",
          policy_version: "policy-v1",
          policy_hash: "da82935fcc53d70d1f7b98e6cb985bdb53b0d54be64689a7648f1a596b986dc4",
          available_at_ms: null,
        }),
        expect.objectContaining({
          request_id: "erase_00000000-0000-4000-8000-000000000016",
          status: "awaiting_purge_policy",
          policy_version: null,
          policy_hash: null,
          available_at_ms: null,
        }),
        expect.objectContaining({
          request_id: "erase_00000000-0000-4000-8000-000000000017",
          status: "purging",
          policy_version: "policy-v1",
          available_at_ms: 932,
          attempts: 2,
          claim_token: "legacy-claim-token-0015",
          lease_until_ms: 5000,
        }),
      ]);
      const [purge] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS total,
                SUM(available_at_ms IS NOT NULL OR claim_token IS NOT NULL
                  OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL) AS claimable
           FROM lifecycle_outbox WHERE topic='session.purge'`,
      );
      expect(purge[0]).toMatchObject({ total: 3, claimable: "0" });
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("expands the full 0015 fixture without changing policy, hold, audit, or content rows", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const before = await preservedSnapshot(conn);

      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0016!, connectionLimit: 1 });
      await store.close();

      expect(await preservedSnapshot(conn)).toEqual(before);
      expect(await tableColumns(conn, "erasure_policy_evaluation_jobs")).toEqual([
        "request_id", "tenant_id", "subject_kind", "subject_id", "subject_generation",
        "build_generation", "cursor_session_id", "target_count", "target_root_sha256",
        "available_at_ms", "attempts", "claim_token", "lease_until_ms", "last_error_code",
        "sealed_at_ms", "created_at_ms", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "erasure_purge_targets")).toEqual([
        "request_id", "build_generation", "tenant_id", "user_id", "session_id",
        "deletion_generation", "deleted_at_ms", "session_content_deadline_ms",
        "ready_blob_count", "ready_blob_root_sha256", "ready_blob_deadline_ms",
        "operational_usage_status", "operational_usage_verified_at_ms",
        "operational_usage_checksum", "operational_usage_deadline_ms",
        "idempotency_receipt_count", "idempotency_receipt_deadline_ms",
        "export_artifact_disposition", "billing_fact_disposition",
        "lifecycle_audit_disposition", "issue_codes", "evidence_sha256",
      ]);
      expect(await tableColumns(conn, "erasure_policy_evaluation_decisions")).toEqual([
        "request_id", "decision_seq", "build_generation", "decision", "policy_version",
        "policy_sha256", "user_grace_deadline_ms", "eligibility_deadline_ms", "target_count",
        "target_root_sha256", "tenant_hold_control_generation", "tenant_hold_projection_sha256",
        "user_hold_control_generation", "user_hold_projection_sha256", "before_sha256",
        "after_sha256", "decided_at_ms",
      ]);
      expect(await tableColumns(conn, "erasure_purge_authority_controls")).toEqual([
        "request_id", "authority_generation", "active_authority_sha256", "updated_at_ms",
      ]);
      expect(await tableColumns(conn, "erasure_purge_authorities")).toEqual([
        "request_id", "authority_generation", "tenant_id", "subject_kind", "subject_id",
        "subject_generation", "build_generation", "policy_version", "policy_sha256",
        "policy_schema_version", "user_grace_deadline_ms", "eligibility_deadline_ms",
        "target_count", "target_root_sha256", "tenant_hold_control_generation",
        "tenant_hold_projection_sha256", "user_hold_control_generation",
        "user_hold_projection_sha256", "decision_sha256", "authority_sha256", "created_at_ms",
      ]);

      const jobIndexes = await tableIndexes(conn, "erasure_policy_evaluation_jobs");
      expect(jobIndexes.PRIMARY).toEqual({ columns: ["request_id"], unique: true });
      expect(jobIndexes.uk_erasure_policy_job_subject_generation).toEqual({
        columns: ["tenant_id", "subject_kind", "subject_id", "subject_generation"],
        unique: true,
      });
      const targetIndexes = await tableIndexes(conn, "erasure_purge_targets");
      expect(targetIndexes.PRIMARY).toEqual({
        columns: ["request_id", "build_generation", "session_id"],
        unique: true,
      });
      const authorityIndexes = await tableIndexes(conn, "erasure_purge_authorities");
      expect(authorityIndexes.PRIMARY).toEqual({
        columns: ["request_id", "authority_generation"],
        unique: true,
      });
      expect(await triggerNames(conn)).toEqual([...IMMUTABLE_0016_TRIGGERS]);

      await expectDestructiveDormancy(conn);
      const [markers] = await conn.query<Row[]>(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0016_erasure_purge_policy_authority.sql'",
      );
      expect(Number(markers[0]!.count)).toBe(1);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("converges after partial DDL and marker-loss replay without rewriting evidence", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const preservedBefore = await preservedSnapshot(conn);
      for (const statement of migrationStatements.slice(0, 3)) await conn.query(statement);
      const [partial] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM information_schema.tables
            WHERE table_schema=DATABASE()
              AND table_name IN ('erasure_policy_evaluation_jobs','erasure_purge_targets',
                                 'erasure_policy_evaluation_decisions')) AS partial_tables,
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0016_erasure_purge_policy_authority.sql') AS marker_count`,
      );
      expect(partial[0]).toMatchObject({ partial_tables: 3, marker_count: 0 });
      await insertTargetEvidence(conn);

      const first = await MysqlSessionStore.connect({ url, migrationsDir: only0016!, connectionLimit: 1 });
      await first.close();
      const [targetBeforeReplay] = await conn.query<Row[]>(
        "SELECT * FROM erasure_purge_targets WHERE request_id='erase_00000000-0000-4000-8000-000000000015'",
      );
      expect(targetBeforeReplay).toHaveLength(1);

      await conn.query(
        "DELETE FROM schema_migrations WHERE name='0016_erasure_purge_policy_authority.sql'",
      );
      for (const statement of migrationStatements) {
        await conn.query(statement);
        if (/^(?:DROP|CREATE) TRIGGER\b/.test(statement)) {
          await expectEveryImmutableTriggerFamilyGuarded(conn);
        }
      }
      expect(await triggerNames(conn)).toEqual([...IMMUTABLE_0016_TRIGGERS]);
      const firstReplayDrop = migrationStatements.find((statement) => (
        statement.startsWith("DROP TRIGGER IF EXISTS trg_erasure_purge_targets_bu_bootstrap")
      ));
      expect(firstReplayDrop).toBeDefined();
      await conn.query(firstReplayDrop!);
      await expectEveryImmutableTriggerFamilyGuarded(conn);
      const replay = await MysqlSessionStore.connect({ url, migrationsDir: only0016!, connectionLimit: 1 });
      await replay.close();

      const [targetAfterReplay] = await conn.query<Row[]>(
        "SELECT * FROM erasure_purge_targets WHERE request_id='erase_00000000-0000-4000-8000-000000000015'",
      );
      expect(normalize(targetAfterReplay)).toEqual(normalize(targetBeforeReplay));
      expect(await preservedSnapshot(conn)).toEqual(preservedBefore);
      expect(await triggerNames(conn)).toEqual([...IMMUTABLE_0016_TRIGGERS]);
      const [dormancy] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM erasure_policy_evaluation_jobs) AS jobs,
          (SELECT COUNT(*) FROM erasure_policy_evaluation_decisions) AS decisions,
          (SELECT COUNT(*) FROM erasure_purge_authority_controls) AS authority_controls,
          (SELECT COUNT(*) FROM erasure_purge_authorities) AS authorities,
          (SELECT COUNT(*) FROM lifecycle_outbox
            WHERE topic='session.purge' AND available_at_ms IS NOT NULL) AS available_purge,
          (SELECT COUNT(*) FROM schema_migrations
            WHERE name='0016_erasure_purge_policy_authority.sql') AS marker_count`,
      );
      expect(dormancy[0]).toMatchObject({
        jobs: 0,
        decisions: 0,
        authority_controls: 0,
        authorities: 0,
        available_purge: 0,
        marker_count: 1,
      });
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("runs the evaluator against the upgraded historical rows without enabling purge", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    let store: MysqlSessionStore | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      // Evaluate the historical 0016 rows only after the latest runtime's additive 0018 schema
      // dependency is installed. Empty 0018 tables preserve the pre-admission behavior without
      // teaching workers to interpret a missing safety table as an absent fence.
      store = await MysqlSessionStore.connect({
        url,
        migrationsDir: runtime0016And0018!,
        connectionLimit: 2,
      });
      expect(await store.scheduleAwaitingErasurePolicyEvaluations({
        nowMs: 10_000,
        limit: 10,
      })).toBe(2);
      const claims = await store.claimErasurePolicyEvaluations({
        nowMs: 10_000,
        limit: 10,
        leaseMs: 1_000,
        claimToken: "historical-evaluator-0016",
      });
      const bound = claims.find((claim) => (
        claim.requestId === "erase_00000000-0000-4000-8000-000000000015"
      ));
      expect(bound).toBeDefined();
      await store.buildErasurePurgeTargetPage(bound!, { nowMs: 10_001, limit: 10 });
      expect((await store.listErasurePurgeTargetEvidence(bound!.requestId, 1))[0]).toMatchObject({
        sessionId: "sess_0199aabb-ccdd-7001-8000-000000000015",
        readyBlobCount: 1,
        operationalUsageStatus: "verified",
        idempotencyReceiptCount: 2,
        idempotencyReceiptDeadlineMs: 6000,
        issueCodes: [],
      });
      const sealed = await store.sealErasurePurgeAuthority(bound!, { nowMs: 10_002 });
      expect(sealed.decision.decision).toBe("held");
      expect(sealed.authority).toBeUndefined();

      const [columnRows] = await conn.query<Row[]>(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS max_length
           FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name='erasure_purge_targets'
            AND column_name='operational_usage_status'`,
      );
      expect(Number(columnRows[0]!.max_length)).toBe(32);
      const [legacyReceiptRows] = await conn.query<Row[]>(
        `SELECT value, expires_at_ms FROM idempotency_keys
          WHERE tenant_id='tenant_a' AND user_id='user_bound'
            AND session_id='sess_0199aabb-ccdd-7001-8000-000000000015'
            AND idem_key='legacy-pending'`,
      );
      expect(legacyReceiptRows[0]).toMatchObject({ value: null, expires_at_ms: 10 });
      const [purgeRows] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS claimable FROM lifecycle_outbox
          WHERE topic='session.purge'
            AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL
              OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL
              OR dead_lettered_at_ms IS NOT NULL)`,
      );
      expect(Number(purgeRows[0]!.claimable)).toBe(0);
    } finally {
      await store?.close();
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });

  it("rejects same-key different-content evidence and keeps immutable originals", async () => {
    const database = fixtureDatabaseName();
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
    const url = databaseUrl(baseUrl, database);
    let conn: Connection | undefined;
    try {
      conn = await mysql.createConnection({ uri: url, multipleStatements: true });
      await conn.query(fixtureSql);
      const store = await MysqlSessionStore.connect({ url, migrationsDir: only0016!, connectionLimit: 1 });
      await store.close();

      await insertTargetEvidence(conn);
      await insertDecisionEvidence(conn);
      await insertAuthorityEvidence(conn);
      const [before] = await conn.query<Row[]>(
        `SELECT
          (SELECT evidence_sha256 FROM erasure_purge_targets
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND build_generation=1
              AND session_id='sess_0199aabb-ccdd-7001-8000-000000000015') AS target_hash,
          (SELECT decision FROM erasure_policy_evaluation_decisions
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND decision_seq=1) AS decision,
          (SELECT authority_sha256 FROM erasure_purge_authorities
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND authority_generation=1) AS authority_hash`,
      );

      await expect(conn.query(
        `INSERT INTO erasure_purge_targets
          (request_id, build_generation, tenant_id, user_id, session_id, deletion_generation,
           deleted_at_ms, ready_blob_count, ready_blob_root_sha256, operational_usage_status,
           operational_usage_verified_at_ms, operational_usage_checksum,
           idempotency_receipt_count, export_artifact_disposition, billing_fact_disposition,
           lifecycle_audit_disposition, issue_codes, evidence_sha256)
         VALUES
          ('erase_00000000-0000-4000-8000-000000000015',1,'tenant_a','user_bound','sess_0199aabb-ccdd-7001-8000-000000000015',1,
           901,0,REPEAT('7',64),'verified',905,REPEAT('3',64),0,
           'not_applicable','retained','retained',JSON_ARRAY('tombstone_invalid'),REPEAT('8',64))`,
      )).rejects.toThrow(/Duplicate entry/);
      await expect(conn.query(
        `INSERT INTO erasure_policy_evaluation_decisions
          (request_id, decision_seq, build_generation, decision, target_count,
           target_root_sha256, tenant_hold_control_generation, tenant_hold_projection_sha256,
           user_hold_control_generation, user_hold_projection_sha256, before_sha256,
           after_sha256, decided_at_ms)
         VALUES
          ('erase_00000000-0000-4000-8000-000000000015',1,1,'invalid',0,REPEAT('7',64),0,REPEAT('8',64),
           0,REPEAT('9',64),REPEAT('0',64),REPEAT('1',64),1001)`,
      )).rejects.toThrow(/Duplicate entry/);
      await expect(conn.query(
        `INSERT INTO erasure_purge_authorities
          (request_id, authority_generation, tenant_id, subject_kind, subject_id,
           subject_generation, build_generation, policy_version, policy_sha256,
           policy_schema_version, user_grace_deadline_ms, eligibility_deadline_ms, target_count,
           target_root_sha256, tenant_hold_control_generation, tenant_hold_projection_sha256,
           user_hold_control_generation, user_hold_projection_sha256, decision_sha256,
           authority_sha256, created_at_ms)
         VALUES
          ('erase_00000000-0000-4000-8000-000000000015',1,'tenant_a','user','user_bound',1,2,'policy-v1',REPEAT('a',64),1,
           1300,3900,0,REPEAT('7',64),0,REPEAT('8',64),0,REPEAT('9',64),
           REPEAT('1',64),REPEAT('2',64),1001)`,
      )).rejects.toThrow(/Duplicate entry/);

      await expect(conn.query(
        "UPDATE erasure_purge_targets SET deleted_at_ms=901 WHERE request_id='erase_00000000-0000-4000-8000-000000000015'",
      )).rejects.toThrow(/append-only/);
      await expect(conn.query(
        "DELETE FROM erasure_policy_evaluation_decisions WHERE request_id='erase_00000000-0000-4000-8000-000000000015'",
      )).rejects.toThrow(/append-only/);
      await expect(conn.query(
        "UPDATE erasure_purge_authorities SET created_at_ms=1001 WHERE request_id='erase_00000000-0000-4000-8000-000000000015'",
      )).rejects.toThrow(/append-only/);

      const [after] = await conn.query<Row[]>(
        `SELECT
          (SELECT evidence_sha256 FROM erasure_purge_targets
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND build_generation=1
              AND session_id='sess_0199aabb-ccdd-7001-8000-000000000015') AS target_hash,
          (SELECT decision FROM erasure_policy_evaluation_decisions
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND decision_seq=1) AS decision,
          (SELECT authority_sha256 FROM erasure_purge_authorities
            WHERE request_id='erase_00000000-0000-4000-8000-000000000015' AND authority_generation=1) AS authority_hash`,
      );
      expect(after).toEqual(before);

      const [purge] = await conn.query<Row[]>(
        `SELECT COUNT(*) AS claimable
           FROM lifecycle_outbox
          WHERE topic='session.purge'
            AND (available_at_ms IS NOT NULL OR claim_token IS NOT NULL
              OR lease_until_ms IS NOT NULL OR completed_at_ms IS NOT NULL)`,
      );
      expect(Number(purge[0]!.claimable)).toBe(0);
    } finally {
      await conn?.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    }
  });
});
