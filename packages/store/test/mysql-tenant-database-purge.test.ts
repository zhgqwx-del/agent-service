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
  MysqlSessionStore,
  SessionGoneError,
  TenantDatabasePurgeEvidenceChangedError,
  TenantErasureIntegrityError,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  USER_DATA_EXPORT_CONTENT_TYPE,
  newErasureRequestId,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
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
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const BASE_MYSQL_URL = process.env.MYSQL_TEST_URL
  ?? "mysql://root@127.0.0.1:3306/agent_service_test";
const TELEMETRY_REF_KEY = Buffer.alloc(32, 0x45);

function telemetryDigest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
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

async function queueTelemetryForT3f(
  store: MysqlSessionStore,
  tenantId: string,
  marker: string,
  owner: { kind: "tenant"; id: string; userId: null }
    | { kind: "user"; id: string; userId: string }
    | { kind: "session"; id: string; userId: string },
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
  observer: Connection,
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
  conn: Connection,
  tenantId: string,
  userId: string,
  options: {
    seedCompletedBlob?: boolean;
    seedReadyExport?: boolean;
    beforeTenantErasure?: (sessionId: string) => Promise<void>;
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

async function rewriteSelfConsistentT3fBillingEvidence(
  store: MysqlSessionStore,
  conn: Connection,
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
              receipt_sha256=? WHERE request_id=?`,
      [
        newPreDeleteReceipt.receiptSha256,
        domainAckRootSha256,
        graveRootSha256,
        billingRootSha256,
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
    let admin: Connection | undefined;
    let database = "";
    let mysqlUrl = "";

    beforeAll(async () => {
      baseUrl = assertDisposableTestTarget(BASE_MYSQL_URL);
      admin = await mysql.createConnection(databaseUrl(baseUrl, "mysql"));
    });

    beforeEach(async () => {
      database = `agent_service_database_purge_test_${process.pid}_${randomUUID()
        .replaceAll("-", "").slice(0, 8)}`;
      if (!/^agent_service_database_purge_test_[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error("unsafe tenant database purge test database name");
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

    it("atomically deletes local database targets, retains billing, and replays concurrently", async () => {
      const first = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const second = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
        const verified = await MysqlSessionStore.connect({
          url: mysqlUrl, migrationMode: "verify",
        });
        await verified.close();
      } finally {
        await conn.end();
        await first.close();
        await second.close();
      }
    });

    it("captures every telemetry phase from canonical tenant, user and session owners before T3f delete", async () => {
      const store = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 12, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const conn = await mysql.createConnection(mysqlUrl);
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
        const restarted = await MysqlSessionStore.connect({
          url: mysqlUrl,
          migrationMode: "verify",
          tenantTelemetryRefKey: TELEMETRY_REF_KEY,
        });
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
    });

    it("serializes a reserved telemetry write completion behind the T3f closure range lock", async () => {
      const purger = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const writer = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const observer = await mysql.createConnection(mysqlUrl);
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
    });

    it("rolls back a post-closure-publication failure and replays without partial evidence", async () => {
      const store = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const conn = await mysql.createConnection(mysqlUrl);
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
    });

    it("preserves a transient MySQL relation-query timeout for retry instead of an integrity block", async () => {
      const store = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const conn = await mysql.createConnection(mysqlUrl);
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
    });

    it("refuses T3f when a legacy or corrupted telemetry job has no immutable membership", async () => {
      const store = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const conn = await mysql.createConnection(mysqlUrl);
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
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a detached closure entry on read and verify-only startup", async () => {
      const store = await MysqlSessionStore.connect({
        url: mysqlUrl, connectionLimit: 8, tenantTelemetryRefKey: TELEMETRY_REF_KEY,
      });
      const conn = await mysql.createConnection(mysqlUrl);
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
        const createTrigger = `CREATE TRIGGER trg_tt_owner_closure_receipt_bd
          BEFORE DELETE ON tenant_telemetry_owner_closure_receipts FOR EACH ROW
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='telemetry owner closure receipt is append-only'`;
        // Disposable privileged-corruption fixture; immediately restore the exact guard body.
        await conn.query("DROP TRIGGER trg_tt_owner_closure_receipt_bd");
        await conn.query(
          "DELETE FROM tenant_telemetry_owner_closure_receipts WHERE request_id=?",
          [source.requestId],
        );
        await conn.query(createTrigger);
        await expect(store.getTenantTelemetryOwnerClosureEntries(
          tenantId, source.requestId,
        )).rejects.toBeInstanceOf(TenantErasureIntegrityError);
        await expect(MysqlSessionStore.connect({
          url: mysqlUrl,
          migrationMode: "verify",
          tenantTelemetryRefKey: TELEMETRY_REF_KEY,
        })).rejects.toBeInstanceOf(TenantErasureIntegrityError);
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rolls back targets and every T3f evidence row after an injected destructive failure", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
      const tenantId = `tenant-database-rollback-${randomUUID()}`;
      try {
        const source = await advanceToDatabasePurgeClaim(
          store,
          conn,
          tenantId,
          `rollback-user-${randomUUID()}`,
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
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects same-id creation that overlaps an uncommitted grave and delete", async () => {
      const purger = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const creator = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
    });

    it("rejects a post-T3e deleted/completed blob projection that is absent from T3d/T3e", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a same-count completed blob/outbox replacement with a different T3d root", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
      } finally {
        await conn.end();
        await store.close();
      }
    });

    it("rejects a same-count export artifact/part/outbox identity replacement after T3e", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1").catch(() => {});
        await conn.end();
        await store.close();
      }
    });

    it("rejects terminal replay after billing and every dependent T3f hash are rewritten", async () => {
      const store = await MysqlSessionStore.connect({ url: mysqlUrl, connectionLimit: 8 });
      const conn = await mysql.createConnection(mysqlUrl);
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
      } finally {
        await conn.query("SET FOREIGN_KEY_CHECKS=1").catch(() => {});
        await conn.end();
        await store.close();
      }
    });
  });
}
