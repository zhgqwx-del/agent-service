import { createHash, randomUUID } from "node:crypto";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { MysqlSessionStore,
  newErasureRequestId, tenantErasureRequestHash, tenantTelemetryWriteAdapterResult,
  type RetentionPolicyDocumentV1 } from "@agent-service/store";
import { activateCaptureFixture, captureRefKey, captureStepFixture, uncapturedStepFixture } from "../persisted-provider-capture.fixture.js";

// Copied into this exact published archive. All product/helper imports resolve
// inside it; this driver never imports current 0055 code or a live source tree.
const SOURCE_COMMIT = "2932318f31a75e5a8f328165b2daf436f4ec5bc1";
const STAGES = ["input", "connect", "legacy", "activate", "tenant", "source", "claim", "reserve", "ack", "finish", "t1", "proof",
  "proof-schema", "proof-legacy", "proof-phases", "proof-publication"] as const;
const CODES = ["none", "other", "ER_SIGNAL_EXCEPTION", "ER_BAD_FIELD_ERROR", "ER_NO_SUCH_TABLE", "ER_DUP_ENTRY", "ER_PARSE_ERROR",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"] as const;
const NAMES = ["other", "Error", "TypeError", "RangeError", "PersistedProviderCaptureIntegrityError", "PersistedProviderCaptureConflictError",
  "TenantErasureIntegrityError", "TenantRestoreJournalPublicationDependencyPendingError"] as const;
let stage: typeof STAGES[number] = "input";
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const token = (prefix: string) => `${prefix}-${randomUUID()}`;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("frozen 0054 fixture evidence missing");
  return value;
}
function diagnostic(error: unknown, field: "code" | "name", allowed: readonly string[], absent: string): string {
  try {
    if (typeof error !== "object" || error === null || !(field in error)) return absent;
    const value: unknown = (error as Record<string, unknown>)[field];
    return typeof value === "string" && allowed.includes(value) ? value : "other";
  } catch { return "other"; }
}
function count(value: unknown): number {
  if (!(typeof value === "number" || typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) throw new Error("fixture count invalid");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("fixture count invalid");
  return n;
}
const policy: RetentionPolicyDocumentV1 = {
  sessionContentRetentionMs: 0, userErasureGraceMs: 0, operationalUsageRetentionMs: 0,
  idempotencyReceiptRetentionMs: 0, billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: 60_000,
};
async function run() {
  const url = process.env.MYSQL_URL;
  const mode = process.env.PRE0055_FIXTURE_MODE;
  if (!url || mode !== "active" && mode !== "inactive") throw new Error("frozen 0054 fixture inputs invalid");
  const address = new URL(url);
  if (address.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    || !/^agent_service_migration_test_0055_[0-9]+_[0-9a-f]{8}$/.test(decodeURIComponent(address.pathname.slice(1)))) {
    throw new Error("frozen 0054 fixture database invalid");
  }
  stage = "connect";
  const store = await MysqlSessionStore.connect({ url, tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  let conn: Awaited<ReturnType<typeof mysql.createConnection>> | undefined;
  try {
    stage = "legacy";
    const legacy = await uncapturedStepFixture(store, { tenantId: token("legacy-tenant"), userId: token("legacy-user") });
    await store.commit(legacy.batch);
    await store.commit({ sessionId: legacy.session.id, fence: 1,
      turn: { ...legacy.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
      sessionPatch: { status: { type: "idle" } } });
    let activationReceiptSha256: string | null = null;
    let retainedT1ReceiptSha256: string | null = null;
    let publicationPending = false;
    let actualFixtureAckCount = 0;
    if (mode === "active") {
      stage = "activate";
      // In-process journal/fleet and ACK protocol fixture, not a real stopped
      // fleet, S3 write, external sink, encrypted backup or production proof.
      await activateCaptureFixture(store);
      activationReceiptSha256 = required(await store.getTenantTelemetryPersistedProviderCaptureActivationReceipt()).receiptSha256;
      await store.activateBlobStorageControl({ expectedControlGeneration: 0,
        storageBackend: "s3v1-frozen0054-fixture", namespaceSha256: h("frozen0054-blob") });
      const journal = await store.getTenantRestoreJournalControl();
      if (journal.controlGeneration !== 1) throw new Error("frozen journal missing");
      await store.activateTenantBackupCatalogControl({ expectedControlGeneration: 0,
        adapterProtocol: "mysql-authoritative-backup-catalog-v1", catalogNamespaceSha256: h("frozen0054-catalog"),
        catalogTargetSha256: h("frozen0054-catalog-target"), failureDomainSha256: h("frozen0054-catalog-domain"),
        logicalDatabaseNamespaceSha256: journal.logicalDatabaseNamespaceSha256, journalControlEvidenceSha256: journal.evidenceSha256,
        retentionPolicySha256: h("frozen0054-backup-retention"), minimumRetentionMs: 60_000, minimumRecoverableBackups: 1 });
      stage = "tenant";
      const tenantId = token("active-tenant"), userId = token("active-user");
      await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
      await store.putRetentionPolicy({ tenantId, policyVersion: "frozen0054-zero-day", policy,
        actorKeyId: "frozen-fixture-admin", atMs: Date.now() });
      await store.activateRetentionPolicy({ tenantId, policyVersion: "frozen0054-zero-day", expectedControlGeneration: 0,
        actorKeyId: "frozen-fixture-admin", atMs: Date.now() });
      await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
      // Create the unclaimed job last so LIMIT 1 cannot accidentally claim it.
      for (const phase of ["written", "reserved", "queued"] as const) {
        stage = "source";
        const source = await captureStepFixture(store, { tenantId, userId });
        const committed = await store.commitPersistedProviderStepFailure(source.input);
        if (phase !== "queued") {
          stage = "claim";
          const claim = required((await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 120_000,
            claimToken: token("capture-claim"), adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2",
            freshProof: source.proof })).find((row) => row.writeOperationSha256 === committed.failureCommitReceipt.writeOperationSha256));
          const auth = { tenantId, writeOperationSha256: claim.writeOperationSha256, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken };
          stage = "reserve";
          required(await store.reserveTenantTelemetryExternalMutation(auth, "telemetry-s3-object-v1", source.proof));
          if (phase === "written") {
            stage = "ack";
            // No adapter create/read occurs: this only exercises the frozen
            // store's exact reservation/ACK transition and durable SQL rows.
            required(await store.completeTenantTelemetryWrite(auth, tenantTelemetryWriteAdapterResult("telemetry-s3-object-v1", {
              writeOperationSha256: claim.writeOperationSha256, target: claim.target, inventory: claim.inventory, payload: claim.payload,
            }, "already_present", true), source.proof));
            actualFixtureAckCount += 1;
          }
        }
        stage = "finish";
        await store.commit({ sessionId: source.session.id, fence: 1,
          turn: { ...source.batch.turn!, status: "failed", stopReason: "error", completedAtMs: Date.now() },
          sessionPatch: { status: { type: "idle" } } });
      }
      stage = "t1";
      const requestId = newErasureRequestId();
      await store.requestTenantErasure({ requestId, tenantId, requestedByKeyId: "frozen-fixture-admin",
        idempotencyKey: token("frozen0054-erasure"), requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now() });
      // The store returns the committed admission; the HTTP/service boundary
      // owns retryable publication errors. Prove the real queued SQL job rather
      // than expecting this lower-level API to throw an HTTP-style exception.
      publicationPending = required(await store.getTenantRestoreJournalPublicationJob(tenantId, requestId)).phase === "queued";
      required(await store.getTenantErasureRequest(tenantId, requestId));
      retainedT1ReceiptSha256 = required(await store.getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId, requestId)).receiptSha256;
    }
    stage = "proof";
    conn = await mysql.createConnection(url);
    const [markers] = await conn.query<RowDataPacket[]>("SELECT name FROM schema_migrations ORDER BY BINARY name");
    const [triggers] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM information_schema.triggers WHERE trigger_schema=DATABASE()");
    const [legacyRows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM items WHERE type='agentMessage' AND status='failed' AND (telemetry_capture_v2_control_generation IS NULL OR telemetry_capture_v2_control_generation=0)");
    const [jobs] = await conn.query<RowDataPacket[]>(`SELECT COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NULL THEN 1 END) AS queued,
      COUNT(CASE WHEN phase='queued' AND mutation_reservation_receipt_sha256 IS NOT NULL THEN 1 END) AS reserved,
      COUNT(CASE WHEN phase='written' THEN 1 END) AS written FROM tenant_telemetry_write_jobs`);
    if (jobs.length !== 1) throw new Error("frozen source phase proof missing");
    const sourceCounts = { queued: count(jobs[0]!.queued), reserved: count(jobs[0]!.reserved), written: count(jobs[0]!.written) };
    const [operations] = await conn.query<RowDataPacket[]>("SELECT write_operation_sha256 FROM tenant_telemetry_write_jobs ORDER BY BINARY write_operation_sha256");
    if (operations.some((row) => typeof row.write_operation_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.write_operation_sha256))) {
      throw new Error("frozen source operation proof invalid");
    }
    const marker = markers.at(-1)?.name;
    stage = "proof-schema";
    if (marker !== "0054_tenant_telemetry_retained_source.sql" || count(triggers[0]?.n) !== 712) throw new Error("frozen schema proof differed");
    stage = "proof-legacy";
    if (count(legacyRows[0]?.n) !== 1) throw new Error("frozen legacy proof differed");
    stage = "proof-phases";
    if ((mode === "active" && Object.values(sourceCounts).some((n) => n !== 1))
      || (mode === "inactive" && Object.values(sourceCounts).some((n) => n !== 0))) throw new Error("frozen phase proof differed");
    stage = "proof-publication";
    if (mode === "active" && (!publicationPending || !retainedT1ReceiptSha256)) throw new Error("frozen publication proof differed");
    // Closed, content-free stdout: never emit tenant/user/session/item IDs,
    // payload/error text, URL, credentials or key material, even for diagnostics.
    return { scope: "frozen0054-upgrade-history-v1", sourceCommit: SOURCE_COMMIT, mode, marker, triggerCount: 712,
      legacyUnknownItemCount: 1, sourceCounts, activationReceiptSha256, retainedT1ReceiptSha256, publicationPending,
      sourceOperationRootSha256: h(`frozen0054-operation-root-v1\0${JSON.stringify(operations.map((row) => row.write_operation_sha256))}`),
      sourceSink: "local-store-ack-fixture", sourceSinkDurable: false, actualFixtureAckCount, actualSinkWriteCount: 0,
      externalDispositionExecuted: false, freshFleetHttpProven: false, productionAccepted: false };
  } finally { await conn?.end(); await store.close(); }
}
try { process.stdout.write(JSON.stringify(await run())); }
catch (error) {
  process.stderr.write(`pre0055-frozen-writer-diagnostic:${JSON.stringify({ schema: "pre0055-frozen-writer-diagnostic-v1", stage,
    code: diagnostic(error, "code", CODES, "none"), name: diagnostic(error, "name", NAMES, "other") })}\n`);
  process.exitCode = 1;
}
