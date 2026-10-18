import { z } from "zod";
import { idSchema, Limits, Usage } from "./common.js";

const TargetName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const boundedUtf8 = (maximum: number) => z.string().max(maximum).refine(
  value => new TextEncoder().encode(value).byteLength <= maximum,
  "Subagent text exceeds the UTF-8 byte limit",
);
const SubagentLimits = Limits.strict().superRefine((limits, ctx) => {
  for (const value of Object.values(limits)) {
    if (value !== undefined && !Number.isFinite(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Subagent limits must be finite" });
    }
  }
});

/** A label selects a pinned same-tenant agent, never a model/credential/endpoint supplied by a tool. */
export const SubagentTarget = z.object({
  name: TargetName.refine(name => name !== "self", "self is reserved for the parent agent"),
  agentId: idSchema("agt"),
  agentVersion: z.number().int().positive(),
}).strict();
export type SubagentTarget = z.infer<typeof SubagentTarget>;

/** Immutable agent policy. Presence does not enable task execution without the runner fleet gate. */
export const SubagentPolicy = z.object({
  allowSelf: z.boolean().default(false),
  targets: z.array(SubagentTarget).max(16).default([]),
  maxDepth: z.number().int().min(1).max(8).default(3),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  maxTasks: z.number().int().min(1).max(64).default(8),
  /** Further tightens the root family budget; a descendant can never replace the root budget. */
  limits: SubagentLimits.default({}),
  /** User-confirmed contract: background must be explicitly included in the task prompt. */
  context: z.literal("prompt").default("prompt"),
}).strict().superRefine((policy, ctx) => {
  if (!policy.allowSelf && !policy.targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A subagent policy must allow a target" });
  }
  if (new Set(policy.targets.map(target => target.name)).size !== policy.targets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Subagent target names must be distinct" });
  }
  const identities = policy.targets.map(target => JSON.stringify([target.agentId, target.agentVersion]));
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Subagent target versions must be distinct" });
  }
});
export type SubagentPolicy = z.infer<typeof SubagentPolicy>;

/** The model chooses a configured label. It cannot select owner, history, tools or approval grants. */
export const SubagentTaskInput = z.object({
  target: TargetName,
  prompt: boundedUtf8(32_768).refine(value => value.trim().length > 0, "Task prompt is required"),
  description: boundedUtf8(256).optional(),
  limits: SubagentLimits.optional(),
}).strict();
export type SubagentTaskInput = z.infer<typeof SubagentTaskInput>;

export const SubagentTaskStatus = z.enum([
  "reserved", "running", "completed", "failed", "interrupted", "outcome_unknown",
]);
export type SubagentTaskStatus = z.infer<typeof SubagentTaskStatus>;

/**
 * An activity belongs to its parent's seq space. Child seq values are never spliced into that
 * stream. Child usage is an informational projection of already charged child ledger entries.
 */
export const SubagentActivityFields = z.object({
  type: z.literal("subagentActivity"),
  taskId: idSchema("sat"),
  rootSessionId: idSchema("sess"),
  rootTurnId: idSchema("turn"),
  parentCallItemId: idSchema("item"),
  childSessionId: idSchema("sess"),
  childTurnId: idSchema("turn").optional(),
  agentId: idSchema("agt"),
  agentVersion: z.number().int().positive(),
  depth: z.number().int().min(1).max(8),
  taskStatus: SubagentTaskStatus,
  childUsage: Usage.optional(),
});
export type SubagentActivityFields = z.infer<typeof SubagentActivityFields>;

export const SubagentTaskStatusResponse = z.object({
  taskId: idSchema("sat"),
  rootSessionId: idSchema("sess"),
  rootTurnId: idSchema("turn"),
  parentSessionId: idSchema("sess"),
  parentTurnId: idSchema("turn"),
  parentCallItemId: idSchema("item"),
  childSessionId: idSchema("sess"),
  childTurnId: idSchema("turn").optional(),
  status: SubagentTaskStatus,
  depth: z.number().int().min(1).max(8),
  createdAtMs: z.number().int(),
  completedAtMs: z.number().int().optional(),
  childUsage: Usage.optional(),
}).strict();
export type SubagentTaskStatusResponse = z.infer<typeof SubagentTaskStatusResponse>;
