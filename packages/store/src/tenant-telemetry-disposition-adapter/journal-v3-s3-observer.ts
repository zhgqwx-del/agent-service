import { createHash } from "node:crypto";
import {
  GetObjectCommand, S3Client,
  type GetObjectCommandOutput, type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  TenantTelemetryDispositionCorruptError,
} from "../tenant-telemetry-disposition.js";
import { canonicalJson } from "./common.js";
import {
  S3_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ADAPTER_V3,
  assertTenantTelemetryDispositionChainV3,
  validateTenantTelemetryDispositionEventV3,
  validateTenantTelemetryDispositionHeadV3,
  type TenantTelemetryDispositionEventV3,
  type TenantTelemetryDispositionHeadV3,
  type TenantTelemetryDispositionJournalIdentityV3,
} from "./journal-v3.js";
import {
  TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE,
  TENANT_TELEMETRY_DISPOSITION_V3_MAX_ENVELOPE_BYTES,
  decodeTenantTelemetryDispositionV3Envelope,
  type TenantTelemetryDispositionV3EnvelopeKind,
} from "./journal-v3-envelope.js";

const DEFAULT_PREFIX = "tenant-telemetry-disposition";
const SHA256 = /^[0-9a-f]{64}$/;
const SEQUENCE_WIDTH = 16;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error("telemetry disposition v3 identifier is invalid");
  }
}

function validDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error("telemetry disposition v3 digest is invalid");
}

function validBucket(bucket: string): void {
  if (bucket.length < 3 || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error("telemetry disposition v3 bucket is invalid");
  }
}

function validPrefix(prefix: string): void {
  if (prefix.length < 1 || prefix.length > 512 || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))) {
    throw new Error("telemetry disposition v3 prefix is invalid");
  }
}

function normalizedEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("telemetry disposition v3 endpoint is invalid"); }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname
    || url.username || url.password || url.search || url.hash
    || (url.pathname && url.pathname !== "/")) {
    throw new Error("telemetry disposition v3 endpoint must be a credential-free origin");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("telemetry disposition v3 production endpoint must use HTTPS");
  }
  return url.origin;
}

function metadata(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>).$metadata;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function versionEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    const record = value as Record<string, unknown>;
    for (const candidate of [record, record.$metadata, record.$response]) {
      if (!candidate || typeof candidate !== "object") continue;
      const fields = candidate as Record<string, unknown>;
      if (["VersionId", "versionId", "DeleteMarker", "deleteMarker"]
        .some((key) => fields[key] !== undefined)) return true;
      const headers = fields.headers ?? fields.httpHeaders;
      if (!headers || typeof headers !== "object") continue;
      const get = (headers as { get?: unknown }).get;
      if (typeof get === "function"
        && (get.call(headers, "x-amz-version-id") != null
          || get.call(headers, "x-amz-delete-marker") != null)) return true;
      if (Object.entries(headers).some(([key, item]) =>
        (key.toLowerCase() === "x-amz-version-id" || key.toLowerCase() === "x-amz-delete-marker")
        && item !== undefined)) return true;
    }
  } catch { return true; }
  return false;
}

function missingKey(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return metadata(error)?.httpStatusCode === 404
    && (name === "NoSuchKey" || name === "NoSuchObject")
    && !versionEvidence(error);
}

function unversioned(output: { VersionId?: string; DeleteMarker?: boolean }): void {
  if (output.VersionId !== undefined || output.DeleteMarker !== undefined) {
    throw new TenantTelemetryDispositionCorruptError();
  }
}

function destroyBody(body: unknown): void {
  if (!body || (typeof body !== "object" && typeof body !== "function")) return;
  const destroy = (body as { destroy?: unknown }).destroy;
  if (typeof destroy === "function") try { destroy.call(body); } catch { /* Preserve original error. */ }
}

function parseCanonical(payload: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (canonicalJson(parsed) !== payload) throw new Error("noncanonical");
    return parsed;
  } catch { throw new TenantTelemetryDispositionCorruptError(); }
}

function same<T>(left: T, right: T): boolean { return canonicalJson(left) === canonicalJson(right); }

export interface S3TenantTelemetryDispositionJournalV3ObserverOptions {
  /** Operator assertions, not automated proof of private IAM or failure-domain separation. */
  independentFailureDomain: true;
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
  operationTimeoutMs?: number;
  maxEvents?: number;
}

export interface TenantTelemetryDispositionJournalReadObservationV3 {
  sealedHead: TenantTelemetryDispositionHeadV3;
  events: TenantTelemetryDispositionEventV3[];
  sealedChainObserved: true;
  grantReady: false;
  executionReady: false;
  externalAuthorityVerified: false;
  restoreFenceVerified: false;
  physicalAck: false;
}

export class S3TenantTelemetryDispositionJournalV3ObserverTemporaryError extends Error {
  constructor() {
    super("S3 telemetry disposition v3 operation did not converge");
    this.name = "S3TenantTelemetryDispositionJournalV3ObserverTemporaryError";
  }
}

interface StoredObject { payload: string; etag: string }
interface StoredHead { head: TenantTelemetryDispositionHeadV3; etag: string }

/** Independent GET-only observer. A valid chain never confers DB-grant or deletion authority. */
export class S3TenantTelemetryDispositionJournalV3Observer {
  readonly identity: TenantTelemetryDispositionJournalIdentityV3;
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly bucket: string;
  private readonly targetPrefix: string;
  private readonly headKey: string;
  private readonly timeoutMs: number;
  private readonly maxEvents: number;
  private closed = false;

  constructor(options: S3TenantTelemetryDispositionJournalV3ObserverOptions) {
    if (options.independentFailureDomain !== true
      || options.privateBucketAccessVerified !== true) {
      throw new Error("telemetry disposition v3 observer requires verified private target assertions");
    }
    validBucket(options.bucket);
    validId(options.namespaceId);
    validId(options.failureDomainId);
    validDigest(options.logicalDatabaseNamespaceSha256);
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    validPrefix(prefix);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.region)
      || typeof options.forcePathStyle !== "boolean") {
      throw new Error("telemetry disposition v3 target is invalid");
    }
    const endpoint = normalizedEndpoint(options.endpoint);
    this.identity = {
      adapterProtocol: S3_TENANT_TELEMETRY_DISPOSITION_JOURNAL_ADAPTER_V3,
      journalNamespaceSha256: digest(["telemetry-disposition-v3-namespace", options.namespaceId]),
      failureDomainSha256: digest(["telemetry-disposition-v3-failure-domain", options.failureDomainId]),
      logicalDatabaseNamespaceSha256: options.logicalDatabaseNamespaceSha256,
      journalTargetSha256: "",
    };
    this.identity.journalTargetSha256 = digest([
      "telemetry-disposition-v3-target", this.identity.adapterProtocol,
      this.identity.journalNamespaceSha256, this.identity.failureDomainSha256,
      this.identity.logicalDatabaseNamespaceSha256, options.bucket, prefix, options.region,
      endpoint === null ? "standard-endpoint" : "custom-endpoint", endpoint ?? "",
      options.forcePathStyle ? "path-style" : "virtual-hosted-style",
    ]);
    this.bucket = options.bucket;
    this.targetPrefix = `${prefix}/targets-v3/${this.identity.journalTargetSha256}`;
    this.headKey = `${this.targetPrefix}/authority/head-v3`;
    this.timeoutMs = options.operationTimeoutMs ?? 10_000;
    this.maxEvents = options.maxEvents ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000
      || !Number.isSafeInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 100_000) {
      throw new Error("telemetry disposition v3 work bounds are invalid");
    }
    this.ownsClient = options.client === undefined;
    this.client = options.client ?? new S3Client({
      region: options.region,
      ...(endpoint === null ? {} : { endpoint }),
      forcePathStyle: options.forcePathStyle,
      ignoreConfiguredEndpointUrls: true,
      useFipsEndpoint: false, useDualstackEndpoint: false,
      useAccelerateEndpoint: false, useGlobalEndpoint: false,
      useArnRegion: false, disableMultiregionAccessPoints: true,
      followRegionRedirects: false, bucketEndpoint: false, maxAttempts: 2,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError();
  }

  private remaining(deadline: number): number {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError();
    return ms;
  }

  private async send(deadline: number,
    request: (signal: AbortSignal) => Promise<GetObjectCommandOutput>): Promise<GetObjectCommandOutput> {
    const remainingMs = this.remaining(deadline);
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError());
      }, remainingMs);
    });
    const operation = Promise.resolve().then(() => {
      this.remaining(deadline);
      return request(controller.signal);
    }).then((output) => {
      // A non-conforming client can resolve after abort. Do not leak its stream.
      if (timedOut) destroyBody(output.Body);
      return output;
    });
    void operation.catch(() => undefined);
    try { return await Promise.race([operation, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async boundedBody(output: GetObjectCommandOutput, deadline: number): Promise<Buffer> {
    const remainingMs = this.remaining(deadline);
    if (output.ContentLength !== undefined
      && (!Number.isSafeInteger(output.ContentLength) || output.ContentLength < 0
        || output.ContentLength > TENANT_TELEMETRY_DISPOSITION_V3_MAX_ENVELOPE_BYTES)) {
      destroyBody(output.Body);
      throw new TenantTelemetryDispositionCorruptError();
    }
    const body = output.Body;
    if (!(body instanceof Uint8Array)
      && (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
        !== "function")) {
      destroyBody(body); throw new TenantTelemetryDispositionCorruptError();
    }
    let total = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        destroyBody(body);
        reject(new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError());
      }, remainingMs);
    });
    const read = (async () => {
      const iterable = body instanceof Uint8Array
        ? (async function* () { yield body; })()
        : body as AsyncIterable<Uint8Array>;
      for await (const chunk of iterable) {
        this.remaining(deadline);
        if (!(chunk instanceof Uint8Array)) throw new TenantTelemetryDispositionCorruptError();
        total += chunk.byteLength;
        if (total > TENANT_TELEMETRY_DISPOSITION_V3_MAX_ENVELOPE_BYTES) {
          throw new TenantTelemetryDispositionCorruptError();
        }
        chunks.push(Buffer.from(chunk));
      }
    })();
    void read.catch(() => undefined);
    try {
      await Promise.race([read, timeout]);
      this.remaining(deadline);
      if (output.ContentLength !== undefined && total !== output.ContentLength) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      destroyBody(body);
      if (error instanceof TenantTelemetryDispositionCorruptError
        || error instanceof S3TenantTelemetryDispositionJournalV3ObserverTemporaryError) throw error;
      throw new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError();
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async readObject(key: string, kind: TenantTelemetryDispositionV3EnvelopeKind,
    contentType: string, deadline: number): Promise<StoredObject | null> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.send(deadline, (signal) => this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal },
      ));
    } catch (error) {
      if (missingKey(error)) return null;
      if (versionEvidence(error) || metadata(error)?.httpStatusCode === 404) {
        throw new TenantTelemetryDispositionCorruptError();
      }
      throw new S3TenantTelemetryDispositionJournalV3ObserverTemporaryError();
    }
    try {
      unversioned(output);
      if (output.ContentType !== contentType || typeof output.ETag !== "string"
        || output.ETag.length < 1 || output.ETag.length > 512) {
        throw new TenantTelemetryDispositionCorruptError();
      }
    } catch (error) { destroyBody(output.Body); throw error; }
    const bytes = await this.boundedBody(output, deadline);
    return { payload: decodeTenantTelemetryDispositionV3Envelope(kind, bytes),
      etag: output.ETag! };
  }

  private eventKey(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const value = String(sequence).padStart(SEQUENCE_WIDTH, "0");
    if (value.length !== SEQUENCE_WIDTH) throw new TenantTelemetryDispositionCorruptError();
    return `${this.targetPrefix}/events-v3/${value}`;
  }

  private async readHead(deadline: number): Promise<StoredHead | null> {
    const stored = await this.readObject(this.headKey, "head",
      TENANT_TELEMETRY_DISPOSITION_V3_HEAD_CONTENT_TYPE, deadline);
    if (stored === null) return null;
    const head = parseCanonical(stored.payload) as TenantTelemetryDispositionHeadV3;
    validateTenantTelemetryDispositionHeadV3(head);
    if (!same(head.identity, this.identity)) throw new TenantTelemetryDispositionCorruptError();
    return { head, etag: stored.etag };
  }

  private async readEvent(sequence: number, deadline: number): Promise<TenantTelemetryDispositionEventV3 | null> {
    const stored = await this.readObject(this.eventKey(sequence), "event",
      TENANT_TELEMETRY_DISPOSITION_V3_EVENT_CONTENT_TYPE, deadline);
    if (stored === null) return null;
    const event = parseCanonical(stored.payload) as TenantTelemetryDispositionEventV3;
    validateTenantTelemetryDispositionEventV3(event);
    if (event.journalSequence !== sequence || !same(event.identity, this.identity)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return event;
  }

  private async chainThrough(head: TenantTelemetryDispositionHeadV3,
    deadline: number): Promise<TenantTelemetryDispositionEventV3[]> {
    if (head.journalSequence > this.maxEvents
      || head.journalSequence >= Number.MAX_SAFE_INTEGER) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const events: TenantTelemetryDispositionEventV3[] = [];
    for (let sequence = 1; sequence <= head.journalSequence; sequence += 1) {
      const event = await this.readEvent(sequence, deadline);
      if (event === null) throw new TenantTelemetryDispositionCorruptError();
      events.push(event);
    }
    assertTenantTelemetryDispositionChainV3(this.identity, events, head);
    return events;
  }

  /** Missing genesis or a pending slot is never a silently empty authority chain. */
  async observeSealedChain(): Promise<TenantTelemetryDispositionJournalReadObservationV3> {
    this.assertOpen();
    const deadline = performance.now() + this.timeoutMs;
    const first = await this.readHead(deadline);
    if (!first) throw new TenantTelemetryDispositionCorruptError();
    const events = await this.chainThrough(first.head, deadline);
    if (await this.readEvent(first.head.journalSequence + 1, deadline)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    const second = await this.readHead(deadline);
    if (!second || first.etag !== second.etag || !same(first.head, second.head)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    if (await this.readEvent(first.head.journalSequence + 1, deadline)) {
      throw new TenantTelemetryDispositionCorruptError();
    }
    return { sealedHead: structuredClone(first.head), events: structuredClone(events),
      sealedChainObserved: true, grantReady: false, executionReady: false,
      externalAuthorityVerified: false, restoreFenceVerified: false, physicalAck: false };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) this.client.destroy();
  }
}
