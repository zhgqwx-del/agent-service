import { randomUUID } from "node:crypto";
import {
  RedisPurgeOperationConflictError,
  RedisPurgeStateCorruptError,
  TenantErasureIntegrityError,
  TenantRedisPurgeEvidenceChangedError,
  TenantRedisPurgeNotReadyError,
  validateTenantRedisPurgeAdapterResult,
  type TenantRedisPurgeAdapter,
  type TenantRedisPurgeAuthorization,
  type TenantRedisPurgeClaim,
  type TenantRedisPurgeDurableMarker,
  type TenantRedisPurgeReceipt,
  type TenantRedisPurgeRestoreFence,
  type TenantRedisPurgeStore,
  type TenantRedisPurgeTarget,
  type TenantRedisPurgeTargetAck,
} from "@agent-service/store";

export interface TenantRedisPurgeWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  targetPageSize?: number;
  restorePageSize?: number;
  restoreIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantRedisPurgeWorkerDeps {
  /** Narrow T3g evidence store; it cannot promote tenant-erasure completion. */
  store: TenantRedisPurgeStore;
  /** The only component allowed to mutate the three session-scoped Redis domains. */
  adapter: TenantRedisPurgeAdapter;
  /** One fresh all-configured-fleet proof authorizes only the immediately following boundary. */
  canExecute: () => Promise<boolean>;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 5,
  materializeBatchSize: 25,
  targetPageSize: 100,
  restorePageSize: 100,
  restoreIntervalMs: 60_000,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(claim: TenantRedisPurgeClaim): TenantRedisPurgeAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    planBuildGeneration: claim.planBuildGeneration,
    executionGeneration: claim.executionGeneration,
    databasePurgeGeneration: claim.databasePurgeGeneration,
    redisPurgeGeneration: claim.redisPurgeGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksExecution(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantRedisPurgeEvidenceChangedError
    || error instanceof RedisPurgeOperationConflictError
    || error instanceof RedisPurgeStateCorruptError;
}

function markerFromFence(fence: TenantRedisPurgeRestoreFence): TenantRedisPurgeDurableMarker {
  return {
    adapterProtocol: fence.adapterProtocol,
    redisNamespaceSha256: fence.redisNamespaceSha256,
    sessionId: fence.sessionId,
    operationSha256: fence.operationSha256,
    leaseExisted: fence.leaseExisted,
    fenceExisted: fence.fenceExisted,
    streamExisted: fence.streamExisted,
    markerSha256: fence.markerSha256,
  };
}

function assertExactMarker(
  result: Awaited<ReturnType<TenantRedisPurgeAdapter["restoreSessionPurgeFence"]>>,
  expected: TenantRedisPurgeDurableMarker,
): void {
  try {
    validateTenantRedisPurgeAdapterResult(result);
  } catch {
    throw new TenantRedisPurgeEvidenceChangedError();
  }
  if (result.adapterProtocol !== expected.adapterProtocol
    || result.redisNamespaceSha256 !== expected.redisNamespaceSha256
    || result.sessionId !== expected.sessionId
    || result.operationSha256 !== expected.operationSha256
    || result.leaseExisted !== expected.leaseExisted
    || result.fenceExisted !== expected.fenceExisted
    || result.streamExisted !== expected.streamExisted
    || result.markerSha256 !== expected.markerSha256) {
    throw new TenantRedisPurgeEvidenceChangedError();
  }
}

/**
 * Advances only the T3g Redis lease/fence/stream slice. Materializing new work and every new Redis
 * mutation require a fresh non-sticky fleet proof. Atomically replaying an exact existing marker,
 * persisting its durable ACK, and sealing already-complete work deliberately do not: disabling the
 * destructive gate must not strand a marker-only saga window. Durable restore fences likewise replay
 * already-authorized immutable markers without a router gate and must succeed before a runner is
 * allowed to accept traffic after Redis loss/restore.
 */
export class TenantRedisPurgeWorker {
  private readonly opts: Required<TenantRedisPurgeWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;
  private lastRestoreReplayAtMs?: number;

  constructor(
    private readonly deps: TenantRedisPurgeWorkerDeps,
    options: TenantRedisPurgeWorkerOptions = {},
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
      targetPageSize: positiveInteger(
        options.targetPageSize ?? DEFAULTS.targetPageSize,
        "targetPageSize",
      ),
      restorePageSize: positiveInteger(
        options.restorePageSize ?? DEFAULTS.restorePageSize,
        "restorePageSize",
      ),
      restoreIntervalMs: positiveInteger(
        options.restoreIntervalMs ?? DEFAULTS.restoreIntervalMs,
        "restoreIntervalMs",
      ),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100 || this.opts.materializeBatchSize > 100) {
      throw new Error("tenant Redis purge batch sizes must not exceed 100");
    }
    if (this.opts.targetPageSize > 1_000 || this.opts.restorePageSize > 1_000) {
      throw new Error("tenant Redis purge page sizes must not exceed 1000");
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

  /**
   * Rehydrates every exact durable marker, including partial queued/blocked work, and removes any
   * restored live state. This deliberately has no router gate: it repeats already-published
   * immutable authority and throws on any unavailable, mismatched or corrupt Redis state so
   * callers can fail startup closed.
   */
  async replayDurableRestoreFences(): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (this.shutdownRequested) return count;
      const page = await this.deps.store.listTenantRedisPurgeRestoreFences({
        limit: this.opts.restorePageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const fence of page.fences) {
        if (this.shutdownRequested) return count;
        if (this.deps.adapter.redisNamespaceSha256 !== fence.redisNamespaceSha256) {
          throw new TenantRedisPurgeEvidenceChangedError();
        }
        const expected = markerFromFence(fence);
        const result = await this.deps.adapter.restoreSessionPurgeFence(expected);
        assertExactMarker(result, expected);
        count += 1;
      }
      if (page.nextCursor === undefined) break;
      if (page.fences.length === 0 || seenCursors.has(page.nextCursor)) {
        throw new TenantErasureIntegrityError();
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (true);
    this.lastRestoreReplayAtMs = Date.now();
    return count;
  }

  async processOnce(): Promise<number> {
    if (this.shutdownRequested) return 0;
    // A failed due restore replay blocks new destructive work as well as startup readiness. The
    // independent startup call remains full and fail-closed, while polling avoids a full scan on
    // every short queue interval.
    if (this.lastRestoreReplayAtMs === undefined
      || Date.now() - this.lastRestoreReplayAtMs >= this.opts.restoreIntervalMs) {
      await this.replayDurableRestoreFences();
    }
    if (!this.shutdownRequested && await this.freshGate()) {
      try {
        await this.deps.store.materializeTenantRedisPurgeJobs({
          limit: this.opts.materializeBatchSize,
        });
      } catch {
        this.log.warn("[tenant-redis-purge-worker] materialization failed");
      }
    }
    if (this.shutdownRequested) return 0;

    // Claim even while destructive execution is disabled. An earlier authorized Redis script may
    // have committed its marker before the process could durably ACK it; that saga must remain
    // recoverable without reopening permission for a new delete.
    const claims = await this.deps.store.claimTenantRedisPurges({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });
    let completed = 0;
    for (const claim of claims) {
      if (this.shutdownRequested) {
        await this.retry(claim, "temporary_failure").catch(() => false);
        continue;
      }
      try {
        if (await this.advance(claim)) completed += 1;
      } catch (error) {
        this.log.warn("[tenant-redis-purge-worker] claim failed");
        if (blocksExecution(error)) {
          await this.deps.store.blockTenantRedisPurge(
            authorization(claim),
            "integrity_conflict",
          ).catch(() => false);
          continue;
        }
        const code = error instanceof TenantRedisPurgeNotReadyError
          ? "dependency_pending" as const
          : "temporary_failure" as const;
        await this.retry(claim, code).catch(() => false);
      }
    }
    return completed;
  }

  private async advance(claim: TenantRedisPurgeClaim): Promise<boolean> {
    const auth = authorization(claim);
    if (!await this.renewClaim(auth)) return false;
    const [targets, priorAcks] = await Promise.all([
      this.deps.store.getTenantRedisPurgeTargets(
        claim.tenantId,
        claim.requestId,
        claim.redisPurgeGeneration,
      ),
      this.deps.store.getTenantRedisPurgeTargetAcks(
        claim.tenantId,
        claim.requestId,
        claim.redisPurgeGeneration,
      ),
    ]);
    const ackedOrdinals = new Set(priorAcks.map((ack) => ack.targetOrdinal));
    const pending = targets
      .filter((target) => !ackedOrdinals.has(target.targetOrdinal))
      .slice(0, this.opts.targetPageSize);
    for (const target of pending) {
      if (!await this.applyAndRecordTarget(auth, target)) {
        await this.retry(claim, "temporary_failure").catch(() => false);
        return false;
      }
    }
    const currentAcks = await this.deps.store.getTenantRedisPurgeTargetAcks(
      claim.tenantId,
      claim.requestId,
      claim.redisPurgeGeneration,
    );
    if (currentAcks.length !== targets.length) {
      await this.retry(claim, "dependency_pending");
      return false;
    }
    if (this.shutdownRequested || !await this.renewClaim(auth)) return false;
    return (await this.sealWithResponseLossReplay(auth)) !== null;
  }

  private async applyAndRecordTarget(
    auth: TenantRedisPurgeAuthorization,
    target: TenantRedisPurgeTarget,
  ): Promise<boolean> {
    if (this.deps.adapter.redisNamespaceSha256 !== target.redisNamespaceSha256) {
      throw new TenantRedisPurgeEvidenceChangedError();
    }
    const existingReplay = await this.replayExistingTarget(target);
    if (existingReplay) {
      if (!await this.renewClaim(auth, true)) return false;
      return (await this.recordWithResponseLossReplay(auth, existingReplay)) !== null;
    }
    if (!await this.authorizeDestructiveMutation(auth)) return false;
    const result = await this.applyWithResponseLossReplay(auth, target);
    // Once Redis has returned success, graceful shutdown must drain through the first durable ACK
    // attempt. Otherwise a normal SIGTERM can manufacture the same volatile marker-only window as
    // a hard crash. Renewing the already-issued claim and recording its immutable marker do not
    // authorize another destructive Redis operation and therefore do not require a fleet proof.
    if (!await this.renewClaim(auth, true)) return false;
    return (await this.recordWithResponseLossReplay(auth, result)) !== null;
  }

  private async applyWithResponseLossReplay(
    auth: TenantRedisPurgeAuthorization,
    target: TenantRedisPurgeTarget,
  ) {
    const input = { sessionId: target.sessionId, operationSha256: target.operationSha256 };
    try {
      const result = await this.deps.adapter.purgeSessionState(input);
      this.assertTargetResult(target, result);
      return result;
    } catch (firstError) {
      if (blocksExecution(firstError)) throw firstError;
      const recovered = await this.replayExistingTarget(target);
      if (recovered) return recovered;
      if (!await this.authorizeDestructiveMutation(auth)) throw firstError;
      try {
        const replay = await this.deps.adapter.purgeSessionState(input);
        this.assertTargetResult(target, replay);
        return replay;
      } catch (replayError) {
        if (blocksExecution(replayError)) throw replayError;
        const recoveredReplay = await this.replayExistingTarget(target);
        if (recoveredReplay) return recoveredReplay;
      }
      throw firstError;
    }
  }

  private async replayExistingTarget(
    target: TenantRedisPurgeTarget,
  ): Promise<Awaited<ReturnType<TenantRedisPurgeAdapter["replayExistingSessionPurge"]>>> {
    const result = await this.deps.adapter.replayExistingSessionPurge({
      sessionId: target.sessionId,
      operationSha256: target.operationSha256,
    });
    if (result) this.assertTargetResult(target, result);
    return result;
  }

  private assertTargetResult(
    target: TenantRedisPurgeTarget,
    result: Awaited<ReturnType<TenantRedisPurgeAdapter["purgeSessionState"]>>,
  ): void {
    try {
      validateTenantRedisPurgeAdapterResult(result);
    } catch {
      throw new TenantRedisPurgeEvidenceChangedError();
    }
    if (result.sessionId !== target.sessionId
      || result.operationSha256 !== target.operationSha256
      || result.redisNamespaceSha256 !== target.redisNamespaceSha256) {
      throw new TenantRedisPurgeEvidenceChangedError();
    }
  }

  private async recordWithResponseLossReplay(
    auth: TenantRedisPurgeAuthorization,
    result: Awaited<ReturnType<TenantRedisPurgeAdapter["purgeSessionState"]>>,
  ): Promise<TenantRedisPurgeTargetAck | null> {
    try {
      return await this.deps.store.recordTenantRedisPurgeTargetAck(auth, result);
    } catch (firstError) {
      if (blocksExecution(firstError) || firstError instanceof TenantRedisPurgeNotReadyError) {
        throw firstError;
      }
      // The Redis marker already exists. Keep its evidence durable even when operators close the
      // destructive gate between the Lua commit and this ACK (or while shutdown is draining).
      if (!await this.renewClaim(auth, true)) throw firstError;
      try {
        const replay = await this.deps.store.recordTenantRedisPurgeTargetAck(auth, result);
        if (replay) return replay;
      } catch (replayError) {
        if (blocksExecution(replayError)
          || replayError instanceof TenantRedisPurgeNotReadyError) throw replayError;
      }
      throw firstError;
    }
  }

  private async sealWithResponseLossReplay(
    auth: TenantRedisPurgeAuthorization,
  ): Promise<TenantRedisPurgeReceipt | null> {
    try {
      return await this.deps.store.sealTenantRedisPurge(auth);
    } catch (firstError) {
      if (blocksExecution(firstError) || firstError instanceof TenantRedisPurgeNotReadyError) {
        throw firstError;
      }
      // An ambiguous first seal may already have committed the terminal row. The store permits
      // only an exact same-claim response replay, so no new destructive fleet authority is needed.
      try {
        const replay = await this.deps.store.sealTenantRedisPurge(auth);
        if (replay) return replay;
      } catch (replayError) {
        if (blocksExecution(replayError)
          || replayError instanceof TenantRedisPurgeNotReadyError) throw replayError;
      }
      throw firstError;
    }
  }

  private async renewClaim(
    auth: TenantRedisPurgeAuthorization,
    allowDuringShutdown = false,
  ): Promise<boolean> {
    if (!allowDuringShutdown && this.shutdownRequested) return false;
    return this.deps.store.renewTenantRedisPurge(auth, { leaseMs: this.opts.leaseMs });
  }

  private async authorizeDestructiveMutation(
    auth: TenantRedisPurgeAuthorization,
  ): Promise<boolean> {
    if (this.shutdownRequested || !await this.freshGate()) return false;
    // Measure from before renewal: the DB computes its new deadline during this call, so this is a
    // conservative upper bound on how much of the renewed lease the remaining proof consumed.
    // Never begin a Redis mutation unless at least half of the configured lease remains available
    // for the operation and its first durable ACK attempt.
    const renewalStartedAt = performance.now();
    if (!await this.renewClaim(auth)) return false;
    // The renewal is a meaningful asynchronous boundary. Re-attest immediately before the Redis
    // mutation rather than treating the first proof as sticky authorization.
    if (this.shutdownRequested || !await this.freshGate()) return false;
    return performance.now() - renewalStartedAt < this.opts.leaseMs / 2;
  }

  private async retry(
    claim: TenantRedisPurgeClaim,
    errorCode: "temporary_failure" | "dependency_pending",
  ): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantRedisPurge(authorization(claim), {
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
          this.log.warn("[tenant-redis-purge-worker] polling failed");
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
