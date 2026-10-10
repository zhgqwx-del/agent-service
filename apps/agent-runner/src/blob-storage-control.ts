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

/**
 * Reconcile the write-once Blob identity, then re-read the independent migration control before
 * runtime is allowed to start. The first startup gate runs before an S3 adapter is opened; this
 * second gate closes the interval in which an offline mover could commit that same namespace while
 * adapter validation was in flight. Once ordinary generation-1 activation wins instead, the mover's
 * freeze transaction is permanently fenced by the Blob control row.
 */
export async function reconcileBlobStorageControlForRuntime(
  store: BlobStorageControlStore,
  expected: BlobStorageCapability | undefined,
  assertMigrationRuntimeReady: () => Promise<void>,
): Promise<0 | 1> {
  const generation = await reconcileBlobStorageControl(store, expected);
  await assertMigrationRuntimeReady();
  return generation;
}
