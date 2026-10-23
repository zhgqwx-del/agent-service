import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  assertSessionAuthorityActivationAdmission,
  captureSchemaMetadataReaderConfig,
  captureSessionAuthorityBindingCommand,
  prepareSessionAuthorityBindingCommand,
  type SessionAuthorityBindingCommandInput,
  type SessionAuthorityBindingOperatorContext,
} from "@agent-service/store";

// UNAPPLIED operator-only candidate. No dotenv, runtime DSN fallback or resource work on import.
const KEYS = ["AUTHORITY_MYSQL_URL", "AUTHORITY_COMMAND_FILE", "AUTHORITY_FLEET_STOPPED_ACK",
  "AUTHORITY_EXCLUSIVE_CHANGE_ACK", "AUTHORITY_OPERATION_TIMEOUT_MS", "AUTHORITY_METADATA_SCHEMA",
  "AUTHORITY_METADATA_DEFINER_USER", "AUTHORITY_METADATA_DEFINER_HOST"] as const;
const MAXIMUM = 65_536;
function invalid(): never { throw Error("invalid_configuration"); }
export interface SessionAuthorityOperatorConfiguration {
  readonly url: string; readonly commandFile: string; readonly timeoutMs: number;
  readonly schemaMetadata: SessionAuthorityBindingOperatorContext["schemaMetadata"];
}
function ownEnvironment(env: Readonly<NodeJS.ProcessEnv>): Readonly<Record<string, string>> {
  if (!env || typeof env !== "object" || Array.isArray(env)) invalid();
  const result: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(env)) {
    if (typeof key !== "string" || !key.startsWith("AUTHORITY_")) continue;
    if (!(KEYS as readonly string[]).includes(key)) invalid();
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !("value" in d) || !d.enumerable || typeof d.value !== "string"
      || d.value.length < 1 || Buffer.byteLength(d.value) > 4096 || /[\u0000-\u001f\u007f]/.test(d.value)) invalid();
    result[key] = d.value;
  }
  for (const key of KEYS) if (key !== "AUTHORITY_OPERATION_TIMEOUT_MS" && !Object.hasOwn(result, key)) invalid();
  return Object.freeze(result);
}
function mysqlUrl(value: string): boolean {
  if (value.trim() !== value || !value.startsWith("mysql://") || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value), database = decodeURIComponent(url.pathname.slice(1));
    return url.protocol === "mysql:" && !!url.hostname && !url.search && !url.hash
      && !value.includes("?") && !value.includes("#") && /^\/[^/]+$/.test(url.pathname)
      && database.length > 0 && database.length <= 64 && database.trim() === database && !/[\\/\u0000-\u001f\u007f]/.test(database);
  } catch { return false; }
}
function absolute(value: string): void {
  if (!isAbsolute(value) || resolve(value) !== value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
}
export function parseSessionAuthorityOperatorConfiguration(env: Readonly<NodeJS.ProcessEnv>): SessionAuthorityOperatorConfiguration {
  try {
    const input = ownEnvironment(env), url = input.AUTHORITY_MYSQL_URL!, commandFile = input.AUTHORITY_COMMAND_FILE!;
    if (!mysqlUrl(url) || input.AUTHORITY_FLEET_STOPPED_ACK !== "all-application-writers-stopped-v1"
      || input.AUTHORITY_EXCLUSIVE_CHANGE_ACK !== "exclusive-authority-permissions-window-v1") invalid();
    absolute(commandFile);
    const raw = input.AUTHORITY_OPERATION_TIMEOUT_MS ?? "120000";
    if (!/^[1-9][0-9]*$/.test(raw)) invalid();
    const timeoutMs = Number(raw);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) invalid();
    const schemaMetadata = captureSchemaMetadataReaderConfig({ metadataSchema: input.AUTHORITY_METADATA_SCHEMA!,
      trustedDefiner: { user: input.AUTHORITY_METADATA_DEFINER_USER!, host: input.AUTHORITY_METADATA_DEFINER_HOST! } });
    return Object.freeze({ url, commandFile, timeoutMs, schemaMetadata });
  } catch { return invalid(); }
}

/** JSON.parse validates grammar; reject duplicate and escaped duplicate names before capture. */
function parseUnambiguousCommand(raw: string): SessionAuthorityBindingCommandInput {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalid(); }
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") { stack.push(raw[i] === "{" ? new Set() : null); if (stack.length > 12) invalid(); }
    else if (raw[i] === "}" || raw[i] === "]") stack.pop();
    else if (raw[i] === '"') {
      const start = i;
      for (i++; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break; }
      const token: unknown = JSON.parse(raw.slice(start, i + 1));
      if (typeof token !== "string" || /[\uD800-\uDFFF]/u.test(token)) invalid();
      let after = i + 1; while (after < raw.length && /\s/.test(raw[after]!)) after++;
      if (raw[after] === ":") {
        const keys = stack.at(-1); if (!keys || keys.has(token)) invalid(); keys.add(token);
      }
    }
  }
  let nodes = 0;
  const check = (value: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 12) invalid();
    if (typeof value === "number" && !Number.isFinite(value)) invalid();
    if (value !== null && typeof value === "object") for (const child of Object.values(value)) check(child, depth + 1);
  };
  check(parsed, 0);
  // The store's descriptor-capturing parser independently checks the exact nested authority shape.
  return parsed as SessionAuthorityBindingCommandInput;
}
function identity(stat: Awaited<ReturnType<typeof lstat>>): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
async function directory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) invalid();
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
/** Private regular input with bounded read and real close; no input or FS diagnostics escape. */
export async function loadSessionAuthorityOperatorContext(config: SessionAuthorityOperatorConfiguration,
  signal?: AbortSignal): Promise<SessionAuthorityBindingOperatorContext> {
  let file: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  let context: SessionAuthorityBindingOperatorContext | undefined, failed = false;
  try {
    signal?.throwIfAborted();
    const parent = await directory(dirname(config.commandFile)), before = await lstat(config.commandFile);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(config.commandFile) !== config.commandFile) invalid();
    signal?.throwIfAborted();
    file = await open(config.commandFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const start = await file.stat();
    if (!start.isFile() || start.size < 2 || start.size > MAXIMUM || (start.mode & 0o7777) !== 0o600
      || start.nlink !== 1 || start.uid !== process.getuid?.() || identity(before) !== identity(start)) invalid();
    bytes = Buffer.alloc(MAXIMUM + 1); let count = 0;
    while (count < bytes.length) {
      signal?.throwIfAborted(); const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break; count += read.bytesRead;
    }
    signal?.throwIfAborted();
    if (count !== start.size || count > MAXIMUM || identity(start) !== identity(await file.stat())
      || identity(start) !== identity(await lstat(config.commandFile)) || parent !== await directory(dirname(config.commandFile))) invalid();
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    if (!Buffer.from(raw).equals(bytes.subarray(0, count))) invalid();
    const command = prepareSessionAuthorityBindingCommand(parseUnambiguousCommand(raw));
    captureSessionAuthorityBindingCommand(command); // No plain JSON can be used as the private port.
    context = Object.freeze({ command, schemaMetadata: config.schemaMetadata, assertNativeAdmission: assertSessionAuthorityActivationAdmission });
  } catch { failed = true; }
  finally {
    try { await file?.close(); } catch { failed = true; }
    finally { bytes?.fill(0); }
  }
  if (failed || !context) invalid(); signal?.throwIfAborted(); return context;
}
