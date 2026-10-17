import {
  ApiError,
  ImageMediaType,
  addUsage,
  emptyUsage,
  emptyUsageAccumulator,
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
  type McpRegistrationRef,
  type PersistedEvent,
  type Principal,
  type Session,
  type StartTurnRequest,
  type StopReason,
  type Turn,
  type Usage,
  ToolOutputPayload,
  ResolvedSkillContext,
} from "@agent-service/protocol";
import type {
  BlobBinding,
  BlobManifestStore,
  BlobObject,
  CommitBatch,
  CommitResult,
  ErasureSessionHead,
  ErasureSessionStore,
  ErasureWriteAuthorization,
  EventBus,
  EventListener,
  IdempotencyReceiptInput,
  LeaseStore,
  SessionLifecycleTransition,
  SessionStore,
} from "@agent-service/store";
import {
  BlobStateError,
  TOOL_OUTPUT_CONTENT_TYPE,
  FenceError,
  IdempotencyMismatchError,
  IdempotencyPendingError,
  IdempotencyReplayError,
  SessionArchivedError,
  SessionGoneError,
  SessionHasChildrenError,
  SessionLifecycleBusyError,
  SubjectDeletingError,
  newUsageId,
} from "@agent-service/store";
import type { AgentEngine, AssistantStepResult, BeforeToolCallDecision, EngineInputPart, EngineRun, EngineSink, EngineToolResult, ResolvedModel, Summariser } from "../engine/types.js";
import { getPiProviderStepFailure, getPiProviderStepFailureMessage } from "../engine/pi.js";
import { buildSystemPrompt, computeContextEpoch, estimateTokens, renderSkillContext, sha256, stableStringify, type SkillSummary } from "../context/assemble.js";
import { collectResolvedSkillContexts, projectItems, projectItemsForPlanning, pruneToolResults } from "../context/history.js";
import { COMPACTION_SYSTEM_PROMPT, planCompaction, renderForSummary, transcriptTokens } from "../context/compact.js";
import { newId } from "../ids.js";
import type { RunnerTool, ToolRegistry } from "../tools/types.js";
import type { McpToolSource } from "../mcp/service.js";
import type { LoadedStaticSkill, SkillResolution, StaticSkillLoadInput } from "../skills/static.js";
import type { ToolHookContext, ToolHookReport, ToolHookService } from "../hooks/types.js";
import { DynamicToolBridge } from "../tools/dynamic.js";
import type { TenantRuntimeCoordinator, TenantRuntimeLease } from "../lifecycle/tenant-runtime-coordinator.js";
import {
  BlobDataError,
  SessionBlobService,
  matchesImageSignature,
  type BlobHydrationBudget,
  type UploadedSessionBlob,
} from "../blob/service.js";

/** Public turn/event wording is fixed; provider and transport errors are untrusted data. */
const PUBLIC_PROVIDER_ERROR_MESSAGE = "Provider request failed.";

export interface ProviderResolver {
  resolve(principal: Principal, ref: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }): Promise<ResolvedModel>;
}

export interface SkillSource {
  readonly enabled?: boolean;
  validateMounts?(principal: Principal, ids: readonly string[]): void | Promise<void>;
  list(principal: Principal, names: string[], signal: AbortSignal, resolution?: SkillResolution): Promise<readonly SkillSummary[]>;
  /** List-only legacy providers remain metadata-only; missing load never enables execution. */
  load?(principal: Principal, ids: readonly string[], input: StaticSkillLoadInput, signal: AbortSignal, resolution?: SkillResolution): Promise<LoadedStaticSkill>;
}

/** Managed refs are not legacy operator ids. Resolution always uses the actual session owner. */
export interface RegisteredMcpSource {
  readonly enabled: boolean;
  validateMounts(principal: Principal, refs: readonly McpRegistrationRef[]): Promise<void>;
  resolve(principal: Principal, refs: readonly McpRegistrationRef[], signal: AbortSignal): Promise<RunnerTool[]>;
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
  /** Writer rollout gate. Readers remain enabled so mixed-version fleets can drain safely. */
  blobAttachmentsEnabled?: boolean;
  /** Offload serialized tool output at or above this size. Zero disables tool-output offload. */
  toolOutputBlobThresholdBytes?: number;
  /**
   * Hard ceiling for the JSON-safe tool result persisted inline or in Blob storage. This remains
   * active when Blob writes are gated off, offload is disabled, or no Blob service is installed.
   */
  maxDurableToolOutputBytes?: number;
  /** Bounded wait for a local provider/tool execution to acknowledge a subject-erasure abort. */
  erasureDrainTimeoutMs?: number;
}

export interface SessionHostDeps {
  store: SessionStore & Partial<BlobManifestStore>;
  /** Separate gate-aware capability; defaults to store only when that adapter implements it. */
  erasureStore?: ErasureSessionStore;
  /** Optional data-plane adapter. Required before image writes or tool-output offload can be enabled. */
  blobs?: SessionBlobService;
  /** optional: without one, long sessions fall back to cheap pruning only */
  summariser?: Summariser;
  lease: LeaseStore;
  bus: EventBus;
  engine: AgentEngine;
  tools: ToolRegistry;
  /** Principal-scoped, bounded remote discovery; never part of the global builtin registry. */
  mcp?: McpToolSource;
  registeredMcp?: RegisteredMcpSource;
  providers: ProviderResolver;
  skills?: SkillSource;
  hooks?: ToolHookService;
  /** Shared runner-local T3b fence. Omitted while the T3b worker is disabled. */
  tenantRuntime?: TenantRuntimeCoordinator;
  config: SessionHostConfig;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** Content-free ownership-loss signal for structured process telemetry. */
  onOwnershipLost?: () => void;
  /** Present only after exact v2 startup reconciliation. Generic engine error text is not proof. */
  persistedProviderFailureCapture?: {
    commit(batch: CommitBatch, source: {
      tenantId: string; userId: string; turnId: string; itemId: string;
      stepIndex: number; failureKind: "provider_step_error";
    }): Promise<CommitResult>;
  };
}

/**
 * Internal control-plane signal: an earlier erasure call already fenced this runner's local turn,
 * but the provider/tool has not stopped yet. Retrying on this runner must not re-acquire the same
 * lease owner and refresh its TTL; the router waits for expiry before selecting another runner.
 */
export class ErasureLocalTurnFencedError extends ApiError {
  override readonly name = "ErasureLocalTurnFencedError";

  constructor() {
    super("session_busy", "local execution is already fenced and still draining");
  }
}

interface SkillBudget {
  remainingTokens: number;
  /** Exact durable history plus conservative in-flight reservations, shared by every producer. */
  contexts: Map<string, ResolvedSkillContext>;
}

type PreparedToolOutput = { ok: true; payload: ToolOutputPayload; serialized: string } | { ok: false };

interface ActiveTurn {
  turn: Turn;
  session: Session;
  agent: AgentDefinition;
  /** The active engine's actual resolved modalities; steer must obey the same model contract. */
  modelInput: ResolvedModel["input"];
  /** One cumulative Blob byte budget for initial input, retained history and every admitted steer. */
  hydrationBudget?: BlobHydrationBudget;
  fence: number;
  abort: AbortController;
  run?: EngineRun;
  limits: ReturnType<typeof mergeLimits>;
  /** set when a commit was rejected by the store's fence check: this runner no longer owns the session */
  fenced?: boolean;
  /** Best-effort process telemetry must be emitted at most once for one local turn. */
  ownershipLossReported?: boolean;
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
  /** In-memory resumption only; a crash must leave the durable MCP grant suspended. */
  mcpGrantResumptions: Map<string, string>;
  skills: readonly SkillSummary[];
  /** Accepted once at turn start; steer cannot replace the immutable selection. */
  skillResolution?: SkillResolution;
  toolNames: readonly string[];
  skillBudget: SkillBudget;
  hooksSha256?: string;
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
  pendingSteers: EngineInputPart[][];
  /** makes timeout/drain/lease-loss cleanup safe when more than one stop signal races */
  finishPromise?: Promise<void>;
  /** A done-only signal can replay the original step entry, never the terminal finish batch. */
  capturedProviderFailureStep?: number;
  preparedProviderFailureStep?: {
    stepIndex: number;
    commit: Promise<CommitResult>;
  };
  /** Set only when a subject-erasure abort exceeded its configured local drain deadline. */
  erasureDrainTimedOut?: boolean;
  /** Covers queueing, preflight and engine execution until this turn has fully settled locally. */
  tenantRuntimeLease?: TenantRuntimeLease;
  tenantRuntimeAbortListener?: () => void;
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

function isSkillSelector(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) || /^registry:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 73;
}
function turnSkillResolution(req: StartTurnRequest): SkillResolution | undefined {
  if (req.skillOverrides === undefined) return undefined;
  const values = req.skillOverrides;
  if (!Array.isArray(values) || values.length > 8 || new Set(values.map(v => v.name)).size !== values.length) {
    throw new ApiError("invalid_request", "Skill request failed.");
  }
  const overrides = values.map(value => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2
      || !Object.hasOwn(value, "name") || !Object.hasOwn(value, "versionId")
      || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !("value" in d) || !d.enumerable)
      || typeof value.name !== "string" || value.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)
      || typeof value.versionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.versionId)) {
      throw new ApiError("invalid_request", "Skill request failed.");
    }
    return Object.freeze({ name: value.name, versionId: value.versionId });
  });
  return Object.freeze({ overrides: Object.freeze(overrides) });
}

/** Validate once for both a new turn and busyPolicy/public steer paths. */
type ExecutableInputPart = InputPart & { type: "text" | "image" | "skill" };
function executableInput(parts: InputPart[], imagesEnabled: boolean, skillsConfigured: boolean): ExecutableInputPart[] {
  if (parts.some(part => part.type === "mention")) throw new ApiError("invalid_request", "mention input is not supported");
  const skills = parts.filter(part => part.type === "skill");
  if (skills.length && !skillsConfigured) throw new ApiError("invalid_request", "Skills are not configured.");
  if (skills.length > 8 || new Set(skills.map(skill => skill.name)).size !== skills.length
    || skills.some(skill => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64
      || skill.args !== undefined && Buffer.byteLength(skill.args) > 8_192)) {
    throw new ApiError("invalid_request", "Skill request failed.");
  }
  if (!imagesEnabled && parts.some((part) => part.type === "image")) {
    throw new ApiError("invalid_request", "image input is not enabled on this runner");
  }
  const input = parts.filter((part): part is ExecutableInputPart => part.type === "text" || part.type === "image" || part.type === "skill");
  const imageIds = new Set<string>();
  for (const part of input) {
    if (part.type !== "image") continue;
    if (imageIds.has(part.blobId)) {
      throw new ApiError("invalid_request", "the same image blob cannot be referenced more than once in one input");
    }
    imageIds.add(part.blobId);
  }
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
  private readonly maxDurableToolOutputBytes: number;

  constructor(private readonly deps: SessionHostDeps) {
    this.log = deps.logger ?? console;
    const threshold = deps.config.toolOutputBlobThresholdBytes ?? 0;
    if (!Number.isSafeInteger(threshold) || threshold < 0) {
      throw new Error("toolOutputBlobThresholdBytes must be a non-negative safe integer");
    }
    const configuredMax = deps.config.maxDurableToolOutputBytes ?? deps.blobs?.maxBlobBytes ?? 1_000_000;
    if (!Number.isSafeInteger(configuredMax) || configuredMax < 1) {
      throw new Error("maxDurableToolOutputBytes must be a positive safe integer");
    }
    // A physical adapter may impose a stricter ceiling than the host's general durable limit. Keep
    // one effective bound so an offloaded result cannot pass host validation and then fail mid-write.
    this.maxDurableToolOutputBytes = Math.min(configuredMax, deps.blobs?.maxBlobBytes ?? configuredMax);
    if (threshold > this.maxDurableToolOutputBytes) {
      throw new Error("toolOutputBlobThresholdBytes must not exceed maxDurableToolOutputBytes");
    }
    if (
      deps.config.erasureDrainTimeoutMs !== undefined
      && (!Number.isSafeInteger(deps.config.erasureDrainTimeoutMs) || deps.config.erasureDrainTimeoutMs <= 0)
    ) throw new Error("erasureDrainTimeoutMs must be a positive safe integer");
  }

  private reportOwnershipLost(state: ActiveTurn): void {
    if (state.ownershipLossReported) return;
    state.ownershipLossReported = true;
    try {
      this.deps.onOwnershipLost?.();
    } catch {
      // Observability is best-effort and must never interrupt the fence/abort safety path.
    }
  }

  private logTurnStop(level: "warn" | "error", ...args: unknown[]): void {
    try {
      this.log[level](...args);
    } catch {
      // Observability must not escape after a safety stop transition.
    }
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
      blobAttachmentsEnabled: c.blobAttachmentsEnabled ?? false,
      toolOutputBlobThresholdBytes: c.toolOutputBlobThresholdBytes ?? 0,
    };
  }

  // ---------------- sessions ----------------

  async createSession(principal: Principal, req: CreateSessionRequest): Promise<Session> {
    const agent = await this.deps.store.getAgent(principal.tenantId, req.agentId, req.agentVersion);
    if (!agent) throw new ApiError("not_found", "agent not found");
    const targetUserId = req.userId ?? principal.userId;
    if (req.parentSessionId) {
      const parent = await this.deps.store.getSession(principal.tenantId, req.parentSessionId);
      // A trusted caller may create for another user, so compare the parent with the target user,
      // not necessarily the authenticated caller. Cross-tenant/user and missing parents stay
      // indistinguishable to avoid turning this relationship check into an existence oracle.
      if (!parent || parent.userId !== targetUserId) throw new ApiError("not_found", "parent session not found");
    }
    // Delegated creation must resolve extensions as the actual session owner, not the trusted
    // caller. Otherwise a caller's catalog could be pinned into another user's session.
    const owner = { tenantId: principal.tenantId, userId: targetUserId };
    const signal = AbortSignal.timeout(30_000);
    const tools = await this.resolveTools(owner, agent, signal);
    const skills = await this.listSkills(owner, agent, signal);
    this.mountSkillTool(owner, agent, skills, tools, { remainingTokens: 0, contexts: new Map() });
    const systemPrompt = buildSystemPrompt(agent, skills, !!this.deps.skills?.load);
    const hooksSha256 = this.toolHooksVersion(owner);
    const now = Date.now();
    const session: Session = {
      id: newId("sess"),
      tenantId: principal.tenantId,
      userId: targetUserId,
      agentId: agent.id,
      agentVersion: agent.version,
      status: { type: "idle" },
      title: req.title,
      parentSessionId: req.parentSessionId,
      lastSeq: 0,
      contextEpoch: computeContextEpoch({ agentId: agent.id, agentVersion: agent.version, systemPrompt, tools, skills, hooksSha256 }),
      fenceToken: 0,
      usage: emptyUsageAccumulator(),
      autoApprovedTools: [],
      lastCompactionSeq: undefined,
      createdAtMs: now,
      updatedAtMs: now,
      metadata: req.metadata ?? {},
    };
    let r;
    try {
      r = await this.deps.store.createSession(session);
    } catch (err) {
      // The optimistic parent read above is for a useful early error. The store rechecks/locks the
      // parent in the creation transaction so a concurrent parent DELETE cannot leave a dangling
      // child; translate that authoritative race result without creating an existence oracle.
      if (err instanceof SessionGoneError && req.parentSessionId) {
        throw new ApiError("not_found", "parent session not found");
      }
      if (err instanceof SubjectDeletingError) {
        throw new ApiError("subject_deleting", "cannot create a session while this user is being erased");
      }
      throw err;
    }
    await this.publishAll(session.id, r.events);
    return { ...session, lastSeq: r.lastSeq };
  }

  private async resolveTools(principal: Principal, agent: AgentDefinition, signal: AbortSignal): Promise<RunnerTool[]> {
    const builtin = this.deps.tools.resolve(agent.tools);
    const refs = agent.mcpRegistrations ?? [];
    if (!agent.mcpServers.length && !refs.length) return builtin;
    if (agent.mcpServers.length + refs.length > 8) throw new ApiError("invalid_request", "Too many MCP mounts");
    const remote: RunnerTool[] = [];
    if (agent.mcpServers.length) {
      if (!this.deps.mcp?.enabled) throw new ApiError("invalid_request", "MCP is not configured");
      this.deps.mcp.validateMounts(principal, agent.mcpServers);
      remote.push(...await this.deps.mcp.resolve(principal, agent.mcpServers, signal));
    }
    if (refs.length) {
      if (!this.deps.registeredMcp?.enabled) throw new ApiError("invalid_request", "Managed MCP is not configured");
      await this.deps.registeredMcp.validateMounts(principal, refs);
      remote.push(...await this.deps.registeredMcp.resolve(principal, refs, signal));
    }
    const tools = [...builtin, ...remote];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new ApiError("invalid_request", "tool names collide");
    }
    return tools;
  }

  private toolHooksVersion(owner: Principal): string | undefined {
    if (!this.deps.hooks?.enabled) return undefined;
    const version = this.deps.hooks.version({ tenantId: owner.tenantId, userId: owner.userId });
    if (version !== undefined && !/^[a-f0-9]{64}$/.test(version)) throw new ApiError("invalid_request", "Tool hooks are unavailable.");
    return version;
  }

  private toolHookContext(state: ActiveTurn, tool: RunnerTool, toolCallId: string): ToolHookContext {
    return { owner: { tenantId: state.session.tenantId, userId: state.session.userId },
      sessionId: state.session.id, turnId: state.turn.id, toolCallId,
      tool: { name: tool.name, kind: tool.kind, readOnly: tool.readOnly === true } };
  }

  private assertToolHooksOpen(state: ActiveTurn): void {
    state.leaseGuard.assertOwned(); state.tenantRuntimeLease?.assertOpen();
    if (state.fenced || state.abort.signal.aborted || state.closingRequested || isTurnClosing(state)) {
      throw new ApiError("draining", "Tool hooks are unavailable.");
    }
  }

  private toolHookSignal(state: ActiveTurn): AbortSignal {
    return AbortSignal.any([state.abort.signal, ...(state.tenantRuntimeLease ? [state.tenantRuntimeLease.signal] : [])]);
  }

  private async commitToolHookReports(state: ActiveTurn, toolCallId: string, reports: readonly ToolHookReport[]): Promise<void> {
    this.assertToolHooksOpen(state);
    if (!reports.length) return;
    await this.commit(state, { events: reports.map(report => ({ type: "hook/completed" as const,
      sessionId: state.session.id, turnId: state.turn.id, toolCallId, emittedAtMs: Date.now(),
      hookId: report.hookId, phase: report.phase, kind: report.kind, outcome: report.outcome, configSha256: report.configSha256 })) }, undefined, true);
    this.assertToolHooksOpen(state);
  }

  private async listSkills(owner: Principal, agent: AgentDefinition, signal: AbortSignal, resolution?: SkillResolution): Promise<readonly SkillSummary[]> {
    if (!agent.skills.length) {
      if (resolution?.overrides.length) throw new ApiError("invalid_request", "Skill request failed.");
      return [];
    }
    if (agent.skills.length > 8 || new Set(agent.skills).size !== agent.skills.length
      || agent.skills.some(id => !isSkillSelector(id))) throw new ApiError("invalid_request", "Skill request failed.");
    if (resolution?.overrides.some(override => !agent.skills.includes(`registry:${override.name}`))) {
      throw new ApiError("invalid_request", "Skill request failed.");
    }
    const source = this.deps.skills;
    if (!source || source.enabled === false) throw new ApiError("invalid_request", "Skills are not configured.");
    await source.validateMounts?.(owner, agent.skills);
    return source.list(owner, agent.skills, signal, resolution);
  }

  private hasExecutableSkills(agent: AgentDefinition): boolean {
    return !!this.deps.skills?.load && this.deps.skills.enabled !== false && agent.skills.length > 0
      && agent.skills.length <= 8 && new Set(agent.skills).size === agent.skills.length
      && agent.skills.every(isSkillSelector);
  }

  private assertSkillDependencies(skills: readonly SkillSummary[], tools: readonly string[]): void {
    const available = new Set(tools);
    if (skills.some(skill => skill.dependencies?.tools.some(tool => !available.has(tool)))) {
      throw new ApiError("invalid_request", "Skill dependencies are unavailable.");
    }
  }

  private snapshotSkill(loaded: LoadedStaticSkill, expected: SkillSummary): ResolvedSkillContext {
    if (loaded.id !== expected.id || loaded.name !== expected.name || loaded.contentSha256 !== expected.contentSha256
      || loaded.versionSha256 !== expected.versionSha256) throw new ApiError("invalid_request", "Skill request failed.");
    const parsed = ResolvedSkillContext.safeParse({ id: loaded.id, name: loaded.name,
      contentSha256: loaded.contentSha256, versionSha256: loaded.versionSha256, body: loaded.body });
    if (!parsed.success) throw new ApiError("invalid_request", "Skill request failed.");
    return parsed.data;
  }

  /** No await: model results and admitted steer share one prospective union before either commit. */
  private reserveSkillContexts(budget: SkillBudget, contexts: readonly ResolvedSkillContext[]): void {
    const prospective = new Map(budget.contexts);
    for (const context of contexts) {
      const key = `${context.id}:${context.versionSha256}`, previous = prospective.get(key);
      if (previous && stableStringify(previous) !== stableStringify(context)) throw new ApiError("invalid_request", "Skill request failed.");
      prospective.set(key, context);
    }
    if (prospective.size > 8 || Buffer.byteLength(stableStringify([...prospective.values()])) > 65_536) {
      throw new ApiError("invalid_request", "Skill context budget exceeded.");
    }
    // Failed later writes may retain a conservative reservation until turn end. Only committed
    // item metadata is projected or used to initialise the next turn; this map is never history.
    budget.contexts = prospective;
  }

  private mountSkillTool(owner: Principal, agent: AgentDefinition, skills: readonly SkillSummary[], tools: RunnerTool[],
    budget: SkillBudget, resolution?: SkillResolution): void {
    if (!this.deps.skills?.load || !skills.some(skill => skill.disableModelInvocation !== true)) return;
    const source = this.deps.skills;
    tools.push({ name: "skill", description: "Load a mounted static skill's instructions. This grants no additional tools or permissions.",
      kind: "skill", readOnly: true, concurrencySafe: false,
      parameters: { type: "object", properties: { name: { type: "string", enum: skills.filter(skill => !skill.disableModelInvocation).map(skill => skill.name) } }, required: ["name"], additionalProperties: false },
      execute: async (args, context) => {
        try {
          if (!this.hasExecutableSkills(agent) || context.principal.tenantId !== owner.tenantId || context.principal.userId !== owner.userId
            || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1
            || !Object.hasOwn(args, "name")) throw new Error("Skill request failed.");
          const name = (args as { name?: unknown }).name;
          const summary = skills.find(skill => skill.name === name && skill.disableModelInvocation !== true);
          if (!summary?.versionSha256) throw new Error("Skill request failed.");
          const loaded = await source.load!(owner, agent.skills, { name: summary.name, invocation: "model",
            availableTools: tools.map(tool => tool.name), expectedVersionSha256: summary.versionSha256 }, context.signal, resolution);
          const skillContext = this.snapshotSkill(loaded, summary), text = renderSkillContext(skillContext);
          const tokens = estimateTokens(text);
          if (tokens > budget.remainingTokens) throw new Error("Skill context budget exceeded.");
          this.reserveSkillContexts(budget, [skillContext]);
          budget.remainingTokens -= tokens;
          return { content: [{ type: "text", text }], details: { skillContext } };
        } catch { return { content: [{ type: "text", text: "Skill request failed." }], isError: true }; }
      },
    });
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new ApiError("invalid_request", "tool names collide");
  }

  private async resolveSkillInput(owner: Principal, agent: AgentDefinition, catalog: readonly SkillSummary[],
    tools: readonly string[], parts: ExecutableInputPart[], signal: AbortSignal, budget: SkillBudget, resolution?: SkillResolution): Promise<{
      input: (InputPart & { type: "text" | "image" })[]; skillContexts: ResolvedSkillContext[];
    }> {
    const input: (InputPart & { type: "text" | "image" })[] = [], skillContexts: ResolvedSkillContext[] = [];
    for (const part of parts) {
      if (part.type !== "skill") { input.push(part); continue; }
      if (!this.hasExecutableSkills(agent)) throw new ApiError("invalid_request", "Skills are not configured.");
      const summary = catalog.find(skill => skill.name === part.name);
      if (!this.deps.skills?.load || !summary?.versionSha256 || summary.userInvocable !== true) {
        throw new ApiError("not_found", "Skill not found.");
      }
      const loaded = await this.deps.skills.load(owner, agent.skills, { name: part.name, invocation: "user",
        availableTools: tools, expectedVersionSha256: summary.versionSha256 }, signal, resolution);
      const context = this.snapshotSkill(loaded, summary);
      this.reserveSkillContexts(budget, [context]);
      skillContexts.push(context); input.push({ type: "text", text: renderSkillContext(context, part.args) });
    }
    if (Buffer.byteLength(stableStringify(skillContexts)) > 65_536) throw new ApiError("invalid_request", "Skill context budget exceeded.");
    return { input, skillContexts };
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

  /** Stage an image under the same session fence later used to bind it into a user-message item. */
  async uploadInputBlob(
    principal: Principal,
    sessionId: string,
    data: Buffer,
    contentType: string,
  ): Promise<UploadedSessionBlob> {
    return this.serialiseSessionStart(sessionId, async () => {
      const blobs = this.writerBlobService();
      if (!ImageMediaType.safeParse(contentType).success) {
        throw new ApiError("invalid_request", "blob uploads must use a supported image content type");
      }
      if (!matchesImageSignature(data, contentType)) {
        throw new ApiError("invalid_request", "image bytes do not match the declared Content-Type");
      }
      const session = await this.getSession(principal, sessionId);
      this.assertNotArchived(session, "upload an attachment to");

      // Uploads used by steer are allowed on the owning runner while a turn is active. They do not
      // enter the turn's commit chain, but both paths carry the same durable fence and the manifest
      // transition is independently transactional.
      const active = this.active.get(sessionId);
      if (active) {
        try {
          active.leaseGuard.assertOwned();
          return await active.leaseGuard.wait(blobs.stageAndUpload({
            owner: principal,
            sessionId,
            fence: active.fence,
            purpose: "input_image",
            data,
            contentType,
          }));
        } catch (error) {
          throw await this.translateSessionLeaseFailure(sessionId, active.leaseGuard.lost ?? error);
        }
      }

      this.clearHold(sessionId);
      const lease = await this.deps.lease.acquire(
        sessionId,
        this.deps.config.runnerId,
        this.deps.config.runnerAddr,
        this.cfg.leaseTtlMs,
      );
      if (!lease.ok) {
        throw new ApiError("session_lease_conflict", "session owned by another runner", {
          ownerId: lease.ownerId,
          ownerAddr: lease.ownerAddr,
        });
      }
      const guard = this.startLeaseGuard(sessionId);
      try {
        await this.claimSessionFence(session, lease.fence, guard);
        const fresh = await guard.wait(this.getSession(principal, sessionId));
        this.assertNotArchived(fresh, "upload an attachment to");
        if (fresh.status.type === "active") {
          // The previous owner disappeared after persisting turn/start. Repair that durable state
          // before this new fence is used for unrelated writes, exactly as normal turn takeover does.
          await guard.wait(this.closeOrphanedTurn(fresh, lease.fence, guard));
        }
        guard.assertOwned();
        return await guard.wait(blobs.stageAndUpload({
          owner: principal,
          sessionId,
          fence: lease.fence,
          purpose: "input_image",
          data,
          contentType,
        }));
      } catch (error) {
        throw await this.translateSessionLeaseFailure(sessionId, guard.lost ?? error);
      } finally {
        guard.stop();
        await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
      }
    });
  }

  /** Owner-scoped reads never expose the manifest's physical storage key. */
  async readInputBlob(principal: Principal, sessionId: string, blobId: string): Promise<BlobObject | null> {
    await this.getSession(principal, sessionId);
    if (!this.deps.blobs) return null;
    return this.deps.blobs.readReadyInputBlob(principal, sessionId, blobId);
  }

  async readItemOutput(
    principal: Principal,
    sessionId: string,
    itemId: string,
  ): Promise<ToolOutputPayload | null> {
    await this.getSession(principal, sessionId);
    const item = await this.deps.store.getItem(sessionId, itemId);
    if (!item || item.type !== "toolResult" || !item.outputRef || !this.deps.blobs) return null;
    return this.deps.blobs.readReadyToolOutput(principal, sessionId, itemId, item.outputRef);
  }

  private writerBlobService(): SessionBlobService {
    if (!this.cfg.blobAttachmentsEnabled || !this.deps.blobs) {
      throw new ApiError("invalid_request", "blob attachments are not enabled on this runner");
    }
    return this.deps.blobs;
  }

  private imagesEnabled(): boolean {
    return this.cfg.blobAttachmentsEnabled && this.deps.blobs !== undefined;
  }

  private async materializeSubmittedInput(
    principal: Principal,
    sessionId: string,
    input: (InputPart & { type: "text" | "image" })[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<EngineInputPart[]> {
    if (!input.some((part) => part.type === "image")) return input as EngineInputPart[];
    const blobs = this.writerBlobService();
    try {
      return await blobs.materializeBindableInput(principal, sessionId, input, hydrationBudget);
    } catch (error) {
      if (error instanceof BlobDataError) {
        // Keep missing, cross-owner and corrupt references indistinguishable at this write boundary.
        throw new ApiError("invalid_request", "one or more image blobs are unavailable");
      }
      throw error;
    }
  }

  private async hydratePersistedItems(
    principal: Principal,
    sessionId: string,
    items: Item[],
    hydrationBudget?: BlobHydrationBudget,
  ): Promise<Item[]> {
    const carriesBlob = items.some((item) => (
      (item.type === "toolResult" && item.outputRef !== undefined)
      || (item.type === "userMessage" && item.content.some((part) => part.type === "image"))
    ));
    if (!carriesBlob) return items;
    if (!this.deps.blobs) throw new BlobDataError("this runner cannot hydrate blob-backed history");
    return this.deps.blobs.materializeReadyHistory(principal, sessionId, items, hydrationBudget);
  }

  /** Hydrate only typed skill result identities before reserving new snapshots or compacting. */
  private async hydrateSkillSnapshotItems(principal: Principal, sessionId: string, items: Item[], leaseGuard?: LeaseGuard): Promise<Item[]> {
    const calls = new Set(items.flatMap(item => item.type === "toolCall" && item.kind === "skill"
      ? [`${item.turnId}:${item.toolCallId}`] : []));
    const outputs = items.filter(item => item.type === "toolResult" && item.outputRef
      && calls.has(`${item.turnId}:${item.toolCallId}`));
    if (!outputs.length) return items;
    if (!this.deps.blobs) throw new ApiError("invalid_request", "Skill context budget exceeded.");
    const work = this.deps.blobs.materializeReadyHistoryForCompaction(principal, sessionId, outputs);
    const hydrated = leaseGuard ? await leaseGuard.wait(work) : await work;
    if (!hydrated) throw new ApiError("invalid_request", "Skill context budget exceeded.");
    const byId = new Map(hydrated.map(item => [item.id, item]));
    return items.map(item => byId.get(item.id) ?? item);
  }

  private inputBlobBindings(input: readonly InputPart[], itemId: string): BlobBinding[] {
    return input.flatMap((part) => (
      part.type === "image" ? [{ blobId: part.blobId, itemId, purpose: "input_image" as const }] : []
    ));
  }

  /** Tenant-scoped read for administrative listings, where no single user owns the result. */
  async getSessionAsTenant(tenantId: string, sessionId: string): Promise<Session> {
    const s = await this.deps.store.getSession(tenantId, sessionId);
    if (!s) throw new ApiError("not_found", "session not found");
    return s;
  }

  private assertNotArchived(session: Session, action: string): void {
    if (session.archivedAtMs !== undefined) {
      throw new ApiError("session_archived", `cannot ${action} an archived session`);
    }
  }

  /** Archive is a fenced lifecycle write and is serialised with turn starts on this runner. */
  async archiveSession(principal: Principal, sessionId: string): Promise<Session> {
    return this.serialiseSessionStart(sessionId, () => this.setArchiveStateLocked(principal, sessionId, true));
  }

  /** Unarchive uses the same lease/fence path so it cannot race another owner or a new turn. */
  async unarchiveSession(principal: Principal, sessionId: string): Promise<Session> {
    return this.serialiseSessionStart(sessionId, () => this.setArchiveStateLocked(principal, sessionId, false));
  }

  /**
   * DELETE is an irreversible-to-the-user, fenced lifecycle transition. It deliberately only records
   * a tombstone and an outbox intent: physical erasure remains disabled until retention, legal-hold
   * and billing policies have been explicitly configured.
   */
  async deleteSession(principal: Principal, sessionId: string): Promise<void> {
    return this.serialiseSessionStart(sessionId, () => this.deleteSessionLocked(principal, sessionId));
  }

  /**
   * Internal draining-phase operation. It proves the worker claim under the session fence and stops
   * only execution owned by this runner. Durable orphan repair and tombstoning belong to the later
   * tombstoning phase and are intentionally not performed here.
   */
  async drainSessionForErasure(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    return this.serialiseSessionStart(
      sessionId,
      () => this.drainSessionForErasureLocked(authority, sessionId),
    );
  }

  /**
   * Internal user-erasure path. Unlike public DELETE, this can see a gated subject, but every read
   * and commit is bound to the worker's live durable claim. It deliberately remains outside the
   * HTTP/public SessionStore surface.
   */
  async eraseSessionForErasure(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    return this.serialiseSessionStart(
      sessionId,
      () => this.eraseSessionForErasureLocked(authority, sessionId),
    );
  }

  private getErasureStore(): ErasureSessionStore {
    const candidate = this.deps.erasureStore ?? this.deps.store as SessionStore & Partial<ErasureSessionStore>;
    if (
      typeof candidate.getErasureSessionHead !== "function"
      || typeof candidate.applyErasureSessionAction !== "function"
    ) throw new Error("this runner has no erasure session store");
    return candidate as ErasureSessionStore;
  }

  private assertErasureHead(
    head: ErasureSessionHead,
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): void {
    if (
      head.sessionId !== sessionId
      || head.tenantId !== authority.tenantId
      || head.userId !== authority.userId
      || typeof head.deleted !== "boolean"
      || !Number.isSafeInteger(head.deletionGeneration)
      || head.deletionGeneration < 0
    ) throw new Error("erasure session head owner mismatch");
  }

  private async readErasureHead(
    store: ErasureSessionStore,
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<ErasureSessionHead | null> {
    const head = await store.getErasureSessionHead(authority, sessionId);
    if (head) this.assertErasureHead(head, authority, sessionId);
    return head;
  }

  /** Stop local execution without letting its ordinary, now-gated commit path write again. */
  private async drainLocalTurnForErasure(state: ActiveTurn): Promise<void> {
    const wasReserved = state.phase === "reserved";
    state.stopReason = "interrupted";
    state.closingRequested = true;
    // The gate is already durable. Marking this state fenced prevents a late provider/tool result
    // from attempting an ordinary commit; the fixed erasure action repairs durable state below.
    state.fenced = true;
    this.failPendingApprovals(state, "cancel");
    state.abort.abort();
    if (wasReserved) {
      void this.finishTurn(state, { steps: 0, aborted: true }).catch((error) => {
        const name = error instanceof Error ? error.name : "unknown error";
        this.log.error(`[session ${state.session.id}] erasure pre-run cleanup failed (${name})`);
      });
    }

    const timeoutMs = this.deps.config.erasureDrainTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      state.done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (stopped) return;

    // A provider which ignores AbortSignal must not keep renewing forever. Do not release the lease:
    // expiry plus the next fence is what prevents this still-running process from becoming a writer.
    state.erasureDrainTimedOut = true;
    state.leaseGuard.stop();
    throw new ApiError("session_busy", "active turn did not stop before the erasure drain deadline", {
      turnId: state.turn.id,
    });
  }

  /**
   * Common claim/lease boundary for draining and tombstoning. No local execution is disturbed until
   * the authority and fence have linearized together. The callback runs only after local execution
   * has stopped, while this runner still owns and renews the session lease.
   */
  private async withClaimedErasureSession(
    store: ErasureSessionStore,
    authority: ErasureWriteAuthorization,
    sessionId: string,
    operation: (context: { fence: number; leaseGuard: LeaseGuard }) => Promise<void>,
  ): Promise<void> {
    const localBeforeAcquire = this.active.get(sessionId);
    if (localBeforeAcquire && (
      localBeforeAcquire.session.tenantId !== authority.tenantId
      || localBeforeAcquire.session.userId !== authority.userId
    )) throw new Error("local active turn owner does not match erasure authority");

    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(
      sessionId,
      this.deps.config.runnerId,
      this.deps.config.runnerAddr,
      this.cfg.leaseTtlMs,
    );
    if (!lease.ok) {
      throw new ApiError("session_lease_conflict", "session owned by another runner", {
        ownerId: lease.ownerId,
        ownerAddr: lease.ownerAddr,
      });
    }

    const leaseGuard = this.startLeaseGuard(sessionId);
    let claimValidated = false;
    let releaseLease = true;
    try {
      leaseGuard.assertOwned();
      await leaseGuard.wait(store.applyErasureSessionAction({
        authority,
        sessionId,
        fence: lease.fence,
        action: "fence",
      }));
      claimValidated = true;

      // Do not disturb a live local turn until the durable request/subject/generation/claim lease has
      // been revalidated inside the same transaction as the fence hand-off.
      const local = this.active.get(sessionId);
      if (local) {
        try {
          await leaseGuard.wait(this.drainLocalTurnForErasure(local));
        } catch (error) {
          // A wedged provider/tool may still have external side effects in flight. Stop both renewal
          // loops and let the lease expire; releasing immediately would let a new worker overlap it.
          releaseLease = false;
          local.leaseGuard.stop();
          leaseGuard.stop();
          throw error;
        }
      }
      // A failed ordinary turn-end write may have scheduled the normal warm-owner hold while the
      // local state was draining. It must not release the erasure owner's lease mid-operation.
      this.clearHold(sessionId);
      await operation({ fence: lease.fence, leaseGuard });
    } catch (error) {
      const failure = leaseGuard.lost ?? error;
      // A stale/expired authority must not tear down the lease of an otherwise valid local turn.
      if (!claimValidated && this.active.has(sessionId)) releaseLease = false;
      if (leaseGuard.lost) releaseLease = false;
      if (failure instanceof SessionGoneError) {
        const concurrent = await this.readErasureHead(store, authority, sessionId).catch(() => null);
        if (concurrent?.deleted) return;
      }
      throw await this.translateSessionLeaseFailure(sessionId, failure);
    } finally {
      leaseGuard.stop();
      if (releaseLease) {
        await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
      }
    }
  }

  private async drainSessionForErasureLocked(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    const store = this.getErasureStore();
    const head = await this.readErasureHead(store, authority, sessionId);
    if (!head) throw new ApiError("not_found", "session not found");
    if (head.deleted) return;
    this.assertNoFencedLocalErasureTurn(sessionId);
    await this.withClaimedErasureSession(store, authority, sessionId, async () => {});
  }

  private async eraseSessionForErasureLocked(
    authority: ErasureWriteAuthorization,
    sessionId: string,
  ): Promise<void> {
    const store = this.getErasureStore();
    let head = await this.readErasureHead(store, authority, sessionId);
    if (!head) throw new ApiError("not_found", "session not found");
    if (head.deleted) return;
    this.assertNoFencedLocalErasureTurn(sessionId);

    await this.withClaimedErasureSession(store, authority, sessionId, async ({ fence, leaseGuard }) => {
      head = await leaseGuard.wait(this.readErasureHead(store, authority, sessionId));
      if (!head) throw new ApiError("not_found", "session not found");
      if (head.deleted) return;
      if (this.active.has(sessionId)) {
        throw new ApiError("session_busy", "local turn remained active after erasure drain");
      }

      if (head.activeTurnId !== undefined) {
        leaseGuard.assertOwned();
        const settled = await leaseGuard.wait(store.applyErasureSessionAction({
          authority,
          sessionId,
          fence,
          action: "settle",
          atMs: Date.now(),
        }));
        await this.publishAll(sessionId, settled.events);
        head = await leaseGuard.wait(this.readErasureHead(store, authority, sessionId));
        if (!head) throw new ApiError("not_found", "session not found");
        if (head.deleted) return;
      }
      if (head.activeTurnId !== undefined) {
        throw new SessionLifecycleBusyError(sessionId);
      }

      leaseGuard.assertOwned();
      const result = await leaseGuard.wait(store.applyErasureSessionAction({
        authority,
        sessionId,
        fence,
        action: "tombstone",
        atMs: Date.now(),
      }));
      await this.publishAll(sessionId, result.events);
    });
  }

  /**
   * A timed-out erasure drain deliberately leaves the session lease to expire. Because ordinary
   * leases use the stable runner id, a queued duplicate on this same process would otherwise
   * re-acquire that owner and extend the TTL forever. The active state is removed only after the
   * provider/tool really stops, so this check is the exact safe boundary for allowing a retry.
   */
  private assertNoFencedLocalErasureTurn(sessionId: string): void {
    const local = this.active.get(sessionId);
    if (local?.erasureDrainTimedOut) throw new ErasureLocalTurnFencedError();
  }

  private async deleteSessionLocked(principal: Principal, sessionId: string): Promise<void> {
    if (!principal.userId) throw new ApiError("unauthorized", "an end-user identity is required to delete a session");
    let lifecycle = await this.deps.store.getSessionLifecycle(principal.tenantId, principal.userId, sessionId);
    if (!lifecycle) throw new ApiError("not_found", "session not found");
    // A tombstone is idempotent for its owner during the retention window. Do not acquire a new
    // lease or append another event/outbox row for a retry whose 204 response was lost.
    if (lifecycle.deletedAtMs !== undefined) {
      await this.deps.store.sealOrdinarySessionDeleteGrace(principal.tenantId, principal.userId, sessionId);
      return;
    }

    let session = lifecycle.session;
    if (this.active.has(sessionId)) throw new ApiError("session_busy", "cannot delete while a turn is active");

    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) {
      throw new ApiError("session_lease_conflict", "session owned by another runner", {
        ownerId: lease.ownerId,
        ownerAddr: lease.ownerAddr,
      });
    }
    const leaseGuard = this.startLeaseGuard(sessionId);
    try {
      await this.claimSessionFence(session, lease.fence, leaseGuard);
      lifecycle = await leaseGuard.wait(
        this.deps.store.getSessionLifecycle(principal.tenantId, principal.userId, sessionId),
      );
      if (!lifecycle) throw new ApiError("not_found", "session not found");
      if (lifecycle.deletedAtMs !== undefined) {
        await leaseGuard.wait(this.deps.store.sealOrdinarySessionDeleteGrace(
          principal.tenantId, principal.userId, sessionId,
        ));
        return;
      }
      session = lifecycle.session;
      if (this.active.has(sessionId)) throw new ApiError("session_busy", "cannot delete while a turn is active");

      if (session.status.type === "active") {
        // A durable active projection with no live owner is an orphan. Repair it under the new fence
        // before deleting, exactly as turn start/archive takeover do. Historical archived+active rows
        // need the archive lifecycle bypass while that repair is committed.
        const legacyArchivedRepair: SessionLifecycleTransition | undefined = session.archivedAtMs === undefined ? undefined : {
          type: "archive",
          atMs: session.archivedAtMs,
          tenantId: session.tenantId,
          userId: session.userId,
        };
        await leaseGuard.wait(this.closeOrphanedTurn(session, lease.fence, leaseGuard, legacyArchivedRepair));
        lifecycle = await leaseGuard.wait(
          this.deps.store.getSessionLifecycle(principal.tenantId, principal.userId, sessionId),
        );
        if (!lifecycle || lifecycle.deletedAtMs !== undefined) {
          if (lifecycle?.deletedAtMs !== undefined) {
            await leaseGuard.wait(this.deps.store.sealOrdinarySessionDeleteGrace(
              principal.tenantId, principal.userId, sessionId,
            ));
            return;
          }
          throw new ApiError("not_found", "session not found");
        }
        session = lifecycle.session;
      }

      // Normalize stale approvals and session grants in the same transaction as the tombstone. This
      // prevents an old authorization snapshot from becoming usable if an operator inspects or
      // restores a database copy during the grace period.
      const pending = await leaseGuard.wait(this.deps.store.listApprovals(sessionId, { pendingOnly: true }));
      const now = Date.now();
      const approvals: Approval[] = pending.map((approval) => ({
        ...approval,
        status: "expired",
        decision: "cancel",
        decidedBy: "system:delete",
        resolvedAtMs: now,
      }));
      const approvalItems = await leaseGuard.wait(Promise.all(
        pending.map((approval) => this.deps.store.getItem(sessionId, approval.itemId)),
      ));
      const items: Item[] = approvalItems.flatMap((item) => (
        item && item.type === "approvalRequest" && item.status === "inProgress"
          ? [{ ...item, status: "declined" as const, completedAtMs: now }]
          : []
      ));
      const events: EventInput[] = [];
      for (const approval of approvals) {
        events.push({ type: "approval/resolved", sessionId, emittedAtMs: now, approval });
        const item = items.find((candidate) => candidate.type === "approvalRequest" && candidate.approvalId === approval.id);
        if (item) events.push({ type: "item/completed", sessionId, emittedAtMs: now, item });
      }
      const deletionGeneration = lifecycle.deletionGeneration + 1;
      events.push({ type: "session/deleted", sessionId, emittedAtMs: now, deletionGeneration });

      leaseGuard.assertOwned();
      const result = await leaseGuard.wait(this.deps.store.commitOrdinarySessionDelete({
        sessionId,
        fence: lease.fence,
        lifecycle: {
          type: "tombstone",
          atMs: now,
          // NULL is a deliberate safety gate: the ordinary-delete grace is a retention floor,
          // not an execution deadline or authorization for irreversible physical deletion.
          purgeAfterMs: null,
          deletionGeneration,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        approvals,
        items,
        events,
        sessionPatch: { autoApprovedTools: [] },
      }));
      // This second database observation is strictly after the tombstone transaction committed.
      // Failure leaves an unsealed, non-executable origin for exact owner retry/recovery.
      let sealFailed = false;
      let sealFailure: unknown;
      try {
        await leaseGuard.wait(this.deps.store.sealOrdinarySessionDeleteGrace(
          principal.tenantId, principal.userId, sessionId,
        ));
      } catch (error) {
        sealFailed = true;
        sealFailure = error;
      }
      // Preserve the terminal event's direct publication even if post-COMMIT sealing failed.
      // The durable tombstone/outbox still makes both operations exactly retryable.
      await this.publishAll(sessionId, result.events);
      if (sealFailed) throw sealFailure;
    } catch (err) {
      const failure = leaseGuard.lost ?? err;
      if (failure instanceof SessionGoneError) {
        // Another owner may commit the same tombstone after our initial lifecycle read but before
        // this owner can install its fence. Preserve DELETE idempotency for the owning principal
        // without turning the lookup into a cross-user existence oracle.
        const concurrent = await this.deps.store
          .getSessionLifecycle(principal.tenantId, principal.userId, sessionId)
          .catch(() => null);
        if (concurrent?.deletedAtMs !== undefined) {
          await this.deps.store.sealOrdinarySessionDeleteGrace(principal.tenantId, principal.userId, sessionId);
          return;
        }
      }
      if (failure instanceof SessionLifecycleBusyError) {
        throw new ApiError("session_busy", "cannot delete while a turn is active");
      }
      if (failure instanceof SessionHasChildrenError) {
        throw new ApiError("session_has_children", "delete child sessions before deleting their parent");
      }
      throw await this.translateSessionLeaseFailure(sessionId, failure);
    } finally {
      leaseGuard.stop();
      await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
    }
  }

  private async setArchiveStateLocked(principal: Principal, sessionId: string, archive: boolean): Promise<Session> {
    let session = await this.getSession(principal, sessionId);
    if (this.active.has(sessionId)) {
      throw new ApiError("session_busy", `cannot ${archive ? "archive" : "unarchive"} while a turn is active`);
    }

    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) {
      throw new ApiError("session_lease_conflict", "session owned by another runner", {
        ownerId: lease.ownerId,
        ownerAddr: lease.ownerAddr,
      });
    }
    const leaseGuard = this.startLeaseGuard(sessionId);
    try {
      await this.claimSessionFence(session, lease.fence, leaseGuard);
      session = await leaseGuard.wait(this.getSession(principal, sessionId));
      if (this.active.has(sessionId)) {
        throw new ApiError("session_busy", `cannot ${archive ? "archive" : "unarchive"} while a turn is active`);
      }
      if (session.status.type === "active") {
        const legacyArchivedRepair: SessionLifecycleTransition | undefined = session.archivedAtMs === undefined ? undefined : {
          type: "archive",
          atMs: session.archivedAtMs,
          tenantId: session.tenantId,
          userId: session.userId,
        };
        await leaseGuard.wait(this.closeOrphanedTurn(session, lease.fence, leaseGuard, legacyArchivedRepair));
        // Orphan repair can advance lastSeq/fence and resolve approvals. Re-read before deciding
        // whether the requested lifecycle transition is now a no-op and before returning a resource.
        session = await leaseGuard.wait(this.getSession(principal, sessionId));
      }

      const transitioning = archive ? session.archivedAtMs === undefined : session.archivedAtMs !== undefined;
      // Old runners archived sessions without clearing grants or pending approvals. Normalize both
      // archive and unarchive so restoring a historical row can never revive stale authorization.
      const pending = await leaseGuard.wait(this.deps.store.listApprovals(sessionId, { pendingOnly: true }));

      const now = Date.now();
      const approvals: Approval[] = pending.map((approval) => ({
        ...approval,
        status: "expired",
        decision: "cancel",
        decidedBy: "system:archive",
        resolvedAtMs: now,
      }));
      const approvalItems = await leaseGuard.wait(Promise.all(
        pending.map((approval) => this.deps.store.getItem(sessionId, approval.itemId)),
      ));
      const items: Item[] = approvalItems.flatMap((item) => (
        item && item.type === "approvalRequest" && item.status === "inProgress"
          ? [{ ...item, status: "declined" as const, completedAtMs: now }]
          : []
      ));
      const events: EventInput[] = [];
      for (const approval of approvals) {
        events.push({ type: "approval/resolved", sessionId, emittedAtMs: now, approval });
        const item = items.find((candidate) => candidate.type === "approvalRequest" && candidate.approvalId === approval.id);
        if (item) events.push({ type: "item/completed", sessionId, emittedAtMs: now, item });
      }
      if (transitioning) {
        events.push({ type: archive ? "session/archived" : "session/unarchived", sessionId, emittedAtMs: now });
      }

      leaseGuard.assertOwned();
      const result = await leaseGuard.wait(this.deps.store.commit({
        sessionId,
        fence: lease.fence,
        lifecycle: {
          type: archive ? "archive" : "unarchive",
          atMs: archive ? (session.archivedAtMs ?? now) : now,
          tenantId: session.tenantId,
          userId: session.userId,
        },
        approvals,
        items,
        events,
        sessionPatch: { autoApprovedTools: [] },
      }));
      await this.publishAll(sessionId, result.events);
      return await leaseGuard.wait(this.getSession(principal, sessionId));
    } catch (err) {
      const failure = leaseGuard.lost ?? err;
      if (failure instanceof SessionLifecycleBusyError) {
        throw new ApiError("session_busy", `cannot ${archive ? "archive" : "unarchive"} while a turn is active`);
      }
      throw await this.translateSessionLeaseFailure(sessionId, failure);
    } finally {
      leaseGuard.stop();
      await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
    }
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
      while (!closed && seenSeq + 1 < targetSeq) {
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

    const backfillToEnd = async () => {
      while (!closed) {
        const page = await this.deps.store.readEvents(sessionId, seenSeq, 500);
        for (const event of page) deliver(event);
        if (page.length < 500) return;
      }
    };

    // Subscribe first so nothing is lost between the store read and the live attach.
    const buffer: Event[] = [];
    let buffering = true;
    let reconnectPending = false;
    let liveChain = Promise.resolve();
    const enqueue = (event: Event) => {
      liveChain = liveChain
        .then(async () => {
          let delayMs = 50;
          while (!closed) {
            try {
              await processLive(event);
              return;
            } catch (error) {
              // Keep the triggering event in this ordered chain. A terminal event may be the last
              // sequence forever, so waiting for another live event to cause recovery is unsafe.
              const name = error instanceof Error ? error.name : "unknown error";
              this.log.warn(`[session ${sessionId}] live event gap recovery failed (${name}); retrying`);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              delayMs = Math.min(1_000, delayMs * 2);
            }
          }
        });
    };
    const recoverAfterReconnect = () => {
      if (closed) return Promise.resolve();
      if (buffering) {
        reconnectPending = true;
        return Promise.resolve();
      }
      const recovery = liveChain.then(backfillToEnd);
      // Keep the live chain usable for later events, but return the rejecting branch to the bus so
      // it retries durable catch-up until the store is available again.
      liveChain = recovery.catch((error) => {
        const name = error instanceof Error ? error.name : "unknown error";
        this.log.warn(`[session ${sessionId}] reconnect catch-up failed (${name})`);
      });
      return recovery;
    };
    const unsub = await this.deps.bus.subscribe(sessionId, (event) => {
      if (buffering) buffer.push(event);
      else enqueue(event);
    }, { onReconnect: recoverAfterReconnect });
    try {
      await backfillToEnd();
      // Keep buffering until every event that arrived during replay has been processed. The loop's
      // final empty check and the flag flip are synchronous, so a publication cannot fall between them.
      while (buffer.length) {
        const batch = buffer.splice(0);
        for (const event of batch) await processLive(event);
      }
      buffering = false;
      if (reconnectPending) {
        reconnectPending = false;
        await recoverAfterReconnect();
      }
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
    const runtimeLease = this.deps.tenantRuntime?.enter(principal.tenantId, "turn");
    let transferred = false;
    try {
      return await this.serialiseSessionStart(
        sessionId,
        () => this.beginTurnLocked(principal, sessionId, req, opts, runtimeLease, () => { transferred = true; }),
      );
    } finally {
      if (!transferred) runtimeLease?.release();
    }
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

  /**
   * Close the Redis-to-MySQL hand-off window before reading takeover state. Once this pure commit
   * advances the durable fence, every write from the previous owner is rejected by the row lock.
   */
  private async claimSessionFence(session: Session, fence: number, leaseGuard: LeaseGuard): Promise<void> {
    leaseGuard.assertOwned();
    await leaseGuard.wait(this.deps.store.commit({
      sessionId: session.id,
      fence,
      fenceClaim: { tenantId: session.tenantId, userId: session.userId },
    }));
    leaseGuard.assertOwned();
  }

  private async translateSessionLeaseFailure(sessionId: string, failure: unknown): Promise<unknown> {
    if (failure instanceof SessionGoneError) return new ApiError("not_found", "session not found");
    if (failure instanceof FenceError) {
      return new ApiError(
        "session_lease_conflict",
        "session ownership changed before the durable fence was established",
        await this.ownerDetails(sessionId),
      );
    }
    return failure;
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
      if (err instanceof SessionArchivedError) {
        throw new ApiError("session_archived", "cannot start a turn in an archived session");
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

  private async beginTurnLocked(
    principal: Principal,
    sessionId: string,
    req: StartTurnRequest,
    opts: { idempotencyKey?: string },
    runtimeLease?: TenantRuntimeLease,
    transferRuntimeLease: () => void = noop,
  ): Promise<BegunTurn> {
    runtimeLease?.assertOpen();
    const session = await this.getSession(principal, sessionId);
    runtimeLease?.assertOpen();
    const requestHash = opts.idempotencyKey ? turnRequestHash(req) : undefined;
    const existing = opts.idempotencyKey
      ? await this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!)
      : undefined;
    runtimeLease?.assertOpen();
    const local = this.active.get(sessionId);
    if (existing && existing.status !== "inProgress") {
      return { turn: existing, session, replayed: true, run: noop };
    }
    this.assertNotArchived(session, "start a turn in");
    if (existing && local?.turn.id === existing.id) return { turn: existing, session, replayed: true, run: noop };
    const probingInProgressReplay = existing?.status === "inProgress" && !local;
    if (this.draining && !probingInProgressReplay) throw new ApiError("draining", "runner is draining");
    const agent = await this.deps.store.getAgent(principal.tenantId, session.agentId, session.agentVersion);
    runtimeLease?.assertOpen();
    if (!agent) throw new ApiError("not_found", "agent version not found");
    const busyPolicy = req.busyPolicy ?? agent.busyPolicy;
    const input = executableInput(req.input, this.imagesEnabled(), this.hasExecutableSkills(agent));

    // Busy handling: the truth is the session status in the store (survives restarts), the active map is our local view.
    if (local) {
      if (busyPolicy === "steer") {
        if (req.skillOverrides !== undefined) throw new ApiError("invalid_request", "Skill overrides cannot change an active turn.");
        const idempotency: IdempotencyReceiptInput | undefined = opts.idempotencyKey ? {
          scope: { tenantId: session.tenantId, userId: session.userId, sessionId },
          key: opts.idempotencyKey,
          requestHash: requestHash!,
          value: { turnId: local.turn.id, sessionId },
          expiresAtMs: Date.now() + this.cfg.idempotencyTtlMs,
        } : undefined;
        await this.steerActive(local, req.input, input, idempotency);
        runtimeLease?.assertOpen();
        return { turn: local.turn, session, steered: true, run: noop };
      }
      throw new ApiError("session_busy", "a turn is in progress", { turnId: local.turn.id });
    }

    // ---- single writer ----
    this.clearHold(sessionId);
    runtimeLease?.assertOpen();
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) {
      runtimeLease?.assertOpen();
      // The first receipt read can race another runner's atomic turn-start commit. Re-read only after
      // acquisition fails: a matching receipt now proves this request already owns a durable turn and
      // is safe to replay; without one this remains an ordinary lease conflict.
      const racedExisting = opts.idempotencyKey
        ? await this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!)
        : undefined;
      runtimeLease?.assertOpen();
      if (racedExisting) {
        return { turn: racedExisting, session, replayed: true, run: noop };
      }
      throw new ApiError("session_lease_conflict", "session owned by another runner", { ownerId: lease.ownerId, ownerAddr: lease.ownerAddr });
    }
    const fence = lease.fence;
    const leaseGuard = this.startLeaseGuard(sessionId);

    try {
      runtimeLease?.assertOpen();
      await this.claimSessionFence(session, fence, leaseGuard);
      runtimeLease?.assertOpen();
      // The snapshot read at entry is stale by now (several awaits, one of them a DB round trip): a
      // turn may have finished in between. Re-read before deciding anything about the session state.
      const fresh = await leaseGuard.wait(this.getSession(principal, sessionId));
      runtimeLease?.assertOpen();
      Object.assign(session, fresh);
      const afterLeaseExisting = opts.idempotencyKey
        ? await leaseGuard.wait(this.lookupIdempotentTurn(session, opts.idempotencyKey, requestHash!))
        : undefined;
      runtimeLease?.assertOpen();
      if (afterLeaseExisting) {
        if (session.archivedAtMs !== undefined && afterLeaseExisting.status === "inProgress") {
          throw new ApiError("session_archived", "cannot resume an in-progress turn in an archived session");
        }
        // A response can be lost after the atomic turn-start commit but before run(). If no runner is
        // executing that durable in-progress turn, close it as interrupted before replaying it.
        if (afterLeaseExisting.status === "inProgress") {
          if (session.status.type !== "active" || session.status.turnId !== afterLeaseExisting.id) {
            throw new ApiError("idempotency_conflict", "the idempotent turn is inconsistent with the session state");
          }
          leaseGuard.assertOwned();
          await leaseGuard.wait(this.closeOrphanedTurn(session, fence, leaseGuard));
          runtimeLease?.assertOpen();
        }
        const replay = (await this.deps.store.getTurn(sessionId, afterLeaseExisting.id)) ?? afterLeaseExisting;
        runtimeLease?.assertOpen();
        leaseGuard.stop();
        await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
        return { turn: replay, session, replayed: true, run: noop };
      }
      this.assertNotArchived(session, "start a turn in");
      // The receipt may have expired between the optimistic lookup and lease acquisition. A draining
      // runner may repair/replay an existing durable turn, but must never fall through and create one.
      if (this.draining) throw new ApiError("draining", "runner is draining");
      if (session.status.type === "active" && !this.active.has(sessionId)) {
        // A previous owner died mid-turn (or we restarted). Close the orphaned turn before starting a new one.
        leaseGuard.assertOwned();
        await leaseGuard.wait(this.closeOrphanedTurn(session, fence, leaseGuard));
      }
      runtimeLease?.assertOpen();
      return await this.beginTurnInner(principal, session, agent, req, input, opts, fence, leaseGuard, runtimeLease, transferRuntimeLease);
    } catch (err) {
      const failure = leaseGuard.lost ?? err;
      leaseGuard.stop();
      await this.deps.lease.release(sessionId, this.deps.config.runnerId).catch(() => {});
      throw await this.translateSessionLeaseFailure(sessionId, failure);
    }
  }

  private async beginTurnInner(
    principal: Principal,
    session: Session,
    agent: AgentDefinition,
    req: StartTurnRequest,
    input: ExecutableInputPart[],
    opts: { idempotencyKey?: string },
    fence: number,
    leaseGuard: LeaseGuard,
    runtimeLease?: TenantRuntimeLease,
    transferRuntimeLease: () => void = noop,
  ): Promise<BegunTurn> {
    const sessionId = session.id;

    // ---- resolve model, tools, context ----
    runtimeLease?.assertOpen();
    const modelRef = { ...agent.model, ...(req.model ?? {}) };
    const model = await leaseGuard.wait(this.deps.providers.resolve(principal, modelRef));
    runtimeLease?.assertOpen();
    if (input.some((part) => part.type === "image") && !model.input.includes("image")) {
      throw new ApiError("invalid_request", `model ${model.model} does not support image input`);
    }
    const extensionSignal = AbortSignal.any([
        leaseGuard.abort.signal,
        ...(runtimeLease ? [runtimeLease.signal] : []),
      ]);
    const tools: RunnerTool[] = [
      ...await leaseGuard.wait(this.resolveTools(principal, agent, extensionSignal)),
      ...(req.dynamicTools ?? []).map((d) => this.dynamicTools.asTool(d, this.cfg.dynamicToolTimeoutMs)),
    ];
    const skillResolution = turnSkillResolution(req);
    const skills = await leaseGuard.wait(this.listSkills(principal, agent, extensionSignal, skillResolution));
    const skillBudget: SkillBudget = { remainingTokens: 0, contexts: new Map() };
    this.mountSkillTool(principal, agent, skills, tools, skillBudget, skillResolution);
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new ApiError("invalid_request", "tool names collide");
    }
    this.assertSkillDependencies(skills, tools.map(tool => tool.name));
    runtimeLease?.assertOpen();
    const systemPrompt = buildSystemPrompt(agent, skills, !!this.deps.skills?.load);
    const limits = mergeLimits(agent.limits, req.limits);
    const hooksSha256 = this.toolHooksVersion(principal);
    const hasMcp = agent.mcpServers.length > 0 || (agent.mcpRegistrations?.length ?? 0) > 0;
    const hasExtensions = hasMcp || agent.skills.length > 0 || hooksSha256 !== undefined;
    const contextEpoch = hasExtensions
      ? computeContextEpoch({ agentId: agent.id, agentVersion: agent.version, systemPrompt, tools, skills, hooksSha256 })
      : session.contextEpoch;
    const catalogChanged = contextEpoch !== session.contextEpoch;
    const currentGrantScopes = new Set(tools.map((tool) => tool.approvalScope ?? tool.name));
    const autoApprovedTools = hasMcp
      ? session.autoApprovedTools.filter((scope) => currentGrantScopes.has(scope))
      : session.autoApprovedTools;
    let repairWarning: { code: string; message: string } | undefined;

    // One request-local byte budget covers everything sent to the main model. Materialize the
    // submitted input first and strictly: retained history may degrade, but the caller's current
    // input must either arrive intact or fail before a turn is persisted.
    const hydrationBudget = this.deps.blobs?.createHydrationBudget();
    const persistedItems = await leaseGuard.wait(this.deps.store.listItems(sessionId, { afterSeq: projectFromSeq(session), limit: MAX_PROJECTED_ITEMS, newestFirst: true }));
    const snapshotItems = await this.hydrateSkillSnapshotItems(principal, sessionId, persistedItems, leaseGuard);
    this.reserveSkillContexts(skillBudget, collectResolvedSkillContexts(snapshotItems));
    runtimeLease?.assertOpen();
    const resolvedInput = await leaseGuard.wait(this.resolveSkillInput(principal, agent, skills,
      tools.map(tool => tool.name), input, extensionSignal, skillBudget, skillResolution));
    const engineInput = await leaseGuard.wait(
      this.materializeSubmittedInput(principal, sessionId, resolvedInput.input, hydrationBudget),
    );
    runtimeLease?.assertOpen();

    // Plan against raw persisted items. Historical images become explicit placeholders, and
    // offloaded tool results retain their small durable marker, so old bytes cannot exhaust the
    // hydration budget before compaction/pruning has selected the retained tail.
    const planningProjection = projectItemsForPlanning(persistedItems);
    if (planningProjection.repaired.length) {
      this.log.warn(`[session ${sessionId}] repaired ${planningProjection.repaired.length} orphaned tool calls`);
      repairWarning = {
        code: "tool_calls_repaired",
        message: `${planningProjection.repaired.length} tool call(s) from an interrupted turn were resolved as ${[...new Set(planningProjection.repaired.map((r) => r.code))].join("/")}`,
      };
    }
    const budget = Math.floor(model.contextWindow * this.cfg.contextBudgetRatio);
    // Summary tier first: it changes which items are in play. Then cheap pruning on what remains.
    const compacted = await this.maybeCompact(
      principal,
      session,
      fence,
      persistedItems,
      model,
      budget,
      leaseGuard,
      hydrationBudget,
    );
    runtimeLease?.assertOpen();
    const projectedMessages = compacted?.messages ?? projectItems(
      await leaseGuard.wait(this.hydratePersistedItems(principal, sessionId, persistedItems, hydrationBudget)),
    ).messages;
    const history = pruneToolResults(projectedMessages, budget);
    const inputTokens = engineInput.reduce((total, part) => total + (part.type === "text" ? estimateTokens(part.text) : 0), 0);
    skillBudget.remainingTokens = Math.max(0, budget - estimateTokens(systemPrompt) - transcriptTokens(history) - inputTokens);
    if (agent.skills.length && estimateTokens(systemPrompt) + transcriptTokens(history) + inputTokens > budget) {
      throw new ApiError("invalid_request", "Skill context budget exceeded.");
    }
    runtimeLease?.assertOpen();

    // ---- persist turn start + user message ----
    const now = Date.now();
    const turn: Turn = {
      id: newId("turn"),
      sessionId,
      status: "inProgress",
      seqStart: session.lastSeq + 1,
      steps: 0,
      toolCalls: 0,
      usage: emptyUsageAccumulator(),
      startedAtMs: now,
      idempotencyKey: opts.idempotencyKey,
      model: { provider: model.provider, model: model.model },
      metadata: req.metadata,
    };
    const userItem: Item = { id: newId("item"), sessionId, turnId: turn.id, seq: 0, status: "completed", createdAtMs: now, completedAtMs: now, type: "userMessage", content: req.input,
      ...(resolvedInput.skillContexts.length ? { skillContexts: resolvedInput.skillContexts } : {}) };
    const catalogMessage = hooksSha256 !== undefined ? "Tool policy or catalog changed; current tool policies apply before every execution."
      : agent.skills.length ? "Tool or skill catalog changed; loaded skill snapshots remain bound to their original versions."
      : "Remote tool catalog changed; previous approvals do not apply to changed tools.";
    const catalogNotice: ItemOf<"systemNotice"> | undefined = catalogChanged ? {
      id: newId("item"), sessionId, turnId: turn.id, seq: 0, status: "completed",
      createdAtMs: now, completedAtMs: now, type: "systemNotice", kind: "toolsChanged", text: catalogMessage,
    } : undefined;
    if (catalogNotice) history.push({ role: "user", content: [{ type: "text", text: `[system notice: toolsChanged] ${catalogMessage}` }] });
    const state: ActiveTurn = {
      turn, session, agent, modelInput: model.input, hydrationBudget, fence, abort: leaseGuard.abort, leaseGuard, limits,
      stepUsage: emptyUsage(), step: 0, toolCalls: 0, agentText: "", reasoningText: "", lastText: "",
      toolCallItems: new Map(), pendingApprovals: new Map(),
      autoApproved: new Set(autoApprovedTools),
      mcpGrantResumptions: new Map(),
      skills, skillResolution, toolNames: tools.map(tool => tool.name), skillBudget, hooksSha256,
      startedAt: now, done: Promise.resolve(), resolveDone: () => {}, chain: Promise.resolve(),
      agentItem: undefined, agentItemStarted: undefined, deltaChain: undefined,
      phase: "reserved", closingRequested: false, steerChain: Promise.resolve(), pendingSteers: [],
      tenantRuntimeLease: runtimeLease,
    };
    state.done = new Promise((r) => (state.resolveDone = r));
    // Preflight contains provider/store/summariser awaits, during which drain() may observe no active
    // turn and finish. This final synchronous check + registration closes that race: after the check,
    // drain cannot run until `active` contains this state.
    if (this.draining) throw new ApiError("draining", "runner is draining");
    runtimeLease?.assertOpen();
    leaseGuard.attach(() => {
      const wasReserved = state.phase === "reserved";
      state.fenced = true;
      state.closingRequested = true;
      state.phase = "finishing";
      state.stopReason = "error";
      this.failPendingApprovals(state, "cancel");
      this.reportOwnershipLost(state);
      if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
      this.logTurnStop("error", `[session ${sessionId}] lease lost; runner no longer owns the session; aborting turn ${turn.id}`);
    });
    if (runtimeLease) {
      const onRuntimeFence = () => {
        if (state.phase === "finished") return;
        const wasReserved = state.phase === "reserved";
        state.fenced = true;
        state.closingRequested = true;
        state.stopReason = "interrupted";
        this.failPendingApprovals(state, "cancel");
        state.abort.abort();
        if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
      };
      state.tenantRuntimeAbortListener = onRuntimeFence;
      runtimeLease.signal.addEventListener("abort", onRuntimeFence, { once: true });
    }
    this.active.set(sessionId, state);
    transferRuntimeLease();

    try {
      runtimeLease?.assertOpen();
      leaseGuard.assertOwned();
      await this.commit(state, {
        turn,
        items: [...(catalogNotice ? [catalogNotice] : []), userItem],
        blobBindings: this.inputBlobBindings(req.input, userItem.id),
        idempotency: opts.idempotencyKey ? {
          scope: { tenantId: session.tenantId, userId: session.userId, sessionId },
          key: opts.idempotencyKey,
          requestHash: turnRequestHash(req),
          value: { turnId: turn.id, sessionId },
          expiresAtMs: now + this.cfg.idempotencyTtlMs,
        } : undefined,
        events: [
          { type: "turn/started", sessionId, emittedAtMs: now, turn },
          ...(catalogNotice ? [
            { type: "item/completed" as const, sessionId, emittedAtMs: now, item: catalogNotice },
            { type: "warning" as const, sessionId, emittedAtMs: now, code: hooksSha256 !== undefined ? "hook_policy_changed" : agent.skills.length ? "skill_catalog_changed" : "mcp_catalog_changed", message: catalogMessage },
          ] : []),
          ...(repairWarning ? [{ type: "warning" as const, sessionId, emittedAtMs: now, ...repairWarning }] : []),
          { type: "item/completed", sessionId, emittedAtMs: now, item: userItem },
          { type: "session/status/changed", sessionId, emittedAtMs: now, status: { type: "active", turnId: turn.id, activeFlags: [] } },
        ],
        sessionPatch: {
          status: { type: "active", turnId: turn.id, activeFlags: [] },
          ...(hasExtensions ? { contextEpoch } : {}),
          ...(hasMcp ? { autoApprovedTools } : {}),
        },
      });
      runtimeLease?.assertOpen();
      leaseGuard.assertOwned();
    } catch (err) {
      this.active.delete(sessionId);
      state.resolveDone();
      this.releaseTenantRuntime(state);
      if (err instanceof IdempotencyMismatchError) {
        throw new ApiError("idempotency_conflict", "this Idempotency-Key was already used for a different request");
      }
      if (err instanceof IdempotencyPendingError) {
        throw new ApiError("idempotency_conflict", "this Idempotency-Key has a legacy request still in progress");
      }
      if (err instanceof SessionArchivedError) {
        throw new ApiError("session_archived", "cannot start a turn in an archived session");
      }
      if (err instanceof BlobStateError) {
        throw new ApiError("invalid_request", "one or more image blobs expired or became unavailable");
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
      void this.runEngine(principal, state, { systemPrompt, tools, history, input: engineInput, model, limits });
    };
    return { turn, session, run };
  }

  private async runEngine(
    principal: Principal,
    state: ActiveTurn,
    p: { systemPrompt: string; tools: RunnerTool[]; history: ReturnType<typeof projectItems>["messages"]; input: EngineInputPart[]; model: ResolvedModel; limits: ReturnType<typeof mergeLimits> },
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
    } catch {
      result = { steps: state.step, aborted: state.abort.signal.aborted, error: "provider_error" };
    }
    const failure = getPiProviderStepFailure(result);
    const failedMessage = getPiProviderStepFailureMessage(result);
    if (this.deps.persistedProviderFailureCapture && failure && failedMessage
      && !state.fenced && state.capturedProviderFailureStep !== failure.stepIndex
      && state.step === failure.stepIndex) {
      // A typed, original provider result may reach done without its step callback finishing.
      // Retry only that durable step admission; an ambiguous store outcome already fenced state,
      // so it cannot reach this branch and we never execute another model request.
      await sink.onAssistantMessage(failedMessage).catch(() => {});
    }
    await this.finishTurn(state, result).catch(() => this.logTurnStop("error", "turn finish failed"));
  }

  /** One JSON round trip only, also used for hook-enabled duplicate-result identity. */
  private prepareToolOutput(result: EngineToolResult): PreparedToolOutput {
    try {
      const raw = JSON.stringify({ content: result.content, details: result.details });
      const parsed = ToolOutputPayload.safeParse(JSON.parse(raw));
      if (!parsed.success) return { ok: false };
      const payload = parsed.data;
      if (result.details !== undefined && payload.details === undefined) payload.details = {};
      return { ok: true, payload, serialized: JSON.stringify(payload) };
    } catch { return { ok: false }; }
  }

  private async durableToolResult(
    principal: Principal,
    state: ActiveTurn,
    result: EngineToolResult,
    now: number,
    prepared: PreparedToolOutput = this.prepareToolOutput(result),
  ): Promise<{ item: Extract<Item, { type: "toolResult" }>; blobBindings: BlobBinding[]; canonical: EngineToolResult }> {
    const base = {
      id: newId("item"),
      sessionId: state.session.id,
      turnId: state.turn.id,
      seq: 0,
      step: state.step,
      createdAtMs: now,
      completedAtMs: now,
      type: "toolResult" as const,
      toolCallId: result.toolCallId,
      name: result.name,
    };
    const failed = (
      code: "TOOL_OUTPUT_NOT_SERIALIZABLE" | "TOOL_OUTPUT_TOO_LARGE" | "TOOL_OUTPUT_STORAGE_FAILED",
      text: string,
      details: Record<string, unknown> = { code },
    ) => {
      const canonical: EngineToolResult = {
        toolCallId: result.toolCallId,
        name: result.name,
        content: [{ type: "text", text }],
        isError: true,
        details,
      };
      const item: Extract<Item, { type: "toolResult" }> = {
        ...base,
        status: "failed",
        content: canonical.content,
        isError: true,
        details: canonical.details,
      };
      return { item, blobBindings: [] as BlobBinding[], canonical };
    };

    // The round trip is intentional. Database JSON columns and blob payloads observe JSON values,
    // so the live Pi transcript must consume that same representation (undefined fields removed,
    // non-finite numbers normalized, and custom toJSON behavior applied) rather than the raw object.
    if (!prepared.ok) {
      return failed(
        "TOOL_OUTPUT_NOT_SERIALIZABLE",
        "TOOL_OUTPUT_NOT_SERIALIZABLE: the tool output could not be durably recorded.",
      );
    }
    const { payload, serialized } = prepared;

    const canonical: EngineToolResult = {
      toolCallId: result.toolCallId,
      name: result.name,
      content: payload.content,
      isError: result.isError,
      details: payload.details,
    };
    const inline = (): Extract<Item, { type: "toolResult" }> => ({
      ...base,
      status: canonical.isError ? "failed" : "completed",
      content: canonical.content,
      isError: canonical.isError,
      details: canonical.details,
    });
    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    if (sizeBytes > this.maxDurableToolOutputBytes) {
      return failed(
        "TOOL_OUTPUT_TOO_LARGE",
        "TOOL_OUTPUT_TOO_LARGE: the tool output exceeded the configured durable storage limit.",
        { code: "TOOL_OUTPUT_TOO_LARGE", sizeBytes, maxBytes: this.maxDurableToolOutputBytes },
      );
    }
    const threshold = this.cfg.toolOutputBlobThresholdBytes;
    if (!this.cfg.blobAttachmentsEnabled || threshold === 0 || !this.deps.blobs) {
      return { item: inline(), blobBindings: [], canonical };
    }
    if (sizeBytes < threshold) return { item: inline(), blobBindings: [], canonical };

    let uploaded: Awaited<ReturnType<SessionBlobService["stageAndUpload"]>>;
    try {
      uploaded = await this.deps.blobs.stageAndUpload({
        owner: principal,
        sessionId: state.session.id,
        fence: state.fence,
        purpose: "tool_output",
        data: Buffer.from(serialized, "utf8"),
        contentType: TOOL_OUTPUT_CONTENT_TYPE,
      });
    } catch {
      // Blob adapters may include filesystem paths, object locators or credentials in their
      // errors. Never let those errors escape through an engine's tool-result fallback or enter
      // the durable transcript; an unbound staged manifest is reclaimed by the staging sweeper.
      return failed(
        "TOOL_OUTPUT_STORAGE_FAILED",
        "TOOL_OUTPUT_STORAGE_FAILED: the tool output could not be durably stored.",
      );
    }
    const item: Extract<Item, { type: "toolResult" }> = {
      ...base,
      status: canonical.isError ? "failed" : "completed",
      content: [{ type: "text", text: `Tool output stored externally (${sizeBytes} bytes).` }],
      isError: canonical.isError,
      outputRef: uploaded.blobId,
    };
    return {
      item,
      blobBindings: [{ blobId: uploaded.blobId, itemId: item.id, purpose: "tool_output" }],
      canonical,
    };
  }

  private makeSink(principal: Principal, state: ActiveTurn, tools: RunnerTool[]): EngineSink {
    const sessionId = state.session.id;
    const turnId = state.turn.id;
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const live = (e: Event) => void this.deps.bus.publish(sessionId, e).catch(() => {});
    const resultWork = new Map<string, { identity: string | undefined; promise: Promise<EngineToolResult> }>();
    const persistResultOnce = async (r: EngineToolResult, prepared?: PreparedToolOutput): Promise<EngineToolResult> => {
      const now = Date.now();
      const durable = await this.durableToolResult(principal, state, r, now, prepared);
      const call = state.toolCallItems.get(r.toolCallId);
      const items: Item[] = [];
      const events: EventInput[] = [];
      if (call) {
        call.status = call.status === "declined" ? "declined" : durable.canonical.isError ? "failed" : "completed";
        call.completedAtMs = now;
        items.push(call);
        events.push({ type: "item/completed", sessionId, emittedAtMs: now, item: call });
      }
      items.push(durable.item);
      events.push({ type: "item/completed", sessionId, emittedAtMs: now, item: durable.item });
      const tool = toolByName.get(r.name);
      // Unknown remote outcomes (and all other failed MCP executions) invalidate reusable grants.
      // A model's next attempt must obtain new explicit consent, never silently replay a side effect.
      const revoke = durable.canonical.isError && tool?.kind === "mcp" && !!call?.startedAtMs;
      if (revoke) state.autoApproved.delete(tool.approvalScope ?? tool.name);
      const resume = !durable.canonical.isError ? state.mcpGrantResumptions.get(r.toolCallId) : undefined;
      const nextGrants = new Set(state.autoApproved);
      if (resume) nextGrants.add(resume);
      await this.commit(state, {
        items, events, blobBindings: durable.blobBindings,
        ...(revoke || resume ? { sessionPatch: { autoApprovedTools: [...nextGrants] } } : {}),
      });
      if (resume) state.autoApproved.add(resume);
      state.mcpGrantResumptions.delete(r.toolCallId);
      if (state.hooksSha256 !== undefined && tool && call?.startedAtMs !== undefined && call.name === r.name) {
        this.assertToolHooksOpen(state);
        let reports: readonly ToolHookReport[] = [];
        try {
          reports = await this.deps.hooks!.postToolUse({ ...this.toolHookContext(state, tool, r.toolCallId),
            isError: durable.canonical.isError }, this.toolHookSignal(state));
        } catch {
          // Callback failures are observer fail-open. Store/report COMMIT and ownership checks
          // deliberately live outside this catch and must still stop an invalid writer.
        }
        this.assertToolHooksOpen(state);
        await this.commitToolHookReports(state, r.toolCallId, reports);
      }
      return durable.canonical;
    };
    const persistToolResult = async (r: EngineToolResult): Promise<EngineToolResult> => {
      if (state.hooksSha256 === undefined) return persistResultOnce(r);
      const { toolCallId, name, isError } = r;
      const prepared = this.prepareToolOutput(r);
      const identity = prepared.ok ? sha256(stableStringify({ name, isError, payload: prepared.payload })) : undefined;
      // Provider call IDs may repeat in a later step. Only compatibility callbacks for the
      // SAME write-ahead call item share a result; a new durable call must commit/observe again.
      const callIdentity = JSON.stringify([toolCallId, state.toolCallItems.get(toolCallId)?.id ?? null]);
      const previous = resultWork.get(callIdentity);
      if (previous) {
        if (identity === undefined || previous.identity !== identity) throw new ApiError("invalid_request", "Tool result identity conflict.");
        this.assertToolHooksOpen(state);
        const canonical = await previous.promise;
        this.assertToolHooksOpen(state); return canonical;
      }
      // Schedule work only after publishing the promise, so concurrent compatibility callbacks
      // cannot start another canonical COMMIT or observer. Rejections are not retried implicitly.
      const staged = { toolCallId, name, isError, content: prepared.ok ? prepared.payload.content : [],
        details: prepared.ok ? prepared.payload.details : undefined };
      const promise = Promise.resolve().then(() => persistResultOnce(staged, prepared));
      resultWork.set(callIdentity, { identity, promise });
      return promise;
    };

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
        // Pi may synthesize another assistant error after a later listener/steer callback throws.
        // The already-committed failed step is the immutable source; a same-step synthetic error
        // must not replace its item timestamp or account for a second usage entry.
        if (msg.stopReason === "error" && state.capturedProviderFailureStep === state.step) return;
        const failure = getPiProviderStepFailure(msg);
        const captureFailure = this.deps.persistedProviderFailureCapture !== undefined
          && failure?.stepIndex === state.step && msg.stopReason === "error";
        if (captureFailure && state.capturedProviderFailureStep === state.step) return;
        if (captureFailure && state.preparedProviderFailureStep?.stepIndex === state.step) {
          // Share the original admission, including timestamp, usageId, item ID and fence. Neither
          // duplicate callbacks nor done-only settlement may manufacture a second business batch.
          await state.preparedProviderFailureStep.commit;
          return;
        }
        if (state.fenced) throw new FenceError(sessionId, state.fence, state.fence);
        // Text deltas start persistence without awaiting it. Observe that original write before
        // copying its item so a fast final callback retains the already-assigned item sequence.
        if (state.agentItemStarted) await state.agentItemStarted;
        if (state.fenced) throw new FenceError(sessionId, state.fence, state.fence);
        if (msg.stopReason === "error" && state.capturedProviderFailureStep === state.step) return;
        if (captureFailure && state.capturedProviderFailureStep === state.step) return;
        if (captureFailure && state.preparedProviderFailureStep?.stepIndex === state.step) {
          await state.preparedProviderFailureStep.commit;
          return;
        }
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
        let finalAgentItem: Item | undefined;
        if (msg.text || state.agentItemId || captureFailure) {
          // `msg.text` can come back empty on an aborted/errored step; keep what we already streamed.
          const text = msg.text || state.agentText;
          const prev = state.agentItem;
          const item: Item = prev
            ? { ...prev, status: msg.stopReason === "error" ? "failed" : "completed", completedAtMs: now, type: "agentMessage", text, phase: "finalAnswer" }
            : { id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: msg.stopReason === "error" ? "failed" : "completed", createdAtMs: now, completedAtMs: now, type: "agentMessage", text, phase: "finalAnswer" };
          items.push(item);
          finalAgentItem = item;
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
        // An active cost ceiling cannot safely treat an unpriced step as free. Persist/account for
        // this completed provider step, but close admission before any of its tools or another model
        // step can run.
        if (
          state.limits.maxCostCNY
          && msg.stopReason !== "error"
          && msg.stopReason !== "aborted"
          && !(msg.stopReason === "length" && msg.toolCalls.length === 0)
          && (nextTurnUsage.costCNY === undefined || nextTurnUsage.costCNY > state.limits.maxCostCNY)
        ) {
          state.limitHit ??= "max_cost";
          state.closingRequested = true;
        }
        if (msg.stopReason === "length" && msg.toolCalls.length === 0) state.limitHit ??= "max_output_tokens";
        events.push({
          type: "usage/updated", sessionId, emittedAtMs: now, turnId, step: state.step,
          stepUsage: msg.usage, turnUsage: nextTurnUsage, sessionUsage: nextSessionUsage,
          runtime: { provider: msg.provider, model: msg.model },
        });
        const batch: Omit<CommitBatch, "sessionId" | "fence"> = {
          items,
          events,
          turn: nextTurn,
          usageEntries: [{ usageId: newUsageId(), turnId, step: state.step, provider: msg.provider, model: msg.model, usage: msg.usage, createdAtMs: now }],
          sessionPatch: { usage: nextSessionUsage },
        };
        const persistence = this.commit(state, batch, captureFailure && finalAgentItem ? {
          tenantId: principal.tenantId, userId: principal.userId, turnId,
          itemId: finalAgentItem.id, stepIndex: state.step, failureKind: "provider_step_error",
        } : undefined);
        if (captureFailure) state.preparedProviderFailureStep = { stepIndex: state.step, commit: persistence };
        const committedStep = await persistence;
        // Do not let the finish commit turn the old streaming object back into completed. Publish
        // this canonical final state only after the first transaction actually succeeds.
        if (finalAgentItem) {
          const committed = committedStep.events.find((event) => event.type === "item/completed" && event.item.id === finalAgentItem!.id);
          if (committed?.type === "item/completed") finalAgentItem = committed.item;
          state.agentItem = finalAgentItem;
          state.agentItemId = finalAgentItem.id;
        }
        if (captureFailure) state.capturedProviderFailureStep = state.step;
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
      afterToolCall: persistToolResult,
      onToolResult: async (r) => { await persistToolResult(r); },

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
    if (state.hooksSha256 !== undefined) {
      this.assertToolHooksOpen(state);
      let decision: Awaited<ReturnType<ToolHookService["preToolUse"]>>;
      try { decision = await this.deps.hooks!.preToolUse(this.toolHookContext(state, tool, call.id), this.toolHookSignal(state)); }
      catch {
        this.assertToolHooksOpen(state);
        return { allow: false, reason: "Tool blocked by hook policy." };
      }
      this.assertToolHooksOpen(state);
      await this.commitToolHookReports(state, call.id, decision.reports);
      if (!decision.allow) return { allow: false, reason: "Tool blocked by hook policy." };
    }
    const markStarted = async () => {
      if (state.hooksSha256 !== undefined) this.assertToolHooksOpen(state);
      if (!item) {
        if (tool.kind === "mcp") throw new ApiError("internal_error", "remote tool write-ahead is missing");
        return;
      }
      item.startedAtMs = Date.now();
      const scope = tool.approvalScope ?? tool.name;
      const suspend = tool.kind === "mcp" && state.autoApproved.has(scope);
      if (suspend) state.autoApproved.delete(scope);
      // The grant is consumed in the SAME write-ahead commit, before any remote side effect. Only
      // a successful durable result below may restore it; process loss cannot retain permission to
      // silently retry an unknown outcome on a different Host.
      await this.commit(state, {
        items: [item],
        ...(suspend ? { sessionPatch: { autoApprovedTools: [...state.autoApproved] } } : {}),
      }, undefined, state.hooksSha256 !== undefined);
      if (suspend) state.mcpGrantResumptions.set(call.id, scope);
      if (state.hooksSha256 !== undefined) this.assertToolHooksOpen(state);
    };
    const policy = state.agent.approvalPolicy;
    const needs = tool.mandatoryApproval === true
      || (policy === "never" ? false : policy === "untrusted" ? !tool.readOnly : !!tool.needsApproval);
    const approvalScope = tool.approvalScope ?? tool.name;
    if (!needs || state.autoApproved.has(approvalScope)) {
      await markStarted();
      return { allow: true };
    }

    const now = Date.now();
    const approvalItemId = newId("item");
    const approval: Approval = {
      id: newId("apr"), sessionId: state.session.id, turnId: state.turn.id, itemId: approvalItemId,
      status: "pending", toolCallId: call.id, toolName: call.name, args: call.args,
      reason: msg.text || undefined,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      createdAtMs: now, expiresAtMs: now + this.cfg.approvalTtlMs,
    };
    const reqItem: Item = { id: approvalItemId, sessionId: state.session.id, turnId: state.turn.id, seq: 0, step: state.step, status: "inProgress", createdAtMs: now, type: "approvalRequest", approvalId: approval.id, toolCallId: call.id, name: call.name, args: call.args };
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
    if (decision === "acceptForSession") state.autoApproved.add(approvalScope);
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
    const session = await this.getSession(principal, sessionId);
    this.assertNotArchived(session, "resolve an approval in");
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
    const session = await this.getSession(principal, sessionId);
    this.assertNotArchived(session, "steer");
    const state = this.active.get(sessionId);
    if (!state || state.turn.id !== turnId) {
      const owner = await this.ownerDetails(sessionId);
      if (owner.ownerAddr && owner.ownerId !== this.deps.config.runnerId) {
        throw new ApiError("session_lease_conflict", "this turn is owned by another runner", owner);
      }
      throw new ApiError("not_found", "no active turn with that id on this runner");
    }
    if (req.expectedTurnId && req.expectedTurnId !== turnId) throw new ApiError("invalid_request", "expectedTurnId mismatch");
    await this.steerActive(state, req.input, executableInput(req.input, this.imagesEnabled(), this.hasExecutableSkills(state.agent)), idempotency);
  }

  /** Admit one steer against the exact ActiveTurn already selected by the caller. */
  private async steerActive(
    state: ActiveTurn,
    originalInput: InputPart[],
    input: ExecutableInputPart[],
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
      if (input.some((part) => part.type === "image") && !state.modelInput.includes("image")) {
        throw new ApiError("invalid_request", "the active turn's model does not support image input");
      }
      const now = Date.now();
      const resolved = await state.leaseGuard.wait(this.resolveSkillInput(
        { tenantId: state.session.tenantId, userId: state.session.userId }, state.agent, state.skills,
        state.toolNames, input, AbortSignal.any([state.abort.signal,
          ...(state.tenantRuntimeLease ? [state.tenantRuntimeLease.signal] : [])]), state.skillBudget, state.skillResolution));
      const skillTokens = resolved.input.reduce((total, part) => total + (part.type === "text" ? estimateTokens(part.text) : 0), 0);
      if (resolved.skillContexts.length && skillTokens > state.skillBudget.remainingTokens) throw new ApiError("invalid_request", "Skill context budget exceeded.");
      if (resolved.skillContexts.length) state.skillBudget.remainingTokens -= skillTokens;
      const item: Item = {
        id: newId("item"), sessionId, turnId, seq: 0, step: state.step, status: "completed",
        createdAtMs: now, completedAtMs: now, type: "userMessage", content: originalInput,
        ...(resolved.skillContexts.length ? { skillContexts: resolved.skillContexts } : {}),
      };
      const hydrationCheckpoint = state.hydrationBudget?.usedBytes;
      let engineInput: EngineInputPart[];
      try {
        engineInput = await state.leaseGuard.wait(
          this.materializeSubmittedInput(
            { tenantId: state.session.tenantId, userId: state.session.userId },
            sessionId,
            resolved.input,
            state.hydrationBudget,
          ),
        );
        await this.commit(state, {
          items: [item],
          blobBindings: this.inputBlobBindings(originalInput, item.id),
          idempotency,
          events: [
            { type: "item/completed", sessionId, emittedAtMs: now, item },
            { type: "turn/steered", sessionId, emittedAtMs: now, turnId, itemId: item.id },
          ],
        });
      } catch (err) {
        if (hydrationCheckpoint !== undefined) state.hydrationBudget?.rollbackTo(hydrationCheckpoint);
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
        if (err instanceof BlobStateError) {
          throw new ApiError("invalid_request", "one or more image blobs expired or became unavailable");
        }
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
      if (state.run) state.run.steer(engineInput);
      else state.pendingSteers.push(engineInput);
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
  async submitDynamicToolResultOrThrow(principal: Principal, sessionId: string, toolCallId: string, result: { content: { type: "text"; text: string }[]; isError: boolean }): Promise<void> {
    const session = await this.getSession(principal, sessionId);
    this.assertNotArchived(session, "submit a tool result to");
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
    principal: Principal,
    session: Session,
    fence: number,
    items: Item[],
    model: ResolvedModel,
    budgetTokens: number,
    leaseGuard?: LeaseGuard,
    mainRequestHydrationBudget?: BlobHydrationBudget,
  ): Promise<CompactionResult | undefined> {
    if (!this.deps.summariser) return undefined;
    const plan = planCompaction(items, { budgetTokens, keepRatio: this.cfg.compactionKeepRatio });
    if (!plan) return undefined;
    const surfaceLastSeq = session.lastSeq;
    let summaryItems = plan.summarise;
    if (plan.summarise.some((item) => item.type === "toolResult" && item.outputRef)) {
      if (!this.deps.blobs) {
        throw new BlobDataError("this runner cannot hydrate Blob-backed tool results for compaction");
      }
      const hydrationWork = this.deps.blobs.materializeReadyHistoryForCompaction(
        principal,
        session.id,
        plan.summarise,
      );
      const hydrated = leaseGuard ? await leaseGuard.wait(hydrationWork) : await hydrationWork;
      if (!hydrated) {
        // Advancing the watermark would permanently replace at least one real tool result with its
        // small durable storage marker. Keeping the un-compacted history is the safe bounded fallback.
        this.log.warn(
          `[session ${session.id}] compaction skipped: Blob hydration budget cannot materialize every offloaded tool result in the summary range`,
        );
        return undefined;
      }
      summaryItems = hydrated;
    }
    // Exact server-side snapshots survive summary replacement. Neither summariser output nor a
    // text marker can mint this metadata, and no current source file is consulted during compaction.
    let skillContexts: ResolvedSkillContext[];
    try {
      const hydratedById = new Map(summaryItems.map(item => [item.id, item]));
      const skillCalls = new Set(items.flatMap(item => item.type === "toolCall" && item.kind === "skill"
        ? [`${item.turnId}:${item.toolCallId}`] : []));
      const outsideSkillOutputs = items.filter(item => item.type === "toolResult" && item.outputRef
        && !hydratedById.has(item.id) && skillCalls.has(`${item.turnId}:${item.toolCallId}`));
      if (outsideSkillOutputs.length) {
        if (!this.deps.blobs) throw new Error("Skill snapshot hydration unavailable.");
        const work = this.deps.blobs.materializeReadyHistoryForCompaction(principal, session.id, outsideSkillOutputs);
        const hydrated = leaseGuard ? await leaseGuard.wait(work) : await work;
        if (!hydrated) throw new Error("Skill snapshot hydration unavailable.");
        for (const item of hydrated) hydratedById.set(item.id, item);
      }
      skillContexts = collectResolvedSkillContexts(items.map(item => hydratedById.get(item.id) ?? item));
      if (Buffer.byteLength(stableStringify(skillContexts)) > 65_536
        || skillContexts.reduce((total, context) => total + estimateTokens(renderSkillContext(context)), 0) > budgetTokens) {
        throw new Error("Skill context budget exceeded.");
      }
    } catch {
      if (leaseGuard?.lost) throw leaseGuard.lost;
      throw new ApiError("invalid_request", "Skill context budget exceeded.");
    }
    let summary: Awaited<ReturnType<Summariser["summarise"]>>;
    try {
      const work = this.deps.summariser.summarise({
        model,
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        text: renderForSummary(projectItemsForPlanning(summaryItems).messages),
        maxTokens: this.cfg.compactionMaxTokens,
        signal: leaseGuard?.abort.signal,
      });
      summary = leaseGuard ? await leaseGuard.wait(work) : await work;
      if (!summary.text.trim()) throw new Error("summariser returned nothing");
    } catch {
      if (leaseGuard?.lost) throw leaseGuard.lost;
      // Compaction is an optimisation: if the summariser fails, carry on with the pruned transcript.
      this.logTurnStop("warn", "compaction skipped after summariser failure");
      return undefined;
    }

    const { text, usage } = summary;
    const now = Date.now();
    const item: Item = {
      id: newId("item"), sessionId: session.id, turnId: newId("turn"), seq: 0, status: "completed",
      createdAtMs: now, completedAtMs: now, type: "contextCompaction",
      replacesUpToSeq: plan.keepFromSeq - 1, summary: text, usageSnapshot: usage,
      ...(skillContexts.length ? { skillContexts } : {}),
    };
    if (skillContexts.length && transcriptTokens(projectItemsForPlanning([
      ...items.filter(old => old.seq >= plan.keepFromSeq), { ...item, seq: surfaceLastSeq + 1 },
    ]).messages) > budgetTokens) throw new ApiError("invalid_request", "Skill context budget exceeded.");
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
      usageEntries: [{ usageId: newUsageId(), turnId: item.turnId, step: 0, provider: model.provider, model: model.model, usage, createdAtMs: now }],
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
    const persistedKept = leaseGuard ? await leaseGuard.wait(keptWork) : await keptWork;
    const hydrateWork = this.hydratePersistedItems(
      principal,
      session.id,
      persistedKept,
      mainRequestHydrationBudget,
    );
    const kept = leaseGuard ? await leaseGuard.wait(hydrateWork) : await hydrateWork;
    return { messages: projectItems(kept).messages, itemId: item.id };
  }

  /** Explicit compaction (POST /sessions/:id/compact): same path, ignoring the budget check. */
  async compactSession(principal: Principal, sessionId: string): Promise<{ compacted: boolean; summaryItemId?: string }> {
    return this.serialiseSessionStart(sessionId, () => this.compactSessionLocked(principal, sessionId));
  }

  private async compactSessionLocked(principal: Principal, sessionId: string): Promise<{ compacted: boolean; summaryItemId?: string }> {
    const session = await this.getSession(principal, sessionId);
    this.assertNotArchived(session, "compact");
    if (!this.deps.summariser) throw new ApiError("invalid_request", "this runner has no summariser configured");
    if (this.active.has(sessionId)) throw new ApiError("session_busy", "cannot compact while a turn is running");
    const agent = await this.deps.store.getAgent(principal.tenantId, session.agentId, session.agentVersion);
    if (!agent) throw new ApiError("not_found", "agent version not found");
    this.clearHold(sessionId);
    const lease = await this.deps.lease.acquire(sessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
    if (!lease.ok) throw new ApiError("session_lease_conflict", "session owned by another runner", { ownerId: lease.ownerId, ownerAddr: lease.ownerAddr });
    const leaseGuard = this.startLeaseGuard(sessionId);
    try {
      await this.claimSessionFence(session, lease.fence, leaseGuard);
      const fresh = await leaseGuard.wait(this.getSession(principal, sessionId));
      Object.assign(session, fresh);
      this.assertNotArchived(session, "compact");
      if (session.status.type === "active" || this.active.has(sessionId)) throw new ApiError("session_busy", "cannot compact while a turn is running");
      const model = await leaseGuard.wait(this.deps.providers.resolve(principal, agent.model));
      const persistedItems = await leaseGuard.wait(this.deps.store.listItems(sessionId, { afterSeq: projectFromSeq(session), limit: MAX_PROJECTED_ITEMS, newestFirst: true }));
      // force a cut by setting the budget below the current size
      const planningMessages = projectItemsForPlanning(persistedItems).messages;
      const result = await this.maybeCompact(
        principal,
        session,
        lease.fence,
        persistedItems,
        model,
        Math.floor(transcriptTokens(planningMessages) * 0.5),
        leaseGuard,
      );
      leaseGuard.assertOwned();
      return { compacted: !!result, summaryItemId: result?.itemId };
    } catch (err) {
      throw await this.translateSessionLeaseFailure(sessionId, leaseGuard.lost ?? err);
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
      // A fence can arrive while a serialized store commit/publish is still running. Do not release
      // the tenant runtime lease (and therefore do not prove activeTurnCountAfter=0) until it settles.
      await state.chain;
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
    // Keep this final boundary closed even if a stale or faulty engine returns untrusted text.
    if (result.error) turn.error = { code: "provider_error", message: PUBLIC_PROVIDER_ERROR_MESSAGE };

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
      this.releaseTenantRuntime(state);
      return;
    }
    try {
      const r = await this.commit(state, {
        turn,
        items,
        events: [
          ...(result.error ? [{ type: "error" as const, sessionId, emittedAtMs: now, code: "provider_error", message: PUBLIC_PROVIDER_ERROR_MESSAGE, turnId: turn.id }] : []),
          { type: "turn/completed", sessionId, emittedAtMs: now, turn, stopReason },
          { type: "session/status/changed", sessionId, emittedAtMs: now, status: { type: "idle" } },
        ],
        sessionPatch: { status: { type: "idle" }, usage: state.session.usage },
      });
      turn.seqEnd = r.lastSeq;
    } catch {
      this.logTurnStop("error", "turn end persistence failed; the next owner will repair");
    } finally {
      state.leaseGuard.stop();
      if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      state.phase = "finished";
      state.resolveDone();
      this.releaseTenantRuntime(state);
      this.scheduleRelease(sessionId);
    }
  }

  private releaseTenantRuntime(state: ActiveTurn): void {
    if (state.tenantRuntimeLease && state.tenantRuntimeAbortListener) {
      state.tenantRuntimeLease.signal.removeEventListener("abort", state.tenantRuntimeAbortListener);
    }
    state.tenantRuntimeAbortListener = undefined;
    state.tenantRuntimeLease?.release();
    state.tenantRuntimeLease = undefined;
  }

  /**
   * The previous owner died mid-turn: mark its turn interrupted so the store never shows two active
   * turns. A stale projection is repaired without a spurious `idle` event, which would close the SSE
   * stream of the turn we are about to start; orphaned approvals still receive resolution events.
   */
  private async closeOrphanedTurn(
    session: Session,
    fence: number,
    leaseGuard?: LeaseGuard,
    lifecycle?: SessionLifecycleTransition,
  ) {
    if (session.status.type !== "active") return;
    const activeTurnId = session.status.turnId;
    const t = await this.deps.store.getTurn(session.id, activeTurnId);
    const now = Date.now();
    const pending = (await this.deps.store.listApprovals(session.id, { pendingOnly: true }))
      .filter((approval) => approval.turnId === activeTurnId);
    const approvals: Approval[] = pending.map((approval) => ({
      ...approval,
      status: "expired",
      decision: "cancel",
      decidedBy: "system:owner_lost",
      resolvedAtMs: now,
    }));
    const approvalItems = await Promise.all(
      pending.map((approval) => this.deps.store.getItem(session.id, approval.itemId)),
    );
    const items: Item[] = approvalItems.flatMap((item) => (
      item && item.type === "approvalRequest" && item.status === "inProgress"
        ? [{ ...item, status: "declined" as const, completedAtMs: now }]
        : []
    ));
    const approvalEvents: EventInput[] = [];
    for (const approval of approvals) {
      approvalEvents.push({ type: "approval/resolved", sessionId: session.id, emittedAtMs: now, approval });
      const item = items.find((candidate) => candidate.type === "approvalRequest" && candidate.approvalId === approval.id);
      if (item) approvalEvents.push({ type: "item/completed", sessionId: session.id, emittedAtMs: now, item });
    }
    leaseGuard?.assertOwned();
    if (!t || t.status !== "inProgress") {
      // Stale projection only: repair the row without a spurious idle event. Any orphaned approval
      // still gets its own resolution events so its item cannot remain inProgress forever.
      if (session.status.type === "active") {
        leaseGuard?.assertOwned();
        const r = await this.deps.store.commit({
          sessionId: session.id,
          fence,
          lifecycle,
          approvals,
          items,
          events: approvalEvents,
          sessionPatch: { status: { type: "idle" } },
        });
        await this.publishAll(session.id, r.events);
        session.status = { type: "idle" };
        session.lastSeq = r.lastSeq;
      }
      return;
    }
    const turn: Turn = { ...t, status: "interrupted", stopReason: "interrupted", completedAtMs: now, error: { code: "owner_lost", message: "previous runner lost its lease during this turn" } };
    leaseGuard?.assertOwned();
    const r = await this.deps.store.commit({
      sessionId: session.id,
      fence,
      lifecycle,
      turn,
      approvals,
      items,
      events: [
        ...approvalEvents,
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

  private commit(state: ActiveTurn, batch: Omit<CommitBatch, "sessionId" | "fence">, providerFailureSource?: {
    tenantId: string; userId: string; turnId: string; itemId: string;
    stepIndex: number; failureKind: "provider_step_error";
  }, requireOpenToolHook = false) {
    const run = async () => {
      // A hook/report may have queued behind another COMMIT before cancellation closed admission.
      // Recheck at the real write boundary, not only before enqueueing it.
      if (requireOpenToolHook) this.assertToolHooksOpen(state);
      if (state.fenced) throw new FenceError(state.session.id, state.fence, state.fence);
      state.leaseGuard.assertOwned();
      try {
        const completeBatch = { ...batch, sessionId: state.session.id, fence: state.fence };
        const r = providerFailureSource && this.deps.persistedProviderFailureCapture
          ? await this.deps.persistedProviderFailureCapture.commit(completeBatch, providerFailureSource)
          : await this.deps.store.commit(completeBatch);
        state.session.lastSeq = r.lastSeq;
        await this.publishAll(state.session.id, r.events);
        return r;
      } catch (err) {
        // These are a normal control-flow result of the atomic turn-start receipt check, not a
        // storage failure and not evidence that this writer lost ownership.
        if (err instanceof SessionArchivedError) {
          // At reservation time beginTurnInner translates the race to a clean 409 and removes the
          // not-yet-started state itself. Once execution has begun, however, an old writer that
          // archives behind our lease must stop this turn just like deletion or fencing would.
          if (state.phase !== "reserved") this.onCommitError(state, err);
        } else if (
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
    if (err instanceof SessionGoneError || err instanceof SessionArchivedError) {
      const lifecycleState = err instanceof SessionGoneError ? "deleted" : "archived";
      state.fenced = true; // same handling: stop writing, stop stepping
      state.closingRequested = true;
      state.phase = "finishing";
      state.stopReason = "error";
      state.abort.abort();
      this.failPendingApprovals(state, "cancel");
      this.reportOwnershipLost(state);
      if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
      this.logTurnStop("warn", `[session ${state.session.id}] session was ${lifecycleState} mid-turn; stopping turn ${state.turn.id}`);
      return;
    }
    const wasAlreadyFenced = state.fenced === true;
    // An unknown commit outcome is not safe to continue past: executing another model/tool step can
    // double bill or duplicate side effects. Leave the durable in-progress turn for the next owner to
    // reconcile instead of trying to finish it from possibly dirty in-memory state.
    state.fenced = true;
    state.closingRequested = true;
    state.phase = "finishing";
    state.stopReason = "error";
    state.abort.abort();
    this.failPendingApprovals(state, "cancel");
    if (err instanceof FenceError) this.reportOwnershipLost(state);
    if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch(() => {});
    if (err instanceof FenceError) {
      if (!wasAlreadyFenced) this.logTurnStop("error", "session fenced out; aborting turn");
    } else {
      this.logTurnStop("error", "session commit failed");
    }
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
    for (const e of events) {
      await this.deps.bus.publish(sessionId, e).catch((error) => {
        const name = error instanceof Error ? error.name : "unknown error";
        this.log.warn(`[session ${sessionId}] publish failed (${name})`);
      });
    }
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
