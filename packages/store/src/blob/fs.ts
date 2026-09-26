import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BlobStore } from "../types.js";
import { validateBlobKey } from "./key.js";

const ENVELOPE_REF_PREFIX = "file+asblob2://";
const LEGACY_REF_PREFIX = "file://";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ENVELOPE_MAGIC = Buffer.from("ASBLOB02", "ascii");
const DIGEST_BYTES = 32;
const METADATA_LENGTH_OFFSET = ENVELOPE_MAGIC.length;
const PAYLOAD_LENGTH_OFFSET = METADATA_LENGTH_OFFSET + 4;
const DIGEST_OFFSET = PAYLOAD_LENGTH_OFFSET + 4;
const ENVELOPE_HEADER_BYTES = DIGEST_OFFSET + DIGEST_BYTES;
const MAX_METADATA_BYTES = 16 * 1024;

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function unlinkIfExists(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function encodeEnvelope(data: Buffer | string, contentType?: string) {
  // Copy before the caller can regain control at the first await in put().
  const payload = Buffer.from(data);
  const metadata = Buffer.from(JSON.stringify(contentType === undefined ? {} : { contentType }), "utf8");
  if (metadata.length > MAX_METADATA_BYTES) throw new Error("blob metadata is too large");

  const header = Buffer.allocUnsafe(ENVELOPE_HEADER_BYTES);
  ENVELOPE_MAGIC.copy(header);
  header.writeUInt32BE(metadata.length, METADATA_LENGTH_OFFSET);
  header.writeUInt32BE(payload.length, PAYLOAD_LENGTH_OFFSET);
  const digest = createHash("sha256")
    .update(header.subarray(0, DIGEST_OFFSET))
    .update(metadata)
    .update(payload)
    .digest();
  digest.copy(header, DIGEST_OFFSET);
  return Buffer.concat([header, metadata, payload]);
}

function hasEnvelopeMagic(data: Buffer) {
  return data.length >= ENVELOPE_MAGIC.length && data.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC);
}

function decodeEnvelope(envelope: Buffer) {
  if (envelope.length < ENVELOPE_HEADER_BYTES || !hasEnvelopeMagic(envelope)) {
    throw new Error("invalid blob envelope");
  }

  const metadataLength = envelope.readUInt32BE(METADATA_LENGTH_OFFSET);
  const payloadLength = envelope.readUInt32BE(PAYLOAD_LENGTH_OFFSET);
  const payloadOffset = ENVELOPE_HEADER_BYTES + metadataLength;
  if (metadataLength > MAX_METADATA_BYTES || payloadOffset + payloadLength !== envelope.length) {
    throw new Error("invalid blob envelope length");
  }

  const expectedDigest = envelope.subarray(DIGEST_OFFSET, DIGEST_OFFSET + DIGEST_BYTES);
  const actualDigest = createHash("sha256")
    .update(envelope.subarray(0, DIGEST_OFFSET))
    .update(envelope.subarray(ENVELOPE_HEADER_BYTES, payloadOffset))
    .update(envelope.subarray(payloadOffset))
    .digest();
  if (!timingSafeEqual(expectedDigest, actualDigest)) throw new Error("invalid blob envelope checksum");

  let metadata: unknown;
  try {
    metadata = JSON.parse(envelope.subarray(ENVELOPE_HEADER_BYTES, payloadOffset).toString("utf8"));
  } catch {
    throw new Error("invalid blob metadata");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid blob metadata");
  const contentType = (metadata as { contentType?: unknown }).contentType;
  if (contentType !== undefined && typeof contentType !== "string") throw new Error("invalid blob metadata");

  return { data: Buffer.from(envelope.subarray(payloadOffset)), contentType };
}

/**
 * Local filesystem blob store (dev). The configured root must be service-private: Node has no
 * portable openat/O_NOFOLLOW primitive, so the lstat checks below reject static symlinks but cannot
 * eliminate races with another process that is allowed to replace entries inside the root.
 * A rename is atomic for concurrent readers, but this development adapter is not a power-loss
 * durability boundary. Production swaps in OSS/S3 behind the same interface.
 */
export class FsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("blob root must not be empty");
    this.root = resolve(root);
  }

  private parseRef(ref: string) {
    if (ref.startsWith(ENVELOPE_REF_PREFIX)) {
      return { key: ref.slice(ENVELOPE_REF_PREFIX.length), envelopeRequired: true };
    }
    if (ref.startsWith(LEGACY_REF_PREFIX)) {
      return { key: ref.slice(LEGACY_REF_PREFIX.length), envelopeRequired: false };
    }
    throw new Error("invalid filesystem blob reference");
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
        if ((mkdirError as NodeJS.ErrnoException)?.code !== "EEXIST") throw mkdirError;
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
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async path(key: string, create: boolean) {
    const segments = validateBlobKey(key);
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

  private async temporaryFile(target: string, data: Buffer | string) {
    const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, data, { flag: "wx", mode: FILE_MODE });
      await chmod(temp, FILE_MODE);
      return temp;
    } catch (error) {
      try {
        await unlinkIfExists(temp);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "failed to create and clean up temporary blob file");
      }
      throw error;
    }
  }

  private async legacyContentType(path: string) {
    const metadataPath = `${path}.meta`;
    await this.assertSafeFile(metadataPath);
    let raw: string;
    try {
      raw = await readFile(metadataPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(raw);
    } catch {
      throw new Error("invalid legacy blob metadata");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("invalid legacy blob metadata");
    }
    const contentType = (metadata as { contentType?: unknown }).contentType;
    if (contentType !== undefined && typeof contentType !== "string") {
      throw new Error("invalid legacy blob metadata");
    }
    return contentType;
  }

  async put(key: string, data: Buffer | string, contentType?: string) {
    const envelope = encodeEnvelope(data, contentType);
    const path = await this.path(key, true);
    if (!path) throw new Error("blob root is unavailable");
    let temp: string | undefined;
    try {
      temp = await this.temporaryFile(path, envelope);
      // The entire version is published by one rename. Readers can therefore observe only the old
      // complete envelope or the new complete envelope, never bytes and metadata from different puts.
      await rename(temp, path);
      temp = undefined;
      // The versioned ref makes corruption distinguishable from a pre-envelope raw file. `file://`
      // remains read/delete compatible for safe legacy keys but is never issued for new writes.
      return { ref: `${ENVELOPE_REF_PREFIX}${key}` };
    } finally {
      if (temp) await unlinkIfExists(temp);
    }
  }

  async get(ref: string) {
    const parsed = this.parseRef(ref);
    const path = await this.path(parsed.key, false);
    if (!path) return null;
    let envelope: Buffer;
    try {
      envelope = await readFile(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (parsed.envelopeRequired || hasEnvelopeMagic(envelope)) return decodeEnvelope(envelope);
    // Transitional read compatibility for the pre-envelope local format. Unsafe legacy keys remain
    // rejected by the new validator and must be migrated out-of-band before upgrade.
    return { data: Buffer.from(envelope), contentType: await this.legacyContentType(path) };
  }

  async delete(ref: string) {
    const path = await this.path(this.parseRef(ref).key, false);
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
