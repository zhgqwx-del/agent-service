import { isCanonicalId } from "@agent-service/protocol";
import type { ErasureWriteAuthorization } from "./subject-lifecycle.js";
import { validateErasureWriteAuthorization } from "./subject-lifecycle.js";

export type ErasureScanPhase = "draining" | "tombstoning" | "reconciling_usage";

/** Content-free session identity used by the erasure worker. */
export interface ErasureSessionRef {
  sessionId: string;
  parentSessionId?: string;
  deleted: boolean;
  deletionGeneration: number;
  /**
   * Present only for the `reconciling_usage` catalog. This content-free bit proves that the
   * tombstone marker, terminal event and both lifecycle outbox intents agree while the caller's
   * exact job claim is still authoritative. Absence must never be interpreted as success.
   */
  tombstoneProofValid?: boolean;
}

export interface ErasureSessionPage {
  data: ErasureSessionRef[];
  nextCursor?: string;
}

/** Claim-bound completion proof. Counts contain no user content or raw identifiers. */
export interface ErasureSubjectProgress {
  totalSessions: number;
  liveSessions: number;
  liveLeafSessions: number;
  tombstonedSessions: number;
  legacyGenerationZeroSessions: number;
  reconciledUsageSessions: number;
  unreconciledUsageSessions: number;
  orphanOrMismatchedUsageRows: number;
}

export interface ErasureSessionQuery {
  phase: ErasureScanPhase;
  afterSessionId?: string;
  limit: number;
  /** Trusted worker time used for the exact claim-lease boundary. */
  nowMs: number;
}

export interface ErasureProgressQuery {
  phase: ErasureScanPhase;
  nowMs: number;
}

/**
 * Separate read capability for a claimed erasure job. Invalid or stale authority must throw and
 * must never masquerade as an empty page/progress result.
 */
export interface ErasureSessionCatalogStore {
  listErasureSessions(
    authority: ErasureWriteAuthorization,
    query: ErasureSessionQuery,
  ): Promise<ErasureSessionPage>;

  inspectErasureSubjectProgress(
    authority: ErasureWriteAuthorization,
    query: ErasureProgressQuery,
  ): Promise<ErasureSubjectProgress>;
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

export function validateErasureScanPhase(phase: string): asserts phase is ErasureScanPhase {
  if (phase !== "draining" && phase !== "tombstoning" && phase !== "reconciling_usage") {
    throw new Error("invalid erasure scan phase");
  }
}

export function validateErasureSessionQuery(
  authority: ErasureWriteAuthorization,
  query: ErasureSessionQuery,
): void {
  validateErasureWriteAuthorization(authority);
  validateErasureScanPhase(query.phase);
  validateTimestamp(query.nowMs, "nowMs");
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) {
    throw new Error("erasure session page limit must be between 1 and 200");
  }
  if (query.afterSessionId !== undefined && !isCanonicalId("sess", query.afterSessionId)) {
    throw new Error("invalid erasure session cursor");
  }
}

export function validateErasureProgressQuery(
  authority: ErasureWriteAuthorization,
  query: ErasureProgressQuery,
): void {
  validateErasureWriteAuthorization(authority);
  validateErasureScanPhase(query.phase);
  validateTimestamp(query.nowMs, "nowMs");
}
