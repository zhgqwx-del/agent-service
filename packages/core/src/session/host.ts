import {
  ApiError,
  addUsage,
  emptyUsage,
  mergeLimits,
  type AgentDefinition,
  type Approval,
  type ApprovalDecision,
  type CreateSessionRequest,
  type DynamicToolDeclaration,
  type Event,
  type EventInput,
  type InputPart,
  type Item,
  type ItemOf,
  type PersistedEvent,
  type Principal,
  type Session,
  type StartTurnRequest,
  type StopReason,
  type Turn,
  type Usage,
} from "@agent-service/protocol";
import type { CommitBatch, EventBus, EventListener, IdempotencyReceiptInput, LeaseStore, SessionStore } from "@agent-service/store";
import { FenceError, IdempotencyMismatchError, IdempotencyPendingError, IdempotencyReplayError, SessionGoneError } from "@agent-service/store";
import type { AgentEngine, AssistantStepResult, BeforeToolCallDecision, EngineRun, EngineSink, ResolvedModel, Summariser } from "../engine/types.js";
import { buildSystemPrompt, computeContextEpoch, sha256, stableStringify, type SkillSummary } from "../context/assemble.js";
import { projectItems, pruneToolResults } from "../context/history.js";
import { COMPACTION_SYSTEM_PROMPT, planCompaction, renderForSummary, transcriptTokens } from "../context/compact.js";
import { newId } from "../ids.js";
import type { RunnerTool, ToolRegistry } from "../tools/types.js";
import { DynamicToolBridge } from "../tools/dynamic.js";

export interface ProviderResolver {
  resolve(principal: Principal, ref: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }): Promise<ResolvedModel>;
}

export interface SkillSource {
  list(principal: Principal, names: string[]): Promise<SkillSummary[]>;
}

/**
 * A turn that passed every precondition (auth, busy policy, lease, model resolution) and is already
 * persisted as `turn/started`. The engine has NOT started yet: call `run()` after the client's event
 * stream is attached, so a streaming caller can still receive a proper HTTP error from the preflight.
 */
export interface BegunTurn {
  turn: Turn;
  session: Session;
  /** true when this request replayed an already committed idempotency receipt */
  replayed?: boolean;
  /** true when the input was folded into an already-running turn (busyPolicy=steer) */
  steered?: boolean;
  run: () => void;
}

export interface SessionHostConfig {
  runnerId: string;
  runnerAddr: string;
  leaseTtlMs?: number;
  /** keep the lease this long after a turn ends so the next turn on this runner is a cheap re-acquire */
  leaseHoldMs?: number;
  approvalTtlMs?: number;
  dynamicToolTimeoutMs?: number;
  /** fraction of the model's context window the projected transcript may occupy before cheap pruning */
  contextBudgetRatio?: number;
  /** of the context budget, how much the kept tail may use when summarising (rest is for the summary + new turn) */
  compactionKeepRatio?: number;
  /** cap on summary length */
  compactionMaxTokens?: number;
  hotReplayWindowMs?: number;
  /** lifetime of a completed turn idempotency receipt */
  idempotencyTtlMs?: number;
}

export interface SessionHostDeps {
  store: SessionStore;
  /** optional: without one, long sessions fall back to cheap pruning only */
  summariser?: Summariser;
  lease: LeaseStore;
  bus: EventBus;
  engine: AgentEngine;
  tools: ToolRegistry;
  providers: ProviderResolver;
  skills?: SkillSource;
  config: SessionHostConfig;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

interface ActiveTurn {
  turn: Turn;
  session: Session;
  agent: AgentDefinition;
  fence: number;
  abort: AbortController;
  run?: EngineRun;
  limits: ReturnType<typeof mergeLimits>;
  /** set when a commit was rejected by the store's fence check: this runner no longer owns the session */
  fenced?: boolean;
  stopReason?: StopReason;
  limitHit?: StopReason;
  stepUsage: Usage;
  step: number;
  toolCalls: number;
  /** current agentMessage/reasoning item ids for the streaming step */
  agentItemId?: string;
  /** resolves once `item/started` for the streaming agentMessage is persisted and published */
  agentItemStarted?: Promise<unknown>;
  reasoningItemId?: string;
  /** the streaming agentMessage item object, reused across commits to keep its seq stable */
  agentItem?: Item;
  /** serialises delta publication so deltas stay behind item/started and in order */
  deltaChain?: Promise<unknown>;
  agentText: string;
  reasoningText: string;
  lastText: string;
  toolCallItems: Map<string, ItemOf<"toolCall">>;
  pendingApprovals: Map<string, { resolve: (d: ApprovalDecision) => void; timer: NodeJS.Timeout }>;
  autoApproved: Set<string>;
  leaseGuard: LeaseGuard;
  wallClockTimer?: NodeJS.Timeout;
  startedAt: number;
  done: Promise<void>;
  resolveDone: () => void;
  /** per-session write chain: commits (and their publishes) are strictly ordered, so seq order == delivery order */
  chain: Promise<unknown>;
  /** lifecycle gate: only reserved/running turns may admit new steer input */
  phase: "reserved" | "running" | "settling" | "finishing" | "finished";
  /** stop admitting new steer requests while already-admitted requests drain through steerChain */
  closingRequested: boolean;
  /** steer operations admitted before a step boundary; onStepEnd waits for this barrier */
  steerChain: Promise<unknown>;
  /** inputs accepted after turn/start was committed but before the engine was attached */
  pendingSteers: ((InputPart & { type: "text" | "image" })[])[];
  /** makes timeout/drain/lease-loss cleanup safe when more than one stop signal races */
  finishPromise?: Promise<void>;
}

/**
 * Keeps a lease alive from the instant it is acquired, including the potentially slow preflight before
 * an ActiveTurn exists. `wait()` lets non-cancellable reads/model resolution stop blocking the request as
 * soon as ownership is lost; the underlying read may finish later, but no fenced write is allowed after it.
 */
interface LeaseGuard {
  readonly abort: AbortController;
  readonly loss: Promise<ApiError>;
  readonly lost: ApiError | undefined;
  wait<T>(work: Promise<T>): Promise<T>;
  assertOwned(): void;
  attach(onLost: () => void): void;
  stop(): void;
}

interface CompactionResult {
  messages: ReturnType<typeof projectItems>["messages"];
  itemId: string;
}

/** Transport choice (`stream`) does not change the turn resource represented by an idempotency key. */
function turnRequestHash(req: StartTurnRequest): string {
  const { stream: _stream, ...resource } = req;
  return sha256(stableStringify(resource));
}

/** Validate once for both a new turn and busyPolicy/public steer paths. */
function executableInput(parts: InputPart[]): (InputPart & { type: "text" | "image" })[] {
  const unsupported = parts.find((part) => part.type === "skill" || part.type === "mention");
  if (unsupported) throw new ApiError("invalid_request", `input part "${unsupported.type}" is not supported yet (skills land in M3)`);
  if (parts.some((part) => part.type === "image")) {
    throw new ApiError("invalid_request", "image input is not supported yet: attachments need the blob store (M3)");
  }
  const input = parts.filter((part): part is InputPart & { type: "text" | "image" } => part.type === "text" || part.type === "image");
  if (!input.some((part) => part.type === "text")) throw new ApiError("invalid_request", "input must contain at least one text part");
  return input;
}

function isTurnClosing(state: ActiveTurn): boolean {
  return state.phase === "finishing" || state.phase === "finished";
}

/**
 * SessionHost runs turns for sessions this runner owns. It is the only writer for a session while
 * it holds the lease; every write carries the fence token so a stale owner can never corrupt state.
 */
export class SessionHost {
  private readonly active = new Map<string, ActiveTurn>();
  /**
   * Per-session serialisation of turn starts. The lease cannot protect against two concurrent
   * requests on the SAME runner (same owner id gets the same fence), so the busy check and the
   * `active` registration must not be separated by an await for a competing caller.
   */
  private readonly startQueue = new Map<string, Promise<unknown>>();
  private readonly holdTimers = new Map<string, NodeJS.Timeout>();
  private readonly dynamicTools = new DynamicToolBridge();
  private draining = false;
  private readonly log: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: SessionHostDeps) {
    this.log = deps.logger ?? console;
  }

  get cfg() {
    const c = this.deps.config;
    return {
      leaseTtlMs: c.leaseTtlMs ?? 30_000,
      leaseHoldMs: c.leaseHoldMs ?? 60_000,
      approvalTtlMs: c.approvalTtlMs ?? 10 * 60_000,
      dynamicToolTimeoutMs: c.dynamicToolTimeoutMs ?? 5 * 60_000,
      contextBudgetRatio: c.contextBudgetRatio ?? 0.7,
      compactionKeepRatio: c.compactionKeepRatio ?? 0.5,
      compactionMaxTokens: c.compactionMaxTokens ?? 1_500,
      idempotencyTtlMs: c.idempotencyTtlMs ?? 24 * 3_600_000,
    };
  }

  // ---------------- sessions ----------------

  async createSession(principal: Principal, req: CreateSessionRequest): Promise<Session> {
    const agent = await this.deps.store.getAgent(principal.tenantId, req.agentId, req.agentVersion);
    if (!agent) throw new ApiError("not_found", "agent not found");
    const tools = this.deps.tools.resolve(agent.tools);
    const skills = this.deps.skills ? await this.deps.skills.list(principal, agent.skills) : [];
    const systemPrompt = buildSystemPrompt(agent, skills);
    const now = Date.now();
    const session: Session = {
      id: newId("sess"),
      tenantId: principal.tenantId,
      userId: req.userId ?? principal.userId,
      agentId: agent.id,
      agentVersion: agent.version,
      status: { type: "idle" },
      title: req.title,
      parentSessionId: req.parentSessionId,
      lastSeq: 0,
      contextEpoch: computeContextEpoch({ agentId: agent.id, agentVersion: agent.version, systemPrompt, tools, skills }),
      fenceToken: 0,
      usage: emptyUsage(),
      autoApprovedTools: [],
      lastCompactionSeq: undefined,
      createdAtMs: now,
      updatedAtMs: now,
      metadata: req.metadata ?? {},
    };
    await this.deps.store.createSession(session);
    const r = await this.deps.store.commit({ sessionId: session.id, fence: 0, events: [{ type: "session/created", sessionId: session.id, emittedAtMs: now }] });
    await this.publishAll(session.id, r.events);
    return { ...session, lastSeq: r.lastSeq };
  }

  /**
   * Tenant-scoped read. When the caller carries an end-user identity, the session must belong to that
   * user: a tenant's own client must not be able to read another user's session by guessing its id.
   * Tenant-wide reads (admin consoles) omit `X-User-Id` and therefore omit the user check.
   */
  async getSession(principal: Principal, sessionId: string): Promise<Session> {
    // No short-circuit on a missing userId. A route that forgets `requireUser` must fail here rather
    // than quietly return any session in the tenant — that exact short-circuit leaked three routes.
    if (!principal.userId) throw new ApiError("unauthorized", "an end-user identity is required to read a session");
    const s = await this.deps.store.getSession(principal.tenantId, sessionId);
    if (!s) throw new ApiError("not_found", "session not found");
    if (s.userId !== principal.userId) throw new ApiError("not_found", "session not found");
    return s;
  }

  /** Tenant-scoped read for administrative listings, where no single user owns the result. */
  async getSessionAsTenant(tenantId: string, sessionId: string): Promise<Session> {
    const s = await this.deps.store.getSession(tenantId, sessionId);
    if (!s) throw new ApiError("not_found", "session not found");
    return s;
  }

  // ---------------- event subscription ----------------

  /**
   * Replay persisted events after `afterSeq` from the store, then attach to the live bus.
   * Duplicates across the boundary are dropped by seq.
   */
  async subscribe(principal: Principal, sessionId: string, afterSeq: number, listener: EventListener, opts?: { exclude?: Set<string> }): Promise<() => void> {
    await this.getSession(principal, sessionId);
    let seenSeq = afterSeq;
    let closed = false;
    const deliver: EventListener = (e) => {
      if (closed) return;
      const seq = (e as { seq?: number }).seq;
      if (typeof seq === "number") {
        if (seq <= seenSeq) return;
        seenSeq = seq;
      }
      // Excluded persisted events still advance the cursor. Otherwise every later event would look
      // like a gap and repeatedly read the same excluded row from the store.
      if (opts?.exclude?.has(e.type)) return;
      listener(e);
    };

    const backfillBefore = async (targetSeq: number) => {
      while (seenSeq + 1 < targetSeq) {
        const page = await this.deps.store.readEvents(sessionId, seenSeq, 500);
        if (!page.length) break;
        let advanced = false;
        for (const event of page) {
          if (event.seq >= targetSeq) break;
          deliver(event);
          advanced = true;
        }
        if (!advanced || page.at(-1)!.seq >= targetSeq) break;
      }
      if (seenSeq + 1 < targetSeq) {
        throw new Error(`persisted event gap: expected seq ${seenSeq + 1}, received ${targetSeq}`);
      }
    };

    const processLive = async (event: Event) => {
      if (closed) return;
      const seq = (event as { seq?: number }).seq;
      if (typeof seq === "number" && seq > seenSeq + 1) await backfillBefore(seq);
      deliver(event);
    };

    // Subscribe first so nothing is lost between the store read and the live attach.
    const buffer: Event[] = [];
    let buffering = true;
    let liveChain = Promise.resolve();
    const enqueue = (event: Event) => {
      liveChain = liveChain
        .then(() => processLive(event))
        .catch((err) => this.log.warn(`[session ${sessionId}] live event gap recovery failed`, err));
    };
    const unsub = await this.deps.bus.subscribe(sessionId, (event) => {
      if (buffering) buffer.push(event);
      else enqueue(event);
    });
    try {
      let cursor = afterSeq;
      for (;;) {
        const page = await this.deps.store.readEvents(sessionId, cursor, 500);
        for (const event of page) deliver(event);
        if (page.length < 500) break;
        cursor = page.at(-1)!.seq;
      }
      // Keep buffering until every event that arrived during replay has been processed. The loop's
      // final empty check and the flag flip are synchronous, so a publication cannot fall between them.
      while (buffer.length) {
        const batch = buffer.splice(0);
        for (const event of batch) await processLive(event);
      }
      buffering = false;
    } catch (err) {
      closed = true;
      unsub();
      throw err;
    }
    return () => {
      closed = true;
      unsub();
    };
  }

  // ---------------- turns ----------------

  activeTurn(sessionId: string): Turn | undefined {
    return this.active.get(sessionId)?.turn;
  }

  /**
   * Reserve a turn: runs every precondition and persists `turn/started`, then hands back a `run()`
   * that starts the engine. Serialised per session — the lease alone cannot stop two concurrent
   * requests on this same runner, because both would be the same lease owner with the same fence.
   */
  async beginTurn(principal: Principal, sessionId: string, req: StartTurnRequest, opts: { idempotencyKey?: string } = {}): Promise<BegunTurn> {
    return this.serialiseSessionStart(sessionId, () => this.beginTurnLocked(principal, sessionId, req, opts));
  }

  /**
   * Serialise operations which may acquire a session lease before they register in `active`.
   * Explicit compaction shares this queue with turn starts: Redis deliberately treats a re-acquire by
   * the same runner as the same owner, so the lease alone is not a mutex for two local operations.
   */
  private serialiseSessionStart<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const prev = this.startQueue.get(sessionId);
    const running = (prev ? prev.then(noop, noop) : Promise.resolve()).then(operation);
    const guarded = running.then(noop, noop);
    this.startQueue.set(sessionId, guarded);
    void guarded.then(() => {
      if (this.startQueue.get(sessionId) === guarded) this.startQueue.delete(sessionId);
    });
    return running;
  }

  /** Start renewal immediately after acquisition, before any model/store/summariser preflight. */
  private startLeaseGuard(sessionId: string): LeaseGuard {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    let lost: ApiError | undefined;
    let onLost: (() => void) | undefined;
    let resolveLoss!: (error: ApiError) => void;
    const renewEveryMs = Math.max(10, Math.floor(this.cfg.leaseTtlMs / 3));
    const loss = new Promise<ApiError>((resolve) => {
      resolveLoss = resolve;
    });

    const markLost = () => {
      if (stopped || lost) return;
      lost = new ApiError("session_lease_conflict", "session lease was lost");
      abort.abort();
      resolveLoss(lost);
      onLost?.();
    };
    const schedule = () => {
      timer = setTimeout(async () => {
        timer = undefined;
        if (stopped) return;
        let deadline: NodeJS.Timeout | undefined;
        const renewal = this.deps.lease.renew(sessionId, this.deps.config.runnerId, this.cfg.leaseTtlMs).catch(() => false);
        const ok = await Promise.race([
          renewal,
          new Promise<boolean>((resolve) => {
            deadline = setTimeout(() => resolve(false), renewEveryMs);
          }),
        ]);
        if (deadline) clearTimeout(deadline);
        if (stopped) return;
        if (!ok) {
          markLost();
          return;
        }
        schedule();
      }, renewEveryMs);
    };
    schedule();

    return {
      abort,
      loss,
      get lost() {
        return lost;
      },
      async wait<T>(work: Promise<T>): Promise<T> {
        const outcome = await Promise.race([
          work.then(
            (value) => ({ type: "value" as const, value }),
            (error: unknown) => ({ type: "error" as const, error }),
          ),
          loss.then((error) => ({ type: "lost" as const, error })),
        ]);
        if (outcome.type === "value") return outcome.value;
        throw outcome.error;
      },
      assertOwned() {
        if (lost) throw lost;
      },
      attach(callback) {
        onLost = callback;
        if (lost) callback();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
      },
    };
  }

  /** begin + run in one call. Convenience for non-streaming callers and tests. */
  async startTurn(principal: Principal, sessionId: string, req: StartTurnRequest, opts: { idempotencyKey?: string } = {}): Promise<{ turn: Turn; session: Session; steered?: boolean; replayed?: boolean }> {
    const begun = await this.beginTurn(principal, sessionId, req, opts);
    begun.run();
    return { turn: begun.turn, session: begun.session, steered: begun.steered, replayed: begun.replayed };
  }

  private async lookupIdempotentTurn(session: Session, key: string, requestHash: string): Promise<Turn | undefined> {
    let receipt;
    try {
      receipt = await this.deps.store.getIdempotencyKey(
        { tenantId: session.tenantId, userId: session.userId, sessionId: session.id },
        key,
      );
    } catch (err) {
      if (err instanceof IdempotencyPendingError) {
        throw new ApiError("idempotency_conflict", "this Idempotency-Key has a legacy request still in progress");
      }
      throw err;
    }
    if (!receipt) return undefined;
    if (receipt.requestHash && receipt.requestHash !== requestHash) {
      throw new ApiError("idempotency_conflict", "this Idempotency-Key was already used for a different request");
    }
    if (receipt.value.sessionId !== session.id) {
      throw new ApiError("idempotency_conflict", "this Idempotency-Key was used for a different session");
    }
    const turn = await this.deps.store.getTurn(session.id, receipt.value.turnId);
    if (!turn) throw new ApiError("idempotency_conflict", "the original turn is no longer available");
    return turn;
  }

  private async beginTurnLocked(principal: Principal, sessionId: string, req: StartTurnRequest, opts: { idempotencyKey?: string }): Promise<BegunTurn> {
    const session = await this.getSession(principal, sessionId);
    const requestHash = opts.idempotencyKey ? turnRequestHash(req) : undefined;
    const existing = opts.idempotencyKey
      ? await this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!)
      : undefined;
    const local = this.active.get(sessionId);
    if (existing && (existing.status !== "inProgress" || local?.turn.id === existing.id)) {
      return { turn: existing, session, replayed: true, run: noop };
    }
    const probingInProgressReplay = existing?.status === "inProgress" && !local;
    if (this.draining && !probingInProgressReplay) throw new ApiError("draining", "runner is draining");
    const agent = await this.deps.store.getAgent(principal.tenantId, session.agentId, session.agentVersion);
    if (!agent) throw new ApiError("not_found", "agent version not found");
    const busyPolicy = req.busyPolicy ?? agent.busyPolicy;
    const input = executableInput(req.input);

    // Busy handling: the truth is the session status in the store (survives restarts), the active map is our local view.
    if (local) {
      if (busyPolicy === "steer") {
        const idempotency: IdempotencyReceiptInput | undefined = opts.idempotencyKey ? {
          scope: { tenantId: session.tenantId, userId: session.userId, sessionId },
          key: opts.idempotencyKey,
          requestHash: requestHash!,
          value: { turnId: local.turn.id, sessionId },
          expiresAtMs: Date.now() + this.cfg.idempotencyTtlMs,
        } : undefined;
        await this.steerActive(local, req.input, input, idempotency);
        return { turn: local.turn, session, steered: true, run: noop };
      }
      throw new ApiError("session_busy", "a turn is in progress", { turnId: local.turn.id });
    }

    // ---- single writer ----
    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) {
      // The first receipt read can race another runner's atomic turn-start commit. Re-read only after
      // acquisition fails: a matching receipt now proves this request already owns a durable turn and
      // is safe to replay; without one this remains an ordinary lease conflict.
      const racedExisting = opts.idempotencyKey
        ? await this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!)
        : undefined;
      if (racedExisting) {
        return { turn: racedExisting, session, replayed: true, run: noop };
      }
      throw new ApiError("session_lease_conflict", "session owned by another runner", { ownerId: lease.ownerId, ownerAddr: lease.ownerAddr });
    }
    const fence = lease.fence;
    const leaseGuard = this.startLeaseGuard(sessionId);

    try {
      // The snapshot read at entry is stale by now (several awaits, one of them a DB round trip): a
      // turn may have finished in between. Re-read before deciding anything about the session state.
      const fresh = await leaseGuard.wait(this.getSession(principal, sessionId));
      Object.assign(session, fresh);
      const afterLeaseExisting = opts.idempotencyKey
        ? await leaseGuard.wait(this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!))
        : undefined;
      if (afterLeaseExisting) {
        // A response can be lost after the atomic turn-start commit but before run(). If no runner is
        // executing that durable in-progress turn, close it as interrupted before replaying it.
        if (afterLeaseExisting.status === "inProgress") {
          if (session.status.type !== "active" || session.status.turnId !== afterLeaseExisting.id) {
            throw new ApiError("idempotency_conflict", "the idempotent turn is inconsistent with the session state");
          }
          leaseGuard.assertOwned();
          await leaseGuard.wait(this.closeOrphanedTurn(session, fence, leaseGuard));
        }
        const replay = (await this.deps.store.getTurn(sessionId, afterLeaseExisting.id)) ?? afterLeaseExisting;
        leaseGuard.stop();
        await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
        return { turn: replay, session, replayed: true, run: noop };
      }
      // The receipt may have expired between the optimistic lookup and lease acquisition. A draining
      // runner may repair/replay an existing durable turn, but must never fall through and create one.
      if (this.draining) throw new ApiError("draining", "runner is draining");
      if (session.status.type === "active" && !this.active.has(sessionId)) {
        // A previous owner died mid-turn (or we restarted). Close the orphaned turn before starting a new one.
        leaseGuard.assertOwned();
        await leaseGuard.wait(this.closeOrphanedTurn(session, fence, leaseGuard));
      }
      return await this.beginTurnInner(principal, session, agent, req, input, opts, fence, leaseGuard);
    } catch (err) {
      leaseGuard.stop();
      await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
      throw leaseGuard.lost ?? err;
    }
  }

  private async beginTurnInner(
    principal: Principal,
    session: Session,
    agent: AgentDefinition,
    req: StartTurnRequest,
    input: (InputPart & { type: "text" | "image" })[],
    opts: { idempotencyKey?: string },
    fence: number,
    leaseGuard: LeaseGuard,
  ): Promise<BegunTurn> {
    const sessionId = session.id;

    // ---- resolve model, tools, context ----
    const modelRef = { ...agent.model, ...(req.model ?? {}) };
    const model = await leaseGuard.wait(this.deps.providers.resolve(principal, modelRef));
    const tools: RunnerTool[] = [
      ...this.deps.tools.resolve(agent.tools),
      ...(req.dynamicTools ?? []).map((d) => this.dynamicTools.asTool(d, this.cfg.dynamicToolTimeoutMs)),
    ];
    const skills = this.deps.skills ? await leaseGuard.wait(this.deps.skills.list(principal, agent.skills)) : [];
    const systemPrompt = buildSystemPrompt(agent, skills);
    const limits = mergeLimits(agent.limits, req.limits);
    let repairWarning: { code: string; message: string } | undefined;

    const items = await leaseGuard.wait(this.deps.store.listItems(sessionId, { afterSeq: projectFromSeq(session), limit: MAX_PROJECTED_ITEMS, newestFirst: true }));
    const projected = projectItems(items);
    if (projected.repaired.length) {
      this.log.warn(`[session ${sessionId}] repaired ${projected.repaired.length} orphaned tool calls`);
      repairWarning = {
        code: "tool_calls_repaired",
        message: `${projected.repaired.length} tool call(s) from an interrupted turn were resolved as ${[...new Set(projected.repaired.map((r) => r.code))].join("/")}`,
      };
    }
    const budget = Math.floor(model.contextWindow * this.cfg.contextBudgetRatio);
    // Summary tier first: it changes which items are in play. Then cheap pruning on what remains.
    const compacted = await this.maybeCompact(session, fence, items, model, budget, leaseGuard);
    const history = pruneToolResults(compacted?.messages ?? projected.messages, budget);

    // ---- persist turn start + user message ----
    const now = Date.now();
    const turn: Turn = {
      id: newId("turn"),
      sessionId,
      status: "inProgress",
      seqStart: session.lastSeq + 1,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      startedAtMs: now,
      idempotencyKey: opts.idempotencyKey,
      model: { provider: model.provider, model: model.model },
      metadata: req.metadata,
    };
    const userItem: Item = { id: newId("item"), sessionId, turnId: turn.id, seq: 0, status: "completed", createdAtMs: now, completedAtMs: now, type: "userMessage", content: req.input };
    const state: ActiveTurn = {
      turn, session, agent, fence, abort: leaseGuard.abort, leaseGuard, limits,
      stepUsage: emptyUsage(), step: 0, toolCalls: 0, agentText: "", reasoningText: "", lastText: "",
      toolCallItems: new Map(), pendingApprovals: new Map(),
      autoApproved: new Set(session.autoApprovedTools),
      startedAt: now, done: Promise.resolve(), resolveDone: () => {}, chain: Promise.resolve(),
      agentItem: undefined, agentItemStarted: undefined, deltaChain: undefined,
      phase: "reserved", closingRequested: false, steerChain: Promise.resolve(), pendingSteers: [],
    };
    state.done = new Promise((r) => (state.resolveDone = r));
    // Preflight contains provider/store/summariser awaits, during which drain() may observe no active
    // turn and finish. This final synchronous check + registration closes that race: after the check,
    // drain cannot run until `active` contains this state.
    if (this.draining) throw new ApiError("draining", "runner is draining");
    leaseGuard.attach(() => {
      this.log.error(`[session ${sessionId}] lease lost; runner no longer owns the session; aborting turn ${turn.id}`);
      const wasReserved = state.phase === "reserved";
      state.fenced = true;
      state.closingRequested = true;
      state.phase = "finishing";
      state.stopReason = "error";
      this.failPendingApprovals(state, "cancel");
      if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
    });
    this.active.set(sessionId, state);

    try {
      leaseGuard.assertOwned();
      await this.commit(state, {
        turn,
        items: [userItem],
        idempotency: opts.idempotencyKey ? {
          scope: { tenantId: session.tenantId, userId: session.userId, sessionId },
          key: opts.idempotencyKey,
          requestHash: turnRequestHash(req),
          value: { turnId: turn.id, sessionId },
          expiresAtMs: now + this.cfg.idempotencyTtlMs,
        } : undefined,
        events: [
          { type: "turn/started", sessionId, emittedAtMs: now, turn },
          ...(repairWarning ? [{ type: "warning" as const, sessionId, emittedAtMs: now, ...repairWarning }] : []),
          { type: "item/completed", sessionId, emittedAtMs: now, item: userItem },
          { type: "session/status/changed", sessionId, emittedAtMs: now, status: { type: "active", turnId: turn.id, activeFlags: [] } },
        ],
        sessionPatch: { status: { type: "active", turnId: turn.id, activeFlags: [] } },
      });
      leaseGuard.assertOwned();
    } catch (err) {
      this.active.delete(sessionId);
      state.resolveDone();
      if (err instanceof IdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", "this Idempotency-Key was already used for a different request");
      }
      if (err instanceof IdempotencyPendingError) {
        throw new ApiError("idempotency_conflict", "this Idempotency-Key has a legacy request still in progress");
      }
      if (err instanceof IdempotencyReplayError) {
        const existingTurn = await this.deps.store.getTurn(sessionId, err.receipt.value.turnId);
        if (!existingTurn) throw new ApiError("idempotency_conflict", "the original turn is no longer available");
        leaseGuard.stop();
        await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
        return { turn: existingTurn, session, replayed: true, run: noop };
      }
      throw err;
    }

    // ---- wall clock ----
    state.wallClockTimer = setTimeout(() => {
      state.limitHit = "max_wall_clock";
      const wasReserved = state.phase === "reserved";
      void (async () => {
        // Linearise the timeout after every steer which was admitted before this callback. New
        // requests are rejected immediately, while admitted ones still reach the engine/pending queue.
        await this.settleAdmittedSteers(state);
        if (state.phase === "finished") return;
        state.phase = "finishing";
        state.abort.abort();
        // No engine exists yet to drive runEngine() into finishTurn(). Close the durable reservation
        // ourselves so a caller that forgot/died before run() cannot renew this lease forever.
        if (wasReserved) await this.finishTurn(state, { steps: 0, aborted: true });
      })().catch((err) => this.log.error(`[session ${sessionId}] wall-clock cleanup failed`, err));
    }, limits.maxWallClockMs);

    // The engine starts only when the caller says so (see BegunTurn).
    const run = () => {
      if (state.phase !== "reserved" || state.closingRequested) return;
      state.phase = "running";
      void this.runEngine(principal, state, { systemPrompt, tools, history, input, model, limits });
    };
    return { turn, session, run };
  }

  private async runEngine(
    principal: Principal,
    state: ActiveTurn,
    p: { systemPrompt: string; tools: RunnerTool[]; history: ReturnType<typeof projectItems>["messages"]; input: (InputPart & { type: "text" | "image" })[]; model: ResolvedModel; limits: ReturnType<typeof mergeLimits> },
  ) {
    const sessionId = state.session.id;
    const sink = this.makeSink(principal, state, p.tools);
    let result: Awaited<EngineRun["done"]>;
    try {
      const run = this.deps.engine.start(
        {
          systemPrompt: p.systemPrompt,
          tools: p.tools,
          history: p.history,
          input: p.input,
          model: p.model,
          maxOutputTokens: p.limits.maxOutputTokensPerStep,
          signal: state.abort.signal,
          toolContext: { principal, sessionId, turnId: state.turn.id },
        },
        sink,
      );
      state.run = run;
      // busyPolicy=steer can arrive in the intentional beginTurn()/run() gap used to attach SSE.
      // Preserve write-ahead ordering, then feed every admitted input as soon as the engine exists.
      for (const input of state.pendingSteers.splice(0)) run.steer(input);
      result = await run.done;
    } catch (err) {
      result = { steps: state.step, aborted: state.abort.signal.aborted, error: err instanceof Error ? err.message : String(err) };
    }
    await this.finishTurn(state, result).catch((err) => this.log.error(`[session ${sessionId}] finishTurn failed`, err));
  }

  private makeSink(principal: Principal, state: ActiveTurn, tools: RunnerTool[]): EngineSink {
    const sessionId = state.session.id;
    const turnId = state.turn.id;
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const live = (e: Event) => void this.deps.bus.publish(sessionId, e).catch(() => {});

    return {
      onStepStart: (step) => {
        // A next step can already have been scheduled when an interrupt/timeout closes admission.
        // Never let that callback reopen the steer gate.
        if (!state.closingRequested && state.phase !== "finishing" && state.phase !== "finished") state.phase = "running";
        state.step = step;
        state.turn.steps = step;
        state.agentItemId = undefined;
        state.agentItem = undefined;
        state.agentItemStarted = undefined;
        state.reasoningItemId = undefined;
        state.agentText = "";
        state.reasoningText = "";
      },
      onTextDelta: (delta) => {
        if (!state.agentItemId) {
          const id = newId("item");
          state.agentItemId = id;
          // Reuse this exact object on later commits so its seq, assigned here, never changes.
          const item: Item = { id, sessionId, turnId, seq: 0, step: state.step, status: "inProgress", createdAtMs: Date.now(), type: "agentMessage", text: "", phase: "finalAnswer" };
          state.agentItem = item;
          state.agentItemStarted = this.commit(state, {
            items: [item],
            events: [{ type: "item/started", sessionId, emittedAtMs: Date.now(), item }],
          }).catch(() => {});
        }
        state.agentText += delta;
        state.lastText = state.agentText;
        const itemId = state.agentItemId;
        // Ordered behind item/started: a client that creates its render node on `started` would
        // otherwise drop the first chunks of text.
        const started = state.agentItemStarted ?? Promise.resolve();
        state.deltaChain = (state.deltaChain ?? started).then(() =>
          this.deps.bus.publish(sessionId, { type: "item/agentMessage/delta", sessionId, turnId, itemId, delta, emittedAtMs: Date.now() }).catch(() => {}),
        );
      },
      onReasoningDelta: (delta) => {
        if (!state.reasoningItemId) state.reasoningItemId = newId("item");
        state.reasoningText += delta;
        live({ type: "item/reasoning/delta", sessionId, turnId, itemId: state.reasoningItemId, delta, emittedAtMs: Date.now() });
      },
      onToolArgsDelta: (toolCallId, delta) => {
        // Pure tool-call steps have no agentMessage item, so this must not depend on one.
        if (!toolCallId) return;
        live({ type: "item/toolCall/argsDelta", sessionId, turnId, toolCallId, delta, emittedAtMs: Date.now() });
      },

      onAssistantMessage: async (msg) => {
        const now = Date.now();
        if (msg.stopReason === "error" || msg.stopReason === "aborted" || (msg.stopReason === "length" && msg.toolCalls.length === 0)) {
          state.closingRequested = true;
        }
        const items: Item[] = [];
        const events: EventInput[] = [];
        if (msg.reasoning) {
          const item: Item = { id: state.reasoningItemId ?? newId("item"), sessionId, turnId, seq: 0, step: state.step, status: "completed", createdAtMs: now, completedAtMs: now, type: "reasoning", text: msg.reasoning };
          items.push(item);
          events.push({ type: "item/completed", sessionId, emittedAtMs: now, item });
        }
        if (msg.text || state.agentItemId) {
          // `msg.text` can come back empty on an aborted/errored step; keep what we already streamed.
          const text = msg.text || state.agentText;
          const prev = state.agentItem;
          const item: Item = prev
            ? { ...prev, status: msg.stopReason === "error" ? "failed" : "completed", completedAtMs: now, type: "agentMessage", text, phase: "finalAnswer" }
            : { id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: msg.stopReason === "error" ? "failed" : "completed", createdAtMs: now, completedAtMs: now, type: "agentMessage", text, phase: "finalAnswer" };
          items.push(item);
          events.push({ type: "item/completed", sessionId, emittedAtMs: now, item });
          if (text) state.lastText = text;
        }
        // write-ahead: tool calls are persisted BEFORE execution so a crash leaves evidence
        for (const tc of msg.toolCalls) {
          const kind = toolByName.get(tc.name)?.kind ?? "builtin";
          const item: ItemOf<"toolCall"> = { id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: "inProgress", createdAtMs: now, type: "toolCall", toolCallId: tc.id, name: tc.name, kind, args: tc.args };
          state.toolCallItems.set(tc.id, item);
          items.push(item);
          events.push({ type: "item/started", sessionId, emittedAtMs: now, item });
        }
        // usage
        const nextTurnUsage = addUsage(state.turn.usage, msg.usage);
        const nextSessionUsage = addUsage(state.session.usage, msg.usage);
        const nextTurn = { ...state.turn, usage: nextTurnUsage };
        if (state.limits.maxCostCNY && (nextTurnUsage.costCNY ?? 0) > state.limits.maxCostCNY) {
          state.limitHit ??= "max_cost";
          state.closingRequested = true;
        }
        if (msg.stopReason === "length" && msg.toolCalls.length === 0) state.limitHit ??= "max_output_tokens";
        events.push({
          type: "usage/updated", sessionId, emittedAtMs: now, turnId, step: state.step,
          stepUsage: msg.usage, turnUsage: nextTurnUsage, sessionUsage: nextSessionUsage,
          runtime: { provider: msg.provider, model: msg.model },
        });
        await this.commit(state, {
          items,
          events,
          turn: nextTurn,
          usageEntries: [{ turnId, step: state.step, provider: msg.provider, model: msg.model, usage: msg.usage, createdAtMs: now }],
          sessionPatch: { usage: nextSessionUsage },
        });
        state.stepUsage = msg.usage;
        state.turn.usage = nextTurnUsage;
        state.session.usage = nextSessionUsage;
        // Pi does not invoke onStepEnd for provider errors/aborts. When this response closes the
        // turn, drain every steer admitted before closingRequested was set before returning control
        // to the engine, so those promises cannot succeed without engine delivery.
        if (state.closingRequested) await state.steerChain;
      },

      beforeToolCall: async (call, msg) => this.gateToolCall(principal, state, toolByName.get(call.name), call, msg),

      // pi emits tool_execution_start BEFORE the approval gate, so the write-ahead marker is set in
      // gateToolCall once the call is actually allowed to run. Otherwise a crash while waiting for
      // approval would be reported to the model as TOOL_OUTCOME_UNKNOWN ("may have happened") for a
      // tool that never ran.
      onToolExecutionStart: () => {},
      onToolProgress: () => {},
      onToolResult: async (r) => {
        const now = Date.now();
        const call = state.toolCallItems.get(r.toolCallId);
        const items: Item[] = [];
        const events: EventInput[] = [];
        if (call) {
          call.status = call.status === "declined" ? "declined" : r.isError ? "failed" : "completed";
          call.completedAtMs = now;
          items.push(call);
          events.push({ type: "item/completed", sessionId, emittedAtMs: now, item: call });
        }
        const result: Item = { id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: r.isError ? "failed" : "completed", createdAtMs: now, completedAtMs: now, type: "toolResult", toolCallId: r.toolCallId, name: r.name, content: r.content, isError: r.isError, details: r.details };
        items.push(result);
        events.push({ type: "item/completed", sessionId, emittedAtMs: now, item: result });
        await this.commit(state, { items, events });
      },

      onStepEnd: async (step) => {
        if (state.fenced || isTurnClosing(state)) return "end";
        if (state.closingRequested || state.limitHit) {
          await state.steerChain;
          return "end";
        }
        // Close admission before the engine decides whether it has another step. Every steer that
        // was admitted while this step was running is in steerChain; waiting here guarantees its
        // durable item is committed and engine.steer() is called before the loop checks its queue.
        state.phase = "settling";
        await state.steerChain;
        if (state.fenced || state.closingRequested || state.limitHit || isTurnClosing(state)) return "end";
        if (step >= state.limits.maxSteps) {
          state.limitHit = "max_steps";
          state.closingRequested = true;
          return "end";
        }
        // Keep `settling` until the next onStepStart. If the engine naturally stops instead, no
        // late request can persist a steer into a turn that has already gone idle.
        return "continue";
      },
    };
  }

  /** Approval + limits gate; runs before every tool execution. */
  private async gateToolCall(principal: Principal, state: ActiveTurn, tool: RunnerTool | undefined, call: { id: string; name: string; args: unknown }, msg: AssistantStepResult): Promise<BeforeToolCallDecision> {
    const item = state.toolCallItems.get(call.id);
    if (state.fenced) return { allow: false, reason: "this runner no longer owns the session", interrupt: true };
    if (state.limitHit || state.closingRequested || state.phase === "finishing" || state.phase === "finished") {
      return { allow: false, reason: `turn stopped: ${state.limitHit ?? "finishing"}`, interrupt: true };
    }
    if (!tool) return { allow: false, reason: `unknown tool ${call.name}` };
    state.toolCalls += 1;
    state.turn.toolCalls = state.toolCalls;
    if (state.toolCalls > state.limits.maxToolCalls) {
      state.limitHit = "max_tool_calls";
      state.closingRequested = true;
      await state.steerChain;
      return { allow: false, reason: "tool call limit reached", interrupt: true };
    }
    const markStarted = async () => {
      if (!item) return;
      item.startedAtMs = Date.now();
      await this.commit(state, { items: [item] });
    };
    const policy = state.agent.approvalPolicy;
    const needs = policy === "never" ? false : policy === "untrusted" ? !tool.readOnly : !!tool.needsApproval;
    if (!needs || state.autoApproved.has(tool.name)) {
      await markStarted();
      return { allow: true };
    }

    const now = Date.now();
    const approval: Approval = {
      id: newId("apr"), sessionId: state.session.id, turnId: state.turn.id, itemId: item?.id ?? newId("item"),
      status: "pending", toolCallId: call.id, toolName: call.name, args: call.args,
      reason: msg.text || undefined,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      createdAtMs: now, expiresAtMs: now + this.cfg.approvalTtlMs,
    };
    const reqItem: Item = { id: newId("item"), sessionId: state.session.id, turnId: state.turn.id, seq: 0, step: state.step, status: "inProgress", createdAtMs: now, type: "approvalRequest", approvalId: approval.id, toolCallId: call.id, name: call.name, args: call.args };
    const status = { type: "active" as const, turnId: state.turn.id, activeFlags: ["waitingOnApproval" as const] };
    await this.commit(state, {
      approvals: [approval], items: [reqItem],
      events: [
        { type: "item/started", sessionId: state.session.id, emittedAtMs: now, item: reqItem },
        { type: "approval/requested", sessionId: state.session.id, emittedAtMs: now, approval },
        { type: "session/status/changed", sessionId: state.session.id, emittedAtMs: now, status },
      ],
      sessionPatch: { status },
    });

    const resolution = await new Promise<{ decision: ApprovalDecision; timedOut: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        state.pendingApprovals.delete(approval.id);
        state.abort.signal.removeEventListener("abort", onAbort);
        // The timer firing is the authoritative timeout signal. Comparing Date.now() alone is racy:
        // its millisecond clock can still read one tick before expiresAtMs on a loaded CI runner.
        resolve({ decision: "decline", timedOut: true });
      }, this.cfg.approvalTtlMs);
      // Without this, drain()/interrupt()/fence-loss would block for the whole approval TTL.
      function onAbort() {
        clearTimeout(timer);
        state.pendingApprovals.delete(approval.id);
        resolve({ decision: "cancel", timedOut: false });
      }
      state.abort.signal.addEventListener("abort", onAbort, { once: true });
      state.pendingApprovals.set(approval.id, {
        timer,
        resolve: (d) => {
          clearTimeout(timer);
          state.abort.signal.removeEventListener("abort", onAbort);
          resolve({ decision: d, timedOut: false });
        },
      });
    });
    const resolvedAt = Date.now();
    const expired = resolution.timedOut || resolvedAt >= approval.expiresAtMs;
    // A user response that reaches the event loop after the deadline must never execute the tool,
    // even when its callback wins the race with the delayed timeout callback.
    const decision: ApprovalDecision = expired ? "decline" : resolution.decision;
    const finalApproval: Approval = { ...approval, status: expired ? "expired" : "resolved", decision, resolvedAtMs: resolvedAt, decidedBy: expired ? "system:timeout" : principal.userId };
    const doneItem: Item = { ...reqItem, status: decision === "accept" || decision === "acceptForSession" ? "completed" : "declined", completedAtMs: resolvedAt };
    const back = { type: "active" as const, turnId: state.turn.id, activeFlags: [] as ("waitingOnApproval" | "waitingOnUserInput")[] };
    if (decision === "acceptForSession") state.autoApproved.add(tool.name);
    await this.commit(state, {
      approvals: [finalApproval], items: [doneItem],
      events: [
        { type: "approval/resolved", sessionId: state.session.id, emittedAtMs: resolvedAt, approval: finalApproval },
        { type: "item/completed", sessionId: state.session.id, emittedAtMs: resolvedAt, item: doneItem },
        { type: "session/status/changed", sessionId: state.session.id, emittedAtMs: resolvedAt, status: back },
      ],
      sessionPatch: { status: back, autoApprovedTools: [...state.autoApproved] },
    });
    if (decision === "accept" || decision === "acceptForSession") {
      await markStarted();
      return { allow: true };
    }
    if (item) item.status = "declined";
    if (decision === "cancel") {
      state.stopReason = "interrupted";
      state.closingRequested = true;
      await state.steerChain;
      return { allow: false, reason: "declined by user; turn interrupted", interrupt: true };
    }
    return { allow: false, reason: expired ? "approval expired" : "declined by user" };
  }

  /** Where a session is actually running, so a 409 can tell the router where to retry. */
  private async ownerDetails(sessionId: string): Promise<{ ownerId?: string; ownerAddr?: string }> {
    const owner = await this.deps.lease.getOwner(sessionId).catch(() => null);
    return owner ? { ownerId: owner.ownerId, ownerAddr: owner.ownerAddr } : {};
  }

  async resolveApproval(principal: Principal, sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    await this.getSession(principal, sessionId);
    const state = this.active.get(sessionId);
    const pending = state?.pendingApprovals.get(approvalId);
    if (!pending) {
      const stored = await this.deps.store.getApproval(sessionId, approvalId);
      if (!stored) throw new ApiError("not_found", "approval not found");
      if (stored.status !== "pending") throw new ApiError("approval_expired", `approval already ${stored.status}`);
      // pending in the store but not on this runner: the owner is elsewhere, and the router needs to know
      throw new ApiError("session_lease_conflict", "approval is owned by another runner", await this.ownerDetails(sessionId));
    }
    clearTimeout(pending.timer);
    state!.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
    // wait for the resolution commit to land so the caller sees the resolved row
    for (let i = 0; i < 50; i++) {
      const a = await this.deps.store.getApproval(sessionId, approvalId);
      if (a && a.status !== "pending") return a;
      await new Promise((r) => setTimeout(r, 20));
    }
    return (await this.deps.store.getApproval(sessionId, approvalId))!;
  }

  async steer(
    principal: Principal,
    sessionId: string,
    turnId: string,
    req: { input: InputPart[]; expectedTurnId?: string },
    idempotency?: IdempotencyReceiptInput,
  ): Promise<void> {
    await this.getSession(principal, sessionId);
    const state = this.active.get(sessionId);
    if (!state || state.turn.id !== turnId) {
      const owner = await this.ownerDetails(sessionId);
      if (owner.ownerAddr && owner.ownerId !== this.deps.config.runnerId) {
        throw new ApiError("session_lease_conflict", "this turn is owned by another runner", owner);
      }
      throw new ApiError("not_found", "no active turn with that id on this runner");
    }
    if (req.expectedTurnId && req.expectedTurnId !== turnId) throw new ApiError("invalid_request", "expectedTurnId mismatch");
    await this.steerActive(state, req.input, executableInput(req.input), idempotency);
  }

  /** Admit one steer against the exact ActiveTurn already selected by the caller. */
  private async steerActive(
    state: ActiveTurn,
    originalInput: InputPart[],
    input: (InputPart & { type: "text" | "image" })[],
    idempotency?: IdempotencyReceiptInput,
  ): Promise<void> {
    const sessionId = state.session.id;
    const turnId = state.turn.id;
    if (this.active.get(sessionId) !== state || state.fenced || state.closingRequested || (state.phase !== "reserved" && state.phase !== "running")) {
      throw new ApiError("session_busy", "the active turn is no longer accepting steer input", { turnId });
    }

    const operation = async () => {
      // The operation was admitted before a step entered `settling`, so that phase is allowed here.
      // A real stop/ownership change wins over an operation which has not reached its durable write.
      if (this.active.get(sessionId) !== state || state.fenced || isTurnClosing(state)) {
        throw new ApiError("session_busy", "the active turn is no longer accepting steer input", { turnId });
      }
      const now = Date.now();
      const item: Item = {
        id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: "completed",
        createdAtMs: now, completedAtMs: now, type: "userMessage", content: originalInput,
      };
      try {
        await this.commit(state, {
          items: [item],
          idempotency,
          events: [
            { type: "item/completed", sessionId, emittedAtMs: now, item },
            { type: "turn/steered", sessionId, emittedAtMs: now, turnId, itemId: item.id },
          ],
        });
      } catch (err) {
        if (err instanceof IdempotencyMismatchError) {
          throw new ApiError("idempotency_conflict", "this Idempotency-Key was already used for a different request");
        }
        if (err instanceof IdempotencyPendingError) {
          throw new ApiError("idempotency_conflict", "this Idempotency-Key has a legacy request still in progress");
        }
        if (
          err instanceof IdempotencyReplayError
          && idempotency
          && err.receipt.value.turnId === turnId
          && (!err.receipt.requestHash || err.receipt.requestHash === idempotency.requestHash)
        ) return;
        throw err;
      }
      // A stop request closes admission synchronously but must drain operations already admitted.
      // Only ownership/storage failure may prevent delivery, and that must reject this request rather
      // than return a false success after its user item was committed.
      if (this.active.get(sessionId) !== state || state.fenced || isTurnClosing(state)) {
        throw new ApiError(
          state.fenced ? "session_lease_conflict" : "session_busy",
          "the accepted steer could not be delivered because the turn lost ownership",
          { turnId },
        );
      }
      if (state.run) state.run.steer(input);
      else state.pendingSteers.push(input);
    };

    const admitted = state.steerChain.then(operation, operation);
    state.steerChain = admitted.catch(() => {});
    await admitted;
  }

  /** Close admission synchronously, then wait for every operation already linked into steerChain. */
  private async settleAdmittedSteers(state: ActiveTurn): Promise<void> {
    state.closingRequested = true;
    await state.steerChain;
  }

  async interrupt(principal: Principal, sessionId: string, turnId: string): Promise<Turn> {
    await this.getSession(principal, sessionId);
    const state = this.active.get(sessionId);
    if (!state || state.turn.id !== turnId) {
      const t = await this.deps.store.getTurn(sessionId, turnId);
      if (!t) throw new ApiError("not_found", "turn not found");
      if (t.status !== "inProgress") return t;
      throw new ApiError("session_lease_conflict", "turn is owned by another runner", await this.ownerDetails(sessionId));
    }
    const wasReserved = state.phase === "reserved";
    state.stopReason = "interrupted";
    await this.settleAdmittedSteers(state);
    if (state.phase === "finished") return (await this.deps.store.getTurn(sessionId, turnId)) ?? state.turn;
    state.phase = "finishing";
    // Cancel (not decline) pending approvals first, so history records a user interrupt rather than
    // a refusal, then abort. Bounded wait: a wedged engine must not hang the HTTP request.
    this.failPendingApprovals(state, "cancel");
    state.abort.abort();
    if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch((err) => this.log.error(`[session ${sessionId}] pre-run interrupt cleanup failed`, err));
    await Promise.race([state.done, new Promise((r) => setTimeout(r, 10_000))]);
    return (await this.deps.store.getTurn(sessionId, turnId)) ?? state.turn;
  }

  /** Async twin of submitDynamicToolResult that reports the owner when this runner is not it. */
  async submitDynamicToolResultOrThrow(sessionId: string, toolCallId: string, result: { content: { type: "text"; text: string }[]; isError: boolean }): Promise<void> {
    if (this.submitDynamicToolResult(sessionId, toolCallId, result)) return;
    const owner = await this.ownerDetails(sessionId);
    if (owner.ownerAddr && owner.ownerId !== this.deps.config.runnerId) {
      throw new ApiError("session_lease_conflict", "this session is owned by another runner", owner);
    }
    throw new ApiError("not_found", "no pending dynamic tool call with that id on this runner");
  }

  submitDynamicToolResult(sessionId: string, toolCallId: string, result: { content: { type: "text"; text: string }[]; isError: boolean }): boolean {
    if (!this.active.has(sessionId)) return false;
    return this.dynamicTools.resolve(sessionId, toolCallId, result);
  }

  // ---------------- compaction ----------------

  /**
   * Replace the older part of the transcript with a summary, at a turn boundary, and persist it as a
   * `contextCompaction` item so every later projection starts from it. Returns the new transcript, or
   * undefined when nothing was done.
   */
  private async maybeCompact(
    session: Session,
    fence: number,
    items: Item[],
    model: ResolvedModel,
    budgetTokens: number,
    leaseGuard?: LeaseGuard,
  ): Promise<CompactionResult | undefined> {
    if (!this.deps.summariser) return undefined;
    const plan = planCompaction(items, { budgetTokens, keepRatio: this.cfg.compactionKeepRatio });
    if (!plan) return undefined;
    const surfaceLastSeq = session.lastSeq;
    let summary: Awaited<ReturnType<Summariser["summarise"]>>;
    try {
      const work = this.deps.summariser.summarise({
        model,
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        text: renderForSummary(projectItems(plan.summarise).messages),
        maxTokens: this.cfg.compactionMaxTokens,
        signal: leaseGuard?.abort.signal,
      });
      summary = leaseGuard ? await leaseGuard.wait(work) : await work;
      if (!summary.text.trim()) throw new Error("summariser returned nothing");
    } catch (err) {
      if (leaseGuard?.lost) throw leaseGuard.lost;
      // Compaction is an optimisation: if the summariser fails, carry on with the pruned transcript.
      this.log.warn(`[session ${session.id}] compaction skipped: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }

    const { text, usage } = summary;
    const now = Date.now();
    const item: Item = {
      id: newId("item"), sessionId: session.id, turnId: newId("turn"), seq: 0, status: "completed",
      createdAtMs: now, completedAtMs: now, type: "contextCompaction",
      replacesUpToSeq: plan.keepFromSeq - 1, summary: text, usageSnapshot: usage,
    };
    leaseGuard?.assertOwned();
    const nextSessionUsage = addUsage(session.usage, usage);
    // Summary item, both durable events, accounting and the projection watermark are one fenced
    // transaction. A crash or takeover can therefore expose either the old surface or the complete
    // new surface, never a summary item with a stale watermark.
    const compactCommit = await this.deps.store.commit({
      sessionId: session.id, fence, expectedLastSeq: surfaceLastSeq, items: [item],
      events: [
        { type: "item/completed", sessionId: session.id, emittedAtMs: now, item },
        { type: "session/compacted", sessionId: session.id, emittedAtMs: now, itemId: item.id },
      ],
      usageEntries: [{ turnId: item.turnId, step: 0, provider: model.provider, model: model.model, usage, createdAtMs: now }],
      // The watermark is the first KEPT item, not the summary item: projecting from the summary would
      // also drop the recent turns this plan deliberately preserved.
      sessionPatch: { lastCompactionSeq: plan.keepFromSeq, usage: nextSessionUsage },
    });
    await this.publishAll(session.id, compactCommit.events);
    session.lastCompactionSeq = plan.keepFromSeq;
    session.usage = nextSessionUsage;
    session.lastSeq = compactCommit.lastSeq;
    this.log.info(`[session ${session.id}] compacted ${plan.summarise.length} items (~${plan.droppedTokens} tokens) into a summary; keeping from seq ${plan.keepFromSeq}`);
    // Re-project from the new watermark so the caller sees exactly what later turns will see.
    const keptWork = this.deps.store.listItems(session.id, { afterSeq: plan.keepFromSeq - 1, limit: MAX_PROJECTED_ITEMS, newestFirst: true });
    const kept = leaseGuard ? await leaseGuard.wait(keptWork) : await keptWork;
    return { messages: projectItems(kept).messages, itemId: item.id };
  }

  /** Explicit compaction (POST /sessions/:id/compact): same path, ignoring the budget check. */
  async compactSession(principal: Principal, sessionId: string): Promise<{ compacted: boolean; summaryItemId?: string }> {
    return this.serialiseSessionStart(sessionId, () => this.compactSessionLocked(principal, sessionId));
  }

  private async compactSessionLocked(principal: Principal, sessionId: string): Promise<{ compacted: boolean; summaryItemId?: string }> {
    if (!this.deps.summariser) throw new ApiError("invalid_request", "this runner has no summariser configured");
    const session = await this.getSession(principal, sessionId);
    if (this.active.has(sessionId)) throw new ApiError("session_busy", "cannot compact while a turn is running");
    const agent = await this.deps.store.getAgent(principal.tenantId, session.agentId, session.agentVersion);
    if (!agent) throw new ApiError("not_found", "agent version not found");
    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) throw new ApiError("session_lease_conflict", "session owned by another runner", { ownerId: lease.ownerId, ownerAddr: lease.ownerAddr });
    const leaseGuard = this.startLeaseGuard(sessionId);
    try {
      const fresh = await leaseGuard.wait(this.getSession(principal, sessionId));
      Object.assign(session, fresh);
      if (session.status.type === "active" || this.active.has(sessionId)) throw new ApiError("session_busy", "cannot compact while a turn is running");
      const model = await leaseGuard.wait(this.deps.providers.resolve(principal, agent.model));
      const items = await leaseGuard.wait(this.deps.store.listItems(sessionId, { afterSeq: projectFromSeq(session), limit: MAX_PROJECTED_ITEMS, newestFirst: true }));
      // force a cut by setting the budget below the current size
      const result = await this.maybeCompact(session, lease.fence, items, model, Math.floor(transcriptTokens(projectItems(items).messages) * 0.5), leaseGuard);
      leaseGuard.assertOwned();
      return { compacted: !!result, summaryItemId: result?.itemId };
    } catch (err) {
      throw leaseGuard.lost ?? err;
    } finally {
      leaseGuard.stop();
      await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
    }
  }

  // ---------------- finishing ----------------

  private finishTurn(state: ActiveTurn, result: Awaited<EngineRun["done"]>): Promise<void> {
    if (state.finishPromise) return state.finishPromise;
    state.closingRequested = true;
    const finishing = (async () => {
      await state.steerChain;
      state.phase = "finishing";
      await this.finishTurnOnce(state, result);
    })();
    state.finishPromise = finishing;
    return finishing;
  }

  private async finishTurnOnce(state: ActiveTurn, result: Awaited<EngineRun["done"]>) {
    const sessionId = state.session.id;
    clearTimeout(state.wallClockTimer);
    for (const [, p] of state.pendingApprovals) clearTimeout(p.timer);
    state.pendingApprovals.clear();

    const now = Date.now();
    const turn = state.turn;
    let stopReason: StopReason;
    if (state.stopReason === "interrupted") stopReason = "interrupted";
    else if (state.stopReason === "error") stopReason = "error";
    else if (state.limitHit) stopReason = state.limitHit;
    else if (result.error) stopReason = "error";
    else if (result.aborted) stopReason = "interrupted";
    else stopReason = "end_turn";
    turn.status = stopReason === "error" ? "failed" : stopReason === "interrupted" ? "interrupted" : "completed";
    turn.stopReason = stopReason;
    turn.completedAtMs = now;
    turn.partialText = stopReason !== "end_turn" && state.lastText ? state.lastText : undefined;
    if (result.error) turn.error = { code: "provider_error", message: result.error };

    // an agentMessage that was streaming when we stopped must not stay inProgress
    const items: Item[] = [];
    const streaming = state.agentItem;
    if (streaming && streaming.status === "inProgress") {
      if (streaming.type === "agentMessage") streaming.text = state.agentText;
      streaming.status = "completed";
      streaming.completedAtMs = now;
      items.push(streaming);
    }
    // Tool calls that never got dispatched must not stay `inProgress` forever.
    for (const call of state.toolCallItems.values()) {
      if (call.status === "inProgress") {
        call.status = "failed";
        call.completedAtMs = now;
        items.push(call);
      }
    }
    if (state.fenced) {
      this.log.warn(`[session ${sessionId}] turn ${turn.id} ended while fenced out; the new owner will repair the row`);
      state.leaseGuard.stop();
      if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      state.phase = "finished";
      state.resolveDone();
      return;
    }
    try {
      const r = await this.commit(state, {
        turn,
        items,
        events: [
          ...(result.error ? [{ type: "error" as const, sessionId, emittedAtMs: now, code: "provider_error", message: result.error, turnId: turn.id }] : []),
          { type: "turn/completed", sessionId, emittedAtMs: now, turn, stopReason },
          { type: "session/status/changed", sessionId, emittedAtMs: now, status: { type: "idle" } },
        ],
        sessionPatch: { status: { type: "idle" }, usage: state.session.usage },
      });
      turn.seqEnd = r.lastSeq;
    } catch (err) {
      this.log.error(`[session ${sessionId}] could not persist turn end (${err instanceof Error ? err.message : err}); the next owner will repair`);
    } finally {
      state.leaseGuard.stop();
      if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      state.phase = "finished";
      state.resolveDone();
      this.scheduleRelease(sessionId);
    }
  }

  /**
   * The previous owner died mid-turn: mark its turn interrupted so the store never shows two active
   * turns. Writes nothing when the turn already finished — a spurious `idle` event would close the
   * SSE stream of the turn we are about to start.
   */
  private async closeOrphanedTurn(session: Session, fence: number, leaseGuard?: LeaseGuard) {
    if (session.status.type !== "active") return;
    const t = await this.deps.store.getTurn(session.id, session.status.turnId);
    leaseGuard?.assertOwned();
    if (!t || t.status !== "inProgress") {
      // Stale projection only: repair the row quietly, without an event.
      if (session.status.type === "active") {
        leaseGuard?.assertOwned();
        await this.deps.store.commit({ sessionId: session.id, fence, sessionPatch: { status: { type: "idle" } } });
        session.status = { type: "idle" };
      }
      return;
    }
    const now = Date.now();
    const turn: Turn = { ...t, status: "interrupted", stopReason: "interrupted", completedAtMs: now, error: { code: "owner_lost", message: "previous runner lost its lease during this turn" } };
    const pend = (await this.deps.store.listApprovals(session.id, { pendingOnly: true })).filter((a) => a.turnId === t.id);
    leaseGuard?.assertOwned();
    const r = await this.deps.store.commit({
      sessionId: session.id,
      fence,
      turn,
      approvals: pend.map((a) => ({ ...a, status: "expired" as const, resolvedAtMs: now, decidedBy: "system:owner_lost" })),
      events: [
        { type: "turn/completed", sessionId: session.id, emittedAtMs: now, turn, stopReason: "interrupted" },
        { type: "session/status/changed", sessionId: session.id, emittedAtMs: now, status: { type: "idle" } },
      ],
      sessionPatch: { status: { type: "idle" } },
    });
    await this.publishAll(session.id, r.events);
    session.status = { type: "idle" };
    session.lastSeq = r.lastSeq;
  }

  private scheduleRelease(sessionId: string) {
    this.clearHold(sessionId);
    this.holdTimers.set(
      sessionId,
      setTimeout(() => {
        this.holdTimers.delete(sessionId);
        void this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
      }, this.cfg.leaseHoldMs),
    );
  }
  private clearHold(sessionId: string) {
    const t = this.holdTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.holdTimers.delete(sessionId);
    }
  }

  // ---------------- commit + publish ----------------

  private commit(state: ActiveTurn, batch: Omit<CommitBatch, "sessionId" | "fence">) {
    const run = async () => {
      if (state.fenced) throw new FenceError(state.session.id, state.fence, state.fence);
      state.leaseGuard.assertOwned();
      try {
        const r = await this.deps.store.commit({ ...batch, sessionId: state.session.id, fence: state.fence });
        state.session.lastSeq = r.lastSeq;
        await this.publishAll(state.session.id, r.events);
        return r;
      } catch (err) {
        // These are a normal control-flow result of the atomic turn-start receipt check, not a
        // storage failure and not evidence that this writer lost ownership.
        if (
          !(err instanceof IdempotencyReplayError)
          && !(err instanceof IdempotencyMismatchError)
          && !(err instanceof IdempotencyPendingError)
        ) {
          this.onCommitError(state, err);
        }
        throw err;
      }
    };
    const p = state.chain.then(run, run);
    state.chain = p.catch(() => {});
    return p;
  }

  /**
   * A rejected commit means we are no longer the owner (or the store is broken). Either way this turn
   * must stop: a stale owner that keeps stepping would execute tools twice and bill twice.
   */
  private onCommitError(state: ActiveTurn, err: unknown) {
    const wasReserved = state.phase === "reserved";
    if (err instanceof SessionGoneError) {
      this.log.warn(`[session ${state.session.id}] session was deleted mid-turn; stopping turn ${state.turn.id}`);
      state.fenced = true; // same handling: stop writing, stop stepping
      state.closingRequested = true;
      state.phase = "finishing";
      state.stopReason = "error";
      state.abort.abort();
      this.failPendingApprovals(state, "cancel");
      if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
      return;
    }
    if (err instanceof FenceError) {
      if (!state.fenced) this.log.error(`[session ${state.session.id}] fenced out (${err.message}); aborting turn ${state.turn.id}`);
    } else {
      this.log.error(`[session ${state.session.id}] commit failed`, err);
    }
    // An unknown commit outcome is not safe to continue past: executing another model/tool step can
    // double bill or duplicate side effects. Leave the durable in-progress turn for the next owner to
    // reconcile instead of trying to finish it from possibly dirty in-memory state.
    state.fenced = true;
    state.closingRequested = true;
    state.phase = "finishing";
    state.stopReason = "error";
    state.abort.abort();
    this.failPendingApprovals(state, "cancel");
    if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
  }

  /** Resolve every waiting approval now. Used on abort, fence loss and drain. */
  private failPendingApprovals(state: ActiveTurn, decision: ApprovalDecision) {
    for (const [id, p] of state.pendingApprovals) {
      clearTimeout(p.timer);
      state.pendingApprovals.delete(id);
      p.resolve(decision);
    }
  }

  private async publishAll(sessionId: string, events: PersistedEvent[]) {
    for (const e of events) await this.deps.bus.publish(sessionId, e).catch((err) => this.log.warn(`[session ${sessionId}] publish failed`, err));
  }

  // ---------------- lifecycle ----------------

  /** Stop accepting turns; wait for in-flight turns (up to `timeoutMs`), then abort the rest. */
  async drain(timeoutMs = 30_000) {
    this.draining = true;
    // A reserved turn has no engine whose `done` promise could ever drive cleanup. Stop it before
    // entering the grace period; running turns still receive the full graceful-drain window.
    for (const [, state] of this.active) {
      if (state.phase !== "reserved") continue;
      state.stopReason = "interrupted";
      state.closingRequested = true;
      void (async () => {
        await this.settleAdmittedSteers(state);
        if (state.phase === "finished") return;
        state.phase = "finishing";
        state.abort.abort();
        await this.finishTurn(state, { steps: 0, aborted: true });
      })().catch((err) => this.log.error(`[session ${state.session.id}] pre-run drain cleanup failed`, err));
    }
    const deadline = Date.now() + timeoutMs;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    for (const [, s] of this.active) {
      s.stopReason = "interrupted";
      void (async () => {
        await this.settleAdmittedSteers(s);
        if (s.phase === "finished") return;
        s.phase = "finishing";
        this.failPendingApprovals(s, "cancel");
        s.abort.abort();
      })().catch((err) => this.log.error(`[session ${s.session.id}] drain abort failed`, err));
    }
    await Promise.race([
      Promise.all([...this.active.values()].map((s) => s.done)),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
    for (const [sid, t] of this.holdTimers) {
      clearTimeout(t);
      await this.deps.lease.release(sid, this.deps.config.runnerId).catch(() => {});
    }
    this.holdTimers.clear();
  }
}

const noop = () => {};

/**
 * Upper bound on how many items one turn will project. Reached only when compaction has not kept up;
 * the newest items are the ones that matter, so the store is asked for those.
 */
const MAX_PROJECTED_ITEMS = 5_000;

/** Project from the newest compaction item onward (inclusive), or from the beginning. */
function projectFromSeq(session: Session): number {
  return session.lastCompactionSeq === undefined ? -1 : session.lastCompactionSeq - 1;
}
