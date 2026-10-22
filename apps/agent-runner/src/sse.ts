import type { Context } from "hono";
import { resolveSseLimits, type SseResourceLimits } from "@agent-service/core";
import { ApiError, type Event } from "@agent-service/protocol";

export interface SsePermit { readonly signal: AbortSignal; release(): void }

/** Runner-local observation slots, not a configured-fleet or upstream model quota. */
export class SseAdmission {
  readonly limits: Readonly<SseResourceLimits>;
  private accepting = true;
  private readonly tenants = new Map<string, number>();
  private readonly active = new Set<{ abort: AbortController; done: Promise<void> }>();
  constructor(limits?: Partial<SseResourceLimits>) { this.limits = resolveSseLimits(limits); }

  acquire(tenantId: string): SsePermit {
    if (!tenantId || !this.accepting || this.active.size >= this.limits.maxConnections
      || (this.tenants.get(tenantId) ?? 0) >= this.limits.maxConnectionsPerTenant) {
      throw new ApiError("quota_exceeded", "SSE connection limit exceeded");
    }
    const abort = new AbortController(); let finish!: () => void, released = false;
    const entry = { abort, done: new Promise<void>(resolve => { finish = resolve; }) };
    this.active.add(entry); this.tenants.set(tenantId, (this.tenants.get(tenantId) ?? 0) + 1);
    return Object.freeze({ signal: abort.signal, release: () => {
      if (released) return; released = true; this.active.delete(entry);
      const count = (this.tenants.get(tenantId) ?? 1) - 1;
      if (count) this.tenants.set(tenantId, count); else this.tenants.delete(tenantId);
      finish();
    } });
  }
  stopAccepting(): void { this.accepting = false; }
  async close(): Promise<void> {
    this.stopAccepting(); const entries = [...this.active];
    for (const entry of entries) entry.abort.abort();
    await Promise.all(entries.map(entry => entry.done));
  }
}

type Close = (force?: boolean) => void;
type Disposer = () => void | Promise<void>;
type Frame = { bytes: Uint8Array; heartbeat: boolean; resolve(): void; reject(): void; released: boolean };
const closedError = () => new Error("SSE observation closed");
function ignoredRejection(): Promise<void> {
  const failed = Promise.reject<void>(closedError()); void failed.catch(() => {}); return failed;
}
/** Bound serialization work as well as the resulting UTF-8 frame. No payload in errors. */
function encode(event: Event, maximum: number): Uint8Array {
  let remaining = maximum, root = true;
  const data = JSON.stringify(event, function (key, value: unknown) {
    // This is a lower bound on actual JSON bytes, never a stricter substitute for maxFrameBytes.
    // JSON escaping can expand it by at most a fixed factor; reject the exact final frame below.
    const omitted = value === undefined || typeof value === "function" || typeof value === "symbol";
    if (!root && !Array.isArray(this) && omitted) return value;
    const keyBytes = root || Array.isArray(this) ? 0 : Buffer.byteLength(key) + 3; root = false;
    const valueBytes = typeof value === "string" ? Buffer.byteLength(value) + 2
      : value !== null && typeof value === "object" ? 2 : Buffer.byteLength(JSON.stringify(value) ?? "null");
    remaining -= keyBytes + valueBytes;
    if (remaining < 0) throw closedError(); return value;
  });
  const seq = (event as { seq?: number }).seq;
  if (!/^[A-Za-z0-9/._-]{1,128}$/.test(event.type)
    || seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0)) throw closedError();
  const frame = new TextEncoder().encode(`${seq === undefined ? "" : `id: ${seq}\n`}event: ${event.type}\ndata: ${data}\n\n`);
  if (frame.byteLength > maximum) throw closedError(); return frame;
}

/**
 * One owned pump with a zero-buffer ReadableStream handoff. Budgets include the frame awaiting a
 * downstream read. Normal close drains accepted frames; force/cancel drops them. Keep admission
 * until late attachment, producer disposal and pump work have actually settled.
 */
export function sseResponse(
  c: Context,
  attach: (send: (event: Event) => Promise<void>, close: Close, signal: AbortSignal) => Promise<Disposer>,
  opts: { heartbeatMs: number; sessionId: string; limits?: Partial<SseResourceLimits>; permit?: SsePermit },
): Response {
  const limits = resolveSseLimits(opts.limits), abort = new AbortController(), queue: Frame[] = [];
  let accepting = true, forced = false, heldEvents = 0, heldBytes = 0, heartbeatPending = false;
  let current: Frame | undefined, handed = false, disposer: Disposer | undefined, controller!: ReadableStreamDefaultController<Uint8Array>;
  let wake: (() => void) | undefined, demand = false, pullDone: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined, stall: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const settled = new Promise<void>(resolve => { finish = resolve; });
  const notify = () => { const previous = wake; wake = undefined; previous?.(); };
  const releaseFrame = (frame: Frame) => {
    if (frame.released) return; frame.released = true;
    heldEvents--; heldBytes -= frame.bytes.byteLength;
    if (frame.heartbeat) heartbeatPending = false; frame.bytes = new Uint8Array(0);
  };
  const close: Close = (force = false) => {
    if (force && !forced) {
      forced = true;
      clearTimeout(stall); stall = undefined;
      if (current) { current.reject(); releaseFrame(current); current = undefined; handed = false; }
      for (const frame of queue.splice(0)) { frame.reject(); releaseFrame(frame); }
      try { controller.error(closedError()); } catch { /* Already cancelled or closed. */ }
      pullDone?.(); pullDone = undefined;
    }
    if (accepting) {
      accepting = false; clearInterval(heartbeat);
      // Fence producer work without cancelling accepted frames on a normal drain.
      abort.abort();
    }
    notify();
  };
  const send = (event: Event): Promise<void> => {
    if (!accepting) return ignoredRejection();
    const isHeartbeat = event.type === "heartbeat";
    if (isHeartbeat && heartbeatPending) return Promise.resolve();
    let bytes: Uint8Array;
    try { bytes = encode(event, limits.maxFrameBytes); } catch { close(true); return ignoredRejection(); }
    if (heldEvents >= limits.maxQueuedEvents || heldBytes + bytes.byteLength > limits.maxQueuedBytes) {
      if (isHeartbeat) return Promise.resolve(); close(true); return ignoredRejection();
    }
    let resolve!: () => void, reject!: () => void;
    const delivery = new Promise<void>((done, failed) => { resolve = done; reject = () => failed(closedError()); });
    // Legacy attach callbacks ignore send; observe their failures without losing paced await support.
    void delivery.catch(() => {});
    const frame: Frame = { bytes, heartbeat: isHeartbeat, resolve, reject, released: false };
    heldEvents++; heldBytes += bytes.byteLength; if (isHeartbeat) heartbeatPending = true;
    queue.push(frame); notify(); return delivery;
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { demand = true; notify(); return new Promise<void>(resolve => { pullDone = resolve; }); },
    cancel() { close(true); return settled; },
  }, { highWaterMark: 0 });
  const onAbort = () => close(true);
  c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
  opts.permit?.signal.addEventListener("abort", onAbort, { once: true });
  if (c.req.raw.signal.aborted || opts.permit?.signal.aborted) close(true);

  const pump = async () => {
    while (!forced) {
      if (!current && queue.length) current = queue.shift();
      if (!current) {
        if (!accepting) return;
        await new Promise<void>(resolve => { wake = resolve; }); continue;
      }
      const frame = current;
      if (!demand) {
        stall ??= setTimeout(() => close(true), limits.writeStallMs);
        await new Promise<void>(resolve => { wake = resolve; });
        continue;
      }
      if (forced) return;
      clearTimeout(stall); stall = undefined;
      if (handed) {
        // The next pull acknowledges downstream progress, including Node's native write/drain.
        // Keep the handed-off frame counted until then; enqueue alone is not a write completion.
        frame.resolve(); releaseFrame(frame); current = undefined; handed = false; continue;
      }
      demand = false; controller.enqueue(frame.bytes); handed = true;
      pullDone?.(); pullDone = undefined;
    }
  };
  // Do not use the Hono streaming helper: its swallowed write errors are not a cleanup barrier.
  const attaching = Promise.resolve().then(() => attach(send, close, abort.signal))
    .then(value => { disposer = value; }, () => { close(true); });
  const pumping = pump().catch(() => { close(true); });
  heartbeat = setInterval(() => {
    if (accepting) void send({ type: "heartbeat", sessionId: opts.sessionId, emittedAtMs: Date.now() });
  }, opts.heartbeatMs);
  if (!accepting) clearInterval(heartbeat);
  void (async () => {
    try {
      await pumping; await attaching;
      try { await disposer?.(); } catch { close(true); }
      disposer = undefined;
      if (!forced) { try { controller.close(); } catch { close(true); } }
    } finally {
      close(forced); clearInterval(heartbeat); clearTimeout(stall);
      c.req.raw.signal.removeEventListener("abort", onAbort);
      opts.permit?.signal.removeEventListener("abort", onAbort);
      pullDone?.(); pullDone = undefined; wake = undefined;
      opts.permit?.release(); finish();
    }
  })();
  c.header("Content-Type", "text/event-stream; charset=UTF-8");
  c.header("X-Accel-Buffering", "no"); c.header("Cache-Control", "no-cache");
  return c.newResponse(body);
}
