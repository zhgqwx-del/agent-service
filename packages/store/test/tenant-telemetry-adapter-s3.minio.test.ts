import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  S3TenantTelemetryWriteAdapter,
  TENANT_TELEMETRY_ARTIFACT_PAYLOAD_SCHEMA,
  TenantTelemetryWriteAdapterConflictError,
  s3TenantTelemetryTargetIdentity,
  type TenantTelemetryLifecycleTargetRecord,
  type TenantTelemetryWriteAdapterInput,
} from "../src/index.js";
import { tenantTelemetryDispositionOperationSha256 } from "../src/tenant-telemetry-disposition.js";
import { MemoryTenantTelemetryDispositionAdapter } from "../src/tenant-telemetry-disposition-adapter/memory.js";
import { TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE } from "../src/tenant-telemetry-adapter/s3-tombstone-codec.js";
import { trustedRunnerTelemetryRecord } from "./tenant-telemetry-adapter.fixture.js";

const integrationGate = process.env.AGENT_SERVICE_TENANT_TELEMETRY_S3_INTEGRATION ?? "0";
if (integrationGate !== "0" && integrationGate !== "1") {
  throw new Error("AGENT_SERVICE_TENANT_TELEMETRY_S3_INTEGRATION must be 0 or 1");
}
const integrationEnabled = integrationGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real tenant telemetry MinIO suite`);
  return value;
}

function testEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  }
  if (endpoint.protocol === "http:"
    && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("the tenant telemetry MinIO HTTP endpoint must be loopback-only");
  }
  return endpoint;
}

const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled
  ? required("S3_TENANT_TELEMETRY_TEST_BUCKET")
  : "disabled-tenant-telemetry-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `tenant-telemetry-tests/${runId}`;
const namespaceId = `minio-tenant-telemetry-${runId}`;
const failureDomainId = `local-minio-${runId}`;
const refKey = new Uint8Array(32).fill(43);

const clientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};
const firstClient = new S3Client(clientConfig);
const secondClient = new S3Client(clientConfig);
const firstAdapters: S3TenantTelemetryWriteAdapter[] = [];

function identityOptions(domain: "logs" | "traces") {
  return {
    namespaceId,
    failureDomainId,
    bucket,
    prefix,
    region,
    endpoint: endpoint.origin,
    forcePathStyle,
    domain,
    ...(endpoint.protocol === "http:"
      ? { allowInsecureHttpForLocalTest: true as const }
      : {}),
  };
}

async function preparedFixture(statusCode: number): Promise<{
  targets: TenantTelemetryLifecycleTargetRecord[];
  input: TenantTelemetryWriteAdapterInput;
}> {
  let nowMs = 1_000;
  const tenantId = "raw-real-minio-tenant-must-not-appear";
  const store = new MemorySessionStore(
    { now: () => nowMs },
    { tenantTelemetryRefKey: refKey },
  );
  const activated = await store.activateTenantTelemetryLifecycle({
    expectedControlGeneration: 0,
    targets: (["logs", "traces"] as const).map((domain) => ({
      domain,
      ...s3TenantTelemetryTargetIdentity(identityOptions(domain)),
    })),
  });
  nowMs = 1_100;
  await store.createApiKey(tenantId, "minio-telemetry-key", "hash");
  await store.enqueueTenantTelemetryArtifact({
    tenantId,
    expectedControlGeneration: 1,
    domain: "logs",
    artifactIdSha256: "5".repeat(64),
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
        opaqueRefKey: refKey,
        ownerKind: "tenant",
        ownerValue: tenantId,
        statusCode,
      })],
    },
  });
  const [claim] = await store.claimTenantTelemetryWriteJobs({
    limit: 1,
    leaseMs: 10_000,
    claimToken: "minio-telemetry-claim",
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  });
  if (!claim) throw new Error("real MinIO tenant telemetry claim is missing");
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

function adapter(
  client: S3Client,
  targets: readonly TenantTelemetryLifecycleTargetRecord[],
  nonProductionDispositionFixture = false,
): S3TenantTelemetryWriteAdapter {
  const result = new S3TenantTelemetryWriteAdapter({
    privateBucketAcknowledged: true,
    bucket,
    prefix,
    namespaceId,
    failureDomainId,
    region,
    endpoint: endpoint.origin,
    forcePathStyle,
    expectedTargets: targets,
    client,
    ...(nonProductionDispositionFixture
      ? { nonProductionDispositionFixture: true as const }
      : {}),
    ...(endpoint.protocol === "http:"
      ? { allowInsecureHttpForLocalTest: true as const }
      : {}),
  });
  firstAdapters.push(result);
  return result;
}

function artifactKey(input: TenantTelemetryWriteAdapterInput): string {
  return [
    prefix,
    "v1",
    input.inventory.domain,
    input.target.targetSha256.slice(0, 2),
    input.target.targetSha256,
    input.inventory.artifactIdSha256.slice(0, 2),
    input.inventory.artifactIdSha256,
    `${input.inventory.artifactGeneration}.astelm`,
  ].join("/");
}

function anonymousObjectUrl(key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (forcePathStyle) {
    return new URL(`${encodeURIComponent(bucket)}/${encodedKey}`, `${endpoint.origin}/`).href;
  }
  const url = new URL(endpoint.origin);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = `/${encodedKey}`;
  return url.href;
}

async function readBody(body: unknown): Promise<Buffer> {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
    !== "function") {
    throw new Error("real MinIO telemetry object body is not an async byte stream");
  }
  const chunks: Buffer[] = [];
  for await (const value of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks);
}

async function listPrefix(): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await firstClient.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(`${prefix}/`)) {
        throw new Error("tenant telemetry test cleanup escaped its isolated prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("tenant telemetry test cleanup omitted its continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(): Promise<void> {
  while (true) {
    const keys = await listPrefix();
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const result = await firstClient.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Quiet: true,
          Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })),
        },
      }));
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error("tenant telemetry test cleanup reported an object error");
      }
    }
  }
}

const describeMinio = integrationEnabled ? describe : describe.skip;

describeMinio("S3TenantTelemetryWriteAdapter real MinIO contract", () => {
  let exact: Awaited<ReturnType<typeof preparedFixture>>;
  let first: S3TenantTelemetryWriteAdapter;
  let second: S3TenantTelemetryWriteAdapter;

  beforeAll(async () => {
    exact = await preparedFixture(202);
    first = adapter(firstClient, exact.targets);
    second = adapter(secondClient, exact.targets);
    await first.validateStartup();
    await second.validateStartup();
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanupPrefix();
    } finally {
      await Promise.allSettled(firstAdapters.map((value) => value.close()));
      firstClient.destroy();
      secondClient.destroy();
    }
  }, 30_000);

  it("makes create-only writes immediately visible and exactly replayable across clients", async () => {
    const results = await Promise.all([
      first.createWrite(exact.input),
      second.createWrite(exact.input),
    ]);
    expect(results.map((result) => result.outcome).sort())
      .toEqual(["already_present", "written"]);
    await expect(first.inspectWrite(exact.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
    await expect(second.inspectWrite(exact.input)).resolves.toMatchObject({
      status: "exact",
      result: { outcome: "already_present", replayed: true },
    });
  });

  it("does not overwrite a conflicting immutable artifact slot", async () => {
    const conflict = await preparedFixture(503);
    const key = artifactKey(exact.input);
    const before = await readBody((await firstClient.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }))).Body);
    await expect(second.inspectWrite(conflict.input)).resolves.toEqual({ status: "conflict" });
    await expect(second.createWrite(conflict.input))
      .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    const after = await readBody((await secondClient.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }))).Body);
    expect(after).toEqual(before);
  });

  it("stores a closed envelope without the raw tenant identifier", async () => {
    const output = await firstClient.send(new GetObjectCommand({
      Bucket: bucket,
      Key: artifactKey(exact.input),
    }));
    expect(output.ContentType).toBe(
      "application/vnd.agent-service.telemetry-artifact-v1",
    );
    const bytes = await readBody(output.Body);
    expect(bytes.subarray(0, 8).toString("ascii")).toBe("ASTELM01");
    expect(bytes.toString("utf8")).not.toContain("raw-real-minio-tenant-must-not-appear");
  });

  it("does not expose a telemetry artifact to an anonymous raw GET", async () => {
    const response = await fetch(anonymousObjectUrl(artifactKey(exact.input)), {
      method: "GET",
      redirect: "manual",
    });
    await response.body?.cancel();
    expect([401, 403]).toContain(response.status);
  });

  it("CAS-tombstones at the same key and exactly replays the original ACK across real clients", async () => {
    await first.createWrite(exact.input);
    const dispositionFirst = adapter(firstClient, exact.targets, true);
    const dispositionSecond = adapter(secondClient, exact.targets, true);
    await dispositionFirst.validateDispositionStartup();
    await dispositionSecond.validateDispositionStartup();
    const digest = (label: string) => createHash("sha256").update(label).digest("hex");
    const source = {
      domain: exact.input.inventory.domain,
      targetSha256: exact.input.target.targetSha256,
      artifactIdSha256: exact.input.inventory.artifactIdSha256,
      artifactGeneration: exact.input.inventory.artifactGeneration,
      inventorySha256: exact.input.inventory.inventorySha256,
      inventoryReceiptSha256: exact.input.inventory.receiptSha256,
      writeOperationSha256: exact.input.writeOperationSha256,
      writeAckReceiptSha256: digest("durable-minio-write-ack"),
      payloadSha256: exact.input.inventory.payloadSha256,
      manifestSha256: exact.input.inventory.manifestSha256,
      lifecycleCoverageEvidenceSha256: exact.input.inventory.coverageEvidenceSha256,
      applicationCoverageEvidenceSha256: null,
      applicationWriteBindingReceiptSha256: null,
      t3cReceiptSha256: digest("minio-t3c"),
      t3dPlanReceiptSha256: digest("minio-t3d-plan"),
      t3dPlanEntryReceiptSha256: digest("minio-t3d-entry"),
    };
    const journal = new MemoryTenantTelemetryDispositionAdapter({
      nonProductionFixture: true,
      namespaceId: `minio-journal-${runId}`,
      targetId: `minio-journal-target-${runId}`,
      failureDomainId: `minio-journal-domain-${runId}`,
      logicalDatabaseNamespaceSha256: digest(`logical-db-${runId}`),
    });
    try {
      const proof = await journal.authorizeDeletion({
        ...source,
        dispositionOperationSha256: tenantTelemetryDispositionOperationSha256(source),
      });
      const firstAck = await dispositionFirst.tombstoneAuthorized(proof, journal);
      const secondAck = await dispositionSecond.tombstoneAuthorized(proof, journal);
      expect(secondAck).toEqual(firstAck);
      const object = await secondClient.send(new GetObjectCommand({
        Bucket: bucket,
        Key: artifactKey(exact.input),
      }));
      expect(object.ContentType).toBe(TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE);
      const bytes = await readBody(object.Body);
      expect(bytes.subarray(0, 8).toString("ascii")).toBe("ASTOMB01");
      expect(bytes.toString("utf8")).not.toContain("raw-real-minio-tenant-must-not-appear");
      await expect(first.createWrite(exact.input))
        .rejects.toBeInstanceOf(TenantTelemetryWriteAdapterConflictError);
    } finally {
      await journal.close();
    }
  }, 30_000);
});
