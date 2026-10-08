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
import { DEFAULT_AUTH_POLICY, DEFAULT_SCOPES, addUsage, emptyUsage } from "@agent-service/protocol";
import {
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
  assertPureFenceClaim,
  assertTombstoneEvent,
  assignItemSeqs,
  assignTurnSeqEnd,
  backfillAssignedSequences,
  type BlobStore,
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
  type UsageLedgerEntry,
} from "./types.js";
import { validateBlobKey } from "./blob/key.js";
import {
  assertLifecycleOutboxId,
  parseLifecycleOutboxEnvelope,
  sanitizeLifecycleOutboxError,
  validateClaimLifecycleOutboxOptions,
  validateLifecycleOutboxAck,
  validateRenewLifecycleOutboxClaim,
  validateRetryLifecycleOutboxOptions,
} from "./lifecycle-outbox.js";

const clone = <T>(v: T): T => structuredClone(v);

function paginate<T>(rows: T[], key: (r: T) => string, cursor: string | undefined, limit: number, dir: "asc" | "desc"): Page<T> {
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (dir === "desc") sorted.reverse();
  const start = cursor ? sorted.findIndex((r) => key(r) === cursor) + 1 : 0;
  const slice = sorted.slice(start, start + limit);
  const last = slice.at(-1);
  return { data: slice.map(clone), nextCursor: last && start + limit < sorted.length ? key(last) : null };
}

/** In-memory store: reference semantics for tests. Single process only. */
export class MemorySessionStore implements SessionStore, LifecycleOutboxStore {
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
  tenants = new Map<string, TenantRecord>();

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
    const stagedEvent = clone<PersistedEvent>({
      type: "session/created",
      sessionId: session.id,
      emittedAtMs: session.createdAtMs,
      seq: 1,
    });
    stagedSession.lastSeq = 1;

    this.sessions.set(session.id, stagedSession);
    this.events.set(session.id, [stagedEvent]);
    return { events: [clone(stagedEvent)], lastSeq: 1 };
  }
  async getSession(tenantId: string, sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s && s.tenantId === tenantId && !this.deleted.has(sessionId) ? clone(s) : null;
  }
  async getSessionLifecycle(tenantId: string, userId: string, sessionId: string): Promise<SessionLifecycleRecord | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId || session.userId !== userId) return null;
    const tombstone = this.deleted.get(sessionId);
    return {
      session: clone(session),
      deletedAtMs: tombstone?.deletedAtMs,
      purgeAfterMs: tombstone?.purgeAfterMs,
      deletionGeneration: tombstone?.deletionGeneration ?? 0,
    };
  }
  async listSessions(tenantId: string, opts: { userId?: string; cursor?: string; limit: number; includeArchived?: boolean }) {
    const rows = [...this.sessions.values()].filter(
      (s) => s.tenantId === tenantId && !this.deleted.has(s.id) && (!opts.userId || s.userId === opts.userId) && (opts.includeArchived || !s.archivedAtMs),
    );
    return paginate(rows, (s) => s.id, opts.cursor, opts.limit, "desc");
  }
  async commit(batch: CommitBatch): Promise<CommitResult> {
    assertPureFenceClaim(batch);
    assertTombstoneEvent(batch);
    const s = this.sessions.get(batch.sessionId);
    if (!s || this.deleted.has(batch.sessionId)) throw new SessionGoneError(batch.sessionId);
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
    for (const entry of stagedUsage) {
      const key = JSON.stringify([entry.sessionId, entry.turnId, entry.step]);
      if (usageKeys.has(key)) throw new Error(`duplicate usage entry for turn ${entry.turnId} step ${entry.step}`);
      usageKeys.add(key);
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
    const stagedEvents = out.map(clone);
    const stagedItems = (batch.items ?? []).map(clone);
    const stagedTurn = batch.turn ? clone(batch.turn) : undefined;
    const stagedApprovals = (batch.approvals ?? []).map(clone);
    const stagedIdempotencyValue = batch.idempotency ? clone(batch.idempotency.value) : undefined;
    const stagedSessionPatch = batch.sessionPatch ? clone(batch.sessionPatch) : undefined;
    const stagedLifecycle = batch.lifecycle ? clone(batch.lifecycle) : undefined;
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

    s.fenceToken = batch.fence;
    const log = this.events.get(batch.sessionId)!;
    log.push(...stagedEvents);
    s.lastSeq = seq;
    for (const it of stagedItems) this.items.set(it.id, it);
    if (stagedTurn) this.turns.set(stagedTurn.id, stagedTurn);
    for (const a of stagedApprovals) this.approvals.set(a.id, a);
    this.usageLedger.push(...stagedUsage);
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
    backfillAssignedSequences(batch, { items: stagedItems, turn: stagedTurn, events: stagedEvents });
    return {
      events: resultEvents,
      lastSeq: seq,
      lifecycleGeneration: stagedLifecycle?.type === "tombstone" ? stagedLifecycle.deletionGeneration : undefined,
    };
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    // Deliberately raw: an already-established SSE subscription must be able to deliver the final
    // session/deleted event. Public subscription setup performs an owner-aware session check first.
    return (this.events.get(sessionId) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit).map(clone);
  }
  async getTurn(sessionId: string, turnId: string) {
    if (this.deleted.has(sessionId)) return null;
    const t = this.turns.get(turnId);
    return t && t.sessionId === sessionId ? clone(t) : null;
  }
  async listTurns(sessionId: string, opts: { cursor?: string; limit: number; sortDirection?: "asc" | "desc" }) {
    if (this.deleted.has(sessionId)) return { data: [], nextCursor: null };
    const rows = [...this.turns.values()].filter((t) => t.sessionId === sessionId);
    return paginate(rows, (t) => t.id, opts.cursor, opts.limit, opts.sortDirection ?? "desc");
  }
  async listItems(sessionId: string, opts: { turnId?: string; afterSeq?: number; limit: number; newestFirst?: boolean }) {
    if (this.deleted.has(sessionId)) return [];
    const all = [...this.items.values()]
      .filter((i) => i.sessionId === sessionId && (!opts.turnId || i.turnId === opts.turnId) && i.seq > (opts.afterSeq ?? -1))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
    const kept = opts.newestFirst ? all.slice(Math.max(0, all.length - opts.limit)) : all.slice(0, opts.limit);
    return kept.map(clone);
  }
  async getItem(sessionId: string, itemId: string) {
    if (this.deleted.has(sessionId)) return null;
    const i = this.items.get(itemId);
    return i && i.sessionId === sessionId ? clone(i) : null;
  }
  async listApprovals(sessionId: string, opts: { pendingOnly?: boolean }) {
    if (this.deleted.has(sessionId)) return [];
    return [...this.approvals.values()]
      .filter((a) => a.sessionId === sessionId && (!opts.pendingOnly || a.status === "pending"))
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map(clone);
  }
  async getApproval(sessionId: string, approvalId: string) {
    if (this.deleted.has(sessionId)) return null;
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
    const rows = this.usageLedger.filter(
      (e) =>
        e.tenantId === tenantId &&
        !this.deleted.has(e.sessionId) &&
        (!q.userId || e.userId === q.userId) &&
        (!q.sessionId || e.sessionId === q.sessionId) &&
        (q.from === undefined || e.createdAtMs >= q.from) &&
        (q.to === undefined || e.createdAtMs < q.to),
    );
    const keyOf = (e: UsageLedgerEntry) =>
      q.groupBy === "user" ? e.userId
      : q.groupBy === "session" ? e.sessionId
      : q.groupBy === "model" ? `${e.provider}/${e.model}`
      : q.groupBy === "day" ? new Date(e.createdAtMs).toISOString().slice(0, 10)
      : "total";
    const acc = new Map<string, { turns: Set<string>; steps: number; usage: Usage }>();
    for (const e of rows) {
      const k = keyOf(e);
      const cur = acc.get(k) ?? { turns: new Set<string>(), steps: 0, usage: emptyUsage() };
      cur.turns.add(e.turnId);
      cur.steps += 1;
      cur.usage = addUsage(cur.usage, e.usage);
      acc.set(k, cur);
    }
    return {
      data: [...acc.entries()]
        .map(([key, v]) => ({ key, turns: v.turns.size, steps: v.steps, usage: v.usage }))
        .sort((a, b) => (b.usage.totalTokens - a.usage.totalTokens) || a.key.localeCompare(b.key))
        .slice(0, q.limit),
    };
  }

  private idempotencyMapKey(scope: IdempotencyScope, key: string) {
    // JSON encoding keeps the tuple unambiguous even when an opaque client key contains separators.
    return JSON.stringify([scope.tenantId, scope.userId, scope.sessionId, key]);
  }

  async getIdempotencyKey(scope: IdempotencyScope, key: string): Promise<IdempotencyReceipt | null> {
    if (this.deleted.has(scope.sessionId)) return null;
    const k = this.idempotencyMapKey(scope, key);
    const cur = this.idem.get(k);
    if (!cur || cur.expiresAt < Date.now() || !cur.value) return null;
    return { requestHash: cur.requestHash, value: clone(cur.value), expiresAtMs: cur.expiresAt };
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
  private readonly blobs = new Map<string, { data: Buffer; contentType?: string }>();
  private keyFromRef(ref: string) {
    if (!ref.startsWith("mem://")) throw new Error("invalid memory blob reference");
    const key = ref.slice("mem://".length);
    validateBlobKey(key);
    return key;
  }
  async put(key: string, data: Buffer | string, contentType?: string) {
    validateBlobKey(key);
    this.blobs.set(key, { data: Buffer.from(data), contentType });
    return { ref: `mem://${key}` };
  }
  async get(ref: string) {
    const blob = this.blobs.get(this.keyFromRef(ref));
    return blob ? { ...blob, data: Buffer.from(blob.data) } : null;
  }
  async delete(ref: string) {
    this.blobs.delete(this.keyFromRef(ref));
  }
}
