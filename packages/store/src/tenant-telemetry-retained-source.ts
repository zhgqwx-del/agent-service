import { createHash } from "node:crypto";
import {
  validatePersistedProviderFailureCommitReceipt,
  type PersistedProviderStepFailureCommitReceipt,
} from "./tenant-telemetry-persisted-provider-capture.js";
import {
  validateTenantTelemetryPlanArtifactTarget,
  type TenantTelemetryPlanArtifactTarget,
} from "./tenant-telemetry-plan-artifact-target.js";
import {
  validateTenantTelemetryOwnerClosureEntry,
  type TenantTelemetryOwnerClosureEntry,
} from "./tenant-telemetry-owner-closure.js";
import { tenantTelemetryDispositionInventoryTargetRootSha256 } from "./tenant-telemetry-disposition.js";
import {
  tenantTelemetryTargetManifestArtifactGroupSha256,
  validateTenantTelemetryTargetManifestProof,
  type TenantTelemetryTargetManifestEntry,
  type TenantTelemetryTargetManifestReceipt,
} from "./tenant-telemetry-target-manifest.js";
import {
  TENANT_TELEMETRY_SOURCE_KINDS,
  validateTenantTelemetrySourceAccountingProof,
  type TenantTelemetrySourceAccountingEntry,
  type TenantTelemetrySourceAccountingReceipt,
} from "./tenant-telemetry-source-accounting.js";
import {
  validateTenantPurgePlanJobRecord,
  validateTenantPurgePlanReceipt,
  type TenantPurgePlanJobRecord,
  type TenantPurgePlanReceipt,
} from "./tenant-purge-plan.js";
import { assertBillingUsageFact } from "./usage-lifecycle.js";
import type { BillingUsageFact } from "./types.js";
import { persistedProviderCaptureSha256, persistedProviderCaptureEventRoot } from "./tenant-telemetry-persisted-provider-capture.js";
import type { Item, PersistedEvent } from "@agent-service/protocol";
import {
  validateTenantDatabasePurgeSessionGraveMarker,
  tenantDatabasePurgeSessionGraveMarkerRootSha256,
  type TenantPurgeSessionGraveMarker,
} from "./tenant-database-purge.js";

/**
 * Content-free retained-object evidence for a new tenant in its original primary epoch.
 * These codecs do not prove DB provenance, authorize external deletion, or permit restore.
 * Stores must capture the whole managed graph under the original transaction/owner fences.
 * No existing v1/0053 hash or receipt is reinterpreted by this protocol.
 */
export const TENANT_TELEMETRY_RETAINED_SOURCE_PROTOCOL =
  "tenant-telemetry-retained-source-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_PRIMARY_SCOPE =
  "tenant-telemetry-retained-source-primary-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE =
  "tenant-telemetry-retained-source-t1-entry-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_T1_RECEIPT_SCOPE =
  "tenant-telemetry-retained-source-t1-receipt-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE =
  "tenant-telemetry-retained-source-catalog-entry-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_RECEIPT_SCOPE =
  "tenant-telemetry-retained-source-catalog-receipt-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_ENTRY_SCOPE =
  "tenant-telemetry-retained-source-usage-entry-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_RECEIPT_SCOPE =
  "tenant-telemetry-retained-source-usage-receipt-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_ENTRY_SCOPE =
  "tenant-telemetry-retained-source-canonical-entry-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_RECEIPT_SCOPE =
  "tenant-telemetry-retained-source-canonical-receipt-v1" as const;

export const TENANT_TELEMETRY_RETAINED_SOURCE_COHORT_STATES =
  ["written_ack", "pending", "reserved", "blocked", "unknown"] as const;
export type TenantTelemetryRetainedSourceCohortState =
  (typeof TENANT_TELEMETRY_RETAINED_SOURCE_COHORT_STATES)[number];
export type TenantTelemetryRetainedSourceHistoricalPhase =
  "live_complete" | "usage_released_canonical_present" | "canonical_closed";
export const TENANT_TELEMETRY_RETAINED_SOURCE_BLOCK_REASONS = [
  "coverage_missing", "coverage_not_creation_complete", "legacy_failed_items",
  "legacy_history_unproven", "legacy_tenant", "restore_pending", "runtime_not_primary",
] as const;
export type TenantTelemetryRetainedSourceBlockReason =
  (typeof TENANT_TELEMETRY_RETAINED_SOURCE_BLOCK_REASONS)[number];
export const TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE =
  "tenant-telemetry-retained-source-catalog-source-v1" as const;
export const TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS = ["inventory", "write_job", "write_ack",
  "membership", "application_binding", "provider_source_binding", "provider_failure_commit"] as const;
export type TenantTelemetryRetainedSourceRawKind =
  (typeof TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS)[number];

export class TenantTelemetryRetainedSourceIntegrityError extends Error {
  constructor() {
    super("tenant telemetry retained-source evidence is invalid");
    this.name = "TenantTelemetryRetainedSourceIntegrityError";
  }
}

export interface TenantTelemetryRetainedSourcePrimaryBinding {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_PRIMARY_SCOPE;
  captureControlEvidenceSha256: string;
  lifecycleControlEvidenceSha256: string;
  refKeyIdSha256: string;
  logsTargetSha256: string;
  logsTargetReceiptSha256: string;
  runtimeEpochSha256: string;
  runtimeBindingSha256: string;
  runtimeControlEvidenceSha256: string;
  runtimeControlGeneration: number;
  lifecycleCoverageEvidenceSha256: string;
  captureCoverageEvidenceSha256: string;
  lifecycleHistoryStatus: "complete_since_creation";
  captureStatus: "capture_since_tenant_creation";
  lifecycleActivatedAtDbMs: number;
  captureActivatedAtDbMs: number;
  lifecycleCoverageStartedAtDbMs: number;
  captureCoverageStartedAtDbMs: number;
  tenantCreatedAtDbMs: number;
  evidenceSha256: string;
}

export interface TenantTelemetryRetainedSourceIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1ProfileSha256: string;
  /** Exact existing TenantCredentialRevocationFence.evidenceSha256. */
  t1FenceSha256: string;
}

export type TenantTelemetryRetainedSourceT1Profile =
  | { kind: "eligible-primary"; primaryBinding: TenantTelemetryRetainedSourcePrimaryBinding;
      legacyFailedItemCount: 0; legacyFailedItemRootSha256: string }
  | { kind: "blocked-source"; controlProjectionSha256: string;
      lifecycleCoverageEvidenceSha256: string | null; captureCoverageEvidenceSha256: string | null;
      runtimeEpochSha256: string | null; runtimeBindingSha256: string | null;
      legacyFailedItemCount: number | null; legacyFailedItemRootSha256: string | null;
      observedHighWaterDbMs: number; reasons: readonly TenantTelemetryRetainedSourceBlockReason[] };

/** All states are frozen at T1; later ACKs never replace an entry or its eligibility. */
export interface TenantTelemetryRetainedSourceT1CohortEntry
  extends TenantTelemetryRetainedSourceIdentity {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE;
  sourceIdentitySha256: string;
  state: TenantTelemetryRetainedSourceCohortState;
  writeOperationSha256: string | null;
  failureCommitReceiptSha256: string | null;
  sourceBindingReceiptSha256: string | null;
  membershipSha256: string | null;
  writeJobEvidenceSha256: string | null;
  reservationSha256: string | null;
  writeAckReceiptSha256: string | null;
  inventorySha256: string | null;
  inventoryReceiptSha256: string | null;
  payloadSha256: string | null;
  sourceHighWaterDbMs: number;
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantTelemetryRetainedSourceSafety {
  executionReady: false;
  externalAuthorityVerified: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
}

export interface TenantTelemetryRetainedSourceT1CohortReceipt
  extends TenantTelemetryRetainedSourceIdentity, TenantTelemetryRetainedSourceSafety {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_T1_RECEIPT_SCOPE;
  profile: TenantTelemetryRetainedSourceT1Profile;
  /** Actual active-lifecycle T1 subject; the inactive path has no new-family receipt. */
  tenantLifecycleSubjectEvidenceSha256: string;
  entryCount: number;
  entryRootSha256: string;
  writtenAckCount: number;
  writtenAckRootSha256: string;
  pendingCount: number;
  pendingRootSha256: string;
  reservedCount: number;
  reservedRootSha256: string;
  blockedCount: number;
  blockedRootSha256: string;
  unknownCount: number;
  unknownRootSha256: string;
  eligibility: "eligible_retained" | "blocked_source";
  t1AcceptedAtDbMs: number;
  sourceHighWaterDbMs: number;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

export type TenantTelemetryRetainedSourceCatalogEvidence =
  | { kind: "application-v1"; applicationBindingReceiptSha256: string;
      applicationCoverageEvidenceSha256: string; sourceGroupRootSha256: string }
  | { kind: "persisted-provider-v2"; failureCommitReceiptSha256: string;
      sourceBindingReceiptSha256: string; captureCoverageEvidenceSha256: string;
      cohortEntryReceiptSha256: string };

export interface TenantTelemetryRetainedSourceCatalogEntry
  extends TenantTelemetryRetainedSourceIdentity {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE;
  planBuildGeneration: number;
  cohortReceiptSha256: string;
  domain: "logs" | "traces";
  source: TenantTelemetryRetainedSourceCatalogEvidence;
  artifactGroupSha256: string;
  targetSha256: string;
  targetReceiptSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  inventorySha256: string;
  inventoryReceiptSha256: string;
  writeOperationSha256: string;
  writeJobEvidenceSha256: string;
  reservationSha256: string;
  writeAckReceiptSha256: string;
  membershipSha256: string;
  payloadSha256: string;
  manifestSha256: string;
  lifecycleCoverageEvidenceSha256: string;
  ownerKind: "tenant" | "user" | "session";
  ownerRefSha256: string;
  holdSubjectRefSha256: string;
  ownerBindingSha256: string;
  liveOwnerClaimSha256: string;
  sourceHighWaterDbMs: number;
  capturedAtDbMs: number;
  receiptSha256: string;
}

/** One independently observed physical row. This is never a deletion locator or authority. */
export interface TenantTelemetryRetainedSourceObservedRow {
  sourceKind: TenantTelemetryRetainedSourceRawKind;
  sourceIdentitySha256: string;
  sourceEvidenceSha256: string;
  domain: "logs" | "traces";
  writeOperationSha256: string | null;
  sourceHighWaterDbMs: number;
}
export interface TenantTelemetryRetainedSourceCatalogSourceEntry
  extends TenantTelemetryRetainedSourceIdentity, TenantTelemetryRetainedSourceObservedRow {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE;
  planBuildGeneration: number;
  cohortReceiptSha256: string;
  artifactGroupSha256: string | null;
  catalogTargetEntryReceiptSha256: string | null;
  classification: "accounted" | "unknown";
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantTelemetryRetainedSourceCatalogReceipt
  extends TenantTelemetryRetainedSourceIdentity, TenantTelemetryRetainedSourceSafety {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_RECEIPT_SCOPE;
  planBuildGeneration: number;
  cohortReceiptSha256: string;
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  /** These retain their old semantics; neither claims to account for v2 sources. */
  legacySourceAccountingReceiptSha256: string;
  legacyTargetManifestReceiptSha256: string;
  proofFamily: typeof TENANT_TELEMETRY_RETAINED_SOURCE_PROTOCOL;
  sourceCount: number;
  sourceRootSha256: string;
  inventoryCount: number;
  inventoryRootSha256: string;
  writeJobCount: number;
  writeJobRootSha256: string;
  writeAckCount: number;
  writeAckRootSha256: string;
  membershipCount: number;
  membershipRootSha256: string;
  applicationBindingCount: number;
  applicationBindingRootSha256: string;
  providerSourceBindingCount: number;
  providerSourceBindingRootSha256: string;
  providerFailureCommitCount: number;
  providerFailureCommitRootSha256: string;
  unknownSourceCount: number;
  unknownSourceRootSha256: string;
  entryCount: number;
  entryRootSha256: string;
  applicationV1Count: number;
  applicationV1RootSha256: string;
  persistedProviderV2Count: number;
  persistedProviderV2RootSha256: string;
  logsTargetCount: number;
  logsTargetRootSha256: string;
  tracesTargetCount: number;
  tracesTargetRootSha256: string;
  unknownGroupCount: number;
  unknownGroupRootSha256: string;
  sourceHighWaterDbMs: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  receiptSha256: string;
}

/** Pre-delete entry: deliberately excludes the final ACK/new aggregate to avoid a hash cycle. */
export interface TenantTelemetryRetainedSourceUsageReleaseEntry
  extends TenantTelemetryRetainedSourceIdentity {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_ENTRY_SCOPE;
  planBuildGeneration: number;
  executionGeneration: number;
  cohortReceiptSha256: string;
  catalogEntryReceiptSha256: string;
  catalogReceiptSha256: string;
  writeOperationSha256: string;
  failureCommitReceiptSha256: string;
  usageIdSha256: string;
  billingRootSha256: string;
  retainedBillingFactSha256: string;
  planReceiptSha256: string;
  operationalUsagePlanRootSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  sourceHighWaterDbMs: number;
  /** In-transaction pre-DELETE evidence time, not a physical completion or COMMIT timestamp. */
  releasedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantTelemetryRetainedSourceUsageReleaseReceipt
  extends TenantTelemetryRetainedSourceIdentity, TenantTelemetryRetainedSourceSafety {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_RECEIPT_SCOPE;
  planBuildGeneration: number;
  executionGeneration: number;
  cohortReceiptSha256: string;
  catalogReceiptSha256: string;
  planReceiptSha256: string;
  operationalUsagePlanRootSha256: string;
  operationalUsageAckReceiptSha256: string;
  localCutoverReceiptSha256: string;
  entryCount: number;
  entryRootSha256: string;
  retainedBillingFactCount: number;
  retainedBillingFactRootSha256: string;
  sourceHighWaterDbMs: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  receiptSha256: string;
}

/** Captured before canonical DELETE; final T3f/0039/grave aggregate hashes are downstream. */
export interface TenantTelemetryRetainedSourceCanonicalClosureEntry
  extends TenantTelemetryRetainedSourceIdentity {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_ENTRY_SCOPE;
  planBuildGeneration: number;
  executionGeneration: number;
  databasePurgeGeneration: number;
  cohortReceiptSha256: string;
  catalogReceiptSha256: string;
  catalogEntryReceiptSha256: string;
  usageReleaseReceiptSha256: string;
  usageReleaseEntryReceiptSha256: string;
  writeOperationSha256: string;
  failureCommitReceiptSha256: string;
  sourceBindingReceiptSha256: string;
  membershipSha256: string;
  sourceSessionRefSha256: string;
  sourceTurnRefSha256: string;
  sourceItemRefSha256: string;
  sourceStepIndex: number;
  sourceEventSeq: number;
  beginLastSeq: number;
  endLastSeq: number;
  eventCount: number;
  eventRootSha256: string;
  businessBatchSha256: string;
  canonicalItemSha256: string;
  canonicalOwnerProofSha256: string;
  ownerBindingSha256: string;
  ownerClosureEntryReceiptSha256: string;
  sessionGraveMarkerSha256: string;
  preDeleteReceiptSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  sourceHighWaterDbMs: number;
  capturedAtDbMs: number;
  receiptSha256: string;
}

export interface TenantTelemetryRetainedSourceCanonicalClosureReceipt
  extends TenantTelemetryRetainedSourceIdentity, TenantTelemetryRetainedSourceSafety {
  scope: typeof TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_RECEIPT_SCOPE;
  planBuildGeneration: number;
  executionGeneration: number;
  databasePurgeGeneration: number;
  cohortReceiptSha256: string;
  catalogReceiptSha256: string;
  usageReleaseReceiptSha256: string;
  planReceiptSha256: string;
  localPhysicalAckReceiptSha256: string;
  preDeleteReceiptSha256: string;
  t3fReceiptSha256: string;
  ownerClosureReceiptSha256: string;
  graveMarkerRootSha256: string;
  entryCount: number;
  entryRootSha256: string;
  sourceHighWaterDbMs: number;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  receiptSha256: string;
}

/** Read-only capability. Evidence is written only by trusted T1/T3d/T3e/T3f transactions. */
export interface TenantTelemetryRetainedSourceStore {
  getTenantTelemetryRetainedSourceT1CohortEntries(tenantId: string, requestId: string):
    Promise<readonly TenantTelemetryRetainedSourceT1CohortEntry[]>;
  getTenantTelemetryRetainedSourceT1CohortReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryRetainedSourceT1CohortReceipt | null>;
  getTenantTelemetryRetainedSourceCatalogSourceEntries(tenantId: string, requestId: string):
    Promise<readonly TenantTelemetryRetainedSourceCatalogSourceEntry[]>;
  getTenantTelemetryRetainedSourceCatalogTargets(tenantId: string, requestId: string):
    Promise<readonly TenantTelemetryRetainedSourceCatalogEntry[]>;
  getTenantTelemetryRetainedSourceCatalogReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryRetainedSourceCatalogReceipt | null>;
  getTenantTelemetryRetainedSourceUsageReleaseEntries(tenantId: string, requestId: string):
    Promise<readonly TenantTelemetryRetainedSourceUsageReleaseEntry[]>;
  getTenantTelemetryRetainedSourceUsageReleaseReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryRetainedSourceUsageReleaseReceipt | null>;
  getTenantTelemetryRetainedSourceCanonicalClosureEntries(tenantId: string, requestId: string):
    Promise<readonly TenantTelemetryRetainedSourceCanonicalClosureEntry[]>;
  getTenantTelemetryRetainedSourceCanonicalClosureReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryRetainedSourceCanonicalClosureReceipt | null>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_KEYS = ["requestId", "tenantId", "subjectGeneration",
  "t1ProfileSha256", "t1FenceSha256"] as const;
const SAFETY_KEYS = ["executionReady", "externalAuthorityVerified", "allDomainsComplete",
  "contentPurgeExecuted"] as const;
const PRIMARY_KEYS = ["scope", "captureControlEvidenceSha256", "lifecycleControlEvidenceSha256",
  "refKeyIdSha256", "logsTargetSha256", "logsTargetReceiptSha256", "runtimeEpochSha256",
  "runtimeBindingSha256", "runtimeControlEvidenceSha256", "runtimeControlGeneration",
  "lifecycleCoverageEvidenceSha256", "captureCoverageEvidenceSha256", "lifecycleHistoryStatus",
  "captureStatus", "lifecycleActivatedAtDbMs", "captureActivatedAtDbMs",
  "lifecycleCoverageStartedAtDbMs", "captureCoverageStartedAtDbMs", "tenantCreatedAtDbMs"] as const;
const T1_ENTRY_KEYS = ["scope", ...IDENTITY_KEYS, "sourceIdentitySha256", "state",
  "writeOperationSha256", "failureCommitReceiptSha256", "sourceBindingReceiptSha256",
  "membershipSha256", "writeJobEvidenceSha256", "reservationSha256", "writeAckReceiptSha256",
  "inventorySha256", "inventoryReceiptSha256", "payloadSha256", "sourceHighWaterDbMs",
  "capturedAtDbMs"] as const;
const T1_RECEIPT_KEYS = ["scope", ...IDENTITY_KEYS, ...SAFETY_KEYS, "profile",
  "tenantLifecycleSubjectEvidenceSha256",
  "entryCount", "entryRootSha256", "writtenAckCount", "writtenAckRootSha256", "pendingCount",
  "pendingRootSha256", "reservedCount", "reservedRootSha256", "blockedCount", "blockedRootSha256",
  "unknownCount", "unknownRootSha256", "eligibility", "t1AcceptedAtDbMs", "sourceHighWaterDbMs",
  "storeDbTimestampMs"] as const;
const CATALOG_ENTRY_KEYS = ["scope", ...IDENTITY_KEYS, "planBuildGeneration", "cohortReceiptSha256",
  "domain", "source", "artifactGroupSha256", "targetSha256", "targetReceiptSha256",
  "artifactIdSha256", "artifactGeneration", "inventorySha256", "inventoryReceiptSha256",
  "writeOperationSha256", "writeJobEvidenceSha256", "reservationSha256", "writeAckReceiptSha256", "membershipSha256", "payloadSha256",
  "manifestSha256", "lifecycleCoverageEvidenceSha256", "ownerKind", "ownerRefSha256",
  "holdSubjectRefSha256", "ownerBindingSha256", "liveOwnerClaimSha256", "sourceHighWaterDbMs",
  "capturedAtDbMs"] as const;
const OBSERVED_ROW_KEYS = ["sourceKind", "sourceIdentitySha256", "sourceEvidenceSha256", "domain",
  "writeOperationSha256", "sourceHighWaterDbMs"] as const;
const CATALOG_SOURCE_KEYS = ["scope", ...IDENTITY_KEYS, ...OBSERVED_ROW_KEYS, "planBuildGeneration",
  "cohortReceiptSha256", "artifactGroupSha256", "catalogTargetEntryReceiptSha256", "classification", "capturedAtDbMs"] as const;
const CATALOG_RECEIPT_KEYS = ["scope", ...IDENTITY_KEYS, ...SAFETY_KEYS, "planBuildGeneration",
  "cohortReceiptSha256", "t3cReceiptSha256", "planReceiptSha256",
  "legacySourceAccountingReceiptSha256", "legacyTargetManifestReceiptSha256", "proofFamily", "sourceCount",
  "sourceRootSha256", "inventoryCount", "inventoryRootSha256", "writeJobCount", "writeJobRootSha256",
  "writeAckCount", "writeAckRootSha256", "membershipCount", "membershipRootSha256",
  "applicationBindingCount", "applicationBindingRootSha256", "providerSourceBindingCount", "providerSourceBindingRootSha256",
  "providerFailureCommitCount", "providerFailureCommitRootSha256", "unknownSourceCount", "unknownSourceRootSha256", "entryCount",
  "entryRootSha256", "applicationV1Count", "applicationV1RootSha256", "persistedProviderV2Count",
  "persistedProviderV2RootSha256", "logsTargetCount", "logsTargetRootSha256", "tracesTargetCount",
  "tracesTargetRootSha256", "unknownGroupCount", "unknownGroupRootSha256", "sourceHighWaterDbMs",
  "storeDbTimestampMs", "completedClaimAttempt", "completedClaimTokenSha256"] as const;
const USAGE_ENTRY_KEYS = ["scope", ...IDENTITY_KEYS, "planBuildGeneration", "executionGeneration",
  "cohortReceiptSha256", "catalogEntryReceiptSha256", "catalogReceiptSha256", "writeOperationSha256",
  "failureCommitReceiptSha256", "usageIdSha256", "billingRootSha256", "retainedBillingFactSha256",
  "planReceiptSha256", "operationalUsagePlanRootSha256", "completedClaimAttempt",
  "completedClaimTokenSha256", "sourceHighWaterDbMs", "releasedAtDbMs"] as const;
const USAGE_RECEIPT_KEYS = ["scope", ...IDENTITY_KEYS, ...SAFETY_KEYS, "planBuildGeneration",
  "executionGeneration", "cohortReceiptSha256", "catalogReceiptSha256", "planReceiptSha256",
  "operationalUsagePlanRootSha256", "operationalUsageAckReceiptSha256", "localCutoverReceiptSha256",
  "entryCount", "entryRootSha256", "retainedBillingFactCount", "retainedBillingFactRootSha256",
  "sourceHighWaterDbMs", "storeDbTimestampMs", "completedClaimAttempt", "completedClaimTokenSha256"] as const;
const CANONICAL_ENTRY_KEYS = ["scope", ...IDENTITY_KEYS, "planBuildGeneration", "executionGeneration",
  "databasePurgeGeneration", "cohortReceiptSha256", "catalogReceiptSha256", "catalogEntryReceiptSha256",
  "usageReleaseReceiptSha256", "usageReleaseEntryReceiptSha256", "writeOperationSha256",
  "failureCommitReceiptSha256", "sourceBindingReceiptSha256", "membershipSha256",
  "sourceSessionRefSha256", "sourceTurnRefSha256", "sourceItemRefSha256", "sourceStepIndex",
  "sourceEventSeq", "beginLastSeq", "endLastSeq", "eventCount", "eventRootSha256",
  "businessBatchSha256", "canonicalItemSha256", "canonicalOwnerProofSha256", "ownerBindingSha256",
  "ownerClosureEntryReceiptSha256", "sessionGraveMarkerSha256", "preDeleteReceiptSha256",
  "completedClaimAttempt", "completedClaimTokenSha256", "sourceHighWaterDbMs", "capturedAtDbMs"] as const;
const CANONICAL_RECEIPT_KEYS = ["scope", ...IDENTITY_KEYS, ...SAFETY_KEYS, "planBuildGeneration",
  "executionGeneration", "databasePurgeGeneration", "cohortReceiptSha256", "catalogReceiptSha256",
  "usageReleaseReceiptSha256", "planReceiptSha256", "localPhysicalAckReceiptSha256",
  "preDeleteReceiptSha256", "t3fReceiptSha256", "ownerClosureReceiptSha256", "graveMarkerRootSha256",
  "entryCount", "entryRootSha256", "sourceHighWaterDbMs", "storeDbTimestampMs",
  "completedClaimAttempt", "completedClaimTokenSha256"] as const;
const NULLABLE_T1_DIGESTS = ["writeOperationSha256", "failureCommitReceiptSha256",
  "sourceBindingReceiptSha256", "membershipSha256", "writeJobEvidenceSha256", "reservationSha256",
  "writeAckReceiptSha256", "inventorySha256", "inventoryReceiptSha256", "payloadSha256"] as const;

function invalid(): never { throw new TenantTelemetryRetainedSourceIntegrityError(); }
function requireValue(condition: unknown): asserts condition { if (!condition) invalid(); }
function record(value: unknown): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  for (const key of Reflect.ownKeys(value)) {
    requireValue(typeof key === "string");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(descriptor?.enumerable && "value" in descriptor);
  }
}
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  record(value);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireValue(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
}
function digest(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && SHA256.test(value));
}
function counter(value: unknown, minimum = 0): asserts value is number {
  requireValue(Number.isSafeInteger(value) && (value as number) >= minimum);
}
function fields(value: Record<string, unknown>, nullableDigests: readonly string[] = []): void {
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Sha256")) {
      if (nullableDigests.includes(key) && child === null) continue;
      digest(child);
    } else if (key.endsWith("DbMs") || key.endsWith("TimestampMs") || key.endsWith("Count")) {
      counter(child);
    } else if (key.endsWith("Generation") || key === "completedClaimAttempt") {
      counter(child, 1);
    }
  }
}
function identity(value: Record<string, unknown>): void {
  requireValue(typeof value.requestId === "string" && REQUEST_ID.test(value.requestId));
  requireValue(typeof value.tenantId === "string" && value.tenantId.length > 0
    && value.tenantId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value.tenantId));
  counter(value.subjectGeneration, 1);
  digest(value.t1ProfileSha256); digest(value.t1FenceSha256);
}
function safety(value: Record<string, unknown>): void {
  for (const key of SAFETY_KEYS) requireValue(value[key] === false);
}
function same(left: unknown, right: unknown): void {
  requireValue(tenantTelemetryRetainedSourceCanonicalJson(left) === tenantTelemetryRetainedSourceCanonicalJson(right));
}
function sameIdentity(left: TenantTelemetryRetainedSourceIdentity, right: TenantTelemetryRetainedSourceIdentity): void {
  for (const key of IDENTITY_KEYS) requireValue(left[key] === right[key]);
}
function sameFields(left: object, right: object, keys: readonly string[]): void {
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  for (const key of keys) requireValue(a[key] === b[key]);
}
function safeSum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) { counter(value); sum += value; counter(sum); }
  return sum;
}
function max(values: readonly number[]): number {
  let high = 0;
  for (const value of values) { counter(value); high = Math.max(high, value); }
  return high;
}

/** Strict JSON data only: no getter, symbol, Date, undefined, sparse slot, or non-finite value. */
export function tenantTelemetryRetainedSourceCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function visit(child: unknown, depth: number): string {
    requireValue(depth <= 64);
    if (child === null || typeof child === "string" || typeof child === "boolean") return JSON.stringify(child);
    if (typeof child === "number") { requireValue(Number.isFinite(child)); return JSON.stringify(child); }
    requireValue(typeof child === "object" && child !== null && !ancestors.has(child));
    ancestors.add(child);
    let result: string;
    if (Array.isArray(child)) {
      requireValue(Object.getPrototypeOf(child) === Array.prototype);
      const ownKeys = Reflect.ownKeys(child);
      requireValue(ownKeys.length === child.length + 1 && ownKeys.includes("length"));
      const parts: string[] = [];
      for (let index = 0; index < child.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(child, String(index));
        requireValue(descriptor?.enumerable && "value" in descriptor);
        parts.push(visit(descriptor.value, depth + 1));
      }
      result = `[${parts.join(",")}]`;
    } else {
      record(child);
      result = `{${Object.keys(child).sort().map((key) =>
        `${JSON.stringify(key)}:${visit(child[key], depth + 1)}`).join(",")}}`;
    }
    ancestors.delete(child);
    return result;
  }
  return visit(value, 0);
}
export function tenantTelemetryRetainedSourceSha256(scope: string, value: unknown): string {
  requireValue(typeof scope === "string" && /^[a-z][a-z0-9:_-]{0,191}$/.test(scope));
  return createHash("sha256").update(scope).update("\0")
    .update(tenantTelemetryRetainedSourceCanonicalJson(value)).digest("hex");
}
export function tenantTelemetryRetainedSourceReceiptSha256(value: { scope: string; receiptSha256?: string }): string {
  record(value);
  const { receiptSha256: ignored, ...body } = value; void ignored;
  return tenantTelemetryRetainedSourceSha256(body.scope, body);
}
function frozen<T>(value: T): T {
  const copy = JSON.parse(tenantTelemetryRetainedSourceCanonicalJson(value)) as T;
  function freeze(child: unknown): void {
    if (child !== null && typeof child === "object") {
      for (const nested of Object.values(child)) freeze(nested);
      Object.freeze(child);
    }
  }
  freeze(copy); return copy;
}
function checkReceipt(value: Record<string, unknown>, keys: readonly string[], scope: string,
  nullable: readonly string[] = []): void {
  closed(value, [...keys, "receiptSha256"]);
  requireValue(value.scope === scope); identity(value); fields(value, nullable);
  requireValue(value.receiptSha256 === tenantTelemetryRetainedSourceReceiptSha256(value as { scope: string }));
}
function seal<T extends { scope: string; receiptSha256: string }>(body: Omit<T, "receiptSha256">,
  validate: (value: unknown) => void): T {
  record(body);
  const value = { ...body, receiptSha256: tenantTelemetryRetainedSourceReceiptSha256(body as { scope: string }) };
  validate(value); return frozen(value as T);
}

export function buildTenantTelemetryRetainedSourcePrimaryBinding(
  body: Omit<TenantTelemetryRetainedSourcePrimaryBinding, "evidenceSha256">,
): TenantTelemetryRetainedSourcePrimaryBinding {
  closed(body, PRIMARY_KEYS);
  const value = { ...body, evidenceSha256: tenantTelemetryRetainedSourceSha256(body.scope, body) };
  validateTenantTelemetryRetainedSourcePrimaryBinding(value); return frozen(value);
}
export function validateTenantTelemetryRetainedSourcePrimaryBinding(value: unknown):
  asserts value is TenantTelemetryRetainedSourcePrimaryBinding {
  closed(value, [...PRIMARY_KEYS, "evidenceSha256"]); fields(value);
  requireValue(value.scope === TENANT_TELEMETRY_RETAINED_SOURCE_PRIMARY_SCOPE
    && value.lifecycleHistoryStatus === "complete_since_creation"
    && value.captureStatus === "capture_since_tenant_creation");
  requireValue((value.lifecycleCoverageStartedAtDbMs as number) >= (value.lifecycleActivatedAtDbMs as number)
    && (value.captureCoverageStartedAtDbMs as number) >= (value.captureActivatedAtDbMs as number)
    && (value.tenantCreatedAtDbMs as number) >= max([
      value.lifecycleActivatedAtDbMs as number, value.captureActivatedAtDbMs as number,
      value.lifecycleCoverageStartedAtDbMs as number, value.captureCoverageStartedAtDbMs as number]));
  const { evidenceSha256, ...body } = value;
  requireValue(evidenceSha256 === tenantTelemetryRetainedSourceSha256(body.scope as string, body));
}
function primaryHighWater(binding: TenantTelemetryRetainedSourcePrimaryBinding): number {
  return max([binding.lifecycleActivatedAtDbMs, binding.captureActivatedAtDbMs,
    binding.lifecycleCoverageStartedAtDbMs, binding.captureCoverageStartedAtDbMs, binding.tenantCreatedAtDbMs]);
}
export function tenantTelemetryRetainedSourceEmptyLegacyRootSha256(identityValue: Pick<
  TenantTelemetryRetainedSourceIdentity, "requestId" | "tenantId" | "subjectGeneration" | "t1FenceSha256">): string {
  return tenantTelemetryRetainedSourceLegacyFailedItemRootSha256(identityValue, []);
}
export function tenantTelemetryRetainedSourceLegacyFailedItemRootSha256(identityValue: Pick<
  TenantTelemetryRetainedSourceIdentity, "requestId" | "tenantId" | "subjectGeneration" | "t1FenceSha256">,
  itemEvidenceSha256s: readonly string[]): string {
  requireValue(typeof identityValue.requestId === "string" && REQUEST_ID.test(identityValue.requestId)
    && typeof identityValue.tenantId === "string" && identityValue.tenantId.length > 0
    && identityValue.tenantId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(identityValue.tenantId));
  counter(identityValue.subjectGeneration, 1); digest(identityValue.t1FenceSha256);
  const values = [...itemEvidenceSha256s]; digestRoot("tenant-telemetry-retained-source-legacy-set-check-v1", values);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-legacy-failed-root-v1",
    [identityValue.requestId, identityValue.tenantId, identityValue.subjectGeneration, identityValue.t1FenceSha256, values.sort()]);
}
export function tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId: string, operationSha256: string): string {
  requireValue(typeof tenantId === "string" && tenantId.length > 0 && tenantId.length <= 128); digest(operationSha256);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-managed-operation-v1", [tenantId, operationSha256]);
}
export function tenantTelemetryRetainedSourceOrphanIdentitySha256(tenantId: string,
  sourceKind: TenantTelemetryRetainedSourceRawKind, sourceIdentitySha256: string): string {
  requireValue(typeof tenantId === "string" && tenantId.length > 0 && tenantId.length <= 128
    && TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS.includes(sourceKind)); digest(sourceIdentitySha256);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-orphan-v1", [tenantId, sourceKind, sourceIdentitySha256]);
}
export interface TenantTelemetryRetainedSourceLegacyFailedItem {
  tenantId: string;
  userId: string;
  item: Item;
  classification: null | "runtime_unknown";
  controlGeneration: null | 0;
}
export function tenantTelemetryRetainedSourceLegacyFailedItemSha256(value: TenantTelemetryRetainedSourceLegacyFailedItem): string {
  closed(value, ["tenantId", "userId", "item", "classification", "controlGeneration"]);
  requireValue(typeof value.tenantId === "string" && value.tenantId.length > 0 && value.tenantId.length <= 128
    && typeof value.userId === "string" && value.userId.length > 0 && value.userId.length <= 128
    && value.item.type === "agentMessage" && value.item.status === "failed"
    && (value.classification === null || value.classification === "runtime_unknown")
    && (value.controlGeneration === null || value.controlGeneration === 0));
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-legacy-failed-item-v1", value);
}
export interface TenantTelemetryRetainedSourceControlProjection {
  captureState: "inactive" | "active";
  captureControlGeneration: 0 | 1;
  captureControlEvidenceSha256: string | null;
  lifecycleControlEvidenceSha256: string | null;
  refKeyIdSha256: string | null;
  logsTargetSha256: string | null;
  logsTargetReceiptSha256: string | null;
  runtimeState: "inactive" | "primary" | "restored";
  runtimeControlGeneration: number;
  runtimeControlEvidenceSha256: string | null;
  runtimeEpochSha256: string | null;
  runtimeBindingSha256: string | null;
}
export function tenantTelemetryRetainedSourceControlProjectionSha256(value: TenantTelemetryRetainedSourceControlProjection): string {
  closed(value, ["captureState", "captureControlGeneration", "captureControlEvidenceSha256", "lifecycleControlEvidenceSha256",
    "refKeyIdSha256", "logsTargetSha256", "logsTargetReceiptSha256", "runtimeState", "runtimeControlGeneration",
    "runtimeControlEvidenceSha256", "runtimeEpochSha256", "runtimeBindingSha256"]);
  for (const [key, child] of Object.entries(value)) if (key.endsWith("Sha256") && child !== null) digest(child);
  counter(value.runtimeControlGeneration);
  requireValue((value.captureState === "inactive" && value.captureControlGeneration === 0 && value.captureControlEvidenceSha256 === null)
    || (value.captureState === "active" && value.captureControlGeneration === 1 && value.captureControlEvidenceSha256 !== null));
  if (value.captureState === "active") {
    for (const key of ["lifecycleControlEvidenceSha256", "refKeyIdSha256", "logsTargetSha256", "logsTargetReceiptSha256"] as const) digest(value[key]);
  }
  requireValue(value.runtimeState === "inactive" || value.runtimeState === "primary" || value.runtimeState === "restored");
  if (value.runtimeState === "inactive") requireValue(value.runtimeControlGeneration === 0
    && value.runtimeEpochSha256 === null && value.runtimeBindingSha256 === null && value.runtimeControlEvidenceSha256 === null);
  else { counter(value.runtimeControlGeneration, 1); digest(value.runtimeEpochSha256); digest(value.runtimeBindingSha256); digest(value.runtimeControlEvidenceSha256); }
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-control-projection-v1", value);
}
export interface TenantTelemetryRetainedSourceProfileObservations {
  lifecycleHistoryStatus: "complete_since_creation" | "legacy_history_unknown" | null;
  captureStatus: "capture_since_tenant_creation" | "capture_since_cutover" | null;
  legacyFailedItemCount: number | null;
  runtimeState: "inactive" | "primary" | "restored";
  restorePending: boolean;
}
/** Diagnostic derivation from valid audited projections, not permission to accept corrupt control. */
export function deriveTenantTelemetryRetainedSourceBlockedReasons(value: TenantTelemetryRetainedSourceProfileObservations):
  TenantTelemetryRetainedSourceBlockReason[] {
  closed(value, ["lifecycleHistoryStatus", "captureStatus", "legacyFailedItemCount", "runtimeState", "restorePending"]);
  requireValue(["complete_since_creation", "legacy_history_unknown", null].includes(value.lifecycleHistoryStatus)
    && ["capture_since_tenant_creation", "capture_since_cutover", null].includes(value.captureStatus)
    && ["inactive", "primary", "restored"].includes(value.runtimeState) && typeof value.restorePending === "boolean");
  if (value.legacyFailedItemCount !== null) counter(value.legacyFailedItemCount);
  const reasons = new Set<TenantTelemetryRetainedSourceBlockReason>();
  if (value.lifecycleHistoryStatus === null || value.captureStatus === null) reasons.add("coverage_missing");
  if (value.lifecycleHistoryStatus === "legacy_history_unknown" || value.captureStatus === "capture_since_cutover") reasons.add("legacy_tenant");
  if (value.lifecycleHistoryStatus !== "complete_since_creation" || value.captureStatus !== "capture_since_tenant_creation") reasons.add("coverage_not_creation_complete");
  if (value.legacyFailedItemCount === null) reasons.add("legacy_history_unproven");
  else if (value.legacyFailedItemCount > 0) reasons.add("legacy_failed_items");
  if (value.runtimeState !== "primary") reasons.add("runtime_not_primary");
  if (value.restorePending) reasons.add("restore_pending");
  return [...reasons].sort();
}
export function validateTenantTelemetryRetainedSourceT1Profile(value: unknown):
  asserts value is TenantTelemetryRetainedSourceT1Profile {
  record(value);
  if (value.kind === "eligible-primary") {
    closed(value, ["kind", "primaryBinding", "legacyFailedItemCount", "legacyFailedItemRootSha256"]);
    validateTenantTelemetryRetainedSourcePrimaryBinding(value.primaryBinding);
    requireValue(value.legacyFailedItemCount === 0); digest(value.legacyFailedItemRootSha256);
  } else {
    closed(value, ["kind", "controlProjectionSha256", "lifecycleCoverageEvidenceSha256", "captureCoverageEvidenceSha256",
      "runtimeEpochSha256", "runtimeBindingSha256", "legacyFailedItemCount", "legacyFailedItemRootSha256",
      "observedHighWaterDbMs", "reasons"]);
    requireValue(value.kind === "blocked-source"); digest(value.controlProjectionSha256);
    for (const key of ["lifecycleCoverageEvidenceSha256", "captureCoverageEvidenceSha256",
      "runtimeEpochSha256", "runtimeBindingSha256", "legacyFailedItemRootSha256"] as const) {
      if (value[key] !== null) digest(value[key]);
    }
    requireValue((value.runtimeEpochSha256 === null) === (value.runtimeBindingSha256 === null)
      && (value.legacyFailedItemCount === null) === (value.legacyFailedItemRootSha256 === null));
    if (value.legacyFailedItemCount !== null) counter(value.legacyFailedItemCount);
    counter(value.observedHighWaterDbMs);
    requireValue(Array.isArray(value.reasons) && value.reasons.length > 0);
    let prior = "";
    for (const reason of value.reasons) {
      requireValue((TENANT_TELEMETRY_RETAINED_SOURCE_BLOCK_REASONS as readonly unknown[]).includes(reason)
        && typeof reason === "string" && reason > prior); prior = reason;
    }
    tenantTelemetryRetainedSourceCanonicalJson(value);
  }
}
export function tenantTelemetryRetainedSourceT1ProfileSha256(profile: TenantTelemetryRetainedSourceT1Profile): string {
  validateTenantTelemetryRetainedSourceT1Profile(profile);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-t1-profile-v1", profile);
}
function profileHighWater(profile: TenantTelemetryRetainedSourceT1Profile): number {
  return profile.kind === "eligible-primary" ? primaryHighWater(profile.primaryBinding) : profile.observedHighWaterDbMs;
}
export function validateTenantTelemetryRetainedSourceT1CohortEntry(value: unknown):
  asserts value is TenantTelemetryRetainedSourceT1CohortEntry {
  record(value); checkReceipt(value, T1_ENTRY_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_T1_ENTRY_SCOPE, NULLABLE_T1_DIGESTS);
  requireValue((TENANT_TELEMETRY_RETAINED_SOURCE_COHORT_STATES as readonly unknown[]).includes(value.state));
  requireValue((value.capturedAtDbMs as number) >= (value.sourceHighWaterDbMs as number));
  if (value.writeOperationSha256 !== null) requireValue(value.sourceIdentitySha256
    === tenantTelemetryRetainedSourceManagedOperationIdentitySha256(value.tenantId as string, value.writeOperationSha256 as string));
  if (value.state !== "unknown") {
    for (const key of ["writeOperationSha256", "failureCommitReceiptSha256", "sourceBindingReceiptSha256",
      "membershipSha256", "writeJobEvidenceSha256", "payloadSha256"] as const) digest(value[key]);
  }
  if (value.state === "written_ack") {
    for (const key of NULLABLE_T1_DIGESTS) digest(value[key]);
  } else if (value.state !== "unknown") {
    requireValue(value.writeAckReceiptSha256 === null && value.inventoryReceiptSha256 === null);
    if (value.state === "pending") requireValue(value.reservationSha256 === null);
    if (value.state === "reserved") digest(value.reservationSha256);
  }
}
export function buildTenantTelemetryRetainedSourceT1CohortEntry(
  body: Omit<TenantTelemetryRetainedSourceT1CohortEntry, "receiptSha256">,
): TenantTelemetryRetainedSourceT1CohortEntry {
  closed(body, T1_ENTRY_KEYS);
  return seal<TenantTelemetryRetainedSourceT1CohortEntry>(body, validateTenantTelemetryRetainedSourceT1CohortEntry);
}

type RootEntry = { receiptSha256: string };
function root(scope: string, entries: readonly RootEntry[], key: (entry: RootEntry) => string): string {
  requireValue(Array.isArray(entries));
  const seen = new Set<string>();
  const pairs = entries.map((entry) => {
    const id = key(entry); digest(id); digest(entry.receiptSha256);
    requireValue(!seen.has(id)); seen.add(id); return [id, entry.receiptSha256];
  }).sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
  return tenantTelemetryRetainedSourceSha256(scope, pairs);
}
export function tenantTelemetryRetainedSourceT1CohortRootSha256(
  entries: readonly TenantTelemetryRetainedSourceT1CohortEntry[], state?: TenantTelemetryRetainedSourceCohortState,
): string {
  requireValue(state === undefined || TENANT_TELEMETRY_RETAINED_SOURCE_COHORT_STATES.includes(state));
  for (const entry of entries) validateTenantTelemetryRetainedSourceT1CohortEntry(entry);
  return root(`tenant-telemetry-retained-source-t1-${state ?? "all"}-root-v1`,
    state === undefined ? entries : entries.filter((entry) => entry.state === state),
    (entry) => (entry as TenantTelemetryRetainedSourceT1CohortEntry).sourceIdentitySha256);
}
export function validateTenantTelemetryRetainedSourceT1CohortReceipt(value: unknown):
  asserts value is TenantTelemetryRetainedSourceT1CohortReceipt {
  record(value); checkReceipt(value, T1_RECEIPT_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_T1_RECEIPT_SCOPE); safety(value);
  validateTenantTelemetryRetainedSourceT1Profile(value.profile);
  requireValue(value.t1ProfileSha256 === tenantTelemetryRetainedSourceT1ProfileSha256(value.profile));
  if (value.profile.legacyFailedItemCount === 0) requireValue(value.profile.legacyFailedItemRootSha256
    === tenantTelemetryRetainedSourceEmptyLegacyRootSha256(value as unknown as TenantTelemetryRetainedSourceIdentity));
  const pending = safeSum([value.pendingCount as number, value.reservedCount as number,
    value.blockedCount as number, value.unknownCount as number]);
  requireValue(value.entryCount === safeSum([value.writtenAckCount as number, pending])
    && value.eligibility === (value.profile.kind === "eligible-primary" && pending === 0 ? "eligible_retained" : "blocked_source")
    && (value.sourceHighWaterDbMs as number) >= profileHighWater(value.profile)
    && (value.storeDbTimestampMs as number) >= max([value.sourceHighWaterDbMs as number,
      value.t1AcceptedAtDbMs as number]));
}
export function validateTenantTelemetryRetainedSourceT1CohortProof(
  receipt: TenantTelemetryRetainedSourceT1CohortReceipt,
  entries: readonly TenantTelemetryRetainedSourceT1CohortEntry[],
  expectedProfile: TenantTelemetryRetainedSourceT1Profile,
): void {
  validateTenantTelemetryRetainedSourceT1CohortReceipt(receipt);
  validateTenantTelemetryRetainedSourceT1Profile(expectedProfile); same(receipt.profile, expectedProfile);
  const operations = new Set<string>();
  for (const entry of entries) {
    validateTenantTelemetryRetainedSourceT1CohortEntry(entry); sameIdentity(entry, receipt);
    requireValue(entry.capturedAtDbMs === receipt.storeDbTimestampMs);
    if (entry.writeOperationSha256 !== null) {
      requireValue(!operations.has(entry.writeOperationSha256)); operations.add(entry.writeOperationSha256);
    }
  }
  requireValue(receipt.entryCount === entries.length
    && receipt.entryRootSha256 === tenantTelemetryRetainedSourceT1CohortRootSha256(entries)
    && receipt.sourceHighWaterDbMs === max([profileHighWater(receipt.profile), ...entries.map((entry) => entry.sourceHighWaterDbMs)]));
  for (const [state, prefix] of [["written_ack", "writtenAck"], ["pending", "pending"],
    ["reserved", "reserved"], ["blocked", "blocked"], ["unknown", "unknown"]] as const) {
    const counts = receipt as unknown as Record<string, unknown>;
    requireValue(counts[`${prefix}Count`] === entries.filter((entry) => entry.state === state).length
      && counts[`${prefix}RootSha256`] === tenantTelemetryRetainedSourceT1CohortRootSha256(entries, state));
  }
}
export function buildTenantTelemetryRetainedSourceT1CohortReceipt(
  body: Omit<TenantTelemetryRetainedSourceT1CohortReceipt, "receiptSha256">,
  entries: readonly TenantTelemetryRetainedSourceT1CohortEntry[],
): TenantTelemetryRetainedSourceT1CohortReceipt {
  closed(body, T1_RECEIPT_KEYS);
  const value = seal<TenantTelemetryRetainedSourceT1CohortReceipt>(body, validateTenantTelemetryRetainedSourceT1CohortReceipt);
  validateTenantTelemetryRetainedSourceT1CohortProof(value, entries, value.profile); return value;
}

export interface TenantTelemetryRetainedSourceLegacyCatalogAnchors {
  job: TenantPurgePlanJobRecord;
  planReceipt: TenantPurgePlanReceipt;
  sourceEntries: readonly TenantTelemetrySourceAccountingEntry[];
  sourceReceipt: TenantTelemetrySourceAccountingReceipt;
  manifestEntries: readonly TenantTelemetryTargetManifestEntry[];
  manifestReceipt: TenantTelemetryTargetManifestReceipt;
}
export interface TenantTelemetryRetainedSourceCatalogProof {
  cohortReceipt: TenantTelemetryRetainedSourceT1CohortReceipt;
  cohortEntries: readonly TenantTelemetryRetainedSourceT1CohortEntry[];
  expectedProfile: TenantTelemetryRetainedSourceT1Profile;
  failureReceipts: readonly PersistedProviderStepFailureCommitReceipt[];
  applicationV1Targets: readonly TenantTelemetryPlanArtifactTarget[];
  /** All seven physical row kinds from the same locked snapshot, including unknown/orphan rows. */
  observedSourceRows: readonly TenantTelemetryRetainedSourceObservedRow[];
  /** Independently read old proof objects; self-projection of the new catalog is not provenance. */
  legacyAnchors: TenantTelemetryRetainedSourceLegacyCatalogAnchors;
}
function uniqueMap<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  requireValue(Array.isArray(values));
  const result = new Map<string, T>();
  for (const value of values) { const id = key(value); digest(id); requireValue(!result.has(id)); result.set(id, value); }
  return result;
}
function digestRoot(scope: string, values: readonly string[]): string {
  const unique = new Set<string>();
  for (const value of values) { digest(value); requireValue(!unique.has(value)); unique.add(value); }
  return tenantTelemetryRetainedSourceSha256(scope, [...unique].sort());
}
export function tenantTelemetryRetainedSourceUnknownGroupRootSha256(values: readonly string[]): string {
  return digestRoot("tenant-telemetry-retained-source-unknown-group-root-v1", values);
}
export function validateTenantTelemetryRetainedSourceObservedRow(value: unknown):
  asserts value is TenantTelemetryRetainedSourceObservedRow {
  closed(value, OBSERVED_ROW_KEYS); observedRowFields(value);
}
function observedRowFields(value: Record<string, unknown>): void {
  // This helper is also used on a closed catalog-source entry. Validate only the
  // observed-row projection; its nullable catalog links were checked separately.
  digest(value.sourceIdentitySha256); digest(value.sourceEvidenceSha256);
  counter(value.sourceHighWaterDbMs);
  if (value.writeOperationSha256 !== null) digest(value.writeOperationSha256);
  requireValue((TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS as readonly unknown[]).includes(value.sourceKind)
    && (value.domain === "logs" || value.domain === "traces"));
  if (value.sourceKind === "provider_source_binding" || value.sourceKind === "provider_failure_commit") requireValue(value.domain === "logs");
  if (value.sourceKind !== "inventory") requireValue(value.writeOperationSha256 !== null
    && value.sourceIdentitySha256 === value.writeOperationSha256);
}
export function validateTenantTelemetryRetainedSourceCatalogSourceEntry(value: unknown):
  asserts value is TenantTelemetryRetainedSourceCatalogSourceEntry {
  record(value); checkReceipt(value, CATALOG_SOURCE_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_SOURCE_SCOPE,
    ["writeOperationSha256", "artifactGroupSha256", "catalogTargetEntryReceiptSha256"]);
  observedRowFields(value);
  requireValue(value.classification === "accounted" || value.classification === "unknown");
  if (value.classification === "accounted") {
    digest(value.writeOperationSha256); digest(value.artifactGroupSha256); digest(value.catalogTargetEntryReceiptSha256);
  } else {
    requireValue(value.catalogTargetEntryReceiptSha256 === null);
    if (value.artifactGroupSha256 !== null) {
      // Unknown groups can be counted together only through independently
      // derived raw operation/orphan identity, never a caller-chosen digest.
      const expectedGroup = value.writeOperationSha256 === null
        ? tenantTelemetryRetainedSourceOrphanIdentitySha256(value.tenantId as string,
          "inventory", value.sourceIdentitySha256 as string)
        : tenantTelemetryRetainedSourceManagedOperationIdentitySha256(value.tenantId as string,
          value.writeOperationSha256 as string);
      requireValue(value.artifactGroupSha256 === expectedGroup);
    }
  }
  requireValue((value.capturedAtDbMs as number) >= (value.sourceHighWaterDbMs as number));
}
export function buildTenantTelemetryRetainedSourceCatalogSourceEntry(
  body: Omit<TenantTelemetryRetainedSourceCatalogSourceEntry, "receiptSha256">,
): TenantTelemetryRetainedSourceCatalogSourceEntry {
  closed(body, CATALOG_SOURCE_KEYS);
  return seal<TenantTelemetryRetainedSourceCatalogSourceEntry>(body, validateTenantTelemetryRetainedSourceCatalogSourceEntry);
}
function observedKey(row: Pick<TenantTelemetryRetainedSourceObservedRow, "sourceKind" | "sourceIdentitySha256">): string {
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-physical-row-key-v1",
    [row.sourceKind, row.sourceIdentitySha256]);
}
export function tenantTelemetryRetainedSourceCatalogSourceRootSha256(
  entries: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[],
  subset?: TenantTelemetryRetainedSourceRawKind | "unknown",
): string {
  requireValue(subset === undefined || subset === "unknown" || TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS.includes(subset));
  for (const entry of entries) validateTenantTelemetryRetainedSourceCatalogSourceEntry(entry);
  return root(`tenant-telemetry-retained-source-physical-${subset ?? "all"}-root-v1`,
    subset === undefined ? entries : entries.filter((entry) => entry.sourceKind === subset || entry.classification === subset),
    (entry) => observedKey(entry as TenantTelemetryRetainedSourceCatalogSourceEntry));
}
export function tenantTelemetryRetainedSourceCatalogUnknownGroups(
  entries: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[],
): string[] {
  tenantTelemetryRetainedSourceCatalogSourceRootSha256(entries);
  return [...new Set(entries.filter((entry) => entry.classification === "unknown")
    .map((entry) => entry.artifactGroupSha256 ?? observedKey(entry)))].sort();
}
const SOURCE_COUNT_PREFIXES = [
  ["inventory", "inventory"], ["write_job", "writeJob"], ["write_ack", "writeAck"],
  ["membership", "membership"], ["application_binding", "applicationBinding"],
  ["provider_source_binding", "providerSourceBinding"], ["provider_failure_commit", "providerFailureCommit"],
] as const;
function validateCatalogSourceBijection(receipt: TenantTelemetryRetainedSourceCatalogReceipt,
  targets: readonly TenantTelemetryRetainedSourceCatalogEntry[],
  sources: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[],
  observed: readonly TenantTelemetryRetainedSourceObservedRow[]): void {
  const rows = uniqueMap(observed, (row) => { validateTenantTelemetryRetainedSourceObservedRow(row); return observedKey(row); });
  const sealed = uniqueMap(sources, (row) => { validateTenantTelemetryRetainedSourceCatalogSourceEntry(row); return observedKey(row); });
  requireValue(rows.size === sealed.size && receipt.sourceCount === sources.length);
  const targetMap = uniqueMap(targets, (entry) => entry.writeOperationSha256);
  for (const source of sources) {
    sameIdentity(source, receipt);
    requireValue(source.planBuildGeneration === receipt.planBuildGeneration
      && source.cohortReceiptSha256 === receipt.cohortReceiptSha256 && source.capturedAtDbMs === receipt.storeDbTimestampMs);
    const row = rows.get(observedKey(source)); requireValue(row !== undefined); sameFields(source, row, OBSERVED_ROW_KEYS);
    const target = source.writeOperationSha256 === null ? undefined : targetMap.get(source.writeOperationSha256);
    if (source.classification === "accounted") {
      requireValue(target !== undefined && source.domain === target.domain
        && source.artifactGroupSha256 === target.artifactGroupSha256
        && source.catalogTargetEntryReceiptSha256 === target.receiptSha256);
      const evidence = source.sourceKind === "inventory" ? target.inventoryReceiptSha256
        : source.sourceKind === "write_job" ? target.writeJobEvidenceSha256
        : source.sourceKind === "write_ack" ? target.writeAckReceiptSha256
        : source.sourceKind === "membership" ? target.membershipSha256
        : source.sourceKind === "application_binding" && target.source.kind === "application-v1" ? target.source.applicationBindingReceiptSha256
        : source.sourceKind === "provider_source_binding" && target.source.kind === "persisted-provider-v2" ? target.source.sourceBindingReceiptSha256
        : source.sourceKind === "provider_failure_commit" && target.source.kind === "persisted-provider-v2" ? target.source.failureCommitReceiptSha256 : null;
      requireValue(evidence !== null && source.sourceEvidenceSha256 === evidence
        && source.sourceIdentitySha256 === (source.sourceKind === "inventory" ? target.inventorySha256 : target.writeOperationSha256));
    } else requireValue(target === undefined);
  }
  for (const target of targets) {
    const members = sources.filter((source) => source.writeOperationSha256 === target.writeOperationSha256);
    const wanted: readonly TenantTelemetryRetainedSourceRawKind[] = target.source.kind === "application-v1"
      ? ["inventory", "write_job", "write_ack", "membership", "application_binding"]
      : ["inventory", "write_job", "write_ack", "membership", "provider_source_binding", "provider_failure_commit"];
    requireValue(members.length === wanted.length && wanted.every((kind) => members.filter((source) => source.sourceKind === kind).length === 1));
  }
  const unknownGroups = tenantTelemetryRetainedSourceCatalogUnknownGroups(sources);
  requireValue(receipt.sourceRootSha256 === tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources)
    && receipt.unknownSourceCount === sources.filter((source) => source.classification === "unknown").length
    && receipt.unknownSourceRootSha256 === tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources, "unknown")
    && receipt.unknownGroupCount === unknownGroups.length
    && receipt.unknownGroupRootSha256 === tenantTelemetryRetainedSourceUnknownGroupRootSha256(unknownGroups));
  const counts = receipt as unknown as Record<string, unknown>;
  for (const [kind, prefix] of SOURCE_COUNT_PREFIXES) {
    requireValue(counts[`${prefix}Count`] === sources.filter((source) => source.sourceKind === kind).length
      && counts[`${prefix}RootSha256`] === tenantTelemetryRetainedSourceCatalogSourceRootSha256(sources, kind));
  }
}
export function validateTenantTelemetryRetainedSourceCatalogEntry(value: unknown):
  asserts value is TenantTelemetryRetainedSourceCatalogEntry {
  record(value); checkReceipt(value, CATALOG_ENTRY_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE);
  requireValue(value.domain === "logs" || value.domain === "traces");
  requireValue(value.ownerKind === "tenant" || value.ownerKind === "user" || value.ownerKind === "session");
  requireValue(value.artifactGroupSha256 === tenantTelemetryTargetManifestArtifactGroupSha256(
    value.tenantId as string, value.domain, value.inventorySha256 as string));
  requireValue((value.capturedAtDbMs as number) >= (value.sourceHighWaterDbMs as number));
  record(value.source);
  if (value.source.kind === "application-v1") {
    closed(value.source, ["kind", "applicationBindingReceiptSha256", "applicationCoverageEvidenceSha256", "sourceGroupRootSha256"]);
  } else {
    requireValue(value.source.kind === "persisted-provider-v2" && value.domain === "logs" && value.ownerKind === "session");
    closed(value.source, ["kind", "failureCommitReceiptSha256", "sourceBindingReceiptSha256",
      "captureCoverageEvidenceSha256", "cohortEntryReceiptSha256"]);
  }
  fields(value.source);
}
export function buildTenantTelemetryRetainedSourceCatalogEntry(
  body: Omit<TenantTelemetryRetainedSourceCatalogEntry, "receiptSha256">,
): TenantTelemetryRetainedSourceCatalogEntry {
  closed(body, CATALOG_ENTRY_KEYS);
  return seal<TenantTelemetryRetainedSourceCatalogEntry>(body, validateTenantTelemetryRetainedSourceCatalogEntry);
}
export function tenantTelemetryRetainedSourceCatalogRootSha256(
  entries: readonly TenantTelemetryRetainedSourceCatalogEntry[],
  subset?: "application-v1" | "persisted-provider-v2" | "logs" | "traces",
): string {
  requireValue(subset === undefined || ["application-v1", "persisted-provider-v2", "logs", "traces"].includes(subset));
  for (const entry of entries) validateTenantTelemetryRetainedSourceCatalogEntry(entry);
  return root(`tenant-telemetry-retained-source-catalog-${subset ?? "all"}-root-v1`,
    subset === undefined ? entries : entries.filter((entry) => entry.source.kind === subset || entry.domain === subset),
    (entry) => (entry as TenantTelemetryRetainedSourceCatalogEntry).artifactGroupSha256);
}
/** The existing plan target-root codec remains authoritative for the public logs/traces root. */
export function tenantTelemetryRetainedSourceCatalogPlanTargets(
  entries: readonly TenantTelemetryRetainedSourceCatalogEntry[], domain: "logs" | "traces",
): { domain: "logs" | "traces"; targetSha256: string; artifactIdSha256: string;
  artifactGeneration: number; inventoryReceiptSha256: string; writeAckReceiptSha256: string }[] {
  requireValue(domain === "logs" || domain === "traces");
  tenantTelemetryRetainedSourceCatalogRootSha256(entries);
  return entries.filter((entry) => entry.domain === domain).map((entry) => ({ domain,
    targetSha256: entry.targetSha256, artifactIdSha256: entry.artifactIdSha256,
    artifactGeneration: entry.artifactGeneration, inventoryReceiptSha256: entry.inventoryReceiptSha256,
    writeAckReceiptSha256: entry.writeAckReceiptSha256 }));
}
export function validateTenantTelemetryRetainedSourceCatalogReceipt(value: unknown):
  asserts value is TenantTelemetryRetainedSourceCatalogReceipt {
  record(value); checkReceipt(value, CATALOG_RECEIPT_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_RECEIPT_SCOPE); safety(value);
  requireValue(value.proofFamily === TENANT_TELEMETRY_RETAINED_SOURCE_PROTOCOL
    && value.sourceCount === safeSum([value.inventoryCount as number, value.writeJobCount as number,
      value.writeAckCount as number, value.membershipCount as number, value.applicationBindingCount as number,
      value.providerSourceBindingCount as number, value.providerFailureCommitCount as number])
    && (value.unknownSourceCount as number) <= (value.sourceCount as number)
    && value.entryCount === safeSum([value.applicationV1Count as number, value.persistedProviderV2Count as number])
    && value.entryCount === safeSum([value.logsTargetCount as number, value.tracesTargetCount as number])
    && (value.storeDbTimestampMs as number) >= (value.sourceHighWaterDbMs as number));
}
const TARGET_MATCH_KEYS = ["domain", "artifactGroupSha256", "targetSha256", "targetReceiptSha256",
  "artifactIdSha256", "artifactGeneration", "inventorySha256", "inventoryReceiptSha256", "writeOperationSha256",
  "writeAckReceiptSha256", "membershipSha256", "payloadSha256", "manifestSha256",
  "lifecycleCoverageEvidenceSha256", "ownerKind", "ownerRefSha256", "holdSubjectRefSha256",
  "ownerBindingSha256", "liveOwnerClaimSha256"] as const;
function validateLegacyCatalogAnchors(receipt: TenantTelemetryRetainedSourceCatalogReceipt,
  proof: TenantTelemetryRetainedSourceCatalogProof): void {
  const legacy = proof.legacyAnchors;
  closed(legacy, ["job", "planReceipt", "sourceEntries", "sourceReceipt", "manifestEntries", "manifestReceipt"]);
  const { job, planReceipt, sourceEntries, sourceReceipt, manifestEntries, manifestReceipt } = legacy;
  validateTenantPurgePlanJobRecord(job); validateTenantPurgePlanReceipt(planReceipt);
  sameFields(job, planReceipt, ["requestId", "tenantId", "subjectGeneration", "buildGeneration", "t1FenceSha256",
    "t3aReceiptSha256", "t3bReceiptSha256", "t3cReceiptSha256", "policyVersion", "policySha256", "policySchemaVersion",
    "retentionAnchorDbMs", "purgeNotBeforeDbMs", "sourceEvidenceDbMs", "planEntryCount", "planEntryRootSha256",
    "blockerCount", "blockerRootSha256", "completedClaimAttempt", "completedClaimTokenSha256"]);
  validateTenantTelemetrySourceAccountingProof(job, planReceipt, sourceEntries, sourceReceipt);
  validateTenantTelemetryTargetManifestProof({ job, planReceipt, sourceEntries, sourceReceipt,
    entries: manifestEntries, receipt: manifestReceipt });
  sameFields(receipt, planReceipt, ["requestId", "tenantId", "subjectGeneration", "t1FenceSha256",
    "completedClaimAttempt", "completedClaimTokenSha256"]);
  requireValue(receipt.planBuildGeneration === planReceipt.buildGeneration
    && receipt.planReceiptSha256 === planReceipt.receiptSha256 && receipt.t3cReceiptSha256 === planReceipt.t3cReceiptSha256
    && receipt.legacySourceAccountingReceiptSha256 === sourceReceipt.receiptSha256
    && receipt.legacyTargetManifestReceiptSha256 === manifestReceipt.receiptSha256
    && sourceReceipt.storeDbTimestampMs === receipt.storeDbTimestampMs
    && manifestReceipt.storeDbTimestampMs === receipt.storeDbTimestampMs);
  const observed = uniqueMap(proof.observedSourceRows.filter((row) =>
    (TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).includes(row.sourceKind)), (row) => {
    validateTenantTelemetryRetainedSourceObservedRow(row); return observedKey(row);
  });
  const oldRows = uniqueMap(sourceEntries, (row) => observedKey(row));
  requireValue(observed.size === oldRows.size);
  for (const source of sourceEntries) {
    const row = observed.get(observedKey(source)); requireValue(row !== undefined);
    sameFields(source, row, ["sourceKind", "sourceIdentitySha256", "writeOperationSha256", "domain", "sourceEvidenceSha256"]);
    requireValue(source.capturedAtDbMs === receipt.storeDbTimestampMs);
  }
}
export function validateTenantTelemetryRetainedSourceCatalogProof(
  receipt: TenantTelemetryRetainedSourceCatalogReceipt,
  entries: readonly TenantTelemetryRetainedSourceCatalogEntry[],
  sources: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[], proof: TenantTelemetryRetainedSourceCatalogProof,
): void {
  validateTenantTelemetryRetainedSourceCatalogReceipt(receipt);
  validateLegacyCatalogAnchors(receipt, proof);
  validateTenantTelemetryRetainedSourceT1CohortProof(proof.cohortReceipt, proof.cohortEntries, proof.expectedProfile);
  sameIdentity(receipt, proof.cohortReceipt);
  requireValue(receipt.cohortReceiptSha256 === proof.cohortReceipt.receiptSha256);
  const eligible = proof.cohortReceipt.eligibility === "eligible_retained";
  const binding = proof.expectedProfile.kind === "eligible-primary" ? proof.expectedProfile.primaryBinding : null;
  const cohort = uniqueMap(proof.cohortEntries.filter((entry) => entry.writeOperationSha256 !== null), (entry) => entry.writeOperationSha256!);
  const failures = uniqueMap(proof.failureReceipts, (failure) => {
    validatePersistedProviderFailureCommitReceipt(failure); return failure.writeOperationSha256;
  });
  // Ineligible footprints may contain orphan bindings/receipts; the seven-row bijection below
  // captures them as unknown. They must never be upgraded to a target by a later ACK.
  if (eligible) requireValue(failures.size === cohort.size);
  const legacy = uniqueMap(proof.applicationV1Targets, (target) => {
    validateTenantTelemetryPlanArtifactTarget(target); return target.writeOperationSha256;
  });
  const operations = uniqueMap(entries, (entry) => entry.writeOperationSha256);
  requireValue(operations.size === (eligible ? cohort.size : 0) + legacy.size && receipt.entryCount === entries.length);
  for (const entry of entries) {
    validateTenantTelemetryRetainedSourceCatalogEntry(entry); sameIdentity(entry, receipt);
    requireValue(entry.planBuildGeneration === receipt.planBuildGeneration
      && entry.cohortReceiptSha256 === receipt.cohortReceiptSha256 && entry.capturedAtDbMs === receipt.storeDbTimestampMs);
    if (entry.source.kind === "application-v1") {
      const target = legacy.get(entry.writeOperationSha256); requireValue(target !== undefined);
      sameFields(entry, target, ["requestId", "tenantId", "subjectGeneration", ...TARGET_MATCH_KEYS]);
      requireValue(target.buildGeneration === entry.planBuildGeneration
        && entry.source.applicationBindingReceiptSha256 === target.applicationBindingReceiptSha256
        && entry.source.applicationCoverageEvidenceSha256 === target.applicationCoverageEvidenceSha256
        && entry.source.sourceGroupRootSha256 === target.sourceGroupRootSha256
        && entry.sourceHighWaterDbMs >= target.capturedAtDbMs);
      const manifests = proof.legacyAnchors.manifestEntries.filter((manifest) =>
        manifest.writeOperationSha256 === target.writeOperationSha256);
      requireValue(manifests.length === TENANT_TELEMETRY_SOURCE_KINDS.length);
      for (const manifest of manifests) {
        requireValue(manifest.classification === "accounted" && manifest.groupObservedTargetCount === 1
          && manifest.observedTargetSha256 === target.targetSha256
          && manifest.groupSourceRootSha256 === target.sourceGroupRootSha256);
        sameFields(manifest, target, ["requestId", "tenantId", "subjectGeneration", "buildGeneration", "domain",
          "artifactGroupSha256", "inventorySha256", "writeOperationSha256", "artifactIdSha256", "artifactGeneration",
          "ownerKind", "ownerRefSha256", "holdSubjectRefSha256", "ownerBindingSha256", "liveOwnerClaimSha256"]);
      }
    } else {
      const frozenEntry = cohort.get(entry.writeOperationSha256), failure = failures.get(entry.writeOperationSha256);
      requireValue(eligible && binding !== null && frozenEntry !== undefined && failure !== undefined && frozenEntry.state === "written_ack");
      requireValue(entry.source.cohortEntryReceiptSha256 === frozenEntry.receiptSha256
        && entry.source.failureCommitReceiptSha256 === frozenEntry.failureCommitReceiptSha256
        && entry.source.failureCommitReceiptSha256 === failure.receiptSha256
        && entry.source.sourceBindingReceiptSha256 === frozenEntry.sourceBindingReceiptSha256
        && entry.source.sourceBindingReceiptSha256 === failure.bindingReceiptSha256
        && entry.source.captureCoverageEvidenceSha256 === binding.captureCoverageEvidenceSha256
        && entry.lifecycleCoverageEvidenceSha256 === binding.lifecycleCoverageEvidenceSha256
        && entry.inventorySha256 === frozenEntry.inventorySha256 && entry.inventoryReceiptSha256 === frozenEntry.inventoryReceiptSha256
        && entry.writeJobEvidenceSha256 === frozenEntry.writeJobEvidenceSha256 && entry.reservationSha256 === frozenEntry.reservationSha256
        && entry.writeAckReceiptSha256 === frozenEntry.writeAckReceiptSha256 && entry.membershipSha256 === frozenEntry.membershipSha256
        && entry.membershipSha256 === failure.membershipSha256 && entry.payloadSha256 === frozenEntry.payloadSha256
        && entry.payloadSha256 === failure.payloadSha256 && failure.tenantId === receipt.tenantId
        && failure.captureControlEvidenceSha256 === binding.captureControlEvidenceSha256
        && failure.runtimeEpochSha256 === binding.runtimeEpochSha256
        && failure.runtimeBindingSha256 === binding.runtimeBindingSha256
        && entry.targetSha256 === binding.logsTargetSha256
        && entry.targetReceiptSha256 === binding.logsTargetReceiptSha256
        && frozenEntry.sourceHighWaterDbMs >= failure.committedAtDbMs
        && entry.sourceHighWaterDbMs >= frozenEntry.capturedAtDbMs);
    }
  }
  requireValue(receipt.entryRootSha256 === tenantTelemetryRetainedSourceCatalogRootSha256(entries)
    && receipt.applicationV1Count === legacy.size && receipt.persistedProviderV2Count === (eligible ? cohort.size : 0)
    && receipt.applicationV1RootSha256 === tenantTelemetryRetainedSourceCatalogRootSha256(entries, "application-v1")
    && receipt.persistedProviderV2RootSha256 === tenantTelemetryRetainedSourceCatalogRootSha256(entries, "persisted-provider-v2")
    && receipt.logsTargetCount === entries.filter((entry) => entry.domain === "logs").length
    && receipt.tracesTargetCount === entries.filter((entry) => entry.domain === "traces").length
    && receipt.sourceHighWaterDbMs === max([proof.cohortReceipt.storeDbTimestampMs,
      ...entries.map((entry) => entry.sourceHighWaterDbMs), ...sources.map((entry) => entry.sourceHighWaterDbMs)]));
  validateCatalogSourceBijection(receipt, entries, sources, proof.observedSourceRows);
  // logs/traces roots use the published plan target-root function, not a new root domain.
  // The caller also compares those roots with the independent original plan receipt.
  requireValue(receipt.logsTargetRootSha256 === tenantTelemetryDispositionInventoryTargetRootSha256(
    "logs", tenantTelemetryRetainedSourceCatalogPlanTargets(entries, "logs"))
    && receipt.tracesTargetRootSha256 === tenantTelemetryDispositionInventoryTargetRootSha256(
      "traces", tenantTelemetryRetainedSourceCatalogPlanTargets(entries, "traces")));
}
export function buildTenantTelemetryRetainedSourceCatalogReceipt(
  body: Omit<TenantTelemetryRetainedSourceCatalogReceipt, "receiptSha256">,
  entries: readonly TenantTelemetryRetainedSourceCatalogEntry[],
  sources: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[], proof: TenantTelemetryRetainedSourceCatalogProof,
): TenantTelemetryRetainedSourceCatalogReceipt {
  closed(body, CATALOG_RECEIPT_KEYS);
  const value = seal<TenantTelemetryRetainedSourceCatalogReceipt>(body, validateTenantTelemetryRetainedSourceCatalogReceipt);
  validateTenantTelemetryRetainedSourceCatalogProof(value, entries, sources, proof); return value;
}

export function validateTenantTelemetryRetainedSourceUsageReleaseEntry(value: unknown):
  asserts value is TenantTelemetryRetainedSourceUsageReleaseEntry {
  record(value); checkReceipt(value, USAGE_ENTRY_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_ENTRY_SCOPE);
  requireValue((value.releasedAtDbMs as number) >= (value.sourceHighWaterDbMs as number));
}
export function buildTenantTelemetryRetainedSourceUsageReleaseEntry(
  body: Omit<TenantTelemetryRetainedSourceUsageReleaseEntry, "receiptSha256">,
): TenantTelemetryRetainedSourceUsageReleaseEntry {
  closed(body, USAGE_ENTRY_KEYS);
  return seal<TenantTelemetryRetainedSourceUsageReleaseEntry>(body, validateTenantTelemetryRetainedSourceUsageReleaseEntry);
}
export function tenantTelemetryRetainedSourceUsageReleaseRootSha256(
  entries: readonly TenantTelemetryRetainedSourceUsageReleaseEntry[],
): string {
  for (const entry of entries) validateTenantTelemetryRetainedSourceUsageReleaseEntry(entry);
  uniqueMap(entries, (entry) => entry.usageIdSha256);
  return root("tenant-telemetry-retained-source-usage-all-root-v1", entries,
    (entry) => (entry as TenantTelemetryRetainedSourceUsageReleaseEntry).writeOperationSha256);
}
export function tenantTelemetryRetainedSourceRetainedBillingRootSha256(
  entries: readonly TenantTelemetryRetainedSourceUsageReleaseEntry[],
): string {
  tenantTelemetryRetainedSourceUsageReleaseRootSha256(entries);
  uniqueMap(entries, (entry) => entry.retainedBillingFactSha256);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-retained-billing-root-v1",
    [...entries].sort((a, b) => a.usageIdSha256 < b.usageIdSha256 ? -1 : a.usageIdSha256 > b.usageIdSha256 ? 1 : 0)
      .map((entry) => [entry.usageIdSha256, entry.retainedBillingFactSha256]));
}
export function validateTenantTelemetryRetainedSourceUsageReleaseReceipt(value: unknown):
  asserts value is TenantTelemetryRetainedSourceUsageReleaseReceipt {
  record(value); checkReceipt(value, USAGE_RECEIPT_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_USAGE_RECEIPT_SCOPE); safety(value);
  requireValue(value.entryCount === value.retainedBillingFactCount
    && (value.storeDbTimestampMs as number) >= (value.sourceHighWaterDbMs as number));
}

export function validateTenantTelemetryRetainedSourceCanonicalClosureEntry(value: unknown):
  asserts value is TenantTelemetryRetainedSourceCanonicalClosureEntry {
  record(value); checkReceipt(value, CANONICAL_ENTRY_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_ENTRY_SCOPE);
  counter(value.beginLastSeq);
  for (const key of ["sourceStepIndex", "sourceEventSeq", "endLastSeq", "eventCount"] as const) counter(value[key], 1);
  requireValue((value.sourceEventSeq as number) > (value.beginLastSeq as number)
    && (value.sourceEventSeq as number) <= (value.endLastSeq as number)
    && value.eventCount === (value.endLastSeq as number) - (value.beginLastSeq as number)
    && (value.capturedAtDbMs as number) >= (value.sourceHighWaterDbMs as number));
}
export function buildTenantTelemetryRetainedSourceCanonicalClosureEntry(
  body: Omit<TenantTelemetryRetainedSourceCanonicalClosureEntry, "receiptSha256">,
): TenantTelemetryRetainedSourceCanonicalClosureEntry {
  closed(body, CANONICAL_ENTRY_KEYS);
  return seal<TenantTelemetryRetainedSourceCanonicalClosureEntry>(body, validateTenantTelemetryRetainedSourceCanonicalClosureEntry);
}
export function tenantTelemetryRetainedSourceCanonicalClosureRootSha256(
  entries: readonly TenantTelemetryRetainedSourceCanonicalClosureEntry[],
): string {
  for (const entry of entries) validateTenantTelemetryRetainedSourceCanonicalClosureEntry(entry);
  return root("tenant-telemetry-retained-source-canonical-all-root-v1", entries,
    (entry) => (entry as TenantTelemetryRetainedSourceCanonicalClosureEntry).writeOperationSha256);
}
export function validateTenantTelemetryRetainedSourceCanonicalClosureReceipt(value: unknown):
  asserts value is TenantTelemetryRetainedSourceCanonicalClosureReceipt {
  record(value); checkReceipt(value, CANONICAL_RECEIPT_KEYS, TENANT_TELEMETRY_RETAINED_SOURCE_CANONICAL_RECEIPT_SCOPE); safety(value);
  requireValue((value.storeDbTimestampMs as number) >= (value.sourceHighWaterDbMs as number));
}

/** Prior receipts are independently read/validated by the store in the same snapshot. */
export interface TenantTelemetryRetainedSourceUsageAnchors {
  planBuildGeneration: number;
  executionGeneration: number;
  planReceiptSha256: string;
  operationalUsagePlanRootSha256: string;
  operationalUsageAckReceiptSha256: string;
  localCutoverReceiptSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
}
export interface TenantTelemetryRetainedSourceUsageProof {
  catalogProof: TenantTelemetryRetainedSourceCatalogProof;
  catalogReceipt: TenantTelemetryRetainedSourceCatalogReceipt;
  catalogEntries: readonly TenantTelemetryRetainedSourceCatalogEntry[];
  catalogSources: readonly TenantTelemetryRetainedSourceCatalogSourceEntry[];
  retainedBillingFacts: readonly BillingUsageFact[];
  anchors: TenantTelemetryRetainedSourceUsageAnchors;
}
function billingFactProof(fact: BillingUsageFact): void {
  closed(fact, ["usageId", "tenantId", "accountingPeriod", "provider", "model", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens", "currency", "factSha256",
    ...(Object.hasOwn(fact, "costCNY") ? ["costCNY"] : [])]);
  tenantTelemetryRetainedSourceCanonicalJson(fact); assertBillingUsageFact(fact);
}
function usageAnchors(value: TenantTelemetryRetainedSourceUsageAnchors): void {
  closed(value, ["planBuildGeneration", "executionGeneration", "planReceiptSha256", "operationalUsagePlanRootSha256",
    "operationalUsageAckReceiptSha256", "localCutoverReceiptSha256", "completedClaimAttempt",
    "completedClaimTokenSha256", "storeDbTimestampMs"]); fields(value);
}
export function validateTenantTelemetryRetainedSourceUsageReleaseProof(
  receipt: TenantTelemetryRetainedSourceUsageReleaseReceipt,
  entries: readonly TenantTelemetryRetainedSourceUsageReleaseEntry[], proof: TenantTelemetryRetainedSourceUsageProof,
): void {
  validateTenantTelemetryRetainedSourceUsageReleaseReceipt(receipt); usageAnchors(proof.anchors);
  validateTenantTelemetryRetainedSourceCatalogProof(proof.catalogReceipt, proof.catalogEntries, proof.catalogSources, proof.catalogProof);
  sameIdentity(receipt, proof.catalogReceipt);
  sameFields(receipt, proof.anchors, ["planBuildGeneration", "executionGeneration", "planReceiptSha256",
    "operationalUsagePlanRootSha256", "operationalUsageAckReceiptSha256", "localCutoverReceiptSha256",
    "completedClaimAttempt", "completedClaimTokenSha256", "storeDbTimestampMs"]);
  requireValue(receipt.catalogReceiptSha256 === proof.catalogReceipt.receiptSha256
    && receipt.cohortReceiptSha256 === proof.catalogReceipt.cohortReceiptSha256
    && receipt.planReceiptSha256 === proof.catalogReceipt.planReceiptSha256
    && proof.catalogReceipt.unknownGroupCount === 0
    && proof.catalogProof.cohortReceipt.eligibility === "eligible_retained");
  const targets = uniqueMap(proof.catalogEntries.filter((entry) => entry.source.kind === "persisted-provider-v2"),
    (entry) => entry.writeOperationSha256);
  const failures = uniqueMap(proof.catalogProof.failureReceipts, (failure) => failure.writeOperationSha256);
  const facts = uniqueMap(proof.retainedBillingFacts, (fact) => {
    billingFactProof(fact); requireValue(fact.tenantId === receipt.tenantId);
    return persistedProviderCaptureSha256("tenant-telemetry-step-usage-id-v2", fact.usageId);
  });
  tenantTelemetryRetainedSourceUsageReleaseRootSha256(entries);
  requireValue(entries.length === targets.size && facts.size === targets.size && receipt.entryCount === entries.length);
  for (const entry of entries) {
    validateTenantTelemetryRetainedSourceUsageReleaseEntry(entry); sameIdentity(entry, receipt);
    sameFields(entry, receipt, ["planBuildGeneration", "executionGeneration", "cohortReceiptSha256",
      "catalogReceiptSha256", "planReceiptSha256", "operationalUsagePlanRootSha256", "completedClaimAttempt",
      "completedClaimTokenSha256"]);
    const target = targets.get(entry.writeOperationSha256), failure = failures.get(entry.writeOperationSha256);
    const fact = facts.get(entry.usageIdSha256);
    requireValue(target !== undefined && failure !== undefined && fact !== undefined);
    requireValue(entry.catalogEntryReceiptSha256 === target.receiptSha256
      && target.source.kind === "persisted-provider-v2"
      && entry.failureCommitReceiptSha256 === target.source.failureCommitReceiptSha256
      && entry.failureCommitReceiptSha256 === failure.receiptSha256
      && entry.usageIdSha256 === failure.usageIdSha256 && entry.billingRootSha256 === failure.billingRootSha256
      && entry.billingRootSha256 === persistedProviderCaptureSha256("tenant-telemetry-step-billing-v2", fact)
      && entry.retainedBillingFactSha256 === fact.factSha256
      && entry.sourceHighWaterDbMs >= max([proof.catalogReceipt.storeDbTimestampMs, failure.committedAtDbMs])
      // Immutable evidence is inserted before DELETE. The downstream aggregate retains the
      // independently read old ACK/cutover timestamp; it must not be backdated to this leaf.
      && entry.releasedAtDbMs <= receipt.storeDbTimestampMs);
  }
  requireValue(receipt.entryRootSha256 === tenantTelemetryRetainedSourceUsageReleaseRootSha256(entries)
    && receipt.retainedBillingFactRootSha256 === tenantTelemetryRetainedSourceRetainedBillingRootSha256(entries)
    && receipt.sourceHighWaterDbMs === max([proof.catalogReceipt.storeDbTimestampMs,
      ...entries.map((entry) => entry.sourceHighWaterDbMs)]));
}
export function buildTenantTelemetryRetainedSourceUsageReleaseReceipt(
  body: Omit<TenantTelemetryRetainedSourceUsageReleaseReceipt, "receiptSha256">,
  entries: readonly TenantTelemetryRetainedSourceUsageReleaseEntry[], proof: TenantTelemetryRetainedSourceUsageProof,
): TenantTelemetryRetainedSourceUsageReleaseReceipt {
  closed(body, USAGE_RECEIPT_KEYS);
  const value = seal<TenantTelemetryRetainedSourceUsageReleaseReceipt>(body, validateTenantTelemetryRetainedSourceUsageReleaseReceipt);
  validateTenantTelemetryRetainedSourceUsageReleaseProof(value, entries, proof); return value;
}

export interface TenantTelemetryRetainedSourceCanonicalAnchors {
  planBuildGeneration: number;
  executionGeneration: number;
  databasePurgeGeneration: number;
  planReceiptSha256: string;
  localPhysicalAckReceiptSha256: string;
  preDeleteReceiptSha256: string;
  t3fReceiptSha256: string;
  ownerClosureReceiptSha256: string;
  graveMarkerRootSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
}
export interface TenantTelemetryRetainedSourceCanonicalProof {
  usageProof: TenantTelemetryRetainedSourceUsageProof;
  usageReceipt: TenantTelemetryRetainedSourceUsageReleaseReceipt;
  usageEntries: readonly TenantTelemetryRetainedSourceUsageReleaseEntry[];
  ownerClosureEntries: readonly TenantTelemetryOwnerClosureEntry[];
  graveMarkers: readonly TenantPurgeSessionGraveMarker[];
  anchors: TenantTelemetryRetainedSourceCanonicalAnchors;
}
export interface TenantTelemetryRetainedSourceCanonicalSnapshot {
  writeOperationSha256: string;
  item: Item;
  events: readonly PersistedEvent[];
}
export function tenantTelemetryRetainedSourceCanonicalItemSha256(item: Item): string {
  requireValue(item.type === "agentMessage" && item.status === "failed");
  counter(item.seq, 1);
  return tenantTelemetryRetainedSourceSha256("tenant-telemetry-retained-source-canonical-item-v1", item);
}
/** Before DELETE only. Historical validators do not call this with invented/missing snapshots. */
export function validateTenantTelemetryRetainedSourceCanonicalSnapshot(
  entry: TenantTelemetryRetainedSourceCanonicalClosureEntry,
  snapshot: TenantTelemetryRetainedSourceCanonicalSnapshot,
  failure: PersistedProviderStepFailureCommitReceipt,
): void {
  validateTenantTelemetryRetainedSourceCanonicalClosureEntry(entry);
  closed(snapshot, ["writeOperationSha256", "item", "events"]);
  validatePersistedProviderFailureCommitReceipt(failure);
  sameFields(entry, failure, ["sourceSessionRefSha256", "sourceTurnRefSha256", "sourceItemRefSha256",
    "sourceStepIndex", "sourceEventSeq", "beginLastSeq", "endLastSeq", "eventCount", "eventRootSha256", "businessBatchSha256"]);
  requireValue(snapshot.writeOperationSha256 === entry.writeOperationSha256
    && snapshot.writeOperationSha256 === failure.writeOperationSha256
    && entry.failureCommitReceiptSha256 === failure.receiptSha256
    && snapshot.item.type === "agentMessage" && snapshot.item.status === "failed"
    && snapshot.item.step === failure.sourceStepIndex && snapshot.item.seq <= failure.sourceEventSeq
    && entry.canonicalItemSha256 === tenantTelemetryRetainedSourceCanonicalItemSha256(snapshot.item)
    && snapshot.events.length === failure.eventCount
    && persistedProviderCaptureEventRoot([...snapshot.events]) === failure.eventRootSha256);
  for (let index = 0; index < snapshot.events.length; index += 1) {
    const event = snapshot.events[index]!;
    requireValue(event.seq === failure.beginLastSeq + index + 1 && event.sessionId === snapshot.item.sessionId);
  }
  const completed = snapshot.events.find((event) => event.seq === failure.sourceEventSeq);
  requireValue(completed !== undefined && completed.type === "item/completed");
  same(completed.item, snapshot.item);
}
export function validateTenantTelemetryRetainedSourceCanonicalClosureProof(
  receipt: TenantTelemetryRetainedSourceCanonicalClosureReceipt,
  entries: readonly TenantTelemetryRetainedSourceCanonicalClosureEntry[], proof: TenantTelemetryRetainedSourceCanonicalProof,
): void {
  validateTenantTelemetryRetainedSourceCanonicalClosureReceipt(receipt);
  closed(proof.anchors, ["planBuildGeneration", "executionGeneration", "databasePurgeGeneration", "planReceiptSha256",
    "localPhysicalAckReceiptSha256", "preDeleteReceiptSha256", "t3fReceiptSha256", "ownerClosureReceiptSha256",
    "graveMarkerRootSha256", "completedClaimAttempt", "completedClaimTokenSha256", "storeDbTimestampMs"]);
  fields(proof.anchors);
  validateTenantTelemetryRetainedSourceUsageReleaseProof(proof.usageReceipt, proof.usageEntries, proof.usageProof);
  sameIdentity(receipt, proof.usageReceipt);
  sameFields(receipt, proof.anchors, ["planBuildGeneration", "executionGeneration", "databasePurgeGeneration", "planReceiptSha256",
    "localPhysicalAckReceiptSha256", "preDeleteReceiptSha256", "t3fReceiptSha256", "ownerClosureReceiptSha256",
    "graveMarkerRootSha256", "completedClaimAttempt", "completedClaimTokenSha256", "storeDbTimestampMs"]);
  requireValue(receipt.usageReleaseReceiptSha256 === proof.usageReceipt.receiptSha256
    && receipt.cohortReceiptSha256 === proof.usageReceipt.cohortReceiptSha256
    && receipt.catalogReceiptSha256 === proof.usageReceipt.catalogReceiptSha256
    && receipt.planReceiptSha256 === proof.usageReceipt.planReceiptSha256);
  const usage = uniqueMap(proof.usageEntries, (entry) => entry.writeOperationSha256);
  const failures = uniqueMap(proof.usageProof.catalogProof.failureReceipts, (entry) => entry.writeOperationSha256);
  const targets = uniqueMap(proof.usageProof.catalogEntries, (entry) => entry.writeOperationSha256);
  const owners = uniqueMap(proof.ownerClosureEntries, (entry) => {
    validateTenantTelemetryOwnerClosureEntry(entry); return entry.writeOperationSha256;
  });
  const graves = uniqueMap(proof.graveMarkers, (marker) => {
    validateTenantDatabasePurgeSessionGraveMarker(marker); return marker.markerSha256;
  });
  requireValue(receipt.graveMarkerRootSha256 === tenantDatabasePurgeSessionGraveMarkerRootSha256(proof.graveMarkers)
    && receipt.entryCount === entries.length && entries.length === usage.size);
  tenantTelemetryRetainedSourceCanonicalClosureRootSha256(entries);
  for (const marker of proof.graveMarkers) {
    sameFields(marker, receipt, ["requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
      "executionGeneration", "databasePurgeGeneration", "preDeleteReceiptSha256"]);
    requireValue(marker.markedAtDbMs === receipt.storeDbTimestampMs);
  }
  for (const entry of entries) {
    validateTenantTelemetryRetainedSourceCanonicalClosureEntry(entry); sameIdentity(entry, receipt);
    sameFields(entry, receipt, ["planBuildGeneration", "executionGeneration", "databasePurgeGeneration",
      "cohortReceiptSha256", "catalogReceiptSha256", "usageReleaseReceiptSha256", "preDeleteReceiptSha256",
      "completedClaimAttempt", "completedClaimTokenSha256"]);
    const released = usage.get(entry.writeOperationSha256), failure = failures.get(entry.writeOperationSha256);
    const target = targets.get(entry.writeOperationSha256), owner = owners.get(entry.writeOperationSha256);
    const grave = graves.get(entry.sessionGraveMarkerSha256);
    requireValue(released !== undefined && failure !== undefined && target !== undefined && owner !== undefined && grave !== undefined);
    sameFields(entry, failure, ["sourceSessionRefSha256", "sourceTurnRefSha256", "sourceItemRefSha256",
      "sourceStepIndex", "sourceEventSeq", "beginLastSeq", "endLastSeq", "eventCount", "eventRootSha256", "businessBatchSha256"]);
    sameFields(owner, receipt, ["requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
      "executionGeneration", "databasePurgeGeneration", "preDeleteReceiptSha256"]);
    requireValue(entry.usageReleaseEntryReceiptSha256 === released.receiptSha256
      && entry.catalogEntryReceiptSha256 === target.receiptSha256
      && entry.failureCommitReceiptSha256 === failure.receiptSha256
      && entry.sourceBindingReceiptSha256 === failure.bindingReceiptSha256
      && entry.membershipSha256 === failure.membershipSha256 && owner.ownerKind === "session");
    // Compare the independently validated 0039 owner proof, not a public T3f getter.
    const profile = proof.usageProof.catalogProof.expectedProfile;
    requireValue(profile.kind === "eligible-primary"
      && owner.refKeyIdSha256 === profile.primaryBinding.refKeyIdSha256
      && entry.membershipSha256 === owner.membershipSha256 && entry.membershipSha256 === target.membershipSha256
      && owner.inventorySha256 === target.inventorySha256 && owner.ownerRefSha256 === target.ownerRefSha256
      && owner.holdSubjectRefSha256 === target.holdSubjectRefSha256
      && entry.ownerBindingSha256 === owner.ownerBindingSha256 && entry.ownerBindingSha256 === target.ownerBindingSha256
      && entry.canonicalOwnerProofSha256 === owner.canonicalOwnerProofSha256
      && entry.ownerClosureEntryReceiptSha256 === owner.receiptSha256
      && entry.sessionGraveMarkerSha256 === owner.sessionGraveMarkerSha256
      && owner.capturedAtDbMs === receipt.storeDbTimestampMs && entry.capturedAtDbMs === receipt.storeDbTimestampMs
      && entry.sourceHighWaterDbMs >= proof.usageReceipt.storeDbTimestampMs);
  }
  requireValue(receipt.entryRootSha256 === tenantTelemetryRetainedSourceCanonicalClosureRootSha256(entries)
    && receipt.sourceHighWaterDbMs === max([proof.usageReceipt.storeDbTimestampMs,
      ...entries.map((entry) => entry.sourceHighWaterDbMs)]));
}
export function buildTenantTelemetryRetainedSourceCanonicalClosureReceipt(
  body: Omit<TenantTelemetryRetainedSourceCanonicalClosureReceipt, "receiptSha256">,
  entries: readonly TenantTelemetryRetainedSourceCanonicalClosureEntry[], proof: TenantTelemetryRetainedSourceCanonicalProof,
): TenantTelemetryRetainedSourceCanonicalClosureReceipt {
  closed(body, CANONICAL_RECEIPT_KEYS);
  const value = seal<TenantTelemetryRetainedSourceCanonicalClosureReceipt>(body, validateTenantTelemetryRetainedSourceCanonicalClosureReceipt);
  validateTenantTelemetryRetainedSourceCanonicalClosureProof(value, entries, proof); return value;
}
