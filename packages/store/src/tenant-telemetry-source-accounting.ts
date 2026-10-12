import { createHash } from "node:crypto";
import {
  validateTenantTelemetryArtifactInventory,
  type TenantTelemetryArtifactInventoryRecord,
  type TenantTelemetryDomain,
} from "./tenant-telemetry-lifecycle.js";
import {
  validateTenantTelemetryWriteAck,
  validateTenantTelemetryWriteJobRecord,
  type TenantTelemetryWriteAck,
  type TenantTelemetryWriteJobRecord,
} from "./tenant-telemetry-writer.js";
import {
  validateTenantTelemetryArtifactMembership,
  validateTenantTelemetryArtifactMembershipSource,
  type TenantTelemetryArtifactMembershipRecord,
} from "./tenant-telemetry-artifact-membership.js";
import {
  validateTenantTelemetryApplicationWriteBinding,
  type TenantTelemetryApplicationWriteBinding,
} from "./tenant-telemetry-application-capture.js";
import {
  TenantPurgePlanNotReadyError,
  type TenantPurgePlanJobRecord,
  type TenantPurgePlanReceipt,
} from "./tenant-purge-plan.js";

/** A T3d snapshot of source rows, not deletion authority or a coverage assertion. */
export const TENANT_TELEMETRY_SOURCE_ACCOUNTING_ENTRY_SCOPE =
  "tenant-telemetry-source-accounting-entry-v1" as const;
export const TENANT_TELEMETRY_SOURCE_ACCOUNTING_RECEIPT_SCOPE =
  "tenant-telemetry-source-accounting-receipt-v1" as const;
export const TENANT_TELEMETRY_SOURCE_KINDS = [
  "inventory", "write_job", "write_ack", "membership", "application_binding",
] as const;
export type TenantTelemetrySourceKind = typeof TENANT_TELEMETRY_SOURCE_KINDS[number];
export type TenantTelemetrySourceClassification = "accounted" | "unknown";
export type TenantTelemetrySourceReason =
  | "complete" | "legacy_missing_membership" | "incomplete_write"
  | "missing_inventory" | "missing_ack" | "unbound_application" | "orphan_source";

const SHA256 = /^[0-9a-f]{64}$/;
const REASONS: readonly string[] = [
  "complete", "legacy_missing_membership", "incomplete_write", "missing_inventory",
  "missing_ack", "unbound_application", "orphan_source",
];
const ENTRY_KEYS = [
  "scope", "requestId", "tenantId", "subjectGeneration", "buildGeneration",
  "sourceKind", "sourceIdentitySha256", "writeOperationSha256", "domain",
  "sourceEvidenceSha256", "classification", "reason", "capturedAtDbMs",
] as const;
const RECEIPT_KEYS = [
  "scope", "requestId", "tenantId", "subjectGeneration", "buildGeneration",
  "t1FenceSha256", "t3cReceiptSha256", "planReceiptSha256",
  "inventoryCount", "writeJobCount", "writeAckCount", "membershipCount",
  "applicationBindingCount", "entryCount", "entryRootSha256", "unknownCount",
  "unknownRootSha256", "storeDbTimestampMs", "completedClaimAttempt",
  "completedClaimTokenSha256",
] as const;

export interface TenantTelemetrySourceAccountingEntryBody {
  scope: typeof TENANT_TELEMETRY_SOURCE_ACCOUNTING_ENTRY_SCOPE;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  buildGeneration: number;
  sourceKind: TenantTelemetrySourceKind;
  sourceIdentitySha256: string;
  writeOperationSha256: string | null;
  domain: TenantTelemetryDomain;
  sourceEvidenceSha256: string;
  classification: TenantTelemetrySourceClassification;
  reason: TenantTelemetrySourceReason;
  capturedAtDbMs: number;
}
export interface TenantTelemetrySourceAccountingEntry
  extends TenantTelemetrySourceAccountingEntryBody {
  receiptSha256: string;
}
export interface TenantTelemetrySourceAccountingReceiptBody {
  scope: typeof TENANT_TELEMETRY_SOURCE_ACCOUNTING_RECEIPT_SCOPE;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  buildGeneration: number;
  t1FenceSha256: string;
  t3cReceiptSha256: string;
  planReceiptSha256: string;
  inventoryCount: number;
  writeJobCount: number;
  writeAckCount: number;
  membershipCount: number;
  applicationBindingCount: number;
  entryCount: number;
  entryRootSha256: string;
  unknownCount: number;
  unknownRootSha256: string;
  storeDbTimestampMs: number;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
}
export interface TenantTelemetrySourceAccountingReceipt
  extends TenantTelemetrySourceAccountingReceiptBody {
  receiptSha256: string;
}

export interface TenantTelemetrySourceAccountingInputs {
  inventories: readonly TenantTelemetryArtifactInventoryRecord[];
  jobs: readonly TenantTelemetryWriteJobRecord[];
  acks: readonly TenantTelemetryWriteAck[];
  memberships: readonly TenantTelemetryArtifactMembershipRecord[];
  bindings: readonly TenantTelemetryApplicationWriteBinding[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("undefined telemetry source snapshot field");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}
function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256 digest`);
  }
}
function safeInt(value: unknown, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} is not a safe integer`);
  }
}
function validateIdentity(value: { requestId: string; tenantId: string;
  subjectGeneration: number; buildGeneration: number }): void {
  if (typeof value.requestId !== "string" || value.requestId.length < 1
    || typeof value.tenantId !== "string" || value.tenantId.length < 1
    || value.tenantId.length > 128) throw new Error("telemetry source identity is invalid");
  safeInt(value.subjectGeneration, "telemetry source subject generation", 1);
  safeInt(value.buildGeneration, "telemetry source build generation", 1);
}

export function tenantTelemetrySourceAccountingEntrySha256(
  body: TenantTelemetrySourceAccountingEntryBody,
): string {
  validateTenantTelemetrySourceAccountingEntryBody(body);
  return hash(["tenant-telemetry-source-accounting-entry-receipt-v1",
    ...ENTRY_KEYS.map((key) => body[key])]);
}
export function validateTenantTelemetrySourceAccountingEntryBody(
  body: TenantTelemetrySourceAccountingEntryBody,
): void {
  exactKeys(body, ENTRY_KEYS, "telemetry source entry body");
  validateIdentity(body);
  if (body.scope !== TENANT_TELEMETRY_SOURCE_ACCOUNTING_ENTRY_SCOPE
    || !(TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).includes(body.sourceKind)
    || (body.domain !== "logs" && body.domain !== "traces")
    || (body.classification !== "accounted" && body.classification !== "unknown")
    || !REASONS.includes(body.reason)
    || (body.classification === "accounted") !== (body.reason === "complete")
    || (body.sourceKind !== "inventory" && body.writeOperationSha256 === null)) {
    throw new Error("telemetry source entry classification is invalid");
  }
  digest(body.sourceIdentitySha256, "telemetry source identity hash");
  digest(body.sourceEvidenceSha256, "telemetry source evidence hash");
  if (body.writeOperationSha256 !== null) {
    digest(body.writeOperationSha256, "telemetry source operation hash");
  }
  safeInt(body.capturedAtDbMs, "telemetry source capture time");
}
export function validateTenantTelemetrySourceAccountingEntry(
  entry: TenantTelemetrySourceAccountingEntry,
): void {
  exactKeys(entry, [...ENTRY_KEYS, "receiptSha256"], "telemetry source entry");
  digest(entry.receiptSha256, "telemetry source entry receipt");
  const { receiptSha256, ...body } = entry;
  if (receiptSha256 !== tenantTelemetrySourceAccountingEntrySha256(body)) {
    throw new Error("telemetry source entry receipt mismatch");
  }
}
export function tenantTelemetrySourceAccountingEntryRootSha256(
  entries: readonly TenantTelemetrySourceAccountingEntry[],
): string {
  const sorted = [...entries].sort((a, b) =>
    TENANT_TELEMETRY_SOURCE_KINDS.indexOf(a.sourceKind)
      - TENANT_TELEMETRY_SOURCE_KINDS.indexOf(b.sourceKind)
    || a.sourceIdentitySha256.localeCompare(b.sourceIdentitySha256));
  for (const entry of sorted) validateTenantTelemetrySourceAccountingEntry(entry);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.sourceKind === sorted[i - 1]!.sourceKind
      && sorted[i]!.sourceIdentitySha256 === sorted[i - 1]!.sourceIdentitySha256) {
      throw new Error("duplicate telemetry source identity");
    }
  }
  return hash(["tenant-telemetry-source-accounting-entry-root-v1",
    ...sorted.map((entry) => entry.receiptSha256)]);
}
export function tenantTelemetrySourceAccountingUnknownRootSha256(
  entries: readonly TenantTelemetrySourceAccountingEntry[],
): string {
  return tenantTelemetrySourceAccountingEntryRootSha256(
    entries.filter((entry) => entry.classification === "unknown"),
  );
}
export function tenantTelemetrySourceAccountingReceiptSha256(
  body: TenantTelemetrySourceAccountingReceiptBody,
): string {
  validateTenantTelemetrySourceAccountingReceiptBody(body);
  return hash(["tenant-telemetry-source-accounting-receipt-v1",
    ...RECEIPT_KEYS.map((key) => body[key])]);
}
export function validateTenantTelemetrySourceAccountingReceiptBody(
  body: TenantTelemetrySourceAccountingReceiptBody,
): void {
  exactKeys(body, RECEIPT_KEYS, "telemetry source receipt body");
  validateIdentity(body);
  if (body.scope !== TENANT_TELEMETRY_SOURCE_ACCOUNTING_RECEIPT_SCOPE) {
    throw new Error("telemetry source receipt scope is invalid");
  }
  for (const key of ["t1FenceSha256", "t3cReceiptSha256", "planReceiptSha256",
    "entryRootSha256", "unknownRootSha256", "completedClaimTokenSha256"] as const) {
    digest(body[key], `telemetry source receipt ${key}`);
  }
  for (const key of ["inventoryCount", "writeJobCount", "writeAckCount",
    "membershipCount", "applicationBindingCount", "entryCount", "unknownCount",
    "storeDbTimestampMs"] as const) safeInt(body[key], `telemetry source receipt ${key}`);
  safeInt(body.completedClaimAttempt, "telemetry source claim attempt", 1);
  if (body.entryCount !== body.inventoryCount + body.writeJobCount + body.writeAckCount
    + body.membershipCount + body.applicationBindingCount
    || body.unknownCount > body.entryCount) {
    throw new Error("telemetry source receipt counts are inconsistent");
  }
}
export function validateTenantTelemetrySourceAccountingReceipt(
  receipt: TenantTelemetrySourceAccountingReceipt,
): void {
  exactKeys(receipt, [...RECEIPT_KEYS, "receiptSha256"], "telemetry source receipt");
  digest(receipt.receiptSha256, "telemetry source receipt hash");
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== tenantTelemetrySourceAccountingReceiptSha256(body)) {
    throw new Error("telemetry source receipt mismatch");
  }
}
export function validateTenantTelemetrySourceAccountingProof(
  job: TenantPurgePlanJobRecord,
  planReceipt: TenantPurgePlanReceipt,
  entries: readonly TenantTelemetrySourceAccountingEntry[],
  receipt: TenantTelemetrySourceAccountingReceipt,
): void {
  validateTenantTelemetrySourceAccountingReceipt(receipt);
  if (job.phase !== "plan_sealed" || job.requestId !== receipt.requestId
    || job.tenantId !== receipt.tenantId
    || job.subjectGeneration !== receipt.subjectGeneration
    || job.buildGeneration !== receipt.buildGeneration
    || job.aggregateReceiptSha256 !== planReceipt.receiptSha256
    || planReceipt.receiptSha256 !== receipt.planReceiptSha256
    || planReceipt.t1FenceSha256 !== receipt.t1FenceSha256
    || planReceipt.t3cReceiptSha256 !== receipt.t3cReceiptSha256
    || planReceipt.storeDbTimestampMs > receipt.storeDbTimestampMs
    || planReceipt.completedClaimAttempt !== receipt.completedClaimAttempt
    || planReceipt.completedClaimTokenSha256 !== receipt.completedClaimTokenSha256
    || entries.some((entry) => entry.requestId !== receipt.requestId
      || entry.tenantId !== receipt.tenantId
      || entry.subjectGeneration !== receipt.subjectGeneration
      || entry.buildGeneration !== receipt.buildGeneration
      || entry.capturedAtDbMs !== receipt.storeDbTimestampMs)
    || receipt.entryCount !== entries.length
    || receipt.inventoryCount !== entries.filter((entry) => entry.sourceKind === "inventory").length
    || receipt.writeJobCount !== entries.filter((entry) => entry.sourceKind === "write_job").length
    || receipt.writeAckCount !== entries.filter((entry) => entry.sourceKind === "write_ack").length
    || receipt.membershipCount !== entries.filter((entry) => entry.sourceKind === "membership").length
    || receipt.applicationBindingCount
      !== entries.filter((entry) => entry.sourceKind === "application_binding").length
    || receipt.unknownCount !== entries.filter((entry) => entry.classification === "unknown").length
    || receipt.entryRootSha256 !== tenantTelemetrySourceAccountingEntryRootSha256(entries)
    || receipt.unknownRootSha256 !== tenantTelemetrySourceAccountingUnknownRootSha256(entries)) {
    throw new Error("telemetry source accounting proof is incomplete");
  }
}

export function tenantTelemetrySourceAccountingJobEvidenceSha256(
  job: TenantTelemetryWriteJobRecord,
): string {
  validateTenantTelemetryWriteJobRecord(job);
  // The job is mutable until seal. Capture every validated field, including the exact target,
  // reservation, claim/lease, and terminal state, without persisting the raw record itself.
  return createHash("sha256")
    .update(canonicalJson(["tenant-telemetry-source-accounting-job-snapshot-v1", job]))
    .digest("hex");
}

/** Seal all five source projections, including their orphan rows. Mutable jobs are snapshotted. */
export function createTenantTelemetrySourceAccountingSnapshot(input: {
  job: TenantPurgePlanJobRecord;
  planReceipt: TenantPurgePlanReceipt;
  sources: TenantTelemetrySourceAccountingInputs;
  capturedAtDbMs: number;
}): { entries: TenantTelemetrySourceAccountingEntry[];
  receipt: TenantTelemetrySourceAccountingReceipt } {
  const { job, planReceipt, sources } = input;
  safeInt(input.capturedAtDbMs, "telemetry source snapshot time");
  if (job.phase !== "plan_sealed" || job.requestId !== planReceipt.requestId
    || job.tenantId !== planReceipt.tenantId
    || job.subjectGeneration !== planReceipt.subjectGeneration
    || job.buildGeneration !== planReceipt.buildGeneration) {
    throw new Error("telemetry source accounting requires an exact terminal T3d source");
  }
  if (input.capturedAtDbMs < planReceipt.storeDbTimestampMs) {
    throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
  }
  let sourceHighWaterDbMs = 0;
  for (const row of sources.inventories) {
    if (row.tenantId === job.tenantId) {
      sourceHighWaterDbMs = Math.max(sourceHighWaterDbMs,
        row.createdAtDbMs, row.sourceHighWaterDbMs);
    }
  }
  for (const row of sources.jobs) {
    if (row.tenantId === job.tenantId) {
      sourceHighWaterDbMs = Math.max(sourceHighWaterDbMs,
        row.createdAtMs, row.updatedAtMs, row.reservation?.startedAtDbMs ?? 0);
    }
  }
  for (const row of sources.acks) {
    if (row.tenantId === job.tenantId) {
      sourceHighWaterDbMs = Math.max(sourceHighWaterDbMs, row.storeDbTimestampMs);
    }
  }
  for (const row of sources.memberships) {
    if (row.tenantId === job.tenantId) {
      sourceHighWaterDbMs = Math.max(sourceHighWaterDbMs,
        row.inventoryCreatedAtDbMs, row.sourceHighWaterDbMs);
    }
  }
  for (const row of sources.bindings) {
    if (row.tenantId === job.tenantId) {
      sourceHighWaterDbMs = Math.max(sourceHighWaterDbMs, row.boundAtDbMs);
    }
  }
  if (input.capturedAtDbMs < sourceHighWaterDbMs) {
    throw new TenantPurgePlanNotReadyError("trusted_clock_before_evidence");
  }
  const inventoryById = new Map<string, TenantTelemetryArtifactInventoryRecord>();
  const jobByOperation = new Map<string, TenantTelemetryWriteJobRecord>();
  const ackByOperation = new Map<string, TenantTelemetryWriteAck>();
  const membershipByOperation = new Map<string, TenantTelemetryArtifactMembershipRecord>();
  const bindingByOperation = new Map<string, TenantTelemetryApplicationWriteBinding>();
  for (const inventory of sources.inventories) {
    validateTenantTelemetryArtifactInventory(inventory);
    if (inventoryById.has(inventory.inventorySha256)) throw new Error("duplicate telemetry inventory");
    inventoryById.set(inventory.inventorySha256, inventory);
  }
  for (const row of sources.jobs) {
    validateTenantTelemetryWriteJobRecord(row);
    if (jobByOperation.has(row.writeOperationSha256)) throw new Error("duplicate telemetry job");
    jobByOperation.set(row.writeOperationSha256, row);
  }
  for (const ack of sources.acks) {
    validateTenantTelemetryWriteAck(ack);
    if (ackByOperation.has(ack.writeOperationSha256)) throw new Error("duplicate telemetry ACK");
    ackByOperation.set(ack.writeOperationSha256, ack);
  }
  for (const membership of sources.memberships) {
    validateTenantTelemetryArtifactMembership(membership);
    if (membershipByOperation.has(membership.writeOperationSha256)) {
      throw new Error("duplicate telemetry membership");
    }
    membershipByOperation.set(membership.writeOperationSha256, membership);
  }
  for (const binding of sources.bindings) {
    validateTenantTelemetryApplicationWriteBinding(binding);
    if (bindingByOperation.has(binding.writeOperationSha256)) {
      throw new Error("duplicate telemetry application binding");
    }
    bindingByOperation.set(binding.writeOperationSha256, binding);
  }
  const reasonByOperation = new Map<string, TenantTelemetrySourceReason>();
  const inventoryToOperation = new Map<string, string>();
  for (const write of sources.jobs) {
    const inventoryId = write.inventory.inventorySha256;
    if (inventoryToOperation.has(inventoryId)) throw new Error("telemetry inventory has two jobs");
    inventoryToOperation.set(inventoryId, write.writeOperationSha256);
    const inventory = inventoryById.get(inventoryId);
    const ack = ackByOperation.get(write.writeOperationSha256);
    const membership = membershipByOperation.get(write.writeOperationSha256);
    const binding = bindingByOperation.get(write.writeOperationSha256);
    for (const source of [inventory, ack, membership, binding]) {
      if (source && source.tenantId !== write.tenantId) {
        throw new Error("cross-tenant telemetry source relation");
      }
    }
    if (inventory && (inventory.domain !== write.inventory.domain
      || inventory.receiptSha256 !== write.inventory.receiptSha256
      || inventory.inventorySha256 !== inventoryId)) {
      throw new Error("telemetry inventory and job disagree");
    }
    if (ack && (write.phase !== "written"
      || !write.reservation
      || ack.domain !== write.inventory.domain
      || ack.targetSha256 !== write.target.targetSha256
      || ack.targetReceiptSha256 !== write.target.receiptSha256
      || ack.inventorySha256 !== inventoryId
      || ack.inventoryReceiptSha256 !== write.inventory.receiptSha256
      || ack.artifactIdSha256 !== write.inventory.artifactIdSha256
      || ack.artifactGeneration !== write.inventory.artifactGeneration
      || ack.payloadSha256 !== write.inventory.payloadSha256
      || ack.manifestSha256 !== write.inventory.manifestSha256
      || ack.adapterProtocol !== write.target.adapterProtocol
      || ack.reservationReceiptSha256 !== write.reservation.receiptSha256
      || ack.mutationStartedAtDbMs !== write.reservation.startedAtDbMs
      || ack.mutationStartedClaimAttempt !== write.reservation.startedClaimAttempt
      || ack.mutationStartedClaimTokenSha256 !== write.reservation.startedClaimTokenSha256
      || ack.completedClaimAttempt !== write.completedClaimAttempt
      || ack.completedClaimTokenSha256 !== write.completedClaimTokenSha256
      || ack.storeDbTimestampMs !== write.writtenAtDbMs
      || ack.storeDbTimestampMs !== write.updatedAtMs
      || ack.receiptSha256 !== write.writeAckReceiptSha256)) {
      throw new Error("telemetry ACK and job disagree");
    }
    if (membership && inventory) {
      validateTenantTelemetryArtifactMembershipSource(membership, {
        writeOperationSha256: write.writeOperationSha256,
        jobCreatedAtMs: write.createdAtMs,
        inventory,
        refKeyIdSha256: membership.refKeyIdSha256,
        applicationBinding: binding ?? null,
      });
    }
    if (binding && (binding.writeOperationSha256 !== write.writeOperationSha256
      || binding.domain !== write.inventory.domain
      || binding.targetSha256 !== write.target.targetSha256
      || binding.targetReceiptSha256 !== write.target.receiptSha256
      || binding.lifecycleCoverageEvidenceSha256
        !== write.inventory.coverageEvidenceSha256
      || binding.inventorySha256 !== inventoryId
      || binding.manifestSha256 !== write.inventory.manifestSha256
      || binding.payloadSha256 !== write.inventory.payloadSha256
      || binding.boundAtDbMs !== write.createdAtMs)) {
      throw new Error("telemetry application binding and job disagree");
    }
    reasonByOperation.set(write.writeOperationSha256,
      !inventory ? "missing_inventory"
        : !membership ? "legacy_missing_membership"
          : write.phase !== "written" ? "incomplete_write"
            : !ack ? "missing_ack"
            : !binding ? "unbound_application" : "complete");
  }
  const rows: Array<{ kind: TenantTelemetrySourceKind; identity: string;
    operation: string | null; tenantId: string; domain: TenantTelemetryDomain;
    evidence: string; reason: TenantTelemetrySourceReason }> = [];
  for (const inventory of sources.inventories) rows.push({
    kind: "inventory", identity: inventory.inventorySha256,
    operation: inventoryToOperation.get(inventory.inventorySha256) ?? null,
    tenantId: inventory.tenantId, domain: inventory.domain,
    evidence: inventory.receiptSha256,
    reason: reasonByOperation.get(inventoryToOperation.get(inventory.inventorySha256) ?? "")
      ?? "orphan_source",
  });
  for (const write of sources.jobs) rows.push({
    kind: "write_job", identity: write.writeOperationSha256,
    operation: write.writeOperationSha256, tenantId: write.tenantId,
    domain: write.inventory.domain,
    evidence: tenantTelemetrySourceAccountingJobEvidenceSha256(write),
    reason: reasonByOperation.get(write.writeOperationSha256)!,
  });
  for (const ack of sources.acks) rows.push({
    kind: "write_ack", identity: ack.writeOperationSha256,
    operation: ack.writeOperationSha256, tenantId: ack.tenantId, domain: ack.domain,
    evidence: ack.receiptSha256,
    reason: reasonByOperation.get(ack.writeOperationSha256) ?? "orphan_source",
  });
  for (const membership of sources.memberships) rows.push({
    kind: "membership", identity: membership.writeOperationSha256,
    operation: membership.writeOperationSha256, tenantId: membership.tenantId,
    domain: membership.domain, evidence: membership.membershipSha256,
    reason: reasonByOperation.get(membership.writeOperationSha256) ?? "orphan_source",
  });
  for (const binding of sources.bindings) rows.push({
    kind: "application_binding", identity: binding.writeOperationSha256,
    operation: binding.writeOperationSha256, tenantId: binding.tenantId,
    domain: binding.domain, evidence: binding.receiptSha256,
    reason: reasonByOperation.get(binding.writeOperationSha256) ?? "orphan_source",
  });
  const entries = rows.filter((row) => row.tenantId === job.tenantId).map((row) => {
    const body: TenantTelemetrySourceAccountingEntryBody = {
      scope: TENANT_TELEMETRY_SOURCE_ACCOUNTING_ENTRY_SCOPE,
      requestId: job.requestId, tenantId: job.tenantId,
      subjectGeneration: job.subjectGeneration, buildGeneration: job.buildGeneration,
      sourceKind: row.kind, sourceIdentitySha256: row.identity,
      writeOperationSha256: row.operation, domain: row.domain,
      sourceEvidenceSha256: row.evidence,
      classification: row.reason === "complete" ? "accounted" : "unknown",
      reason: row.reason, capturedAtDbMs: input.capturedAtDbMs,
    };
    return { ...body, receiptSha256: tenantTelemetrySourceAccountingEntrySha256(body) };
  }).sort((a, b) => TENANT_TELEMETRY_SOURCE_KINDS.indexOf(a.sourceKind)
    - TENANT_TELEMETRY_SOURCE_KINDS.indexOf(b.sourceKind)
    || a.sourceIdentitySha256.localeCompare(b.sourceIdentitySha256));
  const body: TenantTelemetrySourceAccountingReceiptBody = {
    scope: TENANT_TELEMETRY_SOURCE_ACCOUNTING_RECEIPT_SCOPE,
    requestId: job.requestId, tenantId: job.tenantId,
    subjectGeneration: job.subjectGeneration, buildGeneration: job.buildGeneration,
    t1FenceSha256: planReceipt.t1FenceSha256,
    t3cReceiptSha256: planReceipt.t3cReceiptSha256,
    planReceiptSha256: planReceipt.receiptSha256,
    inventoryCount: entries.filter((e) => e.sourceKind === "inventory").length,
    writeJobCount: entries.filter((e) => e.sourceKind === "write_job").length,
    writeAckCount: entries.filter((e) => e.sourceKind === "write_ack").length,
    membershipCount: entries.filter((e) => e.sourceKind === "membership").length,
    applicationBindingCount: entries.filter((e) => e.sourceKind === "application_binding").length,
    entryCount: entries.length,
    entryRootSha256: tenantTelemetrySourceAccountingEntryRootSha256(entries),
    unknownCount: entries.filter((e) => e.classification === "unknown").length,
    unknownRootSha256: tenantTelemetrySourceAccountingUnknownRootSha256(entries),
    storeDbTimestampMs: input.capturedAtDbMs,
    completedClaimAttempt: planReceipt.completedClaimAttempt,
    completedClaimTokenSha256: planReceipt.completedClaimTokenSha256,
  };
  const receipt = { ...body,
    receiptSha256: tenantTelemetrySourceAccountingReceiptSha256(body) };
  validateTenantTelemetrySourceAccountingProof(job, planReceipt, entries, receipt);
  return { entries, receipt };
}

/** A missing receipt on a pre-0040 sealed plan means unknown, never an empty source set. */
export interface TenantTelemetrySourceAccountingStore {
  getTenantTelemetrySourceAccountingReceipt(
    tenantId: string, requestId: string,
  ): Promise<TenantTelemetrySourceAccountingReceipt | null>;
  getTenantTelemetrySourceAccountingEntries(
    tenantId: string, requestId: string,
  ): Promise<TenantTelemetrySourceAccountingEntry[]>;
}
