import { transferSessionWriteAdmission } from "./session-authority.js";
import { createHash } from "node:crypto";
import { AgentDefinition, Limits, ModelRef, Principal, SubagentPolicy, Usage, idSchema,
  type ApprovalPolicy, type Session, type StopReason, type SubagentTaskStatus, type Turn } from "@agent-service/protocol";
import type { CommitBatch, CommitResult } from "./types.js";

/** These errors are intentionally content-free: prompts, argument values and credentials are never diagnostics. */
export class SubagentIntegrityError extends Error { constructor() { super("Subagent durable state is invalid."); this.name = "SubagentIntegrityError"; } }
export class SubagentConflictError extends Error { constructor() { super("Subagent state changed."); this.name = "SubagentConflictError"; } }
export class SubagentLifecycleBlockedError extends Error { constructor() { super("Subagent lifecycle proof is unavailable."); this.name = "SubagentLifecycleBlockedError"; } }
export class SubagentManagedSessionError extends Error { constructor() { super("Managed subagent control requires its root session."); this.name = "SubagentManagedSessionError"; } }

function invalid(): never { throw new SubagentIntegrityError(); }
export function subagentClosed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).some(key => !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(entry => !Object.hasOwn(entry, "value") || !entry.enumerable)) invalid();
}
export function subagentNatural(value: unknown, positive = false): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) invalid();
}
function parsed<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success || result.data === undefined) return invalid(); return result.data;
}
/** Canonical JSON is only an identity check, never authority. Access/admission identity is held in WeakMaps. */
export function subagentCanonical(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown, array = false): unknown => {
    if (input === undefined) return array ? null : undefined;
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") { if (!Number.isFinite(input)) invalid(); return input; }
    if (typeof input !== "object" || seen.has(input)) return invalid();
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) invalid();
    if (Object.getOwnPropertySymbols(input).length
      || Object.values(Object.getOwnPropertyDescriptors(input)).some(entry => !Object.hasOwn(entry, "value"))) invalid();
    seen.add(input);
    let output: unknown;
    if (Array.isArray(input)) output = input.map(item => normalize(item, true));
    else { const object: Record<string, unknown> = {}; for (const key of Object.keys(input).sort()) {
      const next = normalize((input as Record<string, unknown>)[key]); if (next !== undefined) Object.defineProperty(object, key, { value: next, enumerable: true, configurable: true, writable: true });
    } output = object; }
    seen.delete(input); return output;
  };
  try { const text = JSON.stringify(normalize(value)); if (text === undefined) return invalid(); return text; } catch { return invalid(); }
}
export const subagentDigest = (value: unknown): string => createHash("sha256").update(subagentCanonical(value)).digest("hex");

declare const accessBrand: unique symbol;
export interface SubagentMemberAccess { readonly [accessBrand]: true }
export interface SubagentMemberIdentity {
  readonly principal: Principal;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootFence: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskId: string | null;
}
const members = new WeakMap<object, Readonly<SubagentMemberIdentity>>();
function issue(identity: SubagentMemberIdentity): SubagentMemberAccess {
  const token = Object.freeze({}) as SubagentMemberAccess;
  members.set(token, Object.freeze({ ...identity, principal: Object.freeze({ ...identity.principal }) })); return token;
}
export function createSubagentRootAccess(input: { principal: Principal; rootSessionId: string; rootTurnId: string; rootFence: number }): SubagentMemberAccess {
  subagentClosed(input, ["principal", "rootSessionId", "rootTurnId", "rootFence"]);
  const principal = parsed<Principal>(Principal, input.principal);
  parsed(idSchema("sess"), input.rootSessionId); parsed(idSchema("turn"), input.rootTurnId); subagentNatural(input.rootFence, true);
  return issue({ ...input, principal, sessionId: input.rootSessionId, turnId: input.rootTurnId, taskId: null });
}
export function createSubagentChildAccess(root: SubagentMemberAccess, input: { taskId: string; childSessionId: string; childTurnId: string }): SubagentMemberAccess {
  const member = assertSubagentMemberAccess(root);
  subagentClosed(input, ["taskId", "childSessionId", "childTurnId"]);
  parsed(idSchema("sat"), input.taskId); parsed(idSchema("sess"), input.childSessionId); parsed(idSchema("turn"), input.childTurnId);
  if (input.childSessionId === member.rootSessionId || input.childTurnId === member.rootTurnId) invalid();
  const access = issue({ ...member, taskId: input.taskId, sessionId: input.childSessionId, turnId: input.childTurnId });
  transferSessionWriteAdmission(root, access); return access;
}
export function assertSubagentMemberAccess(value: SubagentMemberAccess): Readonly<SubagentMemberIdentity> {
  const member = value && typeof value === "object" ? members.get(value) : undefined; if (!member) return invalid(); return member;
}

export interface SubagentAuthoritySnapshot {
  readonly agentId: string;
  readonly agentVersion: number;
  readonly model: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" };
  readonly toolNames: readonly string[];
  /** Server-composed real tool approval predicate, not an ordering of policy names. */
  readonly approvalRequiredTools: readonly string[];
  readonly toolContractSha256ByName: Readonly<Record<string, string>>;
  readonly approvalPolicy: ApprovalPolicy;
  readonly contextEpoch: string;
}
export interface SubagentRootSpecification {
  readonly policy: SubagentPolicy;
  readonly limits: Required<Limits>;
  readonly deadlineAtMs: number;
  readonly authority: SubagentAuthoritySnapshot;
  /** Actual first-turn provider identity, distinct from the immutable configured model pin. */
  readonly initialResolvedModel: ModelRef;
}
export interface SubagentRootRecord extends SubagentRootSpecification {
  readonly effectiveLimits: Required<Limits>;
  readonly effectiveDeadlineAtMs: number;
  readonly principal: Principal;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootFence: number;
  readonly state: "active" | "closing" | "terminal" | "outcome_unknown";
  readonly stopReason: StopReason | null;
  readonly policySha256: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly taskCount: number;
  readonly activeTasks: number;
  /** Non-billing projection of the real member step ledger, never another UsageLedgerWrite. */
  readonly familyUsage: Usage;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface SubagentTaskRecord {
  readonly taskId: string;
  readonly principal: Principal;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootFence: number;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly parentCallItemId: string;
  readonly parentToolCallId: string;
  readonly activityItemId: string;
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly depth: number;
  readonly target: string;
  readonly authority: SubagentAuthoritySnapshot;
  readonly initialResolvedModel: ModelRef;
  readonly limits: Required<Limits>;
  readonly selectedPolicy: SubagentPolicy | null;
  readonly deadlineAtMs: number;
  readonly effectiveLimits: Required<Limits>;
  readonly effectiveDeadlineAtMs: number;
  readonly inputSha256: string;
  readonly requestSha256: string;
  readonly status: SubagentTaskStatus;
  readonly childUsage: Usage;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}
export interface SubagentBudgetEntry {
  readonly entryId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootFence: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly kind: "provider_step" | "tool_call";
  readonly step: number;
  readonly callItemId: string | null;
  readonly provider: SubagentProviderAdmission | null;
  readonly state: "admitted" | "settled" | "outcome_unknown";
  readonly usageId: string | null;
  readonly usage: Usage | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}
export interface SubagentCommitAdmissionInput {
  readonly access: SubagentMemberAccess;
  /** Only on the first root turn/started business batch. */
  readonly root?: SubagentRootSpecification;
  /** A real terminal root turn; this cannot release an unsettled child. */
  readonly finishRoot?: true;
}
export interface CapturedSubagentCommitAdmission {
  readonly identity: Readonly<SubagentMemberIdentity>;
  readonly input: Readonly<SubagentCommitAdmissionInput>;
  readonly businessSha256: string;
}
const commits = new WeakMap<object, CapturedSubagentCommitAdmission>();
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
export function attachSubagentCommitAdmission<T extends CommitBatch>(batch: T, input: SubagentCommitAdmissionInput): T {
  subagentClosed(input, ["access", "root", "finishRoot"]);
  const identity = assertSubagentMemberAccess(input.access);
  if (batch.sessionId !== identity.sessionId || batch.fence !== identity.rootFence || batch.lifecycle || batch.fenceClaim
    || batch.turn && (batch.turn.id !== identity.turnId || batch.turn.sessionId !== identity.sessionId)
    || input.root && identity.taskId !== null || input.finishRoot !== undefined && input.finishRoot !== true) invalid();
  if (input.root) {
    subagentClosed(input.root, ["policy", "limits", "deadlineAtMs", "authority", "initialResolvedModel"]);
    parsed<SubagentPolicy>(SubagentPolicy, input.root.policy); parsed<Limits>(Limits.strict(), input.root.limits);
    subagentNatural(input.root.deadlineAtMs, true); validateSubagentAuthority(input.root.authority);
    validateSubagentResolvedModel(input.root.initialResolvedModel);
    for (const key of ["maxSteps", "maxToolCalls", "maxWallClockMs", "maxOutputTokensPerStep"] as const) subagentNatural(input.root.limits[key], true);
    if (!Number.isFinite(input.root.limits.maxCostCNY) || input.root.limits.maxCostCNY <= 0) invalid();
    subagentCanonical(input.root);
  }
  const businessSha256 = subagentDigest(batch);
  if (commits.has(batch)) invalid();
  const snapshot = Object.freeze({ ...input, ...(input.root ? { root: freezeTree(structuredClone(input.root)) } : {}) });
  commits.set(batch, Object.freeze({ identity, input: snapshot, businessSha256 }));
  transferSessionWriteAdmission(input.access, batch); return batch;
}
/** Must be called before any clone/serialization or mutation can drop the original object identity. */
export function captureSubagentCommitAdmission(batch: CommitBatch): CapturedSubagentCommitAdmission | undefined {
  const original = commits.get(batch); if (!original) return undefined;
  assertSubagentMemberAccess(original.input.access);
  if (subagentDigest(batch) !== original.businessSha256) invalid(); return original;
}
/** Trusted wrapper clone only. A changed business body, owner, session, fence or arbitrary alias is rejected. */
export function transferSubagentCommitAdmission(original: CommitBatch, clone: CommitBatch): void {
  const admission = captureSubagentCommitAdmission(original); if (!admission) return;
  if (original === clone || commits.has(clone) || subagentDigest(clone) !== admission.businessSha256) invalid();
  commits.set(clone, admission); transferSessionWriteAdmission(original, clone);
}
export function validateSubagentAuthority(input: SubagentAuthoritySnapshot): void {
  subagentClosed(input, ["agentId", "agentVersion", "model", "toolNames", "approvalRequiredTools", "toolContractSha256ByName", "approvalPolicy", "contextEpoch"]);
  subagentClosed(input.model, ["provider", "model", "reasoning"]);
  parsed(idSchema("agt"), input.agentId); subagentNatural(input.agentVersion, true); parsed(ModelRef, input.model);
  if (input.approvalPolicy !== "on-request" || typeof input.contextEpoch !== "string" || !input.contextEpoch.length
    || !Array.isArray(input.toolNames) || input.toolNames.length > 256 || new Set(input.toolNames).size !== input.toolNames.length
    || input.toolNames.some(name => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
    || !Array.isArray(input.approvalRequiredTools) || new Set(input.approvalRequiredTools).size !== input.approvalRequiredTools.length
    || input.approvalRequiredTools.some(name => !input.toolNames.includes(name))) invalid();
  subagentClosed(input.toolContractSha256ByName, input.toolNames);
  if (Object.keys(input.toolContractSha256ByName).length !== input.toolNames.length
    || input.toolNames.some(name => !/^[a-f0-9]{64}$/.test(input.toolContractSha256ByName[name] ?? ""))) invalid();
}
export function validateSubagentResolvedModel(input: ModelRef): void {
  subagentClosed(input, ["provider", "model", "reasoning"]); parsed(ModelRef, input);
}

export interface AdmitSubagentBudgetInput {
  readonly access: SubagentMemberAccess;
  readonly kind: "provider_step" | "tool_call";
  readonly step: number;
  readonly callItemId?: string;
  readonly provider?: SubagentProviderAdmission;
  readonly effectiveLimits: Required<Limits>;
  readonly effectiveDeadlineAtMs: number;
}
export interface SubagentProviderAdmission {
  readonly provider: string;
  readonly model: string;
  readonly lifecycleSha256: string | null;
  readonly contextEpoch: string;
}
export interface SubagentBudgetDecision {
  readonly admitted: boolean;
  readonly replayed: boolean;
  readonly reason?: StopReason;
  readonly root: SubagentRootRecord;
}
export interface CreateSubagentTaskInput {
  readonly access: SubagentMemberAccess;
  readonly taskId: string;
  readonly parentCallItemId: string;
  readonly authority: SubagentAuthoritySnapshot;
  readonly initialResolvedModel: ModelRef;
  readonly limits: Required<Limits>;
  /** The effective immutable policy is checked against every ancestor and target agent. */
  readonly selectedPolicy: SubagentPolicy | null;
  readonly deadlineAtMs: number;
  readonly childSession: Session;
  /** Reserve the real first turn/input in the same transaction as seq1 and the parent activity. */
  readonly childBatch: CommitBatch;
  readonly parentActivityBatch: CommitBatch;
}
export interface CreateSubagentTaskResult {
  readonly task: SubagentTaskRecord;
  readonly childSession: Session;
  readonly childTurn: Turn;
  readonly childCommit: CommitResult;
  readonly parentCommit: CommitResult;
  readonly replayed: boolean;
}
export interface CompleteSubagentTaskInput {
  readonly access: SubagentMemberAccess;
  readonly childBatch: CommitBatch;
  readonly parentActivityBatch: CommitBatch;
}
export interface SubagentTaskCommitResult {
  readonly task: SubagentTaskRecord;
  readonly childCommit: CommitResult;
  readonly parentCommit: CommitResult;
}
export interface SubagentStore {
  /** Pure observer flags do not authorize this gate or task creation. */
  assertSubagentRuntimeGate(enabled: boolean): Promise<void>;
  admitSubagentBudget(input: AdmitSubagentBudgetInput): Promise<SubagentBudgetDecision>;
  createSubagentTask(input: CreateSubagentTaskInput): Promise<CreateSubagentTaskResult>;
  completeSubagentTask(input: CompleteSubagentTaskInput): Promise<SubagentTaskCommitResult>;
  getSubagentRoot(input: { access: SubagentMemberAccess }): Promise<SubagentRootRecord | null>;
  getSubagentTask(input: { principal: Principal; rootSessionId: string; taskId: string }): Promise<SubagentTaskRecord | null>;
  getSubagentSessionMember(input: { principal: Principal; sessionId: string }): Promise<{ rootSessionId: string; rootTurnId: string; taskId: string } | null>;
  listSubagentTasks(input: { principal: Principal; rootSessionId: string; rootTurnId?: string }): Promise<readonly SubagentTaskRecord[]>;
  /** Close old admissions after actual root-fence takeover; never dispatch/retry any model or tool. */
  repairSubagentRoot(input: { principal: Principal; rootSessionId: string; rootTurnId: string; newFence: number }): Promise<readonly SubagentTaskRecord[]>;
  /** Explicit terminal child tombstone; ordinary grace/origin/outbox rules still apply. */
  deleteSubagentTaskSession(input: { access: SubagentMemberAccess; taskId: string; batch: CommitBatch }): Promise<CommitResult>;
}

/** Kept here as a typed source boundary for adapters; an agent row is still read under the root transaction. */
export type SubagentAgentSnapshot = AgentDefinition;
