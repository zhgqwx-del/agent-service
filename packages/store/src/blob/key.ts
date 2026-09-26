const MAX_BLOB_KEY_LENGTH = 512;
const MAX_BLOB_KEY_SEGMENT_LENGTH = 128;
// Lowercase is intentional: APFS, NTFS and common macOS/Windows development volumes case-fold
// filenames. Accepting both `Tenant` and `tenant` would make FsBlobStore alias keys that remain
// distinct in MemoryBlobStore.
const SAFE_SEGMENT = /^[a-z0-9_-]+$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Validate an opaque blob-store key. Keeping this grammar independent of the host filesystem makes
 * MemoryBlobStore and FsBlobStore accept exactly the same keys on every supported platform.
 */
export function validateBlobKey(key: string): string[] {
  if (!key || key.length > MAX_BLOB_KEY_LENGTH) {
    throw new Error(`blob key must contain between 1 and ${MAX_BLOB_KEY_LENGTH} ASCII characters`);
  }

  const segments = key.split("/");
  for (const segment of segments) {
    if (!segment || segment.length > MAX_BLOB_KEY_SEGMENT_LENGTH || !SAFE_SEGMENT.test(segment)) {
      throw new Error(
        `blob key segments must contain 1-${MAX_BLOB_KEY_SEGMENT_LENGTH} lowercase ASCII letters, digits, underscores, or hyphens`,
      );
    }
    if (WINDOWS_DEVICE_NAME.test(segment)) {
      throw new Error("blob key contains a reserved filesystem name");
    }
  }

  return segments;
}
