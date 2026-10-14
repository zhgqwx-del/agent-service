import { randomUUID } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
} from "@agent-service/protocol";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  MysqlSessionStore,
  TenantRestoreJournalPublicationDependencyPendingError,
  newErasureRequestId,
  tenantErasureRequestHash,
  s3TenantTelemetryTargetIdentity,
  tenantTelemetryWriteAdapterResult,
  type RetentionPolicyDocumentV1,
  type TenantRuntimeRevocationClaim,
} from "@agent-service/store";
import { captureRefKey, captureStepFixture, uncapturedStepFixture } from "../persisted-provider-capture.fixture.js";

// This driver is copied into the exact e411143 archive. All product and helper
// imports resolve inside that archive, never against the live 0054 checkout.
// The through0052 mode uses a 0053-aware binary's real legacy-schema path; it is
// deliberately NOT described as a frozen 0052 binary.
const SOURCE_COMMIT = "e41114392e028efff474b2c5ac13df3784b83228";
const url = process.env.MYSQL_URL;
const mode = process.env.PRE0054_FIXTURE_MODE;
if (!url || !["legacy", "active", "terminal"].includes(mode ?? "")) {
  throw new Error("frozen 0053 writer requires fixed fixture inputs");
}
const WRITER_STAGES = [
  "input", "legacy-connect-pre53", "legacy-failed-step-pre53", "legacy-schema-proof",
  "legacy-connect53", "legacy-failed-step-gen0", "terminal-connect", "terminal-tenant-setup",
  "terminal-t1", "terminal-t3a", "terminal-t3b", "terminal-t3c", "terminal-t3d",
  "terminal-t3d-seal", "terminal-t3d-receipts", "terminal-t3e",
  "terminal-t3f", "terminal-proof", "active-connect", "active-journal", "active-lifecycle",
  "active-capture-activation", "active-tenant-setup", "active-source-fixture", "active-source-commit",
  "active-source-claim", "active-source-reserve", "active-source-write", "active-source-ack",
  "active-source-finish", "active-t1", "active-t1-proof",
] as const;
const WRITER_CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE",
  "ER_PARSE_ERROR", "ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const WRITER_NAMES = ["other", "Error", "TypeError", "RangeError", "AssertionError",
  "PersistedProviderCaptureConflictError", "PersistedProviderCaptureIntegrityError",
  "TenantErasureIntegrityError", "TenantPurgePlanNotReadyError", "TenantPurgePlanEvidenceChangedError",
  "TenantPurgeExecutionNotReadyError", "TenantPurgeExecutionEvidenceChangedError",
  "TenantDatabasePurgeNotReadyError", "TenantDatabasePurgeEvidenceChangedError",
  "TenantRestoreJournalPublicationDependencyPendingError"] as const;
let stage: typeof WRITER_STAGES[number] = "input";
function safeDiagnosticField(error: unknown, field: "name" | "code", allowed: readonly string[], fallback: string): string {
  try {
    if (typeof error !== "object" || error === null || !(field in error)) return fallback;
    const value: unknown = (error as Record<string, unknown>)[field];
    return typeof value === "string" && allowed.includes(value) ? value : "other";
  } catch { return "other"; }
}
const token = (prefix: string) => `${prefix}-${randomUUID()}`;
function required<T>(value: T | null | undefined, stage: string): T {
  if (value === null || value === undefined) throw new Error(`frozen 0053 fixture missing ${stage}`);
  return value;
}
const policy: RetentionPolicyDocumentV1 = {
  sessionContentRetentionMs: 0, userErasureGraceMs: 0,
  operationalUsageRetentionMs: 0, idempotencyReceiptRetentionMs: 0,
  billingFactRetentionMs: null, lifecycleAuditRetentionMs: null,
  exportArtifactTtlMs: 60_000,
};
async function tenantSetup(store: MysqlSessionStore, tenantId: string) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({ tenantId, policyVersion: "pre0054-zero-day", policy,
    actorKeyId: "frozen-fixture-admin", atMs: Date.now() });
  await store.activateRetentionPolicy({ tenantId, policyVersion: "pre0054-zero-day",
    expectedControlGeneration: 0, actorKeyId: "frozen-fixture-admin", atMs: Date.now() });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
}
function fleetProof(claim: TenantRuntimeRevocationClaim) {
  // Explicit non-production protocol fixture, not a real fleet-stopped/HTTP proof.
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://frozen-0053-fixture.internal:8080"),
    runnerId: "frozen-0053-fixture", bootId: "fixture-boot",
    requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 0, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 0, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 0, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return { targets, fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets) };
}
async function legacy() {
  const through0052 = process.env.PRE0054_THROUGH0052_DIR;
  if (!through0052) throw new Error("legacy-schema fixture requires its isolated migration directory");
  const tenantId = token("tenant-frozen53-legacy");
  const userId = token("user-frozen53-legacy");
  stage = "legacy-connect-pre53";
  let store = await MysqlSessionStore.connect({ url: url!, migrationsDir: through0052,
    tenantTelemetryRefKey: captureRefKey });
  const legacyProof = await (async () => {
    try {
      stage = "legacy-failed-step-pre53";
      const pre53 = await uncapturedStepFixture(store, { tenantId, userId });
      const result = await store.commit(pre53.batch);
      if (result.lastSeq !== 4) throw new Error("legacy-schema failed-step cursor differed");
      stage = "legacy-schema-proof";
      const conn = await mysql.createConnection(url!);
      try {
        const [columns] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN ('items','events') AND column_name IN ('telemetry_failure_classification','telemetry_capture_v2_control_generation')");
        const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY name");
        const [triggers] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
        const legacyPrivateColumnCount = Number(columns[0]?.n);
        const legacyLastMarker = String(markers.at(-1)?.name);
        const legacyTriggerCount = Number(triggers[0]?.n);
        if (legacyPrivateColumnCount !== 0 || legacyLastMarker !== "0052_ordinary_session_usage_retention.sql"
          || legacyTriggerCount !== 647) throw new Error("actual pre53 schema projection differed");
        return { pre53, legacyPrivateColumnCount, legacyLastMarker, legacyTriggerCount };
      } finally { await conn.end(); }
    } finally { await store.close(); }
  })();
  stage = "legacy-connect53";
  store = await MysqlSessionStore.connect({ url: url!, tenantTelemetryRefKey: captureRefKey });
  try {
    stage = "legacy-failed-step-gen0";
    const aware = await uncapturedStepFixture(store, { tenantId, userId });
    if ((await store.commit(aware.batch)).lastSeq !== 4) throw new Error("inactive 0053 cursor differed");
    return { mode: "legacy", sourceCommit: SOURCE_COMMIT, tenantId, userId,
      pre53: legacyProof.pre53.lookup, gen0: aware.lookup,
      legacyPrivateColumnCount: legacyProof.legacyPrivateColumnCount,
      legacyLastMarker: legacyProof.legacyLastMarker, legacyTriggerCount: legacyProof.legacyTriggerCount,
      frozenBinaryVersion: "0053-aware", legacySchemaVersion: "0052",
      externalDispositionExecuted: false, productionAccepted: false };
  } finally { await store.close(); }
}
async function terminal() {
  stage = "terminal-connect";
  const store = await MysqlSessionStore.connect({ url: url!, tenantTelemetryRefKey: captureRefKey });
  const tenantId = token("tenant-frozen53-terminal");
  const requestId = newErasureRequestId();
  try {
    stage = "terminal-tenant-setup";
    await tenantSetup(store, tenantId);
    stage = "terminal-t1";
    await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "frozen-fixture-admin",
      idempotencyKey: token("pre54-terminal"), requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
    stage = "terminal-t3a";
    const a = required((await store.claimTenantCredentialRevocations({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3a") })).find((row) => row.requestId === requestId), "T3a claim");
    required(await store.revokeTenantCredentialMaterial({ requestId, tenantId,
      subjectGeneration: a.subjectGeneration, claimAttempt: a.claimAttempt, claimToken: a.claimToken }), "T3a receipt");
    stage = "terminal-t3b";
    await store.materializeTenantRuntimeRevocationJobs({ limit: 1 });
    const b = required((await store.claimTenantRuntimeRevocations({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3b") })).find((row) => row.requestId === requestId), "T3b claim");
    required(await store.completeTenantRuntimeRevocation({ requestId, tenantId,
      subjectGeneration: b.subjectGeneration, claimAttempt: b.claimAttempt, claimToken: b.claimToken }, fleetProof(b)), "T3b receipt");
    stage = "terminal-t3c";
    await store.materializeTenantContentInventoryJobs({ limit: 1 });
    const c = required((await store.claimTenantContentInventories({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3c") })).find((row) => row.requestId === requestId), "T3c claim");
    const ca = { requestId, tenantId, subjectGeneration: c.subjectGeneration,
      buildGeneration: c.buildGeneration, claimAttempt: c.claimAttempt, claimToken: c.claimToken };
    let done = false;
    for (let page = 0; page < 20; page += 1) {
      if ((await store.buildTenantContentInventoryPage(ca, { limit: 100 })).done) { done = true; break; }
    }
    if (!done) throw new Error("frozen 0053 inventory pagination budget exhausted");
    required(await store.sealTenantContentInventory(ca), "T3c receipt");
    stage = "terminal-t3d";
    await store.materializeTenantPurgePlanJobs({ limit: 1 });
    const d = required((await store.claimTenantPurgePlans({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3d") })).find((row) => row.requestId === requestId), "T3d claim");
    const da = { requestId, tenantId, subjectGeneration: d.subjectGeneration,
      buildGeneration: d.buildGeneration, claimAttempt: d.claimAttempt, claimToken: d.claimToken };
    // Use the frozen binary's official atomic seal, not the deprecated page
    // builder. This bounded fixture delay observes its existing DB-time floor;
    // no product predicate, claim duration, or migration timeout is changed.
    stage = "terminal-t3d-seal";
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const plan = required(await store.sealTenantPurgePlan(da), "T3d receipt");
    stage = "terminal-t3d-receipts";
    const source = required(await store.getTenantTelemetrySourceAccountingReceipt(tenantId, requestId), "0040 receipt");
    const manifest = required(await store.getTenantTelemetryTargetManifestReceipt(tenantId, requestId), "0041 receipt");
    const catalog = required(await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, requestId), "0042 receipt");
    stage = "terminal-t3e";
    await store.materializeTenantPurgeExecutionJobs({ limit: 1 });
    const e = required((await store.claimTenantPurgeExecutions({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3e") })).find((row) => row.requestId === requestId), "T3e claim");
    const ea = { requestId, tenantId, subjectGeneration: e.subjectGeneration,
      planBuildGeneration: e.planBuildGeneration, executionGeneration: e.executionGeneration,
      claimAttempt: e.claimAttempt, claimToken: e.claimToken };
    required(await store.executeTenantPurgeLocalCutover(ea), "T3e cutover");
    // No Blob/export target or external object exists in this zero-source fixture.
    required(await store.sealTenantPurgeLocalPhysicalAcks(ea), "T3e physical receipt");
    stage = "terminal-t3f";
    await store.materializeTenantDatabasePurgeJobs({ limit: 1 });
    const f = required((await store.claimTenantDatabasePurges({ limit: 1, leaseMs: 120_000,
      claimToken: token("t3f") })).find((row) => row.requestId === requestId), "T3f claim");
    const fa = { requestId, tenantId, subjectGeneration: f.subjectGeneration,
      planBuildGeneration: f.planBuildGeneration, executionGeneration: f.executionGeneration,
      databasePurgeGeneration: f.databasePurgeGeneration, claimAttempt: f.claimAttempt, claimToken: f.claimToken };
    const receipt = required(await store.executeTenantDatabasePurge(fa), "T3f receipt");
    const closure = required(await store.getTenantTelemetryOwnerClosureReceipt(tenantId, requestId), "0039 closure");
    stage = "terminal-proof";
    if (!receipt.localDatabasePurgeComplete || receipt.allDomainsComplete || receipt.contentPurgeExecuted
      || source.entryCount !== 0 || catalog.targetCount !== 0 || closure.entryCount !== 0) {
      throw new Error("frozen 0053 zero-source terminal proof differed");
    }
    return { mode: "terminal", sourceCommit: SOURCE_COMMIT, tenantId, requestId,
      planReceiptSha256: plan.receiptSha256, sourceReceiptSha256: source.receiptSha256,
      manifestReceiptSha256: manifest.receiptSha256, catalogReceiptSha256: catalog.receiptSha256,
      terminalReceiptSha256: receipt.receiptSha256, closureReceiptSha256: closure.receiptSha256,
      allDomainsComplete: false, externalDispositionExecuted: false, productionAccepted: false };
  } finally { await store.close(); }
}
async function active() {
  stage = "active-connect";
  const store = await MysqlSessionStore.connect({ url: url!, tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  try {
    stage = "active-journal";
    const target = { targetOrdinal: 0, targetSha256: "1".repeat(64), failureDomainSha256: "2".repeat(64),
      adapterProtocol: "memory-restore-journal-v1", journalNamespaceSha256: "3".repeat(64) };
    await store.activateTenantRestoreJournalControl({ adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256, logicalDatabaseNamespaceSha256: "4".repeat(64),
      runtimeEpochSha256: "5".repeat(64), targets: [target], observedHeads: [{ ...target,
        logicalDatabaseNamespaceSha256: "4".repeat(64), sealedRemoteSequence: 0,
        sealedHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 }] });
    stage = "active-lifecycle";
    await store.activateTenantTelemetryLifecycle({ expectedControlGeneration: 0,
      targets: (["logs", "traces"] as const).map((domain) => ({ domain,
        ...s3TenantTelemetryTargetIdentity({ namespaceId: "frozen0053-history",
          failureDomainId: "local-ack-fixture-no-external-sink", bucket: "frozen0053-history",
          prefix: "capture", region: "us-east-1", endpoint: null, forcePathStyle: false, domain }) })) });
    const lifecycle = await store.getTenantTelemetryLifecycleControl();
    if (lifecycle.state !== "active") throw new Error("frozen 0053 lifecycle activation missing");
    const logs = required((await store.listTenantTelemetryLifecycleTargets()).find((row) => row.domain === "logs"), "logs target");
    stage = "active-capture-activation";
    await store.withTenantTelemetryCaptureOperatorFence((fence) => store.activateTenantTelemetryPersistedProviderCapture({
      expectedControlGeneration: 0, lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
      logsTargetSha256: logs.targetSha256, logsTargetReceiptSha256: logs.receiptSha256,
      configuredFleetRootSha256: "6".repeat(64), fleetStoppedAck: "fleet-stopped-v1",
      legacyWritersDrainedAck: "legacy-writers-drained-v1", producerReadyAck: "provider-step-error-v2-ready-v1",
      localOnlyAck: "local-only-v1",
    }, fence), { timeoutMs: 5_000 });
    const tenantId = token("tenant-frozen53-active"), userId = token("user-frozen53-active");
    stage = "active-tenant-setup";
    await tenantSetup(store, tenantId);
    let actualFixtureAckCount = 0;
    const sources: { mode: string; sessionId: string; turnId: string; itemId: string; stepIndex: number; writeOperationSha256: string }[] = [];
    // Claim reserved before creating the unclaimed pending row: LIMIT 1 must
    // select the requested operation, not incidentally lease another source.
    for (const state of ["written", "reserved", "pending"] as const) {
      stage = "active-source-fixture";
      const capture = await captureStepFixture(store, { tenantId, userId });
      stage = "active-source-commit";
      const committed = await store.commitPersistedProviderStepFailure(capture.input);
      if (state !== "pending") {
        stage = "active-source-claim";
        const claim = required((await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
          claimToken: token("source-write"), adapterProtocol: "telemetry-s3-object-v1",
          captureMode: "include_v2", freshProof: capture.proof })).find((row) =>
          row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256), "source writer claim");
        const auth = { tenantId, writeOperationSha256: claim.writeOperationSha256,
          claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
        stage = "active-source-reserve";
        required(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", capture.proof), "write reservation");
        if (state === "written") {
          const input = { writeOperationSha256: claim.writeOperationSha256, target: claim.target,
            inventory: claim.inventory, payload: claim.payload };
          // This ACK fixture exercises the actual frozen store protocol/closure.
          // It never writes/reads bytes, calls S3/MinIO, or proves a durable sink.
          stage = "active-source-write";
          const result = tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", input, "already_present", true);
          stage = "active-source-ack";
          required(await store.completeTenantTelemetryWrite(auth, result, capture.proof), "written ACK");
          actualFixtureAckCount += 1;
        }
      }
      stage = "active-source-finish";
      await store.commit({ sessionId: capture.session.id, fence: 1,
        turn: { ...capture.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
        sessionPatch: { status: { type: "idle" } } });
      sources.push({ mode: state, ...capture.lookup,
        writeOperationSha256: committed.failureCommitReceipt.writeOperationSha256 });
    }
    const requestId = newErasureRequestId();
    let publicationPending = false;
    try {
      stage = "active-t1";
      await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "frozen-fixture-admin",
        idempotencyKey: token("pre54-active"), requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
    } catch (error) {
      if (!(error instanceof TenantRestoreJournalPublicationDependencyPendingError)) throw error;
      publicationPending = true;
    }
    stage = "active-t1-proof";
    required(await store.getTenantErasureRequest(tenantId, requestId), "durable old active T1");
    required(await store.getTenantCredentialRevocationFence(tenantId, requestId), "durable old active T1 fence");
    return { mode: "active", sourceCommit: SOURCE_COMMIT, tenantId, userId, requestId, sources,
      publicationPending, sourceSink: "local-store-ack-fixture", sourceSinkDurable: false,
      actualSinkWriteCount: 0, actualFixtureAckCount, externalDispositionExecuted: false,
      freshFleetHttpProven: false, productionAccepted: false };
  } finally { await store.close(); }
}
try {
  const result = mode === "legacy" ? await legacy() : mode === "terminal" ? await terminal() : await active();
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  // Fixed enumerated diagnostics only: never echo a message, stack, SQL/DSN,
  // parameters, key, provider content, child environment or nested error cause.
  process.stderr.write(`pre0054-frozen-writer-diagnostic:${JSON.stringify({
    schema: "pre0054-frozen-writer-diagnostic-v1", stage,
    code: safeDiagnosticField(error, "code", WRITER_CODES, "none"),
    name: safeDiagnosticField(error, "name", WRITER_NAMES, "other"),
  })}\n`);
  process.exitCode = 1;
}
