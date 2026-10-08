const MAX_BLOB_KEY_LENGTH = 512;
const MAX_BLOB_KEY_SEGMENT_LENGTH = 128;
const MAX_UPLOAD_TOKEN_LENGTH = 128;
const MAX_CONTENT_TYPE_LENGTH = 255;
const MAX_ENVELOPE_PAYLOAD_BYTES = 0xffff_ffff;
// Lowercase is intentional: APFS, NTFS and common macOS/Windows development volumes case-fold
// filenames. Accepting both `Tenant` and `tenant` would make FsBlobStore alias keys that remain
// distinct in MemoryBlobStore.
const SAFE_SEGMENT = /^[a-z0-9_-]+$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const MEDIA_TYPE_TOKEN = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const CONTENT_TYPE = new RegExp(
  `^${MEDIA_TYPE_TOKEN}/${MEDIA_TYPE_TOKEN}(?: *; *${MEDIA_TYPE_TOKEN} *= *${MEDIA_TYPE_TOKEN})*$`,
);

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

/** Upload tokens become filenames, so they use one case-stable key segment without separators. */
export function validateBlobUploadToken(uploadToken: string): string {
  if (
    !uploadToken
    || uploadToken.length > MAX_UPLOAD_TOKEN_LENGTH
    || !SAFE_SEGMENT.test(uploadToken)
    || WINDOWS_DEVICE_NAME.test(uploadToken)
  ) {
    throw new Error(
      `blob upload token must contain 1-${MAX_UPLOAD_TOKEN_LENGTH} lowercase ASCII letters, digits, underscores, or hyphens`,
    );
  }
  return uploadToken;
}

/**
 * Accept a deliberately small, header-safe MIME subset. In particular CR/LF, Unicode controls,
 * quoted parameter values and unbounded metadata cannot reach a response header or envelope.
 */
export function validateBlobContentType(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined;
  if (
    contentType.length === 0
    || contentType.length > MAX_CONTENT_TYPE_LENGTH
    || contentType.trim() !== contentType
    || !CONTENT_TYPE.test(contentType)
  ) {
    throw new Error("blob content type must be a header-safe ASCII media type");
  }
  return contentType;
}

/** The envelope uses uint32 lengths; callers must also choose an explicit, finite lower ceiling. */
export function validateBlobMaxBytes(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_ENVELOPE_PAYLOAD_BYTES) {
    throw new Error(`blob maxBytes must be an integer between 0 and ${MAX_ENVELOPE_PAYLOAD_BYTES}`);
  }
  return maxBytes;
}
