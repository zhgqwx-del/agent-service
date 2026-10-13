import { createHash } from "node:crypto";

/** Ordinary API DELETE only. This is a retention floor, never an execution deadline. */
export const ORDINARY_SESSION_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const ORDINARY_SESSION_DELETE_GRACE_SCOPE = "ordinary-api-delete-grace-v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;

/** No generic lifecycle batch may claim ordinary provenance, even via a runtime cast. */
export function assertNoCallerOrdinaryDeleteOrigin(lifecycle: unknown): void {
  if (lifecycle && typeof lifecycle === "object" && "ordinaryDeleteGraceOrigin" in lifecycle) {
    throw new Error("ordinary DELETE origin is not accepted from a generic lifecycle batch");
  }
}

function safeMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

/**
 * Binds the terminal event and both immutable outbox identities to the live session owner.
 * The owner tuple lives only on the sessions row; T3f deletes that row in its existing
 * destructive transaction. Neither this digest nor a seal is a deletion authorization.
 */
export function ordinarySessionDeleteOriginSha256(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  deletionGeneration: number;
  deletedAtMs: number;
  eventSeq: number;
  observedDbMs: number;
}): string {
  for (const key of ["tenantId", "userId", "sessionId"] as const) {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > 128) {
      throw new Error(`ordinary DELETE ${key} is invalid`);
    }
  }
  safeMs(input.deletionGeneration, "ordinary DELETE generation");
  safeMs(input.deletedAtMs, "ordinary DELETE timestamp");
  safeMs(input.eventSeq, "ordinary DELETE event sequence");
  safeMs(input.observedDbMs, "ordinary DELETE source database time");
  if (input.deletionGeneration < 1 || input.eventSeq < 1) {
    throw new Error("ordinary DELETE terminal identity is invalid");
  }
  return createHash("sha256").update(JSON.stringify([
    ORDINARY_SESSION_DELETE_GRACE_SCOPE,
    input.tenantId,
    input.userId,
    input.sessionId,
    input.deletionGeneration,
    input.deletedAtMs,
    input.eventSeq,
    input.observedDbMs,
    ["session.tombstoned", input.sessionId, input.deletionGeneration, input.eventSeq],
    ["session.purge", input.sessionId, input.deletionGeneration, null],
  ])).digest("hex");
}

export function ordinarySessionDeleteGraceSeal(
  originSha256: string,
  originObservedDbMs: number,
  sealObservedDbMs: number,
): { sealObservedDbMs: number; graceFloorDbMs: number; sealSha256: string } {
  if (!SHA256.test(originSha256)) throw new Error("ordinary DELETE origin digest is invalid");
  safeMs(originObservedDbMs, "ordinary DELETE source database time");
  safeMs(sealObservedDbMs, "ordinary DELETE seal database time");
  if (sealObservedDbMs < originObservedDbMs) {
    throw new Error("ordinary DELETE database clock moved behind the committed origin");
  }
  // databaseNow() floors CURRENT_TIMESTAMP(3). +1 ms makes the floor strictly no earlier
  // than the actual observation after the first transaction committed.
  const graceFloorDbMs = sealObservedDbMs + 1 + ORDINARY_SESSION_DELETE_GRACE_MS;
  safeMs(graceFloorDbMs, "ordinary DELETE grace floor");
  return {
    sealObservedDbMs,
    graceFloorDbMs,
    sealSha256: createHash("sha256").update(JSON.stringify([
      "ordinary-api-delete-grace-seal-v1",
      originSha256,
      sealObservedDbMs,
      graceFloorDbMs,
    ])).digest("hex"),
  };
}

export interface OrdinarySessionDeleteGraceEvidence {
  originSha256: string;
  originObservedDbMs: number;
  sealObservedDbMs?: number;
  graceFloorDbMs?: number;
  sealSha256?: string;
}

export interface OrdinarySessionDeleteGraceView {
  state: "unknown" | "sealed";
  /** A minimum content-retention floor, not a purge due time or permission. */
  graceFloorDbMs?: number;
  executionReady: false;
  physicalPurgeEnabled: false;
}
