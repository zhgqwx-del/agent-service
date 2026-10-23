import { memoryAuthorityStore, MemoryAuthorityFixture } from "./session-authority-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type AgentDefinition, type Approval, type Event, type Principal, type Session } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore, SubjectDeletingError, type CommitBatch } from "@agent-service/store";
import {
  SessionHost,
  StaticToolRegistry,
  TenantRuntimeCoordinator,
  computeContextEpoch,
  newId,
  type McpToolSource,
  type ResolvedModel,
  type RunnerTool,
} from "../src/index.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

// Host integration only: the real host/store/engine exercise an injected source. These tests do
// not claim to prove HTTP, TLS, MCP codecs, MySQL, Redis or the router-to-model vertical slice.
const owner: Principal = { tenantId: "t_host_mcp", userId: "u_owner" };
const SERVER = "configured_remote";
const TOOL = "mcp__configured__echo_0123456789abcdef";
const SCOPE = "mcp_scope_owner_catalog_a";
const CATALOG_MESSAGE = "Remote tool catalog changed; previous approvals do not apply to changed tools.";
const model: ResolvedModel = {
  handle: {}, provider: "fake", model: "fake-1", contextWindow: 32_000,
  input: ["text"], apiKey: async () => "unused-fixture-value",
};
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const builtin: RunnerTool = {
  name: "echo", description: "builtin echo", parameters: { type: "object" }, kind: "builtin", readOnly: true,
  execute: async () => textResult("builtin"),
};

function remoteTool(patch: Partial<RunnerTool> = {}): RunnerTool {
  return {
    name: TOOL, description: "Untrusted remote fixture echo", kind: "mcp",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    mandatoryApproval: true, approvalScope: SCOPE, readOnly: false, concurrencySafe: false,
    execute: async (args) => textResult(`remote:${(args as { text: string }).text}`),
    ...patch,
  };
}

class ControlledMcpSource implements McpToolSource {
  readonly enabled = true;
  readonly validations: { principal: Principal; ids: string[] }[] = [];
  readonly discoveries: { principal: Principal; ids: string[]; signal: AbortSignal }[] = [];
  tools = [remoteTool()];
  resolveHook?: McpToolSource["resolve"];
  constructor(private readonly allowed: readonly Principal[] = [owner]) {}
  validateMounts(principal: Principal, ids: string[]): void {
    this.validations.push({ principal: { ...principal }, ids: [...ids] });
    if (ids.some(id => id !== SERVER) || !this.allowed.some(p => p.tenantId === principal.tenantId && p.userId === principal.userId)) {
      throw new ApiError("not_found", "MCP server not found");
    }
  }
  async resolve(principal: Principal, ids: string[], signal: AbortSignal): Promise<RunnerTool[]> {
    this.discoveries.push({ principal: { ...principal }, ids: [...ids], signal });
    return this.resolveHook ? this.resolveHook(principal, ids, signal) : [...this.tools];
  }
  async close(): Promise<void> {}
}

class RecordingStore extends MemorySessionStore {
  createCalls = 0;
  readonly batches: CommitBatch[] = [];
  override async createSession(session: Session) {
    this.createCalls += 1;
    return super.createSession(session);
  }
  override async commit(batch: CommitBatch) {
    this.batches.push(structuredClone(batch));
    return super.commit(batch);
  }
}
class RecordingBus extends MemoryEventBus {
  readonly published: Event[] = [];
  override async publish(sessionId: string, event: Event) {
    this.published.push(structuredClone(event));
    return super.publish(sessionId, event);
  }
}
class LosingLease extends MemoryAuthorityFixture {
  renewals = 0;
  rejectRenewals = false;
  override async renew(proof: import("@agent-service/store").SessionLeaseProof, ttlMs: number) {
    this.renewals += 1;
    return this.rejectRenewals ? false : super.renew(proof, ttlMs);
  }
}

const fixtures: { host: SessionHost; mcp: ControlledMcpSource; bus: RecordingBus; lease: MemoryAuthorityFixture }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.host.drain(1_000).catch(() => {});
    await fixture.mcp.close();
    await fixture.bus.close();
    await fixture.lease.close();
  }
});

async function setup(script: ScriptStep[] = [{ text: "finished" }], options: {
  mcp?: ControlledMcpSource;
  agent?: Partial<AgentDefinition>;
  lease?: MemoryAuthorityFixture;
  leaseTtlMs?: number;
  runtime?: TenantRuntimeCoordinator;
} = {}) {
  const store = memoryAuthorityStore(RecordingStore), bus = new RecordingBus();
  const lease = (options.lease ?? new MemoryAuthorityFixture()).bind(store);
  const mcp = options.mcp ?? new ControlledMcpSource();
  const engine = new ScriptedEngine(script);
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "MCP host fixture", instructions: "Use the mounted tool.",
    model: { provider: "fake", model: "fake-1" }, tools: [], mcpServers: [SERVER], skills: [], limits: {},
    approvalPolicy: "on-request", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
    ...options.agent,
  };
  await store.createAgent(agent);
  const host = new SessionHost({
    store, lease: lease.authority, bus, engine, mcp, tools: new StaticToolRegistry([builtin]),
    providers: { resolve: async () => model }, tenantRuntime: options.runtime,
    config: { runnerId: "mcp-host-runner", runnerAddr: "127.0.0.1:4010", leaseTtlMs: options.leaseTtlMs ?? 2_000, leaseHoldMs: 10, approvalTtlMs: 5_000 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  fixtures.push({ host, mcp, bus, lease });
  return { host, store, lease, bus, engine, mcp, agent };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function create(h: Harness, principal = owner, userId?: string) {
  return h.host.createSession(principal, { agentId: h.agent.id, ...(userId === undefined ? {} : { userId }), metadata: {} });
}
const request = () => ({ input: [{ type: "text" as const, text: "use the tool" }], stream: true, metadata: {} });
async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function finished(h: Harness, sessionId: string, turnId: string) {
  return waitFor(async () => {
    const turn = await h.store.getTurn(sessionId, turnId);
    return turn && turn.status !== "inProgress" && !h.host.activeTurn(sessionId) ? turn : undefined;
  }, "turn completion");
}
async function pending(h: Harness, sessionId: string): Promise<Approval> {
  return waitFor(async () => (await h.store.listApprovals(sessionId, { pendingOnly: true }))[0], "MCP approval");
}
async function noTurn(h: Harness, session: Session) {
  expect((await h.store.listTurns(session.id, { limit: 20 })).data).toEqual([]);
  expect(await h.store.listItems(session.id, { limit: 100 })).toEqual([]);
  expect(await h.store.readEvents(session.id, 0, 100)).toEqual([
    { type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 },
  ]);
  expect((await h.store.getSession(session.tenantId, session.id))?.lastSeq).toBe(1);
  expect(h.engine.received).toEqual([]);
  expect(h.host.activeTurn(session.id)).toBeUndefined();
  expect(await h.lease.getOwner(session.id)).toBeNull();
}
function waitForAbort(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("SessionHost MCP source integration (Memory/ScriptedEngine)", () => {
  it("resolves delegated creation and its epoch as the target owner rather than the caller", async () => {
    const target = { ...owner, userId: "u_target" };
    const mcp = new ControlledMcpSource([target]);
    mcp.resolveHook = async principal => [remoteTool({ approvalScope: `scope_${principal.userId}` })];
    const h = await setup(undefined, { mcp });
    // The HTTP layer separately proves trusted-caller delegation; this test exercises the host's
    // effective-owner boundary after that authorization, not end-user-token authorization itself.
    const session = await create(h, owner, target.userId);
    expect(session.userId).toBe(target.userId);
    expect(mcp.validations).toEqual([{ principal: target, ids: [SERVER] }]);
    expect(mcp.discoveries.map(call => ({ principal: call.principal, ids: call.ids }))).toEqual([{ principal: target, ids: [SERVER] }]);
    const epoch = (userId: string) => computeContextEpoch({
      agentId: h.agent.id, agentVersion: h.agent.version, systemPrompt: h.agent.instructions,
      tools: [remoteTool({ approvalScope: `scope_${userId}` })], skills: [],
    });
    expect(session.contextEpoch).toBe(epoch(target.userId));
    expect(session.contextEpoch).not.toBe(epoch(owner.userId));
    expect(await h.store.getSession(target.tenantId, session.id)).toMatchObject({ userId: target.userId, lastSeq: 1 });
  });

  it.each([
    { label: "unknown server", principal: owner, mounts: ["unknown_remote"] },
    { label: "another user", principal: { ...owner, userId: "u_other" }, mounts: [SERVER] },
    { label: "another tenant", principal: { ...owner, tenantId: "t_other" }, mounts: [SERVER] },
  ])("does not create a session or first event for $label", async ({ principal, mounts }) => {
    const h = await setup(undefined, { agent: { tenantId: principal.tenantId, mcpServers: mounts } });
    await expect(create(h, principal)).rejects.toMatchObject({ code: "not_found" });
    expect(h.mcp.validations).toEqual([{ principal, ids: mounts }]);
    expect(h.mcp.discoveries).toEqual([]);
    expect(h.store.createCalls).toBe(0);
    expect((await h.store.listSessions(principal.tenantId, { limit: 20 })).data).toEqual([]);
    expect(h.bus.published).toEqual([]);
  });

  it("rediscovers at beginTurn and persists a real host tool result before the second scripted step", async () => {
    const h = await setup([
      { toolCalls: [{ name: TOOL, args: { text: "first" } }] },
      { text: results => {
        const first = results[0]?.content[0];
        return `second:${first?.type === "text" ? first.text : "missing"}`;
      } },
    ]);
    const session = await create(h);
    const { turn } = await h.host.startTurn(owner, session.id, request());
    const approval = await pending(h, session.id);
    expect(h.mcp.discoveries).toHaveLength(2);
    expect(h.mcp.discoveries[1]?.principal).toEqual(owner);
    expect(h.engine.executedToolCalls).toBe(0);
    await h.host.resolveApproval(owner, session.id, approval.id, "accept");
    expect(await finished(h, session.id, turn.id)).toMatchObject({ status: "completed", steps: 2 });
    const items = await h.store.listItems(session.id, { limit: 100 });
    expect(items.find(item => item.type === "toolCall")).toMatchObject({ name: TOOL, kind: "mcp", status: "completed", startedAtMs: expect.any(Number) });
    expect(items.find(item => item.type === "toolResult")).toMatchObject({ name: TOOL, isError: false, content: [{ type: "text", text: "remote:first" }] });
    expect(items.find(item => item.type === "agentMessage" && item.text === "second:remote:first")).toBeDefined();
    const events = await h.store.readEvents(session.id, 0, 100);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
    expect(events.some(event => event.type === "item/started" && event.item.type === "toolCall" && event.item.kind === "mcp")).toBe(true);
  });

  it("fails unavailable turn discovery before any turn/item/event is written", async () => {
    const h = await setup();
    const session = await create(h);
    h.mcp.resolveHook = async () => { throw new ApiError("draining", "MCP request failed.", undefined, true); };
    await expect(h.host.beginTurn(owner, session.id, request())).rejects.toMatchObject({ code: "draining" });
    expect(h.mcp.discoveries).toHaveLength(2);
    await noTurn(h, session);
  });

  it("requires mandatory approval under never even when the injected remote claims readOnly", async () => {
    let executions = 0;
    const mcp = new ControlledMcpSource();
    mcp.tools = [remoteTool({ readOnly: true, needsApproval: false, execute: async (_args, ctx) => {
      executions += 1;
      expect(ctx.principal).toEqual(owner);
      expect(ctx.signal.aborted).toBe(false);
      return textResult("approved");
    } })];
    const h = await setup([{ toolCalls: [{ name: TOOL, args: { text: "x" } }] }, { text: "done" }], { mcp, agent: { approvalPolicy: "never" } });
    const session = await create(h);
    const { turn } = await h.host.startTurn(owner, session.id, request());
    const approval = await pending(h, session.id);
    expect(executions).toBe(0);
    expect((await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "toolCall")?.startedAtMs).toBeUndefined();
    await h.host.resolveApproval(owner, session.id, approval.id, "accept");
    await finished(h, session.id, turn.id);
    expect(executions).toBe(1);
  });

  it("declines without executing the remote tool and delivers the declined result to the next step", async () => {
    const h = await setup([{ toolCalls: [{ name: TOOL, args: { text: "x" } }] }, { text: results => results[0]?.isError ? "declined" : "unexpected-success" }]);
    const session = await create(h);
    const { turn } = await h.host.startTurn(owner, session.id, request());
    await h.host.resolveApproval(owner, session.id, (await pending(h, session.id)).id, "decline");
    await finished(h, session.id, turn.id);
    expect(h.engine.executedToolCalls).toBe(0);
    const items = await h.store.listItems(session.id, { limit: 100 });
    expect(items.find(item => item.type === "toolCall")).toMatchObject({ status: "declined" });
    expect(items.find(item => item.type === "toolResult")).toMatchObject({ isError: true });
    expect(items.find(item => item.type === "agentMessage" && item.text === "declined")).toBeDefined();
  });

  it("reuses acceptForSession only for the exact scope and asks again when the same tool changes scope", async () => {
    const h = await setup([{ toolCalls: [{ name: TOOL, args: { text: "x" } }] }, { text: "done" }], { agent: { approvalPolicy: "never" } });
    const session = await create(h);
    const first = await h.host.startTurn(owner, session.id, request());
    await h.host.resolveApproval(owner, session.id, (await pending(h, session.id)).id, "acceptForSession");
    await finished(h, session.id, first.turn.id);
    expect((await h.store.getSession(owner.tenantId, session.id))?.autoApprovedTools).toContain(SCOPE);
    expect((await h.store.getSession(owner.tenantId, session.id))?.autoApprovedTools).not.toContain(TOOL);
    const second = await h.host.startTurn(owner, session.id, request());
    await finished(h, session.id, second.turn.id);
    expect(await h.store.listApprovals(session.id, {})).toHaveLength(1);
    expect(h.engine.executedToolCalls).toBe(2);
    h.mcp.tools = [remoteTool({ approvalScope: "mcp_scope_owner_catalog_b" })];
    const third = await h.host.startTurn(owner, session.id, request());
    const approval = await pending(h, session.id);
    expect(approval.turnId).toBe(third.turn.id);
    expect(h.engine.executedToolCalls).toBe(2);
    await h.host.resolveApproval(owner, session.id, approval.id, "accept");
    await finished(h, session.id, third.turn.id);
    expect(await h.store.listApprovals(session.id, {})).toHaveLength(2);
    expect(h.engine.executedToolCalls).toBe(3);
  });

  it("does not treat a legacy tool-name grant as a grant for its mandatory MCP scope", async () => {
    const h = await setup([{ toolCalls: [{ name: TOOL, args: { text: "x" } }] }], { agent: { approvalPolicy: "never" } });
    const session = await create(h);
    await h.lease.seed({ sessionId: session.id, fence: 0, sessionPatch: { autoApprovedTools: [TOOL] } });
    const { turn } = await h.host.startTurn(owner, session.id, request());
    const approval = await pending(h, session.id);
    expect(h.engine.executedToolCalls).toBe(0);
    await h.host.resolveApproval(owner, session.id, approval.id, "decline");
    await finished(h, session.id, turn.id);
    expect(h.engine.executedToolCalls).toBe(0);
  });

  it.each(["builtin", "dynamic"] as const)("rejects an MCP/%s name collision before turn persistence", async kind => {
    const h = await setup(undefined, { agent: { tools: kind === "builtin" ? [builtin.name] : [] } });
    const session = await create(h);
    if (kind === "builtin") h.mcp.tools = [remoteTool({ name: builtin.name })];
    const input = { ...request(), ...(kind === "dynamic" ? { dynamicTools: [{ name: TOOL, description: "client echo", parameters: { type: "object" } }] } : {}) };
    await expect(h.host.beginTurn(owner, session.id, input)).rejects.toMatchObject({ code: "invalid_request", message: "tool names collide" });
    await noTurn(h, session);
  });

  it("commits a changed catalog epoch, notice and warning with turn start and includes the notice in model history", async () => {
    const h = await setup();
    const session = await create(h);
    h.mcp.tools = [remoteTool({ description: "Untrusted changed catalog", approvalScope: "mcp_scope_changed" })];
    const expectedEpoch = computeContextEpoch({ agentId: h.agent.id, agentVersion: h.agent.version, systemPrompt: h.agent.instructions, tools: h.mcp.tools, skills: [] });
    const begun = await h.host.beginTurn(owner, session.id, request());
    expect(expectedEpoch).not.toBe(session.contextEpoch);
    expect((await h.store.getSession(owner.tenantId, session.id))?.contextEpoch).toBe(expectedEpoch);
    const batch = h.store.batches.find(batch => batch.turn?.id === begun.turn.id);
    expect(batch?.sessionPatch?.contextEpoch).toBe(expectedEpoch);
    const notice = batch?.items?.find(item => item.type === "systemNotice" && item.kind === "toolsChanged");
    expect(notice).toMatchObject({ type: "systemNotice", kind: "toolsChanged", text: CATALOG_MESSAGE, turnId: begun.turn.id });
    expect(batch?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn/started", turn: expect.objectContaining({ id: begun.turn.id }) }),
      expect.objectContaining({ type: "warning", code: "mcp_catalog_changed", message: CATALOG_MESSAGE }),
      expect.objectContaining({ type: "item/completed", item: expect.objectContaining({ id: notice?.id, text: CATALOG_MESSAGE }) }),
    ]));
    begun.run();
    await finished(h, session.id, begun.turn.id);
    expect(JSON.stringify(h.engine.received[0]?.history)).toContain(CATALOG_MESSAGE);
    expect((await h.store.readEvents(session.id, 0, 100)).filter(event => event.type === "warning" && event.code === "mcp_catalog_changed")).toHaveLength(1);
  });

  it("passes tenant-runtime cancellation into in-flight discovery and waits for it before proving zero", async () => {
    const runtime = new TenantRuntimeCoordinator();
    const h = await setup(undefined, { runtime });
    const session = await create(h);
    runtime.sealParticipants();
    let signal: AbortSignal | undefined;
    let settled = false;
    h.mcp.resolveHook = async (_principal, _ids, inputSignal) => {
      signal = inputSignal;
      await waitForAbort(inputSignal);
      settled = true;
      return [remoteTool()];
    };
    const beginning = h.host.beginTurn(owner, session.id, request());
    const rejected = expect(beginning).rejects.toBeInstanceOf(SubjectDeletingError);
    await waitFor(async () => signal, "runtime-fenced MCP discovery");
    expect(runtime.snapshot(owner.tenantId).activeTurns).toBe(1);
    const draining = runtime.drain({ requestId: "ter_host_mcp_runtime", tenantId: owner.tenantId, subjectGeneration: 1, t3aReceiptSha256: "34".repeat(32) }, 1_000);
    await rejected;
    expect(await draining).toMatchObject({ activeTurnCountBefore: 1, activeTurnCountAfter: 0 });
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(true);
    await noTurn(h, session);
  });

  it("passes lease loss into in-flight discovery without admitting a turn", async () => {
    const lease = new LosingLease();
    const h = await setup(undefined, { lease, leaseTtlMs: 300 });
    const session = await create(h);
    let signal: AbortSignal | undefined;
    let settled = false;
    h.mcp.resolveHook = async (_principal, _ids, inputSignal) => {
      signal = inputSignal;
      lease.rejectRenewals = true;
      await waitForAbort(inputSignal);
      settled = true;
      return [remoteTool()];
    };
    await expect(h.host.beginTurn(owner, session.id, request())).rejects.toMatchObject({ code: "session_lease_conflict" });
    expect(lease.renewals).toBeGreaterThan(0);
    expect(signal?.aborted).toBe(true);
    await waitFor(async () => settled ? true : undefined, "cancelled discovery settlement");
    // A failed renewal fences this Host promptly; it is not proof the real tuple was released.
    // Keep the original TTL and let the owning store's clock observe its natural expiry.
    await waitFor(async () => (await h.lease.getOwner(session.id)) === null ? true : undefined, "lost lease natural expiry");
    await noTurn(h, session);
  });
});
