import {
  BlobConflictError,
  type BlobExpectedExactState,
} from "../types.js";
import {
  validateBlobContentType,
  validateBlobKey,
  validateBlobMaxBytes,
  validateBlobMigrationOwnerSha256,
  validateBlobUploadToken,
} from "./key.js";
import { sameBlobDescriptor } from "./envelope.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Validate ledger-controlled cleanup input before looking at or mutating physical storage. */
export function validateBlobDiscardInput(
  storageKey: string,
  expectedState: BlobExpectedExactState,
  uploadToken: string,
  migrationOwnerSha256: string,
) {
  validateBlobKey(storageKey);
  validateBlobUploadToken(uploadToken);
  validateBlobMigrationOwnerSha256(migrationOwnerSha256);
  if (expectedState.kind === "tombstone") return expectedState;
  const expectedDescriptor = expectedState.descriptor;
  validateBlobKey(expectedDescriptor.storageKey);
  if (expectedDescriptor.storageKey !== storageKey) {
    throw new Error("blob discard descriptor storage key does not match target key");
  }
  if (!SHA256_HEX.test(expectedDescriptor.sha256)) {
    throw new Error("blob discard descriptor sha256 must be lowercase hexadecimal");
  }
  validateBlobMaxBytes(expectedDescriptor.sizeBytes);
  validateBlobContentType(expectedDescriptor.contentType);
  return expectedState;
}

/** Abort cleanup may delete only bytes written by this exact migration owner. */
export function assertMigrationOwner(
  storageKey: string,
  expectedMigrationOwnerSha256: string,
  actualMigrationOwnerSha256: string | undefined,
) {
  if (actualMigrationOwnerSha256 !== expectedMigrationOwnerSha256) {
    throw new BlobConflictError(storageKey);
  }
}

/** A different state or non-identical data is a hard conflict for an abort cleanup. */
export function assertExpectedMigrationState(
  storageKey: string,
  expectedState: BlobExpectedExactState,
  actualState: BlobExpectedExactState,
) {
  if (
    expectedState.kind !== actualState.kind
    || (
      expectedState.kind === "data"
      && actualState.kind === "data"
      && !sameBlobDescriptor(expectedState.descriptor, actualState.descriptor)
    )
  ) {
    throw new BlobConflictError(storageKey);
  }
}
