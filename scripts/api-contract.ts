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
  ActiveLegalHoldListResponse,
  ActiveRetentionPolicyResponse,
  ApiKeyCreateRequest,
  ApiKeyIdParams,
  ApiKeyListResponse,
  Approval,
  ApprovalListQuery,
  ApprovalListResponse,
  ApprovalResolveRequest,
  BlobUploadResponse,
  Capabilities,
  CompactSessionResponse,
  configureProtocolZod,
  CreateApiKeyResponse,
  DATA_EXPORT_CONTENT_TYPE,
  DataExportRequest,
  DataExportRequestHeaders,
  DataExportRequestParams,
  DynamicToolResultSubmitRequest,
  ErrorBody,
  ExcludableEventTypeSchema,
  EventStreamBody,
  EventStreamEvent,
  EventStreamHeaders,
  EventStreamQuery,
  ErasureRequest,
  ErasureRequestHeaders,
  ErasureRequestParams,
  HealthResponse,
  ItemListQuery,
  ItemListResponse,
  ItemOutputResponse,
  LegalHoldListQuery,
  LegalHoldParams,
  LegalHoldRecord,
  LegalHoldReleaseRequest,
  LegalHoldSetRequest,
  IMAGE_MEDIA_TYPES,
  ModelListResponse,
  OkResponse,
  OpenApiDocumentResponse,
  Pagination,
  ProviderConfigResponse,
  ProviderIdParams,
  ProviderListResponse,
  ReadinessResponse,
  RetentionPolicyActivateRequest,
  RetentionPolicyParams,
  RetentionPolicyPutRequest,
  RetentionPolicyRecord,
  ResumeSessionHttpResponse,
  SessionApprovalParams,
  SessionBlobParams,
  SessionCreateRequest,
  SessionIdParams,
  SessionItemOutputParams,
  SessionListQuery,
  SessionPageResponse,
  SessionResponse,
  SessionTurnParams,
  StartTurnHeaders,
  StartTurnQuery,
  TenantErasureCreateRequest,
  TenantErasureRequest,
  TenantErasureRequestHeaders,
  TenantErasureRequestParams,
  TenantErasureRequestQuery,
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

const PRIVATE_RESPONSE_HEADERS: NonNullable<ResponseConfig["headers"]> = {
  "Cache-Control": {
    description: "Prevents storage of this sensitive lifecycle response.",
    schema: { type: "string", enum: ["no-store"] },
  },
  "X-Content-Type-Options": {
    description: "Prevents content-type sniffing.",
    schema: { type: "string", enum: ["nosniff"] },
  },
};

const privateJsonResponse = (schema: ContractSchema, description: string): ResponseConfig => ({
  ...jsonResponse(schema, description),
  headers: PRIVATE_RESPONSE_HEADERS,
});

const EXPORT_RESPONSE_HEADERS: NonNullable<ResponseConfig["headers"]> = {
  ...PRIVATE_RESPONSE_HEADERS,
  "Content-Disposition": {
    description: "Attachment disposition with a server-generated ASCII filename.",
    schema: { type: "string" },
  },
  "Content-Digest": {
    description: "SHA-256 digest of the complete artifact using HTTP structured-field syntax.",
    schema: { type: "string", pattern: "^sha-256=:[A-Za-z0-9+/]{43}=:$" },
  },
  "X-Artifact-Size": {
    description: "Complete artifact size in bytes, independent of transfer framing.",
    schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
  "Content-Length": {
    description: "Artifact transfer length when known; proxies may omit it and use chunked transfer.",
    schema: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
};

const textResponse = (schema: ContractSchema, description: string): ResponseConfig => ({
  description,
  content: { "text/plain": { schema } },
});

const BINARY_SCHEMA = { type: "string", format: "binary" } as const;

const binaryResponse = (description: string): ResponseConfig => ({
  description,
  content: Object.fromEntries(IMAGE_MEDIA_TYPES.map((mediaType) => [mediaType, { schema: BINARY_SCHEMA }])),
});

const privateExportBinaryResponse = (description: string): ResponseConfig => ({
  description,
  headers: EXPORT_RESPONSE_HEADERS,
  content: { [DATA_EXPORT_CONTENT_TYPE]: { schema: BINARY_SCHEMA } },
});

const binaryBody = (description: string): NonNullable<RouteConfig["request"]>["body"] => ({
  description,
  required: true,
  content: Object.fromEntries(IMAGE_MEDIA_TYPES.map((mediaType) => [mediaType, { schema: BINARY_SCHEMA }])),
});

const jsonBody = (schema: ContractSchema, description: string): NonNullable<RouteConfig["request"]>["body"] => ({
  description,
  required: true,
  content: { [JSON_MEDIA_TYPE]: { schema } },
});

const noContentResponse = (description: string): ResponseConfig => ({ description });

const serviceSecurity: NonNullable<RouteConfig["security"]> = [{ ServiceApiKey: [] }];
const platformSecurity: NonNullable<RouteConfig["security"]> = [{ PlatformOperatorToken: [] }];
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
  registry.registerComponent("securitySchemes", "PlatformOperatorToken", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "AgentServicePlatformOperatorToken",
    description: "Platform lifecycle operator credential. It is independent from every tenant service API key.",
  });

  const schemas = {
    error: registry.register("ErrorBody", ErrorBody),
    event: registry.register("Event", EventStreamEvent),
    erasureRequest: registry.register("ErasureRequest", ErasureRequest),
    tenantErasureCreate: registry.register("TenantErasureCreateRequest", TenantErasureCreateRequest),
    tenantErasureRequest: registry.register("TenantErasureRequest", TenantErasureRequest),
    dataExportRequest: registry.register("DataExportRequest", DataExportRequest),
    retentionPolicyPut: registry.register("RetentionPolicyPutRequest", RetentionPolicyPutRequest),
    retentionPolicyActivate: registry.register("RetentionPolicyActivateRequest", RetentionPolicyActivateRequest),
    retentionPolicy: registry.register("RetentionPolicy", RetentionPolicyRecord),
    activeRetentionPolicy: registry.register("ActiveRetentionPolicy", ActiveRetentionPolicyResponse),
    legalHoldSet: registry.register("LegalHoldSetRequest", LegalHoldSetRequest),
    legalHoldRelease: registry.register("LegalHoldReleaseRequest", LegalHoldReleaseRequest),
    legalHold: registry.register("LegalHold", LegalHoldRecord),
    activeLegalHolds: registry.register("ActiveLegalHoldList", ActiveLegalHoldListResponse),
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
    itemOutput: registry.register("ToolOutputPayload", ItemOutputResponse),
    blobUpload: registry.register("BlobUploadResponse", BlobUploadResponse),
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
    summary: "Tombstone a session",
    description: "Idempotently tombstones a visible or archived idle session through the lease/fence path. A retry by the same owner returns 204 without another event or generation; an active session returns session_busy and a parent with non-deleted children returns session_has_children. After success all normal resource APIs return 404. Physical purge remains disabled until retention policy is configured.",
    security: userSecurity,
    request: { params: SessionIdParams, headers: UserIdentityHeaders },
    responses: { 204: noContentResponse("Session tombstoned."), default: errorResponse },
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
  register({
    method: "post",
    path: "/v1/sessions/{id}/blobs",
    operationId: "uploadSessionBlob",
    tags: ["Blobs"],
    summary: "Stage an input image for a session",
    description: "Uploads raw bytes and returns an opaque, owner-scoped blob id. A staging blob is not readable until a turn or steer request atomically attaches it. Cross-tenant, cross-user and cross-session lookups return 404.",
    security: userSecurity,
    request: {
      params: SessionIdParams,
      headers: UserIdentityHeaders,
      body: binaryBody("Raw input-image bytes. Send the image media type in Content-Type."),
    },
    responses: { 201: jsonResponse(schemas.blobUpload, "Staged input image."), default: errorResponse },
  });
  register({
    method: "get",
    path: "/v1/sessions/{id}/blobs/{blobId}",
    operationId: "getSessionBlob",
    tags: ["Blobs"],
    summary: "Read an attached session blob",
    description: "Returns bytes only after the opaque blob id is ready and attached to this session. Staging, missing and ownership-mismatched blobs all return 404.",
    security: userSecurity,
    request: { params: SessionBlobParams, headers: UserIdentityHeaders },
    responses: { 200: binaryResponse("Attached blob bytes; Content-Type is the recorded media type."), default: errorResponse },
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

  // ---------- subject lifecycle ----------

  register({
    method: "post",
    path: "/v1/tenant-erasure-requests",
    operationId: "requestTenantErasure",
    tags: ["Platform data lifecycle"],
    summary: "Admit and logically fence a tenant for future erasure",
    description: "Platform-operator-only. New admission is fleet-gated and atomically creates the tenant admission, logical credential fence and first audit event. While admission is closed, an exact already-committed Idempotency-Key replay remains recoverable but can never create a gate. T2 does not claim that a tenant worker exists or that physical credential/content deletion is complete.",
    security: platformSecurity,
    request: {
      headers: TenantErasureRequestHeaders,
      body: jsonBody(schemas.tenantErasureCreate, "Target tenant. The platform credential is intentionally outside that tenant's credential plane."),
    },
    responses: {
      202: privateJsonResponse(schemas.tenantErasureRequest, "Existing or newly accepted tenant erasure request."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/tenant-erasure-requests/{requestId}",
    operationId: "getTenantErasureRequest",
    tags: ["Platform data lifecycle"],
    summary: "Read a tenant erasure request",
    description: "Uses the independent platform operator credential and remains available when new tenant-erasure admission is closed.",
    security: platformSecurity,
    request: {
      params: TenantErasureRequestParams,
      query: TenantErasureRequestQuery,
    },
    responses: {
      200: privateJsonResponse(schemas.tenantErasureRequest, "Tenant erasure request status."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });

  register({
    method: "post",
    path: "/v1/data-erasure-requests",
    operationId: "requestUserErasure",
    tags: ["Data lifecycle"],
    summary: "Gate a user's data for asynchronous erasure",
    description: "Admin-only and capability-gated. Atomically blocks new user-owned writes and creates an auditable request; it does not claim physical purge is complete.",
    security: userSecurity,
    ...adminOnly,
    request: { headers: ErasureRequestHeaders },
    responses: {
      202: privateJsonResponse(schemas.erasureRequest, "Existing or newly accepted user erasure request."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/data-erasure-requests/{requestId}",
    operationId: "getUserErasureRequest",
    tags: ["Data lifecycle"],
    summary: "Read an owned user erasure request",
    security: userSecurity,
    ...adminOnly,
    request: { params: ErasureRequestParams, headers: UserIdentityHeaders },
    responses: {
      200: privateJsonResponse(schemas.erasureRequest, "Erasure request status."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "post",
    path: "/v1/data-export-requests",
    operationId: "requestUserDataExport",
    tags: ["Data lifecycle"],
    summary: "Request an asynchronous user data export",
    description: "Admin-only, user-scoped and capability-gated. Idempotently queues a point-in-time NDJSON export artifact; no partial artifact is downloadable.",
    security: userSecurity,
    ...adminOnly,
    request: { headers: DataExportRequestHeaders },
    responses: {
      202: privateJsonResponse(schemas.dataExportRequest, "Existing or newly accepted user data export request."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/data-export-requests/{requestId}",
    operationId: "getUserDataExportRequest",
    tags: ["Data lifecycle"],
    summary: "Read an owned user data export request",
    security: userSecurity,
    ...adminOnly,
    request: { params: DataExportRequestParams, headers: UserIdentityHeaders },
    responses: {
      200: privateJsonResponse(schemas.dataExportRequest, "Data export request status."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/data-export-requests/{requestId}/download",
    operationId: "downloadUserDataExport",
    tags: ["Data lifecycle"],
    summary: "Download a ready user data export artifact",
    description: "Streams the complete owner-scoped artifact only while the request is ready and unexpired. Missing, expired, revoked and ownership-mismatched artifacts return the same private 404 response.",
    security: userSecurity,
    ...adminOnly,
    request: { params: DataExportRequestParams, headers: UserIdentityHeaders },
    responses: {
      200: privateExportBinaryResponse("Complete NDJSON export artifact."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "put",
    path: "/v1/retention-policies/{policyVersion}",
    operationId: "putRetentionPolicy",
    tags: ["Data lifecycle"],
    summary: "Register an immutable tenant retention policy version",
    description: "Admin-only and rollout-gated. Registering a version does not activate it and cannot authorize purge.",
    security: serviceSecurity,
    ...adminOnly,
    request: {
      params: RetentionPolicyParams,
      body: jsonBody(schemas.retentionPolicyPut, "Complete version-1 retention policy document."),
    },
    responses: {
      200: privateJsonResponse(schemas.retentionPolicy, "Existing or newly registered immutable policy version."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "post",
    path: "/v1/retention-policies/{policyVersion}/activate",
    operationId: "activateRetentionPolicy",
    tags: ["Data lifecycle"],
    summary: "Activate a canonical tenant retention policy",
    description: "Admin-only generation-CAS activation. It affects only requests created after the activation linearization point; existing backlog is never adopted implicitly.",
    security: serviceSecurity,
    ...adminOnly,
    request: {
      params: RetentionPolicyParams,
      body: jsonBody(schemas.retentionPolicyActivate, "Expected policy-control generation."),
    },
    responses: {
      200: privateJsonResponse(schemas.activeRetentionPolicy, "Active policy and its monotonic control."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/retention-policies/active",
    operationId: "getActiveRetentionPolicy",
    tags: ["Data lifecycle"],
    summary: "Read the active canonical tenant retention policy",
    security: serviceSecurity,
    ...adminOnly,
    responses: {
      200: privateJsonResponse(schemas.activeRetentionPolicy, "Active policy and its monotonic control."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/retention-policies/{policyVersion}",
    operationId: "getRetentionPolicy",
    tags: ["Data lifecycle"],
    summary: "Read an immutable tenant retention policy version",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: RetentionPolicyParams },
    responses: {
      200: privateJsonResponse(schemas.retentionPolicy, "Immutable policy version."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "post",
    path: "/v1/legal-holds",
    operationId: "setLegalHold",
    tags: ["Data lifecycle"],
    summary: "Set a tenant- or user-scoped legal hold",
    description: "Admin-only generation-CAS operation. A hold pauses destructive work but never restores ordinary API visibility.",
    security: serviceSecurity,
    ...adminOnly,
    request: { body: jsonBody(schemas.legalHoldSet, "Bounded hold identity, scope and reason.") },
    responses: {
      200: privateJsonResponse(schemas.legalHold, "Existing or newly set legal hold."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "post",
    path: "/v1/legal-holds/{holdId}/release",
    operationId: "releaseLegalHold",
    tags: ["Data lifecycle"],
    summary: "Release one legal hold",
    description: "Admin-only generation-CAS release. Other active holds on the same subject remain effective.",
    security: serviceSecurity,
    ...adminOnly,
    request: {
      params: LegalHoldParams,
      body: jsonBody(schemas.legalHoldRelease, "Expected subject hold generation and bounded release reason."),
    },
    responses: {
      200: privateJsonResponse(schemas.legalHold, "Released legal hold."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/legal-holds/{holdId}",
    operationId: "getLegalHold",
    tags: ["Data lifecycle"],
    summary: "Read one tenant-owned legal hold",
    security: serviceSecurity,
    ...adminOnly,
    request: { params: LegalHoldParams },
    responses: {
      200: privateJsonResponse(schemas.legalHold, "Legal hold."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
  });
  register({
    method: "get",
    path: "/v1/legal-holds",
    operationId: "listActiveLegalHolds",
    tags: ["Data lifecycle"],
    summary: "List active holds and their subject control",
    security: serviceSecurity,
    ...adminOnly,
    request: { query: LegalHoldListQuery },
    responses: {
      200: privateJsonResponse(schemas.activeLegalHolds, "Active holds and fail-closed projection control."),
      default: privateJsonResponse(schemas.error, "Error response."),
    },
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
    path: "/v1/sessions/{id}/items/{itemId}/output",
    operationId: "getItemOutput",
    tags: ["Items"],
    summary: "Fetch an offloaded tool output",
    description: "Resolves an item's opaque output blob only for the exact tenant, user, session and item owner. Missing, non-ready and ownership-mismatched outputs return 404.",
    security: userSecurity,
    request: { params: SessionItemOutputParams, headers: UserIdentityHeaders },
    responses: { 200: jsonResponse(schemas.itemOutput, "Full offloaded tool output."), default: errorResponse },
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

  if (operationIds.size !== 55) {
    throw new Error(`expected 55 public OpenAPI operations, registered ${operationIds.size}`);
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
      { name: "Blobs" },
      { name: "Turns" },
      { name: "Data lifecycle" },
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
