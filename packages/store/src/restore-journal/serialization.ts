import {
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  tenantRestoreJournalNextRemoteHeadRootSha256,
  validateTenantRestoreJournalRecord,
  type TenantRestoreJournalRecord,
} from "../tenant-restore-journal.js";

const HEAD_STORAGE_SCOPE = "tenant-restore-journal-storage-head-v1" as const;

export interface RestoreJournalStoredHead {
  scope: typeof HEAD_STORAGE_SCOPE;
  protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  targetSha256: string;
  logicalDatabaseNamespaceSha256: string;
  remoteSequence: number;
  previousHeadRootSha256: string;
  operationSha256: string;
  recordSha256: string;
  headRootSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;

function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

export function canonicalTenantRestoreJournalRecord(record: TenantRestoreJournalRecord): string {
  validateTenantRestoreJournalRecord(record);
  return JSON.stringify({
    scope: record.scope,
    protocol: record.protocol,
    logicalDatabaseNamespaceSha256: record.logicalDatabaseNamespaceSha256,
    requestId: record.requestId,
    tenantId: record.tenantId,
    subjectGeneration: record.subjectGeneration,
    t1FenceSha256: record.t1FenceSha256,
    operationSha256: record.operationSha256,
    recordSha256: record.recordSha256,
  });
}

export function parseCanonicalTenantRestoreJournalRecord(payload: string): TenantRestoreJournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("invalid restore journal record JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid restore journal record JSON");
  }
  const record = parsed as unknown as TenantRestoreJournalRecord;
  validateTenantRestoreJournalRecord(record);
  if (canonicalTenantRestoreJournalRecord(record) !== payload) {
    throw new Error("restore journal record JSON is not canonical");
  }
  return record;
}

export function buildRestoreJournalStoredHead(input: Omit<
  RestoreJournalStoredHead,
  "scope" | "protocol" | "headRootSha256"
>): RestoreJournalStoredHead {
  const headRootSha256 = tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256: input.previousHeadRootSha256,
    targetSha256: input.targetSha256,
    remoteSequence: input.remoteSequence,
    operationSha256: input.operationSha256,
    recordSha256: input.recordSha256,
  });
  const head: RestoreJournalStoredHead = {
    scope: HEAD_STORAGE_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    adapterProtocol: input.adapterProtocol,
    journalNamespaceSha256: input.journalNamespaceSha256,
    targetSha256: input.targetSha256,
    logicalDatabaseNamespaceSha256: input.logicalDatabaseNamespaceSha256,
    remoteSequence: input.remoteSequence,
    previousHeadRootSha256: input.previousHeadRootSha256,
    operationSha256: input.operationSha256,
    recordSha256: input.recordSha256,
    headRootSha256,
  };
  validateRestoreJournalStoredHead(head);
  return head;
}

export function validateRestoreJournalStoredHead(head: RestoreJournalStoredHead): void {
  exactKeys(head, [
    "scope",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "targetSha256",
    "logicalDatabaseNamespaceSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "operationSha256",
    "recordSha256",
    "headRootSha256",
  ], "tenant restore journal stored head");
  if (head.scope !== HEAD_STORAGE_SCOPE || head.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL) {
    throw new Error("tenant restore journal stored head protocol is invalid");
  }
  if (typeof head.adapterProtocol !== "string" || !IDENTIFIER.test(head.adapterProtocol)) {
    throw new Error("tenant restore journal stored head adapter protocol is invalid");
  }
  for (const [value, name] of [
    [head.journalNamespaceSha256, "journal namespace"],
    [head.targetSha256, "target"],
    [head.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [head.previousHeadRootSha256, "previous root"],
    [head.operationSha256, "operation"],
    [head.recordSha256, "record"],
    [head.headRootSha256, "head root"],
  ] as const) digest(value, `tenant restore journal stored head ${name}`);
  if (!Number.isSafeInteger(head.remoteSequence) || head.remoteSequence < 1) {
    throw new Error("tenant restore journal stored head sequence must be positive");
  }
  const expected = tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256: head.previousHeadRootSha256,
    targetSha256: head.targetSha256,
    remoteSequence: head.remoteSequence,
    operationSha256: head.operationSha256,
    recordSha256: head.recordSha256,
  });
  if (head.headRootSha256 !== expected) {
    throw new Error("tenant restore journal stored head root does not match");
  }
}

export function canonicalRestoreJournalStoredHead(head: RestoreJournalStoredHead): string {
  validateRestoreJournalStoredHead(head);
  return JSON.stringify({
    scope: head.scope,
    protocol: head.protocol,
    adapterProtocol: head.adapterProtocol,
    journalNamespaceSha256: head.journalNamespaceSha256,
    targetSha256: head.targetSha256,
    logicalDatabaseNamespaceSha256: head.logicalDatabaseNamespaceSha256,
    remoteSequence: head.remoteSequence,
    previousHeadRootSha256: head.previousHeadRootSha256,
    operationSha256: head.operationSha256,
    recordSha256: head.recordSha256,
    headRootSha256: head.headRootSha256,
  });
}

export function parseCanonicalRestoreJournalStoredHead(payload: string): RestoreJournalStoredHead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("invalid restore journal head JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid restore journal head JSON");
  }
  const head = parsed as unknown as RestoreJournalStoredHead;
  validateRestoreJournalStoredHead(head);
  if (canonicalRestoreJournalStoredHead(head) !== payload) {
    throw new Error("restore journal head JSON is not canonical");
  }
  return head;
}
