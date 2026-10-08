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
