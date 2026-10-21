import { randomUUID } from "node:crypto";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  ApiError,
  ImageMediaType,
  McpToolProgress,
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
  SubagentTaskInput,
  type SubagentPolicy,
  type SubagentTaskStatusResponse,
  type Turn,
  type Usage,
  ToolOutputPayload,
  ResolvedSkillContext,
  InputPart as InputPartSchema,
  Limits as LimitsSchema,
  ModelRef as ModelRefSchema,
  type LifecycleMiddlewareReport,
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
  McpProgressPublisher,
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
  SubagentManagedSessionError,
  assertSubagentMemberAccess,
  attachSubagentCommitAdmission,
  createSubagentChildAccess,
  createSubagentRootAccess,
  newUsageId,
} from "@agent-service/store";
import type { SubagentMemberAccess, SubagentRootSpecification, SubagentRootRecord, SubagentTaskRecord, SubagentAuthoritySnapshot } from "@agent-service/store";
import type { AgentEngine, AssistantStepResult, BeforeToolCallDecision, EngineInputPart, EngineModelStep, EngineRun, EngineSink, EngineToolResult, ProviderModelRequest, ResolvedModel, Summariser } from "../engine/types.js";
import { getPiProviderStepFailure, getPiProviderStepFailureMessage, takePiSummariserFailure } from "../engine/pi.js";
import { buildSystemPrompt, computeContextEpoch, estimateTokens, renderSkillContext, sha256, stableStringify, type SkillSummary } from "../context/assemble.js";
import { collectResolvedSkillContexts, projectItems, projectItemsForPlanning, pruneToolResults } from "../context/history.js";
import { COMPACTION_SYSTEM_PROMPT, planCompaction, renderForSummary, transcriptTokens } from "../context/compact.js";
import { newId } from "../ids.js";
import type { RunnerTool, ToolRegistry, ToolExecutionContext, ToolResult } from "../tools/types.js";
import type { McpToolSource } from "../mcp/service.js";
import type { LoadedStaticSkill, SkillResolution, StaticSkillLoadInput } from "../skills/static.js";
import type { ToolHookContext, ToolHookReport, ToolHookService } from "../hooks/types.js";
import type { LifecycleHookContext, LifecycleHookService } from "../hooks/lifecycle-types.js";
import { resolveSubagentTarget, selectSubagentPolicy, subagentToolAuthority, SubagentPolicyError, type SelectedSubagentPolicy } from "../subagents/policy.js";
import { createSubagentTaskDescriptor } from "../subagents/tool.js";
import type { RegisteredTenantWebhookService, TenantWebhookDispatchReport, TenantWebhookMilestonePlan } from "../hooks/registered.js";
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
function publicEngineFailure(code: unknown): { code: "provider_error" | "quota_exceeded" | "draining" | "subject_deleting"; message: string } {
  if (code === "quota_exceeded") return { code, message: "Provider quota exceeded." };
  if (code === "draining") return { code, message: "Provider admission is unavailable." };
  if (code === "subject_deleting") return { code, message: "Subject is being deleted." };
  return { code: "provider_error", message: PUBLIC_PROVIDER_ERROR_MESSAGE };
}

export interface ProviderResolver {
  resolve(principal: Principal, ref: { provider: string; model: string; reasoning?: "off" | "low" | "medium" | "high" }): Promise<ResolvedModel>;
  /** An implementation must authenticate the original request; public error codes grant nothing. */
  resolveFallback?(principal: Principal, failedRequest: ProviderModelRequest): Promise<ResolvedModel | undefined>;
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
  lifecycleHooks?: LifecycleHookService;
  /** Fresh whole-configured-fleet proof at actual extension/provider admission, never a cached capability. */
  authorizeRuntimeExtensions?: (signal: AbortSignal) => Promise<void>;
  subagents?: { enabled: boolean; maxDepth: number; maxConcurrent: number; maxTasks: number };
  tenantWebhooks?: RegisteredTenantWebhookService;
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

interface McpProgressChannel {
  accepting: boolean;
  closed: boolean;
  accepted: number;
  pending: number;
  lastProgress: number;
  tail: Promise<void>;
  publisher: McpProgressPublisher;
  abort: AbortController;
  closePromise?: Promise<void>;
  drainTimer?: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
  report: (progress: McpToolProgress) => void;
}

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
  /** Only a successful actual started COMMIT may admit a progress reporter. */
  mcpProgressStarted: Set<string>;
  /** Per durable call, bounded live-only work; result/finish awaits real publication settlement. */
  mcpProgressChannels: Map<string, McpProgressChannel>;
  skills: readonly SkillSummary[];
  /** Accepted once at turn start; steer cannot replace the immutable selection. */
  skillResolution?: SkillResolution;
  toolNames: readonly string[];
  skillBudget: SkillBudget;
  hooksSha256?: string;
  tenantHooksSha256?: string;
  tenantHookPrePolicies: Map<string, string>;
  lifecycleSha256?: string;
  baseSystemPrompt: string;
  requestedModelRef: AgentDefinition["model"];
  initialUserItemId: string;
  /** Normal tool interruption does not cancel the already-authorized terminal observation. */
  lifecycleAbort: AbortController;
  interruptObservation?: Promise<void>;
  acceptedContextEpoch: string;
  tools: readonly RunnerTool[];
  taskExecutions: Map<string, Promise<ToolResult>>;
  /** Local facts from the real Store admission/COMMIT, not model message fields. */
  delegatedProviderDeniedStep?: number;
  delegatedProviderSettledStep?: number;
  delegation?: {
    access: SubagentMemberAccess;
    root: ActiveTurn;
    parent?: ActiveTurn;
    task?: SubagentTaskRecord;
    depth: number;
    policy: SubagentPolicy | null;
    deadlineAtMs: number;
    rootSpecification?: SubagentRootSpecification;
    /** The root owns the whole tree until every actual descendant run/observer has settled. */
    members: Set<ActiveTurn>;
    removeRootAbort?: () => void;
  };
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

interface DelegatedStart {
  root: ActiveTurn;
  parent: ActiveTurn;
  taskId: string;
  parentCall: ItemOf<"toolCall">;
  selected: Readonly<SelectedSubagentPolicy>;
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
  private readonly delegatedProviderBases = new WeakMap<ResolvedModel, ResolvedModel>();
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
      await this.assertOrdinaryControl({ tenantId: principal.tenantId, userId: targetUserId }, req.parentSessionId);
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
    const tenantHooksSha256 = await this.deps.tenantWebhooks?.resolve(owner, signal);
    const lifecycleSha256 = this.lifecycleVersion(owner);
    const epochHooksSha256 = this.epochHookVersion(hooksSha256, tenantHooksSha256, lifecycleSha256);
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
      contextEpoch: computeContextEpoch({ agentId: agent.id, agentVersion: agent.version, systemPrompt, tools, skills, hooksSha256: epochHooksSha256 }),
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
    session.lastSeq = r.lastSeq;
    if (lifecycleSha256 !== undefined) {
      // Creation is authoritative already. Observation cannot turn it into an ambiguous failed create.
      await this.serialiseSessionStart(session.id, async () => {
        if (this.draining || this.active.has(session.id) || this.holdTimers.has(session.id)
          || await this.deps.lease.getOwner(session.id)) return;
        const fresh = await this.deps.store.getSession(owner.tenantId, session.id);
        if (!fresh || fresh.userId !== owner.userId || fresh.status.type !== "idle") return;
        const acquired = await this.deps.lease.acquire(session.id, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
        if (!acquired.ok) return;
        const guard = this.startLeaseGuard(session.id);
        try {
          await this.claimSessionFence(fresh, acquired.fence, guard);
          const current = await this.deps.store.getSession(owner.tenantId, session.id);
          if (!current || current.userId !== owner.userId || current.status.type !== "idle" || this.active.has(session.id)) return;
          await this.observeLifecycleControlled(current, acquired.fence, guard, { owner, sessionId: session.id, phase: "SessionStart" });
          Object.assign(session, current);
        } finally {
          guard.stop();
          await this.deps.lease.release(session.id, this.deps.config.runnerId);
        }
      }).catch(() => { /* no crash-atomic observer delivery guarantee */ });
    }
    return { ...session };
  }

  private async resolveTools(principal: Principal, agent: AgentDefinition, signal: AbortSignal): Promise<RunnerTool[]> {
    const builtin = this.deps.tools.resolve(agent.tools);
    if (agent.subagents !== undefined && agent.tools.includes("task")) {
      if (!this.deps.subagents?.enabled) throw new ApiError("draining", "Subagents are unavailable.");
      if (builtin.some(tool => tool.name === "task")) throw new ApiError("invalid_request", "tool names collide");
      builtin.push({ ...createSubagentTaskDescriptor(),
        execute: (args, context) => this.executeSubagentTask(args, context),
      });
    }
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

  private lifecycleVersion(owner: Principal): string | undefined {
    if (!this.deps.lifecycleHooks?.enabled) return undefined;
    const version = this.deps.lifecycleHooks.version({ tenantId: owner.tenantId, userId: owner.userId });
    if (version !== undefined && !/^[a-f0-9]{64}$/.test(version)) throw new ApiError("invalid_request", "Lifecycle hooks are unavailable.");
    return version;
  }

  private epochHookVersion(operator: string | undefined, tenant: string | undefined, lifecycle: string | undefined): string | undefined {
    const previous = tenant ? sha256(stableStringify({ operator: operator ?? null, tenant })) : operator;
    return lifecycle ? sha256(stableStringify({ previous: previous ?? null, lifecycle })) : previous;
  }

  private lifecycleContext(state: ActiveTurn): { owner: Principal; sessionId: string; turnId: string } {
    return { owner: { tenantId: state.session.tenantId, userId: state.session.userId }, sessionId: state.session.id, turnId: state.turn.id };
  }

  private assertLifecycleOpen(state: ActiveTurn, terminal = false): void {
    state.leaseGuard.assertOwned();
    state.tenantRuntimeLease?.assertOpen();
    if (state.fenced || state.lifecycleAbort.signal.aborted) throw new ApiError("session_lease_conflict", "Lifecycle authority is unavailable.");
    if (!terminal) this.assertToolHooksOpen(state);
    if (this.lifecycleVersion({ tenantId: state.session.tenantId, userId: state.session.userId }) !== state.lifecycleSha256) {
      throw new ApiError("draining", "Lifecycle policy changed.");
    }
  }

  private lifecycleSignal(state: ActiveTurn, terminal = false): AbortSignal {
    return AbortSignal.any([terminal ? state.lifecycleAbort.signal : state.abort.signal,
      ...(state.tenantRuntimeLease ? [state.tenantRuntimeLease.signal] : [])]);
  }

  private lifecycleFields(context: LifecycleHookContext, configSha256: string, invocationId = randomUUID()) {
    return { sessionId: context.sessionId, invocationId, configSha256,
      ...(context.turnId ? { turnId: context.turnId } : {}), ...(context.itemId ? { itemId: context.itemId } : {}),
      ...(context.step ? { step: context.step } : {}),
      ...("throughSeq" in context ? { throughSeq: context.throughSeq } : {}),
      ...("toolCallId" in context ? { toolCallId: context.toolCallId } : {}),
      ...("approvalId" in context ? { approvalId: context.approvalId } : {}),
      ...("subagent" in context ? context.subagent : {}) };
  }

  private middlewareEvents(sessionId: string, configSha256: string | undefined, stage: "prompt" | "model" | "tool",
    reports: readonly LifecycleMiddlewareReport[], context: { turnId?: string; itemId?: string; step?: number }): EventInput[] {
    if (configSha256 === undefined || !reports.length) return [];
    return [{ type: "lifecycle-middleware/completed", sessionId, emittedAtMs: Date.now(), invocationId: randomUUID(),
      configSha256, stage, reports: [...reports], ...context }];
  }

  private async observeLifecycle(state: ActiveTurn, context: LifecycleHookContext, terminal = false): Promise<void> {
    if (state.lifecycleSha256 === undefined) return;
    this.assertLifecycleOpen(state, terminal);
    const fields = this.lifecycleFields(context, state.lifecycleSha256);
    await this.commit(state, { events: [{ ...fields, type: "lifecycle-hook/started", phase: context.phase, emittedAtMs: Date.now() }] }, undefined, !terminal);
    this.assertLifecycleOpen(state, terminal);
    // Only fixed pure packages run here. Authorization/T1/close/source errors are never observer fail-open.
    const reports = await this.deps.lifecycleHooks!.observe(context, this.lifecycleSignal(state, terminal));
    this.assertLifecycleOpen(state, terminal);
    await this.commit(state, { events: [{ ...fields, type: "lifecycle-hook/completed", phase: context.phase,
      emittedAtMs: Date.now(), reports: [...reports] }] }, undefined, !terminal);
  }

  private async observeLifecycleControlled(session: Session, fence: number, guard: LeaseGuard, context: LifecycleHookContext): Promise<void> {
    const version = this.lifecycleVersion(context.owner);
    if (version === undefined) return;
    const fields = this.lifecycleFields(context, version);
    const write = async (events: EventInput[]) => {
      guard.assertOwned();
      if (this.lifecycleVersion(context.owner) !== version) throw new ApiError("draining", "Lifecycle policy changed.");
      const result = await this.deps.store.commit({ sessionId: session.id, fence, events });
      session.lastSeq = result.lastSeq;
      await this.publishAll(session.id, result.events);
    };
    await write([{ ...fields, type: "lifecycle-hook/started", phase: context.phase, emittedAtMs: Date.now() }]);
    const reports = await this.deps.lifecycleHooks!.observe(context, guard.abort.signal);
    await write([{ ...fields, type: "lifecycle-hook/completed", phase: context.phase, emittedAtMs: Date.now(), reports: [...reports] }]);
  }

  private async assertOrdinaryControl(principal: Principal, sessionId: string): Promise<void> {
    if (await this.deps.store.getSubagentSessionMember({ principal: { ...principal }, sessionId })) {
      throw new ApiError("not_found", "session not found");
    }
  }

  private delegatedAuthority(state: ActiveTurn): SubagentAuthoritySnapshot {
    return { agentId: state.agent.id, agentVersion: state.agent.version, model: { ...state.requestedModelRef },
      toolNames: state.tools.map(tool => tool.name), ...subagentToolAuthority(state.tools, state.agent.approvalPolicy),
      approvalPolicy: "on-request", contextEpoch: state.acceptedContextEpoch };
  }

  private async reserveDelegatedTurn(state: ActiveTurn, start: DelegatedStart, first: Omit<CommitBatch, "sessionId" | "fence">): Promise<void> {
    const parent = start.parent, group = state.delegation!;
    const now = Date.now(); state.turn.seqStart = 2;
    const activity: ItemOf<"subagentActivity"> = { id: newId("item"), sessionId: parent.session.id, turnId: parent.turn.id,
      seq: 0, step: start.parentCall.step, status: "inProgress", createdAtMs: now, type: "subagentActivity",
      taskId: start.taskId, rootSessionId: start.root.session.id, rootTurnId: start.root.turn.id, parentCallItemId: start.parentCall.id,
      childSessionId: state.session.id, childTurnId: state.turn.id, agentId: state.agent.id, agentVersion: state.agent.version,
      depth: group.depth, taskStatus: "reserved" };
    const run = async () => {
      this.assertToolHooksOpen(parent); this.assertToolHooksOpen(start.root);
      const childBatch = attachSubagentCommitAdmission({ ...first, turn: state.turn, sessionId: state.session.id, fence: state.fence }, { access: group.access });
      const reserved = await this.deps.store.createSubagentTask({ access: parent.delegation!.access, taskId: start.taskId,
        parentCallItemId: start.parentCall.id, authority: this.delegatedAuthority(state), initialResolvedModel: { ...state.turn.model! }, limits: state.limits,
        selectedPolicy: group.policy, deadlineAtMs: group.deadlineAtMs, childSession: state.session, childBatch,
        parentActivityBatch: attachSubagentCommitAdmission({ sessionId: parent.session.id, fence: parent.fence, items: [activity],
          events: [{ type: "item/started", sessionId: parent.session.id, emittedAtMs: now, item: activity }] }, { access: parent.delegation!.access }) });
      if (reserved.replayed) throw new ApiError("state_conflict", "Subagent outcome must not be dispatched again.");
      Object.assign(state.session, reserved.childSession); Object.assign(state.turn, reserved.childTurn);
      group.task = reserved.task; group.members.add(state);
      parent.session.lastSeq = reserved.parentCommit.lastSeq; state.session.lastSeq = reserved.childCommit.lastSeq;
      await this.publishAll(parent.session.id, reserved.parentCommit.events);
      await this.publishAll(state.session.id, reserved.childCommit.events);
    };
    const work = parent.chain.then(run, run); parent.chain = work.catch(() => {});
    try { await work; } catch (error) { this.onCommitError(parent, error); throw error; }
  }

  private childLeaseGuard(root: ActiveTurn): LeaseGuard {
    const abort = new AbortController(); let listener: (() => void) | undefined;
    return { abort, loss: root.leaseGuard.loss, get lost() { return root.leaseGuard.lost; },
      wait: work => root.leaseGuard.wait(work), assertOwned: () => {
        root.leaseGuard.assertOwned(); if (root.fenced) throw new FenceError(root.session.id, root.fence, root.fence);
      },
      attach: callback => { listener = callback; if (root.leaseGuard.lost) callback();
        else void root.leaseGuard.loss.then(() => { abort.abort(); listener?.(); }); },
      // Only the root may stop renewal or release its shared lease.
      stop: () => { listener = undefined; },
    };
  }

  private executeSubagentTask(args: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    const parent = this.active.get(context.sessionId), call = parent?.toolCallItems.get(context.toolCallId);
    if (!parent || !call || call.name !== "task" || call.startedAtMs === undefined || !parent.delegation
      || parent.session.tenantId !== context.principal.tenantId || parent.session.userId !== context.principal.userId
      || parent.turn.id !== context.turnId || stableStringify(args) !== stableStringify(call.args)) {
      return Promise.reject(new ApiError("invalid_request", "Subagent task is unavailable."));
    }
    const existing = parent.taskExecutions.get(call.id);
    if (existing) return existing;
    const promise = this.runSubagentTask(parent, call, args);
    parent.taskExecutions.set(call.id, promise);
    return promise;
  }

  private async runSubagentTask(parent: ActiveTurn, call: ItemOf<"toolCall">, args: unknown): Promise<ToolResult> {
    const root = parent.delegation!.root, config = this.deps.subagents;
    let child: ActiveTurn | undefined;
    try {
      this.assertToolHooksOpen(parent); this.assertToolHooksOpen(root);
      if (!config?.enabled || !parent.delegation!.policy) throw new ApiError("invalid_request", "Subagent task is not permitted.");
      const parsed = SubagentTaskInput.safeParse(args);
      if (!parsed.success) throw new ApiError("invalid_request", "Subagent task is not permitted.");
      await this.deps.authorizeRuntimeExtensions?.(this.toolHookSignal(parent));
      this.assertToolHooksOpen(parent); this.assertToolHooksOpen(root);
      const principal = { tenantId: parent.session.tenantId, userId: parent.session.userId };
      const target = resolveSubagentTarget({ principal, rootAgent: root.agent, parentAgent: parent.agent,
        ...(parent !== root ? { parentPolicy: parent.delegation!.policy } : {}), target: parsed.data.target });
      const targetAgent = await this.deps.store.getAgent(principal.tenantId, target.agentId, target.agentVersion);
      if (!targetAgent) throw new ApiError("not_found", "Subagent task is not permitted.");
      const sourceTools = await this.resolveTools(principal, targetAgent, this.toolHookSignal(parent));
      for (const tool of parent.tools) if (tool.kind === "dynamic" && targetAgent.tools.includes(tool.name)
        && !sourceTools.some(current => current.name === tool.name)) sourceTools.push(tool);
      const skills = await this.listSkills(principal, targetAgent, this.toolHookSignal(parent));
      this.mountSkillTool(principal, targetAgent, skills, sourceTools, { remainingTokens: 0, contexts: new Map() });
      const selected = selectSubagentPolicy({ principal, rootAgent: root.agent, parentAgent: parent.agent,
        ...(parent !== root ? { parentPolicy: parent.delegation!.policy } : {}), targetAgent, task: parsed.data,
        parentTools: parent.tools, childTools: sourceTools, rootLimits: root.limits, parentLimits: parent.limits,
        runnerCeilings: { maxDepth: config.maxDepth, maxConcurrent: config.maxConcurrent, maxTasks: config.maxTasks },
        parentDepth: parent.delegation!.depth,
        rootDeadlineAtMs: Math.min(parent.delegation!.deadlineAtMs, root.delegation!.deadlineAtMs, parent.startedAt + parent.limits.maxWallClockMs), nowMs: Date.now() });
      const agent: AgentDefinition = { ...targetAgent, approvalPolicy: selected.approvalPolicy,
        ...(selected.selectedPolicy ? { subagents: selected.selectedPolicy } : { subagents: undefined }) };
      const now = Date.now(), taskId = newId("sat");
      const session: Session = { id: newId("sess"), tenantId: principal.tenantId, userId: principal.userId,
        agentId: agent.id, agentVersion: agent.version, parentSessionId: parent.session.id, status: { type: "idle" }, lastSeq: 0,
        contextEpoch: "reserved-subagent", fenceToken: 0, usage: emptyUsageAccumulator(), autoApprovedTools: [],
        createdAtMs: now, updatedAtMs: now, metadata: {} };
      const runtime = this.deps.tenantRuntime?.enter(principal.tenantId, "turn"); let transferred = false;
      let begun: BegunTurn;
      try {
        begun = await this.beginTurnInner(principal, session, agent, { input: [...selected.input], stream: false, metadata: {}, limits: selected.limits },
          [...selected.input], {}, root.fence, this.childLeaseGuard(root), runtime, () => { transferred = true; }, { root, parent, taskId, parentCall: call, selected });
      } finally { if (!transferred) runtime?.release(); }
      child = this.active.get(session.id);
      if (!child?.delegation?.task) throw new ApiError("internal_error", "Subagent reservation is unavailable.");
      await this.observeDelegatedLifecycle(root.delegation!.access, "SubagentStart", { taskId, childSessionId: session.id, childTurnId: child.turn.id });
      await this.observeDelegatedLifecycle(root.delegation!.access, "SessionStart", { taskId, childSessionId: session.id, childTurnId: child.turn.id });
      begun.run(); await child.done;
      const turn = await this.deps.store.getTurn(session.id, child.turn.id);
      const status = turn?.status ?? "unknown";
      return { content: [{ type: "text", text: JSON.stringify({ taskId, childSessionId: session.id, childTurnId: child.turn.id,
        status, text: child.lastText || "" }) }], isError: !turn || turn.status !== "completed" };
    } catch (error) {
      if (!child && (error instanceof SubagentPolicyError || error instanceof ApiError && (error.code === "invalid_request" || error.code === "not_found"))) {
        return { content: [{ type: "text", text: "Subagent task is not permitted." }], isError: true };
      }
      if (child && child.phase !== "finished") {
        child.closingRequested = true; child.abort.abort(); this.failPendingApprovals(child, "cancel");
        if (!child.run) await this.finishTurn(child, { steps: child.step, aborted: true });
        await child.done;
      }
      // No raw Store/provider failure can become tool text. Ambiguous persistence is a hard stop,
      // not an invitation to re-run a child on another provider or runner.
      parent.stopReason = "error"; parent.closingRequested = true; parent.abort.abort();
      throw new ApiError("invalid_request", "Subagent task is unavailable.");
    }
  }

  private async completeDelegatedTurn(state: ActiveTurn, childBatch: CommitBatch): Promise<CommitResult> {
    const group = state.delegation!, parent = group.parent!, task = group.task!;
    const run = async () => {
      parent.leaseGuard.assertOwned(); parent.tenantRuntimeLease?.assertOpen();
      const original = await this.deps.store.getItem(parent.session.id, task.activityItemId);
      if (!original || original.type !== "subagentActivity" || original.taskId !== task.taskId
        || original.childSessionId !== state.session.id || original.childTurnId !== state.turn.id) throw new ApiError("internal_error", "Subagent activity is unavailable.");
      const now = Date.now(), status = state.turn.status === "completed" ? "completed" : state.turn.status === "interrupted" ? "interrupted" : "failed";
      const activity: ItemOf<"subagentActivity"> = { ...original, status: status === "completed" ? "completed" : "failed",
        taskStatus: status, childUsage: structuredClone(state.turn.usage), completedAtMs: now };
      const result = await this.deps.store.completeSubagentTask({ access: group.access, childBatch,
        parentActivityBatch: attachSubagentCommitAdmission({ sessionId: parent.session.id, fence: parent.fence, items: [activity],
          events: [{ type: "item/completed", sessionId: parent.session.id, emittedAtMs: now, item: activity }] }, { access: parent.delegation!.access }) });
      group.task = result.task; parent.session.lastSeq = result.parentCommit.lastSeq;
      await this.publishAll(parent.session.id, result.parentCommit.events);
      return result.childCommit;
    };
    const work = parent.chain.then(run, run); parent.chain = work.catch(() => {}); return work;
  }

  private scheduleTurnDeadline(state: ActiveTurn, deadlineAtMs: number): void {
    clearTimeout(state.wallClockTimer);
    state.wallClockTimer = setTimeout(() => {
      state.limitHit = "max_wall_clock";
      const wasReserved = state.phase === "reserved";
      void (async () => {
        // Preserve admitted steers before closing the same canonical turn. Tightening never
        // starts a new duration, and a reserved child has no engine to finish it for us.
        await this.settleAdmittedSteers(state);
        if (state.phase === "finished") return;
        state.phase = "finishing";
        state.abort.abort();
        if (wasReserved) await this.finishTurn(state, { steps: 0, aborted: true });
      })().catch((err) => this.log.error(`[session ${state.session.id}] wall-clock cleanup failed`, err));
    }, Math.max(0, deadlineAtMs - Date.now()));
  }

  private tightenDelegatedBudget(state: ActiveTurn, record: SubagentRootRecord): void {
    const root = state.delegation!.root;
    const subtreeLimits = { ...state.limits };
    const subtreeDeadline = Math.min(state.delegation!.deadlineAtMs, state.startedAt + state.limits.maxWallClockMs);
    for (const member of [root, ...root.delegation!.members]) {
      member.limits = mergeLimits(member.limits, record.effectiveLimits);
      member.delegation!.deadlineAtMs = Math.min(member.delegation!.deadlineAtMs, record.effectiveDeadlineAtMs);
      let ancestor: ActiveTurn | undefined = member;
      while (ancestor && ancestor !== state) ancestor = ancestor.delegation?.parent;
      if (ancestor === state) {
        member.limits = mergeLimits(member.limits, subtreeLimits);
        member.delegation!.deadlineAtMs = Math.min(member.delegation!.deadlineAtMs, subtreeDeadline);
      }
      if (member.wallClockTimer !== undefined && member.phase !== "finished") this.scheduleTurnDeadline(member,
        Math.min(member.delegation!.deadlineAtMs, member.startedAt + member.limits.maxWallClockMs));
    }
  }

  private async admitDelegatedProvider(state: ActiveTurn, model: ResolvedModel): Promise<void> {
    if (!state.delegation) return;
    this.assertToolHooksOpen(state);
    const decision = await this.deps.store.admitSubagentBudget({ access: state.delegation.access, kind: "provider_step", step: state.step,
      provider: { provider: model.provider, model: model.model, lifecycleSha256: state.lifecycleSha256 ?? null, contextEpoch: state.acceptedContextEpoch },
      effectiveLimits: { ...state.limits }, effectiveDeadlineAtMs: Math.min(state.delegation.deadlineAtMs, state.startedAt + state.limits.maxWallClockMs) });
    this.assertToolHooksOpen(state);
    this.tightenDelegatedBudget(state, decision.root);
    if (!decision.admitted || decision.replayed) {
      state.delegatedProviderDeniedStep = state.step;
      state.limitHit = decision.reason ?? "error"; state.closingRequested = true;
      throw new ApiError("invalid_request", "Subagent family provider budget is unavailable.");
    }
  }

  private async prepareDelegatedProvider(state: ActiveTurn, resolved: ResolvedModel, beforeAdmission?: () => void): Promise<ResolvedModel> {
    const model = this.delegatedProviderBases.get(resolved) ?? resolved;
    if (!state.delegation || !model.createRequest) {
      if (!model.createRequest) beforeAdmission?.();
      await this.admitDelegatedProvider(state, model);
      if (!model.createRequest || !beforeAdmission) return model;
      const create = model.createRequest;
      const wrapped: ResolvedModel = { ...model, createRequest: (beforeDispatch) => create.call(model, async () => {
        beforeAdmission();
        await beforeDispatch?.();
      }) };
      this.delegatedProviderBases.set(wrapped, model);
      return wrapped;
    }
    const create = model.createRequest;
    // Quota denial must not create a paid/unknown family reservation for a request that was never
    // dispatched. The trusted provider invokes this only after quota/fleet admission, before I/O.
    const wrapped: ResolvedModel = { ...model, createRequest: (beforeDispatch) => create.call(model, async () => {
      beforeAdmission?.();
      await this.admitDelegatedProvider(state, model);
      await beforeDispatch?.();
    }) };
    this.delegatedProviderBases.set(wrapped, model);
    return wrapped;
  }

  private delegatedStatus(task: SubagentTaskRecord): SubagentTaskStatusResponse {
    return { taskId: task.taskId, rootSessionId: task.rootSessionId, rootTurnId: task.rootTurnId,
      parentSessionId: task.parentSessionId, parentTurnId: task.parentTurnId, parentCallItemId: task.parentCallItemId,
      childSessionId: task.childSessionId, childTurnId: task.childTurnId, status: task.status, depth: task.depth,
      createdAtMs: task.createdAtMs, ...(task.completedAtMs === null ? {} : { completedAtMs: task.completedAtMs }), childUsage: task.childUsage };
  }

  private async delegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<SubagentTaskRecord> {
    if (!this.deps.subagents?.enabled) throw new ApiError("draining", "Subagents are unavailable.");
    await this.assertOrdinaryControl(principal, rootSessionId);
    await this.getSession(principal, rootSessionId);
    const task = await this.deps.store.getSubagentTask({ principal: { ...principal }, rootSessionId, taskId });
    if (!task) throw new ApiError("not_found", "Subagent task not found.");
    return task;
  }

  async listDelegatedTasks(principal: Principal, rootSessionId: string, rootTurnId: string): Promise<SubagentTaskStatusResponse[]> {
    if (!this.deps.subagents?.enabled) throw new ApiError("draining", "Subagents are unavailable.");
    await this.assertOrdinaryControl(principal, rootSessionId); await this.getSession(principal, rootSessionId);
    const tasks = await this.deps.store.listSubagentTasks({ principal: { ...principal }, rootSessionId, rootTurnId });
    if (tasks.length > 64) throw new ApiError("invalid_request", "Subagent task list is unavailable.");
    return tasks.map(task => this.delegatedStatus(task));
  }

  async getDelegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<SubagentTaskStatusResponse> {
    return this.delegatedStatus(await this.delegatedTask(principal, rootSessionId, taskId));
  }

  private async activeDelegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<{ task: SubagentTaskRecord; root: ActiveTurn; child: ActiveTurn }> {
    const task = await this.delegatedTask(principal, rootSessionId, taskId), root = this.active.get(rootSessionId), child = this.active.get(task.childSessionId);
    if (!root || root.turn.id !== task.rootTurnId || root.fence !== task.rootFence || !child
      || child.turn.id !== task.childTurnId || child.delegation?.root !== root || child.delegation.task?.taskId !== taskId) {
      throw new ApiError("session_lease_conflict", "Subagent task is owned by another runner", await this.ownerDetails(rootSessionId));
    }
    this.assertToolHooksOpen(root); child.leaseGuard.assertOwned(); child.tenantRuntimeLease?.assertOpen();
    return { task, root, child };
  }

  async resolveDelegatedApproval(principal: Principal, rootSessionId: string, taskId: string, approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    const { child } = await this.activeDelegatedTask(principal, rootSessionId, taskId);
    const approval = await this.deps.store.getApproval(child.session.id, approvalId);
    if (!approval || approval.turnId !== child.turn.id) throw new ApiError("not_found", "approval not found");
    child.leaseGuard.assertOwned();
    return this.resolveApprovalInternal(principal, child.session.id, approvalId, decision);
  }

  async submitDelegatedToolResult(principal: Principal, rootSessionId: string, taskId: string, toolCallId: string,
    result: { content: { type: "text"; text: string }[]; isError?: boolean }): Promise<void> {
    const { child } = await this.activeDelegatedTask(principal, rootSessionId, taskId), call = child.toolCallItems.get(toolCallId);
    if (!call || call.kind !== "dynamic" || call.startedAtMs === undefined || call.status !== "inProgress"
      || !this.dynamicTools.resolve(child.session.id, toolCallId, { content: result.content, isError: result.isError ?? false })) {
      throw new ApiError("not_found", "no pending dynamic tool call with that id on this runner");
    }
  }

  async interruptDelegatedTask(principal: Principal, rootSessionId: string, taskId: string): Promise<Turn> {
    const task = await this.delegatedTask(principal, rootSessionId, taskId);
    const turn = await this.deps.store.getTurn(task.childSessionId, task.childTurnId);
    if (turn && turn.status !== "inProgress") return turn;
    const { child } = await this.activeDelegatedTask(principal, rootSessionId, taskId);
    const terminal = await this.interruptInternal(principal, child.session.id, child.turn.id);
    if (terminal.status === "inProgress") {
      // The bounded control response is not proof that cancellation or persistence settled.
      // Keep the real child/root I/O and lease ownership intact until their normal finalizers run.
      throw new ApiError(child.fenced ? "session_lease_conflict" : "session_busy", "Subagent cancellation is still settling.");
    }
    return terminal;
  }

  async deleteDelegatedSession(principal: Principal, rootSessionId: string, taskId: string): Promise<void> {
    await this.serialiseSessionStart(rootSessionId, async () => {
      let task = await this.delegatedTask(principal, rootSessionId, taskId);
      const root = await this.getSession(principal, rootSessionId);
      if (this.active.has(rootSessionId) || root.status.type === "active") throw new ApiError("session_busy", "cannot delete a child while its root is active");
      this.clearHold(rootSessionId);
      const acquired = await this.deps.lease.acquire(rootSessionId, this.deps.config.runnerId, this.deps.config.runnerAddr, this.cfg.leaseTtlMs);
      if (!acquired.ok) throw new ApiError("session_lease_conflict", "root session owned by another runner", { ownerId: acquired.ownerId, ownerAddr: acquired.ownerAddr });
      const guard = this.startLeaseGuard(rootSessionId);
      try {
        await this.claimSessionFence(root, acquired.fence, guard);
        task = await this.delegatedTask(principal, rootSessionId, taskId);
        if (["reserved", "running"].includes(task.status) || this.active.has(task.childSessionId)) throw new ApiError("session_busy", "cannot delete while a child turn is active");
        const lifecycle = await this.deps.store.getSessionLifecycle(principal.tenantId, principal.userId, task.childSessionId);
        if (!lifecycle) throw new ApiError("not_found", "session not found");
        if (lifecycle.deletedAtMs !== undefined) {
          await this.deps.store.sealOrdinarySessionDeleteGrace(principal.tenantId, principal.userId, task.childSessionId); return;
        }
        if (lifecycle.session.status.type === "active") throw new ApiError("session_busy", "cannot delete while a child turn is active");
        const pending = await this.deps.store.listApprovals(task.childSessionId, { pendingOnly: true }), now = Date.now();
        const approvals: Approval[] = pending.map(approval => ({ ...approval, status: "expired", decision: "cancel", decidedBy: "system:delete", resolvedAtMs: now }));
        const originals = await Promise.all(pending.map(approval => this.deps.store.getItem(task.childSessionId, approval.itemId)));
        const items: Item[] = originals.flatMap(item => item?.type === "approvalRequest" && item.status === "inProgress"
          ? [{ ...item, status: "declined" as const, completedAtMs: now }] : []);
        const events: EventInput[] = approvals.flatMap(approval => [{ type: "approval/resolved" as const, sessionId: task.childSessionId, emittedAtMs: now, approval }]);
        for (const item of items) events.push({ type: "item/completed", sessionId: task.childSessionId, emittedAtMs: now, item });
        const generation = lifecycle.deletionGeneration + 1;
        events.push({ type: "session/deleted", sessionId: task.childSessionId, emittedAtMs: now, deletionGeneration: generation });
        guard.assertOwned();
        const committed = await this.deps.store.deleteSubagentTaskSession({
          access: createSubagentRootAccess({ principal: { ...principal }, rootSessionId, rootTurnId: task.rootTurnId, rootFence: acquired.fence }), taskId,
          batch: { sessionId: task.childSessionId, fence: acquired.fence,
            lifecycle: { type: "tombstone", atMs: now, purgeAfterMs: null, deletionGeneration: generation, tenantId: principal.tenantId, userId: principal.userId },
            approvals, items, events, sessionPatch: { autoApprovedTools: [] } },
        });
        try { await this.deps.store.sealOrdinarySessionDeleteGrace(principal.tenantId, principal.userId, task.childSessionId); }
        finally { await this.publishAll(task.childSessionId, committed.events); }
      } catch (error) {
        if (error instanceof SessionHasChildrenError) throw new ApiError("session_has_children", "delete child sessions before deleting their parent");
        if (error instanceof SessionLifecycleBusyError) throw new ApiError("session_busy", "cannot delete while a turn is active");
        throw await this.translateSessionLeaseFailure(rootSessionId, guard.lost ?? error);
      } finally { guard.stop(); await this.deps.lease.release(rootSessionId, this.deps.config.runnerId).catch(() => {}); }
    });
  }

  /** Internal producer boundary: only a real Store-reserved task may call this with its original access. */
  async observeDelegatedLifecycle(access: SubagentMemberAccess, phase: "SessionStart" | "SubagentStart" | "SubagentStop",
    task: { taskId: string; childSessionId: string; childTurnId: string }): Promise<void> {
    const member = assertSubagentMemberAccess(access);
    const state = this.active.get(member.rootSessionId);
    if (!state || state.turn.id !== member.rootTurnId || state.fence !== member.rootFence
      || state.session.tenantId !== member.principal.tenantId || state.session.userId !== member.principal.userId) {
      throw new ApiError("session_lease_conflict", "Delegated lifecycle authority is unavailable.");
    }
    const stored = await this.deps.store.getSubagentTask({ principal: member.principal, rootSessionId: member.rootSessionId, taskId: task.taskId });
    if (!stored || stored.childSessionId !== task.childSessionId || stored.childTurnId !== task.childTurnId
      || stored.rootTurnId !== member.rootTurnId || stored.rootFence !== member.rootFence) throw new ApiError("not_found", "Subagent task not found.");
    if (phase === "SessionStart") {
      // The child is created atomically under root authority; never acquire an independent child lease.
      if (state.lifecycleSha256 === undefined) return;
      const childAccess = createSubagentChildAccess(access, task);
      const context: LifecycleHookContext = { owner: { ...member.principal }, sessionId: task.childSessionId, phase: "SessionStart" };
      const fields = this.lifecycleFields(context, state.lifecycleSha256);
      const write = async (events: EventInput[]) => {
        this.assertLifecycleOpen(state);
        const batch = attachSubagentCommitAdmission({ sessionId: task.childSessionId, fence: state.fence, events }, { access: childAccess });
        const committed = await this.deps.store.commit(batch);
        await this.publishAll(task.childSessionId, committed.events);
      };
      await write([{ ...fields, type: "lifecycle-hook/started", phase, emittedAtMs: Date.now() }]);
      const reports = await this.deps.lifecycleHooks!.observe(context, this.lifecycleSignal(state));
      await write([{ ...fields, type: "lifecycle-hook/completed", phase, emittedAtMs: Date.now(), reports: [...reports] }]);
    } else {
      await this.observeLifecycle(state, { ...this.lifecycleContext(state), phase, subagent: { ...task } }, phase === "SubagentStop");
    }
  }

  /** Only text may be introduced by prompt middleware; attachment/skill authority remains original. */
  private validateEffectiveInput(original: InputPart[], value: readonly InputPart[]): ExecutableInputPart[] {
    const parsed = InputPartSchema.array().max(256).safeParse(value);
    if (!parsed.success || Buffer.byteLength(stableStringify(parsed.data)) > 262_144
      || stableStringify(original.filter(part => part.type !== "text")) !== stableStringify(parsed.data.filter(part => part.type !== "text"))) {
      throw new ApiError("invalid_request", "Lifecycle input is unavailable.");
    }
    return executableInput(parsed.data, this.cfg.blobAttachmentsEnabled, !!this.deps.skills?.load && this.deps.skills.enabled !== false);
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

  private async tenantHookSource(state: ActiveTurn, callItemId: string) {
    this.assertToolHooksOpen(state);
    let source: Awaited<ReturnType<RegisteredTenantWebhookService["readSource"]>>;
    try {
      source = await this.deps.tenantWebhooks!.readSource(
        { tenantId: state.session.tenantId, userId: state.session.userId },
        { sessionId: state.session.id, turnId: state.turn.id, callItemId, fence: state.fence }, this.toolHookSignal(state));
    } catch (error) { this.onCommitError(state, error); throw error; }
    this.assertToolHooksOpen(state); return source;
  }
  private tenantHookProjectionEvents(state: ActiveTurn, plan: TenantWebhookMilestonePlan): EventInput[] {
    return plan.projectionFailed ? [{ type: "warning", sessionId: state.session.id, emittedAtMs: Date.now(),
      code: "tenant_hook_not_dispatched", message: "A tenant observer payload exceeded its projection budget and was not dispatched." }] : [];
  }
  private async commitTenantHookReports(state: ActiveTurn, reports: readonly TenantWebhookDispatchReport[]) {
    this.assertToolHooksOpen(state);
    if (reports.length) await this.commit(state, { events: reports.map(report => ({ type: "tenant-hook/completed" as const,
      sessionId: state.session.id, turnId: state.turn.id, emittedAtMs: Date.now(), ...report })) }, undefined, true);
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
    await this.assertOrdinaryControl(principal, sessionId);
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
    // Projection-only clones select the accepted text while preserving original durable disclosure
    // sources in the Store. Materializing both copies would double-charge one attachment budget.
    const selected = items.map(item => item.type === "userMessage" && item.effectiveContent !== undefined
      ? { ...item, content: item.effectiveContent, effectiveContent: undefined } : item);
    const carriesBlob = selected.some((item) => (
      (item.type === "toolResult" && item.outputRef !== undefined)
      || (item.type === "userMessage" && item.content.some((part) => part.type === "image"))
    ));
    if (!carriesBlob) return selected;
    if (!this.deps.blobs) throw new BlobDataError("this runner cannot hydrate blob-backed history");
    return this.deps.blobs.materializeReadyHistory(principal, sessionId, selected, hydrationBudget);
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
    await this.assertOrdinaryControl(principal, sessionId);
    return this.serialiseSessionStart(sessionId, () => this.setArchiveStateLocked(principal, sessionId, true));
  }

  /** Unarchive uses the same lease/fence path so it cannot race another owner or a new turn. */
  async unarchiveSession(principal: Principal, sessionId: string): Promise<Session> {
    await this.assertOrdinaryControl(principal, sessionId);
    return this.serialiseSessionStart(sessionId, () => this.setArchiveStateLocked(principal, sessionId, false));
  }

  /**
   * DELETE is an irreversible-to-the-user, fenced lifecycle transition. It deliberately only records
   * a tombstone and an outbox intent: physical erasure remains disabled until retention, legal-hold
   * and billing policies have been explicitly configured.
   */
  async deleteSession(principal: Principal, sessionId: string): Promise<void> {
    await this.assertOrdinaryControl(principal, sessionId);
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
      // A gated managed child is deliberately hidden by the membership getter. The ordinary
      // write guard still rejects it; keep that rejection indistinguishable from a hidden session.
      if (failure instanceof SubagentManagedSessionError) {
        throw new ApiError("not_found", "session not found");
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
    await this.assertOrdinaryControl(principal, sessionId);
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
    delegated?: DelegatedStart,
  ): Promise<BegunTurn> {
    const sessionId = session.id;
    const turnId = newId("turn"), userItemId = newId("item");

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
    let tools: RunnerTool[] = [
      ...await leaseGuard.wait(this.resolveTools(principal, agent, extensionSignal)),
      ...(req.dynamicTools ?? []).map((d) => this.dynamicTools.asTool(d, this.cfg.dynamicToolTimeoutMs)),
    ];
    if (delegated) for (const tool of delegated.parent.tools) {
      if (tool.kind === "dynamic" && agent.tools.includes(tool.name) && !tools.some(current => current.name === tool.name)) tools.push(tool);
    }
    const skillResolution = turnSkillResolution(req);
    const skills = await leaseGuard.wait(this.listSkills(principal, agent, extensionSignal, skillResolution));
    const skillBudget: SkillBudget = { remainingTokens: 0, contexts: new Map() };
    this.mountSkillTool(principal, agent, skills, tools, skillBudget, skillResolution);
    if (delegated) {
      const current = subagentToolAuthority(tools, agent.approvalPolicy).toolContractSha256ByName;
      tools = delegated.selected.tools.filter(tool => tool.name !== "task" || delegated.selected.selectedPolicy !== null).map(tool => {
        if (current[tool.name] !== delegated.selected.toolContractSha256ByName[tool.name]) throw new ApiError("draining", "Subagent tool catalog changed.");
        return { ...tool, execute: tools.find(currentTool => currentTool.name === tool.name)!.execute };
      });
    }
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new ApiError("invalid_request", "tool names collide");
    }
    this.assertSkillDependencies(skills, tools.map(tool => tool.name));
    runtimeLease?.assertOpen();
    const systemPrompt = buildSystemPrompt(agent, skills, !!this.deps.skills?.load);
    const limits = mergeLimits(agent.limits, req.limits,
      delegated ? delegated.selected.limits : this.deps.subagents?.enabled && agent.tools.includes("task") ? agent.subagents?.limits : undefined);
    const hooksSha256 = this.toolHooksVersion(principal);
    const tenantHooksSha256 = await this.deps.tenantWebhooks?.resolve(principal, extensionSignal);
    const lifecycleSha256 = this.lifecycleVersion(principal);
    let promptReports: readonly LifecycleMiddlewareReport[] = [];
    let effectiveInput = input;
    if (lifecycleSha256 !== undefined) {
      await this.deps.authorizeRuntimeExtensions?.(extensionSignal);
      leaseGuard.assertOwned(); runtimeLease?.assertOpen();
      const decision = await this.deps.lifecycleHooks!.beforePrompt({ owner: { ...principal }, sessionId, turnId, itemId: userItemId }, { input: req.input }, extensionSignal);
      leaseGuard.assertOwned(); runtimeLease?.assertOpen();
      if (extensionSignal.aborted) throw new ApiError("draining", "Lifecycle request is unavailable.");
      if (!decision.allow) throw new ApiError("invalid_request", "Prompt blocked by lifecycle policy.");
      effectiveInput = this.validateEffectiveInput(req.input, decision.input);
      promptReports = decision.reports;
    }
    const epochHooksSha256 = this.epochHookVersion(hooksSha256, tenantHooksSha256, lifecycleSha256);
    const hasMcp = agent.mcpServers.length > 0 || (agent.mcpRegistrations?.length ?? 0) > 0;
    const hasExtensions = delegated !== undefined || hasMcp || agent.skills.length > 0 || hooksSha256 !== undefined || tenantHooksSha256 !== undefined || lifecycleSha256 !== undefined;
    const contextEpoch = hasExtensions
      ? computeContextEpoch({ agentId: agent.id, agentVersion: agent.version, systemPrompt, tools, skills, hooksSha256: epochHooksSha256 })
      : session.contextEpoch;
    if (delegated) session.contextEpoch = contextEpoch; // initial unpublished draft, not a catalog change
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
    const persistedItems = delegated ? [] : await leaseGuard.wait(this.deps.store.listItems(sessionId, { afterSeq: projectFromSeq(session), limit: MAX_PROJECTED_ITEMS, newestFirst: true }));
    const snapshotItems = await this.hydrateSkillSnapshotItems(principal, sessionId, persistedItems, leaseGuard);
    this.reserveSkillContexts(skillBudget, collectResolvedSkillContexts(snapshotItems));
    runtimeLease?.assertOpen();
    const resolvedInput = await leaseGuard.wait(this.resolveSkillInput(principal, agent, skills,
      tools.map(tool => tool.name), effectiveInput, extensionSignal, skillBudget, skillResolution));
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
      id: turnId,
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
    const userItem: Item = { id: userItemId, sessionId, turnId: turn.id, seq: 0, status: "completed", createdAtMs: now, completedAtMs: now, type: "userMessage", content: req.input,
      ...(stableStringify(effectiveInput) !== stableStringify(req.input) ? { effectiveContent: effectiveInput } : {}),
      ...(resolvedInput.skillContexts.length ? { skillContexts: resolvedInput.skillContexts } : {}) };
    const catalogMessage = hooksSha256 !== undefined || tenantHooksSha256 !== undefined || lifecycleSha256 !== undefined ? "Tool policy or catalog changed; current tool policies apply before every execution."
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
      mcpProgressStarted: new Set(), mcpProgressChannels: new Map(),
      skills, skillResolution, toolNames: tools.map(tool => tool.name), skillBudget, hooksSha256, tenantHooksSha256, tenantHookPrePolicies: new Map(),
      lifecycleSha256, baseSystemPrompt: systemPrompt, requestedModelRef: modelRef, initialUserItemId: userItemId, lifecycleAbort: new AbortController(),
      acceptedContextEpoch: contextEpoch, tools, taskExecutions: new Map(),
      startedAt: now, done: Promise.resolve(), resolveDone: () => {}, chain: Promise.resolve(),
      agentItem: undefined, agentItemStarted: undefined, deltaChain: undefined,
      phase: "reserved", closingRequested: false, steerChain: Promise.resolve(), pendingSteers: [],
      tenantRuntimeLease: runtimeLease,
    };
    if (delegated) {
      const group = delegated.root.delegation;
      if (!group) throw new ApiError("invalid_request", "Subagent root is unavailable.");
      state.delegation = { root: delegated.root, parent: delegated.parent,
        access: createSubagentChildAccess(group.access, { taskId: delegated.taskId, childSessionId: session.id, childTurnId: turn.id }),
        depth: delegated.selected.depth, policy: delegated.selected.selectedPolicy, deadlineAtMs: delegated.selected.deadlineAtMs, members: group.members };
      const ancestorSignal = AbortSignal.any([delegated.root.abort.signal, delegated.parent.abort.signal]);
      const onRootAbort = () => {
        state.closingRequested = true; state.abort.abort(); this.failPendingApprovals(state, "cancel");
        if (state.phase === "reserved" && state.delegation?.task) void this.finishTurn(state, { steps: state.step, aborted: true }).catch(() => {});
      };
      ancestorSignal.addEventListener("abort", onRootAbort, { once: true });
      state.delegation.removeRootAbort = () => ancestorSignal.removeEventListener("abort", onRootAbort);
      if (ancestorSignal.aborted) onRootAbort();
    } else if (this.deps.subagents?.enabled && agent.subagents && tools.some(tool => tool.name === "task")) {
      const policy = { ...agent.subagents, maxDepth: Math.min(agent.subagents.maxDepth, this.deps.subagents.maxDepth),
        maxConcurrent: Math.min(agent.subagents.maxConcurrent, this.deps.subagents.maxConcurrent), maxTasks: Math.min(agent.subagents.maxTasks, this.deps.subagents.maxTasks) };
      const specification: SubagentRootSpecification = { policy, limits, deadlineAtMs: now + limits.maxWallClockMs,
        initialResolvedModel: { provider: model.provider, model: model.model },
        authority: { agentId: agent.id, agentVersion: agent.version, model: modelRef, toolNames: tools.map(tool => tool.name),
          ...subagentToolAuthority(tools, agent.approvalPolicy), approvalPolicy: "on-request", contextEpoch } };
      state.delegation = { root: state, access: createSubagentRootAccess({ principal: { ...principal }, rootSessionId: session.id, rootTurnId: turn.id, rootFence: fence }),
        depth: 0, policy, deadlineAtMs: specification.deadlineAtMs, rootSpecification: specification, members: new Set() };
    }
    state.done = new Promise((r) => (state.resolveDone = r));
    // Preflight contains provider/store/summariser awaits, during which drain() may observe no active
    // turn and finish. This final synchronous check + registration closes that race: after the check,
    // drain cannot run until `active` contains this state.
    if (this.draining) throw new ApiError("draining", "runner is draining");
    runtimeLease?.assertOpen();
    leaseGuard.attach(() => {
      const wasReserved = state.phase === "reserved";
      state.fenced = true;
      state.lifecycleAbort.abort();
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
        state.lifecycleAbort.abort();
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
      const firstBatch = {
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
          ...this.middlewareEvents(sessionId, lifecycleSha256, "prompt", promptReports, { turnId, itemId: userItemId }),
          ...(catalogNotice ? [
            { type: "item/completed" as const, sessionId, emittedAtMs: now, item: catalogNotice },
            { type: "warning" as const, sessionId, emittedAtMs: now, code: hooksSha256 !== undefined || tenantHooksSha256 !== undefined ? "hook_policy_changed" : agent.skills.length ? "skill_catalog_changed" : "mcp_catalog_changed", message: catalogMessage },
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
      } satisfies Omit<CommitBatch, "sessionId" | "fence">;
      if (delegated) await this.reserveDelegatedTurn(state, delegated, firstBatch);
      else await this.commit(state, firstBatch);
      state.session.contextEpoch = contextEpoch;
      runtimeLease?.assertOpen();
      leaseGuard.assertOwned();
    } catch (err) {
      this.active.delete(sessionId);
      state.delegation?.removeRootAbort?.();
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
    this.scheduleTurnDeadline(state, Math.min(now + limits.maxWallClockMs, state.delegation?.deadlineAtMs ?? Number.POSITIVE_INFINITY));

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
      await this.observeLifecycle(state, { ...this.lifecycleContext(state), phase: "UserPromptSubmit", itemId: state.initialUserItemId, submission: "initial" });
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

  private closeMcpProgressPublisher(channel: McpProgressChannel): Promise<void> {
    if (!channel.closePromise) {
      // This capability closes only its owned connection and settles actual local I/O, including
      // on failure. Observations may fail; neither their errors nor their payload become results.
      try { channel.closePromise = channel.publisher.close().catch(() => {}); }
      catch { channel.closePromise = Promise.resolve(); }
    }
    return channel.closePromise;
  }

  private cancelMcpProgress(channel: McpProgressChannel): void {
    channel.accepting = false;
    channel.closed = true;
    channel.abort.abort();
    void this.closeMcpProgressPublisher(channel);
  }

  private async closeMcpProgress(state: ActiveTurn, itemId?: string, discard = false): Promise<void> {
    const channels = [...state.mcpProgressChannels].filter(([id]) => itemId === undefined || id === itemId);
    for (const [, channel] of channels) {
      channel.accepting = false;
      if (discard) this.cancelMcpProgress(channel);
      else if (!channel.drainTimer && !channel.closePromise) {
        // One non-resetting result-boundary budget, not a fresh 2s for each queued frame.
        // Expiry cancels real owned I/O; the original tail/close still have to settle below.
        channel.drainTimer = setTimeout(() => this.cancelMcpProgress(channel), 2_000);
      }
    }
    await Promise.all(channels.map(([, channel]) => channel.tail));
    await Promise.all(channels.map(([, channel]) => this.closeMcpProgressPublisher(channel)));
    for (const [id, channel] of channels) {
      clearTimeout(channel.drainTimer);
      channel.removeAbortListener();
      channel.closed = true;
      if (state.mcpProgressChannels.get(id) === channel) state.mcpProgressChannels.delete(id);
      state.mcpProgressStarted.delete(id);
    }
    if (itemId !== undefined) state.mcpProgressStarted.delete(itemId);
    else state.mcpProgressStarted.clear();
  }

  private makeMcpProgressReporter(
    principal: Principal, state: ActiveTurn, tool: RunnerTool | undefined,
    toolCallId: string, toolName: string, signal: AbortSignal,
  ): ((progress: McpToolProgress) => void) | undefined {
    // A legacy bus's unbounded publish cannot safely participate before canonical COMMIT.
    if (!this.deps.bus.openMcpProgressPublisher) return undefined;
    const call = state.toolCallItems.get(toolCallId);
    if (!call || tool?.kind !== "mcp" || tool.name !== toolName || call.name !== toolName
      || call.kind !== "mcp" || call.step === undefined || call.startedAtMs === undefined
      || !state.mcpProgressStarted.has(call.id)) return undefined;
    // Capture the real invocation now. Looking it up only when a notification arrives would
    // misattribute an old callback when a model reuses toolCallId in a later step.
    const itemId = call.id, step = call.step, sessionId = state.session.id, turnId = state.turn.id;
    const tenantId = principal.tenantId, userId = principal.userId, fence = state.fence;
    const invocationCurrent = () => {
      if (signal.aborted || state.abort.signal.aborted || state.fenced || state.closingRequested
        || state.phase === "finishing" || state.phase === "finished" || state.turn.status !== "inProgress"
        || this.active.get(sessionId) !== state || state.fence !== fence || state.step !== step
        || state.session.tenantId !== tenantId || state.session.userId !== userId
        || state.toolCallItems.get(toolCallId) !== call || call.id !== itemId || call.name !== toolName
        || call.status !== "inProgress" || !state.mcpProgressStarted.has(itemId)) return false;
      try { state.leaseGuard.assertOwned(); state.tenantRuntimeLease?.assertOpen(); return true; }
      catch { return false; }
    };
    if (!invocationCurrent()) return undefined;
    const previous = state.mcpProgressChannels.get(itemId);
    if (previous) return previous.accepting && !previous.closed ? previous.report : undefined;
    const abort = new AbortController();
    const publisherSignal = AbortSignal.any([signal, state.abort.signal, abort.signal,
      ...(state.tenantRuntimeLease ? [state.tenantRuntimeLease.signal] : [])]);
    let publisher: McpProgressPublisher;
    try { publisher = this.deps.bus.openMcpProgressPublisher(sessionId, { signal: publisherSignal, timeoutMs: 2_000 }); }
    catch { return undefined; }
    const channel: McpProgressChannel = {
      accepting: true, closed: false, accepted: 0, pending: 0, lastProgress: -Infinity, tail: Promise.resolve(),
      publisher, abort, removeAbortListener: () => {}, report: () => {},
    };
    const cancel = () => this.cancelMcpProgress(channel);
    publisherSignal.addEventListener("abort", cancel, { once: true });
    channel.removeAbortListener = () => publisherSignal.removeEventListener("abort", cancel);
    state.mcpProgressChannels.set(itemId, channel);
    if (publisherSignal.aborted) { cancel(); return undefined; }
    const current = () => !channel.closed && !publisherSignal.aborted && invocationCurrent();
    channel.report = (progress) => {
      try {
        if (!channel.accepting || !current() || channel.accepted >= 64 || channel.pending >= 16) return;
        const parsed = McpToolProgress.safeParse(progress);
        if (!parsed.success || parsed.data.progress <= channel.lastProgress) return;
        const value = Object.freeze({ ...parsed.data });
        channel.accepted += 1; channel.pending += 1; channel.lastProgress = value.progress;
        channel.tail = channel.tail.then(async () => {
          if (!current()) return;
          await channel.publisher.publish({
            type: "item/mcpToolCall/progress", sessionId, emittedAtMs: Date.now(), turnId,
            itemId, toolCallId, ...value,
          });
        }).catch(() => { this.cancelMcpProgress(channel); })
          .finally(() => { channel.pending -= 1; });
      } catch { /* Invalid/hostile progress values are observations, never tool results or logs. */ }
    };
    return channel.report;
  }

  private makeSink(principal: Principal, state: ActiveTurn, tools: RunnerTool[]): EngineSink {
    const sessionId = state.session.id;
    const turnId = state.turn.id;
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const live = (e: Event) => void this.deps.bus.publish(sessionId, e).catch(() => {});
    const resultWork = new Map<string, { identity: string | undefined; promise: Promise<EngineToolResult> }>();
    // This fence is per semantic step, not per turn. Completed tools in an earlier step must not
    // block the next step's key selection; any current-step output/effect or budget entry does.
    let fallbackClosed = false, fallbackInFlight = false, fallbackCount = 0, fallbackEpoch = 0;
    const closeFallback = () => { fallbackClosed = true; };
    const prepareCandidate = (model: ResolvedModel) => this.prepareDelegatedProvider(state, model,
      this.deps.providers.resolveFallback ? closeFallback : undefined);
    const persistResultOnce = async (r: EngineToolResult, prepared?: PreparedToolOutput): Promise<EngineToolResult> => {
      const call = state.toolCallItems.get(r.toolCallId);
      if (call) await this.closeMcpProgress(state, call.id);
      const now = Date.now();
      const durable = await this.durableToolResult(principal, state, r, now, prepared);
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
      let tenantPlan: TenantWebhookMilestonePlan | undefined;
      if (this.deps.tenantWebhooks && tool && call?.startedAtMs !== undefined && call.name === r.name) {
        const source = await this.tenantHookSource(state, call.id);
        const payload = { content: durable.canonical.content, ...(durable.canonical.details !== undefined ? { details: durable.canonical.details } : {}) };
        const serialized = JSON.stringify(payload);
        tenantPlan = this.deps.tenantWebhooks.prepare(source, "post", { itemId: durable.item.id, isError: durable.canonical.isError,
          payload, payloadSha256: sha256(serialized), payloadBytes: Buffer.byteLength(serialized) });
        events.push(...this.tenantHookProjectionEvents(state, tenantPlan));
      }
      const committed = await this.commit(state, {
        items, events, blobBindings: durable.blobBindings,
        ...(revoke || resume ? { sessionPatch: { autoApprovedTools: [...nextGrants] } } : {}),
      }, undefined, tenantPlan !== undefined, tenantPlan);
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
      if (tenantPlan) {
        const reports = await this.deps.tenantWebhooks!.dispatch(committed.tenantWebhookIntents ?? [], this.toolHookSignal(state), tenantPlan.deadlineAt);
        await this.commitTenantHookReports(state, reports);
      }
      if (tool && call?.startedAtMs !== undefined && call.name === r.name) await this.observeLifecycle(state, {
        ...this.lifecycleContext(state), phase: "PostToolUse", itemId: call.id, toolCallId: call.toolCallId,
        tool: { name: tool.name, kind: tool.kind, readOnly: tool.readOnly === true }, isError: durable.canonical.isError,
      });
      return durable.canonical;
    };
    const persistToolResult = async (r: EngineToolResult): Promise<EngineToolResult> => {
      if (state.hooksSha256 === undefined && !this.deps.tenantWebhooks && state.lifecycleSha256 === undefined) return persistResultOnce(r);
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
      ...(state.lifecycleSha256 === undefined && !this.deps.authorizeRuntimeExtensions && !state.delegation ? {} : { prepareModelStep: async (request: EngineModelStep): Promise<EngineModelStep> => {
        if (state.lifecycleSha256 === undefined) {
          this.assertToolHooksOpen(state);
          await this.deps.authorizeRuntimeExtensions?.(this.toolHookSignal(state));
          this.assertToolHooksOpen(state);
          const model = await prepareCandidate(request.model);
          return { ...request, model, maxOutputTokens: Math.min(request.maxOutputTokens ?? state.limits.maxOutputTokensPerStep, state.limits.maxOutputTokensPerStep) };
        }
        this.assertLifecycleOpen(state);
        if (request.step !== state.step || request.step < 1) throw new ApiError("invalid_request", "Model step is unavailable.");
        const decision = await this.deps.lifecycleHooks!.beforeModelStep({ ...this.lifecycleContext(state), step: state.step }, {
          step: state.step, modelRef: structuredClone(state.requestedModelRef), systemPrompt: state.baseSystemPrompt,
          input: request.messages, limits: { ...state.limits },
        }, this.lifecycleSignal(state));
        this.assertLifecycleOpen(state);
        if (!decision.allow) throw new ApiError("invalid_request", "Model blocked by lifecycle policy.");
        const ref = ModelRefSchema.safeParse(decision.modelRef), checkedLimits = LimitsSchema.strict().safeParse(decision.limits);
        if (!ref.success || !checkedLimits.success || Object.keys(checkedLimits.data).length !== 5
          || stableStringify(decision.input) !== stableStringify(request.messages)
          || typeof decision.systemPrompt !== "string" || Buffer.byteLength(decision.systemPrompt) > 262_144) {
          throw new ApiError("invalid_request", "Model middleware output is unavailable.");
        }
        const limits = mergeLimits(state.limits, checkedLimits.data);
        if (state.step > limits.maxSteps || state.toolCalls > limits.maxToolCalls
          || Date.now() - state.startedAt >= limits.maxWallClockMs
          || state.turn.usage.costCNY !== undefined && state.turn.usage.costCNY >= limits.maxCostCNY) {
          state.limitHit = state.step > limits.maxSteps ? "max_steps" : state.toolCalls > limits.maxToolCalls ? "max_tool_calls"
            : Date.now() - state.startedAt >= limits.maxWallClockMs ? "max_wall_clock" : "max_cost";
          throw new ApiError("invalid_request", "Model budget exhausted.");
        }
        const model = await this.deps.providers.resolve({ ...principal }, ref.data);
        this.assertLifecycleOpen(state);
        await this.deps.authorizeRuntimeExtensions?.(this.lifecycleSignal(state));
        this.assertLifecycleOpen(state);
        if (request.messages.some(message => message.role === "user" && message.content.some(part => part.type === "image")) && !model.input.includes("image")) {
          throw new ApiError("invalid_request", "Model input is unavailable.");
        }
        const budget = Math.floor(model.contextWindow * this.cfg.contextBudgetRatio);
        if (estimateTokens(decision.systemPrompt) + transcriptTokens(request.messages) > budget) throw new ApiError("invalid_request", "Model context budget exceeded.");
        state.limits = limits;
        state.modelInput = model.input;
        // Tightening the wall clock never resets elapsed time or grants a new turn budget.
        this.scheduleTurnDeadline(state, Math.min(state.startedAt + limits.maxWallClockMs, state.delegation?.deadlineAtMs ?? Number.POSITIVE_INFINITY));
        state.turn.model = { provider: model.provider, model: model.model };
        await this.commit(state, { turn: state.turn, events: this.middlewareEvents(state.session.id, state.lifecycleSha256,
          "model", decision.reports, { turnId: state.turn.id, step: state.step }) }, undefined, true);
        const admittedModel = await prepareCandidate(model);
        return { ...request, model: admittedModel, systemPrompt: decision.systemPrompt, maxOutputTokens: state.limits.maxOutputTokensPerStep };
      } }),
      ...(this.deps.providers.resolveFallback ? { prepareFallbackModelStep: async (request: EngineModelStep,
        failedRequest: ProviderModelRequest): Promise<EngineModelStep | undefined> => {
        if (fallbackClosed || fallbackInFlight || fallbackCount >= 3 || request.step !== state.step
          || request.step < 1 || failedRequest.wasDispatched()) return undefined;
        const epoch = fallbackEpoch, step = request.step, maxOutputTokens = request.maxOutputTokens;
        const messages = structuredClone(request.messages), messagesIdentity = stableStringify(messages);
        const initialSystemPrompt = request.systemPrompt;
        const assertSelectionOpen = () => {
          if (fallbackClosed || epoch !== fallbackEpoch || step !== state.step) {
            throw new ApiError("draining", "Provider admission is unavailable.");
          }
        };
        fallbackInFlight = true;
        fallbackCount += 1;
        try {
          this.assertToolHooksOpen(state);
          await this.deps.authorizeRuntimeExtensions?.(this.toolHookSignal(state));
          this.assertToolHooksOpen(state);
          const model = await this.deps.providers.resolveFallback!({ ...principal }, failedRequest);
          this.assertToolHooksOpen(state);
          if (!model) return undefined;
          assertSelectionOpen();
          let systemPrompt = initialSystemPrompt;
          let limits = state.limits;
          let reports: readonly LifecycleMiddlewareReport[] | undefined;
          if (state.lifecycleSha256 !== undefined) {
            this.assertLifecycleOpen(state);
            const canonical = ModelRefSchema.safeParse(model.canonicalRef);
            if (!canonical.success) throw new ApiError("invalid_request", "Model fallback is unavailable.");
            const decision = await this.deps.lifecycleHooks!.beforeModelStep({ ...this.lifecycleContext(state), step: state.step }, {
              step: state.step, modelRef: canonical.data, systemPrompt,
              input: structuredClone(messages), limits: { ...state.limits },
            }, this.lifecycleSignal(state));
            this.assertLifecycleOpen(state);
            const ref = ModelRefSchema.safeParse(decision.modelRef), checked = LimitsSchema.strict().safeParse(decision.limits);
            if (!decision.allow || !ref.success || stableStringify(ref.data) !== stableStringify(canonical.data)
              || !checked.success || Object.keys(checked.data).length !== 5
              || stableStringify(decision.input) !== messagesIdentity
              || typeof decision.systemPrompt !== "string" || Buffer.byteLength(decision.systemPrompt) > 262_144) {
              throw new ApiError("invalid_request", "Model fallback middleware output is unavailable.");
            }
            limits = mergeLimits(state.limits, checked.data);
            systemPrompt = decision.systemPrompt;
            reports = decision.reports;
          }
          assertSelectionOpen();
          if (state.step > limits.maxSteps || state.toolCalls > limits.maxToolCalls
            || Date.now() - state.startedAt >= limits.maxWallClockMs
            || state.turn.usage.costCNY !== undefined && state.turn.usage.costCNY >= limits.maxCostCNY) {
            throw new ApiError("invalid_request", "Model budget exhausted.");
          }
          if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0
            || model.maxOutputTokens !== undefined && (!Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0)
            || messages.some(message => message.role === "user" && message.content.some(part => part.type === "image"))
              && !model.input.includes("image")) throw new ApiError("invalid_request", "Model input is unavailable.");
          if (estimateTokens(systemPrompt) + transcriptTokens(messages) > Math.floor(model.contextWindow * this.cfg.contextBudgetRatio)) {
            throw new ApiError("invalid_request", "Model context budget exceeded.");
          }
          await this.deps.authorizeRuntimeExtensions?.(this.toolHookSignal(state));
          this.assertToolHooksOpen(state);
          assertSelectionOpen();
          state.limits = limits;
          state.modelInput = model.input;
          this.scheduleTurnDeadline(state, Math.min(state.startedAt + limits.maxWallClockMs,
            state.delegation?.deadlineAtMs ?? Number.POSITIVE_INFINITY));
          state.turn.model = { provider: model.provider, model: model.model };
          if (reports) await this.commit(state, { turn: state.turn, events: this.middlewareEvents(state.session.id,
            state.lifecycleSha256!, "model", reports, { turnId: state.turn.id, step: state.step }) }, undefined, true);
          this.assertToolHooksOpen(state);
          assertSelectionOpen();
          const prepared = await prepareCandidate(model);
          assertSelectionOpen();
          return { ...request, step, messages, model: prepared, systemPrompt,
            maxOutputTokens: Math.min(maxOutputTokens ?? limits.maxOutputTokensPerStep,
              limits.maxOutputTokensPerStep, model.maxOutputTokens ?? limits.maxOutputTokensPerStep) };
        } finally { if (epoch === fallbackEpoch) fallbackInFlight = false; }
      } } : {}),
      onStepStart: (step) => {
        fallbackEpoch += 1;
        fallbackClosed = false; fallbackInFlight = false; fallbackCount = 0;
        // Synchronous fence first; onAssistantMessage drains any old in-flight publication before
        // it can commit the next step. Already captured reporters never acquire the new call.
        for (const channel of state.mcpProgressChannels.values()) this.cancelMcpProgress(channel);
        state.mcpProgressStarted.clear();
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
        closeFallback();
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
        closeFallback();
        if (!state.reasoningItemId) state.reasoningItemId = newId("item");
        state.reasoningText += delta;
        live({ type: "item/reasoning/delta", sessionId, turnId, itemId: state.reasoningItemId, delta, emittedAtMs: Date.now() });
      },
      onToolArgsDelta: (toolCallId, delta) => {
        closeFallback();
        // Pure tool-call steps have no agentMessage item, so this must not depend on one.
        if (!toolCallId) return;
        live({ type: "item/toolCall/argsDelta", sessionId, turnId, toolCallId, delta, emittedAtMs: Date.now() });
      },

      onAssistantMessage: async (msg) => {
        closeFallback();
        if (state.mcpProgressChannels.size) await this.closeMcpProgress(state, undefined, true);
        // Official Pi also emits an assistant error/abort when prepareRequest or a later tool
        // listener throws. A known denied dispatch has no provider usage to settle; after an
        // interrupted, already committed step this callback cannot charge that reservation twice.
        // Only these local admission/COMMIT facts qualify, never an untrusted zero-usage field.
        if (state.delegation && (msg.stopReason === "error" || msg.stopReason === "aborted")
          && (state.delegatedProviderDeniedStep === state.step
            || state.delegatedProviderSettledStep === state.step && (state.abort.signal.aborted || state.closingRequested))) return;
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
        if (state.delegation) state.delegatedProviderSettledStep = state.step;
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

      beforeToolCall: async (call, msg) => { closeFallback(); return this.gateToolCall(principal, state, toolByName.get(call.name), call, msg); },

      // pi emits tool_execution_start BEFORE the approval gate, so the write-ahead marker is set in
      // gateToolCall once the call is actually allowed to run. Otherwise a crash while waiting for
      // approval would be reported to the model as TOOL_OUTCOME_UNKNOWN ("may have happened") for a
      // tool that never ran.
      onToolExecutionStart: () => { closeFallback(); },
      onToolProgress: () => {},
      createMcpProgressReporter: (toolCallId, toolName, signal) =>
        this.makeMcpProgressReporter(principal, state, toolByName.get(toolName), toolCallId, toolName, signal),
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
    let effectiveArgs = call.args;
    let rewritten = false;
    const gateDecision = (decision: BeforeToolCallDecision): BeforeToolCallDecision => rewritten ? { ...decision, effectiveArgs: structuredClone(effectiveArgs) } : decision;
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
    if (state.delegation) {
      if (!item) throw new ApiError("internal_error", "tool write-ahead is missing");
      this.assertToolHooksOpen(state);
      const admitted = await this.deps.store.admitSubagentBudget({ access: state.delegation.access, kind: "tool_call", step: state.step, callItemId: item.id,
        effectiveLimits: { ...state.limits }, effectiveDeadlineAtMs: Math.min(state.delegation.deadlineAtMs, state.startedAt + state.limits.maxWallClockMs) });
      this.assertToolHooksOpen(state);
      this.tightenDelegatedBudget(state, admitted.root);
      if (!admitted.admitted || admitted.replayed) {
        state.limitHit = admitted.reason ?? "error";
        return { allow: false, reason: "Subagent family tool budget is unavailable.", interrupt: true };
      }
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
    if (state.lifecycleSha256 !== undefined) {
      if (!item) throw new ApiError("internal_error", "tool write-ahead is missing");
      this.assertLifecycleOpen(state);
      const context = { ...this.lifecycleContext(state), phase: "PreToolUse" as const, itemId: item.id,
        toolCallId: call.id, tool: { name: tool.name, kind: tool.kind, readOnly: tool.readOnly === true } };
      const decision = await this.deps.lifecycleHooks!.beforeTool(context, { args: structuredClone(call.args) }, this.lifecycleSignal(state));
      this.assertLifecycleOpen(state);
      if (!decision.allow) {
        await this.commit(state, { events: this.middlewareEvents(state.session.id, state.lifecycleSha256, "tool", decision.reports,
          { turnId: state.turn.id, itemId: item.id, step: state.step }) }, undefined, true);
        return { allow: false, reason: "Tool blocked by lifecycle policy." };
      }
      try {
        const raw = JSON.stringify(decision.args);
        if (raw === undefined || Buffer.byteLength(raw) > 65_536) throw new Error();
        const validated = validateToolArguments({ name: tool.name, description: tool.description,
          parameters: Type.Unsafe(tool.parameters) }, { type: "toolCall", id: call.id, name: call.name, arguments: JSON.parse(raw) });
        const canonical = JSON.stringify(validated);
        if (canonical === undefined || Buffer.byteLength(canonical) > 65_536) throw new Error();
        effectiveArgs = JSON.parse(canonical);
      } catch { return { allow: false, reason: "Tool middleware arguments are invalid." }; }
      rewritten = stableStringify(effectiveArgs) !== stableStringify(call.args);
      const events = this.middlewareEvents(state.session.id, state.lifecycleSha256, "tool", decision.reports,
        { turnId: state.turn.id, itemId: item.id, step: state.step });
      if (rewritten) {
        item.originalArgs = structuredClone(call.args);
        item.args = structuredClone(effectiveArgs);
        item.parametersPolicySha256 = state.lifecycleSha256;
        events.push({ type: "item/toolCall/parametersChanged", sessionId: state.session.id, turnId: state.turn.id,
          emittedAtMs: Date.now(), itemId: item.id, toolCallId: call.id, item, configSha256: state.lifecycleSha256,
          originalArgsSha256: sha256(stableStringify(call.args)), effectiveArgsSha256: sha256(stableStringify(effectiveArgs)) });
      }
      await this.commit(state, { ...(rewritten ? { items: [item] } : {}), events }, undefined, true);
      await this.observeLifecycle(state, context);
    }
    if (this.deps.tenantWebhooks) {
      if (!item) throw new ApiError("internal_error", "tool write-ahead is missing");
      const source = await this.tenantHookSource(state, item.id);
      const versions = source.value.registrations.filter(registration => registration.slot.state === "enabled"
        && registration.version?.config.phase === "preToolUse").map(registration => [registration.version!.configVersionId, registration.slot.revision]).sort();
      state.tenantHookPrePolicies.set(item.id, sha256(stableStringify(versions)));
      const plan = this.deps.tenantWebhooks.prepare(source, "pre");
      const committed = await this.commit(state, { events: this.tenantHookProjectionEvents(state, plan) }, undefined, true, plan);
      const reports = await this.deps.tenantWebhooks.dispatch(committed.tenantWebhookIntents ?? [], this.toolHookSignal(state), plan.deadlineAt);
      await this.commitTenantHookReports(state, reports);
    }
    const markStarted = async () => {
      if (state.hooksSha256 !== undefined || this.deps.tenantWebhooks || state.lifecycleSha256 !== undefined) this.assertToolHooksOpen(state);
      if (state.lifecycleSha256 !== undefined) this.assertLifecycleOpen(state);
      if (!item) {
        if (tool.kind === "mcp") throw new ApiError("internal_error", "remote tool write-ahead is missing");
        return;
      }
      let tenantPlan: TenantWebhookMilestonePlan | undefined;
      if (this.deps.tenantWebhooks) {
        const source = await this.tenantHookSource(state, item.id);
        const versions = source.value.registrations.filter(registration => registration.slot.state === "enabled"
          && registration.version?.config.phase === "preToolUse").map(registration => [registration.version!.configVersionId, registration.slot.revision]).sort();
        if (state.tenantHookPrePolicies.get(item.id) !== sha256(stableStringify(versions))) throw new ApiError("draining", "Tenant hook policy changed before tool execution.");
        tenantPlan = this.deps.tenantWebhooks.prepare(source, "started");
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
        ...(tenantPlan ? { events: this.tenantHookProjectionEvents(state, tenantPlan) } : {}),
        ...(suspend ? { sessionPatch: { autoApprovedTools: [...state.autoApproved] } } : {}),
      }, undefined, state.hooksSha256 !== undefined || tenantPlan !== undefined || state.lifecycleSha256 !== undefined, tenantPlan);
      if (tool.kind === "mcp") state.mcpProgressStarted.add(item.id);
      if (suspend) state.mcpGrantResumptions.set(call.id, scope);
      if (state.hooksSha256 !== undefined || tenantPlan) this.assertToolHooksOpen(state);
    };
    const policy = state.agent.approvalPolicy;
    const needs = tool.mandatoryApproval === true
      || (policy === "never" ? false : policy === "untrusted" ? !tool.readOnly : !!tool.needsApproval);
    const approvalScope = tool.approvalScope ?? tool.name;
    if (!needs || state.autoApproved.has(approvalScope)) {
      await markStarted();
      return gateDecision({ allow: true });
    }

    const now = Date.now();
    const approvalItemId = newId("item");
    const approval: Approval = {
      id: newId("apr"), sessionId: state.session.id, turnId: state.turn.id, itemId: approvalItemId,
      status: "pending", toolCallId: call.id, toolName: call.name, args: effectiveArgs,
      reason: msg.text || undefined,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      createdAtMs: now, expiresAtMs: now + this.cfg.approvalTtlMs,
    };
    const reqItem: Item = { id: approvalItemId, sessionId: state.session.id, turnId: state.turn.id, seq: 0, step: state.step, status: "inProgress", createdAtMs: now, type: "approvalRequest", approvalId: approval.id, toolCallId: call.id, name: call.name, args: effectiveArgs };
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

    const resolutionPromise = new Promise<{ decision: ApprovalDecision; timedOut: boolean }>((resolve) => {
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
    if (item) await this.observeLifecycle(state, { ...this.lifecycleContext(state), phase: "PermissionRequest", itemId: item.id,
      toolCallId: call.id, tool: { name: tool.name, kind: tool.kind, readOnly: tool.readOnly === true }, approvalId: approval.id });
    const resolution = await resolutionPromise;
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
      return gateDecision({ allow: true });
    }
    if (item) item.status = "declined";
    if (decision === "cancel") {
      state.stopReason = "interrupted";
      state.closingRequested = true;
      await state.steerChain;
      return gateDecision({ allow: false, reason: "declined by user; turn interrupted", interrupt: true });
    }
    return gateDecision({ allow: false, reason: expired ? "approval expired" : "declined by user" });
  }

  /** Where a session is actually running, so a 409 can tell the router where to retry. */
  private async ownerDetails(sessionId: string): Promise<{ ownerId?: string; ownerAddr?: string }> {
    const owner = await this.deps.lease.getOwner(sessionId).catch(() => null);
    return owner ? { ownerId: owner.ownerId, ownerAddr: owner.ownerAddr } : {};
  }

  async resolveApproval(principal: Principal, sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<Approval> {
    await this.assertOrdinaryControl(principal, sessionId);
    return this.resolveApprovalInternal(principal, sessionId, approvalId, decision);
  }

  private async resolveApprovalInternal(principal: Principal, sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<Approval> {
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
    await this.assertOrdinaryControl(principal, sessionId);
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
      const itemId = newId("item");
      let effectiveInput = input;
      let promptReports: readonly LifecycleMiddlewareReport[] = [];
      if (state.lifecycleSha256 !== undefined) {
        this.assertLifecycleOpen(state);
        await this.deps.authorizeRuntimeExtensions?.(this.lifecycleSignal(state));
        this.assertLifecycleOpen(state);
        const decision = await this.deps.lifecycleHooks!.beforePrompt({ ...this.lifecycleContext(state), itemId },
          { input: originalInput }, this.lifecycleSignal(state));
        this.assertLifecycleOpen(state);
        if (!decision.allow) throw new ApiError("invalid_request", "Prompt blocked by lifecycle policy.");
        effectiveInput = this.validateEffectiveInput(originalInput, decision.input);
        promptReports = decision.reports;
      }
      const resolved = await state.leaseGuard.wait(this.resolveSkillInput(
        { tenantId: state.session.tenantId, userId: state.session.userId }, state.agent, state.skills,
        state.toolNames, effectiveInput, AbortSignal.any([state.abort.signal,
          ...(state.tenantRuntimeLease ? [state.tenantRuntimeLease.signal] : [])]), state.skillBudget, state.skillResolution));
      const skillTokens = resolved.input.reduce((total, part) => total + (part.type === "text" ? estimateTokens(part.text) : 0), 0);
      if (resolved.skillContexts.length && skillTokens > state.skillBudget.remainingTokens) throw new ApiError("invalid_request", "Skill context budget exceeded.");
      if (resolved.skillContexts.length) state.skillBudget.remainingTokens -= skillTokens;
      const item: Item = {
        id: itemId, sessionId, turnId, seq: 0, step: state.step, status: "completed",
        createdAtMs: now, completedAtMs: now, type: "userMessage", content: originalInput,
        ...(stableStringify(effectiveInput) !== stableStringify(originalInput) ? { effectiveContent: effectiveInput } : {}),
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
            ...this.middlewareEvents(sessionId, state.lifecycleSha256, "prompt", promptReports, { turnId, itemId }),
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
      await this.observeLifecycle(state, { ...this.lifecycleContext(state), phase: "UserPromptSubmit", itemId: item.id, submission: "steer" });
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
    await this.assertOrdinaryControl(principal, sessionId);
    return this.interruptInternal(principal, sessionId, turnId);
  }

  private async interruptInternal(principal: Principal, sessionId: string, turnId: string): Promise<Turn> {
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
    if (!state.interruptObservation && state.lifecycleSha256 !== undefined && !state.fenced) {
      state.interruptObservation = this.observeLifecycle(state, { ...this.lifecycleContext(state), phase: "Interrupt" }, true);
      void state.interruptObservation.catch(() => {});
    }
    if (wasReserved) void this.finishTurn(state, { steps: 0, aborted: true }).catch((err) => this.log.error(`[session ${sessionId}] pre-run interrupt cleanup failed`, err));
    await Promise.race([state.done, new Promise((r) => setTimeout(r, 10_000))]);
    return (await this.deps.store.getTurn(sessionId, turnId)) ?? state.turn;
  }

  /** Async twin of submitDynamicToolResult that reports the owner when this runner is not it. */
  async submitDynamicToolResultOrThrow(principal: Principal, sessionId: string, toolCallId: string, result: { content: { type: "text"; text: string }[]; isError: boolean }): Promise<void> {
    await this.assertOrdinaryControl(principal, sessionId);
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
    if (!this.active.has(sessionId) || this.active.get(sessionId)?.delegation?.parent) return false;
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
    let surfaceLastSeq = session.lastSeq;
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
    if (this.lifecycleVersion(principal) !== undefined) {
      if (!leaseGuard) throw new ApiError("session_lease_conflict", "Compaction authority is unavailable.");
      await this.observeLifecycleControlled(session, fence, leaseGuard, { owner: { ...principal }, sessionId: session.id,
        phase: "PreCompact", throughSeq: plan.keepFromSeq - 1 });
      surfaceLastSeq = session.lastSeq;
    }
    let summary: Awaited<ReturnType<Summariser["summarise"]>>;
    const summarisationStartedAtMs = Date.now();
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
    } catch (error) {
      if (leaseGuard?.lost) throw leaseGuard.lost;
      const attempted = takePiSummariserFailure(error, model);
      if (attempted) {
        leaseGuard?.assertOwned();
        const now = Date.now(), turnId = newId("turn"), usage = { ...attempted.usage };
        const failure = publicEngineFailure("provider_error");
        const started: Turn = { id: turnId, sessionId: session.id, status: "inProgress", seqStart: surfaceLastSeq + 1,
          steps: 0, toolCalls: 0, usage: emptyUsageAccumulator(), startedAtMs: summarisationStartedAtMs,
          model: { provider: attempted.provider, model: attempted.model } };
        const failed: Turn = { ...started, status: "failed", stopReason: "error", usage, error: failure, completedAtMs: now };
        const sessionUsage = addUsage(session.usage, usage);
        // A failed compaction has no summary/item/watermark. Its real terminal turn closes every
        // event and usage owner relation for export/erasure while the ledger and billing fact commit
        // atomically. Never replay this paid attempt or retry an ambiguous accounting COMMIT.
        const committed = await this.deps.store.commit({ sessionId: session.id, fence, expectedLastSeq: surfaceLastSeq,
          turn: failed,
          events: [
            { type: "turn/started", sessionId: session.id, emittedAtMs: summarisationStartedAtMs, turn: started },
            { type: "usage/updated", sessionId: session.id, emittedAtMs: now, turnId, step: 0,
              stepUsage: usage, turnUsage: usage, sessionUsage, runtime: { provider: attempted.provider, model: attempted.model } },
            { type: "error", sessionId: session.id, emittedAtMs: now, turnId, ...failure },
            { type: "turn/completed", sessionId: session.id, emittedAtMs: now, turn: failed, stopReason: "error" },
          ],
          usageEntries: [{ usageId: newUsageId(), turnId, step: 0, provider: attempted.provider, model: attempted.model,
            usage, createdAtMs: now }], sessionPatch: { usage: sessionUsage },
        });
        session.lastSeq = committed.lastSeq; session.usage = sessionUsage;
        await this.publishAll(session.id, committed.events);
        throw new ApiError(failure.code, failure.message, undefined, true);
      }
      // Compaction is an optimisation: if the summariser fails, carry on with the pruned transcript.
      // Admission errors are policy outcomes, not optional upstream failures. Preserve only the
      // closed server-owned code/message; no raw provider error or cause crosses this boundary.
      if (error instanceof ApiError && ["quota_exceeded", "draining", "subject_deleting"].includes(error.code)) {
        const failure = publicEngineFailure(error.code);
        throw new ApiError(failure.code, failure.message, undefined, true);
      }
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
    if (leaseGuard) await this.observeLifecycleControlled(session, fence, leaseGuard, { owner: { ...principal }, sessionId: session.id,
      phase: "PostCompact", throughSeq: plan.keepFromSeq - 1 });
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
    await this.assertOrdinaryControl(principal, sessionId);
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
    if (state.delegation) {
      // Root terminal admission remains closed until every actual descendant execution and its
      // canonical result/observer work has settled. There is no independent child lease to expire.
      if (state.abort.signal.aborted || state.fenced || result.error) {
        for (const child of state.delegation.members) {
          let ancestor = child.delegation?.parent;
          while (ancestor && ancestor !== state) ancestor = ancestor.delegation?.parent;
          if (ancestor !== state) continue;
          child.closingRequested = true; child.abort.abort(); this.failPendingApprovals(child, "cancel");
          if (child.phase === "reserved" && child.delegation?.task) void this.finishTurn(child, { steps: child.step, aborted: true }).catch(() => {});
        }
      }
      await Promise.allSettled([...state.taskExecutions.values()]);
      await Promise.all([...state.delegation.members].filter(child => {
        let ancestor = child.delegation?.parent;
        while (ancestor && ancestor !== state) ancestor = ancestor.delegation?.parent;
        return ancestor === state;
      }).map(child => child.done));
      await state.chain;
    }
    await this.closeMcpProgress(state, undefined, true);
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
    if (stopReason !== "end_turn" && state.lastText) turn.partialText = state.lastText;
    else delete turn.partialText;
    // Keep this final boundary closed even if a stale or faulty engine returns untrusted text.
    if (result.error) turn.error = publicEngineFailure(result.error);

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
      if (state.interruptObservation) await state.interruptObservation;
      const r = await this.commit(state, {
        turn,
        items,
        events: [
          ...(result.error ? [{ type: "error" as const, sessionId, emittedAtMs: now, ...publicEngineFailure(result.error), turnId: turn.id }] : []),
          { type: "turn/completed", sessionId, emittedAtMs: now, turn, stopReason },
          { type: "session/status/changed", sessionId, emittedAtMs: now, status: { type: "idle" } },
        ],
        sessionPatch: { status: { type: "idle" }, usage: state.session.usage },
      });
      turn.seqEnd = r.lastSeq;
      // A terminal observer cannot undo the already committed result. Its failure is not a
      // canonical rollback and must not be logged as a turn requiring repair.
      try {
        await this.observeLifecycle(state, { ...this.lifecycleContext(state), phase: "Stop", outcome: turn.status }, true);
        if (state.delegation?.task) {
          const task = state.delegation.task;
          await this.observeDelegatedLifecycle(state.delegation.root.delegation!.access, "SubagentStop",
            { taskId: task.taskId, childSessionId: state.session.id, childTurnId: state.turn.id });
        }
      } catch { this.logTurnStop("warn", "terminal lifecycle observation did not complete"); }
    } catch {
      this.logTurnStop("error", "turn end persistence failed; the next owner will repair");
    } finally {
      state.leaseGuard.stop();
      if (this.active.get(sessionId) === state) this.active.delete(sessionId);
      state.phase = "finished";
      state.resolveDone();
      this.releaseTenantRuntime(state);
      if (!state.delegation?.parent) this.scheduleRelease(sessionId);
    }
  }

  private releaseTenantRuntime(state: ActiveTurn): void {
    state.lifecycleAbort.abort();
    state.delegation?.removeRootAbort?.();
    if (state.delegation?.parent) state.delegation.members.delete(state);
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
    const rootAccess = createSubagentRootAccess({ principal: { tenantId: session.tenantId, userId: session.userId },
      rootSessionId: session.id, rootTurnId: activeTurnId, rootFence: fence });
    const delegatedRoot = await this.deps.store.getSubagentRoot({ access: rootAccess });
    if (delegatedRoot) {
      if (!leaseGuard) throw new ApiError("session_lease_conflict", "Subagent recovery requires its root lease.");
      leaseGuard.assertOwned();
      const principal = { tenantId: session.tenantId, userId: session.userId };
      const tasks = await leaseGuard.wait(this.deps.store.listSubagentTasks({ principal, rootSessionId: session.id, rootTurnId: activeTurnId }));
      if (tasks.length > 64 || tasks.some(task => task.rootSessionId !== session.id || task.rootTurnId !== activeTurnId)
        || new Set(tasks.map(task => task.childSessionId)).size !== tasks.length) throw new ApiError("internal_error", "Subagent recovery source is unavailable.");
      const before = new Map<string, number>();
      for (const id of [session.id, ...tasks.map(task => task.childSessionId).sort()]) {
        leaseGuard.assertOwned();
        const source = await leaseGuard.wait(this.deps.store.getSession(principal.tenantId, id));
        if (!source || source.userId !== principal.userId || !Number.isSafeInteger(source.lastSeq) || source.lastSeq < 0) {
          throw new ApiError("internal_error", "Subagent recovery source is unavailable.");
        }
        before.set(id, source.lastSeq);
      }
      // A takeover never restarts a child or refunds an unsettled reservation. Store repair marks
      // the exact old family unknown and closes its canonical child/activity projections atomically.
      leaseGuard.assertOwned();
      await leaseGuard.wait(this.deps.store.repairSubagentRoot({ principal, rootSessionId: session.id, rootTurnId: activeTurnId, newFence: fence }));
      for (const [id, firstSeq] of before) {
        leaseGuard.assertOwned();
        const after = await leaseGuard.wait(this.deps.store.getSession(principal.tenantId, id));
        if (!after || after.userId !== principal.userId || !Number.isSafeInteger(after.lastSeq) || after.lastSeq < firstSeq) {
          throw new ApiError("internal_error", "Subagent recovery source is unavailable.");
        }
        // The root fence excludes every old family writer. Read only this finite committed delta,
        // not new producer output, and preserve each session's independent durable sequence space.
        let cursor = firstSeq;
        while (cursor < after.lastSeq) {
          leaseGuard.assertOwned();
          const page = await leaseGuard.wait(this.deps.store.readEvents(id, cursor, Math.min(256, after.lastSeq - cursor)));
          if (!page.length || page.some((event, index) => event.sessionId !== id || event.seq !== cursor + index + 1 || event.seq > after.lastSeq)) {
            throw new ApiError("internal_error", "Subagent recovery events are unavailable.");
          }
          leaseGuard.assertOwned(); await this.publishAll(id, page); cursor = page.at(-1)!.seq;
        }
        if (id === session.id) session.lastSeq = after.lastSeq;
      }
    }
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
  }, requireOpenToolHook = false, tenantWebhookPlan?: TenantWebhookMilestonePlan): Promise<CommitResult & { tenantWebhookIntents?: readonly import("@agent-service/store").TenantWebhookIntent[] }> {
    const run = async () => {
      // A hook/report may have queued behind another COMMIT before cancellation closed admission.
      // Recheck at the real write boundary, not only before enqueueing it.
      if (requireOpenToolHook) this.assertToolHooksOpen(state);
      if (state.fenced) throw new FenceError(state.session.id, state.fence, state.fence);
      state.leaseGuard.assertOwned();
      try {
        const completeBatch = { ...batch, sessionId: state.session.id, fence: state.fence };
        if (state.delegation) attachSubagentCommitAdmission(completeBatch, { access: state.delegation.access,
          ...(batch.events?.some(event => event.type === "turn/started") && state.delegation.rootSpecification
            ? { root: state.delegation.rootSpecification } : {}),
          ...(batch.turn && batch.turn.status !== "inProgress" && state.delegation.root === state ? { finishRoot: true as const } : {}) });
        if (tenantWebhookPlan && providerFailureSource) throw new ApiError("internal_error", "Invalid combined commit milestone.");
        if (state.delegation?.parent && batch.turn && batch.turn.status !== "inProgress" && (tenantWebhookPlan || providerFailureSource)) {
          throw new ApiError("internal_error", "Invalid delegated terminal milestone.");
        }
        const r = state.delegation?.parent && batch.turn && batch.turn.status !== "inProgress"
          ? await this.completeDelegatedTurn(state, completeBatch)
          : tenantWebhookPlan && this.deps.tenantWebhooks
          ? await this.deps.tenantWebhooks.commit(completeBatch, tenantWebhookPlan)
          : providerFailureSource && this.deps.persistedProviderFailureCapture
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
    if (state.delegation?.parent && !state.delegation.root.fenced) this.onCommitError(state.delegation.root, err);
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
