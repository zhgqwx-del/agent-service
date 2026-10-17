import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentDefinition, type Principal } from "@agent-service/protocol";
import { createSkillRegistryAccess, MemoryBlobStore, MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { RegisteredSkillService } from "../src/skills/registered.js";
import { SessionHost } from "../src/session/host.js";
import { StaticToolRegistry } from "../src/tools/types.js";
import { newId } from "../src/ids.js";
import { ScriptedEngine, type ScriptStep } from "./fake-engine.js";

const owner: Principal = { tenantId: "registered-host", userId: "owner" };
const skillOwner = { scope: "user" as const, tenantId: owner.tenantId, userId: owner.userId };
const document = (body: string) => Buffer.from(`---\nname: review\ndescription: Review a requested change\n---\n${body}\n`);
const signal = () => new AbortController().signal;
const fixtures: { host: SessionHost; source: RegisteredSkillService; bus: MemoryEventBus; lease: MemoryLeaseStore }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.host.drain(0); await f.source.close(); await f.bus.close(); await f.lease.close(); }
  vi.restoreAllMocks();
});
async function setup(script: ScriptStep[] = [{ text: "done" }]) {
  const store = new MemorySessionStore(), blobs = new MemoryBlobStore(), bus = new MemoryEventBus(), lease = new MemoryLeaseStore();
  const seen: Principal[] = [];
  const source = new RegisteredSkillService({ store, blobs, namespaceSha256: "a".repeat(64), authorizeSubject: async p => { seen.push({ ...p }); } });
  const install = (body: string, expectedRevision = 0, idempotencyKey = "first") => source.install(skillOwner, {
    access: createSkillRegistryAccess({ owner: skillOwner, principal: owner, authority: "user_self", access: "manage" }),
    document: document(body), expectedRevision, idempotencyKey,
  }, signal());
  const version = await install("Original immutable instruction."); seen.length = 0;
  const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "registered",
    instructions: "Use only the mounted tools.", model: { provider: "fake", model: "fake" }, tools: [],
    mcpServers: [], skills: ["registry:review"], limits: {}, approvalPolicy: "never", busyPolicy: "steer", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
  await store.createAgent(agent);
  const engine = new ScriptedEngine(script);
  const host = new SessionHost({ store, bus, lease, engine, tools: new StaticToolRegistry([]), skills: source,
    providers: { resolve: async () => ({ handle: {}, provider: "fake", model: "fake", contextWindow: 32_000, input: ["text"], apiKey: async () => "unused-fixture" }) },
    config: { runnerId: "registered-host-runner", runnerAddr: "127.0.0.1:1", leaseTtlMs: 2000, leaseHoldMs: 1 },
    logger: { info: () => {}, warn: () => {}, error: () => {} } });
  fixtures.push({ host, source, bus, lease });
  return { host, source, store, bus, lease, engine, agent, version, install, seen };
}
function request(input: ({ type: "text"; text: string } | { type: "skill"; name: string; args?: string })[] = [{ type: "text", text: "Review this" }]) {
  return { input, stream: true, metadata: {} };
}
async function finish(h: Awaited<ReturnType<typeof setup>>, sessionId: string, turnId: string) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const turn = await h.store.getTurn(sessionId, turnId); if (turn && turn.status !== "inProgress") return turn;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Registered skill Host fixture did not settle.");
}

describe("Host actual registered skill selection and durable history", () => {
  it("awaits registry mount validation using the actual delegated session owner", async () => {
    const h = await setup(), caller = { ...owner, userId: "trusted-caller" };
    const session = await h.host.createSession(caller, { agentId: h.agent.id, userId: owner.userId, metadata: {} });
    expect(h.seen.length).toBeGreaterThan(0); expect(h.seen.every(p => p.tenantId === owner.tenantId && p.userId === owner.userId)).toBe(true);
    await expect(h.host.createSession(caller, { agentId: h.agent.id, metadata: {} })).rejects.toMatchObject({ code: "not_found" });
    expect((await h.store.listSessions(owner.tenantId, { limit: 20 })).data).toHaveLength(1);
    expect((await h.store.readEvents(session.id, 0, 10)).map(event => event.type)).toEqual(["session/created"]);
    await expect(h.host.getSession(caller, session.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("applies an authorized immutable override to the actual model tool and second model step", async () => {
    const h = await setup([
      { toolCalls: [{ name: "skill", args: { name: "review" } }] },
      { text: results => results.some(result => JSON.stringify(result).includes("Original immutable instruction.")) ? "loaded original" : "wrong version" },
    ]);
    const newer = await h.install("New current instruction.", 1, "second");
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const begun = await h.host.startTurn(owner, session.id, { ...request(), skillOverrides: [{ name: "review", versionId: h.version.versionId }] });
    expect(await finish(h, session.id, begun.turn.id)).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
    const items = await h.store.listItems(session.id, { limit: 100 });
    expect(items.find(item => item.type === "toolCall")).toMatchObject({ name: "skill", kind: "skill", startedAtMs: expect.any(Number) });
    expect(items.find(item => item.type === "toolResult")).toMatchObject({ isError: false, details: { skillContext: {
      id: h.version.slotId, name: "review", contentSha256: h.version.sha256, versionSha256: h.version.versionSha256, body: "Original immutable instruction.\n",
    } } });
    expect(items.find(item => item.type === "agentMessage" && item.text === "loaded original")).toBeDefined();
    expect(JSON.stringify(items)).not.toContain(newer.storageKey); expect(await h.store.listApprovals(session.id, {})).toEqual([]);
  });
  it("persists explicit-input version snapshots and binds overrides into the idempotency body hash", async () => {
    const h = await setup(), v2 = await h.install("Second immutable instruction.", 1, "second");
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const req = { ...request([{ type: "skill", name: "review", args: "literal user argument" }]), skillOverrides: [{ name: "review", versionId: h.version.versionId }] };
    const first = await h.host.startTurn(owner, session.id, req, { idempotencyKey: "same-request" }); await finish(h, session.id, first.turn.id);
    expect(JSON.stringify(h.engine.received[0]!.input)).toContain("Original immutable instruction.");
    expect(JSON.stringify(h.engine.received[0]!.input)).toContain("literal user argument");
    const userItem = (await h.store.listItems(session.id, { limit: 100 })).find(item => item.type === "userMessage");
    expect(userItem).toMatchObject({ content: [{ type: "skill", name: "review", args: "literal user argument" }], skillContexts: [{
      versionSha256: h.version.versionSha256, contentSha256: h.version.sha256, body: "Original immutable instruction.\n",
    }] });
    expect((await h.host.beginTurn(owner, session.id, req, { idempotencyKey: "same-request" })).replayed).toBe(true);
    await expect(h.host.beginTurn(owner, session.id, { ...req, skillOverrides: [{ name: "review", versionId: v2.versionId }] }, { idempotencyKey: "same-request" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(h.engine.received).toHaveLength(1);
  });
  it("keeps the accepted override for steer and refuses to replace an active turn selection", async () => {
    const h = await setup([{ text: "done", delayMs: 120 }]);
    const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const begun = await h.host.startTurn(owner, session.id, { ...request(), skillOverrides: [{ name: "review", versionId: h.version.versionId }] });
    const v2 = await h.install("New head after acceptance.", 1, "second");
    await expect(h.host.beginTurn(owner, session.id, { ...request([{ type: "skill", name: "review" }]), skillOverrides: [{ name: "review", versionId: v2.versionId }] }))
      .rejects.toMatchObject({ code: "invalid_request", message: "Skill overrides cannot change an active turn." });
    await h.host.steer(owner, session.id, begun.turn.id, { input: [{ type: "skill", name: "review", args: "steered" }] });
    expect(JSON.stringify(h.engine.steers)).toContain("Original immutable instruction."); expect(JSON.stringify(h.engine.steers)).not.toContain("New head after acceptance.");
    await finish(h, session.id, begun.turn.id);
    const steered = (await h.store.listItems(session.id, { limit: 100 })).filter(item => item.type === "userMessage").at(-1);
    expect(steered).toMatchObject({ skillContexts: [{ versionSha256: h.version.versionSha256 }] });
  });
  it("never hydrates accepted historical skill authority from a deleted/recreated registry version", async () => {
    const h = await setup(); const session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    const first = await h.host.startTurn(owner, session.id, request([{ type: "skill", name: "review" }])); await finish(h, session.id, first.turn.id);
    await h.source.deleteInstalled(skillOwner, "review", { access: createSkillRegistryAccess({ owner: skillOwner, principal: owner, authority: "user_self", access: "manage" }), expectedRevision: 1, idempotencyKey: "delete" }, signal());
    await h.install("Recreated generation instructions.", 2, "recreate");
    const read = vi.spyOn(h.store, "getReadableSkillVersion");
    const next = await h.host.startTurn(owner, session.id, request()); await finish(h, session.id, next.turn.id);
    expect(JSON.stringify(h.engine.received[1]!.history)).toContain("Original immutable instruction.");
    expect(read.mock.calls.every(([input]) => input.versionId !== h.version.versionId)).toBe(true);
    const items = await h.store.listItems(session.id, { limit: 100 });
    expect(items.some(item => item.type === "systemNotice" && item.kind === "toolsChanged")).toBe(true);
    const events = await h.store.readEvents(session.id, 0, 200);
    expect(events.map(event => event.seq)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  });
  it("cannot use an override to mount a name not in the immutable agent definition", async () => {
    const h = await setup(), session = await h.host.createSession(owner, { agentId: h.agent.id, metadata: {} });
    await expect(h.host.beginTurn(owner, session.id, { ...request(), skillOverrides: [{ name: "unmounted", versionId: h.version.versionId }] }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(h.engine.received).toEqual([]);
    expect((await h.store.listItems(session.id, { limit: 100 })).filter(item => item.type === "userMessage")).toEqual([]);
  });
});
