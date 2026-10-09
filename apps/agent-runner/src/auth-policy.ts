import { assertPublicHost } from "@agent-service/core";
import { ApiError, type TenantAuthPolicy, type TenantAuthPolicyInput } from "@agent-service/protocol";

/** Does this policy need the tenant's stored secret to work at all? */
export function needsSecret(policy: TenantAuthPolicy): boolean {
  if (policy.mode !== "end_user_token") return false;
  return policy.verifier.kind === "jwt" ? policy.verifier.hs256 : policy.verifier.useStoredSecret;
}

function credentialFreeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The configured URL can contain credentials even when it is syntactically malformed. Never
    // reflect the original input into an API error or log-adjacent response.
    throw new ApiError("invalid_request", "URL is not valid");
  }
  if (url.username || url.password) {
    throw new ApiError("invalid_request", "URL must not contain credentials");
  }
  return url;
}

/**
 * The default URL guard for anything a tenant configures us to call.
 *
 * https is required, not preferred: a JWKS is the trust root for user identity, and an introspection
 * request carries a live token. Over plaintext, anyone on the path substitutes the key set or reads the
 * token. Tests inject a permissive guard because their servers are local.
 */
export async function assertPublicUrlDefault(url: string): Promise<void> {
  const u = credentialFreeUrl(url);
  if (u.protocol !== "https:") throw new ApiError("invalid_request", `must be https, got ${u.protocol}`);
  try {
    await assertPublicHost(u.hostname);
  } catch (err) {
    throw new ApiError("invalid_request", `URL host is not reachable from this service: ${(err as Error).message}`);
  }
}

/**
 * Validate a policy BEFORE storing it. Every check here exists because the alternative is worse than a
 * rejected request:
 *  - a policy that cannot build a verifier makes every route fail;
 *  - HS256 listed next to a JWKS is the classic algorithm-confusion setup;
 *  - no issuer/audience against a shared identity provider accepts tokens minted for someone else;
 *  - a tenant-supplied URL is an outbound target, so it is an SSRF vector.
 */
export async function validateAuthPolicy(
  input: TenantAuthPolicyInput,
  hasStoredSecret: boolean,
  assertPublicUrl: (url: string) => Promise<void> = assertPublicUrlDefault,
  /** the verifier kind currently stored, so a change of kind can demand a fresh secret */
  storedVerifierKind?: "jwt" | "introspection",
): Promise<void> {
  const { policy, secret } = input;
  if (policy.mode !== "end_user_token") return;
  const v = policy.verifier;

  if (v.kind === "jwt") {
    if (!v.algorithms.length) throw new ApiError("invalid_request", "algorithms must not be empty: it is what pins the signature algorithm");
    if (v.hs256 && v.jwksUri) throw new ApiError("invalid_request", "choose either hs256 or jwksUri, not both");
    if (!v.hs256 && !v.jwksUri) throw new ApiError("invalid_request", "a jwt verifier needs either jwksUri or hs256");
    const symmetric = v.algorithms.includes("HS256");
    if (v.jwksUri && symmetric) {
      throw new ApiError("invalid_request", "algorithms must not include HS256 alongside jwksUri: a symmetric algorithm with a published key set enables algorithm confusion");
    }
    if (v.hs256 && !symmetric) throw new ApiError("invalid_request", 'hs256 requires "HS256" in algorithms');
    // A secret stored for a DIFFERENT verifier must never be reused: an introspection credential that
    // the tenant's auth service has seen would become the HMAC key that signs user identities.
    const reusable = hasStoredSecret && storedVerifierKind === "jwt";
    if (v.hs256 && !secret && !reusable) {
      throw new ApiError("invalid_request", hasStoredSecret
        ? "switching to hs256 requires a NEW secret: the stored one belongs to a different verifier"
        : "hs256 needs a secret; send it as `secret` in this request");
    }
    if (v.jwksUri) {
      credentialFreeUrl(v.jwksUri);
      await assertPublicUrl(v.jwksUri);
      if (!v.issuer || !v.audience) {
        throw new ApiError("invalid_request", "issuer and audience are required with jwksUri: without them any token from that key set is accepted, including tokens minted for another relying party");
      }
    }
  } else {
    credentialFreeUrl(v.endpoint);
    await assertPublicUrl(v.endpoint);
    const reusable = hasStoredSecret && storedVerifierKind === "introspection";
    if (v.useStoredSecret && !secret && !reusable) {
      throw new ApiError("invalid_request", hasStoredSecret
        ? "switching to introspection requires a NEW credential: the stored secret belongs to a different verifier"
        : "useStoredSecret needs a secret; send it as `secret` in this request");
    }
  }
}
