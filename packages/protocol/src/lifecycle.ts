import { z } from "zod";
import { UserId } from "./common.js";

export const ErasureRequestId = z.string().regex(
  /^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

export const ErasureRequestStatus = z.enum([
  "gated",
  "draining",
  "tombstoning",
  "reconciling_usage",
  "awaiting_purge_policy",
  "purging",
  "blocked",
  "completed",
]);

/** Public erasure status deliberately omits actor ids, idempotency material and internal cursors. */
export const ErasureRequest = z.object({
  id: ErasureRequestId,
  scope: z.literal("user"),
  userId: UserId,
  generation: z.number().int().positive(),
  status: ErasureRequestStatus,
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type ErasureRequest = z.infer<typeof ErasureRequest>;

export const ErasureRequestParams = z.object({ requestId: ErasureRequestId });

// ---------- canonical retention policy and legal-hold management ----------

// `active` is the fixed read endpoint below `/v1/retention-policies`; allowing an immutable
// version with the same literal would make that version impossible to address with GET.
export const RetentionPolicyVersion = z.string().regex(/^(?!active$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
export const LegalHoldId = z.string().regex(/^hold_[A-Za-z0-9][A-Za-z0-9._-]{0,58}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
// Keep explicit bounds in this order. Chaining `.nonnegative().safe()` makes the OpenAPI
// generator retain safe()'s negative lower bound even though Zod rejects it at runtime.
const SafeNonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SafePositiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const SafeDurationMs = SafeNonnegativeInteger.nullable().describe(
  "Retention duration in milliseconds. null is fail-closed and does not authorize expiry.",
);

export const RetentionPolicyDocument = z.object({
  sessionContentRetentionMs: SafeDurationMs,
  userErasureGraceMs: SafeDurationMs,
  operationalUsageRetentionMs: SafeDurationMs,
  idempotencyReceiptRetentionMs: SafeDurationMs,
  billingFactRetentionMs: SafeDurationMs,
  lifecycleAuditRetentionMs: SafeDurationMs,
  exportArtifactTtlMs: SafeDurationMs,
}).strict();
export type RetentionPolicyDocument = z.infer<typeof RetentionPolicyDocument>;

export const RetentionPolicyParams = z.object({ policyVersion: RetentionPolicyVersion });
export const RetentionPolicyPutRequest = z.object({ policy: RetentionPolicyDocument }).strict();
export const RetentionPolicyActivateRequest = z.object({
  expectedControlGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export const RetentionPolicyRecord = z.object({
  tenantId: z.string(),
  policyVersion: RetentionPolicyVersion,
  schemaVersion: z.literal(1),
  policy: RetentionPolicyDocument,
  policySha256: Sha256,
  createdByKeyId: z.string(),
  createdAtMs: SafeNonnegativeInteger,
});
export type RetentionPolicyRecord = z.infer<typeof RetentionPolicyRecord>;

export const RetentionPolicyControl = z.object({
  tenantId: z.string(),
  controlGeneration: SafeNonnegativeInteger,
  activePolicyVersion: RetentionPolicyVersion.optional(),
  activePolicySha256: Sha256.optional(),
  effectiveAtMs: SafeNonnegativeInteger.optional(),
  updatedAtMs: SafeNonnegativeInteger,
});
export type RetentionPolicyControl = z.infer<typeof RetentionPolicyControl>;

export const ActiveRetentionPolicyResponse = z.object({
  control: RetentionPolicyControl,
  policy: RetentionPolicyRecord,
});
export type ActiveRetentionPolicyResponse = z.infer<typeof ActiveRetentionPolicyResponse>;

export const LegalHoldSubjectKind = z.enum(["tenant", "user"]);
export const LegalHoldReasonCode = z.enum([
  "litigation",
  "regulatory",
  "security_incident",
  "billing_dispute",
]);
export const LegalHoldReleaseReasonCode = z.enum([
  "matter_closed",
  "issued_in_error",
  "superseded",
]);

export const LegalHoldSetRequest = z.object({
  holdId: LegalHoldId,
  subjectKind: LegalHoldSubjectKind,
  subjectId: z.string().min(1).max(128),
  reasonCode: LegalHoldReasonCode,
  externalReferenceSha256: Sha256.optional(),
  expectedControlGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();
export const LegalHoldReleaseRequest = z.object({
  expectedControlGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  reasonCode: LegalHoldReleaseReasonCode,
}).strict();
export const LegalHoldParams = z.object({ holdId: LegalHoldId });
export const LegalHoldListQuery = z.object({
  subjectKind: LegalHoldSubjectKind,
  subjectId: z.string().min(1).max(128),
});

export const LegalHoldRecord = z.object({
  tenantId: z.string(),
  holdId: LegalHoldId,
  subjectKind: LegalHoldSubjectKind,
  subjectId: z.string(),
  state: z.enum(["active", "released"]),
  reasonCode: z.enum([
    "litigation",
    "regulatory",
    "security_incident",
    "billing_dispute",
    "legacy_unattributed",
  ]),
  externalReferenceSha256: Sha256.optional(),
  createdControlGeneration: SafePositiveInteger,
  createdByKeyId: z.string(),
  createdAtMs: SafeNonnegativeInteger,
  releasedControlGeneration: SafePositiveInteger.optional(),
  releasedByKeyId: z.string().optional(),
  releasedAtMs: SafeNonnegativeInteger.optional(),
  releaseReasonCode: LegalHoldReleaseReasonCode.optional(),
});
export type LegalHoldRecord = z.infer<typeof LegalHoldRecord>;

export const LegalHoldControl = z.object({
  tenantId: z.string(),
  subjectKind: LegalHoldSubjectKind,
  subjectId: z.string(),
  controlGeneration: SafeNonnegativeInteger,
  activeHoldCount: SafeNonnegativeInteger,
  activeProjectionSha256: Sha256,
  updatedAtMs: SafeNonnegativeInteger,
});
export type LegalHoldControl = z.infer<typeof LegalHoldControl>;

export const ActiveLegalHoldListResponse = z.object({
  control: LegalHoldControl,
  data: z.array(LegalHoldRecord),
});
export type ActiveLegalHoldListResponse = z.infer<typeof ActiveLegalHoldListResponse>;
