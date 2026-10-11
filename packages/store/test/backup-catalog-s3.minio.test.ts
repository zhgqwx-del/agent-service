import { createHash, randomBytes } from "node:crypto";
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
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionPlanSha256,
  type TenantBackupEvictionPlan,
} from "../src/backup-catalog.js";
import {
  TenantBackupCatalogAdapterConflictError,
  type PublishTenantBackupAvailabilityInput,
} from "../src/backup-catalog-adapter/common.js";
import {
  S3_TENANT_BACKUP_CATALOG_PROTOCOL,
  S3TenantBackupCatalogAdapter,
} from "../src/backup-catalog-adapter/s3.js";

const integrationGate = process.env.AGENT_SERVICE_BACKUP_CATALOG_S3_INTEGRATION ?? "0";
if (integrationGate !== "0" && integrationGate !== "1") {
  throw new Error("AGENT_SERVICE_BACKUP_CATALOG_S3_INTEGRATION must be 0 or 1");
}
const integrationEnabled = integrationGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real backup-catalog MinIO suite`);
  return value;
}

function testEndpoint(raw: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || (endpoint.pathname && endpoint.pathname !== "/")
  ) throw new Error("S3_TEST_ENDPOINT must be a credential-free http(s) origin");
  return endpoint;
}

const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled
  ? required("S3_BACKUP_CATALOG_TEST_BUCKET")
  : "disabled-backup-catalog-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `backup-catalog-tests/${runId}`;
const isolatedPrefix = `backup-catalog-tests/${runId}-isolated`;
const corruptPrefix = `backup-catalog-tests/${runId}-corrupt`;
const cleanupPrefixes = new Set([prefix, isolatedPrefix, corruptPrefix]);
const LOGICAL_DATABASE_NAMESPACE_SHA256 = digest("minio-logical-database");
const namespaceId = `minio-backup-catalog-${runId}`;
const failureDomainId = `minio-local-${runId}`;

const clientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
};
const adapterClientIdentity = {
  region,
  endpoint: endpoint.origin,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
} as const;
const cleanupClient = new S3Client({ ...clientConfig, maxAttempts: 2 });
const first = new S3TenantBackupCatalogAdapter({
  independentFailureDomain: true,
  bucket,
  prefix,
  namespaceId,
  failureDomainId,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...adapterClientIdentity,
});
const second = new S3TenantBackupCatalogAdapter({
  independentFailureDomain: true,
  bucket,
  prefix,
  namespaceId,
  failureDomainId,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...adapterClientIdentity,
});
const isolated = new S3TenantBackupCatalogAdapter({
  independentFailureDomain: true,
  bucket,
  prefix: isolatedPrefix,
  namespaceId: `${namespaceId}-isolated`,
  failureDomainId: `${failureDomainId}-isolated`,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...adapterClientIdentity,
});
const corrupt = new S3TenantBackupCatalogAdapter({
  independentFailureDomain: true,
  bucket,
  prefix: corruptPrefix,
  namespaceId: `${namespaceId}-corrupt`,
  failureDomainId: `${failureDomainId}-corrupt`,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...adapterClientIdentity,
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(index: number): string {
  return index.toString(16).padStart(12, "0");
}

function availability(index: number): PublishTenantBackupAvailabilityInput {
  const registeredAtDbMs = 1_700_000_000_000 + index;
  return {
    backupId: `backup_00000000-0000-4000-8000-${uuid(index)}`,
    anchorSha256: digest(`anchor-${index}`),
    sourceSnapshotSha256: digest(`snapshot-${index}`),
    sourceBackupSha256: digest(`backup-artifact-${index}`),
    artifactManifestSha256: digest(`manifest-${index}`),
    providerEvidenceSha256: digest(`provider-${index}`),
    controlEvidenceSha256: digest(`control-${index}`),
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    retentionPolicySha256: digest(`retention-${index}`),
    retentionUntilDbMs: registeredAtDbMs + 86_400_000,
    registeredAtDbMs,
  };
}

function evictionPlan(
  source: PublishTenantBackupAvailabilityInput,
  entrySha256: string,
  head: { catalogSequence: number; catalogEventRootSha256: string },
  index: number,
): TenantBackupEvictionPlan {
  const body = {
    evictionId: `backup_evict_00000000-0000-4000-8000-${uuid(index)}`,
    backupId: source.backupId,
    anchorSha256: source.anchorSha256,
    entrySha256,
    sourceSnapshotSha256: source.sourceSnapshotSha256,
    sourceBackupSha256: source.sourceBackupSha256,
    artifactManifestSha256: source.artifactManifestSha256,
    providerEvidenceSha256: source.providerEvidenceSha256,
    controlEvidenceSha256: source.controlEvidenceSha256,
    retentionPolicySha256: source.retentionPolicySha256,
    retentionUntilDbMs: source.retentionUntilDbMs,
    expectedCatalogSequence: head.catalogSequence,
    expectedCatalogEventRootSha256: head.catalogEventRootSha256,
  };
  const evictionOperationSha256 = tenantBackupEvictionOperationSha256(body);
  const withOperation = { ...body, evictionOperationSha256 };
  return { ...withOperation, planSha256: tenantBackupEvictionPlanSha256(withOperation) };
}

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
        throw new Error("backup catalog test cleanup listing escaped its prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("backup catalog test cleanup listing omitted continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(selectedPrefix: string): Promise<void> {
  if (!cleanupPrefixes.has(selectedPrefix)) {
    throw new Error("refusing to clean an unrelated backup catalog prefix");
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
        throw new Error("backup catalog test cleanup reported an object error");
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

describeMinio("S3TenantBackupCatalogAdapter real MinIO contract", () => {
  beforeAll(async () => {
    const versioning = await cleanupClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) {
      throw new Error("backup catalog MinIO test bucket must never have enabled versioning");
    }
    await first.validateStartup();
    await second.validateStartup();
    await isolated.validateStartup();
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanupPrefix(prefix);
      await cleanupPrefix(isolatedPrefix);
      await cleanupPrefix(corruptPrefix);
    } finally {
      await first.close();
      await second.close();
      await isolated.close();
      await corrupt.close();
      cleanupClient.destroy();
    }
  }, 30_000);

  it("serializes independent concurrent clients into one immutable global event chain", async () => {
    expect(first.adapterProtocol).toBe(S3_TENANT_BACKUP_CATALOG_PROTOCOL);
    expect(first.adapterProtocol).toContain("cas-head");
    const inputs = Array.from({ length: 20 }, (_, index) => availability(index + 1));
    const settled = await Promise.allSettled(inputs.map((input, index) => (
      (index % 2 === 0 ? first : second).publishAvailability(input)
    )));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
    const results = settled.map((result) => {
      if (result.status !== "fulfilled") throw new Error("unreachable rejected catalog publisher");
      return result.value;
    });
    expect(new Set(results.map((result) => result.catalogSequence)).size).toBe(inputs.length);
    expect(results.every((result) => result.entrySha256.length === 64)).toBe(true);
    const head = await first.readHead();
    expect(head.catalogSequence).toBe(inputs.length);
    expect(await second.readHead()).toEqual(head);
    const keys = await listPrefix(prefix);
    expect(keys).toContain(
      `${prefix}/targets/${first.catalogTargetSha256}/authority/head-v2`,
    );
    expect(keys).toContain(
      `${prefix}/probes/conditional-cas-v1/${first.catalogTargetSha256}`,
    );
    for (const input of inputs) {
      await expect(second.inspectAvailability(input.backupId)).resolves.toMatchObject(input);
    }
  }, 30_000);

  it("keeps a sealed scan stable while later events append", async () => {
    const sealedHead = await first.readHead();
    const later = availability(100);
    await second.publishAvailability(later);
    const seen: string[] = [];
    let afterCatalogSequence = 0;
    let afterCatalogEventRootSha256 = EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256;
    while (true) {
      const page = await first.scanEvents({
        sealedHead,
        afterCatalogSequence,
        afterCatalogEventRootSha256,
        limit: 3,
      });
      seen.push(...page.events.map((event) => event.eventType));
      afterCatalogSequence = page.nextCatalogSequence;
      afterCatalogEventRootSha256 = page.nextCatalogEventRootSha256;
      if (page.complete) break;
    }
    expect(seen).toHaveLength(sealedHead.catalogSequence);
    expect((await first.readHead()).catalogSequence).toBe(sealedHead.catalogSequence + 1);
  }, 30_000);

  it("persists reservation resolution and physical-absence eviction tombstone events", async () => {
    const source = availability(200);
    const otherSource = availability(201);
    const entry = await first.publishAvailability(source);
    const otherEntry = await second.publishAvailability(otherSource);
    const beforeRejectedEntry = await first.readHead();
    await expect(second.reserveRestore({
      backupId: source.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000200",
      entrySha256: digest("wrong-entry-200"),
      runtimeEpochSha256: digest("runtime-200"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(first.readHead()).resolves.toEqual(beforeRejectedEntry);
    const reservation = await second.reserveRestore({
      backupId: source.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000200",
      entrySha256: entry.entrySha256,
      runtimeEpochSha256: digest("runtime-200"),
    });
    const activeHead = await first.readHead();
    await expect(first.reserveRestore({
      backupId: otherSource.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000201",
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("runtime-201"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(first.resolveRestore({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: digest("wrong-reservation-receipt-200"),
      phase: "aborted",
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(second.readHead()).resolves.toEqual(activeHead);
    await first.resolveRestore({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const plan = evictionPlan(source, entry.entrySha256, await first.readHead(), 200);
    const eviction = await second.recordEviction({
      plan,
      externalTombstoneSha256: digest("physical-tombstone-200"),
      observedAbsent: true,
    });
    await expect(first.recordEviction({
      plan,
      externalTombstoneSha256: digest("physical-tombstone-200"),
      observedAbsent: true,
    })).resolves.toEqual(eviction);
    expect("delete" in first).toBe(false);
  }, 30_000);

  it("keeps equal backup identities isolated by catalog namespace", async () => {
    const input = availability(300);
    await isolated.publishAvailability(input);
    await expect(isolated.inspectAvailability(input.backupId)).resolves.toMatchObject(input);
    // The primary catalog has never seen this backup identity.
    await expect(first.inspectAvailability(input.backupId)).resolves.toBeNull();
    expect(isolated.catalogNamespaceSha256).not.toBe(first.catalogNamespaceSha256);
    expect(isolated.catalogTargetSha256).not.toBe(first.catalogTargetSha256);
  });

  it("keeps catalog event objects private from anonymous HTTP reads", async () => {
    const input = availability(301);
    const result = await isolated.publishAvailability(input);
    const eventKey = `${isolatedPrefix}/targets/${isolated.catalogTargetSha256}/events/${String(
      result.catalogSequence,
    ).padStart(16, "0")}`;
    const response = await fetch(anonymousObjectUrl(eventKey), { redirect: "manual" });
    try {
      expect([401, 403]).toContain(response.status);
    } finally {
      await response.body?.cancel();
    }
  });

  it("fails closed when a real object at the next sequence has a corrupt envelope", async () => {
    const input = availability(400);
    await corrupt.publishAvailability(input);
    const key = `${corruptPrefix}/targets/${corrupt.catalogTargetSha256}/events/0000000000000002`;
    await cleanupClient.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from("not-a-catalog-envelope"),
      IfNoneMatch: "*",
    }));
    await expect(corrupt.readHead()).rejects.toThrow("chain is corrupt");
  });
});
