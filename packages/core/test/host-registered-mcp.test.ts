import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type AgentDefinition, type McpRegistrationRef, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore } from "@agent-service/store";
import { SessionHost, type RegisteredMcpSource } from "../src/session/host.js";
import { StaticToolRegistry, type RunnerTool } from "../src/tools/types.js";
import { computeContextEpoch } from "../src/context/assemble.js";
import { newId } from "../src/ids.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

// Host boundary only. The injected directory is not evidence for OAuth, SQL, Redis or network
// behavior; those are exercised by the registered service and product vertical suites.
const owner: Principal = { tenantId: "managed-host", userId: "owner" };
const ref: McpRegistrationRef = { scope: "platform", name: "shared" };
const toolName = "mcp__managed__echo_0123456789abcdef";
function tool(scope = "managed-scope-v1", name = toolName): RunnerTool {
  return { name, description: "Untrusted managed tool", kind: "mcp", parameters: { type: "object" },
    mandatoryApproval: true, approvalScope: scope, readOnly: true, needsApproval: false,
    execute: async () => ({ content: [{ type: "text", text: "approved managed result" }] }) };
}
class Directory implements RegisteredMcpSource {
  enabled = true;
  allowed = owner;
  tools = [tool()];
  validations: { principal: Principal; refs: readonly McpRegistrationRef[] }[] = [];
  discoveries: { principal: Principal; refs: readonly McpRegistrationRef[] }[] = [];
  async validateMounts(p: Principal, refs: readonly McpRegistrationRef[]) {
    this.validations.push({ principal: { ...p }, refs: structuredClone(refs) });
    if (p.tenantId !== this.allowed.tenantId || p.userId !== this.allowed.userId
      || refs.some(r => r.scope !== ref.scope || r.name !== ref.name)) throw new ApiError("not_found", "MCP registration not found.");
  }
  async resolve(p: Principal, refs: readonly McpRegistrationRef[]) {
    this.discoveries.push({ principal: { ...p }, refs: structuredClone(refs) }); return [...this.tools];
  }
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(options: { agent?: Partial<AgentDefinition>; source?: Directory; script?: ScriptStep[];
  legacy?: { ids: string[]; tools: RunnerTool[] } } = {}) {
  const store = new MemorySessionStore(), bus = new MemoryEventBus(), lease = store.sessionAuthority;
  const source = options.source ?? new Directory(), legacyCalls: string[][] = [];
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1,
    name: "Managed MCP host", instructions: "Use only the mounted tools.", model: { provider: "fake", model: "fake" },
    tools: [], mcpServers: [], mcpRegistrations: [ref], skills: [], limits: {}, approvalPolicy: "never",
    busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now(), ...options.agent };
  await store.createAgent(agent);
  const engine = new ScriptedEngine(options.script ?? [{ text: "done" }]);
  const host = new SessionHost({ store, bus, lease, engine, registeredMcp: source,
    ...(options.legacy ? { mcp: { enabled: true,
      validateMounts(_p: Principal, ids: string[]) {
        legacyCalls.push([...ids]); if (JSON.stringify(ids) !== JSON.stringify(options.legacy!.ids)) throw new Error("Unexpected legacy mount");
      }, async resolve() { return options.legacy!.tools; }, async close() {} } } : {}),
    tools: new StaticToolRegistry([]),
    providers: { resolve: async () => ({ handle: {}, provider: "fake", model: "fake", contextWindow: 32_000,
      input: ["text"], apiKey: async () => "unused-fixture" }) },
    config: { runnerId: "managed-host-runner", runnerAddr: "127.0.0.1:1", leaseTtlMs: 2_000, leaseHoldMs: 1 },
    logger: { info() {}, warn() {}, error() {} } });
  cleanups.push(async () => { await host.drain(1_000); await bus.close(); await lease.close(); await store.close(); });
  return { store, host, engine, source, agent, legacyCalls };
}
type Harness = Awaited<ReturnType<typeof setup>>;
const create = (h: Harness, p = owner, userId?: string) => h.host.createSession(p, { agentId: h.agent.id,
  metadata: {}, ...(userId === undefined ? {} : { userId }) });
const request = () => ({ input: [{ type: "text" as const, text: "Use managed tool" }], stream: true, metadata: {} });
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) { const value = await read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Managed MCP host fixture did not settle");
}
const approval = (h: Harness, sessionId: string) => waitFor(async () =>
  (await h.store.listApprovals(sessionId, { pendingOnly: true }))[0]);
const finish = (h: Harness, sessionId: string, turnId: string) => waitFor(async () => {
  const turn = await h.store.getTurn(sessionId, turnId);
  return turn && turn.status !== "inProgress" && !h.host.activeTurn(sessionId) ? turn : undefined;
});

describe("Host explicit managed MCP mount and approval boundary", () => {
  it("validates and discovers as the delegated session owner and binds that catalog into the epoch", async () => {
    const h = await setup(), caller = { ...owner, userId: "trusted-caller" };
    const session = await create(h, caller, owner.userId);
    expect(h.source.validations).toEqual([{ principal: owner, refs: [ref] }]);
    expect(h.source.discoveries).toEqual([{ principal: owner, refs: [ref] }]);
    expect(h.legacyCalls).toEqual([]);
    expect(session.contextEpoch).toBe(computeContextEpoch({ agentId: h.agent.id, agentVersion: 1,
      systemPrompt: h.agent.instructions, tools: h.source.tools, skills: [] }));
    expect((await h.store.readEvents(session.id, 0, 10)).map(e => [e.type, e.seq])).toEqual([["session/created", 1]]);
  });
  it.each([{ ...owner, userId: "other" }, { ...owner, tenantId: "other" }])(
    "does not create a session for a different actual subject (%#)", async principal => {
      const h = await setup({ agent: { tenantId: principal.tenantId } });
      await expect(create(h, principal)).rejects.toMatchObject({ code: "not_found" });
      expect(h.source.discoveries).toEqual([]);
      expect((await h.store.listSessions(principal.tenantId, { limit: 10 })).data).toEqual([]);
    });
  it("fails closed when managed MCP is disabled even though legacy MCP is available", async () => {
    const source = new Directory(); source.enabled = false;
    const h = await setup({ source, legacy: { ids: [], tools: [] } });
    await expect(create(h)).rejects.toMatchObject({ code: "invalid_request", message: "Managed MCP is not configured" });
    expect(source.validations).toEqual([]); expect(source.discoveries).toEqual([]);
    expect((await h.store.listSessions(owner.tenantId, { limit: 10 })).data).toEqual([]);
  });
  it("applies the combined eight-mount budget before either source or persistence", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `legacy-${i}`);
    const h = await setup({ agent: { mcpServers: ids }, legacy: { ids, tools: [] } });
    await expect(create(h)).rejects.toMatchObject({ code: "invalid_request", message: "Too many MCP mounts" });
    expect(h.source.validations).toEqual([]); expect(h.legacyCalls).toEqual([]);
    expect((await h.store.listSessions(owner.tenantId, { limit: 10 })).data).toEqual([]);
  });
  it("keeps identically named legacy ids and managed references in independent namespaces", async () => {
    const legacy = tool("legacy-scope", "mcp__legacy__echo_0123456789abcdef");
    const h = await setup({ agent: { mcpServers: [ref.name] }, legacy: { ids: [ref.name], tools: [legacy] } });
    const session = await create(h);
    expect(h.legacyCalls).toEqual([[ref.name]]); expect(h.source.validations[0]?.refs).toEqual([ref]);
    expect(session.contextEpoch).toBe(computeContextEpoch({ agentId: h.agent.id, agentVersion: 1,
      systemPrompt: h.agent.instructions, tools: [legacy, ...h.source.tools], skills: [] }));
  });
  it("rechecks at turn admission and leaves no turn/item/event when authorization is lost", async () => {
    const h = await setup(), session = await create(h);
    h.source.allowed = { ...owner, userId: "replacement" };
    await expect(h.host.beginTurn(owner, session.id, request())).rejects.toMatchObject({ code: "not_found" });
    expect((await h.store.listTurns(session.id, { limit: 10 })).data).toEqual([]);
    expect(await h.store.listItems(session.id, { limit: 10 })).toEqual([]);
    expect((await h.store.readEvents(session.id, 0, 10)).map(e => e.type)).toEqual(["session/created"]);
    expect(h.engine.received).toEqual([]);
  });
  it("requires mandatory approval under never and removes old grants when the managed scope changes", async () => {
    const h = await setup({ script: [{ toolCalls: [{ name: toolName, args: {} }] }, { text: "done" }] });
    const session = await create(h), first = await h.host.startTurn(owner, session.id, request());
    const firstApproval = await approval(h, session.id); expect(h.engine.executedToolCalls).toBe(0);
    await h.host.resolveApproval(owner, session.id, firstApproval.id, "acceptForSession");
    expect(await finish(h, session.id, first.turn.id)).toMatchObject({ status: "completed" });
    expect(h.engine.executedToolCalls).toBe(1);
    expect((await h.store.getSession(owner.tenantId, session.id))?.autoApprovedTools).toEqual(["managed-scope-v1"]);
    h.source.tools = [tool("managed-scope-v2")];
    const second = await h.host.startTurn(owner, session.id, request()), nextApproval = await approval(h, session.id);
    expect(nextApproval.turnId).toBe(second.turn.id); expect(h.engine.executedToolCalls).toBe(1);
    expect((await h.store.getSession(owner.tenantId, session.id))?.autoApprovedTools).toEqual([]);
    expect((await h.store.readEvents(session.id, 0, 100)).some(e => e.type === "warning" && e.code === "mcp_catalog_changed")).toBe(true);
    await h.host.resolveApproval(owner, session.id, nextApproval.id, "decline");
    await finish(h, session.id, second.turn.id); expect(h.engine.executedToolCalls).toBe(1);
  });
  it("rejects a cross-source tool name collision before creating a session", async () => {
    const h = await setup({ agent: { mcpServers: ["legacy"] }, legacy: { ids: ["legacy"], tools: [tool()] } });
    await expect(create(h)).rejects.toMatchObject({ code: "invalid_request", message: "tool names collide" });
    expect((await h.store.listSessions(owner.tenantId, { limit: 10 })).data).toEqual([]);
  });
});
