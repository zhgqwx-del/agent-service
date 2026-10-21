import { describe, expect, it, vi } from "vitest";
import { createRuntimeMetrics, type ProviderGatewayObserver, type ProviderGatewayRejectionReason, type RuntimeMetrics } from "@agent-service/protocol";
import { MemoryProviderPoolCoordinator, MemoryProviderQuotaCoordinator, MemorySessionStore, ProviderPoolError, ProviderQuotaError, SubjectDeletingError } from "@agent-service/store";
import { PiEngine, TenantRuntimeCoordinator, getPiProviderStepFailure } from "@agent-service/core";
import type { AssistantStepResult, EngineSink, ProviderModelRequest } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService, type ProviderServiceOptions } from "../src/index.js";

const owner = { tenantId: "metrics-tenant", userId: "metrics-user" }, ref = { provider: "metrics-provider", model: "metrics-model" };
const url = "https://private-metrics-provider.example/v1/chat/completions", key = "private-metrics-secret";
const config = () => ({ id: ref.provider, api: "openai-completions" as const, baseUrl: "https://private-metrics-provider.example/v1", headers: {}, quota: {}, fallback: [],
  models: [{ id: ref.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function sample(metrics: RuntimeMetrics, name: string, scope: "platform" | "byok", extra = ""): number {
  const prefix = `agent_service_provider_gateway_${name}{component="runner",scope="${scope}"${extra}} `;
  const line = metrics.render().split("\n").find(value => value.startsWith(prefix)); return line ? Number(line.slice(prefix.length)) : 0;
}
function completion(metrics: RuntimeMetrics, scope: "platform" | "byok", outcome: string) {
  return sample(metrics, "io_completions_total", scope, `,outcome="${outcome}"`);
}
function sse() { return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: ref.model,
  choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }

async function fixture(options: { scope?: "platform" | "byok"; quota?: boolean; breaker?: boolean; runtime?: TenantRuntimeCoordinator;
  fetch?: typeof fetch; metrics?: RuntimeMetrics; observer?: ProviderGatewayObserver; observerGetter?: () => ProviderGatewayObserver } = {}) {
  const store = new MemorySessionStore(), pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "metrics-service", namespaceId: "fixture" });
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "metrics-service", namespaceId: "fixture" });
  let now = 0; const metrics = options.metrics ?? createRuntimeMetrics("runner", { now: () => now }), finished = barrier();
  const real = metrics.providerGateway!;
  const observer: ProviderGatewayObserver = options.observer ?? { rejected: (scope, reason) => real.rejected(scope, reason),
    beginAttempt: scope => { const end = real.beginAttempt(scope); return outcome => { end(outcome); finished.resolve(); }; } };
  const delegate = vi.fn(options.fetch ?? (async () => new Response("body"))), responses = new Set<Response>();
  const opts: ProviderServiceOptions = { store, cipher: new LocalAesGcmCipher("82".repeat(32)), assertBaseUrl: async () => {}, fetch: delegate,
    platform: [{ config: config(), ...(options.breaker && options.scope !== "byok" ? { keyPool: [{ id: "slot", version: "v1", apiKey: key }] } : { apiKey: key }) }],
    gatewayObserver: observer, tenantRuntime: options.runtime, persistedProviderFailureCaptureActive: true,
    ...(options.quota ? { quota: { coordinator: quota, tenant: { concurrency: 1 }, user: {} } } : {}),
    ...(options.breaker ? options.scope === "byok" ? { byokBreaker: { coordinator: pool, policy: {} } } : { keyPool: { coordinator: pool, policy: {} } } : {}) };
  if (options.observerGetter) Object.defineProperty(opts, "gatewayObserver", { get: options.observerGetter });
  const service = new ProviderService(opts);
  if (options.scope === "byok") await service.upsertTenantProvider(owner.tenantId, { ...config(), apiKey: key });
  const model = await service.resolve(owner, ref);
  const dispatch = async (request = model.createRequest!(), signal?: AbortSignal) => {
    const apiKey = await request.apiKey!(signal);
    const response = await request.fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal }); responses.add(response); return { request, response };
  };
  return { store, pool, quota, metrics, finished, model, service, delegate, dispatch, now: (value: number) => { now = value; }, close: async () => {
    const cancelled = await Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
    const closed = await Promise.allSettled([pool.close(), quota.close(), store.close()]);
    if ([...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("Gateway metrics fixture did not settle.");
  } };
}

describe("Gateway Service L0 observation at actual I/O boundaries", () => {
  it("holds an observer-only attempt past headers and pending reads until original cancellation acknowledgement", async () => {
    const entered = barrier(), ack = barrier();
    const f = await fixture({ fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    let cancel: Promise<void> | undefined;
    try {
      const result = await f.dispatch(); expect(sample(f.metrics, "attempts_total", "platform")).toBe(1);
      expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(1); expect(completion(f.metrics, "platform", "completed")).toBe(0);
      f.now(1000); cancel = result.response.body!.cancel(); await entered.promise;
      expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(1); expect(completion(f.metrics, "platform", "cancelled")).toBe(0);
      f.now(2000); ack.resolve(); await cancel;
      expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(0); expect(completion(f.metrics, "platform", "cancelled")).toBe(1);
      expect(result.request.hasLocalFailure?.()).toBe(false);
      expect(sample(f.metrics, "io_duration_seconds_sum", "platform", ',outcome="cancelled"')).toBe(2);
    } finally { ack.resolve(); await cancel; await f.close(); }
  });

  it("keeps platform and BYOK concurrent scope counts independent with no identity or credential labels", async () => {
    const metrics = createRuntimeMetrics("runner"), first = await fixture({ metrics, fetch: async () => new Response(new ReadableStream()) });
    const second = await fixture({ metrics, scope: "byok", breaker: true, quota: true, fetch: async () => new Response(new ReadableStream()) });
    try {
      const a = await first.dispatch(), b = await second.dispatch();
      expect(sample(metrics, "attempts_in_progress", "platform")).toBe(1); expect(sample(metrics, "attempts_in_progress", "byok")).toBe(1);
      await a.response.body!.cancel(); expect(sample(metrics, "attempts_in_progress", "platform")).toBe(0); expect(sample(metrics, "attempts_in_progress", "byok")).toBe(1);
      await b.response.body!.cancel(); expect(completion(metrics, "byok", "cancelled")).toBe(1);
      const rendered = metrics.render();
      expect([owner.tenantId, owner.userId, ref.provider, url, key, "slot=", "provider="].some(value => rendered.includes(value))).toBe(false);
    } finally { await Promise.all([first.close(), second.close()]); }
  });

  it("finishes a complete 2xx I/O before a held health release, excluding release duration without changing release failure", async () => {
    const releaseEntered = barrier(), releaseAck = barrier(), f = await fixture({ breaker: true, quota: true });
    const acquire = f.pool.acquire.bind(f.pool);
    vi.spyOn(f.pool, "acquire").mockImplementation(async (...args) => {
      const lease = await acquire(...args); return { ...lease, release: async outcome => {
        releaseEntered.resolve(); await releaseAck.promise; await lease.release(outcome); throw new Error("private-health-failure");
      } };
    });
    let consumed: Promise<void> | undefined;
    try {
      const result = await f.dispatch(); f.now(2000); consumed = expect(result.response.text()).rejects.toMatchObject({ reason: "unavailable" });
      await releaseEntered.promise; expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(0);
      expect(completion(f.metrics, "platform", "completed")).toBe(1); f.now(10000);
      expect(sample(f.metrics, "io_duration_seconds_sum", "platform", ',outcome="completed"')).toBe(2);
      releaseAck.resolve(); await consumed; expect(result.request.hasLocalFailure?.()).toBe(true);
      expect(result.request.wasDispatched()).toBe(true); expect(result.request.admissionFailure()).toBeUndefined();
    } finally { releaseAck.resolve(); await consumed; await f.close(); }
  });

  it.each(["http", "fetch", "read"] as const)("records the true %s I/O result without turning it into admission rejection", async failure => {
    const original = new Error("private-upstream-failure"), f = await fixture({ fetch: failure === "fetch" ? async () => { throw original; }
      : failure === "http" ? async () => new Response("body", { status: 503 })
      : async () => new Response(new ReadableStream({ start(controller) { controller.error(original); } })) });
    try {
      if (failure === "fetch") await expect(f.dispatch()).rejects.toBe(original);
      else { const result = await f.dispatch(); if (failure === "http") expect(await result.response.text()).toBe("body"); else await expect(result.response.text()).rejects.toBe(original); }
      expect(sample(f.metrics, "attempts_total", "platform")).toBe(1); expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(0);
      expect(completion(f.metrics, "platform", failure === "http" ? "http_error" : "transport_error")).toBe(1);
      expect(f.metrics.render().split("\n").filter(line => line.startsWith("agent_service_provider_gateway_rejections_total{"))).toEqual([]);
      expect(f.metrics.render().includes("private-")).toBe(false);
    } finally { await f.close(); }
  });

  it("classifies observer-only caller abort as cancellation, retaining active through actual cancel join and the original AbortError", async () => {
    const entered = barrier(), ack = barrier(), caller = new AbortController();
    const f = await fixture({ fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    let consumed: Promise<void> | undefined;
    try {
      const result = await f.dispatch(undefined, caller.signal); consumed = expect(result.response.text()).rejects.toMatchObject({ name: "AbortError" });
      caller.abort(); await entered.promise; expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(1);
      ack.resolve(); await consumed; await f.finished.promise;
      expect(completion(f.metrics, "platform", "cancelled")).toBe(1); expect(completion(f.metrics, "platform", "local_abort")).toBe(0);
    } finally { ack.resolve(); await consumed; await f.close(); }
  });

  it.each(["quota", "pool", "t3b"] as const)("keeps a %s local fence distinct from caller cancellation until real body cleanup", async fence => {
    const entered = barrier(), ack = barrier(), runtime = fence === "t3b" ? new TenantRuntimeCoordinator() : undefined;
    const f = await fixture({ quota: fence === "quota", breaker: fence === "pool", runtime,
      fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    runtime?.sealParticipants(); let consumed: Promise<void> | undefined, closing: Promise<unknown> | undefined;
    try {
      const result = await f.dispatch(); consumed = expect(result.response.text()).rejects.toMatchObject({ name: fence === "t3b" ? "AbortError" : "ProviderQuotaError" });
      closing = fence === "quota" ? f.quota.close() : fence === "pool" ? f.pool.close() : runtime!.drain({ tenantId: owner.tenantId,
        requestId: "fixture-erasure", subjectGeneration: 1, t3aReceiptSha256: "b".repeat(64) }, 1000);
      await entered.promise; expect(sample(f.metrics, "attempts_in_progress", "platform")).toBe(1);
      ack.resolve(); await consumed; await closing; await f.finished.promise;
      expect(completion(f.metrics, "platform", "local_abort")).toBe(1); expect(completion(f.metrics, "platform", "cancelled")).toBe(0);
      expect(result.request.wasDispatched()).toBe(true);
    } finally { ack.resolve(); await Promise.allSettled([...(consumed ? [consumed] : []), ...(closing ? [closing] : [])]); await f.close(); }
  });

  const denials: { source: "quota" | "pool" | "subject" | "caller" | "local"; error: Error; reason: ProviderGatewayRejectionReason }[] = [
    { source: "quota", error: new ProviderQuotaError("rpm"), reason: "quota_rpm" },
    { source: "quota", error: new ProviderQuotaError("concurrency"), reason: "quota_concurrency" },
    { source: "quota", error: new ProviderQuotaError("unavailable"), reason: "quota_unavailable" },
    { source: "pool", error: new ProviderPoolError("open"), reason: "breaker_open" },
    { source: "pool", error: new ProviderPoolError("disabled"), reason: "breaker_disabled" },
    { source: "pool", error: new ProviderPoolError("unavailable"), reason: "breaker_unavailable" },
    { source: "subject", error: new SubjectDeletingError(owner.tenantId), reason: "subject_deleting" },
    { source: "caller", error: new DOMException("fixture", "AbortError"), reason: "cancelled" },
    { source: "local", error: new Error("private-local-failure"), reason: "local_unavailable" },
  ];
  it.each(denials)("latches one $reason rejection across this request's key/fetch attempts and dispatches nothing", async ({ source, error, reason }) => {
    const f = await fixture({ scope: "byok", quota: source === "quota", breaker: source === "pool" }), caller = new AbortController();
    if (source === "quota") vi.spyOn(f.quota, "enter").mockRejectedValue(error);
    if (source === "pool") vi.spyOn(f.pool, "select").mockRejectedValue(error);
    if (source === "local") vi.spyOn(f.store, "getTenantRuntimeState").mockRejectedValue(error);
    if (source === "caller") caller.abort(error);
    const request = f.model.createRequest!(source === "subject" ? async () => { throw error; } : undefined);
    try {
      await expect(f.dispatch(request, caller.signal)).rejects.toBeInstanceOf(Error);
      await expect(request.fetch(url, { signal: caller.signal })).rejects.toBeInstanceOf(Error);
      expect(f.delegate).not.toHaveBeenCalled(); expect(request.wasDispatched()).toBe(false);
      expect(sample(f.metrics, "attempts_total", "byok")).toBe(0);
      expect(sample(f.metrics, "rejections_total", "byok", `,reason="${reason}"`)).toBe(1);
      expect(f.metrics.render().includes("private-")).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["observer", "rejected-getter", "rejected-call"] as const)("does not change a known quota rejection when %s observation throws", async failure => {
    const observer: ProviderGatewayObserver = { rejected() { throw new Error("private-observer-failure"); }, beginAttempt() { return () => {}; } };
    if (failure === "rejected-getter") Object.defineProperty(observer, "rejected", { get() { throw new Error("private-observer-failure"); } });
    const f = await fixture({ quota: true, observer, ...(failure === "observer" ? { observerGetter: () => { throw new Error("private-observer-failure"); } } : {}) });
    const original = new ProviderQuotaError("rpm"); vi.spyOn(f.quota, "enter").mockRejectedValue(original);
    try { await expect(f.dispatch()).rejects.toBe(original); expect(f.delegate).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });

  it.each(["observer", "begin-getter", "begin-call", "finish"] as const)("keeps actual Pi usage and original provider provenance when %s observation fails", async failure => {
    const observer: ProviderGatewayObserver = { rejected() {}, beginAttempt() { return () => {}; } };
    if (failure === "begin-getter") Object.defineProperty(observer, "beginAttempt", { get() { throw new Error("private-observer-failure"); } });
    if (failure === "begin-call") observer.beginAttempt = () => { throw new Error("private-observer-failure"); };
    if (failure === "finish") observer.beginAttempt = () => () => { throw new Error("private-observer-failure"); };
    const f = await fixture({ observer, fetch: async () => { throw new Error("private-provider-failure"); },
      ...(failure === "observer" ? { observerGetter: () => { throw new Error("private-observer-failure"); } } : {}) });
    const messages: AssistantStepResult[] = [], requests: ProviderModelRequest[] = [];
    const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
      async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; }, onToolExecutionStart() {},
      onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
    const model = { ...f.model, createRequest: (before?: () => Promise<void>) => { const request = f.model.createRequest!(before); requests.push(request); return request; } };
    const run = new PiEngine(f.service.models).start({ model, systemPrompt: "fixture", history: [], tools: [], input: [{ type: "text", text: "fixture" }],
      signal: new AbortController().signal, toolContext: { principal: owner, sessionId: "metrics-session", turnId: "metrics-turn" } }, sink);
    try {
      const done = await run.done; expect(done.error).toBe("provider_error"); expect(f.delegate).toHaveBeenCalledOnce(); expect(requests[0]!.wasDispatched()).toBe(true);
      expect(messages).toHaveLength(1); expect(Object.hasOwn(messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(done)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(JSON.stringify({ done, messages }).includes("private-")).toBe(false);
    } finally { run.interrupt(); await run.done; await f.close(); }
  });

  it("does not change a successful priced Pi estimate when completion observation throws", async () => {
    const f = await fixture({ observer: { rejected() {}, beginAttempt() { return () => { throw new Error("private-observer-failure"); }; } }, fetch: async () => sse() });
    const messages: AssistantStepResult[] = [], sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
      async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; }, onToolExecutionStart() {},
      onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
    const run = new PiEngine(f.service.models).start({ model: f.model, systemPrompt: "fixture", history: [], tools: [], input: [{ type: "text", text: "fixture" }],
      signal: new AbortController().signal, toolContext: { principal: owner, sessionId: "metrics-session", turnId: "metrics-turn" } }, sink);
    try { expect((await run.done).error).toBeUndefined(); expect(messages).toHaveLength(1); expect(messages[0]!.usage.costCNY).toBeGreaterThan(0); }
    finally { run.interrupt(); await run.done; await f.close(); }
  });
});
