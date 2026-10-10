import { createHash, randomUUID } from "node:crypto";
import {
  BLOB_STORAGE_FORMAT,
  BlobConflictError,
  BlobTooLargeError,
  EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256,
  USER_DATA_EXPORT_CONTENT_TYPE,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_RECORD_KIND_ORDER,
  USER_DATA_EXPORT_SCHEMA_VERSION,
  UserDataExportIntegrityError,
  canonicalUserDataExportBytes,
  canonicalUserDataExportJson,
  newUserDataExportArtifactId,
  nextUserDataExportSnapshotRootSha256,
  userDataExportAttachmentLogicalKey,
  userDataExportAuthorization,
  userDataExportManifestSha256,
  userDataExportStorageKey,
  type BlobDescriptor,
  type BlobStore,
  type UserDataExportArtifactPart,
  type UserDataExportArtifactRecord,
  type UserDataExportAttachmentSnapshot,
  type UserDataExportAuthorization,
  type UserDataExportClaim,
  type UserDataExportErrorCode,
  type UserDataExportJobStore,
  type UserDataExportSnapshotBlob,
  type UserDataExportSnapshotRecord,
  type UserDataExportSnapshotSummary,
} from "@agent-service/store";

export interface UserDataExportWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  snapshotPageSize?: number;
  artifactStagingTtlMs?: number;
  /** ndjson-v1 layout constant. Override only in tests or with an explicit future format change. */
  partMaxBytes?: number;
  /** ndjson-v1 layout constant. Override only in tests or with an explicit future format change. */
  attachmentChunkBytes?: number;
  maxSourceBlobBytes?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Availability failures are never capped; this applies only to deterministic poison. */
  poisonMaxAttempts?: number;
}

export interface UserDataExportWorkerDeps {
  /** Least-privilege export surface. It cannot mutate session or general Blob lifecycle state. */
  store: UserDataExportJobStore;
  blob: BlobStore;
  logger?: Pick<Console, "warn" | "error">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 5,
  snapshotPageSize: 200,
  artifactStagingTtlMs: 15 * 60_000,
  partMaxBytes: 1024 * 1024,
  attachmentChunkBytes: 256 * 1024,
  maxSourceBlobBytes: 16 * 1024 * 1024,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  poisonMaxAttempts: 3,
} as const;

const SNAPSHOT_KINDS = [
  ...USER_DATA_EXPORT_RECORD_KIND_ORDER,
  "attachment",
] as const;
const SNAPSHOT_RECORD_KIND_INDEX = new Map(
  USER_DATA_EXPORT_RECORD_KIND_ORDER.map((kind, index) => [kind, index]),
);

const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_ID = /^xart_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_BACKEND = /^[a-z0-9][a-z0-9._-]{0,31}$/;

class LostUserDataExportClaimError extends Error {
  constructor() {
    super("data export claim was lost");
    this.name = "LostUserDataExportClaimError";
  }
}

class SnapshotPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotPoisonError";
  }
}

class ArtifactPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactPoisonError";
  }
}

class StorageAdapterUnavailableError extends Error {
  constructor() {
    super("data export storage adapter is unavailable");
    this.name = "StorageAdapterUnavailableError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function canonicalLine(value: unknown): Buffer {
  return Buffer.from(`${canonicalUserDataExportJson(value)}\n`, "utf8");
}

function descriptorFor(storageKey: string, bytes: Buffer): BlobDescriptor {
  return {
    storageKey,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    contentType: USER_DATA_EXPORT_CONTENT_TYPE,
  };
}

function descriptorsEqual(left: BlobDescriptor, right: BlobDescriptor): boolean {
  return left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes
    && left.contentType === right.contentType;
}

function stableCounts(summary: UserDataExportSnapshotSummary) {
  return {
    session: summary.counts.session,
    turn: summary.counts.turn,
    item: summary.counts.item,
    event: summary.counts.event,
    approval: summary.counts.approval,
    operational_usage: summary.counts.operational_usage,
    attachment: summary.counts.attachment,
  };
}

function validateSummary(summary: UserDataExportSnapshotSummary): void {
  if (!Number.isSafeInteger(summary.snapshotAtMs) || summary.snapshotAtMs < 0) {
    throw new SnapshotPoisonError("snapshot timestamp is invalid");
  }
  if (!Number.isSafeInteger(summary.recordCount) || summary.recordCount < 0) {
    throw new SnapshotPoisonError("snapshot record count is invalid");
  }
  if (!SHA256.test(summary.snapshotRootSha256)) {
    throw new SnapshotPoisonError("snapshot root is invalid");
  }
  let count = 0;
  for (const kind of SNAPSHOT_KINDS) {
    const value = summary.counts[kind];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SnapshotPoisonError("snapshot kind count is invalid");
    }
    count += value;
    if (!Number.isSafeInteger(count)) throw new SnapshotPoisonError("snapshot record count overflowed");
  }
  if (count !== summary.recordCount) {
    throw new SnapshotPoisonError("snapshot kind counts do not match the total");
  }
}

function validateSnapshotRecord(
  record: UserDataExportSnapshotRecord,
  auth: UserDataExportAuthorization,
  expectedOrdinal: number,
): void {
  if (
    record.requestId !== auth.requestId
    || record.buildGeneration !== auth.buildGeneration
    || record.ordinal !== expectedOrdinal
    || !SNAPSHOT_KINDS.includes(record.kind)
    || !record.logicalKey
    || record.logicalKey.length > 512
    || !Number.isSafeInteger(record.sizeBytes)
    || record.sizeBytes < 0
    || record.sizeBytes !== record.canonicalBytes.byteLength
    || !SHA256.test(record.sha256)
    || createHash("sha256").update(record.canonicalBytes).digest("hex") !== record.sha256
  ) {
    throw new SnapshotPoisonError("snapshot record identity or digest is invalid");
  }

  try {
    const parsed = JSON.parse(record.canonicalBytes.toString("utf8")) as { type?: unknown };
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.type !== record.kind
      || !record.canonicalBytes.equals(Buffer.from(canonicalUserDataExportJson(parsed), "utf8"))
    ) throw new Error("not canonical");
  } catch {
    throw new SnapshotPoisonError("snapshot record is not canonical JSON");
  }
}

function validateSnapshotBlob(
  blob: UserDataExportSnapshotBlob,
  auth: UserDataExportAuthorization,
  expectedOrdinal: number,
): void {
  if (
    blob.requestId !== auth.requestId
    || blob.buildGeneration !== auth.buildGeneration
    || blob.ordinal !== expectedOrdinal
    || !blob.blobId
    || !blob.sessionId
    || (blob.purpose !== "input_image" && blob.purpose !== "tool_output")
    || !SHA256.test(blob.sha256)
    || !Number.isSafeInteger(blob.sizeBytes)
    || blob.sizeBytes < 0
    || !STORAGE_BACKEND.test(blob.storageBackend)
    || (blob.storageNamespaceSha256 !== undefined && !SHA256.test(blob.storageNamespaceSha256))
    || blob.storageFormat !== BLOB_STORAGE_FORMAT
    || !blob.storageKey
    || !blob.sourceUploadToken
    || blob.sourceUploadToken.length > 128
    || !Number.isSafeInteger(blob.sourceDeletionGeneration)
    || blob.sourceDeletionGeneration < 0
    || !SHA256.test(blob.pinToken)
    || !Number.isSafeInteger(blob.pinnedAtMs)
    || blob.pinnedAtMs < 0
    || blob.releasedAtMs !== undefined
  ) throw new SnapshotPoisonError("snapshot attachment identity is invalid");
}

function publicAttachment(blob: UserDataExportSnapshotBlob): UserDataExportAttachmentSnapshot {
  return {
    blobId: blob.blobId,
    sessionId: blob.sessionId,
    ...(blob.itemId === undefined ? {} : { itemId: blob.itemId }),
    purpose: blob.purpose,
    ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
    sha256: blob.sha256,
    sizeBytes: blob.sizeBytes,
  };
}

function validateArtifact(
  artifact: UserDataExportArtifactRecord,
  claim: UserDataExportClaim,
): void {
  if (
    !ARTIFACT_ID.test(artifact.artifactId)
    || artifact.requestId !== claim.requestId
    || artifact.tenantId !== claim.tenantId
    || artifact.userId !== claim.userId
    || artifact.subjectGeneration !== claim.subjectGeneration
    || artifact.buildGeneration !== claim.buildGeneration
    || artifact.format !== USER_DATA_EXPORT_FORMAT
    || artifact.schemaVersion !== USER_DATA_EXPORT_SCHEMA_VERSION
    || artifact.contentType !== USER_DATA_EXPORT_CONTENT_TYPE
    || !STORAGE_BACKEND.test(artifact.storageBackend)
    || artifact.storageFormat !== BLOB_STORAGE_FORMAT
    || artifact.policyVersion !== claim.policyVersion
    || artifact.policySha256 !== claim.policySha256
    || !SHA256.test(artifact.snapshotRootSha256)
    || artifact.artifactTtlMs !== claim.artifactTtlMs
    || !Number.isSafeInteger(artifact.stagingExpiresAtMs)
    || !Number.isSafeInteger(artifact.createdAtMs)
    || artifact.stagingExpiresAtMs <= artifact.createdAtMs
    || !Number.isSafeInteger(artifact.deletionGeneration)
    || artifact.deletionGeneration !== 0
    || artifact.state !== "staging"
  ) throw new ArtifactPoisonError("artifact build identity is invalid");
}

function validatePartIdentity(
  part: UserDataExportArtifactPart,
  artifact: UserDataExportArtifactRecord,
  claim: UserDataExportClaim,
  partNumber: number,
  expectedStorageKey: string,
): void {
  if (
    part.artifactId !== artifact.artifactId
    || part.requestId !== claim.requestId
    || part.buildGeneration !== claim.buildGeneration
    || part.partNumber !== partNumber
    || !STORAGE_BACKEND.test(part.storageBackend)
    || part.storageFormat !== BLOB_STORAGE_FORMAT
    || part.storageKey !== expectedStorageKey
    || !/^[a-z0-9_-]{1,128}$/.test(part.uploadToken)
    || !Number.isSafeInteger(part.deletionGeneration)
    || part.deletionGeneration !== 0
    || !Number.isSafeInteger(part.createdAtMs)
    || (part.state !== "staging" && part.state !== "uploaded")
    || (part.state === "staging" && (
      part.sha256 !== undefined
      || part.sizeBytes !== undefined
      || part.contentType !== undefined
      || part.uploadedAtMs !== undefined
    ))
    || (part.state === "uploaded" && !Number.isSafeInteger(part.uploadedAtMs))
  ) throw new ArtifactPoisonError("artifact part identity is invalid");
}

function requireBlobBackend(storageBackend: string, blob: BlobStore): void {
  if (storageBackend !== blob.backend) throw new StorageAdapterUnavailableError();
}

function requireSnapshotBlobAdapter(snapshot: UserDataExportSnapshotBlob, blob: BlobStore): void {
  if (
    snapshot.storageBackend !== blob.backend
    || snapshot.storageNamespaceSha256 !== blob.namespaceSha256
    || (blob.shared === true && blob.namespaceSha256 === undefined)
  ) throw new StorageAdapterUnavailableError();
}

/**
 * Builds an immutable, multipart NDJSON export from a store-sealed ownership snapshot. Database
 * rows are never read through SessionStore, and physical Blob locators never enter serialized
 * output. Each bounded part is create-only so a successor can exactly resume every crash window.
 */
export class UserDataExportWorker {
  private readonly opts: Required<UserDataExportWorkerOptions>;
  private readonly log: Pick<Console, "warn" | "error">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: UserDataExportWorkerDeps,
    options: UserDataExportWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      snapshotPageSize: positiveInteger(
        options.snapshotPageSize ?? DEFAULTS.snapshotPageSize,
        "snapshotPageSize",
      ),
      artifactStagingTtlMs: positiveInteger(
        options.artifactStagingTtlMs ?? DEFAULTS.artifactStagingTtlMs,
        "artifactStagingTtlMs",
      ),
      partMaxBytes: positiveInteger(options.partMaxBytes ?? DEFAULTS.partMaxBytes, "partMaxBytes"),
      attachmentChunkBytes: positiveInteger(
        options.attachmentChunkBytes ?? DEFAULTS.attachmentChunkBytes,
        "attachmentChunkBytes",
      ),
      maxSourceBlobBytes: positiveInteger(
        options.maxSourceBlobBytes ?? DEFAULTS.maxSourceBlobBytes,
        "maxSourceBlobBytes",
      ),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
      poisonMaxAttempts: positiveInteger(
        options.poisonMaxAttempts ?? DEFAULTS.poisonMaxAttempts,
        "poisonMaxAttempts",
      ),
    };
    if (this.opts.batchSize > 100) throw new Error("batchSize must not exceed 100");
    if (this.opts.snapshotPageSize > 1_000) throw new Error("snapshotPageSize must not exceed 1000");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    if (this.opts.attachmentChunkBytes > this.opts.maxSourceBlobBytes) {
      throw new Error("attachmentChunkBytes must not exceed maxSourceBlobBytes");
    }
    // Base64 plus deterministic metadata must fit without splitting one NDJSON record.
    if (Math.ceil(this.opts.attachmentChunkBytes / 3) * 4 + 4_096 > this.opts.partMaxBytes) {
      throw new Error("attachmentChunkBytes is too large for partMaxBytes");
    }
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    this.shutdownRequested = false;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  /** One bounded queue claim pass. */
  async processOnce(): Promise<number> {
    if (this.shutdownRequested) return 0;
    const claims = await this.deps.store.claimUserDataExports({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    const results = await Promise.all(claims.map(async (claim) => {
      let phase: "snapshot" | "artifact" = "snapshot";
      try {
        const completed = await this.buildClaim(claim, () => { phase = "artifact"; });
        return completed;
      } catch (error) {
        if (error instanceof LostUserDataExportClaimError) return false;
        const deterministic = error instanceof SnapshotPoisonError
          || error instanceof ArtifactPoisonError
          || error instanceof UserDataExportIntegrityError
          || error instanceof BlobConflictError
          || error instanceof BlobTooLargeError;
        const errorCode: UserDataExportErrorCode = error instanceof SnapshotPoisonError
          ? "snapshot_invalid"
          : error instanceof ArtifactPoisonError
            || error instanceof BlobConflictError
            || error instanceof BlobTooLargeError
            ? "artifact_invalid"
            : error instanceof UserDataExportIntegrityError
              ? (phase === "snapshot" ? "snapshot_invalid" : "artifact_invalid")
              : "temporary_failure";
        this.log.warn("[user-data-export] claim failed");
        return await this.retry(claim, errorCode, deterministic);
      }
    }));
    return results.reduce((count, completed) => count + (completed ? 1 : 0), 0);
  }

  private async renew(auth: UserDataExportAuthorization): Promise<void> {
    if (this.shutdownRequested) throw new LostUserDataExportClaimError();
    if (!await this.deps.store.renewUserDataExportClaim(auth, this.opts.leaseMs)) {
      throw new LostUserDataExportClaimError();
    }
    if (this.shutdownRequested) throw new LostUserDataExportClaimError();
  }

  private async buildClaim(claim: UserDataExportClaim, artifactPhase: () => void): Promise<boolean> {
    const auth = userDataExportAuthorization(claim);
    await this.renew(auth);
    const summary = await this.deps.store.captureAndSealUserDataExportSnapshot(auth);
    validateSummary(summary);
    await this.renew(auth);
    artifactPhase();

    let build = await this.deps.store.getUserDataExportArtifactBuild(auth);
    let artifact = build.artifact;
    if (!artifact) {
      artifact = await this.deps.store.startUserDataExportArtifact(auth, {
        artifactId: newUserDataExportArtifactId(),
        storageBackend: this.deps.blob.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        stagingTtlMs: this.opts.artifactStagingTtlMs,
      });
      build = await this.deps.store.getUserDataExportArtifactBuild(auth);
      artifact = build.artifact ?? artifact;
    }
    validateArtifact(artifact, claim);
    requireBlobBackend(artifact.storageBackend, this.deps.blob);
    if (artifact.snapshotRootSha256 !== summary.snapshotRootSha256) {
      throw new ArtifactPoisonError("artifact build does not match the sealed snapshot");
    }

    const existingParts = new Map<number, UserDataExportArtifactPart>();
    const persistedParts = [...build.parts].sort((left, right) => left.partNumber - right.partNumber);
    for (const [index, part] of persistedParts.entries()) {
      if (!Number.isSafeInteger(part.partNumber) || part.partNumber !== index) {
        throw new ArtifactPoisonError("artifact parts are duplicate or non-contiguous");
      }
      const expectedStorageKey = userDataExportStorageKey(
        { tenantId: claim.tenantId, userId: claim.userId },
        claim.requestId,
        artifact.artifactId,
        part.partNumber,
      );
      validatePartIdentity(
        part,
        artifact,
        claim,
        part.partNumber,
        expectedStorageKey,
      );
      requireBlobBackend(part.storageBackend, this.deps.blob);
      existingParts.set(part.partNumber, part);
    }

    const uploaded: UserDataExportArtifactPart[] = [];
    const contentHash = createHash("sha256");
    let totalSizeBytes = 0;
    let currentChunks: Buffer[] = [];
    let currentSize = 0;
    let nextPartNumber = 0;

    const flush = async () => {
      if (currentSize === 0) return;
      const bytes = Buffer.concat(currentChunks, currentSize);
      const part = await this.publishPart(claim, auth, artifact!, existingParts, nextPartNumber, bytes);
      uploaded.push(part);
      totalSizeBytes += bytes.byteLength;
      if (!Number.isSafeInteger(totalSizeBytes)) throw new ArtifactPoisonError("artifact size overflowed");
      nextPartNumber += 1;
      currentChunks = [];
      currentSize = 0;
    };

    const append = async (line: Buffer) => {
      if (line.byteLength > this.opts.partMaxBytes) {
        throw new ArtifactPoisonError("one export record exceeds the artifact part limit");
      }
      if (currentSize > 0 && currentSize + line.byteLength > this.opts.partMaxBytes) await flush();
      currentChunks.push(line);
      currentSize += line.byteLength;
      contentHash.update(line);
    };

    await append(canonicalLine({
      type: "export/header",
      value: {
        format: USER_DATA_EXPORT_FORMAT,
        schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
        requestId: claim.requestId,
        tenantId: claim.tenantId,
        userId: claim.userId,
        snapshotAtMs: summary.snapshotAtMs,
        snapshotRootSha256: summary.snapshotRootSha256,
        counts: stableCounts(summary),
      },
    }));

    const observedCounts = Object.fromEntries(SNAPSHOT_KINDS.map((kind) => [kind, 0])) as Record<
      (typeof SNAPSHOT_KINDS)[number],
      number
    >;
    let snapshotRoot = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
    let expectedRecordOrdinal = 0;
    let recordCursor: number | undefined;
    let previousRecordKindIndex = -1;
    let previousRecordLogicalKey: string | undefined;
    for (;;) {
      await this.renew(auth);
      const page = await this.deps.store.readUserDataExportSnapshotRecords(auth, {
        ...(recordCursor === undefined ? {} : { afterOrdinal: recordCursor }),
        limit: this.opts.snapshotPageSize,
      });
      for (const record of page.data) {
        validateSnapshotRecord(record, auth, expectedRecordOrdinal);
        const kindIndex = SNAPSHOT_RECORD_KIND_INDEX.get(record.kind);
        if (
          kindIndex === undefined
          || kindIndex < previousRecordKindIndex
          || (kindIndex === previousRecordKindIndex
            && previousRecordLogicalKey !== undefined
            && record.logicalKey <= previousRecordLogicalKey)
        ) throw new SnapshotPoisonError("snapshot records are not in canonical order");
        previousRecordLogicalKey = record.logicalKey;
        previousRecordKindIndex = kindIndex;
        snapshotRoot = nextUserDataExportSnapshotRootSha256(
          snapshotRoot,
          record.kind,
          record.logicalKey,
          record.sha256,
          record.sizeBytes,
        );
        observedCounts[record.kind] += 1;
        expectedRecordOrdinal += 1;
        await append(Buffer.concat([record.canonicalBytes, Buffer.from("\n")]));
      }
      if (page.nextOrdinal === null) break;
      if (
        page.data.length === 0
        || page.nextOrdinal !== expectedRecordOrdinal - 1
        || page.nextOrdinal === recordCursor
      ) throw new SnapshotPoisonError("snapshot record page made no progress");
      recordCursor = page.nextOrdinal;
    }

    let expectedBlobOrdinal = 0;
    let blobCursor: number | undefined;
    let previousBlobLogicalKey: string | undefined;
    for (;;) {
      await this.renew(auth);
      const page = await this.deps.store.readUserDataExportSnapshotBlobs(auth, {
        ...(blobCursor === undefined ? {} : { afterOrdinal: blobCursor }),
        limit: this.opts.snapshotPageSize,
      });
      for (const blob of page.data) {
        validateSnapshotBlob(blob, auth, expectedBlobOrdinal);
        const attachment = publicAttachment(blob);
        const logicalKey = userDataExportAttachmentLogicalKey(attachment);
        if (previousBlobLogicalKey !== undefined && logicalKey <= previousBlobLogicalKey) {
          throw new SnapshotPoisonError("snapshot attachments are not in canonical order");
        }
        previousBlobLogicalKey = logicalKey;
        requireSnapshotBlobAdapter(blob, this.deps.blob);
        if (blob.sizeBytes > this.opts.maxSourceBlobBytes) {
          throw new ArtifactPoisonError("snapshot attachment exceeds the configured read ceiling");
        }
        const object = await this.deps.blob.get(blob.storageKey, { maxBytes: this.opts.maxSourceBlobBytes });
        if (
          !object
          || object.storageKey !== blob.storageKey
          || object.sha256 !== blob.sha256
          || object.sizeBytes !== blob.sizeBytes
          || object.contentType !== blob.contentType
          || createHash("sha256").update(object.data).digest("hex") !== blob.sha256
          || object.data.byteLength !== blob.sizeBytes
        ) throw new ArtifactPoisonError("snapshot attachment object does not match its sealed descriptor");

        const snapshotBytes = canonicalUserDataExportBytes({
          type: "attachment",
          value: attachment,
        });
        snapshotRoot = nextUserDataExportSnapshotRootSha256(
          snapshotRoot,
          "attachment",
          logicalKey,
          createHash("sha256").update(snapshotBytes).digest("hex"),
          snapshotBytes.byteLength,
        );

        const chunkCount = Math.max(1, Math.ceil(object.data.byteLength / this.opts.attachmentChunkBytes));
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const start = chunkIndex * this.opts.attachmentChunkBytes;
          const data = object.data.subarray(start, Math.min(object.data.byteLength, start + this.opts.attachmentChunkBytes));
          await append(canonicalLine({
            type: "attachment/chunk",
            value: {
              ...attachment,
              encoding: "base64",
              chunkIndex,
              chunkCount,
              dataBase64: data.toString("base64"),
            },
          }));
        }
        observedCounts.attachment += 1;
        expectedBlobOrdinal += 1;
      }
      if (page.nextOrdinal === null) break;
      if (
        page.data.length === 0
        || page.nextOrdinal !== expectedBlobOrdinal - 1
        || page.nextOrdinal === blobCursor
      ) throw new SnapshotPoisonError("snapshot attachment page made no progress");
      blobCursor = page.nextOrdinal;
    }

    for (const kind of SNAPSHOT_KINDS) {
      if (observedCounts[kind] !== summary.counts[kind]) {
        throw new SnapshotPoisonError("snapshot page counts do not match the seal");
      }
    }
    if (expectedRecordOrdinal + expectedBlobOrdinal !== summary.recordCount) {
      throw new SnapshotPoisonError("snapshot pages do not match the sealed total");
    }
    if (snapshotRoot !== summary.snapshotRootSha256) {
      throw new SnapshotPoisonError("snapshot pages do not match the sealed root");
    }

    await append(canonicalLine({
      type: "export/footer",
      value: {
        snapshotRootSha256: summary.snapshotRootSha256,
        recordCount: summary.recordCount,
        counts: stableCounts(summary),
      },
    }));
    await flush();

    if (
      existingParts.size !== uploaded.length
      || [...existingParts.keys()].some((partNumber) => partNumber < 0 || partNumber >= uploaded.length)
    ) throw new ArtifactPoisonError("artifact contains unexpected trailing parts");

    const contentSha256 = contentHash.digest("hex");
    const manifestSha256 = userDataExportManifestSha256(uploaded);
    await this.renew(auth);
    const completed = await this.deps.store.completeUserDataExportArtifact(auth, {
      artifactId: artifact.artifactId,
      snapshotAtMs: summary.snapshotAtMs,
      partCount: uploaded.length,
      recordCount: summary.recordCount,
      totalSizeBytes,
      contentSha256,
      manifestSha256,
    });
    return completed.status === "ready" && completed.currentArtifactId === artifact.artifactId;
  }

  private async publishPart(
    claim: UserDataExportClaim,
    auth: UserDataExportAuthorization,
    artifact: UserDataExportArtifactRecord,
    existingParts: Map<number, UserDataExportArtifactPart>,
    partNumber: number,
    bytes: Buffer,
  ): Promise<UserDataExportArtifactPart> {
    const storageKey = userDataExportStorageKey(
      { tenantId: claim.tenantId, userId: claim.userId },
      claim.requestId,
      artifact.artifactId,
      partNumber,
    );
    const expected = descriptorFor(storageKey, bytes);
    let part = existingParts.get(partNumber);
    if (!part) {
      await this.renew(auth);
      part = await this.deps.store.stageUserDataExportPart(auth, {
        artifactId: artifact.artifactId,
        partNumber,
        storageBackend: this.deps.blob.backend,
        storageFormat: BLOB_STORAGE_FORMAT,
        storageKey,
        uploadToken: randomUUID(),
      });
      existingParts.set(partNumber, part);
    }
    validatePartIdentity(part, artifact, claim, partNumber, storageKey);
    requireBlobBackend(part.storageBackend, this.deps.blob);

    if (part.state === "uploaded") {
      const stored: BlobDescriptor = {
        storageKey: part.storageKey,
        sha256: part.sha256 ?? "",
        sizeBytes: part.sizeBytes ?? -1,
        ...(part.contentType === undefined ? {} : { contentType: part.contentType }),
      };
      if (!descriptorsEqual(stored, expected)) {
        throw new ArtifactPoisonError("uploaded artifact part differs from deterministic bytes");
      }
      const object = await this.deps.blob.get(part.storageKey, { maxBytes: this.opts.partMaxBytes });
      if (!object || !descriptorsEqual(object, expected) || !object.data.equals(bytes)) {
        throw new ArtifactPoisonError("uploaded artifact part object is missing or corrupt");
      }
      return part;
    }

    // A staged part may be resumed long after it was first created. Renew again immediately before
    // the only external write so a worker that already knows it lost authority never publishes.
    await this.renew(auth);
    const descriptor = await this.deps.blob.putIfAbsent(part.storageKey, bytes, {
      uploadToken: part.uploadToken,
      maxBytes: this.opts.partMaxBytes,
      contentType: USER_DATA_EXPORT_CONTENT_TYPE,
    });
    if (!descriptorsEqual(descriptor, expected)) {
      throw new ArtifactPoisonError("artifact object adapter changed the part descriptor");
    }
    await this.renew(auth);
    const uploaded = await this.deps.store.markUserDataExportPartUploaded(auth, {
      artifactId: artifact.artifactId,
      partNumber,
      descriptor,
    });
    validatePartIdentity(uploaded, artifact, claim, partNumber, storageKey);
    requireBlobBackend(uploaded.storageBackend, this.deps.blob);
    if (
      uploaded.state !== "uploaded"
      || uploaded.sha256 !== expected.sha256
      || uploaded.sizeBytes !== expected.sizeBytes
      || uploaded.contentType !== expected.contentType
    ) throw new ArtifactPoisonError("uploaded artifact part acknowledgement is invalid");
    existingParts.set(partNumber, uploaded);
    return uploaded;
  }

  private async retry(
    claim: UserDataExportClaim,
    errorCode: UserDataExportErrorCode,
    poison: boolean,
  ): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    await this.deps.store.retryUserDataExport(userDataExportAuthorization(claim), {
      delayMs,
      errorCode,
      ...(poison ? { maxAttempts: this.opts.poisonMaxAttempts } : {}),
    });
    return false;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      this.inFlight = run;
      void run
        .catch(() => this.log.warn("[user-data-export] polling failed"))
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
