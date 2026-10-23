import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Readable, type Duplex } from "node:stream";

/** Private per-instance standard Node agents. No global transport or resolver changes.
 * Default AWS credential-provider transports remain outside this agent owner. */
export class RestoreJournalOwnedNativeHttp {
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;
  private readonly sockets = new Set<Duplex>();
  private readonly closes = new Set<Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly lookups = new Set<Promise<void>>();
  private readonly bodies = new Set<Readable>();
  private readonly bodyCloses = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private stopped = false;
  private opened = 0;
  private nativeClosed = 0;
  private lookupStarted = 0;
  private lookupSettled = 0;
  private failure: { reason: unknown } | undefined;
  private readonly abort = (): void => { this.stop(); };

  private readonly ownedLookup: LookupFunction = (hostname, options, callback) => {
    if (this.stopped) throw Object.assign(Error("owned_transport_stopped"), { name: "AbortError" });
    let complete!: () => void, finished = false;
    const task = new Promise<void>(resolve => { complete = resolve; });
    this.lookups.add(task); this.lookupStarted += 1;
    const finish = () => {
      if (finished) return;
      finished = true; this.lookupSettled += 1; this.lookups.delete(task); complete();
    };
    try {
      // Socket destruction does not cancel getaddrinfo. Keep ownership until the original
      // system callback actually returns, including an all-address lookup used by Node.
      lookup(hostname, options, (error, address, family) => {
        try { callback(error, address, family); } finally { finish(); }
      });
    } catch (error) { finish(); throw error; }
  };

  constructor(private readonly externalSignal?: AbortSignal) {
    this.httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, lookup: this.ownedLookup });
    this.httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1, lookup: this.ownedLookup });
    this.wrap(this.httpAgent); this.wrap(this.httpsAgent);
    externalSignal?.addEventListener("abort", this.abort, { once: true });
    if (externalSignal?.aborted) this.stop();
  }
  private wrap(agent: HttpAgent) {
    const original = agent.createConnection.bind(agent);
    agent.createConnection = (...args: Parameters<typeof original>) => {
      if (this.stopped) throw Object.assign(Error("owned_transport_stopped"), { name: "AbortError" });
      const socket = Reflect.apply(original, agent, args) as ReturnType<typeof original>;
      if (!socket) throw Error("native_socket_not_observable");
      this.sockets.add(socket); this.opened += 1;
      const closed = new Promise<void>(done => socket.once("close", () => {
        this.sockets.delete(socket); this.nativeClosed += 1; done();
      }));
      this.closes.add(closed); void closed.then(() => this.closes.delete(closed));
      return socket;
    };
  }
  /** Register a successful SDK body even if its outer deadline already won. */
  observeBody(body: unknown): void {
    if (body === undefined || body instanceof Uint8Array) return;
    if (!(body instanceof Readable)) throw Error("owned_body_not_observable");
    if (body.closed || this.bodies.has(body)) return;
    this.bodies.add(body);
    const absorbError = () => {}; body.on("error", absorbError);
    const closed = new Promise<void>(done => body.once("close", () => {
      this.bodies.delete(body); body.off("error", absorbError); done();
    }));
    this.bodyCloses.add(closed); void closed.then(() => this.bodyCloses.delete(closed));
    if (this.stopped) {
      try { body.destroy(); } catch (reason) { this.failure ??= { reason }; }
    }
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(() => {
      if (this.stopped) throw Object.assign(Error("owned_transport_stopped"), { name: "AbortError" });
      return work();
    });
    this.pending.add(task); void task.then(() => this.pending.delete(task), () => this.pending.delete(task)); return task;
  }
  stop(): Readonly<{ reason: unknown }> | undefined {
    const remember = (reason: unknown) => { this.failure ??= { reason }; };
    if (!this.stopped) {
      this.stopped = true;
      try { this.controller.abort(); } catch (error) { remember(error); }
    }
    for (const action of [() => this.httpAgent.destroy(), () => this.httpsAgent.destroy(),
      ...[...this.sockets].map(socket => () => socket.destroy()),
      ...[...this.bodies].map(body => () => body.destroy())]) {
      try { action(); } catch (error) { remember(error); }
    }
    return this.failure;
  }
  snapshot() {
    return Object.freeze({ opened: this.opened, nativeClosed: this.nativeClosed, pending: this.pending.size,
      activeSockets: this.sockets.size, stopped: this.stopped,
      lookupStarted: this.lookupStarted, lookupSettled: this.lookupSettled, activeLookups: this.lookups.size,
      activeBodies: this.bodies.size });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stop();
      try {
        while (this.pending.size || this.closes.size || this.lookups.size || this.bodyCloses.size)
          await Promise.allSettled([...this.pending, ...this.closes, ...this.lookups, ...this.bodyCloses]);
      } finally { this.externalSignal?.removeEventListener("abort", this.abort); }
      if (this.failure) throw this.failure.reason;
    })();
  }
}
