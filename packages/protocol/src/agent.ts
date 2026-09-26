import { z } from "zod";
import { externalId, idSchema, Limits } from "./common.js";

/** `untrusted`: every non-read tool needs approval. `on-request`: only tools flagged `needsApproval`. `never`: auto-allow. */
export const ApprovalPolicy = z.enum(["untrusted", "on-request", "never"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

/**
 * What happens when a turn is requested while another is in progress on the same session.
 * `steer` folds the input into the running turn; `reject` returns 409 session_busy.
 * (A `queue` policy is planned for M3 — it is deliberately absent so clients cannot depend on it.)
 */
export const BusyPolicy = z.enum(["steer", "reject"]);
export type BusyPolicy = z.infer<typeof BusyPolicy>;

export const ModelRef = z.object({
  /** provider config id (tenant BYOK or platform preset), e.g. `dashscope`, `prov_...` */
  provider: externalId,
  model: externalId,
  reasoning: z.enum(["off", "low", "medium", "high"]).optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;

/** Immutable agent definition snapshot. A session pins `agentId@version`; PUT creates a new version. */
export const AgentDefinition = z.object({
  id: idSchema("agt"),
  tenantId: externalId,
  version: z.number().int().positive(),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(200_000).default(""),
  model: ModelRef,
  /** builtin tool names enabled for this agent (see GET /v1/tools) */
  tools: z.array(externalId).default([]),
  /** mcp server ids mounted for this agent */
  mcpServers: z.array(externalId).default([]),
  /** skill names available to this agent */
  skills: z.array(externalId).default([]),
  limits: Limits.default({}),
  approvalPolicy: ApprovalPolicy.default("on-request"),
  busyPolicy: BusyPolicy.default("steer"),
  /** reserved for the heavy pool; phase 1 only accepts "none" */
  sandbox: z.enum(["none"]).default("none"),
  metadata: z.record(z.unknown()).default({}),
  createdAtMs: z.number().int(),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const AgentDefinitionInput = AgentDefinition.omit({ id: true, tenantId: true, version: true, createdAtMs: true });
export type AgentDefinitionInput = z.infer<typeof AgentDefinitionInput>;
