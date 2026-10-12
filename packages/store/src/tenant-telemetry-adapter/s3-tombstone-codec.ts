import { createHash, timingSafeEqual } from "node:crypto";

export const TENANT_TELEMETRY_S3_TOMBSTONE_MAGIC = "ASTOMB01" as const;
export const TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE =
  "application/vnd.agent-service.telemetry-tombstone-v1" as const;
export const TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES = 44 as const;
export const TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES = 4096 as const;

function digest(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** Content-free, self-checking replacement for an artifact at exactly the artifact's own key. */
export function encodeTenantTelemetryS3Tombstone(bodyJson: string): Buffer {
  const body = Buffer.from(bodyJson, "utf8");
  if (body.byteLength < 1 || body.byteLength > TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES) {
    throw new Error("tenant telemetry S3 tombstone length is invalid");
  }
  const result = Buffer.allocUnsafe(TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES + body.byteLength);
  result.write(TENANT_TELEMETRY_S3_TOMBSTONE_MAGIC, 0, "ascii");
  result.writeUInt32BE(body.byteLength, 8);
  digest(body).copy(result, 12);
  body.copy(result, TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES);
  return result;
}

export function decodeTenantTelemetryS3Tombstone(bytes: Uint8Array): string {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (source.byteLength < TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES
    || source.subarray(0, 8).toString("ascii") !== TENANT_TELEMETRY_S3_TOMBSTONE_MAGIC) {
    throw new Error("tenant telemetry S3 tombstone header is invalid");
  }
  const bodyLength = source.readUInt32BE(8);
  if (bodyLength < 1 || bodyLength > TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES
    || source.byteLength !== TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES + bodyLength) {
    throw new Error("tenant telemetry S3 tombstone length is invalid");
  }
  const body = source.subarray(TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES);
  if (!timingSafeEqual(source.subarray(12, 44), digest(body))) {
    throw new Error("tenant telemetry S3 tombstone checksum is invalid");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("tenant telemetry S3 tombstone UTF-8 is invalid");
  }
}
