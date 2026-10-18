import type {
  Approval, ApprovalDecision, DynamicToolResultRequest, Principal, SubagentTaskStatusResponse, Turn,
} from "@agent-service/protocol";

export type DelegatedToolResult = Pick<DynamicToolResultRequest, "content"> & { readonly isError?: boolean };

/** Root-addressed controls. Implementations must re-read the actual root owner/task membership;
 * these methods confer no authority to address a child as an ordinary standalone session. */
export interface SubagentControlService {
  listDelegatedTasks(principal: Principal, rootSessionId: string, rootTurnId: string): Promise<SubagentTaskStatusResponse[]>;
  getDelegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<SubagentTaskStatusResponse>;
  resolveDelegatedApproval(principal: Principal, rootSessionId: string, taskId: string, approvalId: string,
    decision: ApprovalDecision): Promise<Approval>;
  submitDelegatedToolResult(principal: Principal, rootSessionId: string, taskId: string, toolCallId: string,
    result: DelegatedToolResult): Promise<void>;
  interruptDelegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<Turn>;
  /** Logical tombstone only, and only through the independently enabled session-tombstone authority. */
  deleteDelegatedSession(principal: Principal, rootSessionId: string, taskId: string): Promise<void>;
}
