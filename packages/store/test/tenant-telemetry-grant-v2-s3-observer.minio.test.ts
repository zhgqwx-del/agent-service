import { randomBytes } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionAuthorizationGrantSha256,
  type TenantTelemetryDispositionAuthorizationGrant,
  type TenantTelemetryDispositionJournalIdentity,
} from "../src/tenant-telemetry-disposition.js";
import { canonicalJson } from "../src/tenant-telemetry-disposition-adapter/common.js";
import {
  buildFixtureTenantTelemetryGrantAuthorizationEventV2,
  emptyTenantTelemetryGrantJournalHeadV2,
  headAfterTenantTelemetryGrantAuthorizationEventV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2.js";
import {
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE,
  encodeTenantTelemetryGrantJournalV2Envelope,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2-envelope.js";
import {
  S3TenantTelemetryGrantJournalObserverV2,
} from "../src/tenant-telemetry-disposition-adapter/grant-v2-s3-observer.js";
import { dispositionDigest, dispositionEvidence } from "./tenant-telemetry-disposition.fixture.js";

const gate = process.env.AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION ?? "0";
if (gate !== "0" && gate !== "1") {
  throw new Error("AGENT_SERVICE_TELEMETRY_DISPOSITION_S3_INTEGRATION must be 0 or 1");
}
const enabled = gate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real v2 observer MinIO suite`);
  return value;
}

function endpointOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash
    || (url.pathname && url.pathname !== "/")) {
    throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  }
  return url.origin;
}

const endpoint = enabled ? endpointOrigin(required("S3_TEST_ENDPOINT")) : "http://127.0.0.1:9000";
const region = enabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = enabled
  ? required("S3_TELEMETRY_DISPOSITION_TEST_BUCKET")
  : "disabled-telemetry-grant-v2-integration";
const accessKeyId = enabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = enabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleValue = enabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleValue !== "0" && forcePathStyleValue !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleValue === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `telemetry-grant-v2-tests/${runId}`;
const config: S3ClientConfig = {
  endpoint,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
  maxAttempts: 2,
};

class RecordingClient {
  readonly names: string[] = [];
  readonly inner = new S3Client(config);

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.names.push(command?.constructor?.name ?? "unknown");
    return this.inner.send(command as never, options);
  }

  destroy(): void {
    this.inner.destroy();
  }
}

const fixtureClient = new S3Client(config);
const firstClient = new RecordingClient();
const secondClient = new RecordingClient();
const common = {
  independentFailureDomain: true as const,
  privateBucketAccessVerified: true as const,
  bucket,
  prefix,
  namespaceId: `minio-grant-v2-${runId}`,
  failureDomainId: `minio-local-${runId}`,
  logicalDatabaseNamespaceSha256: dispositionDigest(`minio-v2-db-${runId}`),
  region,
  endpoint,
  forcePathStyle,
  operationTimeoutMs: 30_000,
  maxEvents: 100,
};
const first = new S3TenantTelemetryGrantJournalObserverV2({
  ...common,
  client: firstClient as unknown as S3Client,
});
const second = new S3TenantTelemetryGrantJournalObserverV2({
  ...common,
  client: secondClient as unknown as S3Client,
});
const identity: TenantTelemetryDispositionJournalIdentity = {
  adapterProtocol: first.adapterProtocol,
  journalNamespaceSha256: first.journalNamespaceSha256,
  journalTargetSha256: first.journalTargetSha256,
  failureDomainSha256: first.failureDomainSha256,
  logicalDatabaseNamespaceSha256: first.logicalDatabaseNamespaceSha256,
};
const base = `${prefix}/targets/${first.journalTargetSha256}`;
const headKey = `${base}/authority/head-v2`;
const eventKey = (sequence: number) =>
  `${base}/events-v2/${String(sequence).padStart(16, "0")}`;

function grant(index: number): TenantTelemetryDispositionAuthorizationGrant {
  const body = {
    scope: TENANT_TELEMETRY_DISPOSITION_AUTHORIZATION_GRANT_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    tenantId: `private-tenant-${index}`,
    requestId: `private-request-${index}`,
    ...dispositionEvidence(index),
    claimAttempt: 1,
    claimTokenSha256: dispositionDigest(`minio-claim-${index}`),
    grantedAtDbMs: 1_000,
    leaseUntilDbMs: 2_000,
  };
  return {
    ...body,
    grantReceiptSha256: tenantTelemetryDispositionAuthorizationGrantSha256(body),
  };
}

async function put(
  key: string,
  kind: "head" | "event",
  value: unknown,
  ifMatch?: string,
): Promise<string> {
  const output = await fixtureClient.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: kind === "head"
      ? TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE
      : TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
    Body: encodeTenantTelemetryGrantJournalV2Envelope(kind, canonicalJson(value)),
    ...(ifMatch === undefined ? { IfNoneMatch: "*" } : { IfMatch: ifMatch }),
  }));
  if (!output.ETag) throw new Error("MinIO fixture did not return an ETag");
  return output.ETag;
}

async function listOwnKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const output = await fixtureClient.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      ContinuationToken: token,
    }));
    for (const object of output.Contents ?? []) {
      if (!object.Key?.startsWith(`${prefix}/`)) {
        throw new Error("v2 observer fixture cleanup escaped its unique prefix");
      }
      keys.push(object.Key);
    }
    token = output.IsTruncated ? output.NextContinuationToken : undefined;
    if (output.IsTruncated && !token) throw new Error("MinIO fixture omitted continuation token");
  } while (token);
  return keys;
}

const describeMinio = enabled ? describe : describe.skip;

describeMinio("v2 grant journal read-only observer on real MinIO", () => {
  beforeAll(async () => {
    const versioning = await fixtureClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) {
      throw new Error("v2 grant journal MinIO bucket must never have enabled versioning");
    }
  }, 30_000);

  afterAll(async () => {
    try {
      while (true) {
        const keys = await listOwnKeys();
        if (keys.length === 0) break;
        for (let offset = 0; offset < keys.length; offset += 1_000) {
          const result = await fixtureClient.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Quiet: true,
              Objects: keys.slice(offset, offset + 1_000).map((Key) => ({ Key })),
            },
          }));
          if ((result.Errors?.length ?? 0) > 0) {
            throw new Error("v2 observer fixture cleanup reported an object error");
          }
        }
      }
    } finally {
      await first.close();
      await second.close();
      firstClient.destroy();
      secondClient.destroy();
      fixtureClient.destroy();
    }
  }, 30_000);

  it("refuses a missing head without creating one", async () => {
    await expect(first.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect(await listOwnKeys()).toEqual([]);
    expect(firstClient.names).toEqual(["GetObjectCommand"]);
  });

  it("two clients observe only sealed v2 authority and never advance a pending head", async () => {
    const genesis = emptyTenantTelemetryGrantJournalHeadV2(identity);
    const genesisEtag = await put(headKey, "head", genesis);
    const empty = await first.observeSealedChain();
    expect(empty.observedEventCount).toBe(0);
    expect(empty.grantReady).toBe(false);

    const event = buildFixtureTenantTelemetryGrantAuthorizationEventV2(
      identity, grant(1), genesis, true,
    );
    await put(eventKey(1), "event", event);
    await expect(second.observeSealedChain())
      .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
    expect((await listOwnKeys()).sort()).toEqual([headKey, eventKey(1)].sort());

    const sealed = headAfterTenantTelemetryGrantAuthorizationEventV2(event);
    await put(headKey, "head", sealed, genesisEtag);
    const observed = await Promise.all([
      first.observeSealedChain(),
      second.observeSealedChain(),
    ]);
    for (const result of observed) {
      expect(result.sealedHead).toEqual(sealed);
      expect(result.observedEventCount).toBe(1);
      expect(result.grantReady).toBe(false);
      expect(result.executionReady).toBe(false);
      expect(result.externalAuthorityVerified).toBe(false);
      expect(result.restoreFenceVerified).toBe(false);
    }
    expect([...firstClient.names, ...secondClient.names]
      .every((name) => name === "GetObjectCommand"))
      .toBe(true);
    expect([...firstClient.names, ...secondClient.names])
      .not.toContain("PutObjectCommand");
  }, 30_000);

  it("uses a disjoint target identity and does not leak raw tenant/request IDs", async () => {
    const other = new S3TenantTelemetryGrantJournalObserverV2({
      ...common,
      namespaceId: `other-namespace-${runId}`,
      client: secondClient as unknown as S3Client,
    });
    try {
      expect(other.journalTargetSha256).not.toBe(first.journalTargetSha256);
      await expect(other.observeSealedChain())
        .rejects.toBeInstanceOf(TenantTelemetryDispositionCorruptError);
      const keys = await listOwnKeys();
      expect(keys.sort()).toEqual([headKey, eventKey(1)].sort());
      expect(keys.join(" ")).not.toMatch(/private-tenant|private-request/);
    } finally {
      await other.close();
    }
  });
});
