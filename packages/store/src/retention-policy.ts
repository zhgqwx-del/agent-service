import { createHash, randomUUID } from "node:crypto";
import { UserId } from "@agent-service/protocol";
import type { DataSubjectKind } from "./subject-lifecycle.js";

export const RETENTION_POLICY_SCHEMA_VERSION = 1 as const;

export const RETENTION_POLICY_DURATION_FIELDS = [
  "sessionContentRetentionMs",
  "userErasureGraceMs",
  "operationalUsageRetentionMs",
  "idempotencyReceiptRetentionMs",
  "billingFactRetentionMs",
  "lifecycleAuditRetentionMs",
  "exportArtifactTtlMs",
] as const;

export type RetentionPolicyDurationField = (typeof RETENTION_POLICY_DURATION_FIELDS)[number];

/** `null` is the fail-closed value: this policy does not authorize expiry for that data class. */
export type RetentionPolicyDocumentV1 = Readonly<Record<RetentionPolicyDurationField, number | null>>;

export interface RetentionPolicyVersionRecord {
  tenantId: string;
  policyVersion: string;
  schemaVersion: typeof RETENTION_POLICY_SCHEMA_VERSION;
  policy: RetentionPolicyDocumentV1;
  policySha256: string;
  createdByKeyId: string;
  createdAtMs: number;
}

export interface RetentionPolicyControlRecord {
  tenantId: string;
  controlGeneration: number;
  activePolicyVersion?: string;
  activePolicySha256?: string;
  effectiveAtMs?: number;
  updatedAtMs: number;
}

export interface RetentionPolicyActivationEvent {
  eventId: number;
  tenantId: string;
  controlGeneration: number;
  policyVersion: string;
  policySha256: string;
  effectiveAtMs: number;
  actorKeyId: string;
  beforeSha256: string;
  afterSha256: string;
  emittedAtMs: number;
}

export interface PutRetentionPolicyInput {
  tenantId: string;
  policyVersion: string;
  policy: RetentionPolicyDocumentV1;
  actorKeyId: string;
  atMs: number;
}

export interface ActivateRetentionPolicyInput {
  tenantId: string;
  policyVersion: string;
  expectedControlGeneration: number;
  actorKeyId: string;
  atMs: number;
}

export interface ActiveRetentionPolicy {
  control: RetentionPolicyControlRecord;
  policy: RetentionPolicyVersionRecord;
}

export const LEGAL_HOLD_REASON_CODES = [
  "litigation",
  "regulatory",
  "security_incident",
  "billing_dispute",
  "legacy_unattributed",
] as const;
export type LegalHoldReasonCode = (typeof LEGAL_HOLD_REASON_CODES)[number];

export const LEGAL_HOLD_RELEASE_REASON_CODES = [
  "matter_closed",
  "issued_in_error",
  "superseded",
] as const;
export type LegalHoldReleaseReasonCode = (typeof LEGAL_HOLD_RELEASE_REASON_CODES)[number];

export interface LegalHoldControlRecord {
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  controlGeneration: number;
  activeHoldCount: number;
  activeProjectionSha256: string;
  updatedAtMs: number;
}

export interface LegalHoldRecord {
  tenantId: string;
  holdId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  state: "active" | "released";
  reasonCode: LegalHoldReasonCode;
  externalReferenceSha256?: string;
  createdControlGeneration: number;
  createdByKeyId: string;
  createdAtMs: number;
  releasedControlGeneration?: number;
  releasedByKeyId?: string;
  releasedAtMs?: number;
  releaseReasonCode?: LegalHoldReleaseReasonCode;
}

export interface LegalHoldEvent {
  eventId: number;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  controlGeneration: number;
  holdId: string;
  eventType: "legal_hold/set" | "legal_hold/released";
  reasonCode: LegalHoldReasonCode | LegalHoldReleaseReasonCode;
  externalReferenceSha256?: string;
  actorKeyId: string;
  beforeSha256: string;
  afterSha256: string;
  emittedAtMs: number;
}

export interface SetLegalHoldInput {
  tenantId: string;
  holdId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  reasonCode: LegalHoldReasonCode;
  externalReferenceSha256?: string;
  expectedControlGeneration: number;
  actorKeyId: string;
  atMs: number;
}

export interface ReleaseLegalHoldInput {
  tenantId: string;
  holdId: string;
  expectedControlGeneration: number;
  reasonCode: LegalHoldReleaseReasonCode;
  actorKeyId: string;
  atMs: number;
}

/**
 * Policy/hold management is intentionally separate from SessionStore and from the future purge
 * capability. Nothing on this interface can delete, anonymize, enqueue purge, or complete an
 * erasure request.
 */
export interface RetentionPolicyStore {
  putRetentionPolicy(input: PutRetentionPolicyInput): Promise<RetentionPolicyVersionRecord>;
  activateRetentionPolicy(input: ActivateRetentionPolicyInput): Promise<RetentionPolicyControlRecord>;
  getRetentionPolicy(tenantId: string, policyVersion: string): Promise<RetentionPolicyVersionRecord | null>;
  getActiveRetentionPolicy(tenantId: string): Promise<ActiveRetentionPolicy | null>;
  listRetentionPolicyActivationEvents(tenantId: string): Promise<RetentionPolicyActivationEvent[]>;
  setLegalHold(input: SetLegalHoldInput): Promise<LegalHoldRecord>;
  releaseLegalHold(input: ReleaseLegalHoldInput): Promise<LegalHoldRecord>;
  getLegalHold(tenantId: string, holdId: string): Promise<LegalHoldRecord | null>;
  getLegalHoldControl(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldControlRecord>;
  /** One consistent, integrity-checked snapshot for management and future policy evaluation. */
  getActiveLegalHoldState(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<{ control: LegalHoldControlRecord; holds: LegalHoldRecord[] }>;
  listActiveLegalHolds(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldRecord[]>;
  listLegalHoldEvents(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<LegalHoldEvent[]>;
}

export class RetentionPolicyVersionConflictError extends Error {
  constructor(public readonly policyVersion: string) {
    super(`retention policy version ${policyVersion} already has different immutable content`);
    this.name = "RetentionPolicyVersionConflictError";
  }
}

export class RetentionPolicyNotFoundError extends Error {
  constructor(public readonly policyVersion: string) {
    super(`retention policy version ${policyVersion} was not found`);
    this.name = "RetentionPolicyNotFoundError";
  }
}

export class RetentionPolicyGenerationConflictError extends Error {
  constructor(public readonly expectedGeneration: number, public readonly actualGeneration: number) {
    super(`retention policy generation ${actualGeneration} does not match expected ${expectedGeneration}`);
    this.name = "RetentionPolicyGenerationConflictError";
  }
}

export class LegalHoldConflictError extends Error {
  constructor(public readonly holdId: string) {
    super(`legal hold ${holdId} already has different immutable content or release evidence`);
    this.name = "LegalHoldConflictError";
  }
}

export class LegalHoldNotFoundError extends Error {
  constructor(public readonly holdId: string) {
    super(`legal hold ${holdId} was not found`);
    this.name = "LegalHoldNotFoundError";
  }
}

export class LegalHoldGenerationConflictError extends Error {
  constructor(public readonly expectedGeneration: number, public readonly actualGeneration: number) {
    super(`legal hold generation ${actualGeneration} does not match expected ${expectedGeneration}`);
    this.name = "LegalHoldGenerationConflictError";
  }
}

export class LegalHoldIntegrityError extends Error {
  constructor(message = "legal hold ledger and lifecycle projection do not agree") {
    super(message);
    this.name = "LegalHoldIntegrityError";
  }
}

const POLICY_VERSION = /^(?!active$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOLD_ID = /^hold_[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTOR_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SAFE_DURATION_MS = Number.MAX_SAFE_INTEGER;

function assertTenantId(tenantId: string): void {
  if (!tenantId || tenantId.length > 128) throw new Error("invalid retention tenant id");
}

function assertActorKeyId(actorKeyId: string): void {
  if (!ACTOR_KEY_ID.test(actorKeyId)) throw new Error("invalid retention actor key id");
}

function assertTimestamp(atMs: number, label: string): void {
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error(`invalid ${label}`);
}

function assertGeneration(generation: number, label: string): void {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`invalid ${label}`);
  }
}

export function validateRetentionPolicyDocument(policy: RetentionPolicyDocumentV1): void {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("invalid retention policy document");
  }
  const keys = Object.keys(policy).sort();
  const expected = [...RETENTION_POLICY_DURATION_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("retention policy document has unknown or missing fields");
  }
  for (const field of RETENTION_POLICY_DURATION_FIELDS) {
    const value = policy[field];
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_DURATION_MS)) {
      throw new Error(`invalid retention policy duration ${field}`);
    }
  }
}

export function retentionPolicySha256(
  tenantId: string,
  policyVersion: string,
  policy: RetentionPolicyDocumentV1,
): string {
  validateRetentionPolicyIdentity(tenantId, policyVersion);
  validateRetentionPolicyDocument(policy);
  return createHash("sha256").update(JSON.stringify([
    "agent-service/retention-policy/v1",
    tenantId,
    policyVersion,
    RETENTION_POLICY_SCHEMA_VERSION,
    ...RETENTION_POLICY_DURATION_FIELDS.map((field) => policy[field]),
  ])).digest("hex");
}

export function retentionPolicyControlSha256(control: RetentionPolicyControlRecord): string {
  validateRetentionPolicyControlRecord(control);
  return createHash("sha256").update(JSON.stringify([
    "agent-service/retention-policy-control/v1",
    control.tenantId,
    control.controlGeneration,
    control.activePolicyVersion ?? null,
    control.activePolicySha256 ?? null,
    control.effectiveAtMs ?? null,
    control.updatedAtMs,
  ])).digest("hex");
}

/** Byte/code-unit order, independent of the process locale and ICU version. */
export function compareLegalHoldIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function legalHoldProjectionSha256(holds: readonly LegalHoldRecord[]): string {
  const active = holds.filter((hold) => hold.state === "active");
  for (const hold of active) validateLegalHoldRecord(hold);
  const tuples = active
    .map((hold) => [
      hold.tenantId,
      hold.subjectKind,
      hold.subjectId,
      hold.holdId,
      hold.reasonCode,
      hold.externalReferenceSha256 ?? null,
      hold.createdControlGeneration,
      hold.createdAtMs,
    ])
    .sort((left, right) => compareLegalHoldIds(String(left[3]), String(right[3])));
  return createHash("sha256").update(JSON.stringify([
    "agent-service/legal-hold-active-projection/v1",
    ...tuples,
  ])).digest("hex");
}

export function legalHoldControlSha256(control: LegalHoldControlRecord): string {
  validateLegalHoldControlRecord(control);
  return createHash("sha256").update(JSON.stringify([
    "agent-service/legal-hold-control/v1",
    control.tenantId,
    control.subjectKind,
    control.subjectId,
    control.controlGeneration,
    control.activeHoldCount,
    control.activeProjectionSha256,
    control.updatedAtMs,
  ])).digest("hex");
}

export function newLegalHoldId(): string {
  return `hold_${randomUUID()}`;
}

export function validateRetentionPolicyIdentity(tenantId: string, policyVersion: string): void {
  validateRetentionPolicyTenantId(tenantId);
  if (!POLICY_VERSION.test(policyVersion)) throw new Error("invalid retention policy version");
}

export function validateRetentionPolicyTenantId(tenantId: string): void {
  assertTenantId(tenantId);
}

export function validatePutRetentionPolicyInput(input: PutRetentionPolicyInput): void {
  validateRetentionPolicyIdentity(input.tenantId, input.policyVersion);
  validateRetentionPolicyDocument(input.policy);
  assertActorKeyId(input.actorKeyId);
  assertTimestamp(input.atMs, "retention policy creation timestamp");
}

export function validateActivateRetentionPolicyInput(input: ActivateRetentionPolicyInput): void {
  validateRetentionPolicyIdentity(input.tenantId, input.policyVersion);
  assertGeneration(input.expectedControlGeneration, "retention policy expected generation");
  assertActorKeyId(input.actorKeyId);
  assertTimestamp(input.atMs, "retention policy activation timestamp");
}

export function validateRetentionPolicyVersionRecord(record: RetentionPolicyVersionRecord): void {
  validateRetentionPolicyIdentity(record.tenantId, record.policyVersion);
  if (record.schemaVersion !== RETENTION_POLICY_SCHEMA_VERSION) {
    throw new Error("unsupported retention policy schema version");
  }
  validateRetentionPolicyDocument(record.policy);
  if (record.policySha256 !== retentionPolicySha256(record.tenantId, record.policyVersion, record.policy)) {
    throw new Error("stored retention policy hash is invalid");
  }
  assertActorKeyId(record.createdByKeyId);
  assertTimestamp(record.createdAtMs, "stored retention policy creation timestamp");
}

export function validateRetentionPolicyControlRecord(record: RetentionPolicyControlRecord): void {
  assertTenantId(record.tenantId);
  assertGeneration(record.controlGeneration, "stored retention policy generation");
  assertTimestamp(record.updatedAtMs, "stored retention policy update timestamp");
  const markers = [record.activePolicyVersion, record.activePolicySha256, record.effectiveAtMs]
    .filter((value) => value !== undefined).length;
  if (markers !== 0 && markers !== 3) throw new Error("stored active retention policy is incomplete");
  if (record.controlGeneration === 0) {
    if (markers !== 0) throw new Error("inactive retention policy control has active markers");
  } else {
    if (markers !== 3) throw new Error("active retention policy control is missing markers");
    validateRetentionPolicyIdentity(record.tenantId, record.activePolicyVersion!);
    if (!SHA256.test(record.activePolicySha256!)) throw new Error("stored active retention policy hash is invalid");
    assertTimestamp(record.effectiveAtMs!, "stored retention policy effective timestamp");
    if (record.updatedAtMs < record.effectiveAtMs!) {
      throw new Error("retention policy control predates its effective timestamp");
    }
  }
}

function validateLegalHoldSubject(
  tenantId: string,
  subjectKind: DataSubjectKind,
  subjectId: string,
): void {
  assertTenantId(tenantId);
  if (subjectKind === "tenant") {
    if (subjectId !== tenantId) throw new Error("tenant legal hold subject must equal tenant id");
  } else if (subjectKind === "user") {
    if (!UserId.safeParse(subjectId).success) throw new Error("invalid legal hold user id");
  } else {
    throw new Error("invalid legal hold subject kind");
  }
}

export function validateSetLegalHoldInput(input: SetLegalHoldInput): void {
  validateLegalHoldSubject(input.tenantId, input.subjectKind, input.subjectId);
  if (!HOLD_ID.test(input.holdId)) throw new Error("invalid legal hold id");
  if (!LEGAL_HOLD_REASON_CODES.includes(input.reasonCode)) throw new Error("invalid legal hold reason code");
  if (input.reasonCode === "legacy_unattributed") {
    throw new Error("legacy_unattributed legal holds can only be created by migration");
  }
  if (input.externalReferenceSha256 !== undefined && !SHA256.test(input.externalReferenceSha256)) {
    throw new Error("invalid legal hold external reference hash");
  }
  assertGeneration(input.expectedControlGeneration, "legal hold expected generation");
  assertActorKeyId(input.actorKeyId);
  assertTimestamp(input.atMs, "legal hold creation timestamp");
}

export function validateReleaseLegalHoldInput(input: ReleaseLegalHoldInput): void {
  assertTenantId(input.tenantId);
  if (!HOLD_ID.test(input.holdId)) throw new Error("invalid legal hold id");
  if (!LEGAL_HOLD_RELEASE_REASON_CODES.includes(input.reasonCode)) {
    throw new Error("invalid legal hold release reason code");
  }
  assertGeneration(input.expectedControlGeneration, "legal hold expected generation");
  assertActorKeyId(input.actorKeyId);
  assertTimestamp(input.atMs, "legal hold release timestamp");
}

export function validateLegalHoldRecord(record: LegalHoldRecord): void {
  validateLegalHoldSubject(record.tenantId, record.subjectKind, record.subjectId);
  if (!HOLD_ID.test(record.holdId)) throw new Error("stored legal hold id is invalid");
  if (!LEGAL_HOLD_REASON_CODES.includes(record.reasonCode)) throw new Error("stored legal hold reason is invalid");
  if (record.externalReferenceSha256 !== undefined && !SHA256.test(record.externalReferenceSha256)) {
    throw new Error("stored legal hold external reference is invalid");
  }
  if (!Number.isSafeInteger(record.createdControlGeneration) || record.createdControlGeneration <= 0) {
    throw new Error("stored legal hold creation generation is invalid");
  }
  assertActorKeyId(record.createdByKeyId);
  assertTimestamp(record.createdAtMs, "stored legal hold creation timestamp");
  const released = record.state === "released";
  const releaseMarkers = [
    record.releasedControlGeneration,
    record.releasedByKeyId,
    record.releasedAtMs,
    record.releaseReasonCode,
  ].filter((value) => value !== undefined).length;
  if (record.state !== "active" && !released) throw new Error("stored legal hold state is invalid");
  if (!released && releaseMarkers !== 0) throw new Error("active legal hold has release evidence");
  if (released) {
    if (releaseMarkers !== 4) throw new Error("released legal hold evidence is incomplete");
    if (
      !Number.isSafeInteger(record.releasedControlGeneration)
      || record.releasedControlGeneration! <= record.createdControlGeneration
    ) throw new Error("stored legal hold release generation is invalid");
    assertActorKeyId(record.releasedByKeyId!);
    assertTimestamp(record.releasedAtMs!, "stored legal hold release timestamp");
    if (record.releasedAtMs! < record.createdAtMs) throw new Error("legal hold release predates creation");
    if (!LEGAL_HOLD_RELEASE_REASON_CODES.includes(record.releaseReasonCode!)) {
      throw new Error("stored legal hold release reason is invalid");
    }
  }
}

export function validateLegalHoldControlRecord(record: LegalHoldControlRecord): void {
  validateLegalHoldSubject(record.tenantId, record.subjectKind, record.subjectId);
  assertGeneration(record.controlGeneration, "stored legal hold generation");
  if (!Number.isSafeInteger(record.activeHoldCount) || record.activeHoldCount < 0) {
    throw new Error("stored legal hold active count is invalid");
  }
  if (!SHA256.test(record.activeProjectionSha256)) {
    throw new Error("stored legal hold projection hash is invalid");
  }
  assertTimestamp(record.updatedAtMs, "stored legal hold update timestamp");
  if (record.controlGeneration === 0 && record.activeHoldCount !== 0) {
    throw new Error("initial legal hold control cannot contain active holds");
  }
}
