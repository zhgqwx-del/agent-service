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
  /** Optional compare-and-swap guard for work prepared from a session snapshot (for example a summary). */
  expectedLastSeq?: number;
  events?: EventInput[];
  items?: Item[];
  turn?: Turn;
  approvals?: Approval[];
  /** Usage entries committed atomically with their milestone event and aggregate projections. */
  usageEntries?: UsageLedgerWrite[];
  /** A completed receipt committed atomically with the first durable write for an idempotent request. */
  idempotency?: IdempotencyReceiptInput;
  sessionPatch?: Partial<Pick<Session, "status" | "title" | "usage" | "contextEpoch" | "metadata" | "archivedAtMs" | "autoApprovedTools" | "lastCompactionSeq">>;
}

export interface CommitResult {
  /** events with seq assigned, in input order */
  events: PersistedEvent[];
  lastSeq: number;
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
  createSession(session: Session): Promise<void>;
  getSession(tenantId: string, sessionId: string): Promise<Session | null>;
  listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }): Promise<Page<Session>>;
  deleteSession(tenantId: string, sessionId: string): Promise<boolean>;

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
  subscribe(sessionId: string, listener: EventListener, opts?: { afterSeq?: number }): Promise<() => void>;
  close(): Promise<void>;
}

export interface BlobStore {
  put(key: string, data: Buffer | string, contentType?: string): Promise<{ ref: string }>;
  get(ref: string): Promise<{ data: Buffer; contentType?: string } | null>;
  delete(ref: string): Promise<void>;
}
