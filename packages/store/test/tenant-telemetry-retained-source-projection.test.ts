import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
  TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
  TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  tenantTelemetryWriteAdapterResult,
  tenantTelemetryWriteAckSha256,
  tenantTelemetryExternalMutationReservationSha256,
  validateTenantTelemetryWriteAck,
  validateTenantTelemetryExternalMutationReservation,
  type TenantTelemetryWriteClaim,
} from "../src/index.js";
import {
  projectTenantTelemetryRetainedSourceGraph,
  validateTenantTelemetryRetainedSourceProviderTargetRelations,
  type TenantTelemetryRetainedSourceGraphInputs,
} from "../src/tenant-telemetry-retained-source-projection.js";
import {
  TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE,
  TenantTelemetryRetainedSourceIntegrityError,
  buildTenantTelemetryRetainedSourceCatalogEntry,
  tenantTelemetryRetainedSourceManagedOperationIdentitySha256,
  tenantTelemetryRetainedSourceOrphanIdentitySha256,
  validateTenantTelemetryRetainedSourceCatalogEntry,
} from "../src/tenant-telemetry-retained-source.js";
import {
  tenantTelemetryLiveOwnerClaimSha256,
  tenantTelemetryTargetManifestArtifactGroupSha256,
} from "../src/tenant-telemetry-target-manifest.js";
import { tenantTelemetrySourceAccountingJobEvidenceSha256 } from "../src/tenant-telemetry-source-accounting.js";
import { telemetryAdapterFixture, trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";
import { activateCaptureFixture, captureRefKey, captureStepFixture } from "./persisted-provider-capture.fixture.js";

const tenantId = "retained-source-projection-tenant";
const protocol = "telemetry-projection-unit-v1";
const producerProtocol = "application-dual-write-v1";
const producerContractSha256 = "9".repeat(64);
const emptySources = (): TenantTelemetryRetainedSourceGraphInputs => ({ inventories: [], jobs: [], acks: [],
  memberships: [], bindings: [], providerBindings: [], providerFailureReceipts: [] });
const sourceKeys = ["inventories", "jobs", "acks", "memberships", "bindings", "providerBindings", "providerFailureReceipts"] as const;
type SourceKey = (typeof sourceKeys)[number];
const authorization = (claim: TenantTelemetryWriteClaim) => ({ tenantId: claim.tenantId,
  writeOperationSha256: claim.writeOperationSha256, claimAttempt: claim.claimAttempt, claimToken: claim.claimToken });

async function sourceRows(store: MemorySessionStore, operation: string): Promise<TenantTelemetryRetainedSourceGraphInputs> {
  const job = await store.getTenantTelemetryWriteJob(tenantId, operation);
  if (!job) throw new Error("projection fixture lost the real write job");
  const member = await store.getTenantTelemetryArtifactMembership(tenantId, operation);
  if (!member) throw new Error("projection fixture lost the real membership");
  const inventory = await store.getTenantTelemetryArtifact(tenantId, job.inventory.domain,
    job.inventory.artifactIdSha256, job.inventory.artifactGeneration);
  const ack = await store.getTenantTelemetryWriteAck(tenantId, operation);
  const binding = await store.getTenantTelemetryApplicationWriteBinding(tenantId, operation);
  return { ...emptySources(), jobs: [job], memberships: [member], inventories: inventory ? [inventory] : [],
    acks: ack ? [ack] : [], bindings: binding ? [binding] : [] };
}
async function completeLegacy(store: MemorySessionStore, claim: TenantTelemetryWriteClaim) {
  const auth = authorization(claim);
  const reservation = await store.reserveTenantTelemetryExternalMutation(auth, protocol);
  if (!reservation) throw new Error("projection fixture lost the real mutation reservation");
  // This is an explicit in-memory unit result, not evidence of network/object creation.
  const result = tenantTelemetryWriteAdapterResult(protocol, { writeOperationSha256: claim.writeOperationSha256,
    target: claim.target, inventory: claim.inventory, payload: claim.payload }, "written", false);
  const ack = await store.completeTenantTelemetryWrite(auth, result);
  if (!ack) throw new Error("projection fixture could not complete its in-memory ACK");
}
async function legacyFixture() {
  const f = await telemetryAdapterFixture(protocol, tenantId);
  await completeLegacy(f.store, f.claim);
  const first = await sourceRows(f.store, f.claim.writeOperationSha256);
  const lifecycle = await f.store.getTenantTelemetryLifecycleControl();
  if (lifecycle.state !== "active") throw new Error("projection fixture lifecycle missing");
  const logs = (await f.store.listTenantTelemetryLifecycleTargets()).find((target) => target.domain === "logs");
  if (!logs) throw new Error("projection fixture logs target missing");
  await f.store.activateTenantTelemetryApplicationCapture({ domain: "logs", expectedControlGeneration: 0,
    expectedLifecycleControlGeneration: 1, lifecycleControlEvidenceSha256: lifecycle.activationEvidenceSha256,
    lifecycleTargetSha256: logs.targetSha256, lifecycleTargetReceiptSha256: logs.receiptSha256,
    producerProtocol, producerContractSha256, fleetStoppedAck: TENANT_TELEMETRY_APPLICATION_FLEET_STOPPED_ACK,
    legacyWritersDrainedAck: TENANT_TELEMETRY_APPLICATION_LEGACY_WRITERS_DRAINED_ACK,
    producerReadyAck: TENANT_TELEMETRY_APPLICATION_PRODUCER_READY_ACK });
  const queued = await f.store.enqueueTenantTelemetryArtifact({ tenantId, expectedControlGeneration: 1, domain: "logs",
    artifactIdSha256: "a".repeat(64), artifactGeneration: 1, ownerKind: "tenant", ownerId: tenantId, ownerUserId: null,
    sourceSchema: "structured-log-batch-v1", sourceGeneration: 1, sourceHighWaterDbMs: 1_100,
    producerProtocol, producerContractSha256, payload: { schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs", records: [trustedRunnerTelemetryRecord(1_100, { opaqueRefKey: new Uint8Array(32).fill(21),
        ownerKind: "tenant", ownerValue: tenantId })] } });
  const [claim] = await f.store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 10_000,
    claimToken: "projection-application-claim", adapterProtocol: protocol });
  if (!claim || claim.writeOperationSha256 !== queued.writeOperationSha256) throw new Error("projection fixture claim missing");
  await completeLegacy(f.store, claim);
  const second = await sourceRows(f.store, claim.writeOperationSha256);
  return { first, second, sources: combine(first, second) };
}
function combine(...inputs: TenantTelemetryRetainedSourceGraphInputs[]): TenantTelemetryRetainedSourceGraphInputs {
  return { inventories: inputs.flatMap((input) => [...input.inventories]), jobs: inputs.flatMap((input) => [...input.jobs]),
    acks: inputs.flatMap((input) => [...input.acks]), memberships: inputs.flatMap((input) => [...input.memberships]),
    bindings: inputs.flatMap((input) => [...input.bindings]), providerBindings: inputs.flatMap((input) => [...input.providerBindings]),
    providerFailureReceipts: inputs.flatMap((input) => [...input.providerFailureReceipts]) };
}
async function providerFixture() {
  let clock = Date.now();
  const store = new MemorySessionStore({ now: () => clock }, { tenantTelemetryRefKey: captureRefKey,
    tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  await activateCaptureFixture(store);
  clock += 1_000;
  const h = await captureStepFixture(store, { tenantId });
  const committed = await store.commitPersistedProviderStepFailure(h.input);
  const operation = committed.failureCommitReceipt.writeOperationSha256;
  const sourceBinding = await store.getTenantTelemetryPersistedProviderCaptureSourceBinding(tenantId, operation);
  if (!sourceBinding) throw new Error("projection fixture lost the original provider source binding");
  const originalRows = { providerBindings: [sourceBinding], providerFailureReceipts: [committed.failureCommitReceipt] };
  const pending = { ...await sourceRows(store, operation), ...originalRows };
  clock += 1_000;
  const [claim] = await store.claimTenantTelemetryWriteJobs({ limit: 1, leaseMs: 30_000,
    claimToken: "projection-provider-claim", adapterProtocol: "telemetry-s3-object-v1", captureMode: "include_v2", freshProof: h.proof });
  if (!claim) throw new Error("projection fixture lost the provider claim");
  clock += 1_000;
  const reservation = await store.reserveTenantTelemetryExternalMutation(authorization(claim), claim.target.adapterProtocol, h.proof);
  if (!reservation) throw new Error("projection fixture lost the provider reservation");
  const reserved = { ...await sourceRows(store, operation), ...originalRows };
  clock += 1_000;
  // Fake ACK only: no adapter is instantiated and no network request is made.
  const result = tenantTelemetryWriteAdapterResult(claim.target.adapterProtocol,
    { writeOperationSha256: operation, target: claim.target, inventory: claim.inventory, payload: claim.payload }, "written", false);
  if (!await store.completeTenantTelemetryWrite(authorization(claim), result, h.proof)) throw new Error("projection fixture provider ACK missing");
  const written = { ...await sourceRows(store, operation), ...originalRows };
  return { pending, reserved, written, operation, failure: committed.failureCommitReceipt,
    refKeyIdSha256: h.proof.refKeyIdSha256 };
}

async function providerCatalogFixture() {
  const f = await providerFixture();
  const group = projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: f.written }).groups[0]!;
  const inventory = group.inventory!, job = group.job!, member = group.membership!;
  const ack = group.ack!, binding = group.providerBinding!, failure = group.providerFailureReceipt!;
  if (job.phase !== "written" || !job.reservation) throw new Error("expected genuine written source");
  // Only the raw target relation is tested here. Synthetic erasure/cohort identities do not
  // establish T1 admission, deletion authorization, or evidence of an external object.
  const target = buildTenantTelemetryRetainedSourceCatalogEntry({
    scope: TENANT_TELEMETRY_RETAINED_SOURCE_CATALOG_ENTRY_SCOPE,
    requestId: "erase_00000000-0000-4000-8000-000000000001", tenantId, subjectGeneration: 1,
    t1ProfileSha256: "1".repeat(64), t1FenceSha256: "2".repeat(64),
    planBuildGeneration: 1, cohortReceiptSha256: "3".repeat(64), domain: "logs",
    source: { kind: "persisted-provider-v2", failureCommitReceiptSha256: failure.receiptSha256,
      sourceBindingReceiptSha256: binding.receiptSha256,
      captureCoverageEvidenceSha256: binding.coverageEvidenceSha256,
      cohortEntryReceiptSha256: "4".repeat(64) },
    artifactGroupSha256: tenantTelemetryTargetManifestArtifactGroupSha256(tenantId, "logs", inventory.inventorySha256),
    targetSha256: inventory.targetSha256, targetReceiptSha256: job.target.receiptSha256,
    artifactIdSha256: inventory.artifactIdSha256, artifactGeneration: inventory.artifactGeneration,
    inventorySha256: inventory.inventorySha256, inventoryReceiptSha256: inventory.receiptSha256,
    writeOperationSha256: job.writeOperationSha256,
    writeJobEvidenceSha256: tenantTelemetrySourceAccountingJobEvidenceSha256(job),
    reservationSha256: job.reservation.receiptSha256, writeAckReceiptSha256: ack.receiptSha256,
    membershipSha256: member.membershipSha256, payloadSha256: inventory.payloadSha256,
    manifestSha256: inventory.manifestSha256, lifecycleCoverageEvidenceSha256: inventory.coverageEvidenceSha256,
    ownerKind: member.ownerKind, ownerRefSha256: member.ownerRefSha256,
    holdSubjectRefSha256: member.holdSubjectRefSha256, ownerBindingSha256: member.ownerBindingSha256,
    liveOwnerClaimSha256: tenantTelemetryLiveOwnerClaimSha256(member),
    sourceHighWaterDbMs: group.sourceHighWaterDbMs, capturedAtDbMs: group.sourceHighWaterDbMs + 1,
  });
  return { ...f, target };
}

describe("retained-source v2 target binding to actual immutable rows", () => {
  it("independently checks the real written inventory, membership, job, reservation, ACK and original provider binding", async () => {
    const f = await providerCatalogFixture();
    validateTenantTelemetryRetainedSourceProviderTargetRelations({ tenantId,
      refKeyIdSha256: f.refKeyIdSha256, entries: [f.target], sources: f.written });
  });

  it.each(["ownerRefSha256", "holdSubjectRefSha256", "ownerBindingSha256", "liveOwnerClaimSha256",
    "manifestSha256", "payloadSha256", "inventoryReceiptSha256", "targetReceiptSha256",
    "writeAckReceiptSha256", "membershipSha256", "lifecycleCoverageEvidenceSha256"] as const)(
    "rejects resealed %s even though the catalog entry itself has a valid checksum", async (field) => {
      const f = await providerCatalogFixture();
      const { receiptSha256: _receipt, ...body } = f.target;
      const forged = buildTenantTelemetryRetainedSourceCatalogEntry({ ...body, [field]: "7".repeat(64) });
      expect(() => validateTenantTelemetryRetainedSourceCatalogEntry(forged)).not.toThrow();
      expect(() => validateTenantTelemetryRetainedSourceProviderTargetRelations({ tenantId,
        refKeyIdSha256: f.refKeyIdSha256, entries: [forged], sources: f.written }))
        .toThrow(TenantTelemetryRetainedSourceIntegrityError);
    },
  );

  it("cannot validate a v2 target against an omitted membership row or another tenant snapshot", async () => {
    const f = await providerCatalogFixture();
    expect(() => validateTenantTelemetryRetainedSourceProviderTargetRelations({ tenantId,
      refKeyIdSha256: f.refKeyIdSha256, entries: [f.target],
      sources: { ...f.written, memberships: [] } })).toThrow(TenantTelemetryRetainedSourceIntegrityError);
    expect(() => validateTenantTelemetryRetainedSourceProviderTargetRelations({ tenantId: "different-tenant",
      refKeyIdSha256: f.refKeyIdSha256, entries: [f.target], sources: f.written }))
      .toThrow(TenantTelemetryRetainedSourceIntegrityError);
  });
});
async function allSources() {
  const legacy = await legacyFixture();
  const provider = await providerFixture();
  return { legacy, provider, sources: combine(legacy.sources, provider.written) };
}
function replaceSource(sources: TenantTelemetryRetainedSourceGraphInputs, key: SourceKey,
  rows: readonly unknown[]): TenantTelemetryRetainedSourceGraphInputs {
  return { ...sources, [key]: rows } as TenantTelemetryRetainedSourceGraphInputs;
}

describe("retained-source actual Memory row projection", () => {
  it("projects genuine 0033/0034/0035/0038 rows and original 0053 bindings/receipts across all seven kinds", async () => {
    const { sources } = await allSources();
    for (const key of sourceKeys) expect(sources[key].length).toBeGreaterThan(0);
    const projected = projectTenantTelemetryRetainedSourceGraph({ tenantId, sources });
    expect(projected.groups).toHaveLength(3);
    expect(projected.observedRows).toHaveLength(sourceKeys.reduce((count, key) => count + sources[key].length, 0));
    expect(new Set(projected.observedRows.map((row) => row.sourceKind))).toEqual(new Set([
      "inventory", "write_job", "write_ack", "membership", "application_binding", "provider_source_binding", "provider_failure_commit",
    ]));
    expect(projected.groups.filter((group) => group.providerFailureReceipt)).toHaveLength(1);
    expect(projected.groups.filter((group) => group.applicationBinding)).toHaveLength(1);
  });

  it.each(sourceKeys)("rejects a corrupt %s row before filtering another tenant", async (key) => {
    const { sources } = await allSources();
    const corrupt = { ...structuredClone(sources[key][0]!), tenantId: "foreign".repeat(30) };
    const input = replaceSource(emptySources(), key, [corrupt]);
    expect(() => projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: input })).toThrow();
  });

  it.each(sourceKeys)("rejects duplicate genuine %s rows rather than counting or silently deduplicating them", async (key) => {
    const { sources } = await allSources();
    const rows = [...sources[key], structuredClone(sources[key][0]!)];
    expect(() => projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: replaceSource(sources, key, rows) })).toThrow();
  });

  it("rejects a same-operation cross-tenant ACK even though that ACK's independent checksum is valid", async () => {
    const f = await legacyFixture();
    const { receiptSha256: ignored, ...body } = f.first.acks[0]!;
    void ignored;
    const { receiptSha256: ignoredReservation, ...reservationBody } = f.first.jobs[0]!.reservation!;
    void ignoredReservation;
    const otherReservationBody = { ...reservationBody, tenantId: "other-tenant" };
    const reservation = { ...otherReservationBody,
      receiptSha256: tenantTelemetryExternalMutationReservationSha256(otherReservationBody) };
    expect(() => validateTenantTelemetryExternalMutationReservation(reservation)).not.toThrow();
    const otherBody = { ...body, tenantId: "other-tenant", reservationReceiptSha256: reservation.receiptSha256 };
    const ack = { ...otherBody, receiptSha256: tenantTelemetryWriteAckSha256(otherBody) };
    expect(() => validateTenantTelemetryWriteAck(ack)).not.toThrow();
    const sources = { ...f.first, acks: [ack] };
    expect(() => projectTenantTelemetryRetainedSourceGraph({ tenantId, sources })).toThrow();
  });

  it("preserves a real inventory with no job and a real job with no supplied inventory", async () => {
    const f = await legacyFixture();
    const inventory = f.first.inventories[0]!;
    const inventoryOnly = projectTenantTelemetryRetainedSourceGraph({ tenantId,
      sources: { ...emptySources(), inventories: [inventory] } });
    expect(inventoryOnly.observedRows).toHaveLength(1);
    expect(inventoryOnly.groups[0]).toMatchObject({ operationSha256: null, inventory,
      sourceIdentitySha256: tenantTelemetryRetainedSourceOrphanIdentitySha256(tenantId, "inventory", inventory.inventorySha256) });
    const job = f.first.jobs[0]!;
    const jobOnly = projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: { ...emptySources(), jobs: [job] } });
    expect(jobOnly.observedRows).toHaveLength(1);
    expect(jobOnly.groups[0]).toMatchObject({ operationSha256: job.writeOperationSha256, job,
      sourceIdentitySha256: tenantTelemetryRetainedSourceManagedOperationIdentitySha256(tenantId, job.writeOperationSha256) });
    expect(jobOnly.groups[0]!.inventory).toBeUndefined();
    expect(jobOnly.groups[0]!.membership).toBeUndefined();
  });

  it("projects deterministic groups/rows from every input-array permutation without mutating the supplied snapshot", async () => {
    const { sources } = await allSources();
    const before = structuredClone(sources);
    const expected = projectTenantTelemetryRetainedSourceGraph({ tenantId, sources });
    const reversed = Object.fromEntries(sourceKeys.map((key) => [key, [...sources[key]].reverse()])) as unknown as TenantTelemetryRetainedSourceGraphInputs;
    expect(projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: reversed })).toEqual(expected);
    expect(sources).toEqual(before);
    for (const key of sourceKeys) {
      expect(projectTenantTelemetryRetainedSourceGraph({ tenantId,
        sources: replaceSource(sources, key, [...sources[key]].reverse()) })).toEqual(expected);
    }
  });

  it("retains distinct queued, reserved, and written evidence plus state-specific DB high-water", async () => {
    const f = await providerFixture();
    const snapshots = [f.pending, f.reserved, f.written];
    const projected = snapshots.map((sources) => projectTenantTelemetryRetainedSourceGraph({ tenantId, sources }));
    expect(f.pending.jobs[0]!.phase).toBe("queued"); expect(f.pending.jobs[0]!.reservation).toBeUndefined();
    expect(f.reserved.jobs[0]!.phase).toBe("queued"); expect(f.reserved.jobs[0]!.reservation).toBeDefined();
    expect(f.written.jobs[0]!.phase).toBe("written");
    expect(f.pending.inventories).toHaveLength(0); expect(f.pending.acks).toHaveLength(0);
    expect(f.written.inventories).toHaveLength(1); expect(f.written.acks).toHaveLength(1);
    const jobRows = projected.map((value) => value.observedRows.find((row) => row.sourceKind === "write_job")!);
    for (let index = 0; index < snapshots.length; index += 1) {
      expect(jobRows[index]!.sourceEvidenceSha256).toBe(tenantTelemetrySourceAccountingJobEvidenceSha256(snapshots[index]!.jobs[0]!));
    }
    expect(new Set(jobRows.map((row) => row.sourceEvidenceSha256)).size).toBe(3);
    expect(jobRows[1]!.sourceHighWaterDbMs).toBeGreaterThan(jobRows[0]!.sourceHighWaterDbMs);
    expect(jobRows[2]!.sourceHighWaterDbMs).toBeGreaterThan(jobRows[1]!.sourceHighWaterDbMs);
    expect(jobRows[1]!.sourceHighWaterDbMs).toBeGreaterThanOrEqual(f.reserved.jobs[0]!.reservation!.startedAtDbMs);
    const writtenJob = f.written.jobs[0]!;
    if (writtenJob.phase !== "written") throw new Error("expected the actual written job");
    expect(jobRows[2]!.sourceHighWaterDbMs).toBeGreaterThanOrEqual(writtenJob.writtenAtDbMs);
    expect(projected.map((value) => value.groups[0]!.sourceHighWaterDbMs)).toEqual(jobRows.map((row) => row.sourceHighWaterDbMs));
    expect(f.pending.providerFailureReceipts[0]).toEqual(f.failure);
    expect(f.reserved.providerFailureReceipts[0]).toEqual(f.failure);
    expect(f.written.providerFailureReceipts[0]).toEqual(f.failure);
  });

  it("does not omit an original provider failure/binding when every ordinary row is absent", async () => {
    const f = await providerFixture();
    const failureOnly = projectTenantTelemetryRetainedSourceGraph({ tenantId,
      sources: { ...emptySources(), providerFailureReceipts: f.pending.providerFailureReceipts } });
    expect(failureOnly.observedRows.map((row) => row.sourceKind)).toEqual(["provider_failure_commit"]);
    expect(failureOnly.groups[0]).toMatchObject({ operationSha256: f.operation, providerFailureReceipt: f.failure });
    expect(failureOnly.groups[0]!.job).toBeUndefined();
    const both = projectTenantTelemetryRetainedSourceGraph({ tenantId, sources: { ...emptySources(),
      providerFailureReceipts: f.pending.providerFailureReceipts, providerBindings: f.pending.providerBindings } });
    expect(both.observedRows.map((row) => row.sourceKind)).toEqual(["provider_source_binding", "provider_failure_commit"]);
    expect(both.groups).toHaveLength(1);
    expect(both.groups[0]!.inventory).toBeUndefined();
    expect(both.groups[0]!.ack).toBeUndefined();
  });
});
