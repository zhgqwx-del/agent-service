import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  PersistedProviderCaptureIntegrityError,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TENANT_TELEMETRY_CAPTURE_LINEAGE_FAMILIES,
  TENANT_RESTORE_FENCE_SCOPE,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  TenantErasureIntegrityError,
  TenantTelemetryCaptureRestoreIntegrityError,
  TenantTelemetryWriteIntegrityError,
  assertMysqlSessionStoreDatabaseBinding,
  createTenantTelemetryCaptureOperationRecoveryPermit,
  newTenantBackupId,
  newErasureRequestId,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupResolutionReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantErasureRequestHash,
  tenantRestoreRuntimeEpochSha256,
  tenantTelemetryCaptureCheckpointOperationIdentity,
  tenantTelemetryCaptureRecoveryJobDescriptorSha256,
  tenantTelemetryWriteClaimTokenSha256,
  tenantRestoreFenceSha256,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  validateTenantRestoreFence,
  validateTenantRestoreJournalRemoteEntry,
  type TenantTelemetryCaptureBackupSourceMaintenance,
  type TenantTelemetryCaptureOperationRecoveryPermit,
  type TenantBackupCatalogEventProof,
} from "../src/index.js";
import { activateCurrentCaptureFixture, captureRefKey, captureCurrentStepFixture as captureStepFixture } from "./persisted-provider-capture.fixture.js";
import { CaptureMysqlEpochRuntimeOwner } from "./fixtures/capture-mysql-epochs.js";
import type { CaptureMysqlInspection as Connection } from "./fixtures/capture-mysql-runtime.js";
import { createMysqlOperationAbortTransport, bindMysqlOperationAbort } from "../src/mysql/operation-abort.js";
import { mkSession } from "./conformance.js";

function admitCapture(step: Awaited<ReturnType<typeof captureStepFixture>>) {
  return { ...step.input, batch: step.lease.admit({ ...step.input.batch }) };
}

const BASE = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function localBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a local disposable test database");
  }
  return url;
}
function databaseUrl(base: URL, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}
function eventProof(sequence: number, previous: string,
  eventType: "backup_recoverable" | "restore_reserved" | "restore_resolved", operationSha256: string,
  receiptSha256: string): TenantBackupCatalogEventProof {
  const catalogEventSha256 = tenantBackupCatalogEventSha256({ eventType, operationSha256, receiptSha256 });
  return { catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    }) };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0058 repeat capture restore: isolated real MySQL source and strict lineage", () => {
    let base: URL;
    type Scope = { signal: AbortSignal; failed: boolean; failure?: { reason: unknown };
      readiness: "ordinary-ready" | "structure-after-intentional-data-corruption";
      owner?: CaptureMysqlEpochRuntimeOwner; work?: Promise<void>; close?: Promise<void>; detach?: () => void;
      nativeFactories: Set<Promise<unknown>>; nativeFacades: Set<{ close(): Promise<void> }> };
    const cases = new Set<Scope>();
    function rememberRejected(scope: Scope, results: readonly PromiseSettledResult<unknown>[]): void {
      for (const result of results) if (result.status === "rejected") {
        scope.failed = true; scope.failure ??= { reason: result.reason };
      }
    }
    function finish(scope: Scope): Promise<void> {
      return scope.close ??= (async () => {
        try {
          // A case-local module facade must retain its actual product brand and original close identity.
          // Own its original native factory Promise and any late fulfilled facade before owner cleanup.
          rememberRejected(scope, await Promise.allSettled([...scope.nativeFactories]));
          rememberRejected(scope, await Promise.allSettled([...scope.nativeFacades].map(value => value.close())));
          await scope.owner?.close({ successful: !scope.failed && !scope.signal.aborted, readiness: scope.readiness });
        } finally { scope.detach?.(); }
      })();
    }
    function runCase(body: (scope: Scope) => Promise<void>) {
      return (context: TestContext): Promise<void> => {
        const scope: Scope = { signal: context.signal, failed: false, readiness: "ordinary-ready",
          nativeFactories: new Set(), nativeFacades: new Set() }; cases.add(scope);
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          try { await finish(scope); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          if (scope.failure) throw scope.failure.reason;
        });
        scope.work = work; return work;
      };
    }
    beforeAll(async () => { base = localBase(BASE); });
    afterAll(async () => {
      await Promise.allSettled([...cases].map(scope => scope.work!));
      const results = await Promise.allSettled([...cases].map(scope => finish(scope)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    });
    async function fixture(scope: Scope) {
      const owner = new CaptureMysqlEpochRuntimeOwner(base.toString()); scope.owner = owner;
      const abort = () => { void owner.close({ successful: false, readiness: scope.readiness }).catch(() => { /* finish joins this exact original close. */ }); };
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.detach = () => scope.signal.removeEventListener("abort", abort);
      scope.signal.throwIfAborted(); await owner.prepare(); await owner.primary();
      const store = await owner.openStore(4, scope.signal), conn = await owner.openInspection(scope.signal);
      const database = owner.database, url = databaseUrl(base, database);
      const [identity] = await conn.query<RowDataPacket[]>("SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName");
      if (identity.length !== 1 || identity[0]?.databaseName !== database || typeof identity[0]?.serverUuid !== "string") {
        throw new Error("Repeat fixture native identity is not proven");
      }
      const nativeIdentity = Object.freeze({ serverUuid: identity[0].serverUuid, database });
      await activateCurrentCaptureFixture(store);
      await store.activateBlobStorageControl({ expectedControlGeneration: 0,
        storageBackend: "s3v1-repeat-local-fixture", namespaceSha256: sha("repeat-blob") });
      const journal = await store.getTenantRestoreJournalControl();
      if (journal.controlGeneration !== 1) throw new Error("fixture journal inactive");
      await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
        adapterProtocol: "mysql-authoritative-backup-catalog-v1",
        catalogNamespaceSha256: sha("repeat-catalog-namespace"),
        catalogTargetSha256: sha("repeat-catalog-target"),
        failureDomainSha256: sha("repeat-catalog-failure-domain"),
        logicalDatabaseNamespaceSha256: "4".repeat(64),
        journalControlEvidenceSha256: journal.evidenceSha256,
        retentionPolicySha256: sha("repeat-catalog-retention"),
        minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 });
      let storeClose: Promise<void> | undefined;
      return { database, url, store, conn, owner, scope, nativeIdentity, close: () => finish(scope),
        closeStore: () => storeClose ??= store.close() };
    }
    async function checkpointAndPrepare(
      store: MysqlSessionStore | TenantTelemetryCaptureBackupSourceMaintenance,
      cursor: { sequence: number; rootSha256: string } = {
        sequence: 0, rootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      },
      // Only reuse a real restricted-source read when this isolated fixture has
      // performed no intervening writes. Every checkpoint mutation still runs
      // its own ordinary store transaction and source/authority revalidation.
      unchangedCatalogControl?: Awaited<ReturnType<MysqlSessionStore["getTenantBackupCatalogControl"]>>,
    ) {
      const control = unchangedCatalogControl ?? await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("fixture catalog inactive");
      const backupId = newTenantBackupId();
      const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId,
        controlEvidenceSha256: control.evidenceSha256 })).value;
      const sealed = await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
      if (!sealed || sealed.disposition !== "created" || sealed.value.checkpoint.families.length !== 49) {
        throw new Error("fixture primary checkpoint missing");
      }
      const descriptor = { backupId, anchorSha256: anchor.anchorSha256,
        sourceSnapshotSha256: sha(`repeat-source-snapshot-${backupId}`),
        sourceBackupSha256: sha(`repeat-source-backup-${backupId}`),
        artifactManifestSha256: sha(`repeat-artifact-${backupId}`),
        providerEvidenceSha256: sha(`repeat-provider-${backupId}`),
        controlEvidenceSha256: anchor.controlEvidenceSha256,
        logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
        retentionPolicySha256: control.retentionPolicySha256,
        retentionUntilDbMs: anchor.retentionUntilDbMs, registeredAtDbMs: anchor.createdAtDbMs,
        catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256 };
      const availabilityOperationSha256 = tenantBackupAvailabilityOperationSha256(descriptor);
      const availabilityReceiptSha256 = tenantBackupAvailabilityReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, descriptor, availabilityOperationSha256);
      const evidence = { adapterProtocol: control.adapterProtocol,
        failureDomainSha256: control.failureDomainSha256, ...descriptor,
        availabilityOperationSha256, availabilityReceiptSha256,
        ...eventProof(cursor.sequence + 1, cursor.rootSha256,
          "backup_recoverable", availabilityOperationSha256, availabilityReceiptSha256) };
      const entry = (await store.recordTenantBackupCatalogAvailability({ ...evidence,
        entrySha256: tenantBackupCatalogEntrySha256({
          scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
          protocol: TENANT_BACKUP_CATALOG_PROTOCOL, ...evidence,
        }),
      })).value;
      const restoreRunId = `restore_${randomUUID()}`;
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`repeat-epoch-${restoreRunId}`);
      const identity = { backupId, restoreRunId, entrySha256: entry.entrySha256, runtimeEpochSha256 };
      const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
      const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, identity, reservationOperationSha256);
      const result = await store.prepareTenantRestoreReplayFromBackup({ backupId, restoreRunId,
        runtimeEpochSha256, controlEvidenceSha256: control.journalControlEvidenceSha256,
        sealedTargets: await store.getTenantRestoreRuntimeHeads(),
        captureCheckpointSha256: sealed.value.checkpoint.checkpointSha256,
        reservation: { adapterProtocol: control.adapterProtocol,
          catalogNamespaceSha256: control.catalogNamespaceSha256,
          catalogTargetSha256: control.catalogTargetSha256, ...identity,
          reservationOperationSha256, reservationReceiptSha256,
          ...eventProof(cursor.sequence + 2, entry.catalogEventRootSha256, "restore_reserved",
            reservationOperationSha256, reservationReceiptSha256) },
      });
      if (result.disposition !== "created") throw new Error("fixture restore prepare was not created");
      return { backupId, restoreRunId, checkpointSha256: sealed.value.checkpoint.checkpointSha256,
        artifactManifestSha256: entry.artifactManifestSha256,
        sourceSnapshotSha256: entry.sourceSnapshotSha256,
        providerEvidenceSha256: entry.providerEvidenceSha256,
        reservationSha256: result.value.reservation.reservationSha256,
        reservationReceiptSha256: result.value.reservation.reservationReceiptSha256,
        fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const };
    }

    async function withoutExactGuard(
      f: Awaited<ReturnType<typeof fixture>>, table: string, guard: string,
      timing: "BEFORE", event: "INSERT" | "UPDATE" | "DELETE",
      action: () => Promise<void>,
    ): Promise<void> {
      const conn = f.conn, database = f.database;
      if (database !== f.owner.database || !/^agent_service_test_capture_epochs_[0-9a-f]{24}$/.test(database)
        || !/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_]+$/.test(guard)) {
        throw new Error("unsafe repeat-restore guard fixture target");
      }
      const [context] = await conn.query<RowDataPacket[]>(
        "SELECT DATABASE() AS activeDb,@@server_uuid AS serverUuid,@@SESSION.sql_mode AS sessionMode");
      if (context.length !== 1 || context[0]!.activeDb !== database
        || context[0]!.serverUuid !== f.nativeIdentity.serverUuid || typeof context[0]!.sessionMode !== "string") {
        throw new Error("repeat-restore guard fixture changed database context");
      }
      const originalMode = String(context[0]!.sessionMode);
      const metadata = async () => {
        const [rows] = await conn.query<RowDataPacket[]>(`SELECT TRIGGER_NAME AS name,
          ACTION_ORDER AS actionOrder,ACTION_STATEMENT AS body,SQL_MODE AS sqlMode,
          DEFINER AS definer FROM information_schema.TRIGGERS
          WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?
            AND ACTION_TIMING=? AND EVENT_MANIPULATION=?
          ORDER BY ACTION_ORDER`, [table, timing, event]);
        return rows.map((row) => ({ name: String(row.name), order: Number(row.actionOrder),
          body: String(row.body), mode: String(row.sqlMode), definer: String(row.definer) }));
      };
      const before = await metadata();
      expect(before.map((row) => row.name)).toEqual([guard]);
      const [definition] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${guard}\``);
      const createSql = definition[0]?.["SQL Original Statement"];
      const triggerMode = definition[0]?.sql_mode;
      if (typeof createSql !== "string" || typeof triggerMode !== "string"
        || !createSql.includes(guard)) {
        throw new Error("repeat-restore guard definition is not exact");
      }
      await conn.query(`DROP TRIGGER \`${guard}\``);
      let actionError: unknown;
      try { await action(); }
      catch (error) { actionError = error; }
      try {
        await conn.query("SET SESSION sql_mode=?", [triggerMode]);
        await conn.query(createSql);
      } finally { await conn.query("SET SESSION sql_mode=?", [originalMode]); }
      expect(await metadata()).toEqual(before);
      if (actionError) throw actionError;
    }

    async function openRestoredSource(
      f: Awaited<ReturnType<typeof fixture>>, configuredFleetRootSha256: string,
    ) {
      const selected = await checkpointAndPrepare(f.store);
      let maintenance = await f.owner.openRestoreRead(selected);
      let cutover: Awaited<ReturnType<typeof maintenance.activateTenantTelemetryCaptureRestoredEpoch>> | null = null;
      let history: Awaited<ReturnType<typeof maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt>> = null;
      try {
        expect(await maintenance.sealTenantRestoreReplay(selected.restoreRunId)).not.toBeNull();
        const primary = await maintenance.getTenantRestoreRuntimeControl();
        if (primary.state !== "active") throw new Error("fixture primary runtime missing");
        const restoredTransition = await f.owner.stageRestore({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        }, selected);
        maintenance = await f.owner.openActivationFacade(restoredTransition);
        const restored = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        });
        if (restored.state !== "active" || restored.lineageKind !== "restore") {
          throw new Error("fixture restored runtime missing");
        }
        await f.owner.confirm(restoredTransition, maintenance);
        cutover = await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: restored.runtimeEpochSha256,
          configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        history = await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt();
        if (!history) throw new Error("fixture actual restore history missing");
        await resolveSelectedReservation(maintenance, selected);
      } finally { await maintenance.close(); }
      if (!cutover || !history) throw new Error("fixture restored authority is missing");
      await f.closeStore();
      const source = await f.owner.openBackupSource();
      try {
        // This real read traverses the old-epoch failure source and its permit
        // chain under the restricted backup-source capability before any test
        // mutates the database. It is not an ordinary capture writer gate.
        const catalogControl = await source.getTenantBackupCatalogControl();
        expect(catalogControl.state).toBe("active");
        return { source, selected, history, cutover, catalogControl };
      } catch (error) {
        await source.close().catch(() => {});
        throw error;
      }
    }

    async function resolveSelectedReservation(
      maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>>,
      selected: Awaited<ReturnType<typeof checkpointAndPrepare>>,
    ): Promise<void> {
      const reservation = await maintenance.getTenantBackupRuntimeReservation(selected.restoreRunId);
      if (!reservation || reservation.reservationReceiptSha256 !== selected.reservationReceiptSha256) {
        throw new Error("fixture actual selected external reservation missing");
      }
      const resolution = { restoreRunId: selected.restoreRunId,
        reservationReceiptSha256: selected.reservationReceiptSha256,
        phase: "activated" as const };
      const resolutionOperationSha256 = tenantBackupReservationResolutionOperationSha256(resolution);
      const resolutionReceiptSha256 = tenantBackupResolutionReceiptSha256(resolution);
      const resolved = await maintenance.resolveTenantBackupRuntimeReservation({ ...resolution,
        resolutionOperationSha256, resolutionReceiptSha256,
        ...eventProof(reservation.catalogSequence + 1, reservation.catalogEventRootSha256,
          "restore_resolved", resolutionOperationSha256, resolutionReceiptSha256),
      });
      expect(resolved.value.phase).toBe("activated");
    }

    async function authorityCounts(conn: Connection) {
      const [rows] = await conn.query<RowDataPacket[]>(`SELECT
        (SELECT COUNT(*) FROM tenant_telemetry_capture_backup_checkpoints) AS checkpoints,
        (SELECT COUNT(*) FROM tenant_telemetry_capture_recovery_permits) AS permitsV1,
        (SELECT COUNT(*) FROM tenant_telemetry_capture_recovery_permits_v2) AS permitsV2,
        (SELECT COUNT(*) FROM backup_catalog_external_events) AS catalogEvents,
        (SELECT COUNT(*) FROM tenant_restore_runtime_events) AS runtimeEvents`);
      expect(rows).toHaveLength(1);
      return Object.fromEntries(Object.entries(rows[0]!).map(([key, value]) => [key, Number(value)]));
    }

    it("binds only the actual still-open restricted MySQL source facade to its database", runCase(async scope => {
      const f = await fixture(scope);
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let bodyFailed = false;
      try {
        await f.closeStore();
        const sourceFactory = MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance({
          url: f.url, tenantTelemetryRefKey: captureRefKey, operationAbortSignal: scope.signal,
          fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1",
        }, { kind: "stopped-fleet-maintenance", fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
        scope.nativeFactories.add(sourceFactory);
        void sourceFactory.then(value => { scope.nativeFacades.add(value); }, () => { /* Original factory rejection remains owned. */ });
        source = await sourceFactory;
        const [identityRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName");
        expect(identityRows).toHaveLength(1);
        const expected = { serverUuid: String(identityRows[0]!.serverUuid), database: f.database };
        const options = { timeoutMs: 5_000 };
        await expect(assertMysqlSessionStoreDatabaseBinding(source, expected, options)).resolves.toBeUndefined();
        await expect(assertMysqlSessionStoreDatabaseBinding(source,
          { ...expected, database: `${f.database}_other` }, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        await expect(assertMysqlSessionStoreDatabaseBinding(Object.freeze({ ...source }), expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        const firstClose = source.close();
        const secondClose = source.close();
        expect(secondClose).toBe(firstClose);
        await Promise.all([firstClose, secondClose]);
        await expect(assertMysqlSessionStoreDatabaseBinding(source, expected, options))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        source = undefined;
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([source?.close() ?? Promise.resolve()]);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("rejects a correctly signed fence for the real active run when no replay entry references it", runCase(async scope => {
      const f = await fixture(scope);
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        const selected = await checkpointAndPrepare(f.store);
        maintenance = await f.owner.openRestoreRead(selected);
        expect(await maintenance.sealTenantRestoreReplay(selected.restoreRunId)).not.toBeNull();
        const primary = await maintenance.getTenantRestoreRuntimeControl();
        if (primary.state !== "active") throw new Error("fixture primary runtime missing");
        const restoredTransition = await f.owner.stageRestore({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        }, selected);
        maintenance = await f.owner.openActivationFacade(restoredTransition);
        const restored = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        });
        if (restored.state !== "active" || restored.lineageKind !== "restore") {
          throw new Error("fixture actual restored runtime missing");
        }
        await f.owner.confirm(restoredTransition, maintenance);
        await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: restored.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        await maintenance.close(); maintenance = undefined;
        await f.closeStore();
        source = await f.owner.openBackupSource();
        expect((await source.getTenantBackupCatalogControl()).state).toBe("active");
        const authorityBefore = await authorityCounts(f.conn);
        const journal = await source.getTenantRestoreJournalControl();
        const targets = await source.getTenantRestoreJournalControlTargets();
        if (journal.controlGeneration !== 1 || targets.length !== 1) {
          throw new Error("fixture actual journal target is missing");
        }
        const [clockRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS db_ms");
        const installedAtDbMs = Number(clockRows[0]?.db_ms);
        expect(Number.isSafeInteger(installedAtDbMs)).toBe(true);
        const basis = { logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256,
          requestId: `erase_${randomUUID()}`, tenantId: step.session.tenantId,
          subjectGeneration: 1, t1FenceSha256: sha("isolated-fence-source") };
        const operationSha256 = tenantRestoreJournalOperationSha256(basis);
        const recordSha256 = tenantRestoreJournalRecordSha256({
          scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE, protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
          ...basis, operationSha256,
        });
        const fenceBody = {
          scope: TENANT_RESTORE_FENCE_SCOPE,
          ...basis, operationSha256, recordSha256,
          restoreRunId: selected.restoreRunId,
          sourceTargetSha256: targets[0]!.targetSha256,
          sourceRemoteSequence: 1,
          sourceHeadRootSha256: sha("isolated-orphan-head"),
          installedAtDbMs,
        };
        const fence = { ...fenceBody, fenceSha256: tenantRestoreFenceSha256(fenceBody) };
        validateTenantRestoreFence(fence);
        await expect(f.conn.query(`INSERT INTO tenant_restore_fences
          (tenant_id,scope,logical_database_namespace_sha256,request_id,subject_generation,
           t1_fence_sha256,operation_sha256,record_sha256,restore_run_id,
           source_target_sha256,source_remote_sequence,source_head_root_sha256,
           installed_at_db_ms,fence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          fence.tenantId, fence.scope, fence.logicalDatabaseNamespaceSha256, fence.requestId,
          fence.subjectGeneration, fence.t1FenceSha256, fence.operationSha256, fence.recordSha256,
          fence.restoreRunId, fence.sourceTargetSha256, fence.sourceRemoteSequence,
          fence.sourceHeadRootSha256, fence.installedAtDbMs, fence.fenceSha256,
        ])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION",
          sqlMessage: "restore fence is not bound to a prepared replay" });
        await withoutExactGuard(f,
          "tenant_restore_fences", "trg_restore_journal_fences_bi", "BEFORE", "INSERT", async () => {
            await f.conn.query(`INSERT INTO tenant_restore_fences
              (tenant_id,scope,logical_database_namespace_sha256,request_id,subject_generation,
               t1_fence_sha256,operation_sha256,record_sha256,restore_run_id,
               source_target_sha256,source_remote_sequence,source_head_root_sha256,
               installed_at_db_ms,fence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
              fence.tenantId, fence.scope, fence.logicalDatabaseNamespaceSha256, fence.requestId,
              fence.subjectGeneration, fence.t1FenceSha256, fence.operationSha256, fence.recordSha256,
              fence.restoreRunId, fence.sourceTargetSha256, fence.sourceRemoteSequence,
              fence.sourceHeadRootSha256, fence.installedAtDbMs, fence.fenceSha256,
            ]);
          });
        const [actualFence] = await f.conn.query<RowDataPacket[]>(`SELECT tenant_id,fence_sha256,restore_run_id
          FROM tenant_restore_fences WHERE BINARY tenant_id=BINARY ?`, [fence.tenantId]);
        expect(actualFence).toHaveLength(1);
        expect(actualFence[0]!.fence_sha256).toBe(fence.fenceSha256);
        expect(actualFence[0]!.restore_run_id).toBe(selected.restoreRunId);
        const [missingEntry] = await f.conn.query<RowDataPacket[]>(`SELECT replay_ordinal
          FROM tenant_restore_replay_entries WHERE BINARY tenant_id=BINARY ?`, [fence.tenantId]);
        expect(missingEntry).toHaveLength(0);
        await expect(source.getTenantBackupCatalogControl())
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        expect(await authorityCounts(f.conn)).toEqual(authorityBefore);
        scope.readiness = "structure-after-intentional-data-corruption";
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), maintenance?.close() ?? Promise.resolve(),
        ]);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("requires an original installed entry even when a signed exact replay references the fence", runCase(async scope => {
      const f = await fixture(scope);
      let auditPool: ReturnType<typeof mysql.createPool> | undefined;
      let auditConn: PoolConnection | undefined;
      let auditTransport: ReturnType<typeof createMysqlOperationAbortTransport> | undefined;
      let auditAbortScope: ReturnType<typeof bindMysqlOperationAbort> | undefined;
      let bodyFailed = false;
      try {
        const tenantId = `repeat-fence-${randomUUID()}`;
        await f.store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
        await f.store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await f.store.createSession(mkSession(tenantId, `repeat-user-${randomUUID()}`));
        const requestId = newErasureRequestId();
        await f.store.requestTenantErasure({ requestId, tenantId,
          requestedByKeyId: "repeat-fence-test", idempotencyKey: `repeat-fence-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
        const claimed = (await f.store.claimTenantRestoreJournalPublications({
          limit: 10, leaseMs: 120_000, claimToken: `repeat-fence-${randomUUID()}`,
        })).find((row) => row.requestId === requestId);
        if (!claimed) throw new Error("fixture real T1 publication claim missing");
        const auth = { requestId: claimed.requestId, tenantId: claimed.tenantId,
          subjectGeneration: claimed.subjectGeneration,
          publicationGeneration: claimed.publicationGeneration,
          claimAttempt: claimed.claimAttempt, claimToken: claimed.claimToken };
        const pending = await f.store.getTenantRestoreJournalPublicationRecord(auth, 0);
        if (!pending) throw new Error("fixture real T1 publication record missing");
        const previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
        const remoteEntry = { targetSha256: pending.target.targetSha256, remoteSequence: 1,
          previousHeadRootSha256,
          headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
            previousHeadRootSha256, targetSha256: pending.target.targetSha256,
            remoteSequence: 1, operationSha256: pending.record.operationSha256,
            recordSha256: pending.record.recordSha256,
          }), record: pending.record };
        // This ACK is a local fixture result, not proof of an external journal.
        expect(await f.store.recordTenantRestoreJournalPublicationTargetAck(auth, {
          adapterProtocol: pending.target.adapterProtocol,
          journalNamespaceSha256: pending.target.journalNamespaceSha256,
          logicalDatabaseNamespaceSha256: pending.target.logicalDatabaseNamespaceSha256,
          ...remoteEntry, replayed: false,
        })).not.toBeNull();
        expect(await f.store.sealTenantRestoreJournalPublication(auth))
          .toMatchObject({ restoreFencePublicationComplete: true });
        const selected = await checkpointAndPrepare(f.store);
        const [clockRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS db_ms");
        const installedAtDbMs = Number(clockRows[0]?.db_ms);
        expect(Number.isSafeInteger(installedAtDbMs)).toBe(true);
        // A privileged, isolated corruption fixture installs the correctly
        // signed fence without its original replay entry. The ordinary replay
        // API can then build a structurally valid exact-replay entry and run.
        const fenceBody = { scope: TENANT_RESTORE_FENCE_SCOPE,
          logicalDatabaseNamespaceSha256: pending.record.logicalDatabaseNamespaceSha256,
          requestId: pending.record.requestId, tenantId: pending.record.tenantId,
          subjectGeneration: pending.record.subjectGeneration,
          t1FenceSha256: pending.record.t1FenceSha256,
          operationSha256: pending.record.operationSha256,
          recordSha256: pending.record.recordSha256,
          restoreRunId: selected.restoreRunId,
          sourceTargetSha256: remoteEntry.targetSha256,
          sourceRemoteSequence: remoteEntry.remoteSequence,
          sourceHeadRootSha256: remoteEntry.headRootSha256, installedAtDbMs };
        const fence = { ...fenceBody, fenceSha256: tenantRestoreFenceSha256(fenceBody) };
        validateTenantRestoreFence(fence);
        const [inserted] = await f.conn.query<mysql.ResultSetHeader>(`INSERT INTO tenant_restore_fences
          (tenant_id,scope,logical_database_namespace_sha256,request_id,subject_generation,
           t1_fence_sha256,operation_sha256,record_sha256,restore_run_id,
           source_target_sha256,source_remote_sequence,source_head_root_sha256,
           installed_at_db_ms,fence_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          fence.tenantId, fence.scope, fence.logicalDatabaseNamespaceSha256, fence.requestId,
          fence.subjectGeneration, fence.t1FenceSha256, fence.operationSha256,
          fence.recordSha256, fence.restoreRunId, fence.sourceTargetSha256,
          fence.sourceRemoteSequence, fence.sourceHeadRootSha256, fence.installedAtDbMs,
          fence.fenceSha256,
        ]);
        expect(inserted.affectedRows).toBe(1);
        const replayed = await f.store.recordTenantRestoreReplayFence({
          restoreRunId: selected.restoreRunId, targetOrdinal: 0, remoteEntry,
        });
        expect(replayed).toMatchObject({ fenceDisposition: "exact_replay",
          fenceSha256: fence.fenceSha256, restoreRunId: selected.restoreRunId });
        expect((await f.store.getTenantRestoreReplayRun(selected.restoreRunId))?.entryCount).toBe(1);
        expect(await f.store.listTenantRestoreReplayEntries(selected.restoreRunId, { limit: 10 }))
          .toEqual([replayed]);
        const [entryRows] = await f.conn.query<RowDataPacket[]>(`SELECT fence_disposition
          FROM tenant_restore_replay_entries WHERE BINARY tenant_id=BINARY ?`, [tenantId]);
        expect(entryRows.map((row) => row.fence_disposition)).toEqual(["exact_replay"]);
        const authorityBefore = await authorityCounts(f.conn);
        auditTransport = createMysqlOperationAbortTransport(scope.signal);
        auditPool = mysql.createPool({ uri: f.url, connectionLimit: 1, stream: auditTransport.stream });
        auditAbortScope = bindMysqlOperationAbort(auditPool, scope.signal, auditTransport);
        auditConn = await auditPool.getConnection();
        const [auditIdentity] = await auditConn.query<RowDataPacket[]>("SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName");
        if (auditIdentity.length !== 1 || auditIdentity[0]?.serverUuid !== f.nativeIdentity.serverUuid
          || auditIdentity[0]?.databaseName !== f.database) throw new Error("Repeat lineage audit native identity is not proven");
        const sourceAudit = f.store as unknown as {
          assertCaptureLineageReplayRelations(conn: PoolConnection): Promise<void>;
        };
        await expect(sourceAudit.assertCaptureLineageReplayRelations(auditConn))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        expect(await authorityCounts(f.conn)).toEqual(authorityBefore);
        scope.readiness = "structure-after-intentional-data-corruption";
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        try { auditConn?.release(); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
        const auditClosed = await Promise.allSettled([(async () => {
          try { if (auditAbortScope) await auditAbortScope.close(); else await auditPool?.end(); }
          finally { auditTransport?.close(); await auditTransport?.settled(); }
        })()]);
        rememberRejected(scope, auditClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...auditClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("rejects a real T1 journal job after its immutable target is lost", runCase(async scope => {
      const f = await fixture(scope);
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        const journalTenantId = `repeat-journal-${randomUUID()}`;
        await f.store.createApiKey(journalTenantId, `key-${journalTenantId}`, `hash-${journalTenantId}`);
        await f.store.setTenantAuth(journalTenantId, DEFAULT_AUTH_POLICY);
        await f.store.createSession(mkSession(journalTenantId, `repeat-user-${randomUUID()}`));
        const requestId = newErasureRequestId();
        await f.store.requestTenantErasure({
          requestId, tenantId: journalTenantId, requestedByKeyId: "repeat-restore-test",
          idempotencyKey: `repeat-journal-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(journalTenantId), atMs: Date.now(),
        });
        const job = await f.store.getTenantRestoreJournalPublicationJob(journalTenantId, requestId);
        if (!job || job.phase !== "queued" || job.targetCount !== 1) {
          throw new Error("fixture real T1 publication job is missing");
        }
        const [originalTargets] = await f.conn.query<RowDataPacket[]>(`SELECT *
          FROM tenant_restore_journal_targets WHERE BINARY request_id=BINARY ?`, [requestId]);
        expect(originalTargets).toHaveLength(1);
        const selected = await checkpointAndPrepare(f.store);
        maintenance = await f.owner.openRestoreRead(selected);
        expect(await maintenance.sealTenantRestoreReplay(selected.restoreRunId)).not.toBeNull();
        const primary = await maintenance.getTenantRestoreRuntimeControl();
        if (primary.state !== "active") throw new Error("fixture primary runtime missing");
        const restoredTransition = await f.owner.stageRestore({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        }, selected);
        maintenance = await f.owner.openActivationFacade(restoredTransition);
        const restored = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        });
        if (restored.state !== "active" || restored.lineageKind !== "restore") {
          throw new Error("fixture restored runtime missing");
        }
        await f.owner.confirm(restoredTransition, maintenance);
        await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: restored.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        await maintenance.close(); maintenance = undefined;
        await f.closeStore();
        source = await f.owner.openBackupSource();
        expect((await source.getTenantBackupCatalogControl()).state).toBe("active");
        const authorityBefore = await authorityCounts(f.conn);
        await expect(f.conn.query(`DELETE FROM tenant_restore_journal_targets
          WHERE BINARY request_id=BINARY ?`, [requestId])).rejects.toMatchObject({
          code: "ER_SIGNAL_EXCEPTION", sqlMessage: "restore journal target is append-only",
        });
        await withoutExactGuard(f, "tenant_restore_journal_targets",
          "trg_restore_journal_targets_bd", "BEFORE", "DELETE", async () => {
            const [deleted] = await f.conn.query<mysql.ResultSetHeader>(`DELETE FROM tenant_restore_journal_targets
              WHERE BINARY request_id=BINARY ?`, [requestId]);
            expect(deleted.affectedRows).toBe(1);
          });
        const [afterJob] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM tenant_restore_journal_jobs
          WHERE BINARY request_id=BINARY ?`, [requestId]);
        const [afterTargets] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM tenant_restore_journal_targets
          WHERE BINARY request_id=BINARY ?`, [requestId]);
        expect(afterJob).toHaveLength(1);
        expect(afterJob[0]!.target_count).toBe(job.targetCount);
        expect(afterTargets).toHaveLength(0);
        await expect(source.getTenantBackupCatalogControl())
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await authorityCounts(f.conn)).toEqual(authorityBefore);
        scope.readiness = "structure-after-intentional-data-corruption";
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), maintenance?.close() ?? Promise.resolve(),
        ]);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("rejects a source-valid runtime known entry that no immutable runtime event consumes", runCase(async scope => {
      const f = await fixture(scope);
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        // Real T1 is admitted on the original primary BEFORE CP1/restore.
        // Restoring this legal queued publication preserves its actual source;
        // it does not grant a restored epoch new 0054 destructive eligibility.
        const tenantId = `repeat-known-${randomUUID()}`;
        await f.store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
        await f.store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        const requestId = newErasureRequestId();
        await f.store.requestTenantErasure({ requestId, tenantId,
          requestedByKeyId: "repeat-runtime-source", idempotencyKey: `known-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
        });
        const job = await f.store.getTenantRestoreJournalPublicationJob(tenantId, requestId);
        if (!job || job.phase !== "queued" || job.targetCount !== 1) {
          throw new Error("fixture real primary journal source is missing");
        }
        ({ source } = await openRestoredSource(f, step.proof.configuredFleetRootSha256));
        expect((await source.getTenantBackupCatalogControl()).state).toBe("active");
        const authorityBefore = await authorityCounts(f.conn);
        const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT
          r.runtime_epoch_sha256,r.control_generation,r.updated_at_db_ms,
          h.target_ordinal,h.target_sha256,h.remote_sequence,h.head_root_sha256,
          t.logical_database_namespace_sha256,t.request_id,t.tenant_id,
          t.subject_generation,t.t1_fence_sha256,t.operation_sha256,t.record_sha256,
          CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS db_ms
          FROM tenant_restore_runtime_control r
          JOIN tenant_restore_runtime_heads h ON h.singleton_id=r.singleton_id
          JOIN tenant_restore_journal_targets t
            ON t.target_ordinal=h.target_ordinal AND BINARY t.target_sha256=BINARY h.target_sha256
          WHERE r.singleton_id=1 AND r.state='active' AND r.lineage_kind='restore'
            AND BINARY t.request_id=BINARY ?`, [requestId]);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        const known = {
          singletonId: 1, runtimeEpochSha256: String(row.runtime_epoch_sha256),
          targetOrdinal: Number(row.target_ordinal), targetSha256: String(row.target_sha256),
          remoteSequence: Number(row.remote_sequence) + 1,
          previousHeadRootSha256: String(row.head_root_sha256),
          headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
            previousHeadRootSha256: String(row.head_root_sha256),
            targetSha256: String(row.target_sha256), remoteSequence: Number(row.remote_sequence) + 1,
            operationSha256: String(row.operation_sha256), recordSha256: String(row.record_sha256),
          }),
          recordScope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
          recordProtocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
          logicalDatabaseNamespaceSha256: String(row.logical_database_namespace_sha256),
          requestId: String(row.request_id), tenantId: String(row.tenant_id),
          subjectGeneration: Number(row.subject_generation),
          t1FenceSha256: String(row.t1_fence_sha256),
          operationSha256: String(row.operation_sha256), recordSha256: String(row.record_sha256),
          controlGeneration: Number(row.control_generation) + 1,
          recordedAtDbMs: Math.max(Number(row.updated_at_db_ms), Number(row.db_ms)),
        };
        expect(known.subjectGeneration).toBe(1);
        validateTenantRestoreJournalRemoteEntry({
          targetSha256: known.targetSha256, remoteSequence: known.remoteSequence,
          previousHeadRootSha256: known.previousHeadRootSha256, headRootSha256: known.headRootSha256,
          record: { scope: known.recordScope, protocol: known.recordProtocol,
            logicalDatabaseNamespaceSha256: known.logicalDatabaseNamespaceSha256,
            requestId: known.requestId, tenantId: known.tenantId,
            subjectGeneration: known.subjectGeneration, t1FenceSha256: known.t1FenceSha256,
            operationSha256: known.operationSha256, recordSha256: known.recordSha256,
          },
        });
        const [beforeEvents] = await f.conn.query<RowDataPacket[]>(
          "SELECT control_generation FROM tenant_restore_runtime_events");
        const [inserted] = await f.conn.query<mysql.ResultSetHeader>(`INSERT INTO tenant_restore_runtime_known_entries
          (singleton_id,runtime_epoch_sha256,target_ordinal,target_sha256,remote_sequence,
           previous_head_root_sha256,head_root_sha256,record_scope,record_protocol,
           logical_database_namespace_sha256,request_id,tenant_id,subject_generation,
           t1_fence_sha256,operation_sha256,record_sha256,control_generation,recorded_at_db_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          known.singletonId, known.runtimeEpochSha256, known.targetOrdinal, known.targetSha256,
          known.remoteSequence, known.previousHeadRootSha256, known.headRootSha256,
          known.recordScope, known.recordProtocol, known.logicalDatabaseNamespaceSha256,
          known.requestId, known.tenantId, known.subjectGeneration, known.t1FenceSha256,
          known.operationSha256, known.recordSha256, known.controlGeneration, known.recordedAtDbMs,
        ]);
        expect(inserted.affectedRows).toBe(1);
        const [afterEvents] = await f.conn.query<RowDataPacket[]>(
          "SELECT control_generation FROM tenant_restore_runtime_events");
        expect(afterEvents).toEqual(beforeEvents);
        const [actualKnown] = await f.conn.query<RowDataPacket[]>(`SELECT request_id,record_sha256,
          control_generation FROM tenant_restore_runtime_known_entries
          WHERE BINARY request_id=BINARY ?`, [known.requestId]);
        expect(actualKnown).toHaveLength(1);
        expect(actualKnown[0]!.record_sha256).toBe(known.recordSha256);
        expect(Number(actualKnown[0]!.control_generation)).toBe(known.controlGeneration);
        await expect(source.getTenantBackupCatalogControl())
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        expect(await authorityCounts(f.conn)).toEqual(authorityBefore);
        scope.readiness = "structure-after-intentional-data-corruption";
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(),
        ]);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("rejects a fully re-signed recovery permit whose tenant reference disagrees with the actual member", runCase(async scope => {
      let diagnosticStartedAt: number | undefined;
      let diagnosticElapsedMs: number | null = null;
      try { const now = performance.now(); if (Number.isFinite(now)) diagnosticStartedAt = now; }
      catch { /* Best-effort diagnostic only. */ }
      type DiagnosticPhase = "fixture-start" | "fixture-ready" | "capture-start" | "capture-committed"
        | "restore-start" | "restore-ready" | "writer-start" | "writer-ready"
        | "claim-start" | "claim-ready" | "writer-close-start" | "writer-closed"
        | "source-baseline-start" | "source-baseline-ready" | "permit-read-start" | "permit-read-ready"
        | "permit-forge-start" | "permit-forge-ready" | "guard-rejection-start" | "guard-rejection-verified"
        | "tamper-start" | "tamper-guard-restored" | "stored-permit-read-start" | "stored-permit-verified"
        | "source-rejection-start" | "source-rejection-verified" | "authority-after-start" | "authority-after-verified"
        | "body-verified" | "body-failed" | "cleanup-native-start" | "cleanup-native-settled"
        | "cleanup-fixture-start" | "cleanup-fixture-settled" | "cleanup-scope-exit";
      const mark = (phase: DiagnosticPhase): void => {
        try {
          const now = performance.now();
          const elapsed = diagnosticStartedAt === undefined ? NaN : Math.floor(now - diagnosticStartedAt);
          if (Number.isSafeInteger(elapsed) && elapsed >= 0) {
            diagnosticElapsedMs = Math.max(diagnosticElapsedMs ?? 0, elapsed);
          }
          console.info(JSON.stringify({ schema: "repeat-tenant-permit-phase-v1", phase, elapsedMs: diagnosticElapsedMs }));
        } catch { /* Clock, serialization and logger failure cannot alter the original outcome. */ }
      };
      mark("fixture-start");
      const f = await fixture(scope);
      mark("fixture-ready");
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let writer: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        mark("capture-start");
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        mark("capture-committed");
        mark("restore-start");
        const restored = await openRestoredSource(f, step.proof.configuredFleetRootSha256);
        mark("restore-ready");
        source = restored.source;
        mark("writer-start");
        writer = await f.owner.openStore(2, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: false });
        mark("writer-ready");
        mark("claim-start");
        const proof = await writer.getTenantTelemetryPersistedProviderCaptureBinding();
        if (!proof) throw new Error("fixture recovered producer proof missing");
        const claim = (await writer.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
          claimToken: `repeat-claim-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
          captureMode: "include_v2", freshProof: proof,
        })).find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256);
        if (!claim?.captureRecovery) throw new Error("fixture actual P1 recovery claim missing");
        mark("claim-ready");
        mark("writer-close-start");
        await writer.close(); writer = undefined;
        mark("writer-closed");
        mark("source-baseline-start");
        expect((await source.getTenantBackupCatalogControl()).state).toBe("active");
        const authorityBefore = await authorityCounts(f.conn);
        mark("source-baseline-ready");
        mark("permit-read-start");
        const cp1 = await f.conn.readCaptureCheckpoint(restored.selected.backupId, captureRefKey);
        if (!cp1 || cp1.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v1") {
          throw new Error("fixture actual CP1 not found");
        }
        const [permitRows] = await f.conn.query<RowDataPacket[]>(`SELECT *
          FROM tenant_telemetry_capture_recovery_permits
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        expect(permitRows).toHaveLength(1);
        const rawReceipt: unknown = permitRows[0]!.receipt_json;
        const original = (typeof rawReceipt === "string" ? JSON.parse(rawReceipt) : rawReceipt) as TenantTelemetryCaptureOperationRecoveryPermit;
        expect(original.receiptSha256).toBe(claim.captureRecovery.permitReceiptSha256);
        mark("permit-read-ready");
        const { scope: _scope, protocol: _protocol, phase: _phase, sourceKind: _sourceKind,
          newReservationAuthorized: _reservation, newExternalCreateAuthorized: _external,
          executionReady: _execution, externalAuthorityVerified: _authority,
          erasureAuthorized: _erasure, allDomainsComplete: _domains,
          contentPurgeExecuted: _purge, receiptSha256: _receipt, ...originalInput } = original;
        mark("permit-forge-start");
        const forgedTenantRef = sha(`foreign-member-ref-${randomUUID()}`);
        expect(forgedTenantRef).not.toBe(original.tenantRefSha256);
        const forged = createTenantTelemetryCaptureOperationRecoveryPermit({
          ...originalInput, tenantRefSha256: forgedTenantRef,
        }, restored.cutover, restored.history, cp1.checkpoint, cp1.leaves, captureRefKey);
        expect(forged.receiptSha256).not.toBe(original.receiptSha256);
        mark("permit-forge-ready");
        mark("guard-rejection-start");
        await expect(f.conn.query(`UPDATE tenant_telemetry_capture_recovery_permits
          SET permit_receipt_sha256=?,receipt_json=?
          WHERE BINARY write_operation_sha256=BINARY ? AND new_claim_attempt=?`, [
          forged.receiptSha256, JSON.stringify(forged), claim.writeOperationSha256, claim.claimAttempt,
        ])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION",
          sqlMessage: "capture recovery permit is immutable" });
        mark("guard-rejection-verified");
        mark("tamper-start");
        await withoutExactGuard(f, "tenant_telemetry_capture_recovery_permits",
          "trg_tt_capture_recovery_permit_bu", "BEFORE", "UPDATE", async () => {
            const [updated] = await f.conn.query<mysql.ResultSetHeader>(`UPDATE tenant_telemetry_capture_recovery_permits
              SET permit_receipt_sha256=?,receipt_json=?
              WHERE BINARY write_operation_sha256=BINARY ? AND new_claim_attempt=?`, [
              forged.receiptSha256, JSON.stringify(forged), claim.writeOperationSha256, claim.claimAttempt,
            ]);
            expect(updated.affectedRows).toBe(1);
          });
        mark("tamper-guard-restored");
        mark("stored-permit-read-start");
        const [resigned] = await f.conn.query<RowDataPacket[]>(`SELECT permit_receipt_sha256,receipt_json
          FROM tenant_telemetry_capture_recovery_permits
          WHERE BINARY write_operation_sha256=BINARY ?`, [claim.writeOperationSha256]);
        expect(resigned).toHaveLength(1);
        expect(resigned[0]!.permit_receipt_sha256).toBe(forged.receiptSha256);
        const storedReceipt = typeof resigned[0]!.receipt_json === "string"
          ? JSON.parse(String(resigned[0]!.receipt_json)) : resigned[0]!.receipt_json;
        expect(storedReceipt).toEqual(forged);
        const [stillClaimed] = await f.conn.query<RowDataPacket[]>(`SELECT attempts,claim_token,phase
          FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`,
        [claim.writeOperationSha256]);
        expect(stillClaimed).toHaveLength(1);
        expect(Number(stillClaimed[0]!.attempts)).toBe(claim.claimAttempt);
        expect(stillClaimed[0]!.claim_token).toBe(claim.claimToken);
        expect(stillClaimed[0]!.phase).toBe("queued");
        mark("stored-permit-verified");
        mark("source-rejection-start");
        await expect(source.getTenantBackupCatalogControl())
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        mark("source-rejection-verified");
        mark("authority-after-start");
        expect(await authorityCounts(f.conn)).toEqual(authorityBefore);
        mark("authority-after-verified");
        scope.readiness = "structure-after-intentional-data-corruption";
        mark("body-verified");
      } catch (error) { mark("body-failed"); bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        mark("cleanup-native-start");
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), writer?.close() ?? Promise.resolve(),
        ]);
        mark("cleanup-native-settled");
        rememberRejected(scope, nativeClosed);
        mark("cleanup-fixture-start");
        const fixtureClosed = await Promise.allSettled([f.close()]);
        mark("cleanup-fixture-settled");
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
        mark("cleanup-scope-exit");
      }
    }), 60_000);

    it("seals a real 27-family CP2 without rewriting CP1 or its captured physical sources", runCase(async scope => {
      const f = await fixture(scope);
      let source: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureBackupSourceMaintenance>> | undefined;
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        expect(committed.replayed).toBe(false);
        const selected = await checkpointAndPrepare(f.store);
        const [original] = await f.conn.query<RowDataPacket[]>(`SELECT checkpoint_sha256,checkpoint_json
          FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?`, [selected.backupId]);
        expect(original).toHaveLength(1);
        maintenance = await f.owner.openRestoreRead(selected);
        expect(await maintenance.sealTenantRestoreReplay(selected.restoreRunId)).not.toBeNull();
        const before = await maintenance.getTenantRestoreRuntimeControl();
        if (before.state !== "active") throw new Error("fixture primary runtime missing");
        const activatedTransition = await f.owner.stageRestore({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: before.controlGeneration,
        }, selected);
        maintenance = await f.owner.openActivationFacade(activatedTransition);
        const activated = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: before.controlGeneration,
        });
        if (activated.state !== "active" || activated.lineageKind !== "restore") {
          throw new Error("fixture restored runtime missing");
        }
        await f.owner.confirm(activatedTransition, maintenance);
        const cutover = await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: activated.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        expect(cutover.checkpointSha256).toBe(selected.checkpointSha256);
        await resolveSelectedReservation(maintenance, selected);
        await maintenance.close(); maintenance = undefined;
        await f.closeStore();
        source = await f.owner.openBackupSource();
        const catalog = await source.getTenantBackupCatalogControl();
        if (catalog.state !== "active") throw new Error("fixture catalog not active after restore");
        const backup2 = newTenantBackupId();
        await source.createTenantBackupSnapshotAnchor({ backupId: backup2,
          controlEvidenceSha256: catalog.evidenceSha256 });
        const sealed = await source.sealTenantTelemetryCaptureBackupCheckpoint({ backupId: backup2,
          fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
        if (!sealed || sealed.disposition !== "created") throw new Error("CP2 was not created");
        expect(sealed.value.checkpoint.scope).toBe("tenant-telemetry-capture-backup-checkpoint-v2");
        if (sealed.value.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v2") {
          throw new Error("CP2 scope changed");
        }
        expect(sealed.value.checkpoint.lineage.families.map((family) => family.family))
          .toEqual([...TENANT_TELEMETRY_CAPTURE_LINEAGE_FAMILIES]);
        expect(sealed.value.lineageLeaves).toBeDefined();
        expect(sealed.value.checkpoint.lineage.sourceRestoreRunId).toBe(selected.restoreRunId);
        expect(sealed.value.checkpoint.lineage.sourceCaptureCutoverReceiptSha256).toBe(cutover.receiptSha256);
        const independentlyRead = await f.conn.readCaptureCheckpoint(backup2, captureRefKey);
        expect(independentlyRead).toEqual(sealed.value);
        const replay = await source.sealTenantTelemetryCaptureBackupCheckpoint({ backupId: backup2,
          fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
        expect(replay).toMatchObject({ disposition: "exact_replay" });
        const [unchanged] = await f.conn.query<RowDataPacket[]>(`SELECT checkpoint_sha256,checkpoint_json
          FROM tenant_telemetry_capture_backup_checkpoints WHERE BINARY backup_id=BINARY ?`, [selected.backupId]);
        expect(unchanged).toEqual(original);
        const [lineageRows] = await f.conn.query<RowDataPacket[]>(`SELECT family,identity_ref_sha256
          FROM tenant_telemetry_capture_checkpoint_lineage_leaves WHERE BINARY backup_id=BINARY ?`, [backup2]);
        expect(lineageRows).toHaveLength(sealed.value.lineageLeaves?.length ?? -1);
        const [v2Permits] = await f.conn.query<RowDataPacket[]>(
          "SELECT permit_receipt_sha256 FROM tenant_telemetry_capture_recovery_permits_v2");
        expect(v2Permits).toHaveLength(0);
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), maintenance?.close() ?? Promise.resolve(),
        ]);
        // The exact owned database is removed only after every independent
        // source/operator pool has actually settled its close operation.
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 60_000);

    it("rejects a fully signed R1 v1 permit after R2 becomes the actual runtime", runCase(async scope => {
      const f = await fixture(scope);
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let firstMaintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let secondMaintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let bodyFailed = false;
      try {
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        const operation = committed.failureCommitReceipt.writeOperationSha256;
        const job = await f.store.getTenantTelemetryWriteJob(step.session.tenantId, operation);
        const member = await f.store.getTenantTelemetryArtifactMembership(step.session.tenantId, operation);
        const binding = await f.store.getTenantTelemetryPersistedProviderCaptureSourceBinding(step.session.tenantId, operation);
        if (!job || !member || !binding || job.phase !== "queued" || job.attempts !== 0 || job.reservation) {
          throw new Error("fixture original unclaimed v2 job is missing");
        }
        const first = await checkpointAndPrepare(f.store);
        const cp1 = await f.conn.readCaptureCheckpoint(first.backupId, captureRefKey);
        if (!cp1 || cp1.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v1") {
          throw new Error("fixture actual CP1 is missing");
        }
        firstMaintenance = await f.owner.openRestoreRead(first);
        expect(await firstMaintenance.sealTenantRestoreReplay(first.restoreRunId)).not.toBeNull();
        const beforeFirst = await firstMaintenance.getTenantRestoreRuntimeControl();
        if (beforeFirst.state !== "active") throw new Error("fixture original runtime missing");
        const firstRuntimeTransition = await f.owner.stageRestore({
          restoreRunId: first.restoreRunId, expectedControlGeneration: beforeFirst.controlGeneration,
        }, first);
        firstMaintenance = await f.owner.openActivationFacade(firstRuntimeTransition);
        const firstRuntime = await firstMaintenance.activateTenantRestoreRuntime({
          restoreRunId: first.restoreRunId, expectedControlGeneration: beforeFirst.controlGeneration,
        });
        if (firstRuntime.state !== "active" || firstRuntime.lineageKind !== "restore") {
          throw new Error("fixture R1 runtime missing");
        }
        await f.owner.confirm(firstRuntimeTransition, firstMaintenance);
        const cutover1 = await firstMaintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: firstRuntime.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        const history1 = await firstMaintenance.getTenantTelemetryCaptureRestoreHistoryReceipt();
        if (!history1) throw new Error("fixture R1 history missing");
        await resolveSelectedReservation(firstMaintenance, first);
        await firstMaintenance.close(); firstMaintenance = undefined;
        await f.closeStore();

        source = await f.owner.openBackupSource();
        const [cursorRows] = await f.conn.query<RowDataPacket[]>(`SELECT catalog_sequence,catalog_event_root_sha256
          FROM backup_catalog_external_events ORDER BY catalog_sequence DESC LIMIT 1`);
        expect(cursorRows).toHaveLength(1);
        expect(Number(cursorRows[0]!.catalog_sequence)).toBe(3);
        const second = await checkpointAndPrepare(source, {
          sequence: Number(cursorRows[0]!.catalog_sequence),
          rootSha256: String(cursorRows[0]!.catalog_event_root_sha256),
        });
        const cp2 = await f.conn.readCaptureCheckpoint(second.backupId, captureRefKey);
        expect(cp2?.checkpoint.scope).toBe("tenant-telemetry-capture-backup-checkpoint-v2");
        await source.close(); source = undefined;
        secondMaintenance = await f.owner.openRestoreRead(second);
        expect(await secondMaintenance.sealTenantRestoreReplay(second.restoreRunId)).not.toBeNull();
        const beforeSecond = await secondMaintenance.getTenantRestoreRuntimeControl();
        if (beforeSecond.state !== "active" || beforeSecond.restoreRunId !== first.restoreRunId) {
          throw new Error("fixture R1 was not current before second activation");
        }
        const secondRuntimeTransition = await f.owner.stageRestore({
          restoreRunId: second.restoreRunId, expectedControlGeneration: beforeSecond.controlGeneration,
        }, second);
        secondMaintenance = await f.owner.openActivationFacade(secondRuntimeTransition);
        const secondRuntime = await secondMaintenance.activateTenantRestoreRuntime({
          restoreRunId: second.restoreRunId, expectedControlGeneration: beforeSecond.controlGeneration,
        });
        if (secondRuntime.state !== "active" || secondRuntime.lineageKind !== "restore") {
          throw new Error("fixture R2 runtime missing");
        }
        await f.owner.confirm(secondRuntimeTransition, secondMaintenance);
        const cutover2 = await secondMaintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: secondRuntime.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        expect(cutover2.restoreRunId).toBe(second.restoreRunId);
        expect(cutover2.receiptSha256).not.toBe(cutover1.receiptSha256);
        await resolveSelectedReservation(secondMaintenance, second);

        const originalLeaf = (family: "write_job" | "write_payload" | "membership"
          | "provider_source_binding" | "provider_failure_commit") => {
          const identity = tenantTelemetryCaptureCheckpointOperationIdentity(family, operation, captureRefKey);
          const rows = cp1.leaves.filter((leaf) => leaf.family === family && leaf.identityRefSha256 === identity);
          expect(rows, `one genuine CP1 ${family} leaf`).toHaveLength(1);
          expect(rows[0]!.knowledge).toBe("validated_projection");
          return rows[0]!.recordHmacSha256;
        };
        const [clockRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS db_ms");
        const issuedAtDbMs = Number(clockRows[0]?.db_ms);
        expect(Number.isSafeInteger(issuedAtDbMs)).toBe(true);
        const oldPermit = createTenantTelemetryCaptureOperationRecoveryPermit({
          cutoverReceiptSha256: cutover1.receiptSha256,
          historyReceiptSha256: history1.receiptSha256,
          checkpointSha256: cp1.checkpoint.checkpointSha256,
          restoreRunId: first.restoreRunId,
          runtimeEpochSha256: cutover1.runtimeEpochSha256,
          writeOperationSha256: operation,
          tenantRefSha256: member.tenantRefSha256,
          ownerRefSha256: member.ownerRefSha256,
          sourceSessionRefSha256: committed.failureCommitReceipt.sourceSessionRefSha256,
          sourceTurnRefSha256: committed.failureCommitReceipt.sourceTurnRefSha256,
          sourceItemRefSha256: committed.failureCommitReceipt.sourceItemRefSha256,
          sourceStepIndex: committed.failureCommitReceipt.sourceStepIndex,
          inventorySha256: job.inventory.inventorySha256,
          payloadSha256: job.inventory.payloadSha256,
          manifestSha256: job.inventory.manifestSha256,
          membershipSha256: member.membershipSha256,
          sourceBindingReceiptSha256: binding.receiptSha256,
          failureCommitReceiptSha256: committed.failureCommitReceipt.receiptSha256,
          originalJobState: "queued", originalJobEvidenceHmacSha256: originalLeaf("write_job"),
          originalJobDescriptorSha256: tenantTelemetryCaptureRecoveryJobDescriptorSha256(job),
          originalPayloadEvidenceHmacSha256: originalLeaf("write_payload"),
          originalMembershipEvidenceHmacSha256: originalLeaf("membership"),
          originalSourceBindingEvidenceHmacSha256: originalLeaf("provider_source_binding"),
          originalFailureEvidenceHmacSha256: originalLeaf("provider_failure_commit"),
          originalReservationReceiptSha256: null, originalReservationEvidenceHmacSha256: null,
          originalReservationClaimAttempt: null, originalReservationClaimTokenSha256: null,
          previousClaimAttempt: 0, previousClaimTokenSha256: null, previousClaimLeaseUntilMs: null,
          newClaimAttempt: 1,
          newClaimTokenSha256: tenantTelemetryWriteClaimTokenSha256(`old-r1-${randomUUID()}`),
          newClaimLeaseUntilMs: issuedAtDbMs + 120_000,
          claimLeaseCeilingMs: issuedAtDbMs + 300_000,
          previousPermitReceiptSha256: null,
          reservationAtIssue: { origin: "none" },
          issuedAtDbMs, recoveryMode: "resume_queued",
        }, cutover1, history1, cp1.checkpoint, cp1.leaves, captureRefKey);
        const [oldContext] = await f.conn.query<RowDataPacket[]>(`SELECT
          (SELECT COUNT(*) FROM tenant_telemetry_capture_epoch_cutovers c
            JOIN tenant_telemetry_capture_backup_checkpoints h ON BINARY h.checkpoint_sha256=BINARY c.checkpoint_sha256
            WHERE BINARY c.restore_run_id=BINARY ? AND BINARY c.cutover_receipt_sha256=BINARY ?
              AND BINARY h.checkpoint_sha256=BINARY ?) AS old_cutover_count,
          (SELECT COUNT(*) FROM tenant_restore_runtime_control r WHERE r.singleton_id=1
            AND r.state='active' AND r.lineage_kind='restore' AND BINARY r.restore_run_id=BINARY ?) AS current_r2_count`,
        [first.restoreRunId, cutover1.receiptSha256, first.checkpointSha256, second.restoreRunId]);
        expect(Number(oldContext[0]?.old_cutover_count)).toBe(1);
        expect(Number(oldContext[0]?.current_r2_count)).toBe(1);
        const [beforeJob] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM tenant_telemetry_write_jobs
          WHERE BINARY write_operation_sha256=BINARY ?`, [operation]);
        expect(beforeJob).toHaveLength(1);
        expect(beforeJob[0]!.phase).toBe("queued");
        expect(Number(beforeJob[0]!.attempts)).toBe(0);
        await expect(f.conn.query(`INSERT INTO tenant_telemetry_capture_recovery_permits
          (write_operation_sha256,new_claim_attempt,restore_run_id,cutover_receipt_sha256,
           checkpoint_sha256,previous_permit_receipt_sha256,predecessor_key_sha256,
           previous_claim_attempt,new_claim_token_sha256,new_claim_lease_until_ms,
           claim_lease_ceiling_ms,issued_at_db_ms,permit_receipt_sha256,receipt_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          oldPermit.writeOperationSha256, oldPermit.newClaimAttempt, oldPermit.restoreRunId,
          oldPermit.cutoverReceiptSha256, oldPermit.checkpointSha256,
          oldPermit.previousPermitReceiptSha256, "0".repeat(64),
          oldPermit.previousClaimAttempt, oldPermit.newClaimTokenSha256,
          oldPermit.newClaimLeaseUntilMs, oldPermit.claimLeaseCeilingMs,
          oldPermit.issuedAtDbMs, oldPermit.receiptSha256, JSON.stringify(oldPermit),
        ])).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION",
          sqlMessage: "capture v1 recovery permit cannot cross repeat restore" });
        const [afterJob] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM tenant_telemetry_write_jobs
          WHERE BINARY write_operation_sha256=BINARY ?`, [operation]);
        expect(afterJob).toEqual(beforeJob);
        const [v1Rows] = await f.conn.query<RowDataPacket[]>(
          "SELECT permit_receipt_sha256 FROM tenant_telemetry_capture_recovery_permits");
        const [v2Rows] = await f.conn.query<RowDataPacket[]>(
          "SELECT permit_receipt_sha256 FROM tenant_telemetry_capture_recovery_permits_v2");
        expect(v1Rows).toHaveLength(0);
        expect(v2Rows).toHaveLength(0);
      } catch (error) { bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), firstMaintenance?.close() ?? Promise.resolve(),
          secondMaintenance?.close() ?? Promise.resolve(),
        ]);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
    }), 45_000);

    it("rolls back a CP2 permit and job CAS when the live lease expires before commit", runCase(async scope => {
      const diagnosticStartedAt = performance.now();
      let diagnosticElapsedMs = 0;
      type DiagnosticPhase = "fixture-start" | "fixture-ready" | "capture-start" | "capture-committed"
        | "r1-start" | "r1-ready" | "cp2-start" | "cp2-ready" | "r2-open-start" | "r2-opened"
        | "r2-ready" | "writer-start" | "writer-ready" | "snapshot-before-start" | "snapshot-before-ready"
        | "probe-ready" | "claim-start" | "claim-settled" | "commit-rejection-verified"
        | "snapshot-after-start" | "snapshot-after-verified" | "body-failed" | "cleanup-start"
        | "cleanup-probes-settled" | "cleanup-native-settled" | "cleanup-fixture-settled" | "cleanup-scope-exit";
      const mark = (phase: DiagnosticPhase) => {
        // Fixed test-only metadata: never report a target, SQL, native error, key or source body.
        diagnosticElapsedMs = Math.max(diagnosticElapsedMs, Math.floor(performance.now() - diagnosticStartedAt));
        try { console.info(JSON.stringify({ schema: "cp2-live-lease-rollback-phase-v1", phase, elapsedMs: diagnosticElapsedMs })); }
        catch { /* Diagnostics cannot change the original fixture or assertion outcome. */ }
      };
      mark("fixture-start");
      const f = await fixture(scope);
      mark("fixture-ready");
      let source: TenantTelemetryCaptureBackupSourceMaintenance | undefined;
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let writer: MysqlSessionStore | undefined;
      let bodyFailed = false;
      const probe = "fixture_repeat_late_claim_probe";
      const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
      const permitTrigger = `fixture_repeat_permit_sleep_${nonce}`;
      const jobTrigger = `fixture_repeat_job_cas_${nonce}`;
      let probeCreated = false;
      let permitTriggerCreated = false;
      let jobTriggerCreated = false;
      try {
        mark("capture-start");
        const step = await captureStepFixture(f.store);
        const committed = await f.store.commitPersistedProviderStepFailure(admitCapture(step));
        mark("capture-committed");
        mark("r1-start");
        const first = await openRestoredSource(f, step.proof.configuredFleetRootSha256);
        source = first.source;
        // Reuse openRestoredSource's actual restricted-source read for CP2:
        // only the catalog cursor SELECT below intervenes, never a writer.
        mark("r1-ready");
        mark("cp2-start");
        const [cursorRows] = await f.conn.query<RowDataPacket[]>(`SELECT catalog_sequence,catalog_event_root_sha256
          FROM backup_catalog_external_events ORDER BY catalog_sequence DESC LIMIT 1`);
        expect(cursorRows).toHaveLength(1);
        const second = await checkpointAndPrepare(source, {
          sequence: Number(cursorRows[0]!.catalog_sequence),
          rootSha256: String(cursorRows[0]!.catalog_event_root_sha256),
        }, first.catalogControl);
        const cp2 = await f.conn.readCaptureCheckpoint(second.backupId, captureRefKey);
        expect(cp2?.checkpoint.scope).toBe("tenant-telemetry-capture-backup-checkpoint-v2");
        mark("cp2-ready");
        mark("r2-open-start");
        await source.close(); source = undefined;
        maintenance = await f.owner.openRestoreRead(second);
        mark("r2-opened");
        expect(await maintenance.sealTenantRestoreReplay(second.restoreRunId)).not.toBeNull();
        const before = await maintenance.getTenantRestoreRuntimeControl();
        if (before.state !== "active" || before.restoreRunId !== first.selected.restoreRunId) {
          throw new Error("fixture R1 not active before repeat restore");
        }
        const secondRuntimeTransition = await f.owner.stageRestore({
          restoreRunId: second.restoreRunId, expectedControlGeneration: before.controlGeneration,
        }, second);
        maintenance = await f.owner.openActivationFacade(secondRuntimeTransition);
        const secondRuntime = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: second.restoreRunId, expectedControlGeneration: before.controlGeneration,
        });
        if (secondRuntime.state !== "active" || secondRuntime.lineageKind !== "restore") {
          throw new Error("fixture R2 runtime missing");
        }
        await f.owner.confirm(secondRuntimeTransition, maintenance);
        await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: secondRuntime.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        await resolveSelectedReservation(maintenance, second);
        await maintenance.close(); maintenance = undefined;
        mark("r2-ready");
        mark("writer-start");
        writer = await f.owner.openStore(2, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: false });
        const proof = await writer.getTenantTelemetryPersistedProviderCaptureBinding();
        if (!proof || proof.runtimeEpochSha256 !== secondRuntime.runtimeEpochSha256) {
          throw new Error("fixture R2 producer proof missing");
        }
        mark("writer-ready");
        const operation = committed.failureCommitReceipt.writeOperationSha256;
        const [candidate] = await f.conn.query<RowDataPacket[]>(`SELECT phase,attempts,claim_token
          FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`, [operation]);
        expect(candidate).toHaveLength(1);
        expect(candidate[0]!.phase).toBe("queued");
        expect(Number(candidate[0]!.attempts)).toBe(0);
        expect(candidate[0]!.claim_token).toBeNull();
        const tables = ["tenant_telemetry_write_jobs", "tenant_telemetry_capture_recovery_permits",
          "tenant_telemetry_capture_recovery_permits_v2", "tenant_telemetry_write_payloads",
          "tenant_telemetry_write_acks", "tenant_telemetry_artifact_inventory"] as const;
        const snapshot = async () => {
          const result: Record<string, RowDataPacket[]> = {};
          for (const table of tables) {
            const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT * FROM ${table}`);
            result[table] = rows;
          }
          return result;
        };
        mark("snapshot-before-start");
        const original = await snapshot();
        mark("snapshot-before-ready");
        await f.conn.query(`CREATE TABLE \`${probe}\` (phase VARCHAR(24) NOT NULL PRIMARY KEY,
          lease_until_ms BIGINT UNSIGNED NOT NULL, observed_db_ms BIGINT UNSIGNED NOT NULL)
          ENGINE=MEMORY`); probeCreated = true;
        await f.conn.query(`CREATE TRIGGER \`${permitTrigger}\` AFTER INSERT
          ON tenant_telemetry_capture_recovery_permits_v2 FOR EACH ROW BEGIN
          INSERT INTO \`${probe}\` (phase,lease_until_ms,observed_db_ms)
            VALUES ('permit_inserted',NEW.new_claim_lease_until_ms,
              CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED));
          DO SLEEP(GREATEST(0,(CAST(NEW.new_claim_lease_until_ms AS SIGNED)
            - CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS SIGNED))/1000)+0.05);
        END`); permitTriggerCreated = true;
        await f.conn.query(`CREATE TRIGGER \`${jobTrigger}\` AFTER UPDATE
          ON tenant_telemetry_write_jobs FOR EACH ROW BEGIN
          IF NEW.attempts=OLD.attempts+1
            AND BINARY NEW.write_operation_sha256=BINARY '${operation}' THEN
            INSERT INTO \`${probe}\` (phase,lease_until_ms,observed_db_ms)
              VALUES ('job_cas',NEW.lease_until_ms,
                CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED));
          END IF;
        END`); jobTriggerCreated = true;
        mark("probe-ready");
        let outcome: { state: "fulfilled" } | { state: "rejected"; error: unknown };
        mark("claim-start");
        try {
          await writer.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 1_000,
            claimToken: `repeat-late-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1",
            captureMode: "include_v2", freshProof: proof,
          });
          outcome = { state: "fulfilled" };
        } catch (error) { outcome = { state: "rejected", error }; }
        mark("claim-settled");
        const [marks] = await f.conn.query<RowDataPacket[]>(
          `SELECT phase,lease_until_ms,observed_db_ms FROM \`${probe}\` ORDER BY phase`);
        expect(marks.map((row) => row.phase)).toEqual(["job_cas", "permit_inserted"]);
        // This AFTER UPDATE is a later SQL statement than the permit INSERT. Its
        // real DB timestamp proves the unchanged 1s lease expired after both real
        // mutations were reached; no fixed multi-second delay or injected clock.
        const casMark = marks[0]!;
        expect(Number(casMark.lease_until_ms)).toBeGreaterThan(0);
        expect(Number(casMark.lease_until_ms)).toBe(Number(marks[1]!.lease_until_ms));
        expect(Number(casMark.observed_db_ms)).toBeGreaterThanOrEqual(Number(casMark.lease_until_ms));
        expect(outcome.state).toBe("rejected");
        if (outcome.state === "rejected") {
          expect(outcome.error).toMatchObject({ name: "TenantTelemetryCaptureRestoreIntegrityError" });
        }
        mark("commit-rejection-verified");
        await f.conn.query(`DROP TRIGGER \`${jobTrigger}\``); jobTriggerCreated = false;
        await f.conn.query(`DROP TRIGGER \`${permitTrigger}\``); permitTriggerCreated = false;
        await f.conn.query(`DROP TABLE \`${probe}\``); probeCreated = false;
        mark("snapshot-after-start");
        expect(await snapshot()).toEqual(original);
        mark("snapshot-after-verified");
      } catch (error) { mark("body-failed"); bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        mark("cleanup-start");
        const cleanup = await Promise.allSettled([
          ...(jobTriggerCreated ? [f.conn.query(`DROP TRIGGER \`${jobTrigger}\``)] : []),
          ...(permitTriggerCreated ? [f.conn.query(`DROP TRIGGER \`${permitTrigger}\``)] : []),
        ]);
        if (probeCreated) cleanup.push(...await Promise.allSettled([
          f.conn.query(`DROP TABLE \`${probe}\``),
        ]));
        mark("cleanup-probes-settled");
        const nativeClosed = await Promise.allSettled([
          source?.close() ?? Promise.resolve(), maintenance?.close() ?? Promise.resolve(),
          writer?.close() ?? Promise.resolve(),
        ]);
        mark("cleanup-native-settled");
        rememberRejected(scope, cleanup);
        rememberRejected(scope, nativeClosed);
        const fixtureClosed = await Promise.allSettled([f.close()]);
        mark("cleanup-fixture-settled");
        if (!bodyFailed) {
          const failure = [...cleanup, ...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
        mark("cleanup-scope-exit");
      }
    }), 60_000);
    it("records restored-epoch T1 only after capture cutover as blocked-source without destructive eligibility", runCase(async scope => {
      let diagnosticStartedAt: number | undefined;
      try { const now = performance.now(); if (Number.isFinite(now)) diagnosticStartedAt = now; } catch { /* Best-effort diagnostic only. */ }
      type DiagnosticPhase = "fixture-start" | "fixture-ready" | "seed-start" | "seed-committed"
        | "writer-cold-start" | "writer-cold-ready" | "checkpoint-prepare-start" | "checkpoint-prepare-ready"
        | "t1-footprint-start" | "t1-footprint-ready" | "t1-rejection-start" | "t1-rejected" | "t1-rollback-verified"
        | "maintenance-start" | "maintenance-ready" | "replay-seal-start" | "replay-sealed"
        | "restore-stage-start" | "restore-stage-ready" | "activation-start" | "activation-confirmed"
        | "precutover-start" | "precutover-rejected" | "capture-cutover-start" | "capture-cutover-ready"
        | "reservation-resolve-start" | "reservation-resolved" | "writer-refresh-close-start" | "writer-refresh-open-start" | "writer-refresh-ready"
        | "actual-t1-start" | "actual-t1-gated" | "cohort-verified" | "final-footprint-start" | "final-footprint-verified"
        | "body-failed" | "cleanup-start" | "cleanup-native-settled" | "cleanup-fixture-start" | "cleanup-fixture-settled" | "cleanup-scope-exit";
      const mark = (phase: DiagnosticPhase): void => {
        try {
          const now = performance.now();
          const elapsed = diagnosticStartedAt === undefined ? NaN : Math.floor(now - diagnosticStartedAt);
          const elapsedMs = Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null;
          console.info(JSON.stringify({ schema: "repeat-restored-t1-phase-v1", phase, elapsedMs }));
        } catch { /* Clock, serialization and logger failure cannot alter the original outcome. */ }
      };
      mark("fixture-start");
      const f = await fixture(scope);
      mark("fixture-ready");
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      let writer: MysqlSessionStore | undefined;
      let bodyFailed = false;
      try {
        mark("seed-start");
        const tenantId = `repeat-restored-t1-${randomUUID()}`;
        await f.store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
        await f.store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        const step = await captureStepFixture(f.store, { tenantId });
        expect((await f.store.commitPersistedProviderStepFailure(admitCapture(step))).replayed).toBe(false);
        mark("seed-committed");
        // This is the ordinary writer capability, not the stopped-fleet operator.
        mark("writer-cold-start");
        writer = await f.owner.openStore(2, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: false });
        mark("writer-cold-ready");
        mark("checkpoint-prepare-start");
        const selected = await checkpointAndPrepare(f.store);
        mark("checkpoint-prepare-ready");
        const requestId = newErasureRequestId();
        const input = { requestId, tenantId, requestedByKeyId: "repeat-restored-t1-test",
          idempotencyKey: `repeat-restored-t1-${randomUUID()}`,
          requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() };
        const t1Tables = [
          "tenant_erasure_admissions", "tenant_credential_revocation_fences", "erasure_audit_events",
          "tenant_credential_revocation_jobs", "tenant_telemetry_lifecycle_subjects",
          "tenant_restore_journal_jobs", "tenant_restore_journal_targets", "tenant_restore_journal_receipts",
          "tenant_telemetry_retained_source_t1_entries", "tenant_telemetry_retained_source_t1_receipts",
          "tenant_telemetry_retained_source_catalog_sources", "tenant_telemetry_retained_source_catalog_targets",
          "tenant_telemetry_retained_source_catalog_receipts", "tenant_telemetry_retained_source_usage_entries",
          "tenant_telemetry_retained_source_usage_receipts", "tenant_telemetry_retained_source_canonical_entries",
          "tenant_telemetry_retained_source_canonical_receipts", "tenant_purge_plan_jobs",
          "tenant_purge_plan_receipts", "tenant_purge_execution_jobs", "tenant_database_purge_jobs",
        ] as const;
        const requestFootprint = async () => {
          const counts = await Promise.all(t1Tables.map(async (table) => {
            const [rows] = await f.conn.query<RowDataPacket[]>(
              `SELECT COUNT(*) AS n FROM \`${table}\` WHERE BINARY request_id=BINARY ?`, [requestId]);
            expect(rows).toHaveLength(1);
            return { table, count: Number(rows[0]!.n) };
          }));
          const [lifecycle] = await f.conn.query<RowDataPacket[]>(`SELECT tenant_id,subject_kind,subject_id,
            state,generation,active_request_id,created_at_ms,updated_at_ms FROM subject_lifecycle
            WHERE BINARY tenant_id=BINARY ? AND subject_kind='tenant' AND BINARY subject_id=BINARY ?`,
          [tenantId, tenantId]);
          expect(lifecycle).toHaveLength(1);
          return { counts, lifecycle };
        };
        mark("t1-footprint-start");
        const before = await requestFootprint();
        expect(before.counts.every((row) => row.count === 0)).toBe(true);
        expect(before.lifecycle[0]).toMatchObject({ state: "active", active_request_id: null });
        mark("t1-footprint-ready");
        mark("t1-rejection-start");
        await expect(writer.requestTenantErasure(input))
          .rejects.toBeInstanceOf(PersistedProviderCaptureIntegrityError);
        mark("t1-rejected");
        expect(await requestFootprint()).toEqual(before);
        mark("t1-rollback-verified");

        mark("maintenance-start");
        maintenance = await f.owner.openRestoreRead(selected);
        mark("maintenance-ready");
        mark("replay-seal-start");
        expect(await maintenance.sealTenantRestoreReplay(selected.restoreRunId)).not.toBeNull();
        mark("replay-sealed");
        const primary = await maintenance.getTenantRestoreRuntimeControl();
        if (primary.state !== "active") throw new Error("fixture primary runtime missing");
        mark("restore-stage-start");
        const restoredTransition = await f.owner.stageRestore({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        }, selected);
        mark("restore-stage-ready");
        mark("activation-start");
        maintenance = await f.owner.openActivationFacade(restoredTransition);
        const restored = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selected.restoreRunId, expectedControlGeneration: primary.controlGeneration,
        });
        expect(restored).toMatchObject({ state: "active", lineageKind: "restore",
          restoreRunId: selected.restoreRunId });
        if (restored.state !== "active" || restored.lineageKind !== "restore") {
          throw new Error("fixture restored runtime missing");
        }
        await f.owner.confirm(restoredTransition, maintenance);
        mark("activation-confirmed");
        // stageRestore joined and retired this old ordinary writer; it cannot survive R1.
        // Runtime history alone still grants no ordinary capability: a fresh CURRENT restricted startup
        // (persisted=true, restore=false) must reject before any T1 mutation with the exact startup class.
        mark("precutover-start");
        await expect(f.owner.openStore(2, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: false })).rejects.toBeInstanceOf(TenantTelemetryWriteIntegrityError);
        expect(await requestFootprint()).toEqual(before);
        mark("precutover-rejected");
        mark("capture-cutover-start");
        const cutover = await maintenance.activateTenantTelemetryCaptureRestoredEpoch({
          expectedRuntimeEpochSha256: restored.runtimeEpochSha256,
          configuredFleetRootSha256: step.proof.configuredFleetRootSha256,
          legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1",
        });
        mark("capture-cutover-ready");
        mark("reservation-resolve-start");
        await resolveSelectedReservation(maintenance, selected);
        mark("reservation-resolved");
        mark("writer-refresh-close-start");
        await maintenance.close(); maintenance = undefined;
        await writer.close(); writer = undefined;
        await f.closeStore();
        // Cold normal startup must consume the actual cutover, without the
        // restore-local-only flag or a caller-supplied maintenance selector.
        mark("writer-refresh-open-start");
        writer = await f.owner.openStore(2, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: false });
        expect(await writer.getTenantTelemetryPersistedProviderCaptureBinding()).toMatchObject({
          runtimeEpochSha256: restored.runtimeEpochSha256,
          captureControlEvidenceSha256: cutover.receiptSha256,
        });
        mark("writer-refresh-ready");
        mark("actual-t1-start");
        const admission = await writer.requestTenantErasure({ ...input, atMs: Date.now() });
        expect(admission).toMatchObject({ requestId, tenantId, status: "gated" });
        mark("actual-t1-gated");
        const cohort = await writer.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, requestId);
        if (!cohort) throw new Error("fixture restored T1 cohort missing");
        expect(cohort.profile).toMatchObject({ kind: "blocked-source",
          runtimeEpochSha256: restored.runtimeEpochSha256,
          reasons: expect.arrayContaining(["runtime_not_primary"]) });
        expect(cohort).toMatchObject({ requestId, tenantId, eligibility: "blocked_source",
          executionReady: false, externalAuthorityVerified: false,
          allDomainsComplete: false, contentPurgeExecuted: false });
        mark("cohort-verified");
        expect(await writer.materializeTenantPurgePlanJobs({ limit: 1 })).toBe(0);
        mark("final-footprint-start");
        const after = await requestFootprint();
        expect(after.counts.find((row) => row.table === "tenant_erasure_admissions")?.count).toBe(1);
        expect(after.counts.find((row) => row.table === "tenant_telemetry_retained_source_t1_entries")?.count).toBe(1);
        expect(after.counts.find((row) => row.table === "tenant_telemetry_retained_source_t1_receipts")?.count).toBe(1);
        expect(after.counts.filter((row) => row.table.startsWith("tenant_purge_")
          || row.table === "tenant_database_purge_jobs"
          || row.table.startsWith("tenant_telemetry_retained_source_catalog_")
          || row.table.startsWith("tenant_telemetry_retained_source_usage_")
          || row.table.startsWith("tenant_telemetry_retained_source_canonical_"))
          .every((row) => row.count === 0)).toBe(true);
        expect(after.lifecycle[0]).toMatchObject({ state: "deleting", active_request_id: requestId });
        mark("final-footprint-verified");
      } catch (error) { mark("body-failed"); bodyFailed = true; scope.failed = true; scope.failure ??= { reason: error }; throw error; }
      finally {
        mark("cleanup-start");
        const nativeClosed = await Promise.allSettled([
          maintenance?.close() ?? Promise.resolve(), writer?.close() ?? Promise.resolve(),
        ]);
        mark("cleanup-native-settled");
        rememberRejected(scope, nativeClosed);
        mark("cleanup-fixture-start");
        const fixtureClosed = await Promise.allSettled([f.close()]);
        mark("cleanup-fixture-settled");
        if (!bodyFailed) {
          const failure = [...nativeClosed, ...fixtureClosed]
            .find((value) => value.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
        mark("cleanup-scope-exit");
      }
    }), 45_000);
  });
} else {
  describe.skip("0058 repeat capture restore requires AGENT_SERVICE_INTEGRATION", () => {
    it("uses only new isolated local MySQL test databases", () => {});
  });
}
