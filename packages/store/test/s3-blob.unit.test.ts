import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { blobS3NamespaceSha256 } from "@agent-service/protocol";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  BlobConflictError,
  BlobTooLargeError,
  S3BlobStore,
} from "../src/index.js";
import { BLOB_ENVELOPE_HEADER_BYTES } from "../src/blob/envelope.js";

const MAX_BYTES = 1024 * 1024;
const MIGRATION_OWNER_SHA256 = "a".repeat(64);
const OTHER_MIGRATION_OWNER_SHA256 = "b".repeat(64);

function serviceError(status: number, name = status === 412 ? "PreconditionFailed" : "ServiceError") {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType?: string;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();
  readonly commands: unknown[] = [];
  readonly destroy = vi.fn();
  versioning: "Enabled" | "Suspended" | undefined;
  objectLockEnabled = false;
  lifecycleRules: Array<Record<string, unknown>> = [];
  returnVersionId = false;
  failConditionalPuts = 0;
  loseNextPutResponse = false;
  acknowledgePutsWithoutCommit = 0;
  replaceNextPutBody: Buffer | undefined;
  beforeNextPut: ((command: PutObjectCommand) => void | Promise<void>) | undefined;
  afterNextPutCommit: ((command: PutObjectCommand) => void | Promise<void>) | undefined;
  getContentLength: number | undefined;
  getBodyFactory: ((body: Buffer) => unknown) | undefined;
  hangNextSend = false;
  private etagSequence = 0;

  key(bucket: string | undefined, key: string | undefined) {
    return `${bucket ?? ""}/${key ?? ""}`;
  }

  seed(bucket: string, key: string, body: Buffer) {
    const stored = { body: Buffer.from(body), etag: this.nextEtag(body) };
    this.objects.set(this.key(bucket, key), stored);
    return stored;
  }

  private nextEtag(body: Buffer) {
    this.etagSequence += 1;
    return `"${createHash("md5").update(body).update(String(this.etagSequence)).digest("hex")}"`;
  }

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> {
    this.commands.push(command);
    if (this.hangNextSend) {
      this.hangNextSend = false;
      return new Promise((_resolve, reject) => {
        const signal = options?.abortSignal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof GetBucketVersioningCommand) return { Status: this.versioning };
    if (command instanceof GetBucketLifecycleConfigurationCommand) return { Rules: this.lifecycleRules };
    if (command instanceof GetObjectLockConfigurationCommand) {
      return this.objectLockEnabled
        ? { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } }
        : {};
    }

    if (command instanceof HeadObjectCommand) {
      const current = this.objects.get(this.key(command.input.Bucket, command.input.Key));
      if (!current) throw serviceError(404, "NotFound");
      return {
        ETag: current.etag,
        ContentLength: current.body.length,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
      };
    }

    if (command instanceof GetObjectCommand) {
      const current = this.objects.get(this.key(command.input.Bucket, command.input.Key));
      if (!current) throw serviceError(404, "NoSuchKey");
      return {
        ETag: current.etag,
        ContentLength: this.getContentLength ?? current.body.length,
        ContentType: current.contentType,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
        Body: this.getBodyFactory?.(Buffer.from(current.body))
          ?? Readable.from([current.body.subarray(0, 7), current.body.subarray(7)]),
      };
    }

    if (command instanceof PutObjectCommand) {
      const beforePut = this.beforeNextPut;
      this.beforeNextPut = undefined;
      await beforePut?.(command);
      const objectKey = this.key(command.input.Bucket, command.input.Key);
      const current = this.objects.get(objectKey);
      if ((command.input.IfNoneMatch !== undefined || command.input.IfMatch !== undefined)
        && this.failConditionalPuts > 0) {
        this.failConditionalPuts -= 1;
        throw serviceError(409, "ConditionalRequestConflict");
      }
      if (command.input.IfNoneMatch === "*" && current) throw serviceError(412);
      if (command.input.IfMatch !== undefined && current?.etag !== command.input.IfMatch) {
        throw serviceError(412);
      }
      const body = Buffer.from(command.input.Body as Uint8Array);
      if (this.acknowledgePutsWithoutCommit > 0) {
        this.acknowledgePutsWithoutCommit -= 1;
        return { ETag: current?.etag, VersionId: this.returnVersionId ? "unexpected-version" : undefined };
      }
      const committedBody = this.replaceNextPutBody ?? body;
      this.replaceNextPutBody = undefined;
      const stored = {
        body: Buffer.from(committedBody),
        etag: this.nextEtag(committedBody),
        contentType: command.input.ContentType,
      };
      this.objects.set(objectKey, stored);
      const afterCommit = this.afterNextPutCommit;
      this.afterNextPutCommit = undefined;
      await afterCommit?.(command);
      if (this.loseNextPutResponse) {
        this.loseNextPutResponse = false;
        throw Object.assign(new Error("simulated response loss"), { code: "ECONNRESET" });
      }
      return { ETag: stored.etag, VersionId: this.returnVersionId ? "unexpected-version" : undefined };
    }

    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(this.key(command.input.Bucket, command.input.Key));
      return { VersionId: this.returnVersionId ? "unexpected-version" : undefined };
    }
    throw new Error(`unexpected command ${String(command)}`);
  }
}

function makeStore(client = new FakeS3Client(), overrides: Partial<ConstructorParameters<typeof S3BlobStore>[0]> = {}) {
  const options = {
    bucket: "agent-service-test",
    prefix: "tenant-blobs",
    namespaceId: "local-minio",
    client: client as unknown as S3Client,
    ...overrides,
  };
  return { client, store: new S3BlobStore(options) };
}

describe("S3BlobStore unit contract", () => {
  it("derives a stable non-secret shared namespace identity", () => {
    const { store } = makeStore();
    const expected = blobS3NamespaceSha256("local-minio", "agent-service-test", "tenant-blobs");
    expect(store.shared).toBe(true);
    expect(store.namespaceSha256).toBe(expected);
    expect(store.backend).toBe(`s3-v1-${expected.slice(0, 24)}`);
    expect(store.backend).toHaveLength(30);

    expect(() => makeStore(new FakeS3Client(), { prefix: "/tenant-blobs/" })).toThrow("prefix");
    expect(makeStore(new FakeS3Client(), { namespaceId: "other" }).store.backend).not.toBe(store.backend);
    expect(() => makeStore(new FakeS3Client(), { bucket: "INVALID" })).toThrow("bucket");
    expect(() => makeStore(new FakeS3Client(), { bucket: "invalid..bucket" })).toThrow("bucket");
    expect(() => makeStore(new FakeS3Client(), { bucket: "127.0.0.1" })).toThrow("bucket");
    expect(() => makeStore(new FakeS3Client(), { maxMutationAttempts: 0 })).toThrow("mutation attempts");
    expect(() => makeStore(new FakeS3Client(), { requestTimeoutMs: 99 })).toThrow("request timeout");
  });

  it("validates reachability, bucket safety, and real If-None-Match/If-Match behavior", async () => {
    const { client, store } = makeStore();
    await store.validateStartup();
    expect(client.objects.size).toBe(0);
    expect(client.commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketVersioningCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketLifecycleConfigurationCommand)).toBe(true);
    const puts = client.commands.filter((command): command is PutObjectCommand => command instanceof PutObjectCommand);
    expect(puts.some((command) => command.input.IfNoneMatch === "*")).toBe(true);
    expect(puts.some((command) => command.input.IfMatch !== undefined)).toBe(true);
    const cleanupDeletes = client.commands.filter((command): command is DeleteObjectCommand => (
      command instanceof DeleteObjectCommand
    ));
    expect(cleanupDeletes).toHaveLength(1);
    expect(cleanupDeletes[0]?.input.IfMatch).toBeUndefined();
    expect(cleanupDeletes[0]?.input.Key).toContain("/_agent_service_probe/");

    for (const versioning of ["Enabled", "Suspended"] as const) {
      const fixture = makeStore();
      fixture.client.versioning = versioning;
      await expect(fixture.store.validateStartup()).rejects.toThrow(`versioning must be disabled, received ${versioning}`);
      expect(fixture.client.commands.some((command) => command instanceof PutObjectCommand)).toBe(false);
    }

    const locked = makeStore();
    locked.client.objectLockEnabled = true;
    await expect(locked.store.validateStartup()).rejects.toThrow("Object Lock must be disabled");
    expect(locked.client.commands.some((command) => command instanceof PutObjectCommand)).toBe(false);

    const expiring = makeStore();
    expiring.client.lifecycleRules = [{ ID: "expire-tombstones", Status: "Enabled" }];
    await expect(expiring.store.validateStartup()).rejects.toThrow("lifecycle configuration must be absent");
    expect(expiring.client.commands.some((command) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("does not echo SDK endpoint, bucket, key, or credential details in adapter errors", async () => {
    const fixture = makeStore();
    vi.spyOn(fixture.client, "send").mockRejectedValueOnce(
      Object.assign(new Error("https://secret:credential@example.test/agent-service-test/private-key"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );
    let caught: unknown;
    try {
      await fixture.store.validateStartup();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toBe("S3 blob startup reachability check failed (AccessDenied/403)");
    expect(message).not.toContain("credential");
    expect(message).not.toContain("agent-service-test");
    expect(message).not.toContain("private-key");
  });

  it("does not mistake a missing bucket or ambiguous 404 for an absent object", async () => {
    for (const name of ["NoSuchBucket", "ServiceError"] as const) {
      const fixture = makeStore();
      vi.spyOn(fixture.client, "send").mockRejectedValueOnce(serviceError(404, name));
      await expect(fixture.store.get("objects/wrong-namespace", { maxBytes: MAX_BYTES })).rejects.toThrow(
        name === "NoSuchBucket" ? "NoSuchBucket/404" : "failed (404)",
      );
    }
  });

  it("bounds a stalled S3 transport with a per-request abort signal", async () => {
    const fixture = makeStore(new FakeS3Client(), { requestTimeoutMs: 100 });
    fixture.client.hangNextSend = true;
    await expect(fixture.store.validateStartup()).rejects.toThrow("TimeoutError");
  });

  it("bounds SDK credential resolution before the HTTP handler and observes its late rejection", async () => {
    let credentialsSettled = false;
    const store = new S3BlobStore({
      bucket: "agent-service-test",
      prefix: "provider-deadline",
      namespaceId: "local-minio",
      requestTimeoutMs: 100,
      clientConfig: {
        endpoint: "http://127.0.0.1:9",
        region: "us-east-1",
        forcePathStyle: true,
        credentials: async () => {
          await new Promise((resolve) => setTimeout(resolve, 350));
          credentialsSettled = true;
          return {
            accessKeyId: "unit-test-access",
            secretAccessKey: "unit-test-secret-value",
          };
        },
      },
    });
    try {
      const startedAt = performance.now();
      await expect(store.validateStartup()).rejects.toThrow("TimeoutError");
      expect(performance.now() - startedAt).toBeLessThan(300);

      // Let the provider and the already-aborted SDK operation settle. Vitest would also fail this
      // case if the deliberately late rejection escaped as an unhandled promise.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(credentialsSettled).toBe(true);
    } finally {
      store.destroy();
    }
  });

  it("uses one bounded SDK transport recovery without duplicate Smithy transport timers", async () => {
    const store = new S3BlobStore({
      bucket: "agent-service-test",
      prefix: "transport-deadline",
      namespaceId: "local-minio",
      requestTimeoutMs: 1_234,
      clientConfig: {
        region: "us-east-1",
        credentials: {
          accessKeyId: "unit-test-access",
          secretAccessKey: "unit-test-secret-value",
        },
      },
    });
    try {
      // White-box the client defaults to keep the application-created path aligned with the real
      // MinIO suite: one request-local recovery, all governed by the command AbortSignal deadline.
      const client = (store as unknown as {
        client: {
          config: {
            maxAttempts: () => Promise<number>;
            requestHandler: {
              configProvider: Promise<Record<string, unknown>>;
            };
          };
        };
      }).client;
      const handlerConfig = await client.config.requestHandler.configProvider;
      await expect(client.config.maxAttempts()).resolves.toBe(2);
      expect(handlerConfig).toMatchObject({
        connectionTimeout: undefined,
        requestTimeout: undefined,
        socketTimeout: undefined,
        throwOnRequestTimeout: undefined,
      });
    } finally {
      store.destroy();
    }
  });

  it("bounds a response body that never yields or completes", async () => {
    const fixture = makeStore(new FakeS3Client(), { requestTimeoutMs: 100 });
    await fixture.store.putIfAbsent("objects/stalled-body", "value", {
      uploadToken: "stalled-body",
      maxBytes: MAX_BYTES,
    });
    fixture.client.getBodyFactory = (body) => (async function* () {
      await new Promise<void>(() => undefined);
      yield body;
    })();
    await expect(fixture.store.get("objects/stalled-body", { maxBytes: MAX_BYTES })).rejects.toThrow(
      "response stream timed out",
    );
  });

  it("round-trips ASBLOB02 data, makes exact retries idempotent, and never overwrites conflicts", async () => {
    const { client, store } = makeStore();
    const bytes = Buffer.from([0, 1, 2, 0xff]);
    const descriptor = await store.putIfAbsent("objects/blob-1", bytes, {
      uploadToken: "upload-1",
      maxBytes: MAX_BYTES,
      contentType: "application/octet-stream",
    });
    expect(descriptor).toMatchObject({ storageKey: "objects/blob-1", sizeBytes: 4 });
    const raw = client.objects.get("agent-service-test/tenant-blobs/objects/blob-1")?.body;
    expect(raw?.subarray(0, 8).toString("ascii")).toBe("ASBLOB02");
    expect(await store.get("objects/blob-1", { maxBytes: MAX_BYTES })).toEqual({ ...descriptor, data: bytes });

    await expect(store.putIfAbsent("objects/blob-1", Buffer.from(bytes), {
      uploadToken: "upload-2",
      maxBytes: MAX_BYTES,
      contentType: "application/octet-stream",
    })).resolves.toEqual(descriptor);
    await expect(store.putIfAbsent("objects/blob-1", "different", {
      uploadToken: "upload-3",
      maxBytes: MAX_BYTES,
      contentType: "application/octet-stream",
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await store.get("objects/blob-1", { maxBytes: MAX_BYTES }))?.data).toEqual(bytes);
  });

  it("persists migration ownership, recovers lost responses, and rejects foreign identical bytes", async () => {
    const migration = makeStore();
    migration.client.loseNextPutResponse = true;
    const descriptor = await migration.store.putIfAbsent("objects/migration-owned", "same", {
      uploadToken: "migration-owned",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await migration.store.inspectExact("objects/migration-owned", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await migration.store.get("objects/migration-owned", { maxBytes: MAX_BYTES })).toEqual({
      ...descriptor,
      data: Buffer.from("same"),
    });
    await expect(migration.store.putIfAbsent("objects/migration-owned", "same", {
      uploadToken: "foreign-owner",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: OTHER_MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    await expect(migration.store.putIfAbsent("objects/migration-owned", "same", {
      uploadToken: "ordinary-retry",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    })).resolves.toEqual(descriptor);
    expect(await migration.store.inspectExact("objects/migration-owned", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(migration.store.delete("objects/migration-owned", {
      uploadToken: "migration-owned-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await migration.store.get("objects/migration-owned", { maxBytes: MAX_BYTES }))?.data.toString()).toBe(
      "same",
    );

    const preexisting = makeStore();
    const preexistingDescriptor = await preexisting.store.putIfAbsent("objects/preexisting", "same", {
      uploadToken: "preexisting",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    await expect(preexisting.store.putIfAbsent("objects/preexisting", "same", {
      uploadToken: "migration-copy",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    await expect(preexisting.store.discardUncommittedTarget("objects/preexisting", {
      expectedState: { kind: "data", descriptor: preexistingDescriptor },
      uploadToken: "migration-copy",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await preexisting.store.get("objects/preexisting", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("same");

    const tombstone = makeStore();
    tombstone.client.loseNextPutResponse = true;
    await expect(tombstone.store.delete("objects/migration-tombstone-loss", {
      uploadToken: "migration-tombstone-loss",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).resolves.toBeUndefined();
    expect(await tombstone.store.inspectExact("objects/migration-tombstone-loss", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(tombstone.store.discardUncommittedTarget("objects/migration-tombstone-loss", {
      expectedState: { kind: "tombstone" },
      uploadToken: "migration-tombstone-loss",
      migrationOwnerSha256: OTHER_MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);

    await expect(tombstone.store.delete("objects/invalid-migration-owner", {
      uploadToken: "invalid-migration-owner",
      migrationOwnerSha256: "A".repeat(64),
    })).rejects.toThrow("migration owner sha256");
  });

  it("does not replace foreign data that appears after migration-tombstone pre-inspection", async () => {
    const { client, store } = makeStore();
    await store.putIfAbsent("objects/foreign-template", "foreign", {
      uploadToken: "foreign-template",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    const foreignEnvelope = Buffer.from(
      client.objects.get("agent-service-test/tenant-blobs/objects/foreign-template")!.body,
    );
    client.beforeNextPut = (command) => {
      if (!command.input.Key?.endsWith("objects/migration-tombstone-race")) {
        throw new Error("unexpected migration tombstone race command");
      }
      client.seed(
        "agent-service-test",
        "tenant-blobs/objects/migration-tombstone-race",
        foreignEnvelope,
      );
    };

    await expect(store.delete("objects/migration-tombstone-race", {
      uploadToken: "migration-tombstone-race",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await store.get("objects/migration-tombstone-race", { maxBytes: MAX_BYTES }))?.data.toString()).toBe(
      "foreign",
    );
    const attempted = client.commands.findLast((command): command is PutObjectCommand => (
      command instanceof PutObjectCommand
      && command.input.Key?.endsWith("objects/migration-tombstone-race") === true
    ));
    expect(attempted?.input.IfNoneMatch).toBe("*");
    expect(attempted?.input.IfMatch).toBeUndefined();
  });

  it("converges late owned PUT races to a final create-only abort fence", async () => {
    // Fence wins: the PUT was already issued but has not reached its conditional-create point.
    const fenceWinner = makeStore();
    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => { releasePut = resolve; });
    let putReached!: () => void;
    const atPut = new Promise<void>((resolve) => { putReached = resolve; });
    fenceWinner.client.beforeNextPut = async (command) => {
      if (!command.input.Key?.endsWith("objects/fence-wins")) {
        throw new Error("unexpected late-copy command");
      }
      putReached();
      await putGate;
    };
    const delayedPut = fenceWinner.store.putIfAbsent("objects/fence-wins", "owned", {
      uploadToken: "fence-wins-copy",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await atPut;
    await fenceWinner.store.delete("objects/fence-wins", {
      uploadToken: "fence-wins-delete",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    releasePut();
    await expect(delayedPut).rejects.toThrow("cancelled before publication");
    expect(await fenceWinner.store.inspectExact("objects/fence-wins", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });

    // PUT wins after delete's missing pre-inspection: delete conflicts instead of overwriting it;
    // the coordinator's exact discard + retry then establishes the permanent owner fence.
    const putWinner = makeStore();
    const templateDescriptor = await putWinner.store.putIfAbsent("objects/owned-template", "owned", {
      uploadToken: "owned-template",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    const ownedEnvelope = Buffer.from(
      putWinner.client.objects.get("agent-service-test/tenant-blobs/objects/owned-template")!.body,
    );
    putWinner.client.beforeNextPut = (command) => {
      if (!command.input.Key?.endsWith("objects/put-wins")) {
        throw new Error("unexpected abort-fence command");
      }
      putWinner.client.seed("agent-service-test", "tenant-blobs/objects/put-wins", ownedEnvelope);
    };
    await expect(putWinner.store.delete("objects/put-wins", {
      uploadToken: "put-wins-delete",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    const observed = await putWinner.store.inspectExact("objects/put-wins", { maxBytes: MAX_BYTES });
    expect(observed).toEqual({
      kind: "data",
      descriptor: { ...templateDescriptor, storageKey: "objects/put-wins" },
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    if (observed.kind !== "data") throw new Error("expected late owned PUT");
    await putWinner.store.discardUncommittedTarget("objects/put-wins", {
      expectedState: { kind: "data", descriptor: observed.descriptor },
      uploadToken: "put-wins-copy",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await putWinner.store.delete("objects/put-wins", {
      uploadToken: "put-wins-delete",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await putWinner.store.inspectExact("objects/put-wins", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(putWinner.store.putIfAbsent("objects/put-wins", "owned", {
      uploadToken: "put-wins-too-late",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toThrow("cancelled before publication");
  });

  it("inspects exact physical states without collapsing tombstones into missing", async () => {
    const { store } = makeStore();
    expect(await store.inspectExact("objects/inspect", { maxBytes: MAX_BYTES })).toEqual({ kind: "missing" });
    const descriptor = await store.putIfAbsent("objects/inspect", "value", {
      uploadToken: "inspect",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    expect(await store.inspectExact("objects/inspect", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor,
    });
    await store.delete("objects/inspect", { uploadToken: "inspect-delete" });
    expect(await store.inspectExact("objects/inspect", { maxBytes: MAX_BYTES })).toEqual({ kind: "tombstone" });
  });

  it("CAS-replaces exact uncommitted data with a durable owner fence and allows safe replay", async () => {
    const { client, store } = makeStore();
    const dataDescriptor = await store.putIfAbsent("objects/discard-data", "uncommitted", {
      uploadToken: "discard-data",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await store.discardUncommittedTarget("objects/discard-data", {
      expectedState: { kind: "data", descriptor: dataDescriptor },
      uploadToken: "discard-data",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await store.discardUncommittedTarget("objects/discard-data", {
      expectedState: { kind: "data", descriptor: dataDescriptor },
      uploadToken: "discard-data",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await store.inspectExact("objects/discard-data", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });

    await store.delete("objects/discard-tombstone", {
      uploadToken: "discard-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await store.inspectExact("objects/discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await store.discardUncommittedTarget("objects/discard-tombstone", {
      expectedState: { kind: "tombstone" },
      uploadToken: "discard-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await store.discardUncommittedTarget("objects/discard-tombstone", {
      expectedState: { kind: "tombstone" },
      uploadToken: "discard-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await store.inspectExact("objects/discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(store.putIfAbsent("objects/discard-tombstone", "after-abort", {
      uploadToken: "after-abort",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("cancelled before publication");

    const fenceWrites = client.commands.filter((command): command is PutObjectCommand => (
      command instanceof PutObjectCommand
      && command.input.Key?.endsWith("objects/discard-data") === true
      && command.input.IfMatch !== undefined
    ));
    expect(fenceWrites).toHaveLength(1);
  });

  it("uses exact on-object migration provenance independently of the upload token", async () => {
    const { store } = makeStore();
    const descriptor = await store.putIfAbsent("objects/discard-ledger-token", "uncommitted", {
      uploadToken: "initial-write-token",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(store.discardUncommittedTarget("objects/discard-ledger-token", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "ledger-authorized-token",
      migrationOwnerSha256: OTHER_MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    await store.discardUncommittedTarget("objects/discard-ledger-token", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "ledger-authorized-token",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await store.inspectExact("objects/discard-ledger-token", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
  });

  it("refuses to fence a different descriptor, state, owner, or unsafe token", async () => {
    const { store } = makeStore();
    const descriptor = await store.putIfAbsent("objects/discard-conflict", "original", {
      uploadToken: "discard-conflict",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(store.discardUncommittedTarget("objects/discard-conflict", {
      expectedState: { kind: "data", descriptor: { ...descriptor, sha256: "0".repeat(64) } },
      uploadToken: "discard-conflict",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    await expect(store.discardUncommittedTarget("objects/discard-conflict", {
      expectedState: { kind: "tombstone" },
      uploadToken: "discard-conflict",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    await expect(store.discardUncommittedTarget("objects/discard-conflict", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "../unsafe",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toThrow("upload token");
    expect(await store.inspectExact("objects/discard-conflict", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });

    await store.delete("objects/discard-conflict", { uploadToken: "discard-conflict-delete" });
    await expect(store.discardUncommittedTarget("objects/discard-conflict", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "discard-conflict",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect(await store.inspectExact("objects/discard-conflict", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
    });
  });

  it("does not overwrite a different object that wins after exact inspection", async () => {
    const { client, store } = makeStore();
    const descriptor = await store.putIfAbsent("objects/discard-race", "original", {
      uploadToken: "discard-race",
      maxBytes: MAX_BYTES,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await store.putIfAbsent("objects/discard-race-replacement", "replaced", {
      uploadToken: "discard-race-replacement",
      maxBytes: MAX_BYTES,
    });
    const replacement = Buffer.from(
      client.objects.get("agent-service-test/tenant-blobs/objects/discard-race-replacement")!.body,
    );
    client.beforeNextPut = (command) => {
      if (!command.input.Key?.endsWith("objects/discard-race")) {
        throw new Error("unexpected discard race command");
      }
      client.seed("agent-service-test", "tenant-blobs/objects/discard-race", replacement);
    };

    await expect(store.discardUncommittedTarget("objects/discard-race", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "discard-race",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    })).rejects.toBeInstanceOf(BlobConflictError);
    expect((await store.get("objects/discard-race", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("replaced");
  });

  it("reconciles lost CAS-fence responses and retries conditional or false acknowledgements", async () => {
    for (const mode of ["response-loss", "conditional-conflict", "false-ack"] as const) {
      const fixture = makeStore();
      const storageKey = `objects/discard-${mode}`;
      const descriptor = await fixture.store.putIfAbsent(storageKey, "uncommitted", {
        uploadToken: `discard-${mode}`,
        maxBytes: MAX_BYTES,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      if (mode === "response-loss") fixture.client.loseNextPutResponse = true;
      else if (mode === "conditional-conflict") fixture.client.failConditionalPuts = 1;
      else fixture.client.acknowledgePutsWithoutCommit = 1;

      await expect(fixture.store.discardUncommittedTarget(storageKey, {
        expectedState: { kind: "data", descriptor },
        uploadToken: `discard-${mode}`,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      expect(await fixture.store.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      const fenceWrites = fixture.client.commands.filter((command): command is PutObjectCommand => (
        command instanceof PutObjectCommand
        && command.input.Key?.endsWith(storageKey) === true
        && command.input.IfMatch !== undefined
      ));
      expect(fenceWrites).toHaveLength(mode === "response-loss" ? 1 : 2);
    }
  });

  it("reconstructs a missing owner fence across create response loss, conflict, and false ACK", async () => {
    for (const mode of ["response-loss", "conditional-conflict", "false-ack"] as const) {
      const fixture = makeStore();
      const storageKey = `objects/discard-tombstone-${mode}`;
      if (mode === "response-loss") fixture.client.loseNextPutResponse = true;
      else if (mode === "conditional-conflict") fixture.client.failConditionalPuts = 1;
      else fixture.client.acknowledgePutsWithoutCommit = 1;

      await expect(fixture.store.discardUncommittedTarget(storageKey, {
        expectedState: { kind: "tombstone" },
        uploadToken: `tombstone-${mode}`,
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      })).resolves.toBeUndefined();
      expect(await fixture.store.inspectExact(storageKey, { maxBytes: MAX_BYTES })).toEqual({
        kind: "tombstone",
        migrationOwnerSha256: MIGRATION_OWNER_SHA256,
      });
      const fenceWrites = fixture.client.commands.filter((command): command is PutObjectCommand => (
        command instanceof PutObjectCommand
        && command.input.Key?.endsWith(storageKey) === true
        && command.input.IfNoneMatch === "*"
      ));
      expect(fenceWrites).toHaveLength(mode === "response-loss" ? 1 : 2);
    }
  });

  it("linearizes concurrent conflicting writers through conditional create", async () => {
    const { store } = makeStore();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => store.putIfAbsent(
      "objects/concurrent",
      `value-${index}`,
      { uploadToken: `upload-${index}`, maxBytes: MAX_BYTES, contentType: "text/plain" },
    )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BlobConflictError);
    }
  });

  it("makes writes, reads, and deletion immediately visible across independent adapters", async () => {
    const client = new FakeS3Client();
    const first = makeStore(client).store;
    const second = makeStore(client).store;
    await first.putIfAbsent("objects/cross-runner", "shared", {
      uploadToken: "runner-a",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    expect((await second.get("objects/cross-runner", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("shared");
    await second.delete("objects/cross-runner", { uploadToken: "runner-b" });
    expect(await first.get("objects/cross-runner", { maxBytes: MAX_BYTES })).toBeNull();
  });

  it("lets a same-key tombstone win both sides of the staging publication race", async () => {
    for (const pause of ["before", "after"] as const) {
      const fixture = makeStore();
      let reached!: () => void;
      const atMutation = new Promise<void>((resolve) => { reached = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const hook = async () => {
        reached();
        await gate;
      };
      if (pause === "before") fixture.client.beforeNextPut = hook;
      else fixture.client.afterNextPutCommit = hook;

      const upload = fixture.store.putIfAbsent(`objects/race-${pause}`, "must-not-survive", {
        uploadToken: `upload-${pause}`,
        maxBytes: MAX_BYTES,
      });
      await atMutation;
      await fixture.store.delete(`objects/race-${pause}`, { uploadToken: `delete-${pause}` });
      release();
      await expect(upload).rejects.toThrow("cancelled before publication");
      expect(await fixture.store.get(`objects/race-${pause}`, { maxBytes: MAX_BYTES })).toBeNull();
    }
  });

  it("retries 409 conflicts and reconciles a lost successful create response", async () => {
    const conflict = makeStore();
    conflict.client.failConditionalPuts = 1;
    await expect(conflict.store.putIfAbsent("objects/retry-409", "value", {
      uploadToken: "retry-409",
      maxBytes: MAX_BYTES,
    })).resolves.toMatchObject({ storageKey: "objects/retry-409" });

    const responseLoss = makeStore();
    responseLoss.client.loseNextPutResponse = true;
    await expect(responseLoss.store.putIfAbsent("objects/response-loss", "committed", {
      uploadToken: "response-loss",
      maxBytes: MAX_BYTES,
    })).resolves.toMatchObject({ storageKey: "objects/response-loss", sizeBytes: 9 });
  });

  it("uses the data key itself for a permanent CAS tombstone", async () => {
    const { client, store } = makeStore();
    await store.putIfAbsent("objects/delete", "sensitive", {
      uploadToken: "delete-token",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    const objectKey = "agent-service-test/tenant-blobs/objects/delete";
    const dataEtag = client.objects.get(objectKey)?.etag;

    await store.delete("objects/delete", { uploadToken: "delete-token" });
    const tombstone = client.objects.get(objectKey);
    expect(tombstone?.body.subarray(0, 8).toString("ascii")).toBe("ASBLOB02");
    expect(tombstone?.body.includes(Buffer.from("sensitive"))).toBe(false);
    const cas = client.commands.findLast((command): command is PutObjectCommand => (
      command instanceof PutObjectCommand && command.input.Key?.endsWith("objects/delete") === true
    ));
    expect(cas?.input.IfMatch).toBe(dataEtag);
    expect(await store.get("objects/delete", { maxBytes: MAX_BYTES })).toBeNull();

    await store.delete("objects/delete", { uploadToken: "different-token" });
    await expect(store.putIfAbsent("objects/delete", "resurrected", {
      uploadToken: "late-token",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("cancelled before publication");
    expect(client.objects.get(objectKey)?.body).toEqual(tombstone?.body);
  });

  it("creates a tombstone before any upload and handles 412/response-loss deletion retries", async () => {
    const missing = makeStore();
    await missing.store.delete("objects/delete-first", { uploadToken: "delete-first" });
    const createFence = missing.client.commands.findLast((command): command is PutObjectCommand => (
      command instanceof PutObjectCommand && command.input.Key?.endsWith("objects/delete-first") === true
    ));
    expect(createFence?.input.IfNoneMatch).toBe("*");
    await expect(missing.store.putIfAbsent("objects/delete-first", "late", {
      uploadToken: "late",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("cancelled before publication");

    const conflict = makeStore();
    await conflict.store.putIfAbsent("objects/delete-retry", "value", {
      uploadToken: "write",
      maxBytes: MAX_BYTES,
    });
    conflict.client.failConditionalPuts = 1;
    await expect(conflict.store.delete("objects/delete-retry", { uploadToken: "delete" })).resolves.toBeUndefined();
    expect(await conflict.store.get("objects/delete-retry", { maxBytes: MAX_BYTES })).toBeNull();

    const responseLoss = makeStore();
    await responseLoss.store.putIfAbsent("objects/delete-loss", "value", {
      uploadToken: "write",
      maxBytes: MAX_BYTES,
    });
    responseLoss.client.loseNextPutResponse = true;
    await expect(responseLoss.store.delete("objects/delete-loss", { uploadToken: "delete" })).resolves.toBeUndefined();
    expect(await responseLoss.store.get("objects/delete-loss", { maxBytes: MAX_BYTES })).toBeNull();
  });

  it("does not acknowledge deletion until a strong read-back observes the exact tombstone", async () => {
    for (const mutation of ["unchanged", "unexpected"] as const) {
      const fixture = makeStore();
      const storageKey = `objects/delete-readback-${mutation}`;
      await fixture.store.putIfAbsent(storageKey, "sensitive", {
        uploadToken: "write",
        maxBytes: MAX_BYTES,
      });
      if (mutation === "unchanged") fixture.client.acknowledgePutsWithoutCommit = 1;
      else fixture.client.replaceNextPutBody = Buffer.from("unexpected-object");

      await fixture.store.delete(storageKey, { uploadToken: "delete" });
      expect(await fixture.store.get(storageKey, { maxBytes: MAX_BYTES })).toBeNull();
      const deletionPuts = fixture.client.commands.filter((command): command is PutObjectCommand => (
        command instanceof PutObjectCommand
        && command.input.Key?.endsWith(storageKey) === true
        && command.input.IfMatch !== undefined
      ));
      expect(deletionPuts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("fails closed instead of exposing an unfenced DeleteObject path", async () => {
    const { client, store } = makeStore();
    await store.putIfAbsent("objects/no-unfenced-delete", "value", {
      uploadToken: "write",
      maxBytes: MAX_BYTES,
    });
    await expect(store.delete("objects/no-unfenced-delete")).rejects.toThrow("requires an upload token");
    expect(client.commands.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
    expect((await store.get("objects/no-unfenced-delete", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("value");
  });

  it("fails closed if any write response reports object versioning", async () => {
    const fixture = makeStore();
    fixture.client.returnVersionId = true;
    await expect(fixture.store.putIfAbsent("objects/versioned", "value", {
      uploadToken: "versioned",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("versioned-object evidence");

    const changedAfterWrite = makeStore();
    await changedAfterWrite.store.putIfAbsent("objects/versioning-changed", "value", {
      uploadToken: "write",
      maxBytes: MAX_BYTES,
    });
    changedAfterWrite.client.returnVersionId = true;
    await expect(changedAfterWrite.store.delete("objects/versioning-changed", {
      uploadToken: "delete",
    })).rejects.toThrow("versioned-object evidence");
  });

  it("enforces payload bounds from the streamed header and rejects truncation, extra bytes, and corruption", async () => {
    const fixture = makeStore();
    await fixture.store.putIfAbsent("objects/integrity", "12345", {
      uploadToken: "integrity",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
    });
    let payloadChunkRequested = false;
    fixture.client.getBodyFactory = (body) => (async function* () {
      yield body.subarray(0, BLOB_ENVELOPE_HEADER_BYTES);
      payloadChunkRequested = true;
      yield body.subarray(BLOB_ENVELOPE_HEADER_BYTES);
    })();
    await expect(fixture.store.get("objects/integrity", { maxBytes: 4 })).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(payloadChunkRequested).toBe(false);
    fixture.client.getBodyFactory = undefined;

    const objectKey = "agent-service-test/tenant-blobs/objects/integrity";
    const valid = Buffer.from(fixture.client.objects.get(objectKey)!.body);
    fixture.client.seed("agent-service-test", "tenant-blobs/objects/integrity", valid.subarray(0, valid.length - 1));
    await expect(fixture.store.get("objects/integrity", { maxBytes: MAX_BYTES })).rejects.toThrow("envelope length");

    fixture.client.seed("agent-service-test", "tenant-blobs/objects/integrity", Buffer.concat([valid, Buffer.from([0])]));
    await expect(fixture.store.get("objects/integrity", { maxBytes: MAX_BYTES })).rejects.toThrow("envelope length");

    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
    fixture.client.seed("agent-service-test", "tenant-blobs/objects/integrity", corrupt);
    await expect(fixture.store.get("objects/integrity", { maxBytes: MAX_BYTES })).rejects.toThrow("checksum");
  });

  it("never returns partial data when the network body fails mid-stream", async () => {
    const fixture = makeStore();
    await fixture.store.putIfAbsent("objects/stream-error", "complete", {
      uploadToken: "stream-error",
      maxBytes: MAX_BYTES,
    });
    fixture.client.getBodyFactory = (body) => (async function* () {
      yield body.subarray(0, Math.ceil(body.length / 2));
      throw new Error("simulated stream reset");
    })();
    await expect(fixture.store.get("objects/stream-error", { maxBytes: MAX_BYTES })).rejects.toThrow(
      "S3 blob response stream failed",
    );
  });

  it("destroys its client exactly once and rejects later operations", async () => {
    const { client, store } = makeStore();
    await store.close();
    store.destroy();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    await expect(store.get("objects/closed", { maxBytes: MAX_BYTES })).rejects.toThrow("closed");
  });
});
