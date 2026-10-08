import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import type { AgentDefinition, ApiKeyScope, Approval, EventInput, Item, PersistedEvent, ProviderConfig, Session, TenantAuthPolicy, Turn, UsageQuery } from "@agent-service/protocol";
import {
  Approval as ApprovalSchema,
  DEFAULT_AUTH_POLICY,
  DEFAULT_SCOPES,
  Event as EventSchema,
  Item as ItemSchema,
  Session as SessionSchema,
  SessionStatus as SessionStatusSchema,
  Turn as TurnSchema,
  isCanonicalId,
} from "@agent-service/protocol";
import {
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
  assertPureFenceClaim,
  assertCommitResourceOwnership,
  assertTombstoneEvent,
  assignItemSeqs,
  assignTurnSeqEnd,
  backfillAssignedSequences,
  type ApiKeyRecord,
  type AnonymizeSessionUsageInput,
  type BillingUsageFact,
  type CommitBatch,
  type CommitResult,
  type IdempotencyReceipt,
  type IdempotencyScope,
  type LifecycleOutboxRecord,
  type LifecycleOutboxStore,
  type Page,
  type ReconcileSessionUsageInput,
  type SessionStore,
  type SessionLifecycleRecord,
  type TenantRecord,
  type UsageLedgerEntry,
  type UsageLifecycleStore,
  type UsageReconciliationRecord,
  type UsageReconciliationSummary,
} from "../types.js";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  assertBlobBindingsMatch,
  blobBindingsFromItems,
  isUnexpiredStagingBlob,
  sanitizeBlobDeleteError,
  validateBlobDeleteAck,
  validateBlobDeleteClaim,
  type BlobCleanupStore,
  type BlobBinding,
  type BindableBlobLookup,
  type BlobDeleteOutboxRecord,
  type BlobManifest,
  type BlobManifestStore,
  type ClaimBlobDeletesOptions,
  type MarkBlobUploadedInput,
  type ReadyBlobLookup,
  type RetryBlobDeleteOptions,
  type ScheduleStaleBlobsOptions,
  type StageBlobInput,
} from "../blob-lifecycle.js";
import { validateBlobKey, validateBlobUploadToken } from "../blob/key.js";
import {
  assertLifecycleOutboxId,
  parseLifecycleOutboxEnvelope,
  sanitizeLifecycleOutboxError,
  validateClaimLifecycleOutboxOptions,
  validateLifecycleOutboxAck,
  validateRenewLifecycleOutboxClaim,
  validateRetryLifecycleOutboxOptions,
} from "../lifecycle-outbox.js";
import {
  UsageIdentityConflictError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  assertBillingUsageFact,
  assertUsageAnonymizationAllowed,
  billingUsageFactContentEquals,
  billingUsageFactFromLedger,
  canonicalBillingCostCNY,
  canonicalizePersistedUsageEventFromSummaries,
  canonicalizeUsageItem,
  emptyUsageProjectionSummary,
  isUsageId,
  mergeUsageProjectionSummaries,
  newUsageId,
  normalizeHistoricalUsageCost,
  normalizeOperationalUsageCost,
  normalizeRowlessUsageProjection,
  summarizeBillingUsageFacts,
  summarizeUsageProjectionRows,
  usageReconciliationSummariesEqual,
  usageProjectionFromSummary,
  usageProjectionStepKey,
  validateReconcileSessionUsageInput,
  type UsageProjectionLedgerRow,
  type UsageProjectionSummary,
} from "../usage-lifecycle.js";
import {
  CLAIMABLE_ERASURE_REQUEST_STATUSES,
  ErasureJobIntegrityFault,
  ErasureIdempotencyMismatchError,
  SubjectDeletingError,
  classifyErasureJobRecordFault,
  deriveBlockedErasureResumePhase,
  erasureJobClaimFromRecord,
  erasureJobAllowedMaintenanceActions,
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
  userErasureRequestHash,
  validateClaimErasureJobsOptions,
  validateErasureJobAuthorization,
  validateErasureAuditChain,
  validateErasureJobControlAudit,
  validateErasureJobControlEvent,
  validateErasureJobMaintenanceIdentity,
  validateErasureRequestRecord,
  validateErasureRequestRecordForRead,
  validateErasureWriteAuthorization,
  validateRepairAndResumeErasureJobInput,
  validateRequestUserErasureInput,
  validateRenewErasureJobClaimOptions,
  validateRetryErasureJobOptions,
  validateTransitionErasureJobOptions,
  type ClaimErasureJobsOptions,
  type DataSubjectKind,
  type ErasureAuditEvent,
  type ErasureJobControlEvent,
  type ErasureJobAuthorization,
  type ErasureJobClaim,
  type ErasureJobInterventionInspection,
  type ErasureJobMaintenanceIdentity,
  type ErasureJobMaintenanceStore,
  type ErasureJobStore,
  type ErasureJobUnsafeQuarantineEnvelope,
  type ErasureRequestRecord,
  type ErasureRequestStatus,
  type ErasureWriteAuthorization,
  type RequestUserErasureInput,
  type RepairAndResumeErasureJobInput,
  type RetryErasureJobOptions,
  type RenewErasureJobClaimOptions,
  type SubjectLifecycleRecord,
  type SubjectLifecycleState,
  type SubjectLifecycleStore,
  type TransitionErasureJobOptions,
} from "../subject-lifecycle.js";
import {
  validateErasureSessionAction,
  type ErasureSessionAction,
  type ErasureSessionHead,
  type ErasureSessionStore,
} from "../erasure-session.js";
import {
  validateErasureProgressQuery,
  validateErasureSessionQuery,
  type ErasureProgressQuery,
  type ErasureSessionCatalogStore,
  type ErasureSessionPage,
  type ErasureSessionQuery,
  type ErasureSessionRef,
  type ErasureSubjectProgress,
} from "../erasure-catalog.js";
import {
  ErasureTombstoneIntegrityError,
  validateErasureUsageReconciliationInput,
  type ErasureUsageReconciliationInput,
  type ErasureUsageReconciliationStore,
} from "../erasure-usage.js";
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
  type RenewLegacyTombstoneCompensationOptions,
  type RetryLegacyTombstoneCompensationOptions,
  type ScheduleLegacyTombstoneCandidatesOptions,
  type ScheduleLegacyTombstoneCompensationInput,
} from "../legacy-tombstone.js";
import {
  LEGAL_HOLD_REASON_CODES,
  LEGAL_HOLD_RELEASE_REASON_CODES,
  RETENTION_POLICY_DURATION_FIELDS,
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
  type RetentionPolicyDocumentV1,
  type RetentionPolicyStore,
  type RetentionPolicyVersionRecord,
  type SetLegalHoldInput,
} from "../retention-policy.js";
import {
  EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
  ErasurePurgeEvidenceChangedError,
  checkedRetentionDeadline,
  erasurePolicyDecisionSha256,
  erasurePurgeAuthorityMatchesDecision,
  erasurePurgeAuthoritySha256,
  erasurePurgeTargetMatchesRetentionPolicy,
  erasurePurgeTargetEvidenceSha256,
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
} from "../erasure-purge-policy.js";
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
  nextUserDataExportSnapshotRootSha256,
  sanitizeExportEvent,
  sanitizeExportSession,
  sanitizeExportTurn,
  sanitizeUserDataExportError,
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
  type UserDataExportSnapshotBlob,
  type UserDataExportSnapshotBlobPage,
  type UserDataExportSnapshotEntry,
  type UserDataExportSnapshotRecord,
  type UserDataExportSnapshotRecordPage,
  type UserDataExportSnapshotSummary,
} from "../data-export.js";

type Row = RowDataPacket;
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : (v as T));
const BLOB_COLUMNS = `blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend,
  storage_format, storage_key, upload_token, state, sha256, size_bytes, content_type,
  uploaded_at_ms, ready_at_ms, staging_expires_at_ms, delete_after_ms, deleted_at_ms,
  deletion_generation, created_at_ms`;
const QUALIFIED_BLOB_COLUMNS = `b.blob_id, b.tenant_id, b.user_id, b.session_id, b.item_id, b.purpose,
  b.storage_backend, b.storage_format, b.storage_key, b.upload_token, b.state, b.sha256, b.size_bytes,
  b.content_type, b.uploaded_at_ms, b.ready_at_ms, b.staging_expires_at_ms, b.delete_after_ms,
  b.deleted_at_ms, b.deletion_generation, b.created_at_ms`;
const BLOB_DELETE_COLUMNS = `o.outbox_id, o.blob_id, o.generation, o.available_at_ms, o.attempts,
  o.claim_token, o.lease_until_ms, o.last_error, o.completed_at_ms, o.dead_lettered_at_ms, o.created_at_ms,
  b.storage_backend, b.storage_format, b.storage_key, b.upload_token, b.state, b.deletion_generation`;
const BILLING_USAGE_COLUMNS = `usage_id, tenant_id, accounting_period, provider, model, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny,
  currency, fact_sha256`;
const USAGE_RECONCILIATION_COLUMNS = `tenant_id, user_id, session_id, deletion_generation, status,
  row_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  total_tokens, known_cost_rows, cost_cny, checksum, verified_at_ms, anonymized_at_ms`;
const SUBJECT_LIFECYCLE_COLUMNS = `tenant_id, subject_kind, subject_id, state, generation,
  active_request_id, legal_hold_at_ms, created_at_ms, updated_at_ms`;
const ERASURE_REQUEST_COLUMNS = `request_id, tenant_id, subject_kind, subject_id, generation, status,
  requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms, updated_at_ms,
  completed_at_ms, counts_json, checksum, available_at_ms, attempts, claim_token, lease_until_ms,
  last_error_code, policy_version, policy_hash, control_generation, quarantined_at_ms,
  quarantine_reason_code, quarantine_evidence_sha256`;
const ERASURE_CONTROL_EVENT_COLUMNS = `control_event_id, request_id, control_generation, event_type,
  phase, reason_code, action_code, actor_key_id, before_sha256, after_sha256, emitted_at_ms`;
const LEGACY_TOMBSTONE_JOB_COLUMNS = `job_id, session_id, tenant_id, user_id, source_kind,
  source_request_id, source_subject_generation, source_claim_attempt, source_claim_token_sha256,
  maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256, status,
  control_generation, available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
  created_at_ms, updated_at_ms, completed_at_ms, completed_event_seq, completed_claim_attempt,
  completed_claim_token_sha256, terminal_at_ms, terminal_reason_code, terminal_evidence_sha256`;
const LEGACY_TOMBSTONE_EVENT_COLUMNS = `result_event_id, job_id, session_id, control_generation,
  event_type, reason_code, actor_key_id, claim_attempt, source_deleted_at_ms,
  target_deletion_generation, terminal_event_seq, before_sha256, after_sha256, emitted_at_ms`;
const RETENTION_POLICY_VERSION_COLUMNS = `tenant_id, policy_version, schema_version,
  session_content_retention_ms, user_erasure_grace_ms, operational_usage_retention_ms,
  idempotency_receipt_retention_ms, billing_fact_retention_ms, lifecycle_audit_retention_ms,
  export_artifact_ttl_ms, policy_sha256, created_by_key_id, created_at_ms`;
const RETENTION_POLICY_CONTROL_COLUMNS = `tenant_id, control_generation, active_policy_version,
  active_policy_sha256, effective_at_ms, updated_at_ms`;
const RETENTION_POLICY_ACTIVATION_EVENT_COLUMNS = `event_id, tenant_id, control_generation,
  policy_version, policy_sha256, effective_at_ms, actor_key_id, before_sha256, after_sha256,
  emitted_at_ms`;
const LEGAL_HOLD_CONTROL_COLUMNS = `tenant_id, subject_kind, subject_id, control_generation,
  active_hold_count, active_projection_sha256, updated_at_ms`;
const LEGAL_HOLD_COLUMNS = `tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
  external_reference_sha256, created_control_generation, created_by_key_id, created_at_ms,
  released_control_generation, released_by_key_id, released_at_ms, release_reason_code`;
const LEGAL_HOLD_EVENT_COLUMNS = `event_id, tenant_id, subject_kind, subject_id,
  control_generation, hold_id, event_type, reason_code, external_reference_sha256, actor_key_id,
  before_sha256, after_sha256, emitted_at_ms`;
const ERASURE_POLICY_EVALUATION_JOB_COLUMNS = `request_id, tenant_id, subject_kind, subject_id,
  subject_generation, build_generation, cursor_session_id, target_count, target_root_sha256,
  available_at_ms, attempts, claim_token, lease_until_ms, last_error_code, sealed_at_ms,
  created_at_ms, updated_at_ms`;
const ERASURE_PURGE_TARGET_COLUMNS = `request_id, build_generation, tenant_id, user_id, session_id,
  deletion_generation, deleted_at_ms, session_content_deadline_ms, ready_blob_count,
  ready_blob_root_sha256, ready_blob_deadline_ms, operational_usage_status,
  operational_usage_verified_at_ms, operational_usage_checksum,
  operational_usage_deadline_ms, idempotency_receipt_count,
  idempotency_receipt_deadline_ms, export_artifact_disposition, billing_fact_disposition,
  lifecycle_audit_disposition, issue_codes, evidence_sha256`;
const ERASURE_POLICY_DECISION_COLUMNS = `request_id, decision_seq, build_generation, decision,
  policy_version, policy_sha256, user_grace_deadline_ms, eligibility_deadline_ms, target_count,
  target_root_sha256, tenant_hold_control_generation, tenant_hold_projection_sha256,
  user_hold_control_generation, user_hold_projection_sha256, before_sha256, after_sha256,
  decided_at_ms`;
const ERASURE_PURGE_AUTHORITY_COLUMNS = `request_id, authority_generation, tenant_id, subject_kind,
  subject_id, subject_generation, build_generation, policy_version, policy_sha256,
  policy_schema_version, user_grace_deadline_ms, eligibility_deadline_ms, target_count,
  target_root_sha256, tenant_hold_control_generation, tenant_hold_projection_sha256,
  user_hold_control_generation, user_hold_projection_sha256, decision_sha256, authority_sha256,
  created_at_ms`;
const USER_EXPORT_REQUEST_COLUMNS = `r.request_id, r.tenant_id, r.user_id,
  r.subject_generation, r.requested_by_key_id, r.idempotency_key_sha256, r.request_sha256,
  r.export_format, r.export_schema_version, r.policy_version, r.policy_sha256, r.artifact_ttl_ms,
  r.status, r.active_build_generation, r.active_artifact_id, r.last_error_code, r.created_at_ms,
  r.updated_at_ms, r.snapshot_at_ms, r.ready_at_ms, r.expires_at_ms, r.revoked_at_ms,
  a.content_sha256 AS active_artifact_sha256,
  a.total_size_bytes AS active_artifact_size_bytes,
  a.record_count AS active_artifact_record_count,
  a.state AS active_artifact_state`;
const USER_EXPORT_JOB_COLUMNS = `request_id, tenant_id, user_id, subject_generation,
  build_generation, status, active_artifact_id, available_at_ms, attempts, claim_token,
  lease_until_ms, last_error_code, snapshot_at_ms, snapshot_record_count, snapshot_blob_count,
  snapshot_root_sha256, snapshot_sealed_at_ms, created_at_ms, updated_at_ms, completed_at_ms`;
const USER_EXPORT_ARTIFACT_COLUMNS = `artifact_id, request_id, tenant_id, user_id,
  subject_generation, build_generation, export_format, export_schema_version, content_type,
  content_encoding, storage_backend, storage_format, state, part_count, record_count,
  total_size_bytes, manifest_sha256, content_sha256, snapshot_root_sha256, policy_version,
  policy_sha256, artifact_ttl_ms, snapshot_at_ms, staging_expires_at_ms, ready_at_ms,
  expires_at_ms, delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms,
  updated_at_ms`;
const USER_EXPORT_PART_COLUMNS = `artifact_id, part_number, request_id, build_generation,
  tenant_id, user_id, subject_generation, state, storage_backend, storage_format, storage_key,
  upload_token, content_type, content_encoding, sha256, size_bytes, record_count,
  staging_expires_at_ms, uploaded_at_ms, delete_after_ms, deleted_at_ms,
  deletion_generation, created_at_ms, updated_at_ms`;
const USER_EXPORT_DELETE_COLUMNS = `outbox_id, artifact_id, part_number, request_id,
  build_generation, deletion_generation, storage_backend, storage_format, storage_key,
  upload_token, expected_sha256, expected_size_bytes, available_at_ms, attempts, claim_token,
  lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms`;
const EMPTY_LEGAL_HOLD_PROJECTION_SHA256 = legalHoldProjectionSha256([]);
interface LegalHoldContext {
  lifecycle?: SubjectLifecycleRecord;
  control: LegalHoldControlRecord;
  holds: LegalHoldRecord[];
  events: LegalHoldEvent[];
}
const LEGACY_TOMBSTONE_JOB_EVIDENCE_FIELDS = [
  "job_id",
  "session_id",
  "tenant_id",
  "user_id",
  "source_kind",
  "source_request_id",
  "source_subject_generation",
  "source_claim_attempt",
  "source_claim_token_sha256",
  "maintenance_actor_key_id",
  "source_deleted_at_ms",
  "source_last_seq",
  "candidate_sha256",
  "status",
  "control_generation",
  "available_at_ms",
  "attempts",
  "claim_token",
  "lease_until_ms",
  "last_error_code",
  "created_at_ms",
  "updated_at_ms",
  "completed_at_ms",
  "completed_event_seq",
  "completed_claim_attempt",
  "completed_claim_token_sha256",
  "terminal_at_ms",
  "terminal_reason_code",
  "terminal_evidence_sha256",
] as const;
const LEGACY_TOMBSTONE_EVENT_EVIDENCE_FIELDS = [
  "result_event_id",
  "job_id",
  "session_id",
  "control_generation",
  "event_type",
  "reason_code",
  "actor_key_id",
  "claim_attempt",
  "source_deleted_at_ms",
  "target_deletion_generation",
  "terminal_event_seq",
  "before_sha256",
  "after_sha256",
  "emitted_at_ms",
] as const;
const USAGE_OWNER_MATCH = "u.tenant_id=s.tenant_id AND u.user_id=s.user_id";
const usageJsonNumber = (field: string) => (
  `CASE WHEN JSON_TYPE(JSON_EXTRACT(u.usage_json,'$.${field}')) IN ('INTEGER','DOUBLE','DECIMAL') `
  + `THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(u.usage_json,'$.${field}')) AS DECIMAL(30,9)) ELSE 0 END`
);
const USAGE_COST_NUMBER = usageJsonNumber("costCNY");
const USAGE_PRICE_KNOWN = `JSON_TYPE(JSON_EXTRACT(u.usage_json,'$.costCNY')) IN ('INTEGER','DOUBLE','DECIMAL')
  AND NOT (u.usage_id IS NULL AND ${USAGE_COST_NUMBER}=0)`;

interface ExistingCommitResources {
  itemIds: Set<string>;
  turnIds: Set<string>;
  approvalIds: Set<string>;
}

interface LockedErasureMaintenanceContext {
  tenant?: SubjectLifecycleRecord;
  subject?: SubjectLifecycleRecord;
  record: ErasureRequestRecord;
  rawControlGeneration: string;
  auditRows: Row[];
  controlRows: Row[];
}

interface DecodedErasureRequestEnvelope {
  record: ErasureRequestRecord;
  /** Exact unsigned BIGINT text, retained only inside the locked store path for CAS/evidence. */
  rawControlGeneration: string;
  controlGenerationSaturated: boolean;
}

interface ErasureClaimCandidate {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  subjectGeneration: number;
}

type ErasureClaimCandidateResult =
  | { kind: "skipped" }
  | { kind: "consumed"; record?: ErasureRequestRecord };

function legacyTombstoneSha256(domain: string, values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([domain, ...values])).digest("hex");
}

function legacyTombstoneCutoverEvidenceSha256(
  actorKeyId: string,
  activatedAtMs: number,
): string {
  return legacyTombstoneSha256("legacy-tombstone-cutover-v1", [
    LEGACY_TOMBSTONE_CUTOVER_ID,
    1,
    actorKeyId,
    activatedAtMs,
  ]);
}

function legacyTombstoneCandidateSha256(input: {
  sessionId: string;
  tenantId: string;
  userId: string;
  deletedAtMs: number;
  lastSeq: number;
}): string {
  return legacyTombstoneSha256("legacy-tombstone-candidate-v1", [
    input.sessionId,
    input.tenantId,
    input.userId,
    input.deletedAtMs,
    input.lastSeq,
  ]);
}

function legacyTombstoneRawField(row: Row, field: string): string | null {
  return row[field] == null ? null : String(row[field]);
}

function legacyTombstoneMissingResultEvidenceSha256(row: Row, emittedAtMs: number): string {
  return legacyTombstoneSha256("legacy-tombstone-missing-result-v1", [
    ...LEGACY_TOMBSTONE_JOB_EVIDENCE_FIELDS.map((field) => legacyTombstoneRawField(row, field)),
    "proof_conflict",
    emittedAtMs,
  ]);
}

function legacyTombstoneMismatchedResultEvidenceSha256(
  row: Row,
  resultRows: readonly Row[],
): string {
  return legacyTombstoneSha256("legacy-tombstone-mismatched-result-v1", [
    ...LEGACY_TOMBSTONE_JOB_EVIDENCE_FIELDS.map((field) => legacyTombstoneRawField(row, field)),
    resultRows.map((resultRow) => (
      LEGACY_TOMBSTONE_EVENT_EVIDENCE_FIELDS.map((field) => (
        legacyTombstoneRawField(resultRow, field)
      ))
    )),
    "proof_conflict",
  ]);
}

function legacyTombstoneJobIdForRawSession(sessionId: string): string {
  try {
    return legacyTombstoneCompensationJobIdForSession(sessionId);
  } catch {
    const hex = createHash("sha256")
      .update(JSON.stringify(["legacy-tombstone-raw-job-v1", sessionId]))
      .digest("hex")
      .slice(0, 32)
      .split("");
    hex[12] = "4";
    hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
    const value = hex.join("");
    return `ltc_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
}

function rowToLegacyTombstoneCompensationJob(row: Row): LegacyTombstoneCompensationJobRecord {
  const common = {
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    cutoverGeneration: Number(row.control_generation) as 1,
    legacyDeletedAtMs: Number(row.source_deleted_at_ms),
    status: String(row.status) as LegacyTombstoneCompensationJobRecord["status"],
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    ...(row.available_at_ms == null ? {} : { availableAtMs: Number(row.available_at_ms) }),
    attempts: Number(row.attempts),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error_code == null
      ? {}
      : { lastErrorCode: String(row.last_error_code) as LegacyTombstoneCompensationJobRecord["lastErrorCode"] }),
    ...(row.completed_at_ms == null ? {} : { completedAtMs: Number(row.completed_at_ms) }),
    ...(row.completed_event_seq == null ? {} : { completedEventSeq: Number(row.completed_event_seq) }),
    ...(row.completed_claim_attempt == null
      ? {}
      : { completedClaimAttempt: Number(row.completed_claim_attempt) }),
    ...(row.completed_claim_token_sha256 == null
      ? {}
      : { completedClaimTokenSha256: String(row.completed_claim_token_sha256) }),
    ...(row.terminal_at_ms == null ? {} : { terminalAtMs: Number(row.terminal_at_ms) }),
    ...(row.terminal_reason_code == null
      ? {}
      : { terminalReasonCode: String(row.terminal_reason_code) as LegacyTombstoneTerminalReasonCode }),
    ...(row.terminal_evidence_sha256 == null
      ? {}
      : { terminalEvidenceSha256: String(row.terminal_evidence_sha256) }),
  };
  const record: LegacyTombstoneCompensationJobRecord = row.source_kind === "maintenance"
    ? {
        ...common,
        sourceKind: "maintenance",
        maintenanceActorKeyId: String(row.maintenance_actor_key_id),
      }
    : {
        ...common,
        sourceKind: "erasure_claim",
        sourceRequestId: String(row.source_request_id),
        sourceSubjectGeneration: Number(row.source_subject_generation),
        sourceClaimAttempt: Number(row.source_claim_attempt),
        sourceClaimTokenSha256: String(row.source_claim_token_sha256),
      };
  validateLegacyTombstoneCompensationJobRecord(record);
  return record;
}

function rowToLegacyTombstoneUnsafeEnvelope(row: Row) {
  return {
    locatorJobId: String(row.job_id),
    jobId: String(row.job_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    sourceRequestId: row.source_request_id == null ? null : String(row.source_request_id),
    sourceKind: String(row.source_kind),
    rawSourceSubjectGeneration: row.source_subject_generation == null
      ? null
      : String(row.source_subject_generation),
    rawSourceClaimAttempt: row.source_claim_attempt == null ? null : String(row.source_claim_attempt),
    sourceClaimTokenSha256: row.source_claim_token_sha256 == null
      ? null
      : String(row.source_claim_token_sha256),
    maintenanceActorKeyId: row.maintenance_actor_key_id == null
      ? null
      : String(row.maintenance_actor_key_id),
    rawCutoverGeneration: String(row.control_generation),
    rawLegacyDeletedAtMs: String(row.source_deleted_at_ms),
    status: String(row.status),
    rawCreatedAtMs: String(row.created_at_ms),
    rawUpdatedAtMs: String(row.updated_at_ms),
    rawAvailableAtMs: row.available_at_ms == null ? null : String(row.available_at_ms),
    rawAttempts: String(row.attempts),
    claimToken: row.claim_token == null ? null : String(row.claim_token),
    rawLeaseUntilMs: row.lease_until_ms == null ? null : String(row.lease_until_ms),
  };
}

function rowToLegacyTombstoneAudit(row: Row): LegacyTombstoneCompensationAudit {
  const base = {
    auditId: Number(row.result_event_id),
    jobId: String(row.job_id),
    evidenceSha256: String(row.after_sha256 ?? row.before_sha256),
    emittedAtMs: Number(row.emitted_at_ms),
  };
  const audit: LegacyTombstoneCompensationAudit = row.event_type === "legacy_tombstone/compensated"
    ? {
        ...base,
        type: "legacy_tombstone/compensated",
        sessionId: String(row.session_id),
        cutoverGeneration: Number(row.control_generation) as 1,
        deletionGeneration: Number(row.target_deletion_generation) as 1,
        eventSeq: Number(row.terminal_event_seq),
        claimAttempt: Number(row.claim_attempt),
      }
    : {
        ...base,
        type: "legacy_tombstone/terminal_incident",
        reasonCode: String(row.reason_code) as LegacyTombstoneTerminalReasonCode,
      };
  validateLegacyTombstoneCompensationAudit(audit);
  return audit;
}

function rowToLegacyTombstoneCutover(row: Row): LegacyTombstoneCutoverRecord | null {
  const generation = Number(row.control_generation);
  if (
    generation === 0
    && row.activated_at_ms == null
    && row.actor_key_id == null
    && row.evidence_sha256 == null
  ) return null;
  const record: LegacyTombstoneCutoverRecord = {
    cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
    generation: generation as 1,
    activatedByKeyId: String(row.actor_key_id),
    activatedAtMs: Number(row.activated_at_ms),
  };
  validateLegacyTombstoneCutoverRecord(record);
  if (
    String(row.evidence_sha256)
      !== legacyTombstoneCutoverEvidenceSha256(record.activatedByKeyId, record.activatedAtMs)
  ) throw new Error("stored legacy tombstone cutover evidence is invalid");
  return record;
}

/** Serialize a Session row. The projection columns are the source for filtering; `body` holds the rest. */
function rowToSession(r: Row): Session {
  const usage = normalizeHistoricalUsageCost(parse<Session["usage"]>(r.usage_json));
  return {
    id: r.session_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    agentId: r.agent_id,
    agentVersion: r.agent_version,
    status: parse(r.status),
    title: r.title ?? undefined,
    parentSessionId: r.parent_session_id ?? undefined,
    lastSeq: Number(r.last_seq),
    fenceToken: Number(r.fence_token),
    contextEpoch: r.context_epoch,
    usage,
    autoApprovedTools: r.auto_approved_tools == null ? [] : parse(r.auto_approved_tools),
    lastCompactionSeq: r.last_compaction_seq == null ? undefined : Number(r.last_compaction_seq),
    metadata: parse(r.metadata),
    createdAtMs: Number(r.created_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
    archivedAtMs: r.archived_at_ms == null ? undefined : Number(r.archived_at_ms),
  };
}

function rowToUsageProjection(row: Row): UsageProjectionLedgerRow {
  return {
    ...(row.usage_id == null ? {} : { usageId: String(row.usage_id) }),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    step: Number(row.step),
    usage: normalizeHistoricalUsageCost(parse<UsageLedgerEntry["usage"]>(row.usage_json)),
  };
}

function rowToUsageProjectionSummary(row: Row): UsageProjectionSummary {
  return {
    rowCount: Number(row.row_count),
    ownerRowCount: Number(row.owner_row_count),
    pricedRowCount: Number(row.priced_row_count),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
    costCNY: Number(row.cost_cny),
  };
}

function rowToLifecycleOutbox(row: Row): LifecycleOutboxRecord {
  const outboxId = Number(row.outbox_id);
  assertLifecycleOutboxId(outboxId);
  const generation = Number(row.generation);
  const aggregateId = String(row.aggregate_id);
  const envelope = parseLifecycleOutboxEnvelope(row.topic, parse(row.payload));
  if (envelope.payload.sessionId !== aggregateId || envelope.payload.deletionGeneration !== generation) {
    throw new Error(`lifecycle outbox ${outboxId} payload does not match its durable identity`);
  }
  return {
    outboxId,
    aggregateId,
    generation,
    ...envelope,
    ...(row.available_at_ms == null ? {} : { availableAtMs: Number(row.available_at_ms) }),
    attempts: Number(row.attempts),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    ...(row.completed_at_ms == null ? {} : { completedAtMs: Number(row.completed_at_ms) }),
    ...(row.dead_lettered_at_ms == null ? {} : { deadLetteredAtMs: Number(row.dead_lettered_at_ms) }),
    createdAtMs: Number(row.created_at_ms),
  } as LifecycleOutboxRecord;
}

function rowToBlobManifest(row: Row): BlobManifest {
  const sha = row.sha256 == null ? undefined : Buffer.from(row.sha256).toString("hex");
  return {
    blobId: String(row.blob_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    ...(row.item_id == null ? {} : { itemId: String(row.item_id) }),
    purpose: row.purpose,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken: String(row.upload_token),
    state: row.state,
    ...(sha === undefined ? {} : { sha256: sha }),
    ...(row.size_bytes == null ? {} : { sizeBytes: Number(row.size_bytes) }),
    ...(row.content_type == null ? {} : { contentType: String(row.content_type) }),
    ...(row.uploaded_at_ms == null ? {} : { uploadedAtMs: Number(row.uploaded_at_ms) }),
    ...(row.ready_at_ms == null ? {} : { readyAtMs: Number(row.ready_at_ms) }),
    ...(row.staging_expires_at_ms == null ? {} : { stagingExpiresAtMs: Number(row.staging_expires_at_ms) }),
    ...(row.delete_after_ms == null ? {} : { deleteAfterMs: Number(row.delete_after_ms) }),
    ...(row.deleted_at_ms == null ? {} : { deletedAtMs: Number(row.deleted_at_ms) }),
    deletionGeneration: Number(row.deletion_generation),
    createdAtMs: Number(row.created_at_ms),
  } as BlobManifest;
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

function isValidReadyPurgeBlobManifest(manifest: BlobManifest): boolean {
  try {
    validateBlobKey(manifest.storageKey);
  } catch {
    return false;
  }
  return isCanonicalId("blob", manifest.blobId)
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

function rowToBlobDeleteOutbox(row: Row, requirePending = true): BlobDeleteOutboxRecord {
  const outboxId = Number(row.outbox_id);
  const generation = Number(row.generation);
  if (!Number.isSafeInteger(outboxId) || outboxId < 1) throw new Error("invalid blob delete outbox id");
  if (
    Number(row.deletion_generation) !== generation
    || (requirePending ? row.state !== "delete_pending" : row.state !== "delete_pending" && row.state !== "deleted")
  ) {
    throw new Error(`blob delete outbox ${outboxId} does not match its manifest state`);
  }
  const uploadToken = String(row.upload_token);
  if (!uploadToken) throw new Error(`blob delete outbox ${outboxId} has no upload token`);
  return {
    outboxId,
    blobId: String(row.blob_id),
    generation,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken,
    availableAtMs: Number(row.available_at_ms),
    attempts: Number(row.attempts),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    ...(row.completed_at_ms == null ? {} : { completedAtMs: Number(row.completed_at_ms) }),
    ...(row.dead_lettered_at_ms == null ? {} : { deadLetteredAtMs: Number(row.dead_lettered_at_ms) }),
    createdAtMs: Number(row.created_at_ms),
  };
}

type StoredUserDataExportJob = {
  requestId: string;
  tenantId: string;
  userId: string;
  subjectGeneration: number;
  buildGeneration: number;
  status: "queued" | "building" | "completed" | "failed" | "revoked";
  activeArtifactId?: string;
  availableAtMs?: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  lastErrorCode?: import("../data-export.js").UserDataExportErrorCode;
  snapshotAtMs?: number;
  snapshotRecordCount: number;
  snapshotBlobCount: number;
  snapshotRootSha256?: string;
  snapshotSealedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
};

function storedSafeInteger(value: unknown, name: string, minimum = 0): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new UserDataExportIntegrityError(`stored ${name} is invalid`);
  }
  return number;
}

function optionalStoredSafeInteger(value: unknown, name: string, minimum = 0): number | undefined {
  return value == null ? undefined : storedSafeInteger(value, name, minimum);
}

function rowToUserDataExportRequest(row: Row): UserDataExportRequestRecord {
  const status = String(row.status) as UserDataExportRequestRecord["status"];
  const record: UserDataExportRequestRecord = {
    requestId: String(row.request_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    subjectGeneration: storedSafeInteger(row.subject_generation, "data export subject generation"),
    requestedByKeyId: String(row.requested_by_key_id),
    idempotencyKeySha256: String(row.idempotency_key_sha256),
    requestHash: String(row.request_sha256),
    format: String(row.export_format) as typeof USER_DATA_EXPORT_FORMAT,
    schemaVersion: storedSafeInteger(row.export_schema_version, "data export schema version") as 1,
    policyVersion: String(row.policy_version),
    policySha256: String(row.policy_sha256),
    artifactTtlMs: storedSafeInteger(row.artifact_ttl_ms, "data export artifact TTL", 1),
    status,
    currentBuildGeneration: storedSafeInteger(
      row.active_build_generation,
      "data export active build generation",
    ),
    ...(row.active_artifact_id == null ? {} : { currentArtifactId: String(row.active_artifact_id) }),
    ...(row.snapshot_at_ms == null
      ? {}
      : { snapshotAtMs: storedSafeInteger(row.snapshot_at_ms, "data export snapshot timestamp") }),
    ...(row.ready_at_ms == null
      ? {}
      : { readyAtMs: storedSafeInteger(row.ready_at_ms, "data export ready timestamp") }),
    ...(row.expires_at_ms == null
      ? {}
      : { expiresAtMs: storedSafeInteger(row.expires_at_ms, "data export expiry timestamp") }),
    ...(row.last_error_code == null
      ? {}
      : { lastErrorCode: String(row.last_error_code) as UserDataExportRequestRecord["lastErrorCode"] }),
    createdAtMs: storedSafeInteger(row.created_at_ms, "data export creation timestamp"),
    updatedAtMs: storedSafeInteger(row.updated_at_ms, "data export update timestamp"),
  };
  if (status === "ready") {
    if (row.active_artifact_state !== "ready") {
      throw new UserDataExportIntegrityError("ready data export does not reference a ready artifact");
    }
    record.artifactSha256 = String(row.active_artifact_sha256);
    record.artifactSizeBytes = storedSafeInteger(
      row.active_artifact_size_bytes,
      "data export artifact size",
    );
    record.recordCount = storedSafeInteger(
      row.active_artifact_record_count,
      "data export artifact record count",
    );
  }
  try {
    validateUserDataExportRequestRecord(record);
  } catch (error) {
    if (error instanceof UserDataExportIntegrityError) throw error;
    throw new UserDataExportIntegrityError("stored data export request is invalid");
  }
  return record;
}

function rowToUserDataExportJob(row: Row): StoredUserDataExportJob {
  const job: StoredUserDataExportJob = {
    requestId: String(row.request_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    subjectGeneration: storedSafeInteger(row.subject_generation, "data export job subject generation"),
    buildGeneration: storedSafeInteger(row.build_generation, "data export job build generation"),
    status: String(row.status) as StoredUserDataExportJob["status"],
    ...(row.active_artifact_id == null ? {} : { activeArtifactId: String(row.active_artifact_id) }),
    ...(row.available_at_ms == null
      ? {}
      : { availableAtMs: storedSafeInteger(row.available_at_ms, "data export job availability") }),
    attempts: storedSafeInteger(row.attempts, "data export job attempts"),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null
      ? {}
      : { leaseUntilMs: storedSafeInteger(row.lease_until_ms, "data export job lease") }),
    ...(row.last_error_code == null
      ? {}
      : { lastErrorCode: String(row.last_error_code) as StoredUserDataExportJob["lastErrorCode"] }),
    ...(row.snapshot_at_ms == null
      ? {}
      : { snapshotAtMs: storedSafeInteger(row.snapshot_at_ms, "data export job snapshot time") }),
    snapshotRecordCount: storedSafeInteger(
      row.snapshot_record_count,
      "data export snapshot record count",
    ),
    snapshotBlobCount: storedSafeInteger(
      row.snapshot_blob_count,
      "data export snapshot blob count",
    ),
    ...(row.snapshot_root_sha256 == null
      ? {}
      : { snapshotRootSha256: String(row.snapshot_root_sha256) }),
    ...(row.snapshot_sealed_at_ms == null
      ? {}
      : { snapshotSealedAtMs: storedSafeInteger(row.snapshot_sealed_at_ms, "data export snapshot seal time") }),
    createdAtMs: storedSafeInteger(row.created_at_ms, "data export job creation time"),
    updatedAtMs: storedSafeInteger(row.updated_at_ms, "data export job update time"),
    ...(row.completed_at_ms == null
      ? {}
      : { completedAtMs: storedSafeInteger(row.completed_at_ms, "data export job completion time") }),
  };
  if (!["queued", "building", "completed", "failed", "revoked"].includes(job.status)) {
    throw new UserDataExportIntegrityError("stored data export job status is invalid");
  }
  if (
    (job.claimToken === undefined) !== (job.leaseUntilMs === undefined)
    || (job.snapshotSealedAtMs !== undefined && (
      job.snapshotAtMs === undefined
      || job.snapshotRootSha256 === undefined
    ))
  ) throw new UserDataExportIntegrityError("stored data export job envelope is invalid");
  return job;
}

function rowToUserDataExportArtifact(row: Row): UserDataExportArtifactRecord {
  const state = String(row.state) as UserDataExportArtifactRecord["state"];
  const record: UserDataExportArtifactRecord = {
    artifactId: String(row.artifact_id),
    requestId: String(row.request_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    subjectGeneration: storedSafeInteger(row.subject_generation, "export artifact subject generation"),
    buildGeneration: storedSafeInteger(row.build_generation, "export artifact build generation", 1),
    state,
    format: String(row.export_format) as typeof USER_DATA_EXPORT_FORMAT,
    schemaVersion: storedSafeInteger(row.export_schema_version, "export artifact schema version") as 1,
    contentType: String(row.content_type) as typeof USER_DATA_EXPORT_CONTENT_TYPE,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    policyVersion: String(row.policy_version),
    policySha256: String(row.policy_sha256),
    snapshotRootSha256: String(row.snapshot_root_sha256),
    artifactTtlMs: storedSafeInteger(row.artifact_ttl_ms, "export artifact TTL", 1),
    ...(row.manifest_sha256 == null ? {} : { manifestSha256: String(row.manifest_sha256) }),
    ...(row.content_sha256 == null ? {} : { contentSha256: String(row.content_sha256) }),
    ...(row.snapshot_at_ms == null
      ? {}
      : { snapshotAtMs: storedSafeInteger(row.snapshot_at_ms, "export artifact snapshot time") }),
    stagingExpiresAtMs: storedSafeInteger(
      row.staging_expires_at_ms,
      "export artifact staging expiry",
    ),
    ...(row.ready_at_ms == null
      ? {}
      : { readyAtMs: storedSafeInteger(row.ready_at_ms, "export artifact ready time") }),
    ...(row.expires_at_ms == null
      ? {}
      : { expiresAtMs: storedSafeInteger(row.expires_at_ms, "export artifact expiry") }),
    ...(row.delete_after_ms == null
      ? {}
      : { deletePendingAtMs: storedSafeInteger(row.delete_after_ms, "export artifact delete time") }),
    ...(row.deleted_at_ms == null
      ? {}
      : { deletedAtMs: storedSafeInteger(row.deleted_at_ms, "export artifact deleted time") }),
    deletionGeneration: storedSafeInteger(
      row.deletion_generation,
      "export artifact deletion generation",
    ),
    createdAtMs: storedSafeInteger(row.created_at_ms, "export artifact creation time"),
  };
  if (!["staging", "ready", "delete_pending", "deleted"].includes(state)) {
    throw new UserDataExportIntegrityError("stored export artifact state is invalid");
  }
  if (
    record.format !== USER_DATA_EXPORT_FORMAT
    || record.schemaVersion !== USER_DATA_EXPORT_SCHEMA_VERSION
    || record.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
    || row.content_encoding !== "identity"
    || !/^[0-9a-f]{64}$/.test(record.policySha256)
    || !/^[0-9a-f]{64}$/.test(record.snapshotRootSha256)
  ) throw new UserDataExportIntegrityError("stored export artifact envelope is invalid");
  if (row.content_sha256 != null) {
    record.partCount = storedSafeInteger(row.part_count, "export artifact part count", 1);
    record.recordCount = storedSafeInteger(row.record_count, "export artifact record count");
    record.totalSizeBytes = storedSafeInteger(row.total_size_bytes, "export artifact size");
  }
  return record;
}

function rowToUserDataExportPart(row: Row): UserDataExportArtifactPart {
  const state = String(row.state) as UserDataExportArtifactPart["state"];
  const record: UserDataExportArtifactPart = {
    artifactId: String(row.artifact_id),
    requestId: String(row.request_id),
    buildGeneration: storedSafeInteger(row.build_generation, "export part build generation", 1),
    partNumber: storedSafeInteger(row.part_number, "export part number"),
    state,
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken: String(row.upload_token),
    ...(row.sha256 == null ? {} : { sha256: String(row.sha256) }),
    ...(row.size_bytes == null
      ? {}
      : { sizeBytes: storedSafeInteger(row.size_bytes, "export part size") }),
    ...(row.content_type == null ? {} : { contentType: String(row.content_type) }),
    ...(row.uploaded_at_ms == null
      ? {}
      : { uploadedAtMs: storedSafeInteger(row.uploaded_at_ms, "export part upload time") }),
    ...(row.delete_after_ms == null
      ? {}
      : { deletePendingAtMs: storedSafeInteger(row.delete_after_ms, "export part delete time") }),
    ...(row.deleted_at_ms == null
      ? {}
      : { deletedAtMs: storedSafeInteger(row.deleted_at_ms, "export part deleted time") }),
    deletionGeneration: storedSafeInteger(
      row.deletion_generation,
      "export part deletion generation",
    ),
    createdAtMs: storedSafeInteger(row.created_at_ms, "export part creation time"),
  };
  if (
    !["staging", "uploaded", "delete_pending", "deleted"].includes(state)
    || row.content_encoding !== "identity"
    || (record.sha256 === undefined) !== (record.sizeBytes === undefined)
    || (record.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(record.sha256))
  ) throw new UserDataExportIntegrityError("stored export artifact part is invalid");
  return record;
}

function assertUserDataExportPartOwner(
  row: Row,
  expected: {
    artifactId: string;
    requestId: string;
    buildGeneration: number;
    tenantId?: string;
    userId?: string;
    subjectGeneration?: number;
  },
): void {
  if (
    String(row.artifact_id) !== expected.artifactId
    || String(row.request_id) !== expected.requestId
    || storedSafeInteger(row.build_generation, "export part build generation", 1)
      !== expected.buildGeneration
    || (expected.tenantId !== undefined && String(row.tenant_id) !== expected.tenantId)
    || (expected.userId !== undefined && String(row.user_id) !== expected.userId)
    || (expected.subjectGeneration !== undefined && storedSafeInteger(
      row.subject_generation,
      "export part subject generation",
    ) !== expected.subjectGeneration)
  ) throw new UserDataExportIntegrityError("data export artifact part owner is invalid");
}

function rowToUserDataExportDelete(row: Row): UserDataExportDeleteOutboxRecord {
  const record: UserDataExportDeleteOutboxRecord = {
    outboxId: storedSafeInteger(row.outbox_id, "export delete outbox id", 1),
    artifactId: String(row.artifact_id),
    requestId: String(row.request_id),
    partNumber: storedSafeInteger(row.part_number, "export delete part number"),
    deletionGeneration: storedSafeInteger(
      row.deletion_generation,
      "export delete generation",
      1,
    ),
    storageBackend: String(row.storage_backend),
    storageFormat: String(row.storage_format),
    storageKey: String(row.storage_key),
    uploadToken: String(row.upload_token),
    availableAtMs: storedSafeInteger(row.available_at_ms, "export delete availability"),
    attempts: storedSafeInteger(row.attempts, "export delete attempts"),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null
      ? {}
      : { leaseUntilMs: storedSafeInteger(row.lease_until_ms, "export delete lease") }),
    ...(row.last_error == null ? {} : { lastError: String(row.last_error) }),
    ...(row.completed_at_ms == null
      ? {}
      : { completedAtMs: storedSafeInteger(row.completed_at_ms, "export delete completion") }),
    ...(row.dead_lettered_at_ms == null
      ? {}
      : { deadLetteredAtMs: storedSafeInteger(row.dead_lettered_at_ms, "export delete dead letter time") }),
    createdAtMs: storedSafeInteger(row.created_at_ms, "export delete creation time"),
  };
  if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) {
    throw new UserDataExportIntegrityError("stored export delete claim is incomplete");
  }
  return record;
}

function rowToBillingUsageFact(row: Row): BillingUsageFact {
  const fact: BillingUsageFact = {
    usageId: String(row.usage_id),
    tenantId: String(row.tenant_id),
    accountingPeriod: String(row.accounting_period),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
    ...(row.cost_cny == null ? {} : { costCNY: Number(row.cost_cny) }),
    currency: String(row.currency) as "CNY",
    factSha256: String(row.fact_sha256),
  };
  assertBillingUsageFact(fact);
  return fact;
}

function usageReconciliationSummaryFromRow(row: Row): UsageReconciliationSummary {
  const summary: UsageReconciliationSummary = {
    rowCount: Number(row.row_count),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    totalTokens: Number(row.total_tokens),
    knownCostRows: Number(row.known_cost_rows),
    ...(row.cost_cny == null ? {} : { costCNY: Number(row.cost_cny) }),
    checksum: String(row.checksum),
  };
  const integerFields = [
    summary.rowCount,
    summary.inputTokens,
    summary.outputTokens,
    summary.cacheReadTokens,
    summary.cacheWriteTokens,
    summary.reasoningTokens,
    summary.totalTokens,
    summary.knownCostRows,
  ];
  if (integerFields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new UsageReconciliationError("stored usage reconciliation contains an invalid count");
  }
  if (!/^[0-9a-f]{64}$/.test(summary.checksum)) {
    throw new UsageReconciliationError("stored usage reconciliation contains an invalid checksum");
  }
  if (
    summary.knownCostRows > summary.rowCount
    || (summary.knownCostRows === 0) !== (summary.costCNY === undefined)
    || (summary.costCNY !== undefined && (!Number.isFinite(summary.costCNY) || summary.costCNY < 0))
  ) {
    throw new UsageReconciliationError("stored usage reconciliation contains an invalid cost summary");
  }
  return summary;
}

function rowToUsageReconciliation(row: Row): UsageReconciliationRecord {
  const status = String(row.status);
  if (status !== "verified" && status !== "anonymized") {
    throw new UsageReconciliationError("stored usage reconciliation has an invalid status");
  }
  const verifiedAtMs = Number(row.verified_at_ms);
  const anonymizedAtMs = row.anonymized_at_ms == null ? undefined : Number(row.anonymized_at_ms);
  const deletionGeneration = Number(row.deletion_generation);
  if (
    !Number.isSafeInteger(deletionGeneration)
    || deletionGeneration <= 0
    || !String(row.tenant_id)
    || !String(row.user_id)
    || !String(row.session_id)
    || !Number.isSafeInteger(verifiedAtMs)
    || verifiedAtMs < 0
    || (anonymizedAtMs !== undefined && (!Number.isSafeInteger(anonymizedAtMs) || anonymizedAtMs < verifiedAtMs))
    || (status === "verified" && anonymizedAtMs !== undefined)
    || (status === "anonymized" && anonymizedAtMs === undefined)
  ) {
    throw new UsageReconciliationError("stored usage reconciliation has invalid lifecycle timestamps");
  }
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    deletionGeneration,
    status,
    ...usageReconciliationSummaryFromRow(row),
    verifiedAtMs,
    ...(anonymizedAtMs === undefined ? {} : { anonymizedAtMs }),
  };
}

function rowToSubjectLifecycle(row: Row): SubjectLifecycleRecord {
  const subjectKind = String(row.subject_kind) as DataSubjectKind;
  const state = String(row.state) as SubjectLifecycleState;
  const generation = Number(row.generation);
  const createdAtMs = Number(row.created_at_ms);
  const updatedAtMs = Number(row.updated_at_ms);
  if (
    (subjectKind !== "tenant" && subjectKind !== "user")
    || (state !== "active" && state !== "deleting" && state !== "erased")
    || !Number.isSafeInteger(generation)
    || generation < 0
    || !Number.isSafeInteger(createdAtMs)
    || createdAtMs < 0
    || !Number.isSafeInteger(updatedAtMs)
    || updatedAtMs < createdAtMs
  ) throw new Error("stored subject lifecycle row is invalid");
  return {
    tenantId: String(row.tenant_id),
    subjectKind,
    subjectId: String(row.subject_id),
    state,
    generation,
    ...(row.active_request_id == null ? {} : { activeRequestId: String(row.active_request_id) }),
    ...(row.legal_hold_at_ms == null ? {} : { legalHoldAtMs: Number(row.legal_hold_at_ms) }),
    createdAtMs,
    updatedAtMs,
  };
}

function mysqlControlGeneration(value: unknown): {
  projected: number;
  raw: string;
  saturated: boolean;
} {
  let parsed: bigint;
  if (typeof value === "number") {
    // With supportBigNumbers enabled mysql2 returns unsafe BIGINTs as strings. Refuse a rounded
    // number rather than use it for a durable compare-and-swap.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("stored erasure request control generation is not an exact unsigned integer");
    }
    parsed = BigInt(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) throw new Error("stored erasure request control generation is negative");
    parsed = value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error("stored erasure request control generation is not an unsigned integer");
  }
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const saturated = parsed >= maximum;
  return {
    projected: saturated ? Number.MAX_SAFE_INTEGER : Number(parsed),
    raw: parsed.toString(),
    saturated,
  };
}

function mysqlExactIntegerText(value: unknown, label: string, unsigned = false): string {
  let raw: string;
  if (typeof value === "number") {
    // mysql2 returns an unsafe BIGINT as a string with supportBigNumbers enabled. Treat an unsafe
    // number as already rounded and therefore unusable for evidence or compare-and-swap.
    if (!Number.isSafeInteger(value)) throw new Error(`${label} is not an exact integer`);
    raw = String(value);
  } else if (typeof value === "bigint") {
    raw = value.toString();
  } else if (typeof value === "string") {
    raw = value;
  } else {
    throw new Error(`${label} is not an integer`);
  }
  const pattern = unsigned ? /^(?:0|[1-9][0-9]*)$/ : /^(?:0|-?[1-9][0-9]*)$/;
  if (!pattern.test(raw)) throw new Error(`${label} is not a canonical integer`);
  return raw;
}

function rawErasureRequestQuarantineEnvelope(row: Row): ErasureJobUnsafeQuarantineEnvelope {
  const requestId = String(row.request_id);
  return {
    locatorRequestId: requestId,
    requestId,
    tenantId: String(row.tenant_id),
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    rawGeneration: mysqlExactIntegerText(row.generation, "stored erasure subject generation", true),
    status: String(row.status),
    rawCreatedAtMs: mysqlExactIntegerText(row.created_at_ms, "stored erasure creation timestamp"),
    rawGatedAtMs: row.gated_at_ms == null
      ? null
      : mysqlExactIntegerText(row.gated_at_ms, "stored erasure gate timestamp"),
    rawUpdatedAtMs: mysqlExactIntegerText(row.updated_at_ms, "stored erasure update timestamp"),
    rawControlGeneration: mysqlExactIntegerText(
      row.control_generation,
      "stored erasure control generation",
      true,
    ),
  };
}

/** Decode without accepting the row as valid authority. Claim uses this to classify poison. */
function decodeErasureRequest(row: Row): DecodedErasureRequestEnvelope {
  const subjectKind = String(row.subject_kind) as DataSubjectKind;
  const status = String(row.status) as ErasureRequestStatus;
  const generation = Number(row.generation);
  const createdAtMs = Number(row.created_at_ms);
  // `gated_at_ms` is nullable in the historical schema. Never let JavaScript's
  // Number(null) coercion turn a missing gate into epoch zero and grant worker authority.
  const gatedAtMs = row.gated_at_ms == null ? Number.NaN : Number(row.gated_at_ms);
  const updatedAtMs = Number(row.updated_at_ms);
  const counts = row.counts_json == null ? undefined : parse<unknown>(row.counts_json);
  const completedAtMs = row.completed_at_ms == null ? undefined : Number(row.completed_at_ms);
  const controlGeneration = mysqlControlGeneration(row.control_generation);
  const record: ErasureRequestRecord = {
    requestId: String(row.request_id),
    tenantId: String(row.tenant_id),
    subjectKind,
    subjectId: String(row.subject_id),
    generation,
    status,
    requestedByKeyId: String(row.requested_by_key_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    createdAtMs,
    gatedAtMs,
    updatedAtMs,
    attempts: Number(row.attempts),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
    ...(counts === undefined ? {} : { counts: counts as Record<string, number> }),
    ...(row.checksum == null ? {} : { checksum: String(row.checksum) }),
    ...(row.available_at_ms == null ? {} : { availableAtMs: Number(row.available_at_ms) }),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null ? {} : { leaseUntilMs: Number(row.lease_until_ms) }),
    ...(row.last_error_code == null ? {} : { lastErrorCode: String(row.last_error_code) as ErasureRequestRecord["lastErrorCode"] }),
    ...(row.policy_version == null ? {} : { policyVersion: String(row.policy_version) }),
    ...(row.policy_hash == null ? {} : { policyHash: String(row.policy_hash) }),
    controlGeneration: controlGeneration.projected,
    ...(row.quarantined_at_ms == null ? {} : { quarantinedAtMs: Number(row.quarantined_at_ms) }),
    ...(row.quarantine_reason_code == null
      ? {}
      : { quarantineReasonCode: String(row.quarantine_reason_code) as ErasureRequestRecord["quarantineReasonCode"] }),
    ...(row.quarantine_evidence_sha256 == null
      ? {}
      : { quarantineEvidenceSha256: String(row.quarantine_evidence_sha256) }),
  };
  return {
    record,
    rawControlGeneration: controlGeneration.raw,
    controlGenerationSaturated: controlGeneration.saturated,
  };
}

function rowToErasureRequest(row: Row): ErasureRequestRecord {
  const { record } = decodeErasureRequest(row);
  validateErasureRequestRecordForRead(record);
  return record;
}

function mysqlSafeInteger(value: unknown, label: string): number {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
    throw new Error(`${label} exceeds the JavaScript safe integer range`);
  }
  throw new Error(`${label} is not a non-negative integer`);
}

function rowToRetentionPolicyVersion(row: Row): RetentionPolicyVersionRecord {
  const policy: RetentionPolicyDocumentV1 = {
    sessionContentRetentionMs: row.session_content_retention_ms == null
      ? null
      : mysqlSafeInteger(row.session_content_retention_ms, "stored session content retention"),
    userErasureGraceMs: row.user_erasure_grace_ms == null
      ? null
      : mysqlSafeInteger(row.user_erasure_grace_ms, "stored user erasure grace"),
    operationalUsageRetentionMs: row.operational_usage_retention_ms == null
      ? null
      : mysqlSafeInteger(row.operational_usage_retention_ms, "stored operational usage retention"),
    idempotencyReceiptRetentionMs: row.idempotency_receipt_retention_ms == null
      ? null
      : mysqlSafeInteger(row.idempotency_receipt_retention_ms, "stored idempotency receipt retention"),
    billingFactRetentionMs: row.billing_fact_retention_ms == null
      ? null
      : mysqlSafeInteger(row.billing_fact_retention_ms, "stored billing fact retention"),
    lifecycleAuditRetentionMs: row.lifecycle_audit_retention_ms == null
      ? null
      : mysqlSafeInteger(row.lifecycle_audit_retention_ms, "stored lifecycle audit retention"),
    exportArtifactTtlMs: row.export_artifact_ttl_ms == null
      ? null
      : mysqlSafeInteger(row.export_artifact_ttl_ms, "stored export artifact ttl"),
  };
  const record: RetentionPolicyVersionRecord = {
    tenantId: String(row.tenant_id),
    policyVersion: String(row.policy_version),
    schemaVersion: mysqlSafeInteger(
      row.schema_version,
      "stored retention policy schema version",
    ) as typeof RETENTION_POLICY_SCHEMA_VERSION,
    policy,
    policySha256: String(row.policy_sha256),
    createdByKeyId: String(row.created_by_key_id),
    createdAtMs: mysqlSafeInteger(row.created_at_ms, "stored retention policy creation timestamp"),
  };
  validateRetentionPolicyVersionRecord(record);
  return record;
}

function rowToRetentionPolicyControl(row: Row): RetentionPolicyControlRecord {
  const record: RetentionPolicyControlRecord = {
    tenantId: String(row.tenant_id),
    controlGeneration: mysqlSafeInteger(
      row.control_generation,
      "stored retention policy control generation",
    ),
    ...(row.active_policy_version == null
      ? {}
      : { activePolicyVersion: String(row.active_policy_version) }),
    ...(row.active_policy_sha256 == null
      ? {}
      : { activePolicySha256: String(row.active_policy_sha256) }),
    ...(row.effective_at_ms == null
      ? {}
      : { effectiveAtMs: mysqlSafeInteger(row.effective_at_ms, "stored retention policy effective timestamp") }),
    updatedAtMs: mysqlSafeInteger(row.updated_at_ms, "stored retention policy update timestamp"),
  };
  validateRetentionPolicyControlRecord(record);
  return record;
}

const MANAGEMENT_ACTOR_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function rowToRetentionPolicyActivationEvent(row: Row): RetentionPolicyActivationEvent {
  const event: RetentionPolicyActivationEvent = {
    eventId: mysqlSafeInteger(row.event_id, "stored retention policy activation event id"),
    tenantId: String(row.tenant_id),
    controlGeneration: mysqlSafeInteger(
      row.control_generation,
      "stored retention policy activation generation",
    ),
    policyVersion: String(row.policy_version),
    policySha256: String(row.policy_sha256),
    effectiveAtMs: mysqlSafeInteger(row.effective_at_ms, "stored retention policy activation timestamp"),
    actorKeyId: String(row.actor_key_id),
    beforeSha256: String(row.before_sha256),
    afterSha256: String(row.after_sha256),
    emittedAtMs: mysqlSafeInteger(row.emitted_at_ms, "stored retention policy event timestamp"),
  };
  validateRetentionPolicyIdentity(event.tenantId, event.policyVersion);
  if (
    event.eventId <= 0
    || event.controlGeneration <= 0
    || !SHA256_HEX.test(event.policySha256)
    || !MANAGEMENT_ACTOR_KEY_ID.test(event.actorKeyId)
    || !SHA256_HEX.test(event.beforeSha256)
    || !SHA256_HEX.test(event.afterSha256)
    || event.emittedAtMs < event.effectiveAtMs
  ) throw new Error("stored retention policy activation event is invalid");
  return event;
}

function rowToLegalHoldControl(row: Row): LegalHoldControlRecord {
  const record: LegalHoldControlRecord = {
    tenantId: String(row.tenant_id),
    subjectKind: String(row.subject_kind) as DataSubjectKind,
    subjectId: String(row.subject_id),
    controlGeneration: mysqlSafeInteger(row.control_generation, "stored legal hold generation"),
    activeHoldCount: mysqlSafeInteger(row.active_hold_count, "stored legal hold active count"),
    activeProjectionSha256: String(row.active_projection_sha256),
    updatedAtMs: mysqlSafeInteger(row.updated_at_ms, "stored legal hold update timestamp"),
  };
  validateLegalHoldControlRecord(record);
  return record;
}

function rowToLegalHold(row: Row): LegalHoldRecord {
  const record: LegalHoldRecord = {
    tenantId: String(row.tenant_id),
    holdId: String(row.hold_id),
    subjectKind: String(row.subject_kind) as DataSubjectKind,
    subjectId: String(row.subject_id),
    state: String(row.state) as LegalHoldRecord["state"],
    reasonCode: String(row.reason_code) as LegalHoldRecord["reasonCode"],
    ...(row.external_reference_sha256 == null
      ? {}
      : { externalReferenceSha256: String(row.external_reference_sha256) }),
    createdControlGeneration: mysqlSafeInteger(
      row.created_control_generation,
      "stored legal hold creation generation",
    ),
    createdByKeyId: String(row.created_by_key_id),
    createdAtMs: mysqlSafeInteger(row.created_at_ms, "stored legal hold creation timestamp"),
    ...(row.released_control_generation == null
      ? {}
      : {
          releasedControlGeneration: mysqlSafeInteger(
            row.released_control_generation,
            "stored legal hold release generation",
          ),
        }),
    ...(row.released_by_key_id == null ? {} : { releasedByKeyId: String(row.released_by_key_id) }),
    ...(row.released_at_ms == null
      ? {}
      : { releasedAtMs: mysqlSafeInteger(row.released_at_ms, "stored legal hold release timestamp") }),
    ...(row.release_reason_code == null
      ? {}
      : { releaseReasonCode: String(row.release_reason_code) as LegalHoldRecord["releaseReasonCode"] }),
  };
  validateLegalHoldRecord(record);
  return record;
}

function rowToLegalHoldEvent(row: Row): LegalHoldEvent {
  const event: LegalHoldEvent = {
    eventId: mysqlSafeInteger(row.event_id, "stored legal hold event id"),
    tenantId: String(row.tenant_id),
    subjectKind: String(row.subject_kind) as DataSubjectKind,
    subjectId: String(row.subject_id),
    controlGeneration: mysqlSafeInteger(row.control_generation, "stored legal hold event generation"),
    holdId: String(row.hold_id),
    eventType: String(row.event_type) as LegalHoldEvent["eventType"],
    reasonCode: String(row.reason_code) as LegalHoldEvent["reasonCode"],
    ...(row.external_reference_sha256 == null
      ? {}
      : { externalReferenceSha256: String(row.external_reference_sha256) }),
    actorKeyId: String(row.actor_key_id),
    beforeSha256: String(row.before_sha256),
    afterSha256: String(row.after_sha256),
    emittedAtMs: mysqlSafeInteger(row.emitted_at_ms, "stored legal hold event timestamp"),
  };
  const validReason = event.eventType === "legal_hold/set"
    ? LEGAL_HOLD_REASON_CODES.includes(event.reasonCode as LegalHoldRecord["reasonCode"])
    : event.eventType === "legal_hold/released"
      ? LEGAL_HOLD_RELEASE_REASON_CODES.includes(
          event.reasonCode as NonNullable<LegalHoldRecord["releaseReasonCode"]>,
        )
      : false;
  const subjectValid = event.subjectKind === "tenant"
    ? event.subjectId === event.tenantId
    : event.subjectKind === "user" && event.subjectId.length > 0;
  if (
    event.eventId <= 0
    || event.controlGeneration <= 0
    || !subjectValid
    || !/^hold_[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/.test(event.holdId)
    || !validReason
    || (event.externalReferenceSha256 !== undefined && !SHA256_HEX.test(event.externalReferenceSha256))
    || !MANAGEMENT_ACTOR_KEY_ID.test(event.actorKeyId)
    || !SHA256_HEX.test(event.beforeSha256)
    || !SHA256_HEX.test(event.afterSha256)
  ) throw new LegalHoldIntegrityError("stored legal hold event is invalid");
  return event;
}

function rowToErasurePolicyEvaluationJob(row: Row): ErasurePolicyEvaluationJob {
  const subjectKind = String(row.subject_kind) as DataSubjectKind;
  const job: ErasurePolicyEvaluationJob = {
    requestId: String(row.request_id),
    tenantId: String(row.tenant_id),
    subjectKind,
    subjectId: String(row.subject_id),
    subjectGeneration: mysqlSafeInteger(row.subject_generation, "stored evaluation subject generation"),
    buildGeneration: mysqlSafeInteger(row.build_generation, "stored evaluation build generation"),
    ...(row.cursor_session_id == null ? {} : { cursorSessionId: String(row.cursor_session_id) }),
    targetCount: mysqlSafeInteger(row.target_count, "stored evaluation target count"),
    targetRootSha256: String(row.target_root_sha256),
    ...(row.available_at_ms == null
      ? {}
      : { availableAtMs: mysqlSafeInteger(row.available_at_ms, "stored evaluation availability") }),
    attempts: mysqlSafeInteger(row.attempts, "stored evaluation attempts"),
    ...(row.claim_token == null ? {} : { claimToken: String(row.claim_token) }),
    ...(row.lease_until_ms == null
      ? {}
      : { leaseUntilMs: mysqlSafeInteger(row.lease_until_ms, "stored evaluation lease") }),
    ...(row.last_error_code == null
      ? {}
      : { lastErrorCode: String(row.last_error_code) as ErasurePolicyEvaluationJob["lastErrorCode"] }),
    ...(row.sealed_at_ms == null
      ? {}
      : { sealedAtMs: mysqlSafeInteger(row.sealed_at_ms, "stored evaluation seal timestamp") }),
    createdAtMs: mysqlSafeInteger(row.created_at_ms, "stored evaluation creation timestamp"),
    updatedAtMs: mysqlSafeInteger(row.updated_at_ms, "stored evaluation update timestamp"),
  };
  if (
    (subjectKind !== "tenant" && subjectKind !== "user")
    || job.subjectGeneration <= 0
    || job.buildGeneration <= 0
    || !SHA256_HEX.test(job.targetRootSha256)
    || job.targetCount < 0
    || job.attempts < 0
    || (job.cursorSessionId !== undefined && !isCanonicalId("sess", job.cursorSessionId))
    || (job.availableAtMs !== undefined && job.availableAtMs < 0)
    || (job.leaseUntilMs !== undefined && job.leaseUntilMs < 0)
    || (job.sealedAtMs !== undefined && job.sealedAtMs < 0)
    || job.createdAtMs < 0
    || job.updatedAtMs < job.createdAtMs
    || ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined))
    || (job.claimToken !== undefined && !/^[A-Za-z0-9._:-]{16,128}$/.test(job.claimToken))
    || (job.claimToken !== undefined && job.availableAtMs === undefined)
    || (job.sealedAtMs !== undefined && (
      job.availableAtMs !== undefined
      || job.claimToken !== undefined
      || job.leaseUntilMs !== undefined
      || job.lastErrorCode !== undefined
    ))
    || (job.lastErrorCode !== undefined
      && job.lastErrorCode !== "temporary_failure"
      && job.lastErrorCode !== "evidence_changed")
  ) throw new Error("stored erasure policy evaluation job is invalid");
  return job;
}

function rowToErasurePurgeTarget(row: Row): ErasurePurgeTargetEvidence {
  const issueCodes = parse<unknown>(row.issue_codes);
  if (!Array.isArray(issueCodes) || issueCodes.some((issue) => (
    issue !== "policy_unconfigured"
    && issue !== "deadline_overflow"
    && issue !== "tombstone_invalid"
    && issue !== "usage_reconciliation_invalid"
    && issue !== "receipt_invalid"
    && issue !== "blob_invalid"
  ))) throw new Error("stored erasure purge target issue codes are invalid");
  const target: ErasurePurgeTargetEvidence = {
    requestId: String(row.request_id),
    buildGeneration: mysqlSafeInteger(row.build_generation, "stored purge target build generation"),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    deletionGeneration: mysqlSafeInteger(row.deletion_generation, "stored target deletion generation"),
    deletedAtMs: mysqlSafeInteger(row.deleted_at_ms, "stored target deletion timestamp"),
    ...(row.session_content_deadline_ms == null ? {} : {
      sessionContentDeadlineMs: mysqlSafeInteger(
        row.session_content_deadline_ms,
        "stored session content deadline",
      ),
    }),
    readyBlobCount: mysqlSafeInteger(row.ready_blob_count, "stored ready blob count"),
    readyBlobRootSha256: String(row.ready_blob_root_sha256),
    ...(row.ready_blob_deadline_ms == null ? {} : {
      readyBlobDeadlineMs: mysqlSafeInteger(row.ready_blob_deadline_ms, "stored ready blob deadline"),
    }),
    operationalUsageStatus: String(row.operational_usage_status) as ErasurePurgeTargetEvidence["operationalUsageStatus"],
    operationalUsageVerifiedAtMs: mysqlSafeInteger(
      row.operational_usage_verified_at_ms,
      "stored operational usage verification timestamp",
    ),
    operationalUsageChecksum: String(row.operational_usage_checksum),
    ...(row.operational_usage_deadline_ms == null ? {} : {
      operationalUsageDeadlineMs: mysqlSafeInteger(
        row.operational_usage_deadline_ms,
        "stored operational usage deadline",
      ),
    }),
    idempotencyReceiptCount: mysqlSafeInteger(
      row.idempotency_receipt_count,
      "stored idempotency receipt count",
    ),
    ...(row.idempotency_receipt_deadline_ms == null ? {} : {
      idempotencyReceiptDeadlineMs: mysqlSafeInteger(
        row.idempotency_receipt_deadline_ms,
        "stored idempotency receipt deadline",
      ),
    }),
    exportArtifactDisposition: String(row.export_artifact_disposition) as "not_applicable",
    billingFactDisposition: String(row.billing_fact_disposition) as "retained",
    lifecycleAuditDisposition: String(row.lifecycle_audit_disposition) as "retained",
    issueCodes: [...new Set(issueCodes as ErasurePurgeTargetIssueCode[])].sort(),
    evidenceSha256: String(row.evidence_sha256),
  };
  const { evidenceSha256, ...withoutHash } = target;
  if (
    target.buildGeneration <= 0
    || target.deletionGeneration <= 0
    || !isCanonicalId("sess", target.sessionId)
    || !SHA256_HEX.test(target.readyBlobRootSha256)
    || !SHA256_HEX.test(target.operationalUsageChecksum)
    || (
      target.operationalUsageStatus !== "verified"
      && target.operationalUsageStatus !== "anonymized"
      && target.operationalUsageStatus !== "missing_or_invalid"
    )
    || target.exportArtifactDisposition !== "not_applicable"
    || target.billingFactDisposition !== "retained"
    || target.lifecycleAuditDisposition !== "retained"
    || erasurePurgeTargetEvidenceSha256(withoutHash) !== evidenceSha256
  ) throw new Error("stored erasure purge target evidence is invalid");
  validateErasurePurgeTargetEvidence(target);
  return target;
}

function rowToErasurePolicyDecision(row: Row): ErasurePolicyEvaluationDecisionEvent {
  const decision = String(row.decision) as ErasurePolicyEvaluationDecision;
  const event: ErasurePolicyEvaluationDecisionEvent = {
    requestId: String(row.request_id),
    decisionSeq: mysqlSafeInteger(row.decision_seq, "stored policy decision sequence"),
    buildGeneration: mysqlSafeInteger(row.build_generation, "stored policy decision build generation"),
    decision,
    ...(row.policy_version == null ? {} : { policyVersion: String(row.policy_version) }),
    ...(row.policy_sha256 == null ? {} : { policySha256: String(row.policy_sha256) }),
    ...(row.user_grace_deadline_ms == null ? {} : {
      userGraceDeadlineMs: mysqlSafeInteger(row.user_grace_deadline_ms, "stored user grace deadline"),
    }),
    ...(row.eligibility_deadline_ms == null ? {} : {
      eligibilityDeadlineMs: mysqlSafeInteger(row.eligibility_deadline_ms, "stored eligibility deadline"),
    }),
    targetCount: mysqlSafeInteger(row.target_count, "stored decision target count"),
    targetRootSha256: String(row.target_root_sha256),
    tenantHoldControlGeneration: mysqlSafeInteger(
      row.tenant_hold_control_generation,
      "stored tenant hold generation",
    ),
    tenantHoldProjectionSha256: String(row.tenant_hold_projection_sha256),
    userHoldControlGeneration: mysqlSafeInteger(
      row.user_hold_control_generation,
      "stored user hold generation",
    ),
    userHoldProjectionSha256: String(row.user_hold_projection_sha256),
    beforeSha256: String(row.before_sha256),
    afterSha256: String(row.after_sha256),
    decidedAtMs: mysqlSafeInteger(row.decided_at_ms, "stored policy decision timestamp"),
  };
  const { afterSha256, ...withoutAfter } = event;
  if (
    event.decisionSeq <= 0
    || event.buildGeneration <= 0
    || ![
      "unbound",
      "invalid",
      "unconfigured",
      "held",
      "waiting",
      "eligible_execution_disabled",
    ].includes(event.decision)
    || !SHA256_HEX.test(event.targetRootSha256)
    || !SHA256_HEX.test(event.tenantHoldProjectionSha256)
    || !SHA256_HEX.test(event.userHoldProjectionSha256)
    || !SHA256_HEX.test(event.beforeSha256)
    || erasurePolicyDecisionSha256(withoutAfter) !== afterSha256
  ) throw new Error("stored erasure policy decision is invalid");
  return event;
}

function rowToErasurePurgeAuthority(row: Row): ErasurePurgeAuthorityRecord {
  const authority: ErasurePurgeAuthorityRecord = {
    requestId: String(row.request_id),
    authorityGeneration: mysqlSafeInteger(row.authority_generation, "stored authority generation"),
    tenantId: String(row.tenant_id),
    subjectKind: String(row.subject_kind) as DataSubjectKind,
    subjectId: String(row.subject_id),
    subjectGeneration: mysqlSafeInteger(row.subject_generation, "stored authority subject generation"),
    buildGeneration: mysqlSafeInteger(row.build_generation, "stored authority build generation"),
    policyVersion: String(row.policy_version),
    policySha256: String(row.policy_sha256),
    policySchemaVersion: mysqlSafeInteger(row.policy_schema_version, "stored authority policy schema"),
    userGraceDeadlineMs: mysqlSafeInteger(row.user_grace_deadline_ms, "stored authority grace deadline"),
    eligibilityDeadlineMs: mysqlSafeInteger(row.eligibility_deadline_ms, "stored authority eligibility deadline"),
    targetCount: mysqlSafeInteger(row.target_count, "stored authority target count"),
    targetRootSha256: String(row.target_root_sha256),
    tenantHoldControlGeneration: mysqlSafeInteger(
      row.tenant_hold_control_generation,
      "stored authority tenant hold generation",
    ),
    tenantHoldProjectionSha256: String(row.tenant_hold_projection_sha256),
    userHoldControlGeneration: mysqlSafeInteger(
      row.user_hold_control_generation,
      "stored authority user hold generation",
    ),
    userHoldProjectionSha256: String(row.user_hold_projection_sha256),
    decisionSha256: String(row.decision_sha256),
    authoritySha256: String(row.authority_sha256),
    createdAtMs: mysqlSafeInteger(row.created_at_ms, "stored authority creation timestamp"),
  };
  const { authoritySha256, ...withoutHash } = authority;
  if (
    authority.authorityGeneration <= 0
    || authority.subjectKind !== "user"
    || authority.subjectGeneration <= 0
    || authority.buildGeneration <= 0
    || authority.policySchemaVersion !== RETENTION_POLICY_SCHEMA_VERSION
    || !SHA256_HEX.test(authority.policySha256)
    || !SHA256_HEX.test(authority.targetRootSha256)
    || !SHA256_HEX.test(authority.tenantHoldProjectionSha256)
    || !SHA256_HEX.test(authority.userHoldProjectionSha256)
    || !SHA256_HEX.test(authority.decisionSha256)
    || erasurePurgeAuthoritySha256(withoutHash) !== authoritySha256
  ) throw new Error("stored erasure purge authority is invalid");
  return authority;
}

function rowToErasurePurgeAuthorityControl(row: Row): ErasurePurgeAuthorityControl {
  const control: ErasurePurgeAuthorityControl = {
    requestId: String(row.request_id),
    authorityGeneration: mysqlSafeInteger(row.authority_generation, "stored authority control generation"),
    ...(row.active_authority_sha256 == null
      ? {}
      : { activeAuthoritySha256: String(row.active_authority_sha256) }),
    updatedAtMs: mysqlSafeInteger(row.updated_at_ms, "stored authority control timestamp"),
  };
  if (
    (control.authorityGeneration === 0 && control.activeAuthoritySha256 !== undefined)
    || (control.activeAuthoritySha256 !== undefined && !SHA256_HEX.test(control.activeAuthoritySha256))
  ) throw new Error("stored erasure purge authority control is invalid");
  return control;
}

function rowToErasureControlEvent(row: Row): ErasureJobControlEvent {
  const event: ErasureJobControlEvent = {
    controlEventId: mysqlSafeInteger(row.control_event_id, "stored erasure control event id"),
    requestId: String(row.request_id),
    controlGeneration: mysqlSafeInteger(
      row.control_generation,
      "stored erasure control generation",
    ),
    eventType: String(row.event_type) as ErasureJobControlEvent["eventType"],
    phase: String(row.phase) as ErasureRequestStatus,
    reasonCode: String(row.reason_code) as ErasureJobControlEvent["reasonCode"],
    ...(row.action_code == null
      ? {}
      : { actionCode: String(row.action_code) as ErasureJobControlEvent["actionCode"] }),
    ...(row.actor_key_id == null ? {} : { actorKeyId: String(row.actor_key_id) }),
    beforeSha256: String(row.before_sha256),
    ...(row.after_sha256 == null ? {} : { afterSha256: String(row.after_sha256) }),
    emittedAtMs: Number(row.emitted_at_ms),
  };
  validateErasureJobControlEvent(event);
  return event;
}

function rowsToErasureAuditEvents(rows: Row[]): ErasureAuditEvent[] {
  return rows.map((row) => {
    const payload = parse<unknown>(row.payload);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("stored erasure audit payload is invalid");
    }
    return {
      requestId: String(row.request_id),
      seq: Number(row.seq),
      type: String(row.event_type) as ErasureAuditEvent["type"],
      payload: payload as Record<string, unknown>,
      emittedAtMs: Number(row.emitted_at_ms),
    };
  });
}

/**
 * The control chain still needs the bounded blocked/resumed fields when the main audit itself is
 * poison. Decode each payload independently so an unrelated malformed event does not erase a
 * valid historical resume pair; strict main-audit validation remains authoritative elsewhere.
 */
function rowsToErasureControlValidationAudits(rows: readonly Row[]): ErasureAuditEvent[] {
  return rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const decoded = parse<unknown>(row.payload);
      if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
        payload = decoded as Record<string, unknown>;
      }
    } catch {
      // Preserve only the content-free envelope. A resumed event with an undecodable payload will
      // fail the combined validator instead of being silently paired.
    }
    return {
      requestId: String(row.request_id),
      seq: Number(row.seq),
      type: String(row.event_type) as ErasureAuditEvent["type"],
      payload,
      emittedAtMs: Number(row.emitted_at_ms),
    };
  });
}

function deterministicIntegrity<T>(
  record: ErasureRequestRecord,
  reasonCode: Parameters<typeof newErasureJobIntegrityFault>[1],
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ErasureJobIntegrityFault) throw error;
    throw newErasureJobIntegrityFault(record, reasonCode);
  }
}

function rowToErasureSessionRef(row: Row): ErasureSessionRef {
  const sessionId = String(row.session_id);
  const parentSessionId = row.parent_session_id == null ? undefined : String(row.parent_session_id);
  const deletionGeneration = Number(row.deletion_generation);
  if (
    !isCanonicalId("sess", sessionId)
    || (parentSessionId !== undefined && !isCanonicalId("sess", parentSessionId))
    || !Number.isSafeInteger(deletionGeneration)
    || deletionGeneration < 0
  ) throw new Error("stored erasure session reference is invalid");
  return {
    sessionId,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    deleted: row.deleted_at_ms != null,
    deletionGeneration,
  };
}

function erasureProgressCount(row: Row, column: string): number {
  const value = Number(row[column]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`stored erasure progress count ${column} is invalid`);
  }
  return value;
}

function usageReconciliationSummary(record: UsageReconciliationRecord): UsageReconciliationSummary {
  return {
    rowCount: record.rowCount,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    reasoningTokens: record.reasoningTokens,
    totalTokens: record.totalTokens,
    knownCostRows: record.knownCostRows,
    ...(record.costCNY === undefined ? {} : { costCNY: record.costCNY }),
    checksum: record.checksum,
  };
}

function assertUsageReconciliationOwner(
  record: UsageReconciliationRecord,
  input: ReconcileSessionUsageInput,
): void {
  if (
    record.tenantId !== input.tenantId
    || record.userId !== input.userId
    || record.sessionId !== input.sessionId
    || record.deletionGeneration !== input.deletionGeneration
  ) {
    throw new UsageLifecycleGenerationError(input.sessionId, input.deletionGeneration);
  }
}

function billingUsageFactValues(fact: BillingUsageFact): unknown[] {
  assertBillingUsageFact(fact);
  return [
    fact.usageId,
    fact.tenantId,
    fact.accountingPeriod,
    fact.provider,
    fact.model,
    fact.inputTokens,
    fact.outputTokens,
    fact.cacheReadTokens,
    fact.cacheWriteTokens,
    fact.reasoningTokens,
    fact.totalTokens,
    fact.costCNY === undefined ? null : canonicalBillingCostCNY(fact.costCNY),
    fact.currency,
    fact.factSha256,
  ];
}

async function insertBillingUsageFact(conn: PoolConnection, fact: BillingUsageFact): Promise<void> {
  try {
    await conn.query(
      `INSERT INTO billing_usage_facts
         (usage_id, tenant_id, accounting_period, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, cost_cny, currency,
          fact_sha256)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      billingUsageFactValues(fact),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new UsageIdentityConflictError(fact.usageId);
    }
    throw error;
  }
}

export interface MysqlStoreOptions {
  url: string;
  connectionLimit?: number;
  /** overrides migration discovery; useful in tests and unusual deployments */
  migrationsDir?: string;
  /** maximum time to wait for another runner to finish schema migration */
  migrationLockTimeoutSeconds?: number;
}

export class MysqlSessionStore implements
  SessionStore,
  LifecycleOutboxStore,
  BlobManifestStore,
  BlobCleanupStore,
  UsageLifecycleStore,
  SubjectLifecycleStore,
  ErasureJobStore,
  ErasureJobMaintenanceStore,
  ErasureSessionStore,
  ErasureSessionCatalogStore,
  ErasureUsageReconciliationStore,
  LegacyTombstoneCompensationStore,
  RetentionPolicyStore,
  ErasurePolicyEvaluationStore,
  UserDataExportRequestStore,
  UserDataExportJobStore,
  UserDataExportCleanupStore
{
  private constructor(private readonly pool: Pool) {}

  /**
   * Find the .sql migrations. The layout differs between running from source (package root) and from a
   * bundle (copied next to main.js), so try both plus an explicit override.
   */
  private static async resolveMigrationsDir(explicit?: string): Promise<string> {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      explicit,
      process.env.AGENT_SERVICE_MIGRATIONS_DIR,
      join(here, "migrations"), // bundled: dist/main.js + dist/migrations
      join(here, "..", "..", "migrations"), // source: packages/store/src/mysql -> packages/store/migrations
    ].filter((v): v is string => !!v);
    for (const dir of candidates) {
      try {
        const files = await readdir(dir);
        if (files.some((f) => f.endsWith(".sql"))) return dir;
      } catch {
        /* try the next candidate */
      }
    }
    throw new Error(`could not locate migrations; tried: ${candidates.join(", ")}`);
  }

  static async connect(opts: MysqlStoreOptions): Promise<MysqlSessionStore> {
    const pool = mysql.createPool({
      uri: opts.url,
      connectionLimit: opts.connectionLimit ?? 20,
      supportBigNumbers: true,
      bigNumberStrings: false,
      namedPlaceholders: false,
      timezone: "Z",
    });
    const store = new MysqlSessionStore(pool);
    try {
      await store.migrate(await MysqlSessionStore.resolveMigrationsDir(opts.migrationsDir), opts.migrationLockTimeoutSeconds ?? 60);
      return store;
    } catch (err) {
      // A failed startup must not strand a pool (and its advisory-lock connection) in the process.
      await pool.end().catch(() => {});
      throw err;
    }
  }

  async migrate(migrationsDir?: string, lockTimeoutSeconds = 60): Promise<void> {
    const dir = migrationsDir ?? (await MysqlSessionStore.resolveMigrationsDir());
    if (!Number.isInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 0) throw new Error("migrationLockTimeoutSeconds must be a non-negative integer");
    // MySQL DDL auto-commits, so a transaction cannot serialize migrations. A named lock held by one
    // dedicated connection prevents two cold-starting runners from both observing a migration as
    // pending and racing the same ALTER TABLE. The database hash keeps independent schemas separate.
    const conn = await this.pool.getConnection();
    let locked = false;
    try {
      const [lockRows] = await conn.query<Row[]>(
        "SELECT GET_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)), ?) AS acquired",
        [lockTimeoutSeconds],
      );
      locked = Number(lockRows[0]?.acquired) === 1;
      if (!locked) throw new Error(`timed out after ${lockTimeoutSeconds}s waiting for the MySQL schema migration lock`);

      await conn.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(128) PRIMARY KEY, applied_at_ms BIGINT NOT NULL)",
      );
      const [applied] = await conn.query<Row[]>("SELECT name FROM schema_migrations");
      const done = new Set(applied.map((r) => r.name as string));
      const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
      for (const f of files) {
        if (done.has(f)) continue;
        const sql = await readFile(join(dir, f), "utf8");
        const stripped = sql.replace(/^\s*--.*$/gm, "");
        const statements = stripped.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
        for (const [i, stmt] of statements.entries()) {
          try {
            await conn.query(stmt);
          } catch (cause) {
            throw new Error(`migration ${f} failed at statement ${i + 1}/${statements.length}`, { cause });
          }
        }
        await conn.query("INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?, ?)", [f, Date.now()]);
      }
    } finally {
      if (locked) {
        await conn.query("SELECT RELEASE_LOCK(CONCAT('agent-service:migrate:', LEFT(SHA2(DATABASE(), 256), 32)))").catch(() => {});
      }
      conn.release();
    }
  }

  // ---------- legacy generation-zero tombstone compensation ----------
  private async readLegacyTombstoneCutover(
    conn: PoolConnection,
    lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
  ): Promise<LegacyTombstoneCutoverRecord | null> {
    const [rows] = await conn.query<Row[]>(
      `SELECT control_generation, activated_at_ms, actor_key_id, evidence_sha256
         FROM legacy_tombstone_cutover WHERE singleton_id=1 ${lock}`,
    );
    if (!rows[0]) throw new Error("legacy tombstone cutover singleton is missing");
    return rowToLegacyTombstoneCutover(rows[0]);
  }

  private async requireActiveLegacyTombstoneCutover(
    conn: PoolConnection,
  ): Promise<LegacyTombstoneCutoverRecord> {
    const record = await this.readLegacyTombstoneCutover(conn, "FOR SHARE");
    if (!record) throw new LegacyTombstoneCutoverRequiredError();
    return record;
  }

  async getLegacyTombstoneCutover(): Promise<LegacyTombstoneCutoverRecord | null> {
    const conn = await this.pool.getConnection();
    try {
      return await this.readLegacyTombstoneCutover(conn);
    } finally {
      conn.release();
    }
  }

  async activateLegacyTombstoneCutover(
    input: ActivateLegacyTombstoneCutoverInput,
  ): Promise<LegacyTombstoneCutoverRecord> {
    const stagedInput = structuredClone(input);
    validateActivateLegacyTombstoneCutoverInput(stagedInput);
    const evidence = legacyTombstoneCutoverEvidenceSha256(
      stagedInput.actorKeyId,
      stagedInput.atMs,
    );
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const existing = await this.readLegacyTombstoneCutover(conn, "FOR UPDATE");
      if (existing) {
        if (
          existing.activatedByKeyId === stagedInput.actorKeyId
          && existing.activatedAtMs === stagedInput.atMs
        ) {
          await conn.commit();
          return existing;
        }
        throw new LegacyTombstoneCutoverConflictError();
      }
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE legacy_tombstone_cutover
            SET control_generation=1, activated_at_ms=?, actor_key_id=?, evidence_sha256=?
          WHERE singleton_id=1 AND control_generation=0 AND activated_at_ms IS NULL
            AND actor_key_id IS NULL AND evidence_sha256 IS NULL`,
        [stagedInput.atMs, stagedInput.actorKeyId, evidence],
      );
      if (updated.affectedRows !== 1) throw new LegacyTombstoneCutoverConflictError();
      const record = await this.readLegacyTombstoneCutover(conn);
      if (!record) throw new Error("legacy tombstone cutover activation was not durable");
      await conn.commit();
      return record;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private legacyTombstoneCandidate(row: Row): {
    session: Session;
    deletedAtMs: number;
    lastSeq: number;
    candidateSha256: string;
  } {
    let session: Session;
    try {
      session = SessionSchema.parse(rowToSession(row));
    } catch {
      throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
    }
    const deletedAtMs = Number(row.deleted_at_ms);
    const lastSeq = Number(row.last_seq);
    const generation = Number(row.deletion_generation);
    if (
      row.session_id !== session.id
      || row.tenant_id !== session.tenantId
      || row.user_id !== session.userId
      || !Number.isSafeInteger(deletedAtMs)
      || deletedAtMs < 0
      || deletedAtMs < session.createdAtMs
      || deletedAtMs < session.updatedAtMs
      || !Number.isSafeInteger(lastSeq)
      || lastSeq < 0
      || session.lastSeq !== lastSeq
      || generation !== 0
      || row.purge_after_ms != null
    ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
    return {
      session,
      deletedAtMs,
      lastSeq,
      candidateSha256: legacyTombstoneCandidateSha256({
        sessionId: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        deletedAtMs,
        lastSeq,
      }),
    };
  }

  private assertLegacyTombstoneJobCandidate(
    row: Row,
    candidate: ReturnType<MysqlSessionStore["legacyTombstoneCandidate"]>,
  ): void {
    if (
      String(row.session_id) !== candidate.session.id
      || String(row.tenant_id) !== candidate.session.tenantId
      || String(row.user_id) !== candidate.session.userId
      || Number(row.source_deleted_at_ms) !== candidate.deletedAtMs
      || Number(row.source_last_seq) !== candidate.lastSeq
      || String(row.candidate_sha256) !== candidate.candidateSha256
    ) throw new LegacyTombstoneJobConflictError();
  }

  private async readLegacyTombstoneResultRows(
    conn: PoolConnection,
    jobId: string,
    lock: "" | "FOR SHARE" = "",
  ): Promise<Row[]> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${LEGACY_TOMBSTONE_EVENT_COLUMNS}
         FROM legacy_tombstone_compensation_events
        WHERE job_id=? ORDER BY result_event_id ${lock}`,
      [jobId],
    );
    return rows;
  }

  private legacyTombstoneResultMatchesJob(
    jobRow: Row,
    job: LegacyTombstoneCompensationJobRecord,
    resultRows: readonly Row[],
  ): boolean {
    const resultRow = resultRows[0];
    if (resultRows.length !== 1 || !resultRow || job.status === "pending") return false;
    let audit: LegacyTombstoneCompensationAudit;
    try {
      audit = rowToLegacyTombstoneAudit(resultRow);
    } catch {
      return false;
    }
    const expectedActor = job.sourceKind === "maintenance" ? job.maintenanceActorKeyId : null;
    const commonMatches = String(resultRow.job_id) === job.jobId
      && String(resultRow.session_id) === job.sessionId
      && Number(resultRow.control_generation) === 1
      && (resultRow.actor_key_id == null ? null : String(resultRow.actor_key_id)) === expectedActor
      && Number(resultRow.source_deleted_at_ms) === job.legacyDeletedAtMs
      && String(resultRow.before_sha256) === String(jobRow.candidate_sha256);
    if (!commonMatches) return false;

    if (job.status === "completed") {
      if (
        job.completedAtMs === undefined
        || job.completedEventSeq === undefined
        || job.completedClaimAttempt === undefined
      ) return false;
      const evidence = legacyTombstoneSuccessEvidenceSha256({
        jobId: job.jobId,
        tenantId: job.tenantId,
        userId: job.userId,
        sessionId: job.sessionId,
        cutoverGeneration: 1,
        legacyDeletedAtMs: job.legacyDeletedAtMs,
        deletionGeneration: 1,
        eventSeq: job.completedEventSeq,
        claimAttempt: job.completedClaimAttempt,
        emittedAtMs: job.completedAtMs,
      });
      return audit.type === "legacy_tombstone/compensated"
        && resultRow.reason_code == null
        && Number(resultRow.claim_attempt) === job.completedClaimAttempt
        && Number(resultRow.target_deletion_generation) === 1
        && Number(resultRow.terminal_event_seq) === job.completedEventSeq
        && String(resultRow.after_sha256) === evidence
        && Number(resultRow.emitted_at_ms) === job.completedAtMs
        && audit.evidenceSha256 === evidence;
    }

    if (
      job.terminalAtMs === undefined
      || job.terminalReasonCode === undefined
      || job.terminalEvidenceSha256 === undefined
    ) return false;
    const expectedAttempt = job.attempts === 0 ? null : job.attempts;
    return audit.type === "legacy_tombstone/terminal_incident"
      && resultRow.event_type === "legacy_tombstone/terminal_incident"
      && audit.reasonCode === job.terminalReasonCode
      && (resultRow.claim_attempt == null ? null : Number(resultRow.claim_attempt)) === expectedAttempt
      && resultRow.target_deletion_generation == null
      && resultRow.terminal_event_seq == null
      && String(resultRow.after_sha256) === job.terminalEvidenceSha256
      && Number(resultRow.emitted_at_ms) === job.terminalAtMs
      && audit.evidenceSha256 === job.terminalEvidenceSha256;
  }

  private projectLegacyTombstoneProofConflict(
    jobRow: Row,
    job: LegacyTombstoneCompensationJobRecord,
    resultRows: readonly Row[],
  ): LegacyTombstoneCompensationJobRecord {
    let terminalAtMs = job.updatedAtMs;
    let terminalEvidenceSha256: string;
    const resultRow = resultRows.length === 1 ? resultRows[0] : undefined;
    const resultAtMs = resultRow == null ? Number.NaN : Number(resultRow.emitted_at_ms);
    const expectedActor = job.sourceKind === "maintenance" ? job.maintenanceActorKeyId : null;
    const expectedAttempt = job.status === "completed"
      ? job.completedClaimAttempt ?? null
      : job.attempts === 0 ? null : job.attempts;
    if (
      resultRow
      && job.status !== "pending"
      && resultRow.event_type === "legacy_tombstone/terminal_incident"
      && resultRow.reason_code === "proof_conflict"
      && String(resultRow.job_id) === job.jobId
      && String(resultRow.session_id) === job.sessionId
      && Number(resultRow.control_generation) === 1
      && (resultRow.actor_key_id == null ? null : String(resultRow.actor_key_id)) === expectedActor
      && (resultRow.claim_attempt == null ? null : Number(resultRow.claim_attempt)) === expectedAttempt
      && Number(resultRow.source_deleted_at_ms) === job.legacyDeletedAtMs
      && resultRow.target_deletion_generation == null
      && resultRow.terminal_event_seq == null
      && String(resultRow.before_sha256) === String(jobRow.candidate_sha256)
      && Number.isSafeInteger(resultAtMs)
      && resultAtMs >= job.updatedAtMs
      && String(resultRow.after_sha256)
        === legacyTombstoneMissingResultEvidenceSha256(jobRow, resultAtMs)
    ) {
      terminalAtMs = resultAtMs;
      terminalEvidenceSha256 = String(resultRow.after_sha256);
    } else if (resultRows.length > 0) {
      terminalEvidenceSha256 = legacyTombstoneMismatchedResultEvidenceSha256(jobRow, resultRows);
    } else {
      terminalEvidenceSha256 = legacyTombstoneMissingResultEvidenceSha256(jobRow, terminalAtMs);
    }

    const projected = structuredClone(job);
    projected.status = "terminal_incident";
    projected.updatedAtMs = Math.max(projected.updatedAtMs, terminalAtMs);
    projected.terminalAtMs = terminalAtMs;
    projected.terminalReasonCode = "proof_conflict";
    projected.terminalEvidenceSha256 = terminalEvidenceSha256;
    delete projected.availableAtMs;
    delete projected.claimToken;
    delete projected.leaseUntilMs;
    delete projected.lastErrorCode;
    delete projected.completedAtMs;
    delete projected.completedEventSeq;
    delete projected.completedClaimAttempt;
    delete projected.completedClaimTokenSha256;
    validateLegacyTombstoneCompensationJobRecord(projected);
    return projected;
  }

  private projectUnsafeLegacyTombstoneJob(
    jobRow: Row,
    resultRows: readonly Row[],
  ): LegacyTombstoneCompensationJobRecord | null {
    const resultRow = resultRows.length === 1 ? resultRows[0] : undefined;
    if (!resultRow) return null;
    let audit: LegacyTombstoneCompensationAudit;
    try {
      audit = rowToLegacyTombstoneAudit(resultRow);
    } catch {
      return null;
    }
    const sourceKind = String(jobRow.source_kind);
    const expectedActor = audit.type === "legacy_tombstone/terminal_incident"
      && audit.reasonCode !== "unsafe_job_envelope"
      && sourceKind === "maintenance"
      ? String(jobRow.maintenance_actor_key_id)
      : null;
    if (
      audit.type !== "legacy_tombstone/terminal_incident"
      || resultRow.event_type !== "legacy_tombstone/terminal_incident"
      || resultRow.reason_code !== audit.reasonCode
      || String(resultRow.job_id) !== String(jobRow.job_id)
      || String(resultRow.session_id) !== String(jobRow.session_id)
      || Number(resultRow.control_generation) !== 1
      || (resultRow.actor_key_id == null ? null : String(resultRow.actor_key_id)) !== expectedActor
      || Number(resultRow.source_deleted_at_ms) !== Number(jobRow.source_deleted_at_ms)
      || resultRow.target_deletion_generation != null
      || resultRow.terminal_event_seq != null
      || String(resultRow.after_sha256) !== audit.evidenceSha256
      || !/^[0-9a-f]{64}$/.test(String(resultRow.before_sha256))
      || Number(jobRow.control_generation) !== 1
    ) return null;

    const legacyDeletedAtMs = Number(jobRow.source_deleted_at_ms);
    const rawCreatedAtMs = Number(jobRow.created_at_ms);
    const rawUpdatedAtMs = Number(jobRow.updated_at_ms);
    const attempts = Number(jobRow.attempts);
    if (
      !Number.isSafeInteger(legacyDeletedAtMs)
      || legacyDeletedAtMs < 0
      || !Number.isSafeInteger(rawCreatedAtMs)
      || rawCreatedAtMs < 0
      || !Number.isSafeInteger(rawUpdatedAtMs)
      || rawUpdatedAtMs < 0
      || !Number.isSafeInteger(attempts)
      || attempts < 0
    ) return null;
    const createdAtMs = Math.max(rawCreatedAtMs, legacyDeletedAtMs);
    const terminalAtMs = Math.max(createdAtMs, rawUpdatedAtMs, audit.emittedAtMs);
    const common = {
      jobId: String(jobRow.job_id),
      tenantId: String(jobRow.tenant_id),
      userId: String(jobRow.user_id),
      sessionId: String(jobRow.session_id),
      cutoverGeneration: 1 as const,
      legacyDeletedAtMs,
      status: "terminal_incident" as const,
      createdAtMs,
      updatedAtMs: terminalAtMs,
      attempts,
      terminalAtMs,
      terminalReasonCode: audit.reasonCode,
      terminalEvidenceSha256: audit.evidenceSha256,
    };
    const projected = sourceKind === "maintenance"
      ? {
          ...common,
          sourceKind: "maintenance" as const,
          maintenanceActorKeyId: String(jobRow.maintenance_actor_key_id),
        }
      : {
          ...common,
          sourceKind: "erasure_claim" as const,
          sourceRequestId: String(jobRow.source_request_id),
          sourceSubjectGeneration: Number(jobRow.source_subject_generation),
          sourceClaimAttempt: Number(jobRow.source_claim_attempt),
          sourceClaimTokenSha256: String(jobRow.source_claim_token_sha256),
        };
    try {
      validateLegacyTombstoneCompensationJobRecord(projected);
      return projected;
    } catch {
      return null;
    }
  }

  private resolveLegacyTombstoneJobResult(
    jobRow: Row,
    job: LegacyTombstoneCompensationJobRecord,
    resultRows: readonly Row[],
  ): LegacyTombstoneCompensationJobRecord {
    if (
      (job.status === "pending" && resultRows.length === 0)
      || this.legacyTombstoneResultMatchesJob(jobRow, job, resultRows)
    ) return job;
    return this.projectLegacyTombstoneProofConflict(jobRow, job, resultRows);
  }

  private async appendLegacyTombstoneMissingResultIncident(
    conn: PoolConnection,
    jobRow: Row,
    job: LegacyTombstoneCompensationJobRecord,
    atMs: number,
  ): Promise<void> {
    const emittedAtMs = Math.max(job.updatedAtMs, atMs);
    const evidence = legacyTombstoneMissingResultEvidenceSha256(jobRow, emittedAtMs);
    const claimAttempt = job.status === "completed"
      ? job.completedClaimAttempt ?? null
      : job.attempts === 0 ? null : job.attempts;
    await conn.query(
      `INSERT INTO legacy_tombstone_compensation_events
         (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
          claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
          before_sha256, after_sha256, emitted_at_ms)
       VALUES (?, ?, 1, 'legacy_tombstone/terminal_incident', 'proof_conflict', ?, ?, ?,
               NULL, NULL, ?, ?, ?)`,
      [
        job.jobId,
        job.sessionId,
        job.sourceKind === "maintenance" ? job.maintenanceActorKeyId : null,
        claimAttempt,
        job.legacyDeletedAtMs,
        String(jobRow.candidate_sha256),
        evidence,
        emittedAtMs,
      ],
    );
  }

  async scheduleLegacyTombstoneCompensation(
    authorization: ErasureWriteAuthorization,
    input: ScheduleLegacyTombstoneCompensationInput,
  ): Promise<LegacyTombstoneCompensationJobRecord> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedInput = structuredClone(input);
    validateErasureWriteAuthorization(stagedAuthorization);
    validateScheduleLegacyTombstoneCompensationInput(stagedInput);
    if (stagedInput.jobId !== legacyTombstoneCompensationJobIdForSession(stagedInput.sessionId)) {
      throw new LegacyTombstoneJobConflictError();
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.requireActiveLegacyTombstoneCutover(conn);
      const [sessionRows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? AND session_id=? FOR UPDATE`,
        [stagedAuthorization.tenantId, stagedAuthorization.userId, stagedInput.sessionId],
      );
      await this.lockErasureSessionAuthority(
        conn,
        stagedAuthorization,
        ["reconciling_usage"],
        stagedInput.atMs,
      );
      if (!sessionRows[0]) throw new SessionGoneError(stagedInput.sessionId);

      const [existingRows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs
          WHERE job_id=? OR session_id=? ORDER BY job_id FOR UPDATE`,
        [stagedInput.jobId, stagedInput.sessionId],
      );
      if (existingRows.length > 1) throw new LegacyTombstoneJobConflictError();
      if (existingRows[0]) {
        const existingRow = existingRows[0];
        const resultRows = await this.readLegacyTombstoneResultRows(
          conn,
          String(existingRow.job_id),
          "FOR SHARE",
        );
        let stored: LegacyTombstoneCompensationJobRecord;
        let existing: LegacyTombstoneCompensationJobRecord;
        try {
          stored = rowToLegacyTombstoneCompensationJob(existingRow);
          existing = this.resolveLegacyTombstoneJobResult(existingRow, stored, resultRows);
        } catch {
          const unsafeProjection = this.projectUnsafeLegacyTombstoneJob(existingRow, resultRows);
          if (!unsafeProjection) throw new LegacyTombstoneJobConflictError();
          stored = unsafeProjection;
          existing = unsafeProjection;
        }
        const sameIdentity = stored.jobId === stagedInput.jobId
          && stored.sessionId === stagedInput.sessionId
          && stored.tenantId === stagedAuthorization.tenantId
          && stored.userId === stagedAuthorization.userId
          && sessionRows[0].session_id === stored.sessionId
          && sessionRows[0].tenant_id === stored.tenantId
          && sessionRows[0].user_id === stored.userId
          && Number(sessionRows[0].deleted_at_ms) === stored.legacyDeletedAtMs
          && (stored.sourceKind === "maintenance" || (
            stored.sourceRequestId === stagedAuthorization.requestId
            && stored.sourceSubjectGeneration === stagedAuthorization.subjectGeneration
          ));
        if (!sameIdentity) throw new LegacyTombstoneJobConflictError();
        if (existing.status === "pending") {
          const candidate = this.legacyTombstoneCandidate(sessionRows[0]);
          this.assertLegacyTombstoneJobCandidate(existingRow, candidate);
        } else if (
          existing.status === "completed"
          && Number(sessionRows[0].deletion_generation) !== 1
        ) {
          throw new LegacyTombstoneJobConflictError();
        }
        await conn.commit();
        return existing;
      }

      const candidate = this.legacyTombstoneCandidate(sessionRows[0]);
      if (stagedInput.atMs < candidate.deletedAtMs) {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }

      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
           (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
            source_subject_generation, source_claim_attempt, source_claim_token_sha256,
            maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
            status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
            last_error_code, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'erasure_claim', ?, ?, ?, ?, NULL, ?, ?, ?,
                 'pending', 1, ?, 0, NULL, NULL, NULL, ?, ?)`,
        [
          stagedInput.jobId,
          candidate.session.id,
          candidate.session.tenantId,
          candidate.session.userId,
          stagedAuthorization.requestId,
          stagedAuthorization.subjectGeneration,
          stagedAuthorization.claimAttempt,
          legacyTombstoneClaimTokenSha256(stagedAuthorization.claimToken),
          candidate.deletedAtMs,
          candidate.lastSeq,
          candidate.candidateSha256,
          stagedInput.availableAtMs,
          stagedInput.atMs,
          stagedInput.atMs,
        ],
      );
      const [createdRows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs WHERE job_id=?`,
        [stagedInput.jobId],
      );
      if (!createdRows[0]) throw new Error("legacy tombstone job was not created");
      const created = rowToLegacyTombstoneCompensationJob(createdRows[0]);
      await conn.commit();
      return created;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async scheduleLegacyTombstoneCandidates(
    options: ScheduleLegacyTombstoneCandidatesOptions,
  ): Promise<LegacyTombstoneCompensationJobRecord[]> {
    const stagedOptions = structuredClone(options);
    validateScheduleLegacyTombstoneCandidatesOptions(stagedOptions);
    const conn = await this.pool.getConnection();
    let candidateIds: string[] = [];
    try {
      const cutover = await this.readLegacyTombstoneCutover(conn);
      if (!cutover) throw new LegacyTombstoneCutoverRequiredError();
      if (cutover.generation !== stagedOptions.cutoverGeneration) {
        throw new LegacyTombstoneCutoverConflictError();
      }
      const [leafRows] = await conn.query<Row[]>(
        `SELECT s.session_id
           FROM sessions s FORCE INDEX (idx_sessions_legacy_tombstone_candidate)
           LEFT JOIN legacy_tombstone_compensation_jobs j ON j.session_id=s.session_id
          WHERE s.deletion_generation=0 AND s.deleted_at_ms IS NOT NULL AND j.session_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sessions c
               WHERE c.parent_session_id=s.session_id AND c.deletion_generation=0
            )
          ORDER BY s.session_id LIMIT ?`,
        [stagedOptions.limit],
      );
      candidateIds = leafRows.map((row) => String(row.session_id));
      if (candidateIds.length < stagedOptions.limit) {
        const remaining = stagedOptions.limit - candidateIds.length;
        const excluded = candidateIds.length
          ? ` AND s.session_id NOT IN (${candidateIds.map(() => "?").join(",")})`
          : "";
        const [fallbackRows] = await conn.query<Row[]>(
          `SELECT s.session_id
             FROM sessions s FORCE INDEX (idx_sessions_legacy_tombstone_candidate)
             LEFT JOIN legacy_tombstone_compensation_jobs j ON j.session_id=s.session_id
            WHERE s.deletion_generation=0 AND s.deleted_at_ms IS NOT NULL AND j.session_id IS NULL
              ${excluded}
            ORDER BY s.session_id LIMIT ?`,
          [...candidateIds, remaining],
        );
        candidateIds.push(...fallbackRows.map((row) => String(row.session_id)));
      }
    } finally {
      conn.release();
    }

    const created: LegacyTombstoneCompensationJobRecord[] = [];
    for (const sessionId of candidateIds) {
      const record = await this.scheduleLegacyTombstoneCandidate(stagedOptions, sessionId);
      if (record) created.push(record);
    }
    return created;
  }

  private async scheduleLegacyTombstoneCandidate(
    options: ScheduleLegacyTombstoneCandidatesOptions,
    sessionId: string,
  ): Promise<LegacyTombstoneCompensationJobRecord | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const cutover = await this.requireActiveLegacyTombstoneCutover(conn);
      if (cutover.generation !== options.cutoverGeneration) {
        throw new LegacyTombstoneCutoverConflictError();
      }
      const [rows] = await conn.query<Row[]>(
        "SELECT * FROM sessions WHERE session_id=? FOR UPDATE",
        [sessionId],
      );
      if (!rows[0] || rows[0].deleted_at_ms == null || Number(rows[0].deletion_generation) !== 0) {
        await conn.commit();
        return null;
      }
      let candidate: ReturnType<MysqlSessionStore["legacyTombstoneCandidate"]>;
      try {
        candidate = this.legacyTombstoneCandidate(rows[0]);
        if (options.nowMs < candidate.deletedAtMs) {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
      } catch (error) {
        if (!(error instanceof LegacyTombstoneIntegrityFault)) throw error;
        await this.terminallyIsolateLegacyTombstoneCandidate(conn, rows[0], options, error.reasonCode);
        await conn.commit();
        return null;
      }
      const jobId = legacyTombstoneCompensationJobIdForSession(candidate.session.id);
      const [existing] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs WHERE session_id=? OR job_id=? FOR UPDATE`,
        [candidate.session.id, jobId],
      );
      if (existing.length > 1) throw new LegacyTombstoneJobConflictError();
      if (existing[0]) {
        await conn.commit();
        return null;
      }
      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
           (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
            source_subject_generation, source_claim_attempt, source_claim_token_sha256,
            maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
            status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
            last_error_code, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, 'maintenance', NULL, NULL, NULL, NULL, ?, ?, ?, ?,
                 'pending', 1, ?, 0, NULL, NULL, NULL, ?, ?)`,
        [
          jobId,
          candidate.session.id,
          candidate.session.tenantId,
          candidate.session.userId,
          options.actorKeyId,
          candidate.deletedAtMs,
          candidate.lastSeq,
          candidate.candidateSha256,
          options.nowMs,
          options.nowMs,
          options.nowMs,
        ],
      );
      const [createdRows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs WHERE job_id=?`,
        [jobId],
      );
      if (!createdRows[0]) throw new Error("legacy tombstone maintenance job was not created");
      const record = rowToLegacyTombstoneCompensationJob(createdRows[0]);
      await conn.commit();
      return record;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private async terminallyIsolateLegacyTombstoneCandidate(
    conn: PoolConnection,
    row: Row,
    options: ScheduleLegacyTombstoneCandidatesOptions,
    reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">,
  ): Promise<void> {
    const sessionId = String(row.session_id);
    const jobId = legacyTombstoneJobIdForRawSession(sessionId);
    const deletedAtRaw = String(row.deleted_at_ms);
    const lastSeqRaw = String(row.last_seq);
    const candidateEvidence = legacyTombstoneSha256("legacy-tombstone-unsafe-candidate-v1", [
      sessionId,
      String(row.tenant_id),
      String(row.user_id),
      deletedAtRaw,
      lastSeqRaw,
      reasonCode,
    ]);
    const [existingJobs] = await conn.query<Row[]>(
      `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
         FROM legacy_tombstone_compensation_jobs
        WHERE session_id=? OR job_id=? FOR UPDATE`,
      [sessionId, jobId],
    );
    if (existingJobs.length > 1) throw new LegacyTombstoneJobConflictError();
    const incidentJobId = existingJobs[0] ? String(existingJobs[0].job_id) : jobId;
    const incidentEvidence = legacyTombstoneSha256("legacy-tombstone-candidate-incident-v1", [
      incidentJobId,
      sessionId,
      candidateEvidence,
      reasonCode,
      options.nowMs,
    ]);
    if (existingJobs.length === 0) {
      await conn.query(
        `INSERT INTO legacy_tombstone_compensation_jobs
         (job_id, session_id, tenant_id, user_id, source_kind, source_request_id,
          source_subject_generation, source_claim_attempt, source_claim_token_sha256,
          maintenance_actor_key_id, source_deleted_at_ms, source_last_seq, candidate_sha256,
          status, control_generation, available_at_ms, attempts, claim_token, lease_until_ms,
          last_error_code, created_at_ms, updated_at_ms, terminal_at_ms, terminal_reason_code,
          terminal_evidence_sha256)
       VALUES (?, ?, ?, ?, 'maintenance', NULL, NULL, NULL, NULL, ?, ?, ?, ?,
                 'terminal_incident', 1, NULL, 0, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
        [
          jobId,
          sessionId,
          String(row.tenant_id),
          String(row.user_id),
          options.actorKeyId,
          row.deleted_at_ms,
          row.last_seq,
          candidateEvidence,
          options.nowMs,
          options.nowMs,
          options.nowMs,
          reasonCode,
          incidentEvidence,
        ],
      );
    }
    const resultRows = await this.readLegacyTombstoneResultRows(conn, incidentJobId, "FOR SHARE");
    if (resultRows.length > 0) return;
    await conn.query(
      `INSERT INTO legacy_tombstone_compensation_events
         (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
          claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
          before_sha256, after_sha256, emitted_at_ms)
       VALUES (?, ?, 1, 'legacy_tombstone/terminal_incident', ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
      [
        incidentJobId,
        sessionId,
        reasonCode,
        options.actorKeyId,
        row.deleted_at_ms,
        candidateEvidence,
        incidentEvidence,
        options.nowMs,
      ],
    );
  }

  async getLegacyTombstoneCompensationJob(
    tenantId: string,
    userId: string,
    jobId: string,
  ): Promise<LegacyTombstoneCompensationJobRecord | null> {
    return await this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs
          WHERE tenant_id=? AND user_id=? AND job_id=?`,
        [tenantId, userId, jobId],
      );
      const row = rows[0];
      if (!row) return null;
      const resultRows = await this.readLegacyTombstoneResultRows(conn, String(row.job_id));
      try {
        const job = rowToLegacyTombstoneCompensationJob(row);
        return this.resolveLegacyTombstoneJobResult(row, job, resultRows);
      } catch {
        return this.projectUnsafeLegacyTombstoneJob(row, resultRows);
      }
    });
  }

  async listLegacyTombstoneCompensationAudits(
    jobId: string,
  ): Promise<LegacyTombstoneCompensationAudit[]> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${LEGACY_TOMBSTONE_EVENT_COLUMNS}
         FROM legacy_tombstone_compensation_events
        WHERE job_id=? ORDER BY result_event_id`,
      [jobId],
    );
    return rows.map(rowToLegacyTombstoneAudit);
  }

  async claimLegacyTombstoneCompensations(
    options: ClaimLegacyTombstoneCompensationsOptions,
  ): Promise<LegacyTombstoneCompensationClaim[]> {
    const stagedOptions = structuredClone(options);
    const leaseUntilMs = validateClaimLegacyTombstoneCompensationsOptions(stagedOptions);
    if (!(await this.getLegacyTombstoneCutover())) {
      throw new LegacyTombstoneCutoverRequiredError();
    }
    const [candidateRows] = await this.pool.query<Row[]>(
      `SELECT j.job_id
         FROM legacy_tombstone_compensation_jobs j
        WHERE NOT EXISTS (
                SELECT 1 FROM legacy_tombstone_compensation_events e WHERE e.job_id=j.job_id
              )
          AND (
            (j.status='pending' AND j.available_at_ms IS NOT NULL
              AND j.available_at_ms<=?
              AND (j.claim_token IS NULL OR (j.lease_until_ms IS NOT NULL AND j.lease_until_ms<=?)))
            OR j.status<>'pending'
            OR j.available_at_ms IS NULL
            OR j.available_at_ms < 0
            OR j.available_at_ms > 9007199254740991
            OR (j.claim_token IS NULL AND j.lease_until_ms IS NOT NULL)
            OR (j.claim_token IS NOT NULL AND j.lease_until_ms IS NULL)
            OR j.lease_until_ms < 0
            OR j.lease_until_ms > 9007199254740991
          )
        ORDER BY j.job_id LIMIT 100`,
      [stagedOptions.nowMs, stagedOptions.nowMs],
    );
    const claims: LegacyTombstoneCompensationClaim[] = [];
    for (const candidate of candidateRows) {
      if (claims.length >= stagedOptions.limit) break;
      const result = await this.claimLegacyTombstoneCandidate(
        String(candidate.job_id),
        stagedOptions,
        leaseUntilMs,
      );
      if (result) claims.push(result);
    }
    return claims;
  }

  private async claimLegacyTombstoneCandidate(
    jobId: string,
    options: ClaimLegacyTombstoneCompensationsOptions,
    leaseUntilMs: number,
  ): Promise<LegacyTombstoneCompensationClaim | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.requireActiveLegacyTombstoneCutover(conn);
      const [rows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs WHERE job_id=? FOR UPDATE`,
        [jobId],
      );
      const row = rows[0];
      if (!row) {
        await conn.commit();
        return null;
      }
      const resultEvents = await this.readLegacyTombstoneResultRows(conn, jobId, "FOR SHARE");
      if (resultEvents.length > 0) {
        await conn.commit();
        return null;
      }
      let record: LegacyTombstoneCompensationJobRecord;
      try {
        record = rowToLegacyTombstoneCompensationJob(row);
      } catch {
        await this.terminallyIsolateUnsafeLegacyTombstoneJob(conn, row, options.nowMs);
        await conn.commit();
        return null;
      }
      if (record.status !== "pending") {
        await this.appendLegacyTombstoneMissingResultIncident(conn, row, record, options.nowMs);
        await conn.commit();
        return null;
      }
      if (
        record.availableAtMs === undefined
        || record.availableAtMs > options.nowMs
        || (
          record.claimToken !== undefined
          && (record.leaseUntilMs === undefined || record.leaseUntilMs > options.nowMs)
        )
      ) {
        await conn.commit();
        return null;
      }
      const nextAttempts = record.attempts + 1;
      if (!Number.isSafeInteger(nextAttempts) || nextAttempts <= 0) {
        await this.terminallyIsolateUnsafeLegacyTombstoneJob(conn, row, options.nowMs);
        await conn.commit();
        return null;
      }
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE legacy_tombstone_compensation_jobs
            SET attempts=?, claim_token=?, lease_until_ms=?, last_error_code=NULL,
                updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE job_id=? AND status='pending'`,
        [nextAttempts, options.claimToken, leaseUntilMs, options.nowMs, jobId],
      );
      if (updated.affectedRows !== 1) throw new Error("legacy tombstone claim changed while locked");
      const [claimedRows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs WHERE job_id=?`,
        [jobId],
      );
      if (!claimedRows[0]) throw new Error("legacy tombstone claim disappeared");
      const claim = legacyTombstoneCompensationClaimFromRecord(
        rowToLegacyTombstoneCompensationJob(claimedRows[0]),
      );
      await conn.commit();
      return claim;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private async terminallyIsolateUnsafeLegacyTombstoneJob(
    conn: PoolConnection,
    row: Row,
    emittedAtMs: number,
  ): Promise<void> {
    const envelope = rowToLegacyTombstoneUnsafeEnvelope(row);
    const evidence = legacyTombstoneUnsafeJobEnvelopeEvidenceSha256(envelope);
    // Do not normalize corrupt identity/generation/time fields. The append-only event revokes this
    // locator from future claims while preserving the exact raw envelope under a one-way digest.
    await conn.query(
      `INSERT INTO legacy_tombstone_compensation_events
         (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
          claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
          before_sha256, after_sha256, emitted_at_ms)
       VALUES (?, ?, 1, 'legacy_tombstone/terminal_incident', 'unsafe_job_envelope', NULL,
               NULL, ?, NULL, NULL, ?, ?, ?)`,
      [
        envelope.locatorJobId,
        envelope.sessionId,
        row.source_deleted_at_ms,
        evidence,
        evidence,
        emittedAtMs,
      ],
    );
  }

  async renewLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RenewLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedOptions = structuredClone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    const leaseUntilMs = validateRenewLegacyTombstoneCompensationOptions(stagedOptions);
    const [updated] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE legacy_tombstone_compensation_jobs j
          SET lease_until_ms=GREATEST(lease_until_ms, ?),
              updated_at_ms=GREATEST(updated_at_ms, ?)
        WHERE j.job_id=? AND j.tenant_id=? AND j.user_id=? AND j.session_id=?
          AND j.control_generation=1 AND j.status='pending'
          AND j.claim_token=? AND j.attempts=? AND j.lease_until_ms>?
          AND NOT EXISTS (
            SELECT 1 FROM legacy_tombstone_compensation_events e WHERE e.job_id=j.job_id
          )`,
      [
        leaseUntilMs,
        stagedOptions.nowMs,
        stagedAuthorization.jobId,
        stagedAuthorization.tenantId,
        stagedAuthorization.userId,
        stagedAuthorization.sessionId,
        stagedAuthorization.claimToken,
        stagedAuthorization.claimAttempt,
        stagedOptions.nowMs,
      ],
    );
    return updated.affectedRows === 1;
  }

  async retryLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RetryLegacyTombstoneCompensationOptions,
  ): Promise<boolean> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedOptions = structuredClone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    validateRetryLegacyTombstoneCompensationOptions(stagedOptions);
    const [updated] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE legacy_tombstone_compensation_jobs j
          SET available_at_ms=?, claim_token=NULL, lease_until_ms=NULL,
              last_error_code=?, updated_at_ms=GREATEST(updated_at_ms, ?)
        WHERE j.job_id=? AND j.tenant_id=? AND j.user_id=? AND j.session_id=?
          AND j.control_generation=1 AND j.status='pending'
          AND j.claim_token=? AND j.attempts=? AND j.lease_until_ms>?
          AND ?>=j.created_at_ms
          AND NOT EXISTS (
            SELECT 1 FROM legacy_tombstone_compensation_events e WHERE e.job_id=j.job_id
          )`,
      [
        stagedOptions.availableAtMs,
        stagedOptions.errorCode,
        stagedOptions.failedAtMs,
        stagedAuthorization.jobId,
        stagedAuthorization.tenantId,
        stagedAuthorization.userId,
        stagedAuthorization.sessionId,
        stagedAuthorization.claimToken,
        stagedAuthorization.claimAttempt,
        stagedOptions.failedAtMs,
        stagedOptions.availableAtMs,
      ],
    );
    return updated.affectedRows === 1;
  }

  private async writeLegacyTombstoneTerminalIncident(
    conn: PoolConnection,
    jobRow: Row,
    job: LegacyTombstoneCompensationJobRecord,
    authorization: LegacyTombstoneCompensationAuthorization,
    atMs: number,
    reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">,
  ): Promise<LegacyTombstoneCompensationResult> {
    const existingResults = await this.readLegacyTombstoneResultRows(conn, job.jobId, "FOR SHARE");
    if (existingResults.length > 0) {
      const projection = this.projectLegacyTombstoneProofConflict(
        jobRow,
        job,
        existingResults,
      );
      return {
        outcome: "terminal_incident",
        jobId: projection.jobId,
        reasonCode: "proof_conflict",
        evidenceSha256: projection.terminalEvidenceSha256!,
      };
    }
    const emittedAtMs = Math.max(job.updatedAtMs, atMs);
    const evidence = legacyTombstoneTerminalIncidentEvidenceSha256({
      jobId: job.jobId,
      sessionId: job.sessionId,
      cutoverGeneration: 1,
      legacyDeletedAtMs: job.legacyDeletedAtMs,
      claimAttempt: authorization.claimAttempt,
      reasonCode,
    });
    const [inserted] = await conn.query<mysql.ResultSetHeader>(
      `INSERT INTO legacy_tombstone_compensation_events
         (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
          claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
          before_sha256, after_sha256, emitted_at_ms)
       VALUES (?, ?, 1, 'legacy_tombstone/terminal_incident', ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        job.jobId,
        job.sessionId,
        reasonCode,
        job.sourceKind === "maintenance" ? job.maintenanceActorKeyId : null,
        authorization.claimAttempt,
        job.legacyDeletedAtMs,
        String(jobRow.candidate_sha256),
        evidence,
        emittedAtMs,
      ],
    );
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE legacy_tombstone_compensation_jobs
          SET status='terminal_incident', available_at_ms=NULL, claim_token=NULL,
              lease_until_ms=NULL, last_error_code=NULL, updated_at_ms=?, terminal_at_ms=?,
              terminal_reason_code=?, terminal_evidence_sha256=?
        WHERE job_id=? AND tenant_id=? AND user_id=? AND session_id=?
          AND control_generation=1 AND status='pending' AND claim_token=? AND attempts=?`,
      [
        emittedAtMs,
        emittedAtMs,
        reasonCode,
        evidence,
        job.jobId,
        job.tenantId,
        job.userId,
        job.sessionId,
        authorization.claimToken,
        authorization.claimAttempt,
      ],
    );
    if (updated.affectedRows !== 1) {
      throw new Error("legacy tombstone job changed while recording terminal incident");
    }
    const audit: LegacyTombstoneCompensationAudit = {
      auditId: Number(inserted.insertId),
      jobId: job.jobId,
      type: "legacy_tombstone/terminal_incident",
      reasonCode,
      evidenceSha256: evidence,
      emittedAtMs,
    };
    validateLegacyTombstoneCompensationAudit(audit);
    return { outcome: "terminal_incident", jobId: job.jobId, reasonCode, evidenceSha256: evidence };
  }

  private async assertCompletedLegacyTombstoneCompensation(
    conn: PoolConnection,
    job: Extract<LegacyTombstoneCompensationJobRecord, { status: "completed" }> | LegacyTombstoneCompensationJobRecord,
    jobRow: Row,
    sessionRow: Row,
  ): Promise<LegacyTombstoneCompensationResult> {
    if (
      job.status !== "completed"
      || job.completedEventSeq === undefined
      || job.completedClaimAttempt === undefined
      || job.completedAtMs === undefined
    ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
    const sourceLastSeq = Number(jobRow.source_last_seq);
    if (
      sessionRow.session_id !== job.sessionId
      || sessionRow.tenant_id !== job.tenantId
      || sessionRow.user_id !== job.userId
      || Number(sessionRow.deleted_at_ms) !== job.legacyDeletedAtMs
      || Number(sessionRow.deletion_generation) !== 1
      || Number(sessionRow.last_seq) !== job.completedEventSeq
      || !Number.isSafeInteger(sourceLastSeq)
      || sourceLastSeq < 0
      || sourceLastSeq >= job.completedEventSeq
      || String(jobRow.candidate_sha256) !== legacyTombstoneCandidateSha256({
        sessionId: job.sessionId,
        tenantId: job.tenantId,
        userId: job.userId,
        deletedAtMs: job.legacyDeletedAtMs,
        lastSeq: sourceLastSeq,
      })
    ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
    await this.assertExistingErasureSessionTombstone(
      conn,
      job.sessionId,
      job.userId,
      sessionRow.deleted_at_ms,
      sessionRow.purge_after_ms,
      sessionRow.last_seq,
      sessionRow.deletion_generation,
    );
    const [auditRows] = await conn.query<Row[]>(
      `SELECT result_event_id, job_id, session_id, control_generation, event_type, reason_code,
              actor_key_id, claim_attempt, source_deleted_at_ms, target_deletion_generation,
              terminal_event_seq, before_sha256, after_sha256, emitted_at_ms
         FROM legacy_tombstone_compensation_events WHERE job_id=? FOR SHARE`,
      [job.jobId],
    );
    const auditRow = auditRows[0];
    if (auditRows.length !== 1 || !auditRow) {
      throw new LegacyTombstoneIntegrityFault("proof_conflict");
    }
    if (!this.legacyTombstoneResultMatchesJob(jobRow, job, auditRows)) {
      throw new LegacyTombstoneIntegrityFault("proof_conflict");
    }
    const audit = rowToLegacyTombstoneAudit(auditRow);
    const expectedEvidence = legacyTombstoneSuccessEvidenceSha256({
      jobId: job.jobId,
      tenantId: job.tenantId,
      userId: job.userId,
      sessionId: job.sessionId,
      cutoverGeneration: 1,
      legacyDeletedAtMs: job.legacyDeletedAtMs,
      deletionGeneration: 1,
      eventSeq: job.completedEventSeq,
      claimAttempt: job.completedClaimAttempt,
      emittedAtMs: job.completedAtMs,
    });
    if (
      audit.type !== "legacy_tombstone/compensated"
      || audit.sessionId !== job.sessionId
      || audit.eventSeq !== job.completedEventSeq
      || audit.claimAttempt !== job.completedClaimAttempt
      || audit.emittedAtMs !== job.completedAtMs
      || audit.evidenceSha256 !== expectedEvidence
    ) throw new LegacyTombstoneIntegrityFault("proof_conflict");
    return {
      outcome: "already_compensated",
      sessionId: job.sessionId,
      deletionGeneration: 1,
      eventSeq: job.completedEventSeq,
    };
  }

  private async assertLegacyTombstoneChildrenResolved(
    conn: PoolConnection,
    job: LegacyTombstoneCompensationJobRecord,
  ): Promise<void> {
    let ancestorRows: Row[];
    try {
      [ancestorRows] = await conn.query<Row[]>(
        `WITH RECURSIVE ancestors (session_id, parent_session_id, tenant_id, user_id) AS (
           SELECT session_id, parent_session_id, tenant_id, user_id
             FROM sessions WHERE session_id=?
           UNION DISTINCT
           SELECT p.session_id, p.parent_session_id, p.tenant_id, p.user_id
             FROM sessions p JOIN ancestors a ON p.session_id=a.parent_session_id
         )
         SELECT session_id, parent_session_id, tenant_id, user_id FROM ancestors`,
        [job.sessionId],
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === "ER_CTE_MAX_RECURSION_DEPTH") {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      throw error;
    }
    const ancestors = new Map(ancestorRows.map((row) => [String(row.session_id), row]));
    let ancestor = ancestors.get(job.sessionId);
    const visited = new Set<string>();
    while (ancestor) {
      const ancestorId = String(ancestor.session_id);
      if (
        visited.has(ancestorId)
        || !isCanonicalId("sess", ancestorId)
        || ancestor.tenant_id !== job.tenantId
        || ancestor.user_id !== job.userId
      ) throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      visited.add(ancestorId);
      if (ancestor.parent_session_id == null) break;
      const parentId = String(ancestor.parent_session_id);
      if (!isCanonicalId("sess", parentId)) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      ancestor = ancestors.get(parentId);
      if (!ancestor) throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
    }
    if (!ancestor) throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");

    const [children] = await conn.query<Row[]>(
      "SELECT * FROM sessions WHERE parent_session_id=? ORDER BY session_id FOR SHARE",
      [job.sessionId],
    );
    for (const child of children) {
      const childSessionId = String(child.session_id);
      if (
        !isCanonicalId("sess", childSessionId)
        || child.tenant_id !== job.tenantId
        || child.user_id !== job.userId
      ) throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      const generation = Number(child.deletion_generation);
      if (child.deleted_at_ms == null) {
        // A live child is not a compensation candidate, so the global legacy sweep can never make
        // this dependency progress. Retrying the parent would be an infinite loop.
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      if (generation === 0) {
        await this.assertLegacyTombstoneGenerationZeroChildPending(conn, job, child);
      }
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      try {
        await this.assertExistingErasureSessionTombstone(
          conn,
          childSessionId,
          job.userId,
          child.deleted_at_ms,
          child.purge_after_ms,
          child.last_seq,
          child.deletion_generation,
        );
      } catch (error) {
        if ((error as { code?: unknown })?.code) throw error;
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
    }
  }

  private async assertLegacyTombstoneGenerationZeroChildPending(
    conn: PoolConnection,
    parentJob: LegacyTombstoneCompensationJobRecord,
    childRow: Row,
  ): Promise<never> {
    const childSessionId = String(childRow.session_id);
    const expectedJobId = legacyTombstoneCompensationJobIdForSession(childSessionId);
    // Include the deterministic job locator as well as the session locator. A corrupt cross-owner
    // or hash-collision row must be surfaced as an invalid dependency, not hidden as "not scheduled".
    const [jobRows] = await conn.query<Row[]>(
      `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
         FROM legacy_tombstone_compensation_jobs
        WHERE session_id=? OR job_id=? ORDER BY job_id FOR SHARE`,
      [childSessionId, expectedJobId],
    );
    if (jobRows.length > 1) {
      throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
    }

    const relatedJobIds = new Set<string>([expectedJobId]);
    if (jobRows[0]) relatedJobIds.add(String(jobRows[0].job_id));
    const resultJobIds = [...relatedJobIds];
    const [resultRows] = await conn.query<Row[]>(
      `SELECT ${LEGACY_TOMBSTONE_EVENT_COLUMNS}
         FROM legacy_tombstone_compensation_events
        WHERE session_id=? OR job_id IN (${resultJobIds.map(() => "?").join(",")})
        ORDER BY result_event_id FOR SHARE`,
      [childSessionId, ...resultJobIds],
    );

    if (jobRows.length === 0) {
      if (resultRows.length > 0) {
        throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
      }
      throw new LegacyTombstoneChildPendingError(parentJob.sessionId);
    }
    // A generation-zero child cannot have any durable result. A result means the child is terminal,
    // proof-conflicted, unsafe, or claims completion while its session marker still contradicts it.
    if (resultRows.length > 0) {
      throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
    }

    try {
      const candidate = this.legacyTombstoneCandidate(childRow);
      const childJob = rowToLegacyTombstoneCompensationJob(jobRows[0]!);
      if (
        childJob.jobId !== expectedJobId
        || childJob.sessionId !== childSessionId
        || childJob.tenantId !== parentJob.tenantId
        || childJob.userId !== parentJob.userId
        || childJob.status !== "pending"
        || candidate.session.parentSessionId !== parentJob.sessionId
      ) throw new LegacyTombstoneJobConflictError();
      this.assertLegacyTombstoneJobCandidate(jobRows[0]!, candidate);
    } catch {
      throw new LegacyTombstoneIntegrityFault("child_dependency_invalid");
    }
    throw new LegacyTombstoneChildPendingError(parentJob.sessionId);
  }

  private async validateLegacyTombstoneEventLog(
    conn: PoolConnection,
    job: LegacyTombstoneCompensationJobRecord,
    lastSeq: number,
  ): Promise<void> {
    const [rows] = await conn.query<Row[]>(
      `SELECT session_id, seq, user_id, type, body, emitted_at_ms
         FROM events WHERE session_id=? ORDER BY seq FOR SHARE`,
      [job.sessionId],
    );
    if (rows.length !== lastSeq) {
      throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
    }
    for (const [index, row] of rows.entries()) {
      let event: PersistedEvent;
      try {
        event = EventSchema.parse(parse<unknown>(row.body)) as PersistedEvent;
      } catch {
        throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
      }
      if (
        row.session_id !== job.sessionId
        || row.user_id !== job.userId
        || Number(row.seq) !== index + 1
        || event.sessionId !== job.sessionId
        || event.seq !== index + 1
        || event.type !== row.type
        || event.emittedAtMs !== Number(row.emitted_at_ms)
        || event.emittedAtMs > job.legacyDeletedAtMs
        || event.type === "session/deleted"
      ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
    }
  }

  async completeLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: CompleteLegacyTombstoneCompensationOptions,
  ): Promise<LegacyTombstoneCompensationResult | null> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedOptions = structuredClone(options);
    validateLegacyTombstoneCompensationAuthorization(stagedAuthorization);
    validateCompleteLegacyTombstoneCompensationOptions(stagedOptions);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.requireActiveLegacyTombstoneCutover(conn);
      const [sessionRows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? AND session_id=? FOR UPDATE`,
        [stagedAuthorization.tenantId, stagedAuthorization.userId, stagedAuthorization.sessionId],
      );
      const [jobRows] = await conn.query<Row[]>(
        `SELECT ${LEGACY_TOMBSTONE_JOB_COLUMNS}
           FROM legacy_tombstone_compensation_jobs FORCE INDEX (idx_legacy_tombstone_compensation_jobs_owner)
          WHERE tenant_id=? AND user_id=? AND session_id=? AND job_id=? FOR UPDATE`,
        [
          stagedAuthorization.tenantId,
          stagedAuthorization.userId,
          stagedAuthorization.sessionId,
          stagedAuthorization.jobId,
        ],
      );
      if (!jobRows[0]) {
        await conn.commit();
        return null;
      }
      const jobRow = jobRows[0];
      const storedJob = rowToLegacyTombstoneCompensationJob(jobRow);
      const resultRows = await this.readLegacyTombstoneResultRows(
        conn,
        storedJob.jobId,
        "FOR SHARE",
      );
      const job = this.resolveLegacyTombstoneJobResult(jobRow, storedJob, resultRows);
      if (job !== storedJob) {
        await conn.commit();
        return null;
      }
      if (job.status === "completed") {
        if (
          job.completedClaimAttempt !== stagedAuthorization.claimAttempt
          || job.completedClaimTokenSha256
            !== legacyTombstoneClaimTokenSha256(stagedAuthorization.claimToken)
          || !sessionRows[0]
        ) {
          await conn.commit();
          return null;
        }
        const result = await this.assertCompletedLegacyTombstoneCompensation(
          conn,
          job,
          jobRow,
          sessionRows[0],
        );
        await conn.commit();
        return result;
      }
      if (job.status === "terminal_incident") {
        await conn.commit();
        return null;
      }
      if (!legacyTombstoneCompensationAuthorizationMatches(
        job,
        stagedAuthorization,
        stagedOptions.completedAtMs,
      )) {
        await conn.commit();
        return null;
      }

      await conn.query("SAVEPOINT legacy_tombstone_completion");
      try {
        const sessionRow = sessionRows[0];
        if (!sessionRow) throw new LegacyTombstoneIntegrityFault("owner_binding_invalid");
        const candidate = this.legacyTombstoneCandidate(sessionRow);
        try {
          this.assertLegacyTombstoneJobCandidate(jobRow, candidate);
        } catch (error) {
          if (error instanceof LegacyTombstoneJobConflictError) {
            throw new LegacyTombstoneIntegrityFault("proof_conflict");
          }
          throw error;
        }
        await this.assertLegacyTombstoneChildrenResolved(conn, job);
        await this.validateLegacyTombstoneEventLog(conn, job, candidate.lastSeq);
        const [conflicts] = await conn.query<Row[]>(
          `SELECT
             (SELECT COUNT(*) FROM lifecycle_outbox
               WHERE aggregate_id=? AND generation=1) AS outbox_count,
             (SELECT COUNT(*) FROM usage_reconciliations
               WHERE session_id=? AND deletion_generation=1) AS reconciliation_count,
             (SELECT COUNT(*) FROM legacy_tombstone_compensation_events
               WHERE job_id=?) AS audit_count`,
          [job.sessionId, job.sessionId, job.jobId],
        );
        if (
          Number(conflicts[0]?.outbox_count) !== 0
          || Number(conflicts[0]?.reconciliation_count) !== 0
          || Number(conflicts[0]?.audit_count) !== 0
        ) throw new LegacyTombstoneIntegrityFault("proof_conflict");

        let status: Session["status"];
        try {
          status = SessionStatusSchema.parse(parse<unknown>(sessionRow.status));
        } catch {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        const [turnRows] = await conn.query<Row[]>(
          `SELECT turn_id, session_id, user_id, status, body
             FROM turns WHERE session_id=? AND status='inProgress' ORDER BY turn_id FOR UPDATE`,
          [job.sessionId],
        );
        if (
          (status.type === "active" && (
            turnRows.length !== 1 || turnRows[0]?.turn_id !== status.turnId
          ))
          || (status.type !== "active" && turnRows.length !== 0)
        ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");

        let activeTurn: Turn | undefined;
        if (status.type === "active") {
          try {
            activeTurn = TurnSchema.parse(parse<unknown>(turnRows[0]!.body));
          } catch {
            throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
          }
          if (
            activeTurn.id !== status.turnId
            || activeTurn.sessionId !== job.sessionId
            || turnRows[0]!.session_id !== job.sessionId
            || turnRows[0]!.user_id !== job.userId
            || activeTurn.status !== "inProgress"
            || activeTurn.startedAtMs > candidate.deletedAtMs
          ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }

        let resolution: Awaited<ReturnType<MysqlSessionStore["lockErasureResolution"]>>;
        try {
          resolution = await this.lockErasureResolution(
            conn,
            job.sessionId,
            job.userId,
            candidate.deletedAtMs,
          );
        } catch (error) {
          if ((error as { code?: unknown })?.code) throw error;
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        if (resolution.approvals.some((approval) => approval.createdAtMs > candidate.deletedAtMs)) {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }

        const eventInputs: EventInput[] = [];
        for (const approval of resolution.approvals) {
          eventInputs.push({
            type: "approval/resolved",
            sessionId: job.sessionId,
            emittedAtMs: candidate.deletedAtMs,
            approval,
          });
          const item = resolution.items.find((value) => (
            value.type === "approvalRequest" && value.approvalId === approval.id
          ));
          if (!item) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
          eventInputs.push({
            type: "item/completed",
            sessionId: job.sessionId,
            emittedAtMs: candidate.deletedAtMs,
            item,
          });
        }

        const terminalEventSeq = candidate.lastSeq
          + eventInputs.length
          + (activeTurn ? 3 : 1);
        if (
          !Number.isSafeInteger(terminalEventSeq)
          || terminalEventSeq <= candidate.lastSeq
        ) throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");

        let terminalTurn: Turn | undefined;
        if (activeTurn) {
          try {
            terminalTurn = TurnSchema.parse({
              ...activeTurn,
              status: "interrupted",
              stopReason: "interrupted",
              completedAtMs: candidate.deletedAtMs,
              error: {
                code: "legacy_tombstone_compensation",
                message: "turn interrupted during legacy tombstone compensation",
              },
              seqEnd: terminalEventSeq - 1,
            });
          } catch {
            throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
          }
          eventInputs.push({
            type: "turn/completed",
            sessionId: job.sessionId,
            emittedAtMs: candidate.deletedAtMs,
            turn: terminalTurn,
            stopReason: "interrupted",
          });
          eventInputs.push({
            type: "session/status/changed",
            sessionId: job.sessionId,
            emittedAtMs: candidate.deletedAtMs,
            status: { type: "idle" },
          });
        }
        eventInputs.push({
          type: "session/deleted",
          sessionId: job.sessionId,
          emittedAtMs: candidate.deletedAtMs,
          deletionGeneration: 1,
        });
        let seq = candidate.lastSeq;
        let events: PersistedEvent[];
        try {
          events = eventInputs.map((event) => (
            EventSchema.parse({ ...event, seq: ++seq }) as PersistedEvent
          ));
        } catch {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        const terminal = events.at(-1);
        if (terminal?.type !== "session/deleted" || terminal.seq !== terminalEventSeq) {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        const completedAtMs = Math.max(job.updatedAtMs, stagedOptions.completedAtMs);
        let stagedSession: Session;
        try {
          stagedSession = SessionSchema.parse({
            ...candidate.session,
            ...(activeTurn ? { status: { type: "idle" as const } } : {}),
            lastSeq: terminal.seq,
            updatedAtMs: Math.max(candidate.session.updatedAtMs, completedAtMs),
            autoApprovedTools: [],
          });
        } catch {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }
        const successEvidence = legacyTombstoneSuccessEvidenceSha256({
          jobId: job.jobId,
          tenantId: job.tenantId,
          userId: job.userId,
          sessionId: job.sessionId,
          cutoverGeneration: 1,
          legacyDeletedAtMs: job.legacyDeletedAtMs,
          deletionGeneration: 1,
          eventSeq: terminal.seq,
          claimAttempt: stagedAuthorization.claimAttempt,
          emittedAtMs: completedAtMs,
        });
        let serializedEvents: string[];
        let serializedItems: string[];
        let serializedApprovals: string[];
        let serializedTurn: string | undefined;
        let tombstonedPayload: string;
        let purgePayload: string;
        try {
          serializedEvents = events.map((event) => json(event));
          serializedItems = resolution.items.map((item) => json(item));
          serializedApprovals = resolution.approvals.map((approval) => json(approval));
          serializedTurn = terminalTurn ? json(terminalTurn) : undefined;
          tombstonedPayload = json({
            sessionId: job.sessionId,
            deletionGeneration: 1,
            eventSeq: terminal.seq,
          });
          purgePayload = json({ sessionId: job.sessionId, deletionGeneration: 1 });
        } catch {
          throw new LegacyTombstoneIntegrityFault("session_integrity_conflict");
        }

        for (const [index, item] of resolution.items.entries()) {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE items SET status='declined', body=?, completed_at_ms=?
              WHERE item_id=? AND session_id=? AND user_id=?
                AND type='approvalRequest' AND status='inProgress'`,
            [serializedItems[index], candidate.deletedAtMs, item.id, job.sessionId, job.userId],
          );
          if (updated.affectedRows !== 1) throw new Error("legacy approval item changed while locked");
        }
        for (const [index, approval] of resolution.approvals.entries()) {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE approvals SET status='expired', body=?
              WHERE approval_id=? AND session_id=? AND user_id=? AND status='pending'`,
            [serializedApprovals[index], approval.id, job.sessionId, job.userId],
          );
          if (updated.affectedRows !== 1) throw new Error("legacy approval changed while locked");
        }
        if (terminalTurn) {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE turns SET status='interrupted', stop_reason='interrupted', seq_end=?,
                    body=?, completed_at_ms=?
              WHERE turn_id=? AND session_id=? AND user_id=? AND status='inProgress'`,
            [
              terminalTurn.seqEnd,
              serializedTurn,
              candidate.deletedAtMs,
              terminalTurn.id,
              job.sessionId,
              job.userId,
            ],
          );
          if (updated.affectedRows !== 1) throw new Error("legacy active turn changed while locked");
        }
        await conn.query(
          "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
          [events.map((event, index) => [
            job.sessionId,
            event.seq,
            job.userId,
            event.type,
            serializedEvents[index],
            event.emittedAtMs,
          ])],
        );
        await conn.query(
          `INSERT INTO lifecycle_outbox
             (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
           VALUES ?`,
          [[
            ["session.tombstoned", job.sessionId, 1, tombstonedPayload, completedAtMs, 0, completedAtMs],
            ["session.purge", job.sessionId, 1, purgePayload, null, 0, completedAtMs],
          ]],
        );
        const [sessionUpdated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE sessions
              SET status=?, last_seq=?, auto_approved_tools=?, updated_at_ms=?,
                  purge_after_ms=NULL, deletion_generation=1
            WHERE session_id=? AND tenant_id=? AND user_id=?
              AND deleted_at_ms=? AND deletion_generation=0 AND last_seq=?`,
          [
            json(stagedSession.status),
            terminal.seq,
            json([]),
            stagedSession.updatedAtMs,
            job.sessionId,
            job.tenantId,
            job.userId,
            candidate.deletedAtMs,
            candidate.lastSeq,
          ],
        );
        if (sessionUpdated.affectedRows !== 1) throw new Error("legacy session changed while locked");
        const [auditInserted] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO legacy_tombstone_compensation_events
             (job_id, session_id, control_generation, event_type, reason_code, actor_key_id,
              claim_attempt, source_deleted_at_ms, target_deletion_generation, terminal_event_seq,
              before_sha256, after_sha256, emitted_at_ms)
           VALUES (?, ?, 1, 'legacy_tombstone/compensated', NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [
            job.jobId,
            job.sessionId,
            job.sourceKind === "maintenance" ? job.maintenanceActorKeyId : null,
            stagedAuthorization.claimAttempt,
            job.legacyDeletedAtMs,
            terminal.seq,
            String(jobRow.candidate_sha256),
            successEvidence,
            completedAtMs,
          ],
        );
        const successAudit: LegacyTombstoneCompensationAudit = {
          auditId: Number(auditInserted.insertId),
          jobId: job.jobId,
          type: "legacy_tombstone/compensated",
          sessionId: job.sessionId,
          cutoverGeneration: 1,
          deletionGeneration: 1,
          eventSeq: terminal.seq,
          claimAttempt: stagedAuthorization.claimAttempt,
          evidenceSha256: successEvidence,
          emittedAtMs: completedAtMs,
        };
        validateLegacyTombstoneCompensationAudit(successAudit);
        const [jobUpdated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE legacy_tombstone_compensation_jobs
              SET status='completed', available_at_ms=NULL, claim_token=NULL,
                  lease_until_ms=NULL, last_error_code=NULL, updated_at_ms=?, completed_at_ms=?,
                  completed_event_seq=?, completed_claim_attempt=?, completed_claim_token_sha256=?
            WHERE job_id=? AND tenant_id=? AND user_id=? AND session_id=?
              AND control_generation=1 AND status='pending' AND claim_token=? AND attempts=?`,
          [
            completedAtMs,
            completedAtMs,
            terminal.seq,
            stagedAuthorization.claimAttempt,
            legacyTombstoneClaimTokenSha256(stagedAuthorization.claimToken),
            job.jobId,
            job.tenantId,
            job.userId,
            job.sessionId,
            stagedAuthorization.claimToken,
            stagedAuthorization.claimAttempt,
          ],
        );
        if (jobUpdated.affectedRows !== 1) throw new Error("legacy tombstone job changed while completing");
        await conn.commit();
        return {
          outcome: "compensated",
          sessionId: job.sessionId,
          deletionGeneration: 1,
          eventSeq: terminal.seq,
        };
      } catch (error) {
        if (error instanceof LegacyTombstoneChildPendingError) throw error;
        if (!(error instanceof LegacyTombstoneIntegrityFault)) throw error;
        // Keep terminal isolation atomic even if a future validation is accidentally placed after
        // one of the content updates above. The incident must never commit a partial settlement.
        await conn.query("ROLLBACK TO SAVEPOINT legacy_tombstone_completion");
        const result = await this.writeLegacyTombstoneTerminalIncident(
          conn,
          jobRow,
          job,
          stagedAuthorization,
          stagedOptions.completedAtMs,
          error.reasonCode,
        );
        await conn.commit();
        return result;
      }
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  // ---------- retention policy and legal holds ----------
  private async loadRetentionPolicyVersion(
    conn: PoolConnection,
    tenantId: string,
    policyVersion: string,
    lockClause = "",
  ): Promise<RetentionPolicyVersionRecord | null> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${RETENTION_POLICY_VERSION_COLUMNS}
         FROM retention_policy_versions
        WHERE tenant_id=? AND policy_version=? ${lockClause}`,
      [tenantId, policyVersion],
    );
    return rows[0] ? rowToRetentionPolicyVersion(rows[0]) : null;
  }

  async putRetentionPolicy(input: PutRetentionPolicyInput): Promise<RetentionPolicyVersionRecord> {
    input = structuredClone(input);
    validatePutRetentionPolicyInput(input);
    const record: RetentionPolicyVersionRecord = {
      tenantId: input.tenantId,
      policyVersion: input.policyVersion,
      schemaVersion: RETENTION_POLICY_SCHEMA_VERSION,
      policy: structuredClone(input.policy),
      policySha256: retentionPolicySha256(input.tenantId, input.policyVersion, input.policy),
      createdByKeyId: input.actorKeyId,
      createdAtMs: input.atMs,
    };
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // All policy writers take the per-tenant control before immutable versions. Activation and
      // erasure binding use the same order, avoiding a control/version lock inversion.
      await conn.query(
        `INSERT IGNORE INTO retention_policy_controls
           (tenant_id, control_generation, active_policy_version, active_policy_sha256,
            effective_at_ms, updated_at_ms)
         VALUES (?,0,NULL,NULL,NULL,0)`,
        [input.tenantId],
      );
      await conn.query(
        `INSERT IGNORE INTO retention_policy_versions
           (tenant_id, policy_version, schema_version, session_content_retention_ms,
            user_erasure_grace_ms, operational_usage_retention_ms,
            idempotency_receipt_retention_ms, billing_fact_retention_ms,
            lifecycle_audit_retention_ms, export_artifact_ttl_ms, policy_sha256,
            created_by_key_id, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          record.tenantId,
          record.policyVersion,
          record.schemaVersion,
          record.policy.sessionContentRetentionMs,
          record.policy.userErasureGraceMs,
          record.policy.operationalUsageRetentionMs,
          record.policy.idempotencyReceiptRetentionMs,
          record.policy.billingFactRetentionMs,
          record.policy.lifecycleAuditRetentionMs,
          record.policy.exportArtifactTtlMs,
          record.policySha256,
          record.createdByKeyId,
          record.createdAtMs,
        ],
      );
      const stored = await this.loadRetentionPolicyVersion(
        conn,
        input.tenantId,
        input.policyVersion,
        "FOR SHARE",
      );
      if (
        !stored
        || stored.policySha256 !== record.policySha256
        || RETENTION_POLICY_DURATION_FIELDS.some(
          (field) => stored.policy[field] !== record.policy[field],
        )
      ) {
        throw new RetentionPolicyVersionConflictError(input.policyVersion);
      }
      // Creation metadata belongs to the first successful immutable write. A retry carrying a new
      // request timestamp or actor is still the same policy document and must not rewrite history.
      await conn.commit();
      return stored;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async activateRetentionPolicy(
    input: ActivateRetentionPolicyInput,
  ): Promise<RetentionPolicyControlRecord> {
    input = structuredClone(input);
    validateActivateRetentionPolicyInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [controlRows] = await conn.query<Row[]>(
        `SELECT ${RETENTION_POLICY_CONTROL_COLUMNS}
           FROM retention_policy_controls WHERE tenant_id=? FOR UPDATE`,
        [input.tenantId],
      );
      if (!controlRows[0]) throw new RetentionPolicyNotFoundError(input.policyVersion);
      const current = rowToRetentionPolicyControl(controlRows[0]);
      const validatedActive = await this.loadValidatedActiveRetentionPolicy(
        conn,
        input.tenantId,
        "FOR UPDATE",
      );
      if (
        (current.controlGeneration === 0 && validatedActive !== null)
        || (current.controlGeneration > 0 && (
          !validatedActive
          || retentionPolicyControlSha256(validatedActive.control)
            !== retentionPolicyControlSha256(current)
        ))
      ) throw new Error("retention policy control changed or failed audit validation");
      const policy = await this.loadRetentionPolicyVersion(
        conn,
        input.tenantId,
        input.policyVersion,
        "FOR SHARE",
      );
      if (!policy) throw new RetentionPolicyNotFoundError(input.policyVersion);

      if (input.expectedControlGeneration !== current.controlGeneration) {
        // Only the immediately preceding exact activation is replayable. This closes the
        // response-lost window without turning an arbitrarily stale generation into authority.
        if (
          input.expectedControlGeneration + 1 === current.controlGeneration
          && current.activePolicyVersion === policy.policyVersion
          && current.activePolicySha256 === policy.policySha256
        ) {
          const [tailRows] = await conn.query<Row[]>(
            `SELECT ${RETENTION_POLICY_ACTIVATION_EVENT_COLUMNS}
               FROM retention_policy_activation_events
              WHERE tenant_id=? AND control_generation=? FOR SHARE`,
            [input.tenantId, current.controlGeneration],
          );
          const tail = tailRows[0] ? rowToRetentionPolicyActivationEvent(tailRows[0]) : undefined;
          if (
            tail
            && tail.policyVersion === input.policyVersion
            && tail.policySha256 === policy.policySha256
            && tail.afterSha256 === retentionPolicyControlSha256(current)
          ) {
            await conn.commit();
            return current;
          }
        }
        throw new RetentionPolicyGenerationConflictError(
          input.expectedControlGeneration,
          current.controlGeneration,
        );
      }
      if (
        current.activePolicyVersion === policy.policyVersion
        && current.activePolicySha256 === policy.policySha256
      ) {
        await conn.commit();
        return current;
      }
      if (current.controlGeneration + 1 >= Number.MAX_SAFE_INTEGER) {
        throw new Error("retention policy control generation is exhausted");
      }
      const effectiveAtMs = Math.max(input.atMs, current.updatedAtMs);
      const next: RetentionPolicyControlRecord = {
        tenantId: input.tenantId,
        controlGeneration: current.controlGeneration + 1,
        activePolicyVersion: policy.policyVersion,
        activePolicySha256: policy.policySha256,
        effectiveAtMs,
        updatedAtMs: effectiveAtMs,
      };
      validateRetentionPolicyControlRecord(next);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE retention_policy_controls
            SET control_generation=?, active_policy_version=?, active_policy_sha256=?,
                effective_at_ms=?, updated_at_ms=?
          WHERE tenant_id=? AND control_generation=?`,
        [
          next.controlGeneration,
          next.activePolicyVersion,
          next.activePolicySha256,
          next.effectiveAtMs,
          next.updatedAtMs,
          input.tenantId,
          current.controlGeneration,
        ],
      );
      if (updated.affectedRows !== 1) {
        throw new RetentionPolicyGenerationConflictError(
          input.expectedControlGeneration,
          current.controlGeneration,
        );
      }
      await conn.query(
        `INSERT INTO retention_policy_activation_events
           (tenant_id, control_generation, policy_version, policy_sha256, effective_at_ms,
            actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          input.tenantId,
          next.controlGeneration,
          policy.policyVersion,
          policy.policySha256,
          effectiveAtMs,
          input.actorKeyId,
          retentionPolicyControlSha256(current),
          retentionPolicyControlSha256(next),
          effectiveAtMs,
        ],
      );
      await conn.commit();
      return next;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getRetentionPolicy(
    tenantId: string,
    policyVersion: string,
  ): Promise<RetentionPolicyVersionRecord | null> {
    validateRetentionPolicyIdentity(tenantId, policyVersion);
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${RETENTION_POLICY_VERSION_COLUMNS}
         FROM retention_policy_versions WHERE tenant_id=? AND policy_version=?`,
      [tenantId, policyVersion],
    );
    return rows[0] ? rowToRetentionPolicyVersion(rows[0]) : null;
  }

  private async loadValidatedActiveRetentionPolicy(
    conn: PoolConnection,
    tenantId: string,
    lockClause = "",
  ): Promise<ActiveRetentionPolicy | null> {
    const [controlRows] = await conn.query<Row[]>(
      `SELECT ${RETENTION_POLICY_CONTROL_COLUMNS}
         FROM retention_policy_controls WHERE tenant_id=? ${lockClause}`,
      [tenantId],
    );
    if (!controlRows[0]) {
      const [orphanRows] = await conn.query<Row[]>(
        `SELECT event_id FROM retention_policy_activation_events
          WHERE tenant_id=? LIMIT 1 ${lockClause}`,
        [tenantId],
      );
      if (orphanRows[0]) {
        throw new Error("retention policy activation audit exists without its control row");
      }
      return null;
    }
    const control = rowToRetentionPolicyControl(controlRows[0]);
    const [eventRows] = await conn.query<Row[]>(
      `SELECT ${RETENTION_POLICY_ACTIVATION_EVENT_COLUMNS}
         FROM retention_policy_activation_events
        WHERE tenant_id=? ORDER BY control_generation, event_id ${lockClause}`,
      [tenantId],
    );
    const events = eventRows.map(rowToRetentionPolicyActivationEvent);
    let projected: RetentionPolicyControlRecord = {
      tenantId,
      controlGeneration: 0,
      updatedAtMs: 0,
    };
    let active: RetentionPolicyVersionRecord | null = null;
    let previousEventId = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const policy = await this.loadRetentionPolicyVersion(
        conn,
        tenantId,
        event.policyVersion,
        lockClause,
      );
      if (
        event.eventId <= previousEventId
        || event.controlGeneration !== index + 1
        || event.effectiveAtMs !== event.emittedAtMs
        || event.emittedAtMs < projected.updatedAtMs
        || event.beforeSha256 !== retentionPolicyControlSha256(projected)
        || !policy
        || policy.policySha256 !== event.policySha256
      ) throw new Error("retention policy activation audit is invalid");
      previousEventId = event.eventId;
      projected = {
        tenantId,
        controlGeneration: event.controlGeneration,
        activePolicyVersion: event.policyVersion,
        activePolicySha256: event.policySha256,
        effectiveAtMs: event.effectiveAtMs,
        updatedAtMs: event.emittedAtMs,
      };
      if (event.afterSha256 !== retentionPolicyControlSha256(projected)) {
        throw new Error("retention policy activation audit outcome is invalid");
      }
      active = policy;
    }
    if (
      events.length !== control.controlGeneration
      || retentionPolicyControlSha256(projected) !== retentionPolicyControlSha256(control)
    ) throw new Error("retention policy control and activation audit do not agree");
    if (control.controlGeneration === 0) return null;
    if (!active || active.policySha256 !== control.activePolicySha256) {
      throw new Error("active retention policy control does not match its immutable version");
    }
    return { control, policy: active };
  }

  async getActiveRetentionPolicy(tenantId: string): Promise<ActiveRetentionPolicy | null> {
    validateRetentionPolicyTenantId(tenantId);
    return this.withConsistentRead((conn) => this.loadValidatedActiveRetentionPolicy(conn, tenantId));
  }

  async listRetentionPolicyActivationEvents(
    tenantId: string,
  ): Promise<RetentionPolicyActivationEvent[]> {
    validateRetentionPolicyTenantId(tenantId);
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT ${RETENTION_POLICY_ACTIVATION_EVENT_COLUMNS}
           FROM retention_policy_activation_events
          WHERE tenant_id=? ORDER BY control_generation, event_id`,
        [tenantId],
      );
      const events = rows.map(rowToRetentionPolicyActivationEvent);
      let previousEventId = 0;
      let previousEmittedAtMs = 0;
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        if (
          event.eventId <= previousEventId
          || event.controlGeneration !== index + 1
          || event.effectiveAtMs !== event.emittedAtMs
          || event.emittedAtMs < previousEmittedAtMs
        ) {
          throw new Error("retention policy activation audit has a generation gap");
        }
        previousEventId = event.eventId;
        previousEmittedAtMs = event.emittedAtMs;
        const expectedBeforeSha256 = index === 0
          ? retentionPolicyControlSha256({ tenantId, controlGeneration: 0, updatedAtMs: 0 })
          : events[index - 1]!.afterSha256;
        if (expectedBeforeSha256 !== event.beforeSha256) {
          throw new Error("retention policy activation audit chain is invalid");
        }
        const policy = await this.loadRetentionPolicyVersion(
          conn,
          tenantId,
          event.policyVersion,
        );
        if (!policy || policy.policySha256 !== event.policySha256) {
          throw new Error("retention policy activation audit references an invalid version");
        }
        const projected: RetentionPolicyControlRecord = {
          tenantId,
          controlGeneration: event.controlGeneration,
          activePolicyVersion: event.policyVersion,
          activePolicySha256: event.policySha256,
          effectiveAtMs: event.effectiveAtMs,
          updatedAtMs: event.emittedAtMs,
        };
        if (event.afterSha256 !== retentionPolicyControlSha256(projected)) {
          throw new Error("retention policy activation audit projection is invalid");
        }
      }
      const [controlRows] = await conn.query<Row[]>(
        `SELECT ${RETENTION_POLICY_CONTROL_COLUMNS}
           FROM retention_policy_controls WHERE tenant_id=?`,
        [tenantId],
      );
      if (controlRows[0]) {
        const control = rowToRetentionPolicyControl(controlRows[0]);
        const expectedTailSha256 = events.length === 0
          ? retentionPolicyControlSha256({ tenantId, controlGeneration: 0, updatedAtMs: 0 })
          : events[events.length - 1]!.afterSha256;
        if (
          control.controlGeneration !== events.length
          || expectedTailSha256 !== retentionPolicyControlSha256(control)
        ) throw new Error("retention policy control and activation audit do not agree");
      } else if (events.length > 0) {
        throw new Error("retention policy activation audit has no control row");
      }
      return events;
    });
  }

  private async lockRetentionPolicyForErasureRequest(
    conn: PoolConnection,
    tenantId: string,
  ): Promise<RetentionPolicyVersionRecord | null> {
    const active = await this.loadValidatedActiveRetentionPolicy(conn, tenantId, "FOR SHARE");
    if (!active) return null;
    return active.policy;
  }

  private async ensureLegalHoldSubjectRows(
    conn: PoolConnection,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
    atMs: number,
  ): Promise<void> {
    if (subjectKind === "user") {
      await this.ensureSubjectLifecycleRows(conn, tenantId, subjectId, atMs);
      return;
    }
    const [existing] = await conn.query<Row[]>(
      `SELECT subject_id FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=?`,
      [tenantId, tenantId],
    );
    if (!existing[0]) {
      const [requests] = await conn.query<Row[]>(
        `SELECT request_id FROM erasure_requests
          WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? LIMIT 1`,
        [tenantId, tenantId],
      );
      if (requests.length > 0) {
        throw new LegalHoldIntegrityError(
          "tenant lifecycle gate is missing for an existing erasure request",
        );
      }
      await conn.query(
        `INSERT IGNORE INTO subject_lifecycle
           (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
            legal_hold_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'tenant', ?, 'active', 0, NULL, NULL, ?, ?)`,
        [tenantId, tenantId, atMs, atMs],
      );
    }
  }

  private async ensureLegalHoldControlForLifecycle(
    conn: PoolConnection,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<void> {
    // Never adopt a legacy shadow without provenance. The 0015 migration is the only component
    // allowed to convert such a timestamp into a canonical hold/event ledger.
    await conn.query(
      `INSERT IGNORE INTO legal_hold_controls
         (tenant_id, subject_kind, subject_id, control_generation, active_hold_count,
          active_projection_sha256, updated_at_ms)
       SELECT tenant_id, subject_kind, subject_id, 0, 0, ?, 0
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind=? AND subject_id=? AND legal_hold_at_ms IS NULL`,
      [EMPTY_LEGAL_HOLD_PROJECTION_SHA256, tenantId, subjectKind, subjectId],
    );
  }

  private validateLegalHoldLifecycle(
    lifecycle: SubjectLifecycleRecord,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): void {
    if (
      lifecycle.tenantId !== tenantId
      || lifecycle.subjectKind !== subjectKind
      || lifecycle.subjectId !== subjectId
      || (lifecycle.legalHoldAtMs !== undefined
        && (!Number.isSafeInteger(lifecycle.legalHoldAtMs) || lifecycle.legalHoldAtMs < 0))
    ) throw new LegalHoldIntegrityError("legal hold lifecycle owner or timestamp is invalid");
  }

  private async loadLegalHoldContextForLifecycle(
    conn: PoolConnection,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
    lifecycle: SubjectLifecycleRecord | undefined,
    lockClause = "",
  ): Promise<LegalHoldContext> {
    const [controlRows] = await conn.query<Row[]>(
      `SELECT ${LEGAL_HOLD_CONTROL_COLUMNS}
         FROM legal_hold_controls
        WHERE tenant_id=? AND subject_kind=? AND subject_id=? ${lockClause}`,
      [tenantId, subjectKind, subjectId],
    );
    const [holdRows] = await conn.query<Row[]>(
      `SELECT ${LEGAL_HOLD_COLUMNS}
         FROM legal_holds
        WHERE tenant_id=? AND subject_kind=? AND subject_id=?
        ORDER BY hold_id ${lockClause}`,
      [tenantId, subjectKind, subjectId],
    );
    const [eventRows] = await conn.query<Row[]>(
      `SELECT ${LEGAL_HOLD_EVENT_COLUMNS}
         FROM legal_hold_events
        WHERE tenant_id=? AND subject_kind=? AND subject_id=?
        ORDER BY control_generation, event_id ${lockClause}`,
      [tenantId, subjectKind, subjectId],
    );
    let control: LegalHoldControlRecord | undefined;
    let holds: LegalHoldRecord[];
    let events: LegalHoldEvent[];
    try {
      control = controlRows[0] ? rowToLegalHoldControl(controlRows[0]) : undefined;
      holds = holdRows.map(rowToLegalHold)
        .sort((left, right) => compareLegalHoldIds(left.holdId, right.holdId));
      events = eventRows.map(rowToLegalHoldEvent);
    } catch (error) {
      if (error instanceof LegalHoldIntegrityError) throw error;
      throw new LegalHoldIntegrityError(
        `stored legal hold row is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!lifecycle) {
      if (control || holds.length > 0 || events.length > 0) {
        throw new LegalHoldIntegrityError("legal hold ledger exists without a lifecycle subject");
      }
      const synthetic: LegalHoldControlRecord = {
        tenantId,
        subjectKind,
        subjectId,
        controlGeneration: 0,
        activeHoldCount: 0,
        activeProjectionSha256: EMPTY_LEGAL_HOLD_PROJECTION_SHA256,
        updatedAtMs: 0,
      };
      validateLegalHoldControlRecord(synthetic);
      return { control: synthetic, holds, events };
    }
    this.validateLegalHoldLifecycle(lifecycle, tenantId, subjectKind, subjectId);
    if (!control) {
      if (holds.length > 0 || events.length > 0 || lifecycle.legalHoldAtMs !== undefined) {
        throw new LegalHoldIntegrityError("legal hold lifecycle shadow has no canonical provenance");
      }
      const synthetic: LegalHoldControlRecord = {
        tenantId,
        subjectKind,
        subjectId,
        controlGeneration: 0,
        activeHoldCount: 0,
        activeProjectionSha256: EMPTY_LEGAL_HOLD_PROJECTION_SHA256,
        updatedAtMs: 0,
      };
      validateLegalHoldControlRecord(synthetic);
      return { lifecycle, control: synthetic, holds, events };
    }
    if (
      control.tenantId !== tenantId
      || control.subjectKind !== subjectKind
      || control.subjectId !== subjectId
    ) throw new LegalHoldIntegrityError("legal hold control owner is invalid");
    if (
      control.controlGeneration === 0
      && (
        control.updatedAtMs !== 0
        || control.activeProjectionSha256 !== EMPTY_LEGAL_HOLD_PROJECTION_SHA256
      )
    ) throw new LegalHoldIntegrityError("initial legal hold control is invalid");
    if (holds.some((hold) => (
      hold.tenantId !== tenantId
      || hold.subjectKind !== subjectKind
      || hold.subjectId !== subjectId
    ))) throw new LegalHoldIntegrityError("legal hold owner does not match its control");

    const activeHolds = holds.filter((hold) => hold.state === "active");
    if (
      control.activeHoldCount !== activeHolds.length
      || control.activeProjectionSha256 !== legalHoldProjectionSha256(activeHolds)
    ) throw new LegalHoldIntegrityError("legal hold control and active projection do not agree");
    const expectedShadow = activeHolds.length === 0
      ? undefined
      : Math.min(...activeHolds.map((hold) => hold.createdAtMs));
    if (lifecycle.legalHoldAtMs !== expectedShadow) {
      throw new LegalHoldIntegrityError("legal hold lifecycle shadow does not match active holds");
    }
    if (events.length !== control.controlGeneration) {
      throw new LegalHoldIntegrityError("legal hold event ledger has a generation gap");
    }

    const byId = new Map(holds.map((hold) => [hold.holdId, hold]));
    const seenSet = new Set<string>();
    const seenRelease = new Set<string>();
    const simulatedActive = new Map<string, LegalHoldRecord>();
    let simulated: LegalHoldControlRecord = {
      tenantId,
      subjectKind,
      subjectId,
      controlGeneration: 0,
      activeHoldCount: 0,
      activeProjectionSha256: EMPTY_LEGAL_HOLD_PROJECTION_SHA256,
      updatedAtMs: 0,
    };
    let previousEventId = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const hold = byId.get(event.holdId);
      if (
        event.tenantId !== tenantId
        || event.subjectKind !== subjectKind
        || event.subjectId !== subjectId
        || event.eventId <= previousEventId
        || event.controlGeneration !== index + 1
        || !hold
        || event.beforeSha256 !== legalHoldControlSha256(simulated)
        || event.emittedAtMs < simulated.updatedAtMs
      ) throw new LegalHoldIntegrityError("legal hold event chain is invalid");
      previousEventId = event.eventId;
      if (event.eventType === "legal_hold/set") {
        if (
          seenSet.has(hold.holdId)
          || hold.createdControlGeneration !== event.controlGeneration
          || hold.reasonCode !== event.reasonCode
          || hold.externalReferenceSha256 !== event.externalReferenceSha256
          || hold.createdByKeyId !== event.actorKeyId
          || event.emittedAtMs !== hold.createdAtMs
        ) throw new LegalHoldIntegrityError("legal hold set evidence is invalid");
        seenSet.add(hold.holdId);
        simulatedActive.set(hold.holdId, {
          tenantId: hold.tenantId,
          holdId: hold.holdId,
          subjectKind: hold.subjectKind,
          subjectId: hold.subjectId,
          state: "active",
          reasonCode: hold.reasonCode,
          ...(hold.externalReferenceSha256 === undefined
            ? {}
            : { externalReferenceSha256: hold.externalReferenceSha256 }),
          createdControlGeneration: hold.createdControlGeneration,
          createdByKeyId: hold.createdByKeyId,
          createdAtMs: hold.createdAtMs,
        });
      } else {
        if (
          !seenSet.has(hold.holdId)
          || seenRelease.has(hold.holdId)
          || hold.state !== "released"
          || hold.releasedControlGeneration !== event.controlGeneration
          || hold.releaseReasonCode !== event.reasonCode
          || event.externalReferenceSha256 !== undefined
          || hold.releasedByKeyId !== event.actorKeyId
          || hold.releasedAtMs === undefined
          || event.emittedAtMs !== hold.releasedAtMs
        ) throw new LegalHoldIntegrityError("legal hold release evidence is invalid");
        seenRelease.add(hold.holdId);
        simulatedActive.delete(hold.holdId);
      }
      const projectedHolds = [...simulatedActive.values()];
      const next: LegalHoldControlRecord = {
        tenantId,
        subjectKind,
        subjectId,
        controlGeneration: event.controlGeneration,
        activeHoldCount: projectedHolds.length,
        activeProjectionSha256: legalHoldProjectionSha256(projectedHolds),
        updatedAtMs: event.emittedAtMs,
      };
      if (event.afterSha256 !== legalHoldControlSha256(next)) {
        throw new LegalHoldIntegrityError("legal hold event projection hash is invalid");
      }
      simulated = next;
    }
    if (
      holds.some((hold) => (
        !seenSet.has(hold.holdId)
        || (hold.state === "released" && !seenRelease.has(hold.holdId))
        || (hold.state === "active" && seenRelease.has(hold.holdId))
      ))
      || legalHoldControlSha256(simulated) !== legalHoldControlSha256(control)
    ) throw new LegalHoldIntegrityError("legal hold ledger and control tail do not agree");
    return { lifecycle, control, holds, events };
  }

  private async lockLegalHoldContext(
    conn: PoolConnection,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldContext> {
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
      [tenantId, tenantId],
    );
    let lifecycleRow = tenantRows[0];
    if (subjectKind === "user") {
      const [userRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR UPDATE`,
        [tenantId, subjectId],
      );
      lifecycleRow = userRows[0];
    }
    if (!lifecycleRow) {
      throw new LegalHoldIntegrityError("legal hold lifecycle subject is missing after initialization");
    }
    const lifecycle = rowToSubjectLifecycle(lifecycleRow);
    await this.ensureLegalHoldControlForLifecycle(conn, tenantId, subjectKind, subjectId);
    return this.loadLegalHoldContextForLifecycle(
      conn,
      tenantId,
      subjectKind,
      subjectId,
      lifecycle,
      "FOR UPDATE",
    );
  }

  private async readLegalHoldContext(
    conn: PoolConnection,
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldContext> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
      [tenantId, subjectKind, subjectId],
    );
    const lifecycle = rows[0] ? rowToSubjectLifecycle(rows[0]) : undefined;
    return this.loadLegalHoldContextForLifecycle(
      conn,
      tenantId,
      subjectKind,
      subjectId,
      lifecycle,
    );
  }

  async setLegalHold(input: SetLegalHoldInput): Promise<LegalHoldRecord> {
    input = structuredClone(input);
    validateSetLegalHoldInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.ensureLegalHoldSubjectRows(
        conn,
        input.tenantId,
        input.subjectKind,
        input.subjectId,
        input.atMs,
      );
      const context = await this.lockLegalHoldContext(
        conn,
        input.tenantId,
        input.subjectKind,
        input.subjectId,
      );
      const [existingRows] = await conn.query<Row[]>(
        `SELECT ${LEGAL_HOLD_COLUMNS}
           FROM legal_holds WHERE tenant_id=? AND hold_id=? FOR UPDATE`,
        [input.tenantId, input.holdId],
      );
      if (existingRows[0]) {
        const existing = rowToLegalHold(existingRows[0]);
        if (
          existing.state === "active"
          &&
          existing.subjectKind === input.subjectKind
          && existing.subjectId === input.subjectId
          && existing.reasonCode === input.reasonCode
          && existing.externalReferenceSha256 === input.externalReferenceSha256
          && existing.createdControlGeneration - 1 === input.expectedControlGeneration
        ) {
          await conn.commit();
          return existing;
        }
        throw new LegalHoldConflictError(input.holdId);
      }
      if (input.expectedControlGeneration !== context.control.controlGeneration) {
        throw new LegalHoldGenerationConflictError(
          input.expectedControlGeneration,
          context.control.controlGeneration,
        );
      }
      if (context.control.controlGeneration + 1 >= Number.MAX_SAFE_INTEGER) {
        throw new Error("legal hold control generation is exhausted");
      }
      const effectiveAtMs = Math.max(input.atMs, context.control.updatedAtMs);
      const record: LegalHoldRecord = {
        tenantId: input.tenantId,
        holdId: input.holdId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        state: "active",
        reasonCode: input.reasonCode,
        ...(input.externalReferenceSha256 === undefined
          ? {}
          : { externalReferenceSha256: input.externalReferenceSha256 }),
        createdControlGeneration: context.control.controlGeneration + 1,
        createdByKeyId: input.actorKeyId,
        createdAtMs: effectiveAtMs,
      };
      validateLegalHoldRecord(record);
      const active = [...context.holds.filter((hold) => hold.state === "active"), record];
      const next: LegalHoldControlRecord = {
        tenantId: input.tenantId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        controlGeneration: record.createdControlGeneration,
        activeHoldCount: active.length,
        activeProjectionSha256: legalHoldProjectionSha256(active),
        updatedAtMs: effectiveAtMs,
      };
      await conn.query(
        `INSERT INTO legal_holds
           (tenant_id, hold_id, subject_kind, subject_id, state, reason_code,
            external_reference_sha256, created_control_generation, created_by_key_id,
            created_at_ms, released_control_generation, released_by_key_id, released_at_ms,
            release_reason_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)`,
        [
          record.tenantId,
          record.holdId,
          record.subjectKind,
          record.subjectId,
          record.state,
          record.reasonCode,
          record.externalReferenceSha256 ?? null,
          record.createdControlGeneration,
          record.createdByKeyId,
          record.createdAtMs,
        ],
      );
      const [controlUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE legal_hold_controls
            SET control_generation=?, active_hold_count=?, active_projection_sha256=?,
                updated_at_ms=?
          WHERE tenant_id=? AND subject_kind=? AND subject_id=? AND control_generation=?`,
        [
          next.controlGeneration,
          next.activeHoldCount,
          next.activeProjectionSha256,
          next.updatedAtMs,
          input.tenantId,
          input.subjectKind,
          input.subjectId,
          context.control.controlGeneration,
        ],
      );
      if (controlUpdated.affectedRows !== 1) {
        throw new LegalHoldGenerationConflictError(
          input.expectedControlGeneration,
          context.control.controlGeneration,
        );
      }
      const shadow = Math.min(...active.map((hold) => hold.createdAtMs));
      const [lifecycleUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE subject_lifecycle
            SET legal_hold_at_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
        [shadow, effectiveAtMs, input.tenantId, input.subjectKind, input.subjectId],
      );
      if (lifecycleUpdated.affectedRows !== 1) {
        throw new LegalHoldIntegrityError("legal hold lifecycle subject disappeared while locked");
      }
      await conn.query(
        `INSERT INTO legal_hold_events
           (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type,
            reason_code, external_reference_sha256, actor_key_id, before_sha256,
            after_sha256, emitted_at_ms)
         VALUES (?,?,?,?,?,'legal_hold/set',?,?,?,?,?,?)`,
        [
          input.tenantId,
          input.subjectKind,
          input.subjectId,
          next.controlGeneration,
          input.holdId,
          input.reasonCode,
          input.externalReferenceSha256 ?? null,
          input.actorKeyId,
          legalHoldControlSha256(context.control),
          legalHoldControlSha256(next),
          effectiveAtMs,
        ],
      );
      await conn.commit();
      return record;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async releaseLegalHold(input: ReleaseLegalHoldInput): Promise<LegalHoldRecord> {
    input = structuredClone(input);
    validateReleaseLegalHoldInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // This snapshot lookup discovers the immutable scope. The canonical lifecycle rows are then
      // locked before the locking ledger read, preserving tenant -> user -> ledger order.
      const [candidateRows] = await conn.query<Row[]>(
        `SELECT ${LEGAL_HOLD_COLUMNS} FROM legal_holds WHERE tenant_id=? AND hold_id=?`,
        [input.tenantId, input.holdId],
      );
      if (!candidateRows[0]) throw new LegalHoldNotFoundError(input.holdId);
      const candidate = rowToLegalHold(candidateRows[0]);
      const context = await this.lockLegalHoldContext(
        conn,
        input.tenantId,
        candidate.subjectKind,
        candidate.subjectId,
      );
      const existing = context.holds.find((hold) => hold.holdId === input.holdId);
      if (!existing) throw new LegalHoldIntegrityError("legal hold disappeared from its owner ledger");
      if (existing.state === "released") {
        if (
          existing.releaseReasonCode === input.reasonCode
          && existing.releasedControlGeneration! - 1 === input.expectedControlGeneration
        ) {
          await conn.commit();
          return existing;
        }
        throw new LegalHoldConflictError(input.holdId);
      }
      if (input.expectedControlGeneration !== context.control.controlGeneration) {
        throw new LegalHoldGenerationConflictError(
          input.expectedControlGeneration,
          context.control.controlGeneration,
        );
      }
      if (context.control.controlGeneration + 1 >= Number.MAX_SAFE_INTEGER) {
        throw new Error("legal hold control generation is exhausted");
      }
      const effectiveAtMs = Math.max(input.atMs, context.control.updatedAtMs);
      const released: LegalHoldRecord = {
        ...existing,
        state: "released",
        releasedControlGeneration: context.control.controlGeneration + 1,
        releasedByKeyId: input.actorKeyId,
        releasedAtMs: effectiveAtMs,
        releaseReasonCode: input.reasonCode,
      };
      validateLegalHoldRecord(released);
      const remaining = context.holds.filter(
        (hold) => hold.state === "active" && hold.holdId !== existing.holdId,
      );
      const next: LegalHoldControlRecord = {
        tenantId: existing.tenantId,
        subjectKind: existing.subjectKind,
        subjectId: existing.subjectId,
        controlGeneration: released.releasedControlGeneration!,
        activeHoldCount: remaining.length,
        activeProjectionSha256: legalHoldProjectionSha256(remaining),
        updatedAtMs: effectiveAtMs,
      };
      const [holdUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE legal_holds
            SET state='released', released_control_generation=?, released_by_key_id=?,
                released_at_ms=?, release_reason_code=?
          WHERE tenant_id=? AND hold_id=? AND subject_kind=? AND subject_id=? AND state='active'`,
        [
          released.releasedControlGeneration,
          released.releasedByKeyId,
          released.releasedAtMs,
          released.releaseReasonCode,
          input.tenantId,
          input.holdId,
          existing.subjectKind,
          existing.subjectId,
        ],
      );
      if (holdUpdated.affectedRows !== 1) throw new LegalHoldConflictError(input.holdId);
      const [controlUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE legal_hold_controls
            SET control_generation=?, active_hold_count=?, active_projection_sha256=?,
                updated_at_ms=?
          WHERE tenant_id=? AND subject_kind=? AND subject_id=? AND control_generation=?`,
        [
          next.controlGeneration,
          next.activeHoldCount,
          next.activeProjectionSha256,
          next.updatedAtMs,
          next.tenantId,
          next.subjectKind,
          next.subjectId,
          context.control.controlGeneration,
        ],
      );
      if (controlUpdated.affectedRows !== 1) {
        throw new LegalHoldGenerationConflictError(
          input.expectedControlGeneration,
          context.control.controlGeneration,
        );
      }
      const shadow = remaining.length === 0
        ? null
        : Math.min(...remaining.map((hold) => hold.createdAtMs));
      const [lifecycleUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE subject_lifecycle
            SET legal_hold_at_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
        [shadow, effectiveAtMs, next.tenantId, next.subjectKind, next.subjectId],
      );
      if (lifecycleUpdated.affectedRows !== 1) {
        throw new LegalHoldIntegrityError("legal hold lifecycle subject disappeared while locked");
      }
      await conn.query(
        `INSERT INTO legal_hold_events
           (tenant_id, subject_kind, subject_id, control_generation, hold_id, event_type,
            reason_code, external_reference_sha256, actor_key_id, before_sha256,
            after_sha256, emitted_at_ms)
         VALUES (?,?,?,?,?,'legal_hold/released',?,?,?,?,?,?)`,
        [
          next.tenantId,
          next.subjectKind,
          next.subjectId,
          next.controlGeneration,
          existing.holdId,
          input.reasonCode,
          null,
          input.actorKeyId,
          legalHoldControlSha256(context.control),
          legalHoldControlSha256(next),
          effectiveAtMs,
        ],
      );
      await conn.commit();
      return released;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getLegalHold(tenantId: string, holdId: string): Promise<LegalHoldRecord | null> {
    validateReleaseLegalHoldInput({
      tenantId,
      holdId,
      expectedControlGeneration: 0,
      reasonCode: "matter_closed",
      actorKeyId: "read",
      atMs: 0,
    });
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT ${LEGAL_HOLD_COLUMNS} FROM legal_holds WHERE tenant_id=? AND hold_id=?`,
        [tenantId, holdId],
      );
      if (!rows[0]) return null;
      const hold = rowToLegalHold(rows[0]);
      const context = await this.readLegalHoldContext(
        conn,
        tenantId,
        hold.subjectKind,
        hold.subjectId,
      );
      const validated = context.holds.find((candidate) => candidate.holdId === holdId);
      if (!validated) throw new LegalHoldIntegrityError("legal hold is missing from its owner ledger");
      return validated;
    });
  }

  async getActiveLegalHoldState(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<{ control: LegalHoldControlRecord; holds: LegalHoldRecord[] }> {
    return this.withConsistentRead(async (conn) => {
      const context = await this.readLegalHoldContext(conn, tenantId, subjectKind, subjectId);
      return {
        control: context.control,
        holds: context.holds.filter((hold) => hold.state === "active"),
      };
    });
  }

  async getLegalHoldControl(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldControlRecord> {
    const state = await this.getActiveLegalHoldState(tenantId, subjectKind, subjectId);
    return state.control;
  }

  async listActiveLegalHolds(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldRecord[]> {
    const state = await this.getActiveLegalHoldState(tenantId, subjectKind, subjectId);
    return state.holds;
  }

  async listLegalHoldEvents(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldEvent[]> {
    return this.withConsistentRead(async (conn) => {
      const context = await this.readLegalHoldContext(conn, tenantId, subjectKind, subjectId);
      return context.events;
    });
  }

  private async assertMysqlErasurePolicyDecisionChain(
    conn: PoolConnection,
    requestId: string,
    lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
  ): Promise<ErasurePolicyEvaluationDecisionEvent[]> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_POLICY_DECISION_COLUMNS}
         FROM erasure_policy_evaluation_decisions
        WHERE request_id=? ORDER BY decision_seq ${lock}`,
      [requestId],
    );
    const decisions = rows.map(rowToErasurePolicyDecision);
    let beforeSha256 = createHash("sha256").update(json([
      "agent-service/erasure-policy-decision-root/v1",
      requestId,
    ])).digest("hex");
    let decidedAtMs = 0;
    for (const [index, decision] of decisions.entries()) {
      if (
        decision.requestId !== requestId
        || decision.decisionSeq !== index + 1
        || decision.beforeSha256 !== beforeSha256
        || decision.decidedAtMs < decidedAtMs
      ) throw new Error("erasure policy evaluation decision chain is corrupt");
      beforeSha256 = decision.afterSha256;
      decidedAtMs = decision.decidedAtMs;
    }
    return decisions;
  }

  private async lockErasurePolicyEvaluationContext(
    conn: PoolConnection,
    identity: Pick<ErasurePolicyEvaluationAuthorization,
      "requestId" | "tenantId" | "subjectKind" | "subjectId" | "subjectGeneration">,
    lock: "FOR SHARE" | "FOR UPDATE",
  ): Promise<{
    request: ErasureRequestRecord;
    subject: SubjectLifecycleRecord;
    job: ErasurePolicyEvaluationJob;
  } | null> {
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? ${lock}`,
      [identity.tenantId, identity.tenantId],
    );
    if (!tenantRows[0]) return null;
    const tenant = rowToSubjectLifecycle(tenantRows[0]);
    let subject = tenant;
    if (identity.subjectKind === "user") {
      if (tenant.state !== "active") return null;
      const [userRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? ${lock}`,
        [identity.tenantId, identity.subjectId],
      );
      if (!userRows[0]) return null;
      subject = rowToSubjectLifecycle(userRows[0]);
    }
    const [requestRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_REQUEST_COLUMNS}
         FROM erasure_requests
        WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
        ${lock}`,
      [
        identity.requestId,
        identity.tenantId,
        identity.subjectKind,
        identity.subjectId,
        identity.subjectGeneration,
      ],
    );
    if (!requestRows[0]) return null;
    const request = rowToErasureRequest(requestRows[0]);
    if (request.status !== "awaiting_purge_policy") {
      throw new Error("erasure request is not awaiting purge policy");
    }
    await this.assertLockedErasureJobIntegrity(conn, request, lock, subject);
    const [jobRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_POLICY_EVALUATION_JOB_COLUMNS}
         FROM erasure_policy_evaluation_jobs WHERE request_id=? ${lock}`,
      [identity.requestId],
    );
    if (!jobRows[0]) return null;
    const job = rowToErasurePolicyEvaluationJob(jobRows[0]);
    if (
      job.tenantId !== request.tenantId
      || job.subjectKind !== request.subjectKind
      || job.subjectId !== request.subjectId
      || job.subjectGeneration !== request.generation
    ) throw new Error("erasure policy evaluation job binding is invalid");
    return { request, subject, job };
  }

  private mysqlErasurePolicyEvaluationAuthorizationMatches(
    job: ErasurePolicyEvaluationJob,
    authorization: ErasurePolicyEvaluationAuthorization,
    nowMs: number,
  ): boolean {
    return job.requestId === authorization.requestId
      && job.tenantId === authorization.tenantId
      && job.subjectKind === authorization.subjectKind
      && job.subjectId === authorization.subjectId
      && job.subjectGeneration === authorization.subjectGeneration
      && job.buildGeneration === authorization.buildGeneration
      && job.attempts === authorization.claimAttempt
      && job.claimToken === authorization.claimToken
      && job.leaseUntilMs !== undefined
      && job.leaseUntilMs > nowMs
      && job.sealedAtMs === undefined;
  }

  private mysqlErasurePolicyEvaluationClaim(
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
      claimToken: job.claimToken,
      claimAttempt: job.attempts,
      availableAtMs: job.availableAtMs,
      leaseUntilMs: job.leaseUntilMs,
    };
  }

  private async mysqlErasurePurgeTarget(
    conn: PoolConnection,
    request: ErasureRequestRecord,
    job: ErasurePolicyEvaluationJob,
    policy: RetentionPolicyVersionRecord,
    sessionRow: Row,
  ): Promise<ErasurePurgeTargetEvidence> {
    const issues = new Set<ErasurePurgeTargetIssueCode>();
    let deletedAtMs = 0;
    let deletionGeneration = 1;
    let marker: { deletedAtMs: number; lastSeq: number; generation: number } | undefined;
    try {
      marker = this.erasureTombstoneMarker(
        sessionRow.deleted_at_ms,
        sessionRow.purge_after_ms,
        sessionRow.last_seq,
        sessionRow.deletion_generation,
      );
      deletedAtMs = marker.deletedAtMs;
      deletionGeneration = marker.generation;
    } catch {
      issues.add("tombstone_invalid");
    }
    if (marker) {
      const proof = await this.loadErasureTombstoneProofRows(
        conn,
        String(sessionRow.session_id),
        marker.lastSeq,
        marker.generation,
      );
      try {
        this.assertErasureTombstoneProofRows(
          String(sessionRow.session_id),
          request.subjectId,
          marker,
          proof.eventRows,
          proof.outboxRows,
        );
      } catch {
        issues.add("tombstone_invalid");
      }
    }

    const contentDeadline = checkedRetentionDeadline(
      deletedAtMs,
      policy.policy.sessionContentRetentionMs,
    );
    if (contentDeadline.kind === "unconfigured") issues.add("policy_unconfigured");
    if (contentDeadline.kind === "invalid") issues.add("deadline_overflow");

    const [blobRows] = await conn.query<Row[]>(
      `SELECT ${BLOB_COLUMNS}
         FROM blob_objects WHERE session_id=? ORDER BY blob_id FOR SHARE`,
      [sessionRow.session_id],
    );
    const sessionBlobs = blobRows.map(rowToBlobManifest);
    if (sessionBlobs.some((blob) => (
      blob.tenantId !== request.tenantId
      || blob.userId !== request.subjectId
      || (blob.state !== "ready" && blob.state !== "deleted")
      || (blob.state === "ready" && !isValidReadyPurgeBlobManifest(blob))
    ))) issues.add("blob_invalid");
    const readyBlobs = sessionBlobs.filter((blob) => (
      blob.tenantId === request.tenantId
      && blob.userId === request.subjectId
      && blob.state === "ready"
    ));
    const readyBlobRootSha256 = createHash("sha256").update(json([
      "agent-service/erasure-ready-blob-root/v1",
      ...readyBlobs.map((blob) => [
        blob.blobId,
        blob.deletionGeneration,
        blob.sha256 ?? null,
        blob.sizeBytes ?? null,
      ]),
    ])).digest("hex");

    const [reconciliationRows] = await conn.query<Row[]>(
      `SELECT ${USAGE_RECONCILIATION_COLUMNS}
         FROM usage_reconciliations
        WHERE session_id=? AND deletion_generation=? FOR SHARE`,
      [sessionRow.session_id, deletionGeneration],
    );
    let reconciliation: UsageReconciliationRecord | undefined;
    let reconciliationValid = false;
    try {
      reconciliation = reconciliationRows[0]
        ? rowToUsageReconciliation(reconciliationRows[0])
        : undefined;
      reconciliationValid = !!reconciliation
        && reconciliation.tenantId === request.tenantId
        && reconciliation.userId === request.subjectId
        && reconciliation.sessionId === sessionRow.session_id
        && reconciliation.deletionGeneration === deletionGeneration
        && reconciliation.verifiedAtMs >= deletedAtMs;
      if (reconciliationValid && reconciliation?.status === "verified") {
        const input: ReconcileSessionUsageInput = {
          tenantId: request.tenantId,
          userId: request.subjectId,
          sessionId: String(sessionRow.session_id),
          deletionGeneration,
          nowMs: reconciliation.verifiedAtMs,
        };
        const { expected, actual } = await this.materializeBillingUsageFacts(conn, input, "verify");
        reconciliationValid = usageReconciliationSummariesEqual(
          summarizeBillingUsageFacts(expected),
          summarizeBillingUsageFacts(actual),
        ) && usageReconciliationSummariesEqual(
          reconciliation,
          summarizeBillingUsageFacts(expected),
        );
      } else if (reconciliationValid && reconciliation?.status === "anonymized") {
        const [remainingRows] = await conn.query<Row[]>(
          "SELECT id FROM usage_ledger WHERE session_id=? LIMIT 1 FOR SHARE",
          [sessionRow.session_id],
        );
        reconciliationValid = remainingRows.length === 0
          && reconciliation.anonymizedAtMs !== undefined
          && reconciliation.anonymizedAtMs >= reconciliation.verifiedAtMs;
      }
    } catch (error) {
      if (error instanceof UsageReconciliationError || error instanceof UsageIdentityConflictError) {
        reconciliationValid = false;
      } else {
        throw error;
      }
    }
    if (!reconciliationValid) issues.add("usage_reconciliation_invalid");
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

    const [receiptRows] = await conn.query<Row[]>(
      `SELECT tenant_id, user_id, expires_at_ms FROM idempotency_keys
        WHERE session_id=? ORDER BY tenant_id, user_id, idem_key FOR SHARE`,
      [sessionRow.session_id],
    );
    const ownedReceiptRows = receiptRows.filter((receipt) => (
      receipt.tenant_id === request.tenantId && receipt.user_id === request.subjectId
    ));
    if (ownedReceiptRows.length !== receiptRows.length) issues.add("receipt_invalid");
    const receiptExpiries: number[] = [];
    for (const receipt of ownedReceiptRows) {
      try {
        receiptExpiries.push(mysqlSafeInteger(receipt.expires_at_ms, "stored receipt expiry"));
      } catch {
        issues.add("receipt_invalid");
      }
    }
    const receiptFloor = checkedRetentionDeadline(
      deletedAtMs,
      policy.policy.idempotencyReceiptRetentionMs,
    );
    if (receiptFloor.kind === "unconfigured") issues.add("policy_unconfigured");
    if (receiptFloor.kind === "invalid") issues.add("deadline_overflow");
    const idempotencyReceiptDeadlineMs = ownedReceiptRows.length > 0
      && receiptExpiries.length === ownedReceiptRows.length
      && receiptFloor.kind === "deadline"
      ? Math.max(receiptFloor.value, ...receiptExpiries)
      : undefined;
    const withoutHash: Omit<ErasurePurgeTargetEvidence, "evidenceSha256"> = {
      requestId: request.requestId,
      buildGeneration: job.buildGeneration,
      tenantId: request.tenantId,
      userId: request.subjectId,
      sessionId: String(sessionRow.session_id),
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
      idempotencyReceiptCount: ownedReceiptRows.length,
      ...(idempotencyReceiptDeadlineMs === undefined ? {} : { idempotencyReceiptDeadlineMs }),
      exportArtifactDisposition: "not_applicable",
      billingFactDisposition: "retained",
      lifecycleAuditDisposition: "retained",
      issueCodes: [...issues].sort(),
    };
    return {
      ...withoutHash,
      evidenceSha256: erasurePurgeTargetEvidenceSha256(withoutHash),
    };
  }

  private async mysqlErasurePurgeInventoryMatches(
    conn: PoolConnection,
    request: ErasureRequestRecord,
    job: ErasurePolicyEvaluationJob,
    policy: RetentionPolicyVersionRecord,
    lock: "FOR SHARE" | "FOR UPDATE",
  ): Promise<boolean> {
    const [targetRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
        WHERE request_id=? AND build_generation=? ORDER BY session_id ${lock}`,
      [request.requestId, job.buildGeneration],
    );
    const storedTargets = targetRows.map(rowToErasurePurgeTarget);
    const [sessionRows] = await conn.query<Row[]>(
      `SELECT session_id, tenant_id, user_id, last_seq, deleted_at_ms, purge_after_ms,
              deletion_generation
         FROM sessions FORCE INDEX (idx_sessions_tenant_user)
        WHERE tenant_id=? AND user_id=? ORDER BY session_id ${lock}`,
      [request.tenantId, request.subjectId],
    );
    let liveRoot = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
    const liveTargets: ErasurePurgeTargetEvidence[] = [];
    for (const sessionRow of sessionRows) {
      const target = await this.mysqlErasurePurgeTarget(conn, request, job, policy, sessionRow);
      liveTargets.push(target);
      liveRoot = nextErasurePurgeTargetRootSha256(liveRoot, target.evidenceSha256);
    }
    return liveTargets.length === job.targetCount
      && storedTargets.length === job.targetCount
      && liveRoot === job.targetRootSha256
      && liveTargets.every((target, index) => (
        target.evidenceSha256 === storedTargets[index]?.evidenceSha256
      ));
  }

  async scheduleAwaitingErasurePolicyEvaluations(
    options: ScheduleAwaitingErasurePolicyEvaluationsOptions,
  ): Promise<number> {
    validateScheduleAwaitingErasurePolicyEvaluationsOptions(options);
    const [candidateRows] = await this.pool.query<Row[]>(
      `SELECT r.request_id, r.tenant_id, r.subject_kind, r.subject_id, r.generation
         FROM erasure_requests r
         LEFT JOIN erasure_policy_evaluation_jobs j ON j.request_id=r.request_id
         LEFT JOIN erasure_policy_evaluation_decisions d
           ON d.request_id=r.request_id
          AND d.decision_seq=(
            SELECT MAX(d2.decision_seq) FROM erasure_policy_evaluation_decisions d2
             WHERE d2.request_id=r.request_id
          )
        WHERE r.status='awaiting_purge_policy'
          AND (
            j.request_id IS NULL
            OR (
              j.sealed_at_ms IS NOT NULL
              AND d.decision IN ('invalid','held','waiting','eligible_execution_disabled')
            )
          )
        ORDER BY r.request_id`,
    );
    let scheduled = 0;
    let firstError: unknown;
    for (const candidate of candidateRows) {
      if (scheduled >= options.limit) break;
      let conn: PoolConnection | undefined;
      try {
        const identity = {
          requestId: String(candidate.request_id),
          tenantId: String(candidate.tenant_id),
          subjectKind: String(candidate.subject_kind) as DataSubjectKind,
          subjectId: String(candidate.subject_id),
          subjectGeneration: mysqlSafeInteger(candidate.generation, "evaluation candidate generation"),
        };
        conn = await this.pool.getConnection();
        await conn.beginTransaction();
        const [tenantRows] = await conn.query<Row[]>(
          `SELECT ${SUBJECT_LIFECYCLE_COLUMNS} FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [identity.tenantId, identity.tenantId],
        );
        const tenant = tenantRows[0] ? rowToSubjectLifecycle(tenantRows[0]) : undefined;
        if (!tenant || tenant.state !== "active" || identity.subjectKind !== "user") {
          await conn.commit();
          continue;
        }
        const [userRows] = await conn.query<Row[]>(
          `SELECT ${SUBJECT_LIFECYCLE_COLUMNS} FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR UPDATE`,
          [identity.tenantId, identity.subjectId],
        );
        const user = userRows[0] ? rowToSubjectLifecycle(userRows[0]) : undefined;
        if (!user) {
          await conn.commit();
          continue;
        }
        const [requestRows] = await conn.query<Row[]>(
          `SELECT ${ERASURE_REQUEST_COLUMNS} FROM erasure_requests
            WHERE request_id=? AND tenant_id=? AND subject_kind='user' AND subject_id=?
              AND generation=? FOR UPDATE`,
          [identity.requestId, identity.tenantId, identity.subjectId, identity.subjectGeneration],
        );
        if (!requestRows[0]) {
          await conn.commit();
          continue;
        }
        const request = rowToErasureRequest(requestRows[0]);
        if (request.status !== "awaiting_purge_policy") {
          await conn.commit();
          continue;
        }
        await this.assertLockedErasureJobIntegrity(conn, request, "FOR UPDATE", user);
        const [jobRows] = await conn.query<Row[]>(
          `SELECT ${ERASURE_POLICY_EVALUATION_JOB_COLUMNS}
             FROM erasure_policy_evaluation_jobs WHERE request_id=? FOR UPDATE`,
          [identity.requestId],
        );
        if (!jobRows[0]) {
          const atMs = Math.max(options.nowMs, request.updatedAtMs);
          await conn.query(
            `INSERT INTO erasure_policy_evaluation_jobs
               (request_id, tenant_id, subject_kind, subject_id, subject_generation,
                build_generation, cursor_session_id, target_count, target_root_sha256,
                available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
                sealed_at_ms, created_at_ms, updated_at_ms)
             VALUES (?,?,?,?,?,1,NULL,0,?, ?,0,NULL,NULL,NULL,NULL,?,?)`,
            [
              request.requestId,
              request.tenantId,
              request.subjectKind,
              request.subjectId,
              request.generation,
              EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
              atMs,
              atMs,
              atMs,
            ],
          );
          await conn.commit();
          scheduled += 1;
          continue;
        }
        const job = rowToErasurePolicyEvaluationJob(jobRows[0]);
        if (job.sealedAtMs === undefined) {
          await conn.commit();
          continue;
        }
        const decisions = await this.assertMysqlErasurePolicyDecisionChain(
          conn,
          request.requestId,
          "FOR UPDATE",
        );
        const last = decisions.at(-1);
        if (!last || last.buildGeneration !== job.buildGeneration) {
          throw new Error("sealed evaluation job has no matching decision");
        }
        if (last.decision === "unbound" || last.decision === "unconfigured") {
          await conn.commit();
          continue;
        }
        const [controlRows] = await conn.query<Row[]>(
          `SELECT request_id, authority_generation, active_authority_sha256, updated_at_ms
             FROM erasure_purge_authority_controls WHERE request_id=? FOR UPDATE`,
          [request.requestId],
        );
        if (!controlRows[0]) throw new Error("sealed evaluation authority control is missing");
        const control = rowToErasurePurgeAuthorityControl(controlRows[0]);
        const tenantHold = await this.loadLegalHoldContextForLifecycle(
          conn,
          request.tenantId,
          "tenant",
          request.tenantId,
          tenant,
          "FOR UPDATE",
        );
        const userHold = await this.loadLegalHoldContextForLifecycle(
          conn,
          request.tenantId,
          "user",
          request.subjectId,
          user,
          "FOR UPDATE",
        );
        const holdChanged = tenantHold.control.controlGeneration !== last.tenantHoldControlGeneration
          || tenantHold.control.activeProjectionSha256 !== last.tenantHoldProjectionSha256
          || userHold.control.controlGeneration !== last.userHoldControlGeneration
          || userHold.control.activeProjectionSha256 !== last.userHoldProjectionSha256;
        const deadlineReached = last.decision === "waiting"
          && last.eligibilityDeadlineMs !== undefined
          && last.eligibilityDeadlineMs <= options.nowMs;
        let liveEvidenceChanged = false;
        if (request.policyVersion !== undefined && request.policyHash !== undefined) {
          const [policyRows] = await conn.query<Row[]>(
            `SELECT ${RETENTION_POLICY_VERSION_COLUMNS} FROM retention_policy_versions
              WHERE tenant_id=? AND policy_version=? FOR SHARE`,
            [request.tenantId, request.policyVersion],
          );
          let policy: RetentionPolicyVersionRecord | undefined;
          try {
            policy = policyRows[0] ? rowToRetentionPolicyVersion(policyRows[0]) : undefined;
          } catch {
            // Invalid/missing policy identity is terminal for this request. Only owner inventory
            // drift can recover an evaluation build without changing the immutable binding.
          }
          if (policy?.policySha256 === request.policyHash) {
            liveEvidenceChanged = !await this.mysqlErasurePurgeInventoryMatches(
              conn,
              request,
              job,
              policy,
              "FOR SHARE",
            );
          }
        }
        const shouldReevaluate = last.decision === "invalid"
          ? liveEvidenceChanged
          : holdChanged || deadlineReached || liveEvidenceChanged;
        if (!shouldReevaluate) {
          await conn.commit();
          continue;
        }
        if (job.buildGeneration >= Number.MAX_SAFE_INTEGER - 1) {
          throw new Error("erasure policy evaluation build generation exhausted");
        }
        const atMs = Math.max(
          options.nowMs,
          request.updatedAtMs,
          job.updatedAtMs,
          last.decidedAtMs,
          control.updatedAtMs,
        );
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE erasure_policy_evaluation_jobs
              SET build_generation=build_generation+1, cursor_session_id=NULL,
                  target_count=0, target_root_sha256=?, available_at_ms=?, attempts=0,
                  claim_token=NULL, lease_until_ms=NULL, last_error_code=NULL,
                  sealed_at_ms=NULL, updated_at_ms=?
            WHERE request_id=? AND build_generation=? AND sealed_at_ms=?`,
          [
            EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
            atMs,
            atMs,
            request.requestId,
            job.buildGeneration,
            job.sealedAtMs,
          ],
        );
        if (updated.affectedRows !== 1) throw new Error("evaluation job changed while rescheduling");
        if (control.activeAuthoritySha256 !== undefined) {
          const [controlUpdated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE erasure_purge_authority_controls
                SET active_authority_sha256=NULL, updated_at_ms=?
              WHERE request_id=? AND authority_generation=? AND active_authority_sha256=?`,
            [
              atMs,
              request.requestId,
              control.authorityGeneration,
              control.activeAuthoritySha256,
            ],
          );
          if (controlUpdated.affectedRows !== 1) {
            throw new Error("authority control changed while rescheduling");
          }
        }
        await conn.commit();
        scheduled += 1;
      } catch (error) {
        await conn?.rollback().catch(() => {});
        firstError ??= error;
      } finally {
        conn?.release();
      }
    }
    if (firstError !== undefined) throw firstError;
    return scheduled;
  }

  async claimErasurePolicyEvaluations(
    options: ClaimErasurePolicyEvaluationsOptions,
  ): Promise<ErasurePolicyEvaluationClaim[]> {
    const leaseUntilMs = validateClaimErasurePolicyEvaluationsOptions(options);
    const [candidateRows] = await this.pool.query<Row[]>(
      `SELECT ${ERASURE_POLICY_EVALUATION_JOB_COLUMNS}
         FROM erasure_policy_evaluation_jobs
        WHERE sealed_at_ms IS NULL AND available_at_ms IS NOT NULL AND available_at_ms<=?
          AND (claim_token IS NULL OR lease_until_ms<=?)
        ORDER BY available_at_ms, request_id`,
      [options.nowMs, options.nowMs],
    );
    const claims: ErasurePolicyEvaluationClaim[] = [];
    let firstError: unknown;
    for (const row of candidateRows) {
      if (claims.length >= options.limit) break;
      let conn: PoolConnection | undefined;
      try {
        const candidate = rowToErasurePolicyEvaluationJob(row);
        conn = await this.pool.getConnection();
        await conn.beginTransaction();
        const context = await this.lockErasurePolicyEvaluationContext(conn, candidate, "FOR UPDATE");
        if (!context) {
          await conn.commit();
          continue;
        }
        const current = context.job;
        if (
          current.sealedAtMs !== undefined
          || current.availableAtMs === undefined
          || current.availableAtMs > options.nowMs
          || (current.claimToken !== undefined && current.leaseUntilMs! > options.nowMs)
        ) {
          await conn.commit();
          continue;
        }
        if (current.attempts >= Number.MAX_SAFE_INTEGER - 1) {
          throw new Error("erasure policy evaluation claim generation exhausted");
        }
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE erasure_policy_evaluation_jobs
              SET attempts=attempts+1, claim_token=?, lease_until_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
            WHERE request_id=? AND build_generation=? AND attempts=? AND sealed_at_ms IS NULL
              AND available_at_ms IS NOT NULL AND available_at_ms<=?
              AND (claim_token IS NULL OR lease_until_ms<=?)`,
          [
            options.claimToken,
            leaseUntilMs,
            options.nowMs,
            current.requestId,
            current.buildGeneration,
            current.attempts,
            options.nowMs,
            options.nowMs,
          ],
        );
        if (updated.affectedRows !== 1) {
          await conn.commit();
          continue;
        }
        const claimed: ErasurePolicyEvaluationJob = {
          ...current,
          attempts: current.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
          updatedAtMs: Math.max(current.updatedAtMs, options.nowMs),
        };
        await conn.commit();
        claims.push(this.mysqlErasurePolicyEvaluationClaim(claimed));
      } catch (error) {
        await conn?.rollback().catch(() => {});
        firstError ??= error;
      } finally {
        conn?.release();
      }
    }
    if (claims.length === 0 && firstError !== undefined) throw firstError;
    return claims;
  }

  async renewErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RenewErasurePolicyEvaluationOptions,
  ): Promise<boolean> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    const leaseUntilMs = validateRenewErasurePolicyEvaluationOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasurePolicyEvaluationContext(conn, authorization, "FOR UPDATE");
      if (!context || !this.mysqlErasurePolicyEvaluationAuthorizationMatches(
        context.job,
        authorization,
        options.nowMs,
      )) {
        await conn.commit();
        return false;
      }
      const nextLease = Math.max(context.job.leaseUntilMs!, leaseUntilMs);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_policy_evaluation_jobs
            SET lease_until_ms=?, updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE request_id=? AND build_generation=? AND attempts=? AND claim_token=?
            AND lease_until_ms>? AND sealed_at_ms IS NULL`,
        [
          nextLease,
          options.nowMs,
          authorization.requestId,
          authorization.buildGeneration,
          authorization.claimAttempt,
          authorization.claimToken,
          options.nowMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("evaluation claim changed while renewing");
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RetryErasurePolicyEvaluationOptions,
  ): Promise<boolean> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    validateRetryErasurePolicyEvaluationOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasurePolicyEvaluationContext(conn, authorization, "FOR UPDATE");
      if (!context || !this.mysqlErasurePolicyEvaluationAuthorizationMatches(
        context.job,
        authorization,
        options.failedAtMs,
      )) {
        await conn.commit();
        return false;
      }
      if (
        options.errorCode === "evidence_changed"
        && context.job.buildGeneration >= Number.MAX_SAFE_INTEGER - 1
      ) throw new Error("erasure policy evaluation build generation exhausted");
      const evidenceChanged = options.errorCode === "evidence_changed";
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_policy_evaluation_jobs
            SET build_generation=build_generation+?, cursor_session_id=?, target_count=?,
                target_root_sha256=?, available_at_ms=?, attempts=?, claim_token=NULL,
                lease_until_ms=NULL, last_error_code=?, sealed_at_ms=NULL,
                updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE request_id=? AND build_generation=? AND attempts=? AND claim_token=?
            AND lease_until_ms>? AND sealed_at_ms IS NULL`,
        [
          evidenceChanged ? 1 : 0,
          evidenceChanged ? null : context.job.cursorSessionId ?? null,
          evidenceChanged ? 0 : context.job.targetCount,
          evidenceChanged ? EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256 : context.job.targetRootSha256,
          options.availableAtMs,
          evidenceChanged ? 0 : context.job.attempts,
          options.errorCode,
          options.failedAtMs,
          authorization.requestId,
          authorization.buildGeneration,
          authorization.claimAttempt,
          authorization.claimToken,
          options.failedAtMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("evaluation claim changed while retrying");
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async buildErasurePurgeTargetPage(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: BuildErasurePurgeTargetPageOptions,
  ): Promise<BuildErasurePurgeTargetPageResult> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    validateBuildErasurePurgeTargetPageOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasurePolicyEvaluationContext(conn, authorization, "FOR UPDATE");
      if (!context || !this.mysqlErasurePolicyEvaluationAuthorizationMatches(
        context.job,
        authorization,
        options.nowMs,
      )) throw new Error("stale erasure policy evaluation authority");
      const { request, job } = context;
      if (request.subjectKind !== "user") throw new Error("tenant purge evaluation is not implemented");
      let policy: RetentionPolicyVersionRecord | undefined;
      if (request.policyVersion !== undefined && request.policyHash !== undefined) {
        const [policyRows] = await conn.query<Row[]>(
          `SELECT ${RETENTION_POLICY_VERSION_COLUMNS} FROM retention_policy_versions
            WHERE tenant_id=? AND policy_version=? FOR SHARE`,
          [request.tenantId, request.policyVersion],
        );
        try {
          policy = policyRows[0] ? rowToRetentionPolicyVersion(policyRows[0]) : undefined;
          if (policy?.policySha256 !== request.policyHash) policy = undefined;
        } catch {
          policy = undefined;
        }
      }
      if (!policy) {
        await conn.commit();
        return {
          built: 0,
          done: true,
          ...(job.cursorSessionId === undefined ? {} : { cursorSessionId: job.cursorSessionId }),
          targetCount: job.targetCount,
          targetRootSha256: job.targetRootSha256,
        };
      }
      const [sessionRows] = await conn.query<Row[]>(
        `SELECT session_id, tenant_id, user_id, last_seq, deleted_at_ms, purge_after_ms,
                deletion_generation
           FROM sessions FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? AND (? IS NULL OR session_id>?)
          ORDER BY session_id LIMIT ? FOR SHARE`,
        [
          request.tenantId,
          request.subjectId,
          job.cursorSessionId ?? null,
          job.cursorSessionId ?? null,
          options.limit + 1,
        ],
      );
      const page = sessionRows.slice(0, options.limit);
      let root = job.targetRootSha256;
      let count = job.targetCount;
      for (const sessionRow of page) {
        const target = await this.mysqlErasurePurgeTarget(conn, request, job, policy, sessionRow);
        try {
          await conn.query(
            `INSERT INTO erasure_purge_targets
               (request_id, build_generation, tenant_id, user_id, session_id,
                deletion_generation, deleted_at_ms, session_content_deadline_ms,
                ready_blob_count, ready_blob_root_sha256, ready_blob_deadline_ms,
                operational_usage_status, operational_usage_verified_at_ms,
                operational_usage_checksum, operational_usage_deadline_ms,
                idempotency_receipt_count, idempotency_receipt_deadline_ms,
                export_artifact_disposition, billing_fact_disposition,
                lifecycle_audit_disposition, issue_codes, evidence_sha256)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              target.requestId,
              target.buildGeneration,
              target.tenantId,
              target.userId,
              target.sessionId,
              target.deletionGeneration,
              target.deletedAtMs,
              target.sessionContentDeadlineMs ?? null,
              target.readyBlobCount,
              target.readyBlobRootSha256,
              target.readyBlobDeadlineMs ?? null,
              target.operationalUsageStatus,
              target.operationalUsageVerifiedAtMs,
              target.operationalUsageChecksum,
              target.operationalUsageDeadlineMs ?? null,
              target.idempotencyReceiptCount,
              target.idempotencyReceiptDeadlineMs ?? null,
              target.exportArtifactDisposition,
              target.billingFactDisposition,
              target.lifecycleAuditDisposition,
              json(target.issueCodes),
              target.evidenceSha256,
            ],
          );
        } catch (error) {
          if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
          const [existingRows] = await conn.query<Row[]>(
            `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
              WHERE request_id=? AND build_generation=? AND session_id=? FOR SHARE`,
            [target.requestId, target.buildGeneration, target.sessionId],
          );
          const existing = existingRows[0] ? rowToErasurePurgeTarget(existingRows[0]) : undefined;
          if (!existing || existing.evidenceSha256 !== target.evidenceSha256) {
            throw new Error("erasure purge target evidence conflicts with an immutable row");
          }
          throw new Error("erasure policy evaluation cursor overlaps existing evidence");
        }
        root = nextErasurePurgeTargetRootSha256(root, target.evidenceSha256);
        count += 1;
      }
      const cursorSessionId = page.at(-1)?.session_id == null
        ? job.cursorSessionId
        : String(page.at(-1)!.session_id);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_policy_evaluation_jobs
            SET cursor_session_id=?, target_count=?, target_root_sha256=?,
                updated_at_ms=GREATEST(updated_at_ms, ?)
          WHERE request_id=? AND build_generation=? AND attempts=? AND claim_token=?
            AND lease_until_ms>? AND sealed_at_ms IS NULL`,
        [
          cursorSessionId ?? null,
          count,
          root,
          options.nowMs,
          request.requestId,
          job.buildGeneration,
          authorization.claimAttempt,
          authorization.claimToken,
          options.nowMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("evaluation job changed while building targets");
      await conn.commit();
      return {
        built: page.length,
        done: sessionRows.length <= options.limit,
        ...(cursorSessionId === undefined ? {} : { cursorSessionId }),
        targetCount: count,
        targetRootSha256: root,
      };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async sealErasurePurgeAuthority(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: SealErasurePurgeAuthorityOptions,
  ): Promise<ErasurePolicyEvaluationSealResult> {
    validateErasurePolicyEvaluationAuthorization(authorization);
    validateSealErasurePurgeAuthorityOptions(options);
    // Immutable history cannot change after this check; the transaction below re-locks the mutable
    // job/control tails and CASes both before it appends anything.
    await this.getValidatedErasurePurgeAuthority(authorization.requestId);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasurePolicyEvaluationContext(conn, authorization, "FOR UPDATE");
      if (!context || !this.mysqlErasurePolicyEvaluationAuthorizationMatches(
        context.job,
        authorization,
        options.nowMs,
      )) throw new Error("stale erasure policy evaluation authority");
      const { request, subject, job } = context;
      if (request.subjectKind !== "user") throw new Error("tenant purge evaluation is not implemented");

      const decisions = await this.assertMysqlErasurePolicyDecisionChain(
        conn,
        request.requestId,
        "FOR UPDATE",
      );
      await conn.query(
        `INSERT IGNORE INTO erasure_purge_authority_controls
           (request_id, authority_generation, active_authority_sha256, updated_at_ms)
         VALUES (?,0,NULL,0)`,
        [request.requestId],
      );
      const [controlRows] = await conn.query<Row[]>(
        `SELECT request_id, authority_generation, active_authority_sha256, updated_at_ms
           FROM erasure_purge_authority_controls WHERE request_id=? FOR UPDATE`,
        [request.requestId],
      );
      if (!controlRows[0]) throw new Error("erasure purge authority control is missing");
      const control = rowToErasurePurgeAuthorityControl(controlRows[0]);
      const [authorityRows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_PURGE_AUTHORITY_COLUMNS} FROM erasure_purge_authorities
          WHERE request_id=? ORDER BY authority_generation FOR SHARE`,
        [request.requestId],
      );
      const existingAuthorities = authorityRows.map(rowToErasurePurgeAuthority);
      const eligibleDecisions = decisions.filter((decision) => (
        decision.decision === "eligible_execution_disabled"
      ));
      if (
        existingAuthorities.length !== eligibleDecisions.length
        || existingAuthorities.length !== control.authorityGeneration
      ) throw new Error("erasure purge authority chain is corrupt");
      for (const [index, candidate] of existingAuthorities.entries()) {
        const linkedDecision = eligibleDecisions[index];
        if (
          candidate.authorityGeneration !== index + 1
          || candidate.tenantId !== request.tenantId
          || candidate.subjectKind !== request.subjectKind
          || candidate.subjectId !== request.subjectId
          || candidate.subjectGeneration !== request.generation
          || !linkedDecision
          || !erasurePurgeAuthorityMatchesDecision(candidate, linkedDecision)
          || (index > 0
            && candidate.buildGeneration <= existingAuthorities[index - 1]!.buildGeneration)
        ) throw new Error("erasure purge authority chain is corrupt");
        const [historicalTargetRows] = await conn.query<Row[]>(
          `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
            WHERE request_id=? AND build_generation=? ORDER BY session_id FOR SHARE`,
          [request.requestId, candidate.buildGeneration],
        );
        const historicalTargets = historicalTargetRows.map(rowToErasurePurgeTarget);
        let historicalRoot = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
        for (const target of historicalTargets) {
          if (
            target.requestId !== request.requestId
            || target.buildGeneration !== candidate.buildGeneration
            || target.tenantId !== request.tenantId
            || target.userId !== request.subjectId
          ) throw new Error("erasure purge authority target chain is corrupt");
          historicalRoot = nextErasurePurgeTargetRootSha256(
            historicalRoot,
            target.evidenceSha256,
          );
        }
        if (
          historicalTargets.length !== candidate.targetCount
          || historicalRoot !== candidate.targetRootSha256
        ) throw new Error("erasure purge authority target chain is corrupt");
      }
      const latestAuthority = existingAuthorities.at(-1);
      if (
        (control.authorityGeneration === 0 && control.activeAuthoritySha256 !== undefined)
        || (latestAuthority !== undefined && control.updatedAtMs < latestAuthority.createdAtMs)
        || (control.activeAuthoritySha256 !== undefined && (
          latestAuthority?.authoritySha256 !== control.activeAuthoritySha256
          || decisions.at(-1)?.afterSha256 !== latestAuthority?.decisionSha256
          || control.updatedAtMs !== latestAuthority.createdAtMs
        ))
      ) throw new Error("erasure purge authority control is corrupt");

      const tenantHold = await this.loadLegalHoldContextForLifecycle(
        conn,
        request.tenantId,
        "tenant",
        request.tenantId,
        rowToSubjectLifecycle((await conn.query<Row[]>(
          `SELECT ${SUBJECT_LIFECYCLE_COLUMNS} FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR UPDATE`,
          [request.tenantId, request.tenantId],
        ))[0][0]!),
        "FOR UPDATE",
      );
      const userHold = await this.loadLegalHoldContextForLifecycle(
        conn,
        request.tenantId,
        "user",
        request.subjectId,
        subject,
        "FOR UPDATE",
      );

      const [targetRows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
          WHERE request_id=? AND build_generation=? ORDER BY session_id FOR SHARE`,
        [request.requestId, job.buildGeneration],
      );
      const targets = targetRows.map(rowToErasurePurgeTarget);
      let policy: RetentionPolicyVersionRecord | undefined;
      let policyInvalid = false;
      if ((request.policyVersion === undefined) !== (request.policyHash === undefined)) {
        policyInvalid = true;
      } else if (request.policyVersion !== undefined && request.policyHash !== undefined) {
        const [policyRows] = await conn.query<Row[]>(
          `SELECT ${RETENTION_POLICY_VERSION_COLUMNS} FROM retention_policy_versions
            WHERE tenant_id=? AND policy_version=? FOR SHARE`,
          [request.tenantId, request.policyVersion],
        );
        try {
          policy = policyRows[0] ? rowToRetentionPolicyVersion(policyRows[0]) : undefined;
          if (!policy || policy.policySha256 !== request.policyHash) policyInvalid = true;
        } catch {
          policyInvalid = true;
          policy = undefined;
        }
      }

      if (policy) {
        if (!await this.mysqlErasurePurgeInventoryMatches(
          conn,
          request,
          job,
          policy,
          "FOR SHARE",
        )) throw new ErasurePurgeEvidenceChangedError();
      }

      let evaluationDecision: ErasurePolicyEvaluationDecision;
      let userGraceDeadlineMs: number | undefined;
      let eligibilityDeadlineMs: number | undefined;
      if (request.policyVersion === undefined && request.policyHash === undefined) {
        evaluationDecision = "unbound";
      } else if (policyInvalid || !policy) {
        evaluationDecision = "invalid";
      } else {
        const grace = checkedRetentionDeadline(request.gatedAtMs, policy.policy.userErasureGraceMs);
        const requiredPolicyUnconfigured = policy.policy.sessionContentRetentionMs === null
          || policy.policy.operationalUsageRetentionMs === null
          || policy.policy.idempotencyReceiptRetentionMs === null;
        const targetInvalid = targets.some((target) => target.issueCodes.some(
          (issue) => issue !== "policy_unconfigured",
        ));
        const targetUnconfigured = targets.some((target) => (
          target.issueCodes.includes("policy_unconfigured")
        ));
        if (grace.kind === "invalid" || targetInvalid) {
          evaluationDecision = "invalid";
        } else if (grace.kind === "unconfigured" || requiredPolicyUnconfigured || targetUnconfigured) {
          evaluationDecision = "unconfigured";
        } else {
          userGraceDeadlineMs = grace.value;
          eligibilityDeadlineMs = Math.max(
            grace.value,
            ...targets.flatMap((target) => [
              target.sessionContentDeadlineMs,
              target.readyBlobDeadlineMs,
              target.operationalUsageDeadlineMs,
              target.idempotencyReceiptDeadlineMs,
            ].filter((value): value is number => value !== undefined)),
          );
          evaluationDecision = tenantHold.control.activeHoldCount > 0
            || userHold.control.activeHoldCount > 0
            ? "held"
            : "waiting";
        }
      }

      const effectiveAtMs = Math.max(
        options.nowMs,
        request.updatedAtMs,
        job.updatedAtMs,
        tenantHold.control.updatedAtMs,
        userHold.control.updatedAtMs,
        policy?.createdAtMs ?? 0,
        decisions.at(-1)?.decidedAtMs ?? 0,
        control.updatedAtMs,
      );
      if (
        evaluationDecision === "waiting"
        && eligibilityDeadlineMs !== undefined
        && eligibilityDeadlineMs <= effectiveAtMs
      ) evaluationDecision = "eligible_execution_disabled";

      const beforeSha256 = decisions.at(-1)?.afterSha256 ?? createHash("sha256").update(json([
        "agent-service/erasure-policy-decision-root/v1",
        request.requestId,
      ])).digest("hex");
      const eventWithoutAfter: Omit<ErasurePolicyEvaluationDecisionEvent, "afterSha256"> = {
        requestId: request.requestId,
        decisionSeq: decisions.length + 1,
        buildGeneration: job.buildGeneration,
        decision: evaluationDecision,
        ...(policy === undefined ? {} : {
          policyVersion: policy.policyVersion,
          policySha256: policy.policySha256,
        }),
        ...(userGraceDeadlineMs === undefined ? {} : { userGraceDeadlineMs }),
        ...(eligibilityDeadlineMs === undefined ? {} : { eligibilityDeadlineMs }),
        targetCount: job.targetCount,
        targetRootSha256: job.targetRootSha256,
        tenantHoldControlGeneration: tenantHold.control.controlGeneration,
        tenantHoldProjectionSha256: tenantHold.control.activeProjectionSha256,
        userHoldControlGeneration: userHold.control.controlGeneration,
        userHoldProjectionSha256: userHold.control.activeProjectionSha256,
        beforeSha256,
        decidedAtMs: effectiveAtMs,
      };
      const decision: ErasurePolicyEvaluationDecisionEvent = {
        ...eventWithoutAfter,
        afterSha256: erasurePolicyDecisionSha256(eventWithoutAfter),
      };
      await conn.query(
        `INSERT INTO erasure_policy_evaluation_decisions
           (request_id, decision_seq, build_generation, decision, policy_version, policy_sha256,
            user_grace_deadline_ms, eligibility_deadline_ms, target_count, target_root_sha256,
            tenant_hold_control_generation, tenant_hold_projection_sha256,
            user_hold_control_generation, user_hold_projection_sha256,
            before_sha256, after_sha256, decided_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          decision.requestId,
          decision.decisionSeq,
          decision.buildGeneration,
          decision.decision,
          decision.policyVersion ?? null,
          decision.policySha256 ?? null,
          decision.userGraceDeadlineMs ?? null,
          decision.eligibilityDeadlineMs ?? null,
          decision.targetCount,
          decision.targetRootSha256,
          decision.tenantHoldControlGeneration,
          decision.tenantHoldProjectionSha256,
          decision.userHoldControlGeneration,
          decision.userHoldProjectionSha256,
          decision.beforeSha256,
          decision.afterSha256,
          decision.decidedAtMs,
        ],
      );

      let authority: ErasurePurgeAuthorityRecord | undefined;
      let nextControl = control;
      if (evaluationDecision === "eligible_execution_disabled") {
        if (!policy || userGraceDeadlineMs === undefined || eligibilityDeadlineMs === undefined) {
          throw new Error("eligible authority evidence is incomplete");
        }
        if (control.authorityGeneration >= Number.MAX_SAFE_INTEGER - 1) {
          throw new Error("erasure purge authority generation exhausted");
        }
        const authorityWithoutHash: Omit<ErasurePurgeAuthorityRecord, "authoritySha256"> = {
          requestId: request.requestId,
          authorityGeneration: control.authorityGeneration + 1,
          tenantId: request.tenantId,
          subjectKind: request.subjectKind,
          subjectId: request.subjectId,
          subjectGeneration: request.generation,
          buildGeneration: job.buildGeneration,
          policyVersion: policy.policyVersion,
          policySha256: policy.policySha256,
          policySchemaVersion: policy.schemaVersion,
          userGraceDeadlineMs,
          eligibilityDeadlineMs,
          targetCount: job.targetCount,
          targetRootSha256: job.targetRootSha256,
          tenantHoldControlGeneration: tenantHold.control.controlGeneration,
          tenantHoldProjectionSha256: tenantHold.control.activeProjectionSha256,
          userHoldControlGeneration: userHold.control.controlGeneration,
          userHoldProjectionSha256: userHold.control.activeProjectionSha256,
          decisionSha256: decision.afterSha256,
          createdAtMs: effectiveAtMs,
        };
        authority = {
          ...authorityWithoutHash,
          authoritySha256: erasurePurgeAuthoritySha256(authorityWithoutHash),
        };
        await conn.query(
          `INSERT INTO erasure_purge_authorities
             (request_id, authority_generation, tenant_id, subject_kind, subject_id,
              subject_generation, build_generation, policy_version, policy_sha256,
              policy_schema_version, user_grace_deadline_ms, eligibility_deadline_ms,
              target_count, target_root_sha256, tenant_hold_control_generation,
              tenant_hold_projection_sha256, user_hold_control_generation,
              user_hold_projection_sha256, decision_sha256, authority_sha256, created_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            authority.requestId,
            authority.authorityGeneration,
            authority.tenantId,
            authority.subjectKind,
            authority.subjectId,
            authority.subjectGeneration,
            authority.buildGeneration,
            authority.policyVersion,
            authority.policySha256,
            authority.policySchemaVersion,
            authority.userGraceDeadlineMs,
            authority.eligibilityDeadlineMs,
            authority.targetCount,
            authority.targetRootSha256,
            authority.tenantHoldControlGeneration,
            authority.tenantHoldProjectionSha256,
            authority.userHoldControlGeneration,
            authority.userHoldProjectionSha256,
            authority.decisionSha256,
            authority.authoritySha256,
            authority.createdAtMs,
          ],
        );
        const [controlUpdated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE erasure_purge_authority_controls
              SET authority_generation=?, active_authority_sha256=?, updated_at_ms=?
            WHERE request_id=? AND authority_generation=? AND active_authority_sha256 <=> ?`,
          [
            authority.authorityGeneration,
            authority.authoritySha256,
            effectiveAtMs,
            request.requestId,
            control.authorityGeneration,
            control.activeAuthoritySha256 ?? null,
          ],
        );
        if (controlUpdated.affectedRows !== 1) throw new Error("authority control changed while sealing");
        nextControl = {
          requestId: request.requestId,
          authorityGeneration: authority.authorityGeneration,
          activeAuthoritySha256: authority.authoritySha256,
          updatedAtMs: effectiveAtMs,
        };
      } else if (control.activeAuthoritySha256 !== undefined) {
        const [controlUpdated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE erasure_purge_authority_controls
              SET active_authority_sha256=NULL, updated_at_ms=?
            WHERE request_id=? AND authority_generation=? AND active_authority_sha256=?`,
          [
            effectiveAtMs,
            request.requestId,
            control.authorityGeneration,
            control.activeAuthoritySha256,
          ],
        );
        if (controlUpdated.affectedRows !== 1) throw new Error("authority control changed while sealing");
        nextControl = {
          requestId: request.requestId,
          authorityGeneration: control.authorityGeneration,
          updatedAtMs: effectiveAtMs,
        };
      }
      const [jobUpdated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_policy_evaluation_jobs
            SET available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                last_error_code=NULL, sealed_at_ms=?, updated_at_ms=?
          WHERE request_id=? AND build_generation=? AND attempts=? AND claim_token=?
            AND lease_until_ms>? AND sealed_at_ms IS NULL`,
        [
          effectiveAtMs,
          effectiveAtMs,
          request.requestId,
          job.buildGeneration,
          authorization.claimAttempt,
          authorization.claimToken,
          options.nowMs,
        ],
      );
      if (jobUpdated.affectedRows !== 1) throw new Error("evaluation job changed while sealing");
      await conn.commit();
      return { decision, ...(authority === undefined ? {} : { authority }), control: nextControl };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getErasurePolicyEvaluationJob(
    requestId: string,
  ): Promise<ErasurePolicyEvaluationJob | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${ERASURE_POLICY_EVALUATION_JOB_COLUMNS}
         FROM erasure_policy_evaluation_jobs WHERE request_id=?`,
      [requestId],
    );
    return rows[0] ? rowToErasurePolicyEvaluationJob(rows[0]) : null;
  }

  async listErasurePurgeTargetEvidence(
    requestId: string,
    buildGeneration: number,
  ): Promise<ErasurePurgeTargetEvidence[]> {
    if (!Number.isSafeInteger(buildGeneration) || buildGeneration <= 0) {
      throw new Error("invalid erasure purge target generation");
    }
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
        WHERE request_id=? AND build_generation=? ORDER BY session_id`,
      [requestId, buildGeneration],
    );
    return rows.map(rowToErasurePurgeTarget);
  }

  async listErasurePolicyEvaluationDecisions(
    requestId: string,
  ): Promise<ErasurePolicyEvaluationDecisionEvent[]> {
    return this.withConsistentRead((conn) => (
      this.assertMysqlErasurePolicyDecisionChain(conn, requestId)
    ));
  }

  async getValidatedErasurePurgeAuthority(
    requestId: string,
  ): Promise<ErasurePurgeAuthorityRecord | null> {
    // Resolve only a non-authoritative owner hint before the transaction. No authority/control
    // absence decision is made outside the consistent read: that would race the first seal.
    const [hintRequestRows] = await this.pool.query<Row[]>(
      `SELECT request_id, tenant_id, subject_kind, subject_id, generation
         FROM erasure_requests WHERE request_id=?`,
      [requestId],
    );
    if (!hintRequestRows[0]) {
      const [orphanRows] = await this.pool.query<Row[]>(
        `SELECT 1 AS present FROM erasure_purge_authorities WHERE request_id=? LIMIT 1`,
        [requestId],
      );
      if (orphanRows[0]) throw new Error("erasure purge authority request binding is corrupt");
      return null;
    }
    const hint = hintRequestRows[0]!;
    const identityHint = {
      requestId: String(hint.request_id),
      tenantId: String(hint.tenant_id),
      subjectKind: String(hint.subject_kind) as DataSubjectKind,
      subjectId: String(hint.subject_id),
      subjectGeneration: mysqlSafeInteger(hint.generation, "authority request hint generation"),
    };
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasurePolicyEvaluationContext(conn, identityHint, "FOR SHARE");
      if (!context) {
        throw new Error("erasure purge authority request binding is corrupt");
      }
      const [controlRows] = await conn.query<Row[]>(
        `SELECT request_id, authority_generation, active_authority_sha256, updated_at_ms
           FROM erasure_purge_authority_controls WHERE request_id=? FOR SHARE`,
        [requestId],
      );
      const [authorityRows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_PURGE_AUTHORITY_COLUMNS} FROM erasure_purge_authorities
          WHERE request_id=? ORDER BY authority_generation FOR SHARE`,
        [requestId],
      );
      const authorities = authorityRows.map(rowToErasurePurgeAuthority);
      const { request, subject, job } = context;
      const decisions = await this.assertMysqlErasurePolicyDecisionChain(conn, requestId, "FOR SHARE");
      const eligibleDecisions = decisions.filter((decision) => (
        decision.decision === "eligible_execution_disabled"
      ));
      if (!controlRows[0]) {
        if (authorities.length > 0 || eligibleDecisions.length > 0) {
          throw new Error("erasure purge authority control is corrupt");
        }
        await conn.commit();
        return null;
      }
      const control = rowToErasurePurgeAuthorityControl(controlRows[0]);
      if (control.authorityGeneration === 0) {
        if (authorities.length > 0 || eligibleDecisions.length > 0) {
          throw new Error("erasure purge authority chain is corrupt");
        }
        await conn.commit();
        return null;
      }
      const [tenantRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS} FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
        [request.tenantId, request.tenantId],
      );
      if (!tenantRows[0]) throw new Error("erasure purge authority tenant lifecycle is missing");
      const tenantHold = await this.loadLegalHoldContextForLifecycle(
        conn,
        request.tenantId,
        "tenant",
        request.tenantId,
        rowToSubjectLifecycle(tenantRows[0]),
        "FOR SHARE",
      );
      const userHold = await this.loadLegalHoldContextForLifecycle(
        conn,
        request.tenantId,
        "user",
        request.subjectId,
        subject,
        "FOR SHARE",
      );
      if (request.policyVersion === undefined || request.policyHash === undefined) {
        throw new Error("erasure purge authority policy binding is corrupt");
      }
      const [canonicalPolicyRows] = await conn.query<Row[]>(
        `SELECT ${RETENTION_POLICY_VERSION_COLUMNS} FROM retention_policy_versions
          WHERE tenant_id=? AND policy_version=? FOR SHARE`,
        [request.tenantId, request.policyVersion],
      );
      let canonicalPolicy: RetentionPolicyVersionRecord | undefined;
      try {
        canonicalPolicy = canonicalPolicyRows[0]
          ? rowToRetentionPolicyVersion(canonicalPolicyRows[0])
          : undefined;
      } catch {
        canonicalPolicy = undefined;
      }
      if (!canonicalPolicy || canonicalPolicy.policySha256 !== request.policyHash) {
        throw new Error("erasure purge authority policy binding is corrupt");
      }
      if (
        authorities.length !== eligibleDecisions.length
        || authorities.length !== control.authorityGeneration
      ) throw new Error("erasure purge authority chain is corrupt");
      for (const [index, candidate] of authorities.entries()) {
        const linkedDecision = eligibleDecisions[index];
        if (
          candidate.authorityGeneration !== index + 1
          || candidate.tenantId !== request.tenantId
          || candidate.subjectKind !== request.subjectKind
          || candidate.subjectId !== request.subjectId
          || candidate.subjectGeneration !== request.generation
          || candidate.policyVersion !== request.policyVersion
          || candidate.policySha256 !== request.policyHash
          || candidate.policySchemaVersion !== canonicalPolicy.schemaVersion
          || !linkedDecision
          || !erasurePurgeAuthorityMatchesDecision(candidate, linkedDecision)
          || (index > 0 && candidate.buildGeneration <= authorities[index - 1]!.buildGeneration)
        ) throw new Error("erasure purge authority chain is corrupt");
        const [historicalTargetRows] = await conn.query<Row[]>(
          `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
            WHERE request_id=? AND build_generation=? ORDER BY session_id FOR SHARE`,
          [request.requestId, candidate.buildGeneration],
        );
        const historicalTargets = historicalTargetRows.map(rowToErasurePurgeTarget);
        let historicalRoot = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
        for (const target of historicalTargets) {
          if (
            target.requestId !== request.requestId
            || target.buildGeneration !== candidate.buildGeneration
            || target.tenantId !== request.tenantId
            || target.userId !== request.subjectId
          ) throw new Error("erasure purge authority target chain is corrupt");
          historicalRoot = nextErasurePurgeTargetRootSha256(
            historicalRoot,
            target.evidenceSha256,
          );
        }
        if (
          historicalTargets.length !== candidate.targetCount
          || historicalRoot !== candidate.targetRootSha256
        ) throw new Error("erasure purge authority target chain is corrupt");
        const historicalGrace = checkedRetentionDeadline(
          request.gatedAtMs,
          canonicalPolicy.policy.userErasureGraceMs,
        );
        const historicalPolicyConfigured = canonicalPolicy.policy.sessionContentRetentionMs !== null
          && canonicalPolicy.policy.operationalUsageRetentionMs !== null
          && canonicalPolicy.policy.idempotencyReceiptRetentionMs !== null;
        const historicalEligibilityDeadlineMs = historicalGrace.kind === "deadline"
          && historicalPolicyConfigured
          && historicalTargets.every((target) => (
            erasurePurgeTargetMatchesRetentionPolicy(target, canonicalPolicy.policy)
          ))
          ? Math.max(
            historicalGrace.value,
            ...historicalTargets.flatMap((target) => [
              target.sessionContentDeadlineMs,
              target.readyBlobDeadlineMs,
              target.operationalUsageDeadlineMs,
              target.idempotencyReceiptDeadlineMs,
            ].filter((value): value is number => value !== undefined)),
          )
          : undefined;
        if (
          historicalGrace.kind !== "deadline"
          || historicalEligibilityDeadlineMs === undefined
          || candidate.userGraceDeadlineMs !== historicalGrace.value
          || candidate.eligibilityDeadlineMs !== historicalEligibilityDeadlineMs
          || candidate.createdAtMs < request.gatedAtMs
          || candidate.createdAtMs < request.updatedAtMs
          || candidate.createdAtMs < canonicalPolicy.createdAtMs
          || candidate.createdAtMs < historicalEligibilityDeadlineMs
        ) throw new Error("erasure purge authority deadline chain is corrupt");
        const historicalTenantHold = legalHoldControlAtGeneration(
          request.tenantId,
          "tenant",
          request.tenantId,
          tenantHold.holds,
          tenantHold.events,
          candidate.tenantHoldControlGeneration,
        );
        const historicalUserHold = legalHoldControlAtGeneration(
          request.tenantId,
          "user",
          request.subjectId,
          userHold.holds,
          userHold.events,
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
        !authority
        || control.updatedAtMs < authority.createdAtMs
        || (control.activeAuthoritySha256 !== undefined && (
          authority.authoritySha256 !== control.activeAuthoritySha256
          || decisions.at(-1)?.afterSha256 !== authority.decisionSha256
          || control.updatedAtMs !== authority.createdAtMs
        ))
      ) throw new Error("erasure purge authority control is corrupt");
      // A scheduler/retry generation bump intentionally supersedes (but never rewrites) the prior
      // authority while the next immutable build is in progress.
      if (authority.buildGeneration !== job.buildGeneration) {
        if (authority.buildGeneration < job.buildGeneration) {
          await conn.commit();
          return null;
        }
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
        || authority.targetCount !== job.targetCount
        || authority.targetRootSha256 !== job.targetRootSha256
      ) throw new Error("erasure purge authority request evidence is corrupt");

      if (
        tenantHold.control.controlGeneration !== authority.tenantHoldControlGeneration
        || tenantHold.control.activeProjectionSha256 !== authority.tenantHoldProjectionSha256
        || userHold.control.controlGeneration !== authority.userHoldControlGeneration
        || userHold.control.activeProjectionSha256 !== authority.userHoldProjectionSha256
        || tenantHold.control.activeHoldCount > 0
        || userHold.control.activeHoldCount > 0
      ) {
        await conn.commit();
        return null;
      }

      const policy = canonicalPolicy;
      const [targetRows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_PURGE_TARGET_COLUMNS} FROM erasure_purge_targets
          WHERE request_id=? AND build_generation=? ORDER BY session_id FOR SHARE`,
        [request.requestId, authority.buildGeneration],
      );
      const targets = targetRows.map(rowToErasurePurgeTarget);
      const [sessionRows] = await conn.query<Row[]>(
        `SELECT session_id, tenant_id, user_id, last_seq, deleted_at_ms, purge_after_ms,
                deletion_generation
           FROM sessions FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? ORDER BY session_id FOR SHARE`,
        [request.tenantId, request.subjectId],
      );
      let liveRoot = EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256;
      const liveTargets: ErasurePurgeTargetEvidence[] = [];
      for (const sessionRow of sessionRows) {
        const target = await this.mysqlErasurePurgeTarget(conn, request, job, policy, sessionRow);
        liveTargets.push(target);
        liveRoot = nextErasurePurgeTargetRootSha256(liveRoot, target.evidenceSha256);
      }
      if (
        liveTargets.length !== authority.targetCount
        || targets.length !== authority.targetCount
        || liveRoot !== authority.targetRootSha256
        || liveTargets.some((target, index) => target.evidenceSha256 !== targets[index]?.evidenceSha256)
      ) {
        await conn.commit();
        return null;
      }
      const grace = checkedRetentionDeadline(
        request.gatedAtMs,
        policy.policy.userErasureGraceMs,
      );
      const destructivePolicyConfigured = policy.policy.sessionContentRetentionMs !== null
        && policy.policy.operationalUsageRetentionMs !== null
        && policy.policy.idempotencyReceiptRetentionMs !== null;
      const targetsEligible = targets.every((target) => (
        erasurePurgeTargetMatchesRetentionPolicy(target, policy.policy)
      ));
      const eligibilityDeadlineMs = grace.kind === "deadline" && destructivePolicyConfigured
        && targetsEligible
        ? Math.max(
          grace.value,
          ...targets.flatMap((target) => [
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
        || authority.userGraceDeadlineMs !== grace.value
        || authority.eligibilityDeadlineMs !== eligibilityDeadlineMs
        || authority.createdAtMs < eligibilityDeadlineMs
      ) throw new Error("erasure purge authority deadline evidence is corrupt");
      await conn.commit();
      return authority;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getErasureCompletionReadiness(requestId: string): Promise<ErasureCompletionReadiness> {
    const authority = await this.getValidatedErasurePurgeAuthority(requestId);
    return {
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
    };
  }

  // ---------- durable subject lifecycle ----------
  private async ensureSubjectLifecycleRows(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    atMs: number,
  ): Promise<void> {
    // Most transactions hit rows created by migration/session creation. The optimistic read avoids
    // taking an unnecessary exclusive duplicate-key lock on the tenant row for every turn while a
    // mixed-version writer can still be healed safely: a final locking read below always sees the
    // winner's current state before any business write is allowed.
    const [existing] = await conn.query<Row[]>(
      `SELECT subject_kind, subject_id
         FROM subject_lifecycle
        WHERE tenant_id=?
          AND ((subject_kind='tenant' AND subject_id=?)
            OR (subject_kind='user' AND subject_id=?))`,
      [tenantId, tenantId, userId],
    );
    const hasTenant = existing.some((row) => row.subject_kind === "tenant" && row.subject_id === tenantId);
    const hasUser = existing.some((row) => row.subject_kind === "user" && row.subject_id === userId);
    if (!hasTenant) {
      const [requests] = await conn.query<Row[]>(
        `SELECT request_id FROM erasure_requests
          WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? LIMIT 1`,
        [tenantId, tenantId],
      );
      if (requests.length > 0) {
        throw new Error("tenant lifecycle gate is missing for an existing erasure request");
      }
      await conn.query(
        `INSERT IGNORE INTO subject_lifecycle
           (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
            legal_hold_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'tenant', ?, 'active', 0, NULL, NULL, ?, ?)`,
        [tenantId, tenantId, atMs, atMs],
      );
    }
    if (!hasUser) {
      const [requests] = await conn.query<Row[]>(
        `SELECT request_id FROM erasure_requests
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? LIMIT 1`,
        [tenantId, userId],
      );
      if (requests.length > 0) {
        throw new Error("user lifecycle gate is missing for an existing erasure request");
      }
      await conn.query(
        `INSERT IGNORE INTO subject_lifecycle
           (tenant_id, subject_kind, subject_id, state, generation, active_request_id,
            legal_hold_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, 'user', ?, 'active', 0, NULL, NULL, ?, ?)`,
        [tenantId, userId, atMs, atMs],
      );
    }
  }

  private async lockActiveSubjectGate(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    atMs: number,
    blockedSessionId?: string,
  ): Promise<void> {
    await this.ensureSubjectLifecycleRows(conn, tenantId, userId, atMs);
    // Every path takes the coarse tenant row before the user row. User erasure takes the same order
    // with an exclusive user lock, so create/commit/gate have one unambiguous linearization point.
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
      [tenantId, tenantId],
    );
    const [userRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR SHARE`,
      [tenantId, userId],
    );
    const tenant = tenantRows[0] ? rowToSubjectLifecycle(tenantRows[0]) : undefined;
    const user = userRows[0] ? rowToSubjectLifecycle(userRows[0]) : undefined;
    if (!tenant || !user) throw new Error("subject lifecycle gate row is missing");
    if (tenant.state !== "active" || user.state !== "active") {
      if (blockedSessionId) throw new SessionGoneError(blockedSessionId);
      throw new SubjectDeletingError(tenantId, user.state === "active" ? undefined : userId);
    }
  }

  async requestUserErasure(input: RequestUserErasureInput): Promise<ErasureRequestRecord> {
    input = structuredClone(input);
    validateRequestUserErasureInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.ensureSubjectLifecycleRows(conn, input.tenantId, input.userId, input.atMs);
      const [tenantRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
        [input.tenantId, input.tenantId],
      );
      const [userRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR UPDATE`,
        [input.tenantId, input.userId],
      );
      const tenant = tenantRows[0] ? rowToSubjectLifecycle(tenantRows[0]) : undefined;
      const user = userRows[0] ? rowToSubjectLifecycle(userRows[0]) : undefined;
      if (!tenant || !user) throw new Error("subject lifecycle gate row is missing");
      if (tenant.state !== "active") throw new SubjectDeletingError(input.tenantId);

      const [idempotencyRows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_REQUEST_COLUMNS}
           FROM erasure_requests
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? AND idempotency_key=?
          FOR UPDATE`,
        [input.tenantId, input.userId, input.idempotencyKey],
      );
      if (idempotencyRows[0]) {
        const replay = rowToErasureRequest(idempotencyRows[0]);
        if (replay.requestHash !== input.requestHash) throw new ErasureIdempotencyMismatchError();
        await conn.commit();
        return replay;
      }

      if (user.state !== "active") {
        if (!user.activeRequestId) throw new SubjectDeletingError(input.tenantId, input.userId);
        const [activeRows] = await conn.query<Row[]>(
          // ensureSubjectLifecycleRows performs an optimistic consistent read before this lock
          // chain. Use a locking current read here: after waiting for a competing gate, the RR
          // snapshot may predate the winner's request even though the user row already exposes it.
          `SELECT ${ERASURE_REQUEST_COLUMNS}
             FROM erasure_requests WHERE request_id=? FOR SHARE`,
          [user.activeRequestId],
        );
        const active = activeRows[0] ? rowToErasureRequest(activeRows[0]) : undefined;
        if (
          !active
          || active.tenantId !== input.tenantId
          || active.subjectKind !== "user"
          || active.subjectId !== input.userId
          || active.generation !== user.generation
        ) throw new Error("subject lifecycle active request is corrupt");
        await conn.commit();
        return active;
      }

      // The shared control/version locks make request creation linearizable with activation. Any
      // active policy observed here is bound; runner wall clocks are audit data, not a scheduler.
      const boundPolicy = await this.lockRetentionPolicyForErasureRequest(
        conn,
        input.tenantId,
      );
      const generation = user.generation + 1;
      const record: ErasureRequestRecord = {
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
        ...(boundPolicy === null
          ? {}
          : {
              policyVersion: boundPolicy.policyVersion,
              policyHash: boundPolicy.policySha256,
            }),
        controlGeneration: 0,
      };
      await conn.query(
        `INSERT INTO erasure_requests
           (request_id, tenant_id, subject_kind, subject_id, generation, status,
            requested_by_key_id, idempotency_key, request_hash, created_at_ms, gated_at_ms,
            updated_at_ms, completed_at_ms, counts_json, checksum, available_at_ms, attempts,
            claim_token, lease_until_ms, last_error_code, policy_version, policy_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,0,NULL,NULL,NULL,?,?)`,
        [
          record.requestId,
          record.tenantId,
          record.subjectKind,
          record.subjectId,
          record.generation,
          record.status,
          record.requestedByKeyId,
          record.idempotencyKey,
          record.requestHash,
          record.createdAtMs,
          record.gatedAtMs,
          record.updatedAtMs,
          record.availableAtMs,
          record.policyVersion ?? null,
          record.policyHash ?? null,
        ],
      );
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE subject_lifecycle
            SET state='deleting', generation=?, active_request_id=?, updated_at_ms=?
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=?
            AND state='active' AND generation=?`,
        [
          generation,
          input.requestId,
          Math.max(user.updatedAtMs, input.atMs),
          input.tenantId,
          input.userId,
          user.generation,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("subject lifecycle gate changed while locked");
      await conn.query(
        `INSERT INTO erasure_audit_events
           (request_id, seq, event_type, payload, emitted_at_ms)
         VALUES (?,1,'erasure/gated',?,?)`,
        [
          input.requestId,
          json({
            status: "gated",
            subjectKind: "user",
            generation,
            ...(boundPolicy === null
              ? {}
              : {
                  policyVersion: boundPolicy.policyVersion,
                  policyHash: boundPolicy.policySha256,
                }),
          }),
          input.atMs,
        ],
      );
      // Export admission and erasure share the user lifecycle lock. Revocation, download lease
      // cancellation, snapshot release and artifact deletion intents must commit with the gate so
      // there is no observable "deleting subject with a still-downloadable export" window.
      await this.revokeUserExportsForSubject(
        conn,
        input.tenantId,
        input.userId,
        await this.userExportDatabaseNow(conn),
      );
      await conn.commit();
      return record;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getUserErasureRequest(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<ErasureRequestRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${ERASURE_REQUEST_COLUMNS}
         FROM erasure_requests
        WHERE request_id=? AND tenant_id=? AND subject_kind='user' AND subject_id=?`,
      [requestId, tenantId, userId],
    );
    return rows[0] ? rowToErasureRequest(rows[0]) : null;
  }

  async getSubjectLifecycle(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<SubjectLifecycleRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind=? AND subject_id=?`,
      [tenantId, subjectKind, subjectId],
    );
    return rows[0] ? rowToSubjectLifecycle(rows[0]) : null;
  }

  async listErasureAuditEvents(requestId: string): Promise<ErasureAuditEvent[]> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT request_id, seq, event_type, payload, emitted_at_ms
         FROM erasure_audit_events WHERE request_id=? ORDER BY seq`,
      [requestId],
    );
    return rows.map((row) => {
      const type = String(row.event_type) as ErasureAuditEvent["type"];
      const payload = parse<unknown>(row.payload);
      const seq = Number(row.seq);
      const emittedAtMs = Number(row.emitted_at_ms);
      if (
        ![
          "erasure/gated",
          "erasure/status_changed",
          "erasure/blocked",
          "erasure/resumed",
          "erasure/completed",
        ].includes(type)
        || typeof payload !== "object"
        || payload === null
        || Array.isArray(payload)
        || !Number.isSafeInteger(seq)
        || seq < 1
        || !Number.isSafeInteger(emittedAtMs)
        || emittedAtMs < 0
      ) throw new Error("stored erasure audit event is invalid");
      return {
        requestId: String(row.request_id),
        seq,
        type,
        payload: payload as Record<string, unknown>,
        emittedAtMs,
      };
    });
  }

  private async assertLockedErasureJobIntegrity(
    conn: PoolConnection,
    record: ErasureRequestRecord,
    lock: "FOR SHARE" | "FOR UPDATE",
    lockedSubject?: SubjectLifecycleRecord,
  ): Promise<{
    subject: SubjectLifecycleRecord;
    audits: ErasureAuditEvent[];
    controlEvents: ErasureJobControlEvent[];
    auditSeq: number;
  }> {
    const rowFault = classifyErasureJobRecordFault(record);
    if (rowFault) throw rowFault;
    let subject = lockedSubject;
    if (!subject) {
      // Authority paths follow the global tenant -> user lock order. Claim performs a non-locking
      // candidate scan before entering that order, then locks the request row last.
      const [tenantRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
        [record.tenantId, record.tenantId],
      );
      if (!tenantRows[0]) throw newErasureJobIntegrityFault(record, "subject_binding_invalid");
      const tenant = deterministicIntegrity(
        record,
        "subject_binding_invalid",
        () => rowToSubjectLifecycle(tenantRows[0]!),
      );
      if (record.subjectKind === "tenant") subject = tenant;
      else {
        const [subjectRows] = await conn.query<Row[]>(
          `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
             FROM subject_lifecycle
            WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR SHARE`,
          [record.tenantId, record.subjectId],
        );
        subject = subjectRows[0]
          ? deterministicIntegrity(
              record,
              "subject_binding_invalid",
              () => rowToSubjectLifecycle(subjectRows[0]!),
            )
          : undefined;
      }
    }
    if (
      !subject
      || subject.tenantId !== record.tenantId
      || subject.subjectKind !== record.subjectKind
      || subject.subjectId !== record.subjectId
      || subject.state !== "deleting"
      || subject.generation !== record.generation
      || subject.activeRequestId !== record.requestId
    ) throw newErasureJobIntegrityFault(record, "subject_binding_invalid");

    const [auditRows] = await conn.query<Row[]>(
      `SELECT request_id, seq, event_type, payload, emitted_at_ms
         FROM erasure_audit_events
        WHERE request_id=? ORDER BY seq ${lock}`,
      [record.requestId],
    );
    const [controlRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_CONTROL_EVENT_COLUMNS}
         FROM erasure_job_control_events
        WHERE request_id=? ORDER BY control_generation, control_event_id ${lock}`,
      [record.requestId],
    );
    const audits = deterministicIntegrity(
      record,
      "audit_chain_invalid",
      () => rowsToErasureAuditEvents(auditRows),
    );
    deterministicIntegrity(
      record,
      "audit_chain_invalid",
      () => validateErasureAuditChain(record, audits),
    );
    if (
      record.subjectKind === "user"
      && record.requestHash !== userErasureRequestHash(record.tenantId, record.subjectId)
    ) throw newErasureJobIntegrityFault(record, "idempotency_binding_invalid");
    const controlEvents = deterministicIntegrity(
      record,
      "control_audit_invalid",
      () => controlRows.map(rowToErasureControlEvent),
    );
    deterministicIntegrity(
      record,
      "control_audit_invalid",
      () => validateErasureJobControlAudit(record, audits, controlEvents),
    );
    return { subject, audits, controlEvents, auditSeq: audits.length };
  }

  private async lockErasureAuthorizationSubject(
    conn: PoolConnection,
    authorization: ErasureJobAuthorization,
    targetLock: "FOR SHARE" | "FOR UPDATE",
  ): Promise<SubjectLifecycleRecord | null> {
    // All authority-bearing paths take tenant before user, matching create/commit/gate and the
    // later session erasure store. This avoids a request <-> subject lock inversion at completion.
    const tenantLock = authorization.subjectKind === "tenant" ? targetLock : "FOR SHARE";
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? ${tenantLock}`,
      [authorization.tenantId, authorization.tenantId],
    );
    if (!tenantRows[0]) return null;
    const tenant = rowToSubjectLifecycle(tenantRows[0]);
    if (authorization.subjectKind === "tenant") return tenant;
    if (tenant.state !== "active") return null;
    const [userRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=? ${targetLock}`,
      [authorization.tenantId, authorization.subjectId],
    );
    return userRows[0] ? rowToSubjectLifecycle(userRows[0]) : null;
  }

  private async lockErasureMaintenanceContext(
    conn: PoolConnection,
    identity: ErasureJobMaintenanceIdentity,
    lock: "FOR SHARE" | "FOR UPDATE",
  ): Promise<LockedErasureMaintenanceContext | null> {
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? ${lock}`,
      [identity.tenantId, identity.tenantId],
    );
    let tenant: SubjectLifecycleRecord | undefined;
    if (tenantRows[0]) {
      try {
        tenant = rowToSubjectLifecycle(tenantRows[0]);
      } catch {
        // A quarantined subject-binding fault must remain inspectable. Repair still performs a
        // strict check before it grants queue authority.
      }
    }

    let subject = identity.subjectKind === "tenant" ? tenant : undefined;
    if (identity.subjectKind === "user") {
      const [subjectRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? ${lock}`,
        [identity.tenantId, identity.subjectId],
      );
      if (subjectRows[0]) {
        try {
          subject = rowToSubjectLifecycle(subjectRows[0]);
        } catch {
          // See the tenant note above.
        }
      }
    }

    const [requestRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_REQUEST_COLUMNS}
         FROM erasure_requests
        WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
        ${lock}`,
      [
        identity.requestId,
        identity.tenantId,
        identity.subjectKind,
        identity.subjectId,
        identity.subjectGeneration,
      ],
    );
    if (!requestRows[0]) return null;
    const decodedRequest = decodeErasureRequest(requestRows[0]);
    const record = decodedRequest.record;
    validateErasureRequestRecordForRead(record);
    const [auditRows] = await conn.query<Row[]>(
      `SELECT request_id, seq, event_type, payload, emitted_at_ms
         FROM erasure_audit_events
        WHERE request_id=? ORDER BY seq ${lock}`,
      [record.requestId],
    );
    const [controlRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_CONTROL_EVENT_COLUMNS}
         FROM erasure_job_control_events
        WHERE request_id=? ORDER BY control_generation, control_event_id ${lock}`,
      [record.requestId],
    );
    return {
      tenant,
      subject,
      record,
      rawControlGeneration: decodedRequest.rawControlGeneration,
      auditRows,
      controlRows,
    };
  }

  /** Session actions preserve the ordinary writer's session -> tenant -> user lock order. */
  private async lockErasureSessionAuthority(
    conn: PoolConnection,
    authorization: ErasureWriteAuthorization,
    allowedStatuses: readonly ErasureRequestStatus[],
    nowMs = Date.now(),
  ): Promise<ErasureRequestRecord> {
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
      [authorization.tenantId, authorization.tenantId],
    );
    const [userRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR SHARE`,
      [authorization.tenantId, authorization.userId],
    );
    const tenant = tenantRows[0] ? rowToSubjectLifecycle(tenantRows[0]) : undefined;
    const user = userRows[0] ? rowToSubjectLifecycle(userRows[0]) : undefined;
    if (
      !tenant
      || tenant.state !== "active"
      || !user
      || user.state !== "deleting"
      || user.generation !== authorization.subjectGeneration
      || user.activeRequestId !== authorization.requestId
    ) throw new Error("stale erasure authority");

    const [requestRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_REQUEST_COLUMNS}
         FROM erasure_requests WHERE request_id=? FOR SHARE`,
      [authorization.requestId],
    );
    const request = requestRows[0] ? rowToErasureRequest(requestRows[0]) : undefined;
    if (!request) throw new Error("stale erasure authority");
    await this.assertLockedErasureJobIntegrity(conn, request, "FOR SHARE", user);
    if (
      !allowedStatuses.includes(request.status)
      || !erasureWriteAuthorizationMatches(request, authorization, nowMs)
    ) throw new Error("stale erasure authority");
    return request;
  }

  async claimErasureJobs(options: ClaimErasureJobsOptions): Promise<ErasureJobClaim[]> {
    const leaseUntilMs = validateClaimErasureJobsOptions(options);
    const conn = await this.pool.getConnection();
    try {
      const statusPlaceholders = CLAIMABLE_ERASURE_REQUEST_STATUSES.map(() => "?").join(",");
      // Phase 1 is deliberately non-locking. Each phase-2 candidate receives its own transaction:
      // a committed quarantine cannot be resurrected by an unrelated later SQL/deadlock failure,
      // while that failing candidate itself is rolled back and never misclassified as poison.
      const [candidateRows] = await conn.query<Row[]>(
        `SELECT request_id, tenant_id, subject_kind, subject_id, generation
           FROM erasure_requests
          WHERE status IN (${statusPlaceholders})
            AND NOT (
              quarantined_at_ms IS NOT NULL
              AND quarantine_reason_code IS NOT NULL
              AND quarantine_evidence_sha256 IS NOT NULL
            )
            AND (
              (available_at_ms IS NOT NULL AND available_at_ms<=?
                AND (claim_token IS NULL OR (lease_until_ms IS NOT NULL AND lease_until_ms<=?)))
              OR available_at_ms IS NULL
              OR available_at_ms < 0
              OR available_at_ms > 9007199254740991
              OR (claim_token IS NULL AND lease_until_ms IS NOT NULL)
              OR (claim_token IS NOT NULL AND lease_until_ms IS NULL)
              OR lease_until_ms < 0
              OR lease_until_ms > 9007199254740991
              OR control_generation >= 9007199254740991
              OR (claim_token IS NOT NULL
                AND NOT REGEXP_LIKE(claim_token, '^[A-Za-z0-9._:-]{1,64}$', 'c'))
              OR (quarantined_at_ms IS NULL
                AND (quarantine_reason_code IS NOT NULL OR quarantine_evidence_sha256 IS NOT NULL))
              OR (quarantined_at_ms IS NOT NULL
                AND (quarantine_reason_code IS NULL OR quarantine_evidence_sha256 IS NULL))
            )
          ORDER BY available_at_ms ASC, request_id ASC
          LIMIT 100`,
        [...CLAIMABLE_ERASURE_REQUEST_STATUSES, options.nowMs, options.nowMs],
      );
      const candidates: ErasureClaimCandidate[] = candidateRows.map((row) => ({
          requestId: String(row.request_id),
          tenantId: String(row.tenant_id),
          subjectKind: String(row.subject_kind) as DataSubjectKind,
          subjectId: String(row.subject_id),
          subjectGeneration: Number(row.generation),
      })).sort((left, right) => (
        left.tenantId.localeCompare(right.tenantId)
        || left.subjectKind.localeCompare(right.subjectKind)
        || left.subjectId.localeCompare(right.subjectId)
        || left.requestId.localeCompare(right.requestId)
      ));
      const claimed: ErasureRequestRecord[] = [];
      let consumed = 0;
      for (const candidate of candidates) {
        if (consumed >= options.limit) break;
        try {
          await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          await conn.beginTransaction();
          const result = await this.claimErasureCandidate(
            conn,
            candidate,
            options,
            leaseUntilMs,
          );
          await conn.commit();
          if (result.kind === "consumed") {
            consumed += 1;
            if (result.record) claimed.push(result.record);
          }
        } catch (error) {
          await conn.rollback().catch(() => {});
          // A prior candidate was already committed in its own transaction. Returning that
          // authority is safer than rejecting the whole call and orphaning an invisible live
          // lease; the failed candidate remains unchanged and will surface on the next poll.
          if (claimed.length > 0) break;
          throw error;
        }
      }
      return claimed.map(erasureJobClaimFromRecord);
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private async claimErasureCandidate(
    conn: PoolConnection,
    candidate: ErasureClaimCandidate,
    options: ClaimErasureJobsOptions,
    leaseUntilMs: number,
  ): Promise<ErasureClaimCandidateResult> {
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
      [candidate.tenantId, candidate.tenantId],
    );
    let tenant: SubjectLifecycleRecord | undefined;
    let subject: SubjectLifecycleRecord | undefined;
    let subjectDecodeFailed = false;
    if (tenantRows[0]) {
      try {
        tenant = rowToSubjectLifecycle(tenantRows[0]);
        if (candidate.subjectKind === "tenant") subject = tenant;
      } catch {
        subjectDecodeFailed = true;
      }
    }
    if (candidate.subjectKind === "user") {
      const [userRows] = await conn.query<Row[]>(
        `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
           FROM subject_lifecycle
          WHERE tenant_id=? AND subject_kind='user' AND subject_id=? FOR SHARE`,
        [candidate.tenantId, candidate.subjectId],
      );
      if (userRows[0]) {
        try {
          subject = rowToSubjectLifecycle(userRows[0]);
        } catch {
          subjectDecodeFailed = true;
        }
      }
    }
    const [requestRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_REQUEST_COLUMNS}
         FROM erasure_requests
        WHERE request_id=?
        FOR UPDATE SKIP LOCKED`,
      [candidate.requestId],
    );
    if (!requestRows[0]) return { kind: "skipped" };
    const rawQuarantineEnvelope = rawErasureRequestQuarantineEnvelope(requestRows[0]);
    const decodedCurrent = decodeErasureRequest(requestRows[0]);
    const current = decodedCurrent.record;
    if (
      current.tenantId !== candidate.tenantId
      || current.subjectKind !== candidate.subjectKind
      || current.subjectId !== candidate.subjectId
      || current.generation !== candidate.subjectGeneration
    ) return { kind: "skipped" };
    if (!isClaimableErasureRequestStatus(current.status) || isErasureJobQuarantined(current)) {
      return { kind: "skipped" };
    }
    if (!hasSafeErasureRequestQuarantineEnvelope(current)) {
      await this.terminallyIsolateUnsafeErasureJobEnvelope(
        conn,
        rawQuarantineEnvelope,
        options.nowMs,
      );
      return { kind: "consumed" };
    }
    let fault = decodedCurrent.controlGenerationSaturated
      ? newErasureJobIntegrityFault(current, "control_audit_invalid")
      : classifyErasureJobRecordFault(current);
    const normallyDue = current.availableAtMs !== undefined
      && Number.isSafeInteger(current.availableAtMs)
      && current.availableAtMs <= options.nowMs
      && (
        current.claimToken === undefined
        || (current.leaseUntilMs !== undefined
          && Number.isSafeInteger(current.leaseUntilMs)
          && current.leaseUntilMs <= options.nowMs)
      );
    if (!fault && !normallyDue) return { kind: "skipped" };

    const [auditRows] = await conn.query<Row[]>(
      `SELECT request_id, seq, event_type, payload, emitted_at_ms
         FROM erasure_audit_events
        WHERE request_id=? ORDER BY seq FOR SHARE`,
      [current.requestId],
    );
    const controlValidationAudits = rowsToErasureControlValidationAudits(auditRows);
    const [controlRows] = await conn.query<Row[]>(
      `SELECT ${ERASURE_CONTROL_EVENT_COLUMNS}
         FROM erasure_job_control_events
        WHERE request_id=? ORDER BY control_generation, control_event_id FOR SHARE`,
      [current.requestId],
    );

    if (!fault && (
      subjectDecodeFailed
      || !tenant
      || tenant.tenantId !== current.tenantId
      || tenant.subjectKind !== "tenant"
      || tenant.subjectId !== current.tenantId
      || (current.subjectKind === "user" && tenant.state !== "active")
      || !subject
      || subject.tenantId !== current.tenantId
      || subject.subjectKind !== current.subjectKind
      || subject.subjectId !== current.subjectId
      || subject.state !== "deleting"
      || subject.generation !== current.generation
      || subject.activeRequestId !== current.requestId
    )) fault = newErasureJobIntegrityFault(current, "subject_binding_invalid");
    if (!fault) {
      try {
        const audits = rowsToErasureAuditEvents(auditRows);
        validateErasureAuditChain(current, audits);
      } catch {
        fault = newErasureJobIntegrityFault(current, "audit_chain_invalid");
      }
    }
    if (
      !fault
      && current.subjectKind === "user"
      && current.requestHash !== userErasureRequestHash(current.tenantId, current.subjectId)
    ) fault = newErasureJobIntegrityFault(current, "idempotency_binding_invalid");
    // A torn quarantine overlay is queue-control poison, not proof that the append-only audit is
    // corrupt. Validate the audit against the pre-overlay projection in that one recoverable case;
    // every other mismatch still takes precedence as control_audit_invalid. A normal quarantine
    // advances to a free safe generation; an exhausted row fence takes the terminal no-event path.
    const quarantineMarkerCount = [
      current.quarantinedAtMs,
      current.quarantineReasonCode,
      current.quarantineEvidenceSha256,
    ].filter((value) => value !== undefined).length;
    const controlRecord = fault?.reasonCode === "queue_control_invalid"
      && quarantineMarkerCount > 0
      && quarantineMarkerCount < 3
      ? (() => {
          const normalized = { ...current };
          delete normalized.quarantinedAtMs;
          delete normalized.quarantineReasonCode;
          delete normalized.quarantineEvidenceSha256;
          return normalized;
        })()
      : current;
    try {
      const controlEvents = controlRows.map(rowToErasureControlEvent);
      validateErasureJobControlAudit(controlRecord, controlValidationAudits, controlEvents);
    } catch {
      fault = newErasureJobIntegrityFault(current, "control_audit_invalid");
    }
    if (fault) {
      await this.quarantineLockedErasureJob(
        conn,
        current,
        decodedCurrent.rawControlGeneration,
        fault,
        controlRows,
        options.nowMs,
      );
      return { kind: "consumed" };
    }

    const next: ErasureRequestRecord = {
      ...current,
      attempts: current.attempts + 1,
      claimToken: options.claimToken,
      leaseUntilMs,
    };
    validateErasureRequestRecord(next);
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE erasure_requests
          SET attempts=?, claim_token=?, lease_until_ms=?
        WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
          AND status=? AND available_at_ms IS NOT NULL AND available_at_ms<=?
          AND quarantined_at_ms IS NULL
          AND quarantine_reason_code IS NULL
          AND quarantine_evidence_sha256 IS NULL
          AND control_generation=?
          AND (claim_token IS NULL OR lease_until_ms<=?)`,
      [
        next.attempts,
        options.claimToken,
        leaseUntilMs,
        current.requestId,
        current.tenantId,
        current.subjectKind,
        current.subjectId,
        current.generation,
        current.status,
        options.nowMs,
        current.controlGeneration,
        options.nowMs,
      ],
    );
    if (updated.affectedRows !== 1) throw new Error("erasure job changed while locked");
    return { kind: "consumed", record: next };
  }

  /**
   * A damaged owner/generation/time envelope cannot enter the repairable control chain without
   * guessing authority. Preserve a hash commitment to the exact locked BIGINT/string fields,
   * revoke queue authority, and append a private terminal incident in this same transaction.
   */
  private async terminallyIsolateUnsafeErasureJobEnvelope(
    conn: PoolConnection,
    raw: ErasureJobUnsafeQuarantineEnvelope,
    atMs: number,
  ): Promise<void> {
    if (!isClaimableErasureRequestStatus(raw.status as ErasureRequestStatus)) {
      throw new Error("erasure request is not terminally isolatable");
    }
    const evidenceSha256 = erasureJobUnsafeQuarantineEnvelopeEvidenceSha256(raw);
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE erasure_requests
          SET control_generation=?, quarantined_at_ms=?,
              quarantine_reason_code='control_audit_invalid',
              quarantine_evidence_sha256=?, available_at_ms=NULL, claim_token=NULL,
              lease_until_ms=NULL
        WHERE request_id=? AND control_generation=?`,
      [
        raw.rawControlGeneration,
        atMs,
        evidenceSha256,
        raw.requestId,
        raw.rawControlGeneration,
      ],
    );
    if (updated.affectedRows !== 1) {
      throw new Error("erasure request changed while terminally isolating its envelope");
    }
    await conn.query(
      `INSERT INTO erasure_job_terminal_incidents
         (request_id, raw_control_generation, reason_code, evidence_sha256, emitted_at_ms)
       VALUES (?,?,'unsafe_quarantine_envelope',?,?)`,
      [raw.requestId, raw.rawControlGeneration, evidenceSha256, atMs],
    );
  }

  private async quarantineLockedErasureJob(
    conn: PoolConnection,
    current: ErasureRequestRecord,
    rawControlGeneration: string,
    fault: ErasureJobIntegrityFault,
    controlRows: readonly Row[],
    atMs: number,
  ): Promise<void> {
    if (!isClaimableErasureRequestStatus(current.status) || isErasureJobQuarantined(current)) {
      throw new Error("erasure request is not safely quarantineable");
    }
    const occupiedSafeGenerations = new Set<number>();
    for (const row of controlRows) {
      try {
        const generation = mysqlSafeInteger(
          row.control_generation,
          "stored erasure control generation",
        );
        if (generation > 0) occupiedSafeGenerations.add(generation);
      } catch {
        // An unsafe/invalid event is itself control_audit_invalid evidence. It must not prevent a
        // safe row fence and durable quarantine; this chain intentionally remains non-repairable.
      }
    }
    let controlGeneration = current.controlGeneration + 1;
    while (Number.isSafeInteger(controlGeneration) && occupiedSafeGenerations.has(controlGeneration)) {
      controlGeneration += 1;
    }
    if (!Number.isSafeInteger(controlGeneration) || controlGeneration <= 0) {
      await this.terminallyQuarantineLockedErasureJob(
        conn,
        current,
        rawControlGeneration,
        atMs,
      );
      return;
    }
    const evidenceSha256 = erasureJobInterventionEvidenceSha256({
      requestId: current.requestId,
      controlGeneration,
      phase: current.status,
      kind: "quarantine",
      reasonCode: fault.reasonCode,
    });
    const effectiveAtMs = Math.max(
      atMs,
      Number.isSafeInteger(current.gatedAtMs) ? current.gatedAtMs : atMs,
      Number.isSafeInteger(current.updatedAtMs) ? current.updatedAtMs : atMs,
    );
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE erasure_requests
          SET control_generation=?, quarantined_at_ms=?, quarantine_reason_code=?,
              quarantine_evidence_sha256=?, available_at_ms=NULL, claim_token=NULL,
              lease_until_ms=NULL, updated_at_ms=?
        WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
          AND status=? AND control_generation=?
          AND quarantined_at_ms <=> ? AND quarantine_reason_code <=> ?
          AND quarantine_evidence_sha256 <=> ?`,
      [
        controlGeneration,
        effectiveAtMs,
        fault.reasonCode,
        evidenceSha256,
        effectiveAtMs,
        current.requestId,
        current.tenantId,
        current.subjectKind,
        current.subjectId,
        current.generation,
        current.status,
        rawControlGeneration,
        current.quarantinedAtMs ?? null,
        current.quarantineReasonCode ?? null,
        current.quarantineEvidenceSha256 ?? null,
      ],
    );
    if (updated.affectedRows !== 1) throw new Error("erasure request changed while quarantining");
    await conn.query(
      `INSERT INTO erasure_job_control_events
         (request_id, control_generation, event_type, phase, reason_code, action_code,
          actor_key_id, before_sha256, after_sha256, emitted_at_ms)
       VALUES (?,?,'erasure_job/quarantined',?,?,NULL,NULL,?,NULL,?)`,
      [
        current.requestId,
        controlGeneration,
        current.status,
        fault.reasonCode,
        evidenceSha256,
        effectiveAtMs,
      ],
    );
  }

  /**
   * Terminal exception for an exhausted/unrepresentable fence. The exact durable BIGINT is never
   * reduced, no colliding control event is fabricated, and the row becomes permanently
   * unavailable to workers while remaining owner/maintenance-readable.
   */
  private async terminallyQuarantineLockedErasureJob(
    conn: PoolConnection,
    current: ErasureRequestRecord,
    rawControlGeneration: string,
    atMs: number,
  ): Promise<void> {
    const maximum = BigInt(Number.MAX_SAFE_INTEGER);
    const currentFence = BigInt(rawControlGeneration);
    const terminalFence = currentFence < maximum ? maximum : currentFence;
    const terminalFenceText = terminalFence.toString();
    const effectiveAtMs = Math.max(
      atMs,
      Number.isSafeInteger(current.gatedAtMs) ? current.gatedAtMs : atMs,
      Number.isSafeInteger(current.updatedAtMs) ? current.updatedAtMs : atMs,
    );
    const evidenceSha256 = erasureJobTerminalInterventionEvidenceSha256({
      requestId: current.requestId,
      rawControlGeneration: terminalFenceText,
      phase: current.status,
      reasonCode: "control_audit_invalid",
    });
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE erasure_requests
          SET control_generation=?, quarantined_at_ms=?,
              quarantine_reason_code='control_audit_invalid',
              quarantine_evidence_sha256=?, available_at_ms=NULL, claim_token=NULL,
              lease_until_ms=NULL, updated_at_ms=?
        WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
          AND status=? AND control_generation=?
          AND quarantined_at_ms <=> ? AND quarantine_reason_code <=> ?
          AND quarantine_evidence_sha256 <=> ?`,
      [
        terminalFenceText,
        effectiveAtMs,
        evidenceSha256,
        effectiveAtMs,
        current.requestId,
        current.tenantId,
        current.subjectKind,
        current.subjectId,
        current.generation,
        current.status,
        rawControlGeneration,
        current.quarantinedAtMs ?? null,
        current.quarantineReasonCode ?? null,
        current.quarantineEvidenceSha256 ?? null,
      ],
    );
    if (updated.affectedRows !== 1) {
      throw new Error("erasure request changed while terminally quarantining");
    }
  }

  async renewErasureJobClaim(
    authorization: ErasureJobAuthorization,
    options: RenewErasureJobClaimOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    const leaseUntilMs = validateRenewErasureJobClaimOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const subject = await this.lockErasureAuthorizationSubject(conn, authorization, "FOR SHARE");
      if (!subject) {
        await conn.commit();
        return false;
      }
      const [rows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_REQUEST_COLUMNS} FROM erasure_requests WHERE request_id=? FOR UPDATE`,
        [authorization.requestId],
      );
      if (!rows[0]) {
        await conn.commit();
        return false;
      }
      const current = rowToErasureRequest(rows[0]);
      await this.assertLockedErasureJobIntegrity(conn, current, "FOR SHARE", subject);
      if (!erasureJobAuthorizationMatches(current, authorization, options.nowMs)) {
        await conn.commit();
        return false;
      }
      const nextLeaseUntilMs = Math.max(current.leaseUntilMs!, leaseUntilMs);
      if (nextLeaseUntilMs === current.leaseUntilMs) {
        await conn.commit();
        return true;
      }
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_requests SET lease_until_ms=GREATEST(lease_until_ms, ?)
          WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
            AND status=? AND attempts=? AND claim_token=? AND lease_until_ms>?`,
        [
          nextLeaseUntilMs,
          current.requestId,
          current.tenantId,
          current.subjectKind,
          current.subjectId,
          current.generation,
          current.status,
          authorization.claimAttempt,
          authorization.claimToken,
          options.nowMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("erasure job claim changed while locked");
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async transitionErasureJob(
    authorization: ErasureJobAuthorization,
    options: TransitionErasureJobOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    validateTransitionErasureJobOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const lockedSubject = await this.lockErasureAuthorizationSubject(conn, authorization, "FOR UPDATE");
      if (!lockedSubject) {
        await conn.commit();
        return false;
      }
      const [rows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_REQUEST_COLUMNS} FROM erasure_requests WHERE request_id=? FOR UPDATE`,
        [authorization.requestId],
      );
      if (!rows[0]) {
        await conn.commit();
        return false;
      }
      const current = rowToErasureRequest(rows[0]);
      const { auditSeq } = await this.assertLockedErasureJobIntegrity(
        conn,
        current,
        "FOR UPDATE",
        lockedSubject,
      );
      if (
        current.status !== options.fromStatus
        || !erasureJobAuthorizationMatches(current, authorization, options.atMs)
      ) {
        await conn.commit();
        return false;
      }
      if (
        options.policyVersion !== undefined
      ) {
        if (current.policyVersion === undefined) {
          throw new Error("erasure policy identity cannot be assigned after admission");
        }
        if (current.policyVersion !== options.policyVersion || current.policyHash !== options.policyHash) {
          throw new Error("erasure policy identity is immutable");
        }
      }

      const effectiveAtMs = Math.max(current.updatedAtMs, options.atMs);
      const policyVersion = current.policyVersion;
      const policyHash = current.policyHash;
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_requests
            SET status=?, available_at_ms=?, claim_token=NULL, lease_until_ms=NULL,
                last_error_code=?, policy_version=?, policy_hash=?, updated_at_ms=?,
                completed_at_ms=?, counts_json=?, checksum=?
          WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
            AND status=? AND attempts=? AND claim_token=? AND lease_until_ms>?`,
        [
          options.toStatus,
          options.availableAtMs ?? null,
          options.toStatus === "blocked" ? options.errorCode : null,
          policyVersion ?? null,
          policyHash ?? null,
          effectiveAtMs,
          null,
          null,
          null,
          current.requestId,
          current.tenantId,
          current.subjectKind,
          current.subjectId,
          current.generation,
          options.fromStatus,
          authorization.claimAttempt,
          authorization.claimToken,
          options.atMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("erasure job transition changed while locked");

      if (options.fromStatus === "reconciling_usage" && options.toStatus === "awaiting_purge_policy") {
        await conn.query(
          `INSERT INTO erasure_policy_evaluation_jobs
             (request_id, tenant_id, subject_kind, subject_id, subject_generation,
              build_generation, cursor_session_id, target_count, target_root_sha256,
              available_at_ms, attempts, claim_token, lease_until_ms, last_error_code,
              sealed_at_ms, created_at_ms, updated_at_ms)
           VALUES (?,?,?,?,?,1,NULL,0,?, ?,0,NULL,NULL,NULL,NULL,?,?)`,
          [
            current.requestId,
            current.tenantId,
            current.subjectKind,
            current.subjectId,
            current.generation,
            EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
            effectiveAtMs,
            effectiveAtMs,
            effectiveAtMs,
          ],
        );
      }

      const auditType: ErasureAuditEvent["type"] = options.toStatus === "blocked"
        ? "erasure/blocked"
        : "erasure/status_changed";
      const payload = {
        fromStatus: options.fromStatus,
        status: options.toStatus,
        generation: current.generation,
        ...(policyVersion === undefined ? {} : { policyVersion }),
        ...(policyHash === undefined ? {} : { policyHash }),
        ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      };
      await conn.query(
        `INSERT INTO erasure_audit_events (request_id, seq, event_type, payload, emitted_at_ms)
         VALUES (?,?,?,?,?)`,
        [current.requestId, auditSeq + 1, auditType, json(payload), effectiveAtMs],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryErasureJob(
    authorization: ErasureJobAuthorization,
    options: RetryErasureJobOptions,
  ): Promise<boolean> {
    validateErasureJobAuthorization(authorization);
    validateRetryErasureJobOptions(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const subject = await this.lockErasureAuthorizationSubject(conn, authorization, "FOR SHARE");
      if (!subject) {
        await conn.commit();
        return false;
      }
      const [rows] = await conn.query<Row[]>(
        `SELECT ${ERASURE_REQUEST_COLUMNS} FROM erasure_requests WHERE request_id=? FOR UPDATE`,
        [authorization.requestId],
      );
      if (!rows[0]) {
        await conn.commit();
        return false;
      }
      const current = rowToErasureRequest(rows[0]);
      await this.assertLockedErasureJobIntegrity(conn, current, "FOR SHARE", subject);
      if (!erasureJobAuthorizationMatches(current, authorization, options.failedAtMs)) {
        await conn.commit();
        return false;
      }
      const effectiveAtMs = Math.max(current.updatedAtMs, options.failedAtMs);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_requests
            SET available_at_ms=?, claim_token=NULL, lease_until_ms=NULL,
                last_error_code=?, updated_at_ms=?
          WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
            AND status=? AND attempts=? AND claim_token=? AND lease_until_ms>?`,
        [
          options.availableAtMs,
          options.errorCode,
          effectiveAtMs,
          current.requestId,
          current.tenantId,
          current.subjectKind,
          current.subjectId,
          current.generation,
          current.status,
          authorization.claimAttempt,
          authorization.claimToken,
          options.failedAtMs,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("erasure job retry changed while locked");
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async inspectErasureJobIntervention(
    identity: ErasureJobMaintenanceIdentity,
  ): Promise<ErasureJobInterventionInspection | null> {
    validateErasureJobMaintenanceIdentity(identity);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasureMaintenanceContext(conn, identity, "FOR SHARE");
      if (!context) {
        await conn.commit();
        return null;
      }
      const { record } = context;
      if (isErasureJobQuarantined(record)) {
        // Every individual event is decoded strictly. A quarantine whose reason is a broken
        // control chain remains inspectable, but the broken chain cannot be declared repaired by
        // this API; repairAndResume still requires the complete validator to pass.
        try {
          const controlEvents = context.controlRows.map(rowToErasureControlEvent);
          validateErasureJobControlAudit(
            record,
            rowsToErasureControlValidationAudits(context.auditRows),
            controlEvents,
          );
        } catch (error) {
          if (record.quarantineReasonCode !== "control_audit_invalid") throw error;
        }
        const reasonCode = record.quarantineReasonCode!;
        const evidenceSha256 = record.quarantineEvidenceSha256!;
        const rawControlGeneration = BigInt(context.rawControlGeneration);
        const maximumSafeGeneration = BigInt(Number.MAX_SAFE_INTEGER);
        // A raw fence above the public number domain must be bound only by the exact-decimal
        // terminal evidence. Accepting the MAX_SAFE projection there would hide a database-level
        // change to the original BIGINT, even though the row remains non-repairable.
        const expected = rawControlGeneration > maximumSafeGeneration
          ? undefined
          : erasureJobInterventionEvidenceSha256({
              requestId: record.requestId,
              controlGeneration: record.controlGeneration,
              phase: record.status,
              kind: "quarantine",
              reasonCode,
            });
        const terminalExpected = reasonCode === "control_audit_invalid"
          && rawControlGeneration >= maximumSafeGeneration
          ? erasureJobTerminalInterventionEvidenceSha256({
              requestId: record.requestId,
              rawControlGeneration: context.rawControlGeneration,
              phase: record.status,
              reasonCode,
            })
          : undefined;
        if (expected !== evidenceSha256 && terminalExpected !== evidenceSha256) {
          throw new Error("erasure quarantine evidence is corrupt");
        }
        const currentAudits = reasonCode === "audit_chain_invalid"
          ? context.auditRows.map((row) => ({
              requestId: String(row.request_id),
              seq: Number(row.seq),
              type: String(row.event_type) as ErasureAuditEvent["type"],
              // Inspection needs only the bounded envelope/count. Repair always decodes and
              // validates the actual payload before restoring authority.
              payload: {},
              emittedAtMs: Number(row.emitted_at_ms),
            }))
          : rowsToErasureAuditEvents(context.auditRows);
        // A corrupt control chain is observable through this bounded projection but cannot be
        // proven repaired by an API that itself relies on that append-only chain as authority.
        const allowedActions = reasonCode === "control_audit_invalid"
          ? []
          : erasureJobAllowedMaintenanceActions(record, currentAudits);
        await conn.commit();
        return {
          requestId: record.requestId,
          phase: record.status,
          controlGeneration: record.controlGeneration,
          kind: "quarantine",
          reasonCode,
          evidenceSha256,
          occurredAtMs: record.quarantinedAtMs!,
          allowedActions,
        };
      }

      if (record.status !== "blocked") {
        await conn.commit();
        return null;
      }
      if (
        !context.tenant
        || (record.subjectKind === "user" && context.tenant.state !== "active")
      ) throw new Error("erasure request tenant lifecycle is invalid");
      const { audits } = await this.assertLockedErasureJobIntegrity(
        conn,
        record,
        "FOR SHARE",
        context.subject,
      );
      const reasonCode = record.lastErrorCode!;
      const evidenceSha256 = erasureJobInterventionEvidenceSha256({
        requestId: record.requestId,
        controlGeneration: record.controlGeneration,
        phase: record.status,
        kind: "blocked",
        reasonCode,
      });
      const allowedActions = erasureJobAllowedMaintenanceActions(record, audits);
      const resumePhase = allowedActions.includes("resume_blocked")
        ? deriveBlockedErasureResumePhase(record, audits)
        : undefined;
      const result: ErasureJobInterventionInspection = {
        requestId: record.requestId,
        phase: record.status,
        controlGeneration: record.controlGeneration,
        kind: "blocked",
        reasonCode,
        evidenceSha256,
        occurredAtMs: audits.at(-1)!.emittedAtMs,
        ...(resumePhase === undefined ? {} : { resumePhase }),
        allowedActions,
      };
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async repairAndResumeErasureJob(input: RepairAndResumeErasureJobInput): Promise<boolean> {
    validateRepairAndResumeErasureJobInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const context = await this.lockErasureMaintenanceContext(conn, input, "FOR UPDATE");
      if (!context) {
        await conn.commit();
        return false;
      }
      const current = context.record;
      if (current.controlGeneration !== input.expectedControlGeneration) {
        await conn.commit();
        return false;
      }

      if (isErasureJobQuarantined(current)) {
        const expectedEvidenceSha256 = erasureJobInterventionEvidenceSha256({
          requestId: current.requestId,
          controlGeneration: current.controlGeneration,
          phase: current.status,
          kind: "quarantine",
          reasonCode: current.quarantineReasonCode!,
        });
        if (
          current.quarantineEvidenceSha256 !== expectedEvidenceSha256
          || input.expectedEvidenceSha256 !== expectedEvidenceSha256
          || input.actionCode === "resume_blocked"
        ) {
          await conn.commit();
          return false;
        }
        const currentAudits = rowsToErasureAuditEvents(context.auditRows);
        const allowedActions = current.quarantineReasonCode === "control_audit_invalid"
          ? []
          : erasureJobAllowedMaintenanceActions(current, currentAudits);
        if (!allowedActions.includes(input.actionCode)) {
          await conn.commit();
          return false;
        }
        const currentControlEvents = context.controlRows.map(rowToErasureControlEvent);
        validateErasureJobControlAudit(current, currentAudits, currentControlEvents);

        const effectiveAtMs = Math.max(current.updatedAtMs, input.atMs);
        const next: ErasureRequestRecord = { ...current };
        next.controlGeneration = current.controlGeneration + 1;
        next.updatedAtMs = effectiveAtMs;
        next.availableAtMs = effectiveAtMs;
        delete next.claimToken;
        delete next.leaseUntilMs;
        delete next.quarantinedAtMs;
        delete next.quarantineReasonCode;
        delete next.quarantineEvidenceSha256;

        let stagedAudits = currentAudits;
        if (input.actionCode === "restore_initial_gate_audit") {
          if (current.status !== "gated" || currentAudits.length !== 0) {
            await conn.commit();
            return false;
          }
          stagedAudits = [{
            requestId: current.requestId,
            seq: 1,
            type: "erasure/gated",
            payload: {
              status: "gated",
              subjectKind: current.subjectKind,
              generation: current.generation,
              ...(current.policyVersion === undefined
                ? {}
                : {
                    policyVersion: current.policyVersion,
                    policyHash: current.policyHash,
                  }),
            },
            emittedAtMs: current.gatedAtMs,
          }];
        }

        validateErasureRequestRecord(next);
        validateErasureAuditChain(next, stagedAudits);
        if (
          !context.tenant
          || (next.subjectKind === "user" && context.tenant.state !== "active")
          || !context.subject
          || context.subject.tenantId !== next.tenantId
          || context.subject.subjectKind !== next.subjectKind
          || context.subject.subjectId !== next.subjectId
          || context.subject.state !== "deleting"
          || context.subject.generation !== next.generation
          || context.subject.activeRequestId !== next.requestId
        ) throw new Error("repaired erasure request does not match its subject lifecycle");
        if (
          next.subjectKind === "user"
          && next.requestHash !== userErasureRequestHash(next.tenantId, next.subjectId)
        ) throw new Error("repaired erasure request idempotency binding is invalid");

        const controlOutcome = {
          requestId: next.requestId,
          controlGeneration: next.controlGeneration,
          eventType: "erasure_job/quarantine_repaired" as const,
          phase: next.status,
          reasonCode: current.quarantineReasonCode!,
          actionCode: input.actionCode,
          actorKeyId: input.actorKeyId,
          beforeSha256: expectedEvidenceSha256,
          emittedAtMs: effectiveAtMs,
        };
        const afterSha256 = erasureJobControlOutcomeSha256(controlOutcome);
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE erasure_requests
              SET control_generation=?, quarantined_at_ms=NULL, quarantine_reason_code=NULL,
                  quarantine_evidence_sha256=NULL, available_at_ms=?, claim_token=NULL,
                  lease_until_ms=NULL, updated_at_ms=?
            WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
              AND status=? AND control_generation=? AND quarantined_at_ms=?
              AND quarantine_reason_code=? AND quarantine_evidence_sha256=?`,
          [
            next.controlGeneration,
            next.availableAtMs,
            next.updatedAtMs,
            current.requestId,
            current.tenantId,
            current.subjectKind,
            current.subjectId,
            current.generation,
            current.status,
            input.expectedControlGeneration,
            current.quarantinedAtMs,
            current.quarantineReasonCode,
            expectedEvidenceSha256,
          ],
        );
        if (updated.affectedRows !== 1) throw new Error("erasure quarantine changed while repairing");
        if (input.actionCode === "restore_initial_gate_audit") {
          const audit = stagedAudits[0]!;
          await conn.query(
            `INSERT INTO erasure_audit_events
               (request_id, seq, event_type, payload, emitted_at_ms)
             VALUES (?,?,?,?,?)`,
            [audit.requestId, audit.seq, audit.type, json(audit.payload), audit.emittedAtMs],
          );
        }
        const [inserted] = await conn.query<mysql.ResultSetHeader>(
          `INSERT INTO erasure_job_control_events
             (request_id, control_generation, event_type, phase, reason_code, action_code,
              actor_key_id, before_sha256, after_sha256, emitted_at_ms)
           VALUES (?,?,'erasure_job/quarantine_repaired',?,?,?,?,?,?,?)`,
          [
            next.requestId,
            next.controlGeneration,
            next.status,
            current.quarantineReasonCode,
            input.actionCode,
            input.actorKeyId,
            expectedEvidenceSha256,
            afterSha256,
            effectiveAtMs,
          ],
        );
        const controlEvent: ErasureJobControlEvent = {
          controlEventId: Number(inserted.insertId),
          requestId: next.requestId,
          controlGeneration: next.controlGeneration,
          eventType: "erasure_job/quarantine_repaired",
          phase: next.status,
          reasonCode: current.quarantineReasonCode!,
          actionCode: input.actionCode,
          actorKeyId: input.actorKeyId,
          beforeSha256: expectedEvidenceSha256,
          afterSha256,
          emittedAtMs: effectiveAtMs,
        };
        validateErasureJobControlEvent(controlEvent);
        validateErasureJobControlAudit(
          next,
          stagedAudits,
          [...currentControlEvents, controlEvent],
        );
        await conn.commit();
        return true;
      }

      if (current.status !== "blocked" || input.actionCode !== "resume_blocked") {
        await conn.commit();
        return false;
      }
      if (
        !context.tenant
        || (current.subjectKind === "user" && context.tenant.state !== "active")
      ) throw new Error("erasure request tenant lifecycle is invalid");
      const { audits: currentAudits, controlEvents: currentControlEvents } =
        await this.assertLockedErasureJobIntegrity(
          conn,
          current,
          "FOR UPDATE",
          context.subject,
        );
      const reasonCode = current.lastErrorCode!;
      const evidenceSha256 = erasureJobInterventionEvidenceSha256({
        requestId: current.requestId,
        controlGeneration: current.controlGeneration,
        phase: current.status,
        kind: "blocked",
        reasonCode,
      });
      if (evidenceSha256 !== input.expectedEvidenceSha256) {
        await conn.commit();
        return false;
      }
      if (!erasureJobAllowedMaintenanceActions(current, currentAudits).includes("resume_blocked")) {
        await conn.commit();
        return false;
      }
      const resumePhase = deriveBlockedErasureResumePhase(current, currentAudits);
      const effectiveAtMs = Math.max(current.updatedAtMs, input.atMs);
      const next: ErasureRequestRecord = {
        ...current,
        status: resumePhase,
        controlGeneration: current.controlGeneration + 1,
        updatedAtMs: effectiveAtMs,
        availableAtMs: effectiveAtMs,
      };
      delete next.lastErrorCode;
      delete next.claimToken;
      delete next.leaseUntilMs;
      validateErasureRequestRecord(next);
      const resumedAudit: ErasureAuditEvent = {
        requestId: next.requestId,
        seq: currentAudits.length + 1,
        type: "erasure/resumed",
        payload: {
          fromStatus: "blocked",
          status: resumePhase,
          generation: next.generation,
          ...(next.policyVersion === undefined ? {} : { policyVersion: next.policyVersion }),
          ...(next.policyHash === undefined ? {} : { policyHash: next.policyHash }),
        },
        emittedAtMs: effectiveAtMs,
      };
      const stagedAudits = [...currentAudits, resumedAudit];
      validateErasureAuditChain(next, stagedAudits);
      const controlOutcome = {
        requestId: next.requestId,
        controlGeneration: next.controlGeneration,
        eventType: "erasure_job/blocked_resumed" as const,
        phase: next.status,
        reasonCode,
        actionCode: "resume_blocked" as const,
        actorKeyId: input.actorKeyId,
        beforeSha256: evidenceSha256,
        emittedAtMs: effectiveAtMs,
      };
      const afterSha256 = erasureJobControlOutcomeSha256(controlOutcome);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE erasure_requests
            SET status=?, control_generation=?, available_at_ms=?, claim_token=NULL,
                lease_until_ms=NULL, last_error_code=NULL, updated_at_ms=?
          WHERE request_id=? AND tenant_id=? AND subject_kind=? AND subject_id=? AND generation=?
            AND status='blocked' AND control_generation=? AND last_error_code=?
            AND quarantined_at_ms IS NULL AND quarantine_reason_code IS NULL
            AND quarantine_evidence_sha256 IS NULL`,
        [
          next.status,
          next.controlGeneration,
          next.availableAtMs,
          next.updatedAtMs,
          current.requestId,
          current.tenantId,
          current.subjectKind,
          current.subjectId,
          current.generation,
          input.expectedControlGeneration,
          reasonCode,
        ],
      );
      if (updated.affectedRows !== 1) throw new Error("blocked erasure request changed while resuming");
      await conn.query(
        `INSERT INTO erasure_audit_events
           (request_id, seq, event_type, payload, emitted_at_ms)
         VALUES (?,?,?,?,?)`,
        [resumedAudit.requestId, resumedAudit.seq, resumedAudit.type, json(resumedAudit.payload), effectiveAtMs],
      );
      const [inserted] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO erasure_job_control_events
           (request_id, control_generation, event_type, phase, reason_code, action_code,
            actor_key_id, before_sha256, after_sha256, emitted_at_ms)
         VALUES (?,?,'erasure_job/blocked_resumed',?,?, 'resume_blocked',?,?,?,?)`,
        [
          next.requestId,
          next.controlGeneration,
          next.status,
          reasonCode,
          input.actorKeyId,
          evidenceSha256,
          afterSha256,
          effectiveAtMs,
        ],
      );
      const controlEvent: ErasureJobControlEvent = {
        controlEventId: Number(inserted.insertId),
        requestId: next.requestId,
        controlGeneration: next.controlGeneration,
        eventType: "erasure_job/blocked_resumed",
        phase: next.status,
        reasonCode,
        actionCode: "resume_blocked",
        actorKeyId: input.actorKeyId,
        beforeSha256: evidenceSha256,
        afterSha256,
        emittedAtMs: effectiveAtMs,
      };
      validateErasureJobControlEvent(controlEvent);
      validateErasureJobControlAudit(
        next,
        stagedAudits,
        [...currentControlEvents, controlEvent],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  // ---------- agents ----------
  async createAgent(def: AgentDefinition) {
    await this.pool.query(
      "INSERT INTO agent_versions (tenant_id, agent_id, version, definition, created_at_ms) VALUES (?,?,?,?,?)",
      [def.tenantId, def.id, def.version, json(def), def.createdAtMs],
    );
  }
  async getAgent(tenantId: string, agentId: string, version?: number) {
    const [rows] = await this.pool.query<Row[]>(
      version === undefined
        ? "SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? ORDER BY version DESC LIMIT 1"
        : "SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? AND version=?",
      version === undefined ? [tenantId, agentId] : [tenantId, agentId, version],
    );
    return rows[0] ? parse<AgentDefinition>(rows[0].definition) : null;
  }
  async listAgents(tenantId: string, opts: { cursor?: string; limit: number }): Promise<Page<AgentDefinition>> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.definition, a.agent_id FROM agent_versions a
         JOIN (SELECT agent_id, MAX(version) v FROM agent_versions WHERE tenant_id=? GROUP BY agent_id) m
           ON a.agent_id=m.agent_id AND a.version=m.v
        WHERE a.tenant_id=? ${opts.cursor ? "AND a.agent_id < ?" : ""}
        ORDER BY a.agent_id DESC LIMIT ?`,
      opts.cursor ? [tenantId, tenantId, opts.cursor, opts.limit + 1] : [tenantId, tenantId, opts.limit + 1],
    );
    const data = rows.slice(0, opts.limit).map((r) => parse<AgentDefinition>(r.definition));
    return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
  }

  // ---------- sessions ----------
  async createSession(s: Session): Promise<CommitResult> {
    if (s.lastSeq !== 0) throw new Error("a new session must start at lastSeq 0");
    if (s.fenceToken !== 0) throw new Error("a new session must start at fenceToken 0");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.lockActiveSubjectGate(conn, s.tenantId, s.userId, s.createdAtMs);
      if (s.parentSessionId) {
        // Serialize child creation with parent tombstoning. Host preflight is only an early error;
        // this locked re-check is the authority that prevents a dangling child under a deleted row.
        const [parentRows] = await conn.query<Row[]>(
          `SELECT tenant_id, user_id, deleted_at_ms
             FROM sessions WHERE session_id=? FOR UPDATE`,
          [s.parentSessionId],
        );
        const parent = parentRows[0];
        if (
          !parent
          || parent.deleted_at_ms != null
          || parent.tenant_id !== s.tenantId
          || parent.user_id !== s.userId
        ) {
          throw new SessionGoneError(s.parentSessionId);
        }
      }
      const initialUsage = normalizeRowlessUsageProjection(s.usage);
      try {
        await conn.query(
          `INSERT INTO sessions (session_id, tenant_id, user_id, agent_id, agent_version, status, title, parent_session_id,
             last_seq, fence_token, context_epoch, usage_json, auto_approved_tools, metadata, created_at_ms, updated_at_ms, archived_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            s.id, s.tenantId, s.userId, s.agentId, s.agentVersion, json(s.status), s.title ?? null, s.parentSessionId ?? null,
            1, s.fenceToken, s.contextEpoch, json(initialUsage), json(s.autoApprovedTools), json(s.metadata), s.createdAtMs, s.updatedAtMs, s.archivedAtMs ?? null,
          ],
        );
      } catch (err) {
        // Only a collision on the session row has SessionExists semantics. A later duplicate/error
        // while inserting the event must retain its database identity for diagnosis after rollback.
        if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw new SessionExistsError(s.id);
        throw err;
      }
      const event: PersistedEvent = {
        type: "session/created",
        sessionId: s.id,
        emittedAtMs: s.createdAtMs,
        seq: 1,
      };
      await conn.query(
        "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES (?,?,?,?,?,?)",
        [s.id, event.seq, s.userId, event.type, json(event), event.emittedAtMs],
      );
      await conn.commit();
      return { events: [event], lastSeq: 1 };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  async getSession(tenantId: string, sessionId: string) {
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE s.session_id=? AND s.tenant_id=? AND s.deleted_at_ms IS NULL`,
        [sessionId, tenantId],
      );
      if (!rows[0]) return null;
      const session = rowToSession(rows[0]);
      const summaries = await this.loadSessionUsageSummaries(conn, [session.id]);
      return this.projectSessionUsage(session, summaries.get(session.id));
    });
  }
  async getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null> {
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s
          WHERE s.session_id=? AND s.tenant_id=? AND s.user_id=?`,
        [sessionId, tenantId, userId],
      );
      const row = rows[0];
      if (!row) return null;
      const session = rowToSession(row);
      const summaries = await this.loadSessionUsageSummaries(conn, [session.id]);
      return {
        session: this.projectSessionUsage(session, summaries.get(session.id)),
        deletedAtMs: row.deleted_at_ms == null ? undefined : Number(row.deleted_at_ms),
        purgeAfterMs: row.purge_after_ms == null ? undefined : Number(row.purge_after_ms),
        deletionGeneration: Number(row.deletion_generation),
      };
    });
  }

  private async lockErasureResolution(
    conn: PoolConnection,
    sessionId: string,
    userId: string,
    atMs: number,
    turnId?: string,
  ): Promise<{ approvals: Approval[]; items: Item[] }> {
    const itemParams: unknown[] = [sessionId];
    const itemTurn = turnId === undefined ? "" : " AND turn_id=?";
    if (turnId !== undefined) itemParams.push(turnId);
    const [itemRows] = await conn.query<Row[]>(
      `SELECT item_id, session_id, user_id, turn_id, type, status, body
         FROM items
        WHERE session_id=?${itemTurn} AND type='approvalRequest' AND status='inProgress'
        ORDER BY item_id FOR UPDATE`,
      itemParams,
    );
    const existingItems = itemRows.map((row) => {
      const item = ItemSchema.parse(parse<unknown>(row.body));
      if (
        item.type !== "approvalRequest"
        || item.id !== row.item_id
        || item.sessionId !== sessionId
        || item.sessionId !== row.session_id
        || item.turnId !== row.turn_id
        || item.status !== "inProgress"
        || row.status !== "inProgress"
        || row.type !== "approvalRequest"
        || row.user_id !== userId
      ) throw new Error("stored erasure approval item identity is corrupt");
      return item;
    });

    const approvalParams: unknown[] = [sessionId];
    const approvalTurn = turnId === undefined ? "" : " AND turn_id=?";
    if (turnId !== undefined) approvalParams.push(turnId);
    const [approvalRows] = await conn.query<Row[]>(
      `SELECT approval_id, session_id, user_id, turn_id, status, body
         FROM approvals
        WHERE session_id=?${approvalTurn} AND status='pending'
        ORDER BY approval_id FOR UPDATE`,
      approvalParams,
    );
    const existingApprovals = approvalRows.map((row) => {
      const approval = ApprovalSchema.parse(parse<unknown>(row.body));
      if (
        approval.id !== row.approval_id
        || approval.sessionId !== sessionId
        || approval.sessionId !== row.session_id
        || approval.turnId !== row.turn_id
        || approval.status !== "pending"
        || row.status !== "pending"
        || row.user_id !== userId
      ) throw new Error("stored erasure approval identity is corrupt");
      return approval;
    });

    const approvalsById = new Map(existingApprovals.map((approval) => [approval.id, approval]));
    const itemsByApproval = new Map<string, Extract<Item, { type: "approvalRequest" }>>();
    for (const item of existingItems) {
      const approval = approvalsById.get(item.approvalId);
      if (
        !approval
        || itemsByApproval.has(item.approvalId)
        || approval.turnId !== item.turnId
        || approval.toolCallId !== item.toolCallId
        || approval.toolName !== item.name
      ) throw new Error("stored erasure approval association is corrupt");
      itemsByApproval.set(item.approvalId, item);
    }
    if (itemsByApproval.size !== existingApprovals.length) {
      throw new Error("stored erasure approval item is missing");
    }

    const approvals: Approval[] = existingApprovals.map((approval) => ApprovalSchema.parse({
      ...approval,
      status: "expired",
      decision: "cancel",
      decidedBy: "system:erasure",
      resolvedAtMs: atMs,
    }));
    const items: Item[] = approvals.map((approval) => {
      const item = itemsByApproval.get(approval.id)!;
      return ItemSchema.parse({ ...item, status: "declined", completedAtMs: atMs });
    });
    return { approvals, items };
  }

  async getErasureSessionHead(
    authorization: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<ErasureSessionHead | null> {
    validateErasureWriteAuthorization(authorization);
    if (!isCanonicalId("sess", sessionId)) throw new Error("invalid erasure session id");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // The owner prefix must drive this locking read. A primary-key lookup followed by an owner
      // predicate may lock a different user's row before MySQL rejects it at the SQL filter.
      const [rows] = await conn.query<Row[]>(
        `SELECT session_id, tenant_id, user_id, status, deleted_at_ms, deletion_generation
           FROM sessions FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? AND session_id=? FOR SHARE`,
        [authorization.tenantId, authorization.userId, sessionId],
      );
      await this.lockErasureSessionAuthority(conn, authorization, ["draining", "tombstoning"]);
      const row = rows[0];
      if (!row) {
        await conn.commit();
        return null;
      }
      const status = SessionStatusSchema.parse(parse<unknown>(row.status));
      const generation = Number(row.deletion_generation);
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error("stored session deletion generation is invalid");
      }
      const head: ErasureSessionHead = {
        sessionId,
        tenantId: authorization.tenantId,
        userId: authorization.userId,
        ...(status.type === "active" ? { activeTurnId: status.turnId } : {}),
        deleted: row.deleted_at_ms != null,
        deletionGeneration: generation,
      };
      await conn.commit();
      return head;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private erasureTombstoneMarker(
    deletedAtMs: unknown,
    purgeAfterMs: unknown,
    lastSeqValue: unknown,
    generationValue: unknown,
  ): { deletedAtMs: number; lastSeq: number; generation: number } {
    const deletedAt = Number(deletedAtMs);
    const lastSeq = Number(lastSeqValue);
    const generation = Number(generationValue);
    if (
      !Number.isSafeInteger(deletedAt)
      || deletedAt < 0
      || !Number.isSafeInteger(lastSeq)
      || lastSeq <= 0
      || !Number.isSafeInteger(generation)
      || generation <= 0
      || purgeAfterMs != null
    ) throw new Error("erasure tombstone marker is corrupt");
    return { deletedAtMs: deletedAt, lastSeq, generation };
  }

  private async loadErasureTombstoneProofRows(
    conn: PoolConnection,
    sessionId: string,
    lastSeq: number,
    generation: number,
  ): Promise<{ eventRows: Row[]; outboxRows: Row[] }> {
    const [eventRows] = await conn.query<Row[]>(
      `SELECT session_id, seq, user_id, type, body, emitted_at_ms
         FROM events
        WHERE session_id=? AND seq=? FOR SHARE`,
      [sessionId, lastSeq],
    );
    const [outboxRows] = await conn.query<Row[]>(
      `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts,
              claim_token, lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
         FROM lifecycle_outbox FORCE INDEX (uk_lifecycle_outbox_identity)
        WHERE aggregate_id=? AND generation=?
          AND topic IN ('session.purge', 'session.tombstoned')
        ORDER BY topic FOR SHARE`,
      [sessionId, generation],
    );
    return { eventRows, outboxRows };
  }

  private assertErasureTombstoneProofRows(
    sessionId: string,
    userId: string,
    marker: { deletedAtMs: number; lastSeq: number; generation: number },
    eventRows: Row[],
    outboxRows: Row[],
  ): void {
    const { deletedAtMs, lastSeq, generation } = marker;
    const eventRow = eventRows[0];
    let event: ReturnType<typeof EventSchema.safeParse> | undefined;
    try {
      event = eventRow ? EventSchema.safeParse(parse<unknown>(eventRow.body)) : undefined;
    } catch {
      throw new Error("erasure tombstone event is corrupt");
    }
    if (
      eventRows.length !== 1
      || !eventRow
      || !event?.success
      || eventRow.session_id !== sessionId
      || Number(eventRow.seq) !== lastSeq
      || eventRow.user_id !== userId
      || eventRow.type !== "session/deleted"
      || Number(eventRow.emitted_at_ms) !== deletedAtMs
      || event.data.type !== "session/deleted"
      || event.data.sessionId !== sessionId
      || event.data.seq !== lastSeq
      || event.data.emittedAtMs !== deletedAtMs
      || event.data.deletionGeneration !== generation
    ) throw new Error("erasure tombstone event is corrupt");

    if (outboxRows.length !== 2) throw new Error("erasure tombstone outbox is missing");
    let outboxes: LifecycleOutboxRecord[];
    try {
      outboxes = outboxRows.map(rowToLifecycleOutbox);
    } catch {
      throw new Error("erasure tombstone outbox is corrupt");
    }
    const tombstoned = outboxes.find((row) => row.topic === "session.tombstoned");
    const purge = outboxes.find((row) => row.topic === "session.purge");
    if (
      new Set(outboxes.map((row) => row.outboxId)).size !== 2
      || !tombstoned
      || tombstoned.aggregateId !== sessionId
      || tombstoned.generation !== generation
      || tombstoned.payload.sessionId !== sessionId
      || tombstoned.payload.deletionGeneration !== generation
      || tombstoned.payload.eventSeq !== lastSeq
      || tombstoned.deadLetteredAtMs !== undefined
      || !purge
      || purge.aggregateId !== sessionId
      || purge.generation !== generation
      || purge.payload.sessionId !== sessionId
      || purge.payload.deletionGeneration !== generation
      || purge.availableAtMs !== undefined
      || purge.attempts !== 0
      || purge.claimToken !== undefined
      || purge.leaseUntilMs !== undefined
      || purge.lastError !== undefined
      || purge.completedAtMs !== undefined
      || purge.deadLetteredAtMs !== undefined
    ) throw new Error("erasure tombstone outbox is corrupt");
  }

  private async assertExistingErasureSessionTombstone(
    conn: PoolConnection,
    sessionId: string,
    userId: string,
    deletedAtMs: unknown,
    purgeAfterMs: unknown,
    lastSeqValue: unknown,
    generationValue: unknown,
  ): Promise<{ lastSeq: number; generation: number }> {
    const marker = this.erasureTombstoneMarker(
      deletedAtMs,
      purgeAfterMs,
      lastSeqValue,
      generationValue,
    );
    const rows = await this.loadErasureTombstoneProofRows(
      conn,
      sessionId,
      marker.lastSeq,
      marker.generation,
    );
    this.assertErasureTombstoneProofRows(sessionId, userId, marker, rows.eventRows, rows.outboxRows);
    return { lastSeq: marker.lastSeq, generation: marker.generation };
  }

  private async erasureTombstoneProofValid(
    conn: PoolConnection,
    sessionId: string,
    userId: string,
    deletedAtMs: unknown,
    purgeAfterMs: unknown,
    lastSeqValue: unknown,
    generationValue: unknown,
  ): Promise<boolean> {
    let marker: { deletedAtMs: number; lastSeq: number; generation: number };
    try {
      marker = this.erasureTombstoneMarker(
        deletedAtMs,
        purgeAfterMs,
        lastSeqValue,
        generationValue,
      );
    } catch {
      return false;
    }
    // Query failures deliberately escape so the worker retries. Only deterministic validation of
    // rows already read from MySQL is collapsed to the content-free invalid-proof bit.
    const rows = await this.loadErasureTombstoneProofRows(
      conn,
      sessionId,
      marker.lastSeq,
      marker.generation,
    );
    try {
      this.assertErasureTombstoneProofRows(sessionId, userId, marker, rows.eventRows, rows.outboxRows);
      return true;
    } catch {
      return false;
    }
  }

  async applyErasureSessionAction(input: ErasureSessionAction): Promise<CommitResult> {
    // Snapshot the complete capability before the first await. In particular, a caller cannot
    // mutate session/owner identity while this transaction is waiting for the session row lock.
    const stagedInput = structuredClone(input);
    validateErasureSessionAction(stagedInput);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // Preserve session -> authority lock order while ensuring a forged/cross-owner session id
      // cannot lock the real owner's row.
      const [rows] = await conn.query<Row[]>(
        `SELECT session_id, tenant_id, user_id, status, last_seq, fence_token, updated_at_ms,
                deleted_at_ms, purge_after_ms, deletion_generation
           FROM sessions FORCE INDEX (idx_sessions_tenant_user)
          WHERE tenant_id=? AND user_id=? AND session_id=? FOR UPDATE`,
        [stagedInput.authority.tenantId, stagedInput.authority.userId, stagedInput.sessionId],
      );
      await this.lockErasureSessionAuthority(
        conn,
        stagedInput.authority,
        stagedInput.action === "fence" ? ["draining", "tombstoning"] : ["tombstoning"],
      );
      const head = rows[0];
      if (!head) throw new SessionGoneError(stagedInput.sessionId);
      const currentFence = Number(head.fence_token);
      const currentLastSeq = Number(head.last_seq);
      const currentGeneration = Number(head.deletion_generation);
      if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) {
        throw new Error("stored session deletion generation is invalid");
      }
      if (
        head.deleted_at_ms == null
        && (currentGeneration !== 0 || head.purge_after_ms != null)
      ) {
        throw new Error("stored live session tombstone marker is corrupt");
      }
      if (stagedInput.fence < currentFence) {
        throw new FenceError(stagedInput.sessionId, stagedInput.fence, currentFence);
      }

      if (head.deleted_at_ms != null) {
        if (stagedInput.action !== "tombstone") throw new SessionGoneError(stagedInput.sessionId);
        const existing = await this.assertExistingErasureSessionTombstone(
          conn,
          stagedInput.sessionId,
          stagedInput.authority.userId,
          head.deleted_at_ms,
          head.purge_after_ms,
          head.last_seq,
          head.deletion_generation,
        );
        await conn.commit();
        return { events: [], lastSeq: existing.lastSeq, lifecycleGeneration: existing.generation };
      }

      if (stagedInput.action === "fence") {
        await conn.query(
          "UPDATE sessions SET fence_token=? WHERE session_id=?",
          [stagedInput.fence, stagedInput.sessionId],
        );
        await conn.commit();
        return { events: [], lastSeq: currentLastSeq };
      }

      const status = SessionStatusSchema.parse(parse<unknown>(head.status));
      const effectiveAtMs = Math.max(stagedInput.atMs, Number(head.updated_at_ms));
      if (stagedInput.action === "settle") {
        if (status.type !== "active") {
          await conn.query(
            "UPDATE sessions SET fence_token=? WHERE session_id=?",
            [stagedInput.fence, stagedInput.sessionId],
          );
          await conn.commit();
          return { events: [], lastSeq: currentLastSeq };
        }

        const [turnRows] = await conn.query<Row[]>(
          `SELECT turn_id, session_id, user_id, status, body
             FROM turns WHERE turn_id=? FOR UPDATE`,
          [status.turnId],
        );
        const turnRow = turnRows[0];
        if (!turnRow) throw new Error("active erasure turn is missing");
        const existingTurn = TurnSchema.parse(parse<unknown>(turnRow.body));
        if (
          existingTurn.id !== status.turnId
          || existingTurn.sessionId !== stagedInput.sessionId
          || existingTurn.sessionId !== turnRow.session_id
          || existingTurn.status !== "inProgress"
          || turnRow.status !== "inProgress"
          || turnRow.user_id !== stagedInput.authority.userId
        ) throw new Error("active erasure turn identity is corrupt");

        const atMs = Math.max(effectiveAtMs, existingTurn.startedAtMs);
        const resolution = await this.lockErasureResolution(
          conn,
          stagedInput.sessionId,
          stagedInput.authority.userId,
          atMs,
          existingTurn.id,
        );
        const resolutionEvents: EventInput[] = [];
        for (const approval of resolution.approvals) {
          resolutionEvents.push({
            type: "approval/resolved",
            sessionId: stagedInput.sessionId,
            emittedAtMs: atMs,
            approval,
          });
          const item = resolution.items.find((candidate) => (
            candidate.type === "approvalRequest" && candidate.approvalId === approval.id
          ))!;
          resolutionEvents.push({
            type: "item/completed",
            sessionId: stagedInput.sessionId,
            emittedAtMs: atMs,
            item,
          });
        }
        const finalSeq = currentLastSeq + resolutionEvents.length + 2;
        const turn = TurnSchema.parse({
          ...existingTurn,
          status: "interrupted",
          stopReason: "interrupted",
          seqEnd: finalSeq,
          completedAtMs: atMs,
          error: { code: "erasure", message: "turn interrupted for user erasure" },
        });
        const inputs: EventInput[] = [
          ...resolutionEvents,
          {
            type: "turn/completed",
            sessionId: stagedInput.sessionId,
            emittedAtMs: atMs,
            turn,
            stopReason: "interrupted",
          },
          {
            type: "session/status/changed",
            sessionId: stagedInput.sessionId,
            emittedAtMs: atMs,
            status: { type: "idle" },
          },
        ];
        let seq = currentLastSeq;
        const events = inputs.map((event) => ({ ...event, seq: ++seq } as PersistedEvent));
        const serializedEvents = events.map((event) => json(event));
        const serializedItems = resolution.items.map((item) => json(item));
        const serializedApprovals = resolution.approvals.map((approval) => json(approval));
        const serializedTurn = json(turn);
        const serializedIdle = json({ type: "idle" });

        for (const [index, item] of resolution.items.entries()) {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE items SET status='declined', body=?, completed_at_ms=?
              WHERE item_id=? AND session_id=? AND user_id=?
                AND type='approvalRequest' AND status='inProgress'`,
            [serializedItems[index], atMs, item.id, stagedInput.sessionId, stagedInput.authority.userId],
          );
          if (updated.affectedRows !== 1) throw new Error("erasure approval item changed while locked");
        }
        for (const [index, approval] of resolution.approvals.entries()) {
          const [updated] = await conn.query<mysql.ResultSetHeader>(
            `UPDATE approvals SET status='expired', body=?
              WHERE approval_id=? AND session_id=? AND user_id=? AND status='pending'`,
            [serializedApprovals[index], approval.id, stagedInput.sessionId, stagedInput.authority.userId],
          );
          if (updated.affectedRows !== 1) throw new Error("erasure approval changed while locked");
        }
        const [turnUpdated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE turns SET status='interrupted', stop_reason='interrupted', seq_end=?, body=?, completed_at_ms=?
            WHERE turn_id=? AND session_id=? AND user_id=? AND status='inProgress'`,
          [finalSeq, serializedTurn, atMs, turn.id, stagedInput.sessionId, stagedInput.authority.userId],
        );
        if (turnUpdated.affectedRows !== 1) throw new Error("erasure turn changed while locked");
        await conn.query(
          "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
          [events.map((event, index) => [
            stagedInput.sessionId,
            event.seq,
            stagedInput.authority.userId,
            event.type,
            serializedEvents[index],
            event.emittedAtMs,
          ])],
        );
        await conn.query(
          `UPDATE sessions
              SET status=?, last_seq=?, fence_token=?, updated_at_ms=?
            WHERE session_id=?`,
          [serializedIdle, finalSeq, stagedInput.fence, atMs, stagedInput.sessionId],
        );
        await conn.commit();
        return { events, lastSeq: finalSeq };
      }

      if (status.type === "active") throw new SessionLifecycleBusyError(stagedInput.sessionId);
      const [children] = await conn.query<Row[]>(
        "SELECT session_id FROM sessions WHERE parent_session_id=? AND deleted_at_ms IS NULL LIMIT 1 FOR SHARE",
        [stagedInput.sessionId],
      );
      if (children.length) throw new SessionHasChildrenError(stagedInput.sessionId);

      const atMs = effectiveAtMs;
      const resolution = await this.lockErasureResolution(
        conn,
        stagedInput.sessionId,
        stagedInput.authority.userId,
        atMs,
      );
      const inputs: EventInput[] = [];
      for (const approval of resolution.approvals) {
        inputs.push({
          type: "approval/resolved",
          sessionId: stagedInput.sessionId,
          emittedAtMs: atMs,
          approval,
        });
        const item = resolution.items.find((candidate) => (
          candidate.type === "approvalRequest" && candidate.approvalId === approval.id
        ))!;
        inputs.push({ type: "item/completed", sessionId: stagedInput.sessionId, emittedAtMs: atMs, item });
      }
      const deletionGeneration = currentGeneration + 1;
      inputs.push({
        type: "session/deleted",
        sessionId: stagedInput.sessionId,
        emittedAtMs: atMs,
        deletionGeneration,
      });
      let seq = currentLastSeq;
      const events = inputs.map((event) => ({ ...event, seq: ++seq } as PersistedEvent));
      const serializedEvents = events.map((event) => json(event));
      const serializedItems = resolution.items.map((item) => json(item));
      const serializedApprovals = resolution.approvals.map((approval) => json(approval));
      const tombstonedPayload = json({
        sessionId: stagedInput.sessionId,
        deletionGeneration,
        eventSeq: seq,
      });
      const purgePayload = json({ sessionId: stagedInput.sessionId, deletionGeneration });
      const clearedAutoApprovals = json([]);

      for (const [index, item] of resolution.items.entries()) {
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE items SET status='declined', body=?, completed_at_ms=?
            WHERE item_id=? AND session_id=? AND user_id=?
              AND type='approvalRequest' AND status='inProgress'`,
          [serializedItems[index], atMs, item.id, stagedInput.sessionId, stagedInput.authority.userId],
        );
        if (updated.affectedRows !== 1) throw new Error("erasure approval item changed while locked");
      }
      for (const [index, approval] of resolution.approvals.entries()) {
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE approvals SET status='expired', body=?
            WHERE approval_id=? AND session_id=? AND user_id=? AND status='pending'`,
          [serializedApprovals[index], approval.id, stagedInput.sessionId, stagedInput.authority.userId],
        );
        if (updated.affectedRows !== 1) throw new Error("erasure approval changed while locked");
      }
      await conn.query(
        "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
        [events.map((event, index) => [
          stagedInput.sessionId,
          event.seq,
          stagedInput.authority.userId,
          event.type,
          serializedEvents[index],
          event.emittedAtMs,
        ])],
      );
      await conn.query(
        `INSERT INTO lifecycle_outbox
           (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
         VALUES ?`,
        [[
          ["session.tombstoned", stagedInput.sessionId, deletionGeneration, tombstonedPayload, atMs, 0, atMs],
          ["session.purge", stagedInput.sessionId, deletionGeneration, purgePayload, null, 0, atMs],
        ]],
      );
      await conn.query(
        `UPDATE sessions
            SET last_seq=?, fence_token=?, auto_approved_tools=?, updated_at_ms=?,
                deleted_at_ms=?, purge_after_ms=NULL, deletion_generation=?
          WHERE session_id=?`,
        [seq, stagedInput.fence, clearedAutoApprovals, atMs, atMs, deletionGeneration, stagedInput.sessionId],
      );
      await conn.commit();
      return { events, lastSeq: seq, lifecycleGeneration: deletionGeneration };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private async withErasureCatalogRead<T>(
    authorization: ErasureWriteAuthorization,
    phase: ErasureSessionQuery["phase"],
    nowMs: number,
    work: (conn: PoolConnection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      // These worker reads hold only the coarse authority rows. The session/usage scans below use
      // statement snapshots and never lock a whole subject batch, so ordinary row-level lifecycle
      // work is not serialized behind a long cursor scan.
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      await this.lockErasureSessionAuthority(conn, authorization, [phase], nowMs);
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async listErasureSessions(
    authorization: ErasureWriteAuthorization,
    query: ErasureSessionQuery,
  ): Promise<ErasureSessionPage> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedQuery = structuredClone(query);
    validateErasureSessionQuery(stagedAuthorization, stagedQuery);
    return this.withErasureCatalogRead(
      stagedAuthorization,
      stagedQuery.phase,
      stagedQuery.nowMs,
      async (conn) => {
      const where = ["s.tenant_id=?", "s.user_id=?"];
      const params: unknown[] = [stagedAuthorization.tenantId, stagedAuthorization.userId];
      if (stagedQuery.phase === "reconciling_usage") {
        where.push("s.deleted_at_ms IS NOT NULL");
      } else {
        where.push("s.deleted_at_ms IS NULL");
      }
      if (stagedQuery.phase === "tombstoning") {
        // The child check deliberately has no owner predicate. A corrupt/imported cross-owner
        // live child must block its parent instead of being hidden and turned into a dangling row.
        where.push(`NOT EXISTS (
          SELECT 1 FROM sessions child
           WHERE child.parent_session_id=s.session_id AND child.deleted_at_ms IS NULL
        )`);
      }
      if (stagedQuery.afterSessionId !== undefined) {
        where.push("s.session_id>?");
        params.push(stagedQuery.afterSessionId);
      }
      params.push(stagedQuery.limit + 1);
      const [rows] = await conn.query<Row[]>(
        `SELECT s.session_id, s.parent_session_id, s.user_id, s.last_seq,
                s.deleted_at_ms, s.purge_after_ms, s.deletion_generation
           FROM sessions s
          WHERE ${where.join(" AND ")}
          ORDER BY s.session_id ASC
          LIMIT ?`,
        params,
      );
      const pageRows = rows.slice(0, stagedQuery.limit);
      const data: ErasureSessionRef[] = [];
      for (const row of pageRows) {
        const ref = rowToErasureSessionRef(row);
        if (stagedQuery.phase === "reconciling_usage") {
          ref.tombstoneProofValid = ref.deletionGeneration > 0
            && String(row.user_id) === stagedAuthorization.userId
            && await this.erasureTombstoneProofValid(
              conn,
              ref.sessionId,
              stagedAuthorization.userId,
              row.deleted_at_ms,
              row.purge_after_ms,
              row.last_seq,
              row.deletion_generation,
            );
        }
        data.push(ref);
      }
      const nextCursor = rows.length > stagedQuery.limit ? data.at(-1)?.sessionId : undefined;
      return {
        data,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      },
    );
  }

  async inspectErasureSubjectProgress(
    authorization: ErasureWriteAuthorization,
    query: ErasureProgressQuery,
  ): Promise<ErasureSubjectProgress> {
    const stagedAuthorization = structuredClone(authorization);
    const stagedQuery = structuredClone(query);
    validateErasureProgressQuery(stagedAuthorization, stagedQuery);
    return this.withErasureCatalogRead(
      stagedAuthorization,
      stagedQuery.phase,
      stagedQuery.nowMs,
      async (conn) => {
      // Keep all counters in one READ COMMITTED statement snapshot. In particular, reconciliation
      // cannot move between two queries and yield a proof assembled from different database states.
      const owner = [stagedAuthorization.tenantId, stagedAuthorization.userId];
      const [rows] = await conn.query<Row[]>(
        `SELECT
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=?) AS total_sessions,
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NULL) AS live_sessions,
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM sessions child
                 WHERE child.parent_session_id=s.session_id AND child.deleted_at_ms IS NULL
              )) AS live_leaf_sessions,
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NOT NULL) AS tombstoned_sessions,
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NOT NULL
              AND s.deletion_generation=0) AS legacy_generation_zero_sessions,
          (SELECT COUNT(*) FROM sessions s
             JOIN usage_reconciliations r
               ON r.session_id=s.session_id
              AND r.deletion_generation=s.deletion_generation
              AND r.tenant_id=s.tenant_id
              AND r.user_id=s.user_id
              AND r.status IN ('verified','anonymized')
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NOT NULL
              AND s.deletion_generation>0) AS reconciled_usage_sessions,
          (SELECT COUNT(*) FROM sessions s
            WHERE s.tenant_id=? AND s.user_id=? AND s.deleted_at_ms IS NOT NULL
              AND s.deletion_generation>0
              AND NOT EXISTS (
                SELECT 1 FROM usage_reconciliations r
                 WHERE r.session_id=s.session_id
                   AND r.deletion_generation=s.deletion_generation
                   AND r.tenant_id=s.tenant_id
                   AND r.user_id=s.user_id
                   AND r.status IN ('verified','anonymized')
              )) AS unreconciled_usage_sessions,
          ((SELECT COUNT(*) FROM usage_ledger u
              LEFT JOIN sessions owner_session ON owner_session.session_id=u.session_id
             WHERE u.tenant_id=? AND u.user_id=?
               AND (owner_session.session_id IS NULL
                 OR owner_session.tenant_id<>u.tenant_id
                 OR owner_session.user_id<>u.user_id))
           +
           (SELECT COUNT(*) FROM sessions owner_session
              JOIN usage_ledger u ON u.session_id=owner_session.session_id
             WHERE owner_session.tenant_id=? AND owner_session.user_id=?
               AND (u.tenant_id<>? OR u.user_id<>?))) AS orphan_or_mismatched_usage_rows`,
        [
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
          ...owner,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("erasure progress query returned no row");
      return {
        totalSessions: erasureProgressCount(row, "total_sessions"),
        liveSessions: erasureProgressCount(row, "live_sessions"),
        liveLeafSessions: erasureProgressCount(row, "live_leaf_sessions"),
        tombstonedSessions: erasureProgressCount(row, "tombstoned_sessions"),
        legacyGenerationZeroSessions: erasureProgressCount(row, "legacy_generation_zero_sessions"),
        reconciledUsageSessions: erasureProgressCount(row, "reconciled_usage_sessions"),
        unreconciledUsageSessions: erasureProgressCount(row, "unreconciled_usage_sessions"),
        orphanOrMismatchedUsageRows: erasureProgressCount(row, "orphan_or_mismatched_usage_rows"),
      };
      },
    );
  }

  async listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }): Promise<Page<Session>> {
    return this.withConsistentRead(async (conn) => {
      const where = ["s.tenant_id=?", "s.deleted_at_ms IS NULL"];
      const params: unknown[] = [tenantId];
      if (opts.userId) { where.push("s.user_id=?"); params.push(opts.userId); }
      if (!opts.includeArchived) where.push("s.archived_at_ms IS NULL");
      if (opts.cursor) { where.push("s.session_id < ?"); params.push(opts.cursor); }
      params.push(opts.limit + 1);
      const [rows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE ${where.join(" AND ")} ORDER BY s.session_id DESC LIMIT ?`,
        params,
      );
      const pageRows = rows.slice(0, opts.limit);
      const sessions = pageRows.map(rowToSession);
      const summaries = await this.loadSessionUsageSummaries(conn, sessions.map((session) => session.id));
      const data = sessions.map((session) => this.projectSessionUsage(session, summaries.get(session.id)));
      return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
    });
  }

  // ---------- blob ownership manifest ----------
  async stageBlob(input: StageBlobInput): Promise<void> {
    validateStageBlobInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [sessions] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, fence_token, archived_at_ms, deleted_at_ms
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessions[0];
      if (
        !session
        || session.deleted_at_ms != null
        || session.tenant_id !== input.owner.tenantId
        || session.user_id !== input.owner.userId
      ) throw new SessionGoneError(input.sessionId);
      await this.lockActiveSubjectGate(
        conn,
        input.owner.tenantId,
        input.owner.userId,
        Date.now(),
        input.sessionId,
      );
      if (session.archived_at_ms != null) throw new SessionArchivedError(input.sessionId);
      const currentFence = Number(session.fence_token);
      if (input.fence < currentFence) throw new FenceError(input.sessionId, input.fence, currentFence);

      const [existingRows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=? FOR UPDATE`,
        [input.blobId],
      );
      const existing = existingRows[0] ? rowToBlobManifest(existingRows[0]) : undefined;
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
        await conn.query(
          `INSERT INTO blob_objects
             (blob_id, tenant_id, user_id, session_id, item_id, purpose, storage_backend, storage_format,
              storage_key, upload_token, state, created_at_ms, staging_expires_at_ms, deletion_generation)
           VALUES (?,?,?,?,NULL,?,?,?,?,?,'staging',?,?,0)`,
          [
            input.blobId,
            input.owner.tenantId,
            input.owner.userId,
            input.sessionId,
            input.purpose,
            input.storageBackend,
            input.storageFormat,
            input.storageKey,
            input.uploadToken,
            input.createdAtMs,
            input.stagingExpiresAtMs,
          ],
        );
      }
      if (input.fence > currentFence) {
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [input.fence, input.sessionId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async markBlobUploaded(input: MarkBlobUploadedInput): Promise<void> {
    validateUploadedBlobInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [sessions] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, fence_token, archived_at_ms, deleted_at_ms
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [input.sessionId],
      );
      const session = sessions[0];
      if (
        !session
        || session.deleted_at_ms != null
        || session.tenant_id !== input.owner.tenantId
        || session.user_id !== input.owner.userId
      ) throw new SessionGoneError(input.sessionId);
      await this.lockActiveSubjectGate(
        conn,
        input.owner.tenantId,
        input.owner.userId,
        Date.now(),
        input.sessionId,
      );
      if (session.archived_at_ms != null) throw new SessionArchivedError(input.sessionId);
      const currentFence = Number(session.fence_token);
      if (input.fence < currentFence) throw new FenceError(input.sessionId, input.fence, currentFence);
      const [rows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=? FOR UPDATE`,
        [input.blobId],
      );
      const manifest = rows[0] ? rowToBlobManifest(rows[0]) : undefined;
      if (
        !manifest
        || manifest.state !== "staging"
        || manifest.tenantId !== input.owner.tenantId
        || manifest.userId !== input.owner.userId
        || manifest.sessionId !== input.sessionId
        || manifest.uploadToken !== input.uploadToken
      ) throw new BlobStateError(input.blobId);
      if (manifest.uploadedAtMs !== undefined) {
        if (
          manifest.sha256 !== input.sha256
          || manifest.sizeBytes !== input.sizeBytes
          || manifest.contentType !== input.contentType
        ) throw new BlobStateError(input.blobId, "uploaded blob descriptor does not match");
      } else {
        await conn.query(
          `UPDATE blob_objects
              SET sha256=UNHEX(?), size_bytes=?, content_type=?, uploaded_at_ms=?
            WHERE blob_id=? AND state='staging' AND upload_token=?`,
          [input.sha256, input.sizeBytes, input.contentType ?? null, input.uploadedAtMs, input.blobId, input.uploadToken],
        );
      }
      if (input.fence > currentFence) {
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [input.fence, input.sessionId]);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getBlobManifest(blobId: string): Promise<BlobManifest | null> {
    const [rows] = await this.pool.query<Row[]>(`SELECT ${BLOB_COLUMNS} FROM blob_objects WHERE blob_id=?`, [blobId]);
    return rows[0] ? rowToBlobManifest(rows[0]) : null;
  }

  async getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${QUALIFIED_BLOB_COLUMNS}
         FROM blob_objects b
         JOIN sessions s ON s.session_id=b.session_id AND s.tenant_id=b.tenant_id AND s.user_id=b.user_id
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
        WHERE b.blob_id=? AND b.tenant_id=? AND b.user_id=? AND b.session_id=? AND b.purpose=?
          AND b.state='staging' AND b.item_id IS NULL AND b.uploaded_at_ms IS NOT NULL
          AND b.sha256 IS NOT NULL AND b.size_bytes IS NOT NULL
          AND s.deleted_at_ms IS NULL AND s.archived_at_ms IS NULL`,
      [input.blobId, input.owner.tenantId, input.owner.userId, input.sessionId, input.purpose],
    );
    const manifest = rows[0] ? rowToBlobManifest(rows[0]) : null;
    return manifest && isUnexpiredStagingBlob(manifest, Date.now()) ? manifest : null;
  }

  async getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null> {
    const where = [
      "b.blob_id=?",
      "b.tenant_id=?",
      "b.user_id=?",
      "b.session_id=?",
      "b.state='ready'",
      "s.deleted_at_ms IS NULL",
      "i.item_id=b.item_id",
      "i.session_id=b.session_id",
      "i.user_id=b.user_id",
    ];
    const params: unknown[] = [input.blobId, input.owner.tenantId, input.owner.userId, input.sessionId];
    if (input.itemId) { where.push("b.item_id=?"); params.push(input.itemId); }
    if (input.purpose) { where.push("b.purpose=?"); params.push(input.purpose); }
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${QUALIFIED_BLOB_COLUMNS}
         FROM blob_objects b
         JOIN sessions s ON s.session_id=b.session_id AND s.tenant_id=b.tenant_id AND s.user_id=b.user_id
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
         JOIN items i ON i.item_id=b.item_id
        WHERE ${where.join(" AND ")}`,
      params,
    );
    return rows[0] ? rowToBlobManifest(rows[0]) : null;
  }

  private async lockBlobBindings(
    conn: PoolConnection,
    bindings: readonly BlobBinding[],
    owner: { tenantId: string; userId: string },
    sessionId: string,
  ): Promise<{ blobIds: string[]; readyAtMs: number }> {
    if (bindings.length === 0) return { blobIds: [], readyAtMs: Date.now() };
    const sorted = [...bindings].sort((left, right) => left.blobId.localeCompare(right.blobId));
    const placeholders = sorted.map(() => "?").join(",");
    const [rows] = await conn.query<Row[]>(
      `SELECT ${BLOB_COLUMNS} FROM blob_objects
        WHERE blob_id IN (${placeholders}) ORDER BY blob_id FOR UPDATE`,
      sorted.map((binding) => binding.blobId),
    );
    const manifests = new Map(rows.map((row) => {
      const manifest = rowToBlobManifest(row);
      return [manifest.blobId, manifest] as const;
    }));
    // Evaluate the hard staging deadline only after all selected manifest rows are locked. A
    // transaction that waited behind the sweeper (or another binder) cannot use a stale timestamp
    // captured before lock acquisition to resurrect an expired object.
    const readyAtMs = Date.now();
    const toReady: string[] = [];
    for (const binding of sorted) {
      const manifest = manifests.get(binding.blobId);
      if (
        !manifest
        || manifest.tenantId !== owner.tenantId
        || manifest.userId !== owner.userId
        || manifest.sessionId !== sessionId
        || manifest.purpose !== binding.purpose
        || manifest.uploadedAtMs === undefined
        || manifest.sha256 === undefined
        || manifest.sizeBytes === undefined
      ) throw new BlobStateError(binding.blobId);
      if (manifest.state === "ready" && manifest.itemId === binding.itemId) continue;
      if (!isUnexpiredStagingBlob(manifest, readyAtMs) || manifest.itemId !== undefined) {
        throw new BlobStateError(binding.blobId);
      }
      toReady.push(binding.blobId);
    }
    return { blobIds: toReady, readyAtMs };
  }

  /**
   * Item/turn/approval primary keys are global while their API ownership is session-scoped. Lock
   * every existing identity before any event or blob state is written, and reject both direct
   * collisions and references to a resource owned by another session. The returned sets also let
   * persistence use an explicit INSERT or UPDATE; ON DUPLICATE KEY UPDATE would let a concurrent
   * first writer from another session overwrite the globally keyed row after this preflight.
   */
  private async preflightCommitResources(
    conn: PoolConnection,
    batch: CommitBatch,
    owner: { tenantId: string; userId: string },
  ): Promise<ExistingCommitResources> {
    const observedItems = new Map<string, Item>();
    const observedTurns = new Map<string, Turn>();
    const observedApprovals = new Map<string, Approval>();
    const observeItem = (item: Item) => {
      const previous = observedItems.get(item.id);
      if (previous && (previous.sessionId !== item.sessionId || previous.turnId !== item.turnId || previous.type !== item.type)) {
        throw new Error("item identity conflicts with another resource");
      }
      observedItems.set(item.id, item);
    };
    const observeTurn = (turn: Turn) => {
      const previous = observedTurns.get(turn.id);
      if (previous && previous.sessionId !== turn.sessionId) throw new Error("turn identity conflicts with another resource");
      observedTurns.set(turn.id, turn);
    };
    const observeApproval = (approval: Approval) => {
      const previous = observedApprovals.get(approval.id);
      if (
        previous
        && (
          previous.sessionId !== approval.sessionId
          || previous.turnId !== approval.turnId
          || previous.itemId !== approval.itemId
          || previous.toolCallId !== approval.toolCallId
        )
      ) throw new Error("approval identity conflicts with another resource");
      observedApprovals.set(approval.id, approval);
    };

    for (const item of batch.items ?? []) observeItem(item);
    if (batch.turn) observeTurn(batch.turn);
    for (const approval of batch.approvals ?? []) {
      if (observedApprovals.has(approval.id)) throw new Error("commit contains the same approval more than once");
      observeApproval(approval);
    }
    for (const event of batch.events ?? []) {
      if ("item" in event) observeItem(event.item);
      if ("turn" in event) observeTurn(event.turn);
      if ("approval" in event) observeApproval(event.approval);
    }

    const turnReferences = new Set<string>();
    for (const id of observedTurns.keys()) turnReferences.add(id);
    for (const item of batch.items ?? []) turnReferences.add(item.turnId);
    for (const approval of batch.approvals ?? []) turnReferences.add(approval.turnId);
    for (const usage of batch.usageEntries ?? []) turnReferences.add(usage.turnId);
    if (batch.idempotency) turnReferences.add(batch.idempotency.value.turnId);

    const itemReferences = new Set<string>(observedItems.keys());
    for (const approval of batch.approvals ?? []) itemReferences.add(approval.itemId);

    const existing: ExistingCommitResources = {
      itemIds: new Set<string>(),
      turnIds: new Set<string>(),
      approvalIds: new Set<string>(),
    };

    const turnIds = [...turnReferences].sort();
    if (turnIds.length) {
      const placeholders = turnIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT turn_id, session_id, user_id
           FROM turns WHERE turn_id IN (${placeholders})
          ORDER BY turn_id FOR UPDATE`,
        turnIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("turn identity conflicts with another session owner");
        }
        if (batch.turn?.id === row.turn_id) existing.turnIds.add(String(row.turn_id));
      }
    }

    const itemIds = [...itemReferences].sort();
    if (itemIds.length) {
      const placeholders = itemIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT item_id, session_id, user_id, turn_id, type
           FROM items WHERE item_id IN (${placeholders})
          ORDER BY item_id FOR UPDATE`,
        itemIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("item identity conflicts with another session owner");
        }
        const incoming = observedItems.get(String(row.item_id));
        if (incoming) {
          if (row.turn_id !== incoming.turnId || row.type !== incoming.type) {
            throw new Error("item identity cannot change its turn or type");
          }
          existing.itemIds.add(String(row.item_id));
        }
      }
    }

    const approvalIds = [...observedApprovals.keys()].sort();
    if (approvalIds.length) {
      const placeholders = approvalIds.map(() => "?").join(",");
      const [rows] = await conn.query<Row[]>(
        `SELECT approval_id, session_id, user_id, turn_id, body
           FROM approvals WHERE approval_id IN (${placeholders})
          ORDER BY approval_id FOR UPDATE`,
        approvalIds,
      );
      for (const row of rows) {
        if (row.session_id !== batch.sessionId || row.user_id !== owner.userId) {
          throw new Error("approval identity conflicts with another session owner");
        }
        const incoming = observedApprovals.get(String(row.approval_id));
        const stored = parse<Approval>(row.body);
        if (
          !incoming
          || row.turn_id !== incoming.turnId
          || stored.itemId !== incoming.itemId
          || stored.toolCallId !== incoming.toolCallId
        ) {
          throw new Error("approval identity cannot change its turn, item or tool call");
        }
        if (batch.approvals?.some((approval) => approval.id === row.approval_id)) {
          existing.approvalIds.add(String(row.approval_id));
        }
      }
    }

    return existing;
  }

  // ---------- fenced commit ----------
  async commit(batch: CommitBatch): Promise<CommitResult> {
    assertPureFenceClaim(batch);
    assertTombstoneEvent(batch);
    assertCommitResourceOwnership(batch);
    assertBlobBindingsMatch(batch.items, batch.blobBindings);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<Row[]>(
        `SELECT tenant_id, user_id, status, last_seq, fence_token, usage_json, archived_at_ms,
                deleted_at_ms, purge_after_ms, deletion_generation
           FROM sessions WHERE session_id=? FOR UPDATE`,
        [batch.sessionId],
      );
      const head = rows[0];
      if (!head || head.deleted_at_ms != null) throw new SessionGoneError(batch.sessionId);
      const tenantId = head.tenant_id as string;
      const userId = head.user_id as string;
      await this.lockActiveSubjectGate(conn, tenantId, userId, Date.now(), batch.sessionId);
      const expectedOwner = batch.lifecycle ?? batch.fenceClaim;
      if (expectedOwner && (expectedOwner.tenantId !== tenantId || expectedOwner.userId !== userId)) {
        throw new SessionGoneError(batch.sessionId);
      }
      const currentFence = Number(head.fence_token);
      if (batch.fence < currentFence) throw new FenceError(batch.sessionId, batch.fence, currentFence);
      const currentLastSeq = Number(head.last_seq);
      if (batch.expectedLastSeq !== undefined && batch.expectedLastSeq !== currentLastSeq) {
        throw new SessionVersionError(batch.sessionId, batch.expectedLastSeq, currentLastSeq);
      }
      if (batch.lifecycle) {
        if (
          (batch.lifecycle.type === "archive" || batch.lifecycle.type === "tombstone")
          && parse<Session["status"]>(head.status).type === "active"
          && batch.sessionPatch?.status?.type !== "idle"
        ) {
          throw new SessionLifecycleBusyError(batch.sessionId);
        }
      } else if (!batch.fenceClaim && head.archived_at_ms != null) {
        throw new SessionArchivedError(batch.sessionId);
      }

      if (batch.fenceClaim) {
        // Ownership hand-off is intentionally invisible to clients: do not change updated_at_ms or
        // last_seq, and do not emit an event. The row lock makes this the linearization point.
        await conn.query("UPDATE sessions SET fence_token=? WHERE session_id=?", [batch.fence, batch.sessionId]);
        await conn.commit();
        return { events: [], lastSeq: currentLastSeq };
      }

      if (batch.lifecycle?.type === "tombstone") {
        const currentGeneration = Number(head.deletion_generation);
        if (batch.lifecycle.deletionGeneration !== currentGeneration + 1) {
          throw new Error(`deletion generation must advance from ${currentGeneration} to ${currentGeneration + 1}`);
        }
        const [children] = await conn.query<Row[]>(
          "SELECT session_id FROM sessions WHERE parent_session_id=? AND deleted_at_ms IS NULL LIMIT 1",
          [batch.sessionId],
        );
        if (children.length) throw new SessionHasChildrenError(batch.sessionId);
      }

      // A completed idempotency receipt and the first turn write share this transaction. There is no
      // pending reservation: a process that dies during preflight therefore leaves nothing to poison
      // retries. The locked session row serialises all conforming writers for this scope.
      if (batch.idempotency) {
        const receipt = batch.idempotency;
        if (receipt.scope.tenantId !== tenantId || receipt.scope.userId !== userId || receipt.scope.sessionId !== batch.sessionId) {
          throw new Error("idempotency scope does not match the locked session");
        }
        const keyParams = [tenantId, userId, batch.sessionId, receipt.key];
        const [idemRows] = await conn.query<Row[]>(
          "SELECT value, request_hash, expires_at_ms FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=? FOR UPDATE",
          keyParams,
        );
        const existing = idemRows[0];
        const now = Date.now();
        // A legacy runner completes a reservation with an unconditional UPDATE by primary key. Do
        // not replace even an expired pending row: that delayed UPDATE could otherwise overwrite the
        // new completed receipt. Operations may delete pending rows after all legacy runners exit.
        if (existing && existing.value == null) {
          throw new IdempotencyPendingError(Number(existing.expires_at_ms));
        }
        if (existing && Number(existing.expires_at_ms) >= now && existing.value != null) {
          const stored: IdempotencyReceipt = {
            requestHash: existing.request_hash == null ? undefined : String(existing.request_hash),
            value: parse(existing.value),
            expiresAtMs: Number(existing.expires_at_ms),
          };
          if (!stored.requestHash || stored.requestHash === receipt.requestHash) throw new IdempotencyReplayError(stored);
          throw new IdempotencyMismatchError(stored);
        }
        // New code never creates pending rows. An expired completed receipt is safe to replace.
        if (existing) {
          await conn.query(
            "DELETE FROM idempotency_keys WHERE tenant_id=? AND user_id=? AND session_id=? AND idem_key=?",
            keyParams,
          );
        }
      }

      const existingResources = await this.preflightCommitResources(
        conn,
        batch,
        { tenantId, userId },
      );

      // Lock every referenced manifest only after the session and globally keyed resource rows, in
      // bytewise blob-id order. The
      // staging sweeper locks only blob rows, so it either wins this state transition or observes the
      // committed ready state; it can never delete an object that this transaction just attached.
      const bindings = batch.blobBindings ?? [];
      const { blobIds: blobsToReady, readyAtMs } = await this.lockBlobBindings(
        conn,
        bindings,
        { tenantId, userId },
        batch.sessionId,
      );

      const stagedUsage = (batch.usageEntries ?? []).map((entry) => {
        if (!isUsageId(entry.usageId)) throw new Error("invalid usage id");
        const operational: UsageLedgerEntry & { usageId: string } = {
          ...entry,
          tenantId,
          userId,
          sessionId: batch.sessionId,
        };
        return {
          operational,
          billing: billingUsageFactFromLedger(operational),
        };
      });
      const owner = { tenantId, userId };
      const stagedProjectionRows = stagedUsage.map(({ operational }) => operational);
      const turnIds = new Set<string>();
      if (batch.turn) turnIds.add(batch.turn.id);
      for (const item of batch.items ?? []) turnIds.add(item.turnId);
      const exactKeys: { turnId: string; step: number }[] = [];
      const prefixKeys: { turnId: string; step: number }[] = [];
      for (const event of batch.events ?? []) {
        if (event.type === "turn/started" || event.type === "turn/completed") turnIds.add(event.turn.id);
        if (event.type === "usage/updated") {
          turnIds.add(event.turnId);
          exactKeys.push({ turnId: event.turnId, step: event.step });
          prefixKeys.push({ turnId: event.turnId, step: event.step });
        }
        if (
          (event.type === "item/started" || event.type === "item/completed")
          && event.item.type === "contextCompaction"
          && event.item.usageSnapshot !== undefined
        ) exactKeys.push({ turnId: event.item.turnId, step: 0 });
      }
      for (const item of batch.items ?? []) {
        if (item.type === "contextCompaction" && item.usageSnapshot !== undefined) {
          exactKeys.push({ turnId: item.turnId, step: 0 });
        }
      }

      // The locked session row serialises every conforming old/new writer for this ledger slice.
      // Aggregate only the facts needed by the batch; do not load an unbounded session ledger into
      // Node. The first consistent read occurs after the session lock, so it includes the previous
      // writer that released that lock and no later writer can race this transaction.
      const sessionSummaries = await this.loadSessionUsageSummaries(conn, [batch.sessionId]);
      const turnSummaries = await this.loadTurnUsageSummaries(conn, batch.sessionId, [...turnIds]);
      const turnPrefixes = await this.loadTurnPrefixUsageSummaries(conn, batch.sessionId, prefixKeys);
      const exactRows = await this.loadExactUsageProjectionRows(conn, batch.sessionId, exactKeys);
      const sessionSummary = mergeUsageProjectionSummaries(
        sessionSummaries.get(batch.sessionId),
        summarizeUsageProjectionRows(stagedProjectionRows, owner),
      );
      for (const turnId of turnIds) {
        turnSummaries.set(turnId, mergeUsageProjectionSummaries(
          turnSummaries.get(turnId),
          summarizeUsageProjectionRows(
            stagedProjectionRows.filter((row) => row.turnId === turnId),
            owner,
          ),
        ));
      }
      for (const key of prefixKeys) {
        const mapKey = usageProjectionStepKey(key.turnId, key.step);
        turnPrefixes.set(mapKey, mergeUsageProjectionSummaries(
          turnPrefixes.get(mapKey),
          summarizeUsageProjectionRows(
            stagedProjectionRows.filter((row) => row.turnId === key.turnId && row.step <= key.step),
            owner,
          ),
        ));
      }
      for (const row of stagedProjectionRows) {
        exactRows.set(usageProjectionStepKey(row.turnId, row.step), row);
      }

      let seq = currentLastSeq;
      let events: PersistedEvent[] = [];
      for (const e of batch.events ?? []) {
        seq += 1;
        const event = { ...e, seq } as PersistedEvent;
        // Only sequence-bearing nested resources are mutated below. Copy those resource objects so
        // a later SQL/serialization failure cannot leak an assigned seq into the caller's batch.
        if (event.type === "item/started" || event.type === "item/completed") event.item = { ...event.item };
        if (event.type === "turn/completed") event.turn = { ...event.turn };
        events.push(event);
      }
      let items = batch.items?.map((item) => ({ ...item }));
      let turn = batch.turn ? { ...batch.turn } : undefined;
      const sessionPatch = {
        ...(batch.sessionPatch ?? {}),
        usage: usageProjectionFromSummary(
          batch.sessionPatch?.usage ?? parse<Session["usage"]>(head.usage_json),
          sessionSummary,
        ),
      };
      if (turn) turn = this.projectTurnUsage(turn, turnSummaries.get(turn.id));
      items = items?.map((item) => canonicalizeUsageItem(
        item,
        exactRows.get(usageProjectionStepKey(item.turnId, 0)),
      ));
      events = events.map((event) => canonicalizePersistedUsageEventFromSummaries(event, {
        session: sessionSummary,
        turns: turnSummaries,
        turnPrefixes,
        exactRows,
      }));
      assignItemSeqs(items, events, seq);
      assignTurnSeqEnd(turn, events, seq);
      if (events.length) {
        await conn.query(
          "INSERT INTO events (session_id, seq, user_id, type, body, emitted_at_ms) VALUES ?",
          [events.map((e) => [batch.sessionId, e.seq, userId, e.type, json(e), e.emittedAtMs])],
        );
      }
      for (const it of items ?? []) await upsertItem(conn, it, userId, existingResources.itemIds.has(it.id));
      for (const blobId of blobsToReady) {
        const binding = bindings.find((candidate) => candidate.blobId === blobId)!;
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE blob_objects
            SET state='ready', item_id=?, ready_at_ms=?, staging_expires_at_ms=NULL
            WHERE blob_id=? AND state='staging' AND item_id IS NULL AND staging_expires_at_ms>?`,
          [binding.itemId, readyAtMs, blobId, readyAtMs],
        );
        if (updated.affectedRows !== 1) throw new BlobStateError(blobId);
      }
      if (turn) await upsertTurn(conn, turn, userId, existingResources.turnIds.has(turn.id));
      for (const a of batch.approvals ?? []) {
        await upsertApproval(conn, a, userId, existingResources.approvalIds.has(a.id));
      }
      if (stagedUsage.length) {
        await conn.query(
          `INSERT INTO usage_ledger
             (usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model, usage_json, created_at_ms)
           VALUES ?`,
          [stagedUsage.map(({ operational: entry }) => [
            entry.usageId,
            entry.tenantId,
            entry.userId,
            entry.sessionId,
            entry.turnId,
            entry.step,
            entry.provider,
            entry.model,
            json(entry.usage),
            entry.createdAtMs,
          ])],
        );
        for (const { billing } of stagedUsage) await insertBillingUsageFact(conn, billing);
      }
      if (batch.idempotency) {
        const receipt = batch.idempotency;
        await conn.query(
          "INSERT INTO idempotency_keys (tenant_id, user_id, session_id, idem_key, request_hash, value, expires_at_ms) VALUES (?,?,?,?,?,?,?)",
          [tenantId, userId, batch.sessionId, receipt.key, receipt.requestHash, json(receipt.value), receipt.expiresAtMs],
        );
      }
      if (batch.lifecycle?.type === "tombstone") {
        const generation = batch.lifecycle.deletionGeneration;
        const deletedEvent = events.at(-1);
        if (deletedEvent?.type !== "session/deleted") throw new Error("tombstone event was not assigned a sequence");
        await conn.query(
          `INSERT INTO lifecycle_outbox
             (topic, aggregate_id, generation, payload, available_at_ms, attempts, created_at_ms)
           VALUES ?`,
          [[
            [
              "session.tombstoned",
              batch.sessionId,
              generation,
              json({ sessionId: batch.sessionId, deletionGeneration: generation, eventSeq: deletedEvent.seq }),
              batch.lifecycle.atMs,
              0,
              batch.lifecycle.atMs,
            ],
            [
              "session.purge",
              batch.sessionId,
              generation,
              json({ sessionId: batch.sessionId, deletionGeneration: generation }),
              null,
              0,
              batch.lifecycle.atMs,
            ],
          ]],
        );
      }

      const sets = ["last_seq=?", "fence_token=?", "updated_at_ms=?"];
      const params: unknown[] = [seq, batch.fence, Date.now()];
      const p = sessionPatch;
      if (p) {
        if (p.status !== undefined) { sets.push("status=?"); params.push(json(p.status)); }
        if (p.title !== undefined) { sets.push("title=?"); params.push(p.title); }
        if (p.usage !== undefined) { sets.push("usage_json=?"); params.push(json(p.usage)); }
        if (p.contextEpoch !== undefined) { sets.push("context_epoch=?"); params.push(p.contextEpoch); }
        if (p.metadata !== undefined) { sets.push("metadata=?"); params.push(json(p.metadata)); }
        if (p.autoApprovedTools !== undefined) { sets.push("auto_approved_tools=?"); params.push(json(p.autoApprovedTools)); }
        if (p.lastCompactionSeq !== undefined) { sets.push("last_compaction_seq=?"); params.push(p.lastCompactionSeq); }
      }
      if (batch.lifecycle) {
        if (batch.lifecycle.type === "tombstone") {
          sets.push("deleted_at_ms=?", "purge_after_ms=?", "deletion_generation=?");
          params.push(batch.lifecycle.atMs, batch.lifecycle.purgeAfterMs ?? null, batch.lifecycle.deletionGeneration);
        } else {
          sets.push("archived_at_ms=?");
          params.push(batch.lifecycle.type === "archive" ? batch.lifecycle.atMs : null);
        }
      }
      params.push(batch.sessionId);
      await conn.query(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id=?`, params);
      await conn.commit();
      backfillAssignedSequences(batch, { items, turn, events });
      return {
        events,
        lastSeq: seq,
        lifecycleGeneration: batch.lifecycle?.type === "tombstone" ? batch.lifecycle.deletionGeneration : undefined,
      };
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---------- reads ----------
  private async withConsistentRead<T>(work: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      // Session/turn JSON and their ledger rollup must come from one MVCC snapshot. Without this,
      // an old writer committing between two ordinary SELECTs could pair a stale projection with a
      // newer ledger (or the reverse).
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  private usageProjectionSummarySql(groupColumns: string): string {
    const owned = USAGE_OWNER_MATCH;
    const ownedNumber = (field: string) => `CASE WHEN ${owned} THEN ${usageJsonNumber(field)} ELSE 0 END`;
    return `${groupColumns},
            COUNT(*) AS row_count,
            SUM(CASE WHEN ${owned} THEN 1 ELSE 0 END) AS owner_row_count,
            SUM(CASE WHEN ${owned} AND ${USAGE_PRICE_KNOWN} THEN 1 ELSE 0 END) AS priced_row_count,
            COALESCE(SUM(${ownedNumber("inputTokens")}),0) AS input_tokens,
            COALESCE(SUM(${ownedNumber("outputTokens")}),0) AS output_tokens,
            COALESCE(SUM(${ownedNumber("cacheReadTokens")}),0) AS cache_read_tokens,
            COALESCE(SUM(${ownedNumber("cacheWriteTokens")}),0) AS cache_write_tokens,
            COALESCE(SUM(${ownedNumber("reasoningTokens")}),0) AS reasoning_tokens,
            COALESCE(SUM(${ownedNumber("totalTokens")}),0) AS total_tokens,
            COALESCE(SUM(CASE WHEN ${owned} AND ${USAGE_PRICE_KNOWN}
              THEN ${USAGE_COST_NUMBER} ELSE 0 END),0) AS cost_cny`;
  }

  private async loadSessionUsageSummaries(
    executor: Pool | PoolConnection,
    sessionIds: readonly string[],
  ): Promise<Map<string, UsageProjectionSummary>> {
    const result = new Map<string, UsageProjectionSummary>();
    if (sessionIds.length === 0) return result;
    const placeholders = sessionIds.map(() => "?").join(",");
    const [rows] = await executor.query<Row[]>(
      `SELECT ${this.usageProjectionSummarySql("u.session_id")}
         FROM usage_ledger u
         JOIN sessions s ON s.session_id=u.session_id
        WHERE u.session_id IN (${placeholders})
        GROUP BY u.session_id`,
      [...sessionIds],
    );
    for (const row of rows) result.set(String(row.session_id), rowToUsageProjectionSummary(row));
    return result;
  }

  private async loadTurnUsageSummaries(
    executor: Pool | PoolConnection,
    sessionId: string,
    turnIds: readonly string[],
  ): Promise<Map<string, UsageProjectionSummary>> {
    const result = new Map<string, UsageProjectionSummary>();
    const unique = [...new Set(turnIds)];
    if (unique.length === 0) return result;
    const placeholders = unique.map(() => "?").join(",");
    const [rows] = await executor.query<Row[]>(
      `SELECT ${this.usageProjectionSummarySql("u.turn_id")}
         FROM usage_ledger u
         JOIN sessions s ON s.session_id=u.session_id
        WHERE u.session_id=? AND u.turn_id IN (${placeholders})
        GROUP BY u.turn_id`,
      [sessionId, ...unique],
    );
    for (const row of rows) result.set(String(row.turn_id), rowToUsageProjectionSummary(row));
    return result;
  }

  private async loadExactUsageProjectionRows(
    executor: Pool | PoolConnection,
    sessionId: string,
    keys: readonly { turnId: string; step: number }[],
  ): Promise<Map<string, UsageProjectionLedgerRow>> {
    const result = new Map<string, UsageProjectionLedgerRow>();
    const unique = [...new Map(keys.map((key) => [usageProjectionStepKey(key.turnId, key.step), key])).values()];
    if (unique.length === 0) return result;
    const predicates = unique.map(() => "(turn_id=? AND step=?)").join(" OR ");
    const [rows] = await executor.query<Row[]>(
      `SELECT u.usage_id, u.tenant_id, u.user_id, u.session_id, u.turn_id, u.step, u.usage_json
         FROM usage_ledger u
         JOIN sessions s
           ON s.session_id=u.session_id AND s.tenant_id=u.tenant_id AND s.user_id=u.user_id
        WHERE u.session_id=? AND (${predicates.replaceAll("turn_id", "u.turn_id").replaceAll("step", "u.step")})`,
      [sessionId, ...unique.flatMap((key) => [key.turnId, key.step])],
    );
    for (const raw of rows) {
      const row = rowToUsageProjection(raw);
      result.set(usageProjectionStepKey(row.turnId, row.step), row);
    }
    return result;
  }

  private async loadTurnPrefixUsageSummaries(
    executor: Pool | PoolConnection,
    sessionId: string,
    keys: readonly { turnId: string; step: number }[],
  ): Promise<Map<string, UsageProjectionSummary>> {
    const result = new Map<string, UsageProjectionSummary>();
    const unique = [...new Map(keys.map((key) => [usageProjectionStepKey(key.turnId, key.step), key])).values()];
    if (unique.length === 0) return result;
    const requested = unique.map(() => "SELECT ? AS turn_id, ? AS step").join(" UNION ALL ");
    const owned = USAGE_OWNER_MATCH;
    const ownedNumber = (field: string) => `CASE WHEN u.id IS NOT NULL AND ${owned}
      THEN ${usageJsonNumber(field)} ELSE 0 END`;
    const [rows] = await executor.query<Row[]>(
      `SELECT requested.turn_id, requested.step,
              COUNT(u.id) AS row_count,
              SUM(CASE WHEN u.id IS NOT NULL AND ${owned} THEN 1 ELSE 0 END) AS owner_row_count,
              SUM(CASE WHEN u.id IS NOT NULL AND ${owned} AND ${USAGE_PRICE_KNOWN}
                THEN 1 ELSE 0 END) AS priced_row_count,
              COALESCE(SUM(${ownedNumber("inputTokens")}),0) AS input_tokens,
              COALESCE(SUM(${ownedNumber("outputTokens")}),0) AS output_tokens,
              COALESCE(SUM(${ownedNumber("cacheReadTokens")}),0) AS cache_read_tokens,
              COALESCE(SUM(${ownedNumber("cacheWriteTokens")}),0) AS cache_write_tokens,
              COALESCE(SUM(${ownedNumber("reasoningTokens")}),0) AS reasoning_tokens,
              COALESCE(SUM(${ownedNumber("totalTokens")}),0) AS total_tokens,
              COALESCE(SUM(CASE WHEN u.id IS NOT NULL AND ${owned} AND ${USAGE_PRICE_KNOWN}
                THEN ${USAGE_COST_NUMBER} ELSE 0 END),0) AS cost_cny
         FROM (${requested}) requested
         JOIN sessions s ON s.session_id=?
         LEFT JOIN usage_ledger u
           ON u.session_id=s.session_id AND u.turn_id=requested.turn_id AND u.step<=requested.step
        GROUP BY requested.turn_id, requested.step`,
      [...unique.flatMap((key) => [key.turnId, key.step]), sessionId],
    );
    for (const row of rows) {
      result.set(
        usageProjectionStepKey(String(row.turn_id), Number(row.step)),
        rowToUsageProjectionSummary(row),
      );
    }
    return result;
  }

  private projectSessionUsage(session: Session, summary: UsageProjectionSummary | undefined): Session {
    return {
      ...session,
      usage: usageProjectionFromSummary(session.usage, summary ?? emptyUsageProjectionSummary()),
    };
  }

  private projectTurnUsage(
    turn: Turn,
    summary: UsageProjectionSummary | undefined,
  ): Turn {
    return {
      ...turn,
      usage: usageProjectionFromSummary(turn.usage, summary ?? emptyUsageProjectionSummary()),
    };
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    // Deliberately raw: an established SSE stream must be able to observe session/deleted. Public
    // subscription setup performs an owner-aware live-session check before calling this method.
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        "SELECT body FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
        [sessionId, afterSeq, limit],
      );
      const events = rows.map((r) => parse<PersistedEvent>(r.body));
      if (!events.some((event) => (
        event.type === "turn/started" || event.type === "turn/completed"
        || event.type === "usage/updated"
        || ((event.type === "item/started" || event.type === "item/completed")
          && event.item.type === "contextCompaction" && event.item.usageSnapshot !== undefined)
      ))) return events;
      const [owners] = await conn.query<Row[]>(
        "SELECT tenant_id, user_id FROM sessions WHERE session_id=?",
        [sessionId],
      );
      if (!owners[0]) return events;

      const turnIds: string[] = [];
      const exactKeys: { turnId: string; step: number }[] = [];
      const prefixKeys: { turnId: string; step: number }[] = [];
      for (const event of events) {
        if (event.type === "turn/completed") turnIds.push(event.turn.id);
        if (event.type === "usage/updated") {
          turnIds.push(event.turnId);
          exactKeys.push({ turnId: event.turnId, step: event.step });
          prefixKeys.push({ turnId: event.turnId, step: event.step });
        }
        if (
          (event.type === "item/started" || event.type === "item/completed")
          && event.item.type === "contextCompaction"
          && event.item.usageSnapshot !== undefined
        ) exactKeys.push({ turnId: event.item.turnId, step: 0 });
      }
      const sessionSummaries = await this.loadSessionUsageSummaries(conn, [sessionId]);
      const turns = await this.loadTurnUsageSummaries(conn, sessionId, turnIds);
      const turnPrefixes = await this.loadTurnPrefixUsageSummaries(conn, sessionId, prefixKeys);
      const exactRows = await this.loadExactUsageProjectionRows(conn, sessionId, exactKeys);
      return events.map((event) => canonicalizePersistedUsageEventFromSummaries(event, {
        session: sessionSummaries.get(sessionId) ?? emptyUsageProjectionSummary(),
        turns,
        turnPrefixes,
        exactRows,
      }));
    });
  }
  async getTurn(sessionId: string, turnId: string) {
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT t.body FROM turns t
           JOIN sessions s ON s.session_id=t.session_id AND s.deleted_at_ms IS NULL
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE t.turn_id=? AND t.session_id=?`,
        [turnId, sessionId],
      );
      if (!rows[0]) return null;
      const summaries = await this.loadTurnUsageSummaries(conn, sessionId, [turnId]);
      return this.projectTurnUsage(parse<Turn>(rows[0].body), summaries.get(turnId));
    });
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }): Promise<Page<Turn>> {
    return this.withConsistentRead(async (conn) => {
      const desc = (opts.sortDirection ?? "desc") === "desc";
      const [rows] = await conn.query<Row[]>(
        `SELECT t.body FROM turns t
           JOIN sessions s ON s.session_id=t.session_id AND s.deleted_at_ms IS NULL
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE t.session_id=? ${opts.cursor ? `AND t.turn_id ${desc ? "<" : ">"} ?` : ""}
          ORDER BY t.turn_id ${desc ? "DESC" : "ASC"} LIMIT ?`,
        opts.cursor ? [sessionId, opts.cursor, opts.limit + 1] : [sessionId, opts.limit + 1],
      );
      const pageRows = rows.slice(0, opts.limit);
      const parsed = pageRows.map((row) => parse<Turn>(row.body));
      const summaries = await this.loadTurnUsageSummaries(conn, sessionId, parsed.map((turn) => turn.id));
      const data = parsed.map((turn) => this.projectTurnUsage(turn, summaries.get(turn.id)));
      return { data, nextCursor: rows.length > opts.limit ? (data.at(-1)?.id ?? null) : null };
    });
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    return this.withConsistentRead(async (conn) => {
      const where = ["i.session_id=?", "s.deleted_at_ms IS NULL"];
      const params: unknown[] = [sessionId];
      if (opts.turnId) { where.push("i.turn_id=?"); params.push(opts.turnId); }
      if (opts.afterSeq !== undefined) { where.push("i.seq>?"); params.push(opts.afterSeq); }
      params.push(opts.limit);
      // Take the newest rows when asked, then flip back to seq-ascending for the caller.
      const order = opts.newestFirst ? "DESC" : "ASC";
      const [rows] = await conn.query<Row[]>(
        `SELECT i.body FROM items i
           JOIN sessions s ON s.session_id=i.session_id
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE ${where.join(" AND ")} ORDER BY i.seq ${order}, i.item_id ${order} LIMIT ?`,
        params,
      );
      let items = rows.map((r) => parse<Item>(r.body));
      const compactions = items.filter((item) => item.type === "contextCompaction" && item.usageSnapshot !== undefined);
      const exact = await this.loadExactUsageProjectionRows(
        conn,
        sessionId,
        compactions.map((item) => ({ turnId: item.turnId, step: 0 })),
      );
      items = items.map((item) => canonicalizeUsageItem(
        item,
        exact.get(usageProjectionStepKey(item.turnId, 0)),
      ));
      return opts.newestFirst ? items.reverse() : items;
    });
  }
  async getItem(sessionId: string, itemId: string) {
    return this.withConsistentRead(async (conn) => {
      const [rows] = await conn.query<Row[]>(
        `SELECT i.body FROM items i
           JOIN sessions s ON s.session_id=i.session_id AND s.deleted_at_ms IS NULL
           JOIN subject_lifecycle tl
             ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
            AND tl.subject_id=s.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul
             ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
            AND ul.subject_id=s.user_id AND ul.state='active'
          WHERE i.item_id=? AND i.session_id=?`,
        [itemId, sessionId],
      );
      if (!rows[0]) return null;
      const item = parse<Item>(rows[0].body);
      const exact = await this.loadExactUsageProjectionRows(conn, sessionId, [{ turnId: item.turnId, step: 0 }]);
      return canonicalizeUsageItem(item, exact.get(usageProjectionStepKey(item.turnId, 0)));
    });
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.body FROM approvals a
         JOIN sessions s ON s.session_id=a.session_id AND s.deleted_at_ms IS NULL
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
        WHERE a.session_id=? ${opts.pendingOnly ? "AND a.status='pending'" : ""}
        ORDER BY a.created_at_ms ASC`,
      [sessionId],
    );
    return rows.map((r) => parse<Approval>(r.body));
  }
  async getApproval(sessionId: string, approvalId: string) {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT a.body FROM approvals a
         JOIN sessions s ON s.session_id=a.session_id AND s.deleted_at_ms IS NULL
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
        WHERE a.approval_id=? AND a.session_id=?`,
      [approvalId, sessionId],
    );
    return rows[0] ? parse<Approval>(rows[0].body) : null;
  }

  // ---------- provider configs ----------
  async upsertProviderConfig(cfg: ProviderConfig, secret?: { ciphertext: Buffer; keyId: string }) {
    await this.pool.query(
      `INSERT INTO provider_configs (tenant_id, provider_id, config, secret_cipher, secret_key_id, created_at_ms, updated_at_ms)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE config=VALUES(config), updated_at_ms=VALUES(updated_at_ms),
         secret_cipher=COALESCE(VALUES(secret_cipher), secret_cipher), secret_key_id=COALESCE(VALUES(secret_key_id), secret_key_id)`,
      [cfg.tenantId, cfg.id, json(cfg), secret?.ciphertext ?? null, secret?.keyId ?? null, cfg.createdAtMs, cfg.updatedAtMs],
    );
  }
  async getProviderConfig(tenantId: string, providerId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT config, secret_cipher, secret_key_id FROM provider_configs WHERE tenant_id=? AND provider_id=?", [tenantId, providerId]);
    const r = rows[0];
    if (!r) return null;
    return {
      config: parse<ProviderConfig>(r.config),
      secret: r.secret_cipher ? { ciphertext: Buffer.from(r.secret_cipher), keyId: r.secret_key_id as string } : undefined,
    };
  }
  async listProviderConfigs(tenantId: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT config FROM provider_configs WHERE tenant_id=? ORDER BY provider_id", [tenantId]);
    return rows.map((r) => parse<ProviderConfig>(r.config));
  }
  async deleteProviderConfig(tenantId: string, providerId: string) {
    const [res] = await this.pool.query<mysql.ResultSetHeader>("DELETE FROM provider_configs WHERE tenant_id=? AND provider_id=?", [tenantId, providerId]);
    return res.affectedRows > 0;
  }

  // ---------- api keys ----------
  async resolveApiKey(hashedKey: string) {
    const [rows] = await this.pool.query<Row[]>("SELECT tenant_id, key_id, scopes FROM api_keys WHERE key_hash=? AND revoked_at_ms IS NULL", [hashedKey]);
    const r = rows[0];
    if (!r) return null;
    return { tenantId: r.tenant_id as string, keyId: r.key_id as string, scopes: r.scopes == null ? DEFAULT_SCOPES : parse<ApiKeyScope[]>(r.scopes) };
  }
  async createApiKey(tenantId: string, keyId: string, hashedKey: string, scopes: ApiKeyScope[] = DEFAULT_SCOPES) {
    await this.pool.query("INSERT IGNORE INTO tenants (tenant_id, created_at_ms) VALUES (?,?)", [tenantId, Date.now()]);
    await this.pool.query("INSERT IGNORE INTO api_keys (key_hash, key_id, tenant_id, scopes, created_at_ms) VALUES (?,?,?,?,?)", [hashedKey, keyId, tenantId, json(scopes), Date.now()]);
  }
  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const [rows] = await this.pool.query<Row[]>("SELECT key_id, tenant_id, scopes, created_at_ms, revoked_at_ms FROM api_keys WHERE tenant_id=? ORDER BY created_at_ms", [tenantId]);
    return rows.map((r) => ({
      keyId: r.key_id as string,
      tenantId: r.tenant_id as string,
      scopes: r.scopes == null ? DEFAULT_SCOPES : parse<ApiKeyScope[]>(r.scopes),
      createdAtMs: Number(r.created_at_ms),
      revokedAtMs: r.revoked_at_ms == null ? undefined : Number(r.revoked_at_ms),
    }));
  }
  async revokeApiKey(tenantId: string, keyId: string) {
    const [res] = await this.pool.query<mysql.ResultSetHeader>(
      "UPDATE api_keys SET revoked_at_ms=? WHERE tenant_id=? AND key_id=? AND revoked_at_ms IS NULL",
      [Date.now(), tenantId, keyId],
    );
    return res.affectedRows > 0;
  }

  async getTenant(tenantId: string): Promise<TenantRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      "SELECT tenant_id, name, auth_policy, auth_secret_cipher, auth_secret_key_id, created_at_ms FROM tenants WHERE tenant_id=?",
      [tenantId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      tenantId: r.tenant_id,
      name: r.name ?? undefined,
      authPolicy: r.auth_policy == null ? DEFAULT_AUTH_POLICY : parse<TenantAuthPolicy>(r.auth_policy),
      authSecret: r.auth_secret_cipher ? { ciphertext: Buffer.from(r.auth_secret_cipher), keyId: r.auth_secret_key_id as string } : undefined,
      createdAtMs: Number(r.created_at_ms),
    };
  }
  async setTenantAuth(tenantId: string, policy: TenantAuthPolicy, secret?: { ciphertext: Buffer; keyId: string } | null) {
    // `undefined` keeps the stored secret; `null` clears it, so switching verifier kind cannot leave a
    // stale key behind that would then be used to verify tokens for the new configuration.
    const keep = secret === undefined;
    await this.pool.query(
      `INSERT INTO tenants (tenant_id, auth_policy, auth_secret_cipher, auth_secret_key_id, created_at_ms)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE auth_policy=VALUES(auth_policy),
         auth_secret_cipher=${keep ? "auth_secret_cipher" : "VALUES(auth_secret_cipher)"},
         auth_secret_key_id=${keep ? "auth_secret_key_id" : "VALUES(auth_secret_key_id)"}`,
      [tenantId, json(policy), secret?.ciphertext ?? null, secret?.keyId ?? null, Date.now()],
    );
  }

  // ---------- usage ledger ----------
  private async lockUsageLifecycleSession(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
    proofRequired = false,
  ): Promise<Row> {
    const [rows] = await conn.query<Row[]>(
      `SELECT tenant_id, user_id, last_seq, deleted_at_ms, purge_after_ms, deletion_generation
         FROM sessions FORCE INDEX (idx_sessions_tenant_user)
        WHERE tenant_id=? AND user_id=? AND session_id=? FOR UPDATE`,
      [input.tenantId, input.userId, input.sessionId],
    );
    const session = rows[0];
    if (
      !session
      || session.tenant_id !== input.tenantId
      || session.user_id !== input.userId
    ) {
      if (proofRequired) throw new ErasureTombstoneIntegrityError();
      throw new SessionGoneError(input.sessionId);
    }
    if (
      session.deleted_at_ms == null
      || Number(session.deletion_generation) !== input.deletionGeneration
    ) {
      if (proofRequired) throw new ErasureTombstoneIntegrityError();
      throw new UsageLifecycleGenerationError(input.sessionId, input.deletionGeneration);
    }
    return session;
  }

  private async lockUsageReconciliation(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
  ): Promise<UsageReconciliationRecord | null> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${USAGE_RECONCILIATION_COLUMNS}
         FROM usage_reconciliations
        WHERE session_id=? AND deletion_generation=?
        FOR UPDATE`,
      [input.sessionId, input.deletionGeneration],
    );
    if (!rows[0]) return null;
    const record = rowToUsageReconciliation(rows[0]);
    assertUsageReconciliationOwner(record, input);
    return record;
  }

  private async lockUsageLegalHold(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
  ): Promise<boolean> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=?
          AND ((subject_kind='tenant' AND subject_id=?)
            OR (subject_kind='user' AND subject_id=?))
        ORDER BY subject_kind, subject_id
        FOR UPDATE`,
      [input.tenantId, input.tenantId, input.userId],
    );
    const tenantLifecycle = rows.find(
      (row) => row.subject_kind === "tenant" && row.subject_id === input.tenantId,
    );
    const userLifecycle = rows.find(
      (row) => row.subject_kind === "user" && row.subject_id === input.userId,
    );
    if (!tenantLifecycle || !userLifecycle) {
      throw new UsageReconciliationError("subject lifecycle state is missing; anonymization is fail-closed");
    }
    let tenant: LegalHoldContext;
    let user: LegalHoldContext;
    try {
      tenant = await this.loadLegalHoldContextForLifecycle(
        conn,
        input.tenantId,
        "tenant",
        input.tenantId,
        rowToSubjectLifecycle(tenantLifecycle),
        "FOR UPDATE",
      );
      user = await this.loadLegalHoldContextForLifecycle(
        conn,
        input.tenantId,
        "user",
        input.userId,
        rowToSubjectLifecycle(userLifecycle),
        "FOR UPDATE",
      );
    } catch (error) {
      if (error instanceof LegalHoldIntegrityError) throw error;
      throw new LegalHoldIntegrityError(
        `legal hold state cannot be proven: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    return tenant.control.activeHoldCount > 0 || user.control.activeHoldCount > 0;
  }

  private async assertNoOperationalUsage(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
  ): Promise<void> {
    const rows = await this.lockSessionUsageRows(conn, input);
    if (rows.length > 0) {
      throw new UsageReconciliationError("operational usage reappeared after anonymization");
    }
  }

  private async lockSessionUsageRows(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
  ): Promise<Row[]> {
    const [rows] = await conn.query<Row[]>(
      `SELECT id, usage_id, tenant_id, user_id, session_id, turn_id, step, provider, model,
              usage_json, created_at_ms
         FROM usage_ledger
        WHERE session_id=?
        ORDER BY id
        FOR UPDATE`,
      [input.sessionId],
    );
    // Validate the complete session slice before assigning a legacy id or deleting a row. The
    // schema historically had no composite owner FK, so corrupt/imported rows must fail closed
    // instead of being omitted from reconciliation and left behind by anonymization.
    if (rows.some((row) => row.tenant_id !== input.tenantId || row.user_id !== input.userId)) {
      throw new UsageReconciliationError("operational usage owner does not match its session");
    }
    return rows;
  }

  private async materializeBillingUsageFacts(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
    mode: "reconcile" | "verify",
  ): Promise<{ expected: BillingUsageFact[]; actual: BillingUsageFact[] }> {
    const rows = await this.lockSessionUsageRows(conn, input);
    const operational: (UsageLedgerEntry & { usageId: string })[] = [];
    for (const row of rows) {
      let usageId = row.usage_id == null ? undefined : String(row.usage_id);
      const parsedUsage = parse<UsageLedgerEntry["usage"]>(row.usage_json);
      // Preserve legacy provenance before assigning an identity. Pre-0011 Pi wrote costCNY=0 both
      // for genuinely free models and for missing pricing; those cases are indistinguishable, so
      // reconciliation conservatively persists the normalized unknown form in the same transaction.
      const normalizedUsage = normalizeOperationalUsageCost(parsedUsage, usageId);
      if (usageId === undefined && mode === "reconcile") {
        for (let attempt = 0; attempt < 5 && usageId === undefined; attempt += 1) {
          const candidate = newUsageId();
          try {
            const [updated] = await conn.query<mysql.ResultSetHeader>(
              "UPDATE usage_ledger SET usage_id=?, usage_json=? WHERE id=? AND usage_id IS NULL",
              [candidate, json(normalizedUsage), row.id],
            );
            if (updated.affectedRows !== 1) {
              throw new UsageReconciliationError("legacy usage identity assignment lost its row lock");
            }
            usageId = candidate;
          } catch (error) {
            if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
          }
        }
      }
      if (!isUsageId(usageId)) {
        throw new UsageReconciliationError(
          mode === "reconcile"
            ? "could not assign a stable identity to legacy usage"
            : "verified operational usage is missing its stable identity",
        );
      }
      operational.push({
        usageId,
        tenantId: String(row.tenant_id),
        userId: String(row.user_id),
        sessionId: String(row.session_id),
        turnId: String(row.turn_id),
        step: Number(row.step),
        provider: String(row.provider),
        model: String(row.model),
        usage: normalizedUsage,
        createdAtMs: Number(row.created_at_ms),
      });
    }

    const expected = operational.map((entry) => billingUsageFactFromLedger(entry));
    const actual: BillingUsageFact[] = [];
    for (const fact of [...expected].sort((left, right) => left.usageId.localeCompare(right.usageId))) {
      const [billingRows] = await conn.query<Row[]>(
        `SELECT ${BILLING_USAGE_COLUMNS}
           FROM billing_usage_facts WHERE usage_id=? FOR UPDATE`,
        [fact.usageId],
      );
      const existing = billingRows[0] ? rowToBillingUsageFact(billingRows[0]) : undefined;
      if (existing) {
        if (!billingUsageFactContentEquals(existing, fact)) {
          throw new UsageIdentityConflictError(fact.usageId);
        }
        actual.push(existing);
      } else {
        if (mode === "verify") {
          throw new UsageReconciliationError("a verified billing usage fact is missing");
        }
        await insertBillingUsageFact(conn, fact);
        actual.push(fact);
      }
    }
    return { expected, actual };
  }

  async queryUsage(tenantId: string, q: UsageQuery) {
    // Grouping keys are chosen from a fixed set, never interpolated from input.
    const keyExpr =
      q.groupBy === "user" ? "u.user_id"
      : q.groupBy === "session" ? "u.session_id"
      : q.groupBy === "model" ? "CONCAT(u.provider, '/', u.model)"
      : q.groupBy === "day" ? "DATE_FORMAT(FROM_UNIXTIME(u.created_at_ms/1000), '%Y-%m-%d')"
      : "'total'";
    const where = ["u.tenant_id=?", "s.deleted_at_ms IS NULL"];
    const params: unknown[] = [tenantId];
    if (q.userId) { where.push("u.user_id=?"); params.push(q.userId); }
    if (q.sessionId) { where.push("u.session_id=?"); params.push(q.sessionId); }
    if (q.from !== undefined) { where.push("u.created_at_ms>=?"); params.push(q.from); }
    if (q.to !== undefined) { where.push("u.created_at_ms<?"); params.push(q.to); }
    params.push(q.limit);
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${keyExpr} AS k,
              COUNT(DISTINCT u.turn_id) AS turns,
              COUNT(*) AS steps,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.inputTokens') AS UNSIGNED)),0) AS input_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.outputTokens') AS UNSIGNED)),0) AS output_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.cacheReadTokens') AS UNSIGNED)),0) AS cache_read_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.cacheWriteTokens') AS UNSIGNED)),0) AS cache_write_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.reasoningTokens') AS UNSIGNED)),0) AS reasoning_tokens,
              COALESCE(SUM(CAST(JSON_EXTRACT(u.usage_json,'$.totalTokens') AS UNSIGNED)),0) AS total_tokens,
              COUNT(CASE
                WHEN ${USAGE_PRICE_KNOWN}
                THEN 1
              END) AS priced_rows,
              COALESCE(SUM(CASE
                WHEN ${USAGE_PRICE_KNOWN}
                THEN ${USAGE_COST_NUMBER}
                ELSE 0
              END),0) AS cost
         FROM usage_ledger u
         JOIN sessions s
           ON s.session_id=u.session_id AND s.tenant_id=u.tenant_id AND s.user_id=u.user_id
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
        WHERE ${where.join(" AND ")}
        GROUP BY k
        ORDER BY total_tokens DESC, k ASC
        LIMIT ?`,
      params,
    );
    return {
      data: rows.map((r) => ({
        key: String(r.k),
        turns: Number(r.turns),
        steps: Number(r.steps),
        usage: {
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          cacheReadTokens: Number(r.cache_read_tokens),
          cacheWriteTokens: Number(r.cache_write_tokens),
          reasoningTokens: Number(r.reasoning_tokens),
          totalTokens: Number(r.total_tokens),
          // A cost total is publishable only when every constituent row is priced. Returning the
          // known subtotal would silently understate mixed priced/unpriced usage.
          ...(Number(r.priced_rows) === Number(r.steps) ? { costCNY: Number(r.cost) } : {}),
        },
      })),
    };
  }

  /** Session and any erasure authority are already locked by the caller for this transaction. */
  private async reconcileSessionUsageLocked(
    conn: PoolConnection,
    input: ReconcileSessionUsageInput,
  ): Promise<UsageReconciliationRecord> {
    const existing = await this.lockUsageReconciliation(conn, input);
    if (existing?.status === "anonymized") {
      await this.assertNoOperationalUsage(conn, input);
      return existing;
    }

    const { expected, actual } = await this.materializeBillingUsageFacts(
      conn,
      input,
      "reconcile",
    );
    const expectedSummary = summarizeBillingUsageFacts(expected);
    const actualSummary = summarizeBillingUsageFacts(actual);
    if (!usageReconciliationSummariesEqual(expectedSummary, actualSummary)) {
      throw new UsageReconciliationError();
    }
    if (existing) {
      if (!usageReconciliationSummariesEqual(usageReconciliationSummary(existing), actualSummary)) {
        throw new UsageReconciliationError("stored usage reconciliation no longer matches its facts");
      }
      return existing;
    }

    const record: UsageReconciliationRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      deletionGeneration: input.deletionGeneration,
      status: "verified",
      ...actualSummary,
      verifiedAtMs: input.nowMs,
    };
    await conn.query(
      `INSERT INTO usage_reconciliations
         (tenant_id, user_id, session_id, deletion_generation, status, row_count, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
          known_cost_rows, cost_cny, checksum, verified_at_ms, anonymized_at_ms, created_at_ms,
          updated_at_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        record.tenantId,
        record.userId,
        record.sessionId,
        record.deletionGeneration,
        record.status,
        record.rowCount,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.reasoningTokens,
        record.totalTokens,
        record.knownCostRows,
        record.costCNY === undefined ? null : canonicalBillingCostCNY(record.costCNY),
        record.checksum,
        record.verifiedAtMs,
        null,
        record.verifiedAtMs,
        record.verifiedAtMs,
      ],
    );
    return record;
  }

  async reconcileSessionUsage(input: ReconcileSessionUsageInput): Promise<UsageReconciliationRecord> {
    validateReconcileSessionUsageInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await this.lockUsageLifecycleSession(conn, input);
      const result = await this.reconcileSessionUsageLocked(conn, input);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async reconcileErasureSessionUsage(
    authorization: ErasureWriteAuthorization,
    input: ErasureUsageReconciliationInput,
  ): Promise<UsageReconciliationRecord> {
    // Freeze the complete authority before the first await so mutable caller objects cannot swap a
    // token, attempt, owner or timestamp while this method waits for a pooled connection/row lock.
    const stagedAuthorization = structuredClone(authorization);
    const stagedInput = structuredClone(input);
    validateErasureUsageReconciliationInput(stagedAuthorization, stagedInput);
    const lifecycleInput: ReconcileSessionUsageInput = {
      tenantId: stagedAuthorization.tenantId,
      userId: stagedAuthorization.userId,
      sessionId: stagedInput.sessionId,
      deletionGeneration: stagedInput.deletionGeneration,
      nowMs: stagedInput.nowMs,
    };
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // Preserve the writer lock order used by claim-bound session actions: session -> tenant ->
      // user -> request. Reconciliation and usage/billing rows follow those coarse authority locks.
      // Holding the request lock until commit makes revalidation and every possible write one
      // linearizable boundary; a transition, retry or ABA reclaim cannot interleave.
      const proofSession = await this.lockUsageLifecycleSession(conn, lifecycleInput, true);
      await this.lockErasureSessionAuthority(
        conn,
        stagedAuthorization,
        ["reconciling_usage"],
        stagedInput.nowMs,
      );
      if (!await this.erasureTombstoneProofValid(
        conn,
        stagedInput.sessionId,
        stagedAuthorization.userId,
        proofSession.deleted_at_ms,
        proofSession.purge_after_ms,
        proofSession.last_seq,
        proofSession.deletion_generation,
      )) {
        throw new ErasureTombstoneIntegrityError();
      }
      const result = await this.reconcileSessionUsageLocked(conn, lifecycleInput);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async anonymizeSessionUsage(input: AnonymizeSessionUsageInput): Promise<UsageReconciliationRecord> {
    // The runtime check is intentional even though TypeScript callers see literal `true`.
    assertUsageAnonymizationAllowed(input, false);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      // Canonical destructive lock order is tenant -> user -> session -> reconciliation/ledger.
      // Evaluator seal follows the same subject prefix before it inventories session data, so a
      // concurrent hold, evaluation, or anonymization cannot form a session/subject cycle.
      const legalHoldActive = await this.lockUsageLegalHold(conn, input);
      await this.lockUsageLifecycleSession(conn, input);
      const existing = await this.lockUsageReconciliation(conn, input);
      if (!existing) throw new UsageReconciliationError("usage must be reconciled before anonymization");
      if (existing.checksum !== input.expectedChecksum) {
        throw new UsageReconciliationError("expected reconciliation checksum does not match");
      }
      if (existing.status === "anonymized") {
        await this.assertNoOperationalUsage(conn, input);
        await conn.commit();
        return existing;
      }
      // A hold blocks only the destructive verified -> anonymized transition. If that transition
      // already committed but its response was lost, a later hold cannot restore operational rows
      // and must not make the same-checksum retry report a false failure.
      assertUsageAnonymizationAllowed(input, legalHoldActive);
      if (input.nowMs < existing.verifiedAtMs) {
        throw new UsageReconciliationError("anonymization cannot precede verification");
      }

      const { expected, actual } = await this.materializeBillingUsageFacts(
        conn,
        input,
        "verify",
      );
      const expectedSummary = summarizeBillingUsageFacts(expected);
      const actualSummary = summarizeBillingUsageFacts(actual);
      const storedSummary = usageReconciliationSummary(existing);
      if (
        !usageReconciliationSummariesEqual(expectedSummary, actualSummary)
        || !usageReconciliationSummariesEqual(storedSummary, expectedSummary)
      ) {
        throw new UsageReconciliationError("usage changed after verification");
      }

      const [deleted] = await conn.query<mysql.ResultSetHeader>(
        "DELETE FROM usage_ledger WHERE tenant_id=? AND user_id=? AND session_id=?",
        [input.tenantId, input.userId, input.sessionId],
      );
      if (deleted.affectedRows !== existing.rowCount) {
        throw new UsageReconciliationError("operational usage delete count does not match verification");
      }
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE usage_reconciliations
            SET status='anonymized', anonymized_at_ms=?, updated_at_ms=?
          WHERE session_id=? AND deletion_generation=? AND status='verified'`,
        [input.nowMs, input.nowMs, input.sessionId, input.deletionGeneration],
      );
      if (updated.affectedRows !== 1) {
        throw new UsageReconciliationError("usage reconciliation was not in verified state");
      }
      const result: UsageReconciliationRecord = {
        ...existing,
        status: "anonymized",
        anonymizedAtMs: input.nowMs,
      };
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  // ---------- idempotency ----------
  async getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT i.value, i.request_hash, i.expires_at_ms
         FROM idempotency_keys i
         JOIN sessions s
           ON s.session_id=i.session_id AND s.tenant_id=i.tenant_id AND s.user_id=i.user_id
          AND s.deleted_at_ms IS NULL
         JOIN subject_lifecycle tl
           ON tl.tenant_id=s.tenant_id AND tl.subject_kind='tenant'
          AND tl.subject_id=s.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul
           ON ul.tenant_id=s.tenant_id AND ul.subject_kind='user'
          AND ul.subject_id=s.user_id AND ul.state='active'
        WHERE i.tenant_id=? AND i.user_id=? AND i.session_id=? AND i.idem_key=?`,
      [scope.tenantId, scope.userId, scope.sessionId, key],
    );
    const row = rows[0];
    if (!row || row.value == null || Number(row.expires_at_ms) < Date.now()) return null;
    return {
      requestHash: row.request_hash == null ? undefined : String(row.request_hash),
      value: parse(row.value),
      expiresAtMs: Number(row.expires_at_ms),
    };
  }

  async getLifecycleOutbox(
    topic: LifecycleOutboxRecord["topic"],
    aggregateId: string,
    generation: number,
  ): Promise<LifecycleOutboxRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts, claim_token,
              lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
         FROM lifecycle_outbox
        WHERE topic=? AND aggregate_id=? AND generation=?`,
      [topic, aggregateId, generation],
    );
    const row = rows[0];
    return row ? rowToLifecycleOutbox(row) : null;
  }

  async claimLifecycleOutbox(options: import("../types.js").ClaimLifecycleOutboxOptions) {
    const { topics, leaseUntilMs } = validateClaimLifecycleOutboxOptions(options);
    if (topics.length === 0) return [];
    const conn = await this.pool.getConnection();
    try {
      // READ COMMITTED reduces next-key/gap-lock contention around this worker queue. SKIP LOCKED
      // remains deliberately non-blocking and may under-fill a concurrent batch; the next poll
      // drains any eligible row skipped inside another transaction's LIMIT scan window.
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const topicPlaceholders = topics.map(() => "?").join(",");
      const [locked] = await conn.query<Row[]>(
        `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts,
                claim_token, lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
           FROM lifecycle_outbox
          WHERE topic IN (${topicPlaceholders})
            AND available_at_ms IS NOT NULL
            AND available_at_ms<=?
            AND completed_at_ms IS NULL
            AND dead_lettered_at_ms IS NULL
            AND (claim_token IS NULL OR lease_until_ms<=?)
          ORDER BY available_at_ms ASC, outbox_id ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [...topics, options.nowMs, options.nowMs, options.limit],
      );
      if (locked.length === 0) {
        await conn.commit();
        return [];
      }
      const ids: number[] = [];
      const poisonIds: number[] = [];
      for (const row of locked) {
        const id = Number(row.outbox_id);
        assertLifecycleOutboxId(id);
        try {
          rowToLifecycleOutbox(row);
          ids.push(id);
        } catch {
          poisonIds.push(id);
        }
      }
      if (poisonIds.length) {
        const poisonPlaceholders = poisonIds.map(() => "?").join(",");
        // Corrupt envelopes are deterministic poison. Quarantine them in the same locked
        // transaction so they cannot starve every valid intent behind the first queue position.
        await conn.query(
          `UPDATE lifecycle_outbox
              SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL, available_at_ms=NULL,
                  last_error='invalid lifecycle outbox envelope', dead_lettered_at_ms=?
            WHERE outbox_id IN (${poisonPlaceholders})`,
          [options.nowMs, ...poisonIds],
        );
      }
      if (ids.length === 0) {
        await conn.commit();
        return [];
      }
      const idPlaceholders = ids.map(() => "?").join(",");
      await conn.query(
        `UPDATE lifecycle_outbox
            SET attempts=attempts+1, claim_token=?, lease_until_ms=?
          WHERE outbox_id IN (${idPlaceholders})`,
        [options.claimToken, leaseUntilMs, ...ids],
      );
      const [rows] = await conn.query<Row[]>(
        `SELECT outbox_id, topic, aggregate_id, generation, payload, available_at_ms, attempts,
                claim_token, lease_until_ms, last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms
           FROM lifecycle_outbox
          WHERE outbox_id IN (${idPlaceholders})`,
        ids,
      );
      const byId = new Map(rows.map((row) => [Number(row.outbox_id), rowToLifecycleOutbox(row)]));
      const claimed = ids.map((id) => {
        const row = byId.get(id);
        if (!row) throw new Error(`claimed lifecycle outbox ${id} disappeared inside its transaction`);
        return row;
      });
      await conn.commit();
      return claimed;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewLifecycleOutboxClaim(
    outboxId: number,
    claimToken: string,
    options: import("../types.js").RenewLifecycleOutboxClaimOptions,
  ) {
    const leaseUntilMs = validateRenewLifecycleOutboxClaim(outboxId, claimToken, options.nowMs, options.leaseMs);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET lease_until_ms=GREATEST(lease_until_ms, ?)
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND topic='session.tombstoned'
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [leaseUntilMs, outboxId, claimToken, options.nowMs],
    );
    return result.affectedRows === 1;
  }

  async completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number) {
    validateLifecycleOutboxAck(outboxId, claimToken, completedAtMs);
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET completed_at_ms=?, claim_token=NULL, lease_until_ms=NULL, last_error=NULL
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND topic='session.tombstoned'
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [completedAtMs, outboxId, claimToken, completedAtMs],
    );
    return result.affectedRows === 1;
  }

  async retryLifecycleOutbox(
    outboxId: number,
    claimToken: string,
    options: import("../types.js").RetryLifecycleOutboxOptions,
  ) {
    validateLifecycleOutboxAck(outboxId, claimToken, options.failedAtMs);
    validateRetryLifecycleOutboxOptions(options);
    const lastError = sanitizeLifecycleOutboxError(options.error);
    if (options.maxAttempts === undefined) {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `UPDATE lifecycle_outbox
            SET claim_token=NULL, lease_until_ms=NULL, last_error=?, available_at_ms=?
          WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
            AND topic='session.tombstoned'
            AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
        [lastError, options.availableAtMs, outboxId, claimToken, options.failedAtMs],
      );
      return result.affectedRows === 1;
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE lifecycle_outbox
          SET claim_token=NULL,
              lease_until_ms=NULL,
              last_error=?,
              available_at_ms=CASE WHEN attempts>=? THEN NULL ELSE ? END,
              dead_lettered_at_ms=CASE WHEN attempts>=? THEN ? ELSE NULL END
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND topic='session.tombstoned'
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [
        lastError,
        options.maxAttempts,
        options.availableAtMs,
        options.maxAttempts,
        options.failedAtMs,
        outboxId,
        claimToken,
        options.failedAtMs,
      ],
    );
    return result.affectedRows === 1;
  }

  // ---------- blob staging sweeper + delete outbox ----------
  async scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number> {
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) throw new Error("invalid blob sweep timestamp");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("blob sweep limit must be between 1 and 100");
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const [rows] = await conn.query<Row[]>(
        `SELECT ${BLOB_COLUMNS} FROM blob_objects
          WHERE state='staging' AND staging_expires_at_ms IS NOT NULL AND staging_expires_at_ms<=?
          ORDER BY staging_expires_at_ms, blob_id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [options.nowMs, options.limit],
      );
      for (const row of rows) {
        const manifest = rowToBlobManifest(row);
        const generation = manifest.deletionGeneration + 1;
        await conn.query(
          `UPDATE blob_objects
              SET state='delete_pending', staging_expires_at_ms=NULL, delete_after_ms=?, deletion_generation=?
            WHERE blob_id=? AND state='staging'`,
          [options.nowMs, generation, manifest.blobId],
        );
        await conn.query(
          `INSERT INTO blob_delete_outbox
             (blob_id, generation, available_at_ms, attempts, created_at_ms)
           VALUES (?,?,?,0,?)`,
          [manifest.blobId, generation, options.nowMs, options.nowMs],
        );
      }
      await conn.commit();
      return rows.length;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]> {
    const leaseUntilMs = validateBlobDeleteClaim(options);
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const [locked] = await conn.query<Row[]>(
        `SELECT outbox_id FROM blob_delete_outbox
          WHERE available_at_ms<=?
            AND completed_at_ms IS NULL
            AND dead_lettered_at_ms IS NULL
            AND (claim_token IS NULL OR lease_until_ms<=?)
          ORDER BY available_at_ms, outbox_id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [options.nowMs, options.nowMs, options.limit],
      );
      if (locked.length === 0) {
        await conn.commit();
        return [];
      }
      const ids = locked.map((row) => Number(row.outbox_id));
      const placeholders = ids.map(() => "?").join(",");
      const [joined] = await conn.query<Row[]>(
        `SELECT ${BLOB_DELETE_COLUMNS}
           FROM blob_delete_outbox o
           LEFT JOIN blob_objects b ON b.blob_id=o.blob_id
          WHERE o.outbox_id IN (${placeholders})`,
        ids,
      );
      const validIds: number[] = [];
      const poisonIds: number[] = [];
      for (const row of joined) {
        try {
          rowToBlobDeleteOutbox(row);
          validIds.push(Number(row.outbox_id));
        } catch {
          poisonIds.push(Number(row.outbox_id));
        }
      }
      if (poisonIds.length) {
        const poison = poisonIds.map(() => "?").join(",");
        await conn.query(
          `UPDATE blob_delete_outbox
              SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL,
                  last_error='invalid blob delete outbox identity', dead_lettered_at_ms=?
            WHERE outbox_id IN (${poison})`,
          [options.nowMs, ...poisonIds],
        );
      }
      if (validIds.length === 0) {
        await conn.commit();
        return [];
      }
      const valid = validIds.map(() => "?").join(",");
      await conn.query(
        `UPDATE blob_delete_outbox SET attempts=attempts+1, claim_token=?, lease_until_ms=?
          WHERE outbox_id IN (${valid})`,
        [options.claimToken, leaseUntilMs, ...validIds],
      );
      const [claimedRows] = await conn.query<Row[]>(
        `SELECT ${BLOB_DELETE_COLUMNS}
           FROM blob_delete_outbox o
           JOIN blob_objects b ON b.blob_id=o.blob_id
          WHERE o.outbox_id IN (${valid})`,
        validIds,
      );
      const byId = new Map(claimedRows.map((row) => {
        const record = rowToBlobDeleteOutbox(row);
        return [record.outboxId, record] as const;
      }));
      const claimed = validIds.map((id) => {
        const record = byId.get(id);
        if (!record) throw new Error(`claimed blob delete outbox ${id} disappeared inside its transaction`);
        return record;
      });
      await conn.commit();
      return claimed;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: import("../blob-lifecycle.js").RenewBlobDeleteClaimOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.nowMs);
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new Error("invalid blob delete lease duration");
    const leaseUntilMs = options.nowMs + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("invalid blob delete lease expiry");
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE blob_delete_outbox SET lease_until_ms=GREATEST(lease_until_ms, ?)
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [leaseUntilMs, outboxId, claimToken, options.nowMs],
    );
    return result.affectedRows === 1;
  }

  async completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, completedAtMs);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [outboxes] = await conn.query<Row[]>(
        `SELECT blob_id, generation, claim_token, lease_until_ms, completed_at_ms, dead_lettered_at_ms
           FROM blob_delete_outbox WHERE outbox_id=? FOR UPDATE`,
        [outboxId],
      );
      const outbox = outboxes[0];
      if (
        !outbox
        || outbox.completed_at_ms != null
        || outbox.dead_lettered_at_ms != null
        || outbox.claim_token !== claimToken
        || outbox.lease_until_ms == null
        || Number(outbox.lease_until_ms) <= completedAtMs
      ) {
        await conn.rollback();
        return false;
      }
      const [blobs] = await conn.query<Row[]>(
        "SELECT state, deletion_generation FROM blob_objects WHERE blob_id=? FOR UPDATE",
        [outbox.blob_id],
      );
      const blob = blobs[0];
      if (!blob || blob.state !== "delete_pending" || Number(blob.deletion_generation) !== Number(outbox.generation)) {
        throw new BlobStateError(String(outbox.blob_id));
      }
      await conn.query(
        `UPDATE blob_objects
            SET state='deleted', sha256=NULL, size_bytes=NULL, content_type=NULL, uploaded_at_ms=NULL,
                ready_at_ms=NULL, delete_after_ms=NULL, deleted_at_ms=?
          WHERE blob_id=? AND state='delete_pending' AND deletion_generation=?`,
        [completedAtMs, outbox.blob_id, outbox.generation],
      );
      await conn.query(
        `UPDATE blob_delete_outbox
            SET completed_at_ms=?, claim_token=NULL, lease_until_ms=NULL, last_error=NULL
          WHERE outbox_id=?`,
        [completedAtMs, outboxId],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryBlobDelete(outboxId: number, claimToken: string, options: RetryBlobDeleteOptions): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.failedAtMs);
    if (!Number.isSafeInteger(options.availableAtMs) || options.availableAtMs < options.failedAtMs) {
      throw new Error("blob delete retry must not move backwards");
    }
    if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new Error("blob delete maxAttempts must be positive");
    }
    const error = sanitizeBlobDeleteError(options.error);
    if (options.maxAttempts === undefined) {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `UPDATE blob_delete_outbox
            SET claim_token=NULL, lease_until_ms=NULL, last_error=?, available_at_ms=?
          WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
            AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
        [error, options.availableAtMs, outboxId, claimToken, options.failedAtMs],
      );
      return result.affectedRows === 1;
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE blob_delete_outbox
          SET claim_token=NULL, lease_until_ms=NULL, last_error=?,
              available_at_ms=CASE WHEN attempts>=? THEN available_at_ms ELSE ? END,
              dead_lettered_at_ms=CASE WHEN attempts>=? THEN ? ELSE NULL END
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [
        error,
        options.maxAttempts,
        options.availableAtMs,
        options.maxAttempts,
        options.failedAtMs,
        outboxId,
        claimToken,
        options.failedAtMs,
      ],
    );
    return result.affectedRows === 1;
  }

  async getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT ${BLOB_DELETE_COLUMNS}
         FROM blob_delete_outbox o
         JOIN blob_objects b ON b.blob_id=o.blob_id
        WHERE o.blob_id=? AND o.generation=?`,
      [blobId, generation],
    );
    return rows[0] ? rowToBlobDeleteOutbox(rows[0], false) : null;
  }

  // ---------- user data export ----------
  private async userExportDatabaseNow(executor: Pool | PoolConnection): Promise<number> {
    const [rows] = await executor.query<Row[]>(
      "SELECT FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000) AS now_ms",
    );
    return storedSafeInteger(rows[0]?.now_ms, "data export database clock");
  }

  private async loadUserExportRequest(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    requestId: string,
    lock = false,
  ): Promise<UserDataExportRequestRecord | null> {
    const [rows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_REQUEST_COLUMNS}
         FROM user_export_requests r FORCE INDEX (idx_user_export_requests_owner)
         LEFT JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
          AND a.request_id=r.request_id AND a.tenant_id=r.tenant_id AND a.user_id=r.user_id
          AND a.subject_generation=r.subject_generation
          AND a.build_generation=r.active_build_generation
        WHERE r.tenant_id=? AND r.user_id=? AND r.request_id=?
        ${lock ? "FOR UPDATE" : ""}`,
      [tenantId, userId, requestId],
    );
    return rows[0] ? rowToUserDataExportRequest(rows[0]) : null;
  }

  private async lockUserExportSubject(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    atMs: number,
    options: { userLock: "FOR SHARE" | "FOR UPDATE"; requireActive: boolean },
  ): Promise<{ tenant: SubjectLifecycleRecord; user: SubjectLifecycleRecord }> {
    await this.ensureSubjectLifecycleRows(conn, tenantId, userId, atMs);
    const [tenantRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='tenant' AND subject_id=? FOR SHARE`,
      [tenantId, tenantId],
    );
    const [userRows] = await conn.query<Row[]>(
      `SELECT ${SUBJECT_LIFECYCLE_COLUMNS}
         FROM subject_lifecycle
        WHERE tenant_id=? AND subject_kind='user' AND subject_id=? ${options.userLock}`,
      [tenantId, userId],
    );
    const tenant = tenantRows[0] ? rowToSubjectLifecycle(tenantRows[0]) : undefined;
    const user = userRows[0] ? rowToSubjectLifecycle(userRows[0]) : undefined;
    if (!tenant || !user) throw new UserDataExportIntegrityError("data export subject gate is missing");
    if (options.requireActive && (tenant.state !== "active" || user.state !== "active")) {
      throw new SubjectDeletingError(tenantId, user.state === "active" ? undefined : userId);
    }
    return { tenant, user };
  }

  private async lockActiveUserExportClaim(
    conn: PoolConnection,
    authorization: UserDataExportAuthorization,
    nowMs: number,
    currentSubjectGeneration: number,
  ): Promise<{ request: UserDataExportRequestRecord; job: StoredUserDataExportJob } | null> {
    validateUserDataExportAuthorization(authorization);
    const request = await this.loadUserExportRequest(
      conn,
      authorization.tenantId,
      authorization.userId,
      authorization.requestId,
      true,
    );
    const [jobRows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_JOB_COLUMNS}
         FROM user_export_jobs WHERE request_id=? FOR UPDATE`,
      [authorization.requestId],
    );
    const job = jobRows[0] ? rowToUserDataExportJob(jobRows[0]) : undefined;
    if (
      !request
      || !job
      || job.tenantId !== authorization.tenantId
      || job.userId !== authorization.userId
      || request.subjectGeneration !== currentSubjectGeneration
      || job.subjectGeneration !== currentSubjectGeneration
      || request.subjectGeneration !== authorization.subjectGeneration
      || job.subjectGeneration !== authorization.subjectGeneration
      || request.currentBuildGeneration !== authorization.buildGeneration
      || job.buildGeneration !== authorization.buildGeneration
      || job.attempts !== authorization.claimAttempt
      || job.claimToken !== authorization.claimToken
      || job.leaseUntilMs === undefined
      || job.leaseUntilMs <= nowMs
      || request.status !== "building"
      || job.status !== "building"
    ) return null;
    return { request, job };
  }

  private async userExportSnapshotSummary(
    conn: PoolConnection,
    job: StoredUserDataExportJob,
  ): Promise<UserDataExportSnapshotSummary> {
    if (
      job.snapshotAtMs === undefined
      || job.snapshotSealedAtMs === undefined
      || job.snapshotRootSha256 === undefined
    ) throw new UserDataExportIntegrityError("data export snapshot is not sealed");
    const counts = Object.fromEntries(
      [...USER_DATA_EXPORT_RECORD_KIND_ORDER, "attachment"].map((kind) => [kind, 0]),
    ) as Record<UserDataExportSnapshotEntry["type"], number>;
    const [rows] = await conn.query<Row[]>(
      `SELECT record_kind, COUNT(*) AS row_count
         FROM user_export_snapshot_records
        WHERE request_id=? AND build_generation=?
        GROUP BY record_kind FOR SHARE`,
      [job.requestId, job.buildGeneration],
    );
    for (const row of rows) {
      const kind = String(row.record_kind) as keyof typeof counts;
      if (!USER_DATA_EXPORT_RECORD_KIND_ORDER.includes(kind as never)) {
        throw new UserDataExportIntegrityError("data export snapshot contains an unknown record kind");
      }
      counts[kind] = storedSafeInteger(row.row_count, "data export snapshot kind count");
    }
    counts.attachment = job.snapshotBlobCount;
    const regularCount = USER_DATA_EXPORT_RECORD_KIND_ORDER.reduce(
      (total, kind) => total + counts[kind],
      0,
    );
    if (regularCount !== job.snapshotRecordCount) {
      throw new UserDataExportIntegrityError("data export snapshot count does not match its seal");
    }
    const recordCount = regularCount + job.snapshotBlobCount;
    if (!Number.isSafeInteger(recordCount)) {
      throw new UserDataExportIntegrityError("data export snapshot count overflowed");
    }
    return {
      snapshotAtMs: job.snapshotAtMs,
      counts,
      recordCount,
      snapshotRootSha256: job.snapshotRootSha256,
    };
  }

  private async releaseUserExportSnapshot(
    conn: PoolConnection,
    requestId: string,
    buildGeneration: number,
    atMs: number,
  ): Promise<void> {
    await conn.query(
      `UPDATE user_export_snapshot_blobs
          SET released_at_ms=COALESCE(released_at_ms, ?)
        WHERE request_id=? AND build_generation=?`,
      [atMs, requestId, buildGeneration],
    );
    await conn.query(
      `DELETE FROM user_export_snapshot_records
        WHERE request_id=? AND build_generation=?`,
      [requestId, buildGeneration],
    );
  }

  private async transitionUserExportArtifactToDeletePending(
    conn: PoolConnection,
    artifactId: string,
    atMs: number,
  ): Promise<boolean> {
    const [artifactRows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
         FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
      [artifactId],
    );
    if (!artifactRows[0]) return false;
    const artifact = rowToUserDataExportArtifact(artifactRows[0]);
    if (artifact.state === "delete_pending" || artifact.state === "deleted") return false;
    const deletionGeneration = artifact.deletionGeneration + 1;
    if (!Number.isSafeInteger(deletionGeneration) || deletionGeneration < 1) {
      throw new UserDataExportIntegrityError("data export deletion generation is exhausted");
    }
    const [partRows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_PART_COLUMNS}
         FROM user_export_artifact_parts
        WHERE artifact_id=? ORDER BY part_number FOR UPDATE`,
      [artifactId],
    );
    const parts = partRows.map((row) => {
      assertUserDataExportPartOwner(row, {
        artifactId: artifact.artifactId,
        requestId: artifact.requestId,
        buildGeneration: artifact.buildGeneration,
        tenantId: artifact.tenantId,
        userId: artifact.userId,
        subjectGeneration: artifact.subjectGeneration,
      });
      return rowToUserDataExportPart(row);
    });
    if (parts.some((part, index) => (
      part.partNumber !== index
      || part.storageKey !== userDataExportStorageKey(
        { tenantId: artifact.tenantId, userId: artifact.userId },
        artifact.requestId,
        artifact.artifactId,
        part.partNumber,
      )
    ))) {
      throw new UserDataExportIntegrityError("data export artifact parts are non-contiguous");
    }
    await conn.query("DELETE FROM user_export_download_leases WHERE artifact_id=?", [artifactId]);
    if (parts.length === 0) {
      await conn.query(
        `UPDATE user_export_artifacts
            SET state='deleted', delete_after_ms=?, deleted_at_ms=?, deletion_generation=?,
                updated_at_ms=?
          WHERE artifact_id=?`,
        [atMs, atMs, deletionGeneration, atMs, artifactId],
      );
      return true;
    }
    for (const part of parts) {
      if (part.state === "deleted") continue;
      await conn.query(
        `UPDATE user_export_artifact_parts
            SET state='delete_pending', delete_after_ms=?, deletion_generation=?, updated_at_ms=?
          WHERE artifact_id=? AND part_number=?`,
        [atMs, deletionGeneration, atMs, artifactId, part.partNumber],
      );
      await conn.query(
        `INSERT INTO user_export_artifact_delete_outbox
           (artifact_id, part_number, request_id, build_generation, deletion_generation,
            storage_backend, storage_format, storage_key, upload_token, expected_sha256,
            expected_size_bytes, available_at_ms, attempts, claim_token, lease_until_ms,
            last_error, completed_at_ms, dead_lettered_at_ms, created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,0,NULL,NULL,NULL,NULL,NULL,?)`,
        [
          artifactId,
          part.partNumber,
          artifact.requestId,
          artifact.buildGeneration,
          deletionGeneration,
          part.storageBackend,
          part.storageFormat,
          part.storageKey,
          part.uploadToken,
          part.sha256 ?? null,
          part.sizeBytes ?? null,
          atMs,
          atMs,
        ],
      );
    }
    await conn.query(
      `UPDATE user_export_artifacts
          SET state='delete_pending', delete_after_ms=?, deletion_generation=?, updated_at_ms=?
        WHERE artifact_id=?`,
      [atMs, deletionGeneration, atMs, artifactId],
    );
    return true;
  }

  private async revokeUserExportsForSubject(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    atMs: number,
  ): Promise<void> {
    const [requestRows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_REQUEST_COLUMNS}
         FROM user_export_requests r FORCE INDEX (idx_user_export_requests_owner)
         LEFT JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
          AND a.request_id=r.request_id AND a.tenant_id=r.tenant_id AND a.user_id=r.user_id
          AND a.subject_generation=r.subject_generation
          AND a.build_generation=r.active_build_generation
        WHERE r.tenant_id=? AND r.user_id=?
        ORDER BY r.created_at_ms, r.request_id FOR UPDATE`,
      [tenantId, userId],
    );
    const requests = requestRows.map(rowToUserDataExportRequest);
    if (requests.length === 0) return;
    const requestIds = requests.map((request) => request.requestId);
    const placeholders = requestIds.map(() => "?").join(",");
    const [artifactRows] = await conn.query<Row[]>(
      `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
         FROM user_export_artifacts
        WHERE request_id IN (${placeholders})
        ORDER BY request_id, build_generation FOR UPDATE`,
      requestIds,
    );
    await conn.query(
      `UPDATE user_export_requests
          SET status='revoked', revoked_at_ms=COALESCE(revoked_at_ms, ?), updated_at_ms=?,
              last_error_code=NULL
        WHERE request_id IN (${placeholders}) AND status<>'revoked'`,
      [atMs, atMs, ...requestIds],
    );
    await conn.query(
      `UPDATE user_export_jobs
          SET status='revoked', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
              last_error_code=NULL, updated_at_ms=?
        WHERE request_id IN (${placeholders}) AND status<>'revoked'`,
      [atMs, ...requestIds],
    );
    await conn.query(
      `DELETE FROM user_export_download_leases WHERE request_id IN (${placeholders})`,
      requestIds,
    );
    for (const request of requests) {
      await this.releaseUserExportSnapshot(
        conn,
        request.requestId,
        request.currentBuildGeneration,
        atMs,
      );
    }
    for (const row of artifactRows) {
      const artifact = rowToUserDataExportArtifact(row);
      await this.transitionUserExportArtifactToDeletePending(conn, artifact.artifactId, atMs);
    }
  }

  private async quarantineUserExportBuildCandidate(
    conn: PoolConnection,
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await conn.beginTransaction();
    try {
      const now = await this.userExportDatabaseNow(conn);
      // Keep the global export lock order (request -> job -> artifact -> parts). These raw reads
      // intentionally avoid the normal parsers because a parser failure is what routed the row
      // here, but their exact owner coordinates are still independently constrained in SQL.
      const [requestRows] = await conn.query<Row[]>(
        `SELECT subject_generation, active_build_generation, active_artifact_id
           FROM user_export_requests
          WHERE request_id=? AND tenant_id=? AND user_id=?
            AND status IN ('queued','building') FOR UPDATE`,
        [requestId, tenantId, userId],
      );
      if (requestRows.length === 0) {
        await conn.commit();
        return;
      }
      const requestIdentity = requestRows[0]!;
      const [jobRows] = await conn.query<Row[]>(
        `SELECT subject_generation, build_generation, active_artifact_id
           FROM user_export_jobs
          WHERE request_id=? AND tenant_id=? AND user_id=?
            AND status IN ('queued','building') FOR UPDATE`,
        [requestId, tenantId, userId],
      );
      if (jobRows.length === 0) {
        await conn.commit();
        return;
      }
      const jobIdentity = jobRows[0]!;
      const jobArtifactId = jobIdentity.active_artifact_id == null
        ? undefined
        : String(jobIdentity.active_artifact_id);
      const requestArtifactId = requestIdentity.active_artifact_id == null
        ? undefined
        : String(requestIdentity.active_artifact_id);
      // The request parser may be the reason this candidate was quarantined. Use only the raw,
      // redundantly-bound coordinates here, and never follow one pointer unless request, job and
      // artifact all agree on the exact owner/generation. A valid partial artifact must enter its
      // ordinary delete outbox in this same quarantine transaction; otherwise the malformed
      // request would also poison the cleanup scheduler and strand its object indefinitely.
      if (
        jobArtifactId !== undefined
        && jobArtifactId === requestArtifactId
        && String(jobIdentity.subject_generation) === String(requestIdentity.subject_generation)
        && String(jobIdentity.build_generation) === String(requestIdentity.active_build_generation)
      ) {
        const [artifactIdentityRows] = await conn.query<Row[]>(
          `SELECT artifact_id
             FROM user_export_artifacts
            WHERE artifact_id=? AND request_id=? AND tenant_id=? AND user_id=?
              AND subject_generation=? AND build_generation=? FOR UPDATE`,
          [
            jobArtifactId,
            requestId,
            tenantId,
            userId,
            jobIdentity.subject_generation,
            jobIdentity.build_generation,
          ],
        );
        if (artifactIdentityRows.length === 1) {
          await this.transitionUserExportArtifactToDeletePending(conn, jobArtifactId, now);
        }
      }
      await conn.query(
        `UPDATE user_export_jobs
            SET status='failed', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                last_error_code='artifact_invalid', updated_at_ms=?
          WHERE request_id=? AND tenant_id=? AND user_id=? AND status IN ('queued','building')`,
        [now, requestId, tenantId, userId],
      );
      await conn.query(
        `UPDATE user_export_requests
            SET status='failed', last_error_code='artifact_invalid', updated_at_ms=?
          WHERE request_id=? AND tenant_id=? AND user_id=? AND status IN ('queued','building')`,
        [now, requestId, tenantId, userId],
      );
      await conn.query(
        `UPDATE user_export_snapshot_blobs SET released_at_ms=COALESCE(released_at_ms, ?)
          WHERE request_id=?`,
        [now, requestId],
      );
      await conn.query("DELETE FROM user_export_snapshot_records WHERE request_id=?", [requestId]);
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    }
  }

  async requestUserDataExport(
    input: RequestUserDataExportInput,
  ): Promise<UserDataExportRequestRecord> {
    const staged = structuredClone(input);
    validateUserDataExportRequestInput(staged);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const { user: subject } = await this.lockUserExportSubject(
        conn,
        staged.tenantId,
        staged.userId,
        now,
        { userLock: "FOR UPDATE", requireActive: true },
      );
      const [replayRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_REQUEST_COLUMNS}
           FROM user_export_requests r FORCE INDEX (uk_user_export_requests_idempotency)
           LEFT JOIN user_export_artifacts a ON a.artifact_id=r.active_artifact_id
            AND a.request_id=r.request_id AND a.tenant_id=r.tenant_id AND a.user_id=r.user_id
            AND a.subject_generation=r.subject_generation
            AND a.build_generation=r.active_build_generation
          WHERE r.tenant_id=? AND r.user_id=? AND r.idempotency_key_sha256=? FOR UPDATE`,
        [staged.tenantId, staged.userId, staged.idempotencyKeySha256],
      );
      if (replayRows[0]) {
        const replay = rowToUserDataExportRequest(replayRows[0]);
        if (replay.requestHash !== staged.requestHash) {
          throw new UserDataExportIdempotencyMismatchError();
        }
        await conn.commit();
        return replay;
      }
      const active = await this.loadValidatedActiveRetentionPolicy(
        conn,
        staged.tenantId,
        "FOR SHARE",
      );
      const ttl = active?.policy.policy.exportArtifactTtlMs;
      if (
        !active
        || active.control.effectiveAtMs === undefined
        || active.control.effectiveAtMs > now
        || ttl === null
        || ttl === undefined
        || ttl <= 0
      ) throw new UserDataExportPolicyUnavailableError();
      const record: UserDataExportRequestRecord = {
        requestId: staged.requestId,
        tenantId: staged.tenantId,
        userId: staged.userId,
        subjectGeneration: subject.generation,
        requestedByKeyId: staged.requestedByKeyId,
        idempotencyKeySha256: staged.idempotencyKeySha256,
        requestHash: staged.requestHash,
        format: USER_DATA_EXPORT_FORMAT,
        schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
        policyVersion: active.policy.policyVersion,
        policySha256: active.policy.policySha256,
        artifactTtlMs: ttl,
        status: "queued",
        currentBuildGeneration: 0,
        createdAtMs: now,
        updatedAtMs: now,
      };
      validateUserDataExportRequestRecord(record);
      try {
        await conn.query(
          `INSERT INTO user_export_requests
             (request_id, tenant_id, user_id, subject_generation, requested_by_key_id,
              idempotency_key_sha256, request_sha256, export_format, export_schema_version,
              policy_version, policy_sha256, artifact_ttl_ms, status, active_build_generation,
              active_artifact_id, last_error_code, created_at_ms, updated_at_ms, snapshot_at_ms,
              ready_at_ms, expires_at_ms, revoked_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'queued',0,NULL,NULL,?,?,NULL,NULL,NULL,NULL)`,
          [
            record.requestId,
            record.tenantId,
            record.userId,
            record.subjectGeneration,
            record.requestedByKeyId,
            record.idempotencyKeySha256,
            record.requestHash,
            record.format,
            record.schemaVersion,
            record.policyVersion,
            record.policySha256,
            record.artifactTtlMs,
            now,
            now,
          ],
        );
        await conn.query(
          `INSERT INTO user_export_jobs
             (request_id, tenant_id, user_id, subject_generation, build_generation, status,
              active_artifact_id, available_at_ms, attempts, claim_token, lease_until_ms,
              last_error_code, snapshot_at_ms, snapshot_record_count, snapshot_blob_count,
              snapshot_root_sha256, snapshot_sealed_at_ms, created_at_ms, updated_at_ms,
              completed_at_ms)
           VALUES (?,?,?,?,0,'queued',NULL,?,0,NULL,NULL,NULL,NULL,0,0,NULL,NULL,?,?,NULL)`,
          [record.requestId, record.tenantId, record.userId, record.subjectGeneration, now, now, now],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new UserDataExportStateError("data export request identity already exists");
        }
        throw error;
      }
      await conn.commit();
      return record;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getUserDataExport(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<UserDataExportRequestRecord | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        tenantId,
        userId,
        now,
        { userLock: "FOR SHARE", requireActive: false },
      );
      let request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, true);
      if (!request) {
        await conn.commit();
        return null;
      }
      if (
        (subject.tenant.state !== "active"
          || subject.user.state !== "active"
          || subject.user.generation !== request.subjectGeneration)
        && request.status !== "revoked"
      ) {
        await this.revokeUserExportsForSubject(conn, tenantId, userId, now);
        request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, false);
      } else if (request.status === "ready" && request.expiresAtMs! <= now) {
        await conn.query(
          `UPDATE user_export_requests
              SET status='expired', updated_at_ms=?
            WHERE request_id=? AND status='ready'`,
          [now, requestId],
        );
        // Expiry closes admission for new downloads immediately. Existing downloads keep their
        // bounded leases; the cleanup scheduler rechecks them under the artifact lock before it
        // publishes any delete intent.
        request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, false);
      }
      await conn.commit();
      return request;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async acquireUserDataExportDownload(
    tenantId: string,
    userId: string,
    requestId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<UserDataExportDownloadLease | null> {
    if (!/^[A-Za-z0-9._:~-]{1,128}$/.test(leaseToken)) {
      throw new Error("invalid export download lease token");
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 60_000) {
      throw new Error("export download lease must be between 1 and 60000 milliseconds");
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        tenantId,
        userId,
        now,
        { userLock: "FOR SHARE", requireActive: false },
      );
      let request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, true);
      if (!request) {
        await conn.commit();
        return null;
      }
      if (
        (subject.tenant.state !== "active"
          || subject.user.state !== "active"
          || subject.user.generation !== request.subjectGeneration)
        && request.status !== "revoked"
      ) {
        await this.revokeUserExportsForSubject(conn, tenantId, userId, now);
        request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, false);
      }
      if (!request || request.status !== "ready" || request.expiresAtMs! <= now) {
        if (request?.status === "ready" && request.expiresAtMs! <= now) {
          await conn.query(
            `UPDATE user_export_requests SET status='expired', updated_at_ms=?
              WHERE request_id=? AND status='ready'`,
            [now, requestId],
          );
        }
        await conn.commit();
        return null;
      }
      const [artifactRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
        [request.currentArtifactId],
      );
      const artifact = artifactRows[0] ? rowToUserDataExportArtifact(artifactRows[0]) : undefined;
      if (
        !artifact
        || artifact.requestId !== request.requestId
        || artifact.tenantId !== tenantId
        || artifact.userId !== userId
        || artifact.subjectGeneration !== request.subjectGeneration
        || artifact.buildGeneration !== request.currentBuildGeneration
        || artifact.state !== "ready"
        || artifact.expiresAtMs === undefined
        || artifact.expiresAtMs <= now
      ) throw new UserDataExportIntegrityError("ready data export artifact is unavailable");
      const [partRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts WHERE artifact_id=? ORDER BY part_number FOR SHARE`,
        [artifact.artifactId],
      );
      const parts = partRows.map((row) => {
        assertUserDataExportPartOwner(row, {
          artifactId: artifact.artifactId,
          requestId: artifact.requestId,
          buildGeneration: artifact.buildGeneration,
          tenantId: artifact.tenantId,
          userId: artifact.userId,
          subjectGeneration: artifact.subjectGeneration,
        });
        return rowToUserDataExportPart(row);
      });
      if (
        artifact.partCount === undefined
        || parts.length !== artifact.partCount
        || parts.some((part, index) => (
          part.partNumber !== index
          || part.state !== "uploaded"
          || part.sha256 === undefined
          || part.sizeBytes === undefined
          || part.storageKey !== userDataExportStorageKey(
            { tenantId, userId },
            request.requestId,
            artifact.artifactId,
            part.partNumber,
          )
        ))
      ) throw new UserDataExportIntegrityError("ready data export artifact parts are incomplete");
      await conn.query(
        "DELETE FROM user_export_download_leases WHERE artifact_id=? AND lease_until_ms<=?",
        [artifact.artifactId, now],
      );
      const [leaseRows] = await conn.query<Row[]>(
        `SELECT artifact_id, lease_token, tenant_id, user_id, request_id, build_generation,
                artifact_deletion_generation, lease_until_ms, created_at_ms, updated_at_ms
           FROM user_export_download_leases
          WHERE artifact_id=? AND lease_token=? FOR UPDATE`,
        [artifact.artifactId, leaseToken],
      );
      const existing = leaseRows[0];
      if (existing && (
        existing.tenant_id !== tenantId
        || existing.user_id !== userId
        || existing.request_id !== requestId
        || Number(existing.build_generation) !== artifact.buildGeneration
        || Number(existing.artifact_deletion_generation) !== artifact.deletionGeneration
      )) throw new UserDataExportIntegrityError("data export download lease identity conflicts");
      const createdAtMs = existing && Number(existing.lease_until_ms) > now
        ? storedSafeInteger(existing.created_at_ms, "data export download lease creation time")
        : now;
      const hardDeadline = createdAtMs + 10 * 60_000;
      const requestedUntilMs = now + leaseMs;
      const existingLeaseUntilMs = existing
        ? storedSafeInteger(existing.lease_until_ms, "data export download lease expiry")
        : 0;
      const leaseUntilMs = Math.min(
        hardDeadline,
        Math.max(existingLeaseUntilMs, requestedUntilMs),
      );
      if (
        !Number.isSafeInteger(hardDeadline)
        || !Number.isSafeInteger(requestedUntilMs)
        || !Number.isSafeInteger(leaseUntilMs)
        || leaseUntilMs <= now
      ) {
        throw new Error("data export download lease expiry overflow");
      }
      await conn.query(
        `INSERT INTO user_export_download_leases
           (artifact_id, lease_token, tenant_id, user_id, request_id, build_generation,
            artifact_deletion_generation, lease_until_ms, created_at_ms, updated_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE lease_until_ms=VALUES(lease_until_ms),
           created_at_ms=VALUES(created_at_ms), updated_at_ms=VALUES(updated_at_ms)`,
        [
          artifact.artifactId,
          leaseToken,
          tenantId,
          userId,
          requestId,
          artifact.buildGeneration,
          artifact.deletionGeneration,
          leaseUntilMs,
          createdAtMs,
          now,
        ],
      );
      await conn.commit();
      return { request, artifact, parts, leaseToken, leaseUntilMs };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewUserDataExportDownload(
    artifactId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (
      !/^[A-Za-z0-9._:~-]{1,128}$/.test(leaseToken)
      || !Number.isSafeInteger(leaseMs)
      || leaseMs < 1
      || leaseMs > 60_000
    ) return false;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const [rows] = await conn.query<Row[]>(
        `SELECT l.lease_until_ms, l.created_at_ms, l.artifact_deletion_generation,
                a.state, a.deletion_generation
           FROM user_export_download_leases l
           JOIN user_export_artifacts a ON a.artifact_id=l.artifact_id
            AND a.request_id=l.request_id AND a.tenant_id=l.tenant_id AND a.user_id=l.user_id
            AND a.build_generation=l.build_generation
           JOIN user_export_requests r ON r.request_id=a.request_id
            AND r.tenant_id=a.tenant_id AND r.user_id=a.user_id
            AND r.subject_generation=a.subject_generation
            AND r.active_build_generation=a.build_generation
            AND r.active_artifact_id=a.artifact_id
           JOIN subject_lifecycle tl ON tl.tenant_id=a.tenant_id
            AND tl.subject_kind='tenant' AND tl.subject_id=a.tenant_id AND tl.state='active'
           JOIN subject_lifecycle ul ON ul.tenant_id=a.tenant_id
            AND ul.subject_kind='user' AND ul.subject_id=a.user_id AND ul.state='active'
            AND ul.generation=a.subject_generation
          WHERE l.artifact_id=? AND l.lease_token=? FOR UPDATE`,
        [artifactId, leaseToken],
      );
      const row = rows[0];
      if (
        !row
        || Number(row.lease_until_ms) <= now
        || row.state !== "ready"
        || Number(row.artifact_deletion_generation) !== Number(row.deletion_generation)
      ) {
        await conn.commit();
        return false;
      }
      const hardDeadline = storedSafeInteger(
        row.created_at_ms,
        "data export download lease creation time",
      ) + 10 * 60_000;
      const leaseUntilMs = Math.min(hardDeadline, now + leaseMs);
      if (!Number.isSafeInteger(leaseUntilMs) || leaseUntilMs <= now) {
        await conn.commit();
        return false;
      }
      await conn.query(
        `UPDATE user_export_download_leases
            SET lease_until_ms=GREATEST(lease_until_ms, ?), updated_at_ms=?
          WHERE artifact_id=? AND lease_token=?`,
        [leaseUntilMs, now, artifactId, leaseToken],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async releaseUserDataExportDownload(artifactId: string, leaseToken: string): Promise<void> {
    if (!/^[A-Za-z0-9._:~-]{1,128}$/.test(leaseToken)) return;
    await this.pool.query(
      "DELETE FROM user_export_download_leases WHERE artifact_id=? AND lease_token=?",
      [artifactId, leaseToken],
    );
  }

  async claimUserDataExports(
    options: ClaimUserDataExportsOptions,
  ): Promise<UserDataExportClaim[]> {
    validateClaimUserDataExportsOptions(options);
    const observedNow = await this.userExportDatabaseNow(this.pool);
    const [candidateRows] = await this.pool.query<Row[]>(
      `SELECT j.request_id, j.tenant_id, j.user_id
         FROM user_export_jobs j FORCE INDEX (idx_user_export_jobs_claim)
         JOIN user_export_requests r ON r.request_id=j.request_id
          AND r.tenant_id=j.tenant_id AND r.user_id=j.user_id
          AND r.subject_generation=j.subject_generation
         JOIN subject_lifecycle tl ON tl.tenant_id=j.tenant_id
          AND tl.subject_kind='tenant' AND tl.subject_id=j.tenant_id AND tl.state='active'
         JOIN subject_lifecycle ul ON ul.tenant_id=j.tenant_id
          AND ul.subject_kind='user' AND ul.subject_id=j.user_id AND ul.state='active'
          AND ul.generation=j.subject_generation
        WHERE j.status IN ('queued','building')
          AND r.status IN ('queued','building')
          AND ((j.status='queued' AND j.available_at_ms IS NOT NULL
                AND j.available_at_ms<=? AND j.claim_token IS NULL
                AND j.lease_until_ms IS NULL)
            OR (j.status='building' AND j.claim_token IS NOT NULL
                AND j.lease_until_ms IS NOT NULL AND j.lease_until_ms<=?))
        ORDER BY j.available_at_ms, j.request_id
        LIMIT ?`,
      [observedNow, observedNow, options.limit],
    );
    const claims: UserDataExportClaim[] = [];
    for (const candidate of candidateRows) {
      const tenantId = String(candidate.tenant_id);
      const userId = String(candidate.user_id);
      const requestId = String(candidate.request_id);
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        const now = await this.userExportDatabaseNow(conn);
        const subject = await this.lockUserExportSubject(
          conn,
          tenantId,
          userId,
          now,
          { userLock: "FOR SHARE", requireActive: true },
        );
        const request = await this.loadUserExportRequest(conn, tenantId, userId, requestId, true);
        const [jobRows] = await conn.query<Row[]>(
          `SELECT ${USER_EXPORT_JOB_COLUMNS}
             FROM user_export_jobs WHERE request_id=? FOR UPDATE`,
          [requestId],
        );
        const job = jobRows[0] ? rowToUserDataExportJob(jobRows[0]) : undefined;
        const claimableQueued = job?.status === "queued"
          && job.availableAtMs !== undefined
          && job.availableAtMs <= now
          && job.claimToken === undefined
          && job.leaseUntilMs === undefined;
        const claimableTakeover = job?.status === "building"
          && job.claimToken !== undefined
          && job.leaseUntilMs !== undefined
          && job.leaseUntilMs <= now;
        if (
          !request
          || !job
          || request.subjectGeneration !== subject.user.generation
          || job.subjectGeneration !== subject.user.generation
          || request.status !== "queued" && request.status !== "building"
          || (!claimableQueued && !claimableTakeover)
        ) {
          await conn.commit();
          continue;
        }
        const sealed = job.snapshotSealedAtMs !== undefined;
        const buildGeneration = sealed ? job.buildGeneration : job.buildGeneration + 1;
        const claimAttempt = job.attempts + 1;
        const leaseUntilMs = now + options.leaseMs;
        if (
          !Number.isSafeInteger(buildGeneration)
          || buildGeneration < 1
          || !Number.isSafeInteger(claimAttempt)
          || claimAttempt < 1
          || !Number.isSafeInteger(leaseUntilMs)
        ) throw new UserDataExportIntegrityError("data export claim counter overflowed");
        if (!sealed && job.activeArtifactId !== undefined) {
          throw new UserDataExportIntegrityError("unsealed data export job references an artifact");
        }
        await conn.query(
          `UPDATE user_export_jobs
              SET status='building', build_generation=?, attempts=?, claim_token=?,
                  lease_until_ms=?, available_at_ms=NULL, last_error_code=NULL, updated_at_ms=?
            WHERE request_id=?`,
          [
            buildGeneration,
            claimAttempt,
            options.claimToken,
            leaseUntilMs,
            now,
            requestId,
          ],
        );
        await conn.query(
          `UPDATE user_export_requests
              SET status='building', active_build_generation=?,
                  active_artifact_id=?, last_error_code=NULL, updated_at_ms=?
            WHERE request_id=?`,
          [buildGeneration, sealed ? (job.activeArtifactId ?? null) : null, now, requestId],
        );
        await conn.commit();
        claims.push({
          requestId,
          tenantId,
          userId,
          subjectGeneration: request.subjectGeneration,
          buildGeneration,
          claimAttempt,
          claimToken: options.claimToken,
          leaseUntilMs,
          policyVersion: request.policyVersion,
          policySha256: request.policySha256,
          artifactTtlMs: request.artifactTtlMs,
        });
      } catch (error) {
        await conn.rollback().catch(() => {});
        if (error instanceof SubjectDeletingError) continue;
        if (error instanceof UserDataExportIntegrityError) {
          await this.quarantineUserExportBuildCandidate(conn, tenantId, userId, requestId);
          continue;
        }
        throw error;
      } finally {
        conn.release();
      }
    }
    return claims;
  }

  async renewUserDataExportClaim(
    authorization: UserDataExportAuthorization,
    leaseMs: number,
  ): Promise<boolean> {
    validateUserDataExportAuthorization(authorization);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error("invalid data export lease duration");
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn,
        authorization,
        now,
        subject.user.generation,
      );
      if (!state) {
        await conn.commit();
        return false;
      }
      const leaseUntilMs = now + leaseMs;
      if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("data export lease expiry overflow");
      await conn.query(
        `UPDATE user_export_jobs
            SET lease_until_ms=GREATEST(lease_until_ms, ?), updated_at_ms=?
          WHERE request_id=?`,
        [leaseUntilMs, now, authorization.requestId],
      );
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      if (error instanceof SubjectDeletingError) return false;
      throw error;
    } finally {
      conn.release();
    }
  }

  async startUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: StartUserDataExportArtifactInput,
  ): Promise<UserDataExportArtifactRecord> {
    validateUserDataExportAuthorization(authorization);
    validateStartUserDataExportArtifactInput(input);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn,
        authorization,
        now,
        subject.user.generation,
      );
      if (!state) throw new UserDataExportStateError("data export claim is no longer active");
      if (
        state.job.snapshotSealedAtMs === undefined
        || state.job.snapshotRootSha256 === undefined
        || state.job.snapshotAtMs === undefined
      ) throw new UserDataExportStateError("data export snapshot must be sealed before artifact creation");
      if (state.job.activeArtifactId !== undefined) {
        const [rows] = await conn.query<Row[]>(
          `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
             FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
          [state.job.activeArtifactId],
        );
        if (!rows[0]) throw new UserDataExportIntegrityError("data export artifact pointer is dangling");
        const artifact = rowToUserDataExportArtifact(rows[0]);
        if (
          artifact.artifactId !== input.artifactId
          || artifact.storageBackend !== input.storageBackend
          || artifact.storageFormat !== input.storageFormat
          || artifact.requestId !== authorization.requestId
          || artifact.buildGeneration !== authorization.buildGeneration
        ) throw new UserDataExportIntegrityError("data export artifact replay conflicts");
        await conn.commit();
        return artifact;
      }
      const stagingExpiresAtMs = now + input.stagingTtlMs;
      if (!Number.isSafeInteger(stagingExpiresAtMs)) {
        throw new Error("data export artifact staging expiry overflow");
      }
      try {
        await conn.query(
          `INSERT INTO user_export_artifacts
             (artifact_id, request_id, tenant_id, user_id, subject_generation, build_generation,
              export_format, export_schema_version, content_type, content_encoding,
              storage_backend, storage_format, state, part_count, record_count, total_size_bytes,
              manifest_sha256, content_sha256, snapshot_root_sha256, policy_version,
              policy_sha256, artifact_ttl_ms, snapshot_at_ms, staging_expires_at_ms, ready_at_ms,
              expires_at_ms, delete_after_ms, deleted_at_ms, deletion_generation, created_at_ms,
              updated_at_ms)
           VALUES (?,?,?,?,?,?,?,? ,?,'identity',?,?,'staging',0,0,0,NULL,NULL,?,?,?, ?,?, ?,NULL,
                   NULL,NULL,NULL,0,?,?)`,
          [
            input.artifactId,
            authorization.requestId,
            authorization.tenantId,
            authorization.userId,
            authorization.subjectGeneration,
            authorization.buildGeneration,
            USER_DATA_EXPORT_FORMAT,
            USER_DATA_EXPORT_SCHEMA_VERSION,
            USER_DATA_EXPORT_CONTENT_TYPE,
            input.storageBackend,
            input.storageFormat,
            state.job.snapshotRootSha256,
            state.request.policyVersion,
            state.request.policySha256,
            state.request.artifactTtlMs,
            state.job.snapshotAtMs,
            stagingExpiresAtMs,
            now,
            now,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new UserDataExportIntegrityError("data export artifact identity conflicts");
        }
        throw error;
      }
      await conn.query(
        "UPDATE user_export_jobs SET active_artifact_id=?, updated_at_ms=? WHERE request_id=?",
        [input.artifactId, now, authorization.requestId],
      );
      await conn.query(
        "UPDATE user_export_requests SET active_artifact_id=?, updated_at_ms=? WHERE request_id=?",
        [input.artifactId, now, authorization.requestId],
      );
      const [rows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=?`,
        [input.artifactId],
      );
      if (!rows[0]) throw new UserDataExportIntegrityError("data export artifact insert was lost");
      const artifact = rowToUserDataExportArtifact(rows[0]);
      await conn.commit();
      return artifact;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async captureAndSealUserDataExportSnapshot(
    authorization: UserDataExportAuthorization,
  ): Promise<UserDataExportSnapshotSummary> {
    validateUserDataExportAuthorization(authorization);
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
      const snapshotAtMs = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        snapshotAtMs,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn,
        authorization,
        snapshotAtMs,
        subject.user.generation,
      );
      if (!state) throw new UserDataExportStateError("data export claim is no longer active");
      if (state.job.snapshotSealedAtMs !== undefined) {
        const summary = await this.userExportSnapshotSummary(conn, state.job);
        await conn.commit();
        return summary;
      }
      if (
        state.job.snapshotAtMs !== undefined
        || state.job.snapshotRootSha256 !== undefined
        || state.job.snapshotRecordCount !== 0
        || state.job.snapshotBlobCount !== 0
      ) throw new UserDataExportIntegrityError("unsealed data export snapshot state is not pristine");
      const [existingRecordRows] = await conn.query<Row[]>(
        `SELECT ordinal FROM user_export_snapshot_records
          WHERE request_id=? AND build_generation=? LIMIT 1`,
        [authorization.requestId, authorization.buildGeneration],
      );
      const [existingBlobRows] = await conn.query<Row[]>(
        `SELECT ordinal FROM user_export_snapshot_blobs
          WHERE request_id=? AND build_generation=? LIMIT 1`,
        [authorization.requestId, authorization.buildGeneration],
      );
      if (existingRecordRows[0] || existingBlobRows[0]) {
        throw new UserDataExportIntegrityError("unsealed data export snapshot has partial durable rows");
      }

      const [sessionRows] = await conn.query<Row[]>(
        `SELECT s.* FROM sessions s FORCE INDEX (idx_sessions_tenant_user)
          WHERE s.tenant_id=? AND s.user_id=? ORDER BY s.session_id`,
        [authorization.tenantId, authorization.userId],
      );
      const sessions = sessionRows.map((row) => {
        const parsed = SessionSchema.parse(rowToSession(row));
        if (
          parsed.id !== row.session_id
          || parsed.tenantId !== authorization.tenantId
          || parsed.userId !== authorization.userId
          || !Number.isSafeInteger(parsed.lastSeq)
          || parsed.lastSeq < 1
        ) throw new UserDataExportIntegrityError("data export session ownership is invalid");
        return {
          row,
          value: parsed,
          deletedAtMs: optionalStoredSafeInteger(
            row.deleted_at_ms,
            "data export session deletion time",
          ),
        };
      });
      const sessionIds = sessions.map(({ value }) => value.id);
      const sessionIdSet = new Set(sessionIds);
      const sessionUsage = await this.loadSessionUsageSummaries(conn, sessionIds);
      const projectedSessions = sessions.map(({ row, value, deletedAtMs }) => ({
        row,
        value: SessionSchema.parse(this.projectSessionUsage(value, sessionUsage.get(value.id))),
        deletedAtMs,
      }));

      const [turnRows] = await conn.query<Row[]>(
        `SELECT t.*
           FROM turns t
           JOIN sessions s ON s.session_id=t.session_id
          WHERE s.tenant_id=? AND s.user_id=?
          ORDER BY t.session_id, t.turn_id`,
        [authorization.tenantId, authorization.userId],
      );
      const rawTurns = turnRows.map((row) => {
        const value = TurnSchema.parse(parse<unknown>(row.body));
        if (
          value.id !== row.turn_id
          || value.sessionId !== row.session_id
          || row.user_id !== authorization.userId
          || !sessionIdSet.has(value.sessionId)
        ) throw new UserDataExportIntegrityError("data export turn ownership is invalid");
        return value;
      });
      const turnIdsBySession = new Map<string, string[]>();
      for (const turn of rawTurns) {
        const ids = turnIdsBySession.get(turn.sessionId) ?? [];
        ids.push(turn.id);
        turnIdsBySession.set(turn.sessionId, ids);
      }
      const turnUsage = new Map<string, UsageProjectionSummary>();
      for (const [sessionId, turnIds] of turnIdsBySession) {
        for (const [turnId, summary] of await this.loadTurnUsageSummaries(conn, sessionId, turnIds)) {
          turnUsage.set(turnId, summary);
        }
      }
      const turns = rawTurns.map((turn) => TurnSchema.parse(
        this.projectTurnUsage(turn, turnUsage.get(turn.id)),
      ));
      const turnById = new Map(turns.map((turn) => [turn.id, turn]));

      const [itemRows] = await conn.query<Row[]>(
        `SELECT i.*
           FROM items i
           JOIN sessions s ON s.session_id=i.session_id
          WHERE s.tenant_id=? AND s.user_id=?
          ORDER BY i.session_id, i.item_id`,
        [authorization.tenantId, authorization.userId],
      );
      let items = itemRows.map((row) => {
        const value = ItemSchema.parse(parse<unknown>(row.body));
        const turn = turnById.get(value.turnId);
        if (
          value.id !== row.item_id
          || value.sessionId !== row.session_id
          || value.turnId !== row.turn_id
          || value.seq !== Number(row.seq)
          || value.type !== row.type
          || value.status !== row.status
          || row.user_id !== authorization.userId
          || !turn
          || turn.sessionId !== value.sessionId
        ) throw new UserDataExportIntegrityError("data export item ownership is invalid");
        return value;
      });
      const compactionsBySession = new Map<string, { turnId: string; step: number }[]>();
      for (const item of items) {
        if (item.type !== "contextCompaction" || item.usageSnapshot === undefined) continue;
        const keys = compactionsBySession.get(item.sessionId) ?? [];
        keys.push({ turnId: item.turnId, step: 0 });
        compactionsBySession.set(item.sessionId, keys);
      }
      const exactUsageBySession = new Map<string, Map<string, UsageProjectionLedgerRow>>();
      for (const [sessionId, keys] of compactionsBySession) {
        exactUsageBySession.set(
          sessionId,
          await this.loadExactUsageProjectionRows(conn, sessionId, keys),
        );
      }
      items = items.map((item) => ItemSchema.parse(canonicalizeUsageItem(
        item,
        exactUsageBySession.get(item.sessionId)?.get(usageProjectionStepKey(item.turnId, 0)),
      )));
      const itemById = new Map(items.map((item) => [item.id, item]));

      const [eventRows] = await conn.query<Row[]>(
        `SELECT e.*
           FROM events e
           JOIN sessions s ON s.session_id=e.session_id
          WHERE s.tenant_id=? AND s.user_id=?
          ORDER BY e.session_id, e.seq`,
        [authorization.tenantId, authorization.userId],
      );
      const rawEventsBySession = new Map<string, PersistedEvent[]>();
      for (const row of eventRows) {
        const value = EventSchema.parse(parse<unknown>(row.body));
        if (
          !("seq" in value)
          || value.sessionId !== row.session_id
          || value.seq !== Number(row.seq)
          || value.type !== row.type
          || value.emittedAtMs !== Number(row.emitted_at_ms)
          || row.user_id !== authorization.userId
          || !sessionIdSet.has(value.sessionId)
        ) throw new UserDataExportIntegrityError("data export event ownership is invalid");
        const events = rawEventsBySession.get(value.sessionId) ?? [];
        events.push(value as PersistedEvent);
        rawEventsBySession.set(value.sessionId, events);
      }
      const events: PersistedEvent[] = [];
      for (const { value: session } of projectedSessions) {
        const raw = rawEventsBySession.get(session.id) ?? [];
        if (
          raw.length !== session.lastSeq
          || raw.some((event, index) => event.seq !== index + 1)
        ) throw new UserDataExportIntegrityError("data export event sequence is incomplete");
        const relevantTurnIds: string[] = [];
        const exactKeys: { turnId: string; step: number }[] = [];
        const prefixKeys: { turnId: string; step: number }[] = [];
        for (const event of raw) {
          if (event.type === "turn/completed") relevantTurnIds.push(event.turn.id);
          if (event.type === "usage/updated") {
            relevantTurnIds.push(event.turnId);
            exactKeys.push({ turnId: event.turnId, step: event.step });
            prefixKeys.push({ turnId: event.turnId, step: event.step });
          }
          if (
            (event.type === "item/started" || event.type === "item/completed")
            && event.item.type === "contextCompaction"
            && event.item.usageSnapshot !== undefined
          ) exactKeys.push({ turnId: event.item.turnId, step: 0 });
        }
        const eventTurns = await this.loadTurnUsageSummaries(conn, session.id, relevantTurnIds);
        const eventPrefixes = await this.loadTurnPrefixUsageSummaries(conn, session.id, prefixKeys);
        const eventExact = await this.loadExactUsageProjectionRows(conn, session.id, exactKeys);
        for (const event of raw) {
          const canonical = canonicalizePersistedUsageEventFromSummaries(event, {
            session: sessionUsage.get(session.id) ?? emptyUsageProjectionSummary(),
            turns: eventTurns,
            turnPrefixes: eventPrefixes,
            exactRows: eventExact,
          });
          events.push(EventSchema.parse(sanitizeExportEvent(canonical)) as PersistedEvent);
        }
      }

      const [approvalRows] = await conn.query<Row[]>(
        `SELECT a.*
           FROM approvals a
           JOIN sessions s ON s.session_id=a.session_id
          WHERE s.tenant_id=? AND s.user_id=?
          ORDER BY a.session_id, a.approval_id`,
        [authorization.tenantId, authorization.userId],
      );
      const approvals = approvalRows.map((row) => {
        const value = ApprovalSchema.parse(parse<unknown>(row.body));
        const turn = turnById.get(value.turnId);
        const item = itemById.get(value.itemId);
        if (
          value.id !== row.approval_id
          || value.sessionId !== row.session_id
          || value.turnId !== row.turn_id
          || value.status !== row.status
          || row.user_id !== authorization.userId
          || !turn
          || turn.sessionId !== value.sessionId
          || !item
          || item.sessionId !== value.sessionId
          || item.turnId !== value.turnId
        ) throw new UserDataExportIntegrityError("data export approval ownership is invalid");
        return value;
      });

      const [usageRows] = await conn.query<Row[]>(
        `SELECT u.usage_id, u.tenant_id, u.user_id, u.session_id, u.turn_id, u.step,
                u.provider, u.model, u.usage_json, u.created_at_ms,
                s.tenant_id AS session_tenant_id, s.user_id AS session_user_id
           FROM usage_ledger u
           LEFT JOIN sessions s ON s.session_id=u.session_id
          WHERE (u.tenant_id=? AND u.user_id=?)
             OR (s.tenant_id=? AND s.user_id=?)
          ORDER BY u.session_id, u.turn_id, u.step, u.id`,
        [
          authorization.tenantId,
          authorization.userId,
          authorization.tenantId,
          authorization.userId,
        ],
      );
      const usageEntries: Extract<UserDataExportSnapshotEntry, { type: "operational_usage" }>[] = [];
      const usageKeys = new Set<string>();
      for (const row of usageRows) {
        const projection = rowToUsageProjection(row);
        const turn = turnById.get(projection.turnId);
        const step = storedSafeInteger(row.step, "data export usage step");
        const logicalKey = canonicalUserDataExportJson([
          "operational_usage",
          projection.sessionId,
          projection.turnId,
          step,
        ]);
        if (
          row.session_tenant_id !== authorization.tenantId
          || row.session_user_id !== authorization.userId
          || projection.tenantId !== authorization.tenantId
          || projection.userId !== authorization.userId
          || !sessionIdSet.has(projection.sessionId)
          || !turn
          || turn.sessionId !== projection.sessionId
          || usageKeys.has(logicalKey)
        ) throw new UserDataExportIntegrityError("data export usage ownership is invalid");
        usageKeys.add(logicalKey);
        usageEntries.push({
          type: "operational_usage",
          value: {
            sessionId: projection.sessionId,
            turnId: projection.turnId,
            step,
            provider: String(row.provider),
            model: String(row.model),
            usage: projection.usage,
            createdAtMs: storedSafeInteger(row.created_at_ms, "data export usage creation time"),
          },
        });
      }

      const [blobRows] = await conn.query<Row[]>(
        `SELECT ${QUALIFIED_BLOB_COLUMNS},
                s.tenant_id AS session_tenant_id, s.user_id AS session_user_id
           FROM blob_objects b
           LEFT JOIN sessions s ON s.session_id=b.session_id
          WHERE b.state='ready' AND ((b.tenant_id=? AND b.user_id=?)
             OR (s.tenant_id=? AND s.user_id=?))
          ORDER BY b.blob_id`,
        [
          authorization.tenantId,
          authorization.userId,
          authorization.tenantId,
          authorization.userId,
        ],
      );
      const manifests = blobRows.map((row) => {
        const manifest = rowToBlobManifest(row);
        if (
          row.session_tenant_id !== authorization.tenantId
          || row.session_user_id !== authorization.userId
          || manifest.tenantId !== authorization.tenantId
          || manifest.userId !== authorization.userId
          || !sessionIdSet.has(manifest.sessionId)
          || !isValidReadyPurgeBlobManifest(manifest)
        ) throw new UserDataExportIntegrityError("data export attachment ownership is invalid");
        return manifest;
      });
      const bindings = blobBindingsFromItems(items);
      const bindingByBlob = new Map<string, BlobBinding>();
      for (const binding of bindings) {
        if (bindingByBlob.has(binding.blobId)) {
          throw new UserDataExportIntegrityError("data export attachment is referenced more than once");
        }
        bindingByBlob.set(binding.blobId, binding);
      }
      if (manifests.length !== bindingByBlob.size) {
        throw new UserDataExportIntegrityError("data export attachment manifest is incomplete");
      }
      const snapshotBlobs = manifests.map((manifest) => {
        const binding = bindingByBlob.get(manifest.blobId);
        if (
          !binding
          || binding.itemId !== manifest.itemId
          || binding.purpose !== manifest.purpose
          || !itemById.has(binding.itemId)
          || manifest.sha256 === undefined
          || manifest.sizeBytes === undefined
        ) throw new UserDataExportIntegrityError("data export attachment binding is invalid");
        const pinToken = createHash("sha256")
          .update(canonicalUserDataExportJson([
            "agent-service/user-data-export-pin/v1",
            authorization.requestId,
            authorization.buildGeneration,
            manifest.blobId,
          ]))
          .digest("hex");
        return {
          requestId: authorization.requestId,
          buildGeneration: authorization.buildGeneration,
          blobId: manifest.blobId,
          sessionId: manifest.sessionId,
          itemId: manifest.itemId,
          purpose: manifest.purpose,
          ...(manifest.contentType === undefined ? {} : { contentType: manifest.contentType }),
          sha256: manifest.sha256,
          sizeBytes: manifest.sizeBytes,
          storageBackend: manifest.storageBackend,
          storageFormat: manifest.storageFormat,
          storageKey: manifest.storageKey,
          sourceUploadToken: manifest.uploadToken,
          sourceDeletionGeneration: manifest.deletionGeneration,
          pinToken,
          pinnedAtMs: snapshotAtMs,
        } satisfies Omit<UserDataExportSnapshotBlob, "ordinal">;
      }).sort((left, right) => {
        const a = userDataExportAttachmentLogicalKey(left);
        const b = userDataExportAttachmentLogicalKey(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }).map((blob, ordinal) => ({ ...blob, ordinal }));

      if (snapshotBlobs.length > 0) {
        const placeholders = snapshotBlobs.map(() => "?").join(",");
        const [currentBlobRows] = await conn.query<Row[]>(
          `SELECT ${BLOB_COLUMNS} FROM blob_objects
            WHERE blob_id IN (${placeholders}) ORDER BY blob_id FOR SHARE`,
          snapshotBlobs.map((blob) => blob.blobId),
        );
        const current = new Map(currentBlobRows.map((row) => {
          const manifest = rowToBlobManifest(row);
          return [manifest.blobId, manifest] as const;
        }));
        for (const blob of snapshotBlobs) {
          const manifest = current.get(blob.blobId);
          if (
            !manifest
            || manifest.state !== "ready"
            || manifest.tenantId !== authorization.tenantId
            || manifest.userId !== authorization.userId
            || manifest.sessionId !== blob.sessionId
            || manifest.itemId !== blob.itemId
            || manifest.purpose !== blob.purpose
            || manifest.storageBackend !== blob.storageBackend
            || manifest.storageFormat !== blob.storageFormat
            || manifest.storageKey !== blob.storageKey
            || manifest.uploadToken !== blob.sourceUploadToken
            || manifest.deletionGeneration !== blob.sourceDeletionGeneration
            || manifest.sha256 !== blob.sha256
            || manifest.sizeBytes !== blob.sizeBytes
            || manifest.contentType !== blob.contentType
          ) throw new UserDataExportIntegrityError("data export attachment changed during snapshot capture");
        }
      }

      type RecordCandidate = {
        kind: Exclude<UserDataExportSnapshotEntry["type"], "attachment">;
        logicalKey: string;
        entry: Exclude<UserDataExportSnapshotEntry, { type: "attachment" }>;
      };
      const candidates: RecordCandidate[] = [];
      for (const { value, deletedAtMs } of projectedSessions) {
        candidates.push({
          kind: "session",
          logicalKey: canonicalUserDataExportJson(["session", value.id]),
          entry: { type: "session", value: sanitizeExportSession(value, deletedAtMs) },
        });
      }
      for (const value of turns) {
        candidates.push({
          kind: "turn",
          logicalKey: canonicalUserDataExportJson(["turn", value.sessionId, value.id]),
          entry: { type: "turn", value: sanitizeExportTurn(value) },
        });
      }
      for (const value of items) {
        candidates.push({
          kind: "item",
          logicalKey: canonicalUserDataExportJson(["item", value.sessionId, value.id]),
          entry: { type: "item", value },
        });
      }
      for (const value of events) {
        candidates.push({
          kind: "event",
          logicalKey: canonicalUserDataExportJson(["event", value.sessionId, value.seq]),
          entry: { type: "event", value },
        });
      }
      for (const value of approvals) {
        candidates.push({
          kind: "approval",
          logicalKey: canonicalUserDataExportJson(["approval", value.sessionId, value.id]),
          entry: { type: "approval", value },
        });
      }
      for (const entry of usageEntries) {
        candidates.push({
          kind: "operational_usage",
          logicalKey: canonicalUserDataExportJson([
            "operational_usage",
            entry.value.sessionId,
            entry.value.turnId,
            entry.value.step,
          ]),
          entry,
        });
      }
      const kindOrder = new Map(USER_DATA_EXPORT_RECORD_KIND_ORDER.map((kind, index) => [kind, index]));
      candidates.sort((left, right) => {
        const kind = kindOrder.get(left.kind)! - kindOrder.get(right.kind)!;
        if (kind !== 0) return kind;
        return left.logicalKey < right.logicalKey ? -1 : left.logicalKey > right.logicalKey ? 1 : 0;
      });
      const records: UserDataExportSnapshotRecord[] = candidates.map((candidate, ordinal) => {
        let canonicalBytes: Buffer;
        try {
          canonicalBytes = canonicalUserDataExportBytes(candidate.entry);
        } catch (error) {
          if (error instanceof UserDataExportIntegrityError) {
            throw new UserDataExportIntegrityError(
              `data export ${candidate.kind} record cannot be serialized`,
            );
          }
          throw error;
        }
        return {
          requestId: authorization.requestId,
          buildGeneration: authorization.buildGeneration,
          ordinal,
          kind: candidate.kind,
          logicalKey: candidate.logicalKey,
          canonicalBytes,
          sha256: createHash("sha256").update(canonicalBytes).digest("hex"),
          sizeBytes: canonicalBytes.byteLength,
        };
      });
      let snapshotRootSha256 = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
      for (const record of records) {
        snapshotRootSha256 = nextUserDataExportSnapshotRootSha256(
          snapshotRootSha256,
          record.kind,
          record.logicalKey,
          record.sha256,
          record.sizeBytes,
        );
      }
      for (const blob of snapshotBlobs) {
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
        snapshotRootSha256 = nextUserDataExportSnapshotRootSha256(
          snapshotRootSha256,
          "attachment",
          userDataExportAttachmentLogicalKey(publicAttachment),
          createHash("sha256").update(canonicalBytes).digest("hex"),
          canonicalBytes.byteLength,
        );
      }

      for (const record of records) {
        await conn.query(
          `INSERT INTO user_export_snapshot_records
             (request_id, build_generation, ordinal, tenant_id, user_id, subject_generation,
              record_kind, logical_key, canonical_utf8_bytes, record_sha256, size_bytes,
              captured_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            record.requestId,
            record.buildGeneration,
            record.ordinal,
            authorization.tenantId,
            authorization.userId,
            authorization.subjectGeneration,
            record.kind,
            record.logicalKey,
            record.canonicalBytes,
            record.sha256,
            record.sizeBytes,
            snapshotAtMs,
          ],
        );
      }
      for (const blob of snapshotBlobs) {
        await conn.query(
          `INSERT INTO user_export_snapshot_blobs
             (request_id, build_generation, ordinal, blob_id, tenant_id, user_id,
              subject_generation, session_id, item_id, purpose, storage_backend, storage_format,
              storage_key, upload_token, source_deletion_generation, source_sha256,
              source_size_bytes, source_content_type, pin_token, pinned_at_ms, released_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
          [
            blob.requestId,
            blob.buildGeneration,
            blob.ordinal,
            blob.blobId,
            authorization.tenantId,
            authorization.userId,
            authorization.subjectGeneration,
            blob.sessionId,
            blob.itemId ?? null,
            blob.purpose,
            blob.storageBackend,
            blob.storageFormat,
            blob.storageKey,
            blob.sourceUploadToken,
            blob.sourceDeletionGeneration,
            blob.sha256,
            blob.sizeBytes,
            blob.contentType ?? null,
            blob.pinToken,
            snapshotAtMs,
          ],
        );
      }
      const sealNow = await this.userExportDatabaseNow(conn);
      const [updated] = await conn.query<mysql.ResultSetHeader>(
        `UPDATE user_export_jobs
            SET snapshot_at_ms=?, snapshot_record_count=?, snapshot_blob_count=?,
                snapshot_root_sha256=?, snapshot_sealed_at_ms=?, updated_at_ms=?
          WHERE request_id=? AND build_generation=? AND status='building'
            AND attempts=? AND claim_token=? AND snapshot_sealed_at_ms IS NULL`,
        [
          snapshotAtMs,
          records.length,
          snapshotBlobs.length,
          snapshotRootSha256,
          sealNow,
          sealNow,
          authorization.requestId,
          authorization.buildGeneration,
          authorization.claimAttempt,
          authorization.claimToken,
        ],
      );
      if (updated.affectedRows !== 1) {
        throw new UserDataExportStateError("data export claim changed before snapshot seal");
      }
      await conn.query(
        `UPDATE user_export_requests SET snapshot_at_ms=?, updated_at_ms=?
          WHERE request_id=? AND status='building' AND active_build_generation=?`,
        [snapshotAtMs, sealNow, authorization.requestId, authorization.buildGeneration],
      );
      const counts = Object.fromEntries(
        [...USER_DATA_EXPORT_RECORD_KIND_ORDER, "attachment"].map((kind) => [kind, 0]),
      ) as Record<UserDataExportSnapshotEntry["type"], number>;
      for (const record of records) counts[record.kind] += 1;
      counts.attachment = snapshotBlobs.length;
      const recordCount = records.length + snapshotBlobs.length;
      const summary: UserDataExportSnapshotSummary = {
        snapshotAtMs,
        counts,
        recordCount,
        snapshotRootSha256,
      };
      await conn.commit();
      return summary;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async readUserDataExportSnapshotRecords(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotRecordPage> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000
      || (options.afterOrdinal !== undefined && (
        !Number.isSafeInteger(options.afterOrdinal) || options.afterOrdinal < 0
      ))
    ) throw new Error("invalid data export snapshot record page");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state || state.job.snapshotSealedAtMs === undefined) {
        throw new UserDataExportStateError("data export snapshot is not readable");
      }
      const params: unknown[] = [
        authorization.requestId,
        authorization.buildGeneration,
        authorization.tenantId,
        authorization.userId,
        authorization.subjectGeneration,
      ];
      const cursor = options.afterOrdinal === undefined ? "" : " AND ordinal>?";
      if (options.afterOrdinal !== undefined) params.push(options.afterOrdinal);
      params.push(options.limit + 1);
      const [rows] = await conn.query<Row[]>(
        `SELECT request_id, build_generation, ordinal, tenant_id, user_id, subject_generation,
                record_kind, logical_key, canonical_utf8_bytes, record_sha256, size_bytes
           FROM user_export_snapshot_records
          WHERE request_id=? AND build_generation=? AND tenant_id=? AND user_id=?
            AND subject_generation=?${cursor}
          ORDER BY ordinal LIMIT ?`,
        params,
      );
      const hasMore = rows.length > options.limit;
      const data = rows.slice(0, options.limit).map((row): UserDataExportSnapshotRecord => {
        const canonicalBytes = Buffer.from(row.canonical_utf8_bytes);
        const record: UserDataExportSnapshotRecord = {
          requestId: String(row.request_id),
          buildGeneration: storedSafeInteger(row.build_generation, "snapshot record build", 1),
          ordinal: storedSafeInteger(row.ordinal, "snapshot record ordinal"),
          kind: String(row.record_kind) as UserDataExportSnapshotRecord["kind"],
          logicalKey: String(row.logical_key),
          canonicalBytes,
          sha256: String(row.record_sha256),
          sizeBytes: storedSafeInteger(row.size_bytes, "snapshot record size"),
        };
        if (
          record.requestId !== authorization.requestId
          || record.buildGeneration !== authorization.buildGeneration
          || !USER_DATA_EXPORT_RECORD_KIND_ORDER.includes(record.kind)
          || record.sizeBytes !== canonicalBytes.byteLength
          || createHash("sha256").update(canonicalBytes).digest("hex") !== record.sha256
        ) throw new UserDataExportIntegrityError("stored data export snapshot record is invalid");
        return record;
      });
      await conn.commit();
      return {
        data,
        nextOrdinal: hasMore ? (data.at(-1)?.ordinal ?? null) : null,
      };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async readUserDataExportSnapshotBlobs(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotBlobPage> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000
      || (options.afterOrdinal !== undefined && (
        !Number.isSafeInteger(options.afterOrdinal) || options.afterOrdinal < 0
      ))
    ) throw new Error("invalid data export snapshot blob page");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state || state.job.snapshotSealedAtMs === undefined) {
        throw new UserDataExportStateError("data export snapshot is not readable");
      }
      const params: unknown[] = [
        authorization.requestId,
        authorization.buildGeneration,
        authorization.tenantId,
        authorization.userId,
        authorization.subjectGeneration,
      ];
      const cursor = options.afterOrdinal === undefined ? "" : " AND ordinal>?";
      if (options.afterOrdinal !== undefined) params.push(options.afterOrdinal);
      params.push(options.limit + 1);
      const [rows] = await conn.query<Row[]>(
        `SELECT request_id, build_generation, ordinal, blob_id, tenant_id, user_id,
                subject_generation, session_id, item_id, purpose, storage_backend,
                storage_format, storage_key, upload_token, source_deletion_generation,
                source_sha256, source_size_bytes, source_content_type, pin_token, pinned_at_ms,
                released_at_ms
           FROM user_export_snapshot_blobs
          WHERE request_id=? AND build_generation=? AND tenant_id=? AND user_id=?
            AND subject_generation=? AND released_at_ms IS NULL${cursor}
          ORDER BY ordinal LIMIT ?`,
        params,
      );
      const hasMore = rows.length > options.limit;
      const data = rows.slice(0, options.limit).map((row): UserDataExportSnapshotBlob => {
        const blob: UserDataExportSnapshotBlob = {
          requestId: String(row.request_id),
          buildGeneration: storedSafeInteger(row.build_generation, "snapshot blob build", 1),
          ordinal: storedSafeInteger(row.ordinal, "snapshot blob ordinal"),
          blobId: String(row.blob_id),
          sessionId: String(row.session_id),
          ...(row.item_id == null ? {} : { itemId: String(row.item_id) }),
          purpose: String(row.purpose) as UserDataExportSnapshotBlob["purpose"],
          ...(row.source_content_type == null
            ? {}
            : { contentType: String(row.source_content_type) }),
          sha256: String(row.source_sha256),
          sizeBytes: storedSafeInteger(row.source_size_bytes, "snapshot blob size"),
          storageBackend: String(row.storage_backend),
          storageFormat: String(row.storage_format),
          storageKey: String(row.storage_key),
          sourceUploadToken: String(row.upload_token),
          sourceDeletionGeneration: storedSafeInteger(
            row.source_deletion_generation,
            "snapshot blob source deletion generation",
          ),
          pinToken: String(row.pin_token),
          pinnedAtMs: storedSafeInteger(row.pinned_at_ms, "snapshot blob pin time"),
        };
        if (
          blob.requestId !== authorization.requestId
          || blob.buildGeneration !== authorization.buildGeneration
          || (blob.purpose !== "input_image" && blob.purpose !== "tool_output")
          || !/^[0-9a-f]{64}$/.test(blob.sha256)
          || !blob.storageBackend
          || !blob.storageFormat
          || !blob.storageKey
          || !blob.sourceUploadToken
          || !blob.pinToken
        ) throw new UserDataExportIntegrityError("stored data export snapshot blob is invalid");
        return blob;
      });
      await conn.commit();
      return {
        data,
        nextOrdinal: hasMore ? (data.at(-1)?.ordinal ?? null) : null,
      };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async getUserDataExportArtifactBuild(
    authorization: UserDataExportAuthorization,
  ): Promise<{ artifact: UserDataExportArtifactRecord | null; parts: UserDataExportArtifactPart[] }> {
    validateUserDataExportAuthorization(authorization);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state) throw new UserDataExportStateError("data export claim is no longer active");
      if (!state.job.activeArtifactId) {
        await conn.commit();
        return { artifact: null, parts: [] };
      }
      const [artifactRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=? FOR SHARE`,
        [state.job.activeArtifactId],
      );
      if (!artifactRows[0]) throw new UserDataExportIntegrityError("data export artifact pointer is dangling");
      const artifact = rowToUserDataExportArtifact(artifactRows[0]);
      if (
        artifact.requestId !== authorization.requestId
        || artifact.tenantId !== authorization.tenantId
        || artifact.userId !== authorization.userId
        || artifact.subjectGeneration !== authorization.subjectGeneration
        || artifact.buildGeneration !== authorization.buildGeneration
      ) throw new UserDataExportIntegrityError("data export artifact owner is invalid");
      const [partRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts WHERE artifact_id=? ORDER BY part_number`,
        [artifact.artifactId],
      );
      const parts = partRows.map((row) => {
        assertUserDataExportPartOwner(row, {
          artifactId: artifact.artifactId,
          requestId: artifact.requestId,
          buildGeneration: artifact.buildGeneration,
          tenantId: artifact.tenantId,
          userId: artifact.userId,
          subjectGeneration: artifact.subjectGeneration,
        });
        return rowToUserDataExportPart(row);
      });
      if (parts.some((part, index) => (
        part.requestId !== authorization.requestId
        || part.buildGeneration !== authorization.buildGeneration
        || part.partNumber !== index
        || part.storageKey !== userDataExportStorageKey(
          { tenantId: authorization.tenantId, userId: authorization.userId },
          authorization.requestId,
          artifact.artifactId,
          part.partNumber,
        )
      ))) throw new UserDataExportIntegrityError("data export artifact part owner is invalid");
      await conn.commit();
      return { artifact, parts };
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async stageUserDataExportPart(
    authorization: UserDataExportAuthorization,
    input: StageUserDataExportPartInput,
  ): Promise<UserDataExportArtifactPart> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isSafeInteger(input.partNumber)
      || input.partNumber < 0
      || !input.storageBackend
      || input.storageBackend.length > 32
      || !input.storageFormat
      || input.storageFormat.length > 64
    ) throw new Error("invalid data export artifact part input");
    validateBlobKey(input.storageKey);
    validateBlobUploadToken(input.uploadToken);
    if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) {
      throw new Error("invalid data export artifact upload token");
    }
    if (input.storageKey !== userDataExportStorageKey(
      { tenantId: authorization.tenantId, userId: authorization.userId },
      authorization.requestId,
      input.artifactId,
      input.partNumber,
    )) throw new UserDataExportIntegrityError("data export artifact storage key is not canonical");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state) throw new UserDataExportStateError("data export claim is no longer active");
      if (state.job.activeArtifactId !== input.artifactId) {
        throw new UserDataExportStateError("data export artifact is no longer active");
      }
      const [artifactRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
        [input.artifactId],
      );
      if (!artifactRows[0]) throw new UserDataExportIntegrityError("data export artifact is missing");
      const artifact = rowToUserDataExportArtifact(artifactRows[0]);
      if (
        artifact.state !== "staging"
        || artifact.requestId !== authorization.requestId
        || artifact.buildGeneration !== authorization.buildGeneration
        || artifact.storageBackend !== input.storageBackend
        || artifact.storageFormat !== input.storageFormat
      ) throw new UserDataExportStateError("data export artifact cannot accept parts");
      const [existingRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts
          WHERE artifact_id=? AND part_number=? FOR UPDATE`,
        [input.artifactId, input.partNumber],
      );
      if (existingRows[0]) {
        assertUserDataExportPartOwner(existingRows[0], {
          artifactId: artifact.artifactId,
          requestId: artifact.requestId,
          buildGeneration: artifact.buildGeneration,
          tenantId: artifact.tenantId,
          userId: artifact.userId,
          subjectGeneration: artifact.subjectGeneration,
        });
        const existing = rowToUserDataExportPart(existingRows[0]);
        if (
          existing.requestId !== authorization.requestId
          || existing.buildGeneration !== authorization.buildGeneration
          || existing.storageBackend !== input.storageBackend
          || existing.storageFormat !== input.storageFormat
          || existing.storageKey !== input.storageKey
          || existing.uploadToken !== input.uploadToken
        ) throw new UserDataExportIntegrityError("data export artifact part replay conflicts");
        await conn.commit();
        return existing;
      }
      if (input.partNumber > 0) {
        const [priorRows] = await conn.query<Row[]>(
          `SELECT state FROM user_export_artifact_parts
            WHERE artifact_id=? AND part_number=? FOR SHARE`,
          [input.artifactId, input.partNumber - 1],
        );
        if (priorRows[0]?.state !== "uploaded") {
          throw new UserDataExportStateError("data export artifact parts must be staged in order");
        }
      }
      try {
        await conn.query(
          `INSERT INTO user_export_artifact_parts
             (artifact_id, part_number, request_id, build_generation, tenant_id, user_id,
              subject_generation, state, storage_backend, storage_format, storage_key,
              upload_token, content_type, content_encoding, sha256, size_bytes, record_count,
              staging_expires_at_ms, uploaded_at_ms, delete_after_ms, deleted_at_ms,
              deletion_generation, created_at_ms, updated_at_ms)
           VALUES (?,?,?,?,?,?,?,'staging',?,?,?,?,NULL,'identity',NULL,NULL,NULL,?,NULL,NULL,NULL,0,?,?)`,
          [
            input.artifactId,
            input.partNumber,
            authorization.requestId,
            authorization.buildGeneration,
            authorization.tenantId,
            authorization.userId,
            authorization.subjectGeneration,
            input.storageBackend,
            input.storageFormat,
            input.storageKey,
            input.uploadToken,
            artifact.stagingExpiresAtMs,
            now,
            now,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
          throw new UserDataExportIntegrityError("data export artifact part identity conflicts");
        }
        throw error;
      }
      const [rows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts WHERE artifact_id=? AND part_number=?`,
        [input.artifactId, input.partNumber],
      );
      if (!rows[0]) throw new UserDataExportIntegrityError("data export artifact part insert was lost");
      assertUserDataExportPartOwner(rows[0], {
        artifactId: artifact.artifactId,
        requestId: artifact.requestId,
        buildGeneration: artifact.buildGeneration,
        tenantId: artifact.tenantId,
        userId: artifact.userId,
        subjectGeneration: artifact.subjectGeneration,
      });
      const part = rowToUserDataExportPart(rows[0]);
      await conn.commit();
      return part;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async markUserDataExportPartUploaded(
    authorization: UserDataExportAuthorization,
    input: MarkUserDataExportPartUploadedInput,
  ): Promise<UserDataExportArtifactPart> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isSafeInteger(input.partNumber)
      || input.partNumber < 0
      || input.descriptor.storageKey.length < 1
      || !/^[0-9a-f]{64}$/.test(input.descriptor.sha256)
      || !Number.isSafeInteger(input.descriptor.sizeBytes)
      || input.descriptor.sizeBytes < 0
    ) throw new Error("invalid uploaded data export part descriptor");
    validateBlobKey(input.descriptor.storageKey);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state || state.job.activeArtifactId !== input.artifactId) {
        throw new UserDataExportStateError("data export artifact claim is no longer active");
      }
      const [rows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts
          WHERE artifact_id=? AND part_number=? FOR UPDATE`,
        [input.artifactId, input.partNumber],
      );
      if (!rows[0]) throw new UserDataExportStateError("data export artifact part is missing");
      assertUserDataExportPartOwner(rows[0], {
        artifactId: input.artifactId,
        requestId: authorization.requestId,
        buildGeneration: authorization.buildGeneration,
        tenantId: authorization.tenantId,
        userId: authorization.userId,
        subjectGeneration: authorization.subjectGeneration,
      });
      const part = rowToUserDataExportPart(rows[0]);
      if (
        part.requestId !== authorization.requestId
        || part.buildGeneration !== authorization.buildGeneration
        || part.storageKey !== input.descriptor.storageKey
        || input.descriptor.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
      ) throw new UserDataExportIntegrityError("uploaded data export part identity is invalid");
      if (part.state === "uploaded") {
        if (
          part.sha256 !== input.descriptor.sha256
          || part.sizeBytes !== input.descriptor.sizeBytes
          || part.contentType !== input.descriptor.contentType
        ) throw new UserDataExportIntegrityError("uploaded data export part replay conflicts");
        await conn.commit();
        return part;
      }
      if (part.state !== "staging") {
        throw new UserDataExportStateError("data export artifact part cannot be uploaded");
      }
      await conn.query(
        `UPDATE user_export_artifact_parts
            SET state='uploaded', sha256=?, size_bytes=?, content_type=?, uploaded_at_ms=?,
                updated_at_ms=?
          WHERE artifact_id=? AND part_number=?`,
        [
          input.descriptor.sha256,
          input.descriptor.sizeBytes,
          input.descriptor.contentType,
          now,
          now,
          input.artifactId,
          input.partNumber,
        ],
      );
      const [updatedRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts WHERE artifact_id=? AND part_number=?`,
        [input.artifactId, input.partNumber],
      );
      assertUserDataExportPartOwner(updatedRows[0]!, {
        artifactId: input.artifactId,
        requestId: authorization.requestId,
        buildGeneration: authorization.buildGeneration,
        tenantId: authorization.tenantId,
        userId: authorization.userId,
        subjectGeneration: authorization.subjectGeneration,
      });
      const uploaded = rowToUserDataExportPart(updatedRows[0]!);
      await conn.commit();
      return uploaded;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async completeUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: CompleteUserDataExportArtifactInput,
  ): Promise<UserDataExportRequestRecord> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isSafeInteger(input.snapshotAtMs)
      || input.snapshotAtMs < 0
      || !Number.isSafeInteger(input.partCount)
      || input.partCount < 1
      || !Number.isSafeInteger(input.recordCount)
      || input.recordCount < 0
      || !Number.isSafeInteger(input.totalSizeBytes)
      || input.totalSizeBytes < 0
      || !/^[0-9a-f]{64}$/.test(input.contentSha256)
      || !/^[0-9a-f]{64}$/.test(input.manifestSha256)
    ) throw new Error("invalid completed data export artifact");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state || state.job.activeArtifactId !== input.artifactId) {
        throw new UserDataExportStateError("data export artifact claim is no longer active");
      }
      const summary = await this.userExportSnapshotSummary(conn, state.job);
      if (
        summary.snapshotAtMs !== input.snapshotAtMs
        || summary.recordCount !== input.recordCount
      ) throw new UserDataExportIntegrityError("data export artifact does not match its snapshot");
      const [artifactRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
        [input.artifactId],
      );
      if (!artifactRows[0]) throw new UserDataExportIntegrityError("data export artifact is missing");
      const artifact = rowToUserDataExportArtifact(artifactRows[0]);
      if (
        artifact.requestId !== authorization.requestId
        || artifact.tenantId !== authorization.tenantId
        || artifact.userId !== authorization.userId
        || artifact.subjectGeneration !== authorization.subjectGeneration
        || artifact.buildGeneration !== authorization.buildGeneration
        || artifact.state !== "staging"
        || artifact.snapshotAtMs !== input.snapshotAtMs
        || artifact.snapshotRootSha256 !== summary.snapshotRootSha256
        || artifact.policyVersion !== state.request.policyVersion
        || artifact.policySha256 !== state.request.policySha256
        || artifact.artifactTtlMs !== state.request.artifactTtlMs
      ) throw new UserDataExportIntegrityError("data export artifact identity is invalid");
      const [partRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts WHERE artifact_id=? ORDER BY part_number FOR UPDATE`,
        [input.artifactId],
      );
      const parts = partRows.map((row) => {
        assertUserDataExportPartOwner(row, {
          artifactId: artifact.artifactId,
          requestId: artifact.requestId,
          buildGeneration: artifact.buildGeneration,
          tenantId: artifact.tenantId,
          userId: artifact.userId,
          subjectGeneration: artifact.subjectGeneration,
        });
        return rowToUserDataExportPart(row);
      });
      if (
        parts.length !== input.partCount
        || parts.some((part, index) => (
          part.partNumber !== index
          || part.requestId !== authorization.requestId
          || part.buildGeneration !== authorization.buildGeneration
          || part.state !== "uploaded"
          || part.sha256 === undefined
          || part.sizeBytes === undefined
          || part.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
          || part.storageKey !== userDataExportStorageKey(
            { tenantId: authorization.tenantId, userId: authorization.userId },
            authorization.requestId,
            artifact.artifactId,
            part.partNumber,
          )
        ))
      ) throw new UserDataExportIntegrityError("data export artifact parts are incomplete");
      const totalSizeBytes = parts.reduce((total, part) => total + part.sizeBytes!, 0);
      if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes !== input.totalSizeBytes) {
        throw new UserDataExportIntegrityError("data export artifact size does not match its parts");
      }
      if (userDataExportManifestSha256(parts) !== input.manifestSha256) {
        throw new UserDataExportIntegrityError("data export artifact manifest hash is invalid");
      }
      const expiresAtMs = now + state.request.artifactTtlMs;
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
        throw new UserDataExportIntegrityError("data export artifact expiry overflowed");
      }
      await conn.query(
        `UPDATE user_export_artifacts
            SET state='ready', part_count=?, record_count=?, total_size_bytes=?,
                manifest_sha256=?, content_sha256=?, ready_at_ms=?, expires_at_ms=?,
                updated_at_ms=?
          WHERE artifact_id=?`,
        [
          input.partCount,
          input.recordCount,
          input.totalSizeBytes,
          input.manifestSha256,
          input.contentSha256,
          now,
          expiresAtMs,
          now,
          input.artifactId,
        ],
      );
      await conn.query(
        `UPDATE user_export_requests
            SET status='ready', snapshot_at_ms=?, ready_at_ms=?, expires_at_ms=?,
                last_error_code=NULL, updated_at_ms=?
          WHERE request_id=? AND status='building' AND active_build_generation=?
            AND active_artifact_id=?`,
        [
          input.snapshotAtMs,
          now,
          expiresAtMs,
          now,
          authorization.requestId,
          authorization.buildGeneration,
          input.artifactId,
        ],
      );
      await conn.query(
        `UPDATE user_export_jobs
            SET status='completed', available_at_ms=NULL, claim_token=NULL,
                lease_until_ms=NULL, last_error_code=NULL, completed_at_ms=?, updated_at_ms=?
          WHERE request_id=?`,
        [now, now, authorization.requestId],
      );
      await this.releaseUserExportSnapshot(
        conn,
        authorization.requestId,
        authorization.buildGeneration,
        now,
      );
      const request = await this.loadUserExportRequest(
        conn,
        authorization.tenantId,
        authorization.userId,
        authorization.requestId,
        false,
      );
      if (!request || request.status !== "ready") {
        throw new UserDataExportIntegrityError("ready data export request publication failed");
      }
      await conn.commit();
      return request;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryUserDataExport(
    authorization: UserDataExportAuthorization,
    input: RetryUserDataExportInput,
  ): Promise<boolean> {
    validateUserDataExportAuthorization(authorization);
    if (
      !Number.isSafeInteger(input.delayMs)
      || input.delayMs < 0
      || !["temporary_failure", "snapshot_invalid", "artifact_invalid", "subject_revoked"].includes(
        input.errorCode,
      )
      || (input.maxAttempts !== undefined && (
        !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1
      ))
    ) throw new Error("invalid data export retry");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const subject = await this.lockUserExportSubject(
        conn,
        authorization.tenantId,
        authorization.userId,
        now,
        { userLock: "FOR SHARE", requireActive: true },
      );
      const state = await this.lockActiveUserExportClaim(
        conn, authorization, now, subject.user.generation,
      );
      if (!state) {
        await conn.commit();
        return false;
      }
      const terminal = input.maxAttempts !== undefined && state.job.attempts >= input.maxAttempts;
      if (terminal) {
        if (state.job.activeArtifactId) {
          await this.transitionUserExportArtifactToDeletePending(
            conn,
            state.job.activeArtifactId,
            now,
          );
        }
        await this.releaseUserExportSnapshot(
          conn,
          authorization.requestId,
          authorization.buildGeneration,
          now,
        );
        await conn.query(
          `UPDATE user_export_jobs
              SET status='failed', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                  last_error_code=?, updated_at_ms=?
            WHERE request_id=?`,
          [input.errorCode, now, authorization.requestId],
        );
        await conn.query(
          `UPDATE user_export_requests
              SET status='failed', last_error_code=?, updated_at_ms=?
            WHERE request_id=?`,
          [input.errorCode, now, authorization.requestId],
        );
      } else {
        const availableAtMs = now + input.delayMs;
        if (!Number.isSafeInteger(availableAtMs)) throw new Error("data export retry time overflow");
        await conn.query(
          `UPDATE user_export_jobs
              SET status='queued', available_at_ms=?, claim_token=NULL, lease_until_ms=NULL,
                  last_error_code=?, updated_at_ms=?
            WHERE request_id=?`,
          [availableAtMs, input.errorCode, now, authorization.requestId],
        );
        await conn.query(
          `UPDATE user_export_requests
              SET status='queued', last_error_code=?, updated_at_ms=?
            WHERE request_id=?`,
          [input.errorCode, now, authorization.requestId],
        );
      }
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      if (error instanceof SubjectDeletingError) return false;
      throw error;
    } finally {
      conn.release();
    }
  }

  async scheduleUserDataExportDeletes(limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("data export cleanup limit must be between 1 and 1000");
    }
    const observedNow = await this.userExportDatabaseNow(this.pool);
    await this.pool.query(
      "DELETE FROM user_export_download_leases WHERE lease_until_ms<=?",
      [observedNow],
    );
    const [candidateRows] = await this.pool.query<Row[]>(
      `SELECT a.artifact_id, a.request_id, a.tenant_id, a.user_id
         FROM user_export_artifacts a
         JOIN user_export_requests r ON r.request_id=a.request_id
          AND r.tenant_id=a.tenant_id AND r.user_id=a.user_id
        WHERE a.state IN ('staging','ready') AND (
          r.status IN ('failed','revoked')
          OR (r.status='expired' AND NOT EXISTS (
            SELECT 1 FROM user_export_download_leases l
             WHERE l.artifact_id=a.artifact_id AND l.lease_until_ms>?
          ))
          OR (a.state='ready' AND a.expires_at_ms IS NOT NULL AND a.expires_at_ms<=?
            AND NOT EXISTS (
              SELECT 1 FROM user_export_download_leases l
               WHERE l.artifact_id=a.artifact_id AND l.lease_until_ms>?
            ))
          OR (a.state='staging' AND a.staging_expires_at_ms<=? AND NOT EXISTS (
            SELECT 1 FROM user_export_jobs j
             WHERE j.request_id=a.request_id AND j.build_generation=a.build_generation
               AND j.status='building' AND j.claim_token IS NOT NULL
               AND j.lease_until_ms>?
          ))
        )
        ORDER BY COALESCE(a.expires_at_ms, a.staging_expires_at_ms), a.artifact_id
        LIMIT ?`,
      [observedNow, observedNow, observedNow, observedNow, observedNow, limit],
    );
    let scheduled = 0;
    for (const candidate of candidateRows) {
      const tenantId = String(candidate.tenant_id);
      const userId = String(candidate.user_id);
      const artifactId = String(candidate.artifact_id);
      const requestId = String(candidate.request_id);
      const conn = await this.pool.getConnection();
      try {
        await conn.beginTransaction();
        const now = await this.userExportDatabaseNow(conn);
        const subject = await this.lockUserExportSubject(
          conn,
          tenantId,
          userId,
          now,
          { userLock: "FOR SHARE", requireActive: false },
        );
        let request = await this.loadUserExportRequest(
          conn,
          tenantId,
          userId,
          requestId,
          true,
        );
        if (!request) throw new UserDataExportIntegrityError("data export artifact request is missing");
        const [artifactRows] = await conn.query<Row[]>(
          `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
             FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
          [artifactId],
        );
        if (!artifactRows[0]) {
          await conn.commit();
          continue;
        }
        const artifact = rowToUserDataExportArtifact(artifactRows[0]);
        if (artifact.requestId !== request.requestId) {
          throw new UserDataExportIntegrityError("data export artifact request identity conflicts");
        }
        if (
          (subject.tenant.state !== "active"
            || subject.user.state !== "active"
            || subject.user.generation !== request.subjectGeneration)
          && request.status !== "revoked"
        ) {
          await this.revokeUserExportsForSubject(conn, tenantId, userId, now);
          await conn.commit();
          scheduled += 1;
          continue;
        }
        await conn.query(
          "DELETE FROM user_export_download_leases WHERE artifact_id=? AND lease_until_ms<=?",
          [artifactId, now],
        );
        const [leaseRows] = await conn.query<Row[]>(
          `SELECT lease_token FROM user_export_download_leases
            WHERE artifact_id=? AND lease_until_ms>? LIMIT 1 FOR SHARE`,
          [artifactId, now],
        );
        // Erasure/revocation may invalidate active downloads immediately. Ordinary artifact TTL
        // expiry cannot: it marks the request expired but waits for every bounded lease to drain.
        const forced = request.status === "failed" || request.status === "revoked";
        const readyExpired = artifact.state === "ready"
          && artifact.expiresAtMs !== undefined
          && artifact.expiresAtMs <= now
          && leaseRows.length === 0;
        let stagingStale = artifact.state === "staging" && artifact.stagingExpiresAtMs <= now;
        if (stagingStale) {
          const [jobRows] = await conn.query<Row[]>(
            `SELECT ${USER_EXPORT_JOB_COLUMNS}
               FROM user_export_jobs WHERE request_id=? FOR UPDATE`,
            [artifact.requestId],
          );
          const job = jobRows[0] ? rowToUserDataExportJob(jobRows[0]) : undefined;
          if (
            job
            && job.buildGeneration === artifact.buildGeneration
            && job.status === "building"
            && job.claimToken !== undefined
            && job.leaseUntilMs !== undefined
            && job.leaseUntilMs > now
          ) stagingStale = false;
        }
        if (!forced && !readyExpired && !stagingStale) {
          await conn.commit();
          continue;
        }
        if (readyExpired && request.status === "ready") {
          await conn.query(
            `UPDATE user_export_requests SET status='expired', updated_at_ms=?
              WHERE request_id=? AND status='ready'`,
            [now, request.requestId],
          );
          request = { ...request, status: "expired", updatedAtMs: now };
        }
        if (stagingStale && (request.status === "queued" || request.status === "building")) {
          await conn.query(
            `UPDATE user_export_requests
                SET status='failed', last_error_code='artifact_invalid', updated_at_ms=?
              WHERE request_id=?`,
            [now, request.requestId],
          );
          await conn.query(
            `UPDATE user_export_jobs
                SET status='failed', available_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                    last_error_code='artifact_invalid', updated_at_ms=?
              WHERE request_id=?`,
            [now, request.requestId],
          );
          await this.releaseUserExportSnapshot(
            conn,
            request.requestId,
            artifact.buildGeneration,
            now,
          );
        }
        if (await this.transitionUserExportArtifactToDeletePending(conn, artifactId, now)) {
          scheduled += 1;
        }
        await conn.commit();
      } catch (error) {
        await conn.rollback().catch(() => {});
        // A malformed candidate is fail-closed for itself, but must not prevent a later safe
        // artifact in this bounded scheduling pass from reaching its exact delete outbox.
        if (error instanceof UserDataExportIntegrityError) continue;
        throw error;
      } finally {
        conn.release();
      }
    }
    return scheduled;
  }

  async claimUserDataExportDeletes(
    options: ClaimUserDataExportDeletesOptions,
  ): Promise<UserDataExportDeleteOutboxRecord[]> {
    if (
      !Number.isInteger(options.limit)
      || options.limit < 1
      || options.limit > 100
      || !Number.isSafeInteger(options.leaseMs)
      || options.leaseMs < 1
      || !/^[A-Za-z0-9._:~-]{1,128}$/.test(options.claimToken)
    ) throw new Error("invalid data export delete claim");
    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const leaseUntilMs = now + options.leaseMs;
      if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("data export delete lease overflow");
      const [rows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_DELETE_COLUMNS}
           FROM user_export_artifact_delete_outbox
          WHERE completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL
            AND available_at_ms<=?
            AND ((claim_token IS NULL AND lease_until_ms IS NULL)
              OR (claim_token IS NOT NULL AND lease_until_ms IS NOT NULL AND lease_until_ms<=?))
          ORDER BY available_at_ms, outbox_id
          LIMIT ? FOR UPDATE SKIP LOCKED`,
        [now, now, options.limit],
      );
      const claimed: UserDataExportDeleteOutboxRecord[] = [];
      for (const row of rows) {
        const rawOutboxId = Number(row.outbox_id);
        let record: UserDataExportDeleteOutboxRecord;
        try {
          record = rowToUserDataExportDelete(row);
        } catch {
          // A permanently malformed intent must not poison the ordered queue and starve every
          // valid intent behind it. Keep the row as immutable evidence and quarantine it.
          await conn.query(
            `UPDATE user_export_artifact_delete_outbox
                SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL,
                    last_error='delete_intent_envelope_invalid', dead_lettered_at_ms=?
              WHERE outbox_id=? AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
            [now, rawOutboxId],
          );
          continue;
        }
        const [partRows] = await conn.query<Row[]>(
          `SELECT ${USER_EXPORT_PART_COLUMNS}
             FROM user_export_artifact_parts
            WHERE artifact_id=? AND part_number=? FOR SHARE`,
          [record.artifactId, record.partNumber],
        );
        const [artifactRows] = await conn.query<Row[]>(
          `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
             FROM user_export_artifacts WHERE artifact_id=? FOR SHARE`,
          [record.artifactId],
        );
        let identityValid = false;
        try {
          const buildGeneration = storedSafeInteger(
            row.build_generation,
            "export delete build generation",
            1,
          );
          const artifact = artifactRows[0]
            ? rowToUserDataExportArtifact(artifactRows[0])
            : undefined;
          if (partRows[0] && artifact) {
            assertUserDataExportPartOwner(partRows[0], {
              artifactId: artifact.artifactId,
              requestId: artifact.requestId,
              buildGeneration: artifact.buildGeneration,
              tenantId: artifact.tenantId,
              userId: artifact.userId,
              subjectGeneration: artifact.subjectGeneration,
            });
          }
          const part = partRows[0] ? rowToUserDataExportPart(partRows[0]) : undefined;
          identityValid = !!artifact
            && artifact.state === "delete_pending"
            && artifact.requestId === record.requestId
            && artifact.buildGeneration === buildGeneration
            && artifact.deletionGeneration === record.deletionGeneration
            && artifact.storageBackend === record.storageBackend
            && artifact.storageFormat === record.storageFormat
            && !!part
            && part.state === "delete_pending"
            && part.deletionGeneration === record.deletionGeneration
            && part.requestId === record.requestId
            && part.buildGeneration === buildGeneration
            && part.storageBackend === record.storageBackend
            && part.storageFormat === record.storageFormat
            && part.storageKey === record.storageKey
            && part.storageKey === userDataExportStorageKey(
              { tenantId: artifact.tenantId, userId: artifact.userId },
              record.requestId,
              record.artifactId,
              record.partNumber,
            )
            && part.uploadToken === record.uploadToken
            && part.sha256 === (row.expected_sha256 == null
              ? undefined
              : String(row.expected_sha256))
            && part.sizeBytes === (row.expected_size_bytes == null
              ? undefined
              : storedSafeInteger(row.expected_size_bytes, "export delete expected size"));
        } catch {
          identityValid = false;
        }
        if (!identityValid) {
          await conn.query(
            `UPDATE user_export_artifact_delete_outbox
                SET attempts=attempts+1, claim_token=NULL, lease_until_ms=NULL,
                    last_error='delete_intent_identity_invalid', dead_lettered_at_ms=?
              WHERE outbox_id=? AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
            [now, record.outboxId],
          );
          continue;
        }
        await conn.query(
          `UPDATE user_export_artifact_delete_outbox
              SET attempts=attempts+1, claim_token=?, lease_until_ms=?
            WHERE outbox_id=?`,
          [options.claimToken, leaseUntilMs, record.outboxId],
        );
        claimed.push({
          ...record,
          attempts: record.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        });
      }
      await conn.commit();
      return claimed;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async renewUserDataExportDeleteClaim(
    outboxId: number,
    claimToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(outboxId)
      || outboxId < 1
      || !/^[A-Za-z0-9._:~-]{1,128}$/.test(claimToken)
      || !Number.isSafeInteger(leaseMs)
      || leaseMs < 1
    ) throw new Error("invalid data export delete renewal");
    const now = await this.userExportDatabaseNow(this.pool);
    const leaseUntilMs = now + leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("data export delete lease overflow");
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE user_export_artifact_delete_outbox
          SET lease_until_ms=GREATEST(lease_until_ms, ?)
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [leaseUntilMs, outboxId, claimToken, now],
    );
    return result.affectedRows === 1;
  }

  async completeUserDataExportDelete(
    outboxId: number,
    claimToken: string,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(outboxId)
      || outboxId < 1
      || !/^[A-Za-z0-9._:~-]{1,128}$/.test(claimToken)
    ) throw new Error("invalid data export delete completion");
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const now = await this.userExportDatabaseNow(conn);
      const [rows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_DELETE_COLUMNS}
           FROM user_export_artifact_delete_outbox
          WHERE outbox_id=? FOR UPDATE`,
        [outboxId],
      );
      const row = rows[0] ? rowToUserDataExportDelete(rows[0]) : undefined;
      if (
        !row
        || row.completedAtMs !== undefined
        || row.deadLetteredAtMs !== undefined
        || row.claimToken !== claimToken
        || row.leaseUntilMs === undefined
        || row.leaseUntilMs <= now
      ) {
        await conn.commit();
        return false;
      }
      const buildGeneration = storedSafeInteger(
        rows[0]!.build_generation,
        "export delete build generation",
        1,
      );
      const [artifactRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_ARTIFACT_COLUMNS}
           FROM user_export_artifacts WHERE artifact_id=? FOR UPDATE`,
        [row.artifactId],
      );
      const artifact = artifactRows[0]
        ? rowToUserDataExportArtifact(artifactRows[0])
        : undefined;
      if (
        !artifact
        || artifact.state !== "delete_pending"
        || artifact.requestId !== row.requestId
        || artifact.buildGeneration !== buildGeneration
        || artifact.deletionGeneration !== row.deletionGeneration
        || artifact.storageBackend !== row.storageBackend
        || artifact.storageFormat !== row.storageFormat
      ) throw new UserDataExportIntegrityError("data export delete artifact identity is invalid");
      const [partRows] = await conn.query<Row[]>(
        `SELECT ${USER_EXPORT_PART_COLUMNS}
           FROM user_export_artifact_parts
          WHERE artifact_id=? AND part_number=? FOR UPDATE`,
        [row.artifactId, row.partNumber],
      );
      if (partRows[0]) {
        assertUserDataExportPartOwner(partRows[0], {
          artifactId: artifact.artifactId,
          requestId: artifact.requestId,
          buildGeneration: artifact.buildGeneration,
          tenantId: artifact.tenantId,
          userId: artifact.userId,
          subjectGeneration: artifact.subjectGeneration,
        });
      }
      const part = partRows[0] ? rowToUserDataExportPart(partRows[0]) : undefined;
      if (
        !part
        || part.state !== "delete_pending"
        || part.deletionGeneration !== row.deletionGeneration
        || part.requestId !== row.requestId
        || part.buildGeneration !== buildGeneration
        || part.storageBackend !== row.storageBackend
        || part.storageFormat !== row.storageFormat
        || part.storageKey !== row.storageKey
        || part.storageKey !== userDataExportStorageKey(
          { tenantId: artifact.tenantId, userId: artifact.userId },
          row.requestId,
          row.artifactId,
          row.partNumber,
        )
        || part.uploadToken !== row.uploadToken
        || part.sha256 !== (rows[0]!.expected_sha256 == null
          ? undefined
          : String(rows[0]!.expected_sha256))
        || part.sizeBytes !== (rows[0]!.expected_size_bytes == null
          ? undefined
          : storedSafeInteger(rows[0]!.expected_size_bytes, "export delete expected size"))
      ) throw new UserDataExportIntegrityError("data export delete completion identity is invalid");
      await conn.query(
        `UPDATE user_export_artifact_parts
            SET state='deleted', deleted_at_ms=?, updated_at_ms=?
          WHERE artifact_id=? AND part_number=?`,
        [now, now, row.artifactId, row.partNumber],
      );
      await conn.query(
        `UPDATE user_export_artifact_delete_outbox
            SET completed_at_ms=?, claim_token=NULL, lease_until_ms=NULL, last_error=NULL
          WHERE outbox_id=?`,
        [now, outboxId],
      );
      const [remainingRows] = await conn.query<Row[]>(
        `SELECT part_number FROM user_export_artifact_parts
          WHERE artifact_id=? AND state<>'deleted' LIMIT 1 FOR SHARE`,
        [row.artifactId],
      );
      if (remainingRows.length === 0) {
        const [updated] = await conn.query<mysql.ResultSetHeader>(
          `UPDATE user_export_artifacts
              SET state='deleted', deleted_at_ms=?, updated_at_ms=?
            WHERE artifact_id=? AND state='delete_pending' AND deletion_generation=?`,
          [now, now, row.artifactId, row.deletionGeneration],
        );
        if (updated.affectedRows !== 1) {
          throw new UserDataExportIntegrityError("data export delete artifact completion was lost");
        }
      }
      await conn.commit();
      return true;
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    } finally {
      conn.release();
    }
  }

  async retryUserDataExportDelete(
    outboxId: number,
    claimToken: string,
    input: RetryUserDataExportDeleteInput,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(outboxId)
      || outboxId < 1
      || !/^[A-Za-z0-9._:~-]{1,128}$/.test(claimToken)
      || !Number.isSafeInteger(input.delayMs)
      || input.delayMs < 0
      || (input.maxAttempts !== undefined && (
        !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1
      ))
    ) throw new Error("invalid data export delete retry");
    const now = await this.userExportDatabaseNow(this.pool);
    const availableAtMs = now + input.delayMs;
    if (!Number.isSafeInteger(availableAtMs)) throw new Error("data export delete retry overflow");
    const error = sanitizeUserDataExportError(input.error);
    if (input.maxAttempts === undefined) {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `UPDATE user_export_artifact_delete_outbox
            SET claim_token=NULL, lease_until_ms=NULL, last_error=?, available_at_ms=?
          WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
            AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
        [error, availableAtMs, outboxId, claimToken, now],
      );
      return result.affectedRows === 1;
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE user_export_artifact_delete_outbox
          SET claim_token=NULL, lease_until_ms=NULL, last_error=?,
              available_at_ms=CASE WHEN attempts>=? THEN available_at_ms ELSE ? END,
              dead_lettered_at_ms=CASE WHEN attempts>=? THEN ? ELSE NULL END
        WHERE outbox_id=? AND claim_token=? AND lease_until_ms>?
          AND completed_at_ms IS NULL AND dead_lettered_at_ms IS NULL`,
      [
        error,
        input.maxAttempts,
        availableAtMs,
        input.maxAttempts,
        now,
        outboxId,
        claimToken,
        now,
      ],
    );
    return result.affectedRows === 1;
  }

  async close() {
    await this.pool.end();
  }
}

async function upsertItem(conn: PoolConnection, it: Item, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE items SET status=?, body=?, completed_at_ms=?
        WHERE item_id=? AND session_id=? AND user_id=?`,
      [it.status, json(it), it.completedAtMs ?? null, it.id, it.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO items
       (item_id, session_id, user_id, turn_id, seq, type, status, body, created_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [it.id, it.sessionId, userId, it.turnId, it.seq, it.type, it.status, json(it), it.createdAtMs, it.completedAtMs ?? null],
  );
}
async function upsertTurn(conn: PoolConnection, t: Turn, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE turns SET status=?, stop_reason=?, seq_end=?, body=?, completed_at_ms=?
        WHERE turn_id=? AND session_id=? AND user_id=?`,
      [t.status, t.stopReason ?? null, t.seqEnd ?? null, json(t), t.completedAtMs ?? null, t.id, t.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO turns
       (turn_id, session_id, user_id, status, stop_reason, seq_start, seq_end, body,
        idempotency_key, started_at_ms, completed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [t.id, t.sessionId, userId, t.status, t.stopReason ?? null, t.seqStart, t.seqEnd ?? null, json(t), t.idempotencyKey ?? null, t.startedAtMs, t.completedAtMs ?? null],
  );
}
async function upsertApproval(conn: PoolConnection, a: Approval, userId: string, exists: boolean) {
  if (exists) {
    await conn.query(
      `UPDATE approvals SET status=?, body=?
        WHERE approval_id=? AND session_id=? AND user_id=?`,
      [a.status, json(a), a.id, a.sessionId, userId],
    );
    return;
  }
  await conn.query(
    `INSERT INTO approvals
       (approval_id, session_id, user_id, turn_id, status, body, created_at_ms, expires_at_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
    [a.id, a.sessionId, userId, a.turnId, a.status, json(a), a.createdAtMs, a.expiresAtMs],
  );
}
