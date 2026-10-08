import { isCanonicalId } from "@agent-service/protocol";
import type { UsageReconciliationRecord } from "./types.js";
import type { ErasureWriteAuthorization } from "./subject-lifecycle.js";
import { validateErasureWriteAuthorization } from "./subject-lifecycle.js";

/**
 * Content-free deterministic failure: a stored tombstone no longer has the marker/event/outbox
 * proof required before billing reconciliation. Transport/database failures use their native error
 * and remain retryable; workers may durably block only this explicit integrity result.
 */
export class ErasureTombstoneIntegrityError extends Error {
  override readonly name = "ErasureTombstoneIntegrityError";

  constructor() {
    super("erasure tombstone integrity proof is invalid");
  }
}

/** Content-free session selector accepted by the claimed erasure worker. */
export interface ErasureUsageReconciliationInput {
  sessionId: string;
  deletionGeneration: number;
  /** Trusted worker time used for the exact claim-lease boundary and verification timestamp. */
  nowMs: number;
}

/**
 * Claim-bound usage capability for erasure orchestration. Implementations must revalidate the
 * durable request, subject generation, claim identity, lease and phase in the same atomic boundary
 * that may assign a legacy usage id, insert a billing fact or publish a reconciliation record.
 */
export interface ErasureUsageReconciliationStore {
  reconcileErasureSessionUsage(
    authority: ErasureWriteAuthorization,
    input: ErasureUsageReconciliationInput,
  ): Promise<UsageReconciliationRecord>;
}

export function validateErasureUsageReconciliationInput(
  authority: ErasureWriteAuthorization,
  input: ErasureUsageReconciliationInput,
): void {
  validateErasureWriteAuthorization(authority);
  if (!isCanonicalId("sess", input.sessionId)) throw new Error("invalid erasure usage session id");
  if (!Number.isSafeInteger(input.deletionGeneration) || input.deletionGeneration <= 0) {
    throw new Error("erasure usage deletionGeneration must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error("erasure usage nowMs must be a non-negative safe integer");
  }
}
