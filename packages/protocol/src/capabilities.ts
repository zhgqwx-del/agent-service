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

export const TENANT_ERASURE_PLATFORM_CONTROL_V1 = "platform-control-v1" as const;
export const TenantErasureControlCapability = z.literal(TENANT_ERASURE_PLATFORM_CONTROL_V1);
export type TenantErasureControlCapability = z.infer<typeof TenantErasureControlCapability>;

export const PURGE_POLICY_EVALUATOR_V1 = "policy-evaluator-v1" as const;
export const PurgePolicyEvaluationCapability = z.literal(PURGE_POLICY_EVALUATOR_V1);
export type PurgePolicyEvaluationCapability = z.infer<typeof PurgePolicyEvaluationCapability>;

export const USER_DATA_EXPORT_ARTIFACT_NDJSON_V1 = "artifact-ndjson-v1" as const;
export const UserDataExportCapability = z.literal(USER_DATA_EXPORT_ARTIFACT_NDJSON_V1);
export type UserDataExportCapability = z.infer<typeof UserDataExportCapability>;

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
    dynamicTools: z.boolean(),
    mcp: z.array(z.enum(["streamable-http", "stdio"])),
    skills: z.boolean(),
    sandbox: z.array(z.enum(["none"])),
    byok: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof Capabilities>;
