import { createHash, timingSafeEqual } from "node:crypto";
import {
  BlobTooLargeError,
  type BlobDescriptor,
  type BlobObject,
} from "../types.js";
import {
  validateBlobContentType,
  validateBlobMigrationOwnerSha256,
} from "./key.js";

export const BLOB_ENVELOPE_MAGIC_TEXT = "ASBLOB02";
export const BLOB_ENVELOPE_MAX_METADATA_BYTES = 16 * 1024;
export const BLOB_ENVELOPE_OBJECT_CONTENT_TYPE = "application/vnd.agent-service.asblob2";

const ENVELOPE_MAGIC = Buffer.from(BLOB_ENVELOPE_MAGIC_TEXT, "ascii");
const DIGEST_BYTES = 32;
const METADATA_LENGTH_OFFSET = ENVELOPE_MAGIC.length;
const PAYLOAD_LENGTH_OFFSET = METADATA_LENGTH_OFFSET + 4;
const DIGEST_OFFSET = PAYLOAD_LENGTH_OFFSET + 4;
export const BLOB_ENVELOPE_HEADER_BYTES = DIGEST_OFFSET + DIGEST_BYTES;

export interface BlobEnvelopeLengths {
  metadataLength: number;
  payloadLength: number;
  totalLength: number;
}

export type DecodedBlobEnvelope =
  | { kind: "data"; object: BlobObject; migrationOwnerSha256?: string }
  | { kind: "tombstone"; migrationOwnerSha256?: string };

export function inputByteLength(data: Buffer | string) {
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

export function blobDescriptorFor(
  storageKey: string,
  data: Buffer,
  contentType: string | undefined,
): BlobDescriptor {
  return {
    storageKey,
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.byteLength,
    contentType,
  };
}

export function sameBlobDescriptor(left: BlobDescriptor, right: BlobDescriptor) {
  return left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.contentType === right.contentType;
}

function encodeEnvelope(payload: Buffer, metadata: Buffer) {
  if (metadata.length > BLOB_ENVELOPE_MAX_METADATA_BYTES) {
    throw new Error("blob metadata is too large");
  }
  if (payload.length > 0xffff_ffff) throw new Error("blob payload is too large for the envelope");

  const header = Buffer.alloc(BLOB_ENVELOPE_HEADER_BYTES);
  ENVELOPE_MAGIC.copy(header);
  header.writeUInt32BE(metadata.length, METADATA_LENGTH_OFFSET);
  header.writeUInt32BE(payload.length, PAYLOAD_LENGTH_OFFSET);
  createHash("sha256")
    .update(header.subarray(0, DIGEST_OFFSET))
    .update(metadata)
    .update(payload)
    .digest()
    .copy(header, DIGEST_OFFSET);
  return Buffer.concat([header, metadata, payload]);
}

export function encodeBlobDataEnvelope(
  payload: Buffer,
  contentType: string | undefined,
  migrationOwnerSha256?: string,
) {
  if (migrationOwnerSha256 !== undefined) {
    validateBlobMigrationOwnerSha256(migrationOwnerSha256);
  }
  const metadata = Buffer.from(JSON.stringify({
    ...(contentType === undefined ? {} : { contentType }),
    ...(migrationOwnerSha256 === undefined ? {} : { migrationOwnerSha256 }),
  }), "utf8");
  return encodeEnvelope(payload, metadata);
}

/**
 * The tombstone is deliberately one canonical ASBLOB02 object. A token-authenticated delete
 * replaces (or creates) this value at the data object's own key, so a later create-only write
 * cannot race between a separate marker check and publication.
 */
export function encodeBlobTombstoneEnvelope(migrationOwnerSha256?: string) {
  if (migrationOwnerSha256 !== undefined) {
    validateBlobMigrationOwnerSha256(migrationOwnerSha256);
  }
  return encodeEnvelope(Buffer.alloc(0), Buffer.from(JSON.stringify({
    kind: "tombstone",
    ...(migrationOwnerSha256 === undefined ? {} : { migrationOwnerSha256 }),
  }), "utf8"));
}

export function hasBlobEnvelopeMagic(data: Buffer) {
  return data.length >= ENVELOPE_MAGIC.length
    && data.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC);
}

export function blobEnvelopeLengths(header: Buffer): BlobEnvelopeLengths {
  if (header.length < BLOB_ENVELOPE_HEADER_BYTES || !hasBlobEnvelopeMagic(header)) {
    throw new Error("invalid blob envelope");
  }
  const metadataLength = header.readUInt32BE(METADATA_LENGTH_OFFSET);
  const payloadLength = header.readUInt32BE(PAYLOAD_LENGTH_OFFSET);
  return {
    metadataLength,
    payloadLength,
    totalLength: BLOB_ENVELOPE_HEADER_BYTES + metadataLength + payloadLength,
  };
}

function decodeMetadata(envelope: Buffer, payloadOffset: number) {
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      envelope.subarray(BLOB_ENVELOPE_HEADER_BYTES, payloadOffset).toString("utf8"),
    );
  } catch {
    throw new Error("invalid blob metadata");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("invalid blob metadata");
  }
  return metadata as Record<string, unknown>;
}

export function decodeBlobEnvelope(
  storageKey: string,
  envelope: Buffer,
  maxBytes?: number,
): DecodedBlobEnvelope {
  const { metadataLength, payloadLength, totalLength } = blobEnvelopeLengths(envelope);
  const payloadOffset = BLOB_ENVELOPE_HEADER_BYTES + metadataLength;
  if (metadataLength > BLOB_ENVELOPE_MAX_METADATA_BYTES || totalLength !== envelope.length) {
    throw new Error("invalid blob envelope length");
  }
  if (maxBytes !== undefined && payloadLength > maxBytes) {
    throw new BlobTooLargeError(storageKey, maxBytes, payloadLength);
  }

  const expectedDigest = envelope.subarray(DIGEST_OFFSET, DIGEST_OFFSET + DIGEST_BYTES);
  const actualDigest = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(envelope.subarray(BLOB_ENVELOPE_HEADER_BYTES, payloadOffset))
    .update(envelope.subarray(payloadOffset))
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error("invalid blob envelope checksum");
  }

  const metadata = decodeMetadata(envelope, payloadOffset);
  const keys = Object.keys(metadata);
  let migrationOwnerSha256: string | undefined;
  try {
    const value = metadata.migrationOwnerSha256;
    if (value !== undefined && typeof value !== "string") throw new Error("invalid blob metadata");
    migrationOwnerSha256 = value === undefined
      ? undefined
      : validateBlobMigrationOwnerSha256(value);
  } catch (error) {
    if ((error as Error).message === "invalid blob metadata") throw error;
    throw new Error("invalid blob metadata", { cause: error });
  }

  if (
    metadata.kind === "tombstone"
    && keys.every((key) => key === "kind" || key === "migrationOwnerSha256")
    && keys.includes("kind")
  ) {
    if (payloadLength !== 0 || !envelope.equals(encodeBlobTombstoneEnvelope(migrationOwnerSha256))) {
      throw new Error("invalid blob tombstone");
    }
    return {
      kind: "tombstone",
      ...(migrationOwnerSha256 === undefined ? {} : { migrationOwnerSha256 }),
    };
  }
  if (keys.some((key) => key !== "contentType" && key !== "migrationOwnerSha256")) {
    throw new Error("invalid blob metadata");
  }

  let contentType: string | undefined;
  try {
    const value = metadata.contentType;
    if (value !== undefined && typeof value !== "string") throw new Error("invalid blob metadata");
    contentType = validateBlobContentType(value);
  } catch (error) {
    if ((error as Error).message === "invalid blob metadata") throw error;
    throw new Error("invalid blob metadata", { cause: error });
  }

  const data = Buffer.from(envelope.subarray(payloadOffset));
  return {
    kind: "data",
    object: { ...blobDescriptorFor(storageKey, data, contentType), data },
    ...(migrationOwnerSha256 === undefined ? {} : { migrationOwnerSha256 }),
  };
}

export function decodeBlobDataEnvelope(
  storageKey: string,
  envelope: Buffer,
  maxBytes?: number,
): BlobObject {
  const decoded = decodeBlobEnvelope(storageKey, envelope, maxBytes);
  if (decoded.kind === "tombstone") throw new Error("blob object is a tombstone");
  return decoded.object;
}
