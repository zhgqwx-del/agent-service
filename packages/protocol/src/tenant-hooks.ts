import { z } from "zod";

export const TENANT_HOOK_DISCLOSURE_ACK = "tenant-admin-body-disclosure-v1" as const;
export const TenantHookName = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const TenantHookPhase = z.enum(["preToolUse", "postToolUse"]);
export const TenantHookBodyScope = z.enum(["prompt", "tool_arguments", "tool_result"]);
const natural = z.number().int().safe().nonnegative();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const noControls = (value: string) => !/[\x00-\x1f\x7f]/.test(value);

/** URL shape only: the actual sender additionally checks DNS, TLS, pinning and fixture gates. */
export const TenantHookEndpoint = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return noControls(value) && !value.includes("?") && !value.includes("#")
      && !url.username && !url.password && url.href === value
      && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}, "Invalid webhook endpoint");
export const TenantHookConfig = z.object({
  endpoint: TenantHookEndpoint,
  phase: TenantHookPhase,
  bodyScopes: z.array(TenantHookBodyScope).max(3).default([])
    .refine(value => new Set(value).size === value.length, "Duplicate disclosure scope"),
}).strict().refine(value => value.phase !== "preToolUse" || !value.bodyScopes.includes("tool_result"),
  "Pre-tool observation has no tool result");
export type TenantHookConfig = z.infer<typeof TenantHookConfig>;

export const TenantHookHeaders = z.object({
  "idempotency-key": z.string().min(1).max(128).refine(value => noControls(value) && new TextEncoder().encode(value).byteLength <= 128),
}).strict();
export const TenantHookNameParams = z.object({ name: TenantHookName }).strict();
export const TenantHookEmptyQuery = z.object({}).strict();
export const TenantHookListQuery = z.object({
  cursor: sha256.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const TenantHookUpsertRequest = z.object({
  name: TenantHookName, expectedRevision: natural, config: TenantHookConfig,
  /** Write-only exact 32-byte signing key. Never returned by registration or delivery APIs. */
  signingKey: z.string().regex(/^[a-f0-9]{64}$/),
  disclosureAck: z.literal(TENANT_HOOK_DISCLOSURE_ACK).optional(),
}).strict().refine(value => value.config.bodyScopes.length > 0
  ? value.disclosureAck === TENANT_HOOK_DISCLOSURE_ACK : value.disclosureAck === undefined,
"Explicit administrator disclosure acknowledgement required only for body scopes");
export type TenantHookUpsertRequest = z.infer<typeof TenantHookUpsertRequest>;
export const TenantHookStateRequest = z.object({
  expectedRevision: natural, state: z.enum(["enabled", "disabled"]),
}).strict();
export const TenantHookDeleteRequest = z.object({ expectedRevision: natural }).strict();
export const InstalledTenantHookResponse = z.object({
  name: TenantHookName, revision: natural, generation: natural,
  state: z.enum(["enabled", "disabled", "deleted"]), currentVersionId: sha256.nullable(),
  createdAtMs: natural, updatedAtMs: natural,
}).strict();
export const TenantHookVersionResponse = z.object({
  configVersionId: sha256, revision: natural, generation: natural,
  config: TenantHookConfig, createdAtMs: natural,
}).strict();
export const TenantHookResponse = z.object({
  registration: InstalledTenantHookResponse, version: TenantHookVersionResponse.nullable(),
}).strict();
export const TenantHookListResponse = z.object({
  data: z.array(TenantHookResponse).max(100), nextCursor: sha256.nullable(),
}).strict();
/** Content-free status only: no owner, invocation payload, plaintext, key or ciphertext fields. */
export const TenantHookDeliveryResponse = z.object({
  intentId: sha256, configVersionId: sha256, phase: TenantHookPhase,
  state: z.enum(["prepared", "sending", "acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"]),
  createdAtMs: natural, completedAtMs: natural.nullable(),
}).strict();
export const TenantHookDeliveriesResponse = z.object({
  data: z.array(TenantHookDeliveryResponse).max(100), nextCursor: sha256.nullable(),
}).strict();
export type InstalledTenantHookResponse = z.infer<typeof InstalledTenantHookResponse>;
export type TenantHookVersionResponse = z.infer<typeof TenantHookVersionResponse>;
export type TenantHookResponse = z.infer<typeof TenantHookResponse>;
export type TenantHookListResponse = z.infer<typeof TenantHookListResponse>;
export type TenantHookDeliveryResponse = z.infer<typeof TenantHookDeliveryResponse>;
export type TenantHookDeliveriesResponse = z.infer<typeof TenantHookDeliveriesResponse>;
