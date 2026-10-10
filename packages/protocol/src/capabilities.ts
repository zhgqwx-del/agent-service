import { createHash } from "node:crypto";
import { z } from "zod";
import { externalId, UserId } from "./common.js";
import { ErasureRequestId } from "./lifecycle.js";

// Tombstone is an additive, capability-negotiated extension of this wire family. Keeping the
// family stable lets a new router health-check old runners while it withholds DELETE until every
// healthy target advertises the new lifecycle capability.
export const PROTOCOL_VERSION = "2026-10-08" as const;

/**
 * Versioned runner-only route used by the router for destructive lifecycle traffic. An older
 * runner behind an accidentally shared load-balancer returns 404 instead of executing its legacy
 * public DELETE semantics; the acknowledgement header distinguishes that from a real not-found.
 */
export const INTERNAL_TOMBSTONE_PATH_PREFIX = "/v1/_internal/session-tombstone" as const;
export const INTERNAL_TOMBSTONE_ACK_HEADER = "x-agent-service-lifecycle" as const;
export const INTERNAL_TOMBSTONE_ACK_VALUE = "tombstone-v1" as const;
export const INTERNAL_ROUTER_TOKEN_HEADER = "x-agent-service-internal-token" as const;

/**
 * A runner's erasure worker calls the router on the first path; the router selects the current
 * owner and rewrites it to the second, runner-only path. Keeping both versioned prevents a mixed
 * fleet or a public proxy rule from accidentally invoking an unrelated handler.
 */
export const INTERNAL_ERASURE_DRAIN_ROUTER_PATH_PREFIX = "/_internal/user-erasure-drain-v1/sessions" as const;
export const INTERNAL_ERASURE_DRAIN_RUNNER_PATH_PREFIX = "/v1/_internal/user-erasure-drain-v1" as const;
export const INTERNAL_ERASURE_DRAIN_ACK_HEADER = "x-agent-service-erasure-worker" as const;
export const INTERNAL_ERASURE_DRAIN_ACK_VALUE = "drain-v1" as const;

/**
 * A runner probes this router-only endpoint before it may claim a durable erasure job. V2 is an
 * intentionally incompatible acknowledgement boundary: a pre-compensation worker only knows the
 * V1 path/value and therefore cannot keep claiming while generation-zero compensation rolls out.
 * The router acknowledges V2 only after it has observed both additive control capabilities on
 * every configured stable runner address.
 */
export const INTERNAL_ERASURE_JOB_CONTROL_V1_READY_PATH = "/_internal/user-erasure-job-control-v1/ready" as const;
export const INTERNAL_ERASURE_JOB_CONTROL_READY_PATH = "/_internal/user-erasure-job-control-v2/ready" as const;
export const INTERNAL_ERASURE_JOB_CONTROL_ACK_HEADER = "x-agent-service-erasure-job-control" as const;
export const INTERNAL_ERASURE_JOB_CONTROL_ACK_VALUE = "job-control-v2" as const;

/**
 * A policy evaluator probes this router-only endpoint before every durable queue claim. Evaluation
 * is deliberately separate from physical purge: the ACK only authorizes producing a sealed,
 * non-destructive policy decision, never advancing an erasure request or making delete work ready.
 */
export const INTERNAL_PURGE_POLICY_EVALUATION_READY_PATH =
  "/_internal/purge-policy-evaluation-v1/ready" as const;
export const INTERNAL_PURGE_POLICY_EVALUATION_ACK_HEADER =
  "x-agent-service-purge-policy-evaluation" as const;
export const INTERNAL_PURGE_POLICY_EVALUATION_ACK_VALUE = "policy-evaluator-v1" as const;

/**
 * Tenant erasure uses a platform authority that is independent from every tenant credential. The
 * public request still crosses the router, which injects the private token and requires this fixed
 * runner acknowledgement. An old router therefore cannot accidentally expose the new runner
 * handler by forwarding the public path unchanged without the private credential.
 */
export const INTERNAL_TENANT_ERASURE_ROUTE_ACK_HEADER =
  "x-agent-service-tenant-erasure-route" as const;
export const INTERNAL_TENANT_ERASURE_ROUTE_ACK_VALUE = "platform-control-v1" as const;
/** Router-derived platform principal; accepted only beside the authenticated private route token. */
export const INTERNAL_TENANT_ERASURE_ACTOR_HEADER =
  "x-agent-service-tenant-erasure-actor" as const;
export const INTERNAL_TENANT_ERASURE_CONTROL_PATH_PREFIX =
  "/v1/_internal/tenant-erasure-control-v1" as const;
/**
 * Read-only recovery for a POST whose irreversible commit may have succeeded before its response
 * was lost. Keeping this path distinct ensures a pre-replay runner returns 404 instead of treating
 * a gate-off recovery attempt as authority to create a new admission.
 */
export const INTERNAL_TENANT_ERASURE_REPLAY_PATH =
  "/v1/_internal/tenant-erasure-replay-v1" as const;
export const INTERNAL_TENANT_ERASURE_REPLAY_ACK_HEADER =
  "x-agent-service-tenant-erasure-replay" as const;
export const INTERNAL_TENANT_ERASURE_REPLAY_ACK_VALUE = "replay-v1" as const;

/**
 * Immediately before committing a tenant admission, the selected runner probes this router-only
 * endpoint. The ACK proves that every configured stable runner is currently healthy, configured
 * for the T2 contract, and that both sides' admission gates are active.
 */
export const INTERNAL_TENANT_ERASURE_ADMISSION_READY_PATH =
  "/_internal/tenant-erasure-admission-v1/ready" as const;
export const INTERNAL_TENANT_ERASURE_ADMISSION_ACK_HEADER =
  "x-agent-service-tenant-erasure-admission" as const;
export const INTERNAL_TENANT_ERASURE_ADMISSION_ACK_VALUE = "admission-v1" as const;

/**
 * A tenant-credential worker obtains this content-free ACK before each bounded queue-claim pass and
 * again immediately before every destructive completion. The router emits it only after a fresh,
 * non-sticky observation of every configured runner, keeping local credential cleanup separate
 * from the later content-purge execution plane.
 */
export const INTERNAL_TENANT_CREDENTIAL_REVOCATION_READY_PATH =
  "/_internal/tenant-credential-revocation-v1/ready" as const;
export const INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_HEADER =
  "x-agent-service-tenant-credential-revocation" as const;
export const INTERNAL_TENANT_CREDENTIAL_REVOCATION_ACK_VALUE =
  "credential-revocation-v1" as const;

/**
 * External credential target execution is an independent irreversible boundary after T3a. One
 * content-free ACK authorizes one immediately following worker boundary and cannot substitute for
 * the credential-store revocation or any content-purge authority.
 */
export const INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_READY_PATH =
  "/_internal/tenant-credential-target-execution-v1/ready" as const;
export const INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_HEADER =
  "x-agent-service-tenant-credential-target-execution" as const;
export const INTERNAL_TENANT_CREDENTIAL_TARGET_EXECUTION_ACK_VALUE =
  "external-credential-execution-v1" as const;

/**
 * Independent restore-journal publication is a prerequisite for the first destructive tenant
 * credential boundary. One content-free ACK authorizes only the immediately following durable
 * journal operation and is emitted only when every configured runner reports the exact external
 * journal namespace and target-set identity.
 */
export const INTERNAL_TENANT_RESTORE_JOURNAL_READY_PATH =
  "/_internal/tenant-restore-journal-v1/ready" as const;
export const INTERNAL_TENANT_RESTORE_JOURNAL_ACK_HEADER =
  "x-agent-service-tenant-restore-journal" as const;
export const INTERNAL_TENANT_RESTORE_JOURNAL_ACK_VALUE =
  "independent-restore-journal-v1" as const;

/**
 * A tenant-purge executor obtains this content-free ACK before it may touch the independent
 * execution queue or cross an irreversible local action boundary. The router emits it only after
 * a fresh, non-sticky observation of every configured runner. This ACK is deliberately narrower
 * than the reserved public dataPurgeExecution signal and cannot prove purge completion.
 */
export const INTERNAL_TENANT_PURGE_EXECUTION_READY_PATH =
  "/_internal/tenant-purge-execution-v1/ready" as const;
export const INTERNAL_TENANT_PURGE_EXECUTION_ACK_HEADER =
  "x-agent-service-tenant-purge-execution" as const;
export const INTERNAL_TENANT_PURGE_EXECUTION_ACK_VALUE =
  "local-execution-ack-v1" as const;

/**
 * T3f database-content deletion is a separate destructive boundary from the T3e local execution
 * slice. A worker must obtain this exact, content-free ACK before each bounded queue interaction
 * and immediately before an irreversible database transaction. It never implies all-domain purge
 * completion and deliberately cannot be substituted by the T3e ACK above.
 */
export const INTERNAL_TENANT_DATABASE_PURGE_READY_PATH =
  "/_internal/tenant-database-purge-v1/ready" as const;
export const INTERNAL_TENANT_DATABASE_PURGE_ACK_HEADER =
  "x-agent-service-tenant-database-purge" as const;
export const INTERNAL_TENANT_DATABASE_PURGE_ACK_VALUE =
  "local-db-content-delete-v1" as const;

/**
 * T3g removes the three session-scoped Redis domains and installs a permanent, content-free
 * Redis purge fence. This is deliberately independent from both the T3e local execution ACK and
 * the T3f database-content ACK: one fresh response authorizes one bounded Redis worker boundary.
 */
export const INTERNAL_TENANT_REDIS_PURGE_READY_PATH =
  "/_internal/tenant-redis-purge-v1/ready" as const;
export const INTERNAL_TENANT_REDIS_PURGE_ACK_HEADER =
  "x-agent-service-tenant-redis-purge" as const;
export const INTERNAL_TENANT_REDIS_PURGE_ACK_VALUE =
  "session-state-delete-v1" as const;

/**
 * T3b is a fleet operation rather than an owner-routed request. A claimant calls the router path,
 * the router takes a fresh identity snapshot from every exact configured runner URL, then invokes
 * the runner path once per snapshot member. The private ready route binds a stable logical runner
 * id to a single process boot without publishing either value through public capabilities.
 */
export const INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH =
  "/v1/_internal/tenant-runtime-drain-v1/ready" as const;
export const INTERNAL_TENANT_RUNTIME_DRAIN_ROUTER_PATH =
  "/_internal/tenant-runtime-drain-v1/execute" as const;
export const INTERNAL_TENANT_RUNTIME_DRAIN_RUNNER_PATH =
  "/v1/_internal/tenant-runtime-drain-v1/execute" as const;
export const INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER =
  "x-agent-service-tenant-runtime-drain" as const;
export const INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE = "runtime-drain-v1" as const;

export const TENANT_RUNTIME_DRAIN_V1 = "runtime-drain-v1" as const;
export const TenantRuntimeDrainCapability = z.literal(TENANT_RUNTIME_DRAIN_V1);
export type TenantRuntimeDrainCapability = z.infer<typeof TenantRuntimeDrainCapability>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const RuntimeIdentity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const SafeNonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SafePositiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const TenantRuntimeDrainReady = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  service: z.literal("agent-runner"),
  capability: z.literal(TENANT_RUNTIME_DRAIN_V1),
  endpointEnabled: z.literal(true),
  runnerId: RuntimeIdentity,
  bootId: RuntimeIdentity,
}).strict();
export type TenantRuntimeDrainReady = z.infer<typeof TenantRuntimeDrainReady>;

/** Content-free durable authority copied from the already-completed T3a receipt. */
export const TenantRuntimeDrainRequest = z.object({
  requestId: ErasureRequestId,
  tenantId: externalId,
  subjectGeneration: SafePositiveInteger,
  t3aReceiptSha256: Sha256,
}).strict();
export type TenantRuntimeDrainRequest = z.infer<typeof TenantRuntimeDrainRequest>;

/** Router-added snapshot binding. A restarted or misrouted runner must reject this request. */
export const TenantRuntimeDrainRunnerRequest = TenantRuntimeDrainRequest.extend({
  targetSha256: Sha256,
  expectedRunnerId: RuntimeIdentity,
  expectedBootId: RuntimeIdentity,
}).strict();
export type TenantRuntimeDrainRunnerRequest = z.infer<typeof TenantRuntimeDrainRunnerRequest>;

const TenantRuntimeRevocationLocalReceiptFields = z.object({
  targetSha256: Sha256,
  runnerId: RuntimeIdentity,
  bootId: RuntimeIdentity,
  requestId: ErasureRequestId,
  tenantId: externalId,
  subjectGeneration: SafePositiveInteger,
  t3aReceiptSha256: Sha256,
  cacheEntryCountBefore: SafeNonnegativeInteger,
  cacheEntryCountAfter: z.literal(0),
  activeOperationCountBefore: SafeNonnegativeInteger,
  activeOperationCountAfter: z.literal(0),
  activeTurnCountBefore: SafeNonnegativeInteger,
  activeTurnCountAfter: z.literal(0),
  completedAtMs: SafeNonnegativeInteger,
}).strict();
export const TenantRuntimeRevocationLocalReceiptBody =
  TenantRuntimeRevocationLocalReceiptFields;
export type TenantRuntimeRevocationLocalReceiptBody = z.infer<
  typeof TenantRuntimeRevocationLocalReceiptBody
>;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Canonicalize a configured base URL before committing it to fleet evidence. Default ports,
 * hostname/protocol case and a trailing slash therefore cannot create two identities for one
 * destination. Paths, credentials, query parameters and fragments are never accepted.
 */
export function canonicalTenantRuntimeTargetUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("tenant runtime target must be an absolute http(s) base URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || (parsed.pathname && parsed.pathname !== "/")
    || parsed.search
    || parsed.hash
  ) throw new Error("tenant runtime target must be a credential-free http(s) origin");
  return parsed.origin;
}

export function tenantRuntimeTargetSha256(baseUrl: string): string {
  return sha256(["tenant-runtime-target-v1", canonicalTenantRuntimeTargetUrl(baseUrl)]);
}

export function tenantRuntimeLocalReceiptSha256(
  receipt: TenantRuntimeRevocationLocalReceiptBody,
): string {
  // Project the explicit evidence fields before strict validation. A full receipt legitimately
  // carries `receiptSha256`; hashing must neither include it nor reject that validated superset.
  const value = TenantRuntimeRevocationLocalReceiptBody.parse({
    targetSha256: receipt.targetSha256,
    runnerId: receipt.runnerId,
    bootId: receipt.bootId,
    requestId: receipt.requestId,
    tenantId: receipt.tenantId,
    subjectGeneration: receipt.subjectGeneration,
    t3aReceiptSha256: receipt.t3aReceiptSha256,
    cacheEntryCountBefore: receipt.cacheEntryCountBefore,
    cacheEntryCountAfter: receipt.cacheEntryCountAfter,
    activeOperationCountBefore: receipt.activeOperationCountBefore,
    activeOperationCountAfter: receipt.activeOperationCountAfter,
    activeTurnCountBefore: receipt.activeTurnCountBefore,
    activeTurnCountAfter: receipt.activeTurnCountAfter,
    completedAtMs: receipt.completedAtMs,
  });
  return sha256([
    "tenant-runtime-local-receipt-v1",
    value.targetSha256,
    value.runnerId,
    value.bootId,
    value.requestId,
    value.tenantId,
    value.subjectGeneration,
    value.t3aReceiptSha256,
    value.cacheEntryCountBefore,
    value.cacheEntryCountAfter,
    value.activeOperationCountBefore,
    value.activeOperationCountAfter,
    value.activeTurnCountBefore,
    value.activeTurnCountAfter,
    value.completedAtMs,
  ]);
}

export const TenantRuntimeRevocationLocalReceipt =
  TenantRuntimeRevocationLocalReceiptFields.extend({ receiptSha256: Sha256 })
    .strict()
    .superRefine((receipt, ctx) => {
      if (receipt.receiptSha256 !== tenantRuntimeLocalReceiptSha256(receipt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receiptSha256"],
          message: "tenant runtime local receipt hash does not match its evidence",
        });
      }
    });
export type TenantRuntimeRevocationLocalReceipt = z.infer<
  typeof TenantRuntimeRevocationLocalReceipt
>;

function canonicalTenantRuntimeReceipts(
  receipts: readonly TenantRuntimeRevocationLocalReceipt[],
): TenantRuntimeRevocationLocalReceipt[] {
  return [...receipts].sort((left, right) => (
    left.targetSha256.localeCompare(right.targetSha256, "en")
  ));
}

export function tenantRuntimeFleetSha256(
  targets: readonly Pick<TenantRuntimeRevocationLocalReceipt, "targetSha256">[],
): string {
  const sorted = [...targets]
    .map((target) => Sha256.parse(target.targetSha256))
    .sort((left, right) => left.localeCompare(right, "en"));
  return sha256(["tenant-runtime-fleet-v1", sorted]);
}

export function tenantRuntimeTargetReceiptsSha256(
  receipts: readonly Pick<
    TenantRuntimeRevocationLocalReceipt,
    "targetSha256" | "receiptSha256"
  >[],
): string {
  const sorted = [...receipts]
    .map((receipt) => [
      Sha256.parse(receipt.targetSha256),
      Sha256.parse(receipt.receiptSha256),
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  return sha256(["tenant-runtime-target-receipts-v1", sorted]);
}

export const TenantRuntimeRevocationFleetProof = z.object({
  fleetSha256: Sha256,
  targetReceiptsSha256: Sha256,
  targets: z.array(TenantRuntimeRevocationLocalReceipt).min(1).max(100),
}).strict().superRefine((proof, ctx) => {
  const canonical = canonicalTenantRuntimeReceipts(proof.targets);
  const source = proof.targets[0];
  const uniqueTargets = new Set(proof.targets.map((receipt) => receipt.targetSha256));
  const uniqueRunners = new Set(proof.targets.map((receipt) => receipt.runnerId));
  const uniqueBoots = new Set(proof.targets.map((receipt) => receipt.bootId));
  if (
    uniqueTargets.size !== proof.targets.length
    || uniqueRunners.size !== proof.targets.length
    || uniqueBoots.size !== proof.targets.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targets"],
      message: "tenant runtime fleet identities must be unique",
    });
  }
  if (source && proof.targets.some((receipt) => (
    receipt.requestId !== source.requestId
    || receipt.tenantId !== source.tenantId
    || receipt.subjectGeneration !== source.subjectGeneration
    || receipt.t3aReceiptSha256 !== source.t3aReceiptSha256
  ))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targets"],
      message: "tenant runtime fleet receipts must share one durable source",
    });
  }
  if (proof.targets.some((receipt, index) => receipt !== canonical[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targets"],
      message: "tenant runtime fleet receipts must be sorted by targetSha256",
    });
  }
  if (proof.fleetSha256 !== tenantRuntimeFleetSha256(proof.targets)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fleetSha256"],
      message: "tenant runtime fleet hash does not match its targets",
    });
  }
  if (
    proof.targetReceiptsSha256
    !== tenantRuntimeTargetReceiptsSha256(proof.targets)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetReceiptsSha256"],
      message: "tenant runtime receipt root does not match its targets",
    });
  }
});
export type TenantRuntimeRevocationFleetProof = z.infer<
  typeof TenantRuntimeRevocationFleetProof
>;

export const TENANT_ERASURE_PLATFORM_CONTROL_V1 = "platform-control-v1" as const;
export const TenantErasureControlCapability = z.literal(TENANT_ERASURE_PLATFORM_CONTROL_V1);
export type TenantErasureControlCapability = z.infer<typeof TenantErasureControlCapability>;

export const TENANT_CREDENTIAL_REVOCATION_STORE_V1 = "credential-store-v1" as const;
export const TenantCredentialRevocationCapability = z.literal(
  TENANT_CREDENTIAL_REVOCATION_STORE_V1,
);
export type TenantCredentialRevocationCapability = z.infer<
  typeof TenantCredentialRevocationCapability
>;

/**
 * Additive writer contract for the versioned provider/auth credential inventory. Code awareness
 * and the durable write-once cutover are intentionally separate: a freshly deployed runner may
 * dual-write the dormant ledger, but T3a must remain closed until every configured runner reports
 * that the shared cutover is active.
 */
export const TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1 =
  "versioned-target-ledger-v1" as const;
export const TenantCredentialLifecycleCapability = z.literal(
  TENANT_CREDENTIAL_LIFECYCLE_VERSIONED_TARGET_LEDGER_V1,
);
export type TenantCredentialLifecycleCapability = z.infer<
  typeof TenantCredentialLifecycleCapability
>;

export const TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1 =
  "external-credential-execution-v1" as const;
export const TenantCredentialTargetExecutionCapability = z.literal(
  TENANT_CREDENTIAL_TARGET_EXECUTION_EXTERNAL_V1,
);
export type TenantCredentialTargetExecutionCapability = z.infer<
  typeof TenantCredentialTargetExecutionCapability
>;

export const TENANT_RESTORE_JOURNAL_INDEPENDENT_V1 =
  "independent-restore-journal-v1" as const;
export const TenantRestoreJournalCapability = z.literal(
  TENANT_RESTORE_JOURNAL_INDEPENDENT_V1,
);
export type TenantRestoreJournalCapability = z.infer<
  typeof TenantRestoreJournalCapability
>;

export const TENANT_PURGE_EXECUTION_LOCAL_ACK_V1 = "local-execution-ack-v1" as const;
export const TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1 =
  "local-db-content-delete-v1" as const;
export const TenantPurgeExecutionCapability = z.enum([
  TENANT_PURGE_EXECUTION_LOCAL_ACK_V1,
  TENANT_PURGE_EXECUTION_LOCAL_DB_CONTENT_DELETE_V1,
]);
export type TenantPurgeExecutionCapability = z.infer<
  typeof TenantPurgeExecutionCapability
>;

export const TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1 =
  "session-state-delete-v1" as const;
export const TenantRedisPurgeCapability = z.literal(
  TENANT_REDIS_PURGE_SESSION_STATE_DELETE_V1,
);
export type TenantRedisPurgeCapability = z.infer<typeof TenantRedisPurgeCapability>;

/**
 * Hash an operator-assigned, non-secret Redis namespace identity together with the key prefix.
 * The value lets a fresh all-runner barrier reject a fleet which would otherwise delete the same
 * session ids in different Redis clusters or namespaces and incorrectly acknowledge zero keys.
 */
export function tenantRedisNamespaceSha256(namespaceId: string, prefix: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(namespaceId)) {
    throw new Error("Redis namespace id is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(prefix)) {
    throw new Error("Redis key prefix is invalid");
  }
  return createHash("sha256")
    .update(JSON.stringify(["tenant-redis-namespace-v1", namespaceId, prefix]))
    .digest("hex");
}

export const PURGE_POLICY_EVALUATOR_V1 = "policy-evaluator-v1" as const;
export const PurgePolicyEvaluationCapability = z.literal(PURGE_POLICY_EVALUATOR_V1);
export type PurgePolicyEvaluationCapability = z.infer<typeof PurgePolicyEvaluationCapability>;

export const USER_DATA_EXPORT_ARTIFACT_NDJSON_V1 = "artifact-ndjson-v1" as const;
export const UserDataExportCapability = z.literal(USER_DATA_EXPORT_ARTIFACT_NDJSON_V1);
export type UserDataExportCapability = z.infer<typeof UserDataExportCapability>;

/**
 * Content-free identity for the object namespace shared by a runner fleet. The endpoint is
 * deliberately excluded: two aliases for one service must compare equal, while moving a bucket or
 * prefix is a data migration and therefore changes this identity.
 */
export function blobS3NamespaceSha256(namespaceId: string, bucket: string, prefix: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(namespaceId)) {
    throw new Error("Blob namespace id is invalid");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("S3 bucket is invalid");
  }
  if (
    !prefix
    || prefix.length > 256
    || !/^[a-z0-9_-]{1,128}(?:\/[a-z0-9_-]{1,128})*$/.test(prefix)
  ) {
    throw new Error("S3 prefix is invalid");
  }
  return createHash("sha256")
    .update(JSON.stringify(["blob-s3-namespace-v1", namespaceId, bucket, prefix]))
    .digest("hex");
}

export function blobS3Backend(namespaceSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(namespaceSha256)) throw new Error("Blob namespace digest is invalid");
  return `s3-v1-${namespaceSha256.slice(0, 24)}`;
}

export const BlobStorageCapability = z.object({
  /** Manifest backend identity. It changes whenever an object namespace changes. */
  backend: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
  /** True only for an adapter with tested cross-process visibility and conditional writes. */
  shared: z.boolean(),
  namespaceSha256: Sha256,
  /** Generation 1 proves the durable database cutover is active for this exact namespace. */
  controlGeneration: z.literal(1),
}).strict();
export type BlobStorageCapability = z.infer<typeof BlobStorageCapability>;

export const ERASURE_JOB_CONTROL_QUARANTINE_V1 = "quarantine-v1" as const;
export const ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1 = "legacy-tombstone-compensation-v1" as const;
export const ErasureJobControlCapability = z.enum([
  ERASURE_JOB_CONTROL_QUARANTINE_V1,
  ERASURE_JOB_CONTROL_LEGACY_TOMBSTONE_COMPENSATION_V1,
]);
export type ErasureJobControlCapability = z.infer<typeof ErasureJobControlCapability>;

export const DATA_GOVERNANCE_CANONICAL_RETENTION_V1 = "canonical-retention-v1" as const;
export const DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1 = "multi-legal-hold-v1" as const;
export const DataGovernanceCapability = z.enum([
  DATA_GOVERNANCE_CANONICAL_RETENTION_V1,
  DATA_GOVERNANCE_MULTI_LEGAL_HOLD_V1,
]);
export type DataGovernanceCapability = z.infer<typeof DataGovernanceCapability>;

/**
 * Fixed, content-free signal from a runner whose old local execution is already fenced but has not
 * acknowledged abort yet. The router may bypass that runner only after the authoritative Redis
 * lease has expired; until then it must not create overlapping execution on another runner.
 */
export const INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_HEADER = "x-agent-service-erasure-local-state" as const;
export const INTERNAL_ERASURE_DRAIN_LOCAL_FENCED_VALUE = "fenced-draining-v1" as const;

/** Claim identity only: the receiving runner derives the current phase from durable state. */
export const UserErasureDrainRequest = z.object({
  tenantId: externalId,
  userId: UserId,
  requestId: ErasureRequestId,
  subjectGeneration: z.number().int().positive().safe(),
  claimToken: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  claimAttempt: z.number().int().positive().safe(),
}).strict();
export type UserErasureDrainRequest = z.infer<typeof UserErasureDrainRequest>;

export const Capabilities = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  service: z.enum(["agent-runner", "agent-router"]),
  features: z.object({
    streaming: z.literal(true),
    replay: z.object({ persistedEvents: z.literal(true), hotWindowMs: z.number().int() }),
    approvals: z.literal(true),
    sessionLifecycle: z.array(z.enum(["archive", "unarchive", "tombstone", "purge"])),
    /** Missing on older runners in this protocol family; parsers normalize that to false. */
    blobAttachments: z.boolean().default(false),
    /** Exact shared namespace proof; older/filesystem-only runners normalize to null. */
    blobStorage: BlobStorageCapability.nullable().default(null),
    /** Missing on older runners in this protocol family; parsers normalize that to false. */
    dataErasureRequests: z.boolean().default(false),
    /**
     * Independent from request admission: an operator may close new erasure POSTs while already
     * durable jobs still need to drain a mixed owner fleet.
     */
    userErasureWorker: z.array(z.literal("drain-v1")).max(1).default([]),
    /** Runner-to-router rollout signals; public routers deliberately project these as an empty list. */
    erasureJobControl: z.array(ErasureJobControlCapability).max(2).default([]),
    /** Writer/store understands canonical policy and multi-hold authority; endpoint activation is separate. */
    dataGovernance: z.array(DataGovernanceCapability).max(2).default([]),
    /** The admin management endpoints are enabled on this runner; still never implies purge. */
    dataGovernanceManagement: z.boolean().default(false),
    /** Code understands the sealed, non-destructive purge-policy evaluation contract. */
    purgePolicyEvaluation: z.array(PurgePolicyEvaluationCapability).max(1).default([]),
    /** Reserved execution signal. It remains false until a separate destructive rollout exists. */
    dataPurgeExecution: z.literal(false).default(false),
    /** Code understands owner-scoped NDJSON export artifacts and their private download contract. */
    userDataExport: z.array(UserDataExportCapability).max(1).default([]),
    /** Admission gate for new export requests; status, download and cleanup remain independent. */
    dataExportRequests: z.boolean().default(false),
    /** Independent platform control plane for tenant-erasure admission, status and replay. */
    tenantErasureControl: z.array(TenantErasureControlCapability).max(1).default([]),
    /** New tenant-erasure admissions are active on this runner; status remains independently readable. */
    tenantErasureRequests: z.boolean().default(false),
    /** Code understands the local credential-store revocation job and immutable receipt contract. */
    tenantCredentialRevocation: z.array(TenantCredentialRevocationCapability).max(1).default([]),
    /** Local worker activation; fleet execution additionally requires the router's fresh barrier. */
    tenantCredentialRevocationWorker: z.boolean().default(false),
    /** Provider/auth writers preserve every credential generation and its two target domains. */
    tenantCredentialLifecycle: z.array(TenantCredentialLifecycleCapability).max(1).default([]),
    /** Durable shared tracking cutover is active; once true the fleet may only forward-fix. */
    tenantCredentialLifecycleTrackingActive: z.boolean().default(false),
    /** Concrete adapter support for the independently gated external credential target executor. */
    tenantCredentialTargetExecution:
      z.array(TenantCredentialTargetExecutionCapability).max(1).default([]),
    /** Local target executor activation; fleet authority still requires the private fresh barrier. */
    tenantCredentialTargetExecutionWorker: z.boolean().default(false),
    /** Code is wired to an independent append-only tenant restore journal. */
    tenantRestoreJournal: z.array(TenantRestoreJournalCapability).max(1).default([]),
    /** Local publication worker activation; destructive authority still requires a fresh barrier. */
    tenantRestoreJournalWorker: z.boolean().default(false),
    /** Content-free external journal namespace identity; null when no adapter is configured. */
    tenantRestoreJournalNamespaceSha256: Sha256.nullable().default(null),
    /** Ordered configured target-set identity; null when no adapter is configured. */
    tenantRestoreJournalTargetRootSha256: Sha256.nullable().default(null),
    /** Exact live database epoch; a restored database must start under a new digest. */
    tenantRestoreRuntimeEpochSha256: Sha256.nullable().default(null),
    /** Code understands the local T3e execution/physical-ACK substrate; this is not completion. */
    tenantPurgeExecution: z.array(TenantPurgeExecutionCapability).max(2).default([]),
    /** Local executor activation; fleet authority additionally requires the router's fresh barrier. */
    tenantPurgeExecutionWorker: z.boolean().default(false),
    /** Local T3f database-content worker activation; it has an independent router barrier. */
    tenantDatabasePurgeWorker: z.boolean().default(false),
    /** Additive T3g Redis lease/fence/stream deletion and permanent marker contract. */
    tenantRedisPurge: z.array(TenantRedisPurgeCapability).max(1).default([]),
    /** Local T3g worker activation; fleet execution additionally requires its router barrier. */
    tenantRedisPurgeWorker: z.boolean().default(false),
    /** Content-free identity of the Redis cluster namespace targeted by the T3g adapter. */
    tenantRedisPurgeNamespaceSha256: Sha256.nullable().default(null),
    /** Code understands the private all-configured runtime-drain receipt contract. */
    tenantRuntimeDrain: z.array(TenantRuntimeDrainCapability).max(1).default([]),
    /** Local private endpoint is active; the router still performs a fresh identity probe. */
    tenantRuntimeDrainEndpoint: z.boolean().default(false),
    dynamicTools: z.boolean(),
    mcp: z.array(z.enum(["streamable-http", "stdio"])),
    skills: z.boolean(),
    sandbox: z.array(z.enum(["none"])),
    byok: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof Capabilities>;
