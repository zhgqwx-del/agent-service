import { createHash } from "node:crypto";
import type { TenantPurgePlanEntry, TenantPurgePlanJobRecord,
  TenantPurgePlanReceipt } from "./tenant-purge-plan.js";
import { tenantTelemetryDispositionInventoryTargetRootSha256,
  type TenantTelemetryDispositionPlanTarget } from "./tenant-telemetry-disposition.js";
import type { TenantTelemetryDomain, TenantTelemetryOwnerKind } from "./tenant-telemetry-lifecycle.js";
import { TENANT_TELEMETRY_SOURCE_KINDS,
  tenantTelemetrySourceAccountingJobEvidenceSha256,
  validateTenantTelemetrySourceAccountingProof,
  type TenantTelemetrySourceAccountingEntry,
  type TenantTelemetrySourceAccountingInputs,
  type TenantTelemetrySourceAccountingReceipt } from "./tenant-telemetry-source-accounting.js";
import { tenantTelemetryLiveOwnerClaimSha256,
  validateTenantTelemetryTargetManifestProof,
  validateTenantTelemetryObservedTargetRelations,
  type TenantTelemetryTargetManifestEntry,
  type TenantTelemetryTargetManifestReceipt } from "./tenant-telemetry-target-manifest.js";

/** A source-valid catalog is not a T3d execution target, deletion grant, or locator. */
export const PLAN_ARTIFACT_TARGET_SCOPE = "tenant-telemetry-plan-artifact-target-v1" as const;
export const PLAN_ARTIFACT_TARGET_RECEIPT_SCOPE =
  "tenant-telemetry-plan-artifact-target-receipt-v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exactKeys = (value: object, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};
const ENTRY_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration", "buildGeneration",
  "domain", "targetSha256", "targetReceiptSha256", "artifactIdSha256",
  "artifactGeneration", "inventorySha256", "inventoryReceiptSha256",
  "writeOperationSha256", "writeAckReceiptSha256", "membershipSha256",
  "applicationBindingReceiptSha256", "payloadSha256", "manifestSha256",
  "lifecycleCoverageEvidenceSha256", "applicationCoverageEvidenceSha256",
  "ownerKind", "ownerRefSha256", "holdSubjectRefSha256", "ownerBindingSha256",
  "liveOwnerClaimSha256", "artifactGroupSha256", "sourceGroupRootSha256",
  "capturedAtDbMs"] as const;
const RECEIPT_KEYS = ["scope", "requestId", "tenantId", "subjectGeneration",
  "buildGeneration", "planReceiptSha256", "sourceAccountingReceiptSha256",
  "targetManifestReceiptSha256", "targetCount", "targetRootSha256",
  "logsTargetCount", "logsTargetRootSha256", "tracesTargetCount",
  "tracesTargetRootSha256", "unknownGroupCount", "unknownGroupRootSha256",
  "storeDbTimestampMs", "completedClaimAttempt", "completedClaimTokenSha256",
  "executionReady"] as const;

export interface TenantTelemetryPlanArtifactTargetBody {
  scope: typeof PLAN_ARTIFACT_TARGET_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; buildGeneration: number;
  domain: TenantTelemetryDomain; targetSha256: string; targetReceiptSha256: string;
  artifactIdSha256: string; artifactGeneration: number;
  inventorySha256: string; inventoryReceiptSha256: string;
  writeOperationSha256: string; writeAckReceiptSha256: string;
  membershipSha256: string; applicationBindingReceiptSha256: string;
  payloadSha256: string; manifestSha256: string;
  lifecycleCoverageEvidenceSha256: string; applicationCoverageEvidenceSha256: string;
  ownerKind: TenantTelemetryOwnerKind; ownerRefSha256: string;
  holdSubjectRefSha256: string; ownerBindingSha256: string;
  liveOwnerClaimSha256: string; artifactGroupSha256: string;
  sourceGroupRootSha256: string; capturedAtDbMs: number;
}
export interface TenantTelemetryPlanArtifactTarget extends TenantTelemetryPlanArtifactTargetBody {
  receiptSha256: string;
}
export interface TenantTelemetryPlanArtifactTargetReceiptBody {
  scope: typeof PLAN_ARTIFACT_TARGET_RECEIPT_SCOPE;
  requestId: string; tenantId: string; subjectGeneration: number; buildGeneration: number;
  planReceiptSha256: string; sourceAccountingReceiptSha256: string;
  targetManifestReceiptSha256: string; targetCount: number; targetRootSha256: string;
  logsTargetCount: number; logsTargetRootSha256: string;
  tracesTargetCount: number; tracesTargetRootSha256: string;
  unknownGroupCount: number; unknownGroupRootSha256: string;
  storeDbTimestampMs: number; completedClaimAttempt: number;
  completedClaimTokenSha256: string; executionReady: false;
}
export interface TenantTelemetryPlanArtifactTargetReceipt
  extends TenantTelemetryPlanArtifactTargetReceiptBody { receiptSha256: string }

const entryOrder = (left: TenantTelemetryPlanArtifactTarget,
  right: TenantTelemetryPlanArtifactTarget) =>
  left.artifactGroupSha256.localeCompare(right.artifactGroupSha256);
const targetRoot = (entries: readonly TenantTelemetryPlanArtifactTarget[]) => hash([
  "tenant-telemetry-plan-artifact-target-root-v1",
  ...[...entries].sort(entryOrder).map((entry) => entry.receiptSha256),
]);
const domainTargets = (entries: readonly TenantTelemetryPlanArtifactTarget[],
  domain: TenantTelemetryDomain): TenantTelemetryDispositionPlanTarget[] =>
  entries.filter((entry) => entry.domain === domain).map((entry) => ({
    domain, targetSha256: entry.targetSha256, artifactIdSha256: entry.artifactIdSha256,
    artifactGeneration: entry.artifactGeneration,
    inventoryReceiptSha256: entry.inventoryReceiptSha256,
    writeAckReceiptSha256: entry.writeAckReceiptSha256,
  }));
const sourceKey = (source: { sourceKind: string; sourceIdentitySha256: string }) =>
  JSON.stringify([source.sourceKind, source.sourceIdentitySha256]);
const sourceGroupRoot = (sources: readonly TenantTelemetrySourceAccountingEntry[]) => hash([
  "tenant-telemetry-target-manifest-group-source-root-v1",
  ...[...sources].sort((left, right) =>
    TENANT_TELEMETRY_SOURCE_KINDS.indexOf(left.sourceKind)
      - TENANT_TELEMETRY_SOURCE_KINDS.indexOf(right.sourceKind)
    || left.sourceIdentitySha256.localeCompare(right.sourceIdentitySha256))
    .map((source) => [source.sourceKind, source.sourceIdentitySha256, source.receiptSha256]),
]);

/**
 * Projection for the new T3d entries. It deliberately has no T3d, 0040, or 0041 receipt
 * input: those receipts are downstream of the plan target root. The caller holds the five
 * source ranges and canonical owner rows through terminal publication.
 */
export function projectTenantTelemetryPreplanTargets(input: {
  tenantId: string; sources: TenantTelemetrySourceAccountingInputs;
  liveOwnerOperations: ReadonlySet<string>;
}): { logs: TenantTelemetryDispositionPlanTarget[];
  traces: TenantTelemetryDispositionPlanTarget[] } {
  const jobs = new Map<string, TenantTelemetrySourceAccountingInputs["jobs"][number]>();
  for (const job of input.sources.jobs) {
    if (job.tenantId !== input.tenantId) continue;
    const inventoryId = job.inventory.inventorySha256;
    if (jobs.has(inventoryId)) {
      throw new Error("telemetry inventory has two write jobs");
    }
    jobs.set(inventoryId, job);
  }
  const acks = new Map(input.sources.acks.filter((row) => row.tenantId === input.tenantId)
    .map((row) => [row.writeOperationSha256, row]));
  const memberships = new Map(input.sources.memberships.filter((row) =>
    row.tenantId === input.tenantId).map((row) => [row.writeOperationSha256, row]));
  const bindings = new Map(input.sources.bindings.filter((row) =>
    row.tenantId === input.tenantId).map((row) => [row.writeOperationSha256, row]));
  const result: { logs: TenantTelemetryDispositionPlanTarget[];
    traces: TenantTelemetryDispositionPlanTarget[] } = { logs: [], traces: [] };
  for (const inventory of input.sources.inventories) {
    if (inventory.tenantId !== input.tenantId) continue;
    const job = jobs.get(inventory.inventorySha256);
    if (!job || job.phase !== "written" || !job.reservation) continue;
    const operation = job.writeOperationSha256;
    const ack = acks.get(operation);
    const membership = memberships.get(operation);
    const binding = bindings.get(operation);
    if (!ack || !membership || !binding || !input.liveOwnerOperations.has(operation)) continue;
    if (job.inventory.receiptSha256 !== inventory.receiptSha256
      || job.inventory.inventorySha256 !== inventory.inventorySha256
      || job.target.targetSha256 !== inventory.targetSha256
      || ack.inventorySha256 !== inventory.inventorySha256
      || ack.inventoryReceiptSha256 !== inventory.receiptSha256
      || ack.targetSha256 !== inventory.targetSha256
      || ack.artifactIdSha256 !== inventory.artifactIdSha256
      || ack.artifactGeneration !== inventory.artifactGeneration
      || ack.receiptSha256 !== job.writeAckReceiptSha256
      || membership.inventorySha256 !== inventory.inventorySha256
      || membership.targetSha256 !== inventory.targetSha256
      || membership.artifactIdSha256 !== inventory.artifactIdSha256
      || membership.artifactGeneration !== inventory.artifactGeneration
      || membership.ownerKind !== inventory.ownerKind
      || membership.ownerRefSha256 !== inventory.ownerRefSha256
      || membership.holdSubjectRefSha256 !== inventory.holdSubjectRefSha256
      || binding.inventorySha256 !== inventory.inventorySha256
      || binding.targetSha256 !== inventory.targetSha256
      || binding.targetReceiptSha256 !== job.target.receiptSha256
      || binding.lifecycleCoverageEvidenceSha256 !== inventory.coverageEvidenceSha256
      || binding.manifestSha256 !== inventory.manifestSha256
      || binding.payloadSha256 !== inventory.payloadSha256) {
      throw new Error("telemetry preplan source tuple drift");
    }
    result[inventory.domain].push({ domain: inventory.domain,
      targetSha256: inventory.targetSha256,
      artifactIdSha256: inventory.artifactIdSha256,
      artifactGeneration: inventory.artifactGeneration,
      inventoryReceiptSha256: inventory.receiptSha256,
      writeAckReceiptSha256: ack.receiptSha256 });
  }
  for (const domain of ["logs", "traces"] as const) {
    tenantTelemetryDispositionInventoryTargetRootSha256(domain, result[domain]);
  }
  return result;
}

export function tenantTelemetryPlanArtifactTargetSha256(
  body: TenantTelemetryPlanArtifactTargetBody,
): string {
  if (!exactKeys(body, ENTRY_KEYS) || body.scope !== PLAN_ARTIFACT_TARGET_SCOPE
    || !body.requestId || !body.tenantId || body.tenantId.length > 128
    || !Number.isSafeInteger(body.subjectGeneration) || body.subjectGeneration < 1
    || !Number.isSafeInteger(body.buildGeneration) || body.buildGeneration < 1
    || !Number.isSafeInteger(body.artifactGeneration) || body.artifactGeneration < 1
    || !Number.isSafeInteger(body.capturedAtDbMs) || body.capturedAtDbMs < 0
    || (body.domain !== "logs" && body.domain !== "traces")
    || (body.ownerKind !== "tenant" && body.ownerKind !== "user"
      && body.ownerKind !== "session")
    || ["targetSha256", "targetReceiptSha256", "artifactIdSha256", "inventorySha256",
      "inventoryReceiptSha256", "writeOperationSha256", "writeAckReceiptSha256",
      "membershipSha256", "applicationBindingReceiptSha256", "payloadSha256",
      "manifestSha256", "lifecycleCoverageEvidenceSha256",
      "applicationCoverageEvidenceSha256", "ownerRefSha256", "holdSubjectRefSha256",
      "ownerBindingSha256", "liveOwnerClaimSha256", "artifactGroupSha256",
      "sourceGroupRootSha256"].some((key) => !digest(body[key as keyof typeof body]))) {
    throw new Error("invalid telemetry plan artifact target");
  }
  return hash(["tenant-telemetry-plan-artifact-target-entry-v1",
    ...ENTRY_KEYS.map((key) => body[key])]);
}
export function validateTenantTelemetryPlanArtifactTarget(
  entry: TenantTelemetryPlanArtifactTarget,
): void {
  if (!exactKeys(entry, [...ENTRY_KEYS, "receiptSha256"])) {
    throw new Error("telemetry plan artifact target shape");
  }
  const { receiptSha256, ...body } = entry;
  if (!digest(receiptSha256) || receiptSha256 !== tenantTelemetryPlanArtifactTargetSha256(body)) {
    throw new Error("telemetry plan artifact target receipt");
  }
}
export function tenantTelemetryPlanArtifactTargetReceiptSha256(
  body: TenantTelemetryPlanArtifactTargetReceiptBody,
): string {
  if (!exactKeys(body, RECEIPT_KEYS) || body.scope !== PLAN_ARTIFACT_TARGET_RECEIPT_SCOPE
    || !body.requestId || !body.tenantId || body.tenantId.length > 128
    || !Number.isSafeInteger(body.subjectGeneration) || body.subjectGeneration < 1
    || !Number.isSafeInteger(body.buildGeneration) || body.buildGeneration < 1
    || !Number.isSafeInteger(body.completedClaimAttempt) || body.completedClaimAttempt < 1
    || body.executionReady !== false
    || ["targetCount", "logsTargetCount", "tracesTargetCount", "unknownGroupCount",
      "storeDbTimestampMs"].some((key) => !Number.isSafeInteger(body[key as keyof typeof body])
        || (body[key as keyof typeof body] as number) < 0)
    || body.targetCount !== body.logsTargetCount + body.tracesTargetCount
    || ["planReceiptSha256", "sourceAccountingReceiptSha256",
      "targetManifestReceiptSha256", "targetRootSha256", "logsTargetRootSha256",
      "tracesTargetRootSha256", "unknownGroupRootSha256",
      "completedClaimTokenSha256"].some((key) => !digest(body[key as keyof typeof body]))) {
    throw new Error("invalid telemetry plan artifact target receipt");
  }
  return hash(["tenant-telemetry-plan-artifact-target-receipt-v1",
    ...RECEIPT_KEYS.map((key) => body[key])]);
}
export function validateTenantTelemetryPlanArtifactTargetReceipt(
  receipt: TenantTelemetryPlanArtifactTargetReceipt,
): void {
  if (!exactKeys(receipt, [...RECEIPT_KEYS, "receiptSha256"])) {
    throw new Error("telemetry plan artifact target aggregate shape");
  }
  const { receiptSha256, ...body } = receipt;
  if (!digest(receiptSha256)
    || receiptSha256 !== tenantTelemetryPlanArtifactTargetReceiptSha256(body)) {
    throw new Error("telemetry plan artifact target aggregate hash");
  }
}

export interface TenantTelemetryPlanArtifactTargetSource {
  job: TenantPurgePlanJobRecord; planReceipt: TenantPurgePlanReceipt;
  planEntries: readonly TenantPurgePlanEntry[];
  sourceEntries: readonly TenantTelemetrySourceAccountingEntry[];
  sourceReceipt: TenantTelemetrySourceAccountingReceipt;
  manifestEntries: readonly TenantTelemetryTargetManifestEntry[];
  manifestReceipt: TenantTelemetryTargetManifestReceipt;
  sources: TenantTelemetrySourceAccountingInputs;
}

/** Independently select candidates from the locked five-source projection, never from 0041. */
export function projectTenantTelemetryPlanArtifactTargets(input:
  TenantTelemetryPlanArtifactTargetSource & { liveOwnerOperations: ReadonlySet<string> },
): TenantTelemetryPlanArtifactTarget[] {
  validateTenantTelemetrySourceAccountingProof(input.job, input.planReceipt,
    input.sourceEntries, input.sourceReceipt);
  const inventories = new Map(input.sources.inventories.filter((row) =>
    row.tenantId === input.job.tenantId).map((row) => [row.inventorySha256, row]));
  const jobs = new Map(input.sources.jobs.filter((row) =>
    row.tenantId === input.job.tenantId).map((row) => [row.writeOperationSha256, row]));
  const acks = new Map(input.sources.acks.filter((row) =>
    row.tenantId === input.job.tenantId).map((row) => [row.writeOperationSha256, row]));
  const memberships = new Map(input.sources.memberships.filter((row) =>
    row.tenantId === input.job.tenantId).map((row) => [row.writeOperationSha256, row]));
  const bindings = new Map(input.sources.bindings.filter((row) =>
    row.tenantId === input.job.tenantId).map((row) => [row.writeOperationSha256, row]));
  const bySource = new Map(input.sourceEntries.map((source) => [sourceKey(source), source]));
  const entries: TenantTelemetryPlanArtifactTarget[] = [];
  for (const inventory of inventories.values()) {
    const inventorySource = bySource.get(sourceKey({ sourceKind: "inventory",
      sourceIdentitySha256: inventory.inventorySha256 }));
    if (!inventorySource || inventorySource.classification !== "accounted"
      || !inventorySource.writeOperationSha256) continue;
    const operation = inventorySource.writeOperationSha256;
    const job = jobs.get(operation);
    const ack = acks.get(operation);
    const membership = memberships.get(operation);
    const binding = bindings.get(operation);
    const groupSources = input.sourceEntries.filter((source) =>
      source.domain === inventory.domain && source.writeOperationSha256 === operation);
    if (!job || !ack || !membership || !binding || groupSources.length !== 5
      || groupSources.some((source) => source.classification !== "accounted")
      || !input.liveOwnerOperations.has(operation)) continue;
    const body: TenantTelemetryPlanArtifactTargetBody = {
      scope: PLAN_ARTIFACT_TARGET_SCOPE, requestId: input.job.requestId,
      tenantId: input.job.tenantId, subjectGeneration: input.job.subjectGeneration,
      buildGeneration: input.job.buildGeneration, domain: inventory.domain,
      targetSha256: inventory.targetSha256, targetReceiptSha256: job.target.receiptSha256,
      artifactIdSha256: inventory.artifactIdSha256,
      artifactGeneration: inventory.artifactGeneration,
      inventorySha256: inventory.inventorySha256,
      inventoryReceiptSha256: inventory.receiptSha256,
      writeOperationSha256: operation, writeAckReceiptSha256: ack.receiptSha256,
      membershipSha256: membership.membershipSha256,
      applicationBindingReceiptSha256: binding.receiptSha256,
      payloadSha256: inventory.payloadSha256, manifestSha256: inventory.manifestSha256,
      lifecycleCoverageEvidenceSha256: inventory.coverageEvidenceSha256,
      applicationCoverageEvidenceSha256: binding.coverageEvidenceSha256,
      ownerKind: membership.ownerKind, ownerRefSha256: membership.ownerRefSha256,
      holdSubjectRefSha256: membership.holdSubjectRefSha256,
      ownerBindingSha256: membership.ownerBindingSha256,
      liveOwnerClaimSha256: tenantTelemetryLiveOwnerClaimSha256(membership),
      artifactGroupSha256: hash(["tenant-telemetry-target-manifest-artifact-v1",
        input.job.tenantId, inventory.domain, inventory.inventorySha256]),
      sourceGroupRootSha256: sourceGroupRoot(groupSources),
      capturedAtDbMs: input.sourceReceipt.storeDbTimestampMs,
    };
    entries.push({ ...body, receiptSha256: tenantTelemetryPlanArtifactTargetSha256(body) });
  }
  return entries.sort(entryOrder);
}

/** Enforce one-to-one 0040/0041 source and per-domain 0036 tuple roots on every read. */
export function validateTenantTelemetryPlanArtifactTargetProof(input:
  TenantTelemetryPlanArtifactTargetSource & {
    entries: readonly TenantTelemetryPlanArtifactTarget[];
    receipt: TenantTelemetryPlanArtifactTargetReceipt;
  },
): void {
  validateTenantTelemetryTargetManifestProof({ job: input.job, planReceipt: input.planReceipt,
    sourceEntries: input.sourceEntries, sourceReceipt: input.sourceReceipt,
    entries: input.manifestEntries, receipt: input.manifestReceipt });
  validateTenantTelemetryObservedTargetRelations(input.manifestEntries, input.sources);
  validateTenantTelemetryPlanArtifactTargetReceipt(input.receipt);
  const receipt = input.receipt;
  if (receipt.requestId !== input.job.requestId || receipt.tenantId !== input.job.tenantId
    || receipt.subjectGeneration !== input.job.subjectGeneration
    || receipt.buildGeneration !== input.job.buildGeneration
    || receipt.planReceiptSha256 !== input.planReceipt.receiptSha256
    || receipt.sourceAccountingReceiptSha256 !== input.sourceReceipt.receiptSha256
    || receipt.targetManifestReceiptSha256 !== input.manifestReceipt.receiptSha256
    || receipt.storeDbTimestampMs !== input.sourceReceipt.storeDbTimestampMs
    || receipt.completedClaimAttempt !== input.sourceReceipt.completedClaimAttempt
    || receipt.completedClaimTokenSha256 !== input.sourceReceipt.completedClaimTokenSha256
    || receipt.targetCount !== input.entries.length
    || receipt.targetRootSha256 !== targetRoot(input.entries)
    || receipt.logsTargetCount !== input.entries.filter((entry) => entry.domain === "logs").length
    || receipt.tracesTargetCount !== input.entries.filter((entry) => entry.domain === "traces").length
    || receipt.logsTargetRootSha256 !== tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", domainTargets(input.entries, "logs"))
    || receipt.tracesTargetRootSha256 !== tenantTelemetryDispositionInventoryTargetRootSha256(
      "traces", domainTargets(input.entries, "traces"))
    || receipt.unknownGroupCount !== input.manifestReceipt.unknownGroupCount
    || receipt.unknownGroupRootSha256 !== input.manifestReceipt.unknownGroupRootSha256
    || receipt.targetCount !== input.manifestReceipt.observedTargetCount) {
    throw new Error("telemetry plan artifact target aggregate mismatch");
  }
  for (const domain of ["logs", "traces"] as const) {
    const planEntry = input.planEntries.filter((entry) => entry.domain === domain);
    if (planEntry.length !== 1 || planEntry[0]!.requestId !== receipt.requestId
      || planEntry[0]!.tenantId !== receipt.tenantId
      || planEntry[0]!.buildGeneration !== receipt.buildGeneration
      || planEntry[0]!.subjectGeneration !== receipt.subjectGeneration
      || planEntry[0]!.disposition !== "blocked_adapter_unconfigured"
      || planEntry[0]!.targetCount !== receipt[domain === "logs"
        ? "logsTargetCount" : "tracesTargetCount"]
      || planEntry[0]!.targetRootSha256 !== receipt[domain === "logs"
        ? "logsTargetRootSha256" : "tracesTargetRootSha256"]) {
      throw new Error("telemetry plan artifact targets do not match blocked T3d entry");
    }
  }
  const knownGroups = new Map<string, TenantTelemetryTargetManifestEntry>();
  for (const manifest of input.manifestEntries) {
    if (manifest.classification === "accounted") {
      knownGroups.set(manifest.artifactGroupSha256, manifest);
    }
  }
  const seenGroups = new Set<string>();
  const inventories = new Map(input.sources.inventories.map((row) => [row.inventorySha256, row]));
  const jobs = new Map(input.sources.jobs.map((row) => [row.writeOperationSha256, row]));
  const acks = new Map(input.sources.acks.map((row) => [row.writeOperationSha256, row]));
  const memberships = new Map(input.sources.memberships.map((row) =>
    [row.writeOperationSha256, row]));
  const bindings = new Map(input.sources.bindings.map((row) =>
    [row.writeOperationSha256, row]));
  const bySource = new Map(input.sourceEntries.map((source) => [sourceKey(source), source]));
  for (const entry of input.entries) {
    validateTenantTelemetryPlanArtifactTarget(entry);
    const manifest = knownGroups.get(entry.artifactGroupSha256);
    const inventory = inventories.get(entry.inventorySha256);
    const job = jobs.get(entry.writeOperationSha256);
    const ack = acks.get(entry.writeOperationSha256);
    const membership = memberships.get(entry.writeOperationSha256);
    const binding = bindings.get(entry.writeOperationSha256);
    const sourceEvidence = [
      ["inventory", entry.inventorySha256, inventory?.receiptSha256],
      ["write_job", entry.writeOperationSha256,
        job ? tenantTelemetrySourceAccountingJobEvidenceSha256(job) : undefined],
      ["write_ack", entry.writeOperationSha256, ack?.receiptSha256],
      ["membership", entry.writeOperationSha256, membership?.membershipSha256],
      ["application_binding", entry.writeOperationSha256, binding?.receiptSha256],
    ] as const;
    if (seenGroups.has(entry.artifactGroupSha256) || !manifest || !inventory || !job
      || !ack || !membership || !binding
      || entry.requestId !== receipt.requestId || entry.tenantId !== receipt.tenantId
      || entry.subjectGeneration !== receipt.subjectGeneration
      || entry.buildGeneration !== receipt.buildGeneration
      || entry.capturedAtDbMs !== receipt.storeDbTimestampMs
      || entry.domain !== manifest.domain || entry.targetSha256 !== manifest.observedTargetSha256
      || entry.artifactIdSha256 !== manifest.artifactIdSha256
      || entry.artifactGeneration !== manifest.artifactGeneration
      || entry.inventorySha256 !== manifest.inventorySha256
      || entry.writeOperationSha256 !== manifest.writeOperationSha256
      || entry.ownerKind !== manifest.ownerKind
      || entry.ownerRefSha256 !== manifest.ownerRefSha256
      || entry.holdSubjectRefSha256 !== manifest.holdSubjectRefSha256
      || entry.ownerBindingSha256 !== manifest.ownerBindingSha256
      || entry.liveOwnerClaimSha256 !== manifest.liveOwnerClaimSha256
      || entry.sourceGroupRootSha256 !== manifest.groupSourceRootSha256
      || entry.targetReceiptSha256 !== job.target.receiptSha256
      || entry.inventoryReceiptSha256 !== inventory.receiptSha256
      || entry.writeAckReceiptSha256 !== ack.receiptSha256
      || entry.membershipSha256 !== membership.membershipSha256
      || entry.applicationBindingReceiptSha256 !== binding.receiptSha256
      || entry.payloadSha256 !== inventory.payloadSha256
      || entry.manifestSha256 !== inventory.manifestSha256
      || entry.lifecycleCoverageEvidenceSha256 !== inventory.coverageEvidenceSha256
      || entry.applicationCoverageEvidenceSha256 !== binding.coverageEvidenceSha256
      || inventory.tenantId !== entry.tenantId || job.tenantId !== entry.tenantId
      || ack.tenantId !== entry.tenantId || membership.tenantId !== entry.tenantId
      || binding.tenantId !== entry.tenantId
      || sourceEvidence.some(([kind, identity, evidence]) => {
        const source = bySource.get(sourceKey({ sourceKind: kind,
          sourceIdentitySha256: identity }));
        return !source || source.classification !== "accounted"
          || source.sourceEvidenceSha256 !== evidence
          || source.writeOperationSha256 !== entry.writeOperationSha256;
      })) {
      throw new Error("telemetry plan artifact target source mismatch");
    }
    seenGroups.add(entry.artifactGroupSha256);
  }
  if (seenGroups.size !== knownGroups.size) {
    throw new Error("telemetry plan artifact target omitted a known source group");
  }
}

export function createTenantTelemetryPlanArtifactTargetSnapshot(input:
  TenantTelemetryPlanArtifactTargetSource & { liveOwnerOperations: ReadonlySet<string> },
): { entries: TenantTelemetryPlanArtifactTarget[];
  receipt: TenantTelemetryPlanArtifactTargetReceipt } {
  const entries = projectTenantTelemetryPlanArtifactTargets(input);
  const body: TenantTelemetryPlanArtifactTargetReceiptBody = {
    scope: PLAN_ARTIFACT_TARGET_RECEIPT_SCOPE, requestId: input.job.requestId,
    tenantId: input.job.tenantId, subjectGeneration: input.job.subjectGeneration,
    buildGeneration: input.job.buildGeneration,
    planReceiptSha256: input.planReceipt.receiptSha256,
    sourceAccountingReceiptSha256: input.sourceReceipt.receiptSha256,
    targetManifestReceiptSha256: input.manifestReceipt.receiptSha256,
    targetCount: entries.length, targetRootSha256: targetRoot(entries),
    logsTargetCount: entries.filter((entry) => entry.domain === "logs").length,
    logsTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256(
      "logs", domainTargets(entries, "logs")),
    tracesTargetCount: entries.filter((entry) => entry.domain === "traces").length,
    tracesTargetRootSha256: tenantTelemetryDispositionInventoryTargetRootSha256(
      "traces", domainTargets(entries, "traces")),
    unknownGroupCount: input.manifestReceipt.unknownGroupCount,
    unknownGroupRootSha256: input.manifestReceipt.unknownGroupRootSha256,
    storeDbTimestampMs: input.sourceReceipt.storeDbTimestampMs,
    completedClaimAttempt: input.sourceReceipt.completedClaimAttempt,
    completedClaimTokenSha256: input.sourceReceipt.completedClaimTokenSha256,
    executionReady: false,
  };
  const receipt = { ...body,
    receiptSha256: tenantTelemetryPlanArtifactTargetReceiptSha256(body) };
  validateTenantTelemetryPlanArtifactTargetProof({ ...input, entries, receipt });
  return { entries, receipt };
}

/** Pre-0042 terminal plans have no catalog, and are never interpreted as an empty set. */
export interface TenantTelemetryPlanArtifactTargetStore {
  getTenantTelemetryPlanArtifactTargetReceipt(tenantId: string, requestId: string):
    Promise<TenantTelemetryPlanArtifactTargetReceipt | null>;
  getTenantTelemetryPlanArtifactTargets(tenantId: string, requestId: string):
    Promise<TenantTelemetryPlanArtifactTarget[]>;
}
