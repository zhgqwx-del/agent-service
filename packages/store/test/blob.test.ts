import { createHash } from "node:crypto";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlobConflictError,
  BlobTooLargeError,
  FsBlobStore,
  MemoryBlobStore,
  type BlobStore,
} from "../src/index.js";

const tempDirectories = new Set<string>();
const MAX_BYTES = 1024 * 1024;

async function makeTempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-service-blob-"));
  tempDirectories.add(path);
  return path;
}

afterEach(async () => {
  await Promise.all([...tempDirectories].map((path) => rm(path, { recursive: true, force: true })));
  tempDirectories.clear();
});

type StoreFixture = { name: string; backend: string; make: () => Promise<BlobStore> };

const fixtures: StoreFixture[] = [
  { name: "memory", backend: "memory-v1", make: async () => new MemoryBlobStore() },
  {
    name: "filesystem",
    backend: "filesystem-v1",
    make: async () => new FsBlobStore(join(await makeTempDirectory(), "blobs")),
  },
];

for (const fixture of fixtures) {
  describe(`${fixture.name} BlobStore conformance`, () => {
    it("round-trips a storage-key object and returns stable integrity metadata", async () => {
      const store = await fixture.make();
      const bytes = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01]);
      const expectedSha = createHash("sha256").update(bytes).digest("hex");

      const descriptor = await store.putIfAbsent("objects/blob-1", bytes, {
        uploadToken: "upload-1",
        maxBytes: MAX_BYTES,
        contentType: "application/octet-stream",
      });

      expect(store.backend).toBe(fixture.backend);
      expect(descriptor).toEqual({
        storageKey: "objects/blob-1",
        sha256: expectedSha,
        sizeBytes: 5,
        contentType: "application/octet-stream",
      });
      expect(await store.get("objects/blob-1", { maxBytes: MAX_BYTES })).toEqual({
        ...descriptor,
        data: bytes,
      });
    });

    it("is create-only: exact retries are idempotent and non-identical retries conflict", async () => {
      const store = await fixture.make();
      const first = await store.putIfAbsent("objects/unique", "same", {
        uploadToken: "first-upload",
        maxBytes: MAX_BYTES,
        contentType: "text/plain; charset=utf-8",
      });

      await expect(store.putIfAbsent("objects/unique", Buffer.from("same"), {
        uploadToken: "retry-upload",
        maxBytes: MAX_BYTES,
        contentType: "text/plain; charset=utf-8",
      })).resolves.toEqual(first);
      await expect(store.putIfAbsent("objects/unique", "different", {
        uploadToken: "different-bytes",
        maxBytes: MAX_BYTES,
        contentType: "text/plain; charset=utf-8",
      })).rejects.toBeInstanceOf(BlobConflictError);
      await expect(store.putIfAbsent("objects/unique", "same", {
        uploadToken: "different-type",
        maxBytes: MAX_BYTES,
        contentType: "application/octet-stream",
      })).rejects.toBeInstanceOf(BlobConflictError);

      expect((await store.get("objects/unique", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("same");
    });

    it("linearizes concurrent identical and conflicting creates without overwriting the winner", async () => {
      const identical = await fixture.make();
      const identicalResults = await Promise.all(
        Array.from({ length: 12 }, (_, index) => identical.putIfAbsent("objects/concurrent-same", "same", {
          uploadToken: `same-${index}`,
          maxBytes: MAX_BYTES,
          contentType: "text/plain",
        })),
      );
      expect(new Set(identicalResults.map((result) => JSON.stringify(result))).size).toBe(1);

      const conflicting = await fixture.make();
      const conflictingResults = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) => conflicting.putIfAbsent(
          "objects/concurrent-different",
          `value-${index}`,
          { uploadToken: `different-${index}`, maxBytes: MAX_BYTES, contentType: "text/plain" },
        )),
      );
      expect(conflictingResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of conflictingResults) {
        if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BlobConflictError);
      }
      const winner = await conflicting.get("objects/concurrent-different", { maxBytes: MAX_BYTES });
      expect(winner?.data.toString()).toMatch(/^value-\d+$/);
    });

    it("coordinates duplicate calls that share one upload token", async () => {
      const same = await fixture.make();
      await expect(Promise.all(Array.from({ length: 8 }, () => same.putIfAbsent("objects/token-retry", "same", {
        uploadToken: "shared-token",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      })))).resolves.toHaveLength(8);

      const different = await fixture.make();
      const results = await Promise.allSettled([
        different.putIfAbsent("objects/token-conflict", "left", {
          uploadToken: "shared-token",
          maxBytes: MAX_BYTES,
          contentType: "text/plain",
        }),
        different.putIfAbsent("objects/token-conflict", "right", {
          uploadToken: "shared-token",
          maxBytes: MAX_BYTES,
          contentType: "text/plain",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(BlobConflictError);
    });

    it("checks maxBytes before copying a write and before copying a read", async () => {
      const store = await fixture.make();
      await expect(store.putIfAbsent("objects/too-large", "12345", {
        uploadToken: "too-large",
        maxBytes: 4,
        contentType: "text/plain",
      })).rejects.toMatchObject({
        name: "BlobTooLargeError",
        storageKey: "objects/too-large",
        maxBytes: 4,
        actualBytes: 5,
      });

      await store.putIfAbsent("objects/read-limit", "12345", {
        uploadToken: "read-limit",
        maxBytes: 5,
        contentType: "text/plain",
      });
      await expect(store.get("objects/read-limit", { maxBytes: 4 })).rejects.toBeInstanceOf(BlobTooLargeError);
      await expect(store.get("objects/read-limit", { maxBytes: Number.NaN })).rejects.toThrow("maxBytes");
    });

    it("rejects unsafe content types, upload tokens and storage keys consistently", async () => {
      const store = await fixture.make();
      for (const contentType of ["", " text/plain", "text/plain ", "text/plain\r\nx-evil: yes", "文本/plain", "text/plain; charset=\"utf-8\""]) {
        await expect(store.putIfAbsent("objects/content-type", "value", {
          uploadToken: "safe-token",
          maxBytes: MAX_BYTES,
          contentType,
        })).rejects.toThrow("content type");
      }
      for (const uploadToken of ["", "UPPER", "../escape", "contains space", "café", "a".repeat(129)]) {
        await expect(store.putIfAbsent("objects/upload-token", "value", {
          uploadToken,
          maxBytes: MAX_BYTES,
          contentType: "text/plain",
        })).rejects.toThrow("upload token");
      }
      for (const storageKey of ["", "../escape", "safe/../escape", "safe//escape", "Tenant/blob", "reserved.meta", "CON", "café"]) {
        await expect(store.putIfAbsent(storageKey, "value", {
          uploadToken: "safe-token",
          maxBytes: MAX_BYTES,
        })).rejects.toThrow("blob key");
      }
    });

    it("makes storage-key deletion idempotent", async () => {
      const store = await fixture.make();
      await store.putIfAbsent("objects/delete", "value", {
        uploadToken: "delete-token",
        maxBytes: MAX_BYTES,
      });
      await store.delete("objects/delete", { uploadToken: "delete-token" });
      await store.delete("objects/delete", { uploadToken: "delete-token" });
      expect(await store.get("objects/delete", { maxBytes: MAX_BYTES })).toBeNull();
    });

    it("fences a manifest-driven delete before publication and prevents key resurrection", async () => {
      const store = await fixture.make();

      await store.delete("objects/delete-before-put", { uploadToken: "original-token" });
      await store.delete("objects/delete-before-put", { uploadToken: "original-token" });
      await expect(store.putIfAbsent("objects/delete-before-put", "late", {
        uploadToken: "original-token",
        maxBytes: MAX_BYTES,
      })).rejects.toThrow("cancelled before publication");
      await expect(store.putIfAbsent("objects/delete-before-put", "resurrected", {
        uploadToken: "different-token",
        maxBytes: MAX_BYTES,
      })).rejects.toThrow("cancelled before publication");
      expect(await store.get("objects/delete-before-put", { maxBytes: MAX_BYTES })).toBeNull();
    });
  });
}

describe("FsBlobStore filesystem guarantees", () => {
  it("snapshots caller buffers before yielding and leaves no upload artifacts after success", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const mutable = Buffer.from([1, 2, 3]);
    const pending = store.putIfAbsent("tenant/session/snapshot", mutable, {
      uploadToken: "snapshot-token",
      maxBytes: MAX_BYTES,
    });
    mutable[0] = 9;
    await pending;

    expect((await store.get("tenant/session/snapshot", { maxBytes: MAX_BYTES }))?.data).toEqual(Buffer.from([1, 2, 3]));
    const names = await readdir(join(root, "tenant", "session"));
    expect(names.filter((name) => name.startsWith(".asblob-"))).toEqual([]);
  });

  it("does not allocate the filesystem root for a preflight size rejection", async () => {
    const root = join(await makeTempDirectory(), "not-created");
    const store = new FsBlobStore(root);
    await expect(store.putIfAbsent("objects/large", "12345", {
      uploadToken: "large-token",
      maxBytes: 4,
    })).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an exact retry from a complete crash temp located by uploadToken", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const internals = store as unknown as {
      createUploadTemp(path: string, envelope: Buffer): Promise<boolean>;
    };
    const createUploadTemp = internals.createUploadTemp.bind(store);
    internals.createUploadTemp = async (path, envelope) => {
      const created = await createUploadTemp(path, envelope);
      await link(path, path.replace(/\.writing$/, ".ready"));
      throw new Error("simulated crash after ready temp");
    };

    await expect(store.putIfAbsent("objects/crash-retry", "recoverable", {
      uploadToken: "crash-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    })).rejects.toThrow("simulated crash");
    expect((await readdir(join(root, "objects"))).filter((name) => name.startsWith(".asblob-"))).toHaveLength(2);

    internals.createUploadTemp = createUploadTemp;
    await expect(store.putIfAbsent("objects/crash-retry", "recoverable", {
      uploadToken: "crash-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    })).resolves.toMatchObject({ storageKey: "objects/crash-retry", sizeBytes: 11 });
    expect((await store.get("objects/crash-retry", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("recoverable");
    expect((await readdir(join(root, "objects"))).filter((name) => name.startsWith(".asblob-"))).toEqual([]);
  });

  it("exposes no partial object and delete fences an upload after temp creation", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const internals = store as unknown as {
      createUploadTemp(path: string, envelope: Buffer): Promise<boolean>;
    };
    const createUploadTemp = internals.createUploadTemp.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const uploadStarted = new Promise<void>((resolve) => { started = resolve; });
    internals.createUploadTemp = async (path, envelope) => {
      const created = await createUploadTemp(path, envelope);
      started();
      await gate;
      return created;
    };

    const pending = store.putIfAbsent("objects/cancelled", "complete-only", {
      uploadToken: "cancel-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    await uploadStarted;
    expect(await store.get("objects/cancelled", { maxBytes: MAX_BYTES })).toBeNull();

    await store.delete("objects/cancelled", { uploadToken: "cancel-token" });
    release();
    await expect(pending).rejects.toThrow("cancelled before publication");
    expect(await store.get("objects/cancelled", { maxBytes: MAX_BYTES })).toBeNull();
    const artifacts = (await readdir(join(root, "objects"))).filter((name) => name.startsWith(".asblob-"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatch(/\.cancelled$/);
  });

  it("persists a delete fence before temp creation so a late upload cannot leave an orphan", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const internals = store as unknown as {
      createUploadTemp(path: string, envelope: Buffer): Promise<boolean>;
    };
    const createUploadTemp = internals.createUploadTemp.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedTempCreation!: () => void;
    const beforeTempCreation = new Promise<void>((resolve) => { reachedTempCreation = resolve; });
    internals.createUploadTemp = async (path, envelope) => {
      reachedTempCreation();
      await gate;
      return createUploadTemp(path, envelope);
    };

    const pending = store.putIfAbsent("objects/late-upload", "must-never-publish", {
      uploadToken: "late-upload-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    await beforeTempCreation;

    // At this point neither the temp nor final object exists. Deletion must still leave a durable
    // fence which the paused writer observes once it resumes.
    await store.delete("objects/late-upload", { uploadToken: "late-upload-token" });
    release();
    await expect(pending).rejects.toThrow("cancelled before publication");
    await expect(store.putIfAbsent("objects/late-upload", "must-never-publish", {
      uploadToken: "late-upload-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    })).rejects.toThrow("cancelled before publication");
    await store.delete("objects/late-upload", { uploadToken: "late-upload-token" });

    expect(await store.get("objects/late-upload", { maxBytes: MAX_BYTES })).toBeNull();
    const artifacts = (await readdir(join(root, "objects"))).filter((name) => name.startsWith(".asblob-"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatch(/\.cancelled$/);
  });

  it("detects a truncated or corrupted envelope instead of returning partial bytes", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    await store.putIfAbsent("checked", "abcdef", {
      uploadToken: "checked-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    const path = join(root, "checked");
    const original = await readFile(path);

    await writeFile(path, original.subarray(0, original.length - 3));
    await expect(store.get("checked", { maxBytes: MAX_BYTES })).rejects.toThrow("invalid blob envelope length");

    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    await writeFile(path, corrupted);
    await expect(store.get("checked", { maxBytes: MAX_BYTES })).rejects.toThrow("invalid blob envelope checksum");

    const badMagic = Buffer.from(original);
    badMagic[0] = badMagic[0]! ^ 0xff;
    await writeFile(path, badMagic);
    await expect(store.get("checked", { maxBytes: MAX_BYTES })).rejects.toThrow("invalid blob envelope");
  });

  it("keeps explicit safe legacy file:// raw + sidecar read/delete compatibility", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const path = join(root, "legacy", "blob");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(path, "legacy bytes");
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: "text/legacy" }));
    const store = new FsBlobStore(root);

    expect(await store.getLegacy("file://legacy/blob", { maxBytes: MAX_BYTES })).toEqual({
      data: Buffer.from("legacy bytes"),
      contentType: "text/legacy",
    });
    await expect(store.get("file://legacy/blob", { maxBytes: MAX_BYTES })).rejects.toThrow("blob key");
    await expect(store.getLegacy("file+asblob2://legacy/blob", { maxBytes: MAX_BYTES })).rejects.toThrow(
      "invalid legacy filesystem blob reference",
    );
    await store.deleteLegacy("file://legacy/blob");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${path}.meta`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces maxBytes and content-type validation on legacy reads", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const path = join(root, "legacy", "blob");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(path, "12345");
    const store = new FsBlobStore(root);

    await expect(store.getLegacy("file://legacy/blob", { maxBytes: 4 })).rejects.toBeInstanceOf(BlobTooLargeError);
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: "text/plain\r\nx-evil: yes" }));
    await expect(store.getLegacy("file://legacy/blob", { maxBytes: 5 })).rejects.toThrow("invalid legacy blob metadata");
  });

  const permissionsIt = process.platform === "win32" ? it.skip : it;
  permissionsIt("uses private permissions and tightens an existing root and parent", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const parent = join(root, "tenant");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    await chmod(parent, 0o755);
    const store = new FsBlobStore(root);

    await store.putIfAbsent("tenant/session/blob", "private", {
      uploadToken: "private-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    const blobPath = join(parent, "session", "blob");
    await chmod(blobPath, 0o644);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o644);
    await store.get("tenant/session/blob", { maxBytes: MAX_BYTES });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(parent, "session"))).mode & 0o777).toBe(0o700);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
  });

  it("propagates non-ENOENT filesystem errors", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    await mkdir(join(root, "not-a-file"), { recursive: true });
    await expect(store.delete("not-a-file")).rejects.toThrow("not a regular file");
  });

  const symlinkIt = process.platform === "win32" ? it.skip : it;
  symlinkIt("rejects symlinked path components without touching data outside the root", async () => {
    const base = await makeTempDirectory();
    const root = join(base, "blobs");
    const outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "outside");
    await symlink(outside, join(root, "linked"), "dir");
    await symlink(join(outside, "secret"), join(root, "file-link"), "file");
    const store = new FsBlobStore(root);

    await expect(store.get("linked/secret", { maxBytes: MAX_BYTES })).rejects.toThrow("symbolic link");
    await expect(store.putIfAbsent("linked/secret", "overwritten", {
      uploadToken: "linked-token",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("symbolic link");
    await expect(store.delete("linked/secret", { uploadToken: "linked-token" })).rejects.toThrow("symbolic link");
    await expect(store.get("file-link", { maxBytes: MAX_BYTES })).rejects.toThrow("symbolic link");
    await expect(store.deleteLegacy("file://file-link")).rejects.toThrow("symbolic link");

    const symlinkedRoot = join(base, "symlinked-root");
    await symlink(outside, symlinkedRoot, "dir");
    await expect(new FsBlobStore(symlinkedRoot).putIfAbsent("escaped", "value", {
      uploadToken: "escaped-token",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("blob root must not be a symbolic link");
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside");
    await expect(access(join(outside, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("MemoryBlobStore copy semantics", () => {
  it("defensively copies buffers on both put and get", async () => {
    const store = new MemoryBlobStore();
    const source = Buffer.from([1, 2, 3]);
    const pending = store.putIfAbsent("immutable", source, {
      uploadToken: "immutable-token",
      maxBytes: MAX_BYTES,
      contentType: "application/octet-stream",
    });
    source[0] = 9;
    await pending;

    const first = await store.get("immutable", { maxBytes: MAX_BYTES });
    expect(first?.data).toEqual(Buffer.from([1, 2, 3]));
    first!.data[1] = 8;
    expect((await store.get("immutable", { maxBytes: MAX_BYTES }))?.data).toEqual(Buffer.from([1, 2, 3]));
  });
});
