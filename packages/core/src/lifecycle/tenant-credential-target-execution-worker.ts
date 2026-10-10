import { randomUUID } from "node:crypto";
import {
  TenantErasureIntegrityError,
  validateTenantCredentialTargetExecutionAdapterInput,
  validateTenantCredentialTargetExecutionAdapterResult,
  validateTenantCredentialTargetExecutionClaim,
  validateTenantCredentialTargetExecutionTarget,
  type TenantCredentialTargetExecutionAdapter,
  type TenantCredentialTargetExecutionAdapterInput,
  type TenantCredentialTargetExecutionAdapterResult,
  type TenantCredentialTargetExecutionAuthorization,
  type TenantCredentialTargetExecutionClaim,
  type TenantCredentialTargetExecutionStore,
  type TenantCredentialTargetExecutionTarget,
} from "@agent-service/store";

export class TenantCredentialTargetExecutionAdapterTemporaryError extends Error {
  constructor() {
    super("tenant credential target execution adapter temporarily unavailable");
    this.name = "TenantCredentialTargetExecutionAdapterTemporaryError";
  }
}

export class TenantCredentialTargetExecutionAdapterPermanentError extends Error {
  constructor() {
    super("tenant credential target execution adapter permanently rejected the operation");
    this.name = "TenantCredentialTargetExecutionAdapterPermanentError";
  }
}

export class TenantCredentialTargetExecutionAdapterConflictError extends Error {
  constructor() {
    super("tenant credential target execution adapter operation conflict");
    this.name = "TenantCredentialTargetExecutionAdapterConflictError";
  }
}

class TenantCredentialTargetExecutionWorkerIntegrityError extends Error {
  constructor() {
    super("tenant credential target execution worker integrity conflict");
    this.name = "TenantCredentialTargetExecutionWorkerIntegrityError";
  }
}

export interface TenantCredentialTargetExecutionWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  materializeBatchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantCredentialTargetExecutionWorkerDeps {
  store: TenantCredentialTargetExecutionStore;
  adapter: TenantCredentialTargetExecutionAdapter;
  /** One fresh, non-sticky fleet proof authorizes only the immediately following boundary. */
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
  claim: TenantCredentialTargetExecutionClaim,
): TenantCredentialTargetExecutionAuthorization {
  return {
    requestId: claim.requestId,
    tenantId: claim.tenantId,
    subjectGeneration: claim.subjectGeneration,
    targetExecutionGeneration: claim.targetExecutionGeneration,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function blocksExecution(error: unknown): boolean {
  return error instanceof TenantErasureIntegrityError
    || error instanceof TenantCredentialTargetExecutionWorkerIntegrityError
    || error instanceof TenantCredentialTargetExecutionAdapterPermanentError
    || error instanceof TenantCredentialTargetExecutionAdapterConflictError;
}

/**
 * Executes only the externally revocable credential target slice. The store owns lease/fencing,
 * target/reference correlation, ACK construction, terminal sealing, and all transactional checks.
 */
export class TenantCredentialTargetExecutionWorker {
  private readonly opts: Required<TenantCredentialTargetExecutionWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<number>;
  private stopping = true;
  private shutdownRequested = false;

  constructor(
    private readonly deps: TenantCredentialTargetExecutionWorkerDeps,
    options: TenantCredentialTargetExecutionWorkerOptions = {},
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
      throw new Error("tenant credential target execution batch sizes must not exceed 100");
    }
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    if (deps.adapter.domain !== "external_credential") {
      throw new Error("tenant credential target execution adapter domain is unsupported");
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
    await this.deps.adapter.close().catch(() => {});
  }

  async processOnce(): Promise<number> {
    if (!await this.boundaryAllowed()) return 0;
    try {
      await this.deps.store.materializeTenantCredentialTargetExecutionJobs({
        limit: this.opts.materializeBatchSize,
      });
    } catch {
      this.log.warn("[tenant-credential-target-execution-worker] materialization failed");
    }

    if (!await this.boundaryAllowed()) return 0;
    const claims = await this.deps.store.claimTenantCredentialTargetExecutions({
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken: randomUUID(),
    });

    let completed = 0;
    for (const claim of claims) {
      try {
        validateTenantCredentialTargetExecutionClaim(claim);
        if (await this.advance(claim)) completed += 1;
      } catch (error) {
        // Adapter/provider/store errors may contain secret material or remote references.
        this.log.warn("[tenant-credential-target-execution-worker] claim failed");
        if (blocksExecution(error)) {
          if (await this.boundaryAllowed()) {
            await this.deps.store.blockTenantCredentialTargetExecution(
              authorization(claim),
              "integrity_conflict",
            ).catch(() => false);
          }
          continue;
        }
        await this.retry(claim, "temporary_failure").catch(() => false);
      }
    }
    return completed;
  }

  private async advance(claim: TenantCredentialTargetExecutionClaim): Promise<boolean> {
    const auth = authorization(claim);
    if (!await this.renewAfterFreshGate(auth)) return false;

    if (!await this.boundaryAllowed()) {
      await this.retry(claim, "temporary_failure");
      return false;
    }
    const targets = (await this.deps.store.getTenantCredentialTargetExecutionTargets(
      claim.tenantId,
      claim.requestId,
      claim.targetExecutionGeneration,
    )).sort((left, right) => left.targetOrdinal - right.targetOrdinal);
    this.assertTargetSet(claim, targets);

    if (!await this.boundaryAllowed()) {
      await this.retry(claim, "temporary_failure");
      return false;
    }
    const existingAcks = await this.deps.store.getTenantCredentialTargetExecutionTargetAcks(
      claim.tenantId,
      claim.requestId,
      claim.targetExecutionGeneration,
    );
    const ackedOrdinals = new Set(existingAcks.map((ack) => ack.targetOrdinal));

    for (const target of targets) {
      if (ackedOrdinals.has(target.targetOrdinal)) continue;
      if (!await this.renewAfterFreshGate(auth)) return false;

      if (!await this.boundaryAllowed()) return false;
      const reference = await this.deps.store.getTenantCredentialTargetExecutionReference(
        auth,
        target.targetOrdinal,
      );
      if (!reference) throw new TenantCredentialTargetExecutionWorkerIntegrityError();
      const input = { target, reference } satisfies TenantCredentialTargetExecutionAdapterInput;
      this.assertAdapterInput(input);

      const inspected = await this.inspectAfterFreshGate(auth, input);
      const result = inspected ?? await this.applyWithResponseLossInspection(auth, input);
      this.assertAdapterResult(target, result);

      if (!await this.renewAfterFreshGate(auth)) return false;
      await this.recordAckWithResponseLossInspection(auth, input, result);
    }

    if (!await this.boundaryAllowed()) return false;
    const finalAcks = await this.deps.store.getTenantCredentialTargetExecutionTargetAcks(
      claim.tenantId,
      claim.requestId,
      claim.targetExecutionGeneration,
    );
    if (finalAcks.length !== targets.length) {
      await this.retry(claim, "dependency_pending");
      return false;
    }

    if (!await this.renewAfterFreshGate(auth)) return false;
    return this.sealWithResponseLossReplay(auth);
  }

  private assertTargetSet(
    claim: TenantCredentialTargetExecutionClaim,
    targets: readonly TenantCredentialTargetExecutionTarget[],
  ): void {
    try {
      if (targets.length !== claim.targetCount) throw new Error("target count mismatch");
      for (const [ordinal, target] of [...targets]
        .sort((left, right) => left.targetOrdinal - right.targetOrdinal).entries()) {
        validateTenantCredentialTargetExecutionTarget(target);
        if (target.targetOrdinal !== ordinal
          || target.requestId !== claim.requestId
          || target.tenantId !== claim.tenantId
          || target.subjectGeneration !== claim.subjectGeneration
          || target.targetExecutionGeneration !== claim.targetExecutionGeneration
          || target.adapterProtocol !== this.deps.adapter.adapterProtocol
          || target.domain !== this.deps.adapter.domain) {
          throw new Error("target identity mismatch");
        }
      }
    } catch {
      throw new TenantCredentialTargetExecutionWorkerIntegrityError();
    }
  }

  private assertAdapterInput(input: TenantCredentialTargetExecutionAdapterInput): void {
    try {
      validateTenantCredentialTargetExecutionAdapterInput(input);
    } catch {
      throw new TenantCredentialTargetExecutionWorkerIntegrityError();
    }
  }

  private assertAdapterResult(
    target: TenantCredentialTargetExecutionTarget,
    result: TenantCredentialTargetExecutionAdapterResult,
  ): void {
    try {
      validateTenantCredentialTargetExecutionAdapterResult(result);
      if (result.adapterProtocol !== target.adapterProtocol
        || result.domain !== target.domain
        || result.operationIdSha256 !== target.operationIdSha256
        || result.targetReferenceSha256 !== target.targetReferenceSha256) {
        throw new Error("adapter result identity mismatch");
      }
    } catch {
      throw new TenantCredentialTargetExecutionWorkerIntegrityError();
    }
  }

  private async inspectAfterFreshGate(
    auth: TenantCredentialTargetExecutionAuthorization,
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult | null> {
    // The router proof may consume most of a lease. Renew only after that fresh proof so the
    // immediately following provider read never starts under a stale claim.
    if (!await this.renewAfterFreshGate(auth)) {
      throw new TenantCredentialTargetExecutionAdapterTemporaryError();
    }
    const result = await this.deps.adapter.inspectTarget(input);
    if (result) this.assertAdapterResult(input.target, result);
    return result;
  }

  private async applyWithResponseLossInspection(
    auth: TenantCredentialTargetExecutionAuthorization,
    input: TenantCredentialTargetExecutionAdapterInput,
  ): Promise<TenantCredentialTargetExecutionAdapterResult> {
    // Keep the irreversible provider mutation fenced by both a fresh fleet proof and a lease
    // renewed after that proof, in this exact order.
    if (!await this.renewAfterFreshGate(auth)) {
      throw new TenantCredentialTargetExecutionAdapterTemporaryError();
    }
    try {
      const result = await this.deps.adapter.applyTarget(input);
      this.assertAdapterResult(input.target, result);
      return result;
    } catch (firstError) {
      if (blocksExecution(firstError)) throw firstError;
      // The provider may have committed and lost the response. Never apply twice in this claim;
      // reacquire authority and inspect the immutable operation id instead.
      const replay = await this.inspectAfterFreshGate(auth, input);
      if (replay) return replay;
      throw firstError;
    }
  }

  private async recordAckWithResponseLossInspection(
    auth: TenantCredentialTargetExecutionAuthorization,
    input: TenantCredentialTargetExecutionAdapterInput,
    result: TenantCredentialTargetExecutionAdapterResult,
  ): Promise<void> {
    if (!await this.boundaryAllowed()) {
      throw new TenantCredentialTargetExecutionAdapterTemporaryError();
    }
    try {
      const ack = await this.deps.store.recordTenantCredentialTargetExecutionTargetAck(auth, result);
      if (!ack) throw new TenantCredentialTargetExecutionAdapterTemporaryError();
    } catch (firstError) {
      if (blocksExecution(firstError)) throw firstError;
      const replay = await this.inspectAfterFreshGate(auth, input);
      if (!replay) throw firstError;
      if (!await this.boundaryAllowed()) throw firstError;
      const ack = await this.deps.store.recordTenantCredentialTargetExecutionTargetAck(auth, replay);
      if (!ack) throw firstError;
    }
  }

  private async sealWithResponseLossReplay(
    auth: TenantCredentialTargetExecutionAuthorization,
  ): Promise<boolean> {
    if (!await this.boundaryAllowed()) return false;
    try {
      return (await this.deps.store.sealTenantCredentialTargetExecution(auth)) !== null;
    } catch (firstError) {
      if (blocksExecution(firstError)) throw firstError;
      if (!await this.boundaryAllowed()) throw firstError;
      try {
        const replay = await this.deps.store.sealTenantCredentialTargetExecution(auth);
        if (replay) return true;
      } catch (replayError) {
        if (blocksExecution(replayError)) throw replayError;
      }
      throw firstError;
    }
  }

  private async renewAfterFreshGate(
    auth: TenantCredentialTargetExecutionAuthorization,
  ): Promise<boolean> {
    if (!await this.boundaryAllowed()) return false;
    return this.deps.store.renewTenantCredentialTargetExecution(auth, {
      leaseMs: this.opts.leaseMs,
    });
  }

  private async retry(
    claim: TenantCredentialTargetExecutionClaim,
    errorCode: "temporary_failure" | "dependency_pending",
  ): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantCredentialTargetExecution(authorization(claim), {
      delayMs,
      errorCode,
    });
  }

  private async boundaryAllowed(): Promise<boolean> {
    if (this.shutdownRequested) return false;
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
        .catch(() => this.log.warn("[tenant-credential-target-execution-worker] polling failed"))
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
