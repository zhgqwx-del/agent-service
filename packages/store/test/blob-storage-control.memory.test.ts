import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobStorageControlConflictError,
  MemorySessionStore,
  type BlobDeleteOutboxRecord,
  type BlobManifest,
  type BlobStorageControlRecord,
  type UserDataExportArtifactPart,
  type UserDataExportArtifactRecord,
  type UserDataExportDeleteOutboxRecord,
  type UserDataExportSnapshotBlob,
} from "../src/index.js";
import { mkSession, newId } from "./conformance.js";

const BACKEND = `s3v1-${"a".repeat(24)}`;
const NAMESPACE = "b".repeat(64);

function activation(storageBackend = BACKEND, namespaceSha256 = NAMESPACE) {
  return { expectedControlGeneration: 0 as const, storageBackend, namespaceSha256 };
}

describe("MemorySessionStore Blob storage control", () => {
  it("starts dormant, activates once, and treats an exact response-loss replay as idempotent", async () => {
    let now = 1_234;
    const store = new MemorySessionStore({ now: () => now });
    expect(await store.getBlobStorageControl()).toEqual({ singletonId: 1, controlGeneration: 0 });

    const active = await store.activateBlobStorageControl(activation());
    expect(active).toMatchObject({
      singletonId: 1,
      controlGeneration: 1,
      storageBackend: BACKEND,
      namespaceSha256: NAMESPACE,
      activatedAtDbMs: 1_234,
      evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    now = 9_999;
    expect(await store.activateBlobStorageControl(activation())).toEqual(active);
    await expect(store.activateBlobStorageControl(activation(BACKEND, "c".repeat(64))))
      .rejects.toBeInstanceOf(BlobStorageControlConflictError);
    await expect(store.activateBlobStorageControl(activation("filesystem-v1")))
      .rejects.toBeInstanceOf(BlobStorageControlConflictError);
  });

  it("serializes competing activations without publishing a partial generation", async () => {
    const store = new MemorySessionStore({ now: () => 2_000 });
    const [first, second] = await Promise.allSettled([
      store.activateBlobStorageControl(activation(BACKEND, "1".repeat(64))),
      store.activateBlobStorageControl(activation(BACKEND, "2".repeat(64))),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(await store.getBlobStorageControl()).toMatchObject({
      controlGeneration: 1,
      namespaceSha256: "1".repeat(64),
    });
  });

  it("rejects every live or uncompleted foreign-backend inventory class but ignores completed history", async () => {
    const cases: Array<(store: MemorySessionStore) => void> = [
      (store) => store.blobManifests.set("blob", {
        state: "ready", storageBackend: "filesystem-v1",
      } as unknown as BlobManifest),
      (store) => store.userDataExportArtifacts.set("artifact", {
        state: "ready", storageBackend: "filesystem-v1",
      } as unknown as UserDataExportArtifactRecord),
      (store) => store.userDataExportParts.set("part", {
        state: "uploaded", storageBackend: "filesystem-v1",
      } as unknown as UserDataExportArtifactPart),
      (store) => store.userDataExportSnapshotBlobs.set("snapshot", [{
        storageBackend: BACKEND,
        // A pre-0027 unreleased pin has no full namespace identity and must block cutover.
      } as unknown as UserDataExportSnapshotBlob]),
      (store) => store.blobDeleteOutbox.set("blob-delete", {
        storageBackend: "filesystem-v1",
      } as unknown as BlobDeleteOutboxRecord),
      (store) => store.userDataExportDeleteOutbox.set("export-delete", {
        storageBackend: "filesystem-v1",
      } as unknown as UserDataExportDeleteOutboxRecord),
      // Dead-letter only stops automatic retry; without a physical completion ACK it still blocks.
      (store) => store.blobDeleteOutbox.set("blob-delete-dead-letter", {
        storageBackend: "filesystem-v1",
        deadLetteredAtMs: 2_999,
      } as unknown as BlobDeleteOutboxRecord),
    ];
    for (const arrange of cases) {
      const store = new MemorySessionStore({ now: () => 3_000 });
      arrange(store);
      await expect(store.activateBlobStorageControl(activation()))
        .rejects.toBeInstanceOf(BlobStorageControlConflictError);
      expect(await store.getBlobStorageControl()).toEqual({ singletonId: 1, controlGeneration: 0 });
    }

    const deleted = new MemorySessionStore({ now: () => 3_001 });
    deleted.blobManifests.set("blob", {
      state: "deleted", storageBackend: "filesystem-v1",
    } as unknown as BlobManifest);
    deleted.userDataExportArtifacts.set("artifact", {
      state: "deleted", storageBackend: "filesystem-v1",
    } as unknown as UserDataExportArtifactRecord);
    deleted.userDataExportParts.set("part", {
      state: "deleted", storageBackend: "filesystem-v1",
    } as unknown as UserDataExportArtifactPart);
    deleted.userDataExportSnapshotBlobs.set("snapshot", [{
      storageBackend: "filesystem-v1",
      releasedAtMs: 3_000,
    } as unknown as UserDataExportSnapshotBlob]);
    deleted.blobDeleteOutbox.set("completed-blob-delete", {
      storageBackend: "filesystem-v1",
      completedAtMs: 3_000,
    } as unknown as BlobDeleteOutboxRecord);
    deleted.userDataExportDeleteOutbox.set("completed-export-delete", {
      storageBackend: "filesystem-v1",
      completedAtMs: 3_000,
    } as unknown as UserDataExportDeleteOutboxRecord);
    await expect(deleted.activateBlobStorageControl(activation())).resolves.toMatchObject({
      controlGeneration: 1,
    });
  });

  it("rolls back a late in-memory publication failure", async () => {
    const store = new MemorySessionStore({ now: () => 4_000 });
    const controls = store.blobStorageControls;
    Object.defineProperty(controls, "set", {
      configurable: true,
      value(key: 1, value: BlobStorageControlRecord) {
        Map.prototype.set.call(controls, key, value);
        throw new Error("injected Blob storage control publication failure");
      },
    });
    await expect(store.activateBlobStorageControl(activation()))
      .rejects.toThrow("injected Blob storage control publication failure");
    delete (controls as unknown as { set?: unknown }).set;
    expect(await store.getBlobStorageControl()).toEqual({ singletonId: 1, controlGeneration: 0 });
  });

  it("rejects a post-cutover foreign manifest before mutating session state", async () => {
    const store = new MemorySessionStore({ now: () => 5_000 });
    await store.activateBlobStorageControl(activation());
    const session = mkSession("tenant_blob_control", "user_blob_control");
    await store.createSession(session);
    const blobId = newId("blob");
    await expect(store.stageBlob({
      owner: { tenantId: session.tenantId, userId: session.userId },
      sessionId: session.id,
      fence: 1,
      blobId,
      purpose: "tool_output",
      storageBackend: "filesystem-v1",
      storageFormat: BLOB_STORAGE_FORMAT,
      storageKey: `objects/${blobId.slice(5)}`,
      uploadToken: `upload-${blobId.slice(5, 29)}`,
      createdAtMs: 5_000,
      stagingExpiresAtMs: 6_000,
    })).rejects.toBeInstanceOf(BlobStorageControlConflictError);
    expect(await store.getBlobManifest(blobId)).toBeNull();
    expect((await store.getSession(session.tenantId, session.id))?.fenceToken).toBe(0);
  });
});
