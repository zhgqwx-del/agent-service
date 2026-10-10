import { createHash } from "node:crypto";

export const BLOB_STORAGE_CONTROL_SINGLETON_ID = 1 as const;

export interface InactiveBlobStorageControlRecord {
  singletonId: typeof BLOB_STORAGE_CONTROL_SINGLETON_ID;
  controlGeneration: 0;
}

export interface ActiveBlobStorageControlRecord {
  singletonId: typeof BLOB_STORAGE_CONTROL_SINGLETON_ID;
  controlGeneration: 1;
  storageBackend: string;
  namespaceSha256: string;
  activatedAtDbMs: number;
  evidenceSha256: string;
}

export type BlobStorageControlRecord =
  | InactiveBlobStorageControlRecord
  | ActiveBlobStorageControlRecord;

export interface ActivateBlobStorageControlInput {
  /** The only supported transition is the one-way inactive generation 0 -> active generation 1. */
  expectedControlGeneration: 0;
  /** Stable manifest identity, including a namespace-derived suffix for shared object stores. */
  storageBackend: string;
  /** Full, non-secret digest of the object-store namespace identity. */
  namespaceSha256: string;
}

export interface BlobStorageControlStore {
  getBlobStorageControl(): Promise<BlobStorageControlRecord>;
  activateBlobStorageControl(
    input: ActivateBlobStorageControlInput,
  ): Promise<ActiveBlobStorageControlRecord>;
}

/** A different backend/namespace is active, or pre-cutover durable work still names one. */
export class BlobStorageControlConflictError extends Error {
  constructor() {
    super("blob storage cutover conflicts with durable storage identity");
    this.name = "BlobStorageControlConflictError";
  }
}

/** The singleton is missing or no longer has a valid write-once shape/evidence chain. */
export class BlobStorageControlIntegrityError extends Error {
  constructor() {
    super("blob storage control is corrupt");
    this.name = "BlobStorageControlIntegrityError";
  }
}

export function validateBlobStorageBackend(storageBackend: unknown): asserts storageBackend is string {
  if (typeof storageBackend !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(storageBackend)) {
    throw new Error("invalid blob storage backend");
  }
}

export function validateBlobStorageNamespaceSha256(
  namespaceSha256: unknown,
): asserts namespaceSha256 is string {
  if (typeof namespaceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(namespaceSha256)) {
    throw new Error("blob storage namespace must be a lowercase SHA-256 digest");
  }
}

export function validateActivateBlobStorageControlInput(
  input: ActivateBlobStorageControlInput,
): void {
  if (!input || input.expectedControlGeneration !== 0) {
    throw new Error("invalid blob storage control generation");
  }
  validateBlobStorageBackend(input.storageBackend);
  validateBlobStorageNamespaceSha256(input.namespaceSha256);
}

export function blobStorageControlEvidenceSha256(input: {
  singletonId: typeof BLOB_STORAGE_CONTROL_SINGLETON_ID;
  controlGeneration: 1;
  storageBackend: string;
  namespaceSha256: string;
  activatedAtDbMs: number;
}): string {
  validateBlobStorageBackend(input.storageBackend);
  validateBlobStorageNamespaceSha256(input.namespaceSha256);
  if (
    input.singletonId !== BLOB_STORAGE_CONTROL_SINGLETON_ID
    || input.controlGeneration !== 1
    || !Number.isSafeInteger(input.activatedAtDbMs)
    || input.activatedAtDbMs < 0
  ) throw new Error("invalid active blob storage control evidence");
  return createHash("sha256").update(JSON.stringify([
    "blob-storage-control-v1",
    input.singletonId,
    input.controlGeneration,
    input.storageBackend,
    input.namespaceSha256,
    input.activatedAtDbMs,
  ])).digest("hex");
}

export function validateBlobStorageControlRecord(
  record: BlobStorageControlRecord,
): void {
  if (
    !record
    || record.singletonId !== BLOB_STORAGE_CONTROL_SINGLETON_ID
    || (record.controlGeneration !== 0 && record.controlGeneration !== 1)
  ) throw new BlobStorageControlIntegrityError();
  if (record.controlGeneration === 0) {
    if (
      "storageBackend" in record
      || "namespaceSha256" in record
      || "activatedAtDbMs" in record
      || "evidenceSha256" in record
    ) throw new BlobStorageControlIntegrityError();
    return;
  }
  try {
    validateBlobStorageBackend(record.storageBackend);
    validateBlobStorageNamespaceSha256(record.namespaceSha256);
    if (!Number.isSafeInteger(record.activatedAtDbMs) || record.activatedAtDbMs < 0) {
      throw new Error("invalid activation time");
    }
    if (
      !/^[0-9a-f]{64}$/.test(record.evidenceSha256)
      || record.evidenceSha256 !== blobStorageControlEvidenceSha256(record)
    ) throw new Error("invalid evidence");
  } catch {
    throw new BlobStorageControlIntegrityError();
  }
}
