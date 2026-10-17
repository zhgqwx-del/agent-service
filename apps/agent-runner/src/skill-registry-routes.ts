import type { Hono, Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  ApiError, SkillInstallRequest, SkillDeleteRequest, SkillListQuery, SkillVersionsQuery,
  SkillScopeQuery, SkillNameParams, SkillVersionParams, SkillRegistryHeaders,
  PlatformSkillInstallRequest, PlatformSkillDeleteRequest, PlatformSkillListQuery, PlatformSkillVersionsQuery,
  SkillExportQuery, SkillExportResponse,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX,
  INTERNAL_SKILL_REGISTRY_ACK_HEADER, INTERNAL_SKILL_REGISTRY_ACK_VALUE,
} from "@agent-service/protocol";
import type { RegisteredSkillService } from "@agent-service/core";
import { createSkillRegistryAccess, type SkillOwner, type SkillSlot, type SkillVersion } from "@agent-service/store";
import { requireAdmin, requireUser, type AuthEnv } from "./auth.js";

type Service = Pick<RegisteredSkillService, "install" | "listInstalled" | "getInstalled" | "listVersions" | "readVersion" | "deleteInstalled" | "exportInstalled">;
interface Deps { service?: Service; enabled: boolean; maxBodyBytes: number; internalTokenMatches: (supplied: string | undefined) => boolean }
const invalid = (): never => { throw new ApiError("invalid_request", "Skill request failed."); };
const parse = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) return invalid(); return result.data;
};
const slotResponse = (slot: SkillSlot) => ({ scope: slot.owner.scope, name: slot.name, revision: slot.revision,
  generation: slot.generation, state: slot.state, currentVersionId: slot.currentVersionId,
  createdAtMs: slot.createdAtMs, updatedAtMs: slot.updatedAtMs });
const versionResponse = (version: SkillVersion) => ({ scope: version.owner.scope, name: version.name,
  versionId: version.versionId, versionSha256: version.versionSha256, revision: version.revision,
  generation: version.generation, metadata: version.metadata, sha256: version.sha256,
  sizeBytes: version.sizeBytes, createdAtMs: version.createdAtMs });
const privateHeaders = (c: Context) => { c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); };
const body = async (c: Context) => { try { return await c.req.json(); } catch { return invalid(); } };
const key = (c: Context) => parse(SkillRegistryHeaders, { "idempotency-key": c.req.header("idempotency-key") })["idempotency-key"];
const service = (deps: Deps): Service => { if (!deps.enabled || !deps.service) throw new ApiError("draining", "Skill request unavailable."); return deps.service; };

export function registerSkillRegistryRoutes(v1: Hono<AuthEnv>, app: Hono<AuthEnv>, deps: Deps): void {
  const authority = (c: Context<AuthEnv>, scope: "user" | "tenant", manage: boolean) => {
    let principal;
    if (scope === "user") principal = requireUser(c);
    else { requireAdmin(c); principal = { tenantId: c.get("tenantId"), userId: c.get("principal").userId || "skill-registry-admin" }; }
    const owner: SkillOwner = { scope, tenantId: principal.tenantId, userId: scope === "user" ? principal.userId : null };
    return { owner, access: createSkillRegistryAccess({ principal, owner, authority: scope === "user" ? "user_self" : "tenant_admin", access: manage ? "manage" : "read" }) };
  };
  // These handlers run behind the existing v1 authentication and lifecycle middleware.
  v1.get("/skills/export", async c => {
    privateHeaders(c); const s = service(deps), principal = requireUser(c), q = parse(SkillExportQuery, c.req.query());
    const owner: SkillOwner = { scope: "user", tenantId: principal.tenantId, userId: principal.userId };
    const access = createSkillRegistryAccess({ owner, principal, authority: "user_self", access: "read" });
    return c.json(parse(SkillExportResponse, await s.exportInstalled(owner, { access, ...q }, c.req.raw.signal)));
  });
  v1.post("/skills", async c => {
    privateHeaders(c); const s = service(deps), input = parse(SkillInstallRequest, await body(c));
    const auth = authority(c, input.scope, true);
    const version = await s.install(auth.owner, { access: auth.access, document: new TextEncoder().encode(input.document),
      expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal);
    return c.json(versionResponse(version), 201);
  });
  v1.get("/skills", async c => {
    privateHeaders(c); const s = service(deps), q = parse(SkillListQuery, c.req.query()), auth = authority(c, q.scope, false);
    const result = await s.listInstalled(auth.owner, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json({ data: result.items.map(slotResponse), nextCursor: result.nextCursor });
  });
  v1.get("/skills/:name", async c => {
    privateHeaders(c); const s = service(deps), { name } = parse(SkillNameParams, c.req.param());
    const q = parse(SkillScopeQuery, c.req.query()), auth = authority(c, q.scope, false);
    const result = await s.getInstalled(auth.owner, name, { access: auth.access }, c.req.raw.signal);
    if (!result) throw new ApiError("not_found", "Skill not found."); return c.json(slotResponse(result));
  });
  v1.get("/skills/:name/versions", async c => {
    privateHeaders(c); const s = service(deps), { name } = parse(SkillNameParams, c.req.param());
    const q = parse(SkillVersionsQuery, c.req.query()), auth = authority(c, q.scope, false);
    const result = await s.listVersions(auth.owner, name, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json({ data: result.items.map(versionResponse), nextCursor: result.nextCursor });
  });
  v1.get("/skills/:name/versions/:versionId", async c => {
    privateHeaders(c); const s = service(deps), p = parse(SkillVersionParams, c.req.param());
    const q = parse(SkillScopeQuery, c.req.query()), auth = authority(c, q.scope, false);
    const result = await s.readVersion(auth.owner, p.name, p.versionId, { access: auth.access }, c.req.raw.signal);
    return c.json({ version: versionResponse(result.version), document: result.document });
  });
  v1.delete("/skills/:name", async c => {
    privateHeaders(c); const s = service(deps), { name } = parse(SkillNameParams, c.req.param());
    const input = parse(SkillDeleteRequest, await body(c)), auth = authority(c, input.scope, true);
    return c.json(slotResponse(await s.deleteInstalled(auth.owner, name, { access: auth.access,
      expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal)));
  });
  // The router consumes the dedicated platform bearer; only this versioned internal path can mint
  // platform access. Neither tenant API keys nor tenant-erasure credentials enter this branch.
  const prefix = INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX;
  app.use(prefix, async (c, next) => { privateHeaders(c);
    if (!deps.internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER))) throw new ApiError("not_found", "not found");
    c.header(INTERNAL_SKILL_REGISTRY_ACK_HEADER, INTERNAL_SKILL_REGISTRY_ACK_VALUE); await next(); });
  app.use(`${prefix}/*`, async (c, next) => { privateHeaders(c);
    if (!deps.internalTokenMatches(c.req.header(INTERNAL_ROUTER_TOKEN_HEADER))) throw new ApiError("not_found", "not found");
    c.header(INTERNAL_SKILL_REGISTRY_ACK_HEADER, INTERNAL_SKILL_REGISTRY_ACK_VALUE); await next(); });
  const bound = bodyLimit({ maxSize: Math.min(deps.maxBodyBytes, 400_000), onError: invalid });
  app.use(prefix, bound); app.use(`${prefix}/*`, bound);
  const platform = (manage: boolean) => { const owner: SkillOwner = { scope: "platform", tenantId: null, userId: null };
    return { owner, access: createSkillRegistryAccess({ owner, principal: { tenantId: "skill-registry-platform", userId: "operator" }, authority: "platform_operator", access: manage ? "manage" : "read" }) }; };
  app.post(prefix, async c => { const s = service(deps), input = parse(PlatformSkillInstallRequest, await body(c)), auth = platform(true);
    const result = await s.install(auth.owner, { access: auth.access, document: new TextEncoder().encode(input.document), expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal);
    return c.json(versionResponse(result), 201); });
  app.get(prefix, async c => { const s = service(deps), q = parse(PlatformSkillListQuery, c.req.query()), auth = platform(false);
    const result = await s.listInstalled(auth.owner, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json({ data: result.items.map(slotResponse), nextCursor: result.nextCursor }); });
  app.get(`${prefix}/:name`, async c => { const s = service(deps), { name } = parse(SkillNameParams, c.req.param()), auth = platform(false);
    const result = await s.getInstalled(auth.owner, name, { access: auth.access }, c.req.raw.signal);
    if (!result) throw new ApiError("not_found", "Skill not found."); return c.json(slotResponse(result)); });
  app.get(`${prefix}/:name/versions`, async c => { const s = service(deps), { name } = parse(SkillNameParams, c.req.param());
    const q = parse(PlatformSkillVersionsQuery, c.req.query()), auth = platform(false);
    const result = await s.listVersions(auth.owner, name, { access: auth.access, cursor: q.cursor, limit: q.limit }, c.req.raw.signal);
    return c.json({ data: result.items.map(versionResponse), nextCursor: result.nextCursor }); });
  app.get(`${prefix}/:name/versions/:versionId`, async c => { const s = service(deps), p = parse(SkillVersionParams, c.req.param()), auth = platform(false);
    const result = await s.readVersion(auth.owner, p.name, p.versionId, { access: auth.access }, c.req.raw.signal);
    return c.json({ version: versionResponse(result.version), document: result.document }); });
  app.delete(`${prefix}/:name`, async c => { const s = service(deps), { name } = parse(SkillNameParams, c.req.param());
    const input = parse(PlatformSkillDeleteRequest, await body(c)), auth = platform(true);
    return c.json(slotResponse(await s.deleteInstalled(auth.owner, name, { access: auth.access, expectedRevision: input.expectedRevision, idempotencyKey: key(c) }, c.req.raw.signal))); });
  app.all(prefix, () => { throw new ApiError("not_found", "not found"); });
  app.all(`${prefix}/*`, () => { throw new ApiError("not_found", "not found"); });
}
