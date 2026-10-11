import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
  TenantBackupCatalogAdapterConflictError,
  tenantBackupCatalogEntrySha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupEvictionPlanSha256,
  type PublishTenantBackupAvailabilityInput,
  type TenantBackupEvictionPlan,
} from "../src/index.js";
import {
  BACKUP_CATALOG_EVENT_CONTENT_TYPE,
  BACKUP_CATALOG_HEAD_CONTENT_TYPE,
  decodeBackupCatalogEnvelope,
  encodeBackupCatalogEnvelope,
} from "../src/backup-catalog-adapter/codec.js";
import {
  S3_TENANT_BACKUP_CATALOG_PROTOCOL,
  S3TenantBackupCatalogAdapter,
  s3TenantBackupCatalogFailureDomainSha256,
  s3TenantBackupCatalogNamespaceSha256,
  s3TenantBackupCatalogTargetSha256,
} from "../src/backup-catalog-adapter/s3.js";

const BUCKET = "agent-service-backup-catalog-test";
const PREFIX = "backup-catalog-tests/unit";
const LOGICAL_DATABASE_NAMESPACE_SHA256 = digest("logical-database");
const NAMESPACE_ID = "unit-backup-catalog";
const FAILURE_DOMAIN_ID = "unit-provider-account-region";
const REGION = "us-east-1";
const ENDPOINT = "https://s3.unit.invalid";
const CATALOG_NAMESPACE_SHA256 = s3TenantBackupCatalogNamespaceSha256(NAMESPACE_ID);
const FAILURE_DOMAIN_SHA256 = s3TenantBackupCatalogFailureDomainSha256(FAILURE_DOMAIN_ID);
const TARGET_SHA256 = s3TenantBackupCatalogTargetSha256({
  catalogNamespaceSha256: CATALOG_NAMESPACE_SHA256,
  failureDomainSha256: FAILURE_DOMAIN_SHA256,
  logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
  bucket: BUCKET,
  prefix: PREFIX,
  region: REGION,
  endpoint: ENDPOINT,
  forcePathStyle: true,
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
  loseNextPutFor: ((key: string) => boolean) | undefined;
  falseAckNextPutFor: ((key: string) => boolean) | undefined;
  rejectNextPutFor: ((key: string) => boolean) | undefined;
  hangNextSend = false;
  rejectNext: unknown;
  ignoreIfNoneMatch = false;
  ignoreIfMatch = false;
  omitAllEventKeysFromList = false;
  omitNextListKey: ((key: string) => boolean) | undefined;
  private etagSequence = 0;

  private objectKey(bucket: string | undefined, key: string | undefined): string {
    return `${bucket ?? ""}/${key ?? ""}`;
  }

  seed(key: string, body: Buffer): void {
    this.objects.set(this.objectKey(BUCKET, key), {
      body: Buffer.from(body),
      etag: this.nextEtag(body),
    });
  }

  private nextEtag(body: Buffer): string {
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
        Body: Readable.from([current.body.subarray(0, 13), current.body.subarray(13)]),
      };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      let keys = [...this.objects.keys()]
        .filter((value) => value.startsWith(`${command.input.Bucket}/${prefix}`))
        .map((value) => value.slice(`${command.input.Bucket}/`.length))
        .sort();
      if (this.omitAllEventKeysFromList) {
        keys = keys.filter((key) => !key.includes("/events/"));
      }
      if (this.omitNextListKey) {
        const omit = this.omitNextListKey;
        this.omitNextListKey = undefined;
        keys = keys.filter((key) => !omit(key));
      }
      const offset = command.input.ContinuationToken ? Number(command.input.ContinuationToken) : 0;
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
      const objectKey = this.objectKey(command.input.Bucket, command.input.Key);
      const current = this.objects.get(objectKey);
      if (!this.ignoreIfMatch && command.input.IfMatch !== undefined
        && current?.etag !== command.input.IfMatch) {
        throw serviceError(412);
      }
      if (!this.ignoreIfNoneMatch && command.input.IfNoneMatch === "*" && current) {
        throw serviceError(412);
      }
      if (this.rejectNextPutFor?.(key)) {
        this.rejectNextPutFor = undefined;
        throw serviceError(503, "ServiceUnavailable");
      }
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

function fixture(
  client = new FakeS3Client(),
  overrides: Partial<ConstructorParameters<typeof S3TenantBackupCatalogAdapter>[0]> = {},
) {
  const store = new S3TenantBackupCatalogAdapter({
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

describe("backup catalog dedicated envelope", () => {
  it("round-trips deterministically and rejects corruption and kind confusion", () => {
    const encoded = encodeBackupCatalogEnvelope("event", "{\"safe\":true}");
    expect(decodeBackupCatalogEnvelope("event", encoded)).toBe("{\"safe\":true}");
    expect(encodeBackupCatalogEnvelope("event", "{\"safe\":true}")).toEqual(encoded);
    const corrupt = Buffer.from(encoded);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decodeBackupCatalogEnvelope("event", corrupt)).toThrow("checksum");
    expect(() => decodeBackupCatalogEnvelope("probe", encoded)).toThrow("kind");
    const head = encodeBackupCatalogEnvelope("head", "{\"sequence\":1}");
    expect(decodeBackupCatalogEnvelope("head", head)).toBe("{\"sequence\":1}");
    expect(() => decodeBackupCatalogEnvelope("event", head)).toThrow("kind");
  });
});

describe("S3TenantBackupCatalogAdapter unit contract", () => {
  it("requires explicit independent configuration and exposes credential-free identity only", () => {
    const { store } = fixture();
    expect(store.adapterProtocol).toBe(S3_TENANT_BACKUP_CATALOG_PROTOCOL);
    expect(store.adapterProtocol).toContain("cas-head");
    expect(store.catalogNamespaceSha256).toBe(CATALOG_NAMESPACE_SHA256);
    expect(store.failureDomainSha256).toBe(FAILURE_DOMAIN_SHA256);
    expect(store.catalogTargetSha256).toBe(TARGET_SHA256);
    expect(store.logicalDatabaseNamespaceSha256).toBe(LOGICAL_DATABASE_NAMESPACE_SHA256);
    expect("delete" in store).toBe(false);
    expect(() => fixture(new FakeS3Client(), {
      independentFailureDomain: false,
    } as unknown as Partial<ConstructorParameters<typeof S3TenantBackupCatalogAdapter>[0]>)).toThrow(
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

  it("binds logical namespace, region, endpoint, and addressing mode into target identity", () => {
    const common = {
      catalogNamespaceSha256: CATALOG_NAMESPACE_SHA256,
      failureDomainSha256: FAILURE_DOMAIN_SHA256,
      logicalDatabaseNamespaceSha256: LOGICAL_DATABASE_NAMESPACE_SHA256,
      bucket: BUCKET,
      prefix: PREFIX,
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: true,
    };
    expect(s3TenantBackupCatalogTargetSha256({ ...common, endpoint: `${ENDPOINT}/` }))
      .toBe(TARGET_SHA256);
    expect(s3TenantBackupCatalogTargetSha256({ ...common, region: "us-west-2" }))
      .not.toBe(TARGET_SHA256);
    expect(s3TenantBackupCatalogTargetSha256({ ...common, endpoint: null }))
      .not.toBe(TARGET_SHA256);
    expect(s3TenantBackupCatalogTargetSha256({ ...common, forcePathStyle: false }))
      .not.toBe(TARGET_SHA256);
    expect(s3TenantBackupCatalogTargetSha256({
      ...common,
      logicalDatabaseNamespaceSha256: digest("other-db"),
    })).not.toBe(TARGET_SHA256);
  });

  it("gates startup on unversioned, no-lifecycle, unlocked conditional-create storage", async () => {
    const { client, store } = fixture();
    await store.validateStartup();
    await store.validateStartup();
    expect(client.commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketVersioningCommand)).toBe(true);
    expect(client.commands.some((command) => command instanceof GetBucketLifecycleConfigurationCommand))
      .toBe(true);
    expect(client.commands.some((command) => command instanceof GetObjectLockConfigurationCommand))
      .toBe(true);
    expect(client.commands.some((command) => (
      command instanceof PutObjectCommand && command.input.IfNoneMatch === "*"
    ))).toBe(true);
    expect(client.commands.some((command) => (
      command instanceof PutObjectCommand && command.input.IfMatch !== undefined
    ))).toBe(true);
    expect(client.commands.some((command) => (
      command !== null && typeof command === "object" && command.constructor.name.includes("Delete")
    ))).toBe(false);

    for (const versioning of ["Enabled", "Suspended"] as const) {
      const blocked = fixture();
      blocked.client.versioning = versioning;
      await expect(blocked.store.validateStartup()).rejects.toThrow("versioning must be disabled");
    }
    const expiring = fixture();
    expiring.client.lifecycleRules = [{ Status: "Enabled", Expiration: { Days: 1 } }];
    await expect(expiring.store.validateStartup()).rejects.toThrow("lifecycle configuration");
    const locked = fixture();
    locked.client.objectLockEnabled = true;
    await expect(locked.store.validateStartup()).rejects.toThrow("Object Lock");
    const unsafeConditional = fixture();
    unsafeConditional.client.ignoreIfNoneMatch = true;
    await expect(unsafeConditional.store.validateStartup()).rejects.toThrow("ignored If-None-Match");
    const unsafeCas = fixture();
    unsafeCas.client.ignoreIfMatch = true;
    await expect(unsafeCas.store.validateStartup()).rejects.toThrow("ignored If-Match");
    const casResponseLoss = fixture();
    await casResponseLoss.store.validateStartup();
    casResponseLoss.client.loseNextPutFor = (key) => key.includes("/conditional-cas-v1/");
    await expect(casResponseLoss.store.validateStartup()).resolves.toBeUndefined();
  });

  it("linearizes concurrent writers, exact-replays, and scans a sealed immutable prefix", async () => {
    const { client, store } = fixture();
    const inputs = Array.from({ length: 12 }, (_, index) => availability(index + 1));
    const results = await Promise.all(inputs.map((input) => store.publishAvailability(input)));
    expect(new Set(results.map((result) => result.catalogSequence)).size).toBe(inputs.length);
    const { entrySha256, ...entryEvidence } = results[0]!;
    expect(entrySha256).toBe(tenantBackupCatalogEntrySha256({
      scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
      protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
      ...entryEvidence,
    }));
    expect(results.every((result, index) => (
      result.entrySha256.length === 64
      && result.controlEvidenceSha256 === inputs[index]!.controlEvidenceSha256
      && result.logicalDatabaseNamespaceSha256 === LOGICAL_DATABASE_NAMESPACE_SHA256
      && result.retentionPolicySha256 === inputs[index]!.retentionPolicySha256
      && result.retentionUntilDbMs === inputs[index]!.retentionUntilDbMs
      && result.registeredAtDbMs === inputs[index]!.registeredAtDbMs
    ))).toBe(true);
    const replay = await Promise.all(inputs.map((input) => store.publishAvailability(input)));
    expect(replay).toEqual(results);
    const sealedHead = await store.readHead();
    await store.publishAvailability(availability(100));
    const page = await store.scanEvents({
      sealedHead,
      afterCatalogSequence: 0,
      afterCatalogEventRootSha256: EMPTY_TENANT_BACKUP_CATALOG_EVENT_ROOT_SHA256,
      limit: 1_000,
    });
    expect(page.events).toHaveLength(inputs.length);
    expect(page.complete).toBe(true);
    expect((await store.readHead()).catalogSequence).toBe(inputs.length + 1);
    const eventObjects = [...client.objects.values()].filter(
      (object) => object.contentType === BACKUP_CATALOG_EVENT_CONTENT_TYPE,
    );
    expect(eventObjects).toHaveLength(inputs.length + 1);
    expect([...client.objects.values()].filter(
      (object) => object.contentType === BACKUP_CATALOG_HEAD_CONTENT_TYPE,
    )).toHaveLength(1);
  });

  it("recovers committed response loss and false acknowledgements by exact read-back", async () => {
    for (const mode of ["loss", "false-ack"] as const) {
      const { client, store } = fixture();
      if (mode === "loss") client.loseNextPutFor = (key) => key.includes("/events/");
      else client.falseAckNextPutFor = (key) => key.includes("/events/");
      const input = availability(mode === "loss" ? 201 : 202);
      const created = await store.publishAvailability(input);
      await expect(store.publishAvailability(input)).resolves.toEqual(created);
      await expect(store.readHead()).resolves.toMatchObject({ catalogSequence: 1 });
    }
  });

  it("uses the CAS head despite LIST tail omission and repairs event-before-head crashes", async () => {
    const tailOmitted = fixture();
    for (const index of [211, 212, 213]) {
      await tailOmitted.store.publishAvailability(availability(index));
    }
    tailOmitted.client.omitAllEventKeysFromList = true;
    await expect(tailOmitted.store.readHead()).resolves.toMatchObject({ catalogSequence: 3 });
    expect(tailOmitted.client.commands.some((command) => command instanceof ListObjectsV2Command))
      .toBe(false);

    const responseLoss = fixture();
    await responseLoss.store.readHead();
    responseLoss.client.loseNextPutFor = (key) => key.endsWith("/authority/head-v2");
    await expect(responseLoss.store.publishAvailability(availability(214))).resolves.toMatchObject({
      catalogSequence: 1,
    });

    const crashed = fixture();
    await crashed.store.readHead();
    crashed.client.rejectNextPutFor = (key) => key.endsWith("/authority/head-v2");
    await expect(crashed.store.publishAvailability(availability(215)))
      .rejects.toThrow("head compare-and-swap failed");
    crashed.client.omitAllEventKeysFromList = true;
    await expect(crashed.store.readHead()).resolves.toMatchObject({ catalogSequence: 1 });
    await expect(crashed.store.publishAvailability(availability(215))).resolves.toMatchObject({
      catalogSequence: 1,
    });

    const reservationTail = fixture();
    const source = availability(216);
    const entry = await reservationTail.store.publishAvailability(source);
    await reservationTail.store.readHead();
    reservationTail.client.rejectNextPutFor = (key) => key.endsWith("/authority/head-v2");
    await expect(reservationTail.store.reserveRestore({
      backupId: source.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000216",
      entrySha256: entry.entrySha256,
      runtimeEpochSha256: digest("runtime-216"),
    })).rejects.toThrow("head compare-and-swap failed");
    reservationTail.client.omitAllEventKeysFromList = true;
    const recoveredHead = await reservationTail.store.readHead();
    expect(recoveredHead.catalogSequence).toBe(2);
    const blockedPlan = evictionPlan(source, entry.entrySha256, recoveredHead, 216);
    await expect(reservationTail.store.recordEviction({
      plan: blockedPlan,
      externalTombstoneSha256: digest("physical-tombstone-216"),
      observedAbsent: true,
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
  });

  it("burns runtime epochs and blocks eviction until reservation resolution", async () => {
    const { store } = fixture();
    const source = availability(301);
    const otherSource = availability(302);
    const entry = await store.publishAvailability(source);
    const otherEntry = await store.publishAvailability(otherSource);
    const beforeRejectedEntry = await store.readHead();
    await expect(store.reserveRestore({
      backupId: source.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000301",
      entrySha256: digest("wrong-entry-301"),
      runtimeEpochSha256: digest("runtime-301"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(store.readHead()).resolves.toEqual(beforeRejectedEntry);
    const reservation = await store.reserveRestore({
      backupId: source.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000301",
      entrySha256: entry.entrySha256,
      runtimeEpochSha256: digest("runtime-301"),
    });
    await expect(store.reserveRestore({
      backupId: otherSource.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000302",
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("runtime-302"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    const activeHead = await store.readHead();
    const blockedPlan = evictionPlan(source, entry.entrySha256, activeHead, 301);
    await expect(store.recordEviction({
      plan: blockedPlan,
      externalTombstoneSha256: digest("physical-tombstone-301"),
      observedAbsent: true,
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(store.resolveRestore({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: digest("wrong-reservation-receipt-301"),
      phase: "aborted",
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(store.readHead()).resolves.toEqual(activeHead);
    await store.resolveRestore({
      restoreRunId: reservation.restoreRunId,
      reservationReceiptSha256: reservation.reservationReceiptSha256,
      phase: "aborted",
    });
    await expect(store.reserveRestore({
      backupId: otherSource.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000302",
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("runtime-301"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    const otherReservation = await store.reserveRestore({
      backupId: otherSource.backupId,
      restoreRunId: "restore_00000000-0000-4000-8000-000000000302",
      entrySha256: otherEntry.entrySha256,
      runtimeEpochSha256: digest("runtime-302"),
    });
    await store.resolveRestore({
      restoreRunId: otherReservation.restoreRunId,
      reservationReceiptSha256: otherReservation.reservationReceiptSha256,
      phase: "aborted",
    });
    const plan = evictionPlan(source, entry.entrySha256, await store.readHead(), 303);
    const eviction = await store.recordEviction({
      plan,
      externalTombstoneSha256: digest("physical-tombstone-301"),
      observedAbsent: true,
    });
    await expect(store.recordEviction({
      plan,
      externalTombstoneSha256: digest("physical-tombstone-301"),
      observedAbsent: true,
    })).resolves.toEqual(eviction);
    expect(entry.catalogSequence).toBe(1);
    expect(eviction.catalogSequence).toBe(7);
  });

  it("fails closed for stale selection, immutable conflicts, gaps, corruption, and versioned evidence", async () => {
    const stale = fixture();
    const source = availability(401);
    const entry = await stale.store.publishAvailability(source);
    const plan = evictionPlan(source, entry.entrySha256, await stale.store.readHead(), 401);
    await stale.store.publishAvailability(availability(402));
    await expect(stale.store.recordEviction({
      plan,
      externalTombstoneSha256: digest("physical-tombstone-401"),
      observedAbsent: true,
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);
    await expect(stale.store.publishAvailability({
      ...source,
      sourceBackupSha256: digest("conflicting-artifact"),
    })).rejects.toBeInstanceOf(TenantBackupCatalogAdapterConflictError);

    const gap = fixture();
    await gap.store.publishAvailability(availability(405));
    await gap.store.publishAvailability(availability(406));
    gap.client.objects.delete(
      `${BUCKET}/${PREFIX}/targets/${TARGET_SHA256}/events/0000000000000001`,
    );
    await expect(gap.store.readHead()).rejects.toThrow("chain is corrupt");

    const corrupt = fixture();
    await corrupt.store.publishAvailability(availability(403));
    const eventKey = `${PREFIX}/targets/${TARGET_SHA256}/events/0000000000000001`;
    corrupt.client.seed(eventKey, Buffer.from("corrupt-envelope"));
    await expect(corrupt.store.readHead()).rejects.toThrow("chain is corrupt");

    const forkSource = fixture();
    const forkVictim = fixture();
    await forkSource.store.publishAvailability(availability(407));
    await forkVictim.store.publishAvailability(availability(408));
    forkVictim.client.seed(
      eventKey,
      forkSource.client.objects.get(`${BUCKET}/${eventKey}`)!.body,
    );
    await expect(forkVictim.store.readHead()).rejects.toThrow("chain is corrupt");

    const versioned = fixture();
    versioned.client.returnVersionId = true;
    await expect(versioned.store.publishAvailability(availability(404)))
      .rejects.toThrow("versioned-object evidence");
  });

  it("isolates namespaces, sanitizes provider errors, bounds stalls, and closes once", async () => {
    const client = new FakeS3Client();
    const primary = fixture(client);
    const isolated = fixture(client, {
      prefix: "backup-catalog-tests/isolated",
      namespaceId: "unit-backup-catalog-isolated",
    });
    const input = availability(501);
    await primary.store.publishAvailability(input);
    await expect(isolated.store.inspectAvailability(input.backupId)).resolves.toBeNull();
    expect(isolated.store.catalogTargetSha256).not.toBe(primary.store.catalogTargetSha256);

    const sanitized = fixture();
    sanitized.client.rejectNext = serviceError(403, "AccessDenied");
    let caught: unknown;
    try {
      await sanitized.store.validateStartup();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe(
      "S3 tenant backup catalog startup reachability check failed (AccessDenied/403)",
    );
    expect((caught as Error).message).not.toContain("credential");
    expect((caught as Error).message).not.toContain(BUCKET);
    expect((caught as Error).message).not.toContain("private-key");

    const stalled = fixture(new FakeS3Client(), { requestTimeoutMs: 100 });
    stalled.client.hangNextSend = true;
    await expect(stalled.store.validateStartup()).rejects.toThrow("TimeoutError");
    await stalled.store.close();
    await stalled.store.close();
    expect(stalled.client.destroy).toHaveBeenCalledOnce();
    await expect(stalled.store.readHead()).rejects.toThrow("closed");
  });
});
