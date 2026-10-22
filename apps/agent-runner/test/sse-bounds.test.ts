import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SessionHost, StaticToolRegistry, builtinTools, type AgentEngine, type EngineRun, type EngineSink,
  type EngineTurnParams, type ResolvedModel, type SseResourceLimits } from "@agent-service/core";
import { emptyUsage, type Event } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { SseAdmission, sseResponse } from "../src/sse.js";

const sessionId = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function boundary<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
  const deadline = new Promise<never>((_done, reject) => {
    stop = () => reject(new Error("SSE test boundary cancelled"));
    signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(() => reject(new Error("SSE test boundary not reached")), 5_000);
    if (signal.aborted) stop();
  });
  try { return await Promise.race([value, deadline]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}
const event = (seq: number): Event => ({ type: "session/created", sessionId, emittedAtMs: 1, seq });
function transport(limits: Partial<SseResourceLimits> = {}) {
  const resolved = { maxConnections: 2, maxConnectionsPerTenant: 1, ...limits };
  return { admission: new SseAdmission(resolved), limits: resolved };
}

describe("bounded owned SSE transport", () => {
  it("stops new admission separately from existing signals and waits for idempotent slot release", async context => {
    const admission = new SseAdmission({ maxConnections: 2, maxConnectionsPerTenant: 1 });
    const a = admission.acquire("a"), b = admission.acquire("b");
    try {
      expect(() => admission.acquire("a")).toThrow("SSE connection limit exceeded");
      admission.stopAccepting(); expect(a.signal.aborted).toBe(false);
      expect(() => admission.acquire("c")).toThrow("SSE connection limit exceeded");
      let closed = false; const closing = admission.close().then(() => { closed = true; });
      expect(a.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(true);
      a.release(); a.release(); await Promise.resolve(); expect(closed).toBe(false);
      b.release(); await boundary(closing, context.signal); expect(closed).toBe(true);
    } finally { a.release(); b.release(); await admission.close(); }
  });

  it("drains ignored-send durable/progress/durable frames in order and joins the actual asynchronous disposer", async context => {
    const { admission, limits } = transport(), cleanup = deferred(), disposing = deferred();
    const app = new Hono(); let disposals = 0;
    app.get("/events", c => sseResponse(c, async (send, close) => {
      void send(event(7));
      void send({ type: "item/agentMessage/delta", sessionId, emittedAtMs: 2,
        turnId: "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", itemId: "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", delta: "正文" });
      void send(event(8)); close();
      return async () => { disposals++; disposing.resolve(); await cleanup.promise; };
    }, { heartbeatMs: 60_000, sessionId, limits, permit: admission.acquire("a") }));
    let reading: Promise<string> | undefined;
    try {
      const response = await app.request("/events"); let done = false;
      reading = response.text().then(text => { done = true; return text; });
      await boundary(disposing.promise, context.signal);
      expect(done).toBe(false); expect(() => admission.acquire("a")).toThrow("SSE connection limit exceeded");
      cleanup.resolve(); const text = await boundary(reading, context.signal);
      expect(text.match(/event:/g)).toHaveLength(3); expect(text.indexOf("id: 7")).toBeLessThan(text.indexOf("id: 8"));
      const frames = text.trim().split("\n\n"); expect(frames[1]).not.toMatch(/(?:^|\n)id:/);
      expect(disposals).toBe(1); const next = admission.acquire("a"); next.release();
    } finally { cleanup.resolve(); await reading?.catch(() => {}); await admission.close(); }
  });

  for (const budget of ["events", "bytes"] as const)
    it(`counts the waiting in-flight frame against the ${budget} ceiling`, async context => {
      const sample = event(1), frameBytes = Buffer.byteLength(`id: 1\nevent: ${sample.type}\ndata: ${JSON.stringify(sample)}\n\n`);
      const { admission, limits } = transport({ maxQueuedEvents: budget === "events" ? 1 : 10,
        maxQueuedBytes: budget === "bytes" ? frameBytes * 2 - 1 : 4096, maxFrameBytes: budget === "bytes" ? frameBytes : 4096 });
      const stopped = deferred(), released = deferred(); let first: Promise<void> | undefined, second: Promise<void> | undefined;
      const app = new Hono();
      app.get("/events", c => {
        const permit = admission.acquire("a");
        return sseResponse(c, async (send, _close, signal) => {
        first = send(sample); await Promise.resolve(); // The pump has removed it from queue but cannot hand it off.
        second = send(event(2)); signal.addEventListener("abort", stopped.resolve, { once: true });
        if (signal.aborted) stopped.resolve(); return () => {};
        }, { heartbeatMs: 60_000, sessionId, limits, permit: { signal: permit.signal, release: () => { permit.release(); released.resolve(); } } });
      });
      try {
        const response = await app.request("/events"); await boundary(stopped.promise, context.signal);
        await expect(first).rejects.toThrow("SSE observation closed"); await expect(second).rejects.toThrow("SSE observation closed");
        await expect(response.text()).rejects.toThrow("SSE observation closed");
        await boundary(released.promise, context.signal);
        const next = admission.acquire("a"); next.release();
      } finally { await admission.close(); }
    });

  it("accepts an exact UTF-8 frame boundary including a common 1MiB tool result, and rejects one byte less", async context => {
    const payload: Event = { type: "item/completed", sessionId, emittedAtMs: 1, seq: 1,
      item: { type: "toolResult", id: "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", sessionId,
        turnId: "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", seq: 1, status: "completed", createdAtMs: 1,
        toolCallId: "tool", name: "synthetic", isError: false, content: [{ type: "text", text: "汉" + "x".repeat(1_048_576) }] } };
    const wire = `id: 1\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`, bytes = Buffer.byteLength(wire);
    for (const maximum of [bytes, bytes - 1]) {
      const { admission, limits } = transport({ maxFrameBytes: maximum, maxQueuedBytes: bytes * 2 });
      const app = new Hono();
      app.get("/events", c => sseResponse(c, async (send, close) => { void send(payload); close(); return () => {}; },
        { heartbeatMs: 60_000, sessionId, limits, permit: admission.acquire("a") }));
      try {
        const response = await app.request("/events");
        if (maximum === bytes) expect(await boundary(response.text(), context.signal)).toBe(wire);
        else await expect(response.text()).rejects.toThrow("SSE observation closed");
      } finally { await admission.close(); }
    }
  });

  it("does not extend a blocked frame's stall deadline when later events keep arriving", async context => {
    const { admission, limits } = transport({ writeStallMs: 40 }), stopped = deferred();
    const app = new Hono(); let sent = 0, interval: ReturnType<typeof setInterval> | undefined;
    app.get("/events", c => sseResponse(c, async (send, _close, signal) => {
      signal.addEventListener("abort", stopped.resolve, { once: true });
      void send(event(++sent)); interval = setInterval(() => { void send(event(++sent)); }, 5);
      return () => { clearInterval(interval); };
    }, { heartbeatMs: 60_000, sessionId, limits, permit: admission.acquire("a") }));
    try {
      const response = await app.request("/events"); await boundary(stopped.promise, context.signal);
      expect(sent).toBeLessThan(256); await expect(response.text()).rejects.toThrow("SSE observation closed");
    } finally { clearInterval(interval); await admission.close(); }
  });

  it("coalesces heartbeats behind a slow reader without overflowing a one-event queue", async context => {
    const { admission, limits } = transport({ maxQueuedEvents: 1, writeStallMs: 1000 });
    const app = new Hono(); let aborted = false;
    app.get("/events", c => sseResponse(c, async (_send, _close, signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true }); return () => {};
    }, { heartbeatMs: 1, sessionId, limits, permit: admission.acquire("a") }));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await app.request("/events"); await pause(20, undefined, { signal: context.signal });
      expect(aborted).toBe(false); reader = response.body!.getReader();
      const first = await boundary(reader.read(), context.signal);
      expect(new TextDecoder().decode(first.value)).toContain("event: heartbeat");
      expect(new TextDecoder().decode(first.value)).not.toContain("id:");
      await reader.cancel(); expect(aborted).toBe(true);
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); await admission.close(); }
  });

  it("holds the permit across cancelled late attachment and delayed producer cleanup", async context => {
    const { admission, limits } = transport(), entered = deferred(), attached = deferred(), disposing = deferred(), disposed = deferred();
    const app = new Hono(); let sourceSignal: AbortSignal | undefined;
    app.get("/events", c => sseResponse(c, async (_send, _close, signal) => {
      sourceSignal = signal; entered.resolve(); await attached.promise;
      return async () => { disposing.resolve(); await disposed.promise; };
    }, { heartbeatMs: 60_000, sessionId, limits, permit: admission.acquire("a") }));
    let cancelling: Promise<void> | undefined;
    try {
      const response = await app.request("/events"); await boundary(entered.promise, context.signal);
      cancelling = response.body!.cancel(); expect(sourceSignal?.aborted).toBe(true);
      expect(() => admission.acquire("a")).toThrow("SSE connection limit exceeded");
      const other = admission.acquire("b"); other.release();
      attached.resolve(); await boundary(disposing.promise, context.signal);
      expect(() => admission.acquire("a")).toThrow("SSE connection limit exceeded");
      disposed.resolve(); await boundary(cancelling, context.signal);
      const next = admission.acquire("a"); next.release();
    } finally { attached.resolve(); disposed.resolve(); await cancelling?.catch(() => {}); await admission.close(); }
  });
});

async function nativeServer(app: Hono) {
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await new Promise<void>((done, reject) => { server.once("listening", done); server.once("error", reject); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("native SSE listener missing");
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    const closing = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    server.closeAllConnections(); await closing;
  } };
}

describe("native SSE cancellation and slow-reader handoff", () => {
  for (const mode of ["cancel", "stall"] as const)
    it(`joins producer disposal and native socket close after a real ${mode}`, async context => {
      const { admission, limits } = transport({ maxQueuedEvents: 2, maxQueuedBytes: 131_072, maxFrameBytes: 65_536, writeStallMs: 100 });
      const stopped = deferred(), cleanup = deferred(), disposing = deferred();
      const app = new Hono(); let sent = 0;
      app.get("/events", c => sseResponse(c, async (send, _close, signal) => {
        signal.addEventListener("abort", stopped.resolve, { once: true });
        const producer = (async () => {
          try {
            while (!signal.aborted && sent < 10_000) await send({ type: "item/agentMessage/delta", sessionId, emittedAtMs: 1,
              turnId: "turn_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", itemId: "item_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b", delta: String(++sent) + "x".repeat(48_000) });
          } catch { /* Force close fences this producer. */ }
        })();
        return async () => { disposing.resolve(); await cleanup.promise; await producer; };
      }, { heartbeatMs: 60_000, sessionId, limits, permit: admission.acquire("a") }));
      const server = await nativeServer(app); let response: IncomingMessage | undefined, socket: Socket | undefined;
      const request = httpRequest(server.url + "/events"); const received = deferred(), requestClosed = deferred(), socketClosed = deferred();
      request.once("socket", value => { socket = value; value.once("close", socketClosed.resolve); });
      request.once("close", requestClosed.resolve); request.on("error", () => {});
      request.once("response", value => { response = value; value.on("error", () => {}); value.pause(); received.resolve(); });
      const cancel = () => { response?.destroy(); request.destroy(); cleanup.resolve(); };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        request.end(); await boundary(received.promise, context.signal);
        if (mode === "cancel") { response?.destroy(); request.destroy(); }
        await boundary(stopped.promise, context.signal); await boundary(disposing.promise, context.signal);
        expect(() => admission.acquire("a")).toThrow("SSE connection limit exceeded");
        expect(sent).toBeGreaterThan(0); expect(sent).toBeLessThan(10_000);
        cleanup.resolve(); await boundary(admission.close(), context.signal);
        response?.destroy(); request.destroy(); await boundary(requestClosed.promise, context.signal); await boundary(socketClosed.promise, context.signal);
        expect(socket?.destroyed).toBe(true);
      } finally {
        context.signal.removeEventListener("abort", cancel); cancel(); await admission.close();
        await requestClosed.promise; await server.close();
      }
    });
});

async function appFixture(block?: ReturnType<typeof deferred>) {
  const store = new MemorySessionStore(), bus = new MemoryEventBus(), tools = new StaticToolRegistry(builtinTools);
  await store.createApiKey("a", "key-a", hashApiKey("key-a"), ["admin", "runtime"]);
  await store.createApiKey("b", "key-b", hashApiKey("key-b"), ["admin", "runtime"]);
  const cipher = new LocalAesGcmCipher("33".repeat(32));
  const providers = new ProviderService({ store, cipher, platform: [ProviderService.preset("dashscope", "x")], assertBaseUrl: async () => {} });
  let dispatches = 0, steers = 0; const started = deferred();
  const engine: AgentEngine = { name: "sse-test", start(_params: EngineTurnParams, sink: EngineSink): EngineRun {
    dispatches++;
    const done = (async () => {
      await sink.onStepStart(1); started.resolve(); if (block) await block.promise;
      const answer = { text: "synthetic", toolCalls: [], usage: { ...emptyUsage(), costCNY: 0 }, stopReason: "stop" as const, provider: "fake", model: "fake" };
      await sink.onAssistantMessage(answer); await sink.onStepEnd(1, answer); return { steps: 1, aborted: false };
    })();
    return { done, steer: () => { steers++; }, interrupt: () => { block?.resolve(); } };
  } };
  const resolved: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 1000, input: ["text"], apiKey: async () => "k" };
  const { admission, limits } = transport();
  const host = new SessionHost({ store, bus, lease: new MemoryLeaseStore(), engine, providers: { resolve: async () => resolved }, tools,
    config: { runnerId: "sse-runner", runnerAddr: "local", leaseHoldMs: 1000, sseLimits: limits } });
  const app = createApp({ store, host, providers, tools, runnerId: "sse-runner", internalRouterToken: "sse-test-internal-token-000001",
    heartbeatMs: 60_000, maxBodyBytes: 1_000_000, sseAdmission: admission, sseLimits: limits, ready: () => true,
    encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }),
    decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId), assertPublicUrl: async () => {} });
  const call = (tenant: "a" | "b", path: string, init: RequestInit = {}) => app.request(path, { ...init,
    headers: { authorization: `Bearer key-${tenant}`, "x-user-id": "u", "content-type": "application/json", ...init.headers } });
  const sessions: Record<string, string> = {};
  for (const tenant of ["a", "b"] as const) {
    const agent = await (await call(tenant, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "sse", model: { provider: "dashscope", model: "qwen-plus" } }) })).json() as { id: string };
    const session = await (await call(tenant, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) })).json() as { id: string };
    sessions[tenant] = session.id;
  }
  return { store, host, app, call, admission, sessions, started, counts: () => ({ dispatches, steers }), async close() {
    block?.resolve(); await host.drain(1000); await admission.close(); await bus.close();
  } };
}

describe("shared GET/POST SSE admission before mutation", () => {
  it("returns 429 without a new turn or model call, preserves neighboring tenant room, and admits exact replay as JSON", async context => {
    const f = await appFixture(); let observer: Response | undefined, other: Response | undefined;
    const input = [{ type: "text", text: "synthetic" }];
    try {
      const initial = await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", headers: { "idempotency-key": "existing" }, body: JSON.stringify({ input, stream: false }) });
      const accepted = await initial.json() as { turn: { id: string } }; expect(initial.status).toBe(202);
      await boundary(f.started.promise, context.signal);
      await boundary((async () => { while (f.host.activeTurn(f.sessions.a!)) await pause(1, undefined, { signal: context.signal }); })(), context.signal);
      observer = await f.call("a", `/v1/sessions/${f.sessions.a}/events`); expect(observer.status).toBe(200);
      const before = await f.store.listTurns(f.sessions.a!, { limit: 100 });
      const denied = await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", body: JSON.stringify({ input }) });
      expect(denied.status).toBe(429); expect(await denied.json()).toMatchObject({ error: { code: "quota_exceeded" } });
      expect(await f.store.listTurns(f.sessions.a!, { limit: 100 })).toEqual(before); expect(f.counts()).toEqual({ dispatches: 1, steers: 0 });
      expect((await f.call("a", `/v1/sessions/${f.sessions.a}/events`)).status).toBe(429);
      other = await f.call("b", `/v1/sessions/${f.sessions.b}/events`); expect(other.status).toBe(200);
      const replay = await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", headers: { "idempotency-key": "existing" }, body: JSON.stringify({ input, stream: true }) });
      expect(replay.status).toBe(200); expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(replay.headers.get("content-type")).toContain("application/json");
      expect(await replay.json()).toMatchObject({ turn: { id: accepted.turn.id } }); expect(f.counts().dispatches).toBe(1);
    } finally { await observer?.body?.cancel().catch(() => {}); await other?.body?.cancel().catch(() => {}); await f.close(); }
  });

  it("rejects a full-slot streaming steer before changing the running input or calling engine.steer", async context => {
    const block = deferred(), f = await appFixture(block); let observer: Response | undefined;
    try {
      expect((await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "first" }], stream: false }) })).status).toBe(202);
      await boundary(f.started.promise, context.signal);
      observer = await f.call("a", `/v1/sessions/${f.sessions.a}/events`);
      const before = await f.store.listItems(f.sessions.a!, { limit: 100 });
      const denied = await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "must not steer" }], busyPolicy: "steer" }) });
      expect(denied.status).toBe(429); expect(f.counts()).toEqual({ dispatches: 1, steers: 0 });
      expect(await f.store.listItems(f.sessions.a!, { limit: 100 })).toEqual(before);
    } finally { block.resolve(); await observer?.body?.cancel().catch(() => {}); await f.close(); }
  });

  it("starts the already-accepted turn exactly once when initial subscription attachment fails", async context => {
    const f = await appFixture(), failure = vi.spyOn(f.host, "subscribe").mockRejectedValue(new Error("fixture attach failure"));
    try {
      const response = await f.call("a", `/v1/sessions/${f.sessions.a}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "start once" }] }) });
      await expect(response.text()).rejects.toThrow("SSE observation closed");
      await boundary(f.started.promise, context.signal); expect(f.counts()).toEqual({ dispatches: 1, steers: 0 });
    } finally { failure.mockRestore(); await f.close(); }
  });
});
