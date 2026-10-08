import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BLOB_STORAGE_FORMAT,
  BlobConflictError,
  EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256,
  USER_DATA_EXPORT_CONTENT_TYPE,
  USER_DATA_EXPORT_FORMAT,
  USER_DATA_EXPORT_SCHEMA_VERSION,
  UserDataExportStateError,
  canonicalUserDataExportJson,
  newUserDataExportArtifactId,
  newUserDataExportRequestId,
  nextUserDataExportSnapshotRootSha256,
  userDataExportAttachmentLogicalKey,
  type BlobDescriptor,
  type BlobObject,
  type BlobStore,
  type ClaimUserDataExportDeletesOptions,
  type ClaimUserDataExportsOptions,
  type CompleteUserDataExportArtifactInput,
  type MarkUserDataExportPartUploadedInput,
  type RetryUserDataExportDeleteInput,
  type RetryUserDataExportInput,
  type StageUserDataExportPartInput,
  type StartUserDataExportArtifactInput,
  type UserDataExportArtifactPart,
  type UserDataExportArtifactRecord,
  type UserDataExportAuthorization,
  type UserDataExportClaim,
  type UserDataExportCleanupStore,
  type UserDataExportDeleteOutboxRecord,
  type UserDataExportJobStore,
  type UserDataExportRequestRecord,
  type UserDataExportSnapshotBlob,
  type UserDataExportSnapshotRecord,
  type UserDataExportSnapshotSummary,
} from "@agent-service/store";
import { UserDataExportCleanupWorker, UserDataExportWorker } from "../src/index.js";

const silent = { warn: () => {}, error: () => {} };
const POLICY_SHA256 = "a".repeat(64);
const PIN_TOKEN = "b".repeat(64);

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function cloneRecord(record: UserDataExportSnapshotRecord): UserDataExportSnapshotRecord {
  return { ...record, canonicalBytes: Buffer.from(record.canonicalBytes) };
}

interface StoredBlob {
  descriptor: BlobDescriptor;
  data: Buffer;
  uploadToken: string;
}

class FakeBlobStore implements BlobStore {
  readonly backend = "memory-v1";
  readonly objects = new Map<string, StoredBlob>();
  readonly puts: Array<{ storageKey: string; uploadToken: string }> = [];
  readonly gets: string[] = [];
  readonly deletes: Array<{ storageKey: string; uploadToken?: string }> = [];
  getFailures = 0;
  deleteFailures = 0;

  seed(storageKey: string, data: Buffer, contentType?: string): void {
    this.objects.set(storageKey, {
      descriptor: {
        storageKey,
        sha256: sha256(data),
        sizeBytes: data.byteLength,
        ...(contentType === undefined ? {} : { contentType }),
      },
      data: Buffer.from(data),
      uploadToken: "source-upload-token",
    });
  }

  async putIfAbsent(
    storageKey: string,
    data: Buffer | string,
    options: { uploadToken: string; maxBytes: number; contentType?: string },
  ): Promise<BlobDescriptor> {
    const bytes = Buffer.from(data);
    if (bytes.byteLength > options.maxBytes) throw new Error("unexpected test fixture overflow");
    this.puts.push({ storageKey, uploadToken: options.uploadToken });
    const descriptor: BlobDescriptor = {
      storageKey,
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    };
    const existing = this.objects.get(storageKey);
    if (existing) {
      if (
        existing.descriptor.sha256 !== descriptor.sha256
        || existing.descriptor.sizeBytes !== descriptor.sizeBytes
        || existing.descriptor.contentType !== descriptor.contentType
        || !existing.data.equals(bytes)
      ) throw new BlobConflictError(storageKey);
      return { ...existing.descriptor };
    }
    this.objects.set(storageKey, {
      descriptor,
      data: Buffer.from(bytes),
      uploadToken: options.uploadToken,
    });
    return { ...descriptor };
  }

  async get(storageKey: string, options: { maxBytes: number }): Promise<BlobObject | null> {
    this.gets.push(storageKey);
    if (this.getFailures > 0) {
      this.getFailures -= 1;
      throw new Error("temporary object-store read outage token=must-not-be-logged");
    }
    const stored = this.objects.get(storageKey);
    if (!stored) return null;
    if (stored.descriptor.sizeBytes > options.maxBytes) throw new Error("unexpected test fixture overflow");
    return { ...stored.descriptor, data: Buffer.from(stored.data) };
  }

  async delete(storageKey: string, options?: { uploadToken?: string }): Promise<void> {
    this.deletes.push({
      storageKey,
      ...(options?.uploadToken === undefined ? {} : { uploadToken: options.uploadToken }),
    });
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("temporary object-store outage token=must-not-be-logged");
    }
    this.objects.delete(storageKey);
  }
}

interface ExportFixture {
  summary: UserDataExportSnapshotSummary;
  records: UserDataExportSnapshotRecord[];
  blobs: UserDataExportSnapshotBlob[];
  sourceData: Buffer;
}

function exportFixture(options: {
  requestId: string;
  buildGeneration?: number;
  payloads?: string[];
  attachment?: boolean;
}): ExportFixture {
  const buildGeneration = options.buildGeneration ?? 1;
  const payloads = options.payloads ?? ["owned session"];
  const records = payloads.map((payload, ordinal) => {
    const canonicalBytes = Buffer.from(canonicalUserDataExportJson({
      type: "session",
      value: { id: `session_${String(ordinal).padStart(4, "0")}`, payload },
    }), "utf8");
    return {
      requestId: options.requestId,
      buildGeneration,
      ordinal,
      kind: "session" as const,
      logicalKey: canonicalUserDataExportJson(["session", String(ordinal).padStart(4, "0")]),
      canonicalBytes,
      sha256: sha256(canonicalBytes),
      sizeBytes: canonicalBytes.byteLength,
    };
  });

  const sourceData = Buffer.from("private-attachment-payload".repeat(23), "utf8");
  const publicAttachment = {
    blobId: "blob_0199f0c8-8a30-7000-8000-000000000001",
    sessionId: "session_0199f0c8-8a30-7000-8000-000000000002",
    itemId: "item_0199f0c8-8a30-7000-8000-000000000003",
    purpose: "tool_output" as const,
    contentType: "application/octet-stream",
    sha256: sha256(sourceData),
    sizeBytes: sourceData.byteLength,
  };
  const blobs: UserDataExportSnapshotBlob[] = options.attachment === false ? [] : [{
    ...publicAttachment,
    requestId: options.requestId,
    buildGeneration,
    ordinal: 0,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: "objects/source_export_blob",
    sourceUploadToken: "source-upload-token",
    sourceDeletionGeneration: 0,
    pinToken: PIN_TOKEN,
    pinnedAtMs: 1_000,
  }];

  let root = EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256;
  for (const record of records) {
    root = nextUserDataExportSnapshotRootSha256(
      root,
      record.kind,
      record.logicalKey,
      record.sha256,
      record.sizeBytes,
    );
  }
  for (const blob of blobs) {
    const attachment = {
      blobId: blob.blobId,
      sessionId: blob.sessionId,
      itemId: blob.itemId,
      purpose: blob.purpose,
      contentType: blob.contentType,
      sha256: blob.sha256,
      sizeBytes: blob.sizeBytes,
    };
    const canonicalBytes = Buffer.from(canonicalUserDataExportJson({
      type: "attachment",
      value: attachment,
    }), "utf8");
    root = nextUserDataExportSnapshotRootSha256(
      root,
      "attachment",
      userDataExportAttachmentLogicalKey(attachment),
      sha256(canonicalBytes),
      canonicalBytes.byteLength,
    );
  }
  return {
    records,
    blobs,
    sourceData,
    summary: {
      snapshotAtMs: 1_000,
      counts: {
        session: records.length,
        turn: 0,
        item: 0,
        event: 0,
        approval: 0,
        operational_usage: 0,
        attachment: blobs.length,
      },
      recordCount: records.length + blobs.length,
      snapshotRootSha256: root,
    },
  };
}

class FakeExportJobStore implements UserDataExportJobStore {
  readonly requestId: string;
  readonly tenantId = "tenant-a";
  readonly userId = "user-a";
  readonly subjectGeneration = 7;
  readonly buildGeneration = 1;
  readonly policyVersion = "policy-v1";
  readonly artifactTtlMs = 60_000;
  readonly parts = new Map<number, UserDataExportArtifactPart>();
  readonly retryCalls: RetryUserDataExportInput[] = [];
  readonly claimTokens: string[] = [];
  captureCalls = 0;
  startCalls = 0;
  completeCalls = 0;
  renewCalls = 0;
  attempts = 0;
  artifact: UserDataExportArtifactRecord | null = null;
  completion?: CompleteUserDataExportArtifactInput;
  startFailureAfterCommit = false;
  stageFailureAfterCommit = false;
  markFailure: "before" | "after" | undefined;
  completeFailureAfterCommit = false;
  takeoverAtRenewCall?: number;
  dead = false;
  ready = false;
  private active?: UserDataExportAuthorization;

  constructor(readonly fixture: ExportFixture, requestId: string) {
    this.requestId = requestId;
  }

  private matches(auth: UserDataExportAuthorization): boolean {
    return !!this.active
      && Object.entries(this.active).every(([key, value]) => (
        auth[key as keyof UserDataExportAuthorization] === value
      ));
  }

  private require(auth: UserDataExportAuthorization): void {
    if (!this.matches(auth)) throw new UserDataExportStateError("stale fake export claim");
  }

  releaseTakeover(): void {
    this.active = undefined;
  }

  async claimUserDataExports(options: ClaimUserDataExportsOptions): Promise<UserDataExportClaim[]> {
    if (this.active || this.dead || this.ready) return [];
    this.attempts += 1;
    const claim: UserDataExportClaim = {
      requestId: this.requestId,
      tenantId: this.tenantId,
      userId: this.userId,
      subjectGeneration: this.subjectGeneration,
      buildGeneration: this.buildGeneration,
      claimAttempt: this.attempts,
      claimToken: options.claimToken,
      leaseUntilMs: Date.now() + options.leaseMs,
      policyVersion: this.policyVersion,
      policySha256: POLICY_SHA256,
      artifactTtlMs: this.artifactTtlMs,
    };
    this.active = {
      requestId: claim.requestId,
      tenantId: claim.tenantId,
      userId: claim.userId,
      subjectGeneration: claim.subjectGeneration,
      buildGeneration: claim.buildGeneration,
      claimAttempt: claim.claimAttempt,
      claimToken: claim.claimToken,
    };
    this.claimTokens.push(options.claimToken);
    return [claim];
  }

  async renewUserDataExportClaim(
    authorization: UserDataExportAuthorization,
    _leaseMs: number,
  ): Promise<boolean> {
    this.renewCalls += 1;
    if (!this.matches(authorization)) return false;
    if (this.takeoverAtRenewCall === this.renewCalls) {
      this.attempts += 1;
      this.active = {
        ...authorization,
        claimAttempt: this.attempts,
        claimToken: `successor-${randomUUID()}`,
      };
      return false;
    }
    return true;
  }

  async captureAndSealUserDataExportSnapshot(
    authorization: UserDataExportAuthorization,
  ): Promise<UserDataExportSnapshotSummary> {
    this.require(authorization);
    this.captureCalls += 1;
    return structuredClone(this.fixture.summary);
  }

  async readUserDataExportSnapshotRecords(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ) {
    this.require(authorization);
    const remaining = this.fixture.records.filter((row) => (
      options.afterOrdinal === undefined || row.ordinal > options.afterOrdinal
    ));
    const data = remaining.slice(0, options.limit).map(cloneRecord);
    return {
      data,
      nextOrdinal: remaining.length > data.length ? data.at(-1)!.ordinal : null,
    };
  }

  async readUserDataExportSnapshotBlobs(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ) {
    this.require(authorization);
    const remaining = this.fixture.blobs.filter((row) => (
      options.afterOrdinal === undefined || row.ordinal > options.afterOrdinal
    ));
    const data = remaining.slice(0, options.limit).map((row) => ({ ...row }));
    return {
      data,
      nextOrdinal: remaining.length > data.length ? data.at(-1)!.ordinal : null,
    };
  }

  async startUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: StartUserDataExportArtifactInput,
  ): Promise<UserDataExportArtifactRecord> {
    this.require(authorization);
    this.startCalls += 1;
    if (!this.artifact) {
      this.artifact = {
        artifactId: input.artifactId,
        requestId: this.requestId,
        tenantId: this.tenantId,
        userId: this.userId,
        subjectGeneration: this.subjectGeneration,
        buildGeneration: this.buildGeneration,
        state: "staging",
        format: USER_DATA_EXPORT_FORMAT,
        schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
        contentType: USER_DATA_EXPORT_CONTENT_TYPE,
        storageBackend: input.storageBackend,
        storageFormat: input.storageFormat,
        policyVersion: this.policyVersion,
        policySha256: POLICY_SHA256,
        snapshotRootSha256: this.fixture.summary.snapshotRootSha256,
        artifactTtlMs: this.artifactTtlMs,
        stagingExpiresAtMs: 1_000 + input.stagingTtlMs,
        deletionGeneration: 0,
        createdAtMs: 1_000,
      };
    }
    if (this.startFailureAfterCommit) {
      this.startFailureAfterCommit = false;
      throw new Error("simulated lost start acknowledgement");
    }
    return { ...this.artifact };
  }

  async getUserDataExportArtifactBuild(authorization: UserDataExportAuthorization) {
    this.require(authorization);
    return {
      artifact: this.artifact ? { ...this.artifact } : null,
      parts: [...this.parts.values()]
        .sort((left, right) => left.partNumber - right.partNumber)
        .map((part) => ({ ...part })),
    };
  }

  async stageUserDataExportPart(
    authorization: UserDataExportAuthorization,
    input: StageUserDataExportPartInput,
  ): Promise<UserDataExportArtifactPart> {
    this.require(authorization);
    const existing = this.parts.get(input.partNumber);
    if (existing) return { ...existing };
    const part: UserDataExportArtifactPart = {
      artifactId: input.artifactId,
      requestId: this.requestId,
      buildGeneration: this.buildGeneration,
      partNumber: input.partNumber,
      state: "staging",
      storageBackend: input.storageBackend,
      storageFormat: input.storageFormat,
      storageKey: input.storageKey,
      uploadToken: input.uploadToken,
      deletionGeneration: 0,
      createdAtMs: 1_000,
    };
    this.parts.set(input.partNumber, part);
    if (this.stageFailureAfterCommit) {
      this.stageFailureAfterCommit = false;
      throw new Error("simulated lost stage acknowledgement");
    }
    return { ...part };
  }

  async markUserDataExportPartUploaded(
    authorization: UserDataExportAuthorization,
    input: MarkUserDataExportPartUploadedInput,
  ): Promise<UserDataExportArtifactPart> {
    this.require(authorization);
    if (this.markFailure === "before") {
      this.markFailure = undefined;
      throw new Error("simulated crash before uploaded marker");
    }
    const part = this.parts.get(input.partNumber);
    if (!part) throw new UserDataExportStateError("missing fake staged part");
    const uploaded: UserDataExportArtifactPart = {
      ...part,
      state: "uploaded",
      sha256: input.descriptor.sha256,
      sizeBytes: input.descriptor.sizeBytes,
      contentType: input.descriptor.contentType,
      uploadedAtMs: 1_001,
    };
    this.parts.set(input.partNumber, uploaded);
    if (this.markFailure === "after") {
      this.markFailure = undefined;
      throw new Error("simulated lost uploaded-marker acknowledgement");
    }
    return { ...uploaded };
  }

  async completeUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: CompleteUserDataExportArtifactInput,
  ): Promise<UserDataExportRequestRecord> {
    this.require(authorization);
    this.completeCalls += 1;
    this.completion = { ...input };
    this.ready = true;
    this.active = undefined;
    if (this.artifact) this.artifact = { ...this.artifact, state: "ready" };
    if (this.completeFailureAfterCommit) {
      this.completeFailureAfterCommit = false;
      throw new Error("simulated lost completion acknowledgement");
    }
    return {
      requestId: this.requestId,
      tenantId: this.tenantId,
      userId: this.userId,
      subjectGeneration: this.subjectGeneration,
      requestedByKeyId: "admin-key",
      idempotencyKeySha256: "c".repeat(64),
      requestHash: "d".repeat(64),
      format: USER_DATA_EXPORT_FORMAT,
      schemaVersion: USER_DATA_EXPORT_SCHEMA_VERSION,
      policyVersion: this.policyVersion,
      policySha256: POLICY_SHA256,
      artifactTtlMs: this.artifactTtlMs,
      status: "ready",
      currentBuildGeneration: this.buildGeneration,
      currentArtifactId: input.artifactId,
      snapshotAtMs: input.snapshotAtMs,
      readyAtMs: 1_002,
      expiresAtMs: 1_002 + this.artifactTtlMs,
      artifactSha256: input.contentSha256,
      artifactSizeBytes: input.totalSizeBytes,
      recordCount: input.recordCount,
      createdAtMs: 900,
      updatedAtMs: 1_002,
    };
  }

  async retryUserDataExport(
    authorization: UserDataExportAuthorization,
    input: RetryUserDataExportInput,
  ): Promise<boolean> {
    if (!this.matches(authorization)) return false;
    this.retryCalls.push({ ...input });
    this.active = undefined;
    if (input.maxAttempts !== undefined && this.attempts >= input.maxAttempts) this.dead = true;
    return true;
  }
}

function harness(options: {
  requestId?: string;
  payloads?: string[];
  attachment?: boolean;
  seedSource?: boolean;
} = {}) {
  const requestId = options.requestId ?? newUserDataExportRequestId();
  const fixture = exportFixture({
    requestId,
    ...(options.payloads === undefined ? {} : { payloads: options.payloads }),
    ...(options.attachment === undefined ? {} : { attachment: options.attachment }),
  });
  const store = new FakeExportJobStore(fixture, requestId);
  const blob = new FakeBlobStore();
  if (fixture.blobs.length > 0 && options.seedSource !== false) {
    blob.seed(fixture.blobs[0]!.storageKey, fixture.sourceData, fixture.blobs[0]!.contentType);
  }
  return { requestId, fixture, store, blob };
}

const builderOptions = {
  partMaxBytes: 5_000,
  attachmentChunkBytes: 256,
  maxSourceBlobBytes: 2_048,
  snapshotPageSize: 1,
  retryBaseMs: 1,
  retryMaxMs: 1,
};

function artifactBytes(store: FakeExportJobStore, blob: FakeBlobStore): Buffer[] {
  return [...store.parts.values()]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map((part) => Buffer.from(blob.objects.get(part.storageKey)!.data));
}

describe("UserDataExportWorker", () => {
  it("publishes canonical multipart NDJSON without leaking private Blob identity", async () => {
    const { store, blob, fixture } = harness({
      payloads: ["x".repeat(2_800), "y".repeat(2_800)],
    });
    const worker = new UserDataExportWorker({ store, blob, logger: silent }, builderOptions);

    expect(await worker.processOnce()).toBe(1);
    expect(store.ready).toBe(true);
    expect(store.parts.size).toBeGreaterThan(1);
    expect(store.completion).toMatchObject({
      recordCount: fixture.summary.recordCount,
      partCount: store.parts.size,
    });

    const complete = Buffer.concat(artifactBytes(store, blob));
    expect(store.completion?.totalSizeBytes).toBe(complete.byteLength);
    expect(store.completion?.contentSha256).toBe(sha256(complete));
    const lines = complete.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "export/header" });
    expect(lines[0].value).not.toHaveProperty("subjectGeneration");
    expect(lines[0].value).not.toHaveProperty("buildGeneration");
    expect(lines.at(-1)).toMatchObject({
      type: "export/footer",
      value: { snapshotRootSha256: fixture.summary.snapshotRootSha256 },
    });
    const chunks = lines.filter((line) => line.type === "attachment/chunk");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({
      value: { encoding: "base64", chunkIndex: 0, chunkCount: chunks.length },
    });
    const serializedArtifact = complete.toString("utf8");
    for (const forbidden of [
      "storageBackend",
      "storageFormat",
      "storageKey",
      "sourceUploadToken",
      "sourceDeletionGeneration",
      "pinToken",
      "pinnedAtMs",
      "subjectGeneration",
      "buildGeneration",
      "claimToken",
      "uploadToken",
    ]) expect(serializedArtifact).not.toContain(forbidden);
    for (const privateValue of [
      ...fixture.blobs.flatMap((blob) => [blob.storageKey, blob.sourceUploadToken, blob.pinToken]),
      ...store.claimTokens,
      ...[...store.parts.values()].flatMap((part) => [part.storageKey, part.uploadToken]),
    ]) expect(serializedArtifact).not.toContain(privateValue);
    expect(Buffer.concat(chunks.map((line) => Buffer.from(line.value.dataBase64, "base64"))))
      .toEqual(fixture.sourceData);
  });

  it("resumes the same sealed build after lost start and stage acknowledgements", async () => {
    const { store, blob } = harness({ attachment: false });
    store.startFailureAfterCommit = true;
    const worker = new UserDataExportWorker({ store, blob, logger: silent }, builderOptions);

    expect(await worker.processOnce()).toBe(0);
    const artifactId = store.artifact?.artifactId;
    expect(artifactId).toMatch(/^xart_/);
    expect(store.retryCalls.at(-1)).toMatchObject({ errorCode: "temporary_failure" });

    store.stageFailureAfterCommit = true;
    expect(await worker.processOnce()).toBe(0);
    expect(store.artifact?.artifactId).toBe(artifactId);
    expect(store.parts.get(0)?.state).toBe("staging");

    expect(await worker.processOnce()).toBe(1);
    expect(store.artifact?.artifactId).toBe(artifactId);
    expect(store.captureCalls).toBe(3);
    expect(store.startCalls).toBe(1);
  });

  it.each([
    ["before", 2],
    ["after", 1],
  ] as const)("recovers when the uploaded marker fails %s commit", async (failure, expectedPuts) => {
    const { store, blob } = harness({ attachment: false });
    store.markFailure = failure;
    const worker = new UserDataExportWorker({ store, blob, logger: silent }, builderOptions);

    expect(await worker.processOnce()).toBe(0);
    expect(await worker.processOnce()).toBe(1);

    const part = store.parts.get(0)!;
    expect(blob.puts.filter((put) => put.storageKey === part.storageKey)).toHaveLength(expectedPuts);
    expect(part.state).toBe("uploaded");
  });

  it("does not roll back an artifact whose final completion acknowledgement was lost", async () => {
    const { store, blob } = harness({ attachment: false });
    store.completeFailureAfterCommit = true;
    const worker = new UserDataExportWorker({ store, blob, logger: silent }, builderOptions);

    expect(await worker.processOnce()).toBe(0);
    expect(store.ready).toBe(true);
    expect(store.completeCalls).toBe(1);
    expect(store.retryCalls).toHaveLength(0);
    expect(await worker.processOnce()).toBe(0);
    expect(store.completeCalls).toBe(1);
  });

  it("does not publish after claim takeover and lets a later claim resume without ABA", async () => {
    const { store, blob } = harness({ attachment: false });
    const worker = new UserDataExportWorker({ store, blob, logger: silent }, builderOptions);
    // Renew calls: before capture, after capture, first record page, empty attachment page,
    // before staging, before put, after put, then immediately before completion.
    store.takeoverAtRenewCall = 8;

    expect(await worker.processOnce()).toBe(0);
    expect(store.completeCalls).toBe(0);
    expect(store.retryCalls).toHaveLength(0);
    expect(store.ready).toBe(false);

    store.releaseTakeover();
    store.takeoverAtRenewCall = undefined;
    expect(await worker.processOnce()).toBe(1);
    expect(store.completeCalls).toBe(1);
    expect(new Set(store.claimTokens).size).toBe(2);
    expect(store.attempts).toBe(3);
  });

  it.each(["missing", "corrupt"] as const)(
    "bounds deterministic %s source attachment failures as artifact poison",
    async (failure) => {
      const { store, blob, fixture } = harness({ seedSource: failure !== "missing" });
      if (failure === "corrupt") {
        const data = blob.objects.get(fixture.blobs[0]!.storageKey)!.data;
        data.writeUInt8(data.readUInt8(0) ^ 0xff, 0);
      }
      const worker = new UserDataExportWorker(
        { store, blob, logger: silent },
        { ...builderOptions, poisonMaxAttempts: 2 },
      );

      expect(await worker.processOnce()).toBe(0);
      expect(store.retryCalls.at(-1)).toEqual({
        delayMs: 1,
        errorCode: "artifact_invalid",
        maxAttempts: 2,
      });
      expect(store.dead).toBe(false);
      expect(await worker.processOnce()).toBe(0);
      expect(store.dead).toBe(true);
      expect(store.ready).toBe(false);
    },
  );

  it("bounds malformed sealed records as snapshot poison", async () => {
    const { store, blob, fixture } = harness({ attachment: false });
    fixture.records[0]!.canonicalBytes = Buffer.from("{\"type\":\"session\",\"value\":", "utf8");
    const worker = new UserDataExportWorker(
      { store, blob, logger: silent },
      { ...builderOptions, poisonMaxAttempts: 2 },
    );

    expect(await worker.processOnce()).toBe(0);
    expect(store.retryCalls.at(-1)).toEqual({
      delayMs: 1,
      errorCode: "snapshot_invalid",
      maxAttempts: 2,
    });
    expect(await worker.processOnce()).toBe(0);
    expect(store.dead).toBe(true);
  });

  it("keeps temporary source reads retryable beyond the poison cap", async () => {
    const { store, blob } = harness();
    blob.getFailures = 3;
    const worker = new UserDataExportWorker(
      { store, blob, logger: silent },
      { ...builderOptions, poisonMaxAttempts: 2 },
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await worker.processOnce()).toBe(0);
      expect(store.dead).toBe(false);
      expect(store.retryCalls.at(-1)).toEqual({ delayMs: 1, errorCode: "temporary_failure" });
    }
    expect(await worker.processOnce()).toBe(1);
    expect(store.attempts).toBe(4);
  });

  it("produces byte-identical partitions for the same sealed input", async () => {
    const requestId = newUserDataExportRequestId();
    const payloads = ["x".repeat(2_600), "y".repeat(2_600), "z".repeat(2_600)];
    const left = harness({ requestId, payloads });
    const right = harness({ requestId, payloads });
    const leftWorker = new UserDataExportWorker(
      { store: left.store, blob: left.blob, logger: silent },
      builderOptions,
    );
    const rightWorker = new UserDataExportWorker(
      { store: right.store, blob: right.blob, logger: silent },
      builderOptions,
    );

    expect(await leftWorker.processOnce()).toBe(1);
    expect(await rightWorker.processOnce()).toBe(1);
    expect(artifactBytes(left.store, left.blob)).toEqual(artifactBytes(right.store, right.blob));
    expect(left.store.completion).toMatchObject({
      contentSha256: right.store.completion?.contentSha256,
      manifestSha256: right.store.completion?.manifestSha256,
      partCount: right.store.completion?.partCount,
      totalSizeBytes: right.store.completion?.totalSizeBytes,
    });
  });
});

function pendingDelete(): UserDataExportDeleteOutboxRecord {
  const requestId = newUserDataExportRequestId();
  const artifactId = newUserDataExportArtifactId();
  return {
    outboxId: 1,
    artifactId,
    requestId,
    partNumber: 0,
    deletionGeneration: 1,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: `data_exports/${"f".repeat(64)}/${requestId}/${artifactId}/part_0000000000`,
    uploadToken: "artifact-upload-token",
    availableAtMs: 1_000,
    attempts: 0,
    createdAtMs: 1_000,
  };
}

class FakeExportCleanupStore implements UserDataExportCleanupStore {
  row?: UserDataExportDeleteOutboxRecord;
  readonly claimTokens: string[] = [];
  readonly retries: RetryUserDataExportDeleteInput[] = [];
  scheduleCalls = 0;
  loseNextCompletion = false;

  async scheduleUserDataExportDeletes(_limit: number): Promise<number> {
    this.scheduleCalls += 1;
    return 0;
  }

  async claimUserDataExportDeletes(
    options: ClaimUserDataExportDeletesOptions,
  ): Promise<UserDataExportDeleteOutboxRecord[]> {
    const row = this.row;
    if (!row || row.claimToken || row.completedAtMs !== undefined || row.deadLetteredAtMs !== undefined) return [];
    row.attempts += 1;
    row.claimToken = options.claimToken;
    row.leaseUntilMs = Date.now() + options.leaseMs;
    this.claimTokens.push(options.claimToken);
    return [{ ...row }];
  }

  async renewUserDataExportDeleteClaim(
    outboxId: number,
    claimToken: string,
    _leaseMs: number,
  ): Promise<boolean> {
    return this.row?.outboxId === outboxId && this.row.claimToken === claimToken;
  }

  async completeUserDataExportDelete(outboxId: number, claimToken: string): Promise<boolean> {
    const row = this.row;
    if (!row || row.outboxId !== outboxId || row.claimToken !== claimToken) return false;
    if (this.loseNextCompletion) {
      this.loseNextCompletion = false;
      return false;
    }
    row.completedAtMs = Date.now();
    delete row.claimToken;
    delete row.leaseUntilMs;
    return true;
  }

  async retryUserDataExportDelete(
    outboxId: number,
    claimToken: string,
    input: RetryUserDataExportDeleteInput,
  ): Promise<boolean> {
    const row = this.row;
    if (!row || row.outboxId !== outboxId || row.claimToken !== claimToken) return false;
    this.retries.push({ ...input });
    delete row.claimToken;
    delete row.leaseUntilMs;
    if (input.maxAttempts !== undefined && row.attempts >= input.maxAttempts) {
      row.deadLetteredAtMs = Date.now();
    } else {
      row.availableAtMs += input.delayMs;
    }
    return true;
  }

  expireClaim(): void {
    if (!this.row) return;
    delete this.row.claimToken;
    delete this.row.leaseUntilMs;
  }
}

describe("UserDataExportCleanupWorker", () => {
  it("repeats an effective idempotent delete after its database ACK is lost", async () => {
    const store = new FakeExportCleanupStore();
    store.row = pendingDelete();
    store.loseNextCompletion = true;
    const blob = new FakeBlobStore();
    blob.seed(store.row.storageKey, Buffer.from("artifact part"), USER_DATA_EXPORT_CONTENT_TYPE);
    const worker = new UserDataExportCleanupWorker({ store, blob, logger: silent });

    expect(await worker.cleanupOnce()).toBe(0);
    expect(blob.objects.has(store.row.storageKey)).toBe(false);
    store.expireClaim();
    expect(await worker.cleanupOnce()).toBe(1);

    expect(blob.deletes).toHaveLength(2);
    expect(new Set(store.claimTokens).size).toBe(2);
    expect(store.row).toMatchObject({ attempts: 2, completedAtMs: expect.any(Number) });
  });

  it("keeps availability failures retryable beyond the deterministic poison cap", async () => {
    const store = new FakeExportCleanupStore();
    store.row = pendingDelete();
    const blob = new FakeBlobStore();
    blob.seed(store.row.storageKey, Buffer.from("artifact part"), USER_DATA_EXPORT_CONTENT_TYPE);
    blob.deleteFailures = 3;
    const worker = new UserDataExportCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1, poisonMaxAttempts: 2 },
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await worker.cleanupOnce()).toBe(0);
      expect(store.row.deadLetteredAtMs).toBeUndefined();
      expect(store.retries.at(-1)?.maxAttempts).toBeUndefined();
    }
    expect(await worker.cleanupOnce()).toBe(1);
    expect(store.row.attempts).toBe(4);
  });

  it("bounds malformed artifact identities without touching the object adapter", async () => {
    const store = new FakeExportCleanupStore();
    // This is a syntactically valid session-Blob namespace key; the export-only worker must still
    // reject it before invoking the shared physical Blob adapter.
    store.row = { ...pendingDelete(), storageKey: "objects/aa/blob_session_owned" };
    const blob = new FakeBlobStore();
    const worker = new UserDataExportCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1, poisonMaxAttempts: 2 },
    );

    expect(await worker.cleanupOnce()).toBe(0);
    expect(await worker.cleanupOnce()).toBe(0);
    expect(store.row.deadLetteredAtMs).toEqual(expect.any(Number));
    expect(blob.deletes).toHaveLength(0);
    expect(store.retries).toHaveLength(2);
    expect(store.retries.every((retry) => retry.maxAttempts === 2)).toBe(true);
  });
});
