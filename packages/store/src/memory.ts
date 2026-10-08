import type {
  AgentDefinition,
  Approval,
  Event,
  Item,
  PersistedEvent,
  ProviderConfig,
  Session,
  Turn,
  ApiKeyScope,
  TenantAuthPolicy,
  Usage,
  UsageQuery,
} from "@agent-service/protocol";
import { DEFAULT_AUTH_POLICY, DEFAULT_SCOPES, addUsage, emptyUsageAccumulator, isCanonicalId } from "@agent-service/protocol";
import { createHash } from "node:crypto";
import {
  BlobConflictError,
  BlobTooLargeError,
  FenceError,
  IdempotencyMismatchError,
  IdempotencyPendingError,
  IdempotencyReplayError,
  SessionArchivedError,
  SessionExistsError,
  SessionGoneError,
  SessionHasChildrenError,
  SessionLifecycleBusyError,
  SessionVersionError,
  assertCommitResourceOwnership,
  assertPureFenceClaim,
  assertTombstoneEvent,
  assignItemSeqs,
  assignTurnSeqEnd,
  backfillAssignedSequences,
  type BlobStore,
  type BlobDescriptor,
  type BillingUsageFact,
  type CommitBatch,
  type CommitResult,
  type EventBus,
  type EventListener,
  type IdempotencyReceipt,
  type IdempotencyReceiptValue,
  type IdempotencyScope,
  type LifecycleOutboxStore,
  type LifecycleOutboxRecord,
  type LeaseAcquireResult,
  type LeaseConflict,
  type LeaseStore,
  type Page,
  type SessionStore,
  type SessionLifecycleRecord,
  type TenantRecord,
  type UsageLifecycleStore,
  type UsageLedgerEntry,
  type UsageReconciliationRecord,
  type ReconcileSessionUsageInput,
  type AnonymizeSessionUsageInput,
} from "./types.js";
import {
  validateBlobContentType,
  validateBlobKey,
  validateBlobMaxBytes,
  validateBlobUploadToken,
} from "./blob/key.js";
import {
  assertLifecycleOutboxId,
  parseLifecycleOutboxEnvelope,
  sanitizeLifecycleOutboxError,
  validateClaimLifecycleOutboxOptions,
  validateLifecycleOutboxAck,
  validateRenewLifecycleOutboxClaim,
  validateRetryLifecycleOutboxOptions,
} from "./lifecycle-outbox.js";
import {
  BLOB_STORAGE_FORMAT,
  BlobStateError,
  assertBlobBindingsMatch,
  isUnexpiredStagingBlob,
  sanitizeBlobDeleteError,
  validateBlobDeleteAck,
  validateBlobDeleteClaim,
  type BindableBlobLookup,
  type BlobCleanupStore,
  type BlobDeleteOutboxRecord,
  type BlobManifest,
  type BlobManifestStore,
  type ClaimBlobDeletesOptions,
  type MarkBlobUploadedInput,
  type ReadyBlobLookup,
  type RetryBlobDeleteOptions,
  type ScheduleStaleBlobsOptions,
  type StageBlobInput,
} from "./blob-lifecycle.js";
import {
  UsageIdentityConflictError,
  UsageLifecycleGenerationError,
  UsageReconciliationError,
  assertUsageAnonymizationAllowed,
  billingUsageFactContentEquals,
  billingUsageFactFromLedger,
  canonicalUsageProjection,
  canonicalizePersistedUsageEvent,
  canonicalizeUsageItem,
  isUsageId,
  newUsageId,
  normalizeHistoricalUsageCost,
  normalizeOperationalUsageCost,
  normalizeRowlessUsageProjection,
  summarizeBillingUsageFacts,
  usageReconciliationSummariesEqual,
  validateReconcileSessionUsageInput,
} from "./usage-lifecycle.js";
import {
  ErasureIdempotencyMismatchError,
  SubjectDeletingError,
  subjectLifecycleKey,
  validateRequestUserErasureInput,
  type DataSubjectKind,
  type ErasureAuditEvent,
  type ErasureRequestRecord,
  type RequestUserErasureInput,
  type SubjectLifecycleRecord,
  type SubjectLifecycleStore,
} from "./subject-lifecycle.js";

const clone = <T>(v: T): T => structuredClone(v);

function paginate<T>(rows: T[], key: (r: T) => string, cursor: string | undefined, limit: number, dir: "asc" | "desc"): Page<T> {
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (dir === "desc") sorted.reverse();
  const start = cursor ? sorted.findIndex((r) => key(r) === cursor) + 1 : 0;
  const slice = sorted.slice(start, start + limit);
  const last = slice.at(-1);
  return { data: slice.map(clone), nextCursor: last && start + limit < sorted.length ? key(last) : null };
}

function validateStageBlobInput(input: StageBlobInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  validateBlobKey(input.storageKey);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(input.storageBackend)) throw new Error("invalid blob storage backend");
  if (input.storageFormat !== BLOB_STORAGE_FORMAT) throw new Error("unsupported blob storage format");
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) throw new Error("invalid blob creation timestamp");
  if (!Number.isSafeInteger(input.stagingExpiresAtMs) || input.stagingExpiresAtMs <= input.createdAtMs) {
    throw new Error("blob staging expiry must be after creation");
  }
}

function validateUploadedBlobInput(input: MarkBlobUploadedInput): void {
  if (!isCanonicalId("sess", input.sessionId) || !isCanonicalId("blob", input.blobId)) {
    throw new Error("invalid blob manifest identity");
  }
  if (!/^[a-z0-9-]{16,64}$/.test(input.uploadToken)) throw new Error("invalid blob upload token");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new Error("invalid blob sha256");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error("invalid blob size");
  if (!Number.isSafeInteger(input.uploadedAtMs) || input.uploadedAtMs < 0) throw new Error("invalid blob upload timestamp");
  if (!Number.isSafeInteger(input.fence) || input.fence < 0) throw new Error("invalid blob fence");
}

/** In-memory store: reference semantics for tests. Single process only. */
export class MemorySessionStore implements SessionStore, LifecycleOutboxStore, BlobManifestStore, BlobCleanupStore, UsageLifecycleStore, SubjectLifecycleStore {
  agents = new Map<string, AgentDefinition>(); // `${tenant}/${id}@${version}`
  sessions = new Map<string, Session>();
  turns = new Map<string, Turn>();
  items = new Map<string, Item>();
  approvals = new Map<string, Approval>();
  events = new Map<string, PersistedEvent[]>();
  providers = new Map<string, { config: ProviderConfig; secret?: { ciphertext: Buffer; keyId: string } }>();
  apiKeys = new Map<string, { tenantId: string; keyId: string; scopes: ApiKeyScope[]; createdAtMs?: number; revokedAtMs?: number }>();
  idem = new Map<string, { value: IdempotencyReceiptValue | null; requestHash?: string; expiresAt: number }>();
  deleted = new Map<string, { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number }>();
  lifecycleOutbox = new Map<string, LifecycleOutboxRecord>();
  private nextLifecycleOutboxId = 1;
  blobManifests = new Map<string, BlobManifest>();
  blobDeleteOutbox = new Map<string, BlobDeleteOutboxRecord>();
  private nextBlobDeleteOutboxId = 1;
  tenants = new Map<string, TenantRecord>();
  billingUsageFacts = new Map<string, BillingUsageFact>();
  usageReconciliations = new Map<string, UsageReconciliationRecord>();
  subjectLifecycles = new Map<string, SubjectLifecycleRecord>();
  erasureRequests = new Map<string, ErasureRequestRecord>();
  erasureAuditEvents = new Map<string, ErasureAuditEvent[]>();
  private erasureIdempotency = new Map<string, string>();

  private subjectRecord(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): SubjectLifecycleRecord | undefined {
    return this.subjectLifecycles.get(subjectLifecycleKey(tenantId, subjectKind, subjectId));
  }

  private isSubjectActive(tenantId: string, userId: string): boolean {
    const tenant = this.subjectRecord(tenantId, "tenant", tenantId);
    const user = this.subjectRecord(tenantId, "user", userId);
    if (!tenant && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "tenant" && request.subjectId === tenantId
    ))) return false;
    if (!user && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "user" && request.subjectId === userId
    ))) return false;
    return (tenant?.state ?? "active") === "active" && (user?.state ?? "active") === "active";
  }

  private assertSubjectWritable(tenantId: string, userId: string): void {
    const tenant = this.subjectRecord(tenantId, "tenant", tenantId);
    if (!tenant && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "tenant" && request.subjectId === tenantId
    ))) throw new SubjectDeletingError(tenantId);
    if (tenant && tenant.state !== "active") throw new SubjectDeletingError(tenantId);
    const user = this.subjectRecord(tenantId, "user", userId);
    if (!user && [...this.erasureRequests.values()].some((request) => (
      request.tenantId === tenantId && request.subjectKind === "user" && request.subjectId === userId
    ))) throw new SubjectDeletingError(tenantId, userId);
    if (user && user.state !== "active") throw new SubjectDeletingError(tenantId, userId);
  }

  private isSessionVisible(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !this.deleted.has(sessionId) && this.isSubjectActive(session.tenantId, session.userId);
  }

  private usageProjectionRows(sessionId: string, turnId?: string) {
    return this.usageLedger.filter((row) => (
      row.sessionId === sessionId && (turnId === undefined || row.turnId === turnId)
    ));
  }

  private sessionForRead(session: Session): Session {
    const projected = clone(session);
    projected.usage = canonicalUsageProjection(
      projected.usage,
      this.usageProjectionRows(projected.id),
      { tenantId: projected.tenantId, userId: projected.userId },
    );
    return projected;
  }

  private turnForRead(turn: Turn, session: Session): Turn {
    const projected = clone(turn);
    projected.usage = canonicalUsageProjection(
      projected.usage,
      this.usageProjectionRows(session.id, projected.id),
      { tenantId: session.tenantId, userId: session.userId },
    );
    return projected;
  }

  private activeSubjectRecord(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
    atMs: number,
  ): SubjectLifecycleRecord {
    return {
      tenantId,
      subjectKind,
      subjectId,
      state: "active",
      generation: 0,
      createdAtMs: atMs,
      updatedAtMs: atMs,
    };
  }

  private erasureIdempotencyKey(input: Pick<RequestUserErasureInput, "tenantId" | "userId" | "idempotencyKey">): string {
    return JSON.stringify([input.tenantId, "user", input.userId, input.idempotencyKey]);
  }

  async requestUserErasure(input: RequestUserErasureInput): Promise<ErasureRequestRecord> {
    validateRequestUserErasureInput(input);
    const tenant = this.subjectRecord(input.tenantId, "tenant", input.tenantId);
    if (tenant && tenant.state !== "active") throw new SubjectDeletingError(input.tenantId);

    const idempotencyKey = this.erasureIdempotencyKey(input);
    const replayId = this.erasureIdempotency.get(idempotencyKey);
    if (replayId) {
      const replay = this.erasureRequests.get(replayId);
      if (!replay) throw new Error("erasure idempotency index is corrupt");
      if (replay.requestHash !== input.requestHash) throw new ErasureIdempotencyMismatchError();
      return clone(replay);
    }

    const userKey = subjectLifecycleKey(input.tenantId, "user", input.userId);
    const existingUser = this.subjectLifecycles.get(userKey);
    if (existingUser && existingUser.state !== "active") {
      const active = existingUser.activeRequestId
        ? this.erasureRequests.get(existingUser.activeRequestId)
        : undefined;
      if (!active) throw new SubjectDeletingError(input.tenantId, input.userId);
      return clone(active);
    }
    if (this.erasureRequests.has(input.requestId)) {
      throw new Error("erasure request id already exists");
    }

    // Clone every row before publishing any map mutation. Invalid/uncloneable audit data can never
    // leave a deleting subject without its request/audit row (or a request without the durable gate).
    const generation = (existingUser?.generation ?? 0) + 1;
    const stagedTenant = tenant
      ? undefined
      : clone(this.activeSubjectRecord(input.tenantId, "tenant", input.tenantId, input.atMs));
    const stagedUser = clone<SubjectLifecycleRecord>({
      ...(existingUser ?? this.activeSubjectRecord(input.tenantId, "user", input.userId, input.atMs)),
      state: "deleting",
      generation,
      activeRequestId: input.requestId,
      // Lifecycle timestamps are monotonic across runners even when their wall clocks are skewed.
      // The request/audit timestamps below intentionally retain the initiating runner's clock.
      updatedAtMs: Math.max(existingUser?.updatedAtMs ?? input.atMs, input.atMs),
    });
    const stagedRequest = clone<ErasureRequestRecord>({
      requestId: input.requestId,
      tenantId: input.tenantId,
      subjectKind: "user",
      subjectId: input.userId,
      generation,
      status: "gated",
      requestedByKeyId: input.requestedByKeyId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAtMs: input.atMs,
      gatedAtMs: input.atMs,
      updatedAtMs: input.atMs,
    });
    const stagedAudit = clone<ErasureAuditEvent>({
      requestId: input.requestId,
      seq: 1,
      type: "erasure/gated",
      payload: { status: "gated", subjectKind: "user", generation },
      emittedAtMs: input.atMs,
    });

    if (stagedTenant) {
      this.subjectLifecycles.set(
        subjectLifecycleKey(input.tenantId, "tenant", input.tenantId),
        stagedTenant,
      );
    }
    this.subjectLifecycles.set(userKey, stagedUser);
    this.erasureRequests.set(input.requestId, stagedRequest);
    this.erasureAuditEvents.set(input.requestId, [stagedAudit]);
    this.erasureIdempotency.set(idempotencyKey, input.requestId);
    return clone(stagedRequest);
  }

  async getUserErasureRequest(
    tenantId: string,
    userId: string,
    requestId: string,
  ): Promise<ErasureRequestRecord | null> {
    const request = this.erasureRequests.get(requestId);
    return request
      && request.tenantId === tenantId
      && request.subjectKind === "user"
      && request.subjectId === userId
      ? clone(request)
      : null;
  }

  async getSubjectLifecycle(
    tenantId: string,
    subjectKind: DataSubjectKind,
    subjectId: string,
  ): Promise<SubjectLifecycleRecord | null> {
    const record = this.subjectRecord(tenantId, subjectKind, subjectId);
    return record ? clone(record) : null;
  }

  async listErasureAuditEvents(requestId: string): Promise<ErasureAuditEvent[]> {
    return (this.erasureAuditEvents.get(requestId) ?? []).map(clone);
  }

  async createAgent(def: AgentDefinition) {
    this.agents.set(`${def.tenantId}/${def.id}@${def.version}`, clone(def));
  }
  async getAgent(tenantId: string, agentId: string, version?: number) {
    if (version !== undefined) return clone(this.agents.get(`${tenantId}/${agentId}@${version}`) ?? null);
    const versions = [...this.agents.values()].filter((a) => a.tenantId === tenantId && a.id === agentId);
    if (!versions.length) return null;
    return clone(versions.reduce((a, b) => (a.version > b.version ? a : b)));
  }
  async listAgents(tenantId: string, opts: { cursor?: string; limit: number }) {
    const latest = new Map<string, AgentDefinition>();
    for (const a of this.agents.values()) {
      if (a.tenantId !== tenantId) continue;
      const cur = latest.get(a.id);
      if (!cur || cur.version < a.version) latest.set(a.id, a);
    }
    return paginate([...latest.values()], (a) => a.id, opts.cursor, opts.limit, "desc");
  }

  async createSession(session: Session): Promise<CommitResult> {
    if (session.lastSeq !== 0) throw new Error("a new session must start at lastSeq 0");
    if (session.fenceToken !== 0) throw new Error("a new session must start at fenceToken 0");
    this.assertSubjectWritable(session.tenantId, session.userId);
    if (this.sessions.has(session.id)) throw new SessionExistsError(session.id);

    // The parent check and child publication are one synchronous critical section. MySQL takes the
    // corresponding parent row lock in its creation transaction, so create-vs-delete has the same
    // linearization semantics in both implementations.
    if (session.parentSessionId) {
      const parent = this.sessions.get(session.parentSessionId);
      if (
        !parent
        || this.deleted.has(session.parentSessionId)
        || parent.tenantId !== session.tenantId
        || parent.userId !== session.userId
      ) {
        throw new SessionGoneError(session.parentSessionId);
      }
    }

    // Stage every fallible clone before publishing either map entry. Session metadata is open-ended
    // and may contain an uncloneable/throwing value; such a failure must not leave a session without
    // its creation event (or vice versa).
    const stagedSession = clone(session);
    // Memory has no durable cross-release state to migrate, but direct/legacy SessionStore callers
    // can still construct a pristine session with pre-0011 emptyUsage(). New-session provenance
    // proves there are no provider rows, so this is the one safe place to restore the cost identity.
    stagedSession.usage = normalizeRowlessUsageProjection(stagedSession.usage);
    const stagedEvent = clone<PersistedEvent>({
      type: "session/created",
      sessionId: session.id,
      emittedAtMs: session.createdAtMs,
      seq: 1,
    });
    stagedSession.lastSeq = 1;
    const tenantKey = subjectLifecycleKey(session.tenantId, "tenant", session.tenantId);
    const userKey = subjectLifecycleKey(session.tenantId, "user", session.userId);
    const stagedTenant = this.subjectLifecycles.has(tenantKey)
      ? undefined
      : clone(this.activeSubjectRecord(session.tenantId, "tenant", session.tenantId, session.createdAtMs));
    const stagedUser = this.subjectLifecycles.has(userKey)
      ? undefined
      : clone(this.activeSubjectRecord(session.tenantId, "user", session.userId, session.createdAtMs));

    if (stagedTenant) this.subjectLifecycles.set(tenantKey, stagedTenant);
    if (stagedUser) this.subjectLifecycles.set(userKey, stagedUser);
    this.sessions.set(session.id, stagedSession);
    this.events.set(session.id, [stagedEvent]);
    return { events: [clone(stagedEvent)], lastSeq: 1 };
  }
  async getSession(tenantId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s && s.tenantId === tenantId && this.isSessionVisible(sessionId) ? this.sessionForRead(s) : null;
  }
  async getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId || session.userId !== userId) return null;
    const tombstone = this.deleted.get(sessionId);
    return {
      session: this.sessionForRead(session),
      deletedAtMs: tombstone?.deletedAtMs,
      purgeAfterMs: tombstone?.purgeAfterMs,
      deletionGeneration: tombstone?.deletionGeneration ?? 0,
    };
  }
  async listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }) {
    const rows = [...this.sessions.values()].filter(
      (s) => s.tenantId === tenantId && this.isSessionVisible(s.id) && (!opts.userId || s.userId === opts.userId) && (opts.includeArchived || !s.archivedAtMs),
    ).map((session) => this.sessionForRead(session));
    return paginate(rows, (s) => s.id, opts.cursor, opts.limit, "desc");
  }

  // ---------- blob ownership manifest ----------
  async stageBlob(input: StageBlobInput): Promise<void> {
    validateStageBlobInput(input);
    const session = this.sessions.get(input.sessionId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
    ) throw new SessionGoneError(input.sessionId);
    if (!this.isSubjectActive(session.tenantId, session.userId)) throw new SessionGoneError(input.sessionId);
    if (session.archivedAtMs !== undefined) throw new SessionArchivedError(input.sessionId);
    if (input.fence < session.fenceToken) throw new FenceError(input.sessionId, input.fence, session.fenceToken);

    const existing = this.blobManifests.get(input.blobId);
    if (existing) {
      if (
        existing.state !== "staging"
        || existing.tenantId !== input.owner.tenantId
        || existing.userId !== input.owner.userId
        || existing.sessionId !== input.sessionId
        || existing.purpose !== input.purpose
        || existing.storageBackend !== input.storageBackend
        || existing.storageFormat !== input.storageFormat
        || existing.storageKey !== input.storageKey
        || existing.uploadToken !== input.uploadToken
        || existing.createdAtMs !== input.createdAtMs
        || existing.stagingExpiresAtMs !== input.stagingExpiresAtMs
      ) throw new BlobStateError(input.blobId);
    } else {
      if ([...this.blobManifests.values()].some((manifest) => manifest.storageKey === input.storageKey)) {
        throw new BlobStateError(input.blobId, "blob storage key is already owned");
      }
      const staged = clone<BlobManifest>({
        blobId: input.blobId,
        tenantId: input.owner.tenantId,
        userId: input.owner.userId,
        sessionId: input.sessionId,
        purpose: input.purpose,
        storageBackend: input.storageBackend,
        storageFormat: input.storageFormat,
        storageKey: input.storageKey,
        uploadToken: input.uploadToken,
        state: "staging",
        stagingExpiresAtMs: input.stagingExpiresAtMs,
        deletionGeneration: 0,
        createdAtMs: input.createdAtMs,
      });
      this.blobManifests.set(input.blobId, staged);
    }
    if (input.fence > session.fenceToken) session.fenceToken = input.fence;
  }

  async markBlobUploaded(input: MarkBlobUploadedInput): Promise<void> {
    validateUploadedBlobInput(input);
    const session = this.sessions.get(input.sessionId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
    ) throw new SessionGoneError(input.sessionId);
    if (!this.isSubjectActive(session.tenantId, session.userId)) throw new SessionGoneError(input.sessionId);
    if (session.archivedAtMs !== undefined) throw new SessionArchivedError(input.sessionId);
    if (input.fence < session.fenceToken) throw new FenceError(input.sessionId, input.fence, session.fenceToken);
    const manifest = this.blobManifests.get(input.blobId);
    if (
      !manifest
      || manifest.state !== "staging"
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.uploadToken !== input.uploadToken
    ) throw new BlobStateError(input.blobId);

    let staged = manifest;
    if (manifest.uploadedAtMs !== undefined) {
      if (
        manifest.sha256 !== input.sha256
        || manifest.sizeBytes !== input.sizeBytes
        || manifest.contentType !== input.contentType
      ) throw new BlobStateError(input.blobId, "uploaded blob descriptor does not match");
    } else {
      staged = clone({
        ...manifest,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        uploadedAtMs: input.uploadedAtMs,
      });
    }
    this.blobManifests.set(input.blobId, staged);
    if (input.fence > session.fenceToken) session.fenceToken = input.fence;
  }

  async getBlobManifest(blobId: string): Promise<BlobManifest | null> {
    const manifest = this.blobManifests.get(blobId);
    return manifest ? clone(manifest) : null;
  }

  async getBindableBlob(input: BindableBlobLookup): Promise<BlobManifest | null> {
    const session = this.sessions.get(input.sessionId);
    const manifest = this.blobManifests.get(input.blobId);
    if (
      !session
      || this.deleted.has(input.sessionId)
      || !this.isSubjectActive(session.tenantId, session.userId)
      || session.archivedAtMs !== undefined
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
      || !manifest
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.purpose !== input.purpose
      || !isUnexpiredStagingBlob(manifest, Date.now())
      || manifest.itemId !== undefined
      || manifest.uploadedAtMs === undefined
      || manifest.sha256 === undefined
      || manifest.sizeBytes === undefined
    ) return null;
    return clone(manifest);
  }

  async getReadyBlob(input: ReadyBlobLookup): Promise<BlobManifest | null> {
    const session = this.sessions.get(input.sessionId);
    const manifest = this.blobManifests.get(input.blobId);
    const item = manifest?.itemId ? this.items.get(manifest.itemId) : undefined;
    if (
      !session
      || this.deleted.has(input.sessionId)
      || !this.isSubjectActive(session.tenantId, session.userId)
      || session.tenantId !== input.owner.tenantId
      || session.userId !== input.owner.userId
      || !manifest
      || manifest.tenantId !== input.owner.tenantId
      || manifest.userId !== input.owner.userId
      || manifest.sessionId !== input.sessionId
      || manifest.state !== "ready"
      || (input.itemId !== undefined && manifest.itemId !== input.itemId)
      || (input.purpose !== undefined && manifest.purpose !== input.purpose)
      || !item
      || item.sessionId !== input.sessionId
    ) return null;
    return clone(manifest);
  }

  async commit(batch: CommitBatch): Promise<CommitResult> {
    assertPureFenceClaim(batch);
    assertTombstoneEvent(batch);
    assertCommitResourceOwnership(batch);
    assertBlobBindingsMatch(batch.items, batch.blobBindings);
    const s = this.sessions.get(batch.sessionId);
    if (!s || this.deleted.has(batch.sessionId)) throw new SessionGoneError(batch.sessionId);
    if (!this.isSubjectActive(s.tenantId, s.userId)) throw new SessionGoneError(batch.sessionId);
    const expectedOwner = batch.lifecycle ?? batch.fenceClaim;
    if (expectedOwner && (expectedOwner.tenantId !== s.tenantId || expectedOwner.userId !== s.userId)) {
      throw new SessionGoneError(batch.sessionId);
    }
    if (batch.fence < s.fenceToken) throw new FenceError(batch.sessionId, batch.fence, s.fenceToken);
    if (batch.lifecycle) {
      if (
        (batch.lifecycle.type === "archive" || batch.lifecycle.type === "tombstone")
        && s.status.type === "active"
        && batch.sessionPatch?.status?.type !== "idle"
      ) {
        throw new SessionLifecycleBusyError(batch.sessionId);
      }
    } else if (!batch.fenceClaim && s.archivedAtMs !== undefined) {
      throw new SessionArchivedError(batch.sessionId);
    }
    if (batch.expectedLastSeq !== undefined && batch.expectedLastSeq !== s.lastSeq) {
      throw new SessionVersionError(batch.sessionId, batch.expectedLastSeq, s.lastSeq);
    }

    let stagedTombstone: { deletedAtMs: number; purgeAfterMs?: number; deletionGeneration: number } | undefined;
    if (batch.lifecycle?.type === "tombstone") {
      const transition = batch.lifecycle;
      const currentGeneration = this.deleted.get(batch.sessionId)?.deletionGeneration ?? 0;
      if (transition.deletionGeneration !== currentGeneration + 1) {
        throw new Error(`deletion generation must advance from ${currentGeneration} to ${currentGeneration + 1}`);
      }
      if ([...this.sessions.values()].some((candidate) => (
        candidate.parentSessionId === batch.sessionId && !this.deleted.has(candidate.id)
      ))) {
        throw new SessionHasChildrenError(batch.sessionId);
      }
      stagedTombstone = clone({
        deletedAtMs: transition.atMs,
        purgeAfterMs: transition.purgeAfterMs ?? undefined,
        deletionGeneration: transition.deletionGeneration,
      });
    }

    if (batch.fenceClaim) {
      // Clone before mutation so accessors/proxies cannot leave a half-applied claim. A claim is not
      // a business update: updatedAt, lastSeq and every projection remain byte-for-byte unchanged.
      clone(batch.fenceClaim);
      s.fenceToken = batch.fence;
      return { events: [], lastSeq: s.lastSeq };
    }

    // Primary keys are global in MySQL. Preflight the same identity constraint here so a resource
    // from another session can never be overwritten merely by presenting a forged sessionId in a
    // replacement body. Nested event snapshots participate in the same identity check.
    this.assertCommitResourceIdentities(batch);

    const stagedReadyBlobs = new Map<string, BlobManifest>();
    const readyAtMs = Date.now();
    for (const binding of batch.blobBindings ?? []) {
      const manifest = this.blobManifests.get(binding.blobId);
      if (
        !manifest
        || manifest.tenantId !== s.tenantId
        || manifest.userId !== s.userId
        || manifest.sessionId !== batch.sessionId
        || manifest.purpose !== binding.purpose
        || manifest.uploadedAtMs === undefined
        || manifest.sha256 === undefined
        || manifest.sizeBytes === undefined
      ) throw new BlobStateError(binding.blobId);
      if (manifest.state === "ready" && manifest.itemId === binding.itemId) continue;
      if (!isUnexpiredStagingBlob(manifest, readyAtMs) || manifest.itemId !== undefined) {
        throw new BlobStateError(binding.blobId);
      }
      const staged = clone({
        ...manifest,
        state: "ready" as const,
        itemId: binding.itemId,
        readyAtMs,
        stagingExpiresAtMs: undefined,
      });
      delete staged.stagingExpiresAtMs;
      stagedReadyBlobs.set(binding.blobId, staged);
    }

    // Validate every fallible invariant before mutating any map. This gives the in-memory reference
    // implementation the same all-or-nothing semantics as the MySQL transaction.
    let idemMapKey: string | undefined;
    if (batch.idempotency) {
      const receipt = batch.idempotency;
      if (receipt.scope.tenantId !== s.tenantId || receipt.scope.userId !== s.userId || receipt.scope.sessionId !== s.id) {
        throw new Error("idempotency scope does not match the session");
      }
      idemMapKey = this.idempotencyMapKey(receipt.scope, receipt.key);
      const cur = this.idem.get(idemMapKey);
      // Never replace a legacy reservation, even after its nominal expiry. An old runner may resume
      // and complete it with an unconditional update, corrupting a receipt written in its place.
      if (cur?.value === null) throw new IdempotencyPendingError(cur.expiresAt);
      if (cur && cur.expiresAt >= Date.now() && cur.value) {
        const stored: IdempotencyReceipt = { requestHash: cur.requestHash, value: clone(cur.value), expiresAtMs: cur.expiresAt };
        if (!stored.requestHash || stored.requestHash === receipt.requestHash) throw new IdempotencyReplayError(stored);
        throw new IdempotencyMismatchError(stored);
      }
    }
    const stagedUsage: UsageLedgerEntry[] = (batch.usageEntries ?? []).map((entry) => ({
      ...clone(entry), tenantId: s.tenantId, userId: s.userId, sessionId: s.id,
    }));
    const usageKeys = new Set(this.usageLedger.map((entry) => JSON.stringify([entry.sessionId, entry.turnId, entry.step])));
    const usageIds = new Set<string>();
    if (stagedUsage.length > 0) {
      for (const entry of this.usageLedger) {
        if (entry.usageId === undefined) continue;
        if (!isUsageId(entry.usageId)) throw new UsageReconciliationError("stored operational usage has an invalid usage id");
        if (usageIds.has(entry.usageId)) throw new UsageIdentityConflictError(entry.usageId);
        usageIds.add(entry.usageId);
      }
    }
    const stagedBillingFacts = new Map<string, BillingUsageFact>();
    for (const entry of stagedUsage) {
      const key = JSON.stringify([entry.sessionId, entry.turnId, entry.step]);
      if (usageKeys.has(key)) throw new Error(`duplicate usage entry for turn ${entry.turnId} step ${entry.step}`);
      usageKeys.add(key);
      if (!isUsageId(entry.usageId)) throw new Error("new usage writes require a valid random usage id");
      if (usageIds.has(entry.usageId) || this.billingUsageFacts.has(entry.usageId)) {
        throw new UsageIdentityConflictError(entry.usageId);
      }
      usageIds.add(entry.usageId);
      stagedBillingFacts.set(entry.usageId, billingUsageFactFromLedger(entry as UsageLedgerEntry & { usageId: string }));
    }

    let seq = s.lastSeq;
    const out: PersistedEvent[] = [];
    for (const e of batch.events ?? []) {
      seq += 1;
      out.push({ ...e, seq } as PersistedEvent);
    }

    // `Item.args`, tool-result `details`, and session metadata are intentionally typed as unknown.
    // Clone the entire write-set before changing persistent state so an uncloneable value cannot
    // leave a partial event log (or advance the fence without advancing lastSeq).
    let stagedEvents = out.map(clone);
    let stagedItems = (batch.items ?? []).map(clone);
    let stagedTurn = batch.turn ? clone(batch.turn) : undefined;
    const stagedApprovals = (batch.approvals ?? []).map(clone);
    const stagedIdempotencyValue = batch.idempotency ? clone(batch.idempotency.value) : undefined;
    const stagedSessionPatch = batch.sessionPatch ? clone(batch.sessionPatch) : {};
    const stagedLifecycle = batch.lifecycle ? clone(batch.lifecycle) : undefined;
    // The ledger, not a legacy caller's aggregate JSON, is authoritative. Do this before publishing
    // any map mutation so a mixed-version writer cannot make a known subtotal sticky in a later
    // current-writer commit.
    const projectionRows = [...this.usageProjectionRows(s.id), ...stagedUsage];
    stagedSessionPatch.usage = canonicalUsageProjection(
      stagedSessionPatch.usage ?? s.usage,
      projectionRows,
      { tenantId: s.tenantId, userId: s.userId },
    );
    if (stagedTurn) {
      stagedTurn = {
        ...stagedTurn,
        usage: canonicalUsageProjection(
          stagedTurn.usage,
          projectionRows.filter((row) => row.turnId === stagedTurn!.id),
          { tenantId: s.tenantId, userId: s.userId },
        ),
      };
    }
    stagedItems = stagedItems.map((item) => canonicalizeUsageItem(
      item,
      projectionRows.find((row) => (
        row.turnId === item.turnId && row.step === 0
        && row.tenantId === s.tenantId && row.userId === s.userId
      )),
    ));
    stagedEvents = stagedEvents.map((event) => canonicalizePersistedUsageEvent(
      event,
      projectionRows,
      { tenantId: s.tenantId, userId: s.userId },
    ));
    assignItemSeqs(stagedItems, stagedEvents, seq);
    assignTurnSeqEnd(stagedTurn, stagedEvents, seq);
    const resultEvents = stagedEvents.map(clone);
    const stagedOutboxes: [string, LifecycleOutboxRecord][] = [];
    if (stagedLifecycle?.type === "tombstone") {
      const deletedEvent = stagedEvents.at(-1);
      if (deletedEvent?.type !== "session/deleted") throw new Error("tombstone event was not assigned a sequence");
      const outboxes: LifecycleOutboxRecord[] = ([
        {
          outboxId: this.nextLifecycleOutboxId,
          topic: "session.tombstoned",
          aggregateId: batch.sessionId,
          generation: stagedLifecycle.deletionGeneration,
          payload: {
            sessionId: batch.sessionId,
            deletionGeneration: stagedLifecycle.deletionGeneration,
            eventSeq: deletedEvent.seq,
          },
          availableAtMs: stagedLifecycle.atMs,
          attempts: 0,
          createdAtMs: stagedLifecycle.atMs,
        },
        {
          outboxId: this.nextLifecycleOutboxId + 1,
          topic: "session.purge",
          aggregateId: batch.sessionId,
          generation: stagedLifecycle.deletionGeneration,
          payload: { sessionId: batch.sessionId, deletionGeneration: stagedLifecycle.deletionGeneration },
          attempts: 0,
          createdAtMs: stagedLifecycle.atMs,
        },
      ] satisfies LifecycleOutboxRecord[]).map((outbox) => clone(outbox));
      for (const outbox of outboxes) {
        const key = this.lifecycleOutboxMapKey(outbox.topic, outbox.aggregateId, outbox.generation);
        if (this.lifecycleOutbox.has(key) || stagedOutboxes.some(([candidate]) => candidate === key)) {
          throw new Error("lifecycle outbox identity already exists");
        }
        stagedOutboxes.push([key, outbox]);
      }
    }

    // This mutates only caller-owned projections. Perform it before publishing the staged store
    // state so a frozen/proxy input cannot leave a partially committed in-memory transaction.
    backfillAssignedSequences(batch, { items: stagedItems, turn: stagedTurn, events: stagedEvents });
    s.fenceToken = batch.fence;
    const log = this.events.get(batch.sessionId)!;
    log.push(...stagedEvents);
    s.lastSeq = seq;
    for (const it of stagedItems) this.items.set(it.id, it);
    for (const [blobId, manifest] of stagedReadyBlobs) this.blobManifests.set(blobId, manifest);
    if (stagedTurn) this.turns.set(stagedTurn.id, stagedTurn);
    for (const a of stagedApprovals) this.approvals.set(a.id, a);
    this.usageLedger.push(...stagedUsage);
    for (const [usageId, fact] of stagedBillingFacts) this.billingUsageFacts.set(usageId, fact);
    if (batch.idempotency && idemMapKey && stagedIdempotencyValue) {
      this.idem.set(idemMapKey, {
        value: stagedIdempotencyValue,
        requestHash: batch.idempotency.requestHash,
        expiresAt: batch.idempotency.expiresAtMs,
      });
    }
    if (stagedSessionPatch) Object.assign(s, stagedSessionPatch);
    if (stagedLifecycle?.type === "archive") s.archivedAtMs = stagedLifecycle.atMs;
    else if (stagedLifecycle?.type === "unarchive") delete s.archivedAtMs;
    else if (stagedLifecycle?.type === "tombstone" && stagedTombstone) {
      this.deleted.set(batch.sessionId, stagedTombstone);
      for (const [key, outbox] of stagedOutboxes) this.lifecycleOutbox.set(key, outbox);
      this.nextLifecycleOutboxId += stagedOutboxes.length;
    }
    s.updatedAtMs = Date.now();
    return {
      events: resultEvents,
      lastSeq: seq,
      lifecycleGeneration: stagedLifecycle?.type === "tombstone" ? stagedLifecycle.deletionGeneration : undefined,
    };
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    // Deliberately raw: an already-established SSE subscription must be able to deliver the final
    // session/deleted event. Public subscription setup performs an owner-aware session check first.
    const session = this.sessions.get(sessionId);
    const rows = this.usageProjectionRows(sessionId);
    return (this.events.get(sessionId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit)
      .map((event) => session
        ? canonicalizePersistedUsageEvent(clone(event), rows, session)
        : clone(event));
  }
  async getTurn(sessionId: string, turnId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const session = this.sessions.get(sessionId)!;
    const t = this.turns.get(turnId);
    return t && t.sessionId === sessionId ? this.turnForRead(t, session) : null;
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }) {
    if (!this.isSessionVisible(sessionId)) return { data: [], nextCursor: null };
    const session = this.sessions.get(sessionId)!;
    const rows = [...this.turns.values()]
      .filter((t) => t.sessionId === sessionId)
      .map((turn) => this.turnForRead(turn, session));
    return paginate(rows, (t) => t.id, opts.cursor, opts.limit, opts.sortDirection ?? "desc");
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    if (!this.isSessionVisible(sessionId)) return [];
    const session = this.sessions.get(sessionId)!;
    const all = [...this.items.values()]
      .filter((i) => i.sessionId === sessionId && (!opts.turnId || i.turnId === opts.turnId) && i.seq > (opts.afterSeq ?? -1))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    const kept = opts.newestFirst ? all.slice(Math.max(0, all.length - opts.limit)) : all.slice(0, opts.limit);
    const projectionRows = this.usageProjectionRows(sessionId);
    return kept.map((item) => canonicalizeUsageItem(
      clone(item),
      projectionRows.find((row) => (
        row.turnId === item.turnId && row.step === 0
        && row.tenantId === session.tenantId && row.userId === session.userId
      )),
    ));
  }
  async getItem(sessionId: string, itemId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const session = this.sessions.get(sessionId)!;
    const i = this.items.get(itemId);
    return i && i.sessionId === sessionId
      ? canonicalizeUsageItem(
        clone(i),
        this.usageProjectionRows(sessionId, i.turnId).find((row) => (
          row.step === 0 && row.tenantId === session.tenantId && row.userId === session.userId
        )),
      )
      : null;
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    if (!this.isSessionVisible(sessionId)) return [];
    return [...this.approvals.values()]
      .filter((a) => a.sessionId === sessionId && (!opts.pendingOnly || a.status === "pending"))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(clone);
  }
  async getApproval(sessionId: string, approvalId: string) {
    if (!this.isSessionVisible(sessionId)) return null;
    const a = this.approvals.get(approvalId);
    return a && a.sessionId === sessionId ? clone(a) : null;
  }

  async upsertProviderConfig(cfg: ProviderConfig, secret?: { ciphertext: Buffer; keyId: string }) {
    const prev = this.providers.get(`${cfg.tenantId}/${cfg.id}`);
    this.providers.set(`${cfg.tenantId}/${cfg.id}`, { config: clone(cfg), secret: secret ?? prev?.secret });
  }
  async getProviderConfig(tenantId: string, providerId: string) {
    const p = this.providers.get(`${tenantId}/${providerId}`);
    return p ? { config: clone(p.config), secret: p.secret } : null;
  }
  async listProviderConfigs(tenantId: string) {
    return [...this.providers.values()].filter((p) => p.config.tenantId === tenantId).map((p) => clone(p.config));
  }
  async deleteProviderConfig(tenantId: string, providerId: string) {
    return this.providers.delete(`${tenantId}/${providerId}`);
  }

  async resolveApiKey(hashedKey: string) {
    const k = this.apiKeys.get(hashedKey);
    return k && !k.revokedAtMs ? { tenantId: k.tenantId, keyId: k.keyId, scopes: k.scopes } : null;
  }
  async createApiKey(tenantId: string, keyId: string, hashedKey: string, scopes: ApiKeyScope[] = DEFAULT_SCOPES) {
    this.apiKeys.set(hashedKey, { tenantId, keyId, scopes, createdAtMs: Date.now() });
    if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, { tenantId, authPolicy: DEFAULT_AUTH_POLICY, createdAtMs: Date.now() });
  }
  async listApiKeys(tenantId: string) {
    return [...this.apiKeys.entries()]
      .filter(([, v]) => v.tenantId === tenantId)
      .map(([, v]) => ({ keyId: v.keyId, tenantId: v.tenantId, scopes: [...v.scopes], createdAtMs: v.createdAtMs ?? 0, revokedAtMs: v.revokedAtMs }));
  }
  async revokeApiKey(tenantId: string, keyId: string) {
    for (const [hash, v] of this.apiKeys) {
      if (v.tenantId === tenantId && v.keyId === keyId && !v.revokedAtMs) {
        this.apiKeys.set(hash, { ...v, revokedAtMs: Date.now() });
        return true;
      }
    }
    return false;
  }

  async getTenant(tenantId: string) {
    const t = this.tenants.get(tenantId);
    return t ? { ...clone({ ...t, authSecret: undefined }), authSecret: t.authSecret } : null;
  }
  async setTenantAuth(tenantId: string, policy: TenantAuthPolicy, secret?: { ciphertext: Buffer; keyId: string } | null) {
    const prev = this.tenants.get(tenantId);
    this.tenants.set(tenantId, {
      tenantId,
      name: prev?.name,
      authPolicy: clone(policy),
      authSecret: secret === null ? undefined : (secret ?? prev?.authSecret),
      createdAtMs: prev?.createdAtMs ?? Date.now(),
    });
  }

  usageLedger: UsageLedgerEntry[] = [];
  async queryUsage(tenantId: string, q: UsageQuery) {
    const rows = this.usageLedger.filter((e) => {
      const session = this.sessions.get(e.sessionId);
      return e.tenantId === tenantId
        && session?.tenantId === e.tenantId
        && session.userId === e.userId
        && this.isSessionVisible(e.sessionId)
        && (!q.userId || e.userId === q.userId)
        && (!q.sessionId || e.sessionId === q.sessionId)
        && (q.from === undefined || e.createdAtMs >= q.from)
        && (q.to === undefined || e.createdAtMs < q.to);
    });
    const keyOf = (e: UsageLedgerEntry) =>
      q.groupBy === "user" ? e.userId
      : q.groupBy === "session" ? e.sessionId
      : q.groupBy === "model" ? `${e.provider}/${e.model}`
      : q.groupBy === "day" ? new Date(e.createdAtMs).toISOString().slice(0, 10)
      : "total";
    const acc = new Map<string, { turns: Set<string>; steps: number; usage: Usage }>();
    for (const e of rows) {
      const k = keyOf(e);
      const cur = acc.get(k) ?? { turns: new Set<string>(), steps: 0, usage: emptyUsageAccumulator() };
      cur.turns.add(e.turnId);
      cur.steps += 1;
      cur.usage = addUsage(cur.usage, normalizeOperationalUsageCost(e.usage, e.usageId));
      acc.set(k, cur);
    }
    return {
      data: [...acc.entries()]
        .map(([key, v]) => ({ key, turns: v.turns.size, steps: v.steps, usage: v.usage }))
        .sort((a, b) => (b.usage.totalTokens - a.usage.totalTokens) || a.key.localeCompare(b.key))
        .slice(0, q.limit),
    };
  }

  private usageReconciliationMapKey(sessionId: string, deletionGeneration: number): string {
    return JSON.stringify([sessionId, deletionGeneration]);
  }

  private assertUsageLifecycleScope(input: ReconcileSessionUsageInput): void {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.userId !== input.userId) {
      // Preserve the same non-oracle owner semantics as every public session resource. Although this
      // is an internal least-privilege interface, a scoped worker must not probe another principal.
      throw new SessionGoneError(input.sessionId);
    }
    const tombstone = this.deleted.get(input.sessionId);
    if (
      !tombstone
      || input.deletionGeneration <= 0
      || tombstone.deletionGeneration !== input.deletionGeneration
    ) {
      throw new UsageLifecycleGenerationError(input.sessionId, input.deletionGeneration);
    }
  }

  private usageRowsForLifecycle(
    ledger: readonly UsageLedgerEntry[],
    input: ReconcileSessionUsageInput,
  ): UsageLedgerEntry[] {
    const rows = ledger.filter((entry) => entry.sessionId === input.sessionId);
    if (rows.some((entry) => entry.tenantId !== input.tenantId || entry.userId !== input.userId)) {
      throw new UsageReconciliationError("operational usage owner does not match its session");
    }
    return rows;
  }

  /** The destructive input has no caller `legalHold: false`; only durable store state decides. */
  protected isUsageAnonymizationLegalHoldActive(input: AnonymizeSessionUsageInput): boolean {
    const tenant = this.subjectRecord(input.tenantId, "tenant", input.tenantId);
    const user = this.subjectRecord(input.tenantId, "user", input.userId);
    if (!tenant || !user) {
      throw new UsageReconciliationError("subject lifecycle state is missing; anonymization is fail-closed");
    }
    return tenant.legalHoldAtMs !== undefined || user.legalHoldAtMs !== undefined;
  }

  async reconcileSessionUsage(input: ReconcileSessionUsageInput): Promise<UsageReconciliationRecord> {
    validateReconcileSessionUsageInput(input);
    this.assertUsageLifecycleScope(input);
    const reconciliationKey = this.usageReconciliationMapKey(input.sessionId, input.deletionGeneration);
    const existingRecord = this.usageReconciliations.get(reconciliationKey);
    if (existingRecord?.status === "anonymized") {
      if (this.usageRowsForLifecycle(this.usageLedger, input).length > 0) {
        throw new UsageReconciliationError("operational usage reappeared after anonymization");
      }
      return clone(existingRecord);
    }

    // Clone the complete ledger so assigning ids to legacy NULL rows cannot become visible until
    // every row and pre-existing billing fact passes conflict and checksum verification.
    const stagedLedger = this.usageLedger.map(clone);
    const targetRows = this.usageRowsForLifecycle(stagedLedger, input);
    const reservedUsageIds = new Set<string>();
    for (const entry of stagedLedger) {
      if (entry.usageId === undefined) continue;
      if (!isUsageId(entry.usageId)) {
        throw new UsageReconciliationError("stored operational usage has an invalid usage id");
      }
      if (reservedUsageIds.has(entry.usageId)) throw new UsageIdentityConflictError(entry.usageId);
      reservedUsageIds.add(entry.usageId);
    }
    for (const usageId of this.billingUsageFacts.keys()) reservedUsageIds.add(usageId);

    for (const entry of targetRows) {
      if (entry.usageId !== undefined) continue;
      // Pre-0011 Pi used numeric zero when price metadata was unavailable. Remove that ambiguous
      // encoding before assigning an id, otherwise the same row would become spuriously "known"
      // immediately after a successful reconciliation.
      entry.usage = normalizeOperationalUsageCost(entry.usage, undefined);
      let allocated: string | undefined;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = newUsageId();
        if (!reservedUsageIds.has(candidate)) {
          allocated = candidate;
          break;
        }
      }
      if (!allocated) throw new UsageReconciliationError("could not allocate a unique usage id");
      entry.usageId = allocated;
      reservedUsageIds.add(allocated);
    }

    const stagedNewFacts = new Map<string, BillingUsageFact>();
    const expectedFacts: BillingUsageFact[] = [];
    const verifiedFacts: BillingUsageFact[] = [];
    const targetIds = new Set<string>();
    for (const entry of targetRows) {
      if (!entry.usageId || targetIds.has(entry.usageId)) {
        throw new UsageIdentityConflictError(entry.usageId ?? "missing");
      }
      targetIds.add(entry.usageId);
      const expected = billingUsageFactFromLedger({
        ...entry,
        usage: normalizeOperationalUsageCost(entry.usage, entry.usageId),
      } as UsageLedgerEntry & { usageId: string });
      expectedFacts.push(expected);
      const existingFact = this.billingUsageFacts.get(entry.usageId);
      if (existingFact) {
        if (!billingUsageFactContentEquals(existingFact, expected)) {
          throw new UsageIdentityConflictError(entry.usageId);
        }
        verifiedFacts.push(clone(existingFact));
      } else {
        stagedNewFacts.set(entry.usageId, expected);
        verifiedFacts.push(expected);
      }
    }

    const expectedSummary = summarizeBillingUsageFacts(expectedFacts);
    const verifiedSummary = summarizeBillingUsageFacts(verifiedFacts);
    if (!usageReconciliationSummariesEqual(expectedSummary, verifiedSummary)) {
      throw new UsageReconciliationError();
    }
    if (existingRecord && !usageReconciliationSummariesEqual(existingRecord, verifiedSummary)) {
      throw new UsageReconciliationError("verified usage changed after its first reconciliation");
    }

    const record = clone<UsageReconciliationRecord>(existingRecord ?? {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      deletionGeneration: input.deletionGeneration,
      status: "verified",
      ...verifiedSummary,
      verifiedAtMs: input.nowMs,
    });
    if (
      record.tenantId !== input.tenantId
      || record.userId !== input.userId
      || record.sessionId !== input.sessionId
      || record.deletionGeneration !== input.deletionGeneration
      || record.status !== "verified"
    ) throw new UsageReconciliationError("usage reconciliation identity changed");

    this.usageLedger = stagedLedger;
    for (const [usageId, fact] of stagedNewFacts) this.billingUsageFacts.set(usageId, clone(fact));
    this.usageReconciliations.set(reconciliationKey, record);
    return clone(record);
  }

  async anonymizeSessionUsage(input: AnonymizeSessionUsageInput): Promise<UsageReconciliationRecord> {
    // Validate the explicit destructive gate without consulting owner-scoped state first. A caller
    // must not be able to distinguish another subject's legal hold from a nonexistent session.
    assertUsageAnonymizationAllowed(input, false);
    this.assertUsageLifecycleScope(input);
    const reconciliationKey = this.usageReconciliationMapKey(input.sessionId, input.deletionGeneration);
    const record = this.usageReconciliations.get(reconciliationKey);
    if (!record) throw new UsageReconciliationError("usage must be reconciled before anonymization");
    if (
      record.tenantId !== input.tenantId
      || record.userId !== input.userId
      || record.sessionId !== input.sessionId
      || record.deletionGeneration !== input.deletionGeneration
    ) throw new SessionGoneError(input.sessionId);
    if (record.checksum !== input.expectedChecksum) {
      throw new UsageReconciliationError("expected reconciliation checksum does not match");
    }
    // Resolve the durable lifecycle rows before the idempotent fast path so missing state still
    // fails closed. A hold installed after anonymization committed cannot undo that deletion and
    // must not turn a lost-response retry into a permanently blocked job.
    const legalHoldActive = this.isUsageAnonymizationLegalHoldActive(input);
    const targetRows = this.usageRowsForLifecycle(this.usageLedger, input);
    if (record.status === "anonymized") {
      if (targetRows.length !== 0) throw new UsageReconciliationError("operational usage reappeared after anonymization");
      return clone(record);
    }
    assertUsageAnonymizationAllowed(input, legalHoldActive);
    if (input.nowMs < record.verifiedAtMs) {
      throw new UsageReconciliationError("anonymization cannot precede verification");
    }

    const verifiedFacts: BillingUsageFact[] = [];
    for (const entry of targetRows) {
      if (!entry.usageId || !isUsageId(entry.usageId)) {
        throw new UsageReconciliationError("operational usage was not fully assigned before anonymization");
      }
      const existingFact = this.billingUsageFacts.get(entry.usageId);
      if (!existingFact) throw new UsageReconciliationError("a reconciled billing fact is missing");
      const expectedFact = billingUsageFactFromLedger(
        {
          ...entry,
          usage: normalizeHistoricalUsageCost(entry.usage),
        } as UsageLedgerEntry & { usageId: string },
      );
      if (!billingUsageFactContentEquals(existingFact, expectedFact)) {
        throw new UsageIdentityConflictError(entry.usageId);
      }
      verifiedFacts.push(existingFact);
    }
    const currentSummary = summarizeBillingUsageFacts(verifiedFacts);
    if (!usageReconciliationSummariesEqual(record, currentSummary)) {
      throw new UsageReconciliationError("operational usage changed after verification");
    }

    const remainingLedger = this.usageLedger.filter((entry) => !(
      entry.tenantId === input.tenantId
      && entry.userId === input.userId
      && entry.sessionId === input.sessionId
    ));
    const anonymized = clone<UsageReconciliationRecord>({
      ...record,
      status: "anonymized",
      anonymizedAtMs: input.nowMs,
    });
    this.usageLedger = remainingLedger;
    this.usageReconciliations.set(reconciliationKey, anonymized);
    return clone(anonymized);
  }

  private assertCommitResourceIdentities(batch: CommitBatch): void {
    const itemIdentities = new Map<string, string>();
    const turnIdentities = new Map<string, string>();
    const approvalIdentities = new Map<string, string>();
    const observe = (
      identities: Map<string, string>,
      id: string,
      identity: string,
      kind: "item" | "turn" | "approval",
    ) => {
      const previous = identities.get(id);
      if (previous !== undefined && previous !== identity) {
        throw new Error(`${kind} identity conflicts with another resource`);
      }
      identities.set(id, identity);
    };
    const observeItem = (item: Item) => {
      observe(itemIdentities, item.id, JSON.stringify([item.sessionId, item.turnId, item.type]), "item");
    };
    const observeTurn = (turn: Turn) => {
      observe(turnIdentities, turn.id, turn.sessionId, "turn");
    };
    const observeApproval = (approval: Approval) => {
      observe(
        approvalIdentities,
        approval.id,
        JSON.stringify([approval.sessionId, approval.turnId, approval.itemId, approval.toolCallId]),
        "approval",
      );
    };

    for (const item of this.items.values()) observeItem(item);
    for (const turn of this.turns.values()) observeTurn(turn);
    for (const approval of this.approvals.values()) observeApproval(approval);
    for (const item of batch.items ?? []) observeItem(item);
    if (batch.turn) observeTurn(batch.turn);
    const approvalIds = new Set<string>();
    for (const approval of batch.approvals ?? []) {
      if (approvalIds.has(approval.id)) throw new Error("commit contains the same approval more than once");
      approvalIds.add(approval.id);
      observeApproval(approval);
    }
    for (const event of batch.events ?? []) {
      if ("item" in event) observeItem(event.item);
      if ("turn" in event) observeTurn(event.turn);
      if ("approval" in event) observeApproval(event.approval);
    }
  }

  private idempotencyMapKey(scope: IdempotencyScope, key: string) {
    // JSON encoding keeps the tuple unambiguous even when an opaque client key contains separators.
    return JSON.stringify([scope.tenantId, scope.userId, scope.sessionId, key]);
  }

  async getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null> {
    if (!this.isSessionVisible(scope.sessionId)) return null;
    const k = this.idempotencyMapKey(scope, key);
    const cur = this.idem.get(k);
    if (!cur || cur.expiresAt < Date.now() || !cur.value) return null;
    return { requestHash: cur.requestHash, value: clone(cur.value), expiresAtMs: cur.expiresAt };
  }

  // ---------- blob staging sweeper + delete outbox ----------
  private blobDeleteOutboxMapKey(blobId: string, generation: number): string {
    return JSON.stringify([blobId, generation]);
  }

  private findBlobDeleteOutboxById(outboxId: number): [string, BlobDeleteOutboxRecord] | undefined {
    for (const entry of this.blobDeleteOutbox.entries()) {
      if (entry[1].outboxId === outboxId) return entry;
    }
    return undefined;
  }

  private hydrateBlobDeleteOutbox(
    row: BlobDeleteOutboxRecord,
    requirePending = true,
  ): BlobDeleteOutboxRecord {
    const manifest = this.blobManifests.get(row.blobId);
    if (!Number.isSafeInteger(row.outboxId) || row.outboxId < 1) {
      throw new Error("invalid blob delete outbox id");
    }
    if (
      !manifest
      || manifest.deletionGeneration !== row.generation
      || (requirePending
        ? manifest.state !== "delete_pending"
        : manifest.state !== "delete_pending" && manifest.state !== "deleted")
      || !manifest.uploadToken
    ) throw new Error(`blob delete outbox ${row.outboxId} does not match its manifest state`);
    return {
      ...clone(row),
      storageBackend: manifest.storageBackend,
      storageFormat: manifest.storageFormat,
      storageKey: manifest.storageKey,
      uploadToken: manifest.uploadToken,
    };
  }

  async scheduleStaleBlobDeletes(options: ScheduleStaleBlobsOptions): Promise<number> {
    if (!Number.isSafeInteger(options.nowMs) || options.nowMs < 0) throw new Error("invalid blob sweep timestamp");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("blob sweep limit must be between 1 and 100");
    }
    const candidates = [...this.blobManifests.values()]
      .filter((manifest) => (
        manifest.state === "staging"
        && manifest.stagingExpiresAtMs !== undefined
        && manifest.stagingExpiresAtMs <= options.nowMs
      ))
      .sort((left, right) => (
        left.stagingExpiresAtMs! - right.stagingExpiresAtMs!
        || left.blobId.localeCompare(right.blobId)
      ))
      .slice(0, options.limit);

    const manifests = new Map<string, BlobManifest>();
    const outboxes = new Map<string, BlobDeleteOutboxRecord>();
    for (const [index, manifest] of candidates.entries()) {
      const generation = manifest.deletionGeneration + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("blob deletion generation overflow");
      const key = this.blobDeleteOutboxMapKey(manifest.blobId, generation);
      if (this.blobDeleteOutbox.has(key) || outboxes.has(key)) {
        throw new Error("blob delete outbox identity already exists");
      }
      const pending = clone({
        ...manifest,
        state: "delete_pending" as const,
        deleteAfterMs: options.nowMs,
        deletionGeneration: generation,
        stagingExpiresAtMs: undefined,
      });
      delete pending.stagingExpiresAtMs;
      const outbox = clone<BlobDeleteOutboxRecord>({
        outboxId: this.nextBlobDeleteOutboxId + index,
        blobId: manifest.blobId,
        generation,
        storageBackend: manifest.storageBackend,
        storageFormat: manifest.storageFormat,
        storageKey: manifest.storageKey,
        uploadToken: manifest.uploadToken,
        availableAtMs: options.nowMs,
        attempts: 0,
        createdAtMs: options.nowMs,
      });
      manifests.set(manifest.blobId, pending);
      outboxes.set(key, outbox);
    }

    for (const [blobId, manifest] of manifests) this.blobManifests.set(blobId, manifest);
    for (const [key, outbox] of outboxes) this.blobDeleteOutbox.set(key, outbox);
    this.nextBlobDeleteOutboxId += outboxes.size;
    return candidates.length;
  }

  async claimBlobDeletes(options: ClaimBlobDeletesOptions): Promise<BlobDeleteOutboxRecord[]> {
    const leaseUntilMs = validateBlobDeleteClaim(options);
    const candidates = [...this.blobDeleteOutbox.entries()]
      .filter(([, row]) => (
        row.availableAtMs <= options.nowMs
        && row.completedAtMs === undefined
        && row.deadLetteredAtMs === undefined
        && (row.claimToken === undefined || (row.leaseUntilMs !== undefined && row.leaseUntilMs <= options.nowMs))
      ))
      .sort((left, right) => (
        left[1].availableAtMs - right[1].availableAtMs
        || left[1].outboxId - right[1].outboxId
      ))
      .slice(0, options.limit);
    const staged = new Map<string, BlobDeleteOutboxRecord>();
    const claimed: BlobDeleteOutboxRecord[] = [];
    for (const [key, row] of candidates) {
      try {
        const hydrated = this.hydrateBlobDeleteOutbox(row);
        const next = clone({
          ...hydrated,
          attempts: hydrated.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        });
        staged.set(key, next);
        claimed.push(next);
      } catch {
        const poison = clone(row);
        poison.attempts += 1;
        poison.lastError = "invalid blob delete outbox identity";
        poison.deadLetteredAtMs = options.nowMs;
        delete poison.claimToken;
        delete poison.leaseUntilMs;
        staged.set(key, poison);
      }
    }
    for (const [key, row] of staged) this.blobDeleteOutbox.set(key, row);
    return claimed.map(clone);
  }

  async renewBlobDeleteClaim(
    outboxId: number,
    claimToken: string,
    options: import("./blob-lifecycle.js").RenewBlobDeleteClaimOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.nowMs);
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1) {
      throw new Error("invalid blob delete lease duration");
    }
    const leaseUntilMs = options.nowMs + options.leaseMs;
    if (!Number.isSafeInteger(leaseUntilMs)) throw new Error("invalid blob delete lease expiry");
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.nowMs
    ) return false;
    row.leaseUntilMs = Math.max(row.leaseUntilMs, leaseUntilMs);
    return true;
  }

  async completeBlobDelete(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, completedAtMs);
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= completedAtMs
    ) return false;
    const manifest = this.blobManifests.get(row.blobId);
    if (!manifest || manifest.state !== "delete_pending" || manifest.deletionGeneration !== row.generation) {
      throw new BlobStateError(row.blobId);
    }
    const completedManifest = clone({
      ...manifest,
      state: "deleted" as const,
      deletedAtMs: completedAtMs,
    });
    delete completedManifest.sha256;
    delete completedManifest.sizeBytes;
    delete completedManifest.contentType;
    delete completedManifest.uploadedAtMs;
    delete completedManifest.readyAtMs;
    delete completedManifest.deleteAfterMs;
    const completedOutbox = clone({ ...row, completedAtMs });
    delete completedOutbox.claimToken;
    delete completedOutbox.leaseUntilMs;
    delete completedOutbox.lastError;
    this.blobManifests.set(row.blobId, completedManifest);
    this.blobDeleteOutbox.set(entry[0], completedOutbox);
    return true;
  }

  async retryBlobDelete(
    outboxId: number,
    claimToken: string,
    options: RetryBlobDeleteOptions,
  ): Promise<boolean> {
    validateBlobDeleteAck(outboxId, claimToken, options.failedAtMs);
    if (!Number.isSafeInteger(options.availableAtMs) || options.availableAtMs < options.failedAtMs) {
      throw new Error("blob delete retry must not move backwards");
    }
    if (options.maxAttempts !== undefined && (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)) {
      throw new Error("blob delete maxAttempts must be positive");
    }
    const entry = this.findBlobDeleteOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.failedAtMs
    ) return false;
    const retried = clone(row);
    retried.lastError = sanitizeBlobDeleteError(options.error);
    delete retried.claimToken;
    delete retried.leaseUntilMs;
    if (options.maxAttempts !== undefined && retried.attempts >= options.maxAttempts) {
      retried.deadLetteredAtMs = options.failedAtMs;
    } else {
      retried.availableAtMs = options.availableAtMs;
    }
    this.blobDeleteOutbox.set(entry[0], retried);
    return true;
  }

  async getBlobDeleteOutbox(blobId: string, generation: number): Promise<BlobDeleteOutboxRecord | null> {
    const row = this.blobDeleteOutbox.get(this.blobDeleteOutboxMapKey(blobId, generation));
    return row ? this.hydrateBlobDeleteOutbox(row, false) : null;
  }

  private lifecycleOutboxMapKey(topic: LifecycleOutboxRecord["topic"], aggregateId: string, generation: number) {
    return JSON.stringify([topic, aggregateId, generation]);
  }

  async getLifecycleOutbox(topic: LifecycleOutboxRecord["topic"], aggregateId: string, generation: number) {
    const row = this.lifecycleOutbox.get(this.lifecycleOutboxMapKey(topic, aggregateId, generation));
    if (!row) return null;
    assertLifecycleOutboxId(row.outboxId);
    const cloned = clone(row);
    const envelope = parseLifecycleOutboxEnvelope(cloned.topic, cloned.payload);
    if (envelope.payload.sessionId !== cloned.aggregateId || envelope.payload.deletionGeneration !== cloned.generation) {
      throw new Error(`lifecycle outbox ${cloned.outboxId} payload does not match its durable identity`);
    }
    return { ...cloned, ...envelope } as LifecycleOutboxRecord;
  }

  private findLifecycleOutboxById(outboxId: number): [string, LifecycleOutboxRecord] | undefined {
    for (const entry of this.lifecycleOutbox.entries()) {
      if (entry[1].outboxId === outboxId) return entry;
    }
    return undefined;
  }

  async claimLifecycleOutbox(options: import("./types.js").ClaimLifecycleOutboxOptions) {
    const { topics, leaseUntilMs } = validateClaimLifecycleOutboxOptions(options);
    if (topics.length === 0) return [];
    const allowed = new Set(topics);
    const candidates = [...this.lifecycleOutbox.entries()]
      .filter((row) => (
        allowed.has(row[1].topic)
        && row[1].availableAtMs !== undefined
        && row[1].availableAtMs <= options.nowMs
        && row[1].completedAtMs === undefined
        && row[1].deadLetteredAtMs === undefined
        && (row[1].claimToken === undefined || (row[1].leaseUntilMs !== undefined && row[1].leaseUntilMs <= options.nowMs))
      ))
      .sort((a, b) => (a[1].availableAtMs! - b[1].availableAtMs!) || (a[1].outboxId - b[1].outboxId))
      .slice(0, options.limit);
    const staged = new Map<string, LifecycleOutboxRecord>();
    const claimed: LifecycleOutboxRecord[] = [];
    for (const [key, row] of candidates) {
      try {
        assertLifecycleOutboxId(row.outboxId);
        const cloned = clone(row);
        const envelope = parseLifecycleOutboxEnvelope(cloned.topic, cloned.payload);
        if (envelope.payload.sessionId !== cloned.aggregateId || envelope.payload.deletionGeneration !== cloned.generation) {
          throw new Error(`lifecycle outbox ${cloned.outboxId} payload does not match its durable identity`);
        }
        const next = {
          ...cloned,
          ...envelope,
          attempts: row.attempts + 1,
          claimToken: options.claimToken,
          leaseUntilMs,
        } as LifecycleOutboxRecord;
        staged.set(key, next);
        claimed.push(next);
      } catch {
        // A corrupt durable envelope cannot become valid by retrying and must not starve every
        // well-formed row behind it. Quarantine it without exposing its payload in durable errors.
        const poison = clone(row);
        poison.attempts += 1;
        poison.lastError = "invalid lifecycle outbox envelope";
        poison.deadLetteredAtMs = options.nowMs;
        delete poison.availableAtMs;
        delete poison.claimToken;
        delete poison.leaseUntilMs;
        staged.set(key, poison);
      }
    }

    for (const [key, row] of staged) this.lifecycleOutbox.set(key, row);
    return claimed.map(clone);
  }

  async renewLifecycleOutboxClaim(
    outboxId: number,
    claimToken: string,
    options: import("./types.js").RenewLifecycleOutboxClaimOptions,
  ) {
    const leaseUntilMs = validateRenewLifecycleOutboxClaim(outboxId, claimToken, options.nowMs, options.leaseMs);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.nowMs
    ) return false;
    row.leaseUntilMs = Math.max(row.leaseUntilMs, leaseUntilMs);
    return true;
  }

  async completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number) {
    validateLifecycleOutboxAck(outboxId, claimToken, completedAtMs);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= completedAtMs
    ) return false;
    row.completedAtMs = completedAtMs;
    delete row.claimToken;
    delete row.leaseUntilMs;
    delete row.lastError;
    return true;
  }

  async retryLifecycleOutbox(
    outboxId: number,
    claimToken: string,
    options: import("./types.js").RetryLifecycleOutboxOptions,
  ) {
    validateLifecycleOutboxAck(outboxId, claimToken, options.failedAtMs);
    validateRetryLifecycleOutboxOptions(options);
    const lastError = sanitizeLifecycleOutboxError(options.error);
    const entry = this.findLifecycleOutboxById(outboxId);
    if (!entry) return false;
    const row = entry[1];
    if (
      row.completedAtMs !== undefined
      || row.deadLetteredAtMs !== undefined
      || row.claimToken !== claimToken
      || row.leaseUntilMs === undefined
      || row.leaseUntilMs <= options.failedAtMs
    ) return false;
    delete row.claimToken;
    delete row.leaseUntilMs;
    row.lastError = lastError;
    if (options.maxAttempts !== undefined && row.attempts >= options.maxAttempts) {
      delete row.availableAtMs;
      row.deadLetteredAtMs = options.failedAtMs;
    } else {
      row.availableAtMs = options.availableAtMs;
    }
    return true;
  }

  async close() {}
}

export class MemoryLeaseStore implements LeaseStore {
  leases = new Map<string, { ownerId: string; ownerAddr: string; fence: number; expiresAt: number }>();
  fences = new Map<string, number>();

  async acquire(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): Promise<LeaseAcquireResult | LeaseConflict> {
    const cur = this.leases.get(sessionId);
    const now = Date.now();
    if (cur && cur.expiresAt > now && cur.ownerId !== ownerId) return { ok: false, ownerId: cur.ownerId, ownerAddr: cur.ownerAddr };
    if (cur && cur.expiresAt > now && cur.ownerId === ownerId) {
      cur.expiresAt = now + ttlMs;
      return { ok: true, fence: cur.fence };
    }
    const fence = (this.fences.get(sessionId) ?? 0) + 1;
    this.fences.set(sessionId, fence);
    this.leases.set(sessionId, { ownerId, ownerAddr, fence, expiresAt: now + ttlMs });
    return { ok: true, fence };
  }
  async renew(sessionId: string, ownerId: string, ttlMs: number) {
    const cur = this.leases.get(sessionId);
    if (!cur || cur.ownerId !== ownerId || cur.expiresAt <= Date.now()) return false;
    cur.expiresAt = Date.now() + ttlMs;
    return true;
  }
  async release(sessionId: string, ownerId: string) {
    const cur = this.leases.get(sessionId);
    if (cur && cur.ownerId === ownerId) this.leases.delete(sessionId);
  }
  async getOwner(sessionId: string) {
    const cur = this.leases.get(sessionId);
    if (!cur || cur.expiresAt <= Date.now()) return null;
    return { ownerId: cur.ownerId, ownerAddr: cur.ownerAddr, fence: cur.fence };
  }
  /** test helper: expire a lease as if TTL passed */
  expire(sessionId: string) {
    const cur = this.leases.get(sessionId);
    if (cur) cur.expiresAt = 0;
  }
  async close() {}
}

export class MemoryEventBus implements EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private hot = new Map<string, PersistedEvent[]>();
  constructor(private readonly hotWindow = 1000) {}

  async publish(sessionId: string, event: Event) {
    if (typeof (event as { seq?: number }).seq === "number") {
      const buf = this.hot.get(sessionId) ?? [];
      buf.push(event as PersistedEvent);
      if (buf.length > this.hotWindow) buf.splice(0, buf.length - this.hotWindow);
      this.hot.set(sessionId, buf);
    }
    for (const l of this.listeners.get(sessionId) ?? []) l(clone(event));
  }
  async subscribe(sessionId: string, listener: EventListener, opts?: import("./types.js").EventSubscriptionOptions) {
    if (opts?.afterSeq !== undefined) {
      for (const e of this.hot.get(sessionId) ?? []) if (e.seq > opts.afterSeq) listener(clone(e));
    }
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  async close() {
    this.listeners.clear();
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly backend = "memory-v1";
  private readonly blobs = new Map<string, { descriptor: BlobDescriptor; data: Buffer }>();
  private readonly cancelledStorageKeys = new Set<string>();

  async putIfAbsent(
    storageKey: string,
    data: Buffer | string,
    options: import("./types.js").BlobPutOptions,
  ) {
    validateBlobKey(storageKey);
    validateBlobUploadToken(options.uploadToken);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const contentType = validateBlobContentType(options.contentType);
    const sizeBytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (sizeBytes > maxBytes) throw new BlobTooLargeError(storageKey, maxBytes, sizeBytes);
    if (this.cancelledStorageKeys.has(storageKey)) {
      throw new Error(`blob upload ${storageKey} was cancelled before publication`);
    }

    // The ceiling is checked before this defensive allocation and before the async method yields.
    const snapshot = Buffer.from(data);
    const descriptor: BlobDescriptor = {
      storageKey,
      sha256: createHash("sha256").update(snapshot).digest("hex"),
      sizeBytes: snapshot.byteLength,
      contentType,
    };
    const existing = this.blobs.get(storageKey);
    if (existing) {
      const matches = existing.descriptor.sha256 === descriptor.sha256
        && existing.descriptor.sizeBytes === descriptor.sizeBytes
        && existing.descriptor.contentType === descriptor.contentType;
      if (!matches) throw new BlobConflictError(storageKey);
      return { ...existing.descriptor };
    }
    this.blobs.set(storageKey, { descriptor, data: snapshot });
    return { ...descriptor };
  }

  async get(storageKey: string, options: import("./types.js").BlobReadOptions) {
    validateBlobKey(storageKey);
    const maxBytes = validateBlobMaxBytes(options.maxBytes);
    const blob = this.blobs.get(storageKey);
    if (!blob) return null;
    if (blob.data.byteLength > maxBytes) {
      throw new BlobTooLargeError(storageKey, maxBytes, blob.data.byteLength);
    }
    return { ...blob.descriptor, data: Buffer.from(blob.data) };
  }

  async delete(storageKey: string, options: import("./types.js").BlobDeleteOptions = {}) {
    validateBlobKey(storageKey);
    if (options.uploadToken !== undefined) {
      validateBlobUploadToken(options.uploadToken);
      // Mirror the durable adapter contract: a manifest-driven delete permanently fences this
      // globally unique key, including when deletion linearizes before a delayed upload begins.
      this.cancelledStorageKeys.add(storageKey);
    }
    this.blobs.delete(storageKey);
  }
}
