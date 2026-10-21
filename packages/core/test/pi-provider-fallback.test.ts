import { describe, expect, it, vi } from "vitest";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ApiError } from "@agent-service/protocol";
import { PiEngine, getPiProviderStepFailure, getPiProviderStepFailureMessage } from "../src/engine/pi.js";
import type { AssistantStepResult, EngineModelStep, EngineRun, EngineSink, ProviderAdmissionFailure, ProviderModelRequest, ResolvedModel } from "../src/engine/types.js";
import type { RunnerTool } from "../src/tools/types.js";

const principal = { tenantId: "selection-fixture", userId: "selection-user" };
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function wire(model: string, tool = false, finished = true) {
  const chunk = { id: "selection-fixture", object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: "selection_tool_call", type: "function",
      function: { name: "selection_tool", arguments: "{}" } }] } : { role: "assistant", content: "selected response" },
    finish_reason: finished ? tool ? "tool_calls" : "stop" : null }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
  return `data: ${JSON.stringify(chunk)}\n\n${finished ? "data: [DONE]\n\n" : ""}`;
}
const response = (model: string, tool = false) => new Response(wire(model, tool), { headers: { "content-type": "text/event-stream" } });

function fixture() {
  const models = createModels(), events: string[] = [];
  function candidate(id: string, options: { enabled?: boolean; key?: string;
    keyWork?: (request: number, signal?: AbortSignal) => Promise<string | undefined>; failure?: ProviderAdmissionFailure;
    keyError?: Error; fetchError?: Error; response?: (request: number) => Response; factoryError?: Error } = {}) {
    const provider = `selection-${id}`, modelId = `model-${id}`, key = Object.hasOwn(options, "key") ? options.key : `test-only-key-${id}`;
    const handle: Model<"openai-completions"> = { id: modelId, name: modelId, provider, api: "openai-completions",
      baseUrl: "https://selection.example/v1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 100 };
    models.setProvider(createProvider({ id: provider, name: provider, baseUrl: handle.baseUrl, models: [handle], api: openAICompletionsApi(),
      auth: { apiKey: { name: "Fixture request key", resolve: async ({ credential }) => credential?.key
        ? { auth: { apiKey: credential.key }, source: "request" }
        // The SDK requires an auth resolution even when the real configured Authorization header
        // supplies auth. Empty ModelAuth permits that header path without inventing an API key.
        : key === undefined ? { auth: {}, source: "request" } : undefined } } }));
    const requests: ProviderModelRequest[] = [], calls: { authorization: string | null; body: Record<string, unknown> }[] = [];
    const rawKey = vi.fn(async () => { throw new Error("Raw key must not be selected."); });
    const keyCalls = vi.fn(async (request: number, signal?: AbortSignal) => {
      events.push(`key:${id}:${request}`); signal?.throwIfAborted();
      if (options.keyError) throw options.keyError;
      return options.keyWork ? options.keyWork(request, signal) : key;
    });
    const create = vi.fn((): ProviderModelRequest => {
      if (options.factoryError) throw options.factoryError;
      const index = requests.length + 1; let dispatched = false; events.push(`create:${id}:${index}`);
      const request: ProviderModelRequest = Object.freeze({
        apiKey: (signal?: AbortSignal) => keyCalls(index, signal),
        fetch: (async (_input, init) => {
          dispatched = true; events.push(`fetch:${id}:${index}`);
          calls.push({ authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          if (options.fetchError) throw options.fetchError;
          return options.response?.(index) ?? response(modelId);
        }) as typeof fetch,
        wasDispatched: () => dispatched, admissionFailure: () => options.failure,
      }); requests.push(request); return request;
    });
    const model: ResolvedModel = { handle: models.getModel(provider, modelId)!, provider, model: modelId, input: ["text"], contextWindow: 1000,
      priceKnown: true, apiKey: rawKey, createRequest: create, ...(options.enabled === undefined ? {} : { fallbackEnabled: options.enabled }),
      ...(key === undefined ? { headers: { authorization: `Bearer test-only-header-${id}` } } : {}) };
    return { model, create, rawKey, keyCalls, requests, calls };
  }
  function start(model: ResolvedModel, options: { fallback?: NonNullable<EngineSink["prepareFallbackModelStep"]>;
    prepare?: NonNullable<EngineSink["prepareModelStep"]>; signal?: AbortSignal; tools?: RunnerTool[]; onText?: () => void; continueFirst?: boolean } = {}) {
    const messages: AssistantStepResult[] = [];
    const sink: EngineSink = { onStepStart: vi.fn(), onTextDelta: vi.fn(options.onText), onReasoningDelta: vi.fn(), onToolArgsDelta: vi.fn(),
      onAssistantMessage: vi.fn(async message => { messages.push(message); }), beforeToolCall: vi.fn(async () => ({ allow: true as const })),
      onToolExecutionStart: vi.fn(), onToolProgress: vi.fn(), afterToolCall: vi.fn(async result => result), onToolResult: vi.fn(async () => {}),
      onStepEnd: vi.fn(async step => options.continueFirst && step === 1 ? "continue" as const : "end" as const),
      ...(options.prepare ? { prepareModelStep: options.prepare } : {}), ...(options.fallback ? { prepareFallbackModelStep: options.fallback } : {}) };
    const run = new PiEngine(models).start({ model, systemPrompt: "initial system", input: [{ type: "text", text: "fixture input" }],
      history: [], tools: options.tools ?? [], maxOutputTokens: 80, signal: options.signal ?? new AbortController().signal,
      toolContext: { principal, sessionId: "selection-session", turnId: "selection-turn" } }, sink);
    return { run, sink, messages };
  }
  return { models, candidate, start, events };
}
function noAttempt(result: Awaited<EngineRun["done"]>, target: ReturnType<ReturnType<typeof fixture>["start"]>, code: string) {
  expect(result.error).toBe(code); expect(target.messages).toEqual([]); expect(target.sink.onTextDelta).not.toHaveBeenCalled();
  expect(target.sink.onReasoningDelta).not.toHaveBeenCalled(); expect(target.sink.onToolArgsDelta).not.toHaveBeenCalled();
  expect(getPiProviderStepFailure(result)).toBeUndefined(); expect(getPiProviderStepFailureMessage(result)).toBeUndefined();
}

// Actual pinned Pi Agent + registered OpenAI adapter; fake original ProviderModelRequest objects
// exercise the engine seam only, not Service authorization, Redis, native HTTP or provider billing.
describe("Pi selection-only fallback", () => {
  it.each([undefined, false])("does not ask for fallback without the final model feature hint (%s)", async enabled => {
    const f = fixture(), source = f.candidate("source", { enabled, keyError: new Error("key rejected"), failure: "draining" });
    const fallback = vi.fn(async () => undefined), target = f.start(source.model, { fallback });
    try { noAttempt(await target.run.done, target, "draining"); expect(fallback).not.toHaveBeenCalled(); expect(source.keyCalls).toHaveBeenCalledOnce(); }
    finally { target.run.interrupt(); await target.run.done; }
  });

  it("keeps the ordinary key phase when the optional fallback sink is absent", async () => {
    const f = fixture(), source = f.candidate("source", { enabled: true }), target = f.start(source.model);
    try { expect((await target.run.done).error).toBeUndefined(); expect(source.keyCalls).toHaveBeenCalledOnce(); expect(source.calls).toHaveLength(1); }
    finally { target.run.interrupt(); await target.run.done; }
  });

  it("uses the final Host selection before choosing keys and binds the last target SDK model, context, key and fetch", async () => {
    const f = fixture(), old = f.candidate("old", { enabled: true }), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" });
    const selected = f.candidate("target", { enabled: false }), stream = vi.spyOn(f.models, "streamSimple");
    const prepare = vi.fn(async (request: EngineModelStep) => ({ ...request, model: source.model, systemPrompt: "source system" }));
    const fallback = vi.fn(async (request: EngineModelStep, failed: ProviderModelRequest) => {
      expect(failed).toBe(source.requests[0]); expect(failed.wasDispatched()).toBe(false);
      return { ...request, model: selected.model, systemPrompt: "target system", maxOutputTokens: 37 };
    });
    const target = f.start(old.model, { prepare, fallback });
    try {
      expect((await target.run.done).error).toBeUndefined(); expect(prepare).toHaveBeenCalledOnce(); expect(fallback).toHaveBeenCalledOnce();
      expect(old.create).not.toHaveBeenCalled(); expect(source.keyCalls).toHaveBeenCalledOnce(); expect(source.calls).toEqual([]);
      expect(selected.keyCalls).toHaveBeenCalledOnce(); expect(selected.rawKey).not.toHaveBeenCalled(); expect(selected.calls).toHaveLength(1);
      expect(selected.calls[0]!.authorization).toBe("Bearer test-only-key-target"); expect(selected.calls[0]!.body.model).toBe(selected.model.model);
      expect(JSON.stringify(selected.calls[0]!.body)).toContain("target system"); expect(JSON.stringify(selected.calls[0]!.body)).not.toContain("source system");
      expect(stream.mock.calls[0]![0]).toBe(selected.model.handle); expect(stream.mock.calls[0]![2]?.maxTokens).toBe(37);
      expect(stream.mock.calls[0]![2]?.maxRetries).toBe(0); expect(target.messages).toHaveLength(1);
      expect(target.messages[0]).toMatchObject({ provider: selected.model.provider, model: selected.model.model, usage: { totalTokens: 3, costCNY: 0.000004 } });
    } finally { target.run.interrupt(); await target.run.done; }
  });

  it("caches a legally undefined key instead of resolving it a second time in SDK getApiKey", async () => {
    const f = fixture(), source = f.candidate("keyless", { enabled: true, key: undefined }), fallback = vi.fn(async () => undefined);
    const target = f.start(source.model, { fallback });
    try {
      expect((await target.run.done).error).toBeUndefined(); expect(source.keyCalls).toHaveBeenCalledOnce(); expect(source.calls).toHaveLength(1);
      expect(source.calls[0]!.authorization).toBe("Bearer test-only-header-keyless"); expect(source.rawKey).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    } finally { target.run.interrupt(); await target.run.done; }
  });

  it("caps alternatives at three and keeps the last candidate denial instead of the previous failure", async () => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("first"), failure: "draining" });
    const candidates = [f.candidate("one", { keyError: new Error("one"), failure: "subject_deleting" }),
      f.candidate("two", { keyError: new Error("two"), failure: "draining" }), f.candidate("three", { keyError: new Error("three"), failure: "quota_exceeded" })];
    let index = 0; const fallback = vi.fn(async (request: EngineModelStep) => ({ ...request, model: candidates[index++ % candidates.length]!.model }));
    const target = f.start(source.model, { fallback });
    try {
      noAttempt(await target.run.done, target, "quota_exceeded"); expect(fallback).toHaveBeenCalledTimes(3);
      for (const value of [source, ...candidates]) { expect(value.create).toHaveBeenCalledOnce(); expect(value.keyCalls).toHaveBeenCalledOnce(); expect(value.calls).toEqual([]); }
    } finally { target.run.interrupt(); await target.run.done; }
  });

  it("preserves a declined source denial and stops on a Host callback error without borrowing that denial", async () => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" });
    const decline = f.start(source.model, { fallback: async () => undefined });
    try { noAttempt(await decline.run.done, decline, "draining"); } finally { decline.run.interrupt(); await decline.run.done; }
    const reject = f.start(source.model, { fallback: async () => { throw new Error("private source check failed"); } });
    try { noAttempt(await reject.run.done, reject, "provider_error"); expect(source.calls).toEqual([]); }
    finally { reject.run.interrupt(); await reject.run.done; }
  });

  it.each(["draining", "quota_exceeded", "subject_deleting"] as const)("preserves the real Host ApiError %s without a provider attempt", async code => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" });
    const target = f.start(source.model, { fallback: async () => { throw new ApiError(code, "test-only fixed Host failure"); } });
    try { noAttempt(await target.run.done, target, code); expect(source.calls).toEqual([]); }
    finally { target.run.interrupt(); await target.run.done; }
  });

  it.each(["draining", "quota_exceeded", "subject_deleting"] as const)("does not trust a plain object claiming the same %s code", async code => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" });
    const target = f.start(source.model, { fallback: async () => { throw { code, message: "test-only imitation Host error" }; } });
    try { noAttempt(await target.run.done, target, "provider_error"); expect(source.calls).toEqual([]); }
    finally { target.run.interrupt(); await target.run.done; }
  });

  it.each(["step", "messages", "mutated-input"] as const)("rejects a fallback that changes the exact prepared %s", async change => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" }), next = f.candidate("target");
    const fallback = vi.fn(async (request: EngineModelStep) => {
      if (change === "mutated-input") request.messages.push({ role: "system", text: "unapproved rewrite" });
      return { ...request, model: next.model, ...(change === "step" ? { step: request.step + 1 } : {}),
        ...(change === "messages" ? { messages: [] } : {}) };
    });
    const target = f.start(source.model, { fallback });
    try { noAttempt(await target.run.done, target, "provider_error"); expect(next.create).not.toHaveBeenCalled(); expect(source.calls).toEqual([]); }
    finally { target.run.interrupt(); await target.run.done; }
  });

  it("does not retry a real dispatched failure and retains its original unknown-cost provenance", async () => {
    const f = fixture(), source = f.candidate("source", { enabled: true, fetchError: new Error("private upstream failure") });
    const fallback = vi.fn(async () => undefined), target = f.start(source.model, { fallback });
    try {
      const result = await target.run.done; expect(result.error).toBe("provider_error"); expect(source.calls).toHaveLength(1);
      expect(fallback).not.toHaveBeenCalled(); expect(target.messages).toHaveLength(1); expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(result)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(getPiProviderStepFailureMessage(result)).toBe(target.messages[0]);
    } finally { target.run.interrupt(); await target.run.done; }
  });

  it("never switches after visible text from a dispatched stream fails", async () => {
    const f = fixture(), seen = barrier(); let pulls = 0;
    const source = f.candidate("source", { enabled: true, response: () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) { if (++pulls === 1) controller.enqueue(new TextEncoder().encode(wire("model-source", false, false)));
        else { await seen.promise; controller.error(new Error("private midstream failure")); } },
    }), { headers: { "content-type": "text/event-stream" } }) });
    const fallback = vi.fn(async () => undefined), target = f.start(source.model, { fallback, onText: seen.resolve });
    try {
      expect((await target.run.done).error).toBe("provider_error"); expect(target.sink.onTextDelta).toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled(); expect(source.calls).toHaveLength(1); expect(target.messages).toHaveLength(1);
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
    } finally { seen.resolve(); target.run.interrupt(); await target.run.done; }
  });

  it("resets selection and cached keys per step without rerunning the Agent, input or completed tool", async () => {
    const f = fixture(), source = f.candidate("source", { enabled: true, keyError: new Error("open"), failure: "draining" });
    const selected = f.candidate("target", { response: index => response("model-target", index === 1) });
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "one durable tool result" }] }));
    const tool: RunnerTool = { name: "selection_tool", description: "fixture", parameters: { type: "object", properties: {} }, kind: "builtin", readOnly: true, execute };
    const fallback = vi.fn(async (request: EngineModelStep) => ({ ...request, model: selected.model }));
    const target = f.start(source.model, { prepare: async request => ({ ...request, model: source.model }), fallback, tools: [tool], continueFirst: true });
    try {
      const result = await target.run.done; expect(result.error).toBeUndefined(); expect(result.steps).toBe(2);
      expect(target.sink.onStepStart).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledOnce(); expect(target.sink.afterToolCall).toHaveBeenCalledOnce();
      expect(fallback).toHaveBeenCalledTimes(2); expect(source.keyCalls).toHaveBeenCalledTimes(2); expect(selected.keyCalls).toHaveBeenCalledTimes(2);
      expect(source.calls).toEqual([]); expect(selected.calls).toHaveLength(2); expect(new Set([...source.requests, ...selected.requests]).size).toBe(4);
      expect(target.messages).toHaveLength(2); expect(target.messages.map(value => value.stopReason)).toEqual(["toolUse", "stop"]);
      const second = JSON.stringify(selected.calls[1]!.body); expect(second.match(/fixture input/g)).toHaveLength(1); expect(second.match(/one durable tool result/g)).toHaveLength(1);
      for (const message of target.messages) expect(message.usage).toMatchObject({ totalTokens: 3, costCNY: 0.000004 });
    } finally { target.run.interrupt(); await target.run.done; }
  });

  it("keeps concurrent fallback bindings on the same source resolved handle isolated", async () => {
    const f = fixture(), entered = barrier(), release = barrier();
    const source = f.candidate("source", { enabled: true, failure: "draining", keyWork: async index => {
      if (index === 1) { entered.resolve(); await release.promise; } throw new Error("open");
    } });
    const a = f.candidate("target-a"), b = f.candidate("target-b"), first = f.start(source.model, { fallback: async request => ({ ...request, model: a.model }) });
    let second: ReturnType<typeof f.start> | undefined;
    try {
      await entered.promise; second = f.start(source.model, { fallback: async request => ({ ...request, model: b.model }) });
      expect((await second.run.done).error).toBeUndefined(); expect(a.calls).toEqual([]); release.resolve();
      expect((await first.run.done).error).toBeUndefined(); expect(source.requests[0]).not.toBe(source.requests[1]);
      expect(a.calls[0]!.authorization).toBe("Bearer test-only-key-target-a"); expect(b.calls[0]!.authorization).toBe("Bearer test-only-key-target-b");
      expect(a.keyCalls).toHaveBeenCalledOnce(); expect(b.keyCalls).toHaveBeenCalledOnce(); expect(source.calls).toEqual([]);
    } finally { release.resolve(); first.run.interrupt(); second?.run.interrupt(); await Promise.allSettled([first.run.done, ...(second ? [second.run.done] : [])]); }
  });

  it("awaits an actually pending key after cancellation and never asks Host to select another candidate", async () => {
    const f = fixture(), entered = barrier(), release = barrier(), controller = new AbortController();
    const source = f.candidate("source", { enabled: true, keyWork: async (_index, signal) => {
      entered.resolve(); await release.promise; signal?.throwIfAborted(); return "test-only-late-key";
    } });
    const fallback = vi.fn(async () => undefined), target = f.start(source.model, { fallback, signal: controller.signal }); let settled = false;
    void target.run.done.then(() => { settled = true; });
    try {
      await entered.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false); release.resolve();
      const result = await target.run.done; expect(result.aborted).toBe(true); expect(source.calls).toEqual([]); expect(fallback).not.toHaveBeenCalled();
      expect(target.messages).toEqual([]); expect(target.sink.onTextDelta).not.toHaveBeenCalled(); expect(getPiProviderStepFailure(result)).toBeUndefined();
    } finally { release.resolve(); target.run.interrupt(); await target.run.done; }
  });
});
