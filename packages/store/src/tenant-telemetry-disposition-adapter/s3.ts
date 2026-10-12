import { createHash, randomBytes } from "node:crypto";
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE,
  TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
  TenantTelemetryDispositionConflictError,
  TenantTelemetryDispositionCorruptError,
  tenantTelemetryDispositionExternalEventOperation,
  tenantTelemetryDispositionExternalEventProof,
  validateTenantTelemetryDispositionEvidence,
  validateTenantTelemetryDispositionExternalEvent,
  validateTenantTelemetryDispositionExternalHead,
  validateTenantTelemetryDispositionJournalIdentity,
  validateTenantTelemetrySameKeyTombstoneAck,
  type ScanTenantTelemetryDispositionEventsOptions,
  type ScanTenantTelemetryDispositionEventsResult,
  type TenantTelemetryDispositionEvidence,
  type TenantTelemetryDispositionExternalAdapter,
  type TenantTelemetryDispositionExternalEvent,
  type TenantTelemetryDispositionExternalHead,
  type TenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryExternalAuthorizationProof,
  type TenantTelemetryExternalTombstoneProof,
  type TenantTelemetrySameKeyTombstoneAck,
} from "../tenant-telemetry-disposition.js";
import {
  assertTenantTelemetryDispositionEventChain,
  buildTenantTelemetryExternalAuthorizationProof,
  buildTenantTelemetryExternalTombstoneProof,
  canonicalJson,
  emptyTenantTelemetryDispositionHead,
  findTenantTelemetryDispositionAuthorization,
  findTenantTelemetryDispositionTerminal,
  headAfterTenantTelemetryDispositionEvent,
  sameTenantTelemetryDispositionEvent,
  tenantTelemetryDispositionFenceKey,
} from "./common.js";
import {
  TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES,
  TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_MAX_PAYLOAD_BYTES,
  TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
  decodeTenantTelemetryDispositionEnvelope,
  encodeTenantTelemetryDispositionEnvelope,
  type TenantTelemetryDispositionEnvelopeKind,
} from "./codec.js";
import {
  buildTenantTelemetryDispositionStoredEvent,
  canonicalTenantTelemetryDispositionStoredEvent,
  parseCanonicalTenantTelemetryDispositionStoredEvent,
} from "./serialization.js";

export const S3_TENANT_TELEMETRY_DISPOSITION_PROTOCOL =
  "s3-cas-head-tenant-telemetry-disposition-journal-v1" as const;

const DEFAULT_PREFIX = "tenant-telemetry-disposition";
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const MIN_OPERATION_TIMEOUT_MS = 100;
const MAX_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_MUTATION_ATTEMPTS = 64;
const MAX_MUTATION_ATTEMPTS = 1_000;
const DEFAULT_SDK_ATTEMPTS = 2;
const SEQUENCE_WIDTH = 16;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = TENANT_TELEMETRY_DISPOSITION_ENVELOPE_HEADER_BYTES
  + TENANT_TELEMETRY_DISPOSITION_MAX_PAYLOAD_BYTES;
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

interface OperationDeadline {
  expiresAtMs: number;
}

interface StoredPayload {
  payload: string;
  etag: string;
}

interface StoredHeadState {
  head: TenantTelemetryDispositionExternalHead;
  etag: string;
}

type StoredEventState =
  | { kind: "missing" }
  | { kind: "exact"; event: TenantTelemetryDispositionExternalEvent }
  | { kind: "occupied"; event: TenantTelemetryDispositionExternalEvent };

export interface S3TenantTelemetryDispositionAdapterOptions {
  /** The journal must survive rollback/loss of the primary database. */
  independentFailureDomain: true;
  /** Operator acknowledgement after independently verifying private bucket access. */
  privateBucketAccessVerified: true;
  /** Reserved for this authority; it must not be the telemetry artifact bucket. */
  bucket: string;
  namespaceId: string;
  failureDomainId: string;
  logicalDatabaseNamespaceSha256: string;
  prefix?: string;
  region: string;
  /** `null` selects the SDK standard endpoint for the region. */
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials?: S3ClientConfig["credentials"];
  client?: S3Client;
  /** One absolute budget shared by all requests, streams, retries and verification. */
  operationTimeoutMs?: number;
  maxMutationAttempts?: number;
  /** Protocol-only fixture. Until a durable store grant/marker verifier exists, product mutation is forbidden. */
  nonProductionMutationFixture?: true;
}

export class S3TenantTelemetryDispositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3TenantTelemetryDispositionError";
  }
}

class S3TenantTelemetryDispositionVersionedObjectError extends Error {
  constructor() {
    super("S3 tenant telemetry disposition returned versioned-object evidence");
    this.name = "S3TenantTelemetryDispositionVersionedObjectError";
  }
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

function sanitizedS3Error(operation: string, error: unknown): S3TenantTelemetryDispositionError {
  const status = errorStatus(error);
  const name = errorName(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const detail = [safeName, status === undefined ? undefined : String(status)]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3TenantTelemetryDispositionError(
    `S3 tenant telemetry disposition ${operation} failed${detail ? ` (${detail})` : ""}`,
  );
}

function isMissingObject(error: unknown): boolean {
  const name = errorName(error);
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
    throw new S3TenantTelemetryDispositionVersionedObjectError();
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateDigest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`S3 tenant telemetry disposition ${name} is invalid`);
}

function validateBucket(bucket: string): void {
  if (bucket.length < 3
    || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
    || bucket.includes(".-")
    || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error("S3 tenant telemetry disposition bucket is invalid");
  }
}

function validatePrefix(prefix: string): void {
  if (prefix.length < 1
    || prefix.length > 512
    || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))) {
    throw new Error("S3 tenant telemetry disposition prefix is invalid");
  }
}

function validateNonSecretId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`S3 tenant telemetry disposition ${name} id is invalid`);
  }
}

function validateRegion(region: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new Error("S3 tenant telemetry disposition region is invalid");
  }
  return region;
}

function normalizeEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("S3 tenant telemetry disposition endpoint is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash) {
    throw new Error(
      "S3 tenant telemetry disposition endpoint must be a credential-free http(s) origin",
    );
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("S3 tenant telemetry disposition production endpoint must use HTTPS");
  }
  return parsed.origin;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sequenceKey(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("tenant telemetry disposition sequence is invalid");
  }
  const value = String(sequence).padStart(SEQUENCE_WIDTH, "0");
  if (value.length !== SEQUENCE_WIDTH) {
    throw new Error("tenant telemetry disposition sequence is exhausted");
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameHead(
  left: TenantTelemetryDispositionExternalHead,
  right: TenantTelemetryDispositionExternalHead,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return;
  try {
    destroy.call(body);
  } catch {
    // Preserve the primary integrity/transport failure.
  }
}

function bodyAsAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) return (async function* () { yield body; })();
  if (!body
    || (typeof body !== "object" && typeof body !== "function")
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
      !== "function") {
    throw new TenantTelemetryDispositionCorruptError();
  }
  return body as AsyncIterable<Uint8Array>;
}

export function s3TenantTelemetryDispositionNamespaceSha256(namespaceId: string): string {
  validateNonSecretId(namespaceId, "namespace");
  return digest(["s3-tenant-telemetry-disposition-namespace-v1", namespaceId]);
}

export function s3TenantTelemetryDispositionFailureDomainSha256(
  failureDomainId: string,
): string {
  validateNonSecretId(failureDomainId, "failure domain");
  return digest(["s3-tenant-telemetry-disposition-failure-domain-v1", failureDomainId]);
}

export function s3TenantTelemetryDispositionTargetSha256(input: {
  journalNamespaceSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
}): string {
  validateDigest(input.journalNamespaceSha256, "namespace digest");
  validateDigest(input.failureDomainSha256, "failure-domain digest");
  validateDigest(input.logicalDatabaseNamespaceSha256, "logical database namespace");
  validateBucket(input.bucket);
  validatePrefix(input.prefix);
  const region = validateRegion(input.region);
  const endpoint = normalizeEndpoint(input.endpoint);
  if (typeof input.forcePathStyle !== "boolean") {
    throw new Error("S3 tenant telemetry disposition addressing mode is invalid");
  }
  return digest([
    "s3-tenant-telemetry-disposition-target-v1",
    S3_TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
    input.journalNamespaceSha256,
    input.failureDomainSha256,
    input.logicalDatabaseNamespaceSha256,
    input.bucket,
    input.prefix,
    region,
    endpoint === null ? "standard-endpoint" : "custom-endpoint",
    endpoint ?? "",
    input.forcePathStyle ? "path-style" : "virtual-hosted-style",
  ]);
}

export class S3TenantTelemetryDispositionAdapter
implements TenantTelemetryDispositionExternalAdapter {
  readonly adapterProtocol = S3_TENANT_TELEMETRY_DISPOSITION_PROTOCOL;
  readonly journalNamespaceSha256: string;
  readonly journalTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly targetPrefix: string;
  private readonly headKey: string;
  private readonly createProbeKey: string;
  private readonly casProbeKey: string;
  private readonly operationTimeoutMs: number;
  private readonly maxMutationAttempts: number;
  private readonly nonProductionMutationFixture: boolean;
  private closed = false;

  constructor(options: S3TenantTelemetryDispositionAdapterOptions) {
    if (options.nonProductionMutationFixture === true && process.env.NODE_ENV === "production") {
      throw new Error("S3 tenant telemetry disposition mutation fixture is forbidden in production");
    }
    this.nonProductionMutationFixture = options.nonProductionMutationFixture === true;
    if (options.independentFailureDomain !== true) {
      throw new Error(
        "S3 tenant telemetry disposition requires an independent failure-domain acknowledgement",
      );
    }
    if (options.privateBucketAccessVerified !== true) {
      throw new Error(
        "S3 tenant telemetry disposition requires a private-bucket verification acknowledgement",
      );
    }
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    validateBucket(this.bucket);
    validatePrefix(this.prefix);
    const region = validateRegion(options.region);
    const endpoint = normalizeEndpoint(options.endpoint);
    validateDigest(options.logicalDatabaseNamespaceSha256, "logical database namespace");
    if (typeof options.forcePathStyle !== "boolean") {
      throw new Error("S3 tenant telemetry disposition addressing mode is invalid");
    }
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.journalNamespaceSha256 = s3TenantTelemetryDispositionNamespaceSha256(
      options.namespaceId,
    );
    this.failureDomainSha256 = s3TenantTelemetryDispositionFailureDomainSha256(
      options.failureDomainId,
    );
    this.journalTargetSha256 = s3TenantTelemetryDispositionTargetSha256({
      journalNamespaceSha256: this.journalNamespaceSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      bucket: this.bucket,
      prefix: this.prefix,
      region,
      endpoint,
      forcePathStyle: options.forcePathStyle,
    });
    validateTenantTelemetryDispositionJournalIdentity(this.identity);
    this.targetPrefix = `${this.prefix}/targets/${this.journalTargetSha256}`;
    this.headKey = `${this.targetPrefix}/authority/head-v1`;
    this.createProbeKey = `${this.prefix}/probes/conditional-create-v1/${this.journalTargetSha256}`;
    this.casProbeKey = `${this.prefix}/probes/conditional-cas-v1/${this.journalTargetSha256}`;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.operationTimeoutMs)
      || this.operationTimeoutMs < MIN_OPERATION_TIMEOUT_MS
      || this.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
      throw new Error(
        `S3 tenant telemetry disposition operation timeout must be between ${MIN_OPERATION_TIMEOUT_MS} and ${MAX_OPERATION_TIMEOUT_MS}`,
      );
    }
    this.maxMutationAttempts = options.maxMutationAttempts ?? DEFAULT_MUTATION_ATTEMPTS;
    if (!Number.isSafeInteger(this.maxMutationAttempts)
      || this.maxMutationAttempts < 1
      || this.maxMutationAttempts > MAX_MUTATION_ATTEMPTS) {
      throw new Error(
        `S3 tenant telemetry disposition mutation attempts must be between 1 and ${MAX_MUTATION_ATTEMPTS}`,
      );
    }
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

  private get identity(): TenantTelemetryDispositionJournalIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      journalNamespaceSha256: this.journalNamespaceSha256,
      journalTargetSha256: this.journalTargetSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("S3 tenant telemetry disposition adapter is closed");
  }

  private assertFixtureMutation(): void {
    this.assertOpen();
    if (!this.nonProductionMutationFixture || process.env.NODE_ENV === "production") {
      throw new TenantTelemetryDispositionConflictError();
    }
  }

  private operationDeadline(): OperationDeadline {
    return { expiresAtMs: Date.now() + this.operationTimeoutMs };
  }

  private remainingMs(deadline: OperationDeadline): number {
    const remaining = deadline.expiresAtMs - Date.now();
    if (remaining <= 0) {
      throw new S3TenantTelemetryDispositionError(
        "S3 tenant telemetry disposition operation deadline exceeded",
      );
    }
    return remaining;
  }

  private eventKey(sequence: number): string {
    return `${this.targetPrefix}/events/${sequenceKey(sequence)}`;
  }

  private async send<Output>(
    deadline: OperationDeadline,
    request: (abortSignal: AbortSignal) => Promise<Output>,
  ): Promise<Output> {
    const controller = new AbortController();
    const remaining = this.remainingMs(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(
          new Error("S3 tenant telemetry disposition operation timed out"),
          { name: "TimeoutError" },
        );
        reject(error);
        controller.abort(error);
      }, remaining);
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

  private async readBoundedBody(
    body: unknown,
    contentLength: number | undefined,
    deadline: OperationDeadline,
  ): Promise<Buffer> {
    if (contentLength !== undefined
      && (!Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > MAX_ENVELOPE_BYTES)) {
      destroyBody(body);
      throw new TenantTelemetryDispositionCorruptError();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        destroyBody(body);
        reject(new S3TenantTelemetryDispositionError(
          "S3 tenant telemetry disposition response stream timed out",
        ));
      }, this.remainingMs(deadline));
      timer.unref();
    });
    const read = (async () => {
      for await (const value of bodyAsAsyncIterable(body)) {
        this.remainingMs(deadline);
        if (!(value instanceof Uint8Array)) throw new TenantTelemetryDispositionCorruptError();
        total += value.byteLength;
        if (total > MAX_ENVELOPE_BYTES) throw new TenantTelemetryDispositionCorruptError();
        // Stream implementations may recycle their backing buffer after yielding a chunk.
        // Keep an owned copy before awaiting the next iterator step.
        chunks.push(Buffer.from(value));
      }
    })();
    void read.catch(() => undefined);
    try {
      await Promise.race([read, timeout]);
    } catch (error) {
      destroyBody(body);
      if (error instanceof TenantTelemetryDispositionCorruptError
        || error instanceof S3TenantTelemetryDispositionError) throw error;
      throw sanitizedS3Error("response stream", error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (contentLength !== undefined && total !== contentLength) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return Buffer.concat(chunks, total);
  }

  private async readStoredPayload(
    key: string,
    kind: TenantTelemetryDispositionEnvelopeKind,
    contentType: string,
    deadline: OperationDeadline,
  ): Promise<StoredPayload | null> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.send(deadline, (abortSignal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return null;
      if (error instanceof S3TenantTelemetryDispositionError) throw error;
      throw sanitizedS3Error("read", error);
    }
    try {
      assertUnversionedEvidence(output);
      if (output.ContentType !== contentType) throw new TenantTelemetryDispositionCorruptError();
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    const bytes = await this.readBoundedBody(output.Body, output.ContentLength, deadline);
    if (typeof output.ETag !== "string"
      || output.ETag.length < 1
      || output.ETag.length > 512) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    try {
      return {
        payload: decodeTenantTelemetryDispositionEnvelope(kind, bytes),
        etag: output.ETag,
      };
    } catch {
      throw new TenantTelemetryDispositionCorruptError();
    }
  }

  private async readStoredEvent(
    sequence: number,
    deadline: OperationDeadline,
  ): Promise<TenantTelemetryDispositionExternalEvent | null> {
    const stored = await this.readStoredPayload(
      this.eventKey(sequence),
      "event",
      TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE,
      deadline,
    );
    if (stored === null) return null;
    try {
      const parsed = parseCanonicalTenantTelemetryDispositionStoredEvent(stored.payload);
      if (parsed.adapterProtocol !== this.adapterProtocol
        || parsed.journalNamespaceSha256 !== this.journalNamespaceSha256
        || parsed.journalTargetSha256 !== this.journalTargetSha256
        || parsed.failureDomainSha256 !== this.failureDomainSha256
        || parsed.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
        || tenantTelemetryDispositionExternalEventProof(parsed.event).journalSequence
          !== sequence) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      return parsed.event;
    } catch (error) {
      if (error instanceof TenantTelemetryDispositionCorruptError) throw error;
      throw new TenantTelemetryDispositionCorruptError();
    }
  }

  private async inspectStoredEvent(
    expected: TenantTelemetryDispositionExternalEvent,
    deadline: OperationDeadline,
  ): Promise<StoredEventState> {
    const stored = await this.readStoredEvent(
      tenantTelemetryDispositionExternalEventProof(expected).journalSequence,
      deadline,
    );
    if (stored === null) return { kind: "missing" };
    return sameTenantTelemetryDispositionEvent(stored, expected)
      ? { kind: "exact", event: stored }
      : { kind: "occupied", event: stored };
  }

  private canonicalHead(head: TenantTelemetryDispositionExternalHead): string {
    validateTenantTelemetryDispositionExternalHead(head);
    return canonicalJson(head);
  }

  private parseHead(payload: string): TenantTelemetryDispositionExternalHead {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TenantTelemetryDispositionCorruptError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !exactKeys(parsed, [
        "scope",
        "protocol",
        "adapterProtocol",
        "journalNamespaceSha256",
        "journalTargetSha256",
        "failureDomainSha256",
        "logicalDatabaseNamespaceSha256",
        "journalSequence",
        "journalEventRootSha256",
      ])) throw new TenantTelemetryDispositionCorruptError();
    const head = parsed as TenantTelemetryDispositionExternalHead;
    try {
      validateTenantTelemetryDispositionExternalHead(head);
    } catch {
      throw new TenantTelemetryDispositionCorruptError();
    }
    if (head.scope !== TENANT_TELEMETRY_DISPOSITION_EXTERNAL_HEAD_SCOPE
      || head.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
      || head.adapterProtocol !== this.adapterProtocol
      || head.journalNamespaceSha256 !== this.journalNamespaceSha256
      || head.journalTargetSha256 !== this.journalTargetSha256
      || head.failureDomainSha256 !== this.failureDomainSha256
      || head.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return head;
  }

  private canonicalProbe(nonceSha256: string): string {
    validateDigest(nonceSha256, "probe nonce");
    return canonicalJson({
      scope: "tenant-telemetry-disposition-cas-probe-v1",
      protocol: TENANT_TELEMETRY_DISPOSITION_PROTOCOL,
      ...this.identity,
      nonceSha256,
    });
  }

  private validateProbe(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TenantTelemetryDispositionCorruptError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !exactKeys(parsed, [
        "scope", "protocol", "adapterProtocol", "journalNamespaceSha256",
        "journalTargetSha256", "failureDomainSha256", "logicalDatabaseNamespaceSha256",
        "nonceSha256",
      ])) throw new TenantTelemetryDispositionCorruptError();
    const value = parsed as Record<string, unknown>;
    if (value.scope !== "tenant-telemetry-disposition-cas-probe-v1"
      || value.protocol !== TENANT_TELEMETRY_DISPOSITION_PROTOCOL
      || value.adapterProtocol !== this.adapterProtocol
      || value.journalNamespaceSha256 !== this.journalNamespaceSha256
      || value.journalTargetSha256 !== this.journalTargetSha256
      || value.failureDomainSha256 !== this.failureDomainSha256
      || value.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
      || typeof value.nonceSha256 !== "string"
      || !SHA256.test(value.nonceSha256)
      || canonicalJson(value) !== payload) {
      throw new TenantTelemetryDispositionCorruptError();
    }
  }

  private async putCreateOnly(
    key: string,
    body: Buffer,
    contentType: string,
    deadline: OperationDeadline,
  ): Promise<void> {
    const output = await this.send(deadline, (abortSignal) => this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: "*",
      }),
      { abortSignal },
    ));
    assertUnversionedEvidence(output);
  }

  private async putCompareAndSwap(
    key: string,
    expectedEtag: string,
    body: Buffer,
    contentType: string,
    deadline: OperationDeadline,
  ): Promise<void> {
    const output = await this.send(deadline, (abortSignal) => this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfMatch: expectedEtag,
      }),
      { abortSignal },
    ));
    assertUnversionedEvidence(output);
  }

  private async readHeadObject(deadline: OperationDeadline): Promise<StoredHeadState | null> {
    const stored = await this.readStoredPayload(
      this.headKey,
      "head",
      TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
      deadline,
    );
    return stored === null ? null : { head: this.parseHead(stored.payload), etag: stored.etag };
  }

  private async ensureHeadObject(deadline: OperationDeadline): Promise<StoredHeadState> {
    const existing = await this.readHeadObject(deadline);
    if (existing !== null) return existing;
    // Never infer authority from LIST. An event without a head is an incomplete/foreign target.
    if (await this.readStoredEvent(1, deadline)) throw new TenantTelemetryDispositionCorruptError();
    const genesis = emptyTenantTelemetryDispositionHead(this.identity);
    const body = encodeTenantTelemetryDispositionEnvelope("head", this.canonicalHead(genesis));
    let putError: unknown;
    try {
      await this.putCreateOnly(
        this.headKey,
        body,
        TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
        deadline,
      );
    } catch (error) {
      if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
      putError = error;
    }
    const observed = await this.readHeadObject(deadline);
    if (observed !== null) {
      if (!sameHead(observed.head, genesis)) throw new TenantTelemetryDispositionCorruptError();
      return observed;
    }
    if (putError !== undefined) {
      if (putError instanceof S3TenantTelemetryDispositionError) throw putError;
      throw sanitizedS3Error("head initialization", putError);
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition head initialization was not durable",
    );
  }

  private async advanceHead(
    expected: StoredHeadState,
    desired: TenantTelemetryDispositionExternalHead,
    deadline: OperationDeadline,
  ): Promise<StoredHeadState> {
    validateTenantTelemetryDispositionExternalHead(expected.head);
    validateTenantTelemetryDispositionExternalHead(desired);
    if (desired.journalSequence !== expected.head.journalSequence + 1) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const body = encodeTenantTelemetryDispositionEnvelope("head", this.canonicalHead(desired));
    let putError: unknown;
    try {
      await this.putCompareAndSwap(
        this.headKey,
        expected.etag,
        body,
        TENANT_TELEMETRY_DISPOSITION_HEAD_CONTENT_TYPE,
        deadline,
      );
    } catch (error) {
      if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
      putError = error;
    }
    const observed = await this.readHeadObject(deadline);
    if (observed === null) throw new TenantTelemetryDispositionCorruptError();
    if (observed.head.journalSequence === desired.journalSequence) {
      if (!sameHead(observed.head, desired)) throw new TenantTelemetryDispositionCorruptError();
      return observed;
    }
    if (observed.head.journalSequence > desired.journalSequence) return observed;
    if (!sameHead(observed.head, expected.head)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    if (putError !== undefined && !isConditionalConflict(putError)) {
      if (putError instanceof S3TenantTelemetryDispositionError) throw putError;
      throw sanitizedS3Error("head compare-and-swap", putError);
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition head compare-and-swap did not converge",
    );
  }

  private async readChainThrough(
    sequence: number,
    deadline: OperationDeadline,
  ): Promise<TenantTelemetryDispositionExternalEvent[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const events: TenantTelemetryDispositionExternalEvent[] = [];
    for (let value = 1; value <= sequence; value += 1) {
      const event = await this.readStoredEvent(value, deadline);
      if (event === null) throw new TenantTelemetryDispositionCorruptError();
      events.push(event);
    }
    assertTenantTelemetryDispositionEventChain(this.identity, events);
    return events;
  }

  private headOf(
    events: readonly TenantTelemetryDispositionExternalEvent[],
  ): TenantTelemetryDispositionExternalHead {
    const event = events.at(-1);
    return event === undefined
      ? emptyTenantTelemetryDispositionHead(this.identity)
      : headAfterTenantTelemetryDispositionEvent(this.identity, event);
  }

  private async readCommittedChain(deadline: OperationDeadline): Promise<{
    events: TenantTelemetryDispositionExternalEvent[];
    state: StoredHeadState;
  }> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      this.remainingMs(deadline);
      const state = await this.ensureHeadObject(deadline);
      const events = await this.readChainThrough(state.head.journalSequence, deadline);
      if (!sameHead(this.headOf(events), state.head)) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      if (state.head.journalSequence === Number.MAX_SAFE_INTEGER) return { events, state };
      const pending = await this.readStoredEvent(state.head.journalSequence + 1, deadline);
      if (pending === null) return { events, state };
      assertTenantTelemetryDispositionEventChain(this.identity, [...events, pending]);
      try {
        await this.advanceHead(state, this.headOf([...events, pending]), deadline);
      } catch (error) {
        if (error instanceof S3TenantTelemetryDispositionError
          && error.message.endsWith("did not converge")) continue;
        throw error;
      }
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition pending-head recovery did not converge",
    );
  }

  private async append(
    deadline: OperationDeadline,
    build: (
      events: readonly TenantTelemetryDispositionExternalEvent[],
      head: TenantTelemetryDispositionExternalHead,
    ) => {
      existing?: TenantTelemetryDispositionExternalEvent;
      proposal?: TenantTelemetryDispositionExternalEvent;
    },
  ): Promise<TenantTelemetryDispositionExternalEvent> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      this.remainingMs(deadline);
      const committed = await this.readCommittedChain(deadline);
      const decision = build(committed.events, committed.state.head);
      if (decision.existing !== undefined) return clone(decision.existing);
      const proposal = decision.proposal;
      if (proposal === undefined) throw new TenantTelemetryDispositionCorruptError();
      validateTenantTelemetryDispositionExternalEvent(proposal);
      assertTenantTelemetryDispositionEventChain(
        this.identity,
        [...committed.events, proposal],
      );
      const stored = buildTenantTelemetryDispositionStoredEvent(this.identity, proposal);
      const body = encodeTenantTelemetryDispositionEnvelope(
        "event",
        canonicalTenantTelemetryDispositionStoredEvent(stored),
      );
      let putSucceeded = false;
      let putError: unknown;
      try {
        await this.putCreateOnly(
          this.eventKey(tenantTelemetryDispositionExternalEventProof(proposal).journalSequence),
          body,
          TENANT_TELEMETRY_DISPOSITION_EVENT_CONTENT_TYPE,
          deadline,
        );
        putSucceeded = true;
      } catch (error) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
        putError = error;
      }
      const state = await this.inspectStoredEvent(proposal, deadline);
      if (state.kind === "exact") {
        try {
          await this.advanceHead(
            committed.state,
            this.headOf([...committed.events, state.event]),
            deadline,
          );
        } catch (error) {
          if (!(error instanceof S3TenantTelemetryDispositionError
            && error.message.endsWith("did not converge"))) throw error;
          continue;
        }
        const verified = await this.readCommittedChain(deadline);
        const index = tenantTelemetryDispositionExternalEventProof(proposal).journalSequence - 1;
        const committedEvent = verified.events[index];
        if (committedEvent === undefined
          || !sameTenantTelemetryDispositionEvent(committedEvent, proposal)) {
          throw new TenantTelemetryDispositionCorruptError();
        }
        return clone(committedEvent);
      }
      if (state.kind === "occupied"
        || (putError !== undefined && isConditionalConflict(putError))) continue;
      if (putSucceeded) continue;
      if (putError !== undefined) {
        if (putError instanceof S3TenantTelemetryDispositionError) throw putError;
        throw sanitizedS3Error("conditional event create", putError);
      }
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition event create did not converge",
    );
  }

  private async ensureCasProbeObject(deadline: OperationDeadline): Promise<StoredPayload> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const existing = await this.readStoredPayload(
        this.casProbeKey,
        "probe",
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      if (existing !== null) {
        this.validateProbe(existing.payload);
        return existing;
      }
      const payload = this.canonicalProbe(randomBytes(32).toString("hex"));
      let putError: unknown;
      try {
        await this.putCreateOnly(
          this.casProbeKey,
          encodeTenantTelemetryDispositionEnvelope("probe", payload),
          TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
          deadline,
        );
      } catch (error) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
        putError = error;
      }
      const observed = await this.readStoredPayload(
        this.casProbeKey,
        "probe",
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      if (observed !== null) {
        this.validateProbe(observed.payload);
        if (putError === undefined
          || observed.payload === payload
          || isConditionalConflict(putError)) return observed;
      }
      if (putError !== undefined && !isConditionalConflict(putError)) {
        if (putError instanceof S3TenantTelemetryDispositionError) throw putError;
        throw sanitizedS3Error("startup CAS probe initialization", putError);
      }
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition CAS probe initialization did not converge",
    );
  }

  private async validateCompareAndSwap(deadline: OperationDeadline): Promise<void> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const previous = await this.ensureCasProbeObject(deadline);
      const nextPayload = this.canonicalProbe(randomBytes(32).toString("hex"));
      let putError: unknown;
      try {
        await this.putCompareAndSwap(
          this.casProbeKey,
          previous.etag,
          encodeTenantTelemetryDispositionEnvelope("probe", nextPayload),
          TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
          deadline,
        );
      } catch (error) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
        putError = error;
      }
      const observed = await this.readStoredPayload(
        this.casProbeKey,
        "probe",
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      if (observed === null) throw new TenantTelemetryDispositionCorruptError();
      this.validateProbe(observed.payload);
      if (putError !== undefined && observed.payload !== nextPayload) {
        if (isConditionalConflict(putError)) continue;
        if (putError instanceof S3TenantTelemetryDispositionError) throw putError;
        throw sanitizedS3Error("startup CAS probe update", putError);
      }
      if (observed.payload !== nextPayload) {
        throw new S3TenantTelemetryDispositionError(
          "S3 tenant telemetry disposition CAS probe update was not durable",
        );
      }
      const stalePayload = this.canonicalProbe(randomBytes(32).toString("hex"));
      let staleError: unknown;
      try {
        await this.putCompareAndSwap(
          this.casProbeKey,
          previous.etag,
          encodeTenantTelemetryDispositionEnvelope("probe", stalePayload),
          TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
          deadline,
        );
      } catch (error) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError) throw error;
        staleError = error;
      }
      const afterStale = await this.readStoredPayload(
        this.casProbeKey,
        "probe",
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      if (afterStale === null) throw new TenantTelemetryDispositionCorruptError();
      this.validateProbe(afterStale.payload);
      if (staleError === undefined || afterStale.payload === stalePayload) {
        throw new S3TenantTelemetryDispositionError(
          "S3 tenant telemetry disposition endpoint ignored If-Match",
        );
      }
      if (!isConditionalConflict(staleError)) {
        if (staleError instanceof S3TenantTelemetryDispositionError) throw staleError;
        throw sanitizedS3Error("startup stale CAS probe", staleError);
      }
      return;
    }
    throw new S3TenantTelemetryDispositionError(
      "S3 tenant telemetry disposition CAS probe did not converge",
    );
  }

  async validateStartup(): Promise<void> {
    // Startup probes, head reads and scans can create a genesis object or promote a pending
    // event with CAS. Until source-bound product recovery is wired, even these are fixture-only.
    this.assertFixtureMutation();
    const deadline = this.operationDeadline();
    try {
      await this.send(deadline, (abortSignal) => this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      if (error instanceof S3TenantTelemetryDispositionError) throw error;
      throw sanitizedS3Error("startup reachability check", error);
    }
    let versioning;
    try {
      versioning = await this.send(deadline, (abortSignal) => this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      if (error instanceof S3TenantTelemetryDispositionError) throw error;
      throw sanitizedS3Error("startup versioning check", error);
    }
    if (versioning.Status !== undefined) {
      throw new S3TenantTelemetryDispositionError(
        "S3 tenant telemetry disposition bucket versioning must be disabled",
      );
    }
    try {
      const lifecycle = await this.send(deadline, (abortSignal) => this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if ((lifecycle.Rules?.length ?? 0) > 0) {
        throw new S3TenantTelemetryDispositionError(
          "S3 tenant telemetry disposition bucket lifecycle configuration must be absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "NoSuchLifecycleConfiguration") {
        if (error instanceof S3TenantTelemetryDispositionError) throw error;
        throw sanitizedS3Error("startup lifecycle check", error);
      }
    }
    try {
      const lock = await this.send(deadline, (abortSignal) => this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== undefined) {
        throw new S3TenantTelemetryDispositionError(
          "S3 tenant telemetry disposition bucket Object Lock must be absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "ObjectLockConfigurationNotFoundError"
        && errorName(error) !== "ObjectLockConfigurationNotFound"
        && errorStatus(error) !== 404) {
        if (error instanceof S3TenantTelemetryDispositionError) throw error;
        throw sanitizedS3Error("startup Object Lock check", error);
      }
    }
    const initialPayload = this.canonicalProbe(digest([
      "tenant-telemetry-disposition-create-probe-v1",
      this.journalTargetSha256,
    ]));
    const initial = encodeTenantTelemetryDispositionEnvelope("probe", initialPayload);
    const replacement = encodeTenantTelemetryDispositionEnvelope(
      "probe",
      this.canonicalProbe(randomBytes(32).toString("hex")),
    );
    try {
      await this.putCreateOnly(
        this.createProbeKey,
        initial,
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError
          || error instanceof S3TenantTelemetryDispositionError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    const readCreateProbe = async (): Promise<Buffer | null> => {
      const stored = await this.readStoredPayload(
        this.createProbeKey,
        "probe",
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      if (stored === null) return null;
      this.validateProbe(stored.payload);
      return encodeTenantTelemetryDispositionEnvelope("probe", stored.payload);
    };
    if (!(await readCreateProbe())?.equals(initial)) {
      throw new S3TenantTelemetryDispositionError(
        "S3 tenant telemetry disposition startup create probe conflicts",
      );
    }
    let ignored = false;
    try {
      await this.putCreateOnly(
        this.createProbeKey,
        replacement,
        TENANT_TELEMETRY_DISPOSITION_PROBE_CONTENT_TYPE,
        deadline,
      );
      ignored = true;
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3TenantTelemetryDispositionVersionedObjectError
          || error instanceof S3TenantTelemetryDispositionError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    if (ignored || !(await readCreateProbe())?.equals(initial)) {
      throw new S3TenantTelemetryDispositionError(
        "S3 tenant telemetry disposition endpoint ignored If-None-Match",
      );
    }
    await this.validateCompareAndSwap(deadline);
    await this.readCommittedChain(deadline);
  }

  async authorizeDeletion(
    evidence: TenantTelemetryDispositionEvidence,
  ): Promise<TenantTelemetryExternalAuthorizationProof> {
    this.assertFixtureMutation();
    validateTenantTelemetryDispositionEvidence(evidence);
    const deadline = this.operationDeadline();
    const committed = await this.append(deadline, (events, head) => {
      const existing = findTenantTelemetryDispositionAuthorization(
        events,
        evidence.dispositionOperationSha256,
      );
      if (existing !== undefined) {
        const expected = buildTenantTelemetryExternalAuthorizationProof(
          this.identity,
          evidence,
          emptyTenantTelemetryDispositionHead(this.identity),
        );
        if (existing.authorizationReceiptSha256 !== expected.authorizationReceiptSha256) {
          throw new TenantTelemetryDispositionConflictError();
        }
        return { existing: { eventType: "delete_authorized", result: existing } };
      }
      const fenceKey = tenantTelemetryDispositionFenceKey(evidence);
      if (events.some((event) => event.eventType === "delete_authorized"
        && tenantTelemetryDispositionFenceKey(event.result) === fenceKey)) {
        throw new TenantTelemetryDispositionConflictError();
      }
      return {
        proposal: {
          eventType: "delete_authorized",
          result: buildTenantTelemetryExternalAuthorizationProof(
            this.identity,
            evidence,
            head,
          ),
        },
      };
    });
    if (committed.eventType !== "delete_authorized") {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return clone(committed.result);
  }

  async recordTombstone(
    ack: TenantTelemetrySameKeyTombstoneAck,
  ): Promise<TenantTelemetryExternalTombstoneProof> {
    this.assertFixtureMutation();
    validateTenantTelemetrySameKeyTombstoneAck(ack);
    const deadline = this.operationDeadline();
    const committed = await this.append(deadline, (events, head) => {
      const authorization = findTenantTelemetryDispositionAuthorization(
        events,
        ack.dispositionOperationSha256,
      );
      if (authorization === undefined) throw new TenantTelemetryDispositionConflictError();
      const existing = findTenantTelemetryDispositionTerminal(
        events,
        ack.dispositionOperationSha256,
      );
      if (existing !== undefined) {
        if (existing.tombstoneAck.receiptSha256 !== ack.receiptSha256) {
          throw new TenantTelemetryDispositionConflictError();
        }
        return { existing: { eventType: "delete_tombstoned", result: existing } };
      }
      return {
        proposal: {
          eventType: "delete_tombstoned",
          result: buildTenantTelemetryExternalTombstoneProof(
            this.identity,
            authorization,
            ack,
            head,
          ),
        },
      };
    });
    if (committed.eventType !== "delete_tombstoned") {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return clone(committed.result);
  }

  async readHead(): Promise<TenantTelemetryDispositionExternalHead> {
    this.assertFixtureMutation();
    const committed = await this.readCommittedChain(this.operationDeadline());
    return clone(committed.state.head);
  }

  async scanEvents(
    options: ScanTenantTelemetryDispositionEventsOptions,
  ): Promise<ScanTenantTelemetryDispositionEventsResult> {
    this.assertFixtureMutation();
    validateTenantTelemetryDispositionExternalHead(options.sealedHead);
    const sealed = options.sealedHead;
    if (sealed.adapterProtocol !== this.adapterProtocol
      || sealed.journalNamespaceSha256 !== this.journalNamespaceSha256
      || sealed.journalTargetSha256 !== this.journalTargetSha256
      || sealed.failureDomainSha256 !== this.failureDomainSha256
      || sealed.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
      || !Number.isSafeInteger(options.afterJournalSequence)
      || options.afterJournalSequence < 0
      || options.afterJournalSequence > sealed.journalSequence
      || !SHA256.test(options.afterJournalEventRootSha256)
      || !Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const deadline = this.operationDeadline();
    const committed = await this.readCommittedChain(deadline);
    if (committed.state.head.journalSequence < sealed.journalSequence) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const events = await this.readChainThrough(sealed.journalSequence, deadline);
    const authoritativeSealed = this.headOf(events);
    if (!sameHead(authoritativeSealed, sealed)) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const cursorRoot = options.afterJournalSequence === 0
      ? emptyTenantTelemetryDispositionHead(this.identity).journalEventRootSha256
      : tenantTelemetryDispositionExternalEventProof(
        events[options.afterJournalSequence - 1]!,
      ).journalEventRootSha256;
    if (cursorRoot !== options.afterJournalEventRootSha256) {
      throw new TenantTelemetryDispositionConflictError();
    }
    const page = events.slice(
      options.afterJournalSequence,
      Math.min(sealed.journalSequence, options.afterJournalSequence + options.limit),
    ).map(clone);
    const last = page.at(-1);
    const proof = last === undefined
      ? undefined
      : tenantTelemetryDispositionExternalEventProof(last);
    const nextJournalSequence = proof?.journalSequence ?? options.afterJournalSequence;
    return {
      events: page,
      nextJournalSequence,
      nextJournalEventRootSha256:
        proof?.journalEventRootSha256 ?? options.afterJournalEventRootSha256,
      complete: nextJournalSequence === sealed.journalSequence,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client.destroy();
  }
}
