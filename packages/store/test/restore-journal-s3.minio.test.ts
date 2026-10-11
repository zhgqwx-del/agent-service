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
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  type TenantRestoreJournalRecord,
} from "../src/tenant-restore-journal.js";
import { encodeRestoreJournalEnvelope } from "../src/restore-journal/codec.js";
import { canonicalTenantRestoreJournalRecord } from "../src/restore-journal/serialization.js";
import { TenantRestoreJournalConflictError } from "../src/restore-journal/common.js";
import { S3TenantRestoreJournalAdapter } from "../src/restore-journal/s3.js";

const integrationGate = process.env.AGENT_SERVICE_RESTORE_JOURNAL_S3_INTEGRATION ?? "0";
if (integrationGate !== "0" && integrationGate !== "1") {
  throw new Error("AGENT_SERVICE_RESTORE_JOURNAL_S3_INTEGRATION must be 0 or 1");
}
const integrationEnabled = integrationGate === "1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real restore-journal MinIO suite`);
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
  ? required("S3_RESTORE_JOURNAL_TEST_BUCKET")
  : "disabled-restore-journal-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `restore-journal-tests/${runId}`;
const isolatedPrefix = `restore-journal-tests/${runId}-isolated`;
const cleanupPrefixes = new Set([prefix, isolatedPrefix]);
const LOGICAL_DATABASE_NAMESPACE_SHA256 = "a".repeat(64);
const T1_FENCE_SHA256 = "c".repeat(64);
const namespaceId = `minio-restore-journal-${runId}`;
const failureDomainId = `minio-local-${runId}`;

const clientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
};
const journalClientIdentity = {
  region,
  endpoint: endpoint.origin,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
} as const;
const cleanupClient = new S3Client({ ...clientConfig, maxAttempts: 2 });
const first = new S3TenantRestoreJournalAdapter({
  independentFailureDomain: true,
  bucket,
  prefix,
  namespaceId,
  failureDomainId,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...journalClientIdentity,
});
const second = new S3TenantRestoreJournalAdapter({
  independentFailureDomain: true,
  bucket,
  prefix,
  namespaceId,
  failureDomainId,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...journalClientIdentity,
});
const isolated = new S3TenantRestoreJournalAdapter({
  independentFailureDomain: true,
  bucket,
  prefix: isolatedPrefix,
  namespaceId: `minio-restore-journal-${runId}-isolated`,
  failureDomainId: `minio-local-${runId}-isolated`,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  ...journalClientIdentity,
});

function record(index: number): TenantRestoreJournalRecord {
  const hex = index.toString(16).padStart(8, "0");
  const requestId = `erase_${hex}-1234-4234-8234-123456789abc`;
  const tenantId = `tenant-${index}`;
  const subjectGeneration = index + 1;
  const operationSha256 = tenantRestoreJournalOperationSha256({
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration,
    t1FenceSha256: T1_FENCE_SHA256,
  });
  const body = {
    scope: TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
    protocol: TENANT_RESTORE_JOURNAL_PROTOCOL,
    logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
    requestId,
    tenantId,
    subjectGeneration,
    t1FenceSha256: T1_FENCE_SHA256,
    operationSha256,
  } as const;
  return { ...body, recordSha256: tenantRestoreJournalRecordSha256(body) };
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
        throw new Error("restore journal test cleanup listing escaped its prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("restore journal test cleanup listing omitted continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(selectedPrefix: string): Promise<void> {
  if (!cleanupPrefixes.has(selectedPrefix)) {
    throw new Error("refusing to clean an unrelated restore journal prefix");
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
        throw new Error("restore journal test cleanup reported an object error");
      }
    }
  }
}

const describeMinio = integrationEnabled ? describe : describe.skip;

describeMinio("S3TenantRestoreJournalAdapter real MinIO contract", () => {
  beforeAll(async () => {
    const versioning = await cleanupClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) {
      throw new Error("restore journal MinIO test bucket must never have enabled versioning");
    }
    await first.validateStartup();
    await second.validateStartup();
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanupPrefix(prefix);
      await cleanupPrefix(isolatedPrefix);
    } finally {
      await first.close();
      await second.close();
      await isolated.close();
      cleanupClient.destroy();
    }
  }, 30_000);

  it("serializes concurrent writers across independent clients into one immutable chain", async () => {
    const records = Array.from({ length: 20 }, (_, index) => record(index + 1));
    const settled = await Promise.allSettled(records.map((value, index) => (
      (index % 2 === 0 ? first : second).publishRecord(value)
    )));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
    }
    const results = settled.map((result) => {
      if (result.status !== "fulfilled") throw new Error("unreachable rejected restore publisher");
      return result.value;
    });
    expect(new Set(results.map((result) => result.remoteSequence)).size).toBe(records.length);
    const head = await first.readHead();
    expect(head.remoteSequence).toBe(records.length);
    expect(await second.readHead()).toEqual(head);
    for (const value of records) {
      await expect(second.inspectRecord(value)).resolves.toMatchObject({ replayed: true });
    }
  }, 30_000);

  it("keeps a sealed scan stable while new records append", async () => {
    const sealedHead = await first.readHead();
    const later = record(100);
    await second.publishRecord(later);
    const seen: TenantRestoreJournalRecord[] = [];
    let afterRemoteSequence = 0;
    let afterHeadRootSha256 = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    while (true) {
      const page = await first.scanRecords({
        sealedHead,
        afterRemoteSequence,
        afterHeadRootSha256,
        limit: 3,
      });
      seen.push(...page.entries.map((entry) => entry.record));
      afterRemoteSequence = page.nextRemoteSequence;
      afterHeadRootSha256 = page.nextHeadRootSha256;
      if (page.complete) break;
    }
    expect(seen).toHaveLength(sealedHead.remoteSequence);
    expect(seen.some((value) => value.operationSha256 === later.operationSha256)).toBe(false);
    expect((await first.readHead()).remoteSequence).toBe(sealedHead.remoteSequence + 1);
  }, 30_000);

  it("keeps equal operations isolated by namespace prefix", async () => {
    const value = record(200);
    await isolated.publishRecord(value);
    await expect(isolated.inspectRecord(value)).resolves.toMatchObject({ remoteSequence: 1 });
    expect(isolated.journalNamespaceSha256).not.toBe(first.journalNamespaceSha256);
    // The primary journal has not seen this operation.
    await expect(first.inspectRecord(value)).resolves.toBeNull();
  });

  it("rejects a pre-existing conflicting immutable operation object", async () => {
    const expected = record(300);
    const foreign = record(301);
    const key = `${prefix}/targets/${first.targetSha256}/records/${expected.operationSha256}`;
    await cleanupClient.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: encodeRestoreJournalEnvelope(
        "record",
        canonicalTenantRestoreJournalRecord(foreign),
      ),
      IfNoneMatch: "*",
    }));
    await expect(first.publishRecord(expected)).rejects.toBeInstanceOf(
      TenantRestoreJournalConflictError,
    );
  });
});
