import { isCanonicalId } from "@agent-service/protocol";
import type { CommitResult } from "./types.js";
import type { ErasureWriteAuthorization } from "./subject-lifecycle.js";
import { validateErasureWriteAuthorization } from "./subject-lifecycle.js";

/**
 * Least-privilege view used by the internal erasure path. Deliberately excludes every content,
 * accounting and presentation field: the host only needs to know whether local execution has a
 * durable active projection and whether the session is already tombstoned.
 */
export interface ErasureSessionHead {
  sessionId: string;
  tenantId: string;
  userId: string;
  activeTurnId?: string;
  deleted: boolean;
  deletionGeneration: number;
}

interface ErasureSessionActionBase {
  authority: ErasureWriteAuthorization;
  sessionId: string;
  /** Session lease fence acquired by the runner before invoking this capability. */
  fence: number;
}

/**
 * The caller chooses only a fixed lifecycle action. Existing turn/approval/item rows and every
 * emitted event are loaded and derived by the store under the same locks as the authority check;
 * callers cannot provide replacement bodies, insert resources, schedule purge or mutate usage.
 */
export type ErasureSessionAction = ErasureSessionActionBase & (
  | { action: "fence" }
  | { action: "settle" | "tombstone"; atMs: number }
);

export interface ErasureSessionStore {
  /** Available only to a live user-erasure claim in draining or tombstoning. */
  getErasureSessionHead(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<ErasureSessionHead | null>;

  /**
   * Validate authority and mutate the locked session atomically. `fence` is valid in draining or
   * tombstoning; `settle` and `tombstone` require tombstoning. Implementations must update existing
   * resources only. `tombstone` also proves there is no live child and leaves purge unscheduled.
   */
  applyErasureSessionAction(input: ErasureSessionAction): Promise<CommitResult>;
}

export function validateErasureSessionAction(input: ErasureSessionAction): void {
  validateErasureWriteAuthorization(input.authority);
  if (!isCanonicalId("sess", input.sessionId) || !Number.isSafeInteger(input.fence) || input.fence <= 0) {
    throw new Error("invalid erasure session action identity");
  }
  if (input.action === "fence") {
    const keys = new Set(["authority", "sessionId", "fence", "action"]);
    for (const key of Object.keys(input)) {
      if (!keys.has(key)) throw new Error(`erasure fence action must not contain ${key}`);
    }
    return;
  }
  if (input.action !== "settle" && input.action !== "tombstone") {
    throw new Error("invalid erasure session action");
  }
  if (!Number.isSafeInteger(input.atMs) || input.atMs < 0) {
    throw new Error("invalid erasure session action timestamp");
  }
  const keys = new Set(["authority", "sessionId", "fence", "action", "atMs"]);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new Error(`erasure ${input.action} action must not contain ${key}`);
  }
}
