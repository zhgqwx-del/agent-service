import { createHash, randomUUID } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { MysqlSessionStore, MemoryTenantBackupCatalogAdapter, PersistedProviderCaptureIntegrityError,
  newTenantBackupId, tenantRestoreRuntimeEpochSha256, tenantTelemetryWriteAdapterResult } from "@agent-service/store";
import { activateCaptureFixture, captureRefKey, captureStepFixture, uncapturedStepFixture } from "../persisted-provider-capture.fixture.js";

// Copied ONLY into the exact published 0057 archive. All product/producer
// imports resolve inside that archive; this driver never imports live 0058.
const SOURCE_COMMIT = "3414b43febd927108ff6e94cab4875499d7d2ea6";
const STAGES = ["input", "connect", "legacy", "activate", "source", "claim", "reserve", "ack", "retry", "finish",
  "anchor", "checkpoint", "availability", "preflight", "epoch-reserve", "prepare", "replay", "restore-activate", "cutover", "cold-open", "recover", "proof"] as const;
const CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantTelemetryCaptureRestoreIntegrityError", "TenantBackupCatalogConflictError", "TenantBackupCatalogNotReadyError", "TenantErasureIntegrityError",
  "TenantTelemetryWriteIntegrityError"] as const;
let stage: typeof STAGES[number] = "input";
const h = (value: string) => createHash("sha256").update(value).digest("hex");
function required<T>(value: T | null | undefined): T { if (value == null) throw new Error("frozen 0057 evidence missing"); return value; }
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
  const profile = process.env.FROZEN_0057_PROFILE;
  if (profile !== "recovered" && profile !== "history-only") throw new Error("frozen 0057 profile invalid");
  const url = process.env.MYSQL_URL;
  if (!url) throw new Error("frozen 0057 fixture URL missing");
  const address = new URL(url);
  if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    || !/^agent_service_migration_test_0058_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) throw new Error("frozen 0057 database invalid");
  stage = "connect";
  const store = await MysqlSessionStore.connect({ url, tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true, tenantTelemetryCaptureRestoreLocalOnly: true });
  let storeClosed = false;
  const closeStore = async () => { if (!storeClosed) { storeClosed = true; await store.close(); } };
  const catalog = new MemoryTenantBackupCatalogAdapter({ nonProductionFixture: true,
    namespaceId: "frozen0057-catalog", targetId: "frozen0057-catalog-target", failureDomainId: "inprocess-no-external-durability" });
  let cold: MysqlSessionStore | undefined;
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  try {
    stage = "legacy";
    const legacy = await uncapturedStepFixture(store, { tenantId: `legacy-${randomUUID()}`, userId: `legacy-user-${randomUUID()}` });
    await store.commit(legacy.batch);
    await store.commit({ sessionId: legacy.session.id, fence: 1,
      turn: { ...legacy.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() }, sessionPatch: { status: { type: "idle" } } });
    stage = "activate";
    await activateCaptureFixture(store);
    const activation = required(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt());
    await store.activateBlobStorageControl({ expectedControlGeneration: 0, storageBackend: "s3v1-frozen0057-fixture", namespaceSha256: h("frozen0057-blob") });
    const journal = await store.getTenantRestoreJournalControl();
    if (journal.controlGeneration !== 1) throw new Error("frozen journal inactive");
    const control = (await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
      adapterProtocol: catalog.adapterProtocol, catalogNamespaceSha256: catalog.catalogNamespaceSha256,
      catalogTargetSha256: catalog.catalogTargetSha256, failureDomainSha256: catalog.failureDomainSha256,
      logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: journal.evidenceSha256,
      retentionPolicySha256: h("frozen0057-retention"), minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 })).value;
    const tenantId = `source-${randomUUID()}`, userId = `source-user-${randomUUID()}`;
    let actualFixtureAckCount = 0;
    let reservedOperationSha256: string | undefined;
    let originalReservation: Awaited<ReturnType<MysqlSessionStore["reserveTenantTelemetryExternalMutation"]>> = null;
    let queuedOperationSha256: string | undefined;
    // Real old-store business calls create all three source states. The ACK
    // below is explicitly an in-process protocol fixture, NOT a durable sink.
    for (const phase of ["written", "reserved", "queued"] as const) {
      stage = "source";
      const source = await captureStepFixture(store, { tenantId, userId });
      const committed = await store.commitPersistedProviderStepFailure(source.input);
      if (phase === "queued") queuedOperationSha256 = committed.failureCommitReceipt.writeOperationSha256;
      else {
        stage = "claim";
        const claim = required((await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
          claimToken: `old57-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: source.proof }))
          .find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256));
        const auth = { tenantId, writeOperationSha256: claim.writeOperationSha256, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        stage = "reserve";
        const reservation = required(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", source.proof));
        if (phase === "written") {
          stage = "ack";
          required(await store.completeTenantTelemetryWrite(auth, tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
            writeOperationSha256: claim.writeOperationSha256, target: claim.target, inventory: claim.inventory, payload: claim.payload,
          }, "already_present", true), source.proof));
          actualFixtureAckCount += 1;
        } else {
          reservedOperationSha256 = claim.writeOperationSha256; originalReservation = reservation;
          stage = "retry";
          // Legitimate old API releases the claim, preserving the original R;
          // no wall-clock sleep or SQL rewrite is needed before restored P1.
          if (!await store.retryTenantTelemetryWrite(auth, { delayMs: 0, errorCode: "temporary_failure" })) {
            throw new Error("frozen reservation retry failed");
          }
        }
      }
      stage = "finish";
      await store.commit({ sessionId: source.session.id, fence: 1,
        turn: { ...source.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() }, sessionPatch: { status: { type: "idle" } } });
    }
    const originalR = required(originalReservation);
    const reservedOperation = required(reservedOperationSha256), queuedOperation = required(queuedOperationSha256);
    stage = "anchor";
    const backupId = newTenantBackupId();
    const anchor = (await store.createTenantBackupSnapshotAnchor({ backupId, controlEvidenceSha256: control.evidenceSha256 })).value;
    stage = "checkpoint";
    const checkpoint = required(await store.sealTenantTelemetryCaptureBackupCheckpoint({ backupId,
      fleetStoppedAck: "fleet-stopped-v1", localOnlyAck: "local-only-v1" })).value;
    if (checkpoint.checkpoint.scope !== "tenant-telemetry-capture-backup-checkpoint-v1"
      || checkpoint.checkpoint.families.length !== 49
      || !checkpoint.leaves.some((leaf) => leaf.family === "legacy_failure" && leaf.knowledge === "legacy_unknown")) {
      throw new Error("frozen checkpoint lost its actual v1 or unknown history");
    }
    stage = "availability";
    const availability = await catalog.publishAvailability({ backupId, anchorSha256: anchor.anchorSha256,
      sourceSnapshotSha256: h("frozen0057-protocol-only-snapshot"), sourceBackupSha256: h("frozen0057-protocol-only-backup"),
      artifactManifestSha256: h("frozen0057-protocol-only-manifest"), providerEvidenceSha256: h("frozen0057-protocol-only-provider"),
      controlEvidenceSha256: control.evidenceSha256, logicalDatabaseNamespaceSha256: anchor.logicalDatabaseNamespaceSha256,
      retentionPolicySha256: control.retentionPolicySha256, retentionUntilDbMs: anchor.retentionUntilDbMs, registeredAtDbMs: anchor.createdAtDbMs });
    const entry = (await store.recordTenantBackupCatalogAvailability(availability)).value;
    const restoreRunId = `restore_${randomUUID()}`, runtimeEpochSha256 = tenantRestoreRuntimeEpochSha256(`frozen0057-restored-${randomUUID()}`);
    stage = "preflight";
    await store.preflightTenantRestoreReplayFromBackup({ backupId, restoreRunId, runtimeEpochSha256,
      captureCheckpointSha256: checkpoint.checkpoint.checkpointSha256 });
    stage = "epoch-reserve";
    const reservation = await catalog.reserveRestore({ backupId, restoreRunId, runtimeEpochSha256, entrySha256: entry.entrySha256 });
    stage = "prepare";
    const prepared = (await store.prepareTenantRestoreReplayFromBackup({ backupId, restoreRunId, runtimeEpochSha256,
      captureCheckpointSha256: checkpoint.checkpoint.checkpointSha256, controlEvidenceSha256: journal.evidenceSha256,
      sealedTargets: anchor.sourceRuntimeHeads, reservation })).value;
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
    stage = "replay";
    const maintenance = await MysqlSessionStore.connectTenantTelemetryCaptureRestoreMaintenance({ url, tenantTelemetryRefKey: captureRefKey, selector });
    let historyReceiptSha256: string;
    let cutoverReceiptSha256: string | null = null;
    try {
      required(await maintenance.sealTenantRestoreReplay(restoreRunId));
      const before = await maintenance.getTenantRestoreRuntimeControl();
      stage = "restore-activate";
      const runtime = await maintenance.activateTenantRestoreRuntime({ restoreRunId, expectedControlGeneration: before.controlGeneration });
      if (runtime.state !== "active" || runtime.lineageKind !== "restore" || runtime.runtimeEpochSha256 !== runtimeEpochSha256) {
        throw new Error("frozen actual restored runtime differed");
      }
      historyReceiptSha256 = required(await maintenance.getTenantTelemetryCaptureRestoreHistoryReceipt()).receiptSha256;
      if (profile === "recovered") {
        stage = "cutover";
        cutoverReceiptSha256 = (await maintenance.activateTenantTelemetryCaptureRestoredEpoch({ expectedRuntimeEpochSha256: runtimeEpochSha256,
          configuredFleetRootSha256: "6".repeat(64), legacyWritersDrainedAck: "legacy-writers-drained-v1",
          producerReadyAck: "provider-step-error-v2-ready-v1" })).receiptSha256;
      }
    } finally { await maintenance.close(); }
    await closeStore(); // Old producer is stopped before cold runtime or upgrade.
    let permitReceiptSha256: string | null = null;
    if (profile === "recovered") {
      stage = "cold-open";
      cold = await MysqlSessionStore.connect({ url, migrationMode: "verify", tenantTelemetryRefKey: captureRefKey,
        tenantTelemetryPersistedProviderCaptureLocalOnly: true });
      const proof = required(await cold.getTenantTelemetryPersistedProviderCaptureBinding());
      if (proof.captureControlEvidenceSha256 !== cutoverReceiptSha256) throw new Error("frozen restored proof differed");
      stage = "recover";
      const recovered = required((await cold.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
        claimToken: `old57-recovered-${randomUUID()}`, adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: proof }))[0]);
      if (recovered.writeOperationSha256 !== reservedOperation || !recovered.captureRecovery
        || recovered.captureRecovery.recoveryMode !== "resume_reserved" || recovered.reservation?.receiptSha256 !== originalR.receiptSha256
        || JSON.stringify(recovered.reservation) !== JSON.stringify(originalR)) throw new Error("frozen P1 did not preserve exact original R");
      permitReceiptSha256 = recovered.captureRecovery.permitReceiptSha256;
      // Deliberately leave P1/R pending: no second create, ACK, or fake recovery completion.
      await cold.close(); cold = undefined;
    }
    stage = "proof";
    conn = await mysql.createConnection(url);
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [guards] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    const [tables] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE'");
    const [jobs] = await conn.query<RowDataPacket[]>(`SELECT COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NOT NULL THEN 1 END) AS reserved,
      COUNT(CASE WHEN phase='written' THEN 1 END) AS written FROM tenant_telemetry_write_jobs`);
    const sourceCounts = { queued: count(jobs[0]?.queued), reserved: count(jobs[0]?.reserved), written: count(jobs[0]?.written) };
    const [legacyRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM items WHERE type='agentMessage' AND status='failed' AND (telemetry_capture_v2_control_generation IS NULL OR telemetry_capture_v2_control_generation=0)");
    const [permits] = await conn.query<RowDataPacket[]>("SELECT permit_receipt_sha256,write_operation_sha256 FROM tenant_telemetry_capture_recovery_permits");
    const [pending] = await conn.query<RowDataPacket[]>(`SELECT phase,attempts,mutation_reservation_receipt_sha256
      FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`, [queuedOperation]);
    const [reserved] = await conn.query<RowDataPacket[]>(`SELECT phase,mutation_reservation_receipt_sha256,mutation_started_claim_attempt,
      mutation_started_claim_token_sha256 FROM tenant_telemetry_write_jobs WHERE BINARY write_operation_sha256=BINARY ?`, [reservedOperation]);
    if (markers.at(-1)?.name !== "0057_tenant_telemetry_capture_epoch_cutover.sql" || count(guards[0]?.n) !== 728
      || count(legacyRows[0]?.n) !== 1 || Object.values(sourceCounts).some((n) => n !== 1)
      || permits.length !== (profile === "recovered" ? 1 : 0)
      || (profile === "recovered" && (permits[0]?.permit_receipt_sha256 !== permitReceiptSha256 || permits[0]?.write_operation_sha256 !== reservedOperation))
      || pending.length !== 1 || pending[0]?.phase !== "queued" || count(pending[0]?.attempts) !== 0 || pending[0]?.mutation_reservation_receipt_sha256 !== null
      || reserved.length !== 1 || reserved[0]?.phase !== "queued" || reserved[0]?.mutation_reservation_receipt_sha256 !== originalR.receiptSha256
      || count(reserved[0]?.mutation_started_claim_attempt) !== originalR.startedClaimAttempt
      || reserved[0]?.mutation_started_claim_token_sha256 !== originalR.startedClaimTokenSha256) throw new Error("frozen 0057 SQL proof differed");
    return { scope: "frozen0057-repeat-upgrade-v1", sourceCommit: SOURCE_COMMIT, marker: markers.at(-1)!.name, profile,
      triggerCount: 728, tableCount: count(tables[0]?.n), sourceCounts, legacyUnknownItemCount: 1,
      activationReceiptSha256: activation.receiptSha256, checkpointSha256: checkpoint.checkpoint.checkpointSha256,
      checkpointLeafCount: checkpoint.leaves.length, historyReceiptSha256, cutoverReceiptSha256, permitReceiptSha256,
      reservedOperationSha256: reservedOperation, queuedOperationSha256: queuedOperation, originalReservationReceiptSha256: originalR.receiptSha256,
      pendingWriteDenied, sourceBackupSha256: entry.sourceBackupSha256, runtimeEpochSha256, selector,
      actualFixtureAckCount, actualSinkWriteCount: 0, sourceSinkDurable: false, catalogProtocolFixture: true,
      artifactBytesAuthenticated: false, physicalRestoreExecuted: false, runtimeActivated: true,
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false };
  } finally { await conn?.end(); await Promise.all([closeStore(), cold?.close(), catalog.close()]); }
}
try { process.stdout.write(JSON.stringify(await run())); }
catch (error) {
  process.stderr.write(`pre0058-frozen-writer-diagnostic:${JSON.stringify({ schema: "pre0058-frozen-writer-diagnostic-v1", stage,
    code: diagnostic(error, "code", CODES, "none"), name: diagnostic(error, "name", NAMES, "other") })}\n`);
  process.exitCode = 1;
}
