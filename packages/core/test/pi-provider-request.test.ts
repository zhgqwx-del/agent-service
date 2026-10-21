import { describe, expect, it, vi } from "vitest";
import type { ModelPrice } from "@agent-service/protocol";
import { MemoryProviderQuotaCoordinator, MemorySessionStore } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "../../providers/src/index.js";
import { PiEngine, PiSummariser, getPiProviderStepFailure, takePiSummariserFailure } from "../src/engine/pi.js";
import type { AssistantStepResult, EngineModelStep, EngineSink, ResolvedModel } from "../src/engine/types.js";

const principal = { tenantId: "request-tenant", userId: "request-user" };
const reference = { provider: "request-provider", model: "request-model" };
const key = "test-only-request-key";
const defaultPrice = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const providerConfig = (id = reference.provider, apiKey = key, price: ModelPrice | null = defaultPrice) => ({ id, api: "openai-completions" as const,
  baseUrl: "https://provider.example/v1", apiKey, headers: {}, quota: {}, fallback: [],
  models: [{ id: reference.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
    ...(price === null ? {} : { price }) }] });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function completion(finished = true) {
  const common = { id: "chatcmpl-request-fixture", object: "chat.completion.chunk", created: 1, model: reference.model };
  const chunks: unknown[] = [{ ...common, choices: [{ index: 0, delta: { role: "assistant", content: "request response" }, finish_reason: null }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }];
  if (finished) chunks.push({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}
function response(finished = true) { return new Response(completion(finished), { headers: { "content-type": "text/event-stream" } }); }
function usageResponse(usage?: unknown, atChoice = false, toolCall = false) {
  const choice = { index: 0, delta: toolCall
    ? { role: "assistant", tool_calls: [{ index: 0, id: "request_fixture_call", type: "function", function: { name: "request_fixture_tool", arguments: "{}" } }] }
    : { role: "assistant", content: "request response" }, finish_reason: toolCall ? "tool_calls" : "stop",
    ...(atChoice && usage !== undefined ? { usage } : {}) };
  const chunk = { id: "chatcmpl-request-usage-fixture", object: "chat.completion.chunk", created: 1, model: reference.model,
    choices: [choice], ...(!atChoice && usage !== undefined ? { usage } : {}) };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function receiver(onText?: () => void) {
  const messages: AssistantStepResult[] = [];
  const sink: EngineSink = {
    onStepStart: vi.fn(), onTextDelta: vi.fn(onText), onReasoningDelta: vi.fn(), onToolArgsDelta: vi.fn(),
    onAssistantMessage: vi.fn(async message => { messages.push(message); }),
    beforeToolCall: vi.fn(async () => ({ allow: true as const })), onToolExecutionStart: vi.fn(), onToolProgress: vi.fn(),
    afterToolCall: vi.fn(async value => value), onToolResult: vi.fn(async () => {}), onStepEnd: vi.fn(async () => "end" as const),
  };
  return { sink, messages };
}
async function fixture(delegate: typeof fetch = async () => response(), price: ModelPrice | null = defaultPrice) {
  const store = new MemorySessionStore(), cipher = new LocalAesGcmCipher("23".repeat(32));
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "pi-request", namespaceId: "fixture" });
  const vendor = vi.fn(delegate);
  const service = new ProviderService({ store, cipher, assertBaseUrl: async () => {}, fetch: vendor,
    persistedProviderFailureCaptureActive: true, quota: { coordinator: quota, tenant: {}, user: {} } });
  await service.upsertTenantProvider(principal.tenantId, providerConfig(reference.provider, key, price));
  const model = await service.resolve(principal, reference);
  const start = (selected: ResolvedModel = model, options: {
    signal?: AbortSignal; prepare?: (request: EngineModelStep) => Promise<EngineModelStep>; onText?: () => void;
  } = {}) => {
    const target = receiver(options.onText);
    if (options.prepare) target.sink.prepareModelStep = options.prepare;
    const run = new PiEngine(service.models).start({ model: selected, systemPrompt: "request fixture", tools: [], history: [],
      input: [{ type: "text", text: "fixture input" }], signal: options.signal ?? new AbortController().signal,
      toolContext: { principal, sessionId: "request-session", turnId: "request-turn" } }, target.sink);
    return { ...target, run };
  };
  return { store, cipher, quota, service, model, vendor, start,
    close: async () => { try { await quota.close(); } finally { await store.close(); } } };
}

// Real pinned Pi Agent/adapter, Service and Memory quota; injected Response bytes and the explicit
// request wrappers below test lifecycle ordering, not key-pool selection or native HTTP billing.
describe("Pi request-bound credentials", () => {
  it("explicitly disables SDK retries for stream and independent compaction requests", async () => {
    const f = await fixture(async () => new Response("private retry fixture", { status: 503 }));
    const stream = vi.spyOn(f.service.models, "streamSimple"), complete = vi.spyOn(f.service.models, "completeSimple");
    const target = f.start();
    try {
      const done = await target.run.done;
      expect(done.error).toBe("provider_error"); expect(f.vendor).toHaveBeenCalledOnce();
      expect(stream.mock.calls[0]![2]?.maxRetries).toBe(0); expect(target.messages).toHaveLength(1);
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      await expect(new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" }))
        .rejects.toBeInstanceOf(Error);
      expect(complete.mock.calls[0]![2]?.maxRetries).toBe(0); expect(f.vendor).toHaveBeenCalledTimes(2);
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("binds concurrent key and fetch lifetimes on one resolved handle before either SDK stream", async () => {
    const f = await fixture(), firstKey = barrier(), releaseFirst = barrier();
    const events: string[] = [], matching: boolean[] = [], signals: AbortSignal[] = [];
    const rawKey = vi.fn(async () => { throw new Error("old raw key must not be used"); });
    const enter = vi.spyOn(f.quota, "enter"); let created = 0;
    const model: ResolvedModel = { ...f.model, apiKey: rawKey, createRequest: beforeDispatch => {
      const request = f.model.createRequest!(beforeDispatch), id = ++created;
      events.push(`create:${id}`);
      return { ...request, apiKey: async signal => {
        expect(signal instanceof AbortSignal).toBe(true); signals.push(signal!);
        await request.apiKey!(signal); events.push(`key:${id}`);
        if (id === 1) { firstKey.resolve(); await releaseFirst.promise; }
        signal?.throwIfAborted(); return `test-only-bound-${id}`;
      }, fetch: (async (input, init) => {
        matching.push(new Headers(init?.headers).get("authorization") === `Bearer test-only-bound-${id}`);
        events.push(`fetch:${id}`); return request.fetch(input, init);
      }) as typeof fetch };
    } };
    const first = f.start(model); let second: ReturnType<typeof f.start> | undefined;
    try {
      await firstKey.promise; expect(enter).not.toHaveBeenCalled(); expect(f.vendor).not.toHaveBeenCalled();
      second = f.start(model); expect((await second.run.done).error).toBeUndefined();
      expect(events).toEqual(["create:1", "key:1", "create:2", "key:2", "fetch:2"]);
      releaseFirst.resolve(); expect((await first.run.done).error).toBeUndefined();
      expect(events).toEqual(["create:1", "key:1", "create:2", "key:2", "fetch:2", "fetch:1"]);
      expect(matching).toEqual([true, true]); expect(signals).toHaveLength(2); expect(signals[0]).not.toBe(signals[1]);
      expect(created).toBe(2); expect(rawKey).not.toHaveBeenCalled(); expect(f.vendor).toHaveBeenCalledTimes(2);
      expect(first.messages).toHaveLength(1); expect(second.messages).toHaveLength(1);
    } finally {
      releaseFirst.resolve(); first.run.interrupt(); second?.run.interrupt();
      await Promise.allSettled([first.run.done, ...(second ? [second.run.done] : [])]); await f.close();
    }
  });

  it("creates the selected request only after middleware and never obtains the previous model key", async () => {
    const f = await fixture();
    await f.service.upsertTenantProvider(principal.tenantId, providerConfig("request-target", "test-only-target-key"));
    const selected = await f.service.resolve(principal, { ...reference, provider: "request-target" });
    const oldKey = vi.fn(async () => { throw new Error("old key"); });
    const oldRequest = vi.fn(() => { throw new Error("old request"); });
    const events: string[] = []; let keyMatches = false;
    const target: ResolvedModel = { ...selected, apiKey: oldKey, createRequest: beforeDispatch => {
      events.push("request"); const request = selected.createRequest!(beforeDispatch);
      return { ...request, apiKey: async signal => { events.push("key"); return request.apiKey!(signal); },
        fetch: (async (input, init) => {
          events.push("fetch"); keyMatches = new Headers(init?.headers).get("authorization") === "Bearer test-only-target-key";
          return request.fetch(input, init);
        }) as typeof fetch };
    } };
    const run = f.start({ ...f.model, apiKey: oldKey, createRequest: oldRequest }, {
      prepare: async request => { events.push("prepare"); return { ...request, model: target }; },
    });
    try {
      expect((await run.run.done).error).toBeUndefined(); expect(events).toEqual(["prepare", "request", "key", "fetch"]);
      expect(oldKey).not.toHaveBeenCalled(); expect(oldRequest).not.toHaveBeenCalled(); expect(keyMatches).toBe(true);
      expect(run.messages).toHaveLength(1); expect(run.messages[0]!.provider).toBe(selected.provider);
      expect(f.vendor).toHaveBeenCalledOnce();
    } finally { run.run.interrupt(); await run.run.done; await f.close(); }
  });

  it("uses one request-bound key and fetch for compaction and passes its actual signal", async () => {
    const f = await fixture(), controller = new AbortController(), events: string[] = [];
    const rawKey = vi.fn(async () => { throw new Error("old raw key"); }); let created = 0;
    const model: ResolvedModel = { ...f.model, apiKey: rawKey, createRequest: beforeDispatch => {
      created++; const request = f.model.createRequest!(beforeDispatch);
      return { ...request, apiKey: async signal => {
        expect(signal).toBe(controller.signal); events.push("key"); return request.apiKey!(signal);
      }, fetch: (async (input, init) => { events.push("fetch"); return request.fetch(input, init); }) as typeof fetch };
    } };
    try {
      const result = await new PiSummariser(f.service.models).summarise({ model, systemPrompt: "fixture", text: "history", signal: controller.signal });
      expect(result.text).toBe("request response"); expect(created).toBe(1); expect(events).toEqual(["key", "fetch"]);
      expect(rawKey).not.toHaveBeenCalled(); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("joins an in-flight key operation after caller abort without acquiring quota or dispatching", async () => {
    const f = await fixture(), entered = barrier(), release = barrier(), controller = new AbortController();
    const decrypt = f.cipher.decrypt.bind(f.cipher);
    vi.spyOn(f.cipher, "decrypt").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return decrypt(...args); });
    const enter = vi.spyOn(f.quota, "enter"), target = f.start(f.model, { signal: controller.signal });
    let settled = false; void target.run.done.then(() => { settled = true; });
    try {
      await entered.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
      expect(enter).not.toHaveBeenCalled(); expect(f.vendor).not.toHaveBeenCalled();
      release.resolve(); const result = await target.run.done;
      expect(result.aborted).toBe(true); expect(result.error).toBe("provider_error");
      expect(target.messages).toEqual([]); expect(getPiProviderStepFailure(result)).toBeUndefined();
      expect(f.vendor).not.toHaveBeenCalled(); expect(enter).not.toHaveBeenCalled();
    } finally { release.resolve(); target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("does not construct a request or obtain a key when the caller was already aborted without middleware", async () => {
    const f = await fixture(), controller = new AbortController();
    const rawKey = vi.fn(f.model.apiKey), enter = vi.spyOn(f.quota, "enter"); let requestKeys = 0;
    const createRequest = vi.fn((beforeDispatch?: () => Promise<void>) => {
      const request = f.model.createRequest!(beforeDispatch);
      return { ...request, apiKey: async (signal?: AbortSignal) => { requestKeys++; return request.apiKey!(signal); } };
    });
    controller.abort();
    const target = f.start({ ...f.model, apiKey: rawKey, createRequest }, { signal: controller.signal });
    try {
      const result = await target.run.done;
      expect(result.aborted).toBe(true);
      expect(target.sink.prepareModelStep).toBeUndefined(); expect(createRequest).not.toHaveBeenCalled();
      expect(rawKey).not.toHaveBeenCalled(); expect(requestKeys).toBe(0); expect(enter).not.toHaveBeenCalled();
      expect(f.vendor).not.toHaveBeenCalled(); expect(target.messages).toEqual([]);
      expect(target.sink.onAssistantMessage).not.toHaveBeenCalled(); expect(target.sink.onStepEnd).not.toHaveBeenCalled();
      expect(result.error).toBe("provider_error"); expect(getPiProviderStepFailure(result)).toBeUndefined();
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it.each(["key", "sdk-build", "vendor"] as const)("preserves %s error dispatch classification with request-bound credentials", async at => {
    const f = await fixture(at === "vendor" ? async () => { throw new Error("private-request-error"); } : undefined);
    if (at === "key") vi.spyOn(f.cipher, "decrypt").mockRejectedValueOnce(new Error("private-request-error"));
    const target = f.start(at === "sdk-build" ? { ...f.model, headers: { "x-invalid-fixture": "private-request-error\ninvalid" } } : f.model);
    try {
      const result = await target.run.done; expect(result.error).toBe("provider_error");
      expect(f.vendor).toHaveBeenCalledTimes(at === "vendor" ? 1 : 0);
      expect(target.messages).toHaveLength(at === "vendor" ? 1 : 0);
      expect(getPiProviderStepFailure(result)).toEqual(at === "vendor" ? { failureKind: "provider_step_error", stepIndex: 1 } : undefined);
      expect(JSON.stringify({ result, messages: target.messages })).not.toContain("private-request-error");
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });
});

describe("Pi priced failed attempts remain unknown-cost", () => {
  it("retains configured cost for a complete successful priced response", async () => {
    const f = await fixture(), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); expect((await target.run.done).error).toBeUndefined();
      expect(target.messages).toHaveLength(1); expect(target.messages[0]!.usage).toMatchObject({ totalTokens: 3, costCNY: 0.000004 });
      expect(f.vendor).toHaveBeenCalledOnce();
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it.each(["delegate-reject", "incomplete-stream"] as const)("does not promote SDK zero or partial priced usage to known cost for %s", async failure => {
    const f = await fixture(failure === "delegate-reject" ? async () => { throw new Error("private-priced-error"); } : async () => response(false));
    const target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); const result = await target.run.done;
      expect(result.error).toBe("provider_error"); expect(f.vendor).toHaveBeenCalledOnce(); expect(target.messages).toHaveLength(1);
      expect(getPiProviderStepFailure(result)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(target.messages[0]!.stopReason).toBe("error");
      expect(target.messages[0]!.usage.totalTokens).toBe(failure === "delegate-reject" ? 0 : 3);
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(JSON.stringify(target.messages)).not.toContain("private-priced-error");
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("does not promote a dispatched abort's partial priced usage to known cost and joins body cancellation", async () => {
    const text = barrier(), cancelled = barrier(), cancelAck = barrier(), controller = new AbortController();
    const f = await fixture(async () => new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new TextEncoder().encode(completion(false).replace("data: [DONE]\n\n", ""))); },
      async cancel() { cancelled.resolve(); await cancelAck.promise; },
    }), { headers: { "content-type": "text/event-stream" } }));
    const target = f.start(f.model, { signal: controller.signal, onText: text.resolve });
    try {
      expect(f.model.priceKnown).toBe(true); await text.promise; controller.abort(); await cancelled.promise;
      cancelAck.resolve(); const result = await target.run.done;
      expect(result.aborted).toBe(true); expect(f.vendor).toHaveBeenCalledOnce(); expect(target.messages).toHaveLength(1);
      expect(target.messages[0]!.stopReason).toBe("aborted"); expect(target.messages[0]!.usage.totalTokens).toBe(3);
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(result)).toBeUndefined();
    } finally { cancelAck.resolve(); target.run.interrupt(); await target.run.done; await f.close(); }
  });
});

// These are configured-price estimates of the adapter's last reported billable components, not
// a complete provider invoice. Reported all-zero usage cannot be distinguished from SDK zeroes.
describe("Pi successful configured-price usage evidence", () => {
  it.each([
    ["no-usage", undefined, 0],
    ["explicit-zero", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, 0],
    ["reasoning-only", { completion_tokens_details: { reasoning_tokens: 7 }, total_tokens: 7 }, 7],
    ["total-only", { total_tokens: 11 }, 0],
  ] as const)("keeps successful %s responses unknown-cost without a positive billable component", async (_scenario, usage, reasoningTokens) => {
    const f = await fixture(async () => usageResponse(usage)), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); const result = await target.run.done;
      expect(result.error).toBeUndefined(); expect(target.messages).toHaveLength(1); expect(f.vendor).toHaveBeenCalledOnce();
      expect(target.messages[0]!.text).toBe("request response"); expect(target.messages[0]!.stopReason).toBe("stop");
      expect(target.messages[0]!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, reasoningTokens, totalTokens: 0 });
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(result)).toBeUndefined();
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("recognises actual positive choice-level usage from the real adapter", async () => {
    const f = await fixture(async () => usageResponse({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, true)), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); expect((await target.run.done).error).toBeUndefined();
      expect(target.messages).toHaveLength(1); expect(f.vendor).toHaveBeenCalledOnce();
      expect(target.messages[0]!.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: 0.000004 });
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("recognises positive cache-read and cache-write components even with zero uncached input and output", async () => {
    const f = await fixture(async () => usageResponse({ prompt_tokens: 7, completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, total_tokens: 7 }),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 5 }), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); expect((await target.run.done).error).toBeUndefined();
      expect(target.messages).toHaveLength(1); expect(f.vendor).toHaveBeenCalledOnce();
      expect(target.messages[0]!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 4, cacheWriteTokens: 3,
        totalTokens: 7, costCNY: (4 / 1_000_000) * 3 + (3 / 1_000_000) * 5 });
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("retains an explicitly configured zero price when actual billable counts are positive", async () => {
    const f = await fixture(async () => response(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(true); expect((await target.run.done).error).toBeUndefined();
      expect(f.vendor).toHaveBeenCalledOnce(); expect(target.messages).toHaveLength(1);
      expect(target.messages[0]!.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: 0 });
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(true);
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("keeps an unpriced model unknown-cost despite actual positive billable counts", async () => {
    const f = await fixture(async () => response(), null), target = f.start();
    try {
      expect(f.model.priceKnown).toBe(false); expect((await target.run.done).error).toBeUndefined();
      expect(f.vendor).toHaveBeenCalledOnce(); expect(target.messages).toHaveLength(1);
      expect(target.messages[0]!.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("keeps compaction's actual successful no-usage response unknown-cost", async () => {
    const f = await fixture(async () => usageResponse());
    try {
      expect(f.model.priceKnown).toBe(true);
      const result = await new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" });
      expect(f.vendor).toHaveBeenCalledOnce(); expect(result.text).toBe("request response"); expect(result.usage.totalTokens).toBe(0);
      expect(Object.hasOwn(result.usage, "costCNY")).toBe(false);
    } finally { await f.close(); }
  });

  it("does not carry a previous step's positive usage evidence into a later no-usage response", async () => {
    let dispatches = 0;
    const f = await fixture(async () => ++dispatches === 1
      ? usageResponse({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, false, true) : usageResponse());
    const target = receiver(), execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fixture result" }] }));
    target.sink.onStepEnd = vi.fn(async (step: number) => step === 1 ? "continue" as const : "end" as const);
    const run = new PiEngine(f.service.models).start({ model: f.model, systemPrompt: "fixture", history: [],
      tools: [{ name: "request_fixture_tool", description: "fixture", parameters: { type: "object", properties: {} }, kind: "builtin", readOnly: true, execute }],
      input: [{ type: "text", text: "fixture input" }], signal: new AbortController().signal,
      toolContext: { principal, sessionId: "request-session", turnId: "request-turn" } }, target.sink);
    try {
      expect((await run.done).error).toBeUndefined(); expect(f.vendor).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledOnce();
      expect(target.messages).toHaveLength(2); expect(target.messages[0]!.stopReason).toBe("toolUse");
      expect(target.messages[0]!.usage).toMatchObject({ totalTokens: 3, costCNY: 0.000004 });
      expect(target.messages[1]!.stopReason).toBe("stop"); expect(target.messages[1]!.usage.totalTokens).toBe(0);
      expect(Object.hasOwn(target.messages[1]!.usage, "costCNY")).toBe(false);
    } finally { run.interrupt(); await run.done; await f.close(); }
  });
});

describe("Pi dispatched compaction failure accounting provenance", () => {
  it("does not create a request, resolve a key or dispatch for a pre-aborted compaction caller, including legacy models", async () => {
    const f = await fixture(), controller = new AbortController();
    controller.abort();
    try {
      for (const withFactory of [true, false]) {
        const rawKey = vi.fn(f.model.apiKey), requestKey = vi.fn(async () => "must-not-resolve");
        const createRequest = vi.fn((beforeDispatch?: () => Promise<void>) => ({
          ...f.model.createRequest!(beforeDispatch), apiKey: requestKey,
        }));
        const model: ResolvedModel = { ...f.model, apiKey: rawKey, createRequest: withFactory ? createRequest : undefined };
        const failure = await new PiSummariser(f.service.models).summarise({ model, systemPrompt: "fixture", text: "history", signal: controller.signal })
          .then(() => undefined, error => error as unknown);
        expect(createRequest).not.toHaveBeenCalled(); expect(requestKey).not.toHaveBeenCalled(); expect(rawKey).not.toHaveBeenCalled();
        expect(f.vendor).not.toHaveBeenCalled(); expect(failure).toMatchObject({ name: "AbortError" });
        expect(takePiSummariserFailure(failure, model)).toBeUndefined();
      }
    } finally { await f.close(); }
  });

  it("authorizes only the original error and exact model once, with frozen unknown usage", async () => {
    const f = await fixture(async () => new Response("private-summary-error", { status: 503 }));
    try {
      const error = await new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" })
        .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
      expect(error).toBeInstanceOf(Error);
      expect(takePiSummariserFailure(new Error("Provider request failed."), f.model)).toBeUndefined();
      expect(takePiSummariserFailure(structuredClone(error), f.model)).toBeUndefined();
      expect(takePiSummariserFailure(error, { ...f.model })).toBeUndefined();
      const source = takePiSummariserFailure(error, f.model);
      expect(source).toMatchObject({ provider: f.model.provider, model: f.model.model, usage: { totalTokens: 0 } });
      expect(Object.isFrozen(source)).toBe(true); expect(Object.isFrozen(source!.usage)).toBe(true);
      expect(Object.hasOwn(source!.usage, "costCNY")).toBe(false);
      expect(takePiSummariserFailure(error, f.model)).toBeUndefined();
      expect(String(error)).toBe("Error: Provider request failed."); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("retains a failed incomplete stream's actual reported tokens without promoting its partial estimate", async () => {
    const f = await fixture(async () => response(false));
    try {
      const error = await new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" })
        .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
      const source = takePiSummariserFailure(error, f.model);
      expect(source?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
      expect(Object.hasOwn(source!.usage, "costCNY")).toBe(false); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("joins actual body cancellation and accounts for an aborted compaction's reported tokens as unknown", async () => {
    const text = barrier(), cancelled = barrier(), cancelAck = barrier(), controller = new AbortController();
    const f = await fixture(async () => new Response(new ReadableStream<Uint8Array>({
      start(body) { body.enqueue(new TextEncoder().encode(completion(false).replace("data: [DONE]\n\n", ""))); },
      async cancel() { cancelled.resolve(); await cancelAck.promise; },
    }), { headers: { "content-type": "text/event-stream" } }));
    const stream = f.service.models.streamSimple.bind(f.service.models);
    vi.spyOn(f.service.models, "streamSimple").mockImplementation((...args) => {
      const result = stream(...args), push = result.push.bind(result);
      result.push = event => { if (event.type === "text_delta") text.resolve(); push(event); };
      return result;
    });
    const pending = new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history", signal: controller.signal })
      .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
    try {
      await text.promise; controller.abort(); await cancelled.promise;
      const held = await f.quota.enter({ ...principal, provider: { scope: "tenant", id: reference.provider },
        tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, new AbortController().signal)
        .then(async lease => { await lease.release(); return undefined; }, error => error as unknown);
      expect(held).toMatchObject({ reason: "concurrency" });
      cancelAck.resolve(); const source = takePiSummariserFailure(await pending, f.model);
      expect(source?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3 });
      expect(Object.hasOwn(source!.usage, "costCNY")).toBe(false); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { cancelAck.resolve(); controller.abort(); await pending; await f.close(); }
  });

  it("accounts for a completeSimple rejection after actual dispatch without trusting an unavailable result", async () => {
    const f = await fixture(), complete = f.service.models.completeSimple.bind(f.service.models);
    vi.spyOn(f.service.models, "completeSimple").mockImplementation(async (...args) => {
      await complete(...args); throw new Error("private-summary-complete-error");
    });
    try {
      const error = await new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" })
        .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
      const source = takePiSummariserFailure(error, f.model);
      expect(source?.usage.totalTokens).toBe(0); expect(Object.hasOwn(source!.usage, "costCNY")).toBe(false);
      expect(String(error)).toBe("Error: Provider request failed."); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("preserves original successful priced usage when its empty summary is unusable", async () => {
    const f = await fixture(async () => new Response(completion().replace("request response", ""), { headers: { "content-type": "text/event-stream" } }));
    try {
      const error = await new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "history" })
        .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
      expect(takePiSummariserFailure(error, f.model)?.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: 0.000004 });
      expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("does not grant attempt provenance to a legacy model without a request factory", async () => {
    const f = await fixture(async () => new Response("private-summary-error", { status: 503 }));
    const model = { ...f.model, createRequest: undefined };
    try {
      const error = await new PiSummariser(f.service.models).summarise({ model, systemPrompt: "fixture", text: "history" })
        .then(() => { throw new Error("Expected compaction failure."); }, failure => failure as unknown);
      expect(takePiSummariserFailure(error, model)).toBeUndefined(); expect(f.vendor).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});
