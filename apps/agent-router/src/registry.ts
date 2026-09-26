import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { Capabilities } from "@agent-service/protocol";

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
  private readonly redis?: Redis;
  private timer?: NodeJS.Timeout;

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

  private async checkAll(): Promise<void> {
    await Promise.all(
      [...this.targets.values()].map(async (t) => {
        try {
          const signal = AbortSignal.timeout(this.opts.healthTimeoutMs ?? 2_000);
          const ready = await fetch(`${t.url}/readyz`, { signal });
          if (!ready.ok) throw new Error(`readiness returned ${ready.status}`);
          const capabilities = await fetch(`${t.url}/v1/capabilities`, { signal });
          const parsed = capabilities.ok ? Capabilities.safeParse(await capabilities.json()) : undefined;
          if (!parsed?.success || parsed.data.service !== "agent-runner") {
            throw new Error("runner protocol is incompatible");
          }
          t.healthy = true;
          t.consecutiveFailures = 0;
        } catch {
          t.consecutiveFailures += 1;
          t.healthy = false;
        }
        t.lastCheckMs = Date.now();
      }),
    );
  }
}
