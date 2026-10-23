import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import type { Event } from "@agent-service/protocol";
import { RedisEventBus } from "../src/index.js";
import { newId } from "./conformance.js";

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
const BUS_COMMANDS = ["+auth", "+hello", "+select", "+ping", "+quit", "+client", "+info",
  "+subscribe", "+unsubscribe", "+eval", "+evalsha", "+exists", "+publish"];

function testBoundary<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}

// Runs only against root's new, owned integration Redis. ACL changes target a fresh test user,
// never the default user or an existing tenant. No application authority or lease is exercised.
if (process.env.AGENT_SERVICE_INTEGRATION) {
  describe("Redis event observer unknown subscription state", () => {
    for (const rejectUnsubscribe of [false, true]) {
      it(`${rejectUnsubscribe ? "fences new subscriptions after a real ACL rejection" : "keeps admission open after an acknowledged unsubscribe"} without closing another listener`, async () => {
        const suffix = randomBytes(12).toString("hex"), username = `as_test_bus_${suffix}`;
        const password = randomBytes(24).toString("hex"), prefix = `bus-unknown-${suffix}`;
        const firstId = newId("sess"), otherId = newId("sess"), newSessionId = newId("sess");
        const channel = (sid: string) => `${prefix}:evt:{${sid}}`;
        const admin = new Redis(REDIS_URL);
        let bus: RedisEventBus | undefined, first: (() => Promise<void>) | undefined;
        let other: (() => Promise<void>) | undefined, replacement: (() => Promise<void>) | undefined;
        let createdUser = false;
        try {
          await admin.acl("SETUSER", username, "reset", "on", `>${password}`, `~${prefix}:*`, `&${prefix}:*`, ...BUS_COMMANDS);
          createdUser = true;
          const url = new URL(REDIS_URL); url.username = username; url.password = password;
          bus = new RedisEventBus(url.toString(), { prefix });
          const sub = (bus as unknown as { sub: Redis }).sub;
          const received: Event[] = [], removed: Event[] = [];
          first = await bus.subscribe(firstId, event => removed.push(event));
          other = await bus.subscribe(otherId, event => received.push(event));
          const nativeSocket = sub.stream;
          const nativeClosed = nativeSocket.closed ? Promise.resolve()
            : new Promise<void>(resolve => nativeSocket.once("close", () => resolve()));
          const unsubscribe = vi.spyOn(sub, "unsubscribe"), subscribe = vi.spyOn(sub, "subscribe");
          const quit = vi.spyOn(sub, "quit");
          if (rejectUnsubscribe) await admin.acl("SETUSER", username, "-unsubscribe");
          const removedCommand = first(); expect(first()).toBe(removedCommand); await removedCommand;
          expect(unsubscribe).toHaveBeenCalledOnce(); expect(quit).not.toHaveBeenCalled();
          expect(sub.status).toBe("ready");
          expect(await admin.pubsub("NUMSUB", channel(firstId))).toEqual([channel(firstId), rejectUnsubscribe ? 1 : 0]);
          await bus.publish(firstId, { type: "heartbeat", sessionId: firstId, emittedAtMs: 1 });
          await bus.publish(otherId, { type: "heartbeat", sessionId: otherId, emittedAtMs: 2 });
          await vi.waitFor(() => expect(received).toHaveLength(1)); expect(removed).toHaveLength(0);
          if (rejectUnsubscribe) {
            await expect(bus.subscribe(newSessionId, () => {})).rejects.toThrow("Redis event bus subscription state is unknown");
            expect(subscribe).not.toHaveBeenCalled();
            expect(await admin.pubsub("NUMSUB", channel(newSessionId))).toEqual([channel(newSessionId), 0]);
            await expect(unsubscribe.mock.results[0]!.value).rejects.toThrow(/^NOPERM/);
            // Restored permission and an actual disconnect/reconnect are not an unsubscribe ACK.
            await admin.acl("SETUSER", username, "+unsubscribe");
            const ended = new Promise<void>(resolve => sub.once("end", () => resolve()));
            sub.disconnect(); await ended; await nativeClosed; await sub.connect();
            await vi.waitFor(async () => {
              expect(await admin.pubsub("NUMSUB", channel(firstId))).toEqual([channel(firstId), 1]);
              expect(await admin.pubsub("NUMSUB", channel(otherId))).toEqual([channel(otherId), 1]);
            });
            await expect(bus.subscribe(newSessionId, () => {})).rejects.toThrow("Redis event bus subscription state is unknown");
            expect(JSON.stringify(subscribe.mock.calls)).not.toContain(channel(newSessionId));
            await bus.publish(otherId, { type: "heartbeat", sessionId: otherId, emittedAtMs: 3 });
            await vi.waitFor(() => expect(received).toHaveLength(2));
          } else {
            replacement = await bus.subscribe(newSessionId, () => {});
            expect(await admin.pubsub("NUMSUB", channel(newSessionId))).toEqual([channel(newSessionId), 1]);
          }
          const otherClosed = other(); expect(other()).toBe(otherClosed); await otherClosed;
          expect(await admin.pubsub("NUMSUB", channel(otherId))).toEqual([channel(otherId), 0]);
          const closingSocket = sub.stream;
          const closingNative = closingSocket.closed ? Promise.resolve()
            : new Promise<void>(resolve => closingSocket.once("close", () => resolve()));
          const close = bus.close(); expect(bus.close()).toBe(close); await close; await nativeClosed; await closingNative;
          expect(nativeSocket.closed).toBe(true); expect(closingSocket.closed).toBe(true);
          await vi.waitFor(async () => {
            expect(await admin.pubsub("NUMSUB", channel(firstId))).toEqual([channel(firstId), 0]);
            expect(await admin.pubsub("NUMSUB", channel(newSessionId))).toEqual([channel(newSessionId), 0]);
          });
          unsubscribe.mockRestore(); subscribe.mockRestore(); quit.mockRestore();
        } finally {
          // Restore only this owned user so existing listeners can still perform normal cleanup.
          try { if (createdUser) await admin.acl("SETUSER", username, "+unsubscribe"); }
          finally {
            try { await Promise.allSettled([first?.(), other?.(), replacement?.()]); }
            finally {
              try { await bus?.close(); }
              finally {
                try { if (createdUser) await admin.acl("DELUSER", username); }
                finally {
                  const socket = admin.stream;
                  const closed = socket?.closed || !socket ? Promise.resolve()
                    : new Promise<void>(resolve => socket.once("close", () => resolve()));
                  try { await admin.quit(); }
                  finally { admin.disconnect(false); socket?.destroy(); await closed; }
                }
              }
            }
          }
        }
      });
    }

    it("cancels the actual subscriber before joining a close-dependent unsubscribe and keeps late publishing alive", async context => {
      const suffix = randomBytes(12).toString("hex"), prefix = `bus-stop-${suffix}`, sid = newId("sess");
      const channel = `${prefix}:evt:{${sid}}`, stream = `${prefix}:stream:{${sid}}`;
      const bus = new RedisEventBus(REDIS_URL, { prefix }), admin = new Redis(REDIS_URL);
      const sub = (bus as unknown as { sub: Redis }).sub;
      let entered!: () => void;
      const removing = new Promise<void>(resolve => { entered = resolve; });
      let socket: Redis["stream"] | undefined;
      const abort = () => socket?.destroy(); context.signal.addEventListener("abort", abort, { once: true });
      let unsubscribe: ReturnType<typeof vi.spyOn> | undefined, dispose: (() => Promise<void>) | undefined, createdStream = false;
      try {
        dispose = await bus.subscribe(sid, () => {}); socket = sub.stream;
        const nativeClosed = socket.closed ? Promise.resolve()
          : new Promise<void>(resolve => socket!.once("close", () => resolve()));
        // Controlled adapter gate, not a claim that Redis returned this error. The underlying
        // subscription is real, and only an actual native close can settle this command substitute.
        unsubscribe = vi.spyOn(sub, "unsubscribe").mockImplementationOnce(async () => {
          entered(); await nativeClosed; throw new Error("controlled unsubscribe waiting for native close");
        });
        const disposing = dispose(); await testBoundary(removing, context.signal);
        const stopping = bus.stopSubscriptions(); expect(bus.stopSubscriptions()).toBe(stopping);
        await stopping; await disposing; await nativeClosed;
        expect(socket.closed).toBe(true);
        await vi.waitFor(async () => expect(await admin.pubsub("NUMSUB", channel)).toEqual([channel, 0]));
        expect(await admin.exists(stream)).toBe(0);
        await bus.publish(sid, { type: "session/created", sessionId: sid, seq: 1, emittedAtMs: 1 });
        createdStream = true;
        expect(await admin.xlen(stream)).toBe(1);
        const publisherSocket = (bus as unknown as { pub: Redis }).pub.stream;
        expect(publisherSocket.closed).toBe(false);
        const publisherClosed = new Promise<void>(resolve => publisherSocket.once("close", () => resolve()));
        const closing = bus.close(); expect(bus.close()).toBe(closing); await closing; await publisherClosed;
        expect(publisherSocket.closed).toBe(true);
      } finally {
        abort(); await dispose?.(); unsubscribe?.mockRestore(); await bus.close();
        try { if (createdStream) await admin.del(stream); }
        finally {
          const peer = admin.stream;
          const closed = peer?.closed || !peer ? Promise.resolve()
            : new Promise<void>(resolve => peer.once("close", () => resolve()));
          try { await admin.quit(); } finally { admin.disconnect(false); peer?.destroy(); await closed; }
          context.signal.removeEventListener("abort", abort);
        }
      }
    });

    it("fences the first-ready waiter before any subscriber command can be dispatched", async () => {
      const bus = new RedisEventBus(REDIS_URL, { prefix: `bus-first-ready-${randomBytes(8).toString("hex")}` });
      const sub = (bus as unknown as { sub: Redis }).sub, subscribe = vi.spyOn(sub, "subscribe");
      const attaching = bus.subscribe(newId("sess"), () => {}); void attaching.catch(() => {});
      try {
        const stopping = bus.stopSubscriptions(); expect(bus.stopSubscriptions()).toBe(stopping);
        await expect(attaching).rejects.toThrow("Redis event bus is closed");
        await stopping; expect(subscribe).not.toHaveBeenCalled();
        await bus.close();
      } finally { await bus.close(); subscribe.mockRestore(); }
    });
  });
}
