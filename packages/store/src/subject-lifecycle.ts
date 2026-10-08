import { createHash, randomUUID } from "node:crypto";
import { UserId } from "@agent-service/protocol";

export type DataSubjectKind = "tenant" | "user";
export type SubjectLifecycleState = "active" | "deleting" | "erased";

export interface SubjectLifecycleRecord {
  tenantId: string;
  subjectKind: DataSubjectKind;
  /** tenant id for tenant scope, user id for user scope */
  subjectId: string;
  state: SubjectLifecycleState;
  generation: number;
  activeRequestId?: string;
  legalHoldAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * The durable worker may advance through the reversible/hidden phases and stop at
 * `awaiting_purge_policy`. `completed` is reserved for a later policy-authorized path that can
 * prove physical content erasure; merely gating or tombstoning a subject must never use it.
 */
export type ErasureRequestStatus =
  | "gated"
  | "draining"
  | "tombstoning"
  | "reconciling_usage"
  | "awaiting_purge_policy"
  | "purging"
  | "blocked"
  | "completed";

const ERASURE_REQUEST_STATUS_SET = new Set<ErasureRequestStatus>([
  "gated",
  "draining",
  "tombstoning",
  "reconciling_usage",
  "awaiting_purge_policy",
  "purging",
  "blocked",
  "completed",
]);

export const CLAIMABLE_ERASURE_REQUEST_STATUSES = [
  "gated",
  "draining",
  "tombstoning",
  "reconciling_usage",
] as const satisfies readonly ErasureRequestStatus[];

export type ClaimableErasureRequestStatus = (typeof CLAIMABLE_ERASURE_REQUEST_STATUSES)[number];

const CLAIMABLE_ERASURE_REQUEST_STATUS_SET = new Set<ErasureRequestStatus>(
  CLAIMABLE_ERASURE_REQUEST_STATUSES,
);

export const ERASURE_JOB_ERROR_CODES = [
  "temporary_failure",
  "owner_unavailable",
  "drain_timeout",
  "integrity_conflict",
  "legal_hold",
  "policy_unavailable",
  "legacy_blocked",
  "legacy_compensation_pending",
] as const;
export type ErasureJobErrorCode = (typeof ERASURE_JOB_ERROR_CODES)[number];
const ERASURE_JOB_ERROR_CODE_SET = new Set<string>(ERASURE_JOB_ERROR_CODES);

export const ERASURE_JOB_QUARANTINE_REASON_CODES = [
  "request_invalid",
  "subject_binding_invalid",
  "audit_chain_invalid",
  "idempotency_binding_invalid",
  "queue_control_invalid",
  "policy_identity_invalid",
  "control_audit_invalid",
] as const;
export type ErasureJobQuarantineReasonCode = (typeof ERASURE_JOB_QUARANTINE_REASON_CODES)[number];
const ERASURE_JOB_QUARANTINE_REASON_CODE_SET = new Set<string>(ERASURE_JOB_QUARANTINE_REASON_CODES);

export const ERASURE_JOB_MAINTENANCE_ACTION_CODES = [
  "normalize_queue_control",
  "restore_initial_gate_audit",
  "resume_verified",
  "resume_blocked",
] as const;
export type ErasureJobMaintenanceActionCode = (typeof ERASURE_JOB_MAINTENANCE_ACTION_CODES)[number];
const ERASURE_JOB_MAINTENANCE_ACTION_CODE_SET = new Set<string>(ERASURE_JOB_MAINTENANCE_ACTION_CODES);

export const ERASURE_JOB_CONTROL_EVENT_TYPES = [
  "erasure_job/quarantined",
  "erasure_job/quarantine_repaired",
  "erasure_job/blocked_resumed",
] as const;
export type ErasureJobControlEventType = (typeof ERASURE_JOB_CONTROL_EVENT_TYPES)[number];
const ERASURE_JOB_CONTROL_EVENT_TYPE_SET = new Set<string>(ERASURE_JOB_CONTROL_EVENT_TYPES);

export type ErasureJobControlReasonCode = ErasureJobQuarantineReasonCode | ErasureJobErrorCode;

export const ERASURE_JOB_TERMINAL_INCIDENT_REASON_CODES = [
  "unsafe_quarantine_envelope",
] as const;
export type ErasureJobTerminalIncidentReasonCode =
  (typeof ERASURE_JOB_TERMINAL_INCIDENT_REASON_CODES)[number];

/**
 * Exact, pre-isolation fields committed by a terminal incident. Numeric database values remain
 * decimal strings so a BIGINT outside JavaScript's safe range is never rounded before hashing.
 * The raw owner fields are inputs to the digest only; the durable incident row does not copy them.
 */
export interface ErasureJobUnsafeQuarantineEnvelope {
  /** Durable row locator; identical to requestId in MySQL, explicit for Memory corruption tests. */
  locatorRequestId: string;
  /** Exact request_id field observed before isolation, even when it is not canonical. */
  requestId: string;
  tenantId: string;
  subjectKind: string;
  subjectId: string;
  rawGeneration: string;
  status: string;
  rawCreatedAtMs: string;
  rawGatedAtMs: string | null;
  rawUpdatedAtMs: string;
  rawControlGeneration: string;
}

/** Private append-only audit for a row that cannot safely enter the repairable control chain. */
export interface ErasureJobTerminalIncident {
  terminalIncidentId: number;
  requestId: string;
  rawControlGeneration: string;
  reasonCode: ErasureJobTerminalIncidentReasonCode;
  evidenceSha256: string;
  emittedAtMs: number;
}

export interface ErasureRequestRecord {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  generation: number;
  status: ErasureRequestStatus;
  requestedByKeyId: string;
  /** Stored only for request replay; never return it from a public response. */
  idempotencyKey: string;
  requestHash: string;
  createdAtMs: number;
  gatedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  counts?: Record<string, number>;
  checksum?: string;
  /** Undefined means deliberately unavailable to workers. */
  availableAtMs?: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  /** A bounded enum only. Raw worker errors and stacks must never be persisted here. */
  lastErrorCode?: ErasureJobErrorCode;
  policyVersion?: string;
  policyHash?: string;
  /** Monotonic ABA fence for quarantine and administrator repair/resume operations. */
  controlGeneration: number;
  /** The three quarantine markers are always all present or all absent. */
  quarantinedAtMs?: number;
  quarantineReasonCode?: ErasureJobQuarantineReasonCode;
  quarantineEvidenceSha256?: string;
}

export interface ErasureAuditEvent {
  requestId: string;
  seq: number;
  type: "erasure/gated" | "erasure/status_changed" | "erasure/blocked" | "erasure/resumed" | "erasure/completed";
  /** Audit payloads may contain counts/checksums/status only, never prompts or resource bodies. */
  payload: Record<string, unknown>;
  emittedAtMs: number;
}

/** Append-only, content-free control-plane audit; there is deliberately no JSON payload. */
export interface ErasureJobControlEvent {
  controlEventId: number;
  requestId: string;
  controlGeneration: number;
  eventType: ErasureJobControlEventType;
  phase: ErasureRequestStatus;
  reasonCode: ErasureJobControlReasonCode;
  actionCode?: ErasureJobMaintenanceActionCode;
  actorKeyId?: string;
  beforeSha256: string;
  afterSha256?: string;
  emittedAtMs: number;
}

export interface RequestUserErasureInput {
  requestId: string;
  tenantId: string;
  userId: string;
  requestedByKeyId: string;
  idempotencyKey: string;
  requestHash: string;
  atMs: number;
}

/** Separate capability from SessionStore: erasure orchestration must not acquire general write APIs. */
export interface SubjectLifecycleStore {
  requestUserErasure(input: RequestUserErasureInput): Promise<ErasureRequestRecord>;
  getUserErasureRequest(tenantId: string, userId: string, requestId: string): Promise<ErasureRequestRecord | null>;
  getSubjectLifecycle(tenantId: string, subjectKind: DataSubjectKind, subjectId: string): Promise<SubjectLifecycleRecord | null>;
  listErasureAuditEvents(requestId: string): Promise<ErasureAuditEvent[]>;
}

export interface ClaimErasureJobsOptions {
  nowMs: number;
  limit: number;
  leaseMs: number;
  claimToken: string;
}

/** Generic authority returned by the durable queue and required for every job acknowledgement. */
export interface ErasureJobAuthorization {
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  requestId: string;
  subjectGeneration: number;
  claimToken: string;
  /** Monotonic claim identity prevents token reuse from creating an ABA-authority match. */
  claimAttempt: number;
}

/** User-erasure authority shared with the later gate-aware session snapshot/commit surface. */
export interface ErasureWriteAuthorization {
  tenantId: string;
  userId: string;
  requestId: string;
  subjectGeneration: number;
  claimToken: string;
  claimAttempt: number;
}

export interface RenewErasureJobClaimOptions {
  nowMs: number;
  leaseMs: number;
}

/** Worker-facing least-privilege projection; request actor/idempotency/hash never leave the store. */
export interface ErasureJobClaim {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  subjectGeneration: number;
  status: ClaimableErasureRequestStatus;
  availableAtMs: number;
  attempts: number;
  claimToken: string;
  leaseUntilMs: number;
  policyVersion?: string;
  policyHash?: string;
}

export interface TransitionErasureJobOptions {
  fromStatus: ErasureRequestStatus;
  toStatus: ErasureRequestStatus;
  atMs: number;
  /** Required for a claimable destination; forbidden for an unavailable destination. */
  availableAtMs?: number;
  /** Required only when entering blocked. */
  errorCode?: ErasureJobErrorCode;
  /** May only repeat the immutable identity selected at admission; it cannot bind old backlog. */
  policyVersion?: string;
  policyHash?: string;
  /** Completion proof contains aggregate counts/checksum only, never content. */
  counts?: Record<string, number>;
  checksum?: string;
}

export interface RetryErasureJobOptions {
  failedAtMs: number;
  availableAtMs: number;
  errorCode: ErasureJobErrorCode;
}

/**
 * Least-privilege durable erasure queue. It can lease and advance requests but cannot read or
 * mutate session content. Session lifecycle work uses ErasureWriteAuthorization separately.
 */
export interface ErasureJobStore {
  claimErasureJobs(options: ClaimErasureJobsOptions): Promise<ErasureJobClaim[]>;
  renewErasureJobClaim(
    authorization: ErasureJobAuthorization,
    options: RenewErasureJobClaimOptions,
  ): Promise<boolean>;
  transitionErasureJob(
    authorization: ErasureJobAuthorization,
    options: TransitionErasureJobOptions,
  ): Promise<boolean>;
  retryErasureJob(
    authorization: ErasureJobAuthorization,
    options: RetryErasureJobOptions,
  ): Promise<boolean>;
}

export interface ErasureJobMaintenanceIdentity {
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  requestId: string;
  subjectGeneration: number;
}

export interface ErasureJobInterventionInspection {
  requestId: string;
  phase: ErasureRequestStatus;
  controlGeneration: number;
  kind: "quarantine" | "blocked";
  reasonCode: ErasureJobControlReasonCode;
  evidenceSha256: string;
  occurredAtMs: number;
  /** Present only for a blocked row whose prior phase can be derived from its strict main audit. */
  resumePhase?: ClaimableErasureRequestStatus;
  allowedActions: ErasureJobMaintenanceActionCode[];
}

export interface RepairAndResumeErasureJobInput extends ErasureJobMaintenanceIdentity {
  expectedControlGeneration: number;
  expectedEvidenceSha256: string;
  actorKeyId: string;
  actionCode: ErasureJobMaintenanceActionCode;
  atMs: number;
}

/** Administrator capability is intentionally separate from the normal worker queue surface. */
export interface ErasureJobMaintenanceStore {
  inspectErasureJobIntervention(
    identity: ErasureJobMaintenanceIdentity,
  ): Promise<ErasureJobInterventionInspection | null>;
  repairAndResumeErasureJob(input: RepairAndResumeErasureJobInput): Promise<boolean>;
}

export function erasureJobClaimFromRecord(record: ErasureRequestRecord): ErasureJobClaim {
  validateErasureRequestRecord(record);
  if (
    !isClaimableErasureRequestStatus(record.status)
    || record.availableAtMs === undefined
    || record.claimToken === undefined
    || record.leaseUntilMs === undefined
  ) throw new Error("erasure request is not an active worker claim");
  return {
    requestId: record.requestId,
    tenantId: record.tenantId,
    subjectKind: record.subjectKind,
    subjectId: record.subjectId,
    subjectGeneration: record.generation,
    status: record.status,
    availableAtMs: record.availableAtMs,
    attempts: record.attempts,
    claimToken: record.claimToken,
    leaseUntilMs: record.leaseUntilMs,
    ...(record.policyVersion === undefined ? {} : { policyVersion: record.policyVersion }),
    ...(record.policyHash === undefined ? {} : { policyHash: record.policyHash }),
  };
}

/** New user-owned writes are rejected once an erasure gate has linearized. */
export class SubjectDeletingError extends Error {
  constructor(public readonly tenantId: string, public readonly userId?: string) {
    super(userId ? "the data subject is being erased" : "the tenant is being erased");
    this.name = "SubjectDeletingError";
  }
}

export class ErasureIdempotencyMismatchError extends Error {
  constructor() {
    super("this Idempotency-Key was already used for a different erasure request");
    this.name = "ErasureIdempotencyMismatchError";
  }
}

export class ErasureJobTransitionError extends Error {
  constructor(fromStatus: ErasureRequestStatus, toStatus: ErasureRequestStatus) {
    super(`illegal erasure job transition: ${fromStatus} -> ${toStatus}`);
    this.name = "ErasureJobTransitionError";
  }
}

const ERASURE_JOB_TRANSITIONS: Readonly<Record<ErasureRequestStatus, ReadonlySet<ErasureRequestStatus>>> = {
  gated: new Set(["draining", "blocked"]),
  draining: new Set(["tombstoning", "blocked"]),
  tombstoning: new Set(["reconciling_usage", "blocked"]),
  reconciling_usage: new Set(["awaiting_purge_policy", "blocked"]),
  awaiting_purge_policy: new Set(["purging"]),
  purging: new Set(["completed", "blocked"]),
  blocked: new Set(),
  completed: new Set(),
};

const ERASURE_REQUEST_ID = /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLICY_VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const ACTOR_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

function assertPositiveGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("subjectGeneration must be a positive safe integer");
}

export function assertErasureClaimToken(claimToken: string): void {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(claimToken)) {
    throw new Error("claimToken must contain 1 to 64 safe characters");
  }
}

export function isClaimableErasureRequestStatus(
  status: ErasureRequestStatus,
): status is ClaimableErasureRequestStatus {
  return CLAIMABLE_ERASURE_REQUEST_STATUS_SET.has(status);
}

export function assertErasureJobErrorCode(errorCode: string): asserts errorCode is ErasureJobErrorCode {
  if (!ERASURE_JOB_ERROR_CODE_SET.has(errorCode)) throw new Error("unsupported erasure job error code");
}

export function assertErasureJobQuarantineReasonCode(
  reasonCode: string,
): asserts reasonCode is ErasureJobQuarantineReasonCode {
  if (!ERASURE_JOB_QUARANTINE_REASON_CODE_SET.has(reasonCode)) {
    throw new Error("unsupported erasure job quarantine reason code");
  }
}

export function assertErasureJobMaintenanceActionCode(
  actionCode: string,
): asserts actionCode is ErasureJobMaintenanceActionCode {
  if (!ERASURE_JOB_MAINTENANCE_ACTION_CODE_SET.has(actionCode)) {
    throw new Error("unsupported erasure job maintenance action code");
  }
}

export function isErasureJobQuarantined(record: ErasureRequestRecord): boolean {
  return record.quarantinedAtMs !== undefined
    && record.quarantineReasonCode !== undefined
    && record.quarantineEvidenceSha256 !== undefined;
}

/** Public status intentionally reveals neither the quarantine reason nor the maintenance token. */
export function publicErasureRequestStatus(record: ErasureRequestRecord): ErasureRequestStatus {
  return isErasureJobQuarantined(record) ? "blocked" : record.status;
}

export function erasureJobInterventionEvidenceSha256(input: {
  requestId: string;
  controlGeneration: number;
  phase: ErasureRequestStatus;
  kind: "quarantine" | "blocked";
  reasonCode: ErasureJobControlReasonCode;
}): string {
  if (!ERASURE_REQUEST_ID.test(input.requestId)) throw new Error("invalid erasure request id");
  if (!Number.isSafeInteger(input.controlGeneration) || input.controlGeneration < 0) {
    throw new Error("invalid erasure control generation");
  }
  if (!ERASURE_REQUEST_STATUS_SET.has(input.phase)) throw new Error("invalid erasure phase");
  if (
    !ERASURE_JOB_QUARANTINE_REASON_CODE_SET.has(input.reasonCode)
    && !ERASURE_JOB_ERROR_CODE_SET.has(input.reasonCode)
  ) throw new Error("invalid erasure control reason code");
  return createHash("sha256").update(JSON.stringify([
    "erasure-job-intervention-v1",
    input.requestId,
    input.controlGeneration,
    input.phase,
    input.kind,
    input.reasonCode,
  ])).digest("hex");
}

/**
 * Evidence for the one terminal exception where the monotonic control fence has no representable
 * successor. The exact durable decimal BIGINT is bound into the hash but is never returned.
 */
export function erasureJobTerminalInterventionEvidenceSha256(input: {
  requestId: string;
  rawControlGeneration: string;
  phase: ErasureRequestStatus;
  reasonCode: "control_audit_invalid";
}): string {
  if (!ERASURE_REQUEST_ID.test(input.requestId)) throw new Error("invalid erasure request id");
  if (!/^(?:0|[1-9][0-9]*)$/.test(input.rawControlGeneration)) {
    throw new Error("invalid raw erasure control generation");
  }
  if (BigInt(input.rawControlGeneration) < BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("terminal erasure control generation is not saturated");
  }
  if (!isClaimableErasureRequestStatus(input.phase)) throw new Error("invalid erasure terminal phase");
  return createHash("sha256").update(JSON.stringify([
    "erasure-job-terminal-intervention-v1",
    input.requestId,
    input.rawControlGeneration,
    input.phase,
    "quarantine",
    input.reasonCode,
  ])).digest("hex");
}

/**
 * Content-free commitment for an irreparable request envelope. This domain is intentionally
 * separate from repairable quarantine evidence: none of these raw owner fields are copied into
 * the incident audit, and the resulting marker can never authorize repair or resume.
 */
export function erasureJobUnsafeQuarantineEnvelopeEvidenceSha256(
  input: ErasureJobUnsafeQuarantineEnvelope,
): string {
  return createHash("sha256").update(JSON.stringify([
    "erasure-job-unsafe-quarantine-envelope-v1",
    input.locatorRequestId,
    input.requestId,
    input.tenantId,
    input.subjectKind,
    input.subjectId,
    input.rawGeneration,
    input.status,
    input.rawCreatedAtMs,
    input.rawGatedAtMs,
    input.rawUpdatedAtMs,
    input.rawControlGeneration,
    "unsafe_quarantine_envelope",
  ])).digest("hex");
}

/**
 * Replayable commitment to a maintenance control outcome. It deliberately hashes only fields in
 * the append-only event: a historical row snapshot cannot be reconstructed after normal worker
 * progress, so `afterSha256` must never pretend to prove such a snapshot.
 */
export function erasureJobControlOutcomeSha256(event: Pick<
  ErasureJobControlEvent,
  | "requestId"
  | "controlGeneration"
  | "eventType"
  | "phase"
  | "reasonCode"
  | "actionCode"
  | "actorKeyId"
  | "beforeSha256"
  | "emittedAtMs"
>): string {
  return createHash("sha256").update(JSON.stringify([
    "erasure-job-control-outcome-v1",
    event.requestId,
    event.controlGeneration,
    event.eventType,
    event.phase,
    event.reasonCode,
    event.actionCode ?? null,
    event.actorKeyId ?? null,
    event.beforeSha256,
    event.emittedAtMs,
  ])).digest("hex");
}

export function assertErasureJobTransition(
  fromStatus: ErasureRequestStatus,
  toStatus: ErasureRequestStatus,
): void {
  if (
    !ERASURE_REQUEST_STATUS_SET.has(fromStatus)
    || !ERASURE_REQUEST_STATUS_SET.has(toStatus)
    || !ERASURE_JOB_TRANSITIONS[fromStatus].has(toStatus)
  ) {
    throw new ErasureJobTransitionError(fromStatus, toStatus);
  }
}

function validateCounts(counts: Record<string, number> | undefined): void {
  if (counts === undefined) return;
  const entries = Object.entries(counts);
  if (entries.length > 64) throw new Error("erasure completion counts have too many fields");
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("invalid erasure completion counts");
    }
  }
}

function validatePolicyIdentity(policyVersion: string | undefined, policyHash: string | undefined): void {
  if ((policyVersion === undefined) !== (policyHash === undefined)) {
    throw new Error("erasure policy version and hash must be provided together");
  }
  if (policyVersion !== undefined && !POLICY_VERSION.test(policyVersion)) {
    throw new Error("invalid erasure policy version");
  }
  if (policyHash !== undefined && !/^[0-9a-f]{64}$/.test(policyHash)) {
    throw new Error("invalid erasure policy hash");
  }
}

function validateErasureRequestQuarantineEnvelope(record: ErasureRequestRecord): void {
  if (!ERASURE_REQUEST_ID.test(record.requestId)) throw new Error("stored erasure request id is invalid");
  if (!record.tenantId || record.tenantId.length > 128) throw new Error("stored erasure tenant id is invalid");
  if (
    (record.subjectKind !== "tenant" && record.subjectKind !== "user")
    || (record.subjectKind === "tenant" && record.subjectId !== record.tenantId)
    || (record.subjectKind === "user" && !UserId.safeParse(record.subjectId).success)
  ) throw new Error("stored erasure subject identity is invalid");
  assertPositiveGeneration(record.generation);
  if (!isClaimableErasureRequestStatus(record.status)) {
    throw new Error("stored erasure quarantine phase is invalid");
  }
  assertTimestamp(record.createdAtMs, "stored erasure creation timestamp");
  assertTimestamp(record.gatedAtMs, "stored erasure gate timestamp");
  assertTimestamp(record.updatedAtMs, "stored erasure update timestamp");
  if (record.gatedAtMs < record.createdAtMs || record.updatedAtMs < record.gatedAtMs) {
    throw new Error("stored erasure request timestamps are invalid");
  }
  if (!Number.isSafeInteger(record.controlGeneration) || record.controlGeneration < 0) {
    throw new Error("stored erasure control generation is invalid");
  }
}

/** Whether a corrupt request still has enough trustworthy identity/time data for normal repair. */
export function hasSafeErasureRequestQuarantineEnvelope(record: ErasureRequestRecord): boolean {
  try {
    validateErasureRequestQuarantineEnvelope(record);
    return true;
  } catch {
    return false;
  }
}

/** Strict durable-row validation shared by Memory/MySQL and later authority-bearing stores. */
export function validateErasureRequestRecord(record: ErasureRequestRecord): void {
  if (!ERASURE_REQUEST_ID.test(record.requestId)) throw new Error("stored erasure request id is invalid");
  if (!record.tenantId || record.tenantId.length > 128) throw new Error("stored erasure tenant id is invalid");
  if (record.subjectKind !== "tenant" && record.subjectKind !== "user") {
    throw new Error("stored erasure subject kind is invalid");
  }
  if (
    (record.subjectKind === "tenant" && record.subjectId !== record.tenantId)
    || (record.subjectKind === "user" && !UserId.safeParse(record.subjectId).success)
  ) throw new Error("stored erasure subject identity is invalid");
  assertPositiveGeneration(record.generation);
  if (!ERASURE_REQUEST_STATUS_SET.has(record.status)) throw new Error("stored erasure request status is invalid");
  if (!ACTOR_KEY_ID.test(record.requestedByKeyId)) {
    throw new Error("stored erasure actor key id is invalid");
  }
  if (!record.idempotencyKey || record.idempotencyKey.length > 256) {
    throw new Error("stored erasure idempotency key is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(record.requestHash)) throw new Error("stored erasure request hash is invalid");
  assertTimestamp(record.createdAtMs, "stored erasure creation timestamp");
  assertTimestamp(record.gatedAtMs, "stored erasure gate timestamp");
  assertTimestamp(record.updatedAtMs, "stored erasure update timestamp");
  if (record.gatedAtMs < record.createdAtMs || record.updatedAtMs < record.gatedAtMs) {
    throw new Error("stored erasure request timestamps are invalid");
  }
  if (!Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > 0xffff_ffff) {
    throw new Error("stored erasure attempts are invalid");
  }
  if (record.availableAtMs !== undefined) assertTimestamp(record.availableAtMs, "stored erasure availability");
  if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) {
    throw new Error("stored erasure claim is incomplete");
  }
  if (record.claimToken !== undefined) assertErasureClaimToken(record.claimToken);
  if (record.leaseUntilMs !== undefined) assertTimestamp(record.leaseUntilMs, "stored erasure lease");
  if (record.lastErrorCode !== undefined) assertErasureJobErrorCode(record.lastErrorCode);
  validatePolicyIdentity(record.policyVersion, record.policyHash);
  if (!Number.isSafeInteger(record.controlGeneration) || record.controlGeneration < 0) {
    throw new Error("stored erasure control generation is invalid");
  }
  if (record.controlGeneration === Number.MAX_SAFE_INTEGER) {
    throw new Error("stored erasure control generation is saturated");
  }
  const quarantineMarkerCount = [
    record.quarantinedAtMs,
    record.quarantineReasonCode,
    record.quarantineEvidenceSha256,
  ].filter((value) => value !== undefined).length;
  if (quarantineMarkerCount !== 0 && quarantineMarkerCount !== 3) {
    throw new Error("stored erasure quarantine markers are incomplete");
  }
  const quarantined = quarantineMarkerCount === 3;
  if (quarantined) {
    assertTimestamp(record.quarantinedAtMs!, "stored erasure quarantine timestamp");
    if (record.quarantinedAtMs! < record.gatedAtMs || record.quarantinedAtMs! > record.updatedAtMs) {
      throw new Error("stored erasure quarantine timestamp is invalid");
    }
    assertErasureJobQuarantineReasonCode(record.quarantineReasonCode!);
    if (!SHA256.test(record.quarantineEvidenceSha256!)) {
      throw new Error("stored erasure quarantine evidence is invalid");
    }
    if (record.controlGeneration <= 0 || !isClaimableErasureRequestStatus(record.status)) {
      throw new Error("stored erasure quarantine phase is invalid");
    }
  }
  if (record.completedAtMs !== undefined) assertTimestamp(record.completedAtMs, "stored erasure completion timestamp");
  validateCounts(record.counts);
  if (record.checksum !== undefined && !/^[0-9a-f]{64}$/.test(record.checksum)) {
    throw new Error("stored erasure checksum is invalid");
  }
  if ((record.counts === undefined) !== (record.checksum === undefined)) {
    throw new Error("stored erasure completion proof is incomplete");
  }
  if (quarantined) {
    if (
      record.availableAtMs !== undefined
      || record.claimToken !== undefined
      || record.leaseUntilMs !== undefined
    ) throw new Error("quarantined erasure request carries worker authority");
  } else if (isClaimableErasureRequestStatus(record.status)) {
    if (record.availableAtMs === undefined) throw new Error("claimable erasure request is unavailable");
  } else if (record.status === "purging") {
    // 0012 workers could already have a live purging claim. New normal workers never claim or
    // acknowledge it, but the reader must preserve that row during the drain/forward-fix window.
  } else if (
    record.availableAtMs !== undefined
    || record.claimToken !== undefined
    || record.leaseUntilMs !== undefined
  ) {
    throw new Error("unclaimable erasure request carries worker authority");
  }
  if (record.status === "completed") {
    if (record.completedAtMs === undefined) throw new Error("completed erasure request has no completion timestamp");
    if (record.completedAtMs < record.updatedAtMs || record.counts === undefined || record.checksum === undefined) {
      throw new Error("completed erasure request has invalid completion proof");
    }
  } else if (record.completedAtMs !== undefined || record.counts !== undefined || record.checksum !== undefined) {
    throw new Error("non-completed erasure request carries completion proof");
  }
  if (record.status === "blocked" && record.lastErrorCode === undefined) {
    throw new Error("blocked erasure request has no error code");
  }
}

/**
 * Decode boundary for owner-scoped status reads. A quarantined row may deliberately retain a
 * poisoned private field so the evidence is not destroyed; only its public-safe envelope and
 * three control markers are decoded here. Worker and maintenance resume paths must still call the
 * strict validator above before granting authority.
 */
export function validateErasureRequestRecordForRead(record: ErasureRequestRecord): void {
  if (!isErasureJobQuarantined(record)) {
    validateErasureRequestRecord(record);
    return;
  }
  validateErasureRequestQuarantineEnvelope(record);
  assertTimestamp(record.quarantinedAtMs!, "stored erasure quarantine timestamp");
  if (record.quarantinedAtMs! < record.gatedAtMs || record.quarantinedAtMs! > record.updatedAtMs) {
    throw new Error("stored erasure quarantine timestamp is invalid");
  }
  assertErasureJobQuarantineReasonCode(record.quarantineReasonCode!);
  if (!SHA256.test(record.quarantineEvidenceSha256!)) {
    throw new Error("stored erasure quarantine evidence is invalid");
  }
  if (record.controlGeneration <= 0) throw new Error("stored erasure quarantine authority is invalid");
  // Full quarantine markers make the row unavailable to claim scans. Deliberately ignore any
  // residual private queue fields here—even malformed ones—so owner status and the CAS-bound
  // maintenance repair cannot become a dead end. The strict authority validator above still
  // rejects the overlay and repair clears all three fields atomically before restoring authority.
}

function auditStatus(value: unknown): ErasureRequestStatus {
  if (typeof value !== "string" || !ERASURE_REQUEST_STATUS_SET.has(value as ErasureRequestStatus)) {
    throw new Error("erasure request audit chain has an invalid status");
  }
  return value as ErasureRequestStatus;
}

function assertExactAuditPayloadKeys(
  payload: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(payload).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new Error("erasure request audit payload contains unexpected fields");
}

function completionCountsEqual(
  left: unknown,
  right: Record<string, number> | undefined,
): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left) || right === undefined) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key] === value);
}

/** Validate that the audit log is a complete, legal state chain whose tail is the request row. */
export function validateErasureAuditChain(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
): void {
  validateErasureRequestRecord(record);
  if (audits.length === 0) throw new Error("erasure request audit chain is corrupt");
  let status: ErasureRequestStatus = "gated";
  let emittedAtMs = -1;
  let policyVersion: string | undefined;
  let policyHash: string | undefined;
  for (const [index, audit] of audits.entries()) {
    if (
      audit.requestId !== record.requestId
      || audit.seq !== index + 1
      || !Number.isSafeInteger(audit.emittedAtMs)
      || audit.emittedAtMs < 0
      || audit.emittedAtMs < emittedAtMs
      || typeof audit.payload !== "object"
      || audit.payload === null
      || Array.isArray(audit.payload)
    ) throw new Error("erasure request audit chain is corrupt");
    emittedAtMs = audit.emittedAtMs;
    if (index === 0) {
      const initialPolicyVersion = audit.payload.policyVersion;
      const initialPolicyHash = audit.payload.policyHash;
      const carriesPolicy = initialPolicyVersion !== undefined || initialPolicyHash !== undefined;
      assertExactAuditPayloadKeys(audit.payload, [
        "status",
        "subjectKind",
        "generation",
        ...(carriesPolicy ? ["policyVersion", "policyHash"] : []),
      ]);
      if (
        audit.type !== "erasure/gated"
        || audit.payload.status !== "gated"
        || audit.payload.subjectKind !== record.subjectKind
        || audit.payload.generation !== record.generation
        || audit.emittedAtMs !== record.gatedAtMs
      ) throw new Error("erasure request gated audit identity is corrupt");
      if (carriesPolicy) {
        if (typeof initialPolicyVersion !== "string" || typeof initialPolicyHash !== "string") {
          throw new Error("erasure request gated audit policy identity is incomplete");
        }
        validatePolicyIdentity(initialPolicyVersion, initialPolicyHash);
        policyVersion = initialPolicyVersion;
        policyHash = initialPolicyHash;
      }
      continue;
    }

    const fromStatus = auditStatus(audit.payload.fromStatus);
    const toStatus = auditStatus(audit.payload.status);
    if (fromStatus !== status || audit.payload.generation !== record.generation) {
      throw new Error("erasure request audit chain does not match its prior state");
    }
    let expectedType: ErasureAuditEvent["type"];
    if (audit.type === "erasure/resumed") {
      const blockedAudit = audits[index - 1];
      if (
        fromStatus !== "blocked"
        || !blockedAudit
        || blockedAudit.type !== "erasure/blocked"
        || blockedAudit.payload.status !== "blocked"
      ) throw new Error("erasure resume audit has no prior blocked state");
      const derivedTarget = auditStatus(blockedAudit.payload.fromStatus);
      const blockedError = blockedAudit.payload.errorCode;
      if (
        toStatus !== derivedTarget
        || !isClaimableErasureRequestStatus(toStatus)
        || derivedTarget === "purging"
        || blockedError === "policy_unavailable"
        || blockedError === "legal_hold"
      ) throw new Error("erasure resume audit target is not safe");
      expectedType = "erasure/resumed";
    } else {
      assertErasureJobTransition(fromStatus, toStatus);
      expectedType = toStatus === "blocked"
        ? "erasure/blocked"
        : toStatus === "completed"
          ? "erasure/completed"
          : "erasure/status_changed";
    }
    if (audit.type !== expectedType) throw new Error("erasure request audit type does not match its state");

    const nextPolicyVersion = audit.payload.policyVersion;
    const nextPolicyHash = audit.payload.policyHash;
    const carriesPolicy = nextPolicyVersion !== undefined || nextPolicyHash !== undefined;
    if (policyVersion !== undefined && !carriesPolicy) {
      throw new Error("erasure request audit policy identity was not carried forward");
    }
    assertExactAuditPayloadKeys(audit.payload, [
      "fromStatus",
      "status",
      "generation",
      ...(carriesPolicy ? ["policyVersion", "policyHash"] : []),
      ...(toStatus === "blocked" ? ["errorCode"] : []),
      ...(toStatus === "completed" ? ["counts", "checksum"] : []),
    ]);
    if (carriesPolicy) {
      if (typeof nextPolicyVersion !== "string" || typeof nextPolicyHash !== "string") {
        throw new Error("erasure request audit policy identity is incomplete");
      }
      validatePolicyIdentity(nextPolicyVersion, nextPolicyHash);
      if (
        policyVersion !== undefined
        && (policyVersion !== nextPolicyVersion || policyHash !== nextPolicyHash)
      ) throw new Error("erasure request audit policy identity changed");
      policyVersion = nextPolicyVersion;
      policyHash = nextPolicyHash;
    }
    if (toStatus === "blocked") {
      if (typeof audit.payload.errorCode !== "string") {
        throw new Error("blocked erasure audit has no error code");
      }
      assertErasureJobErrorCode(audit.payload.errorCode);
    }
    if (toStatus === "completed") {
      const counts = audit.payload.counts;
      const checksum = audit.payload.checksum;
      if (
        typeof counts !== "object"
        || counts === null
        || Array.isArray(counts)
        || typeof checksum !== "string"
      ) throw new Error("completed erasure audit has no proof");
      validateCounts(counts as Record<string, number>);
      if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("completed erasure audit checksum is invalid");
    }
    status = toStatus;
  }
  if (status !== record.status || emittedAtMs > record.updatedAtMs) {
    throw new Error("erasure request audit tail does not match its row");
  }
  if (policyVersion !== record.policyVersion || policyHash !== record.policyHash) {
    throw new Error("erasure request audit policy does not match its row");
  }
  const tail = audits.at(-1)!;
  if (record.status === "blocked" && tail.payload.errorCode !== record.lastErrorCode) {
    throw new Error("blocked erasure audit does not match its row");
  }
  if (tail.type === "erasure/resumed" && record.lastErrorCode !== undefined) {
    throw new Error("resumed erasure request retained its blocked error");
  }
  if (record.status === "completed") {
    if (
      tail.emittedAtMs !== record.completedAtMs
      || !completionCountsEqual(tail.payload.counts, record.counts)
      || tail.payload.checksum !== record.checksum
    ) throw new Error("completed erasure audit proof does not match its row");
  }
}

export function validateErasureJobControlEvent(event: ErasureJobControlEvent): void {
  if (!Number.isSafeInteger(event.controlEventId) || event.controlEventId <= 0) {
    throw new Error("erasure control event id is invalid");
  }
  if (!ERASURE_REQUEST_ID.test(event.requestId)) throw new Error("erasure control event request id is invalid");
  if (!Number.isSafeInteger(event.controlGeneration) || event.controlGeneration <= 0) {
    throw new Error("erasure control event generation is invalid");
  }
  if (!ERASURE_JOB_CONTROL_EVENT_TYPE_SET.has(event.eventType)) {
    throw new Error("erasure control event type is invalid");
  }
  if (!ERASURE_REQUEST_STATUS_SET.has(event.phase)) throw new Error("erasure control event phase is invalid");
  if (
    !ERASURE_JOB_QUARANTINE_REASON_CODE_SET.has(event.reasonCode)
    && !ERASURE_JOB_ERROR_CODE_SET.has(event.reasonCode)
  ) throw new Error("erasure control event reason is invalid");
  if (!SHA256.test(event.beforeSha256)) throw new Error("erasure control event before hash is invalid");
  if (event.afterSha256 !== undefined && !SHA256.test(event.afterSha256)) {
    throw new Error("erasure control event after hash is invalid");
  }
  assertTimestamp(event.emittedAtMs, "erasure control event timestamp");

  if (event.eventType === "erasure_job/quarantined") {
    if (
      !ERASURE_JOB_QUARANTINE_REASON_CODE_SET.has(event.reasonCode)
      || !isClaimableErasureRequestStatus(event.phase)
      || event.actionCode !== undefined
      || event.actorKeyId !== undefined
      || event.afterSha256 !== undefined
    ) throw new Error("erasure quarantine control event is invalid");
    return;
  }

  if (
    event.actionCode === undefined
    || !ERASURE_JOB_MAINTENANCE_ACTION_CODE_SET.has(event.actionCode)
    || event.actorKeyId === undefined
    || !ACTOR_KEY_ID.test(event.actorKeyId)
    || event.afterSha256 === undefined
    || !isClaimableErasureRequestStatus(event.phase)
  ) throw new Error("erasure maintenance control event is invalid");
  if (event.eventType === "erasure_job/quarantine_repaired") {
    if (
      !ERASURE_JOB_QUARANTINE_REASON_CODE_SET.has(event.reasonCode)
      || event.actionCode === "resume_blocked"
    ) throw new Error("erasure quarantine repair event is invalid");
  } else if (
    !ERASURE_JOB_ERROR_CODE_SET.has(event.reasonCode)
    || event.actionCode !== "resume_blocked"
  ) {
    throw new Error("erasure blocked resume event is invalid");
  }
}

type BlockedResumeAuditPair = {
  phase: ClaimableErasureRequestStatus;
  reasonCode: ErasureJobErrorCode;
  resumedAtMs: number;
};

function blockedResumeAuditPairs(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
): BlockedResumeAuditPair[] {
  const pairs: BlockedResumeAuditPair[] = [];
  for (const [index, resumed] of audits.entries()) {
    if (resumed.type !== "erasure/resumed") continue;
    const blocked = audits[index - 1];
    const phase = blocked?.payload.fromStatus;
    const reasonCode = blocked?.payload.errorCode;
    if (
      !blocked
      || blocked.type !== "erasure/blocked"
      || blocked.requestId !== record.requestId
      || resumed.requestId !== record.requestId
      || blocked.seq + 1 !== resumed.seq
      || blocked.payload.status !== "blocked"
      || resumed.payload.fromStatus !== "blocked"
      || resumed.payload.status !== phase
      || blocked.payload.generation !== record.generation
      || resumed.payload.generation !== record.generation
      || typeof phase !== "string"
      || !isClaimableErasureRequestStatus(phase as ErasureRequestStatus)
      || typeof reasonCode !== "string"
      || !ERASURE_JOB_ERROR_CODE_SET.has(reasonCode)
      || !Number.isSafeInteger(blocked.emittedAtMs)
      || blocked.emittedAtMs < 0
      || !Number.isSafeInteger(resumed.emittedAtMs)
      || resumed.emittedAtMs < blocked.emittedAtMs
    ) throw new Error("erasure blocked resume control has no canonical main audit pair");
    pairs.push({
      phase: phase as ClaimableErasureRequestStatus,
      reasonCode: reasonCode as ErasureJobErrorCode,
      resumedAtMs: resumed.emittedAtMs,
    });
  }
  return pairs;
}

function quarantineRepairAction(
  reasonCode: ErasureJobQuarantineReasonCode,
): Exclude<ErasureJobMaintenanceActionCode, "resume_blocked"> | undefined {
  switch (reasonCode) {
    case "queue_control_invalid":
      return "normalize_queue_control";
    case "audit_chain_invalid":
      return "restore_initial_gate_audit";
    case "control_audit_invalid":
      return undefined;
    default:
      return "resume_verified";
  }
}

function hasCanonicalInitialGateAudit(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
): boolean {
  const audit = audits[0];
  return audit !== undefined
    && audit.requestId === record.requestId
    && audit.seq === 1
    && audit.type === "erasure/gated"
    && audit.payload.status === "gated"
    && audit.payload.subjectKind === record.subjectKind
    && audit.payload.generation === record.generation
    && audit.emittedAtMs === record.gatedAtMs;
}

function mainAuditContainsPhaseAt(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
  phase: ClaimableErasureRequestStatus,
  atMs: number,
): boolean {
  return audits.some((audit, index) => {
    if (audit.requestId !== record.requestId || !Number.isSafeInteger(audit.emittedAtMs)) return false;
    const auditPhase = index === 0 ? audit.payload.status : audit.payload.status;
    const nextAtMs = audits[index + 1]?.emittedAtMs;
    return auditPhase === phase
      && audit.emittedAtMs <= atMs
      // Equal timestamps have no cross-table ordering, so both boundary phases are admissible.
      && (nextAtMs === undefined || atMs <= nextAtMs);
  });
}

/**
 * Strictly validate the append-only control chain against both its row overlay and the main audit.
 * `afterSha256` is a replayable event-outcome commitment, never a claim that a historical mutable
 * request-row snapshot was reconstructed.
 */
export function validateErasureJobControlAudit(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
  events: readonly ErasureJobControlEvent[],
): void {
  if (!Number.isSafeInteger(record.controlGeneration) || record.controlGeneration < 0) {
    throw new Error("erasure control generation is invalid");
  }
  const resumePairs = blockedResumeAuditPairs(record, audits);
  let resumePairIndex = 0;
  let priorEventId = 0;
  let priorTimestamp = -1;
  let active: {
    phase: ClaimableErasureRequestStatus;
    reasonCode: ErasureJobQuarantineReasonCode;
    evidenceSha256: string;
    atMs: number;
  } | undefined;
  for (const [index, event] of events.entries()) {
    validateErasureJobControlEvent(event);
    if (
      event.requestId !== record.requestId
      || event.controlGeneration !== index + 1
      || event.controlEventId <= priorEventId
      || event.emittedAtMs < priorTimestamp
      || event.emittedAtMs < record.gatedAtMs
      || event.emittedAtMs > record.updatedAtMs
    ) throw new Error("erasure job control audit chain is corrupt");
    priorEventId = event.controlEventId;
    priorTimestamp = event.emittedAtMs;
    if (event.eventType === "erasure_job/quarantined") {
      if (active) throw new Error("erasure job was quarantined twice without repair");
      const expectedEvidenceSha256 = erasureJobInterventionEvidenceSha256({
        requestId: event.requestId,
        controlGeneration: event.controlGeneration,
        phase: event.phase,
        kind: "quarantine",
        reasonCode: event.reasonCode,
      });
      if (event.beforeSha256 !== expectedEvidenceSha256) {
        throw new Error("erasure quarantine control evidence is not canonical");
      }
      if (
        event.reasonCode !== "audit_chain_invalid"
        && event.reasonCode !== "control_audit_invalid"
        && !mainAuditContainsPhaseAt(
          record,
          audits,
          event.phase as ClaimableErasureRequestStatus,
          event.emittedAtMs,
        )
      ) throw new Error("erasure quarantine control phase does not match its main audit");
      active = {
        phase: event.phase as ClaimableErasureRequestStatus,
        reasonCode: event.reasonCode as ErasureJobQuarantineReasonCode,
        evidenceSha256: expectedEvidenceSha256,
        atMs: event.emittedAtMs,
      };
    } else if (event.eventType === "erasure_job/quarantine_repaired") {
      if (
        !active
        || event.phase !== active.phase
        || event.reasonCode !== active.reasonCode
        || event.beforeSha256 !== active.evidenceSha256
      ) throw new Error("erasure quarantine repair does not match its quarantine");
      if (event.actionCode !== quarantineRepairAction(active.reasonCode)) {
        throw new Error("erasure quarantine repair action does not match its reason");
      }
      if (
        event.actionCode === "restore_initial_gate_audit"
        && (event.phase !== "gated" || !hasCanonicalInitialGateAudit(record, audits))
      ) throw new Error("erasure gate audit repair has no canonical restored audit");
      if (event.afterSha256 !== erasureJobControlOutcomeSha256(event)) {
        throw new Error("erasure quarantine repair outcome is not canonical");
      }
      active = undefined;
    } else {
      if (active) throw new Error("blocked erasure resume cannot bypass an active quarantine");
      const pair = resumePairs[resumePairIndex];
      const expectedEvidenceSha256 = erasureJobInterventionEvidenceSha256({
        requestId: event.requestId,
        controlGeneration: event.controlGeneration - 1,
        phase: "blocked",
        kind: "blocked",
        reasonCode: event.reasonCode,
      });
      if (
        !pair
        || pair.phase !== event.phase
        || pair.reasonCode !== event.reasonCode
        || pair.resumedAtMs !== event.emittedAtMs
        || event.beforeSha256 !== expectedEvidenceSha256
      ) throw new Error("erasure blocked resume control does not match its main audit pair");
      if (event.afterSha256 !== erasureJobControlOutcomeSha256(event)) {
        throw new Error("erasure blocked resume outcome is not canonical");
      }
      resumePairIndex += 1;
    }
  }
  if (resumePairIndex !== resumePairs.length) {
    throw new Error("erasure main audit resume has no matching control event");
  }
  if (events.length !== record.controlGeneration) {
    throw new Error("erasure job control audit tail does not match its row");
  }
  if (active) {
    if (
      record.status !== active.phase
      || record.quarantinedAtMs !== active.atMs
      || record.quarantineReasonCode !== active.reasonCode
      || record.quarantineEvidenceSha256 !== active.evidenceSha256
    ) throw new Error("erasure quarantine overlay does not match its control audit");
  } else if (
    record.quarantinedAtMs !== undefined
    || record.quarantineReasonCode !== undefined
    || record.quarantineEvidenceSha256 !== undefined
  ) {
    throw new Error("erasure quarantine overlay has no active control audit");
  }
}

export class ErasureJobIntegrityFault extends Error {
  constructor(public readonly reasonCode: ErasureJobQuarantineReasonCode) {
    super(`deterministic erasure job integrity fault: ${reasonCode}`);
    this.name = "ErasureJobIntegrityFault";
  }
}

export function newErasureJobIntegrityFault(
  _record: ErasureRequestRecord,
  reasonCode: ErasureJobQuarantineReasonCode,
): ErasureJobIntegrityFault {
  // Classification must not require a safe quarantine envelope: damage to identity, generation or
  // timestamps is itself deterministic poison. Stores decide under the durable row lock whether a
  // fault may enter the repairable control chain or needs irreversible terminal isolation.
  return new ErasureJobIntegrityFault(reasonCode);
}

/** Classify deterministic row-local faults only. Related-row and I/O failures remain store-owned. */
export function classifyErasureJobRecordFault(
  record: ErasureRequestRecord,
): ErasureJobIntegrityFault | null {
  const policyPairComplete = (record.policyVersion === undefined) === (record.policyHash === undefined);
  if (
    !policyPairComplete
    || (record.policyVersion !== undefined && !POLICY_VERSION.test(record.policyVersion))
    || (record.policyHash !== undefined && !SHA256.test(record.policyHash))
  ) return newErasureJobIntegrityFault(record, "policy_identity_invalid");

  if (!Number.isSafeInteger(record.controlGeneration) || record.controlGeneration < 0) {
    return newErasureJobIntegrityFault(record, "control_audit_invalid");
  }
  if (record.controlGeneration === Number.MAX_SAFE_INTEGER) {
    return newErasureJobIntegrityFault(record, "control_audit_invalid");
  }
  const markerCount = [
    record.quarantinedAtMs,
    record.quarantineReasonCode,
    record.quarantineEvidenceSha256,
  ].filter((value) => value !== undefined).length;
  if (markerCount !== 0 && markerCount !== 3) {
    return newErasureJobIntegrityFault(record, "queue_control_invalid");
  }
  if (markerCount === 0) {
    const claimPairComplete = (record.claimToken === undefined) === (record.leaseUntilMs === undefined);
    let claimTokenValid = true;
    try {
      if (record.claimToken !== undefined) assertErasureClaimToken(record.claimToken);
    } catch {
      claimTokenValid = false;
    }
    const leaseValid = record.leaseUntilMs === undefined
      || (Number.isSafeInteger(record.leaseUntilMs) && record.leaseUntilMs >= 0);
    const availabilityValid = record.availableAtMs === undefined
      || (Number.isSafeInteger(record.availableAtMs) && record.availableAtMs >= 0);
    if (
      !claimPairComplete
      || !claimTokenValid
      || !leaseValid
      || !availabilityValid
      || (isClaimableErasureRequestStatus(record.status) && record.availableAtMs === undefined)
    ) return newErasureJobIntegrityFault(record, "queue_control_invalid");
  }
  try {
    validateErasureRequestRecord(record);
    return null;
  } catch {
    return newErasureJobIntegrityFault(record, "request_invalid");
  }
}

export function deriveBlockedErasureResumePhase(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
): ClaimableErasureRequestStatus {
  validateErasureAuditChain(record, audits);
  if (record.status !== "blocked") throw new Error("erasure request is not blocked");
  const tail = audits.at(-1);
  if (!tail || tail.type !== "erasure/blocked" || tail.payload.status !== "blocked") {
    throw new Error("blocked erasure request has no canonical audit tail");
  }
  const resumePhase = auditStatus(tail.payload.fromStatus);
  if (
    !isClaimableErasureRequestStatus(resumePhase)
    || record.lastErrorCode === "policy_unavailable"
    || record.lastErrorCode === "legal_hold"
  ) throw new Error("blocked erasure request cannot be safely resumed");
  return resumePhase;
}

export function erasureJobAllowedMaintenanceActions(
  record: ErasureRequestRecord,
  audits: readonly ErasureAuditEvent[],
): ErasureJobMaintenanceActionCode[] {
  if (isErasureJobQuarantined(record)) {
    const action = quarantineRepairAction(record.quarantineReasonCode!);
    if (action === undefined) {
      // The audit is append-only. A broken chain has no generic, patch-free repair recipe; exposing
      // resume_verified here would advertise an action that the strict repair path must reject.
      return [];
    }
    if (action === "restore_initial_gate_audit") {
      return record.status === "gated" && audits.length === 0 ? [action] : [];
    }
    return [action];
  }
  if (record.status !== "blocked") return [];
  try {
    deriveBlockedErasureResumePhase(record, audits);
    return ["resume_blocked"];
  } catch {
    return [];
  }
}

export function validateErasureJobMaintenanceIdentity(identity: ErasureJobMaintenanceIdentity): void {
  validateErasureJobAuthorization({
    ...identity,
    claimToken: "maintenance",
    claimAttempt: 1,
  });
}

export function validateRepairAndResumeErasureJobInput(input: RepairAndResumeErasureJobInput): void {
  validateErasureJobMaintenanceIdentity(input);
  if (!Number.isSafeInteger(input.expectedControlGeneration) || input.expectedControlGeneration < 0) {
    throw new Error("expectedControlGeneration must be a non-negative safe integer");
  }
  if (!SHA256.test(input.expectedEvidenceSha256)) throw new Error("invalid expected erasure evidence hash");
  if (!ACTOR_KEY_ID.test(input.actorKeyId)) throw new Error("invalid erasure maintenance actor key id");
  assertErasureJobMaintenanceActionCode(input.actionCode);
  assertTimestamp(input.atMs, "erasure maintenance timestamp");
}

export function validateClaimErasureJobsOptions(options: ClaimErasureJobsOptions): number {
  assertTimestamp(options.nowMs, "nowMs");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("leaseMs must be a positive safe integer");
  }
  assertErasureClaimToken(options.claimToken);
  const leaseUntilMs = options.nowMs + options.leaseMs;
  assertTimestamp(leaseUntilMs, "leaseUntilMs");
  return leaseUntilMs;
}

export function validateErasureJobAuthorization(authorization: ErasureJobAuthorization): void {
  if (!ERASURE_REQUEST_ID.test(authorization.requestId)) throw new Error("invalid erasure request id");
  if (!authorization.tenantId || authorization.tenantId.length > 128) throw new Error("invalid erasure tenant id");
  if (authorization.subjectKind !== "tenant" && authorization.subjectKind !== "user") {
    throw new Error("invalid erasure subject kind");
  }
  if (
    (authorization.subjectKind === "tenant" && authorization.subjectId !== authorization.tenantId)
    || (authorization.subjectKind === "user" && !UserId.safeParse(authorization.subjectId).success)
  ) throw new Error("invalid erasure subject identity");
  assertPositiveGeneration(authorization.subjectGeneration);
  assertErasureClaimToken(authorization.claimToken);
  if (!Number.isSafeInteger(authorization.claimAttempt) || authorization.claimAttempt <= 0) {
    throw new Error("claimAttempt must be a positive safe integer");
  }
}

export function validateErasureWriteAuthorization(authorization: ErasureWriteAuthorization): void {
  validateErasureJobAuthorization({
    tenantId: authorization.tenantId,
    subjectKind: "user",
    subjectId: authorization.userId,
    requestId: authorization.requestId,
    subjectGeneration: authorization.subjectGeneration,
    claimToken: authorization.claimToken,
    claimAttempt: authorization.claimAttempt,
  });
}

/** Pure claim check; callers must still lock/re-read both request and subject rows transactionally. */
export function erasureJobAuthorizationMatches(
  record: ErasureRequestRecord,
  authorization: ErasureJobAuthorization,
  nowMs: number,
): boolean {
  validateErasureRequestRecord(record);
  validateErasureJobAuthorization(authorization);
  assertTimestamp(nowMs, "authorization timestamp");
  return record.requestId === authorization.requestId
    && record.tenantId === authorization.tenantId
    && record.subjectKind === authorization.subjectKind
    && record.subjectId === authorization.subjectId
    && record.generation === authorization.subjectGeneration
    && record.claimToken === authorization.claimToken
    && record.attempts === authorization.claimAttempt
    && record.leaseUntilMs !== undefined
    && record.leaseUntilMs > nowMs
    && isClaimableErasureRequestStatus(record.status);
}

export function erasureWriteAuthorizationMatches(
  record: ErasureRequestRecord,
  authorization: ErasureWriteAuthorization,
  nowMs: number,
): boolean {
  validateErasureWriteAuthorization(authorization);
  return erasureJobAuthorizationMatches(record, {
    tenantId: authorization.tenantId,
    subjectKind: "user",
    subjectId: authorization.userId,
    requestId: authorization.requestId,
    subjectGeneration: authorization.subjectGeneration,
    claimToken: authorization.claimToken,
    claimAttempt: authorization.claimAttempt,
  }, nowMs);
}

export function validateRenewErasureJobClaimOptions(options: RenewErasureJobClaimOptions): number {
  assertTimestamp(options.nowMs, "nowMs");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("leaseMs must be a positive safe integer");
  }
  const leaseUntilMs = options.nowMs + options.leaseMs;
  assertTimestamp(leaseUntilMs, "leaseUntilMs");
  return leaseUntilMs;
}

export function validateTransitionErasureJobOptions(options: TransitionErasureJobOptions): void {
  assertErasureJobTransition(options.fromStatus, options.toStatus);
  assertTimestamp(options.atMs, "transition timestamp");
  if (isClaimableErasureRequestStatus(options.toStatus)) {
    if (options.availableAtMs === undefined) throw new Error("claimable erasure status requires availableAtMs");
    assertTimestamp(options.availableAtMs, "availableAtMs");
  } else if (options.availableAtMs !== undefined) {
    throw new Error("unclaimable erasure status must not have availableAtMs");
  }
  if (options.toStatus === "blocked") {
    if (options.errorCode === undefined) throw new Error("blocked erasure status requires an error code");
  } else if (options.errorCode !== undefined) {
    throw new Error("only blocked erasure status may carry an error code");
  }
  if (options.errorCode !== undefined) assertErasureJobErrorCode(options.errorCode);
  validatePolicyIdentity(options.policyVersion, options.policyHash);
  validateCounts(options.counts);
  if (options.checksum !== undefined && !/^[0-9a-f]{64}$/.test(options.checksum)) {
    throw new Error("invalid erasure completion checksum");
  }
  if ((options.counts === undefined) !== (options.checksum === undefined)) {
    throw new Error("erasure completion counts and checksum must be provided together");
  }
  if (options.toStatus !== "completed" && (options.counts !== undefined || options.checksum !== undefined)) {
    throw new Error("completion proof is only valid for completed erasure requests");
  }
  if (options.toStatus === "completed" && (options.counts === undefined || options.checksum === undefined)) {
    throw new Error("completed erasure status requires counts and checksum");
  }
}

export function validateRetryErasureJobOptions(options: RetryErasureJobOptions): void {
  assertTimestamp(options.failedAtMs, "failedAtMs");
  assertTimestamp(options.availableAtMs, "availableAtMs");
  if (options.availableAtMs < options.failedAtMs) throw new Error("retry availability must not precede failure");
  assertErasureJobErrorCode(options.errorCode);
}

export function newErasureRequestId(): string {
  return `erase_${randomUUID()}`;
}

export function userErasureRequestHash(tenantId: string, userId: string): string {
  return createHash("sha256").update(JSON.stringify(["user", tenantId, userId])).digest("hex");
}

export function validateRequestUserErasureInput(input: RequestUserErasureInput): void {
  if (!ERASURE_REQUEST_ID.test(input.requestId)) {
    throw new Error("invalid erasure request id");
  }
  if (!input.tenantId || input.tenantId.length > 128) throw new Error("invalid erasure tenant id");
  if (!UserId.safeParse(input.userId).success) throw new Error("invalid erasure user id");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.requestedByKeyId)) throw new Error("invalid erasure actor key id");
  // Match the public Zod contract and MySQL VARCHAR(256) character limit. Restricting bytes here
  // would accept a request at HTTP validation and then turn a valid Unicode key into a server error.
  if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
    throw new Error("invalid erasure idempotency key");
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error("invalid erasure request hash");
  if (!Number.isSafeInteger(input.atMs) || input.atMs < 0) throw new Error("invalid erasure request timestamp");
  const expectedHash = userErasureRequestHash(input.tenantId, input.userId);
  if (input.requestHash !== expectedHash) throw new Error("erasure request hash does not match its subject");
}

export function subjectLifecycleKey(tenantId: string, subjectKind: DataSubjectKind, subjectId: string): string {
  return JSON.stringify([tenantId, subjectKind, subjectId]);
}
