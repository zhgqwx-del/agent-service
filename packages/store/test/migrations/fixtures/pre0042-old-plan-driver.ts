import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_AUTH_POLICY,
  createStructuredTelemetry,
  type StructuredTelemetryRecord,
  tenantRuntimeFleetSha256,
  tenantRuntimeLocalReceiptSha256,
  tenantRuntimeTargetReceiptsSha256,
  tenantRuntimeTargetSha256,
  type TenantRuntimeRevocationFleetProof,
} from "@agent-service/protocol";
import { TenantPurgePlanWorker } from "../../../../core/src/index.js";
import {
  MysqlSessionStore,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  newErasureRequestId,
  tenantTelemetryWriteAdapterEvidenceSha256,
  tenantErasureRequestHash,
  type RetentionPolicyDocumentV1,
  type TenantRuntimeRevocationClaim,
} from "@agent-service/store";

// Copied into the exact published 0041 checkout; no current source is imported.
const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("frozen 0041 fixture requires MYSQL_URL");
const tenantId = `tenant-pre0042-${randomUUID()}`;
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
    targetSha256: tenantRuntimeTargetSha256("http://frozen-0041-runner.internal:8080"),
    runnerId: "frozen-0041-runner",
    bootId: "frozen-0041-boot",
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

const store = await MysqlSessionStore.connect({ url: mysqlUrl, tenantTelemetryRefKey: refKey });
try {
  await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: ["logs", "traces"].map((domain) => ({
      domain: domain as "logs" | "traces", backendKind: "migration_fixture",
      adapterProtocol: "telemetry-fixture-v1",
      namespaceSha256: digest(`pre0042:${domain}:namespace`),
      failureDomainSha256: digest(`pre0042:${domain}:failure-domain`),
    })),
  });
  const lifecycle = await store.getTenantTelemetryLifecycleControl();
  const logTarget = (await store.listTenantTelemetryLifecycleTargets())
    .find((target) => target.domain === "logs");
  if (!logTarget || lifecycle.state !== "active") {
    throw new Error("frozen 0041 telemetry lifecycle activation missing");
  }
  const producerContractSha256 = digest("pre0042:producer-contract");
  await store.activateTenantTelemetryApplicationCapture({
    domain: "logs",
    expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1,
    lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
    lifecycleTargetSha256: logTarget.targetSha256,
    lifecycleTargetReceiptSha256: logTarget.receiptSha256,
    producerProtocol: "application-dual-write-v1",
    producerContractSha256,
    fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  });
  await store.setTenantAuth(tenantId, DEFAULT_AUTH_POLICY);
  const writtenAt = Date.now();
  let structuredRecord: Readonly<StructuredTelemetryRecord> | undefined;
  const telemetry = createStructuredTelemetry({
    component: "runner", opaqueRefKey: refKey, now: () => writtenAt,
    sink: { write(value) { structuredRecord = value; } },
  });
  telemetry.info("runner.runtime.info", { ownerRef: telemetry.opaqueRef("tenant", tenantId) });
  if (!structuredRecord) throw new Error("frozen 0041 trusted telemetry record missing");
  const queued = await store.enqueueTenantTelemetryArtifact({
    tenantId, expectedControlGeneration: 1, domain: "logs",
    artifactIdSha256: digest(`pre0042:${tenantId}:artifact`), artifactGeneration: 1,
    ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "migration-fixture-v1", sourceGeneration: 1,
    sourceHighWaterDbMs: writtenAt,
    producerProtocol: "application-dual-write-v1", producerContractSha256,
    payload: { schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [structuredRecord] },
  });
  const write = (await store.claimTenantTelemetryWriteJobs({
    limit: 1, leaseMs: 120_000, claimToken: `telemetry-write-${randomUUID()}`,
    adapterProtocol: "telemetry-fixture-v1",
  })).find((claim) => claim.writeOperationSha256 === queued.writeOperationSha256);
  if (!write) throw new Error("frozen 0041 telemetry write claim missing");
  const writeAuth = {
    writeOperationSha256: write.writeOperationSha256,
    tenantId: write.tenantId,
    claimAttempt: write.claimAttempt,
    claimToken: write.claimToken,
  };
  await store.reserveTenantTelemetryExternalMutation(writeAuth, write.target.adapterProtocol);
  const writeEvidence = {
    adapterProtocol: write.target.adapterProtocol,
    domain: write.inventory.domain,
    targetSha256: write.target.targetSha256,
    writeOperationSha256: write.writeOperationSha256,
    artifactIdSha256: write.inventory.artifactIdSha256,
    artifactGeneration: write.inventory.artifactGeneration,
    payloadSha256: write.inventory.payloadSha256,
    manifestSha256: write.inventory.manifestSha256,
    outcome: "written" as const,
    replayed: false,
  };
  const writeAck = await store.completeTenantTelemetryWrite(writeAuth, {
    ...writeEvidence,
    evidenceSha256: tenantTelemetryWriteAdapterEvidenceSha256(writeEvidence),
  });
  if (!writeAck) throw new Error("frozen 0041 telemetry ACK missing");
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
    idempotencyKey: `pre0042-${randomUUID()}`,
    requestHash: tenantErasureRequestHash(tenantId), atMs: Date.now(),
  });
  const credential = (await store.claimTenantCredentialRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3a-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!credential) throw new Error("frozen 0041 T3a claim missing");
  const credentialReceipt = await store.revokeTenantCredentialMaterial({
    requestId, tenantId, subjectGeneration: credential.subjectGeneration,
    claimAttempt: credential.claimAttempt, claimToken: credential.claimToken,
  });
  if (!credentialReceipt) throw new Error("frozen 0041 T3a receipt missing");

  await store.materializeTenantRuntimeRevocationJobs({ limit: 10 });
  const runtime = (await store.claimTenantRuntimeRevocations({
    limit: 10, leaseMs: 120_000, claimToken: `t3b-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!runtime) throw new Error("frozen 0041 T3b claim missing");
  const runtimeReceipt = await store.completeTenantRuntimeRevocation({
    requestId, tenantId, subjectGeneration: runtime.subjectGeneration,
    claimAttempt: runtime.claimAttempt, claimToken: runtime.claimToken,
  }, fleetProof(runtime));
  if (!runtimeReceipt) throw new Error("frozen 0041 T3b receipt missing");

  await store.materializeTenantContentInventoryJobs({ limit: 10 });
  const content = (await store.claimTenantContentInventories({
    limit: 10, leaseMs: 120_000, claimToken: `t3c-${randomUUID()}`,
  })).find((claim) => claim.requestId === requestId);
  if (!content) throw new Error("frozen 0041 T3c claim missing");
  const contentAuth = {
    requestId, tenantId, subjectGeneration: content.subjectGeneration,
    buildGeneration: content.buildGeneration, claimAttempt: content.claimAttempt,
    claimToken: content.claimToken,
  };
  for (let page = 0; page < 10; page += 1) {
    const result = await store.buildTenantContentInventoryPage(contentAuth, { limit: 10 });
    if (result.done) break;
    if (page === 9) throw new Error("frozen 0041 T3c pagination did not finish");
  }
  const contentReceipt = await store.sealTenantContentInventory(contentAuth);
  if (!contentReceipt) throw new Error("frozen 0041 T3c receipt missing");

  const worker = new TenantPurgePlanWorker({
    store, logger: { warn() { /* Never print DB errors or authority values. */ } },
  }, { leaseMs: 120_000, batchSize: 1, materializeBatchSize: 1 });
  if (await worker.processOnce() !== 1) throw new Error("frozen 0041 T3d worker did not seal");
  const plan = await store.getTenantPurgePlanReceipt(tenantId, requestId);
  const entries = await store.getTenantPurgePlanEntries(tenantId, requestId, 1);
  const source = await store.getTenantTelemetrySourceAccountingReceipt(tenantId, requestId);
  const manifest = await store.getTenantTelemetryTargetManifestReceipt(tenantId, requestId);
  if (!plan || entries.length !== 33 || !plan.planComplete || plan.executionReady
    || !source || source.planReceiptSha256 !== plan.receiptSha256
    || !manifest || manifest.planReceiptSha256 !== plan.receiptSha256
    || manifest.sourceAccountingReceiptSha256 !== source.receiptSha256
    || manifest.observedTargetCount !== 1 || manifest.unknownGroupCount !== 0) {
    throw new Error("frozen 0041 T3d/0040/0041 terminal proof invalid");
  }
  if (await store.getTenantPurgePlanReceipt(`foreign-${tenantId}`, requestId) !== null
    || await store.getTenantTelemetryTargetManifestReceipt(
      `foreign-${tenantId}`, requestId,
    ) !== null) {
    throw new Error("frozen 0041 T3d crossed tenant boundary");
  }
  process.stdout.write(JSON.stringify({
    sourceCommit: "2cb28ad7d20a06c69380231f7d1fcc5ea9702ce9",
    requestId, tenantId, planReceiptSha256: plan.receiptSha256,
    planEntryRootSha256: plan.planEntryRootSha256,
    sourceReceiptSha256: source.receiptSha256,
    manifestReceiptSha256: manifest.receiptSha256,
    entries: entries.length, observedTargets: manifest.observedTargetCount,
    writtenOperationSha256: queued.writeOperationSha256,
    writtenAckReceiptSha256: writeAck.receiptSha256,
    upstreamReceiptsPresent: Boolean(credentialReceipt && runtimeReceipt && contentReceipt),
  }));
} finally {
  await store.close();
}
