import { randomUUID } from "node:crypto";
import {
  ErasureTombstoneIntegrityError,
  UsageIdentityConflictError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
} from "@agent-service/store";
import type {
  ClaimableErasureRequestStatus,
  ErasureJobAuthorization,
  ErasureJobClaim,
  ErasureJobErrorCode,
  ErasureJobStore,
  ErasureSessionCatalogStore,
  ErasureSessionPage,
  ErasureUsageReconciliationStore,
  ErasureWriteAuthorization,
} from "@agent-service/store";

export type ErasureSessionExecutionFailureCode =
  | "owner_unavailable"
  | "drain_timeout"
  | "temporary_failure";

/**
 * A content-free, bounded failure that an executor may use when composing a local SessionHost with
 * a future router-mediated remote drain. Arbitrary thrown errors are deliberately collapsed to
 * `temporary_failure` by the worker and are never persisted or logged.
 */
export class ErasureSessionExecutionError extends Error {
  override readonly name = "ErasureSessionExecutionError";

  constructor(public readonly code: ErasureSessionExecutionFailureCode) {
    super(`erasure session execution failed: ${code}`);
  }
}

/** The only session mutation authority held by the orchestration worker. */
export interface ErasureSessionExecutor {
  drainSessionForErasure(authority: ErasureWriteAuthorization, sessionId: string): Promise<void>;
  eraseSessionForErasure(authority: ErasureWriteAuthorization, sessionId: string): Promise<void>;
}

export interface ErasureWorkerClock {
  now(): number;
}

export interface ErasureWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  jobBatchSize?: number;
  sessionPageSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface ErasureWorkerDeps {
  jobs: ErasureJobStore;
  catalog: ErasureSessionCatalogStore;
  usage: ErasureUsageReconciliationStore;
  executor: ErasureSessionExecutor;
  clock?: ErasureWorkerClock;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  jobBatchSize: 10,
  sessionPageSize: 100,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

const CLAIM_LOST = Symbol("erasure claim lost");
const RUN_STOPPED = Symbol("erasure worker run stopped");

interface ScheduledRun {
  controller: AbortController;
  promise: Promise<number>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function jobAuthorization(claim: ErasureJobClaim): ErasureJobAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectKind: claim.subjectKind,
    subjectId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function writeAuthorization(claim: ErasureJobClaim): ErasureWriteAuthorization | undefined {
  if (claim.subjectKind !== "user") return undefined;
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    userId: claim.subjectId,
    subjectGeneration: claim.subjectGeneration,
    claimToken: claim.claimToken,
    claimAttempt: claim.attempts,
  };
}

function executionFailureCode(error: unknown): ErasureSessionExecutionFailureCode {
  if (error instanceof ErasureSessionExecutionError) return error.code;
  let code: unknown;
  try {
    code = typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  } catch {
    return "temporary_failure";
  }
  // These two codes let a local SessionHost be injected directly without teaching this worker
  // about API errors. A future remote coordinator should normalize to the public bounded codes.
  if (code === "owner_unavailable" || code === "session_lease_conflict") {
    return "owner_unavailable";
  }
  if (code === "drain_timeout" || code === "session_busy") return "drain_timeout";
  return "temporary_failure";
}

/**
 * Store failures whose type proves durable usage/tombstone state is inconsistent. These must stop
 * automatic retries: retrying the same claim cannot repair the conflicting facts and would hide a
 * policy/integrity incident behind an endless `temporary_failure` loop.
 */
function isErasureUsageIntegrityConflict(error: unknown): boolean {
  return error instanceof ErasureTombstoneIntegrityError
    || error instanceof UsageIdentityConflictError
    || error instanceof UsageLifecycleGenerationError
    || error instanceof UsageReconciliationError;
}

function safeRetryAt(failedAtMs: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, failedAtMs + delayMs);
}

/**
 * Keeps a claim alive independently of a potentially slow local or remote session operation. A
 * false/failed renewal is a one-way loss of authority; callers then stop without acknowledging the
 * old claim. Every downstream store operation still performs its own claim-and-lease CAS.
 */
class ClaimHeartbeat {
  private timer?: ReturnType<typeof setTimeout>;
  private renewal?: Promise<void>;
  private stopped = false;
  private lost = false;

  constructor(
    private readonly jobs: ErasureJobStore,
    private readonly authority: ErasureJobAuthorization,
    private readonly leaseMs: number,
    private readonly clock: ErasureWorkerClock,
  ) {}

  start(): void {
    this.schedule();
  }

  async current(): Promise<boolean> {
    await this.renewal;
    return !this.lost;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.renewal;
  }

  private schedule(): void {
    if (this.stopped || this.lost) return;
    const delayMs = Math.max(1, Math.floor(this.leaseMs / 3));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const renewal = this.renew();
      this.renewal = renewal;
      void renewal.finally(() => {
        if (this.renewal === renewal) this.renewal = undefined;
        this.schedule();
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.stopped || this.lost) return;
    try {
      const renewed = await this.jobs.renewErasureJobClaim(this.authority, {
        nowMs: this.clock.now(),
        leaseMs: this.leaseMs,
      });
      if (!renewed) this.lost = true;
    } catch {
      // An indeterminate renewal must never be treated as retained authority. The durable lease
      // will expire and another worker can safely resume this idempotent phase from the beginning.
      this.lost = true;
    }
  }
}

/**
 * Claim-bound user-erasure orchestration through the non-destructive M1 boundary. This worker may
 * drain executions, tombstone sessions and reconcile usage, but it cannot anonymize usage,
 * physically purge content, revoke keys, or mark an erasure request completed.
 */
export class ErasureWorker {
  private readonly opts: Required<ErasureWorkerOptions>;
  private readonly clock: ErasureWorkerClock;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: ScheduledRun;
  private stopping = true;

  constructor(private readonly deps: ErasureWorkerDeps, options: ErasureWorkerOptions = {}) {
    this.opts = {
      pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      jobBatchSize: positiveInteger(options.jobBatchSize ?? DEFAULTS.jobBatchSize, "jobBatchSize"),
      sessionPageSize: positiveInteger(
        options.sessionPageSize ?? DEFAULTS.sessionPageSize,
        "sessionPageSize",
      ),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.jobBatchSize > 100) throw new Error("jobBatchSize must not exceed 100");
    if (this.opts.sessionPageSize > 200) throw new Error("sessionPageSize must not exceed 200");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
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
    const inFlight = this.inFlight;
    inFlight?.controller.abort();
    await inFlight?.promise.catch(() => {});
  }

  /**
   * One manually-invoked claim pass. This remains usable without start(); only the scheduler-owned
   * pass is cancelled by stop(), so deterministic maintenance/tests do not inherit process state.
   */
  async processOnce(): Promise<number> {
    return await this.processOnceWithSignal();
  }

  /** One claim pass. Each claim executes exactly its claimed phase and then releases authority. */
  private async processOnceWithSignal(signal?: AbortSignal): Promise<number> {
    const claims = await this.deps.jobs.claimErasureJobs({
      nowMs: this.clock.now(),
      limit: this.opts.jobBatchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    // stop() cannot cancel an in-flight database claim call. Once it returns, leave every claimed
    // row untouched for lease expiry rather than starting work or acknowledging stale authority.
    if (signal?.aborted) return 0;

    // Start every claimed job immediately so no later row spends the first job's potentially slow
    // remote timeout without its own heartbeat. Concurrency is bounded by the store claim limit,
    // which is exactly jobBatchSize (validated to <= 100).
    const results = await Promise.all(claims.map(async (claim) => {
      try {
        return await this.processClaim(claim, signal);
      } catch {
        // A retry/transition store failure for one claim must not strand the rest of the batch.
        // Never log the thrown value: database/transport errors may contain secret-bearing URLs.
        this.log.warn("[erasure-worker] claim failed");
        return false;
      }
    }));
    return results.reduce((count, acknowledged) => count + (acknowledged ? 1 : 0), 0);
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const controller = new AbortController();
      const promise = this.processOnceWithSignal(controller.signal);
      const run = { controller, promise };
      this.inFlight = run;
      void promise
        .catch(() => {
          // Do not include an Error name/message: database and transport failures can contain
          // credential-bearing endpoints. Per-job errors are handled with bounded durable codes.
          this.log.warn("[erasure-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private async processClaim(claim: ErasureJobClaim, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const authority = jobAuthorization(claim);
    const heartbeat = new ClaimHeartbeat(this.deps.jobs, authority, this.opts.leaseMs, this.clock);
    heartbeat.start();
    try {
      const userAuthority = writeAuthorization(claim);
      if (userAuthority === undefined) {
        return await this.block(claim.status, authority, heartbeat, "policy_unavailable", signal);
      }
      switch (claim.status) {
        case "gated":
          return await this.transitionClaimable("gated", "draining", authority, heartbeat, signal);
        case "draining":
          return await this.drain(authority, userAuthority, heartbeat, signal);
        case "tombstoning":
          return await this.tombstone(authority, userAuthority, heartbeat, signal);
        case "reconciling_usage":
          return await this.reconcileUsage(claim, authority, userAuthority, heartbeat, signal);
        case "purging":
          return await this.block("purging", authority, heartbeat, "policy_unavailable", signal);
      }
    } catch (error) {
      if (error === RUN_STOPPED || signal?.aborted || error === CLAIM_LOST) return false;
      if (!(await heartbeat.current()) || signal?.aborted) return false;
      if (isErasureUsageIntegrityConflict(error)) {
        return await this.block(
          claim.status,
          authority,
          heartbeat,
          "integrity_conflict",
          signal,
        );
      }
      return await this.retry(claim, authority, heartbeat, executionFailureCode(error), signal);
    } finally {
      await heartbeat.stop();
    }
  }

  private async drain(
    authority: ErasureJobAuthorization,
    userAuthority: ErasureWriteAuthorization,
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let afterSessionId: string | undefined;
    const seenCursors = new Set<string>();
    do {
      await this.requireCurrent(heartbeat, signal);
      const page = await this.deps.catalog.listErasureSessions(userAuthority, {
        phase: "draining",
        ...(afterSessionId === undefined ? {} : { afterSessionId }),
        limit: this.opts.sessionPageSize,
        nowMs: this.clock.now(),
      });
      await this.requireCurrent(heartbeat, signal);
      if (!this.isAscendingPage(page, afterSessionId)) {
        return await this.block("draining", authority, heartbeat, "integrity_conflict", signal);
      }
      for (const session of page.data) {
        if (session.deleted) continue;
        await this.requireCurrent(heartbeat, signal);
        await this.deps.executor.drainSessionForErasure(userAuthority, session.sessionId);
        await this.requireCurrent(heartbeat, signal);
      }
      afterSessionId = page.nextCursor;
      if (afterSessionId !== undefined) {
        if (seenCursors.has(afterSessionId)) {
          return await this.block("draining", authority, heartbeat, "integrity_conflict", signal);
        }
        seenCursors.add(afterSessionId);
      }
    } while (afterSessionId !== undefined);
    return await this.transitionClaimable("draining", "tombstoning", authority, heartbeat, signal);
  }

  private async tombstone(
    authority: ErasureJobAuthorization,
    userAuthority: ErasureWriteAuthorization,
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let previousBatch = "";
    while (true) {
      await this.requireCurrent(heartbeat, signal);
      const page = await this.deps.catalog.listErasureSessions(userAuthority, {
        phase: "tombstoning",
        limit: this.opts.sessionPageSize,
        nowMs: this.clock.now(),
      });
      await this.requireCurrent(heartbeat, signal);
      if (!this.isAscendingPage(page)) {
        return await this.block("tombstoning", authority, heartbeat, "integrity_conflict", signal);
      }
      if (page.data.length === 0) {
        const progress = await this.inspectProgress(userAuthority, "tombstoning", heartbeat, signal);
        if (progress.liveSessions > 0) {
          return await this.block("tombstoning", authority, heartbeat, "integrity_conflict", signal);
        }
        return await this.transitionClaimable(
          "tombstoning",
          "reconciling_usage",
          authority,
          heartbeat,
          signal,
        );
      }
      if (page.data.some((session) => session.deleted)) {
        return await this.block("tombstoning", authority, heartbeat, "integrity_conflict", signal);
      }
      const batch = page.data.map((session) => session.sessionId).join("\n");
      if (batch === previousBatch) {
        return await this.block("tombstoning", authority, heartbeat, "integrity_conflict", signal);
      }
      previousBatch = batch;
      for (const session of page.data) {
        await this.requireCurrent(heartbeat, signal);
        await this.deps.executor.eraseSessionForErasure(userAuthority, session.sessionId);
        await this.requireCurrent(heartbeat, signal);
      }
    }
  }

  private async reconcileUsage(
    claim: ErasureJobClaim,
    authority: ErasureJobAuthorization,
    userAuthority: ErasureWriteAuthorization,
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let afterSessionId: string | undefined;
    const seenCursors = new Set<string>();
    do {
      await this.requireCurrent(heartbeat, signal);
      const page = await this.deps.catalog.listErasureSessions(userAuthority, {
        phase: "reconciling_usage",
        ...(afterSessionId === undefined ? {} : { afterSessionId }),
        limit: this.opts.sessionPageSize,
        nowMs: this.clock.now(),
      });
      await this.requireCurrent(heartbeat, signal);
      if (!this.isAscendingPage(page, afterSessionId)) {
        return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
      }
      for (const session of page.data) {
        if (!session.deleted) {
          return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
        }
        if (session.deletionGeneration === 0) {
          return await this.block("reconciling_usage", authority, heartbeat, "legacy_blocked", signal);
        }
        if (session.tombstoneProofValid !== true) {
          return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
        }
        await this.requireCurrent(heartbeat, signal);
        const result = await this.deps.usage.reconcileErasureSessionUsage(userAuthority, {
          sessionId: session.sessionId,
          deletionGeneration: session.deletionGeneration,
          nowMs: this.clock.now(),
        });
        await this.requireCurrent(heartbeat, signal);
        if (
          result.tenantId !== claim.tenantId
          || result.userId !== claim.subjectId
          || result.sessionId !== session.sessionId
          || result.deletionGeneration !== session.deletionGeneration
          || (result.status !== "verified" && result.status !== "anonymized")
        ) {
          return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
        }
      }
      afterSessionId = page.nextCursor;
      if (afterSessionId !== undefined) {
        if (seenCursors.has(afterSessionId)) {
          return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
        }
        seenCursors.add(afterSessionId);
      }
    } while (afterSessionId !== undefined);

    const progress = await this.inspectProgress(userAuthority, "reconciling_usage", heartbeat, signal);
    if (progress.legacyGenerationZeroSessions > 0) {
      return await this.block("reconciling_usage", authority, heartbeat, "legacy_blocked", signal);
    }
    if (
      progress.liveSessions > 0
      || progress.orphanOrMismatchedUsageRows > 0
      || progress.unreconciledUsageSessions > 0
    ) {
      return await this.block("reconciling_usage", authority, heartbeat, "integrity_conflict", signal);
    }
    return await this.transitionUnavailable(
      "reconciling_usage",
      "awaiting_purge_policy",
      authority,
      heartbeat,
      signal,
    );
  }

  private async inspectProgress(
    authority: ErasureWriteAuthorization,
    phase: "tombstoning" | "reconciling_usage",
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ) {
    await this.requireCurrent(heartbeat, signal);
    const progress = await this.deps.catalog.inspectErasureSubjectProgress(authority, {
      phase,
      nowMs: this.clock.now(),
    });
    await this.requireCurrent(heartbeat, signal);
    return progress;
  }

  private isAscendingPage(page: ErasureSessionPage, afterSessionId?: string): boolean {
    let previous = afterSessionId;
    for (const session of page.data) {
      if (previous !== undefined && session.sessionId <= previous) return false;
      previous = session.sessionId;
    }
    if (
      page.nextCursor !== undefined
      && (page.data.length === 0 || page.nextCursor !== page.data.at(-1)?.sessionId)
    ) return false;
    return true;
  }

  private async transitionClaimable(
    fromStatus: ClaimableErasureRequestStatus,
    toStatus: ClaimableErasureRequestStatus,
    authority: ErasureJobAuthorization,
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.requireCurrent(heartbeat, signal);
    const atMs = this.clock.now();
    return await this.deps.jobs.transitionErasureJob(authority, {
      fromStatus,
      toStatus,
      atMs,
      availableAtMs: atMs,
    });
  }

  private async transitionUnavailable(
    fromStatus: ClaimableErasureRequestStatus,
    toStatus: "awaiting_purge_policy",
    authority: ErasureJobAuthorization,
    heartbeat: ClaimHeartbeat,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.requireCurrent(heartbeat, signal);
    return await this.deps.jobs.transitionErasureJob(authority, {
      fromStatus,
      toStatus,
      atMs: this.clock.now(),
    });
  }

  private async block(
    fromStatus: ClaimableErasureRequestStatus,
    authority: ErasureJobAuthorization,
    heartbeat: ClaimHeartbeat,
    errorCode: Extract<ErasureJobErrorCode, "integrity_conflict" | "legacy_blocked" | "policy_unavailable">,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.requireCurrent(heartbeat, signal);
    return await this.deps.jobs.transitionErasureJob(authority, {
      fromStatus,
      toStatus: "blocked",
      atMs: this.clock.now(),
      errorCode,
    });
  }

  private async retry(
    claim: ErasureJobClaim,
    authority: ErasureJobAuthorization,
    heartbeat: ClaimHeartbeat,
    errorCode: ErasureSessionExecutionFailureCode,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await this.requireCurrent(heartbeat, signal);
    const failedAtMs = this.clock.now();
    const exponent = Math.min(30, Math.max(0, claim.attempts - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return await this.deps.jobs.retryErasureJob(authority, {
      failedAtMs,
      availableAtMs: safeRetryAt(failedAtMs, delayMs),
      errorCode,
    });
  }

  private async requireCurrent(heartbeat: ClaimHeartbeat, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw RUN_STOPPED;
    if (!(await heartbeat.current())) throw CLAIM_LOST;
    if (signal?.aborted) throw RUN_STOPPED;
  }
}
