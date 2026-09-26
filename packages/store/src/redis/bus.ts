import { Redis } from "ioredis";
import type { Event, PersistedEvent } from "@agent-service/protocol";
import type { EventBus, EventListener } from "../types.js";

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
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly ready: Promise<void>;

  constructor(
    url: string,
    private readonly opts: { prefix?: string; hotWindowMs?: number; maxLen?: number } = {},
  ) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub.on("message", (channel: string, message: string) => {
      const set = this.listeners.get(channel);
      if (!set?.size) return;
      const event = JSON.parse(message) as Event;
      for (const l of set) {
        try {
          l(event);
        } catch {
          /* listener errors must not break fan-out */
        }
      }
    });
    this.ready = new Promise((resolve) => this.sub.once("ready", () => resolve()));
  }
  private ch(sid: string) {
    return `${this.opts.prefix ?? "as"}:evt:{${sid}}`;
  }
  private stream(sid: string) {
    return `${this.opts.prefix ?? "as"}:stream:{${sid}}`;
  }

  async publish(sessionId: string, event: Event) {
    const payload = JSON.stringify(event);
    const seq = (event as { seq?: number }).seq;
    if (typeof seq === "number") {
      const s = this.stream(sessionId);
      await this.pub
        .multi()
        .xadd(s, "MAXLEN", "~", String(this.opts.maxLen ?? 2000), "*", "seq", String(seq), "e", payload)
        .pexpire(s, this.opts.hotWindowMs ?? 3_600_000)
        .publish(this.ch(sessionId), payload)
        .exec();
    } else {
      await this.pub.publish(this.ch(sessionId), payload);
    }
  }

  async subscribe(sessionId: string, listener: EventListener, opts?: { afterSeq?: number }) {
    await this.ready;
    const channel = this.ch(sessionId);
    let set = this.listeners.get(channel);
    if (!set) {
      this.listeners.set(channel, (set = new Set()));
      await this.sub.subscribe(channel);
    }
    // Buffer live events while we replay from the stream so ordering by seq is preserved.
    const buffer: Event[] = [];
    let replaying = opts?.afterSeq !== undefined;
    const gate: EventListener = (e) => (replaying ? buffer.push(e) : listener(e));
    set.add(gate);
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
    return () => {
      set!.delete(gate);
      if (set!.size === 0) {
        this.listeners.delete(channel);
        void this.sub.unsubscribe(channel);
      }
    };
  }

  async close() {
    this.listeners.clear();
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}
