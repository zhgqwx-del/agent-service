import { memoryAuthorityStore, MemoryAuthorityFixture } from "./session-authority-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { emptyUsage, type AgentDefinition, type Event, type McpToolProgress, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore, type CommitBatch,
  type McpProgressEvent, type McpProgressPublisher } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, TenantRuntimeCoordinator, newId,
  type AgentEngine, type AssistantStepResult, type EngineSink, type EngineTurnParams,
  type McpToolSource, type ResolvedModel, type RunnerTool, type ToolExecutionContext } from "../src/index.js";

// Real Host/Memory boundaries with a local engine/source double, not a remote protocol proof.
const owner: Principal = { tenantId: "progress-tenant", userId: "alice" };
const TOOL = "mcp__fixture__progress";
const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 32_000,
  input: ["text"], apiKey: async () => undefined };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Progress fixture did not reach its bounded stage.");
}
class Store extends MemorySessionStore {
  startedGate?: ReturnType<typeof deferred>;
  rejectStarted = false;
  startedEntered = deferred();
  sessionReadGate?: { tenantId: string; sessionId: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  override async getSession(tenantId: string, sessionId: string) {
    const gate = this.sessionReadGate;
    if (gate?.tenantId === tenantId && gate.sessionId === sessionId) {
      this.sessionReadGate = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return super.getSession(tenantId, sessionId);
  }
  override async commit(batch: CommitBatch) {
    if (batch.items?.some(item => item.type === "toolCall" && item.startedAtMs !== undefined)) {
      this.startedEntered.resolve();
      if (this.rejectStarted) throw new Error("Fixture rejected the started commit.");
      await this.startedGate?.promise;
    }
    return super.commit(batch);
  }
}
class Bus extends MemoryEventBus {
  readonly published: Event[] = [];
  progressGate?: ReturnType<typeof deferred>;
  progressCloseGate?: ReturnType<typeof deferred>;
  progressDelayMs = 0;
  progressEntered = deferred();
  progressCancelled = deferred();
  progressCloseAcknowledged = deferred();
  progressDispatches = 0;
  legacyProgressCalls = 0;
  failProgress = false;
  override async publish(sessionId: string, event: Event) {
    if (event.type === "item/mcpToolCall/progress") {
      this.legacyProgressCalls++;
      throw new Error("The unbounded legacy progress path must not be used.");
    }
    this.published.push(structuredClone(event));
    return super.publish(sessionId, event);
  }
  override openMcpProgressPublisher(sessionId: string, options: { signal: AbortSignal; timeoutMs: number }): McpProgressPublisher {
    const actual = super.openMcpProgressPublisher(sessionId, options);
    const abort = new AbortController(), pending = new Set<Promise<void>>();
    let closed = false, closing: Promise<void> | undefined;
    const cancel = () => { closed = true; abort.abort(); this.progressCancelled.resolve(); };
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    return {
      publish: (event: McpProgressEvent) => {
        if (closed) return Promise.reject(new Error("Fixture observer is closed."));
        const work = (async () => {
          this.progressDispatches++; this.progressEntered.resolve();
          const timeout = setTimeout(cancel, options.timeoutMs);
          try {
            // A cancellable owned I/O double: cancellation wakes the request, but its actual
            // settlement may still wait on a separate close acknowledgement. Host must own both.
            await new Promise<void>(resolve => {
              let settled = false;
              let delay: ReturnType<typeof setTimeout> | undefined;
              const done = () => {
                if (settled) return;
                settled = true; clearTimeout(delay); abort.signal.removeEventListener("abort", done); resolve();
              };
              abort.signal.addEventListener("abort", done, { once: true });
              if (abort.signal.aborted) done();
              else if (this.progressGate) void this.progressGate.promise.then(done);
              else delay = setTimeout(done, this.progressDelayMs);
            });
            if (abort.signal.aborted) {
              await this.progressCloseGate?.promise;
              throw new Error("Fixture observer cancellation settled.");
            }
            if (this.failProgress) throw new Error("Fixture live observation failed.");
            await actual.publish(event);
            this.published.push(structuredClone(event));
          } finally { clearTimeout(timeout); }
        })();
        pending.add(work);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        return work;
      },
      close: () => {
        cancel();
        closing ??= (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          await actual.close(); options.signal.removeEventListener("abort", cancel);
          this.progressCloseAcknowledged.resolve();
        })();
        return closing;
      },
    };
  }
}
class Engine implements AgentEngine {
  readonly name = "progress-fixture";
  sink?: EngineSink;
  failure?: unknown;
  constructor(private readonly work: (params: EngineTurnParams, sink: EngineSink) => Promise<void>) {}
  start(params: EngineTurnParams, sink: EngineSink) {
    this.sink = sink;
    return { steer() {}, interrupt() {}, done: this.work(params, sink).then(
      () => ({ steps: 2, aborted: params.signal.aborted }),
      error => { this.failure = error; return { steps: 1, aborted: params.signal.aborted, error: "provider_error" as const }; },
    ) };
  }
}
async function call(params: EngineTurnParams, sink: EngineSink, step = 1, id = "reusable-call") {
  await sink.onStepStart(step);
  const invocation = { id, name: TOOL, args: {} };
  const message: AssistantStepResult = { text: "", toolCalls: [invocation], usage: { ...emptyUsage(), costCNY: 0 },
    stopReason: "toolUse", provider: "fake", model: "fake" };
  await sink.onAssistantMessage(message);
  const allowed = await sink.beforeToolCall(invocation, message);
  if (!allowed.allow) return;
  const tool = params.tools.find(value => value.name === TOOL)!;
  const reporter = sink.createMcpProgressReporter?.(id, TOOL, params.signal);
  const result = await tool.execute({}, { ...params.toolContext, toolCallId: id, signal: params.signal,
    ...(reporter ? { onMcpProgress: reporter } : {}) });
  await sink.afterToolCall({ toolCallId: id, name: TOOL, content: result.content,
    isError: result.isError === true, details: result.details });
}
const fixtures: Array<{ host: SessionHost; bus: Bus; lease: MemoryAuthorityFixture; store: Store }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.startedGate?.resolve(); fixture.bus.progressGate?.resolve(); fixture.bus.progressCloseGate?.resolve();
    await fixture.host.drain(1_000);
    await fixture.bus.close(); await fixture.lease.close(); await fixture.store.close();
  }
});
async function setup(execute: RunnerTool["execute"], work: (params: EngineTurnParams, sink: EngineSink) => Promise<void> = call) {
  const store = memoryAuthorityStore(Store), bus = new Bus(), lease = new MemoryAuthorityFixture().bind(store), runtime = new TenantRuntimeCoordinator();
  const tool: RunnerTool = { name: TOOL, description: "untrusted fixture", kind: "mcp", parameters: { type: "object" },
    readOnly: false, mandatoryApproval: true, approvalScope: "mcp_progress_fixture", execute };
  const source: McpToolSource = { enabled: true, validateMounts() {}, resolve: async () => [tool], close: async () => {} };
  const engine = new Engine(work);
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "progress",
    instructions: "", model: { provider: "fake", model: "fake" }, tools: [], mcpServers: ["fixture"], skills: [],
    limits: {}, approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const host = new SessionHost({ store, bus, lease: lease.authority, engine, mcp: source, tools: new StaticToolRegistry(), tenantRuntime: runtime,
    providers: { resolve: async () => model }, config: { runnerId: "progress-runner", runnerAddr: "127.0.0.1:4010",
      leaseTtlMs: 2_000, leaseHoldMs: 1, approvalTtlMs: 2_000 }, logger: { info() {}, warn() {}, error() {} } });
  const session = await host.createSession(owner, { agentId: agent.id, metadata: {} });
  runtime.sealParticipants(); fixtures.push({ host, bus, lease, store });
  return { host, bus, lease, store, runtime, engine, session };
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function start(h: Harness) {
  const begun = await h.host.beginTurn(owner, h.session.id, { input: [{ type: "text", text: "observe" }], stream: true, metadata: {} });
  begun.run(); return begun;
}
async function approve(h: Harness) {
  const approval = await waitFor(async () => (await h.store.listApprovals(h.session.id, { pendingOnly: true }))[0]);
  await h.host.resolveApproval(owner, h.session.id, approval.id, "accept");
}
async function finished(h: Harness, turnId: string) {
  await waitFor(async () => {
    const turn = await h.store.getTurn(h.session.id, turnId);
    return turn && turn.status !== "inProgress" && !h.host.activeTurn(h.session.id) ? turn : undefined;
  });
  expect(h.engine.failure).toBeUndefined();
}
const result = () => ({ content: [{ type: "text" as const, text: "canonical tool result" }] });
const progress = (h: Harness) => h.bus.published.filter(event => event.type === "item/mcpToolCall/progress");

describe("Host typed MCP progress authority and live settlement", () => {
  it("publishes only after committed approval/start, before completion, with no durable seq or payload mutation", async () => {
    const h = await setup(async (_args, ctx) => {
      expect(ctx.onMcpProgress).toBeTypeOf("function");
      const value = { progress: 1, total: 2, message: "untrusted fixture status" };
      ctx.onMcpProgress?.(value); value.message = "mutated later";
      return result();
    });
    const begun = await start(h);
    await waitFor(() => h.engine.sink);
    expect(h.engine.sink?.createMcpProgressReporter?.("reusable-call", TOOL, new AbortController().signal)).toBeUndefined();
    expect(progress(h)).toEqual([]);
    await approve(h); await finished(h, begun.turn.id);
    const events = progress(h); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: h.session.id, turnId: begun.turn.id, toolCallId: "reusable-call",
      progress: 1, total: 2, message: "untrusted fixture status" });
    expect(Object.hasOwn(events[0]!, "seq")).toBe(false);
    const items = await h.store.listItems(h.session.id, { limit: 100 });
    const actual = items.find(item => item.type === "toolCall"); expect(actual).toBeDefined();
    expect(events[0]!.itemId).toBe(actual!.id);
    const position = h.bus.published.indexOf(events[0]!);
    expect(h.bus.published.findIndex(event => event.type === "item/started" && event.item.id === actual!.id)).toBeLessThan(position);
    expect(h.bus.published.findIndex(event => event.type === "item/completed" && event.item.id === actual!.id)).toBeGreaterThan(position);
    const durable = await h.store.readEvents(h.session.id, 0, 100);
    expect(durable.some(event => String(event.type) === "item/mcpToolCall/progress")).toBe(false);
    expect(durable.map(event => event.seq)).toEqual(durable.map((_event, index) => index + 1));
    expect(items.find(item => item.type === "toolResult")).toMatchObject({ content: result().content });
    await expect(h.host.subscribe({ ...owner, userId: "bob" }, h.session.id, 0, () => {})).rejects.toMatchObject({ code: "not_found" });
    await expect(h.host.subscribe({ tenantId: "other", userId: owner.userId }, h.session.id, 0, () => {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not mint from the mutated started item while its actual COMMIT is still pending", async () => {
    const h = await setup(async (_args, ctx) => { ctx.onMcpProgress?.({ progress: 1 }); return result(); });
    h.store.startedGate = deferred(); const begun = await start(h);
    const approved = approve(h);
    // Own the rejection immediately while the test observes the blocked COMMIT; await below
    // still propagates the original failure instead of turning it into a successful approval.
    void approved.catch(() => {});
    await h.store.startedEntered.promise;
    expect(h.engine.sink?.createMcpProgressReporter?.("reusable-call", TOOL, new AbortController().signal)).toBeUndefined();
    expect(progress(h)).toEqual([]);
    h.store.startedGate.resolve(); await approved; await finished(h, begun.turn.id);
    expect(progress(h)).toHaveLength(1);
  });

  it("never mints or executes when the actual started COMMIT rejects", async () => {
    let executions = 0;
    const h = await setup(async () => { executions++; return result(); });
    h.store.rejectStarted = true; await start(h); await approve(h);
    await waitFor(() => !h.host.activeTurn(h.session.id) ? true : undefined);
    expect(executions).toBe(0); expect(progress(h)).toEqual([]);
    expect(h.engine.sink?.createMcpProgressReporter?.("reusable-call", TOOL, new AbortController().signal)).toBeUndefined();
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolCall"))
      .toMatchObject({ status: "inProgress" });
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(false);
  });

  it("pins the actual item when a later step reuses toolCallId and closes all late callbacks", async () => {
    const reporters: Array<NonNullable<ToolExecutionContext["onMcpProgress"]>> = [];
    const h = await setup(async (_args, ctx) => {
      reporters.push(ctx.onMcpProgress!);
      if (reporters.length === 2) reporters[0]!({ progress: 99, message: "stale old call" });
      ctx.onMcpProgress?.({ progress: reporters.length }); return result();
    }, async (params, sink) => { await call(params, sink, 1); await call(params, sink, 2); });
    const begun = await start(h); await approve(h); await approve(h); await finished(h, begun.turn.id);
    const items = (await h.store.listItems(h.session.id, { limit: 100 })).filter(item => item.type === "toolCall");
    expect(items).toHaveLength(2); expect(items[0]!.id === items[1]!.id).toBe(false);
    expect(progress(h).map(event => [event.itemId, event.progress])).toEqual(items.map((item, index) => [item.id, index + 1]));
    reporters.forEach(report => report({ progress: 100 })); await Promise.resolve();
    expect(progress(h)).toHaveLength(2);
  });

  it("bounds pending observations and waits for actual publication before canonical completion", async () => {
    const h = await setup(async (_args, ctx) => {
      ctx.onMcpProgress?.({ progress: 0 }); await h.bus.progressEntered.promise;
      for (let index = 1; index < 100; index++) ctx.onMcpProgress?.({ progress: index });
      return result();
    });
    h.bus.progressGate = deferred(); const begun = await start(h); await approve(h);
    await h.bus.progressEntered.promise;
    await Promise.resolve(); await Promise.resolve();
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(false);
    h.bus.progressGate.resolve(); await finished(h, begun.turn.id);
    expect(progress(h)).toHaveLength(16);
    const completed = h.bus.published.findIndex(event => event.type === "item/completed" && event.item.type === "toolResult");
    expect(h.bus.published.every((event, index) => event.type !== "item/mcpToolCall/progress" || index < completed)).toBe(true);
    await h.bus.progressCloseAcknowledged.promise;
    expect(h.bus.legacyProgressCalls).toBe(0);
  });

  it("keeps a long tool's later progress when each real publication settles within its own budget", async () => {
    const toolFinished = deferred();
    const h = await setup(async (_args, ctx) => {
      for (let index = 1; index <= 3; index++) {
        ctx.onMcpProgress?.({ progress: index });
        await waitFor(() => progress(h).length === index ? true : undefined);
        expect(ctx.signal.aborted).toBe(false);
      }
      toolFinished.resolve(); return result();
    });
    h.bus.progressDelayMs = 750;
    const begun = await start(h); await approve(h); await toolFinished.promise; await finished(h, begun.turn.id);
    expect(progress(h).map(event => event.progress)).toEqual([1, 2, 3]);
    expect(h.bus.legacyProgressCalls).toBe(0);
  });

  it("cancels a slowly draining queue once without releasing runtime before actual observer close", async () => {
    let report: ToolExecutionContext["onMcpProgress"], executionSignal: AbortSignal | undefined;
    const h = await setup(async (_args, ctx) => {
      report = ctx.onMcpProgress; executionSignal = ctx.signal;
      for (let index = 1; index <= 16; index++) report?.({ progress: index });
      return result();
    });
    h.bus.progressDelayMs = 300; h.bus.progressCloseGate = deferred();
    const begun = await start(h); await approve(h); await h.bus.progressCancelled.promise;
    expect(progress(h).length).toBeGreaterThan(0); expect(progress(h).length).toBeLessThan(16);
    expect(h.bus.progressDispatches).toBeGreaterThan(1);
    expect(executionSignal?.aborted).toBe(false);
    expect(h.runtime.snapshot(owner.tenantId).activeTurns).toBe(1);
    expect(h.host.activeTurn(h.session.id)).toBeDefined();
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(false);
    const dispatched = h.bus.progressDispatches; report?.({ progress: 100 });
    h.bus.progressCloseGate.resolve(); await h.bus.progressCloseAcknowledged.promise; await finished(h, begun.turn.id);
    expect(h.bus.progressDispatches).toBe(dispatched);
    expect(h.runtime.snapshot(owner.tenantId).activeTurns).toBe(0);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolResult"))
      .toMatchObject({ content: result().content, isError: false });
    const completed = h.bus.published.findIndex(event => event.type === "item/completed" && event.item.type === "toolResult");
    expect(h.bus.published.every((event, index) => event.type !== "item/mcpToolCall/progress" || index < completed)).toBe(true);
  });

  it("really cancels a never-responding observer and still commits the original tool result", async () => {
    let executionSignal: AbortSignal | undefined;
    const h = await setup(async (_args, ctx) => {
      executionSignal = ctx.signal; ctx.onMcpProgress?.({ progress: 1 }); return result();
    });
    h.bus.progressGate = deferred(); h.bus.progressCloseGate = deferred();
    const begun = await start(h); await approve(h); await h.bus.progressEntered.promise;
    await h.bus.progressCancelled.promise;
    expect(h.runtime.snapshot(owner.tenantId).activeTurns).toBe(1);
    expect(h.host.activeTurn(h.session.id)).toBeDefined();
    expect(executionSignal?.aborted).toBe(false);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(false);
    h.bus.progressCloseGate.resolve(); await h.bus.progressCloseAcknowledged.promise; await finished(h, begun.turn.id);
    expect(progress(h)).toEqual([]); expect(h.bus.legacyProgressCalls).toBe(0);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolResult"))
      .toMatchObject({ content: result().content, isError: false });
  });

  it.each(["unsupported", "factory_failure"] as const)("drops observations for %s without legacy publication or changing tools", async mode => {
    const h = await setup(async (_args, ctx) => {
      expect(ctx.onMcpProgress).toBeUndefined(); return result();
    });
    Object.defineProperty(h.bus, "openMcpProgressPublisher", { value: mode === "unsupported" ? undefined
      : () => { throw new Error("Fixture observer factory failed."); } });
    const begun = await start(h); await approve(h); await finished(h, begun.turn.id);
    expect(h.bus.legacyProgressCalls).toBe(0); expect(h.bus.progressDispatches).toBe(0);
    expect(progress(h)).toEqual([]);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolResult"))
      .toMatchObject({ content: result().content, isError: false });
  });

  it("drops invalid/extra-field progress and live publication errors without changing the result", async () => {
    const h = await setup(async (_args, ctx) => {
      for (const value of [{ progress: -1 }, { progress: Number.NaN }, { progress: 2, total: 1 },
        { progress: 1, message: "中".repeat(171) }, { progress: 1, privateToken: "fixture-private" }]) {
        ctx.onMcpProgress?.(value as McpToolProgress);
      }
      ctx.onMcpProgress?.({ progress: 1 }); return result();
    });
    h.bus.failProgress = true; const begun = await start(h); await approve(h); await finished(h, begun.turn.id);
    expect(progress(h)).toEqual([]);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolResult"))
      .toMatchObject({ content: result().content, isError: false });
  });

  it("independently rejects equal or decreasing values from a typed callback", async () => {
    const h = await setup(async (_args, ctx) => {
      for (const value of [1, 1, 0, 2, 2, 1, 3]) ctx.onMcpProgress?.({ progress: value });
      return result();
    });
    const begun = await start(h); await approve(h); await finished(h, begun.turn.id);
    expect(progress(h).map(event => event.progress)).toEqual([1, 2, 3]);
  });

  it("independently caps the entire call even when each prior publication has settled", async () => {
    const h = await setup(async (_args, ctx) => {
      for (let index = 0; index < 80; index++) {
        ctx.onMcpProgress?.({ progress: index });
        if (index < 64) await waitFor(() => progress(h).length === index + 1 ? true : undefined);
      }
      return result();
    });
    const begun = await start(h); await approve(h); await finished(h, begun.turn.id);
    expect(progress(h).map(event => event.progress)).toEqual(Array.from({ length: 64 }, (_value, index) => index));
  });

  it.each(["interrupt", "runtime", "lease"] as const)("does not dispatch new observations after %s", async mode => {
    const entered = deferred(), release = deferred(); let report: ToolExecutionContext["onMcpProgress"];
    let executionSignal: AbortSignal | undefined;
    const h = await setup(async (_args, ctx) => {
      report = ctx.onMcpProgress; executionSignal = ctx.signal;
      ctx.onMcpProgress?.({ progress: 1 }); entered.resolve(); await release.promise;
      ctx.onMcpProgress?.({ progress: 9 }); return result();
    });
    const begun = await start(h); await approve(h); await entered.promise;
    let stopping: Promise<unknown>;
    if (mode === "interrupt") {
      stopping = h.host.interrupt(owner, h.session.id, begun.turn.id);
      void stopping.catch(() => {});
      await waitFor(() => executionSignal?.aborted ? true : undefined);
    }
    else if (mode === "runtime") stopping = h.runtime.drain({ requestId: "ter_progress_fixture", tenantId: owner.tenantId,
      subjectGeneration: 1, t3aReceiptSha256: "34".repeat(32) }, 1_000);
    else {
      await h.lease.release(h.lease.proof(h.session.id, h.store.sessions.get(h.session.id)!.fenceToken));
      await h.lease.acquire(h.session.id, "replacement-runner", "127.0.0.1:4011", 2_000);
      await waitFor(() => executionSignal?.aborted ? true : undefined);
      stopping = Promise.resolve();
    }
    report?.({ progress: 8 }); release.resolve(); await stopping;
    await waitFor(() => !h.host.activeTurn(h.session.id) ? true : undefined);
    expect(progress(h).every(event => event.progress === 1)).toBe(true);
    report?.({ progress: 10 }); await Promise.resolve();
    expect(progress(h).every(event => event.progress === 1)).toBe(true);
  });

  it.each(["interrupt", "runtime", "lease"] as const)("waits for actual owned observation settlement after %s", async mode => {
    const release = deferred(); let executionSignal: AbortSignal | undefined;
    const h = await setup(async (_args, ctx) => {
      executionSignal = ctx.signal; ctx.onMcpProgress?.({ progress: 1 }); await release.promise; return result();
    });
    h.bus.progressGate = deferred(); h.bus.progressCloseGate = deferred();
    const begun = await start(h); await approve(h); await h.bus.progressEntered.promise;
    let stopping: Promise<unknown>;
    if (mode === "interrupt") stopping = h.host.interrupt(owner, h.session.id, begun.turn.id);
    else if (mode === "runtime") stopping = h.runtime.drain({ requestId: "ter_progress_owned", tenantId: owner.tenantId,
      subjectGeneration: 1, t3aReceiptSha256: "35".repeat(32) }, 1_000);
    else {
      await h.lease.release(h.lease.proof(h.session.id, h.store.sessions.get(h.session.id)!.fenceToken));
      await h.lease.acquire(h.session.id, "replacement-runner", "127.0.0.1:4011", 2_000);
      stopping = Promise.resolve();
    }
    void stopping.catch(() => {});
    try {
      await h.bus.progressCancelled.promise;
      expect(executionSignal?.aborted).toBe(true);
      release.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(h.runtime.snapshot(owner.tenantId).activeTurns).toBe(1);
      expect(h.host.activeTurn(h.session.id)).toBeDefined();
      expect((await h.store.listItems(h.session.id, { limit: 100 })).some(item => item.type === "toolResult")).toBe(false);
      h.bus.progressCloseGate.resolve(); await h.bus.progressCloseAcknowledged.promise; await stopping;
      await waitFor(() => !h.host.activeTurn(h.session.id) ? true : undefined);
      expect(h.runtime.snapshot(owner.tenantId).activeTurns).toBe(0);
      expect(progress(h)).toEqual([]);
    } finally {
      release.resolve(); h.bus.progressCloseGate.resolve(); await Promise.allSettled([stopping]);
    }
  });

  it("keeps progress before interrupt owner admission, then fences new dispatch after actual abort", async () => {
    const entered = deferred(), release = deferred(); let report: ToolExecutionContext["onMcpProgress"];
    let executionSignal: AbortSignal | undefined;
    const h = await setup(async (_args, ctx) => {
      report = ctx.onMcpProgress; executionSignal = ctx.signal;
      ctx.onMcpProgress?.({ progress: 1 }); entered.resolve(); await release.promise;
      ctx.onMcpProgress?.({ progress: 9 }); return result();
    });
    const begun = await start(h); await approve(h); await entered.promise;
    await waitFor(() => progress(h).length === 1 ? true : undefined);
    const gate = { tenantId: owner.tenantId, sessionId: h.session.id, entered: deferred(), release: deferred() };
    let ownerReadEntered = false;
    void gate.entered.promise.then(() => { ownerReadEntered = true; });
    h.store.sessionReadGate = gate;
    const stopping = h.host.interrupt(owner, h.session.id, begun.turn.id);
    void stopping.catch(() => {});
    try {
      await waitFor(() => ownerReadEntered ? true : undefined);
      expect(executionSignal?.aborted).toBe(false);
      report?.({ progress: 2 });
      await waitFor(() => progress(h).length === 2 ? true : undefined);
      expect(progress(h).map(event => event.progress)).toEqual([1, 2]);
      gate.release.resolve();
      await waitFor(() => executionSignal?.aborted ? true : undefined);
      report?.({ progress: 8 }); release.resolve(); await stopping;
      await waitFor(() => !h.host.activeTurn(h.session.id) ? true : undefined);
      expect(progress(h).map(event => event.progress)).toEqual([1, 2]);
      report?.({ progress: 10 }); await Promise.resolve();
      expect(progress(h).map(event => event.progress)).toEqual([1, 2]);
    } finally {
      gate.release.resolve(); release.resolve();
      await Promise.allSettled([stopping]);
    }
  });
});
