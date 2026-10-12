import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemorySessionStore,
  S3_TENANT_TELEMETRY_BACKEND_KIND,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  S3TenantTelemetryWriteAdapter,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  s3TenantTelemetryTargetIdentity,
  type TenantTelemetryLifecycleTargetRecord,
  type TenantTelemetryWriteAdapterInput,
} from "../src/index.js";
import {
  TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES,
  TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE,
  decodeTenantTelemetryS3Envelope,
  encodeTenantTelemetryS3Envelope,
} from "../src/tenant-telemetry-adapter/s3-codec.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const BUCKET = "agent-service-telemetry-test";
const PREFIX = "telemetry-tests/unit";
const NAMESPACE_ID = "unit-managed-telemetry";
const FAILURE_DOMAIN_ID = "unit-provider-account-region";
const REGION = "us-east-1";
const ENDPOINT = "https://s3.unit.invalid";
const REF_KEY = new Uint8Array(32).fill(41);

function serviceError(status: number, name = status === 412 ? "PreconditionFailed" : "ServiceError") {
  return Object.assign(
    new Error(`unsafe-${name}-https://secret:credential@example.invalid/private-key`),
    { name, $metadata: { httpStatusCode: status } },
  );
}

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType?: string;
}

interface FakeS3State {
  objects: Map<string, StoredObject>;
  etagSequence: number;
}

function fakeState(): FakeS3State {
  return { objects: new Map(), etagSequence: 0 };
}

class FakeS3Client {
  readonly commands: unknown[] = [];
  readonly destroy = vi.fn();
  versioning: "Enabled" | "Suspended" | undefined;
  lifecycleRules: Array<Record<string, unknown>> = [];
  objectLockEnabled = false;
  ignoreIfNoneMatch = false;
  returnVersionId = false;
  returnDeleteMarker = false;
  loseNextPutResponse = false;
  falseAckNextPut = false;
  hangNextSend = false;
  delaysMs: number[] = [];
  rejectNext: unknown;
  getContentLength: number | undefined;
  getBodyFactory: ((body: Buffer) => unknown) | undefined;

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

  seed(key: string, body: Buffer, contentType = TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE): void {
    this.state.objects.set(this.key(BUCKET, key), {
      body: Buffer.from(body),
      etag: this.nextEtag(body),
      contentType,
    });
  }

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any> {
    this.commands.push(command);
    if (this.rejectNext !== undefined) {
      const error = this.rejectNext;
      this.rejectNext = undefined;
      throw error;
    }
    if (this.hangNextSend) {
      this.hangNextSend = false;
      return new Promise((_resolve, reject) => {
        if (options?.abortSignal?.aborted) reject(options.abortSignal.reason);
        else options?.abortSignal?.addEventListener(
          "abort",
          () => reject(options.abortSignal?.reason),
          { once: true },
        );
      });
    }
    const delayMs = this.delaysMs.shift();
    if (delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options?.abortSignal?.removeEventListener("abort", abort);
          resolve();
        }, delayMs);
        const abort = () => {
          clearTimeout(timer);
          reject(options?.abortSignal?.reason);
        };
        if (options?.abortSignal?.aborted) abort();
        else options?.abortSignal?.addEventListener("abort", abort, { once: true });
      });
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
    if (command instanceof HeadObjectCommand) {
      const object = this.state.objects.get(this.key(command.input.Bucket, command.input.Key));
      if (!object) throw serviceError(404, "NotFound");
      return {
        ETag: object.etag,
        ContentLength: object.body.byteLength,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
        DeleteMarker: this.returnDeleteMarker || undefined,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.state.objects.get(this.key(command.input.Bucket, command.input.Key));
      if (!object) throw serviceError(404, "NoSuchKey");
      return {
        ETag: object.etag,
        ContentLength: this.getContentLength ?? object.body.byteLength,
        ContentType: object.contentType,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
        DeleteMarker: this.returnDeleteMarker || undefined,
        Body: this.getBodyFactory?.(Buffer.from(object.body))
          ?? Readable.from([object.body.subarray(0, 17), object.body.subarray(17)]),
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = this.key(command.input.Bucket, command.input.Key);
      const current = this.state.objects.get(key);
      if (!this.ignoreIfNoneMatch && command.input.IfNoneMatch === "*" && current) {
        throw serviceError(412);
      }
      if (this.falseAckNextPut) {
        this.falseAckNextPut = false;
        return {};
      }
      const body = Buffer.from(command.input.Body as Uint8Array);
      const stored = {
        body,
        etag: this.nextEtag(body),
        contentType: command.input.ContentType,
      };
      this.state.objects.set(key, stored);
      if (this.loseNextPutResponse) {
        this.loseNextPutResponse = false;
        throw Object.assign(new Error("private endpoint response loss"), { code: "ECONNRESET" });
      }
      return {
        ETag: stored.etag,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.state.objects.delete(this.key(command.input.Bucket, command.input.Key));
      return { VersionId: this.returnVersionId ? "unexpected-version" : undefined };
    }
    throw new Error(`unexpected S3 command ${String(command)}`);
  }
}

interface PreparedFixture {
  input: TenantTelemetryWriteAdapterInput;
  targets: TenantTelemetryLifecycleTargetRecord[];
}

async function preparedFixture(options: {
  tenantId?: string;
  statusCode?: number;
  artifactIdSha256?: string;
} = {}): Promise<PreparedFixture> {
  let nowMs = 1_000;
  const tenantId = options.tenantId ?? "s3-telemetry-tenant";
  const store = new MemorySessionStore(
    { now: () => nowMs },
    { tenantTelemetryRefKey: REF_KEY },
  );
  const activated = await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      ...s3TenantTelemetryTargetIdentity({
        namespaceId: NAMESPACE_ID,
        failureDomainId: FAILURE_DOMAIN_ID,
        bucket: BUCKET,
        prefix: PREFIX,
        region: REGION,
        endpoint: ENDPOINT,
        forcePathStyle: true,
        domain,
      }),
    })),
  });
  nowMs = 1_100;
  await store.createApiKey(tenantId, "s3-telemetry-key", "hash");
  await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: options.artifactIdSha256 ?? "5".repeat(64),
    artifactGeneration: 1,
    ownerKind: "tenant",
    ownerId: tenantId,
    ownerUserId: null,
    sourceSchema: "structured-log-batch-v1",
    sourceGeneration: 1,
    sourceHighWaterDbMs: nowMs,
    payload: {
      schema: TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
      domain: "logs",
      records: [trustedRunnerTelemetryRecord(nowMs, {
        opaqueRefKey: REF_KEY,
        ownerKind: "tenant",
        ownerValue: tenantId,
        statusCode: options.statusCode ?? 202,
      })],
    },
  });
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 10_000,
    claimToken: "s3-telemetry-claim",
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  });
  if (!claim) throw new Error("S3 telemetry fixture claim is missing");
  return {
    targets: activated.targets,
    input: {
      writeOperationSha256: claim.writeOperationSha256,
      target: claim.target,
      inventory: claim.inventory,
      payload: claim.payload,
    },
  };
}

const adapters: S3TenantTelemetryWriteAdapter[] = [];

afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
});

function adapter(
  client: FakeS3Client,
  targets: readonly TenantTelemetryLifecycleTargetRecord[],
  overrides: Partial<ConstructorParameters<typeof S3TenantTelemetryWriteAdapter>[0]> = {},
): S3TenantTelemetryWriteAdapter {
  const result = new S3TenantTelemetryWriteAdapter({
    privateBucketAcknowledged: true,
    bucket: BUCKET,
    prefix: PREFIX,
    namespaceId: NAMESPACE_ID,
    failureDomainId: FAILURE_DOMAIN_ID,
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    expectedTargets: targets,
    client: client as unknown as S3Client,
    ...overrides,
  });
  adapters.push(result);
  return result;
}

function artifactKey(input: TenantTelemetryWriteAdapterInput): string {
  return [
    PREFIX,
    "v1",
    input.inventory.domain,
    input.target.targetSha256.slice(0, 2),
    input.target.targetSha256,
    input.inventory.artifactIdSha256.slice(0, 2),
    input.inventory.artifactIdSha256,
    `${input.inventory.artifactGeneration}.astelm`,
  ].join("/");
}

describe("tenant telemetry S3 envelope", () => {
  it("round-trips deterministically and rejects truncation, concatenation, and corruption", () => {
    const encoded = encodeTenantTelemetryS3Envelope(
      JSON.stringify({ safe: true }),
      JSON.stringify({ records: [1] }),
    );
    expect(encoded.subarray(0, 8).toString("ascii")).toBe("ASTELM01");
    expect(decodeTenantTelemetryS3Envelope(encoded)).toEqual({
      metadataJson: '{"safe":true}',
      payloadJson: '{"records":[1]}',
    });
    expect(encodeTenantTelemetryS3Envelope(
      JSON.stringify({ safe: true }),
      JSON.stringify({ records: [1] }),
    )).toEqual(encoded);
    expect(() => decodeTenantTelemetryS3Envelope(encoded.subarray(0, -1)))
      .toThrow("length");
    expect(() => decodeTenantTelemetryS3Envelope(Buffer.concat([encoded, Buffer.from([0])])))
      .toThrow("length");
    const corrupt = Buffer.from(encoded);
    corrupt[TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES] =
      (corrupt[TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES] ?? 0) ^ 1;
    expect(() => decodeTenantTelemetryS3Envelope(corrupt)).toThrow("checksum");
  });
});

describe("S3TenantTelemetryWriteAdapter", () => {
  it("binds credential-free target identity to all physical configuration and domain fields", () => {
    const base = {
      namespaceId: NAMESPACE_ID,
      failureDomainId: FAILURE_DOMAIN_ID,
      bucket: BUCKET,
      prefix: PREFIX,
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
      domain: "logs" as const,
    };
    const identity = s3TenantTelemetryTargetIdentity(base);
    expect(identity).toMatchObject({
      backendKind: S3_TENANT_TELEMETRY_BACKEND_KIND,
      adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
      namespaceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      failureDomainSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    for (const changed of [
      { ...base, namespaceId: "other-namespace" },
      { ...base, failureDomainId: "other-domain" },
      { ...base, bucket: "other-telemetry-bucket" },
      { ...base, prefix: "telemetry-tests/other" },
      { ...base, region: "us-west-2" },
      { ...base, endpoint: null },
      { ...base, forcePathStyle: false },
      { ...base, domain: "traces" as const },
    ]) {
      expect(s3TenantTelemetryTargetIdentity(changed).namespaceSha256)
        .not.toBe(identity.namespaceSha256);
    }
    expect(() => s3TenantTelemetryTargetIdentity({
      ...base,
      endpoint: "https://secret:credential@example.invalid",
    })).toThrow("credential-free HTTPS origin");
    expect(() => s3TenantTelemetryTargetIdentity({
      ...base,
      endpoint: "http://s3.production.invalid",
    })).toThrow("HTTPS");
    expect(() => s3TenantTelemetryTargetIdentity({
      ...base,
      endpoint: "http://127.0.0.1:9000",
      allowInsecureHttpForLocalTest: true,
    })).not.toThrow();
  });

  it("publishes one create-only envelope and exposes exact cross-client replay", async () => {
    const prepared = await preparedFixture({ tenantId: "raw-tenant-must-not-appear" });
    const state = fakeState();
    const firstClient = new FakeS3Client(state);
    const secondClient = new FakeS3Client(state);
    const first = adapter(firstClient, prepared.targets);
    const second = adapter(secondClient, prepared.targets);

    await expect(first.inspectWrite(prepared.input)).resolves.toEqual({ status: "absent" });
    await expect(first.createWrite(prepared.input)).resolves.toMatchObject({
      outcome: "written",
      replayed: false,
    });
    await expect(second.inspectWrite(prepared.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    await expect(second.createWrite(prepared.input)).resolves.toMatchObject({
      outcome: "already_present",
      replayed: true,
    });
    const stored = state.objects.get(`${BUCKET}/${artifactKey(prepared.input)}`);
    expect(stored?.body.subarray(0, 8).toString("ascii")).toBe("ASTELM01");
    expect(stored?.contentType).toBe(TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    expect(stored?.body.toString("utf8")).not.toContain("raw-tenant-must-not-appear");
    const decoded = decodeTenantTelemetryS3Envelope(stored!.body);
    expect(JSON.parse(decoded.metadataJson)).toMatchObject({
      inventorySha256: prepared.input.inventory.inventorySha256,
      inventoryReceiptSha256: prepared.input.inventory.receiptSha256,
      manifestSha256: prepared.input.inventory.manifestSha256,
      payloadSha256: prepared.input.inventory.payloadSha256,
    });
    const puts = firstClient.commands.filter(
      (command): command is PutObjectCommand => command instanceof PutObjectCommand,
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]?.input.IfNoneMatch).toBe("*");
  });

  it("recovers a committed response loss and rejects a false success without durable bytes", async () => {
    const prepared = await preparedFixture();
    const lostClient = new FakeS3Client();
    lostClient.loseNextPutResponse = true;
    const lost = adapter(lostClient, prepared.targets);
    await expect(lost.createWrite(prepared.input)).resolves.toMatchObject({
      outcome: "already_present",
      replayed: true,
    });
    await expect(lost.inspectWrite(prepared.input)).resolves.toMatchObject({ status: "exact" });

    const falseClient = new FakeS3Client();
    falseClient.falseAckNextPut = true;
    const falseAck = adapter(falseClient, prepared.targets);
    await expect(falseAck.createWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    await expect(falseAck.inspectWrite(prepared.input)).resolves.toEqual({ status: "absent" });
  });

  it("linearizes concurrent exact creates and never overwrites an occupied artifact slot", async () => {
    const exact = await preparedFixture();
    const state = fakeState();
    const first = adapter(new FakeS3Client(state), exact.targets);
    const second = adapter(new FakeS3Client(state), exact.targets);
    const results = await Promise.all([
      first.createWrite(exact.input),
      second.createWrite(exact.input),
    ]);
    expect(results.map((result) => result.outcome).sort())
      .toEqual(["already_present", "written"]);

    const conflict = await preparedFixture({ statusCode: 503 });
    expect(conflict.input.writeOperationSha256).not.toBe(exact.input.writeOperationSha256);
    const original = Buffer.from(
      state.objects.get(`${BUCKET}/${artifactKey(exact.input)}`)!.body,
    );
    await expect(second.inspectWrite(conflict.input)).resolves.toEqual({ status: "conflict" });
    await expect(second.createWrite(conflict.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    expect(state.objects.get(`${BUCKET}/${artifactKey(exact.input)}`)?.body).toEqual(original);
  });

  it("fails closed on envelope corruption, content-type drift, VersionId, and DeleteMarker", async () => {
    const prepared = await preparedFixture();
    for (const mutation of ["bytes", "content-type", "version", "delete-marker"] as const) {
      const client = new FakeS3Client();
      const sink = adapter(client, prepared.targets);
      await sink.createWrite(prepared.input);
      const key = `${BUCKET}/${artifactKey(prepared.input)}`;
      const stored = client.state.objects.get(key)!;
      if (mutation === "bytes") {
        stored.body[stored.body.length - 1] =
          (stored.body[stored.body.length - 1] ?? 0) ^ 1;
      }
      if (mutation === "content-type") stored.contentType = "application/json";
      if (mutation === "version") client.returnVersionId = true;
      if (mutation === "delete-marker") client.returnDeleteMarker = true;
      if (mutation === "version" || mutation === "delete-marker") {
        await expect(sink.inspectWrite(prepared.input))
          .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
      } else {
        await expect(sink.inspectWrite(prepared.input)).resolves.toEqual({ status: "conflict" });
      }
    }
  });

  it("copies mutable streamed chunks before an iterator can reuse their backing buffer", async () => {
    const prepared = await preparedFixture();
    const client = new FakeS3Client();
    const sink = adapter(client, prepared.targets);
    await sink.createWrite(prepared.input);
    client.getBodyFactory = (body) => (async function* () {
      const reusable = Buffer.alloc(body.byteLength);
      body.copy(reusable);
      yield reusable;
      reusable.fill(0);
    })();

    await expect(sink.inspectWrite(prepared.input)).resolves.toMatchObject({ status: "exact" });
  });

  it("bounds response size and body time, and treats an ambiguous 404 as dependency failure", async () => {
    const prepared = await preparedFixture();
    const client = new FakeS3Client();
    const sink = adapter(client, prepared.targets, { requestTimeoutMs: 100 });
    await sink.createWrite(prepared.input);
    client.getContentLength = 1_000_000;
    await expect(sink.inspectWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    client.getContentLength = undefined;
    client.getBodyFactory = () => (async function* () {
      await new Promise<void>(() => undefined);
      yield Buffer.from("never");
    })();
    await expect(sink.inspectWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);

    const wrongBucket = new FakeS3Client();
    wrongBucket.rejectNext = serviceError(404, "NoSuchBucket");
    const unavailable = adapter(wrongBucket, prepared.targets);
    await expect(unavailable.inspectWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
  });

  it("shares one absolute deadline across pre-read, mutation, post-read, and body consumption", async () => {
    const prepared = await preparedFixture();
    const createClient = new FakeS3Client();
    createClient.delaysMs = [70, 70];
    const createSink = adapter(createClient, prepared.targets, { requestTimeoutMs: 100 });
    const createStarted = performance.now();
    await expect(createSink.createWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    expect(performance.now() - createStarted).toBeLessThan(500);
    expect(createClient.state.objects.size).toBe(0);

    const bodyClient = new FakeS3Client();
    const bodySink = adapter(bodyClient, prepared.targets, { requestTimeoutMs: 100 });
    await bodySink.createWrite(prepared.input);
    bodyClient.delaysMs = [70];
    bodyClient.getBodyFactory = (body) => (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 70));
      yield body;
    })();
    const bodyStarted = performance.now();
    await expect(bodySink.inspectWrite(prepared.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterTemporaryError);
    expect(performance.now() - bodyStarted).toBeLessThan(500);

    const startupClient = new FakeS3Client();
    startupClient.delaysMs = [30, 30, 30, 30];
    const startupSink = adapter(startupClient, prepared.targets, { requestTimeoutMs: 100 });
    const startupStarted = performance.now();
    await expect(startupSink.validateStartup()).rejects.toThrow("TimeoutError");
    expect(performance.now() - startupStarted).toBeLessThan(500);
    expect(startupClient.commands.some((command) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("preflights reachability, versioning, lifecycle, Object Lock, and real If-None-Match", async () => {
    const prepared = await preparedFixture();
    const client = new FakeS3Client();
    const sink = adapter(client, prepared.targets);
    await sink.validateStartup();
    expect(client.commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketVersioningCommand)).toBe(true);
    expect(client.commands.some(
      (command) => command instanceof GetBucketLifecycleConfigurationCommand,
    )).toBe(true);
    expect(client.commands.some(
      (command) => command instanceof GetObjectLockConfigurationCommand,
    )).toBe(true);
    expect(client.commands.some((command) => command instanceof HeadObjectCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
    expect([...client.state.objects.keys()].some((key) => key.includes("_agent_service_probe")))
      .toBe(false);

    for (const versioning of ["Enabled", "Suspended"] as const) {
      const invalid = new FakeS3Client();
      invalid.versioning = versioning;
      await expect(adapter(invalid, prepared.targets).validateStartup())
        .rejects.toThrow("versioning must be disabled");
      expect(invalid.commands.some((command) => command instanceof PutObjectCommand)).toBe(false);
    }
    const lifecycle = new FakeS3Client();
    lifecycle.lifecycleRules = [{ ID: "expire", Status: "Enabled" }];
    await expect(adapter(lifecycle, prepared.targets).validateStartup())
      .rejects.toThrow("lifecycle configuration must be absent");
    const locked = new FakeS3Client();
    locked.objectLockEnabled = true;
    await expect(adapter(locked, prepared.targets).validateStartup())
      .rejects.toThrow("Object Lock must be disabled");
    const ignored = new FakeS3Client();
    ignored.ignoreIfNoneMatch = true;
    await expect(adapter(ignored, prepared.targets).validateStartup())
      .rejects.toThrow("ignored If-None-Match");
  });

  it("bounds stalled SDK calls and never echoes endpoint, key, or credential details", async () => {
    const prepared = await preparedFixture();
    const timeoutClient = new FakeS3Client();
    timeoutClient.hangNextSend = true;
    await expect(adapter(timeoutClient, prepared.targets, { requestTimeoutMs: 100 }).validateStartup())
      .rejects.toThrow("TimeoutError");

    const denied = new FakeS3Client();
    denied.rejectNext = serviceError(403, "AccessDenied");
    let caught: unknown;
    try {
      await adapter(denied, prepared.targets).validateStartup();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toBe("S3 tenant telemetry startup reachability check failed (AccessDenied/403)");
    expect(message).not.toContain("credential");
    expect(message).not.toContain("private-key");
    expect(message).not.toContain(BUCKET);
    expect(message).not.toContain("example.invalid");
  });

  it("requires the exact target allowlist and private-bucket acknowledgement", async () => {
    const prepared = await preparedFixture();
    const client = new FakeS3Client();
    expect(() => new S3TenantTelemetryWriteAdapter({
      privateBucketAcknowledged: false as true,
      bucket: BUCKET,
      prefix: PREFIX,
      namespaceId: NAMESPACE_ID,
      failureDomainId: FAILURE_DOMAIN_ID,
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
      expectedTargets: prepared.targets,
      client: client as unknown as S3Client,
    })).toThrow("private-bucket acknowledgement");
    expect(() => adapter(client, prepared.targets, { namespaceId: "wrong-namespace" }))
      .toThrow("target configuration");
    expect(() => adapter(client, prepared.targets, { failureDomainId: "wrong-domain" }))
      .toThrow("target configuration");
    expect(() => adapter(client, prepared.targets.map((target) => ({
      ...target,
      adapterProtocol: "telemetry-http-v1",
    })))).toThrow("target configuration");
  });
});
