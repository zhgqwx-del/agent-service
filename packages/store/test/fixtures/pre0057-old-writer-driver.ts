import { createHash, randomUUID } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, MemoryTenantBackupCatalogAdapter, PersistedProviderCaptureIntegrityError,
  newTenantBackupId, tenantRestoreRuntimeEpochSha256, tenantTelemetryWriteAdapterResult } from "@agent-service/store";
import { activateCaptureFixture, captureRefKey, captureStepFixture, uncapturedStepFixture } from "../persisted-provider-capture.fixture.js";

// Copied into the exact old-0056 source archive. Product imports and the
// capture producer fixture all resolve inside that archive, never live 0057.
const SOURCE_COMMIT = "b8b89843198176ade41839746c8ede235ae5934f";
const STAGES = ["input", "connect", "legacy", "activate", "source", "claim", "reserve", "ack", "finish",
  "anchor", "checkpoint", "availability", "preflight", "epoch-reserve", "prepare", "replay", "restore-activate", "proof"] as const;
const CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantTelemetryCaptureRestoreIntegrityError", "TenantBackupCatalogConflictError", "TenantBackupCatalogNotReadyError", "TenantErasureIntegrityError"] as const;
let stage: typeof STAGES[number] = "input";
const h = (value: string) => createHash("sha256").update(value).digest("hex");
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("frozen 0056 evidence missing"); return value; }
function count(value: unknown): number {
  if (!(typeof value === "number" || typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) throw new Error("frozen count invalid");
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("frozen count invalid"); return n;
}
function diagnostic(error: unknown, field: "code" | "name", allowed: readonly string[], absent: string): string {
  try {
    if (typeof error !== "object" || error === null || !(field in error)) return absent;
    const value: unknown = (error as Record<string, unknown>)[field]; return typeof value === "string" && allowed.includes(value) ? value : "other";
  } catch { return "other"; }
}
async function run() {
  const phase = process.env.FROZEN_0056_PHASE;
  if (phase !== "prepared" && phase !== "active") throw new Error("frozen 0056 phase invalid");
  const tenantHistoryProfile = process.env.FROZEN_0056_TENANT_HISTORY ?? "creation-complete";
  if (tenantHistoryProfile !== "creation-complete" && tenantHistoryProfile !== "legacy-history") {
    throw new Error("frozen 0056 tenant history profile invalid");
  }
  const url = process.env.MYSQL_URL;
  if (!url) throw new Error("frozen 0056 fixture URL missing");
  const address = new URL(url);
  if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    || !/^agent_service_migration_test_0057_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) throw new Error("frozen 0056 database invalid");
  stage = "connect";
  const store = await MysqlSessionStore.connect({ url, tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  const catalog = new MemoryTenantBackupCatalogAdapter({ nonProductionFixture: true,
    namespaceId: "frozen0056-catalog", targetId: "frozen0056-catalog-target", failureDomainId: "inprocess-no-external-durability" });
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  try {
    stage = "legacy";
    const legacy = await uncapturedStepFixture(store, { tenantId: `legacy-${randomUUID()}`, userId: `legacy-user-${randomUUID()}` });
    await store.commit(legacy.batch);
    await store.commit({ sessionId: legacy.session.id, fence: 1,
      turn: { ...legacy.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() }, sessionPatch: { status: { type: "idle" } } });
    if (tenantHistoryProfile === "legacy-history") {
      await store.createApiKey(legacy.session.tenantId, `fixture-key-${randomUUID()}`, `fixture-hash-${randomUUID()}`);
    }
    stage = "activate";
    await activateCaptureFixture(store);
    const activation = required(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt());
    await store.activateBlobStorageControl({ expectedControlGeneration: 0, storageBackend: "s3v1-frozen0056-fixture", namespaceSha256: h("frozen0056-blob") });
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("frozen journal inactive");
    const control = (await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
      adapterProtocol: catalog.adapterProtocol, catalogNamespaceSha256: catalog.catalogNamespaceSha256,
      catalogTargetSha256: catalog.catalogTargetSha256, failureDomainSha256: catalog.failureDomainSha256,
      logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: journal.evidenceSha256,
      retentionPolicySha256: h("frozen0056-retention"), minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 })).value;
    // The legacy-history profile deliberately reuses the real canonical tenant
    // created BEFORE the old product activated lifecycle/capture. Do not swap
    // it for a new tenant or shape SQL into a desired checkpoint classification.
    const tenantId = tenantHistoryProfile === "legacy-history" ? legacy.session.tenantId : `source-${randomUUID()}`;
    const userId = tenantHistoryProfile === "legacy-history" ? legacy.session.userId : `source-user-${randomUUID()}`;
    let actualFixtureAckCount = 0;
    // Each transition uses the old real MySQL store. The adapter ACK fixture
    // performs no external create/read and must never be called S3 durability.
    for (const phase of ["written", "reserved", "queued"] as const) {
      stage = "source";
      const source = await captureStepFixture(store, { tenantId, userId });
      const committed = await store.commitPersistedProviderStepFailure(source.input);
      if (phase !== "queued") {
        stage = "claim";
        const claim = required((await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
          claimToken: `old55-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: source.proof }))
          .find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256));
        const auth = { tenantId, writeOperationSha256: claim.writeOperationSha256, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        stage = "reserve";
        required(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", source.proof));
        if (phase === "written") {
          stage = "ack";
          required(await store.completeTenantTelemetryWrite(auth, tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
            writeOperationSha256: claim.writeOperationSha256, target: claim.target, inventory: claim.inventory, payload: claim.payload,
          }, "already_present", true), source.proof));
          actualFixtureAckCount += 1;
        }
      }
      stage = "finish";
      await store.commit({ sessionId: source.session.id, fence: 1,
        turn: { ...source.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() }, sessionPatch: { status: { type: "idle" } } });
    }
    stage = "anchor";
    const backupId = newTenantBackupId();
    const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId, controlEvidenceSha256: control.evidenceSha256 })).value;
    stage = "checkpoint";
    const checkpoint = required(await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).value;
    const legacyMembershipLeafCount = checkpoint.leaves.filter((leaf) => leaf.family === "membership"
      && leaf.knowledge === "legacy_unknown").length;
    if (tenantHistoryProfile === "legacy-history" && legacyMembershipLeafCount !== 3) {
      throw new Error("frozen old membership knowledge differed");
    }
    stage = "availability";
    // The official old catalog fixture produces every receipt/event itself.
    // Evidence here is explicitly protocol metadata, NOT authenticated GCM bytes.
    const availability = await catalog.publishAvailability({ backupId, anchorSha256: anchor.anchorSha256,
      sourceSnapshotSha256: h("frozen0056-protocol-only-snapshot"), sourceBackupSha256: h("frozen0056-protocol-only-backup"),
      artifactManifestSha256: h("frozen0056-protocol-only-manifest"), providerEvidenceSha256: h("frozen0056-protocol-only-provider"),
      controlEvidenceSha256: control.evidenceSha256, logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
      retentionPolicySha256: control.retentionPolicySha256, retentionUntilDbMs: anchor.retentionUntilDbMs, registeredAtDbMs: anchor.createdAtDbMs });
    const entry = (await store.recordTenantBackupCatalogAvailability(availability)).value;
    const restoreRunId = `restore_${randomUUID()}`, runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`frozen0056-restored-${randomUUID()}`);
    stage = "preflight";
    await store.preflightTenantRestoreReplayFromBackup({ backupId, restoreRunId, runtimeEpochSha256,
      captureCheckpointSha256: checkpoint.checkpoint.checkpointSha256 });
    stage = "epoch-reserve";
    const reservation = await catalog.reserveRestore({ backupId, restoreRunId, runtimeEpochSha256, entrySha256: entry.entrySha256 });
    stage = "prepare";
    const prepared = (await store.prepareTenantRestoreReplayFromBackup({ backupId, restoreRunId, runtimeEpochSha256,
      captureCheckpointSha256: checkpoint.checkpoint.checkpointSha256, controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets: anchor.sourceRuntimeHeads, reservation })).value;
    stage = "proof";
    if (prepared.replayRun.phase !== "prepared" || prepared.binding.sourceBackupSha256 !== entry.sourceBackupSha256
      || prepared.reservation.reservationReceiptSha256 !== reservation.reservationReceiptSha256) throw new Error("frozen prepared relation differed");
    let pendingWriteDenied = false;
    try { await store.getTenantTelemetryPersistedProviderCaptureBinding(); }
    catch (error) {
      if (!(error instanceof PersistedProviderCaptureIntegrityError)
        || error.message !== "persisted provider capture evidence is invalid") throw error;
      pendingWriteDenied = true;
    }
    if (!pendingWriteDenied) throw new Error("frozen pending write gate unexpectedly open");
    const selector = { backupId, restoreRunId, checkpointSha256: checkpoint.checkpoint.checkpointSha256,
      artifactManifestSha256: entry.artifactManifestSha256, sourceSnapshotSha256: entry.sourceSnapshotSha256,
      providerEvidenceSha256: entry.providerEvidenceSha256, reservationSha256: prepared.reservation.reservationSha256,
      reservationReceiptSha256: prepared.reservation.reservationReceiptSha256,
      fleetStoppedAck: "fleet-stopped-v1" as const, localOnlyAck: "local-only-v1" as const };
    let historyReceiptSha256: string | null = null;
    if (phase === "active") {
      stage = "replay";
      const maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({
        url, tenantTelemetryRefKey: captureRefKey, selector });
      try {
        required(await maintenance.sealTenantRestoreReplay(restoreRunId));
        const before = await maintenance.getTenantRestoreRuntimeControl();
        stage = "restore-activate";
        const runtime = await maintenance.activateTenantRestoreRuntime({ restoreRunId, expectedControlGeneration: before.controlGeneration });
        if (runtime.state !== "active" || runtime.lineageKind !== "restore" || runtime.runtimeEpochSha256 !== runtimeEpochSha256) {
          throw new Error("frozen actual restored runtime differed");
        }
        const history = required(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt());
        if (history.restoreRunId !== restoreRunId || history.checkpointSha256 !== checkpoint.checkpoint.checkpointSha256
          || history.runtimeEpochSha256 !== runtimeEpochSha256 || history.historyReadOnly !== true || history.writeAuthorized !== false
          || history.erasureAuthorized !== false) throw new Error("frozen actual history differed");
        historyReceiptSha256 = history.receiptSha256;
      } finally { await maintenance.close(); }
    }
    stage = "proof";
    conn = await mysql.createConnection(url);
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    const [tables] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'");
    const [jobs] = await conn.query<RowDataPacket[]>(`SELECT COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NOT NULL THEN 1 END) AS reserved,
      COUNT(CASE WHEN phase='written' THEN 1 END) AS written FROM tenant_telemetry_write_jobs`);
    if (jobs.length !== 1) throw new Error("frozen job phase proof absent");
    const sourceCounts = { queued: count(jobs[0]!.queued), reserved: count(jobs[0]!.reserved), written: count(jobs[0]!.written) };
    const [legacyRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM items WHERE type='agentMessage' AND status='failed' AND (telemetry_capture_v2_control_generation IS NULL OR telemetry_capture_v2_control_generation=0)");
    const [sidecars] = await conn.query<RowDataPacket[]>("SELECT * FROM tenant_telemetry_capture_restore_bindings WHERE restore_run_id=?", [restoreRunId]);
    if (markers.at(-1)?.name !== "0056_tenant_telemetry_capture_restore_history.sql" || count(guards[0]?.n) !== 720
      || count(legacyRows[0]?.n) !== 1 || Object.values(sourceCounts).some((n) => n !== 1) || sidecars.length !== 1
      || sidecars[0]!.checkpoint_sha256 !== checkpoint.checkpoint.checkpointSha256
      || sidecars[0]!.source_binding_sha256 !== prepared.binding.bindingSha256
      || sidecars[0]!.reservation_sha256 !== prepared.reservation.reservationSha256) throw new Error("frozen 0056 SQL proof differed");
    return { scope: "frozen0056-epoch-upgrade-v1", sourceCommit: SOURCE_COMMIT, marker: markers.at(-1)!.name,
      phase, historyReceiptSha256, tenantHistoryProfile, legacyMembershipLeafCount,
      triggerCount: 720, tableCount: count(tables[0]?.n), sourceCounts, legacyUnknownItemCount: 1,
      activationReceiptSha256: activation.receiptSha256, checkpointSha256: checkpoint.checkpoint.checkpointSha256,
      checkpointLeafCount: checkpoint.leaves.length, pendingWriteDenied,
      sourceBackupSha256: entry.sourceBackupSha256, runtimeEpochSha256, sourceBindingSha256: prepared.binding.bindingSha256,
      selector,
      actualFixtureAckCount, actualSinkWriteCount: 0, sourceSinkDurable: false, catalogProtocolFixture: true,
      artifactBytesAuthenticated: false, physicalRestoreExecuted: false, runtimeActivated: phase === "active",
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false };
  } finally { await conn?.end(); await Promise.all([store.close(), catalog.close()]); }
}
try { process.stdout.write(JSON.stringify(await run())); }
catch (error) {
  process.stderr.write(`pre0057-frozen-writer-diagnostic:${JSON.stringify({ schema: "pre0057-frozen-writer-diagnostic-v1", stage,
    code: diagnostic(error, "code", CODES, "none"), name: diagnostic(error, "name", NAMES, "other") })}\n`);
  process.exitCode = 1;
}

