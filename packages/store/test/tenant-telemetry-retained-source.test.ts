import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { emptyUsage, type Item, type PersistedEvent } from "@agent-service/protocol";
import * as codec from "../src/tenant-telemetry-retained-source.js";
import {
  persistedProviderCaptureEventRoot,
  persistedProviderCaptureReceiptSha256,
  persistedProviderCaptureSha256,
  type PersistedProviderStepFailureCommitReceipt,
} from "../src/tenant-telemetry-persisted-provider-capture.js";
import { billingUsageFactFromLedger } from "../src/usage-lifecycle.js";
import { tenantTelemetryDispositionInventoryTargetRootSha256 } from "../src/tenant-telemetry-disposition.js";
import {
  tenantTelemetryTargetManifestArtifactGroupSha256,
  tenantTelemetryTargetManifestEntrySha256,
  tenantTelemetryTargetManifestReceiptSha256,
  validateTenantTelemetryTargetManifestProof,
  type TenantTelemetryTargetManifestEntry,
  type TenantTelemetryTargetManifestEntryBody,
  type TenantTelemetryTargetManifestReceiptBody,
} from "../src/tenant-telemetry-target-manifest.js";
import {
  tenantTelemetryPlanArtifactTargetSha256,
  validateTenantTelemetryPlanArtifactTarget,
  type TenantTelemetryPlanArtifactTargetBody,
} from "../src/tenant-telemetry-plan-artifact-target.js";
import {
  TENANT_TELEMETRY_SOURCE_KINDS,
  tenantTelemetrySourceAccountingEntrySha256,
  tenantTelemetrySourceAccountingEntryRootSha256,
  tenantTelemetrySourceAccountingUnknownRootSha256,
  tenantTelemetrySourceAccountingReceiptSha256,
  validateTenantTelemetrySourceAccountingEntry,
  validateTenantTelemetrySourceAccountingProof,
  type TenantTelemetrySourceAccountingEntryBody,
  type TenantTelemetrySourceAccountingReceiptBody,
} from "../src/tenant-telemetry-source-accounting.js";
import {
  TENANT_PURGE_PLAN_DOMAINS,
  tenantPurgePlanReceiptSha256,
  type TenantPurgePlanJobRecord,
  type TenantPurgePlanReceipt,
} from "../src/tenant-purge-plan.js";
import {
  tenantTelemetryCanonicalOwnerProofSha256,
  tenantTelemetryOwnerClosureEntrySha256,
  type TenantTelemetryOwnerClosureEntry,
  type TenantTelemetryOwnerClosureEntryBody,
} from "../src/tenant-telemetry-owner-closure.js";
import {
  tenantDatabasePurgeSessionGraveMarkerSha256,
  tenantDatabasePurgeSessionGraveMarkerRootSha256,
  tenantDatabasePurgeSessionGraveOwnerSha256,
  type TenantPurgeSessionGraveMarker,
} from "../src/tenant-database-purge.js";

// Pure proof fixtures: digests here are not DB provenance or external deletion permission.
const sha = (label: string) => codec.tenantTelemetryRetainedSourceSha256("retained-source-test-v1", label);
const tenantId = "retained-source-test";
const requestId = "erase_00000000-0000-4000-8000-000000000001";
const sessionId = "sess_00000000-0000-7000-8000-000000000001";
const turnId = "turn_00000000-0000-7000-8000-000000000001";
const itemId = "item_00000000-0000-7000-8000-000000000001";
const usageId = "usg_00000000-0000-4000-8000-000000000001";
const safety = { executionReady: false, externalAuthorityVerified: false,
  allDomainsComplete: false, contentPurgeExecuted: false } as const;
const oldIdentity = { requestId, tenantId, subjectGeneration: 1, planBuildGeneration: 1,
  executionGeneration: 1, databasePurgeGeneration: 1 };

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function reseal<T extends { scope: string; receiptSha256: string }>(value: T, change: Partial<T>): T {
  const result = { ...clone(value), ...change };
  result.receiptSha256 = codec.tenantTelemetryRetainedSourceReceiptSha256(result);
  return result;
}
function primary() {
  return codec.buildTenantTelemetryRetainedSourcePrimaryBinding({
    scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_PRIMARY_SCOPE,
    captureControlEvidenceSha256: sha("capture"), lifecycleControlEvidenceSha256: sha("lifecycle"),
    refKeyIdSha256: sha("ref-key"), logsTargetSha256: sha("logs-target"),
    logsTargetReceiptSha256: sha("logs-target-receipt"), runtimeEpochSha256: sha("epoch"),
    runtimeBindingSha256: sha("runtime-binding"), runtimeControlEvidenceSha256: sha("runtime-control"),
    runtimeControlGeneration: 1, lifecycleCoverageEvidenceSha256: sha("lifecycle-coverage"),
    captureCoverageEvidenceSha256: sha("capture-coverage"), lifecycleHistoryStatus: "complete_since_creation",
    captureStatus: "capture_since_tenant_creation", lifecycleActivatedAtDbMs: 1_000,
    captureActivatedAtDbMs: 1_100, lifecycleCoverageStartedAtDbMs: 1_200,
    captureCoverageStartedAtDbMs: 1_200, tenantCreatedAtDbMs: 1_200,
  });
}
function identityAndProfile() {
  const base = { requestId, tenantId, subjectGeneration: 1, t1FenceSha256: sha("actual-t1-fence") };
  const profile: codec.TenantTelemetryRetainedSourceT1Profile = { kind: "eligible-primary",
    primaryBinding: primary(), legacyFailedItemCount: 0,
    legacyFailedItemRootSha256: codec.tenantTelemetryRetainedSourceEmptyLegacyRootSha256(base) };
  return { profile, identity: { ...base, t1ProfileSha256: codec.tenantTelemetryRetainedSourceT1ProfileSha256(profile) } };
}
function sealT1(identity: codec.TenantTelemetryRetainedSourceIdentity,
  profile: codec.TenantTelemetryRetainedSourceT1Profile,
  entries: readonly codec.TenantTelemetryRetainedSourceT1CohortEntry[]) {
  const count = (state: codec.TenantTelemetryRetainedSourceCohortState) => entries.filter((entry) => entry.state === state).length;
  const root = (state?: codec.TenantTelemetryRetainedSourceCohortState) => codec.tenantTelemetryRetainedSourceT1CohortRootSha256(entries, state);
  return codec.buildTenantTelemetryRetainedSourceT1CohortReceipt({
    ...identity, ...safety, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_T1_RECEIPT_SCOPE,
    profile, tenantLifecycleSubjectEvidenceSha256: sha("actual-active-t1-subject"),
    entryCount: entries.length, entryRootSha256: root(), writtenAckCount: count("written_ack"),
    writtenAckRootSha256: root("written_ack"), pendingCount: count("pending"), pendingRootSha256: root("pending"),
    reservedCount: count("reserved"), reservedRootSha256: root("reserved"), blockedCount: count("blocked"),
    blockedRootSha256: root("blocked"), unknownCount: count("unknown"), unknownRootSha256: root("unknown"),
    eligibility: profile.kind === "eligible-primary" && count("written_ack") === entries.length ? "eligible_retained" : "blocked_source",
    t1AcceptedAtDbMs: 1_400, sourceHighWaterDbMs: Math.max(profile.kind === "eligible-primary" ? 1_200 : profile.observedHighWaterDbMs,
      ...entries.map((entry) => entry.sourceHighWaterDbMs)), storeDbTimestampMs: 1_400,
  }, entries);
}
const oldHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oldSourceOrder = (a: { sourceKind: string; sourceIdentitySha256: string },
  b: { sourceKind: string; sourceIdentitySha256: string }) =>
  (TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).indexOf(a.sourceKind)
  - (TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).indexOf(b.sourceKind)
  || a.sourceIdentitySha256.localeCompare(b.sourceIdentitySha256);

/** Closed old receipt objects with their real codecs; pure checksums are not DB provenance. */
function legacyAnchorsFixture(identity: codec.TenantTelemetryRetainedSourceIdentity,
  observed: readonly codec.TenantTelemetryRetainedSourceObservedRow[],
  targets: readonly codec.TenantTelemetryRetainedSourceCatalogEntry[]): codec.TenantTelemetryRetainedSourceLegacyCatalogAnchors {
  const source = { requestId: identity.requestId, tenantId: identity.tenantId, subjectGeneration: identity.subjectGeneration,
    buildGeneration: 1, t1FenceSha256: identity.t1FenceSha256, t3aReceiptSha256: sha("t3a"), t3bReceiptSha256: sha("t3b"),
    t3cReceiptSha256: sha("t3c"), policyVersion: "fixture-policy", policySha256: sha("policy"), policySchemaVersion: 1 as const,
    retentionAnchorDbMs: 1_400, purgeNotBeforeDbMs: 1_400, sourceEvidenceDbMs: 1_400 };
  const planBody: Omit<TenantPurgePlanReceipt, "receiptSha256"> = { ...source, scope: "tenant-purge-plan-v1",
    planEntryCount: TENANT_PURGE_PLAN_DOMAINS.length, planEntryRootSha256: sha("plan-entry-root"),
    blockerCount: 2, blockerRootSha256: sha("logs-and-traces-blockers"), storeDbTimestampMs: 1_500,
    completedClaimAttempt: 1, completedClaimTokenSha256: sha("catalog-claim"), planComplete: true,
    executionReady: false, contentPurgeExecuted: false };
  const planReceipt = { ...planBody, receiptSha256: tenantPurgePlanReceiptSha256(planBody) };
  const job: TenantPurgePlanJobRecord = { ...source, phase: "plan_sealed", scanComplete: true,
    cursorDomain: TENANT_PURGE_PLAN_DOMAINS[TENANT_PURGE_PLAN_DOMAINS.length - 1]!,
    planEntryCount: planBody.planEntryCount, planEntryRootSha256: planBody.planEntryRootSha256,
    blockerCount: planBody.blockerCount, blockerRootSha256: planBody.blockerRootSha256,
    attempts: 1, createdAtMs: 1_400, updatedAtMs: 1_500, planSealedAtDbMs: 1_500,
    completedClaimAttempt: 1, completedClaimTokenSha256: planBody.completedClaimTokenSha256,
    aggregateReceiptSha256: planReceipt.receiptSha256 };
  const byOperation = new Map(targets.map((target) => [target.writeOperationSha256, target]));
  const sourceEntries = observed.filter((row) =>
    (TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).includes(row.sourceKind)).map((row) => {
    const target = row.writeOperationSha256 === null ? undefined : byOperation.get(row.writeOperationSha256);
    const accounted = target?.source.kind === "application-v1";
    const body: TenantTelemetrySourceAccountingEntryBody = { scope: "tenant-telemetry-source-accounting-entry-v1",
      requestId: identity.requestId, tenantId: identity.tenantId, subjectGeneration: identity.subjectGeneration,
      buildGeneration: 1, sourceKind: row.sourceKind as TenantTelemetrySourceAccountingEntryBody["sourceKind"],
      sourceIdentitySha256: row.sourceIdentitySha256, writeOperationSha256: row.writeOperationSha256,
      domain: row.domain, sourceEvidenceSha256: row.sourceEvidenceSha256,
      classification: accounted ? "accounted" : "unknown", reason: accounted ? "complete" : target ? "unbound_application" : "orphan_source",
      capturedAtDbMs: 1_500 };
    return { ...body, receiptSha256: tenantTelemetrySourceAccountingEntrySha256(body) };
  }).sort(oldSourceOrder);
  const count = (kind: TenantTelemetrySourceAccountingEntryBody["sourceKind"]) => sourceEntries.filter((entry) => entry.sourceKind === kind).length;
  const sourceBody: TenantTelemetrySourceAccountingReceiptBody = { scope: "tenant-telemetry-source-accounting-receipt-v1",
    requestId: identity.requestId, tenantId: identity.tenantId, subjectGeneration: identity.subjectGeneration,
    buildGeneration: 1, t1FenceSha256: identity.t1FenceSha256, t3cReceiptSha256: planReceipt.t3cReceiptSha256,
    planReceiptSha256: planReceipt.receiptSha256, inventoryCount: count("inventory"), writeJobCount: count("write_job"),
    writeAckCount: count("write_ack"), membershipCount: count("membership"), applicationBindingCount: count("application_binding"),
    entryCount: sourceEntries.length, entryRootSha256: tenantTelemetrySourceAccountingEntryRootSha256(sourceEntries),
    unknownCount: sourceEntries.filter((entry) => entry.classification === "unknown").length,
    unknownRootSha256: tenantTelemetrySourceAccountingUnknownRootSha256(sourceEntries), storeDbTimestampMs: 1_500,
    completedClaimAttempt: 1, completedClaimTokenSha256: planBody.completedClaimTokenSha256 };
  const sourceReceipt = { ...sourceBody, receiptSha256: tenantTelemetrySourceAccountingReceiptSha256(sourceBody) };
  const grouped = new Map<string, typeof sourceEntries>();
  for (const entry of sourceEntries) {
    const target = entry.writeOperationSha256 === null ? undefined : byOperation.get(entry.writeOperationSha256);
    const groupId = target?.artifactGroupSha256 ?? (entry.sourceKind === "inventory"
      ? tenantTelemetryTargetManifestArtifactGroupSha256(identity.tenantId, entry.domain, entry.sourceIdentitySha256)
      : oldHash(["tenant-telemetry-target-manifest-orphan-v1", identity.tenantId, entry.domain, entry.writeOperationSha256, null]));
    const group = grouped.get(groupId) ?? []; group.push(entry); grouped.set(groupId, group);
  }
  const manifestEntries: TenantTelemetryTargetManifestEntry[] = [];
  for (const [groupId, entries] of grouped) {
    const first = entries[0]!;
    const target = first.writeOperationSha256 === null ? undefined : byOperation.get(first.writeOperationSha256);
    const inventory = entries.find((entry) => entry.sourceKind === "inventory");
    const accounted = target?.source.kind === "application-v1";
    const groupSourceRootSha256 = oldHash(["tenant-telemetry-target-manifest-group-source-root-v1",
      ...[...entries].sort(oldSourceOrder).map((entry) => [entry.sourceKind, entry.sourceIdentitySha256, entry.receiptSha256])]);
    for (const entry of entries) {
      const body: TenantTelemetryTargetManifestEntryBody = { scope: "tenant-telemetry-target-manifest-entry-v1",
        requestId: identity.requestId, tenantId: identity.tenantId, subjectGeneration: identity.subjectGeneration,
        buildGeneration: 1, sourceKind: entry.sourceKind, sourceIdentitySha256: entry.sourceIdentitySha256,
        sourceReceiptSha256: entry.receiptSha256, domain: entry.domain, artifactGroupSha256: groupId,
        inventorySha256: inventory?.sourceIdentitySha256 ?? null, writeOperationSha256: first.writeOperationSha256,
        artifactIdSha256: inventory ? target?.artifactIdSha256 ?? sha("orphan-artifact-metadata") : null,
        artifactGeneration: inventory ? target?.artifactGeneration ?? 1 : null,
        observedTargetSha256: accounted ? target!.targetSha256 : null,
        ownerKind: accounted ? target!.ownerKind : null, ownerRefSha256: accounted ? target!.ownerRefSha256 : null,
        holdSubjectRefSha256: accounted ? target!.holdSubjectRefSha256 : null,
        ownerBindingSha256: accounted ? target!.ownerBindingSha256 : null,
        liveOwnerClaimSha256: accounted ? target!.liveOwnerClaimSha256 : null,
        classification: accounted ? "accounted" : "unknown", groupSourceCount: entries.length, groupSourceRootSha256,
        groupObservedTargetCount: accounted ? 1 : 0,
        groupObservedTargetRootSha256: oldHash(["tenant-telemetry-target-manifest-group-target-root-v1", ...(accounted ? [target!.targetSha256] : [])]),
        capturedAtDbMs: 1_500 };
      manifestEntries.push({ ...body, receiptSha256: tenantTelemetryTargetManifestEntrySha256(body) });
    }
  }
  manifestEntries.sort(oldSourceOrder);
  const manifestGroups = [...new Map(manifestEntries.map((entry) => [entry.artifactGroupSha256, entry])).values()]
    .sort((a, b) => a.artifactGroupSha256.localeCompare(b.artifactGroupSha256));
  const groupFields = (entry: TenantTelemetryTargetManifestEntry) => [entry.artifactGroupSha256, entry.inventorySha256,
    entry.writeOperationSha256, entry.artifactIdSha256, entry.artifactGeneration, entry.observedTargetSha256, entry.ownerKind,
    entry.ownerRefSha256, entry.holdSubjectRefSha256, entry.ownerBindingSha256, entry.liveOwnerClaimSha256, entry.classification,
    entry.groupSourceCount, entry.groupSourceRootSha256, entry.groupObservedTargetCount, entry.groupObservedTargetRootSha256];
  const manifestBody: TenantTelemetryTargetManifestReceiptBody = { scope: "tenant-telemetry-target-manifest-receipt-v1",
    requestId: identity.requestId, tenantId: identity.tenantId, subjectGeneration: identity.subjectGeneration, buildGeneration: 1,
    planReceiptSha256: planReceipt.receiptSha256, sourceAccountingReceiptSha256: sourceReceipt.receiptSha256,
    entryCount: manifestEntries.length, entryRootSha256: oldHash(["tenant-telemetry-target-manifest-entry-root-v1", ...manifestEntries.map((entry) => entry.receiptSha256)]),
    artifactGroupCount: manifestGroups.length,
    artifactGroupRootSha256: oldHash(["tenant-telemetry-target-manifest-artifact-root-v1", ...manifestGroups.map(groupFields)]),
    observedTargetCount: manifestGroups.filter((entry) => entry.observedTargetSha256 !== null).length,
    observedTargetRootSha256: oldHash(["tenant-telemetry-target-manifest-observed-root-v1",
      ...manifestGroups.filter((entry) => entry.observedTargetSha256 !== null).map((entry) => [entry.artifactGroupSha256, entry.observedTargetSha256])]),
    unknownGroupCount: manifestGroups.filter((entry) => entry.classification === "unknown").length,
    unknownGroupRootSha256: oldHash(["tenant-telemetry-target-manifest-unknown-root-v1",
      ...manifestGroups.filter((entry) => entry.classification === "unknown").map((entry) => entry.artifactGroupSha256)]),
    storeDbTimestampMs: 1_500, completedClaimAttempt: 1, completedClaimTokenSha256: planBody.completedClaimTokenSha256 };
  const manifestReceipt = { ...manifestBody, receiptSha256: tenantTelemetryTargetManifestReceiptSha256(manifestBody) };
  validateTenantTelemetrySourceAccountingProof(job, planReceipt, sourceEntries, sourceReceipt);
  validateTenantTelemetryTargetManifestProof({ job, planReceipt, sourceEntries, sourceReceipt, entries: manifestEntries, receipt: manifestReceipt });
  return { job, planReceipt, sourceEntries, sourceReceipt, manifestEntries, manifestReceipt };
}
function sealCatalog(identity: codec.TenantTelemetryRetainedSourceIdentity,
  targets: readonly codec.TenantTelemetryRetainedSourceCatalogEntry[],
  sources: readonly codec.TenantTelemetryRetainedSourceCatalogSourceEntry[],
  proof: codec.TenantTelemetryRetainedSourceCatalogProof) {
  const count = (kind: codec.TenantTelemetryRetainedSourceRawKind) => sources.filter((source) => source.sourceKind === kind).length;
  const root = (kind?: codec.TenantTelemetryRetainedSourceRawKind | "unknown") => codec.tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources, kind);
  const targetRoot = (subset?: "application-v1" | "persisted-provider-v2") => codec.tenantTelemetryRetainedSourceCatalogRootSha256(targets, subset);
  const unknownGroups = codec.tenantTelemetryRetainedSourceCatalogUnknownGroups(sources);
  return codec.buildTenantTelemetryRetainedSourceCatalogReceipt({
    ...identity, ...safety, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_RECEIPT_SCOPE,
    planBuildGeneration: 1, cohortReceiptSha256: proof.cohortReceipt.receiptSha256,
    t3cReceiptSha256: proof.legacyAnchors.planReceipt.t3cReceiptSha256, planReceiptSha256: proof.legacyAnchors.planReceipt.receiptSha256,
    legacySourceAccountingReceiptSha256: proof.legacyAnchors.sourceReceipt.receiptSha256,
    legacyTargetManifestReceiptSha256: proof.legacyAnchors.manifestReceipt.receiptSha256,
    proofFamily: codec.TENANT_TELEMETRY_RETAINED_SOURCE_PROTOCOL,
    sourceCount: sources.length, sourceRootSha256: root(), inventoryCount: count("inventory"),
    inventoryRootSha256: root("inventory"), writeJobCount: count("write_job"), writeJobRootSha256: root("write_job"),
    writeAckCount: count("write_ack"), writeAckRootSha256: root("write_ack"), membershipCount: count("membership"),
    membershipRootSha256: root("membership"), applicationBindingCount: count("application_binding"),
    applicationBindingRootSha256: root("application_binding"), providerSourceBindingCount: count("provider_source_binding"),
    providerSourceBindingRootSha256: root("provider_source_binding"), providerFailureCommitCount: count("provider_failure_commit"),
    providerFailureCommitRootSha256: root("provider_failure_commit"),
    unknownSourceCount: sources.filter((source) => source.classification === "unknown").length,
    unknownSourceRootSha256: root("unknown"), entryCount: targets.length, entryRootSha256: targetRoot(),
    applicationV1Count: targets.filter((target) => target.source.kind === "application-v1").length,
    applicationV1RootSha256: targetRoot("application-v1"),
    persistedProviderV2Count: targets.filter((target) => target.source.kind === "persisted-provider-v2").length,
    persistedProviderV2RootSha256: targetRoot("persisted-provider-v2"),
    logsTargetCount: targets.filter((target) => target.domain === "logs").length,
    logsTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256("logs", codec.tenantTelemetryRetainedSourceCatalogPlanTargets(targets, "logs")),
    tracesTargetCount: targets.filter((target) => target.domain === "traces").length,
    tracesTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256("traces", codec.tenantTelemetryRetainedSourceCatalogPlanTargets(targets, "traces")),
    unknownGroupCount: unknownGroups.length, unknownGroupRootSha256: codec.tenantTelemetryRetainedSourceUnknownGroupRootSha256(unknownGroups),
    sourceHighWaterDbMs: Math.max(proof.cohortReceipt.storeDbTimestampMs,
      ...targets.map((target) => target.sourceHighWaterDbMs), ...sources.map((source) => source.sourceHighWaterDbMs)),
    storeDbTimestampMs: 1_500, completedClaimAttempt: 1, completedClaimTokenSha256: sha("catalog-claim"),
  }, targets, sources, proof);
}

function fixture(includeOperation = true) {
  const { profile, identity } = identityAndProfile();
  const binding = profile.primaryBinding;
  const item: Extract<Item, { type: "agentMessage" }> = { id: itemId, sessionId, turnId, seq: 3, step: 1,
    type: "agentMessage", status: "failed", createdAtMs: 1_200, completedAtMs: 1_250,
    phase: "finalAnswer", text: "content retained only as its digest" };
  const events: PersistedEvent[] = [
    { type: "item/completed", sessionId, seq: 4, emittedAtMs: 1_250, item },
    { type: "usage/updated", sessionId, seq: 5, emittedAtMs: 1_250, turnId, step: 1,
      stepUsage: emptyUsage(), turnUsage: emptyUsage(), sessionUsage: emptyUsage(), runtime: { provider: "test", model: "test" } },
  ];
  const fact = billingUsageFactFromLedger({ usageId, tenantId, userId: "user", sessionId, turnId, step: 1,
    provider: "test", model: "test", usage: emptyUsage(), createdAtMs: 1_250 });
  const failureBody: Omit<PersistedProviderStepFailureCommitReceipt, "receiptSha256"> = {
    scope: "tenant-telemetry-provider-step-failure-commit-receipt-v2", tenantId,
    sourceSessionRefSha256: sha("source-session"), sourceTurnRefSha256: sha("source-turn"),
    sourceItemRefSha256: sha("source-item"), sourceStepIndex: 1, sourceEventSeq: 4,
    fenceToken: 1, beginLastSeq: 3, endLastSeq: 5, eventCount: 2,
    eventRootSha256: persistedProviderCaptureEventRoot(events), businessBatchSha256: sha("business-batch"),
    billingRootSha256: persistedProviderCaptureSha256("tenant-telemetry-step-billing-v2", fact),
    usageIdSha256: persistedProviderCaptureSha256("tenant-telemetry-step-usage-id-v2", usageId),
    captureControlEvidenceSha256: binding.captureControlEvidenceSha256, runtimeEpochSha256: binding.runtimeEpochSha256,
    runtimeBindingSha256: binding.runtimeBindingSha256, writeOperationSha256: sha("operation"),
    bindingReceiptSha256: sha("source-binding"), membershipSha256: sha("membership"),
    payloadSha256: sha("payload"), committedAtDbMs: 1_250,
  };
  const failure = { ...failureBody, receiptSha256: persistedProviderCaptureReceiptSha256(failureBody) };
  const t1Entry = codec.buildTenantTelemetryRetainedSourceT1CohortEntry({
    ...identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE,
    sourceIdentitySha256: codec.tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId, failure.writeOperationSha256),
    state: "written_ack", writeOperationSha256: failure.writeOperationSha256,
    failureCommitReceiptSha256: failure.receiptSha256, sourceBindingReceiptSha256: failure.bindingReceiptSha256,
    membershipSha256: failure.membershipSha256, writeJobEvidenceSha256: sha("job-evidence"), reservationSha256: sha("reservation"),
    writeAckReceiptSha256: sha("write-ack"), inventorySha256: sha("inventory"), inventoryReceiptSha256: sha("inventory-receipt"),
    payloadSha256: failure.payloadSha256, sourceHighWaterDbMs: 1_300, capturedAtDbMs: 1_400,
  });
  const t1Entries = includeOperation ? [t1Entry] : [];
  const t1 = sealT1(identity, profile, t1Entries);
  const target = codec.buildTenantTelemetryRetainedSourceCatalogEntry({
    ...identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE,
    planBuildGeneration: 1, cohortReceiptSha256: t1.receiptSha256, domain: "logs",
    source: { kind: "persisted-provider-v2", failureCommitReceiptSha256: failure.receiptSha256,
      sourceBindingReceiptSha256: failure.bindingReceiptSha256, captureCoverageEvidenceSha256: binding.captureCoverageEvidenceSha256,
      cohortEntryReceiptSha256: t1Entry.receiptSha256 },
    artifactGroupSha256: tenantTelemetryTargetManifestArtifactGroupSha256(tenantId, "logs", t1Entry.inventorySha256!),
    targetSha256: binding.logsTargetSha256,
    targetReceiptSha256: binding.logsTargetReceiptSha256, artifactIdSha256: sha("artifact"), artifactGeneration: 1,
    inventorySha256: t1Entry.inventorySha256!, inventoryReceiptSha256: t1Entry.inventoryReceiptSha256!,
    writeOperationSha256: failure.writeOperationSha256, writeJobEvidenceSha256: t1Entry.writeJobEvidenceSha256!,
    reservationSha256: t1Entry.reservationSha256!, writeAckReceiptSha256: t1Entry.writeAckReceiptSha256!,
    membershipSha256: failure.membershipSha256, payloadSha256: failure.payloadSha256, manifestSha256: sha("manifest"),
    lifecycleCoverageEvidenceSha256: binding.lifecycleCoverageEvidenceSha256, ownerKind: "session",
    ownerRefSha256: sha("owner-ref"), holdSubjectRefSha256: sha("hold-subject"), ownerBindingSha256: sha("owner-binding"),
    liveOwnerClaimSha256: sha("live-owner-claim"), sourceHighWaterDbMs: 1_450, capturedAtDbMs: 1_500,
  });
  const targets = includeOperation ? [target] : [];
  const sourceKinds = ["inventory", "write_job", "write_ack", "membership", "provider_source_binding", "provider_failure_commit"] as const;
  const evidence = { inventory: target.inventoryReceiptSha256, write_job: target.writeJobEvidenceSha256,
    write_ack: target.writeAckReceiptSha256, membership: target.membershipSha256,
    provider_source_binding: failure.bindingReceiptSha256, provider_failure_commit: failure.receiptSha256 };
  const observed: codec.TenantTelemetryRetainedSourceObservedRow[] = includeOperation ? sourceKinds.map((sourceKind) => ({
    sourceKind, sourceIdentitySha256: sourceKind === "inventory" ? target.inventorySha256 : failure.writeOperationSha256,
    sourceEvidenceSha256: evidence[sourceKind], domain: "logs", writeOperationSha256: failure.writeOperationSha256, sourceHighWaterDbMs: 1_450,
  })) : [];
  const sources = observed.map((row) => codec.buildTenantTelemetryRetainedSourceCatalogSourceEntry({
    ...identity, ...row, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE,
    planBuildGeneration: 1, cohortReceiptSha256: t1.receiptSha256, artifactGroupSha256: target.artifactGroupSha256,
    catalogTargetEntryReceiptSha256: target.receiptSha256, classification: "accounted", capturedAtDbMs: 1_500,
  }));
  const catalogProof: codec.TenantTelemetryRetainedSourceCatalogProof = { cohortReceipt: t1, cohortEntries: t1Entries,
    expectedProfile: profile, failureReceipts: includeOperation ? [failure] : [], applicationV1Targets: [], observedSourceRows: observed,
    legacyAnchors: legacyAnchorsFixture(identity, observed, targets) };
  const catalog = sealCatalog(identity, targets, sources, catalogProof);
  const usageAnchors: codec.TenantTelemetryRetainedSourceUsageAnchors = { planBuildGeneration: 1, executionGeneration: 1,
    planReceiptSha256: catalog.planReceiptSha256, operationalUsagePlanRootSha256: sha("usage-plan-root"),
    operationalUsageAckReceiptSha256: sha("actual-usage-ack"), localCutoverReceiptSha256: sha("actual-local-cutover"),
    completedClaimAttempt: 1, completedClaimTokenSha256: sha("usage-claim"), storeDbTimestampMs: 1_600 };
  const usageEntry = codec.buildTenantTelemetryRetainedSourceUsageReleaseEntry({
    ...identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_ENTRY_SCOPE,
    planBuildGeneration: 1, executionGeneration: 1, cohortReceiptSha256: t1.receiptSha256,
    catalogEntryReceiptSha256: target.receiptSha256, catalogReceiptSha256: catalog.receiptSha256,
    writeOperationSha256: failure.writeOperationSha256, failureCommitReceiptSha256: failure.receiptSha256,
    usageIdSha256: failure.usageIdSha256, billingRootSha256: failure.billingRootSha256, retainedBillingFactSha256: fact.factSha256,
    planReceiptSha256: catalog.planReceiptSha256, operationalUsagePlanRootSha256: usageAnchors.operationalUsagePlanRootSha256,
    completedClaimAttempt: usageAnchors.completedClaimAttempt, completedClaimTokenSha256: usageAnchors.completedClaimTokenSha256,
    sourceHighWaterDbMs: 1_500, releasedAtDbMs: 1_600,
  });
  const usageEntries = includeOperation ? [usageEntry] : [];
  const usageProof: codec.TenantTelemetryRetainedSourceUsageProof = { catalogProof, catalogReceipt: catalog,
    catalogEntries: targets, catalogSources: sources, retainedBillingFacts: includeOperation ? [fact] : [], anchors: usageAnchors };
  const usage = codec.buildTenantTelemetryRetainedSourceUsageReleaseReceipt({
    ...identity, ...safety, ...usageAnchors, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_RECEIPT_SCOPE,
    cohortReceiptSha256: t1.receiptSha256, catalogReceiptSha256: catalog.receiptSha256,
    entryCount: usageEntries.length, entryRootSha256: codec.tenantTelemetryRetainedSourceUsageReleaseRootSha256(usageEntries),
    retainedBillingFactCount: usageEntries.length, retainedBillingFactRootSha256: codec.tenantTelemetryRetainedSourceRetainedBillingRootSha256(usageEntries),
    sourceHighWaterDbMs: 1_500,
  }, usageEntries, usageProof);
  const graveBody: Omit<TenantPurgeSessionGraveMarker, "markerSha256"> = { ...oldIdentity,
    scope: "tenant-purge-session-grave-marker-v1", sessionId, deletionGeneration: 1, deletedAtDbMs: 1_400,
    ownerSha256: tenantDatabasePurgeSessionGraveOwnerSha256({ tenantId, userId: "user", sessionId }),
    t3cSessionReceiptSha256: sha("session-t3c"), preDeleteReceiptSha256: sha("pre-delete"), markedAtDbMs: 1_700 };
  const grave = { ...graveBody, markerSha256: tenantDatabasePurgeSessionGraveMarkerSha256(graveBody) };
  const ownerBase = { ...oldIdentity, scope: "tenant-telemetry-owner-closure-entry-v1" as const,
    writeOperationSha256: failure.writeOperationSha256, membershipSha256: failure.membershipSha256,
    inventorySha256: target.inventorySha256, ownerKind: "session" as const, ownerRefSha256: target.ownerRefSha256,
    holdSubjectRefSha256: target.holdSubjectRefSha256, refKeyIdSha256: binding.refKeyIdSha256,
    ownerBindingSha256: target.ownerBindingSha256, sessionGraveMarkerSha256: grave.markerSha256,
    preDeleteReceiptSha256: grave.preDeleteReceiptSha256, capturedAtDbMs: 1_700 };
  const ownerBody: TenantTelemetryOwnerClosureEntryBody = { ...ownerBase,
    canonicalOwnerProofSha256: tenantTelemetryCanonicalOwnerProofSha256(ownerBase) };
  const owner: TenantTelemetryOwnerClosureEntry = { ...ownerBody, receiptSha256: tenantTelemetryOwnerClosureEntrySha256(ownerBody) };
  const canonicalEntry = codec.buildTenantTelemetryRetainedSourceCanonicalClosureEntry({
    ...identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_ENTRY_SCOPE,
    planBuildGeneration: 1, executionGeneration: 1, databasePurgeGeneration: 1,
    cohortReceiptSha256: t1.receiptSha256, catalogReceiptSha256: catalog.receiptSha256, catalogEntryReceiptSha256: target.receiptSha256,
    usageReleaseReceiptSha256: usage.receiptSha256, usageReleaseEntryReceiptSha256: usageEntry.receiptSha256,
    writeOperationSha256: failure.writeOperationSha256, failureCommitReceiptSha256: failure.receiptSha256,
    sourceBindingReceiptSha256: failure.bindingReceiptSha256, membershipSha256: failure.membershipSha256,
    sourceSessionRefSha256: failure.sourceSessionRefSha256, sourceTurnRefSha256: failure.sourceTurnRefSha256,
    sourceItemRefSha256: failure.sourceItemRefSha256, sourceStepIndex: failure.sourceStepIndex, sourceEventSeq: failure.sourceEventSeq,
    beginLastSeq: failure.beginLastSeq, endLastSeq: failure.endLastSeq, eventCount: failure.eventCount,
    eventRootSha256: failure.eventRootSha256, businessBatchSha256: failure.businessBatchSha256,
    canonicalItemSha256: codec.tenantTelemetryRetainedSourceCanonicalItemSha256(item),
    canonicalOwnerProofSha256: owner.canonicalOwnerProofSha256, ownerBindingSha256: owner.ownerBindingSha256,
    ownerClosureEntryReceiptSha256: owner.receiptSha256, sessionGraveMarkerSha256: grave.markerSha256,
    preDeleteReceiptSha256: grave.preDeleteReceiptSha256, completedClaimAttempt: 1, completedClaimTokenSha256: sha("canonical-claim"),
    sourceHighWaterDbMs: 1_600, capturedAtDbMs: 1_700,
  });
  const canonicalEntries = includeOperation ? [canonicalEntry] : [];
  const canonicalAnchors: codec.TenantTelemetryRetainedSourceCanonicalAnchors = {
    planBuildGeneration: 1, executionGeneration: 1, databasePurgeGeneration: 1,
    planReceiptSha256: catalog.planReceiptSha256, localPhysicalAckReceiptSha256: sha("actual-physical-ack"),
    preDeleteReceiptSha256: grave.preDeleteReceiptSha256, t3fReceiptSha256: sha("actual-t3f"),
    ownerClosureReceiptSha256: sha("actual-old-owner-aggregate"),
    graveMarkerRootSha256: tenantDatabasePurgeSessionGraveMarkerRootSha256(includeOperation ? [grave] : []),
    completedClaimAttempt: 1, completedClaimTokenSha256: sha("canonical-claim"), storeDbTimestampMs: 1_700 };
  // Anchors deliberately contain only existing-independent hashes, not the new receipt's root.
  const canonicalProof: codec.TenantTelemetryRetainedSourceCanonicalProof = { usageProof, usageReceipt: usage,
    usageEntries, ownerClosureEntries: includeOperation ? [owner] : [], graveMarkers: includeOperation ? [grave] : [], anchors: canonicalAnchors };
  const canonical = codec.buildTenantTelemetryRetainedSourceCanonicalClosureReceipt({
    ...identity, ...safety, ...canonicalAnchors, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_RECEIPT_SCOPE,
    cohortReceiptSha256: t1.receiptSha256, catalogReceiptSha256: catalog.receiptSha256, usageReleaseReceiptSha256: usage.receiptSha256,
    entryCount: canonicalEntries.length, entryRootSha256: codec.tenantTelemetryRetainedSourceCanonicalClosureRootSha256(canonicalEntries),
    sourceHighWaterDbMs: 1_600,
  }, canonicalEntries, canonicalProof);
  return { identity, profile, item, events, fact, failure, t1Entry, t1Entries, t1, target, targets, observed, sources,
    catalogProof, catalog, usageEntry, usageEntries, usageProof, usage, owner, grave,
    canonicalEntry, canonicalEntries, canonicalProof, canonical };
}

/**
 * Independent old-shape/checksum fixture, NOT DB provenance. No old 0042 receipt is
 * emitted or treated as deletion authority. Actual stores must separately audit
 * old 0040/0041 receipt anchors and canonical/0039 owner evidence.
 */
function mixedCatalogFixture() {
  const f = fixture();
  const operation = sha("v1-operation"), inventory = sha("v1-inventory");
  const evidence = { inventory: sha("v1-inventory-receipt"), write_job: sha("v1-job-evidence"),
    write_ack: sha("v1-write-ack"), membership: sha("v1-membership"), application_binding: sha("v1-application-binding") };
  const oldSources = TENANT_TELEMETRY_SOURCE_KINDS.map((sourceKind) => {
    const body: TenantTelemetrySourceAccountingEntryBody = {
      scope: "tenant-telemetry-source-accounting-entry-v1", requestId, tenantId, subjectGeneration: 1,
      buildGeneration: 1, sourceKind, sourceIdentitySha256: sourceKind === "inventory" ? inventory : operation,
      writeOperationSha256: operation, domain: "traces", sourceEvidenceSha256: evidence[sourceKind],
      classification: "accounted", reason: "complete", capturedAtDbMs: 1_500,
    };
    const entry = { ...body, receiptSha256: tenantTelemetrySourceAccountingEntrySha256(body) };
    validateTenantTelemetrySourceAccountingEntry(entry); return entry;
  });
  // Exact published 0041 group-root expression; the old codec/hash semantics are unchanged.
  const sourceGroupRootSha256 = createHash("sha256").update(JSON.stringify([
    "tenant-telemetry-target-manifest-group-source-root-v1",
    ...oldSources.map((source) => [source.sourceKind, source.sourceIdentitySha256, source.receiptSha256]),
  ])).digest("hex");
  const oldTargetBody: TenantTelemetryPlanArtifactTargetBody = {
    scope: "tenant-telemetry-plan-artifact-target-v1", requestId, tenantId, subjectGeneration: 1, buildGeneration: 1,
    domain: "traces", targetSha256: sha("v1-traces-target"), targetReceiptSha256: sha("v1-traces-target-receipt"),
    artifactIdSha256: sha("v1-artifact"), artifactGeneration: 1, inventorySha256: inventory,
    inventoryReceiptSha256: evidence.inventory, writeOperationSha256: operation, writeAckReceiptSha256: evidence.write_ack,
    membershipSha256: evidence.membership, applicationBindingReceiptSha256: evidence.application_binding,
    payloadSha256: sha("v1-payload"), manifestSha256: sha("v1-manifest"),
    lifecycleCoverageEvidenceSha256: f.profile.primaryBinding.lifecycleCoverageEvidenceSha256,
    applicationCoverageEvidenceSha256: sha("v1-application-coverage"), ownerKind: "tenant",
    ownerRefSha256: sha("v1-owner-ref"), holdSubjectRefSha256: sha("v1-hold-ref"),
    ownerBindingSha256: sha("v1-owner-binding"), liveOwnerClaimSha256: sha("v1-live-owner-claim"),
    artifactGroupSha256: tenantTelemetryTargetManifestArtifactGroupSha256(tenantId, "traces", inventory),
    sourceGroupRootSha256, capturedAtDbMs: 1_500,
  };
  const oldTarget = { ...oldTargetBody, receiptSha256: tenantTelemetryPlanArtifactTargetSha256(oldTargetBody) };
  validateTenantTelemetryPlanArtifactTarget(oldTarget);
  const v1Target = codec.buildTenantTelemetryRetainedSourceCatalogEntry({
    ...f.identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE, planBuildGeneration: 1,
    cohortReceiptSha256: f.t1.receiptSha256, domain: oldTarget.domain,
    source: { kind: "application-v1", applicationBindingReceiptSha256: oldTarget.applicationBindingReceiptSha256,
      applicationCoverageEvidenceSha256: oldTarget.applicationCoverageEvidenceSha256,
      sourceGroupRootSha256: oldTarget.sourceGroupRootSha256 },
    artifactGroupSha256: oldTarget.artifactGroupSha256, targetSha256: oldTarget.targetSha256,
    targetReceiptSha256: oldTarget.targetReceiptSha256, artifactIdSha256: oldTarget.artifactIdSha256,
    artifactGeneration: oldTarget.artifactGeneration, inventorySha256: oldTarget.inventorySha256,
    inventoryReceiptSha256: oldTarget.inventoryReceiptSha256, writeOperationSha256: oldTarget.writeOperationSha256,
    writeJobEvidenceSha256: evidence.write_job, reservationSha256: sha("v1-reservation"),
    writeAckReceiptSha256: oldTarget.writeAckReceiptSha256, membershipSha256: oldTarget.membershipSha256,
    payloadSha256: oldTarget.payloadSha256, manifestSha256: oldTarget.manifestSha256,
    lifecycleCoverageEvidenceSha256: oldTarget.lifecycleCoverageEvidenceSha256, ownerKind: oldTarget.ownerKind,
    ownerRefSha256: oldTarget.ownerRefSha256, holdSubjectRefSha256: oldTarget.holdSubjectRefSha256,
    ownerBindingSha256: oldTarget.ownerBindingSha256, liveOwnerClaimSha256: oldTarget.liveOwnerClaimSha256,
    sourceHighWaterDbMs: oldTarget.capturedAtDbMs, capturedAtDbMs: 1_500,
  });
  const v1Observed: codec.TenantTelemetryRetainedSourceObservedRow[] = oldSources.map((source) => ({
    sourceKind: source.sourceKind, sourceIdentitySha256: source.sourceIdentitySha256,
    sourceEvidenceSha256: source.sourceEvidenceSha256, domain: source.domain, writeOperationSha256: operation,
    sourceHighWaterDbMs: 1_500,
  }));
  const v1Sources = v1Observed.map((row) => codec.buildTenantTelemetryRetainedSourceCatalogSourceEntry({
    ...f.identity, ...row, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE,
    planBuildGeneration: 1, cohortReceiptSha256: f.t1.receiptSha256, artifactGroupSha256: v1Target.artifactGroupSha256,
    catalogTargetEntryReceiptSha256: v1Target.receiptSha256, classification: "accounted", capturedAtDbMs: 1_500,
  }));
  const targets = [...f.targets, v1Target], sources = [...f.sources, ...v1Sources];
  const proof = { ...f.catalogProof, applicationV1Targets: [oldTarget], observedSourceRows: [...f.observed, ...v1Observed],
    legacyAnchors: legacyAnchorsFixture(f.identity, [...f.observed, ...v1Observed], targets) };
  const catalog = sealCatalog(f.identity, targets, sources, proof);
  return { ...f, oldSources, oldTarget, v1Target, v1Sources, v1Observed, targets, sources, proof, catalog };
}

describe("versioned retained-source pure contract", () => {
  it.each([1_200, 1_251])("accepts a tenant profile timestamp %s at or after its immutable creation coverage", (tenantCreatedAtDbMs) => {
    const { evidenceSha256: _priorHash, ...body } = primary();
    const binding = codec.buildTenantTelemetryRetainedSourcePrimaryBinding({ ...body, tenantCreatedAtDbMs });
    expect(binding.tenantCreatedAtDbMs).toBe(tenantCreatedAtDbMs);
    expect(() => codec.validateTenantTelemetryRetainedSourcePrimaryBinding(binding)).not.toThrow();
  });

  it.each(["lifecycleCoverageStartedAtDbMs", "captureCoverageStartedAtDbMs"] as const)(
    "rejects %s after profile creation even with a freshly signed primary digest", (key) => {
      const { evidenceSha256: _priorHash, ...original } = primary();
      const body = { ...original, [key]: original.tenantCreatedAtDbMs + 1 };
      // Recompute the actual family checksum; this is a semantic time-order failure,
      // not a stale checksum failure or evidence of database provenance.
      const evidenceSha256 = codec.tenantTelemetryRetainedSourceSha256(body.scope, body);
      const replacement = { ...body, evidenceSha256 };
      expect(evidenceSha256).not.toBe(primary().evidenceSha256);
      expect(() => codec.validateTenantTelemetryRetainedSourcePrimaryBinding(replacement))
        .toThrow(codec.TenantTelemetryRetainedSourceIntegrityError);
      expect(() => codec.buildTenantTelemetryRetainedSourcePrimaryBinding(body))
        .toThrow(codec.TenantTelemetryRetainedSourceIntegrityError);
    },
  );

  it("accepts independently checksummed application-v1 traces alongside the original persisted-provider-v2 logs", () => {
    const f = mixedCatalogFixture();
    codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources, f.proof);
    expect(f.oldSources).toHaveLength(5);
    for (const source of f.oldSources) expect(() => validateTenantTelemetrySourceAccountingEntry(source)).not.toThrow();
    expect(() => validateTenantTelemetryPlanArtifactTarget(f.oldTarget)).not.toThrow();
    expect(f.catalog.sourceCount).toBe(11); expect(f.catalog.entryCount).toBe(2);
    expect(f.catalog.applicationV1Count).toBe(1); expect(f.catalog.persistedProviderV2Count).toBe(1);
    expect(f.catalog.logsTargetCount).toBe(1); expect(f.catalog.tracesTargetCount).toBe(1);
    expect(f.catalog.unknownSourceCount).toBe(0);
    expect(f.proof.legacyAnchors.sourceReceipt.entryCount).toBe(9);
    expect(f.proof.legacyAnchors.sourceReceipt.unknownCount).toBe(4);
    expect(f.proof.legacyAnchors.manifestReceipt.observedTargetCount).toBe(1);
    expect(f.proof.legacyAnchors.manifestReceipt.unknownGroupCount).toBe(1);
    expect(f.catalog.executionReady).toBe(false); expect(f.catalog.externalAuthorityVerified).toBe(false);
    expect(f.catalog.allDomainsComplete).toBe(false);
    const { receiptSha256, ...oldTargetBody } = f.oldTarget;
    expect(receiptSha256).toBe(tenantTelemetryPlanArtifactTargetSha256(oldTargetBody));
  });

  it("rejects a resealed application-v1 binding claim that differs from the independent old-shape snapshot", () => {
    const f = mixedCatalogFixture();
    if (f.v1Target.source.kind !== "application-v1") throw new Error("expected v1 pure fixture");
    const target = reseal(f.v1Target, { source: { ...f.v1Target.source, applicationBindingReceiptSha256: sha("substituted-v1-binding") } });
    const sources = f.sources.map((source) => source.writeOperationSha256 === target.writeOperationSha256
      ? reseal(source, { catalogTargetEntryReceiptSha256: target.receiptSha256,
        ...(source.sourceKind === "application_binding" ? { sourceEvidenceSha256: sha("substituted-v1-binding") } : {}) }) : source);
    const observed = f.proof.observedSourceRows.map((row) => row.writeOperationSha256 === target.writeOperationSha256
      && row.sourceKind === "application_binding" ? { ...row, sourceEvidenceSha256: sha("substituted-v1-binding") } : row);
    expect(() => sealCatalog(f.identity, [f.target, target], sources, { ...f.proof, observedSourceRows: observed })).toThrow();
  });

  it.each(TENANT_TELEMETRY_SOURCE_KINDS)("rejects an application-v1 target with its actual %s row omitted, even with fresh count/root construction", (kind) => {
    const f = mixedCatalogFixture();
    const sources = f.sources.filter((source) => !(source.writeOperationSha256 === f.oldTarget.writeOperationSha256 && source.sourceKind === kind));
    const observed = f.proof.observedSourceRows.filter((row) => !(row.writeOperationSha256 === f.oldTarget.writeOperationSha256 && row.sourceKind === kind));
    expect(() => sealCatalog(f.identity, f.targets, sources, { ...f.proof, observedSourceRows: observed })).toThrow();
  });

  it.each(["legacySourceAccountingReceiptSha256", "legacyTargetManifestReceiptSha256"] as const)(
    "rejects replacement of %s after new receipt resealing when the independently audited caller anchor is unchanged", (key) => {
      const f = mixedCatalogFixture();
      const anchors = clone(f.proof.legacyAnchors);
      const catalog = reseal(f.catalog, { [key]: sha("replacement-old-anchor") });
      // This only proves syntax/checksum validity, never old receipt provenance or authorization.
      expect(() => codec.validateTenantTelemetryRetainedSourceCatalogReceipt(catalog)).not.toThrow();
      expect(f.proof.legacyAnchors).toEqual(anchors);
      expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(catalog, f.targets, f.sources, f.proof)).toThrow();
    });

  it("rejects independently valid rehashed old receipt objects whose actual five-row snapshot differs from the observed seven-row snapshot", () => {
    const f = mixedCatalogFixture();
    const rows = f.proof.observedSourceRows.map((row) => row.sourceKind === "membership"
      && row.writeOperationSha256 === f.oldTarget.writeOperationSha256
      ? { ...row, sourceEvidenceSha256: sha("different-actual-membership") } : row);
    const legacyAnchors = legacyAnchorsFixture(f.identity, rows, f.targets);
    expect(() => validateTenantTelemetrySourceAccountingProof(legacyAnchors.job, legacyAnchors.planReceipt,
      legacyAnchors.sourceEntries, legacyAnchors.sourceReceipt)).not.toThrow();
    expect(() => validateTenantTelemetryTargetManifestProof({ ...legacyAnchors,
      entries: legacyAnchors.manifestEntries, receipt: legacyAnchors.manifestReceipt })).not.toThrow();
    const catalog = reseal(f.catalog, { legacySourceAccountingReceiptSha256: legacyAnchors.sourceReceipt.receiptSha256,
      legacyTargetManifestReceiptSha256: legacyAnchors.manifestReceipt.receiptSha256 });
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogReceipt(catalog)).not.toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(catalog, f.targets, f.sources,
      { ...f.proof, legacyAnchors })).toThrow();
  });

  it("rejects a self-consistent v1 target owner replacement when the actual independently validated manifest owner is unchanged", () => {
    const f = mixedCatalogFixture();
    const { receiptSha256: ignored, ...body } = f.oldTarget; void ignored;
    const oldBody = { ...body, ownerBindingSha256: sha("substituted-owner-binding") };
    const oldTarget = { ...oldBody, receiptSha256: tenantTelemetryPlanArtifactTargetSha256(oldBody) };
    expect(() => validateTenantTelemetryPlanArtifactTarget(oldTarget)).not.toThrow();
    const target = reseal(f.v1Target, { ownerBindingSha256: oldTarget.ownerBindingSha256 });
    const sources = f.sources.map((source) => source.writeOperationSha256 === target.writeOperationSha256
      ? reseal(source, { catalogTargetEntryReceiptSha256: target.receiptSha256 }) : source);
    expect(() => sealCatalog(f.identity, [f.target, target], sources,
      { ...f.proof, applicationV1Targets: [oldTarget] })).toThrow();
  });

  it("requires actual closed legacy proof objects; absent objects or a malformed terminal plan are never defaulted", () => {
    const f = fixture();
    const missing = { ...f.catalogProof } as Partial<codec.TenantTelemetryRetainedSourceCatalogProof>;
    delete missing.legacyAnchors;
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      missing as codec.TenantTelemetryRetainedSourceCatalogProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      { ...f.catalogProof, legacyAnchors: { ...f.catalogProof.legacyAnchors,
        job: { ...f.catalogProof.legacyAnchors.job, scanComplete: false } } })).toThrow();
  });

  it("accepts every internally derived cohort root scope before constructing any receipt fixture", () => {
    for (const state of codec.TENANT_TELEMETRY_RETAINED_SOURCE_COHORT_STATES) {
      const root = codec.tenantTelemetryRetainedSourceT1CohortRootSha256([], state);
      expect(root).toBe(codec.tenantTelemetryRetainedSourceSha256(
        `tenant-telemetry-retained-source-t1-${state}-root-v1`, []));
      expect(root).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const scope of ["Uppercase", "has space", "path/slash", "null\u0000byte", "a".repeat(193)]) {
      expect(() => codec.tenantTelemetryRetainedSourceSha256(scope, [])).toThrow();
    }
  });

  it("binds the four immutable families bottom-up without external authority", () => {
    const f = fixture();
    codec.validateTenantTelemetryRetainedSourceT1CohortProof(f.t1, f.t1Entries, f.profile);
    codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources, f.catalogProof);
    codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(f.usage, f.usageEntries, f.usageProof);
    codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical, f.canonicalEntries, f.canonicalProof);
    codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(f.canonicalEntry,
      { writeOperationSha256: f.failure.writeOperationSha256, item: f.item, events: f.events }, f.failure);
    expect(f.item.seq).toBeLessThan(f.failure.sourceEventSeq);
    for (const receipt of [f.t1, f.catalog, f.usage, f.canonical]) {
      expect(receipt.executionReady).toBe(false); expect(receipt.externalAuthorityVerified).toBe(false);
      expect(receipt.allDomainsComplete).toBe(false); expect(receipt.contentPurgeExecuted).toBe(false);
      expect(Object.isFrozen(receipt)).toBe(true);
    }
    expect(Object.isFrozen(f.t1.profile)).toBe(true);
    expect(f.catalog.sourceCount).toBe(6);
    expect(f.catalog.providerSourceBindingCount).toBe(1);
    expect(f.catalog.providerFailureCommitCount).toBe(1);
    expect(f.catalog.applicationBindingCount).toBe(0);
    expect(f.failure.receiptSha256).toBe(persistedProviderCaptureReceiptSha256(f.failure));
  });

  it("seals explicit empty sets in all four families", () => {
    const f = fixture(false);
    expect(f.t1.entryCount).toBe(0); expect(f.t1.eligibility).toBe("eligible_retained");
    expect(f.catalog.sourceCount).toBe(0); expect(f.catalog.entryCount).toBe(0);
    expect(f.usage.entryCount).toBe(0); expect(f.canonical.entryCount).toBe(0);
    codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical, [], f.canonicalProof);
    expect(f.t1.entryRootSha256).not.toBe(f.catalog.entryRootSha256);
    expect(f.usage.entryRootSha256).not.toBe(f.canonical.entryRootSha256);
  });

  it("binds pre-DELETE usage evidence to a later independently anchored ACK/cutover timestamp", () => {
    const f = fixture();
    const entry = reseal(f.usageEntry, { releasedAtDbMs: 1_550 });
    const receipt = reseal(f.usage, {
      entryRootSha256: codec.tenantTelemetryRetainedSourceUsageReleaseRootSha256([entry]),
    });
    expect(entry.sourceHighWaterDbMs).toBe(1_500);
    expect(receipt.storeDbTimestampMs).toBe(1_600);
    expect(receipt.storeDbTimestampMs).toBe(f.usageProof.anchors.storeDbTimestampMs);
    expect(receipt.operationalUsageAckReceiptSha256).toBe(f.usageProof.anchors.operationalUsageAckReceiptSha256);
    expect(receipt.localCutoverReceiptSha256).toBe(f.usageProof.anchors.localCutoverReceiptSha256);
    codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(receipt, [entry], f.usageProof);
  });

  it("rejects future pre-DELETE evidence despite a valid leaf and freshly resealed aggregate root", () => {
    const f = fixture();
    const entry = reseal(f.usageEntry, { releasedAtDbMs: 1_601 });
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseEntry(entry)).not.toThrow();
    const receipt = reseal(f.usage, {
      entryRootSha256: codec.tenantTelemetryRetainedSourceUsageReleaseRootSha256([entry]),
    });
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseReceipt(receipt)).not.toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(receipt, [entry], f.usageProof))
      .toThrow(codec.TenantTelemetryRetainedSourceIntegrityError);
  });

  it("never backdates a usage aggregate away from the independent old ACK/cutover boundary", () => {
    const f = fixture();
    const entry = reseal(f.usageEntry, { releasedAtDbMs: 1_550 });
    const receipt = reseal(f.usage, {
      entryRootSha256: codec.tenantTelemetryRetainedSourceUsageReleaseRootSha256([entry]),
      storeDbTimestampMs: 1_599,
    });
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseReceipt(receipt)).not.toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(receipt, [entry], f.usageProof))
      .toThrow(codec.TenantTelemetryRetainedSourceIntegrityError);
  });

  it("admits an honest active old-tenant blocked profile without inventing primary coverage", () => {
    const f = fixture();
    const legacyHash = codec.tenantTelemetryRetainedSourceLegacyFailedItemSha256({ tenantId, userId: "user",
      item: f.item, classification: null, controlGeneration: null });
    const profile: codec.TenantTelemetryRetainedSourceT1Profile = { kind: "blocked-source",
      controlProjectionSha256: sha("valid-active-control"), lifecycleCoverageEvidenceSha256: sha("legacy-lifecycle-coverage"),
      captureCoverageEvidenceSha256: sha("cutover-coverage"), runtimeEpochSha256: sha("epoch"), runtimeBindingSha256: sha("runtime-binding"),
      legacyFailedItemCount: 1, legacyFailedItemRootSha256: codec.tenantTelemetryRetainedSourceLegacyFailedItemRootSha256(f.identity, [legacyHash]),
      observedHighWaterDbMs: 1_300, reasons: ["coverage_not_creation_complete", "legacy_failed_items", "legacy_tenant"] };
    const identity = { ...f.identity, t1ProfileSha256: codec.tenantTelemetryRetainedSourceT1ProfileSha256(profile) };
    const receipt = sealT1(identity, profile, []);
    expect(receipt.eligibility).toBe("blocked_source");
    expect("primaryBinding" in receipt.profile).toBe(false);
    expect(() => codec.validateTenantTelemetryRetainedSourceT1CohortReceipt(
      reseal(receipt, { tenantLifecycleSubjectEvidenceSha256: null as unknown as string }))).toThrow();
  });

  it.each(["pending", "reserved", "blocked", "unknown"] as const)("freezes %s at T1; a late ACK cannot upgrade eligibility", (state) => {
    const f = fixture();
    const entry = reseal(f.t1Entry, { state, writeAckReceiptSha256: null, inventoryReceiptSha256: null,
      reservationSha256: state === "pending" ? null : f.t1Entry.reservationSha256 });
    const receipt = sealT1(f.identity, f.profile, [entry]);
    expect(receipt.eligibility).toBe("blocked_source");
    expect(() => codec.validateTenantTelemetryRetainedSourceT1CohortProof(receipt, [f.t1Entry], f.profile)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      { ...f.catalogProof, cohortReceipt: receipt, cohortEntries: [entry] })).toThrow();
  });

  it("accounts for the seventh physical kind as unknown rather than silently omitting it", () => {
    const f = fixture();
    const orphan: codec.TenantTelemetryRetainedSourceObservedRow = { sourceKind: "application_binding",
      sourceIdentitySha256: sha("orphan-operation"), sourceEvidenceSha256: sha("orphan-binding"), domain: "logs",
      writeOperationSha256: sha("orphan-operation"), sourceHighWaterDbMs: 1_450 };
    const source = codec.buildTenantTelemetryRetainedSourceCatalogSourceEntry({ ...f.identity, ...orphan,
      scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE, planBuildGeneration: 1,
      cohortReceiptSha256: f.t1.receiptSha256, artifactGroupSha256: null, catalogTargetEntryReceiptSha256: null,
      classification: "unknown", capturedAtDbMs: 1_500 });
    const sources = [...f.sources, source];
    const proof = { ...f.catalogProof, observedSourceRows: [...f.observed, orphan],
      legacyAnchors: legacyAnchorsFixture(f.identity, [...f.observed, orphan], f.targets) };
    const catalog = sealCatalog(f.identity, f.targets, sources, proof);
    expect(catalog.sourceCount).toBe(7); expect(catalog.applicationBindingCount).toBe(1);
    expect(catalog.unknownSourceCount).toBe(1); expect(catalog.unknownGroupCount).toBe(1);
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(catalog, f.targets, f.sources, proof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(f.usage, f.usageEntries,
      { ...f.usageProof, catalogReceipt: catalog, catalogSources: sources, catalogProof: proof })).toThrow();
  });

  it("keeps nullable orphan inventory links independent from observed-row field validation", () => {
    const { identity } = identityAndProfile();
    const row: codec.TenantTelemetryRetainedSourceObservedRow = { sourceKind: "inventory",
      sourceIdentitySha256: sha("orphan-inventory"), sourceEvidenceSha256: sha("orphan-inventory-receipt"),
      domain: "logs", writeOperationSha256: null, sourceHighWaterDbMs: 1_450 };
    expect(() => codec.validateTenantTelemetryRetainedSourceObservedRow(row)).not.toThrow();
    const entry = codec.buildTenantTelemetryRetainedSourceCatalogSourceEntry({ ...identity, ...row,
      scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE, planBuildGeneration: 1,
      cohortReceiptSha256: sha("cohort"), artifactGroupSha256: null, catalogTargetEntryReceiptSha256: null,
      classification: "unknown", capturedAtDbMs: 1_500 });
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogSourceEntry(entry)).not.toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogSourceEntry(reseal(entry,
      { classification: "accounted" }))).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceObservedRow({ ...row,
      sourceKind: "write_job" })).toThrow();
  });

  it("requires an exact independently observed source bijection even if counts remain equal", () => {
    const f = fixture();
    const rows = f.observed.map((row, index) => index === 0 ? { ...row, sourceEvidenceSha256: sha("other-inventory") } : row);
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      { ...f.catalogProof, observedSourceRows: rows })).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      { ...f.catalogProof, observedSourceRows: [...f.observed, f.observed[0]!] })).toThrow();
  });

  it("deduplicates unknown raw groups only by independently derived tenant-bound identity", () => {
    const f = fixture();
    const operation = sha("unknown-operation");
    const make = (sourceKind: "write_job" | "membership") => codec.buildTenantTelemetryRetainedSourceCatalogSourceEntry({
      ...f.identity, scope: codec.TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE,
      planBuildGeneration: 1, cohortReceiptSha256: f.t1.receiptSha256,
      sourceKind, sourceIdentitySha256: operation, sourceEvidenceSha256: sha(sourceKind),
      domain: "logs", writeOperationSha256: operation, sourceHighWaterDbMs: 1_450,
      artifactGroupSha256: codec.tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId, operation),
      catalogTargetEntryReceiptSha256: null, classification: "unknown", capturedAtDbMs: 1_500,
    });
    const entries = [make("write_job"), make("membership")];
    expect(codec.tenantTelemetryRetainedSourceCatalogUnknownGroups(entries)).toHaveLength(1);
    for (const entry of entries) {
      expect(() => codec.validateTenantTelemetryRetainedSourceCatalogSourceEntry(reseal(entry,
        { artifactGroupSha256: sha("arbitrary-collapse-group") }))).toThrow();
      expect(() => codec.validateTenantTelemetryRetainedSourceCatalogSourceEntry(reseal(entry,
        { tenantId: "different-tenant" }))).toThrow();
    }
  });

  it("rejects a forged published artifact group even after every related source and catalog root is resealed", () => {
    const f = fixture();
    const wrongGroup = sha("arbitrary-noncanonical-group");
    const target = reseal(f.target, { artifactGroupSha256: wrongGroup });
    const sources = f.sources.map((source) => reseal(source, {
      artifactGroupSha256: wrongGroup, catalogTargetEntryReceiptSha256: target.receiptSha256,
    }));
    const root = (subset: codec.TenantTelemetryRetainedSourceRawKind) =>
      codec.tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources, subset);
    const catalog = reseal(f.catalog, {
      entryRootSha256: codec.tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-catalog-all-root-v1",
        [[wrongGroup, target.receiptSha256]]),
      persistedProviderV2RootSha256: codec.tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-catalog-persisted-provider-v2-root-v1",
        [[wrongGroup, target.receiptSha256]]),
      sourceRootSha256: codec.tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources),
      inventoryRootSha256: root("inventory"), writeJobRootSha256: root("write_job"),
      writeAckRootSha256: root("write_ack"), membershipRootSha256: root("membership"),
      providerSourceBindingRootSha256: root("provider_source_binding"),
      providerFailureCommitRootSha256: root("provider_failure_commit"),
    });
    // A valid checksum and aggregate count are insufficient: group identity is independently derived.
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogReceipt(catalog)).not.toThrow();
    for (const source of sources) expect(() => codec.validateTenantTelemetryRetainedSourceCatalogSourceEntry(source)).not.toThrow();
    expect(target.receiptSha256).toBe(codec.tenantTelemetryRetainedSourceReceiptSha256(target));
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(catalog, [target], sources, f.catalogProof)).toThrow();
  });

  it.each(["runtimeEpochSha256", "runtimeBindingSha256", "captureControlEvidenceSha256"] as const)("rejects an original failure with another %s", (key) => {
    const f = fixture();
    const failure = { ...f.failure, [key]: sha("other") };
    failure.receiptSha256 = persistedProviderCaptureReceiptSha256(failure);
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog, f.targets, f.sources,
      { ...f.catalogProof, failureReceipts: [failure] })).toThrow();
  });

  it("rejects reassigned tenant, target, claim, and billing identities after an attacker recomputes hashes", () => {
    const f = fixture();
    expect(() => codec.validateTenantTelemetryRetainedSourceT1CohortProof(reseal(f.t1, { tenantId: "other" }), f.t1Entries, f.profile)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogProof(f.catalog,
      [reseal(f.target, { targetSha256: sha("other-target") })], f.sources, f.catalogProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(f.usage,
      [reseal(f.usageEntry, { completedClaimTokenSha256: sha("other-claim") })], f.usageProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseProof(f.usage,
      [reseal(f.usageEntry, { retainedBillingFactSha256: sha("other-bill") })], f.usageProof)).toThrow();
  });

  it("requires original complete canonical event range and snapshot, not only a failed item", () => {
    const f = fixture();
    const snapshot = { writeOperationSha256: f.failure.writeOperationSha256, item: f.item, events: f.events };
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(f.canonicalEntry,
      { ...snapshot, events: [f.events[0]!] }, f.failure)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(f.canonicalEntry,
      { ...snapshot, item: { ...f.item, seq: 0 } }, f.failure)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(f.canonicalEntry,
      { ...snapshot, item: { ...f.item, seq: 5 } }, f.failure)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(f.canonicalEntry,
      { ...snapshot, item: { ...f.item, text: "changed" } }, f.failure)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalSnapshot(
      reseal(f.canonicalEntry, { sourceItemRefSha256: sha("other-source") }), snapshot, f.failure)).toThrow();
  });

  it("cannot replace old 0039 owner/grave or upstream usage proof with a freshly hashed local claim", () => {
    const f = fixture();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical,
      [reseal(f.canonicalEntry, { ownerClosureEntryReceiptSha256: sha("forged-owner") })], f.canonicalProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical,
      [reseal(f.canonicalEntry, { sessionGraveMarkerSha256: sha("forged-grave") })], f.canonicalProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical,
      [reseal(f.canonicalEntry, { usageReleaseEntryReceiptSha256: sha("forged-usage") })], f.canonicalProof)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical, f.canonicalEntries,
      { ...f.canonicalProof, ownerClosureEntries: [] })).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureProof(f.canonical, f.canonicalEntries,
      { ...f.canonicalProof, graveMarkers: [] })).toThrow();
  });

  it("rejects duplicate operation/billing proofs rather than truncating them", () => {
    const f = fixture();
    expect(() => codec.tenantTelemetryRetainedSourceT1CohortRootSha256([f.t1Entry, f.t1Entry])).toThrow();
    expect(() => codec.tenantTelemetryRetainedSourceCatalogRootSha256([f.target, f.target])).toThrow();
    expect(() => codec.tenantTelemetryRetainedSourceUsageReleaseRootSha256([f.usageEntry, f.usageEntry])).toThrow();
    expect(() => codec.tenantTelemetryRetainedSourceCanonicalClosureRootSha256([f.canonicalEntry, f.canonicalEntry])).toThrow();
  });

  it("enforces safe integer counts, strict time floors, and positive source step", () => {
    const f = fixture();
    for (const change of [{ entryCount: Number.MAX_SAFE_INTEGER + 1 }, { pendingCount: -1 },
      { storeDbTimestampMs: 1_299 }, { sourceHighWaterDbMs: 1_199 }]) {
      expect(() => codec.validateTenantTelemetryRetainedSourceT1CohortReceipt(reseal(f.t1, change))).toThrow();
    }
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureEntry(reseal(f.canonicalEntry, { sourceStepIndex: 0 }))).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceUsageReleaseEntry(reseal(f.usageEntry, { releasedAtDbMs: 1_499 }))).toThrow();
  });

  it("never turns schema extensions or completion bits into authority by recomputing a checksum", () => {
    const f = fixture();
    const extra = { ...f.t1, authorization: true };
    extra.receiptSha256 = codec.tenantTelemetryRetainedSourceReceiptSha256(extra);
    expect(() => codec.validateTenantTelemetryRetainedSourceT1CohortReceipt(extra)).toThrow();
    const profile = { ...f.profile, futureAuthority: true };
    expect(() => codec.tenantTelemetryRetainedSourceT1ProfileSha256(profile)).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCatalogReceipt(reseal(f.catalog,
      { externalAuthorityVerified: true as unknown as false }))).toThrow();
    expect(() => codec.validateTenantTelemetryRetainedSourceCanonicalClosureReceipt(reseal(f.canonical,
      { allDomainsComplete: true as unknown as false }))).toThrow();
  });

  it("uses deterministic domain-separated hashes without changing old codecs", () => {
    expect(codec.tenantTelemetryRetainedSourceCanonicalJson({ z: 2, a: [1, null] })).toBe('{"a":[1,null],"z":2}');
    expect(codec.tenantTelemetryRetainedSourceSha256("scope-one", { a: 1, b: 2 }))
      .toBe(codec.tenantTelemetryRetainedSourceSha256("scope-one", { b: 2, a: 1 }));
    expect(codec.tenantTelemetryRetainedSourceSha256("scope-one", [])).not.toBe(codec.tenantTelemetryRetainedSourceSha256("scope-two", []));
    expect(codec.tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId, sha("operation")))
      .not.toBe(codec.tenantTelemetryRetainedSourceManagedOperationIdentitySha256("other", sha("operation")));
    const f = fixture();
    expect(f.catalog.logsTargetRootSha256).toBe(tenantTelemetryDispositionInventoryTargetRootSha256("logs",
      codec.tenantTelemetryRetainedSourceCatalogPlanTargets(f.targets, "logs")));
    expect(f.failure.receiptSha256).toBe(persistedProviderCaptureReceiptSha256(f.failure));
  });

  it("rejects non-JSON/accessor/symbol/sparse/cyclic hash inputs", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const sparse = new Array(1);
    const symbol = { [Symbol("hidden")]: 1 };
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const hidden = Object.defineProperty({}, "value", { enumerable: false, value: 1 });
    for (const value of [undefined, { missing: undefined }, [undefined], new Date(), BigInt(1), NaN, Infinity,
      cycle, sparse, symbol, accessor, hidden, () => 1]) {
      expect(() => codec.tenantTelemetryRetainedSourceCanonicalJson(value)).toThrow();
    }
  });

  it("derives closed sorted blocked reasons without confusing generation-1 runtime failures with legacy", () => {
    expect(codec.deriveTenantTelemetryRetainedSourceBlockedReasons({ lifecycleHistoryStatus: "complete_since_creation",
      captureStatus: "capture_since_tenant_creation", legacyFailedItemCount: 0, runtimeState: "primary", restorePending: false })).toEqual([]);
    expect(codec.deriveTenantTelemetryRetainedSourceBlockedReasons({ lifecycleHistoryStatus: "legacy_history_unknown",
      captureStatus: "capture_since_cutover", legacyFailedItemCount: null, runtimeState: "primary", restorePending: false }))
      .toEqual(["coverage_not_creation_complete", "legacy_history_unproven", "legacy_tenant"]);
    const f = fixture();
    expect(() => codec.tenantTelemetryRetainedSourceLegacyFailedItemSha256({ tenantId, userId: "user", item: f.item,
      classification: "runtime_unknown", controlGeneration: 1 as unknown as 0 })).toThrow();
  });
});
