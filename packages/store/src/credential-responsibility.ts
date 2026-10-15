import { createHash } from "node:crypto";
import type { ProviderConfig } from "@agent-service/protocol";
import {
  tenantCredentialSlotIdSha256,
  validateTenantCredentialVersion,
  validateTenantCredentialTargetDisposition,
  tenantCredentialTargetDispositionMatchesVersion,
  validateTenantCredentialInventoryReceipt,
  tenantCredentialVersionRootSha256,
  type ProviderCredentialTargetReferenceWrite,
  type TenantCredentialVersion,
  type TenantCredentialTargetDisposition,
  type TenantCredentialInventoryReceipt,
} from "./credential-lifecycle.js";

export const TENANT_CREDENTIAL_RESPONSIBILITY_SOURCE_SCOPE = "tenant-credential-responsibility-source-v1" as const;
export const TENANT_CREDENTIAL_RESPONSIBILITY_ENTRY_SCOPE = "tenant-credential-responsibility-snapshot-entry-v1" as const;
export const TENANT_CREDENTIAL_RESPONSIBILITY_RECEIPT_SCOPE = "tenant-credential-responsibility-snapshot-v1" as const;
export class TenantCredentialResponsibilityIntegrityError extends Error {
  constructor() { super("tenant credential responsibility evidence is invalid"); this.name = "TenantCredentialResponsibilityIntegrityError"; }
}
function fail(): never { throw new TenantCredentialResponsibilityIntegrityError(); }
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
  }
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail();
}
function count(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) fail();
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}
function hash(scope: string, value: unknown): string {
  return createHash("sha256").update(scope).update("\0").update(canonical(value)).digest("hex");
}
export interface ProviderByokEncryptedSecret { ciphertext: Buffer; keyId: string }
export interface ProviderByokSecretAdmission { readonly kind: "provider-byok-secret-admission-v1" }
export interface ProviderByokSecretAdmissionInput {
  tenantId: string; providerId: string; expectedSourceRevision: number | null; secret: ProviderByokEncryptedSecret;
}
const admissions = new WeakMap<ProviderByokSecretAdmission, {
  tenantId: string; providerId: string; expectedSourceRevision: number | null;
  secret: ProviderByokEncryptedSecret; envelopeSha256: string; admissionSha256: string;
}>();
export function providerByokSecretEnvelopeSha256(secret: ProviderByokEncryptedSecret): string {
  closed(secret, ["ciphertext", "keyId"]);
  if (!Buffer.isBuffer(secret.ciphertext) || !secret.ciphertext.length || secret.ciphertext.length > 65_536) fail();
  identity(secret.keyId);
  return hash("provider-byok-secret-envelope-v1", {
    ciphertextSha256: createHash("sha256").update(secret.ciphertext).digest("hex"),
    keyIdSha256: hash("provider-byok-envelope-key-id-v1", secret.keyId),
  });
}
function validateAdmissionInput(input: ProviderByokSecretAdmissionInput): void {
  closed(input, ["tenantId", "providerId", "expectedSourceRevision", "secret"]);
  identity(input.tenantId); identity(input.providerId);
  if (input.expectedSourceRevision !== null) count(input.expectedSourceRevision);
  providerByokSecretEnvelopeSha256(input.secret);
}
/** Internal ProviderService boundary after encryption. No public request flag is authority. */
export function createProviderByokSecretAdmission(input: ProviderByokSecretAdmissionInput): ProviderByokSecretAdmission {
  validateAdmissionInput(input);
  const envelopeSha256 = providerByokSecretEnvelopeSha256(input.secret);
  const admissionSha256 = hash("provider-byok-secret-admission-v1", {
    tenantId: input.tenantId, slotIdSha256: tenantCredentialSlotIdSha256(input.tenantId, "provider_binding", input.providerId),
    expectedSourceRevision: input.expectedSourceRevision, secretEnvelopeSha256: envelopeSha256,
  });
  const token = Object.freeze({ kind: "provider-byok-secret-admission-v1" as const });
  admissions.set(token, { ...input, envelopeSha256, admissionSha256 });
  return token;
}
/** Check the original token AND original encrypted-secret object before any clone. */
export function assertProviderByokSecretAdmission(token: ProviderByokSecretAdmission,
  input: ProviderByokSecretAdmissionInput): string {
  validateAdmissionInput(input);
  const stored = admissions.get(token);
  if (!stored || !Object.isFrozen(token) || stored.secret !== input.secret
    || stored.tenantId !== input.tenantId || stored.providerId !== input.providerId
    || stored.expectedSourceRevision !== input.expectedSourceRevision
    || stored.envelopeSha256 !== providerByokSecretEnvelopeSha256(input.secret)) fail();
  return stored.admissionSha256;
}
export interface UpsertProviderConfigWithResponsibilityInput {
  config: ProviderConfig;
  secret?: ProviderByokEncryptedSecret;
  expectedSourceRevision: number | null;
  targetReference?: ProviderCredentialTargetReferenceWrite;
  secretAdmission?: ProviderByokSecretAdmission;
}
export type TenantCredentialApiKeyResponsibility = "customer_managed" | "unknown" | "not_applicable";
export type TenantCredentialMaterialResponsibility = "unknown" | "not_applicable";
export interface TenantCredentialResponsibilityMaterials {
  apiKeyResponsibility: TenantCredentialApiKeyResponsibility;
  customHeadersResponsibility: TenantCredentialMaterialResponsibility;
  endpointParametersResponsibility: TenantCredentialMaterialResponsibility;
  envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" | "not_applicable";
}
export interface TenantCredentialResponsibilitySource extends TenantCredentialResponsibilityMaterials {
  scope: typeof TENANT_CREDENTIAL_RESPONSIBILITY_SOURCE_SCOPE;
  tenantId: string; credentialVersionId: string; slotKind: "provider_binding"; slotIdSha256: string;
  sourceRevision: number; expectedSourceRevision: number | null; versionIdentitySha256: string;
  secretEnvelopeSha256: string | null; newSecretAdmissionSha256: string | null;
  inheritedFromCredentialVersionId: string | null; inheritedFromResponsibilityReceiptSha256: string | null;
  apiKeySource: "new_byok" | "inherited_byok" | "unknown" | "not_applicable";
  externalTargetEvidenceSha256: string; recordedAtDbMs: number; receiptSha256: string;
}
const MATERIAL_KEYS = ["apiKeyResponsibility", "customHeadersResponsibility", "endpointParametersResponsibility", "envelopeKeyResponsibility"] as const;
const SOURCE_KEYS = ["scope", "tenantId", "credentialVersionId", "slotKind", "slotIdSha256", "sourceRevision",
  "expectedSourceRevision", "versionIdentitySha256", "secretEnvelopeSha256", "newSecretAdmissionSha256",
  "inheritedFromCredentialVersionId", "inheritedFromResponsibilityReceiptSha256", "apiKeySource",
  "externalTargetEvidenceSha256", "recordedAtDbMs", "receiptSha256", ...MATERIAL_KEYS] as const;
function materials(version: TenantCredentialVersion): TenantCredentialResponsibilityMaterials {
  return { apiKeyResponsibility: version.slotKind === "provider_binding" && version.encryptedSecretPresent ? "unknown" : "not_applicable",
    customHeadersResponsibility: version.customHeadersPresent ? "unknown" : "not_applicable",
    endpointParametersResponsibility: version.endpointParametersPresent ? "unknown" : "not_applicable",
    envelopeKeyResponsibility: version.encryptedSecretPresent ? "platform_shared_not_tenant_deletable" : "not_applicable" };
}
function validateMaterials(value: TenantCredentialResponsibilityMaterials): void {
  if (!["customer_managed", "unknown", "not_applicable"].includes(value.apiKeyResponsibility)
    || !["unknown", "not_applicable"].includes(value.customHeadersResponsibility)
    || !["unknown", "not_applicable"].includes(value.endpointParametersResponsibility)
    || !["platform_shared_not_tenant_deletable", "not_applicable"].includes(value.envelopeKeyResponsibility)) fail();
}
/** Retirement is mutable in 0026; the responsibility binding never re-signs that old receipt. */
export function tenantCredentialResponsibilityVersionIdentitySha256(version: TenantCredentialVersion): string {
  try { validateTenantCredentialVersion(version); } catch { fail(); }
  return hash("tenant-credential-responsibility-version-identity-v1", {
    credentialVersionId: version.credentialVersionId, tenantId: version.tenantId,
    slotKind: version.slotKind, slotIdSha256: version.slotIdSha256, origin: version.origin,
    encryptedSecretPresent: version.encryptedSecretPresent, secretKeyIdPresent: version.secretKeyIdPresent,
    customHeadersPresent: version.customHeadersPresent, endpointParametersPresent: version.endpointParametersPresent,
    createdAtDbMs: version.createdAtDbMs,
  });
}
function receiptMatches(value: { scope: string; receiptSha256: string }): void {
  digest(value.receiptSha256); const { receiptSha256, ...body } = value;
  if (receiptSha256 !== hash(value.scope, body)) fail();
}
export function validateTenantCredentialResponsibilitySource(value: TenantCredentialResponsibilitySource): void {
  closed(value, SOURCE_KEYS); validateMaterials(value);
  if (value.scope !== TENANT_CREDENTIAL_RESPONSIBILITY_SOURCE_SCOPE || value.slotKind !== "provider_binding") fail();
  identity(value.tenantId);
  for (const field of ["credentialVersionId", "slotIdSha256", "versionIdentitySha256", "externalTargetEvidenceSha256"] as const) digest(value[field]);
  count(value.sourceRevision); if (value.sourceRevision < 1) fail(); count(value.recordedAtDbMs);
  if (value.expectedSourceRevision !== null) count(value.expectedSourceRevision);
  if (value.sourceRevision !== (value.expectedSourceRevision ?? 0) + 1) fail();
  for (const field of ["secretEnvelopeSha256", "newSecretAdmissionSha256", "inheritedFromCredentialVersionId", "inheritedFromResponsibilityReceiptSha256"] as const) {
    if (value[field] !== null) digest(value[field]);
  }
  if (!["new_byok", "inherited_byok", "unknown", "not_applicable"].includes(value.apiKeySource)) fail();
  const inherited = value.apiKeySource === "inherited_byok";
  if (inherited !== (value.inheritedFromCredentialVersionId !== null)
    || inherited !== (value.inheritedFromResponsibilityReceiptSha256 !== null)) fail();
  const admitted = value.apiKeySource === "new_byok" || inherited;
  if (admitted !== (value.newSecretAdmissionSha256 !== null)
    || ((value.apiKeySource === "not_applicable") !== (value.secretEnvelopeSha256 === null))
    || (value.apiKeyResponsibility === "customer_managed" && !admitted)) fail();
  receiptMatches(value);
}
export function assertTenantCredentialResponsibilitySourceRelations(source: TenantCredentialResponsibilitySource,
  version: TenantCredentialVersion, target: TenantCredentialTargetDisposition,
  previous?: TenantCredentialResponsibilitySource): void {
  validateTenantCredentialResponsibilitySource(source);
  try { validateTenantCredentialVersion(version); validateTenantCredentialTargetDisposition(target); } catch { fail(); }
  if (source.tenantId !== version.tenantId || source.credentialVersionId !== version.credentialVersionId
    || source.slotKind !== version.slotKind || source.slotIdSha256 !== version.slotIdSha256
    || source.versionIdentitySha256 !== tenantCredentialResponsibilityVersionIdentitySha256(version)
    || source.recordedAtDbMs !== version.createdAtDbMs || target.tenantId !== version.tenantId
    || target.credentialVersionId !== version.credentialVersionId || target.domain !== "external_credential"
    || source.externalTargetEvidenceSha256 !== target.evidenceSha256) fail();
  if (!tenantCredentialTargetDispositionMatchesVersion(version, target)) fail();
  const expected = materials(version);
  for (const field of ["customHeadersResponsibility", "endpointParametersResponsibility", "envelopeKeyResponsibility"] as const) {
    if (source[field] !== expected[field]) fail();
  }
  if (!version.encryptedSecretPresent) {
    if (source.apiKeySource !== "not_applicable" || source.apiKeyResponsibility !== "not_applicable") fail();
  } else if (source.apiKeySource === "not_applicable" || source.apiKeyResponsibility === "not_applicable") fail();
  if (source.apiKeyResponsibility === "customer_managed"
    && (target.disposition === "executable_ref" || target.disposition === "blocked_adapter_unconfigured")) fail();
  if (["new_byok", "inherited_byok"].includes(source.apiKeySource) && version.origin !== "managed_v1") fail();
  if (source.apiKeySource === "new_byok") {
    const expectedAdmission = hash("provider-byok-secret-admission-v1", {
      tenantId: source.tenantId, slotIdSha256: source.slotIdSha256,
      expectedSourceRevision: source.expectedSourceRevision, secretEnvelopeSha256: source.secretEnvelopeSha256,
    });
    if (source.newSecretAdmissionSha256 !== expectedAdmission) fail();
  }
  if (source.apiKeySource === "inherited_byok") {
    if (!previous) fail(); validateTenantCredentialResponsibilitySource(previous);
    if (previous.tenantId !== source.tenantId || previous.slotIdSha256 !== source.slotIdSha256
      || previous.credentialVersionId !== source.inheritedFromCredentialVersionId
      || previous.receiptSha256 !== source.inheritedFromResponsibilityReceiptSha256
      || previous.sourceRevision !== source.expectedSourceRevision
      || previous.secretEnvelopeSha256 !== source.secretEnvelopeSha256
      || previous.newSecretAdmissionSha256 !== source.newSecretAdmissionSha256
      || !["new_byok", "inherited_byok"].includes(previous.apiKeySource)
      || (source.apiKeyResponsibility === "customer_managed" && previous.apiKeyResponsibility !== "customer_managed")) fail();
  }
}
export interface CreateTenantCredentialResponsibilitySourceInput {
  version: TenantCredentialVersion; externalTarget: TenantCredentialTargetDisposition;
  sourceRevision: number; expectedSourceRevision: number | null;
  secretEnvelopeSha256: string | null; newSecretAdmissionSha256: string | null;
  previousSource?: TenantCredentialResponsibilitySource;
}
export function createTenantCredentialResponsibilitySource(input: CreateTenantCredentialResponsibilitySourceInput): TenantCredentialResponsibilitySource {
  const v = input.version, p = input.previousSource;
  const inherited = input.newSecretAdmissionSha256 === null && v.encryptedSecretPresent && p
    && p.secretEnvelopeSha256 === input.secretEnvelopeSha256 && ["new_byok", "inherited_byok"].includes(p.apiKeySource);
  const sourceKind = !v.encryptedSecretPresent ? "not_applicable" as const
    : input.newSecretAdmissionSha256 !== null ? "new_byok" as const : inherited ? "inherited_byok" as const : "unknown" as const;
  const managedTarget = ["executable_ref", "blocked_adapter_unconfigured"].includes(input.externalTarget.disposition);
  const body: Omit<TenantCredentialResponsibilitySource, "receiptSha256"> = {
    scope: TENANT_CREDENTIAL_RESPONSIBILITY_SOURCE_SCOPE, tenantId: v.tenantId,
    credentialVersionId: v.credentialVersionId, slotKind: "provider_binding", slotIdSha256: v.slotIdSha256,
    sourceRevision: input.sourceRevision, expectedSourceRevision: input.expectedSourceRevision,
    versionIdentitySha256: tenantCredentialResponsibilityVersionIdentitySha256(v),
    secretEnvelopeSha256: input.secretEnvelopeSha256,
    newSecretAdmissionSha256: input.newSecretAdmissionSha256 ?? (inherited ? p.newSecretAdmissionSha256 : null),
    inheritedFromCredentialVersionId: inherited ? p.credentialVersionId : null,
    inheritedFromResponsibilityReceiptSha256: inherited ? p.receiptSha256 : null,
    apiKeySource: sourceKind, ...materials(v),
    apiKeyResponsibility: !v.encryptedSecretPresent ? "not_applicable"
      : !managedTarget && (sourceKind === "new_byok" || inherited && p.apiKeyResponsibility === "customer_managed") ? "customer_managed" : "unknown",
    externalTargetEvidenceSha256: input.externalTarget.evidenceSha256, recordedAtDbMs: v.createdAtDbMs,
  };
  const source = Object.freeze({ ...body, receiptSha256: hash(body.scope, body) });
  assertTenantCredentialResponsibilitySourceRelations(source, v, input.externalTarget, inherited ? p : undefined);
  return source;
}
export interface TenantCredentialResponsibilitySnapshotEntry extends TenantCredentialResponsibilityMaterials {
  scope: typeof TENANT_CREDENTIAL_RESPONSIBILITY_ENTRY_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; t1FenceSha256: string;
  credentialVersionId: string; slotKind: "provider_binding" | "tenant_auth_secret"; slotIdSha256: string;
  versionIdentitySha256: string; versionEvidenceSha256: string;
  responsibilitySourceReceiptSha256: string | null; sourceKind: "recorded" | "unknown";
  capturedAtDbMs: number; receiptSha256: string;
}
const ENTRY_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration", "t1FenceSha256", "credentialVersionId",
  "slotKind", "slotIdSha256", "versionIdentitySha256", "versionEvidenceSha256", "responsibilitySourceReceiptSha256",
  "sourceKind", "capturedAtDbMs", "receiptSha256", ...MATERIAL_KEYS] as const;
function requestIdentity(value: { requestId: string; tenantId: string; subjectGeneration: number; t1FenceSha256: string }): void {
  if (typeof value.requestId !== "string" || !/^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)) fail();
  identity(value.tenantId); count(value.subjectGeneration); if (!value.subjectGeneration) fail(); digest(value.t1FenceSha256);
}
export function validateTenantCredentialResponsibilitySnapshotEntry(value: TenantCredentialResponsibilitySnapshotEntry): void {
  closed(value, ENTRY_KEYS); requestIdentity(value); validateMaterials(value);
  if (value.scope !== TENANT_CREDENTIAL_RESPONSIBILITY_ENTRY_SCOPE
    || !["provider_binding", "tenant_auth_secret"].includes(value.slotKind)
    || !["recorded", "unknown"].includes(value.sourceKind)
    || ((value.sourceKind === "recorded") !== (value.responsibilitySourceReceiptSha256 !== null))) fail();
  for (const field of ["credentialVersionId", "slotIdSha256", "versionIdentitySha256", "versionEvidenceSha256"] as const) digest(value[field]);
  if (value.responsibilitySourceReceiptSha256 !== null) digest(value.responsibilitySourceReceiptSha256);
  if (value.sourceKind === "unknown" && value.apiKeyResponsibility === "customer_managed") fail();
  count(value.capturedAtDbMs); receiptMatches(value);
}
export function createTenantCredentialResponsibilitySnapshotEntry(input: {
  requestId: string; tenantId: string; subjectGeneration: number; t1FenceSha256: string;
  version: TenantCredentialVersion; source: TenantCredentialResponsibilitySource | null; capturedAtDbMs: number;
}): TenantCredentialResponsibilitySnapshotEntry {
  const { version: v, source, ...base } = input;
  if (source) validateTenantCredentialResponsibilitySource(source);
  if (v.tenantId !== base.tenantId || (source && (source.credentialVersionId !== v.credentialVersionId
    || source.versionIdentitySha256 !== tenantCredentialResponsibilityVersionIdentitySha256(v)))) fail();
  const body: Omit<TenantCredentialResponsibilitySnapshotEntry, "receiptSha256"> = {
    scope: TENANT_CREDENTIAL_RESPONSIBILITY_ENTRY_SCOPE, ...base, credentialVersionId: v.credentialVersionId,
    slotKind: v.slotKind, slotIdSha256: v.slotIdSha256,
    versionIdentitySha256: tenantCredentialResponsibilityVersionIdentitySha256(v), versionEvidenceSha256: v.evidenceSha256,
    responsibilitySourceReceiptSha256: source?.receiptSha256 ?? null, sourceKind: source ? "recorded" : "unknown",
    ...materials(v), ...(source ? Object.fromEntries(MATERIAL_KEYS.map((field) => [field, source[field]])) : {}),
  };
  if (base.capturedAtDbMs < Math.max(v.createdAtDbMs, v.retiredAtDbMs ?? 0)) fail();
  const result = Object.freeze({ ...body, receiptSha256: hash(body.scope, body) });
  validateTenantCredentialResponsibilitySnapshotEntry(result); return result;
}
export interface TenantCredentialResponsibilitySnapshotReceipt {
  scope: typeof TENANT_CREDENTIAL_RESPONSIBILITY_RECEIPT_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; t1FenceSha256: string;
  t3aReceiptSha256: string; credentialInventoryReceiptSha256: string;
  versionCount: number; versionRootSha256: string; entryCount: number; entryRootSha256: string;
  customerManagedApiKeyCount: number; unknownMaterialCount: number; platformSharedKeyCount: number;
  capturedAtDbMs: number; executionReady: false; externalAuthorityVerified: false;
  allDomainsComplete: false; contentPurgeExecuted: false; receiptSha256: string;
}
const SAFETY = { executionReady: false, externalAuthorityVerified: false, allDomainsComplete: false, contentPurgeExecuted: false } as const;
function assertSafety(value: typeof SAFETY): void { for (const key of Object.keys(SAFETY) as (keyof typeof SAFETY)[]) if (value[key] !== false) fail(); }
const RECEIPT_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration", "t1FenceSha256", "t3aReceiptSha256",
  "credentialInventoryReceiptSha256", "versionCount", "versionRootSha256", "entryCount", "entryRootSha256",
  "customerManagedApiKeyCount", "unknownMaterialCount", "platformSharedKeyCount", "capturedAtDbMs", "receiptSha256", ...Object.keys(SAFETY)] as const;
export function tenantCredentialResponsibilitySnapshotEntryRootSha256(entries: readonly TenantCredentialResponsibilitySnapshotEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.credentialVersionId < b.credentialVersionId ? -1 : a.credentialVersionId > b.credentialVersionId ? 1 : 0);
  const ids = new Set<string>();
  for (const entry of sorted) { validateTenantCredentialResponsibilitySnapshotEntry(entry); if (ids.has(entry.credentialVersionId)) fail(); ids.add(entry.credentialVersionId); }
  return hash("tenant-credential-responsibility-snapshot-root-v1", sorted.map((row) => row.receiptSha256));
}
export function validateTenantCredentialResponsibilitySnapshotReceipt(value: TenantCredentialResponsibilitySnapshotReceipt): void {
  closed(value, RECEIPT_KEYS); requestIdentity(value); assertSafety(value);
  if (value.scope !== TENANT_CREDENTIAL_RESPONSIBILITY_RECEIPT_SCOPE) fail();
  for (const field of ["t3aReceiptSha256", "credentialInventoryReceiptSha256", "versionRootSha256", "entryRootSha256"] as const) digest(value[field]);
  for (const field of ["versionCount", "entryCount", "customerManagedApiKeyCount", "unknownMaterialCount", "platformSharedKeyCount", "capturedAtDbMs"] as const) count(value[field]);
  if (value.entryCount !== value.versionCount || value.customerManagedApiKeyCount > value.entryCount
    || value.platformSharedKeyCount > value.entryCount || value.unknownMaterialCount > value.entryCount * 3) fail();
  receiptMatches(value);
}
export function createTenantCredentialResponsibilitySnapshotReceipt(input: {
  t1FenceSha256: string; inventory: TenantCredentialInventoryReceipt;
  versions: readonly TenantCredentialVersion[];
  entries: readonly TenantCredentialResponsibilitySnapshotEntry[];
}): TenantCredentialResponsibilitySnapshotReceipt {
  const { inventory, entries, versions } = input;
  try { validateTenantCredentialInventoryReceipt(inventory); } catch { fail(); }
  const versionById = new Map<string, TenantCredentialVersion>();
  for (const version of versions) {
    try { validateTenantCredentialVersion(version); } catch { fail(); }
    if (version.tenantId !== inventory.tenantId || versionById.has(version.credentialVersionId)) fail();
    versionById.set(version.credentialVersionId, version);
  }
  if (versions.length !== inventory.versionCount
    || tenantCredentialVersionRootSha256(versions) !== inventory.versionRootSha256 || entries.length !== versions.length) fail();
  const seen = new Set<string>();
  for (const entry of entries) {
    const version = versionById.get(entry.credentialVersionId);
    if (!version || seen.has(entry.credentialVersionId) || entry.versionEvidenceSha256 !== version.evidenceSha256
      || entry.versionIdentitySha256 !== tenantCredentialResponsibilityVersionIdentitySha256(version)
      || entry.slotKind !== version.slotKind || entry.slotIdSha256 !== version.slotIdSha256
      || entry.tenantId !== version.tenantId) fail();
    seen.add(entry.credentialVersionId);
    const expected = materials(version);
    for (const field of ["customHeadersResponsibility", "endpointParametersResponsibility", "envelopeKeyResponsibility"] as const) {
      if (entry[field] !== expected[field]) fail();
    }
    if (expected.apiKeyResponsibility === "not_applicable" && entry.apiKeyResponsibility !== "not_applicable") fail();
  }
  const body = { scope: TENANT_CREDENTIAL_RESPONSIBILITY_RECEIPT_SCOPE,
    requestId: inventory.requestId, tenantId: inventory.tenantId, subjectGeneration: inventory.subjectGeneration,
    t1FenceSha256: input.t1FenceSha256, t3aReceiptSha256: inventory.t3aReceiptSha256,
    credentialInventoryReceiptSha256: inventory.receiptSha256, versionCount: inventory.versionCount,
    versionRootSha256: inventory.versionRootSha256, entryCount: entries.length,
    entryRootSha256: tenantCredentialResponsibilitySnapshotEntryRootSha256(entries),
    customerManagedApiKeyCount: entries.filter((row) => row.apiKeyResponsibility === "customer_managed").length,
    unknownMaterialCount: entries.reduce((n, row) => n + Number(row.apiKeyResponsibility === "unknown")
      + Number(row.customHeadersResponsibility === "unknown") + Number(row.endpointParametersResponsibility === "unknown"), 0),
    platformSharedKeyCount: entries.filter((row) => row.envelopeKeyResponsibility === "platform_shared_not_tenant_deletable").length,
    capturedAtDbMs: inventory.storeDbTimestampMs, ...SAFETY };
  for (const entry of entries) if (entry.requestId !== body.requestId || entry.tenantId !== body.tenantId
    || entry.subjectGeneration !== body.subjectGeneration || entry.t1FenceSha256 !== body.t1FenceSha256
    || entry.capturedAtDbMs !== body.capturedAtDbMs) fail();
  const result = Object.freeze({ ...body, receiptSha256: hash(body.scope, body) });
  validateTenantCredentialResponsibilitySnapshotReceipt(result); return result;
}
export interface TenantCredentialResponsibilityReadiness {
  schema: "tenant-credential-responsibility-readiness-v1"; tenantId: string; requestId: string;
  status: "unknown" | "awaiting_local_clear" | "awaiting_runtime_drain" | "local_responsibility_observed";
  t1FenceSha256: string; t3aReceiptSha256: string | null; t3bReceiptSha256: string | null;
  responsibilityReceiptSha256: string | null;
  localDatabase: "unknown" | "not_cleared" | "cleared";
  trackedRuntimeReferences: "unknown" | "not_drained" | "dropped_not_zeroized";
  remoteCredentials: "unknown" | "customer_responsibility_recorded" | "not_applicable";
  sharedKeys: "platform_shared_not_tenant_deletable"; backupCopies: "unknown"; otherCopies: "unknown";
  versionCount: number | null; customerManagedApiKeyCount: number | null; unknownMaterialCount: number | null;
  executionReady: false; externalAuthorityVerified: false; allDomainsComplete: false; contentPurgeExecuted: false;
}
export function validateTenantCredentialResponsibilityReadiness(value: TenantCredentialResponsibilityReadiness): void {
  closed(value, ["schema", "tenantId", "requestId", "status", "t1FenceSha256", "t3aReceiptSha256", "t3bReceiptSha256",
    "responsibilityReceiptSha256", "localDatabase", "trackedRuntimeReferences", "remoteCredentials", "sharedKeys",
    "backupCopies", "otherCopies", "versionCount", "customerManagedApiKeyCount", "unknownMaterialCount", ...Object.keys(SAFETY)]);
  if (value.schema !== "tenant-credential-responsibility-readiness-v1") fail();
  identity(value.tenantId);
  if (typeof value.requestId !== "string" || !/^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)) fail();
  digest(value.t1FenceSha256); assertSafety(value);
  for (const field of ["t3aReceiptSha256", "t3bReceiptSha256", "responsibilityReceiptSha256"] as const) if (value[field] !== null) digest(value[field]);
  for (const field of ["versionCount", "customerManagedApiKeyCount", "unknownMaterialCount"] as const) if (value[field] !== null) count(value[field]);
  if (!["unknown", "awaiting_local_clear", "awaiting_runtime_drain", "local_responsibility_observed"].includes(value.status)
    || !["unknown", "not_cleared", "cleared"].includes(value.localDatabase)
    || !["unknown", "not_drained", "dropped_not_zeroized"].includes(value.trackedRuntimeReferences)
    || !["unknown", "customer_responsibility_recorded", "not_applicable"].includes(value.remoteCredentials)
    || value.sharedKeys !== "platform_shared_not_tenant_deletable" || value.backupCopies !== "unknown" || value.otherCopies !== "unknown") fail();
  if (value.responsibilityReceiptSha256 === null && (value.versionCount !== null || value.customerManagedApiKeyCount !== null
    || value.unknownMaterialCount !== null || value.status !== "unknown")) fail();
  if (value.localDatabase === "cleared" && value.t3aReceiptSha256 === null) fail();
  if (value.trackedRuntimeReferences === "dropped_not_zeroized" && (value.t3aReceiptSha256 === null || value.t3bReceiptSha256 === null)) fail();
  if (value.status === "local_responsibility_observed" && (value.localDatabase !== "cleared"
    || value.trackedRuntimeReferences !== "dropped_not_zeroized" || value.unknownMaterialCount !== 0
    || value.responsibilityReceiptSha256 === null || value.remoteCredentials === "unknown"
    || value.versionCount === null || value.customerManagedApiKeyCount === null)) fail();
  if (value.responsibilityReceiptSha256 !== null && (value.t3aReceiptSha256 === null
    || value.versionCount === null || value.customerManagedApiKeyCount === null || value.unknownMaterialCount === null)) fail();
  if (value.customerManagedApiKeyCount !== null && value.versionCount !== null
    && value.customerManagedApiKeyCount > value.versionCount) fail();
  if (value.remoteCredentials === "customer_responsibility_recorded"
    && (value.customerManagedApiKeyCount === null || value.customerManagedApiKeyCount < 1
      || value.unknownMaterialCount !== 0)) fail();
  if (value.remoteCredentials === "not_applicable"
    && (value.customerManagedApiKeyCount !== 0 || value.unknownMaterialCount !== 0)) fail();
}
export interface TenantCredentialResponsibilityStore {
  getTenantCredentialResponsibilityReadiness(tenantId: string, requestId: string): Promise<TenantCredentialResponsibilityReadiness | null>;
}
