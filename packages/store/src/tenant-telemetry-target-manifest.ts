import { createHash } from "node:crypto";
import type { TenantPurgePlanJobRecord, TenantPurgePlanReceipt } from "./tenant-purge-plan.js";
import type { TenantTelemetryArtifactInventoryRecord, TenantTelemetryDomain,
  TenantTelemetryOwnerKind } from "./tenant-telemetry-lifecycle.js";
import type { TenantTelemetryArtifactMembershipRecord } from "./tenant-telemetry-artifact-membership.js";
import type { TenantTelemetryOwnerClosureEntry,
  TenantTelemetryOwnerClosureReceipt } from "./tenant-telemetry-owner-closure.js";
import { tenantTelemetryOwnerClosureEntryRootSha256,
  validateTenantTelemetryOwnerClosureReceipt } from "./tenant-telemetry-owner-closure.js";
import {
  TENANT_TELEMETRY_SOURCE_KINDS,
  validateTenantTelemetrySourceAccountingProof,
  type TenantTelemetrySourceAccountingEntry,
  type TenantTelemetrySourceAccountingInputs,
  type TenantTelemetrySourceAccountingReceipt,
  type TenantTelemetrySourceKind,
} from "./tenant-telemetry-source-accounting.js";

/** Observed targets are not T3d execution targets, locators, grants, or delete ACKs. */
export const TARGET_MANIFEST_ENTRY_SCOPE = "tenant-telemetry-target-manifest-entry-v1" as const;
export const TARGET_MANIFEST_RECEIPT_SCOPE = "tenant-telemetry-target-manifest-receipt-v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (value: unknown) => typeof value === "string" && SHA256.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Stable published group identity; this carries no owner or deletion authority. */
export function tenantTelemetryTargetManifestArtifactGroupSha256(
  tenantId: string, domain: TenantTelemetryDomain, inventorySha256: string,
): string {
  if (typeof tenantId !== "string" || tenantId.length < 1 || tenantId.length > 128
    || (domain !== "logs" && domain !== "traces") || !digest(inventorySha256)) {
    throw new Error("telemetry artifact group identity is invalid");
  }
  return hash(["tenant-telemetry-target-manifest-artifact-v1", tenantId,
    domain, inventorySha256]);
}
const keys = (value: object, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};
const ENTRY_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration",
  "buildGeneration", "sourceKind", "sourceIdentitySha256", "sourceReceiptSha256",
  "domain", "artifactGroupSha256", "inventorySha256", "writeOperationSha256",
  "artifactIdSha256", "artifactGeneration", "observedTargetSha256", "ownerKind",
  "ownerRefSha256", "holdSubjectRefSha256", "ownerBindingSha256", "liveOwnerClaimSha256",
  "classification", "groupSourceCount", "groupSourceRootSha256",
  "groupObservedTargetCount", "groupObservedTargetRootSha256", "capturedAtDbMs"] as const;
const RECEIPT_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration",
  "buildGeneration", "planReceiptSha256", "sourceAccountingReceiptSha256", "entryCount",
  "entryRootSha256", "artifactGroupCount", "artifactGroupRootSha256",
  "observedTargetCount", "observedTargetRootSha256", "unknownGroupCount",
  "unknownGroupRootSha256", "storeDbTimestampMs", "completedClaimAttempt",
  "completedClaimTokenSha256"] as const;

export interface TenantTelemetryTargetManifestEntryBody {
  scope: typeof TARGET_MANIFEST_ENTRY_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; buildGeneration: number;
  sourceKind: TenantTelemetrySourceKind; sourceIdentitySha256: string;
  sourceReceiptSha256: string; domain: TenantTelemetryDomain;
  artifactGroupSha256: string; inventorySha256: string | null;
  writeOperationSha256: string | null; artifactIdSha256: string | null;
  artifactGeneration: number | null; observedTargetSha256: string | null;
  ownerKind: TenantTelemetryOwnerKind | null; ownerRefSha256: string | null;
  holdSubjectRefSha256: string | null; ownerBindingSha256: string | null;
  liveOwnerClaimSha256: string | null; classification: "accounted" | "unknown";
  groupSourceCount: number; groupSourceRootSha256: string;
  groupObservedTargetCount: 0 | 1; groupObservedTargetRootSha256: string;
  capturedAtDbMs: number;
}
export interface TenantTelemetryTargetManifestEntry
  extends TenantTelemetryTargetManifestEntryBody { receiptSha256: string }
export interface TenantTelemetryTargetManifestReceiptBody {
  scope: typeof TARGET_MANIFEST_RECEIPT_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; buildGeneration: number;
  planReceiptSha256: string; sourceAccountingReceiptSha256: string;
  entryCount: number; entryRootSha256: string; artifactGroupCount: number;
  artifactGroupRootSha256: string; observedTargetCount: number;
  observedTargetRootSha256: string; unknownGroupCount: number;
  unknownGroupRootSha256: string; storeDbTimestampMs: number;
  completedClaimAttempt: number; completedClaimTokenSha256: string;
}
export interface TenantTelemetryTargetManifestReceipt
  extends TenantTelemetryTargetManifestReceiptBody { receiptSha256: string }

const sourceKey = (entry: { sourceKind: TenantTelemetrySourceKind;
  sourceIdentitySha256: string }) => JSON.stringify([
    entry.sourceKind, entry.sourceIdentitySha256]);
const order = (a: { sourceKind: TenantTelemetrySourceKind; sourceIdentitySha256: string },
  b: { sourceKind: TenantTelemetrySourceKind; sourceIdentitySha256: string }) =>
  TENANT_TELEMETRY_SOURCE_KINDS.indexOf(a.sourceKind)
    - TENANT_TELEMETRY_SOURCE_KINDS.indexOf(b.sourceKind)
    || a.sourceIdentitySha256.localeCompare(b.sourceIdentitySha256);
const groupTargetRoot = (target: string | null) => hash([
  "tenant-telemetry-target-manifest-group-target-root-v1", ...(target ? [target] : [])]);
const groupSourceRoot = (entries: readonly TenantTelemetryTargetManifestEntry[]) => hash([
  "tenant-telemetry-target-manifest-group-source-root-v1",
  ...[...entries].sort(order).map((entry) => [entry.sourceKind,
    entry.sourceIdentitySha256, entry.sourceReceiptSha256])]);
const groupsOf = (entries: readonly TenantTelemetryTargetManifestEntry[]) => {
  const groups = new Map<string, TenantTelemetryTargetManifestEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.artifactGroupSha256) ?? [];
    group.push(entry);
    groups.set(entry.artifactGroupSha256, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right));
};
const groupFields = (entry: TenantTelemetryTargetManifestEntry) => [
  entry.artifactGroupSha256, entry.inventorySha256, entry.writeOperationSha256,
  entry.artifactIdSha256, entry.artifactGeneration, entry.observedTargetSha256,
  entry.ownerKind, entry.ownerRefSha256, entry.holdSubjectRefSha256,
  entry.ownerBindingSha256, entry.liveOwnerClaimSha256, entry.classification,
  entry.groupSourceCount, entry.groupSourceRootSha256,
  entry.groupObservedTargetCount, entry.groupObservedTargetRootSha256];
const entryRoot = (entries: readonly TenantTelemetryTargetManifestEntry[]) => hash([
  "tenant-telemetry-target-manifest-entry-root-v1",
  ...[...entries].sort(order).map((entry) => entry.receiptSha256)]);
const groupRoot = (entries: readonly TenantTelemetryTargetManifestEntry[]) => hash([
  "tenant-telemetry-target-manifest-artifact-root-v1",
  ...groupsOf(entries).map(([, group]) => groupFields(group[0]!))]);
const observedRoot = (entries: readonly TenantTelemetryTargetManifestEntry[]) => hash([
  "tenant-telemetry-target-manifest-observed-root-v1",
  ...groupsOf(entries).filter(([, group]) => group[0]!.observedTargetSha256 !== null)
    .map(([, group]) => [group[0]!.artifactGroupSha256,
      group[0]!.observedTargetSha256])]);
const unknownRoot = (entries: readonly TenantTelemetryTargetManifestEntry[]) => hash([
  "tenant-telemetry-target-manifest-unknown-root-v1",
  ...groupsOf(entries).filter(([, group]) => group[0]!.classification === "unknown")
    .map(([key]) => key)]);

export function validateTenantTelemetryTargetManifestEntry(
  entry: TenantTelemetryTargetManifestEntry,
): void {
  if (!keys(entry, [...ENTRY_KEYS, "receiptSha256"])) throw new Error("manifest entry shape");
  const { receiptSha256, ...body } = entry;
  if (body.scope !== TARGET_MANIFEST_ENTRY_SCOPE
    || !digest(body.sourceIdentitySha256) || !digest(body.sourceReceiptSha256)
    || !digest(body.artifactGroupSha256) || !digest(body.groupSourceRootSha256)
    || !digest(body.groupObservedTargetRootSha256)
    || !(TENANT_TELEMETRY_SOURCE_KINDS as readonly string[]).includes(body.sourceKind)
    || (body.domain !== "logs" && body.domain !== "traces")
    || !Number.isSafeInteger(body.groupSourceCount) || body.groupSourceCount < 1
    || !Number.isSafeInteger(body.capturedAtDbMs) || body.capturedAtDbMs < 0
    || (body.groupObservedTargetCount !== 0 && body.groupObservedTargetCount !== 1)
    || (body.classification !== "accounted" && body.classification !== "unknown")
    || (body.classification === "accounted") !== (body.observedTargetSha256 !== null)
    || body.groupObservedTargetRootSha256 !== groupTargetRoot(body.observedTargetSha256)
    || !digest(receiptSha256)
    || receiptSha256 !== hash(["tenant-telemetry-target-manifest-entry-receipt-v1",
      ...ENTRY_KEYS.map((key) => body[key])])) throw new Error("manifest entry receipt");
  for (const key of ["inventorySha256", "writeOperationSha256", "artifactIdSha256",
    "observedTargetSha256", "ownerRefSha256", "holdSubjectRefSha256",
    "ownerBindingSha256", "liveOwnerClaimSha256"] as const) {
    if (body[key] !== null && !digest(body[key])) throw new Error("manifest digest");
  }
  if (body.inventorySha256 === null) {
    if (body.artifactIdSha256 !== null || body.artifactGeneration !== null
      || body.observedTargetSha256 !== null || body.ownerKind !== null
      || body.ownerRefSha256 !== null || body.holdSubjectRefSha256 !== null
      || body.ownerBindingSha256 !== null || body.liveOwnerClaimSha256 !== null
      || body.groupObservedTargetCount !== 0 || body.classification !== "unknown") {
      throw new Error("orphan manifest carries target or owner authority");
    }
  } else if (!Number.isSafeInteger(body.artifactGeneration)
    || body.artifactGeneration! < 1 || body.artifactIdSha256 === null) {
    throw new Error("invalid artifact identity");
  }
  const owner = [body.ownerKind, body.ownerRefSha256, body.holdSubjectRefSha256,
    body.ownerBindingSha256, body.liveOwnerClaimSha256];
  if (owner.some((field) => field === null) && owner.some((field) => field !== null)) {
    throw new Error("partial owner claim");
  }
  if (body.ownerKind !== null && body.ownerKind !== "tenant"
    && body.ownerKind !== "user" && body.ownerKind !== "session") {
    throw new Error("invalid owner kind");
  }
  if ((body.observedTargetSha256 === null) !== (body.groupObservedTargetCount === 0)) {
    throw new Error("observed target count mismatch");
  }
}
export function tenantTelemetryTargetManifestEntrySha256(
  body: TenantTelemetryTargetManifestEntryBody,
): string {
  const receiptSha256 = hash(["tenant-telemetry-target-manifest-entry-receipt-v1",
    ...ENTRY_KEYS.map((key) => body[key])]);
  validateTenantTelemetryTargetManifestEntry({ ...body, receiptSha256 });
  return receiptSha256;
}
export function validateTenantTelemetryTargetManifestReceipt(
  receipt: TenantTelemetryTargetManifestReceipt,
): void {
  if (!keys(receipt, [...RECEIPT_KEYS, "receiptSha256"])) throw new Error("manifest receipt shape");
  const { receiptSha256, ...body } = receipt;
  if (body.scope !== TARGET_MANIFEST_RECEIPT_SCOPE || !digest(receiptSha256)
    || receiptSha256 !== hash(["tenant-telemetry-target-manifest-receipt-v1",
      ...RECEIPT_KEYS.map((key) => body[key])])) throw new Error("manifest receipt hash");
  for (const key of ["planReceiptSha256", "sourceAccountingReceiptSha256",
    "entryRootSha256", "artifactGroupRootSha256", "observedTargetRootSha256",
    "unknownGroupRootSha256", "completedClaimTokenSha256"] as const) {
    if (!digest(body[key])) throw new Error("manifest receipt digest");
  }
  for (const key of ["entryCount", "artifactGroupCount", "observedTargetCount",
    "unknownGroupCount", "storeDbTimestampMs"] as const) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0) throw new Error("manifest count");
  }
  if (!Number.isSafeInteger(body.completedClaimAttempt) || body.completedClaimAttempt < 1
    || body.artifactGroupCount > body.entryCount
    || body.observedTargetCount + body.unknownGroupCount !== body.artifactGroupCount) {
    throw new Error("manifest aggregate counts");
  }
}
export function tenantTelemetryTargetManifestReceiptSha256(
  body: TenantTelemetryTargetManifestReceiptBody,
): string {
  const receiptSha256 = hash(["tenant-telemetry-target-manifest-receipt-v1",
    ...RECEIPT_KEYS.map((key) => body[key])]);
  validateTenantTelemetryTargetManifestReceipt({ ...body, receiptSha256 });
  return receiptSha256;
}

/** Exact one-to-one coverage of 0040, including every orphan and unknown row. */
export function validateTenantTelemetryTargetManifestProof(input: {
  job: TenantPurgePlanJobRecord; planReceipt: TenantPurgePlanReceipt;
  sourceEntries: readonly TenantTelemetrySourceAccountingEntry[];
  sourceReceipt: TenantTelemetrySourceAccountingReceipt;
  entries: readonly TenantTelemetryTargetManifestEntry[];
  receipt: TenantTelemetryTargetManifestReceipt;
}): void {
  const { job, planReceipt, sourceEntries, sourceReceipt, entries, receipt } = input;
  validateTenantTelemetrySourceAccountingProof(job, planReceipt, sourceEntries, sourceReceipt);
  validateTenantTelemetryTargetManifestReceipt(receipt);
  if (job.phase !== "plan_sealed" || receipt.requestId !== job.requestId
    || receipt.tenantId !== job.tenantId
    || receipt.subjectGeneration !== job.subjectGeneration
    || receipt.buildGeneration !== job.buildGeneration
    || receipt.planReceiptSha256 !== planReceipt.receiptSha256
    || receipt.sourceAccountingReceiptSha256 !== sourceReceipt.receiptSha256
    || receipt.storeDbTimestampMs !== sourceReceipt.storeDbTimestampMs
    || receipt.completedClaimAttempt !== sourceReceipt.completedClaimAttempt
    || receipt.completedClaimTokenSha256 !== sourceReceipt.completedClaimTokenSha256
    || receipt.entryCount !== sourceEntries.length || entries.length !== sourceEntries.length) {
    throw new Error("manifest does not bind exact T3d source");
  }
  const sources = new Map(sourceEntries.map((entry) => [sourceKey(entry), entry]));
  const seen = new Set<string>();
  for (const entry of entries) {
    validateTenantTelemetryTargetManifestEntry(entry);
    const key = sourceKey(entry);
    const source = sources.get(key);
    if (!source || seen.has(key) || source.receiptSha256 !== entry.sourceReceiptSha256
      || source.domain !== entry.domain || source.requestId !== entry.requestId
      || source.tenantId !== entry.tenantId
      || source.writeOperationSha256 !== entry.writeOperationSha256
      || source.subjectGeneration !== entry.subjectGeneration
      || source.buildGeneration !== entry.buildGeneration
      || entry.capturedAtDbMs !== receipt.storeDbTimestampMs
      || (source.classification === "unknown" && entry.classification !== "unknown")) {
      throw new Error("manifest source link missing, duplicated, or promoted");
    }
    seen.add(key);
  }
  if (seen.size !== sources.size) throw new Error("manifest omits source entry");
  for (const [, group] of groupsOf(entries)) {
    const first = group[0]!;
    const expectedGroupId = first.inventorySha256
      ? tenantTelemetryTargetManifestArtifactGroupSha256(first.tenantId,
        first.domain, first.inventorySha256)
      : hash(["tenant-telemetry-target-manifest-orphan-v1", first.tenantId,
        first.domain, first.writeOperationSha256,
        first.sourceKind === "inventory" ? first.sourceIdentitySha256 : null]);
    const completeKinds = ["inventory", "write_job", "write_ack", "membership",
      "application_binding"] as const;
    if (group.some((entry) => JSON.stringify(groupFields(entry))
      !== JSON.stringify(groupFields(first)) || entry.domain !== first.domain)
      || first.artifactGroupSha256 !== expectedGroupId
      || first.groupSourceCount !== group.length
      || first.groupSourceRootSha256 !== groupSourceRoot(group)
      || (first.inventorySha256 === null
        ? group.some((entry) => entry.sourceKind === "inventory")
        : group.filter((entry) => entry.sourceKind === "inventory"
          && entry.sourceIdentitySha256 === first.inventorySha256).length !== 1)
      || (first.classification === "accounted"
        && (group.length !== completeKinds.length
          || completeKinds.some((kind) => group.filter((entry) =>
            entry.sourceKind === kind && (kind === "inventory"
              ? entry.sourceIdentitySha256 === first.inventorySha256
              : entry.sourceIdentitySha256 === first.writeOperationSha256)).length !== 1)
          || group.some((entry) => sources.get(sourceKey(entry))!.classification !== "accounted")))) {
      throw new Error("manifest artifact group incomplete");
    }
  }
  if (receipt.entryRootSha256 !== entryRoot(entries)
    || receipt.artifactGroupCount !== groupsOf(entries).length
    || receipt.artifactGroupRootSha256 !== groupRoot(entries)
    || receipt.observedTargetCount !== groupsOf(entries)
      .filter(([, group]) => group[0]!.observedTargetSha256 !== null).length
    || receipt.observedTargetRootSha256 !== observedRoot(entries)
    || receipt.unknownGroupCount !== groupsOf(entries)
      .filter(([, group]) => group[0]!.classification === "unknown").length
    || receipt.unknownGroupRootSha256 !== unknownRoot(entries)) {
    throw new Error("manifest aggregate root mismatch");
  }
}

export const tenantTelemetryLiveOwnerClaimSha256 =
  (membership: TenantTelemetryArtifactMembershipRecord) => hash([
    "tenant-telemetry-target-manifest-live-owner-claim-v1", membership.membershipSha256,
    membership.ownerKind, membership.ownerRefSha256, membership.holdSubjectRefSha256,
    membership.ownerBindingSha256, membership.refKeyIdSha256]);

/** Compare every observed target to retained immutable inventory/write/ACK/membership/binding. */
export function validateTenantTelemetryObservedTargetRelations(
  entries: readonly TenantTelemetryTargetManifestEntry[],
  sources: TenantTelemetrySourceAccountingInputs,
): void {
  const inventories = new Map(sources.inventories.map((row) => [row.inventorySha256, row]));
  const jobs = new Map(sources.jobs.map((row) => [row.writeOperationSha256, row]));
  const acks = new Map(sources.acks.map((row) => [row.writeOperationSha256, row]));
  const memberships = new Map(sources.memberships.map((row) => [row.writeOperationSha256, row]));
  const bindings = new Map(sources.bindings.map((row) => [row.writeOperationSha256, row]));
  for (const [, group] of groupsOf(entries)) {
    const entry = group[0]!;
    if (entry.classification !== "accounted") continue;
    const inventory = entry.inventorySha256 ? inventories.get(entry.inventorySha256) : undefined;
    const operation = entry.writeOperationSha256;
    const job = operation ? jobs.get(operation) : undefined;
    const ack = operation ? acks.get(operation) : undefined;
    const membership = operation ? memberships.get(operation) : undefined;
    const binding = operation ? bindings.get(operation) : undefined;
    if (!inventory || !job || !ack || !membership || !binding
      || inventory.tenantId !== entry.tenantId || inventory.domain !== entry.domain
      || inventory.artifactIdSha256 !== entry.artifactIdSha256
      || inventory.artifactGeneration !== entry.artifactGeneration
      || inventory.targetSha256 !== entry.observedTargetSha256
      || job.tenantId !== entry.tenantId || job.phase !== "written"
      || job.inventory.inventorySha256 !== inventory.inventorySha256
      || job.target.targetSha256 !== inventory.targetSha256
      || ack.tenantId !== entry.tenantId
      || ack.inventorySha256 !== inventory.inventorySha256
      || ack.targetSha256 !== inventory.targetSha256
      || membership.tenantId !== entry.tenantId
      || membership.inventorySha256 !== inventory.inventorySha256
      || membership.targetSha256 !== inventory.targetSha256
      || membership.ownerKind !== entry.ownerKind
      || membership.ownerRefSha256 !== entry.ownerRefSha256
      || membership.holdSubjectRefSha256 !== entry.holdSubjectRefSha256
      || membership.ownerBindingSha256 !== entry.ownerBindingSha256
      || tenantTelemetryLiveOwnerClaimSha256(membership) !== entry.liveOwnerClaimSha256
      || binding.tenantId !== entry.tenantId
      || binding.inventorySha256 !== inventory.inventorySha256
      || binding.targetSha256 !== inventory.targetSha256) {
      throw new Error("observed target no longer has exact immutable source relations");
    }
  }
}

/** The store has already verified liveOwnerOperations against canonical rows under its seal lock. */
export function createTenantTelemetryTargetManifestSnapshot(input: {
  job: TenantPurgePlanJobRecord; planReceipt: TenantPurgePlanReceipt;
  sourceEntries: readonly TenantTelemetrySourceAccountingEntry[];
  sourceReceipt: TenantTelemetrySourceAccountingReceipt;
  sources: TenantTelemetrySourceAccountingInputs;
  liveOwnerOperations: ReadonlySet<string>;
}): { entries: TenantTelemetryTargetManifestEntry[];
  receipt: TenantTelemetryTargetManifestReceipt } {
  const { job, planReceipt, sourceEntries, sourceReceipt, sources } = input;
  validateTenantTelemetrySourceAccountingProof(job, planReceipt, sourceEntries, sourceReceipt);
  const inventories = new Map(sources.inventories.filter((row) => row.tenantId === job.tenantId)
    .map((row) => [row.inventorySha256, row]));
  const jobs = new Map(sources.jobs.filter((row) => row.tenantId === job.tenantId)
    .map((row) => [row.writeOperationSha256, row]));
  const acks = new Map(sources.acks.filter((row) => row.tenantId === job.tenantId)
    .map((row) => [row.writeOperationSha256, row]));
  const memberships = new Map(sources.memberships.filter((row) => row.tenantId === job.tenantId)
    .map((row) => [row.writeOperationSha256, row]));
  const bindings = new Map(sources.bindings.filter((row) => row.tenantId === job.tenantId)
    .map((row) => [row.writeOperationSha256, row]));
  const operationByInventory = new Map<string, string>();
  for (const write of jobs.values()) {
    if (inventories.has(write.inventory.inventorySha256)) {
      operationByInventory.set(write.inventory.inventorySha256, write.writeOperationSha256);
    }
  }
  const groups = new Map<string, { inventory: TenantTelemetryArtifactInventoryRecord | null;
    operation: string | null; sources: TenantTelemetrySourceAccountingEntry[] }>();
  for (const source of sourceEntries) {
    const operation = source.writeOperationSha256;
    const inventoryId = source.sourceKind === "inventory"
      ? source.sourceIdentitySha256
      : operation ? jobs.get(operation)?.inventory.inventorySha256 : undefined;
    const candidate = inventoryId ? inventories.get(inventoryId) : undefined;
    const inventory = candidate?.domain === source.domain ? candidate : null;
    const groupId = inventory
      ? tenantTelemetryTargetManifestArtifactGroupSha256(job.tenantId,
        source.domain, inventory.inventorySha256)
      : hash(["tenant-telemetry-target-manifest-orphan-v1", job.tenantId,
        source.domain, operation, source.sourceKind === "inventory"
          ? source.sourceIdentitySha256 : null]);
    const group = groups.get(groupId) ?? { inventory,
      operation: inventory ? operationByInventory.get(inventory.inventorySha256) ?? null
        : operation, sources: [] };
    group.sources.push(source);
    groups.set(groupId, group);
  }
  const entries: TenantTelemetryTargetManifestEntry[] = [];
  for (const [groupId, group] of groups) {
    const { inventory, operation } = group;
    const membership = operation ? memberships.get(operation) : undefined;
    const complete = !!inventory && !!operation && !!jobs.get(operation)
      && !!acks.get(operation) && !!membership && !!bindings.get(operation)
      && group.sources.length === 5
      && group.sources.every((source) => source.classification === "accounted")
      && input.liveOwnerOperations.has(operation)
      && membership.inventorySha256 === inventory.inventorySha256
      && membership.targetSha256 === inventory.targetSha256
      && membership.ownerKind === inventory.ownerKind
      && membership.ownerRefSha256 === inventory.ownerRefSha256
      && membership.holdSubjectRefSha256 === inventory.holdSubjectRefSha256;
    const target = complete ? inventory.targetSha256 : null;
    const sourceRoot = hash(["tenant-telemetry-target-manifest-group-source-root-v1",
      ...[...group.sources].sort(order).map((source) => [source.sourceKind,
        source.sourceIdentitySha256, source.receiptSha256])]);
    for (const source of group.sources) {
      const body: TenantTelemetryTargetManifestEntryBody = {
        scope: TARGET_MANIFEST_ENTRY_SCOPE, requestId: job.requestId, tenantId: job.tenantId,
        subjectGeneration: job.subjectGeneration, buildGeneration: job.buildGeneration,
        sourceKind: source.sourceKind, sourceIdentitySha256: source.sourceIdentitySha256,
        sourceReceiptSha256: source.receiptSha256, domain: source.domain,
        artifactGroupSha256: groupId, inventorySha256: inventory?.inventorySha256 ?? null,
        writeOperationSha256: operation, artifactIdSha256: inventory?.artifactIdSha256 ?? null,
        artifactGeneration: inventory?.artifactGeneration ?? null, observedTargetSha256: target,
        ownerKind: complete ? membership!.ownerKind : null,
        ownerRefSha256: complete ? membership!.ownerRefSha256 : null,
        holdSubjectRefSha256: complete ? membership!.holdSubjectRefSha256 : null,
        ownerBindingSha256: complete ? membership!.ownerBindingSha256 : null,
        liveOwnerClaimSha256: complete ? tenantTelemetryLiveOwnerClaimSha256(membership!) : null,
        classification: complete ? "accounted" : "unknown",
        groupSourceCount: group.sources.length, groupSourceRootSha256: sourceRoot,
        groupObservedTargetCount: complete ? 1 : 0,
        groupObservedTargetRootSha256: groupTargetRoot(target),
        capturedAtDbMs: sourceReceipt.storeDbTimestampMs,
      };
      entries.push({ ...body, receiptSha256: tenantTelemetryTargetManifestEntrySha256(body) });
    }
  }
  entries.sort(order);
  const body: TenantTelemetryTargetManifestReceiptBody = {
    scope: TARGET_MANIFEST_RECEIPT_SCOPE, requestId: job.requestId,
    tenantId: job.tenantId, subjectGeneration: job.subjectGeneration,
    buildGeneration: job.buildGeneration, planReceiptSha256: planReceipt.receiptSha256,
    sourceAccountingReceiptSha256: sourceReceipt.receiptSha256,
    entryCount: entries.length, entryRootSha256: entryRoot(entries),
    artifactGroupCount: groupsOf(entries).length, artifactGroupRootSha256: groupRoot(entries),
    observedTargetCount: groupsOf(entries).filter(([, group]) =>
      group[0]!.observedTargetSha256 !== null).length,
    observedTargetRootSha256: observedRoot(entries),
    unknownGroupCount: groupsOf(entries).filter(([, group]) =>
      group[0]!.classification === "unknown").length,
    unknownGroupRootSha256: unknownRoot(entries),
    storeDbTimestampMs: sourceReceipt.storeDbTimestampMs,
    completedClaimAttempt: sourceReceipt.completedClaimAttempt,
    completedClaimTokenSha256: sourceReceipt.completedClaimTokenSha256,
  };
  const receipt = { ...body, receiptSha256: tenantTelemetryTargetManifestReceiptSha256(body) };
  validateTenantTelemetryTargetManifestProof({
    job, planReceipt, sourceEntries, sourceReceipt, entries, receipt,
  });
  return { entries, receipt };
}

export interface TenantTelemetryTargetSourceReadiness {
  sourceRelationsComplete: boolean; ownerClosureComplete: boolean;
  observedTargetCount: number; unknownArtifactGroupCount: number;
  executionReady: false;
}
/** Read-only; no external mutation or deletion authority can be derived from this result. */
export function verifyTenantTelemetryTargetSourceReadiness(input: {
  job: TenantPurgePlanJobRecord; planReceipt: TenantPurgePlanReceipt;
  sourceEntries: readonly TenantTelemetrySourceAccountingEntry[];
  sourceReceipt: TenantTelemetrySourceAccountingReceipt;
  entries: readonly TenantTelemetryTargetManifestEntry[];
  receipt: TenantTelemetryTargetManifestReceipt;
  closureReceipt: TenantTelemetryOwnerClosureReceipt | null;
  closureEntries: readonly TenantTelemetryOwnerClosureEntry[];
  graveMarkerSha256s: ReadonlySet<string>;
  t3fReceiptSha256: string | null;
}): TenantTelemetryTargetSourceReadiness {
  validateTenantTelemetryTargetManifestProof(input);
  const known = groupsOf(input.entries).map(([, group]) => group[0]!)
    .filter((entry) => entry.classification === "accounted");
  const closure = input.closureReceipt;
  const byOperation = new Map(input.closureEntries.map((entry) => [
    entry.writeOperationSha256, entry]));
  let ownerClosureComplete = closure !== null && input.t3fReceiptSha256 !== null
    && closure.requestId === input.job.requestId
    && closure.tenantId === input.job.tenantId
    && closure.planReceiptSha256 === input.planReceipt.receiptSha256
    && closure.t3fReceiptSha256 === input.t3fReceiptSha256
    && closure.entryCount === input.closureEntries.length
    && byOperation.size === input.closureEntries.length;
  if (closure) {
    validateTenantTelemetryOwnerClosureReceipt(closure);
    if (closure.entryRootSha256
      !== tenantTelemetryOwnerClosureEntryRootSha256(input.closureEntries)) {
      ownerClosureComplete = false;
    }
  } else if (input.closureEntries.length !== 0) {
    ownerClosureComplete = false;
  }
  for (const entry of known) {
    const closed = entry.writeOperationSha256
      ? byOperation.get(entry.writeOperationSha256) : undefined;
    if (!closed || closed.inventorySha256 !== entry.inventorySha256
      || closed.ownerKind !== entry.ownerKind
      || closed.ownerRefSha256 !== entry.ownerRefSha256
      || closed.holdSubjectRefSha256 !== entry.holdSubjectRefSha256
      || closed.ownerBindingSha256 !== entry.ownerBindingSha256
      || hash(["tenant-telemetry-target-manifest-live-owner-claim-v1",
        closed.membershipSha256, closed.ownerKind, closed.ownerRefSha256,
        closed.holdSubjectRefSha256, closed.ownerBindingSha256,
        closed.refKeyIdSha256]) !== entry.liveOwnerClaimSha256
      || (closed.ownerKind === "session"
        && (closed.sessionGraveMarkerSha256 === null
          || !input.graveMarkerSha256s.has(closed.sessionGraveMarkerSha256)))) {
      ownerClosureComplete = false;
    }
  }
  return { sourceRelationsComplete: input.receipt.unknownGroupCount === 0,
    ownerClosureComplete, observedTargetCount: input.receipt.observedTargetCount,
    unknownArtifactGroupCount: input.receipt.unknownGroupCount, executionReady: false };
}

/** A pre-0041 terminal without the receipt is unknown, never an empty target set. */
export interface TenantTelemetryTargetManifestStore {
  getTenantTelemetryTargetManifestReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryTargetManifestReceipt | null>;
  getTenantTelemetryTargetManifestEntries(tenantId: string, requestId: string):
    Promise<TenantTelemetryTargetManifestEntry[]>;
  getTenantTelemetryTargetSourceReadiness(tenantId: string, requestId: string):
    Promise<TenantTelemetryTargetSourceReadiness | null>;
}
