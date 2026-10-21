import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { externalId } from "@agent-service/protocol";

const MAX_BYTES = 256 * 1024;
const VERSION = "provider-key-pool-v1" as const;
const MULTI_VERSION = "provider-key-pools-v2" as const;
const MULTI_MAX_BYTES = 1024 * 1024;
export interface ProviderKeyPoolSlot { readonly id: string; readonly version: string; readonly apiKey: string }
export interface ProviderKeyPoolConfig {
  readonly version: typeof VERSION; readonly providerId: string; readonly slots: readonly ProviderKeyPoolSlot[];
}
export interface ProviderKeyPoolInventory {
  readonly version: typeof VERSION; readonly providerId: string;
  readonly slots: readonly Readonly<{ id: string; version: string }>[];
}
export interface LoadedProviderKeyPool { readonly config: ProviderKeyPoolConfig; readonly inventory: ProviderKeyPoolInventory }
export interface ProviderKeyPoolsInventory { readonly version: typeof MULTI_VERSION; readonly providers: readonly ProviderKeyPoolInventory[] }
export interface LoadedProviderKeyPools {
  readonly version: typeof VERSION | typeof MULTI_VERSION;
  readonly providers: readonly LoadedProviderKeyPool[];
  readonly inventory: ProviderKeyPoolInventory | ProviderKeyPoolsInventory;
}
export class ProviderKeyPoolReadError extends Error {
  readonly code = "provider_key_pool_invalid";
  constructor() { super("Provider key pool configuration is invalid."); this.name = "ProviderKeyPoolReadError"; }
}
function invalid(): never { throw new ProviderKeyPoolReadError(); }

/** JSON.parse validates the grammar, but is never allowed to silently select a duplicate's last value. */
function rejectDuplicateKeys(raw: string): void {
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(raw[offset] ?? "x")) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < raw.length) {
      if (raw[offset] === "\\") offset += 2;
      else if (raw[offset++] === '"') return JSON.parse(raw.slice(start, offset)) as string;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64) invalid();
    whitespace();
    if (raw[offset] === "{") {
      offset++; whitespace(); const keys = new Set<string>();
      if (raw[offset] === "}") { offset++; return; }
      for (;;) {
        const key = string(); if (keys.has(key)) invalid(); keys.add(key);
        whitespace(); offset++; value(depth + 1); whitespace();
        if (raw[offset++] === "}") return;
        whitespace();
      }
    }
    if (raw[offset] === "[") {
      offset++; whitespace(); if (raw[offset] === "]") { offset++; return; }
      for (;;) { value(depth + 1); whitespace(); if (raw[offset++] === "]") return; }
    }
    if (raw[offset] === '"') { string(); return; }
    while (offset < raw.length && !/[\x20\t\r\n,\]}]/.test(raw[offset]!)) offset++;
  };
  value(0); whitespace(); if (offset !== raw.length) invalid();
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || /[^A-Za-z0-9._-]/.test(value)) invalid();
  return value;
}

/** Private one-process snapshot. Cross-restart slot/version non-reuse is the operator's responsibility. */
export function parseProviderKeyPool(raw: string): LoadedProviderKeyPool {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") < 1 || Buffer.byteLength(raw, "utf8") > MAX_BYTES) invalid();
    const parsed: unknown = JSON.parse(raw); rejectDuplicateKeys(raw);
    const input = object(parsed, ["version", "providerId", "slots"]);
    if (input.version !== VERSION) invalid();
    const provider = externalId.safeParse(input.providerId); if (!provider.success) invalid();
    if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 32) invalid();
    const ids = new Set<string>();
    const slots = input.slots.map(value => {
      const slot = object(value, ["id", "version", "apiKey"]), id = identity(slot.id), version = identity(slot.version);
      if (ids.has(id)) invalid(); ids.add(id);
      if (typeof slot.apiKey !== "string" || slot.apiKey.length < 1 || slot.apiKey.length > 4096
        || /[^\x21-\x7e]/.test(slot.apiKey)) invalid();
      return Object.freeze({ id, version, apiKey: slot.apiKey });
    });
    const config: ProviderKeyPoolConfig = Object.freeze({ version: VERSION, providerId: provider.data, slots: Object.freeze(slots) });
    const inventory: ProviderKeyPoolInventory = Object.freeze({ version: VERSION, providerId: provider.data,
      slots: Object.freeze(slots.map(({ id, version }) => Object.freeze({ id, version }))) });
    // No secret-derived digest or filesystem identity is part of this public inventory.
    return Object.freeze({ config, inventory });
  } catch (error) {
    throw error instanceof ProviderKeyPoolReadError ? error : new ProviderKeyPoolReadError();
  }
}

/** Additive multi-provider input; the original v1 parser intentionally still rejects v2. */
export function parseProviderKeyPools(raw: string): LoadedProviderKeyPools {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") < 1 || Buffer.byteLength(raw, "utf8") > MULTI_MAX_BYTES) invalid();
    const parsed: unknown = JSON.parse(raw); rejectDuplicateKeys(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "version" in parsed && parsed.version === VERSION) {
      const pool = parseProviderKeyPool(raw);
      return Object.freeze({ version: VERSION, providers: Object.freeze([pool]), inventory: pool.inventory });
    }
    const input = object(parsed, ["version", "providers"]);
    if (input.version !== MULTI_VERSION || !Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 16) invalid();
    const ids = new Set<string>();
    const providers = input.providers.map(value => {
      const pool = parseProviderKeyPool(JSON.stringify(value));
      if (ids.has(pool.config.providerId)) invalid(); ids.add(pool.config.providerId); return pool;
    });
    return Object.freeze({ version: MULTI_VERSION, providers: Object.freeze(providers),
      inventory: Object.freeze({ version: MULTI_VERSION, providers: Object.freeze(providers.map(pool => pool.inventory)) }) });
  } catch (error) { throw error instanceof ProviderKeyPoolReadError ? error : new ProviderKeyPoolReadError(); }
}

/** Bounded, leaf-no-follow file input. A failure never retains a path, native message, secret, or cause. */
async function readProtectedPool<T>(path: string, maximum: number, parse: (raw: string) => T): Promise<T> {
  let file: FileHandle | undefined, bytes: Buffer | undefined, result: T | undefined;
  let failure: ProviderKeyPoolReadError | undefined;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || path.includes("\0")) invalid();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum || (before.mode & 0o077) !== 0 || before.nlink !== 1
      || process.getuid && before.uid !== process.getuid()) invalid();
    bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, length);
      if (next.bytesRead === 0) break;
      length += next.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || length > maximum || !after.isFile()
      || ["dev", "ino", "uid", "mode", "nlink", "mtimeMs", "ctimeMs", "size"].some(key =>
        before[key as keyof typeof before] !== after[key as keyof typeof after])) invalid();
    result = parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    failure = error instanceof ProviderKeyPoolReadError ? error : new ProviderKeyPoolReadError();
  } finally {
    try { await file?.close(); }
    catch { failure ??= new ProviderKeyPoolReadError(); }
    finally { bytes?.fill(0); }
  }
  if (failure) throw failure;
  if (!result) return invalid();
  return result;
}

export function readProviderKeyPool(path: string): Promise<LoadedProviderKeyPool> {
  return readProtectedPool(path, MAX_BYTES, parseProviderKeyPool);
}
export function readProviderKeyPools(path: string): Promise<LoadedProviderKeyPools> {
  return readProtectedPool(path, MULTI_MAX_BYTES, parseProviderKeyPools);
}
