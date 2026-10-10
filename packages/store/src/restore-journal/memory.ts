import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  validateScanTenantRestoreJournalRecordsOptions,
  validateScanTenantRestoreJournalRecordsResult,
  type ScanTenantRestoreJournalRecordsOptions,
  type ScanTenantRestoreJournalRecordsResult,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalRemoteHead,
} from "../tenant-restore-journal.js";
import {
  TenantRestoreJournalConflictError,
  TenantRestoreJournalCorruptError,
  adapterResult,
  assertRecordForAdapter,
  emptyRemoteHead,
  headFromEntries,
  remoteEntry,
  sameRestoreJournalRecord,
  sha256,
  validateRestoreJournalAdapterIdentity,
  type RestoreJournalAdapterIdentity,
} from "./common.js";
import {
  buildRestoreJournalStoredHead,
  type RestoreJournalStoredHead,
} from "./serialization.js";

export const MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL =
  "memory-tenant-restore-journal-fixture-v1" as const;

export interface MemoryTenantRestoreJournalAdapterOptions {
  /** Mandatory acknowledgement that this adapter is an in-process test fixture, not a restore domain. */
  nonProductionFixture: true;
  namespaceId: string;
  /** Non-secret fixture label used only to exercise failure-domain binding. */
  failureDomainId: string;
  /** Non-secret fixture target label. */
  targetId: string;
  logicalDatabaseNamespaceSha256: string;
  /** Fault-injection hook used to leave a safe orphan record before immutable head publication. */
  afterRecordCreate?: (record: TenantRestoreJournalRecord) => void | Promise<void>;
}

function validateFixtureId(value: string, name: "namespace" | "failure domain" | "target"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`memory restore journal ${name} id is invalid`);
  }
}

export function memoryTenantRestoreJournalNamespaceSha256(namespaceId: string): string {
  validateFixtureId(namespaceId, "namespace");
  return sha256(["memory-tenant-restore-journal-namespace-v1", namespaceId]);
}

export function memoryTenantRestoreJournalFailureDomainSha256(failureDomainId: string): string {
  validateFixtureId(failureDomainId, "failure domain");
  return sha256(["memory-tenant-restore-journal-failure-domain-v1", failureDomainId]);
}

export function memoryTenantRestoreJournalTargetSha256(input: {
  journalNamespaceSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  targetId: string;
}): string {
  validateFixtureId(input.targetId, "target");
  validateRestoreJournalAdapterIdentity({
    adapterProtocol: MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256: input.journalNamespaceSha256,
    failureDomainSha256: input.failureDomainSha256,
    logicalDatabaseNamespaceSha256: input.logicalDatabaseNamespaceSha256,
    // The input digests are validated before the derived target digest exists.
    targetSha256: "0".repeat(64),
  });
  return sha256([
    "memory-tenant-restore-journal-target-v1",
    MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL,
    input.journalNamespaceSha256,
    input.failureDomainSha256,
    input.logicalDatabaseNamespaceSha256,
    input.targetId,
  ]);
}

/** Explicit non-production fake. Its Maps are not an independent failure domain or durable backup. */
export class MemoryTenantRestoreJournalAdapter implements TenantRestoreJournalAdapter {
  readonly adapterProtocol = MEMORY_TENANT_RESTORE_JOURNAL_PROTOCOL;
  readonly journalNamespaceSha256: string;
  readonly targetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly records = new Map<string, TenantRestoreJournalRecord>();
  private readonly heads: RestoreJournalStoredHead[] = [];
  private readonly afterRecordCreate: MemoryTenantRestoreJournalAdapterOptions["afterRecordCreate"];
  private closed = false;

  constructor(options: MemoryTenantRestoreJournalAdapterOptions) {
    if (options.nonProductionFixture !== true || process.env.NODE_ENV === "production") {
      throw new Error("memory restore journal adapter is a non-production fixture only");
    }
    this.journalNamespaceSha256 = memoryTenantRestoreJournalNamespaceSha256(options.namespaceId);
    this.failureDomainSha256 = memoryTenantRestoreJournalFailureDomainSha256(
      options.failureDomainId,
    );
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.targetSha256 = memoryTenantRestoreJournalTargetSha256({
      journalNamespaceSha256: this.journalNamespaceSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      targetId: options.targetId,
    });
    this.afterRecordCreate = options.afterRecordCreate;
    validateRestoreJournalAdapterIdentity(this.identity);
  }

  private get identity(): RestoreJournalAdapterIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      journalNamespaceSha256: this.journalNamespaceSha256,
      targetSha256: this.targetSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("memory restore journal adapter is closed");
  }

  private entries(maxSequence = this.heads.length): TenantRestoreJournalRemoteEntry[] {
    if (!Number.isSafeInteger(maxSequence) || maxSequence < 0 || maxSequence > this.heads.length) {
      throw new TenantRestoreJournalCorruptError("chain");
    }
    let expectedRoot = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    const operations = new Set<string>();
    return this.heads.slice(0, maxSequence).map((head, index) => {
      if (head.remoteSequence !== index + 1 || head.previousHeadRootSha256 !== expectedRoot) {
        throw new TenantRestoreJournalCorruptError("chain");
      }
      if (operations.has(head.operationSha256)) {
        throw new TenantRestoreJournalCorruptError("chain");
      }
      operations.add(head.operationSha256);
      const record = this.records.get(head.operationSha256);
      if (!record) throw new TenantRestoreJournalCorruptError("record");
      const entry = remoteEntry(this.identity, head, record);
      expectedRoot = entry.headRootSha256;
      return entry;
    });
  }

  async publishRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult> {
    this.assertOpen();
    assertRecordForAdapter(this.identity, record);
    const existingRecord = this.records.get(record.operationSha256);
    if (existingRecord && !sameRestoreJournalRecord(existingRecord, record)) {
      throw new TenantRestoreJournalConflictError();
    }
    if (!existingRecord) {
      // Snapshot the validated input; a caller mutating its object after this point cannot alter the
      // immutable fixture state.
      this.records.set(record.operationSha256, structuredClone(record));
      await this.afterRecordCreate?.(structuredClone(record));
      this.assertOpen();
    }

    const entries = this.entries();
    const existing = entries.find((entry) => entry.record.operationSha256 === record.operationSha256);
    if (existing) {
      if (!sameRestoreJournalRecord(existing.record, record)) {
        throw new TenantRestoreJournalConflictError();
      }
      return adapterResult(this.identity, existing, true);
    }

    const previous = entries.at(-1);
    const stored = buildRestoreJournalStoredHead({
      adapterProtocol: this.adapterProtocol,
      journalNamespaceSha256: this.journalNamespaceSha256,
      targetSha256: this.targetSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      remoteSequence: entries.length + 1,
      previousHeadRootSha256: previous?.headRootSha256
        ?? EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      operationSha256: record.operationSha256,
      recordSha256: record.recordSha256,
    });
    this.heads.push(stored);
    const entry = remoteEntry(this.identity, stored, this.records.get(record.operationSha256)!);
    return adapterResult(this.identity, entry, false);
  }

  async inspectRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult | null> {
    this.assertOpen();
    assertRecordForAdapter(this.identity, record);
    const storedRecord = this.records.get(record.operationSha256);
    if (!storedRecord) {
      // Still validate the entire chain so missing referenced records cannot masquerade as absence.
      this.entries();
      return null;
    }
    if (!sameRestoreJournalRecord(storedRecord, record)) {
      throw new TenantRestoreJournalConflictError();
    }
    const existing = this.entries().find(
      (entry) => entry.record.operationSha256 === record.operationSha256,
    );
    return existing ? adapterResult(this.identity, existing, true) : null;
  }

  async readHead(): Promise<TenantRestoreJournalRemoteHead> {
    this.assertOpen();
    const entries = this.entries();
    return entries.length === 0 ? emptyRemoteHead(this.identity) : headFromEntries(this.identity, entries);
  }

  async scanRecords(
    options: ScanTenantRestoreJournalRecordsOptions,
  ): Promise<ScanTenantRestoreJournalRecordsResult> {
    this.assertOpen();
    validateScanTenantRestoreJournalRecordsOptions(options);
    this.assertSealedHead(options.sealedHead);
    const entries = this.entries(options.sealedHead.remoteSequence);
    const sealedEntry = options.sealedHead.remoteSequence === 0
      ? undefined
      : entries[options.sealedHead.remoteSequence - 1];
    if (sealedEntry && sealedEntry.headRootSha256 !== options.sealedHead.headRootSha256) {
      throw new TenantRestoreJournalCorruptError("chain");
    }
    const cursorEntry = options.afterRemoteSequence === 0
      ? undefined
      : entries[options.afterRemoteSequence - 1];
    const cursorRoot = cursorEntry?.headRootSha256
      ?? EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    if (cursorRoot !== options.afterHeadRootSha256) {
      throw new TenantRestoreJournalConflictError();
    }
    const pageEntries = entries.slice(
      options.afterRemoteSequence,
      Math.min(options.sealedHead.remoteSequence, options.afterRemoteSequence + options.limit),
    ).map((entry) => structuredClone(entry));
    const final = pageEntries.at(-1);
    const result: ScanTenantRestoreJournalRecordsResult = {
      entries: pageEntries,
      nextRemoteSequence: final?.remoteSequence ?? options.afterRemoteSequence,
      nextHeadRootSha256: final?.headRootSha256 ?? options.afterHeadRootSha256,
      complete: (final?.remoteSequence ?? options.afterRemoteSequence)
        === options.sealedHead.remoteSequence,
    };
    validateScanTenantRestoreJournalRecordsResult(options, result);
    return result;
  }

  private assertSealedHead(head: TenantRestoreJournalRemoteHead): void {
    if (
      head.adapterProtocol !== this.adapterProtocol
      || head.journalNamespaceSha256 !== this.journalNamespaceSha256
      || head.targetSha256 !== this.targetSha256
      || head.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
    ) throw new TenantRestoreJournalConflictError();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
