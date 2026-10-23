import { z } from "zod";
import { isCanonicalId } from "./common.js";

/** Private fresh observation, not public SDK/OpenAPI or a writer proof. */
export const INTERNAL_SESSION_AUTHORITY_OWNER_PATH = "/_internal/session-authority-v1/owner" as const;
export const INTERNAL_SESSION_AUTHORITY_ACK_HEADER = "x-agent-service-session-authority" as const;
export const INTERNAL_SESSION_AUTHORITY_ACK_VALUE = "session-authority-owner-v1" as const;
export const SessionAuthorityObservationRequest = z.object({
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().refine(value => isCanonicalId("sess", value)),
}).strict();
export const SessionAuthorityObservationIdentity = z.object({
  protocol: z.enum(["mysql-live-session-v1", "memory-live-session-v1"]),
  backend: z.enum(["mysql", "memory"]), namespaceSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.protocol === (value.backend === "mysql" ? "mysql-live-session-v1" : "memory-live-session-v1"));
export const SessionAuthorityObservationOwner = z.object({
  ownerId: z.string().min(1).max(128), ownerAddr: z.string().min(1).max(2048),
  fence: z.number().int().safe().positive(), expiresAtDbMs: z.number().int().safe().positive(),
  observedAtDbMs: z.number().int().safe().nonnegative(),
  authority: z.enum(["mysql-live-session-v1", "memory-live-session-v1"]),
}).strict().refine(value => value.expiresAtDbMs > value.observedAtDbMs);
export const SessionAuthorityObservationResponse = SessionAuthorityObservationRequest.extend({
  identity: SessionAuthorityObservationIdentity, owner: SessionAuthorityObservationOwner.nullable(),
}).strict().refine(value => value.owner === null || value.owner.authority === value.identity.protocol);
export type SessionAuthorityObservation = z.infer<typeof SessionAuthorityObservationResponse>;
