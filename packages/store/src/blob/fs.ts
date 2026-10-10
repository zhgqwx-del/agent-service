import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BlobConflictError,
  BlobTooLargeError,
  type BlobDeleteOptions,
  type BlobDescriptor,
  type BlobObject,
  type BlobPutOptions,
  type BlobReadOptions,
  type BlobStore,
} from "../types.js";
import {
  BLOB_ENVELOPE_HEADER_BYTES,
  BLOB_ENVELOPE_MAX_METADATA_BYTES,
  blobDescriptorFor,
  blobEnvelopeLengths,
  decodeBlobDataEnvelope,
  encodeBlobDataEnvelope,
  inputByteLength,
  sameBlobDescriptor,
} from "./envelope.js";
import {
  validateBlobContentType,
  validateBlobKey,
  validateBlobMaxBytes,
  validateBlobUploadToken,
} from "./key.js";

const LEGACY_REF_PREFIX = "file://";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UPLOAD_WAIT_ATTEMPTS = 1_000;
const UPLOAD_WAIT_MS = 5;

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return isErrno(error, "ENOENT");
}

async function unlinkIfExists(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  target: Buffer,
  targetOffset: number,
  length: number,
  fileOffset: number,
) {
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(target, targetOffset + consumed, length - consumed, fileOffset + consumed);
    if (bytesRead === 0) throw new Error("blob file changed while being read");
    consumed += bytesRead;
  }
}

/**
 * Local filesystem blob store (dev). The configured root must be service-private: Node has no
 * portable openat/O_NOFOLLOW primitive, so the lstat checks below reject static symlinks but cannot
 * eliminate races with another process that is allowed to replace entries inside the root.
 * Hard links provide a create-only atomic publication point for concurrent readers/writers, but
 * this development adapter is not a power-loss durability boundary. Production swaps in OSS/S3.
 */
export class FsBlobStore implements BlobStore {
  readonly backend = "filesystem-v1";
  private readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("blob root must not be empty");
    this.root = resolve(root);
  }

  private parseLegacyRef(ref: string) {
    if (!ref.startsWith(LEGACY_REF_PREFIX)) throw new Error("invalid legacy filesystem blob reference");
    const key = ref.slice(LEGACY_REF_PREFIX.length);
    validateBlobKey(key);
    return key;
  }

  private async canonicalRoot(create: boolean) {
    if (create) await mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    try {
      const stat = await lstat(this.root);
      if (stat.isSymbolicLink()) throw new Error("blob root must not be a symbolic link");
      if (!stat.isDirectory()) throw new Error("blob root must be a directory");
      await chmod(this.root, DIRECTORY_MODE);
      return await realpath(this.root);
    } catch (error) {
      if (!create && isNotFound(error)) return null;
      throw error;
    }
  }

  private async assertDirectory(path: string, create: boolean) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("blob path contains a symbolic link");
      if (!stat.isDirectory()) throw new Error("blob path parent is not a directory");
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (!create) return false;
      try {
        await mkdir(path, { mode: DIRECTORY_MODE });
      } catch (mkdirError) {
        if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
      }
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("blob path contains a symbolic link");
      if (!stat.isDirectory()) throw new Error("blob path parent is not a directory");
    }
    await chmod(path, DIRECTORY_MODE);
    return true;
  }

  private async assertSafeFile(path: string) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("blob path contains a symbolic link");
      if (!stat.isFile()) throw new Error("blob path is not a regular file");
      await chmod(path, FILE_MODE);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async path(storageKey: string, create: boolean) {
    const segments = validateBlobKey(storageKey);
    const root = await this.canonicalRoot(create);
    if (!root) return null;

    const path = resolve(root, ...segments);
    const fromRoot = relative(root, path);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("blob key escapes root");
    }

    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      if (!(await this.assertDirectory(parent, create))) return path;
    }
    await this.assertSafeFile(path);
    return path;
  }

  private uploadPaths(target: string, uploadToken: string) {
    const nameHash = createHash("sha256").update(basename(target)).digest("hex");
    const prefix = join(dirname(target), `.asblob-${nameHash}-${uploadToken}`);
    return {
      writing: `${prefix}.writing`,
      ready: `${prefix}.ready`,
      // This intentionally survives physical deletion. A staging sweeper can linearize before an
      // uploader has created either temporary path; without a durable fence that late uploader could
      // publish an object after the outbox had already been acknowledged, leaving an untracked orphan.
      // The fence is key-scoped rather than token-scoped because storage keys are globally unique and
      // must never be resurrected by a caller that accidentally supplies a different upload token.
      cancelled: join(dirname(target), `.asblob-${nameHash}.cancelled`),
    };
  }

  private async createCancellationFence(path: string) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", FILE_MODE);
      await handle.chmod(FILE_MODE);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (!(await this.assertSafeFile(path))) {
        throw new Error("blob upload cancellation fence disappeared");
      }
    } finally {
      await handle?.close();
    }
  }

  private async assertUploadNotCancelled(path: string, storageKey: string) {
    if (await this.assertSafeFile(path)) {
      throw new Error(`blob upload ${storageKey} was cancelled before publication`);
    }
  }

  private async createUploadTemp(path: string, envelope: Buffer) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "wx", FILE_MODE);
    } catch (error) {
      if (isErrno(error, "EEXIST")) return false;
      throw error;
    }

    try {
      await handle.chmod(FILE_MODE);
      await handle.writeFile(envelope);
      return true;
    } catch (error) {
      try {
        await handle.close();
        await unlinkIfExists(path);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to create and clean up blob upload temp");
      }
      throw error;
    } finally {
      try {
        await handle.close();
      } catch {
        // A write failure reports its primary error above; a successful close is handled normally.
      }
    }
  }

  private async readEnvelopePath(
    path: string,
    storageKey: string,
    maxBytes: number,
  ): Promise<BlobObject | null> {
    if (!(await this.assertSafeFile(path))) return null;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("blob path is not a regular file");
      if (stat.size < BLOB_ENVELOPE_HEADER_BYTES) throw new Error("invalid blob envelope");

      const header = Buffer.allocUnsafe(BLOB_ENVELOPE_HEADER_BYTES);
      await readExactly(handle, header, 0, BLOB_ENVELOPE_HEADER_BYTES, 0);
      const { metadataLength, payloadLength } = blobEnvelopeLengths(header);
      if (
        metadataLength > BLOB_ENVELOPE_MAX_METADATA_BYTES
        || BLOB_ENVELOPE_HEADER_BYTES + metadataLength + payloadLength !== stat.size
      ) {
        throw new Error("invalid blob envelope length");
      }
      if (payloadLength > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, payloadLength);

      // Only the fixed-size header was read before the payload length was checked.
      const envelope = Buffer.allocUnsafe(stat.size);
      header.copy(envelope);
      await readExactly(
        handle,
        envelope,
        BLOB_ENVELOPE_HEADER_BYTES,
        stat.size - BLOB_ENVELOPE_HEADER_BYTES,
        BLOB_ENVELOPE_HEADER_BYTES,
      );
      return decodeBlobDataEnvelope(storageKey, envelope);
    } finally {
      await handle.close();
    }
  }

  private async readRawPath(path: string, storageKey: string, maxBytes: number): Promise<Buffer | null> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("blob path is not a regular file");
      if (stat.size > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, stat.size);
      const data = Buffer.allocUnsafe(stat.size);
      await readExactly(handle, data, 0, stat.size, 0);
      return data;
    } finally {
      await handle.close();
    }
  }

  private async legacyContentType(path: string, storageKey: string) {
    const metadataPath = `${path}.meta`;
    if (!(await this.assertSafeFile(metadataPath))) return undefined;
    const bytes = await this.readRawPath(metadataPath, `${storageKey}.meta`, BLOB_ENVELOPE_MAX_METADATA_BYTES);
    if (!bytes) return undefined;
    let metadata: unknown;
    try {
      metadata = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("invalid legacy blob metadata");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("invalid legacy blob metadata");
    }
    const keys = Object.keys(metadata);
    if (keys.some((key) => key !== "contentType")) throw new Error("invalid legacy blob metadata");
    const value = (metadata as { contentType?: unknown }).contentType;
    if (value !== undefined && typeof value !== "string") throw new Error("invalid legacy blob metadata");
    try {
      return validateBlobContentType(value);
    } catch (error) {
      throw new Error("invalid legacy blob metadata", { cause: error });
    }
  }

  private assertSame(desired: BlobDescriptor, existing: BlobDescriptor) {
    if (!sameBlobDescriptor(desired, existing)) throw new BlobConflictError(desired.storageKey);
    return desired;
  }

  private async existingTarget(target: string, desired: BlobDescriptor, maxBytes: number) {
    const existing = await this.readEnvelopePath(target, desired.storageKey, maxBytes);
    return existing ? this.assertSame(desired, existing) : null;
  }

  private async awaitReadyUpload(
    target: string,
    writing: string,
    ready: string,
    cancelled: string,
    desired: BlobDescriptor,
    maxBytes: number,
  ): Promise<"completed" | "ready"> {
    for (let attempt = 0; attempt < UPLOAD_WAIT_ATTEMPTS; attempt += 1) {
      await this.assertUploadNotCancelled(cancelled, desired.storageKey);
      if (await this.existingTarget(target, desired, maxBytes)) return "completed";
      if (await this.assertSafeFile(ready)) {
        const candidate = await this.readEnvelopePath(ready, desired.storageKey, maxBytes);
        if (!candidate) continue;
        this.assertSame(desired, candidate);
        return "ready";
      }
      if (!(await this.assertSafeFile(writing))) {
        throw new Error(`blob upload ${desired.storageKey} was cancelled before publication`);
      }
      await new Promise((resolve) => setTimeout(resolve, UPLOAD_WAIT_MS));
    }
    throw new Error(`blob upload ${desired.storageKey} did not finish before the wait deadline`);
  }

  async putIfAbsent(storageKey: string, data: Buffer | string, options: BlobPutOptions) {
    validateBlobKey(storageKey);
    const uploadToken = validateBlobUploadToken(options.uploadToken);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const contentType = validateBlobContentType(options.contentType);
    const sizeBytes = inputByteLength(data);
    if (sizeBytes > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, sizeBytes);

    // Copy only after the byte ceiling has been checked and before the first await yields control.
    const payload = Buffer.from(data);
    const desired = blobDescriptorFor(storageKey, payload, contentType);
    const envelope = encodeBlobDataEnvelope(payload, contentType);
    const target = await this.path(storageKey, true);
    if (!target) throw new Error("blob root is unavailable");
    const upload = this.uploadPaths(target, uploadToken);

    await this.assertUploadNotCancelled(upload.cancelled, storageKey);
    const existing = await this.existingTarget(target, desired, maxBytes);
    if (existing) return existing;

    let createdUpload = false;
    let succeeded = false;
    try {
      createdUpload = await this.createUploadTemp(upload.writing, envelope);
      // `delete()` may have won while createUploadTemp was still pending, including before the
      // temporary file existed. Recheck its persistent fence before producing any publishable link.
      await this.assertUploadNotCancelled(upload.cancelled, storageKey);
      let uploadState: "completed" | "ready";
      if (createdUpload) {
        try {
          await link(upload.writing, upload.ready);
          await chmod(upload.ready, FILE_MODE);
          uploadState = "ready";
        } catch (error) {
          if (isErrno(error, "EEXIST")) {
            const candidate = await this.readEnvelopePath(upload.ready, storageKey, maxBytes);
            if (!candidate) throw error;
            this.assertSame(desired, candidate);
            uploadState = "ready";
          } else if (isNotFound(error)) {
            const completed = await this.existingTarget(target, desired, maxBytes);
            if (!completed) throw new Error(`blob upload ${storageKey} was cancelled before publication`, { cause: error });
            uploadState = "completed";
          } else {
            throw error;
          }
        }
      } else {
        uploadState = await this.awaitReadyUpload(
          target,
          upload.writing,
          upload.ready,
          upload.cancelled,
          desired,
          maxBytes,
        );
      }

      if (uploadState !== "completed") {
        await this.assertUploadNotCancelled(upload.cancelled, storageKey);
        try {
          // Hard-link creation fails with EEXIST instead of replacing another upload's object.
          await link(upload.ready, target);
          await chmod(target, FILE_MODE);
        } catch (error) {
          if (isErrno(error, "EEXIST")) {
            const completed = await this.existingTarget(target, desired, maxBytes);
            if (!completed) throw error;
          } else if (isNotFound(error)) {
            const completed = await this.existingTarget(target, desired, maxBytes);
            if (!completed) throw new Error(`blob upload ${storageKey} was cancelled before publication`, { cause: error });
          } else {
            throw error;
          }
        }
      }

      // If deletion linearized after the pre-publication check, it owns the outcome and will unlink
      // the target. Do not report a successful upload to the manifest layer in that case.
      await this.assertUploadNotCancelled(upload.cancelled, storageKey);
      succeeded = true;
      return desired;
    } finally {
      // A successful duplicate may safely clean a stale token. A conflicting duplicate must not
      // tear down the upload that currently owns that token.
      if (createdUpload || succeeded) {
        await unlinkIfExists(upload.writing);
        await unlinkIfExists(upload.ready);
      }
    }
  }

  async get(storageKey: string, options: BlobReadOptions) {
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const path = await this.path(storageKey, false);
    if (!path) return null;
    return this.readEnvelopePath(path, storageKey, maxBytes);
  }

  async delete(storageKey: string, options: BlobDeleteOptions = {}) {
    const uploadToken = options.uploadToken === undefined
      ? undefined
      : validateBlobUploadToken(options.uploadToken);
    // A manifest-driven (token-authenticated) delete is also a key-wide upload cancellation.
    // Create the private directory path even when no object/temp exists yet so the cancellation
    // fence can precede temp creation.
    const target = await this.path(storageKey, uploadToken !== undefined);
    if (!target) return;

    if (uploadToken !== undefined) {
      const upload = this.uploadPaths(target, uploadToken);
      // The persistent marker is the linearization point. It must exist before temporary/final paths
      // are removed so both an already-running writer and a future late writer observe cancellation.
      await this.createCancellationFence(upload.cancelled);
      await unlinkIfExists(upload.writing);
      await unlinkIfExists(upload.ready);
    }
    await unlinkIfExists(target);
  }

  /** Transitional access for the pre-manifest `file://` raw-file + JSON-sidecar format only. */
  async getLegacy(ref: string, options: BlobReadOptions) {
    const storageKey = this.parseLegacyRef(ref);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const path = await this.path(storageKey, false);
    if (!path) return null;
    const data = await this.readRawPath(path, storageKey, maxBytes);
    if (!data) return null;
    return { data, contentType: await this.legacyContentType(path, storageKey) };
  }

  /** Transitional deletion for safe legacy refs; new business code must call delete(storageKey). */
  async deleteLegacy(ref: string) {
    const path = await this.path(this.parseLegacyRef(ref), false);
    if (!path) return;
    let failure: unknown;
    for (const candidate of [path, `${path}.meta`]) {
      try {
        await unlinkIfExists(candidate);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}
