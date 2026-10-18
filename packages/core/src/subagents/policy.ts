import { createHash } from "node:crypto";
import { ApprovalPolicy, Limits, Principal, SubagentPolicy, SubagentTaskInput, idSchema } from "@agent-service/protocol";
import type { AgentDefinition, InputPart } from "@agent-service/protocol";
import type { RunnerTool, ToolExecutionContext } from "../tools/types.js";

export class SubagentPolicyError extends Error {
  override readonly name = "SubagentPolicyError";
  constructor(readonly code: "invalid" | "not_allowed" | "limit") { super("Subagent task is not permitted."); }
}
export interface SubagentRunnerCeilings {
  readonly maxDepth: number;
  readonly maxConcurrent: number;
  readonly maxTasks: number;
}
export interface SubagentTargetSelection {
  readonly agentId: string;
  readonly agentVersion: number;
}
export interface ResolveSubagentTargetInput {
  readonly principal: Principal;
  readonly rootAgent: AgentDefinition;
  readonly parentAgent: AgentDefinition;
  /** Durable effective parent policy. Null forbids delegation; undefined is only the initial root path. */
  readonly parentPolicy?: SubagentPolicy | null;
  readonly target: string;
}
export interface SelectSubagentPolicyInput extends Omit<ResolveSubagentTargetInput, "target"> {
  /** The coordinator must read this actual immutable agent version from the Store. */
  readonly targetAgent: AgentDefinition;
  readonly task: SubagentTaskInput;
  readonly parentTools: readonly RunnerTool[];
  readonly childTools: readonly RunnerTool[];
  readonly rootLimits: Readonly<Required<Limits>>;
  readonly parentLimits?: Limits;
  readonly runnerCeilings: SubagentRunnerCeilings;
  /** Root depth is zero; this call creates parentDepth + 1. */
  readonly parentDepth: number;
  readonly rootDeadlineAtMs: number;
  readonly nowMs: number;
}
export interface SelectedSubagentPolicy {
  readonly target: SubagentTargetSelection;
  readonly depth: number;
  /** New input only. No ancestor transcript, grants, metadata, attachments or credentials. */
  readonly input: readonly Extract<InputPart, { type: "text" }>[];
  readonly tools: readonly RunnerTool[];
  readonly approvalPolicy: "on-request";
  readonly limits: Readonly<Required<Limits>>;
  readonly ceilings: SubagentRunnerCeilings;
  readonly deadlineAtMs: number;
  readonly selectedPolicy: SubagentPolicy | null;
  readonly approvalRequiredTools: readonly string[];
  readonly toolContractSha256ByName: Readonly<Record<string, string>>;
}
function invalid(): never { throw new SubagentPolicyError("invalid"); }
function denied(): never { throw new SubagentPolicyError("not_allowed"); }
function limited(): never { throw new SubagentPolicyError("limit"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString("utf8") !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) invalid(); return value;
}
function natural(value: unknown, maximum: number, zero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > maximum) invalid(); return value;
}
function actualPrincipal(value: Principal): Principal {
  const p = object(value); keys(p, ["tenantId", "userId"]);
  const parsed = Principal.strict().safeParse({ tenantId: text(p.tenantId, 512), userId: text(p.userId, 128) });
  if (!parsed.success) invalid(); return parsed.data;
}
function identity(agent: AgentDefinition, tenantId: string): SubagentTargetSelection {
  const value = object(agent);
  // Read only authority fields: parent metadata/instructions/credentials are never copied by this selector.
  if (text(value.tenantId, 512) !== tenantId) denied();
  const id = idSchema("agt").safeParse(value.id); if (!id.success) invalid();
  return { agentId: id.data, agentVersion: natural(value.version, Number.MAX_SAFE_INTEGER) };
}
function same(a: SubagentTargetSelection, b: SubagentTargetSelection): boolean {
  return a.agentId === b.agentId && a.agentVersion === b.agentVersion;
}
function parsedPolicy(value: unknown): SubagentPolicy {
  const parsed = SubagentPolicy.safeParse(JSON.parse(canonicalSchema(value))); if (!parsed.success) invalid();
  for (const value of Object.values(parsed.data.limits)) if (!Number.isFinite(value)) invalid();
  for (const target of parsed.data.targets) natural(target.agentVersion, Number.MAX_SAFE_INTEGER);
  return parsed.data;
}
function policy(agent: AgentDefinition): SubagentPolicy | undefined {
  return agent.subagents === undefined ? undefined : parsedPolicy(agent.subagents);
}
function rootAllows(root: SubagentTargetSelection, rootPolicy: SubagentPolicy, target: SubagentTargetSelection): boolean {
  if (same(root, target)) return rootPolicy.allowSelf;
  return rootPolicy.targets.some(pin => same(pin, target));
}
function parentPolicyFor(input: Pick<ResolveSubagentTargetInput, "parentAgent" | "parentPolicy">, root: SubagentTargetSelection,
  parent: SubagentTargetSelection): SubagentPolicy {
  const original = policy(input.parentAgent); if (!original || input.parentPolicy === null) denied();
  if (input.parentPolicy === undefined) { if (!same(root, parent)) denied(); return original; }
  const persisted = parsedPolicy(input.parentPolicy);
  const targets = original.targets.filter(pin => persisted.targets.some(other => pin.name === other.name && same(pin, other)));
  const allowSelf = original.allowSelf && persisted.allowSelf;
  if (!targets.length && !allowSelf) denied();
  const limits: Limits = { ...limitLayer(original.limits) };
  for (const [key, value] of Object.entries(limitLayer(persisted.limits)) as [keyof Limits, number][]) {
    limits[key] = Math.min(limits[key] ?? value, value);
  }
  return { targets, allowSelf, maxDepth: Math.min(original.maxDepth, persisted.maxDepth),
    maxConcurrent: Math.min(original.maxConcurrent, persisted.maxConcurrent), maxTasks: Math.min(original.maxTasks, persisted.maxTasks), limits, context: "prompt" };
}
/** First resolve a configured label, then fetch exactly this tenant-bound agent version.
 * The return value is a pure selection, not an access token or proof that the fetch occurred. */
export function resolveSubagentTarget(input: ResolveSubagentTargetInput): Readonly<SubagentTargetSelection> {
  const raw = object(input); keys(raw, ["principal", "rootAgent", "parentAgent", "target"], ["parentPolicy"]);
  const principal = actualPrincipal(input.principal), root = identity(input.rootAgent, principal.tenantId), parent = identity(input.parentAgent, principal.tenantId);
  const rootPolicy = policy(input.rootAgent), parentPolicy = parentPolicyFor(input, root, parent);
  if (!rootPolicy) denied();
  if (!same(root, parent) && !rootAllows(root, rootPolicy, parent)) denied();
  if (typeof input.target !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.target)) invalid();
  let selected: SubagentTargetSelection;
  if (input.target === "self") {
    if (!parentPolicy.allowSelf) denied(); selected = parent;
  } else {
    const pin = parentPolicy.targets.find(target => target.name === input.target); if (!pin) denied();
    selected = { agentId: pin.agentId, agentVersion: pin.agentVersion };
    // A label alias for the parent cannot bypass explicit self permission.
    if (same(parent, selected) && !parentPolicy.allowSelf) denied();
  }
  if (!rootAllows(root, rootPolicy, selected)) denied();
  return Object.freeze({ ...selected });
}
const LIMIT_KEYS = ["maxSteps", "maxToolCalls", "maxWallClockMs", "maxCostCNY", "maxOutputTokensPerStep"] as const;
function limitLayer(value: unknown, required = false): Limits {
  const raw = object(value); keys(raw, required ? LIMIT_KEYS : [], required ? [] : LIMIT_KEYS);
  const parsed = Limits.strict().safeParse(raw); if (!parsed.success) invalid();
  for (const key of LIMIT_KEYS) {
    const number = parsed.data[key]; if (number === undefined) { if (required) invalid(); continue; }
    if (!Number.isFinite(number) || key !== "maxCostCNY" && !Number.isSafeInteger(number)) invalid();
  }
  return parsed.data;
}

/** Stable JSON equality retains arrays/order/string bytes. It never executes getters/toJSON.
 * Tool contracts are bounded identities, not arbitrary JavaScript graphs. */
function canonicalSchema(value: unknown): string {
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const normalize = (entry: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 32) invalid();
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") { if (!Number.isFinite(entry)) invalid(); return entry; }
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry); if (bytes > 65_536 || Buffer.from(entry).toString("utf8") !== entry) invalid(); return entry;
    }
    if (!entry || typeof entry !== "object" || active.has(entry)) invalid(); active.add(entry);
    let result: unknown;
    if (Array.isArray(entry)) {
      if (Object.getPrototypeOf(entry) !== Array.prototype || Object.getOwnPropertySymbols(entry).length
        || Object.keys(entry).length !== entry.length || entry.length > 16_384
        || Object.entries(Object.getOwnPropertyDescriptors(entry)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) invalid();
      result = entry.map(child => normalize(child, depth + 1));
    } else {
      const source = object(entry), resultObject: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(source).sort()) {
        bytes += Buffer.byteLength(key); if (bytes > 65_536) invalid(); resultObject[key] = normalize(source[key], depth + 1);
      }
      result = resultObject;
    }
    active.delete(entry); return result;
  };
  object(value); const encoded = JSON.stringify(normalize(value, 0)); if (Buffer.byteLength(encoded) > 65_536) invalid(); return encoded;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value;
}
interface ToolIdentity { readonly actual: RunnerTool; readonly schema: string; readonly scope: string | undefined }
function toolMap(tools: readonly RunnerTool[]): Map<string, ToolIdentity> {
  if (!Array.isArray(tools) || Object.getPrototypeOf(tools) !== Array.prototype || tools.length > 256
    || Object.getOwnPropertySymbols(tools).length || Object.keys(tools).length !== tools.length
    || Object.entries(Object.getOwnPropertyDescriptors(tools)).some(([key, d]) => key !== "length" && (!("value" in d) || !d.enumerable))) invalid();
  const result = new Map<string, ToolIdentity>();
  for (const tool of tools) {
    const raw = object(tool); keys(raw, ["name", "description", "parameters", "kind", "execute"],
      ["readOnly", "needsApproval", "mandatoryApproval", "approvalScope", "concurrencySafe"]);
    if (typeof raw.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.name) || result.has(raw.name)
      || typeof raw.kind !== "string" || !["builtin", "mcp", "dynamic", "skill"].includes(raw.kind)
      || typeof raw.execute !== "function") invalid();
    if (typeof raw.description !== "string" || Buffer.byteLength(raw.description) > 32_768) invalid();
    for (const flag of ["readOnly", "needsApproval", "mandatoryApproval", "concurrencySafe"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") invalid();
    }
    const scope = raw.approvalScope === undefined ? undefined : text(raw.approvalScope, 512);
    result.set(raw.name, { actual: tool, schema: canonicalSchema(raw.parameters), scope });
  }
  return result;
}
function approvalPolicy(value: unknown): ApprovalPolicy {
  const result = ApprovalPolicy.safeParse(value); if (!result.success) invalid(); return result.data;
}
function requiresApproval(policy: ApprovalPolicy, tool: RunnerTool): boolean {
  return tool.mandatoryApproval === true || (policy === "never" ? false : policy === "untrusted" ? tool.readOnly !== true : tool.needsApproval === true);
}
export interface SubagentToolAuthority {
  readonly approvalRequiredTools: readonly string[];
  readonly toolContractSha256ByName: Readonly<Record<string, string>>;
}
/** Content-only contract identity plus conservative approval obligations. This does not serialize executors or grant tokens. */
export function subagentToolAuthority(tools: readonly RunnerTool[], policy: ApprovalPolicy): Readonly<SubagentToolAuthority> {
  const actualPolicy = approvalPolicy(policy), actual = toolMap(tools), required: string[] = [], hashes: Record<string, string> = {};
  for (const name of [...actual.keys()].sort()) {
    const tool = actual.get(name)!;
    if (requiresApproval(actualPolicy, tool.actual)) required.push(name);
    const sha256 = createHash("sha256").update("subagent-tool-contract-v1\0").update(JSON.stringify({ name,
      kind: tool.actual.kind, parameters: JSON.parse(tool.schema) as unknown, approvalScope: tool.scope ?? null })).digest("hex");
    Object.defineProperty(hashes, name, { value: sha256, enumerable: true });
  }
  return Object.freeze({ approvalRequiredTools: Object.freeze(required), toolContractSha256ByName: Object.freeze(hashes) });
}
function intersectTools(parent: readonly RunnerTool[], child: readonly RunnerTool[], rootPolicy: ApprovalPolicy,
  parentPolicy: ApprovalPolicy, childPolicy: ApprovalPolicy): readonly RunnerTool[] {
  const parents = toolMap(parent), children = toolMap(child), selected: RunnerTool[] = [];
  for (const [name, actualChild] of children) {
    const actualParent = parents.get(name);
    if (!actualParent || actualParent.actual.kind !== actualChild.actual.kind || actualParent.schema !== actualChild.schema
      || actualParent.scope !== actualChild.scope) continue;
    const p = actualParent.actual, c = actualChild.actual, execute = c.execute;
    selected.push(Object.freeze({ name: c.name, description: c.description, parameters: freeze(JSON.parse(actualChild.schema) as Record<string, unknown>),
      kind: c.kind, readOnly: p.readOnly === true && c.readOnly === true,
      needsApproval: p.needsApproval === true || c.needsApproval === true,
      // Approval policies are not a total order. Preserve each actual policy's demand, without inheriting a grant.
      mandatoryApproval: p.mandatoryApproval === true || c.mandatoryApproval === true
        || requiresApproval(rootPolicy, p) || requiresApproval(parentPolicy, p) || requiresApproval(childPolicy, c),
      concurrencySafe: p.concurrencySafe === true && c.concurrencySafe === true,
      ...(actualChild.scope === undefined ? {} : { approvalScope: actualChild.scope }),
      execute: (args: unknown, context: ToolExecutionContext) => execute.call(c, args, context),
    }));
  }
  return Object.freeze(selected);
}
/** Computes a conservative immutable child capability image. The Store must still perform
 * atomic family admission/usage settlement; this function neither counts tasks nor pre-authorizes money. */
export function selectSubagentPolicy(input: SelectSubagentPolicyInput): Readonly<SelectedSubagentPolicy> {
  const raw = object(input); keys(raw, ["principal", "rootAgent", "parentAgent", "targetAgent", "task", "parentTools", "childTools",
    "rootLimits", "runnerCeilings", "parentDepth", "rootDeadlineAtMs", "nowMs"], ["parentLimits", "parentPolicy"]);
  const taskResult = SubagentTaskInput.safeParse(JSON.parse(canonicalSchema(input.task))); if (!taskResult.success) invalid();
  const task = taskResult.data, principal = actualPrincipal(input.principal);
  const target = resolveSubagentTarget({ principal, rootAgent: input.rootAgent, parentAgent: input.parentAgent,
    ...(input.parentPolicy === undefined ? {} : { parentPolicy: input.parentPolicy }), target: task.target });
  const actual = identity(input.targetAgent, principal.tenantId); if (!same(target, actual)) denied();
  const root = identity(input.rootAgent, principal.tenantId), parent = identity(input.parentAgent, principal.tenantId);
  const parentDepth = natural(input.parentDepth, 7, true);
  if (parentDepth === 0 && !same(root, parent) || parentDepth > 0 && input.parentPolicy === undefined) denied();
  const runner = object(input.runnerCeilings); keys(runner, ["maxDepth", "maxConcurrent", "maxTasks"]);
  const rootPolicy = policy(input.rootAgent); if (!rootPolicy) denied();
  const parentPolicy = parentPolicyFor(input, root, parent), childPolicy = policy(input.targetAgent);
  const policies = [rootPolicy, parentPolicy, childPolicy].filter((p): p is SubagentPolicy => p !== undefined);
  const ceilings = { maxDepth: natural(runner.maxDepth, 8), maxConcurrent: natural(runner.maxConcurrent, 8), maxTasks: natural(runner.maxTasks, 64) };
  for (const p of policies) {
    ceilings.maxDepth = Math.min(ceilings.maxDepth, p.maxDepth);
    ceilings.maxConcurrent = Math.min(ceilings.maxConcurrent, p.maxConcurrent);
    ceilings.maxTasks = Math.min(ceilings.maxTasks, p.maxTasks);
  }
  const depth = parentDepth + 1; if (depth > ceilings.maxDepth) limited();
  const limits = limitLayer(input.rootLimits, true) as Required<Limits>;
  const layers = [input.parentLimits, input.rootAgent.limits, input.parentAgent.limits, input.targetAgent.limits,
    ...policies.map(p => p.limits), task.limits];
  for (const layer of layers) {
    if (layer === undefined) continue;
    const parsed = limitLayer(layer);
    for (const key of LIMIT_KEYS) if (parsed[key] !== undefined) limits[key] = Math.min(limits[key], parsed[key]);
  }
  const now = natural(input.nowMs, Number.MAX_SAFE_INTEGER, true), deadline = natural(input.rootDeadlineAtMs, Number.MAX_SAFE_INTEGER);
  if (deadline <= now) limited();
  limits.maxWallClockMs = Math.min(limits.maxWallClockMs, deadline - now);
  const effectiveDeadline = now + limits.maxWallClockMs;
  let selectedPolicy: SubagentPolicy | null = null;
  if (childPolicy) {
    const targets = childPolicy.targets.filter(pin => rootAllows(root, rootPolicy, pin) && rootAllows(parent, parentPolicy, pin)
      && (!same(actual, pin) || childPolicy.allowSelf));
    const allowSelf = childPolicy.allowSelf && rootAllows(root, rootPolicy, actual) && rootAllows(parent, parentPolicy, actual);
    if (targets.length || allowSelf) selectedPolicy = freeze({ targets, allowSelf, ...ceilings, limits: { ...limits }, context: "prompt" as const });
  }
  const tools = intersectTools(input.parentTools, input.childTools, approvalPolicy(input.rootAgent.approvalPolicy),
    approvalPolicy(input.parentAgent.approvalPolicy), approvalPolicy(input.targetAgent.approvalPolicy));
  const toolAuthority = subagentToolAuthority(tools, "on-request");
  return Object.freeze({ target, depth, input: Object.freeze([Object.freeze({ type: "text" as const, text: task.prompt })]),
    tools, ...toolAuthority, approvalPolicy: "on-request", limits: Object.freeze(limits), ceilings: Object.freeze(ceilings),
    selectedPolicy, deadlineAtMs: effectiveDeadline });
}
