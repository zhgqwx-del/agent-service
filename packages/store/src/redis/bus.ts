import { Redis } from "ioredis";
import { CloseFailures, Event as EventSchema, guardRedisDatabaseSelection, type Event, type PersistedEvent } from "@agent-service/protocol";
import type { EventBus, EventListener, EventSubscriptionOptions, McpProgressEvent, McpProgressPublisher } from "../types.js";
import { RedisSessionPurgedError } from "./purge.js";
import { DEFAULT_REDIS_KEY_PREFIX, redisSessionKeys, validateRedisKeyPrefix } from "./keys.js";

const PUBLISH_PERSISTED = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {-1} end
local reply = redis.call('TYPE', KEYS[1])
local stream_type = reply['ok'] or reply
if stream_type ~= 'none' and stream_type ~= 'stream' then return {-2} end
redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'seq', ARGV[2], 'e', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PUBLISH', ARGV[5], ARGV[3])
return {1}
`;

const PUBLISH_LIVE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return {-1} end
redis.call('PUBLISH', ARGV[1], ARGV[2])
return {1}
`;

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
 *  - both publish paths atomically reject a session once its permanent purge marker exists
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
  // A rejected command is not an UNSUBSCRIBE acknowledgement. Keep the uncertainty sticky:
  // releasing one observer must not allow an unbounded succession of orphan server channels.
  private subscriptionUnknown = false;
  private readonly unknownChannels = new Set<string>();
  private closing: Promise<void> | undefined;
  private subscriberStopping = false;
  private stoppingSubscriptions: Promise<void> | undefined;
  private rejectReady: ((reason: Error) => void) | undefined;
  private readonly publisherWork = new Set<Promise<void>>();
  private readonly subscriptionWork = new Set<Promise<() => Promise<void>>>();
  private readonly nativeFailures = new CloseFailures();
  private readonly subscriberSockets = new Map<Redis["stream"], Promise<void>>();
  private readonly publisherSockets = new Map<Redis["stream"], Promise<void>>();
  private readonly progressPublishers = new Set<McpProgressPublisher>();

  constructor(
    url: string,
    private readonly opts: { prefix?: string; hotWindowMs?: number; maxLen?: number } = {},
  ) {
    validateRedisKeyPrefix(opts.prefix ?? DEFAULT_REDIS_KEY_PREFIX);
    for (const [value, name] of [
      [opts.hotWindowMs ?? 3_600_000, "hot window"],
      [opts.maxLen ?? 2_000, "max length"],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Redis event bus ${name} must be a positive safe integer`);
      }
    }
    this.pub = guardRedisDatabaseSelection(new Redis(url, { maxRetriesPerRequest: 3 }));
    this.sub = guardRedisDatabaseSelection(new Redis(url, { maxRetriesPerRequest: 3 }));
    for (const [client, sockets] of [[this.pub, this.publisherSockets], [this.sub, this.subscriberSockets]] as const) {
      const observe = () => this.observeSocket(client, sockets);
      client.on("connect", observe); client.on("close", observe); client.on("end", observe);
      observe();
    }
    this.pub.defineCommand("eventPublishPersisted", { numberOfKeys: 2, lua: PUBLISH_PERSISTED });
    this.pub.defineCommand("eventPublishLive", { numberOfKeys: 1, lua: PUBLISH_LIVE });
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
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.sub.on("ready", () => {
        if (!this.hasBeenReady) {
          this.hasBeenReady = true;
          this.rejectReady = undefined; resolve();
          return;
        }
        void this.recoverSubscriptions();
      });
    });
    void this.ready.catch(() => {}); // Stop may precede the first observation's ready waiter.
  }
  private ch(sid: string) {
    return redisSessionKeys(sid, this.opts.prefix).eventChannel;
  }
  private stream(sid: string) {
    return redisSessionKeys(sid, this.opts.prefix).stream;
  }

  private observeSocket(client: Redis, sockets: Map<Redis["stream"], Promise<void>>): void {
    const socket = client.stream;
    if (socket && !socket.closed && !sockets.has(socket)) {
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
      sockets.set(socket, closed);
      void closed.then(() => sockets.delete(socket));
    }
    // Only the bus owner invokes close. A single listener never closes this shared transport.
    if (this.closed || client === this.sub && this.subscriberStopping) for (const owned of sockets.keys()) {
      try { owned.destroy(); } catch (error) { this.nativeFailures.record(error); }
    }
  }

  openMcpProgressPublisher(sessionId: string, options: { signal: AbortSignal; timeoutMs: number }): McpProgressPublisher {
    if (this.closed || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2000) {
      throw new Error("MCP progress publisher is unavailable.");
    }
    const keys = redisSessionKeys(sessionId, this.opts.prefix);
    // One actual tool call owns this lazy connection. Never alter the durable
    // publisher/subscriber's options, retry policy, queues, or connection lifetime.
    const client = guardRedisDatabaseSelection(this.pub.duplicate({ lazyConnect: true, connectTimeout: options.timeoutMs, disconnectTimeout: 0,
      retryStrategy: () => null, reconnectOnError: () => false, maxRetriesPerRequest: 0,
      enableOfflineQueue: false, autoResendUnfulfilledCommands: false, autoResubscribe: false,
      enableReadyCheck: false, disableClientInfo: true, protocol: 2 }));
    let stopped = false, busy = false, connecting: Promise<void> | undefined, closing: Promise<void> | undefined;
    const actual = new Set<Promise<unknown>>();
    const sockets = new Map<Redis["stream"], Promise<void>>();
    const observeSocket = () => {
      const socket = client.stream;
      if (socket && !sockets.has(socket)) {
        // The native stream's close, not ioredis's synthetic end/close status,
        // proves that the owned TCP/TLS socket has actually stopped.
        const closed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
        sockets.set(socket, closed);
      }
      if (stopped) for (const socket of sockets.keys()) socket.destroy();
    };
    const tracked = <T>(work: () => Promise<T>): Promise<T> => {
      const task = Promise.resolve().then(() => { if (stopped) throw new Error("MCP progress publisher is unavailable."); return work(); });
      actual.add(task);
      void task.then(() => actual.delete(task), () => actual.delete(task));
      return task;
    };
    const close = (): Promise<void> => {
      if (closing) return closing;
      stopped = true;
      options.signal.removeEventListener("abort", aborted);
      // ioredis6 disconnect cancels a not-yet-created StandaloneConnector stream;
      // destroy the public native stream as well rather than waiting for FIN/RESP.
      try { client.disconnect(false); } catch { /* Still own every actual task/socket below. */ }
      observeSocket();
      closing = (async () => {
        // A connect callback can assign stream after cancellation. Keep the real
        // connect/command promises owned, observe that late stream, and destroy it.
        while (actual.size) { await Promise.allSettled([...actual]); observeSocket(); }
        observeSocket();
        await Promise.all([...sockets.values()]);
      })().finally(() => {
        client.off("connect", observeSocket); client.off("close", disconnected); client.off("end", ended);
        this.progressPublishers.delete(publisher);
      });
      return closing;
    };
    const aborted = () => { void close(); };
    const disconnected = () => { observeSocket(); if (!stopped) void close(); };
    const ended = () => { if (!stopped) void close(); };
    // Never let a native error escape into the SDK's default raw console handler.
    client.on("error", aborted); client.on("connect", observeSocket); client.on("close", disconnected); client.on("end", ended);
    const publisher: McpProgressPublisher = {
      publish: async (event: McpProgressEvent) => {
        if (stopped || this.closed || options.signal.aborted || busy) throw new Error("MCP progress publisher is unavailable.");
        busy = true;
        const timer = setTimeout(aborted, options.timeoutMs);
        try {
          if (Object.hasOwn(event, "seq")) throw new Error();
          const parsed = EventSchema.safeParse(event);
          if (!parsed.success || parsed.data.type !== "item/mcpToolCall/progress" || parsed.data.sessionId !== sessionId
            || parsed.data.total !== undefined && parsed.data.total < parsed.data.progress) throw new Error();
          const payload = JSON.stringify(parsed.data);
          connecting ??= tracked(() => client.connect());
          await connecting; observeSocket();
          if (stopped || this.closed || options.signal.aborted) throw new Error();
          const result = await tracked(() => client.eval(PUBLISH_LIVE, 1, keys.purgeMarker, keys.eventChannel, payload));
          this.assertPublishResult(sessionId, result);
          if (stopped || this.closed || options.signal.aborted) throw new Error();
        } catch (error) {
          await close();
          if (error instanceof RedisSessionPurgedError) throw error;
          throw new Error("MCP progress publisher is unavailable.");
        } finally { clearTimeout(timer); busy = false; }
      },
      close,
    };
    this.progressPublishers.add(publisher);
    options.signal.addEventListener("abort", aborted, { once: true });
    if (options.signal.aborted) aborted();
    return publisher;
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

  publish(sessionId: string, event: Event): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Redis event bus is closed"));
    // Register before even serialization can suspend/reenter. Subscriber-only stop keeps publishing
    // available; full owner close fences/cancels it. A process may close live hints after bounded
    // drain while durable SQL users still settle; their existing hint-failure handling remains valid.
    const work = Promise.resolve().then(() => this.publishOwned(sessionId, event));
    this.publisherWork.add(work);
    void work.then(() => this.publisherWork.delete(work), () => this.publisherWork.delete(work));
    return work;
  }

  private async publishOwned(sessionId: string, event: Event): Promise<void> {
    if (this.closed) throw new Error("Redis event bus is closed");
    const payload = JSON.stringify(event);
    const seq = (event as { seq?: number }).seq;
    const keys = redisSessionKeys(sessionId, this.opts.prefix);
    if (typeof seq === "number") {
      const result = await (this.pub as any).eventPublishPersisted(
        keys.stream,
        keys.purgeMarker,
        String(this.opts.maxLen ?? 2_000),
        String(seq),
        payload,
        String(this.opts.hotWindowMs ?? 3_600_000),
        keys.eventChannel,
      ) as unknown;
      this.assertPublishResult(sessionId, result);
    } else {
      const result = await (this.pub as any).eventPublishLive(
        keys.purgeMarker,
        keys.eventChannel,
        payload,
      ) as unknown;
      this.assertPublishResult(sessionId, result);
    }
  }

  private assertPublishResult(sessionId: string, result: unknown): void {
    if (Array.isArray(result) && Number(result[0]) === -1) {
      throw new RedisSessionPurgedError(sessionId);
    }
    if (!Array.isArray(result) || Number(result[0]) !== 1) {
      throw new Error("Redis event publish transaction failed");
    }
  }

  private assertCanSubscribe(): void {
    if (this.closed || this.subscriberStopping) throw new Error("Redis event bus is closed");
    if (this.subscriptionUnknown) throw new Error("Redis event bus subscription state is unknown");
  }

  private async unsubscribeChannel(channel: string): Promise<void> {
    try { await this.sub.unsubscribe(channel); }
    catch (error) {
      // Retain identity until final owner close; no ready/reconnect event upgrades unknown to ACK.
      this.subscriptionUnknown = true;
      this.unknownChannels.add(channel);
      throw error;
    }
  }

  subscribe(sessionId: string, listener: EventListener, opts?: EventSubscriptionOptions): Promise<() => Promise<void>> {
    const work = Promise.resolve().then(() => this.subscribeOwned(sessionId, listener, opts));
    this.subscriptionWork.add(work);
    void work.then(() => this.subscriptionWork.delete(work), () => this.subscriptionWork.delete(work));
    return work;
  }

  private async subscribeOwned(sessionId: string, listener: EventListener, opts?: EventSubscriptionOptions) {
    this.assertCanSubscribe();
    await this.ready;
    this.assertCanSubscribe();
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
      this.assertCanSubscribe();
      try { await this.sub.subscribe(channel); }
      catch (error) {
        // A SUBSCRIBE response loss can also leave a channel on the shared connection.
        this.subscriptionUnknown = true; this.unknownChannels.add(channel); throw error;
      }
      if (this.closed || this.subscriberStopping || this.subscriptionUnknown) {
        // Another channel can become unknown while this actual command is in flight. Do not
        // publish a new local listener after the fence; own this late registration's cleanup.
        if (!this.closed && !this.subscriberStopping) await this.unsubscribeChannel(channel).catch(() => {});
        this.assertCanSubscribe();
      }
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
        if (!this.closed && !this.subscriberStopping) await this.unsubscribeChannel(channel);
      }
    });
    let removal: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (removal) return removal;
      if (!deactivate()) return removal = Promise.resolve();
      // Fence callbacks synchronously, but retain the actual per-channel command as the close
      // barrier. Rejection means command settled, not server-channel removal: unsubscribeChannel
      // retains that unknown state and fences future admission. Existing listeners keep working.
      // One observer never closes the shared subscriber transport.
      return removal = remove().catch(() => {}).then(() => this.subscriberStopping ? this.stopSubscriptions() : undefined);
    };
    try {
      if (replaying) {
        const after = opts!.afterSeq!;
        const entries = await this.pub.xrange(this.stream(sessionId), "-", "+");
        let maxSeq = after;
        for (const [, fields] of entries) {
          if (!entry.active || this.subscriberStopping || this.closed) throw new Error("Redis event bus is closed");
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
          if (!entry.active || this.subscriberStopping || this.closed) throw new Error("Redis event bus is closed");
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

  private cancelClient(client: Redis, sockets: Map<Redis["stream"], Promise<void>>): void {
    // Cancellation must precede every join that might depend on this socket being closed.
    try { client.disconnect(false); } catch (error) { this.nativeFailures.record(error); }
    this.observeSocket(client, sockets);
    for (const owned of sockets.keys()) {
      try { owned.destroy(); } catch (error) { this.nativeFailures.record(error); }
    }
  }

  /** Subscriber-only stop: no new subscriber work, actual native cancellation now.
   * This lower-level operation leaves publishing/progress available; it cannot by itself unblock
   * a process user awaiting a publisher command or an afterSeq XRANGE. */
  stopSubscriptions(): Promise<void> {
    if (this.stoppingSubscriptions) return this.stoppingSubscriptions;
    this.subscriberStopping = true;
    this.rejectReady?.(new Error("Redis event bus is closed")); this.rejectReady = undefined;
    for (const set of this.listeners.values()) for (const entry of set) {
      entry.active = false;
      if (entry.recoveryTimer) clearTimeout(entry.recoveryTimer);
    }
    this.cancelClient(this.sub, this.subscriberSockets);
    return this.stoppingSubscriptions = (async () => {
      while (this.channelOps.size) await Promise.allSettled([...this.channelOps.values()]);
      while (this.subscriberSockets.size) await Promise.all([...this.subscriberSockets.values()]);
      this.listeners.clear();
      this.nativeFailures.throwIfAny();
    })();
  }

  /** Full native owner stop/join. Cancellation starts synchronously, before the returned join.
   * A process can start this after bounded drain, then join its HTTP/Host business users while
   * keeping SQL/authority/ciphers alive. Calling close again returns the same actual barrier. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const subscriberClose = this.stopSubscriptions();
    const progressClose = this.nativeFailures.start([...this.progressPublishers].map(publisher => () => publisher.close()));
    // No QUIT acknowledgement/race is used as a socket receipt. Stop the final owned publisher
    // before awaiting possibly black-holed command promises; late callers get their real rejection.
    this.cancelClient(this.pub, this.publisherSockets);
    return this.closing = (async () => {
      await this.nativeFailures.stage([() => subscriberClose, () => progressClose]);
      while (this.publisherWork.size || this.subscriptionWork.size || this.channelOps.size) {
        await Promise.allSettled([...this.publisherWork, ...this.subscriptionWork, ...this.channelOps.values()]);
      }
      while (this.publisherSockets.size || this.subscriberSockets.size) {
        await Promise.all([...this.publisherSockets.values(), ...this.subscriberSockets.values()]);
      }
      this.unknownChannels.clear();
      this.nativeFailures.throwIfAny();
    })();
  }

  /** Re-subscribe first, then ask each owner to catch up from its authoritative durable cursor. */
  private async recoverSubscriptions(): Promise<void> {
    if (this.closed || this.subscriberStopping) return;
    const channels = [...this.listeners.entries()].filter(([, set]) => set.size > 0);
    for (const [channel] of channels) {
      try {
        await this.withChannelLock(channel, async () => {
          if (this.closed || this.subscriberStopping || !this.listeners.get(channel)?.size) return;
          await this.sub.subscribe(channel);
        });
      } catch {
        return; // another ready event will retry after ioredis reconnects again
      }
    }
    for (const [, set] of channels) for (const entry of set) this.triggerRecovery(entry);
  }

  private triggerRecovery(entry: RedisListener): void {
    if (this.closed || this.subscriberStopping || !entry.active || !entry.onReconnect) return;
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
        if (this.closed || this.subscriberStopping || !entry.active) return;
        entry.recoveryPending = false;
        entry.recoveryTimer = setTimeout(() => {
          entry.recoveryTimer = undefined;
          this.triggerRecovery(entry);
        }, 1_000);
        entry.recoveryTimer.unref?.();
      });
  }
}
