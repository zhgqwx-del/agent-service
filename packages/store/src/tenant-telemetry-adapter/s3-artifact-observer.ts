import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  validateTenantTelemetryDispositionEvidence,
  type TenantTelemetryDispositionEvidence,
} from "../tenant-telemetry-disposition.js";
import {
  validateTenantTelemetryArtifactInventory,
  validateTenantTelemetryLifecycleTarget,
  type TenantTelemetryArtifactInventoryRecord,
  type TenantTelemetryLifecycleTargetRecord,
} from "../tenant-telemetry-lifecycle.js";
import {
  tenantTelemetryArtifactManifestSha256,
  tenantTelemetryArtifactPayloadCanonicalJson,
  tenantTelemetryArtifactPayloadSha256,
  tenantTelemetryWriteOperationSha256,
  type TenantTelemetryArtifactPayload,
} from "../tenant-telemetry-writer.js";
import {
  TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES,
  TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES,
  TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES,
  TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE,
  decodeTenantTelemetryS3Envelope,
} from "./s3-codec.js";
import {
  TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE,
  TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES,
  TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES,
  decodeTenantTelemetryS3Tombstone,
} from "./s3-tombstone-codec.js";
import {
  S3_TENANT_TELEMETRY_SINK_PROTOCOL,
  S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
  s3TenantTelemetryTargetIdentity,
  tenantTelemetryS3ArtifactObjectKey,
  type S3TenantTelemetryTargetIdentityInput,
} from "./s3.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = Math.max(
  TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES
    + TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES
    + TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES,
  TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES + TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES,
);

export interface S3TenantTelemetryArtifactObserverOptions
  extends Omit<S3TenantTelemetryTargetIdentityInput, "prefix"> {
  prefix: string;
  /** The observation target must be the exact immutable 0033 target for this S3 namespace. */
  expectedTarget: TenantTelemetryLifecycleTargetRecord;
  /** Operator assertion, not automated proof of private IAM or an independent failure domain. */
  privateBucketAccessVerified: true;
  credentials?: S3ClientConfig["credentials"];
  client?: S3Client;
  operationTimeoutMs?: number;
}

/** Source evidence is supplied by the caller; this type does not attest to DB grant provenance. */
export interface TenantTelemetryS3ArtifactObservationInput {
  inventory: TenantTelemetryArtifactInventoryRecord;
  dispositionEvidence: TenantTelemetryDispositionEvidence;
  /** Null permits data observation only. A digest merely selects an exact marker; it is not a grant. */
  expectedAuthorizationReceiptSha256: string | null;
}

export interface TenantTelemetryS3ArtifactObservation {
  status: "exact_data" | "matching_tombstone" | "unknown";
  grantReady: false;
  executionReady: false;
  externalAuthorityVerified: false;
  restoreFenceVerified: false;
  physicalAck: false;
}

export class S3TenantTelemetryArtifactObservationConflictError extends Error {
  constructor() {
    super("S3 telemetry artifact observation conflicts with exact evidence");
    this.name = "S3TenantTelemetryArtifactObservationConflictError";
  }
}

export class S3TenantTelemetryArtifactObservationTemporaryError extends Error {
  constructor() {
    super("S3 telemetry artifact observation is temporarily unavailable");
    this.name = "S3TenantTelemetryArtifactObservationTemporaryError";
  }
}

interface StoredObject {
  etag: string;
  contentType: string;
  bytes: Buffer;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" ? error as Record<string, unknown> : null;
}

function versionEvidence(error: unknown): boolean {
  const value = errorRecord(error);
  if (!value) return false;
  try {
    for (const candidate of [value, value.$metadata, value.$response]) {
      const record = errorRecord(candidate);
      if (!record) continue;
      if (["VersionId", "versionId", "DeleteMarker", "deleteMarker"]
        .some((key) => record[key] !== undefined)) return true;
      const headers = errorRecord(record.headers ?? record.httpHeaders);
      if (!headers) continue;
      if (typeof headers.get === "function") {
        if (headers.get("x-amz-version-id") != null
          || headers.get("x-amz-delete-marker") != null) return true;
      }
      if (Object.entries(headers).some(([key, header]) =>
        (key.toLowerCase() === "x-amz-version-id"
          || key.toLowerCase() === "x-amz-delete-marker") && header !== undefined)) return true;
    }
  } catch {
    // Malformed SDK metadata is never evidence of an ordinary absent key.
    return true;
  }
  return false;
}

function exactMissingKey(error: unknown): boolean {
  const record = errorRecord(error);
  const metadata = errorRecord(record?.$metadata);
  return (record?.name === "NoSuchKey" || record?.name === "NoSuchObject")
    && metadata?.httpStatusCode === 404
    && !versionEvidence(error);
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return;
  try { destroy.call(body); } catch { /* Preserve the primary failure. */ }
}

function observation(status: TenantTelemetryS3ArtifactObservation["status"]): TenantTelemetryS3ArtifactObservation {
  return {
    status,
    grantReady: false,
    executionReady: false,
    externalAuthorityVerified: false,
    restoreFenceVerified: false,
    physicalAck: false,
  };
}

/** GET-only diagnostic. No journal, grant, mutation, physical ACK or product runtime wiring. */
export class S3TenantTelemetryArtifactObserver {
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly target: TenantTelemetryLifecycleTargetRecord;
  private readonly operationTimeoutMs: number;
  private closed = false;

  constructor(options: S3TenantTelemetryArtifactObserverOptions) {
    if (options.privateBucketAccessVerified !== true || typeof options.prefix !== "string") {
      throw new Error("S3 telemetry artifact observer requires an exact private target");
    }
    const identity = s3TenantTelemetryTargetIdentity(options);
    try {
      validateTenantTelemetryLifecycleTarget(options.expectedTarget);
      if (options.expectedTarget.backendKind !== identity.backendKind
        || options.expectedTarget.adapterProtocol !== identity.adapterProtocol
        || options.expectedTarget.domain !== options.domain
        || options.expectedTarget.namespaceSha256 !== identity.namespaceSha256
        || options.expectedTarget.failureDomainSha256 !== identity.failureDomainSha256) {
        throw new Error("target mismatch");
      }
    } catch {
      throw new Error("S3 telemetry artifact observer target is invalid");
    }
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.target = structuredClone(options.expectedTarget);
    this.operationTimeoutMs = options.operationTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.operationTimeoutMs)
      || this.operationTimeoutMs < 100 || this.operationTimeoutMs > 30_000) {
      throw new Error("S3 telemetry artifact observer timeout is invalid");
    }
    this.ownsClient = options.client === undefined;
    this.client = options.client ?? new S3Client({
      region: options.region,
      ...(options.endpoint === null ? {} : { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle,
      ignoreConfiguredEndpointUrls: true,
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      useAccelerateEndpoint: false,
      useGlobalEndpoint: false,
      useArnRegion: false,
      disableMultiregionAccessPoints: true,
      followRegionRedirects: false,
      bucketEndpoint: false,
      maxAttempts: 2,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  private validateInput(input: TenantTelemetryS3ArtifactObservationInput): void {
    try {
      const keys = Object.keys(input).sort();
      if (keys.join(",") !== ["dispositionEvidence", "expectedAuthorizationReceiptSha256", "inventory"].join(",")) {
        throw new Error("input shape");
      }
      validateTenantTelemetryArtifactInventory(input.inventory);
      validateTenantTelemetryDispositionEvidence(input.dispositionEvidence);
      const inventory = input.inventory;
      const evidence = input.dispositionEvidence;
      if (inventory.targetSha256 !== this.target.targetSha256
        || inventory.domain !== this.target.domain
        || evidence.targetSha256 !== this.target.targetSha256
        || evidence.domain !== inventory.domain
        || evidence.artifactIdSha256 !== inventory.artifactIdSha256
        || evidence.artifactGeneration !== inventory.artifactGeneration
        || evidence.inventorySha256 !== inventory.inventorySha256
        || evidence.inventoryReceiptSha256 !== inventory.receiptSha256
        || evidence.payloadSha256 !== inventory.payloadSha256
        || evidence.manifestSha256 !== inventory.manifestSha256
        || evidence.writeOperationSha256 !== tenantTelemetryWriteOperationSha256(inventory.manifestSha256)
        || inventory.manifestSha256 !== tenantTelemetryArtifactManifestSha256({
          tenantId: inventory.tenantId,
          controlGeneration: inventory.controlGeneration,
          domain: inventory.domain,
          targetSha256: inventory.targetSha256,
          artifactIdSha256: inventory.artifactIdSha256,
          artifactGeneration: inventory.artifactGeneration,
          ownerKind: inventory.ownerKind,
          tenantRefSha256: inventory.tenantRefSha256,
          ownerRefSha256: inventory.ownerRefSha256,
          holdSubjectRefSha256: inventory.holdSubjectRefSha256,
          coverageEvidenceSha256: inventory.coverageEvidenceSha256,
          sourceSchema: inventory.sourceSchema,
          sourceGeneration: inventory.sourceGeneration,
          sourceHighWaterDbMs: inventory.sourceHighWaterDbMs,
          payloadSha256: inventory.payloadSha256,
        })
        || (input.expectedAuthorizationReceiptSha256 !== null
          && (typeof input.expectedAuthorizationReceiptSha256 !== "string"
            || !SHA256.test(input.expectedAuthorizationReceiptSha256)))) {
        throw new Error("source mismatch");
      }
    } catch {
      throw new S3TenantTelemetryArtifactObservationConflictError();
    }
  }

  private remaining(deadline: number): number {
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) throw new S3TenantTelemetryArtifactObservationTemporaryError();
    return left;
  }

  private async sendGet(key: string, deadline: number): Promise<GetObjectCommandOutput | null> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new S3TenantTelemetryArtifactObservationTemporaryError());
        controller.abort();
      }, this.remaining(deadline));
      timer.unref();
    });
    const request = Promise.resolve().then(() => this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: controller.signal },
    )).then((output) => {
      // A non-conforming client may resolve after abort/deadline. Never leave its stream open.
      if (timedOut) destroyBody(output.Body);
      return output;
    });
    void request.catch(() => undefined);
    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (exactMissingKey(error)) return null;
      const status = errorRecord(errorRecord(error)?.$metadata)?.httpStatusCode;
      if (versionEvidence(error) || status === 404) {
        throw new S3TenantTelemetryArtifactObservationConflictError();
      }
      throw new S3TenantTelemetryArtifactObservationTemporaryError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async boundedBody(output: GetObjectCommandOutput, deadline: number): Promise<Buffer> {
    if (output.ContentLength !== undefined
      && (!Number.isSafeInteger(output.ContentLength)
        || output.ContentLength < 0 || output.ContentLength > MAX_BYTES)) {
      destroyBody(output.Body);
      throw new S3TenantTelemetryArtifactObservationConflictError();
    }
    const body = output.Body;
    if (!(body instanceof Uint8Array)
      && (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
        !== "function")) {
      destroyBody(body);
      throw new S3TenantTelemetryArtifactObservationConflictError();
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        destroyBody(body);
        reject(new S3TenantTelemetryArtifactObservationTemporaryError());
      }, this.remaining(deadline));
      timer.unref();
    });
    const read = (async () => {
      const iterable = body instanceof Uint8Array
        ? (async function* () { yield body; })()
        : body as AsyncIterable<Uint8Array>;
      for await (const chunk of iterable) {
        if (!(chunk instanceof Uint8Array)) throw new S3TenantTelemetryArtifactObservationConflictError();
        length += chunk.byteLength;
        if (length > MAX_BYTES) throw new S3TenantTelemetryArtifactObservationConflictError();
        chunks.push(Buffer.from(chunk));
      }
    })();
    void read.catch(() => undefined);
    try {
      await Promise.race([read, timeout]);
      this.remaining(deadline);
      if (output.ContentLength !== undefined && length !== output.ContentLength) {
        throw new S3TenantTelemetryArtifactObservationConflictError();
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      destroyBody(body);
      if (error instanceof S3TenantTelemetryArtifactObservationConflictError
        || error instanceof S3TenantTelemetryArtifactObservationTemporaryError) throw error;
      throw new S3TenantTelemetryArtifactObservationTemporaryError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
    }
  }

  private async readOnce(key: string, deadline: number): Promise<StoredObject | null> {
    const output = await this.sendGet(key, deadline);
    if (!output) return null;
    if (output.VersionId !== undefined || output.DeleteMarker !== undefined
      || typeof output.ETag !== "string" || output.ETag.length < 1
      || output.ETag.length > 512
      || (output.ContentType !== TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE
        && output.ContentType !== TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE)) {
      destroyBody(output.Body);
      throw new S3TenantTelemetryArtifactObservationConflictError();
    }
    return {
      etag: output.ETag,
      contentType: output.ContentType,
      bytes: await this.boundedBody(output, deadline),
    };
  }

  private validateStored(input: TenantTelemetryS3ArtifactObservationInput, stored: StoredObject):
    TenantTelemetryS3ArtifactObservation["status"] {
    const inventory = input.inventory;
    const evidence = input.dispositionEvidence;
    try {
      if (stored.contentType === TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE) {
        const decoded = decodeTenantTelemetryS3Envelope(stored.bytes);
        const metadataJson = JSON.stringify({
          protocol: S3_TENANT_TELEMETRY_SINK_PROTOCOL,
          adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
          targetSha256: this.target.targetSha256,
          targetReceiptSha256: this.target.receiptSha256,
          domain: inventory.domain,
          writeOperationSha256: evidence.writeOperationSha256,
          artifactIdSha256: inventory.artifactIdSha256,
          artifactGeneration: inventory.artifactGeneration,
          inventorySha256: inventory.inventorySha256,
          inventoryReceiptSha256: inventory.receiptSha256,
          payloadSha256: inventory.payloadSha256,
          manifestSha256: inventory.manifestSha256,
        });
        const payload = JSON.parse(decoded.payloadJson) as TenantTelemetryArtifactPayload;
        if (decoded.metadataJson !== metadataJson
          || decoded.payloadJson !== tenantTelemetryArtifactPayloadCanonicalJson(payload)
          || tenantTelemetryArtifactPayloadSha256(payload) !== inventory.payloadSha256) {
          throw new Error("artifact mismatch");
        }
        return "exact_data";
      }
      if (input.expectedAuthorizationReceiptSha256 === null) {
        throw new Error("marker was not expected");
      }
      const bodyJson = decodeTenantTelemetryS3Tombstone(stored.bytes);
      const parsed = JSON.parse(bodyJson) as Record<string, unknown>;
      const originalObjectEtagSha256 = parsed.originalObjectEtagSha256;
      if (typeof originalObjectEtagSha256 !== "string"
        || !SHA256.test(originalObjectEtagSha256)
        || bodyJson !== JSON.stringify({
          protocol: "telemetry-s3-same-key-tombstone-v1",
          ...evidence,
          authorizationReceiptSha256: input.expectedAuthorizationReceiptSha256,
          originalObjectEtagSha256,
        })) {
        throw new Error("marker mismatch");
      }
      return "matching_tombstone";
    } catch {
      throw new S3TenantTelemetryArtifactObservationConflictError();
    }
  }

  async observe(input: TenantTelemetryS3ArtifactObservationInput):
    Promise<TenantTelemetryS3ArtifactObservation> {
    if (this.closed) throw new S3TenantTelemetryArtifactObservationTemporaryError();
    this.validateInput(input);
    const deadline = performance.now() + this.operationTimeoutMs;
    const key = tenantTelemetryS3ArtifactObjectKey(this.prefix, {
      domain: input.inventory.domain,
      targetSha256: this.target.targetSha256,
      artifactIdSha256: input.inventory.artifactIdSha256,
      artifactGeneration: input.inventory.artifactGeneration,
    });
    let first: StoredObject | null = null;
    let second: StoredObject | null = null;
    try {
      first = await this.readOnce(key, deadline);
      second = await this.readOnce(key, deadline);
      if (!first && !second) return observation("unknown");
      if (!first || !second || first.etag !== second.etag
        || first.contentType !== second.contentType
        || sha256(first.bytes) !== sha256(second.bytes)) {
        throw new S3TenantTelemetryArtifactObservationTemporaryError();
      }
      return observation(this.validateStored(input, first));
    } finally {
      first?.bytes.fill(0);
      second?.bytes.fill(0);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }
}
