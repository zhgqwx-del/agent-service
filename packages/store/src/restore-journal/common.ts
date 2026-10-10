import { createHash } from "node:crypto";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE,
  validateTenantRestoreJournalAdapterResult,
  validateTenantRestoreJournalRecord,
  validateTenantRestoreJournalRemoteEntry,
  validateTenantRestoreJournalRemoteHead,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalRemoteHead,
} from "../tenant-restore-journal.js";
import {
  canonicalTenantRestoreJournalRecord,
  type RestoreJournalStoredHead,
} from "./serialization.js";

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;

export interface RestoreJournalAdapterIdentity {
  adapterProtocol: string;
  journalNamespaceSha256: string;
  targetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
}

export class TenantRestoreJournalConflictError extends Error {
  constructor() {
    super("tenant restore journal immutable record conflict");
    this.name = "TenantRestoreJournalConflictError";
  }
}

export class TenantRestoreJournalCorruptError extends Error {
  constructor(component: "record" | "head" | "chain" | "listing") {
    super(`tenant restore journal ${component} is corrupt`);
    this.name = "TenantRestoreJournalCorruptError";
  }
}

export function sha256(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function validateRestoreJournalAdapterIdentity(identity: RestoreJournalAdapterIdentity): void {
  if (!IDENTIFIER.test(identity.adapterProtocol)) {
    throw new Error("tenant restore journal adapter protocol is invalid");
  }
  for (const [value, name] of [
    [identity.journalNamespaceSha256, "journal namespace"],
    [identity.targetSha256, "target"],
    [identity.failureDomainSha256, "failure domain"],
    [identity.logicalDatabaseNamespaceSha256, "logical database namespace"],
  ] as const) {
    if (!SHA256.test(value)) {
      throw new Error(`tenant restore journal adapter ${name} must be a lowercase SHA-256 digest`);
    }
  }
}

export function assertRecordForAdapter(
  identity: RestoreJournalAdapterIdentity,
  record: TenantRestoreJournalRecord,
): void {
  validateRestoreJournalAdapterIdentity(identity);
  validateTenantRestoreJournalRecord(record);
  if (record.logicalDatabaseNamespaceSha256 !== identity.logicalDatabaseNamespaceSha256) {
    throw new TenantRestoreJournalConflictError();
  }
}

export function sameRestoreJournalRecord(
  left: TenantRestoreJournalRecord,
  right: TenantRestoreJournalRecord,
): boolean {
  return canonicalTenantRestoreJournalRecord(left) === canonicalTenantRestoreJournalRecord(right);
}

export function emptyRemoteHead(
  identity: RestoreJournalAdapterIdentity,
): TenantRestoreJournalRemoteHead {
  const head: TenantRestoreJournalRemoteHead = {
    scope: TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    adapterProtocol: identity.adapterProtocol,
    journalNamespaceSha256: identity.journalNamespaceSha256,
    targetSha256: identity.targetSha256,
    logicalDatabaseNamespaceSha256: identity.logicalDatabaseNamespaceSha256,
    remoteSequence: 0,
    headRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  };
  validateTenantRestoreJournalRemoteHead(head);
  return head;
}

export function remoteEntry(
  identity: RestoreJournalAdapterIdentity,
  stored: RestoreJournalStoredHead,
  record: TenantRestoreJournalRecord,
): TenantRestoreJournalRemoteEntry {
  if (
    stored.adapterProtocol !== identity.adapterProtocol
    || stored.journalNamespaceSha256 !== identity.journalNamespaceSha256
    || stored.targetSha256 !== identity.targetSha256
    || stored.logicalDatabaseNamespaceSha256 !== identity.logicalDatabaseNamespaceSha256
    || record.logicalDatabaseNamespaceSha256 !== identity.logicalDatabaseNamespaceSha256
    || stored.operationSha256 !== record.operationSha256
    || stored.recordSha256 !== record.recordSha256
  ) {
    throw new TenantRestoreJournalCorruptError("chain");
  }
  const entry: TenantRestoreJournalRemoteEntry = {
    targetSha256: stored.targetSha256,
    remoteSequence: stored.remoteSequence,
    previousHeadRootSha256: stored.previousHeadRootSha256,
    headRootSha256: stored.headRootSha256,
    record,
  };
  validateTenantRestoreJournalRemoteEntry(entry);
  return entry;
}

export function adapterResult(
  identity: RestoreJournalAdapterIdentity,
  entry: TenantRestoreJournalRemoteEntry,
  replayed: boolean,
): TenantRestoreJournalAdapterResult {
  const result: TenantRestoreJournalAdapterResult = {
    adapterProtocol: identity.adapterProtocol,
    journalNamespaceSha256: identity.journalNamespaceSha256,
    logicalDatabaseNamespaceSha256: identity.logicalDatabaseNamespaceSha256,
    ...entry,
    replayed,
  };
  validateTenantRestoreJournalAdapterResult(result);
  return result;
}

export function headFromEntries(
  identity: RestoreJournalAdapterIdentity,
  entries: readonly TenantRestoreJournalRemoteEntry[],
): TenantRestoreJournalRemoteHead {
  if (entries.length === 0) return emptyRemoteHead(identity);
  const last = entries.at(-1)!;
  const head: TenantRestoreJournalRemoteHead = {
    scope: TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    adapterProtocol: identity.adapterProtocol,
    journalNamespaceSha256: identity.journalNamespaceSha256,
    targetSha256: identity.targetSha256,
    logicalDatabaseNamespaceSha256: identity.logicalDatabaseNamespaceSha256,
    remoteSequence: last.remoteSequence,
    headRootSha256: last.headRootSha256,
  };
  validateTenantRestoreJournalRemoteHead(head);
  return head;
}
