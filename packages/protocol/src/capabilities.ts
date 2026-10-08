import { z } from "zod";

export const PROTOCOL_VERSION = "2026-10-08" as const;

export const Capabilities = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  service: z.enum(["agent-runner", "agent-router"]),
  features: z.object({
    streaming: z.literal(true),
    replay: z.object({ persistedEvents: z.literal(true), hotWindowMs: z.number().int() }),
    approvals: z.literal(true),
    sessionLifecycle: z.array(z.enum(["archive", "unarchive", "tombstone", "purge"])),
    dynamicTools: z.boolean(),
    mcp: z.array(z.enum(["streamable-http", "stdio"])),
    skills: z.boolean(),
    sandbox: z.array(z.enum(["none"])),
    byok: z.boolean(),
  }),
});
export type Capabilities = z.infer<typeof Capabilities>;
