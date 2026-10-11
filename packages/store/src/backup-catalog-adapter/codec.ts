import { createHash, timingSafeEqual } from "node:crypto";

export const BACKUP_CATALOG_ENVELOPE_MAGIC_TEXT = "ASBKCAT1";
export const BACKUP_CATALOG_EVENT_CONTENT_TYPE =
  "application/vnd.agent-service.backup-catalog-event-v1";
export const BACKUP_CATALOG_HEAD_CONTENT_TYPE =
  "application/vnd.agent-service.backup-catalog-head-v2";
export const BACKUP_CATALOG_PROBE_CONTENT_TYPE =
  "application/vnd.agent-service.backup-catalog-probe-v1";
export const BACKUP_CATALOG_MAX_PAYLOAD_BYTES = 256 * 1024;

const MAGIC = Buffer.from(BACKUP_CATALOG_ENVELOPE_MAGIC_TEXT, "ascii");
const KIND_OFFSET = MAGIC.length;
const LENGTH_OFFSET = KIND_OFFSET + 1;
const DIGEST_OFFSET = LENGTH_OFFSET + 4;
const DIGEST_BYTES = 32;
export const BACKUP_CATALOG_ENVELOPE_HEADER_BYTES = DIGEST_OFFSET + DIGEST_BYTES;

export type BackupCatalogEnvelopeKind = "event" | "probe" | "head";

function kindByte(kind: BackupCatalogEnvelopeKind): number {
  if (kind === "event") return 1;
  if (kind === "probe") return 2;
  return 3;
}

function decodeKind(value: number): BackupCatalogEnvelopeKind {
  if (value === 1) return "event";
  if (value === 2) return "probe";
  if (value === 3) return "head";
  throw new Error("invalid backup catalog envelope kind");
}

function payloadBytes(payload: string): Buffer {
  if (typeof payload !== "string") throw new Error("backup catalog payload must be a string");
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.toString("utf8") !== payload) {
    throw new Error("backup catalog payload must be valid UTF-8");
  }
  if (bytes.length > BACKUP_CATALOG_MAX_PAYLOAD_BYTES) {
    throw new Error("backup catalog payload is too large");
  }
  return bytes;
}

/** Integrity envelope. Event objects are immutable; the head envelope is replaced only by CAS. */
export function encodeBackupCatalogEnvelope(
  kind: BackupCatalogEnvelopeKind,
  payload: string,
): Buffer {
  const body = payloadBytes(payload);
  const header = Buffer.alloc(BACKUP_CATALOG_ENVELOPE_HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt8(kindByte(kind), KIND_OFFSET);
  header.writeUInt32BE(body.length, LENGTH_OFFSET);
  createHash("sha256")
    .update(header.subarray(0, DIGEST_OFFSET))
    .update(body)
    .digest()
    .copy(header, DIGEST_OFFSET);
  return Buffer.concat([header, body]);
}

export function decodeBackupCatalogEnvelope(
  expectedKind: BackupCatalogEnvelopeKind,
  envelope: Buffer,
): string {
  if (
    envelope.length < BACKUP_CATALOG_ENVELOPE_HEADER_BYTES
    || !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  ) throw new Error("invalid backup catalog envelope");
  if (decodeKind(envelope.readUInt8(KIND_OFFSET)) !== expectedKind) {
    throw new Error("invalid backup catalog envelope kind");
  }
  const length = envelope.readUInt32BE(LENGTH_OFFSET);
  if (
    length > BACKUP_CATALOG_MAX_PAYLOAD_BYTES
    || envelope.length !== BACKUP_CATALOG_ENVELOPE_HEADER_BYTES + length
  ) throw new Error("invalid backup catalog envelope length");
  const expectedDigest = envelope.subarray(DIGEST_OFFSET, DIGEST_OFFSET + DIGEST_BYTES);
  const body = envelope.subarray(BACKUP_CATALOG_ENVELOPE_HEADER_BYTES);
  const actualDigest = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(body)
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error("invalid backup catalog envelope checksum");
  }
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("invalid backup catalog envelope UTF-8");
  }
  payloadBytes(payload);
  return payload;
}
