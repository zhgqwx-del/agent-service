import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  tenantTelemetryArtifactPayloadCanonicalJson,
  type TenantTelemetryWriteAdapterResult,
} from "../tenant-telemetry-writer.js";
import {
  validateTenantTelemetryLifecycleTarget,
  type TenantTelemetryDomain,
  type TenantTelemetryLifecycleTargetRecord,
} from "../tenant-telemetry-lifecycle.js";
import {
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  tenantTelemetryWriteAdapterResult,
  validateTenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteInspection,
} from "./common.js";
import {
  TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES,
  TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES,
  TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES,
  TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE,
  decodeTenantTelemetryS3Envelope,
  encodeTenantTelemetryS3Envelope,
} from "./s3-codec.js";

export const S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL =
  "telemetry-s3-object-v1" as const;
export const S3_TENANT_TELEMETRY_BACKEND_KIND = "s3" as const;
export const S3_TENANT_TELEMETRY_SINK_PROTOCOL =
  "agent-service.telemetry-s3-sink.v1" as const;

const DEFAULT_PREFIX = "tenant-telemetry";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SDK_ATTEMPTS = 2;
const SHA256 = /^[a-f0-9]{64}$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MAX_ENVELOPE_BYTES = TENANT_TELEMETRY_S3_ENVELOPE_HEADER_BYTES
  + TENANT_TELEMETRY_S3_ENVELOPE_MAX_METADATA_BYTES
  + TENANT_TELEMETRY_S3_ENVELOPE_MAX_PAYLOAD_BYTES;
const SAFE_S3_ERROR_NAMES = new Set([
  "AbortError",
  "AccessDenied",
  "CredentialsProviderError",
  "InternalError",
  "InvalidAccessKeyId",
  "InvalidRequest",
  "NetworkingError",
  "NoSuchBucket",
  "ServiceUnavailable",
  "SignatureDoesNotMatch",
  "SlowDown",
  "TimeoutError",
]);

export interface S3TenantTelemetryTargetIdentityInput {
  /** Non-secret logical identity for this managed namespace. */
  namespaceId: string;
  /** Non-secret provider/account/region fault-domain identity. */
  failureDomainId: string;
  bucket: string;
  prefix?: string;
  region: string;
  /** `null` explicitly selects the SDK standard endpoint for `region`. */
  endpoint: string | null;
  forcePathStyle: boolean;
  domain: TenantTelemetryDomain;
  /** Test-only opt in; cleartext endpoints remain limited to loopback names. */
  allowInsecureHttpForLocalTest?: true;
}

export interface S3TenantTelemetryTargetIdentity {
  backendKind: typeof S3_TENANT_TELEMETRY_BACKEND_KIND;
  adapterProtocol: typeof S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  namespaceSha256: string;
  failureDomainSha256: string;
}

export interface S3TenantTelemetryWriteAdapterOptions
  extends Omit<S3TenantTelemetryTargetIdentityInput, "domain"> {
  /** The operator has independently verified that anonymous/public object reads are denied. */
  privateBucketAcknowledged: true;
  /** Exact immutable 0033 targets that this adapter is allowed to serve. */
  expectedTargets: readonly TenantTelemetryLifecycleTargetRecord[];
  credentials?: S3ClientConfig["credentials"];
  client?: S3Client;
  requestTimeoutMs?: number;
}

interface StoredTenantTelemetryObjectMetadata {
  protocol: typeof S3_TENANT_TELEMETRY_SINK_PROTOCOL;
  adapterProtocol: typeof S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  targetSha256: string;
  targetReceiptSha256: string;
  domain: TenantTelemetryDomain;
  writeOperationSha256: string;
  artifactIdSha256: string;
  artifactGeneration: number;
  inventorySha256: string;
  inventoryReceiptSha256: string;
  payloadSha256: string;
  manifestSha256: string;
}

interface CanonicalTenantTelemetryObject {
  metadata: StoredTenantTelemetryObjectMetadata;
  metadataJson: string;
  payloadJson: string;
  envelope: Buffer;
}

class S3TenantTelemetrySafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3TenantTelemetryError";
  }
}

class S3TenantTelemetryVersionedObjectError
  extends TenantTelemetryWriteAdapterConflictError {
  constructor() {
    super();
    this.name = "S3TenantTelemetryVersionedObjectError";
  }
}

class S3TenantTelemetryOperationDeadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number) {
    this.expiresAt = performance.now() + timeoutMs;
  }

  remainingMs(): number {
    const remaining = Math.ceil(this.expiresAt - performance.now());
    if (remaining <= 0) {
      throw Object.assign(new Error("S3 tenant telemetry request timed out"), {
        name: "TimeoutError",
      });
    }
    return remaining;
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function sanitizedS3Error(operation: string, error: unknown): S3TenantTelemetrySafeError {
  const status = errorStatus(error);
  const name = errorName(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const detail = [safeName, status === undefined ? undefined : String(status)]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3TenantTelemetrySafeError(
    `S3 tenant telemetry ${operation} failed${detail ? ` (${detail})` : ""}`,
  );
}

function isMissingObject(error: unknown): boolean {
  const name = errorName(error);
  // A bare 404 is ambiguous: a missing bucket or bad endpoint is not an absent immutable slot.
  return name === "NoSuchKey" || name === "NotFound" || name === "NoSuchObject";
}

function isConditionalConflict(error: unknown): boolean {
  const status = errorStatus(error);
  const name = errorName(error);
  return status === 409
    || status === 412
    || name === "PreconditionFailed"
    || name === "ConditionalRequestConflict";
}

function assertUnversionedEvidence(output: { VersionId?: string; DeleteMarker?: boolean }): void {
  if (output.VersionId !== undefined || output.DeleteMarker === true) {
    throw new S3TenantTelemetryVersionedObjectError();
  }
}

function validateBucket(bucket: string): string {
  if (typeof bucket !== "string"
    || bucket.length < 3
    || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
    || bucket.includes(".-")
    || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error("S3 tenant telemetry bucket is invalid");
  }
  return bucket;
}

function validatePrefix(prefix: string): string {
  if (typeof prefix !== "string"
    || prefix.length < 1
    || prefix.length > 512
    || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))) {
    throw new Error("S3 tenant telemetry prefix is invalid");
  }
  return prefix;
}

function validateLogicalId(value: string, name: "namespace" | "failure domain"): string {
  if (typeof value !== "string" || !LOGICAL_ID.test(value)) {
    throw new Error(`S3 tenant telemetry ${name} id is invalid`);
  }
  return value;
}

function validateRegion(region: string): string {
  if (typeof region !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new Error("S3 tenant telemetry region is invalid");
  }
  return region;
}

function normalizeEndpoint(
  endpoint: string | null,
  allowInsecureHttpForLocalTest: true | undefined,
): string | null {
  if (endpoint === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("S3 tenant telemetry endpoint is invalid");
  }
  const localHttp = allowInsecureHttpForLocalTest === true
    && process.env.NODE_ENV !== "production"
    && parsed.protocol === "http:"
    && LOCAL_HOSTS.has(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash) {
    throw new Error(
      "S3 tenant telemetry endpoint must be a credential-free HTTPS origin",
    );
  }
  return parsed.origin;
}

function validateDomain(domain: TenantTelemetryDomain): TenantTelemetryDomain {
  if (domain !== "logs" && domain !== "traces") {
    throw new Error("S3 tenant telemetry domain is invalid");
  }
  return domain;
}

function targetIdentityValues(input: S3TenantTelemetryTargetIdentityInput): {
  namespaceId: string;
  failureDomainId: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  domain: TenantTelemetryDomain;
} {
  const namespaceId = validateLogicalId(input.namespaceId, "namespace");
  const failureDomainId = validateLogicalId(input.failureDomainId, "failure domain");
  const bucket = validateBucket(input.bucket);
  const prefix = validatePrefix(input.prefix ?? DEFAULT_PREFIX);
  const region = validateRegion(input.region);
  const endpoint = normalizeEndpoint(input.endpoint, input.allowInsecureHttpForLocalTest);
  if (typeof input.forcePathStyle !== "boolean") {
    throw new Error("S3 tenant telemetry addressing mode is invalid");
  }
  const domain = validateDomain(input.domain);
  return {
    namespaceId,
    failureDomainId,
    bucket,
    prefix,
    region,
    endpoint,
    forcePathStyle: input.forcePathStyle,
    domain,
  };
}

/**
 * Build the credential-free 0033 target material. Endpoint mode and normalized origin are bound,
 * while credentials are deliberately absent. Each domain gets its own namespace identity.
 */
export function s3TenantTelemetryTargetIdentity(
  input: S3TenantTelemetryTargetIdentityInput,
): S3TenantTelemetryTargetIdentity {
  const value = targetIdentityValues(input);
  const failureDomainSha256 = sha256([
    "tenant-telemetry-s3-failure-domain-v1",
    value.failureDomainId,
  ]);
  return {
    backendKind: S3_TENANT_TELEMETRY_BACKEND_KIND,
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    namespaceSha256: sha256([
      "tenant-telemetry-s3-namespace-v1",
      value.namespaceId,
      failureDomainSha256,
      value.bucket,
      value.prefix,
      value.region,
      value.endpoint === null ? "standard-endpoint" : "custom-endpoint",
      value.endpoint ?? "",
      value.forcePathStyle ? "path-style" : "virtual-hosted-style",
      value.domain,
    ]),
    failureDomainSha256,
  };
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

const STORED_METADATA_KEYS = [
  "protocol",
  "adapterProtocol",
  "targetSha256",
  "targetReceiptSha256",
  "domain",
  "writeOperationSha256",
  "artifactIdSha256",
  "artifactGeneration",
  "inventorySha256",
  "inventoryReceiptSha256",
  "payloadSha256",
  "manifestSha256",
] as const;

function canonicalObject(input: TenantTelemetryWriteAdapterInput): CanonicalTenantTelemetryObject {
  const payload = validateTenantTelemetryWriteAdapterInput(input);
  const metadata: StoredTenantTelemetryObjectMetadata = {
    protocol: S3_TENANT_TELEMETRY_SINK_PROTOCOL,
    adapterProtocol: S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL,
    targetSha256: input.target.targetSha256,
    targetReceiptSha256: input.target.receiptSha256,
    domain: input.inventory.domain,
    writeOperationSha256: input.writeOperationSha256,
    artifactIdSha256: input.inventory.artifactIdSha256,
    artifactGeneration: input.inventory.artifactGeneration,
    inventorySha256: input.inventory.inventorySha256,
    inventoryReceiptSha256: input.inventory.receiptSha256,
    payloadSha256: input.inventory.payloadSha256,
    manifestSha256: input.inventory.manifestSha256,
  };
  const metadataJson = JSON.stringify(metadata);
  const payloadJson = tenantTelemetryArtifactPayloadCanonicalJson(payload);
  return {
    metadata,
    metadataJson,
    payloadJson,
    envelope: encodeTenantTelemetryS3Envelope(metadataJson, payloadJson),
  };
}

function parseMetadata(value: string): StoredTenantTelemetryObjectMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !exactKeys(parsed, STORED_METADATA_KEYS)) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  const metadata = parsed as Record<string, unknown>;
  if (metadata.protocol !== S3_TENANT_TELEMETRY_SINK_PROTOCOL
    || metadata.adapterProtocol !== S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL
    || (metadata.domain !== "logs" && metadata.domain !== "traces")
    || typeof metadata.targetSha256 !== "string" || !SHA256.test(metadata.targetSha256)
    || typeof metadata.targetReceiptSha256 !== "string"
      || !SHA256.test(metadata.targetReceiptSha256)
    || typeof metadata.writeOperationSha256 !== "string"
      || !SHA256.test(metadata.writeOperationSha256)
    || typeof metadata.artifactIdSha256 !== "string"
      || !SHA256.test(metadata.artifactIdSha256)
    || !Number.isSafeInteger(metadata.artifactGeneration)
      || Number(metadata.artifactGeneration) < 1
    || typeof metadata.inventorySha256 !== "string" || !SHA256.test(metadata.inventorySha256)
    || typeof metadata.inventoryReceiptSha256 !== "string"
      || !SHA256.test(metadata.inventoryReceiptSha256)
    || typeof metadata.payloadSha256 !== "string" || !SHA256.test(metadata.payloadSha256)
    || typeof metadata.manifestSha256 !== "string" || !SHA256.test(metadata.manifestSha256)) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  return metadata as unknown as StoredTenantTelemetryObjectMetadata;
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return;
  try {
    destroy.call(body);
  } catch {
    // Preserve the primary protocol, size, or transport failure.
  }
}

function bodyAsAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) return (async function* () { yield body; })();
  if (!body
    || (typeof body !== "object" && typeof body !== "function")
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
      !== "function") {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  return body as AsyncIterable<Uint8Array>;
}

async function readBoundedBody(
  body: unknown,
  contentLength: number | undefined,
  deadline: S3TenantTelemetryOperationDeadline,
): Promise<Buffer> {
  if (contentLength !== undefined
    && (!Number.isSafeInteger(contentLength) || contentLength < 0
      || contentLength > MAX_ENVELOPE_BYTES)) {
    destroyBody(body);
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remainingMs = deadline.remainingMs();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      destroyBody(body);
      reject(new TenantTelemetryWriteAdapterTemporaryError());
    }, remainingMs);
    timer.unref();
  });
  const read = (async () => {
    for await (const chunk of bodyAsAsyncIterable(body)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      total += chunk.byteLength;
      if (total > MAX_ENVELOPE_BYTES) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      // Copy each chunk immediately. Some SDK/body implementations reuse a mutable backing
      // buffer between iterator yields; retaining a view could otherwise change already-validated
      // bytes before the final concatenation.
      chunks.push(Buffer.from(chunk));
    }
  })();
  void read.catch(() => undefined);
  try {
    await Promise.race([read, timeout]);
  } catch (error) {
    destroyBody(body);
    if (error instanceof TenantTelemetryWriteAdapterConflictError
      || error instanceof TenantTelemetryWriteAdapterTemporaryError) throw error;
    throw new TenantTelemetryWriteAdapterTemporaryError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (contentLength !== undefined && total !== contentLength) {
    throw new TenantTelemetryWriteAdapterConflictError();
  }
  deadline.remainingMs();
  return Buffer.concat(chunks, total);
}

/**
 * Managed S3-compatible write adapter. Artifact publication is create-only. This class deliberately
 * exposes no artifact delete/tombstone operation; that protocol belongs to the later lifecycle
 * execution ledger and cannot be inferred from a successful write.
 */
export class S3TenantTelemetryWriteAdapter implements TenantTelemetryWriteAdapter {
  readonly adapterProtocol = S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  readonly bucket: string;
  readonly prefix: string;

  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly requestTimeoutMs: number;
  private readonly expectedTargets = new Map<string, TenantTelemetryLifecycleTargetRecord>();
  private closed = false;

  constructor(options: S3TenantTelemetryWriteAdapterOptions) {
    if (options.privateBucketAcknowledged !== true) {
      throw new Error("S3 tenant telemetry requires a private-bucket acknowledgement");
    }
    this.bucket = validateBucket(options.bucket);
    this.prefix = validatePrefix(options.prefix ?? DEFAULT_PREFIX);
    const region = validateRegion(options.region);
    const endpoint = normalizeEndpoint(options.endpoint, options.allowInsecureHttpForLocalTest);
    validateLogicalId(options.namespaceId, "namespace");
    validateLogicalId(options.failureDomainId, "failure domain");
    if (typeof options.forcePathStyle !== "boolean") {
      throw new Error("S3 tenant telemetry addressing mode is invalid");
    }
    if (!Array.isArray(options.expectedTargets)
      || options.expectedTargets.length < 1
      || options.expectedTargets.length > 2) {
      throw new Error("S3 tenant telemetry target configuration is invalid");
    }
    const domains = new Set<TenantTelemetryDomain>();
    for (const target of options.expectedTargets) {
      try {
        validateTenantTelemetryLifecycleTarget(target);
        const identity = s3TenantTelemetryTargetIdentity({
          namespaceId: options.namespaceId,
          failureDomainId: options.failureDomainId,
          bucket: this.bucket,
          prefix: this.prefix,
          region,
          endpoint,
          forcePathStyle: options.forcePathStyle,
          domain: target.domain,
          ...(options.allowInsecureHttpForLocalTest === true
            ? { allowInsecureHttpForLocalTest: true as const }
            : {}),
        });
        if (target.adapterProtocol !== identity.adapterProtocol
          || target.backendKind !== identity.backendKind
          || target.namespaceSha256 !== identity.namespaceSha256
          || target.failureDomainSha256 !== identity.failureDomainSha256
          || domains.has(target.domain)
          || this.expectedTargets.has(target.targetSha256)) {
          throw new Error("target mismatch");
        }
        domains.add(target.domain);
        this.expectedTargets.set(target.targetSha256, structuredClone(target));
      } catch {
        throw new Error("S3 tenant telemetry target configuration is invalid");
      }
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error(
        `S3 tenant telemetry request timeout must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
    this.ownsClient = options.client === undefined;
    this.client = options.client ?? new S3Client({
      region,
      ...(endpoint === null ? {} : { endpoint }),
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
      maxAttempts: DEFAULT_SDK_ATTEMPTS,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new TenantTelemetryWriteAdapterTemporaryError();
  }

  private assertInput(input: TenantTelemetryWriteAdapterInput): CanonicalTenantTelemetryObject {
    this.assertOpen();
    const expected = this.expectedTargets.get(input.target.targetSha256);
    if (!expected
      || input.target.adapterProtocol !== this.adapterProtocol
      || input.target.receiptSha256 !== expected.receiptSha256) {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    try {
      return canonicalObject(input);
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }

  private objectKey(input: TenantTelemetryWriteAdapterInput): string {
    return [
      this.prefix,
      "v1",
      input.inventory.domain,
      input.target.targetSha256.slice(0, 2),
      input.target.targetSha256,
      input.inventory.artifactIdSha256.slice(0, 2),
      input.inventory.artifactIdSha256,
      `${input.inventory.artifactGeneration}.astelm`,
    ].join("/");
  }

  private async send<Output>(
    deadline: S3TenantTelemetryOperationDeadline,
    request: (abortSignal: AbortSignal) => Promise<Output>,
  ): Promise<Output> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remainingMs = deadline.remainingMs();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error("S3 tenant telemetry request timed out"), {
          name: "TimeoutError",
        });
        reject(error);
        controller.abort(error);
      }, remainingMs);
      timer.unref();
    });
    const operation = Promise.resolve().then(() => request(controller.signal));
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readObject(
    key: string,
    deadline: S3TenantTelemetryOperationDeadline,
  ): Promise<GetObjectCommandOutput | null> {
    try {
      return await this.send(deadline, (abortSignal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw sanitizedS3Error("read", error);
    }
  }

  private exactStoredObject(
    input: TenantTelemetryWriteAdapterInput,
    expected: CanonicalTenantTelemetryObject,
    bytes: Buffer,
  ): boolean {
    try {
      const decoded = decodeTenantTelemetryS3Envelope(bytes);
      const metadata = parseMetadata(decoded.metadataJson);
      if (decoded.metadataJson !== expected.metadataJson
        || decoded.payloadJson !== expected.payloadJson
        || metadata.protocol !== expected.metadata.protocol
        || metadata.adapterProtocol !== expected.metadata.adapterProtocol
        || metadata.targetSha256 !== input.target.targetSha256
        || metadata.targetReceiptSha256 !== input.target.receiptSha256
        || metadata.domain !== input.inventory.domain
        || metadata.writeOperationSha256 !== input.writeOperationSha256
        || metadata.artifactIdSha256 !== input.inventory.artifactIdSha256
        || metadata.artifactGeneration !== input.inventory.artifactGeneration
        || metadata.payloadSha256 !== input.inventory.payloadSha256
        || metadata.manifestSha256 !== input.inventory.manifestSha256) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async inspectValidated(
    input: TenantTelemetryWriteAdapterInput,
    expected: CanonicalTenantTelemetryObject,
    deadline: S3TenantTelemetryOperationDeadline,
  ): Promise<TenantTelemetryWriteInspection> {
    const output = await this.readObject(this.objectKey(input), deadline);
    if (!output) return { status: "absent" };
    try {
      assertUnversionedEvidence(output);
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    if (output.ContentType !== TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE) {
      destroyBody(output.Body);
      return { status: "conflict" };
    }
    if (typeof output.ETag !== "string" || output.ETag.length < 1 || output.ETag.length > 512) {
      destroyBody(output.Body);
      return { status: "conflict" };
    }
    const bytes = await readBoundedBody(output.Body, output.ContentLength, deadline);
    if (!this.exactStoredObject(input, expected, bytes)) return { status: "conflict" };
    return {
      status: "exact",
      result: tenantTelemetryWriteAdapterResult(
        this.adapterProtocol,
        input,
        "already_present",
        true,
      ),
    };
  }

  async inspectWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteInspection> {
    const deadline = new S3TenantTelemetryOperationDeadline(this.requestTimeoutMs);
    const expected = this.assertInput(input);
    try {
      return await this.inspectValidated(input, expected, deadline);
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  async createWrite(input: TenantTelemetryWriteAdapterInput): Promise<TenantTelemetryWriteAdapterResult> {
    const deadline = new S3TenantTelemetryOperationDeadline(this.requestTimeoutMs);
    const expected = this.assertInput(input);
    try {
      const existing = await this.inspectValidated(input, expected, deadline);
      if (existing.status === "conflict") throw new TenantTelemetryWriteAdapterConflictError();
      if (existing.status === "exact") return existing.result;

      let putError: unknown;
      try {
        const output = await this.send(deadline, (abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.objectKey(input),
            Body: expected.envelope,
            ContentLength: expected.envelope.byteLength,
            ContentType: TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE,
            IfNoneMatch: "*",
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
      } catch (error) {
        if (error instanceof S3TenantTelemetryVersionedObjectError) throw error;
        putError = error;
      }

      // Always read after PUT. This rejects false acknowledgements and converts a lost successful
      // response or a concurrent exact create into the only safe replay result.
      const observed = await this.inspectValidated(input, expected, deadline);
      if (observed.status === "conflict") throw new TenantTelemetryWriteAdapterConflictError();
      if (observed.status === "exact") {
        if (putError !== undefined) return observed.result;
        return tenantTelemetryWriteAdapterResult(
          this.adapterProtocol,
          input,
          "written",
          false,
        );
      }
      // Conditional conflict followed by absence is not proof that this operation won. A transport
      // failure followed by absence is equally ambiguous; the durable worker owns a later retry.
      throw new TenantTelemetryWriteAdapterTemporaryError();
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError
        || error instanceof TenantTelemetryWriteAdapterTemporaryError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  /** Validate the bucket contract and prove that create-only conditional PUT is enforced. */
  async validateStartup(): Promise<void> {
    this.assertOpen();
    const deadline = new S3TenantTelemetryOperationDeadline(this.requestTimeoutMs);
    try {
      await this.send(deadline, (abortSignal) => this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup reachability check", error);
    }

    let versioning;
    try {
      versioning = await this.send(deadline, (abortSignal) => this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup versioning check", error);
    }
    if (versioning.Status !== undefined) {
      throw new S3TenantTelemetrySafeError(
        "S3 tenant telemetry bucket versioning must be disabled",
      );
    }

    try {
      const lifecycle = await this.send(deadline, (abortSignal) => this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if ((lifecycle.Rules?.length ?? 0) > 0) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry bucket lifecycle configuration must be absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "NoSuchLifecycleConfiguration") {
        if (error instanceof S3TenantTelemetrySafeError) throw error;
        throw sanitizedS3Error("startup lifecycle check", error);
      }
    }

    try {
      const lock = await this.send(deadline, (abortSignal) => this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== undefined) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry bucket Object Lock must be disabled or absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "ObjectLockConfigurationNotFoundError"
        && errorName(error) !== "ObjectLockConfigurationNotFound"
        && errorStatus(error) !== 404) {
        if (error instanceof S3TenantTelemetrySafeError) throw error;
        throw sanitizedS3Error("startup Object Lock check", error);
      }
    }

    const probeKey = `${this.prefix}/_agent_service_probe/${randomBytes(16).toString("hex")}`;
    const initial = Buffer.from("agent-service-tenant-telemetry-conditional-probe-v1", "utf8");
    const replacement = Buffer.from("agent-service-tenant-telemetry-conditional-probe-v2", "utf8");
    let created = false;
    try {
      const first = await this.send(deadline, (abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: probeKey,
          Body: initial,
          ContentLength: initial.byteLength,
          IfNoneMatch: "*",
        }),
        { abortSignal },
      ));
      assertUnversionedEvidence(first);
      created = true;
      const head = await this.send(deadline, (abortSignal) => this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: probeKey }),
        { abortSignal },
      ));
      assertUnversionedEvidence(head);
      if (typeof head.ETag !== "string" || head.ETag.length < 1
        || head.ContentLength !== initial.byteLength) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry startup probe metadata is invalid",
        );
      }
      let ignored = false;
      try {
        const second = await this.send(deadline, (abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: probeKey,
            Body: replacement,
            ContentLength: replacement.byteLength,
            IfNoneMatch: "*",
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(second);
        ignored = true;
      } catch (error) {
        if (error instanceof S3TenantTelemetryVersionedObjectError) throw error;
        if (!isConditionalConflict(error)) {
          throw sanitizedS3Error("startup conditional-create probe", error);
        }
      }
      if (ignored) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry endpoint ignored If-None-Match",
        );
      }
      const read = await this.readObject(probeKey, deadline);
      if (!read) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry startup probe disappeared",
        );
      }
      assertUnversionedEvidence(read);
      const bytes = await readBoundedBody(read.Body, read.ContentLength, deadline);
      if (!bytes.equals(initial)) {
        throw new S3TenantTelemetrySafeError(
          "S3 tenant telemetry startup probe conflicts",
        );
      }
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError
        || error instanceof S3TenantTelemetrySafeError) throw error;
      throw sanitizedS3Error("startup conditional-create probe", error);
    } finally {
      if (created) {
        try {
          const removed = await this.send(deadline, (abortSignal) => this.client.send(
            new DeleteObjectCommand({ Bucket: this.bucket, Key: probeKey }),
            { abortSignal },
          ));
          assertUnversionedEvidence(removed);
        } catch (error) {
          if (error instanceof S3TenantTelemetryVersionedObjectError) throw error;
          throw sanitizedS3Error("startup probe cleanup", error);
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }

  destroy(): void {
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }
}
