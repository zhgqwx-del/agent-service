import { describe, expect, it } from "vitest";
import { idSchema, isCanonicalId } from "../src/common.js";
import { SubagentPolicy, SubagentTaskInput, SubagentTaskStatusResponse } from "../src/subagents.js";

const uuid = "01926666-0000-7000-8000-000000000001";
const agentId = `agt_${uuid}`;
const target = { name: "researcher", agentId, agentVersion: 2 };

describe("subagent public policy and task boundary", () => {
  it("uses explicit bounded defaults without granting authority through model arguments", () => {
    expect(SubagentPolicy.parse({ allowSelf: true })).toMatchObject({ allowSelf: true, targets: [], context: "prompt",
      maxDepth: 3, maxConcurrent: 2, maxTasks: 8, limits: {} });
    expect(SubagentTaskInput.parse({ target: "self", prompt: "Research this topic." })).toEqual({
      target: "self", prompt: "Research this topic.",
    });
  });
  it("pins same-tenant target identities by immutable agent version", () => {
    expect(SubagentPolicy.parse({ allowSelf: false, targets: [target] }).targets).toEqual([target]);
    for (const bad of [{ ...target, agentVersion: undefined }, { ...target, agentVersion: 0 },
      { ...target, tenantId: "another-tenant" }, { ...target, name: "self" }, { ...target, name: "../../agent" }]) {
      expect(SubagentPolicy.safeParse({ targets: [bad] }).success).toBe(false);
    }
  });
  it("rejects empty authority and alias/version ambiguity", () => {
    expect(SubagentPolicy.safeParse({}).success).toBe(false);
    expect(SubagentPolicy.safeParse({ allowSelf: false }).success).toBe(false);
    expect(SubagentPolicy.safeParse({ targets: [target, { ...target, agentVersion: 3 }] }).success).toBe(false);
    expect(SubagentPolicy.safeParse({ targets: [target, { ...target, name: "other" }] }).success).toBe(false);
  });
  it.each(["tenantId", "userId", "agentId", "agentVersion", "tools", "credentials", "approvalPolicy", "history", "context", "rootFence"])(
    "rejects model-supplied %s authority", field => {
      expect(SubagentTaskInput.safeParse({ target: "self", prompt: "task", [field]: "forged" }).success).toBe(false);
    },
  );
  it("does not advertise implicit history copying and rejects unbounded limits", () => {
    expect(SubagentPolicy.parse({ allowSelf: true, context: "prompt" }).context).toBe("prompt");
    for (const bad of [{ maxDepth: 9 }, { maxConcurrent: 9 }, { maxTasks: 65 }, { context: "boundedHistory" },
      { maxHistoryMessages: 8 }, { maxHistoryBytes: 4096 }, { limits: { maxCostCNY: Infinity } }, { limits: { unknown: 1 } }]) {
      expect(SubagentPolicy.safeParse({ allowSelf: true, ...bad }).success).toBe(false);
    }
  });
  it("bounds prompt by UTF-8 bytes and refuses empty or extra secret fields", () => {
    expect(SubagentTaskInput.safeParse({ target: "self", prompt: "汉".repeat(10_922) }).success).toBe(true);
    expect(SubagentTaskInput.safeParse({ target: "self", prompt: "汉".repeat(10_923) }).success).toBe(false);
    expect(SubagentTaskInput.safeParse({ target: "self", prompt: " \n\t " }).success).toBe(false);
    expect(SubagentTaskInput.safeParse({ target: "self", prompt: "task", apiKey: "not-a-real-key" }).success).toBe(false);
  });
  it("uses canonical task ids and keeps private fence/claim/key material out of status responses", () => {
    const taskId = `sat_${uuid}`;
    expect(idSchema("sat").parse(taskId)).toBe(taskId);
    expect(isCanonicalId("sat", taskId)).toBe(true);
    expect(isCanonicalId("sat", taskId.toUpperCase())).toBe(false);
    const response = { taskId, rootSessionId: `sess_${uuid}`, rootTurnId: `turn_${uuid}`,
      parentSessionId: `sess_${uuid}`, parentTurnId: `turn_${uuid}`, parentCallItemId: `item_${uuid}`,
      childSessionId: `sess_01926666-0000-7000-8000-000000000002`, status: "outcome_unknown", depth: 1, createdAtMs: 1 };
    expect(SubagentTaskStatusResponse.parse(response)).toEqual(response);
    for (const field of ["rootFence", "claimToken", "providerKey", "prompt", "internalAuthority"]) {
      expect(SubagentTaskStatusResponse.safeParse({ ...response, [field]: "forged" }).success).toBe(false);
    }
  });
});
