import { randomUUID } from "node:crypto";
import {
  TenantTelemetryWriteAdapterConflictError,
  TenantTelemetryWriteAdapterTemporaryError,
  TenantTelemetryWriteConflictError,
  TenantTelemetryWriteIntegrityError,
  assertExactTenantTelemetryWriteAdapterResult,
  validateTenantTelemetryWriteAck,
  validateTenantTelemetryWriteClaim,
  validateTenantTelemetryWriteInspection,
  type TenantTelemetryWriteAdapter,
  type TenantTelemetryWriteAdapterInput,
  type TenantTelemetryWriteAdapterResult,
  type TenantTelemetryWriteAck,
  type TenantTelemetryWriteAuthorization,
  type TenantTelemetryWriteClaim,
  type TenantTelemetryWriterStore,
} from "@agent-service/store";

export interface TenantTelemetryWriterWorkerOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface TenantTelemetryWriterWorkerDeps {
  store: TenantTelemetryWriterStore;
  adapter: TenantTelemetryWriteAdapter;
  logger?: Pick<Console, "warn">;
}

const DEFAULTS = {
  pollIntervalMs: 1_000,
  leaseMs: 30_000,
  batchSize: 25,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function authorization(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAuthorization {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    tenantId: claim.tenantId,
    claimAttempt: claim.claimAttempt,
    claimToken: claim.claimToken,
  };
}

function adapterInput(claim: TenantTelemetryWriteClaim): TenantTelemetryWriteAdapterInput {
  return {
    writeOperationSha256: claim.writeOperationSha256,
    target: claim.target,
    inventory: claim.inventory,
    payload: claim.payload,
  };
}

function blocksWrite(error: unknown): boolean {
  return error instanceof TenantTelemetryWriteAdapterConflictError
    || error instanceof TenantTelemetryWriteConflictError
    || error instanceof TenantTelemetryWriteIntegrityError;
}

function warnWithoutThrow(logger: Pick<Console, "warn">, message: string): void {
  try {
    logger.warn(message);
  } catch {
    // Observability is best-effort and must never change a durable retry/block/shutdown decision.
  }
}

/**
 * Publishes bounded, already-validated telemetry envelopes from the durable DB spool. There is no
 * destructive fleet gate: lease fencing plus immutable remote inspection close create races and
 * response-loss windows. Errors and backend details are never interpolated into process logs.
 */
export class TenantTelemetryWriterWorker {
  private readonly opts: Required<TenantTelemetryWriterWorkerOptions>;
  private readonly log: Pick<Console, "warn">;
  private readonly inFlight = new Set<Promise<number>>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = true;
  private shutdownRequested = false;
  private stopPromise?: Promise<void>;
  private adapterClosed = false;

  constructor(
    private readonly deps: TenantTelemetryWriterWorkerDeps,
    options: TenantTelemetryWriterWorkerOptions = {},
  ) {
    this.opts = {
      pollIntervalMs: positiveInteger(
        options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
        "pollIntervalMs",
      ),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100) {
      throw new Error("tenant telemetry writer batch size must not exceed 100");
    }
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) {
      throw new Error("retryMaxMs must be >= retryBaseMs");
    }
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    if (this.shutdownRequested || this.stopPromise || this.adapterClosed) {
      throw new Error("tenant telemetry writer worker is closed");
    }
    this.stopping = false;
    this.schedule(0);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.shutdownRequested = true;
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  processOnce(): Promise<number> {
    if (this.shutdownRequested) return Promise.resolve(0);
    const run = this.runOnce();
    this.inFlight.add(run);
    void run.then(
      () => this.inFlight.delete(run),
      () => this.inFlight.delete(run),
    );
    return run;
  }

  private async finishStop(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    if (this.adapterClosed) return;
    this.adapterClosed = true;
    try {
      await this.deps.adapter.close();
    } catch {
      warnWithoutThrow(this.log, "[tenant-telemetry-writer-worker] adapter close failed");
    }
  }

  private async runOnce(): Promise<number> {
    let claims: TenantTelemetryWriteClaim[];
    try {
      claims = await this.deps.store.claimTenantTelemetryWriteJobs({
        limit: this.opts.batchSize,
        leaseMs: this.opts.leaseMs,
        claimToken: randomUUID(),
        adapterProtocol: this.deps.adapter.adapterProtocol,
      });
    } catch {
      warnWithoutThrow(this.log, "[tenant-telemetry-writer-worker] claim failed");
      return 0;
    }

    let completed = 0;
    // Once claimed, every item is drained to an ACK/block/retry decision before stop closes the
    // adapter. That prevents shutdown from abandoning an ambiguous external commit.
    for (const claim of claims) {
      try {
        validateTenantTelemetryWriteClaim(claim);
        if (claim.target.adapterProtocol !== this.deps.adapter.adapterProtocol) {
          throw new TenantTelemetryWriteAdapterConflictError();
        }
        if (await this.advance(claim)) completed += 1;
      } catch (error) {
        warnWithoutThrow(this.log, "[tenant-telemetry-writer-worker] write failed");
        if (blocksWrite(error)) {
          await this.deps.store.blockTenantTelemetryWrite(
            authorization(claim),
            "integrity_conflict",
          ).catch(() => false);
        } else {
          await this.retry(claim).catch(() => false);
        }
      }
    }
    return completed;
  }

  private async advance(claim: TenantTelemetryWriteClaim): Promise<boolean> {
    const auth = authorization(claim);
    const input = adapterInput(claim);
    await this.requireRenew(auth);
    let inspected = await this.deps.adapter.inspectWrite(input);
    validateTenantTelemetryWriteInspection(this.deps.adapter.adapterProtocol, input, inspected);
    if (inspected.status === "conflict") {
      throw new TenantTelemetryWriteAdapterConflictError();
    }
    if (inspected.status === "exact") {
      if (!claim.reservation) {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      return this.completeWithExactReplay(auth, claim, input, inspected.result);
    }

    if (!claim.reservation) {
      await this.requireRenew(auth);
      const reservation = await this.deps.store.reserveTenantTelemetryExternalMutation(
        auth,
        this.deps.adapter.adapterProtocol,
      );
      if (!reservation) throw new TenantTelemetryWriteAdapterTemporaryError();
      claim = { ...claim, reservation };

      // The first absent inspection is deliberately pre-reservation so an unrelated exact remote
      // object cannot be laundered. Re-inspect after the write-once reservation commits: an exact
      // result is now an authorized replay, while absent may proceed to create.
      await this.requireRenew(auth);
      inspected = await this.deps.adapter.inspectWrite(input);
      validateTenantTelemetryWriteInspection(this.deps.adapter.adapterProtocol, input, inspected);
      if (inspected.status === "conflict") {
        throw new TenantTelemetryWriteAdapterConflictError();
      }
      if (inspected.status === "exact") {
        return this.completeWithExactReplay(auth, claim, input, inspected.result);
      }
    }

    await this.requireRenew(auth);
    let result: TenantTelemetryWriteAdapterResult;
    try {
      result = await this.deps.adapter.createWrite(input);
      assertExactTenantTelemetryWriteAdapterResult(
        this.deps.adapter.adapterProtocol,
        input,
        result,
      );
    } catch (firstError) {
      // Any error returned after create was invoked is ambiguous: even a malformed, oversized, or
      // unbound success response may have arrived after the sink committed. Inspect once under a
      // renewed claim and never issue a second create in this attempt. Only an absent inspection
      // may classify the original error as retryable or conflicting.
      await this.requireRenew(auth);
      const replay = await this.deps.adapter.inspectWrite(input);
      validateTenantTelemetryWriteInspection(this.deps.adapter.adapterProtocol, input, replay);
      if (replay.status === "conflict") throw new TenantTelemetryWriteAdapterConflictError();
      if (replay.status === "absent") throw firstError;
      result = replay.result;
    }
    return this.completeWithExactReplay(auth, claim, input, result);
  }

  private async completeWithExactReplay(
    auth: TenantTelemetryWriteAuthorization,
    claim: TenantTelemetryWriteClaim,
    input: TenantTelemetryWriteAdapterInput,
    result: TenantTelemetryWriteAdapterResult,
  ): Promise<boolean> {
    assertExactTenantTelemetryWriteAdapterResult(this.deps.adapter.adapterProtocol, input, result);
    await this.requireRenew(auth);
    try {
      const ack = await this.deps.store.completeTenantTelemetryWrite(auth, result);
      if (!ack) throw new TenantTelemetryWriteAdapterTemporaryError();
      this.assertAck(claim, result, ack);
      return true;
    } catch (firstError) {
      if (blocksWrite(firstError)) throw firstError;
      // The DB transaction may have committed while its response was lost. Read the immutable ACK
      // first, then make one exact completion replay while the original claim identity is retained.
      const existing = await this.deps.store.getTenantTelemetryWriteAck(
        claim.tenantId,
        claim.writeOperationSha256,
      );
      if (existing) {
        this.assertAck(claim, result, existing);
        return true;
      }
      await this.requireRenew(auth);
      const replay = await this.deps.store.completeTenantTelemetryWrite(auth, result);
      if (!replay) throw firstError;
      this.assertAck(claim, result, replay);
      return true;
    }
  }

  private assertAck(
    claim: TenantTelemetryWriteClaim,
    result: TenantTelemetryWriteAdapterResult,
    ack: TenantTelemetryWriteAck,
  ): void {
    try {
      validateTenantTelemetryWriteAck(ack);
      if (!claim.reservation
        || ack.tenantId !== claim.tenantId
        || ack.writeOperationSha256 !== claim.writeOperationSha256
        || ack.adapterEvidenceSha256 !== result.evidenceSha256
        || ack.manifestSha256 !== result.manifestSha256
        || ack.payloadSha256 !== result.payloadSha256
        || ack.reservationReceiptSha256 !== claim.reservation.receiptSha256
        || ack.mutationStartedAtDbMs !== claim.reservation.startedAtDbMs
        || ack.mutationStartedClaimAttempt !== claim.reservation.startedClaimAttempt
        || ack.mutationStartedClaimTokenSha256
          !== claim.reservation.startedClaimTokenSha256) {
        throw new Error("ACK mismatch");
      }
    } catch {
      throw new TenantTelemetryWriteIntegrityError();
    }
  }

  private async requireRenew(auth: TenantTelemetryWriteAuthorization): Promise<void> {
    if (!await this.deps.store.renewTenantTelemetryWrite(auth, { leaseMs: this.opts.leaseMs })) {
      throw new TenantTelemetryWriteAdapterTemporaryError();
    }
  }

  private async retry(claim: TenantTelemetryWriteClaim): Promise<boolean> {
    const exponent = Math.min(30, Math.max(0, claim.claimAttempt - 1));
    const delayMs = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    return this.deps.store.retryTenantTelemetryWrite(authorization(claim), {
      delayMs,
      errorCode: "temporary_failure",
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.processOnce();
      void run
        .catch(() => warnWithoutThrow(
          this.log,
          "[tenant-telemetry-writer-worker] polling failed",
        ))
        .finally(() => this.schedule(this.opts.pollIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}
