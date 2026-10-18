import { z } from "zod";

/** Real producer milestones. Model middleware requests are deliberately not lifecycle phases. */
export const LifecycleHookPhase = z.enum([
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
  "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt",
]);
export type LifecycleHookPhase = z.infer<typeof LifecycleHookPhase>;
export const LifecycleHookOutcome = z.enum([
  "observed", "modified", "denied", "failed", "timed_out", "cancelled", "skipped",
]);
export type LifecycleHookOutcome = z.infer<typeof LifecycleHookOutcome>;
const fields = {
  packageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  outcome: LifecycleHookOutcome,
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
/** No owner, body, URL, key, arbitrary reason or raw exception is a report field. */
export const LifecycleHookReport = z.object({
  ...fields, kind: z.literal("observer"), phase: LifecycleHookPhase,
}).strict();
export type LifecycleHookReport = z.infer<typeof LifecycleHookReport>;
export const LifecycleMiddlewareStage = z.enum(["prompt", "model", "tool"]);
export type LifecycleMiddlewareStage = z.infer<typeof LifecycleMiddlewareStage>;
export const LifecycleMiddlewareReport = z.object({
  ...fields, kind: z.literal("middleware"), stage: LifecycleMiddlewareStage,
}).strict();
export type LifecycleMiddlewareReport = z.infer<typeof LifecycleMiddlewareReport>;
