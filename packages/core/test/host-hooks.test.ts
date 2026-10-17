import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore, type CommitBatch } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, computeContextEpoch, newId, type AgentEngine, type EngineSink,
  type EngineTurnParams, type McpToolSource, type ResolvedModel, type RunnerTool } from "../src/index.js";
import type { ToolHookContext, ToolHookPostContext, ToolHookReport, ToolHookService } from "../src/hooks/types.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

// Real Host/Memory commits with an injected hook contract, not webhook/MySQL/socket proof.
const owner: Principal = { tenantId: "t_hooks", userId: "u_owner" };
const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 32_000,
  input: ["text"], apiKey: async () => "unused-fixture" };
const scope = "mcp_exact_hook_scope";
const result = (text = "canonical tool result") => ({ content: [{ type: "text" as const, text }] });
const builtin: RunnerTool = { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" },
  readOnly: true, execute: async () => result() };
const script: ScriptStep[] = [{ toolCalls: [{ name: "echo", args: { privateArgument: "not-for-hooks" } }] }, { text: "finished" }];
function report(phase: ToolHookReport["phase"], outcome: ToolHookReport["outcome"]): ToolHookReport {
  return { hookId: phase === "preToolUse" ? "pre" : "post", phase,
    kind: phase === "preToolUse" ? "deny-tools" : "observe-tool-result", outcome, configSha256: "c".repeat(64) };
}
class Hooks implements ToolHookService {
  enabled = true;
  digest = "a".repeat(64);
  allow = true;
  versions: Principal[] = [];
  pre: ToolHookContext[] = [];
  post: ToolHookPostContext[] = [];
  preWork?: (context: ToolHookContext, signal: AbortSignal) => Promise<void>;
  postWork?: (context: ToolHookPostContext, signal: AbortSignal) => Promise<void>;
  version(principal: Principal) {
    this.versions.push({ ...principal });
    return this.enabled && principal.tenantId === owner.tenantId && principal.userId === owner.userId ? this.digest : undefined;
  }
  async preToolUse(context: ToolHookContext, signal: AbortSignal) {
    this.pre.push(structuredClone(context)); await this.preWork?.(context, signal);
    return { allow: this.allow, reports: [report("preToolUse", this.allow ? "allowed" : "denied")] };
  }
  async postToolUse(context: ToolHookPostContext, signal: AbortSignal) {
    this.post.push(structuredClone(context)); await this.postWork?.(context, signal);
    return [report("postToolUse", context.isError ? "tool_error" : "tool_success")];
  }
  async close() {}
}
class Store extends MemorySessionStore {
  failPostReport = false;
  override async commit(batch: CommitBatch) {
    if (this.failPostReport && batch.events?.some(event => event.type === "hook/completed" && event.phase === "postToolUse")) {
      throw new Error("fixture report COMMIT failed");
    }
    return super.commit(batch);
  }
}
class DuplicateEngine implements AgentEngine {
  readonly name = "duplicate-callback-fixture";
  readonly delegate = new ScriptedEngine(script);
  outcomes: PromiseSettledResult<unknown>[] = [];
  constructor(private readonly conflict: boolean) {}
  start(params: EngineTurnParams, sink: EngineSink) {
    return this.delegate.start(params, { ...sink, afterToolCall: async value => {
      const first = sink.afterToolCall(value);
      const duplicate = this.conflict ? { ...value, content: [{ type: "text" as const, text: "different output" }] } : value;
      this.outcomes = await Promise.allSettled([first, sink.onToolResult(duplicate)]);
      const canonical = this.outcomes[0]!;
      if (canonical.status !== "fulfilled") throw canonical.reason;
      // A completed compatibility callback must also reuse the exact prior result, not resend.
      if (!this.conflict) await sink.onToolResult(value);
      return await first;
    } });
  }
}
class ReusedCallIdEngine implements AgentEngine {
  readonly name = "reused-call-id-fixture";
  readonly callId = "call_reused_across_steps";
  readonly delegate = new ScriptedEngine([
    { toolCalls: [{ name: "echo", args: { step: 1 } }] },
    { toolCalls: [{ name: "echo", args: { step: 2 } }] },
    { text: previous => `second canonical: ${previous[0]?.content.filter(part => part.type === "text").map(part => part.text).join("")}` },
  ]);
  readonly canonicalResults: Awaited<ReturnType<EngineSink["afterToolCall"]>>[] = [];
  start(params: EngineTurnParams, sink: EngineSink) {
    const message = (value: Parameters<EngineSink["onAssistantMessage"]>[0]) => ({ ...value,
      toolCalls: value.toolCalls.map(call => ({ ...call, id: this.callId })) });
    return this.delegate.start({ ...params, tools: params.tools.map(tool => ({ ...tool,
      execute: (args: unknown, context: Parameters<RunnerTool["execute"]>[1]) =>
        tool.execute(args, { ...context, toolCallId: this.callId }),
    })) }, { ...sink,
      onAssistantMessage: value => sink.onAssistantMessage(message(value)),
      beforeToolCall: (call, value) => sink.beforeToolCall({ ...call, id: this.callId }, message(value)),
      onToolExecutionStart: () => sink.onToolExecutionStart(this.callId),
      afterToolCall: async value => {
        const remapped = { ...value, toolCallId: this.callId };
        const canonical = await sink.afterToolCall(remapped);
        // Each actual call still has its own same-item compatibility callback.
        await sink.onToolResult(remapped);
        this.canonicalResults.push(canonical);
        return canonical;
      },
    });
  }
}
const fixtures: { host: SessionHost; bus: MemoryEventBus; lease: MemoryLeaseStore }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) { await fixture.host.drain(0); await fixture.bus.close(); await fixture.lease.close(); }
});
async function setup(options: { hooks?: Hooks | null; tools?: RunnerTool[]; engine?: AgentEngine; script?: ScriptStep[];
  mcp?: McpToolSource; policy?: AgentDefinition["approvalPolicy"]; runtime?: TenantRuntimeCoordinator; leaseTtlMs?: number } = {}) {
  const hooks = options.hooks === null ? undefined : options.hooks ?? new Hooks();
  const store = new Store(), bus = new MemoryEventBus(), lease = new MemoryLeaseStore();
  const engine = options.engine ?? new ScriptedEngine(options.script ?? script), tools = options.tools ?? [builtin];
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "hooks",
    instructions: "Use only the mounted tools.", model: { provider: "fake", model: "fake" }, tools: tools.map(tool => tool.name),
    mcpServers: options.mcp ? ["remote"] : [], skills: [], limits: {}, approvalPolicy: options.policy ?? "never",
    busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const host = new SessionHost({ store, bus, lease, engine, tools: new StaticToolRegistry(tools), hooks, mcp: options.mcp,
    providers: { resolve: async () => model }, tenantRuntime: options.runtime,
    config: { runnerId: "r_hooks", runnerAddr: "127.0.0.1:1", leaseTtlMs: options.leaseTtlMs ?? 2_000, leaseHoldMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} } });
  fixtures.push({ host, bus, lease }); return { host, store, bus, lease, engine, agent, hooks };
}
const request = { input: [{ type: "text" as const, text: "go" }], stream: true, metadata: {} };
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 2_000;
  while (Date.now() < until) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Hook fixture did not settle.");
}
async function finish(h: Awaited<ReturnType<typeof setup>>, sessionId: string, turnId: string) {
  return waitFor(async () => { const turn = await h.store.getTurn(sessionId, turnId); return turn && turn.status !== "inProgress" ? turn : undefined; });
}

describe("SessionHost bounded tool hooks", () => {
  it("uses the delegated actual owner, commits pre reports before start, and observes only a committed canonical result", async () => {
    const h = await setup(), hooks = h.hooks!;
    const caller = { ...owner, userId: "trusted-caller" };
    const session = await h.host.createSession(caller, { agentId: h.agent.id, userId: owner.userId, metadata: {} });
    let verifiedPreBoundary = false, verifiedPostBoundary = false;
    hooks.preWork = async context => {
      expect(context.owner).toEqual(owner);
      expect((await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "toolCall")).not.toHaveProperty("startedAtMs");
      expect(await h.store.listApprovals(session.id, {})).toEqual([]);
      verifiedPreBoundary = true;
    };
    hooks.postWork = async context => {
      const items = await h.store.listItems(session.id, { limit: 100 });
      expect(items.find(item => item.type === "toolCall")).toMatchObject({ status: "completed", startedAtMs: expect.any(Number) });
      expect(items.find(item => item.type === "toolResult")).toMatchObject({ isError: false, content: result().content });
      expect((await h.store.readEvents(session.id, 0, 100)).some(event => event.type === "item/completed" && event.item.type === "toolResult")).toBe(true);
      expect(context).toEqual({ owner, sessionId: session.id, turnId: expect.any(String), toolCallId: "call_1",
        tool: { name: "echo", kind: "builtin", readOnly: true }, isError: false });
      verifiedPostBoundary = true;
    };
    const turn = await h.host.startTurn(owner, session.id, request); expect(await finish(h, session.id, turn.turn.id)).toMatchObject({ status: "completed", steps: 2 });
    expect(hooks.versions.every(principal => JSON.stringify(principal) === JSON.stringify(owner))).toBe(true);
    expect(hooks.pre).toHaveLength(1); expect(hooks.post).toHaveLength(1);
    expect(verifiedPreBoundary).toBe(true); expect(verifiedPostBoundary).toBe(true);
    expect(JSON.stringify([...hooks.pre, ...hooks.post])).not.toContain("not-for-hooks");
    const events = await h.store.readEvents(session.id, 0, 100);
    expect(events.filter(event => event.type === "hook/completed").map(event => event.phase)).toEqual(["preToolUse", "postToolUse"]);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
  });

  it.each(["never", "untrusted"] as const)("denies before approval/start despite %s policy and never observes an unstarted result", async policy => {
    const execute = vi.fn(async () => result()), hooks = new Hooks(); hooks.allow = false;
    const h = await setup({ hooks, policy, tools: [{ ...builtin, readOnly: false, execute }] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, turn.turn.id);
    expect(execute).not.toHaveBeenCalled(); expect(hooks.pre).toHaveLength(1); expect(hooks.post).toEqual([]);
    expect(await h.store.listApprovals(session.id, {})).toEqual([]);
    const call = (await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "toolCall");
    expect(call).not.toHaveProperty("startedAtMs");
    expect((await h.store.readEvents(session.id, 0, 100)).filter(event => event.type === "hook/completed")).toEqual([
      expect.objectContaining({ phase: "preToolUse", outcome: "denied" }),
    ]);
  });

  it("does not bypass MCP mandatory approval and reruns pre policy before reusing an exact session grant", async () => {
    const execute = vi.fn(async () => result());
    const remote: RunnerTool = { ...builtin, kind: "mcp", mandatoryApproval: true, readOnly: false, approvalScope: scope, execute };
    const mcp: McpToolSource = { enabled: true, validateMounts: () => {}, resolve: async () => [remote], close: async () => {} };
    const h = await setup({ tools: [], mcp }), session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const first = await h.host.startTurn(owner, session.id, request);
    const approval = await waitFor(async () => (await h.store.listApprovals(session.id, { pendingOnly: true }))[0]);
    expect(execute).not.toHaveBeenCalled(); expect(h.hooks!.pre).toHaveLength(1);
    await h.host.resolveApproval(owner, session.id, approval.id, "acceptForSession"); await finish(h, session.id, first.turn.id);
    h.hooks!.allow = false;
    const denied = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, denied.turn.id);
    expect(execute).toHaveBeenCalledTimes(1); expect(await h.store.listApprovals(session.id, {})).toHaveLength(1);
    h.hooks!.allow = true;
    const reused = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, reused.turn.id);
    expect(execute).toHaveBeenCalledTimes(2); expect(h.hooks!.pre).toHaveLength(3); expect(h.hooks!.post).toHaveLength(2);
    expect(await h.store.listApprovals(session.id, {})).toHaveLength(1);
    expect((await h.store.getSession(owner.tenantId, session.id))?.autoApprovedTools).toEqual([scope]);
  });

  it("rejects unknown tools before hooks and never observes synthetic recovery results", async () => {
    const h = await setup({ script: [{ toolCalls: [{ name: "missing", args: {} }] }] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, turn.turn.id);
    expect(h.hooks!.pre).toEqual([]); expect(h.hooks!.post).toEqual([]);
  });

  it("checks the tool-call limit before another pre hook can run", async () => {
    const h = await setup({ script: [script[0]!, script[0]!] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, { ...request, limits: { maxToolCalls: 1 } });
    expect(await finish(h, session.id, turn.turn.id)).toMatchObject({ stopReason: "max_tool_calls" });
    expect(h.hooks!.pre).toHaveLength(1); expect(h.hooks!.post).toHaveLength(1);
  });

  it.each([false, true])("memos concurrent canonical/compatibility callbacks and rejects identity conflicts (conflict=%s)", async conflict => {
    const engine = new DuplicateEngine(conflict), h = await setup({ engine });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, turn.turn.id);
    expect(engine.outcomes[0]?.status).toBe("fulfilled");
    if (conflict) expect(engine.outcomes[1]).toMatchObject({ status: "rejected", reason: { code: "invalid_request", message: "Tool result identity conflict." } });
    else expect(engine.outcomes[1]?.status).toBe("fulfilled");
    expect(h.hooks!.post).toHaveLength(1);
    expect((await h.store.listItems(session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toHaveLength(1);
    expect((await h.store.readEvents(session.id, 0, 100)).filter(event => event.type === "hook/completed" && event.phase === "postToolUse")).toHaveLength(1);
  });

  it.each([false, true])("commits and observes both real calls when later steps reuse an external id (differentResult=%s)", async differentResult => {
    const engine = new ReusedCallIdEngine(), values = ["first result", differentResult ? "second result" : "first result"];
    const dispatchedIds: string[] = [];
    const execute = vi.fn(async (_args: unknown, context: Parameters<RunnerTool["execute"]>[1]) => {
      dispatchedIds.push(context.toolCallId);
      return result(values[dispatchedIds.length - 1]!);
    });
    const h = await setup({ engine, tools: [{ ...builtin, execute }] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request);
    expect(await finish(h, session.id, turn.turn.id)).toMatchObject({ status: "completed", stopReason: "end_turn",
      steps: 3, toolCalls: 2, usage: { inputTokens: 30, outputTokens: 15, totalTokens: 45, costCNY: 0 } });
    expect(execute).toHaveBeenCalledTimes(2); expect(dispatchedIds).toEqual([engine.callId, engine.callId]);
    expect(engine.delegate.startedSteps).toBe(3);
    expect(engine.canonicalResults.map(value => value.content)).toEqual(values.map(value => result(value).content));
    expect(h.hooks!.pre).toHaveLength(2); expect(h.hooks!.post).toHaveLength(2);
    expect(h.hooks!.post.map(context => [context.toolCallId, context.isError])).toEqual([[engine.callId, false], [engine.callId, false]]);
    const items = await h.store.listItems(session.id, { limit: 100 });
    const calls = items.filter(item => item.type === "toolCall").sort((a, b) => a.step! - b.step!);
    const results = items.filter(item => item.type === "toolResult").sort((a, b) => a.step! - b.step!);
    expect(calls).toHaveLength(2); expect(new Set(calls.map(call => call.id)).size).toBe(2);
    expect(calls).toMatchObject([1, 2].map(step => ({ step, toolCallId: engine.callId, name: "echo", status: "completed", startedAtMs: expect.any(Number) })));
    expect(results).toHaveLength(2); expect(new Set(results.map(value => value.id)).size).toBe(2);
    expect(results).toMatchObject(values.map((value, index) => ({ step: index + 1, toolCallId: engine.callId,
      name: "echo", status: "completed", isError: false, content: result(value).content })));
    expect(items.some(item => item.type === "agentMessage" && item.text === `second canonical: ${values[1]}`)).toBe(true);
    const events = await h.store.readEvents(session.id, 0, 100);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    expect((await h.store.getSession(owner.tenantId, session.id))?.lastSeq).toBe(events.length);
    expect(events.filter(event => event.type === "hook/completed").map(event => [event.phase, event.outcome])).toEqual([
      ["preToolUse", "allowed"], ["postToolUse", "tool_success"], ["preToolUse", "allowed"], ["postToolUse", "tool_success"],
    ]);
    for (const item of [...calls, ...results]) expect(events.filter(event => event.type === "item/completed" && event.item.id === item.id)).toHaveLength(1);
  });

  it("fails open only around the observer callback, preserving the durable result for step two", async () => {
    const h = await setup({ script: [script[0]!, { text: previous => previous[0]?.content.some(part => part.type === "text" && part.text === "canonical tool result") ? "observed canonical" : "wrong result" }] });
    h.hooks!.postWork = async () => { throw new Error("private callback canary"); };
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request);
    expect(await finish(h, session.id, turn.turn.id)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2 });
    expect(h.hooks!.post).toHaveLength(1);
    expect((await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "toolResult")).toMatchObject({ isError: false, content: result().content });
    expect((await h.store.listItems(session.id, { limit: 100 })).some(item => item.type === "agentMessage" && item.text === "observed canonical")).toBe(true);
    expect(JSON.stringify(await h.store.readEvents(session.id, 0, 100))).not.toContain("private callback canary");
  });

  it("does not swallow a durable observer-report COMMIT failure or execute another model step", async () => {
    const h = await setup(); h.store.failPostReport = true;
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    await h.host.startTurn(owner, session.id, request); await waitFor(() => !h.host.activeTurn(session.id) ? true : undefined);
    expect((h.engine as ScriptedEngine).startedSteps).toBe(1); expect(h.hooks!.post).toHaveLength(1);
    expect((await h.store.listItems(session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toHaveLength(1);
    expect((await h.store.readEvents(session.id, 0, 100)).some(event => event.type === "hook/completed" && event.phase === "postToolUse")).toBe(false);
  });

  it("rejects a late pre-hook allow after interrupt, before approval or execution-start can be written", async () => {
    const execute = vi.fn(async () => result()), h = await setup({ tools: [{ ...builtin, readOnly: false, execute }], policy: "untrusted" });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    let entered!: () => void; const checking = new Promise<void>(resolve => { entered = resolve; });
    h.hooks!.preWork = async (_context, signal) => new Promise<void>(resolve => {
      entered(); const abort = () => resolve(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    const turn = await h.host.startTurn(owner, session.id, request); await checking;
    await h.host.interrupt(owner, session.id, turn.turn.id); await waitFor(() => !h.host.activeTurn(session.id) ? true : undefined);
    expect(execute).not.toHaveBeenCalled(); expect(await h.store.listApprovals(session.id, {})).toEqual([]);
    expect(h.hooks!.pre).toHaveLength(1); expect(h.hooks!.post).toEqual([]);
    expect((await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "toolCall")).not.toHaveProperty("startedAtMs");
    expect((await h.store.readEvents(session.id, 0, 100)).some(event => event.type === "hook/completed")).toBe(false);
  });

  it.each(["interrupt", "lease", "tenant"] as const)("does not dispatch another model request or late report after %s closes an observer", async kind => {
    const runtime = kind === "tenant" ? new TenantRuntimeCoordinator() : undefined;
    const h = await setup({ runtime, leaseTtlMs: kind === "lease" ? 60 : 2_000 }); runtime?.sealParticipants();
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    let entered!: () => void, aborted = false;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    h.hooks!.postWork = async (_context, signal) => new Promise<void>(resolve => {
      entered(); const abort = () => { aborted = true; resolve(); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    if (kind === "lease") vi.spyOn(h.lease, "renew").mockResolvedValue(false);
    const turn = await h.host.startTurn(owner, session.id, request); await observing;
    if (kind === "interrupt") await h.host.interrupt(owner, session.id, turn.turn.id);
    if (kind === "tenant") await runtime!.drain({ requestId: "ter_hooks", tenantId: owner.tenantId, subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 1_000);
    await waitFor(() => !h.host.activeTurn(session.id) ? true : undefined);
    expect(aborted).toBe(true); expect((h.engine as ScriptedEngine).startedSteps).toBe(1); expect(h.hooks!.post).toHaveLength(1);
    const items = await h.store.listItems(session.id, { limit: 100 }); expect(items.filter(item => item.type === "toolResult")).toHaveLength(1);
    expect((await h.store.readEvents(session.id, 0, 100)).some(event => event.type === "hook/completed" && event.phase === "postToolUse")).toBe(false);
  });

  it("preserves old epoch encoding when absent/unmatched and announces applicable policy changes without exposing hashes", async () => {
    const absent = await setup({ hooks: null, script: [{ text: "plain" }] });
    const old = await absent.host.createSession(owner, { agentId: absent.agent.id, metadata: {} });
    const original = computeContextEpoch({ agentId: absent.agent.id, agentVersion: 1, systemPrompt: absent.agent.instructions, tools: [builtin], skills: [] });
    expect(old.contextEpoch).toBe(original);
    expect(computeContextEpoch({ agentId: absent.agent.id, agentVersion: 1, systemPrompt: absent.agent.instructions, tools: [builtin], skills: [], hooksSha256: undefined })).toBe(original);
    const hooks = new Hooks(), h = await setup({ hooks, script: [{ text: "plain" }] });
    const other = await h.host.createSession({ ...owner, userId: "other" }, { agentId: h.agent.id, metadata: {} });
    expect(other.contextEpoch).toBe(computeContextEpoch({ agentId: h.agent.id, agentVersion: 1, systemPrompt: h.agent.instructions, tools: [builtin], skills: [] }));
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} }); hooks.digest = "b".repeat(64);
    const turn = await h.host.startTurn(owner, session.id, request); await finish(h, session.id, turn.turn.id);
    expect((await h.store.getSession(owner.tenantId, session.id))?.contextEpoch).not.toBe(session.contextEpoch);
    const warnings = (await h.store.readEvents(session.id, 0, 100)).filter(event => event.type === "warning");
    expect(warnings).toEqual([expect.objectContaining({ code: "hook_policy_changed" })]);
    expect(JSON.stringify(warnings)).not.toContain(hooks.digest); expect(hooks.pre).toEqual([]); expect(hooks.post).toEqual([]);
  });
});
