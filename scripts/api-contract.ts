import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
  type ResponseConfig,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import {
  AgentDefinitionRequest,
  AgentDefinitionResponse,
  AgentIdParams,
  AgentListQuery,
  AgentPageResponse,
  AgentVersionQuery,
  ApiKeyCreateRequest,
  ApiKeyIdParams,
  ApiKeyListResponse,
  Approval,
  ApprovalListQuery,
  ApprovalListResponse,
  ApprovalResolveRequest,
  Capabilities,
  CompactSessionResponse,
  configureProtocolZod,
  CreateApiKeyResponse,
  DynamicToolResultSubmitRequest,
  ErrorBody,
  ExcludableEventTypeSchema,
  EventStreamBody,
  EventStreamEvent,
  EventStreamHeaders,
  EventStreamQuery,
  HealthResponse,
  ItemListQuery,
  ItemListResponse,
  ModelListResponse,
  OkResponse,
  OpenApiDocumentResponse,
  Pagination,
  ProviderConfigResponse,
  ProviderIdParams,
  ProviderListResponse,
  ReadinessResponse,
  ResumeSessionHttpResponse,
  SessionApprovalParams,
  SessionCreateRequest,
  SessionIdParams,
  SessionListQuery,
  SessionPageResponse,
  SessionResponse,
  SessionTurnParams,
  StartTurnHeaders,
  StartTurnQuery,
  TenantAuthStateResponse,
  TenantAuthUpdateRequest,
  ToolListResponse,
  TurnAcceptedResponse,
  TurnPageResponse,
  TurnReplayResponse,
  TurnResponse,
  TurnStartRequest,
  TurnSteerRequest,
  UpsertProviderRequest,
  UsageListQuery,
  UsageListResponse,
  UserIdentityHeaders,
  PROTOCOL_VERSION,
} from "../packages/protocol/src/index.js";

// Extend the exact Zod instance that owns the protocol schemas. The generator is a root-only dev
// dependency while Zod intentionally remains a protocol dependency under pnpm's strict layout.
configureProtocolZod(extendZodWithOpenApi);

type ContractSchema = Parameters<OpenAPIRegistry["register"]>[1];

const JSON_MEDIA_TYPE = "application/json";
const SSE_MEDIA_TYPE = "text/event-stream";

const jsonResponse = (schema: ContractSchema, description: string): ResponseConfig => ({
  description,
  content: { [JSON_MEDIA_TYPE]: { schema } },
});

const textResponse = (schema: ContractSchema, description: string): ResponseConfig => ({
  description,
  content: { "text/plain": { schema } },
});

const jsonBody = (schema: ContractSchema, description: string): NonNullable<RouteConfig["request"]>["body"] => ({
  description,
  required: true,
  content: { [JSON_MEDIA_TYPE]: { schema } },
});

const noContentResponse = (description: string): ResponseConfig => ({ description });

const serviceSecurity: NonNullable<RouteConfig["security"]> = [{ ServiceApiKey: [] }];
const userSecurity: NonNullable<RouteConfig["security"]> = [
  { ServiceApiKey: [], TrustedCallerUser: [] },
  { ServiceApiKey: [], EndUserToken: [] },
];
const adminOnly = { "x-required-api-key-scopes": ["admin"] } as const;

/**
 * Build the public contract from the same Zod schemas used by the service. This is deliberately a
 * generation-time module: neither runner nor router needs zod-to-openapi in its runtime dependency
 * graph. The committed outputs are produced by scripts/generate-api.ts.
 */
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const operationIds = new Set<string>();

  registry.registerComponent("securitySchemes", "ServiceApiKey", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "AgentServiceApiKey",
    description: "Tenant service API key. Runtime or admin scope is enforced per operation.",
  });
  registry.registerComponent("securitySchemes", "TrustedCallerUser", {
    type: "apiKey",
    in: "header",
    name: "X-User-Id",
    description: "User identity asserted by a trusted tenant backend.",
  });
  registry.registerComponent("securitySchemes", "EndUserToken", {
    type: "apiKey",
    in: "header",
    name: "X-End-User-Token",
    description: "Default end-user token header. A tenant auth policy may configure a different header name.",
  });

  const schemas = {
    error: registry.register("ErrorBody", ErrorBody),
    event: registry.register("Event", EventStreamEvent),
    excludableEventType: registry.register("ExcludableEventType", ExcludableEventTypeSchema),
    capabilities: registry.register("Capabilities", Capabilities),
    openapi: registry.register("OpenApiDocument", OpenApiDocumentResponse),
    agentRequest: registry.register("AgentDefinitionRequest", AgentDefinitionRequest),
    agent: registry.register("AgentDefinition", AgentDefinitionResponse),
    agentPage: registry.register("AgentPage", AgentPageResponse),
    providerRequest: registry.register("UpsertProviderRequest", UpsertProviderRequest),
    provider: registry.register("ProviderConfig", ProviderConfigResponse),
    providerList: registry.register("ProviderList", ProviderListResponse),
    modelList: registry.register("ModelList", ModelListResponse),
    toolList: registry.register("ToolList", ToolListResponse),
    apiKeyCreateRequest: registry.register("CreateApiKeyRequest", ApiKeyCreateRequest),
    apiKeyCreateResponse: registry.register("CreateApiKeyResponse", CreateApiKeyResponse),
    apiKeyList: registry.register("ApiKeyList", ApiKeyListResponse),
    authUpdateRequest: registry.register("TenantAuthUpdateRequest", TenantAuthUpdateRequest),
    authState: registry.register("TenantAuthState", TenantAuthStateResponse),
    sessionCreateRequest: registry.register("CreateSessionRequest", SessionCreateRequest),
    session: registry.register("Session", SessionResponse),
    sessionPage: registry.register("SessionPage", SessionPageResponse),
    compactSession: registry.register("CompactSessionResponse", CompactSessionResponse),
    resumeSession: registry.register("ResumeSessionResponse", ResumeSessionHttpResponse),
    turnStartRequest: registry.register("StartTurnRequest", TurnStartRequest),
    turn: registry.register("Turn", TurnResponse),
    turnPage: registry.register("TurnPage", TurnPageResponse),
    turnReplay: registry.register("TurnReplayResponse", TurnReplayResponse),
    turnAccepted: registry.register("TurnAcceptedResponse", TurnAcceptedResponse),
    turnSteerRequest: registry.register("SteerRequest", TurnSteerRequest),
    dynamicToolResult: registry.register("DynamicToolResultRequest", DynamicToolResultSubmitRequest),
    ok: registry.register("OkResponse", OkResponse),
    usageList: registry.register("UsageListResponse", UsageListResponse),
    itemList: registry.register("ItemListResponse", ItemListResponse),
    approvalList: registry.register("ApprovalListResponse", ApprovalListResponse),
    approvalResolve: registry.register("ApprovalResponseRequest", ApprovalResolveRequest),
    approval: registry.register("Approval", Approval),
  };

  const errorResponse = jsonResponse(schemas.error, "Error response.");
  const register = (route: RouteConfig) => {
    if (!route.operationId) throw new Error(`${route.method.toUpperCase()} ${route.path} is missing operationId`);
    if (operationIds.has(route.operationId)) throw new Error(`duplicate OpenAPI operationId: ${route.operationId}`);
    operationIds.add(route.operationId);
    registry.registerPath(route);
  };

  // ---------- unauthenticated global surface ----------

  register({
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tags: ["Service"],
    summary: "Process liveness",
    responses: { 200: textResponse(HealthResponse, "The process is alive.") },
  });
  register({
    method: "get",
    path: "/readyz",
    operationId: "getReadiness",
    tags: ["Service"],
    summary: "Dependency and drain readiness",
    responses: {
      200: textResponse(ReadinessResponse, "The service is ready."),
      503: textResponse(ReadinessResponse, "The service is not ready or is draining."),
    },
  });
  register({
    method: "get",
    path: "/v1/capabilities",
    operationId: "getCapabilities",
    tags: ["Service"],
    summary: "Discover implemented protocol capabilities",
    responses: {
      200: jsonResponse(schemas.capabilities, "Current runner or router capabilities."),
      503: errorResponse,
    },
  });
  register({
    method: "get",
    path: "/openapi.json",
    operationId: "getOpenApiDocument",
    tags: ["Service"],
    summary: "Download the public OpenAPI contract",
    responses: { 200: jsonResponse(schemas.openapi, "OpenAPI 3.1 document for this service.") },
  });

  // ---------- agents ----------

  register({
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    tags: ["Agents"],
    summary: "Create an immutable agent definition at version 1",
    security: serviceSecurity,
    ...adminOnly,
    request: { body: jsonBody(schemas.agentRequest, "Agent definition.") },
    responses: { 201: jsonResponse(schemas.agent, "Created agent definition."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    tags: ["Agents"],
    summary: "List latest agent definitions",
    security: serviceSecurity,
    ...adminOnly,
    request: { query: AgentListQuery },
    responses: { 200: jsonResponse(schemas.agentPage, "A page of agent definitions."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    tags: ["Agents"],
    summary: "Get an agent definition version",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: AgentIdParams, query: AgentVersionQuery },
    responses: { 200: jsonResponse(schemas.agent, "Agent definition."), default: errorResponse },
  });
  register({
    method: "put",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    tags: ["Agents"],
    summary: "Create the next immutable version of an agent",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: AgentIdParams, body: jsonBody(schemas.agentRequest, "Replacement agent definition.") },
    responses: { 200: jsonResponse(schemas.agent, "New agent definition version."), default: errorResponse },
  });

  // ---------- providers and catalogs ----------

  register({
    method: "get",
    path: "/v1/providers",
    operationId: "listProviders",
    tags: ["Providers"],
    summary: "List visible provider configurations with secrets redacted",
    security: serviceSecurity,
    responses: { 200: jsonResponse(schemas.providerList, "Visible provider configurations."), default: errorResponse },
  });
  register({
    method: "put",
    path: "/v1/providers/{id}",
    operationId: "upsertProvider",
    tags: ["Providers"],
    summary: "Create or replace a tenant provider configuration",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: ProviderIdParams, body: jsonBody(schemas.providerRequest, "Provider configuration; apiKey is write-only.") },
    responses: { 200: jsonResponse(schemas.provider, "Stored provider configuration with secrets redacted."), default: errorResponse },
  });
  register({
    method: "delete",
    path: "/v1/providers/{id}",
    operationId: "deleteProvider",
    tags: ["Providers"],
    summary: "Delete a tenant provider configuration",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: ProviderIdParams },
    responses: { 204: noContentResponse("Provider deleted."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/models",
    operationId: "listModels",
    tags: ["Catalog"],
    summary: "List models visible to the tenant",
    security: serviceSecurity,
    responses: { 200: jsonResponse(schemas.modelList, "Visible model catalog."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/tools",
    operationId: "listTools",
    tags: ["Catalog"],
    summary: "List tools visible to the runner",
    security: serviceSecurity,
    responses: { 200: jsonResponse(schemas.toolList, "Visible tool catalog."), default: errorResponse },
  });

  // ---------- tenant administration ----------

  register({
    method: "get",
    path: "/v1/tenant/api-keys",
    operationId: "listApiKeys",
    tags: ["Tenant"],
    summary: "List API key records without key material",
    security: serviceSecurity,
    ...adminOnly,
    responses: { 200: jsonResponse(schemas.apiKeyList, "Tenant API key records."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/tenant/api-keys",
    operationId: "createApiKey",
    tags: ["Tenant"],
    summary: "Create an API key",
    description: "The plaintext key is returned exactly once and is never stored by the service.",
    security: serviceSecurity,
    ...adminOnly,
    request: { body: jsonBody(schemas.apiKeyCreateRequest, "Key label and scopes.") },
    responses: { 201: jsonResponse(schemas.apiKeyCreateResponse, "Created API key and one-time secret."), default: errorResponse },
  });
  register({
    method: "delete",
    path: "/v1/tenant/api-keys/{keyId}",
    operationId: "revokeApiKey",
    tags: ["Tenant"],
    summary: "Revoke an API key",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: ApiKeyIdParams },
    responses: { 204: noContentResponse("API key revoked."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/tenant/auth",
    operationId: "getTenantAuth",
    tags: ["Tenant"],
    summary: "Read the tenant end-user authentication policy",
    security: serviceSecurity,
    ...adminOnly,
    responses: { 200: jsonResponse(schemas.authState, "Tenant authentication state; secrets are never returned."), default: errorResponse },
  });
  register({
    method: "put",
    path: "/v1/tenant/auth",
    operationId: "updateTenantAuth",
    tags: ["Tenant"],
    summary: "Replace the tenant end-user authentication policy",
    security: serviceSecurity,
    ...adminOnly,
    request: { body: jsonBody(schemas.authUpdateRequest, "Authentication policy and optional write-only secret.") },
    responses: { 200: jsonResponse(schemas.authState, "Updated tenant authentication state."), default: errorResponse },
  });

  // ---------- sessions ----------

  register({
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tags: ["Sessions"],
    summary: "Create a session pinned to an agent version",
    security: userSecurity,
    request: { headers: UserIdentityHeaders, body: jsonBody(schemas.sessionCreateRequest, "Session creation request.") },
    responses: { 201: jsonResponse(schemas.session, "Created session."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tags: ["Sessions"],
    summary: "List sessions visible to the caller",
    description: "A user identity confines the result to that user. Listing tenant-wide requires an admin-scoped key.",
    security: serviceSecurity,
    request: { headers: UserIdentityHeaders, query: SessionListQuery },
    responses: { 200: jsonResponse(schemas.sessionPage, "A page of sessions."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    tags: ["Sessions"],
    summary: "Get a session",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.session, "Session state."), default: errorResponse },
  });
  register({
    method: "delete",
    path: "/v1/sessions/{id}",
    operationId: "deleteSession",
    tags: ["Sessions"],
    summary: "Soft-delete a session",
    description: "Hides the session from normal access. Durable child records remain until the retention/purge lifecycle is implemented.",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 204: noContentResponse("Session hidden."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/compact",
    operationId: "compactSession",
    tags: ["Sessions"],
    summary: "Force context compaction",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.compactSession, "Compaction result."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/archive",
    operationId: "archiveSession",
    tags: ["Sessions"],
    summary: "Archive a session",
    description: "Idempotently archives an idle session through the lease/fence path. Archived sessions remain readable but reject new mutable runtime operations.",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.session, "Archived session."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/unarchive",
    operationId: "unarchiveSession",
    tags: ["Sessions"],
    summary: "Restore an archived session",
    description: "Idempotently returns an archived session to the visible, writable state through the lease/fence path.",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.session, "Unarchived session."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    tags: ["Sessions"],
    summary: "Fetch the state required to resume a client",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.resumeSession, "Session snapshot, recent turns and replay cursor."), default: errorResponse },
  });

  // ---------- turns ----------

  register({
    method: "post",
    path: "/v1/sessions/{id}/turns",
    operationId: "startTurn",
    tags: ["Turns"],
    summary: "Start or steer a turn",
    description: "A new streaming turn returns SSE. A non-streaming request returns 202 JSON. A completed idempotency replay always returns 200 JSON.",
    security: userSecurity,
    request: {
      params: SessionIdParams,
      query: StartTurnQuery,
      headers: StartTurnHeaders,
      body: jsonBody(schemas.turnStartRequest, "Turn input and execution options."),
    },
    responses: {
      200: {
        description: "SSE event stream, or a completed idempotency replay as JSON.",
        headers: {
          "Idempotency-Replayed": {
            description: "True only when the JSON response is a completed idempotency replay.",
            schema: { type: "boolean" },
          },
          "Cache-Control": { description: "SSE streams are not cached.", schema: { type: "string" } },
          "X-Accel-Buffering": { description: "Disables reverse-proxy buffering for SSE.", schema: { type: "string" } },
        },
        content: {
          [JSON_MEDIA_TYPE]: { schema: schemas.turnReplay },
          [SSE_MEDIA_TYPE]: {
            schema: EventStreamBody,
          },
        },
      },
      202: jsonResponse(schemas.turnAccepted, "Turn accepted for asynchronous execution."),
      default: errorResponse,
    },
    "x-sse-event-schema": { $ref: "#/components/schemas/Event" },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listTurns",
    tags: ["Turns"],
    summary: "List turns in a session",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders, query: Pagination },
    responses: { 200: jsonResponse(schemas.turnPage, "A page of turns."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/turns/{turnId}",
    operationId: "getTurn",
    tags: ["Turns"],
    summary: "Get a turn",
    security: userSecurity,
    request: { params: SessionTurnParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.turn, "Turn state."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/turns/{turnId}/interrupt",
    operationId: "interruptTurn",
    tags: ["Turns"],
    summary: "Interrupt a running turn",
    security: userSecurity,
    request: { params: SessionTurnParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.turn, "Interrupted or already-terminal turn."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/turns/{turnId}/steer",
    operationId: "steerTurn",
    tags: ["Turns"],
    summary: "Inject user input into a running turn",
    security: userSecurity,
    request: {
      params: SessionTurnParams,
      headers: UserIdentityHeaders,
      body: jsonBody(schemas.turnSteerRequest, "Steer input and optional active-turn precondition."),
    },
    responses: { 202: jsonResponse(schemas.ok, "Steer accepted."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/turns/{turnId}/tool-results",
    operationId: "submitDynamicToolResult",
    tags: ["Turns"],
    summary: "Return a result for a client-executed dynamic tool",
    security: userSecurity,
    request: {
      params: SessionTurnParams,
      headers: UserIdentityHeaders,
      body: jsonBody(schemas.dynamicToolResult, "Dynamic tool result."),
    },
    responses: { 202: jsonResponse(schemas.ok, "Tool result accepted."), default: errorResponse },
  });

  // ---------- usage, items, events and approvals ----------

  register({
    method: "get",
    path: "/v1/usage",
    operationId: "queryUsage",
    tags: ["Usage"],
    summary: "Query normalized usage ledger rollups",
    description: "A user identity confines results to that user. Tenant-wide and group-by-user views require an admin-scoped key.",
    security: serviceSecurity,
    request: { headers: UserIdentityHeaders, query: UsageListQuery },
    responses: { 200: jsonResponse(schemas.usageList, "Usage rollups."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/items",
    operationId: "listItems",
    tags: ["Items"],
    summary: "List durable items in a session",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders, query: ItemListQuery },
    responses: { 200: jsonResponse(schemas.itemList, "Session items."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "subscribeEvents",
    tags: ["Events"],
    summary: "Replay and follow a session event stream",
    description: "Persisted events use their per-session seq as the SSE id. Last-Event-ID is equivalent to the after query parameter.",
    security: userSecurity,
    request: { params: SessionIdParams, headers: EventStreamHeaders, query: EventStreamQuery },
    responses: {
      200: {
        description: "Replay followed by live Server-Sent Events.",
        headers: {
          "Cache-Control": { description: "The stream is not cached.", schema: { type: "string" } },
          "X-Accel-Buffering": { description: "Disables reverse-proxy buffering.", schema: { type: "string" } },
        },
        content: {
          [SSE_MEDIA_TYPE]: {
            schema: EventStreamBody,
          },
        },
      },
      default: errorResponse,
    },
    "x-sse-event-schema": { $ref: "#/components/schemas/Event" },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/approvals",
    operationId: "listApprovals",
    tags: ["Approvals"],
    summary: "List approvals in a session",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders, query: ApprovalListQuery },
    responses: { 200: jsonResponse(schemas.approvalList, "Session approvals."), default: errorResponse },
  });
  register({
    method: "post",
    path: "/v1/sessions/{id}/approvals/{approvalId}",
    operationId: "resolveApproval",
    tags: ["Approvals"],
    summary: "Resolve a pending approval",
    security: userSecurity,
    request: {
      params: SessionApprovalParams,
      headers: UserIdentityHeaders,
      body: jsonBody(schemas.approvalResolve, "Approval decision."),
    },
    responses: { 200: jsonResponse(schemas.approval, "Resolved approval."), default: errorResponse },
  });

  if (operationIds.size !== 37) {
    throw new Error(`expected 37 public OpenAPI operations, registered ${operationIds.size}`);
  }

  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "agent-service API",
      version: PROTOCOL_VERSION,
      description: "Public local-first API exposed by agent-runner and proxied by agent-router.",
    },
    servers: [{ url: "/", description: "Current service origin" }],
    tags: [
      { name: "Service" },
      { name: "Agents" },
      { name: "Providers" },
      { name: "Catalog" },
      { name: "Tenant" },
      { name: "Sessions" },
      { name: "Turns" },
      { name: "Usage" },
      { name: "Items" },
      { name: "Events" },
      { name: "Approvals" },
    ],
  });
  return {
    ...document,
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  };
}
