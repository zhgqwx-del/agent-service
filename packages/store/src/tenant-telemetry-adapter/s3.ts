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
  tenantTelemetryArtifactPayloadSha256,
  tenantTelemetryArtifactPayloadCanonicalJson,
  type TenantTelemetryWriteAdapterResult,
} from "../tenant-telemetry-writer.js";
import {
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE,
  tenantTelemetrySameKeyTombstoneAckSha256,
  validateTenantTelemetryExternalAuthorizationProof,
  validateTenantTelemetrySameKeyTombstoneAck,
  type TenantTelemetryDispositionExternalAdapter,
  type TenantTelemetryExternalAuthorizationProof,
  type TenantTelemetrySameKeyTombstoneAck,
  type TenantTelemetrySameKeyTombstoneAckBody,
} from "../tenant-telemetry-disposition.js";
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
import {
  TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE,
  TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES,
  TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES,
  decodeTenantTelemetryS3Tombstone,
  encodeTenantTelemetryS3Tombstone,
} from "./s3-tombstone-codec.js";

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
const MAX_READ_BYTES = Math.max(MAX_ENVELOPE_BYTES,
  TENANT_TELEMETRY_S3_TOMBSTONE_HEADER_BYTES + TENANT_TELEMETRY_S3_TOMBSTONE_MAX_BODY_BYTES);
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
  /** 0036 is not a product executor. Only disposable protocol tests may enable mutation. */
  nonProductionDispositionFixture?: true;
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

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dispositionEvidence(proof: TenantTelemetryExternalAuthorizationProof) {
  return {
    domain: proof.domain,
    targetSha256: proof.targetSha256,
    artifactIdSha256: proof.artifactIdSha256,
    artifactGeneration: proof.artifactGeneration,
    inventorySha256: proof.inventorySha256,
    inventoryReceiptSha256: proof.inventoryReceiptSha256,
    writeOperationSha256: proof.writeOperationSha256,
    writeAckReceiptSha256: proof.writeAckReceiptSha256,
    payloadSha256: proof.payloadSha256,
    manifestSha256: proof.manifestSha256,
    lifecycleCoverageEvidenceSha256: proof.lifecycleCoverageEvidenceSha256,
    applicationCoverageEvidenceSha256: proof.applicationCoverageEvidenceSha256,
    applicationWriteBindingReceiptSha256: proof.applicationWriteBindingReceiptSha256,
    t3cReceiptSha256: proof.t3cReceiptSha256,
    t3dPlanReceiptSha256: proof.t3dPlanReceiptSha256,
    t3dPlanEntryReceiptSha256: proof.t3dPlanEntryReceiptSha256,
    dispositionOperationSha256: proof.dispositionOperationSha256,
  };
}

function sameKeyTombstoneJson(
  proof: TenantTelemetryExternalAuthorizationProof,
  originalObjectEtagSha256: string,
): string {
  return JSON.stringify({
    protocol: "telemetry-s3-same-key-tombstone-v1",
    ...dispositionEvidence(proof),
    authorizationReceiptSha256: proof.authorizationReceiptSha256,
    originalObjectEtagSha256,
  });
}

function sameKeyTombstoneAck(
  proof: TenantTelemetryExternalAuthorizationProof,
  tombstone: Buffer,
  originalObjectEtagSha256: string,
): TenantTelemetrySameKeyTombstoneAck {
  const tombstoneSha256 = sha256Bytes(tombstone);
  const body: TenantTelemetrySameKeyTombstoneAckBody = {
    scope: TENANT_TELEMETRY_SAME_KEY_TOMBSTONE_ACK_SCOPE,
    protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    ...dispositionEvidence(proof),
    authorizationReceiptSha256: proof.authorizationReceiptSha256,
    outcome: "tombstoned",
    tombstoneSha256,
    objectEtagSha256: originalObjectEtagSha256,
    adapterEvidenceSha256: sha256([
      "telemetry-s3-same-key-tombstone-adapter-evidence-v1",
      proof.targetSha256,
      proof.dispositionOperationSha256,
      proof.authorizationReceiptSha256,
      tombstoneSha256,
      originalObjectEtagSha256,
    ]),
  };
  const ack = { ...body, receiptSha256: tenantTelemetrySameKeyTombstoneAckSha256(body) };
  validateTenantTelemetrySameKeyTombstoneAck(ack);
  return ack;
}

/** The artifact and permanent tombstone share this exact key. No LIST or delete-marker fallback. */
export function tenantTelemetryS3ArtifactObjectKey(
  prefix: string,
  identity: {
    domain: TenantTelemetryDomain;
    targetSha256: string;
    artifactIdSha256: string;
    artifactGeneration: number;
  },
): string {
  return [
    validatePrefix(prefix),
    "v1",
    identity.domain,
    identity.targetSha256.slice(0, 2),
    identity.targetSha256,
    identity.artifactIdSha256.slice(0, 2),
    identity.artifactIdSha256,
    `${identity.artifactGeneration}.astelm`,
  ].join("/");
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
      || contentLength > MAX_READ_BYTES)) {
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
      if (total > MAX_READ_BYTES) {
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

/** Managed S3-compatible writer; the dormant disposition entrypoint requires separate preflight
 * and a committed independent-journal authorization proof before touching an artifact key. */
export class S3TenantTelemetryWriteAdapter implements TenantTelemetryWriteAdapter {
  readonly adapterProtocol = S3_TENANT_TELEMETRY_WRITE_ADAPTER_PROTOCOL;
  readonly bucket: string;
  readonly prefix: string;

  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly requestTimeoutMs: number;
  private readonly nonProductionDispositionFixture: boolean;
  private readonly expectedTargets = new Map<string, TenantTelemetryLifecycleTargetRecord>();
  private closed = false;
  private dispositionReady = false;

  constructor(options: S3TenantTelemetryWriteAdapterOptions) {
    if (options.nonProductionDispositionFixture === true
      && process.env.NODE_ENV === "production") {
      throw new Error("tenant telemetry disposition fixture is forbidden in production");
    }
    this.nonProductionDispositionFixture = options.nonProductionDispositionFixture === true;
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
    return tenantTelemetryS3ArtifactObjectKey(this.prefix, {
      domain: input.inventory.domain,
      targetSha256: input.target.targetSha256,
      artifactIdSha256: input.inventory.artifactIdSha256,
      artifactGeneration: input.inventory.artifactGeneration,
    });
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

  private assertDispositionProof(proof: TenantTelemetryExternalAuthorizationProof): void {
    this.assertOpen();
    // Fixture authorization is not a product capability. Re-check at the mutation boundary so
    // a long-lived adapter preflighted before an environment switch cannot write in production.
    if (!this.nonProductionDispositionFixture || process.env.NODE_ENV === "production") {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    if (!this.dispositionReady) throw new TenantTelemetryWriteAdapterTemporaryError();
    try {
      validateTenantTelemetryExternalAuthorizationProof(proof);
      const target = this.expectedTargets.get(proof.targetSha256);
      if (!target || target.domain !== proof.domain
        || target.adapterProtocol !== this.adapterProtocol) {
        throw new Error("target mismatch");
      }
    } catch {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }

  private async assertCommittedDispositionProof(
    proof: TenantTelemetryExternalAuthorizationProof,
    journal: TenantTelemetryDispositionExternalAdapter,
  ): Promise<void> {
    try {
      if (journal.adapterProtocol !== proof.adapterProtocol
        || journal.journalNamespaceSha256 !== proof.journalNamespaceSha256
        || journal.journalTargetSha256 !== proof.journalTargetSha256
        || journal.failureDomainSha256 !== proof.failureDomainSha256
        || journal.logicalDatabaseNamespaceSha256
          !== proof.logicalDatabaseNamespaceSha256) {
        throw new Error("journal identity mismatch");
      }
      const head = await journal.readHead();
      if (head.journalSequence < proof.journalSequence) {
        throw new Error("authorization is not committed");
      }
      const page = await journal.scanEvents({
        afterJournalSequence: proof.journalSequence - 1,
        afterJournalEventRootSha256: proof.previousJournalEventRootSha256,
        sealedHead: head,
        limit: 1,
      });
      const event = page.events[0];
      if (event?.eventType !== "delete_authorized"
        || event.result.authorizationReceiptSha256 !== proof.authorizationReceiptSha256
        || event.result.journalSequence !== proof.journalSequence
        || event.result.journalEventSha256 !== proof.journalEventSha256
        || event.result.journalEventRootSha256 !== proof.journalEventRootSha256) {
        throw new Error("authorization event does not match");
      }
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError) throw error;
      // A missing/foreign event is a permanent conflict; a transient journal read failure must
      // not mutate the object either. The worker retries from its durable authorization state.
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  private async dispositionState(
    proof: TenantTelemetryExternalAuthorizationProof,
    key: string,
    deadline: S3TenantTelemetryOperationDeadline,
  ): Promise<
    | { kind: "data"; etag: string }
    | { kind: "tombstone"; ack: TenantTelemetrySameKeyTombstoneAck }
  > {
    const output = await this.readObject(key, deadline);
    // An absent slot does not prove that a permanent fence exists. In particular, a missing
    // external object after a backup restore must never become a physical-deletion ACK.
    if (!output) throw new TenantTelemetryWriteAdapterConflictError();
    try {
      assertUnversionedEvidence(output);
      if (typeof output.ETag !== "string"
        || output.ETag.length < 1 || output.ETag.length > 512) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      if (output.ContentType !== TENANT_TELEMETRY_S3_OBJECT_CONTENT_TYPE
        && output.ContentType !== TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      const bytes = await readBoundedBody(output.Body, output.ContentLength, deadline);
      if (output.ContentType === TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE) {
        const bodyJson = decodeTenantTelemetryS3Tombstone(bytes);
        const parsed = JSON.parse(bodyJson) as Record<string, unknown>;
        const originalObjectEtagSha256 = parsed.originalObjectEtagSha256;
        if (typeof originalObjectEtagSha256 !== "string"
          || !SHA256.test(originalObjectEtagSha256)
          || bodyJson !== sameKeyTombstoneJson(proof, originalObjectEtagSha256)) {
          throw new TenantTelemetryWriteAdapterConflictError();
        }
        return {
          kind: "tombstone",
          ack: sameKeyTombstoneAck(proof, bytes, originalObjectEtagSha256),
        };
      }
      const decoded = decodeTenantTelemetryS3Envelope(bytes);
      const metadata = parseMetadata(decoded.metadataJson);
      const target = this.expectedTargets.get(proof.targetSha256);
      if (!target
        || metadata.targetSha256 !== proof.targetSha256
        || metadata.targetReceiptSha256 !== target.receiptSha256
        || metadata.domain !== proof.domain
        || metadata.writeOperationSha256 !== proof.writeOperationSha256
        || metadata.artifactIdSha256 !== proof.artifactIdSha256
        || metadata.artifactGeneration !== proof.artifactGeneration
        || metadata.inventorySha256 !== proof.inventorySha256
        || metadata.inventoryReceiptSha256 !== proof.inventoryReceiptSha256
        || metadata.payloadSha256 !== proof.payloadSha256
        || metadata.manifestSha256 !== proof.manifestSha256) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      const payload = JSON.parse(decoded.payloadJson);
      if (tenantTelemetryArtifactPayloadCanonicalJson(payload) !== decoded.payloadJson
        || tenantTelemetryArtifactPayloadSha256(payload) !== proof.payloadSha256) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      return { kind: "data", etag: output.ETag };
    } catch (error) {
      destroyBody(output.Body);
      if (error instanceof TenantTelemetryWriteAdapterConflictError
        || error instanceof TenantTelemetryWriteAdapterTemporaryError) throw error;
      throw new TenantTelemetryWriteAdapterConflictError();
    }
  }

  /**
   * Replace only the exact authenticated artifact with a content-free permanent marker. The
   * journal authorization has already committed externally; this method cannot grant deletion
   * authority by itself. A replay returns the original deterministic ACK, not a new outcome.
   */
  async tombstoneAuthorized(
    proof: TenantTelemetryExternalAuthorizationProof,
    journal: TenantTelemetryDispositionExternalAdapter,
  ): Promise<TenantTelemetrySameKeyTombstoneAck> {
    this.assertDispositionProof(proof);
    await this.assertCommittedDispositionProof(proof, journal);
    const deadline = new S3TenantTelemetryOperationDeadline(this.requestTimeoutMs);
    const key = tenantTelemetryS3ArtifactObjectKey(this.prefix, proof);
    try {
      const current = await this.dispositionState(proof, key, deadline);
      if (current.kind === "tombstone") return current.ack;
      const originalObjectEtagSha256 = sha256Bytes(current.etag);
      const tombstone = encodeTenantTelemetryS3Tombstone(
        sameKeyTombstoneJson(proof, originalObjectEtagSha256),
      );
      let putError: unknown;
      try {
        const output = await this.send(deadline, (abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: tombstone,
            ContentLength: tombstone.byteLength,
            ContentType: TENANT_TELEMETRY_S3_TOMBSTONE_CONTENT_TYPE,
            IfMatch: current.etag,
          }),
          { abortSignal },
        ));
        assertUnversionedEvidence(output);
      } catch (error) {
        if (error instanceof S3TenantTelemetryVersionedObjectError) throw error;
        putError = error;
      }
      const observed = await this.dispositionState(proof, key, deadline);
      if (observed.kind === "tombstone") return observed.ack;
      if (putError !== undefined && isConditionalConflict(putError)) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      throw new TenantTelemetryWriteAdapterTemporaryError();
    } catch (error) {
      if (error instanceof TenantTelemetryWriteAdapterConflictError
        || error instanceof TenantTelemetryWriteAdapterTemporaryError) throw error;
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  /** Separate preflight for the dormant destructive path; ordinary writer startup does not enable it. */
  async validateDispositionStartup(): Promise<void> {
    this.dispositionReady = false;
    if (!this.nonProductionDispositionFixture || process.env.NODE_ENV === "production") {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    await this.validateStartup();
    const deadline = new S3TenantTelemetryOperationDeadline(this.requestTimeoutMs);
    const key = `${this.prefix}/_agent_service_probe/${randomBytes(16).toString("hex")}`;
    const initial = Buffer.from("agent-service-telemetry-disposition-cas-v1", "utf8");
    const replacement = Buffer.from("agent-service-telemetry-disposition-cas-v2", "utf8");
    let created = false;
    try {
      const first = await this.send(deadline, (abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket, Key: key, Body: initial,
          ContentLength: initial.byteLength, IfNoneMatch: "*",
        }), { abortSignal },
      ));
      assertUnversionedEvidence(first);
      created = true;
      const head = await this.send(deadline, (abortSignal) => this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal },
      ));
      assertUnversionedEvidence(head);
      if (typeof head.ETag !== "string" || head.ETag.length < 1
        || head.ETag.length > 512 || head.ContentLength !== initial.length) {
        throw new S3TenantTelemetrySafeError("S3 tenant telemetry disposition CAS probe is invalid");
      }
      let ignoredConditional = false;
      try {
        const rejected = await this.send(deadline, (abortSignal) => this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket, Key: key, Body: replacement,
            ContentLength: replacement.byteLength, IfMatch: '"invalid-cas-etag"',
          }), { abortSignal },
        ));
        assertUnversionedEvidence(rejected);
        ignoredConditional = true;
      } catch (error) {
        if (!isConditionalConflict(error)) throw error;
      }
      if (ignoredConditional) {
        throw new S3TenantTelemetrySafeError("S3 tenant telemetry endpoint ignored If-Match");
      }
      const original = await this.readObject(key, deadline);
      if (!original) throw new S3TenantTelemetrySafeError("S3 telemetry CAS probe disappeared");
      assertUnversionedEvidence(original);
      const originalBytes = await readBoundedBody(original.Body, original.ContentLength, deadline);
      if (original.ETag !== head.ETag || !originalBytes.equals(initial)) {
        throw new S3TenantTelemetrySafeError("S3 telemetry CAS probe was overwritten");
      }
      const second = await this.send(deadline, (abortSignal) => this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket, Key: key, Body: replacement,
          ContentLength: replacement.byteLength, IfMatch: head.ETag,
        }), { abortSignal },
      ));
      assertUnversionedEvidence(second);
      const replaced = await this.readObject(key, deadline);
      if (!replaced) throw new S3TenantTelemetrySafeError("S3 telemetry CAS probe disappeared");
      assertUnversionedEvidence(replaced);
      const replacedBytes = await readBoundedBody(replaced.Body, replaced.ContentLength, deadline);
      if (!replacedBytes.equals(replacement)) {
        throw new S3TenantTelemetrySafeError("S3 telemetry CAS probe did not replace the object");
      }
      this.dispositionReady = true;
    } catch (error) {
      if (error instanceof S3TenantTelemetrySafeError) throw error;
      throw sanitizedS3Error("disposition CAS probe", error);
    } finally {
      if (created) {
        try {
          const removed = await this.send(deadline, (abortSignal) => this.client.send(
            new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal },
          ));
          assertUnversionedEvidence(removed);
        } catch (error) {
          this.dispositionReady = false;
          throw sanitizedS3Error("disposition probe cleanup", error);
        }
      }
    }
  }

  /** Validate the bucket contract and prove that create-only conditional PUT is enforced. */
  async validateStartup(): Promise<void> {
    this.assertOpen();
    this.dispositionReady = false;
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
