import { z } from "zod";

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
    dynamicTools: z.boolean(),
    mcp: z.array(z.enum(["streamable-http", "stdio"])),
    skills: z.boolean(),
    sandbox: z.array(z.enum(["none"])),
    byok: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof Capabilities>;
