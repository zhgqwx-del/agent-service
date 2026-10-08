import type {
  ApiKeyScope,
  UsageQuery,
  UsageRollup,
  TenantAuthPolicy,
  EventInput,
  AgentDefinition,
  Approval,
  Event,
  Item,
  PersistedEvent,
  ProviderConfig,
  Session,
  Turn,
} from "@agent-service/protocol";
import { blobBindingsFromItems, type BlobBinding } from "./blob-lifecycle.js";

export interface ApiKeyRecord {
  keyId: string;
  tenantId: string;
  scopes: ApiKeyScope[];
  createdAtMs: number;
  revokedAtMs?: number;
}

/**
 * Idempotency is scoped to the concrete turn-creation resource. Keys supplied by two users or for
 * two sessions must never alias merely because they belong to the same tenant.
 */
export interface IdempotencyScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface TenantRecord {
  tenantId: string;
  name?: string;
  authPolicy: TenantAuthPolicy;
  /** encrypted HS256 key or introspection credential, if the policy needs one */
  authSecret?: { ciphertext: Buffer; keyId: string };
  createdAtMs: number;
}

export interface UsageLedgerEntry {
  tenantId: string;
  userId: string;
  sessionId: string;
  turnId: string;
  step: number;
  provider: string;
  model: string;
  usage: import("@agent-service/protocol").Usage;
  createdAtMs: number;
}

/** A usage row written inside a session commit. Ownership is derived from the locked session row. */
export type UsageLedgerWrite = Omit<UsageLedgerEntry, "tenantId" | "userId" | "sessionId">;

export interface IdempotencyReceiptValue {
  turnId: string;
  sessionId: string;
}

export interface IdempotencyReceipt {
  /** Legacy completed rows may not have a request hash. */
  requestHash?: string;
  value: IdempotencyReceiptValue;
  expiresAtMs: number;
}

export interface IdempotencyReceiptInput {
  scope: IdempotencyScope;
  key: string;
  requestHash: string;
  value: IdempotencyReceiptValue;
  expiresAtMs: number;
}

interface SessionLifecycleOwner {
  /** Expected ownership is checked while the session row is locked. */
  tenantId: string;
  userId: string;
}

export type SessionLifecycleTransition = SessionLifecycleOwner & (
  | {
      type: "archive" | "unarchive";
      atMs: number;
    }
  | {
      type: "tombstone";
      atMs: number;
      /** NULL keeps irreversible purge unscheduled until retention policy is explicitly activated. */
      purgeAfterMs?: number | null;
      /** Must be exactly the locked row's current generation + 1. */
      deletionGeneration: number;
    }
);

/** Internal owner-aware view. Unlike public session reads, it can represent an existing tombstone. */
export interface SessionLifecycleRecord {
  session: Session;
  deletedAtMs?: number;
  purgeAfterMs?: number;
  deletionGeneration: number;
}

export type LifecycleOutboxTopic = "session.tombstoned" | "session.purge";

interface LifecycleOutboxRecordBase {
  /** Stable delivery identity. Workers acknowledge one claimed row at a time with this id. */
  outboxId: number;
  topic: LifecycleOutboxTopic;
  aggregateId: string;
  generation: number;
  /** Undefined means deliberately unavailable: physical purge is disabled. */
  availableAtMs?: number;
  attempts: number;
  claimToken?: string;
  leaseUntilMs?: number;
  lastError?: string;
  completedAtMs?: number;
  deadLetteredAtMs?: number;
  createdAtMs: number;
}

export type LifecycleOutboxRecord = LifecycleOutboxRecordBase & (
  | {
      topic: "session.tombstoned";
      payload: { sessionId: string; deletionGeneration: number; eventSeq: number };
    }
  | {
      topic: "session.purge";
      payload: { sessionId: string; deletionGeneration: number };
    }
);

export interface ClaimLifecycleOutboxOptions {
  topics: readonly LifecycleOutboxTopic[];
  nowMs: number;
  limit: number;
  leaseMs: number;
  /** Opaque worker-generated token, compared together with outboxId by every acknowledgement. */
  claimToken: string;
}

export interface RenewLifecycleOutboxClaimOptions {
  nowMs: number;
  leaseMs: number;
}

export interface RetryLifecycleOutboxOptions {
  failedAtMs: number;
  availableAtMs: number;
  error: unknown;
  /** Omit for delivery-critical transient failures that must continue retrying indefinitely. */
  maxAttempts?: number;
}

/**
 * Least-privilege lifecycle worker surface. It intentionally excludes session/content mutations;
 * workers can only lease and acknowledge already-created durable intents.
 */
export interface LifecycleOutboxStore {
  claimLifecycleOutbox(options: ClaimLifecycleOutboxOptions): Promise<LifecycleOutboxRecord[]>;
  renewLifecycleOutboxClaim(
    outboxId: number,
    claimToken: string,
    options: RenewLifecycleOutboxClaimOptions,
  ): Promise<boolean>;
  completeLifecycleOutbox(outboxId: number, claimToken: string, completedAtMs: number): Promise<boolean>;
  retryLifecycleOutbox(
    outboxId: number,
    claimToken: string,
    options: RetryLifecycleOutboxOptions,
  ): Promise<boolean>;
}

export interface SessionFenceClaim {
  /** Expected ownership is checked while the session row is locked. */
  tenantId: string;
  userId: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Fenced write batch. Everything in a batch is applied in one transaction and only if
 * `fence` is >= the session's current fence_token (a stale writer whose lease was taken over
 * is rejected with FenceError). Events get their `seq` assigned inside the transaction.
 */
export interface CommitBatch {
  sessionId: string;
  fence: number;
  /** The only write path allowed to change archive state or mutate an already archived session. */
  lifecycle?: SessionLifecycleTransition;
  /** Pure ownership hand-off: advances only the durable fence before a takeover snapshot is read. */
  fenceClaim?: SessionFenceClaim;
  /** Optional compare-and-swap guard for work prepared from a session snapshot (for example a summary). */
  expectedLastSeq?: number;
  events?: EventInput[];
  items?: Item[];
  /** Must exactly declare every opaque blob reference carried by `items`; finalized atomically. */
  blobBindings?: BlobBinding[];
  turn?: Turn;
  approvals?: Approval[];
  /** Usage entries committed atomically with their milestone event and aggregate projections. */
  usageEntries?: UsageLedgerWrite[];
  /** A completed receipt committed atomically with the first durable write for an idempotent request. */
  idempotency?: IdempotencyReceiptInput;
  sessionPatch?: Partial<Pick<Session, "status" | "title" | "usage" | "contextEpoch" | "metadata" | "autoApprovedTools" | "lastCompactionSeq">>;
}

export interface CommitResult {
  /** events with seq assigned, in input order */
  events: PersistedEvent[];
  lastSeq: number;
  /** Present when this commit installed a new tombstone generation. */
  lifecycleGeneration?: number;
}

/** A fence hand-off must never smuggle business data into the archived/active bypass. */
export function assertPureFenceClaim(batch: CommitBatch): void {
  if (!batch.fenceClaim) return;
  if (
    batch.lifecycle
    || batch.events?.length
    || batch.items?.length
    || batch.blobBindings?.length
    || batch.turn
    || batch.approvals?.length
    || batch.usageEntries?.length
    || batch.idempotency
    || batch.sessionPatch
  ) {
    throw new Error("fenceClaim must be a pure fence-only commit");
  }
}

/** Reject nested resources that try to escape the locked session row. */
export function assertCommitResourceOwnership(batch: CommitBatch): void {
  const assertSession = (resource: { sessionId: string }, kind: string) => {
    if (resource.sessionId !== batch.sessionId) throw new Error(`${kind} does not belong to the committed session`);
  };
  const itemIds = new Set<string>();
  for (const item of batch.items ?? []) {
    assertSession(item, "item");
    if (itemIds.has(item.id)) throw new Error("commit contains the same item more than once");
    itemIds.add(item.id);
  }
  if (batch.turn) assertSession(batch.turn, "turn");
  for (const approval of batch.approvals ?? []) assertSession(approval, "approval");
  for (const event of batch.events ?? []) {
    assertSession(event, "event");
    if ("item" in event) {
      assertSession(event.item, "event item");
      const eventBindings = blobBindingsFromItems([event.item]);
      if (eventBindings.length) {
        const committed = batch.items?.find((item) => item.id === event.item.id);
        const committedBindings = blobBindingsFromItems(committed ? [committed] : []);
        if (
          eventBindings.length !== committedBindings.length
          || eventBindings.some((binding, index) => {
            const expected = committedBindings[index];
            return !expected
              || binding.blobId !== expected.blobId
              || binding.itemId !== expected.itemId
              || binding.purpose !== expected.purpose;
          })
        ) throw new Error("event blob references must match the committed item");
      }
    }
    if ("turn" in event) assertSession(event.turn, "event turn");
    if ("approval" in event) assertSession(event.approval, "event approval");
  }
}

/** A tombstone marker, its terminal event and its outbox intent are one indivisible transition. */
export function assertTombstoneEvent(batch: CommitBatch): void {
  if (batch.lifecycle?.type !== "tombstone") return;
  const events = batch.events ?? [];
  const deleted = events.filter((event) => event.type === "session/deleted");
  const marker = deleted[0];
  if (
    deleted.length !== 1
    || marker?.sessionId !== batch.sessionId
    || marker.deletionGeneration !== batch.lifecycle.deletionGeneration
    || events.at(-1) !== marker
  ) {
    throw new Error("tombstone commit requires one matching terminal session/deleted event");
  }
}

/**
 * Items are committed with `seq: 0`; the store assigns the seq of the first event in the batch that
 * carries the item (item/started or item/completed), or the batch's last seq when none does.
 * Events carrying items are patched in place so store, bus and client agree.
 */
export function assignItemSeqs(items: Item[] | undefined, events: PersistedEvent[], lastSeq: number): void {
  for (const it of items ?? []) {
    if (it.seq !== 0) continue;
    const ev = events.find((e) => (e.type === "item/started" || e.type === "item/completed") && e.item.id === it.id);
    it.seq = ev ? ev.seq : lastSeq;
  }
  for (const e of events) {
    if ((e.type === "item/started" || e.type === "item/completed") && e.item.seq === 0) {
      const it = items?.find((i) => i.id === e.item.id);
      e.item.seq = it?.seq ?? e.seq;
    }
  }
}

/** A terminal turn and its closing events are one batch; make the durable end cursor part of it. */
export function assignTurnSeqEnd(turn: Turn | undefined, events: PersistedEvent[], lastSeq: number): void {
  if (!turn || turn.seqEnd !== undefined) return;
  for (const event of events) {
    if (event.type !== "turn/completed" || event.turn.id !== turn.id) continue;
    turn.seqEnd = lastSeq;
    event.turn.seqEnd = lastSeq;
    return;
  }
}

/**
 * Preserve the historical caller-visible sequence assignment, but only after a commit succeeded.
 * A caller may supply a frozen object or a throwing Proxy; persistence has already committed at this
 * point, so best-effort backfill must never turn that success into an apparent failed transaction.
 */
export function backfillAssignedSequences(
  original: Pick<CommitBatch, "items" | "turn" | "events">,
  committed: { items?: Item[]; turn?: Turn; events: PersistedEvent[] },
): void {
  const set = (target: object, key: PropertyKey, value: unknown) => {
    try {
      Reflect.set(target, key, value);
    } catch {
      // The durable result is authoritative; caller-object backfill is only a compatibility aid.
    }
  };

  for (const [index, item] of (original.items ?? []).entries()) {
    const assigned = committed.items?.[index];
    if (assigned) set(item, "seq", assigned.seq);
  }
  if (original.turn && committed.turn?.seqEnd !== undefined) set(original.turn, "seqEnd", committed.turn.seqEnd);

  for (const [index, event] of (original.events ?? []).entries()) {
    const assigned = committed.events[index];
    if (!assigned) continue;
    if ((event.type === "item/started" || event.type === "item/completed")
      && (assigned.type === "item/started" || assigned.type === "item/completed")) {
      set(event.item, "seq", assigned.item.seq);
    }
    if (event.type === "turn/completed" && assigned.type === "turn/completed" && assigned.turn.seqEnd !== undefined) {
      set(event.turn, "seqEnd", assigned.turn.seqEnd);
    }
  }
}

/** The session no longer exists (deleted). Writes must stop rather than resurrect it. */
export class SessionGoneError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} no longer exists`);
    this.name = "SessionGoneError";
  }
}

/** Normal runtime writes cannot mutate an archived session. */
export class SessionArchivedError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} is archived`);
    this.name = "SessionArchivedError";
  }
}

/** Archive may only linearize while the durable session projection is not active. */
export class SessionLifecycleBusyError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} has an active turn`);
    this.name = "SessionLifecycleBusyError";
  }
}

/** Parent deletion is blocked until every directly related child is itself tombstoned. */
export class SessionHasChildrenError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} has live child sessions`);
    this.name = "SessionHasChildrenError";
  }
}

/** Session ids are globally unique; a concurrent creator must not replace the winner. */
export class SessionExistsError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} already exists`);
    this.name = "SessionExistsError";
  }
}

export class FenceError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly fence: number,
    public readonly currentFence: number,
  ) {
    super(`stale fence ${fence} for session ${sessionId} (current ${currentFence})`);
    this.name = "FenceError";
  }
}

/** A long-running operation prepared its write from a session surface that has since changed. */
export class SessionVersionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly expectedLastSeq: number,
    public readonly currentLastSeq: number,
  ) {
    super(`session ${sessionId} changed from seq ${expectedLastSeq} to ${currentLastSeq}`);
    this.name = "SessionVersionError";
  }
}

/** The same idempotency key already committed an equivalent request. No batch writes were applied. */
export class IdempotencyReplayError extends Error {
  constructor(public readonly receipt: IdempotencyReceipt) {
    super(`idempotency key already committed turn ${receipt.value.turnId}`);
    this.name = "IdempotencyReplayError";
  }
}

/** The same idempotency key was reused for a semantically different request. */
export class IdempotencyMismatchError extends Error {
  constructor(public readonly receipt: IdempotencyReceipt) {
    super("idempotency key was already used for a different request");
    this.name = "IdempotencyMismatchError";
  }
}

/**
 * A pre-atomic runner reserved this key but has not completed it. New runners must not replace the
 * row: the old runner's unconditional completion UPDATE could arrive later and overwrite the new
 * receipt. Operations may clean these rows only after every legacy runner has exited.
 */
export class IdempotencyPendingError extends Error {
  constructor(public readonly expiresAtMs: number) {
    super("idempotency key has a legacy pending reservation");
    this.name = "IdempotencyPendingError";
  }
}

export interface SessionStore {
  // ---- agents ----
  createAgent(def: AgentDefinition): Promise<void>;
  getAgent(tenantId: string, agentId: string, version?: number): Promise<AgentDefinition | null>;
  listAgents(tenantId: string, opts: { cursor?: string; limit: number }): Promise<Page<AgentDefinition>>;

  // ---- sessions ----
  /**
   * Atomically creates a pristine session and its mandatory `session/created` event. The input must
   * have `lastSeq: 0` and `fenceToken: 0`; the stored session and returned cursor start at seq 1.
   */
  createSession(session: Session): Promise<CommitResult>;
  getSession(tenantId: string, sessionId: string): Promise<Session | null>;
  /** Internal lifecycle lookup that also sees an owned tombstone; never expose directly over HTTP. */
  getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null>;
  listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }): Promise<Page<Session>>;

  /** The single fenced write path for anything that belongs to a session. */
  commit(batch: CommitBatch): Promise<CommitResult>;

  // ---- reads ----
  readEvents(sessionId: string, afterSeq: number, limit: number): Promise<PersistedEvent[]>;
  getTurn(sessionId: string, turnId: string): Promise<Turn | null>;
  listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }): Promise<Page<Turn>>;
  /**
   * Items ordered by seq asc. `afterSeq` for incremental loads (e.g. after the last compaction).
   * `newestFirst` changes only WHICH items the limit keeps — the newest ones — while the returned
   * array is still seq-ascending. Truncating to the oldest items would hand the model the start of a
   * long conversation and drop everything recent.
   */
  listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }): Promise<Item[]>;
  getItem(sessionId: string, itemId: string): Promise<Item | null>;
  listApprovals(sessionId: string, opts: { pendingOnly?: boolean }): Promise<Approval[]>;
  getApproval(sessionId: string, approvalId: string): Promise<Approval | null>;

  // ---- provider configs (BYOK) ----
  upsertProviderConfig(cfg: ProviderConfig, secret?: { ciphertext: Buffer; keyId: string }): Promise<void>;
  getProviderConfig(tenantId: string, providerId: string): Promise<{ config: ProviderConfig; secret?: { ciphertext: Buffer; keyId: string } } | null>;
  listProviderConfigs(tenantId: string): Promise<ProviderConfig[]>;
  deleteProviderConfig(tenantId: string, providerId: string): Promise<boolean>;

  // ---- api keys / tenants ----
  resolveApiKey(hashedKey: string): Promise<{ tenantId: string; keyId: string; scopes: ApiKeyScope[] } | null>;
  createApiKey(tenantId: string, keyId: string, hashedKey: string, scopes?: ApiKeyScope[]): Promise<void>;
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;
  revokeApiKey(tenantId: string, keyId: string): Promise<boolean>;
  getTenant(tenantId: string): Promise<TenantRecord | null>;
  /** `undefined` keeps any stored secret, `null` clears it (used when a policy no longer needs one) */
  setTenantAuth(tenantId: string, policy: TenantAuthPolicy, secret?: { ciphertext: Buffer; keyId: string } | null): Promise<void>;

  // ---- usage ledger ----
  queryUsage(tenantId: string, q: UsageQuery): Promise<{ data: UsageRollup[] }>;

  // ---- idempotency ----
  /** Completed receipts only; pending reservations are intentionally not part of the protocol. */
  getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null>;

  // ---- lifecycle outbox (diagnostic read; claiming/processing is a separate least-privilege API) ----
  getLifecycleOutbox(
    topic: LifecycleOutboxTopic,
    aggregateId: string,
    generation: number,
  ): Promise<LifecycleOutboxRecord | null>;

  close(): Promise<void>;
}

export interface LeaseAcquireResult {
  ok: true;
  fence: number;
}
export interface LeaseConflict {
  ok: false;
  ownerId: string;
  ownerAddr?: string;
}

/**
 * Single-writer lease per session. Acquire returns a fencing token that must accompany every
 * store commit. The lease is the correctness guarantee; routing is only an optimisation.
 */
export interface LeaseStore {
  acquire(sessionId: string, ownerId: string, ownerAddr: string, ttlMs: number): Promise<LeaseAcquireResult | LeaseConflict>;
  /** returns false if the lease is no longer ours (expired and taken by someone else) */
  renew(sessionId: string, ownerId: string, ttlMs: number): Promise<boolean>;
  release(sessionId: string, ownerId: string): Promise<void>;
  /** owner directory lookup used by agent-router */
  getOwner(sessionId: string): Promise<{ ownerId: string; ownerAddr: string; fence: number } | null>;
  close(): Promise<void>;
}

export type EventListener = (event: Event) => void;

export interface EventSubscriptionOptions {
  afterSeq?: number;
  /** Called after a live transport reconnects so the owner can recover beyond the hot window. */
  onReconnect?: () => void | Promise<void>;
}

/**
 * Cross-replica live fan-out with a short hot replay window. Persisted events are written to the
 * store first, then published here; live-only events are published only here.
 */
export interface EventBus {
  publish(sessionId: string, event: Event): Promise<void>;
  /**
   * Subscribe to live events. `afterSeq` lets the bus replay persisted events from its hot window
   * (best effort; the caller must still read older events from the store).
   */
  subscribe(sessionId: string, listener: EventListener, opts?: EventSubscriptionOptions): Promise<() => void>;
  close(): Promise<void>;
}

/** Durable identity and integrity metadata persisted by the ownership manifest. */
export interface BlobDescriptor {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  contentType?: string;
}

export interface BlobPutOptions {
  /** Server-generated token that also names recoverable filesystem upload artifacts. */
  uploadToken: string;
  /** Hard upper bound checked before copying/allocating the caller's payload. */
  maxBytes: number;
  contentType?: string;
}

export interface BlobReadOptions {
  /** Hard upper bound checked from stored metadata before allocating the payload buffer. */
  maxBytes: number;
}

export interface BlobDeleteOptions {
  /**
   * When present, deletion first establishes a persistent, key-scoped cancellation fence, then
   * removes this upload's temporary artifacts and the final object. Globally unique keys fenced by
   * a manifest-driven delete cannot subsequently be published, even with a different token.
   */
  uploadToken?: string;
}

export interface BlobObject extends BlobDescriptor {
  data: Buffer;
}

/** A globally unique storage key was reused for non-identical bytes or content type. */
export class BlobConflictError extends Error {
  constructor(public readonly storageKey: string) {
    super(`blob ${storageKey} already exists with different content`);
    this.name = "BlobConflictError";
  }
}

/** The caller or stored object exceeds the operation's explicit allocation/read ceiling. */
export class BlobTooLargeError extends Error {
  constructor(
    public readonly storageKey: string,
    public readonly maxBytes: number,
    public readonly actualBytes: number,
  ) {
    super(`blob ${storageKey} is ${actualBytes} bytes, exceeding the ${maxBytes} byte limit`);
    this.name = "BlobTooLargeError";
  }
}

export interface BlobStore {
  /** Stable adapter identity recorded by the manifest; changing it requires an explicit migration. */
  readonly backend: string;
  /**
   * Create-only write. An exact byte/content-type retry is idempotent; a non-identical value at the
   * same server-generated key fails with BlobConflictError and is never overwritten.
   */
  putIfAbsent(storageKey: string, data: Buffer | string, options: BlobPutOptions): Promise<BlobDescriptor>;
  /** New business paths address objects by opaque storage key, never by backend-specific URI. */
  get(storageKey: string, options: BlobReadOptions): Promise<BlobObject | null>;
  delete(storageKey: string, options?: BlobDeleteOptions): Promise<void>;
}
