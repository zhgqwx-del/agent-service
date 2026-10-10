import { randomBytes } from "node:crypto";
import { blobS3Backend, blobS3NamespaceSha256 } from "@agent-service/protocol";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  BlobConflictError,
  BlobTooLargeError,
  type BlobDeleteOptions,
  type BlobDescriptor,
  type BlobDiscardUncommittedTargetOptions,
  type BlobExactInspection,
  type BlobMigrationStore,
  type BlobPutOptions,
  type BlobReadOptions,
} from "../types.js";
import {
  BLOB_ENVELOPE_HEADER_BYTES,
  BLOB_ENVELOPE_MAX_METADATA_BYTES,
  BLOB_ENVELOPE_OBJECT_CONTENT_TYPE,
  blobDescriptorFor,
  blobEnvelopeLengths,
  decodeBlobEnvelope,
  encodeBlobDataEnvelope,
  encodeBlobTombstoneEnvelope,
  inputByteLength,
  sameBlobDescriptor,
  type DecodedBlobEnvelope,
} from "./envelope.js";
import {
  validateBlobContentType,
  validateBlobKey,
  validateBlobMaxBytes,
  validateBlobMigrationOwnerSha256,
  validateBlobUploadToken,
} from "./key.js";
import {
  assertExpectedMigrationState,
  assertMigrationOwner,
  validateBlobDiscardInput,
} from "./migration.js";

const DEFAULT_PREFIX = "blobs";
const DEFAULT_MUTATION_ATTEMPTS = 8;
const DEFAULT_SDK_ATTEMPTS = 2;
const MAX_MUTATION_ATTEMPTS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const PROBE_PREFIX = "_agent_service_probe";
const SAFE_S3_ERROR_NAMES = new Set([
  "AbortError",
  "AccessDenied",
  "CredentialsProviderError",
  "InternalError",
  "InvalidAccessKeyId",
  "InvalidRequest",
  "NetworkingError",
  "NoSuchBucket",
  "ServiceUnavailable",
  "SignatureDoesNotMatch",
  "SlowDown",
  "TimeoutError",
]);

export interface S3BlobStoreOptions {
  bucket: string;
  /** Operator-assigned identity for the logical object store; it is not a credential or endpoint. */
  namespaceId: string;
  /** Lowercase, path-safe namespace prefix without a leading or trailing slash. */
  prefix?: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  maxMutationAttempts?: number;
  /** Total deadline for one SDK request and for consuming one response body. */
  requestTimeoutMs?: number;
}

type ObjectState =
  | { kind: "missing" }
  | { kind: "tombstone"; etag: string }
  | { kind: "occupied"; etag: string };

type ExactObjectState =
  | { kind: "missing" }
  | { kind: "tombstone"; etag?: string; migrationOwnerSha256?: string }
  | {
    kind: "data";
    object: Extract<DecodedBlobEnvelope, { kind: "data" }>["object"];
    etag?: string;
    migrationOwnerSha256?: string;
  };

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  return (metadata as { httpStatusCode?: unknown }).httpStatusCode;
}

function errorName(error: unknown) {
  return error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string"
    ? (error as { name: string }).name
    : undefined;
}

function isMissingObject(error: unknown) {
  const name = errorName(error);
  // A bare 404 is ambiguous: NoSuchBucket and endpoint-routing failures must never be treated as
  // an absent object, otherwise a cleanup could acknowledge deletion against the wrong namespace.
  return name === "NoSuchKey" || name === "NotFound" || name === "NoSuchObject";
}

function isConditionalConflict(error: unknown) {
  const status = errorStatus(error);
  const name = errorName(error);
  return status === 409
    || status === 412
    || name === "PreconditionFailed"
    || name === "ConditionalRequestConflict";
}

function assertDnsStyleBucket(bucket: string) {
  if (
    bucket.includes("..")
    || bucket.includes(".-")
    || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new Error("S3 bucket is invalid");
  }
}

function assertSafeContentLength(value: number | undefined) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid S3 blob content length");
  return value;
}

class S3VersionedObjectError extends Error {
  constructor() {
    super("S3 blob operation returned versioned-object evidence");
    this.name = "S3VersionedObjectError";
  }
}

class S3BlobSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3BlobError";
  }
}

function assertUnversionedEvidence(output: { VersionId?: string; DeleteMarker?: boolean }) {
  if (output.VersionId !== undefined || output.DeleteMarker === true) {
    throw new S3VersionedObjectError();
  }
}

function sanitizedS3Error(operation: string, error: unknown) {
  const status = errorStatus(error);
  const name = errorName(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const detail = [safeName, typeof status === "number" ? String(status) : undefined]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3BlobSafeError(`S3 blob ${operation} failed${detail ? ` (${detail})` : ""}`);
}

function isSafeBlobStreamError(error: unknown) {
  if (error instanceof BlobTooLargeError || error instanceof S3BlobSafeError) return true;
  if (!(error instanceof Error)) return false;
  return error.message === "invalid blob envelope"
    || error.message === "invalid blob envelope length"
    || error.message === "invalid S3 blob content length"
    || error.message === "S3 blob response body is not a Node async byte stream"
    || error.message === "S3 blob response yielded a non-byte chunk"
    || error.message === "S3 blob response stream timed out"
    || error.message === "S3 object changed while being read";
}

function bodyAsAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    return (async function* () { yield body; })();
  }
  if (
    !body
    || (typeof body !== "object" && typeof body !== "function")
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("S3 blob response body is not a Node async byte stream");
  }
  return body as AsyncIterable<Uint8Array>;
}

function destroyBody(body: unknown) {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy === "function") {
    try {
      destroy.call(body);
    } catch {
      // Preserve the primary integrity, size, or transport failure.
    }
  }
}

async function withBodyDeadline<T>(body: unknown, timeoutMs: number, read: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      destroyBody(body);
      reject(new S3BlobSafeError("S3 blob response stream timed out"));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read exactly one complete envelope while allocating only after its fixed header is validated. */
async function readBoundedEnvelope(
  storageKey: string,
  body: unknown,
  contentLength: number | undefined,
  maxBytes: number,
  timeoutMs: number,
) {
  const declaredLength = assertSafeContentLength(contentLength);
  if (declaredLength !== undefined && declaredLength < BLOB_ENVELOPE_HEADER_BYTES) {
    destroyBody(body);
    throw new Error("invalid blob envelope length");
  }

  const header = Buffer.alloc(BLOB_ENVELOPE_HEADER_BYTES);
  let headerBytes = 0;
  let envelope: Buffer | undefined;
  let envelopeBytes = 0;

  try {
    await withBodyDeadline(body, timeoutMs, async () => {
      for await (const value of bodyAsAsyncIterable(body)) {
        if (!(value instanceof Uint8Array)) throw new Error("S3 blob response yielded a non-byte chunk");
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        let chunkOffset = 0;

        if (headerBytes < BLOB_ENVELOPE_HEADER_BYTES) {
          const copied = Math.min(BLOB_ENVELOPE_HEADER_BYTES - headerBytes, chunk.length);
          chunk.copy(header, headerBytes, 0, copied);
          headerBytes += copied;
          chunkOffset += copied;
          if (headerBytes === BLOB_ENVELOPE_HEADER_BYTES) {
            const lengths = blobEnvelopeLengths(header);
            if (lengths.metadataLength > BLOB_ENVELOPE_MAX_METADATA_BYTES) {
              throw new Error("invalid blob envelope length");
            }
            if (lengths.payloadLength > maxBytes) {
              throw new BlobTooLargeError(storageKey, maxBytes, lengths.payloadLength);
            }
            if (declaredLength !== undefined && declaredLength !== lengths.totalLength) {
              throw new Error("invalid blob envelope length");
            }
            envelope = Buffer.allocUnsafe(lengths.totalLength);
            header.copy(envelope);
            envelopeBytes = BLOB_ENVELOPE_HEADER_BYTES;
          }
        }

        if (envelope && chunkOffset < chunk.length) {
          const remaining = envelope.length - envelopeBytes;
          const available = chunk.length - chunkOffset;
          if (available > remaining) throw new Error("invalid blob envelope length");
          chunk.copy(envelope, envelopeBytes, chunkOffset);
          envelopeBytes += available;
        }
      }
    });
  } catch (error) {
    destroyBody(body);
    if (isSafeBlobStreamError(error)) throw error;
    throw sanitizedS3Error("response stream", error);
  }

  if (!envelope || envelopeBytes !== envelope.length) throw new Error("invalid blob envelope length");
  return envelope;
}

async function readExactBody(
  body: unknown,
  contentLength: number | undefined,
  expected: number,
  timeoutMs: number,
) {
  const declaredLength = assertSafeContentLength(contentLength);
  if (declaredLength !== undefined && declaredLength !== expected) {
    destroyBody(body);
    throw new Error("S3 object changed while being read");
  }
  const result = Buffer.allocUnsafe(expected);
  let offset = 0;
  try {
    await withBodyDeadline(body, timeoutMs, async () => {
      for await (const value of bodyAsAsyncIterable(body)) {
        if (!(value instanceof Uint8Array)) throw new Error("S3 blob response yielded a non-byte chunk");
        if (offset + value.byteLength > expected) throw new Error("S3 object changed while being read");
        Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(result, offset);
        offset += value.byteLength;
      }
    });
  } catch (error) {
    destroyBody(body);
    if (isSafeBlobStreamError(error)) throw error;
    throw sanitizedS3Error("response stream", error);
  }
  if (offset !== expected) throw new Error("S3 object changed while being read");
  return result;
}

/**
 * Shared S3/MinIO BlobStore. Data and the permanent cancellation tombstone occupy the same key;
 * all publication and fenced deletion decisions therefore linearize through one S3 object.
 */
export class S3BlobStore implements BlobMigrationStore {
  readonly shared = true;
  readonly namespaceSha256: string;
  readonly backend: string;
  readonly bucket: string;
  readonly prefix: string;

  private readonly client: S3Client;
  private readonly maxMutationAttempts: number;
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    assertDnsStyleBucket(this.bucket);
    this.namespaceSha256 = blobS3NamespaceSha256(options.namespaceId, this.bucket, this.prefix);
    this.backend = blobS3Backend(this.namespaceSha256);

    const attempts = options.maxMutationAttempts ?? DEFAULT_MUTATION_ATTEMPTS;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_MUTATION_ATTEMPTS) {
      throw new Error(`S3 blob mutation attempts must be an integer between 1 and ${MAX_MUTATION_ATTEMPTS}`);
    }
    if (options.client && options.clientConfig) {
      throw new Error("S3 blob client and clientConfig are mutually exclusive");
    }
    this.maxMutationAttempts = attempts;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error(
        `S3 blob request timeout must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
    const clientConfig = options.clientConfig ?? {};
    this.client = options.client ?? new S3Client({
      ...clientConfig,
      // One request-local transport recovery is useful for a stale keep-alive socket (notably
      // after a successful conditional-conflict response). Every attempt and its backoff still
      // shares the single command AbortSignal deadline below; durable workers own later retries.
      maxAttempts: clientConfig.maxAttempts ?? DEFAULT_SDK_ATTEMPTS,
    });
  }

  private async send<Output>(
    request: (abortSignal: AbortSignal) => Promise<Output>,
  ): Promise<Output> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(
          new Error(`S3 blob request timed out after ${this.requestTimeoutMs}ms`),
          { name: "TimeoutError" },
        );
        // Reject the outer deadline first so a synchronous handler abort cannot replace the stable
        // TimeoutError with a transport-specific AbortError.
        reject(error);
        controller.abort(error);
      }, this.requestTimeoutMs);
    });
    const operation = Promise.resolve().then(() => request(controller.signal));
    // Promise.race observes late settlement already; this explicit sink documents and preserves
    // that invariant if the race implementation is refactored later.
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertOpen() {
    if (this.closed) throw new Error("S3 blob store is closed");
  }

  private objectKey(storageKey: string) {
    validateBlobKey(storageKey);
    return `${this.prefix}/${storageKey}`;
  }

  private async readExactObjectState(storageKey: string, maxBytes: number): Promise<ExactObjectState> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.send((abortSignal) => this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(storageKey),
        }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return { kind: "missing" };
      throw sanitizedS3Error("read", error);
    }
    try {
      assertUnversionedEvidence(output);
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    const envelope = await readBoundedEnvelope(
      storageKey,
      output.Body,
      output.ContentLength,
      maxBytes,
      this.requestTimeoutMs,
    );
    const decoded = decodeBlobEnvelope(storageKey, envelope, maxBytes);
    return decoded.kind === "tombstone"
      ? {
        kind: "tombstone",
        etag: output.ETag,
        ...(decoded.migrationOwnerSha256 === undefined
          ? {}
          : { migrationOwnerSha256: decoded.migrationOwnerSha256 }),
      }
      : {
        kind: "data",
        object: decoded.object,
        etag: output.ETag,
        ...(decoded.migrationOwnerSha256 === undefined
          ? {}
          : { migrationOwnerSha256: decoded.migrationOwnerSha256 }),
      };
  }

  private async readDecoded(storageKey: string, maxBytes: number): Promise<DecodedBlobEnvelope | null> {
    const state = await this.readExactObjectState(storageKey, maxBytes);
    if (state.kind === "missing") return null;
    return state.kind === "tombstone"
      ? {
        kind: "tombstone",
        ...(state.migrationOwnerSha256 === undefined
          ? {}
          : { migrationOwnerSha256: state.migrationOwnerSha256 }),
      }
      : {
        kind: "data",
        object: state.object,
        ...(state.migrationOwnerSha256 === undefined
          ? {}
          : { migrationOwnerSha256: state.migrationOwnerSha256 }),
      };
  }

  private async reconcilePut(
    storageKey: string,
    desired: BlobDescriptor,
    maxBytes: number,
    migrationOwnerSha256?: string,
  ): Promise<BlobDescriptor | null> {
    const current = await this.readDecoded(storageKey, maxBytes);
    if (!current) return null;
    if (current.kind === "tombstone") {
      throw new Error(`blob upload ${storageKey} was cancelled before publication`);
    }
    if (!sameBlobDescriptor(desired, current.object)) throw new BlobConflictError(storageKey);
    // A drained runtime may resume its exact staging write after the mover has copied it. An
    // ownerless replay can therefore accept identical bytes without stripping the embedded mover
    // marker. A mover-authored replay remains bound to its exact migration owner.
    if (
      migrationOwnerSha256 !== undefined
      && current.migrationOwnerSha256 !== migrationOwnerSha256
    ) {
      throw new BlobConflictError(storageKey);
    }
    return desired;
  }

  async putIfAbsent(storageKey: string, data: Buffer | string, options: BlobPutOptions) {
    this.assertOpen();
    validateBlobKey(storageKey);
    validateBlobUploadToken(options.uploadToken);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const contentType = validateBlobContentType(options.contentType);
    const migrationOwnerSha256 = options.migrationOwnerSha256 === undefined
      ? undefined
      : validateBlobMigrationOwnerSha256(options.migrationOwnerSha256);
    const sizeBytes = inputByteLength(data);
    if (sizeBytes > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, sizeBytes);

    // Snapshot before the first await, matching the Memory/Fs adapter contract.
    const payload = Buffer.from(data);
    const desired = blobDescriptorFor(storageKey, payload, contentType);
    const envelope = encodeBlobDataEnvelope(payload, contentType, migrationOwnerSha256);
    const key = this.objectKey(storageKey);

    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      let putSucceeded = false;
      try {
        const output = await this.send((abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: envelope,
            ContentType: BLOB_ENVELOPE_OBJECT_CONTENT_TYPE,
            IfNoneMatch: "*",
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
        putSucceeded = true;
      } catch (error) {
        if (error instanceof S3VersionedObjectError) throw error;
        // This also recovers a lost success response: S3 is strongly read-after-write consistent.
        const reconciled = await this.reconcilePut(
          storageKey,
          desired,
          maxBytes,
          migrationOwnerSha256,
        );
        if (reconciled) return reconciled;
        if (!isConditionalConflict(error)) throw sanitizedS3Error("conditional create", error);
      }

      if (putSucceeded) {
        // If a concurrent manifest-driven delete already replaced the object with its tombstone,
        // do not tell the ownership layer that publication succeeded.
        const reconciled = await this.reconcilePut(
          storageKey,
          desired,
          maxBytes,
          migrationOwnerSha256,
        );
        if (reconciled) return reconciled;
      }
    }
    throw new S3BlobSafeError("S3 blob conditional create did not converge");
  }

  async get(storageKey: string, options: BlobReadOptions) {
    this.assertOpen();
    validateBlobKey(storageKey);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const decoded = await this.readDecoded(storageKey, maxBytes);
    return !decoded || decoded.kind === "tombstone" ? null : decoded.object;
  }

  async getExact(storageKey: string, options: BlobReadOptions) {
    return this.get(storageKey, options);
  }

  async inspectExact(storageKey: string, options: BlobReadOptions): Promise<BlobExactInspection> {
    this.assertOpen();
    validateBlobKey(storageKey);
    const state = await this.readExactObjectState(storageKey, validateBlobMaxBytes(options.maxBytes));
    if (state.kind !== "data") {
      return {
        kind: state.kind,
        ...(state.kind === "tombstone" && state.migrationOwnerSha256 !== undefined
          ? { migrationOwnerSha256: state.migrationOwnerSha256 }
          : {}),
      };
    }
    const { data: _data, ...descriptor } = state.object;
    return {
      kind: "data",
      descriptor,
      ...(state.migrationOwnerSha256 === undefined
        ? {}
        : { migrationOwnerSha256: state.migrationOwnerSha256 }),
    };
  }

  async discardUncommittedTarget(
    storageKey: string,
    options: BlobDiscardUncommittedTargetOptions,
  ) {
    this.assertOpen();
    const expected = validateBlobDiscardInput(
      storageKey,
      options.expectedState,
      options.uploadToken,
      options.migrationOwnerSha256,
    );
    const key = this.objectKey(storageKey);
    const maxBytes = expected.kind === "data" ? expected.descriptor.sizeBytes : 0;
    const tombstone = encodeBlobTombstoneEnvelope(options.migrationOwnerSha256);
    const readAbortFenceState = async () => {
      let state: ExactObjectState;
      try {
        state = await this.readExactObjectState(storageKey, maxBytes);
      } catch (error) {
        if (error instanceof BlobTooLargeError) throw new BlobConflictError(storageKey);
        throw error;
      }
      if (state.kind === "missing") return state;
      if (state.kind === "tombstone") {
        assertMigrationOwner(
          storageKey,
          options.migrationOwnerSha256,
          state.migrationOwnerSha256,
        );
        return state;
      }
      assertExpectedMigrationState(
        storageKey,
        expected,
        { kind: "data", descriptor: state.object },
      );
      assertMigrationOwner(
        storageKey,
        options.migrationOwnerSha256,
        state.migrationOwnerSha256,
      );
      return state;
    };

    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const state = await readAbortFenceState();
      if (state.kind === "tombstone") return;
      if (state.kind === "data" && !state.etag) {
        throw new Error("S3 blob object has no ETag for conditional abort fencing");
      }

      try {
        const output = await this.send((abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: tombstone,
            ContentType: BLOB_ENVELOPE_OBJECT_CONTENT_TYPE,
            ...(state.kind === "missing" ? { IfNoneMatch: "*" } : { IfMatch: state.etag }),
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
      } catch (error) {
        if (error instanceof S3VersionedObjectError) throw error;
        // A response may be lost after the CAS commits. Only the exact owner-marked tombstone is a
        // successful replay; foreign bytes or a foreign tombstone remain a hard conflict.
        const reconciled = await readAbortFenceState();
        if (reconciled.kind === "tombstone") return;
        if (isConditionalConflict(error)) continue;
        throw sanitizedS3Error("conditional migration abort fence", error);
      }

      const verified = await readAbortFenceState();
      if (verified.kind === "tombstone") return;
    }
    throw new S3BlobSafeError("S3 blob conditional migration abort fence did not converge");
  }

  private async currentDeleteState(key: string, tombstone: Buffer): Promise<ObjectState> {
    let head;
    try {
      head = await this.send((abortSignal) => this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return { kind: "missing" };
      throw sanitizedS3Error("metadata read", error);
    }
    assertUnversionedEvidence(head);
    if (!head.ETag) throw new Error("S3 blob object has no ETag for conditional deletion");
    const length = assertSafeContentLength(head.ContentLength);
    if (length !== tombstone.length) return { kind: "occupied", etag: head.ETag };

    let output;
    try {
      output = await this.send((abortSignal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return { kind: "missing" };
      throw sanitizedS3Error("tombstone read", error);
    }
    try {
      assertUnversionedEvidence(output);
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    if (!output.ETag) throw new Error("S3 blob object has no ETag for conditional deletion");
    if (output.ContentLength !== undefined && output.ContentLength !== tombstone.length) {
      destroyBody(output.Body);
      return { kind: "occupied", etag: output.ETag };
    }
    const bytes = await readExactBody(
      output.Body,
      output.ContentLength,
      tombstone.length,
      this.requestTimeoutMs,
    );
    return bytes.equals(tombstone)
      ? { kind: "tombstone", etag: output.ETag }
      : { kind: "occupied", etag: output.ETag };
  }

  async delete(storageKey: string, options: BlobDeleteOptions = {}) {
    this.assertOpen();
    const key = this.objectKey(storageKey);
    if (options.uploadToken === undefined) {
      throw new Error("S3 blob deletion requires an upload token");
    }
    validateBlobUploadToken(options.uploadToken);
    const migrationOwnerSha256 = options.migrationOwnerSha256 === undefined
      ? undefined
      : validateBlobMigrationOwnerSha256(options.migrationOwnerSha256);

    if (migrationOwnerSha256 !== undefined) {
      const tombstone = encodeBlobTombstoneEnvelope(migrationOwnerSha256);
      const readMigrationTombstoneState = async () => {
        let state: ExactObjectState;
        try {
          state = await this.readExactObjectState(storageKey, 0);
        } catch (error) {
          if (error instanceof BlobTooLargeError) throw new BlobConflictError(storageKey);
          throw error;
        }
        if (state.kind === "missing") return state;
        if (state.kind !== "tombstone") throw new BlobConflictError(storageKey);
        assertMigrationOwner(
          storageKey,
          migrationOwnerSha256,
          state.migrationOwnerSha256,
        );
        return state;
      };

      for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
        const state = await readMigrationTombstoneState();
        if (state.kind === "tombstone") return;
        try {
          const output = await this.send((abortSignal) => this.client.send(
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              Body: tombstone,
              ContentType: BLOB_ENVELOPE_OBJECT_CONTENT_TYPE,
              IfNoneMatch: "*",
            }),
            { abortSignal },
          ));
          assertUnversionedEvidence(output);
        } catch (error) {
          if (error instanceof S3VersionedObjectError) throw error;
          // A response may be lost after the create commits. Only this exact embedded owner is an
          // acceptable replay result; an unmarked or foreign tombstone remains a hard conflict.
          const reconciled = await readMigrationTombstoneState();
          if (reconciled.kind === "tombstone") return;
          if (isConditionalConflict(error)) continue;
          throw sanitizedS3Error("conditional migration tombstone create", error);
        }
        const verified = await readMigrationTombstoneState();
        if (verified.kind === "tombstone") return;
      }
      throw new S3BlobSafeError("S3 migration tombstone create did not converge");
    }

    const tombstone = encodeBlobTombstoneEnvelope();
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const state = await this.currentDeleteState(key, tombstone);
      if (state.kind === "tombstone") return;

      try {
        const output = await this.send((abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: tombstone,
            ContentType: BLOB_ENVELOPE_OBJECT_CONTENT_TYPE,
            ...(state.kind === "missing" ? { IfNoneMatch: "*" } : { IfMatch: state.etag }),
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
        const verified = await this.currentDeleteState(key, tombstone);
        if (verified.kind === "tombstone") return;
        continue;
      } catch (error) {
        if (error instanceof S3VersionedObjectError) throw error;
        if (isConditionalConflict(error)) continue;
        // A transport can lose the response after S3 commits the tombstone. Resolve that ambiguity
        // before surfacing a retryable error to the durable cleanup worker.
        const reconciled = await this.currentDeleteState(key, tombstone);
        if (reconciled.kind === "tombstone") return;
        throw sanitizedS3Error("conditional deletion", error);
      }
    }
    throw new S3BlobSafeError("S3 blob conditional deletion did not converge");
  }

  /**
   * Validate the shared bucket before an HTTP listener or cleanup worker starts. Versioned buckets
   * retain overwritten payload versions, so this adapter cannot honestly acknowledge physical
   * deletion there. The probe also proves this endpoint honors both create-only and CAS writes.
   */
  async validateStartup() {
    this.assertOpen();
    try {
      await this.send((abortSignal) => this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup reachability check", error);
    }

    let versioning;
    try {
      versioning = await this.send((abortSignal) => this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup versioning check", error);
    }
    if (versioning.Status !== undefined) {
      const state = versioning.Status === "Enabled" || versioning.Status === "Suspended"
        ? versioning.Status
        : "an unexpected state";
      throw new S3BlobSafeError(`S3 blob bucket versioning must be disabled, received ${state}`);
    }

    try {
      const lifecycle = await this.send((abortSignal) => this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if ((lifecycle.Rules?.length ?? 0) > 0) {
        throw new S3BlobSafeError("S3 blob bucket lifecycle configuration must be absent");
      }
    } catch (error) {
      if (errorName(error) !== "NoSuchLifecycleConfiguration") {
        if (error instanceof S3BlobSafeError) throw error;
        throw sanitizedS3Error("startup lifecycle check", error);
      }
    }

    try {
      const lock = await this.send((abortSignal) => this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== undefined) {
        throw new S3BlobSafeError("S3 blob bucket Object Lock must be disabled or absent");
      }
    } catch (error) {
      if (
        errorName(error) !== "ObjectLockConfigurationNotFoundError"
        && errorName(error) !== "ObjectLockConfigurationNotFound"
        && errorStatus(error) !== 404
      ) {
        if (error instanceof S3BlobSafeError) throw error;
        throw sanitizedS3Error("startup Object Lock check", error);
      }
    }

    const key = `${this.prefix}/${PROBE_PREFIX}/${randomBytes(16).toString("hex")}`;
    const initial = Buffer.from("agent-service-s3-conditional-probe-v1", "utf8");
    const replacement = Buffer.from("agent-service-s3-conditional-probe-v2", "utf8");
    let failure: unknown;
    try {
      const first = await this.send((abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: initial,
          IfNoneMatch: "*",
        }),
        { abortSignal },
      ));
      assertUnversionedEvidence(first);
      let firstEtag = first.ETag;
      if (!firstEtag) {
        try {
          const head = await this.send((abortSignal) => this.client.send(
            new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            { abortSignal },
          ));
          assertUnversionedEvidence(head);
          firstEtag = head.ETag;
        } catch (error) {
          throw sanitizedS3Error("startup probe metadata read", error);
        }
      }
      if (!firstEtag) throw new S3BlobSafeError("S3 conditional-write probe did not return an ETag");

      let createOnlyWasIgnored = false;
      try {
        const output = await this.send((abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: replacement,
            IfNoneMatch: "*",
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
        createOnlyWasIgnored = true;
      } catch (error) {
        if (error instanceof S3VersionedObjectError) throw error;
        if (!isConditionalConflict(error)) throw error;
      }
      if (createOnlyWasIgnored) {
        throw new S3BlobSafeError("S3 endpoint ignored If-None-Match during startup probe");
      }

      const replacementOutput = await this.send((abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: replacement,
          IfMatch: firstEtag,
        }),
        { abortSignal },
      ));
      assertUnversionedEvidence(replacementOutput);
      let casWasIgnored = false;
      try {
        const output = await this.send((abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: initial,
            IfMatch: firstEtag,
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
        casWasIgnored = true;
      } catch (error) {
        if (error instanceof S3VersionedObjectError) throw error;
        if (!isConditionalConflict(error)) throw error;
      }
      if (casWasIgnored) throw new S3BlobSafeError("S3 endpoint ignored If-Match during startup probe");
    } catch (error) {
      failure = error instanceof S3VersionedObjectError
        || error instanceof S3BlobSafeError
        ? error
        : sanitizedS3Error("startup conditional-write probe", error);
    }

    try {
      const output = await this.send((abortSignal) => this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
      assertUnversionedEvidence(output);
      try {
        await this.send((abortSignal) => this.client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
          { abortSignal },
        ));
        throw new S3BlobSafeError("S3 startup probe cleanup was not strongly visible");
      } catch (error) {
        if (!isMissingObject(error)) throw error;
      }
    } catch (cleanupError) {
      const safeCleanupError = cleanupError instanceof S3VersionedObjectError
        || cleanupError instanceof S3BlobSafeError
        ? cleanupError
        : sanitizedS3Error("startup probe cleanup", cleanupError);
      if (failure) throw new AggregateError([failure, safeCleanupError], "S3 startup probe and cleanup failed");
      throw safeCleanupError;
    }
    if (failure) throw failure;
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.client.destroy();
  }

  async close() {
    this.destroy();
  }
}
