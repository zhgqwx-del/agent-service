import { createHash } from "node:crypto";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  tenantBackupAvailabilityOperationSha256,
  tenantBackupCatalogEventSha256,
  tenantBackupCatalogNextEventRootSha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionPlanSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupRuntimeReservationOperationSha256,
  validateTenantBackupAvailabilityAdapterResult,
  validateTenantBackupCatalogEventProof,
  validateTenantBackupEvictionAdapterResult,
  validateTenantBackupEvictionPlan,
  validateTenantBackupRuntimeReservationAdapterResult,
  type ResolveTenantBackupRuntimeReservationInput,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupCatalogEventProof,
  type TenantBackupEvictionAdapterResult,
  type TenantBackupEvictionPlan,
  type TenantBackupRuntimeReservationAdapterResult,
} from "../backup-catalog.js";

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;
const RESTORE_RUN_ID =
  /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type TenantBackupCatalogEventType =
  | "backup_recoverable"
  | "restore_reserved"
  | "restore_resolved"
  | "backup_evicted";

export interface TenantBackupCatalogAdapterIdentity {
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
}

export interface TenantBackupCatalogHead extends TenantBackupCatalogAdapterIdentity {
  catalogSequence: number;
  catalogEventRootSha256: string;
}

export interface PublishTenantBackupAvailabilityInput {
  backupId: string;
  anchorSha256: string;
  sourceSnapshotSha256: string;
  sourceBackupSha256: string;
  artifactManifestSha256: string;
  providerEvidenceSha256: string;
  controlEvidenceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  retentionPolicySha256: string;
  retentionUntilDbMs: number;
  registeredAtDbMs: number;
}

export interface ReserveTenantBackupRestoreInput {
  backupId: string;
  restoreRunId: string;
  entrySha256: string;
  runtimeEpochSha256: string;
}

export interface ResolveTenantBackupRestoreInput {
  restoreRunId: string;
  reservationReceiptSha256: string;
  phase: "activated" | "aborted";
}

export interface RecordTenantBackupEvictionInput {
  plan: TenantBackupEvictionPlan;
  externalTombstoneSha256: string;
  observedAbsent: true;
}

export type TenantBackupCatalogAdapterEvent =
  | { eventType: "backup_recoverable"; result: TenantBackupAvailabilityAdapterResult }
  | { eventType: "restore_reserved"; result: TenantBackupRuntimeReservationAdapterResult }
  | { eventType: "restore_resolved"; result: ResolveTenantBackupRuntimeReservationInput }
  | { eventType: "backup_evicted"; result: TenantBackupEvictionAdapterResult };

export interface ScanTenantBackupCatalogEventsOptions {
  afterCatalogSequence: number;
  afterCatalogEventRootSha256: string;
  sealedHead: TenantBackupCatalogHead;
  limit: number;
}

export interface ScanTenantBackupCatalogEventsResult {
  events: TenantBackupCatalogAdapterEvent[];
  nextCatalogSequence: number;
  nextCatalogEventRootSha256: string;
  complete: boolean;
}

export interface TenantBackupCatalogAdapter {
  readonly adapterProtocol: string;
  readonly catalogNamespaceSha256: string;
  readonly catalogTargetSha256: string;
  readonly failureDomainSha256: string;
  validateStartup(): Promise<void>;
  publishAvailability(
    input: PublishTenantBackupAvailabilityInput,
  ): Promise<TenantBackupAvailabilityAdapterResult>;
  inspectAvailability(backupId: string): Promise<TenantBackupAvailabilityAdapterResult | null>;
  reserveRestore(
    input: ReserveTenantBackupRestoreInput,
  ): Promise<TenantBackupRuntimeReservationAdapterResult>;
  resolveRestore(
    input: ResolveTenantBackupRestoreInput,
  ): Promise<ResolveTenantBackupRuntimeReservationInput>;
  recordEviction(
    input: RecordTenantBackupEvictionInput,
  ): Promise<TenantBackupEvictionAdapterResult>;
  readHead(): Promise<TenantBackupCatalogHead>;
  scanEvents(options: ScanTenantBackupCatalogEventsOptions):
    Promise<ScanTenantBackupCatalogEventsResult>;
  close(): Promise<void>;
}

export class TenantBackupCatalogAdapterConflictError extends Error {
  constructor() {
    super("tenant backup catalog external operation conflicts with immutable evidence");
    this.name = "TenantBackupCatalogAdapterConflictError";
  }
}

export class TenantBackupCatalogAdapterCorruptError extends Error {
  constructor() {
    super("tenant backup catalog external event chain is corrupt");
    this.name = "TenantBackupCatalogAdapterCorruptError";
  }
}

export function backupCatalogAdapterSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateTenantBackupCatalogAdapterIdentity(
  identity: TenantBackupCatalogAdapterIdentity,
): void {
  if (!IDENTIFIER.test(identity.adapterProtocol)) {
    throw new Error("tenant backup catalog adapter protocol is invalid");
  }
  for (const value of [
    identity.catalogNamespaceSha256,
    identity.catalogTargetSha256,
    identity.failureDomainSha256,
  ]) {
    if (!SHA256.test(value)) throw new Error("tenant backup catalog adapter identity is invalid");
  }
}

export function emptyTenantBackupCatalogHead(
  identity: TenantBackupCatalogAdapterIdentity,
): TenantBackupCatalogHead {
  validateTenantBackupCatalogAdapterIdentity(identity);
  return {
    ...identity,
    catalogSequence: 0,
    catalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  };
}

export function validateTenantBackupCatalogHead(head: TenantBackupCatalogHead): void {
  validateTenantBackupCatalogAdapterIdentity(head);
  if (!Number.isSafeInteger(head.catalogSequence) || head.catalogSequence < 0
    || !SHA256.test(head.catalogEventRootSha256)
    || (head.catalogSequence === 0
      && head.catalogEventRootSha256 !== EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256)) {
    throw new TenantBackupCatalogAdapterCorruptError();
  }
}

export function tenantBackupAvailabilityReceiptSha256(
  identity: TenantBackupCatalogAdapterIdentity,
  input: PublishTenantBackupAvailabilityInput,
  operationSha256 = tenantBackupAvailabilityOperationSha256({
    ...input,
    catalogNamespaceSha256: identity.catalogNamespaceSha256,
    catalogTargetSha256: identity.catalogTargetSha256,
  }),
): string {
  validateTenantBackupCatalogAdapterIdentity(identity);
  return backupCatalogAdapterSha256([
    "tenant-backup-availability-receipt-v1",
    identity.adapterProtocol,
    identity.catalogNamespaceSha256,
    identity.catalogTargetSha256,
    identity.failureDomainSha256,
    input.backupId,
    input.anchorSha256,
    input.sourceSnapshotSha256,
    input.sourceBackupSha256,
    input.artifactManifestSha256,
    input.providerEvidenceSha256,
    input.controlEvidenceSha256,
    input.logicalDatabaseNamespaceSha256,
    input.retentionPolicySha256,
    input.retentionUntilDbMs,
    input.registeredAtDbMs,
    operationSha256,
  ]);
}

export function tenantBackupReservationReceiptSha256(
  identity: TenantBackupCatalogAdapterIdentity,
  input: ReserveTenantBackupRestoreInput,
  operationSha256 = tenantBackupRuntimeReservationOperationSha256(input),
): string {
  validateTenantBackupCatalogAdapterIdentity(identity);
  return backupCatalogAdapterSha256([
    "tenant-backup-runtime-reservation-receipt-v1",
    identity.adapterProtocol,
    identity.catalogNamespaceSha256,
    identity.catalogTargetSha256,
    input.backupId,
    input.restoreRunId,
    input.entrySha256,
    input.runtimeEpochSha256,
    operationSha256,
  ]);
}

export function tenantBackupResolutionReceiptSha256(input: ResolveTenantBackupRestoreInput): string {
  return backupCatalogAdapterSha256([
    "tenant-backup-runtime-resolution-receipt-v1",
    input.restoreRunId,
    input.reservationReceiptSha256,
    input.phase,
  ]);
}

export function tenantBackupEvictionReceiptSha256(
  input: RecordTenantBackupEvictionInput,
): string {
  validateTenantBackupEvictionPlan(input.plan);
  if (input.observedAbsent !== true || !SHA256.test(input.externalTombstoneSha256)) {
    throw new Error("tenant backup eviction physical acknowledgement is invalid");
  }
  return backupCatalogAdapterSha256([
    "tenant-backup-eviction-receipt-v1",
    input.plan.evictionId,
    input.plan.backupId,
    input.plan.planSha256,
    input.plan.evictionOperationSha256,
    input.externalTombstoneSha256,
    true,
  ]);
}

export function eventProof(
  previous: TenantBackupCatalogHead,
  eventType: TenantBackupCatalogEventType,
  operationSha256: string,
  receiptSha256: string,
): TenantBackupCatalogEventProof {
  validateTenantBackupCatalogHead(previous);
  const catalogSequence = previous.catalogSequence + 1;
  if (!Number.isSafeInteger(catalogSequence)) throw new Error("tenant backup catalog is too large");
  const catalogEventSha256 = tenantBackupCatalogEventSha256({
    eventType,
    operationSha256,
    receiptSha256,
  });
  const proof = {
    catalogSequence,
    previousCatalogEventRootSha256: previous.catalogEventRootSha256,
    catalogEventSha256,
    catalogEventRootSha256: tenantBackupCatalogNextEventRootSha256({
      previousCatalogEventRootSha256: previous.catalogEventRootSha256,
      catalogSequence,
      catalogEventSha256,
    }),
  };
  validateTenantBackupCatalogEventProof(proof, catalogEventSha256);
  return proof;
}

export function validateTenantBackupCatalogAdapterEvent(
  event: TenantBackupCatalogAdapterEvent,
): void {
  if (event.eventType === "backup_recoverable") {
    validateTenantBackupAvailabilityAdapterResult(event.result);
  } else if (event.eventType === "restore_reserved") {
    validateTenantBackupRuntimeReservationAdapterResult(event.result);
  } else if (event.eventType === "restore_resolved") {
    if (!exactKeys(event.result, [
      "restoreRunId", "reservationReceiptSha256", "phase", "resolutionOperationSha256",
      "resolutionReceiptSha256",
      "catalogSequence", "previousCatalogEventRootSha256", "catalogEventRootSha256",
      "catalogEventSha256",
    ])
      || !RESTORE_RUN_ID.test(event.result.restoreRunId)
      || !SHA256.test(event.result.reservationReceiptSha256)
      || (event.result.phase !== "activated" && event.result.phase !== "aborted")
      || !SHA256.test(event.result.resolutionOperationSha256)
      || !SHA256.test(event.result.resolutionReceiptSha256)) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (event.result.resolutionOperationSha256
      !== tenantBackupReservationResolutionOperationSha256({
        restoreRunId: event.result.restoreRunId,
        reservationReceiptSha256: event.result.reservationReceiptSha256,
        phase: event.result.phase,
      })
      || event.result.resolutionReceiptSha256 !== tenantBackupResolutionReceiptSha256({
        restoreRunId: event.result.restoreRunId,
        reservationReceiptSha256: event.result.reservationReceiptSha256,
        phase: event.result.phase,
      })) throw new TenantBackupCatalogAdapterCorruptError();
    validateTenantBackupCatalogEventProof({
      catalogSequence: event.result.catalogSequence,
      previousCatalogEventRootSha256: event.result.previousCatalogEventRootSha256,
      catalogEventRootSha256: event.result.catalogEventRootSha256,
      catalogEventSha256: event.result.catalogEventSha256,
    }, tenantBackupCatalogEventSha256({
      eventType: "restore_resolved",
      operationSha256: event.result.resolutionOperationSha256,
      receiptSha256: event.result.resolutionReceiptSha256,
    }));
  } else if (event.eventType === "backup_evicted") {
    validateTenantBackupEvictionAdapterResult(event.result);
  } else {
    throw new TenantBackupCatalogAdapterCorruptError();
  }
}

export function operationOf(event: TenantBackupCatalogAdapterEvent): string {
  if (event.eventType === "backup_recoverable") return event.result.availabilityOperationSha256;
  if (event.eventType === "restore_reserved") return event.result.reservationOperationSha256;
  if (event.eventType === "restore_resolved") return event.result.resolutionOperationSha256;
  return event.result.evictionOperationSha256;
}

export function receiptOf(event: TenantBackupCatalogAdapterEvent): string {
  if (event.eventType === "backup_recoverable") return event.result.availabilityReceiptSha256;
  if (event.eventType === "restore_reserved") return event.result.reservationReceiptSha256;
  if (event.eventType === "restore_resolved") return event.result.resolutionReceiptSha256;
  return event.result.acknowledgementReceiptSha256;
}

export function proofOf(event: TenantBackupCatalogAdapterEvent): TenantBackupCatalogEventProof {
  const result = event.result;
  return {
    catalogSequence: result.catalogSequence,
    previousCatalogEventRootSha256: result.previousCatalogEventRootSha256,
    catalogEventRootSha256: result.catalogEventRootSha256,
    catalogEventSha256: result.catalogEventSha256,
  };
}

export function assertEventChain(
  identity: TenantBackupCatalogAdapterIdentity,
  events: readonly TenantBackupCatalogAdapterEvent[],
): void {
  validateTenantBackupCatalogAdapterIdentity(identity);
  let head = emptyTenantBackupCatalogHead(identity);
  const operations = new Set<string>();
  const backups = new Map<string, TenantBackupAvailabilityAdapterResult>();
  const sourceSnapshots = new Set<string>();
  const sourceBackups = new Set<string>();
  const restoreRuns = new Set<string>();
  const resolvedRuns = new Set<string>();
  const runtimeEpochs = new Set<string>();
  const activeReservations = new Map<string, {
    backupId: string;
    reservationReceiptSha256: string;
  }>();
  const evictedBackups = new Set<string>();
  for (const event of events) {
    validateTenantBackupCatalogAdapterEvent(event);
    const proof = proofOf(event);
    if (operations.has(operationOf(event))
      || proof.catalogSequence !== head.catalogSequence + 1
      || proof.previousCatalogEventRootSha256 !== head.catalogEventRootSha256) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (event.eventType === "backup_recoverable") {
      const result = event.result;
      if (result.adapterProtocol !== identity.adapterProtocol
        || result.catalogNamespaceSha256 !== identity.catalogNamespaceSha256
        || result.catalogTargetSha256 !== identity.catalogTargetSha256
        || result.failureDomainSha256 !== identity.failureDomainSha256
        || backups.has(result.backupId)
        || sourceSnapshots.has(result.sourceSnapshotSha256)
        || sourceBackups.has(result.sourceBackupSha256)
        || result.availabilityReceiptSha256 !== tenantBackupAvailabilityReceiptSha256(
          identity,
          {
            backupId: result.backupId,
            anchorSha256: result.anchorSha256,
            sourceSnapshotSha256: result.sourceSnapshotSha256,
            sourceBackupSha256: result.sourceBackupSha256,
            artifactManifestSha256: result.artifactManifestSha256,
            providerEvidenceSha256: result.providerEvidenceSha256,
            controlEvidenceSha256: result.controlEvidenceSha256,
            logicalDatabaseNamespaceSha256: result.logicalDatabaseNamespaceSha256,
            retentionPolicySha256: result.retentionPolicySha256,
            retentionUntilDbMs: result.retentionUntilDbMs,
            registeredAtDbMs: result.registeredAtDbMs,
          },
          result.availabilityOperationSha256,
        )) throw new TenantBackupCatalogAdapterCorruptError();
      backups.set(result.backupId, result);
      sourceSnapshots.add(result.sourceSnapshotSha256);
      sourceBackups.add(result.sourceBackupSha256);
    } else if (event.eventType === "restore_reserved") {
      const result = event.result;
      if (result.adapterProtocol !== identity.adapterProtocol
        || result.catalogNamespaceSha256 !== identity.catalogNamespaceSha256
        || result.catalogTargetSha256 !== identity.catalogTargetSha256
        || backups.get(result.backupId)?.entrySha256 !== result.entrySha256
        || evictedBackups.has(result.backupId)
        || restoreRuns.has(result.restoreRunId)
        || runtimeEpochs.has(result.runtimeEpochSha256)
        || activeReservations.size > 0
        || result.reservationReceiptSha256 !== tenantBackupReservationReceiptSha256(
          identity,
          {
            backupId: result.backupId,
            restoreRunId: result.restoreRunId,
            entrySha256: result.entrySha256,
            runtimeEpochSha256: result.runtimeEpochSha256,
          },
          result.reservationOperationSha256,
        )) throw new TenantBackupCatalogAdapterCorruptError();
      restoreRuns.add(result.restoreRunId);
      runtimeEpochs.add(result.runtimeEpochSha256);
      activeReservations.set(result.restoreRunId, {
        backupId: result.backupId,
        reservationReceiptSha256: result.reservationReceiptSha256,
      });
    } else if (event.eventType === "restore_resolved") {
      const active = activeReservations.get(event.result.restoreRunId);
      if (!active
        || event.result.reservationReceiptSha256 !== active.reservationReceiptSha256
        || resolvedRuns.has(event.result.restoreRunId)) {
        throw new TenantBackupCatalogAdapterCorruptError();
      }
      activeReservations.delete(event.result.restoreRunId);
      resolvedRuns.add(event.result.restoreRunId);
    } else {
      const result = event.result;
      const availability = backups.get(result.backupId);
      const activeForBackup = [...activeReservations.values()]
        .some((reservation) => reservation.backupId === result.backupId);
      const expectedPlanSource = availability === undefined ? undefined : {
        evictionId: result.evictionId,
        backupId: result.backupId,
        anchorSha256: availability.anchorSha256,
        entrySha256: availability.entrySha256,
        sourceSnapshotSha256: availability.sourceSnapshotSha256,
        sourceBackupSha256: availability.sourceBackupSha256,
        artifactManifestSha256: availability.artifactManifestSha256,
        providerEvidenceSha256: availability.providerEvidenceSha256,
        controlEvidenceSha256: availability.controlEvidenceSha256,
        retentionPolicySha256: availability.retentionPolicySha256,
        retentionUntilDbMs: availability.retentionUntilDbMs,
        expectedCatalogSequence: head.catalogSequence,
        expectedCatalogEventRootSha256: head.catalogEventRootSha256,
      };
      const expectedOperation = expectedPlanSource === undefined
        ? undefined
        : tenantBackupEvictionOperationSha256(expectedPlanSource);
      const expectedPlanSha256 = expectedPlanSource === undefined || expectedOperation === undefined
        ? undefined
        : tenantBackupEvictionPlanSha256({
            ...expectedPlanSource,
            evictionOperationSha256: expectedOperation,
          });
      const expectedReceipt = backupCatalogAdapterSha256([
        "tenant-backup-eviction-receipt-v1",
        result.evictionId,
        result.backupId,
        result.planSha256,
        result.evictionOperationSha256,
        result.externalTombstoneSha256,
        true,
      ]);
      if (result.adapterProtocol !== identity.adapterProtocol
        || result.catalogNamespaceSha256 !== identity.catalogNamespaceSha256
        || result.catalogTargetSha256 !== identity.catalogTargetSha256
        || availability === undefined
        || evictedBackups.has(result.backupId)
        || activeForBackup
        || result.evictionOperationSha256 !== expectedOperation
        || result.planSha256 !== expectedPlanSha256
        || result.acknowledgementReceiptSha256 !== expectedReceipt) {
        throw new TenantBackupCatalogAdapterCorruptError();
      }
      evictedBackups.add(result.backupId);
    }
    operations.add(operationOf(event));
    head = { ...identity, catalogSequence: proof.catalogSequence,
      catalogEventRootSha256: proof.catalogEventRootSha256 };
  }
}

export function sameAdapterEvent(
  left: TenantBackupCatalogAdapterEvent,
  right: TenantBackupCatalogAdapterEvent,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function tenantBackupCatalogAdapterEventSha256(
  event: TenantBackupCatalogAdapterEvent,
): string {
  validateTenantBackupCatalogAdapterEvent(event);
  return createHash("sha256")
    .update(canonicalJson(event))
    .digest("hex");
}
