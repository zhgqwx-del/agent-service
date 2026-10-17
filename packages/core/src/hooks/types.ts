import type { Principal, ToolKind } from "@agent-service/protocol";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";

export type ToolHookPhase = "preToolUse" | "postToolUse";
export type ToolHookKind = "deny-tools" | "observe-tool-result" | "webhook";
export type ToolHookOutcome = "allowed" | "denied" | "tool_success" | "tool_error"
  | "acknowledged" | "failed" | "cancelled" | "timed_out" | "skipped";

/** Content-free reports only. These are observations, not execution/deletion authority. */
export interface ToolHookReport {
  readonly hookId: string;
  readonly phase: ToolHookPhase;
  readonly kind: ToolHookKind;
  readonly outcome: ToolHookOutcome;
  readonly configSha256: string;
}
export interface ToolHookContext {
  readonly owner: Principal;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly tool: { readonly name: string; readonly kind: ToolKind; readonly readOnly: boolean };
}
export interface ToolHookPostContext extends ToolHookContext { readonly isError: boolean }
export interface ToolHookPreResult {
  readonly allow: boolean;
  readonly reports: readonly ToolHookReport[];
}
export interface ToolHookService {
  /** Immutable configuration state; closing never silently disables an applicable policy. */
  readonly enabled: boolean;
  /** Undefined for disabled/unmatched owners, preserving the previous no-hooks context epoch. */
  version(owner: Principal): string | undefined;
  preToolUse(context: ToolHookContext, signal: AbortSignal): Promise<ToolHookPreResult>;
  postToolUse(context: ToolHookPostContext, signal: AbortSignal): Promise<readonly ToolHookReport[]>;
  close(): Promise<void>;
}

interface ToolHookAcl {
  readonly id: string;
  readonly subjects: readonly Principal[];
}
export type ToolHookDefinition =
  | (ToolHookAcl & { readonly phase: "preToolUse"; readonly kind: "deny-tools"; readonly tools: readonly string[] })
  | (ToolHookAcl & { readonly phase: "postToolUse"; readonly kind: "observe-tool-result" })
  | (ToolHookAcl & { readonly phase: ToolHookPhase; readonly kind: "webhook"; readonly endpoint: string;
      /** Independent operator-owned raw 32-byte key. The service copies it, never emits it. */
      readonly signingKey: Uint8Array });
export interface ConfiguredToolHookServiceOptions {
  readonly enabled?: boolean;
  readonly hooks: readonly ToolHookDefinition[];
  /** Whole phase, including authorization, all hooks and HTTP cleanup. Default 1500, maximum 5000. */
  readonly timeoutMs?: number;
  readonly maxConcurrentPerUser?: number;
  readonly tenantRuntime?: TenantRuntimeCoordinator;
  readonly authorizeSubject?: (principal: Principal) => Promise<void>;
  /** Explicit non-production fixtures only; the existing HTTP double gate remains mandatory. */
  readonly allowLoopbackForTests?: boolean;
}

/** Versioned anonymous webhook wire. No arguments, result/body, raw identities or URLs. */
export interface ToolHookWebhookRequest {
  readonly schema: "agent-service-tool-hook-request-v1";
  readonly hookId: string;
  readonly phase: ToolHookPhase;
  readonly invocationId: string;
  readonly configSha256: string;
  readonly refs: { readonly tenant: string; readonly user: string; readonly session: string;
    readonly turn: string; readonly toolCall: string };
  readonly tool: ToolHookContext["tool"];
  readonly isError: boolean | null;
  readonly requestSha256: string;
  readonly macSha256: string;
}
export interface ToolHookWebhookResponse {
  readonly schema: "agent-service-tool-hook-response-v1";
  readonly hookId: string;
  readonly phase: ToolHookPhase;
  readonly invocationId: string;
  readonly configSha256: string;
  readonly requestSha256: string;
  readonly decision: "allow" | "deny" | "ack";
  readonly macSha256: string;
}
