import { describe, expect, it } from "vitest";
import {
  TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE,
  tenantCredentialAuthSlotEvidenceSha256,
  tenantCredentialAuthSlotRootSha256,
  tenantCredentialCurrentTargetDisposition,
  tenantCredentialInventoryReceiptSha256,
  tenantCredentialProviderSlotEvidenceSha256,
  tenantCredentialProviderSlotRootSha256,
  tenantCredentialSlotIdSha256,
  tenantCredentialSubjectEvidenceSha256,
  tenantCredentialSubjectRootSha256,
  tenantCredentialTargetDispositionEvidenceSha256,
  tenantCredentialTargetDispositionRootSha256,
  tenantCredentialTrackingCutoverEvidenceSha256,
  tenantCredentialVersionEvidenceSha256,
  tenantCredentialVersionId,
  tenantCredentialVersionRootSha256,
  validateTenantCredentialInventoryReceipt,
  validateTenantCredentialLifecycleSnapshot,
  validateTenantCredentialProviderSlot,
  validateTenantCredentialTargetDispositionBody,
  validateTenantCredentialTrackingCutoverRecord,
  validateTenantCredentialVersionBody,
  type TenantCredentialInventoryReceipt,
  type TenantCredentialAuthSlot,
  type TenantCredentialProviderSlot,
  type TenantCredentialTargetDisposition,
  type TenantCredentialTrackingSubject,
  type TenantCredentialVersion,
} from "../src/index.js";

const TENANT_ID = "tenant-credential-contract";
const REQUEST_ID = "erase_12345678-1234-4123-8123-123456789abc";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function fixture() {
  const subjectBody = {
    tenantId: TENANT_ID,
    trackingStartedAtDbMs: 10,
    historyStatus: "legacy_history_unknown" as const,
    origin: "legacy_observed" as const,
  };
  const subject: TenantCredentialTrackingSubject = {
    ...subjectBody,
    evidenceSha256: tenantCredentialSubjectEvidenceSha256(subjectBody),
  };
  const slotIdSha256 = tenantCredentialSlotIdSha256(
    TENANT_ID,
    "provider_binding",
    "provider-a",
  );
  const credentialVersionId = tenantCredentialVersionId({
    tenantId: TENANT_ID,
    slotKind: "provider_binding",
    slotId: "provider-a",
    createdAtDbMs: 10,
    nonce: "nonce:credential:00000001",
  });
  const versionBody = {
    credentialVersionId,
    tenantId: TENANT_ID,
    slotKind: "provider_binding" as const,
    slotIdSha256,
    origin: "legacy_observed" as const,
    encryptedSecretPresent: true,
    secretKeyIdPresent: true,
    customHeadersPresent: false,
    endpointParametersPresent: false,
    createdAtDbMs: 10,
  };
  const version: TenantCredentialVersion = {
    ...versionBody,
    evidenceSha256: tenantCredentialVersionEvidenceSha256(versionBody),
  };
  const targets = (["external_credential", "kms_key"] as const).map((domain) => {
    const body = {
      credentialVersionId,
      tenantId: TENANT_ID,
      domain,
      disposition: "blocked_legacy_history" as const,
      capturedAtDbMs: 10,
    };
    return {
      ...body,
      evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(body),
    } satisfies TenantCredentialTargetDisposition;
  });
  const slotBody = {
    tenantId: TENANT_ID,
    slotIdSha256,
    writeGeneration: 1,
    sourcePresent: true,
    currentCredentialVersionId: credentialVersionId,
    updatedAtDbMs: 10,
  };
  const slot: TenantCredentialProviderSlot = {
    ...slotBody,
    evidenceSha256: tenantCredentialProviderSlotEvidenceSha256(slotBody),
  };
  const authSlotBody = {
    tenantId: TENANT_ID,
    writeGeneration: 0,
    sourcePresent: false,
    updatedAtDbMs: 10,
  };
  const authSlot: TenantCredentialAuthSlot = {
    ...authSlotBody,
    evidenceSha256: tenantCredentialAuthSlotEvidenceSha256(authSlotBody),
  };
  return { subject, version, targets, slot, authSlot };
}

describe("credential lifecycle contract", () => {
  it("binds tenant coverage, permanent provider CAS slots, versions, and both domains", () => {
    const { subject, version, targets, slot, authSlot } = fixture();
    const snapshot = {
      subject,
      authSlot,
      providerSlots: [slot],
      versions: [version],
      targetDispositions: targets,
      subjectRootSha256: tenantCredentialSubjectRootSha256([subject]),
      providerSlotRootSha256: tenantCredentialProviderSlotRootSha256([slot]),
      authSlotRootSha256: tenantCredentialAuthSlotRootSha256([authSlot]),
      versionRootSha256: tenantCredentialVersionRootSha256([version]),
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(targets),
    };
    expect(() => validateTenantCredentialLifecycleSnapshot(snapshot)).not.toThrow();

    expect(() => validateTenantCredentialLifecycleSnapshot({
      ...snapshot,
      targetDispositions: targets.slice(0, 1),
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(
        targets.slice(0, 1),
      ),
    })).toThrow(/exactly two target domains/);

    const weakenedTargets = targets.map((target) => {
      if (target.domain !== "external_credential") return target;
      const { evidenceSha256: _evidence, ...body } = target;
      const weakened = { ...body, disposition: "not_applicable" as const };
      return {
        ...weakened,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(weakened),
      };
    });
    expect(() => validateTenantCredentialLifecycleSnapshot({
      ...snapshot,
      targetDispositions: weakenedTargets,
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(weakenedTargets),
    })).toThrow(/does not match its credential version/);

    const shiftedTargets = targets.map((target) => {
      const { evidenceSha256: _evidence, ...body } = target;
      const shifted = { ...body, capturedAtDbMs: body.capturedAtDbMs + 1 };
      return {
        ...shifted,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(shifted),
      };
    });
    expect(() => validateTenantCredentialLifecycleSnapshot({
      ...snapshot,
      targetDispositions: shiftedTargets,
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(shiftedTargets),
    })).toThrow(/does not match its credential version/);

    const { evidenceSha256: _versionEvidence, ...versionBody } = version;
    const shiftedVersionBody = {
      ...versionBody,
      createdAtDbMs: versionBody.createdAtDbMs + 1,
    };
    const shiftedVersion: TenantCredentialVersion = {
      ...shiftedVersionBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(shiftedVersionBody),
    };
    const versionAlignedTargets = targets.map((target) => {
      const { evidenceSha256: _evidence, ...body } = target;
      const shifted = { ...body, capturedAtDbMs: shiftedVersion.createdAtDbMs };
      return {
        ...shifted,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(shifted),
      };
    });
    expect(() => validateTenantCredentialLifecycleSnapshot({
      ...snapshot,
      versions: [shiftedVersion],
      targetDispositions: versionAlignedTargets,
      versionRootSha256: tenantCredentialVersionRootSha256([shiftedVersion]),
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(
        versionAlignedTargets,
      ),
    })).toThrow(/provider slot points at a non-current version/);

    const { evidenceSha256: _subjectEvidence, ...subjectBody } = subject;
    const lateSubjectBody = {
      ...subjectBody,
      trackingStartedAtDbMs: version.createdAtDbMs + 1,
    };
    const lateSubject: TenantCredentialTrackingSubject = {
      ...lateSubjectBody,
      evidenceSha256: tenantCredentialSubjectEvidenceSha256(lateSubjectBody),
    };
    expect(() => validateTenantCredentialLifecycleSnapshot({
      ...snapshot,
      subject: lateSubject,
      subjectRootSha256: tenantCredentialSubjectRootSha256([lateSubject]),
    })).toThrow(/predates subject tracking/);
  });

  it("binds an auth pointer to the canonical auth slot digest", () => {
    const { subject, version } = fixture();
    const { evidenceSha256: _versionEvidence, ...versionBody } = version;
    const wrongAuthBody = {
      ...versionBody,
      slotKind: "tenant_auth_secret" as const,
      // Intentionally retain the provider-slot digest while recomputing every downstream hash.
    };
    const wrongAuthVersion: TenantCredentialVersion = {
      ...wrongAuthBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(wrongAuthBody),
    };
    const targets = (["external_credential", "kms_key"] as const).map((domain) => {
      const body = {
        credentialVersionId: wrongAuthVersion.credentialVersionId,
        tenantId: TENANT_ID,
        domain,
        disposition: domain === "external_credential"
          ? "not_applicable" as const
          : "blocked_legacy_history" as const,
        capturedAtDbMs: wrongAuthVersion.createdAtDbMs,
      };
      return {
        ...body,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(body),
      } satisfies TenantCredentialTargetDisposition;
    });
    const authSlotBody = {
      tenantId: TENANT_ID,
      writeGeneration: 1,
      sourcePresent: true,
      currentCredentialVersionId: wrongAuthVersion.credentialVersionId,
      updatedAtDbMs: 10,
    };
    const authSlot: TenantCredentialAuthSlot = {
      ...authSlotBody,
      evidenceSha256: tenantCredentialAuthSlotEvidenceSha256(authSlotBody),
    };
    expect(() => validateTenantCredentialLifecycleSnapshot({
      subject,
      authSlot,
      providerSlots: [],
      versions: [wrongAuthVersion],
      targetDispositions: targets,
      subjectRootSha256: tenantCredentialSubjectRootSha256([subject]),
      providerSlotRootSha256: tenantCredentialProviderSlotRootSha256([]),
      authSlotRootSha256: tenantCredentialAuthSlotRootSha256([authSlot]),
      versionRootSha256: tenantCredentialVersionRootSha256([wrongAuthVersion]),
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(targets),
    })).toThrow(/auth slot points at a non-current version/);
  });

  it("binds the current auth version creation time to the auth slot update time", () => {
    const { subject } = fixture();
    const slotIdSha256 = tenantCredentialSlotIdSha256(
      TENANT_ID,
      "tenant_auth_secret",
      "tenant_auth_secret",
    );
    const credentialVersionId = tenantCredentialVersionId({
      tenantId: TENANT_ID,
      slotKind: "tenant_auth_secret",
      slotId: "tenant_auth_secret",
      createdAtDbMs: 11,
      nonce: "nonce:credential:auth-time",
    });
    const versionBody = {
      credentialVersionId,
      tenantId: TENANT_ID,
      slotKind: "tenant_auth_secret" as const,
      slotIdSha256,
      origin: "managed_v1" as const,
      encryptedSecretPresent: true,
      secretKeyIdPresent: true,
      customHeadersPresent: false,
      endpointParametersPresent: false,
      createdAtDbMs: 11,
    };
    const version: TenantCredentialVersion = {
      ...versionBody,
      evidenceSha256: tenantCredentialVersionEvidenceSha256(versionBody),
    };
    const targets = (["external_credential", "kms_key"] as const).map((domain) => {
      const body = {
        credentialVersionId,
        tenantId: TENANT_ID,
        domain,
        disposition: tenantCredentialCurrentTargetDisposition(version, domain),
        capturedAtDbMs: version.createdAtDbMs,
      };
      return {
        ...body,
        evidenceSha256: tenantCredentialTargetDispositionEvidenceSha256(body),
      } satisfies TenantCredentialTargetDisposition;
    });
    const authSlotBody = {
      tenantId: TENANT_ID,
      writeGeneration: 1,
      sourcePresent: true,
      currentCredentialVersionId: credentialVersionId,
      updatedAtDbMs: 10,
    };
    const authSlot: TenantCredentialAuthSlot = {
      ...authSlotBody,
      evidenceSha256: tenantCredentialAuthSlotEvidenceSha256(authSlotBody),
    };
    expect(() => validateTenantCredentialLifecycleSnapshot({
      subject,
      authSlot,
      providerSlots: [],
      versions: [version],
      targetDispositions: targets,
      subjectRootSha256: tenantCredentialSubjectRootSha256([subject]),
      providerSlotRootSha256: tenantCredentialProviderSlotRootSha256([]),
      authSlotRootSha256: tenantCredentialAuthSlotRootSha256([authSlot]),
      versionRootSha256: tenantCredentialVersionRootSha256([version]),
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(targets),
    })).toThrow(/auth slot points at a non-current version/);
  });

  it("never upgrades today's missing locators or shared local key to executable", () => {
    const { version } = fixture();
    expect(tenantCredentialCurrentTargetDisposition(
      version,
      "external_credential",
    )).toBe("blocked_legacy_history");
    expect(tenantCredentialCurrentTargetDisposition(
      { ...version, origin: "managed_v1" },
      "external_credential",
    )).toBe("blocked_no_locator");
    expect(tenantCredentialCurrentTargetDisposition(
      { ...version, origin: "managed_v1" },
      "kms_key",
    )).toBe("blocked_shared_local_key");
  });

  it("requires complete encrypted locator metadata for executable references", () => {
    const { version } = fixture();
    expect(() => validateTenantCredentialTargetDispositionBody({
      credentialVersionId: version.credentialVersionId,
      tenantId: TENANT_ID,
      domain: "external_credential",
      disposition: "executable_ref",
      capturedAtDbMs: 10,
    })).toThrow(/locator metadata disagree/);
    expect(() => validateTenantCredentialTargetDispositionBody({
      credentialVersionId: version.credentialVersionId,
      tenantId: TENANT_ID,
      domain: "external_credential",
      disposition: "executable_ref",
      adapterProtocol: "provider-revoke-v1",
      targetReferenceCipherSha256: DIGEST_A,
      targetReferenceKeyId: "tracking-ref-v1",
      targetReferenceSha256: DIGEST_B,
      capturedAtDbMs: 10,
    })).not.toThrow();
  });

  it("rejects secret/config/header/baseUrl fields instead of hashing their values", () => {
    const { version } = fixture();
    for (const forbidden of ["secret", "config", "header", "baseUrl"] as const) {
      expect(() => validateTenantCredentialVersionBody({
        ...version,
        [forbidden]: "must-not-enter-the-ledger",
      } as never)).toThrow(/unknown or missing fields/);
    }
  });

  it("binds dormant/active cutover and the T3a inventory sidecar", () => {
    expect(() => validateTenantCredentialTrackingCutoverRecord({
      controlGeneration: 0,
    })).not.toThrow();
    const { subject, version, targets, slot, authSlot } = fixture();
    const cutoverBody = {
      activatedAtDbMs: 10,
      subjectCount: 1,
      subjectRootSha256: tenantCredentialSubjectRootSha256([subject]),
      providerSlotCount: 1,
      providerSlotRootSha256: tenantCredentialProviderSlotRootSha256([slot]),
      authSlotCount: 1,
      authSlotRootSha256: tenantCredentialAuthSlotRootSha256([authSlot]),
      versionCount: 1,
      versionRootSha256: tenantCredentialVersionRootSha256([version]),
      targetDispositionCount: 2,
      targetDispositionRootSha256: tenantCredentialTargetDispositionRootSha256(targets),
    };
    const cutoverEvidence = tenantCredentialTrackingCutoverEvidenceSha256(cutoverBody);
    expect(() => validateTenantCredentialTrackingCutoverRecord({
      controlGeneration: 1,
      ...cutoverBody,
      evidenceSha256: cutoverEvidence,
    })).not.toThrow();

    const receiptBody = {
      requestId: REQUEST_ID,
      tenantId: TENANT_ID,
      subjectGeneration: 1,
      scope: TENANT_CREDENTIAL_INVENTORY_RECEIPT_SCOPE,
      t3aReceiptSha256: DIGEST_A,
      trackingCutoverEvidenceSha256: cutoverEvidence,
      subjectCount: 1,
      subjectRootSha256: cutoverBody.subjectRootSha256,
      providerSlotCount: 1,
      providerSlotRootSha256: cutoverBody.providerSlotRootSha256,
      authSlotCount: 1,
      authSlotRootSha256: cutoverBody.authSlotRootSha256,
      versionCount: 1,
      versionRootSha256: cutoverBody.versionRootSha256,
      targetDispositionCount: 2,
      targetDispositionRootSha256: cutoverBody.targetDispositionRootSha256,
      externalCredentialBlockerCount: 1,
      kmsKeyBlockerCount: 1,
      legacyHistoryUnknownSubjectCount: 1,
      providerSourceCountBefore: 1,
      providerSourcePointerCountBefore: 1,
      authSecretPresentBefore: false,
      authSourcePointerPresentBefore: false,
      storeDbTimestampMs: 20,
    };
    const receipt: TenantCredentialInventoryReceipt = {
      ...receiptBody,
      receiptSha256: tenantCredentialInventoryReceiptSha256(receiptBody),
    };
    expect(() => validateTenantCredentialInventoryReceipt(receipt)).not.toThrow();
    expect(() => validateTenantCredentialInventoryReceipt({
      ...receipt,
      providerSourcePointerCountBefore: 0,
    })).toThrow(/provider sources are not fully linked/);
  });

  it("keeps provider generations positive and an absent slot detached", () => {
    const { slot } = fixture();
    expect(() => validateTenantCredentialProviderSlot(slot)).not.toThrow();
    expect(() => validateTenantCredentialProviderSlot({
      ...slot,
      sourcePresent: false,
    })).toThrow(/retains a current version/);
  });
});
