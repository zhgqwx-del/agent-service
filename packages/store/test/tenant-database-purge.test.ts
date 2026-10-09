import { describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256,
  EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256,
  TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN,
  TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL,
  TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID,
  TENANT_DATABASE_PURGE_DOMAIN_ACK_SCOPE,
  TENANT_DATABASE_PURGE_DOMAINS,
  TENANT_DATABASE_PURGE_PREDELETE_ENTRY_SCOPE,
  TENANT_DATABASE_PURGE_PREDELETE_RECEIPT_SCOPE,
  TENANT_DATABASE_PURGE_RECEIPT_SCOPE,
  TENANT_DATABASE_PURGE_T3E_SUCCESSOR_DOMAINS,
  TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE,
  tenantDatabasePurgeAuthorizationMatches,
  tenantDatabasePurgeBillingFactRootSha256,
  tenantDatabasePurgeBridgeKind,
  tenantDatabasePurgeBridgeSha256,
  tenantDatabasePurgeClaimFromJob,
  tenantDatabasePurgeClaimTokenSha256,
  tenantDatabasePurgeCutoverEvidenceSha256,
  tenantDatabasePurgeDomainAckRootSha256,
  tenantDatabasePurgeDomainAckSha256,
  tenantDatabasePurgeDomainOrdinal,
  tenantDatabasePurgeNextDomainAckRootSha256,
  tenantDatabasePurgeOperationSha256,
  tenantDatabasePurgePhysicalProofSha256,
  tenantDatabasePurgePreDeleteEntryRootSha256,
  tenantDatabasePurgePreDeleteEntrySha256,
  tenantDatabasePurgePreDeleteReceiptSha256,
  tenantDatabasePurgeReceiptMatchesAuthorization,
  tenantDatabasePurgeReceiptSha256,
  tenantDatabasePurgeRetainedEvidenceRootSha256,
  tenantDatabasePurgeSessionGraveMarkerRootSha256,
  tenantDatabasePurgeSessionGraveMarkerSha256,
  tenantDatabasePurgeSessionGraveOwnerSha256,
  tenantDatabasePurgeTargetRootSha256,
  tenantDatabasePurgeTargetSha256,
  validateTenantDatabasePurgeClaim,
  validateTenantDatabasePurgeCompletionProof,
  validateTenantDatabasePurgeCutoverRecord,
  validateTenantDatabasePurgeDomainAck,
  validateTenantDatabasePurgeEvidenceBundle,
  validateTenantDatabasePurgeJobRecord,
  validateTenantDatabasePurgePreDeleteEntryAgainstSource,
  validateTenantDatabasePurgePreDeleteReceipt,
  validateTenantDatabasePurgeReceipt,
  validateTenantDatabasePurgeSessionGraveMarker,
  type TenantDatabasePurgeAuthorization,
  type TenantDatabasePurgeDomainAck,
  type TenantDatabasePurgeEvidenceBundle,
  type TenantDatabasePurgeJobRecord,
  type TenantDatabasePurgePreDeleteEntry,
  type TenantDatabasePurgePreDeleteReceipt,
  type TenantDatabasePurgeReceipt,
  type TenantDatabasePurgeSource,
  type TenantPurgeSessionGraveMarker,
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const SESSION_ID = "sess_0199aabb-ccdd-7001-8000-000000000024";
const CLAIM_TOKEN = "claim:t3f:one";

const source: TenantDatabasePurgeSource = {
  requestId: "erase_12345678-1234-4123-8123-123456789abc",
  tenantId: "tenant-a",
  subjectGeneration: 1,
  planBuildGeneration: 2,
  executionGeneration: 3,
  databasePurgeGeneration: 1,
  t3cReceiptSha256: DIGEST_A,
  planReceiptSha256: DIGEST_B,
  localPhysicalAckReceiptSha256: DIGEST_C,
  policySha256: DIGEST_D,
  purgeNotBeforeDbMs: 10,
  sourceEvidenceDbMs: 20,
};

const authorization: TenantDatabasePurgeAuthorization = {
  requestId: source.requestId,
  tenantId: source.tenantId,
  subjectGeneration: source.subjectGeneration,
  planBuildGeneration: source.planBuildGeneration,
  executionGeneration: source.executionGeneration,
  databasePurgeGeneration: source.databasePurgeGeneration,
  claimAttempt: 1,
  claimToken: CLAIM_TOKEN,
};

function indexedDigest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function buildEntries(): TenantDatabasePurgePreDeleteEntry[] {
  return TENANT_DATABASE_PURGE_DOMAINS.map((domain, domainOrdinal) => {
    const planEntryReceiptSha256 = indexedDigest(domainOrdinal + 1);
    const bridgeKind = tenantDatabasePurgeBridgeKind(domain);
    const successor = bridgeKind === "t3e_successor";
    const session = domain === "session_content";
    const planTargetCount = 1;
    const planTargetRootSha256 = session
      ? DIGEST_D
      : tenantDatabasePurgeTargetRootSha256(domain, [
          tenantDatabasePurgeTargetSha256(domain, ["plan", domainOrdinal]),
        ]);
    const preDeleteTargetCount = successor ? 0 : 1;
    const preDeleteTargetRootSha256 = successor
      ? tenantDatabasePurgeTargetRootSha256(domain, [])
      : session
        ? tenantDatabasePurgeTargetRootSha256(domain, [
            tenantDatabasePurgeTargetSha256(domain, [SESSION_ID, DIGEST_C]),
          ])
        : planTargetRootSha256;
    const bridgeSha256 = tenantDatabasePurgeBridgeSha256(
      bridgeKind === "direct_plan"
        ? {
            bridgeKind,
            domain,
            planEntryReceiptSha256,
            planTargetCount,
            planTargetRootSha256,
            preDeleteTargetCount,
            preDeleteTargetRootSha256,
          }
        : {
            bridgeKind,
            domain,
            planEntryReceiptSha256,
            planTargetCount,
            planTargetRootSha256,
            localPhysicalAckReceiptSha256: source.localPhysicalAckReceiptSha256,
            preDeleteTargetCount,
            preDeleteTargetRootSha256,
          },
    );
    const body = {
      requestId: source.requestId,
      tenantId: source.tenantId,
      subjectGeneration: source.subjectGeneration,
      planBuildGeneration: source.planBuildGeneration,
      executionGeneration: source.executionGeneration,
      databasePurgeGeneration: source.databasePurgeGeneration,
      scope: TENANT_DATABASE_PURGE_PREDELETE_ENTRY_SCOPE,
      domain,
      domainOrdinal,
      action: TENANT_DATABASE_PURGE_ACTION_BY_DOMAIN[domain],
      planEntryReceiptSha256,
      planTargetCount,
      planTargetRootSha256,
      bridgeKind,
      bridgeSha256,
      preDeleteTargetCount,
      preDeleteTargetRootSha256,
      capturedAtDbMs: 30,
    };
    return { ...body, receiptSha256: tenantDatabasePurgePreDeleteEntrySha256(body) };
  });
}

function buildAcks(
  entries: readonly TenantDatabasePurgePreDeleteEntry[],
  graveMarkers: readonly TenantPurgeSessionGraveMarker[],
): {
  acks: TenantDatabasePurgeDomainAck[];
  billingEvidenceCount: number;
  billingEvidenceRootSha256: string;
} {
  let previousGlobalAckSha256 = EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256;
  const acks: TenantDatabasePurgeDomainAck[] = [];
  for (const entry of entries) {
    const clear = entry.action === "clear";
    const retain = entry.action === "retain_anonymized";
    const sessionDelete = entry.action === "delete_with_grave_markers";
    const resultTargetCount = clear ? 1 : 0;
    const resultTargetRootSha256 = clear
      ? tenantDatabasePurgeTargetRootSha256(entry.domain, [
          tenantDatabasePurgeTargetSha256(entry.domain, ["cleared"]),
        ])
      : tenantDatabasePurgeTargetRootSha256(entry.domain, []);
    const retainedEvidenceCount = sessionDelete ? graveMarkers.length : retain ? 1 : 0;
    const retainedEvidenceRootSha256 = sessionDelete
      ? tenantDatabasePurgeSessionGraveMarkerRootSha256(graveMarkers)
      : tenantDatabasePurgeRetainedEvidenceRootSha256(
          entry.domain,
          retain ? [DIGEST_A] : [],
        );
    const operationSha256 = tenantDatabasePurgeOperationSha256({
      identity: source,
      domain: entry.domain,
      action: entry.action,
      preDeleteTargetCount: entry.preDeleteTargetCount,
      preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
      affectedCount: entry.preDeleteTargetCount,
      resultTargetCount,
      resultTargetRootSha256,
      retainedEvidenceCount,
      retainedEvidenceRootSha256,
    });
    const body = {
      requestId: source.requestId,
      tenantId: source.tenantId,
      subjectGeneration: source.subjectGeneration,
      planBuildGeneration: source.planBuildGeneration,
      executionGeneration: source.executionGeneration,
      databasePurgeGeneration: source.databasePurgeGeneration,
      scope: TENANT_DATABASE_PURGE_DOMAIN_ACK_SCOPE,
      domain: entry.domain,
      domainOrdinal: entry.domainOrdinal,
      globalAckSeq: entry.domainOrdinal + 1,
      previousGlobalAckSha256,
      preDeleteEntryReceiptSha256: entry.receiptSha256,
      action: entry.action,
      preDeleteTargetCount: entry.preDeleteTargetCount,
      preDeleteTargetRootSha256: entry.preDeleteTargetRootSha256,
      affectedCount: entry.preDeleteTargetCount,
      resultTargetCount,
      resultTargetRootSha256,
      retainedEvidenceCount,
      retainedEvidenceRootSha256,
      adapterProtocol: TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL,
      operationSha256,
      physicalProofSha256: tenantDatabasePurgePhysicalProofSha256({
        identity: source,
        domain: entry.domain,
        action: entry.action,
        adapterProtocol: TENANT_DATABASE_PURGE_ADAPTER_PROTOCOL,
        previousGlobalAckSha256,
        preDeleteEntryReceiptSha256: entry.receiptSha256,
        operationSha256,
        storeDbTimestampMs: 30,
        completedClaimAttempt: authorization.claimAttempt,
        completedClaimTokenSha256: tenantDatabasePurgeClaimTokenSha256(CLAIM_TOKEN),
      }),
      completedClaimAttempt: authorization.claimAttempt,
      completedClaimTokenSha256: tenantDatabasePurgeClaimTokenSha256(CLAIM_TOKEN),
      storeDbTimestampMs: 30,
    };
    const ack = { ...body, receiptSha256: tenantDatabasePurgeDomainAckSha256(body) };
    acks.push(ack);
    previousGlobalAckSha256 = tenantDatabasePurgeNextDomainAckRootSha256(
      previousGlobalAckSha256,
      ack.globalAckSeq,
      ack.domain,
      ack.receiptSha256,
    );
  }
  const billingAck = acks.find((ack) => ack.domain === "billing_reconciliation")!;
  return {
    acks,
    billingEvidenceCount: billingAck.retainedEvidenceCount,
    billingEvidenceRootSha256: billingAck.retainedEvidenceRootSha256,
  };
}

function buildBundle(): TenantDatabasePurgeEvidenceBundle {
  const preDeleteEntries = buildEntries();
  const sessionEntry = preDeleteEntries.find((entry) => entry.domain === "session_content")!;
  const billingEntry = preDeleteEntries.find(
    (entry) => entry.domain === "billing_reconciliation",
  )!;
  const preDeleteBody = {
    ...source,
    scope: TENANT_DATABASE_PURGE_PREDELETE_RECEIPT_SCOPE,
    entryCount: preDeleteEntries.length,
    entryRootSha256: tenantDatabasePurgePreDeleteEntryRootSha256(preDeleteEntries),
    sessionTargetCount: sessionEntry.preDeleteTargetCount,
    sessionTargetRootSha256: sessionEntry.preDeleteTargetRootSha256,
    retainedBillingFactCount: 3,
    retainedBillingFactRootSha256: tenantDatabasePurgeBillingFactRootSha256([
      DIGEST_A,
      DIGEST_B,
      DIGEST_C,
    ]),
    billingReconciliationTargetCount: billingEntry.preDeleteTargetCount,
    billingReconciliationTargetRootSha256: billingEntry.preDeleteTargetRootSha256,
    storeDbTimestampMs: 30,
    completedClaimAttempt: authorization.claimAttempt,
    completedClaimTokenSha256: tenantDatabasePurgeClaimTokenSha256(CLAIM_TOKEN),
    preDeleteComplete: true as const,
    destructiveProgress: false as const,
    contentPurgeExecuted: false as const,
  };
  const preDeleteReceipt: TenantDatabasePurgePreDeleteReceipt = {
    ...preDeleteBody,
    receiptSha256: tenantDatabasePurgePreDeleteReceiptSha256(preDeleteBody),
  };
  const graveBody = {
    requestId: source.requestId,
    tenantId: source.tenantId,
    subjectGeneration: source.subjectGeneration,
    planBuildGeneration: source.planBuildGeneration,
    executionGeneration: source.executionGeneration,
    databasePurgeGeneration: source.databasePurgeGeneration,
    scope: TENANT_PURGE_SESSION_GRAVE_MARKER_SCOPE,
    sessionId: SESSION_ID,
    deletionGeneration: 2,
    deletedAtDbMs: 25,
    ownerSha256: tenantDatabasePurgeSessionGraveOwnerSha256({
      tenantId: source.tenantId,
      userId: "user-a",
      sessionId: SESSION_ID,
    }),
    t3cSessionReceiptSha256: DIGEST_C,
    preDeleteReceiptSha256: preDeleteReceipt.receiptSha256,
    markedAtDbMs: 30,
  };
  const graveMarkers: TenantPurgeSessionGraveMarker[] = [{
    ...graveBody,
    markerSha256: tenantDatabasePurgeSessionGraveMarkerSha256(graveBody),
  }];
  const { acks: domainAcks, billingEvidenceCount, billingEvidenceRootSha256 } = buildAcks(
    preDeleteEntries,
    graveMarkers,
  );
  const receiptBody = {
    ...source,
    scope: TENANT_DATABASE_PURGE_RECEIPT_SCOPE,
    preDeleteReceiptSha256: preDeleteReceipt.receiptSha256,
    preDeleteEntryCount: preDeleteEntries.length,
    preDeleteEntryRootSha256: preDeleteReceipt.entryRootSha256,
    domainAckCount: domainAcks.length,
    domainAckRootSha256: tenantDatabasePurgeDomainAckRootSha256(domainAcks),
    graveMarkerCount: graveMarkers.length,
    graveMarkerRootSha256: tenantDatabasePurgeSessionGraveMarkerRootSha256(graveMarkers),
    retainedBillingFactCount: preDeleteReceipt.retainedBillingFactCount,
    retainedBillingFactRootSha256: preDeleteReceipt.retainedBillingFactRootSha256,
    billingReconciliationEvidenceCount: billingEvidenceCount,
    billingReconciliationEvidenceRootSha256: billingEvidenceRootSha256,
    unresolvedBlockerCount: 9,
    storeDbTimestampMs: 30,
    completedClaimAttempt: authorization.claimAttempt,
    completedClaimTokenSha256: tenantDatabasePurgeClaimTokenSha256(CLAIM_TOKEN),
    localDatabasePurgeComplete: true as const,
    sessionContentDeleted: true as const,
    allDomainsComplete: false as const,
    contentPurgeExecuted: false as const,
  };
  const receipt: TenantDatabasePurgeReceipt = {
    ...receiptBody,
    receiptSha256: tenantDatabasePurgeReceiptSha256(receiptBody),
  };
  return { preDeleteEntries, preDeleteReceipt, domainAcks, graveMarkers, receipt };
}

describe("tenant database purge evidence contract", () => {
  it("freezes the 11-domain order and exact bridge split", () => {
    expect(TENANT_DATABASE_PURGE_DOMAINS).toHaveLength(11);
    expect(TENANT_DATABASE_PURGE_DOMAINS.map(tenantDatabasePurgeDomainOrdinal)).toEqual(
      [...Array(11).keys()],
    );
    expect(TENANT_DATABASE_PURGE_T3E_SUCCESSOR_DOMAINS).toEqual([
      "blob_manifest",
      "blob_outbox",
      "user_export_control",
      "user_export_snapshots",
      "user_export_artifacts",
    ]);
    expect(tenantDatabasePurgeBridgeKind("session_content")).toBe("direct_plan");
    expect(tenantDatabasePurgeBridgeKind("blob_manifest")).toBe("t3e_successor");
  });

  it("binds direct and T3e-successor bridges without treating T3c receipts as session rows", () => {
    const entries = buildEntries();
    const session = entries.find((entry) => entry.domain === "session_content")!;
    expect(session.planTargetCount).toBe(1);
    expect(session.preDeleteTargetCount).toBe(1);
    expect(() => validateTenantDatabasePurgePreDeleteEntryAgainstSource(session, source))
      .not.toThrow();

    const blob = entries.find((entry) => entry.domain === "blob_manifest")!;
    expect(() => validateTenantDatabasePurgePreDeleteEntryAgainstSource(blob, source))
      .not.toThrow();
    expect(() => validateTenantDatabasePurgePreDeleteEntryAgainstSource({
      ...blob,
      bridgeSha256: DIGEST_D,
      receiptSha256: tenantDatabasePurgePreDeleteEntrySha256({
        ...blob,
        bridgeSha256: DIGEST_D,
      }),
    }, source)).toThrow(/bridge hash does not match its source/);

    expect(tenantDatabasePurgeTargetRootSha256("blob_outbox", [DIGEST_A, DIGEST_B]))
      .toBe(tenantDatabasePurgeTargetRootSha256("blob_outbox", [DIGEST_B, DIGEST_A]));
    expect(() => tenantDatabasePurgeTargetRootSha256(
      "blob_outbox",
      [DIGEST_A, DIGEST_A],
    )).toThrow(/duplicated/);
    expect(() => tenantDatabasePurgeTargetSha256(
      "blob_outbox",
      ["outbox", undefined as never],
    )).toThrow(/non-canonical value/);
    expect(() => tenantDatabasePurgeTargetSha256(
      "blob_outbox",
      ["outbox", { hidden: true } as never],
    )).toThrow(/non-canonical value/);
  });

  it("validates the complete atomic evidence graph and rejects cross-record drift", () => {
    const bundle = buildBundle();
    expect(() => validateTenantDatabasePurgeEvidenceBundle(bundle)).not.toThrow();
    const completedJob: TenantDatabasePurgeJobRecord = {
      ...source,
      phase: "database_purged",
      domainCount: TENANT_DATABASE_PURGE_DOMAINS.length,
      preDeleteEntryCount: bundle.receipt.preDeleteEntryCount,
      preDeleteEntryRootSha256: bundle.receipt.preDeleteEntryRootSha256,
      domainAckCount: bundle.receipt.domainAckCount,
      domainAckRootSha256: bundle.receipt.domainAckRootSha256,
      unresolvedBlockerCount: bundle.receipt.unresolvedBlockerCount,
      attempts: bundle.receipt.completedClaimAttempt,
      createdAtMs: source.sourceEvidenceDbMs,
      updatedAtMs: bundle.receipt.storeDbTimestampMs,
      preDeleteReceiptSha256: bundle.receipt.preDeleteReceiptSha256,
      terminalReceiptSha256: bundle.receipt.receiptSha256,
      purgedAtDbMs: bundle.receipt.storeDbTimestampMs,
      completedClaimAttempt: bundle.receipt.completedClaimAttempt,
      completedClaimTokenSha256: bundle.receipt.completedClaimTokenSha256,
    };
    expect(() => validateTenantDatabasePurgeCompletionProof(completedJob, bundle)).not.toThrow();
    expect(() => validateTenantDatabasePurgeCompletionProof({
      ...completedJob,
      policySha256: DIGEST_A,
    }, bundle)).toThrow(/source does not match/);
    expect(() => validateTenantDatabasePurgeCompletionProof({
      ...completedJob,
      terminalReceiptSha256: DIGEST_D,
    }, bundle)).toThrow(/evidence does not match/);
    expect(bundle.preDeleteReceipt).not.toHaveProperty("graveMarkerRootSha256");
    expect(bundle.graveMarkers[0]?.preDeleteReceiptSha256).toBe(
      bundle.preDeleteReceipt.receiptSha256,
    );
    expect(bundle.receipt.graveMarkerRootSha256).toBe(
      tenantDatabasePurgeSessionGraveMarkerRootSha256(bundle.graveMarkers),
    );
    expect(() => validateTenantDatabasePurgeEvidenceBundle({
      ...bundle,
      receipt: {
        ...bundle.receipt,
        retainedBillingFactRootSha256: DIGEST_C,
        receiptSha256: tenantDatabasePurgeReceiptSha256({
          ...bundle.receipt,
          retainedBillingFactRootSha256: DIGEST_C,
        }),
      },
    })).toThrow(/changed retained billing facts/);
    expect(() => validateTenantDatabasePurgeEvidenceBundle({
      ...bundle,
      domainAcks: bundle.domainAcks.slice(1),
    })).toThrow(/ACK catalog/);

    // Re-hash every downstream envelope after replacing the whole session identity. Individual
    // hashes and ACK chains remain valid, but the immutable pre-delete target must still reject
    // the splice.
    const replacementSessionId = "sess_0199aabb-ccdd-7001-8000-000000000025";
    const replacementGraveBody = {
      ...bundle.graveMarkers[0]!,
      sessionId: replacementSessionId,
      ownerSha256: tenantDatabasePurgeSessionGraveOwnerSha256({
        tenantId: source.tenantId,
        userId: "user-a",
        sessionId: replacementSessionId,
      }),
    };
    const replacementGraves: TenantPurgeSessionGraveMarker[] = [{
      ...replacementGraveBody,
      markerSha256: tenantDatabasePurgeSessionGraveMarkerSha256(replacementGraveBody),
    }];
    const replacementAckState = buildAcks(bundle.preDeleteEntries, replacementGraves);
    const { receiptSha256: _receiptSha256, ...originalReceiptBody } = bundle.receipt;
    const replacementReceiptBody = {
      ...originalReceiptBody,
      domainAckRootSha256: tenantDatabasePurgeDomainAckRootSha256(
        replacementAckState.acks,
      ),
      graveMarkerRootSha256: tenantDatabasePurgeSessionGraveMarkerRootSha256(
        replacementGraves,
      ),
      billingReconciliationEvidenceCount: replacementAckState.billingEvidenceCount,
      billingReconciliationEvidenceRootSha256:
        replacementAckState.billingEvidenceRootSha256,
    };
    const replacementReceipt: TenantDatabasePurgeReceipt = {
      ...replacementReceiptBody,
      receiptSha256: tenantDatabasePurgeReceiptSha256(replacementReceiptBody),
    };
    expect(() => validateTenantDatabasePurgeEvidenceBundle({
      ...bundle,
      domainAcks: replacementAckState.acks,
      graveMarkers: replacementGraves,
      receipt: replacementReceipt,
    })).toThrow(/session target does not match/);
  });

  it("enforces ACK action results, operation binding, authorization, and strict fields", () => {
    const bundle = buildBundle();
    const sessionAck = bundle.domainAcks.find((ack) => ack.domain === "session_content")!;
    const billingAck = bundle.domainAcks.find(
      (ack) => ack.domain === "billing_reconciliation",
    )!;
    expect(sessionAck.action).toBe("delete_with_grave_markers");
    expect(() => validateTenantDatabasePurgeDomainAck(sessionAck)).not.toThrow();
    expect(() => validateTenantDatabasePurgeDomainAck({
      ...billingAck,
      retainedEvidenceCount: 0,
      retainedEvidenceRootSha256: tenantDatabasePurgeRetainedEvidenceRootSha256(
        "billing_reconciliation",
        [],
      ),
    })).toThrow(/anonymized ACK result/);
    expect(() => validateTenantDatabasePurgeDomainAck({
      ...sessionAck,
      affectedCount: sessionAck.affectedCount + 1,
    })).toThrow(/affected count/);
    expect(() => validateTenantDatabasePurgeDomainAck({
      ...sessionAck,
      adapterProtocol: "other-v1" as never,
    })).toThrow(/adapter protocol/);
    expect(() => validateTenantDatabasePurgeReceipt({
      ...bundle.receipt,
      allDomainsComplete: true as never,
    })).toThrow(/flags/);
    expect(tenantDatabasePurgeReceiptMatchesAuthorization(bundle.receipt, authorization)).toBe(true);
    expect(tenantDatabasePurgeReceiptMatchesAuthorization(bundle.receipt, {
      ...authorization,
      claimToken: "claim:t3f:other",
    })).toBe(false);
    expect(() => validateTenantDatabasePurgePreDeleteReceipt({
      ...bundle.preDeleteReceipt,
      unknown: true,
    } as never)).toThrow(/unknown or missing fields/);
  });

  it("validates queued claim leases without granting stale authorization", () => {
    const job: TenantDatabasePurgeJobRecord = {
      ...source,
      phase: "queued",
      domainCount: TENANT_DATABASE_PURGE_DOMAINS.length,
      preDeleteEntryCount: 0,
      preDeleteEntryRootSha256: EMPTY_TENANT_DATABASE_PURGE_PREDELETE_ENTRY_ROOT_SHA256,
      domainAckCount: 0,
      domainAckRootSha256: EMPTY_TENANT_DATABASE_PURGE_DOMAIN_ACK_ROOT_SHA256,
      unresolvedBlockerCount: 9,
      availableAtMs: 20,
      attempts: 1,
      claimToken: CLAIM_TOKEN,
      leaseUntilMs: 50,
      createdAtMs: 20,
      updatedAtMs: 21,
    };
    expect(() => validateTenantDatabasePurgeJobRecord(job)).not.toThrow();
    const claim = tenantDatabasePurgeClaimFromJob(job);
    expect(() => validateTenantDatabasePurgeClaim(claim)).not.toThrow();
    expect(tenantDatabasePurgeAuthorizationMatches(job, authorization, 49)).toBe(true);
    expect(tenantDatabasePurgeAuthorizationMatches(job, authorization, 50)).toBe(false);
    expect(() => validateTenantDatabasePurgeJobRecord({
      ...job,
      preDeleteEntryCount: 1,
    })).toThrow(/published destructive evidence/);
  });

  it("binds grave ownership and the one-way cutover without a terminal-receipt hash cycle", () => {
    const bundle = buildBundle();
    expect(() => validateTenantDatabasePurgeSessionGraveMarker(bundle.graveMarkers[0]!))
      .not.toThrow();
    expect(() => validateTenantDatabasePurgeSessionGraveMarker({
      ...bundle.graveMarkers[0]!,
      ownerSha256: DIGEST_D,
    })).toThrow(/does not match/);

    const cutoverBody = {
      singletonId: TENANT_DATABASE_PURGE_CUTOVER_SINGLETON_ID,
      controlGeneration: 1 as const,
      activatedAtDbMs: 30,
      firstRequestId: source.requestId,
      firstReceiptSha256: bundle.receipt.receiptSha256,
    };
    const cutover = {
      ...cutoverBody,
      evidenceSha256: tenantDatabasePurgeCutoverEvidenceSha256(cutoverBody),
    };
    expect(() => validateTenantDatabasePurgeCutoverRecord(cutover)).not.toThrow();
    expect(() => validateTenantDatabasePurgeCutoverRecord({
      ...cutover,
      firstReceiptSha256: DIGEST_A,
    })).toThrow(/evidence does not match/);
  });
});
