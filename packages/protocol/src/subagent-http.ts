import { z } from "zod";
import { idSchema } from "./common.js";
import { Approval, ApprovalResponseRequest } from "./approval.js";
import { DynamicToolResultRequest, Turn } from "./session.js";
import { SubagentTaskStatusResponse } from "./subagents.js";

/** Independent router tombstone gate; root-lease task activation alone is never delete authority. */
export const INTERNAL_SUBAGENT_TOMBSTONE_ACK_VALUE = "root-lease-child-tombstone-v1" as const;

export const SubagentRootParams = z.object({ id: idSchema("sess") }).strict();
export const SubagentTaskParams = SubagentRootParams.extend({ taskId: idSchema("sat") }).strict();
export const SubagentApprovalParams = SubagentTaskParams.extend({ approvalId: idSchema("apr") }).strict();
export const SubagentEmptyQuery = z.object({}).strict();
/** One immutable root-turn family, not an unbounded history across all turns of a root session. */
export const SubagentListQuery = z.object({ rootTurnId: idSchema("turn") }).strict();
export const SubagentApprovalRequest = ApprovalResponseRequest.strict();
export const SubagentToolResultRequest = DynamicToolResultRequest.extend({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()),
}).strict();
export const SubagentInterruptRequest = z.object({}).strict();
export const SubagentTaskListResponse = z.object({
  data: z.array(SubagentTaskStatusResponse).max(64), nextCursor: z.null(),
}).strict();
/** Mutation receipts deliberately do not duplicate approval args or child turn plaintext. */
export const SubagentApprovalResponse = Approval.omit({ args: true, reason: true, decidedBy: true }).strict();
export const SubagentInterruptResponse = Turn.omit({ metadata: true, partialText: true, error: true, idempotencyKey: true }).strict();
export const SubagentControlOkResponse = z.object({ ok: z.literal(true) }).strict();
export type SubagentListQuery = z.infer<typeof SubagentListQuery>;
export type SubagentTaskListResponse = z.infer<typeof SubagentTaskListResponse>;
export type SubagentApprovalResponse = z.infer<typeof SubagentApprovalResponse>;
export type SubagentInterruptResponse = z.infer<typeof SubagentInterruptResponse>;
