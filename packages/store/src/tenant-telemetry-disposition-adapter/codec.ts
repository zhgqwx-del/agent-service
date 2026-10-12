import { createHash, timingSafeEqual } from "node:crypto";

export const TENANT_TELEMETRY_DISPOSITION_ENVELOPE_MAGIC_TEXT = "ASTDJP01";
export const TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-disposition-event-v1";
export const TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-disposition-head-v1";
export const TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-disposition-probe-v1";
export const TENANT_TELEMETRY_DISPOSITION_MAX_PAYLOAD_BYTES = 256 * 1024;

const MAGIC = Buffer.from(TENANT_TELEMETRY_DISPOSITION_ENVELOPE_MAGIC_TEXT, "ascii");
const KIND_OFFSET = MAGIC.length;
const LENGTH_OFFSET = KIND_OFFSET + 1;
const DIGEST_OFFSET = LENGTH_OFFSET + 4;
const DIGEST_BYTES = 32;
export const TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES =
  DIGEST_OFFSET + DIGEST_BYTES;

export type TenantTelemetryDispositionEnvelopeKind = "event" | "head" | "probe";

function kindByte(kind: TenantTelemetryDispositionEnvelopeKind): number {
  if (kind === "event") return 1;
  if (kind === "head") return 2;
  return 3;
}

function decodeKind(value: number): TenantTelemetryDispositionEnvelopeKind {
  if (value === 1) return "event";
  if (value === 2) return "head";
  if (value === 3) return "probe";
  throw new Error("invalid tenant telemetry disposition envelope kind");
}

function payloadBytes(payload: string): Buffer {
  if (typeof payload !== "string") {
    throw new Error("tenant telemetry disposition payload must be a string");
  }
  const bytes = Buffer.from(payload, "utf8");
  if (bytes.toString("utf8") !== payload) {
    throw new Error("tenant telemetry disposition payload must be valid UTF-8");
  }
  if (bytes.length > TENANT_TELEMETRY_DISPOSITION_MAX_PAYLOAD_BYTES) {
    throw new Error("tenant telemetry disposition payload is too large");
  }
  return bytes;
}

export function encodeTenantTelemetryDispositionEnvelope(
  kind: TenantTelemetryDispositionEnvelopeKind,
  payload: string,
): Buffer {
  const body = payloadBytes(payload);
  const header = Buffer.alloc(TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES);
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

export function decodeTenantTelemetryDispositionEnvelope(
  expectedKind: TenantTelemetryDispositionEnvelopeKind,
  envelope: Buffer,
): string {
  if (envelope.length < TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES
    || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("invalid tenant telemetry disposition envelope");
  }
  if (decodeKind(envelope.readUInt8(KIND_OFFSET)) !== expectedKind) {
    throw new Error("invalid tenant telemetry disposition envelope kind");
  }
  const length = envelope.readUInt32BE(LENGTH_OFFSET);
  if (length > TENANT_TELEMETRY_DISPOSITION_MAX_PAYLOAD_BYTES
    || envelope.length !== TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES + length) {
    throw new Error("invalid tenant telemetry disposition envelope length");
  }
  const expectedDigest = envelope.subarray(DIGEST_OFFSET, DIGEST_OFFSET + DIGEST_BYTES);
  const body = envelope.subarray(TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES);
  const actualDigest = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(body)
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error("invalid tenant telemetry disposition envelope checksum");
  }
  let payload: string;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("invalid tenant telemetry disposition envelope UTF-8");
  }
  payloadBytes(payload);
  return payload;
}
