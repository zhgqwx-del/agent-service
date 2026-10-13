import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTelemetryCaptureRefKey, tenantTelemetryOperatorRefKeyPath } from "../src/telemetry-capture-ref-key.js";

describe("telemetry capture operator protected ref key", () => {
  it("shares optional file authority without accepting any ambient application hex key", () => {
    expect(tenantTelemetryOperatorRefKeyPath({})).toBeUndefined();
    expect(tenantTelemetryOperatorRefKeyPath({ TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "/private/protected-key" })).toBe("/private/protected-key");
    for (const env of [{ TENANT_TELEMETRY_REF_KEY: "" }, { TENANT_TELEMETRY_REF_KEY: "private" },
      { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "" }, { TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE: "relative" }]) {
      expect(() => tenantTelemetryOperatorRefKeyPath(env)).toThrow("invalid_configuration");
    }
  });
  it("reads exactly 32 raw bytes from an owner-only regular file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capture-key-"));
    try {
      const path = join(directory, "key");
      const key = Buffer.alloc(32, 47);
      await writeFile(path, key, { mode: 0o600 });
      const read = await readTelemetryCaptureRefKey(path);
      expect(read instanceof Uint8Array).toBe(true);
      expect(read.length).toBe(32);
      expect(read.equals(key), "exact protected raw bytes required").toBe(true);
      read.fill(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects relative paths, symlinks, readable-by-others files and hex text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capture-key-negative-"));
    try {
      const path = join(directory, "key");
      await writeFile(path, Buffer.alloc(32, 48), { mode: 0o600 });
      await expect(readTelemetryCaptureRefKey("relative-key")).rejects.toThrow("invalid_configuration");
      const link = join(directory, "link");
      await symlink(path, link);
      await expect(readTelemetryCaptureRefKey(link)).rejects.toThrow();
      await chmod(path, 0o640);
      await expect(readTelemetryCaptureRefKey(path)).rejects.toThrow("invalid_configuration");
      await chmod(path, 0o600);
      await writeFile(path, "30".repeat(32));
      await expect(readTelemetryCaptureRefKey(path)).rejects.toThrow("invalid_configuration");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("sanitizes path-bearing filesystem diagnostics", async () => {
    await expect(readTelemetryCaptureRefKey("/missing/private-capture-secret-key"))
      .rejects.not.toThrow("private-capture-secret-key");
  });

  it("rejects a FIFO without waiting for a writer to open it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capture-key-fifo-"));
    try {
      const path = join(directory, "fifo");
      execFileSync("mkfifo", [path], { stdio: "ignore" });
      await expect(readTelemetryCaptureRefKey(path)).rejects.toThrow("invalid_configuration");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
