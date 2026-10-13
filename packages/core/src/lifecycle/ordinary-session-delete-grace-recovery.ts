import type { SessionStore } from "@agent-service/store";

export interface OrdinarySessionDeleteGraceRecoveryOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export interface OrdinarySessionDeleteGraceRecoveryDeps {
  store: Pick<SessionStore, "retryUnsealedOrdinarySessionDeleteGraceOrigins">;
  logger?: Pick<Console, "warn">;
}

/**
 * Repairs only a committed ordinary DELETE origin whose post-COMMIT seal was interrupted.
 * The store rechecks the exact owner, terminal event and two outbox identities under its own
 * atomic boundary. This worker has no API for scheduling or claiming `session.purge`.
 */
export class OrdinarySessionDeleteGraceRecovery {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger: Pick<Console, "warn">;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private stopping = true;

  constructor(
    private readonly deps: OrdinarySessionDeleteGraceRecoveryDeps,
    options: OrdinarySessionDeleteGraceRecoveryOptions = {},
  ) {
    const pollIntervalMs = options.pollIntervalMs ?? 30_000;
    const batchSize = options.batchSize ?? 25;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 300_000) {
      throw new Error("ordinary DELETE recovery poll interval must be between 1 and 300000 ms");
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("ordinary DELETE recovery batch size must be between 1 and 100");
    }
    this.pollIntervalMs = pollIntervalMs;
    this.batchSize = batchSize;
    this.logger = deps.logger ?? console;
  }

  /** One bounded pass; exposed for deterministic tests and manual operational draining. */
  recoverOnce(): Promise<number> {
    return this.deps.store.retryUnsealedOrdinarySessionDeleteGraceOrigins(this.batchSize);
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

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const run = Promise.resolve().then(() => this.recoverOnce());
      this.inFlight = run;
      void run
        .catch(() => {
          // Database errors may contain credentials or owner identifiers. Never log their text.
          try {
            this.logger.warn("ordinary DELETE grace recovery failed");
          } catch {
            // Telemetry must not alter the recovery loop or shutdown behavior.
          }
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = undefined;
          this.schedule(this.pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
