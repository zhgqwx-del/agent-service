import { z } from "zod";
import { externalId } from "./common.js";

/**
 * How a tenant's end users are identified.
 *
 * `trusted_caller`: the caller holds a service API key and asserts the user with a header. Correct only
 * when that key never leaves the tenant's own backend (BFF pattern) — whoever holds the key can act as
 * any of that tenant's users.
 *
 * `end_user_token`: the caller additionally presents the END USER's own token, which this service
 * verifies before deriving the user id from it. A forged or replayed header buys nothing, so the key may
 * live closer to the edge. The asserted header, if present at all, must match the verified subject.
 */
export const JwtVerifier = z.object({
  kind: z.literal("jwt"),
  /** RFC 7517 key set URL. Preferred: no shared secret has to be stored. */
  jwksUri: z.string().url().optional(),
  /** HS256 with a shared secret held in the tenant's encrypted secret slot (no plaintext at rest). */
  hs256: z.boolean().default(false),
  algorithms: z.array(z.enum(["RS256", "RS384", "RS512", "ES256", "ES384", "PS256", "HS256"])).default(["RS256"]),
  issuer: z.string().optional(),
  audience: z.string().optional(),
  /** claim carrying the user id */
  subjectClaim: z.string().default("sub"),
  /** capped at 60s: a larger window keeps accepting tokens well after they expire */
  clockToleranceSec: z.number().int().min(0).max(60).default(30),
});
export type JwtVerifier = z.infer<typeof JwtVerifier>;

export const IntrospectionVerifier = z.object({
  kind: z.literal("introspection"),
  /** RFC 7662-style endpoint, or any endpoint returning JSON with an active flag and a subject */
  endpoint: z.string().url(),
  method: z.enum(["POST", "GET"]).default("POST"),
  /** header that carries the token being introspected when method=GET */
  tokenHeader: z.string().default("authorization"),
  activeField: z.string().default("active"),
  subjectField: z.string().default("sub"),
  /** the tenant's stored secret is sent as `Authorization: Bearer <secret>` when true */
  useStoredSecret: z.boolean().default(false),
  /** positive-result cache, to keep one auth round trip from becoming one per request */
  cacheTtlMs: z.number().int().min(0).max(600_000).default(60_000),
  timeoutMs: z.number().int().min(100).max(10_000).default(2_000),
});
export type IntrospectionVerifier = z.infer<typeof IntrospectionVerifier>;

export const TenantAuthPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("trusted_caller") }),
  z.object({
    mode: z.literal("end_user_token"),
    verifier: z.discriminatedUnion("kind", [JwtVerifier, IntrospectionVerifier]),
    /** header carrying the end-user token; `Authorization` already carries the service key */
    tokenHeader: z.string().default("x-end-user-token"),
  }),
]);
export type TenantAuthPolicy = z.infer<typeof TenantAuthPolicy>;

export const DEFAULT_AUTH_POLICY: TenantAuthPolicy = { mode: "trusted_caller" };

export const TenantAuthPolicyInput = z.object({
  policy: TenantAuthPolicy,
  /** shared secret for hs256 / introspection; write-only, encrypted at rest, never returned */
  secret: z.string().min(8).max(4096).optional(),
});
export type TenantAuthPolicyInput = z.infer<typeof TenantAuthPolicyInput>;

/**
 * `runtime`: everything needed to run sessions and read usage.
 * `admin`: additionally change tenant configuration — auth policy, provider/BYOK config, agent definitions.
 * Splitting them is what makes `end_user_token` meaningful: a leaked runtime key cannot turn the
 * verification off, and cannot repoint the model endpoint at somewhere it can read prompts.
 */
export const ApiKeyScope = z.enum(["runtime", "admin"]);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;
export const DEFAULT_SCOPES: ApiKeyScope[] = ["runtime"];

export const CreateApiKeyRequest = z.object({
  /** human label; also the id used to revoke it */
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  scopes: z.array(ApiKeyScope).min(1).default(DEFAULT_SCOPES),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const Tenant = z.object({
  tenantId: externalId,
  name: z.string().optional(),
  authPolicy: TenantAuthPolicy,
  createdAtMs: z.number().int(),
});
export type Tenant = z.infer<typeof Tenant>;
