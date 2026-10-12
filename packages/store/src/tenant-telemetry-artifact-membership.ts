import { createHash, createHmac } from "node:crypto";
import {
  TENANT_TELEMETRY_DOMAINS,
  TENANT_TELEMETRY_HISTORY_STATUSES,
  TENANT_TELEMETRY_OWNER_KINDS,
  tenantTelemetryRefKeyIdSha256,
  type TenantTelemetryArtifactInventoryRecord,
  type TenantTelemetryDomain,
  type TenantTelemetryHistoryStatus,
  type TenantTelemetryOwnerKind,
} from "./tenant-telemetry-lifecycle.js";
import {
  validateTenantTelemetryApplicationWriteBinding,
  type TenantTelemetryApplicationWriteBinding,
} from "./tenant-telemetry-application-capture.js";

export const TENANT_TELEMETRY_ARTIFACT_MEMBERSHIP_SCOPE =
  "tenant-telemetry-artifact-membership-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SCHEMA = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface TenantTelemetryArtifactMembershipBody {
  scope: typeof TENANT_TELEMETRY_ARTIFACT_MEMBERSHIP_SCOPE;
  writeOperationSha256: string;
  tenantId: string;
  domain: TenantTelemetryDomain;
  targetSha256: string;
  inventorySha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  manifestSha256: string;
  payloadSha256: string;
  ownerKind: TenantTelemetryOwnerKind;
  tenantRefSha256: string;
  ownerRefSha256: string;
  holdSubjectRefSha256: string;
  refKeyIdSha256: string;
  ownerBindingSha256: string;
  lifecycleCoverageEvidenceSha256: string;
  lifecycleHistoryStatus: TenantTelemetryHistoryStatus;
  applicationBindingReceiptSha256: string | null;
  sourceSchema: string;
  sourceGeneration: number;
  sourceHighWaterDbMs: number;
  inventoryCreatedAtDbMs: number;
}

export interface TenantTelemetryArtifactMembershipRecord
  extends TenantTelemetryArtifactMembershipBody {
  membershipSha256: string;
}

const BODY_KEYS = [
  "scope",
  "writeOperationSha256",
  "tenantId",
  "domain",
  "targetSha256",
  "inventorySha256",
  "artifactIdSha256",
  "artifactGeneration",
  "manifestSha256",
  "payloadSha256",
  "ownerKind",
  "tenantRefSha256",
  "ownerRefSha256",
  "holdSubjectRefSha256",
  "refKeyIdSha256",
  "ownerBindingSha256",
  "lifecycleCoverageEvidenceSha256",
  "lifecycleHistoryStatus",
  "applicationBindingReceiptSha256",
  "sourceSchema",
  "sourceGeneration",
  "sourceHighWaterDbMs",
  "inventoryCreatedAtDbMs",
] as const;

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest`);
  }
}

function nonNegative(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is not a non-negative safe integer`);
  }
}

/**
 * A keyed, domain-separated assertion of the exact live owner tuple observed during enqueue.
 * No raw user/session identifier or secret key is retained in the durable sidecar. It is an
 * admission-time claim, not a post-T3f owner-closure receipt or deletion authorization.
 */
export function tenantTelemetryArtifactOwnerBindingSha256(input: {
  tenantId: string;
  ownerKind: TenantTelemetryOwnerKind;
  ownerId: string;
  ownerUserId: string | null;
}, refKey: Uint8Array): string {
  tenantTelemetryRefKeyIdSha256(refKey);
  if (typeof input.tenantId !== "string" || input.tenantId.length < 1
    || input.tenantId.length > 128
    || !(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(input.ownerKind)
    || typeof input.ownerId !== "string" || input.ownerId.length < 1
    || input.ownerId.length > 128
    || (input.ownerKind === "tenant"
      ? input.ownerId !== input.tenantId || input.ownerUserId !== null
      : typeof input.ownerUserId !== "string" || input.ownerUserId.length < 1
        || input.ownerUserId.length > 128
        || (input.ownerKind === "user" && input.ownerId !== input.ownerUserId))) {
    throw new Error("tenant telemetry artifact owner tuple is invalid");
  }
  return createHmac("sha256", refKey)
    .update(JSON.stringify([
      "tenant-telemetry-artifact-owner-binding-v1",
      input.tenantId,
      input.ownerKind,
      input.ownerId,
      input.ownerUserId,
    ]))
    .digest("hex");
}

export function tenantTelemetryArtifactMembershipSha256(
  body: TenantTelemetryArtifactMembershipBody,
): string {
  validateTenantTelemetryArtifactMembershipBody(body);
  return createHash("sha256")
    .update(JSON.stringify([
      "tenant-telemetry-artifact-membership-receipt-v1",
      ...BODY_KEYS.map((key) => body[key]),
    ]))
    .digest("hex");
}

export function validateTenantTelemetryArtifactMembershipBody(
  body: TenantTelemetryArtifactMembershipBody,
): void {
  exactKeys(body, BODY_KEYS, "tenant telemetry artifact membership body");
  if (body.scope !== TENANT_TELEMETRY_ARTIFACT_MEMBERSHIP_SCOPE
    || typeof body.tenantId !== "string" || body.tenantId.length < 1
    || body.tenantId.length > 128
    || !(TENANT_TELEMETRY_DOMAINS as readonly unknown[]).includes(body.domain)
    || !(TENANT_TELEMETRY_OWNER_KINDS as readonly unknown[]).includes(body.ownerKind)
    || !(TENANT_TELEMETRY_HISTORY_STATUSES as readonly unknown[])
      .includes(body.lifecycleHistoryStatus)
    || typeof body.sourceSchema !== "string" || !SOURCE_SCHEMA.test(body.sourceSchema)) {
    throw new Error("tenant telemetry artifact membership protocol is invalid");
  }
  for (const [value, label] of [
    [body.writeOperationSha256, "write operation"],
    [body.targetSha256, "target"],
    [body.inventorySha256, "inventory"],
    [body.artifactIdSha256, "artifact id"],
    [body.manifestSha256, "manifest"],
    [body.payloadSha256, "payload"],
    [body.tenantRefSha256, "tenant ref"],
    [body.ownerRefSha256, "owner ref"],
    [body.holdSubjectRefSha256, "hold subject ref"],
    [body.refKeyIdSha256, "ref key id"],
    [body.ownerBindingSha256, "owner binding"],
    [body.lifecycleCoverageEvidenceSha256, "lifecycle coverage"],
  ] as const) digest(value, `tenant telemetry artifact membership ${label}`);
  if (body.applicationBindingReceiptSha256 !== null) {
    digest(body.applicationBindingReceiptSha256,
      "tenant telemetry artifact membership application binding");
  }
  nonNegative(body.sourceGeneration, "tenant telemetry artifact membership source generation");
  nonNegative(body.sourceHighWaterDbMs,
    "tenant telemetry artifact membership source high-water");
  nonNegative(body.inventoryCreatedAtDbMs,
    "tenant telemetry artifact membership inventory creation high-water");
  if (!Number.isSafeInteger(body.artifactGeneration) || body.artifactGeneration < 1
    || body.inventoryCreatedAtDbMs < body.sourceHighWaterDbMs
    || (body.ownerKind === "tenant"
      && (body.ownerRefSha256 !== body.tenantRefSha256
        || body.holdSubjectRefSha256 !== body.tenantRefSha256))
    || (body.ownerKind === "user"
      && body.ownerRefSha256 !== body.holdSubjectRefSha256)) {
    throw new Error("tenant telemetry artifact membership owner/source is invalid");
  }
}

export function validateTenantTelemetryArtifactMembership(
  membership: TenantTelemetryArtifactMembershipRecord,
): void {
  exactKeys(membership, [...BODY_KEYS, "membershipSha256"],
    "tenant telemetry artifact membership");
  digest(membership.membershipSha256, "tenant telemetry artifact membership receipt");
  const { membershipSha256, ...body } = membership;
  if (membershipSha256 !== tenantTelemetryArtifactMembershipSha256(body)) {
    throw new Error("tenant telemetry artifact membership receipt mismatch");
  }
}

/** Only a source sidecar: it does not establish full-domain coverage or external deletion authority. */
export function createTenantTelemetryArtifactMembership(input: {
  writeOperationSha256: string;
  inventory: TenantTelemetryArtifactInventoryRecord;
  ownerId: string;
  ownerUserId: string | null;
  refKey: Uint8Array;
  applicationBinding: TenantTelemetryApplicationWriteBinding | null;
}): TenantTelemetryArtifactMembershipRecord {
  const { inventory, applicationBinding } = input;
  if (applicationBinding) validateTenantTelemetryApplicationWriteBinding(applicationBinding);
  if (applicationBinding && (
    applicationBinding.writeOperationSha256 !== input.writeOperationSha256
    || applicationBinding.tenantId !== inventory.tenantId
    || applicationBinding.domain !== inventory.domain
    || applicationBinding.targetSha256 !== inventory.targetSha256
    || applicationBinding.inventorySha256 !== inventory.inventorySha256
    || applicationBinding.manifestSha256 !== inventory.manifestSha256
    || applicationBinding.payloadSha256 !== inventory.payloadSha256
  )) {
    throw new Error("tenant telemetry application binding differs from membership source");
  }
  const body: TenantTelemetryArtifactMembershipBody = {
    scope: TENANT_TELEMETRY_ARTIFACT_MEMBERSHIP_SCOPE,
    writeOperationSha256: input.writeOperationSha256,
    tenantId: inventory.tenantId,
    domain: inventory.domain,
    targetSha256: inventory.targetSha256,
    inventorySha256: inventory.inventorySha256,
    artifactIdSha256: inventory.artifactIdSha256,
    artifactGeneration: inventory.artifactGeneration,
    manifestSha256: inventory.manifestSha256,
    payloadSha256: inventory.payloadSha256,
    ownerKind: inventory.ownerKind,
    tenantRefSha256: inventory.tenantRefSha256,
    ownerRefSha256: inventory.ownerRefSha256,
    holdSubjectRefSha256: inventory.holdSubjectRefSha256,
    refKeyIdSha256: tenantTelemetryRefKeyIdSha256(input.refKey),
    ownerBindingSha256: tenantTelemetryArtifactOwnerBindingSha256({
      tenantId: inventory.tenantId,
      ownerKind: inventory.ownerKind,
      ownerId: input.ownerId,
      ownerUserId: input.ownerUserId,
    }, input.refKey),
    lifecycleCoverageEvidenceSha256: inventory.coverageEvidenceSha256,
    lifecycleHistoryStatus: inventory.historyStatus,
    applicationBindingReceiptSha256: applicationBinding?.receiptSha256 ?? null,
    sourceSchema: inventory.sourceSchema,
    sourceGeneration: inventory.sourceGeneration,
    sourceHighWaterDbMs: inventory.sourceHighWaterDbMs,
    inventoryCreatedAtDbMs: inventory.createdAtDbMs,
  };
  return { ...body, membershipSha256: tenantTelemetryArtifactMembershipSha256(body) };
}

/**
 * Verify an existing sidecar against durable 0033/0034/0035 identities. The absence of a sidecar
 * on an older job remains unknown; this validator must never synthesize one from job JSON.
 */
export function validateTenantTelemetryArtifactMembershipSource(
  membership: TenantTelemetryArtifactMembershipRecord,
  input: {
    writeOperationSha256: string;
    jobCreatedAtMs: number;
    inventory: TenantTelemetryArtifactInventoryRecord;
    refKeyIdSha256: string;
    applicationBinding: TenantTelemetryApplicationWriteBinding | null;
  },
): void {
  validateTenantTelemetryArtifactMembership(membership);
  const { inventory, applicationBinding } = input;
  if (applicationBinding) validateTenantTelemetryApplicationWriteBinding(applicationBinding);
  if (membership.writeOperationSha256 !== input.writeOperationSha256
    || membership.inventoryCreatedAtDbMs !== input.jobCreatedAtMs
    || membership.tenantId !== inventory.tenantId
    || membership.domain !== inventory.domain
    || membership.targetSha256 !== inventory.targetSha256
    || membership.inventorySha256 !== inventory.inventorySha256
    || membership.artifactIdSha256 !== inventory.artifactIdSha256
    || membership.artifactGeneration !== inventory.artifactGeneration
    || membership.manifestSha256 !== inventory.manifestSha256
    || membership.payloadSha256 !== inventory.payloadSha256
    || membership.ownerKind !== inventory.ownerKind
    || membership.tenantRefSha256 !== inventory.tenantRefSha256
    || membership.ownerRefSha256 !== inventory.ownerRefSha256
    || membership.holdSubjectRefSha256 !== inventory.holdSubjectRefSha256
    || membership.refKeyIdSha256 !== input.refKeyIdSha256
    || membership.lifecycleCoverageEvidenceSha256
      !== inventory.coverageEvidenceSha256
    || membership.lifecycleHistoryStatus !== inventory.historyStatus
    || membership.applicationBindingReceiptSha256
      !== (applicationBinding?.receiptSha256 ?? null)
    || membership.sourceSchema !== inventory.sourceSchema
    || membership.sourceGeneration !== inventory.sourceGeneration
    || membership.sourceHighWaterDbMs !== inventory.sourceHighWaterDbMs
    || membership.inventoryCreatedAtDbMs !== inventory.createdAtDbMs) {
    throw new Error("tenant telemetry artifact membership source mismatch");
  }
}

export interface TenantTelemetryArtifactMembershipStore {
  /** Missing on a pre-0038 write means unknown, never permission to infer from inventory JSON. */
  getTenantTelemetryArtifactMembership(
    tenantId: string,
    writeOperationSha256: string,
  ): Promise<TenantTelemetryArtifactMembershipRecord | null>;
}
