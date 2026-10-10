import { createHash, randomUUID } from "node:crypto";
import type {
  Approval,
  Item,
  PersistedEvent,
  Principal,
  Session,
  Turn,
} from "@agent-service/protocol";
import type { BlobDescriptor } from "./types.js";

export const USER_DATA_EXPORT_FORMAT = "ndjson-v1" as const;
export const USER_DATA_EXPORT_SCHEMA_VERSION = 1 as const;
export const USER_DATA_EXPORT_CONTENT_TYPE =
  "application/vnd.agent-service.user-export+ndjson" as const;
export const USER_DATA_EXPORT_CAPABILITY = "artifact-ndjson-v1" as const;
export const USER_DATA_EXPORT_RECORD_KIND_ORDER = [
  "session",
  "turn",
  "item",
  "event",
  "approval",
  "operational_usage",
] as const;
export const EMPTY_USER_DATA_EXPORT_SNAPSHOT_ROOT_SHA256 = createHash("sha256")
  .update(JSON.stringify(["agent-service/user-data-export-snapshot-root/v1"]))
  .digest("hex");

const REQUEST_ID = /^export_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARTIFACT_ID = /^xart_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_TOKEN = /^[A-Za-z0-9._:~-]{1,128}$/;
const ACTOR_KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type UserDataExportRequestStatus =
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "expired"
  | "revoked";

export type UserDataExportArtifactState = "staging" | "ready" | "delete_pending" | "deleted";
export type UserDataExportPartState = "staging" | "uploaded" | "delete_pending" | "deleted";
export type UserDataExportErrorCode =
  | "temporary_failure"
  | "snapshot_invalid"
  | "artifact_invalid"
  | "subject_revoked";

export interface UserDataExportRequestRecord {
  requestId: string;
  tenantId: string;
  userId: string;
  subjectGeneration: number;
  requestedByKeyId: string;
  idempotencyKeySha256: string;
  requestHash: string;
  format: typeof USER_DATA_EXPORT_FORMAT;
  schemaVersion: typeof USER_DATA_EXPORT_SCHEMA_VERSION;
  policyVersion: string;
  policySha256: string;
  artifactTtlMs: number;
  status: UserDataExportRequestStatus;
  currentBuildGeneration: number;
  currentArtifactId?: string;
  snapshotAtMs?: number;
  readyAtMs?: number;
  expiresAtMs?: number;
  artifactSha256?: string;
  artifactSizeBytes?: number;
  recordCount?: number;
  lastErrorCode?: UserDataExportErrorCode;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RequestUserDataExportInput {
  requestId: string;
  tenantId: string;
  userId: string;
  requestedByKeyId: string;
  idempotencyKeySha256: string;
  requestHash: string;
}

export interface ClaimUserDataExportsOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface UserDataExportClaim {
  requestId: string;
  tenantId: string;
  userId: string;
  subjectGeneration: number;
  buildGeneration: number;
  claimAttempt: number;
  claimToken: string;
  leaseUntilMs: number;
  policyVersion: string;
  policySha256: string;
  artifactTtlMs: number;
}

export type UserDataExportAuthorization = Pick<
  UserDataExportClaim,
  | "requestId"
  | "tenantId"
  | "userId"
  | "subjectGeneration"
  | "buildGeneration"
  | "claimAttempt"
  | "claimToken"
>;

export interface StartUserDataExportArtifactInput {
  artifactId: string;
  storageBackend: string;
  storageFormat: string;
  stagingTtlMs: number;
}

export interface StageUserDataExportPartInput {
  artifactId: string;
  partNumber: number;
  storageBackend: string;
  storageFormat: string;
  storageKey: string;
  uploadToken: string;
}

export interface MarkUserDataExportPartUploadedInput {
  artifactId: string;
  partNumber: number;
  descriptor: BlobDescriptor;
}

export interface CompleteUserDataExportArtifactInput {
  artifactId: string;
  snapshotAtMs: number;
  partCount: number;
  recordCount: number;
  totalSizeBytes: number;
  contentSha256: string;
  manifestSha256: string;
}

export interface RetryUserDataExportInput {
  delayMs: number;
  errorCode: UserDataExportErrorCode;
  maxAttempts?: number;
}

export interface UserDataExportArtifactRecord {
  artifactId: string;
  requestId: string;
  tenantId: string;
  userId: string;
  subjectGeneration: number;
  buildGeneration: number;
  state: UserDataExportArtifactState;
  format: typeof USER_DATA_EXPORT_FORMAT;
  schemaVersion: typeof USER_DATA_EXPORT_SCHEMA_VERSION;
  contentType: typeof USER_DATA_EXPORT_CONTENT_TYPE;
  storageBackend: string;
  storageFormat: string;
  policyVersion: string;
  policySha256: string;
  snapshotRootSha256: string;
  artifactTtlMs: number;
  partCount?: number;
  recordCount?: number;
  totalSizeBytes?: number;
  contentSha256?: string;
  manifestSha256?: string;
  snapshotAtMs?: number;
  stagingExpiresAtMs: number;
  readyAtMs?: number;
  expiresAtMs?: number;
  deletePendingAtMs?: number;
  deletedAtMs?: number;
  deletionGeneration: number;
  createdAtMs: number;
}

export interface UserDataExportArtifactPart {
  artifactId: string;
  requestId: string;
  buildGeneration: number;
  partNumber: number;
  state: UserDataExportPartState;
  storageBackend: string;
  storageFormat: string;
  storageKey: string;
  uploadToken: string;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  uploadedAtMs?: number;
  deletePendingAtMs?: number;
  deletedAtMs?: number;
  deletionGeneration: number;
  createdAtMs: number;
}

export interface UserDataExportDownload {
  request: UserDataExportRequestRecord;
  artifact: UserDataExportArtifactRecord;
  parts: UserDataExportArtifactPart[];
}

export interface UserDataExportDownloadLease extends UserDataExportDownload {
  leaseToken: string;
  leaseUntilMs: number;
}

export interface UserDataExportDeleteOutboxRecord {
  outboxId: number;
  artifactId: string;
  requestId: string;
  partNumber: number;
  deletionGeneration: number;
  storageBackend: string;
  storageFormat: string;
  storageKey: string;
  uploadToken: string;
  availableAtMs: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  lastError?: string;
  completedAtMs?: number;
  deadLetteredAtMs?: number;
  createdAtMs: number;
}

export interface ClaimUserDataExportDeletesOptions {
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface RetryUserDataExportDeleteInput {
  delayMs: number;
  error: unknown;
  maxAttempts?: number;
}

export type ExportedSession = Omit<Session, "fenceToken" | "contextEpoch"> & {
  deletedAtMs?: number;
};
export type ExportedTurn = Omit<Turn, "idempotencyKey">;

export interface UserDataExportAttachmentSnapshot {
  blobId: string;
  sessionId: string;
  itemId?: string;
  purpose: "input_image" | "tool_output";
  contentType?: string;
  sha256: string;
  sizeBytes: number;
}

export type UserDataExportSnapshotEntry =
  | { type: "session"; value: ExportedSession }
  | { type: "turn"; value: ExportedTurn }
  | { type: "item"; value: Item }
  | { type: "event"; value: PersistedEvent }
  | { type: "approval"; value: Approval }
  | {
      type: "operational_usage";
      value: {
        usageId?: string;
        sessionId: string;
        turnId: string;
        step: number;
        provider: string;
        model: string;
        usage: import("@agent-service/protocol").Usage;
        createdAtMs: number;
      };
    }
  | { type: "attachment"; value: UserDataExportAttachmentSnapshot };

export interface UserDataExportSnapshotSummary {
  snapshotAtMs: number;
  counts: Record<UserDataExportSnapshotEntry["type"], number>;
  recordCount: number;
  snapshotRootSha256: string;
}

export interface UserDataExportSnapshotRecord {
  requestId: string;
  buildGeneration: number;
  ordinal: number;
  kind: Exclude<UserDataExportSnapshotEntry["type"], "attachment">;
  logicalKey: string;
  canonicalBytes: Buffer;
  sha256: string;
  sizeBytes: number;
}

export interface UserDataExportSnapshotBlob extends UserDataExportAttachmentSnapshot {
  requestId: string;
  buildGeneration: number;
  ordinal: number;
  /** Worker-only physical identity. None of these fields may be serialized into the export. */
  storageBackend: string;
  /** Present for snapshots pinned after the global shared-storage cutover. */
  storageNamespaceSha256?: string;
  storageFormat: string;
  storageKey: string;
  sourceUploadToken: string;
  sourceDeletionGeneration: number;
  pinToken: string;
  pinnedAtMs: number;
  releasedAtMs?: number;
}

export interface UserDataExportSnapshotRecordPage {
  data: UserDataExportSnapshotRecord[];
  nextOrdinal: number | null;
}

export interface UserDataExportSnapshotBlobPage {
  data: UserDataExportSnapshotBlob[];
  nextOrdinal: number | null;
}

/** Public request/status surface. It cannot claim a job or access a physical object locator. */
export interface UserDataExportRequestStore {
  requestUserDataExport(input: RequestUserDataExportInput): Promise<UserDataExportRequestRecord>;
  getUserDataExport(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<UserDataExportRequestRecord | null>;
  acquireUserDataExportDownload(
    tenantId: string,
    userId: string,
    requestId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<UserDataExportDownloadLease | null>;
  renewUserDataExportDownload(
    artifactId: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<boolean>;
  releaseUserDataExportDownload(artifactId: string, leaseToken: string): Promise<void>;
}

/** Least-privilege builder surface. It can publish export-owned artifacts, not mutate sessions. */
export interface UserDataExportJobStore {
  claimUserDataExports(options: ClaimUserDataExportsOptions): Promise<UserDataExportClaim[]>;
  renewUserDataExportClaim(
    authorization: UserDataExportAuthorization,
    leaseMs: number,
  ): Promise<boolean>;
  startUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: StartUserDataExportArtifactInput,
  ): Promise<UserDataExportArtifactRecord>;
  captureAndSealUserDataExportSnapshot(
    authorization: UserDataExportAuthorization,
  ): Promise<UserDataExportSnapshotSummary>;
  readUserDataExportSnapshotRecords(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotRecordPage>;
  readUserDataExportSnapshotBlobs(
    authorization: UserDataExportAuthorization,
    options: { afterOrdinal?: number; limit: number },
  ): Promise<UserDataExportSnapshotBlobPage>;
  getUserDataExportArtifactBuild(
    authorization: UserDataExportAuthorization,
  ): Promise<{
    artifact: UserDataExportArtifactRecord | null;
    parts: UserDataExportArtifactPart[];
  }>;
  stageUserDataExportPart(
    authorization: UserDataExportAuthorization,
    input: StageUserDataExportPartInput,
  ): Promise<UserDataExportArtifactPart>;
  markUserDataExportPartUploaded(
    authorization: UserDataExportAuthorization,
    input: MarkUserDataExportPartUploadedInput,
  ): Promise<UserDataExportArtifactPart>;
  completeUserDataExportArtifact(
    authorization: UserDataExportAuthorization,
    input: CompleteUserDataExportArtifactInput,
  ): Promise<UserDataExportRequestRecord>;
  retryUserDataExport(
    authorization: UserDataExportAuthorization,
    input: RetryUserDataExportInput,
  ): Promise<boolean>;
}

/** Dedicated artifact TTL/delete queue. It has no session or general Blob-manifest authority. */
export interface UserDataExportCleanupStore {
  scheduleUserDataExportDeletes(limit: number): Promise<number>;
  claimUserDataExportDeletes(
    options: ClaimUserDataExportDeletesOptions,
  ): Promise<UserDataExportDeleteOutboxRecord[]>;
  renewUserDataExportDeleteClaim(
    outboxId: number,
    claimToken: string,
    leaseMs: number,
  ): Promise<boolean>;
  completeUserDataExportDelete(
    outboxId: number,
    claimToken: string,
  ): Promise<boolean>;
  retryUserDataExportDelete(
    outboxId: number,
    claimToken: string,
    input: RetryUserDataExportDeleteInput,
  ): Promise<boolean>;
}

export class UserDataExportIdempotencyMismatchError extends Error {
  constructor() {
    super("idempotency key was already used for a different data export request");
    this.name = "UserDataExportIdempotencyMismatchError";
  }
}

export class UserDataExportPolicyUnavailableError extends Error {
  constructor(message = "an active retention policy with a positive export artifact TTL is required") {
    super(message);
    this.name = "UserDataExportPolicyUnavailableError";
  }
}

export class UserDataExportStateError extends Error {
  constructor(message = "data export state changed") {
    super(message);
    this.name = "UserDataExportStateError";
  }
}

export class UserDataExportIntegrityError extends Error {
  constructor(message = "data export integrity could not be proven") {
    super(message);
    this.name = "UserDataExportIntegrityError";
  }
}

export function newUserDataExportRequestId(): string {
  return `export_${randomUUID()}`;
}

export function newUserDataExportArtifactId(): string {
  return `xart_${randomUUID()}`;
}

export function userDataExportIdempotencyKeySha256(key: string): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 256) {
    throw new Error("invalid data export idempotency key");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function userDataExportRequestHash(tenantId: string, userId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "agent-service/user-data-export-request/v1",
      tenantId,
      userId,
      USER_DATA_EXPORT_FORMAT,
      USER_DATA_EXPORT_SCHEMA_VERSION,
    ]))
    .digest("hex");
}

/**
 * Produce one portable JSON representation for snapshot rows written by either store backend.
 * Unknown-valued domain fields are deliberately fail-closed: silently dropping an unsupported
 * value would make an export look complete when it is not.
 */
export function canonicalUserDataExportJson(value: unknown): string {
  const active = new Set<object>();
  const normalize = (candidate: unknown): unknown => {
    if (
      candidate === null
      || typeof candidate === "string"
      || typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new UserDataExportIntegrityError("export JSON contains a non-finite number");
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new UserDataExportIntegrityError("export JSON contains an unsupported value");
    }
    if (active.has(candidate)) throw new UserDataExportIntegrityError("export JSON contains a cycle");
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(normalize);
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new UserDataExportIntegrityError("export JSON contains a non-plain object");
      }
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        result[key] = normalize((candidate as Record<string, unknown>)[key]);
      }
      return result;
    } finally {
      active.delete(candidate);
    }
  };
  return JSON.stringify(normalize(value));
}

export function canonicalUserDataExportBytes(entry: UserDataExportSnapshotEntry): Buffer {
  return Buffer.from(canonicalUserDataExportJson(entry), "utf8");
}

export function canonicalUserDataExportLine(entry: UserDataExportSnapshotEntry): Buffer {
  return Buffer.concat([canonicalUserDataExportBytes(entry), Buffer.from("\n", "utf8")]);
}

export function userDataExportAttachmentLogicalKey(
  attachment: Pick<UserDataExportAttachmentSnapshot, "sessionId" | "itemId" | "purpose" | "blobId">,
): string {
  return canonicalUserDataExportJson([
    "attachment",
    attachment.sessionId,
    attachment.itemId ?? null,
    attachment.purpose,
    attachment.blobId,
  ]);
}

export function userDataExportAuthorization(
  claim: UserDataExportClaim,
): UserDataExportAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.userId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

export function sanitizeExportSession(session: Session, deletedAtMs?: number): ExportedSession {
  const {
    fenceToken: _fenceToken,
    contextEpoch: _contextEpoch,
    title,
    parentSessionId,
    lastCompactionSeq,
    archivedAtMs,
    ...required
  } = session;
  return {
    ...required,
    ...(title === undefined ? {} : { title }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(lastCompactionSeq === undefined ? {} : { lastCompactionSeq }),
    ...(archivedAtMs === undefined ? {} : { archivedAtMs }),
    ...(deletedAtMs === undefined ? {} : { deletedAtMs }),
  };
}

export function sanitizeExportTurn(turn: Turn): ExportedTurn {
  const { idempotencyKey: _idempotencyKey, ...safe } = turn;
  return safe;
}

export function sanitizeExportEvent(event: PersistedEvent): PersistedEvent {
  if (event.type === "turn/started" || event.type === "turn/completed") {
    return { ...event, turn: sanitizeExportTurn(event.turn) } as PersistedEvent;
  }
  return event;
}

function safeInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
}

export function validateUserDataExportRequestInput(input: RequestUserDataExportInput): void {
  if (!REQUEST_ID.test(input.requestId)) throw new Error("invalid data export request id");
  if (!input.tenantId || input.tenantId.length > 128) throw new Error("invalid data export tenant id");
  if (!/^[A-Za-z0-9._:@|-]{1,128}$/.test(input.userId)) throw new Error("invalid data export user id");
  if (!ACTOR_KEY_ID.test(input.requestedByKeyId)) throw new Error("invalid data export actor key id");
  if (!SHA256.test(input.idempotencyKeySha256)) throw new Error("invalid data export idempotency hash");
  if (!SHA256.test(input.requestHash)) throw new Error("invalid data export request hash");
  if (input.requestHash !== userDataExportRequestHash(input.tenantId, input.userId)) {
    throw new Error("data export request hash does not match its subject");
  }
}

export function validateUserDataExportRequestRecord(record: UserDataExportRequestRecord): void {
  validateUserDataExportRequestInput({
    requestId: record.requestId,
    tenantId: record.tenantId,
    userId: record.userId,
    requestedByKeyId: record.requestedByKeyId,
    idempotencyKeySha256: record.idempotencyKeySha256,
    requestHash: record.requestHash,
  });
  safeInteger(record.subjectGeneration, "data export subject generation");
  safeInteger(record.artifactTtlMs, "data export artifact TTL", 1);
  safeInteger(record.currentBuildGeneration, "data export build generation");
  safeInteger(record.createdAtMs, "data export creation timestamp");
  safeInteger(record.updatedAtMs, "data export update timestamp");
  if (record.format !== USER_DATA_EXPORT_FORMAT || record.schemaVersion !== 1) {
    throw new Error("unsupported stored data export format");
  }
  if (!(["queued", "building", "ready", "failed", "expired", "revoked"] as const).includes(record.status)) {
    throw new Error("invalid stored data export status");
  }
  if (!record.policyVersion || record.policyVersion.length > 64 || !SHA256.test(record.policySha256)) {
    throw new Error("invalid stored data export policy binding");
  }
  if (record.currentArtifactId !== undefined && !ARTIFACT_ID.test(record.currentArtifactId)) {
    throw new Error("invalid stored data export artifact id");
  }
  for (const [name, value] of [
    ["snapshotAtMs", record.snapshotAtMs],
    ["readyAtMs", record.readyAtMs],
    ["expiresAtMs", record.expiresAtMs],
    ["artifactSizeBytes", record.artifactSizeBytes],
    ["recordCount", record.recordCount],
  ] as const) {
    if (value !== undefined) safeInteger(value, `data export ${name}`);
  }
  if (record.artifactSha256 !== undefined && !SHA256.test(record.artifactSha256)) {
    throw new Error("invalid stored data export artifact hash");
  }
  if (record.status === "ready") {
    if (
      !record.currentArtifactId
      || record.snapshotAtMs === undefined
      || record.readyAtMs === undefined
      || record.expiresAtMs === undefined
      || record.artifactSha256 === undefined
      || record.artifactSizeBytes === undefined
      || record.recordCount === undefined
      || record.expiresAtMs <= record.readyAtMs
    ) throw new Error("ready data export is incomplete");
  }
}

export function validateClaimUserDataExportsOptions(options: ClaimUserDataExportsOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("data export claim limit must be between 1 and 100");
  }
  safeInteger(options.leaseMs, "data export lease", 1);
  if (!CLAIM_TOKEN.test(options.claimToken)) throw new Error("invalid data export claim token");
}

export function validateUserDataExportAuthorization(
  authorization: UserDataExportAuthorization,
): void {
  if (!REQUEST_ID.test(authorization.requestId)) throw new Error("invalid data export request id");
  if (!authorization.tenantId || authorization.tenantId.length > 128) throw new Error("invalid data export tenant id");
  if (!/^[A-Za-z0-9._:@|-]{1,128}$/.test(authorization.userId)) throw new Error("invalid data export user id");
  safeInteger(authorization.subjectGeneration, "data export subject generation");
  safeInteger(authorization.buildGeneration, "data export build generation", 1);
  safeInteger(authorization.claimAttempt, "data export claim attempt", 1);
  if (!CLAIM_TOKEN.test(authorization.claimToken)) throw new Error("invalid data export claim token");
}

export function validateStartUserDataExportArtifactInput(
  input: StartUserDataExportArtifactInput,
): void {
  if (!ARTIFACT_ID.test(input.artifactId)) throw new Error("invalid data export artifact id");
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(input.storageBackend)) throw new Error("invalid export storage backend");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.storageFormat)) throw new Error("invalid export storage format");
  safeInteger(input.stagingTtlMs, "data export staging TTL", 1);
}

export function userDataExportManifestSha256(
  parts: readonly Pick<UserDataExportArtifactPart, "partNumber" | "sha256" | "sizeBytes">[],
): string {
  const canonical = [...parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map((part, index) => {
      if (part.partNumber !== index || part.sha256 === undefined || part.sizeBytes === undefined) {
        throw new UserDataExportIntegrityError("data export artifact parts are incomplete or non-contiguous");
      }
      if (!SHA256.test(part.sha256)) throw new UserDataExportIntegrityError("invalid data export part hash");
      safeInteger(part.sizeBytes, "data export part size");
      return [part.partNumber, part.sha256, part.sizeBytes];
    });
  return createHash("sha256")
    .update(JSON.stringify(["agent-service/user-data-export-manifest/v1", canonical]))
    .digest("hex");
}

export function nextUserDataExportSnapshotRootSha256(
  previousRootSha256: string,
  kind: UserDataExportSnapshotEntry["type"],
  logicalKey: string,
  sha256: string,
  sizeBytes: number,
): string {
  if (!SHA256.test(previousRootSha256) || !SHA256.test(sha256)) {
    throw new UserDataExportIntegrityError("invalid data export snapshot root input");
  }
  if (!logicalKey || logicalKey.length > 512) {
    throw new UserDataExportIntegrityError("invalid data export snapshot logical key");
  }
  safeInteger(sizeBytes, "data export snapshot record size");
  return createHash("sha256")
    .update(JSON.stringify([
      "agent-service/user-data-export-snapshot-root-step/v1",
      previousRootSha256,
      kind,
      logicalKey,
      sha256,
      sizeBytes,
    ]))
    .digest("hex");
}

export function userDataExportStorageKey(
  owner: Principal,
  requestId: string,
  artifactId: string,
  partNumber: number,
): string {
  if (!REQUEST_ID.test(requestId) || !ARTIFACT_ID.test(artifactId)) {
    throw new Error("invalid data export storage identity");
  }
  safeInteger(partNumber, "data export part number");
  const ownerHash = createHash("sha256")
    .update(JSON.stringify(["agent-service/user-data-export-owner/v1", owner.tenantId, owner.userId]))
    .digest("hex");
  return `data_exports/${ownerHash}/${requestId}/${artifactId}/part_${String(partNumber).padStart(10, "0")}`;
}

export function sanitizeUserDataExportError(error: unknown): string {
  let raw = "export failure";
  try {
    raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    // Keep the bounded generic value.
  }
  return raw
    .replace(/(?:file|https?|s3|oss):\/\/\S+/gi, "[redacted-locator]")
    .replace(/(["'])(?:\/[^"'\r\n]*|[A-Za-z]:[\\/][^"'\r\n]*)\1/g, "$1[redacted-path]$1")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .slice(0, 1_000);
}
