import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
  EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
  EMPTY_TENANT_PURGE_EXECUTION_OUTBOX_ROOT_SHA256,
  TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
  TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE,
  TENANT_PURGE_LOCAL_CUTOVER_SCOPE,
  tenantPurgeExecutionCutoverEvidenceSha256,
  tenantPurgeExecutionDomainAckSha256,
  tenantPurgeExecutionNextDomainAckRootSha256,
  tenantPurgeExecutionNextGlobalAckRootSha256,
  tenantPurgeExecutionOutboxRootSha256,
  tenantPurgeExecutionOutboxTargetSha256,
  tenantPurgeLocalCutoverReceiptSha256,
  validateTenantPurgeExecutionCutoverRecord,
  validateTenantPurgeExecutionDomainAck,
  validateTenantPurgeExecutionJobRecord,
  validateTenantPurgeLocalCutoverReceipt,
  type TenantPurgeExecutionDomainAck,
  type TenantPurgeExecutionJobRecord,
  type TenantPurgeExecutionSource,
  type TenantPurgeLocalCutoverReceipt,
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);

const source: TenantPurgeExecutionSource = {
  requestId: "erase_12345678-1234-4123-8123-123456789abc",
  tenantId: "tenant-a",
  subjectGeneration: 1,
  planBuildGeneration: 2,
  executionGeneration: 1,
  t3cReceiptSha256: DIGEST_A,
  planReceiptSha256: DIGEST_B,
  planEntryRootSha256: DIGEST_C,
  planBlockerCount: 9,
  planBlockerRootSha256: DIGEST_D,
  policySha256: DIGEST_A,
  purgeNotBeforeDbMs: 10,
  sourceEvidenceDbMs: 20,
};

function scheduledAck(): TenantPurgeExecutionDomainAck {
  const body = {
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    planBuildGeneration: source.planBuildGeneration,
    executionGeneration: source.executionGeneration,
    scope: TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE,
    domain: "blob_bytes" as const,
    globalAckSeq: 1,
    domainAckSeq: 1,
    previousDomainAckSha256: EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
    previousGlobalAckSha256: EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
    ackKind: "outbox_scheduled" as const,
    planEntryReceiptSha256: DIGEST_B,
    affectedCount: 1,
    resultCount: 1,
    resultRootSha256: DIGEST_C,
    adapterProtocol: "local-store-v1",
    operationSha256: DIGEST_D,
    physicalProofSha256: DIGEST_A,
    completedClaimAttempt: 1,
    completedClaimTokenSha256: DIGEST_B,
    storeDbTimestampMs: 21,
    final: false,
    outboxKind: "blob_delete" as const,
    outboxId: 7,
    deletionGeneration: 3,
    targetSha256: DIGEST_C,
  };
  return { ...body, receiptSha256: tenantPurgeExecutionDomainAckSha256(body) };
}

describe("tenant purge execution evidence", () => {
  it("binds the one-way global cutover to its first exact receipt", () => {
    const body = {
      singletonId: TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
      controlGeneration: 1 as const,
      activatedAtDbMs: 25,
      firstRequestId: source.requestId,
      firstReceiptSha256: DIGEST_A,
    };
    const record = {
      ...body,
      evidenceSha256: tenantPurgeExecutionCutoverEvidenceSha256(body),
    };
    expect(() => validateTenantPurgeExecutionCutoverRecord(record)).not.toThrow();
    expect(() => validateTenantPurgeExecutionCutoverRecord({
      ...record,
      firstReceiptSha256: DIGEST_B,
    })).toThrow(/evidence does not match/);
  });

  it("requires complete exact-outbox correlation and chains ACKs in both scopes", () => {
    const ack = scheduledAck();
    expect(() => validateTenantPurgeExecutionDomainAck(ack)).not.toThrow();
    expect(tenantPurgeExecutionNextDomainAckRootSha256(
      ack.previousDomainAckSha256,
      ack.domain,
      ack.receiptSha256,
    )).not.toBe(ack.previousDomainAckSha256);
    expect(tenantPurgeExecutionNextGlobalAckRootSha256(
      ack.previousGlobalAckSha256,
      ack.globalAckSeq,
      ack.receiptSha256,
    )).not.toBe(ack.previousGlobalAckSha256);

    const { outboxId: _outboxId, receiptSha256: _receiptSha256, ...partial } = ack;
    expect(() => tenantPurgeExecutionDomainAckSha256(partial as never)).toThrow(
      /outbox reference is incomplete/,
    );
    expect(() => tenantPurgeExecutionDomainAckSha256({
      ...partial,
      outboxId: ack.outboxId,
      ackKind: "physical_delete",
    } as never)).toThrow(/lacks its scheduled ACK/);
    expect(() => tenantPurgeExecutionDomainAckSha256({
      ...ack,
      ackKind: "applied",
    } as never)).toThrow(/non-outbox ACK has an outbox reference/);
  });

  it("sorts exact outbox targets and rejects duplicates", () => {
    const first = {
      outboxKind: "blob_delete" as const,
      outboxId: 2,
      deletionGeneration: 1,
      targetSha256: DIGEST_A,
    };
    const second = {
      outboxKind: "user_export_delete" as const,
      outboxId: 1,
      deletionGeneration: 3,
      targetSha256: DIGEST_B,
    };
    expect(tenantPurgeExecutionOutboxRootSha256([first, second])).toBe(
      tenantPurgeExecutionOutboxRootSha256([second, first]),
    );
    expect(tenantPurgeExecutionOutboxTargetSha256(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => tenantPurgeExecutionOutboxRootSha256([first, first])).toThrow(/duplicated/);
  });

  it("keeps a local cutover explicitly short of physical and full completion", () => {
    const body = {
      ...source,
      scope: TENANT_PURGE_LOCAL_CUTOVER_SCOPE,
      operationalUsageTargetCount: 2,
      operationalUsageTargetRootSha256: DIGEST_A,
      blobBytesTargetCount: 1,
      blobBytesTargetRootSha256: DIGEST_B,
      blobDeleteOutboxCount: 1,
      blobDeleteOutboxRootSha256: DIGEST_C,
      exportBytesTargetCount: 0,
      exportBytesTargetRootSha256: DIGEST_D,
      exportDeleteOutboxCount: 0,
      exportDeleteOutboxRootSha256: EMPTY_TENANT_PURGE_EXECUTION_OUTBOX_ROOT_SHA256,
      domainAckCount: 5,
      domainAckRootSha256: DIGEST_A,
      storeDbTimestampMs: 30,
      completedClaimAttempt: 1,
      completedClaimTokenSha256: DIGEST_B,
      localDestructiveProgress: true as const,
      physicalAcksComplete: false as const,
      allDomainsComplete: false as const,
      contentPurgeExecuted: false as const,
    };
    const receipt: TenantPurgeLocalCutoverReceipt = {
      ...body,
      receiptSha256: tenantPurgeLocalCutoverReceiptSha256(body),
    };
    expect(() => validateTenantPurgeLocalCutoverReceipt(receipt)).not.toThrow();
    expect(() => tenantPurgeLocalCutoverReceiptSha256({
      ...body,
      blobDeleteOutboxCount: 0,
    })).toThrow(/does not cover/);
  });

  it("validates the queued source envelope and rejects blocker drift", () => {
    const job: TenantPurgeExecutionJobRecord = {
      ...source,
      phase: "queued",
      domainCount: 33,
      domainAckCount: 0,
      domainAckRootSha256: EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
      unresolvedBlockerCount: source.planBlockerCount,
      availableAtMs: 20,
      attempts: 0,
      createdAtMs: 20,
      updatedAtMs: 20,
    };
    expect(() => validateTenantPurgeExecutionJobRecord(job)).not.toThrow();
    expect(() => validateTenantPurgeExecutionJobRecord({
      ...job,
      unresolvedBlockerCount: source.planBlockerCount + 1,
    })).toThrow(/unresolved blocker count/);
  });
});
