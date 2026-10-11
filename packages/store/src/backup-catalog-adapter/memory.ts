import {
  tenantBackupAvailabilityOperationSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupCatalogEventSha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupRuntimeReservationOperationSha256,
  validateTenantBackupEvictionPlan,
  type ResolveTenantBackupRuntimeReservationInput,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupEvictionAdapterResult,
  type TenantBackupRuntimeReservationAdapterResult,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
} from "../backup-catalog.js";
import {
  TenantBackupCatalogAdapterConflictError,
  TenantBackupCatalogAdapterCorruptError,
  assertEventChain,
  backupCatalogAdapterSha256,
  emptyTenantBackupCatalogHead,
  eventProof,
  operationOf,
  proofOf,
  sameAdapterEvent,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupEvictionReceiptSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupResolutionReceiptSha256,
  validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogAdapterIdentity,
  validateTenantBackupCatalogHead,
  type PublishTenantBackupAvailabilityInput,
  type RecordTenantBackupEvictionInput,
  type ReserveTenantBackupRestoreInput,
  type ResolveTenantBackupRestoreInput,
  type ScanTenantBackupCatalogEventsOptions,
  type ScanTenantBackupCatalogEventsResult,
  type TenantBackupCatalogAdapter,
  type TenantBackupCatalogAdapterEvent,
  type TenantBackupCatalogAdapterIdentity,
  type TenantBackupCatalogHead,
} from "./common.js";

export const MEMORY_TENANT_BACKUP_CATALOG_PROTOCOL =
  "memory-tenant-backup-catalog-fixture-v1" as const;

export interface MemoryTenantBackupCatalogAdapterOptions {
  /** Mandatory acknowledgement that this in-process adapter is not a durable failure domain. */
  nonProductionFixture: true;
  namespaceId: string;
  targetId: string;
  failureDomainId: string;
  /** Runs after the immutable event is committed, allowing response-loss tests. */
  afterEventCommit?: (event: TenantBackupCatalogAdapterEvent) => void | Promise<void>;
}

function fixtureId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`memory tenant backup catalog ${name} is invalid`);
  }
  return value;
}

function fixtureDigest(scope: string, value: string): string {
  return backupCatalogAdapterSha256([scope, fixtureId(value, scope)]);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Explicit test fixture. It is neither durable nor independent from the process/database. */
export class MemoryTenantBackupCatalogAdapter implements TenantBackupCatalogAdapter {
  readonly adapterProtocol = MEMORY_TENANT_BACKUP_CATALOG_PROTOCOL;
  readonly catalogNamespaceSha256: string;
  readonly catalogTargetSha256: string;
  readonly failureDomainSha256: string;

  private readonly events: TenantBackupCatalogAdapterEvent[] = [];
  private readonly afterEventCommit?: MemoryTenantBackupCatalogAdapterOptions["afterEventCommit"];
  private closed = false;

  constructor(options: MemoryTenantBackupCatalogAdapterOptions) {
    if (options.nonProductionFixture !== true || process.env.NODE_ENV === "production") {
      throw new Error("memory tenant backup catalog is a non-production fixture only");
    }
    this.catalogNamespaceSha256 = fixtureDigest(
      "memory-tenant-backup-catalog-namespace-v1",
      options.namespaceId,
    );
    this.failureDomainSha256 = fixtureDigest(
      "memory-tenant-backup-catalog-failure-domain-v1",
      options.failureDomainId,
    );
    this.catalogTargetSha256 = backupCatalogAdapterSha256([
      "memory-tenant-backup-catalog-target-v1",
      this.catalogNamespaceSha256,
      this.failureDomainSha256,
      fixtureId(options.targetId, "target"),
    ]);
    this.afterEventCommit = options.afterEventCommit;
    validateTenantBackupCatalogAdapterIdentity(this.identity);
  }

  private get identity(): TenantBackupCatalogAdapterIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
      failureDomainSha256: this.failureDomainSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("memory tenant backup catalog is closed");
  }

  private validatedEvents(): TenantBackupCatalogAdapterEvent[] {
    assertEventChain(this.identity, this.events);
    return this.events;
  }

  private head(): TenantBackupCatalogHead {
    const events = this.validatedEvents();
    const last = events.at(-1);
    if (!last) return emptyTenantBackupCatalogHead(this.identity);
    const proof = proofOf(last);
    return {
      ...this.identity,
      catalogSequence: proof.catalogSequence,
      catalogEventRootSha256: proof.catalogEventRootSha256,
    };
  }

  private async append(event: TenantBackupCatalogAdapterEvent): Promise<TenantBackupCatalogAdapterEvent> {
    validateTenantBackupCatalogAdapterEvent(event);
    const existing = this.validatedEvents().find(
      (candidate) => operationOf(candidate) === operationOf(event),
    );
    if (existing) {
      if (!sameAdapterEvent(existing, event)) throw new TenantBackupCatalogAdapterConflictError();
      return clone(existing);
    }
    const expected = eventProof(
      this.head(),
      event.eventType,
      operationOf(event),
      event.eventType === "backup_recoverable"
        ? event.result.availabilityReceiptSha256
        : event.eventType === "restore_reserved"
          ? event.result.reservationReceiptSha256
          : event.eventType === "restore_resolved"
            ? event.result.resolutionReceiptSha256
            : event.result.acknowledgementReceiptSha256,
    );
    const actual = proofOf(event);
    if (expected.catalogSequence !== actual.catalogSequence
      || expected.previousCatalogEventRootSha256 !== actual.previousCatalogEventRootSha256
      || expected.catalogEventRootSha256 !== actual.catalogEventRootSha256
      || expected.catalogEventSha256 !== actual.catalogEventSha256) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    assertEventChain(this.identity, [...this.events, event]);
    this.events.push(clone(event));
    await this.afterEventCommit?.(clone(event));
    this.assertOpen();
    return clone(event);
  }

  private availability(backupId: string): TenantBackupAvailabilityAdapterResult | null {
    const events = this.validatedEvents();
    const event = events.find((candidate) => (
      candidate.eventType === "backup_recoverable" && candidate.result.backupId === backupId
    ));
    return event?.eventType === "backup_recoverable" ? clone(event.result) : null;
  }

  private activeReservationForBackup(backupId: string): boolean {
    const events = this.validatedEvents();
    const reserved = new Set<string>();
    for (const event of events) {
      if (event.eventType === "restore_reserved" && event.result.backupId === backupId) {
        reserved.add(event.result.restoreRunId);
      } else if (event.eventType === "restore_resolved") {
        reserved.delete(event.result.restoreRunId);
      }
    }
    return reserved.size > 0;
  }

  private hasActiveReservation(): boolean {
    const events = this.validatedEvents();
    const reserved = new Set<string>();
    for (const event of events) {
      if (event.eventType === "restore_reserved") {
        reserved.add(event.result.restoreRunId);
      } else if (event.eventType === "restore_resolved") {
        reserved.delete(event.result.restoreRunId);
      }
    }
    return reserved.size > 0;
  }

  private isEvicted(backupId: string): boolean {
    return this.validatedEvents().some((event) => (
      event.eventType === "backup_evicted" && event.result.backupId === backupId
    ));
  }

  async validateStartup(): Promise<void> {
    this.assertOpen();
    this.validatedEvents();
  }

  async publishAvailability(
    input: PublishTenantBackupAvailabilityInput,
  ): Promise<TenantBackupAvailabilityAdapterResult> {
    this.assertOpen();
    const operation = tenantBackupAvailabilityOperationSha256({
      ...input,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
    });
    const receipt = tenantBackupAvailabilityReceiptSha256(this.identity, input, operation);
    const existingForBackup = this.availability(input.backupId);
    if (existingForBackup) {
      if (existingForBackup.availabilityOperationSha256 !== operation
        || existingForBackup.availabilityReceiptSha256 !== receipt) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      return existingForBackup;
    }
    if (this.validatedEvents().some((event) => event.eventType === "backup_recoverable"
      && (event.result.sourceSnapshotSha256 === input.sourceSnapshotSha256
        || event.result.sourceBackupSha256 === input.sourceBackupSha256))) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const proof = eventProof(this.head(), "backup_recoverable", operation, receipt);
    const evidence = {
      ...this.identity,
      ...clone(input),
      availabilityOperationSha256: operation,
      availabilityReceiptSha256: receipt,
      ...proof,
    };
    const result: TenantBackupAvailabilityAdapterResult = {
      ...evidence,
      entrySha256: tenantBackupCatalogEntrySha256({
        scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
        protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
        ...evidence,
      }),
    };
    const committed = await this.append({ eventType: "backup_recoverable", result });
    if (committed.eventType !== "backup_recoverable") throw new TenantBackupCatalogAdapterCorruptError();
    return clone(committed.result);
  }

  async inspectAvailability(backupId: string): Promise<TenantBackupAvailabilityAdapterResult | null> {
    this.assertOpen();
    return this.availability(backupId);
  }

  async reserveRestore(
    input: ReserveTenantBackupRestoreInput,
  ): Promise<TenantBackupRuntimeReservationAdapterResult> {
    this.assertOpen();
    const operation = tenantBackupRuntimeReservationOperationSha256(input);
    const receipt = tenantBackupReservationReceiptSha256(this.identity, input, operation);
    const existing = this.validatedEvents().find((event) => (
      event.eventType === "restore_reserved" && event.result.restoreRunId === input.restoreRunId
    ));
    if (existing?.eventType === "restore_reserved") {
      if (existing.result.reservationOperationSha256 !== operation
        || existing.result.reservationReceiptSha256 !== receipt) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      return clone(existing.result);
    }
    const availability = this.availability(input.backupId);
    if (!availability || availability.entrySha256 !== input.entrySha256
      || this.isEvicted(input.backupId)
      || this.validatedEvents().some((event) => event.eventType === "restore_reserved"
        && event.result.runtimeEpochSha256 === input.runtimeEpochSha256)
      || this.hasActiveReservation()) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const proof = eventProof(this.head(), "restore_reserved", operation, receipt);
    const result: TenantBackupRuntimeReservationAdapterResult = {
      adapterProtocol: this.adapterProtocol,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
      ...clone(input),
      reservationOperationSha256: operation,
      reservationReceiptSha256: receipt,
      ...proof,
    };
    const committed = await this.append({ eventType: "restore_reserved", result });
    if (committed.eventType !== "restore_reserved") throw new TenantBackupCatalogAdapterCorruptError();
    return clone(committed.result);
  }

  async resolveRestore(
    input: ResolveTenantBackupRestoreInput,
  ): Promise<ResolveTenantBackupRuntimeReservationInput> {
    this.assertOpen();
    const reserved = this.validatedEvents().find((event) => (
      event.eventType === "restore_reserved" && event.result.restoreRunId === input.restoreRunId
    ));
    if (reserved?.eventType !== "restore_reserved") {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    if (reserved.result.reservationReceiptSha256 !== input.reservationReceiptSha256) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const operation = tenantBackupReservationResolutionOperationSha256(input);
    const receipt = tenantBackupResolutionReceiptSha256(input);
    const existing = this.validatedEvents().find((event) => (
      event.eventType === "restore_resolved" && event.result.restoreRunId === input.restoreRunId
    ));
    if (existing?.eventType === "restore_resolved") {
      if (existing.result.phase !== input.phase
        || existing.result.resolutionOperationSha256 !== operation
        || existing.result.resolutionReceiptSha256 !== receipt) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      return clone(existing.result);
    }
    const proof = eventProof(this.head(), "restore_resolved", operation, receipt);
    const result: ResolveTenantBackupRuntimeReservationInput = {
      restoreRunId: input.restoreRunId,
      reservationReceiptSha256: input.reservationReceiptSha256,
      phase: input.phase,
      resolutionOperationSha256: operation,
      resolutionReceiptSha256: receipt,
      ...proof,
    };
    const committed = await this.append({ eventType: "restore_resolved", result });
    if (committed.eventType !== "restore_resolved") throw new TenantBackupCatalogAdapterCorruptError();
    return clone(committed.result);
  }

  async recordEviction(
    input: RecordTenantBackupEvictionInput,
  ): Promise<TenantBackupEvictionAdapterResult> {
    this.assertOpen();
    validateTenantBackupEvictionPlan(input.plan);
    const operation = tenantBackupEvictionOperationSha256(input.plan);
    const receipt = tenantBackupEvictionReceiptSha256(input);
    const existing = this.validatedEvents().find((event) => (
      event.eventType === "backup_evicted" && event.result.backupId === input.plan.backupId
    ));
    if (existing?.eventType === "backup_evicted") {
      if (existing.result.evictionOperationSha256 !== operation
        || existing.result.acknowledgementReceiptSha256 !== receipt) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      return clone(existing.result);
    }
    const head = this.head();
    if (operation !== input.plan.evictionOperationSha256
      || !this.availability(input.plan.backupId)
      || this.isEvicted(input.plan.backupId)
      || this.activeReservationForBackup(input.plan.backupId)
      || input.plan.expectedCatalogSequence !== head.catalogSequence
      || input.plan.expectedCatalogEventRootSha256 !== head.catalogEventRootSha256) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const proof = eventProof(head, "backup_evicted", operation, receipt);
    const result: TenantBackupEvictionAdapterResult = {
      adapterProtocol: this.adapterProtocol,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
      evictionId: input.plan.evictionId,
      backupId: input.plan.backupId,
      planSha256: input.plan.planSha256,
      evictionOperationSha256: operation,
      acknowledgementReceiptSha256: receipt,
      externalTombstoneSha256: input.externalTombstoneSha256,
      observedAbsent: true,
      ...proof,
    };
    const committed = await this.append({ eventType: "backup_evicted", result });
    if (committed.eventType !== "backup_evicted") throw new TenantBackupCatalogAdapterCorruptError();
    return clone(committed.result);
  }

  async readHead(): Promise<TenantBackupCatalogHead> {
    this.assertOpen();
    const head = this.head();
    validateTenantBackupCatalogHead(head);
    return clone(head);
  }

  async scanEvents(
    options: ScanTenantBackupCatalogEventsOptions,
  ): Promise<ScanTenantBackupCatalogEventsResult> {
    this.assertOpen();
    validateTenantBackupCatalogHead(options.sealedHead);
    if (options.sealedHead.adapterProtocol !== this.adapterProtocol
      || options.sealedHead.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || options.sealedHead.catalogTargetSha256 !== this.catalogTargetSha256
      || options.sealedHead.failureDomainSha256 !== this.failureDomainSha256
      || !Number.isSafeInteger(options.afterCatalogSequence)
      || options.afterCatalogSequence < 0
      || options.afterCatalogSequence > options.sealedHead.catalogSequence
      || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const events = this.validatedEvents();
    const cursorRoot = options.afterCatalogSequence === 0
      ? emptyTenantBackupCatalogHead(this.identity).catalogEventRootSha256
      : proofOf(events[options.afterCatalogSequence - 1]!).catalogEventRootSha256;
    const sealedRoot = options.sealedHead.catalogSequence === 0
      ? emptyTenantBackupCatalogHead(this.identity).catalogEventRootSha256
      : proofOf(events[options.sealedHead.catalogSequence - 1]!).catalogEventRootSha256;
    if (cursorRoot !== options.afterCatalogEventRootSha256
      || sealedRoot !== options.sealedHead.catalogEventRootSha256) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const page = events.slice(
      options.afterCatalogSequence,
      Math.min(options.sealedHead.catalogSequence, options.afterCatalogSequence + options.limit),
    ).map(clone);
    const last = page.at(-1);
    const nextProof = last ? proofOf(last) : undefined;
    return {
      events: page,
      nextCatalogSequence: nextProof?.catalogSequence ?? options.afterCatalogSequence,
      nextCatalogEventRootSha256:
        nextProof?.catalogEventRootSha256 ?? options.afterCatalogEventRootSha256,
      complete: (nextProof?.catalogSequence ?? options.afterCatalogSequence)
        === options.sealedHead.catalogSequence,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
