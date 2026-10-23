import { attachSessionWriteAdmission, captureSessionWriteAdmission, type SessionLeaseProof } from "../session-authority.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDefinition, Item, Turn, type Principal, type Session } from "@agent-service/protocol";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { CommitBatch, CommitResult } from "../types.js";
import * as A from "../subagents.js";
import * as S from "../subagent-state.js";
import { SubjectDeletingError } from "../subject-lifecycle.js";

export const SUBAGENT_MIGRATION = "0064_subagents.sql";
export const SUBAGENT_TABLES = ["subagent_root_turns", "subagent_tasks", "subagent_budget_entries"] as const;
export const SUBAGENT_TRIGGERS = [
  ...SUBAGENT_TABLES.flatMap(table => ["bi", "bu", "bd"].map(suffix => `trg_${table}_${suffix}`)),
  ...["sessions", "turns", "items", "events", "approvals", "usage_ledger"].flatMap(table => ["bi", "bu"].map(suffix => `trg_subagent_${table}_${suffix}`)),
  "trg_subagent_t3c_bu", "trg_subagent_t3d_bu", "trg_subagent_t3f_bu",
] as const;
type Row = RowDataPacket & Record<string, unknown>;
function fail(): never { throw new A.SubagentIntegrityError(); }
function conflict(): never { throw new A.SubagentConflictError(); }
function parsed<T>(value: unknown): T { try { return (typeof value === "string" ? JSON.parse(value) : value) as T; } catch { return fail(); } }
const same = (a: unknown, b: unknown) => A.subagentCanonical(a) === A.subagentCanonical(b);
const active = (task: A.SubagentTaskRecord) => task.status === "reserved" || task.status === "running";
async function now(conn: PoolConnection) {
  const [rows] = await conn.query<Row[]>("SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
  const result = Number(rows[0]?.now_ms); A.subagentNatural(result, true); return result;
}
export interface MysqlSubagentPort {
  /** Locks the canonical lifecycle/T1/restore credential gates; never creates a weaker owner gate. */
  gate(conn: PoolConnection, principal: Principal): Promise<void>;
  authorize(conn: PoolConnection, target: object, scope: { sessionId: string; fence: number }, fixedProof?: SessionLeaseProof): Promise<void>;
  session(conn: PoolConnection, id: string): Promise<{ session: Session; deleted: boolean } | null>;
  /** Current canonical turn usage under the already locked root/member rows. */
  turn(conn: PoolConnection, sessionId: string, turnId: string): Promise<Turn | null>;
  /** Exact existing business implementations; these callbacks never begin/commit/release a transaction. */
  commit(conn: PoolConnection, batch: CommitBatch, fixedProof?: SessionLeaseProof): Promise<SubagentPreparedCommit>;
  create(conn: PoolConnection, session: Session): Promise<CommitResult>;
  ordinaryDelete(conn: PoolConnection, batch: CommitBatch): Promise<SubagentPreparedCommit>;
}
export interface SubagentPreparedCommit { result: CommitResult; afterCommit(): void }
export function subagentFingerprintStatement(sql: string) {
  const start = "-- agent-service-runtime-fingerprint:subagents:start", end = "-- agent-service-runtime-fingerprint:subagents:end";
  const a = sql.indexOf(start), b = sql.indexOf(end);
  if (a < 0 || b <= a || sql.indexOf(start, a + 1) >= 0 || sql.indexOf(end, b + 1) >= 0) fail();
  const statements = sql.slice(a + start.length, b).replace(/^\s*--.*$/gm, "").split(/;\s*\n/).map(value => value.trim()).filter(Boolean);
  const statement = statements[0], roots = statement?.match(/'[a-f0-9]{64}'/g) ?? [];
  if (statements.length !== 1 || !statement?.startsWith("SET @skill_registry_triggers_ok=") || statement.includes(";") || roots.length !== 1 || roots[0] === `'${"0".repeat(64)}'`) fail();
  return statement;
}
export async function assertMysqlSubagentFingerprint(conn: PoolConnection, directory: string) {
  const statement = subagentFingerprintStatement(await readFile(join(directory, SUBAGENT_MIGRATION), "utf8"));
  await conn.query("SET @subagent_previous_gcml=@@SESSION.group_concat_max_len");
  try {
    await conn.query("SET SESSION group_concat_max_len=1048576"); await conn.query(statement);
    const [rows] = await conn.query<Row[]>("SELECT @skill_registry_triggers_ok AS ok"); if (Number(rows[0]?.ok) !== 1) fail();
  } finally { await conn.query("SET SESSION group_concat_max_len=@subagent_previous_gcml"); }
}
async function image(conn: PoolConnection, rootSessionId: string, rootTurnId: string, lock = true): Promise<S.SubagentImage> {
  const key = S.subagentRootKey(rootSessionId, rootTurnId), result = S.emptySubagentImage();
  const suffix = lock ? " FOR UPDATE" : "";
  const [roots] = await conn.query<Row[]>(`SELECT * FROM subagent_root_turns WHERE root_key=?${suffix}`, [key]);
  if (!roots.length) return result; if (roots.length !== 1) fail();
  const row = roots[0]!, root = parsed<A.SubagentRootRecord>(row.record_json);
  if (row.root_key !== key || row.root_session_id !== root.rootSessionId || row.root_turn_id !== root.rootTurnId
    || row.tenant_id !== root.principal.tenantId || row.user_id !== root.principal.userId || Number(row.root_fence) !== root.rootFence
    || row.state !== root.state || row.record_sha256 !== A.subagentDigest(root)) fail();
  result.root = root;
  const [tasks] = await conn.query<Row[]>(`SELECT * FROM subagent_tasks WHERE root_key=? ORDER BY depth,task_id${suffix}`, [key]);
  result.tasks = tasks.map(row => {
    const task = parsed<A.SubagentTaskRecord>(row.record_json);
    if (row.task_id !== task.taskId || row.child_session_id !== task.childSessionId || row.parent_call_item_id !== task.parentCallItemId
      || row.parent_session_id !== task.parentSessionId || Number(row.depth) !== task.depth || row.status !== task.status
      || row.record_sha256 !== A.subagentDigest(task)) fail(); return task;
  });
  const [entries] = await conn.query<Row[]>(`SELECT * FROM subagent_budget_entries WHERE root_key=? ORDER BY ordinal${suffix}`, [key]);
  result.budgets = entries.map(row => {
    const entry = parsed<A.SubagentBudgetEntry>(row.record_json);
    if (row.entry_id !== entry.entryId || row.session_id !== entry.sessionId || row.turn_id !== entry.turnId || row.kind !== entry.kind
      || Number(row.step) !== entry.step || row.call_item_id !== entry.callItemId || row.state !== entry.state || row.record_sha256 !== A.subagentDigest(entry)) fail(); return entry;
  });
  S.validateSubagentImage(result); return result;
}
/** Verify-only startup audit. No lifecycle gate is invented for retained/deleted historical rows. */
export async function assertMysqlSubagentProjection(conn: PoolConnection) {
  const [roots] = await conn.query<Row[]>("SELECT * FROM subagent_root_turns ORDER BY root_key");
  for (const row of roots) {
    if (row.writer_connection_id !== null || row.writer_session_id !== null || row.writer_mode !== null || row.writer_fence !== null) fail();
    const value = await image(conn, String(row.root_session_id), String(row.root_turn_id), false), root = value.root; if (!root) fail();
    const [heads] = await conn.query<Row[]>("SELECT tenant_id,user_id,fence_token FROM sessions WHERE session_id=?", [root.rootSessionId]);
    const [turns] = await conn.query<Row[]>("SELECT session_id,status,body FROM turns WHERE turn_id=?", [root.rootTurnId]);
    if (heads.length !== 1 || heads[0]!.tenant_id !== root.principal.tenantId || heads[0]!.user_id !== root.principal.userId
      || Number(heads[0]!.fence_token) < root.rootFence || turns.length !== 1 || turns[0]!.session_id !== root.rootSessionId
      || ["active", "closing"].includes(root.state) && (turns[0]!.status !== "inProgress" || Number(heads[0]!.fence_token) !== root.rootFence)) fail();
    for (const task of value.tasks) {
      const [children] = await conn.query<Row[]>("SELECT tenant_id,user_id,parent_session_id,agent_id,agent_version FROM sessions WHERE session_id=?", [task.childSessionId]);
      const [childTurns] = await conn.query<Row[]>("SELECT session_id,status FROM turns WHERE turn_id=?", [task.childTurnId]);
      const [calls] = await conn.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=?", [task.parentCallItemId, task.parentSessionId]);
      const [activities] = await conn.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=?", [task.activityItemId, task.parentSessionId]);
      const child = children[0], call = calls.length === 1 ? Item.parse(parsed(calls[0]!.body)) : null,
        activity = activities.length === 1 ? Item.parse(parsed(activities[0]!.body)) : null;
      if (children.length !== 1 || !child || child.tenant_id !== root.principal.tenantId || child.user_id !== root.principal.userId
        || child.parent_session_id !== task.parentSessionId || child.agent_id !== task.authority.agentId || Number(child.agent_version) !== task.authority.agentVersion
        || childTurns.length !== 1 || childTurns[0]!.session_id !== task.childSessionId
        || active(task) && childTurns[0]!.status !== "inProgress" || !active(task) && task.status !== "outcome_unknown" && childTurns[0]!.status !== task.status
        || !call || call.type !== "toolCall" || call.name !== "task" || call.kind !== "builtin" || call.startedAtMs === undefined || call.toolCallId !== task.parentToolCallId
        || !activity || activity.type !== "subagentActivity" || activity.taskId !== task.taskId || activity.childSessionId !== task.childSessionId
        || activity.childTurnId !== task.childTurnId || activity.rootSessionId !== root.rootSessionId || activity.rootTurnId !== root.rootTurnId) fail();
    }
    for (const entry of value.budgets) if (entry.kind === "provider_step" && entry.state === "settled") {
      const [ledger] = await conn.query<Row[]>("SELECT usage_id,tenant_id,user_id,provider,model,usage_json FROM usage_ledger WHERE session_id=? AND turn_id=? AND step=?", [entry.sessionId, entry.turnId, entry.step]);
      const usage = ledger[0]; if (ledger.length !== 1 || !usage || usage.usage_id !== entry.usageId || usage.tenant_id !== root.principal.tenantId
        || usage.user_id !== root.principal.userId || !entry.provider || usage.provider !== entry.provider.provider || usage.model !== entry.provider.model || !same(parsed(usage.usage_json), entry.usage)) fail();
    }
  }
  const [orphans] = await conn.query<Row[]>(`SELECT
    (SELECT COUNT(*) FROM subagent_tasks t LEFT JOIN subagent_root_turns r ON r.root_key=t.root_key WHERE r.root_key IS NULL)
    +(SELECT COUNT(*) FROM subagent_budget_entries b LEFT JOIN subagent_root_turns r ON r.root_key=b.root_key WHERE r.root_key IS NULL) AS n`);
  if (Number(orphans[0]?.n) !== 0) fail();
}
async function persist(conn: PoolConnection, value: S.SubagentImage) {
  S.validateSubagentImage(value); if (!value.root) return;
  const root = value.root, key = S.subagentRootKey(root.rootSessionId, root.rootTurnId);
  const [existingRoots] = await conn.query<Row[]>("SELECT root_key FROM subagent_root_turns WHERE root_key=? FOR UPDATE", [key]);
  if (existingRoots.length) await conn.query("UPDATE subagent_root_turns SET state=?,record_sha256=?,record_json=? WHERE root_key=?", [root.state, A.subagentDigest(root), JSON.stringify(root), key]);
  else await conn.query(`INSERT INTO subagent_root_turns
    (root_key,root_session_id,root_turn_id,tenant_id,user_id,root_fence,state,record_sha256,record_json)
    VALUES (?,?,?,?,?,?,?,?,?)`,
  [key, root.rootSessionId, root.rootTurnId, root.principal.tenantId, root.principal.userId, root.rootFence, root.state, A.subagentDigest(root), JSON.stringify(root)]);
  for (const task of value.tasks) {
    const [existing] = await conn.query<Row[]>("SELECT task_id FROM subagent_tasks WHERE task_id=? FOR UPDATE", [task.taskId]);
    if (existing.length) await conn.query("UPDATE subagent_tasks SET status=?,record_sha256=?,record_json=? WHERE task_id=?", [task.status, A.subagentDigest(task), JSON.stringify(task), task.taskId]);
    else await conn.query(`INSERT INTO subagent_tasks
    (task_id,root_key,tenant_id,user_id,parent_session_id,parent_call_item_id,child_session_id,depth,status,record_sha256,record_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [task.taskId, key, root.principal.tenantId, root.principal.userId, task.parentSessionId, task.parentCallItemId, task.childSessionId, task.depth, task.status, A.subagentDigest(task), JSON.stringify(task)]);
  }
  for (const [ordinal, entry] of value.budgets.entries()) {
    const [existing] = await conn.query<Row[]>("SELECT entry_id FROM subagent_budget_entries WHERE entry_id=? FOR UPDATE", [entry.entryId]);
    if (existing.length) await conn.query("UPDATE subagent_budget_entries SET state=?,record_sha256=?,record_json=? WHERE entry_id=?", [entry.state, A.subagentDigest(entry), JSON.stringify(entry), entry.entryId]);
    else await conn.query(`INSERT INTO subagent_budget_entries
    (entry_id,root_key,tenant_id,user_id,session_id,turn_id,kind,step,call_item_id,state,ordinal,record_sha256,record_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [entry.entryId, key, root.principal.tenantId, root.principal.userId, entry.sessionId, entry.turnId, entry.kind, entry.step, entry.callItemId, entry.state, ordinal + 1, A.subagentDigest(entry), JSON.stringify(entry)]);
  }
}
export class MysqlSubagents {
  constructor(private readonly pool: Pool, private readonly port: MysqlSubagentPort) {}
  private async transaction<T>(work: (conn: PoolConnection, afterCommit: Array<() => void>) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    const afterCommit: Array<() => void> = [];
    try { await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); await conn.beginTransaction();
      const result = await work(conn, afterCommit); await conn.commit(); for (const publish of afterCommit) publish(); return result;
    } catch (error) { await conn.rollback().catch(() => {}); throw error; } finally { conn.release(); }
  }
  private async business(conn: PoolConnection, batch: CommitBatch, afterCommit: Array<() => void>, ordinaryDelete = false, fixedProof?: SessionLeaseProof) {
    const prepared = ordinaryDelete ? await this.port.ordinaryDelete(conn, batch) : await this.port.commit(conn, batch, fixedProof);
    afterCommit.push(prepared.afterCommit); return prepared.result;
  }
  private async root(conn: PoolConnection, member: A.SubagentMemberIdentity, access: A.SubagentMemberAccess) {
    await this.port.authorize(conn, access, { sessionId: member.rootSessionId, fence: member.rootFence });
    const row = await this.port.session(conn, member.rootSessionId);
    if (!row || row.deleted || row.session.tenantId !== member.principal.tenantId || row.session.userId !== member.principal.userId
      || row.session.fenceToken !== member.rootFence) conflict();
    await this.port.gate(conn, member.principal); return row.session;
  }
  private async source(conn: PoolConnection, member: A.SubagentMemberIdentity, value: S.SubagentImage, callItemId?: string, pendingTurn?: Turn): Promise<S.SubagentMemberSource> {
    // The root row/control already serialize the family. Lock ancestors root-to-leaf before member.
    const chain: A.SubagentTaskRecord[] = []; let task = value.tasks.find(row => row.childSessionId === member.sessionId);
    while (task) { chain.unshift(task); task = value.tasks.find(row => row.childSessionId === task!.parentSessionId); }
    for (const ancestor of chain) if (ancestor.childSessionId !== member.sessionId) await this.port.session(conn, ancestor.childSessionId);
    const row = await this.port.session(conn, member.sessionId);
    if (!row || row.deleted || row.session.tenantId !== member.principal.tenantId || row.session.userId !== member.principal.userId) conflict();
    const session = row.session;
    const turn = pendingTurn ?? await this.port.turn(conn, member.sessionId, member.turnId); if (!turn) return conflict();
    const [agents] = await conn.query<Row[]>("SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? AND version=? FOR SHARE", [member.principal.tenantId, session.agentId, session.agentVersion]);
    if (agents.length !== 1) return conflict(); const agent = AgentDefinition.parse(parsed(agents[0]!.definition));
    let call: Item | undefined;
    if (callItemId) { const [rows] = await conn.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=? AND turn_id=? FOR UPDATE", [callItemId, member.sessionId, member.turnId]);
      if (rows.length === 1) call = Item.parse(parsed(rows[0]!.body)); }
    return { session, turn, agent, ...(call ? { call } : {}) };
  }
  private async calls(conn: PoolConnection, member: A.SubagentMemberIdentity) {
    const [rows] = await conn.query<Row[]>("SELECT body FROM items WHERE session_id=? AND turn_id=? AND type='toolCall' ORDER BY seq FOR SHARE", [member.sessionId, member.turnId]);
    return rows.map(row => Item.parse(parsed(row.body)));
  }
  private async writer(conn: PoolConnection, root: A.SubagentRootRecord, sessionId: string, mode: "business" | "repair" | "delete", fence = root.rootFence) {
    await conn.query("UPDATE subagent_root_turns SET writer_connection_id=CONNECTION_ID(),writer_session_id=?,writer_mode=?,writer_fence=? WHERE root_key=?", [sessionId, mode, fence, S.subagentRootKey(root.rootSessionId, root.rootTurnId)]);
  }
  private async clear(conn: PoolConnection, root: A.SubagentRootRecord) {
    await conn.query("UPDATE subagent_root_turns SET writer_connection_id=NULL,writer_session_id=NULL,writer_mode=NULL,writer_fence=NULL WHERE root_key=?", [S.subagentRootKey(root.rootSessionId, root.rootTurnId)]);
  }
  async assertRuntimeGate(enabled: boolean) {
    if (typeof enabled !== "boolean") fail(); if (enabled) return;
    const [rows] = await this.pool.query<Row[]>("SELECT root_key FROM subagent_root_turns WHERE state IN ('active','closing') LIMIT 1"); if (rows.length) conflict();
  }
  async assertOrdinaryCreate(conn: PoolConnection, session: Session) {
    if (!session.parentSessionId) return;
    // Parent session is locked by the ordinary create path before this check.
    const [rows] = await conn.query<Row[]>(`SELECT task_id AS found FROM subagent_tasks WHERE child_session_id=?
      UNION ALL SELECT root_key AS found FROM subagent_root_turns WHERE root_session_id=? AND state IN ('active','closing')`, [session.parentSessionId, session.parentSessionId]);
    if (rows.length) throw new A.SubagentManagedSessionError();
  }
  async commit(batch: CommitBatch, fixedProof?: SessionLeaseProof): Promise<CommitResult> {
    const admission = A.captureSubagentCommitAdmission(batch);
    if (!admission) {
      // This non-authorizing early rejection must not establish the business transaction's RR
      // snapshot or lock a child/gap before its root. Creation-race membership is rechecked below.
      const [addresses] = await this.pool.query<Row[]>("SELECT task_id FROM subagent_tasks WHERE child_session_id=?", [batch.sessionId]);
      if (addresses.length) throw new A.SubagentManagedSessionError();
      return this.transaction(async (conn, afterCommit) => {
      await this.port.authorize(conn, batch, { sessionId: batch.sessionId, fence: batch.fence }, fixedProof);
      const head = await this.port.session(conn, batch.sessionId); if (!head) return conflict();
      // First consistent read follows the session X lock, preserving ordinary usage projections.
      // A managed child is never upgraded to root authority here, even if it was just created.
      const [members] = await conn.query<Row[]>("SELECT task_id FROM subagent_tasks WHERE child_session_id=?", [batch.sessionId]);
      if (members.length) throw new A.SubagentManagedSessionError();
      const [roots] = await conn.query<Row[]>("SELECT record_json FROM subagent_root_turns WHERE root_session_id=? AND state IN ('active','closing') ORDER BY root_key FOR UPDATE", [batch.sessionId]);
      if (roots.length && !batch.fenceClaim) throw new A.SubagentManagedSessionError();
      const changes: S.SubagentImage[] = [];
      for (const row of roots) { const root = parsed<A.SubagentRootRecord>(row.record_json), value = await image(conn, root.rootSessionId, root.rootTurnId);
        await this.synchronizeTaskUsage(conn, value); S.fenceSubagentImage(value, batch.fence, await now(conn));
        await persist(conn, value); await this.writer(conn, value.root!, batch.sessionId, "repair", batch.fence); changes.push(value); }
      const result = await this.business(conn, batch, afterCommit, false, fixedProof); for (const value of changes) await this.clear(conn, value.root!); return result;
      });
    }
    const member = admission.identity;
    return this.transaction(async (conn, afterCommit) => {
      await this.root(conn, member, admission.input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId);
      const source = await this.source(conn, member, value, undefined, admission.input.root ? batch.turn : undefined);
      if (admission.input.root) {
        const [other] = await conn.query<Row[]>("SELECT root_key FROM subagent_root_turns WHERE root_session_id=? AND state IN ('active','closing') AND root_key<>? FOR UPDATE", [member.rootSessionId, S.subagentRootKey(member.rootSessionId, member.rootTurnId)]);
        if (other.length) return conflict(); S.beginSubagentRoot(value, admission, source, await now(conn));
      }
      S.settleSubagentBusiness(value, admission, batch, await now(conn), await this.calls(conn, member), source);
      await persist(conn, value); if (!value.root) return fail(); await this.writer(conn, value.root, member.sessionId, "business");
      const result = await this.business(conn, batch, afterCommit, false, fixedProof); await this.clear(conn, value.root); return result;
    });
  }
  async admit(input: A.AdmitSubagentBudgetInput) {
    const member = A.assertSubagentMemberAccess(input.access);
    return this.transaction(async conn => { await this.root(conn, member, input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId);
      const source = await this.source(conn, member, value, input.callItemId), result = S.admitSubagentBudget(value, input, source, await now(conn));
      await persist(conn, value); return result; });
  }
  async create(input: A.CreateSubagentTaskInput): Promise<A.CreateSubagentTaskResult> {
    const member = A.assertSubagentMemberAccess(input.access);
    return this.transaction(async (conn, afterCommit) => {
      await this.root(conn, member, input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId), parent = await this.source(conn, member, value, input.parentCallItemId);
      const [targets] = await conn.query<Row[]>("SELECT definition FROM agent_versions WHERE tenant_id=? AND agent_id=? AND version=? FOR SHARE", [member.principal.tenantId, input.childSession.agentId, input.childSession.agentVersion]);
      if (targets.length !== 1) return conflict(); const target = AgentDefinition.parse(parsed(targets[0]!.definition));
      const prior = value.tasks.find(task => task.parentCallItemId === input.parentCallItemId), task = S.stageSubagentTask(value, input, parent, target, await now(conn));
      if (prior) {
        const child = await this.source(conn, { ...member, taskId: task.taskId, sessionId: task.childSessionId, turnId: task.childTurnId }, value);
        return { task, childSession: child.session, childTurn: child.turn, childCommit: { events: [], lastSeq: child.session.lastSeq }, parentCommit: { events: [], lastSeq: parent.session.lastSeq }, replayed: true };
      }
      await persist(conn, value); await this.writer(conn, value.root!, task.childSessionId, "business");
      const created = await this.port.create(conn, input.childSession), childCommit = await this.business(conn, input.childBatch, afterCommit);
      await this.writer(conn, value.root!, member.sessionId, "business"); const parentCommit = await this.business(conn, input.parentActivityBatch, afterCommit);
      await this.clear(conn, value.root!);
      const child = await this.source(conn, { ...member, taskId: task.taskId, sessionId: task.childSessionId, turnId: task.childTurnId }, value);
      return { task, childSession: child.session, childTurn: child.turn, childCommit: { ...childCommit, events: [...created.events, ...childCommit.events] }, parentCommit, replayed: false };
    });
  }
  async complete(input: A.CompleteSubagentTaskInput): Promise<A.SubagentTaskCommitResult> {
    const member = A.assertSubagentMemberAccess(input.access), admission = A.captureSubagentCommitAdmission(input.childBatch);
    if (!admission || !same(admission.identity, member) || admission.input.root || admission.input.finishRoot) return conflict();
    return this.transaction(async (conn, afterCommit) => { await this.root(conn, member, input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId);
      const source = await this.source(conn, member, value); const task = S.completeSubagentTask(value, input, await now(conn));
      S.settleSubagentBusiness(value, admission, input.childBatch, await now(conn), await this.calls(conn, member), source);
      S.closeSubagentTaskAdmissions(value, task.taskId, await now(conn)); await persist(conn, value);
      await this.writer(conn, value.root!, task.childSessionId, "business"); const childCommit = await this.business(conn, input.childBatch, afterCommit);
      await this.writer(conn, value.root!, task.parentSessionId, "business"); const parentCommit = await this.business(conn, input.parentActivityBatch, afterCommit);
      await this.clear(conn, value.root!); return { task, childCommit, parentCommit }; });
  }
  async getRoot(input: { access: A.SubagentMemberAccess }) {
    const member = A.assertSubagentMemberAccess(input.access);
    return this.transaction(async conn => { await this.root(conn, member, input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId);
      if (value.root) await this.source(conn, member, value); return value.root; });
  }
  async listTasks(input: { principal: Principal; rootSessionId: string; rootTurnId?: string }): Promise<readonly A.SubagentTaskRecord[]> {
    return this.transaction(async conn => {
      const head = await this.port.session(conn, input.rootSessionId); if (!head || head.deleted || head.session.tenantId !== input.principal.tenantId || head.session.userId !== input.principal.userId) return [];
      await this.port.gate(conn, input.principal);
      const [roots] = await conn.query<Row[]>(`SELECT root_turn_id FROM subagent_root_turns WHERE root_session_id=?${input.rootTurnId ? " AND root_turn_id=?" : ""} ORDER BY root_key FOR UPDATE`, [input.rootSessionId, ...(input.rootTurnId ? [input.rootTurnId] : [])]);
      const result: A.SubagentTaskRecord[] = []; for (const row of roots) result.push(...(await image(conn, input.rootSessionId, String(row.root_turn_id))).tasks); return result;
    });
  }
  async getTask(input: { principal: Principal; rootSessionId: string; taskId: string }) { return (await this.listTasks(input)).find(task => task.taskId === input.taskId) ?? null; }
  async getMember(input: { principal: Principal; sessionId: string }) {
    const [addresses] = await this.pool.query<Row[]>("SELECT record_json FROM subagent_tasks WHERE child_session_id=?", [input.sessionId]);
    if (addresses.length > 1) return fail(); if (!addresses.length) return null;
    const address = parsed<A.SubagentTaskRecord>(addresses[0]!.record_json);
    if (!same(address.principal, input.principal)) return null;
    return this.transaction(async conn => {
      const root = await this.port.session(conn, address.rootSessionId);
      if (!root || root.session.tenantId !== input.principal.tenantId || root.session.userId !== input.principal.userId || root.deleted) return null;
      try { await this.port.gate(conn, input.principal); } catch (error) { if (error instanceof SubjectDeletingError) return null; throw error; }
      const row = await this.port.session(conn, input.sessionId);
      if (!row || row.deleted || row.session.tenantId !== input.principal.tenantId || row.session.userId !== input.principal.userId) return null;
      const [tasks] = await conn.query<Row[]>("SELECT record_json FROM subagent_tasks WHERE child_session_id=?", [input.sessionId]);
      if (tasks.length > 1) return fail(); if (!tasks.length) return null;
      const task = parsed<A.SubagentTaskRecord>(tasks[0]!.record_json);
      if (!same(task.principal, input.principal) || task.childSessionId !== input.sessionId || task.rootSessionId !== address.rootSessionId || task.taskId !== address.taskId) return fail();
      return { rootSessionId: task.rootSessionId, rootTurnId: task.rootTurnId, taskId: task.taskId };
    });
  }
  /** Called only after authority exact-proof/root/binding validation under the same canonical X lock.
   * This does not fence/repair a family or grant business authority to a caller-owned batch. */
  async withRootLeaseExpiryAdmission(conn: PoolConnection, rootSessionId: string, fence: number, updateExpiry: () => Promise<void>): Promise<void> {
    const [rows] = await conn.query<Row[]>("SELECT root_key,root_turn_id,writer_connection_id,writer_session_id,writer_mode,writer_fence FROM subagent_root_turns WHERE root_session_id=? AND BINARY root_session_id=BINARY ? AND state IN ('active','closing') ORDER BY root_key FOR UPDATE", [rootSessionId, rootSessionId]);
    const roots: A.SubagentRootRecord[] = [];
    for (const row of rows) {
      if (row.writer_connection_id !== null || row.writer_session_id !== null || row.writer_mode !== null || row.writer_fence !== null) return fail();
      const value = await image(conn, rootSessionId, String(row.root_turn_id)), root = value.root;
      if (!root || root.rootSessionId !== rootSessionId || root.rootFence !== fence
        || root.state !== "active" && root.state !== "closing" || row.root_key !== S.subagentRootKey(root.rootSessionId, root.rootTurnId)) return conflict();
      roots.push(root);
    }
    // The existing published guard recognizes this actual connection and exact root fence.
    for (const root of roots) await this.writer(conn, root, rootSessionId, "business", fence);
    await updateExpiry();
    for (const root of roots) {
      await this.clear(conn, root);
      const [cleared] = await conn.query<Row[]>("SELECT writer_connection_id,writer_session_id,writer_mode,writer_fence FROM subagent_root_turns WHERE root_key=? FOR UPDATE", [S.subagentRootKey(root.rootSessionId, root.rootTurnId)]);
      if (cleared.length !== 1 || cleared[0]!.writer_connection_id !== null || cleared[0]!.writer_session_id !== null
        || cleared[0]!.writer_mode !== null || cleared[0]!.writer_fence !== null) return fail();
    }
    // Any failure propagates to the owning authority transaction's real rollback. No finally clear
    // can mask its first error, and a rejected rollback destroys that connection instead of pooling it.
  }
  async fenceForAcquisition(conn: PoolConnection, rootSessionId: string, newFence: number, updateLease: () => Promise<void>): Promise<void> {
    const [roots] = await conn.query<Row[]>("SELECT record_json FROM subagent_root_turns WHERE root_session_id=? AND state IN ('active','closing') ORDER BY root_key FOR UPDATE", [rootSessionId]);
    const changed: S.SubagentImage[] = [];
    for (const row of roots) {
      const root = parsed<A.SubagentRootRecord>(row.record_json), value = await image(conn, root.rootSessionId, root.rootTurnId);
      await this.synchronizeTaskUsage(conn, value); S.fenceSubagentImage(value, newFence, await now(conn));
      await persist(conn, value); await this.writer(conn, value.root!, rootSessionId, "repair", newFence); changed.push(value);
    }
    await updateLease();
    for (const value of changed) await this.clear(conn, value.root!);
  }
  async repair(input: { principal: Principal; rootSessionId: string; rootTurnId: string; newFence: number }): Promise<readonly A.SubagentTaskRecord[]> {
    return this.transaction(async (conn, afterCommit) => {
      await this.port.authorize(conn, input, { sessionId: input.rootSessionId, fence: input.newFence });
      const proof = captureSessionWriteAdmission(input);
      const head = await this.port.session(conn, input.rootSessionId); if (!head || head.deleted || head.session.fenceToken !== input.newFence
        || head.session.tenantId !== input.principal.tenantId || head.session.userId !== input.principal.userId) return conflict();
      await this.port.gate(conn, input.principal); const value = await image(conn, input.rootSessionId, input.rootTurnId);
      if (!value.root || input.newFence <= value.root.rootFence) return conflict();
      await this.synchronizeTaskUsage(conn, value, true);
      if (value.root.state !== "outcome_unknown") S.fenceSubagentImage(value, input.newFence, await now(conn)); await persist(conn, value);
      for (const task of [...value.tasks].sort((a, b) => b.depth - a.depth)) {
        const member = { principal: input.principal, rootSessionId: input.rootSessionId, rootTurnId: input.rootTurnId, rootFence: input.newFence,
          sessionId: task.childSessionId, turnId: task.childTurnId, taskId: task.taskId };
        const source = await this.source(conn, member, value); if (source.turn.status !== "inProgress") continue;
        const at = await now(conn), turn: Turn = { ...source.turn, status: "interrupted", stopReason: "interrupted", completedAtMs: at };
        const [rows] = await conn.query<Row[]>("SELECT body FROM items WHERE session_id=? AND turn_id=? AND status='inProgress' ORDER BY seq FOR UPDATE", [task.childSessionId, task.childTurnId]);
        const items = rows.map(row => ({ ...Item.parse(parsed(row.body)), status: "failed" as const, completedAtMs: at }));
        await this.writer(conn, value.root, task.childSessionId, "repair", input.newFence);
        const childBatch: CommitBatch = { sessionId: task.childSessionId, fence: input.newFence, turn, items, sessionPatch: { status: { type: "idle" } },
          events: [...items.map(item => ({ type: "item/completed" as const, sessionId: task.childSessionId, item, emittedAtMs: at })),
            { type: "turn/completed", sessionId: task.childSessionId, turn, stopReason: "interrupted", emittedAtMs: at }] };
        if (proof) attachSessionWriteAdmission(childBatch, proof);
        await this.business(conn, childBatch, afterCommit);
        const [activities] = await conn.query<Row[]>("SELECT body FROM items WHERE item_id=? AND session_id=? FOR UPDATE", [task.activityItemId, task.parentSessionId]);
        const activity = activities.length === 1 ? Item.parse(parsed(activities[0]!.body)) : null;
        if (!activity || activity.type !== "subagentActivity") return conflict();
        const completed = { ...activity, status: "failed" as const, taskStatus: "outcome_unknown" as const, childUsage: turn.usage, completedAtMs: at };
        await this.writer(conn, value.root, task.parentSessionId, "repair", input.newFence);
        const parentBatch: CommitBatch = { sessionId: task.parentSessionId, fence: input.newFence, items: [completed], events: [{ type: "item/completed", sessionId: task.parentSessionId, item: completed, emittedAtMs: at }] };
        if (proof) attachSessionWriteAdmission(parentBatch, proof);
        await this.business(conn, parentBatch, afterCommit);
      }
      await this.clear(conn, value.root); return value.tasks;
    });
  }
  private async synchronizeTaskUsage(conn: PoolConnection, value: S.SubagentImage, includeUnknown = false) {
    for (const task of [...value.tasks].sort((a, b) => a.depth - b.depth)) {
      if (!active(task) && !(includeUnknown && task.status === "outcome_unknown")) continue;
      const session = await this.port.session(conn, task.childSessionId);
      const turn = session && !session.deleted ? await this.port.turn(conn, task.childSessionId, task.childTurnId) : null;
      if (!turn) return conflict(); S.synchronizeSubagentTaskUsage(value, task.taskId, turn.usage);
    }
  }
  async deleteTaskSession(input: { access: A.SubagentMemberAccess; taskId: string; batch: CommitBatch }): Promise<CommitResult> {
    const member = A.assertSubagentMemberAccess(input.access); if (member.taskId !== null) return conflict();
    return this.transaction(async (conn, afterCommit) => { await this.root(conn, member, input.access); const value = await image(conn, member.rootSessionId, member.rootTurnId), task = value.tasks.find(task => task.taskId === input.taskId);
      if (!task || active(task) || input.batch.sessionId !== task.childSessionId || input.batch.fence !== member.rootFence || input.batch.lifecycle?.type !== "tombstone"
        || input.batch.lifecycle.tenantId !== member.principal.tenantId || input.batch.lifecycle.userId !== member.principal.userId) return conflict();
      const child = await this.source(conn, { ...member, taskId: task.taskId, sessionId: task.childSessionId, turnId: task.childTurnId }, value);
      if (child.turn.status === "inProgress") return conflict();
      await this.writer(conn, value.root!, task.childSessionId, "delete", member.rootFence); const result = await this.business(conn, input.batch, afterCommit, true); await this.clear(conn, value.root!); return result; });
  }
}
