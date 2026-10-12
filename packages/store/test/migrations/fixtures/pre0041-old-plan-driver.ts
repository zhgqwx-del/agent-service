import { randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import { TenantPurgePlanWorker } from "../../../../core/src/index.js";
import {
  MysqlSessionStore,
  newErasureRequestId,
  tenantErasureRequestHash,
  type RetentionPolicyDocumentV1,
  type TenantRuntimeRevocationClaim,
} from "@agent-service/store";

// Copied into the exact published 0040 archive; imported store/core/protocol are frozen code.
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("old-plan fixture requires MYSQL_URL");
const tenantId = `tenant-pre0041-${randomUUID()}`;
const policy: RetentionPolicyDocumentV1 = {
  sessionContentRetentionMs: 0,
  userErasureGraceMs: 0,
  operationalUsageRetentionMs: 0,
  idempotencyReceiptRetentionMs: 0,
  billingFactRetentionMs: 0,
  lifecycleAuditRetentionMs: 0,
  exportArtifactTtlMs: 60_000,
};

function fleetProof(claim: TenantRuntimeRevocationClaim): TenantRuntimeRevocationFleetProof {
  const body = {
    targetSha256: tenantRuntimeTargetSha256("http://frozen-0040-runner.internal:8080"),
    runnerId: "frozen-0040-runner",
    bootId: "frozen-0040-boot",
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

const store = await MysqlSessionStore.connect({ url: mysqlUrl });
try {
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  await store.putRetentionPolicy({
    tenantId, policyVersion: "policy-v1", policy,
    actorKeyId: "frozen-fixture-admin", atMs: Date.now(),
  });
  await store.activateRetentionPolicy({
    tenantId, policyVersion: "policy-v1", expectedControlGeneration: 0,
    actorKeyId: "frozen-fixture-admin", atMs: Date.now() + 1,
  });
  await store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
  const requestId = newErasureRequestId();
  await store.requestTenantErasure({
    requestId, tenantId, requestedByKeyId: "frozen-fixture-platform",
    idempotencyKey: `pre0041-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
  });
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3a-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!credential) throw new Error("frozen 0040 T3a claim missing");
  const credentialReceipt = await store.revokeTenantCredentialMaterial({
    requestId, tenantId, subjectGeneration: credential.subjectGeneration,
    claimAttempt: credential.claimAttempt, claimToken: credential.claimToken,
  });
  if (!credentialReceipt) throw new Error("frozen 0040 T3a receipt missing");

  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3b-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!runtime) throw new Error("frozen 0040 T3b claim missing");
  const runtimeReceipt = await store.completeTenantRuntimeRevocation({
    requestId, tenantId, subjectGeneration: runtime.subjectGeneration,
    claimAttempt: runtime.claimAttempt, claimToken: runtime.claimToken,
  }, fleetProof(runtime));
  if (!runtimeReceipt) throw new Error("frozen 0040 T3b receipt missing");

  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const content = (await store.claimTenantContentInventories({
    limit: 10, leaseMs: 120_000, claimToken: `t3c-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!content) throw new Error("frozen 0040 T3c claim missing");
  const contentAuth = {
    requestId, tenantId, subjectGeneration: content.subjectGeneration,
    buildGeneration: content.buildGeneration, claimAttempt: content.claimAttempt,
    claimToken: content.claimToken,
  };
  for (let page = 0; page < 10; page += 1) {
    const result = await store.buildTenantContentInventoryPage(contentAuth, { limit: 10 });
    if (result.done) break;
    if (page === 9) throw new Error("frozen 0040 T3c pagination did not finish");
  }
  const contentReceipt = await store.sealTenantContentInventory(contentAuth);
  if (!contentReceipt) throw new Error("frozen 0040 T3c receipt missing");

  const worker = new TenantPurgePlanWorker({
    store, logger: { warn() { /* Never print DB errors or authority values. */ } },
  }, { leaseMs: 120_000, batchSize: 1, materializeBatchSize: 1 });
  if (await worker.processOnce() !== 1) throw new Error("frozen 0040 T3d worker did not seal");
  const plan = await store.getTenantPurgePlanReceipt(tenantId, requestId);
  const entries = await store.getTenantPurgePlanEntries(tenantId, requestId, 1);
  const source = await store.getTenantTelemetrySourceAccountingReceipt(tenantId, requestId);
  const sourceEntries = await store.getTenantTelemetrySourceAccountingEntries(tenantId, requestId);
  if (!plan || entries.length !== 33 || !plan.planComplete || plan.executionReady
    || !source || source.planReceiptSha256 !== plan.receiptSha256
    || source.entryCount !== 0 || sourceEntries.length !== 0) {
    throw new Error("frozen 0040 T3d/source terminal proof invalid");
  }
  if (await store.getTenantPurgePlanReceipt(`foreign-${tenantId}`, requestId) !== null
    || await store.getTenantTelemetrySourceAccountingReceipt(
      `foreign-${tenantId}`, requestId,
    ) !== null) {
    throw new Error("frozen 0040 T3d/source crossed tenant boundary");
  }
  process.stdout.write(JSON.stringify({
    sourceCommit: "3680cfe276756f5f39823f8d3ae2667832dc7b8f",
    requestId, tenantId, planReceiptSha256: plan.receiptSha256,
    planEntryRootSha256: plan.planEntryRootSha256,
    sourceReceiptSha256: source.receiptSha256,
    entries: entries.length, sourceEntries: sourceEntries.length,
    upstreamReceiptsPresent: Boolean(credentialReceipt && runtimeReceipt && contentReceipt),
  }));
} finally {
  await store.close();
}
