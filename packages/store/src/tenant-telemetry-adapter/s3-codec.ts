import { createHash, timingSafeEqual } from "node:crypto";

export const TENANT_TELEMETRY_S3_ENVELOPE_MAGIC = "ASTELM01" as const;
export const TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES = 80 as const;
export const TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES = 8_192 as const;
export const TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES = 262_144 as const;
export const TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-artifact-v1" as const;

export interface DecodedTenantTelemetryS3Envelope {
  metadataJson: string;
  payloadJson: string;
}

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function byteLength(value: string, maximum: number, name: string): number {
  const length = Buffer.byteLength(value, "utf8");
  if (length < 1 || length > maximum) {
    throw new Error(`tenant telemetry S3 envelope ${name} length is invalid`);
  }
  return length;
}

/**
 * A single, self-contained immutable object. Both closed JSON sections carry an independent
 * checksum and the fixed header carries their exact lengths, so truncation, concatenation and
 * metadata/payload substitution are rejected before either section is parsed.
 */
export function encodeTenantTelemetryS3Envelope(
  metadataJson: string,
  payloadJson: string,
): Buffer {
  const metadataLength = byteLength(
    metadataJson,
    TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES,
    "metadata",
  );
  const payloadLength = byteLength(
    payloadJson,
    TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES,
    "payload",
  );
  const metadata = Buffer.from(metadataJson, "utf8");
  const payload = Buffer.from(payloadJson, "utf8");
  const result = Buffer.allocUnsafe(
    TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES + metadataLength + payloadLength,
  );
  result.write(TENANT_TELEMETRY_S3_ENVELOPE_MAGIC, 0, "ascii");
  result.writeUInt32BE(metadataLength, 8);
  result.writeUInt32BE(payloadLength, 12);
  digest(metadata).copy(result, 16);
  digest(payload).copy(result, 48);
  metadata.copy(result, TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES);
  payload.copy(result, TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES + metadataLength);
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("tenant telemetry S3 envelope contains invalid UTF-8");
  }
}

export function decodeTenantTelemetryS3Envelope(
  bytes: Uint8Array,
): DecodedTenantTelemetryS3Envelope {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (source.length < TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES
    || source.subarray(0, 8).toString("ascii") !== TENANT_TELEMETRY_S3_ENVELOPE_MAGIC) {
    throw new Error("tenant telemetry S3 envelope header is invalid");
  }
  const metadataLength = source.readUInt32BE(8);
  const payloadLength = source.readUInt32BE(12);
  if (metadataLength < 1 || metadataLength > TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES
    || payloadLength < 1 || payloadLength > TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES
    || source.length !== TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES
      + metadataLength + payloadLength) {
    throw new Error("tenant telemetry S3 envelope length is invalid");
  }
  const metadata = source.subarray(
    TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES,
    TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES + metadataLength,
  );
  const payload = source.subarray(
    TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES + metadataLength,
  );
  if (!timingSafeEqual(source.subarray(16, 48), digest(metadata))) {
    throw new Error("tenant telemetry S3 envelope metadata checksum is invalid");
  }
  if (!timingSafeEqual(source.subarray(48, 80), digest(payload))) {
    throw new Error("tenant telemetry S3 envelope payload checksum is invalid");
  }
  return {
    metadataJson: decodeUtf8(metadata),
    payloadJson: decodeUtf8(payload),
  };
}
