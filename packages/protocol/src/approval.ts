import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * `accept`: run this call. `acceptForSession`: run and auto-allow the same tool for the rest of the session.
 * `decline`: skip the call (the model sees a declined result and the turn continues).
 * `cancel`: skip the call and interrupt the turn.
 */
export const ApprovalDecision = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const ApprovalStatus = z.enum(["pending", "resolved", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: idSchema("apr"),
  sessionId: idSchema("sess"),
  turnId: idSchema("turn"),
  itemId: idSchema("item"),
  status: ApprovalStatus,
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  reason: z.string().optional(),
  availableDecisions: z.array(ApprovalDecision),
  decision: ApprovalDecision.optional(),
  decidedBy: z.string().optional(),
  createdAtMs: z.number().int(),
  expiresAtMs: z.number().int(),
  resolvedAtMs: z.number().int().optional(),
});
export type Approval = z.infer<typeof Approval>;

export const ApprovalResponseRequest = z.object({
  decision: ApprovalDecision,
});
export type ApprovalResponseRequest = z.infer<typeof ApprovalResponseRequest>;
