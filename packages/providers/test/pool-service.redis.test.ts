import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { MemorySessionStore, RedisProviderPoolCoordinator, RedisProviderQuotaCoordinator } from "@agent-service/store";
import { PiEngine, getPiProviderStepFailure } from "../../core/src/engine/pi.js";
import type { AssistantStepResult, EngineSink } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const owner = { tenantId: "native-pool-tenant", userId: "native-pool-user" }, ref = { provider: "native-pool-provider", model: "native-pool-model" };
const keys = ["test-only-native-pool-a", "test-only-native-pool-b"];
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function wire() { return `data: ${JSON.stringify({ id: "native-pool-fixture", object: "chat.completion.chunk", created: 1, model: ref.model,
  choices: [{ index: 0, delta: { role: "assistant", content: "native pool response" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`; }
function redisUrl() {
  const raw = process.env.REDIS_TEST_URL;
  if (!raw) throw new Error("Pool fixture requires explicit local Redis.");
  const parsed = new URL(raw);
  if (!["redis:", "rediss:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || !/^[1-9][0-9]*$/.test(parsed.port) || Number(parsed.port) > 65535 || !/^\/(?:0|[1-9][0-9]*)$/.test(parsed.pathname)
    || parsed.search || parsed.hash || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error("Pool fixture requires explicit local Redis.");
  return raw;
}

async function fixture(signal: AbortSignal, work: (f: {
  services: ProviderService[]; pools: RedisProviderPoolCoordinator[]; labels: string[];
  request(index: number, principal?: typeof owner): Promise<Response>;
  nativeResponse: Set<ServerResponse>; onRequest(handler: (request: IncomingMessage, response: ServerResponse, label: string) => void): void;
  track<T>(promise: Promise<T>): Promise<T>;
}) => Promise<void>, options: { count?: number; concurrency?: number } = {}) {
  const url = redisUrl(), prefix = `pool-service-${randomUUID()}`, namespaceId = `pool-service-${randomUUID()}`;
  const pools = [0, 1].map(() => new RedisProviderPoolCoordinator({ url, prefix, namespaceId }));
  const quotas = [0, 1].map(() => new RedisProviderQuotaCoordinator({ url, prefix, namespaceId }));
  const store = new MemorySessionStore(), responses = new Set<Response>(), nativeResponse = new Set<ServerResponse>(), sockets = new Set<Socket>();
  const pending = new Set<Promise<unknown>>(), labels: string[] = [];
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  };
  let handler = (_request: IncomingMessage, response: ServerResponse, _label: string) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(wire());
  };
  const server = createServer((request, response) => {
    const label = request.headers.authorization === `Bearer ${keys[0]}` ? "a" : request.headers.authorization === `Bearer ${keys[1]}` ? "b" : "wrong";
    labels.push(label); nativeResponse.add(response); response.once("close", () => nativeResponse.delete(response)); handler(request, response, label);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let listening = false, passed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    listening = true; const address = server.address();
    if (!address || typeof address === "string") throw new Error("Pool HTTP fixture is unavailable.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const services = pools.map((coordinator, i) => new ProviderService({ store, cipher: new LocalAesGcmCipher("41".repeat(32)), assertBaseUrl: async () => {},
      platform: [{ config: { id: ref.provider, api: "openai-completions", baseUrl, headers: {}, quota: {}, fallback: [],
        models: [{ id: ref.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text"], reasoning: false,
          price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] },
      keyPool: keys.slice(0, options.count ?? 2).map((apiKey, slot) => ({ id: `slot-${slot}`, version: "v1", apiKey })) }],
      quota: { coordinator: quotas[i]!, tenant: options.concurrency ? { concurrency: options.concurrency } : {}, user: {} },
      keyPool: { coordinator, policy: { threshold: 1, cooldownMs: 100, windowMs: 1000, rateLimitCooldownMs: 1000 } },
      persistedProviderFailureCaptureActive: true }));
    await Promise.all([...pools, ...quotas].map(coordinator => coordinator.assertReady()));
    const request = (index: number, principal = owner) => track((async () => {
      signal.throwIfAborted(); const model = await services[index]!.resolve(principal, ref), request = model.createRequest!();
      const apiKey = await request.apiKey!(signal);
      const response = await request.fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: "{}", signal });
      responses.add(response); return response;
    })());
    await work({ services, pools, labels, request, nativeResponse, onRequest: next => { handler = next; }, track }); passed = true;
  } finally {
    // Exact random namespaces remain as evidence/TTL state; no glob DEL or shared Redis reset.
    const cancelling = Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
    for (const response of nativeResponse) response.destroy();
    let httpClose: Promise<void> | undefined;
    if (listening) { httpClose = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); }
    for (const socket of sockets) socket.destroy();
    const socketClose = [...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve())));
    const joined = await Promise.allSettled([cancelling, ...pending, ...socketClose, ...(httpClose ? [httpClose] : [])]);
    const cancelled = await cancelling;
    const closed = await Promise.allSettled([...pools, ...quotas].map(coordinator => coordinator.close())); await store.close();
    if (passed && [...joined, ...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("Pool native fixture cleanup is unproven.");
  }
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("Platform pool actual Redis and native HTTP", () => {
  it("shares rotation and a credential rejection across two service instances and tenants without in-fetch retry", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response, label) => { response.writeHead(label === "a" ? 401 : 200); response.end("body"); });
    const first = await f.request(0); expect(first.status).toBe(401); await first.text(); expect(f.labels).toEqual(["a"]);
    const other = { tenantId: "other-native-pool-tenant", userId: "other-native-pool-user" };
    const second = await f.request(1, other); expect(second.status).toBe(200); await second.text();
    const third = await f.request(0); await third.text(); expect(f.labels).toEqual(["a", "b", "b"]);
  }));

  it("applies an actual 429 cooldown across service instances and does not dispatch another request", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response) => { response.writeHead(429, { "retry-after": "3600" }); response.end("body"); });
    const first = await f.request(0); expect(first.status).toBe(429); await first.text();
    await expect(f.request(1, { tenantId: "other-native-pool-tenant", userId: "other-native-pool-user" })).rejects.toMatchObject({ reason: "open" });
    expect(f.labels).toEqual(["a"]);
  }, { count: 1 }));

  it("keeps the real HTTP body and pool permit owned until coordinator close cancels the socket", async context => fixture(context.signal, async f => {
    const peerClosed = barrier();
    f.onRequest((_request, response) => { response.once("close", peerClosed.resolve); response.writeHead(200); response.write("held body"); });
    const first = await f.request(0); const closing = f.pools[0]!.close();
    await peerClosed.promise; await closing; await expect(first.text()).rejects.toBeInstanceOf(Error);
    expect(f.labels).toEqual(["a"]);
  }, { count: 1 }));

  it("gives actual Pi an unattempted draining result after a native credential rejection disabled the sole slot", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response) => { response.writeHead(401); response.end("private-upstream-body"); });
    const messages: AssistantStepResult[] = [];
    const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
      async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; },
      onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
    const firstModel = await f.services[0]!.resolve(owner, ref);
    const first = new PiEngine(f.services[0]!.models).start({ model: firstModel, systemPrompt: "fixture", history: [], tools: [],
      input: [{ type: "text", text: "fixture" }], signal: context.signal, toolContext: { principal: owner, sessionId: "native-pool-session", turnId: "native-pool-turn" } }, sink);
    const failed = await f.track(first.done); expect(failed.error).toBe("provider_error");
    expect(getPiProviderStepFailure(failed)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
    expect(messages).toHaveLength(1); expect(Object.hasOwn(messages[0]!.usage, "costCNY")).toBe(false);
    const secondModel = await f.services[1]!.resolve(owner, ref); messages.length = 0;
    const second = new PiEngine(f.services[1]!.models).start({ model: secondModel, systemPrompt: "fixture", history: [], tools: [],
      input: [{ type: "text", text: "fixture" }], signal: context.signal, toolContext: { principal: owner, sessionId: "native-pool-session", turnId: "native-pool-turn-2" } }, sink);
    const denied = await f.track(second.done); expect(denied.error).toBe("draining"); expect(messages).toEqual([]);
    expect(getPiProviderStepFailure(denied)).toBeUndefined(); expect(f.labels).toEqual(["a"]);
  }, { count: 1 }));
});
