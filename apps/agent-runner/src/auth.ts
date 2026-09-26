import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { ApiError, DEFAULT_AUTH_POLICY, type ApiKeyScope, type Principal, type TenantAuthPolicy } from "@agent-service/protocol";
import type { SessionStore, TenantRecord } from "@agent-service/store";
import { buildVerifier, type EndUserVerifier } from "./end-user-auth.js";

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const generateApiKey = () => `ask_${randomBytes(24).toString("base64url")}`;

export interface AuthContext {
  principal: Principal;
  tenantId: string;
  apiKeyId: string;
  scopes: ApiKeyScope[];
  authMode: TenantAuthPolicy["mode"];
  /** true when the end user was proven, not merely asserted by the caller */
  userVerified: boolean;
}

/** End-user ids end up in log lines, Redis keys and SQL; keep them to an unambiguous charset. */
const USER_ID_RE = /^[A-Za-z0-9._:@|-]{1,128}$/;

/** Tokens are verified by a library; cap the size before handing anything to it. */
const MAX_TOKEN_BYTES = 8 * 1024;

export type AuthEnv = { Variables: AuthContext & { tokenMissing?: boolean; authBroken?: string } };

/** Routes that repair tenant configuration must stay reachable even when the policy is broken. */
const isTenantConfigRoute = (path: string) => path === "/v1/tenant/auth";

export interface AuthDeps {
  store: SessionStore;
  /** decrypts the tenant's stored auth secret (HS256 key / introspection credential) */
  decryptSecret: (secret: { ciphertext: Buffer; keyId: string }) => Promise<string>;
  cache?: TenantPolicyCache;
  fetchImpl?: typeof fetch;
}

/**
 * Caches each tenant's auth policy (and the verifier built from it) because it is consulted on every
 * single request. A write invalidates the entry on THIS runner immediately; other runners converge
 * within the TTL, so keep the TTL short enough that tightening a policy is not left stale for long.
 */
export class TenantPolicyCache {
  private readonly entries = new Map<string, { record: TenantRecord; expiresAtMs: number }>();
  /**
   * Verifiers are cached separately, keyed by their configuration, and survive a policy re-read. A
   * verifier owns state worth keeping — the JWKS key set and the introspection result cache — so
   * rebuilding one every TTL would refetch keys and throw away every cached introspection.
   */
  private readonly verifiers = new Map<string, EndUserVerifier>();
  constructor(readonly ttlMs = 10_000) {}

  async get(
    tenantId: string,
    load: (tenantId: string) => Promise<TenantRecord>,
    makeVerifier: (record: TenantRecord) => Promise<EndUserVerifier>,
  ): Promise<{ record: TenantRecord; verifier?: EndUserVerifier }> {
    const hit = this.entries.get(tenantId);
    const record = hit && hit.expiresAtMs > Date.now() ? hit.record : await load(tenantId);
    if (!hit || hit.expiresAtMs <= Date.now()) this.entries.set(tenantId, { record, expiresAtMs: Date.now() + this.ttlMs });
    if (record.authPolicy.mode !== "end_user_token") return { record };

    const key = `${tenantId}:${createHash("sha256").update(JSON.stringify(record.authPolicy) + (record.authSecret?.ciphertext.toString("base64") ?? "")).digest("hex")}`;
    let verifier = this.verifiers.get(key);
    if (!verifier) {
      verifier = await makeVerifier(record);
      // a config change produces a new key; drop the tenant's stale entries so nothing lingers
      for (const k of this.verifiers.keys()) if (k.startsWith(`${tenantId}:`)) this.verifiers.delete(k);
      this.verifiers.set(key, verifier);
    }
    return { record, verifier };
  }

  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
    for (const k of this.verifiers.keys()) if (k.startsWith(`${tenantId}:`)) this.verifiers.delete(k);
  }
}

/**
 * Two layers, and they answer different questions:
 *
 *  1. WHO IS CALLING — `Authorization: Bearer <service api key>` resolves to a tenant. Always required.
 *  2. WHO IS THE USER — depends on the tenant's policy:
 *     - `trusted_caller`: taken from `X-User-Id`. Sound only while the service key stays on the tenant's
 *       own backend, because holding the key means being able to act as any of that tenant's users.
 *     - `end_user_token`: taken from a token this service verifies itself. `X-User-Id`, if sent, must
 *       agree with the verified subject; it is never the source of truth.
 */
export function authMiddleware(deps: AuthDeps): MiddlewareHandler<AuthEnv> {
  const cache = deps.cache ?? new TenantPolicyCache();
  const load = async (tenantId: string): Promise<TenantRecord> =>
    (await deps.store.getTenant(tenantId)) ?? { tenantId, authPolicy: DEFAULT_AUTH_POLICY, createdAtMs: 0 };
  const makeVerifier = async (record: TenantRecord) => {
    const policy = record.authPolicy as Extract<TenantAuthPolicy, { mode: "end_user_token" }>;
    const secret = record.authSecret ? await deps.decryptSecret(record.authSecret) : undefined;
    return buildVerifier(policy, secret, deps.fetchImpl);
  };

  return async (c, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m) throw new ApiError("unauthorized", "missing service api key (Authorization: Bearer ...)");
    const rec = await deps.store.resolveApiKey(hashApiKey(m[1]!.trim()));
    if (!rec) throw new ApiError("unauthorized", "invalid api key");

    let record: TenantRecord;
    let verifier: EndUserVerifier | undefined;
    try {
      ({ record, verifier } = await cache.get(rec.tenantId, load, makeVerifier));
    } catch (err) {
      // A broken policy (e.g. hs256 with no secret) must not take the whole tenant down: the admin
      // routes still have to work so it can be repaired. Everything else is refused.
      if (isTenantConfigRoute(c.req.path)) {
        record = { tenantId: rec.tenantId, authPolicy: DEFAULT_AUTH_POLICY, createdAtMs: 0 };
        c.set("authBroken", err instanceof Error ? err.message : String(err));
      } else {
        throw new ApiError("unauthorized", `this tenant's end-user auth policy is unusable: ${err instanceof Error ? err.message : err}`);
      }
    }

    const asserted = c.req.header("x-user-id")?.trim() || "";
    if (asserted && !USER_ID_RE.test(asserted)) throw new ApiError("invalid_request", "X-User-Id must match [A-Za-z0-9._:@|-]{1,128}");
    let userId = "";
    let userVerified = false;

    if (record.authPolicy.mode === "end_user_token" && verifier) {
      const token = c.req.header(record.authPolicy.tokenHeader)?.trim();
      if (token) {
        if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new ApiError("unauthorized", "end-user token is too large");
        const verified = await verifier.verify(token);
        if (!USER_ID_RE.test(verified.userId)) throw new ApiError("unauthorized", "the verified end-user id has an unacceptable shape");
        if (asserted && asserted !== verified.userId) throw new ApiError("forbidden", "X-User-Id does not match the verified end-user token");
        userId = verified.userId;
        userVerified = true;
      } else {
        // No token at all. Previously this fell through to "no user", which silently granted
        // tenant-wide scope on every session route. Session routes now require an identity, and this
        // tenant has declared that an identity must be proven.
        c.set("tokenMissing", true);
      }
    } else {
      userId = asserted;
    }

    c.set("tenantId", rec.tenantId);
    c.set("apiKeyId", rec.keyId);
    c.set("scopes", rec.scopes);
    c.set("authMode", record.authPolicy.mode);
    c.set("userVerified", userVerified);
    c.set("principal", { tenantId: rec.tenantId, userId });
    await next();
  };
}

type Ctx = { get: (k: string) => unknown };

/**
 * Every session-scoped route needs a user identity — reads included. Without this, a request carrying
 * only a service key would be treated as "no user", and the tenant-scoped code path would hand it any
 * session in the tenant.
 */
export function requireUser(c: Ctx): Principal {
  const principal = c.get("principal") as Principal;
  if (principal.userId) return principal;
  if (c.get("tokenMissing") || c.get("authMode") === "end_user_token") {
    throw new ApiError("unauthorized", "this tenant requires a verified end-user token for this route");
  }
  throw new ApiError("invalid_request", "X-User-Id header is required");
}

/** Tenant configuration changes need an admin-scoped key. */
export function requireAdmin(c: Ctx): void {
  const scopes = (c.get("scopes") as ApiKeyScope[] | undefined) ?? [];
  if (!scopes.includes("admin")) {
    throw new ApiError("forbidden", "this endpoint needs an api key with the \"admin\" scope");
  }
}

/**
 * Acting for a *different* user than the authenticated one. Allowed only for a trusted caller, which by
 * definition already speaks for all of its users; with a verified token the subject is the only identity.
 */
export function assertMayActAs(c: Ctx, targetUserId: string | undefined): void {
  if (!targetUserId) return;
  const principal = c.get("principal") as Principal;
  if (targetUserId === principal.userId) return;
  if (c.get("userVerified")) throw new ApiError("forbidden", "cannot create a session for another user when the end user is authenticated by token");
}
