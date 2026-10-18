import type { Context, Hono } from "hono";
import {
  ApiError, TenantHookHeaders, TenantHookNameParams, TenantHookEmptyQuery, TenantHookListQuery,
  TenantHookUpsertRequest, TenantHookStateRequest, TenantHookDeleteRequest,
  InstalledTenantHookResponse, TenantHookResponse, TenantHookListResponse, TenantHookDeliveriesResponse,
} from "@agent-service/protocol";
import type { RegisteredTenantWebhookService } from "@agent-service/core";
import { createTenantWebhookAdminAccess, type TenantWebhookSlot, type TenantWebhookRegistration } from "@agent-service/store";
import { requireAdmin, type AuthEnv } from "./auth.js";

export type TenantHooksRouteService = Pick<RegisteredTenantWebhookService, "upsert" | "list" | "get" | "setState" | "listDeliveries">;
export interface TenantHooksRouteDeps { readonly enabled: boolean; readonly service?: TenantHooksRouteService }
const invalid = (): never => { throw new ApiError("invalid_request", "Tenant webhook request failed."); };
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : invalid();
};
const body = async (c: Context): Promise<unknown> => { try { return await c.req.json(); } catch { return invalid(); } };
const query = (c: Context): Record<string, string> => {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(result, key)) return invalid(); result[key] = value;
  }
  return result;
};
const slotResponse = (slot: TenantWebhookSlot) => parse(InstalledTenantHookResponse, {
  name: slot.name, revision: slot.revision, generation: slot.generation, state: slot.state,
  currentVersionId: slot.currentVersionId, createdAtMs: slot.createdAtMs, updatedAtMs: slot.updatedAtMs,
});
const response = ({ slot, version }: TenantWebhookRegistration) => parse(TenantHookResponse, {
  registration: slotResponse(slot), version: version ? {
    configVersionId: version.configVersionId, revision: version.revision, generation: version.generation,
    config: { endpoint: version.config.endpoint, phase: version.config.phase, bodyScopes: [...version.config.bodyScopes] },
    createdAtMs: version.createdAtMs,
  } : null,
});

/** All management and delivery status require a real admin key, never an asserted X-User-Id. */
export function registerTenantHooksRoutes(v1: Hono<AuthEnv>, deps: TenantHooksRouteDeps): void {
  const authority = (c: Context<AuthEnv>) => {
    c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    requireAdmin(c);
    if (!deps.enabled || !deps.service) throw new ApiError("draining", "Tenant webhook request unavailable.");
    const tenantId = c.get("tenantId"), apiKeyId = c.get("apiKeyId");
    return { service: deps.service, tenantId, access: createTenantWebhookAdminAccess({ tenantId, apiKeyId }) };
  };
  const name = (c: Context<AuthEnv>) => parse(TenantHookNameParams, c.req.param()).name;
  const key = (c: Context) => parse(TenantHookHeaders, { "idempotency-key": c.req.header("idempotency-key") })["idempotency-key"];
  v1.post("/tenant-hooks", async c => {
    const auth = authority(c); parse(TenantHookEmptyQuery, query(c));
    const input = parse(TenantHookUpsertRequest, await body(c));
    return c.json(response(await auth.service.upsert(auth.tenantId, {
      access: auth.access, name: input.name, expectedRevision: input.expectedRevision, idempotencyKey: key(c),
      config: input.config, signingKey: input.signingKey, disclosureAck: input.disclosureAck,
    }, c.req.raw.signal)), 201);
  });
  v1.get("/tenant-hooks", async c => {
    const auth = authority(c), q = parse(TenantHookListQuery, query(c));
    const result = await auth.service.list(auth.tenantId, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json(parse(TenantHookListResponse, { data: result.items.map(response), nextCursor: result.nextCursor }));
  });
  v1.get("/tenant-hooks/:name", async c => {
    const auth = authority(c); parse(TenantHookEmptyQuery, query(c));
    const result = await auth.service.get(auth.tenantId, name(c), { access: auth.access }, c.req.raw.signal);
    if (!result) throw new ApiError("not_found", "Tenant webhook not found."); return c.json(response(result));
  });
  v1.delete("/tenant-hooks/:name", async c => {
    const auth = authority(c); parse(TenantHookEmptyQuery, query(c)); const input = parse(TenantHookDeleteRequest, await body(c));
    return c.json(slotResponse(await auth.service.setState(auth.tenantId, name(c), { access: auth.access,
      state: "deleted", expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal)));
  });
  v1.post("/tenant-hooks/:name/state", async c => {
    const auth = authority(c); parse(TenantHookEmptyQuery, query(c)); const input = parse(TenantHookStateRequest, await body(c));
    return c.json(slotResponse(await auth.service.setState(auth.tenantId, name(c), { access: auth.access,
      state: input.state, expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal)));
  });
  v1.get("/tenant-hooks/:name/deliveries", async c => {
    const auth = authority(c), q = parse(TenantHookListQuery, query(c));
    const result = await auth.service.listDeliveries(auth.tenantId, name(c), { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json(parse(TenantHookDeliveriesResponse, { data: result.items.map(item => ({
      intentId: item.intentId, configVersionId: item.configVersionId, phase: item.phase, state: item.state,
      createdAtMs: item.createdAtMs, completedAtMs: item.completedAtMs,
    })), nextCursor: result.nextCursor }));
  });
}
