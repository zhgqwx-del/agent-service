import { createHash, randomUUID } from "node:crypto";
import { isCanonicalId } from "@agent-service/protocol";
import type { ErasureWriteAuthorization } from "./subject-lifecycle.js";

export const LEGACY_TOMBSTONE_CUTOVER_ID = "legacy-session-tombstone-v1" as const;

export type LegacyTombstoneCompensationJobStatus =
  | "pending"
  | "completed"
  | "terminal_incident";

export const LEGACY_TOMBSTONE_RETRY_ERROR_CODES = [
  "temporary_failure",
  "owner_unavailable",
  "child_pending",
] as const;
export type LegacyTombstoneRetryErrorCode =
  (typeof LEGACY_TOMBSTONE_RETRY_ERROR_CODES)[number];

export const LEGACY_TOMBSTONE_TERMINAL_REASON_CODES = [
  "unsafe_job_envelope",
  "owner_binding_invalid",
  "session_integrity_conflict",
  "child_dependency_invalid",
  "proof_conflict",
] as const;
export type LegacyTombstoneTerminalReasonCode =
  (typeof LEGACY_TOMBSTONE_TERMINAL_REASON_CODES)[number];

const RETRY_ERROR_CODE_SET = new Set<string>(LEGACY_TOMBSTONE_RETRY_ERROR_CODES);
const TERMINAL_REASON_CODE_SET = new Set<string>(LEGACY_TOMBSTONE_TERMINAL_REASON_CODES);
const JOB_ID = /^ltc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERASURE_REQUEST_ID = /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface LegacyTombstoneCutoverRecord {
  cutoverId: typeof LEGACY_TOMBSTONE_CUTOVER_ID;
  /** The first activation is terminal. There is deliberately no generation 2 or disable path. */
  generation: 1;
  activatedByKeyId: string;
  activatedAtMs: number;
}

export interface ActivateLegacyTombstoneCutoverInput {
  cutoverId: typeof LEGACY_TOMBSTONE_CUTOVER_ID;
  /** Explicit inactive -> active CAS. */
  expectedGeneration: 0;
  actorKeyId: string;
  atMs: number;
}

/**
 * Durable compensation work. The enqueue authorization is committed as hashes/monotonic
 * identities only; no request, session, turn, item, or approval body is copied into this row.
 */
interface LegacyTombstoneCompensationJobBase {
  jobId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cutoverGeneration: 1;
  legacyDeletedAtMs: number;
  status: LegacyTombstoneCompensationJobStatus;
  createdAtMs: number;
  updatedAtMs: number;
  availableAtMs?: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  lastErrorCode?: LegacyTombstoneRetryErrorCode;
  completedAtMs?: number;
  completedEventSeq?: number;
  completedClaimAttempt?: number;
  completedClaimTokenSha256?: string;
  terminalAtMs?: number;
  terminalReasonCode?: LegacyTombstoneTerminalReasonCode;
  terminalEvidenceSha256?: string;
}

export type LegacyTombstoneCompensationJobRecord = LegacyTombstoneCompensationJobBase & (
  | {
      sourceKind: "erasure_claim";
      sourceRequestId: string;
      sourceSubjectGeneration: number;
      sourceClaimAttempt: number;
      sourceClaimTokenSha256: string;
      maintenanceActorKeyId?: never;
    }
  | {
      sourceKind: "maintenance";
      maintenanceActorKeyId: string;
      sourceRequestId?: never;
      sourceSubjectGeneration?: never;
      sourceClaimAttempt?: never;
      sourceClaimTokenSha256?: never;
    }
);

export interface ScheduleLegacyTombstoneCompensationInput {
  jobId: string;
  sessionId: string;
  atMs: number;
  availableAtMs: number;
}

/** Trusted global sweep after the irreversible cutover; it cannot create work for live sessions. */
export interface ScheduleLegacyTombstoneCandidatesOptions {
  cutoverGeneration: 1;
  actorKeyId: string;
  nowMs: number;
  limit: number;
}

export interface ClaimLegacyTombstoneCompensationsOptions {
  nowMs: number;
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface LegacyTombstoneCompensationAuthorization {
  jobId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cutoverGeneration: 1;
  claimToken: string;
  claimAttempt: number;
}

/** Least-privilege worker projection. Source request and enqueue credentials are omitted. */
export interface LegacyTombstoneCompensationClaim
  extends LegacyTombstoneCompensationAuthorization {
  legacyDeletedAtMs: number;
  availableAtMs: number;
  attempts: number;
  leaseUntilMs: number;
}

export interface RenewLegacyTombstoneCompensationOptions {
  nowMs: number;
  leaseMs: number;
}

export interface RetryLegacyTombstoneCompensationOptions {
  failedAtMs: number;
  availableAtMs: number;
  errorCode: LegacyTombstoneRetryErrorCode;
}

export interface CompleteLegacyTombstoneCompensationOptions {
  completedAtMs: number;
}

export interface LegacyTombstoneCompensationSuccessAudit {
  auditId: number;
  jobId: string;
  type: "legacy_tombstone/compensated";
  sessionId: string;
  cutoverGeneration: 1;
  deletionGeneration: 1;
  eventSeq: number;
  claimAttempt: number;
  evidenceSha256: string;
  emittedAtMs: number;
}

export interface LegacyTombstoneCompensationTerminalIncident {
  auditId: number;
  /** Durable locator. It need not equal a corrupt row's embedded jobId. */
  jobId: string;
  type: "legacy_tombstone/terminal_incident";
  reasonCode: LegacyTombstoneTerminalReasonCode;
  evidenceSha256: string;
  emittedAtMs: number;
}

export type LegacyTombstoneCompensationAudit =
  | LegacyTombstoneCompensationSuccessAudit
  | LegacyTombstoneCompensationTerminalIncident;

/** Exact unsafe values are hashed but never copied into the durable incident audit. */
export interface LegacyTombstoneUnsafeJobEnvelope {
  locatorJobId: string;
  jobId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  sourceRequestId: string | null;
  sourceKind: string;
  rawSourceSubjectGeneration: string | null;
  rawSourceClaimAttempt: string | null;
  sourceClaimTokenSha256: string | null;
  maintenanceActorKeyId: string | null;
  rawCutoverGeneration: string;
  rawLegacyDeletedAtMs: string;
  status: string;
  rawCreatedAtMs: string;
  rawUpdatedAtMs: string;
  rawAvailableAtMs: string | null;
  rawAttempts: string;
  claimToken: string | null;
  rawLeaseUntilMs: string | null;
}

export type LegacyTombstoneCompensationResult =
  | {
      outcome: "compensated" | "already_compensated";
      sessionId: string;
      deletionGeneration: 1;
      eventSeq: number;
    }
  | {
      outcome: "terminal_incident";
      jobId: string;
      reasonCode: LegacyTombstoneTerminalReasonCode;
      evidenceSha256: string;
    };

export interface LegacyTombstoneCompensationStore {
  getLegacyTombstoneCutover(): Promise<LegacyTombstoneCutoverRecord | null>;
  activateLegacyTombstoneCutover(
    input: ActivateLegacyTombstoneCutoverInput,
  ): Promise<LegacyTombstoneCutoverRecord>;
  /** A live user-erasure claim is required to enqueue the owner-scoped historical session. */
  scheduleLegacyTombstoneCompensation(
    authorization: ErasureWriteAuthorization,
    input: ScheduleLegacyTombstoneCompensationInput,
  ): Promise<LegacyTombstoneCompensationJobRecord>;
  scheduleLegacyTombstoneCandidates(
    options: ScheduleLegacyTombstoneCandidatesOptions,
  ): Promise<LegacyTombstoneCompensationJobRecord[]>;
  getLegacyTombstoneCompensationJob(
    tenantId: string,
    userId: string,
    jobId: string,
  ): Promise<LegacyTombstoneCompensationJobRecord | null>;
  listLegacyTombstoneCompensationAudits(
    jobId: string,
  ): Promise<LegacyTombstoneCompensationAudit[]>;
  claimLegacyTombstoneCompensations(
    options: ClaimLegacyTombstoneCompensationsOptions,
  ): Promise<LegacyTombstoneCompensationClaim[]>;
  renewLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RenewLegacyTombstoneCompensationOptions,
  ): Promise<boolean>;
  retryLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: RetryLegacyTombstoneCompensationOptions,
  ): Promise<boolean>;
  completeLegacyTombstoneCompensation(
    authorization: LegacyTombstoneCompensationAuthorization,
    options: CompleteLegacyTombstoneCompensationOptions,
  ): Promise<LegacyTombstoneCompensationResult | null>;
}

export class LegacyTombstoneCutoverRequiredError extends Error {
  override readonly name = "LegacyTombstoneCutoverRequiredError";

  constructor() {
    super("legacy tombstone compensation cutover is not active");
  }
}

export class LegacyTombstoneCutoverConflictError extends Error {
  override readonly name = "LegacyTombstoneCutoverConflictError";

  constructor() {
    super("legacy tombstone compensation cutover is already active");
  }
}

export class LegacyTombstoneJobConflictError extends Error {
  override readonly name = "LegacyTombstoneJobConflictError";

  constructor() {
    super("legacy tombstone compensation job identity conflicts with durable state");
  }
}

export class LegacyTombstoneChildPendingError extends Error {
  override readonly name = "LegacyTombstoneChildPendingError";

  constructor(public readonly sessionId: string) {
    super(`legacy tombstone child remains unresolved for session ${sessionId}`);
  }
}

export class LegacyTombstoneIntegrityFault extends Error {
  override readonly name = "LegacyTombstoneIntegrityFault";

  constructor(public readonly reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">) {
    super(`legacy tombstone compensation integrity fault: ${reasonCode}`);
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function assertLegacyTombstoneJobId(jobId: string): void {
  if (!JOB_ID.test(jobId)) throw new Error("invalid legacy tombstone compensation job id");
}

export function assertLegacyTombstoneClaimToken(claimToken: string): void {
  if (!CLAIM_TOKEN.test(claimToken)) {
    throw new Error("legacy tombstone claimToken must contain 1 to 64 safe characters");
  }
}

export function legacyTombstoneClaimTokenSha256(claimToken: string): string {
  assertLegacyTombstoneClaimToken(claimToken);
  return createHash("sha256")
    .update(JSON.stringify(["legacy-tombstone-claim-token-v1", claimToken]))
    .digest("hex");
}

export function validateActivateLegacyTombstoneCutoverInput(
  input: ActivateLegacyTombstoneCutoverInput,
): void {
  if (input.cutoverId !== LEGACY_TOMBSTONE_CUTOVER_ID) {
    throw new Error("invalid legacy tombstone cutover id");
  }
  if (input.expectedGeneration !== 0) {
    throw new Error("legacy tombstone cutover must expect inactive generation 0");
  }
  if (!ACTOR_KEY_ID.test(input.actorKeyId)) throw new Error("invalid legacy tombstone cutover actor key id");
  assertTimestamp(input.atMs, "legacy tombstone cutover timestamp");
}

export function validateLegacyTombstoneCutoverRecord(
  record: LegacyTombstoneCutoverRecord,
): void {
  if (record.cutoverId !== LEGACY_TOMBSTONE_CUTOVER_ID || record.generation !== 1) {
    throw new Error("stored legacy tombstone cutover is invalid");
  }
  if (!ACTOR_KEY_ID.test(record.activatedByKeyId)) {
    throw new Error("stored legacy tombstone cutover actor is invalid");
  }
  assertTimestamp(record.activatedAtMs, "stored legacy tombstone cutover timestamp");
}

export function validateScheduleLegacyTombstoneCompensationInput(
  input: ScheduleLegacyTombstoneCompensationInput,
): void {
  assertLegacyTombstoneJobId(input.jobId);
  if (!isCanonicalId("sess", input.sessionId)) throw new Error("invalid legacy tombstone session id");
  assertTimestamp(input.atMs, "legacy tombstone schedule timestamp");
  assertTimestamp(input.availableAtMs, "legacy tombstone availability timestamp");
  if (input.availableAtMs < input.atMs) {
    throw new Error("legacy tombstone availability must not precede scheduling");
  }
}

export function validateScheduleLegacyTombstoneCandidatesOptions(
  options: ScheduleLegacyTombstoneCandidatesOptions,
): void {
  if (options.cutoverGeneration !== 1) {
    throw new Error("legacy tombstone candidate scheduling requires cutover generation 1");
  }
  if (!ACTOR_KEY_ID.test(options.actorKeyId)) {
    throw new Error("invalid legacy tombstone maintenance actor key id");
  }
  assertTimestamp(options.nowMs, "legacy tombstone candidate scheduling timestamp");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("legacy tombstone candidate scheduling limit must be between 1 and 100");
  }
}

export function validateLegacyTombstoneCompensationJobRecord(
  record: LegacyTombstoneCompensationJobRecord,
): void {
  assertLegacyTombstoneJobId(record.jobId);
  if (!record.tenantId || record.tenantId.length > 128) {
    throw new Error("stored legacy tombstone tenant id is invalid");
  }
  if (!record.userId || record.userId.length > 128) {
    throw new Error("stored legacy tombstone user id is invalid");
  }
  if (!isCanonicalId("sess", record.sessionId)) {
    throw new Error("stored legacy tombstone session id is invalid");
  }
  if (record.sourceKind === "erasure_claim") {
    if (!ERASURE_REQUEST_ID.test(record.sourceRequestId)) {
      throw new Error("stored legacy tombstone source request id is invalid");
    }
    assertPositiveSafeInteger(record.sourceSubjectGeneration, "stored source subject generation");
    assertPositiveSafeInteger(record.sourceClaimAttempt, "stored source claim attempt");
    if (!SHA256.test(record.sourceClaimTokenSha256)) {
      throw new Error("stored source claim token hash is invalid");
    }
    if (record.maintenanceActorKeyId !== undefined) {
      throw new Error("erasure-claim legacy tombstone source has maintenance identity");
    }
  } else if (record.sourceKind === "maintenance") {
    if (!ACTOR_KEY_ID.test(record.maintenanceActorKeyId)) {
      throw new Error("stored legacy tombstone maintenance actor is invalid");
    }
    if (
      record.sourceRequestId !== undefined
      || record.sourceSubjectGeneration !== undefined
      || record.sourceClaimAttempt !== undefined
      || record.sourceClaimTokenSha256 !== undefined
    ) throw new Error("maintenance legacy tombstone source has erasure claim identity");
  } else {
    throw new Error("stored legacy tombstone source kind is invalid");
  }
  if (record.cutoverGeneration !== 1) {
    throw new Error("stored legacy tombstone cutover generation is invalid");
  }
  assertTimestamp(record.legacyDeletedAtMs, "stored legacy deletion timestamp");
  assertTimestamp(record.createdAtMs, "stored legacy tombstone creation timestamp");
  assertTimestamp(record.updatedAtMs, "stored legacy tombstone update timestamp");
  if (record.createdAtMs < record.legacyDeletedAtMs || record.updatedAtMs < record.createdAtMs) {
    throw new Error("stored legacy tombstone timestamps are invalid");
  }
  if (!Number.isSafeInteger(record.attempts) || record.attempts < 0) {
    throw new Error("stored legacy tombstone attempts are invalid");
  }
  if (record.lastErrorCode !== undefined && !RETRY_ERROR_CODE_SET.has(record.lastErrorCode)) {
    throw new Error("stored legacy tombstone retry code is invalid");
  }
  if ((record.claimToken === undefined) !== (record.leaseUntilMs === undefined)) {
    throw new Error("stored legacy tombstone claim is incomplete");
  }
  if (record.claimToken !== undefined) {
    assertLegacyTombstoneClaimToken(record.claimToken);
    assertTimestamp(record.leaseUntilMs!, "stored legacy tombstone lease");
    if (record.attempts <= 0) throw new Error("stored legacy tombstone claim has no attempt");
  }

  if (record.status === "pending") {
    if (record.availableAtMs === undefined) {
      throw new Error("pending legacy tombstone job requires availability");
    }
    assertTimestamp(record.availableAtMs, "stored legacy tombstone availability");
    if (record.availableAtMs < record.createdAtMs) {
      throw new Error("stored legacy tombstone availability is invalid");
    }
    if (
      record.completedAtMs !== undefined
      || record.completedEventSeq !== undefined
      || record.completedClaimAttempt !== undefined
      || record.completedClaimTokenSha256 !== undefined
      || record.terminalAtMs !== undefined
      || record.terminalReasonCode !== undefined
      || record.terminalEvidenceSha256 !== undefined
    ) throw new Error("pending legacy tombstone job has terminal fields");
    return;
  }

  if (record.status === "completed") {
    if (
      record.availableAtMs !== undefined
      || record.claimToken !== undefined
      || record.leaseUntilMs !== undefined
      || record.lastErrorCode !== undefined
      || record.completedAtMs === undefined
      || record.completedEventSeq === undefined
      || record.completedClaimAttempt === undefined
      || record.completedClaimTokenSha256 === undefined
      || record.terminalAtMs !== undefined
      || record.terminalReasonCode !== undefined
      || record.terminalEvidenceSha256 !== undefined
    ) throw new Error("completed legacy tombstone job has invalid terminal fields");
    assertTimestamp(record.completedAtMs, "stored legacy tombstone completion timestamp");
    assertPositiveSafeInteger(record.completedEventSeq, "stored legacy tombstone event sequence");
    assertPositiveSafeInteger(record.completedClaimAttempt, "stored legacy tombstone completion attempt");
    if (!SHA256.test(record.completedClaimTokenSha256)) {
      throw new Error("stored legacy tombstone completion token hash is invalid");
    }
    return;
  }

  if (record.status === "terminal_incident") {
    if (
      record.availableAtMs !== undefined
      || record.claimToken !== undefined
      || record.leaseUntilMs !== undefined
      || record.lastErrorCode !== undefined
      || record.completedAtMs !== undefined
      || record.completedEventSeq !== undefined
      || record.completedClaimAttempt !== undefined
      || record.completedClaimTokenSha256 !== undefined
      || record.terminalAtMs === undefined
      || record.terminalReasonCode === undefined
      || record.terminalEvidenceSha256 === undefined
    ) throw new Error("terminal legacy tombstone job has invalid terminal fields");
    assertTimestamp(record.terminalAtMs, "stored legacy tombstone terminal timestamp");
    if (!TERMINAL_REASON_CODE_SET.has(record.terminalReasonCode)) {
      throw new Error("stored legacy tombstone terminal reason is invalid");
    }
    if (!SHA256.test(record.terminalEvidenceSha256)) {
      throw new Error("stored legacy tombstone terminal evidence is invalid");
    }
    return;
  }

  throw new Error("stored legacy tombstone status is invalid");
}

export function validateClaimLegacyTombstoneCompensationsOptions(
  options: ClaimLegacyTombstoneCompensationsOptions,
): number {
  assertTimestamp(options.nowMs, "legacy tombstone claim timestamp");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) {
    throw new Error("legacy tombstone claim limit must be between 1 and 100");
  }
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("legacy tombstone leaseMs must be a positive safe integer");
  }
  assertLegacyTombstoneClaimToken(options.claimToken);
  const leaseUntilMs = options.nowMs + options.leaseMs;
  assertTimestamp(leaseUntilMs, "legacy tombstone lease deadline");
  return leaseUntilMs;
}

export function validateLegacyTombstoneCompensationAuthorization(
  authorization: LegacyTombstoneCompensationAuthorization,
): void {
  assertLegacyTombstoneJobId(authorization.jobId);
  if (!authorization.tenantId || authorization.tenantId.length > 128) {
    throw new Error("invalid legacy tombstone authorization tenant id");
  }
  if (!authorization.userId || authorization.userId.length > 128) {
    throw new Error("invalid legacy tombstone authorization user id");
  }
  if (!isCanonicalId("sess", authorization.sessionId)) {
    throw new Error("invalid legacy tombstone authorization session id");
  }
  if (authorization.cutoverGeneration !== 1) {
    throw new Error("invalid legacy tombstone authorization cutover generation");
  }
  assertLegacyTombstoneClaimToken(authorization.claimToken);
  assertPositiveSafeInteger(authorization.claimAttempt, "legacy tombstone claimAttempt");
}

export function legacyTombstoneCompensationAuthorizationMatches(
  record: LegacyTombstoneCompensationJobRecord,
  authorization: LegacyTombstoneCompensationAuthorization,
  nowMs: number,
): boolean {
  validateLegacyTombstoneCompensationJobRecord(record);
  validateLegacyTombstoneCompensationAuthorization(authorization);
  assertTimestamp(nowMs, "legacy tombstone authorization timestamp");
  return record.status === "pending"
    && record.jobId === authorization.jobId
    && record.tenantId === authorization.tenantId
    && record.userId === authorization.userId
    && record.sessionId === authorization.sessionId
    && record.cutoverGeneration === authorization.cutoverGeneration
    && record.claimToken === authorization.claimToken
    && record.attempts === authorization.claimAttempt
    && record.leaseUntilMs !== undefined
    && record.leaseUntilMs > nowMs;
}

export function validateRenewLegacyTombstoneCompensationOptions(
  options: RenewLegacyTombstoneCompensationOptions,
): number {
  assertTimestamp(options.nowMs, "legacy tombstone renewal timestamp");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("legacy tombstone renewal leaseMs must be a positive safe integer");
  }
  const leaseUntilMs = options.nowMs + options.leaseMs;
  assertTimestamp(leaseUntilMs, "legacy tombstone renewed lease deadline");
  return leaseUntilMs;
}

export function validateRetryLegacyTombstoneCompensationOptions(
  options: RetryLegacyTombstoneCompensationOptions,
): void {
  assertTimestamp(options.failedAtMs, "legacy tombstone failure timestamp");
  assertTimestamp(options.availableAtMs, "legacy tombstone retry availability");
  if (options.availableAtMs < options.failedAtMs) {
    throw new Error("legacy tombstone retry availability must not precede failure");
  }
  if (!RETRY_ERROR_CODE_SET.has(options.errorCode)) {
    throw new Error("unsupported legacy tombstone retry error code");
  }
}

export function validateCompleteLegacyTombstoneCompensationOptions(
  options: CompleteLegacyTombstoneCompensationOptions,
): void {
  assertTimestamp(options.completedAtMs, "legacy tombstone completion timestamp");
}

export function legacyTombstoneCompensationClaimFromRecord(
  record: LegacyTombstoneCompensationJobRecord,
): LegacyTombstoneCompensationClaim {
  validateLegacyTombstoneCompensationJobRecord(record);
  if (
    record.status !== "pending"
    || record.availableAtMs === undefined
    || record.claimToken === undefined
    || record.leaseUntilMs === undefined
  ) throw new Error("legacy tombstone job is not an active worker claim");
  return {
    jobId: record.jobId,
    tenantId: record.tenantId,
    userId: record.userId,
    sessionId: record.sessionId,
    cutoverGeneration: record.cutoverGeneration,
    legacyDeletedAtMs: record.legacyDeletedAtMs,
    availableAtMs: record.availableAtMs,
    attempts: record.attempts,
    claimToken: record.claimToken,
    claimAttempt: record.attempts,
    leaseUntilMs: record.leaseUntilMs,
  };
}

export function legacyTombstoneUnsafeJobEnvelopeEvidenceSha256(
  input: LegacyTombstoneUnsafeJobEnvelope,
): string {
  return createHash("sha256").update(JSON.stringify([
    "legacy-tombstone-unsafe-job-envelope-v1",
    input.locatorJobId,
    input.jobId,
    input.tenantId,
    input.userId,
    input.sessionId,
    input.sourceRequestId,
    input.sourceKind,
    input.rawSourceSubjectGeneration,
    input.rawSourceClaimAttempt,
    input.sourceClaimTokenSha256,
    input.maintenanceActorKeyId,
    input.rawCutoverGeneration,
    input.rawLegacyDeletedAtMs,
    input.status,
    input.rawCreatedAtMs,
    input.rawUpdatedAtMs,
    input.rawAvailableAtMs,
    input.rawAttempts,
    input.claimToken,
    input.rawLeaseUntilMs,
    "unsafe_job_envelope",
  ])).digest("hex");
}

export function legacyTombstoneTerminalIncidentEvidenceSha256(input: {
  jobId: string;
  sessionId: string;
  cutoverGeneration: 1;
  legacyDeletedAtMs: number;
  claimAttempt: number;
  reasonCode: Exclude<LegacyTombstoneTerminalReasonCode, "unsafe_job_envelope">;
}): string {
  assertLegacyTombstoneJobId(input.jobId);
  if (!isCanonicalId("sess", input.sessionId)) throw new Error("invalid legacy tombstone session id");
  assertTimestamp(input.legacyDeletedAtMs, "legacy deletion timestamp");
  assertPositiveSafeInteger(input.claimAttempt, "legacy tombstone claim attempt");
  if (input.cutoverGeneration !== 1 || !TERMINAL_REASON_CODE_SET.has(input.reasonCode)) {
    throw new Error("invalid legacy tombstone terminal evidence");
  }
  return createHash("sha256").update(JSON.stringify([
    "legacy-tombstone-terminal-incident-v1",
    input.jobId,
    input.sessionId,
    input.cutoverGeneration,
    input.legacyDeletedAtMs,
    input.claimAttempt,
    input.reasonCode,
  ])).digest("hex");
}

export function legacyTombstoneSuccessEvidenceSha256(input: {
  jobId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  cutoverGeneration: 1;
  legacyDeletedAtMs: number;
  deletionGeneration: 1;
  eventSeq: number;
  claimAttempt: number;
  emittedAtMs: number;
}): string {
  assertLegacyTombstoneJobId(input.jobId);
  if (
    !input.tenantId
    || input.tenantId.length > 128
    || !input.userId
    || input.userId.length > 128
  ) {
    throw new Error("invalid legacy tombstone success owner");
  }
  if (!isCanonicalId("sess", input.sessionId)) throw new Error("invalid legacy tombstone success session");
  if (input.cutoverGeneration !== 1 || input.deletionGeneration !== 1) {
    throw new Error("invalid legacy tombstone success generation");
  }
  assertTimestamp(input.legacyDeletedAtMs, "legacy tombstone success deletion timestamp");
  assertPositiveSafeInteger(input.eventSeq, "legacy tombstone success event sequence");
  assertPositiveSafeInteger(input.claimAttempt, "legacy tombstone success claim attempt");
  assertTimestamp(input.emittedAtMs, "legacy tombstone success audit timestamp");
  return createHash("sha256").update(JSON.stringify([
    "legacy-tombstone-compensation-success-v1",
    input.jobId,
    input.tenantId,
    input.userId,
    input.sessionId,
    input.cutoverGeneration,
    input.legacyDeletedAtMs,
    input.deletionGeneration,
    input.eventSeq,
    input.claimAttempt,
    input.emittedAtMs,
  ])).digest("hex");
}

export function validateLegacyTombstoneCompensationAudit(
  audit: LegacyTombstoneCompensationAudit,
): void {
  assertPositiveSafeInteger(audit.auditId, "legacy tombstone audit id");
  // A terminal incident may use a non-canonical durable locator for an unsafe embedded identity.
  if (!audit.jobId || audit.jobId.length > 128) throw new Error("invalid legacy tombstone audit locator");
  if (!SHA256.test(audit.evidenceSha256)) throw new Error("invalid legacy tombstone audit evidence");
  assertTimestamp(audit.emittedAtMs, "legacy tombstone audit timestamp");
  if (audit.type === "legacy_tombstone/terminal_incident") {
    if (!TERMINAL_REASON_CODE_SET.has(audit.reasonCode)) {
      throw new Error("invalid legacy tombstone terminal audit reason");
    }
    return;
  }
  assertLegacyTombstoneJobId(audit.jobId);
  if (!isCanonicalId("sess", audit.sessionId)) throw new Error("invalid legacy tombstone audit session");
  if (audit.cutoverGeneration !== 1 || audit.deletionGeneration !== 1) {
    throw new Error("invalid legacy tombstone audit generation");
  }
  assertPositiveSafeInteger(audit.eventSeq, "legacy tombstone audit event sequence");
  assertPositiveSafeInteger(audit.claimAttempt, "legacy tombstone audit claim attempt");
}

export function newLegacyTombstoneCompensationJobId(): string {
  return `ltc_${randomUUID()}`;
}

/** Stable per-session identity lets maintenance scheduling replay without duplicate work. */
export function legacyTombstoneCompensationJobIdForSession(sessionId: string): string {
  if (!isCanonicalId("sess", sessionId)) throw new Error("invalid legacy tombstone session id");
  const hex = createHash("sha256")
    .update(JSON.stringify(["legacy-tombstone-compensation-job-v1", sessionId]))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = (["8", "9", "a", "b"] as const)[Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join("");
  return `ltc_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
