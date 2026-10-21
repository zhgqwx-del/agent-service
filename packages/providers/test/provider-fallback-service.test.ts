import { describe, expect, it, vi } from "vitest";
import { createModels, InMemoryCredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { type ProviderConfigInput, type Principal } from "@agent-service/protocol";
import { MemoryProviderPoolCoordinator, MemoryProviderQuotaCoordinator, MemorySessionStore, ProviderPoolError, ProviderQuotaError, SubjectDeletingError } from "@agent-service/store";
import { PiEngine, getPiProviderStepFailure } from "../../core/src/engine/pi.js";
import type { AssistantStepResult, EngineSink, ProviderModelRequest, ResolvedModel } from "../../core/src/engine/types.js";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const owner = { tenantId: "fallback-tenant", userId: "fallback-user" }, ref = { provider: "source", model: "model" };
const target = (provider: string) => ({ provider, model: "model" });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function config(id: string): ProviderConfigInput {
  return { id, api: "openai-completions", baseUrl: `https://${id}.example/v1`, headers: {}, quota: {}, fallback: [],
    models: [{ id: "model", contextWindow: 1000, maxOutputTokens: 100, input: ["text"], reasoning: false }] };
}
async function fixture(options: { byok?: boolean; paid?: boolean; targets?: { provider: string; model: string }[];
  recursive?: boolean; tenantTargets?: string[]; sourceConfig?: Partial<ProviderConfigInput>; models?: MutableModels } = {}) {
  const store = new MemorySessionStore(), cipher = new LocalAesGcmCipher("93".repeat(32));
  const pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "fallback", namespaceId: "fixture" });
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "fallback", namespaceId: "fixture" });
  const statuses = new Map<string, number>(), errors = new Map<string, Error>(), responses = new Set<Response>();
  let fleet: (signal: AbortSignal) => Promise<void> = async signal => { signal.throwIfAborted(); };
  const delegate = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const provider = new URL(input instanceof Request ? input.url : String(input)).hostname.split(".")[0]!;
    if (errors.has(provider)) throw errors.get(provider);
    return new Response("body", { status: statuses.get(provider) ?? 200 });
  });
  const source: ProviderConfigInput = { ...config("source"), fallbackRules: [{ model: "model", targets: options.targets ?? [target("target-a")] }],
    ...(options.paid === undefined ? {} : { allowPlatformPaidFallback: options.paid }), ...options.sourceConfig };
  const configs = [source, ...["target-a", "target-b", "target-c", "extra"].map(id => ({ ...config(id),
    ...(options.recursive && id !== "extra" ? { fallbackRules: [{ model: "model", targets: [target("extra")] }] } : {}) }))];
  const service = new ProviderService({ store, cipher, models: options.models, assertBaseUrl: async () => {}, fetch: delegate, persistedProviderFailureCaptureActive: true,
    platform: configs.map(value => ({ config: value, keyPool: [{ id: "credential", version: "v1", apiKey: `private-${value.id}-key` }] })),
    quota: { coordinator: quota, tenant: { concurrency: 1 }, user: {}, authorizeFleet: signal => fleet(signal) },
    keyPool: { coordinator: pool, policy: { threshold: 1, cooldownMs: 3_600_000 } }, byokBreaker: { coordinator: pool, policy: { threshold: 1, cooldownMs: 3_600_000 } } });
  if (options.byok) await service.upsertTenantProvider(owner.tenantId, { ...source, apiKey: "private-source-key" });
  for (const id of options.tenantTargets ?? []) await service.upsertTenantProvider(owner.tenantId, { ...config(id), apiKey: `private-${id}-tenant-key` });
  const resolve = (provider = "source", principal: Principal = owner) => service.resolve(principal, target(provider));
  const dispatch = async (model: ResolvedModel, request = model.createRequest!(), signal?: AbortSignal) => {
    const key = await request.apiKey!(signal), headers = new Headers(model.headers);
    if (!headers.has("authorization") && key !== undefined) headers.set("authorization", `Bearer ${key}`);
    const provider = model.canonicalRef!.provider;
    const response = await request.fetch(`https://${provider}.example/v1/chat/completions`, { headers, signal }); responses.add(response); return response;
  };
  const disable = async (provider = "source") => {
    statuses.set(provider, 401); const response = await dispatch(await resolve(provider)); await response.text(); statuses.delete(provider);
  };
  const denied = async (provider = "source", budget?: () => Promise<void>, signal?: AbortSignal) => {
    const model = await resolve(provider), request = model.createRequest!(budget);
    await expect(request.apiKey!(signal)).rejects.toMatchObject({ reason: "disabled" }); return { model, request };
  };
  return { store, cipher, pool, quota, service, source, delegate, statuses, errors, resolve, dispatch, disable, denied,
    fleet: (next: typeof fleet) => { fleet = next; }, close: async () => {
      const cancelled = await Promise.allSettled([...responses].map(response => response.body && !response.body.locked ? response.body.cancel() : Promise.resolve()));
      const closed = await Promise.allSettled([pool.close(), quota.close(), store.close()]);
      if ([...cancelled, ...closed].some(result => result.status === "rejected")) throw new Error("Fallback fixture did not settle.");
    } };
}

describe("Service private, explicit pre-dispatch fallback authority", () => {
  it("preserves a real subject-deleting rejection during candidate authorization without dispatching a target", async () => {
    const f = await fixture();
    try {
      await f.disable(); const { request } = await f.denied();
      vi.spyOn(f.store, "getTenantRuntimeState").mockRejectedValue(new SubjectDeletingError(owner.tenantId));
      await expect(f.service.resolveFallback(owner, request)).rejects.toBeInstanceOf(SubjectDeletingError);
      expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  it("advances only a real key-selection denial, with an immutable canonical target and no source family admission", async () => {
    const f = await fixture(), budget = vi.fn(async () => {});
    try {
      await f.disable(); const original = await f.denied("source", budget);
      expect(original.model.fallbackEnabled).toBe(true); expect(budget).not.toHaveBeenCalled();
      const next = await f.service.resolveFallback(owner, original.request); expect(next?.canonicalRef).toEqual(target("target-a"));
      expect(Object.isFrozen(next!.canonicalRef)).toBe(true); expect(next!.maxOutputTokens).toBe(100);
      expect(f.delegate).toHaveBeenCalledOnce(); expect(await f.service.resolveFallback(owner, original.request)).toBeUndefined();
      await expect(next!.apiKey()).rejects.toBeInstanceOf(ProviderPoolError); await expect(next!.fetch!("https://target-a.example/v1")).rejects.toBeInstanceOf(ProviderPoolError);
      const response = await f.dispatch(next!, next!.createRequest!(budget)); await response.text();
      expect(budget).toHaveBeenCalledOnce(); expect(f.delegate).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("rejects cloned, fake, foreign-service and cross-principal requests without consuming the genuine capability", async () => {
    const f = await fixture(), foreign = await fixture();
    try {
      await f.disable(); const { request } = await f.denied();
      const forged = Object.freeze({ ...request, wasDispatched() { throw new Error("Public state must not be consulted."); } });
      for (const candidate of [forged, Object.freeze({ ...request })]) expect(await f.service.resolveFallback(owner, candidate)).toBeUndefined();
      expect(await foreign.service.resolveFallback(owner, request)).toBeUndefined();
      expect(await f.service.resolveFallback({ ...owner, tenantId: "other-tenant" }, request)).toBeUndefined();
      expect(await f.service.resolveFallback({ ...owner, userId: "other-user" }, request)).toBeUndefined();
      expect((await f.service.resolveFallback(owner, request))?.canonicalRef).toEqual(target("target-a"));
    } finally { await Promise.all([f.close(), foreign.close()]); }
  });

  it("allows a real open breaker but not an unavailable coordinator, unknown DB error or quota rejection", async () => {
    const f = await fixture();
    try {
      f.statuses.set("source", 503); const response = await f.dispatch(await f.resolve()); await response.text();
      const open = (await f.resolve()).createRequest!(); await expect(open.apiKey!()).rejects.toMatchObject({ reason: "open" });
      expect((await f.service.resolveFallback(owner, open))?.canonicalRef).toEqual(target("target-a"));
      const select = vi.spyOn(f.pool, "select").mockRejectedValue(new ProviderPoolError("unavailable"));
      const unavailable = (await f.resolve()).createRequest!(); await expect(unavailable.apiKey!()).rejects.toMatchObject({ reason: "unavailable" });
      expect(await f.service.resolveFallback(owner, unavailable)).toBeUndefined(); select.mockRestore();
      const local = (await f.resolve()).createRequest!(); const read = vi.spyOn(f.store, "getTenantRuntimeState").mockRejectedValue(new Error("private-db-error"));
      await expect(local.apiKey!()).rejects.toBeInstanceOf(Error); expect(await f.service.resolveFallback(owner, local)).toBeUndefined(); read.mockRestore();
      const quota = (await f.resolve("target-a")).createRequest!(); await quota.apiKey!();
      const enter = vi.spyOn(f.quota, "enter").mockRejectedValue(new ProviderQuotaError("rpm"));
      await expect(quota.fetch("https://target-a.example/v1")).rejects.toMatchObject({ reason: "rpm" });
      expect(await f.service.resolveFallback(owner, quota)).toBeUndefined(); enter.mockRestore(); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each(["quota", "fleet"] as const)("does not treat a source %s failure as key-selection fallback authority", async stage => {
    const f = await fixture();
    try {
      const model = await f.resolve(), request = model.createRequest!(); expect(model.fallbackEnabled).toBe(true); await request.apiKey!();
      if (stage === "quota") vi.spyOn(f.quota, "enter").mockRejectedValue(new ProviderQuotaError("rpm"));
      else f.fleet(async () => { throw new ProviderQuotaError("unavailable"); });
      await expect(request.fetch("https://source.example/v1")).rejects.toBeInstanceOf(ProviderQuotaError);
      expect(await f.service.resolveFallback(owner, request)).toBeUndefined(); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each([new Error("private-db-failure"), new ProviderPoolError("open")])("requires selection-phase provenance rather than a DB error's class or public draining code (%#)", async error => {
    const f = await fixture();
    try {
      const request = (await f.resolve()).createRequest!(); vi.spyOn(f.store, "getTenantRuntimeState").mockRejectedValue(error);
      await expect(request.apiKey!()).rejects.toBe(error); expect(await f.service.resolveFallback(owner, request)).toBeUndefined(); expect(f.delegate).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["four-targets", "duplicate-target"])("rejects a %s declaration rather than expanding the fixed candidate bound", async invalid => {
    const store = new MemorySessionStore(), pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "fallback-invalid", namespaceId: "fixture" });
    try {
      const targets = invalid === "four-targets" ? [target("a"), target("b"), target("c"), target("d")] : [target("a"), target("a")];
      let error: unknown;
      try { new ProviderService({ store, cipher: new LocalAesGcmCipher("93".repeat(32)), platform: [{ config: { ...config("source"),
        fallbackRules: [{ model: "model", targets }] }, keyPool: [{ id: "credential", version: "v1", apiKey: "private-key" }] }],
      keyPool: { coordinator: pool, policy: {} } }); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ name: "ZodError", issues: [{ code: invalid === "four-targets" ? "too_big" : "custom", path: ["fallbackRules", 0, "targets"] }] });
    } finally { await pool.close(); await store.close(); }
  });

  it.each(["key-success", "fetch-entered", "cancelled", "dispatched"] as const)("never authorizes fallback after %s, even for zero bytes or unknown vendor cost", async state => {
    const f = await fixture(), signal = new AbortController(), budget = vi.fn(async () => {});
    try {
      let request: ProviderModelRequest;
      if (state === "key-success") { request = (await f.resolve()).createRequest!(budget); await request.apiKey!(); }
      else if (state === "dispatched") {
        const model = await f.resolve(); request = model.createRequest!(budget); f.errors.set("source", new Error("private-transport-failure"));
        await expect(f.dispatch(model, request)).rejects.toBeInstanceOf(Error); expect(request.wasDispatched()).toBe(true);
      } else {
        await f.disable(); request = (await f.denied("source", budget, signal.signal)).request;
        if (state === "fetch-entered") await expect(request.fetch("https://source.example/v1")).rejects.toBeInstanceOf(Error);
        else signal.abort();
      }
      expect(await f.service.resolveFallback(owner, request)).toBeUndefined();
      expect(budget.mock.calls.length).toBe(state === "dispatched" ? 1 : 0);
      expect(f.delegate.mock.calls.length).toBe(state === "key-success" ? 0 : 1);
    } finally { await f.close(); }
  });

  it("uses only the original three targets, never their own rules, with no vendor or budget replay during traversal", async () => {
    const f = await fixture({ targets: [target("target-a"), target("target-b"), target("target-c")], recursive: true }), budget = vi.fn(async () => {});
    try {
      for (const provider of ["source", "target-a", "target-b", "target-c"]) await f.disable(provider);
      let request = (await f.denied("source", budget)).request;
      for (const provider of ["target-a", "target-b", "target-c"]) {
        const next = await f.service.resolveFallback(owner, request); expect(next?.canonicalRef).toEqual(target(provider));
        request = next!.createRequest!(budget); await expect(request.apiKey!()).rejects.toMatchObject({ reason: "disabled" });
      }
      expect(await f.service.resolveFallback(owner, request)).toBeUndefined(); expect(budget).not.toHaveBeenCalled(); expect(f.delegate).toHaveBeenCalledTimes(4);
    } finally { await f.close(); }
  });

  it.each([false, true])("requires the original BYOK source's separate paid-platform opt-in (%s)", async paid => {
    const f = await fixture({ byok: true, paid });
    try {
      await f.disable(); const { request } = await f.denied();
      if (!paid) await expect(f.service.resolveFallback(owner, request)).rejects.toMatchObject({ code: "draining", message: "Provider admission is unavailable." });
      else { const next = await f.service.resolveFallback(owner, request); const response = await f.dispatch(next!); await response.text(); expect(f.delegate).toHaveBeenCalledTimes(2); }
      if (!paid) expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it("permits same-tenant BYOK targets without paid opt-in but refuses tenant credentials on a platform-source chain", async () => {
    const own = await fixture({ byok: true, tenantTargets: ["target-a"] }), platform = await fixture({ tenantTargets: ["target-a"] });
    try {
      await own.disable(); const first = await own.denied(); const next = await own.service.resolveFallback(owner, first.request);
      const response = await own.dispatch(next!); await response.text(); expect(own.delegate).toHaveBeenCalledTimes(2);
      await platform.disable(); const second = await platform.denied();
      await expect(platform.service.resolveFallback(owner, second.request)).rejects.toMatchObject({ code: "draining", message: "Provider admission is unavailable." });
      expect(platform.delegate).toHaveBeenCalledOnce();
    } finally { await Promise.all([own.close(), platform.close()]); }
  });

  it.each(["missing-target", "missing-model", "reasoning"] as const)("fails a configured %s closed without leaking target details or guessing another mapping", async failure => {
    const f = await fixture({ targets: failure === "missing-target" ? [target("unconfigured-target")] : failure === "missing-model" ? [{ provider: "target-a", model: "unconfigured-model" }] : undefined,
      ...(failure === "reasoning" ? { sourceConfig: { models: [{ ...config("source").models[0]!, reasoning: true }] } } : {}) });
    try {
      await f.disable(); const model = await f.service.resolve(owner, { ...ref, ...(failure === "reasoning" ? { reasoning: "low" as const } : {}) });
      const request = model.createRequest!(); await expect(request.apiKey!()).rejects.toMatchObject({ reason: "disabled" });
      await expect(f.service.resolveFallback(owner, request)).rejects.toMatchObject({ code: "draining", message: "Provider admission is unavailable.", details: undefined });
      expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each(["self", "missing-source-model"] as const)("rejects the semantically invalid %s rule instead of enabling it", async invalid => {
    const f = await fixture({ sourceConfig: { fallbackRules: [{ model: invalid === "self" ? "model" : "absent-model", targets: [target("source")] }] } });
    try { await expect(f.resolve()).rejects.toMatchObject({ code: "draining", message: "Provider admission is unavailable." }); expect(f.delegate).not.toHaveBeenCalled(); }
    finally { await f.close(); }
  });

  it("does not execute the old provider-only fallback list without an explicit model mapping", async () => {
    const f = await fixture({ sourceConfig: { fallbackRules: undefined, fallback: ["target-a"] } });
    try { await f.disable(); const { model, request } = await f.denied(); expect(model.fallbackEnabled).not.toBe(true); expect(await f.service.resolveFallback(owner, request)).toBeUndefined(); }
    finally { await f.close(); }
  });

  it.each(["budget", "final-fleet", "target-final-fleet"] as const)("rechecks original and target authority after an awaited %s boundary before vendor dispatch", async boundary => {
    const f = await fixture({ byok: true, paid: true }), entered = barrier(), resume = barrier(); let budgetDone = false;
    let pending: Promise<Response> | undefined, rejected: Promise<void> | undefined;
    try {
      await f.disable(); const { request } = await f.denied(); const next = await f.service.resolveFallback(owner, request);
      const attempt = next!.createRequest!(async () => { budgetDone = true; if (boundary === "budget") { entered.resolve(); await resume.promise; } });
      if (boundary !== "budget") f.fleet(async signal => { signal.throwIfAborted(); if (budgetDone) { entered.resolve(); await resume.promise; } });
      pending = f.dispatch(next!, attempt); rejected = expect(pending).rejects.toBeInstanceOf(Error); await entered.promise;
      const id = boundary === "target-final-fleet" ? "target-a" : "source";
      await f.service.upsertTenantProvider(owner.tenantId, { ...(id === "source" ? f.source : config(id)), apiKey: "private-revoked-key" });
      resume.resolve(); await rejected; expect(f.delegate).toHaveBeenCalledOnce(); expect(attempt.wasDispatched()).toBe(false);
      expect(await f.service.resolveFallback(owner, attempt)).toBeUndefined();
      const probe = await f.quota.enter({ ...owner, provider: { scope: "platform", id: "target-a" }, tenant: { concurrency: 1 }, user: {}, providerLimit: {} }, new AbortController().signal);
      await probe.release();
    } finally { resume.resolve(); await rejected; await f.close(); }
  });

  it("rechecks original source revocation after target decryption and preserves both old handle and failed grant fences", async () => {
    const f = await fixture({ byok: true, tenantTargets: ["target-a"] }), entered = barrier(), resume = barrier();
    let rejected: Promise<void> | undefined;
    try {
      await f.disable(); const { request } = await f.denied(); const next = await f.service.resolveFallback(owner, request);
      const decrypt = f.cipher.decrypt.bind(f.cipher); vi.spyOn(f.cipher, "decrypt").mockImplementation(async (...args) => { entered.resolve(); await resume.promise; return decrypt(...args); });
      const key = next!.createRequest!().apiKey!(); rejected = expect(key).rejects.toBeInstanceOf(Error); await entered.promise;
      await f.service.deleteTenantProvider(owner.tenantId, "source"); await f.service.upsertTenantProvider(owner.tenantId, { ...f.source, apiKey: "private-new-source-key" });
      resume.resolve(); await rejected; expect(f.delegate).toHaveBeenCalledOnce();
    } finally { resume.resolve(); await rejected; await f.close(); }
  });

  it.each(["cancel", "late-source-fetch"] as const)("revokes an already issued target when its original grant has %s", async invalidation => {
    const f = await fixture(), caller = new AbortController();
    try {
      await f.disable(); const { request } = await f.denied("source", undefined, caller.signal); const next = await f.service.resolveFallback(owner, request);
      if (invalidation === "cancel") caller.abort(); else await expect(request.fetch("https://source.example/v1")).rejects.toBeInstanceOf(Error);
      await expect(next!.createRequest!().apiKey!(new AbortController().signal)).rejects.toBeInstanceOf(Error); expect(f.delegate).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });

  it.each([true, false])("runs real Pi with an undefined request key only when the adapter supports the explicit auth headers (%s)", async headerOnly => {
    const credentials = new InMemoryCredentialStore(), env = vi.fn(async () => "private-ambient-key");
    const models = createModels({ credentials, authContext: { env, fileExists: async () => false } });
    const f = await fixture({ byok: true, tenantTargets: ["target-a"], models });
    const messages: AssistantStepResult[] = [], requests: ProviderModelRequest[] = []; let headerMatched = false;
    let run: ReturnType<PiEngine["start"]> | undefined;
    try {
      await f.service.deleteTenantProvider(owner.tenantId, "target-a");
      await f.service.upsertTenantProvider(owner.tenantId, { ...config("target-a"), headers: headerOnly ? { Authorization: "Custom private-header-only" } : {} });
      await f.disable(); const { request } = await f.denied(); const next = await f.service.resolveFallback(owner, request);
      await credentials.modify(next!.provider, async () => ({ type: "api_key", key: "private-unrelated-sdk-store-key" }));
      const auth = await models.getAuth(next!.provider); expect(auth?.auth.apiKey === undefined).toBe(true); expect(env).not.toHaveBeenCalled();
      f.delegate.mockImplementation(async (_input, init) => {
        headerMatched = new Headers(init?.headers).get("authorization") === "Custom private-header-only";
        return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "model",
          choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      });
      const sink: EngineSink = { onStepStart() {}, onTextDelta() {}, onReasoningDelta() {}, onToolArgsDelta() {},
        async onAssistantMessage(message) { messages.push(message); }, async beforeToolCall() { return { allow: true }; }, onToolExecutionStart() {},
        onToolProgress() {}, async afterToolCall(result) { return result; }, async onToolResult() {}, async onStepEnd() { return "end"; } };
      const model: ResolvedModel = { ...next!, createRequest: before => { const request = next!.createRequest!(before); requests.push(request); return request; } };
      run = new PiEngine(models).start({ model, systemPrompt: "fixture", history: [], tools: [], input: [{ type: "text", text: "fixture" }],
        signal: new AbortController().signal, toolContext: { principal: owner, sessionId: "header-session", turnId: "header-turn" } }, sink);
      const done = await run.done; expect(await requests[0]!.apiKey!() === undefined).toBe(true); expect(env).not.toHaveBeenCalled();
      if (headerOnly) {
        expect(done.error).toBeUndefined(); expect(messages).toHaveLength(1); expect(requests[0]!.wasDispatched()).toBe(true);
        expect(f.delegate).toHaveBeenCalledTimes(2); expect(headerMatched).toBe(true);
      } else {
        // The pinned openai-completions adapter requires a key or an explicit Authorization
        // header. Do not invent a key to advertise an unsupported unauthenticated endpoint.
        expect(done.error).toBe("provider_error"); expect(messages).toEqual([]); expect(requests[0]!.wasDispatched()).toBe(false);
        expect(getPiProviderStepFailure(done)).toBeUndefined(); expect(f.delegate).toHaveBeenCalledOnce();
      }
    } finally { run?.interrupt(); await run?.done; await f.close(); }
  });
});
