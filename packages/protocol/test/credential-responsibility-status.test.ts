import { describe, expect, it } from "vitest";
import { TenantCredentialResponsibilityStatus, TenantErasureRequest, TenantErasureStatusResponse } from "../src/index.js";

const base = { id: "erase_12345678-1234-4123-8123-123456789abc", scope: "tenant" as const,
  tenantId: "tenant", generation: 1, status: "gated" as const, createdAtMs: 1, updatedAtMs: 1 };
const observed = { schema: "tenant-credential-responsibility-status-v1", status: "local_responsibility_observed",
  localDatabase: "cleared", trackedRuntimeReferences: "dropped_not_zeroized",
  remoteCredentials: "customer_responsibility_recorded", sharedKeys: "platform_shared_not_tenant_deletable",
  backupCopies: "unknown", otherCopies: "unknown", versionCount: 1, customerManagedApiKeyCount: 1,
  unknownMaterialCount: 0, executionReady: false, externalAuthorityVerified: false,
  allDomainsComplete: false, contentPurgeExecuted: false };

describe("GET-only credential responsibility protocol", () => {
  it("accepts an absent old-runner observation without inventing zero or success", () => {
    expect(TenantErasureStatusResponse.parse(base)).toEqual(base);
    expect(TenantErasureStatusResponse.parse(base)).not.toHaveProperty("credentialResponsibility");
    expect(TenantErasureRequest.parse(base)).toEqual(base);
  });
  it("allows the closed observation only on GET, not POST/replay", () => {
    const response = { ...base, credentialResponsibility: observed };
    expect(TenantErasureStatusResponse.safeParse(response).success).toBe(true);
    expect(TenantErasureRequest.safeParse(response).success).toBe(false);
  });
  it("preserves nullable unknown counters and fixed unresolved-copy/safety scope", () => {
    expect(TenantCredentialResponsibilityStatus.parse({ ...observed, status: "unknown", localDatabase: "unknown",
      trackedRuntimeReferences: "unknown", remoteCredentials: "unknown", versionCount: null,
      customerManagedApiKeyCount: null, unknownMaterialCount: null })).toMatchObject({
      status: "unknown", versionCount: null, customerManagedApiKeyCount: null, unknownMaterialCount: null,
      backupCopies: "unknown", allDomainsComplete: false,
    });
  });
  it.each([
    { secret: "private" }, { tenantId: "private" }, { t1FenceSha256: "0".repeat(64) },
    { sharedKeys: "destroyed" }, { backupCopies: "cleared" }, { externalAuthorityVerified: true },
    { allDomainsComplete: true }, { contentPurgeExecuted: true }, { executionReady: true },
    { localDatabase: "unknown" }, { trackedRuntimeReferences: "not_drained" },
    { unknownMaterialCount: null }, { customerManagedApiKeyCount: 0 }, { versionCount: 0 },
    { status: "unknown", versionCount: null },
    { status: "unknown", customerManagedApiKeyCount: null },
    { status: "unknown", unknownMaterialCount: null },
    { versionCount: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects private fields, authority claims and contradictory completion observations: %j", (patch) => {
    expect(TenantCredentialResponsibilityStatus.safeParse({ ...observed, ...patch }).success).toBe(false);
  });
});
