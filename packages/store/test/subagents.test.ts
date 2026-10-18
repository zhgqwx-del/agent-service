import { describe, expect, it, vi } from "vitest";
import { addUsage, type Item, type Turn } from "@agent-service/protocol";
import { MemorySessionStore } from "../src/memory.js";
import { SubjectDeletingError, newErasureRequestId, userErasureRequestHash } from "../src/subject-lifecycle.js";
import type { MemorySubagentPort } from "../src/memory-subagents.js";
import * as A from "../src/subagents.js";
import type { SubagentImage } from "../src/subagent-state.js";
import { subagentRootKey } from "../src/subagent-state.js";
import { subagentFixture, subagentProviderInput, subagentTaskRequest, subagentUsageBatch, type SubagentFixture } from "./fixtures/subagents.js";
import { mkSession, newId } from "./conformance.js";
import type { CommitBatch } from "../src/types.js";

function image(store: MemorySessionStore, f: SubagentFixture): SubagentImage {
  const domain = Reflect.get(store, "subagents") as { images: Map<string, SubagentImage> };
  return structuredClone(domain.images.get(subagentRootKey(f.session.id, f.turn.id))!);
}
async function completed(f: SubagentFixture, request: Awaited<ReturnType<typeof subagentTaskRequest>>) {
  const result = await f.store.createSubagentTask(request.input), now = Date.now();
  const access = A.createSubagentChildAccess(f.access, { taskId: result.task.taskId, childSessionId: result.childSession.id, childTurnId: result.childTurn.id });
  const turn: Turn = { ...result.childTurn, status: "completed", stopReason: "end_turn", completedAtMs: now };
  const activity: Item = { ...request.activity, status: "completed", taskStatus: "completed", childUsage: turn.usage, completedAtMs: now };
  const childBatch = A.attachSubagentCommitAdmission({ sessionId: turn.sessionId, fence: 1, turn, sessionPatch: { status: { type: "idle" as const } },
    events: [{ type: "turn/completed" as const, sessionId: turn.sessionId, turn, stopReason: "end_turn" as const, emittedAtMs: now }] }, { access });
  const committed = await f.store.completeSubagentTask({ access, childBatch,
    parentActivityBatch: { sessionId: f.session.id, fence: 1, items: [activity], events: [{ type: "item/completed", sessionId: f.session.id, item: activity, emittedAtMs: now }] } });
  return { result, access, committed };
}
async function terminalInput(f: SubagentFixture, request: Awaited<ReturnType<typeof subagentTaskRequest>>,
  child: Awaited<ReturnType<MemorySessionStore["createSubagentTask"]>>, usageBatch?: CommitBatch) {
  const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
  const live = await f.store.getTurn(child.childSession.id, child.childTurn.id); if (!live) throw new Error("Missing actual child turn.");
  const now = Date.now(), usage = (usageBatch?.usageEntries ?? []).reduce((sum, entry) => addUsage(sum, entry.usage), live.usage);
  const turn: Turn = { ...live, usage, status: "interrupted", stopReason: "interrupted", completedAtMs: now };
  const activity: Item = { ...request.activity, status: "failed", taskStatus: "interrupted", childUsage: usage, completedAtMs: now };
  return { access, childBatch: A.attachSubagentCommitAdmission({ sessionId: child.childSession.id, fence: 1, turn, usageEntries: usageBatch?.usageEntries,
    sessionPatch: { status: { type: "idle" as const } }, events: [{ type: "turn/completed" as const, sessionId: child.childSession.id, turn, stopReason: "interrupted" as const, emittedAtMs: now }] }, { access }),
    parentActivityBatch: { sessionId: f.session.id, fence: 1, items: [activity], events: [{ type: "item/completed" as const, sessionId: f.session.id, item: activity, emittedAtMs: now }] } };
}
describe("subagent original authority and real Memory atomic business transactions", () => {
  it("reserves actual child session, seq1, first turn/input and parent activity atomically", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f);
    const before = (await store.getSession(f.principal.tenantId, f.session.id))!.lastSeq, result = await store.createSubagentTask(request.input);
    expect(result.task.status).toBe("reserved"); expect(result.childSession.parentSessionId).toBe(f.session.id);
    expect(result.childSession.fenceToken).toBe(1); expect(result.childTurn.seqStart).toBe(2);
    expect(result.childCommit.events.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(result.childCommit.events.map(event => event.type)).toEqual(["session/created", "turn/started", "item/completed"]);
    expect(result.parentCommit.lastSeq).toBe(before + 1);
    expect((await store.getSubagentRoot({ access: f.access }))?.activeTasks).toBe(1);
    expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: result.childSession.id })).toEqual({ rootSessionId: f.session.id, rootTurnId: f.turn.id, taskId: result.task.taskId });
  });
  it("exactly replays the same caller input after real seq backfill without another child or event", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f);
    const first = await store.createSubagentTask(request.input), parent = await store.getSession(f.principal.tenantId, f.session.id);
    expect(request.activity.seq).toBeGreaterThan(0);
    const replay = await store.createSubagentTask(request.input);
    expect(replay.replayed).toBe(true); expect(replay.task.taskId).toBe(first.task.taskId);
    expect(replay.childCommit.events).toEqual([]); expect(replay.parentCommit.events).toEqual([]);
    expect(await store.getSession(f.principal.tenantId, f.session.id)).toEqual(parent);
    expect((await store.listSubagentTasks({ principal: f.principal, rootSessionId: f.session.id }))).toHaveLength(1);
  });
  it("does not treat equal JSON or a cloned opaque member as authority", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store);
    await expect(store.admitSubagentBudget({ ...subagentProviderInput(f), access: structuredClone(f.access) })).rejects.toThrow(A.SubagentIntegrityError);
    expect(await store.getSubagentTask({ principal: { ...f.principal, userId: "other" }, rootSessionId: f.session.id, taskId: newId("sat") })).toBeNull();
    expect(await store.getSubagentSessionMember({ principal: { ...f.principal, tenantId: "other" }, sessionId: f.session.id })).toBeNull();
  });
  it("ordinary, missing and foreign membership lookups neither run a write gate nor create subject records", async () => {
    const store = new MemorySessionStore(), absent = { tenantId: `absent-${newId("tenant")}`, userId: "owner" };
    expect(await store.getSubagentSessionMember({ principal: absent, sessionId: newId("sess") })).toBeNull();
    expect(await store.getSubjectLifecycle(absent.tenantId, "tenant", absent.tenantId)).toBeNull();
    expect(await store.getSubjectLifecycle(absent.tenantId, "user", absent.userId)).toBeNull();
    const f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const port = Reflect.get(Reflect.get(store, "subagents"), "port") as MemorySubagentPort, gate = vi.spyOn(port, "gate");
    try {
      expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: f.session.id })).toBeNull();
      expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: newId("sess") })).toBeNull();
      expect(await store.getSubagentSessionMember({ principal: { ...f.principal, userId: "other" }, sessionId: child.childSession.id })).toBeNull();
      expect(gate).not.toHaveBeenCalled();
      expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).toEqual({ rootSessionId: f.session.id, rootTurnId: f.turn.id, taskId: child.task.taskId });
      expect(gate).toHaveBeenCalledTimes(1); expect(gate).toHaveBeenCalledWith(f.principal);
    } finally { gate.mockRestore(); }
  });
  it("hides an ordinary or managed membership after real user erasure without weakening creation or dispatch gates", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const erasure = await store.requestUserErasure({ requestId: newErasureRequestId(), ...f.principal, requestedByKeyId: "admin-key", idempotencyKey: "membership-hidden",
      requestHash: userErasureRequestHash(f.principal.tenantId, f.principal.userId), atMs: Date.now() });
    expect(erasure.status).toBe("gated");
    const before = { root: structuredClone(store.sessions.get(f.session.id)), child: structuredClone(store.sessions.get(child.childSession.id)),
      items: structuredClone([...store.items]), ledger: structuredClone(store.usageLedger), lifecycle: await store.getSubjectLifecycle(f.principal.tenantId, "user", f.principal.userId) };
    expect(before.lifecycle?.state).toBe("deleting");
    expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: f.session.id })).toBeNull();
    expect(await store.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).toBeNull();
    expect({ root: store.sessions.get(f.session.id), child: store.sessions.get(child.childSession.id), items: [...store.items], ledger: store.usageLedger,
      lifecycle: await store.getSubjectLifecycle(f.principal.tenantId, "user", f.principal.userId) }).toEqual(before);
    await expect(store.createSession(mkSession(f.principal.tenantId, f.principal.userId))).rejects.toBeInstanceOf(SubjectDeletingError);
    await expect(store.admitSubagentBudget(subagentProviderInput(f))).rejects.toBeInstanceOf(SubjectDeletingError);
  });
  it("does not hide integrity, SQL-shaped or merely named errors from an exact managed membership gate", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const port = Reflect.get(Reflect.get(store, "subagents"), "port") as MemorySubagentPort, gate = vi.spyOn(port, "gate");
    try {
      for (const error of [new A.SubagentIntegrityError(), Object.assign(new Error("controlled database failure"), { errno: 1213, code: "ER_LOCK_DEADLOCK" }),
        Object.assign(new Error("not the lifecycle class"), { name: "SubjectDeletingError" })]) {
        gate.mockImplementationOnce(() => { throw error; });
        await expect(store.getSubagentSessionMember({ principal: f.principal, sessionId: child.childSession.id })).rejects.toBe(error);
      }
    } finally { gate.mockRestore(); }
  });
  it("rejects ordinary root and managed-child writers including independent child fence claims", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    await expect(store.commit({ sessionId: f.session.id, fence: 1, sessionPatch: { title: "unadmitted" } })).rejects.toThrow(A.SubagentManagedSessionError);
    await expect(store.commit({ sessionId: child.childSession.id, fence: 2, fenceClaim: f.principal })).rejects.toThrow(A.SubagentManagedSessionError);
    await expect(store.commit({ sessionId: child.childSession.id, fence: 1, sessionPatch: { title: "unadmitted" } })).rejects.toThrow(A.SubagentManagedSessionError);
    await expect(store.createSession({ ...mkSession(f.principal.tenantId, f.principal.userId), parentSessionId: child.childSession.id })).rejects.toThrow(A.SubagentManagedSessionError);
  });
  it("rejects post-admission business mutation and only transfers canonical identical trusted clones", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), before = await store.getSession(f.principal.tenantId, f.session.id);
    const batch = A.attachSubagentCommitAdmission({ sessionId: f.session.id, fence: 1, sessionPatch: { title: "bound" } }, { access: f.access });
    const clone = structuredClone(batch); A.transferSubagentCommitAdmission(batch, clone); expect(A.captureSubagentCommitAdmission(clone)).toBeDefined();
    batch.sessionPatch.title = "changed";
    await expect(store.commit(batch)).rejects.toThrow(A.SubagentIntegrityError);
    expect(() => A.transferSubagentCommitAdmission(clone, { ...clone, fence: 2 })).toThrow(A.SubagentIntegrityError);
    expect(await store.getSession(f.principal.tenantId, f.session.id)).toEqual(before);
  });
  it("rolls back child, seq, input, subject writes and activity after a late parent publication failure", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), before = await store.getSession(f.principal.tenantId, f.session.id), root = await store.getSubagentRoot({ access: f.access });
    const spy = vi.spyOn(store.items, "set").mockImplementation(function (key, value) {
      if (key === request.activity.id) throw new Error("controlled publication failure");
      return Map.prototype.set.call(store.items, key, value);
    });
    try { await expect(store.createSubagentTask(request.input)).rejects.toThrow("controlled publication failure"); } finally { spy.mockRestore(); }
    expect(await store.getSession(f.principal.tenantId, request.session.id)).toBeNull();
    expect(await store.readEvents(request.session.id, 0, 100)).toEqual([]); expect(store.turns.has(request.turn.id)).toBe(false);
    expect(await store.getSession(f.principal.tenantId, f.session.id)).toEqual(before);
    expect(await store.getSubagentRoot({ access: f.access })).toEqual(root); expect(image(store, f).tasks).toEqual([]);
  });
  it("does not publish a child or count when first-input serialization fails", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f);
    const metadata = { get invalid() { throw new Error("controlled serialization failure"); } };
    request.input.childSession.metadata = metadata;
    await expect(store.createSubagentTask(request.input)).rejects.toThrow();
    expect(await store.getSession(f.principal.tenantId, request.session.id)).toBeNull(); expect(image(store, f).root?.taskCount).toBe(0);
  });
  it("serializes root and child admissions against one exact shared provider-step cap", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store, { maxSteps: 1 }), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    const decisions = await Promise.all([store.admitSubagentBudget(subagentProviderInput(f)), store.admitSubagentBudget(subagentProviderInput(f, access))]);
    expect(decisions.filter(result => result.admitted)).toHaveLength(1); expect(decisions.filter(result => !result.admitted)[0]?.reason).toBe("max_steps");
    expect(image(store, f).root?.steps).toBe(1); expect(image(store, f).budgets.filter(entry => entry.kind === "provider_step")).toHaveLength(1);
  });
  it("settles actual child provider billing once while family usage remains only a projection", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    expect((await store.admitSubagentBudget(subagentProviderInput(f, access))).admitted).toBe(true);
    const batch = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1, 0.25);
    await store.commit(A.attachSubagentCommitAdmission(batch, { access }));
    expect(store.usageLedger.filter(row => row.tenantId === f.principal.tenantId)).toHaveLength(1);
    expect([...store.billingUsageFacts.values()].filter(row => row.usageId === batch.usageEntries?.[0]?.usageId)).toHaveLength(1);
    expect((await store.getSubagentRoot({ access: f.access }))?.familyUsage.costCNY).toBe(0.25);
    expect((await store.admitSubagentBudget(subagentProviderInput(f, access))).replayed).toBe(true);
  });
  it("binds actual resolved middleware model rather than the initial agent model", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), input = { ...subagentProviderInput(f),
      provider: { provider: "routed-provider", model: "routed-model", lifecycleSha256: "c".repeat(64), contextEpoch: "fixture-epoch" } };
    await store.admitSubagentBudget(input); const wrong = subagentUsageBatch(f, f.session.id, f.turn.id, 1);
    await expect(store.commit(A.attachSubagentCommitAdmission(wrong, { access: f.access }))).rejects.toThrow(A.SubagentConflictError);
    expect(store.usageLedger).toEqual([]);
    const right = subagentUsageBatch(f, f.session.id, f.turn.id, 1); right.usageEntries![0]!.provider = "routed-provider"; right.usageEntries![0]!.model = "routed-model";
    await store.commit(A.attachSubagentCommitAdmission(right, { access: f.access })); expect(image(store, f).root?.familyUsage.costCNY).toBe(0.1);
  });
  it("separates configured pins from actual first-turn providers and records only the real resolved usage", async () => {
    const store = new MemorySessionStore(), rootResolved = { provider: "platform:fixture-provider", model: "fixture-model" },
      childResolved = { provider: "tenant:fixture-provider", model: "fixture-model", reasoning: "low" as const };
    const f = await subagentFixture(store, { resolvedModel: rootResolved }), request = await subagentTaskRequest(f, { resolvedModel: childResolved });
    const child = await store.createSubagentTask(request.input), access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    expect(image(store, f).root).toMatchObject({ authority: { model: { provider: "fixture-provider" } }, initialResolvedModel: rootResolved });
    expect(child.task).toMatchObject({ authority: { model: { provider: "fixture-provider" } }, initialResolvedModel: childResolved });
    expect(child.childTurn.model).toEqual(childResolved);
    await store.admitSubagentBudget({ ...subagentProviderInput(f, access), provider: { provider: childResolved.provider, model: childResolved.model, lifecycleSha256: null, contextEpoch: "fixture-epoch" } });
    const wrong = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1);
    await expect(store.commit(A.attachSubagentCommitAdmission(wrong, { access }))).rejects.toThrow(A.SubagentConflictError);
    const actual = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1); actual.usageEntries![0]!.provider = childResolved.provider;
    await store.commit(A.attachSubagentCommitAdmission(actual, { access }));
    expect(store.usageLedger).toHaveLength(1); expect(store.usageLedger[0]).toMatchObject({ tenantId: f.principal.tenantId, userId: f.principal.userId, provider: childResolved.provider });
    expect([...store.billingUsageFacts.values()]).toHaveLength(1);
  });
  it("rejects mismatched initial resolved identities without weakening the immutable child target pin", async () => {
    const badRoot = new MemorySessionStore();
    await expect(subagentFixture(badRoot, { resolvedModel: { provider: "platform:fixture-provider", model: "fixture-model" },
      initialResolvedModel: { provider: "fixture-provider", model: "fixture-model" } })).rejects.toThrow(A.SubagentConflictError);
    expect(badRoot.turns.size).toBe(0);
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f, { resolvedModel: { provider: "platform:fixture-provider", model: "fixture-model" } });
    await expect(store.createSubagentTask({ ...request.input, initialResolvedModel: { provider: "fixture-provider", model: "fixture-model" } })).rejects.toThrow(A.SubagentConflictError);
    await expect(store.createSubagentTask({ ...request.input, authority: { ...request.input.authority, model: { provider: "platform:fixture-provider", model: "fixture-model" } } })).rejects.toThrow(A.SubagentConflictError);
    expect(image(store, f).tasks).toEqual([]); expect(await store.getSession(f.principal.tenantId, request.session.id)).toBeNull();
  });
  it("monotonically tightens native limits without refund or declaring existing usage corrupt", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store);
    await store.admitSubagentBudget(subagentProviderInput(f));
    const decision = await store.admitSubagentBudget({ ...subagentProviderInput(f, f.access, 2), effectiveLimits: { ...f.spec.limits, maxSteps: 1 } });
    expect(decision).toMatchObject({ admitted: false, reason: "max_steps", root: { steps: 1, state: "closing", effectiveLimits: { maxSteps: 1 } } });
    expect((await store.admitSubagentBudget(subagentProviderInput(f, f.access, 3))).admitted).toBe(false);
    expect(image(store, f).root?.effectiveLimits.maxSteps).toBe(1);
  });
  it("unknown actual usage closes new family admission and is never treated as a refunded step", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store); await store.admitSubagentBudget(subagentProviderInput(f));
    const batch = subagentUsageBatch(f, f.session.id, f.turn.id, 1); delete batch.usageEntries![0]!.usage.costCNY;
    await store.commit(A.attachSubagentCommitAdmission(batch, { access: f.access }));
    expect((await store.admitSubagentBudget(subagentProviderInput(f, f.access, 2)))).toMatchObject({ admitted: false, reason: "max_cost" });
    expect(image(store, f).root?.steps).toBe(1); expect(image(store, f).root?.familyUsage.costCNY).toBeUndefined();
  });
  it("a terminal child with an unanswered provider reservation closes family admission without refund or invented billing", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const terminal = await terminalInput(f, request, child); await store.admitSubagentBudget(subagentProviderInput(f, terminal.access));
    await store.completeSubagentTask(terminal);
    expect(image(store, f).root).toMatchObject({ state: "closing", stopReason: "max_cost", steps: 1, toolCalls: 1, taskCount: 1, activeTasks: 0 });
    expect(image(store, f).budgets.find(entry => entry.kind === "provider_step")).toMatchObject({ state: "outcome_unknown", usageId: null, usage: null });
    expect((await store.admitSubagentBudget(subagentProviderInput(f, f.access, 2)))).toMatchObject({ admitted: false, reason: "max_cost" });
    expect(store.usageLedger).toEqual([]); expect([...store.billingUsageFacts.values()]).toEqual([]);
    expect(image(store, f).root?.familyUsage.totalTokens).toBe(0); expect(image(store, f).root?.steps).toBe(1);
  });
  it("settles actual usage in the terminal child batch before closing only the still-unknown reservations", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    await store.admitSubagentBudget(subagentProviderInput(f, access)); const usage = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1, 0.25);
    await store.completeSubagentTask(await terminalInput(f, request, child, usage));
    expect(image(store, f).budgets.find(entry => entry.kind === "provider_step")).toMatchObject({ state: "settled", usageId: usage.usageEntries?.[0]?.usageId });
    expect(image(store, f).root).toMatchObject({ state: "active", activeTasks: 0, steps: 1, familyUsage: { totalTokens: 5, costCNY: 0.25 } });
    expect(store.usageLedger).toHaveLength(1); expect([...store.billingUsageFacts.values()]).toHaveLength(1);
    expect((await store.admitSubagentBudget(subagentProviderInput(f, f.access, 2)))).toMatchObject({ admitted: true });
  });
  it("same toolCallId across steps settles only the actual step and call item budget", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), first = await subagentTaskRequest(f, { step: 1, toolCallId: "reused" }), second = await subagentTaskRequest(f, { step: 2, toolCallId: "reused" });
    const result: Item = { id: newId("item"), sessionId: f.session.id, turnId: f.turn.id, seq: 0, type: "toolResult", toolCallId: "reused", name: "task", step: 2, status: "completed", isError: false, content: [{ type: "text", text: "result" }], createdAtMs: Date.now() };
    await store.commit(A.attachSubagentCommitAdmission({ sessionId: f.session.id, fence: 1, items: [result] }, { access: f.access }));
    expect(image(store, f).budgets.find(entry => entry.callItemId === first.call.id)?.state).toBe("admitted");
    expect(image(store, f).budgets.find(entry => entry.callItemId === second.call.id)?.state).toBe("settled");
  });
  it("same-name tools cannot replace their schema/scope contract or shed required approval", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f);
    await expect(store.createSubagentTask({ ...request.input, authority: { ...request.input.authority, toolContractSha256ByName: { current_time: "c".repeat(64) } } })).rejects.toThrow(A.SubagentConflictError);
    expect(image(store, f).tasks).toEqual([]);
  });
  it("an explicit named alias cannot bypass allowSelf=false for actual root identity", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store, { selfAlias: true }), request = await subagentTaskRequest(f, { target: "alias" });
    request.input.childSession.agentId = f.agent.id; request.activity.agentId = f.agent.id;
    await expect(store.createSubagentTask({ ...request.input, authority: { ...request.input.authority, agentId: f.agent.id } })).rejects.toThrow(A.SubagentConflictError);
    expect(image(store, f).tasks).toEqual([]);
  });
  it("root takeover makes old admissions unknown and repairs real child turns without redispatch", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    await store.admitSubagentBudget(subagentProviderInput(f, access));
    await store.commit({ sessionId: f.session.id, fence: 2, fenceClaim: f.principal });
    await expect(store.admitSubagentBudget(subagentProviderInput(f, access, 2))).rejects.toThrow(A.SubagentConflictError);
    const repaired = await store.repairSubagentRoot({ principal: f.principal, rootSessionId: f.session.id, rootTurnId: f.turn.id, newFence: 2 });
    expect(repaired[0]?.status).toBe("outcome_unknown"); expect(await store.getTurn(child.childSession.id, child.childTurn.id)).toMatchObject({ status: "interrupted" });
    expect(await store.getSession(f.principal.tenantId, child.childSession.id)).toMatchObject({ status: { type: "idle" }, fenceToken: 2 });
    expect(image(store, f).budgets.find(entry => entry.kind === "provider_step")?.state).toBe("outcome_unknown"); expect(store.usageLedger).toEqual([]);
  });
  it("takeover and repair retain the canonical billed child usage rather than its initial empty turn JSON", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), child = await store.createSubagentTask(request.input);
    const access = A.createSubagentChildAccess(f.access, { taskId: child.task.taskId, childSessionId: child.childSession.id, childTurnId: child.childTurn.id });
    await store.admitSubagentBudget(subagentProviderInput(f, access)); const usage = subagentUsageBatch(f, child.childSession.id, child.childTurn.id, 1, 0.25);
    await store.commit(A.attachSubagentCommitAdmission(usage, { access })); await store.admitSubagentBudget(subagentProviderInput(f, access, 2));
    const canonical = await store.getTurn(child.childSession.id, child.childTurn.id); if (!canonical) throw new Error("Missing child usage projection.");
    expect(canonical.usage.totalTokens).toBe(5);
    await store.commit({ sessionId: f.session.id, fence: 2, fenceClaim: f.principal });
    expect((await store.getSubagentTask({ principal: f.principal, rootSessionId: f.session.id, taskId: child.task.taskId }))?.childUsage).toEqual(canonical.usage);
    const repaired = await store.repairSubagentRoot({ principal: f.principal, rootSessionId: f.session.id, rootTurnId: f.turn.id, newFence: 2 });
    expect(repaired[0]).toMatchObject({ status: "outcome_unknown", childUsage: canonical.usage });
    expect((await store.getTurn(child.childSession.id, child.childTurn.id))?.usage).toEqual(canonical.usage);
    expect(store.items.get(request.activity.id)).toMatchObject({ taskStatus: "outcome_unknown", childUsage: canonical.usage });
    expect(image(store, f).budgets.filter(entry => entry.kind === "provider_step").map(entry => entry.state)).toEqual(["settled", "outcome_unknown"]);
    expect(image(store, f).root).toMatchObject({ steps: 2, familyUsage: canonical.usage });
    expect(store.usageLedger).toHaveLength(1); expect([...store.billingUsageFacts.values()]).toHaveLength(1);
  });
  it("completes canonical child and parent activity together, then explicitly tombstones terminal child under fresh root fence", async () => {
    const store = new MemorySessionStore(), f = await subagentFixture(store), request = await subagentTaskRequest(f), done = await completed(f, request);
    expect(done.committed.task.status).toBe("completed"); expect((await store.getSubagentRoot({ access: f.access }))?.activeTasks).toBe(0);
    await store.commit({ sessionId: f.session.id, fence: 2, fenceClaim: f.principal });
    const access = A.createSubagentRootAccess({ principal: f.principal, rootSessionId: f.session.id, rootTurnId: f.turn.id, rootFence: 2 }), now = Date.now();
    const batch = { sessionId: done.result.childSession.id, fence: 2, lifecycle: { type: "tombstone" as const, ...f.principal, atMs: now, deletionGeneration: 1 },
      events: [{ type: "session/deleted" as const, sessionId: done.result.childSession.id, deletionGeneration: 1, emittedAtMs: now }] };
    await expect(store.commitOrdinarySessionDelete(batch)).rejects.toThrow(A.SubagentManagedSessionError);
    const result = await store.deleteSubagentTaskSession({ access, taskId: done.result.task.taskId, batch });
    expect(result.lifecycleGeneration).toBe(1); await store.sealOrdinarySessionDeleteGrace(f.principal.tenantId, f.principal.userId, done.result.childSession.id);
    expect(await store.getSession(f.principal.tenantId, done.result.childSession.id)).toBeNull();
    expect((await store.getOrdinarySessionDeleteGrace(f.principal.tenantId, f.principal.userId, done.result.childSession.id))?.state).toBe("sealed");
    expect(image(store, f).tasks).toHaveLength(1); expect(image(store, f).budgets).toHaveLength(1);
  });
  it("canonical tool maps preserve the legal own __proto__ contract leaf", () => {
    const contracts: Record<string, string> = {}; Object.defineProperty(contracts, "__proto__", { value: "a".repeat(64), enumerable: true });
    expect(A.subagentCanonical(contracts)).toBe(`{"__proto__":"${"a".repeat(64)}"}`);
    expect(A.subagentDigest(contracts)).not.toBe(A.subagentDigest({}));
  });
});
