import type { BlobStorageCapability } from "@agent-service/protocol";
import { MemorySessionStore, type BlobStorageControlStore } from "@agent-service/store";
import { describe, expect, it } from "vitest";
import {
  reconcileBlobStorageControl,
  reconcileBlobStorageControlForRuntime,
} from "../src/blob-storage-control.js";

const EXPECTED: BlobStorageCapability = {
  backend: `s3-v1-${"a".repeat(24)}`,
  shared: true,
  namespaceSha256: "a".repeat(64),
  controlGeneration: 1,
};

describe("runner Blob storage startup control", () => {
  it("leaves an inactive filesystem database dormant", async () => {
    const store = new MemorySessionStore();
    await expect(reconcileBlobStorageControl(store)).resolves.toBe(0);
    await expect(store.getBlobStorageControl()).resolves.toEqual({ singletonId: 1, controlGeneration: 0 });
  });

  it("activates one exact namespace and lets concurrent runners converge", async () => {
    const store = new MemorySessionStore();
    await expect(Promise.all(Array.from({ length: 8 }, () => (
      reconcileBlobStorageControl(store, EXPECTED)
    )))).resolves.toEqual(Array(8).fill(1));
    await expect(store.getBlobStorageControl()).resolves.toMatchObject({
      controlGeneration: 1,
      storageBackend: EXPECTED.backend,
      namespaceSha256: EXPECTED.namespaceSha256,
    });
  });

  it("recovers a lost activation response only after an exact independent read", async () => {
    const durable = new MemorySessionStore();
    const responseLoss: BlobStorageControlStore = {
      getBlobStorageControl: () => durable.getBlobStorageControl(),
      activateBlobStorageControl: async (input) => {
        await durable.activateBlobStorageControl(input);
        throw new Error("simulated response loss");
      },
    };
    await expect(reconcileBlobStorageControl(responseLoss, EXPECTED)).resolves.toBe(1);
  });

  it("rechecks migration authority after an exact namespace reconciliation", async () => {
    const store = new MemorySessionStore();
    await store.activateBlobStorageControl({
      expectedControlGeneration: 0,
      storageBackend: EXPECTED.backend,
      namespaceSha256: EXPECTED.namespaceSha256,
    });
    const startupRace = new Error("migration committed during S3 startup");
    let checkedAfterReconciliation = false;

    await expect(reconcileBlobStorageControlForRuntime(
      store,
      EXPECTED,
      async () => {
        await expect(store.getBlobStorageControl()).resolves.toMatchObject({
          controlGeneration: 1,
          storageBackend: EXPECTED.backend,
          namespaceSha256: EXPECTED.namespaceSha256,
        });
        checkedAfterReconciliation = true;
        throw startupRace;
      },
    )).rejects.toBe(startupRace);
    expect(checkedAfterReconciliation).toBe(true);
  });

  it("rejects namespace rollback, mismatch, and filesystem fallback after activation", async () => {
    const store = new MemorySessionStore();
    await reconcileBlobStorageControl(store, EXPECTED);
    await expect(reconcileBlobStorageControl(store, {
      ...EXPECTED,
      backend: `s3-v1-${"b".repeat(24)}`,
      namespaceSha256: "b".repeat(64),
    })).rejects.toThrow(/does not match/);
    await expect(reconcileBlobStorageControl(store)).rejects.toThrow(/filesystem/);
  });
});
