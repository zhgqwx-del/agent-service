import { createHmac } from "node:crypto";
import { externalId, isCanonicalId } from "./common.js";

export type TelemetryCaptureSourceKind = "session" | "turn" | "item";

/**
 * Content-free, logs-only v2 source identity for a future crash-atomic producer.
 * This is distinct from the v1 structured-logger opaque-ref namespace and does
 * not add `item` to the logger's allowlisted field vocabulary. A future trace
 * producer must use a different protocol/namespace. Persist only the 64-character
 * result, never the raw source ID or key.
 */
export function telemetryCaptureLogsSourceRefSha256(
  kind: TelemetryCaptureSourceKind,
  tenantId: string,
  sourceId: string,
  refKey: Uint8Array,
): string {
  if (kind !== "session" && kind !== "turn" && kind !== "item") {
    throw new TypeError("telemetry capture source kind is invalid");
  }
  if (!externalId.safeParse(tenantId).success) {
    throw new TypeError("telemetry capture tenant identity is invalid");
  }
  const prefix = kind === "session" ? "sess" : kind;
  if (typeof sourceId !== "string" || !isCanonicalId(prefix, sourceId)) {
    throw new TypeError("telemetry capture source identity is invalid");
  }
  if (!(refKey instanceof Uint8Array) || refKey.byteLength !== 32) {
    throw new TypeError("telemetry capture source ref key must be exactly 32 bytes");
  }
  const hmac = createHmac("sha256", refKey);
  hmac.update("agent-service/tenant-telemetry-capture-logs-source-ref/v2\0", "utf8");
  for (const value of [kind, tenantId, sourceId]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    hmac.update(length).update(bytes);
  }
  return hmac.digest("hex");
}
