import type {
  ClaimLifecycleOutboxOptions,
  LifecycleOutboxRecord,
  LifecycleOutboxTopic,
  RetryLifecycleOutboxOptions,
} from "./types.js";

export const MAX_LIFECYCLE_OUTBOX_CLAIM = 100;
export const MAX_LIFECYCLE_OUTBOX_ERROR_CHARS = 1_024;

const TOPICS = new Set<LifecycleOutboxTopic>(["session.tombstoned", "session.purge"]);

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

export function assertLifecycleOutboxId(outboxId: number): void {
  if (!Number.isSafeInteger(outboxId) || outboxId <= 0) throw new Error("outboxId must be a positive safe integer");
}

export function assertLifecycleOutboxClaimToken(claimToken: string): void {
  if (typeof claimToken !== "string" || claimToken.length === 0 || claimToken.length > 64) {
    throw new Error("claimToken must contain 1 to 64 characters");
  }
}

export function validateClaimLifecycleOutboxOptions(options: ClaimLifecycleOutboxOptions): {
  topics: LifecycleOutboxTopic[];
  leaseUntilMs: number;
} {
  assertTimestamp(options.nowMs, "nowMs");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > MAX_LIFECYCLE_OUTBOX_CLAIM) {
    throw new Error(`limit must be between 1 and ${MAX_LIFECYCLE_OUTBOX_CLAIM}`);
  }
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new Error("leaseMs must be a positive safe integer");
  }
  assertLifecycleOutboxClaimToken(options.claimToken);
  const topics = [...new Set(options.topics)];
  for (const topic of topics) {
    if (!TOPICS.has(topic)) throw new Error(`unsupported lifecycle outbox topic: ${String(topic)}`);
  }
  const leaseUntilMs = options.nowMs + options.leaseMs;
  assertTimestamp(leaseUntilMs, "leaseUntilMs");
  return { topics, leaseUntilMs };
}

export function validateRenewLifecycleOutboxClaim(
  outboxId: number,
  claimToken: string,
  nowMs: number,
  leaseMs: number,
): number {
  assertLifecycleOutboxId(outboxId);
  assertLifecycleOutboxClaimToken(claimToken);
  assertTimestamp(nowMs, "nowMs");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be a positive safe integer");
  const leaseUntilMs = nowMs + leaseMs;
  assertTimestamp(leaseUntilMs, "leaseUntilMs");
  return leaseUntilMs;
}

export function validateLifecycleOutboxAck(outboxId: number, claimToken: string, atMs: number): void {
  assertLifecycleOutboxId(outboxId);
  assertLifecycleOutboxClaimToken(claimToken);
  assertTimestamp(atMs, "acknowledgement timestamp");
}

export function validateRetryLifecycleOutboxOptions(options: RetryLifecycleOutboxOptions): void {
  assertTimestamp(options.failedAtMs, "failedAtMs");
  assertTimestamp(options.availableAtMs, "availableAtMs");
  if (
    options.maxAttempts !== undefined
    && (!Number.isInteger(options.maxAttempts) || options.maxAttempts <= 0 || options.maxAttempts > 0xffff_ffff)
  ) {
    throw new Error("maxAttempts must be a positive 32-bit integer");
  }
}

/** Store only one bounded message: never an Error stack, control characters, or obvious credentials. */
export function sanitizeLifecycleOutboxError(error: unknown): string {
  let raw: string;
  try {
    if (error instanceof Error) raw = error.message;
    else if (typeof error === "string") raw = error;
    else if (error == null) raw = "worker failure";
    else if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") raw = String(error);
    else raw = "non-error worker failure";
  } catch {
    raw = "worker failure";
  }
  const cleaned = raw
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|password)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned || "worker failure").slice(0, MAX_LIFECYCLE_OUTBOX_ERROR_CHARS).join("");
}

export function parseLifecycleOutboxEnvelope(
  topicValue: unknown,
  payloadValue: unknown,
): Pick<LifecycleOutboxRecord, "topic" | "payload"> {
  if (!TOPICS.has(topicValue as LifecycleOutboxTopic)) {
    throw new Error(`unsupported lifecycle outbox topic: ${String(topicValue)}`);
  }
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) {
    throw new Error("invalid lifecycle outbox payload");
  }
  const payload = payloadValue as Record<string, unknown>;
  if (
    typeof payload.sessionId !== "string"
    || payload.sessionId.length === 0
    || !Number.isSafeInteger(payload.deletionGeneration)
    || Number(payload.deletionGeneration) <= 0
  ) {
    throw new Error("invalid lifecycle outbox payload identity");
  }
  if (topicValue === "session.tombstoned") {
    if (!Number.isSafeInteger(payload.eventSeq) || Number(payload.eventSeq) <= 0) {
      throw new Error("session.tombstoned payload requires a positive eventSeq");
    }
    return {
      topic: "session.tombstoned",
      payload: {
        sessionId: payload.sessionId,
        deletionGeneration: Number(payload.deletionGeneration),
        eventSeq: Number(payload.eventSeq),
      },
    };
  }
  return {
    topic: "session.purge",
    payload: {
      sessionId: payload.sessionId,
      deletionGeneration: Number(payload.deletionGeneration),
    },
  };
}
