import type { SessionAuthority } from "@agent-service/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, emptyUsage, type AgentDefinition, type Item, type Principal } from "@agent-service/protocol";
import { MemoryEventBus, MemorySessionStore } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type ResolvedModel, type RunnerTool, type SkillSource, type Summariser } from "../src/index.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import type { LoadedStaticSkill, StaticSkillLoadInput } from "../src/skills/static.js";
import { collectResolvedSkillContexts, projectItems } from "../src/context/history.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

// Host/store contracts with an injected source. Filesystem parsing and real HTTP/Pi bootstraps
// have independent suites; these doubles are not evidence of either external boundary.
const owner: Principal = { tenantId: "t_skills", userId: "u_owner" };
const body = "Keep this exact skill instruction and its established identifiers.";
const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 32_000,
  input: ["text"], apiKey: async () => "unused-fixture" };
const echo: RunnerTool = { name: "echo", kind: "builtin", description: "echo", parameters: { type: "object" },
  readOnly: true, execute: async () => ({ content: [{ type: "text", text: "echo" }] }) };
function skill(patch: Partial<LoadedStaticSkill> = {}): LoadedStaticSkill {
  return { id: "guide", name: "guide", description: "A bounded static guide", whenToUse: "A guide is needed",
    contentSha256: "a".repeat(64), versionSha256: "b".repeat(64), body,
    disableModelInvocation: false, userInvocable: true, dependencies: { tools: [] }, ...patch };
}
class Catalog implements SkillSource {
  enabled = true;
  entry = skill();
  extraEntries: LoadedStaticSkill[] = [];
  readonly listed: Principal[] = [];
  readonly loads: StaticSkillLoadInput[] = [];
  listWait: ((signal: AbortSignal) => Promise<void>) | undefined;
  loadWait: ((input: StaticSkillLoadInput, signal: AbortSignal) => Promise<void>) | undefined;
  transform: ((loaded: LoadedStaticSkill) => LoadedStaticSkill) | undefined;
  validateMounts(principal: Principal, ids: readonly string[]): void {
    if (principal.tenantId !== owner.tenantId || principal.userId !== owner.userId
      || ids.some(id => ![this.entry, ...this.extraEntries].some(entry => entry.id === id))) {
      throw new ApiError("not_found", "Skill not found.");
    }
  }
  async list(principal: Principal, ids: string[], signal: AbortSignal) {
    this.validateMounts(principal, ids); this.listed.push({ ...principal });
    await this.listWait?.(signal);
    return [this.entry, ...this.extraEntries].filter(entry => ids.includes(entry.id)).map(entry => {
      const { body: _body, ...summary } = entry; return structuredClone(summary);
    });
  }
  async load(principal: Principal, ids: readonly string[], input: StaticSkillLoadInput, signal: AbortSignal) {
    this.validateMounts(principal, ids); this.loads.push(structuredClone(input));
    if (signal.aborted) throw new ApiError("draining", "Skill request unavailable.");
    const entry = [this.entry, ...this.extraEntries].find(entry => entry.name === input.name && ids.includes(entry.id));
    if (!entry || input.expectedVersionSha256 !== entry.versionSha256) throw new ApiError("invalid_request", "Skill request failed.");
    if (input.invocation === "model" && entry.disableModelInvocation || input.invocation === "user" && !entry.userInvocable) throw new ApiError("not_found", "Skill not found.");
    if (entry.dependencies.tools.some(tool => !input.availableTools.includes(tool))) throw new ApiError("invalid_request", "Skill request failed.");
    const loaded = structuredClone(entry); await this.loadWait?.(input, signal);
    return this.transform?.(loaded) ?? loaded;
  }
}
const fixtures: { host: SessionHost; bus: MemoryEventBus; lease: SessionAuthority }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) { await fixture.host.drain(0); await fixture.bus.close(); await fixture.lease.close(); }
});
async function setup(options: { source?: SkillSource | null; script?: ScriptStep[]; tools?: RunnerTool[]; mounts?: string[];
  model?: ResolvedModel; summariser?: Summariser; runtime?: TenantRuntimeCoordinator; leaseTtlMs?: number } = {}) {
  const store = new MemorySessionStore(), bus = new MemoryEventBus(), lease = store.sessionAuthority;
  const source = options.source === null ? undefined : options.source ?? new Catalog();
  const engine = new ScriptedEngine(options.script ?? [{ text: "done" }]);
  const tools = options.tools ?? [echo];
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "skills",
    instructions: "Use only the mounted tools.", model: { provider: "fake", model: "fake" }, tools: tools.map(tool => tool.name),
    mcpServers: [], skills: options.mounts ?? ["guide"], limits: {}, approvalPolicy: "untrusted", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const host = new SessionHost({ store, bus, lease, engine, tools: new StaticToolRegistry(tools), skills: source,
    providers: { resolve: async () => options.model ?? model }, summariser: options.summariser, tenantRuntime: options.runtime,
    config: { runnerId: "r_skills", runnerAddr: "127.0.0.1:1", leaseTtlMs: options.leaseTtlMs ?? 2_000, leaseHoldMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} } });
  fixtures.push({ host, bus, lease });
  return { host, store, bus, lease, engine, agent, source };
}
const request = (input: ({ type: "text"; text: string } | { type: "skill"; name: string; args?: string })[] = [{ type: "text", text: "use the guide" }]) => ({ input, stream: true, metadata: {} });
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const until = Date.now() + 2_000;
  while (Date.now() < until) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Skill fixture did not settle.");
}
async function finish(h: Awaited<ReturnType<typeof setup>>, sessionId: string, turnId: string) {
  return waitFor(async () => { const turn = await h.store.getTurn(sessionId, turnId); return turn?.status !== "inProgress" ? turn ?? undefined : undefined; });
}

describe("SessionHost static skills", () => {
  it("uses the delegated session owner and leaves no session/event on an unauthorized mount", async () => {
    const source = new Catalog(), h = await setup({ source });
    const caller = { ...owner, userId: "u_trusted_caller" };
    const session = await h.host.createSession(caller, { agentId: h.agent.id, userId: owner.userId, metadata: {} });
    expect(source.listed).toEqual([owner]); expect(source.loads).toEqual([]);
    expect((await h.store.readEvents(session.id, 0, 10)).map(event => event.type)).toEqual(["session/created"]);
    await expect(h.host.createSession(caller, { agentId: h.agent.id, metadata: {} })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.host.getSession(caller, session.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(h.host.getSession({ ...owner, tenantId: "other" }, session.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await h.store.listSessions(owner.tenantId, { limit: 20 })).data).toHaveLength(1);
  });

  it("fails closed without a configured source and never executes a list-only provider", async () => {
    const absent = await setup({ source: null });
    await expect(absent.host.createSession(owner, { agentId: absent.agent.id, metadata: {} })).rejects.toMatchObject({ code: "invalid_request" });
    const legacy: SkillSource = { list: async () => [{ name: "guide", description: "metadata only" }] };
    const h = await setup({ source: legacy, script: [{ toolCalls: [{ name: "skill", args: { name: "guide" } }] }] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    await expect(h.host.beginTurn(owner, session.id, request([{ type: "skill", name: "guide" }]))).rejects.toMatchObject({ code: "invalid_request" });
    const turn = await h.host.startTurn(owner, session.id, request()); await finish(h, session.id, turn.turn.id);
    expect(h.engine.executedToolCalls).toBe(0);
    expect(h.engine.received[0]?.systemPrompt).not.toContain("Use the `skill` tool");
  });

  it("rejects disabled or unmounted skill input before steer admission can persist a receipt", async () => {
    const h = await setup({ source: null, mounts: [], script: [{ text: "done", delayMs: 80 }] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request());
    await expect(h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }]),
      { idempotencyKey: "disabled-skill-steer" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.host.steer(owner, session.id, turn.turn.id, { input: [{ type: "skill", name: "guide" }] }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(await h.store.getIdempotencyKey({ ...owner, userId: owner.userId!, sessionId: session.id }, "disabled-skill-steer")).toBeNull();
    expect(h.engine.steers).toEqual([]);
    expect((await h.store.listItems(session.id, { limit: 100 })).filter(item => item.type === "userMessage")).toHaveLength(1);
    await finish(h, session.id, turn.turn.id);
    const enabled = new Catalog(), gated = await setup({ source: enabled, script: [{ text: "done", delayMs: 80 }] });
    const gatedSession = await gated.host.createSession(owner, { agentId: gated.agent.id, metadata: {} });
    const gatedTurn = await gated.host.startTurn(owner, gatedSession.id, request()); enabled.enabled = false;
    await expect(gated.host.steer(owner, gatedSession.id, gatedTurn.turn.id, { input: [{ type: "skill", name: "guide" }] }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(gated.engine.steers).toEqual([]); await finish(gated, gatedSession.id, gatedTurn.turn.id);
  });

  it("loads through a real Host tool, persists exact result metadata and feeds its result into the next step", async () => {
    const source = new Catalog(), h = await setup({ source, script: [
      { toolCalls: [{ name: "skill", args: { name: "guide" } }] },
      { text: results => results[0]?.content.some(part => part.type === "text" && part.text.includes(body)) ? "loaded" : "missing" },
    ] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request());
    expect(await finish(h, session.id, turn.turn.id)).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    expect(source.loads).toEqual([{ name: "guide", invocation: "model", availableTools: ["echo", "skill"], expectedVersionSha256: source.entry.versionSha256 }]);
    const items = await h.store.listItems(session.id, { limit: 100 });
    expect(items.find(item => item.type === "toolCall")).toMatchObject({ kind: "skill", name: "skill", startedAtMs: expect.any(Number) });
    expect(items.find(item => item.type === "toolResult")).toMatchObject({ isError: false, details: { skillContext: { body, versionSha256: source.entry.versionSha256 } } });
    expect(items.find(item => item.type === "agentMessage" && item.text === "loaded")).toBeDefined();
    expect(await h.store.listApprovals(session.id, {})).toEqual([]);
  });

  it("hides model-disabled skills but permits explicit user invocation only when user-invocable", async () => {
    const source = new Catalog(); source.entry = skill({ disableModelInvocation: true });
    const h = await setup({ source, script: [{ text: "done", delayMs: 30 }] }); const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const turn = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide", args: "use this exact argument" }]));
    await h.host.steer(owner, session.id, turn.turn.id, { input: [{ type: "skill", name: "guide", args: "steered argument" }] });
    await finish(h, session.id, turn.turn.id);
    expect(h.engine.received[0]?.systemPrompt).not.toContain("<available_skills>");
    expect(JSON.stringify(h.engine.received[0]?.input)).toContain(body);
    expect(JSON.stringify(h.engine.received[0]?.input)).toContain("use this exact argument");
    expect(JSON.stringify(h.engine.steers)).toContain("steered argument");
    expect(JSON.stringify(h.engine.steers)).toContain(body);
    const stored = (await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "userMessage");
    expect(stored).toMatchObject({ content: [{ type: "skill", name: "guide", args: "use this exact argument" }], skillContexts: [{ body }] });
    source.entry = skill({ userInvocable: false });
    await expect(h.host.beginTurn(owner, session.id, request([{ type: "skill", name: "guide" }]))).rejects.toMatchObject({ code: "not_found" });
  });

  it("checks dependencies against the final dynamic-inclusive tool set and rejects skill name collisions", async () => {
    const source = new Catalog(); source.entry = skill({ dependencies: { tools: ["needed"] } });
    const h = await setup({ source }); const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    await expect(h.host.beginTurn(owner, session.id, request())).rejects.toMatchObject({ code: "invalid_request", message: "Skill dependencies are unavailable." });
    const turn = await h.host.startTurn(owner, session.id, { ...request(), dynamicTools: [{ name: "needed", description: "client", parameters: { type: "object" } }] });
    await finish(h, session.id, turn.turn.id);
    await expect(h.host.beginTurn(owner, session.id, { ...request(), dynamicTools: [{ name: "skill", description: "collision", parameters: { type: "object" } }] })).rejects.toMatchObject({ code: "invalid_request", message: "tool names collide" });
    const builtin = await setup({ tools: [{ ...echo, name: "skill" }] });
    await expect(builtin.host.createSession(owner, { agentId: builtin.agent.id, metadata: {} })).rejects.toMatchObject({ code: "invalid_request", message: "tool names collide" });
  });

  it("bounds internal skill requests before persisting any turn or user message", async () => {
    const h = await setup(), session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const invalid = [request([{ type: "skill", name: "guide", args: "x".repeat(8_193) }]),
      request([{ type: "skill", name: "guide" }, { type: "skill", name: "guide" }]), request([{ type: "skill", name: "UPPER" }])];
    for (const input of invalid) await expect(h.host.beginTurn(owner, session.id, input)).rejects.toMatchObject({ code: "invalid_request" });
    expect(await h.store.listTurns(session.id, { limit: 100 })).toMatchObject({ data: [] });
    expect(await h.store.listItems(session.id, { limit: 100 })).toEqual([]);
    expect((await h.store.getSession(owner.tenantId, session.id))?.lastSeq).toBe(1);
  });

  it("bumps the skill epoch with the next turn but replays the old durable body without loading it again", async () => {
    const source = new Catalog(), h = await setup({ source });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const firstInput = request([{ type: "skill", name: "guide" }]);
    const first = await h.host.startTurn(owner, session.id, firstInput, { idempotencyKey: "skill-original" });
    await finish(h, session.id, first.turn.id); const firstEpoch = (await h.store.getSession(owner.tenantId, session.id))!.contextEpoch;
    source.entry = skill({ body: "new body not yet loaded", contentSha256: "c".repeat(64), versionSha256: "d".repeat(64) });
    const replay = await h.host.beginTurn(owner, session.id, firstInput, { idempotencyKey: "skill-original" });
    expect(replay.replayed).toBe(true); expect(source.loads).toHaveLength(1);
    const second = await h.host.startTurn(owner, session.id, request()); await finish(h, session.id, second.turn.id);
    expect((await h.store.getSession(owner.tenantId, session.id))?.contextEpoch).not.toBe(firstEpoch);
    expect(JSON.stringify(h.engine.received[1]?.history)).toContain(body);
    expect(JSON.stringify(h.engine.received[1]?.history)).not.toContain("new body not yet loaded");
    const events = await h.store.readEvents(session.id, 0, 100);
    expect(events.some(event => event.type === "warning" && event.code === "skill_catalog_changed")).toBe(true);
    expect(events.some(event => event.type === "item/completed" && event.item.type === "systemNotice" && event.item.kind === "toolsChanged")).toBe(true);
    expect(source.loads).toHaveLength(1);
  });

  it("carries the exact snapshot through real Host compaction even when the summary omits its body", async () => {
    const source = new Catalog(), summaryInputs: string[] = [];
    const h = await setup({ source, summariser: { summarise: async input => { summaryInputs.push(input.text); return { text: "A conversation happened.", usage: emptyUsage() }; } } });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const first = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }])); await finish(h, session.id, first.turn.id);
    for (let i = 0; i < 4; i++) { const turn = await h.host.startTurn(owner, session.id, request([{ type: "text", text: `message-${i} ${"long history ".repeat(200)}` }])); await finish(h, session.id, turn.turn.id); }
    expect(await h.host.compactSession(owner, session.id)).toMatchObject({ compacted: true });
    const items = await h.store.listItems(session.id, { limit: 100 });
    const compacted = items.filter((item): item is Extract<Item, { type: "contextCompaction" }> => item.type === "contextCompaction").at(-1)!;
    expect(compacted.skillContexts).toEqual([expect.objectContaining({ body, versionSha256: "b".repeat(64) })]);
    expect(summaryInputs.join("\n")).toContain(body);
    source.entry = skill({ body: "later bytes", contentSha256: "c".repeat(64), versionSha256: "d".repeat(64) });
    expect(JSON.stringify(projectItems(items).messages)).toContain(body);
    expect(source.loads).toHaveLength(1);
  });

  it("rejects over-budget or drifted loaded snapshots before the user message commit", async () => {
    const source = new Catalog(); source.entry = skill({ body: "x".repeat(4_000) });
    const h = await setup({ source, model: { ...model, contextWindow: 128 } });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    await expect(h.host.beginTurn(owner, session.id, request([{ type: "skill", name: "guide" }]))).rejects.toMatchObject({ code: "invalid_request", message: "Skill context budget exceeded." });
    source.transform = loaded => ({ ...loaded, versionSha256: "f".repeat(64) });
    await expect(h.host.beginTurn(owner, session.id, request([{ type: "skill", name: "guide" }]))).rejects.toMatchObject({ code: "invalid_request", message: "Skill request failed." });
    expect((await h.store.listTurns(session.id, { limit: 10 })).data).toEqual([]);
    expect(await h.store.listItems(session.id, { limit: 100 })).toEqual([]);
  });

  it("rejects a ninth version before input commit and returns a snapshot-free model error without poisoning the next turn", async () => {
    const source = new Catalog(), script: ScriptStep[] = [{ text: "done" }], h = await setup({ source, script });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    for (let version = 1; version <= 8; version++) {
      source.entry = skill({ versionSha256: version.toString(16).padStart(64, "0") });
      const turn = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }]));
      await finish(h, session.id, turn.turn.id);
    }
    source.entry = skill({ versionSha256: "9".padStart(64, "0") });
    await expect(h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }]),
      { idempotencyKey: "ninth-version" })).rejects.toMatchObject({ code: "invalid_request", message: "Skill context budget exceeded." });
    expect((await h.store.listTurns(session.id, { limit: 100 })).data).toHaveLength(8);
    expect(await h.store.getIdempotencyKey({ ...owner, userId: owner.userId!, sessionId: session.id }, "ninth-version")).toBeNull();
    script.splice(0, script.length, { toolCalls: [{ name: "skill", args: { name: "guide" } }] }, { text: "recovered" });
    const limited = await h.host.startTurn(owner, session.id, request()); await finish(h, session.id, limited.turn.id);
    const limitedResult = (await h.store.listItems(session.id, { limit: 200 })).find(item => item.type === "toolResult" && item.turnId === limited.turn.id);
    expect(limitedResult).toMatchObject({ isError: true, content: [{ type: "text", text: "Skill request failed." }] });
    expect(limitedResult).not.toHaveProperty("details.skillContext");
    script.splice(0, script.length, { text: "ordinary next turn" });
    const next = await h.host.startTurn(owner, session.id, request());
    expect(await finish(h, session.id, next.turn.id)).toMatchObject({ status: "completed" });
    const items = await h.store.listItems(session.id, { limit: 200 });
    expect(collectResolvedSkillContexts(items)).toHaveLength(8); expect(() => projectItems(items)).not.toThrow();
  });

  it("bounds the cumulative UTF-8 snapshot union before a third individually valid input can commit", async () => {
    const source = new Catalog(), h = await setup({ source, model: { ...model, contextWindow: 128_000 } });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    for (let version = 1; version <= 2; version++) {
      source.entry = skill({ body: "é".repeat(15_500), versionSha256: version.toString(16).padStart(64, "0") });
      const turn = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }])); await finish(h, session.id, turn.turn.id);
    }
    source.entry = skill({ body: "é".repeat(1_500), versionSha256: "3".padStart(64, "0") });
    await expect(h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }]),
      { idempotencyKey: "byte-limit" })).rejects.toMatchObject({ code: "invalid_request", message: "Skill context budget exceeded." });
    expect((await h.store.listTurns(session.id, { limit: 100 })).data).toHaveLength(2);
    expect(await h.store.getIdempotencyKey({ ...owner, userId: owner.userId!, sessionId: session.id }, "byte-limit")).toBeNull();
    const next = await h.host.startTurn(owner, session.id, request());
    expect(await finish(h, session.id, next.turn.id)).toMatchObject({ status: "completed" });
    expect(collectResolvedSkillContexts(await h.store.listItems(session.id, { limit: 100 }))).toHaveLength(2);
  });

  it("shares one synchronous prospective union between concurrent model load and user steer", async () => {
    const source = new Catalog(), script: ScriptStep[] = [{ text: "done" }];
    source.extraEntries = [skill({ id: "other", name: "other", versionSha256: "f".repeat(64) })];
    const h = await setup({ source, script, mounts: ["guide", "other"] });
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    for (let version = 1; version <= 7; version++) {
      source.entry = skill({ versionSha256: version.toString(16).padStart(64, "0") });
      const turn = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "guide" }])); await finish(h, session.id, turn.turn.id);
    }
    source.entry = skill({ versionSha256: "8".padStart(64, "0") });
    let enterModel!: () => void, enterUser!: () => void, release!: () => void;
    const modelEntered = new Promise<void>(resolve => { enterModel = resolve; });
    const userEntered = new Promise<void>(resolve => { enterUser = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    source.loadWait = async input => { (input.invocation === "model" ? enterModel : enterUser)(); await barrier; };
    script.splice(0, script.length, { toolCalls: [{ name: "skill", args: { name: "guide" } }] }, { text: "settled" });
    try {
      const turn = await h.host.startTurn(owner, session.id, request()); await modelEntered;
      const steered = h.host.steer(owner, session.id, turn.turn.id, { input: [{ type: "skill", name: "other" }] })
        .then(() => ({ accepted: true as const }), error => ({ accepted: false as const, error }));
      await userEntered; release(); const steerResult = await steered; await finish(h, session.id, turn.turn.id);
      const items = await h.store.listItems(session.id, { limit: 200 });
      const result = items.find((item): item is Extract<Item, { type: "toolResult" }> => item.type === "toolResult" && item.turnId === turn.turn.id)!;
      if (!steerResult.accepted) expect(steerResult.error).toMatchObject({ code: "invalid_request", message: "Skill context budget exceeded." });
      expect(Number(steerResult.accepted) + Number(!result.isError)).toBe(1);
      if (result.isError) expect(result).not.toHaveProperty("details.skillContext");
      expect(collectResolvedSkillContexts(items)).toHaveLength(8); expect(() => projectItems(items)).not.toThrow();
      source.loadWait = undefined; script.splice(0, script.length, { text: "still usable" });
      const next = await h.host.startTurn(owner, session.id, request());
      expect(await finish(h, session.id, next.turn.id)).toMatchObject({ status: "completed" });
    } finally { release(); source.loadWait = undefined; }
  });

  it.each(["lease", "tenant"] as const)("cancels in-flight skill discovery on %s ownership loss without a turn commit", async kind => {
    const source = new Catalog(), runtime = kind === "tenant" ? new TenantRuntimeCoordinator() : undefined;
    const h = await setup({ source, runtime, leaseTtlMs: 60 });
    runtime?.sealParticipants();
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    let entered!: () => void, cancelled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    source.listWait = signal => new Promise<void>((_resolve, reject) => {
      entered(); const abort = () => { cancelled = true; reject(new ApiError("draining", "Skill request unavailable.")); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    });
    if (kind === "lease") vi.spyOn(h.lease, "renew").mockResolvedValue(false);
    const begun = h.host.beginTurn(owner, session.id, request());
    const rejected = expect(begun).rejects.toMatchObject({ code: kind === "lease" ? "session_lease_conflict" : "draining" });
    await started;
    const drained = runtime?.drain({ requestId: "ter_skills", tenantId: owner.tenantId, subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 1_000);
    await rejected; await drained;
    expect(cancelled).toBe(true);
    expect((await h.store.listTurns(session.id, { limit: 10 })).data).toEqual([]);
  });
});
