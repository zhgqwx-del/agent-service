import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  TenantPurgePlanEvidenceChangedError,
  TenantPurgePlanNotReadyError,
  type TenantPurgePlanAuthorization,
  type TenantPurgePlanClaim,
  type TenantPurgePlanReceipt,
  type TenantPurgePlanStore,
} from "@agent-service/store";

export interface TenantPurgePlanWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantPurgePlanWorkerDeps {
  /** Planning-only T3d surface. It exposes no delete, anonymize, revoke, or completion method. */
  store: TenantPurgePlanStore;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 5,
  materializeBatchSize: 25,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(claim: TenantPurgePlanClaim): TenantPurgePlanAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksPlan(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantPurgePlanEvidenceChangedError;
}

/**
 * Builds and seals the non-destructive T3d full-domain plan. Store/database time remains the sole
 * clock authority. The worker can only persist hashes, counts, dispositions, and a receipt whose
 * executionReady/contentPurgeExecuted flags are fixed false.
 */
export class TenantPurgePlanWorker {
  private readonly opts: Required<TenantPurgePlanWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantPurgePlanWorkerDeps,
    options: TenantPurgePlanWorkerOptions = {},
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
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100 || this.opts.materializeBatchSize > 100) {
      throw new Error("tenant purge plan batch sizes must not exceed 100");
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
      await this.deps.store.materializeTenantPurgePlanJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      // Do not log source rows, backend errors, secrets, locators, or external adapter metadata.
      this.log.warn("[tenant-purge-plan-worker] materialization failed");
    }
    if (this.shutdownRequested) return 0;

    const claims = await this.deps.store.claimTenantPurgePlans({
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
        this.log.warn("[tenant-purge-plan-worker] claim failed");
        if (blocksPlan(error)) {
          await this.deps.store.blockTenantPurgePlan(authorization(claim)).catch(() => false);
        } else {
          await this.retry(claim).catch(() => false);
        }
      }
    }
    return completed;
  }

  private async buildAndSeal(claim: TenantPurgePlanClaim): Promise<boolean> {
    const auth = authorization(claim);
    if (this.shutdownRequested) return this.retry(claim);
    if (!await this.deps.store.renewTenantPurgePlan(auth, {
      leaseMs: this.opts.leaseMs,
    })) return false;
    if (this.shutdownRequested) return this.retry(claim);

    // A new empty plan is generated and sealed by the store in one atomic boundary. The worker
    // intentionally never calls buildTenantPurgePlanPage: a multi-transaction live snapshot could
    // drift between pages and leave an append-only plan permanently unsealable.
    return (await this.sealWithResponseLossReplay(auth)) !== null;
  }

  /** Exact attempt/token replay recovers a receipt committed before response loss. */
  private async sealWithResponseLossReplay(
    auth: TenantPurgePlanAuthorization,
  ): Promise<TenantPurgePlanReceipt | null> {
    try {
      return await this.deps.store.sealTenantPurgePlan(auth);
    } catch (firstError) {
      if (blocksPlan(firstError) || firstError instanceof TenantPurgePlanNotReadyError) {
        throw firstError;
      }
      try {
        const replay = await this.deps.store.sealTenantPurgePlan(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (blocksPlan(replayError) || replayError instanceof TenantPurgePlanNotReadyError) {
          throw replayError;
        }
      }
      throw firstError;
    }
  }

  private async retry(claim: TenantPurgePlanClaim): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantPurgePlan(authorization(claim), {
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
          this.log.warn("[tenant-purge-plan-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
