import { memoryAuthorityStore, MemoryAuthorityFixture } from "./session-authority-fixture.js";
import { randomUUID } from "node:crypto";
import { captureSessionAcquireCommand } from "../../store/src/session-authority.js";
import { acquireSessionAuthority } from "../src/session/authority.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type JsonObject, type Model, type Models } from "@earendil-works/pi-ai";
import { LifecycleHookPhase, isPersistedEvent, type AgentDefinition, type PersistedEvent, type Principal, type SubagentPolicy } from "@agent-service/protocol";
import { MemorySessionStore, MemoryEventBus, attachSessionWriteAdmission, createSubagentRootAccess, type CreateSubagentTaskInput } from "@agent-service/store";
import { SessionHost } from "../src/session/host.js";
import { PiEngine } from "../src/engine/pi.js";
import type { ResolvedModel } from "../src/engine/types.js";
import { StaticToolRegistry, type RunnerTool } from "../src/tools/types.js";
import { ConfiguredLifecycleHookService } from "../src/hooks/lifecycle.js";
import { newId } from "../src/ids.js";

// Actual Pi -> Host -> Memory atomic task/budget adapters. This is not MySQL/Redis/HTTP proof.
const principal: Principal = { tenantId: "task-host", userId: "owner" };
const prompt = "only explicit task background";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
type Call = { name: string; args: JsonObject };
class ModelsFixture {
  requests: { model: string; context: Context }[] = [];
  constructor(readonly respond: (model: string, first: boolean) => Call | string) {}
  streamSimple(model: Model<"openai-completions">, context: Context) {
    this.requests.push({ model: model.id, context: structuredClone(context) });
    const answer = this.respond(model.id, !context.messages.some(message => message.role === "assistant"));
    const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: "openai-completions",
      content: typeof answer === "string" ? [{ type: "text", text: answer }] : [{ type: "toolCall", id: "provider-call", name: answer.name, arguments: answer.args }],
      stopReason: typeof answer === "string" ? "stop" : "toolUse", timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream(); queueMicrotask(() => {
      stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
    }); return stream;
  }
}
class Store extends MemorySessionStore {
  failCreate = false;
  override async createSubagentTask(input: CreateSubagentTaskInput) {
    if (this.failCreate) throw new Error("fixture task reservation failed");
    return super.createSubagentTask(input);
  }
}
function model(id: string): ResolvedModel {
  return { provider: "resolved-task-provider", model: id, contextWindow: 32000, input: ["text"], priceKnown: true, apiKey: async () => "fixture-key",
    handle: { id, name: id, provider: "resolved-task-provider", api: "openai-completions", baseUrl: "http://unused.invalid", input: ["text"], reasoning: false,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 8192 } };
}
async function setup(options: { enabled?: boolean; childApproval?: AgentDefinition["approvalPolicy"]; dynamic?: boolean;
  nested?: boolean; target?: string; echo?: RunnerTool["execute"]; maxSteps?: number } = {}) {
  const store = memoryAuthorityStore(Store), bus = new MemoryEventBus(), lease = new MemoryAuthorityFixture().bind(store);
  const echoCalls: unknown[] = [];
  const echo: RunnerTool = { name: "echo", kind: "builtin", readOnly: false, description: "echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: options.echo ?? (async args => { echoCalls.push(args); return { content: [{ type: "text", text: "child result" }] }; }) };
  const base = { tenantId: principal.tenantId, version: 1, mcpServers: [], skills: [], limits: {}, approvalPolicy: "never" as const,
    busyPolicy: "reject" as const, sandbox: "none" as const, metadata: {}, createdAtMs: Date.now() };
  const grand: AgentDefinition = { ...base, id: newId("agt"), name: "grand", instructions: "grand instructions", model: { provider: "task-provider", model: "grand-model" }, tools: ["echo"] };
  const child: AgentDefinition = { ...base, id: newId("agt"), name: "child", instructions: "child instructions", model: { provider: "task-provider", model: "child-model" },
    tools: options.dynamic ? ["client_echo"] : options.nested ? ["task", "echo"] : ["echo"], approvalPolicy: options.childApproval ?? "never",
    ...(options.nested ? { subagents: { allowSelf: false, targets: [{ name: "grand", agentId: grand.id, agentVersion: 1 }],
      maxDepth: 3, maxConcurrent: 2, maxTasks: 8, limits: {}, context: "prompt" } satisfies SubagentPolicy } : {}) };
  const rootPolicy: SubagentPolicy = { allowSelf: false, targets: [{ name: "worker", agentId: child.id, agentVersion: 1 },
    ...(options.nested ? [{ name: "grand", agentId: grand.id, agentVersion: 1 }] : [])], maxDepth: 3, maxConcurrent: 2, maxTasks: 8, limits: {}, context: "prompt" };
  const rootAgent: AgentDefinition = { ...base, id: newId("agt"), name: "root", instructions: "root private instructions", model: { provider: "task-provider", model: "root-model" },
    tools: options.dynamic ? ["task", "client_echo"] : ["task", "echo"], subagents: rootPolicy,
    ...(options.maxSteps ? { limits: { maxSteps: options.maxSteps } } : {}) };
  await Promise.all([store.createAgent(rootAgent), store.createAgent(child), store.createAgent(grand)]);
  const models = new ModelsFixture((name, first): Call | string => {
    if (!first) return `${name} finished`;
    if (name === "root-model") return { name: "task", args: { target: options.target ?? "worker", prompt } };
    if (options.nested && name === "child-model") return { name: "task", args: { target: "grand", prompt: "grand explicit prompt" } };
    return { name: options.dynamic ? "client_echo" : "echo", args: { value: "child input" } };
  });
  const hooks = new ConfiguredLifecycleHookService({ packages: [{ id: "audit", package: "audit", subjects: [principal], phases: [...LifecycleHookPhase.options] }] });
  const createHost = (runnerId: string) => new SessionHost({ store, lease: lease.authority, bus, engine: new PiEngine(models as unknown as Models), tools: new StaticToolRegistry([echo]),
    providers: { resolve: async (_owner, ref) => model(ref.model) }, lifecycleHooks: hooks,
    authorizeRuntimeExtensions: async signal => { signal.throwIfAborted(); },
    subagents: { enabled: options.enabled ?? true, maxDepth: 3, maxConcurrent: 2, maxTasks: 8 },
    config: { runnerId, runnerAddr: "127.0.0.1:1", leaseTtlMs: 2000, leaseHoldMs: 1 }, logger: { info() {}, warn() {}, error() {} } });
  const host = createHost("task-runner");
  cleanups.push(async () => { await host.drain(2000); await hooks.close(); await Promise.all([lease.close(), bus.close()]); });
  return { host, createHost, store, lease, bus, hooks, models, rootAgent, child, grand, echoCalls };
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 3000;
  while (Date.now() < until) { const value = await read(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Task fixture did not settle.");
}
async function start(f: Awaited<ReturnType<typeof setup>>, dynamic = false) {
  const session = await f.host.createSession(principal, { agentId: f.rootAgent.id, metadata: {} });
  const begun = await f.host.beginTurn(principal, session.id, { input: [{ type: "text", text: "parent private input not inherited" }], stream: true, metadata: {},
    ...(dynamic ? { dynamicTools: [{ name: "client_echo", description: "client echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] } : {}) });
  begun.run(); return { session, begun };
}
async function done(f: Awaited<ReturnType<typeof setup>>, sessionId: string, turnId: string) {
  await waitFor(async () => (await f.store.readEvents(sessionId, 0, 1000)).some(event => event.type === "lifecycle-hook/completed" && event.phase === "Stop" && event.turnId === turnId) ? true : undefined);
  return f.store.getTurn(sessionId, turnId);
}

/** A new explicit owner is needed for this protected internal post-turn family inspection. */
async function inspectCompletedFamily(f: Awaited<ReturnType<typeof setup>>, sessionId: string, turnId: string, predecessorFence: number) {
  // Stop/join the actual old Host owner before a new fixed command can acquire its successor.
  await f.host.settle();
  const acquired = await acquireSessionAuthority(f.store.sessionAuthority, {
    sessionId, principal, runnerId: "task-family-inspection", runnerAddr: "127.0.0.1:1", bootId: randomUUID(),
    expectedFence: predecessorFence, ttlMs: 2000,
  });
  if (!acquired.ok) throw new Error("fixture_completed_family_authority_conflict");
  let bodyFailed = false;
  try {
    const access = attachSessionWriteAdmission(createSubagentRootAccess({ principal, rootSessionId: sessionId,
      rootTurnId: turnId, rootFence: acquired.fence }), acquired.proof);
    return await f.store.getSubagentRoot({ access });
  } catch (error) { bodyFailed = true; throw error; }
  finally {
    try { await f.store.sessionAuthority.release(acquired.proof); }
    catch (error) { if (!bodyFailed) throw error; }
  }
}

describe("Host root-lease real task coordinator", () => {
  it("atomically reserves real child first input/activity, runs Pi and charges actual member usage once", async () => {
    const f = await setup(), acquire = vi.spyOn(f.lease, "acquire"), { session, begun } = await start(f);
    const predecessorFence = begun.session.fenceToken;
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    const tasks = await f.host.listDelegatedTasks(principal, session.id, begun.turn.id); expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "completed", depth: 1, childUsage: { totalTokens: 6 } });
    expect(acquire.mock.calls.every(([command]) => typeof command !== "string"
      && captureSessionAcquireCommand(command).sessionId === session.id)).toBe(true);
    const task = tasks[0]!, childItems = await f.store.listItems(task.childSessionId, { afterSeq: 0, limit: 1000 });
    expect(childItems.filter(item => item.type === "userMessage").map(item => item.content)).toEqual([[{ type: "text", text: prompt }]]);
    expect(f.models.requests.filter(request => request.model === "child-model").every(request => !JSON.stringify(request.context).includes("parent private input not inherited") && !JSON.stringify(request.context).includes("root private instructions"))).toBe(true);
    expect(f.echoCalls).toHaveLength(1);
    const childEvents = await f.store.readEvents(task.childSessionId, 0, 1000), rootEvents = await f.store.readEvents(session.id, 0, 1000);
    expect(childEvents[0]?.type).toBe("session/created"); expect(childEvents[0]?.seq).toBe(1);
    expect(childEvents.find(event => event.type === "turn/started")?.seq).toBe(2);
    expect(childEvents.some(event => event.type === "lifecycle-hook/completed" && event.phase === "SessionStart")).toBe(true);
    expect(rootEvents.flatMap(event => event.type === "lifecycle-hook/completed" && (event.phase === "SubagentStart" || event.phase === "SubagentStop") ? [event.phase] : [])).toEqual(["SubagentStart", "SubagentStop"]);
    const stored = await f.store.getSession(principal.tenantId, session.id);
    if (!stored || stored.fenceToken !== predecessorFence) throw new Error("fixture_completed_family_predecessor_changed");
    const family = await inspectCompletedFamily(f, session.id, begun.turn.id, predecessorFence);
    expect(family).toMatchObject({ state: "terminal", steps: 4, familyUsage: { totalTokens: 12 } });
    expect(family?.authority.model.provider).toBe("task-provider");
    expect(family?.initialResolvedModel.provider).toBe("resolved-task-provider");
    expect((await f.store.getTurn(session.id, begun.turn.id))?.usage.totalTokens).toBe(6);
    expect((await f.store.getTurn(session.id, begun.turn.id))?.model?.provider).toBe("resolved-task-provider");
    expect(childEvents.map(event => event.seq)).toEqual(childEvents.map((_, index) => index + 1));
    expect(rootEvents.map(event => event.seq)).toEqual(rootEvents.map((_, index) => index + 1));
  });

  it("enforces stronger child approval through root controls and rejects all ordinary child writes", async () => {
    const f = await setup({ childApproval: "untrusted" }), { session, begun } = await start(f);
    const task = await waitFor(async () => (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]);
    const approval = await waitFor(async () => (await f.store.listApprovals(task.childSessionId, { pendingOnly: true }))[0]);
    expect(f.echoCalls).toEqual([]);
    const other = { ...principal, userId: "other" };
    await expect(f.host.getDelegatedTask(other, session.id, task.taskId)).rejects.toMatchObject({ code: "not_found" });
    for (const operation of [
      () => f.host.beginTurn(principal, task.childSessionId, { input: [{ type: "text", text: "bypass" }], stream: false, metadata: {} }),
      () => f.host.steer(principal, task.childSessionId, task.childTurnId!, { input: [{ type: "text", text: "bypass" }] }),
      () => f.host.resolveApproval(principal, task.childSessionId, approval.id, "acceptForSession"),
      () => f.host.interrupt(principal, task.childSessionId, task.childTurnId!), () => f.host.archiveSession(principal, task.childSessionId),
      () => f.host.unarchiveSession(principal, task.childSessionId), () => f.host.deleteSession(principal, task.childSessionId),
      () => f.host.compactSession(principal, task.childSessionId),
      () => f.host.uploadInputBlob(principal, task.childSessionId, Buffer.from([]), "image/png"),
    ]) await expect(operation()).rejects.toMatchObject({ code: "not_found" });
    await f.host.resolveDelegatedApproval(principal, session.id, task.taskId, approval.id, "accept");
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed"); expect(f.echoCalls).toHaveLength(1);
    expect((await f.store.getSession(principal.tenantId, task.childSessionId))?.autoApprovedTools).toEqual([]);
    await expect(f.host.deleteSession(principal, session.id)).rejects.toMatchObject({ code: "session_has_children" });
    await f.host.deleteDelegatedSession(principal, session.id, task.taskId);
    expect((await f.store.getSessionLifecycle(principal.tenantId, principal.userId, task.childSessionId))?.deletedAtMs).toBeTypeOf("number");
  });

  it("uses only target-explicit named dynamic contracts and accepts their results through root task addressing", async () => {
    const f = await setup({ dynamic: true }), { session, begun } = await start(f, true);
    const task = await waitFor(async () => (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]);
    const call = await waitFor(async () => (await f.store.listItems(task.childSessionId, { afterSeq: 0, limit: 1000 })).find(item => item.type === "toolCall" && item.kind === "dynamic" && item.startedAtMs !== undefined));
    if (call.type !== "toolCall") throw new Error("Expected real child call.");
    expect(f.host.submitDynamicToolResult(task.childSessionId, call.toolCallId, { content: [{ type: "text", text: "bypass" }], isError: false })).toBe(false);
    await f.host.submitDelegatedToolResult(principal, session.id, task.taskId, call.toolCallId, { content: [{ type: "text", text: "client canonical" }] });
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    const next = f.models.requests.filter(request => request.model === "child-model")[1];
    expect(next?.context.messages.some(message => message.role === "toolResult" && JSON.stringify(message.content).includes("client canonical"))).toBe(true);
  });

  it("closes the actual child I/O on root interruption and waits before declaring terminal", async () => {
    const entered = barrier(), release = barrier(); let aborted = false, settled = false;
    const f = await setup({ echo: async (_args, context) => { entered.resolve(); context.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await release.promise; settled = true; return { content: [{ type: "text", text: "settled" }] }; } });
    const { session, begun } = await start(f); await entered.promise;
    let returned = false; const interrupted = f.host.interrupt(principal, session.id, begun.turn.id).then(value => { returned = true; return value; });
    await waitFor(() => aborted ? true : undefined); expect(returned).toBe(false); expect(settled).toBe(false);
    release.resolve(); expect((await interrupted).status).toBe("interrupted"); expect(settled).toBe(true);
    const tasks = await f.host.listDelegatedTasks(principal, session.id, begun.turn.id); expect(tasks[0]?.status).toBe("interrupted");
    expect(f.models.requests.filter(request => request.model === "child-model")).toHaveLength(1);
    expect((await f.store.readEvents(tasks[0]!.childSessionId, 0, 1000)).filter(event => event.type === "usage/updated")).toHaveLength(1);
    expect((await f.store.readEvents(session.id, 0, 1000)).filter(event => event.type === "usage/updated")).toHaveLength(1);
    expect((await f.store.getTurn(tasks[0]!.childSessionId, tasks[0]!.childTurnId!))?.usage.totalTokens).toBe(3);
  });

  it("interrupts only the addressed child and settles its real I/O before the root continues", async () => {
    const entered = barrier(), release = barrier(); let aborted = false;
    const f = await setup({ echo: async (_args, context) => {
      entered.resolve(); context.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      await release.promise; return { content: [{ type: "text", text: "settled child" }] };
    } });
    const { session, begun } = await start(f); await entered.promise;
    const task = (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]!;
    let returned = false;
    const interrupted = f.host.interruptDelegatedTask(principal, session.id, task.taskId).then(turn => { returned = true; return turn; });
    await waitFor(() => aborted ? true : undefined); expect(returned).toBe(false);
    release.resolve(); expect((await interrupted).status).toBe("interrupted");
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    expect((await f.host.getDelegatedTask(principal, session.id, task.taskId)).status).toBe("interrupted");
    expect(f.models.requests.filter(request => request.model === "child-model")).toHaveLength(1);
    expect(f.models.requests.filter(request => request.model === "root-model")).toHaveLength(2);
    expect((await f.store.readEvents(task.childSessionId, 0, 1000)).filter(event => event.type === "usage/updated")).toHaveLength(1);
    expect((await f.store.getTurn(task.childSessionId, task.childTurnId!))?.usage.totalTokens).toBe(3);
  });

  it("returns a conflict rather than an in-progress success when bounded child cancellation has not settled", async () => {
    const entered = barrier(), cancelled = barrier(), release = barrier(); let settled = false;
    const f = await setup({ echo: async (_args, context) => {
      entered.resolve(); context.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      await release.promise; settled = true; return { content: [{ type: "text", text: "settled child" }] };
    } });
    const { session, begun } = await start(f); await entered.promise;
    const task = (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]!;
    const leaseRelease = vi.spyOn(f.lease, "release");
    // Only advance the existing control-response timer. Real I/O, the held barrier and the
    // previously started lease are not replaced, and the production 10s bound is unchanged.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rejection = expect(f.host.interruptDelegatedTask(principal, session.id, task.taskId)).rejects.toMatchObject({ code: "session_busy" });
      await cancelled.promise; await vi.advanceTimersByTimeAsync(10_000); await rejection;
      expect(settled).toBe(false); expect(leaseRelease).not.toHaveBeenCalled();
      expect((await f.store.getTurn(task.childSessionId, task.childTurnId!))?.status).toBe("inProgress");
    } finally { vi.useRealTimers(); release.resolve(); }
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    expect((await f.host.getDelegatedTask(principal, session.id, task.taskId)).status).toBe("interrupted");
    expect(settled).toBe(true);
  });

  it("never dispatches child work or claims SubagentStart after a failed atomic reservation", async () => {
    const f = await setup(); f.store.failCreate = true; const { session, begun } = await start(f);
    await waitFor(() => f.models.requests.length === 1 ? true : undefined); await f.host.drain(2000);
    expect(f.models.requests.map(request => request.model)).toEqual(["root-model"]); expect(f.echoCalls).toEqual([]);
    expect(await f.store.listSubagentTasks({ principal, rootSessionId: session.id, rootTurnId: begun.turn.id })).toEqual([]);
    expect((await f.store.readEvents(session.id, 0, 1000)).some(event => event.type === "lifecycle-hook/completed" && event.phase === "SubagentStart")).toBe(false);
  });

  it("enforces the one shared provider budget for root and child without a second family bill", async () => {
    const f = await setup({ maxSteps: 2 }), { session, begun } = await start(f);
    const predecessorFence = begun.session.fenceToken;
    expect((await done(f, session.id, begun.turn.id))?.stopReason).toBe("max_steps");
    expect(f.models.requests.map(request => request.model)).toEqual(["root-model", "child-model"]);
    const stored = await f.store.getSession(principal.tenantId, session.id);
    if (!stored || stored.fenceToken !== predecessorFence) throw new Error("fixture_completed_family_predecessor_changed");
    const family = await inspectCompletedFamily(f, session.id, begun.turn.id, predecessorFence);
    expect(family?.familyUsage.totalTokens).toBe(6); expect(family?.steps).toBe(2);
    expect((await f.store.getTurn(session.id, begun.turn.id))?.usage.totalTokens).toBe(3);
    const task = (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]!;
    expect((await f.store.readEvents(task.childSessionId, 0, 1000)).flatMap(event => event.type === "usage/updated" ? [event.step] : [])).toEqual([1]);
  });

  it("executes an explicitly allowed nested task and keeps each activity in its actual parent's seq space", async () => {
    const f = await setup({ nested: true }), { session, begun } = await start(f);
    const parentTask = await waitFor(async () => (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id)).find(task => task.depth === 1));
    const approval = await waitFor(async () => (await f.store.listApprovals(parentTask.childSessionId, { pendingOnly: true }))[0]);
    await f.host.resolveDelegatedApproval(principal, session.id, parentTask.taskId, approval.id, "accept");
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    const tasks = await f.host.listDelegatedTasks(principal, session.id, begun.turn.id); expect(tasks.map(task => task.depth).sort()).toEqual([1, 2]);
    expect(tasks.every(task => task.status === "completed")).toBe(true);
    const rootItems = await f.store.listItems(session.id, { afterSeq: 0, limit: 1000 });
    expect(rootItems.filter(item => item.type === "subagentActivity")).toHaveLength(1);
    const first = tasks.find(task => task.depth === 1)!;
    expect((await f.store.listItems(first.childSessionId, { afterSeq: 0, limit: 1000 })).filter(item => item.type === "subagentActivity")).toHaveLength(1);
    expect(f.echoCalls).toHaveLength(1);
  });

  it("publishes the exact canonical child and parent repair deltas after a higher-fence Memory takeover", async () => {
    const entered = barrier(), release = barrier(); let calls = 0;
    const f = await setup({ echo: async () => {
      calls++; entered.resolve(); await release.promise; return { content: [{ type: "text", text: "old execution settled" }] };
    } });
    const { session, begun } = await start(f); await entered.promise;
    const task = (await f.host.listDelegatedTasks(principal, session.id, begun.turn.id))[0]!;
    const rootBefore = (await f.store.getSession(principal.tenantId, session.id))!.lastSeq;
    const childBefore = (await f.store.getSession(principal.tenantId, task.childSessionId))!.lastSeq;
    const rootLive: PersistedEvent[] = [], childLive: PersistedEvent[] = [];
    // Raw bus listeners deliberately do not backfill gaps from Store, so this observes Host's
    // actual repair publication, not subscribe()'s separate durable recovery behavior.
    const rootUnsubscribe = await f.bus.subscribe(session.id, event => { if (isPersistedEvent(event)) rootLive.push(event); });
    const childUnsubscribe = await f.bus.subscribe(task.childSessionId, event => { if (isPersistedEvent(event)) childLive.push(event); });
    const survivor = f.createHost("task-survivor"); cleanups.push(async () => { await survivor.drain(2000); });
    try {
      await f.lease.expire(session.id);
      const next = await survivor.beginTurn(principal, session.id, { input: [{ type: "text", text: "new root turn" }], stream: true, metadata: {} });
      expect(next.turn.id).not.toBe(begun.turn.id); // remain reserved: no replacement task dispatch
      expect((await f.store.getTurn(task.childSessionId, task.childTurnId!))?.status).toBe("interrupted");
      expect((await survivor.getDelegatedTask(principal, session.id, task.taskId)).status).toBe("outcome_unknown");
      const childDurable = await f.store.readEvents(task.childSessionId, childBefore, 1000);
      const rootDurable = await f.store.readEvents(session.id, rootBefore, 1000);
      expect(childLive).toEqual(childDurable); expect(rootLive).toEqual(rootDurable);
      expect(childLive.some(event => event.type === "turn/completed" && event.turn.id === task.childTurnId)).toBe(true);
      expect(rootLive.some(event => event.type === "item/completed" && event.item.type === "subagentActivity" && event.item.taskId === task.taskId && event.item.taskStatus === "outcome_unknown")).toBe(true);
      expect(childLive.map(event => event.seq)).toEqual(childLive.map((_, index) => childBefore + index + 1));
      expect(rootLive.map(event => event.seq)).toEqual(rootLive.map((_, index) => rootBefore + index + 1));
      expect(calls).toBe(1);
    } finally { rootUnsubscribe(); childUnsubscribe(); release.resolve(); }
  });

  it("does not turn an unknown target into a model/agent selector or create an unauthorized child", async () => {
    const f = await setup({ target: "unconfigured" }), { session, begun } = await start(f);
    expect((await done(f, session.id, begun.turn.id))?.status).toBe("completed");
    expect(await f.host.listDelegatedTasks(principal, session.id, begun.turn.id)).toEqual([]);
    expect(f.models.requests.every(request => request.model === "root-model")).toBe(true);
    const disabled = await setup({ enabled: false });
    await expect(disabled.host.createSession(principal, { agentId: disabled.rootAgent.id, metadata: {} })).rejects.toMatchObject({ code: "draining" });
  });
});
