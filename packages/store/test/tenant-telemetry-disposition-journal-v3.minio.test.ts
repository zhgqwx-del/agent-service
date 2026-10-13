import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand, GetBucketVersioningCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client, type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TenantTelemetryDispositionConflictError, TenantTelemetryDispositionCorruptError,
} from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  buildFixtureTenantTelemetryDispositionEventV3,
  headAfterTenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionRestoreLineageV3,
  type TenantTelemetryDispositionSourceV3,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3.js";
import {
  TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
  encodeTenantTelemetryDispositionV3Envelope,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-envelope.js";
import {
  S3TenantTelemetryDispositionJournalV3Fixture,
} from "../src/tenant-telemetry-disposition-adapter/journal-v3-s3-fixture.js";

const gate = process.env.AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION ?? "0";
if (gate !== "0" && gate !== "1") throw new Error("Invalid disposition S3 integration gate");
const enabled = gate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real v3 journal MinIO suite`);
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
const bucket = enabled ? required("S3_TELEMETRY_DISPOSITION_TEST_BUCKET") : "disabled-disposition-v3";
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const pathStyle = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (pathStyle !== "0" && pathStyle !== "1") throw new Error("Invalid S3 path-style setting");
const runId = randomBytes(12).toString("hex");
const prefix = `telemetry-journal-v3-tests/${runId}`;
const config: S3ClientConfig = {
  endpoint, region, forcePathStyle: pathStyle === "1",
  credentials: { accessKeyId, secretAccessKey }, maxAttempts: 2,
};
const digest = (label: string) => createHash("sha256").update(label).digest("hex");

class RecordingClient {
  readonly inner = new S3Client(config);
  readonly names: string[] = [];
  loseNextEventResponse = false;
  loseNextHeadResponse = false;

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    const name = command?.constructor?.name ?? "unknown";
    this.names.push(name);
    const result = await this.inner.send(command as never, options);
    if (name === "PutObjectCommand") {
      const key = String((command as { input: { Key?: string } }).input.Key ?? "");
      if (key.includes("/events-v3/") && this.loseNextEventResponse) {
        this.loseNextEventResponse = false;
        throw new Error("simulated response loss");
      }
      if (key.endsWith("/authority/head-v3") && this.loseNextHeadResponse) {
        this.loseNextHeadResponse = false;
        throw new Error("simulated response loss");
      }
    }
    return result;
  }

  destroy(): void { this.inner.destroy(); }
}

const cleanupClient = new S3Client(config);
const firstClient = new RecordingClient();
const secondClient = new RecordingClient();
const options = {
  nonProductionFixture: true as const,
  independentFailureDomain: true as const,
  privateBucketAccessVerified: true as const,
  bucket, prefix, namespaceId: `v3-${runId}`, failureDomainId: `minio-${runId}`,
  logicalDatabaseNamespaceSha256: digest(`database-${runId}`),
  region, endpoint, forcePathStyle: pathStyle === "1", operationTimeoutMs: 30_000,
  maxEvents: 100,
};
const first = new S3TenantTelemetryDispositionJournalV3Fixture({
  ...options, client: firstClient as unknown as S3Client,
});
const second = new S3TenantTelemetryDispositionJournalV3Fixture({
  ...options, client: secondClient as unknown as S3Client,
});
const headKey = `${prefix}/targets-v3/${first.identity.journalTargetSha256}/authority/head-v3`;
const eventKey = (sequence: number) =>
  `${prefix}/targets-v3/${first.identity.journalTargetSha256}/events-v3/${String(sequence).padStart(16, "0")}`;

function source(index: number): TenantTelemetryDispositionSourceV3 {
  const value = (label: string) => digest(`${runId}-${index}-${label}`);
  return {
    tenantRefSha256: value("tenant"), domain: index % 2 === 0 ? "traces" : "logs",
    targetSha256: value("target"), artifactIdSha256: value("artifact"),
    artifactGeneration: 1, dispositionOperationSha256: value("operation"),
    subjectGeneration: 1, buildGeneration: 1,
    artifactGroupSha256: value("group"), catalogEntryReceiptSha256: value("entry"),
    catalogReceiptSha256: value("catalog"), sourceAccountingReceiptSha256: value("source"),
    targetManifestReceiptSha256: value("manifest"), ownerClosureReceiptSha256: value("closure"),
    databasePurgeReceiptSha256: value("purge"), pregrantIntentSha256: value("intent"),
    pregrantClaimSha256: value("claim"),
  };
}

function restore(index: number): TenantTelemetryDispositionRestoreLineageV3 {
  return {
    runtimeEpochSha256: digest(`${runId}-${index}-epoch`),
    runtimeControlEvidenceSha256: digest(`${runId}-${index}-runtime`),
    backupCatalogControlEvidenceSha256: digest(`${runId}-${index}-backup`),
    restoreRunSha256: null, restoreReplayReceiptSha256: null,
    backupReservationReceiptSha256: null,
  };
}

function authorization(index: number) {
  return {
    source: source(index), restore: restore(index),
    grantReceiptSha256: digest(`${runId}-${index}-grant`), claimAttempt: 1,
    claimTokenSha256: digest(`${runId}-${index}-token`), grantedAtDbMs: 1_000,
    leaseUntilDbMs: 2_000,
  };
}

async function listOwnKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await cleanupClient.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token,
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key?.startsWith(`${prefix}/`)) throw new Error("v3 cleanup prefix escaped");
      keys.push(item.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) throw new Error("MinIO omitted continuation token");
  } while (token);
  return keys;
}

const describeMinio = enabled ? describe : describe.skip;

describeMinio("v3 disposition journal fixture on real MinIO", () => {
  beforeAll(async () => {
    const versioning = await cleanupClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) throw new Error("v3 fixture bucket must never enable versioning");
  }, 30_000);

  afterAll(async () => {
    try {
      while (true) {
        const keys = await listOwnKeys();
        if (keys.length === 0) break;
        for (let offset = 0; offset < keys.length; offset += 1_000) {
          const removed = await cleanupClient.send(new DeleteObjectsCommand({
            Bucket: bucket, Delete: { Quiet: true,
              Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })) },
          }));
          if ((removed.Errors?.length ?? 0) > 0) throw new Error("v3 fixture cleanup failed");
        }
      }
    } finally {
      await first.close(); await second.close();
      firstClient.destroy(); secondClient.destroy(); cleanupClient.destroy();
    }
  }, 30_000);

  it("does not create authority during a missing-head observation", async () => {
    await expect(first.observeSealedChain()).rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(await listOwnKeys()).toEqual([]);
    expect(firstClient.names).toEqual(["GetObjectCommand"]);
  });

  it("seals authorization and terminal events, replays exactly, and never asserts product authority", async () => {
    await first.initializeFixture();
    firstClient.loseNextEventResponse = true;
    const authorized = await first.appendFixtureAuthorization(authorization(1));
    expect(authorized.eventType).toBe("delete_authorized");
    expect(await first.appendFixtureAuthorization(authorization(1))).toEqual(authorized);
    await expect(first.appendFixtureAuthorization({
      ...authorization(1), grantReceiptSha256: digest("different-grant"),
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
    firstClient.loseNextHeadResponse = true;
    const marker = {
      dispositionOperationSha256: source(1).dispositionOperationSha256,
      sameKeyTombstoneReceiptSha256: digest("same-key-receipt"),
      tombstoneMarkerSha256: digest("marker"),
      originalObjectEtagSha256: digest("etag"),
    };
    const terminal = await first.appendFixtureTerminal(marker);
    expect(terminal.eventType).toBe("delete_tombstoned");
    expect(await second.appendFixtureTerminal(marker)).toEqual(terminal);
    const view = await second.observeSealedChain();
    expect(view.events).toEqual([authorized, terminal]);
    expect(view.sealedHead.journalSequence).toBe(2);
    expect([view.grantReady, view.executionReady, view.externalAuthorityVerified,
      view.restoreFenceVerified, view.physicalAck]).toEqual([false, false, false, false, false]);
    expect(secondClient.names).not.toContain("ListObjectsV2Command");
    expect((await listOwnKeys()).sort()).toEqual([headKey, eventKey(1), eventKey(2)].sort());
    await expect(second.appendFixtureTerminal({
      ...marker, tombstoneMarkerSha256: digest("different-marker"),
    })).rejects.toBeInstanceOf(TenantTelemetryDispositionConflictError);
  }, 30_000);

  it("refuses an unsealed pending slot without observer mutation, then fixture CAS-recovers it", async () => {
    const head = (await first.observeSealedChain()).sealedHead;
    const pendingInput = authorization(3);
    const pending = buildFixtureTenantTelemetryDispositionEventV3({
      identity: first.identity, ...pendingInput, terminal: null, head,
      nonProductionFixture: true,
    });
    await cleanupClient.send(new PutObjectCommand({
      Bucket: bucket, Key: eventKey(3), IfNoneMatch: "*",
      ContentType: TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
      Body: encodeTenantTelemetryDispositionV3Envelope("event", canonicalJson(pending)),
    }));
    const keysBefore = await listOwnKeys();
    const writesBefore = secondClient.names.filter((name) => name === "PutObjectCommand").length;
    await expect(second.observeSealedChain()).rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(await listOwnKeys()).toEqual(keysBefore);
    expect(secondClient.names.filter((name) => name === "PutObjectCommand").length).toBe(writesBefore);
    expect(await first.appendFixtureAuthorization(pendingInput)).toEqual(pending);
    expect((await second.observeSealedChain()).sealedHead)
      .toEqual(headAfterTenantTelemetryDispositionEventV3(pending));
  }, 30_000);

  it("serializes two concurrent CAS writers with distinct operation slots", async () => {
    const [a, b] = await Promise.all([
      first.appendFixtureAuthorization(authorization(4)),
      second.appendFixtureAuthorization(authorization(5)),
    ]);
    expect(a.source.dispositionOperationSha256).not.toBe(b.source.dispositionOperationSha256);
    const observed = await first.observeSealedChain();
    expect(observed.events.map((event) => event.journalSequence))
      .toEqual([1, 2, 3, 4, 5]);
    expect(observed.events.some((event) => event.journalEventSha256 === a.journalEventSha256)).toBe(true);
    expect(observed.events.some((event) => event.journalEventSha256 === b.journalEventSha256)).toBe(true);
    expect(firstClient.names).not.toContain("ListObjectsV2Command");
  }, 30_000);
});
