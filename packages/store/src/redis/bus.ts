import { Redis } from "ioredis";
import { Event as EventSchema, type Event, type PersistedEvent } from "@agent-service/protocol";
import type { EventBus, EventListener, EventSubscriptionOptions } from "../types.js";

interface RedisListener {
  listener: EventListener;
  onReconnect?: () => void | Promise<void>;
  active: boolean;
  recoveryTimer?: NodeJS.Timeout;
  recovering?: boolean;
  recoveryPending?: boolean;
}

/**
 * Redis event bus:
 *  - live delivery via pub/sub channel `evt:{sid}` (all events, including deltas)
 *  - hot replay of persisted events via stream `stream:{sid}` (MAXLEN-capped, TTL hotWindowMs)
 *
 * Subscribe order is: subscribe channel first, then XRANGE the stream for `> afterSeq`, dedupe by seq.
 * Anything older than the hot window must come from the SessionStore.
 */
export class RedisEventBus implements EventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly listeners = new Map<string, Set<RedisListener>>();
  /** Serializes Redis subscription commands and listener-set transitions for each channel. */
  private readonly channelOps = new Map<string, Promise<void>>();
  private readonly ready: Promise<void>;
  private hasBeenReady = false;
  private closed = false;

  constructor(
    url: string,
    private readonly opts: { prefix?: string; hotWindowMs?: number; maxLen?: number } = {},
  ) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set?.size) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(message);
      } catch {
        return; // durable replay/catch-up is authoritative; a corrupt live hint must not crash the runner
      }
      const parsed = EventSchema.safeParse(decoded);
      if (!parsed.success) return;
      const event = parsed.data;
      for (const entry of set) {
        if (!entry.active) continue;
        try {
          entry.listener(event);
        } catch {
          /* listener errors must not break fan-out */
        }
      }
    });
    this.ready = new Promise((resolve) => {
      this.sub.on("ready", () => {
        if (!this.hasBeenReady) {
          this.hasBeenReady = true;
          resolve();
          return;
        }
        void this.recoverSubscriptions();
      });
    });
  }
  private ch(sid: string) {
    return `${this.opts.prefix ?? "as"}:evt:{${sid}}`;
  }
  private stream(sid: string) {
    return `${this.opts.prefix ?? "as"}:stream:{${sid}}`;
  }

  private async withChannelLock<T>(channel: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channelOps.get(channel) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.channelOps.set(channel, tail);
    try {
      return await result;
    } finally {
      if (this.channelOps.get(channel) === tail) this.channelOps.delete(channel);
    }
  }

  async publish(sessionId: string, event: Event) {
    const payload = JSON.stringify(event);
    const seq = (event as { seq?: number }).seq;
    if (typeof seq === "number") {
      const s = this.stream(sessionId);
      const results = await this.pub
        .multi()
        .xadd(s, "MAXLEN", "~", String(this.opts.maxLen ?? 2000), "*", "seq", String(seq), "e", payload)
        .pexpire(s, this.opts.hotWindowMs ?? 3_600_000)
        .publish(this.ch(sessionId), payload)
        .exec();
      // Redis transactions can resolve successfully while individual commands fail (for example,
      // XADD against a key with the wrong type). Treat any subcommand error as a failed delivery so
      // a durable outbox is never acknowledged after only part of the hot-replay/live publish pair.
      if (!results || results.some(([error]) => error !== null)) {
        throw new Error("Redis event publish transaction failed");
      }
    } else {
      await this.pub.publish(this.ch(sessionId), payload);
    }
  }

  async subscribe(sessionId: string, listener: EventListener, opts?: EventSubscriptionOptions) {
    await this.ready;
    const channel = this.ch(sessionId);
    // Buffer live events while we replay from the stream so ordering by seq is preserved.
    const buffer: Event[] = [];
    let replaying = opts?.afterSeq !== undefined;
    const entry: RedisListener = {
      listener: (e) => (replaying ? buffer.push(e) : listener(e)),
      onReconnect: opts?.onReconnect,
      active: true,
    };
    let set!: Set<RedisListener>;
    // Keep the Redis command and local registration in one per-channel critical section. Otherwise
    // the last old listener can UNSUBSCRIBE after a replacement command is acknowledged but before
    // that replacement is represented in `listeners`, leaving a live-looking phantom subscription.
    await this.withChannelLock(channel, async () => {
      if (this.closed) throw new Error("Redis event bus is closed");
      await this.sub.subscribe(channel);
      if (this.closed) throw new Error("Redis event bus is closed");
      set = this.listeners.get(channel) ?? new Set<RedisListener>();
      this.listeners.set(channel, set);
      set.add(entry);
    });
    const deactivate = () => {
      if (!entry.active) return false;
      entry.active = false;
      if (entry.recoveryTimer) clearTimeout(entry.recoveryTimer);
      return true;
    };
    const remove = () => this.withChannelLock(channel, async () => {
      if (this.listeners.get(channel) !== set) return;
      set.delete(entry);
      if (set.size === 0) {
        this.listeners.delete(channel);
        if (!this.closed) await this.sub.unsubscribe(channel);
      }
    });
    const cleanup = () => {
      if (!deactivate()) return;
      void remove().catch(() => {});
    };
    try {
      if (replaying) {
        const after = opts!.afterSeq!;
        const entries = await this.pub.xrange(this.stream(sessionId), "-", "+");
        let maxSeq = after;
        for (const [, fields] of entries) {
          const idx = fields.indexOf("e");
          if (idx < 0) continue;
          const e = JSON.parse(fields[idx + 1]!) as PersistedEvent;
          if (e.seq > after) {
            listener(e);
            maxSeq = Math.max(maxSeq, e.seq);
          }
        }
        replaying = false;
        for (const e of buffer) {
          const seq = (e as { seq?: number }).seq;
          if (typeof seq === "number" && seq <= maxSeq) continue; // already replayed
          listener(e);
        }
        buffer.length = 0;
      }
    } catch (error) {
      if (deactivate()) await remove().catch(() => {});
      throw error;
    }
    return cleanup;
  }

  async close() {
    this.closed = true;
    for (const set of this.listeners.values()) {
      for (const entry of set) {
        entry.active = false;
        if (entry.recoveryTimer) clearTimeout(entry.recoveryTimer);
      }
    }
    this.listeners.clear();
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }

  /** Re-subscribe first, then ask each owner to catch up from its authoritative durable cursor. */
  private async recoverSubscriptions(): Promise<void> {
    if (this.closed) return;
    const channels = [...this.listeners.entries()].filter(([, set]) => set.size > 0);
    for (const [channel] of channels) {
      try {
        await this.withChannelLock(channel, async () => {
          if (this.closed || !this.listeners.get(channel)?.size) return;
          await this.sub.subscribe(channel);
        });
      } catch {
        return; // another ready event will retry after ioredis reconnects again
      }
    }
    for (const [, set] of channels) for (const entry of set) this.triggerRecovery(entry);
  }

  private triggerRecovery(entry: RedisListener): void {
    if (this.closed || !entry.active || !entry.onReconnect) return;
    if (entry.recovering) {
      entry.recoveryPending = true;
      return;
    }
    if (entry.recoveryTimer) return;
    entry.recovering = true;
    void Promise.resolve()
      .then(entry.onReconnect)
      .then(() => {
        entry.recovering = false;
        if (entry.recoveryPending) {
          entry.recoveryPending = false;
          this.triggerRecovery(entry);
        }
      })
      .catch(() => {
        entry.recovering = false;
        if (this.closed || !entry.active) return;
        entry.recoveryPending = false;
        entry.recoveryTimer = setTimeout(() => {
          entry.recoveryTimer = undefined;
          this.triggerRecovery(entry);
        }, 1_000);
        entry.recoveryTimer.unref?.();
      });
  }
}
