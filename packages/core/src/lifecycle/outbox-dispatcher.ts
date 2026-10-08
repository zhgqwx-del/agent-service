import { randomUUID } from "node:crypto";
import type { PersistedEvent } from "@agent-service/protocol";
import type { EventBus, LifecycleOutboxRecord, LifecycleOutboxStore, SessionStore } from "@agent-service/store";

export interface LifecycleOutboxDispatcherOptions {
  pollIntervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface LifecycleOutboxDispatcherDeps {
  /** Read-only event access plus the least-privilege outbox acknowledgement surface. */
  store: LifecycleOutboxStore & Pick<SessionStore, "readEvents">;
  bus: EventBus;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const DEFAULTS = {
  pollIntervalMs: 250,
  leaseMs: 10_000,
  batchSize: 50,
  retryBaseMs: 250,
  retryMaxMs: 60_000,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

/**
 * Re-publishes the durable terminal deletion event after a process crash or transient event-bus
 * failure. Delivery is intentionally at-least-once: event seq is the consumer deduplication key.
 * This worker never claims `session.purge`, so physical deletion remains impossible here.
 */
export class LifecycleOutboxDispatcher {
  private readonly opts: Required<LifecycleOutboxDispatcherOptions>;
  private readonly log: Pick<Console, "info" | "warn" | "error">;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private stopping = true;

  constructor(private readonly deps: LifecycleOutboxDispatcherDeps, options: LifecycleOutboxDispatcherOptions = {}) {
    this.opts = {
      pollIntervalMs: positiveInteger(options.pollIntervalMs ?? DEFAULTS.pollIntervalMs, "pollIntervalMs"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULTS.leaseMs, "leaseMs"),
      batchSize: positiveInteger(options.batchSize ?? DEFAULTS.batchSize, "batchSize"),
      retryBaseMs: positiveInteger(options.retryBaseMs ?? DEFAULTS.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInteger(options.retryMaxMs ?? DEFAULTS.retryMaxMs, "retryMaxMs"),
    };
    if (this.opts.batchSize > 100) throw new Error("batchSize must not exceed the store claim limit of 100");
    if (this.opts.retryMaxMs < this.opts.retryBaseMs) throw new Error("retryMaxMs must be >= retryBaseMs");
    this.log = deps.logger ?? console;
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  /** One deterministic polling pass, exposed for tests and operational draining. */
  async dispatchOnce(nowMs = Date.now()): Promise<number> {
    const claimToken = randomUUID();
    const rows = await this.deps.store.claimLifecycleOutbox({
      topics: ["session.tombstoned"],
      nowMs,
      limit: this.opts.batchSize,
      leaseMs: this.opts.leaseMs,
      claimToken,
    });
    let completed = 0;
    for (const row of rows) {
      if (await this.dispatchClaimed(row, claimToken)) completed += 1;
    }
    return completed;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = this.dispatchOnce();
      this.inFlight = run;
      void run
        .catch((error) => {
          // Never log the vendor message: connection errors can contain credential-bearing URLs.
          const name = error instanceof Error ? error.name : "unknown error";
          this.log.warn(`[lifecycle-outbox] polling failed (${name})`);
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.opts.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private async dispatchClaimed(row: LifecycleOutboxRecord, claimToken: string): Promise<boolean> {
    if (row.topic !== "session.tombstoned") {
      // The claim is topic-scoped; treat an impossible widening as poison instead of touching purge.
      await this.retry(row, claimToken, new Error("dispatcher claimed an unsupported lifecycle topic"), true);
      return false;
    }

    const renewedAtMs = Date.now();
    const renewed = await this.deps.store.renewLifecycleOutboxClaim(row.outboxId, claimToken, {
      nowMs: renewedAtMs,
      leaseMs: this.opts.leaseMs,
    });
    if (!renewed) return false;

    let event: PersistedEvent | undefined;
    try {
      [event] = await this.deps.store.readEvents(row.payload.sessionId, row.payload.eventSeq - 1, 1);
    } catch (error) {
      await this.retry(row, claimToken, error, false);
      return false;
    }
    if (
      !event
      || event.seq !== row.payload.eventSeq
      || event.type !== "session/deleted"
      || event.sessionId !== row.payload.sessionId
      || event.deletionGeneration !== row.payload.deletionGeneration
    ) {
      await this.retry(
        row,
        claimToken,
        new Error("durable tombstone event does not match lifecycle outbox identity"),
        true,
      );
      return false;
    }

    try {
      await this.deps.bus.publish(row.payload.sessionId, event);
      const completed = await this.deps.store.completeLifecycleOutbox(row.outboxId, claimToken, Date.now());
      // A publish can cross the lease boundary. In that case a successor will safely send the same
      // event seq again; this worker must not overwrite its newer claim.
      return completed;
    } catch (error) {
      // Event-bus and acknowledgement failures are availability failures, not poison. They retry
      // indefinitely by default so a long Redis outage cannot silently make the terminal event
      // permanently undeliverable.
      await this.retry(row, claimToken, error, false);
      return false;
    }
  }

  private async retry(
    row: LifecycleOutboxRecord,
    claimToken: string,
    error: unknown,
    terminal: boolean,
  ): Promise<void> {
    const failedAtMs = Date.now();
    const exponent = Math.min(30, Math.max(0, row.attempts - 1));
    const delay = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * (2 ** exponent));
    const updated = await this.deps.store.retryLifecycleOutbox(row.outboxId, claimToken, {
      failedAtMs,
      availableAtMs: failedAtMs + delay,
      error,
      ...(terminal ? { maxAttempts: row.attempts } : {}),
    });
    if (updated && terminal) {
      this.log.error(`[lifecycle-outbox] dead-lettered outbox ${row.outboxId} after ${row.attempts} attempts`);
    }
  }
}
