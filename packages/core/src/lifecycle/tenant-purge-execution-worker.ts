import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  TenantPurgeExecutionEvidenceChangedError,
  TenantPurgeExecutionNotReadyError,
  TenantPurgeExecutionPhysicalAckDeadLetterError,
  type TenantPurgeExecutionAuthorization,
  type TenantPurgeExecutionClaim,
  type TenantPurgeExecutionStore,
  type TenantPurgeLocalCutoverReceipt,
  type TenantPurgeLocalPhysicalAckReceipt,
} from "@agent-service/store";

export interface TenantPurgeExecutionWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantPurgeExecutionWorkerDeps {
  /** Narrow T3e surface. It cannot promote public completion or erase unresolved domains. */
  store: TenantPurgeExecutionStore;
  /** One fresh router fleet proof authorizes only the immediately following bounded boundary. */
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

function authorization(claim: TenantPurgeExecutionClaim): TenantPurgeExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksExecution(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantPurgeExecutionEvidenceChangedError;
}

/**
 * Advances only the locally implemented T3e execution/ACK slice. Every queue scan and every
 * claim-bound boundary gets a fresh non-sticky router proof. The store remains authoritative for
 * DB time, holds, leases, rollback, exact outbox correlation, and the fixed false completion flags.
 */
export class TenantPurgeExecutionWorker {
  private readonly opts: Required<TenantPurgeExecutionWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantPurgeExecutionWorkerDeps,
    options: TenantPurgeExecutionWorkerOptions = {},
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
      throw new Error("tenant purge execution batch sizes must not exceed 100");
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
      await this.deps.store.materializeTenantPurgeExecutionJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      // Never include backend errors: they may contain row data, locators, or connection secrets.
      this.log.warn("[tenant-purge-execution-worker] materialization failed");
    }
    if (this.shutdownRequested || !await this.freshGate()) return 0;

    const claims = await this.deps.store.claimTenantPurgeExecutions({
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
        this.log.warn("[tenant-purge-execution-worker] claim failed");
        if (error instanceof TenantPurgeExecutionPhysicalAckDeadLetterError) {
          // The store committed the terminal blocked transition in the same boundary that observed
          // the exact dead letter. A second worker-side transition would introduce a TOCTOU gap.
          continue;
        }
        if (blocksExecution(error)) {
          await this.deps.store.blockTenantPurgeExecution(
            authorization(claim),
            "integrity_conflict",
          ).catch(() => false);
          continue;
        }
        const code = error instanceof TenantPurgeExecutionNotReadyError
          && error.reason === "physical_ack_pending"
          ? "physical_ack_pending" as const
          : "temporary_failure" as const;
        await this.retry(claim, code).catch(() => false);
      }
    }
    return completed;
  }

  private async advance(claim: TenantPurgeExecutionClaim): Promise<boolean> {
    const auth = authorization(claim);
    if (!await this.renewAfterFreshGate(auth)) return false;

    if (!claim.localCutoverCommitted) {
      if (this.shutdownRequested || !await this.freshGate()) {
        await this.retry(claim, "temporary_failure");
        return false;
      }
      const cutover = await this.cutoverWithResponseLossReplay(auth);
      if (!cutover) return false;
    }

    if (this.shutdownRequested || !await this.renewAfterFreshGate(auth)) {
      await this.retry(claim, "temporary_failure");
      return false;
    }
    if (this.shutdownRequested || !await this.freshGate()) {
      await this.retry(claim, "temporary_failure");
      return false;
    }
    return (await this.physicalSealWithResponseLossReplay(auth)) !== null;
  }

  private async renewAfterFreshGate(auth: TenantPurgeExecutionAuthorization): Promise<boolean> {
    if (this.shutdownRequested || !await this.freshGate()) return false;
    return this.deps.store.renewTenantPurgeExecution(auth, { leaseMs: this.opts.leaseMs });
  }

  private async cutoverWithResponseLossReplay(
    auth: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalCutoverReceipt | null> {
    try {
      return await this.deps.store.executeTenantPurgeLocalCutover(auth);
    } catch (firstError) {
      if (blocksExecution(firstError) || firstError instanceof TenantPurgeExecutionNotReadyError) {
        throw firstError;
      }
      // A lost response does not let one fleet proof authorize a second potentially destructive
      // invocation. The store will distinguish exact receipt replay from an uncommitted retry.
      if (this.shutdownRequested || !await this.freshGate()) throw firstError;
      try {
        const replay = await this.deps.store.executeTenantPurgeLocalCutover(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (blocksExecution(replayError)
          || replayError instanceof TenantPurgeExecutionNotReadyError) throw replayError;
      }
      throw firstError;
    }
  }

  private async physicalSealWithResponseLossReplay(
    auth: TenantPurgeExecutionAuthorization,
  ): Promise<TenantPurgeLocalPhysicalAckReceipt | null> {
    try {
      return await this.deps.store.sealTenantPurgeLocalPhysicalAcks(auth);
    } catch (firstError) {
      if (
        blocksExecution(firstError)
        || firstError instanceof TenantPurgeExecutionNotReadyError
        || firstError instanceof TenantPurgeExecutionPhysicalAckDeadLetterError
      ) throw firstError;
      // The retry can still be the call that commits, so it requires its own fresh rollout proof.
      if (this.shutdownRequested || !await this.freshGate()) throw firstError;
      try {
        const replay = await this.deps.store.sealTenantPurgeLocalPhysicalAcks(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (
          blocksExecution(replayError)
          || replayError instanceof TenantPurgeExecutionNotReadyError
          || replayError instanceof TenantPurgeExecutionPhysicalAckDeadLetterError
        ) throw replayError;
      }
      throw firstError;
    }
  }

  private async retry(
    claim: TenantPurgeExecutionClaim,
    errorCode: "temporary_failure" | "physical_ack_pending",
  ): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantPurgeExecution(authorization(claim), {
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
          this.log.warn("[tenant-purge-execution-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
