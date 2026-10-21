import { constants } from "node:fs";
import { chmod, link, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderKeyPoolReadError, parseProviderKeyPool, readProviderKeyPool } from "../src/provider-key-pool.js";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, open: vi.fn(actual.open) };
});
const native = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const mockedOpen = vi.mocked(open);
const MAX_BYTES = 256 * 1024;
const secret = "private-key-pool-canary";
const pathCanary = "private-key-pool-path-canary";
const document = () => ({ version: "provider-key-pool-v1", providerId: "fixture-provider",
  slots: [{ id: "slot-A", version: "generation-1", apiKey: secret }] });
const json = () => JSON.stringify(document());
const directories: string[] = [];
beforeEach(() => { mockedOpen.mockReset(); mockedOpen.mockImplementation(native.open); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture(bytes: string | Uint8Array = json()) {
  const directory = await mkdtemp(join(tmpdir(), "provider-key-pool-")); directories.push(directory);
  await chmod(directory, 0o700);
  const path = join(directory, pathCanary);
  await writeFile(path, bytes, { mode: 0o600 });
  return { directory, path };
}
function fixed(error: unknown) {
  expect(error).toBeInstanceOf(ProviderKeyPoolReadError);
  expect(error).toMatchObject({ name: "ProviderKeyPoolReadError", code: "provider_key_pool_invalid",
    message: "Provider key pool configuration is invalid." });
  expect(Object.hasOwn(error as object, "cause")).toBe(false);
  expect(JSON.stringify(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(pathCanary);
  expect(String(error)).not.toContain(secret); expect(String(error)).not.toContain(pathCanary);
}
function rejects(raw: string) {
  try { parseProviderKeyPool(raw); throw new Error("Invalid key pool was accepted."); }
  catch (error) { fixed(error); }
}
async function rejectsRead(path: string) {
  try { await readProviderKeyPool(path); throw new Error("Invalid key pool file was accepted."); }
  catch (error) { fixed(error); }
}
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("platform provider key pool strict private JSON", () => {
  it("separates a deeply frozen public inventory from the private credential snapshot", () => {
    const loaded = parseProviderKeyPool(json());
    expect(loaded.config).toEqual(document());
    expect(loaded.inventory).toEqual({ version: "provider-key-pool-v1", providerId: "fixture-provider",
      slots: [{ id: "slot-A", version: "generation-1" }] });
    expect(JSON.stringify(loaded.inventory)).not.toContain(secret);
    expect(Object.keys(loaded.inventory)).toEqual(["version", "providerId", "slots"]);
    for (const value of [loaded, loaded.config, loaded.config.slots, loaded.config.slots[0],
      loaded.inventory, loaded.inventory.slots, loaded.inventory.slots[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(loaded.inventory.slots[0]).not.toBe(loaded.config.slots[0]);
    expect(() => Object.assign(loaded.config.slots[0]!, { apiKey: "replacement" })).toThrow();
  });

  it("does not derive public inventory from secret bytes or claim cross-restart version verification", () => {
    const first = parseProviderKeyPool(json());
    const input = document(); input.slots[0]!.apiKey = "different-protected-secret";
    const second = parseProviderKeyPool(JSON.stringify(input));
    expect(second.config.slots[0]!.apiKey).not.toBe(first.config.slots[0]!.apiKey);
    expect(second.inventory).toEqual(first.inventory);
    // An operator must never provision changed material under the same immutable slot/version.
  });

  it("accepts exact maximum slot/id/version/key/file and externalId bounds", () => {
    const input = { ...document(), providerId: "中".repeat(128), slots: Array.from({ length: 32 }, (_, index) => ({
      id: String(index).padEnd(64, "a"), version: "v".repeat(64), apiKey: "!".repeat(4096),
    })) };
    const raw = JSON.stringify(input), padded = raw + " ".repeat(MAX_BYTES - Buffer.byteLength(raw));
    expect(parseProviderKeyPool(padded).config).toEqual(input);
    rejects(padded + " ");
  });

  it.each([
    ["empty", ""], ["null", "null"], ["array", "[]"], ["number", "1"], ["malformed", "{"],
    ["trailing", json() + " true"], ["unknown top", JSON.stringify({ ...document(), extra: secret })],
    ["wrong document version", JSON.stringify({ ...document(), version: "provider-key-pool-v2" })],
    ["missing provider", JSON.stringify({ version: document().version, slots: document().slots })],
    ["empty provider", JSON.stringify({ ...document(), providerId: "" })],
    ["long provider", JSON.stringify({ ...document(), providerId: "p".repeat(129) })],
    ["no slots", JSON.stringify({ ...document(), slots: [] })],
    ["too many slots", JSON.stringify({ ...document(), slots: Array.from({ length: 33 }, (_, id) => ({ id: String(id), version: "v", apiKey: "key" })) })],
    ["null slots", JSON.stringify({ ...document(), slots: null })],
    ["null slot", JSON.stringify({ ...document(), slots: [null] })],
    ["unknown slot", JSON.stringify({ ...document(), slots: [{ ...document().slots[0], path: secret }] })],
    ["missing key", JSON.stringify({ ...document(), slots: [{ id: "slot", version: "v" }] })],
  ])("rejects closed-shape violation %s without exposing input", (_label, raw) => { rejects(raw); });

  it.each(["", "_start", ".start", "-start", "bad:colon", "has space", "尾", "tail\n", "a".repeat(65)])(
    "rejects invalid slot identity %j", value => {
      for (const key of ["id", "version"] as const) {
        rejects(JSON.stringify({ ...document(), slots: [{ ...document().slots[0], [key]: value }] }));
      }
    });

  it.each(["", "has space", "tab\t", "CR\r", "LF\n", "nul\0", "DEL\x7f", "é", "k".repeat(4097)])(
    "rejects unsafe or oversized credential %#", apiKey => {
      rejects(JSON.stringify({ ...document(), slots: [{ ...document().slots[0], apiKey }] }));
    });

  it.each([
    '{"version":"provider-key-pool-v1","version":"provider-key-pool-v1","providerId":"p","slots":[{"id":"a","version":"v","apiKey":"key"}]}',
    '{"version":"provider-key-pool-v1","providerId":"p","\\u0070roviderId":"p","slots":[{"id":"a","version":"v","apiKey":"key"}]}',
    '{"version":"provider-key-pool-v1","providerId":"p","slots":[{"id":"a","\\u0069d":"b","version":"v","apiKey":"key"}]}',
    '{"version":"provider-key-pool-v1","providerId":"p","slots":[{"id":"a","version":"v","apiKey":"old","apiKey":"new"}]}',
  ])("rejects duplicate JSON keys including escaped equivalent spelling %#", raw => { rejects(raw); });

  it("rejects repeated slot identities even when the material or version differs", () => {
    const original = document();
    rejects(JSON.stringify({ ...original, slots: [original.slots[0], original.slots[0]] }));
    rejects(JSON.stringify({ ...original, slots: [original.slots[0], { ...original.slots[0], version: "generation-2", apiKey: "new" }] }));
  });
});

describe("platform provider key pool protected native file reader", () => {
  it("reads a real protected regular file using exact nonblocking/no-follow flags", async () => {
    const f = await fixture();
    expect((await readProviderKeyPool(f.path)).config).toEqual(document());
    expect(mockedOpen).toHaveBeenCalledTimes(1);
    expect(mockedOpen).toHaveBeenCalledWith(f.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  });

  it("rejects relative, NUL, overlong and missing paths with fixed diagnostics", async () => {
    for (const path of ["relative", "/private/\0key", "/" + "x".repeat(4096), "/missing/" + pathCanary]) await rejectsRead(path);
    expect(mockedOpen).toHaveBeenCalledTimes(1);
  });

  it("rejects symlink and multi-link files without following leaf authority", async () => {
    const f = await fixture(), leaf = join(f.directory, "symlink"), hard = join(f.directory, "hardlink");
    await symlink(f.path, leaf); await rejectsRead(leaf);
    await link(f.path, hard); await rejectsRead(f.path); await rejectsRead(hard);
  });

  it("rejects nonprivate permissions, empty/oversized files and malformed UTF-8", async () => {
    const f = await fixture(); await chmod(f.path, 0o640); await rejectsRead(f.path); await chmod(f.path, 0o600);
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1, 32), Buffer.from([0xc3, 0x28])]) {
      await writeFile(f.path, bytes); await rejectsRead(f.path);
    }
  });

  it("rejects a real FIFO without a writer rather than blocking its open", async () => {
    const f = await fixture(), fifo = join(f.directory, "fifo");
    execFileSync("mkfifo", [fifo], { stdio: "ignore" });
    await rejectsRead(fifo);
  });

  it("rejects a real directory rather than parsing it as a file", async () => {
    const f = await fixture(); await rejectsRead(f.directory);
  });

  it.each(["dev", "ino", "uid", "mode", "nlink", "mtimeMs", "ctimeMs", "size"] as const)(
    "rejects descriptor %s drift and awaits its real close", async key => {
      const f = await fixture(), handle = await native.open(f.path, "r");
      const before = await handle.stat(), after = await handle.stat(); after[key] += 1;
      vi.spyOn(handle, "stat").mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      const close = vi.spyOn(handle, "close"); mockedOpen.mockResolvedValueOnce(handle);
      await rejectsRead(f.path); expect(close).toHaveBeenCalledTimes(1);
    });

  it("rejects a foreign owner before reading credential bytes", async () => {
    const f = await fixture(), handle = await native.open(f.path, "r"), stat = await handle.stat();
    stat.uid = (process.getuid?.() ?? stat.uid) + 1;
    vi.spyOn(handle, "stat").mockResolvedValue(stat);
    const read = vi.spyOn(handle, "read"), close = vi.spyOn(handle, "close"); mockedOpen.mockResolvedValueOnce(handle);
    await rejectsRead(f.path); expect(read).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
  });

  it("bounds a growing file read at limit plus one even if a descriptor initially reports a small size", async () => {
    const f = await fixture(), handle = await native.open(f.path, "r"), nativeStat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
      const before = await nativeStat(); await writeFile(f.path, Buffer.alloc(MAX_BYTES + 1, 32)); return before;
    });
    const read = vi.spyOn(handle, "read");
    const close = vi.spyOn(handle, "close"); mockedOpen.mockResolvedValueOnce(handle);
    await rejectsRead(f.path); expect(read).toHaveBeenCalled();
    expect(read.mock.calls[0]).toEqual([expect.any(Buffer), 0, MAX_BYTES + 1, 0]); expect(close).toHaveBeenCalledTimes(1);
  });

  it("awaits a held close and preserves the first fixed failure when close also rejects", async () => {
    const f = await fixture(), handle = await native.open(f.path, "r"), nativeClose = handle.close.bind(handle);
    const entered = barrier(), release = barrier(), primary = new ProviderKeyPoolReadError();
    vi.spyOn(handle, "stat").mockRejectedValue(primary);
    vi.spyOn(handle, "close").mockImplementation(async () => { entered.resolve(); await release.promise; await nativeClose(); throw new Error(secret); });
    mockedOpen.mockResolvedValueOnce(handle);
    let settled = false;
    const pending = readProviderKeyPool(f.path).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const assertion = expect(pending).rejects.toBe(primary);
    try { await entered.promise; expect(settled).toBe(false); }
    finally { release.resolve(); await assertion; }
    fixed(primary);
  });

  it("does not return a valid snapshot before a failing close settles", async () => {
    const f = await fixture(), handle = await native.open(f.path, "r"), nativeClose = handle.close.bind(handle);
    const entered = barrier(), release = barrier();
    vi.spyOn(handle, "close").mockImplementation(async () => { entered.resolve(); await release.promise; await nativeClose(); throw new Error(pathCanary); });
    mockedOpen.mockResolvedValueOnce(handle);
    let settled = false;
    const pending = readProviderKeyPool(f.path).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    const observed = pending.then(() => { throw new Error("A failing close returned a snapshot."); }, error => { fixed(error); });
    try { await entered.promise; expect(settled).toBe(false); }
    finally { release.resolve(); await observed; }
    expect(settled).toBe(true);
  });
});
