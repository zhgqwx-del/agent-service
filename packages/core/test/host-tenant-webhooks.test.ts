import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiError, type AgentDefinition, type Principal } from "@agent-service/protocol";
import { createTenantWebhookAdminAccess, createTenantWebhookRuntimeAccess, MemoryEventBus, MemoryLeaseStore, MemorySessionStore, tenantWebhookAad, tenantWebhookId,
  type CommitBatch, type TenantWebhookIntent, type TenantWebhookRegistration } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type AgentEngine, type EngineSink, type EngineTurnParams, type RunnerTool, type ResolvedModel } from "../src/index.js";
import { RegisteredTenantWebhookService, type TenantWebhookDispatchReport } from "../src/hooks/registered.js";
import { TenantWebhookCipher, tenantWebhookHash } from "../src/hooks/cipher.js";
import { createTenantWebhookResponse, validateTenantWebhookRequest, type TenantWebhookRequestV2 } from "../src/hooks/webhook-v2.js";
import type { ToolHookService } from "../src/hooks/types.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

// Real Host/Memory atomic milestones and source capabilities. Most cases observe without HTTP;
// the explicitly named loopback cases use the actual HTTP substrate. None proves MySQL/fleet.
const owner: Principal = { tenantId: "tenant_managed_hooks", userId: "user_owner" };
const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 32_000, input: ["text"], apiKey: async () => "unused-fixture" };
const input = { input: [{ type: "text" as const, text: "initial current-turn text" }], stream: true, metadata: {} };
class Store extends MemorySessionStore {
  failPre = false; failResult = false;
  override async commit(batch: CommitBatch) {
    if (this.failResult && batch.items?.some(item => item.type === "toolResult")) throw new Error("fixture result commit failure");
    return super.commit(batch);
  }
  override async commitTenantWebhookMilestone(value: Parameters<MemorySessionStore["commitTenantWebhookMilestone"]>[0]) {
    if (this.failPre && !value.batch.items?.length) throw new Error("fixture pre commit failure");
    return super.commitTenantWebhookMilestone(value);
  }
}
class ObservedService extends RegisteredTenantWebhookService {
  readonly observed: Array<{ intent: TenantWebhookIntent; request: TenantWebhookRequestV2 }> = [];
  onDispatch?: (intent: TenantWebhookIntent) => Promise<void>;
  constructor(readonly fixtureStore: Store, readonly cipherRef: TenantWebhookCipher, readonly registrations: TenantWebhookRegistration[], readonly realDispatch = false, timeoutMs?: number,
    authorizeFleet: (signal: AbortSignal) => Promise<void> = async () => {}) {
    super({ store: fixtureStore, cipher: cipherRef, authorizeFleet, authorizeSubject: async () => {}, authorizeTenant: async () => {}, allowLoopbackForTests: realDispatch, timeoutMs });
  }
  override async dispatch(intents: readonly TenantWebhookIntent[], signal: AbortSignal, deadlineAt?: number): Promise<readonly TenantWebhookDispatchReport[]> {
    if (this.realDispatch) return super.dispatch(intents, signal, deadlineAt);
    for (const intent of intents) {
      const access = createTenantWebhookRuntimeAccess(intent.subject);
      const claim = await this.fixtureStore.claimTenantWebhookDelivery({ access, intentId: intent.intentId, timeoutMs: 1000 });
      if (!claim) continue;
      const version = this.registrations.find(value => value.version?.configVersionId === intent.configVersionId)!.version!;
      const material = this.cipherRef.open(tenantWebhookAad(version, "delivery_payload", { principal: intent.subject,
        sessionId: intent.sessionId, turnId: intent.turnId, callItemId: intent.callItemId }), claim.intent.payload);
      if (material.purpose !== "delivery_payload") throw new Error("Fixture payload purpose mismatch");
      const stored = await this.fixtureStore.getTenantWebhookDelivery({ access: createTenantWebhookAdminAccess({ tenantId: owner.tenantId, apiKeyId: "admin_hooks" }), intentId: intent.intentId });
      expect(stored?.payloadSha256 === intent.payloadSha256).toBe(true);
      await this.onDispatch?.(intent);
      this.observed.push({ intent, request: material.request as TenantWebhookRequestV2 });
      await this.fixtureStore.finishTenantWebhookDelivery({ access, intentId: intent.intentId, claimToken: claim.claimToken,
        outcome: "failed_not_dispatched", resultSha256: tenantWebhookHash("fixture-not-dispatched-v2", intent.intentId) });
    }
    return []; // No fabricated external ACK: the pure fixture records an explicit local non-dispatch.
  }
}
class ReusedCallEngine implements AgentEngine {
  readonly name = "tenant-hook-reused-call-fixture";
  readonly delegate = new ScriptedEngine([
    { toolCalls: [{ name: "echo", args: { step: 1 } }] }, { toolCalls: [{ name: "echo", args: { step: 2 } }] }, { text: "finished" },
  ]);
  start(params: EngineTurnParams, sink: EngineSink) {
    const callId = "call_reused", message = (value: Parameters<EngineSink["onAssistantMessage"]>[0]) => ({ ...value,
      toolCalls: value.toolCalls.map(call => ({ ...call, id: callId })) });
    return this.delegate.start({ ...params, tools: params.tools.map(tool => ({ ...tool,
      execute: (args: unknown, context: Parameters<RunnerTool["execute"]>[1]) => tool.execute(args, { ...context, toolCallId: callId }),
    })) }, { ...sink, onAssistantMessage: value => sink.onAssistantMessage(message(value)),
      beforeToolCall: (call, value) => sink.beforeToolCall({ ...call, id: callId }, message(value)),
      onToolExecutionStart: () => sink.onToolExecutionStart(callId),
      afterToolCall: async value => {
        const remapped = { ...value, toolCallId: callId };
        const [canonical] = await Promise.all([sink.afterToolCall(remapped), sink.onToolResult(remapped)]);
        await sink.onToolResult(remapped); return canonical;
      },
    });
  }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const work of cleanup.splice(0).reverse()) await work(); vi.unstubAllEnvs(); });
async function setup(options: { phase?: "preToolUse" | "postToolUse"; scopes?: Array<"prompt" | "tool_arguments" | "tool_result">;
  tool?: RunnerTool; hooks?: ToolHookService; script?: ScriptStep[]; engine?: AgentEngine;
  policy?: AgentDefinition["approvalPolicy"]; endpoint?: string; realDispatch?: boolean; timeoutMs?: number;
  authorizeFleet?: (signal: AbortSignal) => Promise<void> } = {}) {
  const store = new Store(), bus = new MemoryEventBus(), lease = new MemoryLeaseStore();
  await store.createApiKey(owner.tenantId, "admin_hooks", "fixture-hash", ["admin"]);
  const cipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
  const registrations: TenantWebhookRegistration[] = [], service = new ObservedService(store, cipher, registrations, options.realDispatch, options.timeoutMs, options.authorizeFleet);
  const access = createTenantWebhookAdminAccess({ tenantId: owner.tenantId, apiKeyId: "admin_hooks" });
  const registration = await service.upsert(owner.tenantId, { access, name: "observe", expectedRevision: 0, idempotencyKey: "install",
    config: { endpoint: options.endpoint ?? "https://hooks.example.test/receiver", phase: options.phase ?? "preToolUse", bodyScopes: options.scopes ?? [] },
    signingKey: "a".repeat(64), ...(options.scopes?.length ? { disclosureAck: "tenant-admin-body-disclosure-v1" as const } : {}) }, new AbortController().signal);
  registrations.push(registration);
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "canonical result" }] }));
  const tool = options.tool ?? { name: "echo", kind: "builtin" as const, description: "echo", parameters: { type: "object" }, readOnly: true, execute };
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "tenant hooks", instructions: "Use echo.",
    model: { provider: "fake", model: "fake" }, tools: [tool.name], mcpServers: [], skills: [], limits: {}, approvalPolicy: options.policy ?? "never",
    busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const scripted = new ScriptedEngine(options.script ?? [{ toolCalls: [{ name: "echo", args: { argument: "durable argument" } }] }, { text: "finished" }]);
  const engine = options.engine ?? scripted;
  const host = new SessionHost({ store, bus, lease, engine, tools: new StaticToolRegistry([tool]), tenantWebhooks: service, hooks: options.hooks,
    providers: { resolve: async () => model }, config: { runnerId: "r_tenant_hooks", runnerAddr: "127.0.0.1:1", leaseTtlMs: 2000, leaseHoldMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} } });
  cleanup.push(async () => { await host.drain(0); await service.close(); cipher.close(); await bus.close(); await lease.close(); });
  const session = await host.createSession({ ...owner, userId: "trusted_creator" }, { agentId: agent.id, userId: owner.userId, metadata: {} });
  return { store, bus, lease, cipher, service, registrations, access, host, session, execute, engine, scripted };
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 3000;
  while (Date.now() < until) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Tenant hook pure fixture did not settle");
}
async function finish(fixture: Awaited<ReturnType<typeof setup>>, turnId: string) {
  return waitFor(async () => { const turn = await fixture.store.getTurn(fixture.session.id, turnId); return turn && turn.status !== "inProgress" ? turn : undefined; });
}
describe("SessionHost managed tenant observer atomic milestones", () => {
  it("uses the actual delegated owner and a committed metadata-only pre intent before approval/start", async () => {
    const h = await setup(); let inspected = false;
    h.service.onDispatch = async intent => {
      expect(intent.subject).toEqual(owner);
      const items = await h.store.listItems(h.session.id, { limit: 100 });
      expect(items.find(item => item.type === "toolCall")).not.toHaveProperty("startedAtMs");
      expect(await h.store.listApprovals(h.session.id, {})).toEqual([]); inspected = true;
    };
    const turn = await h.host.startTurn(owner, h.session.id, input); await finish(h, turn.turn.id);
    expect(inspected).toBe(true); expect(h.execute).toHaveBeenCalledTimes(1); expect(h.service.observed).toHaveLength(1);
    expect(Object.hasOwn(h.service.observed[0]!.request, "body")).toBe(false);
    const events = await h.store.readEvents(h.session.id, 0, 100);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  });
  it("commits post intent with the actual canonical result before observation and fixes prompt before later steer", async () => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const tool: RunnerTool = { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" }, readOnly: true,
      execute: async () => { entered(); await blocked; return { content: [{ type: "text", text: "canonical result" }] }; } };
    const h = await setup({ phase: "postToolUse", scopes: ["prompt", "tool_arguments", "tool_result"], tool });
    h.service.onDispatch = async () => { expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(true); };
    try {
      const turn = await h.host.startTurn(owner, h.session.id, input); await began;
      await h.host.steer(owner, h.session.id, turn.turn.id, { input: [{ type: "text", text: "later committed steer" }] });
      release(); await finish(h, turn.turn.id);
      expect(h.service.observed).toHaveLength(1);
      const body = h.service.observed[0]!.request.body!;
      expect(body.prompt).toEqual({ profile: "current_turn_user_text_v1", textParts: ["initial current-turn text"] });
      expect(body.tool_arguments).toEqual({ argument: "durable argument" });
      expect(body.tool_result).toEqual({ content: [{ type: "text", text: "canonical result" }] });
    } finally { release(); }
  });
  it("includes only current-turn original text committed before invocation, including an admitted steer", async () => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const delegate = new ScriptedEngine([{ toolCalls: [{ name: "echo", args: {} }] }, { text: "finished" }]);
    const engine: AgentEngine = { name: "tenant-hook-prompt-watermark-fixture", start: (params, sink) => delegate.start(params, { ...sink,
      onStepStart: async step => { await sink.onStepStart(step); if (step === 1) { entered(); await blocked; } },
    }) };
    const h = await setup({ scopes: ["prompt"], engine });
    try {
      const turn = await h.host.startTurn(owner, h.session.id, input); await began;
      await h.host.steer(owner, h.session.id, turn.turn.id, { input: [{ type: "text", text: "committed steer before invocation" }] });
      release(); expect((await finish(h, turn.turn.id)).status).toBe("completed");
      expect(h.service.observed).toHaveLength(1);
      expect(h.service.observed[0]!.request.body?.prompt).toEqual({ profile: "current_turn_user_text_v1",
        textParts: ["initial current-turn text", "committed steer before invocation"] });
    } finally { release(); }
  });
  it("preserves operator pre denial and never starts or dispatches a tenant body afterwards", async () => {
    const hooks: ToolHookService = { enabled: true, version: () => "c".repeat(64), preToolUse: async () => ({ allow: false, reports: [] }), postToolUse: async () => [], close: async () => {} };
    const h = await setup({ hooks, scopes: ["prompt", "tool_arguments"] });
    const turn = await h.host.startTurn(owner, h.session.id, input); await finish(h, turn.turn.id);
    expect(h.execute).not.toHaveBeenCalled(); expect(h.service.observed).toEqual([]);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolCall")).not.toHaveProperty("startedAtMs");
  });
  it.each(["pre", "post"] as const)("never observes an uncommitted %s milestone", async phase => {
    const h = await setup({ phase: phase === "pre" ? "preToolUse" : "postToolUse" });
    h.store.failPre = phase === "pre"; h.store.failResult = phase === "post";
    await h.host.startTurn(owner, h.session.id, input); await waitFor(() => !h.host.activeTurn(h.session.id) ? true : undefined);
    expect(h.scripted.startedSteps).toBe(1);
    expect(h.service.observed).toEqual([]);
    expect(h.execute).toHaveBeenCalledTimes(phase === "pre" ? 0 : 1);
    if (phase === "post") expect((await h.store.listItems(h.session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toEqual([]);
    const deliveries = await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 });
    expect(deliveries.items).toEqual([]);
  });
  it("rejects a changed pre policy after approval wait, without redispatching or weakening tool consent", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "canonical result" }] }));
    const h = await setup({ policy: "untrusted", tool: { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" }, readOnly: false, execute } });
    const turn = await h.host.startTurn(owner, h.session.id, input);
    const approval = await waitFor(async () => (await h.store.listApprovals(h.session.id, { pendingOnly: true }))[0]);
    expect(h.service.observed).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
    await h.service.setState(owner.tenantId, "observe", { access: h.access, expectedRevision: 1, idempotencyKey: "disable", state: "disabled" }, new AbortController().signal);
    await h.host.resolveApproval(owner, h.session.id, approval.id, "accept"); await finish(h, turn.turn.id);
    expect(execute).not.toHaveBeenCalled(); expect(h.service.observed).toHaveLength(1);
  });
  it("does not accept an invented source wrapper or a caller-supplied credential record as a trusted compiler source", async () => {
    const h = await setup();
    expect(() => h.service.prepare({ kind: "tenant-webhook-source-v2", value: { provider: "not-a-source" } } as never, "pre")).toThrow();
    expect(h.service.observed).toEqual([]);
  });
  it.each([false, true])("keeps distinct durable calls when an external id repeats (different results=%s), but deduplicates same-item callbacks", async different => {
    const execute = vi.fn(async (args: unknown) => ({ content: [{ type: "text" as const,
      text: different ? `result ${(args as { step: number }).step}` : "same result" }] }));
    const engine = new ReusedCallEngine(), h = await setup({ phase: "postToolUse", scopes: ["tool_result"], engine,
      tool: { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" }, readOnly: true, execute } });
    const turn = await h.host.startTurn(owner, h.session.id, input); expect((await finish(h, turn.turn.id)).status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(2); expect(h.service.observed).toHaveLength(2);
    expect(new Set(h.service.observed.map(value => value.intent.callItemId)).size).toBe(2);
    expect(h.service.observed.every(value => value.intent.toolCallId === "call_reused")).toBe(true);
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    expect(items.filter(item => item.type === "toolCall" && item.status === "completed")).toHaveLength(2);
    expect(items.filter(item => item.type === "toolResult")).toHaveLength(2);
    const events = await h.store.readEvents(h.session.id, 0, 100);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  });
  it("persists the canonical result after post policy revocation without sending new or unapproved body", async () => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const tool: RunnerTool = { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" }, readOnly: true,
      execute: async () => { entered(); await blocked; return { content: [{ type: "text", text: "real completed result" }] }; } };
    const h = await setup({ phase: "postToolUse", scopes: ["prompt", "tool_result"], tool });
    try {
      const turn = await h.host.startTurn(owner, h.session.id, input); await began;
      await h.service.setState(owner.tenantId, "observe", { access: h.access, expectedRevision: 1, idempotencyKey: "disable-post", state: "disabled" }, new AbortController().signal);
      release(); expect((await finish(h, turn.turn.id)).status).toBe("completed");
      expect((await h.store.listItems(h.session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toHaveLength(1);
      expect(h.service.observed).toEqual([]);
      expect((await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 })).items.map(item => item.state)).toEqual(["blocked"]);
    } finally { release(); }
  });
  it.each(["source", "snapshot", "payload"] as const)("retains the actual result when the %s projection exceeds its budget, with an honest non-dispatch intent", async boundary => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: boundary === "payload" ? "r".repeat(20_000) : "small result" }] }));
    const h = await setup({ phase: "postToolUse", scopes: boundary === "payload" ? ["tool_result"] : ["prompt"],
      tool: { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" }, readOnly: true, execute } });
    const turn = await h.host.startTurn(owner, h.session.id, boundary !== "payload" ? { ...input, input: [{ type: "text", text: "p".repeat(boundary === "source" ? 70_000 : 61_000) }] } : input);
    expect((await finish(h, turn.turn.id)).status).toBe("completed"); expect(execute).toHaveBeenCalledTimes(1);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toHaveLength(1);
    expect(h.service.observed).toEqual([]);
    const deliveries = await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 });
    expect(deliveries.items).toHaveLength(1);
    expect(deliveries.items[0]).toMatchObject({ state: "failed_not_dispatched", payload: null, payloadSha256: null,
      payloadBytes: null, requestSha256: null, invocationId: null });
    expect((await h.store.readEvents(h.session.id, 0, 100)).some(event => event.type === "warning" && event.code === "tenant_hook_not_dispatched")).toBe(true);
  });
  it.each(["ack", "response-loss", "deadline"] as const)("uses actual anonymous loopback HTTP for %s, then refuses a cold second-service redispatch", async mode => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
    let requests = 0, peerValid = true;
    const signingKey = Buffer.from("a".repeat(64), "hex");
    const server = createServer((request, response) => { void (async () => {
      try {
        const parts: Buffer[] = []; let size = 0;
        for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length; if (size > 16_384) throw new Error("fixture bound"); parts.push(bytes); }
        const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        const verified = validateTenantWebhookRequest(parsed, signingKey); requests++;
        if (request.headers.authorization !== undefined || request.method !== "POST") peerValid = false;
        if (mode === "response-loss") { response.destroy(); return; }
        if (mode === "deadline") return; // Leave the actual socket pending until the bounded client cancels it.
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(createTenantWebhookResponse(verified, signingKey)));
      } catch { peerValid = false; response.writeHead(500); response.end(); }
    })(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); signingKey.fill(0); });
    const h = await setup({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/observe`, realDispatch: true,
      ...(mode === "deadline" ? { timeoutMs: 100 } : {}) });
    const turn = await h.host.startTurn(owner, h.session.id, input); await finish(h, turn.turn.id);
    expect(peerValid).toBe(true); expect(requests).toBe(1); expect(h.execute).toHaveBeenCalledTimes(1);
    const deliveries = await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 });
    expect(deliveries.items.map(intent => intent.state)).toEqual([mode === "ack" ? "acknowledged" : "outcome_unknown"]);
    const coldCipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
    const cold = new RegisteredTenantWebhookService({ store: h.store, cipher: coldCipher, authorizeFleet: async () => {}, allowLoopbackForTests: true });
    try { await cold.dispatch(deliveries.items, new AbortController().signal); }
    finally { await cold.close(); coldCipher.close(); }
    expect(requests).toBe(1);
  });
  it("settles the actual pending HTTP and its durable unknown claim before close returns, without executing the tool or replaying", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
    let entered!: () => void, requests = 0, socketClosed = false;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const server = createServer((request, response) => { void (async () => {
      for await (const _part of request) { /* Consume only this fixture's bounded metadata request. */ }
      requests++; response.once("close", () => { socketClosed = true; }); entered();
    })(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const h = await setup({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/observe`, realDispatch: true });
    await h.host.startTurn(owner, h.session.id, input); await began;
    await h.service.close();
    const deliveries = await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 });
    expect(deliveries.items.map(intent => intent.state)).toEqual(["outcome_unknown"]);
    await waitFor(() => socketClosed ? true : undefined); expect(h.execute).not.toHaveBeenCalled();
    const coldCipher = new TenantWebhookCipher({ keyId: "hooks_fixture", key: Buffer.alloc(32, 7) });
    const cold = new RegisteredTenantWebhookService({ store: h.store, cipher: coldCipher, authorizeFleet: async () => {}, allowLoopbackForTests: true });
    try { await cold.dispatch(deliveries.items, new AbortController().signal); }
    finally { await cold.close(); coldCipher.close(); }
    expect(requests).toBe(1);
  });
  it("continues the actual tool after the first observer exhausts its own phase budget, and never dispatches the second observer", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
    let slowRequests = 0, laterRequests = 0, peerValid = true;
    const key = Buffer.from("a".repeat(64), "hex");
    const peer = (slow: boolean) => createServer((request, response) => { void (async () => {
      try {
        const parts: Buffer[] = []; let size = 0;
        for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length; if (size > 16_384) throw new Error("fixture bound"); parts.push(bytes); }
        const verified = validateTenantWebhookRequest(JSON.parse(Buffer.concat(parts).toString("utf8")), key);
        if (request.method !== "POST" || request.headers.authorization !== undefined) peerValid = false;
        if (slow) { slowRequests++; return; } // Its actual socket remains open until the phase timer cancels it.
        laterRequests++; response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(createTenantWebhookResponse(verified, key)));
      } catch { peerValid = false; response.writeHead(500); response.end(); }
    })(); });
    const slow = peer(true), later = peer(false);
    await new Promise<void>(resolve => slow.listen(0, "127.0.0.1", resolve));
    await new Promise<void>(resolve => later.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      await Promise.all([slow, later].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
      key.fill(0);
    });
    const slowEndpoint = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/observe`;
    const laterEndpoint = `http://127.0.0.1:${(later.address() as AddressInfo).port}/observe`;
    const observeFirst = tenantWebhookId(owner.tenantId, "observe") < tenantWebhookId(owner.tenantId, "second");
    const h = await setup({ endpoint: observeFirst ? slowEndpoint : laterEndpoint, realDispatch: true, timeoutMs: 250 });
    const second = await h.service.upsert(owner.tenantId, { access: h.access, name: "second", expectedRevision: 0, idempotencyKey: "install-second",
      config: { endpoint: observeFirst ? laterEndpoint : slowEndpoint, phase: "preToolUse", bodyScopes: [] }, signingKey: "a".repeat(64) }, new AbortController().signal);
    h.registrations.push(second);
    const turn = await h.host.startTurn(owner, h.session.id, input);
    expect((await finish(h, turn.turn.id)).status).toBe("completed");
    expect(peerValid).toBe(true); expect(slowRequests).toBe(1); expect(laterRequests).toBe(0); expect(h.execute).toHaveBeenCalledTimes(1);
    const first = await h.store.listTenantWebhookDeliveries({ access: h.access, name: observeFirst ? "observe" : "second", cursor: null, limit: 100 });
    const unattempted = await h.store.listTenantWebhookDeliveries({ access: h.access, name: observeFirst ? "second" : "observe", cursor: null, limit: 100 });
    expect(first.items.map(intent => intent.state)).toEqual(["outcome_unknown"]);
    expect(unattempted.items.map(intent => intent.state)).toEqual(["failed_not_dispatched"]);
  });
  it.each(["budget-only", "caller", "close", "authorization-reject"] as const)("settles an expired entry budget without HTTP, but preserves %s authority semantics", async mode => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
    let requests = 0, rejectAuthorization = false, refusal: string | undefined;
    const server = createServer((request, response) => { requests++; request.resume(); response.writeHead(500); response.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const h = await setup({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/observe`, realDispatch: true,
      authorizeFleet: async () => { if (rejectAuthorization) {
        await new Promise(resolve => setTimeout(resolve, 20)); throw new ApiError("forbidden", "Fixture authorization rejected.");
      } } });
    const actual = h.service.dispatch.bind(h.service), abandon = vi.spyOn(h.store, "abandonPreparedTenantWebhookDelivery");
    vi.spyOn(h.service, "dispatch").mockImplementation(async (intents, signal, deadlineAt) => {
      if (!intents.length) return actual(intents, signal, deadlineAt);
      const caller = new AbortController();
      if (mode === "caller") caller.abort();
      if (mode === "close") await h.service.close();
      if (mode === "authorization-reject") rejectAuthorization = true;
      try { return await actual(intents, AbortSignal.any([signal, caller.signal]),
        performance.now() + (mode === "authorization-reject" ? 10 : -1)); }
      catch (error) { refusal = error instanceof ApiError ? error.code : "other"; throw error; }
    });
    const turn = await h.host.startTurn(owner, h.session.id, input), completed = await finish(h, turn.turn.id);
    expect(requests).toBe(0);
    if (mode === "budget-only") {
      expect(completed.status).toBe("completed"); expect(h.execute).toHaveBeenCalledTimes(1); expect(abandon).toHaveBeenCalledTimes(1); expect(refusal).toBeUndefined();
    } else {
      expect(completed.status).not.toBe("completed"); expect(h.execute).not.toHaveBeenCalled(); expect(abandon).not.toHaveBeenCalled();
      expect(refusal).toBe(mode === "authorization-reject" ? "forbidden" : "draining");
    }
    const deliveries = await h.store.listTenantWebhookDeliveries({ access: h.access, name: "observe", cursor: null, limit: 100 });
    expect(deliveries.items.map(intent => intent.state)).toEqual([mode === "budget-only" ? "failed_not_dispatched" : "prepared"]);
  });
  it("waits for the actual non-cancellable authorization to settle on close and never enters the Store afterwards", async () => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const store = new Store(), cipher = new TenantWebhookCipher({ keyId: "drain_fixture", key: Buffer.alloc(32, 9) });
    const read = vi.spyOn(store, "getTenantWebhook");
    const service = new RegisteredTenantWebhookService({ store, cipher, authorizeFleet: async () => {},
      authorizeTenant: async () => { entered(); await blocked; } });
    const result = service.get(owner.tenantId, "observe", { access: createTenantWebhookAdminAccess({ tenantId: owner.tenantId, apiKeyId: "admin_hooks" }) }, new AbortController().signal)
      .then(() => "resolved", () => "rejected");
    let settled = false;
    try {
      await began; const closing = service.close().then(() => { settled = true; });
      await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false); expect(read).not.toHaveBeenCalled();
      release(); await closing; expect(await result).toBe("rejected"); expect(read).not.toHaveBeenCalled();
    } finally { release(); await service.close(); cipher.close(); }
  });
});
