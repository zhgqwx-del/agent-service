import {
  validateTenantTelemetryArtifactInventory,
  type TenantTelemetryArtifactInventoryRecord,
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
  PERSISTED_PROVIDER_CAPTURE_SOURCE_SCHEMA,
  validatePersistedProviderCaptureSourceBinding,
  validatePersistedProviderFailureCommitReceipt,
  type PersistedProviderStepFailureCommitReceipt,
  type TenantTelemetryPersistedProviderCaptureSourceBinding,
} from "./tenant-telemetry-persisted-provider-capture.js";
import {
  tenantTelemetrySourceAccountingJobEvidenceSha256,
  type TenantTelemetrySourceAccountingInputs,
} from "./tenant-telemetry-source-accounting.js";
import {
  tenantTelemetryLiveOwnerClaimSha256,
  tenantTelemetryTargetManifestArtifactGroupSha256,
} from "./tenant-telemetry-target-manifest.js";
import {
  TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS,
  TenantTelemetryRetainedSourceIntegrityError,
  tenantTelemetryRetainedSourceManagedOperationIdentitySha256,
  tenantTelemetryRetainedSourceOrphanIdentitySha256,
  validateTenantTelemetryRetainedSourceCatalogEntry,
  type TenantTelemetryRetainedSourceCatalogEntry,
  type TenantTelemetryRetainedSourceObservedRow,
} from "./tenant-telemetry-retained-source.js";

export interface TenantTelemetryRetainedSourceGraphInputs
  extends TenantTelemetrySourceAccountingInputs {
  providerBindings: readonly TenantTelemetryPersistedProviderCaptureSourceBinding[];
  providerFailureReceipts: readonly PersistedProviderStepFailureCommitReceipt[];
}

/**
 * A projection of actual rows, not a trusted source or a grant. The caller supplies
 * one complete locked snapshot and independently validates canonical owners/sources.
 * Orphan rows remain in the result; neither job existence nor a timestamp filters them out.
 */
export interface TenantTelemetryRetainedSourceGraphGroup {
  sourceIdentitySha256: string;
  operationSha256: string | null;
  inventory?: TenantTelemetryArtifactInventoryRecord;
  job?: TenantTelemetryWriteJobRecord;
  ack?: TenantTelemetryWriteAck;
  membership?: TenantTelemetryArtifactMembershipRecord;
  applicationBinding?: TenantTelemetryApplicationWriteBinding;
  providerBinding?: TenantTelemetryPersistedProviderCaptureSourceBinding;
  providerFailureReceipt?: PersistedProviderStepFailureCommitReceipt;
  observedRows: TenantTelemetryRetainedSourceObservedRow[];
  sourceHighWaterDbMs: number;
}

function invalid(): never {
  throw new TenantTelemetryRetainedSourceIntegrityError();
}
function maximum(values: readonly number[]): number {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) invalid();
  return values.reduce((result, value) => Math.max(result, value), 0);
}
const inventoryHighWater = (row: TenantTelemetryArtifactInventoryRecord) =>
  maximum([row.sourceHighWaterDbMs, row.createdAtDbMs, row.restoreUpdatedAtDbMs]);

export function projectTenantTelemetryRetainedSourceGraph(input: {
  tenantId: string;
  sources: TenantTelemetryRetainedSourceGraphInputs;
}): {
  groups: TenantTelemetryRetainedSourceGraphGroup[];
  observedRows: TenantTelemetryRetainedSourceObservedRow[];
} {
  if (typeof input.tenantId !== "string" || !input.tenantId.length
    || input.tenantId.length > 128) invalid();
  const { sources, tenantId } = input;
  const byOperation = new Map<string, TenantTelemetryRetainedSourceGraphGroup>();
  const jobByInventory = new Map<string, TenantTelemetryWriteJobRecord>();
  const inventoryGroups: TenantTelemetryRetainedSourceGraphGroup[] = [];
  const observedRows: TenantTelemetryRetainedSourceObservedRow[] = [];
  const seenSources = new Set<string>();
  const operationGroup = (operationSha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(operationSha256)) invalid();
    let group = byOperation.get(operationSha256);
    if (!group) {
      group = {
        sourceIdentitySha256: tenantTelemetryRetainedSourceManagedOperationIdentitySha256(
          tenantId, operationSha256,
        ),
        operationSha256, observedRows: [], sourceHighWaterDbMs: 0,
      };
      byOperation.set(operationSha256, group);
    }
    return group;
  };
  const addRow = (
    group: TenantTelemetryRetainedSourceGraphGroup,
    row: TenantTelemetryRetainedSourceObservedRow,
  ) => {
    const identity = JSON.stringify([row.sourceKind, row.sourceIdentitySha256]);
    if (seenSources.has(identity) || !/^[0-9a-f]{64}$/.test(row.sourceEvidenceSha256)) invalid();
    seenSources.add(identity);
    maximum([row.sourceHighWaterDbMs]);
    if (group.observedRows.some((existing) => existing.domain !== row.domain)) invalid();
    group.observedRows.push(row);
    group.sourceHighWaterDbMs = Math.max(group.sourceHighWaterDbMs, row.sourceHighWaterDbMs);
    observedRows.push(row);
  };

  // Validate every supplied row before tenant selection. A caller cannot turn a
  // cross-tenant duplicate operation into a valid local group by filtering first.
  const operationTenants = new Map<string, string>();
  const bindOperationTenant = (row: { tenantId: string; writeOperationSha256: string }) => {
    const previous = operationTenants.get(row.writeOperationSha256);
    if (previous !== undefined && previous !== row.tenantId) invalid();
    operationTenants.set(row.writeOperationSha256, row.tenantId);
  };
  for (const row of sources.jobs) {
    validateTenantTelemetryWriteJobRecord(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.job || jobByInventory.has(row.inventory.inventorySha256)) invalid();
    group.job = row; jobByInventory.set(row.inventory.inventorySha256, row);
    addRow(group, {
      sourceKind: "write_job", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: tenantTelemetrySourceAccountingJobEvidenceSha256(row),
      domain: row.inventory.domain, writeOperationSha256: row.writeOperationSha256,
      sourceHighWaterDbMs: maximum([row.createdAtMs, row.updatedAtMs,
        inventoryHighWater(row.inventory), row.reservation?.startedAtDbMs ?? 0,
        row.phase === "written" ? row.writtenAtDbMs : 0,
        row.phase === "blocked" ? row.blockedAtDbMs : 0]),
    });
  }
  for (const row of sources.inventories) {
    validateTenantTelemetryArtifactInventory(row);
    if (row.tenantId !== tenantId) continue;
    const job = jobByInventory.get(row.inventorySha256);
    const group: TenantTelemetryRetainedSourceGraphGroup = job ? operationGroup(job.writeOperationSha256) : {
      sourceIdentitySha256: tenantTelemetryRetainedSourceOrphanIdentitySha256(
        tenantId, "inventory", row.inventorySha256,
      ),
      operationSha256: null, observedRows: [], sourceHighWaterDbMs: 0,
    };
    if (group.inventory) invalid();
    group.inventory = row;
    if (!job) inventoryGroups.push(group);
    addRow(group, { sourceKind: "inventory", sourceIdentitySha256: row.inventorySha256,
      sourceEvidenceSha256: row.receiptSha256, domain: row.domain,
      writeOperationSha256: group.operationSha256, sourceHighWaterDbMs: inventoryHighWater(row) });
  }
  for (const row of sources.acks) {
    validateTenantTelemetryWriteAck(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.ack) invalid(); group.ack = row;
    addRow(group, { sourceKind: "write_ack", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: row.receiptSha256, domain: row.domain,
      writeOperationSha256: row.writeOperationSha256,
      sourceHighWaterDbMs: maximum([row.mutationStartedAtDbMs, row.storeDbTimestampMs]) });
  }
  for (const row of sources.memberships) {
    validateTenantTelemetryArtifactMembership(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.membership) invalid(); group.membership = row;
    addRow(group, { sourceKind: "membership", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: row.membershipSha256, domain: row.domain,
      writeOperationSha256: row.writeOperationSha256,
      sourceHighWaterDbMs: maximum([row.sourceHighWaterDbMs, row.inventoryCreatedAtDbMs]) });
  }
  for (const row of sources.bindings) {
    validateTenantTelemetryApplicationWriteBinding(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.applicationBinding) invalid(); group.applicationBinding = row;
    addRow(group, { sourceKind: "application_binding", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: row.receiptSha256, domain: row.domain,
      writeOperationSha256: row.writeOperationSha256, sourceHighWaterDbMs: row.boundAtDbMs });
  }
  for (const row of sources.providerBindings) {
    validatePersistedProviderCaptureSourceBinding(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.providerBinding) invalid(); group.providerBinding = row;
    addRow(group, { sourceKind: "provider_source_binding", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: row.receiptSha256, domain: row.domain,
      writeOperationSha256: row.writeOperationSha256, sourceHighWaterDbMs: row.boundAtDbMs });
  }
  for (const row of sources.providerFailureReceipts) {
    validatePersistedProviderFailureCommitReceipt(row); bindOperationTenant(row);
    if (row.tenantId !== tenantId) continue;
    const group = operationGroup(row.writeOperationSha256);
    if (group.providerFailureReceipt) invalid(); group.providerFailureReceipt = row;
    addRow(group, { sourceKind: "provider_failure_commit", sourceIdentitySha256: row.writeOperationSha256,
      sourceEvidenceSha256: row.receiptSha256, domain: "logs",
      writeOperationSha256: row.writeOperationSha256, sourceHighWaterDbMs: row.committedAtDbMs });
  }
  const order = (left: TenantTelemetryRetainedSourceObservedRow,
    right: TenantTelemetryRetainedSourceObservedRow) =>
    TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS.indexOf(left.sourceKind)
      - TENANT_TELEMETRY_RETAINED_SOURCE_RAW_KINDS.indexOf(right.sourceKind)
    || (left.sourceIdentitySha256 < right.sourceIdentitySha256 ? -1
      : left.sourceIdentitySha256 > right.sourceIdentitySha256 ? 1 : 0);
  const groups = [...byOperation.values(), ...inventoryGroups].sort((left, right) =>
    left.sourceIdentitySha256 < right.sourceIdentitySha256 ? -1
      : left.sourceIdentitySha256 > right.sourceIdentitySha256 ? 1 : 0);
  for (const group of groups) group.observedRows.sort(order);
  observedRows.sort(order);
  return { groups, observedRows };
}

/**
 * Compare v2 catalog metadata to actual immutable rows, not just their opaque digests.
 * The caller must supply the same complete locked snapshot used for its cohort/catalog audit
 * and independently verify the canonical owner or the exact usage/canonical closure bridges.
 * This relation check is not a T1 admission, a grant, or proof of external physical deletion.
 * Application-v1 targets retain their separate published source/manifest verification path.
 */
export function validateTenantTelemetryRetainedSourceProviderTargetRelations(input: {
  tenantId: string;
  refKeyIdSha256: string;
  entries: readonly TenantTelemetryRetainedSourceCatalogEntry[];
  sources: TenantTelemetryRetainedSourceGraphInputs;
}): void {
  if (!/^[0-9a-f]{64}$/.test(input.refKeyIdSha256)) invalid();
  const graph = projectTenantTelemetryRetainedSourceGraph(input);
  const groups = new Map(graph.groups.filter((group) => group.operationSha256 !== null)
    .map((group) => [group.operationSha256!, group]));
  const operations = new Set<string>();
  for (const entry of input.entries) {
    validateTenantTelemetryRetainedSourceCatalogEntry(entry);
    if (entry.tenantId !== input.tenantId || operations.has(entry.writeOperationSha256)) invalid();
    operations.add(entry.writeOperationSha256);
    if (entry.source.kind !== "persisted-provider-v2") continue;
    const group = groups.get(entry.writeOperationSha256);
    const inventory = group?.inventory, job = group?.job, ack = group?.ack;
    const member = group?.membership, binding = group?.providerBinding;
    const failure = group?.providerFailureReceipt;
    if (!group || !inventory || !job || job.phase !== "written" || !job.reservation
      || !ack || !member || !binding || !failure || group.applicationBinding) invalid();
    validateTenantTelemetryArtifactMembershipSource(member, {
      writeOperationSha256: job.writeOperationSha256,
      jobCreatedAtMs: job.createdAtMs,
      inventory,
      refKeyIdSha256: input.refKeyIdSha256,
      applicationBinding: null,
    });
    const reservation = job.reservation;
    const pairs: readonly (readonly [unknown, unknown])[] = [
      [inventory.tenantId, input.tenantId], [job.tenantId, input.tenantId],
      [ack.tenantId, input.tenantId], [member.tenantId, input.tenantId],
      [binding.tenantId, input.tenantId], [failure.tenantId, input.tenantId],
      [entry.domain, "logs"], [inventory.domain, "logs"], [ack.domain, "logs"],
      [member.domain, "logs"], [binding.domain, "logs"],
      [inventory.sourceSchema, PERSISTED_PROVIDER_CAPTURE_SOURCE_SCHEMA],
      [member.sourceSchema, PERSISTED_PROVIDER_CAPTURE_SOURCE_SCHEMA],
      [inventory.ownerKind, "session"], [member.ownerKind, "session"],
      [job.inventory.receiptSha256, inventory.receiptSha256],
      [job.writeAckReceiptSha256, ack.receiptSha256],
      [ack.inventoryReceiptSha256, inventory.receiptSha256],
      [ack.reservationReceiptSha256, reservation.receiptSha256],
      [ack.mutationStartedAtDbMs, reservation.startedAtDbMs],
      [ack.mutationStartedClaimAttempt, reservation.startedClaimAttempt],
      [ack.mutationStartedClaimTokenSha256, reservation.startedClaimTokenSha256],
      [reservation.tenantId, input.tenantId],
      [reservation.writeOperationSha256, job.writeOperationSha256],
      [reservation.inventorySha256, inventory.inventorySha256],
      [reservation.manifestSha256, inventory.manifestSha256],
      [ack.writeOperationSha256, job.writeOperationSha256],
      [ack.inventorySha256, inventory.inventorySha256],
      [ack.targetSha256, job.target.targetSha256],
      [ack.targetReceiptSha256, job.target.receiptSha256],
      [ack.artifactIdSha256, inventory.artifactIdSha256],
      [ack.artifactGeneration, inventory.artifactGeneration],
      [ack.payloadSha256, inventory.payloadSha256],
      [ack.manifestSha256, inventory.manifestSha256],
      [binding.ownerRefSha256, member.ownerRefSha256],
      [binding.payloadSha256, inventory.payloadSha256],
      [binding.receiptSha256, failure.bindingReceiptSha256],
      [binding.sourceSessionRefSha256, failure.sourceSessionRefSha256],
      [binding.sourceTurnRefSha256, failure.sourceTurnRefSha256],
      [binding.sourceItemRefSha256, failure.sourceItemRefSha256],
      [binding.sourceStepIndex, failure.sourceStepIndex],
      [binding.sourceEventSeq, failure.sourceEventSeq],
      [failure.membershipSha256, member.membershipSha256],
      [failure.payloadSha256, inventory.payloadSha256],
      [entry.artifactGroupSha256, tenantTelemetryTargetManifestArtifactGroupSha256(
        input.tenantId, "logs", inventory.inventorySha256)],
      [entry.targetSha256, inventory.targetSha256],
      [entry.targetSha256, job.target.targetSha256],
      [entry.targetReceiptSha256, job.target.receiptSha256],
      [entry.artifactIdSha256, inventory.artifactIdSha256],
      [entry.artifactGeneration, inventory.artifactGeneration],
      [entry.inventorySha256, inventory.inventorySha256],
      [entry.inventoryReceiptSha256, inventory.receiptSha256],
      [entry.writeJobEvidenceSha256, tenantTelemetrySourceAccountingJobEvidenceSha256(job)],
      [entry.reservationSha256, reservation.receiptSha256],
      [entry.writeAckReceiptSha256, ack.receiptSha256],
      [entry.membershipSha256, member.membershipSha256],
      [entry.payloadSha256, inventory.payloadSha256],
      [entry.manifestSha256, inventory.manifestSha256],
      [entry.lifecycleCoverageEvidenceSha256, inventory.coverageEvidenceSha256],
      [entry.ownerKind, member.ownerKind], [entry.ownerRefSha256, member.ownerRefSha256],
      [entry.holdSubjectRefSha256, member.holdSubjectRefSha256],
      [entry.ownerBindingSha256, member.ownerBindingSha256],
      [entry.liveOwnerClaimSha256, tenantTelemetryLiveOwnerClaimSha256(member)],
      [entry.source.failureCommitReceiptSha256, failure.receiptSha256],
      [entry.source.sourceBindingReceiptSha256, binding.receiptSha256],
      [entry.source.captureCoverageEvidenceSha256, binding.coverageEvidenceSha256],
    ];
    if (pairs.some(([left, right]) => left !== right)
      || entry.sourceHighWaterDbMs < group.sourceHighWaterDbMs) invalid();
  }
}
