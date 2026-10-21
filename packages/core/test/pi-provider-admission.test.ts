import { describe, expect, it, vi } from "vitest";
import { ApiError, DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import {
  MemoryProviderQuotaCoordinator, MemorySessionStore, newErasureRequestId, tenantErasureRequestHash,
  type ProviderQuotaLease, type ProviderQuotaLimit,
} from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "../../providers/src/index.js";
import { PiEngine, PiSummariser, getPiProviderStepFailure, getPiProviderStepFailureMessage } from "../src/engine/pi.js";
import type { AssistantStepResult, EngineRun, EngineSink, ResolvedModel } from "../src/engine/types.js";

const principal = { tenantId: "admission-tenant", userId: "admission-user" };
const reference = { provider: "admission-provider", model: "admission-model" };
const endpoint = "https://provider.example/v1";
const config = () => ({ id: reference.provider, api: "openai-completions" as const, baseUrl: endpoint,
  apiKey: "test-only-provider-key", headers: {}, quota: {}, fallback: [],
  models: [{ id: reference.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false }] });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function completion() {
  const common = { id: "chatcmpl-admission-fixture", object: "chat.completion.chunk", created: 1, model: reference.model };
  return [
    { ...common, choices: [{ index: 0, delta: { role: "assistant", content: "actual library response" }, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}
function response() { return new Response(completion(), { headers: { "content-type": "text/event-stream" } }); }
function receiver() {
  const messages: AssistantStepResult[] = [];
  const sink: EngineSink = {
    onStepStart: vi.fn(), onTextDelta: vi.fn(), onReasoningDelta: vi.fn(), onToolArgsDelta: vi.fn(),
    onAssistantMessage: vi.fn(async message => { messages.push(message); }),
    beforeToolCall: vi.fn(async () => ({ allow: true as const })), onToolExecutionStart: vi.fn(), onToolProgress: vi.fn(),
    afterToolCall: vi.fn(async value => value), onToolResult: vi.fn(async () => {}), onStepEnd: vi.fn(async () => "end" as const),
  };
  return { sink, messages };
}
async function fixture(options: { limit?: ProviderQuotaLimit; fetch?: typeof fetch } = {}) {
  const store = new MemorySessionStore();
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "pi-admission", namespaceId: "fixture" });
  const delegate = vi.fn(options.fetch ?? (async () => response())), reservations: ProviderQuotaLease[] = [];
  const service = new ProviderService({ store, cipher: new LocalAesGcmCipher("17".repeat(32)),
    assertBaseUrl: async () => {}, fetch: delegate, persistedProviderFailureCaptureActive: true,
    quota: { coordinator: quota, tenant: options.limit ?? {}, user: {} } });
  await service.upsertTenantProvider(principal.tenantId, config());
  const model = await service.resolve(principal, reference);
  const start = (resolved: ResolvedModel = model) => {
    const target = receiver();
    const run = new PiEngine(service.models).start({ model: resolved, systemPrompt: "fixture", tools: [], history: [],
      input: [{ type: "text", text: "fixture input" }], signal: new AbortController().signal,
      toolContext: { principal, sessionId: "session-fixture", turnId: "turn-fixture" } }, target.sink);
    return { ...target, run };
  };
  return { store, quota, service, model, delegate, start,
    reserve: async () => {
      const lease = await quota.enter({ ...principal, provider: { scope: "tenant", id: reference.provider },
        tenant: options.limit ?? {}, user: {}, providerLimit: {} }, new AbortController().signal);
      reservations.push(lease); return lease;
    },
    close: async () => {
      try { await Promise.all(reservations.map(lease => lease.release())); await quota.close(); }
      finally { await store.close(); }
    },
  };
}
function noProviderAttempt(result: Awaited<EngineRun["done"]>, target: ReturnType<typeof receiver>, code: string) {
  expect(result.error).toBe(code); expect(result.aborted).toBe(false);
  expect(target.sink.onAssistantMessage).not.toHaveBeenCalled(); expect(target.messages).toEqual([]);
  expect(target.sink.onStepEnd).not.toHaveBeenCalled(); expect(target.sink.onTextDelta).not.toHaveBeenCalled();
  expect(getPiProviderStepFailure(result)).toBeUndefined(); expect(getPiProviderStepFailureMessage(result)).toBeUndefined();
}

// Real Pi Agent, registered OpenAI adapter, ProviderService and Memory quota. Response bytes are
// synthetic wire fixtures, not a real HTTP/Redis/provider-billing or 0053 durable-store proof.
describe("Pi server-owned provider admission provenance", () => {
  it.each(["rpm", "concurrency", "revision", "tenant"] as const)("does not invent a provider attempt for a known %s denial", async reason => {
    const limit = reason === "rpm" ? { rpm: 1 } : reason === "concurrency" ? { concurrency: 1 } : {};
    const f = await fixture({ limit });
    try {
      if (reason === "rpm" || reason === "concurrency") {
        const lease = await f.reserve(); if (reason === "rpm") await lease.release();
      } else if (reason === "revision") {
        await f.service.upsertTenantProvider(principal.tenantId, { ...config(), quota: { rpm: 1 } });
      } else {
        await f.store.setTenantAuth(principal.tenantId, DEFAULT_AUTH_POLICY);
        await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: principal.tenantId,
          requestedByKeyId: "fixture-admin", idempotencyKey: "fixture-delete", requestHash: tenantErasureRequestHash(principal.tenantId), atMs: Date.now() });
      }
      const target = f.start(), result = await target.run.done;
      noProviderAttempt(result, target, reason === "revision" ? "draining" : reason === "tenant" ? "subject_deleting" : "quota_exceeded");
      expect(f.delegate).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("test-only-provider-key");
    } finally { await f.close(); }
  });

  it("runs the trusted final admission hook only after quota and never treats its rejection as upstream", async () => {
    const f = await fixture({ limit: { concurrency: 1 } });
    const hook = vi.fn(async () => { throw new Error("private-budget-hook-canary"); });
    const model: ResolvedModel = { ...f.model, createRequest: () => f.model.createRequest!(hook) };
    try {
      const held = await f.reserve(), blocked = f.start(model);
      noProviderAttempt(await blocked.run.done, blocked, "quota_exceeded"); expect(hook).not.toHaveBeenCalled();
      await held.release();
      const rejected = f.start(model); noProviderAttempt(await rejected.run.done, rejected, "draining");
      expect(hook).toHaveBeenCalledOnce(); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["config-read", "tenant-read", "api-key", "sdk-build"] as const)("keeps a local %s failure non-dispatched without inventing a quota code or usage", async failureAt => {
    const f = await fixture(); let model = f.model;
    try {
      if (failureAt === "config-read") vi.spyOn(f.store, "getProviderConfig").mockRejectedValueOnce(new Error("private-provider-canary"));
      else if (failureAt === "tenant-read") vi.spyOn(f.store, "getTenantRuntimeState").mockRejectedValueOnce(new Error("private-provider-canary"));
      else if (failureAt === "api-key") model = { ...model, createRequest: beforeDispatch => ({
        ...f.model.createRequest!(beforeDispatch), apiKey: async () => { throw new Error("private-provider-canary"); },
      }) };
      else model = { ...model, headers: { "x-invalid-fixture-header": "private-provider-canary\ninvalid" } };
      const target = f.start(model), result = await target.run.done;
      noProviderAttempt(result, target, "provider_error");
      expect(f.delegate).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("private-provider-canary");
    } finally { await f.close(); }
  });

  it.each(["private-provider-canary", "Provider admission is unavailable."])("retains real dispatched failures without trusting their error text (%#)", async message => {
    const f = await fixture({ fetch: async () => { throw new Error(message); } });
    try {
      const target = f.start(), result = await target.run.done;
      expect(f.delegate).toHaveBeenCalledOnce(); expect(result.error).toBe("provider_error");
      expect(getPiProviderStepFailure(result)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(target.messages).toHaveLength(1);
      expect(getPiProviderStepFailure(target.messages[0])).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(target.messages[0]!.stopReason).toBe("error");
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(JSON.stringify(target.messages).includes(message)).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps dispatched slot loss unknown-cost without an upstream source and joins the real body cancellation", async () => {
    const dispatched = barrier(), cancelEntered = barrier(), cancelAck = barrier();
    const f = await fixture({ fetch: async () => {
      dispatched.resolve();
      return new Response(new ReadableStream<Uint8Array>({ async cancel() { cancelEntered.resolve(); await cancelAck.promise; } }),
        { headers: { "content-type": "text/event-stream" } });
    } });
    const target = f.start(); let closed = false;
    let closing: Promise<void> | undefined;
    try {
      await dispatched.promise; closing = f.quota.close().then(() => { closed = true; });
      await cancelEntered.promise; expect(closed).toBe(false);
      cancelAck.resolve(); const result = await target.run.done; await closing;
      expect(f.delegate).toHaveBeenCalledOnce(); expect(result.error).toBe("provider_error");
      expect(getPiProviderStepFailure(result)).toBeUndefined();
      expect(target.messages).toHaveLength(1); expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
    } finally { cancelAck.resolve(); await Promise.allSettled([target.run.done, ...(closing ? [closing] : [])]); await f.close(); }
  });

  it("isolates concurrent model request lifetimes on the same resolved handle", async () => {
    const dispatched = barrier(); let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const f = await fixture({ limit: { concurrency: 1 }, fetch: async () => {
      const result = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }),
        { headers: { "content-type": "text/event-stream" } });
      dispatched.resolve(); return result;
    } });
    const accepted = f.start(); let rejected: ReturnType<typeof f.start> | undefined;
    try {
      await dispatched.promise;
      rejected = f.start(); noProviderAttempt(await rejected.run.done, rejected, "quota_exceeded");
      body!.enqueue(new TextEncoder().encode(completion())); body!.close();
      const result = await accepted.run.done;
      expect(result.error).toBeUndefined(); expect(result.aborted).toBe(false);
      expect(accepted.messages).toHaveLength(1); expect(accepted.messages[0]!.text).toBe("actual library response");
      expect(getPiProviderStepFailure(result)).toBeUndefined(); expect(f.delegate).toHaveBeenCalledOnce();
    } finally {
      accepted.run.interrupt();
      await Promise.allSettled([accepted.run.done, ...(rejected ? [rejected.run.done] : [])]); await f.close();
    }
  });

  it.each(["quota_exceeded", "draining", "subject_deleting"] as const)("gives compaction the same closed %s error without a vendor call", async code => {
    const f = await fixture({ limit: code === "quota_exceeded" ? { rpm: 1 } : {} });
    try {
      if (code === "quota_exceeded") { const lease = await f.reserve(); await lease.release(); }
      else if (code === "draining") await f.service.upsertTenantProvider(principal.tenantId, { ...config(), quota: { rpm: 1 } });
      else {
        await f.store.setTenantAuth(principal.tenantId, DEFAULT_AUTH_POLICY);
        await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: principal.tenantId,
          requestedByKeyId: "fixture-admin", idempotencyKey: "fixture-delete", requestHash: tenantErasureRequestHash(principal.tenantId), atMs: Date.now() });
      }
      const pending = new PiSummariser(f.service.models).summarise({ model: f.model, systemPrompt: "fixture", text: "fixture history" });
      await expect(pending).rejects.toBeInstanceOf(ApiError);
      await expect(pending).rejects.toMatchObject({ code, message: code === "quota_exceeded" ? "Provider quota exceeded."
        : code === "draining" ? "Provider admission is unavailable." : "Subject is being deleted." });
      expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
