import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  S3TenantTelemetryArtifactObserver,
  S3TenantTelemetryArtifactObservationConflictError,
  type TenantTelemetryS3ArtifactObservationInput,
} from "../src/tenant-telemetry-adapter/s3-artifact-observer.js";
import {
  S3TenantTelemetryWriteAdapter,
  tenantTelemetryS3ArtifactObjectKey,
} from "../src/tenant-telemetry-adapter/s3.js";
import { TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE } from "../src/tenant-telemetry-adapter/s3-codec.js";
import { TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE } from "../src/tenant-telemetry-adapter/s3-tombstone-codec.js";
import {
  artifactObserverDataBytes,
  artifactObserverFixture,
  artifactObserverMarkerBytes,
} from "./tenant-telemetry-artifact-observer.fixture.js";

const gate = process.env.AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION ?? "0";
if (gate !== "0" && gate !== "1") throw new Error("tenant telemetry MinIO gate must be 0 or 1");
const enabled = gate === "1";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the artifact observer MinIO suite`);
  return value;
}
function endpointValue(): string {
  const raw = enabled ? required("S3_TEST_ENDPOINT") : "http://127.0.0.1:9000";
  const endpoint = new URL(raw);
  if (!["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")
    || (endpoint.protocol === "http:"
      && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname))) {
    throw new Error("artifact observer MinIO endpoint must be a credential-free local origin");
  }
  return endpoint.origin;
}
const endpoint = endpointValue();
const region = enabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = enabled
  ? required("S3_TELEMETRY_DISPOSITION_TEST_BUCKET")
  : "disabled-artifact-observer-integration";
const artifactBucket = enabled
  ? required("S3_TENANT_TELEMETRY_TEST_BUCKET")
  : "disabled-telemetry-artifact-integration";
if (enabled && artifactBucket === bucket) {
  throw new Error("artifact writer and disposition fixture buckets must differ");
}
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const config = {
  bucket,
  prefix: `telemetry-artifact-observer-tests/${runId}`,
  namespaceId: `artifact-observer-${runId}`,
  failureDomainId: `local-minio-${runId}`,
  region,
  endpoint,
  forcePathStyle,
};
const artifactConfig = {
  ...config,
  bucket: artifactBucket,
  prefix: `telemetry-writer-observer-tests/${runId}`,
  namespaceId: `writer-observer-${runId}`,
};
const clientConfig: S3ClientConfig = {
  endpoint,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};
const fixtureClient = new S3Client(clientConfig);
const firstInner = new S3Client(clientConfig);
const secondInner = new S3Client(clientConfig);
const authorizationReceiptSha256 = "a".repeat(64);
const keys = new Set<string>();
const artifactKeys = new Set<string>();

class ReadOnlyRecordingClient {
  readonly commands: string[] = [];
  constructor(private readonly inner: S3Client) {}
  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = command?.constructor?.name ?? "unknown";
    this.commands.push(name);
    if (name !== "GetObjectCommand") throw new Error("observer used a non-GET command");
    return this.inner.send(command as never, options);
  }
}
const firstClient = new ReadOnlyRecordingClient(firstInner);
const secondClient = new ReadOnlyRecordingClient(secondInner);

async function prepared(artifactIdSha256: string, tenantId = "private-minio-observer-tenant") {
  const { input, evidence } = await artifactObserverFixture({
    ...config, artifactIdSha256, tenantId,
  });
  const observationInput: TenantTelemetryS3ArtifactObservationInput = {
    inventory: input.inventory,
    dispositionEvidence: evidence,
    expectedAuthorizationReceiptSha256: authorizationReceiptSha256,
  };
  const key = tenantTelemetryS3ArtifactObjectKey(config.prefix, {
    domain: input.inventory.domain,
    targetSha256: input.target.targetSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
  });
  keys.add(key);
  const first = new S3TenantTelemetryArtifactObserver({
    ...config,
    domain: "logs",
    expectedTarget: input.target,
    privateBucketAccessVerified: true,
    allowInsecureHttpForLocalTest: true,
    client: firstClient as unknown as S3Client,
  });
  const second = new S3TenantTelemetryArtifactObserver({
    ...config,
    domain: "logs",
    expectedTarget: input.target,
    privateBucketAccessVerified: true,
    allowInsecureHttpForLocalTest: true,
    client: secondClient as unknown as S3Client,
  });
  return { input, evidence, observationInput, key, first, second };
}

async function fixturePut(key: string, body: Buffer, contentType: string): Promise<void> {
  await fixtureClient.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: contentType,
  }));
}

const describeMinio = enabled ? describe : describe.skip;
describeMinio("0046 GET-only artifact observer real MinIO", () => {
  beforeAll(async () => {
    for (const selectedBucket of [bucket, artifactBucket]) {
      const versioning = await fixtureClient.send(new GetBucketVersioningCommand({
        Bucket: selectedBucket,
      }));
      if (versioning.Status !== undefined || versioning.MFADelete !== undefined) {
        throw new Error("artifact observer MinIO buckets must never have enabled versioning");
      }
    }
  }, 30_000);

  afterAll(async () => {
    try {
      for (const key of keys) {
        await fixtureClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      }
      for (const key of artifactKeys) {
        await fixtureClient.send(new DeleteObjectCommand({
          Bucket: artifactBucket, Key: key,
        }));
      }
    } finally {
      fixtureClient.destroy();
      firstInner.destroy();
      secondInner.destroy();
    }
  }, 30_000);

  it("observes exact data across independent clients with GET only", async () => {
    const f = await prepared("1".repeat(64));
    await fixturePut(f.key, artifactObserverDataBytes(f.input), TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    expect(await f.first.observe(f.observationInput)).toMatchObject({
      status: "exact_data", grantReady: false, physicalAck: false,
    });
    expect(await f.second.observe(f.observationInput)).toMatchObject({
      status: "exact_data", externalAuthorityVerified: false, restoreFenceVerified: false,
    });
    expect(firstClient.commands).toEqual(["GetObjectCommand", "GetObjectCommand"]);
    expect(secondClient.commands).toEqual(["GetObjectCommand", "GetObjectCommand"]);
    await f.first.close();
    await f.second.close();
  });

  it("reads an actual managed writer object from the separate artifact bucket", async () => {
    const { input, evidence } = await artifactObserverFixture({
      ...artifactConfig,
      artifactIdSha256: "4".repeat(64),
    });
    const key = tenantTelemetryS3ArtifactObjectKey(artifactConfig.prefix, {
      domain: input.inventory.domain,
      targetSha256: input.target.targetSha256,
      artifactIdSha256: input.inventory.artifactIdSha256,
      artifactGeneration: input.inventory.artifactGeneration,
    });
    artifactKeys.add(key);
    const writer = new S3TenantTelemetryWriteAdapter({
      ...artifactConfig,
      privateBucketAcknowledged: true,
      expectedTargets: [input.target],
      allowInsecureHttpForLocalTest: true,
      client: fixtureClient,
    });
    const observer = new S3TenantTelemetryArtifactObserver({
      ...artifactConfig,
      domain: "logs",
      expectedTarget: input.target,
      privateBucketAccessVerified: true,
      allowInsecureHttpForLocalTest: true,
      client: firstClient as unknown as S3Client,
    });
    try {
      await writer.validateStartup();
      expect((await writer.createWrite(input)).outcome).toBe("written");
      const result = await observer.observe({
        inventory: input.inventory,
        dispositionEvidence: evidence,
        expectedAuthorizationReceiptSha256: null,
      });
      expect(result).toMatchObject({
        status: "exact_data", grantReady: false, physicalAck: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/private-tenant|records/);
      expect(firstClient.commands.every((name) => name === "GetObjectCommand")).toBe(true);
    } finally {
      await observer.close();
      await writer.close();
    }
  });

  it("observes an exact same-key marker but never emits physical ACK or authority", async () => {
    const f = await prepared("2".repeat(64));
    await fixturePut(f.key, artifactObserverDataBytes(f.input), TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    await fixturePut(f.key, artifactObserverMarkerBytes(f.evidence, authorizationReceiptSha256),
      TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE);
    const result = await f.second.observe(f.observationInput);
    expect(result).toMatchObject({
      status: "matching_tombstone", grantReady: false, physicalAck: false,
      externalAuthorityVerified: false, restoreFenceVerified: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-minio|original-etag|records/);
    await expect(f.first.observe({
      ...f.observationInput, expectedAuthorizationReceiptSha256: "b".repeat(64),
    })).rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    await f.first.close();
    await f.second.close();
  });

  it("keeps absent slots unknown and rejects cross-tenant or tampered bytes", async () => {
    const f = await prepared("3".repeat(64));
    expect(await f.first.observe(f.observationInput)).toMatchObject({
      status: "unknown", physicalAck: false,
    });
    await fixturePut(f.key, artifactObserverDataBytes(f.input), TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    const foreign = await artifactObserverFixture({
      ...config,
      artifactIdSha256: "3".repeat(64),
      tenantId: "foreign-minio-observer-tenant",
    });
    await expect(f.second.observe({
      inventory: foreign.input.inventory,
      dispositionEvidence: foreign.evidence,
      expectedAuthorizationReceiptSha256: authorizationReceiptSha256,
    })).rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    const corrupt = artifactObserverDataBytes(f.input);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await fixturePut(f.key, corrupt, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    await expect(f.first.observe(f.observationInput))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    expect([...firstClient.commands, ...secondClient.commands]
      .every((name) => name === "GetObjectCommand")).toBe(true);
    await f.first.close();
    await f.second.close();
  });
});
