import { z } from "zod";
import { externalId, idSchema, Usage } from "./common.js";
import { SubagentActivityFields } from "./subagents.js";

export const TextInputPart = z.object({ type: z.literal("text"), text: z.string().min(1).max(100_000) });
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const ImageMediaType = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof ImageMediaType>;
export const ImageInputPart = z.object({
  type: z.literal("image"),
  /** Opaque, owner-scoped id returned by the session blob upload endpoint. */
  blobId: idSchema("blob"),
  mimeType: ImageMediaType.optional(),
});
export const SkillInputPart = z.object({
  type: z.literal("skill"),
  name: externalId,
  args: z.string().optional(),
});
export const MentionInputPart = z.object({ type: z.literal("mention"), name: externalId });

/** A server-resolved static skill version. This is item metadata, never caller-writable input.
 * The exact body survives history/compaction without re-reading a changed filesystem package. */
export const ResolvedSkillContext = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  versionSha256: z.string().regex(/^[0-9a-f]{64}$/),
  body: z.string().max(32_768).refine((value) => new TextEncoder().encode(value).byteLength <= 32_768,
    "Resolved skill body exceeds the UTF-8 byte limit"),
}).strict();
export type ResolvedSkillContext = z.infer<typeof ResolvedSkillContext>;
/** Compaction may retain distinct historical versions of the same mount; none overwrites another. */
export const ResolvedSkillContexts = z.array(ResolvedSkillContext).max(8).refine(
  (contexts) => new Set(contexts.map(({ id, versionSha256 }) => JSON.stringify([id, versionSha256]))).size === contexts.length,
  "Resolved skill versions must be distinct",
);
export type ResolvedSkillContexts = z.infer<typeof ResolvedSkillContexts>;

/** Full protocol vocabulary. HTTP adds only configured static skills, never mention inputs. */
export const InputPart = z.discriminatedUnion("type", [
  TextInputPart,
  ImageInputPart,
  /** explicit `/skill` invocation; the skill body is injected regardless of `disable-model-invocation` */
  SkillInputPart,
  MentionInputPart,
]);
export type InputPart = z.infer<typeof InputPart>;

/** Content returned by tools to the model. */
export const ToolContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), url: z.string(), mimeType: z.string().optional() }),
]);
export type ToolContentPart = z.infer<typeof ToolContentPart>;

/** Full offloaded tool result fetched through the owner-scoped item output endpoint. */
export const ToolOutputPayload = z.object({
  content: z.array(ToolContentPart),
  details: z.unknown().optional(),
});
export type ToolOutputPayload = z.infer<typeof ToolOutputPayload>;

export const ItemStatus = z.enum(["inProgress", "completed", "failed", "declined"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const ToolKind = z.enum(["builtin", "mcp", "dynamic", "skill"]);
export type ToolKind = z.infer<typeof ToolKind>;

const base = {
  id: idSchema("item"),
  sessionId: idSchema("sess"),
  turnId: idSchema("turn"),
  /** per-session monotonic sequence assigned when the item is first persisted */
  seq: z.number().int().nonnegative(),
  /** 1-based model-call index within the turn; groups agentMessage/reasoning/toolCall items of one step */
  step: z.number().int().nonnegative().optional(),
  status: ItemStatus,
  createdAtMs: z.number().int(),
  completedAtMs: z.number().int().optional(),
};

export const UserMessageItem = z.object({
  ...base,
  type: z.literal("userMessage"),
  content: z.array(InputPart),
  /** Server-only accepted middleware output; original content remains the v1 disclosure source. */
  effectiveContent: z.array(InputPart).optional(),
  /** Server-only resolved snapshots, committed atomically with this message. */
  skillContexts: ResolvedSkillContexts.optional(),
});
export const AgentMessageItem = z.object({
  ...base,
  type: z.literal("agentMessage"),
  text: z.string(),
  phase: z.enum(["commentary", "finalAnswer"]).default("finalAnswer"),
});
export const ReasoningItem = z.object({ ...base, type: z.literal("reasoning"), text: z.string() });
export const ToolCallItem = z.object({
  ...base,
  type: z.literal("toolCall"),
  toolCallId: z.string(),
  name: z.string(),
  kind: ToolKind,
  /** Server-only model arguments before an approved middleware rewrite. */
  originalArgs: z.unknown().optional(),
  /** Immutable middleware identity that produced the effective args below. */
  parametersPolicySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  args: z.unknown(),
  /** write-ahead marker: set before execution starts (crash recovery relies on it) */
  startedAtMs: z.number().int().optional(),
});
export const ToolResultItem = z.object({
  ...base,
  type: z.literal("toolResult"),
  toolCallId: z.string(),
  name: z.string(),
  content: z.array(ToolContentPart),
  isError: z.boolean().default(false),
  /** Opaque owner-scoped id for a large output stored outside the item row. */
  outputRef: idSchema("blob").optional(),
  details: z.unknown().optional(),
});
export const ApprovalRequestItem = z.object({
  ...base,
  type: z.literal("approvalRequest"),
  approvalId: idSchema("apr"),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  reason: z.string().optional(),
});
export const ContextCompactionItem = z.object({
  ...base,
  type: z.literal("contextCompaction"),
  /** items with seq <= this are replaced by `summary` in the model context */
  replacesUpToSeq: z.number().int(),
  summary: z.string(),
  usageSnapshot: Usage.optional(),
  /** Server-only exact historical bodies; LLM summary text never creates this authority. */
  skillContexts: ResolvedSkillContexts.optional(),
});
export const SystemNoticeItem = z.object({
  ...base,
  type: z.literal("systemNotice"),
  /** e.g. tool catalog changed, steer injected, recovery instructions */
  kind: z.enum(["toolsChanged", "steer", "recovery", "limitReached"]),
  text: z.string(),
});
/** Parent-owned durable activity; child sequence numbers never enter this item. */
export const SubagentActivityItem = z.object({ ...base, ...SubagentActivityFields.shape });

export const Item = z.discriminatedUnion("type", [
  UserMessageItem,
  AgentMessageItem,
  ReasoningItem,
  ToolCallItem,
  ToolResultItem,
  ApprovalRequestItem,
  ContextCompactionItem,
  SystemNoticeItem,
  SubagentActivityItem,
]);
export type Item = z.infer<typeof Item>;
export type ItemType = Item["type"];
export type ItemOf<T extends ItemType> = Extract<Item, { type: T }>;
