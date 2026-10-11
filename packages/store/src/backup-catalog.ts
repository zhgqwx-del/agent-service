import { createHash, randomUUID } from "node:crypto";
/* An anchor binds the exact sealed-head catalog, not merely a caller-supplied aggregate digest. */
import {
  tenantRestoreReplaySealedTargetRootSha256,
  validateTenantRestoreReplaySealedTarget,
  type TenantRestoreReplayRunRecord,
  type TenantRestoreReplaySealedTarget,
} from "./tenant-restore-journal.js";

export const TENANT_BACKUP_CATALOG_CONTROL_SINGLETON_ID = 1 as const;
export const TENANT_BACKUP_CATALOG_PROTOCOL = "tenant-backup-catalog-v1" as const;
export const TENANT_BACKUP_SNAPSHOT_ANCHOR_SCOPE = "tenant-backup-snapshot-anchor-v1" as const;
export const TENANT_BACKUP_CATALOG_ENTRY_SCOPE = "tenant-backup-catalog-entry-v1" as const;
export const TENANT_BACKUP_RESTORE_BINDING_SCOPE = "tenant-backup-restore-binding-v1" as const;
export const TENANT_BACKUP_RUNTIME_RESERVATION_SCOPE =
  "tenant-backup-runtime-reservation-v1" as const;
export const TENANT_BACKUP_CATALOG_EVICTION_SCOPE = "tenant-backup-catalog-eviction-v1" as const;
export const TENANT_BACKUP_CATALOG_EXTERNAL_EVENT_SCOPE =
  "tenant-backup-catalog-external-event-v1" as const;

const BACKUP_ID = /^backup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVICTION_ID = /^backup_evict_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_RUN_ID = /^restore_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
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

function digest(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

function timestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function positive(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function backupId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !BACKUP_ID.test(value)) {
    throw new Error("invalid tenant backup id");
  }
}

function evictionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !EVICTION_ID.test(value)) {
    throw new Error("invalid tenant backup eviction id");
  }
}

function restoreRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RESTORE_RUN_ID.test(value)) {
    throw new Error("invalid tenant backup restore run id");
  }
}

export function newTenantBackupId(): string {
  return `backup_${randomUUID()}`;
}

export function newTenantBackupEvictionId(): string {
  return `backup_evict_${randomUUID()}`;
}

/** Exact content-free commitment used by MySQL and backup tooling for the applied migration set. */
export function tenantBackupSchemaMigrationRootSha256(
  migrationNames: readonly string[],
): string {
  if (!Array.isArray(migrationNames)) throw new Error("schema migration names must be an array");
  const ordered = [...migrationNames];
  for (const name of ordered) {
    if (typeof name !== "string" || name.length === 0 || Buffer.byteLength(name, "utf8") > 128) {
      throw new Error("schema migration name is invalid");
    }
  }
  ordered.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (ordered.some((name, index) => index > 0 && name === ordered[index - 1])) {
    throw new Error("schema migration names contain duplicates");
  }
  let root = createHash("sha256").update("agent-service-schema-migrations-v1").digest("hex");
  for (const name of ordered) {
    const length = Buffer.byteLength(name, "utf8").toString().padStart(10, "0");
    root = createHash("sha256")
      .update(`agent-service-schema-migration-v1|${root}|${length}|${name}`)
      .digest("hex");
  }
  return root;
}

/** Content-free fleet signal binding one active catalog to one exact live runtime lineage. */
export function tenantBackupCatalogRuntimeBindingSha256(input: {
  catalogControlEvidenceSha256: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  logicalDatabaseNamespaceSha256: string;
  journalControlEvidenceSha256: string;
  runtimeEpochSha256: string;
  runtimeControlGeneration: number;
  runtimeControlEvidenceSha256: string;
  runtimeHeadRootSha256: string;
}): string {
  const keys = [
    "catalogControlEvidenceSha256",
    "catalogNamespaceSha256",
    "catalogTargetSha256",
    "logicalDatabaseNamespaceSha256",
    "journalControlEvidenceSha256",
    "runtimeEpochSha256",
    "runtimeControlGeneration",
    "runtimeControlEvidenceSha256",
    "runtimeHeadRootSha256",
  ] as const;
  exactKeys(input, keys, "tenant backup catalog runtime binding");
  for (const key of keys) {
    if (key === "runtimeControlGeneration") continue;
    digest(input[key], `tenant backup catalog runtime binding ${key}`);
  }
  positive(input.runtimeControlGeneration, "tenant backup catalog runtime control generation");
  return sha256([
    "tenant-backup-catalog-runtime-binding-v1",
    ...keys.map((key) => input[key]),
  ]);
}

export type ExactReplay<T> = {
  disposition: "created" | "exact_replay";
  value: T;
};

export class TenantBackupCatalogConflictError extends Error {
  constructor(message = "tenant backup catalog operation conflicts with durable state") {
    super(message);
    this.name = "TenantBackupCatalogConflictError";
  }
}

export class TenantBackupCatalogIntegrityError extends Error {
  constructor(message = "tenant backup catalog evidence is invalid") {
    super(message);
    this.name = "TenantBackupCatalogIntegrityError";
  }
}

export class TenantBackupCatalogNotReadyError extends Error {
  constructor(public readonly reason: string) {
    super(`tenant backup catalog is not ready: ${reason}`);
    this.name = "TenantBackupCatalogNotReadyError";
  }
}

export interface InactiveTenantBackupCatalogControlRecord {
  singletonId: typeof TENANT_BACKUP_CATALOG_CONTROL_SINGLETON_ID;
  state: "inactive";
  controlGeneration: 0;
}

export interface ActiveTenantBackupCatalogControlRecord {
  singletonId: typeof TENANT_BACKUP_CATALOG_CONTROL_SINGLETON_ID;
  state: "active";
  controlGeneration: 1;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  journalControlEvidenceSha256: string;
  retentionPolicySha256: string;
  minimumRetentionMs: number;
  minimumRecoverableBackups: number;
  activatedAtDbMs: number;
  evidenceSha256: string;
}

export type TenantBackupCatalogControlRecord =
  | InactiveTenantBackupCatalogControlRecord
  | ActiveTenantBackupCatalogControlRecord;

export interface ActivateTenantBackupCatalogControlInput {
  expectedControlGeneration: 0;
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  journalControlEvidenceSha256: string;
  retentionPolicySha256: string;
  minimumRetentionMs: number;
  minimumRecoverableBackups: number;
}

const ACTIVE_CONTROL_BODY_KEYS = [
  "singletonId",
  "state",
  "controlGeneration",
  "protocol",
  "adapterProtocol",
  "catalogNamespaceSha256",
  "catalogTargetSha256",
  "failureDomainSha256",
  "logicalDatabaseNamespaceSha256",
  "journalControlEvidenceSha256",
  "retentionPolicySha256",
  "minimumRetentionMs",
  "minimumRecoverableBackups",
  "activatedAtDbMs",
] as const;

export function tenantBackupCatalogControlEvidenceSha256(
  control: Omit<ActiveTenantBackupCatalogControlRecord, "evidenceSha256">,
): string {
  exactKeys(control, ACTIVE_CONTROL_BODY_KEYS, "tenant backup catalog control evidence");
  if (control.singletonId !== TENANT_BACKUP_CATALOG_CONTROL_SINGLETON_ID
    || control.state !== "active"
    || control.controlGeneration !== 1
    || control.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup catalog control protocol is invalid");
  }
  identifier(control.adapterProtocol, "tenant backup catalog adapter protocol");
  for (const [value, name] of [
    [control.catalogNamespaceSha256, "catalog namespace"],
    [control.catalogTargetSha256, "catalog target"],
    [control.failureDomainSha256, "failure domain"],
    [control.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [control.journalControlEvidenceSha256, "journal control evidence"],
    [control.retentionPolicySha256, "retention policy"],
  ] as const) digest(value, `tenant backup catalog ${name}`);
  timestamp(control.minimumRetentionMs, "tenant backup catalog minimum retention");
  positive(control.minimumRecoverableBackups, "tenant backup catalog minimum recoverable backups");
  timestamp(control.activatedAtDbMs, "tenant backup catalog activation time");
  return sha256([
    "tenant-backup-catalog-control-evidence-v1",
    ...ACTIVE_CONTROL_BODY_KEYS.map((key) => control[key]),
  ]);
}

export function validateTenantBackupCatalogControlRecord(
  control: TenantBackupCatalogControlRecord,
): void {
  try {
    if (!control || control.singletonId !== TENANT_BACKUP_CATALOG_CONTROL_SINGLETON_ID) {
      throw new Error("invalid singleton");
    }
    if (control.state === "inactive") {
      exactKeys(control, ["singletonId", "state", "controlGeneration"],
        "inactive tenant backup catalog control");
      if (control.controlGeneration !== 0) throw new Error("invalid inactive generation");
      return;
    }
    exactKeys(control, [...ACTIVE_CONTROL_BODY_KEYS, "evidenceSha256"],
      "active tenant backup catalog control");
    digest(control.evidenceSha256, "tenant backup catalog control evidence");
    const { evidenceSha256, ...body } = control;
    if (evidenceSha256 !== tenantBackupCatalogControlEvidenceSha256(body)) {
      throw new Error("control evidence mismatch");
    }
  } catch {
    throw new TenantBackupCatalogIntegrityError();
  }
}

export function validateActivateTenantBackupCatalogControlInput(
  input: ActivateTenantBackupCatalogControlInput,
): void {
  exactKeys(input, [
    "expectedControlGeneration",
    "adapterProtocol",
    "catalogNamespaceSha256",
    "catalogTargetSha256",
    "failureDomainSha256",
    "logicalDatabaseNamespaceSha256",
    "journalControlEvidenceSha256",
    "retentionPolicySha256",
    "minimumRetentionMs",
    "minimumRecoverableBackups",
  ], "tenant backup catalog activation input");
  if (input.expectedControlGeneration !== 0) throw new Error("invalid expected control generation");
  identifier(input.adapterProtocol, "tenant backup catalog adapter protocol");
  for (const [value, name] of [
    [input.catalogNamespaceSha256, "catalog namespace"],
    [input.catalogTargetSha256, "catalog target"],
    [input.failureDomainSha256, "failure domain"],
    [input.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [input.journalControlEvidenceSha256, "journal control evidence"],
    [input.retentionPolicySha256, "retention policy"],
  ] as const) digest(value, `tenant backup catalog ${name}`);
  timestamp(input.minimumRetentionMs, "tenant backup catalog minimum retention");
  positive(input.minimumRecoverableBackups, "tenant backup catalog minimum recoverable backups");
}

export interface TenantBackupSnapshotAnchor {
  scope: typeof TENANT_BACKUP_SNAPSHOT_ANCHOR_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  backupKind: "full";
  backupId: string;
  controlEvidenceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  journalControlEvidenceSha256: string;
  sourceRuntimeEpochSha256: string;
  sourceRuntimeControlGeneration: number;
  sourceRuntimeControlEvidenceSha256: string;
  sourceRuntimeTargetCount: number;
  sourceRuntimeHeads: TenantRestoreReplaySealedTarget[];
  sourceRuntimeHeadRootSha256: string;
  schemaMigrationRootSha256: string;
  blobStorageControlEvidenceSha256: string;
  sourceCatalogSequence: number;
  sourceCatalogEventRootSha256: string;
  retentionUntilDbMs: number;
  createdAtDbMs: number;
  anchorSha256: string;
}

export interface CreateTenantBackupSnapshotAnchorInput {
  backupId: string;
  controlEvidenceSha256: string;
}

const ANCHOR_BODY_KEYS = [
  "scope",
  "protocol",
  "backupKind",
  "backupId",
  "controlEvidenceSha256",
  "logicalDatabaseNamespaceSha256",
  "journalControlEvidenceSha256",
  "sourceRuntimeEpochSha256",
  "sourceRuntimeControlGeneration",
  "sourceRuntimeControlEvidenceSha256",
  "sourceRuntimeTargetCount",
  "sourceRuntimeHeads",
  "sourceRuntimeHeadRootSha256",
  "schemaMigrationRootSha256",
  "blobStorageControlEvidenceSha256",
  "sourceCatalogSequence",
  "sourceCatalogEventRootSha256",
  "retentionUntilDbMs",
  "createdAtDbMs",
] as const;

export function tenantBackupSnapshotAnchorSha256(
  anchor: Omit<TenantBackupSnapshotAnchor, "anchorSha256">,
): string {
  exactKeys(anchor, ANCHOR_BODY_KEYS, "tenant backup snapshot anchor");
  if (anchor.scope !== TENANT_BACKUP_SNAPSHOT_ANCHOR_SCOPE
    || anchor.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL
    || anchor.backupKind !== "full") {
    throw new Error("tenant backup snapshot anchor protocol is invalid");
  }
  backupId(anchor.backupId);
  for (const [value, name] of [
    [anchor.controlEvidenceSha256, "control evidence"],
    [anchor.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [anchor.journalControlEvidenceSha256, "journal control evidence"],
    [anchor.sourceRuntimeEpochSha256, "source runtime epoch"],
    [anchor.sourceRuntimeControlEvidenceSha256, "source runtime control evidence"],
    [anchor.sourceRuntimeHeadRootSha256, "source runtime head root"],
    [anchor.schemaMigrationRootSha256, "schema migration root"],
    [anchor.blobStorageControlEvidenceSha256, "blob storage control evidence"],
    [anchor.sourceCatalogEventRootSha256, "source catalog event root"],
  ] as const) digest(value, `tenant backup snapshot anchor ${name}`);
  positive(anchor.sourceRuntimeControlGeneration, "source runtime control generation");
  positive(anchor.sourceRuntimeTargetCount, "source runtime target count");
  timestamp(anchor.sourceCatalogSequence, "source tenant backup catalog sequence");
  if (anchor.sourceCatalogSequence === 0
    && anchor.sourceCatalogEventRootSha256
      !== EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256) {
    throw new Error("empty source tenant backup catalog root does not match");
  }
  if (!Array.isArray(anchor.sourceRuntimeHeads)
    || anchor.sourceRuntimeHeads.length !== anchor.sourceRuntimeTargetCount) {
    throw new Error("tenant backup source runtime head catalog is incomplete");
  }
  for (const head of anchor.sourceRuntimeHeads) validateTenantRestoreReplaySealedTarget(head);
  if (tenantRestoreReplaySealedTargetRootSha256(anchor.sourceRuntimeHeads)
    !== anchor.sourceRuntimeHeadRootSha256) {
    throw new Error("tenant backup source runtime head root does not match its catalog");
  }
  timestamp(anchor.retentionUntilDbMs, "tenant backup retention deadline");
  timestamp(anchor.createdAtDbMs, "tenant backup anchor creation time");
  if (anchor.retentionUntilDbMs < anchor.createdAtDbMs) {
    throw new Error("tenant backup retention deadline precedes its anchor");
  }
  return sha256([
    "tenant-backup-snapshot-anchor-v1",
    ...ANCHOR_BODY_KEYS.map((key) => key === "sourceRuntimeHeads"
      ? anchor.sourceRuntimeHeads.map((head) => [
        head.targetOrdinal,
        head.targetSha256,
        head.failureDomainSha256,
        head.adapterProtocol,
        head.journalNamespaceSha256,
        head.logicalDatabaseNamespaceSha256,
        head.sealedRemoteSequence,
        head.sealedHeadRootSha256,
      ])
      : anchor[key]),
  ]);
}

export function validateTenantBackupSnapshotAnchor(anchor: TenantBackupSnapshotAnchor): void {
  exactKeys(anchor, [...ANCHOR_BODY_KEYS, "anchorSha256"], "tenant backup snapshot anchor");
  digest(anchor.anchorSha256, "tenant backup snapshot anchor digest");
  const { anchorSha256, ...body } = anchor;
  if (anchorSha256 !== tenantBackupSnapshotAnchorSha256(body)) {
    throw new Error("tenant backup snapshot anchor digest does not match");
  }
}

export function validateCreateTenantBackupSnapshotAnchorInput(
  input: CreateTenantBackupSnapshotAnchorInput,
): void {
  exactKeys(input, [
    "backupId",
    "controlEvidenceSha256",
  ], "tenant backup snapshot anchor input");
  backupId(input.backupId);
  digest(input.controlEvidenceSha256, "tenant backup snapshot anchor input control evidence");
}

export interface TenantBackupCatalogEventProof {
  catalogSequence: number;
  previousCatalogEventRootSha256: string;
  catalogEventRootSha256: string;
  catalogEventSha256: string;
}

export const EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256 = sha256([
  "tenant-backup-catalog-event-root-v1",
]);

export function tenantBackupCatalogEventSha256(input: {
  eventType: "backup_recoverable" | "restore_reserved" | "restore_resolved" | "backup_evicted";
  operationSha256: string;
  receiptSha256: string;
}): string {
  exactKeys(input, ["eventType", "operationSha256", "receiptSha256"],
    "tenant backup catalog event");
  if (!["backup_recoverable", "restore_reserved", "restore_resolved", "backup_evicted"]
    .includes(input.eventType)) throw new Error("invalid tenant backup catalog event type");
  digest(input.operationSha256, "tenant backup catalog event operation");
  digest(input.receiptSha256, "tenant backup catalog event receipt");
  return sha256([
    "tenant-backup-catalog-event-v1",
    input.eventType,
    input.operationSha256,
    input.receiptSha256,
  ]);
}

export function tenantBackupCatalogNextEventRootSha256(input: {
  previousCatalogEventRootSha256: string;
  catalogSequence: number;
  catalogEventSha256: string;
}): string {
  exactKeys(input, [
    "previousCatalogEventRootSha256",
    "catalogSequence",
    "catalogEventSha256",
  ], "tenant backup catalog event link");
  digest(input.previousCatalogEventRootSha256, "previous tenant backup catalog event root");
  positive(input.catalogSequence, "tenant backup catalog sequence");
  digest(input.catalogEventSha256, "tenant backup catalog event digest");
  return sha256([
    "tenant-backup-catalog-event-root-v1",
    input.previousCatalogEventRootSha256,
    input.catalogSequence,
    input.catalogEventSha256,
  ]);
}

export function validateTenantBackupCatalogEventProof(
  proof: TenantBackupCatalogEventProof,
  expectedEventSha256?: string,
): void {
  exactKeys(proof, [
    "catalogSequence",
    "previousCatalogEventRootSha256",
    "catalogEventRootSha256",
    "catalogEventSha256",
  ], "tenant backup catalog event proof");
  positive(proof.catalogSequence, "tenant backup catalog sequence");
  digest(proof.previousCatalogEventRootSha256, "previous tenant backup catalog event root");
  digest(proof.catalogEventRootSha256, "tenant backup catalog event root");
  digest(proof.catalogEventSha256, "tenant backup catalog event digest");
  if (expectedEventSha256 !== undefined && proof.catalogEventSha256 !== expectedEventSha256) {
    throw new Error("tenant backup catalog event digest does not match its operation");
  }
  if (proof.catalogEventRootSha256 !== tenantBackupCatalogNextEventRootSha256({
    previousCatalogEventRootSha256: proof.previousCatalogEventRootSha256,
    catalogSequence: proof.catalogSequence,
    catalogEventSha256: proof.catalogEventSha256,
  })) {
    throw new Error("tenant backup catalog event root does not match");
  }
}

export interface TenantBackupAvailabilityAdapterResult extends TenantBackupCatalogEventProof {
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
  controlEvidenceSha256: string;
  logicalDatabaseNamespaceSha256: string;
  retentionPolicySha256: string;
  retentionUntilDbMs: number;
  registeredAtDbMs: number;
  backupId: string;
  anchorSha256: string;
  sourceSnapshotSha256: string;
  sourceBackupSha256: string;
  artifactManifestSha256: string;
  providerEvidenceSha256: string;
  availabilityOperationSha256: string;
  availabilityReceiptSha256: string;
  entrySha256: string;
}

export interface TenantBackupCatalogEntry extends TenantBackupAvailabilityAdapterResult {
  scope: typeof TENANT_BACKUP_CATALOG_ENTRY_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
}

export interface TenantBackupAvailabilityDescriptor {
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
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
}

export function tenantBackupAvailabilityOperationSha256(
  input: TenantBackupAvailabilityDescriptor,
): string {
  exactKeys(input, [
    "backupId",
    "anchorSha256",
    "sourceSnapshotSha256",
    "sourceBackupSha256",
    "artifactManifestSha256",
    "providerEvidenceSha256",
    "controlEvidenceSha256",
    "logicalDatabaseNamespaceSha256",
    "retentionPolicySha256",
    "retentionUntilDbMs",
    "registeredAtDbMs",
    "catalogNamespaceSha256",
    "catalogTargetSha256",
  ], "tenant backup availability operation");
  backupId(input.backupId);
  for (const [value, name] of [
    [input.anchorSha256, "anchor"],
    [input.sourceSnapshotSha256, "source snapshot"],
    [input.sourceBackupSha256, "source backup"],
    [input.artifactManifestSha256, "artifact manifest"],
    [input.providerEvidenceSha256, "provider evidence"],
    [input.controlEvidenceSha256, "control evidence"],
    [input.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [input.retentionPolicySha256, "retention policy"],
    [input.catalogNamespaceSha256, "catalog namespace"],
    [input.catalogTargetSha256, "catalog target"],
  ] as const) digest(value, `tenant backup availability ${name}`);
  timestamp(input.retentionUntilDbMs, "tenant backup availability retention deadline");
  timestamp(input.registeredAtDbMs, "tenant backup availability registration time");
  if (input.retentionUntilDbMs < input.registeredAtDbMs) {
    throw new Error("tenant backup availability retention deadline precedes registration");
  }
  return sha256([
    "tenant-backup-availability-operation-v1",
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
    input.catalogNamespaceSha256,
    input.catalogTargetSha256,
  ]);
}

function validateTenantBackupAvailabilityAdapterEvidence(
  result: Omit<TenantBackupAvailabilityAdapterResult, "entrySha256">,
): void {
  exactKeys(result, [
    "adapterProtocol",
    "catalogNamespaceSha256",
    "catalogTargetSha256",
    "failureDomainSha256",
    "controlEvidenceSha256",
    "logicalDatabaseNamespaceSha256",
    "retentionPolicySha256",
    "retentionUntilDbMs",
    "registeredAtDbMs",
    "backupId",
    "anchorSha256",
    "sourceSnapshotSha256",
    "sourceBackupSha256",
    "artifactManifestSha256",
    "providerEvidenceSha256",
    "availabilityOperationSha256",
    "availabilityReceiptSha256",
    "catalogSequence",
    "previousCatalogEventRootSha256",
    "catalogEventRootSha256",
    "catalogEventSha256",
  ], "tenant backup availability adapter result");
  identifier(result.adapterProtocol, "tenant backup availability adapter protocol");
  backupId(result.backupId);
  for (const [value, name] of [
    [result.catalogNamespaceSha256, "catalog namespace"],
    [result.catalogTargetSha256, "catalog target"],
    [result.failureDomainSha256, "failure domain"],
    [result.controlEvidenceSha256, "control evidence"],
    [result.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [result.retentionPolicySha256, "retention policy"],
    [result.anchorSha256, "anchor"],
    [result.sourceSnapshotSha256, "source snapshot"],
    [result.sourceBackupSha256, "source backup"],
    [result.artifactManifestSha256, "artifact manifest"],
    [result.providerEvidenceSha256, "provider evidence"],
    [result.availabilityOperationSha256, "operation"],
    [result.availabilityReceiptSha256, "receipt"],
  ] as const) digest(value, `tenant backup availability ${name}`);
  const expectedOperation = tenantBackupAvailabilityOperationSha256({
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
    catalogNamespaceSha256: result.catalogNamespaceSha256,
    catalogTargetSha256: result.catalogTargetSha256,
  });
  if (result.availabilityOperationSha256 !== expectedOperation) {
    throw new Error("tenant backup availability operation does not match");
  }
  validateTenantBackupCatalogEventProof({
    catalogSequence: result.catalogSequence,
    previousCatalogEventRootSha256: result.previousCatalogEventRootSha256,
    catalogEventRootSha256: result.catalogEventRootSha256,
    catalogEventSha256: result.catalogEventSha256,
  }, tenantBackupCatalogEventSha256({
    eventType: "backup_recoverable",
    operationSha256: result.availabilityOperationSha256,
    receiptSha256: result.availabilityReceiptSha256,
  }));
}

export function validateTenantBackupAvailabilityAdapterResult(
  result: TenantBackupAvailabilityAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol", "catalogNamespaceSha256", "catalogTargetSha256",
    "failureDomainSha256", "controlEvidenceSha256", "logicalDatabaseNamespaceSha256",
    "retentionPolicySha256", "retentionUntilDbMs", "registeredAtDbMs", "backupId",
    "anchorSha256", "sourceSnapshotSha256", "sourceBackupSha256",
    "artifactManifestSha256", "providerEvidenceSha256", "availabilityOperationSha256",
    "availabilityReceiptSha256", "catalogSequence", "previousCatalogEventRootSha256",
    "catalogEventRootSha256", "catalogEventSha256", "entrySha256",
  ], "tenant backup availability adapter result");
  digest(result.entrySha256, "tenant backup availability entry");
  const { entrySha256, ...evidence } = result;
  validateTenantBackupAvailabilityAdapterEvidence(evidence);
  if (entrySha256 !== tenantBackupCatalogEntrySha256({
    scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
    protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
    ...evidence,
  })) throw new Error("tenant backup availability entry digest does not match");
}

const ENTRY_BODY_KEYS = [
  "scope",
  "protocol",
  "controlEvidenceSha256",
  "logicalDatabaseNamespaceSha256",
  "retentionPolicySha256",
  "retentionUntilDbMs",
  "registeredAtDbMs",
  "adapterProtocol",
  "catalogNamespaceSha256",
  "catalogTargetSha256",
  "failureDomainSha256",
  "backupId",
  "anchorSha256",
  "sourceSnapshotSha256",
  "sourceBackupSha256",
  "artifactManifestSha256",
  "providerEvidenceSha256",
  "availabilityOperationSha256",
  "availabilityReceiptSha256",
  "catalogSequence",
  "previousCatalogEventRootSha256",
  "catalogEventRootSha256",
  "catalogEventSha256",
] as const;

export function tenantBackupCatalogEntrySha256(
  entry: Omit<TenantBackupCatalogEntry, "entrySha256">,
): string {
  exactKeys(entry, ENTRY_BODY_KEYS, "tenant backup catalog entry");
  if (entry.scope !== TENANT_BACKUP_CATALOG_ENTRY_SCOPE
    || entry.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup catalog entry protocol is invalid");
  }
  validateTenantBackupAvailabilityAdapterEvidence({
    adapterProtocol: entry.adapterProtocol,
    catalogNamespaceSha256: entry.catalogNamespaceSha256,
    catalogTargetSha256: entry.catalogTargetSha256,
    failureDomainSha256: entry.failureDomainSha256,
    controlEvidenceSha256: entry.controlEvidenceSha256,
    logicalDatabaseNamespaceSha256: entry.logicalDatabaseNamespaceSha256,
    retentionPolicySha256: entry.retentionPolicySha256,
    retentionUntilDbMs: entry.retentionUntilDbMs,
    registeredAtDbMs: entry.registeredAtDbMs,
    backupId: entry.backupId,
    anchorSha256: entry.anchorSha256,
    sourceSnapshotSha256: entry.sourceSnapshotSha256,
    sourceBackupSha256: entry.sourceBackupSha256,
    artifactManifestSha256: entry.artifactManifestSha256,
    providerEvidenceSha256: entry.providerEvidenceSha256,
    availabilityOperationSha256: entry.availabilityOperationSha256,
    availabilityReceiptSha256: entry.availabilityReceiptSha256,
    catalogSequence: entry.catalogSequence,
    previousCatalogEventRootSha256: entry.previousCatalogEventRootSha256,
    catalogEventRootSha256: entry.catalogEventRootSha256,
    catalogEventSha256: entry.catalogEventSha256,
  });
  for (const [value, name] of [
    [entry.controlEvidenceSha256, "control evidence"],
    [entry.logicalDatabaseNamespaceSha256, "logical database namespace"],
    [entry.retentionPolicySha256, "retention policy"],
  ] as const) digest(value, `tenant backup catalog entry ${name}`);
  timestamp(entry.retentionUntilDbMs, "tenant backup catalog entry retention deadline");
  timestamp(entry.registeredAtDbMs, "tenant backup catalog entry registration time");
  return sha256([
    "tenant-backup-catalog-entry-v1",
    ...ENTRY_BODY_KEYS.map((key) => entry[key]),
  ]);
}

export function validateTenantBackupCatalogEntry(entry: TenantBackupCatalogEntry): void {
  exactKeys(entry, [...ENTRY_BODY_KEYS, "entrySha256"], "tenant backup catalog entry");
  digest(entry.entrySha256, "tenant backup catalog entry digest");
  const { entrySha256, ...body } = entry;
  if (entrySha256 !== tenantBackupCatalogEntrySha256(body)) {
    throw new Error("tenant backup catalog entry digest does not match");
  }
}

export function tenantBackupAvailabilityResultFromEntry(
  entry: TenantBackupCatalogEntry,
): TenantBackupAvailabilityAdapterResult {
  validateTenantBackupCatalogEntry(entry);
  const { scope: _scope, protocol: _protocol, ...result } = entry;
  validateTenantBackupAvailabilityAdapterResult(result);
  return result;
}

export interface TenantBackupRuntimeReservationAdapterResult
  extends TenantBackupCatalogEventProof {
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  backupId: string;
  restoreRunId: string;
  entrySha256: string;
  runtimeEpochSha256: string;
  reservationOperationSha256: string;
  reservationReceiptSha256: string;
}

export interface TenantBackupRestoreSourceBinding {
  scope: typeof TENANT_BACKUP_RESTORE_BINDING_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  restoreRunId: string;
  backupId: string;
  anchorSha256: string;
  entrySha256: string;
  sourceSnapshotSha256: string;
  sourceBackupSha256: string;
  artifactManifestSha256: string;
  providerEvidenceSha256: string;
  controlEvidenceSha256: string;
  journalControlEvidenceSha256: string;
  sealedTargetRootSha256: string;
  runtimeEpochSha256: string;
  reservationReceiptSha256: string;
  selectedCatalogSequence: number;
  selectedCatalogEventRootSha256: string;
  boundAtDbMs: number;
  bindingSha256: string;
}

interface TenantBackupRuntimeReservationBase extends TenantBackupCatalogEventProof {
  scope: typeof TENANT_BACKUP_RUNTIME_RESERVATION_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  restoreRunId: string;
  backupId: string;
  entrySha256: string;
  bindingSha256: string;
  runtimeEpochSha256: string;
  reservationOperationSha256: string;
  reservationReceiptSha256: string;
  reservedAtDbMs: number;
  reservationSha256: string;
}

export type TenantBackupRuntimeReservation = TenantBackupRuntimeReservationBase & (
  | { phase: "reserved" }
  | {
    phase: "activated" | "aborted";
    resolutionOperationSha256: string;
    resolutionReceiptSha256: string;
    resolutionCatalogSequence: number;
    resolutionPreviousCatalogEventRootSha256: string;
    resolutionCatalogEventRootSha256: string;
    resolutionCatalogEventSha256: string;
    resolvedAtDbMs: number;
  }
);

export interface PrepareTenantRestoreReplayFromBackupInput {
  backupId: string;
  restoreRunId: string;
  runtimeEpochSha256: string;
  controlEvidenceSha256: string;
  sealedTargets: TenantRestoreReplaySealedTarget[];
  reservation: TenantBackupRuntimeReservationAdapterResult;
}

export interface PreflightTenantRestoreReplayFromBackupInput {
  backupId: string;
  restoreRunId: string;
  runtimeEpochSha256: string;
}

export function validatePreflightTenantRestoreReplayFromBackupInput(
  input: PreflightTenantRestoreReplayFromBackupInput,
): void {
  exactKeys(input, ["backupId", "restoreRunId", "runtimeEpochSha256"],
    "tenant backup restore preflight input");
  backupId(input.backupId);
  restoreRunId(input.restoreRunId);
  digest(input.runtimeEpochSha256, "tenant backup restore preflight epoch");
}

export interface PrepareTenantRestoreReplayFromBackupValue {
  binding: TenantBackupRestoreSourceBinding;
  reservation: TenantBackupRuntimeReservation;
  replayRun: TenantRestoreReplayRunRecord;
}

export interface ResolveTenantBackupRuntimeReservationInput extends TenantBackupCatalogEventProof {
  restoreRunId: string;
  reservationReceiptSha256: string;
  phase: "activated" | "aborted";
  resolutionOperationSha256: string;
  resolutionReceiptSha256: string;
}

export function tenantBackupRuntimeReservationOperationSha256(input: {
  backupId: string;
  restoreRunId: string;
  entrySha256: string;
  runtimeEpochSha256: string;
}): string {
  exactKeys(input, ["backupId", "restoreRunId", "entrySha256", "runtimeEpochSha256"],
    "tenant backup runtime reservation operation");
  backupId(input.backupId);
  restoreRunId(input.restoreRunId);
  digest(input.entrySha256, "tenant backup runtime reservation entry");
  digest(input.runtimeEpochSha256, "tenant backup runtime reservation epoch");
  return sha256([
    "tenant-backup-runtime-reservation-operation-v1",
    input.backupId,
    input.restoreRunId,
    input.entrySha256,
    input.runtimeEpochSha256,
  ]);
}

export function tenantBackupRestoreSourceBindingSha256(
  binding: Omit<TenantBackupRestoreSourceBinding, "bindingSha256">,
): string {
  const keys = [
    "scope", "protocol", "restoreRunId", "backupId", "anchorSha256", "entrySha256",
    "sourceSnapshotSha256", "sourceBackupSha256", "artifactManifestSha256",
    "providerEvidenceSha256", "controlEvidenceSha256",
    "journalControlEvidenceSha256", "sealedTargetRootSha256", "runtimeEpochSha256",
    "reservationReceiptSha256", "selectedCatalogSequence", "selectedCatalogEventRootSha256",
    "boundAtDbMs",
  ] as const;
  exactKeys(binding, keys, "tenant backup restore source binding");
  if (binding.scope !== TENANT_BACKUP_RESTORE_BINDING_SCOPE
    || binding.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup restore source binding protocol is invalid");
  }
  backupId(binding.backupId);
  restoreRunId(binding.restoreRunId);
  for (const [value, name] of [
    [binding.anchorSha256, "anchor"], [binding.entrySha256, "entry"],
    [binding.sourceSnapshotSha256, "source snapshot"],
    [binding.sourceBackupSha256, "source backup"],
    [binding.artifactManifestSha256, "artifact manifest"],
    [binding.providerEvidenceSha256, "provider evidence"],
    [binding.controlEvidenceSha256, "catalog control evidence"],
    [binding.journalControlEvidenceSha256, "journal control evidence"],
    [binding.sealedTargetRootSha256, "sealed target root"],
    [binding.runtimeEpochSha256, "runtime epoch"],
    [binding.reservationReceiptSha256, "reservation receipt"],
    [binding.selectedCatalogEventRootSha256, "selected catalog event root"],
  ] as const) digest(value, `tenant backup restore source binding ${name}`);
  positive(binding.selectedCatalogSequence, "selected tenant backup catalog sequence");
  timestamp(binding.boundAtDbMs, "tenant backup restore binding time");
  return sha256(["tenant-backup-restore-source-binding-v1", ...keys.map((key) => binding[key])]);
}

export function validateTenantBackupRestoreSourceBinding(
  binding: TenantBackupRestoreSourceBinding,
): void {
  digest(binding.bindingSha256, "tenant backup restore source binding digest");
  const { bindingSha256, ...body } = binding;
  if (bindingSha256 !== tenantBackupRestoreSourceBindingSha256(body)) {
    throw new Error("tenant backup restore source binding digest does not match");
  }
}

export function tenantBackupRuntimeReservationSha256(
  reservation: Omit<TenantBackupRuntimeReservationBase, "reservationSha256">,
): string {
  const keys = [
    "scope", "protocol", "restoreRunId", "backupId", "entrySha256", "bindingSha256",
    "runtimeEpochSha256", "reservationOperationSha256", "reservationReceiptSha256",
    "catalogSequence", "previousCatalogEventRootSha256", "catalogEventRootSha256",
    "catalogEventSha256", "reservedAtDbMs",
  ] as const;
  exactKeys(reservation, keys, "tenant backup runtime reservation");
  if (reservation.scope !== TENANT_BACKUP_RUNTIME_RESERVATION_SCOPE
    || reservation.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup runtime reservation protocol is invalid");
  }
  backupId(reservation.backupId);
  restoreRunId(reservation.restoreRunId);
  for (const [value, name] of [
    [reservation.entrySha256, "entry"], [reservation.bindingSha256, "binding"],
    [reservation.runtimeEpochSha256, "runtime epoch"],
    [reservation.reservationOperationSha256, "operation"],
    [reservation.reservationReceiptSha256, "receipt"],
  ] as const) digest(value, `tenant backup runtime reservation ${name}`);
  validateTenantBackupCatalogEventProof({
    catalogSequence: reservation.catalogSequence,
    previousCatalogEventRootSha256: reservation.previousCatalogEventRootSha256,
    catalogEventRootSha256: reservation.catalogEventRootSha256,
    catalogEventSha256: reservation.catalogEventSha256,
  }, tenantBackupCatalogEventSha256({
    eventType: "restore_reserved",
    operationSha256: reservation.reservationOperationSha256,
    receiptSha256: reservation.reservationReceiptSha256,
  }));
  timestamp(reservation.reservedAtDbMs, "tenant backup runtime reservation time");
  return sha256(["tenant-backup-runtime-reservation-v1", ...keys.map((key) => reservation[key])]);
}

export function validateTenantBackupRuntimeReservation(
  reservation: TenantBackupRuntimeReservation,
): void {
  const terminalKeys = [
    "resolutionOperationSha256", "resolutionReceiptSha256", "resolutionCatalogSequence",
    "resolutionPreviousCatalogEventRootSha256", "resolutionCatalogEventRootSha256",
    "resolutionCatalogEventSha256", "resolvedAtDbMs",
  ] as const;
  const base = { ...reservation } as Record<string, unknown>;
  const phase = base.phase;
  delete base.phase;
  for (const key of terminalKeys) delete base[key];
  const reservationSha256 = base.reservationSha256;
  delete base.reservationSha256;
  digest(reservationSha256, "tenant backup runtime reservation digest");
  if (reservationSha256 !== tenantBackupRuntimeReservationSha256(
    base as unknown as Omit<TenantBackupRuntimeReservationBase, "reservationSha256">,
  )) throw new Error("tenant backup runtime reservation digest does not match");
  if (phase === "reserved") {
    exactKeys(reservation, [...Object.keys(base), "reservationSha256", "phase"],
      "reserved tenant backup runtime reservation");
    return;
  }
  if (phase !== "activated" && phase !== "aborted") {
    throw new Error("invalid tenant backup runtime reservation phase");
  }
  const resolved = reservation as Extract<
    TenantBackupRuntimeReservation,
    { phase: "activated" | "aborted" }
  >;
  exactKeys(reservation, [
    ...Object.keys(base), "reservationSha256", "phase", ...terminalKeys,
  ], "resolved tenant backup runtime reservation");
  digest(resolved.resolutionOperationSha256, "tenant backup reservation resolution operation");
  digest(resolved.resolutionReceiptSha256, "tenant backup reservation resolution receipt");
  if (resolved.resolutionOperationSha256
    !== tenantBackupReservationResolutionOperationSha256({
      restoreRunId: resolved.restoreRunId,
      reservationReceiptSha256: resolved.reservationReceiptSha256,
      phase: resolved.phase,
    })) {
    throw new Error("tenant backup reservation resolution operation does not match");
  }
  validateTenantBackupCatalogEventProof({
    catalogSequence: resolved.resolutionCatalogSequence,
    previousCatalogEventRootSha256: resolved.resolutionPreviousCatalogEventRootSha256,
    catalogEventRootSha256: resolved.resolutionCatalogEventRootSha256,
    catalogEventSha256: resolved.resolutionCatalogEventSha256,
  }, tenantBackupCatalogEventSha256({
    eventType: "restore_resolved",
    operationSha256: resolved.resolutionOperationSha256,
    receiptSha256: resolved.resolutionReceiptSha256,
  }));
  timestamp(resolved.resolvedAtDbMs, "tenant backup reservation resolution time");
  if (resolved.resolvedAtDbMs < resolved.reservedAtDbMs) {
    throw new Error("tenant backup reservation resolved before it was created");
  }
}

export function validateTenantBackupRuntimeReservationAdapterResult(
  result: TenantBackupRuntimeReservationAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol", "catalogNamespaceSha256", "catalogTargetSha256", "backupId",
    "restoreRunId", "entrySha256", "runtimeEpochSha256", "reservationOperationSha256",
    "reservationReceiptSha256", "catalogSequence", "previousCatalogEventRootSha256",
    "catalogEventRootSha256", "catalogEventSha256",
  ], "tenant backup runtime reservation adapter result");
  identifier(result.adapterProtocol, "tenant backup reservation adapter protocol");
  digest(result.catalogNamespaceSha256, "tenant backup reservation catalog namespace");
  digest(result.catalogTargetSha256, "tenant backup reservation catalog target");
  backupId(result.backupId);
  restoreRunId(result.restoreRunId);
  digest(result.entrySha256, "tenant backup reservation entry");
  digest(result.runtimeEpochSha256, "tenant backup reservation runtime epoch");
  digest(result.reservationOperationSha256, "tenant backup reservation operation");
  digest(result.reservationReceiptSha256, "tenant backup reservation receipt");
  if (result.reservationOperationSha256 !== tenantBackupRuntimeReservationOperationSha256({
    backupId: result.backupId,
    restoreRunId: result.restoreRunId,
    entrySha256: result.entrySha256,
    runtimeEpochSha256: result.runtimeEpochSha256,
  })) {
    throw new Error("tenant backup runtime reservation operation does not match");
  }
  validateTenantBackupCatalogEventProof({
    catalogSequence: result.catalogSequence,
    previousCatalogEventRootSha256: result.previousCatalogEventRootSha256,
    catalogEventRootSha256: result.catalogEventRootSha256,
    catalogEventSha256: result.catalogEventSha256,
  }, tenantBackupCatalogEventSha256({
    eventType: "restore_reserved",
    operationSha256: result.reservationOperationSha256,
    receiptSha256: result.reservationReceiptSha256,
  }));
}

export function tenantBackupReservationResolutionOperationSha256(input: {
  restoreRunId: string;
  reservationReceiptSha256: string;
  phase: "activated" | "aborted";
}): string {
  exactKeys(input, ["restoreRunId", "reservationReceiptSha256", "phase"],
    "tenant backup reservation resolution operation");
  restoreRunId(input.restoreRunId);
  digest(input.reservationReceiptSha256, "tenant backup reservation resolution source");
  if (input.phase !== "activated" && input.phase !== "aborted") {
    throw new Error("invalid tenant backup reservation resolution phase");
  }
  return sha256([
    "tenant-backup-reservation-resolution-operation-v1",
    input.restoreRunId,
    input.reservationReceiptSha256,
    input.phase,
  ]);
}

export interface PrepareTenantBackupEvictionInput {
  evictionId: string;
  backupId: string;
}

export interface TenantBackupEvictionPlan {
  evictionId: string;
  backupId: string;
  anchorSha256: string;
  entrySha256: string;
  sourceSnapshotSha256: string;
  sourceBackupSha256: string;
  artifactManifestSha256: string;
  providerEvidenceSha256: string;
  controlEvidenceSha256: string;
  retentionPolicySha256: string;
  retentionUntilDbMs: number;
  expectedCatalogSequence: number;
  expectedCatalogEventRootSha256: string;
  evictionOperationSha256: string;
  planSha256: string;
}

export interface TenantBackupEvictionAdapterResult extends TenantBackupCatalogEventProof {
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  evictionId: string;
  backupId: string;
  planSha256: string;
  evictionOperationSha256: string;
  acknowledgementReceiptSha256: string;
  externalTombstoneSha256: string;
  observedAbsent: true;
}

export interface RecordTenantBackupCatalogEvictionInput {
  plan: TenantBackupEvictionPlan;
  acknowledgement: TenantBackupEvictionAdapterResult;
}

export interface TenantBackupCatalogEviction extends TenantBackupEvictionPlan,
  TenantBackupEvictionAdapterResult {
  scope: typeof TENANT_BACKUP_CATALOG_EVICTION_SCOPE;
  protocol: typeof TENANT_BACKUP_CATALOG_PROTOCOL;
  evictedAtDbMs: number;
  evictionSha256: string;
}

export function tenantBackupEvictionOperationSha256(
  plan: Omit<TenantBackupEvictionPlan, "evictionOperationSha256" | "planSha256">,
): string {
  evictionId(plan.evictionId);
  backupId(plan.backupId);
  for (const [value, name] of [
    [plan.anchorSha256, "anchor"], [plan.entrySha256, "entry"],
    [plan.sourceSnapshotSha256, "source snapshot"],
    [plan.sourceBackupSha256, "source backup"],
    [plan.artifactManifestSha256, "artifact manifest"],
    [plan.providerEvidenceSha256, "provider evidence"],
    [plan.controlEvidenceSha256, "control evidence"],
    [plan.retentionPolicySha256, "retention policy"],
    [plan.expectedCatalogEventRootSha256, "expected catalog event root"],
  ] as const) digest(value, `tenant backup eviction ${name}`);
  timestamp(plan.retentionUntilDbMs, "tenant backup eviction retention deadline");
  positive(plan.expectedCatalogSequence, "tenant backup eviction expected catalog sequence");
  return sha256([
    "tenant-backup-eviction-operation-v1",
    plan.evictionId,
    plan.backupId,
    plan.anchorSha256,
    plan.entrySha256,
    plan.sourceSnapshotSha256,
    plan.sourceBackupSha256,
    plan.artifactManifestSha256,
    plan.providerEvidenceSha256,
    plan.controlEvidenceSha256,
    plan.retentionPolicySha256,
    plan.retentionUntilDbMs,
    plan.expectedCatalogSequence,
    plan.expectedCatalogEventRootSha256,
  ]);
}

export function tenantBackupEvictionPlanSha256(
  plan: Omit<TenantBackupEvictionPlan, "planSha256">,
): string {
  const { evictionOperationSha256, ...source } = plan;
  digest(evictionOperationSha256, "tenant backup eviction operation");
  if (evictionOperationSha256 !== tenantBackupEvictionOperationSha256(source)) {
    throw new Error("tenant backup eviction operation does not match its source");
  }
  return sha256([
    "tenant-backup-eviction-plan-v1",
    plan.evictionId,
    plan.backupId,
    plan.anchorSha256,
    plan.entrySha256,
    plan.sourceSnapshotSha256,
    plan.sourceBackupSha256,
    plan.artifactManifestSha256,
    plan.providerEvidenceSha256,
    plan.controlEvidenceSha256,
    plan.retentionPolicySha256,
    plan.retentionUntilDbMs,
    plan.expectedCatalogSequence,
    plan.expectedCatalogEventRootSha256,
    plan.evictionOperationSha256,
  ]);
}

export function validateTenantBackupEvictionPlan(plan: TenantBackupEvictionPlan): void {
  exactKeys(plan, [
    "evictionId", "backupId", "anchorSha256", "entrySha256", "sourceSnapshotSha256",
    "sourceBackupSha256", "artifactManifestSha256", "providerEvidenceSha256",
    "controlEvidenceSha256", "retentionPolicySha256",
    "retentionUntilDbMs", "expectedCatalogSequence", "expectedCatalogEventRootSha256",
    "evictionOperationSha256", "planSha256",
  ], "tenant backup eviction plan");
  digest(plan.planSha256, "tenant backup eviction plan digest");
  if (plan.planSha256 !== tenantBackupEvictionPlanSha256(plan)) {
    throw new Error("tenant backup eviction plan digest does not match");
  }
}

export function validateTenantBackupEvictionAdapterResult(
  result: TenantBackupEvictionAdapterResult,
): void {
  exactKeys(result, [
    "adapterProtocol", "catalogNamespaceSha256", "catalogTargetSha256", "evictionId",
    "backupId", "planSha256", "evictionOperationSha256", "acknowledgementReceiptSha256",
    "externalTombstoneSha256", "observedAbsent", "catalogSequence",
    "previousCatalogEventRootSha256", "catalogEventRootSha256", "catalogEventSha256",
  ], "tenant backup eviction adapter result");
  identifier(result.adapterProtocol, "tenant backup eviction adapter protocol");
  evictionId(result.evictionId);
  backupId(result.backupId);
  for (const [value, name] of [
    [result.catalogNamespaceSha256, "catalog namespace"],
    [result.catalogTargetSha256, "catalog target"], [result.planSha256, "plan"],
    [result.evictionOperationSha256, "operation"],
    [result.acknowledgementReceiptSha256, "acknowledgement receipt"],
    [result.externalTombstoneSha256, "external tombstone"],
  ] as const) digest(value, `tenant backup eviction ${name}`);
  if (result.observedAbsent !== true) throw new Error("tenant backup eviction is not physical");
  validateTenantBackupCatalogEventProof({
    catalogSequence: result.catalogSequence,
    previousCatalogEventRootSha256: result.previousCatalogEventRootSha256,
    catalogEventRootSha256: result.catalogEventRootSha256,
    catalogEventSha256: result.catalogEventSha256,
  }, tenantBackupCatalogEventSha256({
    eventType: "backup_evicted",
    operationSha256: result.evictionOperationSha256,
    receiptSha256: result.acknowledgementReceiptSha256,
  }));
}

export function tenantBackupCatalogEvictionSha256(
  eviction: Omit<TenantBackupCatalogEviction, "evictionSha256">,
): string {
  if (eviction.scope !== TENANT_BACKUP_CATALOG_EVICTION_SCOPE
    || eviction.protocol !== TENANT_BACKUP_CATALOG_PROTOCOL) {
    throw new Error("tenant backup catalog eviction protocol is invalid");
  }
  validateTenantBackupEvictionPlan({
    evictionId: eviction.evictionId,
    backupId: eviction.backupId,
    anchorSha256: eviction.anchorSha256,
    entrySha256: eviction.entrySha256,
    sourceSnapshotSha256: eviction.sourceSnapshotSha256,
    sourceBackupSha256: eviction.sourceBackupSha256,
    artifactManifestSha256: eviction.artifactManifestSha256,
    providerEvidenceSha256: eviction.providerEvidenceSha256,
    controlEvidenceSha256: eviction.controlEvidenceSha256,
    retentionPolicySha256: eviction.retentionPolicySha256,
    retentionUntilDbMs: eviction.retentionUntilDbMs,
    expectedCatalogSequence: eviction.expectedCatalogSequence,
    expectedCatalogEventRootSha256: eviction.expectedCatalogEventRootSha256,
    evictionOperationSha256: eviction.evictionOperationSha256,
    planSha256: eviction.planSha256,
  });
  validateTenantBackupEvictionAdapterResult({
    adapterProtocol: eviction.adapterProtocol,
    catalogNamespaceSha256: eviction.catalogNamespaceSha256,
    catalogTargetSha256: eviction.catalogTargetSha256,
    evictionId: eviction.evictionId,
    backupId: eviction.backupId,
    planSha256: eviction.planSha256,
    evictionOperationSha256: eviction.evictionOperationSha256,
    acknowledgementReceiptSha256: eviction.acknowledgementReceiptSha256,
    externalTombstoneSha256: eviction.externalTombstoneSha256,
    observedAbsent: eviction.observedAbsent,
    catalogSequence: eviction.catalogSequence,
    previousCatalogEventRootSha256: eviction.previousCatalogEventRootSha256,
    catalogEventRootSha256: eviction.catalogEventRootSha256,
    catalogEventSha256: eviction.catalogEventSha256,
  });
  timestamp(eviction.evictedAtDbMs, "tenant backup eviction time");
  return sha256([
    "tenant-backup-catalog-eviction-v1",
    eviction.scope,
    eviction.protocol,
    eviction.planSha256,
    eviction.acknowledgementReceiptSha256,
    eviction.externalTombstoneSha256,
    eviction.catalogSequence,
    eviction.catalogEventRootSha256,
    eviction.evictedAtDbMs,
  ]);
}

export function validateTenantBackupCatalogEviction(
  eviction: TenantBackupCatalogEviction,
): void {
  exactKeys(eviction, [
    "scope", "protocol", "evictionId", "backupId", "anchorSha256", "entrySha256",
    "sourceSnapshotSha256", "sourceBackupSha256", "artifactManifestSha256",
    "providerEvidenceSha256", "controlEvidenceSha256", "retentionPolicySha256",
    "retentionUntilDbMs", "expectedCatalogSequence", "expectedCatalogEventRootSha256",
    "evictionOperationSha256", "planSha256", "adapterProtocol", "catalogNamespaceSha256",
    "catalogTargetSha256", "acknowledgementReceiptSha256", "externalTombstoneSha256",
    "observedAbsent", "catalogSequence", "previousCatalogEventRootSha256",
    "catalogEventRootSha256", "catalogEventSha256", "evictedAtDbMs", "evictionSha256",
  ], "tenant backup catalog eviction");
  digest(eviction.evictionSha256, "tenant backup catalog eviction digest");
  if (eviction.evictionSha256 !== tenantBackupCatalogEvictionSha256(eviction)) {
    throw new Error("tenant backup catalog eviction digest does not match");
  }
}

/**
 * Rebuild the local acknowledgement projection for an eviction that is already committed to the
 * authoritative external catalog. This is deliberately not an authorization check: retention,
 * minimum-copy and active-reservation policy were checked before the external event was appended.
 * Reconciliation only proves that the immutable event is the exact plan for the availability
 * entry and its pre-event catalog head.
 */
export function tenantBackupCatalogEvictionFromExternalEvent(input: {
  entry: TenantBackupCatalogEntry;
  acknowledgement: TenantBackupEvictionAdapterResult;
  evictedAtDbMs: number;
}): TenantBackupCatalogEviction {
  exactKeys(input, ["entry", "acknowledgement", "evictedAtDbMs"],
    "tenant backup external eviction projection");
  validateTenantBackupCatalogEntry(input.entry);
  validateTenantBackupEvictionAdapterResult(input.acknowledgement);
  timestamp(input.evictedAtDbMs, "tenant backup external eviction projection time");
  const { entry, acknowledgement } = input;
  if (acknowledgement.backupId !== entry.backupId
    || acknowledgement.adapterProtocol !== entry.adapterProtocol
    || acknowledgement.catalogNamespaceSha256 !== entry.catalogNamespaceSha256
    || acknowledgement.catalogTargetSha256 !== entry.catalogTargetSha256
    || input.evictedAtDbMs < entry.retentionUntilDbMs
    || acknowledgement.catalogSequence < 2) {
    throw new TenantBackupCatalogConflictError();
  }
  const source = {
    evictionId: acknowledgement.evictionId,
    backupId: entry.backupId,
    anchorSha256: entry.anchorSha256,
    entrySha256: entry.entrySha256,
    sourceSnapshotSha256: entry.sourceSnapshotSha256,
    sourceBackupSha256: entry.sourceBackupSha256,
    artifactManifestSha256: entry.artifactManifestSha256,
    providerEvidenceSha256: entry.providerEvidenceSha256,
    controlEvidenceSha256: entry.controlEvidenceSha256,
    retentionPolicySha256: entry.retentionPolicySha256,
    retentionUntilDbMs: entry.retentionUntilDbMs,
    expectedCatalogSequence: acknowledgement.catalogSequence - 1,
    expectedCatalogEventRootSha256: acknowledgement.previousCatalogEventRootSha256,
  };
  const withOperation = {
    ...source,
    evictionOperationSha256: tenantBackupEvictionOperationSha256(source),
  };
  const plan: TenantBackupEvictionPlan = {
    ...withOperation,
    planSha256: tenantBackupEvictionPlanSha256(withOperation),
  };
  if (acknowledgement.evictionOperationSha256 !== plan.evictionOperationSha256
    || acknowledgement.planSha256 !== plan.planSha256) {
    throw new TenantBackupCatalogConflictError();
  }
  const body = {
    scope: TENANT_BACKUP_CATALOG_EVICTION_SCOPE,
    protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
    ...plan,
    ...acknowledgement,
    evictedAtDbMs: input.evictedAtDbMs,
  };
  const eviction: TenantBackupCatalogEviction = {
    ...body,
    evictionSha256: tenantBackupCatalogEvictionSha256(body),
  };
  validateTenantBackupCatalogEviction(eviction);
  return eviction;
}

export type TenantBackupCatalogExternalEvent =
  | { eventType: "backup_recoverable"; result: TenantBackupAvailabilityAdapterResult }
  | { eventType: "restore_reserved"; result: TenantBackupRuntimeReservationAdapterResult }
  | { eventType: "restore_resolved"; result: ResolveTenantBackupRuntimeReservationInput }
  | { eventType: "backup_evicted"; result: TenantBackupEvictionAdapterResult };

export interface MirrorTenantBackupCatalogEventInput {
  adapterProtocol: string;
  catalogNamespaceSha256: string;
  catalogTargetSha256: string;
  failureDomainSha256: string;
  event: TenantBackupCatalogExternalEvent;
}

export interface TenantBackupCatalogStore {
  getTenantBackupCatalogControl(): Promise<TenantBackupCatalogControlRecord>;
  activateTenantBackupCatalogControl(
    input: ActivateTenantBackupCatalogControlInput,
  ): Promise<ExactReplay<ActiveTenantBackupCatalogControlRecord>>;
  createTenantBackupSnapshotAnchor(
    input: CreateTenantBackupSnapshotAnchorInput,
  ): Promise<ExactReplay<TenantBackupSnapshotAnchor>>;
  getTenantBackupSnapshotAnchor(backupId: string): Promise<TenantBackupSnapshotAnchor | null>;
  recordTenantBackupCatalogAvailability(
    result: TenantBackupAvailabilityAdapterResult,
  ): Promise<ExactReplay<TenantBackupCatalogEntry>>;
  mirrorTenantBackupCatalogEvent(
    input: MirrorTenantBackupCatalogEventInput,
  ): Promise<ExactReplay<TenantBackupCatalogExternalEvent>>;
  getTenantBackupCatalogEntry(backupId: string): Promise<TenantBackupCatalogEntry | null>;
  listRecoverableTenantBackups(options: {
    limit: number;
    afterBackupId?: string;
  }): Promise<TenantBackupCatalogEntry[]>;
  preflightTenantRestoreReplayFromBackup(
    input: PreflightTenantRestoreReplayFromBackupInput,
  ): Promise<TenantBackupCatalogEntry>;
  prepareTenantRestoreReplayFromBackup(
    input: PrepareTenantRestoreReplayFromBackupInput,
  ): Promise<ExactReplay<PrepareTenantRestoreReplayFromBackupValue>>;
  getTenantBackupRestoreSourceBinding(
    restoreRunId: string,
  ): Promise<TenantBackupRestoreSourceBinding | null>;
  getTenantBackupRuntimeReservation(
    restoreRunId: string,
  ): Promise<TenantBackupRuntimeReservation | null>;
  resolveTenantBackupRuntimeReservation(
    input: ResolveTenantBackupRuntimeReservationInput,
  ): Promise<ExactReplay<TenantBackupRuntimeReservation>>;
  assertTenantBackupRestoreRunMaySeal(
    restoreRunId: string,
  ): Promise<TenantBackupRestoreSourceBinding | null>;
  assertTenantBackupRestoreRunMayActivate(
    restoreRunId: string,
  ): Promise<TenantBackupRestoreSourceBinding | null>;
  prepareTenantBackupEviction(
    input: PrepareTenantBackupEvictionInput,
  ): Promise<TenantBackupEvictionPlan>;
  recordTenantBackupCatalogEviction(
    input: RecordTenantBackupCatalogEvictionInput,
  ): Promise<ExactReplay<TenantBackupCatalogEviction>>;
  getTenantBackupCatalogEviction(backupId: string): Promise<TenantBackupCatalogEviction | null>;
}
