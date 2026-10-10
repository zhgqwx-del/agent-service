import { createHash, timingSafeEqual } from "node:crypto";

export const RESTORE_JOURNAL_ENVELOPE_MAGIC_TEXT = "ASRJNL01";
export const RESTORE_JOURNAL_RECORD_CONTENT_TYPE =
  "application/vnd.agent-service.restore-journal-record-v1";
export const RESTORE_JOURNAL_HEAD_CONTENT_TYPE =
  "application/vnd.agent-service.restore-journal-head-v1";
export const RESTORE_JOURNAL_MAX_PAYLOAD_BYTES = 256 * 1024;

const MAGIC = Buffer.from(RESTORE_JOURNAL_ENVELOPE_MAGIC_TEXT, "ascii");
const KIND_OFFSET = MAGIC.length;
const LENGTH_OFFSET = KIND_OFFSET + 1;
const DIGEST_OFFSET = LENGTH_OFFSET + 4;
const DIGEST_BYTES = 32;
export const RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES = DIGEST_OFFSET + DIGEST_BYTES;

export type RestoreJournalEnvelopeKind = "record" | "head";

function kindByte(kind: RestoreJournalEnvelopeKind): number {
  return kind === "record" ? 1 : 2;
}

function decodeKind(value: number): RestoreJournalEnvelopeKind {
  if (value === 1) return "record";
  if (value === 2) return "head";
  throw new Error("invalid restore journal envelope kind");
}

function payloadBytes(payload: string): Buffer {
  if (typeof payload !== "string") throw new Error("restore journal payload must be a string");
  const bytes = Buffer.from(payload, "utf8");
  // Buffer's UTF-8 encoder replaces lone surrogate code points. Refuse that lossy conversion so
  // an adapter never acknowledges bytes that differ from the caller's canonical record.
  if (bytes.toString("utf8") !== payload) {
    throw new Error("restore journal payload must be valid UTF-8");
  }
  if (bytes.length > RESTORE_JOURNAL_MAX_PAYLOAD_BYTES) {
    throw new Error("restore journal payload is too large");
  }
  return bytes;
}

/** A dedicated integrity envelope. It deliberately has no data/tombstone variant or delete form. */
export function encodeRestoreJournalEnvelope(
  kind: RestoreJournalEnvelopeKind,
  payload: string,
): Buffer {
  const body = payloadBytes(payload);
  const header = Buffer.alloc(RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES);
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

export function decodeRestoreJournalEnvelope(
  expectedKind: RestoreJournalEnvelopeKind,
  envelope: Buffer,
): string {
  if (
    envelope.length < RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES
    || !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("invalid restore journal envelope");
  }
  const kind = decodeKind(envelope.readUInt8(KIND_OFFSET));
  if (kind !== expectedKind) throw new Error("invalid restore journal envelope kind");
  const length = envelope.readUInt32BE(LENGTH_OFFSET);
  if (
    length > RESTORE_JOURNAL_MAX_PAYLOAD_BYTES
    || envelope.length !== RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES + length
  ) {
    throw new Error("invalid restore journal envelope length");
  }
  const expectedDigest = envelope.subarray(DIGEST_OFFSET, DIGEST_OFFSET + DIGEST_BYTES);
  const body = envelope.subarray(RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES);
  const actualDigest = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(body)
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error("invalid restore journal envelope checksum");
  }
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("invalid restore journal envelope UTF-8");
  }
  // A second bound protects callers if the envelope limits are changed independently later.
  payloadBytes(payload);
  return payload;
}
