import { constants } from "node:fs";
import { chmod, link, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProviderKeyPool, parseProviderKeyPools, ProviderKeyPoolReadError, readProviderKeyPool, readProviderKeyPools } from "../src/provider-key-pool.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, open: vi.fn(actual.open) };
});
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const mockedOpen = vi.mocked(open), secret = "multi-pool-private-key-canary", directories: string[] = [];
const pool = (providerId = "dashscope") => ({ version: "provider-key-pool-v1", providerId,
  slots: [{ id: "slot-A", version: "v1", apiKey: secret + providerId }] });
const multi = () => ({ version: "provider-key-pools-v2", providers: [pool(), pool("deepseek")] });
afterEach(async () => { vi.restoreAllMocks(); mockedOpen.mockImplementation(native.open);
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
function fixed(error: unknown) {
  expect(error).toBeInstanceOf(ProviderKeyPoolReadError);
  expect(error).toMatchObject({ code: "provider_key_pool_invalid", message: "Provider key pool configuration is invalid." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false); expect(String(error)).not.toContain(secret);
}
function reject(raw: string) { try { parseProviderKeyPools(raw); throw new Error("Invalid multi-pool accepted."); } catch (error) { fixed(error); } }
async function file(raw = JSON.stringify(multi())) {
  const directory = await mkdtemp(join(tmpdir(), "provider-key-pools-")); directories.push(directory); await chmod(directory, 0o700);
  const path = join(directory, "private.json"); await writeFile(path, raw, { mode: 0o600 }); return { path, directory };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("bounded multi-platform protected key pools", () => {
  it("wraps v1 without changing its config or public inventory and leaves the original API v1-only", () => {
    const raw = JSON.stringify(pool()), original = parseProviderKeyPool(raw), loaded = parseProviderKeyPools(raw);
    expect(loaded).toEqual({ version: "provider-key-pool-v1", providers: [original], inventory: original.inventory });
    expect(() => parseProviderKeyPool(JSON.stringify(multi()))).toThrow(ProviderKeyPoolReadError);
    expect(Object.isFrozen(loaded)).toBe(true); expect(Object.isFrozen(loaded.providers)).toBe(true);
  });
  it("keeps every provider's own slots and excludes secrets from the complete frozen inventory", () => {
    const loaded = parseProviderKeyPools(JSON.stringify(multi()));
    expect(loaded.providers.map(value => value.config)).toEqual(multi().providers);
    expect(loaded.inventory).toEqual({ version: "provider-key-pools-v2", providers: multi().providers.map(({ providerId, slots }) => ({
      version: "provider-key-pool-v1", providerId, slots: slots.map(({ id, version }) => ({ id, version })),
    })) });
    expect(JSON.stringify(loaded.inventory)).not.toContain(secret);
    for (const value of [loaded, loaded.providers, loaded.inventory, ...loaded.providers.flatMap(p =>
      [p, p.config, p.config.slots, p.config.slots[0], p.inventory, p.inventory.slots, p.inventory.slots[0]])]) expect(Object.isFrozen(value)).toBe(true);
    if (loaded.inventory.version !== "provider-key-pools-v2") throw new Error("Expected multi inventory.");
    expect(Object.isFrozen(loaded.inventory.providers)).toBe(true);
    expect(loaded.providers[0]!.config.slots[0]!.apiKey).not.toBe(loaded.providers[1]!.config.slots[0]!.apiKey);
  });
  it("accepts sixteen exact Unicode provider identities with thirty-two independently bounded slots", () => {
    const providers = Array.from({ length: 16 }, (_, i) => ({ ...pool("中".repeat(127) + String.fromCharCode(65 + i)),
      slots: Array.from({ length: 32 }, (_, n) => ({ id: `s${n}`, version: "v", apiKey: "key" })) }));
    expect(parseProviderKeyPools(JSON.stringify({ version: "provider-key-pools-v2", providers })).providers).toHaveLength(16);
  });
  it("uses a one-MiB new-loader bound without relaxing the old 256-KiB v1 bound", () => {
    const raw = JSON.stringify(multi()), padded = raw + " ".repeat(1024 * 1024 - Buffer.byteLength(raw));
    expect(parseProviderKeyPools(padded).providers).toHaveLength(2); reject(padded + " ");
    const v1 = JSON.stringify(pool()) + " ".repeat(256 * 1024);
    reject(v1); expect(() => parseProviderKeyPool(v1)).toThrow(ProviderKeyPoolReadError);
  });
  it.each([
    ["null", "null"], ["array", "[]"], ["missing", '{}'], ["version", '{"version":"provider-key-pools-v3","providers":[]}'],
    ["empty", JSON.stringify({ ...multi(), providers: [] })],
    ["seventeen", JSON.stringify({ ...multi(), providers: Array.from({ length: 17 }, (_, i) => pool(`p${i}`)) })],
    ["duplicate provider", JSON.stringify({ ...multi(), providers: [pool(), pool()] })],
    ["unknown top", JSON.stringify({ ...multi(), secret })],
    ["unknown provider", JSON.stringify({ ...multi(), providers: [{ ...pool(), secret }] })],
    ["missing provider key", JSON.stringify({ ...multi(), providers: [{ ...pool(), slots: [{ id: "a", version: "v" }] }] })],
    ["nested multi", JSON.stringify({ ...multi(), providers: [multi()] })],
    ["escaped duplicate", '{"version":"provider-key-pools-v2","providers":[],"\\u0070roviders":[]}'],
    ["nested duplicate", '{"version":"provider-key-pools-v2","providers":[{"version":"provider-key-pool-v1","providerId":"p","slots":[{"id":"a","version":"v","apiKey":"x","apiKey":"y"}]}]}'],
  ])("rejects %s with fixed diagnostics", (_label, raw) => { reject(raw); });
  it("reads both formats using the same native no-follow/nonblocking private-file checks", async () => {
    const f = await file(); expect((await readProviderKeyPools(f.path)).providers).toHaveLength(2);
    expect(mockedOpen).toHaveBeenLastCalledWith(f.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await expect(readProviderKeyPool(f.path)).rejects.toBeInstanceOf(ProviderKeyPoolReadError);
    await writeFile(f.path, JSON.stringify(pool())); expect((await readProviderKeyPools(f.path)).version).toBe("provider-key-pool-v1");
  });
  it("rejects symlinks, hardlinks, nonprivate mode and malformed UTF-8 without accepting a snapshot", async () => {
    const f = await file(), leaf = join(f.directory, "link"), hard = join(f.directory, "hard");
    await symlink(f.path, leaf); await expect(readProviderKeyPools(leaf)).rejects.toBeInstanceOf(ProviderKeyPoolReadError);
    await chmod(f.path, 0o640); await expect(readProviderKeyPools(f.path)).rejects.toBeInstanceOf(ProviderKeyPoolReadError);
    await chmod(f.path, 0o600); await writeFile(f.path, Buffer.from([0xc3, 0x28]));
    await expect(readProviderKeyPools(f.path)).rejects.toBeInstanceOf(ProviderKeyPoolReadError);
    await link(f.path, hard); await expect(readProviderKeyPools(f.path)).rejects.toBeInstanceOf(ProviderKeyPoolReadError);
  });
  it("does not publish a parsed multi snapshot before native close and rejects a close failure", async () => {
    const f = await file(), handle = await native.open(f.path, "r"), nativeClose = handle.close.bind(handle), entered = deferred(), release = deferred();
    vi.spyOn(handle, "close").mockImplementation(async () => { entered.resolve(); await release.promise; await nativeClose(); throw new Error(secret); });
    mockedOpen.mockResolvedValueOnce(handle); let settled = false;
    const pending = readProviderKeyPools(f.path).then(() => { settled = true; throw new Error("Unexpected snapshot."); }, error => { settled = true; fixed(error); });
    try { await entered.promise; expect(settled).toBe(false); } finally { release.resolve(); await pending; }
    expect(settled).toBe(true);
  });
});
