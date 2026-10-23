import { attachSessionWriteAdmission, captureSessionWriteAdmission, type SessionLeaseProof } from "./session-authority.js";
import type { AgentDefinition, Item, Principal, Session, Turn } from "@agent-service/protocol";
import type { CommitBatch, CommitResult } from "./types.js";
import * as A from "./subagents.js";
import * as S from "./subagent-state.js";
import { SubjectDeletingError } from "./subject-lifecycle.js";

/** All callbacks are synchronous. No observer can see an intermediate multi-session publication. */
export interface MemorySubagentPort {
  now(): number;
  gate(principal: Principal): void;
  authorize(target: object, scope: { sessionId: string; fence: number }, fixedProof?: SessionLeaseProof): void;
  session(id: string): Session | undefined;
  deleted(id: string): boolean;
  turn(id: string): Turn | undefined;
  agent(tenantId: string, id: string, version: number): AgentDefinition | undefined;
  items(sessionId: string): readonly Item[];
  create(session: Session): CommitResult;
  commit(batch: CommitBatch, fixedProof?: SessionLeaseProof): CommitResult;
  ordinaryDelete(batch: CommitBatch): CommitResult;
  /** Journals the complete existing business write set, including in-place session/event changes. */
  atomic<T>(sessionIds: readonly string[], work: () => T): T;
}
function conflict(): never { throw new A.SubagentConflictError(); }
const same = (a: unknown, b: unknown) => A.subagentCanonical(a) === A.subagentCanonical(b);
export class MemorySubagents {
  private readonly images = new Map<string, S.SubagentImage>();
  private writerImage?: S.SubagentImage;
  private business(value: S.SubagentImage, batch: CommitBatch, ordinaryDelete = false, fixedProof?: SessionLeaseProof): CommitResult {
    const previous = this.writerImage; this.writerImage = value;
    try { return ordinaryDelete ? this.port.ordinaryDelete(batch) : this.port.commit(batch, fixedProof); }
    finally { this.writerImage = previous; }
  }
  constructor(private readonly port: MemorySubagentPort) {}
  private source(member: A.SubagentMemberIdentity, callItemId?: string, pendingTurn?: Turn): S.SubagentMemberSource {
    this.port.gate(member.principal);
    const session = this.port.session(member.sessionId), root = this.port.session(member.rootSessionId);
    const turn = pendingTurn ?? this.port.turn(member.turnId);
    if (!root || !session || !turn || this.port.deleted(root.id) || this.port.deleted(session.id)
      || root.tenantId !== member.principal.tenantId || root.userId !== member.principal.userId || root.fenceToken !== member.rootFence
      || session.tenantId !== member.principal.tenantId || session.userId !== member.principal.userId) conflict();
    const agent = this.port.agent(member.principal.tenantId, session.agentId, session.agentVersion); if (!agent) return conflict();
    return { session, turn, agent, ...(callItemId ? { call: this.port.items(session.id).find(item => item.id === callItemId) } : {}) };
  }
  private image(access: A.SubagentMemberAccess) {
    const member = A.assertSubagentMemberAccess(access), key = S.subagentRootKey(member.rootSessionId, member.rootTurnId);
    this.port.authorize(access, { sessionId: member.rootSessionId, fence: member.rootFence });
    return { member, key, image: structuredClone(this.images.get(key) ?? S.emptySubagentImage()) };
  }
  private publish(key: string, image: S.SubagentImage) {
    S.validateSubagentImage(image); const previous = this.images.get(key);
    try { this.images.set(key, image); }
    catch (error) { if (previous) Map.prototype.set.call(this.images, key, previous); else Map.prototype.delete.call(this.images, key); throw error; }
  }
  hasTenantFootprint(tenantId: string) { return [...this.images.values()].some(image => image.root?.principal.tenantId === tenantId); }
  assertRuntimeGate(enabled: boolean) {
    if (typeof enabled !== "boolean" || !enabled && [...this.images.values()].some(image => image.root?.state === "active" || image.root?.state === "closing")) conflict();
  }
  assertOrdinaryCreate(session: Session) {
    if ([...this.images.values()].some(image => image.tasks.some(task => task.childSessionId === session.id
      || task.childSessionId === session.parentSessionId) || image.root && session.parentSessionId === image.root.rootSessionId
        && ["active", "closing"].includes(image.root.state))) throw new A.SubagentManagedSessionError();
  }
  commit(batch: CommitBatch, fixedProof?: SessionLeaseProof): CommitResult {
    // Authenticate the original before any clone, serialization, sequence assignment or publication.
    this.port.authorize(batch, { sessionId: batch.sessionId, fence: batch.fence }, fixedProof);
    const admission = A.captureSubagentCommitAdmission(batch);
    const managed = [...this.images.values()].find(image => image.tasks.some(task => task.childSessionId === batch.sessionId));
    const roots = [...this.images.entries()].filter(([, image]) => image.root?.rootSessionId === batch.sessionId
      && ["active", "closing"].includes(image.root.state));
    if (!admission) {
      if (managed || roots.length && !batch.fenceClaim) throw new A.SubagentManagedSessionError();
      if (!roots.length) return this.port.commit(batch, fixedProof);
      return this.port.atomic([batch.sessionId], () => {
        const next = roots.map(([key, image]) => [key, structuredClone(image)] as const);
        for (const [, image] of next) {
          this.synchronizeTaskUsage(image); S.fenceSubagentImage(image, batch.fence, this.port.now());
        }
        const result = this.port.commit(batch, fixedProof); for (const [key, image] of next) this.publish(key, image); return result;
      });
    }
    const { member, key, image } = this.image(admission.input.access);
    return this.port.atomic([member.rootSessionId, member.sessionId], () => {
      const source = this.source(member, undefined, admission.input.root ? batch.turn : undefined);
      if (admission.input.root) {
        if ([...this.images.entries()].some(([otherKey, other]) => otherKey !== key && other.root?.rootSessionId === member.rootSessionId && ["active", "closing"].includes(other.root.state))) conflict();
        S.beginSubagentRoot(image, admission, source, this.port.now());
      }
      const calls = this.port.items(member.sessionId);
      S.settleSubagentBusiness(image, admission, batch, this.port.now(), calls, source);
      const result = this.business(image, batch, false, fixedProof); this.publish(key, image); return result;
    });
  }
  admit(input: A.AdmitSubagentBudgetInput): A.SubagentBudgetDecision {
    const { member, key, image } = this.image(input.access), source = this.source(member, input.callItemId);
    const result = S.admitSubagentBudget(image, input, source, this.port.now()); this.publish(key, image); return structuredClone(result);
  }
  create(input: A.CreateSubagentTaskInput): A.CreateSubagentTaskResult {
    const { member, key, image } = this.image(input.access), parent = this.source(member, input.parentCallItemId);
    const target = this.port.agent(member.principal.tenantId, input.childSession.agentId, input.childSession.agentVersion); if (!target) return conflict();
    const prior = image.tasks.find(task => task.parentCallItemId === input.parentCallItemId);
    const task = S.stageSubagentTask(image, input, parent, target, this.port.now());
    if (prior) {
      const session = this.port.session(task.childSessionId), turn = this.port.turn(task.childTurnId);
      if (!session || !turn) return conflict();
      return { task: structuredClone(task), childSession: structuredClone(session), childTurn: structuredClone(turn),
        childCommit: { events: [], lastSeq: session.lastSeq }, parentCommit: { events: [], lastSeq: parent.session.lastSeq }, replayed: true };
    }
    return this.port.atomic([member.rootSessionId, member.sessionId, task.childSessionId], () => {
      const created = this.port.create(input.childSession), childCommit = this.business(image, input.childBatch);
      const parentCommit = this.business(image, input.parentActivityBatch), session = this.port.session(task.childSessionId), turn = this.port.turn(task.childTurnId);
      if (!session || !turn) return conflict(); this.publish(key, image);
      return { task: structuredClone(task), childSession: structuredClone(session), childTurn: structuredClone(turn),
        childCommit: { ...childCommit, events: [...created.events, ...childCommit.events] }, parentCommit, replayed: false };
    });
  }
  complete(input: A.CompleteSubagentTaskInput): A.SubagentTaskCommitResult {
    const { member, key, image } = this.image(input.access); const source = this.source(member);
    const admission = A.captureSubagentCommitAdmission(input.childBatch);
    if (!admission || !same(admission.identity, member) || admission.input.root || admission.input.finishRoot) return conflict();
    const task = S.completeSubagentTask(image, input, this.port.now());
    return this.port.atomic([member.rootSessionId, task.parentSessionId, task.childSessionId], () => {
      S.settleSubagentBusiness(image, admission, input.childBatch, this.port.now(), this.port.items(member.sessionId), source);
      S.closeSubagentTaskAdmissions(image, task.taskId, this.port.now());
      const childCommit = this.business(image, input.childBatch), parentCommit = this.business(image, input.parentActivityBatch);
      this.publish(key, image); return { task: structuredClone(task), childCommit, parentCommit };
    });
  }
  getRoot(input: { access: A.SubagentMemberAccess }) {
    const { member, image } = this.image(input.access);
    if (image.root) this.source(member);
    else { this.port.gate(member.principal); const root = this.port.session(member.rootSessionId);
      if (!root || root.fenceToken !== member.rootFence || root.tenantId !== member.principal.tenantId || root.userId !== member.principal.userId || this.port.deleted(root.id)) conflict(); }
    return structuredClone(image.root);
  }
  getTask(input: { principal: Principal; rootSessionId: string; taskId: string }) {
    return this.listTasks(input).find(task => task.taskId === input.taskId) ?? null;
  }
  getMember(input: { principal: Principal; sessionId: string }) {
    const session = this.port.session(input.sessionId);
    if (!session || session.tenantId !== input.principal.tenantId || session.userId !== input.principal.userId || this.port.deleted(session.id)) return null;
    for (const image of this.images.values()) { const task = image.tasks.find(task => task.childSessionId === session.id);
      if (task) {
        try { this.port.gate(input.principal); } catch (error) { if (error instanceof SubjectDeletingError) return null; throw error; }
        return { rootSessionId: task.rootSessionId, rootTurnId: task.rootTurnId, taskId: task.taskId };
      } }
    return null;
  }
  listTasks(input: { principal: Principal; rootSessionId: string; rootTurnId?: string }): readonly A.SubagentTaskRecord[] {
    this.port.gate(input.principal); const session = this.port.session(input.rootSessionId);
    if (!session || session.tenantId !== input.principal.tenantId || session.userId !== input.principal.userId || this.port.deleted(session.id)) return [];
    return [...this.images.values()].filter(image => image.root?.rootSessionId === session.id
      && (!input.rootTurnId || image.root.rootTurnId === input.rootTurnId)).flatMap(image => structuredClone(image.tasks));
  }
  managedSession(sessionId: string, rootSessionId?: string): boolean {
    return [...this.images.values(), ...(this.writerImage ? [this.writerImage] : [])].some(image => (!rootSessionId || image.root?.rootSessionId === rootSessionId)
      && image.tasks.some(task => task.childSessionId === sessionId));
  }
  fenceForAcquisition(rootSessionId: string, newFence: number, writeLease: () => void): void {
    const changed = [...this.images.entries()].filter(([, value]) => value.root?.rootSessionId === rootSessionId && ["active", "closing"].includes(value.root.state))
      .map(([key, value]) => [key, structuredClone(value)] as const);
    for (const [, value] of changed) { this.synchronizeTaskUsage(value); S.fenceSubagentImage(value, newFence, this.port.now()); }
    writeLease(); for (const [key, value] of changed) this.publish(key, value);
  }
  repair(input: { principal: Principal; rootSessionId: string; rootTurnId: string; newFence: number }): readonly A.SubagentTaskRecord[] {
    this.port.authorize(input, { sessionId: input.rootSessionId, fence: input.newFence });
    const proof = captureSessionWriteAdmission(input);
    this.port.gate(input.principal); const root = this.port.session(input.rootSessionId), key = S.subagentRootKey(input.rootSessionId, input.rootTurnId);
    const image = structuredClone(this.images.get(key));
    if (!root || !image?.root || root.fenceToken !== input.newFence || root.tenantId !== input.principal.tenantId || root.userId !== input.principal.userId) return conflict();
    if (input.newFence <= image.root.rootFence) return conflict();
    // Fence claim has already closed every admission. Repair only canonical terminal projections.
    this.synchronizeTaskUsage(image, true);
    if (image.root.state !== "outcome_unknown") S.fenceSubagentImage(image, input.newFence, this.port.now());
    return this.port.atomic([root.id, ...image.tasks.flatMap(task => [task.parentSessionId, task.childSessionId])], () => {
      for (const task of [...image.tasks].sort((a, b) => b.depth - a.depth)) {
        const turn = this.port.turn(task.childTurnId); if (!turn || turn.status !== "inProgress") continue;
        const now = this.port.now(), terminal: Turn = { ...turn, status: "interrupted", stopReason: "interrupted", completedAtMs: now };
        const items = this.port.items(task.childSessionId).filter(item => item.turnId === turn.id && item.status === "inProgress")
          .map(item => ({ ...item, status: "failed" as const, completedAtMs: now }));
        const batch: CommitBatch = { sessionId: task.childSessionId, fence: input.newFence, turn: terminal, items,
          sessionPatch: { status: { type: "idle" } }, events: [...items.map(item => ({ type: "item/completed" as const, sessionId: item.sessionId, item, emittedAtMs: now })),
            { type: "turn/completed", sessionId: task.childSessionId, turn: terminal, stopReason: "interrupted", emittedAtMs: now }] };
        if (proof) attachSessionWriteAdmission(batch, proof);
        this.business(image, batch);
        const activity = this.port.items(task.parentSessionId).find(item => item.id === task.activityItemId);
        if (!activity || activity.type !== "subagentActivity") return conflict();
        const completed = { ...activity, status: "failed" as const, taskStatus: "outcome_unknown" as const, childUsage: terminal.usage, completedAtMs: now };
        const parentBatch: CommitBatch = { sessionId: task.parentSessionId, fence: input.newFence, items: [completed],
          events: [{ type: "item/completed", sessionId: task.parentSessionId, item: completed, emittedAtMs: now }] };
        if (proof) attachSessionWriteAdmission(parentBatch, proof); this.business(image, parentBatch);
      }
      this.publish(key, image); return structuredClone(image.tasks);
    });
  }
  private synchronizeTaskUsage(image: S.SubagentImage, includeUnknown = false) {
    for (const task of image.tasks) {
      if (task.status !== "reserved" && task.status !== "running" && !(includeUnknown && task.status === "outcome_unknown")) continue;
      const turn = this.port.turn(task.childTurnId);
      if (!turn || turn.sessionId !== task.childSessionId) return conflict();
      S.synchronizeSubagentTaskUsage(image, task.taskId, turn.usage);
    }
  }
  deleteTaskSession(input: { access: A.SubagentMemberAccess; taskId: string; batch: CommitBatch }): CommitResult {
    const member = A.assertSubagentMemberAccess(input.access); if (member.taskId !== null) return conflict();
    this.source(member); const { image } = this.image(input.access), task = image.tasks.find(task => task.taskId === input.taskId);
    const turn = task && this.port.turn(task.childTurnId);
    if (!task || ["reserved", "running"].includes(task.status) || !turn || turn.status === "inProgress"
      || input.batch.sessionId !== task.childSessionId || input.batch.fence !== member.rootFence || input.batch.lifecycle?.type !== "tombstone"
      || input.batch.lifecycle.tenantId !== member.principal.tenantId || input.batch.lifecycle.userId !== member.principal.userId) return conflict();
    return this.port.atomic([member.rootSessionId, task.childSessionId], () => this.business(image, input.batch, true));
  }
}
