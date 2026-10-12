import { createHash, randomUUID } from "node:crypto";
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

// Copied into the pinned 0042 checkout. This intentionally creates NO managed artifact:
// unlike its nonempty T3d, the frozen 0042 binary can really reach T3f for this plan.
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("frozen 0042 zero-plan fixture requires MYSQL_URL");
const tenantId = `tenant-pre0043-zero-${randomUUID()}`;
const refKey = Buffer.alloc(32, 0x42);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
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
    targetSha256: tenantRuntimeTargetSha256("http://frozen-0042-runner.internal:8080"),
    runnerId: "frozen-0042-runner", bootId: "frozen-0042-boot",
    requestId: claim.requestId, tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration, t3aReceiptSha256: claim.t3aReceiptSha256,
    cacheEntryCountBefore: 1, cacheEntryCountAfter: 0 as const,
    activeOperationCountBefore: 1, activeOperationCountAfter: 0 as const,
    activeTurnCountBefore: 1, activeTurnCountAfter: 0 as const,
    completedAtMs: Date.now(),
  };
  const targets = [{ ...body, receiptSha256: tenantRuntimeLocalReceiptSha256(body) }];
  return {
    fleetSha256: tenantRuntimeFleetSha256(targets),
    targetReceiptsSha256: tenantRuntimeTargetReceiptsSha256(targets),
    targets,
  };
}

const stage = (name: string) => process.stderr.write(`PRE0043_STAGE=${name}\n`);
stage("connect_zero");
const store = await MysqlSessionStore.connect({
  url: mysqlUrl, tenantTelemetryRefKey: refKey,
});
try {
  stage("activate_lifecycle_zero");
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain, backendKind: "migration_fixture", adapterProtocol: "telemetry-fixture-v1",
      namespaceSha256: digest(`pre0043-zero:${domain}:namespace`),
      failureDomainSha256: digest(`pre0043-zero:${domain}:failure-domain`),
    })),
  });
  stage("tenant_zero");
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
  stage("t1_zero");
  await store.requestTenantErasure({
    requestId, tenantId, requestedByKeyId: "frozen-fixture-platform",
    idempotencyKey: `pre0043-zero-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
  });
  stage("t3a_zero");
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3a-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!credential || !await store.revokeTenantCredentialMaterial({
    requestId, tenantId, subjectGeneration: credential.subjectGeneration,
    claimAttempt: credential.claimAttempt, claimToken: credential.claimToken,
  })) throw new Error("frozen 0042 zero-plan T3a failed");

  stage("t3b_zero");
  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3b-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!runtime || !await store.completeTenantRuntimeRevocation({
    requestId, tenantId, subjectGeneration: runtime.subjectGeneration,
    claimAttempt: runtime.claimAttempt, claimToken: runtime.claimToken,
  }, fleetProof(runtime))) throw new Error("frozen 0042 zero-plan T3b failed");

  stage("t3c_zero");
  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const content = (await store.claimTenantContentInventories({
    limit: 10, leaseMs: 120_000, claimToken: `t3c-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!content) throw new Error("frozen 0042 zero-plan T3c claim missing");
  const contentAuth = {
    requestId, tenantId, subjectGeneration: content.subjectGeneration,
    buildGeneration: content.buildGeneration, claimAttempt: content.claimAttempt,
    claimToken: content.claimToken,
  };
  for (let page = 0; page < 10; page += 1) {
    if ((await store.buildTenantContentInventoryPage(contentAuth, { limit: 10 })).done) break;
    if (page === 9) throw new Error("frozen 0042 zero-plan T3c pagination did not finish");
  }
  if (!await store.sealTenantContentInventory(contentAuth)) {
    throw new Error("frozen 0042 zero-plan T3c receipt missing");
  }

  stage("t3d_zero");
  const worker = new TenantPurgePlanWorker({
    store, logger: { warn() { /* Do not print DB errors or authority values. */ } },
  }, { leaseMs: 120_000, batchSize: 1, materializeBatchSize: 1 });
  if (await worker.processOnce() !== 1) throw new Error("frozen 0042 zero-plan T3d did not seal");
  const plan = await store.getTenantPurgePlanReceipt(tenantId, requestId);
  const entries = await store.getTenantPurgePlanEntries(tenantId, requestId, 1);
  const catalog = await store.getTenantTelemetryPlanArtifactTargetReceipt(tenantId, requestId);
  const targets = await store.getTenantTelemetryPlanArtifactTargets(tenantId, requestId);
  if (!plan || !plan.planComplete || plan.executionReady || entries.length !== 33
    || !catalog || catalog.targetCount !== 0 || catalog.unknownGroupCount !== 0
    || targets.length !== 0 || catalog.planReceiptSha256 !== plan.receiptSha256) {
    throw new Error("frozen 0042 zero-plan T3d evidence invalid");
  }
  process.stdout.write(JSON.stringify({
    requestId, tenantId, planReceiptSha256: plan.receiptSha256,
    catalogReceiptSha256: catalog.receiptSha256, targetCount: catalog.targetCount,
  }));
} finally {
  await store.close();
}
