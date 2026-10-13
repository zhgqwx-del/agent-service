import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  telemetryCaptureLogsSourceRefSha256, telemetryOpaqueRefSha256,
} from "../src/index.js";

const KEY = Buffer.alloc(32, 0x49);
const UUID = "0199f7a6-1234-7abc-8def-0123456789ab";

describe("v2 telemetry capture source refs", () => {
  it("derives tenant-bound, kind-separated keyed refs without expanding logger refs", () => {
    const session = telemetryCaptureLogsSourceRefSha256("session", "tenant-a", `sess_${UUID}`, KEY);
    const turn = telemetryCaptureLogsSourceRefSha256("turn", "tenant-a", `turn_${UUID}`, KEY);
    const item = telemetryCaptureLogsSourceRefSha256("item", "tenant-a", `item_${UUID}`, KEY);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(session).toBe(telemetryCaptureLogsSourceRefSha256("session", "tenant-a", `sess_${UUID}`, KEY));
    expect(new Set([session, turn, item]).size).toBe(3);
    expect(session).not.toBe(telemetryCaptureLogsSourceRefSha256(
      "session", "tenant-b", `sess_${UUID}`, KEY,
    ));
    expect(session).not.toBe(telemetryCaptureLogsSourceRefSha256(
      "session", "tenant-a", `sess_${UUID}`, Buffer.alloc(32, 0x4a),
    ));
    expect(session).not.toBe(createHash("sha256").update(`sess_${UUID}`).digest("hex"));
    expect(session).not.toBe(telemetryOpaqueRefSha256("session", `sess_${UUID}`, KEY));
    const hypotheticalTraceRef = createHmac("sha256", KEY)
      .update("agent-service/tenant-telemetry-capture-traces-source-ref/v2\0", "utf8");
    for (const value of ["session", "tenant-a", `sess_${UUID}`]) {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.byteLength);
      hypotheticalTraceRef.update(length).update(bytes);
    }
    expect(session).not.toBe(hypotheticalTraceRef.digest("hex"));
  });

  it("rejects noncanonical or misbound identities and non-256-bit keys", () => {
    for (const [kind, raw] of [
      ["session", `turn_${UUID}`],
      ["turn", `sess_${UUID}`],
      ["item", `item_${UUID.toUpperCase()}`],
      ["item", "item_123"],
    ] as const) {
      expect(() => telemetryCaptureLogsSourceRefSha256(kind, "tenant-a", raw, KEY))
        .toThrow("telemetry capture source identity is invalid");
    }
    expect(() => telemetryCaptureLogsSourceRefSha256(
      "provider" as never, "tenant-a", `sess_${UUID}`, KEY,
    )).toThrow("telemetry capture source kind is invalid");
    for (const tenantId of ["", "x".repeat(129)]) {
      expect(() => telemetryCaptureLogsSourceRefSha256(
        "session", tenantId, `sess_${UUID}`, KEY,
      )).toThrow("telemetry capture tenant identity is invalid");
    }
    for (const key of [Buffer.alloc(31), Buffer.alloc(33)]) {
      expect(() => telemetryCaptureLogsSourceRefSha256(
        "session", "tenant-a", `sess_${UUID}`, key,
      )).toThrow("telemetry capture source ref key must be exactly 32 bytes");
    }
  });
});
