import { describe, expect, it } from "vitest";
import type {
  BlobCleanupStore,
  BlobDeleteOutboxRecord,
  BlobStore,
  ClaimBlobDeletesOptions,
  RetryBlobDeleteOptions,
  ScheduleStaleBlobsOptions,
} from "@agent-service/store";
import { BLOB_STORAGE_FORMAT, blobStorageKey } from "@agent-service/store";
import { BlobCleanupWorker, newId } from "../src/index.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function pending(nowMs = Date.now()): BlobDeleteOutboxRecord {
  const blobId = newId("blob");
  return {
    outboxId: 1,
    blobId,
    generation: 1,
    storageBackend: "memory-v1",
    storageFormat: BLOB_STORAGE_FORMAT,
    storageKey: blobStorageKey(blobId),
    uploadToken: "upload-token-0001",
    availableAtMs: nowMs,
    attempts: 0,
    createdAtMs: nowMs,
  };
}

class FakeCleanupStore implements BlobCleanupStore {
  row?: BlobDeleteOutboxRecord;
  readonly calls: string[] = [];
  readonly claimTokens: string[] = [];
  scheduleHook?: (options: ScheduleStaleBlobsOptions) => BlobDeleteOutboxRecord | undefined;
  loseNextCompletion = false;

  async scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number> {
    this.calls.push("schedule");
    const scheduled = this.scheduleHook?.(options);
    if (!this.row && scheduled) {
      this.row = structuredClone(scheduled);
      return 1;
    }
    return 0;
  }

  async claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]> {
    this.calls.push("claim");
    const row = this.row;
    if (
      !row
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.availableAtMs > options.nowMs
      || (row.claimToken !== undefined && (row.leaseUntilMs ?? 0) > options.nowMs)
    ) {
      return [];
    }
    row.attempts += 1;
    row.claimToken = options.claimToken;
    row.leaseUntilMs = options.nowMs + options.leaseMs;
    this.claimTokens.push(options.claimToken);
    return [structuredClone(row)];
  }

  async renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: { nowMs: number; leaseMs: number },
  ): Promise<boolean> {
    this.calls.push("renew");
    const row = this.row;
    if (
      !row
      || row.outboxId !== outboxId
      || row.claimToken !== claimToken
      || (row.leaseUntilMs ?? 0) <= options.nowMs
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
    ) {
      return false;
    }
    row.leaseUntilMs = Math.max(row.leaseUntilMs!, options.nowMs + options.leaseMs);
    return true;
  }

  async completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean> {
    this.calls.push("complete");
    if (this.loseNextCompletion) {
      this.loseNextCompletion = false;
      return false;
    }
    const row = this.row;
    if (
      !row
      || row.outboxId !== outboxId
      || row.claimToken !== claimToken
      || (row.leaseUntilMs ?? 0) <= completedAtMs
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
    ) {
      return false;
    }
    row.completedAtMs = completedAtMs;
    delete row.claimToken;
    delete row.leaseUntilMs;
    delete row.lastError;
    return true;
  }

  async retryBlobDelete(
    outboxId: number,
    claimToken: string,
    options: RetryBlobDeleteOptions,
  ): Promise<boolean> {
    this.calls.push("retry");
    const row = this.row;
    if (
      !row
      || row.outboxId !== outboxId
      || row.claimToken !== claimToken
      || (row.leaseUntilMs ?? 0) <= options.failedAtMs
      || row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
    ) {
      return false;
    }
    row.lastError = options.error instanceof Error ? options.error.message : String(options.error);
    delete row.claimToken;
    delete row.leaseUntilMs;
    if (options.maxAttempts !== undefined && row.attempts >= options.maxAttempts) {
      row.deadLetteredAtMs = options.failedAtMs;
    } else {
      row.availableAtMs = options.availableAtMs;
    }
    return true;
  }

  async getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null> {
    return this.row?.blobId === blobId && this.row.generation === generation
      ? structuredClone(this.row)
      : null;
  }
}

class FakeBlobStore implements BlobStore {
  readonly backend = "memory-v1";
  readonly objects = new Map<string, Buffer>();
  readonly deletes: Array<{ storageKey: string; uploadToken?: string }> = [];
  failures = 0;

  async putIfAbsent(
    storageKey: string,
    data: Buffer | string,
    options: { uploadToken: string; maxBytes: number; contentType?: string },
  ) {
    const value = Buffer.from(data);
    this.objects.set(storageKey, value);
    return {
      storageKey,
      sha256: "0".repeat(64),
      sizeBytes: value.length,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    };
  }

  async get(storageKey: string, _options: { maxBytes: number }) {
    const data = this.objects.get(storageKey);
    return data
      ? { storageKey, sha256: "0".repeat(64), sizeBytes: data.length, data: Buffer.from(data) }
      : null;
  }

  async delete(storageKey: string, options?: { uploadToken?: string }): Promise<void> {
    this.deletes.push({ storageKey, ...(options?.uploadToken ? { uploadToken: options.uploadToken } : {}) });
    if (this.failures-- > 0) throw new Error("temporary backend outage token=must-not-be-logged");
    this.objects.delete(storageKey);
  }
}

describe("BlobCleanupWorker", () => {
  it("schedules stale staging rows before claiming and completes an idempotent delete", async () => {
    const nowMs = Date.now();
    const store = new FakeCleanupStore();
    const row = pending(nowMs);
    store.scheduleHook = () => row;
    const blob = new FakeBlobStore();
    blob.objects.set(row.storageKey, Buffer.from("payload"));
    const worker = new BlobCleanupWorker({ store, blob, logger: silent });

    expect(await worker.cleanupOnce(nowMs)).toBe(1);
    expect(store.calls).toEqual(["schedule", "claim", "renew", "complete"]);
    expect(blob.deletes).toEqual([{ storageKey: row.storageKey, uploadToken: row.uploadToken }]);
    expect(blob.objects.has(row.storageKey)).toBe(false);
    expect(store.row).toMatchObject({ attempts: 1, completedAtMs: expect.any(Number) });
  });

  it("keeps temporary backend failures retryable beyond the poison attempt cap", async () => {
    const nowMs = Date.now();
    const store = new FakeCleanupStore();
    store.row = pending(nowMs);
    const blob = new FakeBlobStore();
    blob.failures = 3;
    const worker = new BlobCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 2, poisonMaxAttempts: 2 },
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await worker.cleanupOnce(store.row!.availableAtMs)).toBe(0);
      expect(store.row).toMatchObject({ attempts: attempt, availableAtMs: expect.any(Number) });
      expect(store.row?.deadLetteredAtMs).toBeUndefined();
    }
    expect(await worker.cleanupOnce(store.row.availableAtMs)).toBe(1);
    expect(store.row).toMatchObject({ attempts: 4, completedAtMs: expect.any(Number) });
  });

  it("repeats an already-effective delete after a lost acknowledgement with a fresh claim token", async () => {
    const nowMs = Date.now();
    const store = new FakeCleanupStore();
    store.row = pending(nowMs);
    store.loseNextCompletion = true;
    const blob = new FakeBlobStore();
    blob.objects.set(store.row.storageKey, Buffer.from("payload"));
    const worker = new BlobCleanupWorker({ store, blob, logger: silent }, { leaseMs: 100 });

    expect(await worker.cleanupOnce(nowMs)).toBe(0);
    const retryAtMs = store.row.leaseUntilMs!;
    expect(await worker.cleanupOnce(retryAtMs)).toBe(1);

    expect(blob.deletes).toHaveLength(2);
    expect(new Set(store.claimTokens).size).toBe(2);
    expect(store.row).toMatchObject({ attempts: 2, completedAtMs: expect.any(Number) });
  });

  it("keeps a backend mismatch retryable beyond the poison attempt cap", async () => {
    const store = new FakeCleanupStore();
    store.row = { ...pending(), storageBackend: "wrong-backend" };
    const blob = new FakeBlobStore();
    const worker = new BlobCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1, poisonMaxAttempts: 2 },
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await worker.cleanupOnce(store.row.availableAtMs)).toBe(0);
      expect(store.row).toMatchObject({ attempts: attempt, availableAtMs: expect.any(Number) });
      expect(store.row.deadLetteredAtMs).toBeUndefined();
    }
    expect(blob.deletes).toHaveLength(0);
  });

  it("dead-letters a valid-looking but non-canonical key without touching the blob adapter", async () => {
    const store = new FakeCleanupStore();
    const row = pending();
    const actualShard = row.blobId.slice("blob_".length, "blob_".length + 2);
    store.row = {
      ...row,
      storageKey: `objects/${actualShard === "ff" ? "00" : "ff"}/${row.blobId}`,
    };
    const blob = new FakeBlobStore();
    const worker = new BlobCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1, poisonMaxAttempts: 1 },
    );

    expect(await worker.cleanupOnce(store.row.availableAtMs)).toBe(0);
    expect(store.row).toMatchObject({ attempts: 1, deadLetteredAtMs: expect.any(Number) });
    expect(blob.deletes).toHaveLength(0);
  });

  it("treats a malformed physical identity as poison without touching the blob adapter", async () => {
    const store = new FakeCleanupStore();
    store.row = { ...pending(), storageKey: "../outside" };
    const blob = new FakeBlobStore();
    const worker = new BlobCleanupWorker(
      { store, blob, logger: silent },
      { retryBaseMs: 1, retryMaxMs: 1, poisonMaxAttempts: 1 },
    );

    expect(await worker.cleanupOnce(store.row.availableAtMs)).toBe(0);
    expect(store.row).toMatchObject({ attempts: 1, deadLetteredAtMs: expect.any(Number) });
    expect(blob.deletes).toHaveLength(0);
  });

  it("allows only one of two workers to claim and delete the same row", async () => {
    const nowMs = Date.now();
    const store = new FakeCleanupStore();
    store.row = pending(nowMs);
    const blob = new FakeBlobStore();
    const first = new BlobCleanupWorker({ store, blob, logger: silent });
    const second = new BlobCleanupWorker({ store, blob, logger: silent });

    expect((await Promise.all([first.cleanupOnce(nowMs), second.cleanupOnce(nowMs)])).sort()).toEqual([0, 1]);
    expect(blob.deletes).toHaveLength(1);
    expect(store.claimTokens).toHaveLength(1);
  });
});
