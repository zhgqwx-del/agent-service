import { createHash } from "node:crypto";
import {
  tenantTelemetryArtifactOwnerBindingSha256,
  validateTenantTelemetryArtifactMembership,
  type TenantTelemetryArtifactMembershipRecord,
} from "./tenant-telemetry-artifact-membership.js";
import {
  tenantTelemetryOwnerRefSha256,
  tenantTelemetryRefKeyIdSha256,
  type TenantTelemetryOwnerKind,
} from "./tenant-telemetry-lifecycle.js";
import type { TenantDatabasePurgeIdentity } from "./tenant-database-purge.js";

/** This is a pre-T3f owner/source fact, never a grant or external deletion receipt. */
export const TENANT_TELEMETRY_OWNER_CLOSURE_ENTRY_SCOPE =
  "tenant-telemetry-owner-closure-entry-v1" as const;
export const TENANT_TELEMETRY_OWNER_CLOSURE_RECEIPT_SCOPE =
  "tenant-telemetry-owner-closure-receipt-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTITY_KEYS = [
  "requestId", "tenantId", "subjectGeneration", "planBuildGeneration",
  "executionGeneration", "databasePurgeGeneration",
] as const;
const ENTRY_BODY_KEYS = [
  "scope", ...IDENTITY_KEYS, "writeOperationSha256", "membershipSha256",
  "inventorySha256", "ownerKind", "ownerRefSha256", "holdSubjectRefSha256",
  "refKeyIdSha256", "ownerBindingSha256", "canonicalOwnerProofSha256",
  "sessionGraveMarkerSha256", "preDeleteReceiptSha256", "capturedAtDbMs",
] as const;
const RECEIPT_BODY_KEYS = [
  "scope", ...IDENTITY_KEYS, "t1FenceSha256", "t3cReceiptSha256",
  "planReceiptSha256", "localPhysicalAckReceiptSha256", "preDeleteReceiptSha256",
  "t3fReceiptSha256", "graveMarkerRootSha256", "entryCount", "entryRootSha256",
  "storeDbTimestampMs", "completedClaimAttempt", "completedClaimTokenSha256",
] as const;

export interface TenantTelemetryOwnerClosureEntryBody extends TenantDatabasePurgeIdentity {
  scope: typeof TENANT_TELEMETRY_OWNER_CLOSURE_ENTRY_SCOPE;
  writeOperationSha256: string;
  membershipSha256: string;
  inventorySha256: string;
  ownerKind: TenantTelemetryOwnerKind;
  ownerRefSha256: string;
  holdSubjectRefSha256: string;
  refKeyIdSha256: string;
  ownerBindingSha256: string;
  canonicalOwnerProofSha256: string;
  sessionGraveMarkerSha256: string | null;
  preDeleteReceiptSha256: string;
  capturedAtDbMs: number;
}

export interface TenantTelemetryOwnerClosureEntry
  extends TenantTelemetryOwnerClosureEntryBody {
  receiptSha256: string;
}

export interface TenantTelemetryOwnerClosureReceiptBody extends TenantDatabasePurgeIdentity {
  scope: typeof TENANT_TELEMETRY_OWNER_CLOSURE_RECEIPT_SCOPE;
  t1FenceSha256: string;
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  localPhysicalAckReceiptSha256: string;
  preDeleteReceiptSha256: string;
  t3fReceiptSha256: string;
  graveMarkerRootSha256: string;
  entryCount: number;
  entryRootSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
}

export interface TenantTelemetryOwnerClosureReceipt
  extends TenantTelemetryOwnerClosureReceiptBody {
  receiptSha256: string;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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

function positive(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is not a positive safe integer`);
  }
}

function identity(identity: TenantDatabasePurgeIdentity): void {
  if (typeof identity.requestId !== "string" || identity.requestId.length < 1
    || typeof identity.tenantId !== "string" || identity.tenantId.length < 1
    || identity.tenantId.length > 128) {
    throw new Error("tenant telemetry owner closure identity is invalid");
  }
  for (const key of ["subjectGeneration", "planBuildGeneration",
    "executionGeneration", "databasePurgeGeneration"] as const) {
    positive(identity[key], `tenant telemetry owner closure ${key}`);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function tenantTelemetryCanonicalOwnerProofSha256(input: Pick<
  TenantTelemetryOwnerClosureEntryBody,
  "ownerKind" | "ownerBindingSha256" | "ownerRefSha256"
    | "holdSubjectRefSha256" | "sessionGraveMarkerSha256"
>): string {
  if (input.ownerKind !== "tenant" && input.ownerKind !== "user"
    && input.ownerKind !== "session") throw new Error("invalid telemetry owner kind");
  for (const key of ["ownerBindingSha256", "ownerRefSha256",
    "holdSubjectRefSha256"] as const) digest(input[key], `owner closure ${key}`);
  if (input.ownerKind === "session") {
    digest(input.sessionGraveMarkerSha256, "owner closure session grave");
  } else if (input.sessionGraveMarkerSha256 !== null) {
    throw new Error("non-session telemetry owner has a session grave");
  }
  return sha256([
    "tenant-telemetry-canonical-owner-proof-v1", input.ownerKind,
    input.ownerBindingSha256, input.ownerRefSha256, input.holdSubjectRefSha256,
    input.sessionGraveMarkerSha256,
  ]);
}

export function tenantTelemetryOwnerClosureEntrySha256(
  body: TenantTelemetryOwnerClosureEntryBody,
): string {
  validateTenantTelemetryOwnerClosureEntryBody(body);
  return sha256([
    "tenant-telemetry-owner-closure-entry-receipt-v1",
    ...ENTRY_BODY_KEYS.map((key) => body[key]),
  ]);
}

export function validateTenantTelemetryOwnerClosureEntryBody(
  body: TenantTelemetryOwnerClosureEntryBody,
): void {
  exactKeys(body, ENTRY_BODY_KEYS, "tenant telemetry owner closure entry body");
  identity(body);
  if (body.scope !== TENANT_TELEMETRY_OWNER_CLOSURE_ENTRY_SCOPE) {
    throw new Error("tenant telemetry owner closure entry scope is invalid");
  }
  for (const key of ["writeOperationSha256", "membershipSha256", "inventorySha256",
    "ownerRefSha256", "holdSubjectRefSha256", "refKeyIdSha256",
    "ownerBindingSha256", "canonicalOwnerProofSha256", "preDeleteReceiptSha256"] as const) {
    digest(body[key], `tenant telemetry owner closure ${key}`);
  }
  nonNegative(body.capturedAtDbMs, "tenant telemetry owner closure capture time");
  if (body.canonicalOwnerProofSha256 !== tenantTelemetryCanonicalOwnerProofSha256(body)) {
    throw new Error("tenant telemetry canonical owner proof does not match");
  }
}

export function validateTenantTelemetryOwnerClosureEntry(
  entry: TenantTelemetryOwnerClosureEntry,
): void {
  exactKeys(entry, [...ENTRY_BODY_KEYS, "receiptSha256"],
    "tenant telemetry owner closure entry");
  digest(entry.receiptSha256, "tenant telemetry owner closure entry receipt");
  const { receiptSha256, ...body } = entry;
  if (receiptSha256 !== tenantTelemetryOwnerClosureEntrySha256(body)) {
    throw new Error("tenant telemetry owner closure entry receipt does not match");
  }
}

/** Caller must supply a tuple read from canonical live owner rows inside the T3f boundary. */
export function createTenantTelemetryOwnerClosureEntry(input: {
  identity: TenantDatabasePurgeIdentity;
  membership: TenantTelemetryArtifactMembershipRecord;
  canonicalOwnerId: string;
  canonicalOwnerUserId: string | null;
  refKey: Uint8Array;
  sessionGraveMarkerSha256: string | null;
  preDeleteReceiptSha256: string;
  capturedAtDbMs: number;
}): TenantTelemetryOwnerClosureEntry {
  validateTenantTelemetryArtifactMembership(input.membership);
  const { membership } = input;
  if (input.capturedAtDbMs < membership.inventoryCreatedAtDbMs
    || membership.tenantId !== input.identity.tenantId
    || membership.refKeyIdSha256 !== tenantTelemetryRefKeyIdSha256(input.refKey)
    || membership.ownerBindingSha256 !== tenantTelemetryArtifactOwnerBindingSha256({
      tenantId: membership.tenantId,
      ownerKind: membership.ownerKind,
      ownerId: input.canonicalOwnerId,
      ownerUserId: input.canonicalOwnerUserId,
    }, input.refKey)
    || membership.ownerRefSha256 !== tenantTelemetryOwnerRefSha256(
      membership.ownerKind, input.canonicalOwnerId, input.refKey,
    )
    || membership.holdSubjectRefSha256 !== tenantTelemetryOwnerRefSha256(
      membership.ownerKind === "tenant" ? "tenant" : "user",
      membership.ownerKind === "tenant"
        ? membership.tenantId : input.canonicalOwnerUserId!,
      input.refKey,
    )) {
    throw new Error("tenant telemetry closure live owner does not match membership");
  }
  const ownerProof = {
    ownerKind: membership.ownerKind,
    ownerBindingSha256: membership.ownerBindingSha256,
    ownerRefSha256: membership.ownerRefSha256,
    holdSubjectRefSha256: membership.holdSubjectRefSha256,
    sessionGraveMarkerSha256: input.sessionGraveMarkerSha256,
  };
  const body: TenantTelemetryOwnerClosureEntryBody = {
    scope: TENANT_TELEMETRY_OWNER_CLOSURE_ENTRY_SCOPE,
    ...input.identity,
    writeOperationSha256: membership.writeOperationSha256,
    membershipSha256: membership.membershipSha256,
    inventorySha256: membership.inventorySha256,
    ownerKind: membership.ownerKind,
    ownerRefSha256: membership.ownerRefSha256,
    holdSubjectRefSha256: membership.holdSubjectRefSha256,
    refKeyIdSha256: membership.refKeyIdSha256,
    ownerBindingSha256: membership.ownerBindingSha256,
    canonicalOwnerProofSha256: tenantTelemetryCanonicalOwnerProofSha256(ownerProof),
    sessionGraveMarkerSha256: input.sessionGraveMarkerSha256,
    preDeleteReceiptSha256: input.preDeleteReceiptSha256,
    capturedAtDbMs: input.capturedAtDbMs,
  };
  return { ...body, receiptSha256: tenantTelemetryOwnerClosureEntrySha256(body) };
}

export function tenantTelemetryOwnerClosureEntryRootSha256(
  entries: readonly TenantTelemetryOwnerClosureEntry[],
): string {
  const sorted = [...entries].sort((left, right) => left.writeOperationSha256 < right.writeOperationSha256
    ? -1 : left.writeOperationSha256 > right.writeOperationSha256 ? 1 : 0);
  for (let index = 0; index < sorted.length; index++) {
    const entry = sorted[index]!;
    validateTenantTelemetryOwnerClosureEntry(entry);
    if (index > 0 && sorted[index - 1]!.writeOperationSha256 === entry.writeOperationSha256) {
      throw new Error("duplicate tenant telemetry owner closure operation");
    }
  }
  return sha256([
    "tenant-telemetry-owner-closure-entry-root-v1",
    ...sorted.map((entry) => [entry.writeOperationSha256, entry.receiptSha256]),
  ]);
}

export function tenantTelemetryOwnerClosureReceiptSha256(
  body: TenantTelemetryOwnerClosureReceiptBody,
): string {
  validateTenantTelemetryOwnerClosureReceiptBody(body);
  return sha256([
    "tenant-telemetry-owner-closure-receipt-v1",
    ...RECEIPT_BODY_KEYS.map((key) => body[key]),
  ]);
}

export function validateTenantTelemetryOwnerClosureReceiptBody(
  body: TenantTelemetryOwnerClosureReceiptBody,
): void {
  exactKeys(body, RECEIPT_BODY_KEYS, "tenant telemetry owner closure receipt body");
  identity(body);
  if (body.scope !== TENANT_TELEMETRY_OWNER_CLOSURE_RECEIPT_SCOPE) {
    throw new Error("tenant telemetry owner closure receipt scope is invalid");
  }
  for (const key of ["t1FenceSha256", "t3cReceiptSha256", "planReceiptSha256",
    "localPhysicalAckReceiptSha256", "preDeleteReceiptSha256", "t3fReceiptSha256",
    "graveMarkerRootSha256", "entryRootSha256", "completedClaimTokenSha256"] as const) {
    digest(body[key], `tenant telemetry owner closure ${key}`);
  }
  nonNegative(body.entryCount, "tenant telemetry owner closure entry count");
  nonNegative(body.storeDbTimestampMs, "tenant telemetry owner closure timestamp");
  positive(body.completedClaimAttempt, "tenant telemetry owner closure claim attempt");
}

export function validateTenantTelemetryOwnerClosureReceipt(
  receipt: TenantTelemetryOwnerClosureReceipt,
): void {
  exactKeys(receipt, [...RECEIPT_BODY_KEYS, "receiptSha256"],
    "tenant telemetry owner closure receipt");
  digest(receipt.receiptSha256, "tenant telemetry owner closure receipt hash");
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== tenantTelemetryOwnerClosureReceiptSha256(body)) {
    throw new Error("tenant telemetry owner closure receipt does not match");
  }
}

export function createTenantTelemetryOwnerClosureReceipt(input:
  TenantTelemetryOwnerClosureReceiptBody & {
    entries: readonly TenantTelemetryOwnerClosureEntry[];
  },
): TenantTelemetryOwnerClosureReceipt {
  const { entries, ...body } = input;
  if (body.entryCount !== entries.length
    || body.entryRootSha256 !== tenantTelemetryOwnerClosureEntryRootSha256(entries)
    || entries.some((entry) => entry.requestId !== body.requestId
      || entry.tenantId !== body.tenantId
      || entry.subjectGeneration !== body.subjectGeneration
      || entry.planBuildGeneration !== body.planBuildGeneration
      || entry.executionGeneration !== body.executionGeneration
      || entry.databasePurgeGeneration !== body.databasePurgeGeneration
      || entry.preDeleteReceiptSha256 !== body.preDeleteReceiptSha256
      || entry.capturedAtDbMs !== body.storeDbTimestampMs)) {
    throw new Error("tenant telemetry owner closure entry set differs from receipt");
  }
  return { ...body, receiptSha256: tenantTelemetryOwnerClosureReceiptSha256(body) };
}

/** Missing on a pre-0039 terminal T3f job is unknown, never an empty-set assertion. */
export interface TenantTelemetryOwnerClosureStore {
  getTenantTelemetryOwnerClosureReceipt(
    tenantId: string,
    requestId: string,
  ): Promise<TenantTelemetryOwnerClosureReceipt | null>;
  getTenantTelemetryOwnerClosureEntries(
    tenantId: string,
    requestId: string,
  ): Promise<TenantTelemetryOwnerClosureEntry[]>;
}
