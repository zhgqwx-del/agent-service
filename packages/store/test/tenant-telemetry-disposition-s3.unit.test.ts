import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
  TenantTelemetryDispositionConflictError,
  tenantTelemetryDispositionOperationSha256,
} from "../src/tenant-telemetry-disposition.js";
import {
  TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
  decodeTenantTelemetryDispositionEnvelope,
  encodeTenantTelemetryDispositionEnvelope,
} from "../src/tenant-telemetry-disposition-adapter/codec.js";
import {
  S3_TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  S3TenantTelemetryDispositionAdapter,
  s3TenantTelemetryDispositionFailureDomainSha256,
  s3TenantTelemetryDispositionNamespaceSha256,
  s3TenantTelemetryDispositionTargetSha256,
} from "../src/tenant-telemetry-disposition-adapter/s3.js";
import { dispositionDigest, dispositionEvidence, tombstoneAck } from "./tenant-telemetry-disposition.fixture.js";

const BUCKET = "agent-service-telemetry-disposition-test";
const PREFIX = "telemetry-disposition-tests/unit";
const NAMESPACE_ID = "unit-telemetry-disposition";
const FAILURE_DOMAIN_ID = "unit-provider-account-region";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = dispositionDigest("logical-database");
const REGION = "us-east-1";
const ENDPOINT = "https://s3.unit.invalid";

function serviceError(status: number, name = status === 412 ? "PreconditionFailed" : "ServiceError") {
  return Object.assign(
    new Error(`unsafe-${name}-https://secret:credential@example.invalid/private-key`),
    { name, $metadata: { httpStatusCode: status } },
  );
}

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType: string | undefined;
}

interface FakeState {
  objects: Map<string, StoredObject>;
  etagSequence: number;
}

function fakeState(): FakeState {
  return { objects: new Map(), etagSequence: 0 };
}

class FakeS3Client {
  readonly commands: unknown[] = [];
  readonly abortedCommands: unknown[] = [];
  readonly destroy = vi.fn();
  versioning: "Enabled" | "Suspended" | undefined;
  lifecycleRules: Array<Record<string, unknown>> = [];
  objectLockEnabled = false;
  ignoreIfNoneMatch = false;
  ignoreIfMatch = false;
  returnVersionId = false;
  returnDeleteMarker = false;
  loseNextPutFor: ((key: string) => boolean) | undefined;
  falseAckNextPutFor: ((key: string) => boolean) | undefined;
  getBodyFactory: ((body: Buffer) => unknown) | undefined;
  rejectNext: unknown;
  delayEverySendMs = 0;

  constructor(readonly state = fakeState()) {}

  private key(bucket: string | undefined, key: string | undefined): string {
    return `${bucket ?? ""}/${key ?? ""}`;
  }

  private nextEtag(body: Buffer): string {
    this.state.etagSequence += 1;
    return `"${createHash("md5")
      .update(body)
      .update(String(this.state.etagSequence))
      .digest("hex")}"`;
  }

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> {
    this.commands.push(command);
    if (this.delayEverySendMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          this.abortedCommands.push(command);
          reject(options?.abortSignal?.reason);
        };
        const timer = setTimeout(() => {
          options?.abortSignal?.removeEventListener("abort", abort);
          resolve();
        }, this.delayEverySendMs);
        if (options?.abortSignal?.aborted) abort();
        else options?.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (this.rejectNext !== undefined) {
      const error = this.rejectNext;
      this.rejectNext = undefined;
      throw error;
    }
    if (command instanceof HeadBucketCommand) return {};
    if (command instanceof GetBucketVersioningCommand) return { Status: this.versioning };
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      return { Rules: this.lifecycleRules };
    }
    if (command instanceof GetObjectLockConfigurationCommand) {
      return this.objectLockEnabled
        ? { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } }
        : {};
    }
    if (command instanceof GetObjectCommand) {
      const current = this.state.objects.get(this.key(
        command.input.Bucket,
        command.input.Key,
      ));
      if (!current) throw serviceError(404, "NoSuchKey");
      return {
        ETag: current.etag,
        ContentLength: current.body.byteLength,
        ContentType: current.contentType,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
        DeleteMarker: this.returnDeleteMarker || undefined,
        Body: this.getBodyFactory?.(current.body) ?? Readable.from([
          current.body.subarray(0, Math.min(13, current.body.length)),
          current.body.subarray(Math.min(13, current.body.length)),
        ]),
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      const objectKey = this.key(command.input.Bucket, command.input.Key);
      const current = this.state.objects.get(objectKey);
      if (!this.ignoreIfNoneMatch && command.input.IfNoneMatch === "*" && current) {
        throw serviceError(412);
      }
      if (!this.ignoreIfMatch && command.input.IfMatch !== undefined
        && current?.etag !== command.input.IfMatch) {
        throw serviceError(412);
      }
      const body = Buffer.from(command.input.Body as Uint8Array);
      if (this.falseAckNextPutFor?.(key)) {
        this.falseAckNextPutFor = undefined;
        return {};
      }
      const stored: StoredObject = {
        body,
        etag: this.nextEtag(body),
        contentType: command.input.ContentType,
      };
      this.state.objects.set(objectKey, stored);
      if (this.loseNextPutFor?.(key)) {
        this.loseNextPutFor = undefined;
        throw Object.assign(new Error("private endpoint response loss"), { code: "ECONNRESET" });
      }
      return {
        ETag: stored.etag,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
      };
    }
    throw new Error(`unexpected S3 command ${String(command)}`);
  }
}

function fixture(
  client = new FakeS3Client(),
  overrides: Partial<ConstructorParameters<
    typeof S3TenantTelemetryDispositionAdapter
  >[0]> = {},
) {
  const adapter = new S3TenantTelemetryDispositionAdapter({
    independentFailureDomain: true,
    privateBucketAccessVerified: true,
    nonProductionMutationFixture: true,
    bucket: BUCKET,
    prefix: PREFIX,
    namespaceId: NAMESPACE_ID,
    failureDomainId: FAILURE_DOMAIN_ID,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    client: client as unknown as S3Client,
    ...overrides,
  });
  return { client, adapter };
}

function storedHead(state: FakeState): StoredObject {
  const key = [...state.objects.keys()].find((candidate) =>
    candidate.endsWith("/authority/head-v1"));
  if (!key) throw new Error("missing authority head fixture");
  const head = state.objects.get(key);
  if (!head) throw new Error("missing authority head object fixture");
  return head;
}

function eventCount(state: FakeState): number {
  return [...state.objects.keys()].filter((key) => key.includes("/events/")).length;
}

describe("tenant telemetry disposition dedicated envelope", () => {
  it("round-trips deterministically and rejects corruption and kind confusion", () => {
    const encoded = encodeTenantTelemetryDispositionEnvelope("event", "{\"safe\":true}");
    expect(decodeTenantTelemetryDispositionEnvelope("event", encoded)).toBe("{\"safe\":true}");
    expect(encodeTenantTelemetryDispositionEnvelope("event", "{\"safe\":true}"))
      .toEqual(encoded);
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decodeTenantTelemetryDispositionEnvelope("event", corrupt))
      .toThrow("checksum");
    expect(() => decodeTenantTelemetryDispositionEnvelope("head", encoded)).toThrow("kind");
  });
});

describe("S3TenantTelemetryDispositionAdapter unit contract", () => {
  it("denies every product journal operation without issuing S3 commands", async () => {
    const client = new FakeS3Client();
    const { adapter } = fixture(client, {
      nonProductionMutationFixture: false,
    } as never);
    await expect(adapter.validateStartup())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    await expect(adapter.readHead())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    await expect(adapter.authorizeDeletion(dispositionEvidence(1)))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    const { adapter: fixtureAdapter } = fixture();
    const authorization = await fixtureAdapter.authorizeDeletion(dispositionEvidence(1));
    await expect(adapter.recordTombstone(tombstoneAck(authorization)))
      .rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    await expect(adapter.scanEvents({
      afterJournalSequence: 0,
      afterJournalEventRootSha256:
        EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
      sealedHead: await fixtureAdapter.readHead(),
      limit: 1,
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    expect(client.commands).toHaveLength(0);
    expect(client.state.objects.size).toBe(0);
  });

  it("forbids the non-production fixture when NODE_ENV is production", () => {
    expect(() => fixture(new FakeS3Client(), {
      nonProductionMutationFixture: true,
    })).not.toThrow();
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(() => fixture(new FakeS3Client(), {
        nonProductionMutationFixture: true,
      })).toThrow("forbidden in production");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets only the non-production fixture initialize and promote pending authority", async () => {
    const state = fakeState();
    const reader = fixture(new FakeS3Client(state));
    const genesis = await reader.adapter.readHead();
    expect(genesis.journalSequence).toBe(0);
    expect(reader.client.commands.some((command) => command instanceof PutObjectCommand
      && command.input.Key?.endsWith("/authority/head-v1")
      && command.input.IfNoneMatch === "*")).toBe(true);
    const genesisObject = storedHead(state);

    const writer = fixture(new FakeS3Client(state));
    const evidence = dispositionEvidence(101);
    const authorization = await writer.adapter.authorizeDeletion(evidence);
    expect(authorization.journalSequence).toBe(1);
    expect(eventCount(state)).toBe(1);
    const headKey = [...state.objects.keys()].find((key) =>
      key.endsWith("/authority/head-v1"));
    if (!headKey) throw new Error("missing authority head fixture");
    // A persisted event with a stale head models response loss between create and CAS.
    state.objects.set(headKey, genesisObject);
    const commandCount = reader.client.commands.length;
    const recovered = await reader.adapter.readHead();
    expect(recovered.journalSequence).toBe(1);
    expect(recovered.journalEventRootSha256).toBe(authorization.journalEventRootSha256);
    expect(reader.client.commands.slice(commandCount).some((command) =>
      command instanceof PutObjectCommand
      && command.input.Key === headKey.slice(BUCKET.length + 1)
      && command.input.IfMatch === genesisObject.etag)).toBe(true);
    expect(eventCount(state)).toBe(1);
  });
  it("requires explicit independent/private acknowledgements and exposes only digests", () => {
    const { adapter } = fixture();
    expect(adapter.adapterProtocol).toBe(S3_TENANT_TELEMETRY_DISPOSITION_PROTOCOL);
    expect(adapter.adapterProtocol).toContain("cas-head");
    expect(adapter.journalNamespaceSha256).toBe(
      s3TenantTelemetryDispositionNamespaceSha256(NAMESPACE_ID),
    );
    expect(adapter.failureDomainSha256).toBe(
      s3TenantTelemetryDispositionFailureDomainSha256(FAILURE_DOMAIN_ID),
    );
    expect(adapter.journalTargetSha256).toBe(s3TenantTelemetryDispositionTargetSha256({
      journalNamespaceSha256: adapter.journalNamespaceSha256,
      failureDomainSha256: adapter.failureDomainSha256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      bucket: BUCKET,
      prefix: PREFIX,
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
    }));
    expect(() => fixture(new FakeS3Client(), {
      privateBucketAccessVerified: false,
    } as never)).toThrow("private-bucket");
    expect(() => fixture(new FakeS3Client(), {
      independentFailureDomain: false,
    } as never)).toThrow("independent failure-domain");
    expect(() => fixture(new FakeS3Client(), { operationTimeoutMs: 99 })).toThrow("timeout");
    expect(() => fixture(new FakeS3Client(), {
      endpoint: "https://user:secret@s3.unit.invalid",
    })).toThrow("credential-free");
  });

  it("preflights create-only and stale-ETag CAS and never calls LIST or DELETE", async () => {
    const { client, adapter } = fixture();
    await adapter.validateStartup();
    expect(client.commands.some((command) => command instanceof PutObjectCommand
      && command.input.IfNoneMatch === "*")).toBe(true);
    expect(client.commands.some((command) => command instanceof PutObjectCommand
      && command.input.IfMatch !== undefined)).toBe(true);
    expect(client.commands.map((command) => command?.constructor?.name)
      .some((name) => name?.includes("List") || name?.includes("Delete"))).toBe(false);

    const ignoredCreate = fixture(new FakeS3Client());
    ignoredCreate.client.ignoreIfNoneMatch = true;
    await expect(ignoredCreate.adapter.validateStartup()).rejects.toThrow("If-None-Match");

    const ignoredCas = fixture(new FakeS3Client());
    ignoredCas.client.ignoreIfMatch = true;
    await expect(ignoredCas.adapter.validateStartup()).rejects.toThrow("If-Match");
  });

  it("commits authorization then terminal event and supports exact sealed scans", async () => {
    const { client, adapter } = fixture();
    await adapter.validateStartup();
    const evidence = dispositionEvidence(10);
    const authorization = await adapter.authorizeDeletion(evidence);
    expect(authorization.journalSequence).toBe(1);
    expect(await adapter.authorizeDeletion(evidence)).toEqual(authorization);
    const terminal = await adapter.recordTombstone(tombstoneAck(authorization));
    const sealedHead = await adapter.readHead();
    expect(sealedHead).toMatchObject({
      journalSequence: 2,
      journalEventRootSha256: terminal.journalEventRootSha256,
    });
    const page = await adapter.scanEvents({
      afterJournalSequence: 0,
      afterJournalEventRootSha256:
        EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
      sealedHead,
      limit: 1,
    });
    expect(page.events).toHaveLength(1);
    expect(page.complete).toBe(false);
    const finalPage = await adapter.scanEvents({
      afterJournalSequence: page.nextJournalSequence,
      afterJournalEventRootSha256: page.nextJournalEventRootSha256,
      sealedHead,
      limit: 10,
    });
    expect(finalPage.events).toHaveLength(1);
    expect(finalPage.complete).toBe(true);
    expect(client.commands.map((command) => command?.constructor?.name)
      .some((name) => name?.includes("List"))).toBe(false);
    await expect(adapter.recordTombstone(tombstoneAck(authorization, {
      suffix: "conflict",
    }))).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
  });

  it("copies streamed chunks before a reader recycles their backing buffer", async () => {
    const { client, adapter } = fixture();
    const authorization = await adapter.authorizeDeletion(dispositionEvidence(31));
    client.getBodyFactory = (body) => (async function* () {
      const reusable = Buffer.alloc(17);
      for (let offset = 0; offset < body.byteLength; offset += reusable.byteLength) {
        const length = Math.min(reusable.byteLength, body.byteLength - offset);
        body.copy(reusable, 0, offset, offset + length);
        yield reusable.subarray(0, length);
      }
    })();
    const head = await adapter.readHead();
    expect(head.journalSequence).toBe(1);
    expect(head.journalEventRootSha256).toBe(authorization.journalEventRootSha256);
    const page = await adapter.scanEvents({
      afterJournalSequence: 0,
      afterJournalEventRootSha256:
        EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
      sealedHead: head,
      limit: 1,
    });
    expect(page.events[0]?.result).toEqual(authorization);
  });

  it("recovers exact event/head response loss without forking the chain", async () => {
    const { client, adapter } = fixture();
    await adapter.readHead();
    client.loseNextPutFor = (key) => key.includes("/events/");
    const first = await adapter.authorizeDeletion(dispositionEvidence(11));
    expect(first.journalSequence).toBe(1);
    client.loseNextPutFor = (key) => key.endsWith("/authority/head-v1");
    const second = await adapter.authorizeDeletion(dispositionEvidence(12));
    expect(second.journalSequence).toBe(2);
    expect((await adapter.readHead()).journalSequence).toBe(2);
  });

  it("rejects false event-create success without durable authorization or terminal", async () => {
    const { client, adapter } = fixture(new FakeS3Client(), {
      maxMutationAttempts: 1,
    });
    await adapter.readHead();
    const evidence = dispositionEvidence(102);
    client.falseAckNextPutFor = (key) => key.includes("/events/");
    await expect(adapter.authorizeDeletion(evidence)).rejects.toThrow();
    expect(eventCount(client.state)).toBe(0);
    expect((await adapter.readHead()).journalSequence).toBe(0);

    const authorization = await adapter.authorizeDeletion(evidence);
    expect(authorization.journalSequence).toBe(1);
    expect(eventCount(client.state)).toBe(1);
    const ack = tombstoneAck(authorization);
    client.falseAckNextPutFor = (key) => key.includes("/events/");
    await expect(adapter.recordTombstone(ack)).rejects.toThrow();
    expect(eventCount(client.state)).toBe(1);
    expect((await adapter.readHead()).journalSequence).toBe(1);

    const terminal = await adapter.recordTombstone(ack);
    expect(terminal.journalSequence).toBe(2);
    expect(eventCount(client.state)).toBe(2);
    expect(await adapter.recordTombstone(ack)).toEqual(terminal);
    expect(eventCount(client.state)).toBe(2);
  });

  it("does not return proof for a false head-CAS success, then exactly replays pending events", async () => {
    const state = fakeState();
    const { client, adapter } = fixture(new FakeS3Client(state), {
      maxMutationAttempts: 1,
    });
    await adapter.readHead();
    const genesisObject = storedHead(state);
    const evidence = dispositionEvidence(103);
    client.falseAckNextPutFor = (key) => key.endsWith("/authority/head-v1");
    await expect(adapter.authorizeDeletion(evidence)).rejects.toThrow();
    expect(eventCount(state)).toBe(1);
    expect(storedHead(state)).toBe(genesisObject);

    // A fresh client recovers the already-created event by CAS, without appending a second one.
    const recovered = fixture(new FakeS3Client(state));
    expect((await recovered.adapter.readHead()).journalSequence).toBe(1);
    const authorization = await recovered.adapter.authorizeDeletion(evidence);
    expect(authorization.journalSequence).toBe(1);
    expect(eventCount(state)).toBe(1);

    const priorHead = storedHead(state);
    const ack = tombstoneAck(authorization);
    const singleAttempt = fixture(new FakeS3Client(state), { maxMutationAttempts: 1 });
    singleAttempt.client.falseAckNextPutFor = (key) => key.endsWith("/authority/head-v1");
    await expect(singleAttempt.adapter.recordTombstone(ack)).rejects.toThrow();
    expect(eventCount(state)).toBe(2);
    expect(storedHead(state)).toBe(priorHead);

    const replay = fixture(new FakeS3Client(state));
    expect((await replay.adapter.readHead()).journalSequence).toBe(2);
    const terminal = await replay.adapter.recordTombstone(ack);
    expect(terminal.journalSequence).toBe(2);
    expect(eventCount(state)).toBe(2);
    expect(await replay.adapter.recordTombstone(ack)).toEqual(terminal);
  });

  it("fences one artifact identity against a second operation across clients", async () => {
    const shared = fakeState();
    const first = fixture(new FakeS3Client(shared));
    const second = fixture(new FakeS3Client(shared));
    const original = dispositionEvidence(15);
    const { dispositionOperationSha256: _oldOperation, ...source } = original;
    const changedSource = {
      ...source,
      t3dPlanReceiptSha256: dispositionDigest("different-sealed-plan"),
    };
    const changed = {
      ...changedSource,
      dispositionOperationSha256:
        tenantTelemetryDispositionOperationSha256(changedSource),
    };
    const results = await Promise.allSettled([
      first.adapter.authorizeDeletion(original),
      second.adapter.authorizeDeletion(changed),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null)
      .toBeInstanceOf(TenantTelemetryDispositionConflictError);
    expect((await first.adapter.readHead()).journalSequence).toBe(1);
    await first.adapter.close();
    await second.adapter.close();
  });

  it("rejects an authority head whose committed event was lost", async () => {
    const { client, adapter } = fixture();
    await adapter.authorizeDeletion(dispositionEvidence(16));
    const eventKey = [...client.state.objects.keys()].find((key) => key.includes("/events/"));
    if (!eventKey) throw new Error("missing committed event fixture");
    client.state.objects.delete(eventKey);
    await expect(adapter.readHead()).rejects.toThrow("corrupt");
  });

  it("uses one whole-operation deadline across requests and sanitizes failures", async () => {
    vi.useFakeTimers();
    try {
      const slow = new FakeS3Client();
      slow.delayEverySendMs = 35;
      const slowFixture = fixture(slow, { operationTimeoutMs: 100 });
      const started = Date.now();
      // The deadline may surface before a request or as the sanitized SDK timeout.
      // Advance one shared clock instead of racing 35ms wall timers on a loaded host.
      const rejection = expect(
        slowFixture.adapter.authorizeDeletion(dispositionEvidence(13)),
      ).rejects.toThrow(/deadline|timed out|TimeoutError/);
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(Date.now() - started).toBe(100);
      expect(slow.commands).toHaveLength(3);
      expect(slow.abortedCommands).toEqual([slow.commands[2]]);
      expect(slow.state.objects.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(slow.commands).toHaveLength(3);
      expect(slow.state.objects.size).toBe(0);
      await slowFixture.adapter.close();
    } finally {
      vi.useRealTimers();
    }

    const failed = fixture(new FakeS3Client());
    failed.client.rejectNext = serviceError(503, "ServiceUnavailable");
    let message = "";
    try {
      await failed.adapter.readHead();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("ServiceUnavailable/503");
    expect(message).not.toContain("credential");
    expect(message).not.toContain("private-key");
    expect(message).not.toContain(ENDPOINT);
  });

  it("rejects versioning, lifecycle, Object Lock, version evidence, and corrupt content type", async () => {
    const versioned = fixture(new FakeS3Client());
    versioned.client.versioning = "Enabled";
    await expect(versioned.adapter.validateStartup()).rejects.toThrow("versioning");
    const lifecycle = fixture(new FakeS3Client());
    lifecycle.client.lifecycleRules = [{}];
    await expect(lifecycle.adapter.validateStartup()).rejects.toThrow("lifecycle");
    const locked = fixture(new FakeS3Client());
    locked.client.objectLockEnabled = true;
    await expect(locked.adapter.validateStartup()).rejects.toThrow("Object Lock");

    const versionEvidence = fixture(new FakeS3Client());
    versionEvidence.client.returnVersionId = true;
    await expect(versionEvidence.adapter.readHead()).rejects.toThrow("versioned-object");

    const corrupt = fixture(new FakeS3Client());
    await corrupt.adapter.readHead();
    const stored = [...corrupt.client.state.objects.values()].find(
      (object) => object.contentType === TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
    );
    if (!stored) throw new Error("missing head fixture");
    stored.contentType = TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE;
    await expect(corrupt.adapter.readHead()).rejects.toThrow("corrupt");
  });
});
