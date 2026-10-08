import { z } from "zod";
import { idSchema, StopReason, Usage } from "./common.js";
import { Item } from "./item.js";
import { Approval } from "./approval.js";
import { SessionStatus, Turn } from "./session.js";

/**
 * Event stream contract.
 *
 * - Persisted events carry a per-session monotonic `seq` and are replayable via `GET /events?after=<seq>`.
 * - Delta events (`*.delta`, `heartbeat`) are NOT persisted and carry no `seq` of their own; they are only
 *   delivered live. Clients reconstruct text from the `item/completed` snapshot after a reconnect.
 */
const envelope = {
  sessionId: idSchema("sess"),
  emittedAtMs: z.number().int(),
};
const persisted = { ...envelope, seq: z.number().int().nonnegative() };
const live = { ...envelope, seq: z.undefined().optional() };

export const Event = z.discriminatedUnion("type", [
  z.object({ ...persisted, type: z.literal("session/created") }),
  z.object({ ...persisted, type: z.literal("session/status/changed"), status: SessionStatus }),
  z.object({ ...persisted, type: z.literal("session/compacted"), itemId: idSchema("item") }),
  z.object({ ...persisted, type: z.literal("session/archived") }),
  z.object({ ...persisted, type: z.literal("session/unarchived") }),

  z.object({ ...persisted, type: z.literal("turn/started"), turn: Turn }),
  z.object({ ...persisted, type: z.literal("turn/steered"), turnId: idSchema("turn"), itemId: idSchema("item") }),
  z.object({
    ...persisted,
    type: z.literal("turn/completed"),
    turn: Turn,
    stopReason: StopReason,
  }),

  z.object({ ...persisted, type: z.literal("item/started"), item: Item }),
  z.object({ ...persisted, type: z.literal("item/completed"), item: Item }),

  z.object({ ...persisted, type: z.literal("approval/requested"), approval: Approval }),
  z.object({ ...persisted, type: z.literal("approval/resolved"), approval: Approval }),

  z.object({
    ...persisted,
    type: z.literal("usage/updated"),
    turnId: idSchema("turn"),
    step: z.number().int(),
    stepUsage: Usage,
    turnUsage: Usage,
    sessionUsage: Usage,
    /** model/provider that served this step (after fallback) */
    runtime: z.object({ provider: z.string(), model: z.string() }),
  }),

  z.object({ ...persisted, type: z.literal("warning"), code: z.string(), message: z.string() }),
  z.object({ ...persisted, type: z.literal("error"), code: z.string(), message: z.string(), turnId: idSchema("turn").optional() }),

  // ---- live-only ----
  z.object({ ...live, type: z.literal("item/agentMessage/delta"), itemId: idSchema("item"), turnId: idSchema("turn"), delta: z.string() }),
  z.object({ ...live, type: z.literal("item/reasoning/delta"), itemId: idSchema("item"), turnId: idSchema("turn"), delta: z.string() }),
  z.object({ ...live, type: z.literal("item/toolCall/argsDelta"), turnId: idSchema("turn"), toolCallId: z.string(), itemId: idSchema("item").optional(), delta: z.string() }),
  z.object({ ...live, type: z.literal("heartbeat") }),
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;
export type PersistedEvent = Extract<Event, { seq: number }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A persisted event before the store assigns its seq. */
export type EventInput = DistributiveOmit<PersistedEvent, "seq">;
export type LiveEvent = Exclude<Event, PersistedEvent>;

export const isPersistedEvent = (e: Event): e is PersistedEvent => typeof (e as { seq?: unknown }).seq === "number";

/** Event types a client may exclude on subscription (`?exclude=item/reasoning/delta,...`). */
export const EXCLUDABLE_EVENT_TYPES = [
  "item/reasoning/delta",
  "item/toolCall/argsDelta",
  "item/agentMessage/delta",
  "usage/updated",
  "heartbeat",
] as const satisfies readonly EventType[];
export type ExcludableEventType = (typeof EXCLUDABLE_EVENT_TYPES)[number];
