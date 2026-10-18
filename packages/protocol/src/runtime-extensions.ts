import { z } from "zod";

/** Separate from legacy tool hooks: neither an old hooks=true nor a healthy subset is authority. */
export const RUNTIME_EXTENSIONS_V1 = "lifecycle-root-lease-runtime-v1" as const;
export const INTERNAL_RUNTIME_EXTENSIONS_READY_PATH = "/_internal/lifecycle-root-lease-runtime-v1/ready" as const;
export const INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER = "x-agent-service-runtime-extensions" as const;
export const INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE = "lifecycle-root-lease-ready-v1" as const;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeExtensionsIdentity = z.object({
  /** Ordered fixed packages, ACL and whole-operation budgets; never a secret or authorization. */
  lifecycleHooksSha256: Digest.nullable(),
  /** Operator depth/concurrency/task ceilings. Per-agent policy is independently pinned in storage. */
  subagentsSha256: Digest.nullable(),
}).strict();
export type RuntimeExtensionsIdentity = z.infer<typeof RuntimeExtensionsIdentity>;
export const RuntimeExtensionsFleetRequest = z.object({
  nonce: Digest,
  identity: RuntimeExtensionsIdentity,
}).strict();
export const RuntimeExtensionsFleetResponse = RuntimeExtensionsFleetRequest;
export function runtimeExtensionsIdentitiesEqual(a: RuntimeExtensionsIdentity, b: RuntimeExtensionsIdentity): boolean {
  return a.lifecycleHooksSha256 === b.lifecycleHooksSha256 && a.subagentsSha256 === b.subagentsSha256;
}
export interface RuntimeExtensionsActivation {
  readonly lifecycleHooks: boolean;
  readonly subagents: boolean;
}
export function runtimeExtensionsActivationMatches(identity: RuntimeExtensionsIdentity, flags: RuntimeExtensionsActivation): boolean {
  return (flags.lifecycleHooks || flags.subagents)
    && (identity.lifecycleHooksSha256 !== null) === flags.lifecycleHooks
    && (identity.subagentsSha256 !== null) === flags.subagents;
}
