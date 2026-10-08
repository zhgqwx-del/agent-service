import { createHash, randomUUID } from "node:crypto";
import { UserId } from "@agent-service/protocol";

export type DataSubjectKind = "tenant" | "user";
export type SubjectLifecycleState = "active" | "deleting" | "erased";

export interface SubjectLifecycleRecord {
  tenantId: string;
  subjectKind: DataSubjectKind;
  /** tenant id for tenant scope, user id for user scope */
  subjectId: string;
  state: SubjectLifecycleState;
  generation: number;
  activeRequestId?: string;
  legalHoldAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Erasure deliberately stops at `gated` in the first activation slice. Later workers may advance
 * through the other durable states, but `completed` must mean that physical erasure really happened.
 */
export type ErasureRequestStatus =
  | "gated"
  | "draining"
  | "tombstoning"
  | "reconciling_usage"
  | "awaiting_purge_policy"
  | "purging"
  | "blocked"
  | "completed";

export interface ErasureRequestRecord {
  requestId: string;
  tenantId: string;
  subjectKind: DataSubjectKind;
  subjectId: string;
  generation: number;
  status: ErasureRequestStatus;
  requestedByKeyId: string;
  /** Stored only for request replay; never return it from a public response. */
  idempotencyKey: string;
  requestHash: string;
  createdAtMs: number;
  gatedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  counts?: Record<string, number>;
  checksum?: string;
}

export interface ErasureAuditEvent {
  requestId: string;
  seq: number;
  type: "erasure/gated" | "erasure/status_changed" | "erasure/blocked" | "erasure/completed";
  /** Audit payloads may contain counts/checksums/status only, never prompts or resource bodies. */
  payload: Record<string, unknown>;
  emittedAtMs: number;
}

export interface RequestUserErasureInput {
  requestId: string;
  tenantId: string;
  userId: string;
  requestedByKeyId: string;
  idempotencyKey: string;
  requestHash: string;
  atMs: number;
}

/** Separate capability from SessionStore: erasure orchestration must not acquire general write APIs. */
export interface SubjectLifecycleStore {
  requestUserErasure(input: RequestUserErasureInput): Promise<ErasureRequestRecord>;
  getUserErasureRequest(tenantId: string, userId: string, requestId: string): Promise<ErasureRequestRecord | null>;
  getSubjectLifecycle(tenantId: string, subjectKind: DataSubjectKind, subjectId: string): Promise<SubjectLifecycleRecord | null>;
  listErasureAuditEvents(requestId: string): Promise<ErasureAuditEvent[]>;
}

/** New user-owned writes are rejected once an erasure gate has linearized. */
export class SubjectDeletingError extends Error {
  constructor(public readonly tenantId: string, public readonly userId?: string) {
    super(userId ? "the data subject is being erased" : "the tenant is being erased");
    this.name = "SubjectDeletingError";
  }
}

export class ErasureIdempotencyMismatchError extends Error {
  constructor() {
    super("this Idempotency-Key was already used for a different erasure request");
    this.name = "ErasureIdempotencyMismatchError";
  }
}

export function newErasureRequestId(): string {
  return `erase_${randomUUID()}`;
}

export function userErasureRequestHash(tenantId: string, userId: string): string {
  return createHash("sha256").update(JSON.stringify(["user", tenantId, userId])).digest("hex");
}

export function validateRequestUserErasureInput(input: RequestUserErasureInput): void {
  if (!/^erase_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.requestId)) {
    throw new Error("invalid erasure request id");
  }
  if (!input.tenantId || input.tenantId.length > 128) throw new Error("invalid erasure tenant id");
  if (!UserId.safeParse(input.userId).success) throw new Error("invalid erasure user id");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.requestedByKeyId)) throw new Error("invalid erasure actor key id");
  // Match the public Zod contract and MySQL VARCHAR(256) character limit. Restricting bytes here
  // would accept a request at HTTP validation and then turn a valid Unicode key into a server error.
  if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
    throw new Error("invalid erasure idempotency key");
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error("invalid erasure request hash");
  if (!Number.isSafeInteger(input.atMs) || input.atMs < 0) throw new Error("invalid erasure request timestamp");
  const expectedHash = userErasureRequestHash(input.tenantId, input.userId);
  if (input.requestHash !== expectedHash) throw new Error("erasure request hash does not match its subject");
}

export function subjectLifecycleKey(tenantId: string, subjectKind: DataSubjectKind, subjectId: string): string {
  return JSON.stringify([tenantId, subjectKind, subjectId]);
}
