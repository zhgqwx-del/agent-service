import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  TENANT_RESTORE_JOURNAL_PROTOCOL,
  TENANT_RESTORE_JOURNAL_RECORD_SCOPE,
  tenantRestoreJournalOperationSha256,
  tenantRestoreJournalRecordSha256,
  type TenantRestoreJournalRecord,
} from "../src/tenant-restore-journal.js";
import { TenantRestoreJournalConflictError } from "../src/restore-journal/common.js";
import {
  S3TenantRestoreJournalAdapter,
  s3TenantRestoreJournalFailureDomainSha256,
  s3TenantRestoreJournalNamespaceSha256,
  s3TenantRestoreJournalTargetSha256,
} from "../src/restore-journal/s3.js";
import { encodeRestoreJournalEnvelope } from "../src/restore-journal/codec.js";
import {
  buildRestoreJournalStoredHead,
  canonicalRestoreJournalStoredHead,
  canonicalTenantRestoreJournalRecord,
} from "../src/restore-journal/serialization.js";

const BUCKET = "agent-service-restore-journal-test";
const PREFIX = "restore-tests/unit";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = "a".repeat(64);
const T1_FENCE_SHA256 = "c".repeat(64);
const NAMESPACE_ID = "unit-journal-set";
const FAILURE_DOMAIN_ID = "unit-provider-account-region";
const REGION = "us-east-1";
const ENDPOINT = "https://s3.unit.invalid";
const JOURNAL_NAMESPACE_SHA256 = s3TenantRestoreJournalNamespaceSha256(NAMESPACE_ID);
const FAILURE_DOMAIN_SHA256 = s3TenantRestoreJournalFailureDomainSha256(FAILURE_DOMAIN_ID);
const TARGET_SHA256 = s3TenantRestoreJournalTargetSha256({
  journalNamespaceSha256: JOURNAL_NAMESPACE_SHA256,
  failureDomainSha256: FAILURE_DOMAIN_SHA256,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  bucket: BUCKET,
  prefix: PREFIX,
  region: REGION,
  endpoint: ENDPOINT,
});

function serviceError(status: number, name = status === 412 ? "PreconditionFailed" : "ServiceError") {
  return Object.assign(new Error(`unsafe-${name}-https://credential@example.invalid/private-key`), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

interface StoredObject {
  body: Buffer;
  etag: string;
  contentType?: string;
}

class FakeS3Client {
  readonly objects = new Map<string, StoredObject>();
  readonly commands: unknown[] = [];
  readonly destroy = vi.fn();
  versioning: "Enabled" | "Suspended" | undefined;
  lifecycleRules: Array<Record<string, unknown>> = [];
  objectLockEnabled = false;
  returnVersionId = false;
  failHeadPuts = 0;
  loseNextPutFor: ((key: string) => boolean) | undefined;
  falseAckNextPutFor: ((key: string) => boolean) | undefined;
  hangNextSend = false;
  rejectNext: unknown;
  private etagSequence = 0;

  private objectKey(bucket: string | undefined, key: string | undefined) {
    return `${bucket ?? ""}/${key ?? ""}`;
  }

  seed(key: string, body: Buffer) {
    const etag = this.nextEtag(body);
    this.objects.set(this.objectKey(BUCKET, key), { body: Buffer.from(body), etag });
  }

  private nextEtag(body: Buffer) {
    this.etagSequence += 1;
    return `"${createHash("md5").update(body).update(String(this.etagSequence)).digest("hex")}"`;
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
      const current = this.objects.get(this.objectKey(command.input.Bucket, command.input.Key));
      if (!current) throw serviceError(404, "NoSuchKey");
      return {
        ETag: current.etag,
        ContentLength: current.body.length,
        VersionId: this.returnVersionId ? "unexpected-version" : undefined,
        Body: Readable.from([current.body.subarray(0, 11), current.body.subarray(11)]),
      };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      const keys = [...this.objects.keys()]
        .filter((value) => value.startsWith(`${command.input.Bucket}/${prefix}`))
        .map((value) => value.slice(`${command.input.Bucket}/`.length))
        .sort();
      const offset = command.input.ContinuationToken
        ? Number(command.input.ContinuationToken)
        : 0;
      const limit = command.input.MaxKeys ?? 1_000;
      const page = keys.slice(offset, offset + limit);
      const next = offset + page.length;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: next < keys.length,
        NextContinuationToken: next < keys.length ? String(next) : undefined,
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      if (key.includes("/heads/") && this.failHeadPuts > 0) {
        this.failHeadPuts -= 1;
        throw serviceError(403, "AccessDenied");
      }
      const objectKey = this.objectKey(command.input.Bucket, command.input.Key);
      const current = this.objects.get(objectKey);
      if (command.input.IfNoneMatch === "*" && current) throw serviceError(412);
      const body = Buffer.from(command.input.Body as Uint8Array);
      if (this.falseAckNextPutFor?.(key)) {
        this.falseAckNextPutFor = undefined;
        return {};
      }
      const stored = {
        body: Buffer.from(body),
        etag: this.nextEtag(body),
        contentType: command.input.ContentType,
      };
      this.objects.set(objectKey, stored);
      if (this.loseNextPutFor?.(key)) {
        this.loseNextPutFor = undefined;
        throw Object.assign(new Error("private endpoint response loss"), { code: "ECONNRESET" });
      }
      return { ETag: stored.etag, VersionId: this.returnVersionId ? "unexpected-version" : undefined };
    }
    throw new Error(`unexpected S3 command ${String(command)}`);
  }
}

function record(
  requestId = "erase_12345678-1234-4234-8234-123456789abc",
  tenantId = "tenant-a",
  subjectGeneration = 1,
): TenantRestoreJournalRecord {
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

function fixture(
  client = new FakeS3Client(),
  overrides: Partial<ConstructorParameters<typeof S3TenantRestoreJournalAdapter>[0]> = {},
) {
  const store = new S3TenantRestoreJournalAdapter({
    independentFailureDomain: true,
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
  return { client, store };
}

describe("S3TenantRestoreJournalAdapter unit contract", () => {
  it("requires strict independent configuration and exposes only content-free identity", () => {
    const { store } = fixture();
    expect(store.journalNamespaceSha256).toBe(JOURNAL_NAMESPACE_SHA256);
    expect(store.failureDomainSha256).toBe(FAILURE_DOMAIN_SHA256);
    expect(store.targetSha256).toBe(TARGET_SHA256);
    const sibling = fixture(new FakeS3Client(), { prefix: "restore-tests/sibling" }).store;
    expect(sibling.journalNamespaceSha256).toBe(store.journalNamespaceSha256);
    expect(sibling.targetSha256).not.toBe(store.targetSha256);
    const otherDomain = fixture(new FakeS3Client(), {
      failureDomainId: "unit-provider-account-other-region",
    }).store;
    expect(otherDomain.failureDomainSha256).not.toBe(store.failureDomainSha256);
    expect(otherDomain.targetSha256).not.toBe(store.targetSha256);
    expect("delete" in store).toBe(false);
    expect(() => fixture(new FakeS3Client(), {
      independentFailureDomain: false,
    } as unknown as Partial<ConstructorParameters<typeof S3TenantRestoreJournalAdapter>[0]>)).toThrow(
      "independent failure-domain",
    );
    expect(() => fixture(new FakeS3Client(), { bucket: "INVALID_BUCKET" })).toThrow("bucket");
    expect(() => fixture(new FakeS3Client(), { prefix: "/unsafe/" })).toThrow("prefix");
    expect(() => fixture(new FakeS3Client(), { region: "unsafe region" })).toThrow("region");
    expect(() => fixture(new FakeS3Client(), {
      endpoint: "https://user:secret@s3.unit.invalid",
    })).toThrow("credential-free");
    expect(() => fixture(new FakeS3Client(), { requestTimeoutMs: 99 })).toThrow("timeout");
  });

  it("binds region and normalized endpoint mode into identity and fixes SDK endpoint controls", async () => {
    const common = {
      journalNamespaceSha256: JOURNAL_NAMESPACE_SHA256,
      failureDomainSha256: FAILURE_DOMAIN_SHA256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      bucket: BUCKET,
      prefix: PREFIX,
    };
    expect(s3TenantRestoreJournalTargetSha256({
      ...common,
      region: REGION,
      endpoint: `${ENDPOINT}/`,
    })).toBe(TARGET_SHA256);
    expect(s3TenantRestoreJournalTargetSha256({
      ...common,
      region: "us-west-2",
      endpoint: ENDPOINT,
    })).not.toBe(TARGET_SHA256);
    expect(s3TenantRestoreJournalTargetSha256({
      ...common,
      region: REGION,
      endpoint: "https://other.unit.invalid",
    })).not.toBe(TARGET_SHA256);
    expect(s3TenantRestoreJournalTargetSha256({
      ...common,
      region: REGION,
      endpoint: null,
    })).not.toBe(TARGET_SHA256);

    const configured = new S3TenantRestoreJournalAdapter({
      independentFailureDomain: true,
      bucket: BUCKET,
      prefix: PREFIX,
      namespaceId: NAMESPACE_ID,
      failureDomainId: FAILURE_DOMAIN_ID,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      region: REGION,
      endpoint: null,
      forcePathStyle: false,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
    });
    const sdkConfig = (configured as unknown as { client: S3Client }).client.config;
    const resolveBoolean = async (value: boolean | (() => Promise<boolean>)) => (
      typeof value === "function" ? value() : value
    );
    expect(sdkConfig.ignoreConfiguredEndpointUrls).toBe(true);
    await expect(resolveBoolean(sdkConfig.useFipsEndpoint)).resolves.toBe(false);
    await expect(resolveBoolean(sdkConfig.useDualstackEndpoint)).resolves.toBe(false);
    expect(sdkConfig.useAccelerateEndpoint).toBe(false);
    expect(sdkConfig.useGlobalEndpoint).toBe(false);
    expect(sdkConfig.disableMultiregionAccessPoints).toBe(true);
    expect(sdkConfig.followRegionRedirects).toBe(false);
    await configured.close();
  });

  it("validates append-only bucket safety and If-None-Match without DeleteObject authority", async () => {
    const { client, store } = fixture();
    await store.validateStartup();
    await store.validateStartup();
    expect(client.commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketVersioningCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketLifecycleConfigurationCommand)).toBe(true);
    expect(client.commands.some((command) => (
      command instanceof PutObjectCommand && command.input.IfNoneMatch === "*"
    ))).toBe(true);
    expect(client.commands.some((command) => (
      command !== null
      && typeof command === "object"
      && command.constructor.name.includes("Delete")
    ))).toBe(false);
    expect([...client.objects.keys()].filter((key) => key.includes("/probes/"))).toHaveLength(1);

    for (const versioning of ["Enabled", "Suspended"] as const) {
      const blocked = fixture();
      blocked.client.versioning = versioning;
      await expect(blocked.store.validateStartup()).rejects.toThrow("versioning must be disabled");
    }
    const expiring = fixture();
    expiring.client.lifecycleRules = [{ Status: "Enabled" }];
    await expect(expiring.store.validateStartup()).rejects.toThrow("lifecycle configuration must be absent");
    const locked = fixture();
    locked.client.objectLockEnabled = true;
    await expect(locked.store.validateStartup()).rejects.toThrow("Object Lock");
  });

  it("publishes, replays, concurrently serializes, and scans only a sealed immutable prefix", async () => {
    const { store } = fixture();
    const first = record();
    const second = record("erase_22345678-1234-4234-8234-123456789abc", "tenant-b", 2);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
      store.publishRecord(index % 2 === 0 ? first : second)
    )));
    expect(results.filter((result) => !result.replayed)).toHaveLength(2);
    const sealedHead = await store.readHead();
    expect(sealedHead.remoteSequence).toBe(2);
    const third = record("erase_32345678-1234-4234-8234-123456789abc", "tenant-c", 3);
    await store.publishRecord(third);
    const firstPage = await store.scanRecords({
      sealedHead,
      afterRemoteSequence: 0,
      afterHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      limit: 1,
    });
    const secondPage = await store.scanRecords({
      sealedHead,
      afterRemoteSequence: firstPage.nextRemoteSequence,
      afterHeadRootSha256: firstPage.nextHeadRootSha256,
      limit: 10,
    });
    expect(firstPage.complete).toBe(false);
    expect(secondPage.complete).toBe(true);
    expect([...firstPage.entries, ...secondPage.entries]).toHaveLength(2);
    expect((await store.readHead()).remoteSequence).toBe(3);
    await expect(store.inspectRecord(first)).resolves.toMatchObject({ replayed: true });
  });

  it("recovers record/head response loss and false acknowledgements by exact strong read-back", async () => {
    for (const point of ["record-loss", "head-loss", "record-false-ack", "head-false-ack"] as const) {
      const { client, store } = fixture();
      if (point === "record-loss") client.loseNextPutFor = (key) => key.includes("/records/");
      if (point === "head-loss") client.loseNextPutFor = (key) => key.includes("/heads/");
      if (point === "record-false-ack") client.falseAckNextPutFor = (key) => key.includes("/records/");
      if (point === "head-false-ack") client.falseAckNextPutFor = (key) => key.includes("/heads/");
      await expect(store.publishRecord(record())).resolves.toMatchObject({ remoteSequence: 1 });
      await expect(store.inspectRecord(record())).resolves.toMatchObject({
        remoteSequence: 1,
        replayed: true,
      });
    }
  });

  it("keeps an orphan record unacknowledged and resumes it without rewriting", async () => {
    const { client, store } = fixture();
    client.failHeadPuts = 1;
    const input = record();
    await expect(store.publishRecord(input)).rejects.toThrow("AccessDenied/403");
    await expect(store.inspectRecord(input)).resolves.toBeNull();
    await expect(store.readHead()).resolves.toMatchObject({ remoteSequence: 0 });
    await expect(store.publishRecord(input)).resolves.toMatchObject({
      remoteSequence: 1,
      replayed: false,
    });
  });

  it("rejects duplicate operations and forks but isolates a sealed scan from later corruption", async () => {
    const duplicate = fixture();
    const first = record();
    const firstResult = await duplicate.store.publishRecord(first);
    const duplicateHead = buildRestoreJournalStoredHead({
      adapterProtocol: duplicate.store.adapterProtocol,
      journalNamespaceSha256: duplicate.store.journalNamespaceSha256,
      targetSha256: duplicate.store.targetSha256,
      logicalDatabaseNamespaceSha256: duplicate.store.logicalDatabaseNamespaceSha256,
      remoteSequence: 2,
      previousHeadRootSha256: firstResult.headRootSha256,
      operationSha256: first.operationSha256,
      recordSha256: first.recordSha256,
    });
    duplicate.client.seed(
      `${PREFIX}/targets/${TARGET_SHA256}/heads/0000000000000002`,
      encodeRestoreJournalEnvelope("head", canonicalRestoreJournalStoredHead(duplicateHead)),
    );
    await expect(duplicate.store.readHead()).rejects.toThrow("chain is corrupt");

    const fork = fixture();
    const forkFirst = await fork.store.publishRecord(first);
    const second = record("erase_62345678-1234-4234-8234-123456789abc", "tenant-fork", 6);
    fork.client.seed(
      `${PREFIX}/targets/${TARGET_SHA256}/records/${second.operationSha256}`,
      encodeRestoreJournalEnvelope("record", canonicalTenantRestoreJournalRecord(second)),
    );
    const forkedHead = buildRestoreJournalStoredHead({
      adapterProtocol: fork.store.adapterProtocol,
      journalNamespaceSha256: fork.store.journalNamespaceSha256,
      targetSha256: fork.store.targetSha256,
      logicalDatabaseNamespaceSha256: fork.store.logicalDatabaseNamespaceSha256,
      remoteSequence: 2,
      previousHeadRootSha256: "f".repeat(64),
      operationSha256: second.operationSha256,
      recordSha256: second.recordSha256,
    });
    fork.client.seed(
      `${PREFIX}/targets/${TARGET_SHA256}/heads/0000000000000002`,
      encodeRestoreJournalEnvelope("head", canonicalRestoreJournalStoredHead(forkedHead)),
    );
    expect(forkFirst.headRootSha256).not.toBe(forkedHead.previousHeadRootSha256);
    await expect(fork.store.readHead()).rejects.toThrow("chain is corrupt");

    const bounded = fixture();
    await bounded.store.publishRecord(first);
    await bounded.store.publishRecord(second);
    const sealedHead = await bounded.store.readHead();
    const third = record("erase_72345678-1234-4234-8234-123456789abc", "tenant-later", 7);
    await bounded.store.publishRecord(third);
    bounded.client.seed(
      `${PREFIX}/targets/${TARGET_SHA256}/heads/0000000000000003`,
      Buffer.from("corrupt-after-sealed-upper-bound"),
    );
    await expect(bounded.store.scanRecords({
      sealedHead,
      afterRemoteSequence: 0,
      afterHeadRootSha256: EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
      limit: 10,
    })).resolves.toMatchObject({ complete: true, nextRemoteSequence: 2 });
    await expect(bounded.store.readHead()).rejects.toThrow("head is corrupt");
  });

  it("fails closed for immutable conflicts, gaps, versioned evidence, and sanitized errors", async () => {
    const conflict = fixture();
    const expected = record();
    const other = record("erase_42345678-1234-4234-8234-123456789abc", "tenant-x", 4);
    const expectedRecordKey = `${PREFIX}/targets/${TARGET_SHA256}/records/${expected.operationSha256}`;
    const otherFixture = fixture();
    await otherFixture.store.publishRecord(other);
    const otherRecordKey = `${PREFIX}/targets/${TARGET_SHA256}/records/${other.operationSha256}`;
    const otherRaw = otherFixture.client.objects.get(`${BUCKET}/${otherRecordKey}`)!.body;
    conflict.client.seed(expectedRecordKey, otherRaw);
    await expect(conflict.store.publishRecord(expected)).rejects.toBeInstanceOf(
      TenantRestoreJournalConflictError,
    );

    const gap = fixture();
    gap.client.seed(`${PREFIX}/targets/${TARGET_SHA256}/heads/0000000000000002`, Buffer.from("bad"));
    await expect(gap.store.readHead()).rejects.toThrow("chain is corrupt");

    const versioned = fixture();
    versioned.client.returnVersionId = true;
    await expect(versioned.store.publishRecord(expected)).rejects.toThrow("versioned-object evidence");

    const sanitized = fixture();
    sanitized.client.rejectNext = serviceError(403, "AccessDenied");
    let caught: unknown;
    try {
      await sanitized.store.validateStartup();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "S3 tenant restore journal startup reachability check failed (AccessDenied/403)",
    );
    expect((caught as Error).message).not.toContain("credential");
    expect((caught as Error).message).not.toContain(BUCKET);
    expect((caught as Error).message).not.toContain("private-key");
  });

  it("bounds stalled SDK work, destroys its client once, and rejects use after close", async () => {
    const { client, store } = fixture(new FakeS3Client(), { requestTimeoutMs: 100 });
    client.hangNextSend = true;
    await expect(store.validateStartup()).rejects.toThrow("TimeoutError");
    await store.close();
    await store.close();
    expect(client.destroy).toHaveBeenCalledOnce();
    await expect(store.readHead()).rejects.toThrow("closed");
  });
});
