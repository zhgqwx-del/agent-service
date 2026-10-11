import { randomBytes } from "node:crypto";
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
  tenantBackupAvailabilityOperationSha256,
  tenantBackupCatalogEntrySha256,
  tenantBackupEvictionOperationSha256,
  tenantBackupReservationResolutionOperationSha256,
  tenantBackupRuntimeReservationOperationSha256,
  validateTenantBackupEvictionPlan,
  type ResolveTenantBackupRuntimeReservationInput,
  type TenantBackupAvailabilityAdapterResult,
  type TenantBackupEvictionAdapterResult,
  type TenantBackupRuntimeReservationAdapterResult,
  TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
  TENANT_BACKUP_CATALOG_PROTOCOL,
} from "../backup-catalog.js";
import {
  TenantBackupCatalogAdapterConflictError,
  TenantBackupCatalogAdapterCorruptError,
  assertEventChain,
  backupCatalogAdapterSha256,
  emptyTenantBackupCatalogHead,
  eventProof,
  operationOf,
  proofOf,
  sameAdapterEvent,
  tenantBackupAvailabilityReceiptSha256,
  tenantBackupEvictionReceiptSha256,
  tenantBackupReservationReceiptSha256,
  tenantBackupResolutionReceiptSha256,
  validateTenantBackupCatalogAdapterEvent,
  validateTenantBackupCatalogAdapterIdentity,
  validateTenantBackupCatalogHead,
  type PublishTenantBackupAvailabilityInput,
  type RecordTenantBackupEvictionInput,
  type ReserveTenantBackupRestoreInput,
  type ResolveTenantBackupRestoreInput,
  type ScanTenantBackupCatalogEventsOptions,
  type ScanTenantBackupCatalogEventsResult,
  type TenantBackupCatalogAdapter,
  type TenantBackupCatalogAdapterEvent,
  type TenantBackupCatalogAdapterIdentity,
  type TenantBackupCatalogHead,
} from "./common.js";
import {
  BACKUP_CATALOG_ENVELOPE_HEADER_BYTES,
  BACKUP_CATALOG_EVENT_CONTENT_TYPE,
  BACKUP_CATALOG_HEAD_CONTENT_TYPE,
  BACKUP_CATALOG_MAX_PAYLOAD_BYTES,
  BACKUP_CATALOG_PROBE_CONTENT_TYPE,
  decodeBackupCatalogEnvelope,
  encodeBackupCatalogEnvelope,
  type BackupCatalogEnvelopeKind,
} from "./codec.js";
import {
  buildTenantBackupCatalogStoredEvent,
  canonicalTenantBackupCatalogStoredEvent,
  parseCanonicalTenantBackupCatalogStoredEvent,
  type TenantBackupCatalogStoredEvent,
} from "./serialization.js";

export const S3_TENANT_BACKUP_CATALOG_PROTOCOL =
  "s3-cas-head-tenant-backup-catalog-v2" as const;

const DEFAULT_PREFIX = "tenant-backup-catalog";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_ATTEMPTS = 64;
const MAX_MUTATION_ATTEMPTS = 1_000;
const DEFAULT_SDK_ATTEMPTS = 2;
const SEQUENCE_WIDTH = 16;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = BACKUP_CATALOG_ENVELOPE_HEADER_BYTES
  + BACKUP_CATALOG_MAX_PAYLOAD_BYTES;
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

export interface S3TenantBackupCatalogAdapterOptions {
  /** Acknowledge that production places this catalog outside the primary database failure domain. */
  independentFailureDomain: true;
  /** Must be a bucket reserved for this catalog, not Blob, restore-journal, or backup bytes. */
  bucket: string;
  namespaceId: string;
  failureDomainId: string;
  prefix?: string;
  logicalDatabaseNamespaceSha256: string;
  region: string;
  /** `null` explicitly selects the SDK standard endpoint for `region`. */
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials?: S3ClientConfig["credentials"];
  client?: S3Client;
  requestTimeoutMs?: number;
  maxMutationAttempts?: number;
}

type StoredEventState =
  | { kind: "missing" }
  | { kind: "exact"; event: TenantBackupCatalogAdapterEvent }
  | { kind: "occupied"; event: TenantBackupCatalogAdapterEvent };

interface StoredPayload {
  payload: string;
  etag: string;
}

interface StoredHeadState {
  head: TenantBackupCatalogHead;
  etag: string;
}

const HEAD_SCOPE = "s3-tenant-backup-catalog-head-v2" as const;
const CAS_PROBE_SCOPE = "s3-tenant-backup-catalog-cas-probe-v1" as const;

class S3BackupCatalogSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3TenantBackupCatalogError";
  }
}

class S3BackupCatalogVersionedObjectError extends Error {
  constructor() {
    super("S3 tenant backup catalog operation returned versioned-object evidence");
    this.name = "S3TenantBackupCatalogVersionedObjectError";
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

function sanitizedS3Error(operation: string, error: unknown): S3BackupCatalogSafeError {
  const status = errorStatus(error);
  const name = errorName(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const detail = [safeName, status === undefined ? undefined : String(status)]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3BackupCatalogSafeError(
    `S3 tenant backup catalog ${operation} failed${detail ? ` (${detail})` : ""}`,
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
    throw new S3BackupCatalogVersionedObjectError();
  }
}

function validateBucket(bucket: string): void {
  if (
    bucket.length < 3
    || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
    || bucket.includes(".-")
    || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) throw new Error("S3 backup catalog bucket is invalid");
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length < 1
    || prefix.length > 512
    || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))
  ) throw new Error("S3 backup catalog prefix is invalid");
}

function validateNonSecretId(value: string, name: "namespace" | "failure domain"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`S3 backup catalog ${name} id is invalid`);
  }
}

function validateRegion(region: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new Error("S3 backup catalog region is invalid");
  }
  return region;
}

function normalizeEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("S3 backup catalog endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("S3 backup catalog endpoint must be a credential-free http(s) origin");
  return parsed.origin;
}

function validateDigest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`S3 backup catalog ${name} is invalid`);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function sameHead(left: TenantBackupCatalogHead, right: TenantBackupCatalogHead): boolean {
  return left.adapterProtocol === right.adapterProtocol
    && left.catalogNamespaceSha256 === right.catalogNamespaceSha256
    && left.catalogTargetSha256 === right.catalogTargetSha256
    && left.failureDomainSha256 === right.failureDomainSha256
    && left.catalogSequence === right.catalogSequence
    && left.catalogEventRootSha256 === right.catalogEventRootSha256;
}

export function s3TenantBackupCatalogNamespaceSha256(namespaceId: string): string {
  validateNonSecretId(namespaceId, "namespace");
  return backupCatalogAdapterSha256(["s3-tenant-backup-catalog-namespace-v1", namespaceId]);
}

export function s3TenantBackupCatalogFailureDomainSha256(failureDomainId: string): string {
  validateNonSecretId(failureDomainId, "failure domain");
  return backupCatalogAdapterSha256([
    "s3-tenant-backup-catalog-failure-domain-v1",
    failureDomainId,
  ]);
}

export function s3TenantBackupCatalogTargetSha256(input: {
  catalogNamespaceSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
}): string {
  validateDigest(input.catalogNamespaceSha256, "namespace digest");
  validateDigest(input.failureDomainSha256, "failure-domain digest");
  validateDigest(input.logicalDatabaseNamespaceSha256, "logical database namespace");
  validateBucket(input.bucket);
  validatePrefix(input.prefix);
  const region = validateRegion(input.region);
  const endpoint = normalizeEndpoint(input.endpoint);
  if (typeof input.forcePathStyle !== "boolean") {
    throw new Error("S3 backup catalog addressing mode is invalid");
  }
  return backupCatalogAdapterSha256([
    "s3-tenant-backup-catalog-target-v2",
    S3_TENANT_BACKUP_CATALOG_PROTOCOL,
    input.catalogNamespaceSha256,
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

function sequenceKey(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("tenant backup catalog sequence is invalid");
  }
  const value = String(sequence).padStart(SEQUENCE_WIDTH, "0");
  if (value.length !== SEQUENCE_WIDTH) throw new Error("tenant backup catalog sequence is exhausted");
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return;
  try {
    destroy.call(body);
  } catch {
    // Preserve the primary integrity or transport failure.
  }
}

function bodyAsAsyncIterable(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) return (async function* () { yield body; })();
  if (
    !body
    || (typeof body !== "object" && typeof body !== "function")
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) throw new TenantBackupCatalogAdapterCorruptError();
  return body as AsyncIterable<Uint8Array>;
}

async function readBoundedBody(
  body: unknown,
  contentLength: number | undefined,
  timeoutMs: number,
): Promise<Buffer> {
  if (contentLength !== undefined
    && (!Number.isSafeInteger(contentLength) || contentLength < 0
      || contentLength > MAX_ENVELOPE_BYTES)) {
    destroyBody(body);
    throw new TenantBackupCatalogAdapterCorruptError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      destroyBody(body);
      reject(new S3BackupCatalogSafeError("S3 tenant backup catalog response stream timed out"));
    }, timeoutMs);
    timer.unref();
  });
  const read = (async () => {
    for await (const value of bodyAsAsyncIterable(body)) {
      if (!(value instanceof Uint8Array)) throw new TenantBackupCatalogAdapterCorruptError();
      total += value.byteLength;
      if (total > MAX_ENVELOPE_BYTES) throw new TenantBackupCatalogAdapterCorruptError();
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  })();
  void read.catch(() => undefined);
  try {
    await Promise.race([read, timeout]);
  } catch (error) {
    destroyBody(body);
    if (error instanceof TenantBackupCatalogAdapterCorruptError
      || error instanceof S3BackupCatalogSafeError) throw error;
    throw sanitizedS3Error("response stream", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (contentLength !== undefined && total !== contentLength) {
    throw new TenantBackupCatalogAdapterCorruptError();
  }
  return Buffer.concat(chunks, total);
}

/** Append-only S3 authority. Physical backup deletion is never performed by this adapter. */
export class S3TenantBackupCatalogAdapter implements TenantBackupCatalogAdapter {
  readonly adapterProtocol = S3_TENANT_BACKUP_CATALOG_PROTOCOL;
  readonly catalogNamespaceSha256: string;
  readonly catalogTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly targetPrefix: string;
  private readonly headKey: string;
  private readonly casProbeKey: string;
  private readonly requestTimeoutMs: number;
  private readonly maxMutationAttempts: number;
  private closed = false;

  constructor(options: S3TenantBackupCatalogAdapterOptions) {
    if (options.independentFailureDomain !== true) {
      throw new Error("S3 backup catalog requires an independent failure-domain acknowledgement");
    }
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    const region = validateRegion(options.region);
    const endpoint = normalizeEndpoint(options.endpoint);
    validateBucket(this.bucket);
    validatePrefix(this.prefix);
    validateDigest(options.logicalDatabaseNamespaceSha256, "logical database namespace");
    if (typeof options.forcePathStyle !== "boolean") {
      throw new Error("S3 backup catalog addressing mode is invalid");
    }
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.catalogNamespaceSha256 = s3TenantBackupCatalogNamespaceSha256(options.namespaceId);
    this.failureDomainSha256 = s3TenantBackupCatalogFailureDomainSha256(options.failureDomainId);
    this.catalogTargetSha256 = s3TenantBackupCatalogTargetSha256({
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      bucket: this.bucket,
      prefix: this.prefix,
      region,
      endpoint,
      forcePathStyle: options.forcePathStyle,
    });
    validateTenantBackupCatalogAdapterIdentity(this.identity);
    this.targetPrefix = `${this.prefix}/targets/${this.catalogTargetSha256}`;
    this.headKey = `${this.targetPrefix}/authority/head-v2`;
    this.casProbeKey = `${this.prefix}/probes/conditional-cas-v1/${this.catalogTargetSha256}`;

    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error(
        `S3 backup catalog request timeout must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
    const maxMutationAttempts = options.maxMutationAttempts ?? DEFAULT_MUTATION_ATTEMPTS;
    if (!Number.isSafeInteger(maxMutationAttempts)
      || maxMutationAttempts < 1
      || maxMutationAttempts > MAX_MUTATION_ATTEMPTS) {
      throw new Error(
        `S3 backup catalog mutation attempts must be between 1 and ${MAX_MUTATION_ATTEMPTS}`,
      );
    }
    this.maxMutationAttempts = maxMutationAttempts;
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

  private get identity(): TenantBackupCatalogAdapterIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
      failureDomainSha256: this.failureDomainSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("S3 backup catalog adapter is closed");
  }

  private eventKey(sequence: number): string {
    return `${this.targetPrefix}/events/${sequenceKey(sequence)}`;
  }

  private async send<Output>(request: (abortSignal: AbortSignal) => Promise<Output>): Promise<Output> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error("S3 backup catalog request timed out"), {
          name: "TimeoutError",
        });
        reject(error);
        controller.abort(error);
      }, this.requestTimeoutMs);
    });
    const operation = Promise.resolve().then(() => request(controller.signal));
    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readStoredPayload(
    key: string,
    kind: BackupCatalogEnvelopeKind,
  ): Promise<StoredPayload | null> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.send((abortSignal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw sanitizedS3Error("read", error);
    }
    try {
      assertUnversionedEvidence(output);
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    const body = await readBoundedBody(output.Body, output.ContentLength, this.requestTimeoutMs);
    if (typeof output.ETag !== "string" || output.ETag.length < 1 || output.ETag.length > 512) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    try {
      return {
        payload: decodeBackupCatalogEnvelope(kind, body),
        etag: output.ETag,
      };
    } catch {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
  }

  private async readPayload(
    key: string,
    kind: BackupCatalogEnvelopeKind,
  ): Promise<string | null> {
    return (await this.readStoredPayload(key, kind))?.payload ?? null;
  }

  private async readStoredEvent(sequence: number): Promise<TenantBackupCatalogAdapterEvent | null> {
    const payload = await this.readPayload(this.eventKey(sequence), "event");
    if (payload === null) return null;
    let stored: TenantBackupCatalogStoredEvent;
    try {
      stored = parseCanonicalTenantBackupCatalogStoredEvent(payload);
    } catch {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (stored.adapterProtocol !== this.adapterProtocol
      || stored.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || stored.catalogTargetSha256 !== this.catalogTargetSha256
      || stored.failureDomainSha256 !== this.failureDomainSha256
      || proofOf(stored.event).catalogSequence !== sequence) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return stored.event;
  }

  private async inspectStoredEvent(
    expected: TenantBackupCatalogAdapterEvent,
  ): Promise<StoredEventState> {
    const stored = await this.readStoredEvent(proofOf(expected).catalogSequence);
    if (!stored) return { kind: "missing" };
    return sameAdapterEvent(stored, expected)
      ? { kind: "exact", event: stored }
      : { kind: "occupied", event: stored };
  }

  private canonicalHead(head: TenantBackupCatalogHead): string {
    validateTenantBackupCatalogHead(head);
    if (head.adapterProtocol !== this.adapterProtocol
      || head.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || head.catalogTargetSha256 !== this.catalogTargetSha256
      || head.failureDomainSha256 !== this.failureDomainSha256) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return JSON.stringify({
      scope: HEAD_SCOPE,
      adapterProtocol: head.adapterProtocol,
      catalogNamespaceSha256: head.catalogNamespaceSha256,
      catalogTargetSha256: head.catalogTargetSha256,
      failureDomainSha256: head.failureDomainSha256,
      catalogSequence: head.catalogSequence,
      catalogEventRootSha256: head.catalogEventRootSha256,
    });
  }

  private parseHead(payload: string): TenantBackupCatalogHead {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !exactKeys(parsed, [
        "scope", "adapterProtocol", "catalogNamespaceSha256", "catalogTargetSha256",
        "failureDomainSha256", "catalogSequence", "catalogEventRootSha256",
      ])) throw new TenantBackupCatalogAdapterCorruptError();
    const value = parsed as Record<string, unknown>;
    if (value.scope !== HEAD_SCOPE
      || value.adapterProtocol !== this.adapterProtocol
      || value.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || value.catalogTargetSha256 !== this.catalogTargetSha256
      || value.failureDomainSha256 !== this.failureDomainSha256
      || typeof value.catalogSequence !== "number"
      || typeof value.catalogEventRootSha256 !== "string") {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    const head: TenantBackupCatalogHead = {
      ...this.identity,
      catalogSequence: value.catalogSequence,
      catalogEventRootSha256: value.catalogEventRootSha256,
    };
    validateTenantBackupCatalogHead(head);
    return head;
  }

  private canonicalCasProbe(nonceSha256: string): string {
    validateDigest(nonceSha256, "CAS probe nonce");
    return JSON.stringify({
      scope: CAS_PROBE_SCOPE,
      adapterProtocol: this.adapterProtocol,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
      failureDomainSha256: this.failureDomainSha256,
      nonceSha256,
    });
  }

  private validateCasProbe(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !exactKeys(parsed, [
        "scope", "adapterProtocol", "catalogNamespaceSha256", "catalogTargetSha256",
        "failureDomainSha256", "nonceSha256",
      ])) throw new TenantBackupCatalogAdapterCorruptError();
    const value = parsed as Record<string, unknown>;
    if (value.scope !== CAS_PROBE_SCOPE
      || value.adapterProtocol !== this.adapterProtocol
      || value.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || value.catalogTargetSha256 !== this.catalogTargetSha256
      || value.failureDomainSha256 !== this.failureDomainSha256
      || typeof value.nonceSha256 !== "string"
      || !SHA256.test(value.nonceSha256)) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
  }

  private async putCreateOnly(key: string, body: Buffer, contentType: string): Promise<void> {
    const output = await this.send((abortSignal) => this.client.send(
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
  ): Promise<void> {
    const output = await this.send((abortSignal) => this.client.send(
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

  private async readEventsForSequences(sequences: Iterable<number>): Promise<TenantBackupCatalogAdapterEvent[]> {
    const events: TenantBackupCatalogAdapterEvent[] = [];
    for (const sequence of sequences) {
      const event = await this.readStoredEvent(sequence);
      if (!event) throw new TenantBackupCatalogAdapterCorruptError();
      events.push(event);
    }
    assertEventChain(this.identity, events);
    return events;
  }

  private async readChainThrough(sequence: number): Promise<TenantBackupCatalogAdapterEvent[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    const sequences = function* (): Generator<number> {
      for (let value = 1; value <= sequence; value += 1) yield value;
    };
    return this.readEventsForSequences(sequences());
  }

  private head(events: readonly TenantBackupCatalogAdapterEvent[]): TenantBackupCatalogHead {
    const last = events.at(-1);
    if (!last) return emptyTenantBackupCatalogHead(this.identity);
    const proof = proofOf(last);
    return {
      ...this.identity,
      catalogSequence: proof.catalogSequence,
      catalogEventRootSha256: proof.catalogEventRootSha256,
    };
  }

  private async readHeadObject(): Promise<StoredHeadState | null> {
    const stored = await this.readStoredPayload(this.headKey, "head");
    if (!stored) return null;
    return { head: this.parseHead(stored.payload), etag: stored.etag };
  }

  private async ensureHeadObject(): Promise<StoredHeadState> {
    const existing = await this.readHeadObject();
    if (existing) return existing;

    // v2 never infers a head from LIST. An event at sequence one without the CAS head belongs to
    // an incomplete/legacy target and must be handled by an explicit migration, not guessed here.
    if (await this.readStoredEvent(1)) throw new TenantBackupCatalogAdapterCorruptError();
    const genesis = emptyTenantBackupCatalogHead(this.identity);
    const body = encodeBackupCatalogEnvelope("head", this.canonicalHead(genesis));
    let putError: unknown;
    try {
      await this.putCreateOnly(this.headKey, body, BACKUP_CATALOG_HEAD_CONTENT_TYPE);
    } catch (error) {
      if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
      putError = error;
    }
    const observed = await this.readHeadObject();
    if (observed) return observed;
    if (putError) {
      if (isConditionalConflict(putError)) {
        throw new S3BackupCatalogSafeError(
          "S3 tenant backup catalog head initialization did not converge",
        );
      }
      throw sanitizedS3Error("head initialization", putError);
    }
    throw new S3BackupCatalogSafeError(
      "S3 tenant backup catalog head initialization was not durable",
    );
  }

  private async advanceHead(
    expected: StoredHeadState,
    desired: TenantBackupCatalogHead,
  ): Promise<StoredHeadState> {
    validateTenantBackupCatalogHead(expected.head);
    validateTenantBackupCatalogHead(desired);
    if (desired.catalogSequence !== expected.head.catalogSequence + 1) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    const body = encodeBackupCatalogEnvelope("head", this.canonicalHead(desired));
    let putError: unknown;
    try {
      await this.putCompareAndSwap(
        this.headKey,
        expected.etag,
        body,
        BACKUP_CATALOG_HEAD_CONTENT_TYPE,
      );
    } catch (error) {
      if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
      putError = error;
    }
    const observed = await this.readHeadObject();
    if (!observed) throw new TenantBackupCatalogAdapterCorruptError();
    if (observed.head.catalogSequence === desired.catalogSequence) {
      if (!sameHead(observed.head, desired)) throw new TenantBackupCatalogAdapterCorruptError();
      return observed;
    }
    if (observed.head.catalogSequence > desired.catalogSequence) return observed;
    if (!sameHead(observed.head, expected.head)) {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    if (putError) {
      throw sanitizedS3Error("head compare-and-swap", putError);
    }
    throw new S3BackupCatalogSafeError(
      "S3 tenant backup catalog head compare-and-swap was not durable",
    );
  }

  private async readCommittedChain(): Promise<{
    events: TenantBackupCatalogAdapterEvent[];
    state: StoredHeadState;
  }> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const state = await this.ensureHeadObject();
      const events = await this.readChainThrough(state.head.catalogSequence);
      if (!sameHead(this.head(events), state.head)) {
        throw new TenantBackupCatalogAdapterCorruptError();
      }
      if (state.head.catalogSequence === Number.MAX_SAFE_INTEGER) {
        return { events, state };
      }
      const pending = await this.readStoredEvent(state.head.catalogSequence + 1);
      if (!pending) return { events, state };
      assertEventChain(this.identity, [...events, pending]);
      await this.advanceHead(state, this.head([...events, pending]));
    }
    throw new S3BackupCatalogSafeError(
      "S3 tenant backup catalog pending head recovery did not converge",
    );
  }

  private async readChain(): Promise<TenantBackupCatalogAdapterEvent[]> {
    return (await this.readCommittedChain()).events;
  }

  private async append(
    build: (events: readonly TenantBackupCatalogAdapterEvent[], head: TenantBackupCatalogHead) =>
      { existing?: TenantBackupCatalogAdapterEvent; proposal?: TenantBackupCatalogAdapterEvent },
  ): Promise<TenantBackupCatalogAdapterEvent> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const committed = await this.readCommittedChain();
      const { events } = committed;
      const decision = build(events, committed.state.head);
      if (decision.existing) return clone(decision.existing);
      const proposal = decision.proposal;
      if (!proposal) throw new TenantBackupCatalogAdapterCorruptError();
      validateTenantBackupCatalogAdapterEvent(proposal);
      assertEventChain(this.identity, [...events, proposal]);
      const stored = buildTenantBackupCatalogStoredEvent(this.identity, proposal);
      const body = encodeBackupCatalogEnvelope(
        "event",
        canonicalTenantBackupCatalogStoredEvent(stored),
      );
      let putSucceeded = false;
      let putError: unknown;
      try {
        await this.putCreateOnly(
          this.eventKey(proofOf(proposal).catalogSequence),
          body,
          BACKUP_CATALOG_EVENT_CONTENT_TYPE,
        );
        putSucceeded = true;
      } catch (error) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        putError = error;
      }
      const state = await this.inspectStoredEvent(proposal);
      if (state.kind === "exact") {
        await this.advanceHead(committed.state, this.head([...events, state.event]));
        const verified = await this.readCommittedChain();
        const committedEvent = verified.events[proofOf(proposal).catalogSequence - 1];
        if (!committedEvent || !sameAdapterEvent(committedEvent, proposal)) {
          throw new TenantBackupCatalogAdapterCorruptError();
        }
        return clone(committedEvent);
      }
      if (state.kind === "occupied" || (putError && isConditionalConflict(putError))) continue;
      if (putSucceeded) continue;
      if (putError) throw sanitizedS3Error("conditional event create", putError);
    }
    throw new S3BackupCatalogSafeError("S3 tenant backup catalog event create did not converge");
  }

  private async ensureCasProbeObject(): Promise<StoredPayload> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const existing = await this.readStoredPayload(this.casProbeKey, "probe");
      if (existing) {
        this.validateCasProbe(existing.payload);
        return existing;
      }
      const payload = this.canonicalCasProbe(randomBytes(32).toString("hex"));
      const body = encodeBackupCatalogEnvelope("probe", payload);
      let putError: unknown;
      try {
        await this.putCreateOnly(
          this.casProbeKey,
          body,
          BACKUP_CATALOG_PROBE_CONTENT_TYPE,
        );
      } catch (error) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        putError = error;
      }
      const observed = await this.readStoredPayload(this.casProbeKey, "probe");
      if (observed) {
        this.validateCasProbe(observed.payload);
        if (!putError || observed.payload === payload || isConditionalConflict(putError)) {
          return observed;
        }
      }
      if (putError && !isConditionalConflict(putError)) {
        throw sanitizedS3Error("startup CAS probe initialization", putError);
      }
    }
    throw new S3BackupCatalogSafeError(
      "S3 tenant backup catalog startup CAS probe initialization did not converge",
    );
  }

  private async validateCompareAndSwap(): Promise<void> {
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const previous = await this.ensureCasProbeObject();
      const nextPayload = this.canonicalCasProbe(randomBytes(32).toString("hex"));
      const nextBody = encodeBackupCatalogEnvelope("probe", nextPayload);
      let putError: unknown;
      try {
        await this.putCompareAndSwap(
          this.casProbeKey,
          previous.etag,
          nextBody,
          BACKUP_CATALOG_PROBE_CONTENT_TYPE,
        );
      } catch (error) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        putError = error;
      }
      const observed = await this.readStoredPayload(this.casProbeKey, "probe");
      if (!observed) throw new TenantBackupCatalogAdapterCorruptError();
      this.validateCasProbe(observed.payload);
      const responseLossRecovered = putError !== undefined && observed.payload === nextPayload;
      if (putError && !responseLossRecovered) {
        if (isConditionalConflict(putError)) continue;
        throw sanitizedS3Error("startup CAS probe update", putError);
      }

      // The previous ETag is now permanently stale because every probe payload has a random nonce.
      // A successful write with it proves the endpoint ignored If-Match and cannot host the head.
      const stalePayload = this.canonicalCasProbe(randomBytes(32).toString("hex"));
      const staleBody = encodeBackupCatalogEnvelope("probe", stalePayload);
      let staleError: unknown;
      try {
        await this.putCompareAndSwap(
          this.casProbeKey,
          previous.etag,
          staleBody,
          BACKUP_CATALOG_PROBE_CONTENT_TYPE,
        );
      } catch (error) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        staleError = error;
      }
      const afterStale = await this.readStoredPayload(this.casProbeKey, "probe");
      if (!afterStale) throw new TenantBackupCatalogAdapterCorruptError();
      this.validateCasProbe(afterStale.payload);
      if (!staleError || afterStale.payload === stalePayload) {
        throw new S3BackupCatalogSafeError(
          "S3 tenant backup catalog endpoint ignored If-Match",
        );
      }
      if (!isConditionalConflict(staleError)) {
        throw sanitizedS3Error("startup stale CAS probe", staleError);
      }
      return;
    }
    throw new S3BackupCatalogSafeError(
      "S3 tenant backup catalog startup CAS probe did not converge",
    );
  }

  async validateStartup(): Promise<void> {
    this.assertOpen();
    try {
      await this.send((abortSignal) => this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup reachability check", error);
    }

    let versioning;
    try {
      versioning = await this.send((abortSignal) => this.client.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
    } catch (error) {
      throw sanitizedS3Error("startup versioning check", error);
    }
    if (versioning.Status !== undefined) {
      throw new S3BackupCatalogSafeError(
        "S3 tenant backup catalog bucket versioning must be disabled",
      );
    }

    try {
      const lifecycle = await this.send((abortSignal) => this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if ((lifecycle.Rules?.length ?? 0) > 0) {
        throw new S3BackupCatalogSafeError(
          "S3 tenant backup catalog bucket lifecycle configuration must be absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "NoSuchLifecycleConfiguration") {
        if (error instanceof S3BackupCatalogSafeError) throw error;
        throw sanitizedS3Error("startup lifecycle check", error);
      }
    }

    try {
      const lock = await this.send((abortSignal) => this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== undefined) {
        throw new S3BackupCatalogSafeError(
          "S3 tenant backup catalog bucket Object Lock must be disabled or absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "ObjectLockConfigurationNotFoundError"
        && errorName(error) !== "ObjectLockConfigurationNotFound"
        && errorStatus(error) !== 404) {
        if (error instanceof S3BackupCatalogSafeError) throw error;
        throw sanitizedS3Error("startup Object Lock check", error);
      }
    }

    const probeKey = `${this.prefix}/probes/conditional-create-v1/${this.catalogTargetSha256}`;
    const initial = encodeBackupCatalogEnvelope("probe", JSON.stringify({
      scope: "tenant-backup-catalog-probe-v1",
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
    }));
    const replacement = encodeBackupCatalogEnvelope("probe", JSON.stringify({
      scope: "tenant-backup-catalog-probe-conflict-v1",
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
    }));
    try {
      await this.putCreateOnly(probeKey, initial, BACKUP_CATALOG_PROBE_CONTENT_TYPE);
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    const readProbe = async (): Promise<Buffer | null> => {
      const payload = await this.readPayload(probeKey, "probe");
      return payload === null ? null : encodeBackupCatalogEnvelope("probe", payload);
    };
    if (!(await readProbe())?.equals(initial)) {
      throw new S3BackupCatalogSafeError("S3 tenant backup catalog startup probe conflicts");
    }
    let ignored = false;
    try {
      await this.putCreateOnly(probeKey, replacement, BACKUP_CATALOG_PROBE_CONTENT_TYPE);
      ignored = true;
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3BackupCatalogVersionedObjectError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    if (ignored || !(await readProbe())?.equals(initial)) {
      throw new S3BackupCatalogSafeError(
        "S3 tenant backup catalog endpoint ignored If-None-Match",
      );
    }
    await this.validateCompareAndSwap();
    // Startup also traverses the CAS-committed chain, so activation cannot accept a corrupt target.
    await this.readChain();
  }

  async publishAvailability(
    input: PublishTenantBackupAvailabilityInput,
  ): Promise<TenantBackupAvailabilityAdapterResult> {
    this.assertOpen();
    const operation = tenantBackupAvailabilityOperationSha256({
      ...input,
      catalogNamespaceSha256: this.catalogNamespaceSha256,
      catalogTargetSha256: this.catalogTargetSha256,
    });
    const receipt = tenantBackupAvailabilityReceiptSha256(this.identity, input, operation);
    const committed = await this.append((events, head) => {
      const existing = events.find((event) => event.eventType === "backup_recoverable"
        && event.result.backupId === input.backupId);
      if (existing?.eventType === "backup_recoverable") {
        if (existing.result.availabilityOperationSha256 !== operation
          || existing.result.availabilityReceiptSha256 !== receipt) {
          throw new TenantBackupCatalogAdapterConflictError();
        }
        return { existing };
      }
      if (events.some((event) => event.eventType === "backup_recoverable"
        && (event.result.sourceSnapshotSha256 === input.sourceSnapshotSha256
          || event.result.sourceBackupSha256 === input.sourceBackupSha256))) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      const proof = eventProof(head, "backup_recoverable", operation, receipt);
      const evidence = {
        ...this.identity,
        ...clone(input),
        availabilityOperationSha256: operation,
        availabilityReceiptSha256: receipt,
        ...proof,
      };
      const result: TenantBackupAvailabilityAdapterResult = {
        ...evidence,
        entrySha256: tenantBackupCatalogEntrySha256({
          scope: TENANT_BACKUP_CATALOG_ENTRY_SCOPE,
          protocol: TENANT_BACKUP_CATALOG_PROTOCOL,
          ...evidence,
        }),
      };
      return { proposal: { eventType: "backup_recoverable", result } };
    });
    if (committed.eventType !== "backup_recoverable") {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return clone(committed.result);
  }

  async inspectAvailability(backupId: string): Promise<TenantBackupAvailabilityAdapterResult | null> {
    this.assertOpen();
    const existing = (await this.readChain()).find((event) => (
      event.eventType === "backup_recoverable" && event.result.backupId === backupId
    ));
    return existing?.eventType === "backup_recoverable" ? clone(existing.result) : null;
  }

  async reserveRestore(
    input: ReserveTenantBackupRestoreInput,
  ): Promise<TenantBackupRuntimeReservationAdapterResult> {
    this.assertOpen();
    const operation = tenantBackupRuntimeReservationOperationSha256(input);
    const receipt = tenantBackupReservationReceiptSha256(this.identity, input, operation);
    const committed = await this.append((events, head) => {
      const existing = events.find((event) => event.eventType === "restore_reserved"
        && event.result.restoreRunId === input.restoreRunId);
      if (existing?.eventType === "restore_reserved") {
        if (existing.result.reservationOperationSha256 !== operation
          || existing.result.reservationReceiptSha256 !== receipt) {
          throw new TenantBackupCatalogAdapterConflictError();
        }
        return { existing };
      }
      const available = events.some((event) => event.eventType === "backup_recoverable"
        && event.result.backupId === input.backupId
        && event.result.entrySha256 === input.entrySha256);
      const evicted = events.some((event) => event.eventType === "backup_evicted"
        && event.result.backupId === input.backupId);
      const epochUsed = events.some((event) => event.eventType === "restore_reserved"
        && event.result.runtimeEpochSha256 === input.runtimeEpochSha256);
      const activeReservation = events.some((event) => event.eventType === "restore_reserved"
        && !events.some((candidate) => candidate.eventType === "restore_resolved"
          && candidate.result.restoreRunId === event.result.restoreRunId));
      if (!available || evicted || epochUsed || activeReservation) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      const proof = eventProof(head, "restore_reserved", operation, receipt);
      const result: TenantBackupRuntimeReservationAdapterResult = {
        adapterProtocol: this.adapterProtocol,
        catalogNamespaceSha256: this.catalogNamespaceSha256,
        catalogTargetSha256: this.catalogTargetSha256,
        ...clone(input),
        reservationOperationSha256: operation,
        reservationReceiptSha256: receipt,
        ...proof,
      };
      return { proposal: { eventType: "restore_reserved", result } };
    });
    if (committed.eventType !== "restore_reserved") {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return clone(committed.result);
  }

  async resolveRestore(
    input: ResolveTenantBackupRestoreInput,
  ): Promise<ResolveTenantBackupRuntimeReservationInput> {
    this.assertOpen();
    const operation = tenantBackupReservationResolutionOperationSha256(input);
    const receipt = tenantBackupResolutionReceiptSha256(input);
    const committed = await this.append((events, head) => {
      const reservation = events.find((event) => event.eventType === "restore_reserved"
        && event.result.restoreRunId === input.restoreRunId);
      if (reservation?.eventType !== "restore_reserved") {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      if (reservation.result.reservationReceiptSha256 !== input.reservationReceiptSha256) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      const existing = events.find((event) => event.eventType === "restore_resolved"
        && event.result.restoreRunId === input.restoreRunId);
      if (existing?.eventType === "restore_resolved") {
        if (existing.result.phase !== input.phase
          || existing.result.resolutionOperationSha256 !== operation
          || existing.result.resolutionReceiptSha256 !== receipt) {
          throw new TenantBackupCatalogAdapterConflictError();
        }
        return { existing };
      }
      const proof = eventProof(head, "restore_resolved", operation, receipt);
      const result: ResolveTenantBackupRuntimeReservationInput = {
        restoreRunId: input.restoreRunId,
        reservationReceiptSha256: input.reservationReceiptSha256,
        phase: input.phase,
        resolutionOperationSha256: operation,
        resolutionReceiptSha256: receipt,
        ...proof,
      };
      return { proposal: { eventType: "restore_resolved", result } };
    });
    if (committed.eventType !== "restore_resolved") {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return clone(committed.result);
  }

  async recordEviction(
    input: RecordTenantBackupEvictionInput,
  ): Promise<TenantBackupEvictionAdapterResult> {
    this.assertOpen();
    validateTenantBackupEvictionPlan(input.plan);
    const operation = tenantBackupEvictionOperationSha256(input.plan);
    const receipt = tenantBackupEvictionReceiptSha256(input);
    const committed = await this.append((events, head) => {
      const existing = events.find((event) => event.eventType === "backup_evicted"
        && event.result.backupId === input.plan.backupId);
      if (existing?.eventType === "backup_evicted") {
        if (existing.result.evictionOperationSha256 !== operation
          || existing.result.acknowledgementReceiptSha256 !== receipt) {
          throw new TenantBackupCatalogAdapterConflictError();
        }
        return { existing };
      }
      if (events.some((event) => event.eventType === "backup_evicted"
        && event.result.evictionId === input.plan.evictionId)) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      const available = events.some((event) => event.eventType === "backup_recoverable"
        && event.result.backupId === input.plan.backupId);
      const activeRuns = new Set<string>();
      for (const event of events) {
        if (event.eventType === "restore_reserved" && event.result.backupId === input.plan.backupId) {
          activeRuns.add(event.result.restoreRunId);
        } else if (event.eventType === "restore_resolved") {
          activeRuns.delete(event.result.restoreRunId);
        }
      }
      if (operation !== input.plan.evictionOperationSha256
        || !available
        || activeRuns.size > 0
        || input.plan.expectedCatalogSequence !== head.catalogSequence
        || input.plan.expectedCatalogEventRootSha256 !== head.catalogEventRootSha256) {
        throw new TenantBackupCatalogAdapterConflictError();
      }
      const proof = eventProof(head, "backup_evicted", operation, receipt);
      const result: TenantBackupEvictionAdapterResult = {
        adapterProtocol: this.adapterProtocol,
        catalogNamespaceSha256: this.catalogNamespaceSha256,
        catalogTargetSha256: this.catalogTargetSha256,
        evictionId: input.plan.evictionId,
        backupId: input.plan.backupId,
        planSha256: input.plan.planSha256,
        evictionOperationSha256: operation,
        acknowledgementReceiptSha256: receipt,
        externalTombstoneSha256: input.externalTombstoneSha256,
        observedAbsent: true,
        ...proof,
      };
      return { proposal: { eventType: "backup_evicted", result } };
    });
    if (committed.eventType !== "backup_evicted") {
      throw new TenantBackupCatalogAdapterCorruptError();
    }
    return clone(committed.result);
  }

  async readHead(): Promise<TenantBackupCatalogHead> {
    this.assertOpen();
    const result = (await this.readCommittedChain()).state.head;
    validateTenantBackupCatalogHead(result);
    return clone(result);
  }

  async scanEvents(
    options: ScanTenantBackupCatalogEventsOptions,
  ): Promise<ScanTenantBackupCatalogEventsResult> {
    this.assertOpen();
    validateTenantBackupCatalogHead(options.sealedHead);
    if (options.sealedHead.adapterProtocol !== this.adapterProtocol
      || options.sealedHead.catalogNamespaceSha256 !== this.catalogNamespaceSha256
      || options.sealedHead.catalogTargetSha256 !== this.catalogTargetSha256
      || options.sealedHead.failureDomainSha256 !== this.failureDomainSha256
      || !Number.isSafeInteger(options.afterCatalogSequence)
      || options.afterCatalogSequence < 0
      || options.afterCatalogSequence > options.sealedHead.catalogSequence
      || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const events = await this.readChainThrough(options.sealedHead.catalogSequence);
    const sealedRoot = events.at(-1)
      ? proofOf(events.at(-1)!).catalogEventRootSha256
      : emptyTenantBackupCatalogHead(this.identity).catalogEventRootSha256;
    const cursorRoot = options.afterCatalogSequence === 0
      ? emptyTenantBackupCatalogHead(this.identity).catalogEventRootSha256
      : proofOf(events[options.afterCatalogSequence - 1]!).catalogEventRootSha256;
    if (sealedRoot !== options.sealedHead.catalogEventRootSha256
      || cursorRoot !== options.afterCatalogEventRootSha256) {
      throw new TenantBackupCatalogAdapterConflictError();
    }
    const page = events.slice(
      options.afterCatalogSequence,
      Math.min(options.sealedHead.catalogSequence, options.afterCatalogSequence + options.limit),
    ).map(clone);
    const final = page.at(-1);
    const finalProof = final ? proofOf(final) : undefined;
    return {
      events: page,
      nextCatalogSequence: finalProof?.catalogSequence ?? options.afterCatalogSequence,
      nextCatalogEventRootSha256:
        finalProof?.catalogEventRootSha256 ?? options.afterCatalogEventRootSha256,
      complete: (finalProof?.catalogSequence ?? options.afterCatalogSequence)
        === options.sealedHead.catalogSequence,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.destroy();
  }
}
