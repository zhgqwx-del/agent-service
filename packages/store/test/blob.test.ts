import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FsBlobStore, MemoryBlobStore } from "../src/index.js";

const tempDirectories = new Set<string>();

async function makeTempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-service-blob-"));
  tempDirectories.add(path);
  return path;
}

afterEach(async () => {
  await Promise.all([...tempDirectories].map((path) => rm(path, { recursive: true, force: true })));
  tempDirectories.clear();
});

describe("FsBlobStore", () => {
  it("round-trips binary data and content type from a real temporary directory", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]);

    const { ref } = await store.put("tenant/session/binary", bytes, "application/octet-stream");

    expect(ref).toBe("file+asblob2://tenant/session/binary");
    expect(await store.get(ref)).toEqual({
      data: Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]),
      contentType: "application/octet-stream",
    });

    const mutable = Buffer.from([1, 2, 3]);
    const pending = store.put("tenant/session/snapshot", mutable);
    mutable[0] = 9;
    const snapshot = await pending;
    expect((await store.get(snapshot.ref))?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("atomically replaces data and does not retain metadata from an earlier value", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const key = "replaceable";

    await store.put(key, "old", "text/plain");
    const { ref } = await store.put(key, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

    expect(await store.get(ref)).toEqual({ data: Buffer.from([0xde, 0xad, 0xbe, 0xef]), contentType: undefined });
    await expect(access(join(root, `${key}.meta`))).rejects.toMatchObject({ code: "ENOENT" });

    await store.put(key, "new", "application/x-new");
    expect(await store.get(ref)).toEqual({ data: Buffer.from("new"), contentType: "application/x-new" });
  });

  it("leaves the prior complete version visible when publication fails", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const { ref } = await store.put("replaceable", "old", "type/old");
    const internals = store as unknown as {
      temporaryFile(target: string, data: Buffer | string): Promise<string>;
    };
    const writeTemporaryFile = internals.temporaryFile.bind(store);
    internals.temporaryFile = async (target, data) => {
      const temp = await writeTemporaryFile(target, data);
      await rm(temp);
      return temp;
    };

    await expect(store.put("replaceable", "new", "type/new")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.get(ref)).toEqual({ data: Buffer.from("old"), contentType: "type/old" });
  });

  it("detects a truncated or corrupted envelope instead of returning partial bytes", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const { ref } = await store.put("checked", "abcdef", "text/plain");
    const path = join(root, "checked");
    const original = await readFile(path);

    await writeFile(path, original.subarray(0, original.length - 3));
    await expect(store.get(ref)).rejects.toThrow("invalid blob envelope length");

    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    await writeFile(path, corrupted);
    await expect(store.get(ref)).rejects.toThrow("invalid blob envelope checksum");

    const badMagic = Buffer.from(original);
    badMagic[0] = badMagic[0]! ^ 0xff;
    await writeFile(path, badMagic);
    await expect(store.get(ref)).rejects.toThrow("invalid blob envelope");

    await writeFile(path, original.subarray(0, 4));
    await expect(store.get(ref)).rejects.toThrow("invalid blob envelope");
  });

  it("reads and deletes the safe subset of the legacy raw-file plus sidecar format", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const path = join(root, "legacy", "blob");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(path, "legacy bytes");
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: "text/legacy" }));
    const store = new FsBlobStore(root);

    expect(await store.get("file://legacy/blob")).toEqual({
      data: Buffer.from("legacy bytes"),
      contentType: "text/legacy",
    });
    await store.delete("file://legacy/blob");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${path}.meta`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps data and content type from the same version during concurrent puts and gets", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const key = "concurrent";
    const { ref } = await store.put(key, "initial", "type/initial");

    for (let round = 0; round < 10; round += 1) {
      const puts = Array.from({ length: 20 }, (_, index) => {
        const version = `${round}-${index}`;
        return store.put(key, version, `type/${version}`);
      });
      const gets = Array.from({ length: 50 }, async () => {
        const blob = await store.get(ref);
        expect(blob).not.toBeNull();
        expect(blob!.contentType).toBe(`type/${blob!.data.toString("utf8")}`);
      });
      await Promise.all([...puts, ...gets]);

      const published = await store.get(ref);
      expect(published).not.toBeNull();
      expect(published!.contentType).toBe(`type/${published!.data.toString("utf8")}`);
    }
  });

  const permissionsIt = process.platform === "win32" ? it.skip : it;
  permissionsIt("uses private permissions and tightens an existing root and parent", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const parent = join(root, "tenant");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    await chmod(parent, 0o755);
    const store = new FsBlobStore(root);

    const { ref } = await store.put("tenant/session/blob", "private", "text/plain");
    const blobPath = join(parent, "session", "blob");
    await chmod(blobPath, 0o644);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o644);
    await store.get(ref);

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(parent, "session"))).mode & 0o777).toBe(0o700);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
  });

  it("makes deletion idempotent but propagates non-ENOENT filesystem errors", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const { ref } = await store.put("deletable", "value", "text/plain");

    await store.delete(ref);
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();

    await mkdir(join(root, "not-a-file"));
    await expect(store.delete("file://not-a-file")).rejects.toBeTruthy();
  });

  it("applies the same strict opaque-key grammar in filesystem and memory stores", async () => {
    const base = await makeTempDirectory();
    const root = join(base, "blobs");
    const sibling = join(base, "blobs-evil");
    const store = new FsBlobStore(root);
    const memory = new MemoryBlobStore();
    await mkdir(sibling);

    for (const key of [
      "",
      join(base, "absolute"),
      "../blobs-evil/escaped",
      "safe/../../blobs-evil/escaped",
      "safe/../escaped",
      "safe//escaped",
      "./escaped",
      "reserved.meta",
      "Tenant/blob",
      "contains space",
      "colon:stream",
      "CON",
      "café",
      "a".repeat(129),
      `${"a/".repeat(256)}a`,
      "C:\\absolute\\escaped",
    ]) {
      await expect(store.put(key, "forbidden")).rejects.toThrow(/blob key/);
      await expect(memory.put(key, "forbidden")).rejects.toThrow(/blob key/);
    }

    await expect(store.get(`file://${join(base, "absolute")}`)).rejects.toThrow(/blob key/);
    await expect(store.delete("file://../blobs-evil/escaped")).rejects.toThrow(/blob key/);
    await expect(memory.get("mem://../escaped")).rejects.toThrow(/blob key/);
    await expect(store.get("mem://wrong-scheme")).rejects.toThrow("invalid filesystem blob reference");
    await expect(access(join(sibling, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });

    const filesystemRef = await store.put("tenant_1/session-2/blob3", "allowed");
    const memoryRef = await memory.put("tenant_1/session-2/blob3", "allowed");
    expect((await store.get(filesystemRef.ref))?.data.toString()).toBe("allowed");
    expect((await memory.get(memoryRef.ref))?.data.toString()).toBe("allowed");
  });

  const symlinkIt = process.platform === "win32" ? it.skip : it;
  symlinkIt("rejects a symlinked path component without reading, writing, or deleting outside the root", async () => {
    const base = await makeTempDirectory();
    const root = join(base, "blobs");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "outside");
    await symlink(outside, join(root, "linked"), "dir");
    await symlink(join(outside, "secret"), join(root, "file-link"), "file");
    const store = new FsBlobStore(root);

    await expect(store.get("file://linked/secret")).rejects.toThrow("symbolic link");
    await expect(store.put("linked/secret", "overwritten")).rejects.toThrow("symbolic link");
    await expect(store.delete("file://linked/secret")).rejects.toThrow("symbolic link");
    await expect(store.get("file://file-link")).rejects.toThrow("symbolic link");
    await expect(store.put("file-link", "overwritten")).rejects.toThrow("symbolic link");
    await expect(store.delete("file://file-link")).rejects.toThrow("symbolic link");

    const symlinkedRoot = join(base, "symlinked-root");
    await symlink(outside, symlinkedRoot, "dir");
    await expect(new FsBlobStore(symlinkedRoot).put("escaped", "value")).rejects.toThrow(
      "blob root must not be a symbolic link",
    );
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside");
    await expect(access(join(outside, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MemoryBlobStore", () => {
  it("defensively copies buffers on both put and get", async () => {
    const store = new MemoryBlobStore();
    const source = Buffer.from([1, 2, 3]);
    const { ref } = await store.put("immutable", source, "application/octet-stream");

    source[0] = 9;
    const first = await store.get(ref);
    expect(first).toEqual({ data: Buffer.from([1, 2, 3]), contentType: "application/octet-stream" });

    first!.data[1] = 8;
    expect(await store.get(ref)).toEqual({
      data: Buffer.from([1, 2, 3]),
      contentType: "application/octet-stream",
    });

    await expect(store.get("file://immutable")).rejects.toThrow("invalid memory blob reference");
    await expect(store.delete("immutable")).rejects.toThrow("invalid memory blob reference");
  });
});
