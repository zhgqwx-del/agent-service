import { createHash } from "node:crypto";
import {
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionExternalEventOperation,
  tenantTelemetryDispositionExternalEventProof,
  validateTenantTelemetryDispositionEvidence,
  validateTenantTelemetryDispositionExternalHead,
  validateTenantTelemetryDispositionJournalIdentity,
  validateTenantTelemetrySameKeyTombstoneAck,
  type ScanTenantTelemetryDispositionEventsOptions,
  type ScanTenantTelemetryDispositionEventsResult,
  type TenantTelemetryDispositionEvidence,
  type TenantTelemetryDispositionExternalAdapter,
  type TenantTelemetryDispositionExternalEvent,
  type TenantTelemetryDispositionExternalHead,
  type TenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryExternalAuthorizationProof,
  type TenantTelemetryExternalTombstoneProof,
  type TenantTelemetrySameKeyTombstoneAck,
} from "../tenant-telemetry-disposition.js";
import {
  assertTenantTelemetryDispositionEventChain,
  buildTenantTelemetryExternalAuthorizationProof,
  buildTenantTelemetryExternalTombstoneProof,
  emptyTenantTelemetryDispositionHead,
  findTenantTelemetryDispositionAuthorization,
  findTenantTelemetryDispositionTerminal,
  headAfterTenantTelemetryDispositionEvent,
  sameTenantTelemetryDispositionEvent,
} from "./common.js";

export const MEMORY_TENANT_TELEMETRY_DISPOSITION_PROTOCOL =
  "memory-tenant-telemetry-disposition-journal-fixture-v1" as const;

export interface MemoryTenantTelemetryDispositionAdapterOptions {
  /** Mandatory acknowledgement that this process-local adapter is not a durable authority. */
  nonProductionFixture: true;
  namespaceId: string;
  targetId: string;
  failureDomainId: string;
  logicalDatabaseNamespaceSha256: string;
  /** Invoked after the immutable event is committed, for response-loss tests. */
  afterEventCommit?: (
    event: TenantTelemetryDispositionExternalEvent,
  ) => void | Promise<void>;
}

function fixtureId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`memory tenant telemetry disposition ${name} is invalid`);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function eventKey(event: TenantTelemetryDispositionExternalEvent): string {
  return `${event.eventType}:${tenantTelemetryDispositionExternalEventOperation(event)}`;
}

export class MemoryTenantTelemetryDispositionAdapter
implements TenantTelemetryDispositionExternalAdapter {
  readonly adapterProtocol = MEMORY_TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  readonly journalNamespaceSha256: string;
  readonly journalTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly events: TenantTelemetryDispositionExternalEvent[] = [];
  private readonly afterEventCommit?:
    MemoryTenantTelemetryDispositionAdapterOptions["afterEventCommit"];
  private closed = false;

  constructor(options: MemoryTenantTelemetryDispositionAdapterOptions) {
    if (options.nonProductionFixture !== true || process.env.NODE_ENV === "production") {
      throw new Error("memory tenant telemetry disposition is a non-production fixture only");
    }
    if (!/^[0-9a-f]{64}$/.test(options.logicalDatabaseNamespaceSha256)) {
      throw new Error("memory tenant telemetry disposition logical database namespace is invalid");
    }
    this.journalNamespaceSha256 = digest([
      "memory-tenant-telemetry-disposition-namespace-v1",
      fixtureId(options.namespaceId, "namespace"),
    ]);
    this.failureDomainSha256 = digest([
      "memory-tenant-telemetry-disposition-failure-domain-v1",
      fixtureId(options.failureDomainId, "failure domain"),
    ]);
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.journalTargetSha256 = digest([
      "memory-tenant-telemetry-disposition-target-v1",
      this.journalNamespaceSha256,
      this.failureDomainSha256,
      this.logicalDatabaseNamespaceSha256,
      fixtureId(options.targetId, "target"),
    ]);
    this.afterEventCommit = options.afterEventCommit;
    validateTenantTelemetryDispositionJournalIdentity(this.identity);
  }

  private get identity(): TenantTelemetryDispositionJournalIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      journalNamespaceSha256: this.journalNamespaceSha256,
      journalTargetSha256: this.journalTargetSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("memory tenant telemetry disposition adapter is closed");
  }

  private validatedEvents(): TenantTelemetryDispositionExternalEvent[] {
    assertTenantTelemetryDispositionEventChain(this.identity, this.events);
    return this.events;
  }

  private head(): TenantTelemetryDispositionExternalHead {
    const event = this.validatedEvents().at(-1);
    return event === undefined
      ? emptyTenantTelemetryDispositionHead(this.identity)
      : headAfterTenantTelemetryDispositionEvent(this.identity, event);
  }

  private async append(
    proposal: TenantTelemetryDispositionExternalEvent,
  ): Promise<TenantTelemetryDispositionExternalEvent> {
    const existing = this.validatedEvents().find(
      (candidate) => eventKey(candidate) === eventKey(proposal),
    );
    if (existing !== undefined) {
      if (!sameTenantTelemetryDispositionEvent(existing, proposal)) {
        throw new TenantTelemetryDispositionConflictError();
      }
      return clone(existing);
    }
    assertTenantTelemetryDispositionEventChain(this.identity, [...this.events, proposal]);
    this.events.push(clone(proposal));
    await this.afterEventCommit?.(clone(proposal));
    this.assertOpen();
    return clone(proposal);
  }

  async validateStartup(): Promise<void> {
    this.assertOpen();
    this.validatedEvents();
  }

  async authorizeDeletion(
    evidence: TenantTelemetryDispositionEvidence,
  ): Promise<TenantTelemetryExternalAuthorizationProof> {
    this.assertOpen();
    validateTenantTelemetryDispositionEvidence(evidence);
    const existing = findTenantTelemetryDispositionAuthorization(
      this.validatedEvents(),
      evidence.dispositionOperationSha256,
    );
    if (existing !== undefined) {
      const expected = buildTenantTelemetryExternalAuthorizationProof(
        this.identity,
        evidence,
        emptyTenantTelemetryDispositionHead(this.identity),
      );
      // Sequence/root differ on a non-genesis event; the immutable receipt binds the evidence.
      if (existing.authorizationReceiptSha256 !== expected.authorizationReceiptSha256) {
        throw new TenantTelemetryDispositionConflictError();
      }
      return clone(existing);
    }
    const result = buildTenantTelemetryExternalAuthorizationProof(
      this.identity,
      evidence,
      this.head(),
    );
    const committed = await this.append({ eventType: "delete_authorized", result });
    if (committed.eventType !== "delete_authorized") {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return clone(committed.result);
  }

  async recordTombstone(
    ack: TenantTelemetrySameKeyTombstoneAck,
  ): Promise<TenantTelemetryExternalTombstoneProof> {
    this.assertOpen();
    validateTenantTelemetrySameKeyTombstoneAck(ack);
    const events = this.validatedEvents();
    const authorization = findTenantTelemetryDispositionAuthorization(
      events,
      ack.dispositionOperationSha256,
    );
    if (authorization === undefined) throw new TenantTelemetryDispositionConflictError();
    const existing = findTenantTelemetryDispositionTerminal(
      events,
      ack.dispositionOperationSha256,
    );
    if (existing !== undefined) {
      if (existing.tombstoneAck.receiptSha256 !== ack.receiptSha256) {
        throw new TenantTelemetryDispositionConflictError();
      }
      return clone(existing);
    }
    const result = buildTenantTelemetryExternalTombstoneProof(
      this.identity,
      authorization,
      ack,
      this.head(),
    );
    const committed = await this.append({ eventType: "delete_tombstoned", result });
    if (committed.eventType !== "delete_tombstoned") {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return clone(committed.result);
  }

  async readHead(): Promise<TenantTelemetryDispositionExternalHead> {
    this.assertOpen();
    const head = this.head();
    validateTenantTelemetryDispositionExternalHead(head);
    return clone(head);
  }

  async scanEvents(
    options: ScanTenantTelemetryDispositionEventsOptions,
  ): Promise<ScanTenantTelemetryDispositionEventsResult> {
    this.assertOpen();
    validateTenantTelemetryDispositionExternalHead(options.sealedHead);
    const sealed = options.sealedHead;
    if (sealed.adapterProtocol !== this.adapterProtocol
      || sealed.journalNamespaceSha256 !== this.journalNamespaceSha256
      || sealed.journalTargetSha256 !== this.journalTargetSha256
      || sealed.failureDomainSha256 !== this.failureDomainSha256
      || sealed.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
      || !Number.isSafeInteger(options.afterJournalSequence)
      || options.afterJournalSequence < 0
      || options.afterJournalSequence > sealed.journalSequence
      || !/^[0-9a-f]{64}$/.test(options.afterJournalEventRootSha256)
      || !Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const events = this.validatedEvents();
    if (sealed.journalSequence > events.length) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const cursorRoot = options.afterJournalSequence === 0
      ? emptyTenantTelemetryDispositionHead(this.identity).journalEventRootSha256
      : tenantTelemetryDispositionExternalEventProof(
        events[options.afterJournalSequence - 1]!,
      ).journalEventRootSha256;
    const sealedRoot = sealed.journalSequence === 0
      ? emptyTenantTelemetryDispositionHead(this.identity).journalEventRootSha256
      : tenantTelemetryDispositionExternalEventProof(
        events[sealed.journalSequence - 1]!,
      ).journalEventRootSha256;
    if (cursorRoot !== options.afterJournalEventRootSha256
      || sealedRoot !== sealed.journalEventRootSha256) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const page = events.slice(
      options.afterJournalSequence,
      Math.min(sealed.journalSequence, options.afterJournalSequence + options.limit),
    ).map(clone);
    const last = page.at(-1);
    const proof = last === undefined
      ? undefined
      : tenantTelemetryDispositionExternalEventProof(last);
    const nextJournalSequence = proof?.journalSequence ?? options.afterJournalSequence;
    return {
      events: page,
      nextJournalSequence,
      nextJournalEventRootSha256:
        proof?.journalEventRootSha256 ?? options.afterJournalEventRootSha256,
      complete: nextJournalSequence === sealed.journalSequence,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
