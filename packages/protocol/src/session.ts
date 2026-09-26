import { z } from "zod";
import { externalId, idSchema, Limits, StopReason, Usage } from "./common.js";
import { BusyPolicy, ModelRef } from "./agent.js";
import { InputPart } from "./item.js";

export const SessionStatus = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({
    type: z.literal("active"),
    turnId: idSchema("turn"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])).default([]),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: idSchema("sess"),
  tenantId: externalId,
  userId: externalId,
  agentId: idSchema("agt"),
  agentVersion: z.number().int().positive(),
  status: SessionStatus,
  title: z.string().max(256).optional(),
  parentSessionId: idSchema("sess").optional(),
  /** highest persisted event seq */
  lastSeq: z.number().int().nonnegative(),
  /** hash(agentVersion, toolSet, mcpCatalog, skillCatalog); bumped when the immutable prefix changes */
  contextEpoch: z.string(),
  /** fencing token of the last successful writer (informational for clients) */
  fenceToken: z.number().int().nonnegative(),
  usage: Usage,
  /**
   * Tools the user granted for the rest of this session (`acceptForSession`). Server-owned: it is
   * never taken from client input, because that would let a caller pre-approve its own tool calls.
   */
  autoApprovedTools: z.array(externalId).default([]),
  /**
   * seq of the newest `contextCompaction` item. History is projected from this point on, so it must be
   * server-owned: reading it from client-writable metadata would let a caller drop its own history.
   */
  lastCompactionSeq: z.number().int().nonnegative().optional(),
  createdAtMs: z.number().int(),
  updatedAtMs: z.number().int(),
  archivedAtMs: z.number().int().optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type Session = z.infer<typeof Session>;

export const TurnStatus = z.enum(["inProgress", "completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const Turn = z.object({
  id: idSchema("turn"),
  sessionId: idSchema("sess"),
  status: TurnStatus,
  stopReason: StopReason.optional(),
  /** model actually used (after fallback), for billing attribution */
  model: ModelRef.optional(),
  seqStart: z.number().int().nonnegative(),
  seqEnd: z.number().int().nonnegative().optional(),
  steps: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  usage: Usage,
  /** text produced so far when the turn ended early (limits/interrupt) */
  partialText: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  startedAtMs: z.number().int(),
  completedAtMs: z.number().int().optional(),
  idempotencyKey: z.string().optional(),
});
export type Turn = z.infer<typeof Turn>;

// ---------- requests ----------

export const CreateSessionRequest = z.object({
  agentId: idSchema("agt"),
  /** defaults to the latest version at creation time */
  agentVersion: z.number().int().positive().optional(),
  userId: externalId.optional(),
  title: z.string().max(256).optional(),
  parentSessionId: idSchema("sess").optional(),
  metadata: z.record(z.unknown()).default({}),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** Client-declared tool executed by the client (reverse delegation, codex `item/tool/call`). */
export const DynamicToolDeclaration = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().max(4000),
  parameters: z.record(z.unknown()),
});
export type DynamicToolDeclaration = z.infer<typeof DynamicToolDeclaration>;

export const StartTurnRequest = z.object({
  input: z.array(InputPart).min(1).max(32),
  model: ModelRef.partial().optional(),
  limits: Limits.optional(),
  busyPolicy: BusyPolicy.optional(),
  dynamicTools: z.array(DynamicToolDeclaration).max(64).optional(),
  /** true (default): respond with SSE; false: 202 + turn object, consume via GET .../events */
  stream: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
});
export type StartTurnRequest = z.infer<typeof StartTurnRequest>;

export const SteerRequest = z.object({
  input: z.array(InputPart).min(1).max(32),
  /** precondition: reject if the active turn is not this one */
  expectedTurnId: idSchema("turn").optional(),
});
export type SteerRequest = z.infer<typeof SteerRequest>;

export const DynamicToolResultRequest = z.object({
  toolCallId: z.string(),
  content: z.array(z.discriminatedUnion("type", [z.object({ type: z.literal("text"), text: z.string() })])),
  isError: z.boolean().default(false),
});
export type DynamicToolResultRequest = z.infer<typeof DynamicToolResultRequest>;

export const ResumeSessionResponse = z.object({
  session: Session,
  recentTurns: z.array(Turn),
  pendingApprovalIds: z.array(idSchema("apr")),
  /** pass to GET /events?after= to continue the stream without gaps */
  lastSeq: z.number().int().nonnegative(),
});
export type ResumeSessionResponse = z.infer<typeof ResumeSessionResponse>;
