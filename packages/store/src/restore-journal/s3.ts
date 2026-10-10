import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
  validateScanTenantRestoreJournalRecordsOptions,
  validateScanTenantRestoreJournalRecordsResult,
  type ScanTenantRestoreJournalRecordsOptions,
  type ScanTenantRestoreJournalRecordsResult,
  type TenantRestoreJournalAdapter,
  type TenantRestoreJournalAdapterResult,
  type TenantRestoreJournalRecord,
  type TenantRestoreJournalRemoteEntry,
  type TenantRestoreJournalRemoteHead,
} from "../tenant-restore-journal.js";
import {
  RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES,
  RESTORE_JOURNAL_HEAD_CONTENT_TYPE,
  RESTORE_JOURNAL_MAX_PAYLOAD_BYTES,
  RESTORE_JOURNAL_RECORD_CONTENT_TYPE,
  decodeRestoreJournalEnvelope,
  encodeRestoreJournalEnvelope,
  type RestoreJournalEnvelopeKind,
} from "./codec.js";
import {
  TenantRestoreJournalConflictError,
  TenantRestoreJournalCorruptError,
  adapterResult,
  assertRecordForAdapter,
  emptyRemoteHead,
  headFromEntries,
  remoteEntry,
  sameRestoreJournalRecord,
  sha256,
  validateRestoreJournalAdapterIdentity,
  type RestoreJournalAdapterIdentity,
} from "./common.js";
import {
  buildRestoreJournalStoredHead,
  canonicalRestoreJournalStoredHead,
  canonicalTenantRestoreJournalRecord,
  parseCanonicalRestoreJournalStoredHead,
  parseCanonicalTenantRestoreJournalRecord,
  type RestoreJournalStoredHead,
} from "./serialization.js";

export const S3_TENANT_RESTORE_JOURNAL_PROTOCOL =
  "s3-immutable-tenant-restore-journal-v1" as const;

const DEFAULT_PREFIX = "tenant-restore-journal";
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_ATTEMPTS = 64;
const MAX_MUTATION_ATTEMPTS = 1_000;
const DEFAULT_SDK_ATTEMPTS = 2;
const SEQUENCE_WIDTH = 16;
const HEAD_SEQUENCE = /^\d{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = RESTORE_JOURNAL_ENVELOPE_HEADER_BYTES
  + RESTORE_JOURNAL_MAX_PAYLOAD_BYTES;
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

export interface S3TenantRestoreJournalAdapterOptions {
  /** Must be a bucket reserved for the restore journal, not the primary Blob/data bucket. */
  independentFailureDomain: true;
  bucket: string;
  /** Operator-assigned non-secret identity of the independent journal deployment. */
  namespaceId: string;
  /** Operator-assigned non-secret identity of the provider/account/region failure domain. */
  failureDomainId: string;
  prefix?: string;
  logicalDatabaseNamespaceSha256: string;
  /** A concrete region is part of the durable target identity; provider functions are forbidden. */
  region: string;
  /** `null` explicitly selects the SDK standard endpoint for `region`. */
  endpoint: string | null;
  forcePathStyle: boolean;
  credentials?: S3ClientConfig["credentials"];
  /** Tests may inject a client, but must still declare the exact region/endpoint identity above. */
  client?: S3Client;
  requestTimeoutMs?: number;
  maxMutationAttempts?: number;
}

type StoredRecordState =
  | { kind: "missing" }
  | { kind: "exact"; record: TenantRestoreJournalRecord }
  | { kind: "conflict" };

type StoredHeadState =
  | { kind: "missing" }
  | { kind: "exact"; head: RestoreJournalStoredHead }
  | { kind: "occupied"; head: RestoreJournalStoredHead };

class S3RestoreJournalSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3TenantRestoreJournalError";
  }
}

class S3RestoreJournalVersionedObjectError extends Error {
  constructor() {
    super("S3 tenant restore journal operation returned versioned-object evidence");
    this.name = "S3TenantRestoreJournalVersionedObjectError";
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

function sanitizedS3Error(operation: string, error: unknown): S3RestoreJournalSafeError {
  const status = errorStatus(error);
  const name = errorName(error);
  const safeName = name && SAFE_S3_ERROR_NAMES.has(name) ? name : undefined;
  const detail = [safeName, status === undefined ? undefined : String(status)]
    .filter((part): part is string => part !== undefined)
    .join("/");
  return new S3RestoreJournalSafeError(
    `S3 tenant restore journal ${operation} failed${detail ? ` (${detail})` : ""}`,
  );
}

function isMissingObject(error: unknown): boolean {
  const name = errorName(error);
  // A bare 404 is ambiguous and may be a missing bucket or bad endpoint route.
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
    throw new S3RestoreJournalVersionedObjectError();
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
  ) throw new Error("S3 restore journal bucket is invalid");
}

function validatePrefix(prefix: string): void {
  if (
    prefix.length < 1
    || prefix.length > 512
    || prefix.startsWith("/")
    || prefix.endsWith("/")
    || prefix.split("/").some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))
  ) throw new Error("S3 restore journal prefix is invalid");
}

function validateNonSecretId(value: string, name: "namespace" | "failure domain"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value)) {
    throw new Error(`S3 restore journal ${name} id is invalid`);
  }
}

function validateRegion(region: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(region)) {
    throw new Error("S3 restore journal region is invalid");
  }
  return region;
}

function normalizeEndpoint(endpoint: string | null): string | null {
  if (endpoint === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("S3 restore journal endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("S3 restore journal endpoint must be a credential-free http(s) origin");
  return parsed.origin;
}

export function s3TenantRestoreJournalNamespaceSha256(
  namespaceId: string,
): string {
  validateNonSecretId(namespaceId, "namespace");
  return sha256(["s3-tenant-restore-journal-namespace-v1", namespaceId]);
}

export function s3TenantRestoreJournalFailureDomainSha256(
  failureDomainId: string,
): string {
  validateNonSecretId(failureDomainId, "failure domain");
  return sha256(["s3-tenant-restore-journal-failure-domain-v1", failureDomainId]);
}

export function s3TenantRestoreJournalTargetSha256(input: {
  journalNamespaceSha256: string;
  failureDomainSha256: string;
  logicalDatabaseNamespaceSha256: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint: string | null;
}): string {
  validateBucket(input.bucket);
  validatePrefix(input.prefix);
  const region = validateRegion(input.region);
  const endpoint = normalizeEndpoint(input.endpoint);
  validateRestoreJournalAdapterIdentity({
    adapterProtocol: S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
    journalNamespaceSha256: input.journalNamespaceSha256,
    failureDomainSha256: input.failureDomainSha256,
    logicalDatabaseNamespaceSha256: input.logicalDatabaseNamespaceSha256,
    // The input digests are validated before the derived target digest exists.
    targetSha256: "0".repeat(64),
  });
  return sha256([
    "s3-tenant-restore-journal-target-v1",
    S3_TENANT_RESTORE_JOURNAL_PROTOCOL,
    input.journalNamespaceSha256,
    input.failureDomainSha256,
    input.logicalDatabaseNamespaceSha256,
    input.bucket,
    input.prefix,
    region,
    endpoint === null ? "standard-endpoint" : "custom-endpoint",
    endpoint ?? "",
  ]);
}

function sequenceKey(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("tenant restore journal sequence is invalid");
  }
  const value = String(sequence).padStart(SEQUENCE_WIDTH, "0");
  if (value.length !== SEQUENCE_WIDTH) throw new Error("tenant restore journal sequence is exhausted");
  return value;
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
  if (body instanceof Uint8Array) {
    return (async function* () { yield body; })();
  }
  if (
    !body
    || (typeof body !== "object" && typeof body !== "function")
    || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) throw new TenantRestoreJournalCorruptError("record");
  return body as AsyncIterable<Uint8Array>;
}

async function readBoundedBody(
  body: unknown,
  contentLength: number | undefined,
  timeoutMs: number,
): Promise<Buffer> {
  if (contentLength !== undefined
    && (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_ENVELOPE_BYTES)) {
    destroyBody(body);
    throw new TenantRestoreJournalCorruptError("record");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      destroyBody(body);
      reject(new S3RestoreJournalSafeError("S3 tenant restore journal response stream timed out"));
    }, timeoutMs);
    timer.unref();
  });
  const read = (async () => {
    for await (const value of bodyAsAsyncIterable(body)) {
      if (!(value instanceof Uint8Array)) throw new TenantRestoreJournalCorruptError("record");
      total += value.byteLength;
      if (total > MAX_ENVELOPE_BYTES) throw new TenantRestoreJournalCorruptError("record");
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  })();
  void read.catch(() => undefined);
  try {
    await Promise.race([read, timeout]);
  } catch (error) {
    destroyBody(body);
    if (error instanceof TenantRestoreJournalCorruptError
      || error instanceof S3RestoreJournalSafeError) throw error;
    throw sanitizedS3Error("response stream", error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (contentLength !== undefined && total !== contentLength) {
    throw new TenantRestoreJournalCorruptError("record");
  }
  return Buffer.concat(chunks, total);
}

/** Immutable S3 journal. It exposes no delete method and never writes Blob/tombstone envelopes. */
export class S3TenantRestoreJournalAdapter implements TenantRestoreJournalAdapter {
  readonly adapterProtocol = S3_TENANT_RESTORE_JOURNAL_PROTOCOL;
  readonly journalNamespaceSha256: string;
  readonly targetSha256: string;
  readonly failureDomainSha256: string;
  readonly logicalDatabaseNamespaceSha256: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly targetPrefix: string;
  private readonly requestTimeoutMs: number;
  private readonly maxMutationAttempts: number;
  private closed = false;

  constructor(options: S3TenantRestoreJournalAdapterOptions) {
    if (options.independentFailureDomain !== true) {
      throw new Error("S3 restore journal requires an independent failure-domain acknowledgement");
    }
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    const region = validateRegion(options.region);
    const endpoint = normalizeEndpoint(options.endpoint);
    this.journalNamespaceSha256 = s3TenantRestoreJournalNamespaceSha256(
      options.namespaceId,
    );
    this.failureDomainSha256 = s3TenantRestoreJournalFailureDomainSha256(
      options.failureDomainId,
    );
    this.logicalDatabaseNamespaceSha256 = options.logicalDatabaseNamespaceSha256;
    this.targetSha256 = s3TenantRestoreJournalTargetSha256({
      journalNamespaceSha256: this.journalNamespaceSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
      bucket: this.bucket,
      prefix: this.prefix,
      region,
      endpoint,
    });
    validateRestoreJournalAdapterIdentity(this.identity);
    this.targetPrefix = `${this.prefix}/targets/${this.targetSha256}`;

    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(requestTimeoutMs)
      || requestTimeoutMs < MIN_REQUEST_TIMEOUT_MS
      || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
      throw new Error(
        `S3 restore journal request timeout must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.requestTimeoutMs = requestTimeoutMs;
    const maxMutationAttempts = options.maxMutationAttempts ?? DEFAULT_MUTATION_ATTEMPTS;
    if (!Number.isSafeInteger(maxMutationAttempts)
      || maxMutationAttempts < 1
      || maxMutationAttempts > MAX_MUTATION_ATTEMPTS) {
      throw new Error(
        `S3 restore journal mutation attempts must be between 1 and ${MAX_MUTATION_ATTEMPTS}`,
      );
    }
    this.maxMutationAttempts = maxMutationAttempts;
    this.client = options.client ?? new S3Client({
      region,
      ...(endpoint === null ? {} : { endpoint }),
      forcePathStyle: options.forcePathStyle,
      // Endpoint selection is part of the durable target identity above. Do not allow environment
      // variables or shared AWS profiles to silently redirect this client to a different target.
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

  private get identity(): RestoreJournalAdapterIdentity {
    return {
      adapterProtocol: this.adapterProtocol,
      journalNamespaceSha256: this.journalNamespaceSha256,
      targetSha256: this.targetSha256,
      failureDomainSha256: this.failureDomainSha256,
      logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("S3 restore journal adapter is closed");
  }

  private recordKey(operationSha256: string): string {
    if (!SHA256.test(operationSha256)) throw new Error("restore journal operation is invalid");
    return `${this.targetPrefix}/records/${operationSha256}`;
  }

  private headKey(remoteSequence: number): string {
    return `${this.targetPrefix}/heads/${sequenceKey(remoteSequence)}`;
  }

  private async send<Output>(request: (abortSignal: AbortSignal) => Promise<Output>): Promise<Output> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error("S3 restore journal request timed out"), {
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

  private async readPayload(
    key: string,
    kind: RestoreJournalEnvelopeKind,
  ): Promise<string | null> {
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
    const body = await readBoundedBody(
      output.Body,
      output.ContentLength,
      this.requestTimeoutMs,
    );
    try {
      return decodeRestoreJournalEnvelope(kind, body);
    } catch (error) {
      if (error instanceof TenantRestoreJournalCorruptError) throw error;
      throw new TenantRestoreJournalCorruptError(kind === "record" ? "record" : "head");
    }
  }

  private async readStoredRecord(operationSha256: string): Promise<TenantRestoreJournalRecord | null> {
    const payload = await this.readPayload(this.recordKey(operationSha256), "record");
    if (payload === null) return null;
    try {
      const record = parseCanonicalTenantRestoreJournalRecord(payload);
      if (record.operationSha256 !== operationSha256) {
        throw new TenantRestoreJournalCorruptError("record");
      }
      return record;
    } catch (error) {
      if (error instanceof TenantRestoreJournalCorruptError) throw error;
      throw new TenantRestoreJournalCorruptError("record");
    }
  }

  private async readStoredHead(remoteSequence: number): Promise<RestoreJournalStoredHead | null> {
    const payload = await this.readPayload(this.headKey(remoteSequence), "head");
    if (payload === null) return null;
    try {
      return parseCanonicalRestoreJournalStoredHead(payload);
    } catch {
      throw new TenantRestoreJournalCorruptError("head");
    }
  }

  private async inspectStoredRecord(record: TenantRestoreJournalRecord): Promise<StoredRecordState> {
    let stored: TenantRestoreJournalRecord | null;
    try {
      stored = await this.readStoredRecord(record.operationSha256);
    } catch (error) {
      if (error instanceof TenantRestoreJournalCorruptError) return { kind: "conflict" };
      throw error;
    }
    if (!stored) return { kind: "missing" };
    return sameRestoreJournalRecord(stored, record)
      ? { kind: "exact", record: stored }
      : { kind: "conflict" };
  }

  private async inspectStoredHead(expected: RestoreJournalStoredHead): Promise<StoredHeadState> {
    const stored = await this.readStoredHead(expected.remoteSequence);
    if (!stored) return { kind: "missing" };
    return canonicalRestoreJournalStoredHead(stored) === canonicalRestoreJournalStoredHead(expected)
      ? { kind: "exact", head: stored }
      : { kind: "occupied", head: stored };
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

  private async ensureRecord(record: TenantRestoreJournalRecord): Promise<void> {
    const key = this.recordKey(record.operationSha256);
    const body = encodeRestoreJournalEnvelope(
      "record",
      canonicalTenantRestoreJournalRecord(record),
    );
    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      let putSucceeded = false;
      let putError: unknown;
      try {
        await this.putCreateOnly(key, body, RESTORE_JOURNAL_RECORD_CONTENT_TYPE);
        putSucceeded = true;
      } catch (error) {
        if (error instanceof S3RestoreJournalVersionedObjectError) throw error;
        putError = error;
      }
      const state = await this.inspectStoredRecord(record);
      if (state.kind === "exact") return;
      if (state.kind === "conflict") throw new TenantRestoreJournalConflictError();
      if (putSucceeded || (putError && isConditionalConflict(putError))) continue;
      if (putError) throw sanitizedS3Error("conditional record create", putError);
    }
    throw new S3RestoreJournalSafeError("S3 tenant restore journal record create did not converge");
  }

  private async listHeadSequences(): Promise<number[]> {
    const prefix = `${this.targetPrefix}/heads/`;
    const sequences: number[] = [];
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    do {
      let page;
      try {
        page = await this.send((abortSignal) => this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: 1_000,
          }),
          { abortSignal },
        ));
      } catch (error) {
        throw sanitizedS3Error("head listing", error);
      }
      for (const object of page.Contents ?? []) {
        if (!object.Key?.startsWith(prefix)) throw new TenantRestoreJournalCorruptError("listing");
        const suffix = object.Key.slice(prefix.length);
        if (!HEAD_SEQUENCE.test(suffix)) throw new TenantRestoreJournalCorruptError("listing");
        const sequence = Number(suffix);
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw new TenantRestoreJournalCorruptError("listing");
        }
        sequences.push(sequence);
      }
      if (page.IsTruncated) {
        if (!page.NextContinuationToken || seenTokens.has(page.NextContinuationToken)) {
          throw new TenantRestoreJournalCorruptError("listing");
        }
        continuationToken = page.NextContinuationToken;
        seenTokens.add(continuationToken);
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    sequences.sort((left, right) => left - right);
    for (const [index, sequence] of sequences.entries()) {
      if (sequence !== index + 1) throw new TenantRestoreJournalCorruptError("chain");
    }
    return sequences;
  }

  private async readEntriesForSequences(
    sequences: Iterable<number>,
  ): Promise<TenantRestoreJournalRemoteEntry[]> {
    const entries: TenantRestoreJournalRemoteEntry[] = [];
    const operations = new Set<string>();
    let previousRoot = EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    for (const sequence of sequences) {
      const head = await this.readStoredHead(sequence);
      if (!head) throw new TenantRestoreJournalCorruptError("chain");
      if (
        head.adapterProtocol !== this.adapterProtocol
        || head.journalNamespaceSha256 !== this.journalNamespaceSha256
        || head.targetSha256 !== this.targetSha256
        || head.logicalDatabaseNamespaceSha256 !== this.logicalDatabaseNamespaceSha256
        || head.remoteSequence !== sequence
        || head.previousHeadRootSha256 !== previousRoot
        || operations.has(head.operationSha256)
      ) throw new TenantRestoreJournalCorruptError("chain");
      operations.add(head.operationSha256);
      const record = await this.readStoredRecord(head.operationSha256);
      if (!record) throw new TenantRestoreJournalCorruptError("record");
      const entry = remoteEntry(this.identity, head, record);
      entries.push(entry);
      previousRoot = entry.headRootSha256;
    }
    return entries;
  }

  private async readChain(): Promise<TenantRestoreJournalRemoteEntry[]> {
    return this.readEntriesForSequences(await this.listHeadSequences());
  }

  private async readChainThrough(remoteSequence: number): Promise<TenantRestoreJournalRemoteEntry[]> {
    if (!Number.isSafeInteger(remoteSequence) || remoteSequence < 0) {
      throw new TenantRestoreJournalCorruptError("chain");
    }
    const sequences = function* (): Generator<number> {
      for (let sequence = 1; sequence <= remoteSequence; sequence += 1) yield sequence;
    };
    return this.readEntriesForSequences(sequences());
  }

  private findRecord(
    entries: readonly TenantRestoreJournalRemoteEntry[],
    record: TenantRestoreJournalRecord,
  ): TenantRestoreJournalRemoteEntry | undefined {
    const entry = entries.find((candidate) => (
      candidate.record.operationSha256 === record.operationSha256
    ));
    if (entry && !sameRestoreJournalRecord(entry.record, record)) {
      throw new TenantRestoreJournalConflictError();
    }
    return entry;
  }

  async publishRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult> {
    this.assertOpen();
    assertRecordForAdapter(this.identity, record);
    await this.ensureRecord(record);

    for (let attempt = 0; attempt < this.maxMutationAttempts; attempt += 1) {
      const entries = await this.readChain();
      const existing = this.findRecord(entries, record);
      if (existing) return adapterResult(this.identity, existing, true);
      const previous = entries.at(-1);
      const head = buildRestoreJournalStoredHead({
        adapterProtocol: this.adapterProtocol,
        journalNamespaceSha256: this.journalNamespaceSha256,
        targetSha256: this.targetSha256,
        logicalDatabaseNamespaceSha256: this.logicalDatabaseNamespaceSha256,
        remoteSequence: entries.length + 1,
        previousHeadRootSha256: previous?.headRootSha256
          ?? EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256,
        operationSha256: record.operationSha256,
        recordSha256: record.recordSha256,
      });
      const body = encodeRestoreJournalEnvelope(
        "head",
        canonicalRestoreJournalStoredHead(head),
      );
      let putError: unknown;
      try {
        await this.putCreateOnly(
          this.headKey(head.remoteSequence),
          body,
          RESTORE_JOURNAL_HEAD_CONTENT_TYPE,
        );
      } catch (error) {
        if (error instanceof S3RestoreJournalVersionedObjectError) throw error;
        putError = error;
      }
      const state = await this.inspectStoredHead(head);
      if (state.kind === "exact") {
        const recordState = await this.inspectStoredRecord(record);
        if (recordState.kind !== "exact") {
          if (recordState.kind === "conflict") throw new TenantRestoreJournalConflictError();
          throw new TenantRestoreJournalCorruptError("record");
        }
        const entry = remoteEntry(this.identity, state.head, record);
        return adapterResult(this.identity, entry, putError !== undefined);
      }
      if (state.kind === "occupied" || (putError && isConditionalConflict(putError))) continue;
      if (putError) throw sanitizedS3Error("conditional head create", putError);
      // A false success acknowledgement left no object. Retry the same immutable proposal.
    }
    throw new S3RestoreJournalSafeError("S3 tenant restore journal head create did not converge");
  }

  async inspectRecord(record: TenantRestoreJournalRecord): Promise<TenantRestoreJournalAdapterResult | null> {
    this.assertOpen();
    assertRecordForAdapter(this.identity, record);
    const state = await this.inspectStoredRecord(record);
    if (state.kind === "conflict") throw new TenantRestoreJournalConflictError();
    const entries = await this.readChain();
    const existing = this.findRecord(entries, record);
    if (existing) {
      if (state.kind !== "exact") throw new TenantRestoreJournalCorruptError("record");
      return adapterResult(this.identity, existing, true);
    }
    // A create committed before process/response loss but has no immutable head link yet. It is
    // intentionally not an ACK; publishRecord can safely resume it.
    return null;
  }

  async readHead(): Promise<TenantRestoreJournalRemoteHead> {
    this.assertOpen();
    const entries = await this.readChain();
    return entries.length === 0 ? emptyRemoteHead(this.identity) : headFromEntries(this.identity, entries);
  }

  async scanRecords(
    options: ScanTenantRestoreJournalRecordsOptions,
  ): Promise<ScanTenantRestoreJournalRecordsResult> {
    this.assertOpen();
    validateScanTenantRestoreJournalRecordsOptions(options);
    if (
      options.sealedHead.adapterProtocol !== this.adapterProtocol
      || options.sealedHead.journalNamespaceSha256 !== this.journalNamespaceSha256
      || options.sealedHead.targetSha256 !== this.targetSha256
      || options.sealedHead.logicalDatabaseNamespaceSha256
        !== this.logicalDatabaseNamespaceSha256
    ) throw new TenantRestoreJournalConflictError();
    // Read only the immutable sealed prefix. A later concurrent append or corruption beyond the
    // sealed upper bound cannot enter or invalidate this restore page.
    const entries = await this.readChainThrough(options.sealedHead.remoteSequence);
    const sealedEntry = options.sealedHead.remoteSequence === 0
      ? undefined
      : entries[options.sealedHead.remoteSequence - 1];
    if (sealedEntry && sealedEntry.headRootSha256 !== options.sealedHead.headRootSha256) {
      throw new TenantRestoreJournalCorruptError("chain");
    }
    const cursorEntry = options.afterRemoteSequence === 0
      ? undefined
      : entries[options.afterRemoteSequence - 1];
    const cursorRoot = cursorEntry?.headRootSha256
      ?? EMPTY_TENANT_RESTORE_JOURNAL_REMOTE_HEAD_ROOT_SHA256;
    if (cursorRoot !== options.afterHeadRootSha256) {
      throw new TenantRestoreJournalConflictError();
    }
    const pageEntries = entries.slice(
      options.afterRemoteSequence,
      Math.min(options.sealedHead.remoteSequence, options.afterRemoteSequence + options.limit),
    );
    const final = pageEntries.at(-1);
    const result: ScanTenantRestoreJournalRecordsResult = {
      entries: pageEntries,
      nextRemoteSequence: final?.remoteSequence ?? options.afterRemoteSequence,
      nextHeadRootSha256: final?.headRootSha256 ?? options.afterHeadRootSha256,
      complete: (final?.remoteSequence ?? options.afterRemoteSequence)
        === options.sealedHead.remoteSequence,
    };
    validateScanTenantRestoreJournalRecordsResult(options, result);
    return result;
  }

  /** Validate the append-only bucket without ever acquiring or exposing DeleteObject authority. */
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
      throw new S3RestoreJournalSafeError(
        "S3 tenant restore journal bucket versioning must be disabled",
      );
    }

    try {
      const lifecycle = await this.send((abortSignal) => this.client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if ((lifecycle.Rules?.length ?? 0) > 0) {
        throw new S3RestoreJournalSafeError(
          "S3 tenant restore journal bucket lifecycle configuration must be absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "NoSuchLifecycleConfiguration") {
        if (error instanceof S3RestoreJournalSafeError) throw error;
        throw sanitizedS3Error("startup lifecycle check", error);
      }
    }

    try {
      const lock = await this.send((abortSignal) => this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
        { abortSignal },
      ));
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== undefined) {
        throw new S3RestoreJournalSafeError(
          "S3 tenant restore journal bucket Object Lock must be disabled or absent",
        );
      }
    } catch (error) {
      if (errorName(error) !== "ObjectLockConfigurationNotFoundError"
        && errorName(error) !== "ObjectLockConfigurationNotFound"
        && errorStatus(error) !== 404) {
        if (error instanceof S3RestoreJournalSafeError) throw error;
        throw sanitizedS3Error("startup Object Lock check", error);
      }
    }

    const probeKey = `${this.prefix}/probes/conditional-create-v1`;
    const initial = encodeRestoreJournalEnvelope("record", JSON.stringify({
      scope: "tenant-restore-journal-probe-v1",
      journalNamespaceSha256: this.journalNamespaceSha256,
    }));
    const replacement = encodeRestoreJournalEnvelope("record", JSON.stringify({
      scope: "tenant-restore-journal-probe-conflict-v1",
      journalNamespaceSha256: this.journalNamespaceSha256,
    }));
    try {
      await this.putCreateOnly(probeKey, initial, RESTORE_JOURNAL_RECORD_CONTENT_TYPE);
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3RestoreJournalVersionedObjectError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    const readProbe = async (): Promise<Buffer | null> => {
      let output: GetObjectCommandOutput;
      try {
        output = await this.send((abortSignal) => this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: probeKey }),
          { abortSignal },
        ));
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw sanitizedS3Error("startup probe read", error);
      }
      try {
        assertUnversionedEvidence(output);
      } catch (error) {
        destroyBody(output.Body);
        throw error;
      }
      return readBoundedBody(output.Body, output.ContentLength, this.requestTimeoutMs);
    };
    if (!(await readProbe())?.equals(initial)) {
      throw new S3RestoreJournalSafeError("S3 tenant restore journal startup probe conflicts");
    }
    let ignored = false;
    try {
      await this.putCreateOnly(probeKey, replacement, RESTORE_JOURNAL_RECORD_CONTENT_TYPE);
      ignored = true;
    } catch (error) {
      if (!isConditionalConflict(error)) {
        if (error instanceof S3RestoreJournalVersionedObjectError) throw error;
        throw sanitizedS3Error("startup conditional-create probe", error);
      }
    }
    if (ignored || !(await readProbe())?.equals(initial)) {
      throw new S3RestoreJournalSafeError(
        "S3 tenant restore journal endpoint ignored If-None-Match",
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.client.destroy();
  }
}
