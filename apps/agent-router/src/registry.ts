import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import {
  Capabilities,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
} from "@agent-service/protocol";

/**
 * Where a session should go. Two sources, in priority order:
 *  1. the ownership directory (`lease:{sid}` in Redis, written by whichever runner holds the lease) —
 *     authoritative about who is running the session right now;
 *  2. consistent hashing over the healthy runner pool — only a first guess for a session nobody owns.
 *
 * Routing is an optimisation, never a correctness mechanism: a wrong guess costs one extra hop,
 * because the runner rejects a session it does not own with 409 + `X-Owner`.
 */

export interface RunnerTarget {
  /** base url, e.g. http://10.0.0.7:8787 */
  url: string;
  healthy: boolean;
  lastCheckMs: number;
  consecutiveFailures: number;
  /** Last capability document from the same probe that marked this target healthy. */
  capabilities?: Capabilities;
}

export interface RunnerRegistryOptions {
  runners: string[];
  redisUrl?: string;
  redisPrefix?: string;
  /** how often to poll readiness and protocol compatibility */
  healthIntervalMs?: number;
  /** virtual nodes per runner on the hash ring */
  virtualNodes?: number;
  healthTimeoutMs?: number;
  redisCommandTimeoutMs?: number;
}

const hash = (s: string) => {
  // 32-bit unsigned from the first 4 bytes of sha1: enough spread for a ring
  const d = createHash("sha1").update(s).digest();
  return d.readUInt32BE(0);
};

export class RunnerRegistry {
  private readonly targets = new Map<string, RunnerTarget>();
  private readonly ring: { point: number; url: string }[] = [];
  /**
   * Sticky only across transient health loss inside this router process. A target enters the set
   * after one successful probe containing both the quarantine and legacy-compensation contracts,
   * and leaves it after any later successful downgrade. This distinguishes an unobserved rollout
   * target from a known-compatible runner that crashed: the former must block activation, while
   * the latter must not deadlock erasure recovery.
   */
  private readonly erasureJobControlCompatible = new Set<string>();
  private readonly redis?: Redis;
  private timer?: NodeJS.Timeout;
  private checkInFlight?: Promise<void>;

  constructor(private readonly opts: RunnerRegistryOptions) {
    for (const url of opts.runners) {
      const normalized = url.replace(/\/+$/, "");
      // Unknown until the first probe: reporting ready before any check makes /readyz lie during rollout.
      this.targets.set(normalized, { url: normalized, healthy: false, lastCheckMs: 0, consecutiveFailures: 0 });
      for (let i = 0; i < (opts.virtualNodes ?? 64); i++) this.ring.push({ point: hash(`${normalized}#${i}`), url: normalized });
    }
    this.ring.sort((a, b) => a.point - b.point);
    if (opts.redisUrl) {
      // The directory is a cache. During a Redis failover every request would otherwise queue on it, so
      // commands fail fast and are never buffered offline.
      this.redis = new Redis(opts.redisUrl, {
        maxRetriesPerRequest: 1,
        commandTimeout: opts.redisCommandTimeoutMs ?? 300,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      this.redis.on("error", () => {}); // handled per-command; an unhandled 'error' would crash the process
    }
  }

  private firstProbe?: Promise<void>;

  start(): void {
    const every = this.opts.healthIntervalMs ?? 5_000;
    this.firstProbe = this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), every);
    this.timer.unref?.();
  }

  /** Targets start unhealthy; wait for one probe so the first request is not answered with 503. */
  async waitForFirstProbe(timeoutMs = 5_000): Promise<void> {
    await Promise.race([this.firstProbe ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.checkInFlight?.catch(() => {});
    await this.redis?.quit().catch(() => {});
  }

  list(): RunnerTarget[] {
    return [...this.targets.values()];
  }

  /** The runner that currently holds this session's lease, if the directory knows one. */
  async owner(sessionId: string): Promise<string | undefined> {
    if (!this.redis) return undefined;
    try {
      const addr = await this.redis.hget(`${this.opts.redisPrefix ?? "as"}:lease:{${sessionId}}`, "addr");
      return addr ? this.routeableUrl(addr) : undefined;
    } catch {
      return undefined; // the directory is a cache; losing it only costs an extra hop
    }
  }

  /**
   * Tri-state authoritative lease presence for destructive retry coordination. `false` is returned
   * only after Redis confirms the key is absent; an unavailable directory is `undefined`, never a
   * license to overlap a possibly-live provider/tool call.
   */
  async hasLeaseOwner(sessionId: string): Promise<boolean | undefined> {
    if (!this.redis) return undefined;
    try {
      return await this.redis.exists(
        `${this.opts.redisPrefix ?? "as"}:lease:{${sessionId}}`,
      ) === 1;
    } catch {
      return undefined;
    }
  }

  /** Ring position for a session nobody owns yet, skipping unhealthy runners. */
  candidate(sessionId: string): string | undefined {
    if (!this.ring.length) return undefined;
    const h = hash(sessionId);
    const start = this.ring.findIndex((p) => p.point >= h);
    const from = start === -1 ? 0 : start;
    for (let i = 0; i < this.ring.length; i++) {
      const url = this.ring[(from + i) % this.ring.length]!.url;
      if (this.targets.get(url)?.healthy) return url;
    }
    return undefined;
  }

  private rr = 0;

  /**
   * Any healthy runner, round-robin. Hashing the path instead would pin every `POST /v1/sessions` — the
   * single hottest route — onto one runner for the life of the process.
   */
  anyHealthy(): string | undefined {
    const healthy = this.list().filter((t) => t.healthy);
    if (!healthy.length) return undefined;
    return healthy[this.rr++ % healthy.length]!.url;
  }

  /**
   * Lifecycle writes are fleet semantics, not a per-request experiment. During a rolling upgrade
   * the router activates one only after every healthy runner advertises it; otherwise consistent
   * hashing or an existing owner could select an old implementation.
   */
  allHealthySupportLifecycle(feature: Capabilities["features"]["sessionLifecycle"][number]): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => target.capabilities?.features.sessionLifecycle.includes(feature));
  }

  /** Revalidate the concrete destination immediately before a capability-gated write is sent. */
  supportsLifecycle(url: string, feature: Capabilities["features"]["sessionLifecycle"][number]): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && !!target.capabilities?.features.sessionLifecycle.includes(feature);
  }

  allHealthySupportBlobAttachments(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => target.capabilities?.features.blobAttachments === true);
  }

  supportsBlobAttachments(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && target.capabilities?.features.blobAttachments === true;
  }

  allHealthySupportDataErasureRequests(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => target.capabilities?.features.dataErasureRequests === true);
  }

  /**
   * Erasure admission is irreversible: an unavailable legacy writer cannot be ignored merely
   * because it is absent from the currently healthy subset. Require every configured destination
   * to have completed a healthy capability probe before the router may accept the first gate.
   */
  allConfiguredSupportDataErasureRequests(): boolean {
    const configured = this.list();
    return configured.length > 0 && configured.every((target) => (
      target.healthy && target.capabilities?.features.dataErasureRequests === true
    ));
  }

  supportsDataErasureRequests(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy && target.capabilities?.features.dataErasureRequests === true;
  }

  /** Existing durable erasure jobs keep running even when admission of new requests is disabled. */
  allHealthySupportUserErasureWorker(): boolean {
    const healthy = this.list().filter((target) => target.healthy);
    return healthy.length > 0 && healthy.every((target) => (
      target.capabilities?.features.userErasureWorker.includes("drain-v1") === true
    ));
  }

  supportsUserErasureWorker(url: string): boolean {
    const target = this.targets.get(url.replace(/\/+$/, ""));
    return !!target?.healthy
      && target.capabilities?.features.userErasureWorker.includes("drain-v1") === true;
  }

  /**
   * Publishing a quarantine or compensating a generation-zero tombstone changes durable state.
   * Every configured target must first have been observed on both additive contracts. Once
   * observed, a transient crash does not close the worker barrier: otherwise the surviving worker
   * could never recover that runner's live session lease. A later successful downgrade removes the
   * target from this set and closes the V2 barrier.
   */
  allConfiguredSupportErasureJobControl(): boolean {
    const configured = this.list();
    return configured.length > 0
      && configured.every((target) => this.erasureJobControlCompatible.has(target.url));
  }

  /**
   * A runner address as reported by `X-Owner` (host:port) mapped back onto a configured target.
   * Matching on the port alone as a fallback covers the common misconfiguration where a runner advertises
   * a wildcard or container-internal host (`0.0.0.0:8787`) that never string-matches the configured URL.
   */
  toUrl(addr: string): string | undefined {
    const bare = addr.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    for (const t of this.targets.keys()) if (t.replace(/^https?:\/\//, "") === bare) return t;
    const port = bare.split(":").at(-1);
    if (!port || !/^\d+$/.test(port)) return undefined;
    const byPort = [...this.targets.keys()].filter((t) => t.endsWith(`:${port}`));
    return byPort.length === 1 ? byPort[0] : undefined;
  }

  /** Resolve an advertised owner only when it passed both readiness and protocol probes. */
  routeableUrl(addr: string): string | undefined {
    const url = this.toUrl(addr);
    return url && this.targets.get(url)?.healthy ? url : undefined;
  }

  markFailure(url: string): void {
    const t = this.targets.get(url);
    if (!t) return;
    t.consecutiveFailures += 1;
    if (t.consecutiveFailures >= 2) t.healthy = false;
  }

  private checkAll(): Promise<void> {
    if (this.checkInFlight) return this.checkInFlight;
    const check = this.checkAllOnce();
    this.checkInFlight = check.finally(() => {
      this.checkInFlight = undefined;
    });
    return this.checkInFlight;
  }

  private async checkAllOnce(): Promise<void> {
    await Promise.all(
      [...this.targets.values()].map(async (t) => {
        try {
          const signal = AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000);
          const ready = await fetch(`${t.url}/readyz`, { signal });
          if (!ready.ok) throw new Error(`readiness returned ${ready.status}`);
          let capabilities: Response;
          try {
            capabilities = await fetch(`${t.url}/v1/capabilities`, { signal });
          } catch {
            // A process that answered readiness but cannot prove its capability is not equivalent
            // to a wholly unreachable, previously attested target. Revoke until a later good probe.
            this.erasureJobControlCompatible.delete(t.url);
            throw new Error("runner capability probe transport failed");
          }
          if (!capabilities.ok) {
            this.erasureJobControlCompatible.delete(t.url);
            throw new Error(`runner capability endpoint returned ${capabilities.status}`);
          }
          let payload: unknown;
          try {
            payload = await capabilities.json();
          } catch {
            this.erasureJobControlCompatible.delete(t.url);
            throw new Error("runner capability document is malformed");
          }
          const parsed = Capabilities.safeParse(payload);
          if (!parsed?.success || parsed.data.service !== "agent-runner") {
            // A successful HTTP response with an old protocol, missing feature or wrong service is
            // affirmative incompatibility, so it revokes the sticky observation immediately.
            this.erasureJobControlCompatible.delete(t.url);
            throw new Error("runner protocol is incompatible");
          }
          const jobControl = parsed.data.features.erasureJobControl;
          if (
            jobControl.includes(ERASURE_JOB_CONTROL_QUARANTINE_V1)
            && jobControl.includes(ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1)
          ) {
            this.erasureJobControlCompatible.add(t.url);
          } else {
            this.erasureJobControlCompatible.delete(t.url);
          }
          t.capabilities = parsed.data;
          t.healthy = true;
          t.consecutiveFailures = 0;
        } catch {
          t.capabilities = undefined;
          t.consecutiveFailures += 1;
          t.healthy = false;
        }
        t.lastCheckMs = Date.now();
      }),
    );
  }
}
