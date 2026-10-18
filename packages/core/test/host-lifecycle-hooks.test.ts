import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type Models } from "@earendil-works/pi-ai";
import { Event, LifecycleHookPhase, emptyUsage, type AgentDefinition, type InputPart, type Item, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore, type CommitBatch, type UsageLedgerWrite } from "@agent-service/store";
import { SessionHost } from "../src/session/host.js";
import { PiEngine } from "../src/engine/pi.js";
import { StaticToolRegistry } from "../src/tools/types.js";
import type { ResolvedModel, Summariser } from "../src/engine/types.js";
import type { RunnerTool } from "../src/tools/types.js";
import { ConfiguredLifecycleHookService } from "../src/hooks/lifecycle.js";
import type { LifecycleHookService, LifecyclePackageDefinition } from "../src/hooks/lifecycle-types.js";
import { projectItems } from "../src/context/history.js";

// Real Host/Memory transactions and the actual Pi request/tool adapter; no HTTP/MySQL claim.
const owner: Principal = { tenantId: "lifecycle-host", userId: "owner" };
const input = [{ type: "text" as const, text: "original user" }];
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function handle(id = "model-a", provider = "provider-a"): Model<"openai-completions"> {
  return { id, provider, name: id, api: "openai-completions", baseUrl: "http://unused.invalid", reasoning: false,
    input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 8192 };
}
function resolved(id = "model-a", provider = "provider-a"): ResolvedModel {
  return { handle: handle(id, provider), provider, model: id, contextWindow: 32_000, input: ["text"], priceKnown: true,
    apiKey: async () => `fixture-${provider}`, headers: { "X-Fixture-Provider": provider } };
}
class ModelsFixture {
  requests: { model: string; provider: string; context: Context; maxTokens?: number; keyMatches: boolean; headerMatches: boolean }[] = [];
  beforeResponse?: (index: number) => Promise<void>;
  constructor(readonly script: ("tool" | "text")[] = ["tool", "text"]) {}
  streamSimple(model: Model<"openai-completions">, context: Context, options: { maxTokens?: number; apiKey?: string; headers?: Record<string, string> }) {
    const index = this.requests.length;
    this.requests.push({ model: model.id, provider: model.provider, context: structuredClone(context), maxTokens: options.maxTokens,
      keyMatches: options.apiKey === `fixture-${model.provider}`, headerMatches: options.headers?.["X-Fixture-Provider"] === model.provider });
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id,
      content: this.script[index] === "tool" ? [{ type: "toolCall", id: "call-reused", name: "echo", arguments: { value: "model original" } }]
        : [{ type: "text", text: "finished" }], usage, stopReason: this.script[index] === "tool" ? "toolUse" : "stop", timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(async () => {
      await this.beforeResponse?.(index);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
    });
    return stream;
  }
}
const audit = (): LifecyclePackageDefinition => ({ id: "audit", package: "audit", subjects: [owner], phases: [...LifecycleHookPhase.options] });
class Store extends MemorySessionStore {
  failParameters = false;
  failTerminal = false;
  terminalAttempts = 0;
  ledger: UsageLedgerWrite[] = [];
  override async commit(batch: CommitBatch) {
    if (this.failParameters && batch.events?.some(event => event.type === "item/toolCall/parametersChanged")) throw new Error("fixture commit rejected");
    if (batch.events?.some(event => event.type === "turn/completed")) {
      this.terminalAttempts++;
      if (this.failTerminal) throw new Error("fixture terminal commit rejected");
    }
    const result = await super.commit(batch);
    this.ledger.push(...structuredClone(batch.usageEntries ?? []));
    return result;
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { packages?: LifecyclePackageDefinition[]; service?: LifecycleHookService; models?: ModelsFixture;
  approval?: AgentDefinition["approvalPolicy"]; summariser?: Summariser; authorize?: (signal: AbortSignal) => Promise<void> } = {}) {
  const service = options.service ?? new ConfiguredLifecycleHookService({ packages: options.packages ?? [audit()] });
  const store = new Store(), lease = new MemoryLeaseStore(), bus = new MemoryEventBus(), models = options.models ?? new ModelsFixture();
  const executions: unknown[] = [];
  const tool: RunnerTool = { name: "echo", description: "echo", kind: "builtin", readOnly: false,
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: async args => { executions.push(structuredClone(args)); return { content: [{ type: "text", text: JSON.stringify(args) }] }; } };
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "lifecycle", instructions: "base system",
    model: { provider: "provider-a", model: "model-a" }, tools: [tool.name], mcpServers: [], skills: [], limits: {},
    approvalPolicy: options.approval ?? "never", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const resolutions: { principal: Principal; provider: string; model: string }[] = [];
  const host = new SessionHost({ store, lease, bus, engine: new PiEngine(models as unknown as Models), tools: new StaticToolRegistry([tool]),
    lifecycleHooks: service, summariser: options.summariser, authorizeRuntimeExtensions: options.authorize,
    providers: { resolve: async (principal, ref) => { resolutions.push({ principal: { ...principal }, ...ref }); return resolved(ref.model, ref.provider); } },
    config: { runnerId: "lifecycle-runner", runnerAddr: "127.0.0.1:1", leaseTtlMs: 2000, leaseHoldMs: 1 },
    logger: { info() {}, warn() {}, error() {} } });
  cleanups.push(async () => { await host.drain(0); await service.close(); await Promise.all([bus.close(), lease.close()]); });
  return { store, lease, bus, host, service, models, agent, executions, resolutions };
}
import { newId } from "../src/ids.js";
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Lifecycle fixture did not settle.");
}
async function complete(f: Awaited<ReturnType<typeof setup>>, sessionId: string, content: InputPart[] = input) {
  const begun = await f.host.beginTurn(owner, sessionId, { input: content, stream: true, metadata: {} }); begun.run();
  const terminal = await waitFor(async () => { const turn = await f.store.getTurn(sessionId, begun.turn.id); return turn?.status !== "inProgress" ? turn : undefined; });
  await waitFor(async () => (await events(f, sessionId)).some(event => event.type === "lifecycle-hook/completed"
    && event.phase === "Stop" && event.turnId === begun.turn.id) ? true : undefined);
  return terminal;
}
async function events(f: Awaited<ReturnType<typeof setup>>, sessionId: string) { return f.store.readEvents(sessionId, 0, 1000); }

describe("Host actual lifecycle/middleware boundaries", () => {
  it("rewrites durable tool args before approval, executes the effective copy and keeps next Pi/cold context identical", async () => {
    const f = await setup({ approval: "untrusted", packages: [audit(), { id: "rewrite", package: "tool-policy", subjects: [owner], denyTools: [],
      rewrites: [{ tool: "echo", args: { value: "effective" } }] }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    const approval = await waitFor(async () => (await f.store.listApprovals(session.id, { pendingOnly: true }))[0]);
    expect(approval.args).toEqual({ value: "effective" }); expect(f.executions).toEqual([]);
    await f.host.resolveApproval(owner, session.id, approval.id, "accept");
    expect((await waitFor(async () => { const t = await f.store.getTurn(session.id, begun.turn.id); return t?.status === "completed" ? t : undefined; })).status).toBe("completed");
    await waitFor(async () => (await events(f, session.id)).some(event => event.type === "lifecycle-hook/completed" && event.phase === "Stop") ? true : undefined);
    const items = await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 });
    const call = items.find(item => item.type === "toolCall");
    expect(call).toMatchObject({ args: { value: "effective" }, originalArgs: { value: "model original" }, status: "completed" });
    expect(f.executions).toEqual([{ value: "effective" }]);
    const next = f.models.requests[1]!.context.messages.find(message => message.role === "assistant");
    expect(next?.role === "assistant" && next.content.find(part => part.type === "toolCall")).toMatchObject({ arguments: { value: "effective" } });
    const cold = projectItems(items).messages.find(message => message.role === "assistant" && message.toolCalls.length);
    expect(cold?.role === "assistant" && cold.toolCalls[0]?.args).toEqual({ value: "effective" });
    const stream = await events(f, session.id); expect(stream.every(event => Event.safeParse(event).success)).toBe(true);
    expect(stream.filter(event => event.type === "item/toolCall/parametersChanged")).toHaveLength(1);
    const phases = stream.flatMap(event => event.type === "lifecycle-hook/completed" ? [event.phase] : []);
    expect(phases).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"]);
    expect(stream.findIndex(event => event.type === "item/toolCall/parametersChanged")).toBeLessThan(stream.findIndex(event => event.type === "approval/requested"));
  });

  it("re-resolves the routed model for each real Pi step, uses actual credentials/usage and only tightens complete limits", async () => {
    let proofs = 0;
    const f = await setup({ authorize: async () => { proofs++; }, packages: [audit(),
      { id: "route", package: "prompt-policy", subjects: [owner], modelRef: { provider: "provider-b", model: "model-b" }, limits: { maxOutputTokensPerStep: 17, maxSteps: 8 } },
      { id: "memory", package: "memory-injection", subjects: [owner], prefix: "memory-prefix", append: "memory-append" }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    const turn = await complete(f, session.id); expect(turn?.status).toBe("completed");
    expect(f.models.requests.map(request => [request.provider, request.model, request.maxTokens])).toEqual([["provider-b", "model-b", 17], ["provider-b", "model-b", 17]]);
    expect(f.models.requests.every(request => request.keyMatches && request.headerMatches)).toBe(true);
    expect(f.models.requests.every(request => {
      const system = request.context.messages.filter(message => message.role === "system").map(message =>
        typeof message.content === "string" ? message.content : message.content.map(part => part.text).join("\n")).join("\n");
      return system.split("memory-prefix").length === 2 && system.split("memory-append").length === 2;
    })).toBe(true);
    expect(f.resolutions.filter(value => value.provider === "provider-b")).toHaveLength(2);
    expect(f.resolutions.every(value => value.principal.tenantId === owner.tenantId && value.principal.userId === owner.userId)).toBe(true);
    expect(f.store.ledger.map(row => [row.provider, row.model])).toEqual([["provider-b", "model-b"], ["provider-b", "model-b"]]);
    expect(turn?.usage.totalTokens).toBe(6); expect(proofs).toBe(3);
  });

  it("persists original versus effective prompt and steer text, and cold projection never re-runs middleware", async () => {
    const hold = deferred(), entered = deferred(), models = new ModelsFixture(["text", "text"]);
    models.beforeResponse = async index => { if (index === 0) { entered.resolve(); await hold.promise; } };
    const f = await setup({ models, packages: [audit(), { id: "prompt", package: "prompt-policy", subjects: [owner], prependText: "before", appendText: "after" }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    try {
      await entered.promise;
      await f.host.steer(owner, session.id, begun.turn.id, { input: [{ type: "text", text: "steer original" }] });
    } finally { hold.resolve(); }
    await waitFor(async () => (await f.store.getTurn(session.id, begun.turn.id))?.status === "completed" ? true : undefined);
    const items = await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 });
    const users = items.filter((item): item is Extract<Item, { type: "userMessage" }> => item.type === "userMessage");
    expect(users.map(item => item.content)).toEqual([input, [{ type: "text", text: "steer original" }]]);
    expect(users.map(item => item.effectiveContent?.map(part => part.type === "text" ? part.text : "attachment"))).toEqual([["before", "original user", "after"], ["before", "steer original", "after"]]);
    const cold = projectItems(items).messages.filter(message => message.role === "user");
    expect(cold.map(message => message.role === "user" && message.content.map(part => part.type === "text" ? part.text : "image"))).toEqual([["before", "original user", "after"], ["before", "steer original", "after"]]);
    expect((await events(f, session.id)).filter(event => event.type === "lifecycle-hook/completed" && event.phase === "UserPromptSubmit")).toHaveLength(2);
  });

  it("rejects invalid rewritten args before approval/started/execute without leaking validation content", async () => {
    const f = await setup({ approval: "untrusted", packages: [{ id: "bad", package: "tool-policy", subjects: [owner], denyTools: [], rewrites: [{ tool: "echo", args: { unknown: "secret-canary" } }] }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    await complete(f, session.id);
    expect(f.executions).toEqual([]); expect(await f.store.listApprovals(session.id, {})).toEqual([]);
    const items = await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 });
    expect(items.filter(item => item.type === "toolCall").every(item => item.startedAtMs === undefined)).toBe(true);
    expect(JSON.stringify(items).includes("secret-canary")).toBe(false);
  });

  it("never executes when the parameters COMMIT fails and never replays the ambiguous write", async () => {
    const f = await setup({ packages: [{ id: "rewrite", package: "tool-policy", subjects: [owner], denyTools: [], rewrites: [{ tool: "echo", args: { value: "effective" } }] }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} }); f.store.failParameters = true;
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    await waitFor(() => f.models.requests.length === 1 ? true : undefined);
    await f.host.drain(0);
    expect(f.executions).toEqual([]); expect(f.models.requests).toHaveLength(1);
    expect((await f.store.getTurn(session.id, begun.turn.id))?.status).toBe("inProgress");
  });

  it("pins middleware identity across an approval wait rather than executing newly changed policy", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [audit()] });
    const version = service.version.bind(service); let changed = false;
    vi.spyOn(service, "version").mockImplementation(principal => changed ? "f".repeat(64) : version(principal));
    const f = await setup({ service, approval: "untrusted" });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    const approval = await waitFor(async () => (await f.store.listApprovals(session.id, { pendingOnly: true }))[0]);
    changed = true; await f.host.resolveApproval(owner, session.id, approval.id, "accept");
    await f.host.drain(0); expect(f.executions).toEqual([]);
    expect((await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 })).filter(item => item.type === "toolCall").every(item => item.startedAtMs === undefined)).toBe(true);
  });

  it("interrupts the real engine before running independent terminal observers, without reopening tool admission", async () => {
    const entered = deferred(), release = deferred(), models = new ModelsFixture(["tool", "text"]);
    models.beforeResponse = async index => { if (index === 0) { entered.resolve(); await release.promise; } };
    const f = await setup({ models }); const service = f.service;
    const actual = service.observe.bind(service); const observed: { phase: string; aborted: boolean }[] = [];
    vi.spyOn(service, "observe").mockImplementation(async (context, signal) => { observed.push({ phase: context.phase, aborted: signal.aborted }); return actual(context, signal); });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    await entered.promise;
    const interrupted = f.host.interrupt(owner, session.id, begun.turn.id); release.resolve();
    expect((await interrupted).status).toBe("interrupted"); expect(f.executions).toEqual([]);
    expect(observed.filter(value => value.phase === "Interrupt" || value.phase === "Stop")).toEqual([{ phase: "Interrupt", aborted: false }, { phase: "Stop", aborted: false }]);
  });

  it("observes only real compaction and preserves accepted prompt bytes in summary input", async () => {
    const summaries: string[] = [];
    const summariser: Summariser = { summarise: async value => { summaries.push(value.text); return { text: "summary", usage: emptyUsage() }; } };
    const f = await setup({ models: new ModelsFixture(["text", "text", "text"]), summariser,
      packages: [audit(), { id: "prompt", package: "prompt-policy", subjects: [owner], prependText: "effective-prefix" }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    expect(await f.host.compactSession(owner, session.id)).toEqual({ compacted: false, summaryItemId: undefined });
    for (let index = 0; index < 3; index++) await complete(f, session.id, [{ type: "text", text: `turn${index} ${"long ".repeat(200)}` }]);
    expect((await f.host.compactSession(owner, session.id)).compacted).toBe(true);
    expect(summaries).toHaveLength(1); expect(summaries[0]?.includes("effective-prefix")).toBe(true);
    const phases = (await events(f, session.id)).flatMap(event => event.type === "lifecycle-hook/completed" && (event.phase === "PreCompact" || event.phase === "PostCompact") ? [event.phase] : []);
    expect(phases).toEqual(["PreCompact", "PostCompact"]);
  });

  it("uses actual delegated session owner and does not emit Subagent lifecycle for parentSessionId", async () => {
    const f = await setup({ models: new ModelsFixture(["text"]) });
    const caller = { ...owner, userId: "trusted-caller" };
    const session = await f.host.createSession(caller, { agentId: f.agent.id, userId: owner.userId, metadata: {} });
    const parent = await f.host.createSession(owner, { agentId: f.agent.id, parentSessionId: session.id, metadata: {} });
    const phases = (await events(f, parent.id)).flatMap(event => event.type === "lifecycle-hook/completed" ? [event.phase] : []);
    expect(phases).toEqual(["SessionStart"]);
    expect((await events(f, session.id)).some(event => event.type === "lifecycle-hook/completed" && event.phase === "SessionStart")).toBe(true);
  });

  it("skips SessionStart under an already held owner and never releases that owner's lease", async () => {
    const f = await setup(); const acquire = f.lease.acquire.bind(f.lease);
    const create = f.store.createSession.bind(f.store); let heldId = "";
    vi.spyOn(f.store, "createSession").mockImplementation(async session => { const result = await create(session); heldId = session.id; await acquire(session.id, "other-runner", "127.0.0.1:2", 2000); return result; });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    expect(session.id).toBe(heldId); expect((await f.lease.getOwner(session.id))?.ownerId).toBe("other-runner");
    expect((await events(f, session.id)).some(event => event.type === "lifecycle-hook/started")).toBe(false);
  });

  it("keeps repeated external call IDs separate across real Pi steps and observes each actual result once", async () => {
    const f = await setup({ models: new ModelsFixture(["tool", "tool", "text"]), packages: [audit(),
      { id: "rewrite", package: "tool-policy", subjects: [owner], denyTools: [], rewrites: [{ tool: "echo", args: { value: "effective" } }] }] });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    expect((await complete(f, session.id))?.status).toBe("completed");
    expect(f.executions).toEqual([{ value: "effective" }, { value: "effective" }]);
    const stream = await events(f, session.id), items = await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 });
    const calls = items.filter(item => item.type === "toolCall"), results = items.filter(item => item.type === "toolResult");
    expect(calls).toHaveLength(2); expect(results).toHaveLength(2); expect(new Set(calls.map(call => call.id)).size).toBe(2);
    expect(stream.filter(event => event.type === "lifecycle-hook/completed" && event.phase === "PostToolUse")).toHaveLength(2);
    expect(stream.map(event => event.seq)).toEqual(stream.map((_, index) => index + 1));
  });

  it("rejects new attachment authority introduced by a middleware double before persisting any turn", async () => {
    const f = await setup({ models: new ModelsFixture(["text"]) });
    const actual = f.service.beforePrompt.bind(f.service);
    vi.spyOn(f.service, "beforePrompt").mockImplementation(async (context, value, signal) => ({ ...await actual(context, value, signal),
      input: [...value.input, { type: "image", blobId: newId("blob") }] }));
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    await expect(f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} })).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.models.requests).toEqual([]); expect((await events(f, session.id)).some(event => event.type === "turn/started")).toBe(false);
  });

  it("runs Stop only after the real terminal transaction is visible to an independent Store read", async () => {
    const f = await setup({ models: new ModelsFixture(["text"]) });
    const actual = f.service.observe.bind(f.service); const states: string[] = [];
    vi.spyOn(f.service, "observe").mockImplementation(async (context, signal) => {
      if (context.phase === "Stop") states.push((await f.store.getTurn(context.sessionId, context.turnId))?.status ?? "missing");
      return actual(context, signal);
    });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} });
    await complete(f, session.id); await f.host.drain(2000);
    expect(states).toEqual(["completed"]);
    const stream = await events(f, session.id);
    expect(stream.findIndex(event => event.type === "turn/completed")).toBeLessThan(stream.findIndex(event => event.type === "lifecycle-hook/started" && event.phase === "Stop"));
  });

  it("does not emit Stop when the canonical terminal transaction fails", async () => {
    const f = await setup({ models: new ModelsFixture(["text"]) });
    const session = await f.host.createSession(owner, { agentId: f.agent.id, metadata: {} }); f.store.failTerminal = true;
    const begun = await f.host.beginTurn(owner, session.id, { input, stream: true, metadata: {} }); begun.run();
    await waitFor(() => f.store.terminalAttempts === 1 ? true : undefined); await f.host.drain(2000);
    expect((await f.store.getTurn(session.id, begun.turn.id))?.status).toBe("inProgress");
    expect((await events(f, session.id)).some(event => (event.type === "lifecycle-hook/started" || event.type === "lifecycle-hook/completed") && event.phase === "Stop")).toBe(false);
  });
});
