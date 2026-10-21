import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AUTH_POLICY } from "@agent-service/protocol";
import { MemoryProviderPoolCoordinator, MemoryProviderQuotaCoordinator, MemorySessionStore, ProviderPoolError, ProviderQuotaError,
  newErasureRequestId, tenantErasureRequestHash, type ProviderPoolPolicy } from "@agent-service/store";
import { PiEngine, getPiProviderStepFailure } from "../../core/src/engine/pi.js";
import type { AssistantStepResult, EngineSink, ProviderModelRequest, ResolvedModel } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService, type PlatformProvider } from "../src/index.js";

const owner = { tenantId: "byok-tenant", userId: "byok-user" }, ref = { provider: "byok-provider", model: "byok-model" };
const key = "private-byok-canary", url = "https://provider.example/v1/chat/completions";
const keylessHeaders: Record<string, string>[] = [{}, { "x-api-key": "private-header-canary" }, { AuThOrIzAtIoN: "Custom private-header-canary" }];
const config = () => ({ id: ref.provider, api: "openai-completions" as const, baseUrl: "https://provider.example/v1", headers: {}, quota: {}, fallback: [],
  models: [{ id: ref.model, contextWindow: 1000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
    price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function sse() { return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: ref.model,
  choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }); }

async function fixture(options: { fetch?: typeof fetch; policy?: ProviderPoolPolicy; platform?: PlatformProvider[]; enabled?: boolean;
  authorizeFleet?: (signal: AbortSignal) => Promise<void> } = {}) {
  const store = new MemorySessionStore(), cipher = new LocalAesGcmCipher("73".repeat(32));
  const pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "byok-service", namespaceId: "fixture" });
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "byok-service", namespaceId: "fixture" });
  const delegate = vi.fn(options.fetch ?? (async () => new Response("body"))), responses = new Set<Response>();
  const acquireOriginal = pool.acquire.bind(pool);
  const selected = vi.spyOn(pool, "select"), acquired = vi.spyOn(pool, "acquire"), decrypted = vi.spyOn(cipher, "decrypt");
  const service = new ProviderService({ store, cipher, assertBaseUrl: async () => {}, fetch: delegate, platform: options.platform,
    persistedProviderFailureCaptureActive: true, quota: { coordinator: quota, tenant: { concurrency: 1 }, user: {},
      ...(options.authorizeFleet ? { authorizeFleet: options.authorizeFleet } : {}) },
    ...(options.enabled === false ? {} : { byokBreaker: { coordinator: pool, policy: options.policy ?? { threshold: 1 } } }),
    ...(options.platform?.some(value => value.keyPool) ? { keyPool: { coordinator: pool, policy: { threshold: 1 } } } : {}) });
  await service.upsertTenantProvider(owner.tenantId, { ...config(), apiKey: key });
  const dispatch = async (model: ResolvedModel, request = model.createRequest!(), signal = new AbortController().signal) => {
    const apiKey = await request.apiKey!(signal), headers = new Headers(model.headers);
    if (!headers.has("authorization") && apiKey !== undefined) headers.set("authorization", `Bearer ${apiKey}`);
    const response = await request.fetch(url, { headers, signal }); responses.add(response); return { request, response };
  };
  return { store, pool, quota, cipher, decrypted, service, delegate, selected, acquired, acquireOriginal, dispatch, responses,
    model: () => service.resolve(owner, ref), close: async () => {
      const cancelled = await Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
      const closed = await Promise.allSettled([pool.close(), quota.close(), store.close()]);
      if ([...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("BYOK fixture did not settle.");
    } };
}
function startPi(f: Awaited<ReturnType<typeof fixture>>, model: ResolvedModel) {
  const messages: AssistantStepResult[] = [], requests: ProviderModelRequest[] = [];
  const bound = { ...model, createRequest: (before?: () => Promise<void>) => { const request = model.createRequest!(before); requests.push(request); return request; } };
  const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
    async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; },
    onToolExecutionStart() {}, onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
  const run = new PiEngine(f.service.models).start({ model: bound, systemPrompt: "fixture", history: [], tools: [], input: [{ type: "text", text: "fixture" }],
    signal: new AbortController().signal, toolContext: { principal: owner, sessionId: "byok-session", turnId: "byok-turn" } }, sink);
  return { run, messages, requests };
}

describe("Explicit BYOK single-credential breaker", () => {
  it.each([0, undefined, -1, Number.MAX_SAFE_INTEGER + 1])("rejects unproven revision %s before selection or decryption", async revision => {
    const f = await fixture(), get = f.store.getProviderConfig.bind(f.store);
    vi.spyOn(f.store, "getProviderConfig").mockImplementation(async (...args) => {
      const current = await get(...args); return current ? { ...current, credentialSourceRevision: revision as number } : null;
    });
    try {
      await expect(f.model()).rejects.toMatchObject({ reason: "unavailable" });
      expect(f.selected).not.toHaveBeenCalled(); expect(f.decrypted).not.toHaveBeenCalled(); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("keeps the unconfigured legacy path unchanged and rejects an explicitly missing coordinator", async () => {
    const f = await fixture({ enabled: false }), get = f.store.getProviderConfig.bind(f.store);
    vi.spyOn(f.store, "getProviderConfig").mockImplementation(async (...args) => {
      const current = await get(...args); return current ? { ...current, credentialSourceRevision: 0 } : null;
    });
    try {
      const model = await f.model(); expect((await model.apiKey()) === key).toBe(true);
      const response = await model.fetch!(url); await response.text(); expect(f.selected).not.toHaveBeenCalled();
      expect(() => new ProviderService({ store: f.store, cipher: f.cipher, byokBreaker: { coordinator: undefined!, policy: {} } }))
        .toThrow("Invalid provider key pool configuration.");
    } finally { await f.close(); }
  });

  it("pins one immutable selection and key per request, snapshots policy, and exposes no tenant, endpoint or secret inventory", async () => {
    const policy = { threshold: 2 }, f = await fixture({ policy }); policy.threshold = 100;
    try {
      const model = await f.model(), first = model.createRequest!(), second = model.createRequest!();
      const values = await Promise.all([first.apiKey!(), first.apiKey!(), second.apiKey!()]);
      expect(values.every(value => value === key)).toBe(true); expect(f.selected).toHaveBeenCalledTimes(2); expect(f.decrypted).toHaveBeenCalledTimes(2);
      expect(f.selected.mock.invocationCallOrder[0]!).toBeLessThan(f.decrypted.mock.invocationCallOrder[0]!);
      const inventory = f.selected.mock.calls[0]![0], revision = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
      expect(inventory.providerId).toMatch(/^[a-f0-9]{64}$/); expect(inventory.slots).toEqual([{ id: "credential", version: `r${revision}` }]);
      expect(f.selected.mock.calls[0]![1].threshold).toBe(2); expect(Object.isFrozen(f.selected.mock.calls[0]![1])).toBe(true);
      const evidence = JSON.stringify({ inventory, publicConfig: await f.service.listVisible(owner.tenantId) });
      expect(evidence.includes(key) || JSON.stringify(inventory).includes(owner.tenantId) || JSON.stringify(inventory).includes("provider.example")).toBe(false);
      await expect(model.apiKey()).rejects.toBeInstanceOf(ProviderPoolError); await expect(model.fetch!(url)).rejects.toBeInstanceOf(ProviderPoolError);
      const result = await f.dispatch(model, first); await result.response.text(); expect(f.selected).toHaveBeenCalledTimes(2); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("shares a rejected revision across users, but not tenants or provider ids, and never borrows a platform key", async () => {
    const f = await fixture({ fetch: async () => new Response("rejected", { status: 401 }), platform: [{ config: config(), apiKey: "private-platform-canary" }] });
    try {
      const model = await f.model(), first = await f.dispatch(model); await first.response.text();
      const same = await f.service.resolve({ ...owner, userId: "other-user" }, ref);
      await expect(same.createRequest!().apiKey!()).rejects.toMatchObject({ reason: "disabled" });
      for (const [tenantId, provider] of [["other-tenant", ref.provider], [owner.tenantId, "other-provider"]]) {
        await f.service.upsertTenantProvider(tenantId!, { ...config(), id: provider!, apiKey: key });
        const target = await f.service.resolve({ ...owner, tenantId: tenantId! }, { ...ref, provider: provider! });
        const result = await f.dispatch(target); await result.response.text();
      }
      expect(f.delegate).toHaveBeenCalledTimes(3);
      expect(f.delegate.mock.calls.every(call => new Headers(call[1]?.headers).get("authorization") === `Bearer ${key}`)).toBe(true);
    } finally { await f.close(); }
  });

  it.each(["update", "delete-recreate"] as const)("isolates an accepted %s source generation and rejects the old resolved handle", async change => {
    const f = await fixture({ fetch: async () => new Response("rejected", { status: 401 }) });
    try {
      const old = await f.model(), pinned = old.createRequest!(); await pinned.apiKey!();
      const first = await f.dispatch(old); await first.response.text();
      const before = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
      if (change === "delete-recreate") await f.service.deleteTenantProvider(owner.tenantId, ref.provider);
      await f.service.upsertTenantProvider(owner.tenantId, { ...config(), ...(change === "delete-recreate" ? { apiKey: key } : {}) });
      const after = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
      expect(after).toBeGreaterThan(before);
      await expect(pinned.apiKey!()).rejects.toMatchObject({ reason: "unavailable" });
      await expect(pinned.fetch(url, { headers: { authorization: `Bearer ${key}` } })).rejects.toMatchObject({ reason: "unavailable" });
      const fresh = await f.model(), result = await f.dispatch(fresh); await result.response.text(); expect(f.delegate).toHaveBeenCalledTimes(2);
      expect(f.selected.mock.calls.at(-1)![0].slots).toEqual([{ id: "credential", version: `r${after}` }]);
    } finally { await f.close(); }
  });

  it.for(["same-key", "config-only", "changed-key", "delete-recreate"] as const)(
    "rejects a %s source change held inside the fourth and final fleet check before ordinary BYOK dispatch", async (change, context) => {
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
      const f = await fixture({ authorizeFleet }), model = await f.model(), request = model.createRequest!();
      const pending = f.dispatch(model, request, context.signal);
      const settled = pending.then(value => ({ value }), error => ({ error }));
      try {
        await Promise.race([entered.promise, settled.then(() => { throw new Error("BYOK fixture did not reach final fleet check."); })]);
        expect(authorizeFleet).toHaveBeenCalledTimes(4); expect(f.delegate).not.toHaveBeenCalled();
        const before = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
        if (change === "delete-recreate") expect(await f.service.deleteTenantProvider(owner.tenantId, ref.provider)).toBe(true);
        await f.service.upsertTenantProvider(owner.tenantId, { ...config(),
          ...(change === "config-only" ? { quota: { rpm: 50 } }
            : { apiKey: change === "changed-key" ? "private-byok-replacement-canary" : key }) });
        const after = (await f.store.getProviderConfig(owner.tenantId, ref.provider))!.credentialSourceRevision;
        expect(after).toBeGreaterThan(before); resume.resolve();
        const result = await settled;
        expect(result).toHaveProperty("error");
        if (!("error" in result)) throw new Error("BYOK fixture unexpectedly dispatched.");
        expect(result.error).toBeInstanceOf(ProviderQuotaError); expect(result.error).toMatchObject({ reason: "unavailable" });
        expect(authorizeFleet).toHaveBeenCalledTimes(4); expect(f.delegate).not.toHaveBeenCalled();
        expect(request.wasDispatched()).toBe(false); expect(request.admissionFailure()).toBe("draining");
        expect(f.selected).toHaveBeenCalledOnce(); expect(f.acquired).toHaveBeenCalledOnce();
        const probe = await f.quota.enter({ ...owner, provider: { scope: "tenant", id: ref.provider },
          tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, context.signal);
        await probe.release();
      } finally { resume.resolve(); await settled; await f.close(); }
    });

  it.each(keylessHeaders)("supports a real keyless source and binds all configured headers (%#)", async headers => {
    const f = await fixture({ platform: [{ config: config(), apiKey: "private-platform-canary" }] });
    try {
      await f.service.deleteTenantProvider(owner.tenantId, ref.provider);
      await f.service.upsertTenantProvider(owner.tenantId, { ...config(), headers });
      const model = await f.model(), request = model.createRequest!(); expect(await request.apiKey!()).toBeUndefined();
      const result = await f.dispatch(model, request); await result.response.text();
      expect(f.decrypted).not.toHaveBeenCalled(); expect(f.delegate).toHaveBeenCalledOnce();
      const actual = new Headers(f.delegate.mock.calls[0]![1]?.headers);
      for (const [name, value] of new Headers(headers)) expect(actual.get(name) === value).toBe(true);
      if (!new Headers(headers).has("authorization")) expect(actual.has("authorization")).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["authorization", "x-api-key"])("rejects substituted %s before vendor dispatch and settles the permit", async changed => {
    const f = await fixture();
    try {
      await f.service.upsertTenantProvider(owner.tenantId, { ...config(), headers: { "X-Api-Key": "private-header-canary" } });
      const model = await f.model(), request = model.createRequest!(); await request.apiKey!();
      const headers = new Headers({ authorization: `Bearer ${key}`, "x-api-key": "private-header-canary" }); headers.set(changed, "private-substitute");
      await expect(request.fetch(url, { headers })).rejects.toBeInstanceOf(ProviderPoolError);
      expect(request.wasDispatched()).toBe(false); expect(f.delegate).not.toHaveBeenCalled();
      const next = await f.dispatch(model); await next.response.text(); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("uses distinct platform and tenant identity domains even when a raw platform id equals the tenant digest", async () => {
    const collision = createHash("sha256").update("provider-breaker-tenant-v1\0").update(JSON.stringify([owner.tenantId, ref.provider])).digest("hex");
    const f = await fixture({ fetch: async () => new Response("body", { status: 401 }),
      platform: [{ config: { ...config(), id: collision }, keyPool: [{ id: "credential", version: "r1", apiKey: "private-platform-canary" }] }] });
    try {
      const first = await f.dispatch(await f.model()); await first.response.text();
      const platform = await f.service.resolve(owner, { ...ref, provider: collision });
      const second = await f.dispatch(platform); await second.response.text();
      expect(f.delegate).toHaveBeenCalledTimes(2); const inventories = f.selected.mock.calls.map(call => call[0]);
      expect(inventories[0]!.providerId).toBe(collision); expect(inventories[1]!.providerId).not.toBe(collision);
      expect(inventories[0]!.slots).toEqual(inventories[1]!.slots);
    } finally { await f.close(); }
  });

  it("preserves service-owned W3C privacy while binding the remaining configured credential headers", async () => {
    const f = await fixture(), configured = "00-11111111111111111111111111111111-2222222222222222-01";
    try {
      await f.service.upsertTenantProvider(owner.tenantId, { ...config(), headers: { traceparent: configured, tracestate: "private-state",
        baggage: "private-baggage", "X-Api-Key": "private-header-canary" } });
      const model = await f.model(), result = await f.dispatch(model); await result.response.text();
      const headers = new Headers(f.delegate.mock.calls[0]![1]?.headers);
      expect(headers.has("tracestate") || headers.has("baggage") || headers.get("traceparent") === configured).toBe(false);
      expect(headers.get("traceparent")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/);
      expect(headers.get("x-api-key") === "private-header-canary").toBe(true);
      const request = model.createRequest!(); await request.apiKey!();
      await expect(request.fetch(url, { headers: { authorization: `Bearer ${key}`, "x-api-key": "private-substitute" } })).rejects.toMatchObject({ reason: "unavailable" });
      expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("admits quota then the fixed credential before family budget, and holds both until real cancellation acknowledgement", async () => {
    const entered = barrier(), ack = barrier(), f = await fixture({ fetch: async () => new Response(new ReadableStream({ async cancel() { entered.resolve(); await ack.promise; } })) });
    const events: string[] = [], enter = f.quota.enter.bind(f.quota), acquire = f.acquireOriginal;
    vi.spyOn(f.quota, "enter").mockImplementation(async (...args) => { events.push("quota"); return enter(...args); });
    f.acquired.mockImplementation(async (...args) => { events.push("breaker"); return acquire(...args); });
    let cancellation: Promise<void> | undefined;
    try {
      const model = await f.model(), request = model.createRequest!(async () => { events.push("budget"); });
      const first = await f.dispatch(model, request); expect(events).toEqual(["quota", "breaker", "budget"]);
      cancellation = first.response.body!.cancel(); await entered.promise;
      await expect(f.dispatch(model)).rejects.toMatchObject({ reason: "concurrency" });
      ack.resolve(); await cancellation; const next = await f.dispatch(model); cancellation = next.response.body!.cancel(); await cancellation;
    } finally { ack.resolve(); await cancellation; await f.close(); }
  });

  it("rechecks T1 before returning a previously selected key", async () => {
    const f = await fixture();
    try {
      const request = (await f.model()).createRequest!(); await request.apiKey!(); await f.store.setTenantAuth(owner.tenantId, DEFAULT_AUTH_POLICY);
      await f.store.requestTenantErasure({ requestId: newErasureRequestId(), tenantId: owner.tenantId, requestedByKeyId: "fixture-admin",
        idempotencyKey: "byok-delete", requestHash: tenantErasureRequestHash(owner.tenantId), atMs: Date.now() });
      await expect(request.apiKey!()).rejects.toMatchObject({ name: "SubjectDeletingError" });
      expect(request.admissionFailure()).toBe("subject_deleting"); expect(f.selected).toHaveBeenCalledOnce(); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("preserves SDK configured credential headers with the same real Pi request", async () => {
    const f = await fixture({ fetch: async () => sse() });
    await f.service.upsertTenantProvider(owner.tenantId, { ...config(), headers: { Authorization: "Custom private-header-canary", "X-Api-Key": "private-header-canary" } });
    const target = startPi(f, await f.model());
    try {
      const done = await target.run.done; expect(done.error).toBeUndefined(); expect(f.delegate).toHaveBeenCalledOnce(); expect(target.messages).toHaveLength(1);
      const headers = new Headers(f.delegate.mock.calls[0]![1]?.headers);
      expect(headers.get("authorization") === "Custom private-header-canary" && headers.get("x-api-key") === "private-header-canary").toBe(true);
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });

  it.each(["health", "vendor"] as const)("retains actual dispatch and unknown cost with correct %s failure provenance", async failure => {
    const f = await fixture({ fetch: failure === "vendor" ? async () => { throw new Error("private-upstream-failure"); } : async () => sse() });
    const acquire = f.acquireOriginal;
    f.acquired.mockImplementation(async (...args) => {
      const lease = await acquire(...args); return { ...lease, release: async outcome => { await lease.release(outcome); throw new Error("private-health-failure"); } };
    });
    const target = startPi(f, await f.model());
    try {
      const done = await target.run.done; expect(done.error).toBe("provider_error"); expect(f.delegate).toHaveBeenCalledOnce();
      expect(target.requests[0]!.wasDispatched()).toBe(true); expect(target.messages).toHaveLength(1);
      expect(Object.hasOwn(target.messages[0]!.usage, "costCNY")).toBe(false);
      expect(target.requests[0]!.hasLocalFailure?.()).toBe(failure === "health");
      expect(getPiProviderStepFailure(done)).toEqual(failure === "vendor" ? { failureKind: "provider_step_error", stepIndex: 1 } : undefined);
      expect(JSON.stringify({ done, messages: target.messages }).includes("private-")).toBe(false);
      await expect(f.model()).rejects.toMatchObject({ reason: "unavailable" });
    } finally { target.run.interrupt(); await target.run.done; await f.close(); }
  });
});
