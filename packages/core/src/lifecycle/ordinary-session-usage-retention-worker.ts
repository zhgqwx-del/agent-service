import type { OrdinarySessionUsageRetentionStore, UsageLifecycleStore } from "@agent-service/store";

export interface OrdinarySessionUsageRetentionWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
}

export interface OrdinarySessionUsageRetentionWorkerDeps {
  store: OrdinarySessionUsageRetentionStore & Pick<UsageLifecycleStore, "reconcileSessionUsage">;
  /** A new, non-sticky all-configured fleet proof for each immediately following boundary. */
  canExecute: () => Promise<boolean>;
  logger?: Pick<Console, "warn">;
}

/**
 * Default-off runner caller for one operational domain only. Scanning and reconciliation are not
 * deletion authority: the trusted execute operation independently rechecks origin, database time,
 * deletion/current policy, canonical holds and every retained billing fact in its atomic boundary.
 * There is deliberately no SessionStore/content/blob/Redis purge capability here.
 */
export class OrdinarySessionUsageRetentionWorker {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger: Pick<Console, "warn">;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private cursor?: string;
  private started = false;
  private stopping = false;

  constructor(
    private readonly deps: OrdinarySessionUsageRetentionWorkerDeps,
    options: OrdinarySessionUsageRetentionWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.batchSize = options.batchSize ?? 25;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1
      || this.pollIntervalMs > 300_000) {
      throw new Error("ordinary usage retention poll interval must be between 1 and 300000 ms");
    }
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 100) {
      throw new Error("ordinary usage retention batch size must be between 1 and 100");
    }
    this.logger = deps.logger ?? console;
  }

  /** One bounded page. Concurrent callers share the same pass instead of overlapping work. */
  pollOnce(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const run = this.runPage();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = undefined;
    }).catch(() => {});
    return run;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight?.catch(() => {});
  }

  private warn(): void {
    try {
      // Never log database/transport errors, owner ids, policy documents or receipt contents.
      this.logger.warn("ordinary session usage retention failed");
    } catch {
      // A telemetry failure cannot change the data lifecycle or shutdown semantics.
    }
  }

  private async gate(): Promise<boolean> {
    if (this.stopping) return false;
    try {
      return await this.deps.canExecute() === true && !this.stopping;
    } catch {
      this.warn();
      return false;
    }
  }

  private async runPage(): Promise<number> {
    if (!await this.gate()) return 0;
    let candidates;
    try {
      candidates = await this.deps.store.listOrdinarySessionUsageRetentionCandidates({
        ...(this.cursor === undefined ? {} : { afterSessionId: this.cursor }),
        limit: this.batchSize,
      });
    } catch {
      this.warn();
      return 0;
    }
    if (candidates.length === 0) {
      this.cursor = undefined; // A completed pass wraps; deferred/failed rows are retried later.
      return 0;
    }
    let completed = 0;
    for (const candidate of candidates) {
      if (!await this.gate()) break;
      try {
        // The wall clock is only the existing reconciliation's audit input, never expiry authority.
        // execute rechecks the reconciliation against its own database clock and can deny skew.
        const record = await this.deps.store.reconcileSessionUsage({ ...candidate, nowMs: Date.now() });
        if (!await this.gate()) break;
        const receipt = await this.deps.store.executeOrdinarySessionUsageRetention({
          ...candidate, expectedChecksum: record.checksum, enabled: true,
        });
        if (receipt !== null) completed += 1;
      } catch {
        this.warn();
      } finally {
        // A poison candidate must not starve its neighbours. This cursor conveys no authority.
        this.cursor = candidate.sessionId;
      }
    }
    return completed;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pollOnce().catch(() => this.warn()).finally(() => this.schedule(this.pollIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}
