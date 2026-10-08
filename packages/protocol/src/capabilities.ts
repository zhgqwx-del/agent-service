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
    dynamicTools: z.boolean(),
    mcp: z.array(z.enum(["streamable-http", "stdio"])),
    skills: z.boolean(),
    sandbox: z.array(z.enum(["none"])),
    byok: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof Capabilities>;
