import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ApiError, McpRegistryHeaders, McpRegistrationNameParams, McpRegistrationScopeQuery,
  McpRegistrationUpsertRequest, McpRegistrationStateRequest, McpRegistrationDeleteRequest,
  McpRegistrationListQuery, McpRegistrationRuntimeQuery, McpRegistrationRuntimeRequest,
  McpAuthorizationDisconnectRequest, McpOAuthCallbackQuery, McpRegistrationResponse,
  McpRegistrationListResponse, McpInstalledRegistrationResponse, McpAuthorizationBeginResponse,
  McpAuthorizationStatusResponse, ToolListResponse, PlatformMcpRegistrationUpsertRequest,
  PlatformMcpRegistrationStateRequest, PlatformMcpRegistrationDeleteRequest, PlatformMcpRegistrationListQuery,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX, INTERNAL_MCP_REGISTRY_CALLBACK_PATH,
  INTERNAL_MCP_REGISTRY_ACK_HEADER, INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE, INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE,
} from "@agent-service/protocol";
import type { RegisteredMcpService } from "@agent-service/core";
import {
  createMcpRegistryAccess, type McpRegistrationOwner, type McpRegistrationSlot,
  type McpRegistrationVersion, type McpUserAuthorization,
} from "@agent-service/store";
import { requireAdmin, requireUser, type AuthEnv } from "./auth.js";

export type McpRegistryRouteService = Pick<RegisteredMcpService,
  "upsert" | "listInstalled" | "getInstalled" | "setState" | "discover" | "refresh" |
  "beginAuthorization" | "getAuthorization" | "disconnect" | "completeAuthorization">;
export interface McpRegistryRouteDeps {
  service?: McpRegistryRouteService; enabled: boolean; maxBodyBytes: number;
  internalTokenMatches: (supplied: string | undefined) => boolean;
}
const invalid = (): never => { throw new ApiError("invalid_request", "MCP request failed."); };
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value); return result.success ? result.data : invalid();
};
const body = async (c: Context): Promise<unknown> => { try { return await c.req.json(); } catch { return invalid(); } };
/** Hono's single-value query helper would silently collapse repeated OAuth state/code fields. */
const query = (c: Context): Record<string, string> => {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(result, name)) return invalid(); result[name] = value;
  }
  return result;
};
const key = (c: Context) => parse(McpRegistryHeaders, { "idempotency-key": c.req.header("idempotency-key") })["idempotency-key"];
const privateHeaders = (c: Context): void => {
  c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer");
};
const service = (deps: McpRegistryRouteDeps): McpRegistryRouteService => {
  if (!deps.enabled || !deps.service) throw new ApiError("draining", "MCP request unavailable."); return deps.service;
};
const slotResponse = (slot: McpRegistrationSlot) => ({
  scope: slot.owner.scope, name: slot.name, revision: slot.revision, generation: slot.generation,
  state: slot.state, currentVersionId: slot.currentVersionId, createdAtMs: slot.createdAtMs, updatedAtMs: slot.updatedAtMs,
});
const versionResponse = (version: McpRegistrationVersion) => {
  const auth = version.config.authentication;
  return { configVersionId: version.configVersionId, revision: version.revision, generation: version.generation,
    createdAtMs: version.createdAtMs, config: {
      endpoint: version.config.endpoint, description: version.config.description, protocolVersion: version.config.protocolVersion,
      authentication: auth.kind === "none" ? { kind: "none" as const } : {
        kind: "oauth" as const, issuer: auth.issuer, clientId: auth.clientId,
        clientAuthentication: auth.clientAuthentication, scopes: [...auth.scopes],
      },
    } };
};
const registrationResponse = (value: { slot: McpRegistrationSlot; version: McpRegistrationVersion | null }) =>
  parse(McpRegistrationResponse, { registration: slotResponse(value.slot), version: value.version ? versionResponse(value.version) : null });
const authorizationResponse = (ref: { scope: "user" | "tenant" | "platform"; name: string }, auth: McpUserAuthorization | null) =>
  parse(McpAuthorizationStatusResponse, { ...ref, authorization: auth ? {
    state: auth.state, authorizationEpoch: auth.authorizationEpoch, tokenRevision: auth.tokenRevision, updatedAtMs: auth.updatedAtMs,
  } : null });
const toolsResponse = (tools: Awaited<ReturnType<McpRegistryRouteService["discover"]>>) => parse(ToolListResponse, { data: tools.map(tool => ({
  name: tool.name, description: tool.description, parameters: tool.parameters, kind: tool.kind,
  readOnly: tool.readOnly, needsApproval: tool.needsApproval, concurrencySafe: tool.concurrencySafe,
})) });

/** Ordinary routes require the existing v1 auth/lifecycle middleware. Callback and platform routes
 * are internal-token-only; the public router owns anonymous callback and operator admission. */
export function registerMcpRegistryRoutes(v1: Hono<AuthEnv>, app: Hono<AuthEnv>, deps: McpRegistryRouteDeps): void {
  const authority = (c: Context<AuthEnv>, scope: "user" | "tenant") => {
    let principal;
    if (scope === "user") principal = requireUser(c);
    else { requireAdmin(c); principal = { tenantId: c.get("tenantId"), userId: c.get("principal").userId || "mcp-registry-admin" }; }
    const owner: McpRegistrationOwner = { scope, tenantId: principal.tenantId, userId: scope === "user" ? principal.userId : null };
    return { owner, access: createMcpRegistryAccess({ principal, owner, authority: scope === "user" ? "user_self" : "tenant_admin", access: "manage" }) };
  };
  const names = (c: Context<AuthEnv>) => parse(McpRegistrationNameParams, c.req.param());
  v1.post("/mcp-servers", async c => {
    privateHeaders(c); const s = service(deps), input = parse(McpRegistrationUpsertRequest, await body(c)), auth = authority(c, input.scope);
    return c.json(registrationResponse(await s.upsert(auth.owner, { access: auth.access, name: input.name,
      expectedRevision: input.expectedRevision, idempotencyKey: key(c), config: input.config }, c.req.raw.signal)), 201);
  });
  v1.get("/mcp-servers", async c => {
    privateHeaders(c); const s = service(deps), q = parse(McpRegistrationListQuery, query(c)), auth = authority(c, q.scope);
    const result = await s.listInstalled(auth.owner, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json(parse(McpRegistrationListResponse, { data: result.items.map(slotResponse), nextCursor: result.nextCursor }));
  });
  v1.get("/mcp-servers/:name", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), q = parse(McpRegistrationScopeQuery, query(c)), auth = authority(c, q.scope);
    const result = await s.getInstalled(auth.owner, name, { access: auth.access }, c.req.raw.signal);
    if (!result) throw new ApiError("not_found", "MCP server not found."); return c.json(registrationResponse(result));
  });
  v1.delete("/mcp-servers/:name", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), input = parse(McpRegistrationDeleteRequest, await body(c)), auth = authority(c, input.scope);
    return c.json(parse(McpInstalledRegistrationResponse, slotResponse(await s.setState(auth.owner, name, {
      access: auth.access, state: "deleted", expectedRevision: input.expectedRevision, idempotencyKey: key(c),
    }, c.req.raw.signal))));
  });
  v1.post("/mcp-servers/:name/state", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), input = parse(McpRegistrationStateRequest, await body(c)), auth = authority(c, input.scope);
    return c.json(parse(McpInstalledRegistrationResponse, slotResponse(await s.setState(auth.owner, name, {
      access: auth.access, state: input.state, expectedRevision: input.expectedRevision, idempotencyKey: key(c),
    }, c.req.raw.signal))));
  });
  v1.get("/mcp-servers/:name/tools", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), ref = { ...parse(McpRegistrationRuntimeQuery, query(c)), name };
    return c.json(toolsResponse(await s.discover(requireUser(c), ref, c.req.raw.signal)));
  });
  v1.post("/mcp-servers/:name/refresh", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), ref = { ...parse(McpRegistrationRuntimeRequest, await body(c)), name };
    return c.json(toolsResponse(await s.refresh(requireUser(c), ref, c.req.raw.signal)));
  });
  v1.post("/mcp-servers/:name/oauth/begin", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), ref = { ...parse(McpRegistrationRuntimeRequest, await body(c)), name };
    return c.json(parse(McpAuthorizationBeginResponse, await s.beginAuthorization(requireUser(c), ref, { idempotencyKey: key(c) }, c.req.raw.signal)));
  });
  v1.get("/mcp-servers/:name/oauth/status", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), ref = { ...parse(McpRegistrationRuntimeQuery, query(c)), name };
    return c.json(authorizationResponse(ref, await s.getAuthorization(requireUser(c), ref, c.req.raw.signal)));
  });
  v1.post("/mcp-servers/:name/oauth/disconnect", async c => {
    privateHeaders(c); const s = service(deps), { name } = names(c), input = parse(McpAuthorizationDisconnectRequest, await body(c)), ref = { scope: input.scope, name };
    return c.json(authorizationResponse(ref, await s.disconnect(requireUser(c), ref, {
      expectedAuthorizationEpoch: input.expectedAuthorizationEpoch, idempotencyKey: key(c),
    }, c.req.raw.signal)));
  });

  const prefix = INTERNAL_MCP_REGISTRY_PLATFORM_PREFIX;
  const protect = (ack: string) => async (c: Context<AuthEnv>, next: () => Promise<void>) => {
    privateHeaders(c); if (!deps.internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER))) throw new ApiError("not_found", "not found");
    c.header(INTERNAL_MCP_REGISTRY_ACK_HEADER, ack); await next();
  };
  app.use(prefix, protect(INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE));
  app.use(`${prefix}/*`, protect(INTERNAL_MCP_REGISTRY_PLATFORM_ACK_VALUE));
  const bound = bodyLimit({ maxSize: Math.min(deps.maxBodyBytes, 65_536), onError: invalid });
  app.use(prefix, bound); app.use(`${prefix}/*`, bound);
  const platform = () => { const owner: McpRegistrationOwner = { scope: "platform", tenantId: null, userId: null };
    return { owner, access: createMcpRegistryAccess({ owner, principal: { tenantId: "mcp-registry-platform", userId: "operator" }, authority: "platform_operator", access: "manage" }) }; };
  app.post(prefix, async c => {
    const s = service(deps), input = parse(PlatformMcpRegistrationUpsertRequest, await body(c)), auth = platform();
    return c.json(registrationResponse(await s.upsert(auth.owner, { access: auth.access, name: input.name,
      expectedRevision: input.expectedRevision, idempotencyKey: key(c), config: input.config }, c.req.raw.signal)), 201);
  });
  app.get(prefix, async c => {
    const s = service(deps), q = parse(PlatformMcpRegistrationListQuery, query(c)), auth = platform();
    const result = await s.listInstalled(auth.owner, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json(parse(McpRegistrationListResponse, { data: result.items.map(slotResponse), nextCursor: result.nextCursor }));
  });
  app.get(`${prefix}/:name`, async c => {
    const s = service(deps), { name } = names(c), auth = platform(), result = await s.getInstalled(auth.owner, name, { access: auth.access }, c.req.raw.signal);
    if (!result) throw new ApiError("not_found", "MCP server not found."); return c.json(registrationResponse(result));
  });
  app.delete(`${prefix}/:name`, async c => {
    const s = service(deps), { name } = names(c), input = parse(PlatformMcpRegistrationDeleteRequest, await body(c)), auth = platform();
    return c.json(parse(McpInstalledRegistrationResponse, slotResponse(await s.setState(auth.owner, name, { access: auth.access,
      state: "deleted", expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal))));
  });
  app.post(`${prefix}/:name/state`, async c => {
    const s = service(deps), { name } = names(c), input = parse(PlatformMcpRegistrationStateRequest, await body(c)), auth = platform();
    return c.json(parse(McpInstalledRegistrationResponse, slotResponse(await s.setState(auth.owner, name, { access: auth.access,
      state: input.state, expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal))));
  });
  app.all(prefix, () => { throw new ApiError("not_found", "not found"); });
  app.all(`${prefix}/*`, () => { throw new ApiError("not_found", "not found"); });

  const callback = INTERNAL_MCP_REGISTRY_CALLBACK_PATH;
  app.use(callback, protect(INTERNAL_MCP_REGISTRY_CALLBACK_ACK_VALUE));
  app.get(callback, async c => {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    let connected = false;
    try {
      const input = parse(McpOAuthCallbackQuery, query(c));
      connected = (await service(deps).completeAuthorization({ state: input.state, code: input.code, error: input.error, iss: input.iss }, c.req.raw.signal)).status === "connected";
    } catch { /* A static outcome never reflects upstream errors, state, code or caller headers. */ }
    return c.html(connected ? "<!doctype html><title>MCP authorization</title><p>Authorization completed. You can close this page.</p>" :
      "<!doctype html><title>MCP authorization</title><p>Authorization was not completed. Start authorization again from the application.</p>", connected ? 200 : 400);
  });
  app.all(callback, () => { throw new ApiError("not_found", "not found"); });
}
