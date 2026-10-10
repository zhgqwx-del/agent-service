import type { BlobStorageCapability } from "@agent-service/protocol";
import type { BlobStorageControlStore } from "@agent-service/store";

function matches(
  control: Awaited<ReturnType<BlobStorageControlStore["getBlobStorageControl"]>>,
  expected: BlobStorageCapability,
): boolean {
  return control.controlGeneration === 1
    && control.storageBackend === expected.backend
    && control.namespaceSha256 === expected.namespaceSha256;
}

/**
 * Reconcile a process' non-secret object-store identity with the database-wide write-once cutover.
 * This must complete before bootstrap mutations, workers, readiness, or the HTTP listener start.
 */
export async function reconcileBlobStorageControl(
  store: BlobStorageControlStore,
  expected?: BlobStorageCapability,
): Promise<0 | 1> {
  let control = await store.getBlobStorageControl();
  if (!expected) {
    if (control.controlGeneration !== 0) {
      throw new Error("filesystem Blob storage cannot start after the shared storage cutover");
    }
    return 0;
  }

  if (control.controlGeneration === 0) {
    try {
      control = await store.activateBlobStorageControl({
        expectedControlGeneration: 0,
        storageBackend: expected.backend,
        namespaceSha256: expected.namespaceSha256,
      });
    } catch (error) {
      // Another runner can win activation, or the response can be lost after commit. Recover only
      // from an independent exact read of the immutable namespace identity.
      control = await store.getBlobStorageControl();
      if (!matches(control, expected)) throw error;
    }
  }
  if (!matches(control, expected)) {
    throw new Error("shared Blob storage does not match the durable database control");
  }
  return 1;
}
