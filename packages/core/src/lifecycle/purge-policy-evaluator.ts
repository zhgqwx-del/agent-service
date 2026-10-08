import { randomUUID } from "node:crypto";
import {
  ErasurePurgeEvidenceChangedError,
  type ErasurePolicyEvaluationErrorCode,
  type ErasurePolicyEvaluationAuthorization,
  type ErasurePolicyEvaluationClaim,
  type ErasurePolicyEvaluationStore,
} from "@agent-service/store";

export interface PurgePolicyEvaluatorOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  jobBatchSize?: number;
  targetPageSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface PurgePolicyEvaluatorDeps {
  /** Least-privilege store: this surface cannot advance erasure state or enqueue deletion. */
  store: ErasurePolicyEvaluationStore;
  /** Versioned fleet barrier. False or unavailable means no scheduling and no queue claim. */
  canClaim: () => Promise<boolean>;
  clock?: { now(): number };
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  jobBatchSize: 10,
  targetPageSize: 100,
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
  claim: ErasurePolicyEvaluationClaim,
): ErasurePolicyEvaluationAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    buildGeneration: claim.buildGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.claimAttempt,
  };
}

function retryAt(failedAtMs: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, failedAtMs + delayMs);
}

/**
 * Builds and seals immutable policy evidence for requests already parked at
 * `awaiting_purge_policy`. It has no reference to SessionStore, the lifecycle outbox, BlobStore or
 * an erasure transition API, so even an eligible decision remains non-executable evidence.
 */
export class PurgePolicyEvaluator {
  private readonly opts: Required<PurgePolicyEvaluatorOptions>;
  private readonly clock: { now(): number };
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  /**
   * `stopping` controls timer scheduling and starts true so a constructed worker is idle. Keep the
   * shutdown signal separate: `processOnce()` is also a useful explicit one-shot before `start()`,
   * while a pass that was already scheduled must observe `stop()` at every durable boundary.
   */
  private shutdownRequested = false;

  constructor(
    private readonly deps: PurgePolicyEvaluatorDeps,
    options: PurgePolicyEvaluatorOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(
        options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
        "pollIntervalMs",
      ),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      jobBatchSize: positiveInteger(
        options.jobBatchSize ?? DEFAULTS.jobBatchSize,
        "jobBatchSize",
      ),
      targetPageSize: positiveInteger(
        options.targetPageSize ?? DEFAULTS.targetPageSize,
        "targetPageSize",
      ),
      retryBaseMs: positiveInteger(
        options.retryBaseMs ?? DEFAULTS.retryBaseMs,
        "retryBaseMs",
      ),
      retryMaxMs: positiveInteger(
        options.retryMaxMs ?? DEFAULTS.retryMaxMs,
        "retryMaxMs",
      ),
    };
    if (this.opts.jobBatchSize > 100) throw new Error("jobBatchSize must not exceed 100");
    if (this.opts.targetPageSize > 1_000) {
      throw new Error("targetPageSize must not exceed the store page limit of 1000");
    }
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    this.clock = deps.clock ?? { now: () => Date.now() };
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

  /** One barrier-protected schedule, claim, evidence-build and seal pass. */
  async processOnce(): Promise<number> {
    if (this.shutdownRequested) return 0;
    try {
      if (!(await this.deps.canClaim())) return 0;
    } catch {
      return 0;
    }
    if (this.shutdownRequested) return 0;

    try {
      await this.deps.store.scheduleAwaitingErasurePolicyEvaluations({
        nowMs: this.clock.now(),
        limit: this.opts.jobBatchSize,
      });
    } catch {
      // A corrupt scheduling candidate must not starve already durable healthy work. The store
      // reports the failed scheduling pass, while this worker keeps the log free of row/error data
      // and proceeds to claim jobs that were queued before (or safely committed during) the pass.
      this.log.warn("[purge-policy-evaluator] scheduling failed");
    }
    if (this.shutdownRequested) return 0;
    const claims = await this.deps.store.claimErasurePolicyEvaluations({
      nowMs: this.clock.now(),
      limit: this.opts.jobBatchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });

    const results = await Promise.all(claims.map(async (claim) => {
      try {
        return await this.evaluateClaim(claim);
      } catch (error) {
        // Backend errors may carry credentials or row content. Keep logs and retry facts bounded.
        this.log.warn("[purge-policy-evaluator] claim failed");
        return await this.retry(
          claim,
          error instanceof ErasurePurgeEvidenceChangedError
            ? "evidence_changed"
            : "temporary_failure",
        );
      }
    }));
    return results.reduce((count, sealed) => count + (sealed ? 1 : 0), 0);
  }

  private async evaluateClaim(claim: ErasurePolicyEvaluationClaim): Promise<boolean> {
    const auth = authorization(claim);
    while (true) {
      // If shutdown raced with the claim, release it through the same request/generation/attempt CAS
      // used for ordinary retries. A failed release is still safe: the lease remains fenced until it
      // expires and the partial immutable evidence/cursor can be resumed by a successor.
      if (this.shutdownRequested) return this.retry(claim);
      if (!await this.deps.store.renewErasurePolicyEvaluation(auth, {
        nowMs: this.clock.now(),
        leaseMs: this.opts.leaseMs,
      })) return false;
      if (this.shutdownRequested) return this.retry(claim);

      const page = await this.deps.store.buildErasurePurgeTargetPage(auth, {
        nowMs: this.clock.now(),
        limit: this.opts.targetPageSize,
      });
      // A page is the smallest store-atomic unit. Stop before starting another page or sealing so
      // runner shutdown is bounded by at most one page per claimed job.
      if (this.shutdownRequested) return this.retry(claim);
      if (!page.done) {
        // A non-progressing page would otherwise pin one claim forever. Retry through the durable
        // queue and let the store revalidate the same request-bound authority on the next attempt.
        if (page.built === 0) throw new Error("policy evidence page made no progress");
        continue;
      }

      if (!await this.deps.store.renewErasurePolicyEvaluation(auth, {
        nowMs: this.clock.now(),
        leaseMs: this.opts.leaseMs,
      })) return false;
      if (this.shutdownRequested) return this.retry(claim);
      await this.deps.store.sealErasurePurgeAuthority(auth, { nowMs: this.clock.now() });
      return true;
    }
  }

  private async retry(
    claim: ErasurePolicyEvaluationClaim,
    errorCode: ErasurePolicyEvaluationErrorCode = "temporary_failure",
  ): Promise<boolean> {
    const failedAtMs = this.clock.now();
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    await this.deps.store.retryErasurePolicyEvaluation(authorization(claim), {
      failedAtMs,
      availableAtMs: retryAt(failedAtMs, delayMs),
      errorCode,
    });
    return false;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      this.inFlight = run;
      void run
        .catch(() => {
          this.log.warn("[purge-policy-evaluator] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
