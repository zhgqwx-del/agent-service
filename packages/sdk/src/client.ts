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

export type AgentServiceEvent = components["schemas"]["Event"];
export type ExcludableEventType = components["schemas"]["ExcludableEventType"];
export type StartTurnInput = components["schemas"]["StartTurnRequest"];
export type TurnReplay = components["schemas"]["TurnReplayResponse"];
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

export interface AgentServiceStreamOptions extends AgentServiceAuth {
  baseUrl: string;
  headers?: HeaderInput;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

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

export type StartTurnStreamResult =
  | ({ kind: "events" } & EventStreamResult)
  | { kind: "replay"; response: Response; data: TurnReplay };

/** HTTP failures from the streaming helpers. The response body is retained as parsed JSON/text. */
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

function requestHeaders(options: AgentServiceStreamOptions, extra?: HeaderInput): Headers {
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
