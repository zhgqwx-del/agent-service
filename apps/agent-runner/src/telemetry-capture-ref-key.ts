import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Resource-free shared validation for backup/restore's optional protected key. */
export function tenantTelemetryOperatorRefKeyPath(env: NodeJS.ProcessEnv): string | undefined {
  // Application hex input is never authority for an operator, including an explicit empty value.
  if (env.TENANT_TELEMETRY_REF_KEY !== undefined) throw new Error("invalid_configuration");
  const path = env.TENANT_TELEMETRY_OPERATOR_REF_KEY_FILE;
  if (path !== undefined && (path.length === 0 || path.length > 4_096
    || !isAbsolute(path) || path.includes("\0"))) throw new Error("invalid_configuration");
  return path;
}

/** One-shot operators accept raw bytes only, never argv/env key material. */
export async function readTelemetryCaptureRefKey(path: string): Promise<Buffer> {
  if (path.length > 4_096 || !isAbsolute(path) || path.includes("\0")) throw new Error("invalid_configuration");
  let key: Buffer | undefined;
  let file: FileHandle | undefined;
  try {
    // A replaced path may be a FIFO: never block before the regular-file check.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size !== 32 || (before.mode & 0o077) !== 0
      || before.nlink !== 1
      || (process.getuid && before.uid !== process.getuid())) {
      throw new Error("invalid_configuration");
    }
    const bytes = Buffer.alloc(33);
    try {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (bytesRead !== 32 || after.size !== 32 || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino
        || after.uid !== before.uid || after.mode !== before.mode || after.nlink !== 1) throw new Error("invalid_configuration");
      key = Buffer.from(bytes.subarray(0, 32));
    } finally {
      bytes.fill(0);
    }
    await file.close();
    return key;
  } catch {
    key?.fill(0);
    await file?.close().catch(() => {});
    // FS diagnostics include paths. Only the fixed CLI category may escape this boundary.
    throw new Error("invalid_configuration");
  }
}
