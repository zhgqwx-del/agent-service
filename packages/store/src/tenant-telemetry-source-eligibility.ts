import type { TenantTelemetryOwnerClosureEntry } from "./tenant-telemetry-owner-closure.js";
import type { TenantTelemetryPlanArtifactTarget,
  TenantTelemetryPlanArtifactTargetReceipt } from "./tenant-telemetry-plan-artifact-target.js";
import type { TenantTelemetryTargetSourceReadiness } from "./tenant-telemetry-target-manifest.js";

/** Diagnostic for the exact managed artifacts in one sealed plan, never domain completeness. */
export interface TenantTelemetrySourceEligibility {
  readonly status: "unknown" | "local_source_candidate";
  readonly managedArtifactCount: number | null;
  readonly executionReady: false;
  readonly externalAuthorityVerified: false;
}

export const UNKNOWN_TENANT_TELEMETRY_SOURCE_ELIGIBILITY:
  TenantTelemetrySourceEligibility = Object.freeze({
    status: "unknown", managedArtifactCount: null,
    executionReady: false, externalAuthorityVerified: false,
  });

/**
 * Cross-check the already-validated 0042 catalog against the already-validated T3f closure.
 * The caller must validate all source rows and current local gates in one atomic read boundary.
 * This value must never be accepted as a later mutation authorization; that operation must
 * independently lock and re-prove its sources.
 */
export function evaluateTenantTelemetryLocalSourceEligibility(input: {
  readiness: TenantTelemetryTargetSourceReadiness;
  catalog: { readonly entries: readonly TenantTelemetryPlanArtifactTarget[];
    readonly receipt: TenantTelemetryPlanArtifactTargetReceipt } | null;
  closureEntries: readonly TenantTelemetryOwnerClosureEntry[];
  currentLocalSourceVerified: boolean;
}): TenantTelemetrySourceEligibility {
  const { readiness, catalog, closureEntries } = input;
  if (!input.currentLocalSourceVerified || !catalog
    || !readiness.sourceRelationsComplete || !readiness.ownerClosureComplete
    || readiness.unknownArtifactGroupCount !== 0
    || catalog.receipt.unknownGroupCount !== 0
    || catalog.receipt.executionReady !== false
    || catalog.receipt.targetCount !== catalog.entries.length
    || catalog.entries.length !== closureEntries.length) {
    return UNKNOWN_TENANT_TELEMETRY_SOURCE_ELIGIBILITY;
  }
  const closed = new Map(closureEntries.map((entry) => [entry.writeOperationSha256, entry]));
  if (closed.size !== closureEntries.length) {
    return UNKNOWN_TENANT_TELEMETRY_SOURCE_ELIGIBILITY;
  }
  for (const target of catalog.entries) {
    const owner = closed.get(target.writeOperationSha256);
    if (!owner || owner.requestId !== target.requestId || owner.tenantId !== target.tenantId
      || owner.inventorySha256 !== target.inventorySha256
      || owner.membershipSha256 !== target.membershipSha256
      || owner.ownerKind !== target.ownerKind
      || owner.ownerRefSha256 !== target.ownerRefSha256
      || owner.holdSubjectRefSha256 !== target.holdSubjectRefSha256
      || owner.ownerBindingSha256 !== target.ownerBindingSha256) {
      return UNKNOWN_TENANT_TELEMETRY_SOURCE_ELIGIBILITY;
    }
    closed.delete(target.writeOperationSha256);
  }
  if (closed.size !== 0) return UNKNOWN_TENANT_TELEMETRY_SOURCE_ELIGIBILITY;
  return Object.freeze({
    status: "local_source_candidate", managedArtifactCount: catalog.entries.length,
    executionReady: false, externalAuthorityVerified: false,
  });
}

export interface TenantTelemetrySourceEligibilityStore {
  getTenantTelemetrySourceEligibility(tenantId: string, requestId: string):
    Promise<TenantTelemetrySourceEligibility | null>;
}
