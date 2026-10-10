import { createHash } from "node:crypto";
import {
  TENANT_CREDENTIAL_TARGET_DOMAINS,
  type TenantCredentialTargetDomain,
} from "./credential-lifecycle.js";

export const TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE =
  "tenant-credential-target-execution-target-v1" as const;
export const TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ACK_SCOPE =
  "tenant-credential-target-execution-target-ack-v1" as const;
export const TENANT_CREDENTIAL_TARGET_EXECUTION_RECEIPT_SCOPE =
  "tenant-credential-target-execution-v1" as const;
export const TENANT_CREDENTIAL_TARGET_EXECUTION_PROTOCOL =
  "tenant-credential-target-execution-v1" as const;
export const TENANT_CREDENTIAL_TARGET_EXECUTION_CUTOVER_SINGLETON_ID = 1 as const;

/**
 * The domain catalog is intentionally wider than the currently executable set. KMS destruction
 * needs a separate, provider-specific authority and must not be inferred from this contract.
 */
export const TENANT_CREDENTIAL_TARGET_EXECUTION_DOMAINS =
  TENANT_CREDENTIAL_TARGET_DOMAINS;
export const TENANT_CREDENTIAL_TARGET_EXECUTABLE_DOMAINS = [
  "external_credential",
] as const satisfies readonly TenantCredentialTargetDomain[];
export type TenantCredentialTargetExecutableDomain =
  (typeof TENANT_CREDENTIAL_TARGET_EXECUTABLE_DOMAINS)[number];

export const TENANT_CREDENTIAL_TARGET_EXECUTION_OUTCOMES = [
  "revoked",
  "already_absent",
] as const;
export type TenantCredentialTargetExecutionOutcome =
  (typeof TENANT_CREDENTIAL_TARGET_EXECUTION_OUTCOMES)[number];

export type TenantCredentialTargetExecutionJobPhase =
  | "queued"
  | "external_credential_sealed"
  | "blocked";
export type TenantCredentialTargetExecutionRetryErrorCode =
  | "temporary_failure"
  | "dependency_pending";
export type TenantCredentialTargetExecutionBlockReasonCode =
  | "source_blocked"
  | "integrity_conflict";

const REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bytesSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function digest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function identifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} is invalid`);
}

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function count(value: number, name: string): void {
  timestamp(value, name);
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function tenantId(value: string): void {
  if (!value || value.length > 128) {
    throw new Error("invalid tenant credential target execution tenant id");
  }
}

function claimToken(value: string): void {
  if (!CLAIM_TOKEN.test(value)) {
    throw new Error("invalid tenant credential target execution claim token");
  }
}

function executableDomain(
  value: TenantCredentialTargetDomain,
): asserts value is TenantCredentialTargetExecutableDomain {
  if (value !== "external_credential") {
    throw new Error("KMS target execution is reserved but is not executable by this contract");
  }
}

export interface TenantCredentialTargetExecutionIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  targetExecutionGeneration: number;
}

export interface TenantCredentialTargetExecutionSource
  extends TenantCredentialTargetExecutionIdentity {
  t3aReceiptSha256: string;
  inventoryReceiptSha256: string;
  trackingCutoverEvidenceSha256: string;
  versionCount: number;
  versionRootSha256: string;
  targetDispositionCount: number;
  targetDispositionRootSha256: string;
  externalCredentialTargetCount: number;
  externalCredentialTargetRootSha256: string;
  externalCredentialBlockerCount: number;
  kmsKeyBlockerCount: number;
  kmsKeyExecutableTargetCount: 0;
  sourceEvidenceDbMs: number;
}

const IDENTITY_KEYS = [
  "requestId",
  "tenantId",
  "subjectGeneration",
  "targetExecutionGeneration",
] as const;

const SOURCE_KEYS = [
  ...IDENTITY_KEYS,
  "t3aReceiptSha256",
  "inventoryReceiptSha256",
  "trackingCutoverEvidenceSha256",
  "versionCount",
  "versionRootSha256",
  "targetDispositionCount",
  "targetDispositionRootSha256",
  "externalCredentialTargetCount",
  "externalCredentialTargetRootSha256",
  "externalCredentialBlockerCount",
  "kmsKeyBlockerCount",
  "kmsKeyExecutableTargetCount",
  "sourceEvidenceDbMs",
] as const;

export function validateTenantCredentialTargetExecutionIdentity(
  identity: TenantCredentialTargetExecutionIdentity,
): void {
  if (!REQUEST_ID.test(identity.requestId)) {
    throw new Error("invalid tenant credential target execution request id");
  }
  tenantId(identity.tenantId);
  positive(identity.subjectGeneration, "tenant credential target execution subject generation");
  positive(
    identity.targetExecutionGeneration,
    "tenant credential target execution generation",
  );
}

export function validateTenantCredentialTargetExecutionSource(
  source: TenantCredentialTargetExecutionSource,
): void {
  validateTenantCredentialTargetExecutionIdentity(source);
  for (const [value, name] of [
    [source.t3aReceiptSha256, "T3a receipt"],
    [source.inventoryReceiptSha256, "inventory receipt"],
    [source.trackingCutoverEvidenceSha256, "tracking cutover evidence"],
    [source.versionRootSha256, "version root"],
    [source.targetDispositionRootSha256, "target disposition root"],
    [source.externalCredentialTargetRootSha256, "external target root"],
  ] as const) digest(value, `tenant credential target execution ${name}`);
  for (const [value, name] of [
    [source.versionCount, "version count"],
    [source.targetDispositionCount, "target disposition count"],
    [source.externalCredentialTargetCount, "external target count"],
    [source.externalCredentialBlockerCount, "external blocker count"],
    [source.kmsKeyBlockerCount, "KMS blocker count"],
  ] as const) count(value, `tenant credential target execution ${name}`);
  if (!Number.isSafeInteger(source.versionCount * 2)
    || source.targetDispositionCount !== source.versionCount * 2) {
    throw new Error("tenant credential target execution source lacks two dispositions per version");
  }
  if (source.externalCredentialTargetCount + source.externalCredentialBlockerCount
      > source.versionCount
    || source.kmsKeyBlockerCount > source.versionCount) {
    throw new Error("tenant credential target execution source counts exceed the version catalog");
  }
  if (source.kmsKeyExecutableTargetCount !== 0) {
    throw new Error("KMS target execution is not enabled by this contract");
  }
  timestamp(source.sourceEvidenceDbMs, "tenant credential target execution source time");
}

function sameIdentity(
  left: TenantCredentialTargetExecutionIdentity,
  right: TenantCredentialTargetExecutionIdentity,
): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export interface TenantCredentialTargetExecutionOperationInput {
  identity: TenantCredentialTargetExecutionIdentity;
  credentialVersionId: string;
  domain: TenantCredentialTargetExecutableDomain;
  targetDispositionEvidenceSha256: string;
  adapterProtocol: string;
  targetReferenceCipherSha256: string;
  targetReferenceKeyId: string;
  targetReferenceSha256: string;
}

export function tenantCredentialTargetExecutionOperationIdSha256(
  input: TenantCredentialTargetExecutionOperationInput,
): string {
  exactKeys(input, [
    "identity",
    "credentialVersionId",
    "domain",
    "targetDispositionEvidenceSha256",
    "adapterProtocol",
    "targetReferenceCipherSha256",
    "targetReferenceKeyId",
    "targetReferenceSha256",
  ], "tenant credential target execution operation");
  validateTenantCredentialTargetExecutionIdentity(input.identity);
  digest(input.credentialVersionId, "tenant credential target execution version id");
  if (!(TENANT_CREDENTIAL_TARGET_DOMAINS as readonly string[]).includes(input.domain)) {
    throw new Error("tenant credential target execution domain is invalid");
  }
  executableDomain(input.domain);
  digest(
    input.targetDispositionEvidenceSha256,
    "tenant credential target execution disposition evidence",
  );
  identifier(input.adapterProtocol, "tenant credential target execution adapter protocol");
  digest(
    input.targetReferenceCipherSha256,
    "tenant credential target execution reference ciphertext",
  );
  identifier(input.targetReferenceKeyId, "tenant credential target execution reference key id");
  digest(input.targetReferenceSha256, "tenant credential target execution reference");
  return sha256([
    "tenant-credential-target-execution-operation-v1",
    ...IDENTITY_KEYS.map((key) => input.identity[key]),
    input.credentialVersionId,
    input.domain,
    input.targetDispositionEvidenceSha256,
    input.adapterProtocol,
    input.targetReferenceCipherSha256,
    input.targetReferenceKeyId,
    input.targetReferenceSha256,
  ]);
}

export interface TenantCredentialTargetExecutionTarget
  extends TenantCredentialTargetExecutionIdentity {
  scope: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE;
  targetOrdinal: number;
  credentialVersionId: string;
  domain: TenantCredentialTargetExecutableDomain;
  sourceDisposition: "executable_ref";
  targetDispositionEvidenceSha256: string;
  adapterProtocol: string;
  targetReferenceCipherSha256: string;
  targetReferenceKeyId: string;
  targetReferenceSha256: string;
  operationIdSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

type TargetBody = Omit<TenantCredentialTargetExecutionTarget, "receiptSha256">;

export function tenantCredentialTargetExecutionTargetSha256(target: TargetBody): string {
  validateTenantCredentialTargetExecutionIdentity(target);
  if (target.scope !== TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_SCOPE
    || target.sourceDisposition !== "executable_ref") {
    throw new Error("tenant credential target execution target scope or disposition is invalid");
  }
  count(target.targetOrdinal, "tenant credential target execution target ordinal");
  const expectedOperation = tenantCredentialTargetExecutionOperationIdSha256({
    identity: target,
    credentialVersionId: target.credentialVersionId,
    domain: target.domain,
    targetDispositionEvidenceSha256: target.targetDispositionEvidenceSha256,
    adapterProtocol: target.adapterProtocol,
    targetReferenceCipherSha256: target.targetReferenceCipherSha256,
    targetReferenceKeyId: target.targetReferenceKeyId,
    targetReferenceSha256: target.targetReferenceSha256,
  });
  digest(target.operationIdSha256, "tenant credential target execution operation id");
  if (target.operationIdSha256 !== expectedOperation) {
    throw new Error("tenant credential target execution operation id does not match");
  }
  timestamp(target.capturedAtDbMs, "tenant credential target execution target capture time");
  return sha256([
    "tenant-credential-target-execution-target-v1",
    target.scope,
    ...IDENTITY_KEYS.map((key) => target[key]),
    target.targetOrdinal,
    target.credentialVersionId,
    target.domain,
    target.sourceDisposition,
    target.targetDispositionEvidenceSha256,
    target.adapterProtocol,
    target.targetReferenceCipherSha256,
    target.targetReferenceKeyId,
    target.targetReferenceSha256,
    target.operationIdSha256,
    target.capturedAtDbMs,
  ]);
}

export function validateTenantCredentialTargetExecutionTarget(
  target: TenantCredentialTargetExecutionTarget,
): void {
  exactKeys(target, [
    ...IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "credentialVersionId",
    "domain",
    "sourceDisposition",
    "targetDispositionEvidenceSha256",
    "adapterProtocol",
    "targetReferenceCipherSha256",
    "targetReferenceKeyId",
    "targetReferenceSha256",
    "operationIdSha256",
    "capturedAtDbMs",
    "receiptSha256",
  ], "tenant credential target execution target");
  const expected = tenantCredentialTargetExecutionTargetSha256(target);
  digest(target.receiptSha256, "tenant credential target execution target receipt");
  if (target.receiptSha256 !== expected) {
    throw new Error("tenant credential target execution target receipt does not match");
  }
}

export const EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ROOT_SHA256 = sha256([
  "tenant-credential-target-execution-target-root-v1",
]);
export const EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ACK_ROOT_SHA256 = sha256([
  "tenant-credential-target-execution-target-ack-root-v1",
]);
export const EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_ADAPTER_EVIDENCE_ROOT_SHA256 = sha256([
  "tenant-credential-target-execution-adapter-evidence-root-v1",
]);

export function tenantCredentialTargetExecutionTargetRootSha256(
  targets: readonly TenantCredentialTargetExecutionTarget[],
): string {
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const versions = new Set<string>();
  for (const [ordinal, target] of ordered.entries()) {
    validateTenantCredentialTargetExecutionTarget(target);
    if (target.targetOrdinal !== ordinal) {
      throw new Error("tenant credential target execution target ordinals are not contiguous");
    }
    if (versions.has(target.credentialVersionId)) {
      throw new Error("tenant credential target execution version is duplicated");
    }
    versions.add(target.credentialVersionId);
    if (ordinal > 0 && ordered[ordinal - 1]!.credentialVersionId >= target.credentialVersionId) {
      throw new Error("tenant credential target execution targets are not version ordered");
    }
    if (ordered[0] !== undefined && (!sameIdentity(ordered[0]!, target)
      || ordered[0]!.capturedAtDbMs !== target.capturedAtDbMs)) {
      throw new Error("tenant credential target execution targets lack one atomic source");
    }
  }
  return sha256([
    "tenant-credential-target-execution-target-root-v1",
    ...ordered.map((target) => target.receiptSha256),
  ]);
}

/** Ciphertext is short-lived executor input. It must never enter receipts, errors, or logs. */
export interface TenantCredentialTargetExecutionEncryptedReference {
  tenantId: string;
  credentialVersionId: string;
  domain: TenantCredentialTargetExecutableDomain;
  adapterProtocol: string;
  targetDispositionEvidenceSha256: string;
  targetReferenceCipher: Uint8Array;
  targetReferenceCipherSha256: string;
  targetReferenceKeyId: string;
  targetReferenceSha256: string;
}

export function validateTenantCredentialTargetExecutionEncryptedReference(
  reference: TenantCredentialTargetExecutionEncryptedReference,
): void {
  exactKeys(reference, [
    "tenantId",
    "credentialVersionId",
    "domain",
    "adapterProtocol",
    "targetDispositionEvidenceSha256",
    "targetReferenceCipher",
    "targetReferenceCipherSha256",
    "targetReferenceKeyId",
    "targetReferenceSha256",
  ], "tenant credential target execution encrypted reference");
  tenantId(reference.tenantId);
  digest(reference.credentialVersionId, "tenant credential target execution reference version");
  executableDomain(reference.domain);
  identifier(reference.adapterProtocol, "tenant credential target execution reference protocol");
  digest(
    reference.targetDispositionEvidenceSha256,
    "tenant credential target execution reference disposition evidence",
  );
  if (!(reference.targetReferenceCipher instanceof Uint8Array)
    || reference.targetReferenceCipher.byteLength === 0
    || reference.targetReferenceCipher.byteLength > 8_192) {
    throw new Error("tenant credential target execution reference ciphertext is invalid");
  }
  digest(
    reference.targetReferenceCipherSha256,
    "tenant credential target execution reference ciphertext hash",
  );
  if (bytesSha256(reference.targetReferenceCipher) !== reference.targetReferenceCipherSha256) {
    throw new Error("tenant credential target execution reference ciphertext hash does not match");
  }
  identifier(
    reference.targetReferenceKeyId,
    "tenant credential target execution reference key id",
  );
  digest(reference.targetReferenceSha256, "tenant credential target execution reference hash");
}

export interface TenantCredentialTargetExecutionAdapterInput {
  target: TenantCredentialTargetExecutionTarget;
  reference: TenantCredentialTargetExecutionEncryptedReference;
}

export function validateTenantCredentialTargetExecutionAdapterInput(
  input: TenantCredentialTargetExecutionAdapterInput,
): void {
  exactKeys(input, ["target", "reference"], "tenant credential target execution adapter input");
  validateTenantCredentialTargetExecutionTarget(input.target);
  validateTenantCredentialTargetExecutionEncryptedReference(input.reference);
  if (input.target.tenantId !== input.reference.tenantId
    || input.target.credentialVersionId !== input.reference.credentialVersionId
    || input.target.domain !== input.reference.domain
    || input.target.adapterProtocol !== input.reference.adapterProtocol
    || input.target.targetDispositionEvidenceSha256
      !== input.reference.targetDispositionEvidenceSha256
    || input.target.targetReferenceCipherSha256
      !== input.reference.targetReferenceCipherSha256
    || input.target.targetReferenceKeyId !== input.reference.targetReferenceKeyId
    || input.target.targetReferenceSha256 !== input.reference.targetReferenceSha256) {
    throw new Error("tenant credential target execution reference does not match its target");
  }
}

export interface TenantCredentialTargetExecutionAdapterEvidence {
  adapterProtocol: string;
  domain: TenantCredentialTargetExecutableDomain;
  operationIdSha256: string;
  targetReferenceSha256: string;
  outcome: TenantCredentialTargetExecutionOutcome;
}

export function tenantCredentialTargetExecutionAdapterEvidenceSha256(
  evidence: TenantCredentialTargetExecutionAdapterEvidence,
): string {
  exactKeys(evidence, [
    "adapterProtocol",
    "domain",
    "operationIdSha256",
    "targetReferenceSha256",
    "outcome",
  ], "tenant credential target execution adapter evidence");
  identifier(evidence.adapterProtocol, "tenant credential target execution adapter protocol");
  executableDomain(evidence.domain);
  digest(evidence.operationIdSha256, "tenant credential target execution adapter operation");
  digest(evidence.targetReferenceSha256, "tenant credential target execution adapter reference");
  if (!(TENANT_CREDENTIAL_TARGET_EXECUTION_OUTCOMES as readonly string[])
    .includes(evidence.outcome)) {
    throw new Error("tenant credential target execution adapter outcome is invalid");
  }
  return sha256([
    "tenant-credential-target-execution-adapter-evidence-v1",
    evidence.adapterProtocol,
    evidence.domain,
    evidence.operationIdSha256,
    evidence.targetReferenceSha256,
    evidence.outcome,
  ]);
}

export interface TenantCredentialTargetExecutionAdapterResult
  extends TenantCredentialTargetExecutionAdapterEvidence {
  evidenceSha256: string;
  replayed: boolean;
}

export function validateTenantCredentialTargetExecutionAdapterResult(
  result: TenantCredentialTargetExecutionAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol",
    "domain",
    "operationIdSha256",
    "targetReferenceSha256",
    "outcome",
    "evidenceSha256",
    "replayed",
  ], "tenant credential target execution adapter result");
  const expected = tenantCredentialTargetExecutionAdapterEvidenceSha256({
    adapterProtocol: result.adapterProtocol,
    domain: result.domain,
    operationIdSha256: result.operationIdSha256,
    targetReferenceSha256: result.targetReferenceSha256,
    outcome: result.outcome,
  });
  digest(result.evidenceSha256, "tenant credential target execution adapter evidence hash");
  if (result.evidenceSha256 !== expected) {
    throw new Error("tenant credential target execution adapter evidence does not match");
  }
  if (typeof result.replayed !== "boolean") {
    throw new Error("tenant credential target execution adapter replay flag is invalid");
  }
}

export interface TenantCredentialTargetExecutionAdapter {
  readonly adapterProtocol: string;
  readonly domain: "external_credential";
  /** Read the provider's durable idempotency state; null means no exact operation was observed. */
  inspectTarget(
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult | null>;
  /** Apply or exactly replay the immutable operation id. Raw provider responses must not escape. */
  applyTarget(
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult>;
  close(): Promise<void>;
}

export interface TenantCredentialTargetExecutionTargetAck
  extends TenantCredentialTargetExecutionIdentity {
  scope: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ACK_SCOPE;
  targetOrdinal: number;
  credentialVersionId: string;
  domain: TenantCredentialTargetExecutableDomain;
  targetReceiptSha256: string;
  operationIdSha256: string;
  adapterProtocol: string;
  targetReferenceSha256: string;
  outcome: TenantCredentialTargetExecutionOutcome;
  adapterEvidenceSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

type TargetAckBody = Omit<TenantCredentialTargetExecutionTargetAck, "receiptSha256">;

export function tenantCredentialTargetExecutionTargetAckSha256(
  ack: TargetAckBody,
): string {
  validateTenantCredentialTargetExecutionIdentity(ack);
  if (ack.scope !== TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ACK_SCOPE) {
    throw new Error("tenant credential target execution target ACK scope is invalid");
  }
  count(ack.targetOrdinal, "tenant credential target execution target ACK ordinal");
  digest(ack.credentialVersionId, "tenant credential target execution target ACK version");
  executableDomain(ack.domain);
  digest(ack.targetReceiptSha256, "tenant credential target execution target receipt");
  const expectedAdapterEvidence = tenantCredentialTargetExecutionAdapterEvidenceSha256({
    adapterProtocol: ack.adapterProtocol,
    domain: ack.domain,
    operationIdSha256: ack.operationIdSha256,
    targetReferenceSha256: ack.targetReferenceSha256,
    outcome: ack.outcome,
  });
  digest(ack.adapterEvidenceSha256, "tenant credential target execution adapter evidence");
  if (ack.adapterEvidenceSha256 !== expectedAdapterEvidence) {
    throw new Error("tenant credential target execution target ACK adapter evidence is invalid");
  }
  positive(ack.completedClaimAttempt, "tenant credential target execution ACK claim attempt");
  digest(
    ack.completedClaimTokenSha256,
    "tenant credential target execution ACK claim token",
  );
  timestamp(ack.storeDbTimestampMs, "tenant credential target execution ACK timestamp");
  return sha256([
    "tenant-credential-target-execution-target-ack-v1",
    ack.scope,
    ...IDENTITY_KEYS.map((key) => ack[key]),
    ack.targetOrdinal,
    ack.credentialVersionId,
    ack.domain,
    ack.targetReceiptSha256,
    ack.operationIdSha256,
    ack.adapterProtocol,
    ack.targetReferenceSha256,
    ack.outcome,
    ack.adapterEvidenceSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
  ]);
}

export function validateTenantCredentialTargetExecutionTargetAck(
  ack: TenantCredentialTargetExecutionTargetAck,
): void {
  exactKeys(ack, [
    ...IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "credentialVersionId",
    "domain",
    "targetReceiptSha256",
    "operationIdSha256",
    "adapterProtocol",
    "targetReferenceSha256",
    "outcome",
    "adapterEvidenceSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "receiptSha256",
  ], "tenant credential target execution target ACK");
  const expected = tenantCredentialTargetExecutionTargetAckSha256(ack);
  digest(ack.receiptSha256, "tenant credential target execution target ACK receipt");
  if (ack.receiptSha256 !== expected) {
    throw new Error("tenant credential target execution target ACK receipt does not match");
  }
}

export function tenantCredentialTargetExecutionTargetAckRootSha256(
  acks: readonly TenantCredentialTargetExecutionTargetAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const versions = new Set<string>();
  for (const [ordinal, ack] of ordered.entries()) {
    validateTenantCredentialTargetExecutionTargetAck(ack);
    if (ack.targetOrdinal !== ordinal) {
      throw new Error("tenant credential target execution target ACK ordinals are not contiguous");
    }
    if (versions.has(ack.credentialVersionId)) {
      throw new Error("tenant credential target execution target ACK is duplicated");
    }
    versions.add(ack.credentialVersionId);
    if (ordinal > 0 && ordered[ordinal - 1]!.credentialVersionId >= ack.credentialVersionId) {
      throw new Error("tenant credential target execution target ACKs are not version ordered");
    }
    if (ordered[0] !== undefined && !sameIdentity(ordered[0]!, ack)) {
      throw new Error("tenant credential target execution target ACKs have different identities");
    }
  }
  return sha256([
    "tenant-credential-target-execution-target-ack-root-v1",
    ...ordered.map((ack) => ack.receiptSha256),
  ]);
}

export function tenantCredentialTargetExecutionAdapterEvidenceRootSha256(
  acks: readonly TenantCredentialTargetExecutionTargetAck[],
): string {
  const hashes = acks.map((ack) => {
    validateTenantCredentialTargetExecutionTargetAck(ack);
    return ack.adapterEvidenceSha256;
  }).sort();
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("tenant credential target execution adapter evidence is duplicated");
  }
  return sha256([
    "tenant-credential-target-execution-adapter-evidence-root-v1",
    ...hashes,
  ]);
}

export interface TenantCredentialTargetExecutionReceiptBody
  extends TenantCredentialTargetExecutionSource {
  scope: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_RECEIPT_SCOPE;
  targetCount: number;
  targetRootSha256: string;
  targetAckCount: number;
  targetAckRootSha256: string;
  adapterEvidenceCount: number;
  adapterEvidenceRootSha256: string;
  externalCredentialExecutionComplete: true;
  kmsKeyExecutionComplete: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  unresolvedBlockerCount: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
}

export interface TenantCredentialTargetExecutionReceipt
  extends TenantCredentialTargetExecutionReceiptBody {
  receiptSha256: string;
}

export function validateTenantCredentialTargetExecutionReceiptBody(
  receipt: TenantCredentialTargetExecutionReceiptBody,
): void {
  exactKeys(receipt, [
    ...SOURCE_KEYS,
    "scope",
    "targetCount",
    "targetRootSha256",
    "targetAckCount",
    "targetAckRootSha256",
    "adapterEvidenceCount",
    "adapterEvidenceRootSha256",
    "externalCredentialExecutionComplete",
    "kmsKeyExecutionComplete",
    "allDomainsComplete",
    "contentPurgeExecuted",
    "unresolvedBlockerCount",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
  ], "tenant credential target execution receipt");
  validateTenantCredentialTargetExecutionSource(receipt);
  if (receipt.scope !== TENANT_CREDENTIAL_TARGET_EXECUTION_RECEIPT_SCOPE) {
    throw new Error("tenant credential target execution receipt scope is invalid");
  }
  for (const [value, name] of [
    [receipt.targetCount, "target count"],
    [receipt.targetAckCount, "target ACK count"],
    [receipt.adapterEvidenceCount, "adapter evidence count"],
    [receipt.unresolvedBlockerCount, "unresolved blocker count"],
  ] as const) count(value, `tenant credential target execution receipt ${name}`);
  for (const [value, name] of [
    [receipt.targetRootSha256, "target root"],
    [receipt.targetAckRootSha256, "target ACK root"],
    [receipt.adapterEvidenceRootSha256, "adapter evidence root"],
  ] as const) digest(value, `tenant credential target execution receipt ${name}`);
  if (receipt.targetCount !== receipt.externalCredentialTargetCount
    || receipt.targetAckCount !== receipt.targetCount
    || receipt.adapterEvidenceCount !== receipt.targetCount
    || receipt.externalCredentialBlockerCount !== 0) {
    throw new Error("tenant credential target execution receipt lacks complete external coverage");
  }
  if (receipt.targetCount === 0
    && (receipt.targetRootSha256
        !== EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ROOT_SHA256
      || receipt.targetAckRootSha256
        !== EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_TARGET_ACK_ROOT_SHA256
      || receipt.adapterEvidenceRootSha256
        !== EMPTY_TENANT_CREDENTIAL_TARGET_EXECUTION_ADAPTER_EVIDENCE_ROOT_SHA256)) {
    throw new Error("empty tenant credential target execution receipt has non-empty roots");
  }
  if (receipt.externalCredentialExecutionComplete !== true
    || receipt.kmsKeyExecutionComplete !== false
    || receipt.allDomainsComplete !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant credential target execution receipt overstates completion");
  }
  if (receipt.unresolvedBlockerCount !== receipt.kmsKeyBlockerCount) {
    throw new Error("tenant credential target execution receipt blocker count is invalid");
  }
  positive(
    receipt.completedClaimAttempt,
    "tenant credential target execution receipt claim attempt",
  );
  digest(
    receipt.completedClaimTokenSha256,
    "tenant credential target execution receipt claim token",
  );
  timestamp(receipt.storeDbTimestampMs, "tenant credential target execution receipt timestamp");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant credential target execution receipt predates its source");
  }
}

export function tenantCredentialTargetExecutionReceiptSha256(
  receipt: TenantCredentialTargetExecutionReceiptBody,
): string {
  validateTenantCredentialTargetExecutionReceiptBody(receipt);
  return sha256([
    "tenant-credential-target-execution-receipt-v1",
    ...SOURCE_KEYS.map((key) => receipt[key]),
    receipt.scope,
    receipt.targetCount,
    receipt.targetRootSha256,
    receipt.targetAckCount,
    receipt.targetAckRootSha256,
    receipt.adapterEvidenceCount,
    receipt.adapterEvidenceRootSha256,
    receipt.externalCredentialExecutionComplete,
    receipt.kmsKeyExecutionComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
    receipt.unresolvedBlockerCount,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.storeDbTimestampMs,
  ]);
}

export function validateTenantCredentialTargetExecutionReceipt(
  receipt: TenantCredentialTargetExecutionReceipt,
): void {
  const { receiptSha256, ...body } = receipt;
  digest(receiptSha256, "tenant credential target execution receipt hash");
  if (receiptSha256 !== tenantCredentialTargetExecutionReceiptSha256(body)) {
    throw new Error("tenant credential target execution receipt hash does not match");
  }
}

export interface MaterializeTenantCredentialTargetExecutionJobsOptions {
  limit: number;
}

export interface ClaimTenantCredentialTargetExecutionsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface RenewTenantCredentialTargetExecutionOptions {
  leaseMs: number;
}

export interface RetryTenantCredentialTargetExecutionOptions {
  delayMs: number;
  errorCode: TenantCredentialTargetExecutionRetryErrorCode;
}

interface TenantCredentialTargetExecutionJobBase
  extends TenantCredentialTargetExecutionSource {
  phase: TenantCredentialTargetExecutionJobPhase;
  targetCount: number;
  targetRootSha256: string;
  targetAckCount: number;
  targetAckRootSha256: string;
  adapterEvidenceCount: number;
  adapterEvidenceRootSha256: string;
  unresolvedBlockerCount: number;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantCredentialTargetExecutionJobRecord =
  TenantCredentialTargetExecutionJobBase & (
    | {
        phase: "queued";
        availableAtMs: number;
        claimToken?: string;
        leaseUntilMs?: number;
        lastErrorCode?: TenantCredentialTargetExecutionRetryErrorCode;
        terminalReceiptSha256?: never;
        sealedAtDbMs?: never;
        completedClaimAttempt?: never;
        completedClaimTokenSha256?: never;
        blockedAtDbMs?: never;
        blockedReasonCode?: never;
      }
    | {
        phase: "external_credential_sealed";
        availableAtMs?: never;
        claimToken?: never;
        leaseUntilMs?: never;
        lastErrorCode?: never;
        terminalReceiptSha256: string;
        sealedAtDbMs: number;
        completedClaimAttempt: number;
        completedClaimTokenSha256: string;
        blockedAtDbMs?: never;
        blockedReasonCode?: never;
      }
    | {
        phase: "blocked";
        availableAtMs?: never;
        claimToken?: never;
        leaseUntilMs?: never;
        lastErrorCode?: never;
        terminalReceiptSha256?: never;
        sealedAtDbMs?: never;
        completedClaimAttempt?: never;
        completedClaimTokenSha256?: never;
        blockedAtDbMs: number;
        blockedReasonCode: TenantCredentialTargetExecutionBlockReasonCode;
      }
  );

export interface TenantCredentialTargetExecutionClaim
  extends TenantCredentialTargetExecutionSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
  targetCount: number;
  targetRootSha256: string;
}

export type TenantCredentialTargetExecutionAuthorization = Pick<
  TenantCredentialTargetExecutionClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "targetExecutionGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export function tenantCredentialTargetExecutionClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-credential-target-execution-claim-token-v1", value]);
}

export function validateTenantCredentialTargetExecutionAuthorization(
  authorization: TenantCredentialTargetExecutionAuthorization,
): void {
  exactKeys(authorization, [...IDENTITY_KEYS, "claimAttempt", "claimToken"],
    "tenant credential target execution authorization");
  validateTenantCredentialTargetExecutionIdentity(authorization);
  positive(authorization.claimAttempt, "tenant credential target execution claim attempt");
  claimToken(authorization.claimToken);
}

export function validateTenantCredentialTargetExecutionClaim(
  claim: TenantCredentialTargetExecutionClaim,
): void {
  exactKeys(claim, [
    ...SOURCE_KEYS,
    "phase",
    "claimAttempt",
    "claimToken",
    "leaseUntilMs",
    "targetCount",
    "targetRootSha256",
  ], "tenant credential target execution claim");
  validateTenantCredentialTargetExecutionSource(claim);
  if (claim.phase !== "queued") {
    throw new Error("tenant credential target execution claim phase is invalid");
  }
  positive(claim.claimAttempt, "tenant credential target execution claim attempt");
  claimToken(claim.claimToken);
  timestamp(claim.leaseUntilMs, "tenant credential target execution claim lease");
  count(claim.targetCount, "tenant credential target execution claim target count");
  digest(claim.targetRootSha256, "tenant credential target execution claim target root");
  if (claim.targetCount !== claim.externalCredentialTargetCount) {
    throw new Error("tenant credential target execution claim target count is invalid");
  }
}

export function validateTenantCredentialTargetExecutionJobRecord(
  job: TenantCredentialTargetExecutionJobRecord,
): void {
  validateTenantCredentialTargetExecutionSource(job);
  for (const [value, name] of [
    [job.targetCount, "target count"],
    [job.targetAckCount, "target ACK count"],
    [job.adapterEvidenceCount, "adapter evidence count"],
    [job.unresolvedBlockerCount, "unresolved blocker count"],
    [job.attempts, "attempts"],
  ] as const) count(value, `tenant credential target execution job ${name}`);
  for (const [value, name] of [
    [job.targetRootSha256, "target root"],
    [job.targetAckRootSha256, "target ACK root"],
    [job.adapterEvidenceRootSha256, "adapter evidence root"],
  ] as const) digest(value, `tenant credential target execution job ${name}`);
  timestamp(job.createdAtMs, "tenant credential target execution job creation time");
  timestamp(job.updatedAtMs, "tenant credential target execution job update time");
  if (job.updatedAtMs < job.createdAtMs
    || job.targetCount !== job.externalCredentialTargetCount
    || job.targetAckCount > job.targetCount
    || job.adapterEvidenceCount !== job.targetAckCount
    || job.unresolvedBlockerCount
      > job.externalCredentialBlockerCount + job.kmsKeyBlockerCount) {
    throw new Error("tenant credential target execution job counters are invalid");
  }
  const baseKeys = [
    ...SOURCE_KEYS,
    "phase",
    "targetCount",
    "targetRootSha256",
    "targetAckCount",
    "targetAckRootSha256",
    "adapterEvidenceCount",
    "adapterEvidenceRootSha256",
    "unresolvedBlockerCount",
    "attempts",
    "createdAtMs",
    "updatedAtMs",
  ] as const;
  if (job.phase === "queued") {
    exactKeys(job, [
      ...baseKeys,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant credential target execution job");
    timestamp(job.availableAtMs, "tenant credential target execution job availability");
    if (job.externalCredentialBlockerCount !== 0) {
      throw new Error("queued tenant credential target execution job retains a source blocker");
    }
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant credential target execution job claim is incomplete");
    }
    if (job.claimToken === undefined) {
      if (job.availableAtMs < job.updatedAtMs) {
        throw new Error("tenant credential target execution job availability predates update");
      }
    } else {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs!, "tenant credential target execution job lease");
      if (job.attempts < 1 || job.leaseUntilMs! < job.updatedAtMs
        || job.lastErrorCode !== undefined) {
        throw new Error("tenant credential target execution active claim is invalid");
      }
    }
    if (job.lastErrorCode !== undefined
      && !("temporary_failure" === job.lastErrorCode
        || "dependency_pending" === job.lastErrorCode)) {
      throw new Error("tenant credential target execution retry code is invalid");
    }
    return;
  }
  if (job.phase === "external_credential_sealed") {
    exactKeys(job, [
      ...baseKeys,
      "terminalReceiptSha256",
      "sealedAtDbMs",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
    ], "sealed tenant credential target execution job");
    digest(job.terminalReceiptSha256, "tenant credential target execution terminal receipt");
    timestamp(job.sealedAtDbMs, "tenant credential target execution job seal time");
    positive(job.completedClaimAttempt, "tenant credential target execution completion attempt");
    digest(
      job.completedClaimTokenSha256,
      "tenant credential target execution completion claim token",
    );
    if (job.externalCredentialBlockerCount !== 0
      || job.targetAckCount !== job.targetCount
      || job.adapterEvidenceCount !== job.targetCount
      || job.unresolvedBlockerCount !== job.kmsKeyBlockerCount
      || job.completedClaimAttempt !== job.attempts
      || job.sealedAtDbMs < job.sourceEvidenceDbMs
      || job.sealedAtDbMs > job.updatedAtMs) {
      throw new Error("sealed tenant credential target execution job evidence is incomplete");
    }
    return;
  }
  if (job.phase === "blocked") {
    exactKeys(job, [...baseKeys, "blockedAtDbMs", "blockedReasonCode"],
      "blocked tenant credential target execution job");
    timestamp(job.blockedAtDbMs, "tenant credential target execution job blocked time");
    if (!(job.blockedReasonCode === "source_blocked"
      || job.blockedReasonCode === "integrity_conflict")) {
      throw new Error("tenant credential target execution block reason is invalid");
    }
    if (job.blockedReasonCode === "source_blocked"
      && job.externalCredentialBlockerCount === 0) {
      throw new Error("tenant credential target execution source block lacks a blocker");
    }
    if (job.blockedAtDbMs < job.sourceEvidenceDbMs
      || job.blockedAtDbMs > job.updatedAtMs) {
      throw new Error("tenant credential target execution block time is invalid");
    }
    return;
  }
  throw new Error("tenant credential target execution job phase is invalid");
}

export function validateMaterializeTenantCredentialTargetExecutionJobsOptions(
  options: MaterializeTenantCredentialTargetExecutionJobsOptions,
): void {
  exactKeys(options, ["limit"], "materialize tenant credential target execution options");
  positive(options.limit, "tenant credential target execution materialize limit");
  if (options.limit > 100) {
    throw new Error("tenant credential target execution materialize limit must not exceed 100");
  }
}

export function validateClaimTenantCredentialTargetExecutionsOptions(
  options: ClaimTenantCredentialTargetExecutionsOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"],
    "claim tenant credential target executions options");
  positive(options.limit, "tenant credential target execution claim limit");
  if (options.limit > 100) {
    throw new Error("tenant credential target execution claim limit must not exceed 100");
  }
  positive(options.leaseMs, "tenant credential target execution lease");
  claimToken(options.claimToken);
}

export function validateRenewTenantCredentialTargetExecutionOptions(
  options: RenewTenantCredentialTargetExecutionOptions,
): void {
  exactKeys(options, ["leaseMs"], "renew tenant credential target execution options");
  positive(options.leaseMs, "tenant credential target execution renewal lease");
}

export function validateRetryTenantCredentialTargetExecutionOptions(
  options: RetryTenantCredentialTargetExecutionOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"],
    "retry tenant credential target execution options");
  timestamp(options.delayMs, "tenant credential target execution retry delay");
  if (!(options.errorCode === "temporary_failure"
    || options.errorCode === "dependency_pending")) {
    throw new Error("tenant credential target execution retry code is invalid");
  }
}

export type TenantCredentialTargetExecutionCutoverRecord =
  | {
      singletonId: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_CUTOVER_SINGLETON_ID;
      controlGeneration: 0;
    }
  | {
      singletonId: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_CUTOVER_SINGLETON_ID;
      controlGeneration: 1;
      activatedAtDbMs: number;
      firstRequestId: string;
      firstReceiptSha256: string;
      executionProtocol: typeof TENANT_CREDENTIAL_TARGET_EXECUTION_PROTOCOL;
      externalCredentialExecutionEnabled: true;
      kmsKeyExecutionEnabled: false;
      evidenceSha256: string;
    };

type ActiveCutover = Extract<
  TenantCredentialTargetExecutionCutoverRecord,
  { controlGeneration: 1 }
>;

export function tenantCredentialTargetExecutionCutoverEvidenceSha256(
  input: Omit<ActiveCutover, "evidenceSha256">,
): string {
  exactKeys(input, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "firstRequestId",
    "firstReceiptSha256",
    "executionProtocol",
    "externalCredentialExecutionEnabled",
    "kmsKeyExecutionEnabled",
  ], "tenant credential target execution cutover evidence");
  if (input.singletonId !== TENANT_CREDENTIAL_TARGET_EXECUTION_CUTOVER_SINGLETON_ID
    || input.controlGeneration !== 1
    || !REQUEST_ID.test(input.firstRequestId)
    || input.executionProtocol !== TENANT_CREDENTIAL_TARGET_EXECUTION_PROTOCOL
    || input.externalCredentialExecutionEnabled !== true
    || input.kmsKeyExecutionEnabled !== false) {
    throw new Error("tenant credential target execution cutover identity is invalid");
  }
  timestamp(input.activatedAtDbMs, "tenant credential target execution cutover time");
  digest(input.firstReceiptSha256, "tenant credential target execution first receipt");
  return sha256([
    "tenant-credential-target-execution-cutover-v1",
    input.singletonId,
    input.controlGeneration,
    input.activatedAtDbMs,
    input.firstRequestId,
    input.firstReceiptSha256,
    input.executionProtocol,
    input.externalCredentialExecutionEnabled,
    input.kmsKeyExecutionEnabled,
  ]);
}

export function validateTenantCredentialTargetExecutionCutoverRecord(
  record: TenantCredentialTargetExecutionCutoverRecord,
): void {
  if (record.controlGeneration === 0) {
    exactKeys(record, ["singletonId", "controlGeneration"],
      "inactive tenant credential target execution cutover");
    if (record.singletonId !== TENANT_CREDENTIAL_TARGET_EXECUTION_CUTOVER_SINGLETON_ID) {
      throw new Error("tenant credential target execution cutover singleton is invalid");
    }
    return;
  }
  exactKeys(record, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "firstRequestId",
    "firstReceiptSha256",
    "executionProtocol",
    "externalCredentialExecutionEnabled",
    "kmsKeyExecutionEnabled",
    "evidenceSha256",
  ], "active tenant credential target execution cutover");
  const expected = tenantCredentialTargetExecutionCutoverEvidenceSha256({
    singletonId: record.singletonId,
    controlGeneration: record.controlGeneration,
    activatedAtDbMs: record.activatedAtDbMs,
    firstRequestId: record.firstRequestId,
    firstReceiptSha256: record.firstReceiptSha256,
    executionProtocol: record.executionProtocol,
    externalCredentialExecutionEnabled: record.externalCredentialExecutionEnabled,
    kmsKeyExecutionEnabled: record.kmsKeyExecutionEnabled,
  });
  digest(record.evidenceSha256, "tenant credential target execution cutover evidence");
  if (record.evidenceSha256 !== expected) {
    throw new Error("tenant credential target execution cutover evidence does not match");
  }
}

/** Store boundary for the 0029 external-credential target execution slice. */
export interface TenantCredentialTargetExecutionStore {
  materializeTenantCredentialTargetExecutionJobs(
    options: MaterializeTenantCredentialTargetExecutionJobsOptions,
  ): Promise<number>;
  claimTenantCredentialTargetExecutions(
    options: ClaimTenantCredentialTargetExecutionsOptions,
  ): Promise<TenantCredentialTargetExecutionClaim[]>;
  renewTenantCredentialTargetExecution(
    authorization: TenantCredentialTargetExecutionAuthorization,
    options: RenewTenantCredentialTargetExecutionOptions,
  ): Promise<boolean>;
  retryTenantCredentialTargetExecution(
    authorization: TenantCredentialTargetExecutionAuthorization,
    options: RetryTenantCredentialTargetExecutionOptions,
  ): Promise<boolean>;
  blockTenantCredentialTargetExecution(
    authorization: TenantCredentialTargetExecutionAuthorization,
    reason?: TenantCredentialTargetExecutionBlockReasonCode,
  ): Promise<boolean>;
  getTenantCredentialTargetExecutionReference(
    authorization: TenantCredentialTargetExecutionAuthorization,
    targetOrdinal: number,
  ): Promise<TenantCredentialTargetExecutionEncryptedReference | null>;
  recordTenantCredentialTargetExecutionTargetAck(
    authorization: TenantCredentialTargetExecutionAuthorization,
    result: TenantCredentialTargetExecutionAdapterResult,
  ): Promise<TenantCredentialTargetExecutionTargetAck | null>;
  sealTenantCredentialTargetExecution(
    authorization: TenantCredentialTargetExecutionAuthorization,
  ): Promise<TenantCredentialTargetExecutionReceipt | null>;
  getTenantCredentialTargetExecutionJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialTargetExecutionJobRecord | null>;
  getTenantCredentialTargetExecutionTargets(
    tenantId: string,
    requestId: string,
    targetExecutionGeneration: number,
  ): Promise<TenantCredentialTargetExecutionTarget[]>;
  getTenantCredentialTargetExecutionTargetAcks(
    tenantId: string,
    requestId: string,
    targetExecutionGeneration: number,
  ): Promise<TenantCredentialTargetExecutionTargetAck[]>;
  getTenantCredentialTargetExecutionReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialTargetExecutionReceipt | null>;
  getTenantCredentialTargetExecutionCutover():
    Promise<TenantCredentialTargetExecutionCutoverRecord>;
  hasTenantCredentialTargetExecutionJobs(): Promise<boolean>;
}
