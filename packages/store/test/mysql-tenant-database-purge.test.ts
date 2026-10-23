import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  emptyUsage,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256,
  ORDINARY_SESSION_DELETE_GRACE_MS,
  MysqlSessionStore,
  SessionGoneError,
  TenantDatabasePurgeEvidenceChangedError,
  TenantErasureIntegrityError,
  TenantTelemetryPregrantClaimLeaseExpiredError,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  USER_DATA_EXPORT_CONTENT_TYPE,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  newUsageId,
  priorRetainedBillingFactProofSha256,
  computeBillingUsageFactSha256,
  tenantDatabasePurgeBillingFactRootSha256,
  tenantDatabasePurgeCutoverEvidenceSha256,
  tenantDatabasePurgeDomainAckSha256,
  tenantDatabasePurgeNextDomainAckRootSha256,
  tenantDatabasePurgeOperationSha256,
  tenantDatabasePurgePhysicalProofSha256,
  tenantDatabasePurgePreDeleteReceiptSha256,
  tenantDatabasePurgeReceiptSha256,
  tenantDatabasePurgeSessionGraveMarkerRootSha256,
  tenantDatabasePurgeSessionGraveMarkerSha256,
  tenantErasureRequestHash,
  tenantPurgePlanTargetRootSha256,
  tenantPurgePlanTargetSha256,
  tenantDatabasePurgeTargetRootSha256,
  tenantDatabasePurgeTargetSha256,
  tenantTelemetryOwnerClosureEntryRootSha256,
  tenantTelemetryRefKeyIdSha256,
  tenantTelemetryWriteAdapterEvidenceSha256,
  userDataExportAuthorization,
  userDataExportIdempotencyKeySha256,
  userDataExportManifestSha256,
  userDataExportRequestHash,
  userDataExportStorageKey,
  type RetentionPolicyDocumentV1,
  type TenantContentInventoryAuthorization,
  type TenantCredentialRevocationAuthorization,
  type TenantDatabasePurgeAuthorization,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgePlanAuthorization,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
  type TenantTelemetryWriteClaim,
  type UserDataExportAuthorization,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";
import { CaptureMysqlRuntimeOwner, type CaptureMysqlInspection, type CaptureMysqlCleanupValidation } from "./fixtures/capture-mysql-runtime.js";
import { acquireFixtureSessionAuthority } from "./fixtures/session-authority.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const TELEMETRY_REF_KEY = Buffer.alloc(32, 0x45);

function telemetryDigest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function completeOrdinaryTombstoneOutbox(
  store: MysqlSessionStore, sessionId: string,
): Promise<void> {
  const outbox = await store.getLifecycleOutbox("session.tombstoned", sessionId, 1);
  if (!outbox) throw new Error("ordinary tombstone outbox is missing");
  const nowMs = Math.max(Date.now(), outbox.availableAtMs ?? 0) + 1;
  const claimToken = `ordinary-t3f-${randomUUID()}`;
  const claimed = await store.claimLifecycleOutbox({
    topics: ["session.tombstoned"], nowMs, limit: 100, leaseMs: 60_000, claimToken,
  });
  const exact = claimed.find((candidate) => candidate.outboxId === outbox.outboxId);
  if (!exact || !await store.completeLifecycleOutbox(exact.outboxId, claimToken, nowMs)) {
    throw new Error("ordinary tombstone outbox could not be completed");
  }
}

async function activateTelemetryForT3f(store: MysqlSessionStore): Promise<void> {
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: ["logs", "traces"].map((domain) => ({
      domain: domain as "logs" | "traces",
      backendKind: "test_sink",
      adapterProtocol: "telemetry-test-v1",
      namespaceSha256: telemetryDigest(`${domain}:namespace`),
      failureDomainSha256: telemetryDigest(`${domain}:failure-domain`),
    })),
  });
}

async function activateLogsCaptureForT3f(store: MysqlSessionStore) {
  const lifecycle = await store.getTenantTelemetryLifecycleControl();
  if (lifecycle.state !== "active") throw new Error("missing telemetry lifecycle fixture");
  const target = (await store.listTenantTelemetryLifecycleTargets())
    .find((candidate) => candidate.domain === "logs");
  if (!target) throw new Error("missing logs lifecycle target fixture");
  const producerProtocol = "application-dual-write-v1";
  const producerContractSha256 = telemetryDigest("0043-logs-producer-contract");
  await store.activateTenantTelemetryApplicationCapture({
    domain: "logs", expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
    lifecycleTargetSha256: target.targetSha256,
    lifecycleTargetReceiptSha256: target.receiptSha256,
    producerProtocol, producerContractSha256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  });
  return { producerProtocol, producerContractSha256 };
}

async function queueTelemetryForT3f(
  store: MysqlSessionStore,
  tenantId: string,
  marker: string,
  owner: { kind: "tenant"; id: string; userId: null }
    | { kind: "user"; id: string; userId: string }
    | { kind: "session"; id: string; userId: string },
  producer?: { producerProtocol: string; producerContractSha256: string },
) {
  const atMs = Date.now() - 1_000;
  return store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: telemetryDigest(`${marker}:artifact`),
    artifactGeneration: 1,
    ownerKind: owner.kind,
    ownerId: owner.id,
    ownerUserId: owner.userId,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 0,
    sourceHighWaterDbMs: atMs,
    ...(producer ?? {}),
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(atMs, {
        opaqueRefKey: TELEMETRY_REF_KEY,
        tenantValue: tenantId,
        ownerKind: owner.kind,
        ownerValue: owner.id,
        attempt: 1,
      })],
    },
  });
}

function telemetryAuthorization(claim: TenantTelemetryWriteClaim) {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function telemetryAdapterResult(claim: TenantTelemetryWriteClaim) {
  const evidence = {
    adapterProtocol: claim.target.adapterProtocol,
    domain: claim.inventory.domain,
    targetSha256: claim.target.targetSha256,
    writeOperationSha256: claim.writeOperationSha256,
    artifactIdSha256: claim.inventory.artifactIdSha256,
    artifactGeneration: claim.inventory.artifactGeneration,
    payloadSha256: claim.inventory.payloadSha256,
    manifestSha256: claim.inventory.manifestSha256,
    outcome: "written" as const,
    replayed: false,
  };
  return {
    ...evidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(evidence),
  };
}

async function waitForTelemetryWriteLockWaiter(
  observer: CaptureMysqlInspection,
  database: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=?
          AND requested.OBJECT_NAME='tenant_telemetry_write_jobs'`,
      [database],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for telemetry write job lock");
}

async function waitForDatabasePurgeLockWaiter(
  observer: CaptureMysqlInspection, database: string, timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await observer.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT waits.REQUESTING_ENGINE_TRANSACTION_ID) AS waiters
         FROM performance_schema.data_lock_waits waits
         JOIN performance_schema.data_locks requested
           ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
        WHERE requested.OBJECT_SCHEMA=?
          AND requested.OBJECT_NAME='tenant_database_purge_jobs'`,
      [database],
    );
    if (Number(rows[0]?.waiters ?? 0) > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for 0043 diagnostic T3f job lock");
}

function assertDisposableTestTarget(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (url.protocol !== "mysql:" || !/(?:^|[_-])test(?:$|[_-])/i.test(database)) {
    throw new Error(`MYSQL_TEST_URL must name a disposable test database, got ${database}`);
  }
  return url;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

async function installPolicy(store: MysqlSessionStore, tenantId: string): Promise<void> {
  const atMs = Date.now();
  await store.putRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    policy: policy(),
    actorKeyId: "database-purge-policy-admin",
    atMs,
  });
  await store.activateRetentionPolicy({
    tenantId,
    policyVersion: "policy-v1",
    expectedControlGeneration: 0,
    actorKeyId: "database-purge-policy-admin",
    atMs: atMs + 1,
  });
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

function databaseAuthorization(
  claim: Awaited<ReturnType<MysqlSessionStore["claimTenantDatabasePurges"]>>[number],
): TenantDatabasePurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://mysql-database-purge.internal:8080"),
    runnerId: "mysql-database-purge-runner",
    bootId: "mysql-database-purge-boot",
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

async function claimUserDataExport(
  store: MysqlSessionStore,
  requestId: string,
): Promise<UserDataExportAuthorization> {
  const claim = (await store.claimUserDataExports({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-purge-export-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!claim) throw new Error("missing database purge export claim");
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
  const bytes = Buffer.from(`database-purge-export:${authorization.requestId}\n`, "utf8");
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

async function advanceToDatabasePurgeClaim(
  store: MysqlSessionStore,
  conn: CaptureMysqlInspection,
  tenantId: string,
  userId: string,
  options: {
    seedCompletedBlob?: boolean;
    seedReadyExport?: boolean;
    beforeTenantErasure?: (sessionId: string) => Promise<void>;
    beforeExecutionClaim?: (requestId: string) => Promise<void>;
  } = {},
) {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await installPolicy(store, tenantId);
  const session = mkSession(tenantId, userId);
  await store.createSession(session);
  let readyExport: { requestId: string; artifactId: string } | undefined;
  if (options.seedReadyExport) {
    const requestId = newUserDataExportRequestId();
    await store.requestUserDataExport({
      requestId,
      tenantId,
      userId,
      requestedByKeyId: "database-purge-export-admin",
      idempotencyKeySha256: userDataExportIdempotencyKeySha256(
        `database-purge-export-${randomUUID()}`,
      ),
      requestHash: userDataExportRequestHash(tenantId, userId),
    });
    const authorization = await claimUserDataExport(store, requestId);
    readyExport = {
      requestId,
      artifactId: await publishReadyUserDataExport(store, authorization),
    };
  }
  const usageAtMs = Date.now();
  await conn.query(
    `INSERT INTO usage_ledger
       (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
        usage_json, created_at_ms)
     VALUES (NULL,?,?,?,?,1,'database-purge-provider','database-purge-model',?,?)`,
    [
      tenantId,
      userId,
      session.id,
      newId("turn"),
      JSON.stringify({ ...emptyUsage(), inputTokens: 5, outputTokens: 2, totalTokens: 7 }),
      usageAtMs,
    ],
  );
  let completedBlob: { blobId: string; outboxId: number; createdAtMs: number } | undefined;
  if (options.seedCompletedBlob) {
    const blobId = newId("blob");
    const createdAtMs = Date.now();
    await conn.query(
      `INSERT INTO blob_objects
         (blob_id, tenant_id, user_id, session_id, item_id, purpose,
          storage_backend, storage_format, storage_key, upload_token, state,
          sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
          staging_expires_at_ms, delete_after_ms, deleted_at_ms,
          deletion_generation, created_at_ms)
       VALUES (?,?,?,?,NULL,'tool_output','memory-v1',?,?,?,'deleted',
               NULL,NULL,NULL,NULL,NULL,NULL,?,?,1,?)`,
      [
        blobId,
        tenantId,
        userId,
        session.id,
        BLOB_STORAGE_FORMAT,
        `objects/${blobId.slice("blob_".length)}`,
        `upload-${blobId.slice("blob_".length)}`,
        createdAtMs,
        createdAtMs,
        createdAtMs,
      ],
    );
    const [inserted] = await conn.query<mysql.ResultSetHeader>(
      `INSERT INTO blob_delete_outbox
         (blob_id, generation, available_at_ms, attempts, claim_token,
          lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms,
          created_at_ms)
       VALUES (?,1,?,0,NULL,NULL,NULL,?,NULL,?)`,
      [blobId, createdAtMs, createdAtMs, createdAtMs],
    );
    completedBlob = { blobId, outboxId: inserted.insertId, createdAtMs };
  }
  await options.beforeTenantErasure?.(session.id);
  if ((await store.readTenantCredentialTrackingCutover()).controlGeneration === 0) {
    await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  }
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId,
    tenantId,
    requestedByKeyId: "database-purge-lifecycle-admin",
    idempotencyKey: `database-purge-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId),
    atMs: Date.now(),
  });

  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-credential-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!credential || !await store.revokeTenantCredentialMaterial(
    credentialAuthorization(credential),
  )) throw new Error("missing T3a completion");

  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-runtime-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!runtime || !await store.completeTenantRuntimeRevocation(
    runtimeAuthorization(runtime),
    fleetProof(runtime),
  )) throw new Error("missing T3b completion");

  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const inventory = (await store.claimTenantContentInventories({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-inventory-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!inventory) throw new Error("missing T3c claim");
  const inventoryAuth = inventoryAuthorization(inventory);
  let done = false;
  while (!done) {
    done = (await store.buildTenantContentInventoryPage(inventoryAuth, { limit: 100 })).done;
  }
  if (!await store.sealTenantContentInventory(inventoryAuth)) {
    throw new Error("missing T3c completion");
  }

  if (await store.materializeTenantPurgePlanJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3d materialization");
  }
  const plan = (await store.claimTenantPurgePlans({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-plan-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!plan) throw new Error("missing T3d claim");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  if (!await store.sealTenantPurgePlan(planAuthorization(plan))) {
    throw new Error("missing T3d completion");
  }

  if (await store.materializeTenantPurgeExecutionJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3e materialization");
  }
  await options.beforeExecutionClaim?.(requestId);
  const execution = (await store.claimTenantPurgeExecutions({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-execution-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!execution) throw new Error("missing T3e claim");
  const executionAuth = executionAuthorization(execution);
  if (!await store.executeTenantPurgeLocalCutover(executionAuth)) {
    throw new Error("missing T3e cutover");
  }
  if (readyExport) {
    const claimToken = `database-purge-export-delete-${randomUUID()}`;
    const deletes = await store.claimUserDataExportDeletes({
      limit: 10,
      leaseMs: 120_000,
      claimToken,
    });
    if (deletes.length !== 1 || deletes[0]!.artifactId !== readyExport.artifactId) {
      throw new Error("missing T3e export physical delete");
    }
    if (!await store.completeUserDataExportDelete(deletes[0]!.outboxId, claimToken)) {
      throw new Error("missing T3e export physical completion");
    }
  }
  if (!await store.sealTenantPurgeLocalPhysicalAcks(executionAuth)) {
    throw new Error("missing T3e physical receipt");
  }

  if (await store.materializeTenantDatabasePurgeJobs({ limit: 10 }) !== 1) {
    throw new Error("missing T3f materialization");
  }
  const database = (await store.claimTenantDatabasePurges({
    limit: 10,
    leaseMs: 120_000,
    claimToken: `database-purge-${randomUUID()}`,
  })).find((candidate) => candidate.requestId === requestId);
  if (!database) throw new Error("missing T3f claim");
  return {
    requestId,
    session,
    authorization: databaseAuthorization(database),
    completedBlob,
    readyExport,
  };
}

async function advanceToTelemetryPregrantSource(
  store: MysqlSessionStore, conn: CaptureMysqlInspection, tenantId: string,
) {
  await activateTelemetryForT3f(store);
  const producer = await activateLogsCaptureForT3f(store);
  const userId = `pregrant-user-${randomUUID()}`;
  const source = await advanceToDatabasePurgeClaim(
    store, conn, tenantId, userId, {
      beforeTenantErasure: async (sessionId) => {
        await queueTelemetryForT3f(store, tenantId, `pregrant-${randomUUID()}`,
          { kind: "session", id: sessionId, userId }, producer);
        const [claim] = await store.claimTenantTelemetryWriteJobs({
          limit: 1, leaseMs: 120_000,
          claimToken: `pregrant-write-${randomUUID()}`,
          adapterProtocol: "telemetry-test-v1",
        });
        if (!claim) throw new Error("missing pregrant write claim");
        const authorization = telemetryAuthorization(claim);
        if (!await store.reserveTenantTelemetryExternalMutation(
          authorization, "telemetry-test-v1",
        ) || !await store.completeTenantTelemetryWrite(
          authorization, telemetryAdapterResult(claim),
        )) throw new Error("missing pregrant write completion");
      },
    },
  );
  const [target] = await store.getTenantTelemetryPlanArtifactTargets(
    tenantId, source.requestId,
  );
  if (!target) throw new Error("missing pregrant target");
  if (!await store.executeTenantDatabasePurge(source.authorization)) {
    throw new Error("missing pregrant T3f terminal");
  }
  return { source, target };
}

async function rewriteSelfConsistentT3fBillingEvidence(
  store: MysqlSessionStore,
  conn: CaptureMysqlInspection,
  tenantId: string,
  requestId: string,
  sessionId: string,
): Promise<void> {
  const job = await store.getTenantDatabasePurgeJob(tenantId, requestId);
  const preDeleteReceipt = await store.getTenantDatabasePurgePreDeleteReceipt(
    tenantId,
    requestId,
  );
  const domainAcks = await store.getTenantDatabasePurgeDomainAcks(
    tenantId,
    requestId,
    1,
  );
  const terminalReceipt = await store.getTenantDatabasePurgeReceipt(tenantId, requestId);
  const marker = await store.getTenantPurgeSessionGraveMarker(tenantId, sessionId);
  const cutover = await store.getTenantDatabasePurgeCutover();
  if (
    !job
    || job.phase !== "database_purged"
    || !preDeleteReceipt
    || !terminalReceipt
    || !marker
    || cutover.controlGeneration !== 1
  ) throw new Error("missing completed T3f evidence fixture");

  const [billingRows] = await conn.query<RowDataPacket[]>(
    `SELECT usage_id,tenant_id,accounting_period,provider,model,input_tokens,
            output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,
            total_tokens,cost_cny,currency,fact_sha256
       FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id`,
    [tenantId],
  );
  const row = billingRows[0];
  if (!row || billingRows.length !== 1) throw new Error("missing retained billing fact");
  const changedFactBody = {
    usageId: String(row.usage_id),
    tenantId: String(row.tenant_id),
    accountingPeriod: String(row.accounting_period),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: Number(row.input_tokens) + 1,
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens) + 1,
    ...(row.cost_cny == null ? {} : { costCNY: Number(row.cost_cny) }),
    currency: "CNY" as const,
  };
  const changedFactSha256 = computeBillingUsageFactSha256(changedFactBody);
  const billingRootSha256 = tenantDatabasePurgeBillingFactRootSha256([
    changedFactSha256,
  ]);

  const { receiptSha256: _oldPreDeleteSha256, ...oldPreDeleteBody } = preDeleteReceipt;
  const newPreDeleteBody = {
    ...oldPreDeleteBody,
    retainedBillingFactRootSha256: billingRootSha256,
  };
  const newPreDeleteReceipt = {
    ...newPreDeleteBody,
    receiptSha256: tenantDatabasePurgePreDeleteReceiptSha256(newPreDeleteBody),
  };
  const { markerSha256: _oldMarkerSha256, ...oldMarkerBody } = marker;
  const newMarkerBody = {
    ...oldMarkerBody,
    preDeleteReceiptSha256: newPreDeleteReceipt.receiptSha256,
  };
  const newMarker = {
    ...newMarkerBody,
    markerSha256: tenantDatabasePurgeSessionGraveMarkerSha256(newMarkerBody),
  };
  const graveRootSha256 = tenantDatabasePurgeSessionGraveMarkerRootSha256([newMarker]);
  let previousGlobalAckSha256 = EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256;
  const rewrittenAcks = domainAcks.map((ack) => {
    const identity = {
      requestId: ack.requestId,
      tenantId: ack.tenantId,
      subjectGeneration: ack.subjectGeneration,
      planBuildGeneration: ack.planBuildGeneration,
      executionGeneration: ack.executionGeneration,
      databasePurgeGeneration: ack.databasePurgeGeneration,
    };
    const retainedEvidenceRootSha256 = ack.domain === "session_content"
      ? graveRootSha256
      : ack.retainedEvidenceRootSha256;
    const operationSha256 = tenantDatabasePurgeOperationSha256({
      identity,
      domain: ack.domain,
      action: ack.action,
      preDeleteTargetCount: ack.preDeleteTargetCount,
      preDeleteTargetRootSha256: ack.preDeleteTargetRootSha256,
      affectedCount: ack.affectedCount,
      resultTargetCount: ack.resultTargetCount,
      resultTargetRootSha256: ack.resultTargetRootSha256,
      retainedEvidenceCount: ack.retainedEvidenceCount,
      retainedEvidenceRootSha256,
    });
    const physicalProofSha256 = tenantDatabasePurgePhysicalProofSha256({
      identity,
      domain: ack.domain,
      action: ack.action,
      adapterProtocol: ack.adapterProtocol,
      previousGlobalAckSha256,
      preDeleteEntryReceiptSha256: ack.preDeleteEntryReceiptSha256,
      operationSha256,
      storeDbTimestampMs: ack.storeDbTimestampMs,
      completedClaimAttempt: ack.completedClaimAttempt,
      completedClaimTokenSha256: ack.completedClaimTokenSha256,
    });
    const { receiptSha256: _oldAckSha256, ...oldAckBody } = ack;
    const body = {
      ...oldAckBody,
      previousGlobalAckSha256,
      retainedEvidenceRootSha256,
      operationSha256,
      physicalProofSha256,
    };
    const rewritten = {
      ...body,
      receiptSha256: tenantDatabasePurgeDomainAckSha256(body),
    };
    previousGlobalAckSha256 = tenantDatabasePurgeNextDomainAckRootSha256(
      previousGlobalAckSha256,
      rewritten.globalAckSeq,
      rewritten.domain,
      rewritten.receiptSha256,
    );
    return rewritten;
  });
  const domainAckRootSha256 = previousGlobalAckSha256;
  const { receiptSha256: _oldTerminalSha256, ...oldTerminalBody } = terminalReceipt;
  const newTerminalBody = {
    ...oldTerminalBody,
    preDeleteReceiptSha256: newPreDeleteReceipt.receiptSha256,
    domainAckRootSha256,
    graveMarkerRootSha256: graveRootSha256,
    retainedBillingFactRootSha256: billingRootSha256,
  };
  if (newTerminalBody.priorRetainedBillingFacts) {
    newTerminalBody.priorRetainedBillingFacts = {
      ...newTerminalBody.priorRetainedBillingFacts,
      evidenceSha256: priorRetainedBillingFactProofSha256(newTerminalBody,
        newTerminalBody.priorRetainedBillingFacts.facts),
    };
  }
  const newTerminalReceipt = {
    ...newTerminalBody,
    receiptSha256: tenantDatabasePurgeReceiptSha256(newTerminalBody),
  };
  const newCutoverEvidenceSha256 = tenantDatabasePurgeCutoverEvidenceSha256({
    singletonId: cutover.singletonId,
    controlGeneration: cutover.controlGeneration,
    activatedAtDbMs: cutover.activatedAtDbMs,
    firstRequestId: cutover.firstRequestId,
    firstReceiptSha256: newTerminalReceipt.receiptSha256,
  });

  const mutableTables = [
    "billing_usage_facts",
    "tenant_database_purge_jobs",
    "tenant_database_purge_predelete_receipts",
    "tenant_database_purge_domain_acks",
    "tenant_database_purge_receipts",
    "tenant_purge_session_grave_markers",
    "tenant_database_purge_cutover",
  ];
  const [triggerRows] = await conn.query<RowDataPacket[]>(
    `SELECT trigger_name AS trigger_name FROM information_schema.triggers
      WHERE trigger_schema=DATABASE() AND event_manipulation='UPDATE'
        AND event_object_table IN (?)`,
    [mutableTables],
  );
  for (const trigger of triggerRows) {
    const name = String(trigger.trigger_name ?? trigger.TRIGGER_NAME);
    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("unsafe trigger fixture name");
    await conn.query(`DROP TRIGGER \`${name}\``);
  }
  await conn.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    await conn.query(
      `UPDATE billing_usage_facts
          SET input_tokens=?,total_tokens=?,fact_sha256=? WHERE usage_id=?`,
      [
        changedFactBody.inputTokens,
        changedFactBody.totalTokens,
        changedFactSha256,
        changedFactBody.usageId,
      ],
    );
    await conn.query(
      `UPDATE tenant_database_purge_predelete_receipts
          SET retained_billing_fact_root_sha256=?,receipt_sha256=? WHERE request_id=?`,
      [billingRootSha256, newPreDeleteReceipt.receiptSha256, requestId],
    );
    await conn.query(
      `UPDATE tenant_purge_session_grave_markers
          SET predelete_receipt_sha256=?,marker_sha256=? WHERE session_id=?`,
      [newPreDeleteReceipt.receiptSha256, newMarker.markerSha256, sessionId],
    );
    for (const ack of rewrittenAcks) {
      await conn.query(
        `UPDATE tenant_database_purge_domain_acks
            SET previous_global_ack_sha256=?,retained_evidence_root_sha256=?,
                operation_sha256=?,physical_proof_sha256=?,receipt_sha256=?
          WHERE request_id=? AND global_ack_seq=?`,
        [
          ack.previousGlobalAckSha256,
          ack.retainedEvidenceRootSha256,
          ack.operationSha256,
          ack.physicalProofSha256,
          ack.receiptSha256,
          requestId,
          ack.globalAckSeq,
        ],
      );
    }
    await conn.query(
      `UPDATE tenant_database_purge_receipts
          SET predelete_receipt_sha256=?,domain_ack_root_sha256=?,
              grave_marker_root_sha256=?,retained_billing_fact_root_sha256=?,
              prior_retained_billing_facts_json=?,prior_retained_billing_facts_sha256=?,
              receipt_sha256=? WHERE request_id=?`,
      [
        newPreDeleteReceipt.receiptSha256,
        domainAckRootSha256,
        graveRootSha256,
        billingRootSha256,
        newTerminalReceipt.priorRetainedBillingFacts === undefined ? null
          : JSON.stringify(newTerminalReceipt.priorRetainedBillingFacts),
        newTerminalReceipt.priorRetainedBillingFacts?.evidenceSha256 ?? null,
        newTerminalReceipt.receiptSha256,
        requestId,
      ],
    );
    await conn.query(
      `UPDATE tenant_database_purge_jobs
          SET predelete_receipt_sha256=?,domain_ack_root_sha256=?,terminal_receipt_sha256=?
        WHERE request_id=?`,
      [
        newPreDeleteReceipt.receiptSha256,
        domainAckRootSha256,
        newTerminalReceipt.receiptSha256,
        requestId,
      ],
    );
    await conn.query(
      `UPDATE tenant_database_purge_cutover
          SET first_receipt_sha256=?,evidence_sha256=? WHERE singleton_id=1`,
      [newTerminalReceipt.receiptSha256, newCutoverEvidenceSha256],
    );
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS=1");
  }
}

if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("MysqlSessionStore tenant database purge", () => {
    let baseUrl: URL;
    let database = "";
    type Profile = "base" | "telemetry" | "usage";
    const profiles: Readonly<Record<string, Profile>> = Object.freeze({
      "atomically deletes local database targets, retains billing, and replays concurrently": "base",
      "removes a sealed ordinary DELETE origin with its canonical session in T3f": "base",
      "accounts and removes an ordinary usage receipt through T1-T3f (mixed/rollback=false)": "usage",
      "accounts and removes an ordinary usage receipt through T1-T3f (mixed/rollback=true)": "usage",
      "captures every telemetry phase from canonical tenant, user and session owners before T3f delete": "telemetry",
      "reads an exact post-T3f managed-source candidate without granting telemetry execution": "telemetry",
      "serializes 0044 source-bound intent and exact-version claim across MySQL clients": "telemetry",
      "refuses 0044 marker loss under the newer 0049 predecessor guard": "telemetry",
      "rolls back 0044 intent and claim insert failures without publishing partial rows": "telemetry",
      "treats a lost zero-target 0042 receipt as unknown, not an empty-source candidate": "telemetry",
      "serializes a reserved telemetry write completion behind the T3f closure range lock": "telemetry",
      "rolls back a post-closure-publication failure and replays without partial evidence": "telemetry",
      "preserves a transient MySQL relation-query timeout for retry instead of an integrity block": "telemetry",
      "refuses T3f when a legacy or corrupted telemetry job has no immutable membership": "telemetry",
      "rejects a detached closure entry on read and verify-only startup": "telemetry",
      "rolls back targets and every T3f evidence row after an injected destructive failure": "base",
      "rejects same-id creation that overlaps an uncommitted grave and delete": "base",
      "rejects a post-T3e deleted/completed blob projection that is absent from T3d/T3e": "base",
      "rejects a same-count completed blob/outbox replacement with a different T3d root": "base",
      "rejects a same-count export artifact/part/outbox identity replacement after T3e": "base",
      "rejects terminal replay after billing and every dependent T3f hash are rewritten": "base"
});
    type Scope = { signal: AbortSignal; owner: CaptureMysqlRuntimeOwner; ready: boolean;
      failed: boolean; settled: boolean; detach: () => void; setup?: Promise<void>;
      work?: Promise<void>; closing?: Promise<void>; cleanupReported?: boolean;
      cleanupValidation?: CaptureMysqlCleanupValidation };
    const scopes = new Set<Scope>();
    let current: Scope | undefined;
    function scope(): Scope {
      if (!current) throw new Error("Tenant database purge case is not registered");
      return current;
    }
    function openStore(connectionLimit = 20): Promise<MysqlSessionStore> {
      const value = scope(); value.signal.throwIfAborted();
      return value.owner.openStore(connectionLimit, value.signal);
    }
    function openInspection(): Promise<CaptureMysqlInspection> {
      const value = scope(); value.signal.throwIfAborted();
      return value.owner.openInspection(value.signal);
    }
    async function finish(value: Scope): Promise<void> {
      value.closing ??= (async () => {
        const close = value.owner.close({ successful: value.ready && !value.failed && !value.signal.aborted,
          ...(value.cleanupValidation ? { cleanupValidation: value.cleanupValidation } : {}) });
        let failure: { reason: unknown } | undefined;
        try { await close; } catch (reason) { failure = { reason }; }
        await Promise.allSettled(value.setup ? [value.setup] : []);
        value.detach(); if (failure) throw failure.reason;
      })();
      try { await value.closing; }
      catch (reason) {
        if (!value.failed) { value.failed = true; throw reason; }
        if (!value.cleanupReported) {
          value.cleanupReported = true;
          try { console.warn("tenant_database_fixture_cleanup_failed_after_primary_failure"); }
          catch { /* Retain the original case failure. */ }
        }
      }
    }
    function runCase(body: () => Promise<void>) {
      return (): Promise<void> => {
        const value = scope();
        const work = Promise.resolve().then(async () => {
          try { value.signal.throwIfAborted(); await body(); value.signal.throwIfAborted(); }
          catch (reason) { value.failed = true; throw reason; }
        });
        value.work = work;
        void work.then(() => { value.settled = true; }, () => { value.settled = true; });
        return work;
      };
    }
    beforeAll(() => { baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL); });
    beforeEach(({ signal, task }) => {
      if ([...scopes].some(value => value.work && !value.settled)) throw new Error("Tenant database purge prior case is not settled");
      if (!Object.hasOwn(profiles, task.name)) throw new Error("Tenant database purge case profile is not explicit");
      const profile = profiles[task.name]!;
      const owner = new CaptureMysqlRuntimeOwner(baseUrl.toString(), {
        tenantTelemetryRefKey: profile === "telemetry" ? TELEMETRY_REF_KEY : null,
        tenantTelemetryPersistedProviderCaptureLocalOnly: false,
        tenantTelemetryCaptureRestoreLocalOnly: false,
        ...(profile === "usage" ? { tenantRedisPurgeNamespaceSha256: "7".repeat(64) } : {}),
      });
      const value: Scope = { signal, owner, ready: false, failed: false, settled: false, detach: () => {} };
      current = value; scopes.add(value); database = owner.database;
      const abort = () => { value.failed = true; void owner.close({ successful: false }).catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      value.detach = () => signal.removeEventListener("abort", abort); if (signal.aborted) abort();
      const work = Promise.resolve().then(async () => {
        try { signal.throwIfAborted(); await owner.prepare(); signal.throwIfAborted(); value.ready = true; }
        catch (reason) { value.failed = true; throw reason; }
      });
      value.setup = work; return work;
    });
    afterEach(async () => {
      const value = scope();
      await Promise.allSettled(value.work ? [value.work] : []); await finish(value);
    });
    afterAll(async () => {
      await Promise.allSettled([...scopes].flatMap(value => value.work ? [value.work] : []));
      const closed = await Promise.allSettled([...scopes].map(value => finish(value)));
      const error = closed.find(result => result.status === "rejected");
      if (error?.status === "rejected") throw error.reason;
    });
    async function withSessionAuthority<T>(store: MysqlSessionStore,
      session: Parameters<typeof acquireFixtureSessionAuthority>[1], expectedFence: number,
      body: (lease: Awaited<ReturnType<typeof acquireFixtureSessionAuthority>>) => Promise<T>): Promise<T> {
      const lease = await acquireFixtureSessionAuthority(store, session, expectedFence);
      let outcome: { ok: true; value: T } | { ok: false; reason: unknown };
      try { outcome = { ok: true, value: await body(lease) }; }
      catch (reason) { outcome = { ok: false, reason }; }
      try { await lease.release(); } catch (reason) { if (outcome.ok) outcome = { ok: false, reason }; }
      if (!outcome.ok) throw outcome.reason; return outcome.value;
    }

    type RepairTable = "tenant_telemetry_write_acks" | "tenant_telemetry_plan_artifact_target_receipts"
      | "tenant_telemetry_artifact_memberships" | "tenant_telemetry_owner_closure_receipts"
      | "billing_usage_facts" | "tenant_database_purge_jobs" | "tenant_database_purge_predelete_receipts"
      | "tenant_database_purge_domain_acks" | "tenant_database_purge_receipts"
      | "tenant_purge_session_grave_markers" | "tenant_database_purge_cutover";
    async function captureGuardRepair(observer: CaptureMysqlInspection, tables: readonly RepairTable[],
      event: "UPDATE" | "DELETE"): Promise<() => Promise<void>> {
      const allowed: readonly string[] = ["tenant_telemetry_write_acks", "tenant_telemetry_plan_artifact_target_receipts",
        "tenant_telemetry_artifact_memberships", "tenant_telemetry_owner_closure_receipts", "billing_usage_facts",
        "tenant_database_purge_jobs", "tenant_database_purge_predelete_receipts", "tenant_database_purge_domain_acks",
        "tenant_database_purge_receipts", "tenant_purge_session_grave_markers", "tenant_database_purge_cutover"];
      if (!tables.length || new Set(tables).size !== tables.length || tables.some(table => !allowed.includes(table))) {
        throw new Error("Tenant database purge guard repair scope is not closed");
      }
      const metadataSql = `SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,
        ACTION_TIMING AS timing,EVENT_MANIPULATION AS eventName,ACTION_ORDER AS actionOrder,
        ACTION_STATEMENT AS body,SQL_MODE AS sqlMode,DEFINER AS definer,
        CHARACTER_SET_CLIENT AS clientCharset,COLLATION_CONNECTION AS connectionCollation,
        DATABASE_COLLATION AS databaseCollation FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?)
        ORDER BY BINARY EVENT_OBJECT_TABLE,BINARY ACTION_TIMING,BINARY EVENT_MANIPULATION,ACTION_ORDER,BINARY TRIGGER_NAME`;
      const [context] = await observer.query<RowDataPacket[]>(`SELECT DATABASE() AS db,@@SESSION.sql_mode AS sqlMode,
        @@SESSION.character_set_client AS clientCharset,@@SESSION.collation_connection AS connectionCollation`);
      const ctx = context[0];
      if (context.length !== 1 || ctx?.db !== database || typeof ctx.sqlMode !== "string"
        || typeof ctx.clientCharset !== "string" || typeof ctx.connectionCollation !== "string") {
        throw new Error("Tenant database purge guard repair context is not owned");
      }
      const [before] = await observer.query<RowDataPacket[]>(metadataSql, [[...tables]]);
      const originals = new Map(before.map(row => [row.name as string, row]));
      if (originals.size !== before.length || !before.some(row => row.eventName === event)) throw new Error("Tenant database purge original guard set is missing");
      const definitions = new Map<string, string>();
      for (const row of before.filter(value => value.eventName === event)) {
        if (typeof row.name !== "string" || !/^[a-zA-Z0-9_]+$/.test(row.name)
          || typeof row.sqlMode !== "string" || typeof row.clientCharset !== "string"
          || typeof row.connectionCollation !== "string") throw new Error("Tenant database purge guard metadata is invalid");
        const [ddl] = await observer.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${row.name}\``);
        const sql = ddl[0]?.["SQL Original Statement"];
        if (ddl.length !== 1 || typeof sql !== "string" || !sql.startsWith("CREATE ") || ddl[0]?.sql_mode !== row.sqlMode) {
          throw new Error("Tenant database purge guard DDL is not exact");
        }
        definitions.set(row.name, sql);
      }
      return async () => {
        let failure: { reason: unknown } | undefined;
        try {
          const [actual] = await observer.query<RowDataPacket[]>(metadataSql, [[...tables]]);
          const present = new Map(actual.map(row => [row.name as string, row]));
          if (present.size !== actual.length || actual.some(row => !originals.has(row.name as string))) {
            throw new Error("Tenant database purge guard set acquired an unknown member");
          }
          const stable = (row: RowDataPacket) => { const { actionOrder: _order, ...body } = row; return JSON.stringify(body); };
          for (const row of actual) if (stable(row) !== stable(originals.get(row.name as string)!)) {
            throw new Error("Tenant database purge existing guard bytes changed");
          }
          const missing = before.filter(row => !present.has(row.name as string));
          if (missing.some(row => row.eventName !== event)) throw new Error("Tenant database purge unrelated guard is missing");
          // A removed first trigger renumbers survivors. Restore only the affected native group
          // in captured order, using every original DDL; never a guessed trigger body.
          const groups = new Set(missing.map(row => JSON.stringify([row.tableName,row.timing,row.eventName])));
          for (const group of groups) {
            const members = before.filter(row => JSON.stringify([row.tableName,row.timing,row.eventName]) === group);
            for (const row of members) if (present.has(row.name as string)) await observer.query(`DROP TRIGGER \`${row.name}\``);
            for (const row of members) {
              const ddl = definitions.get(row.name as string); if (!ddl) throw new Error("Tenant database purge original guard DDL is missing");
              await observer.query("SET SESSION sql_mode=?", [row.sqlMode]);
              await observer.query("SET SESSION character_set_client=?", [row.clientCharset]);
              await observer.query("SET SESSION collation_connection=?", [row.connectionCollation]);
              await observer.query(ddl);
            }
          }
        } catch (reason) { failure = { reason }; }
        for (const [name, value] of [["sql_mode",ctx.sqlMode],["character_set_client",ctx.clientCharset],
          ["collation_connection",ctx.connectionCollation]] as const) {
          try { await observer.query(`SET SESSION ${name}=?`, [value]); }
          catch (reason) { failure ??= { reason }; }
        }
        try {
          const [after] = await observer.query<RowDataPacket[]>(metadataSql, [[...tables]]);
          if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Tenant database purge complete guard metadata was not restored");
        } catch (reason) { failure ??= { reason }; }
        if (failure) throw failure.reason;
      };
    }
    async function withRestoredGuards(observer: CaptureMysqlInspection, tables: readonly RepairTable[],
      event: "UPDATE" | "DELETE", work: () => Promise<void>): Promise<void> {
      const restore = await captureGuardRepair(observer, tables, event);
      let failure: { reason: unknown } | undefined;
      try { await work(); } catch (reason) { failure = { reason }; }
      try { await restore(); } catch (reason) { failure ??= { reason }; }
      if (failure) throw failure.reason;
    }

    it("atomically deletes local database targets, retains billing, and replays concurrently", runCase(async () => {
      const first = await openStore(8);
      const second = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-success-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          first,
          conn,
          tenantId,
          `database-user-${randomUUID()}`,
        );
        const [receipt, replay] = await Promise.all([
          first.executeTenantDatabasePurge(source.authorization),
          second.executeTenantDatabasePurge(source.authorization),
        ]);
        expect(replay).toEqual(receipt);
        expect(receipt).toMatchObject({
          localDatabasePurgeComplete: true,
          sessionContentDeleted: true,
          allDomainsComplete: false,
          contentPurgeExecuted: false,
          retainedBillingFactCount: 1,
          graveMarkerCount: 1,
        });
        expect(await first.getTenantDatabasePurgePreDeleteEntries(
          tenantId,
          source.requestId,
          1,
        )).toHaveLength(11);
        expect(await first.getTenantDatabasePurgeDomainAcks(
          tenantId,
          source.requestId,
          1,
        )).toHaveLength(11);
        expect(await first.getTenantPurgeSessionGraveMarker(tenantId, source.session.id))
          .toMatchObject({ sessionId: source.session.id, deletionGeneration: 1 });
        expect(await first.getTenantTelemetryOwnerClosureEntries(
          tenantId, source.requestId,
        )).toEqual([]);
        expect(await first.getTenantTelemetryOwnerClosureReceipt(
          tenantId, source.requestId,
        )).toMatchObject({
          entryCount: 0,
          t3fReceiptSha256: receipt?.receiptSha256,
        });
        expect(await first.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toMatchObject({ status: "unknown", managedArtifactCount: null,
          executionReady: false, externalAuthorityVerified: false });
        expect(await first.getTenantTelemetrySourceEligibility(
          "another-tenant", source.requestId,
        )).toBeNull();
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT t.name, t.auth_policy, t.auth_secret_cipher, t.auth_secret_key_id,
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM billing_usage_facts WHERE tenant_id=?) AS billing
           FROM tenants t WHERE t.tenant_id=?`,
          [tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          name: null,
          auth_policy: null,
          auth_secret_cipher: null,
          auth_secret_key_id: null,
          sessions: 0,
          billing: 1,
        });
        expect(await first.executeTenantDatabasePurge(source.authorization)).toEqual(receipt);
        const verified = await openStore();
        await verified.close();
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    }));

    it("removes a sealed ordinary DELETE origin with its canonical session in T3f", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-grace-t3f-${randomUUID()}`;
      const userId = `user-grace-t3f-${randomUUID()}`;
      let ordinarySessionId = "";
      try {
        const source = await advanceToDatabasePurgeClaim(store, conn, tenantId, userId, {
          beforeTenantErasure: async (sessionId) => {
            ordinarySessionId = sessionId;
            const atMs = Date.now();
            await withSessionAuthority(store, { id: sessionId, tenantId, userId }, 0, async lease => {
              await store.commitOrdinarySessionDelete(lease.admit<Parameters<MysqlSessionStore["commitOrdinarySessionDelete"]>[0]>({
                sessionId, fence: 1,
                lifecycle: { type: "tombstone", tenantId, userId, atMs,
                  purgeAfterMs: null, deletionGeneration: 1,
                },
                events: [{ type: "session/deleted", sessionId,
                  emittedAtMs: atMs, deletionGeneration: 1 }],
              }));
            });
            await store.sealOrdinarySessionDeleteGrace(tenantId, userId, sessionId);
            await completeOrdinaryTombstoneOutbox(store, sessionId);
            expect(await store.getOrdinarySessionDeleteGrace(tenantId, userId, sessionId))
              .toMatchObject({ state: "sealed", executionReady: false });
          },
        });
        expect(await store.executeTenantDatabasePurge(source.authorization)).toMatchObject({
          localDatabasePurgeComplete: true, sessionContentDeleted: true,
          allDomainsComplete: false, contentPurgeExecuted: false,
        });
        expect(await store.getOrdinarySessionDeleteGrace(tenantId, userId, ordinarySessionId))
          .toBeNull();
        await expect(store.sealOrdinarySessionDeleteGrace(tenantId, userId, ordinarySessionId))
          .resolves.toBeUndefined();
        expect(await store.getOrdinarySessionDeleteGrace(tenantId, userId, ordinarySessionId))
          .toBeNull();
        const [rows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM sessions WHERE tenant_id=? OR session_id=?",
          [tenantId, ordinarySessionId],
        );
        expect(Number(rows[0]?.n)).toBe(0);
        expect(await store.getTenantPurgeSessionGraveMarker(tenantId, ordinarySessionId))
          .toMatchObject({ sessionId: ordinarySessionId, deletionGeneration: 1 });
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it.each([false, true])("accounts and removes an ordinary usage receipt through T1-T3f (mixed/rollback=%s)", (injectFailure) => runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-ordinary-usage-t3f-${randomUUID()}`;
      const userId = `user-ordinary-usage-t3f-${randomUUID()}`;
      // Each checkout still reads the real MySQL CURRENT_TIMESTAMP(3). Move only this disposable
      // fixture's session clock; never rewrite protected origin/seal/retention evidence.
      let clockMs = Date.now() + 100;
      const pool = (store as unknown as { pool: { getConnection(): Promise<mysql.PoolConnection> } }).pool;
      const originalCheckout = pool.getConnection.bind(pool);
      pool.getConnection = async () => {
        const connection = await originalCheckout();
        clockMs += 5;
        await connection.query("SET timestamp=?", [clockMs / 1000]);
        return connection;
      };
      try {
        const source = await advanceToDatabasePurgeClaim(store, conn, tenantId, userId, {
          beforeTenantErasure: async (sessionId) => {
            const atMs = Date.now();
            await withSessionAuthority(store, { id: sessionId, tenantId, userId }, 0, async lease => {
              await store.commitOrdinarySessionDelete(lease.admit<Parameters<MysqlSessionStore["commitOrdinarySessionDelete"]>[0]>({ sessionId, fence: 1,
                lifecycle: { type: "tombstone", tenantId, userId, atMs,
                  purgeAfterMs: null, deletionGeneration: 1 },
                events: [{ type: "session/deleted", sessionId, emittedAtMs: atMs,
                  deletionGeneration: 1 }],
              }));
            });
            await store.sealOrdinarySessionDeleteGrace(tenantId, userId, sessionId);
            const owner = { tenantId, userId, sessionId, deletionGeneration: 1 };
            const reconciliation = await store.reconcileSessionUsage({ ...owner, nowMs: atMs });
            clockMs += ORDINARY_SESSION_DELETE_GRACE_MS + 86_400_000;
            expect(await store.executeOrdinarySessionUsageRetention({ ...owner,
              expectedChecksum: reconciliation.checksum, enabled: true })).toMatchObject({
              facts: [{ usageId: expect.any(String), factSha256: expect.any(String) }],
              allDomainsComplete: false, contentPurgeExecuted: false,
            });
            await completeOrdinaryTombstoneOutbox(store, sessionId);
            if (injectFailure) {
              const live = mkSession(tenantId, `ordinary-usage-live-${randomUUID()}`);
              await store.createSession(live);
              await withSessionAuthority(store, live, 0, async lease => {
                await store.commit(lease.admit<Parameters<MysqlSessionStore["commit"]>[0]>({ sessionId: live.id, fence: 1,
                  usageEntries: [{ usageId: newUsageId(), turnId: newId("turn"), step: 1,
                    provider: "live-provider", model: "live-model",
                    usage: { ...emptyUsage(), outputTokens: 3, totalTokens: 3, costCNY: 2 },
                    createdAtMs: Date.now() }],
                }));
              });
            }
          },
        });
        const [proofRows] = await conn.query<RowDataPacket[]>(
          `SELECT ordinary_usage_retention_source_json,ordinary_usage_retention_source_sha256,
                  ordinary_usage_retention_receipt_json,ordinary_usage_retention_receipt_sha256
             FROM sessions WHERE session_id=?`, [source.session.id],
        );
        const proofBefore = structuredClone(proofRows[0]!);
        expect(proofBefore.ordinary_usage_retention_source_json).not.toBeNull();
        expect(proofBefore.ordinary_usage_retention_receipt_json).not.toBeNull();
        const ordinaryReceipt = typeof proofBefore.ordinary_usage_retention_receipt_json === "string"
          ? JSON.parse(proofBefore.ordinary_usage_retention_receipt_json)
          : proofBefore.ordinary_usage_retention_receipt_json;
        const [billingBefore] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id", [tenantId],
        );
        expect(billingBefore).toHaveLength(injectFailure ? 2 : 1);
        const sessionReceipts = await store.getTenantSessionContentReceipts(tenantId, source.requestId, 1);
        const sessionReceipt = sessionReceipts.find((receipt) => receipt.sessionId === source.session.id);
        expect(sessionReceipt?.sessionId).toBe(source.session.id);
        const tuples = sessionReceipts.map((receipt) => [receipt.sessionId, receipt.receiptSha256,
          ...(receipt.sessionId === source.session.id ? ["ordinary-usage-retention-v2", source.session.id,
            String(proofBefore.ordinary_usage_retention_source_sha256),
            String(proofBefore.ordinary_usage_retention_receipt_sha256)] : [])]);
        const planEntry = (await store.getTenantPurgePlanEntries(tenantId, source.requestId, 1))
          .find((entry) => entry.domain === "session_content")!;
        expect(planEntry.targetRootSha256).toBe(tenantPurgePlanTargetRootSha256("session_content",
          tuples.map((tuple) => tenantPurgePlanTargetSha256("session_content", tuple))));
        if (injectFailure) {
          const priorFact = billingBefore.find((row) => row.usage_id === ordinaryReceipt.facts[0].usageId)!;
          const crossTenantFactBody = {
            usageId: String(priorFact.usage_id), tenantId: "another-tenant",
            accountingPeriod: String(priorFact.accounting_period),
            provider: String(priorFact.provider), model: String(priorFact.model),
            inputTokens: Number(priorFact.input_tokens), outputTokens: Number(priorFact.output_tokens),
            cacheReadTokens: Number(priorFact.cache_read_tokens),
            cacheWriteTokens: Number(priorFact.cache_write_tokens),
            reasoningTokens: Number(priorFact.reasoning_tokens), totalTokens: Number(priorFact.total_tokens),
            ...(priorFact.cost_cny == null ? {} : { costCNY: Number(priorFact.cost_cny) }),
            currency: "CNY" as const,
          };
          // These corruptions must be rejected at the source-boundary validation;
          // they do not claim to exercise a later bridge-only authorization path.
          for (const corruption of ["missing", "cross-tenant", "digest"] as const) {
            if (corruption === "missing") {
              await conn.query("DELETE FROM billing_usage_facts WHERE usage_id=?", [priorFact.usage_id]);
            } else {
              await conn.query("UPDATE billing_usage_facts SET tenant_id=?,fact_sha256=? WHERE usage_id=?", [
                corruption === "cross-tenant" ? "another-tenant" : tenantId,
                corruption === "cross-tenant" ? computeBillingUsageFactSha256(crossTenantFactBody) : "f".repeat(64),
                priorFact.usage_id,
              ]);
            }
            try {
              await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
              const [proofAfterCorruption] = await conn.query<RowDataPacket[]>(
                `SELECT ordinary_usage_retention_source_json,ordinary_usage_retention_source_sha256,
                        ordinary_usage_retention_receipt_json,ordinary_usage_retention_receipt_sha256
                   FROM sessions WHERE session_id=?`, [source.session.id],
              );
              expect(proofAfterCorruption).toEqual([proofBefore]);
              expect(await store.getTenantDatabasePurgeReceipt(tenantId, source.requestId)).toBeNull();
              expect(await store.getTenantPurgeSessionGraveMarker(tenantId, source.session.id)).toBeNull();
            } finally {
              if (corruption === "missing") {
                await conn.query("INSERT INTO billing_usage_facts SET ?", [{ ...priorFact }]);
              } else {
                await conn.query("UPDATE billing_usage_facts SET tenant_id=?,fact_sha256=? WHERE usage_id=?", [
                  priorFact.tenant_id, priorFact.fact_sha256, priorFact.usage_id,
                ]);
              }
            }
            const [billingAfterCorruption] = await conn.query<RowDataPacket[]>(
              "SELECT * FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id", [tenantId],
            );
            expect(billingAfterCorruption).toEqual(billingBefore);
          }
          const internal = store as unknown as { deleteTenantDatabasePurgeTargets(...args: unknown[]): Promise<void> };
          const originalDelete = internal.deleteTenantDatabasePurgeTargets;
          internal.deleteTenantDatabasePurgeTargets = async (...args) => {
            await originalDelete.apply(store, args);
            throw new Error("injected ordinary usage T3f destructive failure");
          };
          try {
            await expect(store.executeTenantDatabasePurge(source.authorization))
              .rejects.toThrow("injected ordinary usage T3f destructive failure");
          } finally {
            internal.deleteTenantDatabasePurgeTargets = originalDelete;
          }
          const [afterFailure] = await conn.query<RowDataPacket[]>(
            `SELECT ordinary_usage_retention_source_json,ordinary_usage_retention_source_sha256,
                    ordinary_usage_retention_receipt_json,ordinary_usage_retention_receipt_sha256
               FROM sessions WHERE session_id=?`, [source.session.id],
          );
          expect(afterFailure).toEqual([proofBefore]);
          const [billingAfterFailure] = await conn.query<RowDataPacket[]>(
            "SELECT * FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id", [tenantId],
          );
          expect(billingAfterFailure).toEqual(billingBefore);
          expect(await store.getTenantDatabasePurgeReceipt(tenantId, source.requestId)).toBeNull();
          expect(await store.getTenantPurgeSessionGraveMarker(tenantId, source.session.id)).toBeNull();
        }
        if (injectFailure) {
          const originalExecute = store.executeTenantDatabasePurge.bind(store);
          store.executeTenantDatabasePurge = async (authorization) => {
            await originalExecute(authorization);
            throw new Error("injected committed ordinary usage T3f response loss");
          };
          try {
            await expect(store.executeTenantDatabasePurge(source.authorization))
              .rejects.toThrow("injected committed ordinary usage T3f response loss");
          } finally {
            store.executeTenantDatabasePurge = originalExecute;
          }
        }
        const terminal = await store.executeTenantDatabasePurge(source.authorization);
        expect(terminal).toMatchObject({ localDatabasePurgeComplete: true, sessionContentDeleted: true,
          retainedBillingFactCount: injectFailure ? 2 : 1, allDomainsComplete: false, contentPurgeExecuted: false });
        expect(terminal?.priorRetainedBillingFacts?.facts).toEqual(ordinaryReceipt.facts);
        expect(JSON.stringify(terminal?.priorRetainedBillingFacts)).not.toContain(source.session.id);
        expect(JSON.stringify(terminal?.priorRetainedBillingFacts)).not.toContain(userId);
        const contentEntry = (await store.getTenantDatabasePurgePreDeleteEntries(tenantId,
          source.requestId, 1)).find((entry) => entry.domain === "session_content")!;
        expect(contentEntry.preDeleteTargetRootSha256).toBe(tenantDatabasePurgeTargetRootSha256("session_content",
          tuples.map((tuple) => tenantDatabasePurgeTargetSha256("session_content", tuple))));
        const [remaining] = await conn.query<RowDataPacket[]>(
          `SELECT (SELECT COUNT(*) FROM sessions WHERE session_id=?) AS sessions,
                  (SELECT COUNT(*) FROM events WHERE session_id=?) AS events,
                  (SELECT COUNT(*) FROM usage_reconciliations WHERE session_id=?) AS reconciliations,
                  (SELECT COUNT(*) FROM usage_ledger WHERE session_id=?) AS operational`,
          [source.session.id, source.session.id, source.session.id, source.session.id],
        );
        expect(remaining[0]).toMatchObject({ sessions: 0, events: 0, reconciliations: 0, operational: 0 });
        const [billingAfter] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id", [tenantId],
        );
        expect(billingAfter).toEqual(billingBefore);
        const grave = await store.getTenantPurgeSessionGraveMarker(tenantId, source.session.id);
        expect(grave).toMatchObject({ sessionId: source.session.id, deletionGeneration: 1,
          ordinaryUsageRetention: { sourceSha256: proofBefore.ordinary_usage_retention_source_sha256,
            receiptSha256: proofBefore.ordinary_usage_retention_receipt_sha256 } });
        expect(grave?.markerSha256).toBe(tenantDatabasePurgeSessionGraveMarkerSha256(grave!));
        expect(await store.executeTenantDatabasePurge(source.authorization)).toEqual(terminal);
        if (injectFailure) {
          await expect(conn.query(
            `UPDATE tenant_database_purge_receipts
                SET prior_retained_billing_facts_json=NULL,prior_retained_billing_facts_sha256=NULL
              WHERE request_id=?`, [source.requestId],
          )).rejects.toThrow(/append-only/);
          await expect(conn.query(
            `UPDATE tenant_purge_session_grave_markers
                SET ordinary_usage_retention_source_sha256=? WHERE session_id=?`,
            ["f".repeat(64), source.session.id],
          )).rejects.toThrow(/append-only/);
          expect(await store.executeTenantDatabasePurge(source.authorization)).toEqual(terminal);
          const [updateGuards] = await conn.query<RowDataPacket[]>(
            `SELECT trigger_name AS trigger_name FROM information_schema.triggers
              WHERE trigger_schema=DATABASE() AND event_manipulation='UPDATE'
                AND event_object_table IN ('tenant_database_purge_receipts','tenant_purge_session_grave_markers')`,
          );
          const savedGuards: { name: string; ddl: string }[] = [];
          for (const guard of updateGuards) {
            const name = String(guard.trigger_name ?? guard.TRIGGER_NAME);
            if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("unsafe terminal fixture trigger name");
            const [ddlRows] = await conn.query<RowDataPacket[]>(`SHOW CREATE TRIGGER \`${name}\``);
            const ddl = ddlRows[0]?.["SQL Original Statement"];
            if (typeof ddl !== "string" || !ddl.startsWith("CREATE ")) throw new Error("missing terminal fixture guard DDL");
            savedGuards.push({ name, ddl });
          }
          expect(savedGuards.length).toBeGreaterThan(0);
          const droppedGuards: typeof savedGuards = [];
          // Privileged drift is simulated only in this disposable schema. Preserve the exact
          // original CREATE statements and restore both data and guards even on assertion failure.
          try {
            for (const guard of savedGuards) {
              await conn.query(`DROP TRIGGER \`${guard.name}\``);
              droppedGuards.push(guard);
            }
            for (const corruption of ["bridge-missing", "bridge-digest", "bridge-fact",
              "grave-source", "grave-receipt"] as const) {
              const changedBridge = structuredClone(terminal!.priorRetainedBillingFacts!);
              if (corruption === "bridge-digest") changedBridge.evidenceSha256 = "f".repeat(64);
              if (corruption === "bridge-fact") changedBridge.facts[0]!.factSha256 = "f".repeat(64);
              await conn.query(
                `UPDATE tenant_database_purge_receipts
                    SET prior_retained_billing_facts_json=?,prior_retained_billing_facts_sha256=?
                  WHERE request_id=?`,
                [corruption === "bridge-missing" ? null : JSON.stringify(changedBridge),
                  corruption === "bridge-missing" ? null : changedBridge.evidenceSha256, source.requestId],
              );
              await conn.query(
                `UPDATE tenant_purge_session_grave_markers
                    SET ordinary_usage_retention_source_sha256=?,ordinary_usage_retention_receipt_sha256=?
                  WHERE session_id=?`,
                [corruption === "grave-source" ? "f".repeat(64) : grave!.ordinaryUsageRetention!.sourceSha256,
                  corruption === "grave-receipt" ? "f".repeat(64) : grave!.ordinaryUsageRetention!.receiptSha256,
                  source.session.id],
              );
              await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toThrow();
              const [billingAfterDrift] = await conn.query<RowDataPacket[]>(
                "SELECT * FROM billing_usage_facts WHERE tenant_id=? ORDER BY usage_id", [tenantId],
              );
              expect(billingAfterDrift).toEqual(billingBefore);
            }
          } finally {
            if (droppedGuards.length === savedGuards.length) {
              await conn.query(
                `UPDATE tenant_database_purge_receipts
                    SET prior_retained_billing_facts_json=?,prior_retained_billing_facts_sha256=?
                  WHERE request_id=?`,
                [JSON.stringify(terminal!.priorRetainedBillingFacts),
                  terminal!.priorRetainedBillingFacts!.evidenceSha256, source.requestId],
              );
              await conn.query(
                `UPDATE tenant_purge_session_grave_markers
                    SET ordinary_usage_retention_source_sha256=?,ordinary_usage_retention_receipt_sha256=?
                  WHERE session_id=?`,
                [grave!.ordinaryUsageRetention!.sourceSha256, grave!.ordinaryUsageRetention!.receiptSha256,
                  source.session.id],
              );
            }
            for (const guard of droppedGuards) await conn.query(guard.ddl);
          }
          expect(await store.executeTenantDatabasePurge(source.authorization)).toEqual(terminal);
        }
        expect(await store.materializeTenantRedisPurgeJobs({ limit: 10 })).toBe(1);
        expect(await store.claimTenantRedisPurges({ limit: 10, leaseMs: 120_000,
          claimToken: `ordinary-usage-redis-${randomUUID()}` })).toHaveLength(1);
        const redisTargets = await store.getTenantRedisPurgeTargets(tenantId, source.requestId, 1);
        expect(redisTargets.find((targetRow) => targetRow.sessionId === source.session.id)?.graveMarkerSha256)
          .toBe(grave?.markerSha256);
        expect(await store.executeTenantDatabasePurge(source.authorization)).toEqual(terminal);
      } finally {
        pool.getConnection = originalCheckout;
        await conn.end();
        await store.close();
      }
    })());

    it("captures every telemetry phase from canonical tenant, user and session owners before T3f delete", runCase(async () => {
      const store = await openStore(12);
      const conn = await openInspection();
      const tenantId = `tenant-database-telemetry-${randomUUID()}`;
      const userId = `telemetry-user-${randomUUID()}`;
      const operations: string[] = [];
      try {
        await activateTelemetryForT3f(store);
        const source = await advanceToDatabasePurgeClaim(store, conn, tenantId, userId, {
          beforeTenantErasure: async (sessionId) => {
            for (const [marker, owner] of [
              ["queued", { kind: "tenant", id: tenantId, userId: null }],
              ["reserved", { kind: "user", id: userId, userId }],
              ["written", { kind: "session", id: sessionId, userId }],
              ["blocked", { kind: "tenant", id: tenantId, userId: null }],
            ] as const) {
              const job = await queueTelemetryForT3f(store, tenantId, marker, owner);
              operations.push(job.writeOperationSha256);
            }
            const claims = await store.claimTenantTelemetryWriteJobs({
              limit: 3,
              leaseMs: 120_000,
              claimToken: `telemetry-closure-${randomUUID()}`,
              adapterProtocol: "telemetry-test-v1",
            });
            expect(claims).toHaveLength(3);
            expect(await store.reserveTenantTelemetryExternalMutation(
              telemetryAuthorization(claims[0]!), "telemetry-test-v1",
            )).not.toBeNull();
            expect(await store.reserveTenantTelemetryExternalMutation(
              telemetryAuthorization(claims[1]!), "telemetry-test-v1",
            )).not.toBeNull();
            const written = claims[1]!;
            expect(await store.completeTenantTelemetryWrite(
              telemetryAuthorization(written), telemetryAdapterResult(written),
            )).not.toBeNull();
            expect(await store.blockTenantTelemetryWrite(
              telemetryAuthorization(claims[2]!),
            )).toBe(true);
          },
        });
        const [phases] = await conn.query<RowDataPacket[]>(
          "SELECT phase,mutation_reservation_receipt_sha256 FROM tenant_telemetry_write_jobs WHERE tenant_id=?",
          [tenantId],
        );
        expect(phases.filter((row) => row.phase === "written")).toHaveLength(1);
        expect(phases.filter((row) => row.phase === "blocked")).toHaveLength(1);
        expect(phases.filter((row) => row.phase === "queued"
          && row.mutation_reservation_receipt_sha256))
          .toHaveLength(1);
        expect(phases.filter((row) => row.phase === "queued"
          && !row.mutation_reservation_receipt_sha256))
          .toHaveLength(1);

        const terminal = await store.executeTenantDatabasePurge(source.authorization);
        expect(terminal?.allDomainsComplete).toBe(false);
        const entries = await store.getTenantTelemetryOwnerClosureEntries(
          tenantId, source.requestId,
        );
        const closure = await store.getTenantTelemetryOwnerClosureReceipt(
          tenantId, source.requestId,
        );
        expect(entries.map((entry) => entry.writeOperationSha256).sort())
          .toEqual(operations.sort());
        expect(entries.map((entry) => entry.ownerKind).sort())
          .toEqual(["session", "tenant", "tenant", "user"]);
        expect(closure).toMatchObject({
          entryCount: 4,
          entryRootSha256: tenantTelemetryOwnerClosureEntryRootSha256(entries),
          t3fReceiptSha256: terminal?.receiptSha256,
        });
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toMatchObject({ status: "unknown", managedArtifactCount: null,
          executionReady: false, externalAuthorityVerified: false });
        const grave = await store.getTenantPurgeSessionGraveMarker(tenantId, source.session.id);
        expect(entries.find((entry) => entry.ownerKind === "session")
          ?.sessionGraveMarkerSha256).toBe(grave?.markerSha256);
        expect(entries.every((entry) => entry.refKeyIdSha256
          === tenantTelemetryRefKeyIdSha256(TELEMETRY_REF_KEY))).toBe(true);
        expect(JSON.stringify({ entries, closure })).not.toContain(userId);
        expect(JSON.stringify({ entries, closure })).not.toContain(source.session.id);
        expect(await store.getTenantTelemetryOwnerClosureReceipt(
          "another-tenant", source.requestId,
        )).toBeNull();
        expect(await store.getTenantTelemetryOwnerClosureEntries(
          "another-tenant", source.requestId,
        )).toEqual([]);
        expect(await store.executeTenantDatabasePurge(source.authorization)).toEqual(terminal);
        const restarted = await openStore();
        try {
          expect(await restarted.getTenantTelemetryOwnerClosureReceipt(
            tenantId, source.requestId,
          )).toEqual(closure);
        } finally {
          await restarted.close();
        }
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("reads an exact post-T3f managed-source candidate without granting telemetry execution", runCase(async () => {
      const store = await openStore(12);
      const conn = await openInspection();
      const tenantId = `tenant-database-0043-candidate-${randomUUID()}`;
      const userId = `0043-user-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        const producer = await activateLogsCaptureForT3f(store);
        const source = await advanceToDatabasePurgeClaim(store, conn, tenantId, userId, {
          beforeTenantErasure: async (sessionId) => {
            await queueTelemetryForT3f(store, tenantId, "0043-tenant",
              { kind: "tenant", id: tenantId, userId: null }, producer);
            await queueTelemetryForT3f(store, tenantId, "0043-session",
              { kind: "session", id: sessionId, userId }, producer);
            const claims = await store.claimTenantTelemetryWriteJobs({
              limit: 2, leaseMs: 120_000,
              claimToken: `0043-write-${randomUUID()}`,
              adapterProtocol: "telemetry-test-v1",
            });
            expect(claims).toHaveLength(2);
            for (const claim of claims) {
              const authorization = telemetryAuthorization(claim);
              expect(await store.reserveTenantTelemetryExternalMutation(
                authorization, "telemetry-test-v1",
              )).not.toBeNull();
              expect(await store.completeTenantTelemetryWrite(
                authorization, telemetryAdapterResult(claim),
              )).not.toBeNull();
            }
          },
          beforeExecutionClaim: async (requestId) => {
            const internal = store as unknown as Record<string,
              (...args: unknown[]) => Promise<unknown>>;
            const retryableAt = async (method: string, code: string, errno: number,
              injectOnCall = 1) => {
              const original = internal[method];
              if (typeof original !== "function") throw new Error("missing transient test hook");
              const transient = Object.assign(new Error("injected transient source lock"), {
                code, errno, sqlState: code === "ER_LOCK_DEADLOCK" ? "40001" : "HY000",
              });
              let calls = 0;
              internal[method] = async (...args) => {
                calls += 1;
                if (calls === injectOnCall) throw transient;
                return original.apply(store, args);
              };
              try {
                await expect(store.claimTenantPurgeExecutions({
                  limit: 1, leaseMs: 120_000, claimToken: `0043-transient-${randomUUID()}`,
                })).rejects.toBe(transient);
                expect(calls).toBeGreaterThanOrEqual(injectOnCall);
              } finally {
                internal[method] = original;
              }
              const [rows] = await conn.query<RowDataPacket[]>(
                "SELECT phase,attempts,blocked_reason_code FROM tenant_purge_execution_jobs WHERE request_id=?",
                [requestId],
              );
              expect(rows).toMatchObject([{ phase: "queued", attempts: 0,
                blocked_reason_code: null }]);
            };
            await retryableAt("readTenantTelemetrySourceProjection", "ER_LOCK_WAIT_TIMEOUT", 1205);
            await retryableAt("loadValidatedActiveRetentionPolicy", "ER_LOCK_DEADLOCK", 1213);
            await retryableAt("loadLegalHoldContextForLifecycle", "ER_LOCK_WAIT_TIMEOUT", 1205);
            // First plan-entry read precedes the 0042 catalog proof; the second is inside it.
            await retryableAt("loadTenantPurgePlanEntries", "ER_LOCK_DEADLOCK", 1213, 2);
          },
        });
        expect(await store.getTenantTelemetryPlanArtifactTargetReceipt(
          tenantId, source.requestId,
        )).toMatchObject({ targetCount: 2, unknownGroupCount: 0,
          executionReady: false });
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toMatchObject({ status: "unknown", managedArtifactCount: null,
          executionReady: false, externalAuthorityVerified: false });
        expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
        const candidate = await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        );
        expect(candidate).toEqual({ status: "local_source_candidate", managedArtifactCount: 2,
          executionReady: false, externalAuthorityVerified: false });
        expect(JSON.stringify(candidate)).not.toContain(tenantId);
        expect(JSON.stringify(candidate)).not.toContain(userId);
        expect(JSON.stringify(candidate)).not.toContain(source.session.id);
        expect(await store.getTenantTelemetrySourceEligibility(
          "another-tenant", source.requestId,
        )).toBeNull();
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, newErasureRequestId(),
        )).toBeNull();

        // The diagnostic read locks the T3f row before consulting mutable local gates.
        // A concurrent X-lock must delay the entire proof; releasing it leaves no writes.
        await conn.beginTransaction();
        await conn.query(
          "SELECT request_id FROM tenant_database_purge_jobs WHERE request_id=? FOR UPDATE",
          [source.requestId],
        );
        const pending = store.getTenantTelemetrySourceEligibility(tenantId, source.requestId);
        await waitForDatabasePurgeLockWaiter(conn, database);
        await conn.rollback();
        expect(await within(pending, 5_000, "0043 diagnostic read after T3f lock"))
          .toEqual(candidate);

        // An exception after lock acquisition rolls back the read transaction and releases
        // every shared source range, so the same exact proof can be retried unchanged.
        const internal = store as unknown as {
          readTenantTelemetrySourceProjection: (...args: unknown[]) => Promise<unknown>;
        };
        const original = internal.readTenantTelemetrySourceProjection;
        internal.readTenantTelemetrySourceProjection = async () => {
          throw new Error("injected 0043 diagnostic read failure");
        };
        await expect(store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).rejects.toThrow("injected 0043 diagnostic read failure");
        internal.readTenantTelemetrySourceProjection = original;
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toEqual(candidate);
        await expect(conn.query(
          "UPDATE tenant_telemetry_write_acks SET adapter_evidence_sha256=? WHERE tenant_id=? LIMIT 1",
          ["e".repeat(64), tenantId],
        )).rejects.toThrow("tenant telemetry write ACK is immutable");
        await withRestoredGuards(conn, ["tenant_telemetry_write_acks"], "UPDATE", async () => {
        await conn.query("DROP TRIGGER trg_managed_telemetry_write_acks_bu");
        await conn.query(
          "UPDATE tenant_telemetry_write_acks SET adapter_evidence_sha256=? WHERE tenant_id=? LIMIT 1",
          ["e".repeat(64), tenantId],
        );
        await expect(store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).rejects.toThrow();
        });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("serializes 0044 source-bound intent and exact-version claim across MySQL clients", runCase(async () => {
      const first = await openStore(12);
      const second = await openStore(12);
      const conn = await openInspection();
      const tenantId = `tenant-database-0044-${randomUUID()}`;
      try {
        const { source, target } = await advanceToTelemetryPregrantSource(
          first, conn, tenantId,
        );
        const requestId = source.requestId;
        const group = target.artifactGroupSha256;
        const [intent, replay] = await within(Promise.all([
          first.prepareTenantTelemetryPregrantIntent(tenantId, requestId, group),
          second.prepareTenantTelemetryPregrantIntent(tenantId, requestId, group),
        ]), 20_000, "concurrent pregrant prepare");
        expect(intent).not.toBeNull();
        expect(replay).toEqual(intent);
        expect(intent).toMatchObject({ tenantId, requestId, artifactGroupSha256: group,
          catalogEntryReceiptSha256: target.receiptSha256, grantReady: false });
        expect(await second.getTenantTelemetryPregrantIntent(tenantId, requestId, group))
          .toEqual(intent);
        expect(await first.prepareTenantTelemetryPregrantIntent(
          "another-tenant", requestId, group,
        )).toBeNull();
        expect(await second.getTenantTelemetryPregrantIntent(
          "another-tenant", requestId, group,
        )).toBeNull();
        expect(await first.prepareTenantTelemetryPregrantIntent(
          tenantId, requestId, "f".repeat(64),
        )).toBeNull();
        expect(await first.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, "f".repeat(64), "wrong-version", 1_000,
        )).toBeNull();
        expect(await first.claimTenantTelemetryPregrantIntent(
          "another-tenant", requestId, group, intent!.intentSha256, "cross-tenant", 1_000,
        )).toBeNull();

        const [firstClaim, secondClaim] = await within(Promise.all([
          first.claimTenantTelemetryPregrantIntent(
            tenantId, requestId, group, intent!.intentSha256, "claim-first", 10_000,
          ),
          second.claimTenantTelemetryPregrantIntent(
            tenantId, requestId, group, intent!.intentSha256, "claim-second", 10_000,
          ),
        ]), 20_000, "concurrent pregrant claim");
        expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
        const winner = firstClaim ?? secondClaim;
        const winnerToken = firstClaim ? "claim-first" : "claim-second";
        expect(winner).toMatchObject({ intentSha256: intent!.intentSha256,
          attempt: 1, grantReady: false });
        expect(JSON.stringify(winner)).not.toContain(winnerToken);
        expect(await first.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, intent!.intentSha256, winnerToken, 10_000,
        )).toEqual(winner);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_intents WHERE tenant_id=?) AS intents,
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_claims WHERE tenant_id=?) AS claims,
             (SELECT COUNT(*) FROM tenant_telemetry_disposition_authorization_grants WHERE tenant_id=?) AS grants`,
          [tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ intents: 1, claims: 1, grants: 0 });
        expect(JSON.stringify({ intent, winner })).not.toContain(source.session.id);

        const restarted = await openStore();
        try {
          expect(await restarted.getTenantTelemetryPregrantIntent(
            tenantId, requestId, group,
          )).toEqual(intent);
        } finally {
          await restarted.close();
        }

        // A changed local source invalidates every read/replay path; durable intent/claim
        // remain evidence, never authority to continue through the drift.
        await withRestoredGuards(conn, ["tenant_telemetry_write_acks"], "UPDATE", async () => {
        await conn.query("DROP TRIGGER trg_managed_telemetry_write_acks_bu");
        await conn.query(
          "UPDATE tenant_telemetry_write_acks SET adapter_evidence_sha256=? WHERE tenant_id=? LIMIT 1",
          ["e".repeat(64), tenantId],
        );
        await expect(first.getTenantTelemetryPregrantIntent(tenantId, requestId, group))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(first.prepareTenantTelemetryPregrantIntent(tenantId, requestId, group))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(second.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, intent!.intentSha256, winnerToken, 10_000,
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    }));

    it("refuses 0044 marker loss under the newer 0049 predecessor guard", runCase(async () => {
      const store = await openStore(12);
      const conn = await openInspection();
      const tenantId = `tenant-database-0044-marker-${randomUUID()}`;
      try {
        const { source, target } = await advanceToTelemetryPregrantSource(
          store, conn, tenantId,
        );
        const intent = await store.prepareTenantTelemetryPregrantIntent(
          tenantId, source.requestId, target.artifactGroupSha256,
        );
        if (!intent) throw new Error("missing pregrant intent for marker-loss fixture");
        expect(await store.claimTenantTelemetryPregrantIntent(
          tenantId, source.requestId, target.artifactGroupSha256,
          intent.intentSha256, "marker-loss-claim", 10_000,
        )).toMatchObject({ attempt: 1, grantReady: false });

        // This test owns the whole disposable database. Marker deletion is deliberate
        // corruption, not a production recovery procedure.
        const [originalMarker] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM schema_migrations WHERE name=?", ["0044_tenant_telemetry_pregrant_intent.sql"]);
        if (originalMarker.length !== 1) throw new Error("Original 0044 marker is not exact");
        const [deleted] = await conn.query<mysql.ResultSetHeader>(
          "DELETE FROM schema_migrations WHERE name=?",
          ["0044_tenant_telemetry_pregrant_intent.sql"],
        );
        expect(deleted.affectedRows).toBe(1);
        await expect(openStore()).rejects.toThrow("0049 capture v2 marker is missing its 0044 predecessor");
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_intents WHERE tenant_id=?) AS intents,
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_claims WHERE tenant_id=?) AS claims,
             (SELECT COUNT(*) FROM schema_migrations WHERE name=?) AS marker`,
          [tenantId, tenantId, "0044_tenant_telemetry_pregrant_intent.sql"],
        );
        expect(rows[0]).toMatchObject({ intents: 1, claims: 1, marker: 0 });
        await conn.query("INSERT INTO schema_migrations SET ?", [{ ...originalMarker[0]! }]);
        const [restoredMarker] = await conn.query<RowDataPacket[]>(
          "SELECT * FROM schema_migrations WHERE name=?", ["0044_tenant_telemetry_pregrant_intent.sql"]);
        if (JSON.stringify(restoredMarker) !== JSON.stringify(originalMarker)) throw new Error("Original 0044 marker did not restore exactly");
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rolls back 0044 intent and claim insert failures without publishing partial rows", runCase(async () => {
      const store = await openStore(12);
      const conn = await openInspection();
      const tenantId = `tenant-database-0044-rollback-${randomUUID()}`;
      try {
        const { source, target } = await advanceToTelemetryPregrantSource(
          store, conn, tenantId,
        );
        const requestId = source.requestId;
        const group = target.artifactGroupSha256;
        await conn.query(`CREATE TRIGGER test_pregrant_intent_abort AFTER INSERT
          ON tenant_telemetry_pregrant_intents FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected pregrant intent failure'`);
        await expect(store.prepareTenantTelemetryPregrantIntent(tenantId, requestId, group))
          .rejects.toThrow("injected pregrant intent failure");
        const [failedIntentRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM tenant_telemetry_pregrant_intents WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(failedIntentRows[0]?.n)).toBe(0);
        expect(await store.getTenantTelemetryPregrantIntent(tenantId, requestId, group))
          .toBeNull();
        await conn.query("DROP TRIGGER test_pregrant_intent_abort");

        const intent = await store.prepareTenantTelemetryPregrantIntent(
          tenantId, requestId, group,
        );
        if (!intent) throw new Error("missing pregrant intent after rollback retry");
        await conn.query(`CREATE TRIGGER test_pregrant_claim_abort AFTER INSERT
          ON tenant_telemetry_pregrant_claims FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected pregrant claim failure'`);
        await expect(store.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, intent.intentSha256, "claim-after-rollback", 1_000,
        )).rejects.toThrow("injected pregrant claim failure");
        const [failedClaimRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM tenant_telemetry_pregrant_claims WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(failedClaimRows[0]?.n)).toBe(0);
        await conn.query("DROP TRIGGER test_pregrant_claim_abort");
        await conn.query(`CREATE TRIGGER test_pregrant_claim_expire AFTER INSERT
          ON tenant_telemetry_pregrant_claims FOR EACH ROW
          BEGIN DECLARE waited INT; SET waited = SLEEP(1.25); END`);
        await expect(store.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, intent.intentSha256, "claim-after-rollback", 1_000,
        )).rejects.toBeInstanceOf(TenantTelemetryPregrantClaimLeaseExpiredError);
        const [expiredClaimRows] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM tenant_telemetry_pregrant_claims WHERE tenant_id=?",
          [tenantId],
        );
        expect(Number(expiredClaimRows[0]?.n)).toBe(0);
        await conn.query("DROP TRIGGER test_pregrant_claim_expire");
        expect(await store.claimTenantTelemetryPregrantIntent(
          tenantId, requestId, group, intent.intentSha256, "claim-after-rollback", 1_000,
        )).toMatchObject({ attempt: 1, grantReady: false });
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("treats a lost zero-target 0042 receipt as unknown, not an empty-source candidate", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-0043-empty-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        await activateLogsCaptureForT3f(store);
        const source = await advanceToDatabasePurgeClaim(
          store, conn, tenantId, `0043-empty-user-${randomUUID()}`,
        );
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toMatchObject({ status: "unknown", managedArtifactCount: null });
        expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toEqual({ status: "local_source_candidate", managedArtifactCount: 0,
          executionReady: false, externalAuthorityVerified: false });
        const fakeGroup = "f".repeat(64);
        expect(await store.prepareTenantTelemetryPregrantIntent(
          tenantId, source.requestId, fakeGroup,
        )).toBeNull();
        expect(await store.claimTenantTelemetryPregrantIntent(
          tenantId, source.requestId, fakeGroup,
          "e".repeat(64), "zero-target", 1_000,
        )).toBeNull();
        const [pregrantRows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_intents WHERE tenant_id=?) AS intents,
             (SELECT COUNT(*) FROM tenant_telemetry_pregrant_claims WHERE tenant_id=?) AS claims`,
          [tenantId, tenantId],
        );
        expect(pregrantRows[0]).toMatchObject({ intents: 0, claims: 0 });
        await expect(conn.query(
          "DELETE FROM tenant_telemetry_plan_artifact_target_receipts WHERE request_id=?",
          [source.requestId],
        )).rejects.toThrow("telemetry plan artifact receipt is append-only");
        // Only this disposable test database is privileged-corrupted; the real trigger must
        // reject the deletion before a forged legacy/zero interpretation can be attempted.
        await withRestoredGuards(conn, ["tenant_telemetry_plan_artifact_target_receipts"], "DELETE", async () => {
        await conn.query("DROP TRIGGER trg_tt_plan_artifact_target_receipt_bd");
        await conn.query(
          "DELETE FROM tenant_telemetry_plan_artifact_target_receipts WHERE request_id=?",
          [source.requestId],
        );
        expect(await store.getTenantTelemetrySourceEligibility(
          tenantId, source.requestId,
        )).toEqual({ status: "unknown", managedArtifactCount: null,
          executionReady: false, externalAuthorityVerified: false });
        expect(await store.prepareTenantTelemetryPregrantIntent(
          tenantId, source.requestId, fakeGroup,
        )).toBeNull();
        });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("serializes a reserved telemetry write completion behind the T3f closure range lock", runCase(async () => {
      const purger = await openStore(8);
      const writer = await openStore(8);
      const observer = await openInspection();
      const tenantId = `tenant-database-telemetry-race-${randomUUID()}`;
      const userId = `telemetry-race-user-${randomUUID()}`;
      let releaseDelete!: () => void;
      let deletionReached!: () => void;
      const holdDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const atDelete = new Promise<void>((resolve) => { deletionReached = resolve; });
      let purge: Promise<unknown> | undefined;
      let completion: Promise<unknown> | undefined;
      try {
        await activateTelemetryForT3f(purger);
        let claim: TenantTelemetryWriteClaim | undefined;
        const source = await advanceToDatabasePurgeClaim(
          purger, observer, tenantId, userId, {
            beforeTenantErasure: async (sessionId) => {
              await queueTelemetryForT3f(purger, tenantId, "race-reserved", {
                kind: "session", id: sessionId, userId,
              });
              [claim] = await purger.claimTenantTelemetryWriteJobs({
                limit: 1,
                leaseMs: 120_000,
                claimToken: `telemetry-race-${randomUUID()}`,
                adapterProtocol: "telemetry-test-v1",
              });
              if (!claim || !await purger.reserveTenantTelemetryExternalMutation(
                telemetryAuthorization(claim), "telemetry-test-v1",
              )) throw new Error("missing reserved telemetry write fixture");
            },
          },
        );
        if (!claim) throw new Error("missing telemetry write claim fixture");
        const reserved = claim;
        const internal = purger as unknown as {
          deleteTenantDatabasePurgeTargets: (...args: unknown[]) => Promise<void>;
        };
        const original = internal.deleteTenantDatabasePurgeTargets;
        internal.deleteTenantDatabasePurgeTargets = async (...args: unknown[]) => {
          deletionReached();
          await holdDelete;
          await original.apply(purger, args);
        };
        purge = purger.executeTenantDatabasePurge(source.authorization);
        await within(atDelete, 5_000, "telemetry closure pre-delete interleaving");
        completion = writer.completeTenantTelemetryWrite(
          telemetryAuthorization(reserved), telemetryAdapterResult(reserved),
        );
        await waitForTelemetryWriteLockWaiter(observer, database);
        releaseDelete();
        await expect(within(purge, 5_000, "telemetry closure commit"))
          .resolves.toMatchObject({ localDatabasePurgeComplete: true });
        await expect(within(completion, 5_000, "reserved telemetry write completion"))
          .resolves.toMatchObject({ writeOperationSha256: reserved.writeOperationSha256 });
        const entries = await purger.getTenantTelemetryOwnerClosureEntries(
          tenantId, source.requestId,
        );
        expect(entries.map((entry) => entry.writeOperationSha256))
          .toEqual([reserved.writeOperationSha256]);
        expect((await purger.getTenantTelemetryOwnerClosureReceipt(
          tenantId, source.requestId,
        ))?.entryCount).toBe(1);
        expect((await writer.getTenantTelemetryWriteJob(
          tenantId, reserved.writeOperationSha256,
        ))?.phase).toBe("written");
      } finally {
        releaseDelete?.();
        await Promise.allSettled([...(purge ? [purge] : []), ...(completion ? [completion] : [])]);
        await observer.end();
        await purger.close();
        await writer.close();
      }
    }));

    it("rolls back a post-closure-publication failure and replays without partial evidence", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-closure-fault-${randomUUID()}`;
      const sourceUserId = `closure-fault-user-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        const source = await advanceToDatabasePurgeClaim(
          store, conn, tenantId, sourceUserId, {
            beforeTenantErasure: async (sessionId) => {
              await queueTelemetryForT3f(store, tenantId, "publication-fault", {
                kind: "session", id: sessionId, userId: sourceUserId,
              });
            },
          },
        );
        const internal = store as unknown as {
          lockTenantPurgePlanHoldProof: (...args: unknown[]) => Promise<void>;
        };
        const original = internal.lockTenantPurgePlanHoldProof;
        internal.lockTenantPurgePlanHoldProof = async (...args: unknown[]) => {
          const [rows] = await (args[0] as Connection).query<RowDataPacket[]>(
            "SELECT COUNT(*) AS receipts FROM tenant_telemetry_owner_closure_receipts WHERE tenant_id=?",
            [tenantId],
          );
          if (Number(rows[0]?.receipts ?? 0) > 0) {
            throw new Error("injected post-closure-publication failure");
          }
          await original.apply(store, args);
        };
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toThrow("injected post-closure-publication failure");
        internal.lockTenantPurgePlanHoldProof = original;
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries
               WHERE tenant_id=?) AS closure_entries,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts
               WHERE tenant_id=?) AS closure_receipts,
             (SELECT COUNT(*) FROM tenant_database_purge_receipts
               WHERE tenant_id=?) AS t3f_receipts,
             (SELECT phase FROM tenant_database_purge_jobs WHERE tenant_id=?) AS phase`,
          [tenantId, tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          sessions: 1,
          closure_entries: 0,
          closure_receipts: 0,
          t3f_receipts: 0,
          phase: "queued",
        });
        const receipt = await store.executeTenantDatabasePurge(source.authorization);
        expect(receipt).not.toBeNull();
        expect((await store.getTenantTelemetryOwnerClosureReceipt(
          tenantId, source.requestId,
        ))?.entryCount).toBe(1);
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("preserves a transient MySQL relation-query timeout for retry instead of an integrity block", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-closure-timeout-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        const source = await advanceToDatabasePurgeClaim(
          store, conn, tenantId, `closure-timeout-user-${randomUUID()}`, {
            beforeTenantErasure: async () => {
              await queueTelemetryForT3f(store, tenantId, "query-timeout", {
                kind: "tenant", id: tenantId, userId: null,
              });
            },
          },
        );
        const timeout = Object.assign(new Error("injected MySQL lock wait timeout"), {
          code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205, sqlState: "HY000",
        });
        const internal = store as unknown as {
          readTenantTelemetryWritePayload: (...args: unknown[]) => Promise<unknown>;
        };
        const original = internal.readTenantTelemetryWritePayload;
        internal.readTenantTelemetryWritePayload = async () => { throw timeout; };
        await expect(store.executeTenantDatabasePurge(source.authorization)).rejects.toBe(timeout);
        internal.readTenantTelemetryWritePayload = original;
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries
               WHERE tenant_id=?) AS closure_entries,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts
               WHERE tenant_id=?) AS closure_receipts,
             (SELECT phase FROM tenant_database_purge_jobs WHERE tenant_id=?) AS phase`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          sessions: 1, closure_entries: 0, closure_receipts: 0, phase: "queued",
        });
        expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("refuses T3f when a legacy or corrupted telemetry job has no immutable membership", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-no-membership-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        let operationSha256 = "";
        const source = await advanceToDatabasePurgeClaim(
          store, conn, tenantId, `no-membership-user-${randomUUID()}`, {
            beforeTenantErasure: async () => {
              const job = await queueTelemetryForT3f(store, tenantId, "legacy-job", {
                kind: "tenant", id: tenantId, userId: null,
              });
              operationSha256 = job.writeOperationSha256;
            },
          },
        );
        // Disposable fixture only: privileged corruption simulates a pre-0038 or missing sidecar.
        await withRestoredGuards(conn, ["tenant_telemetry_artifact_memberships"], "DELETE", async () => {
        await conn.query("DROP TRIGGER trg_tt_membership_bd");
        await conn.query(
          "DELETE FROM tenant_telemetry_artifact_memberships WHERE write_operation_sha256=?",
          [operationSha256],
        );
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_database_purge_predelete_receipts
               WHERE tenant_id=?) AS predelete_receipts,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries
               WHERE tenant_id=?) AS closure_entries,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts
               WHERE tenant_id=?) AS closure_receipts,
             (SELECT phase FROM tenant_database_purge_jobs WHERE tenant_id=?) AS phase`,
          [tenantId, tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          sessions: 1,
          predelete_receipts: 0,
          closure_entries: 0,
          closure_receipts: 0,
          phase: "queued",
        });
        });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rejects a detached closure entry on read and verify-only startup", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-closure-orphan-${randomUUID()}`;
      try {
        await activateTelemetryForT3f(store);
        const source = await advanceToDatabasePurgeClaim(
          store, conn, tenantId, `closure-orphan-user-${randomUUID()}`, {
            beforeTenantErasure: async () => {
              await queueTelemetryForT3f(store, tenantId, "orphan", {
                kind: "tenant", id: tenantId, userId: null,
              });
            },
          },
        );
        expect(await store.executeTenantDatabasePurge(source.authorization)).not.toBeNull();
        // Disposable privileged-corruption fixture; restore the exact native guard even on failure.
        await withRestoredGuards(conn, ["tenant_telemetry_owner_closure_receipts"], "DELETE", async () => {
        await conn.query("DROP TRIGGER trg_tt_owner_closure_receipt_bd");
        await conn.query(
          "DELETE FROM tenant_telemetry_owner_closure_receipts WHERE request_id=?",
          [source.requestId],
        );
        });
        await expect(store.getTenantTelemetryOwnerClosureEntries(
          tenantId, source.requestId,
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(openStore()).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rolls back targets and every T3f evidence row after an injected destructive failure", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-rollback-${randomUUID()}`;
      const userId = `rollback-user-${randomUUID()}`;
      let ordinarySessionId = "";
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          userId,
          {
            beforeTenantErasure: async (sessionId) => {
              ordinarySessionId = sessionId;
              const atMs = Date.now();
              await withSessionAuthority(store, { id: sessionId, tenantId, userId }, 0, async lease => {
                await store.commitOrdinarySessionDelete(lease.admit<Parameters<MysqlSessionStore["commitOrdinarySessionDelete"]>[0]>({
                  sessionId, fence: 1,
                  lifecycle: { type: "tombstone", tenantId, userId, atMs,
                    purgeAfterMs: null, deletionGeneration: 1 },
                  events: [{ type: "session/deleted", sessionId,
                    emittedAtMs: atMs, deletionGeneration: 1 }],
                }));
              });
              await store.sealOrdinarySessionDeleteGrace(tenantId, userId, sessionId);
              await completeOrdinaryTombstoneOutbox(store, sessionId);
            },
          },
        );
        const internal = store as unknown as {
          deleteTenantDatabasePurgeTargets: (...args: unknown[]) => Promise<void>;
        };
        const original = internal.deleteTenantDatabasePurgeTargets;
        internal.deleteTenantDatabasePurgeTargets = async (...args: unknown[]) => {
          await original.apply(store, args);
          throw new Error("injected T3f destructive failure");
        };
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toThrow("injected T3f destructive failure");
        internal.deleteTenantDatabasePurgeTargets = original;

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_database_purge_predelete_entries
               WHERE tenant_id=?) AS entries,
             (SELECT COUNT(*) FROM tenant_database_purge_receipts
               WHERE tenant_id=?) AS receipts,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_entries
               WHERE tenant_id=?) AS closure_entries,
             (SELECT COUNT(*) FROM tenant_telemetry_owner_closure_receipts
               WHERE tenant_id=?) AS closure_receipts,
             (SELECT COUNT(*) FROM tenant_purge_session_grave_markers
               WHERE tenant_id=?) AS graves,
             (SELECT phase FROM tenant_database_purge_jobs
               WHERE tenant_id=?) AS phase`,
          [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({
          sessions: 1,
          entries: 0,
          receipts: 0,
          closure_entries: 0,
          closure_receipts: 0,
          graves: 0,
          phase: "queued",
        });
        expect(await store.getOrdinarySessionDeleteGrace(tenantId, userId, ordinarySessionId))
          .toMatchObject({ state: "sealed", executionReady: false });
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rejects same-id creation that overlaps an uncommitted grave and delete", runCase(async () => {
      const purger = await openStore(8);
      const creator = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-race-${randomUUID()}`;
      let releaseDelete!: () => void;
      let deletionReached!: () => void;
      const holdDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
      const atDelete = new Promise<void>((resolve) => { deletionReached = resolve; });
      let purge: Promise<unknown> | undefined;
      let create: Promise<unknown> | undefined;
      try {
        const replacementTenant = `tenant-database-reuse-${randomUUID()}`;
        const replacementUser = `replacement-user-${randomUUID()}`;
        await creator.setTenantAuth(replacementTenant, DEFAULT_AUTH_POLICY);
        const protectedSession = mkSession(replacementTenant, replacementUser);
        await creator.createSession(protectedSession);
        const source = await advanceToDatabasePurgeClaim(
          purger,
          conn,
          tenantId,
          `race-user-${randomUUID()}`,
        );
        const internal = purger as unknown as {
          deleteTenantDatabasePurgeTargets: (...args: unknown[]) => Promise<void>;
        };
        const original = internal.deleteTenantDatabasePurgeTargets;
        internal.deleteTenantDatabasePurgeTargets = async (...args: unknown[]) => {
          await original.apply(purger, args);
          deletionReached();
          await holdDelete;
        };

        purge = purger.executeTenantDatabasePurge(source.authorization);
        await within(atDelete, 5_000, "database purge delete interleaving");
        const replacement = {
          ...mkSession(replacementTenant, replacementUser),
          id: source.session.id,
        };
        let createSettled = false;
        create = creator.createSession(replacement).finally(() => {
          createSettled = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(createSettled).toBe(false);
        releaseDelete();
        await expect(within(purge, 5_000, "database purge commit"))
          .resolves.toMatchObject({ localDatabasePurgeComplete: true });
        await expect(within(create, 5_000, "same-id replacement rejection"))
          .rejects.toBeInstanceOf(SessionGoneError);

        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE session_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_purge_session_grave_markers
               WHERE session_id=?) AS graves,
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS protected_sessions,
             (SELECT COUNT(*) FROM events WHERE session_id=?) AS protected_events`,
          [
            source.session.id,
            source.session.id,
            replacementTenant,
            protectedSession.id,
          ],
        );
        expect(rows[0]).toMatchObject({
          sessions: 0,
          graves: 1,
          protected_sessions: 1,
          protected_events: 1,
        });
      } finally {
        releaseDelete?.();
        await Promise.allSettled([...(purge ? [purge] : []), ...(create ? [create] : [])]);
        await conn.end();
        await purger.close();
        await creator.close();
      }
    }));

    it("rejects a post-T3e deleted/completed blob projection that is absent from T3d/T3e", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-extra-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          `extra-user-${randomUUID()}`,
        );
        const now = Date.now() + 10_000;
        const blobId = newId("blob");
        await conn.query(
          `INSERT INTO blob_objects
             (blob_id, tenant_id, user_id, session_id, item_id, purpose,
              storage_backend, storage_format, storage_key, upload_token, state,
              sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
              staging_expires_at_ms, delete_after_ms, deleted_at_ms,
              deletion_generation, created_at_ms)
           VALUES (?,?,?,?,NULL,'tool_output','memory-v1',?,?,?,'deleted',
                   NULL,NULL,NULL,NULL,NULL,NULL,?,?,1,?)`,
          [
            blobId,
            tenantId,
            source.session.userId,
            source.session.id,
            BLOB_STORAGE_FORMAT,
            `objects/${blobId.slice("blob_".length)}`,
            `upload-${blobId.slice("blob_".length)}`,
            now,
            now,
            now,
          ],
        );
        await conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id, generation, available_at_ms, attempts, claim_token,
              lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms,
              created_at_ms)
           VALUES (?,1,?,0,NULL,NULL,NULL,?,NULL,?)`,
          [blobId, now, now, now],
        );
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE tenant_id=?) AS sessions,
             (SELECT COUNT(*) FROM tenant_database_purge_predelete_entries
               WHERE tenant_id=?) AS entries,
             (SELECT phase FROM tenant_database_purge_jobs WHERE tenant_id=?) AS phase`,
          [tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ sessions: 1, entries: 0, phase: "queued" });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rejects a same-count completed blob/outbox replacement with a different T3d root", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-replace-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          `replace-user-${randomUUID()}`,
          { seedCompletedBlob: true },
        );
        if (!source.completedBlob) throw new Error("missing completed blob fixture");
        await conn.query("DELETE FROM blob_delete_outbox WHERE outbox_id=?", [
          source.completedBlob.outboxId,
        ]);
        await conn.query("DELETE FROM blob_objects WHERE blob_id=?", [
          source.completedBlob.blobId,
        ]);
        const replacementBlobId = newId("blob");
        await conn.query(
          `INSERT INTO blob_objects
             (blob_id, tenant_id, user_id, session_id, item_id, purpose,
              storage_backend, storage_format, storage_key, upload_token, state,
              sha256, size_bytes, content_type, uploaded_at_ms, ready_at_ms,
              staging_expires_at_ms, delete_after_ms, deleted_at_ms,
              deletion_generation, created_at_ms)
           VALUES (?,?,?,?,NULL,'tool_output','memory-v1',?,?,?,'deleted',
                   NULL,NULL,NULL,NULL,NULL,NULL,?,?,1,?)`,
          [
            replacementBlobId,
            tenantId,
            source.session.userId,
            source.session.id,
            BLOB_STORAGE_FORMAT,
            `objects/${replacementBlobId.slice("blob_".length)}`,
            `upload-${replacementBlobId.slice("blob_".length)}`,
            source.completedBlob.createdAtMs,
            source.completedBlob.createdAtMs,
            source.completedBlob.createdAtMs,
          ],
        );
        await conn.query(
          `INSERT INTO blob_delete_outbox
             (outbox_id, blob_id, generation, available_at_ms, attempts, claim_token,
              lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms,
              created_at_ms)
           VALUES (?,?,1,?,0,NULL,NULL,NULL,?,NULL,?)`,
          [
            source.completedBlob.outboxId,
            replacementBlobId,
            source.completedBlob.createdAtMs,
            source.completedBlob.createdAtMs,
            source.completedBlob.createdAtMs,
          ],
        );
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM blob_objects WHERE tenant_id=?) AS blobs,
             (SELECT COUNT(*) FROM blob_delete_outbox o
               JOIN blob_objects b ON b.blob_id=o.blob_id
              WHERE b.tenant_id=?) AS outbox,
             (SELECT COUNT(*) FROM tenant_database_purge_predelete_entries
               WHERE tenant_id=?) AS entries`,
          [tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ blobs: 1, outbox: 1, entries: 0 });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.end();
        await store.close();
      }
    }));

    it("rejects a same-count export artifact/part/outbox identity replacement after T3e", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-export-replace-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          `export-replace-user-${randomUUID()}`,
          { seedReadyExport: true },
        );
        if (!source.readyExport) throw new Error("missing ready export fixture");
        const replacementArtifactId = newUserDataExportArtifactId();
        await conn.query("SET FOREIGN_KEY_CHECKS=0");
        try {
          await conn.query(
            `UPDATE user_export_artifact_delete_outbox
                SET artifact_id=? WHERE artifact_id=?`,
            [replacementArtifactId, source.readyExport.artifactId],
          );
          await conn.query(
            "UPDATE user_export_artifact_parts SET artifact_id=? WHERE artifact_id=?",
            [replacementArtifactId, source.readyExport.artifactId],
          );
          await conn.query(
            "UPDATE user_export_artifacts SET artifact_id=? WHERE artifact_id=?",
            [replacementArtifactId, source.readyExport.artifactId],
          );
        } finally {
          await conn.query("SET FOREIGN_KEY_CHECKS=1");
        }
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toBeInstanceOf(TenantDatabasePurgeEvidenceChangedError);
        const [rows] = await conn.query<RowDataPacket[]>(
          `SELECT
             (SELECT COUNT(*) FROM user_export_artifacts WHERE tenant_id=?) AS artifacts,
             (SELECT COUNT(*) FROM user_export_artifact_parts WHERE tenant_id=?) AS parts,
             (SELECT COUNT(*) FROM user_export_artifact_delete_outbox o
               JOIN user_export_artifacts a ON a.artifact_id=o.artifact_id
              WHERE a.tenant_id=?) AS outbox,
             (SELECT COUNT(*) FROM tenant_database_purge_predelete_entries
               WHERE tenant_id=?) AS entries`,
          [tenantId, tenantId, tenantId, tenantId],
        );
        expect(rows[0]).toMatchObject({ artifacts: 1, parts: 1, outbox: 1, entries: 0 });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1").catch(() => {});
        await conn.end();
        await store.close();
      }
    }));

    it("rejects terminal replay after billing and every dependent T3f hash are rewritten", runCase(async () => {
      const store = await openStore(8);
      const conn = await openInspection();
      const tenantId = `tenant-database-billing-rehash-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          `billing-rehash-user-${randomUUID()}`,
        );
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .resolves.toMatchObject({ retainedBillingFactCount: 1 });
        await withRestoredGuards(conn, ["billing_usage_facts", "tenant_database_purge_jobs", "tenant_database_purge_predelete_receipts", "tenant_database_purge_domain_acks", "tenant_database_purge_receipts", "tenant_purge_session_grave_markers", "tenant_database_purge_cutover"], "UPDATE", async () => {
        await rewriteSelfConsistentT3fBillingEvidence(
          store,
          conn,
          tenantId,
          source.requestId,
          source.session.id,
        );
        await expect(store.getTenantDatabasePurgeReceipt(tenantId, source.requestId))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(store.executeTenantDatabasePurge(source.authorization))
          .rejects.toBeInstanceOf(TenantErasureIntegrityError);
        });
        scope().cleanupValidation = "structure-after-intentional-data-corruption-v1";
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1").catch(() => {});
        await conn.end();
        await store.close();
      }
    }));
  });
}
