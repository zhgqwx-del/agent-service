import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  type TenantRuntimeRevocationAuthorization,
  type TenantRuntimeRevocationClaim,
  type TenantRuntimeRevocationFleetProof,
  type TenantRuntimeRevocationReceipt,
  type TenantRuntimeRevocationStore,
} from "@agent-service/store";

export interface TenantRuntimeRevocationWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantRuntimeFleetDrainRequest {
  requestId: string;
  tenantId: string;
  subjectGeneration: number;
  t3aReceiptSha256: string;
}

export interface TenantRuntimeRevocationWorkerDeps {
  /** Least-privilege T3b queue/receipt surface; it cannot purge tenant content. */
  store: TenantRuntimeRevocationStore;
  /** Fresh router-mediated broadcast to every exact configured runner target. */
  drainFleet: (
    request: TenantRuntimeFleetDrainRequest,
  ) => Promise<TenantRuntimeRevocationFleetProof | null>;
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

function authorization(
  claim: TenantRuntimeRevocationClaim,
): TenantRuntimeRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

/**
 * Drives T3b only: process-local cache/reference eviction plus bounded local I/O/turn drain across
 * the router's exact configured fleet. The resulting aggregate receipt deliberately does not claim
 * external-provider revocation, tenant content purge, backup replay, or tenant erasure completion.
 */
export class TenantRuntimeRevocationWorker {
  private readonly opts: Required<TenantRuntimeRevocationWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantRuntimeRevocationWorkerDeps,
    options: TenantRuntimeRevocationWorkerOptions = {},
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
      throw new Error("tenant runtime revocation batch sizes must not exceed 100");
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
      await this.deps.store.materializeTenantRuntimeRevocationJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      // Materialization is non-destructive. Keep already-queued work available while a malformed
      // historical candidate remains fail-closed for operator investigation.
      this.log.warn("[tenant-runtime-revocation-worker] materialization failed");
    }
    if (this.shutdownRequested) return 0;

    const claims = await this.deps.store.claimTenantRuntimeRevocations({
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
      const auth = authorization(claim);
      let proof: TenantRuntimeRevocationFleetProof | null = null;
      try {
        if (!await this.deps.store.renewTenantRuntimeRevocation(auth, {
          leaseMs: this.opts.leaseMs,
        })) continue;
        if (this.shutdownRequested) {
          await this.retry(claim);
          continue;
        }

        proof = await this.deps.drainFleet({
          requestId: claim.requestId,
          tenantId: claim.tenantId,
          subjectGeneration: claim.subjectGeneration,
          t3aReceiptSha256: claim.t3aReceiptSha256,
        });
        if (!proof) {
          await this.retry(claim);
          continue;
        }
        if (this.shutdownRequested) {
          await this.retry(claim);
          continue;
        }

        // The bounded fleet call may consume most of the prior lease. Re-establish database-clock
        // authority immediately before the atomic target-set/aggregate/job transaction.
        if (!await this.deps.store.renewTenantRuntimeRevocation(auth, {
          leaseMs: this.opts.leaseMs,
        })) continue;
        if (this.shutdownRequested) {
          await this.retry(claim);
          continue;
        }
        const receipt = await this.completeWithResponseLossReplay(auth, proof);
        if (receipt) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-runtime-revocation-worker] claim failed");
        if (error instanceof TenantErasureIntegrityError) {
          await this.deps.store.blockTenantRuntimeRevocation(auth).catch(() => false);
        } else {
          await this.retry(claim).catch(() => false);
        }
      }
    }
    return completed;
  }

  /**
   * A connection can disappear after MySQL committed. One exact replay with the same attempt/token
   * is safe and lets the store return the immutable terminal receipt without inventing a new claim.
   */
  private async completeWithResponseLossReplay(
    auth: TenantRuntimeRevocationAuthorization,
    proof: TenantRuntimeRevocationFleetProof,
  ): Promise<TenantRuntimeRevocationReceipt | null> {
    try {
      return await this.deps.store.completeTenantRuntimeRevocation(auth, proof);
    } catch (firstError) {
      try {
        const replay = await this.deps.store.completeTenantRuntimeRevocation(auth, proof);
        if (replay) return replay;
      } catch (replayError) {
        // Either attempt can expose a durable proof conflict. Prefer that typed classification so
        // an ambiguous first transport failure cannot downgrade corrupt committed evidence into an
        // endlessly retried transient failure.
        if (replayError instanceof TenantErasureIntegrityError) throw replayError;
      }
      throw firstError;
    }
  }

  private async retry(claim: TenantRuntimeRevocationClaim): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantRuntimeRevocation(authorization(claim), {
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
          this.log.warn("[tenant-runtime-revocation-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
