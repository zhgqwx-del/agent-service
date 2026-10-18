import { Event as EventSchema, ModelRef, SubagentPolicy, SubagentTaskInput, Usage, addUsage, emptyUsageAccumulator,
  type AgentDefinition, type Item, type Principal, type Session, type Turn } from "@agent-service/protocol";
import type { CommitBatch } from "./types.js";
import * as A from "./subagents.js";

export interface SubagentImage {
  root: A.SubagentRootRecord | null;
  tasks: A.SubagentTaskRecord[];
  budgets: A.SubagentBudgetEntry[];
}
export interface SubagentMemberSource { session: Session; turn: Turn; agent: AgentDefinition; call?: Item }
export const emptySubagentImage = (): SubagentImage => ({ root: null, tasks: [], budgets: [] });
function fail(): never { throw new A.SubagentIntegrityError(); }
function conflict(): never { throw new A.SubagentConflictError(); }
const same = (a: unknown, b: unknown) => A.subagentCanonical(a) === A.subagentCanonical(b);
const active = (task: A.SubagentTaskRecord) => task.status === "reserved" || task.status === "running";
export const subagentRootKey = (sessionId: string, turnId: string) => A.subagentDigest(["subagent-root-v1", sessionId, turnId]);
export const subagentBudgetKey = (root: { rootSessionId: string; rootTurnId: string }, sessionId: string, turnId: string, kind: string, step: number, callItemId: string | null) =>
  A.subagentDigest(["subagent-budget-v1", root.rootSessionId, root.rootTurnId, sessionId, turnId, kind, step, callItemId]);
function rootProfile(root: A.SubagentRootSpecification & { principal: Principal; rootSessionId: string; rootTurnId: string; rootFence: number }) {
  return { profile: "subagent-root-v1", principal: root.principal, rootSessionId: root.rootSessionId, rootTurnId: root.rootTurnId,
    rootFence: root.rootFence, policy: root.policy, limits: root.limits, deadlineAtMs: root.deadlineAtMs, authority: root.authority,
    initialResolvedModel: root.initialResolvedModel };
}
function limits(value: Required<import("@agent-service/protocol").Limits>) {
  A.subagentClosed(value, ["maxSteps", "maxToolCalls", "maxWallClockMs", "maxCostCNY", "maxOutputTokensPerStep"]);
  for (const key of ["maxSteps", "maxToolCalls", "maxWallClockMs", "maxOutputTokensPerStep"] as const) A.subagentNatural(value[key], true);
  if (!Number.isFinite(value.maxCostCNY) || value.maxCostCNY <= 0) fail();
}
function minLimits(a: A.SubagentRootRecord["limits"], b: A.SubagentRootRecord["limits"]) {
  return { maxSteps: Math.min(a.maxSteps, b.maxSteps), maxToolCalls: Math.min(a.maxToolCalls, b.maxToolCalls),
    maxWallClockMs: Math.min(a.maxWallClockMs, b.maxWallClockMs), maxCostCNY: Math.min(a.maxCostCNY, b.maxCostCNY),
    maxOutputTokensPerStep: Math.min(a.maxOutputTokensPerStep, b.maxOutputTokensPerStep) };
}
function authoritySubset(child: A.SubagentAuthoritySnapshot, parent: A.SubagentAuthoritySnapshot) {
  return child.toolNames.every(name => parent.toolNames.includes(name)
    && child.toolContractSha256ByName[name] === parent.toolContractSha256ByName[name]
    && (!parent.approvalRequiredTools.includes(name) || child.approvalRequiredTools.includes(name)));
}
function descendants(image: SubagentImage, task: A.SubagentTaskRecord): Set<string> {
  const sessions = new Set([task.childSessionId]);
  for (let depth = task.depth + 1; depth <= image.root!.policy.maxDepth; depth++) for (const next of image.tasks) {
    if (next.depth === depth && sessions.has(next.parentSessionId)) sessions.add(next.childSessionId);
  }
  return sessions;
}
function ancestry(image: SubagentImage, sessionId: string) {
  const result: A.SubagentTaskRecord[] = []; let current = image.tasks.find(task => task.childSessionId === sessionId);
  while (current) { result.unshift(current); current = image.tasks.find(task => task.childSessionId === current!.parentSessionId); }
  return result;
}
function assertActivityOnly(batch: CommitBatch) {
  if (batch.turn || batch.approvals?.length || batch.blobBindings?.length || batch.usageEntries?.length || batch.idempotency
    || batch.lifecycle || batch.fenceClaim || batch.sessionPatch || batch.items?.length !== 1
    || (batch.events ?? []).some(event => !["item/started", "item/completed"].includes(event.type)
      || !("item" in event) || event.item.id !== batch.items![0]!.id || !same(event.item, batch.items![0]))) conflict();
}
function allowsIdentity(policy: import("@agent-service/protocol").SubagentPolicy, own: A.SubagentAuthoritySnapshot, agent: { id: string; version: number }) {
  return policy.allowSelf && agent.id === own.agentId && agent.version === own.agentVersion
    || policy.targets.some(target => target.agentId === agent.id && target.agentVersion === agent.version);
}
function assertMember(image: SubagentImage, access: A.SubagentMemberAccess, source?: SubagentMemberSource) {
  const member = A.assertSubagentMemberAccess(access), root = image.root;
  if (!root || root.rootSessionId !== member.rootSessionId || root.rootTurnId !== member.rootTurnId || root.rootFence !== member.rootFence
    || !same(root.principal, member.principal)) conflict();
  const task = member.taskId === null ? null : image.tasks.find(row => row.taskId === member.taskId);
  if (member.taskId !== null && (!task || task.childSessionId !== member.sessionId || task.childTurnId !== member.turnId)) conflict();
  if (source && (source.session.id !== member.sessionId || source.turn.id !== member.turnId || source.turn.sessionId !== member.sessionId
    || source.session.tenantId !== member.principal.tenantId || source.session.userId !== member.principal.userId
    || source.session.agentId !== source.agent.id || source.session.agentVersion !== source.agent.version)) conflict();
  return { member, root, task };
}
export function validateSubagentImage(image: SubagentImage): void {
  if (!image.root) { if (image.tasks.length || image.budgets.length) fail(); return; }
  const root = image.root;
  if (!SubagentPolicy.safeParse(root.policy).success || !Usage.safeParse(root.familyUsage).success
    || root.policySha256 !== A.subagentDigest(rootProfile(root))) fail();
  limits(root.limits); limits(root.effectiveLimits); A.validateSubagentAuthority(root.authority); A.validateSubagentResolvedModel(root.initialResolvedModel);
  if (!same(root.effectiveLimits, minLimits(root.limits, root.effectiveLimits)) || root.effectiveDeadlineAtMs > root.deadlineAtMs) fail();
  for (const key of ["rootFence", "createdAtMs", "updatedAtMs", "deadlineAtMs"] as const) A.subagentNatural(root[key], true);
  if (root.updatedAtMs < root.createdAtMs || root.taskCount !== image.tasks.length || root.activeTasks !== image.tasks.filter(active).length
    || root.taskCount > root.policy.maxTasks || root.activeTasks > root.policy.maxConcurrent
    || root.steps !== image.budgets.filter(row => row.kind === "provider_step").length
    || root.toolCalls !== image.budgets.filter(row => row.kind === "tool_call").length
    || root.steps > root.limits.maxSteps || root.toolCalls > root.limits.maxToolCalls) fail();
  const ids = new Set<string>(), children = new Set<string>(), calls = new Set<string>();
  for (const task of image.tasks) {
    if (ids.has(task.taskId) || children.has(task.childSessionId) || calls.has(task.parentCallItemId)
      || task.rootSessionId !== root.rootSessionId || task.rootTurnId !== root.rootTurnId || task.rootFence !== root.rootFence
      || !same(task.principal, root.principal) || task.childSessionId === root.rootSessionId
      || task.depth < 1 || task.depth > root.policy.maxDepth || !Usage.safeParse(task.childUsage).success) fail();
    ids.add(task.taskId); children.add(task.childSessionId); calls.add(task.parentCallItemId);
    limits(task.limits); limits(task.effectiveLimits); A.validateSubagentAuthority(task.authority); A.validateSubagentResolvedModel(task.initialResolvedModel);
    if (!same(task.effectiveLimits, minLimits(task.limits, task.effectiveLimits)) || task.effectiveDeadlineAtMs > task.deadlineAtMs) fail();
    const parent = task.parentSessionId === root.rootSessionId ? null : image.tasks.find(row => row.childSessionId === task.parentSessionId);
    if (task.parentSessionId === root.rootSessionId ? task.parentTurnId !== root.rootTurnId || task.depth !== 1
      : !parent || parent.childTurnId !== task.parentTurnId || task.depth !== parent.depth + 1) fail();
    const authority = parent?.authority ?? root.authority;
    if (!authoritySubset(task.authority, authority)
      || task.selectedPolicy !== null && !SubagentPolicy.safeParse(task.selectedPolicy).success
      || task.selectedPolicy === null && task.authority.toolNames.includes("task")
      || task.deadlineAtMs > root.deadlineAtMs || task.deadlineAtMs <= task.createdAtMs) fail();
    for (const key of Object.keys(root.limits) as (keyof typeof root.limits)[]) if (task.limits[key] > root.limits[key]) fail();
    if (active(task) ? task.completedAtMs !== null : task.completedAtMs === null) fail();
  }
  const entryIds = new Set<string>(); let usage = emptyUsageAccumulator();
  for (const entry of image.budgets) {
    if (entryIds.has(entry.entryId) || entry.rootSessionId !== root.rootSessionId || entry.rootTurnId !== root.rootTurnId || entry.rootFence !== root.rootFence
      || entry.entryId !== subagentBudgetKey(root, entry.sessionId, entry.turnId, entry.kind, entry.step, entry.callItemId)) fail();
    entryIds.add(entry.entryId); A.subagentNatural(entry.step, entry.kind === "tool_call");
    if (entry.sessionId === root.rootSessionId ? entry.turnId !== root.rootTurnId
      : !image.tasks.some(task => task.childSessionId === entry.sessionId && task.childTurnId === entry.turnId)) fail();
    if (entry.kind === "provider_step" && entry.callItemId !== null || entry.kind === "tool_call" && !entry.callItemId) fail();
    if (entry.state === "settled" && entry.kind === "provider_step") {
      if (!entry.usageId || !entry.usage || !Usage.safeParse(entry.usage).success) fail(); usage = addUsage(usage, entry.usage);
    } else if (entry.usageId !== null || entry.usage !== null) fail();
  }
  if (!same(usage, root.familyUsage)) fail();
}
export function beginSubagentRoot(image: SubagentImage, admission: A.CapturedSubagentCommitAdmission, source: SubagentMemberSource, now: number) {
  const { identity, input } = admission, spec = input.root;
  if (!spec || identity.taskId !== null || source.session.id !== identity.rootSessionId || source.turn.id !== identity.rootTurnId
    || source.turn.status !== "inProgress" || source.session.tenantId !== identity.principal.tenantId || source.session.userId !== identity.principal.userId
    || source.agent.tenantId !== identity.principal.tenantId || source.agent.id !== source.session.agentId || source.agent.version !== source.session.agentVersion
    || source.session.fenceToken !== identity.rootFence || source.session.status.type === "active" && source.session.status.turnId !== identity.rootTurnId) conflict();
  const configured = source.agent.subagents;
  if (!configured || spec.policy.context !== "prompt" || spec.policy.allowSelf && !configured.allowSelf
    || spec.policy.targets.some(target => !configured.targets.some(allowed => same(allowed, target)))) conflict();
  for (const key of ["maxDepth", "maxConcurrent", "maxTasks"] as const) if (spec.policy[key] > configured[key]) conflict();
  limits(spec.limits); A.validateSubagentAuthority(spec.authority); A.validateSubagentResolvedModel(spec.initialResolvedModel);
  if (spec.authority.agentId !== source.agent.id || spec.authority.agentVersion !== source.agent.version
    || !same(spec.initialResolvedModel, source.turn.model)
    || spec.deadlineAtMs <= now || spec.deadlineAtMs > now + spec.limits.maxWallClockMs) conflict();
  for (const layer of [configured.limits, source.agent.limits]) for (const key of Object.keys(spec.limits) as (keyof typeof spec.limits)[]) {
    if (layer[key] !== undefined && spec.limits[key] > layer[key]!) conflict();
  }
  const candidate: A.SubagentRootRecord = { ...structuredClone(spec), principal: { ...identity.principal }, rootSessionId: identity.rootSessionId,
    effectiveLimits: { ...spec.limits }, effectiveDeadlineAtMs: spec.deadlineAtMs,
    rootTurnId: identity.rootTurnId, rootFence: identity.rootFence, state: "active", stopReason: null, policySha256: "",
    steps: 0, toolCalls: 0, taskCount: 0, activeTasks: 0, familyUsage: emptyUsageAccumulator(), createdAtMs: now, updatedAtMs: now };
  const next = { ...candidate, policySha256: A.subagentDigest(rootProfile(candidate)) };
  if (image.root) { if (image.root.policySha256 !== next.policySha256) conflict(); return; }
  image.root = next; validateSubagentImage(image);
}
export function admitSubagentBudget(image: SubagentImage, input: A.AdmitSubagentBudgetInput, source: SubagentMemberSource, now: number): A.SubagentBudgetDecision {
  A.subagentClosed(input, ["access", "kind", "step", "callItemId", "provider", "effectiveLimits", "effectiveDeadlineAtMs"]); validateSubagentImage(image);
  let { member, root, task } = assertMember(image, input.access, source); A.subagentNatural(input.step, input.kind === "tool_call");
  limits(input.effectiveLimits); A.subagentNatural(input.effectiveDeadlineAtMs, true);
  const initial = task?.limits ?? root.limits, initialDeadline = task?.deadlineAtMs ?? root.deadlineAtMs;
  if (!same(input.effectiveLimits, minLimits(initial, input.effectiveLimits)) || input.effectiveDeadlineAtMs > initialDeadline) conflict();
  if (task) {
    const sessions = descendants(image, task), effective = minLimits(task.effectiveLimits, input.effectiveLimits), deadline = Math.min(task.effectiveDeadlineAtMs, input.effectiveDeadlineAtMs);
    image.tasks = image.tasks.map(row => active(row) && sessions.has(row.childSessionId) ? { ...row, effectiveLimits: minLimits(row.effectiveLimits, effective), effectiveDeadlineAtMs: Math.min(row.effectiveDeadlineAtMs, deadline) } : row);
    task = image.tasks.find(row => row.taskId === task!.taskId)!;
  } else {
    root = { ...root, effectiveLimits: minLimits(root.effectiveLimits, input.effectiveLimits), effectiveDeadlineAtMs: Math.min(root.effectiveDeadlineAtMs, input.effectiveDeadlineAtMs) };
    image.root = root; image.tasks = image.tasks.map(row => active(row) ? { ...row, effectiveLimits: minLimits(row.effectiveLimits, root.effectiveLimits), effectiveDeadlineAtMs: Math.min(row.effectiveDeadlineAtMs, root.effectiveDeadlineAtMs) } : row);
  }
  if (source.turn.status !== "inProgress" || task && !active(task)) conflict();
  if (input.kind !== "provider_step" && input.kind !== "tool_call" || input.kind === "provider_step" && input.callItemId !== undefined) fail();
  if (input.kind === "provider_step") {
    if (!input.provider) fail(); A.subagentClosed(input.provider, ["provider", "model", "lifecycleSha256", "contextEpoch"]);
    const authority = task?.authority ?? root.authority;
    if (!ModelRef.safeParse({ provider: input.provider.provider, model: input.provider.model }).success || input.provider.contextEpoch !== authority.contextEpoch
      || input.provider.lifecycleSha256 !== null && !/^[a-f0-9]{64}$/.test(input.provider.lifecycleSha256)) fail();
  } else if (input.provider !== undefined) fail();
  const call = source.call;
  if (input.kind === "tool_call" && (!input.callItemId || !call || call.type !== "toolCall" || call.id !== input.callItemId
    || call.sessionId !== member.sessionId || call.turnId !== member.turnId || call.step !== input.step)) conflict();
  const entryId = subagentBudgetKey(root, member.sessionId, member.turnId, input.kind, input.step, input.callItemId ?? null);
  if (image.budgets.some(row => row.entryId === entryId)) return { admitted: false, replayed: true, reason: "error", root };
  let reason = root.stopReason;
  if (root.state !== "active") reason ??= "interrupted";
  else if (now >= root.effectiveDeadlineAtMs) reason = "max_wall_clock";
  else if (root.familyUsage.costCNY === undefined || root.familyUsage.costCNY >= root.effectiveLimits.maxCostCNY) reason = "max_cost";
  else if (input.kind === "provider_step" && root.steps >= root.effectiveLimits.maxSteps) reason = "max_steps";
  else if (input.kind === "tool_call" && root.toolCalls >= root.effectiveLimits.maxToolCalls) reason = "max_tool_calls";
  let localReason: import("@agent-service/protocol").StopReason | null = null;
  for (const ancestor of ancestry(image, member.sessionId)) {
    const members = descendants(image, ancestor), entries = image.budgets.filter(row => members.has(row.sessionId));
    const usage = entries.filter(row => row.usage).reduce((sum, row) => addUsage(sum, row.usage!), emptyUsageAccumulator());
    if (now >= ancestor.effectiveDeadlineAtMs) localReason ??= "max_wall_clock";
    if (usage.costCNY === undefined || usage.costCNY >= ancestor.effectiveLimits.maxCostCNY) localReason ??= "max_cost";
    if (input.kind === "provider_step" && entries.filter(row => row.kind === "provider_step").length >= ancestor.effectiveLimits.maxSteps) localReason ??= "max_steps";
    if (input.kind === "tool_call" && entries.filter(row => row.kind === "tool_call").length >= ancestor.effectiveLimits.maxToolCalls) localReason ??= "max_tool_calls";
  }
  if (reason) { image.root = { ...root, state: root.state === "active" ? "closing" : root.state, stopReason: reason, updatedAtMs: Math.max(now, root.updatedAtMs) };
    return { admitted: false, replayed: false, reason, root: image.root }; }
  if (localReason) return { admitted: false, replayed: false, reason: localReason, root };
  image.budgets.push({ entryId, rootSessionId: root.rootSessionId, rootTurnId: root.rootTurnId, rootFence: root.rootFence,
    sessionId: member.sessionId, turnId: member.turnId, kind: input.kind, step: input.step, callItemId: input.callItemId ?? null,
    provider: input.provider ? structuredClone(input.provider) : null,
    state: "admitted", usageId: null, usage: null, createdAtMs: now, completedAtMs: null });
  if (task && input.kind === "provider_step") image.tasks = image.tasks.map(row => row.taskId === task.taskId ? { ...row, status: "running" } : row);
  image.root = { ...root, steps: root.steps + Number(input.kind === "provider_step"), toolCalls: root.toolCalls + Number(input.kind === "tool_call"), updatedAtMs: Math.max(now, root.updatedAtMs) };
  validateSubagentImage(image); return { admitted: true, replayed: false, root: image.root };
}
export function settleSubagentBusiness(image: SubagentImage, admission: A.CapturedSubagentCommitAdmission, batch: CommitBatch, now: number, durableCalls: readonly Item[] = [], source?: SubagentMemberSource) {
  const { member, root } = assertMember(image, admission.input.access); validateSubagentImage(image);
  if (root.state === "terminal" || root.state === "outcome_unknown" || source && source.turn.status !== "inProgress") {
    // Terminal observers cannot dispatch or amend business state. Original owner/fence and the
    // canonical source row were already rechecked by the adapter inside this same transaction.
    if (admission.input.root || admission.input.finishRoot || batch.turn || batch.sessionPatch || batch.lifecycle || batch.fenceClaim
      || batch.idempotency || batch.items?.length || batch.approvals?.length || batch.usageEntries?.length || batch.blobBindings?.length
      || !batch.events?.length || batch.events.length > 2) conflict();
    for (const event of batch.events) {
      if (!EventSchema.safeParse({ ...event, seq: 1 }).success || event.type !== "lifecycle-hook/started" && event.type !== "lifecycle-hook/completed"
        || event.turnId !== member.turnId || event.sessionId !== member.sessionId || event.phase !== "Stop" && event.phase !== "SubagentStop") conflict();
      if (event.phase === "SubagentStop") {
        const task = image.tasks.find(task => task.taskId === event.taskId);
        if (member.taskId !== null || !task || active(task) || event.childSessionId !== task.childSessionId || event.childTurnId !== task.childTurnId) conflict();
      } else if (event.taskId !== undefined || event.childSessionId !== undefined || event.childTurnId !== undefined) conflict();
      if (event.type === "lifecycle-hook/completed" && event.reports.some(report => report.phase !== event.phase)) conflict();
    }
    return;
  }
  let familyUsage = root.familyUsage;
  for (const usage of batch.usageEntries ?? []) {
    const id = subagentBudgetKey(root, member.sessionId, member.turnId, "provider_step", usage.step, null), entry = image.budgets.find(row => row.entryId === id);
    if (!entry || usage.turnId !== member.turnId || entry.state === "outcome_unknown" || !entry.provider
      || usage.provider !== entry.provider.provider || usage.model !== entry.provider.model) conflict();
    if (entry.state === "settled") { if (entry.usageId !== usage.usageId || !same(entry.usage, usage.usage)) conflict(); continue; }
    if (!Usage.safeParse(usage.usage).success) fail();
    image.budgets = image.budgets.map(row => row.entryId === id ? { ...row, state: "settled", usageId: usage.usageId, usage: structuredClone(usage.usage), completedAtMs: now } : row);
    familyUsage = addUsage(familyUsage, usage.usage);
  }
  for (const item of batch.items ?? []) if (item.type === "toolCall" && item.startedAtMs !== undefined || item.type === "toolResult") {
    if (item.type === "toolResult" && item.step === undefined) conflict();
    const calls = [...durableCalls, ...(batch.items ?? [])].filter((call): call is Extract<Item, { type: "toolCall" }> => call.type === "toolCall"
      && call.sessionId === member.sessionId && call.turnId === member.turnId && call.toolCallId === item.toolCallId
      && call.name === item.name && call.step === item.step).sort((a, b) => b.seq - a.seq);
    const call = item.type === "toolCall" ? item : calls.find(candidate => candidate.startedAtMs !== undefined);
    const entry = call && image.budgets.find(row => row.sessionId === member.sessionId && row.turnId === member.turnId && row.kind === "tool_call" && row.callItemId === call.id);
    // A denied, never-dispatched call may have a result without a reservation. A real started call may not.
    if (call?.startedAtMs !== undefined && !entry) conflict();
    if (item.type === "toolCall" && !durableCalls.some(prior => prior.id === item.id && prior.type === "toolCall" && prior.startedAtMs !== undefined)
      && (root.state !== "active" || now >= root.deadlineAtMs)) conflict();
    if (item.type === "toolResult" && entry && entry.state === "admitted") image.budgets = image.budgets.map(row => row.entryId === entry.entryId
      ? { ...row, state: "settled", completedAtMs: now } : row);
  }
  let state: A.SubagentRootRecord["state"] = root.state, stopReason = root.stopReason;
  if (familyUsage.costCNY === undefined || familyUsage.costCNY >= root.effectiveLimits.maxCostCNY) { state = "closing"; stopReason = "max_cost"; }
  if (admission.input.finishRoot) {
    if (member.taskId !== null || !batch.turn || batch.turn.status === "inProgress" || image.tasks.some(active)) conflict();
    image.budgets = image.budgets.map(entry => entry.state === "admitted" ? { ...entry, state: "outcome_unknown", completedAtMs: now } : entry);
    state = image.budgets.some(entry => entry.kind === "provider_step" && entry.state === "outcome_unknown") ? "outcome_unknown" : "terminal";
  }
  image.root = { ...root, state, stopReason, familyUsage, updatedAtMs: Math.max(now, root.updatedAtMs) }; validateSubagentImage(image);
}

export function stageSubagentTask(image: SubagentImage, input: A.CreateSubagentTaskInput, parent: SubagentMemberSource, target: AgentDefinition, now: number): A.SubagentTaskRecord {
  A.subagentClosed(input, ["access", "taskId", "parentCallItemId", "authority", "initialResolvedModel", "limits", "selectedPolicy", "deadlineAtMs", "childSession", "childBatch", "parentActivityBatch"]);
  validateSubagentImage(image); const { member, root, task: parentTask } = assertMember(image, input.access, parent), call = parent.call;
  if (root.state !== "active" || now >= root.deadlineAtMs || parent.turn.status !== "inProgress" || parentTask && !active(parentTask)) conflict();
  if (!call || call.type !== "toolCall" || call.name !== "task" || call.kind !== "builtin" || call.id !== input.parentCallItemId
    || call.sessionId !== member.sessionId || call.turnId !== member.turnId || call.status !== "inProgress" || call.startedAtMs === undefined) conflict();
  if (!image.budgets.some(entry => entry.kind === "tool_call" && entry.callItemId === call.id && entry.sessionId === member.sessionId && entry.state === "admitted")) conflict();
  const request = SubagentTaskInput.safeParse(call.args); if (!request.success) fail();
  const parentPolicy = parentTask ? parentTask.selectedPolicy : root.policy;
  const targetAllowed = (policy: import("@agent-service/protocol").SubagentPolicy) => request.data.target === "self"
    ? policy.allowSelf && target.id === parent.agent.id && target.version === parent.agent.version
    : policy.targets.some(allowed => allowed.name === request.data.target && allowed.agentId === target.id && allowed.agentVersion === target.version);
  if (!parentPolicy || !targetAllowed(parentPolicy) || !allowsIdentity(root.policy, root.authority, target) || target.tenantId !== root.principal.tenantId) conflict();
  if (target.id === parent.agent.id && target.version === parent.agent.version && !parentPolicy.allowSelf
    || target.id === root.authority.agentId && target.version === root.authority.agentVersion && !root.policy.allowSelf) conflict();
  const depth = (parentTask?.depth ?? 0) + 1, child = input.childSession, turn = input.childBatch.turn;
  if (depth > root.policy.maxDepth || child.id === root.rootSessionId || child.parentSessionId !== member.sessionId
    || child.tenantId !== root.principal.tenantId || child.userId !== root.principal.userId || child.agentId !== target.id || child.agentVersion !== target.version
    || child.lastSeq !== 0 || child.fenceToken !== 0 || child.status.type !== "idle" || child.autoApprovedTools.length
    || !turn || turn.sessionId !== child.id || turn.status !== "inProgress" || input.childBatch.sessionId !== child.id || input.childBatch.fence !== root.rootFence
    || input.childBatch.lifecycle || input.childBatch.fenceClaim || input.childBatch.usageEntries?.length || input.childBatch.approvals?.length
    || input.childBatch.idempotency || input.parentActivityBatch.sessionId !== member.sessionId || input.parentActivityBatch.fence !== root.rootFence
    || (input.childBatch.items ?? []).some(item => item.type !== "userMessage" && item.type !== "systemNotice")
    || input.childBatch.sessionPatch?.autoApprovedTools?.length) conflict();
  assertActivityOnly(input.parentActivityBatch);
  const messages = (input.childBatch.items ?? []).filter(item => item.type === "userMessage");
  if (messages.length !== 1 || messages[0]!.type !== "userMessage" || !same(messages[0]!.content, [{ type: "text", text: request.data.prompt }])) conflict();
  const activity = input.parentActivityBatch.items?.[0];
  if (input.parentActivityBatch.items?.length !== 1 || !activity || activity.type !== "subagentActivity" || activity.taskId !== input.taskId
    || activity.sessionId !== member.sessionId || activity.turnId !== member.turnId || activity.parentCallItemId !== call.id
    || activity.rootSessionId !== root.rootSessionId || activity.rootTurnId !== root.rootTurnId || activity.childSessionId !== child.id
    || activity.childTurnId !== turn.id || activity.agentId !== target.id || activity.agentVersion !== target.version || activity.depth !== depth
    || activity.taskStatus !== "reserved") conflict();
  A.validateSubagentAuthority(input.authority); A.validateSubagentResolvedModel(input.initialResolvedModel); limits(input.limits);
  const parentAuthority = parentTask?.authority ?? root.authority;
  if (input.authority.agentId !== target.id || input.authority.agentVersion !== target.version || !same(input.authority.model, target.model)
    || !same(input.initialResolvedModel, turn.model)
    || !authoritySubset(input.authority, parentAuthority)) conflict();
  A.subagentNatural(input.deadlineAtMs, true);
  if (input.deadlineAtMs <= now || input.deadlineAtMs > root.deadlineAtMs || input.deadlineAtMs > now + input.limits.maxWallClockMs
    || parentTask && input.deadlineAtMs > parentTask.deadlineAtMs) conflict();
  if (input.selectedPolicy !== null) {
    const selected = SubagentPolicy.safeParse(input.selectedPolicy), configured = target.subagents;
    if (!selected.success || !configured || selected.data.targets.some(next => !allowsIdentity(parentPolicy, parentAuthority, { id: next.agentId, version: next.agentVersion })
      || !configured.targets.some(allowed => same(allowed, next)))
      || selected.data.allowSelf && (!configured.allowSelf || !allowsIdentity(parentPolicy, parentAuthority, target))) conflict();
    for (const key of ["maxDepth", "maxConcurrent", "maxTasks"] as const) if (selected.data[key] > Math.min(root.policy[key], parentPolicy[key], configured[key])) conflict();
  } else if (input.authority.toolNames.includes("task")) conflict();
  for (const key of Object.keys(root.limits) as (keyof typeof root.limits)[]) if (input.limits[key] > root.limits[key]
    || input.limits[key] > (parentTask?.effectiveLimits ?? root.effectiveLimits)[key]
    || parentPolicy.limits[key] !== undefined && input.limits[key] > parentPolicy.limits[key]!
    || target.subagents?.limits[key] !== undefined && input.limits[key] > target.subagents.limits[key]!
    || target.limits[key] !== undefined && input.limits[key] > target.limits[key]!
    || request.data.limits?.[key] !== undefined && input.limits[key] > request.data.limits[key]!) conflict();
  const replayBatch = (batch: CommitBatch) => {
    const normalized = structuredClone(batch);
    for (const item of normalized.items ?? []) item.seq = 0;
    for (const event of normalized.events ?? []) {
      if ("item" in event) event.item.seq = 0;
      if ("turn" in event) delete event.turn.seqEnd;
    }
    if (normalized.turn) delete normalized.turn.seqEnd;
    return normalized;
  };
  const requestSha256 = A.subagentDigest({ parentCallItemId: call.id, taskId: input.taskId, authority: input.authority, initialResolvedModel: input.initialResolvedModel, limits: input.limits,
    selectedPolicy: input.selectedPolicy, deadlineAtMs: input.deadlineAtMs,
    childSession: input.childSession, childBatch: replayBatch(input.childBatch), parentActivityBatch: replayBatch(input.parentActivityBatch) });
  const existing = image.tasks.find(row => row.parentCallItemId === call.id);
  if (existing) { if (existing.requestSha256 !== requestSha256) conflict(); return existing; }
  if (root.taskCount >= root.policy.maxTasks || root.activeTasks >= root.policy.maxConcurrent) conflict();
  for (const ancestor of ancestry(image, member.sessionId)) {
    const sessions = descendants(image, ancestor), nested = image.tasks.filter(row => sessions.has(row.parentSessionId));
    const policy = ancestor.selectedPolicy; if (!policy || depth > policy.maxDepth || nested.length >= policy.maxTasks || nested.filter(active).length >= policy.maxConcurrent) conflict();
  }
  const record: A.SubagentTaskRecord = { taskId: input.taskId, principal: { ...root.principal }, rootSessionId: root.rootSessionId, rootTurnId: root.rootTurnId,
    rootFence: root.rootFence, parentSessionId: member.sessionId, parentTurnId: member.turnId, parentCallItemId: call.id, parentToolCallId: call.toolCallId,
    activityItemId: activity.id, childSessionId: child.id, childTurnId: turn.id, depth, target: request.data.target, authority: structuredClone(input.authority), initialResolvedModel: structuredClone(input.initialResolvedModel),
    limits: { ...input.limits }, selectedPolicy: structuredClone(input.selectedPolicy), deadlineAtMs: input.deadlineAtMs,
    effectiveLimits: minLimits(input.limits, root.effectiveLimits), effectiveDeadlineAtMs: Math.min(input.deadlineAtMs, root.effectiveDeadlineAtMs),
    inputSha256: A.subagentDigest(messages[0]!.content), requestSha256, status: "reserved", childUsage: emptyUsageAccumulator(), createdAtMs: now, completedAtMs: null };
  image.tasks.push(record); image.root = { ...root, taskCount: root.taskCount + 1, activeTasks: root.activeTasks + 1, updatedAtMs: Math.max(now, root.updatedAtMs) };
  validateSubagentImage(image); return record;
}
export function completeSubagentTask(image: SubagentImage, input: A.CompleteSubagentTaskInput, now: number): A.SubagentTaskRecord {
  A.subagentClosed(input, ["access", "childBatch", "parentActivityBatch"]); const { member, root, task } = assertMember(image, input.access);
  if (!task || !input.childBatch.turn || input.childBatch.turn.id !== task.childTurnId || input.childBatch.turn.status === "inProgress"
    || input.childBatch.sessionId !== task.childSessionId || input.childBatch.fence !== root.rootFence
    || input.parentActivityBatch.sessionId !== task.parentSessionId || input.parentActivityBatch.fence !== root.rootFence || member.taskId !== task.taskId) conflict();
  const turn = input.childBatch.turn, status = turn.status, activity = input.parentActivityBatch.items?.[0];
  assertActivityOnly(input.parentActivityBatch);
  if (input.parentActivityBatch.items?.length !== 1 || !activity || activity.type !== "subagentActivity" || activity.id !== task.activityItemId
    || activity.taskId !== task.taskId || activity.childSessionId !== task.childSessionId || activity.childTurnId !== task.childTurnId
    || activity.sessionId !== task.parentSessionId || activity.turnId !== task.parentTurnId || activity.rootSessionId !== task.rootSessionId
    || activity.rootTurnId !== task.rootTurnId || activity.agentId !== task.authority.agentId || activity.agentVersion !== task.authority.agentVersion
    || activity.depth !== task.depth || activity.parentCallItemId !== task.parentCallItemId || activity.taskStatus !== status || !same(activity.childUsage, turn.usage)) conflict();
  const next: A.SubagentTaskRecord = { ...task, status, childUsage: structuredClone(turn.usage), completedAtMs: now };
  if (image.tasks.some(row => row.taskId !== task.taskId && active(row) && descendants(image, task).has(row.childSessionId))) conflict();
  if (!active(task)) { if (task.status !== next.status || !same(task.childUsage, next.childUsage)) conflict(); return task; }
  image.tasks = image.tasks.map(row => row.taskId === task.taskId ? next : row);
  image.root = { ...root, activeTasks: root.activeTasks - 1, updatedAtMs: Math.max(now, root.updatedAtMs) }; validateSubagentImage(image); return next;
}
/** Called after the terminal batch's real usage has settled, never before it. */
export function closeSubagentTaskAdmissions(image: SubagentImage, taskId: string, now: number): void {
  const task = image.tasks.find(row => row.taskId === taskId), root = image.root;
  if (!task || !root || active(task)) conflict();
  image.budgets = image.budgets.map(entry => entry.sessionId === task.childSessionId && entry.turnId === task.childTurnId && entry.state === "admitted"
    ? { ...entry, state: "outcome_unknown", completedAtMs: now } : entry);
  if (image.budgets.some(entry => entry.kind === "provider_step" && entry.state === "outcome_unknown") && root.state === "active") {
    image.root = { ...root, state: "closing", stopReason: "max_cost", updatedAtMs: Math.max(now, root.updatedAtMs) };
  }
  validateSubagentImage(image);
}
/** Canonical turn/ledger projection is supplied by the adapter under the root lock. */
export function synchronizeSubagentTaskUsage(image: SubagentImage, taskId: string, usage: import("@agent-service/protocol").Usage): void {
  const task = image.tasks.find(row => row.taskId === taskId); if (!task || !Usage.safeParse(usage).success) fail();
  // Once terminal, the proof is immutable. An inconsistency cannot be repaired by rewriting it.
  if (!active(task)) { if (!same(task.childUsage, usage)) conflict(); return; }
  image.tasks = image.tasks.map(row => row.taskId === taskId ? { ...row, childUsage: structuredClone(usage) } : row);
}
export function fenceSubagentImage(image: SubagentImage, newFence: number, now: number) {
  if (!image.root || newFence <= image.root.rootFence) conflict();
  image.tasks = image.tasks.map(task => active(task) ? { ...task, status: "outcome_unknown", completedAtMs: now } : task);
  image.budgets = image.budgets.map(entry => entry.state === "admitted" ? { ...entry, state: "outcome_unknown", completedAtMs: now } : entry);
  image.root = { ...image.root, state: "outcome_unknown", stopReason: "interrupted", activeTasks: 0, updatedAtMs: Math.max(now, image.root.updatedAtMs) };
  validateSubagentImage(image);
}
