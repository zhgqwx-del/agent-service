import { randomUUID } from "node:crypto";
import { isCanonicalId } from "@agent-service/protocol";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  blobStorageKey,
  type BlobCleanupStore,
  type BlobDeleteOutboxRecord,
  type BlobStore,
} from "@agent-service/store";

export interface BlobCleanupWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Only deterministic poison identities are capped; availability failures retry forever. */
  poisonMaxAttempts?: number;
}

export interface BlobCleanupWorkerDeps {
  store: BlobCleanupStore;
  blob: BlobStore;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 50,
  retryBaseMs: 250,
  retryMaxMs: 60_000,
  poisonMaxAttempts: 3,
} as const;

const SAFE_KEY_SEGMENT = /^[a-z0-9_-]{1,128}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const UPLOAD_TOKEN = /^[a-z0-9-]{16,64}$/;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function validStorageKey(value: string): boolean {
  if (!value || value.length > 512) return false;
  return value.split("/").every((part) => SAFE_KEY_SEGMENT.test(part) && !WINDOWS_DEVICE_NAME.test(part));
}

function hasValidIdentity(row: BlobDeleteOutboxRecord, claimToken: string): boolean {
  return Number.isSafeInteger(row.outboxId)
    && row.outboxId > 0
    && isCanonicalId("blob", row.blobId)
    && Number.isSafeInteger(row.generation)
    && row.generation > 0
    && Number.isSafeInteger(row.attempts)
    && row.attempts > 0
    && row.claimToken === claimToken
    && validStorageKey(row.storageKey)
    && row.storageKey === blobStorageKey(row.blobId)
    && UPLOAD_TOKEN.test(row.uploadToken);
}

/**
 * Reclaims expired staging uploads through a durable, least-privilege delete outbox. Object
 * deletion is intentionally at-least-once: a crash or lost acknowledgement after `delete` causes
 * the same storage key to be deleted again, which every BlobStore adapter must treat as success.
 */
export class BlobCleanupWorker {
  private readonly opts: Required<BlobCleanupWorkerOptions>;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private stopping = true;

  constructor(private readonly deps: BlobCleanupWorkerDeps, options: BlobCleanupWorkerOptions = {}) {
    this.opts = {
      pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
      poisonMaxAttempts: positiveInteger(
        options.poisonMaxAttempts ?? DEFAULTS.poisonMaxAttempts,
        "poisonMaxAttempts",
      ),
    };
    if (this.opts.batchSize > 100) throw new Error("batchSize must not exceed the store claim limit of 100");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) throw new Error("retryMaxMs must be >= retryBaseMs");
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  /** One deterministic scheduling + deletion pass, exposed for tests and operational draining. */
  async cleanupOnce(nowMs = Date.now()): Promise<number> {
    await this.deps.store.scheduleStaleBlobDeletes({ nowMs, limit: this.opts.batchSize });

    // A new token per poll prevents a late acknowledgement from one pass from completing a claim
    // recovered by a later pass in this process (or by another runner).
    const claimToken = randomUUID();
    const rows = await this.deps.store.claimBlobDeletes({
      nowMs,
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken,
    });
    let completed = 0;
    for (const row of rows) {
      if (await this.deleteClaimed(row, claimToken)) completed += 1;
    }
    return completed;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.cleanupOnce();
      this.inFlight = run;
      void run
        .catch((error) => {
          // Never log backend errors: locator- or credential-bearing messages are not safe logs.
          const name = error instanceof Error ? error.name : "unknown error";
          this.log.warn(`[blob-cleanup] polling failed (${name})`);
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private async deleteClaimed(row: BlobDeleteOutboxRecord, claimToken: string): Promise<boolean> {
    if (!hasValidIdentity(row, claimToken) || row.storageFormat !== BLOB_STORAGE_FORMAT) {
      await this.retry(row, claimToken, new Error("invalid blob delete identity"), true);
      return false;
    }
    if (row.storageBackend !== this.deps.blob.backend) {
      // A rolling adapter/configuration transition is recoverable. Keep the durable intent pending
      // until a worker with the recorded backend is available; never dead-letter it as corruption.
      await this.retry(row, claimToken, new Error("blob delete storage adapter is unavailable"), false);
      return false;
    }

    const renewed = await this.deps.store.renewBlobDeleteClaim(row.outboxId, claimToken, {
      nowMs: Date.now(),
      leaseMs: this.opts.leaseMs,
    });
    if (!renewed) return false;

    try {
      // BlobStore.delete is idempotent: an already-missing final object or upload artifact succeeds.
      await this.deps.blob.delete(row.storageKey, { uploadToken: row.uploadToken });
      // If this CAS loses its lease, a successor repeats the idempotent physical deletion and owns
      // the only valid state transition from delete_pending to deleted.
      return await this.deps.store.completeBlobDelete(row.outboxId, claimToken, Date.now());
    } catch (error) {
      // Backend outages and acknowledgement failures are availability failures. They must remain
      // retryable regardless of attempt count. A manifest/outbox state mismatch is deterministic
      // poison and therefore uses the bounded dead-letter policy.
      await this.retry(row, claimToken, error, error instanceof BlobStateError);
      return false;
    }
  }

  private async retry(
    row: BlobDeleteOutboxRecord,
    claimToken: string,
    error: unknown,
    poison: boolean,
  ): Promise<void> {
    const failedAtMs = Date.now();
    const exponent = Math.min(30, Math.max(0, row.attempts - 1));
    const delay = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    const updated = await this.deps.store.retryBlobDelete(row.outboxId, claimToken, {
      failedAtMs,
      availableAtMs: failedAtMs + delay,
      error,
      ...(poison ? { maxAttempts: this.opts.poisonMaxAttempts } : {}),
    });
    if (updated && poison && row.attempts >= this.opts.poisonMaxAttempts) {
      this.log.error(`[blob-cleanup] dead-lettered outbox ${row.outboxId} after ${row.attempts} attempts`);
    }
  }
}
