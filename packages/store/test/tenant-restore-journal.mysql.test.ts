import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY, type TenantAuthPolicy } from "@agent-service/protocol";
import mysql, { type Connection as NativeConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  SessionAuthorityError,
  SubjectDeletingError,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  TenantErasureIntegrityError,
  TenantRestoreJournalPublicationDependencyPendingError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalPublicationReceiptSha256,
  tenantRestoreJournalPublicationTargetAckRootSha256,
  tenantRestoreJournalPublicationTargetAckSha256,
  tenantRestoreJournalRecordSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  userErasureRequestHash,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalPublicationAuthorization,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
  type TenantCredentialRevocationAuthorization,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import { GenericJournalMysqlRuntimeOwner } from "./fixtures/generic-journal-mysql.js";
import type { CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createMysqlOperationAbortTransport } from "../src/mysql/operation-abort.js";
import { witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

const AUTH_POLICY: TenantAuthPolicy = {
  mode: "end_user_token",
  tokenHeader: "x-end-user-token",
  verifier: {
    kind: "jwt",
    hs256: true,
    algorithms: ["HS256"],
    subjectClaim: "sub",
    clockToleranceSec: 0,
  },
};

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function target(): TenantRestoreJournalTargetDescriptor {
  return {
    targetOrdinal: 0,
    targetSha256: sha256("mysql-restore-target"),
    failureDomainSha256: sha256("mysql-restore-failure-domain"),
    adapterProtocol: "mysql-restore-journal-test-v1",
    journalNamespaceSha256: sha256("mysql-restore-journal-namespace"),
  };
}

function emptyHead(
  configured: TenantRestoreJournalTargetDescriptor,
  logicalDatabaseNamespaceSha256: string,
): TenantRestoreReplaySealedTarget {
  return {
    ...configured,
    logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0,
    sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  };
}

async function activate(owner: GenericJournalMysqlRuntimeOwner): Promise<{
  configured: TenantRestoreJournalTargetDescriptor;
  logicalDatabaseNamespaceSha256: string;
  controlEvidenceSha256: string;
  runtimeEpochSha256: string;
}> {
  const configured = target();
  const logicalDatabaseNamespaceSha256 =
    tenantRestoreLogicalDatabaseNamespaceSha256("mysql-restore-logical-db");
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`primary-${randomUUID()}`);
  await owner.activatePrimary({
    adapterProtocol: configured.adapterProtocol,
    journalNamespaceSha256: configured.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256,
    targets: [configured],
    observedHeads: [emptyHead(configured, logicalDatabaseNamespaceSha256)],
  });
  const store = await owner.openStore(1);
  let control: Awaited<ReturnType<MysqlSessionStore["getTenantRestoreJournalControl"]>>;
  try { control = await store.getTenantRestoreJournalControl(); } finally { await store.close(); }
  if (control.controlGeneration !== 1) throw new Error("Generic journal primary activation did not become active");
  return {
    configured,
    logicalDatabaseNamespaceSha256,
    controlEvidenceSha256: control.evidenceSha256,
    runtimeEpochSha256,
  };
}

function authorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantRestoreJournalPublications"]>>[number],
): TenantRestoreJournalPublicationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    publicationGeneration: claim.publicationGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function revocationAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantCredentialRevocations"]>>[number],
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function appendResult(
  configured: TenantRestoreJournalTargetDescriptor,
  logicalDatabaseNamespaceSha256: string,
  record: TenantRestoreJournalRecord,
  remoteSequence = 1,
  previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
): TenantRestoreJournalAdapterResult {
  return {
    adapterProtocol: configured.adapterProtocol,
    journalNamespaceSha256: configured.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    targetSha256: configured.targetSha256,
    remoteSequence,
    previousHeadRootSha256,
    headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
      previousHeadRootSha256,
      targetSha256: configured.targetSha256,
      remoteSequence,
      operationSha256: record.operationSha256,
      recordSha256: record.recordSha256,
    }),
    record,
    replayed: false,
  };
}

function standaloneRecord(
  logicalDatabaseNamespaceSha256: string,
  tenantId: string,
): TenantRestoreJournalRecord {
  const requestId = newErasureRequestId();
  const t1FenceSha256 = sha256(`restore-only-t1-${tenantId}`);
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256,
    requestId,
    tenantId,
    subjectGeneration: 7,
    t1FenceSha256,
  });
  const body = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256,
    requestId,
    tenantId,
    subjectGeneration: 7,
    t1FenceSha256,
    operationSha256,
  };
  return { ...body, recordSha256: tenantRestoreJournalRecordSha256(body) };
}

async function seedTenant(store: MysqlSessionStore, tenantId: string): Promise<void> {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.createSession(mkSession(tenantId, `user-${randomUUID()}`));
}

async function activateExportPolicy(store: MysqlSessionStore, tenantId: string): Promise<void> {
  const atMs = Date.now() - 60_000;
  const policyVersion = `restore-export-policy-${randomUUID()}`;
  await store.putRetentionPolicy({
    tenantId,
    policyVersion,
    policy: {
      sessionContentRetentionMs: null,
      userErasureGraceMs: null,
      operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: null,
      billingFactRetentionMs: null,
      lifecycleAuditRetentionMs: null,
      exportArtifactTtlMs: 10 * 60_000,
    },
    actorKeyId: "restore-journal-mysql-test",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion,
    expectedControlGeneration: 0,
    actorKeyId: "restore-journal-mysql-test",
    atMs: atMs + 1,
  });
}

async function requestExport(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  label: string,
) {
  return store.requestUserDataExport({
    requestId: newUserDataExportRequestId(),
    tenantId,
    userId,
    requestedByKeyId: "restore-journal-mysql-test",
    idempotencyKeySha256: userDataExportIdempotencyKeySha256(`${label}-${randomUUID()}`),
    requestHash: userDataExportRequestHash(tenantId, userId),
  });
}

async function prepareDownloadLease(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
): Promise<{ artifactId: string; leaseToken: string }> {
  const request = await requestExport(store, tenantId, userId, "download-before-restore");
  const claim = (await store.claimUserDataExports({
    limit: 100,
    leaseMs: 60_000,
    claimToken: `restore-export-worker-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === request.requestId);
  expect(claim).toBeDefined();
  const auth = userDataExportAuthorization(claim!);
  const summary = await store.captureAndSealUserDataExportSnapshot(auth);
  const artifactId = newUserDataExportArtifactId();
  await store.startUserDataExportArtifact(auth, {
    artifactId,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    stagingTtlMs: 60_000,
  });
  const storageKey = userDataExportStorageKey(
    { tenantId, userId },
    request.requestId,
    artifactId,
    0,
  );
  await store.stageUserDataExportPart(auth, {
    artifactId,
    partNumber: 0,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey,
    uploadToken: `restore-export-upload-${randomUUID()}`,
  });
  const bytes = Buffer.from(`restore-export:${request.requestId}\n`, "utf8");
  const part = await store.markUserDataExportPartUploaded(auth, {
    artifactId,
    partNumber: 0,
    descriptor: {
      storageKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    },
  });
  await store.completeUserDataExportArtifact(auth, {
    artifactId,
    snapshotAtMs: summary.snapshotAtMs,
    partCount: 1,
    recordCount: summary.recordCount,
    totalSizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: userDataExportManifestSha256([part]),
  });
  const leaseToken = `restore-download-${randomUUID()}`;
  await expect(store.acquireUserDataExportDownload(
    tenantId,
    userId,
    request.requestId,
    leaseToken,
    60_000,
  )).resolves.toMatchObject({ leaseToken });
  return { artifactId, leaseToken };
}

async function waitForMysqlRowLockWaiters(
  observer: Connection,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const [rows] = await observer.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID) AS waiter_count
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks l
           ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
        WHERE l.OBJECT_SCHEMA=DATABASE()
          AND l.OBJECT_NAME='tenant_restore_journal_jobs'`,
    );
    if (Number(rows[0]?.waiter_count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${expected} MySQL row-lock waiters`);
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("concurrent MySQL operations timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}


type OwnedNativeConnection = { connection: NativeConnection; close(): Promise<void> };
async function ownedNativeConnection(url: string, signal: AbortSignal): Promise<OwnedNativeConnection> {
  const transport = createMysqlOperationAbortTransport(signal);
  let connection: NativeConnection | undefined, closing: Promise<void> | undefined;
  const abort = () => { connection?.destroy(); transport.close(); };
  signal.addEventListener("abort", abort, { once: true });
  const close = () => closing ??= (async () => {
    let failure: { reason: unknown } | undefined;
    try { await connection?.end(); } catch (reason) { failure = { reason }; }
    transport.close(); await transport.settled(); signal.removeEventListener("abort", abort);
    if (failure) throw failure.reason;
  })();
  try {
    signal.throwIfAborted();
    connection = await mysql.createConnection({ uri: url, stream: transport.stream, connectTimeout: 10_000 });
    signal.throwIfAborted();
    return { connection, close };
  } catch (reason) { abort(); await close().catch(() => {}); throw reason; }
}
const JOURNAL_GUARDS = [
  "trg_restore_journal_t3a_receipt_bi", "trg_restore_journal_t3a_job_bu",
  "trg_restore_journal_runtime_known_bd", "trg_restore_journal_entries_bu", "trg_restore_journal_entries_bd",
  "trg_restore_journal_acks_bu", "trg_restore_journal_jobs_bu", "trg_restore_journal_receipts_bu",
  "trg_restore_journal_runtime_bu", "trg_restore_journal_runtime_au",
  "trg_restore_journal_runtime_heads_bu", "trg_restore_journal_runs_bu",
] as const;
type JournalGuardName = typeof JOURNAL_GUARDS[number];
type SavedJournalGuard = { name: JournalGuardName; createSql: string; sqlMode: string; charset: string;
  collation: string; metadata: string; peers: Array<{ name: string; order: number }> };
async function ownedCleanup<T>(body: () => Promise<T>, cleanup: Array<() => Promise<unknown>>): Promise<T> {
  let failure: { reason: unknown } | undefined, value: T | undefined;
  try { value = await body(); } catch (reason) { failure = { reason }; }
  for (const close of cleanup) try { await close(); } catch (reason) { failure ??= { reason }; }
  if (failure) throw failure.reason; return value as T;
}
async function journalGuardRows(raw: Connection, name: JournalGuardName): Promise<RowDataPacket> {
  if (!JOURNAL_GUARDS.includes(name)) throw new Error("Unknown journal guard");
  const [rows] = await raw.query<RowDataPacket[]>("SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING,ACTION_ORIENTATION,ACTION_ORDER,"
    + "ACTION_STATEMENT,SQL_MODE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS "
    + "WHERE TRIGGER_SCHEMA=DATABASE() AND BINARY TRIGGER_NAME=BINARY ?", [name]);
  if (rows.length !== 1) throw new Error("Journal guard native metadata is missing");
  return rows[0]!;
}
async function saveJournalGuard(raw: Connection, name: JournalGuardName): Promise<SavedJournalGuard> {
  const metadata = await journalGuardRows(raw, name);
  const [rows] = await raw.query<RowDataPacket[]>("SHOW CREATE TRIGGER " + mysql.escapeId(name));
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row["SQL Original Statement"] !== "string" || typeof row.sql_mode !== "string"
    || typeof row.character_set_client !== "string" || typeof row.collation_connection !== "string"
    || !/^[A-Za-z0-9_]+$/.test(row.character_set_client) || !/^[A-Za-z0-9_]+$/.test(row.collation_connection)) {
    throw new Error("Journal guard native CREATE is invalid");
  }
  const [peers] = await raw.query<RowDataPacket[]>("SELECT TRIGGER_NAME,ACTION_ORDER FROM information_schema.TRIGGERS "
    + "WHERE TRIGGER_SCHEMA=DATABASE() AND BINARY EVENT_OBJECT_TABLE=BINARY ? AND EVENT_MANIPULATION=? AND ACTION_TIMING=? ORDER BY ACTION_ORDER",
    [metadata.EVENT_OBJECT_TABLE, metadata.EVENT_MANIPULATION, metadata.ACTION_TIMING]);
  if (!peers.length || peers.some(peer => typeof peer.TRIGGER_NAME !== "string" || !/^[a-z0-9_]+$/.test(peer.TRIGGER_NAME)
    || !Number.isSafeInteger(Number(peer.ACTION_ORDER)) || Number(peer.ACTION_ORDER) < 1)) throw new Error("Journal guard order is invalid");
  return { name, createSql: row["SQL Original Statement"], sqlMode: row.sql_mode,
    charset: row.character_set_client, collation: row.collation_connection, metadata: JSON.stringify(metadata),
    peers: peers.map(peer => ({ name: peer.TRIGGER_NAME as string, order: Number(peer.ACTION_ORDER) })) };
}
async function restoreJournalGuard(raw: Connection, saved: SavedJournalGuard): Promise<void> {
  const [sessions] = await raw.query<RowDataPacket[]>("SELECT @@SESSION.sql_mode AS mode,@@SESSION.character_set_client AS client,"
    + "@@SESSION.character_set_results AS results,@@SESSION.collation_connection AS collation");
  const previous = sessions[0];
  if (sessions.length !== 1 || !previous || typeof previous.mode !== "string" || typeof previous.client !== "string"
    || previous.results !== null && typeof previous.results !== "string" || typeof previous.collation !== "string") throw new Error("Journal guard session is invalid");
  await ownedCleanup(async () => {
    const [current] = await raw.query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()");
    const names = new Set(current.map(row => row.TRIGGER_NAME));
    if (names.has(saved.name)) await raw.query("DROP TRIGGER " + mysql.escapeId(saved.name));
    const ownOrder = saved.peers.find(peer => peer.name === saved.name)?.order;
    if (ownOrder === undefined) throw new Error("Journal guard original order is missing");
    const after = saved.peers.find(peer => peer.order > ownOrder && names.has(peer.name));
    const before = saved.peers.filter(peer => peer.order < ownOrder && names.has(peer.name)).at(-1);
    const order = after ? " PRECEDES " + mysql.escapeId(after.name) : before ? " FOLLOWS " + mysql.escapeId(before.name) : "";
    const header = saved.createSql.indexOf("FOR EACH ROW");
    if (header < 0) throw new Error("Journal guard CREATE header is invalid");
    const createSql = saved.createSql.slice(0, header + 12) + order + saved.createSql.slice(header + 12);
    await raw.query("SET SESSION sql_mode=?", [saved.sqlMode]);
    await raw.query("SET NAMES " + saved.charset + " COLLATE " + saved.collation);
    await raw.query(createSql);
  }, [() => raw.query("SET SESSION character_set_client=?,character_set_results=?,collation_connection=?,sql_mode=?",
    [previous.client, previous.results, previous.collation, previous.mode])]);
}

async function expectRestoreJournalSchemaStartupRejected(owner: GenericJournalMysqlRuntimeOwner): Promise<void> {
  const fingerprint = /0030 tenant restore journal schema fingerprint verification failed/;
  await expect(owner.openStore(1), "runner restricted verify-only").rejects.toThrow(fingerprint);
  await expect(owner.migrateWithLockTimeout(60), "owned operator schema migrate").rejects.toThrow(fingerprint);
  await expect(owner.openRuntimeMaintenance(1), "restore CLI stopped runtime-maintenance verify").rejects.toThrow(fingerprint);
}
if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant restore journal", () => {
    let base: URL;
    let admin: NativeConnection | undefined;
    let database = "";
    let mysqlUrl = "";
    let owner: GenericJournalMysqlRuntimeOwner | undefined;
    const EMPTY_CASE = "refuses a verify-only maintenance connection without applying any schema DDL";
    type Scope = { signal: AbortSignal; failed: boolean; settled: boolean; work?: Promise<void>; closing?: Promise<void>;
      owner?: GenericJournalMysqlRuntimeOwner; empty: boolean; createAttempted: boolean;
      admin?: OwnedNativeConnection; native: Set<OwnedNativeConnection>; detach: Array<() => void>;
      guards: Map<JournalGuardName, SavedJournalGuard>; repairs: Array<() => Promise<void>>;
      readiness?: "structure-after-intentional-data-corruption-v1"; cleanupReported?: boolean };
    const scopes = new Set<Scope>(); let current: Scope | undefined;
    const scope = (): Scope => { if (!current) throw new Error("Journal case is not registered"); return current; };
    async function inspection(): Promise<Connection> {
      if (!owner) throw new Error("Journal ordinary fixture is not available");
      return owner.openInspection(scope().signal);
    }
    async function rememberGuard(raw: Connection, name: JournalGuardName): Promise<void> {
      const value = scope(); if (!value.guards.has(name)) value.guards.set(name, await saveJournalGuard(raw, name));
    }
    async function restoreGuardNow(name: JournalGuardName): Promise<void> {
      const saved = scope().guards.get(name); if (!saved) throw new Error("Journal guard was not captured");
      const raw = await inspection();
      await ownedCleanup(async () => {
        await restoreJournalGuard(raw, saved);
        if (JSON.stringify(await journalGuardRows(raw, name)) !== saved.metadata) throw new Error("Journal guard exact restoration failed");
      }, [() => raw.end()]);
    }
    async function rememberBoundary(raw: Connection, table: "tenant_restore_journal_control" | "tenant_restore_runtime_heads" | "tenant_restore_replay_entries",
      boundary: "collation" | "idx_restore_runtime_head_checkpoint" | "chk_restore_runtime_head_shape" | "fk_restore_runtime_head_control" | "fk_restore_replay_entry_fence"): Promise<void> {
      const [rows] = await raw.query<RowDataPacket[]>("SHOW CREATE TABLE " + mysql.escapeId(table));
      const create = rows[0]?.["Create Table"];
      if (rows.length !== 1 || typeof create !== "string") throw new Error("Journal table native CREATE is missing");
      const readLine = (source: string) => {
        const quoted = mysql.escapeId(boundary);
        const prefixes = boundary.startsWith("idx_")
          ? ["KEY " + quoted + " ", "UNIQUE KEY " + quoted + " "]
          : boundary.startsWith("fk_") || boundary.startsWith("chk_") ? ["CONSTRAINT " + quoted + " "] : [];
        const found = source.split("\n").map(line => line.trim().replace(/,$/, "")).filter(line => prefixes.some(prefix => line.startsWith(prefix)));
        if (found.length !== 1) throw new Error("Journal table boundary is ambiguous"); return found[0]!;
      };
      let original: string;
      if (boundary === "collation") {
        const [collations] = await raw.query<RowDataPacket[]>("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ?", [table]);
        if (collations.length !== 1 || typeof collations[0]?.TABLE_COLLATION !== "string" || !/^[a-z0-9_]+$/.test(collations[0].TABLE_COLLATION)) throw new Error("Journal collation is invalid");
        original = collations[0].TABLE_COLLATION;
      } else original = readLine(create);
      scope().repairs.push(async () => {
        const repair = await inspection();
        await ownedCleanup(async () => {
          if (boundary === "collation") {
            await repair.query("ALTER TABLE " + mysql.escapeId(table) + " COLLATE=" + original);
            const [after] = await repair.query<RowDataPacket[]>("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ?", [table]);
            if (after.length !== 1 || after[0]?.TABLE_COLLATION !== original) throw new Error("Journal collation restoration failed");
          } else {
            const index = boundary.startsWith("idx_");
            const [existing] = await repair.query<RowDataPacket[]>(index
              ? "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ? AND BINARY INDEX_NAME=BINARY ?"
              : "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND BINARY TABLE_NAME=BINARY ? AND BINARY CONSTRAINT_NAME=BINARY ?", [table, boundary]);
            if (existing.length) await repair.query("ALTER TABLE " + mysql.escapeId(table) + " DROP "
              + (index ? "INDEX " : boundary.startsWith("chk_") ? "CHECK " : "FOREIGN KEY ") + mysql.escapeId(boundary));
            await repair.query("ALTER TABLE " + mysql.escapeId(table) + " ADD " + original);
            const [after] = await repair.query<RowDataPacket[]>("SHOW CREATE TABLE " + mysql.escapeId(table));
            if (after.length !== 1 || typeof after[0]?.["Create Table"] !== "string" || readLine(after[0]["Create Table"]) !== original) throw new Error("Journal table boundary restoration failed");
          }
        }, [() => repair.end()]);
      });
    }
    async function finish(value: Scope): Promise<void> {
      value.closing ??= (async () => {
        let failure: { reason: unknown } | undefined;
        const remember = (reason: unknown) => { failure ??= { reason }; };
        if (!value.signal.aborted && value.owner) {
          for (const repair of value.repairs) try { await repair(); } catch (reason) { remember(reason); }
          for (const saved of value.guards.values()) {
            let raw: Connection | undefined;
            try { raw = await value.owner.openInspection(value.signal); await restoreJournalGuard(raw, saved); }
            catch (reason) { remember(reason); } finally { try { await raw?.end(); } catch (reason) { remember(reason); } }
          }
          for (const saved of value.guards.values()) {
            let raw: Connection | undefined;
            try { raw = await value.owner.openInspection(value.signal);
              if (JSON.stringify(await journalGuardRows(raw, saved.name)) !== saved.metadata) throw new Error("Journal guard exact metadata restoration failed"); }
            catch (reason) { remember(reason); } finally { try { await raw?.end(); } catch (reason) { remember(reason); } }
          }
        }
        const successful = !value.failed && !value.signal.aborted && !failure;
        if (value.owner) try { await value.owner.close({ successful, ...(value.readiness ? { readiness: value.readiness } : {}) }); } catch (reason) { remember(reason); }
        for (const native of value.native) try { await native.close(); } catch (reason) { remember(reason); }
        if (value.empty && value.createAttempted) {
          try {
            if (successful && !failure && value.admin) {
              const [tables] = await value.admin.connection.query<RowDataPacket[]>("SHOW TABLES FROM " + mysql.escapeId(database));
              if (tables.length !== 0) throw new Error("Empty-schema case left unexpected tables");
              await value.admin.connection.query("DROP DATABASE " + mysql.escapeId(database));
              const [left] = await value.admin.connection.query<RowDataPacket[]>("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database]);
              if (left.length) throw new Error("Empty-schema exact cleanup failed");
            } else console.warn(JSON.stringify({ schema: "generic-journal-empty-fixture-retained-v1", applicationDatabase: database, status: "retained_or_unknown" }));
          } catch (reason) { remember(reason); }
        }
        try { await value.admin?.close(); } catch (reason) { remember(reason); }
        for (const detach of value.detach) try { detach(); } catch (reason) { remember(reason); }
        value.settled = true; if (failure) throw failure.reason;
      })();
      try { await value.closing; }
      catch (reason) {
        if (!value.failed) { value.failed = true; throw reason; }
        if (!value.cleanupReported) { value.cleanupReported = true;
          try { console.warn("generic_journal_cleanup_failed_after_original_failure"); } catch { /* Preserve the body/setup error. */ } }
      }
    }
    function runCase(body: () => Promise<void>): () => Promise<void> {
      return () => {
        const value = scope();
        const work = Promise.resolve().then(async () => {
          try { value.signal.throwIfAborted(); await body(); value.signal.throwIfAborted(); }
          catch (reason) { value.failed = true; throw reason; }
          finally { await finish(value); }
        });
        value.work = work; return work;
      };
    }
    beforeAll(() => { base = disposableBase(BASE_MYSQL_URL); });
    beforeEach(async ({ task, signal }) => {
      if ([...scopes].some(value => !value.settled)) throw new Error("Journal prior case has not settled");
      const value: Scope = { signal, failed: false, settled: false, empty: task.name === EMPTY_CASE,
        createAttempted: false, native: new Set(), detach: [], guards: new Map(), repairs: [] };
      current = value; scopes.add(value); owner = undefined; admin = undefined;
      try {
        if (value.empty) {
          database = "agent_service_restore_journal_test_" + process.pid + "_" + randomUUID().replaceAll("-", "").slice(0, 8);
          if (!/^agent_service_restore_journal_test_[A-Za-z0-9_]+$/.test(database)) throw new Error("unsafe restore journal database name");
          mysqlUrl = databaseUrl(base, database);
          await witnessAbsentMysqlFixtureDatabase({ operatorUrl: mysqlUrl, applicationDatabase: database, operationAbortSignal: signal });
          value.admin = await ownedNativeConnection(databaseUrl(base, "mysql"), signal); admin = value.admin.connection;
          value.createAttempted = true;
          await admin.query("CREATE DATABASE " + mysql.escapeId(database) + " CHARACTER SET utf8mb4");
          await MysqlSessionStore.runSchemaOperation({ url: mysqlUrl, operation: "migrate", fleetStoppedAck: "all-application-writers-stopped-v1", operationAbortSignal: signal });
        } else {
          owner = value.owner = new GenericJournalMysqlRuntimeOwner(BASE_MYSQL_URL);
          database = owner.database;
          const abort = () => { void value.owner!.close({ successful: false }).catch(() => {}); };
          signal.addEventListener("abort", abort, { once: true }); value.detach.push(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort(); await owner.prepare();
          mysqlUrl = owner.runtimeEnv().MYSQL_URL!;
        }
      } catch (reason) { value.failed = true; throw reason; }
    });
    afterEach(async () => {
      const value = scope(); await Promise.allSettled(value.work ? [value.work] : []); await finish(value);
      database = ""; mysqlUrl = ""; admin = undefined; owner = undefined;
    });
    afterAll(async () => {
      await Promise.allSettled([...scopes].flatMap(value => value.work ? [value.work] : []));
      const results = await Promise.allSettled([...scopes].map(finish));
      const failure = results.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    });

    it("refuses a verify-only maintenance connection without applying any schema DDL", runCase(async () => {
      await admin!.query(`DROP DATABASE \`${database}\``);
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      await expect(MysqlSessionStore.runSchemaOperation({
        url: mysqlUrl,
        operation: "verify",
        operationAbortSignal: scope().signal,
      })).rejects.toThrow();
      const native = await ownedNativeConnection(mysqlUrl, scope().signal); scope().native.add(native);
      const raw = native.connection;
      const [tables] = await raw.query<RowDataPacket[]>("SHOW TABLES");
      expect(tables).toHaveLength(0);
      await native.close();
    }));

    it("rejects runner and restore CLI startup when the retained marker lacks a guard trigger", runCase(async () => {
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_t3a_receipt_bi");
      await raw.query("DROP TRIGGER trg_restore_journal_t3a_receipt_bi");
      await expectRestoreJournalSchemaStartupRejected(owner!);
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM schema_migrations
             WHERE name='0030_tenant_restore_journal.sql') AS marker_count,
           (SELECT COUNT(*) FROM information_schema.triggers
             WHERE trigger_schema=DATABASE()
               AND trigger_name LIKE 'trg\\_restore\\_journal\\_%') AS trigger_count`,
      );
      expect(rows[0]).toMatchObject({ marker_count: 1, trigger_count: 38 });
      await raw.end();
    }));

    it("rejects runner and restore CLI startup when a retained-marker trigger body changed", runCase(async () => {
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_t3a_job_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_t3a_job_bu");
      await raw.query(
        `CREATE TRIGGER trg_restore_journal_t3a_job_bu
           BEFORE UPDATE ON tenant_credential_revocation_jobs FOR EACH ROW
           SET @restore_journal_t3a_weakened = 1`,
      );
      await expectRestoreJournalSchemaStartupRejected(owner!);
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM schema_migrations
             WHERE name='0030_tenant_restore_journal.sql') AS marker_count,
           (SELECT COUNT(*) FROM information_schema.triggers
             WHERE trigger_schema=DATABASE()
               AND trigger_name LIKE 'trg\\_restore\\_journal\\_%') AS trigger_count,
           (SELECT action_statement FROM information_schema.triggers
             WHERE trigger_schema=DATABASE()
               AND trigger_name='trg_restore_journal_t3a_job_bu') AS action_statement`,
      );
      expect(rows[0]).toMatchObject({
        marker_count: 1,
        trigger_count: 39,
        action_statement: "SET @restore_journal_t3a_weakened = 1",
      });
      await raw.end();
    }));

    it.each([
      {
        boundary: "table collation",
        weaken: "ALTER TABLE tenant_restore_journal_control COLLATE=utf8mb4_0900_ai_ci",
      },
      {
        boundary: "index",
        weaken: `ALTER TABLE tenant_restore_runtime_heads
                    DROP INDEX idx_restore_runtime_head_checkpoint,
                    ADD INDEX idx_restore_runtime_head_checkpoint (singleton_id,target_ordinal)`,
      },
      {
        boundary: "CHECK constraint",
        weaken: `ALTER TABLE tenant_restore_runtime_heads
                    DROP CHECK chk_restore_runtime_head_shape`,
      },
      {
        boundary: "foreign key",
        weaken: `ALTER TABLE tenant_restore_runtime_heads
                    DROP FOREIGN KEY fk_restore_runtime_head_control`,
      },
    ])("rejects retained-marker runner/CLI startup after weakening $boundary", async ({ boundary, weaken }) => runCase(async () => {
      const raw = await inspection();
      await rememberBoundary(raw, boundary === "table collation" ? "tenant_restore_journal_control" : "tenant_restore_runtime_heads",
        boundary === "table collation" ? "collation" : boundary === "index" ? "idx_restore_runtime_head_checkpoint"
          : boundary === "CHECK constraint" ? "chk_restore_runtime_head_shape" : "fk_restore_runtime_head_control");
      await raw.query(weaken);
      await expectRestoreJournalSchemaStartupRejected(owner!);
      const [markers] = await raw.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS marker_count FROM schema_migrations
          WHERE name='0030_tenant_restore_journal.sql'`,
      );
      expect(markers[0]).toMatchObject({ marker_count: 1 });
      await raw.end();
    })());

    it("materializes a pre-activation T1 without breaking replay or tenant isolation", runCase(async () => {
      let store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-pre-activation-${randomUUID()}`;
      const neighborTenantId = `tenant-pre-activation-neighbor-${randomUUID()}`;
      await seedTenant(store, tenantId);
      await seedTenant(store, neighborTenantId);
      const input = {
        requestId: newErasureRequestId(),
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-pre-activation-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      };

      expect(await store.getTenantRestoreJournalControl()).toEqual({
        singletonId: 1,
        controlGeneration: 0,
      });
      const committed = await store.requestTenantErasure(input);
      expect(await store.getTenantRestoreJournalPublicationBundle(tenantId, input.requestId))
        .toBeNull();

      await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      await expect(store.replayTenantErasure({
        tenantId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      })).resolves.toEqual(committed);
      await expect(store.requestTenantErasure(input)).resolves.toEqual(committed);
      await expect(store.getTenantErasureRequest(tenantId, input.requestId))
        .resolves.toEqual(committed);
      await expect(store.getTenantRestoreJournalPublicationBundle(tenantId, input.requestId))
        .resolves.toBeNull();

      await expect(store.replayTenantErasure({
        tenantId: neighborTenantId,
        idempotencyKey: input.idempotencyKey,
        requestHash: tenantErasureRequestHash(neighborTenantId),
      })).resolves.toBeNull();
      await expect(store.getTenantErasureRequest(neighborTenantId, input.requestId))
        .resolves.toBeNull();

      await expect(store.materializeTenantRestoreJournalPublicationJobs({ limit: 1 }))
        .resolves.toBe(1);
      await expect(store.materializeTenantRestoreJournalPublicationJobs({ limit: 1 }))
        .resolves.toBe(0);
      await expect(store.getTenantRestoreJournalPublicationJob(tenantId, input.requestId))
        .resolves.toMatchObject({
          phase: "queued",
          tenantId,
          requestId: input.requestId,
          targetCount: 1,
          targetAckCount: 0,
        });
      const bundle = await store.getTenantRestoreJournalPublicationBundle(
        tenantId,
        input.requestId,
      );
      expect(bundle).toMatchObject({ targets: [{ tenantId }], targetAcks: [] });
      expect(bundle?.receipt).toBeUndefined();
      await expect(store.getTenantRestoreJournalPublicationBundle(
        neighborTenantId,
        input.requestId,
      )).resolves.toBeNull();

      const [credentialClaim] = await store.claimTenantCredentialRevocations({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-pre-activation-t3a-${randomUUID()}`,
      });
      expect(credentialClaim).toMatchObject({ requestId: input.requestId, tenantId });
      await expect(store.revokeTenantCredentialMaterial(
        revocationAuthorization(credentialClaim!),
      )).rejects.toThrow(/active restore journal requires exact publication before T3a receipt/);

      const raw = await inspection();
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT auth_policy IS NOT NULL AS auth_policy_present,
                (SELECT COUNT(*) FROM tenant_credential_revocation_receipts
                  WHERE request_id=?) AS receipt_count
           FROM tenants WHERE tenant_id=?`,
        [input.requestId, tenantId],
      );
      expect(rows[0]).toMatchObject({ auth_policy_present: 1, receipt_count: 0 });
      await raw.end();
      await store.close();
    }));

    it("publishes T1 atomically and advances the durable runtime head before sealing", runCase(async () => {
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const job = await store.getTenantRestoreJournalPublicationJob(tenantId, requestId);
      expect(job).toMatchObject({ phase: "queued", targetAckCount: 0 });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-claim-${randomUUID()}`,
      });
      expect(claim?.requestId).toBe(requestId);
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      expect(publication).not.toBeNull();
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      const ack = await store.recordTenantRestoreJournalPublicationTargetAck(auth, result);
      expect(ack?.remoteSequence).toBe(1);
      const heads = await store.getTenantRestoreRuntimeHeads();
      expect(heads).toMatchObject([{ sealedRemoteSequence: 1, sealedHeadRootSha256: result.headRootSha256 }]);
      const receipt = await store.sealTenantRestoreJournalPublication(auth);
      expect(receipt).toMatchObject({ restoreFencePublicationComplete: true, allDomainsComplete: false });
      expect(await store.sealTenantRestoreJournalPublication(auth)).toEqual(receipt);
      await store.close();
    }));

    it("rolls back the runtime known/head/control projection when ACK persistence fails", runCase(async () => {
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-claim-${randomUUID()}`,
      });
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      const raw = await inspection();
      scope().repairs.push(async () => {
        const repair = await inspection();
        await ownedCleanup(async () => {
          const [rows] = await repair.query<RowDataPacket[]>("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='test_fail_restore_ack'");
          if (rows.length !== 1) throw new Error("Owned ACK fault trigger is missing");
          await repair.query("DROP TRIGGER test_fail_restore_ack");
        }, [() => repair.end()]);
      });
      await raw.query(
        `CREATE TRIGGER test_fail_restore_ack BEFORE INSERT ON tenant_restore_journal_target_acks
         FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected ACK failure'`,
      );
      await expect(store.recordTenantRestoreJournalPublicationTargetAck(auth, result)).rejects.toThrow(
        "injected ACK failure",
      );
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT c.control_generation, h.remote_sequence,
                (SELECT COUNT(*) FROM tenant_restore_runtime_known_entries) AS known_count,
                (SELECT COUNT(*) FROM tenant_restore_journal_target_acks) AS ack_count
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id`,
      );
      expect(rows[0]).toMatchObject({
        control_generation: 1,
        remote_sequence: 0,
        known_count: 0,
        ack_count: 0,
      });
      await raw.end();
      await store.close();
    }));

    it("rolls back T3a credential deletion until the exact restore publication is durable", runCase(async () => {
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const secret = Buffer.from(`restore-t3a-secret-${randomUUID()}`, "utf8");
      await store.setTenantAuth(tenantId, AUTH_POLICY, {
        ciphertext: secret,
        keyId: `restore-t3a-key-${randomUUID()}`,
      });
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [t3aClaim] = await store.claimTenantCredentialRevocations({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-t3a-${randomUUID()}`,
      });
      expect(t3aClaim?.requestId).toBe(requestId);
      const t3aAuthorization = revocationAuthorization(t3aClaim!);
      await expect(store.revokeTenantCredentialMaterial(t3aAuthorization)).rejects.toThrow(
        /active restore journal requires exact publication before T3a receipt/,
      );

      const raw = await inspection();
      const [rolledBack] = await raw.query<RowDataPacket[]>(
        `SELECT j.phase,j.attempts,j.claim_token,HEX(t.auth_secret_cipher) AS secret_hex,
                t.auth_secret_key_id,
                (SELECT COUNT(*) FROM tenant_credential_revocation_receipts r
                  WHERE r.request_id=j.request_id) AS receipt_count
           FROM tenant_credential_revocation_jobs j
           JOIN tenants t ON t.tenant_id=j.tenant_id
          WHERE j.request_id=?`,
        [requestId],
      );
      expect(rolledBack[0]).toMatchObject({
        phase: "queued",
        attempts: 1,
        claim_token: t3aAuthorization.claimToken,
        secret_hex: secret.toString("hex").toUpperCase(),
        receipt_count: 0,
      });
      expect(rolledBack[0]!.auth_secret_key_id).not.toBeNull();

      const [publicationClaim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-publication-${randomUUID()}`,
      });
      expect(publicationClaim?.requestId).toBe(requestId);
      const publicationAuthorization = authorization(publicationClaim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(
        publicationAuthorization,
        0,
      );
      expect(publication).not.toBeNull();
      await store.recordTenantRestoreJournalPublicationTargetAck(
        publicationAuthorization,
        appendResult(
          active.configured,
          active.logicalDatabaseNamespaceSha256,
          publication!.record,
        ),
      );
      await expect(store.sealTenantRestoreJournalPublication(publicationAuthorization))
        .resolves.toMatchObject({ restoreFencePublicationComplete: true });
      await expect(store.revokeTenantCredentialMaterial(t3aAuthorization)).resolves.toMatchObject({
        requestId,
        authSecretCipherPresentBefore: true,
        authSecretCipherPresentAfter: false,
      });
      const [completed] = await raw.query<RowDataPacket[]>(
        `SELECT j.phase,t.auth_policy,t.auth_secret_cipher,t.auth_secret_key_id,
                (SELECT COUNT(*) FROM tenant_credential_revocation_receipts r
                  WHERE r.request_id=j.request_id) AS receipt_count
           FROM tenant_credential_revocation_jobs j
           JOIN tenants t ON t.tenant_id=j.tenant_id
          WHERE j.request_id=?`,
        [requestId],
      );
      expect(completed[0]).toMatchObject({
        phase: "credential_store_revoked",
        auth_policy: null,
        auth_secret_cipher: null,
        auth_secret_key_id: null,
        receipt_count: 1,
      });
      await raw.end();
      await store.close();
    }));

    it("uses one journal-to-runtime lock order for concurrent ACK and startup preflight", runCase(async () => {
      let store = await owner!.openStore(8, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(8, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-claim-${randomUUID()}`,
      });
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      const blocker = await inspection();
      const observer = await inspection();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.beginTransaction();
        await blocker.query(
          "SELECT request_id FROM tenant_restore_journal_jobs WHERE request_id=? FOR UPDATE",
          [requestId],
        );
        const ackPromise = store.recordTenantRestoreJournalPublicationTargetAck(auth, result);
        pending.push(ackPromise);
        await waitForMysqlRowLockWaiters(observer, 1);
        const preflightPromise = store.assertTenantRestoreRuntimeJournalEntryKnown({
          runtimeEpochSha256: active.runtimeEpochSha256,
          controlEvidenceSha256: active.controlEvidenceSha256,
          expectedControlGeneration: 1,
          targetOrdinal: 0,
          remoteEntry: {
            targetSha256: result.targetSha256,
            remoteSequence: result.remoteSequence,
            previousHeadRootSha256: result.previousHeadRootSha256,
            headRootSha256: result.headRootSha256,
            record: result.record,
          },
        });
        pending.push(preflightPromise);
        await waitForMysqlRowLockWaiters(observer, 2);
        await blocker.commit();
        const [ack, runtime] = await within(
          Promise.all([ackPromise, preflightPromise]),
          10_000,
        );
        expect(ack?.headRootSha256).toBe(result.headRootSha256);
        expect(runtime).toMatchObject({ state: "active", controlGeneration: 2 });
        await expect(store.sealTenantRestoreJournalPublication(auth)).resolves.toMatchObject({
          restoreFencePublicationComplete: true,
        });
      } finally {
        await blocker.rollback().catch(() => {});
        await Promise.allSettled(pending);
        await blocker.end();
        await observer.end();
      }
      await store.close();
    }));

    it("rolls back reverse-order ACKs until three contiguous predecessors converge", runCase(async () => {
      let store = await owner!.openStore(8, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(8, scope().signal);
      const requests: Array<{ requestId: ReturnType<typeof newErasureRequestId>; tenantId: string }> = [];
      for (let index = 0; index < 3; index += 1) {
        const tenantId = `tenant-reverse-ack-${index + 1}-${randomUUID()}`;
        await seedTenant(store, tenantId);
        const requestId = newErasureRequestId();
        await store.requestTenantErasure({
          requestId,
          tenantId,
          requestedByKeyId: "restore-journal-mysql-test",
          idempotencyKey: `restore-reverse-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(tenantId),
          atMs: Date.now(),
        });
        requests.push({ requestId, tenantId });
      }
      const claims = await store.claimTenantRestoreJournalPublications({
        limit: 3,
        leaseMs: 60_000,
        claimToken: `restore-reverse-claim-${randomUUID()}`,
      });
      expect(claims).toHaveLength(3);
      const authorizations = new Map(claims.map((claim) => [
        claim.requestId,
        authorization(claim),
      ]));
      const records: TenantRestoreJournalRecord[] = [];
      for (const request of requests) {
        const publication = await store.getTenantRestoreJournalPublicationRecord(
          authorizations.get(request.requestId)!,
          0,
        );
        expect(publication).not.toBeNull();
        records.push(publication!.record);
      }
      const first = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        records[0]!,
      );
      const second = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        records[1]!,
        2,
        first.headRootSha256,
      );
      const third = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        records[2]!,
        3,
        second.headRootSha256,
      );
      const firstAuth = authorizations.get(requests[0]!.requestId)!;
      const secondAuth = authorizations.get(requests[1]!.requestId)!;
      const thirdAuth = authorizations.get(requests[2]!.requestId)!;

      await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
        .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
      await expect(store.recordTenantRestoreJournalPublicationTargetAck(secondAuth, second))
        .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
      const raw = await inspection();
      const [before] = await raw.query<RowDataPacket[]>(
        `SELECT c.control_generation,h.remote_sequence,
                (SELECT COUNT(*) FROM tenant_restore_runtime_known_entries) AS known_count,
                (SELECT COUNT(*) FROM tenant_restore_journal_target_acks) AS ack_count
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id`,
      );
      expect(before[0]).toMatchObject({
        control_generation: 1,
        remote_sequence: 0,
        known_count: 0,
        ack_count: 0,
      });

      await expect(store.recordTenantRestoreJournalPublicationTargetAck(firstAuth, first))
        .resolves.toMatchObject({ remoteSequence: 1 });
      await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
        .rejects.toBeInstanceOf(TenantRestoreJournalPublicationDependencyPendingError);
      await expect(store.recordTenantRestoreJournalPublicationTargetAck(secondAuth, second))
        .resolves.toMatchObject({ remoteSequence: 2 });
      await expect(store.recordTenantRestoreJournalPublicationTargetAck(thirdAuth, third))
        .resolves.toMatchObject({ remoteSequence: 3 });
      const [after] = await raw.query<RowDataPacket[]>(
        `SELECT c.control_generation,h.remote_sequence,h.head_root_sha256,
                (SELECT COUNT(*) FROM tenant_restore_runtime_known_entries) AS known_count,
                (SELECT COUNT(*) FROM tenant_restore_journal_target_acks) AS ack_count
           FROM tenant_restore_runtime_control c
           JOIN tenant_restore_runtime_heads h ON h.singleton_id=c.singleton_id`,
      );
      expect(after[0]).toMatchObject({
        control_generation: 4,
        remote_sequence: 3,
        head_root_sha256: third.headRootSha256,
        known_count: 3,
        ack_count: 3,
      });
      for (const request of requests) {
        await expect(store.sealTenantRestoreJournalPublication(
          authorizations.get(request.requestId)!,
        )).resolves.toMatchObject({ restoreFencePublicationComplete: true });
      }
      await raw.end();
      await store.close();
    }));

    it("refuses to seal when an ACK is missing from the coupled runtime known projection", runCase(async () => {
      scope().readiness = "structure-after-intentional-data-corruption-v1";
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-claim-${randomUUID()}`,
      });
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      await store.recordTenantRestoreJournalPublicationTargetAck(auth, result);
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_runtime_known_bd");
      await raw.query("DROP TRIGGER trg_restore_journal_runtime_known_bd");
      await raw.query("DELETE FROM tenant_restore_runtime_known_entries");
      await expect(
        store.recordTenantRestoreJournalPublicationTargetAck(auth, result),
      ).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await expect(store.sealTenantRestoreJournalPublication(auth)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT phase,
                (SELECT COUNT(*) FROM tenant_restore_journal_receipts WHERE request_id=?) AS receipt_count
           FROM tenant_restore_journal_jobs WHERE request_id=?`,
        [requestId, requestId],
      );
      expect(rows[0]).toMatchObject({ phase: "queued", receipt_count: 0 });
      await raw.end();
      await store.close();
    }));

    it("uses only the exact active restore replay entry for an ACKed unsealed publication", runCase(async () => {
      scope().readiness = "structure-after-intentional-data-corruption-v1";
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-acked-before-restore-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `acked-before-restore-${randomUUID()}`,
      });
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      const ack = await store.recordTenantRestoreJournalPublicationTargetAck(auth, result);
      expect(ack).not.toBeNull();
      expect(await store.getTenantRestoreJournalPublicationJob(tenantId, requestId))
        .toMatchObject({ phase: "queued", targetAckCount: 1 });

      const restoreRunId = `restore_${randomUUID()}`;
      const restoredEpoch = tenantRestoreRuntimeEpochSha256(`acked-before-seal-${randomUUID()}`);
      const sealedTargets: TenantRestoreReplaySealedTarget[] = [{
        ...active.configured,
        logicalDatabaseNamespaceSha256: active.logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: result.remoteSequence,
        sealedHeadRootSha256: result.headRootSha256,
      }];
      await store.prepareTenantRestoreReplay({
        restoreRunId,
        sourceBackupSha256: sha256("mysql-acked-before-seal-backup"),
        runtimeEpochSha256: restoredEpoch,
        controlEvidenceSha256: active.controlEvidenceSha256,
        sealedTargets,
      });
      await expect(store.recordTenantRestoreReplayFence({
        restoreRunId,
        targetOrdinal: 0,
        remoteEntry: {
          targetSha256: result.targetSha256,
          remoteSequence: result.remoteSequence,
          previousHeadRootSha256: result.previousHeadRootSha256,
          headRootSha256: result.headRootSha256,
          record: result.record,
        },
      })).resolves.toMatchObject({ recordSha256: result.record.recordSha256 });
      await expect(store.sealTenantRestoreReplay(restoreRunId)).resolves.toMatchObject({
        restoreFenceReplayComplete: true,
      });
      const beforeActivation = await store.getTenantRestoreRuntimeControl();
      if (beforeActivation.state !== "active") throw new Error("expected active primary runtime");
      const restoreToken = await owner!.stageRestore({
        restoreRunId,
        expectedControlGeneration: beforeActivation.controlGeneration,
      });
      const restoreFacade = await owner!.openActivationFacade(restoreToken, 4);
      await expect(restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken))).resolves.toMatchObject({
        lineageKind: "restore",
        runtimeEpochSha256: restoredEpoch,
      });
      await owner!.confirm(restoreToken, restoreFacade);
      store = await owner!.openStore(4, scope().signal);

      const exactAckReplay = () => store.recordTenantRestoreJournalPublicationTargetAck(
        auth,
        { ...result, replayed: true },
      );
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_entries_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_entries_bu");
      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET record_sha256=? WHERE restore_run_id=? AND target_ordinal=0 AND remote_sequence=1`,
        [sha256("damaged-mysql-restored-publication-record"), restoreRunId],
      );
      await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await expect(store.sealTenantRestoreJournalPublication(auth)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );

      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET record_sha256=? WHERE restore_run_id=? AND target_ordinal=0 AND remote_sequence=1`,
        [result.record.recordSha256, restoreRunId],
      );
      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET target_ordinal=1 WHERE restore_run_id=? AND target_ordinal=0 AND remote_sequence=1`,
        [restoreRunId],
      );
      await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await expect(store.sealTenantRestoreJournalPublication(auth)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET target_ordinal=0 WHERE restore_run_id=? AND target_ordinal=1 AND remote_sequence=1`,
        [restoreRunId],
      );
      // This test deliberately simulates privileged relational tampering after the immutable-row
      // trigger is removed. Drop the owner FK as well so MySQL does not reject the corruption
      // before the store's exact replay-entry verifier gets a chance to fail closed.
      await rememberBoundary(raw, "tenant_restore_replay_entries", "fk_restore_replay_entry_fence");
      await raw.query(
        "ALTER TABLE tenant_restore_replay_entries DROP FOREIGN KEY fk_restore_replay_entry_fence",
      );
      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET tenant_id=? WHERE restore_run_id=? AND target_ordinal=0 AND remote_sequence=1`,
        [`tenant-cross-owner-${randomUUID()}`, restoreRunId],
      );
      await expect(exactAckReplay()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await expect(store.sealTenantRestoreJournalPublication(auth)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await raw.query(
        `UPDATE tenant_restore_replay_entries
            SET tenant_id=? WHERE restore_run_id=? AND target_ordinal=0 AND remote_sequence=1`,
        [tenantId, restoreRunId],
      );
      await expect(exactAckReplay()).resolves.toEqual(ack);
      const receipt = await store.sealTenantRestoreJournalPublication(auth);
      expect(receipt).toMatchObject({ restoreFencePublicationComplete: true });

      await rememberGuard(raw, "trg_restore_journal_entries_bd");
      await raw.query("DROP TRIGGER trg_restore_journal_entries_bd");
      await raw.query(
        "DELETE FROM tenant_restore_replay_entries WHERE restore_run_id=?",
        [restoreRunId],
      );
      await expect(store.sealTenantRestoreJournalPublication(auth)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await raw.end();
      await store.close();
    }));

    it("rejects relationally forged ACK and terminal receipt evidence", runCase(async () => {
      scope().readiness = "structure-after-intentional-data-corruption-v1";
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      const [claim] = await store.claimTenantRestoreJournalPublications({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-claim-${randomUUID()}`,
      });
      const auth = authorization(claim!);
      const publication = await store.getTenantRestoreJournalPublicationRecord(auth, 0);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        publication!.record,
      );
      await store.recordTenantRestoreJournalPublicationTargetAck(auth, result);
      const bundle = await store.getTenantRestoreJournalPublicationBundle(tenantId, requestId);
      const forgedAckBody = {
        ...bundle!.targetAcks[0]!,
        completedClaimAttempt: auth.claimAttempt + 1,
      };
      const { receiptSha256: _oldAckSha256, ...forgedAckWithoutReceipt } = forgedAckBody;
      const forgedAck = {
        ...forgedAckWithoutReceipt,
        receiptSha256: tenantRestoreJournalPublicationTargetAckSha256(forgedAckWithoutReceipt),
      };
      const forgedAckRoot = tenantRestoreJournalPublicationTargetAckRootSha256([forgedAck]);
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_acks_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_acks_bu");
      await rememberGuard(raw, "trg_restore_journal_jobs_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_jobs_bu");
      await raw.query(
        `UPDATE tenant_restore_journal_target_acks
            SET completed_claim_attempt=?,receipt_sha256=? WHERE request_id=?`,
        [forgedAck.completedClaimAttempt, forgedAck.receiptSha256, requestId],
      );
      await raw.query(
        "UPDATE tenant_restore_journal_jobs SET target_ack_root_sha256=? WHERE request_id=?",
        [forgedAckRoot, requestId],
      );
      await expect(
        store.getTenantRestoreJournalPublicationBundle(tenantId, requestId),
      ).rejects.toBeInstanceOf(TenantErasureIntegrityError);

      await raw.query(
        `UPDATE tenant_restore_journal_target_acks
            SET completed_claim_attempt=?,receipt_sha256=? WHERE request_id=?`,
        [bundle!.targetAcks[0]!.completedClaimAttempt, bundle!.targetAcks[0]!.receiptSha256, requestId],
      );
      await raw.query(
        "UPDATE tenant_restore_journal_jobs SET target_ack_root_sha256=? WHERE request_id=?",
        [tenantRestoreJournalPublicationTargetAckRootSha256(bundle!.targetAcks), requestId],
      );
      const receipt = await store.sealTenantRestoreJournalPublication(auth);
      const forgedReceiptBody = { ...receipt!, adapterProtocol: "forged-adapter-v1" };
      const { receiptSha256: _oldReceiptSha256, ...forgedReceiptWithoutSha } = forgedReceiptBody;
      const forgedReceiptSha256 = tenantRestoreJournalPublicationReceiptSha256(
        forgedReceiptWithoutSha,
      );
      await rememberGuard(raw, "trg_restore_journal_receipts_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_receipts_bu");
      await raw.query(
        "UPDATE tenant_restore_journal_receipts SET adapter_protocol=?,receipt_sha256=? WHERE request_id=?",
        [forgedReceiptWithoutSha.adapterProtocol, forgedReceiptSha256, requestId],
      );
      await raw.query(
        "UPDATE tenant_restore_journal_jobs SET terminal_receipt_sha256=? WHERE request_id=?",
        [forgedReceiptSha256, requestId],
      );
      await expect(
        store.getTenantRestoreJournalPublicationBundle(tenantId, requestId),
      ).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await raw.end();
      await store.close();
    }));

    it("rejects and rolls back T1 when an active journal has a torn runtime projection", runCase(async () => {
      let store = await owner!.openStore(4, scope().signal);
      await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const raw = await inspection();
      const [originalControlRows] = await raw.query<RowDataPacket[]>("SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1");
      if (originalControlRows.length !== 1) throw new Error("Original runtime control row is missing");
      const originalControl = { ...originalControlRows[0]! };
      scope().repairs.push(async () => {
        const repair = await inspection();
        await ownedCleanup(async () => {
          const fields = Object.keys(originalControl).filter(field => field !== "singleton_id");
          if (!fields.length || fields.some(field => !/^[a-z0-9_]+$/.test(field))) throw new Error("Original runtime control fields are invalid");
          await repair.query("UPDATE tenant_restore_runtime_control SET " + fields.map(field => mysql.escapeId(field) + "=?").join(",") + " WHERE singleton_id=1", fields.map(field => originalControl[field]));
          const [after] = await repair.query<RowDataPacket[]>("SELECT * FROM tenant_restore_runtime_control WHERE singleton_id=1");
          if (after.length !== 1 || JSON.stringify(after[0]) !== JSON.stringify(originalControl)) throw new Error("Original runtime control restoration failed");
        }, [() => repair.end()]);
      });
      await rememberGuard(raw, "trg_restore_journal_runtime_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_runtime_bu");
      await rememberGuard(raw, "trg_restore_journal_runtime_au");
      await raw.query("DROP TRIGGER trg_restore_journal_runtime_au");
      await raw.query(
        `UPDATE tenant_restore_runtime_control
            SET state='inactive',control_generation=0,update_kind=NULL,lineage_kind=NULL,
                activated_at_db_ms=NULL,updated_at_db_ms=NULL,restore_run_id=NULL,
                replay_receipt_sha256=NULL,runtime_epoch_sha256=NULL,
                control_evidence_sha256=NULL,logical_database_namespace_sha256=NULL,
                target_count=0,target_root_sha256=NULL,verified_head_root_sha256=NULL,
                previous_control_evidence_sha256=NULL,evidence_sha256=NULL
          WHERE singleton_id=1`,
      );
      const requestId = newErasureRequestId();
      const rejectedT1 = store.requestTenantErasure({
        requestId,
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      });
      await expect(rejectedT1).rejects.toBeInstanceOf(SessionAuthorityError);
      await expect(rejectedT1).rejects.toMatchObject({ code: "session_authority_unavailable" });
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE request_id=?) AS admission_count,
           (SELECT COUNT(*) FROM tenant_credential_revocation_fences WHERE request_id=?) AS fence_count,
           (SELECT COUNT(*) FROM tenant_restore_journal_jobs WHERE request_id=?) AS journal_count`,
        [requestId, requestId, requestId],
      );
      expect(rows[0]).toMatchObject({ admission_count: 0, fence_count: 0, journal_count: 0 });
      await raw.end();
      await store.close();
    }));

    it("serializes concurrent tenant admissions into one T1 publication", runCase(async () => {
      let store = await owner!.openStore(8, scope().signal);
      await activate(owner!);
      store = await owner!.openStore(8, scope().signal);
      const tenantId = `tenant-${randomUUID()}`;
      await seedTenant(store, tenantId);
      const inputs = [0, 1].map(() => ({
        requestId: newErasureRequestId(),
        tenantId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(tenantId),
        atMs: Date.now(),
      }));
      const results = await Promise.all(inputs.map((input) => store.requestTenantErasure(input)));
      expect(new Set(results.map((result) => result.requestId)).size).toBe(1);
      const raw = await inspection();
      const [rows] = await raw.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM tenant_erasure_admissions WHERE tenant_id=?) AS admission_count,
           (SELECT COUNT(*) FROM tenant_restore_journal_jobs WHERE tenant_id=?) AS job_count,
           (SELECT COUNT(*) FROM tenant_restore_journal_targets WHERE tenant_id=?) AS target_count`,
        [tenantId, tenantId, tenantId],
      );
      expect(rows[0]).toMatchObject({ admission_count: 1, job_count: 1, target_count: 1 });
      await raw.end();
      await store.close();
    }));

    it("replays a permanent restore fence and blocks writes even without local T1 projections", runCase(async () => {
      scope().readiness = "structure-after-intentional-data-corruption-v1";
      let store = await owner!.openStore(4, scope().signal);
      const active = await activate(owner!);
      store = await owner!.openStore(4, scope().signal);
      const erasedTenantId = `restored-erased-${randomUUID()}`;
      const erasedUserId = `restored-user-${randomUUID()}`;
      const legacySession = mkSession(erasedTenantId, erasedUserId);
      await store.setTenantAuth(erasedTenantId, DEFAULT_AUTH_POLICY);
      await store.createSession(legacySession);
      await activateExportPolicy(store, erasedTenantId);
      const download = await prepareDownloadLease(store, erasedTenantId, erasedUserId);
      const fencedQueuedExport = await requestExport(
        store,
        erasedTenantId,
        erasedUserId,
        "queued-before-restore",
      );
      const record = standaloneRecord(active.logicalDatabaseNamespaceSha256, erasedTenantId);
      const result = appendResult(
        active.configured,
        active.logicalDatabaseNamespaceSha256,
        record,
      );
      const restoreRunId = `restore_${randomUUID()}`;
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`restore-${randomUUID()}`);
      const sealedTargets = [{
        ...active.configured,
        logicalDatabaseNamespaceSha256: active.logicalDatabaseNamespaceSha256,
        sealedRemoteSequence: 1,
        sealedHeadRootSha256: result.headRootSha256,
      }];
      await store.prepareTenantRestoreReplay({
        restoreRunId,
        sourceBackupSha256: sha256("mysql-restore-backup"),
        runtimeEpochSha256,
        controlEvidenceSha256: active.controlEvidenceSha256,
        sealedTargets,
      });
      await expect(store.prepareTenantRestoreReplay({
        restoreRunId,
        sourceBackupSha256: sha256("mysql-restore-backup"),
        runtimeEpochSha256,
        controlEvidenceSha256: active.controlEvidenceSha256,
        sealedTargets: [{ ...sealedTargets[0]!, adapterProtocol: "forged-adapter-v1" }],
      })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await store.recordTenantRestoreReplayFence({
        restoreRunId,
        targetOrdinal: 0,
        remoteEntry: {
          targetSha256: result.targetSha256,
          remoteSequence: result.remoteSequence,
          previousHeadRootSha256: result.previousHeadRootSha256,
          headRootSha256: result.headRootSha256,
          record: result.record,
        },
      });
      await store.sealTenantRestoreReplay(restoreRunId);
      const before = await store.getTenantRestoreRuntimeControl();
      if (before.state !== "active") throw new Error("expected active primary restore runtime");
      const restoreToken = await owner!.stageRestore({
        restoreRunId,
        expectedControlGeneration: before.controlGeneration,
      });
      const restoreFacade = await owner!.openActivationFacade(restoreToken, 4);
      const raw = await inspection();
      await rememberGuard(raw, "trg_restore_journal_runtime_heads_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_runtime_heads_bu");
      const forgedPrimaryLogicalDatabaseSha256 = sha256("forged-primary-logical-database");
      await raw.query(
        `UPDATE tenant_restore_runtime_heads
            SET logical_database_namespace_sha256=? WHERE singleton_id=1 AND target_ordinal=0`,
        [forgedPrimaryLogicalDatabaseSha256],
      );
      const rejectedWitness = await owner!.snapshotForRejectedActivation(restoreToken, restoreFacade);
      const rejectedActivation = restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken));
      await expect(rejectedActivation).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await owner!.proveProjectionRejected(restoreToken, rejectedActivation, rejectedWitness);
      const [firstActivationRollback] = await raw.query<RowDataPacket[]>(
        `SELECT r.phase,c.control_generation,c.evidence_sha256,
                h.logical_database_namespace_sha256,
                (SELECT COUNT(*) FROM tenant_restore_runtime_events e
                  WHERE e.update_kind='restore_activation') AS restore_event_count
           FROM tenant_restore_replay_runs r
           JOIN tenant_restore_runtime_control c ON c.singleton_id=1
           JOIN tenant_restore_runtime_heads h
             ON h.singleton_id=1 AND h.target_ordinal=0
          WHERE r.restore_run_id=?`,
        [restoreRunId],
      );
      expect(firstActivationRollback[0]).toMatchObject({
        phase: "replay_sealed",
        control_generation: before.controlGeneration,
        evidence_sha256: before.evidenceSha256,
        logical_database_namespace_sha256: forgedPrimaryLogicalDatabaseSha256,
        restore_event_count: 0,
      });
      await raw.query(
        `UPDATE tenant_restore_runtime_heads
            SET logical_database_namespace_sha256=? WHERE singleton_id=1 AND target_ordinal=0`,
        [active.logicalDatabaseNamespaceSha256],
      );
      const activated = await restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken));
      await owner!.confirm(restoreToken, restoreFacade);
      await restoreGuardNow("trg_restore_journal_runtime_heads_bu");
      store = await owner!.openStore(4, scope().signal);
      await expect(store.getTenantRuntimeState(erasedTenantId)).resolves.toMatchObject({
        state: "erased",
        generation: 7,
        activeRequestId: record.requestId,
      });
      await expect(store.getSession(erasedTenantId, legacySession.id)).resolves.toBeNull();
      await expect(store.getTenant(erasedTenantId)).resolves.toBeNull();
      await expect(seedTenant(store, erasedTenantId)).rejects.toBeInstanceOf(SubjectDeletingError);
      await expect(store.renewUserDataExportDownload(
        download.artifactId,
        download.leaseToken,
        60_000,
      )).resolves.toBe(false);
      const healthyTenantId = `restore-export-neighbor-${randomUUID()}`;
      const healthyUserId = `restore-export-user-${randomUUID()}`;
      await store.setTenantAuth(healthyTenantId, DEFAULT_AUTH_POLICY);
      await store.createSession(mkSession(healthyTenantId, healthyUserId));
      await activateExportPolicy(store, healthyTenantId);
      const healthyExport = await requestExport(
        store,
        healthyTenantId,
        healthyUserId,
        "healthy-after-restore",
      );
      await raw.query(
        "UPDATE user_export_jobs SET available_at_ms=0 WHERE request_id=?",
        [fencedQueuedExport.requestId],
      );
      const exportClaims = await store.claimUserDataExports({
        limit: 1,
        leaseMs: 60_000,
        claimToken: `restore-export-claim-${randomUUID()}`,
      });
      expect(exportClaims).toHaveLength(1);
      expect(exportClaims[0]?.requestId).toBe(healthyExport.requestId);
      await expect(store.requestUserErasure({
        requestId: newErasureRequestId(),
        tenantId: erasedTenantId,
        userId: erasedUserId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKey: `restore-user-${randomUUID()}`,
        requestHash: userErasureRequestHash(erasedTenantId, erasedUserId),
        atMs: Date.now(),
      })).rejects.toBeInstanceOf(SubjectDeletingError);
      await expect(store.requestUserDataExport({
        requestId: newUserDataExportRequestId(),
        tenantId: erasedTenantId,
        userId: erasedUserId,
        requestedByKeyId: "restore-journal-mysql-test",
        idempotencyKeySha256: userDataExportIdempotencyKeySha256(`restore-${randomUUID()}`),
        requestHash: userDataExportRequestHash(erasedTenantId, erasedUserId),
      })).rejects.toBeInstanceOf(SubjectDeletingError);
      await expect(restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken))).resolves.toEqual(activated);
      await owner!.confirm(restoreToken, restoreFacade);
      await raw.query("DROP TRIGGER trg_restore_journal_runtime_heads_bu");
      await raw.query(
        `UPDATE tenant_restore_runtime_heads
            SET remote_sequence=0,head_root_sha256=?,logical_database_namespace_sha256=?`,
        [
          EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
          sha256("forged-runtime-logical-database"),
        ],
      );
      await expect(store.getTenantRestoreRuntimeControl()).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await expect(store.assertTenantRestoreRuntimeReady({
        runtimeEpochSha256,
        controlEvidenceSha256: active.controlEvidenceSha256,
        observedHeads: sealedTargets,
      })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await expect(restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken))).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await raw.query(
        `UPDATE tenant_restore_runtime_heads
            SET remote_sequence=1,head_root_sha256=?,logical_database_namespace_sha256=?`,
        [result.headRootSha256, active.logicalDatabaseNamespaceSha256],
      );
      await expect(restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken))).resolves.toEqual(activated);
      await owner!.confirm(restoreToken, restoreFacade);
      await restoreGuardNow("trg_restore_journal_runtime_heads_bu");
      await rememberGuard(raw, "trg_restore_journal_runs_bu");
      await raw.query("DROP TRIGGER trg_restore_journal_runs_bu");
      await raw.query(
        `UPDATE tenant_restore_replay_runs
            SET sealed_target_catalog_json=JSON_SET(
              sealed_target_catalog_json,'$[0].adapterProtocol','forged-adapter-v1'
            ) WHERE restore_run_id=?`,
        [restoreRunId],
      );
      await expect(store.getTenantRestoreReplayRun(restoreRunId)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await expect(store.sealTenantRestoreReplay(restoreRunId)).rejects.toBeInstanceOf(
        TenantErasureIntegrityError,
      );
      await expect(restoreFacade.activateTenantRestoreRuntime(owner!.restoreInput(restoreToken))).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      await raw.end();
      await store.close();
    }));
  });
} else {
  describe("MysqlSessionStore tenant restore journal", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with a disposable MySQL test database to enable", () => {});
  });
}
