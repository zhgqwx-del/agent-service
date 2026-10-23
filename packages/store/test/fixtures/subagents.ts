import { randomUUID } from "node:crypto";
import { AgentDefinition, SubagentPolicy, emptyUsageAccumulator, type Item, type ModelRef, type Turn } from "@agent-service/protocol";
import { attachSessionWriteAdmission, createSessionAcquireCommand, newUsageId } from "../../src/index.js";
import type { CommitBatch, SessionStore } from "../../src/types.js";
import * as A from "../../src/subagents.js";
import { mkSession, newId } from "../conformance.js";

export const subagentLimits = { maxSteps: 8, maxToolCalls: 8, maxWallClockMs: 30_000, maxCostCNY: 10, maxOutputTokensPerStep: 1024 };
export const subagentModel = { provider: "fixture-provider", model: "fixture-model" };
export async function subagentFixture(store: SessionStore, options: { maxSteps?: number; maxTasks?: number; allowSelf?: boolean; selfAlias?: boolean; resolvedModel?: ModelRef; initialResolvedModel?: ModelRef } = {}) {
  const principal = { tenantId: `subagent-${newId("tenant")}`, userId: "owner" }, now = Date.now();
  const child = AgentDefinition.parse({ id: newId("agt"), tenantId: principal.tenantId, version: 1, name: "child", model: subagentModel, tools: ["current_time"], createdAtMs: now });
  const rootId = newId("agt");
  const policy = SubagentPolicy.parse({ allowSelf: options.allowSelf ?? false, targets: [{ name: "child", agentId: child.id, agentVersion: 1 }, ...(options.selfAlias ? [{ name: "alias", agentId: rootId, agentVersion: 1 }] : [])], maxDepth: 3, maxConcurrent: 2, maxTasks: options.maxTasks ?? 4 });
  const agent = AgentDefinition.parse({ id: rootId, tenantId: principal.tenantId, version: 1, name: "root", model: subagentModel, tools: ["task", "current_time"], subagents: policy, createdAtMs: now });
  await store.createAgent(agent); await store.createAgent(child);
  const session = { ...mkSession(principal.tenantId, principal.userId), agentId: agent.id, usage: emptyUsageAccumulator() };
  await store.createSession(session);
  const leaseCommand = createSessionAcquireCommand({ sessionId: session.id, principal,
    runnerId: "subagent-store-fixture", runnerAddr: "http://127.0.0.1:10001", bootId: randomUUID(),
    acquisitionId: randomUUID(), expectedFence: 0, ttlMs: subagentLimits.maxWallClockMs });
  const granted = await store.sessionAuthority.acquire(leaseCommand);
  if (!granted.ok || granted.fence !== 1) throw new Error("Subagent fixture authority is unavailable.");
  const proof = granted.proof;
  await store.commit(attachSessionWriteAdmission({ sessionId: session.id, fence: 1, fenceClaim: principal }, proof));
  const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", model: options.resolvedModel ?? subagentModel, seqStart: 2, steps: 0, toolCalls: 0, usage: emptyUsageAccumulator(), startedAtMs: now };
  const access = attachSessionWriteAdmission(A.createSubagentRootAccess({ principal, rootSessionId: session.id, rootTurnId: turn.id, rootFence: 1 }), proof);
  const limits = { ...subagentLimits, maxSteps: options.maxSteps ?? subagentLimits.maxSteps };
  const authority: A.SubagentAuthoritySnapshot = { agentId: agent.id, agentVersion: 1, model: subagentModel, toolNames: ["task", "current_time"],
    approvalRequiredTools: ["task"], toolContractSha256ByName: { task: "a".repeat(64), current_time: "b".repeat(64) }, approvalPolicy: "on-request", contextEpoch: "fixture-epoch" };
  const spec: A.SubagentRootSpecification = { policy, limits, authority, initialResolvedModel: options.initialResolvedModel ?? options.resolvedModel ?? subagentModel, deadlineAtMs: now + limits.maxWallClockMs };
  const user: Item = { id: newId("item"), sessionId: session.id, turnId: turn.id, seq: 0, type: "userMessage", content: [{ type: "text", text: "Parent request" }], status: "completed", createdAtMs: now, completedAtMs: now };
  await store.commit(A.attachSubagentCommitAdmission({ sessionId: session.id, fence: 1, turn, items: [user], sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } },
    events: [{ type: "turn/started", sessionId: session.id, turn, emittedAtMs: now }, { type: "item/completed", sessionId: session.id, item: user, emittedAtMs: now }] }, { access, root: spec }));
  return { store, principal, agent, child, session, turn, access, spec, proof, leaseCommand };
}
export type SubagentFixture = Awaited<ReturnType<typeof subagentFixture>>;
export async function subagentTaskRequest(f: SubagentFixture, options: { step?: number; toolCallId?: string; prompt?: string; target?: string; resolvedModel?: ModelRef; initialResolvedModel?: ModelRef } = {}) {
  const now = Date.now(), step = options.step ?? 1, prompt = options.prompt ?? "Perform the bounded child task.";
  const call: Extract<Item, { type: "toolCall" }> = { id: newId("item"), sessionId: f.session.id, turnId: f.turn.id, type: "toolCall", name: "task", kind: "builtin", toolCallId: options.toolCallId ?? "task-call", args: { target: options.target ?? "child", prompt }, seq: 0, step, status: "inProgress", createdAtMs: now };
  await f.store.commit(A.attachSubagentCommitAdmission({ sessionId: f.session.id, fence: 1, items: [call], events: [{ type: "item/started", sessionId: f.session.id, item: call, emittedAtMs: now }] }, { access: f.access }));
  await f.store.admitSubagentBudget({ access: f.access, kind: "tool_call", step, callItemId: call.id, effectiveLimits: f.spec.limits, effectiveDeadlineAtMs: f.spec.deadlineAtMs });
  call.startedAtMs = now;
  await f.store.commit(A.attachSubagentCommitAdmission({ sessionId: f.session.id, fence: 1, items: [call] }, { access: f.access }));
  const session = { ...mkSession(f.principal.tenantId, f.principal.userId), agentId: f.child.id, parentSessionId: f.session.id, usage: emptyUsageAccumulator() };
  const turn: Turn = { id: newId("turn"), sessionId: session.id, status: "inProgress", model: options.resolvedModel ?? subagentModel, seqStart: 2, steps: 0, toolCalls: 0, usage: emptyUsageAccumulator(), startedAtMs: now };
  const taskId = newId("sat"), user: Item = { id: newId("item"), type: "userMessage", sessionId: session.id, turnId: turn.id, seq: 0, status: "completed", content: [{ type: "text", text: prompt }], createdAtMs: now, completedAtMs: now };
  const activity: Extract<Item, { type: "subagentActivity" }> = { id: newId("item"), type: "subagentActivity", sessionId: f.session.id, turnId: f.turn.id, seq: 0, status: "inProgress", createdAtMs: now,
    taskId, rootSessionId: f.session.id, rootTurnId: f.turn.id, parentCallItemId: call.id, childSessionId: session.id, childTurnId: turn.id, agentId: f.child.id, agentVersion: 1, depth: 1, taskStatus: "reserved" };
  const input: A.CreateSubagentTaskInput = { access: f.access, taskId, parentCallItemId: call.id, initialResolvedModel: options.initialResolvedModel ?? options.resolvedModel ?? subagentModel,
    authority: { agentId: f.child.id, agentVersion: 1, model: subagentModel, toolNames: ["current_time"], approvalRequiredTools: [], toolContractSha256ByName: { current_time: "b".repeat(64) }, approvalPolicy: "on-request", contextEpoch: "fixture-epoch" },
    limits: { ...f.spec.limits }, selectedPolicy: null, deadlineAtMs: f.spec.deadlineAtMs, childSession: session,
    childBatch: { sessionId: session.id, fence: 1, turn, items: [user], sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } },
      events: [{ type: "turn/started", sessionId: session.id, turn, emittedAtMs: now }, { type: "item/completed", sessionId: session.id, item: user, emittedAtMs: now }] },
    parentActivityBatch: { sessionId: f.session.id, fence: 1, items: [activity], events: [{ type: "item/started", sessionId: f.session.id, item: activity, emittedAtMs: now }] } };
  attachSessionWriteAdmission(input.childBatch, f.proof); attachSessionWriteAdmission(input.parentActivityBatch, f.proof);
  attachSessionWriteAdmission(input, f.proof);
  return { input, call, activity, session, turn };
}
export function subagentProviderInput(f: SubagentFixture, access = f.access, step = 1): A.AdmitSubagentBudgetInput {
  return attachSessionWriteAdmission({ access, kind: "provider_step" as const, step, provider: { ...subagentModel, lifecycleSha256: null, contextEpoch: "fixture-epoch" }, effectiveLimits: f.spec.limits, effectiveDeadlineAtMs: f.spec.deadlineAtMs }, f.proof);
}
export function subagentUsageBatch(f: SubagentFixture, sessionId: string, turnId: string, step: number, costCNY = 0.1): CommitBatch {
  const usage = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 5, costCNY };
  return attachSessionWriteAdmission({ sessionId, fence: 1, usageEntries: [{ usageId: newUsageId(), turnId, step, provider: subagentModel.provider, model: subagentModel.model, usage, createdAtMs: Date.now() }] }, f.proof);
}
