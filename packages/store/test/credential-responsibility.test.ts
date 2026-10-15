import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as responsibility from "../src/credential-responsibility.js";
import { tenantCredentialSlotIdSha256, tenantCredentialVersionEvidenceSha256,
  tenantCredentialVersionRootSha256,
  tenantCredentialTargetDispositionEvidenceSha256, tenantCredentialInventoryReceiptSha256,
  TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE, type TenantCredentialVersion,
  type TenantCredentialTargetDisposition, type TenantCredentialInventoryReceipt } from "../src/credential-lifecycle.js";

// Synthetic codec/provenance tests only. No actual provider key, encryption,
// database provenance, remote revocation, or zeroization is proved here.
const sha = (label: string) => createHash("sha256").update(`responsibility-pure\0${label}`).digest("hex");
const requestId = "erase_00000000-0000-4000-8000-000000000001";
function secret() { return { ciphertext: Buffer.from("synthetic-cipher-envelope-not-a-provider-key"), keyId: "shared-envelope-key" }; }
function version(patch: Partial<Omit<TenantCredentialVersion, "evidenceSha256">> = {}): TenantCredentialVersion {
  const body = { credentialVersionId: sha("version"), tenantId: "tenant-responsibility",
    slotKind: "provider_binding" as const, slotIdSha256: tenantCredentialSlotIdSha256("tenant-responsibility", "provider_binding", "provider"),
    origin: "managed_v1" as const, encryptedSecretPresent: true, secretKeyIdPresent: true,
    customHeadersPresent: false, endpointParametersPresent: false, createdAtDbMs: 100, ...patch };
  return { ...body, evidenceSha256: tenantCredentialVersionEvidenceSha256(body) };
}
function target(v: TenantCredentialVersion, managed = false): TenantCredentialTargetDisposition {
  const body = { credentialVersionId: v.credentialVersionId, tenantId: v.tenantId,
    domain: "external_credential" as const, disposition: managed ? "executable_ref" as const : "blocked_no_locator" as const,
    ...(managed ? { adapterProtocol: "provider-target-v1", targetReferenceCipherSha256: sha("locator-cipher"),
      targetReferenceKeyId: "shared-locator-key", targetReferenceSha256: sha("locator") } : {}),
    capturedAtDbMs: v.createdAtDbMs };
  return { ...body, evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(body) };
}
function source(v = version(), managed = false) {
  const encrypted = secret();
  const input = { tenantId: v.tenantId, providerId: "provider", expectedSourceRevision: null, secret: encrypted };
  const token = responsibility.createProviderByokSecretAdmission(input);
  const admissionSha256 = responsibility.assertProviderByokSecretAdmission(token, input);
  const externalTarget = target(v, managed);
  const value = responsibility.createTenantCredentialResponsibilitySource({ version: v, externalTarget,
    sourceRevision: 1, expectedSourceRevision: null,
    secretEnvelopeSha256: responsibility.providerByokSecretEnvelopeSha256(encrypted), newSecretAdmissionSha256: admissionSha256 });
  return { value, encrypted, input, token, externalTarget, version: v };
}
function inventory(versions: readonly TenantCredentialVersion[]): TenantCredentialInventoryReceipt {
  const body = { requestId, tenantId: "tenant-responsibility", subjectGeneration: 1,
    scope: TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE, t3aReceiptSha256: sha("t3a"),
    trackingCutoverEvidenceSha256: sha("cutover"), subjectCount: 1, subjectRootSha256: sha("subject"),
    providerSlotCount: versions.length, providerSlotRootSha256: sha("provider-slot"), authSlotCount: 1,
    authSlotRootSha256: sha("auth-slot"), versionCount: versions.length, versionRootSha256: tenantCredentialVersionRootSha256(versions),
    targetDispositionCount: versions.length * 2, targetDispositionRootSha256: sha("targets"),
    externalCredentialBlockerCount: versions.length, kmsKeyBlockerCount: versions.length,
    legacyHistoryUnknownSubjectCount: 0, providerSourceCountBefore: versions.length,
    providerSourcePointerCountBefore: versions.length, authSecretPresentBefore: false,
    authSourcePointerPresentBefore: false, storeDbTimestampMs: 200 };
  return { ...body, receiptSha256: tenantCredentialInventoryReceiptSha256(body) };
}

describe("BYOK original encrypted-object admission", () => {
  it("binds the original encrypted object, exact owner/revision and envelope without serializing secret bytes", () => {
    const f = source();
    expect(Object.isFrozen(f.token)).toBe(true);
    expect(responsibility.assertProviderByokSecretAdmission(f.token, f.input)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f.token)).toBe('{"kind":"provider-byok-secret-admission-v1"}');
    expect(JSON.stringify(f.value)).not.toContain(f.encrypted.ciphertext.toString("utf8"));
    expect(JSON.stringify(f.value)).not.toContain(f.encrypted.keyId);
  });
  it.each(["literal token", "cloned token", "copied secret"] as const)("rejects %s even with equal public bytes", (kind) => {
    const f = source();
    const token = kind === "literal token" ? Object.freeze({ kind: f.token.kind })
      : kind === "cloned token" ? structuredClone(f.token) : f.token;
    const input = kind === "copied secret" ? { ...f.input,
      secret: { ciphertext: Buffer.from(f.encrypted.ciphertext), keyId: f.encrypted.keyId } } : f.input;
    expect(() => responsibility.assertProviderByokSecretAdmission(token, input))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it.each(["tenantId", "providerId", "expectedSourceRevision"] as const)("rejects changed %s", (field) => {
    const f = source();
    const input = { ...f.input, [field]: field === "expectedSourceRevision" ? 1 : "foreign" };
    expect(() => responsibility.assertProviderByokSecretAdmission(f.token, input))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it.each(["ciphertext", "keyId"] as const)("rejects mutation of admitted %s", (field) => {
    const f = source();
    if (field === "ciphertext") f.encrypted.ciphertext[0] = f.encrypted.ciphertext[0]! ^ 1;
    else f.encrypted.keyId = "other-key";
    expect(() => responsibility.assertProviderByokSecretAdmission(f.token, f.input))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it("rejects accessor input without invoking it or echoing its content", () => {
    let calls = 0;
    const input = { tenantId: "tenant-responsibility", providerId: "provider", expectedSourceRevision: null,
      get secret(): responsibility.ProviderByokEncryptedSecret { calls++; throw new Error("private-canary-must-not-escape"); } };
    expect(() => responsibility.createProviderByokSecretAdmission(input))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
    expect(calls).toBe(0);
  });
});

describe("per-material versioned responsibility evidence", () => {
  it("records only the admitted API key as customer managed, not header/endpoint or shared-key destruction", () => {
    const f = source(version({ customHeadersPresent: true, endpointParametersPresent: true }));
    expect(f.value).toMatchObject({ apiKeyResponsibility: "customer_managed", apiKeySource: "new_byok",
      customHeadersResponsibility: "unknown", endpointParametersResponsibility: "unknown",
      envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" });
  });
  it("does not treat managed_v1 or a material-preserving config edit as fresh provenance", () => {
    const v = version();
    expect(responsibility.createTenantCredentialResponsibilitySource({ version: v, externalTarget: target(v),
      sourceRevision: 1, expectedSourceRevision: null, secretEnvelopeSha256: sha("legacy-envelope"),
      newSecretAdmissionSha256: null })).toMatchObject({ apiKeySource: "unknown", apiKeyResponsibility: "unknown" });
  });
  it("inherits only the exact previous sidecar and envelope, not an unrelated owner/version", () => {
    const f = source(), next = version({ credentialVersionId: sha("version2"), createdAtDbMs: 120 });
    const currentTarget = target(next);
    const inherited = responsibility.createTenantCredentialResponsibilitySource({ version: next, externalTarget: currentTarget,
      sourceRevision: 2, expectedSourceRevision: 1, secretEnvelopeSha256: f.value.secretEnvelopeSha256,
      newSecretAdmissionSha256: null, previousSource: f.value });
    expect(inherited).toMatchObject({ apiKeySource: "inherited_byok", apiKeyResponsibility: "customer_managed",
      inheritedFromCredentialVersionId: f.version.credentialVersionId, inheritedFromResponsibilityReceiptSha256: f.value.receiptSha256 });
    expect(() => responsibility.assertTenantCredentialResponsibilitySourceRelations(inherited, next, currentTarget))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
    const unrelated = source(version({ credentialVersionId: sha("unrelated-version") }));
    expect(() => responsibility.assertTenantCredentialResponsibilitySourceRelations(inherited, next, currentTarget, unrelated.value))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it("keeps trusted executable target disposition pending rather than overriding it with customer responsibility", () => {
    const f = source(version(), true);
    expect(f.value.apiKeyResponsibility).toBe("unknown");
    expect(f.value.externalTargetEvidenceSha256).toBe(f.externalTarget.evidenceSha256);
    expect(f.externalTarget.disposition).toBe("executable_ref");
  });
  it("keeps immutable source identity when the original 0026 version later retires", () => {
    const f = source();
    const retired = version({ retiredAtDbMs: 120, retireReason: "replaced" });
    expect(retired.evidenceSha256).not.toBe(f.version.evidenceSha256);
    expect(responsibility.tenantCredentialResponsibilityVersionIdentitySha256(retired))
      .toBe(f.value.versionIdentitySha256);
    responsibility.assertTenantCredentialResponsibilitySourceRelations(f.value, retired, f.externalTarget);
  });
  it("seals exact known plus unknown entries and explicit empty, never missing-as-empty", () => {
    const f = source(), unknown = version({ credentialVersionId: sha("legacy-version"), origin: "legacy_observed" });
    const makeEntry = (v: TenantCredentialVersion, source: responsibility.TenantCredentialResponsibilitySource | null) =>
      responsibility.createTenantCredentialResponsibilitySnapshotEntry({ requestId, tenantId: v.tenantId,
        subjectGeneration: 1, t1FenceSha256: sha("fence"), version: v, source, capturedAtDbMs: 200 });
    const entries = [makeEntry(f.version, f.value), makeEntry(unknown, null)];
    const receipt = responsibility.createTenantCredentialResponsibilitySnapshotReceipt({
      t1FenceSha256: sha("fence"), inventory: inventory([f.version, unknown]), versions: [f.version, unknown], entries });
    expect(receipt).toMatchObject({ versionCount: 2, entryCount: 2, customerManagedApiKeyCount: 1,
      unknownMaterialCount: 1, platformSharedKeyCount: 2, allDomainsComplete: false, externalAuthorityVerified: false });
    expect(responsibility.tenantCredentialResponsibilitySnapshotEntryRootSha256([...entries].reverse()))
      .toBe(receipt.entryRootSha256);
    expect(() => responsibility.createTenantCredentialResponsibilitySnapshotReceipt({
      t1FenceSha256: sha("fence"), inventory: inventory([f.version]), versions: [f.version], entries: [] }))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
    const empty = responsibility.createTenantCredentialResponsibilitySnapshotReceipt({
      t1FenceSha256: sha("fence"), inventory: inventory([]), versions: [], entries: [] });
    expect(empty).toMatchObject({ versionCount: 0, entryCount: 0, customerManagedApiKeyCount: 0, unknownMaterialCount: 0 });
    expect(empty.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects same-count replacement versions, evidence or a copied inventory root", () => {
    const f = source(), replacement = version({ credentialVersionId: sha("replacement") });
    const entry = responsibility.createTenantCredentialResponsibilitySnapshotEntry({ requestId,
      tenantId: f.version.tenantId, subjectGeneration: 1, t1FenceSha256: sha("fence"),
      version: f.version, source: f.value, capturedAtDbMs: 200 });
    for (const versions of [[replacement], [version({ retiredAtDbMs: 150, retireReason: "replaced" })]]) {
      expect(() => responsibility.createTenantCredentialResponsibilitySnapshotReceipt({
        t1FenceSha256: sha("fence"), inventory: inventory([f.version]), versions, entries: [entry] }))
        .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
    }
    expect(() => responsibility.createTenantCredentialResponsibilitySnapshotReceipt({
      t1FenceSha256: sha("fence"), inventory: inventory([replacement]), versions: [replacement], entries: [entry] }))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it("does not retroactively turn legacy_observed into an admitted BYOK source", () => {
    expect(() => source(version({ origin: "legacy_observed" })))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
  it("does not classify a tenant authentication secret as an external model vendor API key", () => {
    const v = version({ slotKind: "tenant_auth_secret",
      slotIdSha256: tenantCredentialSlotIdSha256("tenant-responsibility", "tenant_auth_secret", "tenant_auth_secret") });
    const entry = responsibility.createTenantCredentialResponsibilitySnapshotEntry({ requestId,
      tenantId: v.tenantId, subjectGeneration: 1, t1FenceSha256: sha("fence"), version: v,
      source: null, capturedAtDbMs: 200 });
    expect(entry).toMatchObject({ sourceKind: "unknown", apiKeyResponsibility: "not_applicable",
      envelopeKeyResponsibility: "platform_shared_not_tenant_deletable" });
  });
  it.each(["capture time", "legacy disposition"] as const)("rejects a rehashed target with a mismatched version %s", (field) => {
    const f = source();
    const { evidenceSha256: ignored, ...original } = f.externalTarget; void ignored;
    const body = field === "capture time" ? { ...original, capturedAtDbMs: f.version.createdAtDbMs + 1 }
      : { ...original, disposition: "blocked_legacy_history" as const };
    const altered = { ...body, evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(body) };
    expect(altered.evidenceSha256).not.toBe(f.externalTarget.evidenceSha256);
    expect(() => responsibility.createTenantCredentialResponsibilitySource({
      version: f.version, externalTarget: altered, sourceRevision: 1, expectedSourceRevision: null,
      secretEnvelopeSha256: f.value.secretEnvelopeSha256, newSecretAdmissionSha256: f.value.newSecretAdmissionSha256,
    })).toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
});

describe("readiness exact erasure identity (pure shape, not store authority)", () => {
  const readiness = (): responsibility.TenantCredentialResponsibilityReadiness => ({
    schema: "tenant-credential-responsibility-readiness-v1", tenantId: "tenant-responsibility", requestId,
    status: "local_responsibility_observed", t1FenceSha256: sha("fence"), t3aReceiptSha256: sha("t3a"),
    t3bReceiptSha256: sha("t3b"), responsibilityReceiptSha256: sha("responsibility"),
    localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized",
    remoteCredentials: "customer_responsibility_recorded", sharedKeys: "platform_shared_not_tenant_deletable",
    backupCopies: "unknown", otherCopies: "unknown", versionCount: 1, customerManagedApiKeyCount: 1,
    unknownMaterialCount: 0, executionReady: false, externalAuthorityVerified: false,
    allDomainsComplete: false, contentPurgeExecuted: false,
  });
  it("accepts the exact canonical v4 erasure request identity", () => {
    expect(() => responsibility.validateTenantCredentialResponsibilityReadiness(readiness())).not.toThrow();
  });
  it.each(["ordinary-id", requestId.replace("erase_", "ERASE_"), requestId.replace("-4000-", "-5000-"),
    requestId.replace("-8000-", "-0000-"), `${requestId} `])("rejects noncanonical request identity %s", (invalidId) => {
    expect(() => responsibility.validateTenantCredentialResponsibilityReadiness({ ...readiness(), requestId: invalidId }))
      .toThrow(responsibility.TenantCredentialResponsibilityIntegrityError);
  });
});
