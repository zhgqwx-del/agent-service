import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand, GetBucketVersioningCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client, type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantTelemetryDispositionCorruptError } from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  buildFixtureTenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionRestoreLineageV3,
  type TenantTelemetryDispositionSourceV3,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3.js";
import {
  TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
  encodeTenantTelemetryDispositionV3Envelope,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-envelope.js";
import { S3TenantTelemetryDispositionJournalV3Fixture } from
  "../src/tenant-telemetry-disposition-adapter/journal-v3-s3-fixture.js";
import { S3TenantTelemetryDispositionJournalV3Observer } from
  "../src/tenant-telemetry-disposition-adapter/journal-v3-s3-observer.js";

const gate = process.env.AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION ?? "0";
if (gate !== "0" && gate !== "1") throw new Error("Invalid disposition S3 integration gate");
const enabled = gate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real v3 journal observer MinIO suite`);
  return value;
}

function endpointOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("S3_TEST_ENDPOINT must be an http(s) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  }
  return url.origin;
}

const endpoint = enabled ? endpointOrigin(required("S3_TEST_ENDPOINT")) : "http://127.0.0.1:9000";
const region = enabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = enabled ? required("S3_TELEMETRY_DISPOSITION_TEST_BUCKET") : "disabled-v3-observer";
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const pathStyle = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (pathStyle !== "0" && pathStyle !== "1") throw new Error("Invalid S3 path-style setting");
const runId = randomBytes(12).toString("hex");
const prefix = `telemetry-journal-v3-observer-tests/${runId}`;
const config: S3ClientConfig = {
  endpoint, region, forcePathStyle: pathStyle === "1",
  credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2,
};
const digest = (label: string) => createHash("sha256").update(label).digest("hex");

class RecordingReadClient {
  readonly inner = new S3Client(config);
  readonly names: string[] = [];
  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = command?.constructor?.name ?? "unknown";
    this.names.push(name);
    if (name !== "GetObjectCommand") throw new Error("v3 observer attempted non-GET S3 command");
    return this.inner.send(command as never, options);
  }
  destroy(): void { this.inner.destroy(); }
}

const fixtureClient = new S3Client(config);
const observerClient = new RecordingReadClient();
const cleanupClient = new S3Client(config);
const options = {
  independentFailureDomain: true as const,
  privateBucketAccessVerified: true as const,
  bucket, prefix, namespaceId: `observer-${runId}`,
  failureDomainId: `minio-${runId}`,
  logicalDatabaseNamespaceSha256: digest(`database-${runId}`),
  region, endpoint, forcePathStyle: pathStyle === "1", operationTimeoutMs: 30_000,
  maxEvents: 100,
};
const fixture = new S3TenantTelemetryDispositionJournalV3Fixture({
  ...options, nonProductionFixture: true, client: fixtureClient,
});
const observer = new S3TenantTelemetryDispositionJournalV3Observer({
  ...options, client: observerClient as unknown as S3Client,
});
const root = `${prefix}/targets-v3/${fixture.identity.journalTargetSha256}`;
const eventKey = (sequence: number) =>
  `${root}/events-v3/${String(sequence).padStart(16, "0")}`;

function source(index: number): TenantTelemetryDispositionSourceV3 {
  const value = (label: string) => digest(`${runId}-${index}-${label}`);
  return {
    tenantRefSha256: value("tenant"), domain: "logs", targetSha256: value("target"),
    artifactIdSha256: value("artifact"), artifactGeneration: 1,
    dispositionOperationSha256: value("operation"), subjectGeneration: 1,
    buildGeneration: 1, artifactGroupSha256: value("group"),
    catalogEntryReceiptSha256: value("catalog-entry"), catalogReceiptSha256: value("catalog"),
    sourceAccountingReceiptSha256: value("source"), targetManifestReceiptSha256: value("manifest"),
    ownerClosureReceiptSha256: value("closure"), databasePurgeReceiptSha256: value("t3f"),
    pregrantIntentSha256: value("intent"), pregrantClaimSha256: value("claim"),
  };
}

function restore(index: number): TenantTelemetryDispositionRestoreLineageV3 {
  return {
    runtimeEpochSha256: digest(`${runId}-${index}-epoch`),
    runtimeControlEvidenceSha256: digest(`${runId}-${index}-runtime`),
    backupCatalogControlEvidenceSha256: digest(`${runId}-${index}-catalog`),
    restoreRunSha256: null, restoreReplayReceiptSha256: null,
    backupReservationReceiptSha256: null,
  };
}

function authorization(index: number) {
  return {
    source: source(index), restore: restore(index),
    grantReceiptSha256: digest(`${runId}-${index}-grant`),
    claimAttempt: 1, claimTokenSha256: digest(`${runId}-${index}-claim-token`),
    grantedAtDbMs: 1_000, leaseUntilDbMs: 2_000,
  };
}

async function ownKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await cleanupClient.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key?.startsWith(`${prefix}/`)) throw new Error("v3 observer cleanup prefix escaped");
      keys.push(item.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) throw new Error("MinIO omitted continuation token");
  } while (token);
  return keys;
}

const describeMinio = enabled ? describe : describe.skip;

describeMinio("independent GET-only v3 journal observer on real MinIO", () => {
  beforeAll(async () => {
    expect(observer.identity).toEqual(fixture.identity);
    const versioning = await cleanupClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) throw new Error("v3 observer bucket must never enable versioning");
  }, 30_000);

  afterAll(async () => {
    try {
      while (true) {
        const keys = await ownKeys();
        if (keys.length === 0) break;
        for (let offset = 0; offset < keys.length; offset += 1_000) {
          const removed = await cleanupClient.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Quiet: true,
              Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })) },
          }));
          if ((removed.Errors?.length ?? 0) > 0) throw new Error("v3 observer cleanup failed");
        }
      }
    } finally {
      await observer.close(); await fixture.close();
      observerClient.destroy(); fixtureClient.destroy(); cleanupClient.destroy();
    }
  }, 30_000);

  it("does not initialize missing genesis or issue any non-GET command", async () => {
    await expect(observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(await ownKeys()).toEqual([]);
    expect(observerClient.names).toEqual(["GetObjectCommand"]);
  });

  it("cross-client observes a sealed authorization and terminal without producing authority", async () => {
    await fixture.initializeFixture();
    const authorized = await fixture.appendFixtureAuthorization(authorization(1));
    const terminal = await fixture.appendFixtureTerminal({
      dispositionOperationSha256: source(1).dispositionOperationSha256,
      sameKeyTombstoneReceiptSha256: digest("same-key-ack"),
      tombstoneMarkerSha256: digest("marker"), originalObjectEtagSha256: digest("etag"),
    });
    const observed = await observer.observeSealedChain();
    expect(observed.events).toEqual([authorized, terminal]);
    expect(observed.sealedHead.journalSequence).toBe(2);
    expect([observed.grantReady, observed.executionReady, observed.externalAuthorityVerified,
      observed.restoreFenceVerified, observed.physicalAck])
      .toEqual([false, false, false, false, false]);
    expect(new Set(observerClient.names)).toEqual(new Set(["GetObjectCommand"]));
  }, 30_000);

  it("rejects pending event until fixture CAS-seals it; observation never mutates", async () => {
    const head = (await observer.observeSealedChain()).sealedHead;
    const input = authorization(2);
    const pending = buildFixtureTenantTelemetryDispositionEventV3({
      identity: fixture.identity, ...input, terminal: null, head,
      nonProductionFixture: true,
    });
    await cleanupClient.send(new PutObjectCommand({
      Bucket: bucket, Key: eventKey(3), IfNoneMatch: "*",
      ContentType: TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
      Body: encodeTenantTelemetryDispositionV3Envelope("event", canonicalJson(pending)),
    }));
    const before = await ownKeys();
    await expect(observer.observeSealedChain()).rejects
      .toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(await ownKeys()).toEqual(before);
    expect(await fixture.appendFixtureAuthorization(input)).toEqual(pending);
    expect((await observer.observeSealedChain()).sealedHead.journalSequence).toBe(3);
    expect(observerClient.names.every((name) => name === "GetObjectCommand")).toBe(true);
  }, 30_000);
});
