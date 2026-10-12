import { createHash } from "node:crypto";

/** Local, versioned source checkpoint. It is deliberately not a disposition grant. */
export const TENANT_TELEMETRY_PREGRANT_INTENT_SCOPE =
  "tenant-telemetry-pregrant-intent-v1" as const;
export const TENANT_TELEMETRY_PREGRANT_CLAIM_SCOPE =
  "tenant-telemetry-pregrant-claim-v1" as const;

/** Retry with the same intent version; no new claim was committed. */
export class TenantTelemetryPregrantClaimLeaseExpiredError extends Error {
  readonly retryable = true as const;

  constructor() {
    super("telemetry pregrant claim lease expired or database clock regressed");
    this.name = "TenantTelemetryPregrantClaimLeaseExpiredError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const digest = (value: unknown): value is string =>
  typeof value === "string" && SHA256.test(value);
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const INTENT_KEYS = ["scope", "tenantId", "requestId", "subjectGeneration",
  "buildGeneration", "artifactGroupSha256", "catalogEntryReceiptSha256",
  "catalogReceiptSha256", "sourceAccountingReceiptSha256",
  "targetManifestReceiptSha256", "ownerClosureReceiptSha256",
  "databasePurgeReceiptSha256", "createdAtDbMs", "grantReady"] as const;
const CLAIM_KEYS = ["scope", "tenantId", "requestId", "intentSha256", "attempt",
  "claimTokenSha256", "claimedAtDbMs", "leaseUntilDbMs", "grantReady"] as const;
const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
};

export interface TenantTelemetryPregrantIntentBody {
  scope: typeof TENANT_TELEMETRY_PREGRANT_INTENT_SCOPE;
  tenantId: string;
  requestId: string;
  subjectGeneration: number;
  buildGeneration: number;
  artifactGroupSha256: string;
  catalogEntryReceiptSha256: string;
  catalogReceiptSha256: string;
  sourceAccountingReceiptSha256: string;
  targetManifestReceiptSha256: string;
  ownerClosureReceiptSha256: string;
  databasePurgeReceiptSha256: string;
  createdAtDbMs: number;
  grantReady: false;
}

export interface TenantTelemetryPregrantIntent extends TenantTelemetryPregrantIntentBody {
  intentSha256: string;
}

export function tenantTelemetryPregrantIntentSha256(
  body: TenantTelemetryPregrantIntentBody,
): string {
  if (!exactKeys(body, INTENT_KEYS)
    || body.scope !== TENANT_TELEMETRY_PREGRANT_INTENT_SCOPE
    || !body.tenantId || body.tenantId.length > 128 || !body.requestId
    || !Number.isSafeInteger(body.subjectGeneration) || body.subjectGeneration < 1
    || !Number.isSafeInteger(body.buildGeneration) || body.buildGeneration < 1
    || !Number.isSafeInteger(body.createdAtDbMs) || body.createdAtDbMs < 0
    || body.grantReady !== false
    || !digest(body.artifactGroupSha256)
    || !digest(body.catalogEntryReceiptSha256)
    || !digest(body.catalogReceiptSha256)
    || !digest(body.sourceAccountingReceiptSha256)
    || !digest(body.targetManifestReceiptSha256)
    || !digest(body.ownerClosureReceiptSha256)
    || !digest(body.databasePurgeReceiptSha256)) {
    throw new Error("invalid telemetry pregrant intent");
  }
  return hash([TENANT_TELEMETRY_PREGRANT_INTENT_SCOPE,
    body.tenantId, body.requestId, body.subjectGeneration, body.buildGeneration,
    body.artifactGroupSha256, body.catalogEntryReceiptSha256,
    body.catalogReceiptSha256, body.sourceAccountingReceiptSha256,
    body.targetManifestReceiptSha256, body.ownerClosureReceiptSha256,
    body.databasePurgeReceiptSha256, body.createdAtDbMs, false]);
}

export function validateTenantTelemetryPregrantIntent(
  intent: TenantTelemetryPregrantIntent,
): void {
  if (!exactKeys(intent, [...INTENT_KEYS, "intentSha256"]) || !digest(intent.intentSha256)) {
    throw new Error("invalid telemetry pregrant intent shape");
  }
  const { intentSha256, ...body } = intent;
  if (intentSha256 !== tenantTelemetryPregrantIntentSha256(body)) {
    throw new Error("invalid telemetry pregrant intent hash");
  }
}

export interface TenantTelemetryPregrantClaimBody {
  scope: typeof TENANT_TELEMETRY_PREGRANT_CLAIM_SCOPE;
  tenantId: string;
  requestId: string;
  intentSha256: string;
  attempt: number;
  claimTokenSha256: string;
  claimedAtDbMs: number;
  leaseUntilDbMs: number;
  grantReady: false;
}

export interface TenantTelemetryPregrantClaim extends TenantTelemetryPregrantClaimBody {
  claimSha256: string;
}

export function tenantTelemetryPregrantClaimTokenSha256(token: string): string {
  if (!token || token.length > 256) throw new Error("invalid telemetry pregrant claim token");
  return hash([TENANT_TELEMETRY_PREGRANT_CLAIM_SCOPE, "token", token]);
}

export function tenantTelemetryPregrantClaimSha256(
  body: TenantTelemetryPregrantClaimBody,
): string {
  if (!exactKeys(body, CLAIM_KEYS)
    || body.scope !== TENANT_TELEMETRY_PREGRANT_CLAIM_SCOPE
    || !body.tenantId || body.tenantId.length > 128 || !body.requestId
    || !digest(body.intentSha256) || !digest(body.claimTokenSha256)
    || !Number.isSafeInteger(body.attempt) || body.attempt < 1
    || !Number.isSafeInteger(body.claimedAtDbMs) || body.claimedAtDbMs < 0
    || !Number.isSafeInteger(body.leaseUntilDbMs)
    || body.leaseUntilDbMs <= body.claimedAtDbMs
    || body.grantReady !== false) {
    throw new Error("invalid telemetry pregrant claim");
  }
  return hash([TENANT_TELEMETRY_PREGRANT_CLAIM_SCOPE,
    body.tenantId, body.requestId, body.intentSha256, body.attempt,
    body.claimTokenSha256, body.claimedAtDbMs, body.leaseUntilDbMs, false]);
}

export function validateTenantTelemetryPregrantClaim(
  claim: TenantTelemetryPregrantClaim,
): void {
  if (!exactKeys(claim, [...CLAIM_KEYS, "claimSha256"]) || !digest(claim.claimSha256)) {
    throw new Error("invalid telemetry pregrant claim shape");
  }
  const { claimSha256, ...body } = claim;
  if (claimSha256 !== tenantTelemetryPregrantClaimSha256(body)) {
    throw new Error("invalid telemetry pregrant claim hash");
  }
}

export interface TenantTelemetryPregrantIntentStore {
  prepareTenantTelemetryPregrantIntent(
    tenantId: string, requestId: string, artifactGroupSha256: string,
  ): Promise<TenantTelemetryPregrantIntent | null>;
  getTenantTelemetryPregrantIntent(
    tenantId: string, requestId: string, artifactGroupSha256: string,
  ): Promise<TenantTelemetryPregrantIntent | null>;
  claimTenantTelemetryPregrantIntent(
    tenantId: string, requestId: string, artifactGroupSha256: string,
    expectedIntentSha256: string, claimToken: string, leaseMs: number,
  ): Promise<TenantTelemetryPregrantClaim | null>;
}
