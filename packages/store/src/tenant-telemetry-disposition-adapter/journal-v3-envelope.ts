import { createHash, timingSafeEqual } from "node:crypto";
import { TenantTelemetryDispositionCorruptError } from "../tenant-telemetry-disposition.js";

export const TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-disposition-head-v3";
export const TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-disposition-event-v3";
const MAGIC = Buffer.from("ASTDJP03", "ascii");
const LENGTH_OFFSET = MAGIC.length + 1;
const DIGEST_OFFSET = LENGTH_OFFSET + 4;
const HEADER_BYTES = DIGEST_OFFSET + 32;
const MAX_PAYLOAD = 256 * 1024;
export const TENANT_TELEMETRY_DISPOSITION_V3_MAX_ENVELOPE_BYTES = HEADER_BYTES + MAX_PAYLOAD;
export type TenantTelemetryDispositionV3EnvelopeKind = "head" | "event";

function kindByte(kind: TenantTelemetryDispositionV3EnvelopeKind): number {
  return kind === "head" ? 1 : 2;
}

export function encodeTenantTelemetryDispositionV3Envelope(
  kind: TenantTelemetryDispositionV3EnvelopeKind,
  payload: string,
): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.toString("utf8") !== payload || body.length > MAX_PAYLOAD) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt8(kindByte(kind), MAGIC.length);
  header.writeUInt32BE(body.length, LENGTH_OFFSET);
  createHash("sha256").update(header.subarray(0, DIGEST_OFFSET)).update(body)
    .digest().copy(header, DIGEST_OFFSET);
  return Buffer.concat([header, body]);
}

export function decodeTenantTelemetryDispositionV3Envelope(
  kind: TenantTelemetryDispositionV3EnvelopeKind,
  envelope: Buffer,
): string {
  if (envelope.length < HEADER_BYTES
    || !envelope.subarray(0, MAGIC.length).equals(MAGIC)
    || envelope.readUInt8(MAGIC.length) !== kindByte(kind)) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const length = envelope.readUInt32BE(LENGTH_OFFSET);
  if (length > MAX_PAYLOAD || envelope.length !== HEADER_BYTES + length) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const body = envelope.subarray(HEADER_BYTES);
  const expected = envelope.subarray(DIGEST_OFFSET, HEADER_BYTES);
  const actual = createHash("sha256").update(envelope.subarray(0, DIGEST_OFFSET))
    .update(body).digest();
  if (!timingSafeEqual(actual, expected)) throw new TenantTelemetryDispositionCorruptError();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new TenantTelemetryDispositionCorruptError();
  }
}
