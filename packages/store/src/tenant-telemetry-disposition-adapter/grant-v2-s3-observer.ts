import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  TenantTelemetryDispositionCorruptError,
  validateTenantTelemetryDispositionJournalIdentity,
  type TenantTelemetryDispositionJournalIdentity,
} from "../tenant-telemetry-disposition.js";
import { canonicalJson } from "./common.js";
import {
  assertTenantTelemetryGrantJournalChainV2,
  validateTenantTelemetryGrantAuthorizationEventV2,
  validateTenantTelemetryGrantJournalHeadV2,
  type TenantTelemetryGrantAuthorizationEventV2,
  type TenantTelemetryGrantJournalHeadV2,
} from "./grant-v2.js";
import {
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE,
  TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_ENVELOPE_BYTES,
  decodeTenantTelemetryGrantJournalV2Envelope,
  type TenantTelemetryGrantJournalV2EnvelopeKind,
} from "./grant-v2-envelope.js";

/**
 * This protocol identity is disjoint from the v1 caller-evidence journal.
 * This class has no writer, grant, marker, restore or startup-gate method.
 */
export const S3_TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2 =
  "s3-cas-head-tenant-telemetry-grant-journal-v2" as const;

const DEFAULT_PREFIX = "tenant-telemetry-disposition";
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_EVENTS = 10_000;
const MAX_EVENTS = 100_000;
const SEQUENCE_WIDTH = 16;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_S3_ERROR_NAMES = new Set([
  "AbortError", "AccessDenied", "CredentialsProviderError", "InternalError",
  "InvalidAccessKeyId", "InvalidRequest", "NetworkingError", "NoSuchBucket",
  "ServiceUnavailable", "SignatureDoesNotMatch", "SlowDown", "TimeoutError",
]);

interface Deadline {
  expiresAtMs: number;
}

interface StoredPayload {
  payload: string;
  etag: string;
}

interface StoredHead {
  head: TenantTelemetryGrantJournalHeadV2;
  etag: string;
}

export interface S3TenantTelemetryGrantJournalObserverV2Options {
  /** Operator assertion, not a proof produced by this read-only observer. */
  independentFailureDomain: true;
  /** Operator assertion after independently verifying private bucket access. */
  privateBucketAccessVerified: true;
  bucket: string;
  namespaceId: string;
  failureDomainId: string;
  logicalDatabaseNamespaceSha256: string;
  prefix?: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials?: S3ClientConfig["credentials"];
  client?: S3Client;
  /** Whole-operation deadline, including credentials, GET/HEAD and streams. */
  operationTimeoutMs?: number;
  /** Bounds one observation's work and memory; a longer chain fails closed. */
  maxEvents?: number;
}

export interface TenantTelemetryGrantJournalObservationV2 {
  sealedHead: TenantTelemetryGrantJournalHeadV2;
  observedEventCount: number;
  sealedChainObserved: true;
  /** Chain syntax alone is not a trusted DB grant or restore fence. */
  grantReady: false;
  executionReady: false;
  externalAuthorityVerified: false;
  restoreFenceVerified: false;
}

export class S3TenantTelemetryGrantJournalObserverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3TenantTelemetryGrantJournalObserverError";
  }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof value === "number" ? value : undefined;
}

function nameOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function missingObject(error: unknown): boolean {
  // A generic 404 can mean NoSuchBucket. Only an explicit missing-key code
  // can establish absence of the pending slot.
  return nameOf(error) === "NoSuchKey" || nameOf(error) === "NoSuchObject";
}

function sanitizedError(operation: string, error: unknown): Error {
  const name = nameOf(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const status = statusOf(error);
  const detail = [safeName, status === undefined ? undefined : String(status)]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3TenantTelemetryGrantJournalObserverError(
    `S3 telemetry grant journal v2 ${operation} failed${detail ? ` (${detail})` : ""}`,
  );
}

function rejectVersioned(output: { VersionId?: string; DeleteMarker?: boolean }): void {
  if (output.VersionId !== undefined || output.DeleteMarker === true) {
    throw new TenantTelemetryDispositionCorruptError();
  }
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") return;
  try {
    destroy.call(body);
  } catch {
    // Keep the primary transport or integrity failure.
  }
}

function iterableBody(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) return (async function* () { yield body; })();
  if (!body || typeof body !== "object"
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
      !== "function") {
    throw new TenantTelemetryDispositionCorruptError();
  }
  return body as AsyncIterable<Uint8Array>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validDigest(value: string, name: string): void {
  if (!SHA256.test(value)) throw new Error(`S3 telemetry grant journal v2 ${name} is invalid`);
}

function validId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`S3 telemetry grant journal v2 ${name} id is invalid`);
  }
}

function validBucket(bucket: string): void {
  if (bucket.length < 3 || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error("S3 telemetry grant journal v2 bucket is invalid");
  }
}

function validPrefix(prefix: string): void {
  if (prefix.length < 1 || prefix.length > 512
    || prefix.startsWith("/") || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))) {
    throw new Error("S3 telemetry grant journal v2 prefix is invalid");
  }
}

function validRegion(region: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new Error("S3 telemetry grant journal v2 region is invalid");
  }
  return region;
}

function normalizedEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("S3 telemetry grant journal v2 endpoint is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.search || url.hash
    || (url.pathname && url.pathname !== "/")) {
    throw new Error("S3 telemetry grant journal v2 endpoint must be a credential-free origin");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("S3 telemetry grant journal v2 production endpoint must use HTTPS");
  }
  return url.origin;
}

function sequenceKey(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TenantTelemetryDispositionCorruptError();
  }
  const key = String(sequence).padStart(SEQUENCE_WIDTH, "0");
  if (key.length !== SEQUENCE_WIDTH) throw new TenantTelemetryDispositionCorruptError();
  return key;
}

function parseCanonical(payload: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
    if (canonicalJson(parsed) !== payload) throw new TenantTelemetryDispositionCorruptError();
  } catch {
    throw new TenantTelemetryDispositionCorruptError();
  }
  return parsed;
}

function sameIdentity(
  expected: TenantTelemetryDispositionJournalIdentity,
  actual: TenantTelemetryDispositionJournalIdentity,
): boolean {
  return expected.adapterProtocol === actual.adapterProtocol
    && expected.journalNamespaceSha256 === actual.journalNamespaceSha256
    && expected.journalTargetSha256 === actual.journalTargetSha256
    && expected.failureDomainSha256 === actual.failureDomainSha256
    && expected.logicalDatabaseNamespaceSha256 === actual.logicalDatabaseNamespaceSha256;
}

export function s3TenantTelemetryGrantJournalNamespaceSha256V2(namespaceId: string): string {
  validId(namespaceId, "namespace");
  return digest(["s3-telemetry-grant-journal-namespace-v2", namespaceId]);
}

export function s3TenantTelemetryGrantJournalFailureDomainSha256V2(
  failureDomainId: string,
): string {
  validId(failureDomainId, "failure domain");
  return digest(["s3-telemetry-grant-journal-failure-domain-v2", failureDomainId]);
}

export function s3TenantTelemetryGrantJournalTargetSha256V2(input: {
  journalNamespaceSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
}): string {
  validDigest(input.journalNamespaceSha256, "namespace digest");
  validDigest(input.failureDomainSha256, "failure-domain digest");
  validDigest(input.logicalDatabaseNamespaceSha256, "logical database namespace");
  validBucket(input.bucket);
  validPrefix(input.prefix);
  const region = validRegion(input.region);
  const endpoint = normalizedEndpoint(input.endpoint);
  if (typeof input.forcePathStyle !== "boolean") {
    throw new Error("S3 telemetry grant journal v2 addressing mode is invalid");
  }
  return digest([
    "s3-telemetry-grant-journal-target-v2",
    S3_TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2,
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

/**
 * Read-only, default-unwired observer. GETs the v2 head, every sealed event
 * and the immediate pending slot, then GETs the head and pending slot again.
 * It never initializes a missing head or helps a pending writer advance it.
 * No result from this class is deletion authorization or restore proof.
 */
export class S3TenantTelemetryGrantJournalObserverV2 {
  readonly adapterProtocol = S3_TENANT_TELEMETRY_GRANT_JOURNAL_PROTOCOL_V2;
  readonly journalNamespaceSha256: string;
  readonly journalTargetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly targetPrefix: string;
  private readonly headKey: string;
  private readonly operationTimeoutMs: number;
  private readonly maxEvents: number;
  private closed = false;

  constructor(options: S3TenantTelemetryGrantJournalObserverV2Options) {
    if (options.independentFailureDomain !== true
      || options.privateBucketAccessVerified !== true) {
      throw new Error("S3 telemetry grant journal v2 requires operator bucket attestations");
    }
    validBucket(options.bucket);
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    validPrefix(prefix);
    const region = validRegion(options.region);
    const endpoint = normalizedEndpoint(options.endpoint);
    validDigest(options.logicalDatabaseNamespaceSha256, "logical database namespace");
    if (typeof options.forcePathStyle !== "boolean") {
      throw new Error("S3 telemetry grant journal v2 addressing mode is invalid");
    }
    this.bucket = options.bucket;
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.journalNamespaceSha256 =
      s3TenantTelemetryGrantJournalNamespaceSha256V2(options.namespaceId);
    this.failureDomainSha256 =
      s3TenantTelemetryGrantJournalFailureDomainSha256V2(options.failureDomainId);
    this.journalTargetSha256 = s3TenantTelemetryGrantJournalTargetSha256V2({
      journalNamespaceSha256: this.journalNamespaceSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      bucket: this.bucket,
      prefix,
      region,
      endpoint,
      forcePathStyle: options.forcePathStyle,
    });
    validateTenantTelemetryDispositionJournalIdentity(this.identity);
    this.targetPrefix = `${prefix}/targets/${this.journalTargetSha256}`;
    this.headKey = `${this.targetPrefix}/authority/head-v2`;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.operationTimeoutMs)
      || this.operationTimeoutMs < MIN_TIMEOUT_MS
      || this.operationTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("S3 telemetry grant journal v2 operation timeout is invalid");
    }
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isSafeInteger(this.maxEvents)
      || this.maxEvents < 0 || this.maxEvents > MAX_EVENTS) {
      throw new Error("S3 telemetry grant journal v2 max events is invalid");
    }
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
      maxAttempts: 2,
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
    if (this.closed) throw new Error("S3 telemetry grant journal v2 observer is closed");
  }

  private remainingMs(deadline: Deadline): number {
    const remaining = deadline.expiresAtMs - Date.now();
    if (remaining <= 0) {
      throw new S3TenantTelemetryGrantJournalObserverError(
        "S3 telemetry grant journal v2 operation deadline exceeded",
      );
    }
    return remaining;
  }

  private async send<Output>(
    deadline: Deadline,
    request: (abortSignal: AbortSignal) => Promise<Output>,
  ): Promise<Output> {
    const controller = new AbortController();
    const remaining = this.remainingMs(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error("S3 telemetry grant journal v2 timed out"), {
          name: "TimeoutError",
        });
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

  private async readBody(
    body: unknown,
    contentLength: number | undefined,
    deadline: Deadline,
  ): Promise<Buffer> {
    if (contentLength !== undefined
      && (!Number.isSafeInteger(contentLength)
        || contentLength < 0
        || contentLength > TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_ENVELOPE_BYTES)) {
      destroyBody(body);
      throw new TenantTelemetryDispositionCorruptError();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        destroyBody(body);
        reject(new S3TenantTelemetryGrantJournalObserverError(
          "S3 telemetry grant journal v2 response stream timed out",
        ));
      }, this.remainingMs(deadline));
      timer.unref();
    });
    const read = (async () => {
      for await (const chunk of iterableBody(body)) {
        this.remainingMs(deadline);
        if (!(chunk instanceof Uint8Array)) throw new TenantTelemetryDispositionCorruptError();
        total += chunk.byteLength;
        if (total > TENANT_TELEMETRY_GRANT_JOURNAL_V2_MAX_ENVELOPE_BYTES) {
          throw new TenantTelemetryDispositionCorruptError();
        }
        chunks.push(Buffer.from(chunk));
      }
    })();
    void read.catch(() => undefined);
    try {
      await Promise.race([read, timeout]);
    } catch (error) {
      destroyBody(body);
      if (error instanceof TenantTelemetryDispositionCorruptError
        || error instanceof S3TenantTelemetryGrantJournalObserverError) throw error;
      throw sanitizedError("response stream", error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (contentLength !== undefined && total !== contentLength) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return Buffer.concat(chunks, total);
  }

  private async readObject(
    key: string,
    kind: TenantTelemetryGrantJournalV2EnvelopeKind,
    contentType: string,
    deadline: Deadline,
  ): Promise<StoredPayload | null> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.send(deadline, (abortSignal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      ));
    } catch (error) {
      if (missingObject(error)) return null;
      if (error instanceof S3TenantTelemetryGrantJournalObserverError) throw error;
      throw sanitizedError("GET", error);
    }
    try {
      rejectVersioned(output);
      if (output.ContentType !== contentType
        || typeof output.ETag !== "string"
        || output.ETag.length < 1 || output.ETag.length > 512) {
        throw new TenantTelemetryDispositionCorruptError();
      }
    } catch (error) {
      destroyBody(output.Body);
      throw error;
    }
    const bytes = await this.readBody(output.Body, output.ContentLength, deadline);
    return {
      payload: decodeTenantTelemetryGrantJournalV2Envelope(kind, bytes),
      etag: output.ETag,
    };
  }

  private async readHead(deadline: Deadline): Promise<StoredHead> {
    const stored = await this.readObject(
      this.headKey,
      "head",
      TENANT_TELEMETRY_GRANT_JOURNAL_V2_HEAD_CONTENT_TYPE,
      deadline,
    );
    if (stored === null) throw new TenantTelemetryDispositionCorruptError();
    const head = parseCanonical(stored.payload) as TenantTelemetryGrantJournalHeadV2;
    validateTenantTelemetryGrantJournalHeadV2(head);
    if (!sameIdentity(this.identity, head)) throw new TenantTelemetryDispositionCorruptError();
    return { head, etag: stored.etag };
  }

  private eventKey(sequence: number): string {
    return `${this.targetPrefix}/events-v2/${sequenceKey(sequence)}`;
  }

  private async readEvent(
    sequence: number,
    deadline: Deadline,
  ): Promise<TenantTelemetryGrantAuthorizationEventV2> {
    const stored = await this.readObject(
      this.eventKey(sequence),
      "event",
      TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
      deadline,
    );
    if (stored === null) throw new TenantTelemetryDispositionCorruptError();
    const event = parseCanonical(stored.payload) as TenantTelemetryGrantAuthorizationEventV2;
    validateTenantTelemetryGrantAuthorizationEventV2(event);
    if (!sameIdentity(this.identity, event) || event.journalSequence !== sequence) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return event;
  }

  private async assertNoPending(sequence: number, deadline: Deadline): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence > Number.MAX_SAFE_INTEGER) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    // GET distinguishes NoSuchKey from NoSuchBucket; a bare HEAD 404 does not.
    const pending = await this.readObject(
      this.eventKey(sequence),
      "event",
      TENANT_TELEMETRY_GRANT_JOURNAL_V2_EVENT_CONTENT_TYPE,
      deadline,
    );
    if (pending === null) return;
    throw new TenantTelemetryDispositionCorruptError();
  }

  async observeSealedChain(): Promise<TenantTelemetryGrantJournalObservationV2> {
    this.assertOpen();
    const deadline = { expiresAtMs: Date.now() + this.operationTimeoutMs };
    const first = await this.readHead(deadline);
    if (first.head.journalSequence > this.maxEvents
      || first.head.journalSequence >= Number.MAX_SAFE_INTEGER) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const events: TenantTelemetryGrantAuthorizationEventV2[] = [];
    for (let sequence = 1; sequence <= first.head.journalSequence; sequence += 1) {
      events.push(await this.readEvent(sequence, deadline));
    }
    assertTenantTelemetryGrantJournalChainV2(this.identity, events, first.head);
    // An event published without its CAS head is not a sealed authority event.
    // Never repair or advance it from an observer.
    await this.assertNoPending(first.head.journalSequence + 1, deadline);
    const second = await this.readHead(deadline);
    if (first.etag !== second.etag
      || canonicalJson(first.head) !== canonicalJson(second.head)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    await this.assertNoPending(first.head.journalSequence + 1, deadline);
    return {
      sealedHead: structuredClone(first.head),
      observedEventCount: events.length,
      sealedChainObserved: true,
      grantReady: false,
      executionReady: false,
      externalAuthorityVerified: false,
      restoreFenceVerified: false,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }
}
