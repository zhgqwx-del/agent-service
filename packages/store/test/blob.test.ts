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
  type BlobMigrationStore,
} from "../src/index.js";
import {
  decodeBlobEnvelope,
  encodeBlobDataEnvelope,
  encodeBlobTombstoneEnvelope,
} from "../src/blob/envelope.js";

const tempDirectories = new Set<string>();
const MAX_BYTES = 1024 * 1024;
const MIGRATION_OWNER_SHA256 = "a".repeat(64);
const OTHER_MIGRATION_OWNER_SHA256 = "b".repeat(64);

describe("ASBLOB02 migration metadata", () => {
  it("keeps legacy envelopes readable while binding marked bytes outside BlobDescriptor", () => {
    const payload = Buffer.from("same");
    const legacy = encodeBlobDataEnvelope(payload, "text/plain");
    const marked = encodeBlobDataEnvelope(payload, "text/plain", MIGRATION_OWNER_SHA256);
    const legacyDecoded = decodeBlobEnvelope("objects/envelope", legacy, MAX_BYTES);
    const markedDecoded = decodeBlobEnvelope("objects/envelope", marked, MAX_BYTES);

    expect(legacy.equals(marked)).toBe(false);
    expect(legacyDecoded).toMatchObject({ kind: "data" });
    expect(legacyDecoded).not.toHaveProperty("migrationOwnerSha256");
    expect(markedDecoded).toMatchObject({
      kind: "data",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    if (legacyDecoded.kind !== "data" || markedDecoded.kind !== "data") {
      throw new Error("expected data envelopes");
    }
    expect(markedDecoded.object).toEqual(legacyDecoded.object);

    expect(decodeBlobEnvelope(
      "objects/tombstone",
      encodeBlobTombstoneEnvelope(),
      0,
    )).toEqual({ kind: "tombstone" });
    expect(decodeBlobEnvelope(
      "objects/tombstone",
      encodeBlobTombstoneEnvelope(MIGRATION_OWNER_SHA256),
      0,
    )).toEqual({ kind: "tombstone", migrationOwnerSha256: MIGRATION_OWNER_SHA256 });
    expect(() => encodeBlobDataEnvelope(payload, undefined, "A".repeat(64))).toThrow(
      "migration owner sha256",
    );
  });
});

async function makeTempDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-service-blob-"));
  tempDirectories.add(path);
  return path;
}

afterEach(async () => {
  await Promise.all([...tempDirectories].map((path) => rm(path, { recursive: true, force: true })));
  tempDirectories.clear();
});

type StoreFixture = { name: string; backend: string; make: () => Promise<BlobMigrationStore> };

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

    it("inspects exact missing, data, and tombstone states for an offline migration", async () => {
      const store = await fixture.make();
      expect(await store.inspectExact("objects/exact-state", { maxBytes: MAX_BYTES })).toEqual({
        kind: "missing",
      });

      const descriptor = await store.putIfAbsent("objects/exact-state", "value", {
        uploadToken: "exact-state",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      });
      expect(await store.inspectExact("objects/exact-state", { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
      });

      await store.delete("objects/exact-state", { uploadToken: "exact-state-delete" });
      expect(await store.inspectExact("objects/exact-state", { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
      });
    });

    it("hard-discards only exact uncommitted data and makes duplicate abort cleanup safe", async () => {
      const store = await fixture.make();
      const descriptor = await store.putIfAbsent("objects/discard-data", "uncommitted", {
        uploadToken: "discard-data",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      const expectedState = { kind: "data", descriptor } as const;

      await expect(store.discardUncommittedTarget("objects/discard-data", {
        expectedState,
        uploadToken: "discard-data",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      await expect(store.discardUncommittedTarget("objects/discard-data", {
        expectedState,
        uploadToken: "discard-data",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      expect(await store.inspectExact("objects/discard-data", { maxBytes: MAX_BYTES })).toEqual({ kind: "missing" });

      // Abort cleanup is a hard delete, not the permanent business tombstone used by delete().
      await expect(store.putIfAbsent("objects/discard-data", "after-abort", {
        uploadToken: "after-abort",
        maxBytes: MAX_BYTES,
      })).resolves.toMatchObject({ storageKey: "objects/discard-data" });
    });

    it("requires exact embedded migration provenance independently of the upload token", async () => {
      const store = await fixture.make();
      const descriptor = await store.putIfAbsent("objects/discard-ledger-token", "uncommitted", {
        uploadToken: "initial-write-token",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });

      await expect(store.discardUncommittedTarget("objects/discard-ledger-token", {
        expectedState: { kind: "data", descriptor },
        uploadToken: "ledger-authorized-token",
        migrationOwnerSha256: OTHER_MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect(await store.inspectExact("objects/discard-ledger-token", { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });

      await store.discardUncommittedTarget("objects/discard-ledger-token", {
        expectedState: { kind: "data", descriptor },
        uploadToken: "ledger-authorized-token",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      expect(await store.inspectExact("objects/discard-ledger-token", { maxBytes: MAX_BYTES })).toEqual({
        kind: "missing",
      });
    });

    it("hard-discards only an expected tombstone without leaving a permanent fence", async () => {
      const store = await fixture.make();
      await store.delete("objects/discard-tombstone", {
        uploadToken: "discard-tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      expect(await store.inspectExact("objects/discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      expect(await store.get("objects/discard-tombstone", { maxBytes: MAX_BYTES })).toBeNull();

      await expect(store.discardUncommittedTarget("objects/discard-tombstone", {
        expectedState: { kind: "tombstone" },
        uploadToken: "discard-tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      await expect(store.discardUncommittedTarget("objects/discard-tombstone", {
        expectedState: { kind: "tombstone" },
        uploadToken: "discard-tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      expect(await store.inspectExact("objects/discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
        kind: "missing",
      });
      await expect(store.putIfAbsent("objects/discard-tombstone", "after-abort", {
        uploadToken: "after-abort",
        maxBytes: MAX_BYTES,
      })).resolves.toMatchObject({ storageKey: "objects/discard-tombstone" });
    });

    it("refuses descriptor, state, and token conflicts without changing the target", async () => {
      const store = await fixture.make();
      const descriptor = await store.putIfAbsent("objects/discard-conflict", "original", {
        uploadToken: "discard-conflict",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      const wrongDescriptor = { ...descriptor, sha256: "0".repeat(64) };

      await expect(store.discardUncommittedTarget("objects/discard-conflict", {
        expectedState: { kind: "data", descriptor: wrongDescriptor },
        uploadToken: "discard-conflict",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      await expect(store.discardUncommittedTarget("objects/discard-conflict", {
        expectedState: { kind: "tombstone" },
        uploadToken: "discard-conflict",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      await expect(store.discardUncommittedTarget("objects/discard-conflict", {
        expectedState: { kind: "data", descriptor },
        uploadToken: "../unsafe",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toThrow("upload token");
      expect(await store.inspectExact("objects/discard-conflict", { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });

      await store.delete("objects/discard-conflict", { uploadToken: "discard-conflict-delete" });
      await expect(store.discardUncommittedTarget("objects/discard-conflict", {
        expectedState: { kind: "data", descriptor },
        uploadToken: "discard-conflict",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect(await store.inspectExact("objects/discard-conflict", { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
      });
    });

    it("never claims or discards pre-existing identical bytes without the exact owner marker", async () => {
      const store = await fixture.make();
      const descriptor = await store.putIfAbsent("objects/preexisting-identical", "same", {
        uploadToken: "preexisting",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      });

      await expect(store.putIfAbsent("objects/preexisting-identical", "same", {
        uploadToken: "migration-copy",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      await expect(store.discardUncommittedTarget("objects/preexisting-identical", {
        expectedState: { kind: "data", descriptor },
        uploadToken: "migration-copy",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect((await store.get("objects/preexisting-identical", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("same");

      await expect(store.putIfAbsent("objects/invalid-owner", "value", {
        uploadToken: "invalid-owner",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: "A".repeat(64),
      })).rejects.toThrow("migration owner sha256");
    });

    it("lets an ordinary exact resume observe migration-owned bytes without changing their owner", async () => {
      const store = await fixture.make();
      const owned = await store.putIfAbsent("objects/rolling-resume-owned", "same", {
        uploadToken: "migration-writer",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });

      await expect(store.putIfAbsent("objects/rolling-resume-owned", "same", {
        uploadToken: "same-migration-retry",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toEqual(owned);
      await expect(store.putIfAbsent("objects/rolling-resume-owned", Buffer.from("same"), {
        uploadToken: "ordinary-retry",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      })).resolves.toEqual(owned);
      await expect(store.putIfAbsent("objects/rolling-resume-owned", "different", {
        uploadToken: "ordinary-non-exact-retry",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect(await store.inspectExact("objects/rolling-resume-owned", { maxBytes: MAX_BYTES }))
        .toEqual({
          kind: "data",
          descriptor: owned,
          migrationOwnerSha256: MIGRATION_OWNER_SHA256,
        });

      await expect(store.putIfAbsent("objects/rolling-resume-owned", "same", {
        uploadToken: "different-migration-writer",
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
        migrationOwnerSha256: OTHER_MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect(await store.inspectExact("objects/rolling-resume-owned", { maxBytes: MAX_BYTES }))
        .toEqual({
          kind: "data",
          descriptor: owned,
          migrationOwnerSha256: MIGRATION_OWNER_SHA256,
        });
    });

    it("treats migration tombstones as create-only even when existing data has the same owner", async () => {
      const store = await fixture.make();
      const descriptor = await store.putIfAbsent("objects/tombstone-over-data", "data", {
        uploadToken: "tombstone-over-data-write",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      await expect(store.putIfAbsent("objects/tombstone-over-data", "data", {
        uploadToken: "ordinary-retry",
        maxBytes: MAX_BYTES,
      })).resolves.toEqual(descriptor);

      await expect(store.delete("objects/tombstone-over-data", {
        uploadToken: "tombstone-over-data-delete",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect(await store.inspectExact("objects/tombstone-over-data", { maxBytes: MAX_BYTES })).toEqual({
        kind: "data",
        descriptor,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
    });

    it("converges concurrent create-only tombstone retries for the same migration owner", async () => {
      const store = await fixture.make();
      await expect(Promise.all(Array.from({ length: 8 }, (_, index) => store.delete(
        "objects/concurrent-migration-tombstone",
        {
          uploadToken: `migration-tombstone-${index}`,
          migrationOwnerSha256: MIGRATION_OWNER_SHA256,
        },
      )))).resolves.toHaveLength(8);
      expect(await store.inspectExact("objects/concurrent-migration-tombstone", { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
    });

    it("converges discard-then-fence after a late owned write and never removes a foreign winner", async () => {
      const store = await fixture.make();
      const storageKey = "objects/abort-final-fence";
      const first = await store.putIfAbsent(storageKey, "owned", {
        uploadToken: "abort-first-copy",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      await store.discardUncommittedTarget(storageKey, {
        expectedState: { kind: "data", descriptor: first },
        uploadToken: "abort-first-copy",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });

      // Simulate a request issued before the abort lock whose create reaches storage after the
      // first discard. A create-only fence cannot overwrite it, so the coordinator must re-inspect,
      // discard the exact owned object, and retry the fence.
      const late = await store.putIfAbsent(storageKey, "owned", {
        uploadToken: "abort-late-copy",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      await expect(store.delete(storageKey, {
        uploadToken: "abort-final-fence",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      await store.discardUncommittedTarget(storageKey, {
        expectedState: { kind: "data", descriptor: late },
        uploadToken: "abort-late-copy",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      await store.delete(storageKey, {
        uploadToken: "abort-final-fence",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      expect(await store.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      await expect(store.putIfAbsent(storageKey, "owned", {
        uploadToken: "abort-too-late-copy",
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toThrow();

      const foreignKey = "objects/abort-foreign-winner";
      const foreign = await store.putIfAbsent(foreignKey, "foreign", {
        uploadToken: "foreign-winner",
        maxBytes: MAX_BYTES,
      });
      await expect(store.delete(foreignKey, {
        uploadToken: "abort-foreign-fence",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      await expect(store.discardUncommittedTarget(foreignKey, {
        expectedState: { kind: "data", descriptor: foreign },
        uploadToken: "foreign-winner",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).rejects.toBeInstanceOf(BlobConflictError);
      expect((await store.get(foreignKey, { maxBytes: MAX_BYTES }))?.data.toString()).toBe("foreign");
    });
  });
}

describe("FsBlobStore filesystem guarantees", () => {
  it("derives a stable non-plaintext namespace identity from the resolved private root", async () => {
    const base = await makeTempDirectory();
    const firstRoot = join(base, "blobs");
    const sameResolvedRoot = join(base, "nested", "..", "blobs");
    const otherRoot = join(base, "other-blobs");
    const first = new FsBlobStore(firstRoot);
    const same = new FsBlobStore(sameResolvedRoot);
    const other = new FsBlobStore(otherRoot);

    expect(first.namespaceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.namespaceSha256).toBe(same.namespaceSha256);
    expect(first.namespaceSha256).not.toBe(other.namespaceSha256);
    expect(first.namespaceSha256).not.toContain(base);
  });

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

  it("uses the expected descriptor and upload token to discard crash artifacts", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const internals = store as unknown as {
      createUploadTemp(path: string, envelope: Buffer): Promise<boolean>;
    };
    const createUploadTemp = internals.createUploadTemp.bind(store);
    internals.createUploadTemp = async (path, envelope) => {
      const created = await createUploadTemp(path, envelope);
      await link(path, path.replace(/\.writing$/, ".ready"));
      throw new Error("simulated migration copy response loss");
    };

    await expect(store.putIfAbsent("objects/abort-crash", "uncommitted", {
      uploadToken: "abort-crash-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toThrow("simulated migration copy response loss");
    internals.createUploadTemp = createUploadTemp;
    const descriptor = {
      storageKey: "objects/abort-crash",
      sha256: createHash("sha256").update("uncommitted").digest("hex"),
      sizeBytes: 11,
      contentType: "text/plain",
    };

    await store.discardUncommittedTarget("objects/abort-crash", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "abort-crash-token",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect((await readdir(join(root, "objects"))).filter((name) => name.startsWith(".asblob-"))).toEqual([]);
    expect(await store.inspectExact("objects/abort-crash", { maxBytes: MAX_BYTES })).toEqual({ kind: "missing" });
  });

  it("does not replace data that wins a migration-tombstone create-only race", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const foreignWriter = new FsBlobStore(root);
    const internals = store as unknown as {
      createUploadTemp(path: string, envelope: Buffer): Promise<boolean>;
    };
    const createUploadTemp = internals.createUploadTemp.bind(store);
    let injected = false;
    internals.createUploadTemp = async (path, envelope) => {
      const created = await createUploadTemp(path, envelope);
      if (!injected) {
        injected = true;
        await foreignWriter.putIfAbsent("objects/migration-tombstone-race", "foreign", {
          uploadToken: "foreign-winner",
          maxBytes: MAX_BYTES,
          contentType: "text/plain",
        });
      }
      return created;
    };

    await expect(store.delete("objects/migration-tombstone-race", {
      uploadToken: "migration-tombstone-race",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await store.get("objects/migration-tombstone-race", { maxBytes: MAX_BYTES }))?.data.toString()).toBe(
      "foreign",
    );
    expect(await store.inspectExact("objects/migration-tombstone-race", { maxBytes: MAX_BYTES })).toMatchObject({
      kind: "data",
    });
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
    expect(await store.getExact("legacy/blob", { maxBytes: MAX_BYTES })).toEqual({
      storageKey: "legacy/blob",
      sha256: createHash("sha256").update("legacy bytes").digest("hex"),
      sizeBytes: 12,
      contentType: "text/legacy",
      data: Buffer.from("legacy bytes"),
    });
    expect(await store.inspectExact("legacy/blob", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor: {
        storageKey: "legacy/blob",
        sha256: createHash("sha256").update("legacy bytes").digest("hex"),
        sizeBytes: 12,
        contentType: "text/legacy",
      },
    });
    await expect(store.get("file://legacy/blob", { maxBytes: MAX_BYTES })).rejects.toThrow("blob key");
    await expect(store.getLegacy("file+asblob2://legacy/blob", { maxBytes: MAX_BYTES })).rejects.toThrow(
      "invalid legacy filesystem blob reference",
    );
    await store.deleteLegacy("file://legacy/blob");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${path}.meta`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes legacy metadata on token-bound deletion, including orphaned crash residue", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    const key = "legacy/manifest-delete";
    const path = join(root, ...key.split("/"));
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(path, "legacy bytes");
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: "text/legacy" }));

    await store.delete(key, { uploadToken: "legacy-manifest-delete" });
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${path}.meta`)).rejects.toMatchObject({ code: "ENOENT" });

    const orphanKey = "legacy/orphan-sidecar";
    const orphanPath = join(root, ...orphanKey.split("/"));
    await writeFile(`${orphanPath}.meta`, JSON.stringify({ contentType: "text/legacy" }));
    await store.delete(orphanKey, { uploadToken: "legacy-orphan-delete" });
    await expect(access(`${orphanPath}.meta`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.inspectExact(orphanKey, { maxBytes: MAX_BYTES }))
      .resolves.toEqual({ kind: "tombstone" });
  });

  it("keeps an exact legacy raw target because it has no migration owner marker", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const path = join(root, "legacy", "discard");
    await mkdir(join(root, "legacy"), { recursive: true });
    await writeFile(path, "legacy discard");
    await writeFile(`${path}.meta`, JSON.stringify({ contentType: "text/plain" }));
    const store = new FsBlobStore(root);
    const inspection = await store.inspectExact("legacy/discard", { maxBytes: MAX_BYTES });
    expect(inspection.kind).toBe("data");
    if (inspection.kind !== "data") throw new Error("expected legacy data inspection");

    await expect(store.discardUncommittedTarget("legacy/discard", {
      expectedState: inspection,
      uploadToken: "legacy-discard",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.inspectExact("legacy/discard", { maxBytes: MAX_BYTES })).toEqual(inspection);
    await expect(access(path)).resolves.toBeUndefined();
    await expect(access(`${path}.meta`)).resolves.toBeUndefined();
  });

  it("gives a cancellation tombstone priority over a residual target during exact inspection", async () => {
    const root = join(await makeTempDirectory(), "blobs");
    const store = new FsBlobStore(root);
    await store.putIfAbsent("objects/tombstone-priority", "sensitive", {
      uploadToken: "tombstone-priority",
      maxBytes: MAX_BYTES,
    });
    const target = join(root, "objects", "tombstone-priority");
    const envelope = await readFile(target);
    await store.delete("objects/tombstone-priority", { uploadToken: "tombstone-priority" });
    await writeFile(target, envelope);

    expect(await store.inspectExact("objects/tombstone-priority", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
    });
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
  symlinkIt("binds namespace identity to a canonical ancestor and rejects alias retargeting", async () => {
    const base = await makeTempDirectory();
    const firstParent = join(base, "first-parent");
    const secondParent = join(base, "second-parent");
    const alias = join(base, "parent-alias");
    await mkdir(firstParent);
    await mkdir(secondParent);
    await symlink(firstParent, alias, "dir");

    const aliased = new FsBlobStore(join(alias, "blobs"));
    const direct = new FsBlobStore(join(firstParent, "blobs"));
    expect(aliased.namespaceSha256).toBe(direct.namespaceSha256);

    await rm(alias);
    await symlink(secondParent, alias, "dir");
    await expect(aliased.putIfAbsent("objects/retargeted", "must-not-write", {
      uploadToken: "retargeted-parent",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("blob root identity changed");
    await expect(access(join(secondParent, "blobs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

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
