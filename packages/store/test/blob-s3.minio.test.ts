import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DeleteBucketPolicyCommand,
  DeleteObjectsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutBucketPolicyCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobConflictError, S3BlobStore } from "../src/index.js";

const MAX_BYTES = 1024 * 1024;
const MIGRATION_OWNER_SHA256 = "a".repeat(64);
const integrationGate = process.env.AGENT_SERVICE_S3_INTEGRATION ?? "0";
if (integrationGate !== "0" && integrationGate !== "1") {
  throw new Error("AGENT_SERVICE_S3_INTEGRATION must be 0 or 1");
}
const integrationEnabled = integrationGate === "1";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the real MinIO suite`);
  return value;
}

function testEndpoint(raw: string) {
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
  ) {
    throw new Error("S3_TEST_ENDPOINT must be an absolute http(s) origin without credentials");
  }
  return endpoint;
}

// Keep top-level collection safe in the broad unit/coverage run. The named required suite sets
// the explicit gate and then requires every real endpoint value below.
const endpoint = integrationEnabled
  ? testEndpoint(required("S3_TEST_ENDPOINT"))
  : new URL("http://127.0.0.1:9000");
const region = integrationEnabled ? required("S3_TEST_REGION") : "us-east-1";
const bucket = integrationEnabled ? required("S3_TEST_BUCKET") : "disabled-s3-integration";
const accessKeyId = integrationEnabled ? required("S3_TEST_ACCESS_KEY_ID") : "disabled";
const secretAccessKey = integrationEnabled ? required("S3_TEST_SECRET_ACCESS_KEY") : "disabled";
const forcePathStyleRaw = integrationEnabled ? required("S3_TEST_FORCE_PATH_STYLE") : "1";
if (forcePathStyleRaw !== "0" && forcePathStyleRaw !== "1") {
  throw new Error("S3_TEST_FORCE_PATH_STYLE must be 0 or 1");
}
const forcePathStyle = forcePathStyleRaw === "1";
const runId = randomBytes(12).toString("hex");
const prefix = `blob-tests/${runId}`;
const isolatedPrefix = `blob-tests/${runId}-isolated`;
const cleanupProofPrefix = `blob-tests/${runId}-cleanup-proof`;
const cleanupSurvivorPrefix = `blob-tests/${runId}-cleanup-survivor`;
const cleanupPrefixes = new Set([prefix, isolatedPrefix, cleanupProofPrefix, cleanupSurvivorPrefix]);

const clientConfig: S3ClientConfig = {
  endpoint: endpoint.origin,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey },
};
const firstClient = new S3Client({ ...clientConfig, maxAttempts: 2 });
const first = new S3BlobStore({
  bucket,
  prefix,
  namespaceId: `minio-suite-${runId}`,
  clientConfig,
});
const second = new S3BlobStore({
  bucket,
  prefix,
  namespaceId: `minio-suite-${runId}`,
  clientConfig,
});
const isolated = new S3BlobStore({
  bucket,
  prefix: isolatedPrefix,
  namespaceId: `minio-suite-${runId}`,
  clientConfig,
});

function objectKey(storageKey: string, selectedPrefix = prefix) {
  return `${selectedPrefix}/${storageKey}`;
}

function anonymousObjectUrl(key: string) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (forcePathStyle) return new URL(`${encodeURIComponent(bucket)}/${encodedKey}`, `${endpoint.origin}/`).href;
  const url = new URL(endpoint.origin);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = `/${encodedKey}`;
  return url.href;
}

async function listPrefix(client: S3Client, selectedPrefix: string) {
  const expectedPrefix = `${selectedPrefix}/`;
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: expectedPrefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents ?? []) {
      if (!object.Key?.startsWith(expectedPrefix)) {
        throw new Error("S3 cleanup listing escaped its validated test prefix");
      }
      keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("S3 cleanup listing omitted its continuation token");
    }
  } while (continuationToken);
  return keys;
}

async function cleanupPrefix(client: S3Client, selectedPrefix: string) {
  // Test prefixes are generated above and never supplied by a caller or wildcard.
  if (!cleanupPrefixes.has(selectedPrefix)) {
    throw new Error("refusing to clean an unrelated S3 prefix");
  }
  while (true) {
    const keys = await listPrefix(client, selectedPrefix);
    if (keys.length === 0) return;
    for (let offset = 0; offset < keys.length; offset += 1_000) {
      const batch = keys.slice(offset, offset + 1_000);
      const result = await client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Quiet: true, Objects: batch.map((Key) => ({ Key })) },
      }));
      if ((result.Errors?.length ?? 0) > 0) throw new Error("S3 test-prefix cleanup reported an object error");
    }
  }
}

const describeMinio = integrationEnabled ? describe : describe.skip;

describeMinio("S3BlobStore real MinIO contract", () => {
  beforeAll(async () => {
    const versioning = await firstClient.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== undefined) throw new Error("real MinIO test bucket must never have enabled versioning");
    await first.validateStartup();
    await second.validateStartup();
  }, 30_000);

  afterAll(async () => {
    try {
      await cleanupPrefix(firstClient, prefix);
      await cleanupPrefix(firstClient, isolatedPrefix);
      await cleanupPrefix(firstClient, cleanupProofPrefix);
      await cleanupPrefix(firstClient, cleanupSurvivorPrefix);
    } finally {
      first.destroy();
      second.destroy();
      isolated.destroy();
      firstClient.destroy();
    }
  }, 30_000);

  it("shares data immediately across two independent clients and preserves MIME/hash/size", async () => {
    const bytes = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xff]);
    const descriptor = await first.putIfAbsent("objects/cross-client", bytes, {
      uploadToken: "cross-client-a",
      maxBytes: MAX_BYTES,
      contentType: "application/octet-stream",
    });
    expect(await second.get("objects/cross-client", { maxBytes: MAX_BYTES })).toEqual({
      ...descriptor,
      data: bytes,
    });
    expect(first.namespaceSha256).toBe(second.namespaceSha256);
    expect(first.backend).toBe(second.backend);
  });

  it("inspects and CAS-fences exact uncommitted data and tombstones across clients", async () => {
    const descriptor = await first.putIfAbsent("objects/migration-discard-data", "uncommitted", {
      uploadToken: "migration-discard-data",
      maxBytes: MAX_BYTES,
      contentType: "text/plain",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await second.inspectExact("objects/migration-discard-data", { maxBytes: MAX_BYTES })).toEqual({
      kind: "data",
      descriptor,
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await second.discardUncommittedTarget("objects/migration-discard-data", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "migration-discard-data",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await first.discardUncommittedTarget("objects/migration-discard-data", {
      expectedState: { kind: "data", descriptor },
      uploadToken: "migration-discard-data",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await first.inspectExact("objects/migration-discard-data", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });

    await first.delete("objects/migration-discard-tombstone", {
      uploadToken: "migration-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await second.inspectExact("objects/migration-discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await second.discardUncommittedTarget("objects/migration-discard-tombstone", {
      expectedState: { kind: "tombstone" },
      uploadToken: "migration-tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    expect(await first.inspectExact("objects/migration-discard-tombstone", { maxBytes: MAX_BYTES })).toEqual({
      kind: "tombstone",
      migrationOwnerSha256: MIGRATION_OWNER_SHA256,
    });
    await expect(first.putIfAbsent("objects/migration-discard-tombstone", "after-abort", {
      uploadToken: "migration-after-abort",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("cancelled before publication");
  });

  it("linearizes concurrent identical creates across clients", async () => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (
      (index % 2 === 0 ? first : second).putIfAbsent("objects/concurrent-same", "same", {
        uploadToken: `same-${index}`,
        maxBytes: MAX_BYTES,
        contentType: "text/plain",
      })
    )));
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it("allows exactly one concurrent conflicting create and never overwrites the winner", async () => {
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => (
      (index % 2 === 0 ? first : second).putIfAbsent(
        "objects/concurrent-different",
        `value-${index}`,
        { uploadToken: `different-${index}`, maxBytes: MAX_BYTES, contentType: "text/plain" },
      )
    )));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BlobConflictError);
    }
    expect((await first.get("objects/concurrent-different", { maxBytes: MAX_BYTES }))?.data.toString())
      .toMatch(/^value-\d+$/);
  });

  it("persists a same-key delete-before-put fence across clients and adapter restarts", async () => {
    await first.delete("objects/delete-before-put", { uploadToken: "delete-first" });
    await expect(second.putIfAbsent("objects/delete-before-put", "late", {
      uploadToken: "late-other-token",
      maxBytes: MAX_BYTES,
    })).rejects.toThrow("cancelled before publication");

    const restarted = new S3BlobStore({
      bucket,
      prefix,
      namespaceId: `minio-suite-${runId}`,
      clientConfig,
    });
    try {
      expect(await restarted.get("objects/delete-before-put", { maxBytes: MAX_BYTES })).toBeNull();
      await expect(restarted.putIfAbsent("objects/delete-before-put", "resurrected", {
        uploadToken: "restart-token",
        maxBytes: MAX_BYTES,
      })).rejects.toThrow("cancelled before publication");
    } finally {
      restarted.destroy();
    }
  });

  it("closes real concurrent put/delete races with a permanent tombstone", async () => {
    for (let index = 0; index < 12; index += 1) {
      const storageKey = `objects/race-${index}`;
      const [put, deletion] = await Promise.allSettled([
        first.putIfAbsent(storageKey, `sensitive-${index}`, {
          uploadToken: `writer-${index}`,
          maxBytes: MAX_BYTES,
        }),
        second.delete(storageKey, { uploadToken: `deleter-${index}` }),
      ]);
      expect(deletion.status).toBe("fulfilled");
      if (put.status === "rejected") expect(String(put.reason)).toContain("cancelled before publication");
      expect(await first.get(storageKey, { maxBytes: MAX_BYTES })).toBeNull();
      await expect(second.putIfAbsent(storageKey, "never-resurrect", {
        uploadToken: `late-${index}`,
        maxBytes: MAX_BYTES,
      })).rejects.toThrow("cancelled before publication");
    }
  }, 30_000);

  it("keeps equal storage keys isolated by configured prefix", async () => {
    await first.putIfAbsent("objects/prefix-isolation", "primary", {
      uploadToken: "primary",
      maxBytes: MAX_BYTES,
    });
    await isolated.putIfAbsent("objects/prefix-isolation", "isolated", {
      uploadToken: "isolated",
      maxBytes: MAX_BYTES,
    });
    expect((await first.get("objects/prefix-isolation", { maxBytes: MAX_BYTES }))?.data.toString()).toBe("primary");
    expect((await isolated.get("objects/prefix-isolation", { maxBytes: MAX_BYTES }))?.data.toString())
      .toBe("isolated");
    expect(isolated.namespaceSha256).not.toBe(first.namespaceSha256);
  });

  it("does not expose stored objects to an anonymous raw GET", async () => {
    const storageKey = "objects/private-raw-get";
    await first.putIfAbsent(storageKey, "private", {
      uploadToken: "private",
      maxBytes: MAX_BYTES,
    });
    const response = await fetch(anonymousObjectUrl(objectKey(storageKey)), {
      method: "GET",
      redirect: "manual",
    });
    await response.body?.cancel();
    expect([401, 403]).toContain(response.status);
  });

  it("cleans only an exact random test prefix", async () => {
    const removedKey = `${cleanupProofPrefix}/inside`;
    const survivorKey = `${cleanupSurvivorPrefix}/outside`;
    await firstClient.send(new PutObjectCommand({ Bucket: bucket, Key: removedKey, Body: "remove" }));
    await firstClient.send(new PutObjectCommand({ Bucket: bucket, Key: survivorKey, Body: "survive" }));

    await cleanupPrefix(firstClient, cleanupProofPrefix);
    expect(await listPrefix(firstClient, cleanupProofPrefix)).toEqual([]);
    await expect(firstClient.send(new HeadObjectCommand({ Bucket: bucket, Key: survivorKey }))).resolves.toBeDefined();
  });

  it("rejects a pre-existing bucket policy without deleting or replacing it", async () => {
    const statementId = `PreservePolicy${runId}`;
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: statementId,
        Effect: "Deny",
        Principal: "*",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucket}/*`,
      }],
    });
    await firstClient.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
    try {
      const beforeBootstrap = await firstClient.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      expect(beforeBootstrap.Policy).toContain(statementId);
      const bootstrap = spawnSync(process.execPath, [
        fileURLToPath(new URL("../scripts/bootstrap-s3.mjs", import.meta.url)),
      ], {
        env: {
          ...process.env,
          S3_TEST_ENDPOINT: endpoint.origin,
          S3_TEST_REGION: region,
          S3_TEST_BUCKET: bucket,
          S3_TEST_ACCESS_KEY_ID: accessKeyId,
          S3_TEST_SECRET_ACCESS_KEY: secretAccessKey,
          S3_TEST_FORCE_PATH_STYLE: forcePathStyle ? "1" : "0",
        },
        encoding: "utf8",
      });
      expect(bootstrap.error).toBeUndefined();
      expect(bootstrap.status).toBe(1);
      expect(bootstrap.stderr).toContain("S3 test bucket must not have an access policy");

      const preserved = await firstClient.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      expect(preserved.Policy).toBe(beforeBootstrap.Policy);
    } finally {
      await firstClient.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    }
  });
});
