import { createHash } from "node:crypto";

export const TENANT_RESTORE_JOURNAL_PROTOCOL = "tenant-restore-journal-v1" as const;
export const TENANT_RESTORE_JOURNAL_RECORD_SCOPE = "tenant-restore-journal-record-v1" as const;
export const TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE =
  "tenant-restore-journal-remote-head-v1" as const;

const REQUEST_ID =
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function digest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
}

function identifier(value: string, name: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} is invalid`);
}

function timestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function tenantId(value: string): void {
  if (!value || value.length > 128) throw new Error("invalid tenant restore journal tenant id");
}

/** Derive the content-free database identity from a stable, non-secret operator namespace ID. */
export function tenantRestoreLogicalDatabaseNamespaceSha256(namespaceId: string): string {
  identifier(namespaceId, "tenant restore logical database namespace id");
  return sha256(["tenant-restore-logical-database-namespace-v1", namespaceId]);
}

/** Every restore activation uses a new stable, non-secret epoch ID; only its digest is durable. */
export function tenantRestoreRuntimeEpochSha256(epochId: string): string {
  identifier(epochId, "tenant restore runtime epoch id");
  return sha256(["tenant-restore-runtime-epoch-v1", epochId]);
}

export interface TenantRestoreJournalTargetDescriptor {
  targetOrdinal: number;
  targetSha256: string;
  failureDomainSha256: string;
  adapterProtocol: string;
  journalNamespaceSha256: string;
}

export function validateTenantRestoreJournalTargetDescriptor(
  target: TenantRestoreJournalTargetDescriptor,
): void {
  exactKeys(target, [
    "targetOrdinal",
    "targetSha256",
    "failureDomainSha256",
    "adapterProtocol",
    "journalNamespaceSha256",
  ], "tenant restore journal target descriptor");
  timestamp(target.targetOrdinal, "tenant restore journal target ordinal");
  digest(target.targetSha256, "tenant restore journal target");
  digest(target.failureDomainSha256, "tenant restore journal failure domain");
  identifier(target.adapterProtocol, "tenant restore journal adapter protocol");
  digest(target.journalNamespaceSha256, "tenant restore journal namespace");
}

export function tenantRestoreJournalTargetRootSha256(
  targets: readonly TenantRestoreJournalTargetDescriptor[],
): string {
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const targetIds = new Set<string>();
  for (const [ordinal, target] of ordered.entries()) {
    validateTenantRestoreJournalTargetDescriptor(target);
    if (target.targetOrdinal !== ordinal || targetIds.has(target.targetSha256)) {
      throw new Error("tenant restore journal target catalog is incomplete or duplicated");
    }
    targetIds.add(target.targetSha256);
    if (ordered[0] !== undefined
      && (target.adapterProtocol !== ordered[0]!.adapterProtocol
        || target.journalNamespaceSha256 !== ordered[0]!.journalNamespaceSha256)) {
      throw new Error("tenant restore journal targets do not share one adapter namespace");
    }
  }
  return sha256([
    "tenant-restore-journal-target-root-v1",
    ...ordered.flatMap((target) => [
      target.targetOrdinal,
      target.targetSha256,
      target.failureDomainSha256,
      target.adapterProtocol,
      target.journalNamespaceSha256,
    ]),
  ]);
}

export const EMPTY_TENANT_RESTORE_JOURNAL_TARGET_ROOT_SHA256 =
  tenantRestoreJournalTargetRootSha256([]);

export interface TenantRestoreJournalRecordIdentity {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
}

export interface TenantRestoreJournalRecordBody extends TenantRestoreJournalRecordIdentity {
  scope: typeof TENANT_RESTORE_JOURNAL_RECORD_SCOPE;
  protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
  logicalDatabaseNamespaceSha256: string;
  t1FenceSha256: string;
  operationSha256: string;
}

export interface TenantRestoreJournalRecord extends TenantRestoreJournalRecordBody {
  recordSha256: string;
}

const RECORD_BODY_KEYS = [
  "scope",
  "protocol",
  "logicalDatabaseNamespaceSha256",
  "requestId",
  "tenantId",
  "subjectGeneration",
  "t1FenceSha256",
  "operationSha256",
] as const;

export function tenantRestoreJournalOperationSha256(input: {
  logicalDatabaseNamespaceSha256: string;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1FenceSha256: string;
}): string {
  exactKeys(input, [
    "logicalDatabaseNamespaceSha256",
    "requestId",
    "tenantId",
    "subjectGeneration",
    "t1FenceSha256",
  ], "tenant restore journal operation");
  digest(input.logicalDatabaseNamespaceSha256, "tenant restore journal logical database namespace");
  if (!REQUEST_ID.test(input.requestId)) throw new Error("invalid tenant restore journal request id");
  tenantId(input.tenantId);
  positive(input.subjectGeneration, "tenant restore journal subject generation");
  digest(input.t1FenceSha256, "tenant restore journal T1 fence");
  return sha256([
    "tenant-restore-journal-operation-v1",
    input.logicalDatabaseNamespaceSha256,
    input.requestId,
    input.tenantId,
    input.subjectGeneration,
    input.t1FenceSha256,
  ]);
}

export function tenantRestoreJournalRecordSha256(record: TenantRestoreJournalRecordBody): string {
  exactKeys(record, RECORD_BODY_KEYS, "tenant restore journal record");
  if (record.scope !== TENANT_RESTORE_JOURNAL_RECORD_SCOPE
    || record.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL) {
    throw new Error("tenant restore journal record protocol is invalid");
  }
  const expectedOperation = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: record.logicalDatabaseNamespaceSha256,
    requestId: record.requestId,
    tenantId: record.tenantId,
    subjectGeneration: record.subjectGeneration,
    t1FenceSha256: record.t1FenceSha256,
  });
  digest(record.operationSha256, "tenant restore journal operation");
  if (record.operationSha256 !== expectedOperation) {
    throw new Error("tenant restore journal operation does not match its source");
  }
  return sha256([
    "tenant-restore-journal-record-v1",
    ...RECORD_BODY_KEYS.map((key) => record[key]),
  ]);
}

export function validateTenantRestoreJournalRecord(record: TenantRestoreJournalRecord): void {
  exactKeys(record, [...RECORD_BODY_KEYS, "recordSha256"], "tenant restore journal record");
  const { recordSha256, ...body } = record;
  const expected = tenantRestoreJournalRecordSha256(body);
  digest(recordSha256, "tenant restore journal record");
  if (recordSha256 !== expected) {
    throw new Error("tenant restore journal record digest does not match");
  }
}

export const EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256 = sha256([
  "tenant-restore-journal-remote-head-root-v1",
]);

export interface TenantRestoreJournalRemoteHead {
  scope: typeof TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE;
  protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  targetSha256: string;
  logicalDatabaseNamespaceSha256: string;
  remoteSequence: number;
  headRootSha256: string;
}

export function validateTenantRestoreJournalRemoteHead(
  head: TenantRestoreJournalRemoteHead,
): void {
  exactKeys(head, [
    "scope",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "targetSha256",
    "logicalDatabaseNamespaceSha256",
    "remoteSequence",
    "headRootSha256",
  ], "tenant restore journal remote head");
  if (head.scope !== TENANT_RESTORE_JOURNAL_REMOTE_HEAD_SCOPE
    || head.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL) {
    throw new Error("tenant restore journal remote head protocol is invalid");
  }
  identifier(head.adapterProtocol, "tenant restore journal remote head adapter protocol");
  for (const [value, name] of [
    [head.journalNamespaceSha256, "journal namespace"],
    [head.targetSha256, "target"],
    [head.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [head.headRootSha256, "root"],
  ] as const) digest(value, `tenant restore journal remote head ${name}`);
  timestamp(head.remoteSequence, "tenant restore journal remote sequence");
  if ((head.remoteSequence === 0)
    !== (head.headRootSha256 === EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256)) {
    throw new Error("tenant restore journal remote head sequence and root disagree");
  }
}

export interface TenantRestoreJournalRemoteEntry {
  targetSha256: string;
  remoteSequence: number;
  previousHeadRootSha256: string;
  headRootSha256: string;
  record: TenantRestoreJournalRecord;
}

export function tenantRestoreJournalNextRemoteHeadRootSha256(input: {
  previousHeadRootSha256: string;
  targetSha256: string;
  remoteSequence: number;
  operationSha256: string;
  recordSha256: string;
}): string {
  exactKeys(input, [
    "previousHeadRootSha256",
    "targetSha256",
    "remoteSequence",
    "operationSha256",
    "recordSha256",
  ], "tenant restore journal remote head link");
  for (const [value, name] of [
    [input.previousHeadRootSha256, "previous root"],
    [input.targetSha256, "target"],
    [input.operationSha256, "operation"],
    [input.recordSha256, "record"],
  ] as const) digest(value, `tenant restore journal remote head ${name}`);
  positive(input.remoteSequence, "tenant restore journal remote head sequence");
  return sha256([
    "tenant-restore-journal-remote-head-link-v1",
    input.previousHeadRootSha256,
    input.targetSha256,
    input.remoteSequence,
    input.operationSha256,
    input.recordSha256,
  ]);
}

export function validateTenantRestoreJournalRemoteEntry(
  entry: TenantRestoreJournalRemoteEntry,
): void {
  exactKeys(entry, [
    "targetSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "headRootSha256",
    "record",
  ], "tenant restore journal remote entry");
  validateTenantRestoreJournalRecord(entry.record);
  const expected = tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256: entry.previousHeadRootSha256,
    targetSha256: entry.targetSha256,
    remoteSequence: entry.remoteSequence,
    operationSha256: entry.record.operationSha256,
    recordSha256: entry.record.recordSha256,
  });
  digest(entry.headRootSha256, "tenant restore journal remote entry head root");
  if (entry.headRootSha256 !== expected) {
    throw new Error("tenant restore journal remote entry head root does not match");
  }
}

export interface TenantRestoreJournalAdapterResult extends TenantRestoreJournalRemoteEntry {
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  replayed: boolean;
}

export function validateTenantRestoreJournalAdapterResult(
  result: TenantRestoreJournalAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "headRootSha256",
    "record",
    "replayed",
  ], "tenant restore journal adapter result");
  validateTenantRestoreJournalRemoteEntry({
    targetSha256: result.targetSha256,
    remoteSequence: result.remoteSequence,
    previousHeadRootSha256: result.previousHeadRootSha256,
    headRootSha256: result.headRootSha256,
    record: result.record,
  });
  identifier(result.adapterProtocol, "tenant restore journal adapter result protocol");
  digest(result.journalNamespaceSha256, "tenant restore journal adapter result namespace");
  digest(
    result.logicalDatabaseNamespaceSha256,
    "tenant restore journal adapter result logical database namespace",
  );
  if (result.logicalDatabaseNamespaceSha256 !== result.record.logicalDatabaseNamespaceSha256) {
    throw new Error("tenant restore journal adapter result database namespace does not match");
  }
  if (typeof result.replayed !== "boolean") {
    throw new Error("tenant restore journal adapter replay flag is invalid");
  }
}

export interface ScanTenantRestoreJournalRecordsOptions {
  sealedHead: TenantRestoreJournalRemoteHead;
  afterRemoteSequence: number;
  afterHeadRootSha256: string;
  limit: number;
}

export interface ScanTenantRestoreJournalRecordsResult {
  entries: TenantRestoreJournalRemoteEntry[];
  nextRemoteSequence: number;
  nextHeadRootSha256: string;
  complete: boolean;
}

export function validateScanTenantRestoreJournalRecordsOptions(
  options: ScanTenantRestoreJournalRecordsOptions,
): void {
  exactKeys(options, [
    "sealedHead",
    "afterRemoteSequence",
    "afterHeadRootSha256",
    "limit",
  ], "scan tenant restore journal records options");
  validateTenantRestoreJournalRemoteHead(options.sealedHead);
  timestamp(options.afterRemoteSequence, "tenant restore journal scan cursor sequence");
  digest(options.afterHeadRootSha256, "tenant restore journal scan cursor root");
  positive(options.limit, "tenant restore journal scan limit");
  if (options.limit > 1_000 || options.afterRemoteSequence > options.sealedHead.remoteSequence) {
    throw new Error("tenant restore journal scan range is invalid");
  }
  if (options.afterRemoteSequence === 0
    && options.afterHeadRootSha256 !== EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256) {
    throw new Error("tenant restore journal initial scan cursor has a non-empty root");
  }
  if (options.afterRemoteSequence === options.sealedHead.remoteSequence
    && options.afterHeadRootSha256 !== options.sealedHead.headRootSha256) {
    throw new Error("tenant restore journal terminal scan cursor does not match sealed head");
  }
}

export function validateScanTenantRestoreJournalRecordsResult(
  options: ScanTenantRestoreJournalRecordsOptions,
  result: ScanTenantRestoreJournalRecordsResult,
): void {
  validateScanTenantRestoreJournalRecordsOptions(options);
  exactKeys(result, [
    "entries",
    "nextRemoteSequence",
    "nextHeadRootSha256",
    "complete",
  ], "scan tenant restore journal records result");
  let sequence = options.afterRemoteSequence;
  let root = options.afterHeadRootSha256;
  for (const entry of result.entries) {
    validateTenantRestoreJournalRemoteEntry(entry);
    if (entry.targetSha256 !== options.sealedHead.targetSha256
      || entry.remoteSequence !== sequence + 1
      || entry.previousHeadRootSha256 !== root
      || entry.record.logicalDatabaseNamespaceSha256
        !== options.sealedHead.logicalDatabaseNamespaceSha256) {
      throw new Error("tenant restore journal scan page is not one contiguous sealed chain");
    }
    sequence = entry.remoteSequence;
    root = entry.headRootSha256;
  }
  timestamp(result.nextRemoteSequence, "tenant restore journal next scan sequence");
  digest(result.nextHeadRootSha256, "tenant restore journal next scan root");
  if (result.entries.length > options.limit
    || result.nextRemoteSequence !== sequence
    || result.nextHeadRootSha256 !== root
    || result.nextRemoteSequence > options.sealedHead.remoteSequence
    || result.complete !== (result.nextRemoteSequence === options.sealedHead.remoteSequence)
    || (result.complete && result.nextHeadRootSha256 !== options.sealedHead.headRootSha256)) {
    throw new Error("tenant restore journal scan result does not match its sealed head");
  }
}

/** External append-only journal. Implementations must not expose credentials or physical locators. */
export interface TenantRestoreJournalAdapter {
  readonly adapterProtocol: string;
  readonly journalNamespaceSha256: string;
  readonly targetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;
  publishRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult>;
  /** Exact response-loss inspection; an unchained/orphan record must return null. */
  inspectRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult | null>;
  readHead(): Promise<TenantRestoreJournalRemoteHead>;
  /** Scan one immutable prefix bounded by sealedHead; concurrent appends cannot enter the prefix. */
  scanRecords(
    options: ScanTenantRestoreJournalRecordsOptions,
  ): Promise<ScanTenantRestoreJournalRecordsResult>;
  close(): Promise<void>;
}

export const TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID = 1 as const;
export const TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_SCOPE =
  "tenant-restore-journal-publication-target-v1" as const;
export const TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_SCOPE =
  "tenant-restore-journal-publication-target-ack-v1" as const;
export const TENANT_RESTORE_JOURNAL_PUBLICATION_RECEIPT_SCOPE =
  "tenant-restore-journal-publication-v1" as const;
export const TENANT_RESTORE_FENCE_SCOPE = "tenant-restore-fence-v1" as const;
export const TENANT_RESTORE_REPLAY_ENTRY_SCOPE = "tenant-restore-replay-entry-v1" as const;
export const TENANT_RESTORE_REPLAY_RECEIPT_SCOPE = "tenant-restore-replay-v1" as const;
export const TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID = 1 as const;

const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const RESTORE_RUN_ID =
  /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function claimToken(value: string): void {
  if (!CLAIM_TOKEN.test(value)) throw new Error("invalid tenant restore journal claim token");
}

function restoreRunId(value: string): void {
  if (!RESTORE_RUN_ID.test(value)) throw new Error("invalid tenant restore replay run id");
}

export interface ActivateTenantRestoreJournalControlInput {
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  runtimeEpochSha256: string;
  targets: TenantRestoreJournalTargetDescriptor[];
  observedHeads: TenantRestoreReplaySealedTarget[];
}

export type TenantRestoreJournalControlRecord =
  | {
      singletonId: typeof TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID;
      controlGeneration: 0;
    }
  | {
      singletonId: typeof TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID;
      controlGeneration: 1;
      activatedAtDbMs: number;
      protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
      adapterProtocol: string;
      journalNamespaceSha256: string;
      logicalDatabaseNamespaceSha256: string;
      targetCount: number;
      targetRootSha256: string;
      evidenceSha256: string;
    };

type ActiveJournalControl = Extract<TenantRestoreJournalControlRecord, { controlGeneration: 1 }>;

export function tenantRestoreJournalControlEvidenceSha256(
  control: Omit<ActiveJournalControl, "evidenceSha256">,
): string {
  exactKeys(control, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
  ], "tenant restore journal control evidence");
  if (control.singletonId !== TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID
    || control.controlGeneration !== 1
    || control.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL) {
    throw new Error("tenant restore journal control identity is invalid");
  }
  timestamp(control.activatedAtDbMs, "tenant restore journal control activation time");
  identifier(control.adapterProtocol, "tenant restore journal control adapter protocol");
  digest(control.journalNamespaceSha256, "tenant restore journal control namespace");
  digest(
    control.logicalDatabaseNamespaceSha256,
    "tenant restore journal control logical database namespace",
  );
  positive(control.targetCount, "tenant restore journal control target count");
  digest(control.targetRootSha256, "tenant restore journal control target root");
  return sha256([
    "tenant-restore-journal-control-v1",
    control.singletonId,
    control.controlGeneration,
    control.activatedAtDbMs,
    control.protocol,
    control.adapterProtocol,
    control.journalNamespaceSha256,
    control.logicalDatabaseNamespaceSha256,
    control.targetCount,
    control.targetRootSha256,
  ]);
}

export function validateActivateTenantRestoreJournalControlInput(
  input: ActivateTenantRestoreJournalControlInput,
): void {
  exactKeys(input, [
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "runtimeEpochSha256",
    "targets",
    "observedHeads",
  ], "activate tenant restore journal control input");
  identifier(input.adapterProtocol, "tenant restore journal adapter protocol");
  digest(input.journalNamespaceSha256, "tenant restore journal namespace");
  digest(input.logicalDatabaseNamespaceSha256, "tenant restore journal database namespace");
  digest(input.runtimeEpochSha256, "tenant restore journal runtime epoch");
  if (input.targets.length === 0 || input.targets.length > 32) {
    throw new Error("tenant restore journal requires between one and 32 targets");
  }
  tenantRestoreJournalTargetRootSha256(input.targets);
  for (const target of input.targets) {
    if (target.adapterProtocol !== input.adapterProtocol
      || target.journalNamespaceSha256 !== input.journalNamespaceSha256) {
      throw new Error("tenant restore journal target does not match control namespace");
    }
  }
  if (input.observedHeads.length !== input.targets.length) {
    throw new Error("tenant restore journal primary activation head catalog is incomplete");
  }
  tenantRestoreReplaySealedTargetRootSha256(input.observedHeads);
  for (const [ordinal, head] of input.observedHeads.entries()) {
    const target = input.targets[ordinal];
    if (!target
      || head.targetOrdinal !== ordinal
      || head.targetSha256 !== target.targetSha256
      || head.failureDomainSha256 !== target.failureDomainSha256
      || head.adapterProtocol !== target.adapterProtocol
      || head.journalNamespaceSha256 !== target.journalNamespaceSha256
      || head.logicalDatabaseNamespaceSha256 !== input.logicalDatabaseNamespaceSha256
      || head.sealedRemoteSequence !== 0
      || head.sealedHeadRootSha256 !== EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256) {
      throw new Error("tenant restore journal primary activation requires exact empty remote heads");
    }
  }
}

export function validateTenantRestoreJournalControlRecord(
  control: TenantRestoreJournalControlRecord,
): void {
  if (control.controlGeneration === 0) {
    exactKeys(control, ["singletonId", "controlGeneration"],
      "inactive tenant restore journal control");
    if (control.singletonId !== TENANT_RESTORE_JOURNAL_CONTROL_SINGLETON_ID) {
      throw new Error("tenant restore journal control singleton is invalid");
    }
    return;
  }
  exactKeys(control, [
    "singletonId",
    "controlGeneration",
    "activatedAtDbMs",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "evidenceSha256",
  ], "active tenant restore journal control");
  const { evidenceSha256, ...body } = control;
  const expected = tenantRestoreJournalControlEvidenceSha256(body);
  digest(evidenceSha256, "tenant restore journal control evidence");
  if (evidenceSha256 !== expected) {
    throw new Error("tenant restore journal control evidence does not match");
  }
}

export interface TenantRestoreJournalPublicationIdentity
  extends TenantRestoreJournalRecordIdentity {
  publicationGeneration: number;
}

export interface TenantRestoreJournalPublicationSource
  extends TenantRestoreJournalPublicationIdentity {
  t1FenceSha256: string;
  controlEvidenceSha256: string;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  targetCount: number;
  targetRootSha256: string;
  sourceEvidenceDbMs: number;
}

const PUBLICATION_IDENTITY_KEYS = [
  "requestId",
  "tenantId",
  "subjectGeneration",
  "publicationGeneration",
] as const;

const PUBLICATION_SOURCE_KEYS = [
  ...PUBLICATION_IDENTITY_KEYS,
  "t1FenceSha256",
  "controlEvidenceSha256",
  "adapterProtocol",
  "journalNamespaceSha256",
  "logicalDatabaseNamespaceSha256",
  "targetCount",
  "targetRootSha256",
  "sourceEvidenceDbMs",
] as const;

export function validateTenantRestoreJournalPublicationIdentity(
  identity: TenantRestoreJournalPublicationIdentity,
): void {
  if (!REQUEST_ID.test(identity.requestId)) throw new Error("invalid restore publication request id");
  tenantId(identity.tenantId);
  positive(identity.subjectGeneration, "restore publication subject generation");
  positive(identity.publicationGeneration, "restore publication generation");
}

export function validateTenantRestoreJournalPublicationSource(
  source: TenantRestoreJournalPublicationSource,
): void {
  validateTenantRestoreJournalPublicationIdentity(source);
  for (const [value, name] of [
    [source.t1FenceSha256, "T1 fence"],
    [source.controlEvidenceSha256, "control evidence"],
    [source.journalNamespaceSha256, "journal namespace"],
    [source.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [source.targetRootSha256, "target root"],
  ] as const) digest(value, `tenant restore publication ${name}`);
  identifier(source.adapterProtocol, "tenant restore publication adapter protocol");
  positive(source.targetCount, "tenant restore publication target count");
  timestamp(source.sourceEvidenceDbMs, "tenant restore publication source time");
}

function samePublicationIdentity(
  left: TenantRestoreJournalPublicationIdentity,
  right: TenantRestoreJournalPublicationIdentity,
): boolean {
  return PUBLICATION_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

export interface TenantRestoreJournalPublicationTarget
  extends TenantRestoreJournalPublicationIdentity {
  scope: typeof TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_SCOPE;
  targetOrdinal: number;
  targetSha256: string;
  failureDomainSha256: string;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  t1FenceSha256: string;
  operationSha256: string;
  recordSha256: string;
  capturedAtDbMs: number;
  receiptSha256: string;
}

type PublicationTargetBody = Omit<TenantRestoreJournalPublicationTarget, "receiptSha256">;

export function tenantRestoreJournalPublicationTargetSha256(
  target: PublicationTargetBody,
): string {
  validateTenantRestoreJournalPublicationIdentity(target);
  if (target.scope !== TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_SCOPE) {
    throw new Error("tenant restore publication target scope is invalid");
  }
  const descriptor: TenantRestoreJournalTargetDescriptor = {
    targetOrdinal: target.targetOrdinal,
    targetSha256: target.targetSha256,
    failureDomainSha256: target.failureDomainSha256,
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
  };
  validateTenantRestoreJournalTargetDescriptor(descriptor);
  const recordBody: TenantRestoreJournalRecordBody = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: target.logicalDatabaseNamespaceSha256,
    requestId: target.requestId,
    tenantId: target.tenantId,
    subjectGeneration: target.subjectGeneration,
    t1FenceSha256: target.t1FenceSha256,
    operationSha256: target.operationSha256,
  };
  const expectedRecord = tenantRestoreJournalRecordSha256(recordBody);
  digest(target.recordSha256, "tenant restore publication target record");
  if (target.recordSha256 !== expectedRecord) {
    throw new Error("tenant restore publication target record does not match");
  }
  timestamp(target.capturedAtDbMs, "tenant restore publication target capture time");
  return sha256([
    "tenant-restore-journal-publication-target-v1",
    target.scope,
    ...PUBLICATION_IDENTITY_KEYS.map((key) => target[key]),
    target.targetOrdinal,
    target.targetSha256,
    target.failureDomainSha256,
    target.adapterProtocol,
    target.journalNamespaceSha256,
    target.logicalDatabaseNamespaceSha256,
    target.t1FenceSha256,
    target.operationSha256,
    target.recordSha256,
    target.capturedAtDbMs,
  ]);
}

export function validateTenantRestoreJournalPublicationTarget(
  target: TenantRestoreJournalPublicationTarget,
): void {
  exactKeys(target, [
    ...PUBLICATION_IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "targetSha256",
    "failureDomainSha256",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "t1FenceSha256",
    "operationSha256",
    "recordSha256",
    "capturedAtDbMs",
    "receiptSha256",
  ], "tenant restore publication target");
  const { receiptSha256, ...body } = target;
  const expected = tenantRestoreJournalPublicationTargetSha256(body);
  digest(receiptSha256, "tenant restore publication target receipt");
  if (receiptSha256 !== expected) {
    throw new Error("tenant restore publication target receipt does not match");
  }
}

export function tenantRestoreJournalPublicationTargetRootSha256(
  targets: readonly TenantRestoreJournalPublicationTarget[],
): string {
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  for (const [ordinal, target] of ordered.entries()) {
    validateTenantRestoreJournalPublicationTarget(target);
    if (target.targetOrdinal !== ordinal
      || (ordered[0] !== undefined && (!samePublicationIdentity(target, ordered[0]!)
        || target.capturedAtDbMs !== ordered[0]!.capturedAtDbMs))) {
      throw new Error("tenant restore publication targets lack one atomic ordered source");
    }
  }
  return sha256([
    "tenant-restore-journal-publication-target-root-v1",
    ...ordered.map((target) => target.receiptSha256),
  ]);
}

export const EMPTY_TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_ROOT_SHA256 = sha256([
  "tenant-restore-journal-publication-target-ack-root-v1",
]);
export const EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_COMMIT_ROOT_SHA256 = sha256([
  "tenant-restore-journal-remote-commit-root-v1",
]);

export interface TenantRestoreJournalPublicationTargetAck
  extends TenantRestoreJournalPublicationIdentity {
  scope: typeof TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_SCOPE;
  targetOrdinal: number;
  targetSha256: string;
  failureDomainSha256: string;
  targetReceiptSha256: string;
  operationSha256: string;
  recordSha256: string;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  remoteSequence: number;
  previousHeadRootSha256: string;
  headRootSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  receiptSha256: string;
}

type PublicationTargetAckBody = Omit<TenantRestoreJournalPublicationTargetAck, "receiptSha256">;

export function tenantRestoreJournalPublicationTargetAckSha256(
  ack: PublicationTargetAckBody,
): string {
  validateTenantRestoreJournalPublicationIdentity(ack);
  if (ack.scope !== TENANT_RESTORE_JOURNAL_PUBLICATION_TARGET_ACK_SCOPE) {
    throw new Error("tenant restore publication target ACK scope is invalid");
  }
  timestamp(ack.targetOrdinal, "tenant restore publication target ACK ordinal");
  for (const [value, name] of [
    [ack.targetSha256, "target"],
    [ack.failureDomainSha256, "failure domain"],
    [ack.targetReceiptSha256, "target receipt"],
    [ack.operationSha256, "operation"],
    [ack.recordSha256, "record"],
    [ack.journalNamespaceSha256, "journal namespace"],
    [ack.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [ack.previousHeadRootSha256, "previous head root"],
    [ack.headRootSha256, "head root"],
    [ack.completedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant restore publication target ACK ${name}`);
  identifier(ack.adapterProtocol, "tenant restore publication target ACK adapter protocol");
  positive(ack.remoteSequence, "tenant restore publication target ACK remote sequence");
  positive(ack.completedClaimAttempt, "tenant restore publication target ACK claim attempt");
  timestamp(ack.storeDbTimestampMs, "tenant restore publication target ACK time");
  if (ack.headRootSha256 !== tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256: ack.previousHeadRootSha256,
    targetSha256: ack.targetSha256,
    remoteSequence: ack.remoteSequence,
    operationSha256: ack.operationSha256,
    recordSha256: ack.recordSha256,
  })) throw new Error("tenant restore publication target ACK remote head does not match");
  return sha256([
    "tenant-restore-journal-publication-target-ack-v1",
    ack.scope,
    ...PUBLICATION_IDENTITY_KEYS.map((key) => ack[key]),
    ack.targetOrdinal,
    ack.targetSha256,
    ack.failureDomainSha256,
    ack.targetReceiptSha256,
    ack.operationSha256,
    ack.recordSha256,
    ack.adapterProtocol,
    ack.journalNamespaceSha256,
    ack.logicalDatabaseNamespaceSha256,
    ack.remoteSequence,
    ack.previousHeadRootSha256,
    ack.headRootSha256,
    ack.completedClaimAttempt,
    ack.completedClaimTokenSha256,
    ack.storeDbTimestampMs,
  ]);
}

export function validateTenantRestoreJournalPublicationTargetAck(
  ack: TenantRestoreJournalPublicationTargetAck,
): void {
  exactKeys(ack, [
    ...PUBLICATION_IDENTITY_KEYS,
    "scope",
    "targetOrdinal",
    "targetSha256",
    "failureDomainSha256",
    "targetReceiptSha256",
    "operationSha256",
    "recordSha256",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "headRootSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "receiptSha256",
  ], "tenant restore publication target ACK");
  const { receiptSha256, ...body } = ack;
  const expected = tenantRestoreJournalPublicationTargetAckSha256(body);
  digest(receiptSha256, "tenant restore publication target ACK receipt");
  if (receiptSha256 !== expected) {
    throw new Error("tenant restore publication target ACK receipt does not match");
  }
}

export function tenantRestoreJournalPublicationTargetAckRootSha256(
  acks: readonly TenantRestoreJournalPublicationTargetAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const ordinals = new Set<number>();
  const targetIds = new Set<string>();
  for (const ack of ordered) {
    validateTenantRestoreJournalPublicationTargetAck(ack);
    if (ordinals.has(ack.targetOrdinal) || targetIds.has(ack.targetSha256)
      || (ordered[0] !== undefined && !samePublicationIdentity(ack, ordered[0]!))) {
      throw new Error("tenant restore publication target ACK is duplicated or mismatched");
    }
    ordinals.add(ack.targetOrdinal);
    targetIds.add(ack.targetSha256);
  }
  return sha256([
    "tenant-restore-journal-publication-target-ack-root-v1",
    ...ordered.map((ack) => ack.receiptSha256),
  ]);
}

export function tenantRestoreJournalRemoteCommitRootSha256(
  acks: readonly TenantRestoreJournalPublicationTargetAck[],
): string {
  const ordered = [...acks].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  for (const ack of ordered) validateTenantRestoreJournalPublicationTargetAck(ack);
  return sha256([
    "tenant-restore-journal-remote-commit-root-v1",
    ...ordered.flatMap((ack) => [
      ack.targetOrdinal,
      ack.targetSha256,
      ack.failureDomainSha256,
      ack.remoteSequence,
      ack.headRootSha256,
      ack.recordSha256,
    ]),
  ]);
}

export interface TenantRestoreJournalPublicationReceipt
  extends TenantRestoreJournalPublicationSource {
  scope: typeof TENANT_RESTORE_JOURNAL_PUBLICATION_RECEIPT_SCOPE;
  targetAckCount: number;
  targetAckRootSha256: string;
  remoteCommitCount: number;
  remoteCommitRootSha256: string;
  completedClaimAttempt: number;
  completedClaimTokenSha256: string;
  storeDbTimestampMs: number;
  restoreFencePublicationComplete: true;
  restoreFenceReplayComplete: false;
  physicalReplayComplete: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

type PublicationReceiptBody = Omit<TenantRestoreJournalPublicationReceipt, "receiptSha256">;

export function tenantRestoreJournalPublicationReceiptSha256(
  receipt: PublicationReceiptBody,
): string {
  validateTenantRestoreJournalPublicationSource(receipt);
  if (receipt.scope !== TENANT_RESTORE_JOURNAL_PUBLICATION_RECEIPT_SCOPE
    || receipt.targetAckCount !== receipt.targetCount
    || receipt.remoteCommitCount !== receipt.targetCount
    || receipt.restoreFencePublicationComplete !== true
    || receipt.restoreFenceReplayComplete !== false
    || receipt.physicalReplayComplete !== false
    || receipt.allDomainsComplete !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant restore publication receipt completion is invalid");
  }
  for (const [value, name] of [
    [receipt.targetAckRootSha256, "target ACK root"],
    [receipt.remoteCommitRootSha256, "remote commit root"],
    [receipt.completedClaimTokenSha256, "claim token"],
  ] as const) digest(value, `tenant restore publication receipt ${name}`);
  positive(receipt.completedClaimAttempt, "tenant restore publication receipt claim attempt");
  timestamp(receipt.storeDbTimestampMs, "tenant restore publication receipt time");
  if (receipt.storeDbTimestampMs < receipt.sourceEvidenceDbMs) {
    throw new Error("tenant restore publication receipt predates its source");
  }
  return sha256([
    "tenant-restore-journal-publication-receipt-v1",
    ...PUBLICATION_SOURCE_KEYS.map((key) => receipt[key]),
    receipt.scope,
    receipt.targetAckCount,
    receipt.targetAckRootSha256,
    receipt.remoteCommitCount,
    receipt.remoteCommitRootSha256,
    receipt.completedClaimAttempt,
    receipt.completedClaimTokenSha256,
    receipt.storeDbTimestampMs,
    receipt.restoreFencePublicationComplete,
    receipt.restoreFenceReplayComplete,
    receipt.physicalReplayComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantRestoreJournalPublicationReceipt(
  receipt: TenantRestoreJournalPublicationReceipt,
): void {
  exactKeys(receipt, [
    ...PUBLICATION_SOURCE_KEYS,
    "scope",
    "targetAckCount",
    "targetAckRootSha256",
    "remoteCommitCount",
    "remoteCommitRootSha256",
    "completedClaimAttempt",
    "completedClaimTokenSha256",
    "storeDbTimestampMs",
    "restoreFencePublicationComplete",
    "restoreFenceReplayComplete",
    "physicalReplayComplete",
    "allDomainsComplete",
    "contentPurgeExecuted",
    "receiptSha256",
  ], "tenant restore publication receipt");
  const { receiptSha256, ...body } = receipt;
  const expected = tenantRestoreJournalPublicationReceiptSha256(body);
  digest(receiptSha256, "tenant restore publication receipt");
  if (receiptSha256 !== expected) {
    throw new Error("tenant restore publication receipt does not match");
  }
}

export type TenantRestoreJournalPublicationJobPhase = "queued" | "published" | "blocked";
export type TenantRestoreJournalPublicationRetryErrorCode =
  | "temporary_failure"
  | "dependency_pending";
export type TenantRestoreJournalPublicationBlockReasonCode =
  | "source_conflict"
  | "remote_conflict";

/**
 * The external append is ahead of the durable runtime head, so an earlier publication ACK must
 * cross that atomic boundary first. This grants no authority and may retry indefinitely; once the
 * gap closes, the normal exact-next sequence and previous-root checks still apply.
 */
export class TenantRestoreJournalPublicationDependencyPendingError extends Error {
  constructor() {
    super("tenant restore journal publication dependency is pending");
    this.name = "TenantRestoreJournalPublicationDependencyPendingError";
  }
}

interface TenantRestoreJournalPublicationJobBase
  extends TenantRestoreJournalPublicationSource {
  phase: TenantRestoreJournalPublicationJobPhase;
  targetAckCount: number;
  targetAckRootSha256: string;
  remoteCommitCount: number;
  remoteCommitRootSha256: string;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export type TenantRestoreJournalPublicationJobRecord =
  TenantRestoreJournalPublicationJobBase & (
    | {
        phase: "queued";
        availableAtMs: number;
        claimToken?: string;
        leaseUntilMs?: number;
        lastErrorCode?: TenantRestoreJournalPublicationRetryErrorCode;
        terminalReceiptSha256?: never;
        completedClaimAttempt?: never;
        completedClaimTokenSha256?: never;
        sealedAtDbMs?: never;
        blockedAtDbMs?: never;
        blockedReasonCode?: never;
      }
    | {
        phase: "published";
        availableAtMs?: never;
        claimToken?: never;
        leaseUntilMs?: never;
        lastErrorCode?: never;
        terminalReceiptSha256: string;
        completedClaimAttempt: number;
        completedClaimTokenSha256: string;
        sealedAtDbMs: number;
        blockedAtDbMs?: never;
        blockedReasonCode?: never;
      }
    | {
        phase: "blocked";
        availableAtMs?: never;
        claimToken?: never;
        leaseUntilMs?: never;
        lastErrorCode?: never;
        terminalReceiptSha256?: never;
        completedClaimAttempt?: never;
        completedClaimTokenSha256?: never;
        sealedAtDbMs?: never;
        blockedAtDbMs: number;
        blockedReasonCode: TenantRestoreJournalPublicationBlockReasonCode;
      }
  );

export interface TenantRestoreJournalPublicationClaim
  extends TenantRestoreJournalPublicationSource {
  phase: "queued";
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
}

export type TenantRestoreJournalPublicationAuthorization = Pick<
  TenantRestoreJournalPublicationClaim,
  | "requestId"
  | "tenantId"
  | "subjectGeneration"
  | "publicationGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export function tenantRestoreJournalClaimTokenSha256(value: string): string {
  claimToken(value);
  return sha256(["tenant-restore-journal-claim-token-v1", value]);
}

export function validateTenantRestoreJournalPublicationAuthorization(
  authorization: TenantRestoreJournalPublicationAuthorization,
): void {
  exactKeys(authorization, [...PUBLICATION_IDENTITY_KEYS, "claimAttempt", "claimToken"],
    "tenant restore publication authorization");
  validateTenantRestoreJournalPublicationIdentity(authorization);
  positive(authorization.claimAttempt, "tenant restore publication claim attempt");
  claimToken(authorization.claimToken);
}

export function validateTenantRestoreJournalPublicationClaim(
  claim: TenantRestoreJournalPublicationClaim,
): void {
  exactKeys(claim, [
    ...PUBLICATION_SOURCE_KEYS,
    "phase",
    "claimAttempt",
    "claimToken",
    "leaseUntilMs",
  ], "tenant restore publication claim");
  validateTenantRestoreJournalPublicationSource(claim);
  if (claim.phase !== "queued") throw new Error("tenant restore publication claim phase is invalid");
  positive(claim.claimAttempt, "tenant restore publication claim attempt");
  claimToken(claim.claimToken);
  timestamp(claim.leaseUntilMs, "tenant restore publication claim lease");
}

export function validateTenantRestoreJournalPublicationJobRecord(
  job: TenantRestoreJournalPublicationJobRecord,
): void {
  validateTenantRestoreJournalPublicationSource(job);
  timestamp(job.targetAckCount, "tenant restore publication job target ACK count");
  timestamp(job.remoteCommitCount, "tenant restore publication job remote commit count");
  for (const [value, name] of [
    [job.targetAckRootSha256, "target ACK root"],
    [job.remoteCommitRootSha256, "remote commit root"],
  ] as const) digest(value, `tenant restore publication job ${name}`);
  timestamp(job.attempts, "tenant restore publication job attempts");
  timestamp(job.createdAtMs, "tenant restore publication job creation time");
  timestamp(job.updatedAtMs, "tenant restore publication job update time");
  if (job.updatedAtMs < job.createdAtMs || job.targetAckCount > job.targetCount
    || job.remoteCommitCount !== job.targetAckCount) {
    throw new Error("tenant restore publication job counters are invalid");
  }
  const baseKeys = [
    ...PUBLICATION_SOURCE_KEYS,
    "phase",
    "targetAckCount",
    "targetAckRootSha256",
    "remoteCommitCount",
    "remoteCommitRootSha256",
    "attempts",
    "createdAtMs",
    "updatedAtMs",
  ] as const;
  if (job.phase === "queued") {
    exactKeys(job, [
      ...baseKeys,
      "availableAtMs",
      ...(job.claimToken === undefined ? [] : ["claimToken"]),
      ...(job.leaseUntilMs === undefined ? [] : ["leaseUntilMs"]),
      ...(job.lastErrorCode === undefined ? [] : ["lastErrorCode"]),
    ], "queued tenant restore publication job");
    timestamp(job.availableAtMs, "tenant restore publication job availability");
    if ((job.claimToken === undefined) !== (job.leaseUntilMs === undefined)) {
      throw new Error("tenant restore publication job claim is incomplete");
    }
    if (job.claimToken === undefined) {
      if (job.availableAtMs < job.updatedAtMs) {
        throw new Error("tenant restore publication availability predates update");
      }
    } else {
      claimToken(job.claimToken);
      timestamp(job.leaseUntilMs!, "tenant restore publication job lease");
      if (job.attempts < 1 || job.leaseUntilMs! < job.updatedAtMs) {
        throw new Error("tenant restore publication active claim is invalid");
      }
    }
    if (job.lastErrorCode !== undefined
      && !(job.lastErrorCode === "temporary_failure"
        || job.lastErrorCode === "dependency_pending")) {
      throw new Error("tenant restore publication retry code is invalid");
    }
    return;
  }
  if (job.phase === "published") {
    exactKeys(job, [
      ...baseKeys,
      "terminalReceiptSha256",
      "completedClaimAttempt",
      "completedClaimTokenSha256",
      "sealedAtDbMs",
    ], "published tenant restore publication job");
    for (const [value, name] of [
      [job.terminalReceiptSha256, "terminal receipt"],
      [job.completedClaimTokenSha256, "completion claim token"],
    ] as const) digest(value, `tenant restore publication job ${name}`);
    positive(job.completedClaimAttempt, "tenant restore publication completion attempt");
    timestamp(job.sealedAtDbMs, "tenant restore publication seal time");
    if (job.targetAckCount !== job.targetCount || job.remoteCommitCount !== job.targetCount
      || job.completedClaimAttempt !== job.attempts || job.sealedAtDbMs > job.updatedAtMs
      || job.sealedAtDbMs < job.sourceEvidenceDbMs) {
      throw new Error("published tenant restore journal job is incomplete");
    }
    return;
  }
  if (job.phase === "blocked") {
    exactKeys(job, [...baseKeys, "blockedAtDbMs", "blockedReasonCode"],
      "blocked tenant restore publication job");
    timestamp(job.blockedAtDbMs, "tenant restore publication block time");
    if (!(job.blockedReasonCode === "source_conflict"
      || job.blockedReasonCode === "remote_conflict")) {
      throw new Error("tenant restore publication block reason is invalid");
    }
    return;
  }
  throw new Error("tenant restore publication job phase is invalid");
}

export interface MaterializeTenantRestoreJournalPublicationJobsOptions { limit: number }
export interface ClaimTenantRestoreJournalPublicationsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}
export interface RenewTenantRestoreJournalPublicationOptions { leaseMs: number }
export interface RetryTenantRestoreJournalPublicationOptions {
  delayMs: number;
  errorCode: TenantRestoreJournalPublicationRetryErrorCode;
}

export function validateMaterializeTenantRestoreJournalPublicationJobsOptions(
  options: MaterializeTenantRestoreJournalPublicationJobsOptions,
): void {
  exactKeys(options, ["limit"], "materialize tenant restore publications options");
  positive(options.limit, "tenant restore publication materialize limit");
  if (options.limit > 100) throw new Error("tenant restore publication limit exceeds 100");
}

export function validateClaimTenantRestoreJournalPublicationsOptions(
  options: ClaimTenantRestoreJournalPublicationsOptions,
): void {
  exactKeys(options, ["limit", "leaseMs", "claimToken"],
    "claim tenant restore publications options");
  positive(options.limit, "tenant restore publication claim limit");
  if (options.limit > 100) throw new Error("tenant restore publication claim limit exceeds 100");
  positive(options.leaseMs, "tenant restore publication claim lease");
  claimToken(options.claimToken);
}

export function validateRenewTenantRestoreJournalPublicationOptions(
  options: RenewTenantRestoreJournalPublicationOptions,
): void {
  exactKeys(options, ["leaseMs"], "renew tenant restore publication options");
  positive(options.leaseMs, "tenant restore publication renewal lease");
}

export function validateRetryTenantRestoreJournalPublicationOptions(
  options: RetryTenantRestoreJournalPublicationOptions,
): void {
  exactKeys(options, ["delayMs", "errorCode"], "retry tenant restore publication options");
  timestamp(options.delayMs, "tenant restore publication retry delay");
  if (!(options.errorCode === "temporary_failure" || options.errorCode === "dependency_pending")) {
    throw new Error("tenant restore publication retry error is invalid");
  }
}

export interface TenantRestoreJournalPublicationBundle {
  targets: TenantRestoreJournalPublicationTarget[];
  targetAcks: TenantRestoreJournalPublicationTargetAck[];
  receipt?: TenantRestoreJournalPublicationReceipt;
}

/** Durable publication boundary. T1 writers call this in their admission transaction once active. */
export interface TenantRestoreJournalStore {
  getTenantRestoreJournalControl(): Promise<TenantRestoreJournalControlRecord>;
  getTenantRestoreJournalControlTargets(): Promise<TenantRestoreJournalTargetDescriptor[]>;
  activateTenantRestoreJournalControl(
    input: ActivateTenantRestoreJournalControlInput,
  ): Promise<ActiveJournalControl>;
  materializeTenantRestoreJournalPublicationJobs(
    options: MaterializeTenantRestoreJournalPublicationJobsOptions,
  ): Promise<number>;
  claimTenantRestoreJournalPublications(
    options: ClaimTenantRestoreJournalPublicationsOptions,
  ): Promise<TenantRestoreJournalPublicationClaim[]>;
  renewTenantRestoreJournalPublication(
    authorization: TenantRestoreJournalPublicationAuthorization,
    options: RenewTenantRestoreJournalPublicationOptions,
  ): Promise<boolean>;
  retryTenantRestoreJournalPublication(
    authorization: TenantRestoreJournalPublicationAuthorization,
    options: RetryTenantRestoreJournalPublicationOptions,
  ): Promise<boolean>;
  blockTenantRestoreJournalPublication(
    authorization: TenantRestoreJournalPublicationAuthorization,
    reason?: TenantRestoreJournalPublicationBlockReasonCode,
  ): Promise<boolean>;
  getTenantRestoreJournalPublicationRecord(
    authorization: TenantRestoreJournalPublicationAuthorization,
    targetOrdinal: number,
  ): Promise<{ target: TenantRestoreJournalPublicationTarget; record: TenantRestoreJournalRecord } | null>;
  recordTenantRestoreJournalPublicationTargetAck(
    authorization: TenantRestoreJournalPublicationAuthorization,
    result: TenantRestoreJournalAdapterResult,
  ): Promise<TenantRestoreJournalPublicationTargetAck | null>;
  sealTenantRestoreJournalPublication(
    authorization: TenantRestoreJournalPublicationAuthorization,
  ): Promise<TenantRestoreJournalPublicationReceipt | null>;
  getTenantRestoreJournalPublicationJob(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRestoreJournalPublicationJobRecord | null>;
  getTenantRestoreJournalPublicationBundle(
    tenantId: string,
    requestId: string,
  ): Promise<TenantRestoreJournalPublicationBundle | null>;
  hasTenantRestoreJournalPublicationWork(): Promise<boolean>;
}

export interface TenantRestoreReplaySealedTarget extends TenantRestoreJournalTargetDescriptor {
  logicalDatabaseNamespaceSha256: string;
  sealedRemoteSequence: number;
  sealedHeadRootSha256: string;
}

export function validateTenantRestoreReplaySealedTarget(
  target: TenantRestoreReplaySealedTarget,
): void {
  exactKeys(target, [
    "targetOrdinal",
    "targetSha256",
    "failureDomainSha256",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "sealedRemoteSequence",
    "sealedHeadRootSha256",
  ], "tenant restore replay sealed target");
  validateTenantRestoreJournalTargetDescriptor({
    targetOrdinal: target.targetOrdinal,
    targetSha256: target.targetSha256,
    failureDomainSha256: target.failureDomainSha256,
    adapterProtocol: target.adapterProtocol,
    journalNamespaceSha256: target.journalNamespaceSha256,
  });
  digest(target.logicalDatabaseNamespaceSha256, "tenant restore replay database namespace");
  timestamp(target.sealedRemoteSequence, "tenant restore replay sealed sequence");
  digest(target.sealedHeadRootSha256, "tenant restore replay sealed head root");
  if ((target.sealedRemoteSequence === 0)
    !== (target.sealedHeadRootSha256
      === EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256)) {
    throw new Error("tenant restore replay sealed target sequence and root disagree");
  }
}

export function tenantRestoreReplaySealedTargetRootSha256(
  targets: readonly TenantRestoreReplaySealedTarget[],
): string {
  const ordered = [...targets].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  const descriptors: TenantRestoreJournalTargetDescriptor[] = [];
  for (const [ordinal, target] of ordered.entries()) {
    validateTenantRestoreReplaySealedTarget(target);
    if (target.targetOrdinal !== ordinal
      || (ordered[0] !== undefined && target.logicalDatabaseNamespaceSha256
        !== ordered[0]!.logicalDatabaseNamespaceSha256)) {
      throw new Error("tenant restore replay sealed target catalog is invalid");
    }
    descriptors.push({
      targetOrdinal: target.targetOrdinal,
      targetSha256: target.targetSha256,
      failureDomainSha256: target.failureDomainSha256,
      adapterProtocol: target.adapterProtocol,
      journalNamespaceSha256: target.journalNamespaceSha256,
    });
  }
  tenantRestoreJournalTargetRootSha256(descriptors);
  return sha256([
    "tenant-restore-replay-sealed-target-root-v1",
    ...ordered.flatMap((target) => [
      target.targetOrdinal,
      target.targetSha256,
      target.failureDomainSha256,
      target.adapterProtocol,
      target.journalNamespaceSha256,
      target.logicalDatabaseNamespaceSha256,
      target.sealedRemoteSequence,
      target.sealedHeadRootSha256,
    ]),
  ]);
}

export interface TenantRestoreFence {
  scope: typeof TENANT_RESTORE_FENCE_SCOPE;
  logicalDatabaseNamespaceSha256: string;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1FenceSha256: string;
  operationSha256: string;
  recordSha256: string;
  restoreRunId: string;
  sourceTargetSha256: string;
  sourceRemoteSequence: number;
  sourceHeadRootSha256: string;
  installedAtDbMs: number;
  fenceSha256: string;
}

type TenantRestoreFenceBody = Omit<TenantRestoreFence, "fenceSha256">;

export function tenantRestoreFenceSha256(fence: TenantRestoreFenceBody): string {
  exactKeys(fence, [
    "scope",
    "logicalDatabaseNamespaceSha256",
    "requestId",
    "tenantId",
    "subjectGeneration",
    "t1FenceSha256",
    "operationSha256",
    "recordSha256",
    "restoreRunId",
    "sourceTargetSha256",
    "sourceRemoteSequence",
    "sourceHeadRootSha256",
    "installedAtDbMs",
  ], "tenant restore fence");
  if (fence.scope !== TENANT_RESTORE_FENCE_SCOPE) {
    throw new Error("tenant restore fence scope is invalid");
  }
  const expectedOperation = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: fence.logicalDatabaseNamespaceSha256,
    requestId: fence.requestId,
    tenantId: fence.tenantId,
    subjectGeneration: fence.subjectGeneration,
    t1FenceSha256: fence.t1FenceSha256,
  });
  digest(fence.operationSha256, "tenant restore fence operation");
  if (fence.operationSha256 !== expectedOperation) {
    throw new Error("tenant restore fence operation does not match");
  }
  const expectedRecord = tenantRestoreJournalRecordSha256({
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: fence.logicalDatabaseNamespaceSha256,
    requestId: fence.requestId,
    tenantId: fence.tenantId,
    subjectGeneration: fence.subjectGeneration,
    t1FenceSha256: fence.t1FenceSha256,
    operationSha256: fence.operationSha256,
  });
  digest(fence.recordSha256, "tenant restore fence record");
  if (fence.recordSha256 !== expectedRecord) {
    throw new Error("tenant restore fence record does not match");
  }
  restoreRunId(fence.restoreRunId);
  digest(fence.sourceTargetSha256, "tenant restore fence source target");
  positive(fence.sourceRemoteSequence, "tenant restore fence source sequence");
  digest(fence.sourceHeadRootSha256, "tenant restore fence source head");
  timestamp(fence.installedAtDbMs, "tenant restore fence installation time");
  return sha256([
    "tenant-restore-fence-v1",
    fence.scope,
    fence.logicalDatabaseNamespaceSha256,
    fence.requestId,
    fence.tenantId,
    fence.subjectGeneration,
    fence.t1FenceSha256,
    fence.operationSha256,
    fence.recordSha256,
    fence.restoreRunId,
    fence.sourceTargetSha256,
    fence.sourceRemoteSequence,
    fence.sourceHeadRootSha256,
    fence.installedAtDbMs,
  ]);
}

export function validateTenantRestoreFence(fence: TenantRestoreFence): void {
  exactKeys(fence, [
    "scope",
    "logicalDatabaseNamespaceSha256",
    "requestId",
    "tenantId",
    "subjectGeneration",
    "t1FenceSha256",
    "operationSha256",
    "recordSha256",
    "restoreRunId",
    "sourceTargetSha256",
    "sourceRemoteSequence",
    "sourceHeadRootSha256",
    "installedAtDbMs",
    "fenceSha256",
  ], "tenant restore fence");
  const { fenceSha256, ...body } = fence;
  const expected = tenantRestoreFenceSha256(body);
  digest(fenceSha256, "tenant restore fence");
  if (fenceSha256 !== expected) throw new Error("tenant restore fence digest does not match");
}

export function tenantRestoreFenceRootSha256(fences: readonly TenantRestoreFence[]): string {
  const ordered = [...fences].sort((left, right) => left.tenantId.localeCompare(right.tenantId));
  for (const [index, fence] of ordered.entries()) {
    validateTenantRestoreFence(fence);
    if (index > 0 && ordered[index - 1]!.tenantId >= fence.tenantId) {
      throw new Error("tenant restore fence catalog is duplicated");
    }
  }
  return sha256(["tenant-restore-fence-root-v1", ...ordered.map((fence) => fence.fenceSha256)]);
}

export const EMPTY_TENANT_RESTORE_FENCE_ROOT_SHA256 = tenantRestoreFenceRootSha256([]);
export const EMPTY_TENANT_RESTORE_REPLAY_ENTRY_ROOT_SHA256 = sha256([
  "tenant-restore-replay-entry-root-v1",
]);

export type TenantRestoreReplayFenceDisposition = "installed" | "exact_replay";

export interface TenantRestoreReplayEntry {
  scope: typeof TENANT_RESTORE_REPLAY_ENTRY_SCOPE;
  restoreRunId: string;
  replayOrdinal: number;
  targetOrdinal: number;
  targetSha256: string;
  remoteSequence: number;
  previousHeadRootSha256: string;
  headRootSha256: string;
  logicalDatabaseNamespaceSha256: string;
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t1FenceSha256: string;
  operationSha256: string;
  recordSha256: string;
  fenceDisposition: TenantRestoreReplayFenceDisposition;
  fenceSha256: string;
  previousEntryRootSha256: string;
  storeDbTimestampMs: number;
  entrySha256: string;
}

type TenantRestoreReplayEntryBody = Omit<TenantRestoreReplayEntry, "entrySha256">;

export function tenantRestoreReplayEntrySha256(entry: TenantRestoreReplayEntryBody): string {
  exactKeys(entry, [
    "scope",
    "restoreRunId",
    "replayOrdinal",
    "targetOrdinal",
    "targetSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "headRootSha256",
    "logicalDatabaseNamespaceSha256",
    "requestId",
    "tenantId",
    "subjectGeneration",
    "t1FenceSha256",
    "operationSha256",
    "recordSha256",
    "fenceDisposition",
    "fenceSha256",
    "previousEntryRootSha256",
    "storeDbTimestampMs",
  ], "tenant restore replay entry");
  if (entry.scope !== TENANT_RESTORE_REPLAY_ENTRY_SCOPE) {
    throw new Error("tenant restore replay entry scope is invalid");
  }
  restoreRunId(entry.restoreRunId);
  positive(entry.replayOrdinal, "tenant restore replay ordinal");
  timestamp(entry.targetOrdinal, "tenant restore replay target ordinal");
  for (const [value, name] of [
    [entry.targetSha256, "target"],
    [entry.previousHeadRootSha256, "previous remote head"],
    [entry.headRootSha256, "remote head"],
    [entry.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [entry.t1FenceSha256, "T1 fence"],
    [entry.operationSha256, "operation"],
    [entry.recordSha256, "record"],
    [entry.fenceSha256, "fence"],
    [entry.previousEntryRootSha256, "previous entry root"],
  ] as const) digest(value, `tenant restore replay entry ${name}`);
  positive(entry.remoteSequence, "tenant restore replay remote sequence");
  if (!REQUEST_ID.test(entry.requestId)) throw new Error("invalid tenant restore replay request id");
  tenantId(entry.tenantId);
  positive(entry.subjectGeneration, "tenant restore replay subject generation");
  if (!(entry.fenceDisposition === "installed" || entry.fenceDisposition === "exact_replay")) {
    throw new Error("tenant restore replay fence disposition is invalid");
  }
  if (entry.headRootSha256 !== tenantRestoreJournalNextRemoteHeadRootSha256({
    previousHeadRootSha256: entry.previousHeadRootSha256,
    targetSha256: entry.targetSha256,
    remoteSequence: entry.remoteSequence,
    operationSha256: entry.operationSha256,
    recordSha256: entry.recordSha256,
  })) throw new Error("tenant restore replay entry remote head does not match");
  timestamp(entry.storeDbTimestampMs, "tenant restore replay entry time");
  return sha256([
    "tenant-restore-replay-entry-v1",
    entry.scope,
    entry.restoreRunId,
    entry.replayOrdinal,
    entry.targetOrdinal,
    entry.targetSha256,
    entry.remoteSequence,
    entry.previousHeadRootSha256,
    entry.headRootSha256,
    entry.logicalDatabaseNamespaceSha256,
    entry.requestId,
    entry.tenantId,
    entry.subjectGeneration,
    entry.t1FenceSha256,
    entry.operationSha256,
    entry.recordSha256,
    entry.fenceDisposition,
    entry.fenceSha256,
    entry.previousEntryRootSha256,
    entry.storeDbTimestampMs,
  ]);
}

export function validateTenantRestoreReplayEntry(entry: TenantRestoreReplayEntry): void {
  exactKeys(entry, [
    "scope",
    "restoreRunId",
    "replayOrdinal",
    "targetOrdinal",
    "targetSha256",
    "remoteSequence",
    "previousHeadRootSha256",
    "headRootSha256",
    "logicalDatabaseNamespaceSha256",
    "requestId",
    "tenantId",
    "subjectGeneration",
    "t1FenceSha256",
    "operationSha256",
    "recordSha256",
    "fenceDisposition",
    "fenceSha256",
    "previousEntryRootSha256",
    "storeDbTimestampMs",
    "entrySha256",
  ], "tenant restore replay entry");
  const { entrySha256, ...body } = entry;
  const expected = tenantRestoreReplayEntrySha256(body);
  digest(entrySha256, "tenant restore replay entry");
  if (entrySha256 !== expected) throw new Error("tenant restore replay entry digest does not match");
}

export function tenantRestoreReplayNextEntryRootSha256(
  previousRootSha256: string,
  entrySha256: string,
): string {
  digest(previousRootSha256, "tenant restore replay previous entry root");
  digest(entrySha256, "tenant restore replay entry");
  return sha256(["tenant-restore-replay-entry-chain-v1", previousRootSha256, entrySha256]);
}

export function tenantRestoreReplayEntryRootSha256(
  entries: readonly TenantRestoreReplayEntry[],
): string {
  const ordered = [...entries].sort((left, right) => left.replayOrdinal - right.replayOrdinal);
  let root = EMPTY_TENANT_RESTORE_REPLAY_ENTRY_ROOT_SHA256;
  for (const [index, entry] of ordered.entries()) {
    validateTenantRestoreReplayEntry(entry);
    if (entry.replayOrdinal !== index + 1 || entry.previousEntryRootSha256 !== root) {
      throw new Error("tenant restore replay entry chain is incomplete");
    }
    root = tenantRestoreReplayNextEntryRootSha256(root, entry.entrySha256);
  }
  return root;
}

export type TenantRestoreReplayRunPhase = "prepared" | "replay_sealed" | "active" | "aborted";

interface TenantRestoreReplayRunBase {
  restoreRunId: string;
  sourceBackupSha256: string;
  runtimeEpochSha256: string;
  protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
  controlEvidenceSha256: string;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  targetCount: number;
  targetRootSha256: string;
  sealedTargetRootSha256: string;
  expectedEntryCount: number;
  entryCount: number;
  entryRootSha256: string;
  fenceCount: number;
  fenceRootSha256: string;
  phase: TenantRestoreReplayRunPhase;
  createdAtDbMs: number;
  updatedAtDbMs: number;
}

export type TenantRestoreReplayRunRecord = TenantRestoreReplayRunBase & (
  | {
      phase: "prepared";
      terminalReceiptSha256?: never;
      sealedAtDbMs?: never;
      activatedAtDbMs?: never;
      abortedAtDbMs?: never;
    }
  | {
      phase: "replay_sealed";
      terminalReceiptSha256: string;
      sealedAtDbMs: number;
      activatedAtDbMs?: never;
      abortedAtDbMs?: never;
    }
  | {
      phase: "active";
      terminalReceiptSha256: string;
      sealedAtDbMs: number;
      activatedAtDbMs: number;
      abortedAtDbMs?: never;
    }
  | {
      phase: "aborted";
      terminalReceiptSha256?: never;
      sealedAtDbMs?: never;
      activatedAtDbMs?: never;
      abortedAtDbMs: number;
    }
);

export interface PrepareTenantRestoreReplayInput {
  restoreRunId: string;
  sourceBackupSha256: string;
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  sealedTargets: TenantRestoreReplaySealedTarget[];
}

export function validatePrepareTenantRestoreReplayInput(
  input: PrepareTenantRestoreReplayInput,
): void {
  exactKeys(input, [
    "restoreRunId",
    "sourceBackupSha256",
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "sealedTargets",
  ], "prepare tenant restore replay input");
  restoreRunId(input.restoreRunId);
  for (const [value, name] of [
    [input.sourceBackupSha256, "source backup"],
    [input.runtimeEpochSha256, "runtime epoch"],
    [input.controlEvidenceSha256, "control evidence"],
  ] as const) digest(value, `tenant restore replay ${name}`);
  if (input.sealedTargets.length === 0 || input.sealedTargets.length > 32) {
    throw new Error("tenant restore replay sealed target count is invalid");
  }
  tenantRestoreReplaySealedTargetRootSha256(input.sealedTargets);
}

export function validateTenantRestoreReplayRunRecord(run: TenantRestoreReplayRunRecord): void {
  const terminalKeys = run.phase === "prepared"
    ? []
    : run.phase === "replay_sealed"
      ? ["terminalReceiptSha256", "sealedAtDbMs"]
      : run.phase === "active"
        ? ["terminalReceiptSha256", "sealedAtDbMs", "activatedAtDbMs"]
        : run.phase === "aborted"
          ? ["abortedAtDbMs"]
          : [];
  exactKeys(run, [
    "restoreRunId",
    "sourceBackupSha256",
    "runtimeEpochSha256",
    "protocol",
    "controlEvidenceSha256",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "sealedTargetRootSha256",
    "expectedEntryCount",
    "entryCount",
    "entryRootSha256",
    "fenceCount",
    "fenceRootSha256",
    "phase",
    "createdAtDbMs",
    "updatedAtDbMs",
    ...terminalKeys,
  ], "tenant restore replay run");
  restoreRunId(run.restoreRunId);
  for (const [value, name] of [
    [run.sourceBackupSha256, "source backup"],
    [run.runtimeEpochSha256, "runtime epoch"],
    [run.controlEvidenceSha256, "control evidence"],
    [run.journalNamespaceSha256, "journal namespace"],
    [run.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [run.targetRootSha256, "target root"],
    [run.sealedTargetRootSha256, "sealed target root"],
    [run.entryRootSha256, "entry root"],
    [run.fenceRootSha256, "fence root"],
  ] as const) digest(value, `tenant restore replay run ${name}`);
  if (run.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL) {
    throw new Error("tenant restore replay run protocol is invalid");
  }
  identifier(run.adapterProtocol, "tenant restore replay run adapter protocol");
  positive(run.targetCount, "tenant restore replay run target count");
  timestamp(run.expectedEntryCount, "tenant restore replay expected entry count");
  timestamp(run.entryCount, "tenant restore replay entry count");
  timestamp(run.fenceCount, "tenant restore replay fence count");
  timestamp(run.createdAtDbMs, "tenant restore replay run creation time");
  timestamp(run.updatedAtDbMs, "tenant restore replay run update time");
  if (run.updatedAtDbMs < run.createdAtDbMs || run.entryCount > run.expectedEntryCount
    || run.fenceCount > run.entryCount
    || (run.entryCount === 0 && run.entryRootSha256 !== EMPTY_TENANT_RESTORE_REPLAY_ENTRY_ROOT_SHA256)
    || (run.fenceCount === 0 && run.fenceRootSha256 !== EMPTY_TENANT_RESTORE_FENCE_ROOT_SHA256)) {
    throw new Error("tenant restore replay run counters are invalid");
  }
  if (run.phase === "prepared") {
    if ("terminalReceiptSha256" in run || "sealedAtDbMs" in run
      || "activatedAtDbMs" in run || "abortedAtDbMs" in run) {
      throw new Error("prepared tenant restore replay run has terminal fields");
    }
    return;
  }
  if (run.phase === "replay_sealed" || run.phase === "active") {
    digest(run.terminalReceiptSha256, "tenant restore replay terminal receipt");
    timestamp(run.sealedAtDbMs, "tenant restore replay seal time");
    if (run.entryCount !== run.expectedEntryCount || run.sealedAtDbMs > run.updatedAtDbMs) {
      throw new Error("sealed tenant restore replay run is incomplete");
    }
    if (run.phase === "active") {
      timestamp(run.activatedAtDbMs, "tenant restore replay activation time");
      if (run.activatedAtDbMs < run.sealedAtDbMs || run.activatedAtDbMs > run.updatedAtDbMs) {
        throw new Error("tenant restore replay activation time is invalid");
      }
    } else if ("activatedAtDbMs" in run || "abortedAtDbMs" in run) {
      throw new Error("sealed tenant restore replay run has invalid terminal fields");
    }
    return;
  }
  if (run.phase === "aborted") {
    timestamp(run.abortedAtDbMs, "tenant restore replay abort time");
    if (run.abortedAtDbMs > run.updatedAtDbMs
      || "terminalReceiptSha256" in run || "sealedAtDbMs" in run
      || "activatedAtDbMs" in run) {
      throw new Error("aborted tenant restore replay run fields are invalid");
    }
    return;
  }
  throw new Error("tenant restore replay run phase is invalid");
}

export interface RecordTenantRestoreReplayFenceInput {
  restoreRunId: string;
  targetOrdinal: number;
  remoteEntry: TenantRestoreJournalRemoteEntry;
}

export function validateRecordTenantRestoreReplayFenceInput(
  input: RecordTenantRestoreReplayFenceInput,
): void {
  exactKeys(input, ["restoreRunId", "targetOrdinal", "remoteEntry"],
    "record tenant restore replay fence input");
  restoreRunId(input.restoreRunId);
  timestamp(input.targetOrdinal, "tenant restore replay target ordinal");
  validateTenantRestoreJournalRemoteEntry(input.remoteEntry);
}

export interface TenantRestoreReplayReceipt {
  scope: typeof TENANT_RESTORE_REPLAY_RECEIPT_SCOPE;
  restoreRunId: string;
  sourceBackupSha256: string;
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  protocol: typeof TENANT_RESTORE_JOURNAL_PROTOCOL;
  adapterProtocol: string;
  journalNamespaceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  targetCount: number;
  targetRootSha256: string;
  sealedTargetRootSha256: string;
  entryCount: number;
  entryRootSha256: string;
  fenceCount: number;
  fenceRootSha256: string;
  storeDbTimestampMs: number;
  restoreFenceReplayComplete: true;
  physicalReplayComplete: false;
  allDomainsComplete: false;
  contentPurgeExecuted: false;
  receiptSha256: string;
}

type TenantRestoreReplayReceiptBody = Omit<TenantRestoreReplayReceipt, "receiptSha256">;

export function tenantRestoreReplayReceiptSha256(
  receipt: TenantRestoreReplayReceiptBody,
): string {
  exactKeys(receipt, [
    "scope",
    "restoreRunId",
    "sourceBackupSha256",
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "sealedTargetRootSha256",
    "entryCount",
    "entryRootSha256",
    "fenceCount",
    "fenceRootSha256",
    "storeDbTimestampMs",
    "restoreFenceReplayComplete",
    "physicalReplayComplete",
    "allDomainsComplete",
    "contentPurgeExecuted",
  ], "tenant restore replay receipt");
  if (receipt.scope !== TENANT_RESTORE_REPLAY_RECEIPT_SCOPE
    || receipt.protocol !== TENANT_RESTORE_JOURNAL_PROTOCOL
    || receipt.restoreFenceReplayComplete !== true
    || receipt.physicalReplayComplete !== false
    || receipt.allDomainsComplete !== false
    || receipt.contentPurgeExecuted !== false) {
    throw new Error("tenant restore replay receipt flags are invalid");
  }
  restoreRunId(receipt.restoreRunId);
  for (const [value, name] of [
    [receipt.sourceBackupSha256, "source backup"],
    [receipt.runtimeEpochSha256, "runtime epoch"],
    [receipt.controlEvidenceSha256, "control evidence"],
    [receipt.journalNamespaceSha256, "journal namespace"],
    [receipt.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [receipt.targetRootSha256, "target root"],
    [receipt.sealedTargetRootSha256, "sealed target root"],
    [receipt.entryRootSha256, "entry root"],
    [receipt.fenceRootSha256, "fence root"],
  ] as const) digest(value, `tenant restore replay receipt ${name}`);
  identifier(receipt.adapterProtocol, "tenant restore replay receipt adapter protocol");
  positive(receipt.targetCount, "tenant restore replay receipt target count");
  timestamp(receipt.entryCount, "tenant restore replay receipt entry count");
  timestamp(receipt.fenceCount, "tenant restore replay receipt fence count");
  timestamp(receipt.storeDbTimestampMs, "tenant restore replay receipt time");
  if (receipt.fenceCount > receipt.entryCount) {
    throw new Error("tenant restore replay receipt fence count is invalid");
  }
  return sha256([
    "tenant-restore-replay-receipt-v1",
    receipt.scope,
    receipt.restoreRunId,
    receipt.sourceBackupSha256,
    receipt.runtimeEpochSha256,
    receipt.controlEvidenceSha256,
    receipt.protocol,
    receipt.adapterProtocol,
    receipt.journalNamespaceSha256,
    receipt.logicalDatabaseNamespaceSha256,
    receipt.targetCount,
    receipt.targetRootSha256,
    receipt.sealedTargetRootSha256,
    receipt.entryCount,
    receipt.entryRootSha256,
    receipt.fenceCount,
    receipt.fenceRootSha256,
    receipt.storeDbTimestampMs,
    receipt.restoreFenceReplayComplete,
    receipt.physicalReplayComplete,
    receipt.allDomainsComplete,
    receipt.contentPurgeExecuted,
  ]);
}

export function validateTenantRestoreReplayReceipt(receipt: TenantRestoreReplayReceipt): void {
  exactKeys(receipt, [
    "scope",
    "restoreRunId",
    "sourceBackupSha256",
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "protocol",
    "adapterProtocol",
    "journalNamespaceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "sealedTargetRootSha256",
    "entryCount",
    "entryRootSha256",
    "fenceCount",
    "fenceRootSha256",
    "storeDbTimestampMs",
    "restoreFenceReplayComplete",
    "physicalReplayComplete",
    "allDomainsComplete",
    "contentPurgeExecuted",
    "receiptSha256",
  ], "tenant restore replay receipt");
  const { receiptSha256, ...body } = receipt;
  const expected = tenantRestoreReplayReceiptSha256(body);
  digest(receiptSha256, "tenant restore replay receipt");
  if (receiptSha256 !== expected) throw new Error("tenant restore replay receipt does not match");
}

export const EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256 = sha256([
  "tenant-restore-runtime-control-evidence-v1",
]);

export type TenantRestoreRuntimeControlUpdateKind =
  | "primary_activation"
  | "restore_activation"
  | "journal_head_advance";

export interface TenantRestoreRuntimeControlActiveBase {
  singletonId: typeof TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID;
  state: "active";
  controlGeneration: number;
  updateKind: TenantRestoreRuntimeControlUpdateKind;
  activatedAtDbMs: number;
  updatedAtDbMs: number;
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  targetCount: number;
  targetRootSha256: string;
  verifiedHeadRootSha256: string;
  previousControlEvidenceSha256: string;
  evidenceSha256: string;
}

type TenantRestoreRuntimePrimaryLineage = {
  lineageKind: "primary";
  restoreRunId?: never;
  replayReceiptSha256?: never;
};

type TenantRestoreRuntimeRestoreLineage = {
  lineageKind: "restore";
  restoreRunId: string;
  replayReceiptSha256: string;
};

export type TenantRestoreRuntimeControlRecord =
  | {
      singletonId: typeof TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID;
      state: "inactive";
      controlGeneration: 0;
    }
  | (TenantRestoreRuntimeControlActiveBase & TenantRestoreRuntimePrimaryLineage & {
      updateKind: "primary_activation" | "journal_head_advance";
    })
  | (TenantRestoreRuntimeControlActiveBase & TenantRestoreRuntimeRestoreLineage & {
      updateKind: "restore_activation" | "journal_head_advance";
    });

type ActiveRuntimeControl = Extract<TenantRestoreRuntimeControlRecord, { state: "active" }>;
type ActiveRuntimeControlBody = ActiveRuntimeControl extends infer Control
  ? Control extends ActiveRuntimeControl
    ? Omit<Control, "evidenceSha256">
    : never
  : never;

export function tenantRestoreRuntimeControlEvidenceSha256(
  control: ActiveRuntimeControlBody,
): string {
  const lineageKeys = control.lineageKind === "restore"
    ? ["restoreRunId", "replayReceiptSha256"] as const
    : [] as const;
  exactKeys(control, [
    "singletonId",
    "state",
    "controlGeneration",
    "updateKind",
    "activatedAtDbMs",
    "updatedAtDbMs",
    "lineageKind",
    ...lineageKeys,
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "verifiedHeadRootSha256",
    "previousControlEvidenceSha256",
  ], "tenant restore runtime control evidence");
  if (control.singletonId !== TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID
    || control.state !== "active") {
    throw new Error("tenant restore runtime control identity is invalid");
  }
  positive(control.controlGeneration, "tenant restore runtime control generation");
  if (!(control.updateKind === "primary_activation"
    || control.updateKind === "restore_activation"
    || control.updateKind === "journal_head_advance")) {
    throw new Error("tenant restore runtime control update kind is invalid");
  }
  timestamp(control.activatedAtDbMs, "tenant restore runtime activation time");
  timestamp(control.updatedAtDbMs, "tenant restore runtime update time");
  if (control.updatedAtDbMs < control.activatedAtDbMs) {
    throw new Error("tenant restore runtime update predates activation");
  }
  // Widen before comparing: callers can deserialize hostile database JSON that bypasses the
  // TypeScript discriminated union, so runtime validation must enforce both directions itself.
  const updateKind: string = control.updateKind;
  if (control.lineageKind === "primary") {
    if (updateKind === "restore_activation") {
      throw new Error("primary tenant restore runtime lineage cannot restore-activate");
    }
    if (control.updateKind === "primary_activation"
      && (control.controlGeneration !== 1
        || control.previousControlEvidenceSha256
          !== EMPTY_TENANT_RESTORE_RUNTIME_CONTROL_EVIDENCE_SHA256)) {
      throw new Error("primary tenant restore runtime activation is not generation one");
    }
  } else if (control.lineageKind === "restore") {
    if (updateKind === "primary_activation") {
      throw new Error("restore tenant runtime lineage cannot primary-activate");
    }
    restoreRunId(control.restoreRunId);
    digest(control.replayReceiptSha256, "tenant restore runtime replay receipt");
  } else {
    throw new Error("tenant restore runtime lineage is invalid");
  }
  for (const [value, name] of [
    [control.runtimeEpochSha256, "runtime epoch"],
    [control.controlEvidenceSha256, "journal control evidence"],
    [control.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [control.targetRootSha256, "target root"],
    [control.verifiedHeadRootSha256, "verified head root"],
    [control.previousControlEvidenceSha256, "previous control evidence"],
  ] as const) digest(value, `tenant restore runtime control ${name}`);
  positive(control.targetCount, "tenant restore runtime target count");
  return sha256([
    "tenant-restore-runtime-control-v1",
    control.singletonId,
    control.state,
    control.controlGeneration,
    control.updateKind,
    control.activatedAtDbMs,
    control.updatedAtDbMs,
    control.lineageKind,
    ...(control.lineageKind === "restore"
      ? [control.restoreRunId, control.replayReceiptSha256]
      : []),
    control.runtimeEpochSha256,
    control.controlEvidenceSha256,
    control.logicalDatabaseNamespaceSha256,
    control.targetCount,
    control.targetRootSha256,
    control.verifiedHeadRootSha256,
    control.previousControlEvidenceSha256,
  ]);
}

export function validateTenantRestoreRuntimeControlRecord(
  control: TenantRestoreRuntimeControlRecord,
): void {
  if (control.state === "inactive") {
    exactKeys(control, ["singletonId", "state", "controlGeneration"],
      "inactive tenant restore runtime control");
    if (control.singletonId !== TENANT_RESTORE_RUNTIME_CONTROL_SINGLETON_ID
      || control.controlGeneration !== 0) {
      throw new Error("tenant restore runtime control singleton is invalid");
    }
    return;
  }
  const { evidenceSha256, ...body } = control;
  exactKeys(control, [
    "singletonId",
    "state",
    "controlGeneration",
    "updateKind",
    "activatedAtDbMs",
    "updatedAtDbMs",
    "lineageKind",
    ...(control.lineageKind === "restore" ? ["restoreRunId", "replayReceiptSha256"] : []),
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "logicalDatabaseNamespaceSha256",
    "targetCount",
    "targetRootSha256",
    "verifiedHeadRootSha256",
    "previousControlEvidenceSha256",
    "evidenceSha256",
  ], "active tenant restore runtime control");
  const expected = tenantRestoreRuntimeControlEvidenceSha256(body);
  digest(evidenceSha256, "tenant restore runtime control evidence");
  if (evidenceSha256 !== expected) {
    throw new Error("tenant restore runtime control evidence does not match");
  }
}

export interface ActivateTenantRestoreRuntimeInput {
  restoreRunId: string;
  expectedControlGeneration: number;
}

export function validateActivateTenantRestoreRuntimeInput(
  input: ActivateTenantRestoreRuntimeInput,
): void {
  exactKeys(input, ["restoreRunId", "expectedControlGeneration"],
    "activate tenant restore runtime input");
  restoreRunId(input.restoreRunId);
  timestamp(input.expectedControlGeneration, "tenant restore runtime expected generation");
}

export interface TenantRestoreRuntimeHeadAdvancement {
  targetOrdinal: number;
  entries: TenantRestoreJournalRemoteEntry[];
}

export function validateTenantRestoreRuntimeHeadAdvancement(
  advancement: TenantRestoreRuntimeHeadAdvancement,
): void {
  exactKeys(advancement, ["targetOrdinal", "entries"],
    "tenant restore runtime head advancement");
  timestamp(advancement.targetOrdinal, "tenant restore runtime advancement target ordinal");
  for (const [index, entry] of advancement.entries.entries()) {
    validateTenantRestoreJournalRemoteEntry(entry);
    if (index > 0) {
      const previous = advancement.entries[index - 1]!;
      if (entry.targetSha256 !== previous.targetSha256
        || entry.remoteSequence !== previous.remoteSequence + 1
        || entry.previousHeadRootSha256 !== previous.headRootSha256) {
        throw new Error("tenant restore runtime advancement is not one contiguous chain");
      }
    }
  }
}

export interface AssertTenantRestoreRuntimeReadyInput {
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  observedHeads: TenantRestoreReplaySealedTarget[];
}

export function validateAssertTenantRestoreRuntimeReadyInput(
  input: AssertTenantRestoreRuntimeReadyInput,
): void {
  exactKeys(input, [
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "observedHeads",
  ],
    "assert tenant restore runtime ready input");
  digest(input.runtimeEpochSha256, "tenant restore runtime readiness epoch");
  digest(input.controlEvidenceSha256, "tenant restore runtime readiness control evidence");
  tenantRestoreReplaySealedTargetRootSha256(input.observedHeads);
}

export interface AssertTenantRestoreRuntimeJournalEntryKnownInput {
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  expectedControlGeneration: number;
  targetOrdinal: number;
  remoteEntry: TenantRestoreJournalRemoteEntry;
}

export function validateAssertTenantRestoreRuntimeJournalEntryKnownInput(
  input: AssertTenantRestoreRuntimeJournalEntryKnownInput,
): void {
  exactKeys(input, [
    "runtimeEpochSha256",
    "controlEvidenceSha256",
    "expectedControlGeneration",
    "targetOrdinal",
    "remoteEntry",
  ], "assert tenant restore runtime journal entry known input");
  digest(input.runtimeEpochSha256, "tenant restore runtime journal entry epoch");
  digest(input.controlEvidenceSha256, "tenant restore runtime journal entry control evidence");
  positive(input.expectedControlGeneration, "tenant restore runtime expected generation");
  timestamp(input.targetOrdinal, "tenant restore runtime journal entry target ordinal");
  validateTenantRestoreJournalRemoteEntry(input.remoteEntry);
}

export interface ListTenantRestoreReplayEntriesOptions {
  limit: number;
  afterReplayOrdinal?: number;
}

export interface ListTenantRestoreFencesOptions {
  limit: number;
  afterTenantId?: string;
}

export interface RestoreReplayStore {
  prepareTenantRestoreReplay(
    input: PrepareTenantRestoreReplayInput,
  ): Promise<TenantRestoreReplayRunRecord>;
  getTenantRestoreReplayRun(restoreRunId: string): Promise<TenantRestoreReplayRunRecord | null>;
  getTenantRestoreReplaySealedTargets(restoreRunId: string): Promise<TenantRestoreReplaySealedTarget[]>;
  listTenantRestoreReplayEntries(
    restoreRunId: string,
    options: ListTenantRestoreReplayEntriesOptions,
  ): Promise<TenantRestoreReplayEntry[]>;
  recordTenantRestoreReplayFence(
    input: RecordTenantRestoreReplayFenceInput,
  ): Promise<TenantRestoreReplayEntry | null>;
  sealTenantRestoreReplay(restoreRunId: string): Promise<TenantRestoreReplayReceipt | null>;
  activateTenantRestoreRuntime(
    input: ActivateTenantRestoreRuntimeInput,
  ): Promise<TenantRestoreRuntimeControlRecord>;
  abortTenantRestoreReplay(restoreRunId: string): Promise<boolean>;
  getTenantRestoreReplayReceipt(restoreRunId: string): Promise<TenantRestoreReplayReceipt | null>;
  getTenantRestoreRuntimeControl(): Promise<TenantRestoreRuntimeControlRecord>;
  /** Durable per-target checkpoints used as the exclusive cursor for bounded startup scans. */
  getTenantRestoreRuntimeHeads(): Promise<TenantRestoreReplaySealedTarget[]>;
  getTenantRestoreFence(tenantId: string): Promise<TenantRestoreFence | null>;
  listTenantRestoreFences(options: ListTenantRestoreFencesOptions): Promise<TenantRestoreFence[]>;
  /**
   * Advance one exact contiguous remote-head link during paged startup catch-up. The store accepts
   * it only when the record still has its exact local T1 admission/fence or a permanent restore
   * fence; a database rollback that lost both remains fail-closed and requires offline replay.
   */
  assertTenantRestoreRuntimeJournalEntryKnown(
    input: AssertTenantRestoreRuntimeJournalEntryKnownInput,
  ): Promise<TenantRestoreRuntimeControlRecord>;
  assertTenantRestoreRuntimeReady(input: AssertTenantRestoreRuntimeReadyInput): Promise<void>;
}
