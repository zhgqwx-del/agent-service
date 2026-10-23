import { createHash, randomUUID } from "node:crypto";
import mysql, { type PoolConnection, type RowDataPacket } from "mysql2/promise";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Turn,
} from "@agent-service/protocol";
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantTelemetryCaptureRestoreIntegrityError,
  TenantTelemetryWriteIntegrityError,
  newTenantBackupId,
  newErasureRequestId,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupRuntimeReservationOperationSha256,
  tenantRestoreRuntimeEpochSha256,
  tenantErasureRequestHash,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  tenantTelemetryWriteAdapterResult,
  type TenantBackupCatalogEntry,
  type TenantBackupCatalogEventProof,
  type TenantBackupRuntimeReservationAdapterResult,
  type TenantRestoreJournalRemoteEntry,
  type TenantTelemetryCaptureRestoreMaintenanceSelector,
} from "../src/index.js";
import { activateCurrentCaptureFixture, captureRefKey, captureCurrentStepFixture as captureStepFixture } from "./persisted-provider-capture.fixture.js";

import { CaptureMysqlEpochRuntimeOwner, type CaptureMysqlEpochTransition } from "./fixtures/capture-mysql-epochs.js";
import type { CaptureMysqlInspection } from "./fixtures/capture-mysql-runtime.js";

function admitCapture(step: Awaited<ReturnType<typeof captureStepFixture>>) {
  return { ...step.input, batch: step.lease.admit({ ...step.input.batch }) };
}
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL ?? "mysql://root@127.0.0.1:3306/agent_service_test";
function disposableBase(raw: string): URL {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error("MYSQL_TEST_URL must name a local disposable test database");
  }
  return url;
}
function eventProof(sequence: number, previous: string,
  eventType: "backup_recoverable" | "restore_reserved", operationSha256: string,
  receiptSha256: string): TenantBackupCatalogEventProof {
  const catalogEventSha256 = tenantBackupCatalogEventSha256({ eventType, operationSha256, receiptSha256 });
  return { catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      catalogSequence: sequence, previousCatalogEventRootSha256: previous, catalogEventSha256,
    }) };
}

type RetainedSourcePhase = "fresh" | "live" | "usage_released" | "canonical_closed";
function retainedPolicy() {
  return { sessionContentRetentionMs: 0, userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0, idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: null, lifecycleAuditRetentionMs: null,
    exportArtifactTtlMs: 60_000 };
}

function localFleetProof(source: {
  requestId: string; tenantId: string; subjectGeneration: number; t3aReceiptSha256: string;
}) {
  const body = { targetSha256: tenantRuntimeTargetSha256("http://restore-maintenance-fixture.internal:8080"),
    runnerId: "restore-maintenance-fixture-runner", bootId: "restore-maintenance-fixture-boot",
    requestId: source.requestId, tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration, t3aReceiptSha256: source.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now() };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return { fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets), targets };
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("0056 capture restore maintenance: isolated real MySQL", () => {
    let base: URL;
    type Phase = "bootstrap" | "primary" | "open_store" | "capture_activation" | "catalog_activation" | "business" | "body_finally" | "fixture_close";
    type Scope = { phase: Phase; caseLabel: string; startedAt: number; signal: AbortSignal; failed: boolean; failure?: { reason: unknown }; readiness: "prepared" | "history-only";
      expectedUnapplied?: CaptureMysqlEpochTransition; owner?: CaptureMysqlEpochRuntimeOwner;
      work?: Promise<void>; close?: Promise<void>; detach?: () => void };
    const cases = new Set<Scope>();
    let caseOrdinal = 0;
    function finish(scope: Scope): Promise<void> {
      return scope.close ??= (async () => {
        scope.phase = "fixture_close";
        try { await scope.owner?.close({ successful: !scope.failed && !scope.signal.aborted,
          readiness: scope.readiness, ...(scope.expectedUnapplied ? { expectedUnapplied: scope.expectedUnapplied } : {}) }); }
        finally { scope.detach?.(); }
      })();
    }
    function runCase(body: (scope: Scope) => Promise<void>) {
      const caseLabel = "0056-case-" + (++caseOrdinal);
      return (context: TestContext): Promise<void> => {
        const scope: Scope = { phase: "bootstrap", caseLabel, startedAt: performance.now(),
          signal: context.signal, failed: false, readiness: "prepared" }; cases.add(scope);
        let abortReported = false;
        const reportAbort = () => {
          if (abortReported) return; abortReported = true;
          try { console.warn(JSON.stringify({ schema: "capture-mysql-case-abort-phase-v1",
            caseLabel: scope.caseLabel, phase: scope.phase, elapsedMs: Math.max(0, Math.round(performance.now() - scope.startedAt)) })); }
          catch { /* Diagnostics cannot replace the original case or cleanup failure. */ }
        };
        scope.signal.addEventListener("abort", reportAbort, { once: true });
        if (scope.signal.aborted) reportAbort();
        const work = Promise.resolve().then(async () => {
          try { scope.signal.throwIfAborted(); await body(scope); scope.signal.throwIfAborted(); }
          catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          scope.phase = "body_finally";
          try { await finish(scope); } catch (reason) { scope.failed = true; scope.failure ??= { reason }; }
          scope.signal.removeEventListener("abort", reportAbort);
          if (scope.failure) throw scope.failure.reason;
        });
        scope.work = work; return work;
      };
    }
    beforeAll(async () => { base = disposableBase(BASE_MYSQL_URL); });
    afterAll(async () => {
      const bodyResults = await Promise.allSettled([...cases].map(scope => scope.work!));
      const closed = await Promise.allSettled([...cases].map(scope => finish(scope)));
      const failure = closed.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      // Original body errors remain attached to their case; this hook only joins their actual work.
      void bodyResults;
    });

    async function fixture(scope: Scope) {
      const owner = new CaptureMysqlEpochRuntimeOwner(base.toString()); scope.owner = owner;
      const abort = () => { void owner.close({ successful: false, readiness: "prepared" }).catch(() => { /* finish joins this same original close. */ }); };
      scope.signal.addEventListener("abort", abort, { once: true });
      scope.detach = () => scope.signal.removeEventListener("abort", abort);
      scope.signal.throwIfAborted();
      await owner.prepare(); scope.phase = "primary"; await owner.primary();
      const name = owner.database;
      scope.phase = "open_store";
      const store = await owner.openStore(4, scope.signal);
      const conn = await owner.openInspection(scope.signal);
      scope.phase = "capture_activation";
      await activateCurrentCaptureFixture(store);
      await store.activateBlobStorageControl({ expectedControlGeneration: 0,
        storageBackend: "s3v1-restore-maintenance-fixture",
        namespaceSha256: h("restore-maintenance-blob") });
      scope.phase = "catalog_activation";
      const journal = await store.getTenantRestoreJournalControl();
      if (journal.controlGeneration !== 1) throw new Error("fixture journal inactive");
      await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
        adapterProtocol: "mysql-authoritative-backup-catalog-v1",
        catalogNamespaceSha256: h("restore-maintenance-catalog-namespace"),
        catalogTargetSha256: h("restore-maintenance-catalog-target"),
        failureDomainSha256: h("restore-maintenance-catalog-failure-domain"),
        logicalDatabaseNamespaceSha256: "4".repeat(64),
        journalControlEvidenceSha256: journal.evidenceSha256,
        retentionPolicySha256: h("restore-maintenance-catalog-retention"),
        minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 });
      scope.phase = "business";
      return { name, store, conn, owner, close: () => finish(scope) };
    }

    type ActualMaintenanceStore = {
      verifyMigrations(dir?: string, skipTelemetryRuntimeAudit?: boolean): Promise<void>;
      withConsistentRead<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T>;
      assertCaptureRecoveryGlobalRelations(connection: PoolConnection, auditOnly: boolean,
        startupPristineDormantRestore: boolean): Promise<void>;
    };
    async function captureActualMaintenanceStore<T>(f: Awaited<ReturnType<typeof fixture>>, open: () => Promise<T>) {
      const prototype = MysqlSessionStore.prototype as unknown as Pick<ActualMaintenanceStore, "verifyMigrations">;
      const original = prototype.verifyMigrations;
      let receiver: ActualMaintenanceStore | undefined;
      const spy = vi.spyOn(prototype, "verifyMigrations").mockImplementation(function(this: ActualMaintenanceStore, ...args) {
        if (receiver && receiver !== this) throw new Error("Unexpected second maintenance Store factory receiver");
        receiver = this; return Reflect.apply(original, this, args);
      });
      try {
        const facade = await open();
        if (!receiver) throw new Error("Actual maintenance Store factory receiver was not observed");
        const actual = receiver;
        const [expected] = await f.conn.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
        await actual.withConsistentRead(async conn => {
          const [rows] = await conn.query<RowDataPacket[]>("SELECT @@server_uuid AS uuid,DATABASE() AS db");
          if (rows.length !== 1 || expected.length !== 1 || rows[0]?.uuid !== expected[0]?.uuid
            || rows[0]?.db !== f.name || expected[0]?.db !== f.name) throw new Error("Actual maintenance Store physical binding mismatch");
        });
        return { facade, actual };
      } finally { spy.mockRestore(); }
    }

    async function available(store: MysqlSessionStore): Promise<{ entry: TenantBackupCatalogEntry;
      checkpointSha256: string }> {
      const control = await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("fixture catalog inactive");
      const backupId = newTenantBackupId();
      const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId,
        controlEvidenceSha256: control.evidenceSha256 })).value;
      const sealed = await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" });
      if (!sealed || sealed.disposition !== "created" || sealed.value.checkpoint.families.length !== 49) {
        throw new Error("fixture checkpoint not sealed");
      }
      const descriptor = { backupId, anchorSha256: anchor.anchorSha256,
        sourceSnapshotSha256: h(`restore-maintenance-source-snapshot-${backupId}`),
        sourceBackupSha256: h(`restore-maintenance-source-backup-${backupId}`),
        artifactManifestSha256: h(`restore-maintenance-artifact-${backupId}`),
        providerEvidenceSha256: h(`restore-maintenance-provider-${backupId}`),
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
        ...eventProof(1, EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
          "backup_recoverable", availabilityOperationSha256, availabilityReceiptSha256) };
      const entry = (await store.recordTenantBackupCatalogAvailability({ ...evidence,
        entrySha256: tenantBackupCatalogEntrySha256({
          scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
          protocol: TENANT_BACKUP_CATALOG_PROTOCOL, ...evidence,
        }),
      })).value;
      return { entry, checkpointSha256: sealed.value.checkpoint.checkpointSha256 };
    }

    async function advanceRetainedSource(
      store: MysqlSessionStore,
      conn: CaptureMysqlInspection,
      step: Awaited<ReturnType<typeof captureStepFixture>>,
      phase: Exclude<RetainedSourcePhase, "fresh">,
    ): Promise<{ targetOrdinal: number; remoteEntry: TenantRestoreJournalRemoteEntry }> {
      // The capture is a real business commit. The following ACK is a
      // deliberately local, in-process adapter result, never S3 evidence.
      const write = (await store.claimTenantTelemetryWriteJobs({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-write-${randomUUID()}`,
        adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: step.proof,
      })).find((row) => row.tenantId === step.session.tenantId);
      if (!write) throw new Error("genuine captured write claim missing");
      const writeAuth = { tenantId: write.tenantId, writeOperationSha256: write.writeOperationSha256,
        claimAttempt: write.claimAttempt, claimToken: write.claimToken };
      expect(await store.reserveTenantTelemetryExternalMutation(
        writeAuth, "telemetry-s3-object-v1", step.proof,
      )).not.toBeNull();
      const writeResult = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
        writeOperationSha256: write.writeOperationSha256, target: write.target,
        inventory: write.inventory, payload: write.payload,
      }, "already_present", true);
      expect(await store.completeTenantTelemetryWrite(writeAuth, writeResult, step.proof)).not.toBeNull();
      const turn: Turn = { ...step.turn, usage: step.batch.turn!.usage, status: "failed",
        completedAtMs: Date.now(), stopReason: "error" };
      expect((await store.commit(step.lease.admit({ sessionId: step.session.id, fence: step.lease.fence, expectedLastSeq: 4,
        turn, events: [
          { type: "error", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
            code: "provider_error", message: "Provider request failed." },
          { type: "turn/completed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
            turn, stopReason: "error" },
          { type: "session/status/changed", sessionId: step.session.id, emittedAtMs: turn.completedAtMs!,
            status: { type: "idle" } },
        ], sessionPatch: { status: { type: "idle" } },
      }))).lastSeq).toBe(7);
      const request = { requestId: newErasureRequestId(), tenantId: step.session.tenantId,
        requestedByKeyId: "maintenance-local-admin", idempotencyKey: `maintenance-${randomUUID()}`,
        requestHash: tenantErasureRequestHash(step.session.tenantId), atMs: Date.now() };
      await store.requestTenantErasure(request);
      expect(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(
        request.tenantId, request.requestId,
      )).toMatchObject({ eligibility: "eligible_retained", entryCount: 1, writtenAckCount: 1 });
      const publication = (await store.claimTenantRestoreJournalPublications({
        limit: 10, leaseMs: 120_000, claimToken: `maintenance-publication-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!publication) throw new Error("genuine T1 publication claim missing");
      const publicationAuth = { requestId: publication.requestId, tenantId: publication.tenantId,
        subjectGeneration: publication.subjectGeneration,
        publicationGeneration: publication.publicationGeneration,
        claimAttempt: publication.claimAttempt, claimToken: publication.claimToken };
      const pending = await store.getTenantRestoreJournalPublicationRecord(publicationAuth, 0);
      if (!pending) throw new Error("genuine T1 publication record missing");
      const previousHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
      const remoteEntry: TenantRestoreJournalRemoteEntry = {
        targetSha256: pending.target.targetSha256,
        remoteSequence: 1,
        previousHeadRootSha256,
        headRootSha256: tenantRestoreJournalNextRemoteHeadRootSha256({
          previousHeadRootSha256, targetSha256: pending.target.targetSha256,
          remoteSequence: 1, operationSha256: pending.record.operationSha256,
          recordSha256: pending.record.recordSha256,
        }), record: pending.record,
      };
      expect(await store.recordTenantRestoreJournalPublicationTargetAck(publicationAuth, {
        adapterProtocol: pending.target.adapterProtocol,
        journalNamespaceSha256: pending.target.journalNamespaceSha256,
        logicalDatabaseNamespaceSha256: pending.target.logicalDatabaseNamespaceSha256,
        ...remoteEntry, replayed: false,
      })).not.toBeNull();
      expect(await store.sealTenantRestoreJournalPublication(publicationAuth))
        .toMatchObject({ restoreFencePublicationComplete: true });
      const [headEvents] = await conn.query<RowDataPacket[]>(`SELECT update_kind FROM tenant_restore_runtime_events
        WHERE singleton_id=1 ORDER BY control_generation`);
      expect(headEvents.map((row) => row.update_kind)).toEqual([
        "primary_activation", "journal_head_advance",
      ]);
      if (phase === "live") return { targetOrdinal: pending.target.targetOrdinal, remoteEntry };

      const credential = (await store.claimTenantCredentialRevocations({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-credential-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!credential) throw new Error("genuine T3a claim missing");
      expect(await store.revokeTenantCredentialMaterial({ requestId: credential.requestId,
        tenantId: credential.tenantId, subjectGeneration: credential.subjectGeneration,
        claimAttempt: credential.claimAttempt, claimToken: credential.claimToken })).not.toBeNull();
      expect(await store.materializeTenantRuntimeRevocationJobs({ limit: 10 })).toBe(1);
      const runtime = (await store.claimTenantRuntimeRevocations({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-runtime-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!runtime) throw new Error("genuine T3b claim missing");
      expect(await store.completeTenantRuntimeRevocation({ requestId: runtime.requestId,
        tenantId: runtime.tenantId, subjectGeneration: runtime.subjectGeneration,
        claimAttempt: runtime.claimAttempt, claimToken: runtime.claimToken }, localFleetProof(runtime)))
        .not.toBeNull();
      expect(await store.materializeTenantContentInventoryJobs({ limit: 10 })).toBe(1);
      const inventory = (await store.claimTenantContentInventories({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-inventory-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!inventory) throw new Error("genuine T3c claim missing");
      const inventoryAuth = { requestId: inventory.requestId, tenantId: inventory.tenantId,
        subjectGeneration: inventory.subjectGeneration, buildGeneration: inventory.buildGeneration,
        claimAttempt: inventory.claimAttempt, claimToken: inventory.claimToken };
      let done = false;
      while (!done) done = (await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 })).done;
      expect(await store.sealTenantContentInventory(inventoryAuth)).not.toBeNull();
      expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
      const plan = (await store.claimTenantPurgePlans({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-plan-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!plan) throw new Error("genuine T3d claim missing");
      // MySQL T3d's final DB-millisecond floor is independent of caller time.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(await store.sealTenantPurgePlan({ requestId: plan.requestId, tenantId: plan.tenantId,
        subjectGeneration: plan.subjectGeneration, buildGeneration: plan.buildGeneration,
        claimAttempt: plan.claimAttempt, claimToken: plan.claimToken })).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCatalogReceipt(
        request.tenantId, request.requestId,
      )).toMatchObject({ sourceCount: 6, entryCount: 1, persistedProviderV2Count: 1 });
      expect(await store.materializeTenantPurgeExecutionJobs({ limit: 10 })).toBe(1);
      const execution = (await store.claimTenantPurgeExecutions({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-execution-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!execution) throw new Error("genuine T3e claim missing");
      const executionAuth = { requestId: execution.requestId, tenantId: execution.tenantId,
        subjectGeneration: execution.subjectGeneration, planBuildGeneration: execution.planBuildGeneration,
        executionGeneration: execution.executionGeneration,
        claimAttempt: execution.claimAttempt, claimToken: execution.claimToken };
      expect(await store.executeTenantPurgeLocalCutover(executionAuth)).not.toBeNull();
      const [ledger] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM usage_ledger WHERE BINARY tenant_id=BINARY ?", [request.tenantId]);
      expect(Number(ledger[0]?.n)).toBe(0);
      expect(await store.getTenantTelemetryRetainedSourceUsageReleaseReceipt(
        request.tenantId, request.requestId,
      )).toMatchObject({ entryCount: 1, retainedBillingFactCount: 1,
        allDomainsComplete: false, contentPurgeExecuted: false });
      if (phase === "usage_released") return { targetOrdinal: pending.target.targetOrdinal, remoteEntry };

      expect(await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)).not.toBeNull();
      expect(await store.materializeTenantDatabasePurgeJobs({ limit: 10 })).toBe(1);
      const database = (await store.claimTenantDatabasePurges({ limit: 10, leaseMs: 120_000,
        claimToken: `maintenance-database-${randomUUID()}`,
      })).find((row) => row.requestId === request.requestId);
      if (!database) throw new Error("genuine T3f claim missing");
      expect(await store.executeTenantDatabasePurge({ requestId: database.requestId,
        tenantId: database.tenantId, subjectGeneration: database.subjectGeneration,
        planBuildGeneration: database.planBuildGeneration,
        executionGeneration: database.executionGeneration,
        databasePurgeGeneration: database.databasePurgeGeneration,
        claimAttempt: database.claimAttempt, claimToken: database.claimToken })).not.toBeNull();
      expect(await store.getTenantTelemetryRetainedSourceCanonicalClosureReceipt(
        request.tenantId, request.requestId,
      )).toMatchObject({ allDomainsComplete: false, contentPurgeExecuted: false });
      const [sessions] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM sessions WHERE BINARY tenant_id=BINARY ?", [request.tenantId]);
      expect(Number(sessions[0]?.n)).toBe(0);
      return { targetOrdinal: pending.target.targetOrdinal, remoteEntry };
    }

    async function prepared(store: MysqlSessionStore, conn?: CaptureMysqlInspection,
      sourcePhase: RetainedSourcePhase = "fresh") {
      // One genuine local business source makes the 49-family comparison
      // nonempty. This fixture is not external S3/fleet proof.
      const tenantId = `tenant-${randomUUID()}`, userId = `user-${randomUUID()}`;
      if (sourcePhase !== "fresh") {
        await store.createApiKey(tenantId, `key-${tenantId}`, `hash-${tenantId}`);
        await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
        await store.putRetentionPolicy({ tenantId, policyVersion: "maintenance-zero-day",
          policy: retainedPolicy(), actorKeyId: "maintenance-local-policy-admin", atMs: Date.now() });
        await store.activateRetentionPolicy({ tenantId, policyVersion: "maintenance-zero-day",
          expectedControlGeneration: 0, actorKeyId: "maintenance-local-policy-admin", atMs: Date.now() });
        await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
      }
      const step = await captureStepFixture(store, { tenantId, userId });
      await store.commitPersistedProviderStepFailure(admitCapture(step));
      let publication: Awaited<ReturnType<typeof advanceRetainedSource>> | null = null;
      if (sourcePhase !== "fresh") {
        if (!conn) throw new Error("retained source fixture requires its own SQL connection");
        publication = await advanceRetainedSource(store, conn, step, sourcePhase);
      }
      const { entry, checkpointSha256 } = await available(store);
      const control = await store.getTenantBackupCatalogControl();
      if (control.state !== "active") throw new Error("fixture catalog inactive");
      const restoreRunId = `restore_${randomUUID()}`;
      const runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`maintenance-epoch-${restoreRunId}`);
      const identity = { backupId: entry.backupId, restoreRunId, entrySha256: entry.entrySha256,
        runtimeEpochSha256 };
      const reservationOperationSha256 = tenantBackupRuntimeReservationOperationSha256(identity);
      const reservationReceiptSha256 = tenantBackupReservationReceiptSha256({
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, failureDomainSha256: control.failureDomainSha256,
      }, identity, reservationOperationSha256);
      const reservation: TenantBackupRuntimeReservationAdapterResult = {
        adapterProtocol: control.adapterProtocol, catalogNamespaceSha256: control.catalogNamespaceSha256,
        catalogTargetSha256: control.catalogTargetSha256, ...identity,
        reservationOperationSha256, reservationReceiptSha256,
        ...eventProof(2, entry.catalogEventRootSha256, "restore_reserved",
          reservationOperationSha256, reservationReceiptSha256),
      };
      const input = { backupId: entry.backupId, restoreRunId, runtimeEpochSha256,
        controlEvidenceSha256: control.journalControlEvidenceSha256,
        sealedTargets: await store.getTenantRestoreRuntimeHeads(), reservation,
        captureCheckpointSha256: checkpointSha256 };
      const result = await store.prepareTenantRestoreReplayFromBackup(input);
      expect(result.disposition).toBe("created");
      const selector: TenantTelemetryCaptureRestoreMaintenanceSelector = {
        backupId: entry.backupId, restoreRunId, checkpointSha256,
        artifactManifestSha256: entry.artifactManifestSha256,
        sourceSnapshotSha256: entry.sourceSnapshotSha256,
        providerEvidenceSha256: entry.providerEvidenceSha256,
        reservationSha256: result.value.reservation.reservationSha256,
        reservationReceiptSha256: result.value.reservation.reservationReceiptSha256,
        fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1",
      };
      return { selector, step, publication };
    }

    it("cold verify-only maintenance seals one exact run then atomically publishes immutable history with runtime activation", runCase(async scope => {
      const f = await fixture(scope);
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      try {
        const { selector, step } = await prepared(f.store);
        await expect(f.owner.openStore(1, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: false,
          tenantTelemetryCaptureRestoreLocalOnly: false })).rejects.toThrow();
        await expect(f.store.activateTenantRestoreRuntime({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: 1 })).rejects.toMatchObject({ name: "Error",
          message: "Session authority activation requires its explicit operator maintenance profile." });
        await f.store.close();
        maintenance = await f.owner.openRestoreRead(selector);
        expect(Object.isFrozen(maintenance)).toBe(true);
        expect((await maintenance.getTenantRestoreReplayRun(selector.restoreRunId))?.phase).toBe("prepared");
        expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toBeNull();
        await expect(maintenance.getTenantRestoreReplayRun(`restore_${randomUUID()}`))
          .rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        const replay = await maintenance.sealTenantRestoreReplay(selector.restoreRunId);
        expect(replay).not.toBeNull();
        expect((await maintenance.getTenantRestoreReplayRun(selector.restoreRunId))?.phase).toBe("replay_sealed");
        const current = await maintenance.getTenantRestoreRuntimeControl();
        if (current.state !== "active") throw new Error("fixture runtime inactive");
        const transition = await f.owner.stageRestore({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: current.controlGeneration }, selector);
        const captured = await captureActualMaintenanceStore(f, () => f.owner.openActivationFacade(transition));
        maintenance = captured.facade;
        const startupAudit = captured.actual;
        const activated = await maintenance.activateTenantRestoreRuntime({
          restoreRunId: selector.restoreRunId, expectedControlGeneration: current.controlGeneration });
        expect(activated.state).toBe("active");
        await f.owner.confirm(transition, maintenance); scope.readiness = "history-only";
        const history = await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt();
        expect(history).toMatchObject({ phase: "active", backupId: selector.backupId,
          checkpointSha256: selector.checkpointSha256, restoreRunId: selector.restoreRunId,
          historyReadOnly: true, writeAuthorized: false, executionReady: false,
          externalAuthorityVerified: false, erasureAuthorized: false,
          allDomainsComplete: false, contentPurgeExecuted: false });
        const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT history_receipt_sha256
          FROM tenant_telemetry_capture_restore_history_receipts WHERE BINARY restore_run_id=BINARY ?`,
        [selector.restoreRunId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.history_receipt_sha256).toBe(history!.receiptSha256);
        expect(await maintenance.activateTenantRestoreRuntime({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: current.controlGeneration })).toEqual(activated);
        expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(history);
        // The normal primary-only startup must not turn this historical receipt
        // into permission to resume new provider writes or destructive T3e/T3f.
        await expect(f.owner.openStore(1, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: false,
          tenantTelemetryCaptureRestoreLocalOnly: false })).rejects.toThrow();
        // A real active capture/history is not a pristine pre-capture restore. Even with the
        // correct protected key and ordinary local capture gate, its missing explicit cutover
        // must remain a cold-start failure rather than taking the dormant-startup exception.
        const [captureControls] = await f.conn.query<RowDataPacket[]>(
          "SELECT state,control_generation FROM tenant_telemetry_capture_v2_controls WHERE domain='logs'",
        );
        expect(captureControls).toEqual([expect.objectContaining({ state: "active", control_generation: 1 })]);
        const [cutovers] = await f.conn.query<RowDataPacket[]>(
          "SELECT restore_run_id FROM tenant_telemetry_capture_epoch_cutovers WHERE BINARY restore_run_id=BINARY ?",
          [selector.restoreRunId],
        );
        expect(cutovers).toHaveLength(0);
        await expect(f.owner.openStore(1, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: true,
          tenantTelemetryCaptureRestoreLocalOnly: false })).rejects.toBeInstanceOf(TenantTelemetryWriteIntegrityError);
        // Ordinary startup's earlier writer audit wraps the same missing-cutover source
        // failure. Independently invoke the actual startup global audit on the real maintenance Store
        // in its real read-only RR scope, so that wrapper cannot hide a false exemption.
        // No proof reader, query, protected key or cutover guard is mocked or replaced.
        await expect(startupAudit.withConsistentRead((conn) =>
          startupAudit.assertCaptureRecoveryGlobalRelations(conn, false, true),
        )).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        expect(step.session.tenantId).not.toBe(history!.backupId);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; }
      finally { scope.phase = "body_finally"; await maintenance?.close(); await f.close(); }
    }));

    for (const sourcePhase of ["live", "usage_released", "canonical_closed"] as const) {
      it(`seals actual ${sourcePhase} retained-source rows after a primary journal-head advance and restores historical read-only lineage`, runCase(async scope => {
        const f = await fixture(scope);
        let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
        try {
          const { selector, step, publication } = await prepared(f.store, f.conn, sourcePhase);
          if (!publication) throw new Error("genuine primary publication entry missing");
          const [prior] = await f.conn.query<RowDataPacket[]>(`SELECT control_generation,update_kind,lineage_kind
            FROM tenant_restore_runtime_events ORDER BY control_generation`);
          expect(prior.map((row) => row.update_kind)).toEqual([
            "primary_activation", "journal_head_advance",
          ]);
          expect(prior.every((row) => row.lineage_kind === "primary")).toBe(true);
          const [actual] = await f.conn.query<RowDataPacket[]>(`SELECT
              (SELECT COUNT(*) FROM sessions WHERE BINARY tenant_id=BINARY ?) AS sessions,
              (SELECT COUNT(*) FROM usage_ledger WHERE BINARY tenant_id=BINARY ?) AS operational_usage,
              (SELECT COUNT(*) FROM billing_usage_facts WHERE BINARY tenant_id=BINARY ?) AS billing_facts,
              (SELECT COUNT(*) FROM tenant_purge_session_grave_markers WHERE BINARY tenant_id=BINARY ?) AS graves`,
          [step.session.tenantId, step.session.tenantId, step.session.tenantId, step.session.tenantId]);
          expect(actual).toHaveLength(1);
          expect(Number(actual[0]!.sessions)).toBe(sourcePhase === "canonical_closed" ? 0 : 1);
          expect(Number(actual[0]!.operational_usage)).toBe(sourcePhase === "live" ? 1 : 0);
          expect(Number(actual[0]!.billing_facts)).toBe(1);
          expect(Number(actual[0]!.graves)).toBe(sourcePhase === "canonical_closed" ? 1 : 0);
          await f.store.close();
          maintenance = await f.owner.openRestoreRead(selector);
          expect((await maintenance.getTenantRestoreReplayRun(selector.restoreRunId))?.phase).toBe("prepared");
          if (sourcePhase === "live") {
            let getterReads = 0;
            await expect(maintenance.recordTenantRestoreReplayFence({
              get restoreRunId() {
                return getterReads++ === 0 ? selector.restoreRunId : `restore_${randomUUID()}`;
              }, ...publication,
            })).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
            expect(getterReads).toBe(0);
            expect((await maintenance.getTenantRestoreReplayRun(selector.restoreRunId))?.entryCount).toBe(0);
          }
          // Replay the exact already-committed 0030 remote entry in ordinal
          // order. A nonzero sealed primary head may never be sealed from a
          // guessed zero-entry restore transcript.
          expect(await maintenance.recordTenantRestoreReplayFence({
            restoreRunId: selector.restoreRunId, ...publication,
          })).toMatchObject({ remoteSequence: publication.remoteEntry.remoteSequence,
            recordSha256: publication.remoteEntry.record.recordSha256 });
          expect(await maintenance.sealTenantRestoreReplay(selector.restoreRunId)).not.toBeNull();
          const runtime = await maintenance.getTenantRestoreRuntimeControl();
          if (runtime.state !== "active" || runtime.lineageKind !== "primary") {
            throw new Error("fixture original primary runtime missing");
          }
          const transition = await f.owner.stageRestore({ restoreRunId: selector.restoreRunId,
            expectedControlGeneration: runtime.controlGeneration }, selector);
          maintenance = await f.owner.openActivationFacade(transition);
          if (sourcePhase === "live") {
            let getterReads = 0;
            await expect(maintenance.activateTenantRestoreRuntime({
              get restoreRunId() {
                return getterReads++ === 0 ? selector.restoreRunId : `restore_${randomUUID()}`;
              }, expectedControlGeneration: runtime.controlGeneration,
            })).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
            expect(getterReads).toBe(0);
            expect((await maintenance.getTenantRestoreReplayRun(selector.restoreRunId))?.phase)
              .toBe("replay_sealed");
          }
          const activated = await maintenance.activateTenantRestoreRuntime({
            restoreRunId: selector.restoreRunId, expectedControlGeneration: runtime.controlGeneration,
          });
          if (activated.state !== "active") throw new Error("restore activation did not publish");
          await f.owner.confirm(transition, maintenance); scope.readiness = "history-only";
          expect(activated.lineageKind).toBe("restore");
          const history = await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt();
          expect(history).toMatchObject({ backupId: selector.backupId,
            restoreRunId: selector.restoreRunId, checkpointSha256: selector.checkpointSha256,
            phase: "active", historyReadOnly: true, writeAuthorized: false,
            executionReady: false, externalAuthorityVerified: false, erasureAuthorized: false,
            allDomainsComplete: false, contentPurgeExecuted: false });
          await maintenance.close(); maintenance = undefined;
          await f.store.close();
          maintenance = await f.owner.openRestoreRead(selector);
          expect(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(history);
          await expect(f.owner.openStore(1, scope.signal, { tenantTelemetryPersistedProviderCaptureLocalOnly: false,
            tenantTelemetryCaptureRestoreLocalOnly: false })).rejects.toThrow();
        } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; }
        finally { scope.phase = "body_finally"; await maintenance?.close(); await f.close(); }
      }));
    }

    it("two cold facades serialize the same run under effective RR even when their sessions default to RC", runCase(async scope => {
      const f = await fixture(scope);
      const facades: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>>[] = [];
      const pools: ReturnType<typeof mysql.createPool>[] = [];
      const sessionInitializers: Promise<void>[] = [];
      type QueryOutcome = "pending" | "succeeded" | "capture_restore_integrity" | "telemetry_write_integrity"
        | "lock_wait_timeout" | "deadlock" | "other_failure";
      type Probe = { poolIndex: number; connectionId: number; threadId: number; dispatched: boolean;
        queryOutcome: QueryOutcome; activationOutcome: QueryOutcome; waitObserved: boolean };
      const probes: Probe[] = [], restoreQueries: (() => void)[] = [];
      let armed = false;
      let releaseBarrier = false;
      let promises: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>[] = [];
      const outcome = (error: unknown): QueryOutcome => {
        if (error instanceof TenantTelemetryCaptureRestoreIntegrityError) return "capture_restore_integrity";
        if (error instanceof TenantTelemetryWriteIntegrityError) return "telemetry_write_integrity";
        const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
        return code === "ER_LOCK_WAIT_TIMEOUT" ? "lock_wait_timeout" : code === "ER_LOCK_DEADLOCK" ? "deadlock" : "other_failure";
      };
      const assertPending = () => {
        for (const probe of probes) {
          if (probe.activationOutcome !== "pending" || probe.dispatched && probe.queryOutcome !== "pending") {
            throw new Error(`Restore RR activation settled before barrier release: facade=${probe.poolIndex},query=${probe.queryOutcome},activation=${probe.activationOutcome}`);
          }
        }
      };
      try {
        const { selector } = await prepared(f.store);
        await f.store.close();
        const preparing = await f.owner.openRestoreRead(selector);
        expect(await preparing.sealTenantRestoreReplay(selector.restoreRunId)).not.toBeNull();
        const stagingRuntime = await preparing.getTenantRestoreRuntimeControl();
        if (stagingRuntime.state !== "active") throw new Error("fixture primary runtime missing");
        const transition = await f.owner.stageRestore({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: stagingRuntime.controlGeneration }, selector);
        const observer = await f.owner.openInspection(scope.signal);
        const originalCreatePool = mysql.createPool.bind(mysql);
        const spy = vi.spyOn(mysql, "createPool").mockImplementation((options) => {
          const pool = originalCreatePool(options);
          const poolIndex = pools.length;
          pools.push(pool);
          // This is a private test-pool session default, never SET GLOBAL or
          // a production store option. Native connection command ordering
          // queues this initializer ahead of the factory's first query.
          pool.pool.on("connection", (connection) => {
            const probe: Probe = { poolIndex, connectionId: 0, threadId: 0, dispatched: false,
              queryOutcome: "pending", activationOutcome: "pending", waitObserved: false };
            probes.push(probe);
            // Delegate the real native query, including its callback. A sticky dispatch
            // marker is set only after mysql2 accepted the exact blocking SELECT; it is
            // not a fabricated lock wait or an isolation-level response.
            type NativeQueryConnection = { query: (...args: unknown[]) => unknown };
            const native = connection as unknown as NativeQueryConnection, originalQuery = native.query;
            const wrappedQuery = (...args: unknown[]) => {
              const sql = args[0], values = args[1];
              if (!armed || probe.dispatched || typeof sql !== "string"
                || !/\bFROM\s+tenant_restore_replay_runs\b/.test(sql) || !/\bFOR UPDATE\s*$/.test(sql)
                || !Array.isArray(values) || values.length !== 1 || values[0] !== selector.restoreRunId) {
                return Reflect.apply(originalQuery, connection, args);
              }
              const callback = args.at(-1);
              if (typeof callback !== "function") throw new Error("Restore RR native query callback missing");
              const forwarded = [...args];
              forwarded[forwarded.length - 1] = function(this: unknown, ...completed: unknown[]) {
                probe.queryOutcome = completed[0] ? outcome(completed[0]) : "succeeded";
                return Reflect.apply(callback, this, completed);
              };
              const query = Reflect.apply(originalQuery, connection, forwarded);
              probe.dispatched = true;
              return query;
            };
            native.query = wrappedQuery;
            restoreQueries.push(() => { if (native.query === wrappedQuery) native.query = originalQuery; });
            sessionInitializers.push(new Promise<void>((resolve, reject) => {
              connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED", (error) => {
                if (error) reject(error); else resolve();
              });
            }));
          });
          return pool;
        });
        try {
          for (let index = 0; index < 2; index++) {
            facades.push(await f.owner.openActivationFacade(transition, 1));
          }
        } finally { spy.mockRestore(); }
        expect(pools).toHaveLength(2);
        await Promise.all(sessionInitializers);
        for (const [index, pool] of pools.entries()) {
          const own = await pool.getConnection();
          try {
            const [rows] = await own.query<RowDataPacket[]>(
              `SELECT @@SESSION.transaction_isolation AS isolation_level, CONNECTION_ID() AS connection_id,
                (SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=CONNECTION_ID()) AS thread_id`);
            expect(rows[0]?.isolation_level).toBe("READ-COMMITTED");
            const matching = probes.filter(probe => probe.poolIndex === index);
            expect(matching).toHaveLength(1);
            matching[0]!.connectionId = Number(rows[0]?.connection_id);
            matching[0]!.threadId = Number(rows[0]?.thread_id);
          } finally { own.release(); }
        }
        const runtime = await facades[0]!.getTenantRestoreRuntimeControl();
        if (runtime.state !== "active") throw new Error("fixture primary runtime missing");
        const [holder] = await f.conn.query<RowDataPacket[]>(`SELECT CONNECTION_ID() AS connection_id,
          (SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=CONNECTION_ID()) AS thread_id`);
        const holderConnectionId = Number(holder[0]?.connection_id), holderThreadId = Number(holder[0]?.thread_id);
        for (const id of [holderConnectionId, holderThreadId, ...probes.flatMap(probe => [probe.connectionId, probe.threadId])]) {
          expect(Number.isSafeInteger(id) && id > 0).toBe(true);
        }
        expect(new Set([holderConnectionId, ...probes.map(probe => probe.connectionId)]).size).toBe(3);
        expect(new Set([holderThreadId, ...probes.map(probe => probe.threadId)]).size).toBe(3);
        await f.conn.beginTransaction();
        const [held] = await f.conn.query<RowDataPacket[]>(`SELECT restore_run_id
          FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ? FOR UPDATE`,
        [selector.restoreRunId]);
        expect(held).toHaveLength(1);
        expect(held[0]?.restore_run_id).toBe(selector.restoreRunId);
        const [barrierLocks] = await observer.query<RowDataPacket[]>(`SELECT LOCK_STATUS
          FROM performance_schema.data_locks WHERE ENGINE='INNODB' AND THREAD_ID=?
            AND BINARY OBJECT_SCHEMA=BINARY ? AND BINARY OBJECT_NAME=BINARY 'tenant_restore_replay_runs'
            AND BINARY INDEX_NAME=BINARY 'PRIMARY' AND LOCK_TYPE='RECORD'`, [holderThreadId, f.name]);
        expect(barrierLocks.some(row => row.LOCK_STATUS === "GRANTED")).toBe(true);
        const input = { restoreRunId: selector.restoreRunId,
          expectedControlGeneration: runtime.controlGeneration };
        // Dispatch admission and all metadata observations share the original ten seconds.
        const deadline = Date.now() + 10_000;
        armed = true;
        promises = facades.map((facade, index) => facade.activateTenantRestoreRuntime(input).then(
          (value) => { probes[index]!.activationOutcome = "succeeded"; return { ok: true as const, value }; },
          (error: unknown) => { probes[index]!.activationOutcome = outcome(error); return { ok: false as const, error }; },
        ));
        let observed = false;
        let lastTransactionCount = 0, lastRrWaitCount = 0;
        while (Date.now() < deadline) {
          assertPending();
          if (probes.every(probe => probe.dispatched)) {
            // These diagnostic views do not share one atomic snapshot. Bind each
            // observation to known native IDs instead of dropping a waiter through
            // four INNER JOINs and requiring COUNT=2 in that same sample.
            const [transactions] = await observer.query<RowDataPacket[]>(`SELECT trx_mysql_thread_id,
                trx_state,trx_isolation_level FROM information_schema.innodb_trx
              WHERE trx_mysql_thread_id IN (?,?)`, probes.map(probe => probe.connectionId));
            lastTransactionCount = transactions.length;
            lastRrWaitCount = transactions.filter(row => row.trx_state === "LOCK WAIT" && row.trx_isolation_level === "REPEATABLE READ").length;
            if (Date.now() >= deadline) break;
            for (const transaction of transactions) expect(transaction.trx_isolation_level).toBe("REPEATABLE READ");
            const [waiters] = await observer.query<RowDataPacket[]>(`SELECT w.REQUESTING_THREAD_ID AS requesting_thread_id,
                w.BLOCKING_THREAD_ID AS blocking_thread_id,l.OBJECT_SCHEMA,l.OBJECT_NAME,l.INDEX_NAME,l.LOCK_TYPE,l.LOCK_STATUS
              FROM performance_schema.data_lock_waits w LEFT JOIN performance_schema.data_locks l
                ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
              WHERE w.ENGINE='INNODB' AND w.REQUESTING_THREAD_ID IN (?,?)`, probes.map(probe => probe.threadId));
            if (Date.now() >= deadline) break;
            const exactWaits = waiters.filter(row => row.OBJECT_SCHEMA === f.name
              && row.OBJECT_NAME === "tenant_restore_replay_runs" && row.INDEX_NAME === "PRIMARY"
              && row.LOCK_TYPE === "RECORD" && row.LOCK_STATUS === "WAITING");
            const reachesBarrier = (threadId: number, visited = new Set<number>()): boolean => {
              if (threadId === holderThreadId) return true;
              if (visited.has(threadId) || !probes.some(probe => probe.threadId === threadId)) return false;
              const next = new Set(visited); next.add(threadId);
              return exactWaits.some(row => Number(row.requesting_thread_id) === threadId
                && reachesBarrier(Number(row.blocking_thread_id), next));
            };
            for (const probe of probes) if (reachesBarrier(probe.threadId)) probe.waitObserved = true;
            assertPending();
            // Each recorded PRIMARY wait is held continuously: neither native
            // blocking query may complete before this test releases f.conn.
            if (Date.now() < deadline && probes.every(probe => probe.waitObserved && transactions.some(transaction =>
              Number(transaction.trx_mysql_thread_id) === probe.connectionId && transaction.trx_state === "LOCK WAIT"))) {
              observed = true;
              break;
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, Math.max(0, deadline - Date.now()))));
        }
        assertPending();
        expect(observed, `native dispatch=${probes.filter(probe => probe.dispatched).length}; transactions=${lastTransactionCount}; RR waits=${lastRrWaitCount}; PRIMARY waits=${probes.filter(probe => probe.waitObserved).length}`).toBe(true);
        armed = false;
        await f.conn.commit(); releaseBarrier = true;
        const outcomes = await Promise.all(promises);
        expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
        if (!outcomes[0]?.ok || !outcomes[1]?.ok) throw new Error("same-run activation did not converge");
        expect(outcomes[0].value).toEqual(outcomes[1].value);
        await f.owner.confirm(transition, facades[0]!); scope.readiness = "history-only";
        const firstHistory = await facades[0]!.getTenantTelemetryCaptureRestoreHistoryReceipt();
        expect(firstHistory).not.toBeNull();
        expect(await facades[1]!.getTenantTelemetryCaptureRestoreHistoryReceipt()).toEqual(firstHistory);
        const [rows] = await f.conn.query<RowDataPacket[]>(`SELECT
            (SELECT COUNT(*) FROM tenant_telemetry_capture_restore_history_receipts) AS history_count,
            (SELECT COUNT(*) FROM tenant_restore_runtime_events
              WHERE update_kind='restore_activation') AS activation_count`);
        expect(Number(rows[0]?.history_count)).toBe(1);
        expect(Number(rows[0]?.activation_count)).toBe(1);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; }
      finally {
        scope.phase = "body_finally";
        armed = false;
        if (!releaseBarrier) await f.conn.rollback().catch(() => {});
        if (promises.length) await Promise.allSettled(promises);
        for (const restoreQuery of restoreQueries) restoreQuery();
        await Promise.all(facades.map((facade) => facade.close()));
        await f.close();
      }
    }));

    it("rejects a wrong selected checkpoint or protected key before exposing the maintenance facade", runCase(async scope => {
      const f = await fixture(scope);
      try {
        const { selector } = await prepared(f.store);
        await f.store.close();
        await expect(f.owner.openRestoreRead({ ...selector, checkpointSha256: h("wrong checkpoint") })).rejects.toBeInstanceOf(TenantTelemetryCaptureRestoreIntegrityError);
        await expect(f.owner.openRestoreRead(selector, new Uint8Array(32).fill(7))).rejects.toThrow();
        const [rows] = await f.conn.query<RowDataPacket[]>(
          "SELECT restore_run_id FROM tenant_telemetry_capture_restore_history_receipts");
        expect(rows).toHaveLength(0);
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; }
      finally { scope.phase = "body_finally"; await f.close(); }
    }));

    it("a late history INSERT error rolls back actual runtime event, head, run and receipt together", runCase(async scope => {
      const f = await fixture(scope);
      let maintenance: Awaited<ReturnType<typeof MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance>> | undefined;
      const guard = "trg_test_mtc_history_late_reject";
      try {
        const { selector } = await prepared(f.store);
        await f.store.close();
        maintenance = await f.owner.openRestoreRead(selector);
        expect(await maintenance.sealTenantRestoreReplay(selector.restoreRunId)).not.toBeNull();
        const before = await maintenance.getTenantRestoreRuntimeControl();
        if (before.state !== "active") throw new Error("fixture runtime inactive");
        const transition = await f.owner.stageRestore({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: before.controlGeneration }, selector);
        maintenance = await f.owner.openActivationFacade(transition);
        const rollbackWitness = await f.owner.snapshotForRollback(transition);
        const [beforeEvents] = await f.conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM tenant_restore_runtime_events");
        await f.conn.query(`CREATE TRIGGER \`${guard}\` BEFORE INSERT ON
          tenant_telemetry_capture_restore_history_receipts FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated late history reject'`);
        const activation = maintenance.activateTenantRestoreRuntime({ restoreRunId: selector.restoreRunId,
          expectedControlGeneration: before.controlGeneration });
        await expect(activation).rejects.toThrow();
        await expect(activation).rejects.toMatchObject({ code: "ER_SIGNAL_EXCEPTION", sqlState: "45000",
          sqlMessage: "isolated late history reject" });
        const [afterEvents] = await f.conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM tenant_restore_runtime_events");
        const [runRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT phase FROM tenant_restore_replay_runs WHERE BINARY restore_run_id=BINARY ?",
        [selector.restoreRunId]);
        const [historyRows] = await f.conn.query<RowDataPacket[]>(
          "SELECT restore_run_id FROM tenant_telemetry_capture_restore_history_receipts");
        expect(afterEvents).toEqual(beforeEvents);
        expect(runRows).toHaveLength(1);
        expect(runRows[0]!.phase).toBe("replay_sealed");
        expect(historyRows).toHaveLength(0);
        expect(await maintenance.getTenantRestoreRuntimeControl()).toEqual(before);
        await f.owner.proveLateHistoryRollback(transition, activation, rollbackWitness);
        scope.expectedUnapplied = transition;
      } catch (reason) { scope.failed = true; scope.failure ??= { reason }; throw reason; }
      finally {
        scope.phase = "body_finally";
        await f.conn.query(`DROP TRIGGER IF EXISTS \`${guard}\``);
        await maintenance?.close(); await f.close();
      }
    }));
  });
} else {
  describe.skip("0056 capture restore maintenance requires local MySQL integration", () => {
    it("requires the explicit integration profile", () => {});
  });
}
