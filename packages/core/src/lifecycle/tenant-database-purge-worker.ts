import { randomUUID } from "node:crypto";
import {
  TenantDatabasePurgeEvidenceChangedError,
  TenantDatabasePurgeNotReadyError,
  TenantErasureIntegrityError,
  type TenantDatabasePurgeAuthorization,
  type TenantDatabasePurgeClaim,
  type TenantDatabasePurgeReceipt,
  type TenantDatabasePurgeStore,
} from "@agent-service/store";

export interface TenantDatabasePurgeWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantDatabasePurgeWorkerDeps {
  /** Narrow T3f database-only surface. It cannot clear Redis or promote tenant completion. */
  store: TenantDatabasePurgeStore;
  /** A fresh all-configured-fleet proof authorizes only the immediately following boundary. */
  canExecute: () => Promise<boolean>;
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

function authorization(claim: TenantDatabasePurgeClaim): TenantDatabasePurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksExecution(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantDatabasePurgeEvidenceChangedError;
}

/**
 * Executes only the T3f local database projection cutover. The store owns trusted DB time,
 * canonical holds, source/root validation, transactional rollback, grave markers, and the fixed
 * false global-completion flags. Materialize, claim, renew, destructive execution and ambiguous
 * response replay each receive a new, non-sticky fleet proof. Retry/block only release or close an
 * already-authorized claim and never perform content deletion.
 */
export class TenantDatabasePurgeWorker {
  private readonly opts: Required<TenantDatabasePurgeWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantDatabasePurgeWorkerDeps,
    options: TenantDatabasePurgeWorkerOptions = {},
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
      throw new Error("tenant database purge batch sizes must not exceed 100");
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
    if (this.shutdownRequested || !await this.freshGate()) return 0;
    try {
      await this.deps.store.materializeTenantDatabasePurgeJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      this.log.warn("[tenant-database-purge-worker] materialization failed");
    }
    if (this.shutdownRequested || !await this.freshGate()) return 0;

    const claims = await this.deps.store.claimTenantDatabasePurges({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    let completed = 0;
    for (const claim of claims) {
      if (this.shutdownRequested || !await this.freshGate()) {
        await this.retry(claim, "temporary_failure").catch(() => false);
        continue;
      }
      try {
        if (await this.advance(claim)) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-database-purge-worker] claim failed");
        if (blocksExecution(error)) {
          await this.deps.store.blockTenantDatabasePurge(
            authorization(claim),
            "integrity_conflict",
          ).catch(() => false);
          continue;
        }
        const code = error instanceof TenantDatabasePurgeNotReadyError
          ? "dependency_pending" as const
          : "temporary_failure" as const;
        await this.retry(claim, code).catch(() => false);
      }
    }
    return completed;
  }

  private async advance(claim: TenantDatabasePurgeClaim): Promise<boolean> {
    const auth = authorization(claim);
    if (!await this.renewAfterFreshGate(auth)) return false;
    if (this.shutdownRequested || !await this.freshGate()) {
      await this.retry(claim, "temporary_failure");
      return false;
    }
    return (await this.executeWithResponseLossReplay(auth)) !== null;
  }

  private async renewAfterFreshGate(auth: TenantDatabasePurgeAuthorization): Promise<boolean> {
    if (this.shutdownRequested || !await this.freshGate()) return false;
    return this.deps.store.renewTenantDatabasePurge(auth, { leaseMs: this.opts.leaseMs });
  }

  private async executeWithResponseLossReplay(
    auth: TenantDatabasePurgeAuthorization,
  ): Promise<TenantDatabasePurgeReceipt | null> {
    try {
      return await this.deps.store.executeTenantDatabasePurge(auth);
    } catch (firstError) {
      if (blocksExecution(firstError) || firstError instanceof TenantDatabasePurgeNotReadyError) {
        throw firstError;
      }
      if (this.shutdownRequested || !await this.freshGate()) throw firstError;
      try {
        const replay = await this.deps.store.executeTenantDatabasePurge(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (
          blocksExecution(replayError)
          || replayError instanceof TenantDatabasePurgeNotReadyError
        ) throw replayError;
      }
      throw firstError;
    }
  }

  private async retry(
    claim: TenantDatabasePurgeClaim,
    errorCode: "temporary_failure" | "dependency_pending",
  ): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantDatabasePurge(authorization(claim), {
      delayMs,
      errorCode,
    });
  }

  private async freshGate(): Promise<boolean> {
    try {
      return await this.deps.canExecute();
    } catch {
      return false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      this.inFlight = run;
      void run
        .catch(() => {
          this.log.warn("[tenant-database-purge-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
