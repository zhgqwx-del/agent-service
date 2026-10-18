import { describe, expect, it, vi } from "vitest";
import type { AgentDefinition, Limits, SubagentPolicy } from "@agent-service/protocol";
import { resolveSubagentTarget, selectSubagentPolicy, subagentToolAuthority, SubagentPolicyError } from "../src/subagents/policy.js";
import type { SelectSubagentPolicyInput } from "../src/subagents/policy.js";
import type { RunnerTool } from "../src/tools/types.js";

const owner = { tenantId: "subagent-tenant", userId: "actual-user" };
const ROOT = "agt_00000000-0000-7000-8000-000000000001";
const CHILD = "agt_00000000-0000-7000-8000-000000000002";
const OTHER = "agt_00000000-0000-7000-8000-000000000003";
const OUTSIDE = "agt_00000000-0000-7000-8000-000000000004";
const rootLimits: Required<Limits> = { maxSteps: 20, maxToolCalls: 50, maxWallClockMs: 10_000, maxCostCNY: 10, maxOutputTokensPerStep: 1000 };
const policy = (targets = [{ name: "worker", agentId: CHILD, agentVersion: 2 }]): SubagentPolicy => ({ allowSelf: false,
  targets, maxDepth: 3, maxConcurrent: 2, maxTasks: 8, limits: {}, context: "prompt" });
const agent = (id = ROOT, version = 1, subagents?: SubagentPolicy): AgentDefinition => ({ id, version, tenantId: owner.tenantId,
  name: "agent", instructions: "child owns its instructions", model: { provider: "configured", model: "model" }, tools: [], mcpServers: [], skills: [],
  ...(subagents ? { subagents } : {}), limits: {}, approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none",
  metadata: { privateCanary: "must-not-inherit" }, createdAtMs: 1 });
function tool(overrides: Partial<RunnerTool> = {}): RunnerTool {
  return { name: "read", description: "child description", kind: "builtin", readOnly: true, concurrencySafe: true,
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "child result" }] })), ...overrides };
}
function input(overrides: Partial<SelectSubagentPolicyInput> = {}): SelectSubagentPolicyInput {
  const root = agent(ROOT, 1, policy());
  return { principal: owner, rootAgent: root, parentAgent: root, targetAgent: agent(CHILD, 2), task: { target: "worker", prompt: "explicit task only" },
    parentTools: [tool()], childTools: [tool()], rootLimits, runnerCeilings: { maxDepth: 4, maxConcurrent: 3, maxTasks: 10 },
    parentDepth: 0, rootDeadlineAtMs: 9000, nowMs: 1000, ...overrides };
}
function target(value = input()) {
  return resolveSubagentTarget({ principal: value.principal, rootAgent: value.rootAgent, parentAgent: value.parentAgent,
    ...(value.parentPolicy === undefined ? {} : { parentPolicy: value.parentPolicy }), target: value.task.target });
}

describe("pure root-bounded subagent policy selection", () => {
  it("resolves only an explicit pinned label and verifies the externally read actual agent", () => {
    const value = input(), selected = selectSubagentPolicy(value);
    expect(target(value)).toEqual({ agentId: CHILD, agentVersion: 2 }); expect(selected.target).toEqual(target(value));
    expect(selected.depth).toBe(1); expect(selected.input).toEqual([{ type: "text", text: "explicit task only" }]);
    expect(Object.keys(selected).sort()).toEqual(["approvalPolicy", "approvalRequiredTools", "ceilings", "deadlineAtMs", "depth", "input", "limits", "selectedPolicy", "target", "toolContractSha256ByName", "tools"]);
    expect(selected.selectedPolicy).toBeNull();
    expect(JSON.stringify(selected)).not.toContain("must-not-inherit");
    expect([selected, selected.target, selected.input, selected.input[0], selected.limits, selected.ceilings, selected.tools].every(Object.isFrozen)).toBe(true);
  });
  it.each([
    { targetAgent: agent(OTHER, 2) }, { targetAgent: agent(CHILD, 3) },
    { targetAgent: { ...agent(CHILD, 2), tenantId: "another-tenant" } },
    { parentAgent: { ...agent(ROOT, 1, policy()), tenantId: "another-tenant" } },
    { rootAgent: { ...agent(ROOT, 1, policy()), tenantId: "another-tenant" } },
    { task: { target: "not-listed", prompt: "task" } }, { task: { target: CHILD, prompt: "task" } },
  ])("rejects wrong target identity, tenant and unlisted selectors (%#)", overrides => {
    expect(() => selectSubagentPolicy(input(overrides))).toThrow(SubagentPolicyError);
  });
  it("requires explicit self permission even for an alias to the parent identity", () => {
    const implicit = agent(ROOT, 1, policy([{ name: "alias", agentId: ROOT, agentVersion: 1 }]));
    expect(() => selectSubagentPolicy(input({ rootAgent: implicit, parentAgent: implicit, targetAgent: implicit,
      task: { target: "alias", prompt: "task" } }))).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy(input({ task: { target: "self", prompt: "task" }, targetAgent: agent() }))).toThrow(SubagentPolicyError);
    const explicit = agent(ROOT, 1, { ...policy(), allowSelf: true });
    expect(selectSubagentPolicy(input({ rootAgent: explicit, parentAgent: explicit, targetAgent: explicit,
      task: { target: "self", prompt: "task" } })).target).toEqual({ agentId: ROOT, agentVersion: 1 });
  });
  it("does not treat an absent policy as permission or turn self's default into true", () => {
    expect(() => selectSubagentPolicy(input({ parentAgent: agent() }))).toThrow(SubagentPolicyError);
    const implicit = { ...policy(), allowSelf: undefined } as unknown as SubagentPolicy;
    const root = agent(ROOT, 1, implicit);
    expect(() => selectSubagentPolicy(input({ rootAgent: root, parentAgent: root, targetAgent: root,
      task: { target: "self", prompt: "task" } }))).toThrow(SubagentPolicyError);
  });
  it("intersects nested target identities with the root allowlist, not only local labels", () => {
    const root = agent(ROOT, 1, policy([{ name: "worker", agentId: CHILD, agentVersion: 2 }, { name: "root-approved", agentId: OTHER, agentVersion: 3 }]));
    const parent = agent(CHILD, 2, policy([{ name: "local-label", agentId: OTHER, agentVersion: 3 }, { name: "escape", agentId: OUTSIDE, agentVersion: 1 }]));
    const value = input({ rootAgent: root, parentAgent: parent, parentPolicy: parent.subagents, parentDepth: 1,
      targetAgent: agent(OTHER, 3), task: { target: "local-label", prompt: "task" } });
    expect(selectSubagentPolicy(value).depth).toBe(2);
    expect(() => selectSubagentPolicy({ ...value, targetAgent: agent(OUTSIDE), task: { target: "escape", prompt: "task" } })).toThrow(SubagentPolicyError);
    const drifted = agent(CHILD, 2, policy([{ name: "local-label", agentId: OTHER, agentVersion: 4 }]));
    expect(() => selectSubagentPolicy({ ...value, parentAgent: drifted, targetAgent: agent(OTHER, 4) })).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy({ ...value, parentDepth: 0 })).toThrow(SubagentPolicyError);
  });
  it("does not admit an unauthorized parent branch merely because its target is root-approved", () => {
    const parent = agent(OUTSIDE, 1, policy());
    expect(() => selectSubagentPolicy(input({ parentAgent: parent, parentDepth: 1 }))).toThrow(SubagentPolicyError);
  });
  it("persists the ancestor intersection so A to B to C cannot escape B's narrow allowlist", () => {
    const rootPolicy = policy([{ name: "worker", agentId: CHILD, agentVersion: 2 }, { name: "grandchild", agentId: OTHER, agentVersion: 3 },
      { name: "outside", agentId: OUTSIDE, agentVersion: 1 }]);
    const root = agent(ROOT, 1, rootPolicy);
    const b = agent(CHILD, 2, policy([{ name: "next", agentId: OTHER, agentVersion: 3 }]));
    const bSelection = selectSubagentPolicy(input({ rootAgent: root, parentAgent: root, targetAgent: b }));
    expect(bSelection.selectedPolicy?.targets).toEqual([{ name: "next", agentId: OTHER, agentVersion: 3 }]);
    const c = agent(OTHER, 3, policy([{ name: "escape", agentId: OUTSIDE, agentVersion: 1 }]));
    const cSelection = selectSubagentPolicy(input({ rootAgent: root, parentAgent: b, parentPolicy: bSelection.selectedPolicy,
      parentDepth: 1, targetAgent: c, task: { target: "next", prompt: "task" } }));
    expect(cSelection.selectedPolicy).toBeNull();
    expect(() => selectSubagentPolicy(input({ rootAgent: root, parentAgent: c, parentPolicy: cSelection.selectedPolicy,
      parentDepth: 2, targetAgent: agent(OUTSIDE), task: { target: "escape", prompt: "task" } }))).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy(input({ rootAgent: root, parentAgent: b,
      parentDepth: 1, targetAgent: c, task: { target: "next", prompt: "task" } }))).toThrow(SubagentPolicyError);
  });
  it("cannot use a persisted override to broaden the actual parent's own targets or self authority", () => {
    const root = agent(ROOT, 1, policy([{ name: "worker", agentId: CHILD, agentVersion: 2 }, { name: "outside", agentId: OUTSIDE, agentVersion: 1 }]));
    const parent = agent(CHILD, 2, policy([{ name: "other", agentId: OTHER, agentVersion: 3 }]));
    const broad = { ...policy([{ name: "escape", agentId: OUTSIDE, agentVersion: 1 }]), allowSelf: true };
    expect(() => selectSubagentPolicy(input({ rootAgent: root, parentAgent: parent, parentPolicy: broad, parentDepth: 1,
      targetAgent: agent(OUTSIDE), task: { target: "escape", prompt: "task" } }))).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy(input({ rootAgent: root, parentAgent: parent, parentPolicy: broad, parentDepth: 1,
      targetAgent: parent, task: { target: "self", prompt: "task" } }))).toThrow(SubagentPolicyError);
  });
  it("preserves actual Unicode tenant equality without locale or user wildcard aliases", () => {
    const unicode = { tenantId: "中".repeat(100), userId: "actual-user" };
    const value = input(); const root = { ...value.rootAgent, tenantId: unicode.tenantId };
    expect(selectSubagentPolicy({ ...value, principal: unicode, rootAgent: root, parentAgent: root,
      targetAgent: { ...value.targetAgent, tenantId: unicode.tenantId } }).target.agentId).toBe(CHILD);
    expect(() => selectSubagentPolicy({ ...value, principal: { ...owner, userId: "*" } })).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy({ ...value, principal: { ...owner, tenantId: "x".repeat(129) } })).toThrow(SubagentPolicyError);
  });
  it("selects the minimum root/parent/child/policy/task limits and runner ceilings", () => {
    const root = agent(ROOT, 1, { ...policy(), maxDepth: 3, maxConcurrent: 3, maxTasks: 20, limits: { maxCostCNY: 3 } });
    root.limits = { maxSteps: 18 };
    const child = agent(CHILD, 2, { ...policy([{ name: "other", agentId: OTHER, agentVersion: 3 }]), maxDepth: 2,
      maxConcurrent: 2, maxTasks: 7, limits: { maxSteps: 12 } });
    child.limits = { maxToolCalls: 25, maxOutputTokensPerStep: 500 };
    const selected = selectSubagentPolicy(input({ rootAgent: root, parentAgent: root, targetAgent: child,
      parentLimits: { maxWallClockMs: 6000, maxSteps: 15 }, task: { target: "worker", prompt: "task", limits: { maxToolCalls: 5, maxCostCNY: 100 } },
      runnerCeilings: { maxDepth: 4, maxConcurrent: 1, maxTasks: 8 } }));
    expect(selected.limits).toEqual({ maxSteps: 12, maxToolCalls: 5, maxWallClockMs: 6000, maxCostCNY: 3, maxOutputTokensPerStep: 500 });
    expect(selected.ceilings).toEqual({ maxDepth: 2, maxConcurrent: 1, maxTasks: 7 }); expect(selected.deadlineAtMs).toBe(7000);
    expect(rootLimits.maxSteps).toBe(20); // Never mutate the caller's root budget.
  });
  it("inherits missing layers from all five required root limits and keeps the absolute wall deadline", () => {
    const selected = selectSubagentPolicy(input());
    expect(selected.limits).toEqual({ ...rootLimits, maxWallClockMs: 8000 }); expect(selected.deadlineAtMs).toBe(9000);
    const later = selectSubagentPolicy(input({ nowMs: 8500 })); expect(later.limits.maxWallClockMs).toBe(500); expect(later.deadlineAtMs).toBe(9000);
    expect(() => selectSubagentPolicy(input({ nowMs: 9000 }))).toThrow(SubagentPolicyError);
    const shallow = agent(ROOT, 1, { ...policy([{ name: "worker", agentId: CHILD, agentVersion: 2 }, { name: "next", agentId: OTHER, agentVersion: 3 }]), maxDepth: 1 });
    const parent = agent(CHILD, 2, policy([{ name: "next", agentId: OTHER, agentVersion: 3 }]));
    expect(() => selectSubagentPolicy(input({ rootAgent: shallow, parentAgent: parent, parentPolicy: parent.subagents,
      parentDepth: 1, targetAgent: agent(OTHER, 3), task: { target: "next", prompt: "task" } }))).toThrowError(new SubagentPolicyError("limit"));
  });
  it.each([
    { rootLimits: { maxSteps: 1 } }, { parentLimits: { maxCostCNY: Infinity } }, { parentLimits: { maxSteps: NaN } },
    { task: { target: "worker", prompt: "task", limits: { maxWallClockMs: 0 } } },
    { nowMs: -1 }, { rootDeadlineAtMs: Number.MAX_SAFE_INTEGER + 1 }, { parentDepth: 0.5 },
    { runnerCeilings: { maxDepth: 9, maxConcurrent: 2, maxTasks: 8 } },
    { runnerCeilings: { maxDepth: 3, maxConcurrent: 0, maxTasks: 8 } },
  ])("rejects non-finite, missing-root and invalid budget images (%#)", overrides => {
    expect(() => selectSubagentPolicy(input(overrides as Partial<SelectSubagentPolicyInput>))).toThrow(SubagentPolicyError);
  });
  it.each([
    { target: "worker", prompt: "task", history: [] }, { target: "worker", prompt: "task", grants: ["old"] },
    { target: "worker", prompt: "task", metadata: { credential: "private" } },
    { target: "worker", prompt: "task", owner: { tenantId: "other", userId: "other" } },
    { target: "worker", prompt: "task", model: { provider: "private", model: "private" } },
    { target: "worker", prompt: "task", tools: ["write"] }, { target: "worker", prompt: " " },
  ])("accepts prompt-only tasks, never inherited capabilities or arbitrary task overrides (%#)", task => {
    expect(() => selectSubagentPolicy(input({ task } as Partial<SelectSubagentPolicyInput>))).toThrow(SubagentPolicyError);
  });
  it("intersects actual tool contracts using canonical schemas and retains the real child executor", async () => {
    const parent = tool({ description: "parent", execute: vi.fn(async () => ({ content: [] })) });
    const child = tool({ parameters: { additionalProperties: false, required: ["value"], properties: { value: { type: "string" } }, type: "object" } });
    const selected = selectSubagentPolicy(input({ parentTools: [parent], childTools: [child] }));
    expect(selected.tools).toHaveLength(1); expect(selected.tools[0]?.description).toBe("child description");
    const ctx = { principal: owner, sessionId: "child", turnId: "turn", toolCallId: "call", signal: new AbortController().signal };
    expect(await selected.tools[0]!.execute({ value: "arg" }, ctx)).toEqual({ content: [{ type: "text", text: "child result" }] });
    expect(child.execute).toHaveBeenCalledTimes(1); expect(parent.execute).not.toHaveBeenCalled();
    child.parameters.type = "changed-after-selection"; expect(selected.tools[0]?.parameters.type).toBe("object");
    expect(Object.isFrozen(selected.tools[0]?.parameters)).toBe(true);
  });
  it.each([
    { kind: "mcp" }, { parameters: { type: "object" } }, { approvalScope: "other-scope" },
    { parameters: { type: "object", properties: { value: { type: "string" } }, required: ["other", "value"], additionalProperties: false } },
  ])("does not delegate a same-name tool with a different kind/schema/grant identity (%#)", change => {
    const selected = selectSubagentPolicy(input({ parentTools: [tool({ approvalScope: "parent-scope" })],
      childTools: [tool({ approvalScope: "parent-scope", ...change } as Partial<RunnerTool>)] }));
    expect(selected.tools).toEqual([]);
  });
  it("keeps array order meaningful and treats absent approvalScope as distinct from a real scope", () => {
    const p = tool({ parameters: { type: "object", required: ["a", "b"] } });
    const c = tool({ parameters: { required: ["b", "a"], type: "object" } });
    expect(selectSubagentPolicy(input({ parentTools: [p], childTools: [c] })).tools).toEqual([]);
    expect(selectSubagentPolicy(input({ parentTools: [tool()], childTools: [tool({ approvalScope: "bound" })] })).tools).toEqual([]);
  });
  it("uses AND for read-only/concurrency and OR for flags without inheriting any approval grant", () => {
    const root = agent(ROOT, 1, policy()); root.approvalPolicy = "never";
    const childAgent = agent(CHILD, 2); childAgent.approvalPolicy = "never";
    const p = tool({ readOnly: true, concurrencySafe: true, needsApproval: true, mandatoryApproval: false });
    const c = tool({ readOnly: false, concurrencySafe: undefined, needsApproval: false, mandatoryApproval: true });
    const selected = selectSubagentPolicy(input({ rootAgent: root, parentAgent: root, targetAgent: childAgent, parentTools: [p], childTools: [c] }));
    expect(selected.approvalPolicy).toBe("on-request");
    expect(selected.tools[0]).toMatchObject({ readOnly: false, concurrencySafe: false, needsApproval: true, mandatoryApproval: true });
    expect(Object.keys(selected.tools[0]!).some(key => /grant/i.test(key))).toBe(false);
  });
  it.each([
    { parentPolicy: "untrusted", childPolicy: "never", readOnly: false, needsApproval: false },
    { parentPolicy: "on-request", childPolicy: "untrusted", readOnly: true, needsApproval: true },
    { parentPolicy: "never", childPolicy: "on-request", readOnly: true, needsApproval: true },
  ] as const)("conservatively composes incomparable approval policies (%#)", scenario => {
    const root = agent(ROOT, 1, policy()); root.approvalPolicy = scenario.parentPolicy;
    const child = agent(CHILD, 2); child.approvalPolicy = scenario.childPolicy;
    const t = tool({ readOnly: scenario.readOnly, needsApproval: scenario.needsApproval });
    expect(selectSubagentPolicy(input({ rootAgent: root, parentAgent: root, targetAgent: child, parentTools: [t], childTools: [t] })).tools[0]?.mandatoryApproval).toBe(true);
  });
  it("rejects duplicate names in either resolved tool array rather than silently overwriting", () => {
    expect(() => selectSubagentPolicy(input({ parentTools: [tool(), tool()] }))).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy(input({ childTools: [tool(), tool()] }))).toThrow(SubagentPolicyError);
  });
  it("provides stable content-free tool contract hashes and exact approval requirements", () => {
    const a = tool({ approvalScope: "catalog-v1", needsApproval: true });
    const b = tool({ approvalScope: "catalog-v1", readOnly: false, needsApproval: false,
      parameters: { additionalProperties: false, required: ["value"], properties: { value: { type: "string" } }, type: "object" } });
    const first = subagentToolAuthority([a], "on-request"), second = subagentToolAuthority([b], "never");
    expect(first.toolContractSha256ByName).toEqual(second.toolContractSha256ByName);
    expect(first.approvalRequiredTools).toEqual(["read"]); expect(second.approvalRequiredTools).toEqual([]);
    expect(first.toolContractSha256ByName.read).toMatch(/^[a-f0-9]{64}$/);
    expect(subagentToolAuthority([tool({ approvalScope: "changed" })], "on-request").toolContractSha256ByName.read).not.toBe(first.toolContractSha256ByName.read);
    expect(subagentToolAuthority([tool({ kind: "mcp", approvalScope: "catalog-v1" })], "on-request").toolContractSha256ByName.read).not.toBe(first.toolContractSha256ByName.read);
    expect(Object.isFrozen(first.toolContractSha256ByName)).toBe(true);
    expect(subagentToolAuthority([tool({ name: "__proto__" })], "on-request").toolContractSha256ByName)
      .toHaveProperty("__proto__");
  });
  it("rejects accessors/cycles/non-JSON tool identities without invoking them or returning raw errors", () => {
    const getter = vi.fn(() => "private"), parameters = Object.defineProperty({}, "secret", { enumerable: true, get: getter });
    expect(() => selectSubagentPolicy(input({ parentTools: [tool({ parameters })] }))).toThrowError(new SubagentPolicyError("invalid"));
    expect(getter).not.toHaveBeenCalled();
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => selectSubagentPolicy(input({ childTools: [tool({ parameters: cyclic })] }))).toThrow(SubagentPolicyError);
    expect(() => selectSubagentPolicy(input({ childTools: [tool({ parameters: { value: NaN } })] }))).toThrow(SubagentPolicyError);
  });
});
