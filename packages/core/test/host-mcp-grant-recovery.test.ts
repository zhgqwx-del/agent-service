import { memoryAuthorityStore, MemoryAuthorityFixture } from "./session-authority-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentDefinition, type Approval, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore, type CommitBatch } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type McpToolSource, type ResolvedModel, type RunnerTool } from "../src/index.js";
import { ScriptedEngine } from "./fake-engine.js";

// Host/store recovery only: the injected MCP tool is actually invoked, but this suite does not
// claim to exercise HTTP, the official MCP codec, MySQL, Redis, or a real process kill.
const owner: Principal = { tenantId: "t_mcp_grant_recovery", userId: "u_grant_owner" };
const SERVER = "grant_recovery_remote";
const TOOL = "mcp__recovery__echo_0123456789abcdef";
const SCOPE = "mcp_owner_same_catalog_scope";
const model: ResolvedModel = {
  handle: {}, provider: "fake", model: "fake-1", contextWindow: 32_000,
  input: ["text"], apiKey: async () => "unused-fixture-value",
};
const request = () => ({ input: [{ type: "text" as const, text: "call the approved remote tool" }], stream: true, metadata: {} });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settled) => { resolve = settled; });
  return { promise, resolve };
}

class ResultFaultStore extends MemorySessionStore {
  throwBeforeSuccessfulResult = false;
  successfulResultFaults = 0;
  beforeSuccessfulResult: ((batch: CommitBatch) => Promise<void>) | undefined;
  override async commit(batch: CommitBatch) {
    if (batch.items?.some(item => item.type === "toolResult" && item.name === TOOL && !item.isError)) {
      await this.beforeSuccessfulResult?.(batch);
      if (this.throwBeforeSuccessfulResult) {
        this.successfulResultFaults++;
        throw new Error("Fixture tool-result commit failed before publication.");
      }
    }
    return super.commit(batch);
  }
}

class FixedCatalog implements McpToolSource {
  readonly enabled = true;
  constructor(readonly tool: RunnerTool) {}
  validateMounts(principal: Principal, ids: string[]): void {
    expect(principal).toEqual(owner);
    expect(ids).toEqual([SERVER]);
  }
  async resolve(principal: Principal, ids: string[]): Promise<RunnerTool[]> {
    this.validateMounts(principal, ids);
    return [this.tool];
  }
  async close(): Promise<void> {}
}

interface DispatchObservation {
  turnId: string;
  grants: string[];
  startedAtMs: number | undefined;
}
const cleanup: { hosts: SessionHost[]; bus: MemoryEventBus; lease: MemoryAuthorityFixture }[] = [];
afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    for (const host of fixture.hosts) await host.drain(0);
    await fixture.bus.close();
    await fixture.lease.close();
  }
});

async function setup(options: { holdUntilOwnerLost?: boolean } = {}) {
  const store = memoryAuthorityStore(ResultFaultStore), lease = new MemoryAuthorityFixture().bind(store), bus = new MemoryEventBus();
  const hosts: SessionHost[] = [];
  cleanup.push({ hosts, bus, lease });
  const dispatched = deferred<void>();
  const observations: DispatchObservation[] = [];
  let calls = 0;
  const tool: RunnerTool = {
    name: TOOL, description: "Untrusted recovery fixture echo", kind: "mcp",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    mandatoryApproval: true, approvalScope: SCOPE, readOnly: false, concurrencySafe: false,
    execute: async (_args, context) => {
      calls++;
      const session = await store.getSession(owner.tenantId, context.sessionId);
      const call = (await store.listItems(context.sessionId, { limit: 100 }))
        .filter(item => item.type === "toolCall")
        .find(item => item.turnId === context.turnId && item.toolCallId === context.toolCallId);
      observations.push({ turnId: context.turnId, grants: [...(session?.autoApprovedTools ?? [])], startedAtMs: call?.startedAtMs });
      // The effect happens only after both the grant consumption and started marker are durable.
      expect(session).toBeDefined();
      expect(session!.autoApprovedTools).not.toContain(SCOPE);
      expect(call?.type).toBe("toolCall");
      expect(call?.startedAtMs).toEqual(expect.any(Number));
      dispatched.resolve();
      if (options.holdUntilOwnerLost && calls === 1) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
          if (context.signal.aborted) resolve();
        });
      }
      return { content: [{ type: "text", text: "remote effect happened" }] };
    },
  };
  const mcp = new FixedCatalog(tool);
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "MCP grant recovery fixture", instructions: "Use the mounted tool.",
    model: { provider: "fake", model: "fake-1" }, tools: [], mcpServers: [SERVER], skills: [], limits: {},
    approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const newHost = () => {
    const engine = new ScriptedEngine([
      { toolCalls: [{ name: TOOL, args: { text: "same request" } }] }, { text: "done" },
    ]);
    const host = new SessionHost({
      store, lease: lease.authority, bus, engine, mcp, tools: new StaticToolRegistry([]), providers: { resolve: async () => model },
      config: { runnerId: `grant-runner-${hosts.length + 1}`, runnerAddr: "127.0.0.1:4020", leaseTtlMs: 300, leaseHoldMs: 10, approvalTtlMs: 5_000 },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    hosts.push(host);
    return { host, engine };
  };
  const first = newHost();
  const session = await first.host.createSession(owner, { agentId: agent.id, metadata: {} });
  return { ...first, newHost, store, lease, session, dispatched, observations, calls: () => calls };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function pending(h: Harness, host: SessionHost): Promise<Approval> {
  expect(host.activeTurn(h.session.id)).toBeDefined();
  return waitFor(async () => (await h.store.listApprovals(h.session.id, { pendingOnly: true }))[0], "new MCP approval");
}
async function completed(h: Harness, host: SessionHost, turnId: string) {
  return waitFor(async () => {
    const turn = await h.store.getTurn(h.session.id, turnId);
    return turn && turn.status !== "inProgress" && !host.activeTurn(h.session.id) ? turn : undefined;
  }, "turn completion");
}
async function oldHostStopped(h: Harness) {
  await waitFor(async () => h.host.activeTurn(h.session.id) ? undefined : true, "fenced old Host to settle");
  await h.host.drain(0);
}

async function requireFreshApprovalOnReplacement(h: Harness, oldTurnId: string) {
  const durable = await h.store.getSession(owner.tenantId, h.session.id);
  expect(durable?.autoApprovedTools).not.toContain(SCOPE);
  expect((await h.store.getTurn(h.session.id, oldTurnId))?.status).toBe("inProgress");
  const before = await h.store.listItems(h.session.id, { limit: 100 });
  expect(before.find(item => item.type === "toolCall" && item.turnId === oldTurnId)).toMatchObject({
    name: TOOL, kind: "mcp", status: "inProgress", startedAtMs: expect.any(Number),
  });
  expect(before.filter(item => item.type === "toolResult" && item.turnId === oldTurnId)).toEqual([]);
  expect(h.calls()).toBe(1);
  // The previous Host has fully settled. This isolated MemoryAuthorityFixture helper models TTL expiry,
  // not a second owner being admitted while the first owner can still execute.
  await h.lease.expire(h.session.id);
  const replacement = h.newHost();
  const { turn } = await replacement.host.startTurn(owner, h.session.id, request());
  const approval = await pending(h, replacement.host);
  expect((await h.store.getTurn(h.session.id, oldTurnId))?.status).toBe("interrupted");
  expect((await h.store.getSession(owner.tenantId, h.session.id))?.contextEpoch).toBe(h.session.contextEpoch);
  expect(replacement.engine.received[0]?.history).toContainEqual(expect.objectContaining({
    role: "toolResult", name: TOOL, isError: true,
    content: [{ type: "text", text: expect.stringContaining("TOOL_OUTCOME_UNKNOWN") }],
  }));
  expect(approval).toMatchObject({ toolName: TOOL, status: "pending", turnId: turn.id });
  expect(h.calls()).toBe(1);
  expect(replacement.engine.executedToolCalls).toBe(0);
  expect((await h.store.listItems(h.session.id, { limit: 100 }))
    .filter(item => item.type === "toolCall")
    .find(item => item.turnId === turn.id)?.startedAtMs).toBeUndefined();
  // The synthetic recovery text is present, but execution is blocked by a real new approval.
  await replacement.host.resolveApproval(owner, h.session.id, approval.id, "accept");
  expect(await completed(h, replacement.host, turn.id)).toMatchObject({ status: "completed" });
  expect(h.calls()).toBe(2);
  expect((await h.store.getSession(owner.tenantId, h.session.id))?.autoApprovedTools).not.toContain(SCOPE);
}

describe("MCP reusable approval crash boundary (Memory/ScriptedEngine)", () => {
  it("consumes the grant with started write-ahead and restores it only with a durable successful result", async () => {
    const h = await setup();
    const entered = deferred<CommitBatch>(), release = deferred<void>();
    h.store.beforeSuccessfulResult = async batch => { entered.resolve(structuredClone(batch)); await release.promise; };
    const { turn } = await h.host.startTurn(owner, h.session.id, request());
    const approval = await pending(h, h.host);
    await h.host.resolveApproval(owner, h.session.id, approval.id, "acceptForSession");
    try {
      const resultBatch = await entered.promise;
      expect(h.calls()).toBe(1);
      expect(h.observations).toEqual([{ turnId: turn.id, grants: [], startedAtMs: expect.any(Number) }]);
      expect((await h.store.getSession(owner.tenantId, h.session.id))?.autoApprovedTools).not.toContain(SCOPE);
      expect((await h.store.listItems(h.session.id, { limit: 100 })).filter(item => item.type === "toolResult")).toEqual([]);
      expect(resultBatch.sessionPatch?.autoApprovedTools).toContain(SCOPE);
      expect(resultBatch.items?.some(item => item.type === "toolResult" && !item.isError)).toBe(true);
    } finally {
      h.store.beforeSuccessfulResult = undefined;
      release.resolve();
    }
    expect(await completed(h, h.host, turn.id)).toMatchObject({ status: "completed" });
    expect((await h.store.getSession(owner.tenantId, h.session.id))?.autoApprovedTools).toEqual([SCOPE]);
    expect((await h.store.listItems(h.session.id, { limit: 100 })).find(item => item.type === "toolResult"))
      .toMatchObject({ name: TOOL, isError: false });
    const second = await h.host.startTurn(owner, h.session.id, request());
    await completed(h, h.host, second.turn.id);
    expect(h.calls()).toBe(2);
    expect(h.observations[1]).toMatchObject({ turnId: second.turn.id, grants: [], startedAtMs: expect.any(Number) });
    expect(await h.store.listApprovals(h.session.id, { pendingOnly: true })).toEqual([]);
    expect(await h.store.listApprovals(h.session.id, {})).toHaveLength(1);
    expect((await h.store.getSession(owner.tenantId, h.session.id))?.autoApprovedTools).toEqual([SCOPE]);
  });

  it("requires new consent on a new Host when the actual remote effect precedes a failed result commit", async () => {
    const h = await setup();
    h.store.throwBeforeSuccessfulResult = true;
    const { turn } = await h.host.startTurn(owner, h.session.id, request());
    await h.host.resolveApproval(owner, h.session.id, (await pending(h, h.host)).id, "acceptForSession");
    await h.dispatched.promise;
    await oldHostStopped(h);
    expect(h.store.successfulResultFaults).toBe(1);
    expect(h.observations).toEqual([{ turnId: turn.id, grants: [], startedAtMs: expect.any(Number) }]);
    h.store.throwBeforeSuccessfulResult = false;
    await requireFreshApprovalOnReplacement(h, turn.id);
  });

  it("requires new consent after owner loss while an already-dispatched effect has no durable result", async () => {
    const h = await setup({ holdUntilOwnerLost: true });
    const { turn } = await h.host.startTurn(owner, h.session.id, request());
    await h.host.resolveApproval(owner, h.session.id, (await pending(h, h.host)).id, "acceptForSession");
    await h.dispatched.promise;
    expect(h.calls()).toBe(1);
    expect((await h.store.getSession(owner.tenantId, h.session.id))?.autoApprovedTools).not.toContain(SCOPE);
    // Trigger the real Host renewal/fence/abort path; the tool settles on that actual signal.
    await h.lease.expire(h.session.id);
    await oldHostStopped(h);
    expect(h.store.successfulResultFaults).toBe(0);
    expect(h.observations).toEqual([{ turnId: turn.id, grants: [], startedAtMs: expect.any(Number) }]);
    await requireFreshApprovalOnReplacement(h, turn.id);
  });
});
