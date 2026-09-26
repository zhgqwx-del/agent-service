import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ApiError, type IntrospectionVerifier, type JwtVerifier, type TenantAuthPolicy } from "@agent-service/protocol";

/**
 * Verifies an END USER's own token so the runner derives the user id from something it checked, rather
 * than from a header the caller asserted.
 *
 * This lives in the runner, not the router, deliberately: the runner is the only component that owns
 * session data, so it must not trust an identity stamped upstream. Anything the router forwards travels
 * over the internal network and is exactly as forgeable as the original header.
 */

export interface VerifiedUser {
  userId: string;
  /** claims/fields worth logging for audit; never the raw token */
  claims?: Record<string, unknown>;
  expiresAtMs?: number;
}

export interface EndUserVerifier {
  verify(token: string): Promise<VerifiedUser>;
}

export class JwtEndUserVerifier implements EndUserVerifier {
  private jwks?: JWTVerifyGetKey;
  private readonly secretKey?: Uint8Array;

  constructor(
    private readonly cfg: JwtVerifier,
    secret?: string,
  ) {
    if (cfg.jwksUri) {
      this.jwks = createRemoteJWKSet(new URL(cfg.jwksUri), { cacheMaxAge: 10 * 60_000, timeoutDuration: 3_000 });
    } else if (cfg.hs256) {
      if (!secret) throw new Error("jwt verifier with hs256 needs the tenant's stored secret");
      this.secretKey = new TextEncoder().encode(secret);
    } else {
      throw new Error("jwt verifier needs either jwksUri or hs256 with a stored secret");
    }
  }

  async verify(token: string): Promise<VerifiedUser> {
    let payload: JWTPayload;
    try {
      const result = this.jwks
        ? await jwtVerify(token, this.jwks, this.options())
        : await jwtVerify(token, this.secretKey!, this.options());
      payload = result.payload;
    } catch (err) {
      // never echo the token or the library's internal details back to the caller
      throw new ApiError("unauthorized", `end-user token rejected: ${reason(err)}`);
    }
    const raw = payload[this.cfg.subjectClaim];
    const userId = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!userId) throw new ApiError("unauthorized", `end-user token has no usable "${this.cfg.subjectClaim}" claim`);
    if (userId.length > 128) throw new ApiError("unauthorized", "end-user id is too long");
    return {
      userId,
      expiresAtMs: payload.exp ? payload.exp * 1000 : undefined,
      claims: { iss: payload.iss, aud: payload.aud, exp: payload.exp },
    };
  }

  private options() {
    return {
      // Pinning the algorithms is what stops an "alg" confusion attack; the policy validator also
      // refuses HS256 alongside a JWKS so the two key sources can never be mixed.
      algorithms: this.cfg.algorithms,
      ...(this.cfg.issuer ? { issuer: this.cfg.issuer } : {}),
      ...(this.cfg.audience ? { audience: this.cfg.audience } : {}),
      clockTolerance: this.cfg.clockToleranceSec,
    };
  }
}

/** Calls the tenant's auth service to check an opaque token, with a short positive-result cache. */
export class IntrospectionEndUserVerifier implements EndUserVerifier {
  private readonly cache = new Map<string, { user: VerifiedUser; expiresAtMs: number }>();
  /** Negatives are cached briefly too: otherwise a flood of bad tokens is a free DoS on the tenant's auth service. */
  private readonly negative = new Map<string, number>();
  private static readonly NEGATIVE_TTL_MS = 5_000;

  constructor(
    private readonly cfg: IntrospectionVerifier,
    secret?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    // Honour the flag: a stored credential must not be sent just because it happens to exist.
    this.secret = cfg.useStoredSecret ? secret : undefined;
    if (secret && !cfg.useStoredSecret) this.secret = undefined;
  }

  private readonly secret?: string;

  async verify(token: string): Promise<VerifiedUser> {
    const key = hashToken(token);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs > Date.now()) return hit.user;
    const rejected = this.negative.get(key);
    if (rejected !== undefined && rejected > Date.now()) throw new ApiError("unauthorized", "end-user token was rejected");

    const headers = new Headers({ accept: "application/json" });
    if (this.secret) headers.set("authorization", `Bearer ${this.secret}`);
    let res: Response;
    try {
      res =
        this.cfg.method === "GET"
          ? await this.fetchImpl(this.cfg.endpoint, {
              method: "GET",
              headers: new Headers([...headers, [this.cfg.tokenHeader, this.cfg.tokenHeader.toLowerCase() === "authorization" ? `Bearer ${token}` : token]]),
              signal: AbortSignal.timeout(this.cfg.timeoutMs),
            })
          : await this.fetchImpl(this.cfg.endpoint, {
              method: "POST",
              headers: new Headers([...headers, ["content-type", "application/x-www-form-urlencoded"]]),
              body: new URLSearchParams({ token }).toString(),
              signal: AbortSignal.timeout(this.cfg.timeoutMs),
            });
    } catch (err) {
      // Fail closed: an auth service we cannot reach must not become an open door.
      throw new ApiError("unauthorized", `could not verify the end-user token: ${reason(err)}`, undefined, true);
    }
    if (!res.ok) {
      this.reject(token);
      throw new ApiError("unauthorized", `end-user token rejected by the auth service (${res.status})`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Strictly true. A missing field, the string "false", 0, or anything else is NOT an authentication:
    // treating "not explicitly false" as valid would let an unrelated 200 response log a user in.
    if (body[this.cfg.activeField] !== true) {
      this.reject(token);
      throw new ApiError("unauthorized", `end-user token is not active (${this.cfg.activeField} must be exactly true)`);
    }
    const raw = body[this.cfg.subjectField];
    const userId = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
    if (!userId) {
      this.reject(token);
      throw new ApiError("unauthorized", `introspection response has no "${this.cfg.subjectField}"`);
    }

    const expSec = typeof body.exp === "number" ? body.exp : undefined;
    const user: VerifiedUser = { userId, expiresAtMs: expSec ? expSec * 1000 : undefined, claims: { exp: expSec } };
    if (this.cfg.cacheTtlMs > 0) {
      const until = Math.min(Date.now() + this.cfg.cacheTtlMs, user.expiresAtMs ?? Number.MAX_SAFE_INTEGER);
      if (until > Date.now()) {
        // Keyed by a hash, not the raw token: a heap dump of the process should not hand over live tokens.
        this.cache.set(hashToken(token), { user, expiresAtMs: until });
        if (this.cache.size > MAX_CACHE_ENTRIES) evictOldest(this.cache, MAX_CACHE_ENTRIES / 2);
      }
    }
    return user;
  }

  private reject(token: string) {
    this.negative.set(hashToken(token), Date.now() + IntrospectionEndUserVerifier.NEGATIVE_TTL_MS);
    if (this.negative.size > MAX_CACHE_ENTRIES) evictOldest(this.negative, MAX_CACHE_ENTRIES / 2);
  }
}

export function buildVerifier(policy: Extract<TenantAuthPolicy, { mode: "end_user_token" }>, secret?: string, fetchImpl?: typeof fetch): EndUserVerifier {
  return policy.verifier.kind === "jwt"
    ? new JwtEndUserVerifier(policy.verifier, secret)
    : new IntrospectionEndUserVerifier(policy.verifier, secret, fetchImpl);
}

const MAX_CACHE_ENTRIES = 10_000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Map iteration is insertion-ordered, so dropping the first N entries evicts the oldest. */
function evictOldest(map: Map<string, unknown>, count: number) {
  let i = 0;
  for (const k of map.keys()) {
    if (i++ >= count) break;
    map.delete(k);
  }
}

function reason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // jose messages are safe and specific ("exp" claim timestamp check failed); keep them short
  return msg.slice(0, 200);
}
