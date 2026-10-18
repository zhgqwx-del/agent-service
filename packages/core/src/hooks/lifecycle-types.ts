import type {
  InputPart, LifecycleHookPhase, LifecycleHookReport, LifecycleMiddlewareReport,
  Limits, ModelRef, Principal, ToolKind,
} from "@agent-service/protocol";
import type { TranscriptMessage } from "../engine/types.js";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";

export interface LifecycleOperationContext {
  readonly owner: Principal;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly itemId?: string;
  readonly step?: number;
}
export interface LifecycleToolMetadata {
  readonly name: string;
  readonly kind: ToolKind;
  readonly readOnly: boolean;
}
/** Server-derived identities only; lifecycle observation never grants tool or delegation authority. */
export type LifecycleHookContext = LifecycleOperationContext & (
  | { readonly phase: "SessionStart" }
  | { readonly phase: "UserPromptSubmit"; readonly turnId: string; readonly itemId: string;
      readonly submission: "initial" | "steer" }
  | { readonly phase: "PreToolUse"; readonly turnId: string; readonly itemId: string;
      readonly toolCallId: string; readonly tool: LifecycleToolMetadata }
  | { readonly phase: "PostToolUse"; readonly turnId: string; readonly itemId: string;
      readonly toolCallId: string; readonly tool: LifecycleToolMetadata; readonly isError: boolean }
  | { readonly phase: "PermissionRequest"; readonly turnId: string; readonly itemId: string;
      readonly toolCallId: string; readonly tool: LifecycleToolMetadata; readonly approvalId: string }
  | { readonly phase: "PreCompact" | "PostCompact"; readonly throughSeq: number }
  | { readonly phase: "SubagentStart" | "SubagentStop"; readonly turnId: string;
      readonly subagent: { readonly taskId: string; readonly childSessionId: string; readonly childTurnId: string } }
  | { readonly phase: "Stop"; readonly turnId: string;
      readonly outcome: "completed" | "failed" | "interrupted" | "unknown" }
  | { readonly phase: "Interrupt"; readonly turnId: string }
);
export interface LifecyclePromptInput { readonly input: readonly InputPart[] }
export interface LifecyclePromptResult extends LifecyclePromptInput {
  readonly allow: boolean;
  readonly reports: readonly LifecycleMiddlewareReport[];
}
export interface LifecycleModelInput {
  readonly step: number;
  readonly modelRef: ModelRef;
  readonly systemPrompt: string;
  /** Full engine-neutral request; fixed packages preserve it byte-for-byte. */
  readonly input: readonly TranscriptMessage[];
  readonly limits: Readonly<Required<Limits>>;
}
export interface LifecycleModelResult extends LifecycleModelInput {
  readonly allow: boolean;
  readonly reports: readonly LifecycleMiddlewareReport[];
}
export interface LifecycleToolInput { readonly args: unknown }
export interface LifecycleToolResult extends LifecycleToolInput {
  readonly allow: boolean;
  readonly reports: readonly LifecycleMiddlewareReport[];
}
export interface LifecycleHookService {
  readonly enabled: boolean;
  version(owner: Principal): string | undefined;
  observe(context: LifecycleHookContext, signal: AbortSignal): Promise<readonly LifecycleHookReport[]>;
  beforePrompt(context: LifecycleOperationContext, input: LifecyclePromptInput, signal: AbortSignal): Promise<LifecyclePromptResult>;
  beforeModelStep(context: LifecycleOperationContext, input: LifecycleModelInput, signal: AbortSignal): Promise<LifecycleModelResult>;
  beforeTool(context: LifecycleHookContext & { readonly phase: "PreToolUse" }, input: LifecycleToolInput,
    signal: AbortSignal): Promise<LifecycleToolResult>;
  /** Stops admission synchronously and waits for actual authorization/package tasks, not a race proxy. */
  close(): Promise<void>;
}
interface PackageAcl { readonly id: string; readonly subjects: readonly Principal[] }
export type LifecyclePackageDefinition =
  | (PackageAcl & { readonly package: "audit"; readonly phases: readonly LifecycleHookPhase[] })
  | (PackageAcl & { readonly package: "prompt-policy"; readonly maxPromptBytes?: number;
      readonly maxModelInputBytes?: number; readonly maxSystemPromptBytes?: number;
      readonly prependText?: string; readonly appendText?: string;
      readonly modelRef?: ModelRef; readonly limits?: Limits })
  | (PackageAcl & { readonly package: "tool-policy"; readonly denyTools: readonly string[];
      readonly rewrites: readonly { readonly tool: string; readonly args: unknown }[] })
  | (PackageAcl & { readonly package: "memory-injection"; readonly prefix: string; readonly append: string });
export interface ConfiguredLifecycleHookServiceOptions {
  readonly enabled?: boolean;
  readonly packages: readonly LifecyclePackageDefinition[];
  /** Whole operation; timeout aborts admission but never claims unfinished authorization has drained. */
  readonly timeoutMs?: number;
  readonly maxConcurrentPerUser?: number;
  readonly tenantRuntime?: TenantRuntimeCoordinator;
  readonly authorizeSubject?: (principal: Principal) => Promise<void>;
  /** Private nonce-bound observation of every configured runner, not a cached healthy subset. */
  readonly authorizeFleet?: (signal: AbortSignal) => Promise<void>;
}
