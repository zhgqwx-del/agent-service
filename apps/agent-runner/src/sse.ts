import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Event } from "@agent-service/protocol";

/**
 * SSE writer. Persisted events carry `id: <seq>` so `Last-Event-ID` resumes without gaps; live-only
 * events (deltas, heartbeat) carry no id. Heartbeats keep intermediaries from closing idle streams.
 *
 * `close()` stops accepting new events but everything already queued is still written before the
 * response ends; only a client abort discards the queue.
 */
export function sseResponse(
  c: Context,
  attach: (send: (e: Event) => void, close: () => void) => Promise<() => void>,
  opts: { heartbeatMs: number; sessionId: string },
) {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache");
  return streamSSE(c, async (stream) => {
    let accepting = true;
    let aborted = false;
    let unsub: (() => void) | undefined;
    const queue: Event[] = [];
    let writing: Promise<void> = Promise.resolve();
    const write = (e: Event) => {
      const seq = (e as { seq?: number }).seq;
      return stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: typeof seq === "number" ? String(seq) : undefined });
    };
    const drain = () => {
      writing = writing.then(async () => {
        while (queue.length && !aborted) await write(queue.shift()!);
      }).catch(() => {});
      return writing;
    };
    const send = (e: Event) => {
      if (!accepting) return;
      queue.push(e);
      void drain();
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const close = () => {
      if (!accepting) return;
      accepting = false;
      unsub?.();
      resolveDone();
    };
    stream.onAbort(() => {
      aborted = true;
      close();
    });
    const hb = setInterval(() => {
      if (accepting && !aborted) {
        const event: Event = { type: "heartbeat", sessionId: opts.sessionId, emittedAtMs: Date.now() };
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(close);
      }
    }, opts.heartbeatMs);
    try {
      const u = await attach(send, close);
      // close() may already have run (e.g. the turn finished while we were reading history):
      // assigning here would leak the subscription forever.
      if (accepting) unsub = u;
      else u();
      await done;
      await drain();
    } finally {
      clearInterval(hb);
      close();
    }
  });
}
