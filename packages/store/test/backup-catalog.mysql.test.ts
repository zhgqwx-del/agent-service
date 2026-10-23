import { createHash, randomUUID } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantBackupCatalogConflictError,
  TenantBackupCatalogNotReadyError,
  newTenantBackupEvictionId,
  newTenantBackupId,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionReceiptSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupResolutionReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantBackupSchemaMigrationRootSha256,
  tenantRestoreLogicalDatabaseNamespaceSha256,
  tenantRestoreRuntimeEpochSha256,
  type ActiveTenantBackupCatalogControlRecord,
  type PrepareTenantRestoreReplayFromBackupInput,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupCatalogEntry,
  type TenantBackupCatalogEventProof,
  type TenantBackupEvictionAdapterResult,
  type TenantBackupEvictionPlan,
  type TenantBackupRuntimeReservationAdapterResult,
  type TenantRestoreJournalTargetDescriptor,
  type TenantRestoreReplaySealedTarget,
} from "../src/index.js";
import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizedSql(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/\s+/g, " ").trim() : "";
}

function isPendingRestoreRunLockQuery(sql: string): boolean {
  return sql.includes("FROM tenant_restore_replay_runs")
    && sql.includes("WHERE phase IN ('prepared','replay_sealed') LIMIT 1 FOR UPDATE");
}

function isBackupCatalogWriteLockQuery(sql: string): boolean {
  return sql.includes("FROM backup_catalog_control WHERE singleton_id=1 FOR UPDATE");
}

type MysqlQueryCall = (...args: unknown[]) => Promise<unknown>;

function observeStoreConnectionQueries(
  store: MysqlSessionStore,
  hooks: {
    onConnection?: (connectionId: number) => void;
    beforeQuery?: (
      sql: string,
      connectionId: number,
      query: MysqlQueryCall,
    ) => Promise<void> | void;
    afterQuery?: (
      sql: string,
      connectionId: number,
      query: MysqlQueryCall,
    ) => Promise<void> | void;
  },
): () => void {
  const pool = (store as unknown as {
    pool: { getConnection: () => Promise<PoolConnection> };
  }).pool;
  const originalGetConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await originalGetConnection();
    await connection.query("SET SESSION innodb_lock_wait_timeout=10");
    const [connectionRows] = await connection.query<RowDataPacket[]>(
      "SELECT CONNECTION_ID() AS connection_id",
    );
    const connectionId = Number(connectionRows[0]?.connection_id);
    if (!Number.isSafeInteger(connectionId) || connectionId < 1) {
      connection.release();
      throw new Error("could not identify observed MySQL connection");
    }
    hooks.onConnection?.(connectionId);
    const originalQuery = connection.query.bind(connection) as MysqlQueryCall;
    const observedQuery: MysqlQueryCall = async (...args) => {
      const sql = normalizedSql(args[0]);
      if (sql) await hooks.beforeQuery?.(sql, connectionId, originalQuery);
      const result = await originalQuery(...args);
      if (sql) await hooks.afterQuery?.(sql, connectionId, originalQuery);
      return result;
    };
    return new Proxy(connection, {
      get(target, property) {
        if (property === "query") return observedQuery;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return () => {
    pool.getConnection = originalGetConnection;
  };
}

async function waitForMysqlConnectionLockWait(
  observer: CaptureMysqlInspection,
  connectionId: number,
  blockerConnectionId: number,
  queryMarker: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS edge_count FROM performance_schema.data_lock_waits w '
      + 'JOIN performance_schema.threads r ON r.THREAD_ID=w.REQUESTING_THREAD_ID '
      + 'JOIN performance_schema.threads b ON b.THREAD_ID=w.BLOCKING_THREAD_ID '
      + 'JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID '
      + "WHERE r.PROCESSLIST_ID=? AND b.PROCESSLIST_ID=? AND l.OBJECT_SCHEMA=DATABASE() AND l.OBJECT_NAME=? AND l.LOCK_TYPE='RECORD' AND l.LOCK_STATUS='WAITING'",
      [connectionId, blockerConnectionId, queryMarker],
    );
    if (rows.length === 1 && Number(rows[0]?.edge_count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the exact owned native restore gate edge');
}

/** Attempt every owned cleanup sequentially and preserve the first error, including undefined. */
async function withOwnedCleanup<T>(body: () => Promise<T>, cleanups: readonly (() => Promise<unknown> | void)[]): Promise<T> {
  let hasError = false, firstError: unknown, value: T | undefined;
  try { value = await body(); } catch (error) { hasError = true; firstError = error; }
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { if (!hasError) { hasError = true; firstError = error; } }
  }
  if (hasError) throw firstError;
  return value as T;
}

type SavedBackupGuard = { createSql: string; sqlMode: string; charset: string; collation: string; metadata: string };
const BACKUP_GUARD_NAME = 'trg_backup_catalog_entries_bu';
async function backupGuardMetadata(raw: CaptureMysqlInspection): Promise<string> {
  const [rows] = await raw.query<RowDataPacket[]>('SELECT TRIGGER_NAME,EVENT_MANIPULATION,EVENT_OBJECT_TABLE,ACTION_TIMING,ACTION_ORIENTATION,ACTION_ORDER,'
    + 'ACTION_STATEMENT,SQL_MODE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS '
    + 'WHERE TRIGGER_SCHEMA=DATABASE() AND BINARY TRIGGER_NAME=BINARY ?', [BACKUP_GUARD_NAME]);
  if (rows.length !== 1) throw new Error('Backup guard native metadata is missing');
  return JSON.stringify(rows[0]);
}
async function captureBackupGuard(raw: CaptureMysqlInspection): Promise<SavedBackupGuard> {
  const [rows] = await raw.query<RowDataPacket[]>('SHOW CREATE TRIGGER `' + BACKUP_GUARD_NAME + '`');
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row['SQL Original Statement'] !== 'string' || typeof row.sql_mode !== 'string'
    || typeof row.character_set_client !== 'string' || typeof row.collation_connection !== 'string'
    || !/^[A-Za-z0-9_]+$/.test(row.character_set_client) || !/^[A-Za-z0-9_]+$/.test(row.collation_connection)) {
    throw new Error('Backup guard native CREATE is invalid');
  }
  return { createSql: row['SQL Original Statement'], sqlMode: row.sql_mode,
    charset: row.character_set_client, collation: row.collation_connection, metadata: await backupGuardMetadata(raw) };
}
async function restoreBackupGuard(raw: CaptureMysqlInspection, guard: SavedBackupGuard): Promise<void> {
  const [rows] = await raw.query<RowDataPacket[]>('SELECT @@SESSION.sql_mode AS mode,@@SESSION.character_set_client AS client,'
    + '@@SESSION.character_set_results AS results,@@SESSION.collation_connection AS collation');
  const previous = rows[0];
  if (rows.length !== 1 || !previous || typeof previous.mode !== 'string' || typeof previous.client !== 'string'
    || (previous.results !== null && typeof previous.results !== 'string') || typeof previous.collation !== 'string') {
    throw new Error('Backup guard observer session is invalid');
  }
  await withOwnedCleanup(async () => {
    await raw.query('SET SESSION sql_mode=?', [guard.sqlMode]);
    await raw.query('SET NAMES ' + guard.charset + ' COLLATE ' + guard.collation);
    await raw.query(guard.createSql);
    if (await backupGuardMetadata(raw) !== guard.metadata) throw new Error('Backup guard exact restoration failed');
  }, [() => raw.query('SET SESSION character_set_client=?,character_set_results=?,collation_connection=?,sql_mode=?',
    [previous.client, previous.results, previous.collation, previous.mode])]);
}

function sha256(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function eventProof(
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
  eventType: Parameters<typeof tenantBackupCatalogEventSha256>[0]["eventType"],
  operationSha256: string,
  receiptSha256: string,
): TenantBackupCatalogEventProof {
  const catalogEventSha256 = tenantBackupCatalogEventSha256({
    eventType,
    operationSha256,
    receiptSha256,
  });
  return {
    catalogSequence,
    previousCatalogEventRootSha256,
    catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      catalogSequence,
      previousCatalogEventRootSha256,
      catalogEventSha256,
    }),
  };
}

interface Fixture {
  store: MysqlSessionStore;
  owner: CaptureMysqlRuntimeOwner;
  control: ActiveTenantBackupCatalogControlRecord;
  target: TenantRestoreJournalTargetDescriptor;
  sealedTargets: TenantRestoreReplaySealedTarget[];
  schemaMigrationRootSha256: string;
  blobStorageControlEvidenceSha256: string;
}

async function fixture(
  owner: CaptureMysqlRuntimeOwner,
  signal: AbortSignal,
  minimumRecoverableBackups = 1,
  minimumRetentionMs = 60_000,
): Promise<Fixture> {
  let store = await owner.openStore(8, signal);
  const blob = await store.activateBlobStorageControl({
    expectedControlGeneration: 0,
    storageBackend: "s3v1-backup-test",
    namespaceSha256: sha256("backup-catalog-blob-namespace"),
  });
  const logicalDatabaseNamespaceSha256 =
    tenantRestoreLogicalDatabaseNamespaceSha256("backup-catalog-mysql-database");
  const target: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: 0,
    targetSha256: sha256("backup-catalog-restore-target"),
    failureDomainSha256: sha256("backup-catalog-restore-failure-domain"),
    adapterProtocol: "mysql-backup-restore-journal-v1",
    journalNamespaceSha256: sha256("backup-catalog-restore-journal-namespace"),
  };
  const sealedTargets: TenantRestoreReplaySealedTarget[] = [{
    ...target,
    logicalDatabaseNamespaceSha256,
    sealedRemoteSequence: 0,
    sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  }];
  await owner.activatePrimary({
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256,
    runtimeEpochSha256: tenantRestoreRuntimeEpochSha256(`backup-primary-${randomUUID()}`),
    targets: [target],
    observedHeads: sealedTargets,
  });
  store = await owner.openStore(8, signal);
  const journal = await store.getTenantRestoreJournalControl();
  if (journal.controlGeneration !== 1) throw new Error("restore journal did not activate");
  const activated = await store.activateTenantBackupCatalogControl({
    expectedControlGeneration: 0,
    adapterProtocol: "mysql-authoritative-backup-catalog-v1",
    catalogNamespaceSha256: sha256("backup-catalog-external-namespace"),
    catalogTargetSha256: sha256("backup-catalog-external-target"),
    failureDomainSha256: sha256("backup-catalog-external-failure-domain"),
    logicalDatabaseNamespaceSha256,
    journalControlEvidenceSha256: journal.evidenceSha256,
    retentionPolicySha256: sha256("backup-catalog-retention-policy"),
    minimumRetentionMs,
    minimumRecoverableBackups,
  });
  const raw = await owner.openInspection(signal);
  const [migrationRows] = await raw.query<RowDataPacket[]>(
    "SELECT name FROM schema_migrations ORDER BY BINARY name",
  );
  await raw.end();
  return {
    store,
    owner,
    control: activated.value,
    target,
    sealedTargets,
    schemaMigrationRootSha256: tenantBackupSchemaMigrationRootSha256(
      migrationRows.map((row) => String(row.name)),
    ),
    blobStorageControlEvidenceSha256: blob.evidenceSha256,
  };
}

async function anchorBackup(f: Fixture, backupId: string) {
  return f.store.createTenantBackupSnapshotAnchor({
    backupId,
    controlEvidenceSha256: f.control.evidenceSha256,
  });
}

async function availabilityResult(
  f: Fixture,
  backupId: string,
  label: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): Promise<TenantBackupAvailabilityAdapterResult> {
  const anchor = (await anchorBackup(f, backupId)).value;
  const base = {
    backupId,
    anchorSha256: anchor.anchorSha256,
    sourceSnapshotSha256: sha256(`${label}-snapshot`),
    sourceBackupSha256: sha256(`${label}-backup-artifact`),
    artifactManifestSha256: sha256(`${label}-artifact-manifest`),
    providerEvidenceSha256: sha256(`${label}-provider-evidence`),
    controlEvidenceSha256: anchor.controlEvidenceSha256,
    logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
    retentionPolicySha256: f.control.retentionPolicySha256,
    retentionUntilDbMs: anchor.retentionUntilDbMs,
    registeredAtDbMs: anchor.createdAtDbMs,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
  };
  const availabilityOperationSha256 = tenantBackupAvailabilityOperationSha256(base);
  const availabilityReceiptSha256 = tenantBackupAvailabilityReceiptSha256({
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    failureDomainSha256: f.control.failureDomainSha256,
  }, base, availabilityOperationSha256);
  const evidence = {
    adapterProtocol: f.control.adapterProtocol,
    failureDomainSha256: f.control.failureDomainSha256,
    ...base,
    availabilityOperationSha256,
    availabilityReceiptSha256,
    ...eventProof(
      catalogSequence,
      previousCatalogEventRootSha256,
      "backup_recoverable",
      availabilityOperationSha256,
      availabilityReceiptSha256,
    ),
  };
  return {
    ...evidence,
    entrySha256: tenantBackupCatalogEntrySha256({
      scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
      protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
      ...evidence,
    }),
  };
}

async function publishBackup(
  f: Fixture,
  backupId: string,
  label: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): Promise<TenantBackupCatalogEntry> {
  return (await f.store.recordTenantBackupCatalogAvailability(await availabilityResult(
    f,
    backupId,
    label,
    catalogSequence,
    previousCatalogEventRootSha256,
  ))).value;
}

function reservationResult(
  f: Fixture,
  entry: TenantBackupCatalogEntry,
  restoreRunId: string,
  runtimeEpochSha256: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): TenantBackupRuntimeReservationAdapterResult {
  const identity = {
    backupId: entry.backupId,
    restoreRunId,
    entrySha256: entry.entrySha256,
    runtimeEpochSha256,
  };
  const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
  const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    failureDomainSha256: f.control.failureDomainSha256,
  }, identity, reservationOperationSha256);
  return {
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    ...identity,
    reservationOperationSha256,
    reservationReceiptSha256,
    ...eventProof(
      catalogSequence,
      previousCatalogEventRootSha256,
      "restore_reserved",
      reservationOperationSha256,
      reservationReceiptSha256,
    ),
  };
}

function restoreInput(
  f: Fixture,
  entry: TenantBackupCatalogEntry,
  epochLabel: string,
  catalogSequence: number,
  previousCatalogEventRootSha256: string,
): PrepareTenantRestoreReplayFromBackupInput {
  const restoreRunId = `restore_${randomUUID()}`;
  const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(epochLabel);
  return {
    backupId: entry.backupId,
    restoreRunId,
    runtimeEpochSha256,
    controlEvidenceSha256: f.control.journalControlEvidenceSha256,
    sealedTargets: structuredClone(f.sealedTargets),
    reservation: reservationResult(
      f,
      entry,
      restoreRunId,
      runtimeEpochSha256,
      catalogSequence,
      previousCatalogEventRootSha256,
    ),
  };
}

function evictionAck(
  f: Fixture,
  plan: TenantBackupEvictionPlan,
): TenantBackupEvictionAdapterResult {
  const externalTombstoneSha256 = sha256(`eviction-tombstone-${plan.evictionId}`);
  const acknowledgementReceiptSha256 = tenantBackupEvictionReceiptSha256({
    plan,
    externalTombstoneSha256,
    observedAbsent: true,
  });
  return {
    adapterProtocol: f.control.adapterProtocol,
    catalogNamespaceSha256: f.control.catalogNamespaceSha256,
    catalogTargetSha256: f.control.catalogTargetSha256,
    evictionId: plan.evictionId,
    backupId: plan.backupId,
    planSha256: plan.planSha256,
    evictionOperationSha256: tenantBackupEvictionOperationSha256(plan),
    acknowledgementReceiptSha256,
    externalTombstoneSha256,
    observedAbsent: true,
    ...eventProof(
      plan.expectedCatalogSequence + 1,
      plan.expectedCatalogEventRootSha256,
      "backup_evicted",
      plan.evictionOperationSha256,
      acknowledgementReceiptSha256,
    ),
  };
}

async function resolveAbortedReservation(
  f: Fixture,
  prepared: Awaited<ReturnType<MysqlSessionStore["prepareTenantRestoreReplayFromBackup"]>>,
) {
  const reservation = prepared.value.reservation;
  const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
    restoreRunId: reservation.restoreRunId,
    reservationReceiptSha256: reservation.reservationReceiptSha256,
    phase: "aborted",
  });
  const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
    restoreRunId: reservation.restoreRunId,
    reservationReceiptSha256: reservation.reservationReceiptSha256,
    phase: "aborted",
  });
  return f.store.resolveTenantBackupRuntimeReservation({
    restoreRunId: reservation.restoreRunId,
    reservationReceiptSha256: reservation.reservationReceiptSha256,
    phase: "aborted",
    resolutionOperationSha256,
    resolutionReceiptSha256,
    ...eventProof(
      reservation.catalogSequence + 1,
      reservation.catalogEventRootSha256,
      "restore_resolved",
      resolutionOperationSha256,
      resolutionReceiptSha256,
    ),
  });
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore authoritative backup catalog", () => {
    let base: URL;
    type Scope = { owner: CaptureMysqlRuntimeOwner; signal: AbortSignal; prepared: boolean;
      failed: boolean; settled: boolean; preparation?: Promise<void>; work?: Promise<void>;
      closing?: Promise<void>; detach: () => void; cleanupReported?: boolean };
    const scopes = new Set<Scope>();
    let current: Scope | undefined;
    function scope(): Scope {
      if (!current) throw new Error('Backup catalog current case is not registered');
      return current;
    }
    async function finish(value: Scope): Promise<void> {
      value.closing ??= value.owner.close({ successful: value.prepared && !value.failed && !value.signal.aborted });
      try { await value.closing; }
      catch (error) {
        if (!value.failed) { value.failed = true; throw error; }
        if (!value.cleanupReported) {
          value.cleanupReported = true;
          try { console.warn('backup_catalog_fixture_cleanup_failed_after_primary_failure'); }
          catch { /* Keep the original body failure, including undefined. */ }
        }
      } finally { value.detach(); }
    }
    function runCase(body: () => Promise<void>) {
      return (): Promise<void> => {
        const value = scope();
        const work = Promise.resolve().then(async () => {
          try { value.signal.throwIfAborted(); await body(); value.signal.throwIfAborted(); }
          catch (error) { value.failed = true; throw error; }
        });
        value.work = work;
        void work.then(() => { value.settled = true; }, () => { value.settled = true; });
        return work;
      };
    }
    beforeAll(() => { base = disposableBase(BASE_MYSQL_URL); });
    beforeEach(async ({ signal }) => {
      if ([...scopes].some(value => value.work && !value.settled)) throw new Error('Backup catalog prior body is not settled');
      const owner = new CaptureMysqlRuntimeOwner(base.toString(), {
        tenantTelemetryRefKey: null, tenantTelemetryPersistedProviderCaptureLocalOnly: false,
        tenantTelemetryCaptureRestoreLocalOnly: false,
      });
      const value: Scope = { owner, signal, prepared: false, failed: false, settled: false, detach: () => {} };
      current = value; scopes.add(value);
      const abort = () => { value.failed = true; void owner.close({ successful: false }).catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      value.detach = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
      value.preparation = owner.prepare();
      try { await value.preparation; value.prepared = true; signal.throwIfAborted(); }
      catch (error) { value.failed = true; throw error; }
    });
    afterEach(async () => {
      const value = scope();
      if (!value.prepared) { value.failed = true; await finish(value); }
      await Promise.allSettled(value.preparation ? [value.preparation] : []);
      await Promise.allSettled(value.work ? [value.work] : []);
      await finish(value);
    });
    afterAll(async () => {
      const closed = await Promise.allSettled([...scopes].map(async value => {
        if (!value.prepared) { value.failed = true; await finish(value); }
        await Promise.allSettled(value.preparation ? [value.preparation] : []);
        await Promise.allSettled(value.work ? [value.work] : []);
        await finish(value);
      }));
      const error = closed.find(result => result.status === 'rejected');
      if (error?.status === 'rejected') throw error.reason;
    });

    it("verifies the exact 0031 schema and owned-trigger fingerprint on startup", runCase(async () => {
      const raw = await scope().owner.openInspection(scope().signal);
      let saved: SavedBackupGuard | undefined, dropped = false;
      await withOwnedCleanup(async () => {
        saved = await captureBackupGuard(raw);
        await raw.query("DROP TRIGGER trg_backup_catalog_entries_bu");
        dropped = true;
        await expect(scope().owner.openStore(1, scope().signal))
          .rejects.toThrow(/0031 tenant backup catalog schema fingerprint verification failed/);
      }, [async () => { if (dropped && saved) await restoreBackupGuard(raw, saved); }, () => raw.end()]);
    }));

    it("rolls activation back when Blob control is still dormant", runCase(async () => {
      let store = await scope().owner.openStore(2, scope().signal);
      const logicalDatabaseNamespaceSha256 =
        tenantRestoreLogicalDatabaseNamespaceSha256("backup-catalog-dormant-blob-database");
      const target: TenantRestoreJournalTargetDescriptor = {
        targetOrdinal: 0,
        targetSha256: sha256("backup-catalog-dormant-blob-target"),
        failureDomainSha256: sha256("backup-catalog-dormant-blob-failure-domain"),
        adapterProtocol: "mysql-backup-restore-journal-v1",
        journalNamespaceSha256: sha256("backup-catalog-dormant-blob-journal"),
      };
      await scope().owner.activatePrimary({
        adapterProtocol: target.adapterProtocol,
        journalNamespaceSha256: target.journalNamespaceSha256,
        logicalDatabaseNamespaceSha256,
        runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("dormant-blob-runtime"),
        targets: [target],
        observedHeads: [{
          ...target,
          logicalDatabaseNamespaceSha256,
          sealedRemoteSequence: 0,
          sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
        }],
      });
      store = await scope().owner.openStore(2, scope().signal);
      const journal = await store.getTenantRestoreJournalControl();
      if (journal.controlGeneration !== 1) throw new Error("restore journal did not activate");
      await expect(store.activateTenantBackupCatalogControl({
        expectedControlGeneration: 0,
        adapterProtocol: "mysql-authoritative-backup-catalog-v1",
        catalogNamespaceSha256: sha256("dormant-blob-catalog"),
        catalogTargetSha256: sha256("dormant-blob-catalog-target"),
        failureDomainSha256: sha256("dormant-blob-catalog-failure-domain"),
        logicalDatabaseNamespaceSha256,
        journalControlEvidenceSha256: journal.evidenceSha256,
        retentionPolicySha256: sha256("dormant-blob-retention"),
        minimumRetentionMs: 1,
        minimumRecoverableBackups: 1,
      })).rejects.toBeInstanceOf(TenantBackupCatalogNotReadyError);
      await expect(store.getTenantBackupCatalogControl()).resolves.toEqual({
        singletonId: 1,
        state: "inactive",
        controlGeneration: 0,
      });
      await store.close();
    }));

    it("derives anchor lineage from live schema, Blob control, and runtime state", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const backupId = newTenantBackupId();
      const first = await anchorBackup(f, backupId);
      expect(first.disposition).toBe("created");
      expect((await anchorBackup(f, backupId)).disposition).toBe("exact_replay");

      const runtime = await f.store.getTenantRestoreRuntimeControl();
      if (runtime.state !== "active") throw new Error("runtime inactive");
      expect(first.value).toMatchObject({
        sourceRuntimeEpochSha256: runtime.runtimeEpochSha256,
        sourceRuntimeControlGeneration: runtime.controlGeneration,
        sourceRuntimeControlEvidenceSha256: runtime.evidenceSha256,
        sourceRuntimeTargetCount: runtime.targetCount,
        sourceRuntimeHeads: await f.store.getTenantRestoreRuntimeHeads(),
        sourceRuntimeHeadRootSha256: runtime.verifiedHeadRootSha256,
        schemaMigrationRootSha256: f.schemaMigrationRootSha256,
        blobStorageControlEvidenceSha256: f.blobStorageControlEvidenceSha256,
        sourceCatalogSequence: 0,
        sourceCatalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      });
      await expect(f.store.createTenantBackupSnapshotAnchor({
        backupId: newTenantBackupId(),
        controlEvidenceSha256: f.control.evidenceSha256,
        schemaMigrationRootSha256: sha256("caller-forged-schema-root"),
      } as Parameters<typeof f.store.createTenantBackupSnapshotAnchor>[0])).rejects.toThrow(
        /unknown or missing fields/,
      );

      const raw = await scope().owner.openInspection(scope().signal);
      const [rows] = await raw.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS anchor_count FROM backup_snapshot_anchors",
      );
      expect(Number(rows[0]?.anchor_count)).toBe(1);
      await raw.end();
      await f.store.close();
    }));

    it("publishes an exact entry and hides all provider locators and tenant/user content", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const backupId = newTenantBackupId();
      const result = await availabilityResult(
        f,
        backupId,
        "content-free",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const created = await f.store.recordTenantBackupCatalogAvailability(result);
      expect(created.disposition).toBe("created");
      const anchor = await f.store.getTenantBackupSnapshotAnchor(backupId);
      expect(anchor).not.toBeNull();
      expect(created.value.registeredAtDbMs).toBe(anchor?.createdAtDbMs);
      const nextAnchor = await anchorBackup(f, newTenantBackupId());
      expect(nextAnchor.value).toMatchObject({
        sourceCatalogSequence: created.value.catalogSequence,
        sourceCatalogEventRootSha256: created.value.catalogEventRootSha256,
      });
      expect((await f.store.recordTenantBackupCatalogAvailability(result)).disposition)
        .toBe("exact_replay");
      expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toEqual([created.value]);
      await expect(f.store.recordTenantBackupCatalogAvailability({
        ...result,
        providerLocator: "s3://secret/location",
      } as TenantBackupAvailabilityAdapterResult)).rejects.toThrow(/unknown or missing fields/);

      const raw = await scope().owner.openInspection(scope().signal);
      const [columns] = await raw.query<RowDataPacket[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema=DATABASE() AND table_name LIKE 'backup\\_%'
            AND column_name IN ('tenant_id','user_id','provider_locator','endpoint','credential')`,
      );
      expect(columns).toHaveLength(0);
      await raw.end();
      await f.store.close();
    }));

    it("rejects an exact eviction replay from the wrong catalog authority", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal, 1, 1);
      const first = await publishBackup(
        f,
        newTenantBackupId(),
        "eviction-authority-a",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      await publishBackup(
        f,
        newTenantBackupId(),
        "eviction-authority-b",
        2,
        first.catalogEventRootSha256,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const plan = await f.store.prepareTenantBackupEviction({
        evictionId: newTenantBackupEvictionId(),
        backupId: first.backupId,
      });
      const acknowledgement = evictionAck(f, plan);
      await expect(f.store.recordTenantBackupCatalogEviction({ plan, acknowledgement }))
        .resolves.toMatchObject({ disposition: "created" });
      await expect(f.store.recordTenantBackupCatalogEviction({
        plan,
        acknowledgement: {
          ...acknowledgement,
          catalogNamespaceSha256: sha256("wrong-exact-replay-namespace"),
        },
      })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      await expect(f.store.recordTenantBackupCatalogEviction({
        plan,
        acknowledgement: {
          ...acknowledgement,
          catalogTargetSha256: sha256("wrong-exact-replay-target"),
        },
      })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      await f.store.close();
    }));

    it("rolls binding, reservation, and replay run back together on a late SQL failure", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const entry = await publishBackup(
        f,
        newTenantBackupId(),
        "rollback",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const input = restoreInput(f, entry, "rollback-epoch", 2, entry.catalogEventRootSha256);
      await expect(f.store.prepareTenantRestoreReplay({
        restoreRunId: input.restoreRunId,
        sourceBackupSha256: entry.sourceBackupSha256,
        runtimeEpochSha256: input.runtimeEpochSha256,
        controlEvidenceSha256: input.controlEvidenceSha256,
        sealedTargets: input.sealedTargets,
      })).rejects.toBeInstanceOf(TenantBackupCatalogNotReadyError);

      const raw = await scope().owner.openInspection(scope().signal);
      await withOwnedCleanup(async () => {
      await raw.query(
        `CREATE TRIGGER test_fail_backup_replay_insert
           BEFORE INSERT ON tenant_restore_replay_runs
           FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected replay insert failure'`,
      );
      await expect(f.store.prepareTenantRestoreReplayFromBackup(input)).rejects.toThrow(
        "injected replay insert failure",
      );
      const [rolledBack] = await raw.query<RowDataPacket[]>(
        `SELECT
          (SELECT COUNT(*) FROM backup_restore_source_bindings) AS binding_count,
          (SELECT COUNT(*) FROM backup_runtime_reservations) AS reservation_count,
          (SELECT COUNT(*) FROM tenant_restore_replay_runs) AS run_count,
          (SELECT COUNT(*) FROM backup_catalog_external_events) AS event_count`,
      );
      expect(rolledBack[0]).toMatchObject({
        binding_count: 0,
        reservation_count: 0,
        run_count: 0,
        event_count: 1,
      });
      await raw.query("DROP TRIGGER test_fail_backup_replay_insert");
      const prepared = await f.store.prepareTenantRestoreReplayFromBackup(input);
      expect(prepared.disposition).toBe("created");
      expect((await f.store.prepareTenantRestoreReplayFromBackup(input)).disposition)
        .toBe("exact_replay");
      }, [() => raw.query("DROP TRIGGER IF EXISTS test_fail_backup_replay_insert"), () => raw.end(), () => f.store.close()]);
    }));

    it("mirrors an external resolution before the local run is terminal and projects it on replay", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const entry = await publishBackup(
        f,
        newTenantBackupId(),
        "historical-resolution",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const prepared = await f.store.prepareTenantRestoreReplayFromBackup(
        restoreInput(f, entry, "historical-resolution-epoch", 2, entry.catalogEventRootSha256),
      );
      const reservation = prepared.value.reservation;
      const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256({
        restoreRunId: reservation.restoreRunId,
        reservationReceiptSha256: reservation.reservationReceiptSha256,
        phase: "aborted",
      });
      const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256({
        restoreRunId: reservation.restoreRunId,
        reservationReceiptSha256: reservation.reservationReceiptSha256,
        phase: "aborted",
      });
      const resolution = {
        restoreRunId: reservation.restoreRunId,
        reservationReceiptSha256: reservation.reservationReceiptSha256,
        phase: "aborted" as const,
        resolutionOperationSha256,
        resolutionReceiptSha256,
        ...eventProof(
          3,
          reservation.catalogEventRootSha256,
          "restore_resolved",
          resolutionOperationSha256,
          resolutionReceiptSha256,
        ),
      };
      const mirrorInput = {
        adapterProtocol: f.control.adapterProtocol,
        catalogNamespaceSha256: f.control.catalogNamespaceSha256,
        catalogTargetSha256: f.control.catalogTargetSha256,
        failureDomainSha256: f.control.failureDomainSha256,
        event: { eventType: "restore_resolved" as const, result: resolution },
      };

      await expect(f.store.mirrorTenantBackupCatalogEvent(mirrorInput))
        .resolves.toMatchObject({ disposition: "created" });
      await expect(f.store.mirrorTenantBackupCatalogEvent(mirrorInput))
        .resolves.toMatchObject({ disposition: "exact_replay" });
      expect(await f.store.getTenantBackupRuntimeReservation(reservation.restoreRunId))
        .toMatchObject({ phase: "reserved" });
      await expect(f.store.listRecoverableTenantBackups({ limit: 10 })).resolves.toEqual([entry]);

      await expect(f.store.abortTenantRestoreReplay(reservation.restoreRunId)).resolves.toBe(true);
      await expect(f.store.resolveTenantBackupRuntimeReservation(resolution)).resolves.toMatchObject({
        disposition: "exact_replay",
        value: { phase: "aborted" },
      });
      await f.store.close();
    }));

    it("preflights a fresh restore, permits only the exact active reservation, and rejects used identities", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const entry = await publishBackup(
        f,
        newTenantBackupId(),
        "preflight",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const input = restoreInput(f, entry, "preflight-epoch", 2, entry.catalogEventRootSha256);
      const preflight = {
        backupId: input.backupId,
        restoreRunId: input.restoreRunId,
        runtimeEpochSha256: input.runtimeEpochSha256,
      };

      await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
      const prepared = await f.store.prepareTenantRestoreReplayFromBackup(input);
      await expect(f.store.preflightTenantRestoreReplayFromBackup(preflight)).resolves.toEqual(entry);
      await expect(f.store.preflightTenantRestoreReplayFromBackup({
        backupId: entry.backupId,
        restoreRunId: `restore_${randomUUID()}`,
        runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("blocked-by-active-reservation"),
      })).rejects.toMatchObject({ reason: "restore_reservation_active" });

      await expect(f.store.abortTenantRestoreReplay(input.restoreRunId)).resolves.toBe(true);
      await resolveAbortedReservation(f, prepared);
      await expect(f.store.preflightTenantRestoreReplayFromBackup({
        ...preflight,
        runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("different-epoch-for-used-run"),
      })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      await expect(f.store.preflightTenantRestoreReplayFromBackup({
        ...preflight,
        restoreRunId: `restore_${randomUUID()}`,
      })).rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      await f.store.close();
    }));

    it("serializes competing external catalog events without a fork", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const first = await availabilityResult(
        f,
        newTenantBackupId(),
        "concurrent-a",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const second = await availabilityResult(
        f,
        newTenantBackupId(),
        "concurrent-b",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const results = await Promise.allSettled([
        f.store.recordTenantBackupCatalogAvailability(first),
        f.store.recordTenantBackupCatalogAvailability(second),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toHaveLength(1);
      await f.store.close();
    }));

    it("serializes legacy and catalog-bound restore preparation without a lock-order deadlock", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const entry = await publishBackup(
        f,
        newTenantBackupId(),
        "legacy-catalog-race",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const bound = restoreInput(
        f,
        entry,
        "catalog-bound-race-epoch",
        2,
        entry.catalogEventRootSha256,
      );
      const legacy = {
        restoreRunId: `restore_${randomUUID()}`,
        sourceBackupSha256: sha256("legacy-race-source-backup"),
        runtimeEpochSha256: tenantRestoreRuntimeEpochSha256("legacy-race-epoch"),
        controlEvidenceSha256: bound.controlEvidenceSha256,
        sealedTargets: bound.sealedTargets,
      };

      const boundStore = await scope().owner.openStore(2, scope().signal);
      const observer = await scope().owner.openInspection(scope().signal);
      const gateA = await scope().owner.openInspection(scope().signal);
      const gateB = await scope().owner.openInspection(scope().signal);
      await gateA.query("SET SESSION innodb_lock_wait_timeout=10");
      await gateB.query("SET SESSION innodb_lock_wait_timeout=10");
      const [gateARows] = await gateA.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS connection_id");
      const [gateBRows] = await gateB.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS connection_id");
      const gateAConnectionId = Number(gateARows[0]?.connection_id);
      const gateBConnectionId = Number(gateBRows[0]?.connection_id);
      if (!Number.isSafeInteger(gateAConnectionId) || gateAConnectionId < 1
        || !Number.isSafeInteger(gateBConnectionId) || gateBConnectionId < 1
        || gateAConnectionId === gateBConnectionId) throw new Error("Owned gate connections are not distinct");
      // Keep the original fixed table/SELECT SQL and real ordinary pending-range boundary.
      // The separate operator gate accounts never grant ordinary access to this test-only table.
      // A remains locked until the actual legacy business Promise settles; B is the native waiter.
      // Removing/moving the bound early pending query still reaches catalog first or misses the latch.
      let gateCreated = false;
      await observer.query(
        `CREATE TABLE backup_catalog_lock_order_test_gate (
           gate_id TINYINT UNSIGNED NOT NULL PRIMARY KEY
         ) ENGINE=InnoDB`,
      );
      await observer.query(
        "INSERT INTO backup_catalog_lock_order_test_gate (gate_id) VALUES (1)",
      );
      gateCreated = true;
      const legacyPendingAcquired = deferred<number>();
      const releaseLegacy = deferred<void>();
      const boundConnection = deferred<number>();
      const boundPendingAttempted = deferred<void>();
      let legacyPaused = false;
      let boundCatalogAcquired = false;
      const restoreLegacyQueries = observeStoreConnectionQueries(f.store, {
        afterQuery: async (sql, connectionId) => {
          if (legacyPaused || !isPendingRestoreRunLockQuery(sql)) return;
          legacyPaused = true;
          await gateA.beginTransaction();
          await gateA.query(
            `SELECT gate_id FROM backup_catalog_lock_order_test_gate
              WHERE gate_id=1 FOR UPDATE`,
          );
          legacyPendingAcquired.resolve(connectionId);
          await releaseLegacy.promise;
        },
      });
      const restoreBoundQueries = observeStoreConnectionQueries(boundStore, {
        onConnection: (connectionId) => boundConnection.resolve(connectionId),
        beforeQuery: async (sql) => {
          if (!isPendingRestoreRunLockQuery(sql)) return;
          boundPendingAttempted.resolve();
          await gateB.beginTransaction();
          await gateB.query(
            `SELECT gate_id FROM backup_catalog_lock_order_test_gate
              WHERE gate_id=1 FOR UPDATE`,
          );
          await gateB.rollback();
        },
        afterQuery: (sql) => {
          if (isBackupCatalogWriteLockQuery(sql)) boundCatalogAcquired = true;
        },
      });
      let legacyPromise: ReturnType<MysqlSessionStore["prepareTenantRestoreReplay"]> | undefined;
      let boundPromise:
        ReturnType<MysqlSessionStore["prepareTenantRestoreReplayFromBackup"]> | undefined;
      let gateReleasePromise: Promise<void> | undefined;
      await withOwnedCleanup(async () => {
        legacyPromise = f.store.prepareTenantRestoreReplay(legacy);
        void legacyPromise.catch(() => {});
        // Release only after this original business operation has actually settled/rolled back.
        gateReleasePromise = legacyPromise.then(() => gateA.rollback(), () => gateA.rollback());
        void gateReleasePromise.catch(() => {});
        const legacyConnectionId = await withTimeout(legacyPendingAcquired.promise, "legacy pending-range lock");

        boundPromise = boundStore.prepareTenantRestoreReplayFromBackup(bound);
        void boundPromise.catch(() => {});
        const boundConnectionId = await withTimeout(
          boundConnection.promise,
          "bound restore connection",
        );
        if (boundConnectionId === gateAConnectionId || boundConnectionId === gateBConnectionId
          || legacyConnectionId === gateAConnectionId || legacyConnectionId === gateBConnectionId
          || boundConnectionId === legacyConnectionId) {
          throw new Error("Ordinary and operator gate connection identities overlap");
        }
        await withTimeout(boundPendingAttempted.promise, "bound pending-range query");
        await waitForMysqlConnectionLockWait(
          observer,
          gateBConnectionId,
          gateAConnectionId,
          "backup_catalog_lock_order_test_gate",
        );
        expect(boundCatalogAcquired).toBe(false);

        releaseLegacy.resolve();
        const results = await withTimeout(
          Promise.allSettled([legacyPromise, boundPromise]),
          "competing restore preparations",
        );
        await gateReleasePromise;
        const legacyResult = results[0];
        const boundResult = results[1];
        expect(legacyResult?.status).toBe("rejected");
        if (legacyResult?.status !== "rejected") {
          throw new Error("legacy restore unexpectedly won");
        }
        expect(legacyResult.reason).toBeInstanceOf(TenantBackupCatalogNotReadyError);
        expect((legacyResult.reason as { code?: string }).code).not.toBe("ER_LOCK_DEADLOCK");
        expect(boundResult?.status).toBe("fulfilled");
        expect(await f.store.getTenantRestoreReplayRun(bound.restoreRunId)).not.toBeNull();
        expect(await f.store.getTenantRestoreReplayRun(legacy.restoreRunId)).toBeNull();
      }, [
        () => releaseLegacy.resolve(),
        async () => {
          if (gateReleasePromise) await gateReleasePromise;
          else await gateA.rollback();
        },
        () => gateA.end(),
        async () => {
          // This is an actual join, never the previous 5s cleanup race interpreted as completion.
          await Promise.allSettled([
            ...(legacyPromise ? [legacyPromise] : []),
            ...(boundPromise ? [boundPromise] : []),
            ...(gateReleasePromise ? [gateReleasePromise] : []),
          ]);
        },
        () => restoreLegacyQueries(),
        () => restoreBoundQueries(),
        () => gateB.rollback(),
        () => gateB.end(),
        async () => { if (gateCreated) await observer.query('DROP TABLE backup_catalog_lock_order_test_gate'); },
        () => observer.end(),
        () => boundStore.close(),
        () => f.store.close(),
      ]);
    }));

    it("keeps a runtime epoch permanently burned after abort and resolution", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal);
      const first = await publishBackup(
        f,
        newTenantBackupId(),
        "epoch-a",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const second = await publishBackup(
        f,
        newTenantBackupId(),
        "epoch-b",
        2,
        first.catalogEventRootSha256,
      );
      const prepared = await f.store.prepareTenantRestoreReplayFromBackup(
        restoreInput(f, first, "permanent-epoch", 3, second.catalogEventRootSha256),
      );
      await expect(f.store.abortTenantRestoreReplay(prepared.value.replayRun.restoreRunId))
        .resolves.toBe(true);
      const resolved = await resolveAbortedReservation(f, prepared);
      if (resolved.value.phase !== "aborted") {
        throw new Error("expected an aborted restore reservation");
      }
      const reused = restoreInput(
        f,
        second,
        "permanent-epoch",
        5,
        resolved.value.resolutionCatalogEventRootSha256,
      );
      await expect(f.store.prepareTenantRestoreReplayFromBackup(reused))
        .rejects.toBeInstanceOf(TenantBackupCatalogConflictError);
      await f.store.close();
    }));

    it("serializes restore reservation against physical eviction", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal, 1, 1_000);
      const first = await publishBackup(
        f,
        newTenantBackupId(),
        "evict-race-a",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const second = await publishBackup(
        f,
        newTenantBackupId(),
        "evict-race-b",
        2,
        first.catalogEventRootSha256,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      const plan = await f.store.prepareTenantBackupEviction({
        evictionId: newTenantBackupEvictionId(),
        backupId: first.backupId,
      });
      const restore = restoreInput(f, first, "eviction-race-epoch", 3,
        second.catalogEventRootSha256);
      const results = await Promise.allSettled([
        f.store.prepareTenantRestoreReplayFromBackup(restore),
        f.store.recordTenantBackupCatalogEviction({ plan, acknowledgement: evictionAck(f, plan) }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const reservation = await f.store.getTenantBackupRuntimeReservation(restore.restoreRunId);
      const eviction = await f.store.getTenantBackupCatalogEviction(first.backupId);
      expect(Number(reservation !== null) + Number(eviction !== null)).toBe(1);
      expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toHaveLength(
        eviction ? 1 : 2,
      );
      await f.store.close();
    }));

    it("projects a mirrored external eviction before exact local record replay", runCase(async () => {
      const f = await fixture(scope().owner, scope().signal, 1, 1);
      const first = await publishBackup(
        f,
        newTenantBackupId(),
        "mirror-first-eviction-a",
        1,
        EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      );
      const second = await publishBackup(
        f,
        newTenantBackupId(),
        "mirror-first-eviction-b",
        2,
        first.catalogEventRootSha256,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const plan = await f.store.prepareTenantBackupEviction({
        evictionId: newTenantBackupEvictionId(),
        backupId: first.backupId,
      });
      const acknowledgement = evictionAck(f, plan);

      await expect(f.store.mirrorTenantBackupCatalogEvent({
        adapterProtocol: f.control.adapterProtocol,
        catalogNamespaceSha256: f.control.catalogNamespaceSha256,
        catalogTargetSha256: f.control.catalogTargetSha256,
        failureDomainSha256: f.control.failureDomainSha256,
        event: { eventType: "backup_evicted", result: acknowledgement },
      })).resolves.toMatchObject({ disposition: "created" });
      const projected = await f.store.getTenantBackupCatalogEviction(first.backupId);
      expect(projected).toMatchObject({
        backupId: first.backupId,
        evictionId: plan.evictionId,
        planSha256: plan.planSha256,
        acknowledgementReceiptSha256: acknowledgement.acknowledgementReceiptSha256,
      });
      await expect(f.store.recordTenantBackupCatalogEviction({ plan, acknowledgement }))
        .resolves.toEqual({ disposition: "exact_replay", value: projected });
      expect(await f.store.listRecoverableTenantBackups({ limit: 10 })).toEqual([second]);

      const raw = await scope().owner.openInspection(scope().signal);
      const [rows] = await raw.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS eviction_count FROM backup_catalog_evictions WHERE backup_id=?",
        [first.backupId],
      );
      expect(Number(rows[0]?.eviction_count)).toBe(1);
      await raw.end();
      await f.store.close();
    }));
  });
} else {
  describe("MysqlSessionStore authoritative backup catalog", () => {
    it.skip("set AGENT_SERVICE_INTEGRATION=1 with a disposable MySQL test database to enable", () => {});
  });
}
