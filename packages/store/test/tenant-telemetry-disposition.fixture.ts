import { createHash } from "node:crypto";
import {
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE,
  tenantTelemetryDispositionOperationSha256,
  tenantTelemetrySameKeyTombstoneAckSha256,
  type TenantTelemetryDispositionEvidence,
  type TenantTelemetryExternalAuthorizationProof,
  type TenantTelemetrySameKeyTombstoneAck,
} from "../src/tenant-telemetry-disposition.js";

export function dispositionDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function dispositionEvidence(index = 1): TenantTelemetryDispositionEvidence {
  const source = {
    domain: index % 2 === 0 ? "traces" as const : "logs" as const,
    targetSha256: dispositionDigest(`target-${index}`),
    artifactIdSha256: dispositionDigest(`artifact-${index}`),
    artifactGeneration: index,
    inventorySha256: dispositionDigest(`inventory-${index}`),
    inventoryReceiptSha256: dispositionDigest(`inventory-receipt-${index}`),
    writeOperationSha256: dispositionDigest(`write-operation-${index}`),
    writeAckReceiptSha256: dispositionDigest(`write-ack-${index}`),
    payloadSha256: dispositionDigest(`payload-${index}`),
    manifestSha256: dispositionDigest(`manifest-${index}`),
    lifecycleCoverageEvidenceSha256: dispositionDigest(`lifecycle-coverage-${index}`),
    applicationCoverageEvidenceSha256: dispositionDigest(`application-coverage-${index}`),
    applicationWriteBindingReceiptSha256:
      dispositionDigest(`application-write-binding-${index}`),
    t3cReceiptSha256: dispositionDigest(`t3c-${index}`),
    t3dPlanReceiptSha256: dispositionDigest(`t3d-plan-${index}`),
    t3dPlanEntryReceiptSha256: dispositionDigest(`t3d-entry-${index}`),
  };
  return {
    ...source,
    dispositionOperationSha256: tenantTelemetryDispositionOperationSha256(source),
  };
}

export function tombstoneAck(
  authorization: TenantTelemetryExternalAuthorizationProof,
  options: { suffix?: string } = {},
): TenantTelemetrySameKeyTombstoneAck {
  const suffix = options.suffix ?? "default";
  const body = {
    scope: TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    domain: authorization.domain,
    targetSha256: authorization.targetSha256,
    artifactIdSha256: authorization.artifactIdSha256,
    artifactGeneration: authorization.artifactGeneration,
    inventorySha256: authorization.inventorySha256,
    inventoryReceiptSha256: authorization.inventoryReceiptSha256,
    writeOperationSha256: authorization.writeOperationSha256,
    writeAckReceiptSha256: authorization.writeAckReceiptSha256,
    payloadSha256: authorization.payloadSha256,
    manifestSha256: authorization.manifestSha256,
    lifecycleCoverageEvidenceSha256: authorization.lifecycleCoverageEvidenceSha256,
    applicationCoverageEvidenceSha256: authorization.applicationCoverageEvidenceSha256,
    applicationWriteBindingReceiptSha256:
      authorization.applicationWriteBindingReceiptSha256,
    t3cReceiptSha256: authorization.t3cReceiptSha256,
    t3dPlanReceiptSha256: authorization.t3dPlanReceiptSha256,
    t3dPlanEntryReceiptSha256: authorization.t3dPlanEntryReceiptSha256,
    dispositionOperationSha256: authorization.dispositionOperationSha256,
    authorizationReceiptSha256: authorization.authorizationReceiptSha256,
    outcome: "tombstoned" as const,
    tombstoneSha256: dispositionDigest(`tombstone-${suffix}`),
    objectEtagSha256: dispositionDigest(`etag-${suffix}`),
    adapterEvidenceSha256: dispositionDigest(`adapter-${suffix}`),
  };
  return { ...body, receiptSha256: tenantTelemetrySameKeyTombstoneAckSha256(body) };
}
