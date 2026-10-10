import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_REDIS_PURGE_DOMAIN_ACK_ROOT_SHA256,
  TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
  TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID,
  TENANT_REDIS_PURGE_DOMAIN_ACK_SCOPE,
  TENANT_REDIS_PURGE_DOMAINS,
  TENANT_REDIS_PURGE_RECEIPT_SCOPE,
  TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE,
  TENANT_REDIS_PURGE_TARGET_ACK_SCOPE,
  TENANT_REDIS_PURGE_TARGET_SCOPE,
  tenantRedisPurgeClaimTokenSha256,
  tenantRedisPurgeCutoverEvidenceSha256,
  tenantRedisPurgeDomainAckRootSha256,
  tenantRedisPurgeDomainAckSha256,
  tenantRedisPurgeGraveMarkerRootSha256,
  tenantRedisPurgeMarkerRootSha256,
  tenantRedisPurgeMarkerSha256,
  tenantRedisPurgeNextDomainAckRootSha256,
  tenantRedisPurgeOperationSha256,
  tenantRedisPurgePlanEntryRootSha256,
  tenantRedisPurgePlanTargetRootSha256,
  tenantRedisPurgePlanTargetSha256,
  tenantRedisPurgeReceiptSha256,
  tenantRedisPurgeRestoreFenceSha256,
  tenantRedisPurgeTargetAckRootSha256,
  tenantRedisPurgeTargetAckSha256,
  tenantRedisPurgeTargetRootSha256,
  tenantRedisPurgeTargetSha256,
  validateTenantRedisPurgeAdapterResult,
  validateTenantRedisPurgeCutoverRecord,
  validateTenantRedisPurgeEvidenceBundle,
  validateTenantRedisPurgeRestoreFence,
  type TenantRedisPurgeDomainAck,
  type TenantRedisPurgeReceipt,
  type TenantRedisPurgeRestoreFence,
  type TenantRedisPurgeSource,
  type TenantRedisPurgeTarget,
  type TenantRedisPurgeTargetAck,
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const SESSION_ID = "sess_0199aabb-ccdd-7001-8000-000000000025";

const planEntries = TENANT_REDIS_PURGE_DOMAINS.map((domain, index) => ({
  domain,
  planEntryReceiptSha256: (index + 1).toString(16).padStart(64, "0"),
}));

const source: TenantRedisPurgeSource = {
  requestId: "erase_12345678-1234-4123-8123-123456789abc",
  tenantId: "tenant-a",
  subjectGeneration: 1,
  planBuildGeneration: 2,
  executionGeneration: 3,
  databasePurgeGeneration: 4,
  redisPurgeGeneration: 1,
  t3cReceiptSha256: DIGEST_A,
  planReceiptSha256: DIGEST_B,
  redisPlanEntryCount: 3,
  redisPlanEntryRootSha256: tenantRedisPurgePlanEntryRootSha256(planEntries),
  databasePurgeReceiptSha256: DIGEST_C,
  graveMarkerCount: 1,
  graveMarkerRootSha256: tenantRedisPurgeGraveMarkerRootSha256([DIGEST_D]),
  redisNamespaceSha256: DIGEST_A,
  policySha256: DIGEST_D,
  purgeNotBeforeDbMs: 10,
  sourceEvidenceDbMs: 20,
  sourceUnresolvedBlockerCount: 9,
};

function buildTarget(): TenantRedisPurgeTarget {
  const leasePlanTargetSha256 = tenantRedisPurgePlanTargetSha256("redis_leases", SESSION_ID);
  const fencePlanTargetSha256 = tenantRedisPurgePlanTargetSha256("redis_fences", SESSION_ID);
  const streamPlanTargetSha256 = tenantRedisPurgePlanTargetSha256("redis_streams", SESSION_ID);
  const operationSha256 = tenantRedisPurgeOperationSha256({
    identity: source,
    sessionId: SESSION_ID,
    graveMarkerSha256: DIGEST_D,
    redisNamespaceSha256: source.redisNamespaceSha256,
    leasePlanTargetSha256,
    fencePlanTargetSha256,
    streamPlanTargetSha256,
  });
  const body = {
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    planBuildGeneration: source.planBuildGeneration,
    executionGeneration: source.executionGeneration,
    databasePurgeGeneration: source.databasePurgeGeneration,
    redisPurgeGeneration: source.redisPurgeGeneration,
    scope: TENANT_REDIS_PURGE_TARGET_SCOPE,
    targetOrdinal: 0,
    sessionId: SESSION_ID,
    graveMarkerSha256: DIGEST_D,
    redisNamespaceSha256: source.redisNamespaceSha256,
    leasePlanTargetSha256,
    fencePlanTargetSha256,
    streamPlanTargetSha256,
    operationSha256,
    capturedAtDbMs: 30,
  };
  return { ...body, receiptSha256: tenantRedisPurgeTargetSha256(body) };
}

function buildTargetAck(target: TenantRedisPurgeTarget): TenantRedisPurgeTargetAck {
  const evidence = {
    adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
    redisNamespaceSha256: source.redisNamespaceSha256,
    sessionId: SESSION_ID,
    operationSha256: target.operationSha256,
    leaseExisted: true,
    fenceExisted: false,
    streamExisted: true,
  };
  const body = {
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    planBuildGeneration: source.planBuildGeneration,
    executionGeneration: source.executionGeneration,
    databasePurgeGeneration: source.databasePurgeGeneration,
    redisPurgeGeneration: source.redisPurgeGeneration,
    scope: TENANT_REDIS_PURGE_TARGET_ACK_SCOPE,
    targetOrdinal: target.targetOrdinal,
    targetReceiptSha256: target.receiptSha256,
    ...evidence,
    markerSha256: tenantRedisPurgeMarkerSha256(evidence),
    // This is intentionally claim 1; the terminal receipt below is sealed by claim 2.
    completedClaimAttempt: 1,
    completedClaimTokenSha256: tenantRedisPurgeClaimTokenSha256("claim:first"),
    storeDbTimestampMs: 31,
  };
  return { ...body, receiptSha256: tenantRedisPurgeTargetAckSha256(body) };
}

function buildBundle() {
  const target = buildTarget();
  const targetAck = buildTargetAck(target);
  const targetAckRootSha256 = tenantRedisPurgeTargetAckRootSha256([targetAck]);
  const markerRootSha256 = tenantRedisPurgeMarkerRootSha256([targetAck]);
  const completedClaimTokenSha256 = tenantRedisPurgeClaimTokenSha256("claim:second");
  let previousGlobalAckSha256 = EMPTY_TENANT_REDIS_PURGE_DOMAIN_ACK_ROOT_SHA256;
  const domainAcks: TenantRedisPurgeDomainAck[] = TENANT_REDIS_PURGE_DOMAINS.map(
    (domain, domainOrdinal) => {
      const body = {
        requestId: source.requestId,
        tenantId: source.tenantId,
        subjectGeneration: source.subjectGeneration,
        planBuildGeneration: source.planBuildGeneration,
        executionGeneration: source.executionGeneration,
        databasePurgeGeneration: source.databasePurgeGeneration,
        redisPurgeGeneration: source.redisPurgeGeneration,
        scope: TENANT_REDIS_PURGE_DOMAIN_ACK_SCOPE,
        domain,
        domainOrdinal,
        globalAckSeq: domainOrdinal + 1,
        previousGlobalAckSha256,
        planEntryReceiptSha256: planEntries[domainOrdinal]!.planEntryReceiptSha256,
        planTargetCount: 1,
        planTargetRootSha256: tenantRedisPurgePlanTargetRootSha256(domain, [SESSION_ID]),
        affectedCount: 1,
        targetAckCount: 1,
        targetAckRootSha256,
        markerCount: 1,
        markerRootSha256,
        adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
        redisNamespaceSha256: source.redisNamespaceSha256,
        completedClaimAttempt: 2,
        completedClaimTokenSha256,
        storeDbTimestampMs: 40,
      };
      const ack = { ...body, receiptSha256: tenantRedisPurgeDomainAckSha256(body) };
      previousGlobalAckSha256 = tenantRedisPurgeNextDomainAckRootSha256(
        previousGlobalAckSha256,
        domain,
        ack.receiptSha256,
      );
      return ack;
    },
  );
  const receiptBody = {
    ...source,
    scope: TENANT_REDIS_PURGE_RECEIPT_SCOPE,
    targetCount: 1,
    targetRootSha256: tenantRedisPurgeTargetRootSha256([target]),
    targetAckCount: 1,
    targetAckRootSha256,
    domainAckCount: 3,
    domainAckRootSha256: tenantRedisPurgeDomainAckRootSha256(domainAcks),
    markerCount: 1,
    markerRootSha256,
    unresolvedBlockerCount: 6,
    storeDbTimestampMs: 40,
    completedClaimAttempt: 2,
    completedClaimTokenSha256,
    redisPurgeComplete: true as const,
    allDomainsComplete: false as const,
    contentPurgeExecuted: false as const,
  };
  const receipt: TenantRedisPurgeReceipt = {
    ...receiptBody,
    receiptSha256: tenantRedisPurgeReceiptSha256(receiptBody),
  };
  return { target, targetAck, domainAcks, receipt };
}

describe("tenant Redis purge evidence", () => {
  it("accepts target ACKs from earlier claims while binding the terminal ACKs to the seal claim", () => {
    const { target, targetAck, domainAcks, receipt } = buildBundle();
    expect(targetAck.completedClaimAttempt).toBe(1);
    expect(receipt.completedClaimAttempt).toBe(2);
    expect(() => validateTenantRedisPurgeEvidenceBundle({
      targets: [target],
      targetAcks: [targetAck],
      domainAcks,
      receipt,
    })).not.toThrow();
  });

  it("binds stable adapter proof to namespace, operation, and the first existence bits", () => {
    const target = buildTarget();
    const evidence = {
      adapterProtocol: TENANT_REDIS_PURGE_ADAPTER_PROTOCOL,
      redisNamespaceSha256: source.redisNamespaceSha256,
      sessionId: target.sessionId,
      operationSha256: target.operationSha256,
      leaseExisted: true,
      fenceExisted: false,
      streamExisted: true,
    };
    const result = {
      ...evidence,
      markerSha256: tenantRedisPurgeMarkerSha256(evidence),
      replayed: true,
    };
    expect(() => validateTenantRedisPurgeAdapterResult(result)).not.toThrow();
    expect(() => validateTenantRedisPurgeAdapterResult({
      ...result,
      fenceExisted: true,
    })).toThrow(/marker does not match/);
  });

  it("projects a content-free terminal restore fence", () => {
    const { target, targetAck, receipt } = buildBundle();
    const body = {
      requestId: source.requestId,
      tenantId: source.tenantId,
      subjectGeneration: source.subjectGeneration,
      planBuildGeneration: source.planBuildGeneration,
      executionGeneration: source.executionGeneration,
      databasePurgeGeneration: source.databasePurgeGeneration,
      redisPurgeGeneration: source.redisPurgeGeneration,
      scope: TENANT_REDIS_PURGE_RESTORE_FENCE_SCOPE,
      jobPhase: "redis_purge_sealed" as const,
      targetOrdinal: target.targetOrdinal,
      sessionId: target.sessionId,
      targetReceiptSha256: target.receiptSha256,
      targetAckReceiptSha256: targetAck.receiptSha256,
      terminalReceiptSha256: receipt.receiptSha256,
      operationSha256: target.operationSha256,
      adapterProtocol: targetAck.adapterProtocol,
      redisNamespaceSha256: targetAck.redisNamespaceSha256,
      leaseExisted: targetAck.leaseExisted,
      fenceExisted: targetAck.fenceExisted,
      streamExisted: targetAck.streamExisted,
      markerSha256: targetAck.markerSha256,
    };
    const fence: TenantRedisPurgeRestoreFence = {
      ...body,
      fenceSha256: tenantRedisPurgeRestoreFenceSha256(body),
    };
    expect(() => validateTenantRedisPurgeRestoreFence(fence)).not.toThrow();
    expect(JSON.stringify(fence)).not.toMatch(/owner|addr|redis:\/\/|payload|claim:/);

    const partialBody = {
      ...body,
      jobPhase: "blocked" as const,
      terminalReceiptSha256: null,
    };
    expect(() => validateTenantRedisPurgeRestoreFence({
      ...partialBody,
      fenceSha256: tenantRedisPurgeRestoreFenceSha256(partialBody),
    })).not.toThrow();
    expect(() => tenantRedisPurgeRestoreFenceSha256({
      ...body,
      jobPhase: "queued",
    })).toThrow(/partial.*terminal receipt/);
  });

  it("rejects a plan target spliced from another session", () => {
    const target = buildTarget();
    expect(() => tenantRedisPurgeOperationSha256({
      identity: source,
      sessionId: target.sessionId,
      graveMarkerSha256: target.graveMarkerSha256,
      redisNamespaceSha256: target.redisNamespaceSha256,
      leasePlanTargetSha256: DIGEST_A,
      fencePlanTargetSha256: target.fencePlanTargetSha256,
      streamPlanTargetSha256: target.streamPlanTargetSha256,
    })).toThrow(/plan target does not match/);
  });

  it("makes the first terminal receipt and Redis namespace a write-once cutover", () => {
    const body = {
      singletonId: TENANT_REDIS_PURGE_CUTOVER_SINGLETON_ID,
      controlGeneration: 1 as const,
      activatedAtDbMs: 50,
      firstRequestId: source.requestId,
      firstReceiptSha256: DIGEST_B,
      redisNamespaceSha256: source.redisNamespaceSha256,
    };
    const record = {
      ...body,
      evidenceSha256: tenantRedisPurgeCutoverEvidenceSha256(body),
    };
    expect(() => validateTenantRedisPurgeCutoverRecord(record)).not.toThrow();
    expect(() => validateTenantRedisPurgeCutoverRecord({
      ...record,
      redisNamespaceSha256: DIGEST_C,
    })).toThrow(/evidence does not match/);
  });
});
