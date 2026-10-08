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
  "purging",
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
] as const;
export type ErasureJobErrorCode = (typeof ERASURE_JOB_ERROR_CODES)[number];
const ERASURE_JOB_ERROR_CODE_SET = new Set<string>(ERASURE_JOB_ERROR_CODES);

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
}

export interface ErasureAuditEvent {
  requestId: string;
  seq: number;
  type: "erasure/gated" | "erasure/status_changed" | "erasure/blocked" | "erasure/completed";
  /** Audit payloads may contain counts/checksums/status only, never prompts or resource bodies. */
  payload: Record<string, unknown>;
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
  /** Optional immutable policy identity carried forward once selected. */
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
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(record.requestedByKeyId)) {
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
  if (record.completedAtMs !== undefined) assertTimestamp(record.completedAtMs, "stored erasure completion timestamp");
  validateCounts(record.counts);
  if (record.checksum !== undefined && !/^[0-9a-f]{64}$/.test(record.checksum)) {
    throw new Error("stored erasure checksum is invalid");
  }
  if ((record.counts === undefined) !== (record.checksum === undefined)) {
    throw new Error("stored erasure completion proof is incomplete");
  }
  if (isClaimableErasureRequestStatus(record.status)) {
    if (record.availableAtMs === undefined) throw new Error("claimable erasure request is unavailable");
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
      assertExactAuditPayloadKeys(audit.payload, ["status", "subjectKind", "generation"]);
      if (
        audit.type !== "erasure/gated"
        || audit.payload.status !== "gated"
        || audit.payload.subjectKind !== record.subjectKind
        || audit.payload.generation !== record.generation
        || audit.emittedAtMs !== record.gatedAtMs
      ) throw new Error("erasure request gated audit identity is corrupt");
      continue;
    }

    const fromStatus = auditStatus(audit.payload.fromStatus);
    const toStatus = auditStatus(audit.payload.status);
    if (fromStatus !== status || audit.payload.generation !== record.generation) {
      throw new Error("erasure request audit chain does not match its prior state");
    }
    assertErasureJobTransition(fromStatus, toStatus);
    const expectedType: ErasureAuditEvent["type"] = toStatus === "blocked"
      ? "erasure/blocked"
      : toStatus === "completed"
        ? "erasure/completed"
        : "erasure/status_changed";
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
  if (record.status === "completed") {
    if (
      tail.emittedAtMs !== record.completedAtMs
      || !completionCountsEqual(tail.payload.counts, record.counts)
      || tail.payload.checksum !== record.checksum
    ) throw new Error("completed erasure audit proof does not match its row");
  }
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
