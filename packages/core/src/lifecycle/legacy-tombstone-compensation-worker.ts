import { randomUUID } from "node:crypto";
import {
  LEGACY_TOMBSTONE_CUTOVER_ID,
  LegacyTombstoneChildPendingError,
  type LegacyTombstoneCompensationAuthorization,
  type LegacyTombstoneCompensationClaim,
  type LegacyTombstoneCompensationStore,
  type LegacyTombstoneRetryErrorCode,
} from "@agent-service/store";

export interface LegacyTombstoneCompensationWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  actorKeyId?: string;
}

export interface LegacyTombstoneCompensationWorkerDeps {
  store: LegacyTombstoneCompensationStore;
  /** V2 fleet-wide rollout barrier. False or unavailable means no cutover, schedule, or claim. */
  canClaim: () => Promise<boolean>;
  clock?: { now(): number };
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 10,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  actorKeyId: "system-legacy-tombstone-worker",
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(claim: LegacyTombstoneCompensationClaim): LegacyTombstoneCompensationAuthorization {
  return {
    jobId: claim.jobId,
    tenantId: claim.tenantId,
    userId: claim.userId,
    sessionId: claim.sessionId,
    cutoverGeneration: claim.cutoverGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function retryAt(failedAtMs: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, failedAtMs + delayMs);
}

/**
 * Converts pre-0009 generation-zero tombstones into the same event/outbox proof created by the
 * current lifecycle path. The store owns the complete transaction; this worker owns only bounded
 * scheduling, lease liveness and retry timing. It cannot make purge claimable or delete content.
 */
export class LegacyTombstoneCompensationWorker {
  private readonly opts: Required<LegacyTombstoneCompensationWorkerOptions>;
  private readonly clock: { now(): number };
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;

  constructor(
    private readonly deps: LegacyTombstoneCompensationWorkerDeps,
    options: LegacyTombstoneCompensationWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
      actorKeyId: options.actorKeyId ?? DEFAULTS.actorKeyId,
    };
    if (this.opts.batchSize > 100) throw new Error("batchSize must not exceed 100");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.opts.actorKeyId)) {
      throw new Error("actorKeyId must contain 1 to 64 safe characters");
    }
    this.clock = deps.clock ?? { now: () => Date.now() };
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

  /** One explicit barrier, cutover, scheduling and claim pass. */
  async processOnce(): Promise<number> {
    try {
      if (!(await this.deps.canClaim())) return 0;
    } catch {
      return 0;
    }

    await this.ensureCutover();
    const scheduleAtMs = this.clock.now();
    await this.deps.store.scheduleLegacyTombstoneCandidates({
      cutoverGeneration: 1,
      actorKeyId: this.opts.actorKeyId,
      nowMs: scheduleAtMs,
      limit: this.opts.batchSize,
    });

    const claims = await this.deps.store.claimLegacyTombstoneCompensations({
      nowMs: this.clock.now(),
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    const results = await Promise.all(claims.map(async (claim) => {
      try {
        return await this.completeClaim(claim);
      } catch {
        // A database/transport error may contain a credential-bearing URL. Never persist or log it.
        this.log.warn("[legacy-tombstone-compensation] claim failed");
        return false;
      }
    }));
    return results.reduce((count, completed) => count + (completed ? 1 : 0), 0);
  }

  private async ensureCutover(): Promise<void> {
    if (await this.deps.store.getLegacyTombstoneCutover()) return;
    try {
      await this.deps.store.activateLegacyTombstoneCutover({
        cutoverId: LEGACY_TOMBSTONE_CUTOVER_ID,
        expectedGeneration: 0,
        actorKeyId: this.opts.actorKeyId,
        atMs: this.clock.now(),
      });
    } catch (error) {
      // Concurrent activation and commit-response loss are both safe only if a durable reread sees
      // the append-only generation-one cutover. Otherwise preserve the original retryable failure.
      if (!(await this.deps.store.getLegacyTombstoneCutover())) throw error;
    }
  }

  private async completeClaim(claim: LegacyTombstoneCompensationClaim): Promise<boolean> {
    const auth = authorization(claim);
    const renewed = await this.deps.store.renewLegacyTombstoneCompensation(auth, {
      nowMs: this.clock.now(),
      leaseMs: this.opts.leaseMs,
    });
    if (!renewed) return false;
    try {
      const result = await this.deps.store.completeLegacyTombstoneCompensation(auth, {
        completedAtMs: this.clock.now(),
      });
      return result !== null;
    } catch (error) {
      const errorCode: LegacyTombstoneRetryErrorCode = error instanceof LegacyTombstoneChildPendingError
        ? "child_pending"
        : "temporary_failure";
      return await this.retry(auth, claim.attempts, errorCode);
    }
  }

  private async retry(
    auth: LegacyTombstoneCompensationAuthorization,
    attempts: number,
    errorCode: LegacyTombstoneRetryErrorCode,
  ): Promise<boolean> {
    const failedAtMs = this.clock.now();
    const exponent = Math.min(30, Math.max(0, attempts - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    await this.deps.store.retryLegacyTombstoneCompensation(auth, {
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
          this.log.warn("[legacy-tombstone-compensation] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
