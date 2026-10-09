import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  type TenantCredentialRevocationAuthorization,
  type TenantCredentialRevocationClaim,
  type TenantCredentialRevocationStore,
} from "@agent-service/store";

export interface TenantCredentialRevocationWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantCredentialRevocationWorkerDeps {
  /** Least-privilege T3a surface; it cannot purge tenant content or mark erasure complete. */
  store: TenantCredentialRevocationStore;
  /** Fresh router-mediated all-runner barrier. False/unavailable revokes destructive authority. */
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

function authorization(
  claim: TenantCredentialRevocationClaim,
): TenantCredentialRevocationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

/**
 * Executes only the T3a local-database credential transaction. A receipt from this worker proves
 * API-key/provider-row deletion and tenant auth-column clearing; it deliberately proves nothing
 * about runtime caches, active I/O, external providers, KMS, backups or tenant content.
 */
export class TenantCredentialRevocationWorker {
  private readonly opts: Required<TenantCredentialRevocationWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantCredentialRevocationWorkerDeps,
    options: TenantCredentialRevocationWorkerOptions = {},
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
      throw new Error("tenant credential revocation batch sizes must not exceed 100");
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
    if (!await this.barrier()) return 0;
    // stop() can win while the remote barrier request is in flight. Recheck before beginning any
    // durable work; the pre-await check alone does not fence that race.
    if (this.shutdownRequested) return 0;
    try {
      await this.deps.store.materializeTenantCredentialRevocationJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      // A malformed historical candidate must not leak row data or starve already queued work.
      this.log.warn("[tenant-credential-revocation-worker] materialization failed");
    }
    if (this.shutdownRequested) return 0;
    if (!await this.barrier()) return 0;
    if (this.shutdownRequested) return 0;

    const claims = await this.deps.store.claimTenantCredentialRevocations({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    let completed = 0;
    for (const claim of claims) {
      if (this.shutdownRequested) {
        await this.retry(claim);
        continue;
      }
      const auth = authorization(claim);
      try {
        // Renewal is not authority by itself. The fleet barrier is deliberately the final external
        // operation immediately before the destructive store transaction.
        if (!await this.deps.store.renewTenantCredentialRevocation(auth, {
          leaseMs: this.opts.leaseMs,
        })) continue;
        if (this.shutdownRequested) {
          await this.retry(claim);
          continue;
        }
        if (!await this.barrier()) {
          await this.retry(claim);
          continue;
        }
        // The final barrier is remote and may resolve after shutdown begins. Never cross from that
        // stale response into the irreversible credential transaction.
        if (this.shutdownRequested) {
          await this.retry(claim);
          continue;
        }
        const receipt = await this.deps.store.revokeTenantCredentialMaterial(auth);
        if (receipt) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-credential-revocation-worker] claim failed");
        if (error instanceof TenantErasureIntegrityError) {
          await this.deps.store.blockTenantCredentialRevocation(auth).catch(() => false);
        } else {
          await this.retry(claim).catch(() => false);
        }
      }
    }
    return completed;
  }

  private async barrier(): Promise<boolean> {
    try {
      return await this.deps.canExecute();
    } catch {
      return false;
    }
  }

  private async retry(claim: TenantCredentialRevocationClaim): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantCredentialRevocation(authorization(claim), {
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
          this.log.warn("[tenant-credential-revocation-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
