import { createHash, timingSafeEqual } from "node:crypto";
import { TenantTelemetryDispositionCorruptError } from "../tenant-telemetry-disposition.js";

/** Separate wire envelope and media types: v1 objects cannot be read as v2 authority. */
export const TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-grant-journal-head-v2";
export const TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-grant-journal-event-v2";
export const TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_PAYLOAD_BYTES = 256 * 1024;

const MAGIC = Buffer.from("ASTDJP02", "ascii");
const LENGTH_OFFSET = MAGIC.length + 1;
const DIGEST_OFFSET = LENGTH_OFFSET + 4;
const HEADER_BYTES = DIGEST_OFFSET + 32;

export type TenantTelemetryGrantJournalV2EnvelopeKind = "head" | "event";

function kindByte(kind: TenantTelemetryGrantJournalV2EnvelopeKind): number {
  return kind === "head" ? 1 : 2;
}

export function encodeTenantTelemetryGrantJournalV2Envelope(
  kind: TenantTelemetryGrantJournalV2EnvelopeKind,
  payload: string,
): Buffer {
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.toString("utf8") !== payload
    || bytes.length > TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_PAYLOAD_BYTES) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt8(kindByte(kind), MAGIC.length);
  header.writeUInt32BE(bytes.length, LENGTH_OFFSET);
  createHash("sha256")
    .update(header.subarray(0, DIGEST_OFFSET))
    .update(bytes)
    .digest()
    .copy(header, DIGEST_OFFSET);
  return Buffer.concat([header, bytes]);
}

export function decodeTenantTelemetryGrantJournalV2Envelope(
  kind: TenantTelemetryGrantJournalV2EnvelopeKind,
  envelope: Buffer,
): string {
  if (envelope.length < HEADER_BYTES
    || !envelope.subarray(0, MAGIC.length).equals(MAGIC)
    || envelope.readUInt8(MAGIC.length) !== kindByte(kind)) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const length = envelope.readUInt32BE(LENGTH_OFFSET);
  if (length > TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_PAYLOAD_BYTES
    || envelope.length !== HEADER_BYTES + length) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const expected = envelope.subarray(DIGEST_OFFSET, HEADER_BYTES);
  const body = envelope.subarray(HEADER_BYTES);
  const actual = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(body)
    .digest();
  if (!timingSafeEqual(expected, actual)) throw new TenantTelemetryDispositionCorruptError();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new TenantTelemetryDispositionCorruptError();
  }
}

export const TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_ENVELOPE_BYTES =
  HEADER_BYTES + TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_PAYLOAD_BYTES;
