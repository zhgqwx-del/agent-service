import { createHash } from "node:crypto";

export const TENANT_CREDENTIAL_TRACKING_CUTOVER_SINGLETON_ID = 1 as const;
export const TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE =
  "tenant-credential-inventory-v1" as const;

export const TENANT_CREDENTIAL_SLOT_KINDS = [
  "provider_binding",
  "tenant_auth_secret",
] as const;
export type TenantCredentialSlotKind = (typeof TENANT_CREDENTIAL_SLOT_KINDS)[number];

export const TENANT_CREDENTIAL_HISTORY_STATUSES = [
  "complete_since_creation",
  "legacy_history_unknown",
] as const;
export type TenantCredentialHistoryStatus =
  (typeof TENANT_CREDENTIAL_HISTORY_STATUSES)[number];

export const TENANT_CREDENTIAL_ORIGINS = ["managed_v1", "legacy_observed"] as const;
export type TenantCredentialOrigin = (typeof TENANT_CREDENTIAL_ORIGINS)[number];

export const TENANT_CREDENTIAL_RETIRE_REASONS = [
  "replaced",
  "deleted",
  "cleared",
  "tenant_erasure",
] as const;
export type TenantCredentialRetireReason =
  (typeof TENANT_CREDENTIAL_RETIRE_REASONS)[number];

export const TENANT_CREDENTIAL_TARGET_DOMAINS = [
  "external_credential",
  "kms_key",
] as const;
export type TenantCredentialTargetDomain =
  (typeof TENANT_CREDENTIAL_TARGET_DOMAINS)[number];

export const TENANT_CREDENTIAL_TARGET_DISPOSITIONS = [
  "executable_ref",
  "not_applicable",
  "blocked_no_locator",
  "blocked_adapter_unconfigured",
  "blocked_shared_local_key",
  "blocked_legacy_history",
] as const;
export type TenantCredentialTargetDispositionKind =
  (typeof TENANT_CREDENTIAL_TARGET_DISPOSITIONS)[number];

/** Internal write-side locator captured by trusted server integration, never public API input. */
export interface ProviderCredentialTargetReferenceWrite {
  domain: "external_credential";
  disposition: "executable_ref";
  adapterProtocol: string;
  targetReferenceCipher: Buffer;
  targetReferenceKeyId: string;
  targetReferenceCipherSha256: string;
  targetReferenceSha256: string;
}

export const TENANT_CREDENTIAL_BLOCKING_TARGET_DISPOSITIONS = [
  "blocked_no_locator",
  "blocked_adapter_unconfigured",
  "blocked_shared_local_key",
  "blocked_legacy_history",
] as const satisfies readonly TenantCredentialTargetDispositionKind[];

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;
const NONCE = /^[A-Za-z0-9._:~-]{16,128}$/;
const REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function tenantId(value: string): void {
  if (!value || value.length > 128) throw new Error("invalid tenant credential tenant id");
}

function enumValue<T extends string>(
  value: string,
  values: readonly T[],
  name: string,
): asserts value is T {
  if (!(values as readonly string[]).includes(value)) throw new Error(`${name} is invalid`);
}

function root(domain: string, values: readonly string[]): string {
  for (const value of values) digest(value, `${domain} member`);
  return sha256([domain, [...values].sort()]);
}

export function validateProviderCredentialTargetReferenceWrite(
  target: ProviderCredentialTargetReferenceWrite,
): void {
  exactKeys(target, [
    "domain", "disposition", "adapterProtocol", "targetReferenceCipher",
    "targetReferenceKeyId", "targetReferenceCipherSha256", "targetReferenceSha256",
  ], "provider credential target reference write");
  if (target.domain !== "external_credential" || target.disposition !== "executable_ref") {
    throw new Error("provider credential target reference write has an invalid disposition");
  }
  if (!IDENTIFIER.test(target.adapterProtocol)) {
    throw new Error("provider credential target adapter protocol is invalid");
  }
  if (!IDENTIFIER.test(target.targetReferenceKeyId)) {
    throw new Error("provider credential target reference key id is invalid");
  }
  if (!Buffer.isBuffer(target.targetReferenceCipher)
    || target.targetReferenceCipher.length < 1
    || target.targetReferenceCipher.length > 8_192) {
    throw new Error("provider credential target reference ciphertext is invalid");
  }
  digest(target.targetReferenceCipherSha256, "provider credential target reference ciphertext");
  digest(target.targetReferenceSha256, "provider credential target reference");
  const cipherSha256 = createHash("sha256").update(target.targetReferenceCipher).digest("hex");
  if (target.targetReferenceCipherSha256 !== cipherSha256) {
    throw new Error("provider credential target reference ciphertext hash mismatch");
  }
}

export interface TenantCredentialTrackingCutoverRecord {
  controlGeneration: 0 | 1;
  activatedAtDbMs?: number;
  subjectCount?: number;
  subjectRootSha256?: string;
  providerSlotCount?: number;
  providerSlotRootSha256?: string;
  authSlotCount?: number;
  authSlotRootSha256?: string;
  versionCount?: number;
  versionRootSha256?: string;
  targetDispositionCount?: number;
  targetDispositionRootSha256?: string;
  evidenceSha256?: string;
}

export interface ActivateTenantCredentialTrackingInput {
  expectedControlGeneration: 0;
}

export function tenantCredentialTrackingCutoverEvidenceSha256(input: {
  activatedAtDbMs: number;
  subjectCount: number;
  subjectRootSha256: string;
  providerSlotCount: number;
  providerSlotRootSha256: string;
  authSlotCount: number;
  authSlotRootSha256: string;
  versionCount: number;
  versionRootSha256: string;
  targetDispositionCount: number;
  targetDispositionRootSha256: string;
}): string {
  exactKeys(input, [
    "activatedAtDbMs", "subjectCount", "subjectRootSha256", "providerSlotCount",
    "providerSlotRootSha256", "authSlotCount", "authSlotRootSha256", "versionCount", "versionRootSha256",
    "targetDispositionCount", "targetDispositionRootSha256",
  ], "tenant credential cutover evidence");
  timestamp(input.activatedAtDbMs, "tenant credential cutover activation time");
  count(input.subjectCount, "tenant credential cutover subject count");
  count(input.providerSlotCount, "tenant credential cutover provider slot count");
  count(input.authSlotCount, "tenant credential cutover auth slot count");
  count(input.versionCount, "tenant credential cutover version count");
  count(input.targetDispositionCount, "tenant credential cutover target count");
  digest(input.subjectRootSha256, "tenant credential cutover subject root");
  digest(input.providerSlotRootSha256, "tenant credential cutover provider slot root");
  digest(input.authSlotRootSha256, "tenant credential cutover auth slot root");
  digest(input.versionRootSha256, "tenant credential cutover version root");
  digest(input.targetDispositionRootSha256, "tenant credential cutover target root");
  if (!Number.isSafeInteger(input.versionCount * 2)
    || input.targetDispositionCount !== input.versionCount * 2) {
    throw new Error("tenant credential cutover requires two target dispositions per version");
  }
  if (input.authSlotCount !== input.subjectCount) {
    throw new Error("tenant credential cutover requires one auth slot per coverage subject");
  }
  return sha256([
    "tenant-credential-tracking-cutover-v1",
    input.activatedAtDbMs,
    input.subjectCount,
    input.subjectRootSha256,
    input.providerSlotCount,
    input.providerSlotRootSha256,
    input.authSlotCount,
    input.authSlotRootSha256,
    input.versionCount,
    input.versionRootSha256,
    input.targetDispositionCount,
    input.targetDispositionRootSha256,
  ]);
}

export function validateTenantCredentialTrackingCutoverRecord(
  record: TenantCredentialTrackingCutoverRecord,
): void {
  if (record.controlGeneration === 0) {
    exactKeys(record, ["controlGeneration"], "inactive tenant credential cutover");
    return;
  }
  if (record.controlGeneration !== 1) throw new Error("invalid tenant credential cutover generation");
  exactKeys(record, [
    "controlGeneration", "activatedAtDbMs", "subjectCount", "subjectRootSha256",
    "providerSlotCount", "providerSlotRootSha256", "authSlotCount", "authSlotRootSha256",
    "versionCount", "versionRootSha256", "targetDispositionCount",
    "targetDispositionRootSha256", "evidenceSha256",
  ], "active tenant credential cutover");
  const evidenceSha256 = tenantCredentialTrackingCutoverEvidenceSha256({
    activatedAtDbMs: record.activatedAtDbMs!,
    subjectCount: record.subjectCount!,
    subjectRootSha256: record.subjectRootSha256!,
    providerSlotCount: record.providerSlotCount!,
    providerSlotRootSha256: record.providerSlotRootSha256!,
    authSlotCount: record.authSlotCount!,
    authSlotRootSha256: record.authSlotRootSha256!,
    versionCount: record.versionCount!,
    versionRootSha256: record.versionRootSha256!,
    targetDispositionCount: record.targetDispositionCount!,
    targetDispositionRootSha256: record.targetDispositionRootSha256!,
  });
  if (record.evidenceSha256 !== evidenceSha256) {
    throw new Error("tenant credential cutover evidence hash mismatch");
  }
}

/** One permanent coverage/gap row per tenant, including tenants with no live credential source. */
export interface TenantCredentialTrackingSubjectBody {
  tenantId: string;
  trackingStartedAtDbMs: number;
  historyStatus: TenantCredentialHistoryStatus;
  origin: TenantCredentialOrigin;
}

export interface TenantCredentialTrackingSubject extends TenantCredentialTrackingSubjectBody {
  evidenceSha256: string;
}

export function validateTenantCredentialTrackingSubjectBody(
  subject: TenantCredentialTrackingSubjectBody,
): void {
  exactKeys(subject, ["tenantId", "trackingStartedAtDbMs", "historyStatus", "origin"],
    "tenant credential tracking subject");
  tenantId(subject.tenantId);
  timestamp(subject.trackingStartedAtDbMs, "tenant credential tracking start time");
  enumValue(
    subject.historyStatus,
    TENANT_CREDENTIAL_HISTORY_STATUSES,
    "tenant credential history status",
  );
  enumValue(subject.origin, TENANT_CREDENTIAL_ORIGINS, "tenant credential origin");
  if ((subject.origin === "managed_v1") !== (subject.historyStatus === "complete_since_creation")) {
    throw new Error("tenant credential origin and history status disagree");
  }
}

export function tenantCredentialSubjectEvidenceSha256(
  subject: TenantCredentialTrackingSubjectBody,
): string {
  validateTenantCredentialTrackingSubjectBody(subject);
  return sha256([
    "tenant-credential-tracking-subject-v1",
    subject.tenantId,
    subject.trackingStartedAtDbMs,
    subject.historyStatus,
    subject.origin,
  ]);
}

export function validateTenantCredentialTrackingSubject(
  subject: TenantCredentialTrackingSubject,
): void {
  exactKeys(subject, [
    "tenantId", "trackingStartedAtDbMs", "historyStatus", "origin", "evidenceSha256",
  ], "tenant credential tracking subject");
  const { evidenceSha256, ...body } = subject;
  digest(evidenceSha256, "tenant credential subject evidence");
  if (evidenceSha256 !== tenantCredentialSubjectEvidenceSha256(body)) {
    throw new Error("tenant credential subject evidence hash mismatch");
  }
}

/** Hash a provider id or the canonical auth slot without retaining the raw slot identifier. */
export function tenantCredentialSlotIdSha256(
  tenant: string,
  slotKind: TenantCredentialSlotKind,
  slotId: string,
): string {
  tenantId(tenant);
  enumValue(slotKind, TENANT_CREDENTIAL_SLOT_KINDS, "tenant credential slot kind");
  if (slotKind === "tenant_auth_secret") {
    if (slotId !== "tenant_auth_secret") {
      throw new Error("tenant auth credential must use its canonical slot id");
    }
  } else if (!slotId || slotId.length > 128) {
    // Provider ids use protocol.externalId, whose deliberately free-form character set predates
    // this ledger. JSON tuple hashing is unambiguous, so narrowing that public API here would be a
    // compatibility regression without adding any storage or cryptographic safety.
    throw new Error("tenant credential slot id is invalid");
  }
  return sha256(["tenant-credential-slot-id-v1", tenant, slotKind, slotId]);
}

/**
 * Produce a non-reusable opaque id. The caller must supply a fresh random nonce for every version;
 * the nonce and raw slot id are not persisted. Credential/config/header/base-URL values are not
 * accepted, hashed, or stored by this helper.
 */
export function tenantCredentialVersionId(input: {
  tenantId: string;
  slotKind: TenantCredentialSlotKind;
  slotId: string;
  createdAtDbMs: number;
  nonce: string;
}): string {
  exactKeys(input, ["tenantId", "slotKind", "slotId", "createdAtDbMs", "nonce"],
    "tenant credential version id input");
  const slotIdSha256 = tenantCredentialSlotIdSha256(input.tenantId, input.slotKind, input.slotId);
  timestamp(input.createdAtDbMs, "tenant credential version creation time");
  if (!NONCE.test(input.nonce)) throw new Error("tenant credential version nonce is invalid");
  return sha256([
    "tenant-credential-version-id-v1",
    input.tenantId,
    input.slotKind,
    slotIdSha256,
    input.createdAtDbMs,
    input.nonce,
  ]);
}

export interface TenantCredentialVersionBody {
  credentialVersionId: string;
  tenantId: string;
  slotKind: TenantCredentialSlotKind;
  slotIdSha256: string;
  origin: TenantCredentialOrigin;
  encryptedSecretPresent: boolean;
  secretKeyIdPresent: boolean;
  customHeadersPresent: boolean;
  endpointParametersPresent: boolean;
  createdAtDbMs: number;
  retiredAtDbMs?: number;
  retireReason?: TenantCredentialRetireReason;
}

export interface TenantCredentialVersion extends TenantCredentialVersionBody {
  evidenceSha256: string;
}

export function validateTenantCredentialVersionBody(version: TenantCredentialVersionBody): void {
  const retired = version.retiredAtDbMs !== undefined || version.retireReason !== undefined;
  exactKeys(version, retired
    ? [
        "credentialVersionId", "tenantId", "slotKind", "slotIdSha256", "origin",
        "encryptedSecretPresent", "secretKeyIdPresent", "customHeadersPresent",
        "endpointParametersPresent", "createdAtDbMs", "retiredAtDbMs", "retireReason",
      ]
    : [
        "credentialVersionId", "tenantId", "slotKind", "slotIdSha256", "origin",
        "encryptedSecretPresent", "secretKeyIdPresent", "customHeadersPresent",
        "endpointParametersPresent", "createdAtDbMs",
      ],
  "tenant credential version");
  digest(version.credentialVersionId, "tenant credential version id");
  tenantId(version.tenantId);
  enumValue(version.slotKind, TENANT_CREDENTIAL_SLOT_KINDS, "tenant credential slot kind");
  digest(version.slotIdSha256, "tenant credential slot id hash");
  enumValue(version.origin, TENANT_CREDENTIAL_ORIGINS, "tenant credential version origin");
  if (version.encryptedSecretPresent !== version.secretKeyIdPresent) {
    throw new Error("tenant credential secret envelope presence is inconsistent");
  }
  if (!version.encryptedSecretPresent
    && !version.customHeadersPresent
    && !version.endpointParametersPresent) {
    throw new Error("tenant credential version has no credential-bearing material");
  }
  if (version.slotKind === "tenant_auth_secret"
    && (!version.encryptedSecretPresent
      || version.customHeadersPresent
      || version.endpointParametersPresent)) {
    throw new Error("tenant auth credential version must describe only its encrypted secret");
  }
  timestamp(version.createdAtDbMs, "tenant credential version creation time");
  if (retired && (version.retiredAtDbMs === undefined || version.retireReason === undefined)) {
    throw new Error("tenant credential version retirement is incomplete");
  }
  if (version.retiredAtDbMs !== undefined) {
    timestamp(version.retiredAtDbMs, "tenant credential version retirement time");
    if (version.retiredAtDbMs < version.createdAtDbMs) {
      throw new Error("tenant credential version retired before creation");
    }
  }
  if (version.retireReason !== undefined) {
    enumValue(version.retireReason, TENANT_CREDENTIAL_RETIRE_REASONS, "retire reason");
  }
}

export function tenantCredentialVersionEvidenceSha256(
  version: TenantCredentialVersionBody,
): string {
  validateTenantCredentialVersionBody(version);
  return sha256([
    "tenant-credential-version-v1",
    version.credentialVersionId,
    version.tenantId,
    version.slotKind,
    version.slotIdSha256,
    version.origin,
    version.encryptedSecretPresent,
    version.secretKeyIdPresent,
    version.customHeadersPresent,
    version.endpointParametersPresent,
    version.createdAtDbMs,
    version.retiredAtDbMs ?? null,
    version.retireReason ?? null,
  ]);
}

export function validateTenantCredentialVersion(version: TenantCredentialVersion): void {
  const { evidenceSha256, ...body } = version;
  digest(evidenceSha256, "tenant credential version evidence");
  if (evidenceSha256 !== tenantCredentialVersionEvidenceSha256(body)) {
    throw new Error("tenant credential version evidence hash mismatch");
  }
}

export interface TenantCredentialTargetDispositionBody {
  credentialVersionId: string;
  tenantId: string;
  domain: TenantCredentialTargetDomain;
  disposition: TenantCredentialTargetDispositionKind;
  adapterProtocol?: string;
  targetReferenceCipherSha256?: string;
  targetReferenceKeyId?: string;
  targetReferenceSha256?: string;
  capturedAtDbMs: number;
}

export interface TenantCredentialTargetDisposition
  extends TenantCredentialTargetDispositionBody {
  evidenceSha256: string;
}

function targetReferencePresent(disposition: TenantCredentialTargetDispositionBody): boolean {
  const fields = [
    disposition.adapterProtocol,
    disposition.targetReferenceCipherSha256,
    disposition.targetReferenceKeyId,
    disposition.targetReferenceSha256,
  ];
  const present = fields.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== fields.length) {
    throw new Error("tenant credential target reference metadata is incomplete");
  }
  return present === fields.length;
}

export function validateTenantCredentialTargetDispositionBody(
  target: TenantCredentialTargetDispositionBody,
): void {
  const hasAnyReferenceField = target.adapterProtocol !== undefined
    || target.targetReferenceCipherSha256 !== undefined
    || target.targetReferenceKeyId !== undefined
    || target.targetReferenceSha256 !== undefined;
  exactKeys(target, hasAnyReferenceField
    ? [
        "credentialVersionId", "tenantId", "domain", "disposition", "adapterProtocol",
        "targetReferenceCipherSha256", "targetReferenceKeyId", "targetReferenceSha256",
        "capturedAtDbMs",
      ]
    : ["credentialVersionId", "tenantId", "domain", "disposition", "capturedAtDbMs"],
  "tenant credential target disposition");
  digest(target.credentialVersionId, "tenant credential target version id");
  tenantId(target.tenantId);
  enumValue(target.domain, TENANT_CREDENTIAL_TARGET_DOMAINS, "tenant credential target domain");
  enumValue(
    target.disposition,
    TENANT_CREDENTIAL_TARGET_DISPOSITIONS,
    "tenant credential target disposition",
  );
  timestamp(target.capturedAtDbMs, "tenant credential target capture time");
  const hasReference = targetReferencePresent(target);
  if (target.adapterProtocol !== undefined && !IDENTIFIER.test(target.adapterProtocol)) {
    throw new Error("tenant credential adapter protocol is invalid");
  }
  if (target.targetReferenceKeyId !== undefined && !IDENTIFIER.test(target.targetReferenceKeyId)) {
    throw new Error("tenant credential target reference key id is invalid");
  }
  if (target.targetReferenceCipherSha256 !== undefined) {
    digest(target.targetReferenceCipherSha256, "tenant credential target reference ciphertext hash");
  }
  if (target.targetReferenceSha256 !== undefined) {
    digest(target.targetReferenceSha256, "tenant credential target reference hash");
  }
  if ((target.disposition === "executable_ref"
      || target.disposition === "blocked_adapter_unconfigured") !== hasReference) {
    throw new Error("tenant credential target disposition and locator metadata disagree");
  }
  if (target.disposition === "blocked_no_locator" && target.domain !== "external_credential") {
    throw new Error("blocked_no_locator is only valid for external credentials");
  }
  if (target.disposition === "blocked_shared_local_key" && target.domain !== "kms_key") {
    throw new Error("blocked_shared_local_key is only valid for KMS targets");
  }
}

export function tenantCredentialTargetDispositionEvidenceSha256(
  target: TenantCredentialTargetDispositionBody,
): string {
  validateTenantCredentialTargetDispositionBody(target);
  return sha256([
    "tenant-credential-target-disposition-v1",
    target.credentialVersionId,
    target.tenantId,
    target.domain,
    target.disposition,
    target.adapterProtocol ?? null,
    target.targetReferenceCipherSha256 ?? null,
    target.targetReferenceKeyId ?? null,
    target.targetReferenceSha256 ?? null,
    target.capturedAtDbMs,
  ]);
}

export function validateTenantCredentialTargetDisposition(
  target: TenantCredentialTargetDisposition,
): void {
  const { evidenceSha256, ...body } = target;
  digest(evidenceSha256, "tenant credential target evidence");
  if (evidenceSha256 !== tenantCredentialTargetDispositionEvidenceSha256(body)) {
    throw new Error("tenant credential target evidence hash mismatch");
  }
}

/** Current storage has no remote revocation locator and uses a shared local envelope key. */
export function tenantCredentialCurrentTargetDisposition(
  version: Pick<
    TenantCredentialVersion,
    | "slotKind"
    | "origin"
    | "encryptedSecretPresent"
    | "customHeadersPresent"
    | "endpointParametersPresent"
  >,
  domain: TenantCredentialTargetDomain,
): Exclude<TenantCredentialTargetDispositionKind, "executable_ref" | "blocked_adapter_unconfigured"> {
  enumValue(version.slotKind, TENANT_CREDENTIAL_SLOT_KINDS, "tenant credential slot kind");
  enumValue(version.origin, TENANT_CREDENTIAL_ORIGINS, "tenant credential version origin");
  enumValue(domain, TENANT_CREDENTIAL_TARGET_DOMAINS, "tenant credential target domain");
  if (domain === "external_credential") {
    if (version.slotKind === "tenant_auth_secret") return "not_applicable";
    return version.origin === "legacy_observed"
      ? "blocked_legacy_history"
      : "blocked_no_locator";
  }
  if (!version.encryptedSecretPresent) return "not_applicable";
  return version.origin === "legacy_observed"
    ? "blocked_legacy_history"
    : "blocked_shared_local_key";
}

/**
 * A version's target rows are immutable once captured. Legacy and non-applicable shapes therefore
 * have exactly one valid disposition, while a newly managed version may either retain the safe
 * local blocker or carry a trusted executable reference captured in the same source transaction.
 * This predicate deliberately does not let an existing row transition between those shapes.
 */
export function tenantCredentialTargetDispositionMatchesVersion(
  version: Pick<
    TenantCredentialVersion,
    | "credentialVersionId"
    | "tenantId"
    | "slotKind"
    | "origin"
    | "encryptedSecretPresent"
    | "customHeadersPresent"
    | "endpointParametersPresent"
    | "createdAtDbMs"
  >,
  target: TenantCredentialTargetDisposition,
): boolean {
  validateTenantCredentialTargetDisposition(target);
  if (
    target.credentialVersionId !== version.credentialVersionId
    || target.tenantId !== version.tenantId
    || target.capturedAtDbMs !== version.createdAtDbMs
  ) return false;

  const baseline = tenantCredentialCurrentTargetDisposition(version, target.domain);
  if (target.disposition === baseline) return true;
  if (version.origin !== "managed_v1") return false;

  if (target.domain === "external_credential") {
    return version.slotKind === "provider_binding"
      && (target.disposition === "executable_ref"
        || target.disposition === "blocked_adapter_unconfigured");
  }
  return version.encryptedSecretPresent
    && (target.disposition === "executable_ref"
      || target.disposition === "blocked_adapter_unconfigured");
}

/** Permanent provider-slot CAS state; rows are updated monotonically and are never deleted. */
export interface TenantCredentialProviderSlotBody {
  tenantId: string;
  slotIdSha256: string;
  writeGeneration: number;
  sourcePresent: boolean;
  currentCredentialVersionId?: string;
  updatedAtDbMs: number;
}

export interface TenantCredentialProviderSlot extends TenantCredentialProviderSlotBody {
  evidenceSha256: string;
}

export function validateTenantCredentialProviderSlotBody(
  slot: TenantCredentialProviderSlotBody,
): void {
  exactKeys(slot, slot.currentCredentialVersionId === undefined
    ? ["tenantId", "slotIdSha256", "writeGeneration", "sourcePresent", "updatedAtDbMs"]
    : [
        "tenantId", "slotIdSha256", "writeGeneration", "sourcePresent",
        "currentCredentialVersionId", "updatedAtDbMs",
      ],
  "tenant credential provider slot");
  tenantId(slot.tenantId);
  digest(slot.slotIdSha256, "tenant credential provider slot hash");
  positive(slot.writeGeneration, "tenant credential provider slot generation");
  timestamp(slot.updatedAtDbMs, "tenant credential provider slot update time");
  if (!slot.sourcePresent && slot.currentCredentialVersionId !== undefined) {
    throw new Error("absent tenant credential provider source retains a current version");
  }
  if (slot.currentCredentialVersionId !== undefined) {
    digest(slot.currentCredentialVersionId, "tenant credential provider current version id");
  }
}

export function tenantCredentialProviderSlotEvidenceSha256(
  slot: TenantCredentialProviderSlotBody,
): string {
  validateTenantCredentialProviderSlotBody(slot);
  return sha256([
    "tenant-credential-provider-slot-v1",
    slot.tenantId,
    slot.slotIdSha256,
    slot.writeGeneration,
    slot.sourcePresent,
    slot.currentCredentialVersionId ?? null,
    slot.updatedAtDbMs,
  ]);
}

export function validateTenantCredentialProviderSlot(slot: TenantCredentialProviderSlot): void {
  const { evidenceSha256, ...body } = slot;
  digest(evidenceSha256, "tenant credential provider slot evidence");
  if (evidenceSha256 !== tenantCredentialProviderSlotEvidenceSha256(body)) {
    throw new Error("tenant credential provider slot evidence hash mismatch");
  }
}

export function tenantCredentialProviderSlotRootSha256(
  slots: readonly TenantCredentialProviderSlot[],
): string {
  for (const slot of slots) validateTenantCredentialProviderSlot(slot);
  return root("tenant-credential-provider-slot-root-v1", slots.map((item) => item.evidenceSha256));
}

export function tenantCredentialSubjectRootSha256(
  subjects: readonly TenantCredentialTrackingSubject[],
): string {
  for (const subject of subjects) validateTenantCredentialTrackingSubject(subject);
  return root("tenant-credential-subject-root-v1", subjects.map((item) => item.evidenceSha256));
}

export function tenantCredentialVersionRootSha256(
  versions: readonly TenantCredentialVersion[],
): string {
  for (const version of versions) validateTenantCredentialVersion(version);
  return root("tenant-credential-version-root-v1", versions.map((item) => item.evidenceSha256));
}

export function tenantCredentialTargetDispositionRootSha256(
  targets: readonly TenantCredentialTargetDisposition[],
): string {
  for (const target of targets) validateTenantCredentialTargetDisposition(target);
  return root(
    "tenant-credential-target-disposition-root-v1",
    targets.map((item) => item.evidenceSha256),
  );
}

export interface TenantCredentialLifecycleSnapshot {
  subject: TenantCredentialTrackingSubject;
  authSlot: TenantCredentialAuthSlot;
  providerSlots: readonly TenantCredentialProviderSlot[];
  versions: readonly TenantCredentialVersion[];
  targetDispositions: readonly TenantCredentialTargetDisposition[];
  subjectRootSha256: string;
  providerSlotRootSha256: string;
  authSlotRootSha256: string;
  versionRootSha256: string;
  targetDispositionRootSha256: string;
}

export function validateTenantCredentialLifecycleSnapshot(
  snapshot: TenantCredentialLifecycleSnapshot,
): void {
  exactKeys(snapshot, [
    "subject", "authSlot", "providerSlots", "versions", "targetDispositions", "subjectRootSha256",
    "providerSlotRootSha256", "authSlotRootSha256", "versionRootSha256",
    "targetDispositionRootSha256",
  ], "tenant credential lifecycle snapshot");
  validateTenantCredentialTrackingSubject(snapshot.subject);
  validateTenantCredentialAuthSlot(snapshot.authSlot);
  if (snapshot.authSlot.tenantId !== snapshot.subject.tenantId) {
    throw new Error("tenant credential snapshot contains a cross-tenant auth slot");
  }
  let previousSlot = "";
  for (const slot of snapshot.providerSlots) {
    validateTenantCredentialProviderSlot(slot);
    if (slot.tenantId !== snapshot.subject.tenantId) {
      throw new Error("tenant credential snapshot contains a cross-tenant provider slot");
    }
    if (slot.sourcePresent && slot.updatedAtDbMs < snapshot.subject.trackingStartedAtDbMs) {
      throw new Error("tenant credential provider slot predates subject tracking");
    }
    if (slot.slotIdSha256 <= previousSlot) {
      throw new Error("tenant credential snapshot provider slots are not strictly sorted");
    }
    previousSlot = slot.slotIdSha256;
  }
  const versionIds = new Set<string>();
  let previousVersion = "";
  for (const version of snapshot.versions) {
    validateTenantCredentialVersion(version);
    if (version.tenantId !== snapshot.subject.tenantId) {
      throw new Error("tenant credential snapshot contains a cross-tenant version");
    }
    if (version.createdAtDbMs < snapshot.subject.trackingStartedAtDbMs) {
      throw new Error("tenant credential version predates subject tracking");
    }
    if (versionIds.has(version.credentialVersionId)) {
      throw new Error("tenant credential snapshot contains a duplicate version");
    }
    if (version.credentialVersionId <= previousVersion) {
      throw new Error("tenant credential snapshot versions are not strictly sorted");
    }
    previousVersion = version.credentialVersionId;
    versionIds.add(version.credentialVersionId);
  }
  const targetsByVersion = new Map<string, Set<TenantCredentialTargetDomain>>();
  let previousTarget = "";
  for (const target of snapshot.targetDispositions) {
    validateTenantCredentialTargetDisposition(target);
    if (target.tenantId !== snapshot.subject.tenantId
      || !versionIds.has(target.credentialVersionId)) {
      throw new Error("tenant credential snapshot contains an orphan/cross-tenant target");
    }
    const sortKey = `${target.credentialVersionId}\u0000${target.domain}`;
    if (sortKey <= previousTarget) {
      throw new Error("tenant credential snapshot targets are not strictly sorted");
    }
    previousTarget = sortKey;
    const domains = targetsByVersion.get(target.credentialVersionId) ?? new Set();
    if (domains.has(target.domain)) throw new Error("duplicate credential target domain");
    domains.add(target.domain);
    targetsByVersion.set(target.credentialVersionId, domains);
  }
  for (const versionId of versionIds) {
    const domains = targetsByVersion.get(versionId);
    if (domains?.size !== TENANT_CREDENTIAL_TARGET_DOMAINS.length
      || TENANT_CREDENTIAL_TARGET_DOMAINS.some((domain) => !domains.has(domain))) {
      throw new Error("tenant credential version does not have exactly two target domains");
    }
  }
  const versionById = new Map(snapshot.versions.map((version) => [
    version.credentialVersionId,
    version,
  ]));
  for (const target of snapshot.targetDispositions) {
    const version = versionById.get(target.credentialVersionId);
    if (!version || !tenantCredentialTargetDispositionMatchesVersion(version, target)) {
      throw new Error("tenant credential target does not match its credential version");
    }
  }
  if (snapshot.authSlot.currentCredentialVersionId !== undefined) {
    const authVersion = versionById.get(snapshot.authSlot.currentCredentialVersionId);
    if (!authVersion
      || authVersion.slotKind !== "tenant_auth_secret"
      || authVersion.slotIdSha256 !== tenantCredentialSlotIdSha256(
        snapshot.subject.tenantId,
        "tenant_auth_secret",
        "tenant_auth_secret",
      )
      || authVersion.createdAtDbMs !== snapshot.authSlot.updatedAtDbMs
      || authVersion.retiredAtDbMs !== undefined) {
      throw new Error("tenant credential auth slot points at a non-current version");
    }
  }
  for (const slot of snapshot.providerSlots) {
    if (slot.currentCredentialVersionId === undefined) continue;
    const version = versionById.get(slot.currentCredentialVersionId);
    if (!version
      || version.slotKind !== "provider_binding"
      || version.slotIdSha256 !== slot.slotIdSha256
      || version.createdAtDbMs !== slot.updatedAtDbMs
      || version.retiredAtDbMs !== undefined) {
      throw new Error("tenant credential provider slot points at a non-current version");
    }
  }
  if (snapshot.subjectRootSha256 !== tenantCredentialSubjectRootSha256([snapshot.subject])
    || snapshot.providerSlotRootSha256
      !== tenantCredentialProviderSlotRootSha256(snapshot.providerSlots)
    || snapshot.authSlotRootSha256 !== tenantCredentialAuthSlotRootSha256([snapshot.authSlot])
    || snapshot.versionRootSha256 !== tenantCredentialVersionRootSha256(snapshot.versions)
    || snapshot.targetDispositionRootSha256
      !== tenantCredentialTargetDispositionRootSha256(snapshot.targetDispositions)) {
    throw new Error("tenant credential snapshot root mismatch");
  }
}

export interface TenantCredentialAuthSlotBody {
  tenantId: string;
  writeGeneration: number;
  sourcePresent: boolean;
  currentCredentialVersionId?: string;
  updatedAtDbMs: number;
}

export interface TenantCredentialAuthSlot extends TenantCredentialAuthSlotBody {
  evidenceSha256: string;
}

export function validateTenantCredentialAuthSlotBody(
  slot: TenantCredentialAuthSlotBody,
): void {
  exactKeys(slot, slot.currentCredentialVersionId === undefined
    ? ["tenantId", "writeGeneration", "sourcePresent", "updatedAtDbMs"]
    : [
        "tenantId", "writeGeneration", "sourcePresent", "currentCredentialVersionId",
        "updatedAtDbMs",
      ],
  "tenant credential auth slot");
  tenantId(slot.tenantId);
  count(slot.writeGeneration, "tenant credential auth write generation");
  timestamp(slot.updatedAtDbMs, "tenant credential auth update time");
  if (slot.sourcePresent !== (slot.currentCredentialVersionId !== undefined)) {
    throw new Error("tenant credential auth source and pointer disagree");
  }
  if (slot.sourcePresent && slot.writeGeneration === 0) {
    throw new Error("tenant credential auth source has no write generation");
  }
  if (slot.currentCredentialVersionId !== undefined) {
    digest(slot.currentCredentialVersionId, "tenant credential auth current version id");
  }
}

export function tenantCredentialAuthSlotEvidenceSha256(
  slot: TenantCredentialAuthSlotBody,
): string {
  validateTenantCredentialAuthSlotBody(slot);
  return sha256([
    "tenant-credential-auth-slot-v1",
    slot.tenantId,
    slot.writeGeneration,
    slot.sourcePresent,
    slot.currentCredentialVersionId ?? null,
    slot.updatedAtDbMs,
  ]);
}

export function validateTenantCredentialAuthSlot(slot: TenantCredentialAuthSlot): void {
  const { evidenceSha256, ...body } = slot;
  digest(evidenceSha256, "tenant credential auth slot evidence");
  if (evidenceSha256 !== tenantCredentialAuthSlotEvidenceSha256(body)) {
    throw new Error("tenant credential auth slot evidence hash mismatch");
  }
}

export function tenantCredentialAuthSlotRootSha256(
  slots: readonly TenantCredentialAuthSlot[],
): string {
  for (const slot of slots) validateTenantCredentialAuthSlot(slot);
  return root("tenant-credential-auth-slot-root-v1", slots.map((item) => item.evidenceSha256));
}

export interface TenantCredentialInventoryReceiptBody {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  scope: typeof TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE;
  t3aReceiptSha256: string;
  trackingCutoverEvidenceSha256: string;
  subjectCount: number;
  subjectRootSha256: string;
  providerSlotCount: number;
  providerSlotRootSha256: string;
  authSlotCount: number;
  authSlotRootSha256: string;
  versionCount: number;
  versionRootSha256: string;
  targetDispositionCount: number;
  targetDispositionRootSha256: string;
  externalCredentialBlockerCount: number;
  kmsKeyBlockerCount: number;
  legacyHistoryUnknownSubjectCount: number;
  /** Live provider rows whose three material-presence bits require a version pointer. */
  providerSourceCountBefore: number;
  /** The credential-bearing subset above that was bound to a current version. */
  providerSourcePointerCountBefore: number;
  authSecretPresentBefore: boolean;
  authSourcePointerPresentBefore: boolean;
  storeDbTimestampMs: number;
}

export interface TenantCredentialInventoryReceipt
  extends TenantCredentialInventoryReceiptBody {
  receiptSha256: string;
}

export function validateTenantCredentialInventoryReceiptBody(
  receipt: TenantCredentialInventoryReceiptBody,
): void {
  exactKeys(receipt, [
    "requestId", "tenantId", "subjectGeneration", "scope", "t3aReceiptSha256",
    "trackingCutoverEvidenceSha256", "subjectCount", "subjectRootSha256", "providerSlotCount",
    "providerSlotRootSha256", "authSlotCount", "authSlotRootSha256", "versionCount",
    "versionRootSha256", "targetDispositionCount", "targetDispositionRootSha256",
    "externalCredentialBlockerCount", "kmsKeyBlockerCount",
    "legacyHistoryUnknownSubjectCount", "providerSourceCountBefore",
    "providerSourcePointerCountBefore", "authSecretPresentBefore",
    "authSourcePointerPresentBefore", "storeDbTimestampMs",
  ], "tenant credential inventory receipt");
  if (!REQUEST_ID.test(receipt.requestId)) throw new Error("invalid credential inventory request id");
  tenantId(receipt.tenantId);
  positive(receipt.subjectGeneration, "credential inventory subject generation");
  if (receipt.scope !== TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE) {
    throw new Error("invalid credential inventory receipt scope");
  }
  for (const [value, name] of [
    [receipt.t3aReceiptSha256, "T3a receipt"],
    [receipt.trackingCutoverEvidenceSha256, "tracking cutover evidence"],
    [receipt.subjectRootSha256, "subject root"],
    [receipt.providerSlotRootSha256, "provider slot root"],
    [receipt.authSlotRootSha256, "auth slot root"],
    [receipt.versionRootSha256, "version root"],
    [receipt.targetDispositionRootSha256, "target disposition root"],
  ] as const) digest(value, `credential inventory ${name}`);
  for (const [value, name] of [
    [receipt.subjectCount, "subject count"],
    [receipt.providerSlotCount, "provider slot count"],
    [receipt.authSlotCount, "auth slot count"],
    [receipt.versionCount, "version count"],
    [receipt.targetDispositionCount, "target disposition count"],
    [receipt.externalCredentialBlockerCount, "external blocker count"],
    [receipt.kmsKeyBlockerCount, "KMS blocker count"],
    [receipt.legacyHistoryUnknownSubjectCount, "legacy history subject count"],
    [receipt.providerSourceCountBefore, "provider source count"],
    [receipt.providerSourcePointerCountBefore, "provider pointer count"],
  ] as const) count(value, `credential inventory ${name}`);
  if (receipt.subjectCount !== 1 || receipt.legacyHistoryUnknownSubjectCount > 1) {
    throw new Error("credential inventory requires one tenant coverage subject");
  }
  if (receipt.authSlotCount !== 1) {
    throw new Error("credential inventory requires one tenant auth slot");
  }
  if (!Number.isSafeInteger(receipt.versionCount * 2)
    || receipt.targetDispositionCount !== receipt.versionCount * 2) {
    throw new Error("credential inventory requires two target dispositions per version");
  }
  if (receipt.externalCredentialBlockerCount > receipt.versionCount
    || receipt.kmsKeyBlockerCount > receipt.versionCount) {
    throw new Error("credential inventory blocker count exceeds its domain count");
  }
  if (receipt.providerSourcePointerCountBefore !== receipt.providerSourceCountBefore) {
    throw new Error("credential inventory provider sources are not fully linked");
  }
  if (receipt.providerSourceCountBefore > receipt.providerSlotCount) {
    throw new Error("credential inventory provider sources exceed permanent provider slots");
  }
  if (receipt.authSourcePointerPresentBefore !== receipt.authSecretPresentBefore) {
    throw new Error("credential inventory auth source pointer is incomplete");
  }
  timestamp(receipt.storeDbTimestampMs, "credential inventory store timestamp");
}

export function tenantCredentialInventoryReceiptSha256(
  receipt: TenantCredentialInventoryReceiptBody,
): string {
  validateTenantCredentialInventoryReceiptBody(receipt);
  return sha256([
    "tenant-credential-inventory-receipt-v1",
    receipt.requestId,
    receipt.tenantId,
    receipt.subjectGeneration,
    receipt.scope,
    receipt.t3aReceiptSha256,
    receipt.trackingCutoverEvidenceSha256,
    receipt.subjectCount,
    receipt.subjectRootSha256,
    receipt.providerSlotCount,
    receipt.providerSlotRootSha256,
    receipt.authSlotCount,
    receipt.authSlotRootSha256,
    receipt.versionCount,
    receipt.versionRootSha256,
    receipt.targetDispositionCount,
    receipt.targetDispositionRootSha256,
    receipt.externalCredentialBlockerCount,
    receipt.kmsKeyBlockerCount,
    receipt.legacyHistoryUnknownSubjectCount,
    receipt.providerSourceCountBefore,
    receipt.providerSourcePointerCountBefore,
    receipt.authSecretPresentBefore,
    receipt.authSourcePointerPresentBefore,
    receipt.storeDbTimestampMs,
  ]);
}

export function validateTenantCredentialInventoryReceipt(
  receipt: TenantCredentialInventoryReceipt,
): void {
  const { receiptSha256, ...body } = receipt;
  digest(receiptSha256, "credential inventory receipt hash");
  if (receiptSha256 !== tenantCredentialInventoryReceiptSha256(body)) {
    throw new Error("credential inventory receipt hash mismatch");
  }
}

export interface CredentialLifecycleStore {
  readTenantCredentialTrackingCutover(): Promise<TenantCredentialTrackingCutoverRecord>;
  activateTenantCredentialTrackingCutover(
    input: ActivateTenantCredentialTrackingInput,
  ): Promise<TenantCredentialTrackingCutoverRecord>;
  getTenantCredentialInventorySnapshot(
    tenantId: string,
  ): Promise<TenantCredentialLifecycleSnapshot>;
  getTenantCredentialInventoryReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantCredentialInventoryReceipt | null>;
}
