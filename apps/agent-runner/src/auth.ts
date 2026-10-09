import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { ApiError, DEFAULT_AUTH_POLICY, UserId, type ApiKeyScope, type Principal, type TenantAuthPolicy } from "@agent-service/protocol";
import { SubjectDeletingError, type SessionStore, type TenantRecord } from "@agent-service/store";
import type { TenantRuntimeCoordinator, TenantRuntimeDrainIdentity, TenantRuntimeLease, TenantRuntimeParticipant } from "@agent-service/core";
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
  /** Shared runner-local T3b fence. Wiring is optional until the T3b worker is enabled. */
  tenantRuntime?: TenantRuntimeCoordinator;
}

/**
 * Caches each tenant's auth policy (and the verifier built from it) because it is consulted on every
 * single request. A write invalidates the entry on THIS runner immediately; other runners converge
 * within the TTL, so keep the TTL short enough that tightening a policy is not left stale for long.
 */
export class TenantPolicyCache implements TenantRuntimeParticipant {
  readonly name = "tenant-auth-policy-cache";
  private readonly entries = new Map<string, { record: TenantRecord; expiresAtMs: number }>();
  /**
   * Verifiers are cached separately, keyed by their configuration, and survive a policy re-read. A
   * verifier owns state worth keeping — the JWKS key set and the introspection result cache — so
   * rebuilding one every TTL would refetch keys and throw away every cached introspection.
   */
  private readonly verifiers = new Map<string, { tenantId: string; verifier: EndUserVerifier }>();
  private readonly building = new Map<string, Promise<EndUserVerifier>>();
  private readonly epochs = new Map<string, number>();
  private readonly fenced = new Set<string>();
  private readonly attached = new Set<TenantRuntimeCoordinator>();
  private runtime?: TenantRuntimeCoordinator;

  constructor(readonly ttlMs = 10_000, runtime?: TenantRuntimeCoordinator) {
    if (runtime) this.attachRuntime(runtime);
  }

  attachRuntime(runtime: TenantRuntimeCoordinator): void {
    if (this.attached.has(runtime)) return;
    if (this.runtime && this.runtime !== runtime) throw new Error("a tenant policy cache can only belong to one runtime coordinator");
    runtime.registerParticipant(this);
    this.runtime = runtime;
    this.attached.add(runtime);
  }

  async get(
    tenantId: string,
    load: (tenantId: string) => Promise<TenantRecord>,
    makeVerifier: (record: TenantRecord) => Promise<EndUserVerifier>,
  ): Promise<{ record: TenantRecord; verifier?: EndUserVerifier }> {
    this.assertOpen(tenantId);
    const epoch = this.epochs.get(tenantId) ?? 0;
    const hit = this.entries.get(tenantId);
    const record = hit && hit.expiresAtMs > Date.now() ? hit.record : await load(tenantId);
    this.assertEpoch(tenantId, epoch);
    if (!hit || hit.expiresAtMs <= Date.now()) this.entries.set(tenantId, { record, expiresAtMs: Date.now() + this.ttlMs });
    if (record.authPolicy.mode !== "end_user_token") return { record };

    const key = `${tenantId}:${createHash("sha256").update(JSON.stringify(record.authPolicy) + (record.authSecret?.ciphertext.toString("base64") ?? "")).digest("hex")}`;
    let verifier = this.verifiers.get(key)?.verifier;
    if (!verifier) {
      let pending = this.building.get(key);
      if (!pending) {
        const buildLease = this.runtime?.enter(tenantId, "auth");
        pending = makeVerifier(record).then((built) => {
          try {
            buildLease?.assertOpen();
            this.assertEpoch(tenantId, epoch);
            return built;
          } catch (error) {
            built.dispose();
            throw error;
          }
        }).finally(() => buildLease?.release());
        this.building.set(key, pending);
        void pending.finally(() => {
          if (this.building.get(key) === pending) this.building.delete(key);
        }).catch(() => {});
      }
      verifier = await pending;
      try {
        this.assertEpoch(tenantId, epoch);
      } catch (error) {
        verifier.dispose();
        throw error;
      }
      // a config change produces a new key; drop the tenant's stale entries so nothing lingers
      for (const [k, owned] of this.verifiers) {
        if (owned.tenantId !== tenantId || k === key) continue;
        owned.verifier.dispose();
        this.verifiers.delete(k);
      }
      this.verifiers.set(key, { tenantId, verifier });
    }
    return { record, verifier };
  }

  invalidate(tenantId: string): void {
    this.bumpEpoch(tenantId);
    this.entries.delete(tenantId);
    for (const [key, owned] of this.verifiers) {
      if (owned.tenantId !== tenantId) continue;
      owned.verifier.dispose();
      this.verifiers.delete(key);
    }
  }

  snapshotTenant(tenantId: string) {
    let authVerifiers = 0;
    for (const owned of this.verifiers.values()) if (owned.tenantId === tenantId) authVerifiers += 1;
    return { policyEntries: this.entries.has(tenantId) ? 1 : 0, authVerifiers };
  }

  fenceTenant(identity: TenantRuntimeDrainIdentity): void {
    this.fenced.add(identity.tenantId);
    this.bumpEpoch(identity.tenantId);
    for (const owned of this.verifiers.values()) {
      if (owned.tenantId === identity.tenantId) owned.verifier.dispose();
    }
  }

  purgeTenant(identity: TenantRuntimeDrainIdentity): void {
    this.entries.delete(identity.tenantId);
    for (const [key, owned] of this.verifiers) {
      if (owned.tenantId !== identity.tenantId) continue;
      owned.verifier.dispose();
      this.verifiers.delete(key);
    }
  }

  private assertOpen(tenantId: string): void {
    if (this.fenced.has(tenantId)) throw new SubjectDeletingError(tenantId);
  }

  private assertEpoch(tenantId: string, epoch: number): void {
    this.assertOpen(tenantId);
    if ((this.epochs.get(tenantId) ?? 0) !== epoch) throw new SubjectDeletingError(tenantId);
  }

  private bumpEpoch(tenantId: string): void {
    this.epochs.set(tenantId, (this.epochs.get(tenantId) ?? 0) + 1);
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
  const cache = deps.cache ?? new TenantPolicyCache(10_000, deps.tenantRuntime);
  if (deps.tenantRuntime) cache.attachRuntime(deps.tenantRuntime);
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
    // API-key resolution itself is durable-store work covered by T3a. Once it returns a tenant, T3b
    // must either account this request as active or reject it if the local fence won the race.
    const runtimeLease = deps.tenantRuntime?.enter(rec.tenantId, "auth");
    let responseOwnsLease = false;
    try {
      const tenantConfigRoute = isTenantConfigRoute(c.req.path);

      let record: TenantRecord;
      let verifier: EndUserVerifier | undefined;
      try {
        ({ record, verifier } = await cache.get(rec.tenantId, load, makeVerifier));
      } catch (err) {
        // A broken policy (e.g. hs256 with no secret) must not take the whole tenant down: the admin
        // routes still have to work so it can be repaired. Everything else is refused. A runtime
        // fence is never recoverable through this exception path.
        if (err instanceof SubjectDeletingError) throw err;
        if (tenantConfigRoute) {
          record = { tenantId: rec.tenantId, authPolicy: DEFAULT_AUTH_POLICY, createdAtMs: 0 };
          c.set("authBroken", err instanceof Error ? err.message : String(err));
        } else {
          throw new ApiError("unauthorized", `this tenant's end-user auth policy is unusable: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Tenant-auth administration is the recovery path for every historical or malformed policy. Once
      // the service key has resolved the tenant, do not let that policy interpret ambient request headers
      // as an end-user token and lock an administrator out. The route handler still requires admin scope.
      const asserted = tenantConfigRoute ? "" : c.req.header("x-user-id")?.trim() || "";
      if (asserted && !UserId.safeParse(asserted).success) throw new ApiError("invalid_request", "X-User-Id must match [A-Za-z0-9._:@|-]{1,128}");
      let userId = "";
      let userVerified = false;

      if (!tenantConfigRoute && record.authPolicy.mode === "end_user_token" && verifier) {
        const token = c.req.header(record.authPolicy.tokenHeader)?.trim();
        if (token) {
          if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw new ApiError("unauthorized", "end-user token is too large");
          const verified = await verifier.verify(token, runtimeLease?.signal);
          runtimeLease?.assertOpen();
          if (!UserId.safeParse(verified.userId).success) throw new ApiError("unauthorized", "the verified end-user id has an unacceptable shape");
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

      runtimeLease?.assertOpen();
      c.set("tenantId", rec.tenantId);
      c.set("apiKeyId", rec.keyId);
      c.set("scopes", rec.scopes);
      c.set("authMode", record.authPolicy.mode);
      c.set("userVerified", userVerified);
      c.set("principal", { tenantId: rec.tenantId, userId });
      await next();
      if (runtimeLease && c.res.body) {
        c.res = responseWithRuntimeLease(c.res, runtimeLease);
        responseOwnsLease = true;
      }
    } finally {
      if (!responseOwnsLease) runtimeLease?.release();
    }
  };
}

/** Keep an authenticated streaming request active until its response body is consumed or cancelled. */
function responseWithRuntimeLease(response: Response, lease: TenantRuntimeLease): Response {
  const reader = response.body!.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    lease.signal.removeEventListener("abort", onAbort);
    lease.release();
  };
  const onAbort = () => {
    void reader.cancel(lease.signal.reason).catch(() => {}).finally(settle);
  };
  lease.signal.addEventListener("abort", onAbort, { once: true });
  if (lease.signal.aborted) onAbort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          settle();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        settle();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
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
