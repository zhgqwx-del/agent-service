import { createHash } from "node:crypto";
import type { DataSubjectKind } from "./subject-lifecycle.js";

export const ERASURE_POLICY_EVALUATION_DECISIONS = [
  "unbound",
  "invalid",
  "unconfigured",
  "held",
  "waiting",
  "eligible_execution_disabled",
] as const;
export type ErasurePolicyEvaluationDecision =
  (typeof ERASURE_POLICY_EVALUATION_DECISIONS)[number];

export const ERASURE_POLICY_EVALUATION_ERROR_CODES = [
  "temporary_failure",
  "evidence_changed",
] as const;
export type ErasurePolicyEvaluationErrorCode =
  (typeof ERASURE_POLICY_EVALUATION_ERROR_CODES)[number];

/** Live owner evidence changed after this build started; callers must start a new generation. */
export class ErasurePurgeEvidenceChangedError extends Error {
  constructor() {
    super("erasure purge target evidence changed");
    this.name = "ErasurePurgeEvidenceChangedError";
  }
}

export const ERASURE_PURGE_TARGET_ISSUE_CODES = [
  "policy_unconfigured",
  "deadline_overflow",
  "tombstone_invalid",
  "usage_reconciliation_invalid",
  "receipt_invalid",
  "blob_invalid",
] as const;
export type ErasurePurgeTargetIssueCode =
  (typeof ERASURE_PURGE_TARGET_ISSUE_CODES)[number];

export interface ErasurePolicyEvaluationJob {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  subjectGeneration: number;
  buildGeneration: number;
  cursorSessionId?: string;
  targetCount: number;
  targetRootSha256: string;
  availableAtMs?: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  lastErrorCode?: ErasurePolicyEvaluationErrorCode;
  sealedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ErasurePolicyEvaluationAuthorization {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  subjectGeneration: number;
  buildGeneration: number;
  claimToken: string;
  claimAttempt: number;
}

export interface ErasurePolicyEvaluationClaim
  extends ErasurePolicyEvaluationAuthorization {
  availableAtMs: number;
  leaseUntilMs: number;
}

export interface ClaimErasurePolicyEvaluationsOptions {
  nowMs: number;
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface RenewErasurePolicyEvaluationOptions {
  nowMs: number;
  leaseMs: number;
}

export interface RetryErasurePolicyEvaluationOptions {
  failedAtMs: number;
  availableAtMs: number;
  errorCode: ErasurePolicyEvaluationErrorCode;
}

export interface ScheduleAwaitingErasurePolicyEvaluationsOptions {
  nowMs: number;
  limit: number;
}

/**
 * Content-free, request-bound purge evidence. It does not grant an execution capability.
 * Billing facts and the minimal lifecycle audit are deliberately classified as retained.
 */
export interface ErasurePurgeTargetEvidence {
  requestId: string;
  buildGeneration: number;
  tenantId: string;
  userId: string;
  sessionId: string;
  deletionGeneration: number;
  deletedAtMs: number;
  sessionContentDeadlineMs?: number;
  readyBlobCount: number;
  readyBlobRootSha256: string;
  readyBlobDeadlineMs?: number;
  operationalUsageStatus: "verified" | "anonymized" | "missing_or_invalid";
  operationalUsageVerifiedAtMs: number;
  operationalUsageChecksum: string;
  operationalUsageDeadlineMs?: number;
  idempotencyReceiptCount: number;
  idempotencyReceiptDeadlineMs?: number;
  exportArtifactDisposition: "not_applicable";
  billingFactDisposition: "retained";
  lifecycleAuditDisposition: "retained";
  issueCodes: ErasurePurgeTargetIssueCode[];
  evidenceSha256: string;
}

export interface BuildErasurePurgeTargetPageOptions {
  nowMs: number;
  limit: number;
}

export interface BuildErasurePurgeTargetPageResult {
  built: number;
  done: boolean;
  cursorSessionId?: string;
  targetCount: number;
  targetRootSha256: string;
}

export interface SealErasurePurgeAuthorityOptions {
  nowMs: number;
}

/** Every evaluation result is immutable and chained, including denied/deferred results. */
export interface ErasurePolicyEvaluationDecisionEvent {
  requestId: string;
  decisionSeq: number;
  buildGeneration: number;
  decision: ErasurePolicyEvaluationDecision;
  policyVersion?: string;
  policySha256?: string;
  userGraceDeadlineMs?: number;
  eligibilityDeadlineMs?: number;
  targetCount: number;
  targetRootSha256: string;
  tenantHoldControlGeneration: number;
  tenantHoldProjectionSha256: string;
  userHoldControlGeneration: number;
  userHoldProjectionSha256: string;
  beforeSha256: string;
  afterSha256: string;
  decidedAtMs: number;
}

/** Immutable evidence only. No claim token, lease, or executable queue field may be added here. */
export interface ErasurePurgeAuthorityRecord {
  requestId: string;
  authorityGeneration: number;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  subjectGeneration: number;
  buildGeneration: number;
  policyVersion: string;
  policySha256: string;
  policySchemaVersion: number;
  userGraceDeadlineMs: number;
  eligibilityDeadlineMs: number;
  targetCount: number;
  targetRootSha256: string;
  tenantHoldControlGeneration: number;
  tenantHoldProjectionSha256: string;
  userHoldControlGeneration: number;
  userHoldProjectionSha256: string;
  decisionSha256: string;
  authoritySha256: string;
  createdAtMs: number;
}

/**
 * Mutable generation-CAS cache/projection only. It is never an execution authorization. A future
 * destructive worker must consume a separate interface that performs the validated authority read.
 */
export interface ErasurePurgeAuthorityControl {
  requestId: string;
  authorityGeneration: number;
  activeAuthoritySha256?: string;
  updatedAtMs: number;
}

export interface ErasurePolicyEvaluationSealResult {
  decision: ErasurePolicyEvaluationDecisionEvent;
  authority?: ErasurePurgeAuthorityRecord;
  control: ErasurePurgeAuthorityControl;
}

export const ERASURE_COMPLETION_MISSING_PROOFS = [
  "purge_execution_disabled",
  "trusted_clock_linearization",
  "session_content_receipts",
  "ready_blob_physical_acks",
  "operational_usage_anonymization",
  "idempotency_receipt_deletion",
  "redis_cleanup",
  "provider_secret_revocation",
  "restore_ledger_ack",
] as const;
export type ErasureCompletionMissingProof =
  (typeof ERASURE_COMPLETION_MISSING_PROOFS)[number];

export interface ErasureCompletionReadiness {
  requestId: string;
  complete: false;
  missing: ErasureCompletionMissingProof[];
  authority?: ErasurePurgeAuthorityRecord;
}

/**
 * Evaluation is separate from SessionStore and from any future destructive executor. The surface
 * can only build/attest immutable evidence and always reports completion as false.
 */
export interface ErasurePolicyEvaluationStore {
  scheduleAwaitingErasurePolicyEvaluations(
    options: ScheduleAwaitingErasurePolicyEvaluationsOptions,
  ): Promise<number>;
  claimErasurePolicyEvaluations(
    options: ClaimErasurePolicyEvaluationsOptions,
  ): Promise<ErasurePolicyEvaluationClaim[]>;
  renewErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RenewErasurePolicyEvaluationOptions,
  ): Promise<boolean>;
  retryErasurePolicyEvaluation(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: RetryErasurePolicyEvaluationOptions,
  ): Promise<boolean>;
  buildErasurePurgeTargetPage(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: BuildErasurePurgeTargetPageOptions,
  ): Promise<BuildErasurePurgeTargetPageResult>;
  sealErasurePurgeAuthority(
    authorization: ErasurePolicyEvaluationAuthorization,
    options: SealErasurePurgeAuthorityOptions,
  ): Promise<ErasurePolicyEvaluationSealResult>;
  getErasurePolicyEvaluationJob(requestId: string): Promise<ErasurePolicyEvaluationJob | null>;
  listErasurePurgeTargetEvidence(
    requestId: string,
    buildGeneration: number,
  ): Promise<ErasurePurgeTargetEvidence[]>;
  listErasurePolicyEvaluationDecisions(
    requestId: string,
  ): Promise<ErasurePolicyEvaluationDecisionEvent[]>;
  getValidatedErasurePurgeAuthority(
    requestId: string,
  ): Promise<ErasurePurgeAuthorityRecord | null>;
  getErasureCompletionReadiness(requestId: string): Promise<ErasureCompletionReadiness>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:-]{16,128}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export const EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256 = sha256([
  "agent-service/erasure-purge-target-root/v1",
]);

export function nextErasurePurgeTargetRootSha256(
  previous: string,
  evidenceSha256: string,
): string {
  if (!SHA256.test(previous) || !SHA256.test(evidenceSha256)) {
    throw new Error("invalid erasure purge target root input");
  }
  return sha256(["agent-service/erasure-purge-target-root/v1", previous, evidenceSha256]);
}

export function erasurePurgeTargetEvidenceSha256(
  evidence: Omit<ErasurePurgeTargetEvidence, "evidenceSha256">,
): string {
  return sha256([
    "agent-service/erasure-purge-target/v1",
    evidence.requestId,
    evidence.buildGeneration,
    evidence.tenantId,
    evidence.userId,
    evidence.sessionId,
    evidence.deletionGeneration,
    evidence.deletedAtMs,
    evidence.sessionContentDeadlineMs ?? null,
    evidence.readyBlobCount,
    evidence.readyBlobRootSha256,
    evidence.readyBlobDeadlineMs ?? null,
    evidence.operationalUsageStatus,
    evidence.operationalUsageVerifiedAtMs,
    evidence.operationalUsageChecksum,
    evidence.operationalUsageDeadlineMs ?? null,
    evidence.idempotencyReceiptCount,
    evidence.idempotencyReceiptDeadlineMs ?? null,
    evidence.exportArtifactDisposition,
    evidence.billingFactDisposition,
    evidence.lifecycleAuditDisposition,
    [...evidence.issueCodes].sort(),
  ]);
}

/** Reject a persisted target that could not have been emitted by the evaluator. */
export function validateErasurePurgeTargetEvidence(
  evidence: ErasurePurgeTargetEvidence,
): void {
  const { evidenceSha256, ...withoutHash } = evidence;
  const safeNonnegative = (value: number | undefined): boolean => (
    value === undefined || (Number.isSafeInteger(value) && value >= 0)
  );
  const sortedIssues = [...new Set(evidence.issueCodes)].sort();
  if (
    !evidence.requestId
    || !evidence.tenantId
    || !evidence.userId
    || !evidence.sessionId
    || !Number.isSafeInteger(evidence.buildGeneration)
    || evidence.buildGeneration <= 0
    || !Number.isSafeInteger(evidence.deletionGeneration)
    || evidence.deletionGeneration <= 0
    || !safeNonnegative(evidence.deletedAtMs)
    || !safeNonnegative(evidence.sessionContentDeadlineMs)
    || !Number.isSafeInteger(evidence.readyBlobCount)
    || evidence.readyBlobCount < 0
    || !SHA256.test(evidence.readyBlobRootSha256)
    || !safeNonnegative(evidence.readyBlobDeadlineMs)
    || !["verified", "anonymized", "missing_or_invalid"].includes(evidence.operationalUsageStatus)
    || !safeNonnegative(evidence.operationalUsageVerifiedAtMs)
    || !SHA256.test(evidence.operationalUsageChecksum)
    || !safeNonnegative(evidence.operationalUsageDeadlineMs)
    || !Number.isSafeInteger(evidence.idempotencyReceiptCount)
    || evidence.idempotencyReceiptCount < 0
    || !safeNonnegative(evidence.idempotencyReceiptDeadlineMs)
    || evidence.exportArtifactDisposition !== "not_applicable"
    || evidence.billingFactDisposition !== "retained"
    || evidence.lifecycleAuditDisposition !== "retained"
    || evidence.issueCodes.some((issue) => !ERASURE_PURGE_TARGET_ISSUE_CODES.includes(issue))
    || JSON.stringify(evidence.issueCodes) !== JSON.stringify(sortedIssues)
    || !SHA256.test(evidenceSha256)
    || erasurePurgeTargetEvidenceSha256(withoutHash) !== evidenceSha256
  ) throw new Error("stored erasure purge target evidence is invalid");
}

export function erasurePurgeTargetMatchesRetentionPolicy(
  evidence: ErasurePurgeTargetEvidence,
  policy: {
    sessionContentRetentionMs: number | null;
    operationalUsageRetentionMs: number | null;
    idempotencyReceiptRetentionMs: number | null;
  },
): boolean {
  const content = checkedRetentionDeadline(
    evidence.deletedAtMs,
    policy.sessionContentRetentionMs,
  );
  const usage = checkedRetentionDeadline(
    evidence.operationalUsageVerifiedAtMs,
    policy.operationalUsageRetentionMs,
  );
  const receiptFloor = checkedRetentionDeadline(
    evidence.deletedAtMs,
    policy.idempotencyReceiptRetentionMs,
  );
  return evidence.issueCodes.length === 0
    && content.kind === "deadline"
    && usage.kind === "deadline"
    && receiptFloor.kind === "deadline"
    && evidence.sessionContentDeadlineMs === content.value
    && evidence.operationalUsageVerifiedAtMs >= evidence.deletedAtMs
    && (evidence.operationalUsageStatus === "verified"
      || evidence.operationalUsageStatus === "anonymized")
    && evidence.operationalUsageDeadlineMs === usage.value
    && (evidence.readyBlobCount === 0
      ? evidence.readyBlobDeadlineMs === undefined
      : evidence.readyBlobDeadlineMs === content.value)
    && (evidence.idempotencyReceiptCount === 0
      ? evidence.idempotencyReceiptDeadlineMs === undefined
      : evidence.idempotencyReceiptDeadlineMs !== undefined
        && evidence.idempotencyReceiptDeadlineMs >= receiptFloor.value);
}

export function erasurePolicyDecisionSha256(
  event: Omit<ErasurePolicyEvaluationDecisionEvent, "afterSha256">,
): string {
  return sha256([
    "agent-service/erasure-policy-decision/v1",
    event.requestId,
    event.decisionSeq,
    event.buildGeneration,
    event.decision,
    event.policyVersion ?? null,
    event.policySha256 ?? null,
    event.userGraceDeadlineMs ?? null,
    event.eligibilityDeadlineMs ?? null,
    event.targetCount,
    event.targetRootSha256,
    event.tenantHoldControlGeneration,
    event.tenantHoldProjectionSha256,
    event.userHoldControlGeneration,
    event.userHoldProjectionSha256,
    event.beforeSha256,
    event.decidedAtMs,
  ]);
}

export function erasurePurgeAuthoritySha256(
  authority: Omit<ErasurePurgeAuthorityRecord, "authoritySha256">,
): string {
  return sha256([
    "agent-service/erasure-purge-authority/v1",
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
    authority.createdAtMs,
  ]);
}

export function erasurePurgeAuthorityMatchesDecision(
  authority: ErasurePurgeAuthorityRecord,
  decision: ErasurePolicyEvaluationDecisionEvent,
): boolean {
  return decision.requestId === authority.requestId
    && decision.decision === "eligible_execution_disabled"
    && decision.buildGeneration === authority.buildGeneration
    && decision.policyVersion === authority.policyVersion
    && decision.policySha256 === authority.policySha256
    && decision.userGraceDeadlineMs === authority.userGraceDeadlineMs
    && decision.eligibilityDeadlineMs === authority.eligibilityDeadlineMs
    && decision.targetCount === authority.targetCount
    && decision.targetRootSha256 === authority.targetRootSha256
    && decision.tenantHoldControlGeneration === authority.tenantHoldControlGeneration
    && decision.tenantHoldProjectionSha256 === authority.tenantHoldProjectionSha256
    && decision.userHoldControlGeneration === authority.userHoldControlGeneration
    && decision.userHoldProjectionSha256 === authority.userHoldProjectionSha256
    && decision.afterSha256 === authority.decisionSha256
    && decision.decidedAtMs === authority.createdAtMs;
}

export function validateErasurePolicyEvaluationAuthorization(
  authorization: ErasurePolicyEvaluationAuthorization,
): void {
  if (
    !authorization.requestId
    || !authorization.tenantId
    || !authorization.subjectId
    || (authorization.subjectKind !== "tenant" && authorization.subjectKind !== "user")
    || !Number.isSafeInteger(authorization.subjectGeneration)
    || authorization.subjectGeneration <= 0
    || !Number.isSafeInteger(authorization.buildGeneration)
    || authorization.buildGeneration <= 0
    || !CLAIM_TOKEN.test(authorization.claimToken)
    || !Number.isSafeInteger(authorization.claimAttempt)
    || authorization.claimAttempt <= 0
  ) throw new Error("invalid erasure policy evaluation authorization");
}

export function erasurePolicyEvaluationAuthorizationMatches(
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

function assertSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new Error("invalid limit");
}

export function validateClaimErasurePolicyEvaluationsOptions(
  options: ClaimErasurePolicyEvaluationsOptions,
): number {
  assertSafeTimestamp(options.nowMs, "claim timestamp");
  assertLimit(options.limit);
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) throw new Error("invalid lease duration");
  if (!CLAIM_TOKEN.test(options.claimToken)) throw new Error("invalid claim token");
  const leaseUntilMs = options.nowMs + options.leaseMs;
  if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("claim lease deadline overflow");
  return leaseUntilMs;
}

export function validateRenewErasurePolicyEvaluationOptions(
  options: RenewErasurePolicyEvaluationOptions,
): number {
  assertSafeTimestamp(options.nowMs, "renew timestamp");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) throw new Error("invalid lease duration");
  const leaseUntilMs = options.nowMs + options.leaseMs;
  if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("renew lease deadline overflow");
  return leaseUntilMs;
}

export function validateRetryErasurePolicyEvaluationOptions(
  options: RetryErasurePolicyEvaluationOptions,
): void {
  assertSafeTimestamp(options.failedAtMs, "retry failure timestamp");
  assertSafeTimestamp(options.availableAtMs, "retry availability timestamp");
  if (options.availableAtMs < options.failedAtMs) throw new Error("retry cannot precede failure");
  if (!ERASURE_POLICY_EVALUATION_ERROR_CODES.includes(options.errorCode)) {
    throw new Error("invalid erasure policy evaluation error code");
  }
}

export function validateScheduleAwaitingErasurePolicyEvaluationsOptions(
  options: ScheduleAwaitingErasurePolicyEvaluationsOptions,
): void {
  assertSafeTimestamp(options.nowMs, "schedule timestamp");
  assertLimit(options.limit);
}

export function validateBuildErasurePurgeTargetPageOptions(
  options: BuildErasurePurgeTargetPageOptions,
): void {
  assertSafeTimestamp(options.nowMs, "target build timestamp");
  assertLimit(options.limit);
}

export function validateSealErasurePurgeAuthorityOptions(
  options: SealErasurePurgeAuthorityOptions,
): void {
  assertSafeTimestamp(options.nowMs, "authority seal timestamp");
}

export function checkedRetentionDeadline(
  anchorMs: number,
  durationMs: number | null,
): { kind: "deadline"; value: number } | { kind: "unconfigured" } | { kind: "invalid" } {
  if (!Number.isSafeInteger(anchorMs) || anchorMs < 0) return { kind: "invalid" };
  if (durationMs === null) return { kind: "unconfigured" };
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return { kind: "invalid" };
  const value = anchorMs + durationMs;
  return Number.isSafeInteger(value) ? { kind: "deadline", value } : { kind: "invalid" };
}

export function newErasurePolicyEvaluationJob(
  identity: Pick<ErasurePolicyEvaluationJob,
    "requestId" | "tenantId" | "subjectKind" | "subjectId" | "subjectGeneration">,
  atMs: number,
): ErasurePolicyEvaluationJob {
  assertSafeTimestamp(atMs, "evaluation job creation timestamp");
  return {
    ...identity,
    buildGeneration: 1,
    targetCount: 0,
    targetRootSha256: EMPTY_ERASURE_PURGE_TARGET_ROOT_SHA256,
    availableAtMs: atMs,
    attempts: 0,
    createdAtMs: atMs,
    updatedAtMs: atMs,
  };
}
