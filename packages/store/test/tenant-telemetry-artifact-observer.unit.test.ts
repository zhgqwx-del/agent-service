import { Readable } from "node:stream";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  S3TenantTelemetryArtifactObserver,
  S3TenantTelemetryArtifactObservationConflictError,
  S3TenantTelemetryArtifactObservationTemporaryError,
  type TenantTelemetryS3ArtifactObservationInput,
} from "../src/tenant-telemetry-adapter/s3-artifact-observer.js";
import { tenantTelemetryS3ArtifactObjectKey } from "../src/tenant-telemetry-adapter/s3.js";
import {
  TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE,
} from "../src/tenant-telemetry-adapter/s3-codec.js";
import { TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE } from "../src/tenant-telemetry-adapter/s3-tombstone-codec.js";
import {
  artifactObserverDataBytes,
  artifactObserverFixture,
  artifactObserverMarkerBytes,
} from "./tenant-telemetry-artifact-observer.fixture.js";

const config = {
  bucket: "artifact-observer-unit",
  prefix: "telemetry-observer/unit",
  namespaceId: "observer-unit-namespace",
  failureDomainId: "observer-unit-domain",
  region: "us-east-1",
  endpoint: "https://s3.unit.invalid",
  forcePathStyle: true,
};
const authorizationReceiptSha256 = "a".repeat(64);

interface FakeObject {
  body: Buffer;
  contentType: string;
  etag: string;
  versionId?: string;
  deleteMarker?: boolean;
}

class ReadOnlyFakeS3 {
  readonly commands: string[] = [];
  readonly objects = new Map<string, FakeObject>();
  onFirstGet?: () => void;
  error?: Error;
  hang = false;
  lateResolveMs = 0;
  lateBody?: Readable;
  getCount = 0;

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    this.commands.push(command?.constructor?.name ?? "unknown");
    if (!(command instanceof GetObjectCommand)) throw new Error("observer attempted non-GET");
    this.getCount += 1;
    if (this.error) throw this.error;
    if (this.hang) {
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener("abort", () => reject(new Error("unsafe-secret")), {
          once: true,
        });
      });
    }
    const object = this.objects.get(command.input.Key ?? "");
    if (this.getCount === 1) this.onFirstGet?.();
    if (!object) {
      throw Object.assign(new Error("unsafe-private-object-key"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    }
    const output = {
      Body: this.lateBody ?? Readable.from([object.body.subarray(0, 9), object.body.subarray(9)]),
      ContentType: object.contentType,
      ContentLength: object.body.length,
      ETag: object.etag,
      ...(object.versionId === undefined ? {} : { VersionId: object.versionId }),
      ...(object.deleteMarker === undefined ? {} : { DeleteMarker: object.deleteMarker }),
    };
    if (this.lateResolveMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(output), this.lateResolveMs));
    }
    return output;
  }
}

async function fixture() {
  const prepared = await artifactObserverFixture(config);
  const client = new ReadOnlyFakeS3();
  const observer = new S3TenantTelemetryArtifactObserver({
    ...config,
    domain: "logs",
    expectedTarget: prepared.input.target,
    privateBucketAccessVerified: true,
    client: client as unknown as S3Client,
    operationTimeoutMs: 100,
  });
  const input: TenantTelemetryS3ArtifactObservationInput = {
    inventory: prepared.input.inventory,
    dispositionEvidence: prepared.evidence,
    expectedAuthorizationReceiptSha256: authorizationReceiptSha256,
  };
  const key = tenantTelemetryS3ArtifactObjectKey(config.prefix, {
    domain: prepared.input.inventory.domain,
    targetSha256: prepared.input.target.targetSha256,
    artifactIdSha256: prepared.input.inventory.artifactIdSha256,
    artifactGeneration: prepared.input.inventory.artifactGeneration,
  });
  const data = artifactObserverDataBytes(prepared.input);
  const marker = artifactObserverMarkerBytes(prepared.evidence, authorizationReceiptSha256);
  const seed = (body: Buffer, contentType: string, etag = '"object-1"') => {
    client.objects.set(key, { body, contentType, etag });
  };
  return { prepared, client, observer, input, key, data, marker, seed };
}

describe("0046 GET-only telemetry artifact observer", () => {
  it("observes exact data twice without exposing payload, ETag or authority", async () => {
    const f = await fixture();
    f.seed(f.data, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    const result = await f.observer.observe(f.input);
    expect(result).toEqual({
      status: "exact_data",
      grantReady: false,
      executionReady: false,
      externalAuthorityVerified: false,
      restoreFenceVerified: false,
      physicalAck: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-tenant|object-1|records/);
    expect(f.client.commands).toEqual(["GetObjectCommand", "GetObjectCommand"]);
    expect("tombstoneAuthorized" in f.observer).toBe(false);
    await f.observer.close();
  });

  it("observes only an exact matching same-key marker, never a physical ACK", async () => {
    const f = await fixture();
    f.seed(f.marker, TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE);
    expect(await f.observer.observe(f.input)).toMatchObject({
      status: "matching_tombstone",
      physicalAck: false,
      externalAuthorityVerified: false,
      restoreFenceVerified: false,
    });
    await expect(f.observer.observe({ ...f.input, expectedAuthorizationReceiptSha256: null }))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    await expect(f.observer.observe({
      ...f.input,
      expectedAuthorizationReceiptSha256: "b".repeat(64),
    })).rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
  });

  it("treats only two exact missing-key 404s as unknown", async () => {
    const f = await fixture();
    expect(await f.observer.observe(f.input)).toMatchObject({
      status: "unknown",
      physicalAck: false,
    });
    expect(f.client.commands).toEqual(["GetObjectCommand", "GetObjectCommand"]);
    f.client.error = Object.assign(new Error("unsafe-secret"), {
      name: "NoSuchBucket", $metadata: { httpStatusCode: 404 },
    });
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    f.client.error = Object.assign(new Error("unsafe-secret"), {
      name: "NoSuchKey", $metadata: { httpStatusCode: 500 },
    });
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationTemporaryError);
    f.client.error = Object.assign(new Error("unsafe-secret"), {
      name: "NoSuchKey", $metadata: { httpStatusCode: 404 },
      $response: { headers: { "x-amz-delete-marker": "true" } },
    });
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    f.client.error = Object.assign(new Error("unsafe-secret"), {
      name: "NoSuchKey", $metadata: { httpStatusCode: 404 }, VersionId: "null",
    });
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
  });

  it("rejects cross-tenant evidence, foreign target and tampered content", async () => {
    const f = await fixture();
    f.seed(f.data, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    const foreign = await artifactObserverFixture({ ...config, tenantId: "other-private-tenant" });
    await expect(f.observer.observe({
      ...f.input,
      inventory: foreign.input.inventory,
      dispositionEvidence: foreign.evidence,
    })).rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    expect(() => new S3TenantTelemetryArtifactObserver({
      ...config,
      domain: "traces",
      expectedTarget: f.prepared.input.target,
      privateBucketAccessVerified: true,
      client: f.client as unknown as S3Client,
    })).toThrow("target is invalid");
    const corrupt = Buffer.from(f.data);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    f.seed(corrupt, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    const corruptMarker = Buffer.from(f.marker);
    corruptMarker[corruptMarker.length - 1] = corruptMarker[corruptMarker.length - 1]! ^ 1;
    f.seed(corruptMarker, TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE);
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
  });

  it("rejects version/delete-marker evidence and changing GET responses", async () => {
    const f = await fixture();
    f.seed(f.data, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    f.client.objects.get(f.key)!.versionId = "unexpected-version";
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    delete f.client.objects.get(f.key)!.versionId;
    f.client.objects.get(f.key)!.deleteMarker = false;
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    delete f.client.objects.get(f.key)!.deleteMarker;
    f.client.getCount = 0;
    f.client.onFirstGet = () => f.seed(f.marker, TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE, '"object-2"');
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationTemporaryError);
    expect(f.client.commands.every((name) => name === "GetObjectCommand")).toBe(true);
    f.client.getCount = 0;
    f.seed(f.data, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    const changed = Buffer.from(f.data);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    f.client.onFirstGet = () => f.seed(changed, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationTemporaryError);
  });

  it("rejects wrong content type and oversized bodies before interpreting bytes", async () => {
    const f = await fixture();
    f.seed(f.data, "text/plain");
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
    f.seed(Buffer.alloc(300_000), TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationConflictError);
  });

  it("bounds the full read and never propagates secret-bearing transport errors", async () => {
    const f = await fixture();
    f.client.hang = true;
    const error = await f.observer.observe(f.input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(S3TenantTelemetryArtifactObservationTemporaryError);
    expect(String(error)).not.toMatch(/unsafe-secret|private-tenant/);
    expect(f.client.commands).toEqual(["GetObjectCommand"]);
  });

  it("destroys a GET body that a non-conforming client resolves after timeout", async () => {
    const f = await fixture();
    f.seed(f.data, TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE);
    const lateBody = Readable.from([f.data]);
    const destroy = vi.spyOn(lateBody, "destroy");
    f.client.lateBody = lateBody;
    f.client.lateResolveMs = 150;
    await expect(f.observer.observe(f.input))
      .rejects.toBeInstanceOf(S3TenantTelemetryArtifactObservationTemporaryError);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(destroy).toHaveBeenCalled();
  });
});
