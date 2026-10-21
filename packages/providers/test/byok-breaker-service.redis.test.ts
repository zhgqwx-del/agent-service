import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createRuntimeMetrics, type ProviderConfigInput, type ProviderGatewayObserver } from "@agent-service/protocol";
import { MemorySessionStore, RedisProviderPoolCoordinator, RedisProviderQuotaCoordinator } from "@agent-service/store";
import { PiEngine, getPiProviderStepFailure } from "../../core/src/engine/pi.js";
import type { AssistantStepResult, EngineSink, ProviderModelRequest, ResolvedModel } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const owner = { tenantId: "native-byok-tenant", userId: "native-byok-user" }, ref = { provider: "native-byok-provider", model: "native-byok-model" };
const key = "test-only-native-byok-key";
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function redisUrl() {
  const raw = process.env.REDIS_TEST_URL;
  if (!raw) throw new Error("BYOK fixture requires explicit local Redis.");
  const parsed = new URL(raw);
  if (!["redis:", "rediss:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    || !/^[1-9][0-9]*$/.test(parsed.port) || Number(parsed.port) > 65535 || !/^\/(?:0|[1-9][0-9]*)$/.test(parsed.pathname)
    || parsed.search || parsed.hash || /[\u0000-\u0020\u007f]/.test(raw)) throw new Error("BYOK fixture requires explicit local Redis.");
  return raw;
}
async function fixture(signal: AbortSignal, work: (f: {
  store: MemorySessionStore; services: ProviderService[]; pools: RedisProviderPoolCoordinator[]; labels: string[]; endpoint: string;
  configure(tenantId: string, providerId?: string, apiKey?: string | null, headers?: Record<string, string>, extra?: Partial<ProviderConfigInput>): Promise<void>;
  model(index: number, principal?: typeof owner, providerId?: string): Promise<ResolvedModel>;
  request(index: number, principal?: typeof owner, providerId?: string, request?: ProviderModelRequest): Promise<Response>;
  onRequest(handler: (request: IncomingMessage, response: ServerResponse) => void): void;
  track<T>(promise: Promise<T>): Promise<T>;
}) => Promise<void>, options: { gatewayObserver?: ProviderGatewayObserver; authorizeFleet?: (signal: AbortSignal) => Promise<void> } = {}) {
  const url = redisUrl(), prefix = `byok-service-${randomUUID()}`, namespaceId = `byok-service-${randomUUID()}`;
  const pools = [0, 1].map(() => new RedisProviderPoolCoordinator({ url, prefix, namespaceId }));
  const quotas = [0, 1].map(() => new RedisProviderQuotaCoordinator({ url, prefix, namespaceId }));
  const store = new MemorySessionStore(), responses = new Set<Response>(), nativeResponses = new Set<ServerResponse>(), sockets = new Set<Socket>();
  const nativeRedis: Socket[] = [], pending = new Set<Promise<unknown>>(), labels: string[] = [], abort = new AbortController();
  const actualSignal = AbortSignal.any([signal, abort.signal]);
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  };
  let handler = (_request: IncomingMessage, response: ServerResponse) => { response.writeHead(200); response.end("body"); };
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization;
    labels.push(authorization === `Bearer ${key}` ? "byok" : authorization === "Custom test-only-header-key" ? "custom" : authorization === undefined ? "keyless" : "wrong");
    nativeResponses.add(response); response.once("close", () => nativeResponses.delete(response)); handler(request, response);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let listening = false, passed = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    listening = true; const address = server.address();
    if (!address || typeof address === "string") throw new Error("BYOK HTTP fixture is unavailable.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const config = (providerId = ref.provider, headers: Record<string, string> = {}) => ({ id: providerId, api: "openai-completions" as const,
      baseUrl, headers, quota: {}, fallback: [], models: [{ id: ref.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
        price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
    const services = pools.map((coordinator, index) => new ProviderService({ store, cipher: new LocalAesGcmCipher("71".repeat(32)), assertBaseUrl: async () => {},
      platform: [{ config: config(), apiKey: "test-only-unused-platform-key" }],
      quota: { coordinator: quotas[index]!, tenant: { concurrency: 1 }, user: {},
        ...(options.authorizeFleet === undefined ? {} : { authorizeFleet: options.authorizeFleet }) },
      byokBreaker: { coordinator, policy: { threshold: 1, windowMs: 1000, cooldownMs: 1000, rateLimitCooldownMs: 1000 } },
      ...(options.gatewayObserver === undefined ? {} : { gatewayObserver: options.gatewayObserver }),
      persistedProviderFailureCaptureActive: true }));
    await Promise.all([...pools, ...quotas].map(coordinator => coordinator.assertReady()));
    for (const coordinator of [...pools, ...quotas]) {
      const stream = (coordinator as unknown as { port: { redis: { stream?: Socket } } }).port.redis.stream;
      if (!stream) throw new Error("BYOK Redis fixture lacks a native stream."); nativeRedis.push(stream);
    }
    const configure = async (tenantId: string, providerId = ref.provider, apiKey: string | null = key, headers: Record<string, string> = {}, extra: Partial<ProviderConfigInput> = {}) => {
      await services[0]!.upsertTenantProvider(tenantId, { ...config(providerId, headers), ...(apiKey === null ? {} : { apiKey }), ...extra });
    };
    await configure(owner.tenantId);
    const model = (index: number, principal = owner, providerId = ref.provider) => services[index]!.resolve(principal, { ...ref, provider: providerId });
    const request = (index: number, principal = owner, providerId = ref.provider, pinned?: ProviderModelRequest) => track((async () => {
      actualSignal.throwIfAborted(); const resolved = await model(index, principal, providerId), request = pinned ?? resolved.createRequest!();
      const apiKey = await request.apiKey!(actualSignal), headers = new Headers(resolved.headers);
      if (!headers.has("authorization") && apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
      const response = await request.fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: "{}", signal: actualSignal });
      responses.add(response); return response;
    })());
    await work({ store, services, pools, labels, endpoint: `${baseUrl}/chat/completions`, configure, model, request, onRequest: next => { handler = next; }, track }); passed = true;
  } finally {
    // Keep random health tombstones/TTL evidence. Never flush or glob-delete shared Redis keys.
    abort.abort();
    const cancelling = Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
    for (const response of nativeResponses) response.destroy();
    let httpClose: Promise<void> | undefined;
    if (listening) { httpClose = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); }
    const socketClose = [...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve())));
    for (const socket of sockets) socket.destroy();
    const joined = await Promise.allSettled([cancelling, ...pending, ...socketClose, ...(httpClose ? [httpClose] : [])]);
    const cancelled = await cancelling, closed = await Promise.allSettled([...pools, ...quotas].map(coordinator => coordinator.close())); await store.close();
    if (passed && ([...joined, ...cancelled, ...closed].some(result => result.status === "rejected") || nativeRedis.some(socket => !socket.closed))) {
      throw new Error("BYOK native fixture cleanup is unproven.");
    }
  }
}

describe.skipIf(!process.env.AGENT_SERVICE_INTEGRATION)("BYOK breaker actual Redis and native HTTP", () => {
  it("shares a disabled revision across services and users, but isolates both tenant and provider ownership", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response) => { response.writeHead(401); response.end("body"); });
    const first = await f.request(0); expect(first.status).toBe(401); await first.text();
    await expect(f.request(1, { ...owner, userId: "other-user" })).rejects.toMatchObject({ reason: "disabled" });
    const other = { tenantId: "other-native-byok-tenant", userId: "other-user" };
    await f.configure(other.tenantId); const second = await f.request(1, other); await second.text();
    await f.configure(owner.tenantId, "other-provider"); const third = await f.request(1, owner, "other-provider"); await third.text();
    expect(f.labels).toEqual(["byok", "byok", "byok"]); // No platform credential or hidden second request.
  }));

  it("advances the actual same-key config generation and delete/recreate generation without reviving an old handle", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response) => { response.writeHead(401); response.end("body"); });
    const oldModel = await f.model(0), oldRequest = oldModel.createRequest!(); await oldRequest.apiKey!(context.signal);
    const first = await f.request(0); await first.text();
    const before = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
    await f.configure(owner.tenantId); const middle = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
    expect(middle).toBeGreaterThan(before); await expect(oldRequest.apiKey!(context.signal)).rejects.toMatchObject({ reason: "unavailable" });
    const current = await f.model(1), pinned = current.createRequest!(); await pinned.apiKey!(context.signal);
    const second = await f.request(1, owner, ref.provider, pinned); await second.text();
    await f.services[0]!.deleteTenantProvider(owner.tenantId, ref.provider); await f.configure(owner.tenantId);
    expect((await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision).toBeGreaterThan(middle);
    await expect(pinned.fetch(f.endpoint, { signal: context.signal })).rejects.toMatchObject({ reason: "unavailable" });
    const third = await f.request(0); await third.text(); expect(f.labels).toEqual(["byok", "byok", "byok"]);
  }));

  it("rechecks a real BYOK rotation after the held final fleet gate before any HTTP dispatch", async context => {
    const reached = barrier(), release = barrier(); let fleetCalls = 0;
    const authorizeFleet = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (++fleetCalls !== 4) return;
      reached.resolve();
      const cancel = () => release.resolve();
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try { await release.promise; signal.throwIfAborted(); }
      finally { signal.removeEventListener("abort", cancel); }
    };
    await fixture(context.signal, async f => {
      const staleKey = "test-only-native-byok-stale-key";
      await f.configure(owner.tenantId, ref.provider, staleKey);
      const staleModel = await f.model(0), staleRequest = staleModel.createRequest!();
      expect(await staleRequest.apiKey!(context.signal)).toBe(staleKey);
      let pendingSettled = false;
      const pending = f.request(0, owner, ref.provider, staleRequest);
      // An early terminal result must wake this assertion too, never leave an unowned rejection.
      void pending.then(() => { pendingSettled = true; reached.resolve(); }, () => { pendingSettled = true; reached.resolve(); });
      try {
        await reached.promise;
        expect(fleetCalls).toBe(4); expect(pendingSettled).toBe(false); expect(f.labels).toEqual([]);
        const before = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!;
        await f.track(f.services[1]!.upsertTenantProvider(owner.tenantId, { ...before.config, apiKey: key }));
        expect((await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision)
          .toBeGreaterThan(before.credentialSourceRevision);
        release.resolve();
        await expect(pending).rejects.toMatchObject({ reason: "unavailable" });
        expect(staleRequest.wasDispatched()).toBe(false); expect(f.labels).toEqual([]);
        const currentModel = await f.model(1), currentRequest = currentModel.createRequest!();
        expect(await currentRequest.apiKey!(context.signal)).toBe(key);
        // The other coordinator shares concurrency=1: success also proves the denied permit released.
        const current = await f.request(1, owner, ref.provider, currentRequest);
        expect(current.status).toBe(200); await current.text();
        expect(currentRequest.wasDispatched()).toBe(true); expect(f.labels).toEqual(["byok"]);
      } finally {
        release.resolve();
        await Promise.allSettled([pending]);
      }
    }, { authorizeFleet });
  });

  it("accepts real keyless and explicit-header BYOK while refusing a substituted configured credential", async context => fixture(context.signal, async f => {
    await f.services[0]!.deleteTenantProvider(owner.tenantId, ref.provider);
    // Explicit keyless configuration must not borrow the platform key of the same provider id.
    await f.configure(owner.tenantId, ref.provider, null);
    const keyless = await f.model(0); expect(await keyless.createRequest!().apiKey!(context.signal)).toBeUndefined();
    const first = await f.request(0); await first.text(); expect(f.labels).toEqual(["keyless"]);
    await f.configure(owner.tenantId, ref.provider, key, { Authorization: "Custom test-only-header-key", "X-Api-Key": "test-only-header-key" });
    const model = await f.model(1), request = model.createRequest!(); await request.apiKey!(context.signal);
    await expect(request.fetch(f.endpoint, { headers: { authorization: "Custom test-only-header-key", "x-api-key": "wrong" }, signal: context.signal }))
      .rejects.toMatchObject({ reason: "unavailable" });
    const second = await f.request(1); await second.text(); expect(f.labels).toEqual(["keyless", "custom"]);
  }));

  it("keeps a native 429 cooldown shared and gives real Pi an unattempted draining result without usage or 0053 source", async context => fixture(context.signal, async f => {
    f.onRequest((_request, response) => { response.writeHead(429, { "retry-after": "3600" }); response.end("body"); });
    const first = await f.request(0); await first.text();
    const messages: AssistantStepResult[] = [];
    const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
      async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; },
      onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
    const run = new PiEngine(f.services[1]!.models).start({ model: await f.model(1), systemPrompt: "fixture", history: [], tools: [],
      input: [{ type: "text", text: "fixture" }], signal: context.signal, toolContext: { principal: owner, sessionId: "native-byok-session", turnId: "native-byok-turn" } }, sink);
    const done = await f.track(run.done); expect(done.error).toBe("draining"); expect(messages).toEqual([]);
    expect(getPiProviderStepFailure(done)).toBeUndefined(); expect(f.labels).toEqual(["byok"]);
  }));

  it("holds native quota and credential ownership until actual body cancellation and closes every owned Redis socket", async context => fixture(context.signal, async f => {
    const closed = barrier(); let hold = true;
    f.onRequest((_request, response) => {
      if (hold) { response.once("close", closed.resolve); response.writeHead(200); response.write("held body"); }
      else { response.writeHead(200); response.end("body"); }
    });
    const first = await f.request(0); await expect(f.request(1)).rejects.toMatchObject({ reason: "concurrency" });
    await first.body!.cancel(); await closed.promise; hold = false;
    const second = await f.request(1); await second.text(); expect(f.labels).toEqual(["byok", "byok"]);
  }));

  it("observes one real HTTP attempt across shared Redis concurrency rejection and actual body cancellation", async context => {
    const registry = createRuntimeMetrics("runner"), peerClosed = barrier();
    const count = (name: string, extra = "") => {
      const prefix = `agent_service_provider_gateway_${name}{component="runner",scope="byok"${extra}} `;
      const line = registry.render().split("\n").find(value => value.startsWith(prefix)); return line ? Number(line.slice(prefix.length)) : 0;
    };
    await fixture(context.signal, async f => {
      f.onRequest((_request, response) => { response.once("close", peerClosed.resolve); response.writeHead(200); response.write("held body"); });
      const first = await f.request(0); expect(count("attempts_total")).toBe(1); expect(count("attempts_in_progress")).toBe(1);
      await expect(f.request(1)).rejects.toMatchObject({ reason: "concurrency" });
      expect(count("attempts_total")).toBe(1); expect(count("attempts_in_progress")).toBe(1);
      expect(count("rejections_total", ',reason="quota_concurrency"')).toBe(1);
      await first.body!.cancel(); await peerClosed.promise;
      expect(count("attempts_in_progress")).toBe(0); expect(count("io_completions_total", ',outcome="cancelled"')).toBe(1);
      expect(count("io_completions_total", ',outcome="completed"')).toBe(0); expect(f.labels).toEqual(["byok"]);
      expect(registry.render().includes(key) || registry.render().includes(owner.tenantId)).toBe(false);
    }, { gatewayObserver: registry.providerGateway });
  });

  it.for([false, true])("selects a shared-Redis explicit target once and stops after its actual HTTP failure=%s", async (failure, context) => fixture(context.signal, async f => {
    const targetProvider = "native-fallback-target", targetKey = "test-only-native-fallback-target-key";
    await f.configure(owner.tenantId, ref.provider, key, {}, { fallbackRules: [{ model: ref.model,
      targets: [{ provider: targetProvider, model: ref.model }] }] });
    await f.configure(owner.tenantId, targetProvider, targetKey);
    const nativeLabels: string[] = [];
    f.onRequest((request, response) => {
      const label = request.headers.authorization === `Bearer ${key}` ? "source"
        : request.headers.authorization === `Bearer ${targetKey}` ? "target" : "wrong";
      nativeLabels.push(label);
      if (label === "source") { response.writeHead(401); response.end("credential rejected"); return; }
      if (failure) { response.writeHead(503); response.end("fixture unavailable"); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "native-fallback", object: "chat.completion.chunk", created: 1, model: ref.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "native fallback" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
    });
    const seed = await f.request(0); expect(seed.status).toBe(401); await seed.text();
    const service = f.services[1]!, source = await f.model(1), messages: AssistantStepResult[] = [];
    let replacements = 0;
    const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
      async prepareFallbackModelStep(input, failed) {
        replacements++;
        const model = await service.resolveFallback(owner, failed);
        return model ? { ...input, model } : undefined;
      },
      async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; },
      onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
    const run = new PiEngine(service.models).start({ model: source, systemPrompt: "native fallback fixture", history: [], tools: [],
      input: [{ type: "text", text: "fixture" }], signal: context.signal,
      toolContext: { principal: owner, sessionId: "native-fallback-session", turnId: "native-fallback-turn" } }, sink);
    const result = await f.track(run.done);
    expect(replacements).toBe(1); expect(nativeLabels).toEqual(["source", "target"]); expect(messages).toHaveLength(1);
    if (failure) {
      expect(result.error).toBe("provider_error"); expect(messages[0]!.usage).not.toHaveProperty("costCNY");
      expect(getPiProviderStepFailure(messages[0])).toMatchObject({ failureKind: "provider_step_error", stepIndex: 1 });
    } else {
      expect(result.error).toBeUndefined(); expect(messages[0]).toMatchObject({ text: "native fallback", usage: { totalTokens: 3 } });
    }
  }));
});
