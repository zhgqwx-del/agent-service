import type { Item, Principal } from "@agent-service/protocol";

export const BLOB_STORAGE_FORMAT = "asblob2-envelope" as const;
export const TOOL_OUTPUT_CONTENT_TYPE = "application/vnd.agent-service.tool-output+json" as const;

export type BlobPurpose = "input_image" | "tool_output";
export type BlobState = "staging" | "ready" | "delete_pending" | "deleted";

export interface BlobManifest {
  blobId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  itemId?: string;
  purpose: BlobPurpose;
  storageBackend: string;
  storageFormat: string;
  storageKey: string;
  uploadToken: string;
  state: BlobState;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  uploadedAtMs?: number;
  readyAtMs?: number;
  stagingExpiresAtMs?: number;
  deleteAfterMs?: number;
  deletedAtMs?: number;
  deletionGeneration: number;
  createdAtMs: number;
}

export interface StageBlobInput {
  owner: Principal;
  sessionId: string;
  fence: number;
  blobId: string;
  purpose: BlobPurpose;
  storageBackend: string;
  storageFormat: string;
  storageKey: string;
  uploadToken: string;
  createdAtMs: number;
  stagingExpiresAtMs: number;
}

export interface MarkBlobUploadedInput {
  owner: Principal;
  sessionId: string;
  fence: number;
  blobId: string;
  uploadToken: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string;
  uploadedAtMs: number;
}

/** Internal commit declaration. The store also derives references from the items and compares sets. */
export interface BlobBinding {
  blobId: string;
  itemId: string;
  purpose: BlobPurpose;
}

export interface ReadyBlobLookup {
  owner: Principal;
  sessionId: string;
  blobId: string;
  itemId?: string;
  purpose?: BlobPurpose;
}

export interface BindableBlobLookup {
  owner: Principal;
  sessionId: string;
  blobId: string;
  purpose: BlobPurpose;
}

export interface ScheduleStaleBlobsOptions {
  nowMs: number;
  limit: number;
}

export interface ClaimBlobDeletesOptions {
  nowMs: number;
  limit: number;
  leaseMs: number;
  claimToken: string;
}

export interface BlobDeleteOutboxRecord {
  outboxId: number;
  blobId: string;
  generation: number;
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

export interface RenewBlobDeleteClaimOptions {
  nowMs: number;
  leaseMs: number;
}

export interface RetryBlobDeleteOptions {
  failedAtMs: number;
  availableAtMs: number;
  error: unknown;
  maxAttempts?: number;
}

/** Session-facing ownership manifest operations. None expose a physical locator to an API client. */
export interface BlobManifestStore {
  stageBlob(input: StageBlobInput): Promise<void>;
  markBlobUploaded(input: MarkBlobUploadedInput): Promise<void>;
  /** Owner-scoped preflight read for an uploaded staging object immediately before atomic binding. */
  getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null>;
  getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null>;
  /** Diagnostic/internal read used by conformance and operations, never an HTTP lookup. */
  getBlobManifest(blobId: string): Promise<BlobManifest | null>;
}

/** Least-privilege orphan sweeper and physical-delete acknowledgement surface. */
export interface BlobCleanupStore {
  scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number>;
  claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]>;
  renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: RenewBlobDeleteClaimOptions,
  ): Promise<boolean>;
  completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean>;
  retryBlobDelete(outboxId: number, claimToken: string, options: RetryBlobDeleteOptions): Promise<boolean>;
  getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null>;
}

/** A manifest changed state or identity before the requested transition could linearize. */
export class BlobStateError extends Error {
  constructor(public readonly blobId: string, message = "blob is not available for this transition") {
    super(message);
    this.name = "BlobStateError";
  }
}

/**
 * A staging lease is a hard ownership boundary: once its deadline is reached, only the orphan
 * sweeper may advance the manifest. Callers that bind a manifest must evaluate this predicate at
 * their linearization point (after taking the durable row lock for MySQL).
 */
export function isUnexpiredStagingBlob(manifest: BlobManifest, nowMs: number): boolean {
  return manifest.state === "staging"
    && manifest.stagingExpiresAtMs !== undefined
    && manifest.stagingExpiresAtMs > nowMs;
}

/** Extract the only blob references that may become ready in a normal session commit. */
export function blobBindingsFromItems(items: readonly Item[] | undefined): BlobBinding[] {
  const bindings: BlobBinding[] = [];
  for (const item of items ?? []) {
    if (item.type === "toolResult" && item.outputRef) {
      bindings.push({ blobId: item.outputRef, itemId: item.id, purpose: "tool_output" });
    }
    if (item.type === "userMessage") {
      for (const part of item.content) {
        if (part.type === "image" && "blobId" in part) {
          bindings.push({ blobId: part.blobId, itemId: item.id, purpose: "input_image" });
        }
      }
    }
  }
  return bindings.sort(compareBlobBindings);
}

export function compareBlobBindings(left: BlobBinding, right: BlobBinding): number {
  return left.blobId.localeCompare(right.blobId)
    || left.itemId.localeCompare(right.itemId)
    || left.purpose.localeCompare(right.purpose);
}

export function assertBlobBindingsMatch(items: readonly Item[] | undefined, declared: readonly BlobBinding[] | undefined): void {
  const derived = blobBindingsFromItems(items);
  const provided = [...(declared ?? [])].sort(compareBlobBindings);
  if (derived.length !== provided.length || derived.some((binding, index) => {
    const candidate = provided[index];
    return !candidate
      || candidate.blobId !== binding.blobId
      || candidate.itemId !== binding.itemId
      || candidate.purpose !== binding.purpose;
  })) {
    throw new Error("blob bindings must exactly match the references in committed items");
  }
  const ids = new Set<string>();
  for (const binding of provided) {
    if (ids.has(binding.blobId)) throw new Error("one blob cannot be bound more than once in a commit");
    ids.add(binding.blobId);
  }
}

export function validateBlobDeleteClaim(options: ClaimBlobDeletesOptions): number {
  if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) throw new Error("blob delete nowMs must be a non-negative safe integer");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("blob delete limit must be between 1 and 100");
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) throw new Error("blob delete leaseMs must be a positive safe integer");
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(options.claimToken)) throw new Error("invalid blob delete claim token");
  const until = options.nowMs + options.leaseMs;
  if (!Number.isSafeInteger(until)) throw new Error("blob delete lease expiry is outside the safe integer range");
  return until;
}

export function validateBlobDeleteAck(outboxId: number, claimToken: string, atMs: number): void {
  if (!Number.isSafeInteger(outboxId) || outboxId < 1) throw new Error("invalid blob delete outbox id");
  if (!/^[A-Za-z0-9._~-]{1,64}$/.test(claimToken)) throw new Error("invalid blob delete claim token");
  if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("blob delete timestamp must be a non-negative safe integer");
}

export function sanitizeBlobDeleteError(error: unknown): string {
  let raw: string;
  try {
    raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    raw = "blob cleanup failure";
  }
  // Physical paths, URLs and credentials must not become durable queue diagnostics.
  return raw
    .replace(/(?:file|https?|s3|oss):\/\/\S+/gi, "[redacted-locator]")
    // Node errno messages quote paths, including spaces. Keep the quote and error context while
    // replacing POSIX, drive-letter and UNC locators themselves.
    .replace(/(["'])(?:\/[^"'\r\n]*|[A-Za-z]:[\\/][^"'\r\n]*|\\\\[^"'\r\n\\]+\\[^"'\r\n]*)\1/g, "$1[redacted-path]$1")
    // Also cover common unquoted absolute paths without treating values such as `retry 2/3` as paths.
    .replace(/(^|[\s(,=])(?:\/[^\s,;)'"`]+|[A-Za-z]:[\\/][^\s,;)'"`]+|\\\\[^\s\\]+\\[^\s,;)'"`]+)/g, "$1[redacted-path]")
    .replace(/\b(authorization)\s*[:=]\s*(?:Bearer\s+)?\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .slice(0, 1_000);
}
