import { randomUUID } from "node:crypto";
import {
  TenantContentInventoryEvidenceChangedError,
  TenantContentInventoryNotReadyError,
  TenantErasureIntegrityError,
  type TenantContentInventoryAuthorization,
  type TenantContentInventoryClaim,
  type TenantContentInventoryReceipt,
  type TenantContentInventoryStore,
} from "@agent-service/store";

export interface TenantContentInventoryWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  sessionPageSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantContentInventoryWorkerDeps {
  /** Least-privilege T3c evidence surface; it has no destructive content operation. */
  store: TenantContentInventoryStore;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 5,
  materializeBatchSize: 25,
  sessionPageSize: 100,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(
  claim: TenantContentInventoryClaim,
): TenantContentInventoryAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksInventory(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantContentInventoryEvidenceChangedError;
}

/**
 * Materializes and seals T3c structural owner-scan evidence. Database/store time is the sole
 * authority for availability, lease, capture, retention deadline, hold revalidation, and seal.
 * This worker cannot delete content or mark tenant erasure complete.
 */
export class TenantContentInventoryWorker {
  private readonly opts: Required<TenantContentInventoryWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantContentInventoryWorkerDeps,
    options: TenantContentInventoryWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(
        options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
        "pollIntervalMs",
      ),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      materializeBatchSize: positiveInteger(
        options.materializeBatchSize ?? DEFAULTS.materializeBatchSize,
        "materializeBatchSize",
      ),
      sessionPageSize: positiveInteger(
        options.sessionPageSize ?? DEFAULTS.sessionPageSize,
        "sessionPageSize",
      ),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100 || this.opts.materializeBatchSize > 100) {
      throw new Error("tenant content inventory batch sizes must not exceed 100");
    }
    if (this.opts.sessionPageSize > 1_000) {
      throw new Error("sessionPageSize must not exceed the store page limit of 1000");
    }
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    this.shutdownRequested = false;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  async processOnce(): Promise<number> {
    if (this.shutdownRequested) return 0;
    try {
      await this.deps.store.materializeTenantContentInventoryJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      // A malformed historical source must not starve an already materialized healthy job. Never
      // include backend errors here because they may contain row content or connection credentials.
      this.log.warn("[tenant-content-inventory-worker] materialization failed");
    }
    if (this.shutdownRequested) return 0;

    const claims = await this.deps.store.claimTenantContentInventories({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    let completed = 0;
    for (const claim of claims) {
      if (this.shutdownRequested) {
        await this.retry(claim).catch(() => false);
        continue;
      }
      try {
        if (await this.buildAndSeal(claim)) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-content-inventory-worker] claim failed");
        if (blocksInventory(error)) {
          await this.deps.store.blockTenantContentInventory(authorization(claim)).catch(() => false);
        } else {
          // Not-ready (deadline/hold) and backend failures both remain non-destructive retries. The
          // typed distinction matters because a valid not-ready state must never become blocked.
          await this.retry(claim).catch(() => false);
        }
      }
    }
    return completed;
  }

  private async buildAndSeal(claim: TenantContentInventoryClaim): Promise<boolean> {
    const auth = authorization(claim);
    while (true) {
      if (this.shutdownRequested) return this.retry(claim);
      if (!await this.deps.store.renewTenantContentInventory(auth, {
        leaseMs: this.opts.leaseMs,
      })) return false;
      if (this.shutdownRequested) return this.retry(claim);

      const page = await this.deps.store.buildTenantContentInventoryPage(auth, {
        limit: this.opts.sessionPageSize,
      });
      // Each page is store-atomic. Shutdown and lease loss stop before another durable boundary.
      if (this.shutdownRequested) return this.retry(claim);
      if (!page.done) {
        if (page.built === 0) throw new Error("tenant content inventory page made no progress");
        continue;
      }

      // A page scan can consume most of the lease. Renew immediately before the trusted-clock,
      // legal-hold, global-orphan and aggregate-receipt seal transaction.
      if (!await this.deps.store.renewTenantContentInventory(auth, {
        leaseMs: this.opts.leaseMs,
      })) return false;
      if (this.shutdownRequested) return this.retry(claim);
      return (await this.sealWithResponseLossReplay(auth)) !== null;
    }
  }

  /** Exact attempt/token replay can recover an aggregate committed before response loss. */
  private async sealWithResponseLossReplay(
    auth: TenantContentInventoryAuthorization,
  ): Promise<TenantContentInventoryReceipt | null> {
    try {
      return await this.deps.store.sealTenantContentInventory(auth);
    } catch (firstError) {
      if (
        blocksInventory(firstError)
        || firstError instanceof TenantContentInventoryNotReadyError
      ) throw firstError;
      try {
        const replay = await this.deps.store.sealTenantContentInventory(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (
          blocksInventory(replayError)
          || replayError instanceof TenantContentInventoryNotReadyError
        ) throw replayError;
      }
      throw firstError;
    }
  }

  private async retry(claim: TenantContentInventoryClaim): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantContentInventory(authorization(claim), {
      delayMs,
      errorCode: "temporary_failure",
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      this.inFlight = run;
      void run
        .catch(() => {
          this.log.warn("[tenant-content-inventory-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
