import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import {
  MemoryProviderQuotaCoordinator, MemorySessionStore, ProviderPoolError, ProviderQuotaError, SubjectDeletingError, newErasureRequestId, tenantErasureRequestHash,
  type ProviderPoolCoordinator, type ProviderPoolInventory, type ProviderPoolLease, type ProviderPoolOutcome,
  type ProviderPoolPolicy, type ProviderPoolSelection, type ProviderQuotaLimit,
} from "@agent-service/store";
import { PiEngine, getPiProviderStepFailure } from "../../core/src/engine/pi.js";
import type { AssistantStepResult, EngineSink, ProviderModelRequest, ResolvedModel } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService, type PlatformProvider } from "../src/index.js";

const owner = { tenantId: "pool-tenant", userId: "pool-user" }, ref = { provider: "pool-provider", model: "pool-model" };
const url = "https://provider.example/v1/chat/completions";
const config = () => ({ id: ref.provider, api: "openai-completions" as const, baseUrl: "https://provider.example/v1", headers: {}, quota: {}, fallback: [],
  models: [{ id: ref.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
const slots = () => [{ id: "slot-a", version: "v1", apiKey: "private-pool-key-a" }, { id: "slot-b", version: "v1", apiKey: "private-pool-key-b" }];
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function sse() { return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: ref.model,
  choices: [{ index: 0, delta: { role: "assistant", content: "pool response" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }

// A controllable contract double, not evidence of Redis Lua, clocks, sockets or cross-runner state.
class ControlledPool implements ProviderPoolCoordinator {
  readonly namespaceSha256 = "13".repeat(32);
  readonly events: string[] = [];
  readonly outcomes: ProviderPoolOutcome[] = [];
  readonly inventories: ProviderPoolInventory[] = [];
  readonly policies: ProviderPoolPolicy[] = [];
  readonly controllers = new Set<AbortController>();
  private issued = new WeakSet<object>(); private cursor = 0; private pending = new Set<Promise<void>>();
  selectError?: Error; acquireError?: Error; releaseHook?: (outcome: ProviderPoolOutcome) => Promise<void>;
  async assertReady() {}
  async select(inventory: ProviderPoolInventory, policy: ProviderPoolPolicy, signal: AbortSignal) {
    signal.throwIfAborted(); this.events.push("select"); this.inventories.push(inventory); this.policies.push(policy);
    if (this.selectError) throw this.selectError;
    const selection = Object.freeze({ slot: Object.freeze({ ...inventory.slots[this.cursor++ % inventory.slots.length]! }) });
    this.issued.add(selection); return selection;
  }
  async acquire(selection: ProviderPoolSelection, signal: AbortSignal): Promise<ProviderPoolLease> {
    signal.throwIfAborted(); this.events.push("acquire");
    if (this.acquireError) throw this.acquireError;
    if (!this.issued.has(selection)) throw new ProviderPoolError("unavailable");
    const controller = new AbortController(), done = barrier(); this.controllers.add(controller); this.pending.add(done.promise);
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    let releasing: Promise<void> | undefined;
    return { signal: controller.signal, assertOpen: async () => { if (controller.signal.aborted) throw new ProviderPoolError("unavailable"); },
      release: outcome => releasing ??= (async () => {
        this.events.push("release"); this.outcomes.push(outcome);
        try { await this.releaseHook?.(outcome); }
        finally { signal.removeEventListener("abort", abort); controller.abort(); this.controllers.delete(controller); this.pending.delete(done.promise); done.resolve(); }
      })() };
  }
  async close() { for (const controller of this.controllers) controller.abort(); await Promise.all([...this.pending]); }
}

async function fixture(options: { fetch?: typeof fetch; limit?: ProviderQuotaLimit; pool?: ControlledPool; platform?: PlatformProvider[]; policy?: ProviderPoolPolicy;
  authorizeFleet?: (signal: AbortSignal) => Promise<void> } = {}) {
  const store = new MemorySessionStore(), pool = options.pool ?? new ControlledPool();
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "pool-service", namespaceId: "fixture" });
  const delegate = vi.fn(options.fetch ?? (async () => new Response("provider body"))), responses = new Set<Response>();
  const platform = options.platform ?? [{ config: config(), keyPool: slots() }];
  const service = new ProviderService({ store, cipher: new LocalAesGcmCipher("31".repeat(32)), platform, assertBaseUrl: async () => {}, fetch: delegate,
    persistedProviderFailureCaptureActive: true, quota: { coordinator: quota, tenant: options.limit ?? {}, user: {},
      ...(options.authorizeFleet ? { authorizeFleet: options.authorizeFleet } : {}) }, keyPool: { coordinator: pool, policy: options.policy ?? {} } });
  const model = await service.resolve(owner, ref);
  const dispatch = async (request = model.createRequest!(), signal = new AbortController().signal) => {
    const key = await request.apiKey!(signal);
    const response = await request.fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}", signal });
    responses.add(response); return { request, response };
  };
  return { store, pool, quota, delegate, service, model, dispatch, close: async () => {
    const cancelled = await Promise.allSettled([...responses].map(r => r.body && !r.body.locked ? r.body.cancel() : Promise.resolve()));
    const closed = await Promise.allSettled([pool.close(), quota.close(), store.close()]);
    if ([...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("Pool service fixture did not settle.");
  } };
}
function startPi(f: Awaited<ReturnType<typeof fixture>>) {
  const messages: AssistantStepResult[] = [], requests: ProviderModelRequest[] = [];
  const model: ResolvedModel = { ...f.model, createRequest: before => { const request = f.model.createRequest!(before); requests.push(request); return request; } };
  const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
    async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; },
    onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
  const run = new PiEngine(f.service.models).start({ model, systemPrompt: "fixture", history: [], tools: [], input: [{ type: "text", text: "fixture" }],
    signal: new AbortController().signal, toolContext: { principal: owner, sessionId: "pool-session", turnId: "pool-turn" } }, sink);
  return { run, messages, requests };
}

describe("ProviderService platform pool request binding", () => {
  it.each(["empty", "duplicate", "bad-id", "bad-version", "bad-secret", "too-many", "both-keys", "missing-coordinator", "auth-header"])("rejects %s configuration without retaining a secret in the error", async reason => {
    const store = new MemorySessionStore(), pool = new ControlledPool(), values = slots();
    const platform: PlatformProvider = { config: config(), keyPool: values };
    if (reason === "empty") platform.keyPool = [];
    if (reason === "duplicate") values[1]!.id = values[0]!.id;
    if (reason === "bad-id") values[0]!.id = "bad\n";
    if (reason === "bad-version") values[0]!.version = "bad version";
    if (reason === "bad-secret") values[0]!.apiKey += "\n";
    if (reason === "too-many") platform.keyPool = Array.from({ length: 33 }, (_, i) => ({ ...values[0]!, id: `slot-${i}` }));
    if (reason === "both-keys") platform.apiKey = "private-single-key";
    if (reason === "auth-header") platform.config = { ...platform.config, headers: { AuThOrIzAtIoN: "private-header-key" } };
    try {
      expect(() => new ProviderService({ store, cipher: new LocalAesGcmCipher("31".repeat(32)), platform: [platform],
        ...(reason === "missing-coordinator" ? {} : { keyPool: { coordinator: pool, policy: {} } }) })).toThrow("Invalid provider key pool configuration.");
    } finally { await pool.close(); await store.close(); }
  });

  it("privately snapshots slots and policy, caches each selection, and isolates concurrent requests on one handle", async () => {
    const pool = new ControlledPool(), values = slots(), policy = { threshold: 2 };
    const f = await fixture({ pool, platform: [{ config: config(), keyPool: values }], policy });
    policy.threshold = 100;
    const first = f.model.createRequest!(), second = f.model.createRequest!();
    try {
      const keys = await Promise.all([first.apiKey!(), first.apiKey!(), second.apiKey!()]);
      values[0]!.apiKey = "mutated-private-key"; values[1]!.id = "mutated-slot";
      expect(keys[0] === "private-pool-key-a" && keys[1] === keys[0] && keys[2] === "private-pool-key-b").toBe(true);
      expect(pool.events).toEqual(["select", "select"]); expect(pool.inventories[0]!.slots.map(slot => slot.id)).toEqual(["slot-a", "slot-b"]);
      const a = await f.dispatch(first), b = await f.dispatch(second); await Promise.all([a.response.text(), b.response.text()]);
      expect(f.delegate).toHaveBeenCalledTimes(2); expect(pool.outcomes).toEqual([{ kind: "success" }, { kind: "success" }]);
      expect(JSON.stringify(pool.inventories)).not.toContain("private-pool-key"); expect(Object.isFrozen(pool.inventories[0]!.slots)).toBe(true);
      expect(Object.isFrozen(pool.policies[0])).toBe(true); expect(pool.policies[0]!.threshold).toBe(2);
      await expect(f.model.apiKey()).rejects.toBeInstanceOf(ProviderPoolError); await expect(f.model.fetch!(url)).rejects.toBeInstanceOf(ProviderPoolError);
    } finally { await f.close(); }
  });

  it("never borrows a platform slot for BYOK and rejects an old platform pin after a BYOK shadow", async () => {
    const f = await fixture(), pinned = f.model.createRequest!();
    try {
      await pinned.apiKey!(); await f.service.upsertTenantProvider(owner.tenantId, { ...config(), apiKey: "private-byok-key" });
      await expect(pinned.fetch(url, { headers: { authorization: "Bearer private-pool-key-a" } })).rejects.toMatchObject({ reason: "unavailable" });
      const byok = await f.service.resolve(owner, ref), request = byok.createRequest!();
      expect((await request.apiKey!()) === "private-byok-key").toBe(true);
      const result = await f.dispatch(request); await result.response.text();
      expect(f.pool.events).toEqual(["select"]); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("admits quota before the pinned permit and family budget, without reselecting an unavailable pin", async () => {
    const f = await fixture({ limit: { concurrency: 1 } }), events: string[] = [];
    const enter = f.quota.enter.bind(f.quota); vi.spyOn(f.quota, "enter").mockImplementation(async (...args) => { events.push("quota"); return enter(...args); });
    const acquire = f.pool.acquire.bind(f.pool); vi.spyOn(f.pool, "acquire").mockImplementation(async (...args) => { events.push("pool"); return acquire(...args); });
    const request = f.model.createRequest!(async () => { events.push("budget"); });
    try {
      const held = await f.quota.enter({ ...owner, provider: { scope: "platform", id: ref.provider }, tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, new AbortController().signal);
      try { await expect(f.dispatch(request)).rejects.toMatchObject({ reason: "concurrency" }); }
      finally { await held.release(); }
      expect(events).toEqual(["quota", "quota"]); expect(f.pool.events).toEqual(["select"]);
      f.pool.acquireError = new ProviderPoolError("open");
      await expect(f.dispatch(request)).rejects.toMatchObject({ reason: "open" });
      expect(events).toEqual(["quota", "quota", "quota", "pool"]); expect(f.pool.events.filter(x => x === "select")).toHaveLength(1);
      expect(f.delegate).not.toHaveBeenCalled(); expect(request.wasDispatched()).toBe(false); expect(request.admissionFailure()).toBe("draining");
    } finally { await f.close(); }
  });

  it("rejects a mismatched Authorization before actual delegate entry", async () => {
    const f = await fixture(), request = f.model.createRequest!();
    try {
      await request.apiKey!(); await expect(request.fetch(url, { headers: { authorization: "Bearer private-other-key" } })).rejects.toBeInstanceOf(ProviderPoolError);
      expect(f.delegate).not.toHaveBeenCalled(); expect(request.wasDispatched()).toBe(false); expect(f.pool.outcomes).toEqual([{ kind: "cancelled" }]);
    } finally { await f.close(); }
  });

  it("freshly reauthorizes the configured fleet after awaited family admission and settles both permits on rejection", async context => {
    const entered = barrier(), resume = barrier(); let fleetOpen = true, budgetCalls = 0;
    const authorizeFleet = vi.fn(async (signal: AbortSignal) => { signal.throwIfAborted(); if (!fleetOpen) throw new ProviderQuotaError("unavailable"); });
    const f = await fixture({ limit: { concurrency: 1 }, authorizeFleet });
    const request = f.model.createRequest!(async () => { budgetCalls++; entered.resolve(); await resume.promise; });
    const pending = f.dispatch(request, context.signal);
    const settled = pending.then(value => ({ value }), error => ({ error })); // Own rejection immediately, including while the barrier is held.
    try {
      await Promise.race([entered.promise, settled.then(() => { throw new Error("Provider fixture did not reach family admission."); })]);
      expect(f.pool.controllers.size).toBe(1); expect(f.delegate).not.toHaveBeenCalled();
      const callsBefore = authorizeFleet.mock.calls.length; fleetOpen = false; resume.resolve();
      const result = await settled;
      expect(result).toMatchObject({ error: { reason: "unavailable" } }); expect(authorizeFleet.mock.calls.length).toBeGreaterThan(callsBefore);
      expect(budgetCalls).toBe(1); expect(request.wasDispatched()).toBe(false); expect(request.admissionFailure()).toBe("draining");
      expect(f.delegate).not.toHaveBeenCalled(); expect(f.pool.events).toEqual(["select", "acquire", "release"]);
      expect(f.pool.outcomes).toEqual([{ kind: "cancelled" }]); expect(f.pool.controllers.size).toBe(0);
      const probe = await f.quota.enter({ ...owner, provider: { scope: "platform", id: ref.provider }, tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, context.signal);
      await probe.release(); // Actual Memory quota admission proves the prior request no longer holds its slot.
    } finally { resume.resolve(); await settled; await f.close(); }
  });

  it.for(["unchanged", "shadow", "t1"] as const)(
    "rechecks ordinary platform %s state after the fourth and final fleet check", async (change, context) => {
      const entered = barrier(), resume = barrier(); let fleetCalls = 0;
      const authorizeFleet = vi.fn(async (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (++fleetCalls === 4) {
          entered.resolve(); const cancel = () => resume.resolve();
          signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
          try { await resume.promise; } finally { signal.removeEventListener("abort", cancel); }
        }
        signal.throwIfAborted();
      });
      const f = await fixture({ limit: { concurrency: 1 }, authorizeFleet });
      if (change === "t1") await f.store.setTenantAuth(owner.tenantId, DEFAULT_AUTH_POLICY);
      const request = f.model.createRequest!(), pending = f.dispatch(request, context.signal);
      const settled = pending.then(value => ({ value }), error => ({ error }));
      try {
        await Promise.race([entered.promise, settled.then(() => { throw new Error("Platform fixture did not reach final fleet check."); })]);
        expect(authorizeFleet).toHaveBeenCalledTimes(4); expect(f.delegate).not.toHaveBeenCalled();
        expect(request.wasDispatched()).toBe(false); expect(f.pool.controllers.size).toBe(1);
        if (change === "shadow") await f.service.upsertTenantProvider(owner.tenantId, { ...config(), apiKey: "private-new-byok-canary" });
        if (change === "t1") await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: owner.tenantId,
          requestedByKeyId: "fixture-admin", idempotencyKey: "pool-final-fleet-delete",
          requestHash: tenantErasureRequestHash(owner.tenantId), atMs: Date.now() });
        resume.resolve(); const result = await settled;
        if (change === "unchanged") {
          expect(result).toHaveProperty("value");
          if (!("value" in result)) throw new Error("Platform fixture unexpectedly rejected.");
          await result.value.response.text();
          expect(f.delegate).toHaveBeenCalledOnce(); expect(request.wasDispatched()).toBe(true);
          expect(request.admissionFailure()).toBeUndefined(); expect(f.pool.outcomes).toEqual([{ kind: "success" }]);
        } else {
          expect(result).toHaveProperty("error");
          if (!("error" in result)) throw new Error("Platform fixture unexpectedly dispatched.");
          expect(result.error).toBeInstanceOf(change === "t1" ? SubjectDeletingError : ProviderQuotaError);
          if (change === "shadow") expect(result.error).toMatchObject({ reason: "unavailable" });
          expect(f.delegate).not.toHaveBeenCalled(); expect(request.wasDispatched()).toBe(false);
          expect(request.admissionFailure()).toBe(change === "t1" ? "subject_deleting" : "draining");
          expect(f.pool.outcomes).toEqual([{ kind: "cancelled" }]);
        }
        expect(authorizeFleet).toHaveBeenCalledTimes(4); expect(f.pool.events).toEqual(["select", "acquire", "release"]);
        expect(f.pool.controllers.size).toBe(0);
        const probe = await f.quota.enter({ ...owner, provider: { scope: "platform", id: ref.provider },
          tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, context.signal);
        await probe.release();
      } finally { resume.resolve(); await settled; await f.close(); }
    });

  it("rechecks T1 even when the same request already cached its selected key", async () => {
    const f = await fixture(), request = f.model.createRequest!();
    try {
      await request.apiKey!(); await f.store.setTenantAuth(owner.tenantId, DEFAULT_AUTH_POLICY);
      await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: owner.tenantId, requestedByKeyId: "fixture-admin",
        idempotencyKey: "pool-delete", requestHash: tenantErasureRequestHash(owner.tenantId), atMs: Date.now() });
      await expect(request.apiKey!()).rejects.toMatchObject({ name: "SubjectDeletingError" });
      expect(request.admissionFailure()).toBe("subject_deleting"); expect(f.pool.events).toEqual(["select"]); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});

describe("ProviderService pool completion and actual stream settlement", () => {
  it.each([
    [200, undefined, { kind: "success" }], [401, undefined, { kind: "credential_rejected" }], [403, undefined, { kind: "credential_rejected" }],
    [400, undefined, { kind: "neutral" }], [503, undefined, { kind: "failure" }],
    [429, "2", { kind: "rate_limited", retryDelayMs: 2000 }], [429, "1.5", { kind: "rate_limited" }],
    [429, "9007199254740991", { kind: "rate_limited", retryDelayMs: 3600000 }], [429, "9007199254740992", { kind: "rate_limited" }],
    [429, new Date(Date.UTC(2037, 0, 1)).toUTCString(), { kind: "rate_limited", retryAtMs: Date.UTC(2037, 0, 1) }],
  ] as const)("reports HTTP %s only after its real body settles (%#)", async (status, retryAfter, outcome) => {
    const f = await fixture({ fetch: async () => new Response("body", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} }) });
    try {
      const result = await f.dispatch(); expect(f.pool.outcomes).toEqual([]); expect(f.pool.controllers.size).toBe(1);
      await result.response.text(); expect(f.pool.outcomes).toEqual([outcome]); expect(f.pool.controllers.size).toBe(0);
      expect(result.request.wasDispatched()).toBe(true); expect(result.request.admissionFailure()).toBeUndefined();
    } finally { await f.close(); }
  });

  it("holds both permits through an actual cancellation acknowledgement", async () => {
    const entered = barrier(), ack = barrier();
    const f = await fixture({ limit: { concurrency: 1 }, fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    const result = await f.dispatch(); let cancellation: Promise<void> | undefined;
    try {
      cancellation = result.response.body!.cancel(); await entered.promise;
      expect(f.pool.controllers.size).toBe(1); expect(f.pool.outcomes).toEqual([]);
      await expect(f.dispatch()).rejects.toMatchObject({ reason: "concurrency" });
      ack.resolve(); await cancellation; expect(f.pool.controllers.size).toBe(0); expect(f.pool.outcomes).toEqual([{ kind: "cancelled" }]);
    } finally { ack.resolve(); await cancellation; await f.close(); }
  });

  it("does not certify pool close before the consumer's body cancellation settles", async () => {
    const entered = barrier(), ack = barrier();
    const f = await fixture({ fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    const result = await f.dispatch(); let closed = false;
    const closing = f.pool.close().then(() => { closed = true; });
    try {
      await entered.promise; expect(closed).toBe(false); expect(result.request.hasLocalFailure?.()).toBe(true);
      ack.resolve(); await closing; expect(f.pool.outcomes).toEqual([{ kind: "cancelled" }]);
      expect(result.request.wasDispatched()).toBe(true); expect(result.request.admissionFailure()).toBeUndefined();
      await expect(result.response.text()).rejects.toMatchObject({ reason: "unavailable" });
    } finally { ack.resolve(); await closing; await f.close(); }
  });

  it("preserves a real delegate failure when health release also fails, then fences the whole service", async () => {
    const original = new Error("private-upstream-failure"), f = await fixture({ fetch: async () => { throw original; } });
    f.pool.releaseHook = async () => { throw new Error("private-health-failure"); };
    const request = f.model.createRequest!();
    try {
      await expect(f.dispatch(request)).rejects.toBe(original); expect(request.wasDispatched()).toBe(true);
      expect(request.hasLocalFailure?.()).toBe(false); expect(request.admissionFailure()).toBeUndefined();
      await expect(f.service.resolve(owner, ref)).rejects.toMatchObject({ reason: "unavailable" }); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
});

describe("Real Pi and Service pool failure provenance", () => {
  it("keeps a pool selection denial non-dispatched with no usage or upstream failure source", async () => {
    const f = await fixture({ fetch: async () => sse() }); f.pool.selectError = new ProviderPoolError("open");
    const target = startPi(f);
    try {
      const result = await target.run.done; expect(result.error).toBe("draining"); expect(target.messages).toEqual([]);
      expect(f.delegate).not.toHaveBeenCalled(); expect(getPiProviderStepFailure(result)).toBeUndefined();
      expect(target.requests[0]!.wasDispatched()).toBe(false);
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it("retains dispatched unknown usage but not an upstream source for a primary local EOF health error", async () => {
    const f = await fixture({ fetch: async () => sse() }); f.pool.releaseHook = async () => { throw new Error("private-health-failure"); };
    const target = startPi(f);
    try {
      const result = await target.run.done; expect(result.error).toBe("provider_error"); expect(f.delegate).toHaveBeenCalledOnce();
      expect(target.requests[0]!.wasDispatched()).toBe(true); expect(target.requests[0]!.hasLocalFailure?.()).toBe(true);
      expect(target.messages).toHaveLength(1); expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(result)).toBeUndefined(); expect(getPiProviderStepFailure(target.messages[0])).toBeUndefined();
      expect(JSON.stringify({ result, messages: target.messages })).not.toContain("private-health-failure");
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it.each(["delegate", "http", "body"] as const)("does not erase an original %s failure's provenance for a secondary health failure", async original => {
    const f = await fixture({ fetch: original === "delegate" ? async () => { throw new Error("private-upstream-failure"); }
      : original === "http" ? async () => new Response("private-upstream-body", { status: 503 })
      : async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-upstream-body")); } }),
        { headers: { "content-type": "text/event-stream" } }) });
    f.pool.releaseHook = async () => { throw new Error("private-health-failure"); }; const target = startPi(f);
    try {
      const result = await target.run.done; expect(result.error).toBe("provider_error"); expect(f.delegate).toHaveBeenCalledOnce();
      expect(target.requests[0]!.wasDispatched()).toBe(true); expect(target.requests[0]!.hasLocalFailure?.()).toBe(false);
      expect(target.messages).toHaveLength(1); expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(getPiProviderStepFailure(result)).toEqual({ failureKind: "provider_step_error", stepIndex: 1 });
      expect(JSON.stringify(target.messages)).not.toContain("private-");
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });
});
