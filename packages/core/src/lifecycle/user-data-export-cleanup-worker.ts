import { randomUUID } from "node:crypto";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  UserDataExportStateError,
  type BlobStore,
  type UserDataExportCleanupStore,
  type UserDataExportDeleteOutboxRecord,
} from "@agent-service/store";

export interface UserDataExportCleanupWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Availability failures retry forever; only deterministic poison uses this cap. */
  poisonMaxAttempts?: number;
}

export interface UserDataExportCleanupWorkerDeps {
  /** Dedicated artifact queue; it has no session Blob cleanup authority. */
  store: UserDataExportCleanupStore;
  blob: BlobStore;
  logger?: Pick<Console, "warn" | "error">;
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
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ARTIFACT_ID = new RegExp(`^xart_${UUID_V4}$`);
const REQUEST_ID = new RegExp(`^export_${UUID_V4}$`);

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function validStorageKey(value: string): boolean {
  if (!value || value.length > 512) return false;
  return value.split("/").every((part) => SAFE_KEY_SEGMENT.test(part) && !WINDOWS_DEVICE_NAME.test(part));
}

function matchesArtifactStorageIdentity(row: UserDataExportDeleteOutboxRecord): boolean {
  const segments = row.storageKey.split("/");
  return segments.length === 5
    && segments[0] === "data_exports"
    && /^[0-9a-f]{64}$/.test(segments[1] ?? "")
    && segments[2] === row.requestId
    && segments[3] === row.artifactId
    && segments[4] === `part_${String(row.partNumber).padStart(10, "0")}`;
}

function hasValidIdentity(row: UserDataExportDeleteOutboxRecord, claimToken: string): boolean {
  return Number.isSafeInteger(row.outboxId)
    && row.outboxId > 0
    && ARTIFACT_ID.test(row.artifactId)
    && REQUEST_ID.test(row.requestId)
    && Number.isSafeInteger(row.partNumber)
    && row.partNumber >= 0
    && Number.isSafeInteger(row.deletionGeneration)
    && row.deletionGeneration > 0
    && Number.isSafeInteger(row.attempts)
    && row.attempts > 0
    && row.claimToken === claimToken
    && validStorageKey(row.storageKey)
    && matchesArtifactStorageIdentity(row)
    && UPLOAD_TOKEN.test(row.uploadToken);
}

/** Deletes only export-owned artifact parts through their dedicated durable outbox. */
export class UserDataExportCleanupWorker {
  private readonly opts: Required<UserDataExportCleanupWorkerOptions>;
  private readonly log: Pick<Console, "warn" | "error">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;

  constructor(
    private readonly deps: UserDataExportCleanupWorkerDeps,
    options: UserDataExportCleanupWorkerOptions = {},
  ) {
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
    if (this.opts.batchSize > 100) throw new Error("batchSize must not exceed 100");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  /** One deterministic TTL scheduling and physical-delete pass. */
  async cleanupOnce(): Promise<number> {
    try {
      await this.deps.store.scheduleUserDataExportDeletes(this.opts.batchSize);
    } catch {
      // Already-durable delete intents must keep draining even when this scheduling pass fails.
      this.log.warn("[user-data-export-cleanup] scheduling failed");
    }

    const claimToken = randomUUID();
    const rows = await this.deps.store.claimUserDataExportDeletes({
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

  private async deleteClaimed(row: UserDataExportDeleteOutboxRecord, claimToken: string): Promise<boolean> {
    if (!hasValidIdentity(row, claimToken) || row.storageFormat !== BLOB_STORAGE_FORMAT) {
      await this.retry(row, claimToken, new Error("invalid export artifact delete identity"), true);
      return false;
    }
    if (row.storageBackend !== this.deps.blob.backend) {
      await this.retry(row, claimToken, new Error("export artifact storage adapter is unavailable"), false);
      return false;
    }

    if (!await this.deps.store.renewUserDataExportDeleteClaim(
      row.outboxId,
      claimToken,
      this.opts.leaseMs,
    )) return false;

    try {
      // Missing objects are success by BlobStore contract. If the ACK is lost, a successor repeats
      // this same key/token-fenced deletion before it owns the only valid durable completion CAS.
      await this.deps.blob.delete(row.storageKey, { uploadToken: row.uploadToken });
      return await this.deps.store.completeUserDataExportDelete(row.outboxId, claimToken);
    } catch (error) {
      const poison = error instanceof BlobStateError || error instanceof UserDataExportStateError;
      await this.retry(row, claimToken, error, poison);
      return false;
    }
  }

  private async retry(
    row: UserDataExportDeleteOutboxRecord,
    claimToken: string,
    error: unknown,
    poison: boolean,
  ): Promise<void> {
    const exponent = Math.min(30, Math.max(0, row.attempts - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    const updated = await this.deps.store.retryUserDataExportDelete(row.outboxId, claimToken, {
      delayMs,
      error,
      ...(poison ? { maxAttempts: this.opts.poisonMaxAttempts } : {}),
    });
    if (updated && poison && row.attempts >= this.opts.poisonMaxAttempts) {
      this.log.error(`[user-data-export-cleanup] dead-lettered outbox ${row.outboxId}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.cleanupOnce();
      this.inFlight = run;
      void run
        .catch(() => this.log.warn("[user-data-export-cleanup] polling failed"))
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
