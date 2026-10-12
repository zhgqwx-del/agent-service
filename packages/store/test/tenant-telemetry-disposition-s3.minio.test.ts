import { randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256,
} from "../src/tenant-telemetry-disposition.js";
import {
  S3TenantTelemetryDispositionAdapter,
} from "../src/tenant-telemetry-disposition-adapter/s3.js";
import { dispositionDigest, dispositionEvidence, tombstoneAck } from "./tenant-telemetry-disposition.fixture.js";

const integrationGate = process.env.AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION ?? "0";
if (integrationGate !== "0" && integrationGate !== "1") {
  throw new Error("AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION must be 0 or 1");
}
const integrationEnabled = integrationGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real telemetry-disposition MinIO suite`);
  return value;
}

function testEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  }
  return endpoint;
}

const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled
  ? required("S3_TELEMETRY_DISPOSITION_TEST_BUCKET")
  : "disabled-telemetry-disposition-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `telemetry-disposition-tests/${runId}`;
const cleanupPrefixes = new Set([prefix]);
const logicalDatabaseNamespaceSha256 = dispositionDigest(`minio-logical-database-${runId}`);

const clientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};

class RecordingS3Client {
  readonly commandNames: string[] = [];
  readonly inner = new S3Client(clientConfig);

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.commandNames.push(command?.constructor?.name ?? "unknown");
    return this.inner.send(command as never, options);
  }

  destroy(): void {
    this.inner.destroy();
  }
}

const firstClient = new RecordingS3Client();
const secondClient = new RecordingS3Client();
const cleanupClient = new S3Client(clientConfig);
const common = {
  independentFailureDomain: true as const,
  privateBucketAccessVerified: true as const,
  nonProductionMutationFixture: true as const,
  bucket,
  prefix,
  namespaceId: `minio-telemetry-disposition-${runId}`,
  failureDomainId: `minio-local-${runId}`,
  logicalDatabaseNamespaceSha256,
  region,
  endpoint: endpoint.origin,
  forcePathStyle,
  operationTimeoutMs: 30_000,
  maxMutationAttempts: 256,
};
const first = new S3TenantTelemetryDispositionAdapter({
  ...common,
  client: firstClient as unknown as S3Client,
});
const second = new S3TenantTelemetryDispositionAdapter({
  ...common,
  client: secondClient as unknown as S3Client,
});

async function listPrefix(selectedPrefix: string): Promise<string[]> {
  const expectedPrefix = `${selectedPrefix}/`;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await cleanupClient.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: expectedPrefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(expectedPrefix)) {
        throw new Error("telemetry disposition cleanup listing escaped its prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("telemetry disposition cleanup listing omitted continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(selectedPrefix: string): Promise<void> {
  if (!cleanupPrefixes.has(selectedPrefix)) {
    throw new Error("refusing to clean an unrelated telemetry disposition prefix");
  }
  while (true) {
    const keys = await listPrefix(selectedPrefix);
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await cleanupClient.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
      }));
      if ((result.Errors?.length ?? 0) > 0) {
        throw new Error("telemetry disposition cleanup reported an object error");
      }
    }
  }
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

const describeMinio = integrationEnabled ? describe : describe.skip;

describeMinio("S3TenantTelemetryDispositionAdapter real MinIO contract", () => {
  beforeAll(async () => {
    const versioning = await cleanupClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) {
      throw new Error("telemetry disposition MinIO bucket must never have enabled versioning");
    }
    await first.validateStartup();
    await second.validateStartup();
  }, 60_000);

  afterAll(async () => {
    try {
      await cleanupPrefix(prefix);
    } finally {
      await first.close();
      await second.close();
      cleanupClient.destroy();
    }
  }, 30_000);

  it("serializes two clients through create-only events and a CAS authority head", async () => {
    const evidence = Array.from({ length: 8 }, (_, index) => dispositionEvidence(index + 100));
    const settled = await Promise.allSettled(evidence.map((item, index) => (
      (index % 2 === 0 ? first : second).authorizeDeletion(item)
    )));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
    const authorizations = settled.map((result) => {
      if (result.status !== "fulfilled") throw new Error("unreachable rejected authorization");
      return result.value;
    });
    expect(new Set(authorizations.map((value) => value.journalSequence)).size)
      .toBe(evidence.length);
    const head = await first.readHead();
    expect(head.journalSequence).toBe(evidence.length);
    expect(await second.readHead()).toEqual(head);
    const keys = await listPrefix(prefix);
    expect(keys).toContain(
      `${prefix}/targets/${first.journalTargetSha256}/authority/head-v1`,
    );
    expect(keys.filter((key) => key.includes("/events/"))).toHaveLength(evidence.length);
    expect([...firstClient.commandNames, ...secondClient.commandNames]
      .some((name) => name.includes("List") || name.includes("Delete"))).toBe(false);
  }, 60_000);

  it("records a terminal marker event and reconstructs the permanent identity from a sealed scan", async () => {
    const authorization = await first.authorizeDeletion(dispositionEvidence(200));
    const terminal = await second.recordTombstone(tombstoneAck(authorization));
    const sealedHead = await first.readHead();
    let afterJournalSequence = 0;
    let afterJournalEventRootSha256 =
      EMPTY_TENANT_TELEMETRY_DISPOSITION_EVENT_ROOT_SHA256;
    const events = [];
    while (true) {
      const page = await second.scanEvents({
        afterJournalSequence,
        afterJournalEventRootSha256,
        sealedHead,
        limit: 3,
      });
      events.push(...page.events);
      afterJournalSequence = page.nextJournalSequence;
      afterJournalEventRootSha256 = page.nextJournalEventRootSha256;
      if (page.complete) break;
    }
    const restored = events.find((event) => event.eventType === "delete_tombstoned"
      && event.result.terminalReceiptSha256 === terminal.terminalReceiptSha256);
    expect(restored?.eventType).toBe("delete_tombstoned");
    if (restored?.eventType !== "delete_tombstoned") throw new Error("missing terminal event");
    expect(restored.result.authorization).toMatchObject({
      targetSha256: authorization.targetSha256,
      artifactIdSha256: authorization.artifactIdSha256,
      artifactGeneration: authorization.artifactGeneration,
    });
    expect(JSON.stringify(restored)).not.toMatch(/tenantId|requestId|ownerRef|https?:\/\//);
  }, 30_000);

  it("is not anonymously readable", async () => {
    const keys = await listPrefix(prefix);
    const eventKey = keys.find((key) => key.includes("/events/"));
    if (!eventKey) throw new Error("missing telemetry disposition event object");
    const response = await fetch(anonymousObjectUrl(eventKey), { redirect: "manual" });
    expect(response.ok).toBe(false);
  }, 15_000);
});
