import type {
  AgentDefinition,
  Approval,
  Event,
  EventInput,
  Item,
  ItemOf,
  PersistedEvent,
  ProviderConfig,
  Session,
  Turn,
  ApiKeyScope,
  TenantAuthPolicy,
  Usage,
  UsageQuery,
} from "@agent-service/protocol";
import {
  Approval as ApprovalSchema,
  DEFAULT_AUTH_POLICY,
  DEFAULT_SCOPES,
  Event as EventSchema,
  Item as ItemSchema,
  Session as SessionSchema,
  Turn as TurnSchema,
  Usage as UsageSchema,
  addUsage,
  emptyUsageAccumulator,
  isCanonicalId,
} from "@agent-service/protocol";
import { createHash } from "node:crypto";
import {
  BlobConflictError,
  BlobTooLargeError,
  FenceError,
  IdempotencyMismatchError,
  IdempotencyPendingError,
  IdempotencyReplayError,
  SessionArchivedError,
  SessionExistsError,
  SessionGoneError,
  SessionHasChildrenError,
  SessionLifecycleBusyError,
  SessionVersionError,
  assertCommitResourceOwnership,
  assertPureFenceClaim,
  assertTombstoneEvent,
  assignItemSeqs,
  assignTurnSeqEnd,
  backfillAssignedSequences,
  type BlobStore,
  type BlobDescriptor,
  type BillingUsageFact,
  type CommitBatch,
  type CommitResult,
  type EventBus,
  type EventListener,
  type IdempotencyReceipt,
  type IdempotencyReceiptValue,
  type IdempotencyScope,
  type LifecycleOutboxStore,
  type LifecycleOutboxRecord,
  type LeaseAcquireResult,
  type LeaseConflict,
  type LeaseStore,
  type Page,
  type SessionStore,
  type SessionLifecycleRecord,
  type TenantRecord,
  type UsageLifecycleStore,
  type UsageLedgerEntry,
  type UsageReconciliationRecord,
  type ReconcileSessionUsageInput,
  type AnonymizeSessionUsageInput,
} from "./types.js";
import {
  validateBlobContentType,
  validateBlobKey,
  validateBlobMaxBytes,
  validateBlobUploadToken,
} from "./blob/key.js";
import {
  assertLifecycleOutboxId,
  parseLifecycleOutboxEnvelope,
  sanitizeLifecycleOutboxError,
  validateClaimLifecycleOutboxOptions,
  validateLifecycleOutboxAck,
  validateRenewLifecycleOutboxClaim,
  validateRetryLifecycleOutboxOptions,
} from "./lifecycle-outbox.js";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  assertBlobBindingsMatch,
  blobBindingsFromItems,
  isUnexpiredStagingBlob,
  sanitizeBlobDeleteError,
  validateBlobDeleteAck,
  validateBlobDeleteClaim,
  type BindableBlobLookup,
  type BlobCleanupStore,
  type BlobDeleteOutboxRecord,
  type BlobManifest,
  type BlobManifestStore,
  type ClaimBlobDeletesOptions,
  type MarkBlobUploadedInput,
  type ReadyBlobLookup,
  type RetryBlobDeleteOptions,
  type ScheduleStaleBlobsOptions,
  type StageBlobInput,
} from "./blob-lifecycle.js";
import {
  UsageIdentityConflictError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  assertUsageAnonymizationAllowed,
  billingUsageFactContentEquals,
  billingUsageFactFromLedger,
  canonicalUsageProjection,
  canonicalizePersistedUsageEvent,
  canonicalizeUsageItem,
  isUsageId,
  newUsageId,
  normalizeHistoricalUsageCost,
  normalizeOperationalUsageCost,
  normalizeRowlessUsageProjection,
  summarizeBillingUsageFacts,
  usageReconciliationSummariesEqual,
  validateReconcileSessionUsageInput,
} from "./usage-lifecycle.js";
import {
  ErasureIdempotencyMismatchError,
  ErasureJobIntegrityFault,
  SubjectDeletingError,
  TenantErasureConflictError,
  TenantErasureIntegrityError,
  TenantErasureTargetNotFoundError,
  assertErasureClaimToken,
  classifyErasureJobRecordFault,
  deriveBlockedErasureResumePhase,
  erasureJobAllowedMaintenanceActions,
  erasureJobClaimFromRecord,
  erasureJobAuthorizationMatches,
  erasureJobControlOutcomeSha256,
  erasureJobInterventionEvidenceSha256,
  erasureJobTerminalInterventionEvidenceSha256,
  erasureJobUnsafeQuarantineEnvelopeEvidenceSha256,
  erasureWriteAuthorizationMatches,
  hasSafeErasureRequestQuarantineEnvelope,
  isErasureJobQuarantined,
  isClaimableErasureRequestStatus,
  newErasureJobIntegrityFault,
  subjectLifecycleKey,
  tenantCredentialRevocationFenceSha256,
  validateClaimErasureJobsOptions,
  validateErasureJobAuthorization,
  validateErasureAuditChain,
  validateErasureJobControlAudit,
  validateErasureJobControlEvent,
  validateErasureJobMaintenanceIdentity,
  validateErasureRequestRecord,
  validateErasureRequestRecordForRead,
  validateRepairAndResumeErasureJobInput,
  validateReplayTenantErasureInput,
  validateRequestUserErasureInput,
  validateRequestTenantErasureInput,
  validateTenantErasureAdmissionProof,
  validateTenantErasureImmutableT1Proof,
  validateTenantCredentialRevocationFence,
  validateRenewErasureJobClaimOptions,
  validateRetryErasureJobOptions,
  validateTransitionErasureJobOptions,
  type ClaimErasureJobsOptions,
  type DataSubjectKind,
  type ErasureAuditEvent,
  type ErasureJobControlEvent,
  type ErasureJobTerminalIncident,
  type ErasureJobUnsafeQuarantineEnvelope,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureJobMaintenanceIdentity,
  type ErasureJobMaintenanceStore,
  type ErasureJobStore,
  type ErasureJobQuarantineReasonCode,
  type ErasureJobInterventionInspection,
  type ErasureRequestRecord,
  type ErasureRequestStatus,
  type ErasureWriteAuthorization,
  type RequestUserErasureInput,
  type RequestTenantErasureInput,
  type ReplayTenantErasureInput,
  type RepairAndResumeErasureJobInput,
  type RetryErasureJobOptions,
  type RenewErasureJobClaimOptions,
  type SubjectLifecycleRecord,
  type SubjectLifecycleStore,
  type TenantCredentialRevocationFence,
  type TenantRuntimeState,
  type TransitionErasureJobOptions,
} from "./subject-lifecycle.js";
import {
  validateErasureSessionAction,
  type ErasureSessionAction,
  type ErasureSessionHead,
  type ErasureSessionStore,
} from "./erasure-session.js";
import {
  validateErasureProgressQuery,
  validateErasureSessionQuery,
  type ErasureProgressQuery,
  type ErasureSessionCatalogStore,
  type ErasureSessionPage,
  type ErasureSessionQuery,
  type ErasureSessionRef,
  type ErasureSubjectProgress,
} from "./erasure-catalog.js";
import {
  ErasureTombstoneIntegrityError,
  validateErasureUsageReconciliationInput,
  type ErasureUsageReconciliationInput,
  type ErasureUsageReconciliationStore,
} from "./erasure-usage.js";
import {
  LEGACY_TOMBSTONE_CUTOVER_ID,
  LegacyTombstoneChildPendingError,
  LegacyTombstoneCutoverConflictError,
  LegacyTombstoneCutoverRequiredError,
  LegacyTombstoneIntegrityFault,
  LegacyTombstoneJobConflictError,
  legacyTombstoneClaimTokenSha256,
  legacyTombstoneCompensationAuthorizationMatches,
  legacyTombstoneCompensationClaimFromRecord,
  legacyTombstoneCompensationJobIdForSession,
  legacyTombstoneSuccessEvidenceSha256,
  legacyTombstoneTerminalIncidentEvidenceSha256,
  legacyTombstoneUnsafeJobEnvelopeEvidenceSha256,
  validateActivateLegacyTombstoneCutoverInput,
  validateClaimLegacyTombstoneCompensationsOptions,
  validateCompleteLegacyTombstoneCompensationOptions,
  validateLegacyTombstoneCompensationAudit,
  validateLegacyTombstoneCompensationAuthorization,
  validateLegacyTombstoneCompensationJobRecord,
  validateLegacyTombstoneCutoverRecord,
  validateRenewLegacyTombstoneCompensationOptions,
  validateRetryLegacyTombstoneCompensationOptions,
  validateScheduleLegacyTombstoneCandidatesOptions,
  validateScheduleLegacyTombstoneCompensationInput,
  type ActivateLegacyTombstoneCutoverInput,
  type ClaimLegacyTombstoneCompensationsOptions,
  type CompleteLegacyTombstoneCompensationOptions,
  type LegacyTombstoneCompensationAudit,
  type LegacyTombstoneCompensationAuthorization,
  type LegacyTombstoneCompensationClaim,
  type LegacyTombstoneCompensationJobRecord,
  type LegacyTombstoneCompensationResult,
  type LegacyTombstoneCompensationStore,
  type LegacyTombstoneCutoverRecord,
  type LegacyTombstoneTerminalReasonCode,
  type LegacyTombstoneUnsafeJobEnvelope,
  type RenewLegacyTombstoneCompensationOptions,
  type RetryLegacyTombstoneCompensationOptions,
  type ScheduleLegacyTombstoneCandidatesOptions,
  type ScheduleLegacyTombstoneCompensationInput,
} from "./legacy-tombstone.js";
import {
  RETENTION_POLICY_SCHEMA_VERSION,
  LegalHoldConflictError,
  LegalHoldGenerationConflictError,
  LegalHoldIntegrityError,
  LegalHoldNotFoundError,
  RetentionPolicyGenerationConflictError,
  RetentionPolicyNotFoundError,
  RetentionPolicyVersionConflictError,
  compareLegalHoldIds,
  legalHoldControlAtGeneration,
  legalHoldControlSha256,
  legalHoldProjectionSha256,
  retentionPolicyControlSha256,
  retentionPolicySha256,
  validateActivateRetentionPolicyInput,
  validateLegalHoldControlRecord,
  validateLegalHoldRecord,
  validatePutRetentionPolicyInput,
  validateReleaseLegalHoldInput,
  validateRetentionPolicyControlRecord,
  validateRetentionPolicyIdentity,
  validateRetentionPolicyTenantId,
  validateRetentionPolicyVersionRecord,
  validateSetLegalHoldInput,
  type ActivateRetentionPolicyInput,
  type ActiveRetentionPolicy,
  type LegalHoldControlRecord,
  type LegalHoldEvent,
  type LegalHoldRecord,
  type PutRetentionPolicyInput,
  type ReleaseLegalHoldInput,
  type RetentionPolicyActivationEvent,
  type RetentionPolicyControlRecord,
  type RetentionPolicyStore,
  type RetentionPolicyVersionRecord,
  type SetLegalHoldInput,
} from "./retention-policy.js";
import {
  EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
  ErasurePurgeEvidenceChangedError,
  checkedRetentionDeadline,
  erasurePolicyDecisionSha256,
  erasurePolicyEvaluationAuthorizationMatches,
  erasurePurgeAuthorityMatchesDecision,
  erasurePurgeAuthoritySha256,
  erasurePurgeTargetMatchesRetentionPolicy,
  erasurePurgeTargetEvidenceSha256,
  newErasurePolicyEvaluationJob,
  nextErasurePurgeTargetRootSha256,
  validateBuildErasurePurgeTargetPageOptions,
  validateClaimErasurePolicyEvaluationsOptions,
  validateErasurePolicyEvaluationAuthorization,
  validateErasurePurgeTargetEvidence,
  validateRenewErasurePolicyEvaluationOptions,
  validateRetryErasurePolicyEvaluationOptions,
  validateScheduleAwaitingErasurePolicyEvaluationsOptions,
  validateSealErasurePurgeAuthorityOptions,
  type BuildErasurePurgeTargetPageOptions,
  type BuildErasurePurgeTargetPageResult,
  type ClaimErasurePolicyEvaluationsOptions,
  type ErasureCompletionReadiness,
  type ErasurePolicyEvaluationAuthorization,
  type ErasurePolicyEvaluationClaim,
  type ErasurePolicyEvaluationDecision,
  type ErasurePolicyEvaluationDecisionEvent,
  type ErasurePolicyEvaluationJob,
  type ErasurePolicyEvaluationSealResult,
  type ErasurePolicyEvaluationStore,
  type ErasurePurgeAuthorityControl,
  type ErasurePurgeAuthorityRecord,
  type ErasurePurgeTargetEvidence,
  type ErasurePurgeTargetIssueCode,
  type RenewErasurePolicyEvaluationOptions,
  type RetryErasurePolicyEvaluationOptions,
  type ScheduleAwaitingErasurePolicyEvaluationsOptions,
  type SealErasurePurgeAuthorityOptions,
} from "./erasure-purge-policy.js";
import {
  EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256,
  USER_DATA_EXPORT_CONTENT_TYPE,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_RECORD_KIND_ORDER,
  USER_DATA_EXPORT_SCHEMA_VERSION,
  UserDataExportIdempotencyMismatchError,
  UserDataExportIntegrityError,
  UserDataExportPolicyUnavailableError,
  UserDataExportStateError,
  canonicalUserDataExportBytes,
  canonicalUserDataExportJson,
  sanitizeExportEvent,
  sanitizeExportSession,
  sanitizeExportTurn,
  sanitizeUserDataExportError,
  nextUserDataExportSnapshotRootSha256,
  userDataExportAttachmentLogicalKey,
  userDataExportManifestSha256,
  userDataExportStorageKey,
  validateClaimUserDataExportsOptions,
  validateStartUserDataExportArtifactInput,
  validateUserDataExportAuthorization,
  validateUserDataExportRequestInput,
  validateUserDataExportRequestRecord,
  type ClaimUserDataExportDeletesOptions,
  type ClaimUserDataExportsOptions,
  type CompleteUserDataExportArtifactInput,
  type MarkUserDataExportPartUploadedInput,
  type RequestUserDataExportInput,
  type RetryUserDataExportDeleteInput,
  type RetryUserDataExportInput,
  type StageUserDataExportPartInput,
  type StartUserDataExportArtifactInput,
  type UserDataExportArtifactPart,
  type UserDataExportArtifactRecord,
  type UserDataExportAuthorization,
  type UserDataExportClaim,
  type UserDataExportCleanupStore,
  type UserDataExportDeleteOutboxRecord,
  type UserDataExportDownloadLease,
  type UserDataExportJobStore,
  type UserDataExportRequestRecord,
  type UserDataExportRequestStore,
  type UserDataExportSnapshotEntry,
  type UserDataExportSnapshotBlob,
  type UserDataExportSnapshotBlobPage,
  type UserDataExportSnapshotRecord,
  type UserDataExportSnapshotRecordPage,
  type UserDataExportSnapshotSummary,
} from "./data-export.js";
import {
  TENANT_CREDENTIAL_REVOCATION_EXTERNAL_DISPOSITION,
  TENANT_CREDENTIAL_REVOCATION_RECEIPT_SCOPE,
  TENANT_CREDENTIAL_REVOCATION_RUNTIME_DISPOSITION,
  tenantCredentialRevocationAuthorizationMatches,
  tenantCredentialRevocationClaimFromJob,
  tenantCredentialRevocationClaimTokenSha256,
  tenantCredentialRevocationCompletionMatchesAuthorization,
  tenantCredentialRevocationCutoverEvidenceSha256,
  tenantCredentialRevocationReceiptMatchesAuthorization,
  tenantCredentialRevocationReceiptSha256,
  validateClaimTenantCredentialRevocationsOptions,
  validateMaterializeTenantCredentialRevocationJobsOptions,
  validateRenewTenantCredentialRevocationOptions,
  validateRetryTenantCredentialRevocationOptions,
  validateTenantCredentialRevocationAuthorization,
  validateTenantCredentialRevocationCompletionProof,
  validateTenantCredentialRevocationCutoverRecord,
  validateTenantCredentialRevocationJobRecord,
  validateTenantCredentialRevocationReceipt,
  type ClaimTenantCredentialRevocationsOptions,
  type MaterializeTenantCredentialRevocationJobsOptions,
  type RenewTenantCredentialRevocationOptions,
  type RetryTenantCredentialRevocationOptions,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
  type TenantCredentialRevocationCutoverRecord,
  type TenantCredentialRevocationJobRecord,
  type TenantCredentialRevocationReceipt,
  type TenantCredentialRevocationStore,
} from "./tenant-credential-revocation.js";
import {
  TENANT_RUNTIME_REVOCATION_EXTERNAL_DISPOSITION,
  TENANT_RUNTIME_REVOCATION_MEMORY_DISPOSITION,
  TENANT_RUNTIME_REVOCATION_RECEIPT_SCOPE,
  tenantRuntimeRevocationAuthorizationMatches,
  tenantRuntimeRevocationClaimFromJob,
  tenantRuntimeRevocationClaimTokenSha256,
  tenantRuntimeRevocationCompletionMatchesAuthorization,
  tenantRuntimeRevocationReceiptSha256,
  tenantRuntimeRevocationTargetReceiptFromLocal,
  validateClaimTenantRuntimeRevocationsOptions,
  validateMaterializeTenantRuntimeRevocationJobsOptions,
  validateRenewTenantRuntimeRevocationOptions,
  validateRetryTenantRuntimeRevocationOptions,
  validateTenantRuntimeRevocationAuthorization,
  validateTenantRuntimeRevocationCompletionProof,
  validateTenantRuntimeRevocationCompletionReplayProof,
  validateTenantRuntimeRevocationFleetProof,
  validateTenantRuntimeRevocationJobRecord,
  type ClaimTenantRuntimeRevocationsOptions,
  type MaterializeTenantRuntimeRevocationJobsOptions,
  type RenewTenantRuntimeRevocationOptions,
  type RetryTenantRuntimeRevocationOptions,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
  type TenantRuntimeRevocationFleetProof,
  type TenantRuntimeRevocationJobRecord,
  type TenantRuntimeRevocationReceipt,
  type TenantRuntimeRevocationStore,
  type TenantRuntimeRevocationTargetReceipt,
} from "./tenant-runtime-revocation.js";
import {
  EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256,
  TENANT_CONTENT_INVENTORY_GLOBAL_ORPHAN_CHECK,
  TENANT_CONTENT_INVENTORY_RECEIPT_SCOPE,
  TENANT_SESSION_CONTENT_RECEIPT_SCOPE,
  TenantContentInventoryEvidenceChangedError,
  TenantContentInventoryNotReadyError,
  tenantContentIdentityRootSha256,
  tenantContentEventIdentityRow,
  tenantContentInventoryAuthorizationMatches,
  tenantContentInventoryClaimFromJob,
  tenantContentInventoryClaimTokenSha256,
  tenantContentInventoryHoldControlRootSha256,
  tenantContentInventoryHoldControlSha256,
  tenantContentInventoryNextSessionReceiptRootSha256,
  tenantContentInventoryReceiptMatchesAuthorization,
  tenantContentInventoryReceiptSha256,
  tenantContentInventorySessionReceiptRootSha256,
  tenantSessionContentReceiptSha256,
  tenantSessionContentRootSha256,
  tenantSessionStructuralSha256,
  validateBuildTenantContentInventoryPageOptions,
  validateClaimTenantContentInventoriesOptions,
  validateMaterializeTenantContentInventoryJobsOptions,
  validateRenewTenantContentInventoryOptions,
  validateRetryTenantContentInventoryOptions,
  validateTenantContentInventoryAuthorization,
  validateTenantContentInventoryCompletionProof,
  validateTenantContentInventoryJobRecord,
  validateTenantSessionContentReceipt,
  type BuildTenantContentInventoryPageOptions,
  type BuildTenantContentInventoryPageResult,
  type ClaimTenantContentInventoriesOptions,
  type MaterializeTenantContentInventoryJobsOptions,
  type RenewTenantContentInventoryOptions,
  type RetryTenantContentInventoryOptions,
  type TenantContentIdentityRows,
  type TenantContentInventoryAuthorization,
  type TenantContentInventoryClaim,
  type TenantContentInventoryJobRecord,
  type TenantContentInventoryReceipt,
  type TenantContentInventoryStore,
  type TenantSessionContentReceipt,
} from "./tenant-content-inventory.js";
import {
  EMPTY_TENANT_PURGE_PLAN_BLOCKER_ROOT_SHA256,
  EMPTY_TENANT_PURGE_PLAN_ENTRY_ROOT_SHA256,
  TENANT_PURGE_PLAN_DOMAINS,
  TENANT_PURGE_PLAN_ENTRY_SCOPE,
  TENANT_PURGE_PLAN_RECEIPT_SCOPE,
  TenantPurgePlanEvidenceChangedError,
  TenantPurgePlanNotReadyError,
  isTenantPurgePlanBlockingDisposition,
  tenantPurgePlanAuthorizationMatches,
  tenantPurgePlanBlockerRootSha256,
  tenantPurgePlanClaimFromJob,
  tenantPurgePlanClaimTokenSha256,
  tenantPurgePlanDomainOrdinal,
  tenantPurgePlanDomainSourceSha256,
  tenantPurgePlanEntryRootSha256,
  tenantPurgePlanEntrySha256,
  tenantPurgePlanNextBlockerRootSha256,
  tenantPurgePlanNextEntryRootSha256,
  tenantPurgePlanReceiptMatchesAuthorization,
  tenantPurgePlanReceiptSha256,
  tenantPurgePlanTargetRootSha256,
  tenantPurgePlanTargetSha256,
  validateBuildTenantPurgePlanPageOptions,
  validateClaimTenantPurgePlansOptions,
  validateMaterializeTenantPurgePlanJobsOptions,
  validateRenewTenantPurgePlanOptions,
  validateRetryTenantPurgePlanOptions,
  validateTenantPurgePlanAuthorization,
  validateTenantPurgePlanCompletionProof,
  validateTenantPurgePlanEntry,
  validateTenantPurgePlanJobRecord,
  type BuildTenantPurgePlanPageOptions,
  type BuildTenantPurgePlanPageResult,
  type ClaimTenantPurgePlansOptions,
  type MaterializeTenantPurgePlanJobsOptions,
  type RenewTenantPurgePlanOptions,
  type RetryTenantPurgePlanOptions,
  type TenantPurgePlanAuthorization,
  type TenantPurgePlanClaim,
  type TenantPurgePlanDisposition,
  type TenantPurgePlanDomain,
  type TenantPurgePlanEntry,
  type TenantPurgePlanJobRecord,
  type TenantPurgePlanReceipt,
  type TenantPurgePlanStore,
} from "./tenant-purge-plan.js";
import {
  EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
  EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
  TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
  TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE,
  TENANT_PURGE_LOCAL_CUTOVER_SCOPE,
  TENANT_PURGE_LOCAL_PHYSICAL_ACK_SCOPE,
  TenantPurgeExecutionEvidenceChangedError,
  TenantPurgeExecutionNotReadyError,
  TenantPurgeExecutionPhysicalAckDeadLetterError,
  tenantPurgeExecutionAuthorizationMatches,
  tenantPurgeExecutionClaimFromJob,
  tenantPurgeExecutionClaimTokenSha256,
  tenantPurgeExecutionCutoverEvidenceSha256,
  tenantPurgeExecutionDomainAckSha256,
  tenantPurgeExecutionNextDomainAckRootSha256,
  tenantPurgeExecutionNextGlobalAckRootSha256,
  tenantPurgeExecutionOutboxRootSha256,
  tenantPurgeExecutionOutboxTargetSha256,
  tenantPurgeExecutionOperationSha256,
  tenantPurgeExecutionPhysicalProofSha256,
  tenantPurgeExecutionResultRootSha256,
  tenantPurgeLocalCutoverReceiptSha256,
  tenantPurgeLocalPhysicalAckReceiptSha256,
  validateClaimTenantPurgeExecutionsOptions,
  validateMaterializeTenantPurgeExecutionJobsOptions,
  validateRenewTenantPurgeExecutionOptions,
  validateRetryTenantPurgeExecutionOptions,
  validateTenantPurgeExecutionAuthorization,
  validateTenantPurgeExecutionCutoverRecord,
  validateTenantPurgeExecutionDomainAck,
  validateTenantPurgeExecutionDomainRecord,
  validateTenantPurgeExecutionJobRecord,
  validateTenantPurgeLocalCutoverReceipt,
  validateTenantPurgeLocalPhysicalAckReceipt,
  type ClaimTenantPurgeExecutionsOptions,
  type MaterializeTenantPurgeExecutionJobsOptions,
  type RenewTenantPurgeExecutionOptions,
  type RetryTenantPurgeExecutionOptions,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgeExecutionBlockReasonCode,
  type TenantPurgeExecutionClaim,
  type TenantPurgeExecutionCutoverRecord,
  type TenantPurgeExecutionDomainAck,
  type TenantPurgeExecutionDomainRecord,
  type TenantPurgeExecutionJobRecord,
  type TenantPurgeExecutionOutboxReference,
  type TenantPurgeExecutionStore,
  type TenantPurgeLocalCutoverReceipt,
  type TenantPurgeLocalPhysicalAckReceipt,
} from "./tenant-purge-execution.js";

interface MemoryUserDataExportJob {
  requestId: string;
  status: "queued" | "building" | "completed" | "failed" | "revoked";
  buildGeneration: number;
  attempts: number;
  availableAtMs?: number;
  claimToken?: string;
  leaseUntilMs?: number;
  currentArtifactId?: string;
  lastErrorCode?: import("./data-export.js").UserDataExportErrorCode;
  snapshot?: UserDataExportSnapshotSummary;
  completedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** A physically revoked tenant retains registry identity but has no auth policy or secret. */
type MemoryTenantRecord = Omit<TenantRecord, "authPolicy"> & {
  authPolicy?: TenantRecord["authPolicy"];
};

const clone = <T>(v: T): T => structuredClone(v);

function cloneUserDataExportSnapshotRecord(
  record: UserDataExportSnapshotRecord,
): UserDataExportSnapshotRecord {
  return {
    ...clone(record),
    canonicalBytes: Buffer.from(record.canonicalBytes),
  };
}

function restoreMapEntry<K, V>(
  map: Map<K, V>,
  key: K,
  existed: boolean,
  previous: V | undefined,
): void {
  // Call the intrinsic methods so fault-injection wrappers on an instance's `set` cannot prevent
  // rollback of an otherwise durable-looking multi-map publication.
  if (existed) Map.prototype.set.call(map, key, previous as V);
  else Map.prototype.delete.call(map, key);
}

function restoreMapSnapshot<K, V>(map: Map<K, V>, snapshot: Map<K, V>): void {
  Map.prototype.clear.call(map);
  for (const [key, value] of snapshot) Map.prototype.set.call(map, key, value);
}

function retentionPolicyKey(tenantId: string, policyVersion: string): string {
  return JSON.stringify([tenantId, policyVersion]);
}

function agentVersionKey(tenantId: string, agentId: string, version: number): string {
  return JSON.stringify([tenantId, agentId, version]);
}

function providerConfigKey(tenantId: string, providerId: string): string {
  return JSON.stringify([tenantId, providerId]);
}

function legalHoldKey(tenantId: string, holdId: string): string {
  return JSON.stringify([tenantId, holdId]);
}

function retentionPolicyDocumentsEqual(
  left: RetentionPolicyVersionRecord["policy"],
  right: RetentionPolicyVersionRecord["policy"],
): boolean {
  return retentionPolicySha256("comparison", "comparison", left)
    === retentionPolicySha256("comparison", "comparison", right);
}

function retentionPolicyControlsEqual(
  left: RetentionPolicyControlRecord,
  right: RetentionPolicyControlRecord,
): boolean {
  return left.tenantId === right.tenantId
    && left.controlGeneration === right.controlGeneration
    && left.activePolicyVersion === right.activePolicyVersion
    && left.activePolicySha256 === right.activePolicySha256
    && left.effectiveAtMs === right.effectiveAtMs
    && left.updatedAtMs === right.updatedAtMs;
}

function legalHoldRecordsEqual(left: LegalHoldRecord, right: LegalHoldRecord): boolean {
  return left.tenantId === right.tenantId
    && left.holdId === right.holdId
    && left.subjectKind === right.subjectKind
    && left.subjectId === right.subjectId
    && left.state === right.state
    && left.reasonCode === right.reasonCode
    && left.externalReferenceSha256 === right.externalReferenceSha256
    && left.createdControlGeneration === right.createdControlGeneration
    && left.createdByKeyId === right.createdByKeyId
    && left.createdAtMs === right.createdAtMs
    && left.releasedControlGeneration === right.releasedControlGeneration
    && left.releasedByKeyId === right.releasedByKeyId
    && left.releasedAtMs === right.releasedAtMs
    && left.releaseReasonCode === right.releaseReasonCode;
}

function legalHoldControlsEqual(
  left: LegalHoldControlRecord,
  right: LegalHoldControlRecord,
): boolean {
  return left.tenantId === right.tenantId
    && left.subjectKind === right.subjectKind
    && left.subjectId === right.subjectId
    && left.controlGeneration === right.controlGeneration
    && left.activeHoldCount === right.activeHoldCount
    && left.activeProjectionSha256 === right.activeProjectionSha256
    && left.updatedAtMs === right.updatedAtMs;
}

function paginate<T>(rows: T[], key: (r: T) => string, cursor: string | undefined, limit: number, dir: "asc" | "desc"): Page<T> {
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (dir === "desc") sorted.reverse();
  const start = cursor ? sorted.findIndex((r) => key(r) === cursor) + 1 : 0;
  const slice = sorted.slice(start, start + limit);
  const last = slice.at(-1);
  return { data: slice.map(clone), nextCursor: last && start + limit < sorted.length ? key(last) : null };
}

function validateStageBlobInput(input: StageBlobInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  validateBlobKey(input.storageKey);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(input.storageBackend)) throw new Error("invalid blob storage backend");
  if (input.storageFormat !== BLOB_STORAGE_FORMAT) throw new Error("unsupported blob storage format");
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) throw new Error("invalid blob creation timestamp");
  if (!Number.isSafeInteger(input.stagingExpiresAtMs) || input.stagingExpiresAtMs <= input.createdAtMs) {
    throw new Error("blob staging expiry must be after creation");
  }
}

function validateUploadedBlobInput(input: MarkBlobUploadedInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("invalid blob sha256");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("invalid blob size");
  if (!Number.isSafeInteger(input.uploadedAtMs) || input.uploadedAtMs < 0) throw new Error("invalid blob upload timestamp");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
}

function isValidReadyPurgeBlobManifest(mapKey: string, manifest: BlobManifest): boolean {
  try {
    validateBlobKey(manifest.storageKey);
  } catch {
    return false;
  }
  return mapKey === manifest.blobId
    && isCanonicalId("blob", manifest.blobId)
    && isCanonicalId("sess", manifest.sessionId)
    && manifest.state === "ready"
    && (manifest.purpose === "input_image" || manifest.purpose === "tool_output")
    && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(manifest.storageBackend)
    && manifest.storageFormat === BLOB_STORAGE_FORMAT
    && /^[a-z0-9-]{16,64}$/.test(manifest.uploadToken)
    && manifest.itemId !== undefined
    && isCanonicalId("item", manifest.itemId)
    && manifest.sha256 !== undefined
    && /^[0-9a-f]{64}$/.test(manifest.sha256)
    && manifest.sizeBytes !== undefined
    && Number.isSafeInteger(manifest.sizeBytes)
    && manifest.sizeBytes >= 0
    && manifest.uploadedAtMs !== undefined
    && Number.isSafeInteger(manifest.uploadedAtMs)
    && manifest.uploadedAtMs >= manifest.createdAtMs
    && manifest.readyAtMs !== undefined
    && Number.isSafeInteger(manifest.readyAtMs)
    && manifest.readyAtMs >= manifest.createdAtMs
    && Number.isSafeInteger(manifest.createdAtMs)
    && manifest.createdAtMs >= 0
    && manifest.stagingExpiresAtMs === undefined
    && manifest.deleteAfterMs === undefined
    && manifest.deletedAtMs === undefined
    && manifest.deletionGeneration === 0;
}

/** In-memory store: reference semantics for tests. Single process only. */
export class MemorySessionStore implements SessionStore, LifecycleOutboxStore, BlobManifestStore, BlobCleanupStore, UsageLifecycleStore, SubjectLifecycleStore, ErasureJobStore, ErasureJobMaintenanceStore, ErasureSessionStore, ErasureSessionCatalogStore, ErasureUsageReconciliationStore, LegacyTombstoneCompensationStore, RetentionPolicyStore, ErasurePolicyEvaluationStore, UserDataExportRequestStore, UserDataExportJobStore, UserDataExportCleanupStore, TenantCredentialRevocationStore, TenantRuntimeRevocationStore, TenantContentInventoryStore, TenantPurgePlanStore, TenantPurgeExecutionStore {
  agents = new Map<string, AgentDefinition>();
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  items = new Map<string, Item>();
  approvals = new Map<string, Approval>();
  events = new Map<string, PersistedEvent[]>();
  providers = new Map<string, { config: ProviderConfig; secret?: { ciphertext: Buffer; keyId: string } }>();
  apiKeys = new Map<string, { tenantId: string; keyId: string; scopes: ApiKeyScope[]; createdAtMs?: number; revokedAtMs?: number }>();
  idem = new Map<string, { value: IdempotencyReceiptValue | null; requestHash?: string; expiresAt: number }>();
  deleted = new Map<string, { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number }>();
  lifecycleOutbox = new Map<string, LifecycleOutboxRecord>();
  private nextLifecycleOutboxId = 1;
  blobManifests = new Map<string, BlobManifest>();
  blobDeleteOutbox = new Map<string, BlobDeleteOutboxRecord>();
  private nextBlobDeleteOutboxId = 1;
  tenants = new Map<string, MemoryTenantRecord>();
  billingUsageFacts = new Map<string, BillingUsageFact>();
  usageReconciliations = new Map<string, UsageReconciliationRecord>();
  subjectLifecycles = new Map<string, SubjectLifecycleRecord>();
  erasureRequests = new Map<string, ErasureRequestRecord>();
  tenantErasureAdmissions = new Map<string, ErasureRequestRecord>();
  erasureAuditEvents = new Map<string, ErasureAuditEvent[]>();
  tenantCredentialRevocationFences = new Map<string, TenantCredentialRevocationFence>();
  tenantCredentialRevocationJobs = new Map<string, TenantCredentialRevocationJobRecord>();
  tenantCredentialRevocationReceipts = new Map<string, TenantCredentialRevocationReceipt>();
  tenantCredentialRevocationCutovers = new Map<1, TenantCredentialRevocationCutoverRecord>([[
    1,
    { singletonId: 1, controlGeneration: 0 },
  ]]);
  tenantRuntimeRevocationJobs = new Map<string, TenantRuntimeRevocationJobRecord>();
  tenantRuntimeRevocationTargetReceipts = new Map<string, TenantRuntimeRevocationTargetReceipt>();
  tenantRuntimeRevocationReceipts = new Map<string, TenantRuntimeRevocationReceipt>();
  tenantContentInventoryJobs = new Map<string, TenantContentInventoryJobRecord>();
  tenantSessionContentReceipts = new Map<string, TenantSessionContentReceipt>();
  tenantContentInventoryReceipts = new Map<string, TenantContentInventoryReceipt>();
  tenantPurgePlanJobs = new Map<string, TenantPurgePlanJobRecord>();
  tenantPurgePlanEntries = new Map<string, TenantPurgePlanEntry>();
  tenantPurgePlanReceipts = new Map<string, TenantPurgePlanReceipt>();
  tenantPurgeExecutionJobs = new Map<string, TenantPurgeExecutionJobRecord>();
  tenantPurgeExecutionDomains = new Map<string, TenantPurgeExecutionDomainRecord>();
  tenantPurgeExecutionDomainAcks = new Map<string, TenantPurgeExecutionDomainAck>();
  tenantPurgeLocalCutoverReceipts = new Map<string, TenantPurgeLocalCutoverReceipt>();
  tenantPurgeLocalPhysicalAckReceipts = new Map<string, TenantPurgeLocalPhysicalAckReceipt>();
  tenantPurgeExecutionCutovers = new Map<1, TenantPurgeExecutionCutoverRecord>([[
    TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
    { singletonId: TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID, controlGeneration: 0 },
  ]]);
  erasureJobControlEvents = new Map<string, ErasureJobControlEvent[]>();
  private nextErasureJobControlEventId = 1;
  erasureJobTerminalIncidents = new Map<string, ErasureJobTerminalIncident>();
  private nextErasureJobTerminalIncidentId = 1;
  private erasureIdempotency = new Map<string, string>();
  retentionPolicies = new Map<string, RetentionPolicyVersionRecord>();
  retentionPolicyControls = new Map<string, RetentionPolicyControlRecord>();
  retentionPolicyActivationEvents = new Map<string, RetentionPolicyActivationEvent[]>();
  private nextRetentionPolicyActivationEventId = 1;
  legalHolds = new Map<string, LegalHoldRecord>();
  legalHoldControls = new Map<string, LegalHoldControlRecord>();
  legalHoldEvents = new Map<string, LegalHoldEvent[]>();
  private nextLegalHoldEventId = 1;
  erasurePolicyEvaluationJobs = new Map<string, ErasurePolicyEvaluationJob>();
  erasurePurgeTargets = new Map<string, ErasurePurgeTargetEvidence>();
  erasurePolicyEvaluationDecisions = new Map<string, ErasurePolicyEvaluationDecisionEvent[]>();
  erasurePurgeAuthorityControls = new Map<string, ErasurePurgeAuthorityControl>();
  erasurePurgeAuthorities = new Map<string, ErasurePurgeAuthorityRecord[]>();
  legacyTombstoneCutovers = new Map<string, LegacyTombstoneCutoverRecord>();
  legacyTombstoneCompensationJobs = new Map<string, LegacyTombstoneCompensationJobRecord>();
  legacyTombstoneCompensationAudits = new Map<string, LegacyTombstoneCompensationAudit[]>();
  private nextLegacyTombstoneAuditId = 1;
  userDataExportRequests = new Map<string, UserDataExportRequestRecord>();
  userDataExportJobs = new Map<string, MemoryUserDataExportJob>();
  userDataExportArtifacts = new Map<string, UserDataExportArtifactRecord>();
  userDataExportParts = new Map<string, UserDataExportArtifactPart>();
  userDataExportSnapshotRecords = new Map<string, UserDataExportSnapshotRecord[]>();
  userDataExportSnapshotBlobs = new Map<string, UserDataExportSnapshotBlob[]>();
  userDataExportDeleteOutbox = new Map<string, UserDataExportDeleteOutboxRecord>();
  userDataExportDownloadLeases = new Map<string, {
    artifactId: string;
    requestId: string;
    tenantId: string;
    userId: string;
    leaseToken: string;
    leaseUntilMs: number;
    createdAtMs: number;
  }>();
  private userDataExportIdempotency = new Map<string, string>();
  private nextUserDataExportDeleteOutboxId = 1;

  constructor(private readonly storeClock: { now(): number } = { now: () => Date.now() }) {}

  private storeNowMs(): number {
    const nowMs = this.storeClock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error("memory store clock must return a non-negative safe integer");
    }
    return nowMs;
  }

  private initialRetentionPolicyControl(tenantId: string): RetentionPolicyControlRecord {
    const control: RetentionPolicyControlRecord = {
      tenantId,
      controlGeneration: 0,
      updatedAtMs: 0,
    };
    validateRetentionPolicyControlRecord(control);
    return control;
  }

  private assertRetentionPolicyState(tenantId: string): {
    control: RetentionPolicyControlRecord;
    events: RetentionPolicyActivationEvent[];
    active: RetentionPolicyVersionRecord | null;
  } {
    const storedControl = this.retentionPolicyControls.get(tenantId);
    const storedEvents = this.retentionPolicyActivationEvents.get(tenantId) ?? [];
    const initial = this.initialRetentionPolicyControl(tenantId);
    if (!storedControl) {
      if (storedEvents.length !== 0) {
        throw new Error("retention policy activation audit exists without its control row");
      }
      return { control: initial, events: [], active: null };
    }
    validateRetentionPolicyControlRecord(storedControl);
    if (storedControl.tenantId !== tenantId) {
      throw new Error("retention policy control tenant is corrupt");
    }

    let reconstructed = initial;
    let previousEventId = 0;
    for (const [index, event] of storedEvents.entries()) {
      if (
        !Number.isSafeInteger(event.eventId)
        || event.eventId <= previousEventId
        || event.tenantId !== tenantId
        || event.controlGeneration !== index + 1
        || event.effectiveAtMs !== event.emittedAtMs
      ) throw new Error("retention policy activation audit is corrupt");
      previousEventId = event.eventId;
      validateActivateRetentionPolicyInput({
        tenantId: event.tenantId,
        policyVersion: event.policyVersion,
        expectedControlGeneration: event.controlGeneration - 1,
        actorKeyId: event.actorKeyId,
        atMs: event.emittedAtMs,
      });
      if (event.emittedAtMs < reconstructed.updatedAtMs) {
        throw new Error("retention policy activation time regressed");
      }
      const version = this.retentionPolicies.get(retentionPolicyKey(tenantId, event.policyVersion));
      if (!version) throw new Error("retention policy activation references a missing version");
      validateRetentionPolicyVersionRecord(version);
      if (
        version.tenantId !== tenantId
        || version.policyVersion !== event.policyVersion
        || version.policySha256 !== event.policySha256
        || event.beforeSha256 !== retentionPolicyControlSha256(reconstructed)
      ) throw new Error("retention policy activation audit does not match its version or prior state");
      const next: RetentionPolicyControlRecord = {
        tenantId,
        controlGeneration: event.controlGeneration,
        activePolicyVersion: event.policyVersion,
        activePolicySha256: event.policySha256,
        effectiveAtMs: event.effectiveAtMs,
        updatedAtMs: event.emittedAtMs,
      };
      validateRetentionPolicyControlRecord(next);
      if (event.afterSha256 !== retentionPolicyControlSha256(next)) {
        throw new Error("retention policy activation audit does not match its outcome");
      }
      reconstructed = next;
    }
    if (
      storedEvents.length !== storedControl.controlGeneration
      || !retentionPolicyControlsEqual(storedControl, reconstructed)
    ) throw new Error("retention policy activation audit does not match its control row");
    if (storedControl.controlGeneration === 0) {
      return { control: clone(storedControl), events: storedEvents.map(clone), active: null };
    }
    const active = this.retentionPolicies.get(retentionPolicyKey(
      tenantId,
      storedControl.activePolicyVersion!,
    ));
    if (!active) throw new Error("active retention policy version is missing");
    validateRetentionPolicyVersionRecord(active);
    if (active.policySha256 !== storedControl.activePolicySha256) {
      throw new Error("active retention policy hash does not match its control row");
    }
    return {
      control: clone(storedControl),
      events: storedEvents.map(clone),
      active: clone(active),
    };
  }

  async putRetentionPolicy(input: PutRetentionPolicyInput): Promise<RetentionPolicyVersionRecord> {
    const stagedInput = clone(input);
    validatePutRetentionPolicyInput(stagedInput);
    this.assertTenantWritable(stagedInput.tenantId);
    const key = retentionPolicyKey(stagedInput.tenantId, stagedInput.policyVersion);
    const existing = this.retentionPolicies.get(key);
    if (existing) {
      validateRetentionPolicyVersionRecord(existing);
      if (
        existing.tenantId === stagedInput.tenantId
        && existing.policyVersion === stagedInput.policyVersion
        && retentionPolicyDocumentsEqual(existing.policy, stagedInput.policy)
      ) return clone(existing);
      throw new RetentionPolicyVersionConflictError(stagedInput.policyVersion);
    }
    const record = clone<RetentionPolicyVersionRecord>({
      tenantId: stagedInput.tenantId,
      policyVersion: stagedInput.policyVersion,
      schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
      policy: stagedInput.policy,
      policySha256: retentionPolicySha256(
        stagedInput.tenantId,
        stagedInput.policyVersion,
        stagedInput.policy,
      ),
      createdByKeyId: stagedInput.actorKeyId,
      createdAtMs: stagedInput.atMs,
    });
    validateRetentionPolicyVersionRecord(record);
    const existed = this.retentionPolicies.has(key);
    const prior = this.retentionPolicies.get(key);
    try {
      this.retentionPolicies.set(key, record);
    } catch (error) {
      restoreMapEntry(this.retentionPolicies, key, existed, prior);
      throw error;
    }
    return clone(record);
  }

  async getRetentionPolicy(
    tenantId: string,
    policyVersion: string,
  ): Promise<RetentionPolicyVersionRecord | null> {
    validateRetentionPolicyIdentity(tenantId, policyVersion);
    const key = retentionPolicyKey(tenantId, policyVersion);
    const record = this.retentionPolicies.get(key);
    if (!record) return null;
    validateRetentionPolicyVersionRecord(record);
    if (record.tenantId !== tenantId || record.policyVersion !== policyVersion) {
      throw new Error("retention policy index is corrupt");
    }
    return clone(record);
  }

  async activateRetentionPolicy(
    input: ActivateRetentionPolicyInput,
  ): Promise<RetentionPolicyControlRecord> {
    const stagedInput = clone(input);
    validateActivateRetentionPolicyInput(stagedInput);
    this.assertTenantWritable(stagedInput.tenantId);
    const policy = this.retentionPolicies.get(retentionPolicyKey(
      stagedInput.tenantId,
      stagedInput.policyVersion,
    ));
    if (!policy) throw new RetentionPolicyNotFoundError(stagedInput.policyVersion);
    validateRetentionPolicyVersionRecord(policy);
    const state = this.assertRetentionPolicyState(stagedInput.tenantId);
    const current = state.control;
    const sameActive = current.activePolicyVersion === policy.policyVersion
      && current.activePolicySha256 === policy.policySha256;
    if (sameActive) {
      if (stagedInput.expectedControlGeneration === current.controlGeneration) return clone(current);
      const tail = state.events.at(-1);
      if (
        stagedInput.expectedControlGeneration + 1 === current.controlGeneration
        && tail?.controlGeneration === current.controlGeneration
        && tail.policyVersion === stagedInput.policyVersion
        && tail.policySha256 === policy.policySha256
      ) return clone(current);
    }
    if (stagedInput.expectedControlGeneration !== current.controlGeneration) {
      throw new RetentionPolicyGenerationConflictError(
        stagedInput.expectedControlGeneration,
        current.controlGeneration,
      );
    }
    if (current.controlGeneration >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error("retention policy control generation is exhausted");
    }
    const effectiveAtMs = Math.max(stagedInput.atMs, current.updatedAtMs);
    const next = clone<RetentionPolicyControlRecord>({
      tenantId: stagedInput.tenantId,
      controlGeneration: current.controlGeneration + 1,
      activePolicyVersion: policy.policyVersion,
      activePolicySha256: policy.policySha256,
      effectiveAtMs,
      updatedAtMs: effectiveAtMs,
    });
    validateRetentionPolicyControlRecord(next);
    if (
      !Number.isSafeInteger(this.nextRetentionPolicyActivationEventId)
      || this.nextRetentionPolicyActivationEventId <= 0
    ) throw new Error("retention policy activation event sequence is exhausted");
    const event = clone<RetentionPolicyActivationEvent>({
      eventId: this.nextRetentionPolicyActivationEventId,
      tenantId: stagedInput.tenantId,
      controlGeneration: next.controlGeneration,
      policyVersion: policy.policyVersion,
      policySha256: policy.policySha256,
      effectiveAtMs,
      actorKeyId: stagedInput.actorKeyId,
      beforeSha256: retentionPolicyControlSha256(current),
      afterSha256: retentionPolicyControlSha256(next),
      emittedAtMs: effectiveAtMs,
    });
    const nextEvents = clone([...state.events, event]);

    const controlExisted = this.retentionPolicyControls.has(stagedInput.tenantId);
    const priorControl = this.retentionPolicyControls.get(stagedInput.tenantId);
    const eventsExisted = this.retentionPolicyActivationEvents.has(stagedInput.tenantId);
    const priorEvents = this.retentionPolicyActivationEvents.get(stagedInput.tenantId);
    try {
      this.retentionPolicyControls.set(stagedInput.tenantId, next);
      this.retentionPolicyActivationEvents.set(stagedInput.tenantId, nextEvents);
    } catch (error) {
      restoreMapEntry(
        this.retentionPolicyActivationEvents,
        stagedInput.tenantId,
        eventsExisted,
        priorEvents,
      );
      restoreMapEntry(
        this.retentionPolicyControls,
        stagedInput.tenantId,
        controlExisted,
        priorControl,
      );
      throw error;
    }
    this.nextRetentionPolicyActivationEventId += 1;
    return clone(next);
  }

  async getActiveRetentionPolicy(tenantId: string): Promise<ActiveRetentionPolicy | null> {
    validateRetentionPolicyTenantId(tenantId);
    const state = this.assertRetentionPolicyState(tenantId);
    if (!state.active) return null;
    return clone({ control: state.control, policy: state.active });
  }

  async listRetentionPolicyActivationEvents(
    tenantId: string,
  ): Promise<RetentionPolicyActivationEvent[]> {
    validateRetentionPolicyTenantId(tenantId);
    return this.assertRetentionPolicyState(tenantId).events.map(clone);
  }

  private initialLegalHoldControl(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): LegalHoldControlRecord {
    const control: LegalHoldControlRecord = {
      tenantId,
      subjectKind,
      subjectId,
      controlGeneration: 0,
      activeHoldCount: 0,
      activeProjectionSha256: legalHoldProjectionSha256([]),
      updatedAtMs: 0,
    };
    validateLegalHoldControlRecord(control);
    return control;
  }

  private subjectLegalHoldRecords(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): LegalHoldRecord[] {
    const records: LegalHoldRecord[] = [];
    for (const [key, record] of this.legalHolds) {
      if (
        record.tenantId !== tenantId
        || record.subjectKind !== subjectKind
        || record.subjectId !== subjectId
      ) continue;
      validateLegalHoldRecord(record);
      if (key !== legalHoldKey(record.tenantId, record.holdId)) {
        throw new LegalHoldIntegrityError("legal hold index does not match its record");
      }
      records.push(clone(record));
    }
    return records.sort((left, right) => compareLegalHoldIds(left.holdId, right.holdId));
  }

  private assertLegalHoldState(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): { control: LegalHoldControlRecord; holds: LegalHoldRecord[]; events: LegalHoldEvent[] } {
    const key = subjectLifecycleKey(tenantId, subjectKind, subjectId);
    const initial = this.initialLegalHoldControl(tenantId, subjectKind, subjectId);
    const storedControl = this.legalHoldControls.get(key);
    const durableHolds = this.subjectLegalHoldRecords(tenantId, subjectKind, subjectId);
    const storedEvents = this.legalHoldEvents.get(key) ?? [];
    const lifecycle = this.subjectLifecycles.get(key);
    if (lifecycle && (
      lifecycle.tenantId !== tenantId
      || lifecycle.subjectKind !== subjectKind
      || lifecycle.subjectId !== subjectId
    )) throw new LegalHoldIntegrityError("legal hold lifecycle index is corrupt");

    if (!storedControl) {
      if (durableHolds.length !== 0 || storedEvents.length !== 0) {
        throw new LegalHoldIntegrityError("legal hold ledger exists without its control row");
      }
      if (lifecycle?.legalHoldAtMs !== undefined) {
        throw new LegalHoldIntegrityError("legacy legal hold shadow has no canonical provenance");
      }
      return { control: initial, holds: [], events: [] };
    }
    validateLegalHoldControlRecord(storedControl);
    if (
      storedControl.tenantId !== tenantId
      || storedControl.subjectKind !== subjectKind
      || storedControl.subjectId !== subjectId
    ) throw new LegalHoldIntegrityError("legal hold control identity is corrupt");

    let reconstructedControl = initial;
    const reconstructedHolds = new Map<string, LegalHoldRecord>();
    let previousEventId = 0;
    for (const [index, event] of storedEvents.entries()) {
      if (
        !Number.isSafeInteger(event.eventId)
        || event.eventId <= previousEventId
        || event.tenantId !== tenantId
        || event.subjectKind !== subjectKind
        || event.subjectId !== subjectId
        || event.controlGeneration !== index + 1
      ) throw new LegalHoldIntegrityError("legal hold audit identity is corrupt");
      previousEventId = event.eventId;
      if (event.emittedAtMs < reconstructedControl.updatedAtMs) {
        throw new LegalHoldIntegrityError("legal hold audit time regressed");
      }
      if (event.beforeSha256 !== legalHoldControlSha256(reconstructedControl)) {
        throw new LegalHoldIntegrityError("legal hold audit prior-state commitment is invalid");
      }
      if (event.eventType === "legal_hold/set") {
        validateSetLegalHoldInput({
          tenantId,
          holdId: event.holdId,
          subjectKind,
          subjectId,
          reasonCode: event.reasonCode as SetLegalHoldInput["reasonCode"],
          ...(event.externalReferenceSha256 === undefined
            ? {}
            : { externalReferenceSha256: event.externalReferenceSha256 }),
          expectedControlGeneration: event.controlGeneration - 1,
          actorKeyId: event.actorKeyId,
          atMs: event.emittedAtMs,
        });
        if (reconstructedHolds.has(event.holdId)) {
          throw new LegalHoldIntegrityError("legal hold was set more than once");
        }
        reconstructedHolds.set(event.holdId, {
          tenantId,
          holdId: event.holdId,
          subjectKind,
          subjectId,
          state: "active",
          reasonCode: event.reasonCode as SetLegalHoldInput["reasonCode"],
          ...(event.externalReferenceSha256 === undefined
            ? {}
            : { externalReferenceSha256: event.externalReferenceSha256 }),
          createdControlGeneration: event.controlGeneration,
          createdByKeyId: event.actorKeyId,
          createdAtMs: event.emittedAtMs,
        });
      } else if (event.eventType === "legal_hold/released") {
        if (event.externalReferenceSha256 !== undefined) {
          throw new LegalHoldIntegrityError("legal hold release audit carries set-only evidence");
        }
        validateReleaseLegalHoldInput({
          tenantId,
          holdId: event.holdId,
          expectedControlGeneration: event.controlGeneration - 1,
          reasonCode: event.reasonCode as ReleaseLegalHoldInput["reasonCode"],
          actorKeyId: event.actorKeyId,
          atMs: event.emittedAtMs,
        });
        const existing = reconstructedHolds.get(event.holdId);
        if (!existing || existing.state !== "active") {
          throw new LegalHoldIntegrityError("legal hold release audit has no active hold");
        }
        reconstructedHolds.set(event.holdId, {
          ...existing,
          state: "released",
          releasedControlGeneration: event.controlGeneration,
          releasedByKeyId: event.actorKeyId,
          releasedAtMs: event.emittedAtMs,
          releaseReasonCode: event.reasonCode as ReleaseLegalHoldInput["reasonCode"],
        });
      } else {
        throw new LegalHoldIntegrityError("legal hold audit type is invalid");
      }
      const active = [...reconstructedHolds.values()].filter((hold) => hold.state === "active");
      const nextControl: LegalHoldControlRecord = {
        tenantId,
        subjectKind,
        subjectId,
        controlGeneration: event.controlGeneration,
        activeHoldCount: active.length,
        activeProjectionSha256: legalHoldProjectionSha256(active),
        updatedAtMs: event.emittedAtMs,
      };
      validateLegalHoldControlRecord(nextControl);
      if (event.afterSha256 !== legalHoldControlSha256(nextControl)) {
        throw new LegalHoldIntegrityError("legal hold audit outcome commitment is invalid");
      }
      reconstructedControl = nextControl;
    }

    const reconstructed = [...reconstructedHolds.values()]
      .sort((left, right) => compareLegalHoldIds(left.holdId, right.holdId));
    if (
      storedEvents.length !== storedControl.controlGeneration
      || !legalHoldControlsEqual(storedControl, reconstructedControl)
      || reconstructed.length !== durableHolds.length
      || reconstructed.some((hold, index) => !legalHoldRecordsEqual(hold, durableHolds[index]!))
    ) throw new LegalHoldIntegrityError();
    const active = durableHolds.filter((hold) => hold.state === "active");
    if (
      storedControl.activeHoldCount !== active.length
      || storedControl.activeProjectionSha256 !== legalHoldProjectionSha256(active)
    ) throw new LegalHoldIntegrityError();
    if (storedControl.controlGeneration > 0 && !lifecycle) {
      throw new LegalHoldIntegrityError("legal hold lifecycle shadow row is missing");
    }
    const expectedShadow = active.length === 0
      ? undefined
      : Math.min(...active.map((hold) => hold.createdAtMs));
    if (lifecycle?.legalHoldAtMs !== expectedShadow) throw new LegalHoldIntegrityError();
    return {
      control: clone(storedControl),
      holds: durableHolds.map(clone),
      events: storedEvents.map(clone),
    };
  }

  private stageLegalHoldLifecycleRows(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
    legalHoldAtMs: number | undefined,
    atMs: number,
  ): Array<{ key: string; value: SubjectLifecycleRecord }> {
    const keys = [subjectLifecycleKey(tenantId, "tenant", tenantId)];
    if (subjectKind === "user") keys.push(subjectLifecycleKey(tenantId, "user", subjectId));
    const staged: Array<{ key: string; value: SubjectLifecycleRecord }> = [];
    for (const key of keys) {
      const isTarget = key === subjectLifecycleKey(tenantId, subjectKind, subjectId);
      const existing = this.subjectLifecycles.get(key);
      const rowKind: DataSubjectKind = key === keys[0] ? "tenant" : "user";
      const rowSubjectId = rowKind === "tenant" ? tenantId : subjectId;
      if (!existing && [...this.erasureRequests.values()].some((request) => (
        request.tenantId === tenantId
        && request.subjectKind === rowKind
        && request.subjectId === rowSubjectId
      ))) {
        throw new LegalHoldIntegrityError(
          `${rowKind} lifecycle gate is missing for an existing erasure request`,
        );
      }
      const value = clone(existing ?? this.activeSubjectRecord(
        tenantId,
        rowKind,
        rowSubjectId,
        atMs,
      ));
      if (isTarget) {
        value.updatedAtMs = Math.max(value.updatedAtMs, atMs);
        value.legalHoldAtMs = legalHoldAtMs;
        if (value.legalHoldAtMs === undefined) delete value.legalHoldAtMs;
      }
      staged.push({ key, value });
    }
    return staged;
  }

  private publishLegalHoldState(
    key: string,
    control: LegalHoldControlRecord,
    holdKey: string,
    hold: LegalHoldRecord,
    events: LegalHoldEvent[],
    lifecycleRows: Array<{ key: string; value: SubjectLifecycleRecord }>,
  ): void {
    const controlExisted = this.legalHoldControls.has(key);
    const priorControl = this.legalHoldControls.get(key);
    const holdExisted = this.legalHolds.has(holdKey);
    const priorHold = this.legalHolds.get(holdKey);
    const eventsExisted = this.legalHoldEvents.has(key);
    const priorEvents = this.legalHoldEvents.get(key);
    const lifecyclePrior = lifecycleRows.map((row) => ({
      key: row.key,
      existed: this.subjectLifecycles.has(row.key),
      value: this.subjectLifecycles.get(row.key),
    }));
    try {
      this.legalHolds.set(holdKey, hold);
      this.legalHoldEvents.set(key, events);
      this.legalHoldControls.set(key, control);
      for (const row of lifecycleRows) this.subjectLifecycles.set(row.key, row.value);
    } catch (error) {
      for (const row of lifecyclePrior.reverse()) {
        restoreMapEntry(this.subjectLifecycles, row.key, row.existed, row.value);
      }
      restoreMapEntry(this.legalHoldControls, key, controlExisted, priorControl);
      restoreMapEntry(this.legalHoldEvents, key, eventsExisted, priorEvents);
      restoreMapEntry(this.legalHolds, holdKey, holdExisted, priorHold);
      throw error;
    }
  }

  async setLegalHold(input: SetLegalHoldInput): Promise<LegalHoldRecord> {
    const stagedInput = clone(input);
    validateSetLegalHoldInput(stagedInput);
    this.assertTenantWritable(stagedInput.tenantId);
    const holdKey = legalHoldKey(stagedInput.tenantId, stagedInput.holdId);
    const existing = this.legalHolds.get(holdKey);
    if (existing) {
      validateLegalHoldRecord(existing);
      this.assertLegalHoldState(existing.tenantId, existing.subjectKind, existing.subjectId);
      if (
        existing.tenantId === stagedInput.tenantId
        && existing.subjectKind === stagedInput.subjectKind
        && existing.subjectId === stagedInput.subjectId
        && existing.state === "active"
        && existing.reasonCode === stagedInput.reasonCode
        && existing.externalReferenceSha256 === stagedInput.externalReferenceSha256
        && existing.createdControlGeneration === stagedInput.expectedControlGeneration + 1
      ) return clone(existing);
      throw new LegalHoldConflictError(stagedInput.holdId);
    }
    const state = this.assertLegalHoldState(
      stagedInput.tenantId,
      stagedInput.subjectKind,
      stagedInput.subjectId,
    );
    if (stagedInput.expectedControlGeneration !== state.control.controlGeneration) {
      throw new LegalHoldGenerationConflictError(
        stagedInput.expectedControlGeneration,
        state.control.controlGeneration,
      );
    }
    if (state.control.controlGeneration >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error("legal hold control generation is exhausted");
    }
    const effectiveAtMs = Math.max(stagedInput.atMs, state.control.updatedAtMs);
    const record = clone<LegalHoldRecord>({
      tenantId: stagedInput.tenantId,
      holdId: stagedInput.holdId,
      subjectKind: stagedInput.subjectKind,
      subjectId: stagedInput.subjectId,
      state: "active",
      reasonCode: stagedInput.reasonCode,
      ...(stagedInput.externalReferenceSha256 === undefined
        ? {}
        : { externalReferenceSha256: stagedInput.externalReferenceSha256 }),
      createdControlGeneration: state.control.controlGeneration + 1,
      createdByKeyId: stagedInput.actorKeyId,
      createdAtMs: effectiveAtMs,
    });
    validateLegalHoldRecord(record);
    const active = [...state.holds.filter((hold) => hold.state === "active"), record]
      .sort((left, right) => compareLegalHoldIds(left.holdId, right.holdId));
    const nextControl = clone<LegalHoldControlRecord>({
      tenantId: stagedInput.tenantId,
      subjectKind: stagedInput.subjectKind,
      subjectId: stagedInput.subjectId,
      controlGeneration: record.createdControlGeneration,
      activeHoldCount: active.length,
      activeProjectionSha256: legalHoldProjectionSha256(active),
      updatedAtMs: effectiveAtMs,
    });
    validateLegalHoldControlRecord(nextControl);
    if (!Number.isSafeInteger(this.nextLegalHoldEventId) || this.nextLegalHoldEventId <= 0) {
      throw new Error("legal hold event sequence is exhausted");
    }
    const event = clone<LegalHoldEvent>({
      eventId: this.nextLegalHoldEventId,
      tenantId: stagedInput.tenantId,
      subjectKind: stagedInput.subjectKind,
      subjectId: stagedInput.subjectId,
      controlGeneration: nextControl.controlGeneration,
      holdId: stagedInput.holdId,
      eventType: "legal_hold/set",
      reasonCode: stagedInput.reasonCode,
      ...(stagedInput.externalReferenceSha256 === undefined
        ? {}
        : { externalReferenceSha256: stagedInput.externalReferenceSha256 }),
      actorKeyId: stagedInput.actorKeyId,
      beforeSha256: legalHoldControlSha256(state.control),
      afterSha256: legalHoldControlSha256(nextControl),
      emittedAtMs: effectiveAtMs,
    });
    const key = subjectLifecycleKey(
      stagedInput.tenantId,
      stagedInput.subjectKind,
      stagedInput.subjectId,
    );
    const lifecycleRows = this.stageLegalHoldLifecycleRows(
      stagedInput.tenantId,
      stagedInput.subjectKind,
      stagedInput.subjectId,
      Math.min(...active.map((hold) => hold.createdAtMs)),
      effectiveAtMs,
    );
    this.publishLegalHoldState(
      key,
      nextControl,
      holdKey,
      record,
      clone([...state.events, event]),
      lifecycleRows,
    );
    this.nextLegalHoldEventId += 1;
    return clone(record);
  }

  async releaseLegalHold(input: ReleaseLegalHoldInput): Promise<LegalHoldRecord> {
    const stagedInput = clone(input);
    validateReleaseLegalHoldInput(stagedInput);
    this.assertTenantWritable(stagedInput.tenantId);
    const holdKey = legalHoldKey(stagedInput.tenantId, stagedInput.holdId);
    const existing = this.legalHolds.get(holdKey);
    if (!existing) throw new LegalHoldNotFoundError(stagedInput.holdId);
    validateLegalHoldRecord(existing);
    const state = this.assertLegalHoldState(
      existing.tenantId,
      existing.subjectKind,
      existing.subjectId,
    );
    if (existing.state === "released") {
      if (
        existing.releasedControlGeneration === stagedInput.expectedControlGeneration + 1
        && existing.releaseReasonCode === stagedInput.reasonCode
      ) return clone(existing);
      throw new LegalHoldConflictError(stagedInput.holdId);
    }
    if (stagedInput.expectedControlGeneration !== state.control.controlGeneration) {
      throw new LegalHoldGenerationConflictError(
        stagedInput.expectedControlGeneration,
        state.control.controlGeneration,
      );
    }
    if (state.control.controlGeneration >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error("legal hold control generation is exhausted");
    }
    const effectiveAtMs = Math.max(stagedInput.atMs, state.control.updatedAtMs);
    const released = clone<LegalHoldRecord>({
      ...existing,
      state: "released",
      releasedControlGeneration: state.control.controlGeneration + 1,
      releasedByKeyId: stagedInput.actorKeyId,
      releasedAtMs: effectiveAtMs,
      releaseReasonCode: stagedInput.reasonCode,
    });
    validateLegalHoldRecord(released);
    const active = state.holds
      .filter((hold) => hold.holdId !== released.holdId && hold.state === "active")
      .sort((left, right) => compareLegalHoldIds(left.holdId, right.holdId));
    const nextControl = clone<LegalHoldControlRecord>({
      tenantId: existing.tenantId,
      subjectKind: existing.subjectKind,
      subjectId: existing.subjectId,
      controlGeneration: released.releasedControlGeneration!,
      activeHoldCount: active.length,
      activeProjectionSha256: legalHoldProjectionSha256(active),
      updatedAtMs: effectiveAtMs,
    });
    validateLegalHoldControlRecord(nextControl);
    if (!Number.isSafeInteger(this.nextLegalHoldEventId) || this.nextLegalHoldEventId <= 0) {
      throw new Error("legal hold event sequence is exhausted");
    }
    const event = clone<LegalHoldEvent>({
      eventId: this.nextLegalHoldEventId,
      tenantId: existing.tenantId,
      subjectKind: existing.subjectKind,
      subjectId: existing.subjectId,
      controlGeneration: nextControl.controlGeneration,
      holdId: existing.holdId,
      eventType: "legal_hold/released",
      reasonCode: stagedInput.reasonCode,
      actorKeyId: stagedInput.actorKeyId,
      beforeSha256: legalHoldControlSha256(state.control),
      afterSha256: legalHoldControlSha256(nextControl),
      emittedAtMs: effectiveAtMs,
    });
    const key = subjectLifecycleKey(existing.tenantId, existing.subjectKind, existing.subjectId);
    const lifecycleRows = this.stageLegalHoldLifecycleRows(
      existing.tenantId,
      existing.subjectKind,
      existing.subjectId,
      active.length === 0 ? undefined : Math.min(...active.map((hold) => hold.createdAtMs)),
      effectiveAtMs,
    );
    this.publishLegalHoldState(
      key,
      nextControl,
      holdKey,
      released,
      clone([...state.events, event]),
      lifecycleRows,
    );
    this.nextLegalHoldEventId += 1;
    return clone(released);
  }

  async getLegalHold(tenantId: string, holdId: string): Promise<LegalHoldRecord | null> {
    const record = this.legalHolds.get(legalHoldKey(tenantId, holdId));
    if (!record) return null;
    validateLegalHoldRecord(record);
    if (record.tenantId !== tenantId || record.holdId !== holdId) {
      throw new LegalHoldIntegrityError("legal hold index is corrupt");
    }
    this.assertLegalHoldState(record.tenantId, record.subjectKind, record.subjectId);
    return clone(record);
  }

  async getActiveLegalHoldState(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<{ control: LegalHoldControlRecord; holds: LegalHoldRecord[] }> {
    const state = this.assertLegalHoldState(tenantId, subjectKind, subjectId);
    return clone({
      control: state.control,
      holds: state.holds.filter((hold) => hold.state === "active"),
    });
  }

  async getLegalHoldControl(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldControlRecord> {
    return (await this.getActiveLegalHoldState(tenantId, subjectKind, subjectId)).control;
  }

  async listActiveLegalHolds(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldRecord[]> {
    return (await this.getActiveLegalHoldState(tenantId, subjectKind, subjectId)).holds;
  }

  async listLegalHoldEvents(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldEvent[]> {
    return this.assertLegalHoldState(tenantId, subjectKind, subjectId).events.map(clone);
  }

  private erasurePurgeTargetKey(
    requestId: string,
    buildGeneration: number,
    sessionId: string,
  ): string {
    return JSON.stringify([requestId, buildGeneration, sessionId]);
  }

  private assertErasurePolicyEvaluationJob(
    job: ErasurePolicyEvaluationJob,
  ): { request: ErasureRequestRecord; subject: SubjectLifecycleRecord } {
    const request = this.erasureRequests.get(job.requestId);
    if (
      !request
      || request.requestId !== job.requestId
      || request.tenantId !== job.tenantId
      || request.subjectKind !== job.subjectKind
      || request.subjectId !== job.subjectId
      || request.generation !== job.subjectGeneration
      || request.status !== "awaiting_purge_policy"
    ) throw new Error("erasure policy evaluation request binding is invalid");
    const subject = this.assertErasureJobIntegrity(request);
    if (
      subject.generation !== job.subjectGeneration
      || subject.activeRequestId !== job.requestId
      || subject.state !== "deleting"
    ) throw new Error("erasure policy evaluation subject binding is invalid");
    if (
      (job.subjectKind !== "tenant" && job.subjectKind !== "user")
      || !Number.isSafeInteger(job.buildGeneration)
      || job.buildGeneration <= 0
      || !Number.isSafeInteger(job.targetCount)
      || job.targetCount < 0
      || !/^[0-9a-f]{64}$/.test(job.targetRootSha256)
      || !Number.isSafeInteger(job.attempts)
      || job.attempts < 0
      || (job.cursorSessionId !== undefined && !isCanonicalId("sess", job.cursorSessionId))
      || (job.availableAtMs !== undefined
        && (!Number.isSafeInteger(job.availableAtMs) || job.availableAtMs < 0))
      || (job.leaseUntilMs !== undefined
        && (!Number.isSafeInteger(job.leaseUntilMs) || job.leaseUntilMs < 0))
      || (job.sealedAtMs !== undefined
        && (!Number.isSafeInteger(job.sealedAtMs) || job.sealedAtMs < 0))
      || !Number.isSafeInteger(job.createdAtMs)
      || job.createdAtMs < 0
      || !Number.isSafeInteger(job.updatedAtMs)
      || job.updatedAtMs < job.createdAtMs
      || ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined))
      || (job.claimToken !== undefined && !/^[A-Za-z0-9._:-]{16,128}$/.test(job.claimToken))
      || (job.claimToken !== undefined && job.availableAtMs === undefined)
      || (job.lastErrorCode !== undefined
        && job.lastErrorCode !== "temporary_failure"
        && job.lastErrorCode !== "evidence_changed")
      || (job.sealedAtMs !== undefined && (
        job.availableAtMs !== undefined
        || job.claimToken !== undefined
        || job.leaseUntilMs !== undefined
        || job.lastErrorCode !== undefined
      ))
    ) throw new Error("erasure policy evaluation job is invalid");
    return { request, subject };
  }

  private erasurePolicyEvaluationClaim(
    job: ErasurePolicyEvaluationJob,
  ): ErasurePolicyEvaluationClaim {
    if (
      job.availableAtMs === undefined
      || job.claimToken === undefined
      || job.leaseUntilMs === undefined
    ) throw new Error("erasure policy evaluation job is not claimed");
    return {
      requestId: job.requestId,
      tenantId: job.tenantId,
      subjectKind: job.subjectKind,
      subjectId: job.subjectId,
      subjectGeneration: job.subjectGeneration,
      buildGeneration: job.buildGeneration,
      availableAtMs: job.availableAtMs,
      claimToken: job.claimToken,
      claimAttempt: job.attempts,
      leaseUntilMs: job.leaseUntilMs,
    };
  }

  private assertErasurePolicyEvaluationAuthorization(
    authorization: ErasurePolicyEvaluationAuthorization,
    nowMs: number,
  ): { job: ErasurePolicyEvaluationJob; request: ErasureRequestRecord } {
    validateErasurePolicyEvaluationAuthorization(authorization);
    if (!this.isTenantActive(authorization.tenantId)) {
      throw new Error("stale erasure policy evaluation authority");
    }
    const job = this.erasurePolicyEvaluationJobs.get(authorization.requestId);
    if (!job) throw new Error("stale erasure policy evaluation authority");
    const { request } = this.assertErasurePolicyEvaluationJob(job);
    if (!erasurePolicyEvaluationAuthorizationMatches(job, authorization, nowMs)) {
      throw new Error("stale erasure policy evaluation authority");
    }
    return { job, request };
  }

  private memoryErasurePurgeTarget(
    request: ErasureRequestRecord,
    job: ErasurePolicyEvaluationJob,
    policy: RetentionPolicyVersionRecord,
    session: Session,
  ): ErasurePurgeTargetEvidence {
    const issues = new Set<ErasurePurgeTargetIssueCode>();
    const tombstone = this.deleted.get(session.id);
    let deletedAtMs = 0;
    let deletionGeneration = 0;
    if (tombstone) {
      deletedAtMs = tombstone.deletedAtMs;
      deletionGeneration = tombstone.deletionGeneration;
    }
    try {
      if (!tombstone) throw new Error("missing tombstone");
      this.assertExistingErasureTombstone(session, tombstone);
    } catch {
      issues.add("tombstone_invalid");
      if (!Number.isSafeInteger(deletedAtMs) || deletedAtMs < 0) deletedAtMs = 0;
      if (!Number.isSafeInteger(deletionGeneration) || deletionGeneration <= 0) deletionGeneration = 1;
    }

    const contentDeadline = checkedRetentionDeadline(
      deletedAtMs,
      policy.policy.sessionContentRetentionMs,
    );
    if (contentDeadline.kind === "unconfigured") issues.add("policy_unconfigured");
    if (contentDeadline.kind === "invalid") issues.add("deadline_overflow");

    const sessionBlobs = [...this.blobManifests.entries()]
      .filter(([, blob]) => blob.sessionId === session.id)
      .sort((left, right) => left[1].blobId.localeCompare(right[1].blobId));
    if (sessionBlobs.some(([key, blob]) => (
      blob.tenantId !== request.tenantId
      || blob.userId !== request.subjectId
      || (blob.state !== "ready" && blob.state !== "deleted")
      || (blob.state === "ready" && !isValidReadyPurgeBlobManifest(key, blob))
    ))) issues.add("blob_invalid");
    const readyBlobs = sessionBlobs
      .map(([, blob]) => blob)
      .filter((blob) => (
        blob.tenantId === request.tenantId
        && blob.userId === request.subjectId
        && blob.state === "ready"
      ));
    const readyBlobRootSha256 = createHash("sha256").update(JSON.stringify([
      "agent-service/erasure-ready-blob-root/v1",
      ...readyBlobs.map((blob) => [
        blob.blobId,
        blob.deletionGeneration,
        blob.sha256 ?? null,
        blob.sizeBytes ?? null,
      ]),
    ])).digest("hex");

    const reconciliation = this.usageReconciliations.get(
      this.usageReconciliationMapKey(session.id, deletionGeneration),
    );
    let reconciliationValid = !!reconciliation && (
      reconciliation.tenantId === request.tenantId
      && reconciliation.userId === request.subjectId
      && reconciliation.sessionId === session.id
      && reconciliation.deletionGeneration === deletionGeneration
      && (reconciliation.status === "verified" || reconciliation.status === "anonymized")
      && Number.isSafeInteger(reconciliation.verifiedAtMs)
      && reconciliation.verifiedAtMs >= deletedAtMs
      && /^[0-9a-f]{64}$/.test(reconciliation.checksum)
    );
    if (reconciliationValid && reconciliation) {
      const ledger = this.usageLedger.filter((entry) => entry.sessionId === session.id);
      if (ledger.some((entry) => (
        entry.tenantId !== request.tenantId || entry.userId !== request.subjectId
      ))) {
        reconciliationValid = false;
      } else if (reconciliation.status === "anonymized") {
        reconciliationValid = ledger.length === 0
          && reconciliation.anonymizedAtMs !== undefined
          && reconciliation.anonymizedAtMs >= reconciliation.verifiedAtMs;
      } else {
        try {
          const facts = ledger.map((entry) => {
            if (!entry.usageId || !isUsageId(entry.usageId)) throw new Error("missing usage identity");
            const durable = this.billingUsageFacts.get(entry.usageId);
            if (!durable) throw new Error("missing billing fact");
            const expected = billingUsageFactFromLedger({
              ...entry,
              usage: normalizeHistoricalUsageCost(entry.usage),
            } as UsageLedgerEntry & { usageId: string });
            if (!billingUsageFactContentEquals(durable, expected)) throw new Error("billing fact mismatch");
            return durable;
          });
          reconciliationValid = usageReconciliationSummariesEqual(
            reconciliation,
            summarizeBillingUsageFacts(facts),
          );
        } catch {
          reconciliationValid = false;
        }
      }
    }
    if (
      !reconciliation
      || !reconciliationValid
    ) issues.add("usage_reconciliation_invalid");
    // Invalid reconciliation rows are untrusted, including their owner-scoped timestamp and
    // checksum. Use deterministic subject-local placeholders so target evidence cannot disclose
    // fields from a foreign tenant/user that happens to share the session/generation key.
    const usageVerifiedAtMs = reconciliationValid ? reconciliation!.verifiedAtMs : deletedAtMs;
    const usageDeadline = checkedRetentionDeadline(
      usageVerifiedAtMs,
      policy.policy.operationalUsageRetentionMs,
    );
    if (usageDeadline.kind === "unconfigured") issues.add("policy_unconfigured");
    if (usageDeadline.kind === "invalid") issues.add("deadline_overflow");

    const receipts: number[] = [];
    let ownedReceiptCount = 0;
    for (const [key, receipt] of this.idem) {
      let scope: unknown;
      try {
        scope = JSON.parse(key);
      } catch {
        continue;
      }
      if (
        !Array.isArray(scope)
        || scope.length !== 4
        || scope[2] !== session.id
      ) continue;
      if (scope[0] !== request.tenantId || scope[1] !== request.subjectId) {
        issues.add("receipt_invalid");
        continue;
      }
      ownedReceiptCount += 1;
      if (!Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt < 0) {
        issues.add("receipt_invalid");
      } else {
        receipts.push(receipt.expiresAt);
      }
    }
    const receiptFloor = checkedRetentionDeadline(
      deletedAtMs,
      policy.policy.idempotencyReceiptRetentionMs,
    );
    if (receiptFloor.kind === "unconfigured") issues.add("policy_unconfigured");
    if (receiptFloor.kind === "invalid") issues.add("deadline_overflow");
    const idempotencyReceiptDeadlineMs = receipts.length > 0 && receiptFloor.kind === "deadline"
      ? Math.max(receiptFloor.value, ...receipts)
      : undefined;

    const withoutHash: Omit<ErasurePurgeTargetEvidence, "evidenceSha256"> = {
      requestId: request.requestId,
      buildGeneration: job.buildGeneration,
      tenantId: request.tenantId,
      userId: request.subjectId,
      sessionId: session.id,
      deletionGeneration,
      deletedAtMs,
      ...(contentDeadline.kind === "deadline"
        ? { sessionContentDeadlineMs: contentDeadline.value }
        : {}),
      readyBlobCount: readyBlobs.length,
      readyBlobRootSha256,
      ...(readyBlobs.length > 0 && contentDeadline.kind === "deadline"
        ? { readyBlobDeadlineMs: contentDeadline.value }
        : {}),
      operationalUsageStatus: reconciliationValid
        ? reconciliation!.status
        : "missing_or_invalid",
      operationalUsageVerifiedAtMs: usageVerifiedAtMs,
      operationalUsageChecksum: reconciliationValid ? reconciliation!.checksum : "0".repeat(64),
      ...(usageDeadline.kind === "deadline"
        ? { operationalUsageDeadlineMs: usageDeadline.value }
        : {}),
      idempotencyReceiptCount: ownedReceiptCount,
      ...(idempotencyReceiptDeadlineMs === undefined ? {} : { idempotencyReceiptDeadlineMs }),
      exportArtifactDisposition: "not_applicable",
      billingFactDisposition: "retained",
      lifecycleAuditDisposition: "retained",
      issueCodes: [...issues].sort(),
    };
    return clone({
      ...withoutHash,
      evidenceSha256: erasurePurgeTargetEvidenceSha256(withoutHash),
    });
  }

  async scheduleAwaitingErasurePolicyEvaluations(
    options: ScheduleAwaitingErasurePolicyEvaluationsOptions,
  ): Promise<number> {
    validateScheduleAwaitingErasurePolicyEvaluationsOptions(options);
    const candidates = [...this.erasureRequests.values()]
      .filter((request) => request.status === "awaiting_purge_policy")
      .sort((left, right) => left.requestId.localeCompare(right.requestId));
    let scheduled = 0;
    let firstError: unknown;
    for (const request of candidates) {
      if (scheduled >= options.limit) break;
      try {
        // Append-only tenant admission/fence evidence is an independent parent-authority fence.
        // A privileged repair must not revive user purge evaluation merely by resetting the
        // mutable tenant lifecycle projection to active.
        if (!this.isTenantActive(request.tenantId)) continue;
        const job = this.erasurePolicyEvaluationJobs.get(request.requestId);
        let shouldSchedule = !job;
        if (job?.sealedAtMs !== undefined) {
          const decisions = this.assertMemoryErasurePolicyDecisionChain(request.requestId);
          const last = decisions.at(-1);
          if (!last || last.buildGeneration !== job.buildGeneration) {
            throw new Error("sealed evaluation job has no matching decision");
          }
          if (last.decision === "unbound" || last.decision === "unconfigured") continue;
          let liveEvidenceChanged = false;
          if (request.policyVersion !== undefined && request.policyHash !== undefined) {
            let policy = this.retentionPolicies.get(retentionPolicyKey(
              request.tenantId,
              request.policyVersion,
            ));
            if (policy?.policySha256 === request.policyHash) {
              try {
                validateRetentionPolicyVersionRecord(policy);
              } catch {
                // A malformed/missing bound policy is a terminal policy-identity failure, not a
                // recoverable inventory drift signal.
                policy = undefined;
              }
            }
            if (policy?.policySha256 === request.policyHash) {
              liveEvidenceChanged = !this.memoryErasurePurgeInventoryMatches(request, job, policy);
            }
          }
          if (last.decision === "invalid") {
            shouldSchedule = liveEvidenceChanged;
          } else {
            const tenantHold = this.assertLegalHoldState(
              request.tenantId,
              "tenant",
              request.tenantId,
            ).control;
            const userHold = this.assertLegalHoldState(
              request.tenantId,
              "user",
              request.subjectId,
            ).control;
            const holdChanged = tenantHold.controlGeneration !== last.tenantHoldControlGeneration
              || tenantHold.activeProjectionSha256 !== last.tenantHoldProjectionSha256
              || userHold.controlGeneration !== last.userHoldControlGeneration
              || userHold.activeProjectionSha256 !== last.userHoldProjectionSha256;
            const deadlineReached = last.decision === "waiting"
              && last.eligibilityDeadlineMs !== undefined
              && last.eligibilityDeadlineMs <= options.nowMs;
            shouldSchedule = holdChanged || deadlineReached || liveEvidenceChanged;
          }
        } else if (job) {
          shouldSchedule = false;
        }
        if (!shouldSchedule) continue;

        this.assertErasureJobIntegrity(request);
        const existing = this.erasurePolicyEvaluationJobs.get(request.requestId);
        const priorControl = this.erasurePurgeAuthorityControls.get(request.requestId);
        let nextJob: ErasurePolicyEvaluationJob;
        let nextControl: ErasurePurgeAuthorityControl | undefined;
        if (!existing) {
          nextJob = clone(newErasurePolicyEvaluationJob({
            requestId: request.requestId,
            tenantId: request.tenantId,
            subjectKind: request.subjectKind,
            subjectId: request.subjectId,
            subjectGeneration: request.generation,
          }, Math.max(options.nowMs, request.updatedAtMs)));
        } else {
          this.assertErasurePolicyEvaluationJob(existing);
          if (existing.buildGeneration >= Number.MAX_SAFE_INTEGER - 1) {
            throw new Error("erasure policy evaluation build generation exhausted");
          }
          const decisions = this.assertMemoryErasurePolicyDecisionChain(request.requestId);
          const last = decisions.at(-1)!;
          const atMs = Math.max(
            options.nowMs,
            request.updatedAtMs,
            existing.updatedAtMs,
            last.decidedAtMs,
            priorControl?.updatedAtMs ?? 0,
          );
          nextJob = clone({
            requestId: existing.requestId,
            tenantId: existing.tenantId,
            subjectKind: existing.subjectKind,
            subjectId: existing.subjectId,
            subjectGeneration: existing.subjectGeneration,
            buildGeneration: existing.buildGeneration + 1,
            targetCount: 0,
            targetRootSha256: EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
            availableAtMs: atMs,
            attempts: 0,
            createdAtMs: existing.createdAtMs,
            updatedAtMs: atMs,
          });
          if (priorControl?.activeAuthoritySha256 !== undefined) {
            nextControl = clone({
              requestId: priorControl.requestId,
              authorityGeneration: priorControl.authorityGeneration,
              updatedAtMs: atMs,
            });
          }
        }
        const priorJob = this.erasurePolicyEvaluationJobs.get(request.requestId);
        try {
          this.erasurePolicyEvaluationJobs.set(request.requestId, nextJob);
          if (nextControl) this.erasurePurgeAuthorityControls.set(request.requestId, nextControl);
        } catch (error) {
          restoreMapEntry(
            this.erasurePurgeAuthorityControls,
            request.requestId,
            priorControl !== undefined,
            priorControl,
          );
          restoreMapEntry(
            this.erasurePolicyEvaluationJobs,
            request.requestId,
            priorJob !== undefined,
            priorJob,
          );
          throw error;
        }
        scheduled += 1;
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
    return scheduled;
  }

  async claimErasurePolicyEvaluations(
    options: ClaimErasurePolicyEvaluationsOptions,
  ): Promise<ErasurePolicyEvaluationClaim[]> {
    const leaseUntilMs = validateClaimErasurePolicyEvaluationsOptions(options);
    const candidates = [...this.erasurePolicyEvaluationJobs.values()]
      .filter((job) => (
        this.isTenantActive(job.tenantId)
        && job.sealedAtMs === undefined
        && job.availableAtMs !== undefined
        && job.availableAtMs <= options.nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= options.nowMs)
      ))
      .sort((left, right) => left.availableAtMs! - right.availableAtMs!
        || left.requestId.localeCompare(right.requestId));
    const claims: ErasurePolicyEvaluationClaim[] = [];
    let firstError: unknown;
    for (const current of candidates) {
      if (claims.length >= options.limit) break;
      try {
        this.assertErasurePolicyEvaluationJob(current);
        if (current.attempts >= Number.MAX_SAFE_INTEGER - 1) {
          throw new Error("erasure policy evaluation claim generation exhausted");
        }
        const next = clone<ErasurePolicyEvaluationJob>({
          ...current,
          attempts: current.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
          updatedAtMs: Math.max(current.updatedAtMs, options.nowMs),
        });
        this.erasurePolicyEvaluationJobs.set(next.requestId, next);
        claims.push(this.erasurePolicyEvaluationClaim(next));
      } catch (error) {
        firstError ??= error;
      }
    }
    if (claims.length === 0 && firstError !== undefined) throw firstError;
    return clone(claims);
  }

  async renewErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RenewErasurePolicyEvaluationOptions,
  ): Promise<boolean> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    const leaseUntilMs = validateRenewErasurePolicyEvaluationOptions(options);
    const job = this.erasurePolicyEvaluationJobs.get(authorization.requestId);
    if (!job) return false;
    if (!this.isTenantActive(job.tenantId)) return false;
    this.assertErasurePolicyEvaluationJob(job);
    if (!erasurePolicyEvaluationAuthorizationMatches(job, authorization, options.nowMs)) return false;
    const next = clone(job);
    next.leaseUntilMs = Math.max(job.leaseUntilMs!, leaseUntilMs);
    next.updatedAtMs = Math.max(job.updatedAtMs, options.nowMs);
    this.erasurePolicyEvaluationJobs.set(job.requestId, next);
    return true;
  }

  async retryErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RetryErasurePolicyEvaluationOptions,
  ): Promise<boolean> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    validateRetryErasurePolicyEvaluationOptions(options);
    const job = this.erasurePolicyEvaluationJobs.get(authorization.requestId);
    if (!job) return false;
    if (!this.isTenantActive(job.tenantId)) return false;
    this.assertErasurePolicyEvaluationJob(job);
    if (!erasurePolicyEvaluationAuthorizationMatches(job, authorization, options.failedAtMs)) return false;
    let next: ErasurePolicyEvaluationJob;
    if (options.errorCode === "evidence_changed") {
      if (job.buildGeneration >= Number.MAX_SAFE_INTEGER - 1) {
        throw new Error("erasure policy evaluation build generation exhausted");
      }
      next = {
        requestId: job.requestId,
        tenantId: job.tenantId,
        subjectKind: job.subjectKind,
        subjectId: job.subjectId,
        subjectGeneration: job.subjectGeneration,
        buildGeneration: job.buildGeneration + 1,
        targetCount: 0,
        targetRootSha256: EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
        availableAtMs: options.availableAtMs,
        attempts: 0,
        lastErrorCode: options.errorCode,
        createdAtMs: job.createdAtMs,
        updatedAtMs: Math.max(job.updatedAtMs, options.failedAtMs),
      };
    } else {
      next = clone(job);
      next.availableAtMs = options.availableAtMs;
      next.lastErrorCode = options.errorCode;
      next.updatedAtMs = Math.max(job.updatedAtMs, options.failedAtMs);
      delete next.claimToken;
      delete next.leaseUntilMs;
    }
    this.erasurePolicyEvaluationJobs.set(job.requestId, next);
    return true;
  }

  async buildErasurePurgeTargetPage(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: BuildErasurePurgeTargetPageOptions,
  ): Promise<BuildErasurePurgeTargetPageResult> {
    validateBuildErasurePurgeTargetPageOptions(options);
    const { job, request } = this.assertErasurePolicyEvaluationAuthorization(
      authorization,
      options.nowMs,
    );
    if (request.subjectKind !== "user") throw new Error("tenant purge evaluation is not implemented");
    if (request.policyVersion === undefined || request.policyHash === undefined) {
      return clone({
        built: 0,
        done: true,
        ...(job.cursorSessionId === undefined ? {} : { cursorSessionId: job.cursorSessionId }),
        targetCount: job.targetCount,
        targetRootSha256: job.targetRootSha256,
      });
    }
    const policy = this.retentionPolicies.get(retentionPolicyKey(
      request.tenantId,
      request.policyVersion,
    ));
    if (!policy || policy.policySha256 !== request.policyHash) {
      return clone({
        built: 0,
        done: true,
        ...(job.cursorSessionId === undefined ? {} : { cursorSessionId: job.cursorSessionId }),
        targetCount: job.targetCount,
        targetRootSha256: job.targetRootSha256,
      });
    }
    validateRetentionPolicyVersionRecord(policy);
    const remaining = [...this.sessions.values()]
      .filter((session) => (
        session.tenantId === request.tenantId
        && session.userId === request.subjectId
        && (job.cursorSessionId === undefined || session.id > job.cursorSessionId)
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
    const page = remaining.slice(0, options.limit);
    const stagedTargets = new Map<string, ErasurePurgeTargetEvidence>();
    let targetRootSha256 = job.targetRootSha256;
    let targetCount = job.targetCount;
    for (const session of page) {
      const evidence = this.memoryErasurePurgeTarget(request, job, policy, session);
      const key = this.erasurePurgeTargetKey(job.requestId, job.buildGeneration, session.id);
      const existing = this.erasurePurgeTargets.get(key);
      if (existing && existing.evidenceSha256 !== evidence.evidenceSha256) {
        throw new Error("erasure purge target evidence conflicts with an immutable row");
      }
      if (existing) throw new Error("erasure policy evaluation cursor overlaps existing evidence");
      stagedTargets.set(key, evidence);
      targetRootSha256 = nextErasurePurgeTargetRootSha256(
        targetRootSha256,
        evidence.evidenceSha256,
      );
      targetCount += 1;
    }
    const next = clone(job);
    next.targetCount = targetCount;
    next.targetRootSha256 = targetRootSha256;
    next.updatedAtMs = Math.max(job.updatedAtMs, options.nowMs);
    const cursor = page.at(-1)?.id;
    if (cursor !== undefined) next.cursorSessionId = cursor;

    const priorJob = this.erasurePolicyEvaluationJobs.get(job.requestId);
    const priorTargets = [...stagedTargets.keys()].map((key) => ({
      key,
      existed: this.erasurePurgeTargets.has(key),
      value: this.erasurePurgeTargets.get(key),
    }));
    try {
      for (const [key, value] of stagedTargets) this.erasurePurgeTargets.set(key, clone(value));
      this.erasurePolicyEvaluationJobs.set(job.requestId, next);
    } catch (error) {
      for (const prior of priorTargets.reverse()) {
        restoreMapEntry(this.erasurePurgeTargets, prior.key, prior.existed, prior.value);
      }
      restoreMapEntry(this.erasurePolicyEvaluationJobs, job.requestId, true, priorJob);
      throw error;
    }
    return clone({
      built: page.length,
      done: remaining.length <= page.length,
      ...(next.cursorSessionId === undefined ? {} : { cursorSessionId: next.cursorSessionId }),
      targetCount: next.targetCount,
      targetRootSha256: next.targetRootSha256,
    });
  }

  private initialErasurePurgeAuthorityControl(requestId: string): ErasurePurgeAuthorityControl {
    return { requestId, authorityGeneration: 0, updatedAtMs: 0 };
  }

  private assertMemoryErasurePolicyDecisionChain(
    requestId: string,
  ): ErasurePolicyEvaluationDecisionEvent[] {
    const decisions = this.erasurePolicyEvaluationDecisions.get(requestId) ?? [];
    let beforeSha256 = createHash("sha256").update(JSON.stringify([
      "agent-service/erasure-policy-decision-root/v1",
      requestId,
    ])).digest("hex");
    let decidedAtMs = 0;
    for (const [index, decision] of decisions.entries()) {
      const { afterSha256, ...withoutAfter } = decision;
      if (
        decision.requestId !== requestId
        || decision.decisionSeq !== index + 1
        || decision.beforeSha256 !== beforeSha256
        || decision.decidedAtMs < decidedAtMs
        || erasurePolicyDecisionSha256(withoutAfter) !== afterSha256
      ) throw new Error("erasure policy evaluation decision chain is corrupt");
      beforeSha256 = afterSha256;
      decidedAtMs = decision.decidedAtMs;
    }
    return decisions.map(clone);
  }

  private memoryErasurePolicyEvaluationState(
    request: ErasureRequestRecord,
    job: ErasurePolicyEvaluationJob,
    nowMs: number,
  ): {
    decision: ErasurePolicyEvaluationDecision;
    policy?: RetentionPolicyVersionRecord;
    userGraceDeadlineMs?: number;
    eligibilityDeadlineMs?: number;
    targets: ErasurePurgeTargetEvidence[];
    tenantHold: LegalHoldControlRecord;
    userHold: LegalHoldControlRecord;
  } {
    const tenantHoldState = this.assertLegalHoldState(request.tenantId, "tenant", request.tenantId);
    const userHoldState = this.assertLegalHoldState(request.tenantId, "user", request.subjectId);
    const targetEntries = [...this.erasurePurgeTargets.entries()]
      .filter(([, target]) => (
        target.requestId === request.requestId
        && target.buildGeneration === job.buildGeneration
      ))
      .sort((left, right) => left[1].sessionId.localeCompare(right[1].sessionId));
    for (const [key, target] of targetEntries) {
      validateErasurePurgeTargetEvidence(target);
      if (
        key !== this.erasurePurgeTargetKey(request.requestId, job.buildGeneration, target.sessionId)
        || !isCanonicalId("sess", target.sessionId)
        || target.tenantId !== request.tenantId
        || target.userId !== request.subjectId
      ) throw new Error("erasure purge evaluation target is invalid");
    }
    const targets = targetEntries.map(([, target]) => target);
    if (request.policyVersion === undefined || request.policyHash === undefined) {
      return {
        decision: "unbound",
        targets,
        tenantHold: tenantHoldState.control,
        userHold: userHoldState.control,
      };
    }
    const policy = this.retentionPolicies.get(retentionPolicyKey(request.tenantId, request.policyVersion));
    if (!policy || policy.policySha256 !== request.policyHash) {
      return {
        decision: "invalid",
        targets,
        tenantHold: tenantHoldState.control,
        userHold: userHoldState.control,
      };
    }
    try {
      validateRetentionPolicyVersionRecord(policy);
    } catch {
      return {
        decision: "invalid",
        targets,
        tenantHold: tenantHoldState.control,
        userHold: userHoldState.control,
      };
    }
    const grace = checkedRetentionDeadline(request.gatedAtMs, policy.policy.userErasureGraceMs);
    if (
      grace.kind === "invalid"
      || targets.some((target) => target.issueCodes.some((issue) => issue !== "policy_unconfigured"))
    ) {
      return {
        decision: "invalid",
        policy,
        targets,
        tenantHold: tenantHoldState.control,
        userHold: userHoldState.control,
      };
    }
    if (
      grace.kind === "unconfigured"
      || policy.policy.sessionContentRetentionMs === null
      || policy.policy.operationalUsageRetentionMs === null
      || policy.policy.idempotencyReceiptRetentionMs === null
      || targets.some((target) => target.issueCodes.includes("policy_unconfigured"))
    ) {
      return {
        decision: "unconfigured",
        policy,
        targets,
        tenantHold: tenantHoldState.control,
        userHold: userHoldState.control,
      };
    }
    const deadlines = [
      grace.value,
      ...targets.flatMap((target) => [
        target.sessionContentDeadlineMs,
        target.readyBlobDeadlineMs,
        target.operationalUsageDeadlineMs,
        target.idempotencyReceiptDeadlineMs,
      ].filter((value): value is number => value !== undefined)),
    ];
    const eligibilityDeadlineMs = Math.max(...deadlines);
    const held = tenantHoldState.control.activeHoldCount > 0
      || userHoldState.control.activeHoldCount > 0;
    return {
      decision: held
        ? "held"
        : eligibilityDeadlineMs > nowMs
          ? "waiting"
          : "eligible_execution_disabled",
      policy,
      userGraceDeadlineMs: grace.value,
      eligibilityDeadlineMs,
      targets,
      tenantHold: tenantHoldState.control,
      userHold: userHoldState.control,
    };
  }

  private memoryErasurePurgeInventoryMatches(
    request: ErasureRequestRecord,
    job: ErasurePolicyEvaluationJob,
    policy: RetentionPolicyVersionRecord,
  ): boolean {
    const storedTargets = [...this.erasurePurgeTargets.values()]
      .filter((target) => (
        target.requestId === request.requestId
        && target.buildGeneration === job.buildGeneration
      ))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const sessions = [...this.sessions.values()]
      .filter((session) => session.tenantId === request.tenantId && session.userId === request.subjectId)
      .sort((left, right) => left.id.localeCompare(right.id));
    let liveRoot = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
    const liveTargets = sessions.map((session) => {
      const target = this.memoryErasurePurgeTarget(request, job, policy, session);
      liveRoot = nextErasurePurgeTargetRootSha256(liveRoot, target.evidenceSha256);
      return target;
    });
    return liveTargets.length === job.targetCount
      && storedTargets.length === job.targetCount
      && liveRoot === job.targetRootSha256
      && liveTargets.every((target, index) => (
        target.evidenceSha256 === storedTargets[index]?.evidenceSha256
      ));
  }

  async sealErasurePurgeAuthority(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: SealErasurePurgeAuthorityOptions,
  ): Promise<ErasurePolicyEvaluationSealResult> {
    validateSealErasurePurgeAuthorityOptions(options);
    let { job, request } = this.assertErasurePolicyEvaluationAuthorization(
      authorization,
      options.nowMs,
    );
    if (request.subjectKind !== "user") throw new Error("tenant purge evaluation is not implemented");

    // Never extend an authority ledger whose immutable history is already corrupt. During a
    // superseding build this intentionally returns null after validating the complete old chain.
    await this.getValidatedErasurePurgeAuthority(request.requestId);
    ({ job, request } = this.assertErasurePolicyEvaluationAuthorization(
      authorization,
      options.nowMs,
    ));

    // Re-read every owner row and rederive every target/root at the seal linearization point.
    const decisions = this.assertMemoryErasurePolicyDecisionChain(request.requestId);
    const currentControl = clone(this.erasurePurgeAuthorityControls.get(request.requestId)
      ?? this.initialErasurePurgeAuthorityControl(request.requestId));
    let state = this.memoryErasurePolicyEvaluationState(request, job, options.nowMs);
    const effectiveAtMs = Math.max(
      options.nowMs,
      request.updatedAtMs,
      job.updatedAtMs,
      state.tenantHold.updatedAtMs,
      state.userHold.updatedAtMs,
      state.policy?.createdAtMs ?? 0,
      decisions.at(-1)?.decidedAtMs ?? 0,
      currentControl.updatedAtMs,
    );
    if (effectiveAtMs !== options.nowMs) {
      state = this.memoryErasurePolicyEvaluationState(request, job, effectiveAtMs);
    }
    if (
      state.policy
      && !this.memoryErasurePurgeInventoryMatches(request, job, state.policy)
    ) {
      throw new ErasurePurgeEvidenceChangedError();
    }

    const decisionSeq = decisions.length + 1;
    const beforeSha256 = decisions.at(-1)?.afterSha256 ?? createHash("sha256").update(JSON.stringify([
      "agent-service/erasure-policy-decision-root/v1",
      request.requestId,
    ])).digest("hex");
    const eventWithoutAfter: Omit<ErasurePolicyEvaluationDecisionEvent, "afterSha256"> = {
      requestId: request.requestId,
      decisionSeq,
      buildGeneration: job.buildGeneration,
      decision: state.decision,
      ...(state.policy === undefined ? {} : {
        policyVersion: state.policy.policyVersion,
        policySha256: state.policy.policySha256,
      }),
      ...(state.userGraceDeadlineMs === undefined
        ? {}
        : { userGraceDeadlineMs: state.userGraceDeadlineMs }),
      ...(state.eligibilityDeadlineMs === undefined
        ? {}
        : { eligibilityDeadlineMs: state.eligibilityDeadlineMs }),
      targetCount: job.targetCount,
      targetRootSha256: job.targetRootSha256,
      tenantHoldControlGeneration: state.tenantHold.controlGeneration,
      tenantHoldProjectionSha256: state.tenantHold.activeProjectionSha256,
      userHoldControlGeneration: state.userHold.controlGeneration,
      userHoldProjectionSha256: state.userHold.activeProjectionSha256,
      beforeSha256,
      decidedAtMs: effectiveAtMs,
    };
    const decision = clone<ErasurePolicyEvaluationDecisionEvent>({
      ...eventWithoutAfter,
      afterSha256: erasurePolicyDecisionSha256(eventWithoutAfter),
    });
    const control = currentControl;
    let authority: ErasurePurgeAuthorityRecord | undefined;
    let nextControl = control;
    if (state.decision === "eligible_execution_disabled") {
      if (!state.policy || state.userGraceDeadlineMs === undefined || state.eligibilityDeadlineMs === undefined) {
        throw new Error("eligible authority evidence is incomplete");
      }
      if (control.authorityGeneration >= Number.MAX_SAFE_INTEGER - 1) {
        throw new Error("erasure purge authority generation exhausted");
      }
      const withoutHash: Omit<ErasurePurgeAuthorityRecord, "authoritySha256"> = {
        requestId: request.requestId,
        authorityGeneration: control.authorityGeneration + 1,
        tenantId: request.tenantId,
        subjectKind: request.subjectKind,
        subjectId: request.subjectId,
        subjectGeneration: request.generation,
        buildGeneration: job.buildGeneration,
        policyVersion: state.policy.policyVersion,
        policySha256: state.policy.policySha256,
        policySchemaVersion: state.policy.schemaVersion,
        userGraceDeadlineMs: state.userGraceDeadlineMs,
        eligibilityDeadlineMs: state.eligibilityDeadlineMs,
        targetCount: job.targetCount,
        targetRootSha256: job.targetRootSha256,
        tenantHoldControlGeneration: state.tenantHold.controlGeneration,
        tenantHoldProjectionSha256: state.tenantHold.activeProjectionSha256,
        userHoldControlGeneration: state.userHold.controlGeneration,
        userHoldProjectionSha256: state.userHold.activeProjectionSha256,
        decisionSha256: decision.afterSha256,
        createdAtMs: effectiveAtMs,
      };
      authority = clone({
        ...withoutHash,
        authoritySha256: erasurePurgeAuthoritySha256(withoutHash),
      });
      nextControl = clone({
        requestId: request.requestId,
        authorityGeneration: authority.authorityGeneration,
        activeAuthoritySha256: authority.authoritySha256,
        updatedAtMs: effectiveAtMs,
      });
    } else if (control.activeAuthoritySha256 !== undefined) {
      nextControl = clone({
        requestId: control.requestId,
        authorityGeneration: control.authorityGeneration,
        updatedAtMs: effectiveAtMs,
      });
    }
    const nextJob = clone(job);
    nextJob.sealedAtMs = effectiveAtMs;
    nextJob.updatedAtMs = effectiveAtMs;
    delete nextJob.availableAtMs;
    delete nextJob.claimToken;
    delete nextJob.leaseUntilMs;
    delete nextJob.lastErrorCode;
    const nextDecisions = clone([...decisions, decision]);
    const authorities = this.erasurePurgeAuthorities.get(request.requestId) ?? [];
    const nextAuthorities = authority ? clone([...authorities, authority]) : clone(authorities);

    const priorJob = this.erasurePolicyEvaluationJobs.get(request.requestId);
    const priorDecisions = this.erasurePolicyEvaluationDecisions.get(request.requestId);
    const priorControl = this.erasurePurgeAuthorityControls.get(request.requestId);
    const priorAuthorities = this.erasurePurgeAuthorities.get(request.requestId);
    try {
      this.erasurePolicyEvaluationDecisions.set(request.requestId, nextDecisions);
      this.erasurePurgeAuthorityControls.set(request.requestId, nextControl);
      if (authority) this.erasurePurgeAuthorities.set(request.requestId, nextAuthorities);
      this.erasurePolicyEvaluationJobs.set(request.requestId, nextJob);
    } catch (error) {
      restoreMapEntry(
        this.erasurePolicyEvaluationJobs,
        request.requestId,
        priorJob !== undefined,
        priorJob,
      );
      restoreMapEntry(
        this.erasurePurgeAuthorities,
        request.requestId,
        priorAuthorities !== undefined,
        priorAuthorities,
      );
      restoreMapEntry(
        this.erasurePurgeAuthorityControls,
        request.requestId,
        priorControl !== undefined,
        priorControl,
      );
      restoreMapEntry(
        this.erasurePolicyEvaluationDecisions,
        request.requestId,
        priorDecisions !== undefined,
        priorDecisions,
      );
      throw error;
    }
    return clone({ decision, ...(authority === undefined ? {} : { authority }), control: nextControl });
  }

  async getErasurePolicyEvaluationJob(
    requestId: string,
  ): Promise<ErasurePolicyEvaluationJob | null> {
    const job = this.erasurePolicyEvaluationJobs.get(requestId);
    if (!job) return null;
    this.assertErasurePolicyEvaluationJob(job);
    return clone(job);
  }

  async listErasurePurgeTargetEvidence(
    requestId: string,
    buildGeneration: number,
  ): Promise<ErasurePurgeTargetEvidence[]> {
    if (!Number.isSafeInteger(buildGeneration) || buildGeneration <= 0) {
      throw new Error("invalid erasure purge target generation");
    }
    return clone([...this.erasurePurgeTargets.values()]
      .filter((target) => target.requestId === requestId && target.buildGeneration === buildGeneration)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
  }

  async listErasurePolicyEvaluationDecisions(
    requestId: string,
  ): Promise<ErasurePolicyEvaluationDecisionEvent[]> {
    return this.assertMemoryErasurePolicyDecisionChain(requestId);
  }

  async getValidatedErasurePurgeAuthority(
    requestId: string,
  ): Promise<ErasurePurgeAuthorityRecord | null> {
    const authorities = this.erasurePurgeAuthorities.get(requestId) ?? [];
    const decisions = this.assertMemoryErasurePolicyDecisionChain(requestId);
    const eligibleDecisions = decisions.filter((decision) => (
      decision.decision === "eligible_execution_disabled"
    ));
    const control = this.erasurePurgeAuthorityControls.get(requestId);
    if (!control) {
      if (authorities.length > 0 || eligibleDecisions.length > 0) {
        throw new Error("erasure purge authority control is corrupt");
      }
      return null;
    }
    if (
      control.requestId !== requestId
      || !Number.isSafeInteger(control.authorityGeneration)
      || control.authorityGeneration < 0
      || !Number.isSafeInteger(control.updatedAtMs)
      || control.updatedAtMs < 0
      || (control.activeAuthoritySha256 !== undefined
        && !/^[0-9a-f]{64}$/.test(control.activeAuthoritySha256))
      || (control.authorityGeneration === 0 && control.activeAuthoritySha256 !== undefined)
    ) throw new Error("erasure purge authority control is corrupt");
    if (control.authorityGeneration === 0) {
      if (authorities.length > 0 || eligibleDecisions.length > 0) {
        throw new Error("erasure purge authority chain is corrupt");
      }
      return null;
    }
    const job = this.erasurePolicyEvaluationJobs.get(requestId);
    if (!job) throw new Error("erasure purge authority job is corrupt");
    const { request } = this.assertErasurePolicyEvaluationJob(job);
    if (!this.isTenantActive(request.tenantId)) return null;
    if (request.subjectKind !== "user") throw new Error("tenant purge authority is not implemented");
    const boundPolicy = request.policyVersion === undefined
      ? undefined
      : this.retentionPolicies.get(retentionPolicyKey(request.tenantId, request.policyVersion));
    if (boundPolicy) validateRetentionPolicyVersionRecord(boundPolicy);
    if (
      request.policyVersion === undefined
      || request.policyHash === undefined
      || !boundPolicy
      || boundPolicy.policySha256 !== request.policyHash
    ) throw new Error("erasure purge authority policy binding is corrupt");
    const tenantHoldHistory = this.assertLegalHoldState(
      request.tenantId,
      "tenant",
      request.tenantId,
    );
    const userHoldHistory = this.assertLegalHoldState(
      request.tenantId,
      "user",
      request.subjectId,
    );
    for (const [index, candidate] of authorities.entries()) {
      const { authoritySha256, ...withoutHash } = candidate;
      const linkedDecision = eligibleDecisions[index];
      if (
        candidate.requestId !== requestId
        || candidate.authorityGeneration !== index + 1
        || candidate.policySchemaVersion !== RETENTION_POLICY_SCHEMA_VERSION
        || erasurePurgeAuthoritySha256(withoutHash) !== authoritySha256
        || candidate.tenantId !== request.tenantId
        || candidate.subjectKind !== request.subjectKind
        || candidate.subjectId !== request.subjectId
        || candidate.subjectGeneration !== request.generation
        || candidate.policyVersion !== request.policyVersion
        || candidate.policySha256 !== request.policyHash
        || candidate.policySchemaVersion !== boundPolicy.schemaVersion
        || !linkedDecision
        || !erasurePurgeAuthorityMatchesDecision(candidate, linkedDecision)
        || (index > 0 && candidate.buildGeneration <= authorities[index - 1]!.buildGeneration)
      ) throw new Error("erasure purge authority chain is corrupt");

      const targetEntries = [...this.erasurePurgeTargets.entries()]
        .filter(([, target]) => (
          target.requestId === requestId
          && target.buildGeneration === candidate.buildGeneration
        ))
        .sort((left, right) => left[1].sessionId.localeCompare(right[1].sessionId));
      let targetRootSha256 = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
      for (const [key, target] of targetEntries) {
        validateErasurePurgeTargetEvidence(target);
        if (
          key !== this.erasurePurgeTargetKey(requestId, candidate.buildGeneration, target.sessionId)
          || !isCanonicalId("sess", target.sessionId)
          || target.tenantId !== request.tenantId
          || target.userId !== request.subjectId
        ) throw new Error("erasure purge authority target chain is corrupt");
        targetRootSha256 = nextErasurePurgeTargetRootSha256(
          targetRootSha256,
          target.evidenceSha256,
        );
      }
      if (
        targetEntries.length !== candidate.targetCount
        || targetRootSha256 !== candidate.targetRootSha256
      ) throw new Error("erasure purge authority target chain is corrupt");
      const grace = checkedRetentionDeadline(
        request.gatedAtMs,
        boundPolicy.policy.userErasureGraceMs,
      );
      const destructivePolicyConfigured = boundPolicy.policy.sessionContentRetentionMs !== null
        && boundPolicy.policy.operationalUsageRetentionMs !== null
        && boundPolicy.policy.idempotencyReceiptRetentionMs !== null;
      const historicalTargets = targetEntries.map(([, target]) => target);
      const eligibilityDeadlineMs = grace.kind === "deadline"
        && destructivePolicyConfigured
        && historicalTargets.every((target) => (
          erasurePurgeTargetMatchesRetentionPolicy(target, boundPolicy.policy)
        ))
        ? Math.max(
          grace.value,
          ...historicalTargets.flatMap((target) => [
            target.sessionContentDeadlineMs,
            target.readyBlobDeadlineMs,
            target.operationalUsageDeadlineMs,
            target.idempotencyReceiptDeadlineMs,
          ].filter((value): value is number => value !== undefined)),
        )
        : undefined;
      if (
        grace.kind !== "deadline"
        || eligibilityDeadlineMs === undefined
        || candidate.userGraceDeadlineMs !== grace.value
        || candidate.eligibilityDeadlineMs !== eligibilityDeadlineMs
        || candidate.createdAtMs < request.gatedAtMs
        || candidate.createdAtMs < request.updatedAtMs
        || candidate.createdAtMs < boundPolicy.createdAtMs
        || candidate.createdAtMs < eligibilityDeadlineMs
      ) throw new Error("erasure purge authority deadline chain is corrupt");
      const historicalTenantHold = legalHoldControlAtGeneration(
        request.tenantId,
        "tenant",
        request.tenantId,
        tenantHoldHistory.holds,
        tenantHoldHistory.events,
        candidate.tenantHoldControlGeneration,
      );
      const historicalUserHold = legalHoldControlAtGeneration(
        request.tenantId,
        "user",
        request.subjectId,
        userHoldHistory.holds,
        userHoldHistory.events,
        candidate.userHoldControlGeneration,
      );
      if (
        historicalTenantHold.activeHoldCount !== 0
        || historicalUserHold.activeHoldCount !== 0
        || historicalTenantHold.activeProjectionSha256 !== candidate.tenantHoldProjectionSha256
        || historicalUserHold.activeProjectionSha256 !== candidate.userHoldProjectionSha256
        || candidate.createdAtMs < historicalTenantHold.updatedAtMs
        || candidate.createdAtMs < historicalUserHold.updatedAtMs
      ) throw new Error("erasure purge authority hold chain is corrupt");
    }
    const authority = authorities.at(-1);
    if (
      eligibleDecisions.length !== authorities.length
      || authorities.length !== control.authorityGeneration
      || !authority
      || authority.authorityGeneration !== control.authorityGeneration
      || (control.activeAuthoritySha256 !== undefined
        && authority.authoritySha256 !== control.activeAuthoritySha256)
      || (control.activeAuthoritySha256 !== undefined
        && decisions.at(-1)?.afterSha256 !== authority.decisionSha256)
      || control.updatedAtMs < authority.createdAtMs
      || (control.activeAuthoritySha256 !== undefined
        && control.updatedAtMs !== authority.createdAtMs)
    ) throw new Error("erasure purge authority control is corrupt");
    if (authority.buildGeneration !== job.buildGeneration) {
      if (authority.buildGeneration < job.buildGeneration) return null;
      throw new Error("erasure purge authority job generation is corrupt");
    }
    if (control.activeAuthoritySha256 === undefined) {
      throw new Error("inactive erasure purge authority did not advance the evaluation build");
    }
    if (
      job.sealedAtMs === undefined
      || job.sealedAtMs !== authority.createdAtMs
      || job.updatedAtMs !== authority.createdAtMs
      || request.updatedAtMs > authority.createdAtMs
      || job.targetCount !== authority.targetCount
      || job.targetRootSha256 !== authority.targetRootSha256
    ) throw new Error("erasure purge authority job is corrupt");
    const state = this.memoryErasurePolicyEvaluationState(request, job, authority.createdAtMs);
    if (!state.policy) return null;
    if (
      state.decision !== "eligible_execution_disabled"
      || state.policy.policyVersion !== authority.policyVersion
      || state.policy.policySha256 !== authority.policySha256
      || state.policy.schemaVersion !== authority.policySchemaVersion
      || state.userGraceDeadlineMs !== authority.userGraceDeadlineMs
      || state.eligibilityDeadlineMs !== authority.eligibilityDeadlineMs
      || authority.createdAtMs < authority.eligibilityDeadlineMs
      || state.tenantHold.controlGeneration !== authority.tenantHoldControlGeneration
      || state.tenantHold.activeProjectionSha256 !== authority.tenantHoldProjectionSha256
      || state.userHold.controlGeneration !== authority.userHoldControlGeneration
      || state.userHold.activeProjectionSha256 !== authority.userHoldProjectionSha256
      || state.targets.length !== authority.targetCount
      || !this.memoryErasurePurgeInventoryMatches(request, job, state.policy)
    ) return null;
    // A hold set+release ABA leaves active_count at zero but advances this exact generation fence.
    return clone(authority);
  }

  async getErasureCompletionReadiness(requestId: string): Promise<ErasureCompletionReadiness> {
    const authority = await this.getValidatedErasurePurgeAuthority(requestId);
    return clone({
      requestId,
      complete: false,
      missing: [
        "purge_execution_disabled",
        "trusted_clock_linearization",
        "session_content_receipts",
        "ready_blob_physical_acks",
        "operational_usage_anonymization",
        "idempotency_receipt_deletion",
        "redis_cleanup",
        "provider_secret_revocation",
        "restore_ledger_ack",
      ],
      ...(authority === null ? {} : { authority }),
    });
  }

  private activeLegacyTombstoneCutover(): LegacyTombstoneCutoverRecord {
    const cutover = this.legacyTombstoneCutovers.get(LEGACY_TOMBSTONE_CUTOVER_ID);
    if (!cutover) throw new LegacyTombstoneCutoverRequiredError();
    validateLegacyTombstoneCutoverRecord(cutover);
    return cutover;
  }

  async getLegacyTombstoneCutover(): Promise<LegacyTombstoneCutoverRecord | null> {
    const cutover = this.legacyTombstoneCutovers.get(LEGACY_TOMBSTONE_CUTOVER_ID);
    if (!cutover) return null;
    validateLegacyTombstoneCutoverRecord(cutover);
    return clone(cutover);
  }

  async activateLegacyTombstoneCutover(
    input: ActivateLegacyTombstoneCutoverInput,
  ): Promise<LegacyTombstoneCutoverRecord> {
    const stagedInput = clone(input);
    validateActivateLegacyTombstoneCutoverInput(stagedInput);
    const existing = this.legacyTombstoneCutovers.get(LEGACY_TOMBSTONE_CUTOVER_ID);
    if (existing) {
      validateLegacyTombstoneCutoverRecord(existing);
      if (
        existing.activatedByKeyId === stagedInput.actorKeyId
        && existing.activatedAtMs === stagedInput.atMs
      ) return clone(existing);
      throw new LegacyTombstoneCutoverConflictError();
    }
    const record = clone<LegacyTombstoneCutoverRecord>({
      cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
      generation: 1,
      activatedByKeyId: stagedInput.actorKeyId,
      activatedAtMs: stagedInput.atMs,
    });
    validateLegacyTombstoneCutoverRecord(record);
    this.legacyTombstoneCutovers.set(LEGACY_TOMBSTONE_CUTOVER_ID, record);
    return clone(record);
  }

  private assertLegacyTombstoneCandidate(
    sessionKey: string,
    session: Session | undefined,
    legacyDeletedAtMs?: number,
  ): asserts session is Session {
    if (
      !session
      || sessionKey !== session.id
      || !SessionSchema.safeParse(session).success
      || !Number.isSafeInteger(legacyDeletedAtMs)
      || legacyDeletedAtMs! < 0
      || legacyDeletedAtMs! < session.createdAtMs
      || legacyDeletedAtMs! < session.updatedAtMs
    ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
    const marker = this.deleted.get(sessionKey);
    if (
      !marker
      || marker.deletionGeneration !== 0
      || marker.deletedAtMs !== legacyDeletedAtMs
      || marker.purgeAfterMs !== undefined
    ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
  }

  private existingLegacyTombstoneJobForSession(
    sessionId: string,
  ): LegacyTombstoneCompensationJobRecord | undefined {
    let existing: LegacyTombstoneCompensationJobRecord | undefined;
    for (const record of this.legacyTombstoneCompensationJobs.values()) {
      if (record.sessionId !== sessionId) continue;
      if (this.legacyTombstoneJobHasTerminalAudit(record.jobId)) return record;
      validateLegacyTombstoneCompensationJobRecord(record);
      if (existing) throw new LegacyTombstoneJobConflictError();
      existing = record;
    }
    return existing;
  }

  async scheduleLegacyTombstoneCompensation(
    authorization: ErasureWriteAuthorization,
    input: ScheduleLegacyTombstoneCompensationInput,
  ): Promise<LegacyTombstoneCompensationJobRecord> {
    this.activeLegacyTombstoneCutover();
    const stagedAuthorization = clone(authorization);
    const stagedInput = clone(input);
    validateScheduleLegacyTombstoneCompensationInput(stagedInput);
    this.assertErasureSessionAuthority(stagedAuthorization, ["reconciling_usage"], stagedInput.atMs);
    const deterministicJobId = legacyTombstoneCompensationJobIdForSession(stagedInput.sessionId);
    if (stagedInput.jobId !== deterministicJobId) throw new LegacyTombstoneJobConflictError();

    const byJobId = this.legacyTombstoneCompensationJobs.get(stagedInput.jobId);
    if (!byJobId && this.legacyTombstoneJobHasTerminalAudit(stagedInput.jobId)) {
      // A content-free incident may deliberately have no owner-readable job projection because the
      // historical candidate identity itself was unsafe. Never recreate worker authority over it.
      throw new LegacyTombstoneJobConflictError();
    }
    const bySession = this.existingLegacyTombstoneJobForSession(stagedInput.sessionId);
    const existing = byJobId ?? bySession;
    if (existing) {
      validateLegacyTombstoneCompensationJobRecord(existing);
      if (
        existing === byJobId
        && existing === bySession
        && existing.tenantId === stagedAuthorization.tenantId
        && existing.userId === stagedAuthorization.userId
        && existing.sessionId === stagedInput.sessionId
        && (
          existing.sourceKind === "maintenance"
          || (
            existing.sourceRequestId === stagedAuthorization.requestId
            && existing.sourceSubjectGeneration === stagedAuthorization.subjectGeneration
          )
        )
      ) return clone(existing);
      throw new LegacyTombstoneJobConflictError();
    }

    const session = this.sessions.get(stagedInput.sessionId);
    if (
      !session
      || session.tenantId !== stagedAuthorization.tenantId
      || session.userId !== stagedAuthorization.userId
    ) throw new SessionGoneError(stagedInput.sessionId);
    const marker = this.deleted.get(stagedInput.sessionId);
    this.assertLegacyTombstoneCandidate(stagedInput.sessionId, session, marker?.deletedAtMs);
    if (stagedInput.atMs < marker!.deletedAtMs) {
      throw new Error("legacy tombstone scheduling precedes the historical deletion");
    }
    const expectedSourceHash = legacyTombstoneClaimTokenSha256(stagedAuthorization.claimToken);

    const record = clone<LegacyTombstoneCompensationJobRecord>({
      jobId: stagedInput.jobId,
      tenantId: session.tenantId,
      userId: session.userId,
      sessionId: session.id,
      sourceKind: "erasure_claim",
      sourceRequestId: stagedAuthorization.requestId,
      sourceSubjectGeneration: stagedAuthorization.subjectGeneration,
      sourceClaimAttempt: stagedAuthorization.claimAttempt,
      sourceClaimTokenSha256: expectedSourceHash,
      cutoverGeneration: 1,
      legacyDeletedAtMs: marker!.deletedAtMs,
      status: "pending",
      createdAtMs: stagedInput.atMs,
      updatedAtMs: stagedInput.atMs,
      availableAtMs: stagedInput.availableAtMs,
      attempts: 0,
    });
    validateLegacyTombstoneCompensationJobRecord(record);
    const existed = this.legacyTombstoneCompensationJobs.has(record.jobId);
    const previous = this.legacyTombstoneCompensationJobs.get(record.jobId);
    try {
      this.legacyTombstoneCompensationJobs.set(record.jobId, record);
    } catch (error) {
      restoreMapEntry(this.legacyTombstoneCompensationJobs, record.jobId, existed, previous);
      throw error;
    }
    return clone(record);
  }

  private legacyTombstoneSessionDepth(sessionId: string): number {
    let depth = 0;
    let current = this.sessions.get(sessionId);
    const visited = new Set<string>();
    while (current?.parentSessionId !== undefined) {
      if (visited.has(current.id) || current.parentSessionId === current.id) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      visited.add(current.id);
      const parent = this.sessions.get(current.parentSessionId);
      if (!parent) break;
      current = parent;
      depth += 1;
    }
    return depth;
  }

  private terminallyIsolateLegacyTombstoneCandidate(
    sessionId: string,
    session: Session | undefined,
    rawDeletedAtMs: unknown,
    options: ScheduleLegacyTombstoneCandidatesOptions,
    reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">,
  ): void {
    const canonicalSessionId = isCanonicalId("sess", sessionId);
    const jobId = canonicalSessionId
      ? legacyTombstoneCompensationJobIdForSession(sessionId)
      : (() => {
          const hex = createHash("sha256")
            .update(JSON.stringify(["legacy-tombstone-compensation-job-v1", sessionId]))
            .digest("hex")
            .slice(0, 32)
            .split("");
          hex[12] = "4";
          hex[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(hex[16]!, 16) % 4]!;
          const value = hex.join("");
          return `ltc_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
        })();
    if (this.legacyTombstoneJobHasTerminalAudit(jobId)) return;
    if (!Number.isSafeInteger(this.nextLegacyTombstoneAuditId) || this.nextLegacyTombstoneAuditId <= 0) {
      throw new Error("legacy tombstone audit sequence is exhausted");
    }
    const candidateEvidence = createHash("sha256").update(JSON.stringify([
      "legacy-tombstone-unsafe-candidate-v1",
      sessionId,
      String(session?.tenantId),
      String(session?.userId),
      String(rawDeletedAtMs),
      String(session?.lastSeq),
      reasonCode,
    ])).digest("hex");
    const incidentEvidence = createHash("sha256").update(JSON.stringify([
      "legacy-tombstone-candidate-incident-v1",
      jobId,
      sessionId,
      candidateEvidence,
      reasonCode,
      options.nowMs,
    ])).digest("hex");
    const incident = clone<LegacyTombstoneCompensationAudit>({
      auditId: this.nextLegacyTombstoneAuditId,
      jobId,
      type: "legacy_tombstone/terminal_incident",
      reasonCode,
      evidenceSha256: incidentEvidence,
      emittedAtMs: options.nowMs,
    });
    validateLegacyTombstoneCompensationAudit(incident);

    let terminalJob: LegacyTombstoneCompensationJobRecord | undefined;
    if (
      canonicalSessionId
      && session?.id === sessionId
      && typeof session.tenantId === "string"
      && session.tenantId.length > 0
      && session.tenantId.length <= 128
      && typeof session.userId === "string"
      && session.userId.length > 0
      && session.userId.length <= 128
      && Number.isSafeInteger(rawDeletedAtMs)
      && Number(rawDeletedAtMs) >= 0
      && options.nowMs >= Number(rawDeletedAtMs)
    ) {
      terminalJob = clone({
        jobId,
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId,
        sourceKind: "maintenance" as const,
        maintenanceActorKeyId: options.actorKeyId,
        cutoverGeneration: 1 as const,
        legacyDeletedAtMs: Number(rawDeletedAtMs),
        status: "terminal_incident" as const,
        createdAtMs: options.nowMs,
        updatedAtMs: options.nowMs,
        attempts: 0,
        terminalAtMs: options.nowMs,
        terminalReasonCode: reasonCode,
        terminalEvidenceSha256: incidentEvidence,
      });
      validateLegacyTombstoneCompensationJobRecord(terminalJob);
    }

    const jobExisted = this.legacyTombstoneCompensationJobs.has(jobId);
    const priorJob = this.legacyTombstoneCompensationJobs.get(jobId);
    const auditsExisted = this.legacyTombstoneCompensationAudits.has(jobId);
    const priorAudits = this.legacyTombstoneCompensationAudits.get(jobId);
    try {
      if (terminalJob) this.legacyTombstoneCompensationJobs.set(jobId, terminalJob);
      this.legacyTombstoneCompensationAudits.set(jobId, [incident]);
    } catch (error) {
      restoreMapEntry(this.legacyTombstoneCompensationAudits, jobId, auditsExisted, priorAudits);
      restoreMapEntry(this.legacyTombstoneCompensationJobs, jobId, jobExisted, priorJob);
      throw error;
    }
    this.nextLegacyTombstoneAuditId += 1;
  }

  async scheduleLegacyTombstoneCandidates(
    options: ScheduleLegacyTombstoneCandidatesOptions,
  ): Promise<LegacyTombstoneCompensationJobRecord[]> {
    const stagedOptions = clone(options);
    validateScheduleLegacyTombstoneCandidatesOptions(stagedOptions);
    const cutover = this.activeLegacyTombstoneCutover();
    if (cutover.generation !== stagedOptions.cutoverGeneration) {
      throw new LegacyTombstoneCutoverConflictError();
    }

    const candidates: Array<{ session: Session; deletedAtMs: number; depth: number }> = [];
    for (const [sessionId, marker] of this.deleted) {
      if (marker.deletionGeneration !== 0) continue;
      const deterministicJobId = isCanonicalId("sess", sessionId)
        ? legacyTombstoneCompensationJobIdForSession(sessionId)
        : undefined;
      if (
        (deterministicJobId !== undefined && (
          this.legacyTombstoneCompensationJobs.has(deterministicJobId)
          || this.legacyTombstoneJobHasTerminalAudit(deterministicJobId)
        ))
        || [...this.legacyTombstoneCompensationJobs.values()].some(
          (record) => String((record as unknown as { sessionId?: unknown }).sessionId) === sessionId,
        )
      ) continue;
      const session = this.sessions.get(sessionId);
      try {
        this.assertLegacyTombstoneCandidate(sessionId, session, marker.deletedAtMs);
        if (stagedOptions.nowMs < marker.deletedAtMs) {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
      } catch (error) {
        if (!(error instanceof LegacyTombstoneIntegrityFault)) throw error;
        this.terminallyIsolateLegacyTombstoneCandidate(
          sessionId,
          session,
          marker.deletedAtMs,
          stagedOptions,
          error.reasonCode,
        );
        continue;
      }
      let depth = 0;
      try {
        depth = this.legacyTombstoneSessionDepth(sessionId);
      } catch (error) {
        if (!(error instanceof LegacyTombstoneIntegrityFault)) throw error;
        // Persist a deterministic job even for a cyclic candidate. Completion owns the terminal
        // incident transaction; silently omitting it here would make the cutover sweep incomplete.
      }
      candidates.push({
        session,
        deletedAtMs: marker.deletedAtMs,
        depth,
      });
    }
    candidates.sort((left, right) => (
      right.depth - left.depth || left.session.id.localeCompare(right.session.id)
    ));

    const stagedJobs = candidates.slice(0, stagedOptions.limit).map(({ session, deletedAtMs }) => {
      const record = clone<LegacyTombstoneCompensationJobRecord>({
        jobId: legacyTombstoneCompensationJobIdForSession(session.id),
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId: session.id,
        sourceKind: "maintenance",
        maintenanceActorKeyId: stagedOptions.actorKeyId,
        cutoverGeneration: 1,
        legacyDeletedAtMs: deletedAtMs,
        status: "pending",
        createdAtMs: stagedOptions.nowMs,
        updatedAtMs: stagedOptions.nowMs,
        availableAtMs: stagedOptions.nowMs,
        attempts: 0,
      });
      validateLegacyTombstoneCompensationJobRecord(record);
      if (this.legacyTombstoneCompensationJobs.has(record.jobId)) {
        throw new LegacyTombstoneJobConflictError();
      }
      return record;
    });

    const prior = stagedJobs.map((record) => ({
      key: record.jobId,
      existed: this.legacyTombstoneCompensationJobs.has(record.jobId),
      value: this.legacyTombstoneCompensationJobs.get(record.jobId),
    }));
    try {
      for (const record of stagedJobs) {
        this.legacyTombstoneCompensationJobs.set(record.jobId, record);
      }
    } catch (error) {
      for (const entry of prior.reverse()) {
        restoreMapEntry(this.legacyTombstoneCompensationJobs, entry.key, entry.existed, entry.value);
      }
      throw error;
    }
    return stagedJobs.map(clone);
  }

  async getLegacyTombstoneCompensationJob(
    tenantId: string,
    userId: string,
    jobId: string,
  ): Promise<LegacyTombstoneCompensationJobRecord | null> {
    const record = this.legacyTombstoneCompensationJobs.get(jobId);
    if (!record || record.tenantId !== tenantId || record.userId !== userId) return null;
    validateLegacyTombstoneCompensationJobRecord(record);
    return clone(record);
  }

  async listLegacyTombstoneCompensationAudits(
    jobId: string,
  ): Promise<LegacyTombstoneCompensationAudit[]> {
    const audits = clone(this.legacyTombstoneCompensationAudits.get(jobId) ?? []);
    for (const audit of audits) validateLegacyTombstoneCompensationAudit(audit);
    return audits;
  }

  private terminallyIsolateUnsafeLegacyTombstoneJob(
    jobKey: string,
    current: LegacyTombstoneCompensationJobRecord,
    atMs: number,
  ): void {
    if ((this.legacyTombstoneCompensationAudits.get(jobKey) ?? []).some(
      (audit) => audit.type === "legacy_tombstone/terminal_incident",
    )) return;
    if (!Number.isSafeInteger(this.nextLegacyTombstoneAuditId) || this.nextLegacyTombstoneAuditId <= 0) {
      throw new Error("legacy tombstone audit sequence is exhausted");
    }
    const unsafe = current as unknown as Record<string, unknown>;
    const envelope: LegacyTombstoneUnsafeJobEnvelope = {
      locatorJobId: jobKey,
      jobId: String(unsafe.jobId),
      tenantId: String(unsafe.tenantId),
      userId: String(unsafe.userId),
      sessionId: String(unsafe.sessionId),
      sourceRequestId: unsafe.sourceRequestId === undefined ? null : String(unsafe.sourceRequestId),
      sourceKind: String(unsafe.sourceKind),
      rawSourceSubjectGeneration: unsafe.sourceSubjectGeneration === undefined
        ? null
        : String(unsafe.sourceSubjectGeneration),
      rawSourceClaimAttempt: unsafe.sourceClaimAttempt === undefined
        ? null
        : String(unsafe.sourceClaimAttempt),
      sourceClaimTokenSha256: unsafe.sourceClaimTokenSha256 === undefined
        ? null
        : String(unsafe.sourceClaimTokenSha256),
      maintenanceActorKeyId: unsafe.maintenanceActorKeyId === undefined
        ? null
        : String(unsafe.maintenanceActorKeyId),
      rawCutoverGeneration: String(unsafe.cutoverGeneration),
      rawLegacyDeletedAtMs: String(unsafe.legacyDeletedAtMs),
      status: String(unsafe.status),
      rawCreatedAtMs: String(unsafe.createdAtMs),
      rawUpdatedAtMs: String(unsafe.updatedAtMs),
      rawAvailableAtMs: unsafe.availableAtMs === undefined ? null : String(unsafe.availableAtMs),
      rawAttempts: String(unsafe.attempts),
      claimToken: unsafe.claimToken === undefined ? null : String(unsafe.claimToken),
      rawLeaseUntilMs: unsafe.leaseUntilMs === undefined ? null : String(unsafe.leaseUntilMs),
    };
    const incident = clone<LegacyTombstoneCompensationAudit>({
      auditId: this.nextLegacyTombstoneAuditId,
      jobId: jobKey,
      type: "legacy_tombstone/terminal_incident",
      reasonCode: "unsafe_job_envelope",
      evidenceSha256: legacyTombstoneUnsafeJobEnvelopeEvidenceSha256(envelope),
      emittedAtMs: atMs,
    });
    validateLegacyTombstoneCompensationAudit(incident);
    const existed = this.legacyTombstoneCompensationAudits.has(jobKey);
    const previous = this.legacyTombstoneCompensationAudits.get(jobKey);
    const staged = clone([...(previous ?? []), incident]);
    try {
      this.legacyTombstoneCompensationAudits.set(jobKey, staged);
    } catch (error) {
      restoreMapEntry(this.legacyTombstoneCompensationAudits, jobKey, existed, previous);
      throw error;
    }
    this.nextLegacyTombstoneAuditId += 1;
  }

  private legacyTombstoneJobHasTerminalAudit(jobId: string): boolean {
    return (this.legacyTombstoneCompensationAudits.get(jobId) ?? []).some((audit) => (
      audit.type === "legacy_tombstone/terminal_incident"
      || audit.type === "legacy_tombstone/compensated"
    ));
  }

  async claimLegacyTombstoneCompensations(
    options: ClaimLegacyTombstoneCompensationsOptions,
  ): Promise<LegacyTombstoneCompensationClaim[]> {
    const stagedOptions = clone(options);
    const leaseUntilMs = validateClaimLegacyTombstoneCompensationsOptions(stagedOptions);
    this.activeLegacyTombstoneCutover();
    const candidates = [...this.legacyTombstoneCompensationJobs.entries()]
      .filter(([jobKey, record]) => {
        if (this.legacyTombstoneJobHasTerminalAudit(jobKey)) return false;
        try {
          if (jobKey !== record.jobId) return true;
          validateLegacyTombstoneCompensationJobRecord(record);
          return record.status === "pending"
            && record.availableAtMs! <= stagedOptions.nowMs
            && (record.claimToken === undefined || record.leaseUntilMs! <= stagedOptions.nowMs);
        } catch {
          return true;
        }
      })
      .sort((left, right) => {
        const leftAvailable = Number.isSafeInteger(left[1].availableAtMs) ? left[1].availableAtMs! : -1;
        const rightAvailable = Number.isSafeInteger(right[1].availableAtMs) ? right[1].availableAtMs! : -1;
        let depthOrder = 0;
        try {
          depthOrder = this.legacyTombstoneSessionDepth(right[1].sessionId)
            - this.legacyTombstoneSessionDepth(left[1].sessionId);
        } catch {
          // Session-tree corruption is handled as a deterministic incident during completion. Job
          // envelope corruption itself is isolated below without trusting this ordering hint.
        }
        return depthOrder || leftAvailable - rightAvailable || left[0].localeCompare(right[0]);
      });

    const claimed: LegacyTombstoneCompensationJobRecord[] = [];
    for (const [jobKey, current] of candidates) {
      if (claimed.length >= stagedOptions.limit) break;
      try {
        try {
          if (jobKey !== current.jobId) throw new Error("job locator mismatch");
          validateLegacyTombstoneCompensationJobRecord(current);
        } catch {
          this.terminallyIsolateUnsafeLegacyTombstoneJob(jobKey, current, stagedOptions.nowMs);
          continue;
        }
        if (
          current.status !== "pending"
          || current.availableAtMs! > stagedOptions.nowMs
          || (current.claimToken !== undefined && current.leaseUntilMs! > stagedOptions.nowMs)
        ) continue;
        if (current.attempts === Number.MAX_SAFE_INTEGER) {
          this.terminallyIsolateUnsafeLegacyTombstoneJob(jobKey, current, stagedOptions.nowMs);
          continue;
        }
        const next = clone<LegacyTombstoneCompensationJobRecord>({
          ...current,
          attempts: current.attempts + 1,
          claimToken: stagedOptions.claimToken,
          leaseUntilMs,
        });
        validateLegacyTombstoneCompensationJobRecord(next);
        this.legacyTombstoneCompensationJobs.set(jobKey, next);
        claimed.push(next);
      } catch (error) {
        if (claimed.length > 0) break;
        throw error;
      }
    }
    return claimed.map((record) => clone(legacyTombstoneCompensationClaimFromRecord(record)));
  }

  async renewLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RenewLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    const leaseUntilMs = validateRenewLegacyTombstoneCompensationOptions(stagedOptions);
    this.activeLegacyTombstoneCutover();
    const current = this.legacyTombstoneCompensationJobs.get(stagedAuthorization.jobId);
    if (!current) return false;
    if (
      current.tenantId !== stagedAuthorization.tenantId
      || current.userId !== stagedAuthorization.userId
      || current.sessionId !== stagedAuthorization.sessionId
    ) return false;
    if (!legacyTombstoneCompensationAuthorizationMatches(current, stagedAuthorization, stagedOptions.nowMs)) {
      return false;
    }
    const next = clone(current);
    next.leaseUntilMs = Math.max(current.leaseUntilMs!, leaseUntilMs);
    validateLegacyTombstoneCompensationJobRecord(next);
    this.legacyTombstoneCompensationJobs.set(next.jobId, next);
    return true;
  }

  async retryLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RetryLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    validateRetryLegacyTombstoneCompensationOptions(stagedOptions);
    this.activeLegacyTombstoneCutover();
    const current = this.legacyTombstoneCompensationJobs.get(stagedAuthorization.jobId);
    if (!current) return false;
    if (
      current.tenantId !== stagedAuthorization.tenantId
      || current.userId !== stagedAuthorization.userId
      || current.sessionId !== stagedAuthorization.sessionId
    ) return false;
    if (!legacyTombstoneCompensationAuthorizationMatches(
      current,
      stagedAuthorization,
      stagedOptions.failedAtMs,
    )) return false;
    const next = clone(current);
    next.updatedAtMs = Math.max(current.updatedAtMs, stagedOptions.failedAtMs);
    next.availableAtMs = stagedOptions.availableAtMs;
    next.lastErrorCode = stagedOptions.errorCode;
    delete next.claimToken;
    delete next.leaseUntilMs;
    validateLegacyTombstoneCompensationJobRecord(next);
    this.legacyTombstoneCompensationJobs.set(next.jobId, next);
    return true;
  }

  private legacyTombstoneTerminalIncident(
    current: LegacyTombstoneCompensationJobRecord,
    authorization: LegacyTombstoneCompensationAuthorization,
    atMs: number,
    reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">,
  ): LegacyTombstoneCompensationResult {
    if (!Number.isSafeInteger(this.nextLegacyTombstoneAuditId) || this.nextLegacyTombstoneAuditId <= 0) {
      throw new Error("legacy tombstone audit sequence is exhausted");
    }
    const emittedAtMs = Math.max(current.updatedAtMs, atMs);
    const evidenceSha256 = legacyTombstoneTerminalIncidentEvidenceSha256({
      jobId: current.jobId,
      sessionId: current.sessionId,
      cutoverGeneration: current.cutoverGeneration,
      legacyDeletedAtMs: current.legacyDeletedAtMs,
      claimAttempt: authorization.claimAttempt,
      reasonCode,
    });
    const next = clone(current);
    next.status = "terminal_incident";
    next.updatedAtMs = emittedAtMs;
    next.terminalAtMs = emittedAtMs;
    next.terminalReasonCode = reasonCode;
    next.terminalEvidenceSha256 = evidenceSha256;
    delete next.availableAtMs;
    delete next.claimToken;
    delete next.leaseUntilMs;
    delete next.lastErrorCode;
    validateLegacyTombstoneCompensationJobRecord(next);

    const priorAudits = this.legacyTombstoneCompensationAudits.get(current.jobId);
    if ((priorAudits ?? []).length > 0) {
      throw new Error("legacy tombstone terminal audit identity already exists");
    }
    const incident = clone<LegacyTombstoneCompensationAudit>({
      auditId: this.nextLegacyTombstoneAuditId,
      jobId: current.jobId,
      type: "legacy_tombstone/terminal_incident",
      reasonCode,
      evidenceSha256,
      emittedAtMs,
    });
    validateLegacyTombstoneCompensationAudit(incident);

    const jobExisted = this.legacyTombstoneCompensationJobs.has(current.jobId);
    const priorJob = this.legacyTombstoneCompensationJobs.get(current.jobId);
    const auditsExisted = this.legacyTombstoneCompensationAudits.has(current.jobId);
    try {
      this.legacyTombstoneCompensationJobs.set(current.jobId, next);
      this.legacyTombstoneCompensationAudits.set(current.jobId, [incident]);
    } catch (error) {
      restoreMapEntry(
        this.legacyTombstoneCompensationAudits,
        current.jobId,
        auditsExisted,
        priorAudits,
      );
      restoreMapEntry(
        this.legacyTombstoneCompensationJobs,
        current.jobId,
        jobExisted,
        priorJob,
      );
      throw error;
    }
    this.nextLegacyTombstoneAuditId += 1;
    return { outcome: "terminal_incident", jobId: current.jobId, reasonCode, evidenceSha256 };
  }

  private assertCompletedLegacyTombstoneCompensation(
    job: LegacyTombstoneCompensationJobRecord,
  ): LegacyTombstoneCompensationResult {
    validateLegacyTombstoneCompensationJobRecord(job);
    if (
      job.status !== "completed"
      || job.completedAtMs === undefined
      || job.completedEventSeq === undefined
      || job.completedClaimAttempt === undefined
    ) throw new Error("legacy tombstone compensation is not completed");
    const session = this.sessions.get(job.sessionId);
    const marker = this.deleted.get(job.sessionId);
    if (
      !session
      || session.id !== job.sessionId
      || session.tenantId !== job.tenantId
      || session.userId !== job.userId
      || !marker
      || marker.deletedAtMs !== job.legacyDeletedAtMs
      || marker.deletionGeneration !== 1
      || marker.purgeAfterMs !== undefined
    ) throw new Error("completed legacy tombstone marker is corrupt");
    this.assertExistingErasureTombstone(session, marker);
    const terminal = this.events.get(job.sessionId)?.at(-1);
    if (terminal?.type !== "session/deleted" || terminal.seq !== job.completedEventSeq) {
      throw new Error("completed legacy tombstone terminal event is corrupt");
    }
    const audits = this.legacyTombstoneCompensationAudits.get(job.jobId) ?? [];
    if (audits.length !== 1) throw new Error("completed legacy tombstone audit is corrupt");
    const audit = audits[0]!;
    validateLegacyTombstoneCompensationAudit(audit);
    if (
      audit.type !== "legacy_tombstone/compensated"
      || audit.sessionId !== job.sessionId
      || audit.cutoverGeneration !== job.cutoverGeneration
      || audit.deletionGeneration !== 1
      || audit.eventSeq !== job.completedEventSeq
      || audit.claimAttempt !== job.completedClaimAttempt
      || audit.emittedAtMs !== job.completedAtMs
      || audit.evidenceSha256 !== legacyTombstoneSuccessEvidenceSha256({
        jobId: job.jobId,
        tenantId: job.tenantId,
        userId: job.userId,
        sessionId: job.sessionId,
        cutoverGeneration: job.cutoverGeneration,
        legacyDeletedAtMs: job.legacyDeletedAtMs,
        deletionGeneration: 1,
        eventSeq: job.completedEventSeq,
        claimAttempt: job.completedClaimAttempt,
        emittedAtMs: job.completedAtMs,
      })
    ) throw new Error("completed legacy tombstone audit is corrupt");
    return {
      outcome: "already_compensated",
      sessionId: job.sessionId,
      deletionGeneration: 1,
      eventSeq: job.completedEventSeq,
    };
  }

  private assertLegacyTombstoneChildrenResolved(parent: Session): void {
    const ancestry = new Set<string>();
    let current: Session | undefined = parent;
    while (current) {
      if (ancestry.has(current.id)) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      ancestry.add(current.id);
      if (current.parentSessionId === undefined) break;
      const ancestor = this.sessions.get(current.parentSessionId);
      if (
        !ancestor
        || ancestor.id !== current.parentSessionId
        || ancestor.tenantId !== parent.tenantId
        || ancestor.userId !== parent.userId
        || !SessionSchema.safeParse(ancestor).success
      ) throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      current = ancestor;
    }

    for (const [childKey, child] of this.sessions) {
      if (child.parentSessionId !== parent.id) continue;
      if (
        childKey !== child.id
        || child.tenantId !== parent.tenantId
        || child.userId !== parent.userId
        || !SessionSchema.safeParse(child).success
      ) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      const childMarker = this.deleted.get(child.id);
      if (!childMarker) {
        // A live child is not compensation work and can never become resolved through this queue.
        // Treat the historical parent/child ordering violation as permanent integrity failure.
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      if (childMarker.deletionGeneration === 0) {
        const expectedJobId = legacyTombstoneCompensationJobIdForSession(child.id);
        const matchingJobs = [...this.legacyTombstoneCompensationJobs.entries()].filter(
          ([jobKey, record]) => jobKey === expectedJobId || record.sessionId === child.id,
        );
        const expectedAudits = this.legacyTombstoneCompensationAudits.get(expectedJobId) ?? [];
        if (matchingJobs.length === 0) {
          if (expectedAudits.length === 0) {
            throw new LegacyTombstoneChildPendingError(parent.id);
          }
          throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
        }
        if (matchingJobs.length !== 1) {
          throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
        }
        const [jobKey, childJob] = matchingJobs[0]!;
        const childAudits = this.legacyTombstoneCompensationAudits.get(jobKey) ?? [];
        try {
          validateLegacyTombstoneCompensationJobRecord(childJob);
          if (
            jobKey !== expectedJobId
            || childJob.jobId !== expectedJobId
            || childJob.sessionId !== child.id
            || childJob.tenantId !== parent.tenantId
            || childJob.userId !== parent.userId
            || childJob.legacyDeletedAtMs !== childMarker.deletedAtMs
          ) throw new Error("legacy child job binding mismatch");
        } catch {
          throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
        }
        if (childJob.status === "pending" && childAudits.length === 0) {
          throw new LegacyTombstoneChildPendingError(parent.id);
        }
        // A completed child cannot still have generation zero. A terminal/proof incident is also
        // permanent, so retrying the parent as child_pending would create an infinite loop.
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      try {
        this.assertExistingErasureTombstone(child, childMarker);
      } catch (error) {
        if (error instanceof DOMException && error.name === "DataCloneError") throw error;
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
    }
  }

  async completeLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: CompleteLegacyTombstoneCompensationOptions,
  ): Promise<LegacyTombstoneCompensationResult | null> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    validateCompleteLegacyTombstoneCompensationOptions(stagedOptions);
    this.activeLegacyTombstoneCutover();
    const current = this.legacyTombstoneCompensationJobs.get(stagedAuthorization.jobId);
    if (!current) return null;
    if (
      current.tenantId !== stagedAuthorization.tenantId
      || current.userId !== stagedAuthorization.userId
      || current.sessionId !== stagedAuthorization.sessionId
      || current.cutoverGeneration !== stagedAuthorization.cutoverGeneration
    ) return null;
    validateLegacyTombstoneCompensationJobRecord(current);
    if (current.status === "completed") {
      if (
        current.completedClaimAttempt !== stagedAuthorization.claimAttempt
        || current.completedClaimTokenSha256
          !== legacyTombstoneClaimTokenSha256(stagedAuthorization.claimToken)
      ) return null;
      return this.assertCompletedLegacyTombstoneCompensation(current);
    }
    if (!legacyTombstoneCompensationAuthorizationMatches(
      current,
      stagedAuthorization,
      stagedOptions.completedAtMs,
    )) return null;

    try {
      const session = this.sessions.get(current.sessionId);
      if (
        !session
        || session.id !== current.sessionId
        || session.tenantId !== current.tenantId
        || session.userId !== current.userId
      ) throw new LegacyTombstoneIntegrityFault("owner_binding_invalid");
      const marker = this.deleted.get(current.sessionId);
      this.assertLegacyTombstoneCandidate(current.sessionId, session, marker?.deletedAtMs);
      if (marker!.deletedAtMs !== current.legacyDeletedAtMs) {
        throw new LegacyTombstoneIntegrityFault("proof_conflict");
      }
      this.assertLegacyTombstoneChildrenResolved(session);
      if (
        this.usageReconciliations.has(this.usageReconciliationMapKey(current.sessionId, 1))
        || this.lifecycleOutbox.has(this.lifecycleOutboxMapKey("session.tombstoned", current.sessionId, 1))
        || this.lifecycleOutbox.has(this.lifecycleOutboxMapKey("session.purge", current.sessionId, 1))
        || (this.legacyTombstoneCompensationAudits.get(current.jobId) ?? []).length > 0
      ) throw new LegacyTombstoneIntegrityFault("proof_conflict");

      const rawLog = this.events.get(current.sessionId);
      if (!rawLog) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      // An uncloneable value is an unknown serialization failure, not evidence that may be turned
      // into an irreversible incident. It must escape with the entire claimed job unchanged.
      const stagedLog = clone(rawLog);
      if (stagedLog.length !== session.lastSeq || stagedLog.some((event, index) => (
        event.sessionId !== session.id
        || event.seq !== index + 1
        || !EventSchema.safeParse(event).success
        || event.emittedAtMs > current.legacyDeletedAtMs
        || event.type === "session/deleted"
      ))) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");

      const deletedAtMs = marker!.deletedAtMs;
      const stagedSession = clone(session);
      const pendingApprovals = [...this.approvals.values()].filter((approval) => (
        approval.sessionId === session.id && approval.status === "pending"
      ));
      if (pendingApprovals.some((approval) => approval.createdAtMs > deletedAtMs)) {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }

      let approvalTerminals: ReturnType<MemorySessionStore["stageErasureApprovalTerminals"]>;
      try {
        approvalTerminals = this.stageErasureApprovalTerminals(session.id, deletedAtMs);
      } catch (error) {
        if (error instanceof DOMException && error.name === "DataCloneError") throw error;
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }
      const eventInputs: EventInput[] = [...approvalTerminals.events];
      let stagedTurn: Turn | undefined;
      const terminalEventCount = eventInputs.length
        + (stagedSession.status.type === "active" ? 3 : 1);
      const terminalSeq = stagedSession.lastSeq + terminalEventCount;
      if (
        !Number.isSafeInteger(terminalSeq)
        || terminalSeq <= stagedSession.lastSeq
      ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      if (stagedSession.status.type === "active") {
        const turn = this.turns.get(stagedSession.status.turnId);
        if (
          !turn
          || turn.id !== stagedSession.status.turnId
          || turn.sessionId !== stagedSession.id
          || turn.status !== "inProgress"
          || turn.startedAtMs > deletedAtMs
          || !TurnSchema.safeParse(turn).success
        ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        stagedTurn = clone({
          ...turn,
          status: "interrupted" as const,
          stopReason: "interrupted" as const,
          completedAtMs: deletedAtMs,
          error: {
            code: "legacy_tombstone_compensation",
            message: "turn interrupted during legacy tombstone compensation",
          },
          seqEnd: terminalSeq - 1,
        });
        if (!TurnSchema.safeParse(stagedTurn).success) {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        eventInputs.push(clone({
          type: "turn/completed",
          sessionId: session.id,
          emittedAtMs: deletedAtMs,
          turn: stagedTurn,
          stopReason: "interrupted",
        }));
        eventInputs.push(clone({
          type: "session/status/changed",
          sessionId: session.id,
          emittedAtMs: deletedAtMs,
          status: { type: "idle" },
        }));
        stagedSession.status = { type: "idle" };
      }
      eventInputs.push(clone({
        type: "session/deleted",
        sessionId: session.id,
        emittedAtMs: deletedAtMs,
        deletionGeneration: 1,
      }));
      const stagedEvents = eventInputs.map((event, index) => clone({
        ...event,
        seq: stagedSession.lastSeq + index + 1,
      } as PersistedEvent));
      if (stagedEvents.some((event) => !EventSchema.safeParse(event).success)) {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }
      const terminal = stagedEvents.at(-1);
      if (terminal?.type !== "session/deleted") {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }
      stagedSession.lastSeq = terminal.seq;
      stagedSession.updatedAtMs = Math.max(session.updatedAtMs, stagedOptions.completedAtMs);
      stagedSession.autoApprovedTools = [];
      if (!SessionSchema.safeParse(stagedSession).success) {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }
      const nextLog = clone([...stagedLog, ...stagedEvents]);

      if (
        !Number.isSafeInteger(this.nextLifecycleOutboxId)
        || this.nextLifecycleOutboxId <= 0
        || this.nextLifecycleOutboxId > Number.MAX_SAFE_INTEGER - 2
      ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
      if (!Number.isSafeInteger(this.nextLegacyTombstoneAuditId) || this.nextLegacyTombstoneAuditId <= 0) {
        throw new LegacyTombstoneIntegrityFault("proof_conflict");
      }
      const completedAtMs = Math.max(current.updatedAtMs, stagedOptions.completedAtMs);
      const outboxes = ([
        {
          outboxId: this.nextLifecycleOutboxId,
          topic: "session.tombstoned",
          aggregateId: session.id,
          generation: 1,
          payload: { sessionId: session.id, deletionGeneration: 1, eventSeq: terminal.seq },
          availableAtMs: completedAtMs,
          attempts: 0,
          createdAtMs: completedAtMs,
        },
        {
          outboxId: this.nextLifecycleOutboxId + 1,
          topic: "session.purge",
          aggregateId: session.id,
          generation: 1,
          payload: { sessionId: session.id, deletionGeneration: 1 },
          attempts: 0,
          createdAtMs: completedAtMs,
        },
      ] satisfies LifecycleOutboxRecord[]).map(clone);
      const stagedOutboxes = outboxes.map((outbox) => {
        assertLifecycleOutboxId(outbox.outboxId);
        parseLifecycleOutboxEnvelope(outbox.topic, clone(outbox.payload));
        const key = this.lifecycleOutboxMapKey(outbox.topic, session.id, 1);
        if (
          this.lifecycleOutbox.has(key)
          || [...this.lifecycleOutbox.values()].some((candidate) => candidate.outboxId === outbox.outboxId)
        ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
        return [key, outbox] as const;
      });

      const successEvidence = legacyTombstoneSuccessEvidenceSha256({
        jobId: current.jobId,
        tenantId: current.tenantId,
        userId: current.userId,
        sessionId: current.sessionId,
        cutoverGeneration: 1,
        legacyDeletedAtMs: current.legacyDeletedAtMs,
        deletionGeneration: 1,
        eventSeq: terminal.seq,
        claimAttempt: stagedAuthorization.claimAttempt,
        emittedAtMs: completedAtMs,
      });
      const audit = clone<LegacyTombstoneCompensationAudit>({
        auditId: this.nextLegacyTombstoneAuditId,
        jobId: current.jobId,
        type: "legacy_tombstone/compensated",
        sessionId: current.sessionId,
        cutoverGeneration: 1,
        deletionGeneration: 1,
        eventSeq: terminal.seq,
        claimAttempt: stagedAuthorization.claimAttempt,
        evidenceSha256: successEvidence,
        emittedAtMs: completedAtMs,
      });
      validateLegacyTombstoneCompensationAudit(audit);
      const nextJob = clone(current);
      nextJob.status = "completed";
      nextJob.updatedAtMs = completedAtMs;
      nextJob.completedAtMs = completedAtMs;
      nextJob.completedEventSeq = terminal.seq;
      nextJob.completedClaimAttempt = stagedAuthorization.claimAttempt;
      nextJob.completedClaimTokenSha256 = legacyTombstoneClaimTokenSha256(
        stagedAuthorization.claimToken,
      );
      delete nextJob.availableAtMs;
      delete nextJob.claimToken;
      delete nextJob.leaseUntilMs;
      delete nextJob.lastErrorCode;
      validateLegacyTombstoneCompensationJobRecord(nextJob);
      const nextMarker = clone({ deletedAtMs, deletionGeneration: 1 });

      const sessionExisted = this.sessions.has(session.id);
      const priorSession = this.sessions.get(session.id);
      const eventExisted = this.events.has(session.id);
      const priorEvents = this.events.get(session.id);
      const deletedExisted = this.deleted.has(session.id);
      const priorDeleted = this.deleted.get(session.id);
      const jobExisted = this.legacyTombstoneCompensationJobs.has(current.jobId);
      const priorJob = this.legacyTombstoneCompensationJobs.get(current.jobId);
      const auditExisted = this.legacyTombstoneCompensationAudits.has(current.jobId);
      const priorAudits = this.legacyTombstoneCompensationAudits.get(current.jobId);
      const turnExisted = stagedTurn === undefined ? false : this.turns.has(stagedTurn.id);
      const priorTurn = stagedTurn === undefined ? undefined : this.turns.get(stagedTurn.id);
      const approvalPrior = approvalTerminals.approvals.map((approval) => ({
        id: approval.id,
        existed: this.approvals.has(approval.id),
        value: this.approvals.get(approval.id),
      }));
      const itemPrior = approvalTerminals.items.map((item) => ({
        id: item.id,
        existed: this.items.has(item.id),
        value: this.items.get(item.id),
      }));
      const outboxPrior = stagedOutboxes.map(([key]) => ({
        key,
        existed: this.lifecycleOutbox.has(key),
        value: this.lifecycleOutbox.get(key),
      }));
      try {
        this.sessions.set(session.id, stagedSession);
        if (stagedTurn) this.turns.set(stagedTurn.id, stagedTurn);
        for (const approval of approvalTerminals.approvals) this.approvals.set(approval.id, approval);
        for (const item of approvalTerminals.items) this.items.set(item.id, item);
        this.events.set(session.id, nextLog);
        this.deleted.set(session.id, nextMarker);
        for (const [key, outbox] of stagedOutboxes) this.lifecycleOutbox.set(key, outbox);
        this.legacyTombstoneCompensationAudits.set(current.jobId, [audit]);
        this.legacyTombstoneCompensationJobs.set(current.jobId, nextJob);
      } catch (error) {
        restoreMapEntry(
          this.legacyTombstoneCompensationJobs,
          current.jobId,
          jobExisted,
          priorJob,
        );
        restoreMapEntry(
          this.legacyTombstoneCompensationAudits,
          current.jobId,
          auditExisted,
          priorAudits,
        );
        for (const entry of outboxPrior.reverse()) {
          restoreMapEntry(this.lifecycleOutbox, entry.key, entry.existed, entry.value);
        }
        restoreMapEntry(this.deleted, session.id, deletedExisted, priorDeleted);
        restoreMapEntry(this.events, session.id, eventExisted, priorEvents);
        for (const entry of itemPrior.reverse()) {
          restoreMapEntry(this.items, entry.id, entry.existed, entry.value);
        }
        for (const entry of approvalPrior.reverse()) {
          restoreMapEntry(this.approvals, entry.id, entry.existed, entry.value);
        }
        if (stagedTurn) restoreMapEntry(this.turns, stagedTurn.id, turnExisted, priorTurn);
        restoreMapEntry(this.sessions, session.id, sessionExisted, priorSession);
        throw error;
      }
      this.nextLifecycleOutboxId += 2;
      this.nextLegacyTombstoneAuditId += 1;
      return {
        outcome: "compensated",
        sessionId: session.id,
        deletionGeneration: 1,
        eventSeq: terminal.seq,
      };
    } catch (error) {
      if (error instanceof LegacyTombstoneChildPendingError) throw error;
      if (!(error instanceof LegacyTombstoneIntegrityFault)) throw error;
      return this.legacyTombstoneTerminalIncident(
        current,
        stagedAuthorization,
        stagedOptions.completedAtMs,
        error.reasonCode,
      );
    }
  }

  private subjectRecord(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): SubjectLifecycleRecord | undefined {
    return this.subjectLifecycles.get(subjectLifecycleKey(tenantId, subjectKind, subjectId));
  }

  private tenantErasureAdmission(tenantId: string): ErasureRequestRecord | undefined {
    return [...this.tenantErasureAdmissions.values()].find((request) => request.tenantId === tenantId);
  }

  private hasTenantErasureAuthorityFence(tenantId: string): boolean {
    return this.tenantErasureAdmission(tenantId) !== undefined
      || this.tenantCredentialRevocationFences.has(tenantId);
  }

  async getTenantRuntimeState(tenantId: string): Promise<TenantRuntimeState> {
    if (!tenantId || tenantId.length > 128) throw new Error("invalid tenant id");
    const lifecycle = this.subjectRecord(tenantId, "tenant", tenantId);
    const admission = this.tenantErasureAdmission(tenantId);
    const fence = this.tenantCredentialRevocationFences.get(tenantId);
    if (admission) validateErasureRequestRecordForRead(admission);
    if (fence) validateTenantCredentialRevocationFence(fence);
    if (!lifecycle) {
      if (admission || fence) throw new Error("tenant lifecycle gate is missing for an existing erasure admission");
      return { tenantId, state: "active", generation: 0 };
    }
    if (
      (lifecycle.state === "active" && (admission !== undefined || fence !== undefined))
      || (lifecycle.state !== "active" && (
        !admission
        || !fence
        || admission.requestId !== lifecycle.activeRequestId
        || admission.generation !== lifecycle.generation
        || fence.requestId !== lifecycle.activeRequestId
        || fence.subjectGeneration !== lifecycle.generation
      ))
    ) throw new Error("tenant lifecycle and credential fence do not agree");
    return clone({
      tenantId,
      state: lifecycle.state,
      generation: lifecycle.generation,
      ...(lifecycle.activeRequestId === undefined
        ? {}
        : { activeRequestId: lifecycle.activeRequestId }),
    });
  }

  private assertTenantWritable(tenantId: string): SubjectLifecycleRecord | undefined {
    const tenant = this.subjectRecord(tenantId, "tenant", tenantId);
    const admission = this.tenantErasureAdmission(tenantId);
    if (!tenant && (
      this.tenantCredentialRevocationFences.has(tenantId)
      || admission !== undefined
    )) throw new SubjectDeletingError(tenantId);
    if (
      (tenant && tenant.state !== "active")
      || admission !== undefined
      || this.tenantCredentialRevocationFences.has(tenantId)
    ) throw new SubjectDeletingError(tenantId);
    return tenant;
  }

  private isTenantActive(tenantId: string): boolean {
    const tenant = this.subjectRecord(tenantId, "tenant", tenantId);
    if (this.hasTenantErasureAuthorityFence(tenantId)) return false;
    return (tenant?.state ?? "active") === "active";
  }

  private isSubjectActive(tenantId: string, userId: string): boolean {
    const user = this.subjectRecord(tenantId, "user", userId);
    if (!user && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "user" && request.subjectId === userId
    ))) return false;
    return this.isTenantActive(tenantId) && (user?.state ?? "active") === "active";
  }

  private isUserDataExportSubjectCurrent(request: UserDataExportRequestRecord): boolean {
    if (!this.isSubjectActive(request.tenantId, request.userId)) return false;
    const user = this.subjectRecord(request.tenantId, "user", request.userId);
    return (user?.generation ?? 0) === request.subjectGeneration;
  }

  private assertSubjectWritable(tenantId: string, userId: string): void {
    this.assertTenantWritable(tenantId);
    const user = this.subjectRecord(tenantId, "user", userId);
    if (!user && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "user" && request.subjectId === userId
    ))) throw new SubjectDeletingError(tenantId, userId);
    if (user && user.state !== "active") throw new SubjectDeletingError(tenantId, userId);
  }

  private isSessionVisible(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !this.deleted.has(sessionId) && this.isSubjectActive(session.tenantId, session.userId);
  }

  private usageProjectionRows(sessionId: string, turnId?: string) {
    return this.usageLedger.filter((row) => (
      row.sessionId === sessionId && (turnId === undefined || row.turnId === turnId)
    ));
  }

  private sessionForRead(session: Session): Session {
    const projected = clone(session);
    projected.usage = canonicalUsageProjection(
      projected.usage,
      this.usageProjectionRows(projected.id),
      { tenantId: projected.tenantId, userId: projected.userId },
    );
    return projected;
  }

  private turnForRead(turn: Turn, session: Session): Turn {
    const projected = clone(turn);
    projected.usage = canonicalUsageProjection(
      projected.usage,
      this.usageProjectionRows(session.id, projected.id),
      { tenantId: session.tenantId, userId: session.userId },
    );
    return projected;
  }

  private activeSubjectRecord(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
    atMs: number,
  ): SubjectLifecycleRecord {
    return {
      tenantId,
      subjectKind,
      subjectId,
      state: "active",
      generation: 0,
      createdAtMs: atMs,
      updatedAtMs: atMs,
    };
  }

  private erasureIdempotencyKey(input: Pick<RequestUserErasureInput, "tenantId" | "userId" | "idempotencyKey">): string {
    return JSON.stringify([input.tenantId, "user", input.userId, input.idempotencyKey]);
  }

  private activeRetentionPolicyBinding(
    tenantId: string,
  ): { policyVersion: string; policyHash: string } | undefined {
    const state = this.assertRetentionPolicyState(tenantId);
    if (!state.active || state.control.effectiveAtMs === undefined) return undefined;
    return {
      policyVersion: state.active.policyVersion,
      policyHash: state.active.policySha256,
    };
  }

  async requestUserErasure(input: RequestUserErasureInput): Promise<ErasureRequestRecord> {
    validateRequestUserErasureInput(input);
    const tenant = this.assertTenantWritable(input.tenantId);

    const idempotencyKey = this.erasureIdempotencyKey(input);
    const replayId = this.erasureIdempotency.get(idempotencyKey);
    if (replayId) {
      const replay = this.erasureRequests.get(replayId);
      if (!replay) throw new Error("erasure idempotency index is corrupt");
      if (
        replay.tenantId !== input.tenantId
        || replay.subjectKind !== "user"
        || replay.subjectId !== input.userId
        || replay.idempotencyKey !== input.idempotencyKey
      ) throw new Error("erasure idempotency index is corrupt");
      validateErasureRequestRecordForRead(replay);
      if (replay.requestHash !== input.requestHash) throw new ErasureIdempotencyMismatchError();
      return clone(replay);
    }

    const userKey = subjectLifecycleKey(input.tenantId, "user", input.userId);
    const existingUser = this.subjectLifecycles.get(userKey);
    if (existingUser && existingUser.state !== "active") {
      const active = existingUser.activeRequestId
        ? this.erasureRequests.get(existingUser.activeRequestId)
        : undefined;
      if (!active) throw new SubjectDeletingError(input.tenantId, input.userId);
      if (
        active.tenantId !== input.tenantId
        || active.subjectKind !== "user"
        || active.subjectId !== input.userId
        || active.generation !== existingUser.generation
      ) throw new Error("subject lifecycle active request is corrupt");
      validateErasureRequestRecordForRead(active);
      return clone(active);
    }
    if (this.erasureRequests.has(input.requestId)) {
      throw new Error("erasure request id already exists");
    }

    // Resolve only for a brand-new request. A replay or pre-policy backlog must retain the exact
    // immutable identity (including the deliberate absence of a policy) captured at admission.
    const boundPolicy = this.activeRetentionPolicyBinding(input.tenantId);

    // Clone every row before publishing any map mutation. Invalid/uncloneable audit data can never
    // leave a deleting subject without its request/audit row (or a request without the durable gate).
    const generation = (existingUser?.generation ?? 0) + 1;
    const stagedTenant = tenant
      ? undefined
      : clone(this.activeSubjectRecord(input.tenantId, "tenant", input.tenantId, input.atMs));
    const stagedUser = clone<SubjectLifecycleRecord>({
      ...(existingUser ?? this.activeSubjectRecord(input.tenantId, "user", input.userId, input.atMs)),
      state: "deleting",
      generation,
      activeRequestId: input.requestId,
      // Lifecycle timestamps are monotonic across runners even when their wall clocks are skewed.
      // The request/audit timestamps below intentionally retain the initiating runner's clock.
      updatedAtMs: Math.max(existingUser?.updatedAtMs ?? input.atMs, input.atMs),
    });
    const stagedRequest = clone<ErasureRequestRecord>({
      requestId: input.requestId,
      tenantId: input.tenantId,
      subjectKind: "user",
      subjectId: input.userId,
      generation,
      status: "gated",
      requestedByKeyId: input.requestedByKeyId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAtMs: input.atMs,
      gatedAtMs: input.atMs,
      updatedAtMs: input.atMs,
      availableAtMs: input.atMs,
      attempts: 0,
      ...(boundPolicy ?? {}),
      controlGeneration: 0,
    });
    const stagedAudit = clone<ErasureAuditEvent>({
      requestId: input.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: {
        status: "gated",
        subjectKind: "user",
        generation,
        ...(boundPolicy ?? {}),
      },
      emittedAtMs: input.atMs,
    });
    validateErasureRequestRecord(stagedRequest);
    validateErasureAuditChain(stagedRequest, [stagedAudit]);

    const tenantKey = subjectLifecycleKey(input.tenantId, "tenant", input.tenantId);
    const tenantExisted = this.subjectLifecycles.has(tenantKey);
    const priorTenant = this.subjectLifecycles.get(tenantKey);
    const userExisted = this.subjectLifecycles.has(userKey);
    const priorUser = this.subjectLifecycles.get(userKey);
    const requestExisted = this.erasureRequests.has(input.requestId);
    const priorRequest = this.erasureRequests.get(input.requestId);
    const auditExisted = this.erasureAuditEvents.has(input.requestId);
    const priorAudit = this.erasureAuditEvents.get(input.requestId);
    const idempotencyExisted = this.erasureIdempotency.has(idempotencyKey);
    const priorIdempotency = this.erasureIdempotency.get(idempotencyKey);
    const priorExportState = this.captureUserDataExportState();
    try {
      if (stagedTenant) this.subjectLifecycles.set(tenantKey, stagedTenant);
      this.subjectLifecycles.set(userKey, stagedUser);
      this.erasureRequests.set(input.requestId, stagedRequest);
      this.erasureAuditEvents.set(input.requestId, [stagedAudit]);
      this.erasureIdempotency.set(idempotencyKey, input.requestId);
      this.revokeUserDataExportsForSubject(input.tenantId, input.userId, input.atMs);
    } catch (error) {
      this.restoreUserDataExportState(priorExportState);
      restoreMapEntry(this.erasureIdempotency, idempotencyKey, idempotencyExisted, priorIdempotency);
      restoreMapEntry(this.erasureAuditEvents, input.requestId, auditExisted, priorAudit);
      restoreMapEntry(this.erasureRequests, input.requestId, requestExisted, priorRequest);
      restoreMapEntry(this.subjectLifecycles, userKey, userExisted, priorUser);
      restoreMapEntry(this.subjectLifecycles, tenantKey, tenantExisted, priorTenant);
      throw error;
    }
    return clone(stagedRequest);
  }

  async getUserErasureRequest(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<ErasureRequestRecord | null> {
    const request = this.erasureRequests.get(requestId);
    if (
      !request
      || request.tenantId !== tenantId
      || request.subjectKind !== "user"
      || request.subjectId !== userId
    ) return null;
    validateErasureRequestRecordForRead(request);
    return clone(request);
  }

  private tenantErasureIdempotencyKey(input: Pick<
    RequestTenantErasureInput,
    "tenantId" | "idempotencyKey"
  >): string {
    return JSON.stringify([input.tenantId, "tenant", input.tenantId, input.idempotencyKey]);
  }

  private assertTenantErasureAdmissionProof(
    admission: ErasureRequestRecord,
    lifecycle: SubjectLifecycleRecord | undefined,
    fence: TenantCredentialRevocationFence | undefined,
  ): void {
    validateTenantErasureAdmissionProof({
      admission,
      lifecycle,
      fence,
      firstAudit: this.erasureAuditEvents.get(admission.requestId)?.[0],
    });
  }

  async replayTenantErasure(
    input: ReplayTenantErasureInput,
  ): Promise<ErasureRequestRecord | null> {
    const stagedInput = clone(input);
    validateReplayTenantErasureInput(stagedInput);
    const idempotencyKey = this.tenantErasureIdempotencyKey(stagedInput);
    const replayId = this.erasureIdempotency.get(idempotencyKey);
    if (!replayId) {
      // The index is part of the atomic publication. If the immutable admission still carries this
      // exact identity, treating the missing index as "not found" would make recovery lie.
      if ([...this.tenantErasureAdmissions.values()].some((admission) => (
        admission.tenantId === stagedInput.tenantId
        && admission.idempotencyKey === stagedInput.idempotencyKey
      ))) throw new TenantErasureIntegrityError();
      return null;
    }
    const replay = this.tenantErasureAdmissions.get(replayId);
    if (
      !replay
      || replay.tenantId !== stagedInput.tenantId
      || replay.subjectKind !== "tenant"
      || replay.subjectId !== stagedInput.tenantId
      || replay.idempotencyKey !== stagedInput.idempotencyKey
    ) throw new TenantErasureIntegrityError();
    if (replay.requestHash !== stagedInput.requestHash) {
      throw new ErasureIdempotencyMismatchError();
    }
    this.assertTenantErasureAdmissionProof(
      replay,
      this.subjectRecord(stagedInput.tenantId, "tenant", stagedInput.tenantId),
      this.tenantCredentialRevocationFences.get(stagedInput.tenantId),
    );
    return clone(replay);
  }

  async requestTenantErasure(input: RequestTenantErasureInput): Promise<ErasureRequestRecord> {
    const stagedInput = clone(input);
    validateRequestTenantErasureInput(stagedInput);
    const tenantKey = subjectLifecycleKey(stagedInput.tenantId, "tenant", stagedInput.tenantId);
    const existingTenant = this.subjectLifecycles.get(tenantKey);
    const existingAdmission = this.tenantErasureAdmission(stagedInput.tenantId);
    const existingFence = this.tenantCredentialRevocationFences.get(stagedInput.tenantId);
    const existingCredentialJob = [...this.tenantCredentialRevocationJobs.values()].find(
      (job) => job.tenantId === stagedInput.tenantId,
    );
    const existingCredentialReceipt = [...this.tenantCredentialRevocationReceipts.values()].find(
      (receipt) => receipt.tenantId === stagedInput.tenantId,
    );
    const idempotencyKey = this.tenantErasureIdempotencyKey(stagedInput);
    const replayId = this.erasureIdempotency.get(idempotencyKey);
    if (replayId) {
      const replay = this.tenantErasureAdmissions.get(replayId);
      if (
        !replay
        || replay.tenantId !== stagedInput.tenantId
        || replay.subjectKind !== "tenant"
        || replay.subjectId !== stagedInput.tenantId
        || replay.idempotencyKey !== stagedInput.idempotencyKey
      ) throw new TenantErasureIntegrityError();
      if (replay.requestHash !== stagedInput.requestHash) {
        throw new ErasureIdempotencyMismatchError();
      }
      this.assertTenantErasureAdmissionProof(replay, existingTenant, existingFence);
      return clone(replay);
    }

    if (existingTenant && existingTenant.state !== "active") {
      const active = existingTenant.activeRequestId
        ? this.tenantErasureAdmissions.get(existingTenant.activeRequestId)
        : undefined;
      if (!active) throw new TenantErasureIntegrityError();
      this.assertTenantErasureAdmissionProof(active, existingTenant, existingFence);
      return clone(active);
    }
    if (existingAdmission || existingFence || existingCredentialJob || existingCredentialReceipt) {
      throw new TenantErasureIntegrityError();
    }
    // Only the canonical tenant registry proves that a target exists. Sessions, policies and
    // lifecycle rows can be written independently and must not authorize tenant-wide erasure.
    // This check follows all replay paths so loss of an unrelated registry projection cannot
    // invalidate an already-committed, internally consistent request.
    if (!this.tenants.has(stagedInput.tenantId)) throw new TenantErasureTargetNotFoundError();
    if (
      this.erasureRequests.has(stagedInput.requestId)
      || this.tenantErasureAdmissions.has(stagedInput.requestId)
      || this.tenantCredentialRevocationJobs.has(stagedInput.requestId)
      || this.tenantCredentialRevocationReceipts.has(stagedInput.requestId)
    ) {
      throw new Error("erasure request id already exists");
    }
    if ([...this.erasureRequests.values()].some((request) => (
      request.tenantId === stagedInput.tenantId
      && request.subjectKind === "user"
      && (
        request.status === "gated"
        || request.status === "draining"
        || request.status === "tombstoning"
        || request.status === "reconciling_usage"
        || request.status === "purging"
      )
    ))) throw new TenantErasureConflictError();

    const boundPolicy = this.activeRetentionPolicyBinding(stagedInput.tenantId);
    const generation = (existingTenant?.generation ?? 0) + 1;
    const stagedTenant = clone<SubjectLifecycleRecord>({
      ...(existingTenant ?? this.activeSubjectRecord(
        stagedInput.tenantId,
        "tenant",
        stagedInput.tenantId,
        stagedInput.atMs,
      )),
      state: "deleting",
      generation,
      activeRequestId: stagedInput.requestId,
      updatedAtMs: Math.max(existingTenant?.updatedAtMs ?? stagedInput.atMs, stagedInput.atMs),
    });
    const stagedRequest = clone<ErasureRequestRecord>({
      requestId: stagedInput.requestId,
      tenantId: stagedInput.tenantId,
      subjectKind: "tenant",
      subjectId: stagedInput.tenantId,
      generation,
      status: "gated",
      requestedByKeyId: stagedInput.requestedByKeyId,
      idempotencyKey: stagedInput.idempotencyKey,
      requestHash: stagedInput.requestHash,
      createdAtMs: stagedInput.atMs,
      gatedAtMs: stagedInput.atMs,
      updatedAtMs: stagedInput.atMs,
      attempts: 0,
      ...(boundPolicy ?? {}),
      controlGeneration: 0,
    });
    const stagedAudit = clone<ErasureAuditEvent>({
      requestId: stagedInput.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: {
        status: "gated",
        subjectKind: "tenant",
        generation,
        credentialFence: "logical-v1",
        ...(boundPolicy ?? {}),
      },
      emittedAtMs: stagedInput.atMs,
    });
    const fenceBase = {
      tenantId: stagedInput.tenantId,
      requestId: stagedInput.requestId,
      subjectGeneration: generation,
      fencedAtMs: stagedInput.atMs,
    };
    const stagedFence = clone<TenantCredentialRevocationFence>({
      ...fenceBase,
      evidenceSha256: tenantCredentialRevocationFenceSha256(fenceBase),
    });
    const jobNowMs = this.storeNowMs();
    const stagedCredentialJob = clone<TenantCredentialRevocationJobRecord>({
      requestId: stagedInput.requestId,
      tenantId: stagedInput.tenantId,
      subjectGeneration: generation,
      t1FenceSha256: stagedFence.evidenceSha256,
      phase: "queued",
      availableAtMs: jobNowMs,
      attempts: 0,
      createdAtMs: jobNowMs,
      updatedAtMs: jobNowMs,
    });
    validateErasureRequestRecord(stagedRequest);
    validateErasureAuditChain(stagedRequest, [stagedAudit]);
    validateTenantCredentialRevocationFence(stagedFence);
    validateTenantCredentialRevocationJobRecord(stagedCredentialJob);

    const tenantExisted = this.subjectLifecycles.has(tenantKey);
    const priorTenant = this.subjectLifecycles.get(tenantKey);
    const requestExisted = this.tenantErasureAdmissions.has(stagedInput.requestId);
    const priorRequest = this.tenantErasureAdmissions.get(stagedInput.requestId);
    const auditExisted = this.erasureAuditEvents.has(stagedInput.requestId);
    const priorAudit = this.erasureAuditEvents.get(stagedInput.requestId);
    const fenceExisted = this.tenantCredentialRevocationFences.has(stagedInput.tenantId);
    const priorFence = this.tenantCredentialRevocationFences.get(stagedInput.tenantId);
    const idempotencyExisted = this.erasureIdempotency.has(idempotencyKey);
    const priorIdempotency = this.erasureIdempotency.get(idempotencyKey);
    const jobExisted = this.tenantCredentialRevocationJobs.has(stagedInput.requestId);
    const priorJob = this.tenantCredentialRevocationJobs.get(stagedInput.requestId);
    try {
      this.tenantErasureAdmissions.set(stagedInput.requestId, stagedRequest);
      this.erasureAuditEvents.set(stagedInput.requestId, [stagedAudit]);
      this.tenantCredentialRevocationFences.set(stagedInput.tenantId, stagedFence);
      this.erasureIdempotency.set(idempotencyKey, stagedInput.requestId);
      this.tenantCredentialRevocationJobs.set(stagedInput.requestId, stagedCredentialJob);
      // Publish the lifecycle gate last. All staged values above were cloned and validated first;
      // synchronous rollback below preserves the same all-or-nothing contract as InnoDB.
      this.subjectLifecycles.set(tenantKey, stagedTenant);
    } catch (error) {
      restoreMapEntry(this.subjectLifecycles, tenantKey, tenantExisted, priorTenant);
      restoreMapEntry(
        this.tenantCredentialRevocationJobs,
        stagedInput.requestId,
        jobExisted,
        priorJob,
      );
      restoreMapEntry(
        this.erasureIdempotency,
        idempotencyKey,
        idempotencyExisted,
        priorIdempotency,
      );
      restoreMapEntry(
        this.tenantCredentialRevocationFences,
        stagedInput.tenantId,
        fenceExisted,
        priorFence,
      );
      restoreMapEntry(this.erasureAuditEvents, stagedInput.requestId, auditExisted, priorAudit);
      restoreMapEntry(
        this.tenantErasureAdmissions,
        stagedInput.requestId,
        requestExisted,
        priorRequest,
      );
      throw error;
    }
    return clone(stagedRequest);
  }

  async getTenantErasureRequest(
    tenantId: string,
    requestId: string,
  ): Promise<ErasureRequestRecord | null> {
    const request = this.tenantErasureAdmissions.get(requestId);
    const lifecycle = this.subjectRecord(tenantId, "tenant", tenantId);
    const fence = this.tenantCredentialRevocationFences.get(tenantId);
    if (!request) {
      if (lifecycle?.activeRequestId === requestId || fence?.requestId === requestId) {
        throw new TenantErasureIntegrityError();
      }
      return null;
    }
    // Preserve owner isolation: a request id belonging to another tenant is indistinguishable
    // from a random id, even if the other tenant's proof is corrupt.
    if (
      request.tenantId !== tenantId
      || request.subjectKind !== "tenant"
      || request.subjectId !== tenantId
    ) return null;
    this.assertTenantErasureAdmissionProof(request, lifecycle, fence);
    return clone(request);
  }

  async getTenantCredentialRevocationFence(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialRevocationFence | null> {
    const fence = this.tenantCredentialRevocationFences.get(tenantId);
    if (!fence || fence.requestId !== requestId) return null;
    validateTenantCredentialRevocationFence(fence);
    return clone(fence);
  }

  private assertTenantCredentialRevocationSource(
    job: TenantCredentialRevocationJobRecord,
  ): void {
    try {
      validateTenantCredentialRevocationJobRecord(job);
      const admission = this.tenantErasureAdmissions.get(job.requestId);
      const lifecycle = this.subjectRecord(job.tenantId, "tenant", job.tenantId);
      const fence = this.tenantCredentialRevocationFences.get(job.tenantId);
      if (
        !admission
        || admission.tenantId !== job.tenantId
        || admission.generation !== job.subjectGeneration
        || !fence
        || fence.requestId !== job.requestId
        || fence.subjectGeneration !== job.subjectGeneration
        || fence.evidenceSha256 !== job.t1FenceSha256
      ) throw new Error("tenant credential revocation source binding is invalid");
      const firstAudit = this.erasureAuditEvents.get(admission.requestId)?.[0];
      if (job.phase === "credential_store_revoked") {
        validateTenantErasureImmutableT1Proof({ admission, fence, firstAudit });
      } else {
        validateTenantErasureAdmissionProof({ admission, lifecycle, fence, firstAudit });
      }
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  private readTenantCredentialRevocationCutover(
    requireCommittedFirstReceipt: boolean,
  ): TenantCredentialRevocationCutoverRecord {
    const cutover = this.tenantCredentialRevocationCutovers.get(1);
    if (!cutover || this.tenantCredentialRevocationCutovers.size !== 1) {
      throw new TenantErasureIntegrityError();
    }
    try {
      validateTenantCredentialRevocationCutoverRecord(cutover);
      if (cutover.controlGeneration === 0) {
        if (
          this.tenantCredentialRevocationReceipts.size !== 0
          || [...this.tenantCredentialRevocationJobs.values()].some(
            (job) => job.phase === "credential_store_revoked",
          )
        ) {
          throw new Error("inactive cutover has physical revocation completion evidence");
        }
      } else if (requireCommittedFirstReceipt) {
        const firstMatches = [...this.tenantCredentialRevocationReceipts.entries()].filter(
          ([, receipt]) => receipt.receiptSha256 === cutover.firstReceiptSha256,
        );
        if (firstMatches.length !== 1) {
          throw new Error("active cutover does not have exactly one first receipt");
        }
        const [firstRequestId, first] = firstMatches[0]!;
        validateTenantCredentialRevocationReceipt(first);
        if (firstRequestId !== first.requestId) {
          throw new Error("cutover first receipt storage identity is invalid");
        }
        if (first.storeDbTimestampMs !== cutover.activatedAtMs) {
          throw new Error("cutover timestamp does not match its first receipt");
        }
        const firstJob = this.tenantCredentialRevocationJobs.get(first.requestId);
        if (!firstJob) throw new Error("active cutover has no first terminal job");
        this.assertTenantCredentialRevocationSource(firstJob);
        validateTenantCredentialRevocationCompletionProof(firstJob, first);
      }
      return cutover;
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  async materializeTenantCredentialRevocationJobs(
    options: MaterializeTenantCredentialRevocationJobsOptions,
  ): Promise<number> {
    const stagedOptions = clone(options);
    validateMaterializeTenantCredentialRevocationJobsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const candidates = [...this.tenantErasureAdmissions.values()]
      .filter((admission) => !this.tenantCredentialRevocationJobs.has(admission.requestId))
      .sort((left, right) => left.requestId.localeCompare(right.requestId))
      .slice(0, stagedOptions.limit);
    const staged: TenantCredentialRevocationJobRecord[] = [];
    for (const admission of candidates) {
      const fence = this.tenantCredentialRevocationFences.get(admission.tenantId);
      try {
        this.assertTenantErasureAdmissionProof(
          admission,
          this.subjectRecord(admission.tenantId, "tenant", admission.tenantId),
          fence,
        );
      } catch {
        throw new TenantErasureIntegrityError();
      }
      if (
        !fence
        || this.tenantCredentialRevocationReceipts.has(admission.requestId)
        || [...this.tenantCredentialRevocationJobs.values()].some(
          (job) => job.tenantId === admission.tenantId,
        )
        || [...this.tenantCredentialRevocationReceipts.values()].some(
          (receipt) => receipt.tenantId === admission.tenantId,
        )
      ) throw new TenantErasureIntegrityError();
      const job = clone<TenantCredentialRevocationJobRecord>({
        requestId: admission.requestId,
        tenantId: admission.tenantId,
        subjectGeneration: admission.generation,
        t1FenceSha256: fence.evidenceSha256,
        phase: "queued",
        availableAtMs: nowMs,
        attempts: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      validateTenantCredentialRevocationJobRecord(job);
      staged.push(job);
    }

    const prior = new Map(this.tenantCredentialRevocationJobs);
    try {
      for (const job of staged) {
        this.tenantCredentialRevocationJobs.set(job.requestId, job);
      }
    } catch (error) {
      restoreMapSnapshot(this.tenantCredentialRevocationJobs, prior);
      throw error;
    }
    return staged.length;
  }

  async claimTenantCredentialRevocations(
    options: ClaimTenantCredentialRevocationsOptions,
  ): Promise<TenantCredentialRevocationClaim[]> {
    const stagedOptions = clone(options);
    validateClaimTenantCredentialRevocationsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = nowMs + stagedOptions.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) {
      throw new Error("tenant credential revocation lease deadline is invalid");
    }
    const candidates = [...this.tenantCredentialRevocationJobs.values()]
      .filter((job): job is Extract<
        TenantCredentialRevocationJobRecord,
        { phase: "queued" }
      > => (
        job.phase === "queued"
        && job.availableAtMs <= nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= nowMs)
      ))
      .sort((left, right) => (
        left.availableAtMs - right.availableAtMs
        || left.requestId.localeCompare(right.requestId)
      ))
      .slice(0, stagedOptions.limit);
    const staged: TenantCredentialRevocationJobRecord[] = [];
    for (const current of candidates) {
      this.assertTenantCredentialRevocationSource(current);
      const claimAttempt = current.attempts + 1;
      if (!Number.isSafeInteger(claimAttempt) || claimAttempt > 0xffff_ffff) {
        throw new TenantErasureIntegrityError();
      }
      const next = clone<TenantCredentialRevocationJobRecord>({
        ...current,
        attempts: claimAttempt,
        claimToken: stagedOptions.claimToken,
        leaseUntilMs,
        lastErrorCode: undefined,
        updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      });
      validateTenantCredentialRevocationJobRecord(next);
      staged.push(next);
    }

    const prior = new Map(this.tenantCredentialRevocationJobs);
    try {
      for (const job of staged) this.tenantCredentialRevocationJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantCredentialRevocationJobs, prior);
      throw error;
    }
    return staged.map((job) => clone(tenantCredentialRevocationClaimFromJob(job)));
  }

  async renewTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
    options: RenewTenantCredentialRevocationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantCredentialRevocationAuthorization(stagedAuthorization);
    validateRenewTenantCredentialRevocationOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = nowMs + stagedOptions.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) {
      throw new Error("tenant credential revocation renewed lease deadline is invalid");
    }
    const current = this.tenantCredentialRevocationJobs.get(stagedAuthorization.requestId);
    if (
      !current
      || !tenantCredentialRevocationAuthorizationMatches(current, stagedAuthorization, nowMs)
    ) return false;
    if (current.phase !== "queued") return false;
    this.assertTenantCredentialRevocationSource(current);
    const next = clone<TenantCredentialRevocationJobRecord>({
      ...current,
      leaseUntilMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantCredentialRevocationJobRecord(next);
    try {
      this.tenantCredentialRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantCredentialRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async retryTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
    options: RetryTenantCredentialRevocationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantCredentialRevocationAuthorization(stagedAuthorization);
    validateRetryTenantCredentialRevocationOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const availableAtMs = nowMs + stagedOptions.delayMs;
    if (!Number.isSafeInteger(availableAtMs)) {
      throw new Error("tenant credential revocation retry deadline is invalid");
    }
    const current = this.tenantCredentialRevocationJobs.get(stagedAuthorization.requestId);
    if (
      !current
      || !tenantCredentialRevocationAuthorizationMatches(current, stagedAuthorization, nowMs)
    ) return false;
    if (current.phase !== "queued") return false;
    this.assertTenantCredentialRevocationSource(current);
    const next = clone<TenantCredentialRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      phase: "queued",
      availableAtMs,
      attempts: current.attempts,
      lastErrorCode: stagedOptions.errorCode,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantCredentialRevocationJobRecord(next);
    try {
      this.tenantCredentialRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantCredentialRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async blockTenantCredentialRevocation(
    authorization: TenantCredentialRevocationAuthorization,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    validateTenantCredentialRevocationAuthorization(stagedAuthorization);
    const nowMs = this.storeNowMs();
    const current = this.tenantCredentialRevocationJobs.get(stagedAuthorization.requestId);
    if (
      !current
      || !tenantCredentialRevocationAuthorizationMatches(current, stagedAuthorization, nowMs)
    ) return false;
    if (current.phase !== "queued") return false;
    this.assertTenantCredentialRevocationSource(current);
    const next = clone<TenantCredentialRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      phase: "blocked",
      attempts: current.attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      blockedAtMs: nowMs,
      blockedReasonCode: "integrity_conflict",
    });
    validateTenantCredentialRevocationJobRecord(next);
    try {
      this.tenantCredentialRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantCredentialRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async revokeTenantCredentialMaterial(
    authorization: TenantCredentialRevocationAuthorization,
  ): Promise<TenantCredentialRevocationReceipt | null> {
    const stagedAuthorization = clone(authorization);
    validateTenantCredentialRevocationAuthorization(stagedAuthorization);
    const current = this.tenantCredentialRevocationJobs.get(stagedAuthorization.requestId);
    if (!current || current.tenantId !== stagedAuthorization.tenantId) return null;
    validateTenantCredentialRevocationJobRecord(current);

    if (current.phase === "credential_store_revoked") {
      this.assertTenantCredentialRevocationSource(current);
      const receipt = this.tenantCredentialRevocationReceipts.get(current.requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantCredentialRevocationCompletionProof(current, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
      return tenantCredentialRevocationCompletionMatchesAuthorization(current, stagedAuthorization)
        && tenantCredentialRevocationReceiptMatchesAuthorization(receipt, stagedAuthorization)
        ? clone(receipt)
        : null;
    }
    if (current.phase === "blocked") {
      this.assertTenantCredentialRevocationSource(current);
      return null;
    }

    const nowMs = this.storeNowMs();
    if (!tenantCredentialRevocationAuthorizationMatches(current, stagedAuthorization, nowMs)) {
      return null;
    }
    this.assertTenantCredentialRevocationSource(current);
    if (
      this.tenantCredentialRevocationReceipts.has(current.requestId)
      || [...this.tenantCredentialRevocationReceipts.values()].some(
        (receipt) => receipt.tenantId === current.tenantId,
      )
    ) {
      throw new TenantErasureIntegrityError();
    }
    const tenant = this.tenants.get(current.tenantId);
    if (!tenant || tenant.tenantId !== current.tenantId) throw new TenantErasureIntegrityError();
    const cutover = this.readTenantCredentialRevocationCutover(true);

    // Clone every credential-bearing target before the first destructive mutation. Besides giving
    // MemoryStore transaction-like rollback, this makes serialization failure an all-or-nothing
    // failure and prevents an uncloneable provider/auth value from becoming partial proof.
    const stagedTenantBefore = clone(tenant);
    const apiKeyTargets = [...this.apiKeys.entries()]
      .filter(([, value]) => value.tenantId === current.tenantId)
      .map(([key, value]) => [key, clone(value)] as const);
    const providerTargets = [...this.providers.entries()]
      .filter(([key, value]) => {
        let keyTenant: unknown;
        try {
          const parsed = JSON.parse(key) as unknown;
          keyTenant = Array.isArray(parsed) ? parsed[0] : undefined;
        } catch {
          keyTenant = undefined;
        }
        return value.config.tenantId === current.tenantId || keyTenant === current.tenantId;
      })
      .map(([key, value]) => {
        if (key !== providerConfigKey(value.config.tenantId, value.config.id)
          || value.config.tenantId !== current.tenantId) {
          throw new TenantErasureIntegrityError();
        }
        return [key, clone(value)] as const;
      });
    const stagedTenantAfter = clone<MemoryTenantRecord>({
      tenantId: stagedTenantBefore.tenantId,
      ...(stagedTenantBefore.name === undefined ? {} : { name: stagedTenantBefore.name }),
      createdAtMs: stagedTenantBefore.createdAtMs,
    });
    const receiptBody = {
      scope: TENANT_CREDENTIAL_REVOCATION_RECEIPT_SCOPE,
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      apiKeyCountBefore: apiKeyTargets.length,
      apiKeyCountAfter: 0 as const,
      providerConfigCountBefore: providerTargets.length,
      providerConfigCountAfter: 0 as const,
      authPolicyPresentBefore: stagedTenantBefore.authPolicy !== undefined,
      authPolicyPresentAfter: false as const,
      authSecretCipherPresentBefore: stagedTenantBefore.authSecret?.ciphertext !== undefined,
      authSecretCipherPresentAfter: false as const,
      authSecretKeyIdPresentBefore: stagedTenantBefore.authSecret?.keyId !== undefined,
      authSecretKeyIdPresentAfter: false as const,
      storeDbTimestampMs: nowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: tenantCredentialRevocationClaimTokenSha256(
        stagedAuthorization.claimToken,
      ),
      runtimeDisposition: TENANT_CREDENTIAL_REVOCATION_RUNTIME_DISPOSITION,
      externalDisposition: TENANT_CREDENTIAL_REVOCATION_EXTERNAL_DISPOSITION,
      contentPurgeRequired: true as const,
    };
    const stagedReceipt = clone<TenantCredentialRevocationReceipt>({
      ...receiptBody,
      receiptSha256: tenantCredentialRevocationReceiptSha256(receiptBody),
    });
    const stagedJob = clone<TenantCredentialRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      phase: "credential_store_revoked",
      attempts: current.attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      credentialStoreRevokedAtMs: nowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: stagedReceipt.completedClaimTokenSha256,
    });
    const stagedCutover = cutover.controlGeneration === 0
      ? clone<TenantCredentialRevocationCutoverRecord>({
          singletonId: 1,
          controlGeneration: 1,
          activatedAtMs: nowMs,
          firstReceiptSha256: stagedReceipt.receiptSha256,
          evidenceSha256: tenantCredentialRevocationCutoverEvidenceSha256({
            singletonId: 1,
            controlGeneration: 1,
            activatedAtMs: nowMs,
            firstReceiptSha256: stagedReceipt.receiptSha256,
          }),
        })
      : clone(cutover);
    validateTenantCredentialRevocationReceipt(stagedReceipt);
    validateTenantCredentialRevocationJobRecord(stagedJob);
    validateTenantCredentialRevocationCompletionProof(stagedJob, stagedReceipt);
    validateTenantCredentialRevocationCutoverRecord(stagedCutover);

    const apiKeysBefore = new Map(this.apiKeys);
    const providersBefore = new Map(this.providers);
    const tenantsBefore = new Map(this.tenants);
    const jobsBefore = new Map(this.tenantCredentialRevocationJobs);
    const receiptsBefore = new Map(this.tenantCredentialRevocationReceipts);
    const cutoversBefore = new Map(this.tenantCredentialRevocationCutovers);
    try {
      for (const [key] of apiKeyTargets) this.apiKeys.delete(key);
      for (const [key] of providerTargets) this.providers.delete(key);
      this.tenants.set(current.tenantId, stagedTenantAfter);
      if (
        [...this.apiKeys.values()].some((value) => value.tenantId === current.tenantId)
        || [...this.providers.values()].some((value) => value.config.tenantId === current.tenantId)
      ) throw new TenantErasureIntegrityError();
      this.tenantCredentialRevocationReceipts.set(current.requestId, stagedReceipt);
      if (cutover.controlGeneration === 0) {
        this.tenantCredentialRevocationCutovers.set(1, stagedCutover);
      }
      this.tenantCredentialRevocationJobs.set(current.requestId, stagedJob);
    } catch (error) {
      restoreMapSnapshot(this.apiKeys, apiKeysBefore);
      restoreMapSnapshot(this.providers, providersBefore);
      restoreMapSnapshot(this.tenants, tenantsBefore);
      restoreMapSnapshot(this.tenantCredentialRevocationJobs, jobsBefore);
      restoreMapSnapshot(this.tenantCredentialRevocationReceipts, receiptsBefore);
      restoreMapSnapshot(this.tenantCredentialRevocationCutovers, cutoversBefore);
      throw error;
    }
    return clone(stagedReceipt);
  }

  async getTenantCredentialRevocationJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialRevocationJobRecord | null> {
    const job = this.tenantCredentialRevocationJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return null;
    this.assertTenantCredentialRevocationSource(job);
    if (job.phase === "credential_store_revoked") {
      const receipt = this.tenantCredentialRevocationReceipts.get(requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantCredentialRevocationCompletionProof(job, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    }
    return clone(job);
  }

  async getTenantCredentialRevocationReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialRevocationReceipt | null> {
    const receipt = this.tenantCredentialRevocationReceipts.get(requestId);
    if (!receipt || receipt.tenantId !== tenantId) return null;
    const job = this.tenantCredentialRevocationJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    this.assertTenantCredentialRevocationSource(job);
    try {
      validateTenantCredentialRevocationCompletionProof(job, receipt);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    return clone(receipt);
  }

  async getTenantCredentialRevocationCutover(): Promise<TenantCredentialRevocationCutoverRecord> {
    return clone(this.readTenantCredentialRevocationCutover(true));
  }

  private tenantRuntimeRevocationTargetKey(requestId: string, targetSha256: string): string {
    return JSON.stringify([requestId, targetSha256]);
  }

  /**
   * T3b queue authority is derived from immutable T1 + terminal T3a proof. Mutable lifecycle is
   * required while a job can still cause work, but deliberately excluded from completed replay.
   */
  private assertTenantRuntimeRevocationSource(
    job: TenantRuntimeRevocationJobRecord,
    requireLiveLifecycle: boolean,
  ): TenantCredentialRevocationReceipt {
    try {
      validateTenantRuntimeRevocationJobRecord(job);
      const credentialJob = this.tenantCredentialRevocationJobs.get(job.requestId);
      const credentialReceipt = this.tenantCredentialRevocationReceipts.get(job.requestId);
      if (
        !credentialJob
        || !credentialReceipt
        || credentialJob.phase !== "credential_store_revoked"
        || credentialJob.tenantId !== job.tenantId
        || credentialJob.subjectGeneration !== job.subjectGeneration
        || credentialJob.t1FenceSha256 !== job.t1FenceSha256
        || credentialReceipt.tenantId !== job.tenantId
        || credentialReceipt.subjectGeneration !== job.subjectGeneration
        || credentialReceipt.t1FenceSha256 !== job.t1FenceSha256
        || credentialReceipt.receiptSha256 !== job.t3aReceiptSha256
      ) throw new Error("tenant runtime revocation T3a binding is invalid");
      this.assertTenantCredentialRevocationSource(credentialJob);
      validateTenantCredentialRevocationCompletionProof(credentialJob, credentialReceipt);
      this.readTenantCredentialRevocationCutover(true);
      if (requireLiveLifecycle) {
        const admission = this.tenantErasureAdmissions.get(job.requestId);
        const lifecycle = this.subjectRecord(job.tenantId, "tenant", job.tenantId);
        const fence = this.tenantCredentialRevocationFences.get(job.tenantId);
        if (!admission) throw new Error("tenant runtime revocation admission is missing");
        this.assertTenantErasureAdmissionProof(admission, lifecycle, fence);
      }
      return credentialReceipt;
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  async materializeTenantRuntimeRevocationJobs(
    options: MaterializeTenantRuntimeRevocationJobsOptions,
  ): Promise<number> {
    const stagedOptions = clone(options);
    validateMaterializeTenantRuntimeRevocationJobsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const candidates = [...this.tenantCredentialRevocationJobs.values()]
      .filter((job) => (
        job.phase === "credential_store_revoked"
        && !this.tenantRuntimeRevocationJobs.has(job.requestId)
      ))
      .sort((left, right) => left.requestId.localeCompare(right.requestId))
      .slice(0, stagedOptions.limit);
    const staged: TenantRuntimeRevocationJobRecord[] = [];
    for (const source of candidates) {
      const receipt = this.tenantCredentialRevocationReceipts.get(source.requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      const job = clone<TenantRuntimeRevocationJobRecord>({
        requestId: source.requestId,
        tenantId: source.tenantId,
        subjectGeneration: source.subjectGeneration,
        t1FenceSha256: source.t1FenceSha256,
        t3aReceiptSha256: receipt.receiptSha256,
        phase: "queued",
        availableAtMs: nowMs,
        attempts: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      this.assertTenantRuntimeRevocationSource(job, true);
      if (
        this.tenantRuntimeRevocationReceipts.has(job.requestId)
        || [...this.tenantRuntimeRevocationJobs.values()].some(
          (existing) => existing.tenantId === job.tenantId,
        )
        || staged.some((existing) => existing.tenantId === job.tenantId)
        || [...this.tenantRuntimeRevocationTargetReceipts.values()].some(
          (existing) => (
            existing.requestId === job.requestId || existing.tenantId === job.tenantId
          ),
        )
        || [...this.tenantRuntimeRevocationReceipts.values()].some(
          (existing) => existing.tenantId === job.tenantId,
        )
      ) throw new TenantErasureIntegrityError();
      staged.push(job);
    }
    const prior = new Map(this.tenantRuntimeRevocationJobs);
    try {
      for (const job of staged) this.tenantRuntimeRevocationJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantRuntimeRevocationJobs, prior);
      throw error;
    }
    return staged.length;
  }

  async claimTenantRuntimeRevocations(
    options: ClaimTenantRuntimeRevocationsOptions,
  ): Promise<TenantRuntimeRevocationClaim[]> {
    const stagedOptions = clone(options);
    validateClaimTenantRuntimeRevocationsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = nowMs + stagedOptions.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) {
      throw new Error("tenant runtime revocation lease deadline is invalid");
    }
    const candidates = [...this.tenantRuntimeRevocationJobs.values()]
      .filter((job): job is Extract<TenantRuntimeRevocationJobRecord, { phase: "queued" }> => (
        job.phase === "queued"
        && job.availableAtMs <= nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= nowMs)
      ))
      .sort((left, right) => (
        left.availableAtMs - right.availableAtMs
        || left.requestId.localeCompare(right.requestId)
      ))
      .slice(0, stagedOptions.limit);
    const staged: TenantRuntimeRevocationJobRecord[] = [];
    for (const current of candidates) {
      this.assertTenantRuntimeRevocationSource(current, true);
      const claimAttempt = current.attempts + 1;
      if (!Number.isSafeInteger(claimAttempt) || claimAttempt > 0xffff_ffff) {
        throw new TenantErasureIntegrityError();
      }
      const next = clone<TenantRuntimeRevocationJobRecord>({
        ...current,
        attempts: claimAttempt,
        claimToken: stagedOptions.claimToken,
        leaseUntilMs,
        lastErrorCode: undefined,
        updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      });
      validateTenantRuntimeRevocationJobRecord(next);
      staged.push(next);
    }
    const prior = new Map(this.tenantRuntimeRevocationJobs);
    try {
      for (const job of staged) this.tenantRuntimeRevocationJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantRuntimeRevocationJobs, prior);
      throw error;
    }
    return staged.map((job) => clone(tenantRuntimeRevocationClaimFromJob(job)));
  }

  async renewTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    options: RenewTenantRuntimeRevocationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantRuntimeRevocationAuthorization(stagedAuthorization);
    validateRenewTenantRuntimeRevocationOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = nowMs + stagedOptions.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) {
      throw new Error("tenant runtime revocation renewed lease deadline is invalid");
    }
    const current = this.tenantRuntimeRevocationJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantRuntimeRevocationAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    if (current.phase !== "queued") return false;
    this.assertTenantRuntimeRevocationSource(current, true);
    const next = clone<TenantRuntimeRevocationJobRecord>({
      ...current,
      leaseUntilMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantRuntimeRevocationJobRecord(next);
    try {
      this.tenantRuntimeRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantRuntimeRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async retryTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    options: RetryTenantRuntimeRevocationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantRuntimeRevocationAuthorization(stagedAuthorization);
    validateRetryTenantRuntimeRevocationOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const availableAtMs = nowMs + stagedOptions.delayMs;
    if (!Number.isSafeInteger(availableAtMs)) {
      throw new Error("tenant runtime revocation retry deadline is invalid");
    }
    const current = this.tenantRuntimeRevocationJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantRuntimeRevocationAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantRuntimeRevocationSource(current, true);
    const next = clone<TenantRuntimeRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      phase: "queued",
      availableAtMs,
      attempts: current.attempts,
      lastErrorCode: stagedOptions.errorCode,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantRuntimeRevocationJobRecord(next);
    try {
      this.tenantRuntimeRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantRuntimeRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async blockTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    validateTenantRuntimeRevocationAuthorization(stagedAuthorization);
    const nowMs = this.storeNowMs();
    const current = this.tenantRuntimeRevocationJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantRuntimeRevocationAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantRuntimeRevocationSource(current, true);
    const next = clone<TenantRuntimeRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      phase: "blocked",
      attempts: current.attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      blockedAtMs: nowMs,
      blockedReasonCode: "integrity_conflict",
    });
    validateTenantRuntimeRevocationJobRecord(next);
    try {
      this.tenantRuntimeRevocationJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantRuntimeRevocationJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async completeTenantRuntimeRevocation(
    authorization: TenantRuntimeRevocationAuthorization,
    proof: TenantRuntimeRevocationFleetProof,
  ): Promise<TenantRuntimeRevocationReceipt | null> {
    const stagedAuthorization = clone(authorization);
    const stagedProof = clone(proof);
    validateTenantRuntimeRevocationAuthorization(stagedAuthorization);
    const current = this.tenantRuntimeRevocationJobs.get(stagedAuthorization.requestId);
    if (!current || current.tenantId !== stagedAuthorization.tenantId) return null;
    validateTenantRuntimeRevocationJobRecord(current);
    if (current.phase === "configured_fleet_quiesced") {
      this.assertTenantRuntimeRevocationSource(current, false);
      const receipt = this.tenantRuntimeRevocationReceipts.get(current.requestId);
      const targets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
        .filter((target) => target.requestId === current.requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantRuntimeRevocationCompletionProof(current, targets, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
      if (!tenantRuntimeRevocationCompletionMatchesAuthorization(
        current,
        stagedAuthorization,
      )) return null;
      try {
        validateTenantRuntimeRevocationCompletionReplayProof(
          current,
          targets,
          receipt,
          stagedAuthorization,
          stagedProof,
        );
      } catch {
        throw new TenantErasureIntegrityError();
      }
      return clone(receipt);
    }
    if (current.phase === "blocked") {
      this.assertTenantRuntimeRevocationSource(current, true);
      return null;
    }
    const nowMs = this.storeNowMs();
    if (!tenantRuntimeRevocationAuthorizationMatches(current, stagedAuthorization, nowMs)) {
      return null;
    }
    this.assertTenantRuntimeRevocationSource(current, true);
    try {
      validateTenantRuntimeRevocationFleetProof(stagedProof, current);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    const existingTargets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
      .filter((target) => target.requestId === current.requestId);
    if (
      existingTargets.length !== 0
      || this.tenantRuntimeRevocationReceipts.has(current.requestId)
    ) throw new TenantErasureIntegrityError();

    const tokenSha256 = tenantRuntimeRevocationClaimTokenSha256(stagedAuthorization.claimToken);
    const stagedTargets = stagedProof.targets.map((local) => clone(
      tenantRuntimeRevocationTargetReceiptFromLocal(
        local,
        current,
        stagedAuthorization,
        stagedProof.fleetSha256,
      ),
    ));
    const receiptBody = {
      scope: TENANT_RUNTIME_REVOCATION_RECEIPT_SCOPE,
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      fleetSha256: stagedProof.fleetSha256,
      targetCount: stagedTargets.length,
      targetReceiptsSha256: stagedProof.targetReceiptsSha256,
      storeDbTimestampMs: nowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: tokenSha256,
      memoryDisposition: TENANT_RUNTIME_REVOCATION_MEMORY_DISPOSITION,
      externalDisposition: TENANT_RUNTIME_REVOCATION_EXTERNAL_DISPOSITION,
      contentPurgeRequired: true as const,
    };
    const stagedReceipt = clone<TenantRuntimeRevocationReceipt>({
      ...receiptBody,
      receiptSha256: tenantRuntimeRevocationReceiptSha256(receiptBody),
    });
    const stagedJob = clone<TenantRuntimeRevocationJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      phase: "configured_fleet_quiesced",
      attempts: current.attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      configuredFleetQuiescedAtMs: nowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: tokenSha256,
    });
    try {
      validateTenantRuntimeRevocationCompletionProof(stagedJob, stagedTargets, stagedReceipt);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    const jobsBefore = new Map(this.tenantRuntimeRevocationJobs);
    const targetsBefore = new Map(this.tenantRuntimeRevocationTargetReceipts);
    const receiptsBefore = new Map(this.tenantRuntimeRevocationReceipts);
    try {
      for (const target of stagedTargets) {
        this.tenantRuntimeRevocationTargetReceipts.set(
          this.tenantRuntimeRevocationTargetKey(target.requestId, target.targetSha256),
          target,
        );
      }
      this.tenantRuntimeRevocationReceipts.set(current.requestId, stagedReceipt);
      this.tenantRuntimeRevocationJobs.set(current.requestId, stagedJob);
    } catch (error) {
      restoreMapSnapshot(this.tenantRuntimeRevocationJobs, jobsBefore);
      restoreMapSnapshot(this.tenantRuntimeRevocationTargetReceipts, targetsBefore);
      restoreMapSnapshot(this.tenantRuntimeRevocationReceipts, receiptsBefore);
      throw error;
    }
    return clone(stagedReceipt);
  }

  async getTenantRuntimeRevocationJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationJobRecord | null> {
    const job = this.tenantRuntimeRevocationJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return null;
    this.assertTenantRuntimeRevocationSource(
      job,
      job.phase !== "configured_fleet_quiesced",
    );
    if (job.phase === "configured_fleet_quiesced") {
      const receipt = this.tenantRuntimeRevocationReceipts.get(requestId);
      const targets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
        .filter((target) => target.requestId === requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantRuntimeRevocationCompletionProof(job, targets, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    }
    return clone(job);
  }

  async getTenantRuntimeRevocationTargetReceipts(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationTargetReceipt[]> {
    const job = this.tenantRuntimeRevocationJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return [];
    const targets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
      .filter((target) => target.requestId === requestId)
      .sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));
    this.assertTenantRuntimeRevocationSource(
      job,
      job.phase !== "configured_fleet_quiesced",
    );
    if (job.phase !== "configured_fleet_quiesced") {
      if (targets.length !== 0) throw new TenantErasureIntegrityError();
      return [];
    }
    const receipt = this.tenantRuntimeRevocationReceipts.get(requestId);
    if (!receipt) throw new TenantErasureIntegrityError();
    try {
      validateTenantRuntimeRevocationCompletionProof(job, targets, receipt);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    return targets.map(clone);
  }

  async getTenantRuntimeRevocationReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRuntimeRevocationReceipt | null> {
    const receipt = this.tenantRuntimeRevocationReceipts.get(requestId);
    if (!receipt || receipt.tenantId !== tenantId) return null;
    const job = this.tenantRuntimeRevocationJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    const targets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
      .filter((target) => target.requestId === requestId);
    this.assertTenantRuntimeRevocationSource(job, false);
    try {
      validateTenantRuntimeRevocationCompletionProof(job, targets, receipt);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    return clone(receipt);
  }

  private tenantSessionContentReceiptKey(
    requestId: string,
    buildGeneration: number,
    sessionId: string,
  ): string {
    return JSON.stringify([requestId, buildGeneration, sessionId]);
  }

  /**
   * T3c is derived only from the immutable T1/T3a/T3b proof chain and the policy version captured
   * at T1. Mutable tenant lifecycle is additionally required for every operation that can advance
   * an unfinished job; a sealed proof remains independently verifiable for response-loss replay.
   */
  private assertTenantContentInventorySource(
    job: TenantContentInventoryJobRecord,
    requireLiveLifecycle: boolean,
  ): void {
    try {
      validateTenantContentInventoryJobRecord(job);
      const runtimeJob = this.tenantRuntimeRevocationJobs.get(job.requestId);
      const runtimeReceipt = this.tenantRuntimeRevocationReceipts.get(job.requestId);
      const runtimeTargets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
        .filter((target) => target.requestId === job.requestId);
      if (
        !runtimeJob
        || !runtimeReceipt
        || runtimeJob.phase !== "configured_fleet_quiesced"
        || runtimeJob.tenantId !== job.tenantId
        || runtimeJob.subjectGeneration !== job.subjectGeneration
        || runtimeJob.t1FenceSha256 !== job.t1FenceSha256
        || runtimeJob.t3aReceiptSha256 !== job.t3aReceiptSha256
        || runtimeReceipt.receiptSha256 !== job.t3bReceiptSha256
      ) throw new Error("tenant content inventory T3b binding is invalid");
      const credentialReceipt = this.assertTenantRuntimeRevocationSource(
        runtimeJob,
        requireLiveLifecycle,
      );
      validateTenantRuntimeRevocationCompletionProof(runtimeJob, runtimeTargets, runtimeReceipt);
      if (job.retentionAnchorDbMs < Math.max(
        credentialReceipt.storeDbTimestampMs,
        runtimeReceipt.storeDbTimestampMs,
      )) throw new Error("tenant content inventory anchor predates its terminal source proof");

      const admission = this.tenantErasureAdmissions.get(job.requestId);
      if (
        !admission
        || admission.tenantId !== job.tenantId
        || admission.subjectKind !== "tenant"
        || admission.subjectId !== job.tenantId
        || admission.generation !== job.subjectGeneration
        || admission.policyVersion !== job.policyVersion
        || admission.policyHash !== job.policySha256
      ) throw new Error("tenant content inventory T1 policy binding is invalid");
      validateErasureRequestRecordForRead(admission);
      if (requireLiveLifecycle) {
        this.assertTenantErasureAdmissionProof(
          admission,
          this.subjectRecord(job.tenantId, "tenant", job.tenantId),
          this.tenantCredentialRevocationFences.get(job.tenantId),
        );
      }

      // Validate the complete policy ledger before trusting its immutable bound version. A later
      // active version does not rewrite an already-admitted request's retention contract.
      this.assertRetentionPolicyState(job.tenantId);
      const policy = this.retentionPolicies.get(retentionPolicyKey(
        job.tenantId,
        job.policyVersion,
      ));
      if (!policy) throw new Error("tenant content inventory policy is missing");
      validateRetentionPolicyVersionRecord(policy);
      const deadline = checkedRetentionDeadline(
        job.retentionAnchorDbMs,
        policy.policy.sessionContentRetentionMs,
      );
      if (
        policy.tenantId !== job.tenantId
        || policy.policySha256 !== job.policySha256
        || policy.schemaVersion !== job.policySchemaVersion
        || deadline.kind !== "deadline"
        || deadline.value !== job.contentNotBeforeDbMs
      ) throw new Error("tenant content inventory policy deadline binding is invalid");
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  private tenantContentSessions(tenantId: string): Session[] {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.tenantId === tenantId)
      .map(([key, session]) => {
        const parsed = SessionSchema.safeParse(session);
        if (!parsed.success || key !== session.id) {
          throw new TenantErasureIntegrityError();
        }
        return session;
      })
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  /** Validate that none of the four content child tables contains an orphan or cross-owner edge. */
  private assertTenantContentGlobalRelations(): void {
    try {
      for (const [key, session] of this.sessions) {
        const parsed = SessionSchema.safeParse(session);
        if (!parsed.success || key !== session.id) throw new Error("session identity is corrupt");
        if (session.parentSessionId !== undefined) {
          const parent = this.sessions.get(session.parentSessionId);
          if (
            !parent
            || parent.tenantId !== session.tenantId
            || parent.userId !== session.userId
            || parent.id === session.id
          ) throw new Error("session parent owner is corrupt");
        }
        const log = this.events.get(session.id);
        if (!log || log.length !== session.lastSeq) {
          throw new Error("session event cursor is corrupt");
        }
        if (
          !this.deleted.has(session.id)
          && log.some((event) => event.type === "session/deleted")
        ) throw new Error("live session has a tombstone event");
      }
      const resolvedParentChains = new Set<string>();
      for (const session of this.sessions.values()) {
        const path = new Set<string>();
        let current: Session | undefined = session;
        while (current?.parentSessionId !== undefined) {
          if (path.has(current.id)) throw new Error("session parent cycle");
          if (resolvedParentChains.has(current.id)) break;
          path.add(current.id);
          current = this.sessions.get(current.parentSessionId);
          if (!current) throw new Error("orphaned parent session");
        }
        for (const sessionId of path) resolvedParentChains.add(sessionId);
      }

      for (const [key, marker] of this.deleted) {
        const session = this.sessions.get(key);
        if (
          !session
          || !Number.isSafeInteger(marker.deletedAtMs)
          || marker.deletedAtMs < 0
          || !Number.isSafeInteger(marker.deletionGeneration)
          || marker.deletionGeneration < 1
          || (marker.purgeAfterMs !== undefined && (
            !Number.isSafeInteger(marker.purgeAfterMs)
            || marker.purgeAfterMs < marker.deletedAtMs
          ))
        ) throw new Error("session tombstone marker is corrupt");
        const terminal = this.events.get(key)?.filter((event) => event.type === "session/deleted") ?? [];
        if (
          terminal.length !== 1
          || terminal[0]!.deletionGeneration !== marker.deletionGeneration
          || terminal[0]!.emittedAtMs !== marker.deletedAtMs
          || terminal[0]!.seq !== session.lastSeq
        ) throw new Error("session tombstone event is corrupt");
      }

      for (const [key, turn] of this.turns) {
        const parsed = TurnSchema.safeParse(turn);
        const session = this.sessions.get(turn.sessionId);
        if (
          !parsed.success
          || key !== turn.id
          || !session
          || turn.seqStart > session.lastSeq
          || (turn.seqEnd !== undefined && (
            turn.seqEnd < turn.seqStart || turn.seqEnd > session.lastSeq
          ))
        ) throw new Error("turn owner relation is corrupt");
      }

      for (const [key, item] of this.items) {
        const parsed = ItemSchema.safeParse(item);
        const session = this.sessions.get(item.sessionId);
        const turn = this.turns.get(item.turnId);
        const standaloneCompaction = item.type === "contextCompaction";
        if (
          !parsed.success
          || key !== item.id
          || !session
          || (!standaloneCompaction && !turn)
          || (turn !== undefined && turn.sessionId !== item.sessionId)
          || item.seq < 1
          || item.seq > session.lastSeq
        ) throw new Error("item owner relation is corrupt");
        if (item.type === "approvalRequest") {
          const matchingApprovals = [...this.approvals.values()].filter(
            (approval) => approval.id === item.approvalId,
          );
          const approval = matchingApprovals[0];
          if (
            matchingApprovals.length !== 1
            || !approval
            || approval.sessionId !== item.sessionId
            || approval.turnId !== item.turnId
            || approval.toolCallId !== item.toolCallId
            || approval.toolName !== item.name
          ) throw new Error("approval request reverse relation is corrupt");
        }
      }

      for (const [key, approval] of this.approvals) {
        const parsed = ApprovalSchema.safeParse(approval);
        const session = this.sessions.get(approval.sessionId);
        const turn = this.turns.get(approval.turnId);
        const matchingItems = [...this.items.values()].filter((item) => (
          item.type === "approvalRequest" && item.approvalId === approval.id
        ));
        const item = matchingItems[0];
        if (
          !parsed.success
          || key !== approval.id
          || !session
          || !turn
          || !item
          || item.type !== "approvalRequest"
          || matchingItems.length !== 1
          || turn.sessionId !== approval.sessionId
          || item.sessionId !== approval.sessionId
          || item.turnId !== approval.turnId
          || item.toolCallId !== approval.toolCallId
          || item.name !== approval.toolName
        ) throw new Error("approval owner relation is corrupt");
      }

      for (const [sessionId, log] of this.events) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error("event log is orphaned");
        for (const [index, event] of log.entries()) {
          const parsed = EventSchema.safeParse(event);
          if (
            !parsed.success
            || event.sessionId !== sessionId
            || event.seq !== index + 1
          ) throw new Error("event owner or sequence is corrupt");

          if ("turn" in event) {
            const turn = this.turns.get(event.turn.id);
            if (!turn || event.turn.sessionId !== sessionId || turn.sessionId !== sessionId) {
              throw new Error("event turn relation is corrupt");
            }
            if (
              turn.seqStart !== event.turn.seqStart
            ) throw new Error("event turn snapshot is corrupt");
          }
          if ("item" in event) {
            const item = this.items.get(event.item.id);
            const turn = this.turns.get(event.item.turnId);
            const standaloneCompaction = event.item.type === "contextCompaction";
            if (
              !item
              || event.item.sessionId !== sessionId
              || item.sessionId !== sessionId
              || item.turnId !== event.item.turnId
              || item.seq !== event.item.seq
              || item.type !== event.item.type
              || (!standaloneCompaction && !turn)
              || (turn !== undefined && turn.sessionId !== sessionId)
            ) throw new Error("event item relation is corrupt");
            if (event.item.type === "approvalRequest") {
              const approval = this.approvals.get(event.item.approvalId);
              if (
                item.type !== "approvalRequest"
                || item.approvalId !== event.item.approvalId
                || item.toolCallId !== event.item.toolCallId
                || item.name !== event.item.name
                || !approval
                || approval.sessionId !== sessionId
                || approval.turnId !== event.item.turnId
                || approval.toolCallId !== event.item.toolCallId
                || approval.toolName !== event.item.name
              ) throw new Error("event approval request relation is corrupt");
            }
          }
          if ("approval" in event) {
            const approval = this.approvals.get(event.approval.id);
            const turn = this.turns.get(event.approval.turnId);
            const matchingItems = [...this.items.values()].filter((item) => (
              item.type === "approvalRequest" && item.approvalId === event.approval.id
            ));
            const item = matchingItems[0];
            if (
              !approval
              || !turn
              || !item
              || item.type !== "approvalRequest"
              || matchingItems.length !== 1
              || event.approval.sessionId !== sessionId
              || approval.sessionId !== sessionId
              || approval.turnId !== event.approval.turnId
              || approval.itemId !== event.approval.itemId
              || turn.sessionId !== sessionId
              || item.sessionId !== sessionId
              || item.turnId !== event.approval.turnId
              || item.toolCallId !== event.approval.toolCallId
              || item.name !== event.approval.toolName
              || approval.toolCallId !== event.approval.toolCallId
              || approval.toolName !== event.approval.toolName
            ) throw new Error("event approval relation is corrupt");
          }
          if ("turnId" in event && event.turnId !== undefined) {
            const turn = this.turns.get(event.turnId);
            if (!turn || turn.sessionId !== sessionId) {
              throw new Error("event turn id is corrupt");
            }
          }
          if (event.type === "turn/steered") {
            const item = this.items.get(event.itemId);
            if (
              !item
              || item.sessionId !== sessionId
              || item.turnId !== event.turnId
            ) {
              throw new Error("event steered item relation is corrupt");
            }
          }
          if (event.type === "session/compacted") {
            const item = this.items.get(event.itemId);
            if (
              !item
              || item.sessionId !== sessionId
              || item.type !== "contextCompaction"
            ) {
              throw new Error("event compacted item relation is corrupt");
            }
          }
          if (event.type === "session/status/changed" && event.status.type === "active") {
            const turn = this.turns.get(event.status.turnId);
            if (!turn || turn.sessionId !== sessionId) {
              throw new Error("event active turn is corrupt");
            }
          }
        }
      }
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  private memoryTenantSessionContentReceipt(
    job: TenantContentInventoryJobRecord,
    session: Session,
    capturedAtDbMs: number,
  ): TenantSessionContentReceipt {
    const marker = this.deleted.get(session.id);
    const lifecycleDisposition = marker
      ? "tombstoned" as const
      : session.archivedAtMs === undefined ? "live" as const : "archived" as const;
    const turns = [...this.turns.values()].filter((turn) => turn.sessionId === session.id);
    const items = [...this.items.values()].filter((item) => item.sessionId === session.id);
    const events = this.events.get(session.id) ?? [];
    const approvals = [...this.approvals.values()]
      .filter((approval) => approval.sessionId === session.id);
    const turnRows: TenantContentIdentityRows["turn"][] = turns
      .map((turn) => [
        turn.id,
        turn.seqStart,
        turn.seqEnd ?? null,
        turn.status,
      ] as const);
    const itemRows: TenantContentIdentityRows["item"][] = items
      .map((item) => [
        item.id,
        item.turnId,
        item.seq,
        item.type,
        item.status,
        item.type === "approvalRequest" ? item.approvalId : null,
      ] as const);
    const eventRows: TenantContentIdentityRows["event"][] = events
      .map((event) => tenantContentEventIdentityRow(event));
    const approvalRows: TenantContentIdentityRows["approval"][] = approvals
      .map((approval) => [
        approval.id,
        approval.turnId,
        approval.itemId,
        approval.status,
      ] as const);
    const content = {
      sessionSha256: tenantSessionStructuralSha256(
        session.id,
        session.parentSessionId,
        session.lastSeq,
        marker?.deletionGeneration ?? 0,
        lifecycleDisposition,
      ),
      turnCount: turnRows.length,
      turnRootSha256: tenantContentIdentityRootSha256("turn", turnRows),
      itemCount: itemRows.length,
      itemRootSha256: tenantContentIdentityRootSha256("item", itemRows),
      eventCount: eventRows.length,
      eventRootSha256: tenantContentIdentityRootSha256("event", eventRows),
      approvalCount: approvalRows.length,
      approvalRootSha256: tenantContentIdentityRootSha256("approval", approvalRows),
      contentRecordCount: 1 + turnRows.length + itemRows.length + events.length + approvals.length,
    };
    const body = {
      scope: TENANT_SESSION_CONTENT_RECEIPT_SCOPE,
      requestId: job.requestId,
      buildGeneration: job.buildGeneration,
      tenantId: job.tenantId,
      subjectGeneration: job.subjectGeneration,
      sessionId: session.id,
      ...content,
      contentRootSha256: tenantSessionContentRootSha256(content),
      capturedAtDbMs,
    };
    const receipt = clone<TenantSessionContentReceipt>({
      ...body,
      receiptSha256: tenantSessionContentReceiptSha256(body),
    });
    validateTenantSessionContentReceipt(receipt);
    return receipt;
  }

  private tenantContentInventoryReceiptsFor(
    job: TenantContentInventoryJobRecord,
  ): TenantSessionContentReceipt[] {
    return [...this.tenantSessionContentReceipts.values()]
      .filter((receipt) => (
        receipt.requestId === job.requestId
        && receipt.buildGeneration === job.buildGeneration
      ))
      .sort((left, right) => (
        left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
      ));
  }

  private assertTenantContentInventoryBuildState(
    job: TenantContentInventoryJobRecord,
    sessions: Session[],
  ): { receipts: TenantSessionContentReceipt[]; contentRecordCount: number } {
    const receipts = this.tenantContentInventoryReceiptsFor(job);
    if (
      receipts.length !== job.sessionReceiptCount
      || receipts.length > sessions.length
      || tenantContentInventorySessionReceiptRootSha256(receipts)
        !== job.sessionReceiptRootSha256
      || receipts.some((receipt, index) => (
        receipt.tenantId !== job.tenantId
        || receipt.subjectGeneration !== job.subjectGeneration
        || receipt.sessionId !== sessions[index]!.id
        || receipt.receiptSha256 !== this.memoryTenantSessionContentReceipt(
          job,
          sessions[index]!,
          receipt.capturedAtDbMs,
        ).receiptSha256
      ))
      || (receipts.length === 0
        ? job.cursorSessionId !== undefined
        : job.cursorSessionId !== receipts.at(-1)!.sessionId)
      || (job.scanComplete && receipts.length !== sessions.length)
    ) throw new TenantContentInventoryEvidenceChangedError();
    let contentRecordCount = 0;
    for (const receipt of receipts) {
      contentRecordCount += receipt.contentRecordCount;
      if (!Number.isSafeInteger(contentRecordCount)) throw new TenantErasureIntegrityError();
    }
    return { receipts, contentRecordCount };
  }

  private tenantContentHoldProof(tenantId: string): {
    holdControlCount: number;
    holdControlRootSha256: string;
  } {
    try {
      const userIds = new Set<string>();
      for (const session of this.sessions.values()) {
        if (session.tenantId === tenantId) userIds.add(session.userId);
      }
      for (const lifecycle of this.subjectLifecycles.values()) {
        if (lifecycle.tenantId === tenantId && lifecycle.subjectKind === "user") {
          userIds.add(lifecycle.subjectId);
        }
      }
      for (const request of this.erasureRequests.values()) {
        if (request.tenantId === tenantId && request.subjectKind === "user") {
          userIds.add(request.subjectId);
        }
      }
      for (const [key, control] of this.legalHoldControls) {
        validateLegalHoldControlRecord(control);
        if (key !== subjectLifecycleKey(
          control.tenantId,
          control.subjectKind,
          control.subjectId,
        )) throw new Error("legal hold control index is corrupt");
        if (control.tenantId === tenantId && control.subjectKind === "user") {
          userIds.add(control.subjectId);
        }
      }
      for (const [key, hold] of this.legalHolds) {
        validateLegalHoldRecord(hold);
        if (key !== legalHoldKey(hold.tenantId, hold.holdId)) {
          throw new Error("legal hold row index is corrupt");
        }
        if (hold.tenantId === tenantId && hold.subjectKind === "user") {
          userIds.add(hold.subjectId);
        }
      }
      for (const [key, events] of this.legalHoldEvents) {
        for (const event of events) {
          if (key !== subjectLifecycleKey(
            event.tenantId,
            event.subjectKind,
            event.subjectId,
          )) throw new Error("legal hold event index is corrupt");
          if (event.tenantId === tenantId) {
            if (event.subjectKind === "tenant") {
              if (event.subjectId !== tenantId) {
                throw new Error("tenant legal hold event subject is corrupt");
              }
            } else if (event.subjectKind === "user") {
              userIds.add(event.subjectId);
            } else {
              throw new Error("legal hold event subject kind is corrupt");
            }
          }
        }
      }

      const subjects: Array<{ kind: "tenant" | "user"; id: string }> = [
        { kind: "tenant", id: tenantId },
        ...[...userIds]
          .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
          .map((id) => ({ kind: "user" as const, id })),
      ];
      const controlHashes = subjects.map((subject, ordinal) => {
        const state = this.assertLegalHoldState(tenantId, subject.kind, subject.id);
        if (state.control.activeHoldCount !== 0) {
          throw new TenantContentInventoryNotReadyError("active_legal_hold");
        }
        return tenantContentInventoryHoldControlSha256(
          ordinal,
          subject.kind,
          state.control.controlGeneration,
          state.control.activeProjectionSha256,
        );
      });
      return {
        holdControlCount: controlHashes.length,
        holdControlRootSha256: tenantContentInventoryHoldControlRootSha256(controlHashes),
      };
    } catch (error) {
      if (error instanceof TenantContentInventoryNotReadyError) throw error;
      throw new TenantErasureIntegrityError();
    }
  }

  /**
   * Blocking is a claim-bound, non-destructive terminal transition. It deliberately depends only
   * on the already validated T3c job envelope: requiring the damaged upstream proof again would
   * make the integrity incident impossible to persist and would leave it repeatedly claimable.
   */
  private blockedTenantContentInventoryJob(
    current: TenantContentInventoryJobRecord,
    blockedAtDbMs: number,
    attempts: number = current.attempts,
  ): TenantContentInventoryJobRecord {
    const terminalAtDbMs = Math.max(
      current.createdAtMs,
      current.updatedAtMs,
      blockedAtDbMs,
    );
    const blocked = clone<TenantContentInventoryJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      contentNotBeforeDbMs: current.contentNotBeforeDbMs,
      phase: "blocked",
      ...(current.cursorSessionId === undefined ? {} : { cursorSessionId: current.cursorSessionId }),
      scanComplete: current.scanComplete,
      sessionReceiptCount: current.sessionReceiptCount,
      sessionReceiptRootSha256: current.sessionReceiptRootSha256,
      attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: terminalAtDbMs,
      blockedAtDbMs: terminalAtDbMs,
      blockedReasonCode: "integrity_conflict",
    });
    validateTenantContentInventoryJobRecord(blocked);
    return blocked;
  }

  async materializeTenantContentInventoryJobs(
    options: MaterializeTenantContentInventoryJobsOptions,
  ): Promise<number> {
    const stagedOptions = clone(options);
    validateMaterializeTenantContentInventoryJobsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const candidates = [...this.tenantRuntimeRevocationJobs.values()]
      .filter((runtime) => (
        runtime.phase === "configured_fleet_quiesced"
        && !this.tenantContentInventoryJobs.has(runtime.requestId)
      ))
      .sort((left, right) => (
        left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0
      ));
    const staged: TenantContentInventoryJobRecord[] = [];
    let sourceIntegrityConflict = false;
    let firstNotReady: TenantContentInventoryNotReadyError | undefined;
    for (const runtime of candidates) {
      if (staged.length >= stagedOptions.limit) break;
      try {
        const admission = this.tenantErasureAdmissions.get(runtime.requestId);
        const t3bReceipt = this.tenantRuntimeRevocationReceipts.get(runtime.requestId);
        if (!admission || !t3bReceipt) throw new TenantErasureIntegrityError();
        if (admission.policyVersion === undefined || admission.policyHash === undefined) continue;
        const credentialReceipt = this.assertTenantRuntimeRevocationSource(runtime, true);
        const runtimeTargets = [...this.tenantRuntimeRevocationTargetReceipts.values()]
          .filter((target) => target.requestId === runtime.requestId);
        try {
          validateTenantRuntimeRevocationCompletionProof(runtime, runtimeTargets, t3bReceipt);
        } catch {
          throw new TenantErasureIntegrityError();
        }
        this.assertRetentionPolicyState(runtime.tenantId);
        const policy = this.retentionPolicies.get(retentionPolicyKey(
          runtime.tenantId,
          admission.policyVersion,
        ));
        if (!policy) throw new TenantErasureIntegrityError();
        validateRetentionPolicyVersionRecord(policy);
        if (policy.policySha256 !== admission.policyHash) {
          throw new TenantErasureIntegrityError();
        }
        const deadline = checkedRetentionDeadline(
          nowMs,
          policy.policy.sessionContentRetentionMs,
        );
        if (deadline.kind === "unconfigured") continue;
        if (deadline.kind === "invalid") throw new TenantErasureIntegrityError();
        if (nowMs < Math.max(
          credentialReceipt.storeDbTimestampMs,
          t3bReceipt.storeDbTimestampMs,
        )) {
          throw new TenantContentInventoryNotReadyError("trusted_clock_before_source");
        }
        const job = clone<TenantContentInventoryJobRecord>({
          requestId: runtime.requestId,
          tenantId: runtime.tenantId,
          subjectGeneration: runtime.subjectGeneration,
          buildGeneration: 1,
          t1FenceSha256: runtime.t1FenceSha256,
          t3aReceiptSha256: runtime.t3aReceiptSha256,
          t3bReceiptSha256: t3bReceipt.receiptSha256,
          policyVersion: policy.policyVersion,
          policySha256: policy.policySha256,
          policySchemaVersion: policy.schemaVersion,
          retentionAnchorDbMs: nowMs,
          contentNotBeforeDbMs: deadline.value,
          phase: "queued",
          scanComplete: false,
          sessionReceiptCount: 0,
          sessionReceiptRootSha256: EMPTY_TENANT_SESSION_RECEIPT_ROOT_SHA256,
          availableAtMs: nowMs,
          attempts: 0,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        this.assertTenantContentInventorySource(job, true);
        if (
          this.tenantContentInventoryReceipts.has(job.requestId)
          || [...this.tenantContentInventoryJobs.values()].some(
            (existing) => existing.tenantId === job.tenantId,
          )
          || staged.some((existing) => existing.tenantId === job.tenantId)
          || [...this.tenantSessionContentReceipts.values()].some((receipt) => (
            receipt.requestId === job.requestId || receipt.tenantId === job.tenantId
          ))
          || [...this.tenantContentInventoryReceipts.values()].some(
            (receipt) => receipt.tenantId === job.tenantId,
          )
        ) throw new TenantErasureIntegrityError();
        staged.push(job);
      } catch (error) {
        if (error instanceof TenantContentInventoryNotReadyError) {
          firstNotReady ??= error;
          continue;
        }
        // Model the production per-candidate transactions: one malformed immutable source must be
        // reported, but cannot roll back or indefinitely hide a healthy neighbor from the worker.
        sourceIntegrityConflict = true;
      }
    }
    const prior = new Map(this.tenantContentInventoryJobs);
    try {
      for (const job of staged) this.tenantContentInventoryJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantContentInventoryJobs, prior);
      throw error;
    }
    if (sourceIntegrityConflict) throw new TenantErasureIntegrityError();
    if (firstNotReady) throw firstNotReady;
    return staged.length;
  }

  async claimTenantContentInventories(
    options: ClaimTenantContentInventoriesOptions,
  ): Promise<TenantContentInventoryClaim[]> {
    const stagedOptions = clone(options);
    validateClaimTenantContentInventoriesOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (leaseUntilMs <= nowMs) return [];
    const candidates = [...this.tenantContentInventoryJobs.values()]
      .filter((job): job is Extract<TenantContentInventoryJobRecord, { phase: "queued" }> => (
        job.phase === "queued"
        && job.availableAtMs <= nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= nowMs)
      ))
      .sort((left, right) => (
        left.availableAtMs - right.availableAtMs
        || left.requestId.localeCompare(right.requestId)
      ))
      .slice(0, stagedOptions.limit);
    const staged: TenantContentInventoryJobRecord[] = [];
    const stagedClaims: TenantContentInventoryJobRecord[] = [];
    for (const current of candidates) {
      const attempts = current.attempts + 1;
      if (!Number.isSafeInteger(attempts) || attempts > 0xffff_ffff) {
        throw new TenantErasureIntegrityError();
      }
      try {
        this.assertTenantContentInventorySource(current, true);
      } catch (error) {
        if (!(error instanceof TenantErasureIntegrityError)) throw error;
        staged.push(this.blockedTenantContentInventoryJob(current, nowMs, attempts));
        continue;
      }
      const next = clone<TenantContentInventoryJobRecord>({
        ...current,
        attempts,
        claimToken: stagedOptions.claimToken,
        leaseUntilMs,
        lastErrorCode: undefined,
        updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      });
      delete next.lastErrorCode;
      validateTenantContentInventoryJobRecord(next);
      staged.push(next);
      stagedClaims.push(next);
    }
    const prior = new Map(this.tenantContentInventoryJobs);
    try {
      for (const job of staged) this.tenantContentInventoryJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantContentInventoryJobs, prior);
      throw error;
    }
    return stagedClaims.map((job) => clone(tenantContentInventoryClaimFromJob(job)));
  }

  async renewTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
    options: RenewTenantContentInventoryOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantContentInventoryAuthorization(stagedAuthorization);
    validateRenewTenantContentInventoryOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const requestedLeaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (requestedLeaseUntilMs <= nowMs) return false;
    const current = this.tenantContentInventoryJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    if (current.phase !== "queued") return false;
    this.assertTenantContentInventorySource(current, true);
    const leaseUntilMs = Math.max(current.leaseUntilMs!, requestedLeaseUntilMs);
    const next = clone<TenantContentInventoryJobRecord>({
      ...current,
      leaseUntilMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantContentInventoryJobRecord(next);
    try {
      this.tenantContentInventoryJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantContentInventoryJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async retryTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
    options: RetryTenantContentInventoryOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantContentInventoryAuthorization(stagedAuthorization);
    validateRetryTenantContentInventoryOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const current = this.tenantContentInventoryJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantContentInventorySource(current, true);
    const availableBaseMs = Math.max(
      nowMs,
      current.createdAtMs,
      current.updatedAtMs,
      current.availableAtMs,
    );
    const availableAtMs = stagedOptions.delayMs > Number.MAX_SAFE_INTEGER - availableBaseMs
      ? Number.MAX_SAFE_INTEGER
      : availableBaseMs + stagedOptions.delayMs;
    const next = clone<TenantContentInventoryJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      contentNotBeforeDbMs: current.contentNotBeforeDbMs,
      phase: "queued",
      ...(current.cursorSessionId === undefined ? {} : { cursorSessionId: current.cursorSessionId }),
      scanComplete: current.scanComplete,
      sessionReceiptCount: current.sessionReceiptCount,
      sessionReceiptRootSha256: current.sessionReceiptRootSha256,
      availableAtMs,
      attempts: current.attempts,
      lastErrorCode: stagedOptions.errorCode,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantContentInventoryJobRecord(next);
    try {
      this.tenantContentInventoryJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantContentInventoryJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async blockTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    validateTenantContentInventoryAuthorization(stagedAuthorization);
    const nowMs = this.storeNowMs();
    const current = this.tenantContentInventoryJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    const next = this.blockedTenantContentInventoryJob(current, nowMs);
    try {
      this.tenantContentInventoryJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantContentInventoryJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async buildTenantContentInventoryPage(
    authorization: TenantContentInventoryAuthorization,
    options: BuildTenantContentInventoryPageOptions,
  ): Promise<BuildTenantContentInventoryPageResult> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantContentInventoryAuthorization(stagedAuthorization);
    validateBuildTenantContentInventoryPageOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const current = this.tenantContentInventoryJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) throw new TenantErasureIntegrityError();
    if (nowMs < current.retentionAnchorDbMs) {
      throw new TenantContentInventoryNotReadyError("trusted_clock_before_anchor");
    }
    this.assertTenantContentInventorySource(current, true);
    this.assertTenantContentGlobalRelations();
    const sessions = this.tenantContentSessions(current.tenantId);
    const state = this.assertTenantContentInventoryBuildState(current, sessions);
    if (current.scanComplete) {
      return clone({
        built: 0,
        done: true,
        ...(current.cursorSessionId === undefined ? {} : { cursorSessionId: current.cursorSessionId }),
        sessionReceiptCount: current.sessionReceiptCount,
        sessionReceiptRootSha256: current.sessionReceiptRootSha256,
        contentRecordCount: state.contentRecordCount,
      });
    }

    const page = sessions.slice(state.receipts.length, state.receipts.length + stagedOptions.limit);
    const stagedReceipts = page.map((session) => this.memoryTenantSessionContentReceipt(
      current,
      session,
      nowMs,
    ));
    let sessionReceiptRootSha256 = current.sessionReceiptRootSha256;
    let contentRecordCount = state.contentRecordCount;
    for (const receipt of stagedReceipts) {
      const key = this.tenantSessionContentReceiptKey(
        receipt.requestId,
        receipt.buildGeneration,
        receipt.sessionId,
      );
      if (this.tenantSessionContentReceipts.has(key)) {
        throw new TenantErasureIntegrityError();
      }
      sessionReceiptRootSha256 = tenantContentInventoryNextSessionReceiptRootSha256(
        sessionReceiptRootSha256,
        receipt.receiptSha256,
      );
      contentRecordCount += receipt.contentRecordCount;
      if (!Number.isSafeInteger(contentRecordCount)) throw new TenantErasureIntegrityError();
    }
    const sessionReceiptCount = current.sessionReceiptCount + stagedReceipts.length;
    if (!Number.isSafeInteger(sessionReceiptCount)) throw new TenantErasureIntegrityError();
    const done = sessionReceiptCount === sessions.length;
    const cursorSessionId = stagedReceipts.at(-1)?.sessionId ?? current.cursorSessionId;
    const next = clone<TenantContentInventoryJobRecord>({
      ...current,
      ...(cursorSessionId === undefined ? {} : { cursorSessionId }),
      scanComplete: done,
      sessionReceiptCount,
      sessionReceiptRootSha256,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantContentInventoryJobRecord(next);
    const jobsBefore = new Map(this.tenantContentInventoryJobs);
    const receiptsBefore = new Map(this.tenantSessionContentReceipts);
    try {
      for (const receipt of stagedReceipts) {
        this.tenantSessionContentReceipts.set(
          this.tenantSessionContentReceiptKey(
            receipt.requestId,
            receipt.buildGeneration,
            receipt.sessionId,
          ),
          receipt,
        );
      }
      this.tenantContentInventoryJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapSnapshot(this.tenantContentInventoryJobs, jobsBefore);
      restoreMapSnapshot(this.tenantSessionContentReceipts, receiptsBefore);
      throw error;
    }
    return clone({
      built: stagedReceipts.length,
      done,
      ...(cursorSessionId === undefined ? {} : { cursorSessionId }),
      sessionReceiptCount,
      sessionReceiptRootSha256,
      contentRecordCount,
    });
  }

  async sealTenantContentInventory(
    authorization: TenantContentInventoryAuthorization,
  ): Promise<TenantContentInventoryReceipt | null> {
    const stagedAuthorization = clone(authorization);
    validateTenantContentInventoryAuthorization(stagedAuthorization);
    const current = this.tenantContentInventoryJobs.get(stagedAuthorization.requestId);
    if (!current || current.tenantId !== stagedAuthorization.tenantId) return null;
    validateTenantContentInventoryJobRecord(current);
    const existingReceipts = this.tenantContentInventoryReceiptsFor(current);
    if (current.phase === "inventory_sealed") {
      this.assertTenantContentInventorySource(current, false);
      const aggregate = this.tenantContentInventoryReceipts.get(current.requestId);
      if (!aggregate) throw new TenantErasureIntegrityError();
      try {
        validateTenantContentInventoryCompletionProof(current, existingReceipts, aggregate);
      } catch {
        throw new TenantErasureIntegrityError();
      }
      if (!tenantContentInventoryReceiptMatchesAuthorization(aggregate, stagedAuthorization)) {
        return null;
      }
      return clone(aggregate);
    }
    if (current.phase === "blocked") {
      this.assertTenantContentInventorySource(current, true);
      return null;
    }

    const initialNowMs = this.storeNowMs();
    if (!tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      initialNowMs,
    )) return null;
    this.assertTenantContentInventorySource(current, true);
    this.assertTenantContentGlobalRelations();
    const sessions = this.tenantContentSessions(current.tenantId);
    const state = this.assertTenantContentInventoryBuildState(current, sessions);
    if (!current.scanComplete || state.receipts.length !== sessions.length) {
      throw new TenantContentInventoryEvidenceChangedError();
    }
    const holdProof = this.tenantContentHoldProof(current.tenantId);

    // This is deliberately the final clock observation after every potentially expensive owner
    // and hold scan. It models the MySQL implementation's post-lock database timestamp read.
    const sealNowMs = this.storeNowMs();
    if (!tenantContentInventoryAuthorizationMatches(
      current,
      stagedAuthorization,
      sealNowMs,
    )) return null;
    if (sealNowMs < current.contentNotBeforeDbMs) {
      throw new TenantContentInventoryNotReadyError("deadline_not_reached");
    }
    const latestCapturedAtDbMs = state.receipts.reduce(
      (latest, receipt) => Math.max(latest, receipt.capturedAtDbMs),
      current.retentionAnchorDbMs,
    );
    if (sealNowMs < latestCapturedAtDbMs) {
      throw new TenantContentInventoryNotReadyError("trusted_clock_before_evidence");
    }
    this.assertTenantContentInventorySource(current, true);

    const receiptBody = {
      scope: TENANT_CONTENT_INVENTORY_RECEIPT_SCOPE,
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      contentNotBeforeDbMs: current.contentNotBeforeDbMs,
      sessionReceiptCount: current.sessionReceiptCount,
      sessionReceiptRootSha256: current.sessionReceiptRootSha256,
      contentRecordCount: state.contentRecordCount,
      ...holdProof,
      globalOrphanCheck: TENANT_CONTENT_INVENTORY_GLOBAL_ORPHAN_CHECK,
      storeDbTimestampMs: sealNowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: tenantContentInventoryClaimTokenSha256(
        stagedAuthorization.claimToken,
      ),
      contentInventoryComplete: true as const,
      contentPurgeExecuted: false as const,
    };
    const aggregate = clone<TenantContentInventoryReceipt>({
      ...receiptBody,
      receiptSha256: tenantContentInventoryReceiptSha256(receiptBody),
    });
    const next = clone<TenantContentInventoryJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      contentNotBeforeDbMs: current.contentNotBeforeDbMs,
      phase: "inventory_sealed",
      ...(current.cursorSessionId === undefined ? {} : { cursorSessionId: current.cursorSessionId }),
      scanComplete: true,
      sessionReceiptCount: current.sessionReceiptCount,
      sessionReceiptRootSha256: current.sessionReceiptRootSha256,
      attempts: current.attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, sealNowMs),
      inventorySealedAtDbMs: sealNowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: aggregate.completedClaimTokenSha256,
      aggregateReceiptSha256: aggregate.receiptSha256,
    });
    try {
      validateTenantContentInventoryCompletionProof(next, state.receipts, aggregate);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    if (this.tenantContentInventoryReceipts.has(current.requestId)) {
      throw new TenantErasureIntegrityError();
    }
    const jobsBefore = new Map(this.tenantContentInventoryJobs);
    const aggregatesBefore = new Map(this.tenantContentInventoryReceipts);
    try {
      this.tenantContentInventoryReceipts.set(current.requestId, aggregate);
      this.tenantContentInventoryJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapSnapshot(this.tenantContentInventoryJobs, jobsBefore);
      restoreMapSnapshot(this.tenantContentInventoryReceipts, aggregatesBefore);
      throw error;
    }
    return clone(aggregate);
  }

  async getTenantContentInventoryJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantContentInventoryJobRecord | null> {
    const job = this.tenantContentInventoryJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return null;
    this.assertTenantContentInventorySource(job, job.phase !== "inventory_sealed");
    const receipts = this.tenantContentInventoryReceiptsFor(job);
    if (job.phase === "inventory_sealed") {
      const aggregate = this.tenantContentInventoryReceipts.get(requestId);
      if (!aggregate) throw new TenantErasureIntegrityError();
      try {
        validateTenantContentInventoryCompletionProof(job, receipts, aggregate);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    }
    return clone(job);
  }

  async getTenantSessionContentReceipts(
    tenantId: string,
    requestId: string,
    buildGeneration: number,
  ): Promise<TenantSessionContentReceipt[]> {
    const job = this.tenantContentInventoryJobs.get(requestId);
    if (
      !job
      || job.tenantId !== tenantId
      || job.buildGeneration !== buildGeneration
    ) return [];
    this.assertTenantContentInventorySource(job, job.phase !== "inventory_sealed");
    const receipts = this.tenantContentInventoryReceiptsFor(job);
    if (job.phase === "inventory_sealed") {
      const aggregate = this.tenantContentInventoryReceipts.get(requestId);
      if (!aggregate) throw new TenantErasureIntegrityError();
      try {
        validateTenantContentInventoryCompletionProof(job, receipts, aggregate);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    } else {
      for (const receipt of receipts) validateTenantSessionContentReceipt(receipt);
      if (
        receipts.length !== job.sessionReceiptCount
        || tenantContentInventorySessionReceiptRootSha256(receipts)
          !== job.sessionReceiptRootSha256
      ) throw new TenantErasureIntegrityError();
    }
    return receipts.map(clone);
  }

  async getTenantContentInventoryReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantContentInventoryReceipt | null> {
    const aggregate = this.tenantContentInventoryReceipts.get(requestId);
    if (!aggregate || aggregate.tenantId !== tenantId) return null;
    const job = this.tenantContentInventoryJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    const receipts = this.tenantContentInventoryReceiptsFor(job);
    this.assertTenantContentInventorySource(job, false);
    try {
      validateTenantContentInventoryCompletionProof(job, receipts, aggregate);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    return clone(aggregate);
  }

  /**
   * T3d cannot attribute a child row whose owner row is missing. Fail the whole planning snapshot
   * closed instead of letting an owner-filtered scan silently omit that orphan and seal an
   * incomplete `planComplete` receipt. MySQL takes equivalent full-range shared locks while it
   * validates these relations.
   */
  private assertTenantPurgePlanGlobalRelations(): void {
    try {
      for (const [sessionId, session] of this.sessions) {
        if (sessionId !== session.id) throw new Error("session identity is invalid");
      }
      for (const [itemId, item] of this.items) {
        const session = this.sessions.get(item.sessionId);
        if (
          itemId !== item.id
          || !session
        ) throw new Error("item owner relation is invalid");
      }
      for (const [key, receipt] of this.idem) {
        let scope: unknown;
        try {
          scope = JSON.parse(key);
        } catch {
          throw new Error("idempotency scope is invalid");
        }
        if (
          !Array.isArray(scope)
          || scope.length !== 4
          || scope.some((value) => typeof value !== "string")
        ) throw new Error("idempotency scope is invalid");
        const [tenantId, userId, sessionId] = scope as string[];
        const session = this.sessions.get(sessionId!);
        if (
          !session
          || session.tenantId !== tenantId
          || session.userId !== userId
        ) throw new Error("idempotency owner relation is invalid");
        // NULL is the intentionally preserved legacy pending receipt. Historical completed
        // receipts may contain only turnId; modern receipts also carry sessionId. In either shape
        // the durable response pointer must resolve to a turn owned by the scoped session.
        if (receipt.value !== null) {
          const value: unknown = receipt.value;
          if (
            typeof value !== "object"
            || Array.isArray(value)
            || typeof (value as { turnId?: unknown }).turnId !== "string"
          ) throw new Error("idempotency completed value is invalid");
          const valueSessionId = (value as { sessionId?: unknown }).sessionId;
          const turnId = (value as { turnId: string }).turnId;
          const turn = this.turns.get(turnId);
          if (
            (valueSessionId !== undefined && valueSessionId !== sessionId)
            || !turn
            || turn.sessionId !== sessionId
          ) throw new Error("idempotency completed value relation is invalid");
        }
      }
      for (const usage of this.usageLedger) {
        const session = this.sessions.get(usage.sessionId);
        if (
          !session
          || session.tenantId !== usage.tenantId
          || session.userId !== usage.userId
        ) throw new Error("operational usage owner relation is invalid");
      }
      for (const [key, reconciliation] of this.usageReconciliations) {
        const session = this.sessions.get(reconciliation.sessionId);
        const tombstone = this.deleted.get(reconciliation.sessionId);
        if (
          key !== this.usageReconciliationMapKey(
            reconciliation.sessionId,
            reconciliation.deletionGeneration,
          )
          || !session
          || session.tenantId !== reconciliation.tenantId
          || session.userId !== reconciliation.userId
          || !tombstone
          || tombstone.deletionGeneration !== reconciliation.deletionGeneration
        ) throw new Error("usage reconciliation owner relation is invalid");
      }
      for (const [blobId, manifest] of this.blobManifests) {
        const session = this.sessions.get(manifest.sessionId);
        if (
          blobId !== manifest.blobId
          || !session
          || session.tenantId !== manifest.tenantId
          || session.userId !== manifest.userId
        ) throw new Error("blob owner relation is invalid");
        if (manifest.itemId !== undefined) {
          const item = this.items.get(manifest.itemId);
          if (
            !item
            || item.sessionId !== manifest.sessionId
          ) throw new Error("blob item relation is invalid");
        }
      }
      for (const outbox of this.blobDeleteOutbox.values()) {
        const manifest = this.blobManifests.get(outbox.blobId);
        if (!manifest || manifest.deletionGeneration !== outbox.generation) {
          throw new Error("orphaned blob delete outbox");
        }
      }
      for (const outbox of this.lifecycleOutbox.values()) {
        const session = this.sessions.get(outbox.aggregateId);
        const tombstone = this.deleted.get(outbox.aggregateId);
        if (
          !session
          || !tombstone
          || outbox.payload.sessionId !== outbox.aggregateId
          || outbox.payload.deletionGeneration !== outbox.generation
          || tombstone.deletionGeneration !== outbox.generation
        ) throw new Error("orphaned lifecycle outbox");
      }

      for (const [requestId, request] of this.userDataExportRequests) {
        if (requestId !== request.requestId) throw new Error("export request identity is invalid");
        if (
          this.userDataExportIdempotency.get(
            this.userDataExportIdempotencyKeyFor(request),
          ) !== requestId
        ) throw new Error("export request idempotency relation is invalid");
        const job = this.userDataExportJobs.get(requestId);
        if (!job || job.requestId !== requestId
          || job.buildGeneration !== request.currentBuildGeneration) {
          throw new Error("export job owner relation is invalid");
        }
      }
      for (const [requestId, exportJob] of this.userDataExportJobs) {
        const request = this.userDataExportRequests.get(requestId);
        if (
          exportJob.requestId !== requestId
          || !request
          || request.currentBuildGeneration !== exportJob.buildGeneration
        ) throw new Error("export job relation is invalid");
      }
      for (const [artifactId, artifact] of this.userDataExportArtifacts) {
        const request = this.userDataExportRequests.get(artifact.requestId);
        const exportJob = this.userDataExportJobs.get(artifact.requestId);
        if (
          artifactId !== artifact.artifactId
          || !request
          || !exportJob
          || artifact.tenantId !== request.tenantId
          || artifact.userId !== request.userId
          || artifact.subjectGeneration !== request.subjectGeneration
          || artifact.buildGeneration > exportJob.buildGeneration
        ) throw new Error("export artifact owner relation is invalid");
      }
      for (const [requestId, records] of this.userDataExportSnapshotRecords) {
        const request = this.userDataExportRequests.get(requestId);
        const exportJob = this.userDataExportJobs.get(requestId);
        if (!request || !exportJob || records.some((record) => (
          record.requestId !== requestId
          || record.buildGeneration > exportJob.buildGeneration
        ))) throw new Error("export snapshot record owner relation is invalid");
      }
      for (const [requestId, blobs] of this.userDataExportSnapshotBlobs) {
        const request = this.userDataExportRequests.get(requestId);
        const exportJob = this.userDataExportJobs.get(requestId);
        if (!request || !exportJob) throw new Error("export snapshot blob owner is missing");
        for (const blob of blobs) {
          const manifest = this.blobManifests.get(blob.blobId);
          if (
            blob.requestId !== requestId
            || blob.buildGeneration > exportJob.buildGeneration
            || !manifest
            || manifest.tenantId !== request.tenantId
            || manifest.userId !== request.userId
            || manifest.sessionId !== blob.sessionId
            || (blob.releasedAtMs === undefined
              ? manifest.deletionGeneration !== blob.sourceDeletionGeneration
              : manifest.deletionGeneration < blob.sourceDeletionGeneration)
          ) throw new Error("export snapshot blob owner relation is invalid");
        }
      }
      for (const [partKey, part] of this.userDataExportParts) {
        const artifact = this.userDataExportArtifacts.get(part.artifactId);
        if (
          partKey !== this.userDataExportPartKey(part.artifactId, part.partNumber)
          || !artifact
          || artifact.requestId !== part.requestId
          || artifact.buildGeneration !== part.buildGeneration
          || artifact.deletionGeneration !== part.deletionGeneration
        ) throw new Error("export artifact part relation is invalid");
      }
      for (const outbox of this.userDataExportDeleteOutbox.values()) {
        const artifact = this.userDataExportArtifacts.get(outbox.artifactId);
        const part = this.userDataExportParts.get(JSON.stringify([
          outbox.artifactId,
          outbox.partNumber,
        ]));
        if (
          !artifact
          || !part
          || artifact.requestId !== outbox.requestId
          || part.requestId !== outbox.requestId
          || part.deletionGeneration !== outbox.deletionGeneration
          || artifact.deletionGeneration !== outbox.deletionGeneration
        ) throw new Error("orphaned export delete outbox");
      }
      for (const lease of this.userDataExportDownloadLeases.values()) {
        const request = this.userDataExportRequests.get(lease.requestId);
        const artifact = this.userDataExportArtifacts.get(lease.artifactId);
        if (
          !request
          || !artifact
          || request.tenantId !== lease.tenantId
          || request.userId !== lease.userId
          || artifact.requestId !== lease.requestId
          || artifact.tenantId !== lease.tenantId
          || artifact.userId !== lease.userId
        ) throw new Error("orphaned export download lease");
      }
      for (const [key, requestId] of this.userDataExportIdempotency) {
        const request = this.userDataExportRequests.get(requestId);
        let scope: unknown;
        try {
          scope = JSON.parse(key);
        } catch {
          throw new Error("export idempotency scope is invalid");
        }
        if (
          !request
          || !Array.isArray(scope)
          || scope.length !== 3
          || scope[0] !== request.tenantId
          || scope[1] !== request.userId
          || scope[2] !== request.idempotencyKeySha256
        ) throw new Error("export idempotency owner relation is invalid");
      }

      for (const [requestId, request] of this.erasureRequests) {
        const lifecycle = this.subjectLifecycles.get(subjectLifecycleKey(
          request.tenantId,
          request.subjectKind,
          request.subjectId,
        ));
        if (
          requestId !== request.requestId
          || request.subjectKind !== "user"
          || this.erasureIdempotency.get(JSON.stringify([
            request.tenantId,
            request.subjectKind,
            request.subjectId,
            request.idempotencyKey,
          ])) !== requestId
          || !lifecycle
          || lifecycle.state !== "deleting"
          || lifecycle.generation !== request.generation
          || lifecycle.activeRequestId !== requestId
        ) throw new Error("erasure request lifecycle relation is invalid");
      }
      for (const [requestId, admission] of this.tenantErasureAdmissions) {
        const lifecycle = this.subjectLifecycles.get(subjectLifecycleKey(
          admission.tenantId,
          "tenant",
          admission.tenantId,
        ));
        if (
          requestId !== admission.requestId
          || admission.subjectKind !== "tenant"
          || admission.subjectId !== admission.tenantId
          || this.erasureIdempotency.get(JSON.stringify([
            admission.tenantId,
            admission.subjectKind,
            admission.subjectId,
            admission.idempotencyKey,
          ])) !== requestId
          || !lifecycle
          || lifecycle.state !== "deleting"
          || lifecycle.generation !== admission.generation
          || lifecycle.activeRequestId !== requestId
        ) throw new Error("tenant erasure admission lifecycle relation is invalid");
      }
      for (const [key, lifecycle] of this.subjectLifecycles) {
        if (key !== subjectLifecycleKey(
          lifecycle.tenantId,
          lifecycle.subjectKind,
          lifecycle.subjectId,
        )) throw new Error("subject lifecycle identity is invalid");
        if (lifecycle.state !== "deleting") {
          if (lifecycle.activeRequestId !== undefined) {
            throw new Error("inactive subject lifecycle retains an active request");
          }
          continue;
        }
        if (lifecycle.activeRequestId === undefined) {
          throw new Error("deleting subject lifecycle has no active request");
        }
        const owner = lifecycle.subjectKind === "user"
          ? this.erasureRequests.get(lifecycle.activeRequestId)
          : this.tenantErasureAdmissions.get(lifecycle.activeRequestId);
        if (
          !owner
          || owner.tenantId !== lifecycle.tenantId
          || owner.subjectKind !== lifecycle.subjectKind
          || owner.subjectId !== lifecycle.subjectId
          || owner.generation !== lifecycle.generation
        ) throw new Error("subject lifecycle active request relation is invalid");
      }
      for (const [key, requestId] of this.erasureIdempotency) {
        let scope: unknown;
        try {
          scope = JSON.parse(key);
        } catch {
          throw new Error("erasure idempotency scope is invalid");
        }
        if (
          !Array.isArray(scope)
          || scope.length !== 4
          || scope.some((value) => typeof value !== "string")
        ) throw new Error("erasure idempotency scope is invalid");
        const [tenantId, subjectKind, subjectId, idempotencyKey] = scope as string[];
        const request = subjectKind === "user"
          ? this.erasureRequests.get(requestId)
          : subjectKind === "tenant" ? this.tenantErasureAdmissions.get(requestId) : undefined;
        if (
          !request
          || request.tenantId !== tenantId
          || request.subjectKind !== subjectKind
          || request.subjectId !== subjectId
          || request.idempotencyKey !== idempotencyKey
        ) throw new Error("erasure idempotency owner relation is invalid");
      }
      for (const [requestId, events] of this.erasureAuditEvents) {
        const userRequest = this.erasureRequests.get(requestId);
        const tenantAdmission = this.tenantErasureAdmissions.get(requestId);
        if ((userRequest === undefined) === (tenantAdmission === undefined)) {
          throw new Error("orphaned or ambiguous erasure audit");
        }
        if (events.some((event) => event.requestId !== requestId)) {
          throw new Error("cross-request erasure audit");
        }
      }
      for (const [requestId, events] of this.erasureJobControlEvents) {
        if (
          !this.erasureRequests.has(requestId)
          || events.some((event) => event.requestId !== requestId)
        ) throw new Error("orphaned erasure control event");
      }
      for (const incident of this.erasureJobTerminalIncidents.values()) {
        if (!this.erasureRequests.has(incident.requestId)) {
          throw new Error("orphaned erasure terminal incident");
        }
      }
      for (const [jobId, legacyJob] of this.legacyTombstoneCompensationJobs) {
        validateLegacyTombstoneCompensationJobRecord(legacyJob);
        const session = this.sessions.get(legacyJob.sessionId);
        const tombstone = this.deleted.get(legacyJob.sessionId);
        if (
          jobId !== legacyJob.jobId
          || jobId !== legacyTombstoneCompensationJobIdForSession(legacyJob.sessionId)
          || !session
          || session.tenantId !== legacyJob.tenantId
          || session.userId !== legacyJob.userId
          || !tombstone
          || tombstone.deletedAtMs !== legacyJob.legacyDeletedAtMs
          || tombstone.purgeAfterMs !== undefined
          || tombstone.deletionGeneration !== (legacyJob.status === "completed" ? 1 : 0)
          || (legacyJob.status === "completed"
            && session.lastSeq !== legacyJob.completedEventSeq)
        ) throw new Error("legacy compensation owner relation is invalid");
        if (legacyJob.sourceKind === "erasure_claim") {
          const request = this.erasureRequests.get(legacyJob.sourceRequestId);
          if (
            !request
            || request.subjectKind !== "user"
            || request.tenantId !== legacyJob.tenantId
            || request.subjectId !== legacyJob.userId
            || request.generation !== legacyJob.sourceSubjectGeneration
          ) throw new Error("legacy compensation source relation is invalid");
        }
        const audits = this.legacyTombstoneCompensationAudits.get(jobId) ?? [];
        if (legacyJob.status === "pending") {
          if (audits.length !== 0) throw new Error("pending legacy compensation has an audit");
        } else if (legacyJob.status === "completed") {
          const audit = audits[0];
          if (
            audits.length !== 1
            || !audit
            || audit.type !== "legacy_tombstone/compensated"
            || legacyJob.completedAtMs === undefined
            || legacyJob.completedEventSeq === undefined
            || legacyJob.completedClaimAttempt === undefined
            || audit.sessionId !== legacyJob.sessionId
            || audit.cutoverGeneration !== legacyJob.cutoverGeneration
            || audit.deletionGeneration !== 1
            || audit.eventSeq !== legacyJob.completedEventSeq
            || audit.claimAttempt !== legacyJob.completedClaimAttempt
            || audit.emittedAtMs !== legacyJob.completedAtMs
            || audit.evidenceSha256 !== legacyTombstoneSuccessEvidenceSha256({
              jobId: legacyJob.jobId,
              tenantId: legacyJob.tenantId,
              userId: legacyJob.userId,
              sessionId: legacyJob.sessionId,
              cutoverGeneration: legacyJob.cutoverGeneration,
              legacyDeletedAtMs: legacyJob.legacyDeletedAtMs,
              deletionGeneration: 1,
              eventSeq: legacyJob.completedEventSeq,
              claimAttempt: legacyJob.completedClaimAttempt,
              emittedAtMs: legacyJob.completedAtMs,
            })
          ) throw new Error("completed legacy compensation audit is invalid");
        } else {
          const audit = audits[0];
          if (
            audits.length !== 1
            || !audit
            || audit.type !== "legacy_tombstone/terminal_incident"
            || audit.reasonCode !== legacyJob.terminalReasonCode
            || audit.emittedAtMs !== legacyJob.terminalAtMs
            || audit.evidenceSha256 !== legacyJob.terminalEvidenceSha256
          ) throw new Error("terminal legacy compensation audit is invalid");
        }
      }
      for (const [jobId, audits] of this.legacyTombstoneCompensationAudits) {
        const legacyJob = this.legacyTombstoneCompensationJobs.get(jobId);
        if (
          !legacyJob
          || audits.some((audit) => {
            validateLegacyTombstoneCompensationAudit(audit);
            return audit.jobId !== jobId
              || (audit.type === "legacy_tombstone/compensated"
                && audit.sessionId !== legacyJob.sessionId);
          })
        ) throw new Error("orphaned legacy compensation event");
      }
      for (const [requestId, evaluation] of this.erasurePolicyEvaluationJobs) {
        const request = this.erasureRequests.get(requestId);
        if (
          evaluation.requestId !== requestId
          || !request
          || evaluation.tenantId !== request.tenantId
          || evaluation.subjectKind !== request.subjectKind
          || evaluation.subjectId !== request.subjectId
          || evaluation.subjectGeneration !== request.generation
        ) throw new Error("purge-policy evaluation owner relation is invalid");
      }
      for (const [key, target] of this.erasurePurgeTargets) {
        const evaluation = this.erasurePolicyEvaluationJobs.get(target.requestId);
        const session = this.sessions.get(target.sessionId);
        const tombstone = this.deleted.get(target.sessionId);
        if (
          key !== this.erasurePurgeTargetKey(
            target.requestId,
            target.buildGeneration,
            target.sessionId,
          )
          || !evaluation
          || target.buildGeneration > evaluation.buildGeneration
          || evaluation.tenantId !== target.tenantId
          || evaluation.subjectKind !== "user"
          || evaluation.subjectId !== target.userId
          || !session
          || session.tenantId !== target.tenantId
          || session.userId !== target.userId
          || !tombstone
          || tombstone.deletionGeneration !== target.deletionGeneration
          || tombstone.deletedAtMs !== target.deletedAtMs
        ) throw new Error("purge target owner relation is invalid");
      }
      for (const [requestId, decisions] of this.erasurePolicyEvaluationDecisions) {
        const evaluation = this.erasurePolicyEvaluationJobs.get(requestId);
        if (
          !this.erasureRequests.has(requestId)
          || !evaluation
          || decisions.some((decision) => (
            decision.requestId !== requestId
            || decision.buildGeneration > evaluation.buildGeneration
          ))
        ) throw new Error("orphaned purge-policy decision");
      }
      for (const [requestId, control] of this.erasurePurgeAuthorityControls) {
        if (!this.erasureRequests.has(requestId) || control.requestId !== requestId) {
          throw new Error("orphaned purge-authority control");
        }
      }
      for (const [requestId, authorities] of this.erasurePurgeAuthorities) {
        const request = this.erasureRequests.get(requestId);
        const evaluation = this.erasurePolicyEvaluationJobs.get(requestId);
        if (
          !request
          || !evaluation
          || authorities.some((authority) => (
            authority.requestId !== requestId
            || authority.tenantId !== request.tenantId
            || authority.subjectKind !== request.subjectKind
            || authority.subjectId !== request.subjectId
            || authority.subjectGeneration !== request.generation
            || authority.buildGeneration > evaluation.buildGeneration
          ))
        ) throw new Error("orphaned purge authority");
      }
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  private tenantPurgePlanEntryKey(
    requestId: string,
    buildGeneration: number,
    domain: TenantPurgePlanDomain,
  ): string {
    return JSON.stringify([requestId, buildGeneration, domain]);
  }

  private tenantPurgePlanEntriesFor(job: TenantPurgePlanJobRecord): TenantPurgePlanEntry[] {
    return [...this.tenantPurgePlanEntries.values()]
      .filter((entry) => (
        entry.requestId === job.requestId
        && entry.buildGeneration === job.buildGeneration
      ))
      .sort((left, right) => (
        tenantPurgePlanDomainOrdinal(left.domain) - tenantPurgePlanDomainOrdinal(right.domain)
      ));
  }

  /**
   * Bind T3d only to a complete immutable T1/T3a/T3b/T3c chain. Advancing operations also
   * require the live deleting lifecycle and re-scan the current session topology against T3c.
   */
  private assertTenantPurgePlanSource(
    job: TenantPurgePlanJobRecord,
    requireLiveSource: boolean,
  ): {
    contentJob: Extract<TenantContentInventoryJobRecord, { phase: "inventory_sealed" }>;
    contentReceipt: TenantContentInventoryReceipt;
    credentialReceipt: TenantCredentialRevocationReceipt;
  } {
    try {
      validateTenantPurgePlanJobRecord(job);
      const contentJob = this.tenantContentInventoryJobs.get(job.requestId);
      const contentReceipt = this.tenantContentInventoryReceipts.get(job.requestId);
      if (
        !contentJob
        || contentJob.phase !== "inventory_sealed"
        || !contentReceipt
        || contentJob.tenantId !== job.tenantId
        || contentJob.subjectGeneration !== job.subjectGeneration
        || contentJob.buildGeneration !== job.buildGeneration
      ) throw new Error("tenant purge plan T3c source is missing");
      this.assertTenantContentInventorySource(contentJob, requireLiveSource);
      const sessionReceipts = this.tenantContentInventoryReceiptsFor(contentJob);
      validateTenantContentInventoryCompletionProof(contentJob, sessionReceipts, contentReceipt);
      const credentialReceipt = this.tenantCredentialRevocationReceipts.get(job.requestId);
      if (!credentialReceipt) throw new Error("tenant purge plan T3a receipt is missing");
      if (
        job.t1FenceSha256 !== contentJob.t1FenceSha256
        || job.t3aReceiptSha256 !== contentJob.t3aReceiptSha256
        || job.t3bReceiptSha256 !== contentJob.t3bReceiptSha256
        || job.t3cReceiptSha256 !== contentReceipt.receiptSha256
        || job.policyVersion !== contentJob.policyVersion
        || job.policySha256 !== contentJob.policySha256
        || job.policySchemaVersion !== contentJob.policySchemaVersion
        || job.retentionAnchorDbMs !== contentJob.retentionAnchorDbMs
        || job.purgeNotBeforeDbMs !== contentJob.contentNotBeforeDbMs
        || job.sourceEvidenceDbMs !== contentReceipt.storeDbTimestampMs
        || credentialReceipt.receiptSha256 !== job.t3aReceiptSha256
      ) throw new Error("tenant purge plan source binding is invalid");

      if (requireLiveSource) {
        this.assertTenantContentGlobalRelations();
        const sessions = this.tenantContentSessions(job.tenantId);
        const state = this.assertTenantContentInventoryBuildState(contentJob, sessions);
        if (
          !contentJob.scanComplete
          || state.receipts.length !== sessions.length
          || state.contentRecordCount !== contentReceipt.contentRecordCount
          || state.receipts.length !== contentReceipt.sessionReceiptCount
        ) throw new TenantPurgePlanEvidenceChangedError();
      }
      return { contentJob, contentReceipt, credentialReceipt };
    } catch (error) {
      if (error instanceof TenantPurgePlanEvidenceChangedError) throw error;
      if (error instanceof TenantContentInventoryEvidenceChangedError) {
        throw new TenantPurgePlanEvidenceChangedError();
      }
      throw new TenantErasureIntegrityError();
    }
  }

  private tenantPurgePlanHoldProof(tenantId: string): {
    holdControlCount: number;
    holdControlRootSha256: string;
  } {
    try {
      return this.tenantContentHoldProof(tenantId);
    } catch (error) {
      if (
        error instanceof TenantContentInventoryNotReadyError
        && error.reason === "active_legal_hold"
      ) throw new TenantPurgePlanNotReadyError("active_legal_hold");
      throw new TenantErasureIntegrityError();
    }
  }

  private tenantPurgePlanTargetEvidence(
    job: TenantPurgePlanJobRecord,
    domain: TenantPurgePlanDomain,
    contentReceipt: TenantContentInventoryReceipt,
    credentialReceipt: TenantCredentialRevocationReceipt,
    holdProof: { holdControlCount: number; holdControlRootSha256: string },
  ): {
    targetCount: number;
    targetRootSha256: string;
    disposition: TenantPurgePlanDisposition;
  } {
    const tuples: Array<readonly (string | number | boolean | null)[]> = [];
    let targetCount: number | undefined;
    let disposition: TenantPurgePlanDisposition;
    const add = (...tuple: readonly (string | number | boolean | null)[]) => tuples.push(tuple);
    const tenantSessions = [...this.sessions.values()]
      .filter((session) => session.tenantId === job.tenantId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const tenantRequestIds = new Set(
      [...this.erasureRequests.values()]
        .filter((request) => request.tenantId === job.tenantId)
        .map((request) => request.requestId),
    );
    const userRequestIds = new Set(
      [...this.erasureRequests.values()]
        .filter((request) => (
          request.tenantId === job.tenantId && request.subjectKind === "user"
        ))
        .map((request) => request.requestId),
    );

    switch (domain) {
      case "tenant_registry": {
        const tenant = this.tenants.get(job.tenantId);
        if (!tenant) throw new TenantErasureIntegrityError();
        add(tenant.tenantId);
        disposition = "retain_evidence";
        break;
      }
      case "tenant_profile": {
        const tenant = this.tenants.get(job.tenantId);
        if (!tenant) throw new TenantErasureIntegrityError();
        add(
          tenant.tenantId,
          tenant.name ?? null,
          tenant.authPolicy !== undefined,
          tenant.authSecret?.ciphertext !== undefined,
          tenant.authSecret?.keyId !== undefined,
        );
        disposition = "clear";
        break;
      }
      case "agent_definitions":
        for (const agent of this.agents.values()) {
          if (agent.tenantId === job.tenantId) add(agent.id, agent.version);
        }
        disposition = "delete";
        break;
      case "session_content": {
        const receipts = [...this.tenantSessionContentReceipts.values()]
          .filter((receipt) => (
            receipt.requestId === job.requestId
            && receipt.buildGeneration === job.buildGeneration
          ));
        for (const receipt of receipts) add(receipt.sessionId, receipt.receiptSha256);
        targetCount = contentReceipt.sessionReceiptCount + contentReceipt.contentRecordCount;
        if (!Number.isSafeInteger(targetCount)) throw new TenantErasureIntegrityError();
        disposition = "delete";
        break;
      }
      case "idempotency_receipts":
        for (const [key, value] of this.idem) {
          let scope: unknown;
          try {
            scope = JSON.parse(key);
          } catch {
            throw new TenantErasureIntegrityError();
          }
          if (!Array.isArray(scope) || scope.length !== 4) {
            throw new TenantErasureIntegrityError();
          }
          if (scope[0] === job.tenantId) {
            add(
              String(scope[1]),
              String(scope[2]),
              String(scope[3]),
              value.value === null ? "pending" : "completed",
            );
          }
        }
        disposition = "delete";
        break;
      case "operational_usage":
        for (const row of this.usageLedger) {
          if (row.tenantId === job.tenantId) {
            add(row.usageId ?? null, row.sessionId, row.turnId, row.step);
          }
        }
        disposition = "anonymize";
        break;
      case "billing_facts":
        for (const fact of this.billingUsageFacts.values()) {
          if (fact.tenantId === job.tenantId) add(fact.usageId, fact.factSha256);
        }
        disposition = "retain_anonymized";
        break;
      case "billing_reconciliation":
        for (const record of this.usageReconciliations.values()) {
          if (record.tenantId === job.tenantId) {
            add(record.sessionId, record.deletionGeneration, record.status, record.checksum);
          }
        }
        disposition = "retain_anonymized";
        break;
      case "blob_manifest":
        for (const manifest of this.blobManifests.values()) {
          if (manifest.tenantId === job.tenantId) {
            add(manifest.blobId, manifest.deletionGeneration, manifest.state);
          }
        }
        disposition = "delete";
        break;
      case "blob_bytes":
        for (const manifest of this.blobManifests.values()) {
          if (manifest.tenantId === job.tenantId && manifest.state !== "deleted") {
            add(manifest.blobId, manifest.deletionGeneration, manifest.state);
          }
        }
        disposition = "blocked_adapter_unconfigured";
        break;
      case "blob_outbox":
        for (const outbox of this.blobDeleteOutbox.values()) {
          const manifest = this.blobManifests.get(outbox.blobId);
          if (!manifest) throw new TenantErasureIntegrityError();
          if (manifest.tenantId === job.tenantId) {
            add(
              outbox.outboxId,
              outbox.blobId,
              outbox.generation,
              outbox.completedAtMs !== undefined
                ? "completed"
                : outbox.deadLetteredAtMs !== undefined ? "dead_letter" : "pending",
            );
          }
        }
        disposition = "delete";
        break;
      case "lifecycle_outbox":
        for (const outbox of this.lifecycleOutbox.values()) {
          const session = this.sessions.get(outbox.aggregateId);
          if (!session) throw new TenantErasureIntegrityError();
          if (session.tenantId === job.tenantId) {
            add(
              outbox.outboxId,
              outbox.topic,
              outbox.aggregateId,
              outbox.generation,
              outbox.completedAtMs !== undefined
                ? "completed"
                : outbox.deadLetteredAtMs !== undefined ? "dead_letter" : "pending",
            );
          }
        }
        disposition = "delete";
        break;
      case "user_export_control":
        for (const request of this.userDataExportRequests.values()) {
          if (request.tenantId === job.tenantId) {
            add("request", request.requestId, request.subjectGeneration, request.status);
          }
        }
        for (const exportJob of this.userDataExportJobs.values()) {
          const request = this.userDataExportRequests.get(exportJob.requestId);
          if (!request) throw new TenantErasureIntegrityError();
          if (request.tenantId === job.tenantId) {
            add("job", exportJob.requestId, exportJob.buildGeneration, exportJob.status);
          }
        }
        for (const lease of this.userDataExportDownloadLeases.values()) {
          if (lease.tenantId === job.tenantId) {
            const artifact = this.userDataExportArtifacts.get(lease.artifactId);
            if (
              !artifact
              || artifact.requestId !== lease.requestId
              || artifact.tenantId !== lease.tenantId
              || artifact.userId !== lease.userId
            ) throw new TenantErasureIntegrityError();
            const leaseTokenSha256 = createHash("sha256")
              .update(JSON.stringify([
                "tenant-purge-plan-download-lease-token-v1",
                lease.leaseToken,
              ]))
              .digest("hex");
            add(
              "download",
              lease.artifactId,
              lease.requestId,
              artifact.buildGeneration,
              artifact.deletionGeneration,
              leaseTokenSha256,
              lease.leaseUntilMs,
              lease.createdAtMs,
            );
          }
        }
        for (const [key, requestId] of this.userDataExportIdempotency) {
          let scope: unknown;
          try {
            scope = JSON.parse(key);
          } catch {
            throw new TenantErasureIntegrityError();
          }
          if (!Array.isArray(scope) || scope.length !== 3) {
            throw new TenantErasureIntegrityError();
          }
          if (scope[0] === job.tenantId) add("idempotency", String(scope[1]), String(scope[2]), requestId);
        }
        disposition = "delete";
        break;
      case "user_export_snapshots":
        for (const records of this.userDataExportSnapshotRecords.values()) {
          for (const record of records) {
            const request = this.userDataExportRequests.get(record.requestId);
            if (!request) throw new TenantErasureIntegrityError();
            if (request.tenantId === job.tenantId) {
              add("record", record.requestId, record.buildGeneration, record.ordinal, record.sha256);
            }
          }
        }
        for (const blobs of this.userDataExportSnapshotBlobs.values()) {
          for (const blob of blobs) {
            const request = this.userDataExportRequests.get(blob.requestId);
            if (!request) throw new TenantErasureIntegrityError();
            if (request.tenantId === job.tenantId) {
              add(
                "blob",
                blob.requestId,
                blob.buildGeneration,
                blob.ordinal,
                blob.blobId,
                blob.releasedAtMs === undefined ? "pinned" : "released",
              );
            }
          }
        }
        disposition = "delete";
        break;
      case "user_export_artifacts":
        for (const artifact of this.userDataExportArtifacts.values()) {
          if (artifact.tenantId === job.tenantId) {
            add(
              "artifact",
              artifact.artifactId,
              artifact.requestId,
              artifact.buildGeneration,
              artifact.deletionGeneration,
              artifact.state,
            );
          }
        }
        for (const part of this.userDataExportParts.values()) {
          const artifact = this.userDataExportArtifacts.get(part.artifactId);
          if (!artifact) throw new TenantErasureIntegrityError();
          if (artifact.tenantId === job.tenantId) {
            add(
              "part",
              part.artifactId,
              part.partNumber,
              part.deletionGeneration,
              part.state,
            );
          }
        }
        for (const outbox of this.userDataExportDeleteOutbox.values()) {
          const artifact = this.userDataExportArtifacts.get(outbox.artifactId);
          if (!artifact) throw new TenantErasureIntegrityError();
          if (artifact.tenantId === job.tenantId) {
            add(
              "outbox",
              outbox.outboxId,
              outbox.artifactId,
              outbox.partNumber,
              outbox.deletionGeneration,
              outbox.completedAtMs !== undefined
                ? "completed"
                : outbox.deadLetteredAtMs !== undefined ? "dead_letter" : "pending",
            );
          }
        }
        disposition = "delete";
        break;
      case "user_export_bytes":
        for (const part of this.userDataExportParts.values()) {
          const artifact = this.userDataExportArtifacts.get(part.artifactId);
          if (!artifact) throw new TenantErasureIntegrityError();
          if (artifact.tenantId === job.tenantId && part.state !== "deleted") {
            add(part.artifactId, part.partNumber, part.deletionGeneration, part.state);
          }
        }
        disposition = "blocked_adapter_unconfigured";
        break;
      case "user_erasure_evidence":
        for (const lifecycle of this.subjectLifecycles.values()) {
          if (lifecycle.tenantId === job.tenantId && lifecycle.subjectKind === "user") {
            add("lifecycle", lifecycle.subjectId, lifecycle.generation, lifecycle.state);
          }
        }
        for (const request of this.erasureRequests.values()) {
          if (request.tenantId === job.tenantId && request.subjectKind === "user") {
            add("request", request.requestId, request.subjectId, request.generation, request.status);
          }
        }
        for (const [requestId, events] of this.erasureAuditEvents) {
          if (!userRequestIds.has(requestId)) continue;
          for (const event of events) add("audit", requestId, event.seq, event.type);
        }
        for (const [requestId, events] of this.erasureJobControlEvents) {
          if (!userRequestIds.has(requestId)) continue;
          for (const event of events) {
            add("control", requestId, event.controlEventId, event.controlGeneration, event.eventType);
          }
        }
        for (const incident of this.erasureJobTerminalIncidents.values()) {
          if (userRequestIds.has(incident.requestId)) {
            add("incident", incident.terminalIncidentId, incident.requestId, incident.evidenceSha256);
          }
        }
        for (const compensation of this.legacyTombstoneCompensationJobs.values()) {
          if (compensation.tenantId === job.tenantId) {
            add(
              "legacy_job",
              compensation.jobId,
              compensation.sessionId,
              compensation.cutoverGeneration,
              compensation.sourceKind,
              compensation.status,
            );
          }
        }
        for (const [jobId, audits] of this.legacyTombstoneCompensationAudits) {
          const compensation = this.legacyTombstoneCompensationJobs.get(jobId);
          if (!compensation || compensation.tenantId !== job.tenantId) continue;
          for (const audit of audits) add("legacy_audit", jobId, audit.auditId, audit.type);
        }
        for (const [key, requestId] of this.erasureIdempotency) {
          let scope: unknown;
          try {
            scope = JSON.parse(key);
          } catch {
            throw new TenantErasureIntegrityError();
          }
          if (Array.isArray(scope) && scope[0] === job.tenantId && scope[1] === "user") {
            add("idempotency", String(scope[2]), String(scope[3]), requestId);
          }
        }
        disposition = "retain_evidence";
        break;
      case "user_purge_policy_evidence":
        for (const evaluation of this.erasurePolicyEvaluationJobs.values()) {
          if (evaluation.tenantId === job.tenantId) {
            add("job", evaluation.requestId, evaluation.buildGeneration, evaluation.targetRootSha256);
          }
        }
        for (const target of this.erasurePurgeTargets.values()) {
          if (target.tenantId === job.tenantId) {
            add("target", target.requestId, target.buildGeneration, target.sessionId, target.evidenceSha256);
          }
        }
        for (const [requestId, decisions] of this.erasurePolicyEvaluationDecisions) {
          if (!tenantRequestIds.has(requestId)) continue;
          for (const decision of decisions) add("decision", requestId, decision.decisionSeq, decision.afterSha256);
        }
        for (const control of this.erasurePurgeAuthorityControls.values()) {
          if (tenantRequestIds.has(control.requestId)) {
            add("control", control.requestId, control.authorityGeneration, control.activeAuthoritySha256 ?? null);
          }
        }
        for (const authorities of this.erasurePurgeAuthorities.values()) {
          for (const authority of authorities) {
            if (authority.tenantId === job.tenantId) {
              add("authority", authority.requestId, authority.authorityGeneration, authority.authoritySha256);
            }
          }
        }
        disposition = "retain_evidence";
        break;
      case "governance_policy":
        for (const policy of this.retentionPolicies.values()) {
          if (policy.tenantId === job.tenantId) {
            add("version", policy.policyVersion, policy.policySha256, policy.schemaVersion);
          }
        }
        for (const control of this.retentionPolicyControls.values()) {
          if (control.tenantId === job.tenantId) {
            add("control", control.controlGeneration, control.activePolicySha256 ?? null);
          }
        }
        for (const events of this.retentionPolicyActivationEvents.values()) {
          for (const event of events) {
            if (event.tenantId === job.tenantId) {
              add("activation", event.eventId, event.controlGeneration, event.afterSha256);
            }
          }
        }
        disposition = "retain_evidence";
        break;
      case "legal_holds":
        add("projection", holdProof.holdControlCount, holdProof.holdControlRootSha256);
        targetCount = holdProof.holdControlCount;
        disposition = "retain_evidence";
        break;
      case "tenant_t1_evidence": {
        const admission = this.tenantErasureAdmissions.get(job.requestId);
        const lifecycle = this.subjectLifecycles.get(subjectLifecycleKey(
          job.tenantId,
          "tenant",
          job.tenantId,
        ));
        const fence = this.tenantCredentialRevocationFences.get(job.tenantId);
        const audits = this.erasureAuditEvents.get(job.requestId) ?? [];
        if (!admission || !lifecycle || !fence || audits.length === 0) {
          throw new TenantErasureIntegrityError();
        }
        add("admission", admission.requestId, admission.generation, admission.status);
        add("lifecycle", lifecycle.subjectId, lifecycle.generation, lifecycle.state);
        add("fence", fence.tenantId, fence.subjectGeneration, fence.evidenceSha256);
        for (const audit of audits) add("audit", audit.requestId, audit.seq, audit.type);
        disposition = "retain_evidence";
        break;
      }
      case "tenant_t3a_evidence": {
        const sourceJob = this.tenantCredentialRevocationJobs.get(job.requestId);
        const receipt = this.tenantCredentialRevocationReceipts.get(job.requestId);
        if (!sourceJob || !receipt) throw new TenantErasureIntegrityError();
        add("job", sourceJob.requestId, sourceJob.attempts, sourceJob.phase);
        add("receipt", receipt.requestId, receipt.receiptSha256);
        disposition = "retain_evidence";
        break;
      }
      case "tenant_t3b_evidence": {
        const sourceJob = this.tenantRuntimeRevocationJobs.get(job.requestId);
        const receipt = this.tenantRuntimeRevocationReceipts.get(job.requestId);
        if (!sourceJob || !receipt) throw new TenantErasureIntegrityError();
        add("job", sourceJob.requestId, sourceJob.attempts, sourceJob.phase);
        for (const target of this.tenantRuntimeRevocationTargetReceipts.values()) {
          if (target.requestId === job.requestId) {
            add("target", target.targetSha256, target.evidenceSha256);
          }
        }
        add("receipt", receipt.requestId, receipt.receiptSha256);
        disposition = "retain_evidence";
        break;
      }
      case "tenant_t3c_evidence": {
        const sourceJob = this.tenantContentInventoryJobs.get(job.requestId);
        if (!sourceJob) throw new TenantErasureIntegrityError();
        add("job", sourceJob.requestId, sourceJob.buildGeneration, sourceJob.phase);
        for (const receipt of this.tenantContentInventoryReceiptsFor(sourceJob)) {
          add("session", receipt.sessionId, receipt.receiptSha256);
        }
        add("receipt", contentReceipt.requestId, contentReceipt.receiptSha256);
        disposition = "retain_evidence";
        break;
      }
      case "redis_leases":
      case "redis_fences":
      case "redis_streams":
        for (const session of tenantSessions) add(session.id);
        disposition = "blocked_adapter_unconfigured";
        break;
      case "external_provider":
        targetCount = credentialReceipt.providerConfigCountBefore;
        if (targetCount > 0) {
          add(credentialReceipt.receiptSha256, targetCount);
          disposition = "blocked_legacy_external_source_unavailable";
        } else {
          disposition = "not_applicable";
        }
        break;
      case "kms":
        targetCount = credentialReceipt.providerConfigCountBefore
          + (credentialReceipt.authSecretCipherPresentBefore
            || credentialReceipt.authSecretKeyIdPresentBefore ? 1 : 0);
        if (targetCount > 0) {
          add(
            credentialReceipt.receiptSha256,
            credentialReceipt.providerConfigCountBefore,
            credentialReceipt.authSecretCipherPresentBefore,
            credentialReceipt.authSecretKeyIdPresentBefore,
          );
          disposition = "blocked_legacy_external_source_unavailable";
        } else {
          disposition = "not_applicable";
        }
        break;
      case "backup_ledger":
        disposition = "blocked_adapter_unconfigured";
        break;
      case "restore_ledger":
        disposition = "blocked_restore_replay_unproven";
        break;
      case "logs":
      case "traces":
        disposition = "blocked_adapter_unconfigured";
        break;
      default: {
        const exhaustive: never = domain;
        throw new Error(`unhandled tenant purge plan domain: ${String(exhaustive)}`);
      }
    }

    const targetHashes = tuples.map((tuple) => tenantPurgePlanTargetSha256(domain, tuple));
    const count = targetCount ?? targetHashes.length;
    if (!Number.isSafeInteger(count) || count < 0) throw new TenantErasureIntegrityError();
    return {
      targetCount: count,
      targetRootSha256: tenantPurgePlanTargetRootSha256(domain, targetHashes),
      disposition,
    };
  }

  private memoryTenantPurgePlanEntry(
    job: TenantPurgePlanJobRecord,
    domain: TenantPurgePlanDomain,
    capturedAtDbMs: number,
    source: ReturnType<MemorySessionStore["assertTenantPurgePlanSource"]>,
    holdProof: { holdControlCount: number; holdControlRootSha256: string },
  ): TenantPurgePlanEntry {
    const target = this.tenantPurgePlanTargetEvidence(
      job,
      domain,
      source.contentReceipt,
      source.credentialReceipt,
      holdProof,
    );
    const body = {
      scope: TENANT_PURGE_PLAN_ENTRY_SCOPE,
      requestId: job.requestId,
      tenantId: job.tenantId,
      subjectGeneration: job.subjectGeneration,
      buildGeneration: job.buildGeneration,
      domain,
      ...target,
      sourceSha256: tenantPurgePlanDomainSourceSha256(job, domain),
      capturedAtDbMs,
    };
    const entry = clone<TenantPurgePlanEntry>({
      ...body,
      receiptSha256: tenantPurgePlanEntrySha256(body),
    });
    validateTenantPurgePlanEntry(entry);
    return entry;
  }

  private assertTenantPurgePlanBuildState(
    job: TenantPurgePlanJobRecord,
    source: ReturnType<MemorySessionStore["assertTenantPurgePlanSource"]>,
    holdProof: { holdControlCount: number; holdControlRootSha256: string },
  ): TenantPurgePlanEntry[] {
    const entries = this.tenantPurgePlanEntriesFor(job);
    if (
      entries.length !== job.planEntryCount
      || entries.length > TENANT_PURGE_PLAN_DOMAINS.length
      || tenantPurgePlanEntryRootSha256(entries) !== job.planEntryRootSha256
      || tenantPurgePlanBlockerRootSha256(entries) !== job.blockerRootSha256
      || entries.filter((entry) => isTenantPurgePlanBlockingDisposition(entry.disposition)).length
        !== job.blockerCount
      || entries.some((entry, index) => (
        entry.domain !== TENANT_PURGE_PLAN_DOMAINS[index]
        || entry.receiptSha256 !== this.memoryTenantPurgePlanEntry(
          job,
          entry.domain,
          entry.capturedAtDbMs,
          source,
          holdProof,
        ).receiptSha256
      ))
      || (entries.length === 0
        ? job.cursorDomain !== undefined
        : job.cursorDomain !== entries.at(-1)!.domain)
      || (job.scanComplete && entries.length !== TENANT_PURGE_PLAN_DOMAINS.length)
    ) throw new TenantPurgePlanEvidenceChangedError();
    return entries;
  }

  private blockedTenantPurgePlanJob(
    current: TenantPurgePlanJobRecord,
    blockedAtDbMs: number,
    attempts: number = current.attempts,
  ): TenantPurgePlanJobRecord {
    const terminalAtDbMs = Math.max(current.createdAtMs, current.updatedAtMs, blockedAtDbMs);
    const blocked = clone<TenantPurgePlanJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      t3cReceiptSha256: current.t3cReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      purgeNotBeforeDbMs: current.purgeNotBeforeDbMs,
      sourceEvidenceDbMs: current.sourceEvidenceDbMs,
      phase: "blocked",
      ...(current.cursorDomain === undefined ? {} : { cursorDomain: current.cursorDomain }),
      scanComplete: current.scanComplete,
      planEntryCount: current.planEntryCount,
      planEntryRootSha256: current.planEntryRootSha256,
      blockerCount: current.blockerCount,
      blockerRootSha256: current.blockerRootSha256,
      attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: terminalAtDbMs,
      blockedAtDbMs: terminalAtDbMs,
      blockedReasonCode: "integrity_conflict",
    });
    validateTenantPurgePlanJobRecord(blocked);
    return blocked;
  }

  async materializeTenantPurgePlanJobs(
    options: MaterializeTenantPurgePlanJobsOptions,
  ): Promise<number> {
    const stagedOptions = clone(options);
    validateMaterializeTenantPurgePlanJobsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const candidates = [...this.tenantContentInventoryJobs.values()]
      .filter((content) => (
        content.phase === "inventory_sealed"
        && !this.tenantPurgePlanJobs.has(content.requestId)
      ))
      .sort((left, right) => left.requestId.localeCompare(right.requestId));
    const staged: TenantPurgePlanJobRecord[] = [];
    let sourceIntegrityConflict = false;
    let firstNotReady: TenantPurgePlanNotReadyError | undefined;
    for (const content of candidates) {
      if (staged.length >= stagedOptions.limit) break;
      try {
        const receipt = this.tenantContentInventoryReceipts.get(content.requestId);
        if (!receipt) throw new TenantErasureIntegrityError();
        if (nowMs < receipt.storeDbTimestampMs) {
          throw new TenantPurgePlanNotReadyError("trusted_clock_before_source");
        }
        const job = clone<TenantPurgePlanJobRecord>({
          requestId: content.requestId,
          tenantId: content.tenantId,
          subjectGeneration: content.subjectGeneration,
          buildGeneration: content.buildGeneration,
          t1FenceSha256: content.t1FenceSha256,
          t3aReceiptSha256: content.t3aReceiptSha256,
          t3bReceiptSha256: content.t3bReceiptSha256,
          t3cReceiptSha256: receipt.receiptSha256,
          policyVersion: content.policyVersion,
          policySha256: content.policySha256,
          policySchemaVersion: content.policySchemaVersion,
          retentionAnchorDbMs: content.retentionAnchorDbMs,
          purgeNotBeforeDbMs: content.contentNotBeforeDbMs,
          sourceEvidenceDbMs: receipt.storeDbTimestampMs,
          phase: "queued",
          scanComplete: false,
          planEntryCount: 0,
          planEntryRootSha256: EMPTY_TENANT_PURGE_PLAN_ENTRY_ROOT_SHA256,
          blockerCount: 0,
          blockerRootSha256: EMPTY_TENANT_PURGE_PLAN_BLOCKER_ROOT_SHA256,
          availableAtMs: nowMs,
          attempts: 0,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        this.assertTenantPurgePlanSource(job, true);
        if (
          this.tenantPurgePlanReceipts.has(job.requestId)
          || [...this.tenantPurgePlanJobs.values()].some(
            (existing) => existing.tenantId === job.tenantId,
          )
          || staged.some((existing) => existing.tenantId === job.tenantId)
          || [...this.tenantPurgePlanEntries.values()].some((entry) => (
            entry.requestId === job.requestId || entry.tenantId === job.tenantId
          ))
          || [...this.tenantPurgePlanReceipts.values()].some(
            (existing) => existing.tenantId === job.tenantId,
          )
        ) throw new TenantErasureIntegrityError();
        staged.push(job);
      } catch (error) {
        if (error instanceof TenantPurgePlanNotReadyError) {
          firstNotReady ??= error;
          continue;
        }
        sourceIntegrityConflict = true;
      }
    }
    const prior = new Map(this.tenantPurgePlanJobs);
    try {
      for (const job of staged) this.tenantPurgePlanJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgePlanJobs, prior);
      throw error;
    }
    if (sourceIntegrityConflict) throw new TenantErasureIntegrityError();
    if (firstNotReady) throw firstNotReady;
    return staged.length;
  }

  async claimTenantPurgePlans(
    options: ClaimTenantPurgePlansOptions,
  ): Promise<TenantPurgePlanClaim[]> {
    const stagedOptions = clone(options);
    validateClaimTenantPurgePlansOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (leaseUntilMs <= nowMs) return [];
    const candidates = [...this.tenantPurgePlanJobs.values()]
      .filter((job): job is Extract<TenantPurgePlanJobRecord, { phase: "queued" }> => (
        job.phase === "queued"
        && job.availableAtMs <= nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= nowMs)
      ))
      .sort((left, right) => (
        left.availableAtMs - right.availableAtMs
        || left.requestId.localeCompare(right.requestId)
      ))
      .slice(0, stagedOptions.limit);
    const staged: TenantPurgePlanJobRecord[] = [];
    const claims: TenantPurgePlanJobRecord[] = [];
    for (const current of candidates) {
      const attempts = current.attempts + 1;
      if (!Number.isSafeInteger(attempts) || attempts > 0xffff_ffff) {
        throw new TenantErasureIntegrityError();
      }
      try {
        this.assertTenantPurgePlanSource(current, true);
      } catch (error) {
        if (error instanceof TenantPurgePlanNotReadyError) continue;
        if (
          !(error instanceof TenantErasureIntegrityError)
          && !(error instanceof TenantPurgePlanEvidenceChangedError)
        ) throw error;
        staged.push(this.blockedTenantPurgePlanJob(current, nowMs, attempts));
        continue;
      }
      const next = clone<TenantPurgePlanJobRecord>({
        ...current,
        attempts,
        claimToken: stagedOptions.claimToken,
        leaseUntilMs,
        lastErrorCode: undefined,
        updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      });
      delete next.lastErrorCode;
      validateTenantPurgePlanJobRecord(next);
      staged.push(next);
      claims.push(next);
    }
    const prior = new Map(this.tenantPurgePlanJobs);
    try {
      for (const job of staged) this.tenantPurgePlanJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgePlanJobs, prior);
      throw error;
    }
    return claims.map((job) => clone(tenantPurgePlanClaimFromJob(job)));
  }

  async renewTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
    options: RenewTenantPurgePlanOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantPurgePlanAuthorization(stagedAuthorization);
    validateRenewTenantPurgePlanOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const requestedLeaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (requestedLeaseUntilMs <= nowMs) return false;
    const current = this.tenantPurgePlanJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantPurgePlanAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantPurgePlanSource(current, true);
    const next = clone<TenantPurgePlanJobRecord>({
      ...current,
      leaseUntilMs: Math.max(current.leaseUntilMs!, requestedLeaseUntilMs),
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantPurgePlanJobRecord(next);
    try {
      this.tenantPurgePlanJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgePlanJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async retryTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
    options: RetryTenantPurgePlanOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantPurgePlanAuthorization(stagedAuthorization);
    validateRetryTenantPurgePlanOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const current = this.tenantPurgePlanJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantPurgePlanAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantPurgePlanSource(current, true);
    const availableBaseMs = Math.max(
      nowMs,
      current.createdAtMs,
      current.updatedAtMs,
      current.availableAtMs,
    );
    const availableAtMs = stagedOptions.delayMs > Number.MAX_SAFE_INTEGER - availableBaseMs
      ? Number.MAX_SAFE_INTEGER
      : availableBaseMs + stagedOptions.delayMs;
    const next = clone<TenantPurgePlanJobRecord>({
      requestId: current.requestId,
      tenantId: current.tenantId,
      subjectGeneration: current.subjectGeneration,
      buildGeneration: current.buildGeneration,
      t1FenceSha256: current.t1FenceSha256,
      t3aReceiptSha256: current.t3aReceiptSha256,
      t3bReceiptSha256: current.t3bReceiptSha256,
      t3cReceiptSha256: current.t3cReceiptSha256,
      policyVersion: current.policyVersion,
      policySha256: current.policySha256,
      policySchemaVersion: current.policySchemaVersion,
      retentionAnchorDbMs: current.retentionAnchorDbMs,
      purgeNotBeforeDbMs: current.purgeNotBeforeDbMs,
      sourceEvidenceDbMs: current.sourceEvidenceDbMs,
      phase: "queued",
      ...(current.cursorDomain === undefined ? {} : { cursorDomain: current.cursorDomain }),
      scanComplete: current.scanComplete,
      planEntryCount: current.planEntryCount,
      planEntryRootSha256: current.planEntryRootSha256,
      blockerCount: current.blockerCount,
      blockerRootSha256: current.blockerRootSha256,
      availableAtMs,
      attempts: current.attempts,
      lastErrorCode: stagedOptions.errorCode,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantPurgePlanJobRecord(next);
    try {
      this.tenantPurgePlanJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgePlanJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async blockTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    validateTenantPurgePlanAuthorization(stagedAuthorization);
    const nowMs = this.storeNowMs();
    const current = this.tenantPurgePlanJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantPurgePlanAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    const next = this.blockedTenantPurgePlanJob(current, nowMs);
    try {
      this.tenantPurgePlanJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgePlanJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  /** @deprecated Diagnostic/compatibility only; production workers must call atomic seal. */
  async buildTenantPurgePlanPage(
    authorization: TenantPurgePlanAuthorization,
    options: BuildTenantPurgePlanPageOptions,
  ): Promise<BuildTenantPurgePlanPageResult> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantPurgePlanAuthorization(stagedAuthorization);
    validateBuildTenantPurgePlanPageOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const current = this.tenantPurgePlanJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantPurgePlanAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) throw new TenantErasureIntegrityError();
    if (nowMs < current.retentionAnchorDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_anchor");
    }
    if (nowMs < current.purgeNotBeforeDbMs) {
      throw new TenantPurgePlanNotReadyError("deadline_not_reached");
    }
    if (nowMs < current.sourceEvidenceDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
    }
    const source = this.assertTenantPurgePlanSource(current, true);
    this.assertTenantPurgePlanGlobalRelations();
    const holdProof = this.tenantPurgePlanHoldProof(current.tenantId);
    const existing = this.assertTenantPurgePlanBuildState(current, source, holdProof);
    if (current.scanComplete) {
      return clone({
        built: 0,
        done: true,
        ...(current.cursorDomain === undefined ? {} : { cursorDomain: current.cursorDomain }),
        planEntryCount: current.planEntryCount,
        planEntryRootSha256: current.planEntryRootSha256,
        blockerCount: current.blockerCount,
        blockerRootSha256: current.blockerRootSha256,
      });
    }

    const domains = TENANT_PURGE_PLAN_DOMAINS.slice(
      existing.length,
      existing.length + stagedOptions.limit,
    );
    const stagedEntries = domains.map((domain) => this.memoryTenantPurgePlanEntry(
      current,
      domain,
      nowMs,
      source,
      holdProof,
    ));
    let planEntryRootSha256 = current.planEntryRootSha256;
    let blockerRootSha256 = current.blockerRootSha256;
    let blockerCount = current.blockerCount;
    for (const entry of stagedEntries) {
      const key = this.tenantPurgePlanEntryKey(
        entry.requestId,
        entry.buildGeneration,
        entry.domain,
      );
      if (this.tenantPurgePlanEntries.has(key)) throw new TenantErasureIntegrityError();
      planEntryRootSha256 = tenantPurgePlanNextEntryRootSha256(
        planEntryRootSha256,
        entry.domain,
        entry.receiptSha256,
      );
      if (isTenantPurgePlanBlockingDisposition(entry.disposition)) {
        blockerRootSha256 = tenantPurgePlanNextBlockerRootSha256(
          blockerRootSha256,
          entry.domain,
          entry.disposition,
          entry.receiptSha256,
        );
        blockerCount += 1;
      }
    }
    const planEntryCount = current.planEntryCount + stagedEntries.length;
    const done = planEntryCount === TENANT_PURGE_PLAN_DOMAINS.length;
    const cursorDomain = stagedEntries.at(-1)?.domain ?? current.cursorDomain;
    const next = clone<TenantPurgePlanJobRecord>({
      ...current,
      ...(cursorDomain === undefined ? {} : { cursorDomain }),
      scanComplete: done,
      planEntryCount,
      planEntryRootSha256,
      blockerCount,
      blockerRootSha256,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantPurgePlanJobRecord(next);
    const jobsBefore = new Map(this.tenantPurgePlanJobs);
    const entriesBefore = new Map(this.tenantPurgePlanEntries);
    try {
      for (const entry of stagedEntries) {
        this.tenantPurgePlanEntries.set(
          this.tenantPurgePlanEntryKey(entry.requestId, entry.buildGeneration, entry.domain),
          entry,
        );
      }
      this.tenantPurgePlanJobs.set(current.requestId, next);
      const publishNowMs = this.storeNowMs();
      if (!tenantPurgePlanAuthorizationMatches(next, stagedAuthorization, publishNowMs)) {
        throw new Error("tenant purge plan lease expired while publishing a page");
      }
      if (publishNowMs < current.sourceEvidenceDbMs) {
        throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
      }
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgePlanJobs, jobsBefore);
      restoreMapSnapshot(this.tenantPurgePlanEntries, entriesBefore);
      throw error;
    }
    return clone({
      built: stagedEntries.length,
      done,
      ...(cursorDomain === undefined ? {} : { cursorDomain }),
      planEntryCount,
      planEntryRootSha256,
      blockerCount,
      blockerRootSha256,
    });
  }

  async sealTenantPurgePlan(
    authorization: TenantPurgePlanAuthorization,
  ): Promise<TenantPurgePlanReceipt | null> {
    const stagedAuthorization = clone(authorization);
    validateTenantPurgePlanAuthorization(stagedAuthorization);
    const current = this.tenantPurgePlanJobs.get(stagedAuthorization.requestId);
    if (!current || current.tenantId !== stagedAuthorization.tenantId) return null;
    validateTenantPurgePlanJobRecord(current);
    const existingEntries = this.tenantPurgePlanEntriesFor(current);
    if (current.phase === "plan_sealed") {
      this.assertTenantPurgePlanSource(current, false);
      const receipt = this.tenantPurgePlanReceipts.get(current.requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantPurgePlanCompletionProof(current, existingEntries, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
      if (!tenantPurgePlanReceiptMatchesAuthorization(receipt, stagedAuthorization)) return null;
      return clone(receipt);
    }
    if (current.phase === "blocked") {
      this.assertTenantPurgePlanSource(current, true);
      return null;
    }

    const initialNowMs = this.storeNowMs();
    if (!tenantPurgePlanAuthorizationMatches(current, stagedAuthorization, initialNowMs)) {
      return null;
    }
    if (initialNowMs < current.retentionAnchorDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_anchor");
    }
    if (initialNowMs < current.purgeNotBeforeDbMs) {
      throw new TenantPurgePlanNotReadyError("deadline_not_reached");
    }
    if (initialNowMs < current.sourceEvidenceDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
    }
    const source = this.assertTenantPurgePlanSource(current, true);
    this.assertTenantPurgePlanGlobalRelations();
    const holdProof = this.tenantPurgePlanHoldProof(current.tenantId);
    let entries = this.assertTenantPurgePlanBuildState(current, source, holdProof);
    let working: TenantPurgePlanJobRecord = current;
    const stagedEntries: TenantPurgePlanEntry[] = [];
    if (!current.scanComplete) {
      // The production path never exposes a multi-transaction partial snapshot. An untouched
      // queued plan is built and sealed below in one in-memory atomic boundary. Historical or
      // diagnostic partial builds remain readable/resumable through buildTenantPurgePlanPage,
      // but seal refuses to reinterpret them against a newer live snapshot.
      if (entries.length !== 0) throw new TenantPurgePlanEvidenceChangedError();
      let planEntryRootSha256 = current.planEntryRootSha256;
      let blockerRootSha256 = current.blockerRootSha256;
      let blockerCount = current.blockerCount;
      for (const domain of TENANT_PURGE_PLAN_DOMAINS) {
        const entry = this.memoryTenantPurgePlanEntry(
          current,
          domain,
          initialNowMs,
          source,
          holdProof,
        );
        stagedEntries.push(entry);
        planEntryRootSha256 = tenantPurgePlanNextEntryRootSha256(
          planEntryRootSha256,
          entry.domain,
          entry.receiptSha256,
        );
        if (isTenantPurgePlanBlockingDisposition(entry.disposition)) {
          blockerRootSha256 = tenantPurgePlanNextBlockerRootSha256(
            blockerRootSha256,
            entry.domain,
            entry.disposition,
            entry.receiptSha256,
          );
          blockerCount += 1;
        }
      }
      const cursorDomain = stagedEntries.at(-1)?.domain;
      if (!cursorDomain || stagedEntries.length !== TENANT_PURGE_PLAN_DOMAINS.length) {
        throw new TenantErasureIntegrityError();
      }
      working = clone<TenantPurgePlanJobRecord>({
        ...current,
        cursorDomain,
        scanComplete: true,
        planEntryCount: stagedEntries.length,
        planEntryRootSha256,
        blockerCount,
        blockerRootSha256,
        updatedAtMs: Math.max(current.updatedAtMs, initialNowMs),
      });
      validateTenantPurgePlanJobRecord(working);
      entries = stagedEntries;
    }
    if (!working.scanComplete || entries.length !== TENANT_PURGE_PLAN_DOMAINS.length) {
      throw new TenantPurgePlanEvidenceChangedError();
    }

    const sealNowMs = this.storeNowMs();
    if (!tenantPurgePlanAuthorizationMatches(working, stagedAuthorization, sealNowMs)) return null;
    if (sealNowMs < working.retentionAnchorDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_anchor");
    }
    if (sealNowMs < working.purgeNotBeforeDbMs) {
      throw new TenantPurgePlanNotReadyError("deadline_not_reached");
    }
    const latestCapturedAtDbMs = entries.reduce(
      (latest, entry) => Math.max(latest, entry.capturedAtDbMs),
      working.sourceEvidenceDbMs,
    );
    if (sealNowMs < latestCapturedAtDbMs) {
      throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
    }
    this.assertTenantPurgePlanSource(working, true);
    this.assertTenantPurgePlanGlobalRelations();
    this.tenantPurgePlanHoldProof(working.tenantId);

    const receiptBody = {
      scope: TENANT_PURGE_PLAN_RECEIPT_SCOPE,
      requestId: working.requestId,
      tenantId: working.tenantId,
      subjectGeneration: working.subjectGeneration,
      buildGeneration: working.buildGeneration,
      t1FenceSha256: working.t1FenceSha256,
      t3aReceiptSha256: working.t3aReceiptSha256,
      t3bReceiptSha256: working.t3bReceiptSha256,
      t3cReceiptSha256: working.t3cReceiptSha256,
      policyVersion: working.policyVersion,
      policySha256: working.policySha256,
      policySchemaVersion: working.policySchemaVersion,
      retentionAnchorDbMs: working.retentionAnchorDbMs,
      purgeNotBeforeDbMs: working.purgeNotBeforeDbMs,
      sourceEvidenceDbMs: working.sourceEvidenceDbMs,
      planEntryCount: working.planEntryCount,
      planEntryRootSha256: working.planEntryRootSha256,
      blockerCount: working.blockerCount,
      blockerRootSha256: working.blockerRootSha256,
      storeDbTimestampMs: sealNowMs,
      completedClaimAttempt: stagedAuthorization.claimAttempt,
      completedClaimTokenSha256: tenantPurgePlanClaimTokenSha256(
        stagedAuthorization.claimToken,
      ),
      planComplete: true as const,
      executionReady: false as const,
      contentPurgeExecuted: false as const,
    };
    const receipt = clone<TenantPurgePlanReceipt>({
      ...receiptBody,
      receiptSha256: tenantPurgePlanReceiptSha256(receiptBody),
    });
    const jobsBefore = new Map(this.tenantPurgePlanJobs);
    const entriesBefore = new Map(this.tenantPurgePlanEntries);
    const receiptsBefore = new Map(this.tenantPurgePlanReceipts);
    try {
      if (this.tenantPurgePlanReceipts.has(working.requestId)) {
        throw new TenantErasureIntegrityError();
      }
      for (const entry of stagedEntries) {
        const key = this.tenantPurgePlanEntryKey(
          entry.requestId,
          entry.buildGeneration,
          entry.domain,
        );
        if (this.tenantPurgePlanEntries.has(key)) throw new TenantErasureIntegrityError();
        this.tenantPurgePlanEntries.set(key, entry);
      }
      this.tenantPurgePlanReceipts.set(working.requestId, receipt);
      const publishNowMs = this.storeNowMs();
      if (!tenantPurgePlanAuthorizationMatches(working, stagedAuthorization, publishNowMs)) {
        restoreMapSnapshot(this.tenantPurgePlanJobs, jobsBefore);
        restoreMapSnapshot(this.tenantPurgePlanEntries, entriesBefore);
        restoreMapSnapshot(this.tenantPurgePlanReceipts, receiptsBefore);
        return null;
      }
      if (publishNowMs < latestCapturedAtDbMs) {
        throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
      }
      const next = clone<TenantPurgePlanJobRecord>({
        requestId: working.requestId,
        tenantId: working.tenantId,
        subjectGeneration: working.subjectGeneration,
        buildGeneration: working.buildGeneration,
        t1FenceSha256: working.t1FenceSha256,
        t3aReceiptSha256: working.t3aReceiptSha256,
        t3bReceiptSha256: working.t3bReceiptSha256,
        t3cReceiptSha256: working.t3cReceiptSha256,
        policyVersion: working.policyVersion,
        policySha256: working.policySha256,
        policySchemaVersion: working.policySchemaVersion,
        retentionAnchorDbMs: working.retentionAnchorDbMs,
        purgeNotBeforeDbMs: working.purgeNotBeforeDbMs,
        sourceEvidenceDbMs: working.sourceEvidenceDbMs,
        phase: "plan_sealed",
        cursorDomain: working.cursorDomain!,
        scanComplete: true,
        planEntryCount: working.planEntryCount,
        planEntryRootSha256: working.planEntryRootSha256,
        blockerCount: working.blockerCount,
        blockerRootSha256: working.blockerRootSha256,
        attempts: working.attempts,
        createdAtMs: working.createdAtMs,
        updatedAtMs: Math.max(working.updatedAtMs, publishNowMs),
        planSealedAtDbMs: sealNowMs,
        completedClaimAttempt: stagedAuthorization.claimAttempt,
        completedClaimTokenSha256: receipt.completedClaimTokenSha256,
        aggregateReceiptSha256: receipt.receiptSha256,
      });
      validateTenantPurgePlanCompletionProof(next, entries, receipt);
      this.tenantPurgePlanJobs.set(working.requestId, next);
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgePlanJobs, jobsBefore);
      restoreMapSnapshot(this.tenantPurgePlanEntries, entriesBefore);
      restoreMapSnapshot(this.tenantPurgePlanReceipts, receiptsBefore);
      throw error;
    }
    return clone(receipt);
  }

  async getTenantPurgePlanJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgePlanJobRecord | null> {
    const job = this.tenantPurgePlanJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return null;
    this.assertTenantPurgePlanSource(job, job.phase !== "plan_sealed");
    const entries = this.tenantPurgePlanEntriesFor(job);
    if (job.phase === "plan_sealed") {
      const receipt = this.tenantPurgePlanReceipts.get(requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantPurgePlanCompletionProof(job, entries, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    }
    return clone(job);
  }

  async getTenantPurgePlanEntries(
    tenantId: string,
    requestId: string,
    buildGeneration: number,
  ): Promise<TenantPurgePlanEntry[]> {
    const job = this.tenantPurgePlanJobs.get(requestId);
    if (!job || job.tenantId !== tenantId || job.buildGeneration !== buildGeneration) return [];
    this.assertTenantPurgePlanSource(job, job.phase !== "plan_sealed");
    const entries = this.tenantPurgePlanEntriesFor(job);
    if (job.phase === "plan_sealed") {
      const receipt = this.tenantPurgePlanReceipts.get(requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      try {
        validateTenantPurgePlanCompletionProof(job, entries, receipt);
      } catch {
        throw new TenantErasureIntegrityError();
      }
    } else {
      for (const entry of entries) validateTenantPurgePlanEntry(entry);
      if (
        entries.length !== job.planEntryCount
        || tenantPurgePlanEntryRootSha256(entries) !== job.planEntryRootSha256
        || tenantPurgePlanBlockerRootSha256(entries) !== job.blockerRootSha256
      ) throw new TenantErasureIntegrityError();
    }
    return entries.map(clone);
  }

  async getTenantPurgePlanReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgePlanReceipt | null> {
    const receipt = this.tenantPurgePlanReceipts.get(requestId);
    if (!receipt || receipt.tenantId !== tenantId) return null;
    const job = this.tenantPurgePlanJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    const entries = this.tenantPurgePlanEntriesFor(job);
    this.assertTenantPurgePlanSource(job, false);
    try {
      validateTenantPurgePlanCompletionProof(job, entries, receipt);
    } catch {
      throw new TenantErasureIntegrityError();
    }
    return clone(receipt);
  }

  // ---------- tenant purge execution + local physical ACK ledger ----------
  private tenantPurgeExecutionDomainKey(
    requestId: string,
    executionGeneration: number,
    domain: TenantPurgePlanDomain,
  ): string {
    return JSON.stringify([requestId, executionGeneration, domain]);
  }

  private tenantPurgeExecutionAckKey(
    requestId: string,
    executionGeneration: number,
    globalAckSeq: number,
  ): string {
    return JSON.stringify([requestId, executionGeneration, globalAckSeq]);
  }

  private tenantPurgeExecutionDomainsFor(
    job: TenantPurgeExecutionJobRecord,
  ): TenantPurgeExecutionDomainRecord[] {
    return [...this.tenantPurgeExecutionDomains.values()]
      .filter((record) => (
        record.requestId === job.requestId
        && record.executionGeneration === job.executionGeneration
      ))
      .sort((left, right) => left.executionOrdinal - right.executionOrdinal);
  }

  private tenantPurgeExecutionAcksFor(
    job: TenantPurgeExecutionJobRecord,
  ): TenantPurgeExecutionDomainAck[] {
    return [...this.tenantPurgeExecutionDomainAcks.values()]
      .filter((ack) => (
        ack.requestId === job.requestId
        && ack.executionGeneration === job.executionGeneration
      ))
      .sort((left, right) => left.globalAckSeq - right.globalAckSeq);
  }

  private tenantPurgeExecutionIdentity(job: TenantPurgeExecutionJobRecord) {
    return {
      requestId: job.requestId,
      tenantId: job.tenantId,
      subjectGeneration: job.subjectGeneration,
      planBuildGeneration: job.planBuildGeneration,
      executionGeneration: job.executionGeneration,
    };
  }

  private tenantPurgeExecutionSource(job: TenantPurgeExecutionJobRecord) {
    return {
      ...this.tenantPurgeExecutionIdentity(job),
      t3cReceiptSha256: job.t3cReceiptSha256,
      planReceiptSha256: job.planReceiptSha256,
      planEntryRootSha256: job.planEntryRootSha256,
      planBlockerCount: job.planBlockerCount,
      planBlockerRootSha256: job.planBlockerRootSha256,
      policySha256: job.policySha256,
      purgeNotBeforeDbMs: job.purgeNotBeforeDbMs,
      sourceEvidenceDbMs: job.sourceEvidenceDbMs,
    };
  }

  private assertTenantPurgeExecutionCutoverState(): TenantPurgeExecutionCutoverRecord {
    if (this.tenantPurgeExecutionCutovers.size !== 1) throw new TenantErasureIntegrityError();
    const cutover = this.tenantPurgeExecutionCutovers.get(
      TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
    );
    if (!cutover) throw new TenantErasureIntegrityError();
    try {
      validateTenantPurgeExecutionCutoverRecord(cutover);
      if (cutover.controlGeneration === 0) {
        if (this.tenantPurgeLocalCutoverReceipts.size !== 0) {
          throw new Error("inactive execution cutover has a local receipt");
        }
      } else {
        const first = this.tenantPurgeLocalCutoverReceipts.get(cutover.firstRequestId);
        if (
          !first
          || first.receiptSha256 !== cutover.firstReceiptSha256
          || first.storeDbTimestampMs !== cutover.activatedAtDbMs
        ) throw new Error("active execution cutover lacks its first receipt");
      }
      return cutover;
    } catch {
      throw new TenantErasureIntegrityError();
    }
  }

  private assertTenantPurgeExecutionGlobalRelations(): void {
    this.assertTenantPurgeExecutionCutoverState();
    try {
      for (const [requestId, job] of this.tenantPurgeExecutionJobs) {
        if (requestId !== job.requestId) throw new Error("execution job identity is invalid");
      }
      for (const [key, domain] of this.tenantPurgeExecutionDomains) {
        const job = this.tenantPurgeExecutionJobs.get(domain.requestId);
        if (
          key !== this.tenantPurgeExecutionDomainKey(
            domain.requestId,
            domain.executionGeneration,
            domain.domain,
          )
          || !job
          || domain.tenantId !== job.tenantId
          || domain.subjectGeneration !== job.subjectGeneration
          || domain.planBuildGeneration !== job.planBuildGeneration
          || domain.executionGeneration !== job.executionGeneration
        ) throw new Error("execution domain owner relation is invalid");
      }
      for (const [key, ack] of this.tenantPurgeExecutionDomainAcks) {
        const job = this.tenantPurgeExecutionJobs.get(ack.requestId);
        if (
          key !== this.tenantPurgeExecutionAckKey(
            ack.requestId,
            ack.executionGeneration,
            ack.globalAckSeq,
          )
          || !job
          || ack.tenantId !== job.tenantId
          || ack.subjectGeneration !== job.subjectGeneration
          || ack.planBuildGeneration !== job.planBuildGeneration
          || ack.executionGeneration !== job.executionGeneration
        ) throw new Error("execution ACK owner relation is invalid");
      }
      for (const [requestId, receipt] of this.tenantPurgeLocalCutoverReceipts) {
        const job = this.tenantPurgeExecutionJobs.get(requestId);
        if (!job || receipt.requestId !== requestId || receipt.tenantId !== job.tenantId) {
          throw new Error("execution cutover receipt owner relation is invalid");
        }
      }
      for (const [requestId, receipt] of this.tenantPurgeLocalPhysicalAckReceipts) {
        const job = this.tenantPurgeExecutionJobs.get(requestId);
        if (!job || receipt.requestId !== requestId || receipt.tenantId !== job.tenantId) {
          throw new Error("execution physical receipt owner relation is invalid");
        }
      }
    } catch (error) {
      if (error instanceof TenantErasureIntegrityError) throw error;
      throw new TenantErasureIntegrityError();
    }
  }

  private assertTenantPurgeExecutionState(
    job: TenantPurgeExecutionJobRecord,
    requireLivePlan: boolean,
  ): {
    planJob: Extract<TenantPurgePlanJobRecord, { phase: "plan_sealed" }>;
    planReceipt: TenantPurgePlanReceipt;
    planEntries: TenantPurgePlanEntry[];
    domains: TenantPurgeExecutionDomainRecord[];
    acks: TenantPurgeExecutionDomainAck[];
  } {
    try {
      validateTenantPurgeExecutionJobRecord(job);
      this.assertTenantPurgeExecutionGlobalRelations();
      const planJob = this.tenantPurgePlanJobs.get(job.requestId);
      const planReceipt = this.tenantPurgePlanReceipts.get(job.requestId);
      if (!planJob || planJob.phase !== "plan_sealed" || !planReceipt) {
        throw new Error("tenant purge execution plan source is missing");
      }
      const planEntries = this.tenantPurgePlanEntriesFor(planJob);
      const source = this.assertTenantPurgePlanSource(planJob, requireLivePlan);
      validateTenantPurgePlanCompletionProof(planJob, planEntries, planReceipt);
      if (requireLivePlan) {
        this.assertTenantPurgePlanGlobalRelations();
        const holdProof = this.tenantPurgePlanHoldProof(job.tenantId);
        this.assertTenantPurgePlanBuildState(planJob, source, holdProof);
      }
      if (
        planJob.requestId !== job.requestId
        || planJob.tenantId !== job.tenantId
        || planJob.subjectGeneration !== job.subjectGeneration
        || planJob.buildGeneration !== job.planBuildGeneration
        || planReceipt.t3cReceiptSha256 !== job.t3cReceiptSha256
        || planReceipt.receiptSha256 !== job.planReceiptSha256
        || planReceipt.planEntryRootSha256 !== job.planEntryRootSha256
        || planReceipt.blockerCount !== job.planBlockerCount
        || planReceipt.blockerRootSha256 !== job.planBlockerRootSha256
        || planReceipt.policySha256 !== job.policySha256
        || planReceipt.purgeNotBeforeDbMs !== job.purgeNotBeforeDbMs
        || planReceipt.storeDbTimestampMs !== job.sourceEvidenceDbMs
      ) throw new Error("tenant purge execution source binding is invalid");

      const domains = this.tenantPurgeExecutionDomainsFor(job);
      if (domains.length !== TENANT_PURGE_PLAN_DOMAINS.length) {
        throw new Error("tenant purge execution domain catalog is incomplete");
      }
      for (const [index, domain] of domains.entries()) {
        validateTenantPurgeExecutionDomainRecord(domain);
        const planEntry = planEntries[index];
        if (
          domain.domain !== TENANT_PURGE_PLAN_DOMAINS[index]
          || !planEntry
          || planEntry.domain !== domain.domain
          || domain.requestId !== job.requestId
          || domain.tenantId !== job.tenantId
          || domain.subjectGeneration !== job.subjectGeneration
          || domain.planBuildGeneration !== job.planBuildGeneration
          || domain.executionGeneration !== job.executionGeneration
          || domain.planDisposition !== planEntry.disposition
          || domain.planTargetCount !== planEntry.targetCount
          || domain.planTargetRootSha256 !== planEntry.targetRootSha256
          || domain.planSourceSha256 !== planEntry.sourceSha256
          || domain.planEntryReceiptSha256 !== planEntry.receiptSha256
        ) throw new Error("tenant purge execution domain source is invalid");
      }

      const acks = this.tenantPurgeExecutionAcksFor(job);
      let globalRoot = EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256;
      const domainCounts = new Map<TenantPurgePlanDomain, number>();
      const domainRoots = new Map<TenantPurgePlanDomain, string>();
      const finalAcks = new Map<TenantPurgePlanDomain, string>();
      const blockerResolutions = new Set<TenantPurgePlanDomain>();
      const physicalPending = new Set<TenantPurgePlanDomain>();
      for (const [index, ack] of acks.entries()) {
        validateTenantPurgeExecutionDomainAck(ack);
        const domain = domains[tenantPurgePlanDomainOrdinal(ack.domain)];
        const domainCount = domainCounts.get(ack.domain) ?? 0;
        const domainRoot = domainRoots.get(ack.domain)
          ?? EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256;
        if (
          ack.globalAckSeq !== index + 1
          || ack.domainAckSeq !== domainCount + 1
          || ack.previousGlobalAckSha256 !== globalRoot
          || ack.previousDomainAckSha256 !== domainRoot
          || ack.requestId !== job.requestId
          || ack.tenantId !== job.tenantId
          || ack.subjectGeneration !== job.subjectGeneration
          || ack.planBuildGeneration !== job.planBuildGeneration
          || ack.executionGeneration !== job.executionGeneration
          || ack.planEntryReceiptSha256 !== domain?.planEntryReceiptSha256
          || finalAcks.has(ack.domain)
        ) throw new Error("tenant purge execution ACK chain is invalid");
        const nextDomainRoot = tenantPurgeExecutionNextDomainAckRootSha256(
          domainRoot,
          ack.domain,
          ack.receiptSha256,
        );
        globalRoot = tenantPurgeExecutionNextGlobalAckRootSha256(
          globalRoot,
          ack.globalAckSeq,
          ack.receiptSha256,
        );
        domainCounts.set(ack.domain, domainCount + 1);
        domainRoots.set(ack.domain, nextDomainRoot);
        if (ack.final) finalAcks.set(ack.domain, ack.receiptSha256);
        if (ack.ackKind === "blocker_resolution") {
          if (blockerResolutions.has(ack.domain)) {
            throw new Error("tenant purge execution blocker is resolved more than once");
          }
          blockerResolutions.add(ack.domain);
        }
        if (ack.ackKind === "outbox_scheduled") physicalPending.add(ack.domain);
        if (ack.ackKind === "physical_delete" && ack.final) physicalPending.delete(ack.domain);
      }
      if (acks.length !== job.domainAckCount || globalRoot !== job.domainAckRootSha256) {
        throw new Error("tenant purge execution aggregate ACK chain is invalid");
      }
      for (const domain of domains) {
        const ackCount = domainCounts.get(domain.domain) ?? 0;
        const ackRoot = domainRoots.get(domain.domain)
          ?? EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256;
        const expectedPhase = finalAcks.has(domain.domain)
          ? "acked"
          : blockerResolutions.has(domain.domain) || physicalPending.has(domain.domain)
            ? "awaiting_physical_ack"
            : isTenantPurgePlanBlockingDisposition(domain.planDisposition)
              ? "awaiting_blocker_resolution"
              : "pending";
        if (
          domain.ackCount !== ackCount
          || domain.ackRootSha256 !== ackRoot
          || domain.finalAckSha256 !== finalAcks.get(domain.domain)
          || domain.phase !== expectedPhase
        ) throw new Error("tenant purge execution domain ACK state is invalid");
      }
      if (job.unresolvedBlockerCount !== job.planBlockerCount - blockerResolutions.size) {
        throw new Error("tenant purge execution unresolved blocker count is invalid");
      }

      const cutoverReceipt = this.tenantPurgeLocalCutoverReceipts.get(job.requestId);
      if (cutoverReceipt) {
        validateTenantPurgeLocalCutoverReceipt(cutoverReceipt);
        const operational = domains[tenantPurgePlanDomainOrdinal("operational_usage")]!;
        const blob = domains[tenantPurgePlanDomainOrdinal("blob_bytes")]!;
        const exportControl = domains[tenantPurgePlanDomainOrdinal("user_export_control")]!;
        const exportSnapshots = domains[tenantPurgePlanDomainOrdinal("user_export_snapshots")]!;
        const exportBytes = domains[tenantPurgePlanDomainOrdinal("user_export_bytes")]!;
        const cutoverAcks = acks.slice(0, cutoverReceipt.domainAckCount);
        let cursor = 0;
        const operationMatches = (ack: TenantPurgeExecutionDomainAck, action: string) => (
          ack.adapterProtocol === "local-store-v1"
          && ack.operationSha256 === tenantPurgeExecutionOperationSha256({
            identity: this.tenantPurgeExecutionIdentity(job),
            domain: ack.domain,
            action,
            affectedCount: ack.affectedCount,
            resultCount: ack.resultCount,
            resultRootSha256: ack.resultRootSha256,
          })
        );
        const take = (
          domain: TenantPurgePlanDomain,
          ackKind: TenantPurgeExecutionDomainAck["ackKind"],
          final: boolean,
        ) => {
          const ack = cutoverAcks[cursor++];
          if (!ack || ack.domain !== domain || ack.ackKind !== ackKind || ack.final !== final) {
            throw new Error("tenant purge execution local ACK order is invalid");
          }
          return ack;
        };
        const operationalAck = take("operational_usage", "anonymized", true);
        if (
          operationalAck.affectedCount !== operational.planTargetCount
          || operationalAck.resultCount !== operational.planTargetCount
          || !operationMatches(operationalAck, "anonymize")
        ) throw new Error("tenant purge execution usage ACK count is invalid");
        const blobResolution = take(
          "blob_bytes",
          "blocker_resolution",
          blob.planTargetCount === 0,
        );
        if (
          blob.planDisposition !== "blocked_adapter_unconfigured"
          || blobResolution.affectedCount !== blob.planTargetCount
          || blobResolution.resultCount !== blob.planTargetCount
          || !operationMatches(blobResolution, "schedule-delete")
        ) throw new Error("tenant purge execution Blob blocker resolution is invalid");
        const blobScheduled: TenantPurgeExecutionDomainAck[] = [];
        for (let index = 0; index < blob.planTargetCount; index += 1) {
          blobScheduled.push(take("blob_bytes", "outbox_scheduled", false));
        }
        const controlAck = take("user_export_control", "applied", true);
        const snapshotAck = take("user_export_snapshots", "applied", true);
        if (
          controlAck.affectedCount !== exportControl.planTargetCount
          || controlAck.resultCount !== exportControl.planTargetCount
          || snapshotAck.affectedCount !== exportSnapshots.planTargetCount
          || snapshotAck.resultCount !== exportSnapshots.planTargetCount
          || controlAck.resultRootSha256 !== tenantPurgeExecutionResultRootSha256(
            "user_export_control",
            "revoke",
            this.tenantPurgeExecutionAppliedResultHashes(
              job,
              "user_export_control",
              "revoke-result",
              exportControl.planTargetCount,
              exportControl.planTargetRootSha256,
            ),
          )
          || snapshotAck.resultRootSha256 !== tenantPurgeExecutionResultRootSha256(
            "user_export_snapshots",
            "release-pins",
            this.tenantPurgeExecutionAppliedResultHashes(
              job,
              "user_export_snapshots",
              "release-pin-result",
              exportSnapshots.planTargetCount,
              exportSnapshots.planTargetRootSha256,
            ),
          )
          || !operationMatches(controlAck, "revoke")
          || !operationMatches(snapshotAck, "release-pins")
        ) throw new Error("tenant purge execution export relation ACK count is invalid");
        const exportResolution = take(
          "user_export_bytes",
          "blocker_resolution",
          exportBytes.planTargetCount === 0,
        );
        if (
          exportBytes.planDisposition !== "blocked_adapter_unconfigured"
          || exportResolution.affectedCount !== exportBytes.planTargetCount
          || exportResolution.resultCount !== exportBytes.planTargetCount
          || !operationMatches(exportResolution, "schedule-delete")
        ) throw new Error("tenant purge execution export blocker resolution is invalid");
        const exportScheduled: TenantPurgeExecutionDomainAck[] = [];
        for (let index = 0; index < exportBytes.planTargetCount; index += 1) {
          exportScheduled.push(take("user_export_bytes", "outbox_scheduled", false));
        }
        if (cursor !== cutoverAcks.length) {
          throw new Error("tenant purge execution cutover has an unsupported ACK");
        }
        const validateScheduled = (
          scheduled: TenantPurgeExecutionDomainAck[],
          outboxKind: TenantPurgeExecutionOutboxReference["outboxKind"],
        ): TenantPurgeExecutionOutboxReference[] => {
          const refs = scheduled.map((ack) => {
            if (
              ack.outboxKind !== outboxKind
              || ack.outboxId === undefined
              || ack.deletionGeneration === undefined
              || ack.targetSha256 === undefined
              || ack.scheduledAckSha256 !== undefined
              || ack.affectedCount !== 1
              || ack.resultCount !== 1
            ) throw new Error("tenant purge execution scheduled ACK is invalid");
            return {
              outboxKind,
              outboxId: ack.outboxId,
              deletionGeneration: ack.deletionGeneration,
              targetSha256: ack.targetSha256,
            };
          });
          if (scheduled.some((ack, index) => (
            index > 0 && scheduled[index - 1]!.targetSha256! >= ack.targetSha256!
          ))) throw new Error("tenant purge execution scheduled ACK order is invalid");
          return refs;
        };
        const blobReferences = validateScheduled(blobScheduled, "blob_delete");
        const exportReferences = validateScheduled(exportScheduled, "user_export_delete");
        const validateOutboxProofs = (
          resolution: TenantPurgeExecutionDomainAck,
          scheduled: TenantPurgeExecutionDomainAck[],
          domain: "blob_bytes" | "user_export_bytes",
          refs: TenantPurgeExecutionOutboxReference[],
        ) => {
          const hashes = refs.map(tenantPurgeExecutionOutboxTargetSha256);
          if (
            resolution.resultRootSha256
              !== tenantPurgeExecutionResultRootSha256(domain, "schedule-delete", hashes)
            || scheduled.some((ack, index) => (
              ack.resultRootSha256 !== tenantPurgeExecutionResultRootSha256(
                domain,
                "outbox-scheduled",
                [hashes[index]!],
              )
              || !operationMatches(ack, "outbox-scheduled")
            ))
          ) throw new Error("tenant purge execution outbox proof is invalid");
        };
        validateOutboxProofs(blobResolution, blobScheduled, "blob_bytes", blobReferences);
        validateOutboxProofs(
          exportResolution,
          exportScheduled,
          "user_export_bytes",
          exportReferences,
        );
        let cutoverRoot = EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256;
        for (const ack of cutoverAcks) {
          cutoverRoot = tenantPurgeExecutionNextGlobalAckRootSha256(
            cutoverRoot,
            ack.globalAckSeq,
            ack.receiptSha256,
          );
        }
        if (
          cutoverReceipt.requestId !== job.requestId
          || cutoverReceipt.tenantId !== job.tenantId
          || cutoverReceipt.subjectGeneration !== job.subjectGeneration
          || cutoverReceipt.planBuildGeneration !== job.planBuildGeneration
          || cutoverReceipt.executionGeneration !== job.executionGeneration
          || cutoverReceipt.t3cReceiptSha256 !== job.t3cReceiptSha256
          || cutoverReceipt.planReceiptSha256 !== job.planReceiptSha256
          || cutoverReceipt.planEntryRootSha256 !== job.planEntryRootSha256
          || cutoverReceipt.planBlockerCount !== job.planBlockerCount
          || cutoverReceipt.planBlockerRootSha256 !== job.planBlockerRootSha256
          || cutoverReceipt.policySha256 !== job.policySha256
          || cutoverReceipt.purgeNotBeforeDbMs !== job.purgeNotBeforeDbMs
          || cutoverReceipt.sourceEvidenceDbMs !== job.sourceEvidenceDbMs
          || cutoverReceipt.receiptSha256 !== job.localCutoverReceiptSha256
          || cutoverReceipt.domainAckCount > acks.length
          || cutoverReceipt.domainAckRootSha256 !== cutoverRoot
          || cutoverReceipt.operationalUsageTargetCount !== operational.planTargetCount
          || cutoverReceipt.operationalUsageTargetRootSha256 !== operational.planTargetRootSha256
          || cutoverReceipt.blobBytesTargetCount !== blob.planTargetCount
          || cutoverReceipt.blobBytesTargetRootSha256 !== blob.planTargetRootSha256
          || cutoverReceipt.blobDeleteOutboxCount !== blobReferences.length
          || cutoverReceipt.blobDeleteOutboxRootSha256
            !== tenantPurgeExecutionOutboxRootSha256(blobReferences)
          || cutoverReceipt.exportBytesTargetCount !== exportBytes.planTargetCount
          || cutoverReceipt.exportBytesTargetRootSha256 !== exportBytes.planTargetRootSha256
          || cutoverReceipt.exportDeleteOutboxCount !== exportReferences.length
          || cutoverReceipt.exportDeleteOutboxRootSha256
            !== tenantPurgeExecutionOutboxRootSha256(exportReferences)
          || cutoverAcks.some((ack) => (
            ack.storeDbTimestampMs !== cutoverReceipt.storeDbTimestampMs
            || ack.completedClaimAttempt !== cutoverReceipt.completedClaimAttempt
            || ack.completedClaimTokenSha256 !== cutoverReceipt.completedClaimTokenSha256
          ))
        ) throw new Error("tenant purge execution local cutover receipt is invalid");

        const remaining = acks.slice(cutoverReceipt.domainAckCount);
        const blobPhysical = remaining.slice(0, blobReferences.length);
        const exportPhysical = remaining.slice(blobReferences.length);
        const validatePhysical = (
          physical: TenantPurgeExecutionDomainAck[],
          domain: "blob_bytes" | "user_export_bytes",
          scheduled: TenantPurgeExecutionDomainAck[],
          refs: TenantPurgeExecutionOutboxReference[],
        ) => {
          if (physical.length !== refs.length) {
            throw new Error("tenant purge execution physical ACK count is invalid");
          }
          for (const [index, ack] of physical.entries()) {
            const reference = refs[index]!;
            const scheduledAck = scheduled[index]!;
            if (
              ack.domain !== domain
              || ack.ackKind !== "physical_delete"
              || ack.final !== (index === physical.length - 1)
              || ack.outboxKind !== reference.outboxKind
              || ack.outboxId !== reference.outboxId
              || ack.deletionGeneration !== reference.deletionGeneration
              || ack.targetSha256 !== reference.targetSha256
              || ack.scheduledAckSha256 !== scheduledAck.receiptSha256
              || ack.affectedCount !== 1
              || ack.resultCount !== 1
              || ack.resultRootSha256 !== tenantPurgeExecutionResultRootSha256(
                domain,
                "physical-delete",
                [tenantPurgeExecutionOutboxTargetSha256(reference)],
              )
              || !operationMatches(ack, "physical-delete")
            ) throw new Error("tenant purge execution physical ACK chain is invalid");
          }
        };
        if (job.phase === "local_physical_acks_sealed") {
          if (remaining.length !== blobReferences.length + exportReferences.length) {
            throw new Error("tenant purge execution physical ACK catalog is invalid");
          }
          validatePhysical(blobPhysical, "blob_bytes", blobScheduled, blobReferences);
          validatePhysical(exportPhysical, "user_export_bytes", exportScheduled, exportReferences);
        } else if (remaining.length !== 0) {
          throw new Error("tenant purge execution has a partial physical ACK publication");
        }
      } else if (job.localCutoverReceiptSha256 !== undefined || acks.length !== 0) {
        throw new Error("tenant purge execution has ACKs without local cutover");
      }
      const physicalReceipt = this.tenantPurgeLocalPhysicalAckReceipts.get(job.requestId);
      if (physicalReceipt) {
        validateTenantPurgeLocalPhysicalAckReceipt(physicalReceipt);
        const physicalAcks = acks.slice(cutoverReceipt!.domainAckCount);
        const blobPhysicalHashes = physicalAcks
          .filter((ack) => ack.domain === "blob_bytes")
          .map((ack) => ack.receiptSha256);
        const exportPhysicalHashes = physicalAcks
          .filter((ack) => ack.domain === "user_export_bytes")
          .map((ack) => ack.receiptSha256);
        if (
          job.phase !== "local_physical_acks_sealed"
          || physicalReceipt.requestId !== job.requestId
          || physicalReceipt.tenantId !== job.tenantId
          || physicalReceipt.subjectGeneration !== job.subjectGeneration
          || physicalReceipt.planBuildGeneration !== job.planBuildGeneration
          || physicalReceipt.executionGeneration !== job.executionGeneration
          || physicalReceipt.t3cReceiptSha256 !== job.t3cReceiptSha256
          || physicalReceipt.planReceiptSha256 !== job.planReceiptSha256
          || physicalReceipt.planEntryRootSha256 !== job.planEntryRootSha256
          || physicalReceipt.planBlockerCount !== job.planBlockerCount
          || physicalReceipt.planBlockerRootSha256 !== job.planBlockerRootSha256
          || physicalReceipt.policySha256 !== job.policySha256
          || physicalReceipt.purgeNotBeforeDbMs !== job.purgeNotBeforeDbMs
          || physicalReceipt.sourceEvidenceDbMs !== job.sourceEvidenceDbMs
          || physicalReceipt.receiptSha256 !== job.localPhysicalAckReceiptSha256
          || physicalReceipt.localCutoverReceiptSha256 !== job.localCutoverReceiptSha256
          || physicalReceipt.domainAckCount !== job.domainAckCount
          || physicalReceipt.domainAckRootSha256 !== job.domainAckRootSha256
          || physicalReceipt.unresolvedBlockerCount !== job.unresolvedBlockerCount
          || physicalReceipt.completedClaimAttempt !== job.completedClaimAttempt
          || physicalReceipt.completedClaimTokenSha256 !== job.completedClaimTokenSha256
          || physicalReceipt.storeDbTimestampMs !== job.localPhysicalAcksSealedAtDbMs
          || physicalReceipt.blobPhysicalAckCount !== blobPhysicalHashes.length
          || physicalReceipt.blobPhysicalAckRootSha256 !== tenantPurgeExecutionResultRootSha256(
            "blob_bytes",
            "physical-ack-chain",
            blobPhysicalHashes,
          )
          || physicalReceipt.exportPhysicalAckCount !== exportPhysicalHashes.length
          || physicalReceipt.exportPhysicalAckRootSha256 !== tenantPurgeExecutionResultRootSha256(
            "user_export_bytes",
            "physical-ack-chain",
            exportPhysicalHashes,
          )
          || physicalAcks.some((ack) => (
            ack.storeDbTimestampMs !== physicalReceipt.storeDbTimestampMs
            || ack.completedClaimAttempt !== physicalReceipt.completedClaimAttempt
            || ack.completedClaimTokenSha256 !== physicalReceipt.completedClaimTokenSha256
          ))
        ) throw new Error("tenant purge execution physical ACK receipt is invalid");
      } else if (job.phase === "local_physical_acks_sealed") {
        throw new Error("tenant purge execution terminal receipt is missing");
      }
      return { planJob, planReceipt, planEntries, domains, acks };
    } catch (error) {
      if (error instanceof TenantPurgeExecutionNotReadyError) throw error;
      if (
        error instanceof TenantPurgePlanNotReadyError
        && error.reason === "active_legal_hold"
      ) throw new TenantPurgeExecutionNotReadyError("active_legal_hold");
      if (
        error instanceof TenantPurgePlanEvidenceChangedError
        || error instanceof TenantContentInventoryEvidenceChangedError
      ) throw new TenantPurgeExecutionEvidenceChangedError();
      throw new TenantErasureIntegrityError();
    }
  }

  private blockedTenantPurgeExecutionJob(
    current: TenantPurgeExecutionJobRecord,
    blockedAtDbMs: number,
    reason: TenantPurgeExecutionBlockReasonCode,
    attempts = current.attempts,
  ): TenantPurgeExecutionJobRecord {
    const terminalAtDbMs = Math.max(current.createdAtMs, current.updatedAtMs, blockedAtDbMs);
    const blocked = clone<TenantPurgeExecutionJobRecord>({
      ...this.tenantPurgeExecutionSource(current),
      phase: "blocked",
      domainCount: current.domainCount,
      domainAckCount: current.domainAckCount,
      domainAckRootSha256: current.domainAckRootSha256,
      unresolvedBlockerCount: current.unresolvedBlockerCount,
      ...(current.localCutoverReceiptSha256 === undefined
        ? {} : { localCutoverReceiptSha256: current.localCutoverReceiptSha256 }),
      attempts,
      createdAtMs: current.createdAtMs,
      updatedAtMs: terminalAtDbMs,
      blockedAtDbMs: terminalAtDbMs,
      blockedReasonCode: reason,
    });
    validateTenantPurgeExecutionJobRecord(blocked);
    return blocked;
  }

  async materializeTenantPurgeExecutionJobs(
    options: MaterializeTenantPurgeExecutionJobsOptions,
  ): Promise<number> {
    const stagedOptions = clone(options);
    validateMaterializeTenantPurgeExecutionJobsOptions(stagedOptions);
    this.assertTenantPurgeExecutionGlobalRelations();
    const nowMs = this.storeNowMs();
    const candidates = [...this.tenantPurgePlanJobs.values()]
      .filter((job): job is Extract<TenantPurgePlanJobRecord, { phase: "plan_sealed" }> => (
        job.phase === "plan_sealed" && !this.tenantPurgeExecutionJobs.has(job.requestId)
      ))
      .sort((left, right) => left.requestId.localeCompare(right.requestId));
    const jobs: TenantPurgeExecutionJobRecord[] = [];
    const domains: TenantPurgeExecutionDomainRecord[] = [];
    for (const planJob of candidates) {
      if (jobs.length >= stagedOptions.limit) break;
      const receipt = this.tenantPurgePlanReceipts.get(planJob.requestId);
      if (!receipt) throw new TenantErasureIntegrityError();
      const entries = this.tenantPurgePlanEntriesFor(planJob);
      this.assertTenantPurgePlanSource(planJob, true);
      validateTenantPurgePlanCompletionProof(planJob, entries, receipt);
      this.assertTenantPurgePlanGlobalRelations();
      const holdProof = this.tenantPurgePlanHoldProof(planJob.tenantId);
      this.assertTenantPurgePlanBuildState(planJob, this.assertTenantPurgePlanSource(planJob, true), holdProof);
      if (nowMs < receipt.storeDbTimestampMs) continue;
      if (
        [...this.tenantPurgeExecutionJobs.values()].some((job) => job.tenantId === planJob.tenantId)
        || [...this.tenantPurgeExecutionDomains.values()].some((row) => (
          row.requestId === planJob.requestId || row.tenantId === planJob.tenantId
        ))
        || [...this.tenantPurgeExecutionDomainAcks.values()].some((row) => (
          row.requestId === planJob.requestId || row.tenantId === planJob.tenantId
        ))
        || [...this.tenantPurgeLocalCutoverReceipts.values()].some((row) => (
          row.requestId === planJob.requestId || row.tenantId === planJob.tenantId
        ))
        || [...this.tenantPurgeLocalPhysicalAckReceipts.values()].some((row) => (
          row.requestId === planJob.requestId || row.tenantId === planJob.tenantId
        ))
      ) throw new TenantErasureIntegrityError();
      const job = clone<TenantPurgeExecutionJobRecord>({
        requestId: planJob.requestId,
        tenantId: planJob.tenantId,
        subjectGeneration: planJob.subjectGeneration,
        planBuildGeneration: planJob.buildGeneration,
        executionGeneration: 1,
        t3cReceiptSha256: receipt.t3cReceiptSha256,
        planReceiptSha256: receipt.receiptSha256,
        planEntryRootSha256: receipt.planEntryRootSha256,
        planBlockerCount: receipt.blockerCount,
        planBlockerRootSha256: receipt.blockerRootSha256,
        policySha256: receipt.policySha256,
        purgeNotBeforeDbMs: receipt.purgeNotBeforeDbMs,
        sourceEvidenceDbMs: receipt.storeDbTimestampMs,
        phase: "queued",
        domainCount: TENANT_PURGE_PLAN_DOMAINS.length,
        domainAckCount: 0,
        domainAckRootSha256: EMPTY_TENANT_PURGE_EXECUTION_GLOBAL_ACK_ROOT_SHA256,
        unresolvedBlockerCount: receipt.blockerCount,
        availableAtMs: nowMs,
        attempts: 0,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      validateTenantPurgeExecutionJobRecord(job);
      jobs.push(job);
      for (const entry of entries) {
        const row = clone<TenantPurgeExecutionDomainRecord>({
          ...this.tenantPurgeExecutionIdentity(job),
          domain: entry.domain,
          executionOrdinal: tenantPurgePlanDomainOrdinal(entry.domain),
          planDisposition: entry.disposition,
          planTargetCount: entry.targetCount,
          planTargetRootSha256: entry.targetRootSha256,
          planSourceSha256: entry.sourceSha256,
          planEntryReceiptSha256: entry.receiptSha256,
          phase: isTenantPurgePlanBlockingDisposition(entry.disposition)
            ? "awaiting_blocker_resolution"
            : "pending",
          ackCount: 0,
          ackRootSha256: EMPTY_TENANT_PURGE_EXECUTION_DOMAIN_ACK_ROOT_SHA256,
          updatedAtMs: nowMs,
        });
        validateTenantPurgeExecutionDomainRecord(row);
        domains.push(row);
      }
    }
    const jobsBefore = new Map(this.tenantPurgeExecutionJobs);
    const domainsBefore = new Map(this.tenantPurgeExecutionDomains);
    try {
      for (const job of jobs) this.tenantPurgeExecutionJobs.set(job.requestId, job);
      for (const domain of domains) {
        const key = this.tenantPurgeExecutionDomainKey(
          domain.requestId,
          domain.executionGeneration,
          domain.domain,
        );
        if (this.tenantPurgeExecutionDomains.has(key)) throw new TenantErasureIntegrityError();
        this.tenantPurgeExecutionDomains.set(key, domain);
      }
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgeExecutionJobs, jobsBefore);
      restoreMapSnapshot(this.tenantPurgeExecutionDomains, domainsBefore);
      throw error;
    }
    return jobs.length;
  }

  async claimTenantPurgeExecutions(
    options: ClaimTenantPurgeExecutionsOptions,
  ): Promise<TenantPurgeExecutionClaim[]> {
    const stagedOptions = clone(options);
    validateClaimTenantPurgeExecutionsOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const leaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (leaseUntilMs <= nowMs) return [];
    const candidates = [...this.tenantPurgeExecutionJobs.values()]
      .filter((job): job is Extract<TenantPurgeExecutionJobRecord, { phase: "queued" }> => (
        job.phase === "queued"
        && job.availableAtMs <= nowMs
        && (job.claimToken === undefined || job.leaseUntilMs! <= nowMs)
      ))
      .sort((left, right) => (
        left.availableAtMs - right.availableAtMs || left.requestId.localeCompare(right.requestId)
      ))
      .slice(0, stagedOptions.limit);
    const staged: TenantPurgeExecutionJobRecord[] = [];
    const claims: TenantPurgeExecutionJobRecord[] = [];
    for (const current of candidates) {
      const attempts = current.attempts + 1;
      if (!Number.isSafeInteger(attempts) || attempts > 0xffff_ffff) {
        throw new TenantErasureIntegrityError();
      }
      try {
        this.assertTenantPurgeExecutionState(
          current,
          current.localCutoverReceiptSha256 === undefined,
        );
      } catch (error) {
        if (error instanceof TenantPurgeExecutionNotReadyError) continue;
        if (
          !(error instanceof TenantErasureIntegrityError)
          && !(error instanceof TenantPurgeExecutionEvidenceChangedError)
        ) throw error;
        staged.push(this.blockedTenantPurgeExecutionJob(
          current,
          nowMs,
          "integrity_conflict",
          attempts,
        ));
        continue;
      }
      const next = clone<TenantPurgeExecutionJobRecord>({
        ...current,
        attempts,
        claimToken: stagedOptions.claimToken,
        leaseUntilMs,
        updatedAtMs: Math.max(current.updatedAtMs, nowMs),
      });
      delete next.lastErrorCode;
      validateTenantPurgeExecutionJobRecord(next);
      staged.push(next);
      claims.push(next);
    }
    const prior = new Map(this.tenantPurgeExecutionJobs);
    try {
      for (const job of staged) this.tenantPurgeExecutionJobs.set(job.requestId, job);
    } catch (error) {
      restoreMapSnapshot(this.tenantPurgeExecutionJobs, prior);
      throw error;
    }
    return claims.map((job) => clone(tenantPurgeExecutionClaimFromJob(job)));
  }

  async renewTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    options: RenewTenantPurgeExecutionOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantPurgeExecutionAuthorization(stagedAuthorization);
    validateRenewTenantPurgeExecutionOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const requestedLeaseUntilMs = stagedOptions.leaseMs > Number.MAX_SAFE_INTEGER - nowMs
      ? Number.MAX_SAFE_INTEGER
      : nowMs + stagedOptions.leaseMs;
    if (requestedLeaseUntilMs <= nowMs) return false;
    const current = this.tenantPurgeExecutionJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantPurgeExecutionAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantPurgeExecutionState(current, current.localCutoverReceiptSha256 === undefined);
    const next = clone<TenantPurgeExecutionJobRecord>({
      ...current,
      leaseUntilMs: Math.max(current.leaseUntilMs!, requestedLeaseUntilMs),
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantPurgeExecutionJobRecord(next);
    try {
      this.tenantPurgeExecutionJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgeExecutionJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async retryTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    options: RetryTenantPurgeExecutionOptions,
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    const stagedOptions = clone(options);
    validateTenantPurgeExecutionAuthorization(stagedAuthorization);
    validateRetryTenantPurgeExecutionOptions(stagedOptions);
    const nowMs = this.storeNowMs();
    const current = this.tenantPurgeExecutionJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantPurgeExecutionAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    this.assertTenantPurgeExecutionState(current, current.localCutoverReceiptSha256 === undefined);
    const baseMs = Math.max(nowMs, current.createdAtMs, current.updatedAtMs, current.availableAtMs);
    const availableAtMs = stagedOptions.delayMs > Number.MAX_SAFE_INTEGER - baseMs
      ? Number.MAX_SAFE_INTEGER
      : baseMs + stagedOptions.delayMs;
    const next = clone<TenantPurgeExecutionJobRecord>({
      ...this.tenantPurgeExecutionSource(current),
      phase: "queued",
      domainCount: current.domainCount,
      domainAckCount: current.domainAckCount,
      domainAckRootSha256: current.domainAckRootSha256,
      unresolvedBlockerCount: current.unresolvedBlockerCount,
      ...(current.localCutoverReceiptSha256 === undefined
        ? {} : { localCutoverReceiptSha256: current.localCutoverReceiptSha256 }),
      availableAtMs,
      attempts: current.attempts,
      lastErrorCode: stagedOptions.errorCode,
      createdAtMs: current.createdAtMs,
      updatedAtMs: Math.max(current.updatedAtMs, nowMs),
    });
    validateTenantPurgeExecutionJobRecord(next);
    try {
      this.tenantPurgeExecutionJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgeExecutionJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  async blockTenantPurgeExecution(
    authorization: TenantPurgeExecutionAuthorization,
    reason: TenantPurgeExecutionBlockReasonCode = "integrity_conflict",
  ): Promise<boolean> {
    const stagedAuthorization = clone(authorization);
    validateTenantPurgeExecutionAuthorization(stagedAuthorization);
    const nowMs = this.storeNowMs();
    const current = this.tenantPurgeExecutionJobs.get(stagedAuthorization.requestId);
    if (!current || !tenantPurgeExecutionAuthorizationMatches(
      current,
      stagedAuthorization,
      nowMs,
    )) return false;
    const next = this.blockedTenantPurgeExecutionJob(current, nowMs, reason);
    try {
      this.tenantPurgeExecutionJobs.set(current.requestId, next);
    } catch (error) {
      restoreMapEntry(this.tenantPurgeExecutionJobs, current.requestId, true, current);
      throw error;
    }
    return true;
  }

  private appendTenantPurgeExecutionAck(
    current: Extract<TenantPurgeExecutionJobRecord, { phase: "queued" }>,
    domainName: TenantPurgePlanDomain,
    input: {
      ackKind: TenantPurgeExecutionDomainAck["ackKind"];
      action: string;
      affectedCount: number;
      resultHashes: string[];
      proofFields: Array<string | number | boolean | null>;
      atMs: number;
      authorization: TenantPurgeExecutionAuthorization;
      final: boolean;
      resolvesBlocker?: boolean;
      outbox?: TenantPurgeExecutionOutboxReference;
      scheduledAckSha256?: string;
    },
  ): Extract<TenantPurgeExecutionJobRecord, { phase: "queued" }> {
    const key = this.tenantPurgeExecutionDomainKey(
      current.requestId,
      current.executionGeneration,
      domainName,
    );
    const domain = this.tenantPurgeExecutionDomains.get(key);
    if (!domain || domain.phase === "acked") throw new TenantErasureIntegrityError();
    const globalAckSeq = current.domainAckCount + 1;
    const domainAckSeq = domain.ackCount + 1;
    if (!Number.isSafeInteger(globalAckSeq) || !Number.isSafeInteger(domainAckSeq)) {
      throw new TenantErasureIntegrityError();
    }
    const identity = this.tenantPurgeExecutionIdentity(current);
    const resultRootSha256 = tenantPurgeExecutionResultRootSha256(
      domainName,
      input.action,
      input.resultHashes,
    );
    const body = {
      ...identity,
      scope: TENANT_PURGE_EXECUTION_DOMAIN_ACK_SCOPE,
      domain: domainName,
      globalAckSeq,
      domainAckSeq,
      previousDomainAckSha256: domain.ackRootSha256,
      previousGlobalAckSha256: current.domainAckRootSha256,
      ackKind: input.ackKind,
      planEntryReceiptSha256: domain.planEntryReceiptSha256,
      affectedCount: input.affectedCount,
      resultCount: input.resultHashes.length,
      resultRootSha256,
      adapterProtocol: "local-store-v1",
      operationSha256: tenantPurgeExecutionOperationSha256({
        identity,
        domain: domainName,
        action: input.action,
        affectedCount: input.affectedCount,
        resultCount: input.resultHashes.length,
        resultRootSha256,
      }),
      physicalProofSha256: tenantPurgeExecutionPhysicalProofSha256({
        identity,
        domain: domainName,
        action: input.action,
        proofFields: input.proofFields,
      }),
      completedClaimAttempt: input.authorization.claimAttempt,
      completedClaimTokenSha256: tenantPurgeExecutionClaimTokenSha256(
        input.authorization.claimToken,
      ),
      storeDbTimestampMs: input.atMs,
      final: input.final,
      ...(input.outbox === undefined ? {} : input.outbox),
      ...(input.scheduledAckSha256 === undefined
        ? {} : { scheduledAckSha256: input.scheduledAckSha256 }),
    };
    const ack = clone<TenantPurgeExecutionDomainAck>({
      ...body,
      receiptSha256: tenantPurgeExecutionDomainAckSha256(body),
    });
    validateTenantPurgeExecutionDomainAck(ack);
    const ackKey = this.tenantPurgeExecutionAckKey(
      ack.requestId,
      ack.executionGeneration,
      ack.globalAckSeq,
    );
    if (this.tenantPurgeExecutionDomainAcks.has(ackKey)) {
      throw new TenantErasureIntegrityError();
    }
    if (input.resolvesBlocker && domain.phase !== "awaiting_blocker_resolution") {
      throw new TenantErasureIntegrityError();
    }
    const nextDomain = clone<TenantPurgeExecutionDomainRecord>({
      ...domain,
      phase: input.final ? "acked" : (
        input.resolvesBlocker || input.ackKind === "outbox_scheduled"
          ? "awaiting_physical_ack"
          : domain.phase
      ),
      ackCount: domainAckSeq,
      ackRootSha256: tenantPurgeExecutionNextDomainAckRootSha256(
        domain.ackRootSha256,
        domainName,
        ack.receiptSha256,
      ),
      ...(input.final ? { finalAckSha256: ack.receiptSha256 } : {}),
      updatedAtMs: Math.max(domain.updatedAtMs, input.atMs),
    });
    validateTenantPurgeExecutionDomainRecord(nextDomain);
    const unresolvedBlockerCount = input.resolvesBlocker
      ? current.unresolvedBlockerCount - 1
      : current.unresolvedBlockerCount;
    if (unresolvedBlockerCount < 0) throw new TenantErasureIntegrityError();
    const next = clone<Extract<TenantPurgeExecutionJobRecord, { phase: "queued" }>>({
      ...current,
      domainAckCount: globalAckSeq,
      domainAckRootSha256: tenantPurgeExecutionNextGlobalAckRootSha256(
        current.domainAckRootSha256,
        globalAckSeq,
        ack.receiptSha256,
      ),
      unresolvedBlockerCount,
      updatedAtMs: Math.max(current.updatedAtMs, input.atMs),
    });
    validateTenantPurgeExecutionJobRecord(next);
    this.tenantPurgeExecutionDomainAcks.set(ackKey, ack);
    this.tenantPurgeExecutionDomains.set(key, nextDomain);
    this.tenantPurgeExecutionJobs.set(next.requestId, next);
    return next;
  }

  private tenantPurgeExecutionAppliedResultHashes(
    job: TenantPurgeExecutionJobRecord,
    domain: TenantPurgePlanDomain,
    action: string,
    targetCount: number,
    targetRootSha256: string,
  ): string[] {
    const identity = this.tenantPurgeExecutionIdentity(job);
    return Array.from({ length: targetCount }, (_, ordinal) => (
      tenantPurgeExecutionPhysicalProofSha256({
        identity,
        domain,
        action,
        proofFields: [targetRootSha256, ordinal],
      })
    ));
  }

  private captureTenantPurgeExecutionAtomicState() {
    const copy = <K, V>(map: Map<K, V>) => new Map(
      [...map].map(([key, value]) => [key, clone(value)] as const),
    );
    return {
      jobs: copy(this.tenantPurgeExecutionJobs),
      domains: copy(this.tenantPurgeExecutionDomains),
      acks: copy(this.tenantPurgeExecutionDomainAcks),
      cutoverReceipts: copy(this.tenantPurgeLocalCutoverReceipts),
      physicalReceipts: copy(this.tenantPurgeLocalPhysicalAckReceipts),
      cutovers: copy(this.tenantPurgeExecutionCutovers),
      usageLedger: this.usageLedger.map(clone),
      billingFacts: copy(this.billingUsageFacts),
      blobManifests: copy(this.blobManifests),
      blobDeleteOutbox: copy(this.blobDeleteOutbox),
      nextBlobDeleteOutboxId: this.nextBlobDeleteOutboxId,
      exports: this.captureUserDataExportState(),
    };
  }

  private restoreTenantPurgeExecutionAtomicState(
    state: ReturnType<MemorySessionStore["captureTenantPurgeExecutionAtomicState"]>,
  ): void {
    restoreMapSnapshot(this.tenantPurgeExecutionJobs, state.jobs);
    restoreMapSnapshot(this.tenantPurgeExecutionDomains, state.domains);
    restoreMapSnapshot(this.tenantPurgeExecutionDomainAcks, state.acks);
    restoreMapSnapshot(this.tenantPurgeLocalCutoverReceipts, state.cutoverReceipts);
    restoreMapSnapshot(this.tenantPurgeLocalPhysicalAckReceipts, state.physicalReceipts);
    restoreMapSnapshot(this.tenantPurgeExecutionCutovers, state.cutovers);
    this.usageLedger = state.usageLedger.map(clone);
    restoreMapSnapshot(this.billingUsageFacts, state.billingFacts);
    restoreMapSnapshot(this.blobManifests, state.blobManifests);
    restoreMapSnapshot(this.blobDeleteOutbox, state.blobDeleteOutbox);
    this.nextBlobDeleteOutboxId = state.nextBlobDeleteOutboxId;
    this.restoreUserDataExportState(state.exports);
  }

  async executeTenantPurgeLocalCutover(
    authorization: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalCutoverReceipt | null> {
    const stagedAuthorization = clone(authorization);
    validateTenantPurgeExecutionAuthorization(stagedAuthorization);
    const initialNowMs = this.storeNowMs();
    const current = this.tenantPurgeExecutionJobs.get(stagedAuthorization.requestId);
    if (!current || current.phase !== "queued" || !tenantPurgeExecutionAuthorizationMatches(
      current,
      stagedAuthorization,
      initialNowMs,
    )) return null;
    const existing = this.tenantPurgeLocalCutoverReceipts.get(current.requestId);
    if (existing) {
      this.assertTenantPurgeExecutionState(current, false);
      return clone(existing);
    }
    if (initialNowMs < current.purgeNotBeforeDbMs || initialNowMs < current.sourceEvidenceDbMs) {
      throw new TenantPurgeExecutionEvidenceChangedError();
    }
    const state = this.assertTenantPurgeExecutionState(current, true);
    const entryByDomain = new Map(state.planEntries.map((entry) => [entry.domain, entry] as const));
    const operationalEntry = entryByDomain.get("operational_usage")!;
    const blobEntry = entryByDomain.get("blob_bytes")!;
    const exportControlEntry = entryByDomain.get("user_export_control")!;
    const exportSnapshotEntry = entryByDomain.get("user_export_snapshots")!;
    const exportBytesEntry = entryByDomain.get("user_export_bytes")!;
    const atomicState = this.captureTenantPurgeExecutionAtomicState();
    try {
      const cutoverAtMs = this.storeNowMs();
      if (!tenantPurgeExecutionAuthorizationMatches(current, stagedAuthorization, cutoverAtMs)) {
        return null;
      }
      if (cutoverAtMs < current.sourceEvidenceDbMs) {
        throw new TenantPurgeExecutionEvidenceChangedError();
      }
      this.tenantPurgePlanHoldProof(current.tenantId);

      // Verify every tenant usage row against its owner, assign legacy ids only in the staged
      // ledger, materialize/verify durable billing facts, and then remove operational rows.
      const stagedLedger = this.usageLedger.map(clone);
      const tenantUsageRows = stagedLedger
        .filter((row) => row.tenantId === current.tenantId)
        .sort((left, right) => (
          left.sessionId.localeCompare(right.sessionId)
          || left.turnId.localeCompare(right.turnId)
          || left.step - right.step
        ));
      const usageTargetHashes = tenantUsageRows.map((row) => tenantPurgePlanTargetSha256(
        "operational_usage",
        [row.usageId ?? null, row.sessionId, row.turnId, row.step],
      ));
      if (
        tenantUsageRows.length !== operationalEntry.targetCount
        || tenantPurgePlanTargetRootSha256("operational_usage", usageTargetHashes)
          !== operationalEntry.targetRootSha256
      ) throw new TenantPurgeExecutionEvidenceChangedError();
      const reservedUsageIds = new Set<string>();
      for (const row of stagedLedger) {
        const session = this.sessions.get(row.sessionId);
        if (!session || session.tenantId !== row.tenantId || session.userId !== row.userId) {
          throw new TenantErasureIntegrityError();
        }
        if (row.usageId === undefined) continue;
        if (!isUsageId(row.usageId) || reservedUsageIds.has(row.usageId)) {
          throw new UsageIdentityConflictError(row.usageId);
        }
        reservedUsageIds.add(row.usageId);
      }
      for (const usageId of this.billingUsageFacts.keys()) reservedUsageIds.add(usageId);
      for (const row of tenantUsageRows) {
        if (row.usageId !== undefined) continue;
        row.usage = normalizeOperationalUsageCost(row.usage, undefined);
        let allocated: string | undefined;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = newUsageId();
          if (!reservedUsageIds.has(candidate)) {
            allocated = candidate;
            break;
          }
        }
        if (!allocated) throw new UsageReconciliationError("could not allocate a unique usage id");
        row.usageId = allocated;
        reservedUsageIds.add(allocated);
      }
      const usageFactHashes: string[] = [];
      for (const row of tenantUsageRows) {
        if (!row.usageId) throw new UsageIdentityConflictError("missing");
        const fact = billingUsageFactFromLedger({
          ...row,
          usage: normalizeOperationalUsageCost(row.usage, row.usageId),
        } as UsageLedgerEntry & { usageId: string });
        const prior = this.billingUsageFacts.get(row.usageId);
        if (prior && !billingUsageFactContentEquals(prior, fact)) {
          throw new UsageIdentityConflictError(row.usageId);
        }
        if (!prior) this.billingUsageFacts.set(row.usageId, clone(fact));
        usageFactHashes.push((prior ?? fact).factSha256);
      }
      this.usageLedger = stagedLedger.filter((row) => row.tenantId !== current.tenantId);

      // Freeze each pre-cutover Blob target hash, then bind it to exactly one existing or newly
      // created delete outbox row. No locator enters the execution ACK ledger.
      const blobTargets = [...this.blobManifests.values()]
        .filter((manifest) => manifest.tenantId === current.tenantId && manifest.state !== "deleted")
        .sort((left, right) => left.blobId.localeCompare(right.blobId));
      const blobTargetHashes = blobTargets.map((manifest) => tenantPurgePlanTargetSha256(
        "blob_bytes",
        [manifest.blobId, manifest.deletionGeneration, manifest.state],
      ));
      if (
        blobTargets.length !== blobEntry.targetCount
        || tenantPurgePlanTargetRootSha256("blob_bytes", blobTargetHashes)
          !== blobEntry.targetRootSha256
      ) throw new TenantPurgeExecutionEvidenceChangedError();
      const blobReferences: TenantPurgeExecutionOutboxReference[] = [];
      for (const [index, manifest] of blobTargets.entries()) {
        let generation = manifest.deletionGeneration;
        let outbox: BlobDeleteOutboxRecord | undefined;
        if (manifest.state === "delete_pending") {
          outbox = this.blobDeleteOutbox.get(this.blobDeleteOutboxMapKey(manifest.blobId, generation));
          if (!outbox) throw new TenantErasureIntegrityError();
          this.hydrateBlobDeleteOutbox(outbox, false);
        } else {
          generation += 1;
          if (!Number.isSafeInteger(generation) || generation < 1) {
            throw new TenantErasureIntegrityError();
          }
          const outboxKey = this.blobDeleteOutboxMapKey(manifest.blobId, generation);
          if (this.blobDeleteOutbox.has(outboxKey)) throw new TenantErasureIntegrityError();
          const outboxId = this.nextBlobDeleteOutboxId++;
          if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
            throw new TenantErasureIntegrityError();
          }
          const pending = clone({
            ...manifest,
            state: "delete_pending" as const,
            deletionGeneration: generation,
            deleteAfterMs: cutoverAtMs,
          });
          delete pending.stagingExpiresAtMs;
          outbox = clone<BlobDeleteOutboxRecord>({
            outboxId,
            blobId: manifest.blobId,
            generation,
            storageBackend: manifest.storageBackend,
            storageFormat: manifest.storageFormat,
            storageKey: manifest.storageKey,
            uploadToken: manifest.uploadToken,
            availableAtMs: cutoverAtMs,
            attempts: 0,
            createdAtMs: cutoverAtMs,
          });
          this.blobManifests.set(manifest.blobId, pending);
          this.blobDeleteOutbox.set(outboxKey, outbox);
        }
        blobReferences.push({
          outboxKind: "blob_delete",
          outboxId: outbox.outboxId,
          deletionGeneration: generation,
          targetSha256: blobTargetHashes[index]!,
        });
      }
      blobReferences.sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));

      // Revoke every export control row, remove download/idempotency capability, release every
      // snapshot pin, and bind each non-deleted artifact part to its exact delete outbox row.
      const controlTargetHashes = this.tenantPurgePlanTargetEvidence(
        state.planJob,
        "user_export_control",
        this.tenantContentInventoryReceipts.get(current.requestId)!,
        this.tenantCredentialRevocationReceipts.get(current.requestId)!,
        this.tenantPurgePlanHoldProof(current.tenantId),
      );
      const snapshotTargetHashes = this.tenantPurgePlanTargetEvidence(
        state.planJob,
        "user_export_snapshots",
        this.tenantContentInventoryReceipts.get(current.requestId)!,
        this.tenantCredentialRevocationReceipts.get(current.requestId)!,
        this.tenantPurgePlanHoldProof(current.tenantId),
      );
      if (
        controlTargetHashes.targetCount !== exportControlEntry.targetCount
        || controlTargetHashes.targetRootSha256 !== exportControlEntry.targetRootSha256
        || snapshotTargetHashes.targetCount !== exportSnapshotEntry.targetCount
        || snapshotTargetHashes.targetRootSha256 !== exportSnapshotEntry.targetRootSha256
      ) throw new TenantPurgeExecutionEvidenceChangedError();
      const exportParts = [...this.userDataExportParts.values()]
        .filter((part) => {
          const artifact = this.userDataExportArtifacts.get(part.artifactId);
          if (!artifact) throw new TenantErasureIntegrityError();
          return artifact.tenantId === current.tenantId && part.state !== "deleted";
        })
        .sort((left, right) => (
          left.artifactId.localeCompare(right.artifactId) || left.partNumber - right.partNumber
        ));
      const exportTargetHashes = exportParts.map((part) => tenantPurgePlanTargetSha256(
        "user_export_bytes",
        [part.artifactId, part.partNumber, part.deletionGeneration, part.state],
      ));
      if (
        exportParts.length !== exportBytesEntry.targetCount
        || tenantPurgePlanTargetRootSha256("user_export_bytes", exportTargetHashes)
          !== exportBytesEntry.targetRootSha256
      ) throw new TenantPurgeExecutionEvidenceChangedError();
      const tenantExportRequestIds = new Set<string>();
      for (const request of [...this.userDataExportRequests.values()]) {
        if (request.tenantId !== current.tenantId) continue;
        tenantExportRequestIds.add(request.requestId);
        const revoked = clone({ ...request, status: "revoked" as const, updatedAtMs: cutoverAtMs });
        delete revoked.lastErrorCode;
        this.userDataExportRequests.set(request.requestId, revoked);
        const exportJob = this.userDataExportJobs.get(request.requestId);
        if (exportJob) {
          const revokedJob = clone({ ...exportJob, status: "revoked" as const, updatedAtMs: cutoverAtMs });
          delete revokedJob.availableAtMs;
          delete revokedJob.claimToken;
          delete revokedJob.leaseUntilMs;
          delete revokedJob.lastErrorCode;
          this.userDataExportJobs.set(request.requestId, revokedJob);
        }
        this.userDataExportSnapshotRecords.delete(request.requestId);
        const snapshotBlobs = this.userDataExportSnapshotBlobs.get(request.requestId);
        if (snapshotBlobs) {
          this.userDataExportSnapshotBlobs.set(request.requestId, snapshotBlobs.map((blob) => (
            blob.releasedAtMs === undefined ? { ...blob, releasedAtMs: cutoverAtMs } : blob
          )));
        }
      }
      for (const [key, lease] of this.userDataExportDownloadLeases) {
        if (lease.tenantId === current.tenantId) this.userDataExportDownloadLeases.delete(key);
      }
      for (const [key, requestId] of this.userDataExportIdempotency) {
        if (tenantExportRequestIds.has(requestId)) this.userDataExportIdempotency.delete(key);
      }
      for (const artifact of [...this.userDataExportArtifacts.values()]) {
        if (artifact.tenantId === current.tenantId && artifact.state !== "deleted") {
          this.transitionUserDataExportArtifactToDeletePending(artifact.artifactId, cutoverAtMs);
        }
      }
      const exportReferences: TenantPurgeExecutionOutboxReference[] = [];
      for (const [index, originalPart] of exportParts.entries()) {
        const part = this.userDataExportParts.get(this.userDataExportPartKey(
          originalPart.artifactId,
          originalPart.partNumber,
        ));
        if (!part || part.state !== "delete_pending") throw new TenantErasureIntegrityError();
        const outbox = this.userDataExportDeleteOutbox.get(this.userDataExportDeleteKey(
          part.artifactId,
          part.partNumber,
          part.deletionGeneration,
        ));
        if (!outbox) throw new TenantErasureIntegrityError();
        this.hydrateUserDataExportDeleteOutbox(outbox);
        exportReferences.push({
          outboxKind: "user_export_delete",
          outboxId: outbox.outboxId,
          deletionGeneration: outbox.deletionGeneration,
          targetSha256: exportTargetHashes[index]!,
        });
      }
      exportReferences.sort((left, right) => left.targetSha256.localeCompare(right.targetSha256));

      let working = current;
      working = this.appendTenantPurgeExecutionAck(working, "operational_usage", {
        ackKind: "anonymized",
        action: "anonymize",
        affectedCount: tenantUsageRows.length,
        resultHashes: usageFactHashes,
        proofFields: [operationalEntry.targetRootSha256, usageFactHashes.length, cutoverAtMs],
        atMs: cutoverAtMs,
        authorization: stagedAuthorization,
        final: true,
      });
      const blobReferenceHashes = blobReferences.map(tenantPurgeExecutionOutboxTargetSha256);
      working = this.appendTenantPurgeExecutionAck(working, "blob_bytes", {
        ackKind: "blocker_resolution",
        action: "schedule-delete",
        affectedCount: blobTargets.length,
        resultHashes: blobReferenceHashes,
        proofFields: [blobEntry.targetRootSha256, tenantPurgeExecutionOutboxRootSha256(blobReferences)],
        atMs: cutoverAtMs,
        authorization: stagedAuthorization,
        final: blobReferences.length === 0,
        resolvesBlocker: true,
      });
      for (const reference of blobReferences) {
        working = this.appendTenantPurgeExecutionAck(working, "blob_bytes", {
          ackKind: "outbox_scheduled",
          action: "outbox-scheduled",
          affectedCount: 1,
          resultHashes: [tenantPurgeExecutionOutboxTargetSha256(reference)],
          proofFields: [reference.outboxKind, reference.outboxId, reference.deletionGeneration, reference.targetSha256],
          atMs: cutoverAtMs,
          authorization: stagedAuthorization,
          final: false,
          outbox: reference,
        });
      }
      working = this.appendTenantPurgeExecutionAck(working, "user_export_control", {
        ackKind: "applied",
        action: "revoke",
        affectedCount: exportControlEntry.targetCount,
        resultHashes: this.tenantPurgeExecutionAppliedResultHashes(
          working,
          "user_export_control",
          "revoke-result",
          exportControlEntry.targetCount,
          exportControlEntry.targetRootSha256,
        ),
        proofFields: [exportControlEntry.targetRootSha256, exportControlEntry.targetCount, cutoverAtMs],
        atMs: cutoverAtMs,
        authorization: stagedAuthorization,
        final: true,
      });
      working = this.appendTenantPurgeExecutionAck(working, "user_export_snapshots", {
        ackKind: "applied",
        action: "release-pins",
        affectedCount: exportSnapshotEntry.targetCount,
        resultHashes: this.tenantPurgeExecutionAppliedResultHashes(
          working,
          "user_export_snapshots",
          "release-pin-result",
          exportSnapshotEntry.targetCount,
          exportSnapshotEntry.targetRootSha256,
        ),
        proofFields: [exportSnapshotEntry.targetRootSha256, exportSnapshotEntry.targetCount, cutoverAtMs],
        atMs: cutoverAtMs,
        authorization: stagedAuthorization,
        final: true,
      });
      const exportReferenceHashes = exportReferences.map(tenantPurgeExecutionOutboxTargetSha256);
      working = this.appendTenantPurgeExecutionAck(working, "user_export_bytes", {
        ackKind: "blocker_resolution",
        action: "schedule-delete",
        affectedCount: exportParts.length,
        resultHashes: exportReferenceHashes,
        proofFields: [exportBytesEntry.targetRootSha256, tenantPurgeExecutionOutboxRootSha256(exportReferences)],
        atMs: cutoverAtMs,
        authorization: stagedAuthorization,
        final: exportReferences.length === 0,
        resolvesBlocker: true,
      });
      for (const reference of exportReferences) {
        working = this.appendTenantPurgeExecutionAck(working, "user_export_bytes", {
          ackKind: "outbox_scheduled",
          action: "outbox-scheduled",
          affectedCount: 1,
          resultHashes: [tenantPurgeExecutionOutboxTargetSha256(reference)],
          proofFields: [reference.outboxKind, reference.outboxId, reference.deletionGeneration, reference.targetSha256],
          atMs: cutoverAtMs,
          authorization: stagedAuthorization,
          final: false,
          outbox: reference,
        });
      }

      const receiptBody = {
        ...this.tenantPurgeExecutionSource(working),
        scope: TENANT_PURGE_LOCAL_CUTOVER_SCOPE,
        operationalUsageTargetCount: operationalEntry.targetCount,
        operationalUsageTargetRootSha256: operationalEntry.targetRootSha256,
        blobBytesTargetCount: blobEntry.targetCount,
        blobBytesTargetRootSha256: blobEntry.targetRootSha256,
        blobDeleteOutboxCount: blobReferences.length,
        blobDeleteOutboxRootSha256: tenantPurgeExecutionOutboxRootSha256(blobReferences),
        exportBytesTargetCount: exportBytesEntry.targetCount,
        exportBytesTargetRootSha256: exportBytesEntry.targetRootSha256,
        exportDeleteOutboxCount: exportReferences.length,
        exportDeleteOutboxRootSha256: tenantPurgeExecutionOutboxRootSha256(exportReferences),
        domainAckCount: working.domainAckCount,
        domainAckRootSha256: working.domainAckRootSha256,
        storeDbTimestampMs: cutoverAtMs,
        completedClaimAttempt: stagedAuthorization.claimAttempt,
        completedClaimTokenSha256: tenantPurgeExecutionClaimTokenSha256(stagedAuthorization.claimToken),
        localDestructiveProgress: true as const,
        physicalAcksComplete: false as const,
        allDomainsComplete: false as const,
        contentPurgeExecuted: false as const,
      };
      const receipt = clone<TenantPurgeLocalCutoverReceipt>({
        ...receiptBody,
        receiptSha256: tenantPurgeLocalCutoverReceiptSha256(receiptBody),
      });
      validateTenantPurgeLocalCutoverReceipt(receipt);
      const next = clone<Extract<TenantPurgeExecutionJobRecord, { phase: "queued" }>>({
        ...working,
        localCutoverReceiptSha256: receipt.receiptSha256,
      });
      validateTenantPurgeExecutionJobRecord(next);
      if (this.tenantPurgeLocalCutoverReceipts.has(next.requestId)) {
        throw new TenantErasureIntegrityError();
      }
      const cutover = this.assertTenantPurgeExecutionCutoverState();
      this.tenantPurgeLocalCutoverReceipts.set(next.requestId, receipt);
      this.tenantPurgeExecutionJobs.set(next.requestId, next);
      if (cutover.controlGeneration === 0) {
        const activatedBody = {
          singletonId: TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID,
          controlGeneration: 1 as const,
          activatedAtDbMs: cutoverAtMs,
          firstRequestId: next.requestId,
          firstReceiptSha256: receipt.receiptSha256,
        };
        const activated = clone<TenantPurgeExecutionCutoverRecord>({
          ...activatedBody,
          evidenceSha256: tenantPurgeExecutionCutoverEvidenceSha256(activatedBody),
        });
        validateTenantPurgeExecutionCutoverRecord(activated);
        this.tenantPurgeExecutionCutovers.set(TENANT_PURGE_EXECUTION_CUTOVER_SINGLETON_ID, activated);
      }
      const publishNowMs = this.storeNowMs();
      if (!tenantPurgeExecutionAuthorizationMatches(next, stagedAuthorization, publishNowMs)) {
        this.restoreTenantPurgeExecutionAtomicState(atomicState);
        return null;
      }
      this.tenantPurgePlanHoldProof(next.tenantId);
      return clone(receipt);
    } catch (error) {
      this.restoreTenantPurgeExecutionAtomicState(atomicState);
      if (
        error instanceof TenantPurgeExecutionEvidenceChangedError
        || error instanceof TenantPurgeExecutionNotReadyError
      ) throw error;
      if (error instanceof TenantPurgePlanNotReadyError && error.reason === "active_legal_hold") {
        throw new TenantPurgeExecutionNotReadyError("active_legal_hold");
      }
      throw error;
    }
  }

  async sealTenantPurgeLocalPhysicalAcks(
    authorization: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalPhysicalAckReceipt | null> {
    const stagedAuthorization = clone(authorization);
    validateTenantPurgeExecutionAuthorization(stagedAuthorization);
    const initialNowMs = this.storeNowMs();
    const current = this.tenantPurgeExecutionJobs.get(stagedAuthorization.requestId);
    if (!current || current.tenantId !== stagedAuthorization.tenantId) return null;
    if (current.phase === "local_physical_acks_sealed") {
      this.assertTenantPurgeExecutionState(current, false);
      if (
        current.subjectGeneration !== stagedAuthorization.subjectGeneration
        || current.planBuildGeneration !== stagedAuthorization.planBuildGeneration
        || current.executionGeneration !== stagedAuthorization.executionGeneration
        || current.completedClaimAttempt !== stagedAuthorization.claimAttempt
        || current.completedClaimTokenSha256
          !== tenantPurgeExecutionClaimTokenSha256(stagedAuthorization.claimToken)
      ) return null;
      return clone(this.tenantPurgeLocalPhysicalAckReceipts.get(current.requestId)!);
    }
    if (current.phase !== "queued" || !tenantPurgeExecutionAuthorizationMatches(
      current,
      stagedAuthorization,
      initialNowMs,
    )) return null;
    const state = this.assertTenantPurgeExecutionState(current, false);
    const cutoverReceipt = this.tenantPurgeLocalCutoverReceipts.get(current.requestId);
    if (!cutoverReceipt || current.localCutoverReceiptSha256 !== cutoverReceipt.receiptSha256) {
      throw new TenantErasureIntegrityError();
    }
    const scheduled = state.acks.filter((ack) => ack.ackKind === "outbox_scheduled");
    const blobScheduled = scheduled
      .filter((ack) => ack.outboxKind === "blob_delete")
      .sort((left, right) => left.targetSha256!.localeCompare(right.targetSha256!));
    const exportScheduled = scheduled
      .filter((ack) => ack.outboxKind === "user_export_delete")
      .sort((left, right) => left.targetSha256!.localeCompare(right.targetSha256!));
    const references = (acks: TenantPurgeExecutionDomainAck[]): TenantPurgeExecutionOutboxReference[] => (
      acks.map((ack) => ({
        outboxKind: ack.outboxKind!,
        outboxId: ack.outboxId!,
        deletionGeneration: ack.deletionGeneration!,
        targetSha256: ack.targetSha256!,
      }))
    );
    if (
      blobScheduled.length !== cutoverReceipt.blobDeleteOutboxCount
      || exportScheduled.length !== cutoverReceipt.exportDeleteOutboxCount
      || tenantPurgeExecutionOutboxRootSha256(references(blobScheduled))
        !== cutoverReceipt.blobDeleteOutboxRootSha256
      || tenantPurgeExecutionOutboxRootSha256(references(exportScheduled))
        !== cutoverReceipt.exportDeleteOutboxRootSha256
    ) throw new TenantErasureIntegrityError();

    const completed: Array<{
      scheduled: TenantPurgeExecutionDomainAck;
      reference: TenantPurgeExecutionOutboxReference;
      completedAtMs: number;
    }> = [];
    let pending = false;
    let deadLettered = false;
    for (const scheduledAck of [...blobScheduled, ...exportScheduled]) {
      const reference = references([scheduledAck])[0]!;
      if (reference.outboxKind === "blob_delete") {
        const entry = this.findBlobDeleteOutboxById(reference.outboxId);
        if (!entry || entry[1].generation !== reference.deletionGeneration) {
          throw new TenantErasureIntegrityError();
        }
        const row = this.hydrateBlobDeleteOutbox(entry[1], false);
        const manifest = this.blobManifests.get(row.blobId);
        if (!manifest || manifest.tenantId !== current.tenantId) {
          throw new TenantErasureIntegrityError();
        }
        if (row.deadLetteredAtMs !== undefined) {
          deadLettered = true;
        } else if (row.completedAtMs === undefined) {
          pending = true;
        } else {
          if (manifest.state !== "deleted" || manifest.deletionGeneration !== row.generation) {
            throw new TenantErasureIntegrityError();
          }
          completed.push({ scheduled: scheduledAck, reference, completedAtMs: row.completedAtMs });
        }
      } else {
        const entry = this.findUserDataExportDeleteOutboxById(reference.outboxId);
        if (!entry || entry[1].deletionGeneration !== reference.deletionGeneration) {
          throw new TenantErasureIntegrityError();
        }
        const row = this.hydrateUserDataExportDeleteOutbox(entry[1]);
        const artifact = this.userDataExportArtifacts.get(row.artifactId);
        const part = this.userDataExportParts.get(this.userDataExportPartKey(
          row.artifactId,
          row.partNumber,
        ));
        if (!artifact || artifact.tenantId !== current.tenantId || !part) {
          throw new TenantErasureIntegrityError();
        }
        if (row.deadLetteredAtMs !== undefined) {
          deadLettered = true;
        } else if (row.completedAtMs === undefined) {
          pending = true;
        } else {
          if (part.state !== "deleted" || part.deletionGeneration !== row.deletionGeneration) {
            throw new TenantErasureIntegrityError();
          }
          completed.push({ scheduled: scheduledAck, reference, completedAtMs: row.completedAtMs });
        }
      }
    }
    if (deadLettered) {
      const before = new Map(this.tenantPurgeExecutionJobs);
      try {
        this.tenantPurgeExecutionJobs.set(current.requestId, this.blockedTenantPurgeExecutionJob(
          current,
          initialNowMs,
          "physical_ack_dead_lettered",
        ));
      } catch (error) {
        restoreMapSnapshot(this.tenantPurgeExecutionJobs, before);
        throw error;
      }
      throw new TenantPurgeExecutionPhysicalAckDeadLetterError();
    }
    if (pending || completed.length !== scheduled.length) {
      throw new TenantPurgeExecutionNotReadyError("physical_ack_pending");
    }

    const atomicState = this.captureTenantPurgeExecutionAtomicState();
    try {
      const sealAtMs = this.storeNowMs();
      if (!tenantPurgeExecutionAuthorizationMatches(current, stagedAuthorization, sealAtMs)) {
        return null;
      }
      let working = current;
      const physicalByDomain = new Map<TenantPurgePlanDomain, string[]>();
      for (const domainName of ["blob_bytes", "user_export_bytes"] as const) {
        const candidates = completed
          .filter((entry) => entry.scheduled.domain === domainName)
          .sort((left, right) => left.reference.targetSha256.localeCompare(right.reference.targetSha256));
        for (const [index, entry] of candidates.entries()) {
          if (entry.completedAtMs > sealAtMs) throw new TenantErasureIntegrityError();
          const resultHash = tenantPurgeExecutionOutboxTargetSha256(entry.reference);
          working = this.appendTenantPurgeExecutionAck(working, domainName, {
            ackKind: "physical_delete",
            action: "physical-delete",
            affectedCount: 1,
            resultHashes: [resultHash],
            proofFields: [
              entry.reference.outboxKind,
              entry.reference.outboxId,
              entry.reference.deletionGeneration,
              entry.reference.targetSha256,
              entry.completedAtMs,
            ],
            atMs: sealAtMs,
            authorization: stagedAuthorization,
            final: index === candidates.length - 1,
            outbox: entry.reference,
            scheduledAckSha256: entry.scheduled.receiptSha256,
          });
          const hashes = physicalByDomain.get(domainName) ?? [];
          hashes.push(this.tenantPurgeExecutionAcksFor(working).at(-1)!.receiptSha256);
          physicalByDomain.set(domainName, hashes);
        }
      }
      const blobPhysicalHashes = physicalByDomain.get("blob_bytes") ?? [];
      const exportPhysicalHashes = physicalByDomain.get("user_export_bytes") ?? [];
      const receiptBody = {
        ...this.tenantPurgeExecutionSource(working),
        scope: TENANT_PURGE_LOCAL_PHYSICAL_ACK_SCOPE,
        localCutoverReceiptSha256: cutoverReceipt.receiptSha256,
        blobPhysicalAckCount: blobPhysicalHashes.length,
        blobPhysicalAckRootSha256: tenantPurgeExecutionResultRootSha256(
          "blob_bytes",
          "physical-ack-chain",
          blobPhysicalHashes,
        ),
        exportPhysicalAckCount: exportPhysicalHashes.length,
        exportPhysicalAckRootSha256: tenantPurgeExecutionResultRootSha256(
          "user_export_bytes",
          "physical-ack-chain",
          exportPhysicalHashes,
        ),
        domainAckCount: working.domainAckCount,
        domainAckRootSha256: working.domainAckRootSha256,
        unresolvedBlockerCount: working.unresolvedBlockerCount,
        storeDbTimestampMs: sealAtMs,
        completedClaimAttempt: stagedAuthorization.claimAttempt,
        completedClaimTokenSha256: tenantPurgeExecutionClaimTokenSha256(stagedAuthorization.claimToken),
        localPhysicalAcksComplete: true as const,
        allDomainsComplete: false as const,
        contentPurgeExecuted: false as const,
      };
      const receipt = clone<TenantPurgeLocalPhysicalAckReceipt>({
        ...receiptBody,
        receiptSha256: tenantPurgeLocalPhysicalAckReceiptSha256(receiptBody),
      });
      validateTenantPurgeLocalPhysicalAckReceipt(receipt);
      const publishNowMs = this.storeNowMs();
      if (!tenantPurgeExecutionAuthorizationMatches(working, stagedAuthorization, publishNowMs)) {
        this.restoreTenantPurgeExecutionAtomicState(atomicState);
        return null;
      }
      if (this.tenantPurgeLocalPhysicalAckReceipts.has(working.requestId)) {
        throw new TenantErasureIntegrityError();
      }
      const terminal = clone<TenantPurgeExecutionJobRecord>({
        ...this.tenantPurgeExecutionSource(working),
        phase: "local_physical_acks_sealed",
        domainCount: working.domainCount,
        domainAckCount: working.domainAckCount,
        domainAckRootSha256: working.domainAckRootSha256,
        unresolvedBlockerCount: working.unresolvedBlockerCount,
        localCutoverReceiptSha256: cutoverReceipt.receiptSha256,
        attempts: working.attempts,
        createdAtMs: working.createdAtMs,
        updatedAtMs: Math.max(working.updatedAtMs, sealAtMs),
        localPhysicalAckReceiptSha256: receipt.receiptSha256,
        localPhysicalAcksSealedAtDbMs: sealAtMs,
        completedClaimAttempt: stagedAuthorization.claimAttempt,
        completedClaimTokenSha256: receipt.completedClaimTokenSha256,
      });
      validateTenantPurgeExecutionJobRecord(terminal);
      this.tenantPurgeLocalPhysicalAckReceipts.set(working.requestId, receipt);
      this.tenantPurgeExecutionJobs.set(working.requestId, terminal);
      return clone(receipt);
    } catch (error) {
      this.restoreTenantPurgeExecutionAtomicState(atomicState);
      throw error;
    }
  }

  async getTenantPurgeExecutionJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeExecutionJobRecord | null> {
    const job = this.tenantPurgeExecutionJobs.get(requestId);
    if (!job || job.tenantId !== tenantId) return null;
    this.assertTenantPurgeExecutionState(job, job.localCutoverReceiptSha256 === undefined);
    return clone(job);
  }

  async getTenantPurgeExecutionDomains(
    tenantId: string,
    requestId: string,
    executionGeneration: number,
  ): Promise<TenantPurgeExecutionDomainRecord[]> {
    const job = this.tenantPurgeExecutionJobs.get(requestId);
    if (
      !job
      || job.tenantId !== tenantId
      || job.executionGeneration !== executionGeneration
    ) return [];
    return this.assertTenantPurgeExecutionState(
      job,
      job.localCutoverReceiptSha256 === undefined,
    ).domains.map(clone);
  }

  async getTenantPurgeExecutionDomainAcks(
    tenantId: string,
    requestId: string,
    executionGeneration: number,
  ): Promise<TenantPurgeExecutionDomainAck[]> {
    const job = this.tenantPurgeExecutionJobs.get(requestId);
    if (
      !job
      || job.tenantId !== tenantId
      || job.executionGeneration !== executionGeneration
    ) return [];
    return this.assertTenantPurgeExecutionState(
      job,
      job.localCutoverReceiptSha256 === undefined,
    ).acks.map(clone);
  }

  async getTenantPurgeLocalCutoverReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeLocalCutoverReceipt | null> {
    const receipt = this.tenantPurgeLocalCutoverReceipts.get(requestId);
    if (!receipt || receipt.tenantId !== tenantId) return null;
    const job = this.tenantPurgeExecutionJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    this.assertTenantPurgeExecutionState(job, false);
    return clone(receipt);
  }

  async getTenantPurgeLocalPhysicalAckReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantPurgeLocalPhysicalAckReceipt | null> {
    const receipt = this.tenantPurgeLocalPhysicalAckReceipts.get(requestId);
    if (!receipt || receipt.tenantId !== tenantId) return null;
    const job = this.tenantPurgeExecutionJobs.get(requestId);
    if (!job) throw new TenantErasureIntegrityError();
    this.assertTenantPurgeExecutionState(job, false);
    return clone(receipt);
  }

  async getTenantPurgeExecutionCutover(): Promise<TenantPurgeExecutionCutoverRecord> {
    return clone(this.assertTenantPurgeExecutionCutoverState());
  }

  async getSubjectLifecycle(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<SubjectLifecycleRecord | null> {
    const record = this.subjectRecord(tenantId, subjectKind, subjectId);
    return record ? clone(record) : null;
  }

  async listErasureAuditEvents(requestId: string): Promise<ErasureAuditEvent[]> {
    return (this.erasureAuditEvents.get(requestId) ?? []).map(clone);
  }

  private assertErasureJobIntegrity(record: ErasureRequestRecord): SubjectLifecycleRecord {
    const rowFault = classifyErasureJobRecordFault(record);
    const audits = this.erasureAuditEvents.get(record.requestId);
    const quarantineMarkerCount = [
      record.quarantinedAtMs,
      record.quarantineReasonCode,
      record.quarantineEvidenceSha256,
    ].filter((value) => value !== undefined).length;
    const controlRecord = rowFault?.reasonCode === "queue_control_invalid"
      && quarantineMarkerCount > 0
      && quarantineMarkerCount < 3
      ? (() => {
          const normalized = clone(record);
          delete normalized.quarantinedAtMs;
          delete normalized.quarantineReasonCode;
          delete normalized.quarantineEvidenceSha256;
          return normalized;
        })()
      : record;
    try {
      validateErasureJobControlAudit(
        controlRecord,
        audits ?? [],
        this.erasureJobControlEvents.get(record.requestId) ?? [],
      );
    } catch {
      throw newErasureJobIntegrityFault(record, "control_audit_invalid");
    }
    if (rowFault) throw rowFault;
    const tenant = this.subjectRecord(record.tenantId, "tenant", record.tenantId);
    const subject = this.subjectRecord(record.tenantId, record.subjectKind, record.subjectId);
    if (
      !tenant
      || (record.subjectKind === "user" && tenant.state !== "active")
      || !subject
      || subject.state !== "deleting"
      || subject.generation !== record.generation
      || subject.activeRequestId !== record.requestId
    ) throw newErasureJobIntegrityFault(record, "subject_binding_invalid");
    if (!audits) throw newErasureJobIntegrityFault(record, "audit_chain_invalid");
    try {
      validateErasureAuditChain(record, audits);
    } catch {
      throw newErasureJobIntegrityFault(record, "audit_chain_invalid");
    }
    if (record.subjectKind === "user") {
      const key = JSON.stringify([record.tenantId, "user", record.subjectId, record.idempotencyKey]);
      if (this.erasureIdempotency.get(key) !== record.requestId) {
        throw newErasureJobIntegrityFault(record, "idempotency_binding_invalid");
      }
    }
    return subject;
  }

  private erasureJobParentAllowsAuthority(record: ErasureRequestRecord): boolean {
    if (record.subjectKind === "tenant") return true;
    return this.isTenantActive(record.tenantId);
  }

  private erasureJobNeedsImmediateQueueIsolation(record: ErasureRequestRecord): boolean {
    const quarantineMarkerCount = [
      record.quarantinedAtMs,
      record.quarantineReasonCode,
      record.quarantineEvidenceSha256,
    ].filter((value) => value !== undefined).length;
    if (quarantineMarkerCount > 0 && quarantineMarkerCount < 3) return true;
    if (record.controlGeneration === Number.MAX_SAFE_INTEGER) return true;
    if (
      record.availableAtMs === undefined
      || !Number.isSafeInteger(record.availableAtMs)
      || record.availableAtMs < 0
    ) return true;
    if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) return true;
    try {
      if (record.claimToken !== undefined) assertErasureClaimToken(record.claimToken);
    } catch {
      return true;
    }
    return record.leaseUntilMs !== undefined
      && (!Number.isSafeInteger(record.leaseUntilMs) || record.leaseUntilMs < 0);
  }

  private quarantineErasureJob(
    requestKey: string,
    current: ErasureRequestRecord,
    fault: ErasureJobIntegrityFault,
    atMs: number,
  ): void {
    if (!isClaimableErasureRequestStatus(current.status) || isErasureJobQuarantined(current)) {
      throw new Error("erasure job is not safely quarantineable");
    }
    if (
      requestKey !== current.requestId
      || !hasSafeErasureRequestQuarantineEnvelope(current)
    ) {
      this.terminallyIsolateUnsafeErasureJobEnvelope(requestKey, current, atMs);
      return;
    }
    const occupiedSafeGenerations = new Set(
      (this.erasureJobControlEvents.get(current.requestId) ?? [])
        .map((event) => event.controlGeneration)
        .filter((generation) => Number.isSafeInteger(generation) && generation > 0),
    );
    let controlGeneration = current.controlGeneration + 1;
    while (Number.isSafeInteger(controlGeneration) && occupiedSafeGenerations.has(controlGeneration)) {
      controlGeneration += 1;
    }
    if (!Number.isSafeInteger(controlGeneration) || controlGeneration <= 0) {
      this.terminallyQuarantineErasureJob(current, atMs);
      return;
    }
    const evidenceSha256 = erasureJobInterventionEvidenceSha256({
      requestId: current.requestId,
      controlGeneration,
      phase: current.status,
      kind: "quarantine",
      reasonCode: fault.reasonCode,
    });
    const effectiveAtMs = Math.max(current.updatedAtMs, atMs);
    const next = clone(current);
    next.controlGeneration = controlGeneration;
    next.quarantinedAtMs = effectiveAtMs;
    next.quarantineReasonCode = fault.reasonCode;
    next.quarantineEvidenceSha256 = evidenceSha256;
    next.updatedAtMs = effectiveAtMs;
    delete next.availableAtMs;
    delete next.claimToken;
    delete next.leaseUntilMs;

    const event = clone<ErasureJobControlEvent>({
      controlEventId: this.nextErasureJobControlEventId,
      requestId: current.requestId,
      controlGeneration,
      eventType: "erasure_job/quarantined",
      phase: current.status,
      reasonCode: fault.reasonCode,
      beforeSha256: evidenceSha256,
      emittedAtMs: effectiveAtMs,
    });
    validateErasureJobControlEvent(event);
    const stagedEvents = [...(this.erasureJobControlEvents.get(current.requestId) ?? []), event];
    this.publishErasureControlState(next, undefined, stagedEvents);
    this.nextErasureJobControlEventId += 1;
  }

  private terminallyIsolateUnsafeErasureJobEnvelope(
    requestKey: string,
    current: ErasureRequestRecord,
    atMs: number,
  ): void {
    if (!isClaimableErasureRequestStatus(current.status) || isErasureJobQuarantined(current)) {
      throw new Error("erasure job is not terminally isolatable");
    }
    if (this.erasureJobTerminalIncidents.has(requestKey)) {
      throw new Error("erasure terminal incident identity already exists");
    }
    if (
      !Number.isSafeInteger(this.nextErasureJobTerminalIncidentId)
      || this.nextErasureJobTerminalIncidentId <= 0
    ) throw new Error("erasure terminal incident sequence is exhausted");

    const rawEnvelope: ErasureJobUnsafeQuarantineEnvelope = {
      // The map key is Memory's durable primary key. A forged record.requestId must not cause the
      // poison row to be published under a second key while the original remains claimable.
      locatorRequestId: requestKey,
      requestId: String(current.requestId),
      tenantId: String(current.tenantId),
      subjectKind: String(current.subjectKind),
      subjectId: String(current.subjectId),
      rawGeneration: String(current.generation),
      status: String(current.status),
      rawCreatedAtMs: String(current.createdAtMs),
      rawGatedAtMs: String(current.gatedAtMs),
      rawUpdatedAtMs: String(current.updatedAtMs),
      rawControlGeneration: String(current.controlGeneration),
    };
    const evidenceSha256 = erasureJobUnsafeQuarantineEnvelopeEvidenceSha256(rawEnvelope);
    const next = clone(current);
    // The incident, not a fabricated control event/fence, is the terminal audit. Preserve the raw
    // fence exactly so isolation never hides or moves durable corruption in either direction.
    next.controlGeneration = current.controlGeneration;
    next.quarantinedAtMs = atMs;
    next.quarantineReasonCode = "control_audit_invalid";
    next.quarantineEvidenceSha256 = evidenceSha256;
    delete next.availableAtMs;
    delete next.claimToken;
    delete next.leaseUntilMs;

    const incident = clone<ErasureJobTerminalIncident>({
      terminalIncidentId: this.nextErasureJobTerminalIncidentId,
      requestId: requestKey,
      rawControlGeneration: rawEnvelope.rawControlGeneration,
      reasonCode: "unsafe_quarantine_envelope",
      evidenceSha256,
      emittedAtMs: atMs,
    });
    const requestExisted = this.erasureRequests.has(requestKey);
    const priorRequest = this.erasureRequests.get(requestKey);
    const incidentExisted = this.erasureJobTerminalIncidents.has(requestKey);
    const priorIncident = this.erasureJobTerminalIncidents.get(requestKey);
    try {
      this.erasureRequests.set(requestKey, next);
      this.erasureJobTerminalIncidents.set(requestKey, incident);
    } catch (error) {
      restoreMapEntry(this.erasureRequests, requestKey, requestExisted, priorRequest);
      restoreMapEntry(
        this.erasureJobTerminalIncidents,
        requestKey,
        incidentExisted,
        priorIncident,
      );
      throw error;
    }
    this.nextErasureJobTerminalIncidentId += 1;
  }

  /**
   * Exhausting the safe-integer fence is an unrecoverable control-plane fault. Preserve the
   * monotonic fence at MAX_SAFE, clear every worker credential, and deliberately emit no control
   * event because no distinct representable generation remains for one.
   */
  private terminallyQuarantineErasureJob(
    current: ErasureRequestRecord,
    atMs: number,
  ): void {
    const controlGeneration = Number.MAX_SAFE_INTEGER;
    if (current.controlGeneration > controlGeneration) {
      throw new Error("erasure request control generation cannot be represented safely");
    }
    const effectiveAtMs = Math.max(current.updatedAtMs, atMs);
    const next = clone(current);
    next.controlGeneration = controlGeneration;
    next.quarantinedAtMs = effectiveAtMs;
    next.quarantineReasonCode = "control_audit_invalid";
    next.quarantineEvidenceSha256 = erasureJobTerminalInterventionEvidenceSha256({
      requestId: current.requestId,
      rawControlGeneration: String(controlGeneration),
      phase: current.status,
      reasonCode: "control_audit_invalid",
    });
    next.updatedAtMs = effectiveAtMs;
    delete next.availableAtMs;
    delete next.claimToken;
    delete next.leaseUntilMs;
    this.publishErasureControlState(
      next,
      undefined,
      this.erasureJobControlEvents.get(current.requestId) ?? [],
    );
  }

  private publishErasureControlState(
    next: ErasureRequestRecord,
    audits: ErasureAuditEvent[] | undefined,
    controls: ErasureJobControlEvent[],
  ): void {
    const requestExisted = this.erasureRequests.has(next.requestId);
    const priorRequest = this.erasureRequests.get(next.requestId);
    const auditsExisted = this.erasureAuditEvents.has(next.requestId);
    const priorAudits = this.erasureAuditEvents.get(next.requestId);
    const controlsExisted = this.erasureJobControlEvents.has(next.requestId);
    const priorControls = this.erasureJobControlEvents.get(next.requestId);
    try {
      this.erasureRequests.set(next.requestId, next);
      if (audits !== undefined) this.erasureAuditEvents.set(next.requestId, audits);
      this.erasureJobControlEvents.set(next.requestId, controls);
    } catch (error) {
      restoreMapEntry(this.erasureRequests, next.requestId, requestExisted, priorRequest);
      restoreMapEntry(this.erasureAuditEvents, next.requestId, auditsExisted, priorAudits);
      restoreMapEntry(this.erasureJobControlEvents, next.requestId, controlsExisted, priorControls);
      throw error;
    }
  }

  async claimErasureJobs(options: ClaimErasureJobsOptions): Promise<ErasureJobClaim[]> {
    const leaseUntilMs = validateClaimErasureJobsOptions(options);
    const candidates = [...this.erasureRequests.entries()]
      .filter(([, record]) => (
        record.subjectKind === "user"
        && this.erasureJobParentAllowsAuthority(record)
        && isClaimableErasureRequestStatus(record.status)
        && !isErasureJobQuarantined(record)
        && (
          this.erasureJobNeedsImmediateQueueIsolation(record)
          || (
            record.availableAtMs! <= options.nowMs
            && (
              record.claimToken === undefined
              || record.leaseUntilMs! <= options.nowMs
            )
          )
        )
      ))
      .sort((left, right) => (
        (Number.isSafeInteger(left[1].availableAtMs) ? left[1].availableAtMs! : -1)
        - (Number.isSafeInteger(right[1].availableAtMs) ? right[1].availableAtMs! : -1)
        || left[0].localeCompare(right[0])
      ))
      // A poisoned row consumes scan budget but is durably removed from subsequent polls. This
      // keeps one invocation bounded while guaranteeing that its next neighbour is reachable.
      .slice(0, options.limit);
    const claimed: ErasureRequestRecord[] = [];
    for (const [requestKey, current] of candidates) {
      if (claimed.length >= options.limit) break;
      try {
        if (
          requestKey !== current.requestId
          || !hasSafeErasureRequestQuarantineEnvelope(current)
        ) {
          this.terminallyIsolateUnsafeErasureJobEnvelope(requestKey, current, options.nowMs);
          continue;
        }
        if (!this.erasureJobParentAllowsAuthority(current)) continue;
        try {
          this.assertErasureJobIntegrity(current);
        } catch (error) {
          if (!(error instanceof ErasureJobIntegrityFault)) throw error;
          this.quarantineErasureJob(requestKey, current, error, options.nowMs);
          continue;
        }
        const next = clone<ErasureRequestRecord>({
          ...current,
          attempts: current.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        });
        validateErasureRequestRecord(next);
        this.erasureRequests.set(next.requestId, next);
        claimed.push(next);
      } catch (error) {
        // Claims are committed per row in Memory just as they are per transaction in MySQL.
        // Once one is visible, do not turn a later unknown failure into a hidden successful lease.
        if (claimed.length > 0) break;
        throw error;
      }
    }
    return claimed.map((record) => clone(erasureJobClaimFromRecord(record)));
  }

  async renewErasureJobClaim(
    authorization: ErasureJobAuthorization,
    options: RenewErasureJobClaimOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    const leaseUntilMs = validateRenewErasureJobClaimOptions(options);
    const current = this.erasureRequests.get(authorization.requestId);
    if (!current) return false;
    if (!this.erasureJobParentAllowsAuthority(current)) return false;
    this.assertErasureJobIntegrity(current);
    if (!erasureJobAuthorizationMatches(current, authorization, options.nowMs)) return false;
    const next = clone(current);
    next.leaseUntilMs = Math.max(current.leaseUntilMs!, leaseUntilMs);
    validateErasureRequestRecord(next);
    this.erasureRequests.set(next.requestId, next);
    return true;
  }

  async transitionErasureJob(
    authorization: ErasureJobAuthorization,
    options: TransitionErasureJobOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    validateTransitionErasureJobOptions(options);
    const current = this.erasureRequests.get(authorization.requestId);
    if (!current) return false;
    if (!this.erasureJobParentAllowsAuthority(current)) return false;
    this.assertErasureJobIntegrity(current);
    if (
      current.status !== options.fromStatus
      || !erasureJobAuthorizationMatches(current, authorization, options.atMs)
    ) return false;
    if (options.policyVersion !== undefined && current.policyVersion === undefined) {
      throw new Error("erasure policy identity cannot be assigned after admission");
    }
    if (
      options.policyVersion !== undefined
      && (current.policyVersion !== options.policyVersion || current.policyHash !== options.policyHash)
    ) throw new Error("erasure policy identity is immutable");

    const effectiveAtMs = Math.max(current.updatedAtMs, options.atMs);
    const next = clone(current);
    next.status = options.toStatus;
    next.updatedAtMs = effectiveAtMs;
    next.availableAtMs = options.availableAtMs;
    next.lastErrorCode = options.toStatus === "blocked" ? options.errorCode : undefined;
    next.policyVersion = options.policyVersion ?? current.policyVersion;
    next.policyHash = options.policyHash ?? current.policyHash;
    delete next.claimToken;
    delete next.leaseUntilMs;
    delete next.completedAtMs;
    delete next.counts;
    delete next.checksum;
    if (next.availableAtMs === undefined) delete next.availableAtMs;
    if (next.lastErrorCode === undefined) delete next.lastErrorCode;
    if (next.policyVersion === undefined) delete next.policyVersion;
    if (next.policyHash === undefined) delete next.policyHash;
    validateErasureRequestRecord(next);

    const existingAudits = this.erasureAuditEvents.get(current.requestId)!;
    // Stage the entire chain so a non-cloneable/corrupt prior payload cannot publish half a state
    // transition in the in-memory reference implementation.
    const stagedAudits = clone(existingAudits);
    const auditType: ErasureAuditEvent["type"] = options.toStatus === "blocked"
      ? "erasure/blocked"
      : "erasure/status_changed";
    const payload: Record<string, unknown> = {
      fromStatus: options.fromStatus,
      status: options.toStatus,
      generation: current.generation,
      ...(next.policyVersion === undefined ? {} : { policyVersion: next.policyVersion }),
      ...(next.policyHash === undefined ? {} : { policyHash: next.policyHash }),
      ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
    };
    stagedAudits.push(clone({
      requestId: current.requestId,
      seq: stagedAudits.length + 1,
      type: auditType,
      payload,
      emittedAtMs: effectiveAtMs,
    }));

    let evaluationJob: ErasurePolicyEvaluationJob | undefined;
    if (options.fromStatus === "reconciling_usage" && options.toStatus === "awaiting_purge_policy") {
      if (this.erasurePolicyEvaluationJobs.has(current.requestId)) {
        throw new Error("erasure policy evaluation job already exists before first scheduling");
      }
      evaluationJob = clone(newErasurePolicyEvaluationJob({
        requestId: current.requestId,
        tenantId: current.tenantId,
        subjectKind: current.subjectKind,
        subjectId: current.subjectId,
        subjectGeneration: current.generation,
      }, effectiveAtMs));
    }

    const requestExisted = this.erasureRequests.has(next.requestId);
    const priorRequest = this.erasureRequests.get(next.requestId);
    const auditExisted = this.erasureAuditEvents.has(next.requestId);
    const priorAudits = this.erasureAuditEvents.get(next.requestId);
    const evaluationJobExisted = this.erasurePolicyEvaluationJobs.has(next.requestId);
    const priorEvaluationJob = this.erasurePolicyEvaluationJobs.get(next.requestId);
    try {
      this.erasureRequests.set(next.requestId, next);
      this.erasureAuditEvents.set(next.requestId, stagedAudits);
      if (evaluationJob) this.erasurePolicyEvaluationJobs.set(next.requestId, evaluationJob);
    } catch (error) {
      restoreMapEntry(
        this.erasurePolicyEvaluationJobs,
        next.requestId,
        evaluationJobExisted,
        priorEvaluationJob,
      );
      restoreMapEntry(this.erasureAuditEvents, next.requestId, auditExisted, priorAudits);
      restoreMapEntry(this.erasureRequests, next.requestId, requestExisted, priorRequest);
      throw error;
    }
    return true;
  }

  async retryErasureJob(
    authorization: ErasureJobAuthorization,
    options: RetryErasureJobOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    validateRetryErasureJobOptions(options);
    const current = this.erasureRequests.get(authorization.requestId);
    if (!current) return false;
    if (!this.erasureJobParentAllowsAuthority(current)) return false;
    this.assertErasureJobIntegrity(current);
    if (!erasureJobAuthorizationMatches(current, authorization, options.failedAtMs)) return false;
    const next = clone(current);
    next.updatedAtMs = Math.max(current.updatedAtMs, options.failedAtMs);
    next.availableAtMs = options.availableAtMs;
    next.lastErrorCode = options.errorCode;
    delete next.claimToken;
    delete next.leaseUntilMs;
    validateErasureRequestRecord(next);
    this.erasureRequests.set(next.requestId, next);
    return true;
  }

  private erasureMaintenanceRecord(
    identity: ErasureJobMaintenanceIdentity,
  ): ErasureRequestRecord | undefined {
    const record = this.erasureRequests.get(identity.requestId);
    return record
      && record.tenantId === identity.tenantId
      && record.subjectKind === identity.subjectKind
      && record.subjectId === identity.subjectId
      && record.generation === identity.subjectGeneration
      ? record
      : undefined;
  }

  async inspectErasureJobIntervention(
    identity: ErasureJobMaintenanceIdentity,
  ): Promise<ErasureJobInterventionInspection | null> {
    validateErasureJobMaintenanceIdentity(identity);
    const record = this.erasureMaintenanceRecord(identity);
    if (!record) return null;
    validateErasureRequestRecordForRead(record);
    const audits = this.erasureAuditEvents.get(record.requestId) ?? [];
    if (isErasureJobQuarantined(record)) {
      try {
        validateErasureJobControlAudit(
          record,
          audits,
          this.erasureJobControlEvents.get(record.requestId) ?? [],
        );
      } catch (error) {
        if (record.quarantineReasonCode !== "control_audit_invalid") throw error;
      }
      const reasonCode = record.quarantineReasonCode!;
      const evidenceSha256 = record.quarantineEvidenceSha256!;
      const expected = erasureJobInterventionEvidenceSha256({
        requestId: record.requestId,
        controlGeneration: record.controlGeneration,
        phase: record.status,
        kind: "quarantine",
        reasonCode,
      });
      const terminalExpected = record.controlGeneration === Number.MAX_SAFE_INTEGER
        && reasonCode === "control_audit_invalid"
        ? erasureJobTerminalInterventionEvidenceSha256({
            requestId: record.requestId,
            rawControlGeneration: String(record.controlGeneration),
            phase: record.status,
            reasonCode,
          })
        : undefined;
      if (expected !== evidenceSha256 && terminalExpected !== evidenceSha256) {
        throw new Error("erasure quarantine evidence is corrupt");
      }
      return clone({
        requestId: record.requestId,
        phase: record.status,
        controlGeneration: record.controlGeneration,
        kind: "quarantine",
        reasonCode,
        evidenceSha256,
        occurredAtMs: record.quarantinedAtMs!,
        allowedActions: erasureJobAllowedMaintenanceActions(record, audits),
      });
    }
    if (record.status !== "blocked") return null;
    this.assertErasureJobIntegrity(record);
    const reasonCode = record.lastErrorCode!;
    const evidenceSha256 = erasureJobInterventionEvidenceSha256({
      requestId: record.requestId,
      controlGeneration: record.controlGeneration,
      phase: record.status,
      kind: "blocked",
      reasonCode,
    });
    const allowedActions = erasureJobAllowedMaintenanceActions(record, audits);
    let resumePhase: ErasureJobInterventionInspection["resumePhase"];
    if (allowedActions.includes("resume_blocked")) {
      resumePhase = deriveBlockedErasureResumePhase(record, audits);
    }
    return clone({
      requestId: record.requestId,
      phase: record.status,
      controlGeneration: record.controlGeneration,
      kind: "blocked",
      reasonCode,
      evidenceSha256,
      occurredAtMs: audits.at(-1)!.emittedAtMs,
      ...(resumePhase === undefined ? {} : { resumePhase }),
      allowedActions,
    });
  }

  async repairAndResumeErasureJob(input: RepairAndResumeErasureJobInput): Promise<boolean> {
    validateRepairAndResumeErasureJobInput(input);
    const current = this.erasureMaintenanceRecord(input);
    if (!current || current.controlGeneration !== input.expectedControlGeneration) return false;
    validateErasureRequestRecordForRead(current);
    // Preserve the existing lifecycle-integrity exception below for a genuinely non-active parent.
    // Only the otherwise-valid active projection plus orphan append-only evidence takes this
    // no-resurrection path and declines to mint fresh queue authority.
    const tenant = this.subjectRecord(current.tenantId, "tenant", current.tenantId);
    if (
      current.subjectKind === "user"
      && tenant?.state === "active"
      && this.hasTenantErasureAuthorityFence(current.tenantId)
    ) return false;

    if (isErasureJobQuarantined(current)) {
      const verifiedEvidenceSha256 = erasureJobInterventionEvidenceSha256({
        requestId: current.requestId,
        controlGeneration: current.controlGeneration,
        phase: current.status,
        kind: "quarantine",
        reasonCode: current.quarantineReasonCode!,
      });
      if (
        current.quarantineEvidenceSha256 !== verifiedEvidenceSha256
        || input.expectedEvidenceSha256 !== verifiedEvidenceSha256
        || input.actionCode === "resume_blocked"
      ) return false;
      const currentAudits = this.erasureAuditEvents.get(current.requestId) ?? [];
      const allowedActions = erasureJobAllowedMaintenanceActions(current, currentAudits);
      if (!allowedActions.includes(input.actionCode)) return false;
      validateErasureJobControlAudit(
        current,
        currentAudits,
        this.erasureJobControlEvents.get(current.requestId) ?? [],
      );

      const effectiveAtMs = Math.max(current.updatedAtMs, input.atMs);
      const next = clone(current);
      next.controlGeneration = current.controlGeneration + 1;
      next.updatedAtMs = effectiveAtMs;
      next.availableAtMs = effectiveAtMs;
      delete next.claimToken;
      delete next.leaseUntilMs;
      delete next.quarantinedAtMs;
      delete next.quarantineReasonCode;
      delete next.quarantineEvidenceSha256;

      let stagedAudits: ErasureAuditEvent[];
      if (input.actionCode === "restore_initial_gate_audit") {
        if (current.status !== "gated" || currentAudits.length !== 0) return false;
        stagedAudits = [clone({
          requestId: current.requestId,
          seq: 1,
          type: "erasure/gated",
          payload: {
            status: "gated",
            subjectKind: current.subjectKind,
            generation: current.generation,
            ...(current.policyVersion === undefined ? {} : { policyVersion: current.policyVersion }),
            ...(current.policyHash === undefined ? {} : { policyHash: current.policyHash }),
          },
          emittedAtMs: current.gatedAtMs,
        })];
      } else {
        stagedAudits = clone(currentAudits);
      }

      validateErasureRequestRecord(next);
      validateErasureAuditChain(next, stagedAudits);
      const tenant = this.subjectRecord(next.tenantId, "tenant", next.tenantId);
      const subject = this.subjectRecord(next.tenantId, next.subjectKind, next.subjectId);
      if (
        !tenant
        || (next.subjectKind === "user" && tenant.state !== "active")
        || !subject
        || subject.state !== "deleting"
        || subject.generation !== next.generation
        || subject.activeRequestId !== next.requestId
      ) throw new Error("repaired erasure request does not match its subject lifecycle");
      if (next.subjectKind === "user") {
        const key = JSON.stringify([next.tenantId, "user", next.subjectId, next.idempotencyKey]);
        if (this.erasureIdempotency.get(key) !== next.requestId) {
          throw new Error("repaired erasure request idempotency binding is invalid");
        }
      }

      const eventWithoutAfter = {
        controlEventId: this.nextErasureJobControlEventId,
        requestId: next.requestId,
        controlGeneration: next.controlGeneration,
        eventType: "erasure_job/quarantine_repaired",
        phase: next.status,
        reasonCode: current.quarantineReasonCode!,
        actionCode: input.actionCode,
        actorKeyId: input.actorKeyId,
        beforeSha256: verifiedEvidenceSha256,
        emittedAtMs: effectiveAtMs,
      } satisfies Omit<ErasureJobControlEvent, "afterSha256">;
      const event = clone<ErasureJobControlEvent>({
        ...eventWithoutAfter,
        afterSha256: erasureJobControlOutcomeSha256(eventWithoutAfter),
      });
      validateErasureJobControlEvent(event);
      const stagedControlEvents = [
        ...(this.erasureJobControlEvents.get(current.requestId) ?? []),
        event,
      ];
      validateErasureJobControlAudit(next, stagedAudits, stagedControlEvents);

      this.publishErasureControlState(next, stagedAudits, stagedControlEvents);
      this.nextErasureJobControlEventId += 1;
      return true;
    }

    if (current.status !== "blocked" || input.actionCode !== "resume_blocked") return false;
    const currentAudits = this.erasureAuditEvents.get(current.requestId) ?? [];
    this.assertErasureJobIntegrity(current);
    const reasonCode = current.lastErrorCode!;
    const evidenceSha256 = erasureJobInterventionEvidenceSha256({
      requestId: current.requestId,
      controlGeneration: current.controlGeneration,
      phase: current.status,
      kind: "blocked",
      reasonCode,
    });
    if (evidenceSha256 !== input.expectedEvidenceSha256) return false;
    if (!erasureJobAllowedMaintenanceActions(current, currentAudits).includes("resume_blocked")) {
      return false;
    }
    const resumePhase = deriveBlockedErasureResumePhase(current, currentAudits);
    const effectiveAtMs = Math.max(current.updatedAtMs, input.atMs);
    const next = clone(current);
    next.status = resumePhase;
    next.controlGeneration = current.controlGeneration + 1;
    next.updatedAtMs = effectiveAtMs;
    next.availableAtMs = effectiveAtMs;
    delete next.lastErrorCode;
    delete next.claimToken;
    delete next.leaseUntilMs;
    validateErasureRequestRecord(next);

    const stagedAudits = clone(currentAudits);
    stagedAudits.push(clone({
      requestId: current.requestId,
      seq: stagedAudits.length + 1,
      type: "erasure/resumed",
      payload: {
        fromStatus: "blocked",
        status: resumePhase,
        generation: current.generation,
        ...(next.policyVersion === undefined ? {} : { policyVersion: next.policyVersion }),
        ...(next.policyHash === undefined ? {} : { policyHash: next.policyHash }),
      },
      emittedAtMs: effectiveAtMs,
    }));
    validateErasureAuditChain(next, stagedAudits);

    const eventWithoutAfter = {
      controlEventId: this.nextErasureJobControlEventId,
      requestId: next.requestId,
      controlGeneration: next.controlGeneration,
      eventType: "erasure_job/blocked_resumed",
      phase: resumePhase,
      reasonCode,
      actionCode: "resume_blocked",
      actorKeyId: input.actorKeyId,
      beforeSha256: evidenceSha256,
      emittedAtMs: effectiveAtMs,
    } satisfies Omit<ErasureJobControlEvent, "afterSha256">;
    const event = clone<ErasureJobControlEvent>({
      ...eventWithoutAfter,
      afterSha256: erasureJobControlOutcomeSha256(eventWithoutAfter),
    });
    validateErasureJobControlEvent(event);
    const stagedControlEvents = [
      ...(this.erasureJobControlEvents.get(current.requestId) ?? []),
      event,
    ];
    validateErasureJobControlAudit(next, stagedAudits, stagedControlEvents);

    this.publishErasureControlState(next, stagedAudits, stagedControlEvents);
    this.nextErasureJobControlEventId += 1;
    return true;
  }

  private assertErasureSessionAuthority(
    authorization: ErasureWriteAuthorization,
    allowedStatuses: readonly ErasureRequestStatus[],
    nowMs: number,
  ): ErasureRequestRecord {
    const request = this.erasureRequests.get(authorization.requestId);
    const tenant = this.subjectRecord(authorization.tenantId, "tenant", authorization.tenantId);
    const user = this.subjectRecord(authorization.tenantId, "user", authorization.userId);
    if (
      !request
      || !tenant
      || !this.isTenantActive(authorization.tenantId)
      || !user
      || user.state !== "deleting"
      || user.generation !== authorization.subjectGeneration
      || user.activeRequestId !== authorization.requestId
    ) throw new Error("stale erasure authority");
    this.assertErasureJobIntegrity(request);
    if (
      !allowedStatuses.includes(request.status)
      || !erasureWriteAuthorizationMatches(request, authorization, nowMs)
    ) throw new Error("stale erasure authority");
    return request;
  }

  private cloneAndValidateErasureEventLog(session: Session): PersistedEvent[] {
    const current = this.events.get(session.id);
    if (!current) throw new Error("erasure session event log is missing");
    const staged = clone(current);
    if (staged.length !== session.lastSeq) throw new Error("erasure session event cursor is corrupt");
    for (const [index, event] of staged.entries()) {
      if (
        event.sessionId !== session.id
        || event.seq !== index + 1
        || !EventSchema.safeParse(event).success
      ) throw new Error("erasure session event log is corrupt");
    }
    return staged;
  }

  private stageErasureApprovalTerminals(
    sessionId: string,
    atMs: number,
    turnId?: string,
  ): { approvals: Approval[]; items: Item[]; events: EventInput[] } {
    const selected = [...this.approvals.entries()]
      .filter(([, approval]) => (
        approval.sessionId === sessionId
        && approval.status === "pending"
        && (turnId === undefined || approval.turnId === turnId)
      ))
      .sort((left, right) => left[1].id.localeCompare(right[1].id));
    const approvals: Approval[] = [];
    const items: Item[] = [];
    const events: EventInput[] = [];
    const approvalIds = new Set<string>();
    const itemIds = new Set<string>();
    const selectedApprovalIds = new Set(selected.map(([, approval]) => approval.id));
    const scopedInProgressItems = [...this.items.entries()].filter(
      (entry): entry is [string, ItemOf<"approvalRequest">] => {
        const item = entry[1];
        return item.sessionId === sessionId
          && item.type === "approvalRequest"
          && item.status === "inProgress"
          && (turnId === undefined || item.turnId === turnId);
      },
    );
    if (scopedInProgressItems.some(([, item]) => !selectedApprovalIds.has(item.approvalId))) {
      throw new Error("erasure approval item is orphaned");
    }

    for (const [approvalKey, storedApproval] of selected) {
      if (
        approvalKey !== storedApproval.id
        || approvalIds.has(storedApproval.id)
        || [...this.approvals.values()].filter((candidate) => candidate.id === storedApproval.id).length !== 1
        || !ApprovalSchema.safeParse(storedApproval).success
      ) throw new Error("erasure approval identity is corrupt");
      approvalIds.add(storedApproval.id);

      const approvalTurn = this.turns.get(storedApproval.turnId);
      if (
        !approvalTurn
        || approvalTurn.id !== storedApproval.turnId
        || approvalTurn.sessionId !== sessionId
        || !TurnSchema.safeParse(approvalTurn).success
      ) throw new Error("erasure approval turn identity is corrupt");

      // Historical rows may point Approval.itemId at the tool-call item. The durable relationship is
      // approvalRequest.approvalId; require a strict one-to-one existing association and never INSERT.
      const associated = [...this.items.entries()].filter(
        (entry): entry is [string, ItemOf<"approvalRequest">] => {
          const item = entry[1];
          return item.sessionId === sessionId
            && item.type === "approvalRequest"
            && item.approvalId === storedApproval.id;
        },
      );
      if (associated.length !== 1) throw new Error("erasure approval item association is corrupt");
      const [itemKey, storedItem] = associated[0]!;
      if (
        itemKey !== storedItem.id
        || itemIds.has(storedItem.id)
        || [...this.items.values()].filter((candidate) => candidate.id === storedItem.id).length !== 1
        || storedItem.turnId !== storedApproval.turnId
        || storedItem.toolCallId !== storedApproval.toolCallId
        || storedItem.name !== storedApproval.toolName
        || storedItem.status !== "inProgress"
        || !ItemSchema.safeParse(storedItem).success
      ) throw new Error("erasure approval item identity is corrupt");
      itemIds.add(storedItem.id);

      const approval = clone<Approval>({
        ...storedApproval,
        status: "expired",
        decision: "cancel",
        decidedBy: "system:erasure",
        resolvedAtMs: atMs,
      });
      const item = clone<Item>({
        ...storedItem,
        status: "declined",
        completedAtMs: atMs,
      });
      if (!ApprovalSchema.safeParse(approval).success || !ItemSchema.safeParse(item).success) {
        throw new Error("erasure approval terminal projection is invalid");
      }
      approvals.push(approval);
      items.push(item);
      events.push(clone({ type: "approval/resolved", sessionId, emittedAtMs: atMs, approval }));
      events.push(clone({ type: "item/completed", sessionId, emittedAtMs: atMs, item }));
    }
    return { approvals, items, events };
  }

  private assertExistingErasureTombstone(
    session: Session,
    tombstone: { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number },
  ): void {
    if (
      !Number.isSafeInteger(tombstone.deletedAtMs)
      || tombstone.deletedAtMs < 0
      || !Number.isSafeInteger(tombstone.deletionGeneration)
      || tombstone.deletionGeneration <= 0
      || tombstone.purgeAfterMs !== undefined
    ) throw new Error("erasure tombstone marker is corrupt");
    const log = this.cloneAndValidateErasureEventLog(session);
    const terminal = log.at(-1);
    if (
      terminal?.type !== "session/deleted"
      || terminal.deletionGeneration !== tombstone.deletionGeneration
      || terminal.emittedAtMs !== tombstone.deletedAtMs
    ) throw new Error("erasure tombstone event is corrupt");

    const outboxIds = new Set<number>();
    for (const topic of ["session.tombstoned", "session.purge"] as const) {
      const key = this.lifecycleOutboxMapKey(topic, session.id, tombstone.deletionGeneration);
      const row = this.lifecycleOutbox.get(key);
      if (!row) throw new Error("erasure tombstone outbox is missing");
      assertLifecycleOutboxId(row.outboxId);
      outboxIds.add(row.outboxId);
      const envelope = parseLifecycleOutboxEnvelope(row.topic, clone(row.payload));
      if (
        row.topic !== topic
        || row.aggregateId !== session.id
        || row.generation !== tombstone.deletionGeneration
        || envelope.payload.sessionId !== session.id
        || envelope.payload.deletionGeneration !== tombstone.deletionGeneration
      ) throw new Error("erasure tombstone outbox is corrupt");
      if (
        topic === "session.tombstoned"
        && (
          envelope.topic !== "session.tombstoned"
          || !("eventSeq" in envelope.payload)
          || envelope.payload.eventSeq !== terminal.seq
          || row.deadLetteredAtMs !== undefined
        )
      ) throw new Error("erasure tombstone outbox is corrupt");
      if (
        topic === "session.purge"
        && (
          envelope.topic !== "session.purge"
          || row.availableAtMs !== undefined
          || row.attempts !== 0
          || row.claimToken !== undefined
          || row.leaseUntilMs !== undefined
          || row.lastError !== undefined
          || row.completedAtMs !== undefined
          || row.deadLetteredAtMs !== undefined
        )
      ) throw new Error("erasure tombstone outbox is corrupt");
    }
    if (outboxIds.size !== 2) throw new Error("erasure tombstone outbox is corrupt");
  }

  private erasureTombstoneProofValid(
    session: Session,
    tombstone: { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number },
  ): boolean {
    try {
      this.assertExistingErasureTombstone(session, tombstone);
      return true;
    } catch {
      // Memory has no transport boundary: every failure here is a deterministic stored-proof
      // conflict. The catalog exposes only this bit and never the corrupt content or exception.
      return false;
    }
  }

  async getErasureSessionHead(
    authorization: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<ErasureSessionHead | null> {
    const stagedAuthorization = clone(authorization);
    if (!isCanonicalId("sess", sessionId)) throw new Error("invalid erasure session identity");
    this.assertErasureSessionAuthority(stagedAuthorization, ["draining", "tombstoning"], Date.now());
    const session = this.sessions.get(sessionId);
    if (
      !session
      || session.tenantId !== stagedAuthorization.tenantId
      || session.userId !== stagedAuthorization.userId
    ) {
      return null;
    }
    if (session.id !== sessionId) throw new Error("erasure session identity is corrupt");
    const tombstone = this.deleted.get(sessionId);
    const head: ErasureSessionHead = {
      sessionId,
      tenantId: session.tenantId,
      userId: session.userId,
      ...(session.status.type === "active" ? { activeTurnId: session.status.turnId } : {}),
      deleted: tombstone !== undefined,
      deletionGeneration: tombstone?.deletionGeneration ?? 0,
    };
    if (
      (head.activeTurnId !== undefined && !isCanonicalId("turn", head.activeTurnId))
      || !Number.isSafeInteger(head.deletionGeneration)
      || head.deletionGeneration < 0
    ) throw new Error("erasure session head is corrupt");
    return clone(head);
  }

  async applyErasureSessionAction(input: ErasureSessionAction): Promise<CommitResult> {
    // Clone the complete caller input before inspecting or mutating store state. Accessors, proxies,
    // functions or extra non-serializable authority material therefore fail before publication.
    const action = clone(input);
    validateErasureSessionAction(action);
    const allowedStatuses: readonly ErasureRequestStatus[] = action.action === "fence"
      ? ["draining", "tombstoning"]
      : ["tombstoning"];
    this.assertErasureSessionAuthority(action.authority, allowedStatuses, Date.now());

    const storedSession = this.sessions.get(action.sessionId);
    if (
      !storedSession
      || storedSession.id !== action.sessionId
      || storedSession.tenantId !== action.authority.tenantId
      || storedSession.userId !== action.authority.userId
    ) throw new SessionGoneError(action.sessionId);
    if (action.fence < storedSession.fenceToken) {
      throw new FenceError(action.sessionId, action.fence, storedSession.fenceToken);
    }

    const existingTombstone = this.deleted.get(action.sessionId);
    if (existingTombstone) {
      if (action.action !== "tombstone") throw new SessionGoneError(action.sessionId);
      this.assertExistingErasureTombstone(storedSession, existingTombstone);
      return {
        events: [],
        lastSeq: storedSession.lastSeq,
        lifecycleGeneration: existingTombstone.deletionGeneration,
      };
    }

    const stagedSession = clone(storedSession);
    stagedSession.fenceToken = action.fence;
    if (!SessionSchema.safeParse(stagedSession).success) throw new Error("erasure session row is invalid");
    if (action.action === "fence") {
      // This branch deliberately stages no event log or business resource. Publishing the cloned
      // session replaces exactly one scalar: the durable fence token.
      this.sessions.set(action.sessionId, stagedSession);
      return { events: [], lastSeq: stagedSession.lastSeq };
    }

    if (action.action === "settle" && stagedSession.status.type !== "active") {
      // A lost response may retry after the first settlement. The preceding fence action already
      // linearized ownership, so an inactive projection is a safe idempotent business no-op. A
      // direct caller may still carry a newer valid session fence, which must be published.
      this.sessions.set(action.sessionId, stagedSession);
      return { events: [], lastSeq: stagedSession.lastSeq };
    }

    if (action.action === "tombstone" && stagedSession.status.type === "active") {
      throw new SessionLifecycleBusyError(action.sessionId);
    }

    const stagedLog = this.cloneAndValidateErasureEventLog(stagedSession);
    let stagedTurn: Turn | undefined;
    let terminalApprovals: Approval[] = [];
    let terminalItems: Item[] = [];
    const eventInputs: EventInput[] = [];
    let effectiveAtMs = Math.max(action.atMs, stagedSession.updatedAtMs);

    if (action.action === "settle") {
      const activeTurnId = stagedSession.status.type === "active" ? stagedSession.status.turnId : undefined;
      const storedTurn = activeTurnId ? this.turns.get(activeTurnId) : undefined;
      if (
        !activeTurnId
        || !storedTurn
        || storedTurn.id !== activeTurnId
        || storedTurn.sessionId !== action.sessionId
        || [...this.turns.values()].filter((candidate) => candidate.id === activeTurnId).length !== 1
        || storedTurn.status !== "inProgress"
        || !TurnSchema.safeParse(storedTurn).success
      ) throw new Error("erasure active turn is missing or not in progress");
      effectiveAtMs = Math.max(effectiveAtMs, storedTurn.startedAtMs);

      const approvalTerminals = this.stageErasureApprovalTerminals(action.sessionId, effectiveAtMs, activeTurnId);
      terminalApprovals = approvalTerminals.approvals;
      terminalItems = approvalTerminals.items;
      eventInputs.push(...approvalTerminals.events);

      stagedTurn = clone({
        ...storedTurn,
        status: "interrupted" as const,
        stopReason: "interrupted" as const,
        completedAtMs: effectiveAtMs,
        error: { code: "erasure", message: "turn interrupted for user erasure" },
      });
      const finalSeq = stagedSession.lastSeq + eventInputs.length + 2;
      stagedTurn.seqEnd = finalSeq;
      if (!TurnSchema.safeParse(stagedTurn).success) throw new Error("erasure terminal turn is invalid");
      eventInputs.push(clone({
        type: "turn/completed",
        sessionId: action.sessionId,
        emittedAtMs: effectiveAtMs,
        turn: stagedTurn,
        stopReason: "interrupted",
      }));
      eventInputs.push(clone({
        type: "session/status/changed",
        sessionId: action.sessionId,
        emittedAtMs: effectiveAtMs,
        status: { type: "idle" },
      }));
      stagedSession.status = { type: "idle" };
    } else {
      if ([...this.sessions.values()].some((candidate) => (
        candidate.parentSessionId === action.sessionId && !this.deleted.has(candidate.id)
      ))) throw new SessionHasChildrenError(action.sessionId);
      const approvalTerminals = this.stageErasureApprovalTerminals(action.sessionId, effectiveAtMs);
      terminalApprovals = approvalTerminals.approvals;
      terminalItems = approvalTerminals.items;
      eventInputs.push(...approvalTerminals.events);
      eventInputs.push(clone({
        type: "session/deleted",
        sessionId: action.sessionId,
        emittedAtMs: effectiveAtMs,
        deletionGeneration: 1,
      }));
      stagedSession.autoApprovedTools = [];
    }

    const persistedEvents = eventInputs.map((event, index) => clone({
      ...event,
      seq: stagedSession.lastSeq + index + 1,
    } as PersistedEvent));
    for (const event of persistedEvents) {
      if (!EventSchema.safeParse(event).success) throw new Error("erasure terminal event is invalid");
    }
    const nextLastSeq = stagedSession.lastSeq + persistedEvents.length;
    stagedSession.lastSeq = nextLastSeq;
    stagedSession.updatedAtMs = effectiveAtMs;
    if (!SessionSchema.safeParse(stagedSession).success) throw new Error("erasure terminal session is invalid");
    const nextLog = [...stagedLog, ...persistedEvents.map(clone)];
    const resultEvents = persistedEvents.map(clone);

    let stagedTombstone: { deletedAtMs: number; deletionGeneration: number } | undefined;
    let stagedOutboxes: [string, LifecycleOutboxRecord][] = [];
    let nextOutboxId = this.nextLifecycleOutboxId;
    if (action.action === "tombstone") {
      stagedTombstone = clone({ deletedAtMs: effectiveAtMs, deletionGeneration: 1 });
      if (
        !Number.isSafeInteger(nextOutboxId)
        || nextOutboxId <= 0
        || nextOutboxId > Number.MAX_SAFE_INTEGER - 2
      ) {
        throw new Error("lifecycle outbox sequence is exhausted");
      }
      const deletedEvent = persistedEvents.at(-1);
      if (deletedEvent?.type !== "session/deleted") throw new Error("erasure terminal event is missing");
      const outboxes = ([
        {
          outboxId: nextOutboxId,
          topic: "session.tombstoned",
          aggregateId: action.sessionId,
          generation: 1,
          payload: { sessionId: action.sessionId, deletionGeneration: 1, eventSeq: deletedEvent.seq },
          availableAtMs: effectiveAtMs,
          attempts: 0,
          createdAtMs: effectiveAtMs,
        },
        {
          outboxId: nextOutboxId + 1,
          topic: "session.purge",
          aggregateId: action.sessionId,
          generation: 1,
          payload: { sessionId: action.sessionId, deletionGeneration: 1 },
          attempts: 0,
          createdAtMs: effectiveAtMs,
        },
      ] satisfies LifecycleOutboxRecord[]).map(clone);
      stagedOutboxes = outboxes.map((outbox) => {
        assertLifecycleOutboxId(outbox.outboxId);
        const envelope = parseLifecycleOutboxEnvelope(outbox.topic, clone(outbox.payload));
        if (
          envelope.payload.sessionId !== action.sessionId
          || envelope.payload.deletionGeneration !== 1
          || [...this.lifecycleOutbox.values()].some((candidate) => candidate.outboxId === outbox.outboxId)
        ) throw new Error("erasure lifecycle outbox identity is corrupt");
        const key = this.lifecycleOutboxMapKey(outbox.topic, action.sessionId, 1);
        if (this.lifecycleOutbox.has(key)) throw new Error("lifecycle outbox identity already exists");
        return [key, outbox];
      });
      nextOutboxId += stagedOutboxes.length;
    }

    // All clone/schema/identity checks above are complete. The remainder is a synchronous Memory
    // publication with no fallible serialization, mirroring one database transaction.
    this.sessions.set(action.sessionId, stagedSession);
    if (stagedTurn) this.turns.set(stagedTurn.id, stagedTurn);
    for (const approval of terminalApprovals) this.approvals.set(approval.id, approval);
    for (const item of terminalItems) this.items.set(item.id, item);
    this.events.set(action.sessionId, nextLog);
    if (stagedTombstone) {
      this.deleted.set(action.sessionId, stagedTombstone);
      for (const [key, outbox] of stagedOutboxes) this.lifecycleOutbox.set(key, outbox);
      this.nextLifecycleOutboxId = nextOutboxId;
    }
    return {
      events: resultEvents,
      lastSeq: nextLastSeq,
      ...(stagedTombstone ? { lifecycleGeneration: stagedTombstone.deletionGeneration } : {}),
    };
  }

  private erasureSessionRef(sessionKey: string, session: Session): ErasureSessionRef {
    if (
      sessionKey !== session.id
      || !isCanonicalId("sess", session.id)
      || (session.parentSessionId !== undefined && !isCanonicalId("sess", session.parentSessionId))
    ) throw new Error("erasure catalog session identity is corrupt");
    const tombstone = this.deleted.get(session.id);
    const generation = tombstone?.deletionGeneration ?? 0;
    if (
      !Number.isSafeInteger(generation)
      || generation < 0
      || (tombstone !== undefined && (
        !Number.isSafeInteger(tombstone.deletedAtMs)
        || tombstone.deletedAtMs < 0
      ))
    ) throw new Error("erasure catalog tombstone is corrupt");
    return {
      sessionId: session.id,
      ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
      deleted: tombstone !== undefined,
      deletionGeneration: generation,
    };
  }

  /** Child ownership is deliberately ignored: any live child blocks parent tombstoning. */
  private hasLiveErasureChild(parentSessionId: string): boolean {
    return [...this.sessions.entries()].some(([sessionKey, candidate]) => {
      if (candidate.parentSessionId !== parentSessionId) return false;
      // Validate a row which participates in the leaf decision instead of allowing corrupt identity
      // to turn a real child into an apparently safe leaf.
      this.erasureSessionRef(sessionKey, candidate);
      return !this.deleted.has(candidate.id);
    });
  }

  async listErasureSessions(
    authorization: ErasureWriteAuthorization,
    query: ErasureSessionQuery,
  ): Promise<ErasureSessionPage> {
    const stagedAuthorization = clone(authorization);
    const stagedQuery = clone(query);
    validateErasureSessionQuery(stagedAuthorization, stagedQuery);
    this.assertErasureSessionAuthority(
      stagedAuthorization,
      [stagedQuery.phase],
      stagedQuery.nowMs,
    );

    const candidates: ErasureSessionRef[] = [];
    for (const [sessionKey, session] of this.sessions) {
      if (
        session.tenantId !== stagedAuthorization.tenantId
        || session.userId !== stagedAuthorization.userId
      ) continue;
      const ref = this.erasureSessionRef(sessionKey, session);
      if (stagedQuery.afterSessionId !== undefined && ref.sessionId <= stagedQuery.afterSessionId) continue;
      if (stagedQuery.phase === "draining" && ref.deleted) continue;
      if (stagedQuery.phase === "tombstoning" && (
        ref.deleted || this.hasLiveErasureChild(ref.sessionId)
      )) continue;
      if (stagedQuery.phase === "reconciling_usage" && !ref.deleted) continue;
      if (stagedQuery.phase === "reconciling_usage") {
        const tombstone = this.deleted.get(ref.sessionId);
        ref.tombstoneProofValid = tombstone !== undefined
          && this.erasureTombstoneProofValid(session, tombstone);
      }
      candidates.push(ref);
    }
    candidates.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const hasMore = candidates.length > stagedQuery.limit;
    const data = candidates.slice(0, stagedQuery.limit).map(clone);
    const last = data.at(-1);
    return clone({
      data,
      ...(hasMore && last ? { nextCursor: last.sessionId } : {}),
    });
  }

  async inspectErasureSubjectProgress(
    authorization: ErasureWriteAuthorization,
    query: ErasureProgressQuery,
  ): Promise<ErasureSubjectProgress> {
    const stagedAuthorization = clone(authorization);
    const stagedQuery = clone(query);
    validateErasureProgressQuery(stagedAuthorization, stagedQuery);
    this.assertErasureSessionAuthority(
      stagedAuthorization,
      [stagedQuery.phase],
      stagedQuery.nowMs,
    );

    const owned: ErasureSessionRef[] = [];
    for (const [sessionKey, session] of this.sessions) {
      if (
        session.tenantId === stagedAuthorization.tenantId
        && session.userId === stagedAuthorization.userId
      ) owned.push(this.erasureSessionRef(sessionKey, session));
    }
    const live = owned.filter((session) => !session.deleted);
    const tombstoned = owned.filter((session) => session.deleted);
    const positiveGeneration = tombstoned.filter((session) => session.deletionGeneration > 0);
    let reconciledUsageSessions = 0;
    for (const session of positiveGeneration) {
      const reconciliation = this.usageReconciliations.get(
        this.usageReconciliationMapKey(session.sessionId, session.deletionGeneration),
      );
      if (
        reconciliation
        && reconciliation.tenantId === stagedAuthorization.tenantId
        && reconciliation.userId === stagedAuthorization.userId
        && reconciliation.sessionId === session.sessionId
        && reconciliation.deletionGeneration === session.deletionGeneration
        && (reconciliation.status === "verified" || reconciliation.status === "anonymized")
      ) reconciledUsageSessions += 1;
    }

    let orphanOrMismatchedUsageRows = 0;
    for (const usage of this.usageLedger) {
      const session = this.sessions.get(usage.sessionId);
      const rowOwned = usage.tenantId === stagedAuthorization.tenantId
        && usage.userId === stagedAuthorization.userId;
      const sessionOwned = !!session
        && session.id === usage.sessionId
        && session.tenantId === stagedAuthorization.tenantId
        && session.userId === stagedAuthorization.userId;
      if ((rowOwned && !sessionOwned) || (sessionOwned && !rowOwned)) {
        orphanOrMismatchedUsageRows += 1;
      }
    }

    const progress: ErasureSubjectProgress = {
      totalSessions: owned.length,
      liveSessions: live.length,
      liveLeafSessions: live.filter((session) => !this.hasLiveErasureChild(session.sessionId)).length,
      tombstonedSessions: tombstoned.length,
      legacyGenerationZeroSessions: tombstoned.filter((session) => session.deletionGeneration === 0).length,
      reconciledUsageSessions,
      unreconciledUsageSessions: positiveGeneration.length - reconciledUsageSessions,
      orphanOrMismatchedUsageRows,
    };
    return clone(progress);
  }

  async createAgent(def: AgentDefinition) {
    const staged = clone(def);
    this.assertTenantWritable(staged.tenantId);
    this.agents.set(agentVersionKey(staged.tenantId, staged.id, staged.version), staged);
  }
  async getAgent(tenantId: string, agentId: string, version?: number) {
    if (!this.isTenantActive(tenantId)) return null;
    if (version !== undefined) {
      return clone(this.agents.get(agentVersionKey(tenantId, agentId, version)) ?? null);
    }
    const versions = [...this.agents.values()].filter((a) => a.tenantId === tenantId && a.id === agentId);
    if (!versions.length) return null;
    return clone(versions.reduce((a, b) => (a.version > b.version ? a : b)));
  }
  async listAgents(tenantId: string, opts: { cursor?: string; limit: number }) {
    if (!this.isTenantActive(tenantId)) return { data: [], nextCursor: null };
    const latest = new Map<string, AgentDefinition>();
    for (const a of this.agents.values()) {
      if (a.tenantId !== tenantId) continue;
      const cur = latest.get(a.id);
      if (!cur || cur.version < a.version) latest.set(a.id, a);
    }
    return paginate([...latest.values()], (a) => a.id, opts.cursor, opts.limit, "desc");
  }

  async createSession(session: Session): Promise<CommitResult> {
    if (session.lastSeq !== 0) throw new Error("a new session must start at lastSeq 0");
    if (session.fenceToken !== 0) throw new Error("a new session must start at fenceToken 0");
    this.assertSubjectWritable(session.tenantId, session.userId);
    if (this.sessions.has(session.id)) throw new SessionExistsError(session.id);

    // The parent check and child publication are one synchronous critical section. MySQL takes the
    // corresponding parent row lock in its creation transaction, so create-vs-delete has the same
    // linearization semantics in both implementations.
    if (session.parentSessionId) {
      const parent = this.sessions.get(session.parentSessionId);
      if (
        !parent
        || this.deleted.has(session.parentSessionId)
        || parent.tenantId !== session.tenantId
        || parent.userId !== session.userId
      ) {
        throw new SessionGoneError(session.parentSessionId);
      }
    }

    // Stage every fallible clone before publishing either map entry. Session metadata is open-ended
    // and may contain an uncloneable/throwing value; such a failure must not leave a session without
    // its creation event (or vice versa).
    const stagedSession = clone(session);
    // Memory has no durable cross-release state to migrate, but direct/legacy SessionStore callers
    // can still construct a pristine session with pre-0011 emptyUsage(). New-session provenance
    // proves there are no provider rows, so this is the one safe place to restore the cost identity.
    stagedSession.usage = normalizeRowlessUsageProjection(stagedSession.usage);
    const stagedEvent = clone<PersistedEvent>({
      type: "session/created",
      sessionId: session.id,
      emittedAtMs: session.createdAtMs,
      seq: 1,
    });
    stagedSession.lastSeq = 1;
    const tenantKey = subjectLifecycleKey(session.tenantId, "tenant", session.tenantId);
    const userKey = subjectLifecycleKey(session.tenantId, "user", session.userId);
    const stagedTenant = this.subjectLifecycles.has(tenantKey)
      ? undefined
      : clone(this.activeSubjectRecord(session.tenantId, "tenant", session.tenantId, session.createdAtMs));
    const stagedUser = this.subjectLifecycles.has(userKey)
      ? undefined
      : clone(this.activeSubjectRecord(session.tenantId, "user", session.userId, session.createdAtMs));

    const tenantExisted = this.subjectLifecycles.has(tenantKey);
    const priorTenant = this.subjectLifecycles.get(tenantKey);
    const userExisted = this.subjectLifecycles.has(userKey);
    const priorUser = this.subjectLifecycles.get(userKey);
    const sessionExisted = this.sessions.has(session.id);
    const priorSession = this.sessions.get(session.id);
    const eventsExisted = this.events.has(session.id);
    const priorEvents = this.events.get(session.id);
    try {
      if (stagedTenant) this.subjectLifecycles.set(tenantKey, stagedTenant);
      if (stagedUser) this.subjectLifecycles.set(userKey, stagedUser);
      this.sessions.set(session.id, stagedSession);
      this.events.set(session.id, [stagedEvent]);
    } catch (error) {
      restoreMapEntry(this.events, session.id, eventsExisted, priorEvents);
      restoreMapEntry(this.sessions, session.id, sessionExisted, priorSession);
      restoreMapEntry(this.subjectLifecycles, userKey, userExisted, priorUser);
      restoreMapEntry(this.subjectLifecycles, tenantKey, tenantExisted, priorTenant);
      throw error;
    }
    return { events: [clone(stagedEvent)], lastSeq: 1 };
  }
  async getSession(tenantId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s && s.tenantId === tenantId && this.isSessionVisible(sessionId) ? this.sessionForRead(s) : null;
  }
  async getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId || session.userId !== userId) return null;
    const tombstone = this.deleted.get(sessionId);
    return {
      session: this.sessionForRead(session),
      deletedAtMs: tombstone?.deletedAtMs,
      purgeAfterMs: tombstone?.purgeAfterMs,
      deletionGeneration: tombstone?.deletionGeneration ?? 0,
    };
  }
  async listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }) {
    const rows = [...this.sessions.values()].filter(
      (s) => s.tenantId === tenantId && this.isSessionVisible(s.id) && (!opts.userId || s.userId === opts.userId) && (opts.includeArchived || !s.archivedAtMs),
    ).map((session) => this.sessionForRead(session));
    return paginate(rows, (s) => s.id, opts.cursor, opts.limit, "desc");
  }

  // ---------- blob ownership manifest ----------
  async stageBlob(input: StageBlobInput): Promise<void> {
    validateStageBlobInput(input);
    const session = this.sessions.get(input.sessionId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
    ) throw new SessionGoneError(input.sessionId);
    if (!this.isSubjectActive(session.tenantId, session.userId)) throw new SessionGoneError(input.sessionId);
    if (session.archivedAtMs !== undefined) throw new SessionArchivedError(input.sessionId);
    if (input.fence < session.fenceToken) throw new FenceError(input.sessionId, input.fence, session.fenceToken);

    const existing = this.blobManifests.get(input.blobId);
    if (existing) {
      if (
        existing.state !== "staging"
        || existing.tenantId !== input.owner.tenantId
        || existing.userId !== input.owner.userId
        || existing.sessionId !== input.sessionId
        || existing.purpose !== input.purpose
        || existing.storageBackend !== input.storageBackend
        || existing.storageFormat !== input.storageFormat
        || existing.storageKey !== input.storageKey
        || existing.uploadToken !== input.uploadToken
        || existing.createdAtMs !== input.createdAtMs
        || existing.stagingExpiresAtMs !== input.stagingExpiresAtMs
      ) throw new BlobStateError(input.blobId);
    } else {
      if ([...this.blobManifests.values()].some((manifest) => manifest.storageKey === input.storageKey)) {
        throw new BlobStateError(input.blobId, "blob storage key is already owned");
      }
      const staged = clone<BlobManifest>({
        blobId: input.blobId,
        tenantId: input.owner.tenantId,
        userId: input.owner.userId,
        sessionId: input.sessionId,
        purpose: input.purpose,
        storageBackend: input.storageBackend,
        storageFormat: input.storageFormat,
        storageKey: input.storageKey,
        uploadToken: input.uploadToken,
        state: "staging",
        stagingExpiresAtMs: input.stagingExpiresAtMs,
        deletionGeneration: 0,
        createdAtMs: input.createdAtMs,
      });
      this.blobManifests.set(input.blobId, staged);
    }
    if (input.fence > session.fenceToken) session.fenceToken = input.fence;
  }

  async markBlobUploaded(input: MarkBlobUploadedInput): Promise<void> {
    validateUploadedBlobInput(input);
    const session = this.sessions.get(input.sessionId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
    ) throw new SessionGoneError(input.sessionId);
    if (!this.isSubjectActive(session.tenantId, session.userId)) throw new SessionGoneError(input.sessionId);
    if (session.archivedAtMs !== undefined) throw new SessionArchivedError(input.sessionId);
    if (input.fence < session.fenceToken) throw new FenceError(input.sessionId, input.fence, session.fenceToken);
    const manifest = this.blobManifests.get(input.blobId);
    if (
      !manifest
      || manifest.state !== "staging"
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.uploadToken !== input.uploadToken
    ) throw new BlobStateError(input.blobId);

    let staged = manifest;
    if (manifest.uploadedAtMs !== undefined) {
      if (
        manifest.sha256 !== input.sha256
        || manifest.sizeBytes !== input.sizeBytes
        || manifest.contentType !== input.contentType
      ) throw new BlobStateError(input.blobId, "uploaded blob descriptor does not match");
    } else {
      staged = clone({
        ...manifest,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        uploadedAtMs: input.uploadedAtMs,
      });
    }
    this.blobManifests.set(input.blobId, staged);
    if (input.fence > session.fenceToken) session.fenceToken = input.fence;
  }

  async getBlobManifest(blobId: string): Promise<BlobManifest | null> {
    const manifest = this.blobManifests.get(blobId);
    return manifest ? clone(manifest) : null;
  }

  async getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null> {
    const session = this.sessions.get(input.sessionId);
    const manifest = this.blobManifests.get(input.blobId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || !this.isSubjectActive(session.tenantId, session.userId)
      || session.archivedAtMs !== undefined
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
      || !manifest
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.purpose !== input.purpose
      || !isUnexpiredStagingBlob(manifest, this.storeNowMs())
      || manifest.itemId !== undefined
      || manifest.uploadedAtMs === undefined
      || manifest.sha256 === undefined
      || manifest.sizeBytes === undefined
    ) return null;
    return clone(manifest);
  }

  async getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null> {
    const session = this.sessions.get(input.sessionId);
    const manifest = this.blobManifests.get(input.blobId);
    const item = manifest?.itemId ? this.items.get(manifest.itemId) : undefined;
    if (
      !session
      || this.deleted.has(input.sessionId)
      || !this.isSubjectActive(session.tenantId, session.userId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
      || !manifest
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.state !== "ready"
      || (input.itemId !== undefined && manifest.itemId !== input.itemId)
      || (input.purpose !== undefined && manifest.purpose !== input.purpose)
      || !item
      || item.sessionId !== input.sessionId
    ) return null;
    return clone(manifest);
  }

  async commit(batch: CommitBatch): Promise<CommitResult> {
    assertPureFenceClaim(batch);
    assertTombstoneEvent(batch);
    assertCommitResourceOwnership(batch);
    assertBlobBindingsMatch(batch.items, batch.blobBindings);
    const s = this.sessions.get(batch.sessionId);
    if (!s || this.deleted.has(batch.sessionId)) throw new SessionGoneError(batch.sessionId);
    if (!this.isSubjectActive(s.tenantId, s.userId)) throw new SessionGoneError(batch.sessionId);
    const expectedOwner = batch.lifecycle ?? batch.fenceClaim;
    if (expectedOwner && (expectedOwner.tenantId !== s.tenantId || expectedOwner.userId !== s.userId)) {
      throw new SessionGoneError(batch.sessionId);
    }
    if (batch.fence < s.fenceToken) throw new FenceError(batch.sessionId, batch.fence, s.fenceToken);
    if (batch.lifecycle) {
      if (
        (batch.lifecycle.type === "archive" || batch.lifecycle.type === "tombstone")
        && s.status.type === "active"
        && batch.sessionPatch?.status?.type !== "idle"
      ) {
        throw new SessionLifecycleBusyError(batch.sessionId);
      }
    } else if (!batch.fenceClaim && s.archivedAtMs !== undefined) {
      throw new SessionArchivedError(batch.sessionId);
    }
    if (batch.expectedLastSeq !== undefined && batch.expectedLastSeq !== s.lastSeq) {
      throw new SessionVersionError(batch.sessionId, batch.expectedLastSeq, s.lastSeq);
    }

    let stagedTombstone: { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number } | undefined;
    if (batch.lifecycle?.type === "tombstone") {
      const transition = batch.lifecycle;
      const currentGeneration = this.deleted.get(batch.sessionId)?.deletionGeneration ?? 0;
      if (transition.deletionGeneration !== currentGeneration + 1) {
        throw new Error(`deletion generation must advance from ${currentGeneration} to ${currentGeneration + 1}`);
      }
      if ([...this.sessions.values()].some((candidate) => (
        candidate.parentSessionId === batch.sessionId && !this.deleted.has(candidate.id)
      ))) {
        throw new SessionHasChildrenError(batch.sessionId);
      }
      stagedTombstone = clone({
        deletedAtMs: transition.atMs,
        purgeAfterMs: transition.purgeAfterMs ?? undefined,
        deletionGeneration: transition.deletionGeneration,
      });
    }

    if (batch.fenceClaim) {
      // Clone before mutation so accessors/proxies cannot leave a half-applied claim. A claim is not
      // a business update: updatedAt, lastSeq and every projection remain byte-for-byte unchanged.
      clone(batch.fenceClaim);
      s.fenceToken = batch.fence;
      return { events: [], lastSeq: s.lastSeq };
    }

    // Primary keys are global in MySQL. Preflight the same identity constraint here so a resource
    // from another session can never be overwritten merely by presenting a forged sessionId in a
    // replacement body. Nested event snapshots participate in the same identity check.
    this.assertCommitResourceIdentities(batch);

    const stagedReadyBlobs = new Map<string, BlobManifest>();
    const readyAtMs = this.storeNowMs();
    for (const binding of batch.blobBindings ?? []) {
      const manifest = this.blobManifests.get(binding.blobId);
      if (
        !manifest
        || manifest.tenantId !== s.tenantId
        || manifest.userId !== s.userId
        || manifest.sessionId !== batch.sessionId
        || manifest.purpose !== binding.purpose
        || manifest.uploadedAtMs === undefined
        || manifest.sha256 === undefined
        || manifest.sizeBytes === undefined
      ) throw new BlobStateError(binding.blobId);
      if (manifest.state === "ready" && manifest.itemId === binding.itemId) continue;
      if (!isUnexpiredStagingBlob(manifest, readyAtMs) || manifest.itemId !== undefined) {
        throw new BlobStateError(binding.blobId);
      }
      const staged = clone({
        ...manifest,
        state: "ready" as const,
        itemId: binding.itemId,
        readyAtMs,
        stagingExpiresAtMs: undefined,
      });
      delete staged.stagingExpiresAtMs;
      stagedReadyBlobs.set(binding.blobId, staged);
    }

    // Validate every fallible invariant before mutating any map. This gives the in-memory reference
    // implementation the same all-or-nothing semantics as the MySQL transaction.
    let idemMapKey: string | undefined;
    if (batch.idempotency) {
      const receipt = batch.idempotency;
      if (receipt.scope.tenantId !== s.tenantId || receipt.scope.userId !== s.userId || receipt.scope.sessionId !== s.id) {
        throw new Error("idempotency scope does not match the session");
      }
      idemMapKey = this.idempotencyMapKey(receipt.scope, receipt.key);
      const cur = this.idem.get(idemMapKey);
      // Never replace a legacy reservation, even after its nominal expiry. An old runner may resume
      // and complete it with an unconditional update, corrupting a receipt written in its place.
      if (cur?.value === null) throw new IdempotencyPendingError(cur.expiresAt);
      if (cur && cur.expiresAt >= Date.now() && cur.value) {
        const stored: IdempotencyReceipt = { requestHash: cur.requestHash, value: clone(cur.value), expiresAtMs: cur.expiresAt };
        if (!stored.requestHash || stored.requestHash === receipt.requestHash) throw new IdempotencyReplayError(stored);
        throw new IdempotencyMismatchError(stored);
      }
    }
    const stagedUsage: UsageLedgerEntry[] = (batch.usageEntries ?? []).map((entry) => ({
      ...clone(entry), tenantId: s.tenantId, userId: s.userId, sessionId: s.id,
    }));
    const usageKeys = new Set(this.usageLedger.map((entry) => JSON.stringify([entry.sessionId, entry.turnId, entry.step])));
    const usageIds = new Set<string>();
    if (stagedUsage.length > 0) {
      for (const entry of this.usageLedger) {
        if (entry.usageId === undefined) continue;
        if (!isUsageId(entry.usageId)) throw new UsageReconciliationError("stored operational usage has an invalid usage id");
        if (usageIds.has(entry.usageId)) throw new UsageIdentityConflictError(entry.usageId);
        usageIds.add(entry.usageId);
      }
    }
    const stagedBillingFacts = new Map<string, BillingUsageFact>();
    for (const entry of stagedUsage) {
      const key = JSON.stringify([entry.sessionId, entry.turnId, entry.step]);
      if (usageKeys.has(key)) throw new Error(`duplicate usage entry for turn ${entry.turnId} step ${entry.step}`);
      usageKeys.add(key);
      if (!isUsageId(entry.usageId)) throw new Error("new usage writes require a valid random usage id");
      if (usageIds.has(entry.usageId) || this.billingUsageFacts.has(entry.usageId)) {
        throw new UsageIdentityConflictError(entry.usageId);
      }
      usageIds.add(entry.usageId);
      stagedBillingFacts.set(entry.usageId, billingUsageFactFromLedger(entry as UsageLedgerEntry & { usageId: string }));
    }

    let seq = s.lastSeq;
    const out: PersistedEvent[] = [];
    for (const e of batch.events ?? []) {
      seq += 1;
      out.push({ ...e, seq } as PersistedEvent);
    }

    // `Item.args`, tool-result `details`, and session metadata are intentionally typed as unknown.
    // Clone the entire write-set before changing persistent state so an uncloneable value cannot
    // leave a partial event log (or advance the fence without advancing lastSeq).
    let stagedEvents = out.map(clone);
    let stagedItems = (batch.items ?? []).map(clone);
    let stagedTurn = batch.turn ? clone(batch.turn) : undefined;
    const stagedApprovals = (batch.approvals ?? []).map(clone);
    const stagedIdempotencyValue = batch.idempotency ? clone(batch.idempotency.value) : undefined;
    const stagedSessionPatch = batch.sessionPatch ? clone(batch.sessionPatch) : {};
    const stagedLifecycle = batch.lifecycle ? clone(batch.lifecycle) : undefined;
    // The ledger, not a legacy caller's aggregate JSON, is authoritative. Do this before publishing
    // any map mutation so a mixed-version writer cannot make a known subtotal sticky in a later
    // current-writer commit.
    const projectionRows = [...this.usageProjectionRows(s.id), ...stagedUsage];
    stagedSessionPatch.usage = canonicalUsageProjection(
      stagedSessionPatch.usage ?? s.usage,
      projectionRows,
      { tenantId: s.tenantId, userId: s.userId },
    );
    if (stagedTurn) {
      stagedTurn = {
        ...stagedTurn,
        usage: canonicalUsageProjection(
          stagedTurn.usage,
          projectionRows.filter((row) => row.turnId === stagedTurn!.id),
          { tenantId: s.tenantId, userId: s.userId },
        ),
      };
    }
    stagedItems = stagedItems.map((item) => canonicalizeUsageItem(
      item,
      projectionRows.find((row) => (
        row.turnId === item.turnId && row.step === 0
        && row.tenantId === s.tenantId && row.userId === s.userId
      )),
    ));
    stagedEvents = stagedEvents.map((event) => canonicalizePersistedUsageEvent(
      event,
      projectionRows,
      { tenantId: s.tenantId, userId: s.userId },
    ));
    assignItemSeqs(stagedItems, stagedEvents, seq);
    assignTurnSeqEnd(stagedTurn, stagedEvents, seq);
    const resultEvents = stagedEvents.map(clone);
    const stagedOutboxes: [string, LifecycleOutboxRecord][] = [];
    if (stagedLifecycle?.type === "tombstone") {
      const deletedEvent = stagedEvents.at(-1);
      if (deletedEvent?.type !== "session/deleted") throw new Error("tombstone event was not assigned a sequence");
      const outboxes: LifecycleOutboxRecord[] = ([
        {
          outboxId: this.nextLifecycleOutboxId,
          topic: "session.tombstoned",
          aggregateId: batch.sessionId,
          generation: stagedLifecycle.deletionGeneration,
          payload: {
            sessionId: batch.sessionId,
            deletionGeneration: stagedLifecycle.deletionGeneration,
            eventSeq: deletedEvent.seq,
          },
          availableAtMs: stagedLifecycle.atMs,
          attempts: 0,
          createdAtMs: stagedLifecycle.atMs,
        },
        {
          outboxId: this.nextLifecycleOutboxId + 1,
          topic: "session.purge",
          aggregateId: batch.sessionId,
          generation: stagedLifecycle.deletionGeneration,
          payload: { sessionId: batch.sessionId, deletionGeneration: stagedLifecycle.deletionGeneration },
          attempts: 0,
          createdAtMs: stagedLifecycle.atMs,
        },
      ] satisfies LifecycleOutboxRecord[]).map((outbox) => clone(outbox));
      for (const outbox of outboxes) {
        const key = this.lifecycleOutboxMapKey(outbox.topic, outbox.aggregateId, outbox.generation);
        if (this.lifecycleOutbox.has(key) || stagedOutboxes.some(([candidate]) => candidate === key)) {
          throw new Error("lifecycle outbox identity already exists");
        }
        stagedOutboxes.push([key, outbox]);
      }
    }

    // This mutates only caller-owned projections. Perform it before publishing the staged store
    // state so a frozen/proxy input cannot leave a partially committed in-memory transaction.
    backfillAssignedSequences(batch, { items: stagedItems, turn: stagedTurn, events: stagedEvents });
    s.fenceToken = batch.fence;
    const log = this.events.get(batch.sessionId)!;
    log.push(...stagedEvents);
    s.lastSeq = seq;
    for (const it of stagedItems) this.items.set(it.id, it);
    for (const [blobId, manifest] of stagedReadyBlobs) this.blobManifests.set(blobId, manifest);
    if (stagedTurn) this.turns.set(stagedTurn.id, stagedTurn);
    for (const a of stagedApprovals) this.approvals.set(a.id, a);
    this.usageLedger.push(...stagedUsage);
    for (const [usageId, fact] of stagedBillingFacts) this.billingUsageFacts.set(usageId, fact);
    if (batch.idempotency && idemMapKey && stagedIdempotencyValue) {
      this.idem.set(idemMapKey, {
        value: stagedIdempotencyValue,
        requestHash: batch.idempotency.requestHash,
        expiresAt: batch.idempotency.expiresAtMs,
      });
    }
    if (stagedSessionPatch) Object.assign(s, stagedSessionPatch);
    if (stagedLifecycle?.type === "archive") s.archivedAtMs = stagedLifecycle.atMs;
    else if (stagedLifecycle?.type === "unarchive") delete s.archivedAtMs;
    else if (stagedLifecycle?.type === "tombstone" && stagedTombstone) {
      this.deleted.set(batch.sessionId, stagedTombstone);
      for (const [key, outbox] of stagedOutboxes) this.lifecycleOutbox.set(key, outbox);
      this.nextLifecycleOutboxId += stagedOutboxes.length;
    }
    s.updatedAtMs = Date.now();
    return {
      events: resultEvents,
      lastSeq: seq,
      lifecycleGeneration: stagedLifecycle?.type === "tombstone" ? stagedLifecycle.deletionGeneration : undefined,
    };
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    // Deliberately raw: an already-established SSE subscription must be able to deliver the final
    // session/deleted event. Public subscription setup performs an owner-aware session check first.
    const session = this.sessions.get(sessionId);
    const rows = this.usageProjectionRows(sessionId);
    return (this.events.get(sessionId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit)
      .map((event) => session
        ? canonicalizePersistedUsageEvent(clone(event), rows, session)
        : clone(event));
  }
  async getTurn(sessionId: string, turnId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const session = this.sessions.get(sessionId)!;
    const t = this.turns.get(turnId);
    return t && t.sessionId === sessionId ? this.turnForRead(t, session) : null;
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }) {
    if (!this.isSessionVisible(sessionId)) return { data: [], nextCursor: null };
    const session = this.sessions.get(sessionId)!;
    const rows = [...this.turns.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((turn) => this.turnForRead(turn, session));
    return paginate(rows, (t) => t.id, opts.cursor, opts.limit, opts.sortDirection ?? "desc");
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    if (!this.isSessionVisible(sessionId)) return [];
    const session = this.sessions.get(sessionId)!;
    const all = [...this.items.values()]
      .filter((i) => i.sessionId === sessionId && (!opts.turnId || i.turnId === opts.turnId) && i.seq > (opts.afterSeq ?? -1))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    const kept = opts.newestFirst ? all.slice(Math.max(0, all.length - opts.limit)) : all.slice(0, opts.limit);
    const projectionRows = this.usageProjectionRows(sessionId);
    return kept.map((item) => canonicalizeUsageItem(
      clone(item),
      projectionRows.find((row) => (
        row.turnId === item.turnId && row.step === 0
        && row.tenantId === session.tenantId && row.userId === session.userId
      )),
    ));
  }
  async getItem(sessionId: string, itemId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const session = this.sessions.get(sessionId)!;
    const i = this.items.get(itemId);
    return i && i.sessionId === sessionId
      ? canonicalizeUsageItem(
        clone(i),
        this.usageProjectionRows(sessionId, i.turnId).find((row) => (
          row.step === 0 && row.tenantId === session.tenantId && row.userId === session.userId
        )),
      )
      : null;
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    if (!this.isSessionVisible(sessionId)) return [];
    return [...this.approvals.values()]
      .filter((a) => a.sessionId === sessionId && (!opts.pendingOnly || a.status === "pending"))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(clone);
  }
  async getApproval(sessionId: string, approvalId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const a = this.approvals.get(approvalId);
    return a && a.sessionId === sessionId ? clone(a) : null;
  }

  async upsertProviderConfig(cfg: ProviderConfig, secret?: { ciphertext: Buffer; keyId: string }) {
    const stagedConfig = clone(cfg);
    this.assertTenantWritable(stagedConfig.tenantId);
    const key = providerConfigKey(stagedConfig.tenantId, stagedConfig.id);
    const prev = this.providers.get(key);
    this.providers.set(key, { config: stagedConfig, secret: secret ?? prev?.secret });
  }
  async getProviderConfig(tenantId: string, providerId: string) {
    if (!this.isTenantActive(tenantId)) return null;
    const p = this.providers.get(providerConfigKey(tenantId, providerId));
    return p ? { config: clone(p.config), secret: p.secret } : null;
  }
  async listProviderConfigs(tenantId: string) {
    if (!this.isTenantActive(tenantId)) return [];
    return [...this.providers.values()].filter((p) => p.config.tenantId === tenantId).map((p) => clone(p.config));
  }
  async deleteProviderConfig(tenantId: string, providerId: string) {
    this.assertTenantWritable(tenantId);
    return this.providers.delete(providerConfigKey(tenantId, providerId));
  }

  async resolveApiKey(hashedKey: string) {
    const k = this.apiKeys.get(hashedKey);
    return k && !k.revokedAtMs && this.isTenantActive(k.tenantId)
      ? { tenantId: k.tenantId, keyId: k.keyId, scopes: [...k.scopes] }
      : null;
  }
  async createApiKey(tenantId: string, keyId: string, hashedKey: string, scopes: ApiKeyScope[] = DEFAULT_SCOPES) {
    const stagedScopes = clone(scopes);
    this.assertTenantWritable(tenantId);
    // Match MySQL INSERT IGNORE semantics: a digest is permanently owned by its first row and
    // must never be transferred across tenants by a colliding/replayed bootstrap write.
    if (this.apiKeys.has(hashedKey)) return;
    const now = Date.now();
    const tenantExisted = this.tenants.has(tenantId);
    const priorTenant = this.tenants.get(tenantId);
    try {
      if (!tenantExisted) {
        this.tenants.set(tenantId, {
          tenantId,
          authPolicy: DEFAULT_AUTH_POLICY,
          createdAtMs: now,
        });
      }
      this.apiKeys.set(hashedKey, {
        tenantId,
        keyId,
        scopes: stagedScopes,
        createdAtMs: now,
      });
    } catch (error) {
      restoreMapEntry(this.tenants, tenantId, tenantExisted, priorTenant);
      Map.prototype.delete.call(this.apiKeys, hashedKey);
      throw error;
    }
  }
  async listApiKeys(tenantId: string) {
    if (!this.isTenantActive(tenantId)) return [];
    return [...this.apiKeys.entries()]
      .filter(([, v]) => v.tenantId === tenantId)
      .map(([, v]) => ({ keyId: v.keyId, tenantId: v.tenantId, scopes: [...v.scopes], createdAtMs: v.createdAtMs ?? 0, revokedAtMs: v.revokedAtMs }));
  }
  async revokeApiKey(tenantId: string, keyId: string) {
    this.assertTenantWritable(tenantId);
    for (const [hash, v] of this.apiKeys) {
      if (v.tenantId === tenantId && v.keyId === keyId && !v.revokedAtMs) {
        this.apiKeys.set(hash, { ...v, revokedAtMs: Date.now() });
        return true;
      }
    }
    return false;
  }

  async getTenant(tenantId: string) {
    if (!this.isTenantActive(tenantId)) return null;
    const t = this.tenants.get(tenantId);
    if (!t) return null;
    if (t.authPolicy === undefined) throw new Error("active tenant auth policy is missing");
    const record: TenantRecord = {
      tenantId: t.tenantId,
      ...(t.name === undefined ? {} : { name: t.name }),
      authPolicy: clone(t.authPolicy),
      ...(t.authSecret === undefined ? {} : { authSecret: t.authSecret }),
      createdAtMs: t.createdAtMs,
    };
    return record;
  }
  async setTenantAuth(tenantId: string, policy: TenantAuthPolicy, secret?: { ciphertext: Buffer; keyId: string } | null) {
    const stagedPolicy = clone(policy);
    this.assertTenantWritable(tenantId);
    const prev = this.tenants.get(tenantId);
    this.tenants.set(tenantId, {
      tenantId,
      name: prev?.name,
      authPolicy: stagedPolicy,
      authSecret: secret === null ? undefined : (secret ?? prev?.authSecret),
      createdAtMs: prev?.createdAtMs ?? Date.now(),
    });
  }

  usageLedger: UsageLedgerEntry[] = [];
  async queryUsage(tenantId: string, q: UsageQuery) {
    const rows = this.usageLedger.filter((e) => {
      const session = this.sessions.get(e.sessionId);
      return e.tenantId === tenantId
        && session?.tenantId === e.tenantId
        && session.userId === e.userId
        && this.isSessionVisible(e.sessionId)
        && (!q.userId || e.userId === q.userId)
        && (!q.sessionId || e.sessionId === q.sessionId)
        && (q.from === undefined || e.createdAtMs >= q.from)
        && (q.to === undefined || e.createdAtMs < q.to);
    });
    const keyOf = (e: UsageLedgerEntry) =>
      q.groupBy === "user" ? e.userId
      : q.groupBy === "session" ? e.sessionId
      : q.groupBy === "model" ? `${e.provider}/${e.model}`
      : q.groupBy === "day" ? new Date(e.createdAtMs).toISOString().slice(0, 10)
      : "total";
    const acc = new Map<string, { turns: Set<string>; steps: number; usage: Usage }>();
    for (const e of rows) {
      const k = keyOf(e);
      const cur = acc.get(k) ?? { turns: new Set<string>(), steps: 0, usage: emptyUsageAccumulator() };
      cur.turns.add(e.turnId);
      cur.steps += 1;
      cur.usage = addUsage(cur.usage, normalizeOperationalUsageCost(e.usage, e.usageId));
      acc.set(k, cur);
    }
    return {
      data: [...acc.entries()]
        .map(([key, v]) => ({ key, turns: v.turns.size, steps: v.steps, usage: v.usage }))
        .sort((a, b) => (b.usage.totalTokens - a.usage.totalTokens) || a.key.localeCompare(b.key))
        .slice(0, q.limit),
    };
  }

  private usageReconciliationMapKey(sessionId: string, deletionGeneration: number): string {
    return JSON.stringify([sessionId, deletionGeneration]);
  }

  private assertUsageLifecycleScope(input: ReconcileSessionUsageInput): void {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.userId !== input.userId) {
      // Preserve the same non-oracle owner semantics as every public session resource. Although this
      // is an internal least-privilege interface, a scoped worker must not probe another principal.
      throw new SessionGoneError(input.sessionId);
    }
    const tombstone = this.deleted.get(input.sessionId);
    if (
      !tombstone
      || input.deletionGeneration <= 0
      || tombstone.deletionGeneration !== input.deletionGeneration
    ) {
      throw new UsageLifecycleGenerationError(input.sessionId, input.deletionGeneration);
    }
  }

  private usageRowsForLifecycle(
    ledger: readonly UsageLedgerEntry[],
    input: ReconcileSessionUsageInput,
  ): UsageLedgerEntry[] {
    const rows = ledger.filter((entry) => entry.sessionId === input.sessionId);
    if (rows.some((entry) => entry.tenantId !== input.tenantId || entry.userId !== input.userId)) {
      throw new UsageReconciliationError("operational usage owner does not match its session");
    }
    return rows;
  }

  /** The destructive input has no caller `legalHold: false`; only durable store state decides. */
  protected isUsageAnonymizationLegalHoldActive(input: AnonymizeSessionUsageInput): boolean {
    const tenant = this.subjectRecord(input.tenantId, "tenant", input.tenantId);
    const user = this.subjectRecord(input.tenantId, "user", input.userId);
    if (!tenant || !user) {
      throw new UsageReconciliationError("subject lifecycle state is missing; anonymization is fail-closed");
    }
    const tenantHolds = this.assertLegalHoldState(input.tenantId, "tenant", input.tenantId);
    const userHolds = this.assertLegalHoldState(input.tenantId, "user", input.userId);
    return tenantHolds.control.activeHoldCount > 0 || userHolds.control.activeHoldCount > 0;
  }

  async reconcileSessionUsage(input: ReconcileSessionUsageInput): Promise<UsageReconciliationRecord> {
    const stagedInput = clone(input);
    validateReconcileSessionUsageInput(stagedInput);
    return this.reconcileSessionUsageAtomically(stagedInput);
  }

  async reconcileErasureSessionUsage(
    authorization: ErasureWriteAuthorization,
    input: ErasureUsageReconciliationInput,
  ): Promise<UsageReconciliationRecord> {
    // Clone before consulting authority so caller accessors/proxies cannot mutate an identity
    // between the claim check and publication. This method and the helper below contain no await:
    // in the single-process Memory store they form one indivisible synchronous critical section.
    const stagedAuthorization = clone(authorization);
    const stagedInput = clone(input);
    validateErasureUsageReconciliationInput(stagedAuthorization, stagedInput);
    this.assertErasureSessionAuthority(
      stagedAuthorization,
      ["reconciling_usage"],
      stagedInput.nowMs,
    );
    const proofSession = this.sessions.get(stagedInput.sessionId);
    const proofTombstone = this.deleted.get(stagedInput.sessionId);
    if (
      !proofSession
      || proofSession.tenantId !== stagedAuthorization.tenantId
      || proofSession.userId !== stagedAuthorization.userId
      || !proofTombstone
      || proofTombstone.deletionGeneration !== stagedInput.deletionGeneration
      || !this.erasureTombstoneProofValid(proofSession, proofTombstone)
    ) {
      throw new ErasureTombstoneIntegrityError();
    }
    return this.reconcileSessionUsageAtomically({
      tenantId: stagedAuthorization.tenantId,
      userId: stagedAuthorization.userId,
      sessionId: stagedInput.sessionId,
      deletionGeneration: stagedInput.deletionGeneration,
      nowMs: stagedInput.nowMs,
    });
  }

  private reconcileSessionUsageAtomically(
    input: ReconcileSessionUsageInput,
  ): UsageReconciliationRecord {
    validateReconcileSessionUsageInput(input);
    this.assertUsageLifecycleScope(input);
    const reconciliationKey = this.usageReconciliationMapKey(input.sessionId, input.deletionGeneration);
    const existingRecord = this.usageReconciliations.get(reconciliationKey);
    if (existingRecord?.status === "anonymized") {
      if (this.usageRowsForLifecycle(this.usageLedger, input).length > 0) {
        throw new UsageReconciliationError("operational usage reappeared after anonymization");
      }
      return clone(existingRecord);
    }

    // Clone the complete ledger so assigning ids to legacy NULL rows cannot become visible until
    // every row and pre-existing billing fact passes conflict and checksum verification.
    const stagedLedger = this.usageLedger.map(clone);
    const targetRows = this.usageRowsForLifecycle(stagedLedger, input);
    const reservedUsageIds = new Set<string>();
    for (const entry of stagedLedger) {
      if (entry.usageId === undefined) continue;
      if (!isUsageId(entry.usageId)) {
        throw new UsageReconciliationError("stored operational usage has an invalid usage id");
      }
      if (reservedUsageIds.has(entry.usageId)) throw new UsageIdentityConflictError(entry.usageId);
      reservedUsageIds.add(entry.usageId);
    }
    for (const usageId of this.billingUsageFacts.keys()) reservedUsageIds.add(usageId);

    for (const entry of targetRows) {
      if (entry.usageId !== undefined) continue;
      // Pre-0011 Pi used numeric zero when price metadata was unavailable. Remove that ambiguous
      // encoding before assigning an id, otherwise the same row would become spuriously "known"
      // immediately after a successful reconciliation.
      entry.usage = normalizeOperationalUsageCost(entry.usage, undefined);
      let allocated: string | undefined;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = newUsageId();
        if (!reservedUsageIds.has(candidate)) {
          allocated = candidate;
          break;
        }
      }
      if (!allocated) throw new UsageReconciliationError("could not allocate a unique usage id");
      entry.usageId = allocated;
      reservedUsageIds.add(allocated);
    }

    const stagedNewFacts = new Map<string, BillingUsageFact>();
    const expectedFacts: BillingUsageFact[] = [];
    const verifiedFacts: BillingUsageFact[] = [];
    const targetIds = new Set<string>();
    for (const entry of targetRows) {
      if (!entry.usageId || targetIds.has(entry.usageId)) {
        throw new UsageIdentityConflictError(entry.usageId ?? "missing");
      }
      targetIds.add(entry.usageId);
      const expected = billingUsageFactFromLedger({
        ...entry,
        usage: normalizeOperationalUsageCost(entry.usage, entry.usageId),
      } as UsageLedgerEntry & { usageId: string });
      expectedFacts.push(expected);
      const existingFact = this.billingUsageFacts.get(entry.usageId);
      if (existingFact) {
        if (!billingUsageFactContentEquals(existingFact, expected)) {
          throw new UsageIdentityConflictError(entry.usageId);
        }
        verifiedFacts.push(clone(existingFact));
      } else {
        stagedNewFacts.set(entry.usageId, expected);
        verifiedFacts.push(expected);
      }
    }

    const expectedSummary = summarizeBillingUsageFacts(expectedFacts);
    const verifiedSummary = summarizeBillingUsageFacts(verifiedFacts);
    if (!usageReconciliationSummariesEqual(expectedSummary, verifiedSummary)) {
      throw new UsageReconciliationError();
    }
    if (existingRecord && !usageReconciliationSummariesEqual(existingRecord, verifiedSummary)) {
      throw new UsageReconciliationError("verified usage changed after its first reconciliation");
    }

    const record = clone<UsageReconciliationRecord>(existingRecord ?? {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      deletionGeneration: input.deletionGeneration,
      status: "verified",
      ...verifiedSummary,
      verifiedAtMs: input.nowMs,
    });
    if (
      record.tenantId !== input.tenantId
      || record.userId !== input.userId
      || record.sessionId !== input.sessionId
      || record.deletionGeneration !== input.deletionGeneration
      || record.status !== "verified"
    ) throw new UsageReconciliationError("usage reconciliation identity changed");

    this.usageLedger = stagedLedger;
    for (const [usageId, fact] of stagedNewFacts) this.billingUsageFacts.set(usageId, clone(fact));
    this.usageReconciliations.set(reconciliationKey, record);
    return clone(record);
  }

  async anonymizeSessionUsage(input: AnonymizeSessionUsageInput): Promise<UsageReconciliationRecord> {
    // Validate the explicit destructive gate without consulting owner-scoped state first. A caller
    // must not be able to distinguish another subject's legal hold from a nonexistent session.
    assertUsageAnonymizationAllowed(input, false);
    this.assertUsageLifecycleScope(input);
    const reconciliationKey = this.usageReconciliationMapKey(input.sessionId, input.deletionGeneration);
    const record = this.usageReconciliations.get(reconciliationKey);
    if (!record) throw new UsageReconciliationError("usage must be reconciled before anonymization");
    if (
      record.tenantId !== input.tenantId
      || record.userId !== input.userId
      || record.sessionId !== input.sessionId
      || record.deletionGeneration !== input.deletionGeneration
    ) throw new SessionGoneError(input.sessionId);
    if (record.checksum !== input.expectedChecksum) {
      throw new UsageReconciliationError("expected reconciliation checksum does not match");
    }
    // Resolve the durable lifecycle rows before the idempotent fast path so missing state still
    // fails closed. A hold installed after anonymization committed cannot undo that deletion and
    // must not turn a lost-response retry into a permanently blocked job.
    const legalHoldActive = this.isUsageAnonymizationLegalHoldActive(input);
    const targetRows = this.usageRowsForLifecycle(this.usageLedger, input);
    if (record.status === "anonymized") {
      if (targetRows.length !== 0) throw new UsageReconciliationError("operational usage reappeared after anonymization");
      return clone(record);
    }
    assertUsageAnonymizationAllowed(input, legalHoldActive);
    if (input.nowMs < record.verifiedAtMs) {
      throw new UsageReconciliationError("anonymization cannot precede verification");
    }

    const verifiedFacts: BillingUsageFact[] = [];
    for (const entry of targetRows) {
      if (!entry.usageId || !isUsageId(entry.usageId)) {
        throw new UsageReconciliationError("operational usage was not fully assigned before anonymization");
      }
      const existingFact = this.billingUsageFacts.get(entry.usageId);
      if (!existingFact) throw new UsageReconciliationError("a reconciled billing fact is missing");
      const expectedFact = billingUsageFactFromLedger(
        {
          ...entry,
          usage: normalizeHistoricalUsageCost(entry.usage),
        } as UsageLedgerEntry & { usageId: string },
      );
      if (!billingUsageFactContentEquals(existingFact, expectedFact)) {
        throw new UsageIdentityConflictError(entry.usageId);
      }
      verifiedFacts.push(existingFact);
    }
    const currentSummary = summarizeBillingUsageFacts(verifiedFacts);
    if (!usageReconciliationSummariesEqual(record, currentSummary)) {
      throw new UsageReconciliationError("operational usage changed after verification");
    }

    const remainingLedger = this.usageLedger.filter((entry) => !(
      entry.tenantId === input.tenantId
      && entry.userId === input.userId
      && entry.sessionId === input.sessionId
    ));
    const anonymized = clone<UsageReconciliationRecord>({
      ...record,
      status: "anonymized",
      anonymizedAtMs: input.nowMs,
    });
    this.usageLedger = remainingLedger;
    this.usageReconciliations.set(reconciliationKey, anonymized);
    return clone(anonymized);
  }

  private assertCommitResourceIdentities(batch: CommitBatch): void {
    const itemIdentities = new Map<string, string>();
    const turnIdentities = new Map<string, string>();
    const approvalIdentities = new Map<string, string>();
    const observe = (
      identities: Map<string, string>,
      id: string,
      identity: string,
      kind: "item" | "turn" | "approval",
    ) => {
      const previous = identities.get(id);
      if (previous !== undefined && previous !== identity) {
        throw new Error(`${kind} identity conflicts with another resource`);
      }
      identities.set(id, identity);
    };
    const observeItem = (item: Item) => {
      observe(itemIdentities, item.id, JSON.stringify([item.sessionId, item.turnId, item.type]), "item");
    };
    const observeTurn = (turn: Turn) => {
      observe(turnIdentities, turn.id, turn.sessionId, "turn");
    };
    const observeApproval = (approval: Approval) => {
      observe(
        approvalIdentities,
        approval.id,
        JSON.stringify([approval.sessionId, approval.turnId, approval.itemId, approval.toolCallId]),
        "approval",
      );
    };

    for (const item of this.items.values()) observeItem(item);
    for (const turn of this.turns.values()) observeTurn(turn);
    for (const approval of this.approvals.values()) observeApproval(approval);
    for (const item of batch.items ?? []) observeItem(item);
    if (batch.turn) observeTurn(batch.turn);
    const approvalIds = new Set<string>();
    for (const approval of batch.approvals ?? []) {
      if (approvalIds.has(approval.id)) throw new Error("commit contains the same approval more than once");
      approvalIds.add(approval.id);
      observeApproval(approval);
    }
    for (const event of batch.events ?? []) {
      if ("item" in event) observeItem(event.item);
      if ("turn" in event) observeTurn(event.turn);
      if ("approval" in event) observeApproval(event.approval);
    }
  }

  private idempotencyMapKey(scope: IdempotencyScope, key: string) {
    // JSON encoding keeps the tuple unambiguous even when an opaque client key contains separators.
    return JSON.stringify([scope.tenantId, scope.userId, scope.sessionId, key]);
  }

  async getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null> {
    if (!this.isSessionVisible(scope.sessionId)) return null;
    const k = this.idempotencyMapKey(scope, key);
    const cur = this.idem.get(k);
    if (!cur || cur.expiresAt < Date.now() || !cur.value) return null;
    return { requestHash: cur.requestHash, value: clone(cur.value), expiresAtMs: cur.expiresAt };
  }

  // ---------- blob staging sweeper + delete outbox ----------
  private blobDeleteOutboxMapKey(blobId: string, generation: number): string {
    return JSON.stringify([blobId, generation]);
  }

  private findBlobDeleteOutboxById(outboxId: number): [string, BlobDeleteOutboxRecord] | undefined {
    for (const entry of this.blobDeleteOutbox.entries()) {
      if (entry[1].outboxId === outboxId) return entry;
    }
    return undefined;
  }

  private hydrateBlobDeleteOutbox(
    row: BlobDeleteOutboxRecord,
    requirePending = true,
  ): BlobDeleteOutboxRecord {
    const manifest = this.blobManifests.get(row.blobId);
    if (!Number.isSafeInteger(row.outboxId) || row.outboxId < 1) {
      throw new Error("invalid blob delete outbox id");
    }
    if (
      !manifest
      || manifest.deletionGeneration !== row.generation
      || (requirePending
        ? manifest.state !== "delete_pending"
        : manifest.state !== "delete_pending" && manifest.state !== "deleted")
      || !manifest.uploadToken
    ) throw new Error(`blob delete outbox ${row.outboxId} does not match its manifest state`);
    return {
      ...clone(row),
      storageBackend: manifest.storageBackend,
      storageFormat: manifest.storageFormat,
      storageKey: manifest.storageKey,
      uploadToken: manifest.uploadToken,
    };
  }

  async scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number> {
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) throw new Error("invalid blob sweep timestamp");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("blob sweep limit must be between 1 and 100");
    }
    const candidates = [...this.blobManifests.values()]
      .filter((manifest) => (
        manifest.state === "staging"
        && manifest.stagingExpiresAtMs !== undefined
        && manifest.stagingExpiresAtMs <= options.nowMs
      ))
      .sort((left, right) => (
        left.stagingExpiresAtMs! - right.stagingExpiresAtMs!
        || left.blobId.localeCompare(right.blobId)
      ))
      .slice(0, options.limit);

    const manifests = new Map<string, BlobManifest>();
    const outboxes = new Map<string, BlobDeleteOutboxRecord>();
    for (const [index, manifest] of candidates.entries()) {
      const generation = manifest.deletionGeneration + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("blob deletion generation overflow");
      const key = this.blobDeleteOutboxMapKey(manifest.blobId, generation);
      if (this.blobDeleteOutbox.has(key) || outboxes.has(key)) {
        throw new Error("blob delete outbox identity already exists");
      }
      const pending = clone({
        ...manifest,
        state: "delete_pending" as const,
        deleteAfterMs: options.nowMs,
        deletionGeneration: generation,
        stagingExpiresAtMs: undefined,
      });
      delete pending.stagingExpiresAtMs;
      const outbox = clone<BlobDeleteOutboxRecord>({
        outboxId: this.nextBlobDeleteOutboxId + index,
        blobId: manifest.blobId,
        generation,
        storageBackend: manifest.storageBackend,
        storageFormat: manifest.storageFormat,
        storageKey: manifest.storageKey,
        uploadToken: manifest.uploadToken,
        availableAtMs: options.nowMs,
        attempts: 0,
        createdAtMs: options.nowMs,
      });
      manifests.set(manifest.blobId, pending);
      outboxes.set(key, outbox);
    }

    for (const [blobId, manifest] of manifests) this.blobManifests.set(blobId, manifest);
    for (const [key, outbox] of outboxes) this.blobDeleteOutbox.set(key, outbox);
    this.nextBlobDeleteOutboxId += outboxes.size;
    return candidates.length;
  }

  async claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]> {
    const leaseUntilMs = validateBlobDeleteClaim(options);
    const candidates = [...this.blobDeleteOutbox.entries()]
      .filter(([, row]) => (
        row.availableAtMs <= options.nowMs
        && row.completedAtMs === undefined
        && row.deadLetteredAtMs === undefined
        && (row.claimToken === undefined || (row.leaseUntilMs !== undefined && row.leaseUntilMs <= options.nowMs))
      ))
      .sort((left, right) => (
        left[1].availableAtMs - right[1].availableAtMs
        || left[1].outboxId - right[1].outboxId
      ))
      .slice(0, options.limit);
    const staged = new Map<string, BlobDeleteOutboxRecord>();
    const claimed: BlobDeleteOutboxRecord[] = [];
    for (const [key, row] of candidates) {
      try {
        const hydrated = this.hydrateBlobDeleteOutbox(row);
        const next = clone({
          ...hydrated,
          attempts: hydrated.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        });
        staged.set(key, next);
        claimed.push(next);
      } catch {
        const poison = clone(row);
        poison.attempts += 1;
        poison.lastError = "invalid blob delete outbox identity";
        poison.deadLetteredAtMs = options.nowMs;
        delete poison.claimToken;
        delete poison.leaseUntilMs;
        staged.set(key, poison);
      }
    }
    for (const [key, row] of staged) this.blobDeleteOutbox.set(key, row);
    return claimed.map(clone);
  }

  async renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: import("./blob-lifecycle.js").RenewBlobDeleteClaimOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.nowMs);
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
      throw new Error("invalid blob delete lease duration");
    }
    const leaseUntilMs = options.nowMs + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("invalid blob delete lease expiry");
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.nowMs
    ) return false;
    row.leaseUntilMs = Math.max(row.leaseUntilMs, leaseUntilMs);
    return true;
  }

  async completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, completedAtMs);
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= completedAtMs
    ) return false;
    const manifest = this.blobManifests.get(row.blobId);
    if (!manifest || manifest.state !== "delete_pending" || manifest.deletionGeneration !== row.generation) {
      throw new BlobStateError(row.blobId);
    }
    const completedManifest = clone({
      ...manifest,
      state: "deleted" as const,
      deletedAtMs: completedAtMs,
    });
    delete completedManifest.sha256;
    delete completedManifest.sizeBytes;
    delete completedManifest.contentType;
    delete completedManifest.uploadedAtMs;
    delete completedManifest.readyAtMs;
    delete completedManifest.deleteAfterMs;
    const completedOutbox = clone({ ...row, completedAtMs });
    delete completedOutbox.claimToken;
    delete completedOutbox.leaseUntilMs;
    delete completedOutbox.lastError;
    this.blobManifests.set(row.blobId, completedManifest);
    this.blobDeleteOutbox.set(entry[0], completedOutbox);
    return true;
  }

  async retryBlobDelete(
    outboxId: number,
    claimToken: string,
    options: RetryBlobDeleteOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.failedAtMs);
    if (!Number.isSafeInteger(options.availableAtMs) || options.availableAtMs < options.failedAtMs) {
      throw new Error("blob delete retry must not move backwards");
    }
    if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new Error("blob delete maxAttempts must be positive");
    }
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.failedAtMs
    ) return false;
    const retried = clone(row);
    retried.lastError = sanitizeBlobDeleteError(options.error);
    delete retried.claimToken;
    delete retried.leaseUntilMs;
    if (options.maxAttempts !== undefined && retried.attempts >= options.maxAttempts) {
      retried.deadLetteredAtMs = options.failedAtMs;
    } else {
      retried.availableAtMs = options.availableAtMs;
    }
    this.blobDeleteOutbox.set(entry[0], retried);
    return true;
  }

  async getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null> {
    const row = this.blobDeleteOutbox.get(this.blobDeleteOutboxMapKey(blobId, generation));
    return row ? this.hydrateBlobDeleteOutbox(row, false) : null;
  }

  // ---------- user data export ----------
  private userDataExportNow(): number {
    const now = this.storeNowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid data export clock");
    return now;
  }

  private userDataExportPartKey(artifactId: string, partNumber: number): string {
    return JSON.stringify([artifactId, partNumber]);
  }

  private userDataExportDeleteKey(
    artifactId: string,
    partNumber: number,
    deletionGeneration: number,
  ): string {
    return JSON.stringify([artifactId, partNumber, deletionGeneration]);
  }

  private userDataExportDownloadLeaseKey(artifactId: string, leaseToken: string): string {
    return JSON.stringify([artifactId, leaseToken]);
  }

  private userDataExportIdempotencyKeyFor(input: Pick<
    RequestUserDataExportInput,
    "tenantId" | "userId" | "idempotencyKeySha256"
  >): string {
    return JSON.stringify([input.tenantId, input.userId, input.idempotencyKeySha256]);
  }

  private captureUserDataExportState() {
    const copy = <K, V>(map: Map<K, V>) => new Map(
      [...map].map(([key, value]) => [key, clone(value)] as const),
    );
    return {
      requests: copy(this.userDataExportRequests),
      jobs: copy(this.userDataExportJobs),
      artifacts: copy(this.userDataExportArtifacts),
      parts: copy(this.userDataExportParts),
      snapshotRecords: new Map(
        [...this.userDataExportSnapshotRecords].map(([key, records]) => [
          key,
          records.map(cloneUserDataExportSnapshotRecord),
        ] as const),
      ),
      snapshotBlobs: copy(this.userDataExportSnapshotBlobs),
      deleteOutbox: copy(this.userDataExportDeleteOutbox),
      downloadLeases: copy(this.userDataExportDownloadLeases),
      idempotency: copy(this.userDataExportIdempotency),
      nextDeleteOutboxId: this.nextUserDataExportDeleteOutboxId,
    };
  }

  private restoreUserDataExportState(state: ReturnType<MemorySessionStore["captureUserDataExportState"]>): void {
    restoreMapSnapshot(this.userDataExportRequests, state.requests);
    restoreMapSnapshot(this.userDataExportJobs, state.jobs);
    restoreMapSnapshot(this.userDataExportArtifacts, state.artifacts);
    restoreMapSnapshot(this.userDataExportParts, state.parts);
    restoreMapSnapshot(this.userDataExportSnapshotRecords, state.snapshotRecords);
    restoreMapSnapshot(this.userDataExportSnapshotBlobs, state.snapshotBlobs);
    restoreMapSnapshot(this.userDataExportDeleteOutbox, state.deleteOutbox);
    restoreMapSnapshot(this.userDataExportDownloadLeases, state.downloadLeases);
    restoreMapSnapshot(this.userDataExportIdempotency, state.idempotency);
    this.nextUserDataExportDeleteOutboxId = state.nextDeleteOutboxId;
  }

  private releaseUserDataExportSnapshot(requestId: string, buildGeneration: number, atMs: number): void {
    this.userDataExportSnapshotRecords.delete(requestId);
    const blobs = this.userDataExportSnapshotBlobs.get(requestId);
    if (blobs) {
      this.userDataExportSnapshotBlobs.set(
        requestId,
        blobs.map((blob) => (
          blob.buildGeneration === buildGeneration && blob.releasedAtMs === undefined
            ? { ...blob, releasedAtMs: atMs }
            : blob
        )),
      );
    }
  }

  private transitionUserDataExportArtifactToDeletePending(
    artifactId: string,
    atMs: number,
  ): void {
    const artifact = this.userDataExportArtifacts.get(artifactId);
    if (!artifact || artifact.state === "deleted" || artifact.state === "delete_pending") return;
    const deletionGeneration = artifact.deletionGeneration + 1;
    if (!Number.isSafeInteger(deletionGeneration) || deletionGeneration < 1) {
      throw new UserDataExportIntegrityError("data export deletion generation is exhausted");
    }
    const parts = [...this.userDataExportParts.values()]
      .filter((part) => part.artifactId === artifactId && part.state !== "deleted")
      .sort((left, right) => left.partNumber - right.partNumber);
    if (parts.length === 0) {
      this.userDataExportArtifacts.set(artifactId, clone({
        ...artifact,
        state: "deleted" as const,
        deletePendingAtMs: atMs,
        deletedAtMs: atMs,
        deletionGeneration,
      }));
      return;
    }
    for (const part of parts) {
      const key = this.userDataExportDeleteKey(artifactId, part.partNumber, deletionGeneration);
      const existing = this.userDataExportDeleteOutbox.get(key);
      if (existing) {
        if (existing.requestId !== artifact.requestId) {
          throw new UserDataExportIntegrityError("data export delete identity conflicts");
        }
        continue;
      }
      const outboxId = this.nextUserDataExportDeleteOutboxId++;
      if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
        throw new UserDataExportIntegrityError("data export delete outbox id is exhausted");
      }
      this.userDataExportParts.set(this.userDataExportPartKey(artifactId, part.partNumber), clone({
        ...part,
        state: "delete_pending" as const,
        deletePendingAtMs: atMs,
        deletionGeneration,
      }));
      this.userDataExportDeleteOutbox.set(key, clone({
        outboxId,
        artifactId,
        requestId: artifact.requestId,
        partNumber: part.partNumber,
        deletionGeneration,
        storageBackend: part.storageBackend,
        storageFormat: part.storageFormat,
        storageKey: part.storageKey,
        uploadToken: part.uploadToken,
        availableAtMs: atMs,
        attempts: 0,
        createdAtMs: atMs,
      }));
    }
    this.userDataExportArtifacts.set(artifactId, clone({
      ...artifact,
      state: "delete_pending" as const,
      deletePendingAtMs: atMs,
      deletionGeneration,
    }));
  }

  private revokeUserDataExportsForSubject(tenantId: string, userId: string, atMs: number): void {
    for (const request of [...this.userDataExportRequests.values()]) {
      if (
        request.tenantId !== tenantId
        || request.userId !== userId
        || request.status === "revoked"
      ) continue;
      const next = clone({ ...request, status: "revoked" as const, updatedAtMs: atMs });
      delete next.lastErrorCode;
      this.userDataExportRequests.set(request.requestId, next);
      const job = this.userDataExportJobs.get(request.requestId);
      if (job) {
        const revoked = clone({ ...job, status: "revoked" as const, updatedAtMs: atMs });
        delete revoked.availableAtMs;
        delete revoked.claimToken;
        delete revoked.leaseUntilMs;
        this.userDataExportJobs.set(request.requestId, revoked);
      }
      if (request.currentArtifactId) {
        this.transitionUserDataExportArtifactToDeletePending(request.currentArtifactId, atMs);
      }
      this.releaseUserDataExportSnapshot(
        request.requestId,
        request.currentBuildGeneration,
        atMs,
      );
      for (const [key, lease] of this.userDataExportDownloadLeases) {
        if (lease.requestId === request.requestId) this.userDataExportDownloadLeases.delete(key);
      }
    }
  }

  async requestUserDataExport(
    input: RequestUserDataExportInput,
  ): Promise<UserDataExportRequestRecord> {
    const stagedInput = clone(input);
    validateUserDataExportRequestInput(stagedInput);
    const now = this.userDataExportNow();
    const idempotencyKey = this.userDataExportIdempotencyKeyFor(stagedInput);
    const replayId = this.userDataExportIdempotency.get(idempotencyKey);
    if (replayId) {
      const replay = this.userDataExportRequests.get(replayId);
      if (
        !replay
        || replay.tenantId !== stagedInput.tenantId
        || replay.userId !== stagedInput.userId
        || replay.idempotencyKeySha256 !== stagedInput.idempotencyKeySha256
      ) throw new UserDataExportIntegrityError("data export idempotency index is corrupt");
      validateUserDataExportRequestRecord(replay);
      if (replay.requestHash !== stagedInput.requestHash) {
        throw new UserDataExportIdempotencyMismatchError();
      }
      return clone(replay);
    }
    this.assertSubjectWritable(stagedInput.tenantId, stagedInput.userId);
    if (this.userDataExportRequests.has(stagedInput.requestId)) {
      throw new UserDataExportStateError("data export request id already exists");
    }
    const policyState = this.assertRetentionPolicyState(stagedInput.tenantId);
    const policy = policyState.active;
    const ttl = policy?.policy.exportArtifactTtlMs;
    if (
      !policy
      || policyState.control.activePolicyVersion !== policy.policyVersion
      || policyState.control.activePolicySha256 !== policy.policySha256
      || policyState.control.effectiveAtMs === undefined
      || policyState.control.effectiveAtMs > now
      || ttl === null
      || ttl === undefined
      || ttl <= 0
    ) throw new UserDataExportPolicyUnavailableError();

    const tenantKey = subjectLifecycleKey(stagedInput.tenantId, "tenant", stagedInput.tenantId);
    const userKey = subjectLifecycleKey(stagedInput.tenantId, "user", stagedInput.userId);
    const tenant = this.subjectLifecycles.get(tenantKey);
    const user = this.subjectLifecycles.get(userKey);
    const stagedTenant = tenant ?? this.activeSubjectRecord(
      stagedInput.tenantId,
      "tenant",
      stagedInput.tenantId,
      now,
    );
    const stagedUser = user ?? this.activeSubjectRecord(
      stagedInput.tenantId,
      "user",
      stagedInput.userId,
      now,
    );
    if (stagedTenant.state !== "active" || stagedUser.state !== "active") {
      throw new SubjectDeletingError(stagedInput.tenantId, stagedInput.userId);
    }
    const request = clone<UserDataExportRequestRecord>({
      requestId: stagedInput.requestId,
      tenantId: stagedInput.tenantId,
      userId: stagedInput.userId,
      subjectGeneration: stagedUser.generation,
      requestedByKeyId: stagedInput.requestedByKeyId,
      idempotencyKeySha256: stagedInput.idempotencyKeySha256,
      requestHash: stagedInput.requestHash,
      format: USER_DATA_EXPORT_FORMAT,
      schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
      policyVersion: policy.policyVersion,
      policySha256: policy.policySha256,
      artifactTtlMs: ttl,
      status: "queued",
      currentBuildGeneration: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
    const job = clone<MemoryUserDataExportJob>({
      requestId: request.requestId,
      status: "queued",
      buildGeneration: 0,
      attempts: 0,
      availableAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
    });
    validateUserDataExportRequestRecord(request);
    const prior = this.captureUserDataExportState();
    const tenantExisted = this.subjectLifecycles.has(tenantKey);
    const priorTenant = this.subjectLifecycles.get(tenantKey);
    const userExisted = this.subjectLifecycles.has(userKey);
    const priorUser = this.subjectLifecycles.get(userKey);
    try {
      if (!tenant) this.subjectLifecycles.set(tenantKey, clone(stagedTenant));
      if (!user) this.subjectLifecycles.set(userKey, clone(stagedUser));
      this.userDataExportRequests.set(request.requestId, request);
      this.userDataExportJobs.set(request.requestId, job);
      this.userDataExportIdempotency.set(idempotencyKey, request.requestId);
    } catch (error) {
      this.restoreUserDataExportState(prior);
      restoreMapEntry(this.subjectLifecycles, userKey, userExisted, priorUser);
      restoreMapEntry(this.subjectLifecycles, tenantKey, tenantExisted, priorTenant);
      throw error;
    }
    return clone(request);
  }

  async getUserDataExport(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<UserDataExportRequestRecord | null> {
    let request = this.userDataExportRequests.get(requestId);
    if (!request || request.tenantId !== tenantId || request.userId !== userId) return null;
    const now = this.userDataExportNow();
    if (!this.isUserDataExportSubjectCurrent(request) && request.status !== "revoked") {
      const prior = this.captureUserDataExportState();
      try {
        this.revokeUserDataExportsForSubject(tenantId, userId, now);
      } catch (error) {
        this.restoreUserDataExportState(prior);
        throw error;
      }
      request = this.userDataExportRequests.get(requestId)!;
    } else if (request.status === "ready" && request.expiresAtMs! <= now) {
      const prior = this.captureUserDataExportState();
      try {
        this.expireUserDataExportRequest(request, now);
      } catch (error) {
        this.restoreUserDataExportState(prior);
        throw error;
      }
      request = this.userDataExportRequests.get(requestId)!;
    }
    validateUserDataExportRequestRecord(request);
    return clone(request);
  }

  private expireUserDataExportRequest(request: UserDataExportRequestRecord, atMs: number): void {
    if (request.status !== "ready") return;
    this.userDataExportRequests.set(request.requestId, clone({
      ...request,
      status: "expired" as const,
      updatedAtMs: atMs,
    }));
    if (request.currentArtifactId) {
      const hasActiveLease = [...this.userDataExportDownloadLeases.values()].some((lease) => (
        lease.artifactId === request.currentArtifactId && lease.leaseUntilMs > atMs
      ));
      if (!hasActiveLease) {
        this.transitionUserDataExportArtifactToDeletePending(request.currentArtifactId, atMs);
      }
    }
  }

  async acquireUserDataExportDownload(
    tenantId: string,
    userId: string,
    requestId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<UserDataExportDownloadLease | null> {
    if (!/^[A-Za-z0-9._:~-]{1,128}$/.test(leaseToken)) throw new Error("invalid export download lease token");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) {
      throw new Error("export download lease must be between 1 and 60000 milliseconds");
    }
    const now = this.userDataExportNow();
    for (const [key, lease] of this.userDataExportDownloadLeases) {
      if (lease.leaseUntilMs <= now) this.userDataExportDownloadLeases.delete(key);
    }
    let request = this.userDataExportRequests.get(requestId);
    if (!request || request.tenantId !== tenantId || request.userId !== userId) return null;
    if (!this.isUserDataExportSubjectCurrent(request)) {
      const prior = this.captureUserDataExportState();
      try {
        this.revokeUserDataExportsForSubject(tenantId, userId, now);
      } catch (error) {
        this.restoreUserDataExportState(prior);
        throw error;
      }
      request = this.userDataExportRequests.get(requestId)!;
    } else if (request.status === "ready" && request.expiresAtMs! <= now) {
      const prior = this.captureUserDataExportState();
      try {
        this.expireUserDataExportRequest(request, now);
      } catch (error) {
        this.restoreUserDataExportState(prior);
        throw error;
      }
      request = this.userDataExportRequests.get(requestId)!;
    }
    if (!request || request.status !== "ready" || request.expiresAtMs! <= now) return null;
    const artifact = request.currentArtifactId
      ? this.userDataExportArtifacts.get(request.currentArtifactId)
      : undefined;
    if (
      !artifact
      || artifact.requestId !== request.requestId
      || artifact.tenantId !== tenantId
      || artifact.userId !== userId
      || artifact.subjectGeneration !== request.subjectGeneration
      || artifact.buildGeneration !== request.currentBuildGeneration
      || artifact.state !== "ready"
      || artifact.format !== request.format
      || artifact.schemaVersion !== request.schemaVersion
      || artifact.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
      || artifact.storageFormat !== BLOB_STORAGE_FORMAT
      || artifact.policyVersion !== request.policyVersion
      || artifact.policySha256 !== request.policySha256
      || artifact.artifactTtlMs !== request.artifactTtlMs
      || artifact.snapshotAtMs !== request.snapshotAtMs
      || artifact.readyAtMs !== request.readyAtMs
      || artifact.expiresAtMs !== request.expiresAtMs
      || artifact.contentSha256 !== request.artifactSha256
      || artifact.totalSizeBytes !== request.artifactSizeBytes
      || artifact.recordCount !== request.recordCount
      || artifact.deletionGeneration !== 0
      || artifact.partCount === undefined
      || artifact.manifestSha256 === undefined
      || artifact.expiresAtMs === undefined
      || artifact.expiresAtMs <= now
    ) throw new UserDataExportIntegrityError("ready export artifact identity is invalid");
    const parts = [...this.userDataExportParts.values()]
      .filter((part) => part.artifactId === artifact.artifactId)
      .sort((left, right) => left.partNumber - right.partNumber);
    if (
      parts.length !== artifact.partCount
      || parts.some((part, index) => (
        part.artifactId !== artifact.artifactId
        || part.requestId !== request.requestId
        || part.buildGeneration !== request.currentBuildGeneration
        || part.partNumber !== index
        || part.state !== "uploaded"
        || part.storageBackend !== artifact.storageBackend
        || part.storageFormat !== artifact.storageFormat
        || part.storageKey !== userDataExportStorageKey(
          { tenantId, userId },
          request.requestId,
          artifact.artifactId,
          part.partNumber,
        )
        || part.sha256 === undefined
        || part.sizeBytes === undefined
        || part.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
        || part.deletionGeneration !== 0
      ))
    ) throw new UserDataExportIntegrityError("ready export artifact parts are incomplete");
    const totalSizeBytes = parts.reduce((total, part) => total + part.sizeBytes!, 0);
    if (
      !Number.isSafeInteger(totalSizeBytes)
      || totalSizeBytes !== artifact.totalSizeBytes
      || userDataExportManifestSha256(parts) !== artifact.manifestSha256
    ) throw new UserDataExportIntegrityError("ready export artifact manifest is invalid");
    const key = this.userDataExportDownloadLeaseKey(artifact.artifactId, leaseToken);
    const existing = this.userDataExportDownloadLeases.get(key);
    if (existing && (
      existing.requestId !== request.requestId
      || existing.tenantId !== tenantId
      || existing.userId !== userId
    )) throw new UserDataExportIntegrityError("export download lease identity conflicts");
    const requestedUntilMs = now + leaseMs;
    const createdAtMs = existing?.createdAtMs ?? now;
    const hardDeadlineMs = createdAtMs + 10 * 60_000;
    const leaseUntilMs = Math.min(
      hardDeadlineMs,
      Math.max(existing?.leaseUntilMs ?? 0, requestedUntilMs),
    );
    if (
      !Number.isSafeInteger(requestedUntilMs)
      || !Number.isSafeInteger(hardDeadlineMs)
      || !Number.isSafeInteger(leaseUntilMs)
      || leaseUntilMs <= now
    ) throw new Error("export download lease expiry overflow");
    this.userDataExportDownloadLeases.set(key, clone(existing
      ? { ...existing, leaseUntilMs }
      : {
          artifactId: artifact.artifactId,
          requestId: request.requestId,
          tenantId,
          userId,
          leaseToken,
          leaseUntilMs,
          createdAtMs,
        }));
    return {
      request: clone(request),
      artifact: clone(artifact),
      parts: parts.map(clone),
      leaseToken,
      leaseUntilMs,
    };
  }

  async renewUserDataExportDownload(
    artifactId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) return false;
    const now = this.userDataExportNow();
    const key = this.userDataExportDownloadLeaseKey(artifactId, leaseToken);
    const lease = this.userDataExportDownloadLeases.get(key);
    if (!lease || lease.leaseUntilMs <= now) return false;
    const hardDeadline = lease.createdAtMs + 10 * 60_000;
    const next = Math.min(hardDeadline, Math.max(lease.leaseUntilMs, now + leaseMs));
    if (!Number.isSafeInteger(next) || next <= now) return false;
    this.userDataExportDownloadLeases.set(key, { ...lease, leaseUntilMs: next });
    return true;
  }

  async releaseUserDataExportDownload(artifactId: string, leaseToken: string): Promise<void> {
    this.userDataExportDownloadLeases.delete(
      this.userDataExportDownloadLeaseKey(artifactId, leaseToken),
    );
  }

  private activeUserDataExportClaim(
    authorization: UserDataExportAuthorization,
    now = this.userDataExportNow(),
  ): {
    request: UserDataExportRequestRecord;
    job: MemoryUserDataExportJob;
  } | null {
    validateUserDataExportAuthorization(authorization);
    const request = this.userDataExportRequests.get(authorization.requestId);
    const job = this.userDataExportJobs.get(authorization.requestId);
    if (
      !request
      || !job
      || request.tenantId !== authorization.tenantId
      || request.userId !== authorization.userId
      || request.subjectGeneration !== authorization.subjectGeneration
      || request.currentBuildGeneration !== authorization.buildGeneration
      || job.buildGeneration !== authorization.buildGeneration
      || job.attempts !== authorization.claimAttempt
      || job.claimToken !== authorization.claimToken
      || job.leaseUntilMs === undefined
      || job.leaseUntilMs <= now
      || job.status !== "building"
      || request.status !== "building"
      || !this.isUserDataExportSubjectCurrent(request)
    ) return null;
    return { request, job };
  }

  async claimUserDataExports(
    options: ClaimUserDataExportsOptions,
  ): Promise<UserDataExportClaim[]> {
    validateClaimUserDataExportsOptions(options);
    const now = this.userDataExportNow();
    const leaseUntilMs = now + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("data export lease expiry overflow");
    const prior = this.captureUserDataExportState();
    try {
      for (const request of [...this.userDataExportRequests.values()]) {
        if (!this.isUserDataExportSubjectCurrent(request)) {
          this.revokeUserDataExportsForSubject(request.tenantId, request.userId, now);
        }
      }
      const candidates = [...this.userDataExportJobs.values()]
        .filter((job) => (
          (job.status === "queued" || job.status === "building")
          && (job.availableAtMs ?? 0) <= now
          && (job.claimToken === undefined || (job.leaseUntilMs !== undefined && job.leaseUntilMs <= now))
        ))
        .sort((left, right) => left.requestId.localeCompare(right.requestId))
        .slice(0, options.limit);
      const claims: UserDataExportClaim[] = [];
      for (const job of candidates) {
        const request = this.userDataExportRequests.get(job.requestId);
        if (!request || (request.status !== "queued" && request.status !== "building")) continue;
        const buildGeneration = job.snapshot
          ? job.buildGeneration
          : job.buildGeneration + 1;
        const claimAttempt = job.attempts + 1;
        if (!Number.isSafeInteger(buildGeneration) || buildGeneration < 1) {
          throw new UserDataExportIntegrityError("data export build generation is exhausted");
        }
        if (!Number.isSafeInteger(claimAttempt) || claimAttempt < 1) {
          throw new UserDataExportIntegrityError("data export claim attempt is exhausted");
        }
        const nextJob = clone<MemoryUserDataExportJob>({
          ...job,
          status: "building",
          buildGeneration,
          attempts: claimAttempt,
          claimToken: options.claimToken,
          leaseUntilMs,
          updatedAtMs: now,
        });
        delete nextJob.availableAtMs;
        if (!job.snapshot && job.buildGeneration !== buildGeneration) {
          delete nextJob.currentArtifactId;
          delete nextJob.lastErrorCode;
        }
        const nextRequest = clone<UserDataExportRequestRecord>({
          ...request,
          status: "building",
          currentBuildGeneration: buildGeneration,
          currentArtifactId: nextJob.currentArtifactId,
          updatedAtMs: now,
        });
        delete nextRequest.lastErrorCode;
        this.userDataExportJobs.set(job.requestId, nextJob);
        this.userDataExportRequests.set(job.requestId, nextRequest);
        claims.push({
          requestId: request.requestId,
          tenantId: request.tenantId,
          userId: request.userId,
          subjectGeneration: request.subjectGeneration,
          buildGeneration,
          claimAttempt,
          claimToken: options.claimToken,
          leaseUntilMs,
          policyVersion: request.policyVersion,
          policySha256: request.policySha256,
          artifactTtlMs: request.artifactTtlMs,
        });
      }
      return claims.map(clone);
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
  }

  async renewUserDataExportClaim(
    authorization: UserDataExportAuthorization,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error("invalid data export lease duration");
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    if (!state || !this.isUserDataExportSubjectCurrent(state.request)) return false;
    const until = now + leaseMs;
    if (!Number.isSafeInteger(until)) throw new Error("data export lease expiry overflow");
    this.userDataExportJobs.set(state.job.requestId, clone({
      ...state.job,
      leaseUntilMs: Math.max(state.job.leaseUntilMs!, until),
      updatedAtMs: now,
    }));
    return true;
  }

  async startUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: StartUserDataExportArtifactInput,
  ): Promise<UserDataExportArtifactRecord> {
    validateStartUserDataExportArtifactInput(input);
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(input.storageBackend)) {
      throw new Error("invalid data export storage backend");
    }
    if (input.storageFormat !== BLOB_STORAGE_FORMAT) {
      throw new Error("unsupported data export storage format");
    }
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    if (!state || !this.isUserDataExportSubjectCurrent(state.request)) {
      throw new UserDataExportStateError("stale data export claim");
    }
    if (!state.job.snapshot) {
      throw new UserDataExportStateError("data export snapshot is not sealed");
    }
    if (state.job.currentArtifactId) {
      const existing = this.userDataExportArtifacts.get(state.job.currentArtifactId);
      if (
        !existing
        || existing.artifactId !== input.artifactId
        || existing.requestId !== authorization.requestId
        || existing.buildGeneration !== authorization.buildGeneration
        || existing.storageBackend !== input.storageBackend
        || existing.storageFormat !== input.storageFormat
        || existing.snapshotRootSha256 !== state.job.snapshot.snapshotRootSha256
      ) throw new UserDataExportIntegrityError("data export artifact identity conflicts");
      return clone(existing);
    }
    if (this.userDataExportArtifacts.has(input.artifactId)) {
      throw new UserDataExportStateError("data export artifact id already exists");
    }
    const stagingExpiresAtMs = now + input.stagingTtlMs;
    if (!Number.isSafeInteger(stagingExpiresAtMs)) {
      throw new Error("data export staging expiry overflow");
    }
    const artifact: UserDataExportArtifactRecord = {
      artifactId: input.artifactId,
      requestId: state.request.requestId,
      tenantId: state.request.tenantId,
      userId: state.request.userId,
      subjectGeneration: state.request.subjectGeneration,
      buildGeneration: authorization.buildGeneration,
      state: "staging",
      format: USER_DATA_EXPORT_FORMAT,
      schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
      storageBackend: input.storageBackend,
      storageFormat: input.storageFormat,
      policyVersion: state.request.policyVersion,
      policySha256: state.request.policySha256,
      snapshotRootSha256: state.job.snapshot.snapshotRootSha256,
      artifactTtlMs: state.request.artifactTtlMs,
      stagingExpiresAtMs,
      deletionGeneration: 0,
      createdAtMs: now,
    };
    const prior = this.captureUserDataExportState();
    try {
      this.userDataExportArtifacts.set(input.artifactId, clone(artifact));
      this.userDataExportJobs.set(state.job.requestId, clone({
        ...state.job,
        currentArtifactId: input.artifactId,
        updatedAtMs: now,
      }));
      this.userDataExportRequests.set(state.request.requestId, clone({
        ...state.request,
        currentArtifactId: input.artifactId,
        updatedAtMs: now,
      }));
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    return clone(artifact);
  }

  async captureAndSealUserDataExportSnapshot(
    authorization: UserDataExportAuthorization,
  ): Promise<UserDataExportSnapshotSummary> {
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    if (!state || !this.isUserDataExportSubjectCurrent(state.request)) {
      throw new UserDataExportStateError("stale data export claim");
    }
    if (state.job.snapshot) {
      const records = this.userDataExportSnapshotRecords.get(authorization.requestId) ?? [];
      const blobs = this.userDataExportSnapshotBlobs.get(authorization.requestId) ?? [];
      if (
        records.some((record) => record.buildGeneration !== authorization.buildGeneration)
        || blobs.some((blob) => (
          blob.buildGeneration !== authorization.buildGeneration || blob.releasedAtMs !== undefined
        ))
        || records.length + blobs.length !== state.job.snapshot.recordCount
      ) throw new UserDataExportIntegrityError("sealed data export snapshot is incomplete");
      return clone(state.job.snapshot);
    }
    if (state.job.currentArtifactId) {
      throw new UserDataExportIntegrityError("unsealed data export job already has an artifact");
    }

    const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    const ownedSessions = [...this.sessions.entries()]
      .filter(([, session]) => (
        session.tenantId === authorization.tenantId && session.userId === authorization.userId
      ))
      .sort((left, right) => compareText(left[0], right[0]));
    const ownedSessionIds = new Set(ownedSessions.map(([, session]) => session.id));
    for (const [mapKey, session] of ownedSessions) {
      if (mapKey !== session.id) throw new UserDataExportIntegrityError("session identity is corrupt");
    }
    for (const usage of this.usageLedger) {
      const sourceSession = this.sessions.get(usage.sessionId);
      const rowOwned = usage.tenantId === authorization.tenantId
        && usage.userId === authorization.userId;
      const sessionOwned = !!sourceSession
        && sourceSession.tenantId === authorization.tenantId
        && sourceSession.userId === authorization.userId;
      if (rowOwned !== sessionOwned) {
        throw new UserDataExportIntegrityError("operational usage ownership is corrupt");
      }
    }
    for (const [mapKey, manifest] of this.blobManifests) {
      const sourceSession = this.sessions.get(manifest.sessionId);
      const rowOwned = manifest.tenantId === authorization.tenantId
        && manifest.userId === authorization.userId;
      const sessionOwned = !!sourceSession
        && sourceSession.tenantId === authorization.tenantId
        && sourceSession.userId === authorization.userId;
      if (mapKey !== manifest.blobId || rowOwned !== sessionOwned) {
        throw new UserDataExportIntegrityError("blob ownership is corrupt");
      }
    }

    const counts: UserDataExportSnapshotSummary["counts"] = {
      session: 0,
      turn: 0,
      item: 0,
      event: 0,
      approval: 0,
      operational_usage: 0,
      attachment: 0,
    };
    const pendingRecords: Omit<UserDataExportSnapshotRecord, "ordinal">[] = [];
    const pendingBlobs: Omit<UserDataExportSnapshotBlob, "ordinal">[] = [];
    const appendRecord = (
      kind: UserDataExportSnapshotRecord["kind"],
      logicalKey: string,
      value: UserDataExportSnapshotEntry["value"],
    ) => {
      const canonicalBytes = canonicalUserDataExportBytes({ type: kind, value } as UserDataExportSnapshotEntry);
      const sha256 = createHash("sha256").update(canonicalBytes).digest("hex");
      const record: Omit<UserDataExportSnapshotRecord, "ordinal"> = {
        requestId: authorization.requestId,
        buildGeneration: authorization.buildGeneration,
        kind,
        logicalKey,
        canonicalBytes,
        sha256,
        sizeBytes: canonicalBytes.byteLength,
      };
      pendingRecords.push(record);
      counts[kind] += 1;
    };

    for (const [, storedSession] of ownedSessions) {
      const session = SessionSchema.parse(clone(storedSession));
      const tombstone = this.deleted.get(session.id);
      if (tombstone && (
        !Number.isSafeInteger(tombstone.deletedAtMs)
        || tombstone.deletedAtMs < 0
        || !Number.isSafeInteger(tombstone.deletionGeneration)
        || tombstone.deletionGeneration < 0
      )) throw new UserDataExportIntegrityError("session tombstone is corrupt");
      const projectedSession = this.sessionForRead(session);
      appendRecord(
        "session",
        canonicalUserDataExportJson(["session", session.id]),
        sanitizeExportSession(projectedSession, tombstone?.deletedAtMs),
      );

      const sessionTurns = [...this.turns.entries()]
        .filter(([, turn]) => turn.sessionId === session.id)
        .sort((left, right) => compareText(left[0], right[0]));
      const sessionTurnIds = new Set<string>();
      for (const [mapKey, storedTurn] of sessionTurns) {
        const turn = TurnSchema.parse(clone(storedTurn));
        if (mapKey !== turn.id || turn.sessionId !== session.id) {
          throw new UserDataExportIntegrityError("turn identity is corrupt");
        }
        sessionTurnIds.add(turn.id);
        appendRecord(
          "turn",
          canonicalUserDataExportJson(["turn", session.id, turn.id]),
          sanitizeExportTurn(this.turnForRead(turn, session)),
        );
      }

      const sessionItems = [...this.items.entries()]
        .filter(([, item]) => item.sessionId === session.id)
        .sort((left, right) => (left[1].seq - right[1].seq) || compareText(left[0], right[0]));
      const normalizedItems: Item[] = [];
      const sessionItemIds = new Set<string>();
      for (const [mapKey, storedItem] of sessionItems) {
        const item = ItemSchema.parse(clone(storedItem));
        if (mapKey !== item.id || !sessionTurnIds.has(item.turnId)) {
          throw new UserDataExportIntegrityError("item identity is corrupt");
        }
        const usage = this.usageProjectionRows(session.id, item.turnId).find((row) => (
          row.step === 0 && row.tenantId === session.tenantId && row.userId === session.userId
        ));
        const normalized = canonicalizeUsageItem(item, usage);
        normalizedItems.push(normalized);
        sessionItemIds.add(normalized.id);
        appendRecord(
          "item",
          canonicalUserDataExportJson(["item", session.id, normalized.id]),
          normalized,
        );
      }

      const sessionEvents = clone(this.events.get(session.id) ?? []);
      if (sessionEvents.length !== session.lastSeq) {
        throw new UserDataExportIntegrityError("event sequence is incomplete");
      }
      for (const [index, storedEvent] of sessionEvents.entries()) {
        const event = EventSchema.parse(storedEvent);
        if (event.seq === undefined || event.seq !== index + 1 || event.sessionId !== session.id) {
          throw new UserDataExportIntegrityError("event sequence is corrupt");
        }
        const normalized = sanitizeExportEvent(canonicalizePersistedUsageEvent(
          event as PersistedEvent,
          this.usageProjectionRows(session.id),
          { tenantId: session.tenantId, userId: session.userId },
        ));
        appendRecord(
          "event",
          canonicalUserDataExportJson(["event", session.id, normalized.seq]),
          normalized,
        );
      }

      const sessionApprovals = [...this.approvals.entries()]
        .filter(([, approval]) => approval.sessionId === session.id)
        .sort((left, right) => compareText(left[0], right[0]));
      for (const [mapKey, storedApproval] of sessionApprovals) {
        const approval = ApprovalSchema.parse(clone(storedApproval));
        if (
          mapKey !== approval.id
          || !sessionTurnIds.has(approval.turnId)
          || !sessionItemIds.has(approval.itemId)
        ) throw new UserDataExportIntegrityError("approval identity is corrupt");
        appendRecord(
          "approval",
          canonicalUserDataExportJson(["approval", session.id, approval.id]),
          approval,
        );
      }

      const usageRows = this.usageProjectionRows(session.id)
        .sort((left, right) => (
          compareText(left.turnId, right.turnId)
          || left.step - right.step
          || compareText(left.provider, right.provider)
          || compareText(left.model, right.model)
        ));
      const usageKeys = new Set<string>();
      for (const usage of usageRows) {
        if (
          usage.tenantId !== session.tenantId
          || usage.userId !== session.userId
          || !sessionTurnIds.has(usage.turnId)
          || !Number.isSafeInteger(usage.step)
          || usage.step < 0
          || !usage.provider
          || !usage.model
          || !Number.isSafeInteger(usage.createdAtMs)
          || usage.createdAtMs < 0
        ) throw new UserDataExportIntegrityError("operational usage is corrupt");
        const logicalKey = canonicalUserDataExportJson([
          "operational_usage", session.id, usage.turnId, usage.step,
        ]);
        if (usageKeys.has(logicalKey)) {
          throw new UserDataExportIntegrityError("operational usage identity is duplicated");
        }
        usageKeys.add(logicalKey);
        const value = {
          sessionId: session.id,
          turnId: usage.turnId,
          step: usage.step,
          provider: usage.provider,
          model: usage.model,
          usage: UsageSchema.parse(normalizeOperationalUsageCost(usage.usage, usage.usageId)),
          createdAtMs: usage.createdAtMs,
        };
        appendRecord("operational_usage", logicalKey, value);
      }

      const bindings = blobBindingsFromItems(normalizedItems).sort((left, right) => (
        compareText(left.blobId, right.blobId)
        || compareText(left.itemId, right.itemId)
        || compareText(left.purpose, right.purpose)
      ));
      const readyForSession = [...this.blobManifests.values()].filter((manifest) => (
        manifest.sessionId === session.id && manifest.state === "ready"
      ));
      if (readyForSession.length !== bindings.length) {
        throw new UserDataExportIntegrityError("ready blob ownership does not match item references");
      }
      for (const binding of bindings) {
        const manifest = this.blobManifests.get(binding.blobId);
        if (
          !manifest
          || manifest.tenantId !== session.tenantId
          || manifest.userId !== session.userId
          || manifest.sessionId !== session.id
          || manifest.itemId !== binding.itemId
          || manifest.purpose !== binding.purpose
          || manifest.state !== "ready"
          || manifest.sha256 === undefined
          || !/^[0-9a-f]{64}$/.test(manifest.sha256)
          || manifest.sizeBytes === undefined
          || !Number.isSafeInteger(manifest.sizeBytes)
          || manifest.sizeBytes < 0
          || manifest.readyAtMs === undefined
          || manifest.uploadedAtMs === undefined
        ) throw new UserDataExportIntegrityError("ready blob manifest is corrupt");
        validateBlobKey(manifest.storageKey);
        validateBlobUploadToken(manifest.uploadToken);
        validateBlobContentType(manifest.contentType);
        if (manifest.storageFormat !== BLOB_STORAGE_FORMAT) {
          throw new UserDataExportIntegrityError("ready blob storage format is unsupported");
        }
        const publicAttachment = {
          blobId: manifest.blobId,
          sessionId: manifest.sessionId,
          itemId: manifest.itemId,
          purpose: manifest.purpose,
          ...(manifest.contentType === undefined ? {} : { contentType: manifest.contentType }),
          sha256: manifest.sha256,
          sizeBytes: manifest.sizeBytes,
        };
        const logicalKey = userDataExportAttachmentLogicalKey(publicAttachment);
        pendingBlobs.push({
          ...publicAttachment,
          requestId: authorization.requestId,
          buildGeneration: authorization.buildGeneration,
          storageBackend: manifest.storageBackend,
          storageFormat: manifest.storageFormat,
          storageKey: manifest.storageKey,
          sourceUploadToken: manifest.uploadToken,
          sourceDeletionGeneration: manifest.deletionGeneration,
          pinToken: createHash("sha256").update(canonicalUserDataExportJson([
            "agent-service/user-data-export-pin/v1",
            authorization.requestId,
            authorization.buildGeneration,
            manifest.blobId,
          ])).digest("hex"),
          pinnedAtMs: now,
        });
        counts.attachment += 1;
      }
    }

    // Resources whose owner is determined by an owned session must all have been selected above.
    for (const [key, turn] of this.turns) {
      if (ownedSessionIds.has(turn.sessionId) && key !== turn.id) {
        throw new UserDataExportIntegrityError("turn map identity is corrupt");
      }
    }
    for (const [key, item] of this.items) {
      if (ownedSessionIds.has(item.sessionId) && key !== item.id) {
        throw new UserDataExportIntegrityError("item map identity is corrupt");
      }
    }
    for (const [key, approval] of this.approvals) {
      if (ownedSessionIds.has(approval.sessionId) && key !== approval.id) {
        throw new UserDataExportIntegrityError("approval map identity is corrupt");
      }
    }
    for (const [key, storedEvents] of this.events) {
      if (
        storedEvents.some((event) => ownedSessionIds.has(event.sessionId))
        && !ownedSessionIds.has(key)
      ) throw new UserDataExportIntegrityError("event log identity is corrupt");
    }
    const kindIndex = new Map<UserDataExportSnapshotRecord["kind"], number>(
      USER_DATA_EXPORT_RECORD_KIND_ORDER.map((kind, index) => [kind, index]),
    );
    pendingRecords.sort((left, right) => (
      kindIndex.get(left.kind)! - kindIndex.get(right.kind)!
      || compareText(left.logicalKey, right.logicalKey)
    ));
    if (pendingRecords.some((record, index) => (
      index > 0
      && pendingRecords[index - 1]!.kind === record.kind
      && pendingRecords[index - 1]!.logicalKey === record.logicalKey
    ))) throw new UserDataExportIntegrityError("data export snapshot record identity is duplicated");
    const records: UserDataExportSnapshotRecord[] = pendingRecords.map((record, ordinal) => ({
      ...record,
      ordinal,
    }));
    pendingBlobs.sort((left, right) => compareText(
      userDataExportAttachmentLogicalKey(left),
      userDataExportAttachmentLogicalKey(right),
    ));
    if (pendingBlobs.some((blob, index) => (
      index > 0
      && userDataExportAttachmentLogicalKey(pendingBlobs[index - 1]!)
        === userDataExportAttachmentLogicalKey(blob)
    ))) throw new UserDataExportIntegrityError("data export attachment identity is duplicated");
    const blobs: UserDataExportSnapshotBlob[] = pendingBlobs.map((blob, ordinal) => ({
      ...blob,
      ordinal,
    }));
    let root = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
    for (const record of records) {
      root = nextUserDataExportSnapshotRootSha256(
        root,
        record.kind,
        record.logicalKey,
        record.sha256,
        record.sizeBytes,
      );
    }
    for (const blob of blobs) {
      const publicAttachment = {
        blobId: blob.blobId,
        sessionId: blob.sessionId,
        ...(blob.itemId === undefined ? {} : { itemId: blob.itemId }),
        purpose: blob.purpose,
        ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
      };
      const canonicalBytes = canonicalUserDataExportBytes({
        type: "attachment",
        value: publicAttachment,
      });
      root = nextUserDataExportSnapshotRootSha256(
        root,
        "attachment",
        userDataExportAttachmentLogicalKey(publicAttachment),
        createHash("sha256").update(canonicalBytes).digest("hex"),
        canonicalBytes.byteLength,
      );
    }
    const summary: UserDataExportSnapshotSummary = {
      snapshotAtMs: now,
      counts,
      recordCount: records.length + blobs.length,
      snapshotRootSha256: root,
    };
    const prior = this.captureUserDataExportState();
    try {
      this.userDataExportSnapshotRecords.set(
        authorization.requestId,
        records.map(cloneUserDataExportSnapshotRecord),
      );
      this.userDataExportSnapshotBlobs.set(authorization.requestId, blobs.map(clone));
      this.userDataExportJobs.set(state.job.requestId, clone({
        ...state.job,
        snapshot: summary,
        updatedAtMs: now,
      }));
      this.userDataExportRequests.set(state.request.requestId, clone({
        ...state.request,
        snapshotAtMs: now,
        updatedAtMs: now,
      }));
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    return clone(summary);
  }

  async readUserDataExportSnapshotRecords(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotRecordPage> {
    const state = this.activeUserDataExportClaim(authorization);
    if (!state?.job.snapshot) throw new UserDataExportStateError("stale or unsealed data export claim");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new Error("data export snapshot page limit must be between 1 and 1000");
    }
    if (options.afterOrdinal !== undefined && (
      !Number.isSafeInteger(options.afterOrdinal) || options.afterOrdinal < 0
    )) throw new Error("invalid data export snapshot cursor");
    const all = (this.userDataExportSnapshotRecords.get(authorization.requestId) ?? [])
      .filter((record) => (
        record.buildGeneration === authorization.buildGeneration
        && (options.afterOrdinal === undefined || record.ordinal > options.afterOrdinal)
      ))
      .sort((left, right) => left.ordinal - right.ordinal);
    const data = all.slice(0, options.limit);
    return {
      data: data.map(cloneUserDataExportSnapshotRecord),
      nextOrdinal: all.length > data.length ? data.at(-1)!.ordinal : null,
    };
  }

  async readUserDataExportSnapshotBlobs(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotBlobPage> {
    const state = this.activeUserDataExportClaim(authorization);
    if (!state?.job.snapshot) throw new UserDataExportStateError("stale or unsealed data export claim");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new Error("data export snapshot page limit must be between 1 and 1000");
    }
    if (options.afterOrdinal !== undefined && (
      !Number.isSafeInteger(options.afterOrdinal) || options.afterOrdinal < 0
    )) throw new Error("invalid data export snapshot cursor");
    const all = (this.userDataExportSnapshotBlobs.get(authorization.requestId) ?? [])
      .filter((blob) => (
        blob.buildGeneration === authorization.buildGeneration
        && blob.releasedAtMs === undefined
        && (options.afterOrdinal === undefined || blob.ordinal > options.afterOrdinal)
      ))
      .sort((left, right) => left.ordinal - right.ordinal);
    const data = all.slice(0, options.limit);
    return {
      data: data.map(clone),
      nextOrdinal: all.length > data.length ? data.at(-1)!.ordinal : null,
    };
  }

  async getUserDataExportArtifactBuild(
    authorization: UserDataExportAuthorization,
  ): Promise<{ artifact: UserDataExportArtifactRecord | null; parts: UserDataExportArtifactPart[] }> {
    const state = this.activeUserDataExportClaim(authorization);
    if (!state) throw new UserDataExportStateError("stale data export claim");
    const artifact = state.job.currentArtifactId
      ? this.userDataExportArtifacts.get(state.job.currentArtifactId)
      : undefined;
    if (artifact && (
      artifact.requestId !== authorization.requestId
      || artifact.buildGeneration !== authorization.buildGeneration
    )) throw new UserDataExportIntegrityError("data export artifact build is corrupt");
    const parts = artifact
      ? [...this.userDataExportParts.values()]
        .filter((part) => part.artifactId === artifact.artifactId)
        .sort((left, right) => left.partNumber - right.partNumber)
      : [];
    return { artifact: artifact ? clone(artifact) : null, parts: parts.map(clone) };
  }

  async stageUserDataExportPart(
    authorization: UserDataExportAuthorization,
    input: StageUserDataExportPartInput,
  ): Promise<UserDataExportArtifactPart> {
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 0) {
      throw new Error("invalid data export part number");
    }
    validateBlobKey(input.storageKey);
    validateBlobUploadToken(input.uploadToken);
    if (input.storageKey !== userDataExportStorageKey(
      { tenantId: authorization.tenantId, userId: authorization.userId },
      authorization.requestId,
      input.artifactId,
      input.partNumber,
    )) throw new UserDataExportIntegrityError("data export artifact storage key is not canonical");
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    const artifact = state?.job.currentArtifactId
      ? this.userDataExportArtifacts.get(state.job.currentArtifactId)
      : undefined;
    if (
      !state
      || !artifact
      || artifact.artifactId !== input.artifactId
      || artifact.state !== "staging"
      || input.storageBackend !== artifact.storageBackend
      || input.storageFormat !== artifact.storageFormat
    ) throw new UserDataExportStateError("stale data export artifact build");
    const key = this.userDataExportPartKey(input.artifactId, input.partNumber);
    const existing = this.userDataExportParts.get(key);
    if (existing) {
      if (
        existing.requestId !== authorization.requestId
        || existing.buildGeneration !== authorization.buildGeneration
        || existing.storageBackend !== input.storageBackend
        || existing.storageFormat !== input.storageFormat
        || existing.storageKey !== input.storageKey
        || existing.uploadToken !== input.uploadToken
      ) throw new UserDataExportIntegrityError("data export part identity conflicts");
      return clone(existing);
    }
    if ([...this.userDataExportParts.values()].some((part) => part.storageKey === input.storageKey)) {
      throw new UserDataExportIntegrityError("data export storage key already exists");
    }
    if (input.partNumber > 0) {
      const prior = this.userDataExportParts.get(
        this.userDataExportPartKey(input.artifactId, input.partNumber - 1),
      );
      if (prior?.state !== "uploaded") {
        throw new UserDataExportStateError("data export artifact parts must be staged in order");
      }
    }
    const part: UserDataExportArtifactPart = {
      artifactId: input.artifactId,
      requestId: authorization.requestId,
      buildGeneration: authorization.buildGeneration,
      partNumber: input.partNumber,
      state: "staging",
      storageBackend: input.storageBackend,
      storageFormat: input.storageFormat,
      storageKey: input.storageKey,
      uploadToken: input.uploadToken,
      deletionGeneration: 0,
      createdAtMs: now,
    };
    this.userDataExportParts.set(key, clone(part));
    return clone(part);
  }

  async markUserDataExportPartUploaded(
    authorization: UserDataExportAuthorization,
    input: MarkUserDataExportPartUploadedInput,
  ): Promise<UserDataExportArtifactPart> {
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 0) {
      throw new Error("invalid data export part number");
    }
    validateBlobKey(input.descriptor.storageKey);
    validateBlobContentType(input.descriptor.contentType);
    if (input.descriptor.contentType !== USER_DATA_EXPORT_CONTENT_TYPE) {
      throw new Error("invalid data export part content type");
    }
    if (!/^[0-9a-f]{64}$/.test(input.descriptor.sha256)) throw new Error("invalid export part hash");
    if (!Number.isSafeInteger(input.descriptor.sizeBytes) || input.descriptor.sizeBytes < 0) {
      throw new Error("invalid export part size");
    }
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    const artifact = state?.job.currentArtifactId
      ? this.userDataExportArtifacts.get(state.job.currentArtifactId)
      : undefined;
    const key = this.userDataExportPartKey(input.artifactId, input.partNumber);
    const part = this.userDataExportParts.get(key);
    if (
      !state
      || !artifact
      || artifact.artifactId !== input.artifactId
      || artifact.state !== "staging"
      || !part
      || part.requestId !== authorization.requestId
      || part.buildGeneration !== authorization.buildGeneration
      || part.storageKey !== input.descriptor.storageKey
    ) throw new UserDataExportStateError("stale data export part");
    if (part.state === "uploaded") {
      if (
        part.sha256 !== input.descriptor.sha256
        || part.sizeBytes !== input.descriptor.sizeBytes
        || part.contentType !== input.descriptor.contentType
      ) throw new UserDataExportIntegrityError("uploaded data export part conflicts");
      return clone(part);
    }
    if (part.state !== "staging") throw new UserDataExportStateError("data export part is not uploadable");
    const uploaded: UserDataExportArtifactPart = {
      ...part,
      state: "uploaded",
      sha256: input.descriptor.sha256,
      sizeBytes: input.descriptor.sizeBytes,
      ...(input.descriptor.contentType === undefined ? {} : { contentType: input.descriptor.contentType }),
      uploadedAtMs: now,
    };
    this.userDataExportParts.set(key, clone(uploaded));
    return clone(uploaded);
  }

  async completeUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: CompleteUserDataExportArtifactInput,
  ): Promise<UserDataExportRequestRecord> {
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    const artifact = state?.job.currentArtifactId
      ? this.userDataExportArtifacts.get(state.job.currentArtifactId)
      : undefined;
    if (
      !state?.job.snapshot
      || !artifact
      || artifact.artifactId !== input.artifactId
      || artifact.state !== "staging"
      || !this.isUserDataExportSubjectCurrent(state.request)
    ) throw new UserDataExportStateError("stale data export artifact completion");
    for (const [name, value, minimum] of [
      ["snapshot timestamp", input.snapshotAtMs, 0],
      ["part count", input.partCount, 1],
      ["record count", input.recordCount, 0],
      ["total size", input.totalSizeBytes, 0],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid data export ${name}`);
    }
    if (!/^[0-9a-f]{64}$/.test(input.contentSha256) || !/^[0-9a-f]{64}$/.test(input.manifestSha256)) {
      throw new Error("invalid data export completion hash");
    }
    if (
      input.snapshotAtMs !== state.job.snapshot.snapshotAtMs
      || input.recordCount !== state.job.snapshot.recordCount
    ) throw new UserDataExportIntegrityError("data export completion does not match its snapshot");
    const parts = [...this.userDataExportParts.values()]
      .filter((part) => part.artifactId === artifact.artifactId)
      .sort((left, right) => left.partNumber - right.partNumber);
    if (
      parts.length !== input.partCount
      || parts.some((part, index) => (
        part.partNumber !== index
        || part.state !== "uploaded"
        || part.sha256 === undefined
        || part.sizeBytes === undefined
      ))
    ) throw new UserDataExportIntegrityError("data export artifact parts are incomplete");
    const totalSizeBytes = parts.reduce((total, part) => total + part.sizeBytes!, 0);
    if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes !== input.totalSizeBytes) {
      throw new UserDataExportIntegrityError("data export artifact size does not match its parts");
    }
    if (userDataExportManifestSha256(parts) !== input.manifestSha256) {
      throw new UserDataExportIntegrityError("data export artifact manifest hash does not match");
    }
    const expiresAtMs = now + state.request.artifactTtlMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
      throw new UserDataExportIntegrityError("data export expiry is invalid");
    }
    const readyArtifact: UserDataExportArtifactRecord = {
      ...artifact,
      state: "ready",
      partCount: input.partCount,
      recordCount: input.recordCount,
      totalSizeBytes: input.totalSizeBytes,
      contentSha256: input.contentSha256,
      manifestSha256: input.manifestSha256,
      snapshotAtMs: input.snapshotAtMs,
      readyAtMs: now,
      expiresAtMs,
    };
    const readyRequest: UserDataExportRequestRecord = {
      ...state.request,
      status: "ready",
      currentArtifactId: artifact.artifactId,
      snapshotAtMs: input.snapshotAtMs,
      readyAtMs: now,
      expiresAtMs,
      artifactSha256: input.contentSha256,
      artifactSizeBytes: input.totalSizeBytes,
      recordCount: input.recordCount,
      updatedAtMs: now,
    };
    const completedJob = clone({
      ...state.job,
      status: "completed" as const,
      completedAtMs: now,
      updatedAtMs: now,
    });
    delete completedJob.claimToken;
    delete completedJob.leaseUntilMs;
    delete completedJob.availableAtMs;
    delete completedJob.lastErrorCode;
    const prior = this.captureUserDataExportState();
    try {
      this.userDataExportArtifacts.set(artifact.artifactId, clone(readyArtifact));
      this.userDataExportRequests.set(state.request.requestId, clone(readyRequest));
      this.userDataExportJobs.set(state.job.requestId, completedJob);
      this.releaseUserDataExportSnapshot(state.request.requestId, authorization.buildGeneration, now);
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    validateUserDataExportRequestRecord(readyRequest);
    return clone(readyRequest);
  }

  async retryUserDataExport(
    authorization: UserDataExportAuthorization,
    input: RetryUserDataExportInput,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
      throw new Error("invalid data export retry delay");
    }
    if (input.maxAttempts !== undefined && (
      !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1
    )) throw new Error("invalid data export retry limit");
    const now = this.userDataExportNow();
    const state = this.activeUserDataExportClaim(authorization, now);
    if (!state) return false;
    if (!this.isUserDataExportSubjectCurrent(state.request)) {
      const prior = this.captureUserDataExportState();
      try {
        this.revokeUserDataExportsForSubject(authorization.tenantId, authorization.userId, now);
      } catch (error) {
        this.restoreUserDataExportState(prior);
        throw error;
      }
      return true;
    }
    const terminal = input.maxAttempts !== undefined && state.job.attempts >= input.maxAttempts;
    const prior = this.captureUserDataExportState();
    try {
      if (terminal) {
        if (state.job.currentArtifactId) {
          this.transitionUserDataExportArtifactToDeletePending(state.job.currentArtifactId, now);
        }
        this.releaseUserDataExportSnapshot(
          state.request.requestId,
          authorization.buildGeneration,
          now,
        );
        const failedJob = clone({
          ...state.job,
          status: "failed" as const,
          lastErrorCode: input.errorCode,
          updatedAtMs: now,
        });
        delete failedJob.claimToken;
        delete failedJob.leaseUntilMs;
        delete failedJob.availableAtMs;
        this.userDataExportJobs.set(state.job.requestId, failedJob);
        this.userDataExportRequests.set(state.request.requestId, clone({
          ...state.request,
          status: "failed" as const,
          lastErrorCode: input.errorCode,
          updatedAtMs: now,
        }));
      } else {
        const availableAtMs = now + input.delayMs;
        if (!Number.isSafeInteger(availableAtMs)) throw new Error("data export retry time overflow");
        const queuedJob = clone({
          ...state.job,
          status: "queued" as const,
          availableAtMs,
          lastErrorCode: input.errorCode,
          updatedAtMs: now,
        });
        delete queuedJob.claimToken;
        delete queuedJob.leaseUntilMs;
        this.userDataExportJobs.set(state.job.requestId, queuedJob);
        this.userDataExportRequests.set(state.request.requestId, clone({
          ...state.request,
          status: "queued" as const,
          lastErrorCode: input.errorCode,
          updatedAtMs: now,
        }));
      }
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    return true;
  }

  async scheduleUserDataExportDeletes(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("data export cleanup limit must be between 1 and 1000");
    }
    const now = this.userDataExportNow();
    const prior = this.captureUserDataExportState();
    try {
      for (const [key, lease] of this.userDataExportDownloadLeases) {
        if (lease.leaseUntilMs <= now) this.userDataExportDownloadLeases.delete(key);
      }
      const candidates = [...this.userDataExportArtifacts.values()]
        .filter((artifact) => {
          if (artifact.state === "deleted") return false;
          const request = this.userDataExportRequests.get(artifact.requestId);
          if (!request) throw new UserDataExportIntegrityError("export artifact request is missing");
          if (
            artifact.state === "ready"
            && [...this.userDataExportDownloadLeases.values()].some((lease) => (
              lease.artifactId === artifact.artifactId && lease.leaseUntilMs > now
            ))
          ) return false;
          if (artifact.state === "delete_pending") return true;
          if (request.status === "revoked" || request.status === "failed" || request.status === "expired") return true;
          if (artifact.state === "staging") {
            const job = this.userDataExportJobs.get(artifact.requestId);
            const activelyClaimed = job?.status === "building"
              && job.claimToken !== undefined
              && job.leaseUntilMs !== undefined
              && job.leaseUntilMs > now;
            return artifact.stagingExpiresAtMs <= now && !activelyClaimed;
          }
          if (artifact.state === "ready" && artifact.expiresAtMs !== undefined && artifact.expiresAtMs <= now) {
            return true;
          }
          return false;
        })
        .sort((left, right) => left.createdAtMs - right.createdAtMs || left.artifactId.localeCompare(right.artifactId))
        .slice(0, limit);
      for (const artifact of candidates) {
        const request = this.userDataExportRequests.get(artifact.requestId)!;
        if (artifact.state === "staging") {
          const job = this.userDataExportJobs.get(artifact.requestId);
          if (!job) throw new UserDataExportIntegrityError("export artifact job is missing");
          const failedJob = clone({
            ...job,
            status: "failed" as const,
            lastErrorCode: "artifact_invalid" as const,
            updatedAtMs: now,
          });
          delete failedJob.availableAtMs;
          delete failedJob.claimToken;
          delete failedJob.leaseUntilMs;
          this.userDataExportJobs.set(job.requestId, failedJob);
          this.userDataExportRequests.set(request.requestId, clone({
            ...request,
            status: "failed" as const,
            lastErrorCode: "artifact_invalid" as const,
            updatedAtMs: now,
          }));
          this.releaseUserDataExportSnapshot(request.requestId, artifact.buildGeneration, now);
        }
        if (artifact.state === "ready" && artifact.expiresAtMs! <= now && request.status === "ready") {
          this.userDataExportRequests.set(request.requestId, clone({
            ...request,
            status: "expired" as const,
            updatedAtMs: now,
          }));
        }
        this.transitionUserDataExportArtifactToDeletePending(artifact.artifactId, now);
      }
      return candidates.length;
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
  }

  private findUserDataExportDeleteOutboxById(
    outboxId: number,
  ): [string, UserDataExportDeleteOutboxRecord] | undefined {
    for (const entry of this.userDataExportDeleteOutbox) {
      if (entry[1].outboxId === outboxId) return entry;
    }
    return undefined;
  }

  private hydrateUserDataExportDeleteOutbox(
    row: UserDataExportDeleteOutboxRecord,
  ): UserDataExportDeleteOutboxRecord {
    const part = this.userDataExportParts.get(this.userDataExportPartKey(row.artifactId, row.partNumber));
    if (
      !part
      || part.requestId !== row.requestId
      || part.deletionGeneration !== row.deletionGeneration
      || (part.state !== "delete_pending" && part.state !== "deleted")
      || part.storageBackend !== row.storageBackend
      || part.storageFormat !== row.storageFormat
      || part.storageKey !== row.storageKey
      || part.uploadToken !== row.uploadToken
    ) throw new UserDataExportIntegrityError("data export delete outbox is corrupt");
    return clone(row);
  }

  async claimUserDataExportDeletes(
    options: ClaimUserDataExportDeletesOptions,
  ): Promise<UserDataExportDeleteOutboxRecord[]> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("data export delete claim limit must be between 1 and 100");
    }
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
      throw new Error("invalid data export delete lease");
    }
    if (!/^[A-Za-z0-9._:~-]{1,128}$/.test(options.claimToken)) {
      throw new Error("invalid data export delete claim token");
    }
    const now = this.userDataExportNow();
    const leaseUntilMs = now + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("data export delete lease overflow");
    const candidates = [...this.userDataExportDeleteOutbox.entries()]
      .filter(([, row]) => (
        row.completedAtMs === undefined
        && row.deadLetteredAtMs === undefined
        && row.availableAtMs <= now
        && (row.claimToken === undefined || (row.leaseUntilMs !== undefined && row.leaseUntilMs <= now))
      ))
      .sort((left, right) => left[1].outboxId - right[1].outboxId)
      .slice(0, options.limit);
    const claimed: UserDataExportDeleteOutboxRecord[] = [];
    const prior = this.captureUserDataExportState();
    try {
      for (const [key, row] of candidates) {
        this.hydrateUserDataExportDeleteOutbox(row);
        const next = clone({
          ...row,
          attempts: row.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        });
        delete next.lastError;
        this.userDataExportDeleteOutbox.set(key, next);
        claimed.push(next);
      }
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    return claimed.map(clone);
  }

  async renewUserDataExportDeleteClaim(
    outboxId: number,
    claimToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(outboxId) || outboxId < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error("invalid data export delete renewal");
    }
    const now = this.userDataExportNow();
    const entry = this.findUserDataExportDeleteOutboxById(outboxId);
    if (
      !entry
      || entry[1].claimToken !== claimToken
      || entry[1].leaseUntilMs === undefined
      || entry[1].leaseUntilMs <= now
      || entry[1].completedAtMs !== undefined
      || entry[1].deadLetteredAtMs !== undefined
    ) return false;
    const nextLease = now + leaseMs;
    if (!Number.isSafeInteger(nextLease)) throw new Error("data export delete lease overflow");
    this.hydrateUserDataExportDeleteOutbox(entry[1]);
    this.userDataExportDeleteOutbox.set(entry[0], clone({
      ...entry[1],
      leaseUntilMs: Math.max(entry[1].leaseUntilMs, nextLease),
    }));
    return true;
  }

  async completeUserDataExportDelete(outboxId: number, claimToken: string): Promise<boolean> {
    const now = this.userDataExportNow();
    const entry = this.findUserDataExportDeleteOutboxById(outboxId);
    if (
      !entry
      || entry[1].claimToken !== claimToken
      || entry[1].leaseUntilMs === undefined
      || entry[1].leaseUntilMs <= now
      || entry[1].completedAtMs !== undefined
      || entry[1].deadLetteredAtMs !== undefined
    ) return false;
    const row = this.hydrateUserDataExportDeleteOutbox(entry[1]);
    const partKey = this.userDataExportPartKey(row.artifactId, row.partNumber);
    const part = this.userDataExportParts.get(partKey)!;
    const completed = clone({ ...row, completedAtMs: now });
    delete completed.claimToken;
    delete completed.leaseUntilMs;
    delete completed.lastError;
    const prior = this.captureUserDataExportState();
    try {
      this.userDataExportParts.set(partKey, clone({
        ...part,
        state: "deleted" as const,
        deletedAtMs: now,
      }));
      this.userDataExportDeleteOutbox.set(entry[0], completed);
      const remaining = [...this.userDataExportParts.values()].some((candidate) => (
        candidate.artifactId === row.artifactId && candidate.state !== "deleted"
      ));
      if (!remaining) {
        const artifact = this.userDataExportArtifacts.get(row.artifactId);
        if (
          !artifact
          || artifact.state !== "delete_pending"
          || artifact.deletionGeneration !== row.deletionGeneration
        ) throw new UserDataExportIntegrityError("data export artifact delete state is corrupt");
        this.userDataExportArtifacts.set(row.artifactId, clone({
          ...artifact,
          state: "deleted" as const,
          deletedAtMs: now,
        }));
      }
    } catch (error) {
      this.restoreUserDataExportState(prior);
      throw error;
    }
    return true;
  }

  async retryUserDataExportDelete(
    outboxId: number,
    claimToken: string,
    input: RetryUserDataExportDeleteInput,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
      throw new Error("invalid data export delete retry delay");
    }
    if (input.maxAttempts !== undefined && (
      !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1
    )) throw new Error("invalid data export delete retry limit");
    const now = this.userDataExportNow();
    const entry = this.findUserDataExportDeleteOutboxById(outboxId);
    if (
      !entry
      || entry[1].claimToken !== claimToken
      || entry[1].leaseUntilMs === undefined
      || entry[1].leaseUntilMs <= now
      || entry[1].completedAtMs !== undefined
      || entry[1].deadLetteredAtMs !== undefined
    ) return false;
    this.hydrateUserDataExportDeleteOutbox(entry[1]);
    const next = clone({
      ...entry[1],
      lastError: sanitizeUserDataExportError(input.error),
    });
    delete next.claimToken;
    delete next.leaseUntilMs;
    if (input.maxAttempts !== undefined && next.attempts >= input.maxAttempts) {
      next.deadLetteredAtMs = now;
    } else {
      const availableAtMs = now + input.delayMs;
      if (!Number.isSafeInteger(availableAtMs)) throw new Error("data export delete retry time overflow");
      next.availableAtMs = availableAtMs;
    }
    this.userDataExportDeleteOutbox.set(entry[0], next);
    return true;
  }

  private lifecycleOutboxMapKey(topic: LifecycleOutboxRecord["topic"], aggregateId: string, generation: number) {
    return JSON.stringify([topic, aggregateId, generation]);
  }

  async getLifecycleOutbox(topic: LifecycleOutboxRecord["topic"], aggregateId: string, generation: number) {
    const row = this.lifecycleOutbox.get(this.lifecycleOutboxMapKey(topic, aggregateId, generation));
    if (!row) return null;
    assertLifecycleOutboxId(row.outboxId);
    const cloned = clone(row);
    const envelope = parseLifecycleOutboxEnvelope(cloned.topic, cloned.payload);
    if (envelope.payload.sessionId !== cloned.aggregateId || envelope.payload.deletionGeneration !== cloned.generation) {
      throw new Error(`lifecycle outbox ${cloned.outboxId} payload does not match its durable identity`);
    }
    return { ...cloned, ...envelope } as LifecycleOutboxRecord;
  }

  private findLifecycleOutboxById(outboxId: number): [string, LifecycleOutboxRecord] | undefined {
    for (const entry of this.lifecycleOutbox.entries()) {
      if (entry[1].outboxId === outboxId) return entry;
    }
    return undefined;
  }

  async claimLifecycleOutbox(options: import("./types.js").ClaimLifecycleOutboxOptions) {
    const { topics, leaseUntilMs } = validateClaimLifecycleOutboxOptions(options);
    if (topics.length === 0) return [];
    const allowed = new Set(topics);
    const candidates = [...this.lifecycleOutbox.entries()]
      .filter((row) => (
        allowed.has(row[1].topic)
        && row[1].availableAtMs !== undefined
        && row[1].availableAtMs <= options.nowMs
        && row[1].completedAtMs === undefined
        && row[1].deadLetteredAtMs === undefined
        && (row[1].claimToken === undefined || (row[1].leaseUntilMs !== undefined && row[1].leaseUntilMs <= options.nowMs))
      ))
      .sort((a, b) => (a[1].availableAtMs! - b[1].availableAtMs!) || (a[1].outboxId - b[1].outboxId))
      .slice(0, options.limit);
    const staged = new Map<string, LifecycleOutboxRecord>();
    const claimed: LifecycleOutboxRecord[] = [];
    for (const [key, row] of candidates) {
      try {
        assertLifecycleOutboxId(row.outboxId);
        const cloned = clone(row);
        const envelope = parseLifecycleOutboxEnvelope(cloned.topic, cloned.payload);
        if (envelope.payload.sessionId !== cloned.aggregateId || envelope.payload.deletionGeneration !== cloned.generation) {
          throw new Error(`lifecycle outbox ${cloned.outboxId} payload does not match its durable identity`);
        }
        const next = {
          ...cloned,
          ...envelope,
          attempts: row.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        } as LifecycleOutboxRecord;
        staged.set(key, next);
        claimed.push(next);
      } catch {
        // A corrupt durable envelope cannot become valid by retrying and must not starve every
        // well-formed row behind it. Quarantine it without exposing its payload in durable errors.
        const poison = clone(row);
        poison.attempts += 1;
        poison.lastError = "invalid lifecycle outbox envelope";
        poison.deadLetteredAtMs = options.nowMs;
        delete poison.availableAtMs;
        delete poison.claimToken;
        delete poison.leaseUntilMs;
        staged.set(key, poison);
      }
    }

    for (const [key, row] of staged) this.lifecycleOutbox.set(key, row);
    return claimed.map(clone);
  }

  async renewLifecycleOutboxClaim(
    outboxId: number,
    claimToken: string,
    options: import("./types.js").RenewLifecycleOutboxClaimOptions,
  ) {
    const leaseUntilMs = validateRenewLifecycleOutboxClaim(outboxId, claimToken, options.nowMs, options.leaseMs);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.topic !== "session.tombstoned"
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.nowMs
    ) return false;
    row.leaseUntilMs = Math.max(row.leaseUntilMs, leaseUntilMs);
    return true;
  }

  async completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number) {
    validateLifecycleOutboxAck(outboxId, claimToken, completedAtMs);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.topic !== "session.tombstoned"
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= completedAtMs
    ) return false;
    row.completedAtMs = completedAtMs;
    delete row.claimToken;
    delete row.leaseUntilMs;
    delete row.lastError;
    return true;
  }

  async retryLifecycleOutbox(
    outboxId: number,
    claimToken: string,
    options: import("./types.js").RetryLifecycleOutboxOptions,
  ) {
    validateLifecycleOutboxAck(outboxId, claimToken, options.failedAtMs);
    validateRetryLifecycleOutboxOptions(options);
    const lastError = sanitizeLifecycleOutboxError(options.error);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.topic !== "session.tombstoned"
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.failedAtMs
    ) return false;
    delete row.claimToken;
    delete row.leaseUntilMs;
    row.lastError = lastError;
    if (options.maxAttempts !== undefined && row.attempts >= options.maxAttempts) {
      delete row.availableAtMs;
      row.deadLetteredAtMs = options.failedAtMs;
    } else {
      row.availableAtMs = options.availableAtMs;
    }
    return true;
  }

  async close() {}
}

export class MemoryLeaseStore implements LeaseStore {
  leases = new Map<string, { ownerId: string; ownerAddr: string; fence: number; expiresAt: number }>();
  fences = new Map<string, number>();

  async acquire(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): Promise<LeaseAcquireResult | LeaseConflict> {
    const cur = this.leases.get(sessionId);
    const now = Date.now();
    if (cur && cur.expiresAt > now && cur.ownerId !== ownerId) return { ok: false, ownerId: cur.ownerId, ownerAddr: cur.ownerAddr };
    if (cur && cur.expiresAt > now && cur.ownerId === ownerId) {
      cur.expiresAt = now + ttlMs;
      return { ok: true, fence: cur.fence };
    }
    const fence = (this.fences.get(sessionId) ?? 0) + 1;
    this.fences.set(sessionId, fence);
    this.leases.set(sessionId, { ownerId, ownerAddr, fence, expiresAt: now + ttlMs });
    return { ok: true, fence };
  }
  async renew(sessionId: string, ownerId: string, ttlMs: number) {
    const cur = this.leases.get(sessionId);
    if (!cur || cur.ownerId !== ownerId || cur.expiresAt <= Date.now()) return false;
    cur.expiresAt = Date.now() + ttlMs;
    return true;
  }
  async release(sessionId: string, ownerId: string) {
    const cur = this.leases.get(sessionId);
    if (cur && cur.ownerId === ownerId) this.leases.delete(sessionId);
  }
  async getOwner(sessionId: string) {
    const cur = this.leases.get(sessionId);
    if (!cur || cur.expiresAt <= Date.now()) return null;
    return { ownerId: cur.ownerId, ownerAddr: cur.ownerAddr, fence: cur.fence };
  }
  /** test helper: expire a lease as if TTL passed */
  expire(sessionId: string) {
    const cur = this.leases.get(sessionId);
    if (cur) cur.expiresAt = 0;
  }
  async close() {}
}

export class MemoryEventBus implements EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private hot = new Map<string, PersistedEvent[]>();
  constructor(private readonly hotWindow = 1000) {}

  async publish(sessionId: string, event: Event) {
    if (typeof (event as { seq?: number }).seq === "number") {
      const buf = this.hot.get(sessionId) ?? [];
      buf.push(event as PersistedEvent);
      if (buf.length > this.hotWindow) buf.splice(0, buf.length - this.hotWindow);
      this.hot.set(sessionId, buf);
    }
    for (const l of this.listeners.get(sessionId) ?? []) l(clone(event));
  }
  async subscribe(sessionId: string, listener: EventListener, opts?: import("./types.js").EventSubscriptionOptions) {
    if (opts?.afterSeq !== undefined) {
      for (const e of this.hot.get(sessionId) ?? []) if (e.seq > opts.afterSeq) listener(clone(e));
    }
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  async close() {
    this.listeners.clear();
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly backend = "memory-v1";
  private readonly blobs = new Map<string, { descriptor: BlobDescriptor; data: Buffer }>();
  private readonly cancelledStorageKeys = new Set<string>();

  async putIfAbsent(
    storageKey: string,
    data: Buffer | string,
    options: import("./types.js").BlobPutOptions,
  ) {
    validateBlobKey(storageKey);
    validateBlobUploadToken(options.uploadToken);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const contentType = validateBlobContentType(options.contentType);
    const sizeBytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (sizeBytes > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, sizeBytes);
    if (this.cancelledStorageKeys.has(storageKey)) {
      throw new Error(`blob upload ${storageKey} was cancelled before publication`);
    }

    // The ceiling is checked before this defensive allocation and before the async method yields.
    const snapshot = Buffer.from(data);
    const descriptor: BlobDescriptor = {
      storageKey,
      sha256: createHash("sha256").update(snapshot).digest("hex"),
      sizeBytes: snapshot.byteLength,
      contentType,
    };
    const existing = this.blobs.get(storageKey);
    if (existing) {
      const matches = existing.descriptor.sha256 === descriptor.sha256
        && existing.descriptor.sizeBytes === descriptor.sizeBytes
        && existing.descriptor.contentType === descriptor.contentType;
      if (!matches) throw new BlobConflictError(storageKey);
      return { ...existing.descriptor };
    }
    this.blobs.set(storageKey, { descriptor, data: snapshot });
    return { ...descriptor };
  }

  async get(storageKey: string, options: import("./types.js").BlobReadOptions) {
    validateBlobKey(storageKey);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const blob = this.blobs.get(storageKey);
    if (!blob) return null;
    if (blob.data.byteLength > maxBytes) {
      throw new BlobTooLargeError(storageKey, maxBytes, blob.data.byteLength);
    }
    return { ...blob.descriptor, data: Buffer.from(blob.data) };
  }

  async delete(storageKey: string, options: import("./types.js").BlobDeleteOptions = {}) {
    validateBlobKey(storageKey);
    if (options.uploadToken !== undefined) {
      validateBlobUploadToken(options.uploadToken);
      // Mirror the durable adapter contract: a manifest-driven delete permanently fences this
      // globally unique key, including when deletion linearizes before a delayed upload begins.
      this.cancelledStorageKeys.add(storageKey);
    }
    this.blobs.delete(storageKey);
  }
}
