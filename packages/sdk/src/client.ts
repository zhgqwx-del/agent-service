import createOpenApiClient, { mergeHeaders, type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";
import { parseSse, type SseEvent } from "./sse.js";

export interface AgentServiceAuth {
  /** Service API key sent as `Authorization: Bearer ...`. */
  serviceApiKey?: string;
  /** Trusted-caller user assertion. Omit when the tenant derives identity from an end-user token. */
  userId?: string;
  /** End-user token. The header name is tenant-configurable and defaults to `X-End-User-Token`. */
  endUserToken?: string;
  endUserTokenHeader?: string;
}

export interface AgentServiceClientOptions extends Omit<ClientOptions, "headers">, AgentServiceAuth {
  baseUrl: string;
  headers?: ClientOptions["headers"];
}

export type AgentServiceClient = Client<paths>;

/** The platform lifecycle credential is intentionally not part of AgentServiceAuth. */
export interface AgentServicePlatformClientOptions extends Omit<ClientOptions, "headers"> {
  baseUrl: string;
  platformOperatorToken: string;
  headers?: ClientOptions["headers"];
}

export type AgentServicePlatformPaths = Pick<
  paths,
  "/v1/tenant-erasure-requests" | "/v1/tenant-erasure-requests/{requestId}"
>;
export type AgentServicePlatformClient = Client<AgentServicePlatformPaths>;

export interface AgentServiceSkillRegistryOperatorClientOptions extends Omit<ClientOptions, "headers"> {
  baseUrl: string;
  skillRegistryOperatorToken: string;
  headers?: ClientOptions["headers"];
}
export type AgentServiceSkillRegistryOperatorPaths = Pick<paths,
  "/v1/platform/skills" | "/v1/platform/skills/{name}" | "/v1/platform/skills/{name}/versions" | "/v1/platform/skills/{name}/versions/{versionId}">;
export type AgentServiceSkillRegistryOperatorClient = Client<AgentServiceSkillRegistryOperatorPaths>;

/** This token cannot authenticate tenant erasure or ordinary runtime requests. */
export function createAgentServiceSkillRegistryOperatorClient(options: AgentServiceSkillRegistryOperatorClientOptions): AgentServiceSkillRegistryOperatorClient {
  const { skillRegistryOperatorToken, headers, ...clientOptions } = options;
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(skillRegistryOperatorToken)) throw new TypeError("Invalid skill registry operator token");
  return createOpenApiClient<AgentServiceSkillRegistryOperatorPaths>({ ...clientOptions,
    headers: mergeHeaders(headers, { Authorization: `Bearer ${skillRegistryOperatorToken}` }) });
}

/** A separate router-only credential; never use tenant-erasure or skills operator credentials. */
export interface AgentServiceMcpRegistryOperatorClientOptions extends Omit<ClientOptions, "headers"> {
  baseUrl: string; mcpRegistryOperatorToken: string; headers?: ClientOptions["headers"];
}
export type AgentServiceMcpRegistryOperatorPaths = Pick<paths,
  "/v1/platform/mcp-servers" | "/v1/platform/mcp-servers/{name}" | "/v1/platform/mcp-servers/{name}/state" |
  "/v1/platform/mcp-servers/{name}/oauth/client/register" | "/v1/platform/mcp-servers/{name}/oauth/client/status">;
export type AgentServiceMcpRegistryOperatorClient = Client<AgentServiceMcpRegistryOperatorPaths>;
export function createAgentServiceMcpRegistryOperatorClient(options: AgentServiceMcpRegistryOperatorClientOptions): AgentServiceMcpRegistryOperatorClient {
  const { mcpRegistryOperatorToken, headers, ...clientOptions } = options;
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(mcpRegistryOperatorToken)) throw new TypeError("Invalid MCP registry operator token");
  return createOpenApiClient<AgentServiceMcpRegistryOperatorPaths>({ ...clientOptions,
    headers: mergeHeaders(headers, { Authorization: `Bearer ${mcpRegistryOperatorToken}` }) });
}

export type AgentServiceEvent = components["schemas"]["Event"];
export type ExcludableEventType = components["schemas"]["ExcludableEventType"];
export type StartTurnInput = components["schemas"]["StartTurnRequest"];
export type TurnReplay = components["schemas"]["TurnReplayResponse"];
export type SessionBlobContentType = components["schemas"]["BlobUploadResponse"]["contentType"];
export type SessionBlobUpload = components["schemas"]["BlobUploadResponse"];
export type ItemOutput = components["schemas"]["ToolOutputPayload"];
type HeaderInput = ConstructorParameters<typeof Headers>[0];

function authHeaders(auth: AgentServiceAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.serviceApiKey) headers.Authorization = `Bearer ${auth.serviceApiKey}`;
  if (auth.userId) headers["X-User-Id"] = auth.userId;
  if (auth.endUserToken) headers[auth.endUserTokenHeader ?? "X-End-User-Token"] = auth.endUserToken;
  return headers;
}

/**
 * Creates the generated, path-typed HTTP client. Credentials live only in request headers and are
 * never interpolated into URLs, errors, or generated source.
 */
export function createAgentServiceClient(options: AgentServiceClientOptions): AgentServiceClient {
  const {
    serviceApiKey,
    userId,
    endUserToken,
    endUserTokenHeader = "X-End-User-Token",
    headers: suppliedHeaders,
    ...clientOptions
  } = options;
  return createOpenApiClient<paths>({
    ...clientOptions,
    headers: mergeHeaders(suppliedHeaders, authHeaders({
      serviceApiKey,
      userId,
      endUserToken,
      endUserTokenHeader,
    })),
  });
}

/**
 * Creates the deliberately narrow tenant-lifecycle client. Keeping this credential out of the
 * tenant runtime auth shape prevents accidental reuse as a service API key or SSE credential.
 */
export function createAgentServicePlatformClient(
  options: AgentServicePlatformClientOptions,
): AgentServicePlatformClient {
  const { platformOperatorToken, headers: suppliedHeaders, ...clientOptions } = options;
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(platformOperatorToken)) {
    throw new TypeError("platformOperatorToken must contain 32 to 256 token-safe characters");
  }
  return createOpenApiClient<AgentServicePlatformPaths>({
    ...clientOptions,
    headers: mergeHeaders(suppliedHeaders, {
      Authorization: `Bearer ${platformOperatorToken}`,
    }),
  });
}

export interface AgentServiceRequestOptions extends AgentServiceAuth {
  baseUrl: string;
  headers?: HeaderInput;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Request options shared by the incremental event-stream helpers. */
export interface AgentServiceStreamOptions extends AgentServiceRequestOptions {}

export interface SessionEventQuery {
  after?: number;
  /** Event types accepted by the server's `exclude` query parameter. */
  exclude?: ExcludableEventType | readonly ExcludableEventType[];
  /** Sent as Last-Event-ID. The `after` query takes precedence when both are supplied. */
  lastEventId?: number;
}

export interface EventStreamResult<T = AgentServiceEvent> {
  response: Response;
  events: AsyncGenerator<SseEvent<T>>;
}

export interface SessionBlobUploadResult {
  response: Response;
  data: SessionBlobUpload;
}

export interface SessionBlobReadResult {
  response: Response;
  bytes: Uint8Array;
}

export interface ItemOutputResult {
  response: Response;
  data: ItemOutput;
}

export type SkillInstallInput = components["schemas"]["SkillInstallRequest"];
export type SkillDeleteInput = components["schemas"]["SkillDeleteRequest"];
export type SkillVersion = components["schemas"]["SkillVersionResponse"];
export type InstalledSkill = components["schemas"]["InstalledSkillResponse"];
export type SkillPage = components["schemas"]["SkillListResponse"];
export type SkillVersions = components["schemas"]["SkillVersionsResponse"];
export type SkillDocument = components["schemas"]["SkillDocumentResponse"];
export type UserSkillExport = components["schemas"]["SkillExportResponse"];
export interface SkillPageQuery { scope: "user" | "tenant"; limit?: number; cursor?: string }
export interface SkillExportOptions { limit?: number; cursor?: string; snapshotSha256?: string }

async function skillRequest<T>(options: AgentServiceRequestOptions, path: string, method: "GET" | "POST" | "DELETE",
  query?: Record<string, string | number | undefined>, body?: unknown, idempotencyKey?: string): Promise<{ response: Response; data: T }> {
  const url = endpoint(options.baseUrl, path);
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await (options.fetch ?? globalThis.fetch)(url, { method, signal: options.signal,
    headers: requestHeaders(options, { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }) }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await responseError(response);
  return { response, data: await response.json() as T };
}
export const installSkill = (options: AgentServiceRequestOptions, input: SkillInstallInput, idempotencyKey: string) =>
  skillRequest<SkillVersion>(options, "/v1/skills", "POST", undefined, input, idempotencyKey);
export const listInstalledSkills = (options: AgentServiceRequestOptions, query: SkillPageQuery) =>
  skillRequest<SkillPage>(options, "/v1/skills", "GET", { ...query });
export const getInstalledSkill = (options: AgentServiceRequestOptions, name: string, scope: "user" | "tenant") =>
  skillRequest<InstalledSkill>(options, `/v1/skills/${encodeURIComponent(name)}`, "GET", { scope });
export const deleteInstalledSkill = (options: AgentServiceRequestOptions, name: string, input: SkillDeleteInput, idempotencyKey: string) =>
  skillRequest<InstalledSkill>(options, `/v1/skills/${encodeURIComponent(name)}`, "DELETE", undefined, input, idempotencyKey);
export const listSkillVersions = (options: AgentServiceRequestOptions, name: string, query: SkillPageQuery) =>
  skillRequest<SkillVersions>(options, `/v1/skills/${encodeURIComponent(name)}/versions`, "GET", { ...query });
export const readSkillVersion = (options: AgentServiceRequestOptions, name: string, versionId: string, scope: "user" | "tenant") =>
  skillRequest<SkillDocument>(options, `/v1/skills/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}`, "GET", { scope });
export const exportUserSkills = (options: AgentServiceRequestOptions, query: SkillExportOptions = {}) =>
  skillRequest<UserSkillExport>(options, "/v1/skills/export", "GET", { ...query });

export type McpRegistrationUpsertInput = components["schemas"]["McpRegistrationUpsertRequest"];
export type McpRegistrationStateInput = components["schemas"]["McpRegistrationStateRequest"];
export type McpRegistrationDeleteInput = components["schemas"]["McpRegistrationDeleteRequest"];
export type McpRegistration = components["schemas"]["McpRegistrationResponse"];
export type McpInstalledRegistration = components["schemas"]["McpInstalledRegistrationResponse"];
export type McpRegistrationPage = components["schemas"]["McpRegistrationListResponse"];
export type McpAuthorizationBegin = components["schemas"]["McpAuthorizationBeginResponse"];
export type McpAuthorizationStatus = components["schemas"]["McpAuthorizationStatusResponse"];
export type McpDynamicClientRegistrationInput = components["schemas"]["McpDynamicClientRegistrationRequest"];
export type McpDynamicClientStatus = components["schemas"]["McpDynamicClientStatusResponse"];
/** Explicit management operation. Unknown creation outcomes require manual AS review. */
export const registerMcpDynamicClient = (options: AgentServiceRequestOptions, name: string, input: McpDynamicClientRegistrationInput, idempotencyKey: string) =>
  skillRequest<McpDynamicClientStatus>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/oauth/client/register`, "POST", undefined, input, idempotencyKey);
export const getMcpDynamicClientStatus = (options: AgentServiceRequestOptions, name: string, scope: "user" | "tenant", configVersionId: string) =>
  skillRequest<McpDynamicClientStatus>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/oauth/client/status`, "GET", { scope, configVersionId });
export type McpRegisteredTools = components["schemas"]["ToolList"];
export type McpRegistrationScope = "platform" | "tenant" | "user";
export interface McpRegistrationPageQuery { scope: "user" | "tenant"; cursor?: string; limit?: number }
export const upsertMcpRegistration = (options: AgentServiceRequestOptions, input: McpRegistrationUpsertInput, idempotencyKey: string) =>
  skillRequest<McpRegistration>(options, "/v1/mcp-servers", "POST", undefined, input, idempotencyKey);
export const listMcpRegistrations = (options: AgentServiceRequestOptions, query: McpRegistrationPageQuery) =>
  skillRequest<McpRegistrationPage>(options, "/v1/mcp-servers", "GET", { ...query });
export const getMcpRegistration = (options: AgentServiceRequestOptions, name: string, scope: "user" | "tenant") =>
  skillRequest<McpRegistration>(options, `/v1/mcp-servers/${encodeURIComponent(name)}`, "GET", { scope });
export const setMcpRegistrationState = (options: AgentServiceRequestOptions, name: string, input: McpRegistrationStateInput, idempotencyKey: string) =>
  skillRequest<McpInstalledRegistration>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/state`, "POST", undefined, input, idempotencyKey);
export const deleteMcpRegistration = (options: AgentServiceRequestOptions, name: string, input: McpRegistrationDeleteInput, idempotencyKey: string) =>
  skillRequest<McpInstalledRegistration>(options, `/v1/mcp-servers/${encodeURIComponent(name)}`, "DELETE", undefined, input, idempotencyKey);
export const discoverMcpTools = (options: AgentServiceRequestOptions, name: string, scope: McpRegistrationScope) =>
  skillRequest<McpRegisteredTools>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/tools`, "GET", { scope });
/** Refreshes the catalog only. Neither the SDK nor this endpoint retries an unknown tool outcome. */
export const refreshMcpCatalog = (options: AgentServiceRequestOptions, name: string, scope: McpRegistrationScope) =>
  skillRequest<McpRegisteredTools>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/refresh`, "POST", undefined, { scope });
export const beginMcpAuthorization = (options: AgentServiceRequestOptions, name: string, scope: McpRegistrationScope, idempotencyKey: string) =>
  skillRequest<McpAuthorizationBegin>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/oauth/begin`, "POST", undefined, { scope }, idempotencyKey);
export const getMcpAuthorization = (options: AgentServiceRequestOptions, name: string, scope: McpRegistrationScope) =>
  skillRequest<McpAuthorizationStatus>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/oauth/status`, "GET", { scope });
export const disconnectMcpAuthorization = (options: AgentServiceRequestOptions, name: string, scope: McpRegistrationScope,
  expectedAuthorizationEpoch: number, idempotencyKey: string) =>
  skillRequest<McpAuthorizationStatus>(options, `/v1/mcp-servers/${encodeURIComponent(name)}/oauth/disconnect`, "POST", undefined,
    { scope, expectedAuthorizationEpoch }, idempotencyKey);

export type StartTurnStreamResult =
  | ({ kind: "events" } & EventStreamResult)
  | { kind: "replay"; response: Response; data: TurnReplay };

/** Tenant administrator observer configuration. Signing keys are accepted only on write. */
export type TenantHookUpsertInput = components["schemas"]["TenantHookUpsertRequest"];
export type TenantHookStateInput = components["schemas"]["TenantHookStateRequest"];
export type TenantHookDeleteInput = components["schemas"]["TenantHookDeleteRequest"];
export type TenantHook = components["schemas"]["TenantHookResponse"];
export type InstalledTenantHook = components["schemas"]["InstalledTenantHookResponse"];
export type TenantHookPage = components["schemas"]["TenantHookListResponse"];
export type TenantHookDeliveries = components["schemas"]["TenantHookDeliveriesResponse"];
export interface TenantHookPageQuery { cursor?: string; limit?: number }
export const upsertTenantHook = (options: AgentServiceRequestOptions, input: TenantHookUpsertInput, idempotencyKey: string) =>
  skillRequest<TenantHook>(options, "/v1/tenant-hooks", "POST", undefined, input, idempotencyKey);
export const listTenantHooks = (options: AgentServiceRequestOptions, query: TenantHookPageQuery = {}) =>
  skillRequest<TenantHookPage>(options, "/v1/tenant-hooks", "GET", { ...query });
export const getTenantHook = (options: AgentServiceRequestOptions, name: string) =>
  skillRequest<TenantHook>(options, `/v1/tenant-hooks/${encodeURIComponent(name)}`, "GET");
export const setTenantHookState = (options: AgentServiceRequestOptions, name: string, input: TenantHookStateInput, idempotencyKey: string) =>
  skillRequest<InstalledTenantHook>(options, `/v1/tenant-hooks/${encodeURIComponent(name)}/state`, "POST", undefined, input, idempotencyKey);
export const deleteTenantHook = (options: AgentServiceRequestOptions, name: string, input: TenantHookDeleteInput, idempotencyKey: string) =>
  skillRequest<InstalledTenantHook>(options, `/v1/tenant-hooks/${encodeURIComponent(name)}`, "DELETE", undefined, input, idempotencyKey);
/** State only. This helper neither reads observed bodies nor retries uncertain delivery outcomes. */
export const listTenantHookDeliveries = (options: AgentServiceRequestOptions, name: string, query: TenantHookPageQuery = {}) =>
  skillRequest<TenantHookDeliveries>(options, `/v1/tenant-hooks/${encodeURIComponent(name)}/deliveries`, "GET", { ...query });

/** HTTP failures from SDK request helpers. The response body is retained as parsed JSON/text. */
export class AgentServiceHttpError extends Error {
  constructor(
    readonly response: Response,
    readonly body: unknown,
  ) {
    super(`agent-service request failed with HTTP ${response.status}`);
    this.name = "AgentServiceHttpError";
  }
}

function endpoint(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), normalized);
}

function requestHeaders(options: AgentServiceRequestOptions, extra?: HeaderInput): Headers {
  const headers = new Headers(options.headers);
  for (const [key, value] of Object.entries(authHeaders(options))) headers.set(key, value);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  return headers;
}

function addEventQuery(url: URL, query?: SessionEventQuery) {
  if (query?.after !== undefined) url.searchParams.set("after", String(query.after));
  if (query?.exclude !== undefined) {
    url.searchParams.set("exclude", typeof query.exclude === "string" ? query.exclude : query.exclude.join(","));
  }
}

async function responseError(response: Response): Promise<AgentServiceHttpError> {
  let body: unknown;
  try {
    body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    body = undefined;
  }
  return new AgentServiceHttpError(response, body);
}

const SESSION_BLOB_CONTENT_TYPES = new Set<SessionBlobContentType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function sessionBlobContentType(body: Uint8Array | Blob, supplied?: SessionBlobContentType): SessionBlobContentType {
  const blobType = body instanceof Uint8Array || !body.type ? undefined : body.type;
  if (supplied && blobType && supplied !== blobType) {
    throw new TypeError(`session blob Content-Type ${supplied} does not match Blob type ${blobType}`);
  }
  const contentType = supplied ?? blobType;
  if (!contentType || !SESSION_BLOB_CONTENT_TYPES.has(contentType as SessionBlobContentType)) {
    throw new TypeError("session blob Content-Type must be image/png, image/jpeg, image/webp, or image/gif");
  }
  return contentType as SessionBlobContentType;
}

/**
 * Upload raw image bytes into a session-scoped staging blob. Uint8Array callers must provide the
 * media type; Blob callers may rely on Blob.type. The helper intentionally bypasses JSON encoding.
 */
export function uploadSessionBlob(
  options: AgentServiceRequestOptions,
  sessionId: string,
  body: Uint8Array,
  contentType: SessionBlobContentType,
): Promise<SessionBlobUploadResult>;
export function uploadSessionBlob(
  options: AgentServiceRequestOptions,
  sessionId: string,
  body: Blob,
  contentType?: SessionBlobContentType,
): Promise<SessionBlobUploadResult>;
export async function uploadSessionBlob(
  options: AgentServiceRequestOptions,
  sessionId: string,
  body: Uint8Array | Blob,
  contentType?: SessionBlobContentType,
): Promise<SessionBlobUploadResult> {
  const mediaType = sessionBlobContentType(body, contentType);
  const url = endpoint(options.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/blobs`);
  const headers = requestHeaders(options, {
    Accept: "application/json",
    "Content-Type": mediaType,
  });
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });
  if (!response.ok) throw await responseError(response);
  return { response, data: await response.json() as SessionBlobUpload };
}

/** Read ready image bytes for the exact session/blob owner pair without JSON coercion. */
export async function readSessionBlob(
  options: AgentServiceRequestOptions,
  sessionId: string,
  blobId: string,
): Promise<SessionBlobReadResult> {
  const url = endpoint(
    options.baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(blobId)}`,
  );
  const headers = requestHeaders(options, { Accept: "image/png, image/jpeg, image/webp, image/gif" });
  const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: options.signal });
  if (!response.ok) throw await responseError(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes };
}

/** Fetch a full offloaded tool output for the exact session/item owner pair. */
export async function readItemOutput(
  options: AgentServiceRequestOptions,
  sessionId: string,
  itemId: string,
): Promise<ItemOutputResult> {
  const url = endpoint(
    options.baseUrl,
    `/v1/sessions/${encodeURIComponent(sessionId)}/items/${encodeURIComponent(itemId)}/output`,
  );
  const headers = requestHeaders(options, { Accept: "application/json" });
  const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: options.signal });
  if (!response.ok) throw await responseError(response);
  return { response, data: await response.json() as ItemOutput };
}

function eventStream(response: Response): EventStreamResult {
  if (!response.body) throw new Error("agent-service SSE response has no body");
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    throw new Error("agent-service response is not an SSE stream");
  }
  return { response, events: parseSse<AgentServiceEvent>(response.body) };
}

/** Replay persisted events, then follow live events for one session. */
export async function subscribeSessionEvents(
  options: AgentServiceStreamOptions,
  sessionId: string,
  query?: SessionEventQuery,
): Promise<EventStreamResult> {
  const url = endpoint(options.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`);
  addEventQuery(url, query);
  const headers = requestHeaders(options, {
    Accept: "text/event-stream",
    ...(query?.lastEventId === undefined ? {} : { "Last-Event-ID": String(query.lastEventId) }),
  });
  const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: options.signal });
  if (!response.ok) throw await responseError(response);
  return eventStream(response);
}

/**
 * Start a streaming turn. A completed idempotency replay is returned as JSON; a new turn exposes an
 * async iterable of typed protocol events without buffering the response body.
 */
export async function startTurnStream(
  options: AgentServiceStreamOptions,
  sessionId: string,
  input: StartTurnInput,
  request?: { idempotencyKey?: string; exclude?: ExcludableEventType | readonly ExcludableEventType[] },
): Promise<StartTurnStreamResult> {
  const url = endpoint(options.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/turns`);
  addEventQuery(url, { exclude: request?.exclude });
  const headers = requestHeaders(options, {
    Accept: "text/event-stream, application/json",
    "Content-Type": "application/json",
    ...(request?.idempotencyKey === undefined ? {} : { "Idempotency-Key": request.idempotencyKey }),
  });
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, stream: true }),
    signal: options.signal,
  });
  if (!response.ok) throw await responseError(response);
  if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
    return { kind: "events", ...eventStream(response) };
  }
  if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { kind: "replay", response, data: await response.json() as TurnReplay };
  }
  throw new Error("agent-service turn response has an unsupported content type");
}
