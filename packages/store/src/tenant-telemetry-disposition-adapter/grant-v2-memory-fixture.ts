import { createHash } from "node:crypto";
import {
  TenantTelemetryDispositionConflictError,
  type TenantTelemetryDispositionAuthorizationGrant,
  type TenantTelemetryDispositionJournalIdentity,
} from "../tenant-telemetry-disposition.js";
import {
  assertTenantTelemetryGrantAuthorizationMatchesV2,
  assertTenantTelemetryGrantJournalChainV2,
  buildFixtureTenantTelemetryGrantAuthorizationEventV2,
  emptyTenantTelemetryGrantJournalHeadV2,
  headAfterTenantTelemetryGrantAuthorizationEventV2,
  validateTenantTelemetryGrantJournalHeadV2,
  type TenantTelemetryGrantAuthorizationEventV2,
  type TenantTelemetryGrantJournalHeadV2,
} from "./grant-v2.js";

export const MEMORY_TENANT_TELEMETRY_GRANT_JOURNAL_FIXTURE_PROTOCOL_V2 =
  "memory-tenant-telemetry-disposition-grant-journal-fixture-v2" as const;

export interface MemoryTenantTelemetryGrantJournalFixtureV2Options {
  nonProductionFixture: true;
  namespaceId: string;
  targetId: string;
  failureDomainId: string;
  logicalDatabaseNamespaceSha256: string;
  /** Simulates a lost response after an already durable fixture event. */
  afterEventCommit?: (
    event: TenantTelemetryGrantAuthorizationEventV2,
  ) => void | Promise<void>;
}

function fixtureId(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`memory telemetry grant journal ${name} is invalid`);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameHead(
  left: TenantTelemetryGrantJournalHeadV2,
  right: TenantTelemetryGrantJournalHeadV2,
): boolean {
  return left.adapterProtocol === right.adapterProtocol
    && left.journalNamespaceSha256 === right.journalNamespaceSha256
    && left.journalTargetSha256 === right.journalTargetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.logicalDatabaseNamespaceSha256 === right.logicalDatabaseNamespaceSha256
    && left.journalSequence === right.journalSequence
    && left.journalEventRootSha256 === right.journalEventRootSha256;
}

function sameIdentity(
  left: TenantTelemetryGrantJournalHeadV2,
  right: TenantTelemetryGrantJournalHeadV2,
): boolean {
  return left.adapterProtocol === right.adapterProtocol
    && left.journalNamespaceSha256 === right.journalNamespaceSha256
    && left.journalTargetSha256 === right.journalTargetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.logicalDatabaseNamespaceSha256 === right.logicalDatabaseNamespaceSha256;
}

/**
 * Protocol test fixture only. It has no product-authorizing method and never
 * proves a caller-provided grant exists in MySQL. A future production adapter
 * must first verify the exact, live grant at a trusted DB-time boundary.
 */
export class MemoryTenantTelemetryGrantJournalFixtureV2 {
  readonly adapterProtocol = MEMORY_TENANT_TELEMETRY_GRANT_JOURNAL_FIXTURE_PROTOCOL_V2;
  readonly journalNamespaceSha256: string;
  readonly journalTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly events: TenantTelemetryGrantAuthorizationEventV2[] = [];
  private readonly afterEventCommit?: MemoryTenantTelemetryGrantJournalFixtureV2Options["afterEventCommit"];
  private closed = false;

  constructor(options: MemoryTenantTelemetryGrantJournalFixtureV2Options) {
    if (options.nonProductionFixture !== true || process.env.NODE_ENV === "production") {
      throw new Error("memory telemetry grant journal is a non-production fixture only");
    }
    if (!/^[0-9a-f]{64}$/.test(options.logicalDatabaseNamespaceSha256)) {
      throw new Error("memory telemetry grant journal database namespace is invalid");
    }
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.journalNamespaceSha256 = digest([
      "memory-tenant-telemetry-grant-journal-namespace-v2",
      fixtureId(options.namespaceId, "namespace"),
    ]);
    this.failureDomainSha256 = digest([
      "memory-tenant-telemetry-grant-journal-failure-domain-v2",
      fixtureId(options.failureDomainId, "failure domain"),
    ]);
    this.journalTargetSha256 = digest([
      "memory-tenant-telemetry-grant-journal-target-v2",
      this.journalNamespaceSha256,
      this.failureDomainSha256,
      this.logicalDatabaseNamespaceSha256,
      fixtureId(options.targetId, "target"),
    ]);
    this.afterEventCommit = options.afterEventCommit;
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
    if (this.closed) throw new Error("memory telemetry grant journal fixture is closed");
  }

  private head(): TenantTelemetryGrantJournalHeadV2 {
    const last = this.events.at(-1);
    return last === undefined
      ? emptyTenantTelemetryGrantJournalHeadV2(this.identity)
      : headAfterTenantTelemetryGrantAuthorizationEventV2(last);
  }

  async readHead(): Promise<TenantTelemetryGrantJournalHeadV2> {
    this.assertOpen();
    const head = this.head();
    assertTenantTelemetryGrantJournalChainV2(this.identity, this.events, head);
    return structuredClone(head);
  }

  async appendFixtureAuthorization(
    grant: TenantTelemetryDispositionAuthorizationGrant,
    expectedHead: TenantTelemetryGrantJournalHeadV2,
  ): Promise<TenantTelemetryGrantAuthorizationEventV2> {
    this.assertOpen();
    validateTenantTelemetryGrantJournalHeadV2(expectedHead);
    const current = this.head();
    assertTenantTelemetryGrantJournalChainV2(this.identity, this.events, current);
    if (!sameIdentity(current, expectedHead)) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const existing = this.events.find(
      (event) => event.dispositionOperationSha256 === grant.dispositionOperationSha256,
    );
    if (existing !== undefined) {
      assertTenantTelemetryGrantAuthorizationMatchesV2(existing, grant);
      if (!sameHead(current, expectedHead)
        && !(expectedHead.journalSequence === existing.journalSequence - 1
          && expectedHead.journalEventRootSha256
            === existing.previousJournalEventRootSha256)) {
        throw new TenantTelemetryDispositionConflictError();
      }
      return structuredClone(existing);
    }
    if (!sameHead(current, expectedHead)) throw new TenantTelemetryDispositionConflictError();
    const event = buildFixtureTenantTelemetryGrantAuthorizationEventV2(
      this.identity,
      grant,
      current,
      true,
    );
    const next = headAfterTenantTelemetryGrantAuthorizationEventV2(event);
    assertTenantTelemetryGrantJournalChainV2(this.identity, [...this.events, event], next);
    this.events.push(structuredClone(event));
    await this.afterEventCommit?.(structuredClone(event));
    this.assertOpen();
    return structuredClone(event);
  }

  async scanSealedEvents(
    sealedHead: TenantTelemetryGrantJournalHeadV2,
  ): Promise<TenantTelemetryGrantAuthorizationEventV2[]> {
    this.assertOpen();
    validateTenantTelemetryGrantJournalHeadV2(sealedHead);
    if (sealedHead.journalSequence > this.events.length) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const prefix = this.events.slice(0, sealedHead.journalSequence);
    assertTenantTelemetryGrantJournalChainV2(this.identity, prefix, sealedHead);
    return structuredClone(prefix);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
