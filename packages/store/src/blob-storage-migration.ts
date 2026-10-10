import { createHash } from "node:crypto";
import type { BlobDescriptor } from "./types.js";
import {
  validateBlobStorageBackend,
  validateBlobStorageNamespaceSha256,
} from "./blob-storage-control.js";

export const BLOB_STORAGE_MIGRATION_SINGLETON_ID = 1 as const;
export const BLOB_STORAGE_MIGRATION_SOURCE_BACKEND = "filesystem-v1" as const;

export const BLOB_STORAGE_MIGRATION_PHASES = [
  "inactive",
  "frozen",
  "inventory_sealed",
  "copying",
  "verified",
  "cutting_over",
  "committed",
  "source_cleaned",
  "abort_cleaning",
  "aborted",
] as const;
export type BlobStorageMigrationPhase = (typeof BLOB_STORAGE_MIGRATION_PHASES)[number];

export const BLOB_STORAGE_MIGRATION_RECORD_KINDS = [
  "blob_object",
  "blob_delete_intent",
  "export_artifact",
  "export_part",
  "export_snapshot_pin",
  "export_delete_intent",
] as const;
export type BlobStorageMigrationRecordKind =
  (typeof BLOB_STORAGE_MIGRATION_RECORD_KINDS)[number];

export const BLOB_STORAGE_MIGRATION_OBJECT_DISPOSITIONS = [
  "data",
  "tombstone",
  "absent",
  "metadata",
] as const;
export type BlobStorageMigrationObjectDisposition =
  (typeof BLOB_STORAGE_MIGRATION_OBJECT_DISPOSITIONS)[number];

export type BlobStorageMigrationReceiptKind = "committed" | "aborted" | "source_cleaned";

export interface BlobStorageMigrationEvent {
  migrationId: string;
  eventSeq: number;
  controlGeneration: number;
  eventType: string;
  fromPhase: BlobStorageMigrationPhase;
  toPhase: BlobStorageMigrationPhase;
  inventoryEntryCount: number;
  inventoryRootSha256?: string;
  objectAckCount: number;
  objectAckRootSha256?: string;
  occurredAtDbMs: number;
  evidenceSha256: string;
  eventSha256: string;
}

const MIGRATION_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256Lines(values: readonly (string | number | undefined)[]): string {
  return createHash("sha256")
    .update(values.map((value) => value === undefined ? "-" : String(value)).join("\n"))
    .digest("hex");
}

function assertExactKeys(value: object, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function assertSha256(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
}

function assertTimestamp(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertCount(value: unknown, name: string): asserts value is number {
  assertTimestamp(value, name);
}

function assertPositiveGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("blob storage migration generation must be a positive safe integer");
  }
}

export function validateBlobStorageMigrationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !MIGRATION_ID.test(value)) {
    throw new Error("invalid blob storage migration id");
  }
}

export interface BeginBlobStorageMigrationInput {
  migrationId: string;
  expectedControlGeneration: number;
  sourceBackend: typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND;
  sourceNamespaceSha256: string;
  targetBackend: string;
  targetNamespaceSha256: string;
  /** Delay from the trusted freeze DB clock before irreversible generation-1 cutover is allowed. */
  rollbackWindowMs: number;
  /** Delay from commit DB time before source bytes may be physically removed. Runtime stays gated. */
  sourceCleanupDelayMs: number;
  /** Content-free operator evidence that every router/runner/blob worker has been drained. */
  fleetDrainedEvidenceSha256: string;
}

export function validateBeginBlobStorageMigrationInput(
  input: BeginBlobStorageMigrationInput,
): void {
  assertExactKeys(input, [
    "migrationId",
    "expectedControlGeneration",
    "sourceBackend",
    "sourceNamespaceSha256",
    "targetBackend",
    "targetNamespaceSha256",
    "rollbackWindowMs",
    "sourceCleanupDelayMs",
    "fleetDrainedEvidenceSha256",
  ], "blob storage migration begin input");
  validateBlobStorageMigrationId(input.migrationId);
  if (!Number.isSafeInteger(input.expectedControlGeneration)
    || input.expectedControlGeneration < 0) {
    throw new Error("invalid expected blob storage migration generation");
  }
  if (input.sourceBackend !== BLOB_STORAGE_MIGRATION_SOURCE_BACKEND) {
    throw new Error("only filesystem-v1 can be a blob storage migration source");
  }
  validateBlobStorageNamespaceSha256(input.sourceNamespaceSha256);
  validateBlobStorageBackend(input.targetBackend);
  validateBlobStorageNamespaceSha256(input.targetNamespaceSha256);
  const expectedTarget = `s3-v1-${input.targetNamespaceSha256.slice(0, 24)}`;
  if (input.targetBackend !== expectedTarget) {
    throw new Error("blob storage migration target backend does not match its namespace");
  }
  assertTimestamp(input.rollbackWindowMs, "blob storage migration rollback window");
  assertTimestamp(input.sourceCleanupDelayMs, "blob storage migration source cleanup delay");
  assertSha256(input.fleetDrainedEvidenceSha256, "blob storage migration fleet-drain evidence");
}

export interface BlobStorageMigrationControlRecord {
  singletonId: typeof BLOB_STORAGE_MIGRATION_SINGLETON_ID;
  controlGeneration: number;
  phase: BlobStorageMigrationPhase;
  migrationId?: string;
  sourceBackend?: typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND;
  sourceNamespaceSha256?: string;
  targetBackend?: string;
  targetNamespaceSha256?: string;
  fleetDrainedEvidenceSha256?: string;
  rollbackWindowMs?: number;
  sourceCleanupDelayMs?: number;
  cutoverNotBeforeDbMs?: number;
  sourceCleanupNotBeforeDbMs?: number;
  inventoryEntryCount: number;
  inventoryRootSha256?: string;
  objectAckCount: number;
  objectAckRootSha256?: string;
  sourceCleanupAckCount: number;
  sourceCleanupAckRootSha256?: string;
  targetCleanupAckCount: number;
  targetCleanupAckRootSha256?: string;
  startedAtDbMs?: number;
  inventorySealedAtDbMs?: number;
  verifiedAtDbMs?: number;
  completedAtDbMs?: number;
  terminalReceiptSha256?: string;
  evidenceSha256?: string;
}

export interface BlobStorageMigrationInventoryEntry {
  migrationId: string;
  entryOrdinal: number;
  recordKind: BlobStorageMigrationRecordKind;
  recordId: string;
  recordSubId: number;
  recordAuxId: number;
  storageKey?: string;
  sourceBackend: typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND;
  sourceNamespaceSha256: string;
  targetBackend: string;
  targetNamespaceSha256: string;
  storageFormat?: string;
  objectDisposition: BlobStorageMigrationObjectDisposition;
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedContentType?: string;
  sourceUploadTokenSha256?: string;
  sourceRecordSha256: string;
  entrySha256: string;
  createdAtDbMs: number;
}

export interface BlobStorageMigrationPhysicalObject {
  migrationId: string;
  storageKey: string;
  objectDisposition: Exclude<BlobStorageMigrationObjectDisposition, "metadata">;
  expectedDescriptor?: BlobDescriptor;
  sourceDescriptorSha256?: string;
  sourceUploadToken: string;
}

export interface BlobStorageMigrationObjectAck {
  migrationId: string;
  storageKey: string;
  objectDisposition: Exclude<BlobStorageMigrationObjectDisposition, "metadata">;
  targetBackend: string;
  targetNamespaceSha256: string;
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedContentType?: string;
  sourceObservedKind: "data" | "tombstone" | "missing";
  targetObservedKind: "data" | "tombstone" | "missing";
  sourceDescriptorSha256?: string;
  targetDescriptorSha256?: string;
  verifiedAtDbMs: number;
  ackSha256: string;
}

export interface BlobStorageMigrationReceipt {
  migrationId: string;
  receiptKind: BlobStorageMigrationReceiptKind;
  controlGeneration: number;
  sourceBackend: typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND;
  sourceNamespaceSha256: string;
  targetBackend: string;
  targetNamespaceSha256: string;
  rollbackWindowMs: number;
  sourceCleanupDelayMs: number;
  cutoverNotBeforeDbMs: number;
  sourceCleanupNotBeforeDbMs?: number;
  inventoryEntryCount: number;
  inventoryRootSha256: string;
  objectAckCount: number;
  objectAckRootSha256: string;
  sourceCleanupAckCount: number;
  sourceCleanupAckRootSha256?: string;
  targetCleanupAckCount: number;
  targetCleanupAckRootSha256?: string;
  fleetDrainedEvidenceSha256: string;
  blobControlEvidenceSha256?: string;
  occurredAtDbMs: number;
  receiptSha256: string;
}

export class BlobStorageMigrationConflictError extends Error {
  constructor(message = "blob storage migration conflicts with durable state") {
    super(message);
    this.name = "BlobStorageMigrationConflictError";
  }
}

export class BlobStorageMigrationIntegrityError extends Error {
  constructor(message = "blob storage migration evidence is invalid") {
    super(message);
    this.name = "BlobStorageMigrationIntegrityError";
  }
}

export class BlobStorageMigrationNotReadyError extends Error {
  constructor(public readonly reason: string) {
    super(`blob storage migration is not ready: ${reason}`);
    this.name = "BlobStorageMigrationNotReadyError";
  }
}

export function blobStorageMigrationUploadTokenSha256(uploadToken: string): string {
  if (typeof uploadToken !== "string" || !/^[A-Za-z0-9._:~-]{1,128}$/.test(uploadToken)) {
    throw new Error("invalid blob storage migration upload token");
  }
  return sha256(["blob-storage-migration-upload-token-v1", uploadToken]);
}

/** Per-attempt, per-key marker embedded in target envelopes so abort never deletes reused bytes. */
export function blobStorageMigrationTargetOwnerSha256(
  migrationId: string,
  targetNamespaceSha256: string,
  storageKey: string,
): string {
  validateBlobStorageMigrationId(migrationId);
  assertSha256(targetNamespaceSha256, "blob migration target owner namespace");
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    throw new Error("invalid blob migration target owner storage key");
  }
  return sha256([
    "blob-storage-migration-target-owner-v1",
    migrationId,
    targetNamespaceSha256,
    storageKey,
  ]);
}

export function blobStorageMigrationDescriptorSha256(
  state: "missing" | "tombstone" | BlobDescriptor,
): string {
  if (state === "missing" || state === "tombstone") {
    return sha256(["blob-storage-migration-object-state-v1", state]);
  }
  assertSha256(state.sha256, "blob descriptor hash");
  assertCount(state.sizeBytes, "blob descriptor size");
  return sha256([
    "blob-storage-migration-object-state-v1",
    "data",
    state.storageKey,
    state.sha256,
    state.sizeBytes,
    state.contentType ?? null,
  ]);
}

export function blobStorageMigrationSourceRecordSha256(
  recordKind: BlobStorageMigrationRecordKind,
  canonicalRecord: readonly unknown[],
): string {
  if (!(BLOB_STORAGE_MIGRATION_RECORD_KINDS as readonly string[]).includes(recordKind)) {
    throw new Error("invalid blob storage migration record kind");
  }
  return sha256(["blob-storage-migration-source-record-v1", recordKind, canonicalRecord]);
}

export function blobStorageMigrationInventoryEntrySha256(
  entry: Omit<BlobStorageMigrationInventoryEntry, "entrySha256">,
): string {
  validateBlobStorageMigrationId(entry.migrationId);
  assertCount(entry.entryOrdinal, "blob storage migration entry ordinal");
  assertSha256(entry.sourceNamespaceSha256, "blob storage migration source namespace");
  assertSha256(entry.targetNamespaceSha256, "blob storage migration target namespace");
  assertSha256(entry.sourceRecordSha256, "blob storage migration source record");
  return sha256([
    "blob-storage-migration-inventory-entry-v1",
    entry.migrationId,
    entry.entryOrdinal,
    entry.recordKind,
    entry.recordId,
    entry.recordSubId,
    entry.recordAuxId,
    entry.storageKey ?? null,
    entry.sourceBackend,
    entry.sourceNamespaceSha256,
    entry.targetBackend,
    entry.targetNamespaceSha256,
    entry.storageFormat ?? null,
    entry.objectDisposition,
    entry.expectedSha256 ?? null,
    entry.expectedSizeBytes ?? null,
    entry.expectedContentType ?? null,
    entry.sourceUploadTokenSha256 ?? null,
    entry.sourceRecordSha256,
    entry.createdAtDbMs,
  ]);
}

/** Ordered rolling commitment, so callers can seal large inventories without retaining all rows. */
export function appendBlobStorageMigrationRoot(
  scope: "inventory" | "object-acks" | "target-cleanup" | "source-cleanup",
  priorRootSha256: string | undefined,
  ordinal: number,
  evidenceSha256: string,
): string {
  assertCount(ordinal, "blob storage migration evidence ordinal");
  assertSha256(evidenceSha256, "blob storage migration evidence");
  if (priorRootSha256 !== undefined) {
    assertSha256(priorRootSha256, "blob storage migration prior root");
  }
  return sha256([
    `blob-storage-migration-${scope}-root-v1`,
    priorRootSha256 ?? null,
    ordinal,
    evidenceSha256,
  ]);
}

export function emptyBlobStorageMigrationRoot(
  scope: "inventory" | "object-acks" | "target-cleanup" | "source-cleanup",
): string {
  return sha256([`blob-storage-migration-${scope}-root-v1`, "empty"]);
}

export function blobStorageMigrationObjectAckSha256(
  ack: Omit<BlobStorageMigrationObjectAck, "ackSha256">,
): string {
  validateBlobStorageMigrationId(ack.migrationId);
  assertSha256(ack.targetNamespaceSha256, "blob storage migration ACK target namespace");
  if (ack.sourceDescriptorSha256 !== undefined) {
    assertSha256(ack.sourceDescriptorSha256, "blob storage migration ACK source descriptor");
  }
  if (ack.targetDescriptorSha256 !== undefined) {
    assertSha256(ack.targetDescriptorSha256, "blob storage migration ACK target descriptor");
  }
  assertTimestamp(ack.verifiedAtDbMs, "blob storage migration ACK time");
  return sha256([
    "blob-storage-migration-object-ack-v1",
    ack.migrationId,
    ack.storageKey,
    ack.objectDisposition,
    ack.targetBackend,
    ack.targetNamespaceSha256,
    ack.expectedSha256 ?? null,
    ack.expectedSizeBytes ?? null,
    ack.expectedContentType ?? null,
    ack.sourceObservedKind,
    ack.targetObservedKind,
    ack.sourceDescriptorSha256 ?? null,
    ack.targetDescriptorSha256 ?? null,
    ack.verifiedAtDbMs,
  ]);
}

export function blobStorageMigrationControlEvidenceSha256(
  record: Omit<BlobStorageMigrationControlRecord, "evidenceSha256">,
): string {
  if (record.singletonId !== BLOB_STORAGE_MIGRATION_SINGLETON_ID) {
    throw new Error("invalid blob storage migration singleton");
  }
  assertCount(record.controlGeneration, "blob storage migration control generation");
  return sha256Lines([
    "blob-storage-migration-control-v1",
    record.controlGeneration,
    record.migrationId,
    record.phase,
    record.sourceBackend,
    record.sourceNamespaceSha256,
    record.targetBackend,
    record.targetNamespaceSha256,
    record.rollbackWindowMs,
    record.sourceCleanupDelayMs,
    record.cutoverNotBeforeDbMs,
    record.sourceCleanupNotBeforeDbMs,
    record.inventoryEntryCount,
    record.inventoryRootSha256,
    record.objectAckCount,
    record.objectAckRootSha256,
    record.sourceCleanupAckCount,
    record.sourceCleanupAckRootSha256,
    record.targetCleanupAckCount,
    record.targetCleanupAckRootSha256,
    record.startedAtDbMs,
    record.inventorySealedAtDbMs,
    record.verifiedAtDbMs,
    record.completedAtDbMs,
    record.terminalReceiptSha256,
    record.fleetDrainedEvidenceSha256,
  ]);
}

export function blobStorageMigrationReceiptSha256(
  receipt: Omit<BlobStorageMigrationReceipt, "receiptSha256">,
): string {
  validateBlobStorageMigrationId(receipt.migrationId);
  assertPositiveGeneration(receipt.controlGeneration);
  assertSha256(receipt.sourceNamespaceSha256, "blob migration receipt source namespace");
  assertSha256(receipt.targetNamespaceSha256, "blob migration receipt target namespace");
  assertSha256(receipt.inventoryRootSha256, "blob migration receipt inventory root");
  assertSha256(receipt.objectAckRootSha256, "blob migration receipt object ACK root");
  assertTimestamp(receipt.rollbackWindowMs, "blob migration receipt rollback window");
  assertTimestamp(receipt.sourceCleanupDelayMs, "blob migration receipt cleanup delay");
  assertTimestamp(receipt.cutoverNotBeforeDbMs, "blob migration receipt cutover deadline");
  if (receipt.sourceCleanupNotBeforeDbMs !== undefined) {
    assertTimestamp(receipt.sourceCleanupNotBeforeDbMs, "blob migration receipt cleanup deadline");
  }
  assertCount(receipt.sourceCleanupAckCount, "blob migration receipt source cleanup count");
  assertCount(receipt.targetCleanupAckCount, "blob migration receipt target cleanup count");
  if (receipt.sourceCleanupAckRootSha256 !== undefined) {
    assertSha256(receipt.sourceCleanupAckRootSha256, "blob migration receipt source cleanup root");
  }
  if (receipt.targetCleanupAckRootSha256 !== undefined) {
    assertSha256(receipt.targetCleanupAckRootSha256, "blob migration receipt target cleanup root");
  }
  assertSha256(receipt.fleetDrainedEvidenceSha256, "blob migration receipt fleet-drain evidence");
  if (receipt.blobControlEvidenceSha256 !== undefined) {
    assertSha256(receipt.blobControlEvidenceSha256, "blob control evidence");
  }
  assertTimestamp(receipt.occurredAtDbMs, "blob migration receipt time");
  return sha256([
    "blob-storage-migration-receipt-v1",
    receipt.migrationId,
    receipt.receiptKind,
    receipt.controlGeneration,
    receipt.sourceBackend,
    receipt.sourceNamespaceSha256,
    receipt.targetBackend,
    receipt.targetNamespaceSha256,
    receipt.rollbackWindowMs,
    receipt.sourceCleanupDelayMs,
    receipt.cutoverNotBeforeDbMs,
    receipt.sourceCleanupNotBeforeDbMs ?? null,
    receipt.inventoryEntryCount,
    receipt.inventoryRootSha256,
    receipt.objectAckCount,
    receipt.objectAckRootSha256,
    receipt.sourceCleanupAckCount,
    receipt.sourceCleanupAckRootSha256 ?? null,
    receipt.targetCleanupAckCount,
    receipt.targetCleanupAckRootSha256 ?? null,
    receipt.fleetDrainedEvidenceSha256,
    receipt.blobControlEvidenceSha256 ?? null,
    receipt.occurredAtDbMs,
  ]);
}

export function blobStorageMigrationEventSha256(
  event: Omit<BlobStorageMigrationEvent, "eventSha256">,
): string {
  validateBlobStorageMigrationId(event.migrationId);
  assertPositiveGeneration(event.controlGeneration);
  assertPositiveGeneration(event.eventSeq);
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(event.eventType)) {
    throw new Error("invalid blob storage migration event type");
  }
  assertCount(event.inventoryEntryCount, "blob migration event inventory count");
  assertCount(event.objectAckCount, "blob migration event object ACK count");
  if (event.inventoryRootSha256 !== undefined) {
    assertSha256(event.inventoryRootSha256, "blob migration event inventory root");
  }
  if (event.objectAckRootSha256 !== undefined) {
    assertSha256(event.objectAckRootSha256, "blob migration event object ACK root");
  }
  assertTimestamp(event.occurredAtDbMs, "blob migration event time");
  assertSha256(event.evidenceSha256, "blob migration event control evidence");
  return sha256([
    "blob-storage-migration-event-v1",
    event.migrationId,
    event.eventSeq,
    event.controlGeneration,
    event.eventType,
    event.fromPhase,
    event.toPhase,
    event.inventoryEntryCount,
    event.inventoryRootSha256 ?? null,
    event.objectAckCount,
    event.objectAckRootSha256 ?? null,
    event.occurredAtDbMs,
    event.evidenceSha256,
  ]);
}

export function blobStorageMigrationSourceCleanupAckSha256(input: {
  migrationId: string;
  storageKey: string;
  objectDisposition: Exclude<BlobStorageMigrationObjectDisposition, "metadata">;
  sourceBackend: typeof BLOB_STORAGE_MIGRATION_SOURCE_BACKEND;
  sourceNamespaceSha256: string;
  sourceObservedKind: "missing" | "tombstone";
  sourceDescriptorSha256?: string;
  cleanedAtDbMs: number;
}): string {
  validateBlobStorageMigrationId(input.migrationId);
  assertSha256(input.sourceNamespaceSha256, "blob migration cleanup source namespace");
  if (input.sourceDescriptorSha256 !== undefined) {
    assertSha256(input.sourceDescriptorSha256, "blob migration cleanup source descriptor");
  }
  assertTimestamp(input.cleanedAtDbMs, "blob migration cleanup time");
  return sha256([
    "blob-storage-migration-source-cleanup-ack-v1",
    input.migrationId,
    input.storageKey,
    input.objectDisposition,
    input.sourceBackend,
    input.sourceNamespaceSha256,
    input.sourceObservedKind,
    input.sourceDescriptorSha256 ?? null,
    input.cleanedAtDbMs,
  ]);
}

export function blobStorageMigrationTargetCleanupAckSha256(input: {
  migrationId: string;
  storageKey: string;
  objectDisposition: Exclude<BlobStorageMigrationObjectDisposition, "metadata">;
  targetBackend: string;
  targetNamespaceSha256: string;
  cleanupResult: "missing" | "fenced_tombstone" | "preserved_conflict";
  targetObservedKind: "data" | "tombstone" | "missing";
  targetDescriptorSha256?: string;
  targetMigrationOwnerSha256?: string;
  cleanedAtDbMs: number;
}): string {
  validateBlobStorageMigrationId(input.migrationId);
  validateBlobStorageBackend(input.targetBackend);
  assertSha256(input.targetNamespaceSha256, "blob migration target cleanup namespace");
  if (input.cleanupResult === "missing") {
    if (input.objectDisposition !== "absent"
      || input.targetObservedKind !== "missing"
      || input.targetDescriptorSha256 !== undefined
      || input.targetMigrationOwnerSha256 !== undefined) {
      throw new Error("invalid missing target cleanup evidence");
    }
  } else if (input.cleanupResult === "fenced_tombstone") {
    if (input.objectDisposition === "absent"
      || input.targetObservedKind !== "tombstone"
      || input.targetDescriptorSha256 !== undefined
      || input.targetMigrationOwnerSha256 !== blobStorageMigrationTargetOwnerSha256(
        input.migrationId,
        input.targetNamespaceSha256,
        input.storageKey,
      )) {
      throw new Error("invalid fenced target cleanup evidence");
    }
  } else if (input.cleanupResult === "preserved_conflict") {
    if (input.targetObservedKind === "missing") {
      throw new Error("invalid preserved target cleanup evidence");
    }
    if (input.targetObservedKind === "data") {
      assertSha256(input.targetDescriptorSha256, "blob migration target cleanup descriptor");
    } else if (input.targetDescriptorSha256 !== undefined) {
      throw new Error("tombstone target cleanup must not carry a descriptor");
    }
  } else {
    throw new Error("invalid target cleanup result");
  }
  if (input.targetMigrationOwnerSha256 !== undefined) {
    assertSha256(input.targetMigrationOwnerSha256, "blob migration target cleanup owner");
  }
  assertTimestamp(input.cleanedAtDbMs, "blob migration target cleanup time");
  return sha256([
    "blob-storage-migration-target-cleanup-ack-v1",
    input.migrationId,
    input.storageKey,
    input.objectDisposition,
    input.targetBackend,
    input.targetNamespaceSha256,
    input.cleanupResult,
    input.targetObservedKind,
    input.targetDescriptorSha256 ?? null,
    input.targetMigrationOwnerSha256 ?? null,
    input.cleanedAtDbMs,
  ]);
}

export function isBlobStorageMigrationRuntimeBlocked(
  control: BlobStorageMigrationControlRecord,
): boolean {
  return !["inactive", "aborted", "source_cleaned"].includes(control.phase);
}
