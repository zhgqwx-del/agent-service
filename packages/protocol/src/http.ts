import { z } from "zod";
import {
  AgentDefinition,
  AgentDefinitionInput,
  ApprovalPolicy,
  BusyPolicy,
  ModelRef,
} from "./agent.js";
import { Approval, ApprovalResponseRequest } from "./approval.js";
import {
  ApiKeyScope,
  CreateApiKeyRequest,
  TenantAuthPolicy,
  TenantAuthPolicyInput,
} from "./auth.js";
import { Capabilities } from "./capabilities.js";
import { SkillMountSelectors } from "./skill.js";
import { McpRegistrationRefs } from "./mcp.js";
import {
  Limits,
  Pagination,
  Usage,
  UsageQuery,
  UsageRollup,
  UserId,
  externalId,
  idSchema,
} from "./common.js";
import { Event, EXCLUDABLE_EVENT_TYPES } from "./event.js";
import {
  AgentMessageItem,
  ApprovalRequestItem,
  ContextCompactionItem,
  ImageInputPart,
  ImageMediaType,
  InputPart,
  ItemStatus,
  ReasoningItem,
  SkillInputPart,
  SystemNoticeItem,
  SubagentActivityItem,
  ToolCallItem,
  ToolContentPart,
  ToolKind,
  ToolOutputPayload,
  ToolResultItem,
  TextInputPart,
  UserMessageItem,
} from "./item.js";
import {
  ModelPrice,
  ModelInputCapabilities,
  ModelSpec,
  ProviderCompat,
  ProviderConfig,
  ProviderConfigInput,
} from "./provider.js";
import {
  CreateSessionRequest,
  DynamicToolResultRequest,
  ResumeSessionResponse,
  Session,
  StartTurnRequest,
  SteerRequest,
  Turn,
  TurnStatus,
} from "./session.js";

/**
 * HTTP-only schemas live here so the domain resources remain usable without knowing about routing.
 * These schemas describe the API that is implemented today; planned M3/M4 resources do not belong
 * here until a handler exists.
 */

/** @internal Lets generation-time tooling extend the exact Zod instance used by these schemas. */
export const configureProtocolZod = (extension: (zod: typeof z) => void): void => extension(z);

// ---------- common wire shapes ----------

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

export const OpenApiDocumentResponse = z.object({
  openapi: z.string(),
  info: z.object({ title: z.string(), version: z.string() }).passthrough(),
  paths: z.record(z.unknown()),
}).passthrough();
export type OpenApiDocumentResponse = z.infer<typeof OpenApiDocumentResponse>;

export const HealthResponse = z.string();
export const ReadinessResponse = z.string();
export const EventStreamBody = z.string().describe(
  "Server-Sent Events; each data field is a serialized Event component.",
);

// zod-to-openapi 7 deliberately rejects ZodUndefined. The protocol uses `seq?: undefined` to make
// live-only events disjoint in TypeScript; on the JSON wire that property is simply absent.
type DomainEventOption = typeof Event.options[number];
function eventOption<T extends Event["type"]>(type: T): Extract<DomainEventOption, { shape: { type: z.ZodLiteral<T> } }> {
  const option = Event.options.find(candidate => candidate.shape.type.value === type);
  if (!option) throw new Error("Missing event stream schema");
  // The discriminator, not its mutable numeric position, selects this exact schema branch.
  return option as Extract<DomainEventOption, { shape: { type: z.ZodLiteral<T> } }>;
}
export const EventStreamEvent = z.discriminatedUnion("type", [
  eventOption("lifecycle-hook/started"),
  eventOption("lifecycle-hook/completed"),
  eventOption("lifecycle-middleware/completed"),
  eventOption("session/created"),
  eventOption("session/status/changed"),
  eventOption("session/compacted"),
  eventOption("session/archived"),
  eventOption("session/unarchived"),
  eventOption("session/deleted"),
  eventOption("turn/started"),
  eventOption("turn/steered"),
  eventOption("turn/completed"),
  eventOption("item/started"),
  eventOption("item/completed"),
  eventOption("item/toolCall/parametersChanged"),
  eventOption("approval/requested"),
  eventOption("approval/resolved"),
  eventOption("hook/completed"),
  eventOption("tenant-hook/completed"),
  eventOption("usage/updated"),
  eventOption("warning"),
  eventOption("error"),
  eventOption("item/agentMessage/delta").omit({ seq: true }),
  eventOption("item/reasoning/delta").omit({ seq: true }),
  eventOption("item/toolCall/argsDelta").omit({ seq: true }),
  eventOption("item/mcpToolCall/progress").omit({ seq: true }),
  eventOption("heartbeat").omit({ seq: true }),
]);
export type EventStreamEvent = z.infer<typeof EventStreamEvent>;

export const AgentIdParams = z.object({ id: idSchema("agt") });
export const SessionIdParams = z.object({ id: idSchema("sess") });
export const SessionBlobParams = z.object({ id: idSchema("sess"), blobId: idSchema("blob") });
export const SessionItemOutputParams = z.object({ id: idSchema("sess"), itemId: idSchema("item") });
export const SessionTurnParams = z.object({ id: idSchema("sess"), turnId: idSchema("turn") });
export const SessionApprovalParams = z.object({ id: idSchema("sess"), approvalId: idSchema("apr") });
export const ProviderIdParams = z.object({ id: externalId });
export const ApiKeyIdParams = z.object({ keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) });

export const UserIdentityHeaders = z.object({
  "x-user-id": UserId.optional().describe("User asserted by a trusted tenant backend."),
  "x-end-user-token": z.string().min(1).optional().describe(
    "Default end-user token header. A tenant may configure a different header name in its auth policy.",
  ),
});

export const StartTurnHeaders = UserIdentityHeaders.extend({
  "idempotency-key": z.string().trim().min(1).max(256).optional(),
});

const RequiredIdempotencyKey = z.string().trim().min(1).max(256);

export const ErasureRequestHeaders = UserIdentityHeaders.extend({
  "idempotency-key": RequiredIdempotencyKey,
});

export const DataExportRequestHeaders = UserIdentityHeaders.extend({
  "idempotency-key": RequiredIdempotencyKey,
});

/** Platform bearer authentication is described by the OpenAPI security scheme, not this object. */
export const TenantErasureRequestHeaders = z.object({
  "idempotency-key": RequiredIdempotencyKey,
});

export const EventStreamHeaders = UserIdentityHeaders.extend({
  "last-event-id": z.coerce.number().int().min(-1).optional(),
});

export const AgentVersionQuery = z.object({ version: z.coerce.number().int().positive().optional() });
/** Cursor pagination for collections whose public ordering is fixed. */
export const FixedOrderPaginationQuery = Pagination.omit({ sortDirection: true });
export const AgentListQuery = FixedOrderPaginationQuery;
const BooleanQueryParam = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());
export const SessionListQuery = FixedOrderPaginationQuery.extend({
  userId: UserId.optional(),
  // z.coerce.boolean() uses JavaScript truthiness, so the wire value "false" would become true.
  includeArchived: BooleanQueryParam.optional(),
});
export const ItemListQuery = z.object({
  turnId: idSchema("turn").optional(),
  afterSeq: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export const ExcludableEventTypeSchema = z.enum(EXCLUDABLE_EVENT_TYPES);
const escapedExcludableTypes = EXCLUDABLE_EVENT_TYPES.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const ExcludeQueryParam = z.string()
  .regex(new RegExp(`^\\s*(?:${escapedExcludableTypes.join("|")})(?:\\s*,\\s*(?:${escapedExcludableTypes.join("|")}))*\\s*$`))
  .describe(`Comma-separated event types. Allowed values: ${EXCLUDABLE_EVENT_TYPES.join(", ")}.`);
export const EventStreamQuery = z.object({
  after: z.coerce.number().int().min(-1).optional(),
  exclude: ExcludeQueryParam.optional(),
});
export const StartTurnQuery = z.object({
  exclude: ExcludeQueryParam.optional(),
});
export const ApprovalListQuery = z.object({ pending: z.enum(["true", "false"]).optional() });

// ---------- normalized resource responses ----------

/** Usage objects returned by the service always contain all normalized token counters. */
export const UsageResponse = Usage.extend({
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

export const AgentDefinitionResponse = AgentDefinition.extend({
  instructions: z.string().max(200_000),
  tools: z.array(externalId),
  // Keep historical response records compatible; current requests use the bounded mount grammar.
  mcpServers: z.array(externalId).describe("Operator-configured MCP server ids; checked for the actual session owner."),
  skills: z.array(externalId).describe("Persisted exact operator ids or explicit registry:<name> selectors, checked for the actual session owner. Historical records remain readable while skills are disabled."),
  limits: Limits,
  approvalPolicy: ApprovalPolicy,
  busyPolicy: BusyPolicy,
  sandbox: z.literal("none"),
  metadata: z.record(z.unknown()),
});
export type AgentDefinitionResponse = z.infer<typeof AgentDefinitionResponse>;

export const AgentPageResponse = z.object({
  data: z.array(AgentDefinitionResponse),
  nextCursor: z.string().nullable(),
});
export type AgentPageResponse = z.infer<typeof AgentPageResponse>;

export const ModelPriceResponse = ModelPrice.extend({
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const ModelSpecResponse = ModelSpec.extend({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  input: ModelInputCapabilities,
  reasoning: z.boolean(),
  price: ModelPriceResponse.optional(),
});
export type ModelSpecResponse = z.infer<typeof ModelSpecResponse>;

export const ProviderConfigResponse = ProviderConfig.extend({
  api: z.literal("openai-completions"),
  headers: z.record(z.string()),
  models: z.array(ModelSpecResponse).min(1),
  // Read historical positive limits verbatim; new writes and runtime admission retain their 1m cap.
  quota: z.object({
    rpm: z.number().int().positive().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
  fallback: z.array(externalId),
});
export type ProviderConfigResponse = z.infer<typeof ProviderConfigResponse>;

/** The provider id is carried by the path and is deliberately absent from the JSON body. */
export const UpsertProviderRequest = ProviderConfigInput.omit({ id: true });
export type UpsertProviderRequest = z.infer<typeof UpsertProviderRequest>;

export const ProviderListResponse = z.object({ data: z.array(ProviderConfigResponse) });
export type ProviderListResponse = z.infer<typeof ProviderListResponse>;

export const ModelCatalogEntry = ModelSpecResponse.extend({ provider: externalId });
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntry>;
export const ModelListResponse = z.object({ data: z.array(ModelCatalogEntry) });
export type ModelListResponse = z.infer<typeof ModelListResponse>;

export const ToolDescriptor = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string(),
  /** JSON Schema (draft 2020-12 subset) accepted by the configured model provider. */
  parameters: z.record(z.unknown()),
  kind: ToolKind,
  needsApproval: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  concurrencySafe: z.boolean().optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;
export const ToolListResponse = z.object({ data: z.array(ToolDescriptor) });
export type ToolListResponse = z.infer<typeof ToolListResponse>;

export const ApiKeyRecordResponse = z.object({
  keyId: z.string(),
  tenantId: externalId,
  scopes: z.array(ApiKeyScope),
  createdAtMs: z.number().int(),
  revokedAtMs: z.number().int().optional(),
});
export type ApiKeyRecordResponse = z.infer<typeof ApiKeyRecordResponse>;
export const ApiKeyListResponse = z.object({ data: z.array(ApiKeyRecordResponse) });
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponse>;
export const CreateApiKeyResponse = z.object({
  keyId: z.string(),
  scopes: z.array(ApiKeyScope),
  /** Returned exactly once; only a hash is retained by the service. */
  key: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponse>;

export const TenantAuthStateResponse = z.object({
  tenantId: externalId,
  policy: TenantAuthPolicy,
  hasSecret: z.boolean(),
});
export type TenantAuthStateResponse = z.infer<typeof TenantAuthStateResponse>;

const SessionStatusResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({
    type: z.literal("active"),
    turnId: idSchema("turn"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const SessionResponse = Session.extend({
  status: SessionStatusResponse,
  usage: UsageResponse,
  autoApprovedTools: z.array(externalId),
  metadata: z.record(z.unknown()),
});
export type SessionResponse = z.infer<typeof SessionResponse>;
export const SessionPageResponse = z.object({
  data: z.array(SessionResponse),
  nextCursor: z.string().nullable(),
});
export type SessionPageResponse = z.infer<typeof SessionPageResponse>;

export const TurnResponse = Turn.extend({
  status: TurnStatus,
  steps: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  usage: UsageResponse,
});
export type TurnResponse = z.infer<typeof TurnResponse>;
export const TurnPageResponse = z.object({
  data: z.array(TurnResponse),
  nextCursor: z.string().nullable(),
});
export type TurnPageResponse = z.infer<typeof TurnPageResponse>;
export const TurnReplayResponse = z.object({ turn: TurnResponse });
export type TurnReplayResponse = z.infer<typeof TurnReplayResponse>;
export const TurnAcceptedResponse = z.object({ turn: TurnResponse, steered: z.boolean() });
export type TurnAcceptedResponse = z.infer<typeof TurnAcceptedResponse>;

export const CompactSessionResponse = z.object({
  compacted: z.boolean(),
  summaryItemId: idSchema("item").optional(),
});
export type CompactSessionResponse = z.infer<typeof CompactSessionResponse>;

export const ResumeSessionHttpResponse = ResumeSessionResponse.extend({
  session: SessionResponse,
  recentTurns: z.array(TurnResponse),
});
export type ResumeSessionHttpResponse = z.infer<typeof ResumeSessionHttpResponse>;

const CurrentSkillInputPart = SkillInputPart.extend({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  args: z.string().max(8192).refine((value) => new TextEncoder().encode(value).byteLength <= 8192,
    "Skill arguments exceed the UTF-8 byte limit").optional()
    .describe("Literal user text, never a template, command, or additional tool authorization."),
}).strict();
// Keep historical resource reads on the domain leaf; only new HTTP writes use the current bounds.
const CurrentTurnInputPart = z.discriminatedUnion("type", [TextInputPart, ImageInputPart, SkillInputPart]);
const CurrentTurnRequestInputPart = z.discriminatedUnion("type", [TextInputPart, ImageInputPart, CurrentSkillInputPart]);
const UserMessageItemResponse = UserMessageItem.extend({ content: z.array(CurrentTurnInputPart),
  effectiveContent: z.array(CurrentTurnInputPart).optional() });
const AgentMessageItemResponse = AgentMessageItem.extend({ phase: z.enum(["commentary", "finalAnswer"]) });
const ToolResultItemResponse = ToolResultItem.extend({ isError: z.boolean() });
const ContextCompactionItemResponse = ContextCompactionItem.extend({ usageSnapshot: UsageResponse.optional() });
export const ItemResponse = z.discriminatedUnion("type", [
  UserMessageItemResponse,
  AgentMessageItemResponse,
  ReasoningItem,
  ToolCallItem,
  ToolResultItemResponse,
  ApprovalRequestItem,
  ContextCompactionItemResponse,
  SystemNoticeItem,
  SubagentActivityItem,
]);
export type ItemResponse = z.infer<typeof ItemResponse>;
export const ItemListResponse = z.object({ data: z.array(ItemResponse) });
export type ItemListResponse = z.infer<typeof ItemListResponse>;

export const BlobUploadResponse = z.object({
  blobId: idSchema("blob"),
  purpose: z.literal("input_image"),
  state: z.literal("staging"),
  sizeBytes: z.number().int().nonnegative(),
  contentType: ImageMediaType,
  expiresAtMs: z.number().int(),
});
export type BlobUploadResponse = z.infer<typeof BlobUploadResponse>;

export const ItemOutputResponse = ToolOutputPayload;
export type ItemOutputResponse = z.infer<typeof ItemOutputResponse>;

export const ApprovalListResponse = z.object({ data: z.array(Approval) });
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

export const UsageRollupResponse = UsageRollup.extend({ usage: UsageResponse });
export const UsageListResponse = z.object({ data: z.array(UsageRollupResponse) });
export type UsageListResponse = z.infer<typeof UsageListResponse>;

// ---------- request aliases (kept here to make the complete HTTP surface discoverable) ----------

export const AgentDefinitionRequest = AgentDefinitionInput.extend({
  mcpServers: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(8)
    .refine((ids) => new Set(ids).size === ids.length, "MCP server ids must be distinct")
    .default([]).describe("Requires configured MCP support. Only exact operator-authorized mounts are executable; no registration or credentials are accepted here."),
  mcpRegistrations: McpRegistrationRefs.default([]).describe("Explicit managed MCP registration references. Requires managed-mcp-registry-v1 and actual session-owner authorization; never accepts credentials or URLs."),
  skills: SkillMountSelectors.default([]).describe("Exact operator mount ids or registry:<name>; registry selection requires managed-skill-registry-v1. No filesystem path or additional tool authorization is accepted."),
}).refine(value => value.mcpServers.length + value.mcpRegistrations.length <= 8,
  "At most eight MCP mounts are allowed");
export const ApiKeyCreateRequest = CreateApiKeyRequest;
export const TenantAuthUpdateRequest = TenantAuthPolicyInput;
export const SessionCreateRequest = CreateSessionRequest;
const CurrentTurnInput = z.array(CurrentTurnRequestInputPart).min(1).max(32);
export const TurnStartRequest = StartTurnRequest.extend({ input: CurrentTurnInput });
export const TurnSteerRequest = SteerRequest.extend({ input: CurrentTurnInput });
export const DynamicToolResultSubmitRequest = DynamicToolResultRequest;
export const ApprovalResolveRequest = ApprovalResponseRequest;
export const UsageListQuery = UsageQuery;

// Re-exporting these leaf schemas here makes generated-client consumers able to discover the HTTP
// catalog without importing implementation packages. They remain the exact protocol definitions.
export const HttpCapabilitiesResponse = Capabilities;
export const HttpInputPart = InputPart;
export const HttpToolContentPart = ToolContentPart;
export const HttpItemStatus = ItemStatus;
export const HttpModelRef = ModelRef;
export const HttpProviderCompat = ProviderCompat;
