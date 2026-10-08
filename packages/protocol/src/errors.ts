import { z } from "zod";

export const ErrorCode = z.enum([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "session_busy",
  "session_archived",
  "session_lease_conflict",
  "idempotency_conflict",
  // NOTE: `quota_exceeded` (429) arrives with per-tenant quotas in M4; `limits_exceeded` was removed
  // because request limits are clamped (mergeLimits takes the min), never rejected. Do not declare a
  // code before something can return it — clients write dead branches for it.
  "provider_error",
  "approval_expired",
  "draining",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  session_busy: 409,
  session_archived: 409,
  session_lease_conflict: 409,
  idempotency_conflict: 409,
  provider_error: 502,
  approval_expired: 410,
  draining: 503,
  internal_error: 500,
};

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    /** for provider_error: whether the client may retry */
    retryable: z.boolean().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get status(): number {
    return HTTP_STATUS[this.code];
  }
  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details, retryable: this.retryable } };
  }
}
