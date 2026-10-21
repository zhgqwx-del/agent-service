import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, type ProviderConfigInput } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemoryProviderPoolCoordinator, MemoryProviderQuotaCoordinator, MemorySessionStore } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService, type PlatformProvider } from "../../providers/src/index.js";
import { PiEngine, SessionHost, StaticToolRegistry, newId, type AgentEngine, type EngineModelStep,
  type EngineSink, type EngineTurnParams, type ProviderResolver } from "../src/index.js";
import { ConfiguredLifecycleHookService } from "../src/hooks/lifecycle.js";

const owner = { tenantId: "fallback-host-tenant", userId: "fallback-host-user" };
const source = { provider: "fallback-source", model: "source-model" };
const target = { provider: "fallback-target", model: "target-model" };
const privateKey = "test-only-private-fallback-host-key";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(close => close()));
  vi.restoreAllMocks();
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
});

function config(ref: typeof source, extra: Partial<ProviderConfigInput> = {}): ProviderConfigInput {
  return { id: ref.provider, api: "openai-completions", baseUrl: `https://${ref.provider}.example/v1`,
    apiKey: privateKey, quota: {}, headers: {}, fallback: [], compat: { maxTokensField: "max_tokens" }, models: [{ id: ref.model,
      contextWindow: 32_000, maxOutputTokens: 37, input: ["text"], reasoning: false,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], ...extra };
}
function completion() {
  return new Response(`data: ${JSON.stringify({ id: "fallback-host", object: "chat.completion.chunk", created: 1,
    model: target.model, choices: [{ index: 0, delta: { role: "assistant", content: "fallback answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
}

async function fixture(options: { platformTarget?: boolean; paid?: boolean; failure?: boolean; contextWindow?: number;
  script?: (params: EngineTurnParams, sink: EngineSink) => Promise<void>;
  lifecycle?: boolean; rewriteTarget?: boolean; resolver?: (service: ProviderService) => ProviderResolver } = {}) {
  const store = new MemorySessionStore(), bus = new MemoryEventBus(), lease = new MemoryLeaseStore();
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "fallback-host", namespaceId: "fixture" });
  const pool = new MemoryProviderPoolCoordinator({ store: "memory", prefix: "fallback-host", namespaceId: "fixture" });
  let seed = true;
  const delegate = vi.fn<typeof fetch>(async () => {
    if (seed) return new Response("fixture credential rejection", { status: 401 });
    if (options.failure) throw new Error("private-fallback-upstream-canary");
    return completion();
  });
  let host: SessionHost | undefined;
  const lifecycle = options.lifecycle ? new ConfiguredLifecycleHookService({ packages: [{
    id: "fallback-audit", package: "audit", subjects: [owner], phases: ["Stop"],
  }] }) : undefined;
  cleanups.push(async () => {
    await host?.drain(2_000);
    const results = await Promise.allSettled([lifecycle?.close(), pool.close(), quota.close(), lease.close(), bus.close(), store.close()]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  });
  const targetConfig = config(target);
  if (options.contextWindow !== undefined) targetConfig.models[0]!.contextWindow = options.contextWindow;
  const { apiKey, ...platformConfig } = targetConfig;
  const platform: PlatformProvider[] = options.platformTarget ? [{ config: platformConfig, apiKey: "test-only-platform-target-key" }] : [];
  const service = new ProviderService({ store, cipher: new LocalAesGcmCipher("61".repeat(32)), platform,
    assertBaseUrl: async () => {}, fetch: delegate, persistedProviderFailureCaptureActive: true,
    quota: { coordinator: quota, tenant: {}, user: {} }, byokBreaker: { coordinator: pool, policy: { threshold: 1 } } });
  await service.upsertTenantProvider(owner.tenantId, config(source, {
    fallbackRules: [{ model: source.model, targets: [target] }],
    ...(options.paid === undefined ? {} : { allowPlatformPaidFallback: options.paid }),
  }));
  if (!options.platformTarget) await service.upsertTenantProvider(owner.tenantId, targetConfig);
  const original = await service.resolve(owner, source), request = original.createRequest!();
  const key = await request.apiKey!();
  const response = await request.fetch(`https://${source.provider}.example/v1/chat/completions`, {
    headers: { authorization: `Bearer ${key}` }, signal: new AbortController().signal,
  });
  expect(response.status).toBe(401); await response.text();
  seed = false; delegate.mockClear();
  const resolver = options.resolver?.(service) ?? service;
  const fallback = vi.spyOn(resolver, "resolveFallback");
  const actualBeforeModel = lifecycle?.beforeModelStep.bind(lifecycle);
  const beforeModel = lifecycle ? vi.spyOn(lifecycle, "beforeModelStep") : undefined;
  if (beforeModel && options.rewriteTarget) {
    beforeModel.mockImplementation(async (context, input, signal) => ({ ...await actualBeforeModel!(context, input, signal),
      ...(input.modelRef.provider === target.provider ? { modelRef: source } : {}) }));
  }
  const engine: AgentEngine = options.script ? { name: "host-fallback-boundary-fixture", start(params, sink) {
    return { steer() {}, interrupt() {}, done: options.script!(params, sink).then(() => ({ steps: 1, aborted: false })) };
  } } : new PiEngine(service.models);
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "fallback fixture",
    instructions: "system fallback fixture", model: source, tools: [], skills: [], mcpServers: [], limits: {},
    approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  host = new SessionHost({ store, bus, lease, engine, providers: resolver, tools: new StaticToolRegistry(), lifecycleHooks: lifecycle,
    config: { runnerId: "fallback-host", runnerAddr: "127.0.0.1:1", leaseTtlMs: 5_000, leaseHoldMs: 1 },
    logger: { info() {}, warn() {}, error() {} } });
  const session = await host.createSession(owner, { agentId: agent.id, metadata: {} });
  return { host, store, service, session, delegate, fallback, agent, beforeModel };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function run(f: Fixture) {
  const begun = await f.host.beginTurn(owner, f.session.id, { input: [{ type: "text", text: "user fallback fixture" }], metadata: {}, stream: true });
  begun.run(); await vi.waitFor(() => expect(f.host.activeTurn(f.session.id)).toBeUndefined());
  const turn = await f.store.getTurn(f.session.id, begun.turn.id);
  const events = await f.store.readEvents(f.session.id, 0, 1000);
  expect(JSON.stringify([turn, events, f.store.usageLedger])).not.toContain(privateKey);
  expect(JSON.stringify([turn, events, f.store.usageLedger])).not.toContain("private-fallback-upstream-canary");
  return { turn, events };
}

// Actual Host/Memory/ProviderService/Pi adapter. No native HTTP/Redis or paid vendor claim.
describe("Host explicit pre-dispatch fallback", () => {
  it("dispatches only the actual target and preserves the session/agent default and one usage entry", async () => {
    const f = await fixture(); const result = await run(f);
    expect(result.turn?.status).toBe("completed"); expect(f.fallback).toHaveBeenCalledOnce(); expect(f.delegate).toHaveBeenCalledOnce();
    const [url, init] = f.delegate.mock.calls[0]!;
    expect(String(url)).toContain(target.provider); expect(JSON.parse(String(init!.body))).toMatchObject({ model: target.model, max_tokens: 37 });
    expect(f.store.usageLedger).toHaveLength(1);
    expect(f.store.usageLedger[0]).toMatchObject({ step: 1, model: target.model, usage: { totalTokens: 3, costCNY: 0 } });
    expect(result.turn?.model?.model).toBe(target.model);
    expect((await f.store.getAgent(owner.tenantId, f.agent.id))?.model).toEqual(source);
    expect(await f.store.getSession(owner.tenantId, f.session.id)).toMatchObject({ agentId: f.agent.id, agentVersion: f.agent.version });
  });

  it.each([undefined, false])("does not spend platform money without separate opt-in (%s)", async paid => {
    const f = await fixture({ platformTarget: true, paid }); const result = await run(f);
    expect(result.turn?.status).toBe("failed"); expect(f.delegate).not.toHaveBeenCalled(); expect(f.store.usageLedger).toEqual([]);
    expect(result.events.filter(event => event.type === "usage/updated")).toEqual([]);
  });

  it("uses the target's own platform key only with explicit paid opt-in", async () => {
    const f = await fixture({ platformTarget: true, paid: true }); const result = await run(f);
    expect(result.turn?.status).toBe("completed"); expect(f.delegate).toHaveBeenCalledOnce();
    expect(new Headers(f.delegate.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer test-only-platform-target-key");
    expect(f.store.usageLedger).toHaveLength(1);
  });

  it("does not replace an actually dispatched unknown-cost failure", async () => {
    const f = await fixture({ failure: true }); const result = await run(f);
    expect(result.turn).toMatchObject({ status: "failed", error: { code: "provider_error", message: "Provider request failed." } });
    expect(f.fallback).toHaveBeenCalledOnce(); expect(f.delegate).toHaveBeenCalledOnce();
    expect(f.store.usageLedger).toHaveLength(1); expect(f.store.usageLedger[0]!.usage).not.toHaveProperty("costCNY");
    expect(result.events.filter(event => event.type === "usage/updated")).toHaveLength(1);
  });

  it("rejects a target whose context cannot hold the existing transcript", async () => {
    const f = await fixture({ contextWindow: 1 }); const result = await run(f);
    expect(result.turn?.status).toBe("failed"); expect(f.delegate).not.toHaveBeenCalled(); expect(f.store.usageLedger).toEqual([]);
  });

  it("rechecks lifecycle against the canonical explicit target and does not permit a middleware rewrite", async () => {
    const f = await fixture({ lifecycle: true, rewriteTarget: true }); const result = await run(f);
    expect(result.turn?.status).toBe("failed"); expect(f.delegate).not.toHaveBeenCalled(); expect(f.store.usageLedger).toEqual([]);
    expect(f.beforeModel!.mock.calls.map(([, input]) => input.modelRef)).toEqual([source, target]);
  });

  it("keeps target lifecycle checks and limits when middleware accepts it", async () => {
    const f = await fixture({ lifecycle: true }); const result = await run(f);
    expect(result.turn?.status).toBe("completed"); expect(f.delegate).toHaveBeenCalledOnce();
    expect(f.beforeModel!.mock.calls.map(([, input]) => input.modelRef)).toEqual([source, target]);
  });

  it.each(["text", "reasoning", "tool_args", "tool_execution"] as const)("closes selection at the current %s boundary", async kind => {
    let selected: EngineModelStep | undefined;
    const f = await fixture({ script: async (params, sink) => {
      await sink.onStepStart(1);
      const request = params.model.createRequest!(); await expect(request.apiKey!()).rejects.toMatchObject({ reason: "disabled" });
      if (kind === "text") sink.onTextDelta(""); else if (kind === "reasoning") sink.onReasoningDelta("");
      else if (kind === "tool_args") sink.onToolArgsDelta(undefined, ""); else await sink.onToolExecutionStart("fixture-call");
      selected = await sink.prepareFallbackModelStep!({ step: 1, model: params.model, systemPrompt: params.systemPrompt,
        messages: [{ role: "user", content: params.input }] }, request);
    } });
    await run(f); expect(selected).toBeUndefined(); expect(f.fallback).not.toHaveBeenCalled(); expect(f.delegate).not.toHaveBeenCalled();
  });

  it("resets the output fence for a later semantic step without replaying the earlier output", async () => {
    let selected: EngineModelStep | undefined;
    const f = await fixture({ script: async (params, sink) => {
      await sink.onStepStart(1); sink.onToolArgsDelta(undefined, ""); await sink.onStepStart(2);
      const request = params.model.createRequest!(); await expect(request.apiKey!()).rejects.toMatchObject({ reason: "disabled" });
      selected = await sink.prepareFallbackModelStep!({ step: 2, model: params.model, systemPrompt: params.systemPrompt,
        messages: [{ role: "user", content: params.input }] }, request);
    } });
    await run(f); expect(selected?.model.model).toBe(target.model); expect(f.fallback).toHaveBeenCalledOnce(); expect(f.delegate).not.toHaveBeenCalled();
  });
});
