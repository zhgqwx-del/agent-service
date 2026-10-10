import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type Item,
  type TenantRuntimeRevocationFleetProof,
  type Turn,
} from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  MysqlSessionStore,
  TenantErasureIntegrityError,
  TenantPurgeExecutionNotReadyError,
  TenantPurgeExecutionPhysicalAckDeadLetterError,
  USER_DATA_EXPORT_CONTENT_TYPE,
  legalHoldControlSha256,
  legalHoldProjectionSha256,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  tenantErasureRequestHash,
  tenantPurgeExecutionOperationSha256,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  type RetentionPolicyDocumentV1,
  type LegalHoldControlRecord,
  type LegalHoldRecord,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgeExecutionDomainAck,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
  type UserDataExportAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
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

function policy(): RetentionPolicyDocumentV1 {
  return {
    sessionContentRetentionMs: 0,
    userErasureGraceMs: 0,
    operationalUsageRetentionMs: 0,
    idempotencyReceiptRetentionMs: 0,
    billingFactRetentionMs: 0,
    lifecycleAuditRetentionMs: 0,
    exportArtifactTtlMs: 60_000,
  };
}

function credentialAuthorization(
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

function runtimeAuthorization(
  claim: TenantRuntimeRevocationClaim,
): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function inventoryAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantContentInventories"]>>[number],
): TenantContentInventoryAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function planAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgePlans"]>>[number],
): TenantPurgePlanAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function executionAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantPurgeExecutions"]>>[number],
): TenantPurgeExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://mysql-execution-runner.internal:8080"),
    runnerId: "mysql-execution-runner",
    bootId: "mysql-execution-boot",
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 1,
    cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1,
    activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1,
    activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

async function installPolicy(store: MysqlSessionStore, tenantId: string): Promise<void> {
  const atMs = Date.now();
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(),
    actorKeyId: "policy-admin",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "policy-admin",
    atMs: atMs + 1,
  });
}

async function databaseNow(conn: Connection): Promise<number> {
  const [rows] = await conn.query<(RowDataPacket & { now_ms: number })[]>(
    "SELECT CAST(ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS UNSIGNED) AS now_ms",
  );
  return Number(rows[0]?.now_ms);
}

async function injectCanonicalTenantHold(
  conn: Connection,
  tenantId: string,
  holdId: string,
): Promise<void> {
  await conn.beginTransaction();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT control_generation, active_hold_count, active_projection_sha256, updated_at_ms
         FROM legal_hold_controls
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
      [tenantId, tenantId],
    );
    const row = rows[0];
    const before: LegalHoldControlRecord = row
      ? {
          tenantId,
          subjectKind: "tenant",
          subjectId: tenantId,
          controlGeneration: Number(row.control_generation),
          activeHoldCount: Number(row.active_hold_count),
          activeProjectionSha256: String(row.active_projection_sha256),
          updatedAtMs: Number(row.updated_at_ms),
        }
      : {
          tenantId,
          subjectKind: "tenant",
          subjectId: tenantId,
          controlGeneration: 0,
          activeHoldCount: 0,
          activeProjectionSha256: legalHoldProjectionSha256([]),
          updatedAtMs: 0,
        };
    if (!row) {
      await conn.query(
        `INSERT INTO legal_hold_controls
           (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
            active_projection_sha256, updated_at_ms)
         VALUES (?,'tenant',?,0,0,?,0)`,
        [tenantId, tenantId, before.activeProjectionSha256],
      );
    }
    const atMs = Math.max(before.updatedAtMs, await databaseNow(conn));
    const hold: LegalHoldRecord = {
      tenantId,
      holdId,
      subjectKind: "tenant",
      subjectId: tenantId,
      state: "active",
      reasonCode: "litigation",
      createdControlGeneration: before.controlGeneration + 1,
      createdByKeyId: "execution-legal-admin",
      createdAtMs: atMs,
    };
    const after: LegalHoldControlRecord = {
      tenantId,
      subjectKind: "tenant",
      subjectId: tenantId,
      controlGeneration: hold.createdControlGeneration,
      activeHoldCount: before.activeHoldCount + 1,
      activeProjectionSha256: legalHoldProjectionSha256([hold]),
      updatedAtMs: atMs,
    };
    await conn.query(
      `INSERT INTO legal_holds
         (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
          external_reference_sha256, created_control_generation, created_by_key_id,
          created_at_ms, released_control_generation, released_by_key_id, released_at_ms,
          release_reason_code)
       VALUES (?,?,'tenant',?,'active','litigation',NULL,?,?,?,NULL,NULL,NULL,NULL)`,
      [tenantId, holdId, tenantId, hold.createdControlGeneration, hold.createdByKeyId, atMs],
    );
    await conn.query(
      `UPDATE legal_hold_controls
          SET control_generation=?, active_hold_count=?, active_projection_sha256=?,
              updated_at_ms=?
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?
          AND control_generation=?`,
      [
        after.controlGeneration,
        after.activeHoldCount,
        after.activeProjectionSha256,
        atMs,
        tenantId,
        tenantId,
        before.controlGeneration,
      ],
    );
    await conn.query(
      `UPDATE subject_lifecycle SET legal_hold_at_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
      [atMs, atMs, tenantId, tenantId],
    );
    await conn.query(
      `INSERT INTO legal_hold_events
         (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type,
          reason_code, external_reference_sha256, actor_key_id, before_sha256,
          after_sha256, emitted_at_ms)
       VALUES (?,'tenant',?,?,?,'legal_hold/set','litigation',NULL,?,?,?,?)`,
      [
        tenantId,
        tenantId,
        after.controlGeneration,
        holdId,
        hold.createdByKeyId,
        legalHoldControlSha256(before),
        legalHoldControlSha256(after),
        atMs,
      ],
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

async function advanceToExecutionClaim(
  store: MysqlSessionStore,
  tenantId: string,
  userId: string,
  options: {
    leaseMs?: number;
    beforeTenantErasure?: (session: ReturnType<typeof mkSession>) => Promise<void>;
  } = {},
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId);
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  await options.beforeTenantErasure?.(session);
  if ((await store.readTenantCredentialTrackingCutover()).controlGeneration === 0) {
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  }
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "platform-lifecycle-admin",
    idempotencyKey: `tenant-execution-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `credential-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!credential) throw new Error("missing T3a claim");
  if (!await store.revokeTenantCredentialMaterial(credentialAuthorization(credential))) {
    throw new Error("missing T3a receipt");
  }
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `runtime-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!runtime) throw new Error("missing T3b claim");
  if (!await store.completeTenantRuntimeRevocation(runtimeAuthorization(runtime), fleetProof(runtime))) {
    throw new Error("missing T3b receipt");
  }
  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const inventory = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `inventory-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!inventory) throw new Error("missing T3c claim");
  const inventoryAuth = inventoryAuthorization(inventory);
  let inventoryDone = false;
  while (!inventoryDone) {
    inventoryDone = (await store.buildTenantContentInventoryPage(
      inventoryAuth,
      { limit: 100 },
    )).done;
  }
  if (!await store.sealTenantContentInventory(inventoryAuth)) {
    throw new Error("missing T3c receipt");
  }
  expect(await store.materializeTenantPurgePlanJobs({ limit: 10 })).toBe(1);
  const plan = (await store.claimTenantPurgePlans({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `plan-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!plan) throw new Error("missing T3d claim");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!await store.sealTenantPurgePlan(planAuthorization(plan))) {
    throw new Error("missing T3d receipt");
  }
  expect(await store.materializeTenantPurgeExecutionJobs({ limit: 10 })).toBe(1);
  const claim = (await store.claimTenantPurgeExecutions({
    limit: 10,
    leaseMs: options.leaseMs ?? 120_000,
    claimToken: `execution-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing T3e claim");
  return {
    requestId,
    session,
    claim,
    authorization: executionAuthorization(claim),
  };
}

async function claimUserDataExport(
  store: MysqlSessionStore,
  requestId: string,
): Promise<UserDataExportAuthorization> {
  const claim = (await store.claimUserDataExports({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `execution-export-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing user export claim");
  return userDataExportAuthorization(claim);
}

async function publishReadyUserDataExport(
  store: MysqlSessionStore,
  authorization: UserDataExportAuthorization,
): Promise<string> {
  const summary = await store.captureAndSealUserDataExportSnapshot(authorization);
  const artifactId = newUserDataExportArtifactId();
  await store.startUserDataExportArtifact(authorization, {
    artifactId,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    stagingTtlMs: 60_000,
  });
  const storageKey = userDataExportStorageKey(
    { tenantId: authorization.tenantId, userId: authorization.userId },
    authorization.requestId,
    artifactId,
    0,
  );
  await store.stageUserDataExportPart(authorization, {
    artifactId,
    partNumber: 0,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey,
    uploadToken: `upload-${randomUUID()}`,
  });
  const bytes = Buffer.from(`tenant-execution-export:${authorization.requestId}\n`, "utf8");
  const part = await store.markUserDataExportPartUploaded(authorization, {
    artifactId,
    partNumber: 0,
    descriptor: {
      storageKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    },
  });
  await store.completeUserDataExportArtifact(authorization, {
    artifactId,
    snapshotAtMs: summary.snapshotAtMs,
    partCount: 1,
    recordCount: summary.recordCount,
    totalSizeBytes: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    manifestSha256: userDataExportManifestSha256([part]),
  });
  return artifactId;
}

async function installUsageAndBlobs(
  store: MysqlSessionStore,
  conn: Connection,
  session: ReturnType<typeof mkSession>,
  options: { existingOutbox?: boolean; readyExport?: boolean } = {},
) {
  const now = Date.now();
  const stage = async (expired: boolean) => {
    const blobId = newId("blob");
    await store.stageBlob({
      owner: { tenantId: session.tenantId, userId: session.userId },
      sessionId: session.id,
      fence: 1,
      blobId,
      purpose: "tool_output",
      storageBackend: "memory-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${blobId.slice("blob_".length)}`,
      uploadToken: `upload-${blobId.slice("blob_".length)}`,
      createdAtMs: now - 2_000,
      stagingExpiresAtMs: expired ? now - 1_000 : now + 120_000,
    });
    return blobId;
  };
  const freshBlobId = await stage(false);
  let existingBlobId: string | undefined;
  let existingOutboxId: number | undefined;
  if (options.existingOutbox) {
    existingBlobId = await stage(true);
    expect(await store.scheduleStaleBlobDeletes({ nowMs: now, limit: 10 })).toBe(1);
    const [rows] = await conn.query<(RowDataPacket & { outbox_id: number })[]>(
      `SELECT outbox_id FROM blob_delete_outbox WHERE blob_id=?`,
      [existingBlobId],
    );
    existingOutboxId = Number(rows[0]?.outbox_id);
  }
  let exportRequestId: string | undefined;
  let pinnedExportRequestId: string | undefined;
  let artifactId: string | undefined;
  let downloadLeaseToken: string | undefined;
  if (options.readyExport) {
    const uploadToken = `upload-${freshBlobId.slice("blob_".length)}`;
    await store.markBlobUploaded({
      owner: { tenantId: session.tenantId, userId: session.userId },
      sessionId: session.id,
      fence: 1,
      blobId: freshBlobId,
      uploadToken,
      sha256: "a".repeat(64),
      sizeBytes: 128,
      contentType: "application/json",
      uploadedAtMs: now + 1,
    });
    const turn: Turn = {
      id: newId("turn"),
      sessionId: session.id,
      status: "inProgress",
      seqStart: 2,
      steps: 1,
      toolCalls: 1,
      usage: emptyUsage(),
      startedAtMs: now + 2,
      idempotencyKey: `execution-export-attachment-${randomUUID()}`,
    };
    const item: Item = {
      id: newId("item"),
      sessionId: session.id,
      turnId: turn.id,
      seq: 3,
      step: 1,
      status: "completed",
      createdAtMs: now + 3,
      completedAtMs: now + 4,
      type: "toolResult",
      toolCallId: "call-tenant-execution-export",
      name: "large_output",
      content: [],
      isError: false,
      outputRef: freshBlobId,
    };
    await store.commit({
      sessionId: session.id,
      fence: 2,
      turn,
      items: [item],
      blobBindings: [{ blobId: freshBlobId, itemId: item.id, purpose: "tool_output" }],
      events: [
        { type: "turn/started", sessionId: session.id, emittedAtMs: now + 3, turn },
        { type: "item/completed", sessionId: session.id, emittedAtMs: now + 4, item },
      ],
    });
    exportRequestId = newUserDataExportRequestId();
    await store.requestUserDataExport({
      requestId: exportRequestId,
      tenantId: session.tenantId,
      userId: session.userId,
      requestedByKeyId: "tenant-execution-export-admin",
      idempotencyKeySha256: userDataExportIdempotencyKeySha256(
        `tenant-execution-export-${randomUUID()}`,
      ),
      requestHash: userDataExportRequestHash(session.tenantId, session.userId),
    });
    const authorization = await claimUserDataExport(store, exportRequestId);
    artifactId = await publishReadyUserDataExport(store, authorization);
    downloadLeaseToken = `download-${randomUUID()}`;
    if (!await store.acquireUserDataExportDownload(
      session.tenantId,
      session.userId,
      exportRequestId,
      downloadLeaseToken,
      60_000,
    )) throw new Error("missing user export download lease");
    // Keep a second export at its sealed snapshot boundary. This gives T3e a live snapshot
    // record and attachment pin to release, while the first export supplies ready artifact bytes.
    pinnedExportRequestId = newUserDataExportRequestId();
    await store.requestUserDataExport({
      requestId: pinnedExportRequestId,
      tenantId: session.tenantId,
      userId: session.userId,
      requestedByKeyId: "tenant-execution-export-admin",
      idempotencyKeySha256: userDataExportIdempotencyKeySha256(
        `tenant-execution-pinned-export-${randomUUID()}`,
      ),
      requestHash: userDataExportRequestHash(session.tenantId, session.userId),
    });
    const pinnedAuthorization = await claimUserDataExport(store, pinnedExportRequestId);
    await store.captureAndSealUserDataExportSnapshot(pinnedAuthorization);
  }
  // Insert this compatibility row after export snapshotting: legacy operational usage may have
  // no turn owner, while the export snapshot deliberately requires canonical turn ownership.
  await conn.query(
    `INSERT INTO usage_ledger
       (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
        usage_json, created_at_ms)
     VALUES (NULL,?,?,?,?,1,'legacy-provider','legacy-model',?,?)`,
    [
      session.tenantId,
      session.userId,
      session.id,
      newId("turn"),
      JSON.stringify({ ...emptyUsage(), inputTokens: 7, outputTokens: 3, totalTokens: 10 }),
      now,
    ],
  );
  return {
    freshBlobId,
    existingBlobId,
    existingOutboxId,
    exportRequestId,
    pinnedExportRequestId,
    artifactId,
    downloadLeaseToken,
  };
}

function operationAction(ack: TenantPurgeExecutionDomainAck): string {
  if (ack.ackKind === "anonymized") return "anonymize";
  if (ack.ackKind === "blocker_resolution") return "schedule-delete";
  if (ack.ackKind === "outbox_scheduled") return "outbox-scheduled";
  if (ack.ackKind === "physical_delete") return "physical-delete";
  if (ack.domain === "user_export_control") return "revoke";
  if (ack.domain === "user_export_snapshots") return "release-pins";
  throw new Error("unexpected execution ACK");
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant purge execution", () => {
    let baseUrl: URL;
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_execution_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_execution_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe tenant purge execution test database name");
      }
      await admin!.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
      mysqlUrl = databaseUrl(baseUrl, database);
      const migrated = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 1 });
      await migrated.close();
    });

    afterEach(async () => {
      if (admin && database) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
      database = "";
      mysqlUrl = "";
    });

    afterAll(async () => {
      await admin?.end();
    });

    it("atomically cuts over exact local targets, replays response loss, and seals physical ACKs", async () => {
      const firstStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const secondStore = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-execution-success-${randomUUID()}`;
      const userId = `execution-user-${randomUUID()}`;
      let targets: Awaited<ReturnType<typeof installUsageAndBlobs>> | undefined;
      try {
        const source = await advanceToExecutionClaim(firstStore, tenantId, userId, {
          beforeTenantErasure: async (session) => {
            targets = await installUsageAndBlobs(firstStore, conn, session, {
              existingOutbox: true,
              readyExport: true,
            });
          },
        });
        if (!targets?.existingOutboxId || !targets.artifactId || !targets.exportRequestId) {
          throw new Error("missing local execution fixture");
        }
        const [sourceRows] = await conn.query<RowDataPacket[]>(
          `SELECT e.source_evidence_db_ms AS execution_source_ms,
                  p.source_evidence_db_ms AS plan_source_ms,
                  r.store_db_timestamp_ms AS plan_receipt_ms
             FROM tenant_purge_execution_jobs e
             JOIN tenant_purge_plan_jobs p ON p.request_id=e.request_id
             JOIN tenant_purge_plan_receipts r ON r.request_id=e.request_id
            WHERE e.request_id=?`,
          [source.requestId],
        );
        expect(Number(sourceRows[0]?.execution_source_ms))
          .toBe(Number(sourceRows[0]?.plan_receipt_ms));
        expect(Number(sourceRows[0]?.execution_source_ms))
          .not.toBe(Number(sourceRows[0]?.plan_source_ms));
        const [preCutoverRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM user_export_download_leases WHERE tenant_id=?) AS leases,
             (SELECT COUNT(*) FROM user_export_snapshot_blobs
               WHERE tenant_id=? AND released_at_ms IS NULL) AS unreleased_pins,
             (SELECT COUNT(*) FROM user_export_snapshot_records
               WHERE tenant_id=?) AS snapshot_rows,
             (SELECT COUNT(*) FROM user_export_artifact_parts p
               JOIN user_export_artifacts a ON a.artifact_id=p.artifact_id
               WHERE a.tenant_id=? AND p.state='uploaded') AS uploaded_parts`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(preCutoverRows[0]).toMatchObject({
          leases: 1,
          uploaded_parts: 1,
        });
        expect(Number(preCutoverRows[0]?.unreleased_pins)).toBeGreaterThan(0);
        expect(Number(preCutoverRows[0]?.snapshot_rows)).toBeGreaterThan(0);
        expect(await firstStore.getTenantPurgeExecutionDomains(
          tenantId,
          source.requestId,
          1,
        )).toHaveLength(33);
        expect(await firstStore.getTenantPurgeExecutionJob(
          `wrong-${tenantId}`,
          source.requestId,
        )).toBeNull();

        const [first, concurrentReplay] = await Promise.all([
          firstStore.executeTenantPurgeLocalCutover(source.authorization),
          secondStore.executeTenantPurgeLocalCutover(source.authorization),
        ]);
        expect(concurrentReplay).toEqual(first);
        expect(first).toMatchObject({
          operationalUsageTargetCount: 1,
          blobBytesTargetCount: 2,
          blobDeleteOutboxCount: 2,
          exportBytesTargetCount: 1,
          exportDeleteOutboxCount: 1,
          localDestructiveProgress: true,
          physicalAcksComplete: false,
          allDomainsComplete: false,
          contentPurgeExecuted: false,
        });
        expect(await firstStore.executeTenantPurgeLocalCutover(source.authorization)).toEqual(first);

        const acks = await firstStore.getTenantPurgeExecutionDomainAcks(
          tenantId,
          source.requestId,
          1,
        );
        expect(acks.map((ack) => [ack.domain, ack.ackKind, ack.final])).toEqual([
          ["operational_usage", "anonymized", true],
          ["blob_bytes", "blocker_resolution", false],
          ["blob_bytes", "outbox_scheduled", false],
          ["blob_bytes", "outbox_scheduled", false],
          ["user_export_control", "applied", true],
          ["user_export_snapshots", "applied", true],
          ["user_export_bytes", "blocker_resolution", false],
          ["user_export_bytes", "outbox_scheduled", false],
        ]);
        for (const ack of acks) {
          expect(ack.adapterProtocol).toBe("local-store-v1");
          expect(ack.operationSha256).toBe(tenantPurgeExecutionOperationSha256({
            identity: {
              requestId: ack.requestId,
              tenantId: ack.tenantId,
              subjectGeneration: ack.subjectGeneration,
              planBuildGeneration: ack.planBuildGeneration,
              executionGeneration: ack.executionGeneration,
            },
            domain: ack.domain,
            action: operationAction(ack),
            affectedCount: ack.affectedCount,
            resultCount: ack.resultCount,
            resultRootSha256: ack.resultRootSha256,
          }));
        }
        const scheduled = acks.filter((ack) => ack.ackKind === "outbox_scheduled");
        for (const domain of ["blob_bytes", "user_export_bytes"] as const) {
          const targetsForDomain = scheduled
            .filter((ack) => ack.domain === domain)
            .map((ack) => ack.targetSha256);
          expect(targetsForDomain).toEqual(targetsForDomain.toSorted());
        }
        expect(scheduled.map((ack) => ack.outboxId)).toContain(targets.existingOutboxId);
        expect(await firstStore.getTenantPurgeExecutionDomainAcks(
          `wrong-${tenantId}`,
          source.requestId,
          1,
        )).toEqual([]);

        const [counts] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM usage_ledger WHERE tenant_id=?) AS usage_rows,
             (SELECT COUNT(*) FROM billing_usage_facts WHERE tenant_id=?) AS billing_rows,
             (SELECT COUNT(*) FROM blob_delete_outbox o JOIN blob_objects b ON b.blob_id=o.blob_id
               WHERE b.tenant_id=?) AS blob_outboxes,
             (SELECT COUNT(*) FROM user_export_download_leases WHERE tenant_id=?) AS export_leases,
             (SELECT COUNT(*) FROM user_export_snapshot_records WHERE tenant_id=?) AS snapshot_rows,
             (SELECT COUNT(*) FROM user_export_snapshot_blobs
               WHERE tenant_id=? AND released_at_ms IS NULL) AS unreleased_pins,
             (SELECT COUNT(*) FROM user_export_artifact_delete_outbox o
               JOIN user_export_artifacts a ON a.artifact_id=o.artifact_id
               WHERE a.tenant_id=?) AS export_outboxes,
             (SELECT status FROM user_export_requests WHERE request_id=?) AS export_status,
             (SELECT state FROM user_export_artifact_parts
               WHERE artifact_id=? AND part_number=0) AS export_part_state`,
          [
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            targets.exportRequestId,
            targets.artifactId,
          ],
        );
        expect(counts[0]).toMatchObject({
          usage_rows: 0,
          billing_rows: 1,
          blob_outboxes: 2,
          export_leases: 0,
          snapshot_rows: 0,
          unreleased_pins: 0,
          export_outboxes: 1,
          export_status: "revoked",
          export_part_state: "delete_pending",
        });

        await expect(firstStore.sealTenantPurgeLocalPhysicalAcks(source.authorization))
          .rejects.toBeInstanceOf(TenantPurgeExecutionNotReadyError);
        const deleteToken = `blob-delete-${randomUUID()}`;
        const deletes = await firstStore.claimBlobDeletes({
          nowMs: Date.now() + 10_000,
          limit: 10,
          leaseMs: 60_000,
          claimToken: deleteToken,
        });
        expect(deletes).toHaveLength(2);
        for (const row of deletes) {
          expect(await firstStore.completeBlobDelete(
            row.outboxId,
            deleteToken,
            Date.now(),
          )).toBe(true);
        }
        const exportDeleteToken = `export-delete-${randomUUID()}`;
        const exportDeletes = await firstStore.claimUserDataExportDeletes({
          limit: 10,
          leaseMs: 60_000,
          claimToken: exportDeleteToken,
        });
        expect(exportDeletes).toHaveLength(1);
        expect(exportDeletes[0]).toMatchObject({
          artifactId: targets.artifactId,
          requestId: targets.exportRequestId,
          partNumber: 0,
        });
        expect(await firstStore.completeUserDataExportDelete(
          exportDeletes[0]!.outboxId,
          exportDeleteToken,
        )).toBe(true);
        const physical = await secondStore.sealTenantPurgeLocalPhysicalAcks(source.authorization);
        expect(physical).toMatchObject({
          blobPhysicalAckCount: 2,
          exportPhysicalAckCount: 1,
          localPhysicalAcksComplete: true,
          allDomainsComplete: false,
          contentPurgeExecuted: false,
        });
        expect(await firstStore.sealTenantPurgeLocalPhysicalAcks(source.authorization))
          .toEqual(physical);
        const terminal = await firstStore.getTenantPurgeExecutionJob(tenantId, source.requestId);
        expect(terminal).toMatchObject({
          phase: "local_physical_acks_sealed",
          unresolvedBlockerCount: 7,
        });
        const allAcks = await firstStore.getTenantPurgeExecutionDomainAcks(
          tenantId,
          source.requestId,
          1,
        );
        const physicalAcks = allAcks.filter((ack) => ack.ackKind === "physical_delete");
        expect(physicalAcks).toHaveLength(3);
        const blobPhysical = physicalAcks.filter((ack) => ack.domain === "blob_bytes");
        const exportPhysical = physicalAcks.filter((ack) => ack.domain === "user_export_bytes");
        expect(blobPhysical.map((ack) => ack.targetSha256)).toEqual(
          blobPhysical.map((ack) => ack.targetSha256).toSorted(),
        );
        expect(exportPhysical).toHaveLength(1);
        expect(blobPhysical.at(-1)?.final).toBe(true);
        expect(exportPhysical[0]?.final).toBe(true);
        await expect(firstStore.sealTenantPurgeLocalPhysicalAcks({
          ...source.authorization,
          tenantId: `wrong-${tenantId}`,
        })).resolves.toBeNull();
      } finally {
        await conn.end();
        await firstStore.close();
        await secondStore.close();
      }
    });

    it("rolls every destructive write back when ACK publication fails and rejects expired authority", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-execution-rollback-${randomUUID()}`;
      const userId = `rollback-user-${randomUUID()}`;
      try {
        const source = await advanceToExecutionClaim(store, tenantId, userId, {
          beforeTenantErasure: async (session) => {
            await installUsageAndBlobs(store, conn, session);
          },
        });
        const internal = store as unknown as {
          appendTenantPurgeExecutionAck: (...args: unknown[]) => Promise<unknown>;
        };
        const original = internal.appendTenantPurgeExecutionAck;
        let calls = 0;
        internal.appendTenantPurgeExecutionAck = async (...args: unknown[]) => {
          calls += 1;
          if (calls === 2) throw new Error("injected ACK publication failure");
          return original.apply(store, args);
        };
        await expect(store.executeTenantPurgeLocalCutover(source.authorization))
          .rejects.toThrow("injected ACK publication failure");
        internal.appendTenantPurgeExecutionAck = original;

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM usage_ledger WHERE tenant_id=?) AS usage_rows,
             (SELECT COUNT(*) FROM billing_usage_facts WHERE tenant_id=?) AS billing_rows,
             (SELECT COUNT(*) FROM tenant_purge_execution_domain_acks WHERE tenant_id=?) AS acks,
             (SELECT COUNT(*) FROM tenant_purge_local_cutover_receipts WHERE tenant_id=?) AS receipts,
             (SELECT state FROM blob_objects WHERE tenant_id=? LIMIT 1) AS blob_state`,
          [tenantId, tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          usage_rows: 1,
          billing_rows: 0,
          acks: 0,
          receipts: 0,
          blob_state: "staging",
        });
        expect(await store.getTenantPurgeExecutionJob(tenantId, source.requestId))
          .not.toHaveProperty("localCutoverReceiptSha256");

        const leaseTenantId = `tenant-execution-expired-${randomUUID()}`;
        const leaseSource = await advanceToExecutionClaim(
          store,
          leaseTenantId,
          `expired-user-${randomUUID()}`,
          { leaseMs: 1 },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(await store.executeTenantPurgeLocalCutover(leaseSource.authorization)).toBeNull();
        expect(await store.getTenantPurgeExecutionDomainAcks(
          leaseTenantId,
          leaseSource.requestId,
          1,
        )).toEqual([]);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rechecks a canonical tenant hold at the irreversible boundary with zero partial writes", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-execution-hold-${randomUUID()}`;
      const userId = `hold-user-${randomUUID()}`;
      let targets: Awaited<ReturnType<typeof installUsageAndBlobs>> | undefined;
      try {
        const source = await advanceToExecutionClaim(store, tenantId, userId, {
          beforeTenantErasure: async (session) => {
            targets = await installUsageAndBlobs(store, conn, session, { readyExport: true });
          },
        });
        if (!targets?.artifactId || !targets.exportRequestId) {
          throw new Error("missing hold-race export fixture");
        }
        await injectCanonicalTenantHold(
          conn,
          tenantId,
          `hold_execution_${randomUUID().replaceAll("-", "")}`,
        );
        await expect(store.executeTenantPurgeLocalCutover(source.authorization))
          .rejects.toMatchObject({ reason: "active_legal_hold" });

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM usage_ledger WHERE tenant_id=?) AS usage_rows,
             (SELECT COUNT(*) FROM billing_usage_facts WHERE tenant_id=?) AS billing_rows,
             (SELECT COUNT(*) FROM blob_objects
               WHERE tenant_id=? AND state='ready') AS ready_blobs,
             (SELECT COUNT(*) FROM blob_delete_outbox o
               JOIN blob_objects b ON b.blob_id=o.blob_id WHERE b.tenant_id=?) AS blob_outboxes,
             (SELECT COUNT(*) FROM user_export_download_leases WHERE tenant_id=?) AS export_leases,
             (SELECT COUNT(*) FROM user_export_snapshot_records WHERE tenant_id=?) AS snapshot_rows,
             (SELECT COUNT(*) FROM user_export_snapshot_blobs
               WHERE tenant_id=? AND released_at_ms IS NULL) AS unreleased_pins,
             (SELECT status FROM user_export_requests WHERE request_id=?) AS export_status,
             (SELECT state FROM user_export_artifact_parts
               WHERE artifact_id=? AND part_number=0) AS export_part_state,
             (SELECT COUNT(*) FROM tenant_purge_execution_domain_acks WHERE tenant_id=?) AS acks,
             (SELECT COUNT(*) FROM tenant_purge_local_cutover_receipts WHERE tenant_id=?) AS receipts`,
          [
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            tenantId,
            targets.exportRequestId,
            targets.artifactId,
            tenantId,
            tenantId,
          ],
        );
        expect(rows[0]).toMatchObject({
          usage_rows: 1,
          billing_rows: 0,
          ready_blobs: 1,
          blob_outboxes: 0,
          export_leases: 1,
          export_status: "ready",
          export_part_state: "uploaded",
          acks: 0,
          receipts: 0,
        });
        expect(Number(rows[0]?.unreleased_pins)).toBeGreaterThan(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls physical publication back when cleanup completion is ahead of trusted DB time", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-execution-future-physical-${randomUUID()}`;
      const userId = `future-physical-user-${randomUUID()}`;
      try {
        const source = await advanceToExecutionClaim(store, tenantId, userId, {
          beforeTenantErasure: async (session) => {
            const now = Date.now();
            const blobId = newId("blob");
            await store.stageBlob({
              owner: { tenantId, userId },
              sessionId: session.id,
              fence: 1,
              blobId,
              purpose: "tool_output",
              storageBackend: "memory-v1",
              storageFormat: BLOB_STORAGE_FORMAT,
              storageKey: `objects/${blobId.slice("blob_".length)}`,
              uploadToken: `upload-${blobId.slice("blob_".length)}`,
              createdAtMs: now,
              stagingExpiresAtMs: now + 120_000,
            });
          },
        });
        await store.executeTenantPurgeLocalCutover(source.authorization);
        const token = `future-physical-${randomUUID()}`;
        const [deleteClaim] = await store.claimBlobDeletes({
          nowMs: Date.now() + 10_000,
          limit: 10,
          leaseMs: 60_000,
          claimToken: token,
        });
        if (!deleteClaim) throw new Error("missing future-completion Blob claim");
        expect(await store.completeBlobDelete(
          deleteClaim.outboxId,
          token,
          Date.now(),
        )).toBe(true);
        await conn.query(
          "UPDATE blob_delete_outbox SET completed_at_ms=? WHERE outbox_id=?",
          [Date.now() + 3_600_000, deleteClaim.outboxId],
        );
        await expect(store.sealTenantPurgeLocalPhysicalAcks(source.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        expect(await store.getTenantPurgeExecutionJob(tenantId, source.requestId)).toMatchObject({
          phase: "queued",
        });
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_purge_execution_domain_acks
               WHERE tenant_id=? AND ack_kind='physical_delete') AS physical_acks,
             (SELECT COUNT(*) FROM tenant_purge_local_physical_ack_receipts
               WHERE tenant_id=?) AS physical_receipts`,
          [tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ physical_acks: 0, physical_receipts: 0 });
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("atomically blocks a dead-lettered exact physical intent", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-execution-deadletter-${randomUUID()}`;
      const userId = `deadletter-user-${randomUUID()}`;
      try {
        const source = await advanceToExecutionClaim(store, tenantId, userId, {
          beforeTenantErasure: async (session) => {
            const now = Date.now();
            for (let index = 0; index < 2; index += 1) {
              const blobId = newId("blob");
              await store.stageBlob({
                owner: { tenantId, userId },
                sessionId: session.id,
                fence: 1,
                blobId,
                purpose: "tool_output",
                storageBackend: "memory-v1",
                storageFormat: BLOB_STORAGE_FORMAT,
                storageKey: `objects/${blobId.slice("blob_".length)}`,
                uploadToken: `upload-${blobId.slice("blob_".length)}`,
                createdAtMs: now + index,
                stagingExpiresAtMs: now + 120_000,
              });
            }
          },
        });
        await store.executeTenantPurgeLocalCutover(source.authorization);
        const token = `deadletter-${randomUUID()}`;
        const deleteClaims = await store.claimBlobDeletes({
          nowMs: Date.now() + 10_000,
          limit: 10,
          leaseMs: 60_000,
          claimToken: token,
        });
        expect(deleteClaims).toHaveLength(2);
        expect(await store.retryBlobDelete(deleteClaims[1]!.outboxId, token, {
          failedAtMs: Date.now(),
          availableAtMs: Date.now() + 1,
          maxAttempts: 1,
          error: new Error("physical delete failed"),
        })).toBe(true);
        await expect(store.sealTenantPurgeLocalPhysicalAcks(source.authorization))
          .rejects.toBeInstanceOf(TenantPurgeExecutionPhysicalAckDeadLetterError);
        expect(await store.getTenantPurgeExecutionJob(tenantId, source.requestId)).toMatchObject({
          phase: "blocked",
          blockedReasonCode: "physical_ack_dead_lettered",
        });
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS receipts FROM tenant_purge_local_physical_ack_receipts
            WHERE tenant_id=?`,
          [tenantId],
        );
        expect(Number(rows[0]?.receipts)).toBe(0);
      } finally {
        await conn.end();
        await store.close();
      }
    });
  });
}
