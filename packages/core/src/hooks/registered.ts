import { createHash } from "node:crypto";
import { ApiError, type Principal } from "@agent-service/protocol";
import {
  attachSessionWriteAdmission, captureSessionWriteAdmission, type SessionLeaseProof,
  assertTenantWebhookAccess, assertTenantWebhookSource, createTenantWebhookConfigAdmission,
  createTenantWebhookMilestoneAdmission, createTenantWebhookRuntimeAccess, tenantWebhookAad,
  tenantWebhookId, tenantWebhookIntentId, tenantWebhookVersionId,
  TenantWebhookConflictError, TenantWebhookIntegrityError, TenantWebhookSizeError, TenantWebhookLifecycleBlockedError, SubjectDeletingError,
  type CommitBatch, type TenantWebhookAccess, type TenantWebhookCanonicalResult, type TenantWebhookConfig,
  type TenantWebhookIntent, type TenantWebhookPreparedPayload, type TenantWebhookPreparedSnapshot,
  type TenantWebhookRegistration, type TenantWebhookSource, type TenantWebhookStore,
} from "@agent-service/store";
import { createMcpHttpFetch } from "../mcp/http.js";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";
import { TenantWebhookCipher, tenantWebhookCanonicalJson, tenantWebhookHash } from "./cipher.js";
import {
  TENANT_WEBHOOK_MAX_REQUEST_BYTES, TENANT_WEBHOOK_MAX_RESPONSE_BYTES, TenantWebhookProjectionError,
  signTenantWebhookRequest, tenantWebhookOpaqueRef, tenantWebhookPromptBody, validateTenantWebhookRequest,
  verifyTenantWebhookResponse,
} from "./webhook-v2.js";

export interface RegisteredTenantWebhookServiceOptions {
  readonly store: TenantWebhookStore; readonly cipher: TenantWebhookCipher;
  readonly authorizeFleet: (signal: AbortSignal) => Promise<void>;
  readonly authorizeSubject?: (principal: Principal) => Promise<void>;
  readonly authorizeTenant?: (tenantId: string) => Promise<void>;
  readonly tenantRuntime?: TenantRuntimeCoordinator; readonly timeoutMs?: number;
  readonly maxConcurrentPerUser?: number; readonly allowLoopbackForTests?: boolean;
}
export interface TenantWebhookMilestonePlan {
  readonly source: TenantWebhookSource; readonly kind: "pre" | "started" | "post";
  readonly snapshots: readonly TenantWebhookPreparedSnapshot[]; readonly payloads: readonly TenantWebhookPreparedPayload[];
  readonly failures: readonly { readonly configVersionId: string; readonly code: "observation_unavailable" }[];
  readonly canonicalResult: TenantWebhookCanonicalResult | null; readonly projectionFailed: boolean;
  readonly deadlineAt: number;
}
export interface TenantWebhookDispatchReport {
  readonly intentId: string; readonly webhookId: string; readonly configVersionId: string;
  readonly phase: "preToolUse" | "postToolUse"; readonly callItemId: string; readonly toolCallId: string;
  readonly outcome: "acknowledged" | "failed_not_dispatched" | "outcome_unknown" | "blocked";
}
const unavailable = () => new ApiError("draining", "Tenant hooks are unavailable.");
const rawSha = (value: string) => createHash("sha256").update(value).digest("hex");
type RuntimeContext = { signal: AbortSignal; assertOpen(): void; assertAuthority(): void;
  authorize(): Promise<void>; authorizeWithinBudget(): Promise<boolean>; until: number };
type Snapshot = { profile: "tenant-webhook-invocation-snapshot-v2"; prompt: unknown; arguments: unknown };
function fixedError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (error instanceof TenantWebhookConflictError) return new ApiError("state_conflict", "Tenant hook state changed.");
  if (error instanceof TenantWebhookIntegrityError || error instanceof TenantWebhookSizeError) return new ApiError("invalid_request", "Tenant hook request failed.");
  if (error instanceof TenantWebhookLifecycleBlockedError || error instanceof SubjectDeletingError) return new ApiError("subject_deleting", "Tenant hook subject is unavailable.");
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const entry = current as { code?: unknown; cause?: unknown };
    if (entry.code === "ER_LOCK_DEADLOCK" || entry.code === "ER_LOCK_WAIT_TIMEOUT" || entry.code === 1213 || entry.code === 1205) {
      return new ApiError("draining", "Tenant hook request is temporarily unavailable.", undefined, true);
    }
    current = entry.cause;
  }
  return new ApiError("internal_error", "Tenant hook request failed.");
}

/** One bounded, durably witnessed observer attempt; this is not a reliable redelivery outbox. */
export class RegisteredTenantWebhookService {
  readonly enabled = true;
  readonly identity: { readonly keyId: string; readonly keySha256: string };
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  private readonly counts = new Map<string, number>();
  private readonly sourceDeadlines = new WeakMap<TenantWebhookSource, number>();
  private readonly timeout: number;
  private readonly maximum: number;
  constructor(private readonly options: RegisteredTenantWebhookServiceOptions) {
    if (typeof options.authorizeFleet !== "function") throw unavailable();
    this.timeout = options.timeoutMs ?? 1500; this.maximum = options.maxConcurrentPerUser ?? 2;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 5000
      || !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 8) throw unavailable();
    this.identity = options.cipher.identity;
  }
  private operation<T>(tenantId: string, principal: Principal | null, caller: AbortSignal, work: (context: RuntimeContext) => Promise<T>, deadlineAt?: number, allowBudgetSettlement = false): Promise<T> {
    if (this.closed || caller.aborted) return Promise.reject(unavailable());
    const countKey = JSON.stringify([tenantId, principal?.userId ?? null]);
    const count = this.counts.get(countKey) ?? 0;
    if (count >= this.maximum) return Promise.reject(unavailable());
    let lease: ReturnType<TenantRuntimeCoordinator["enter"]> | undefined;
    try { lease = this.options.tenantRuntime?.enter(tenantId, "provider"); } catch { return Promise.reject(unavailable()); }
    const abort = new AbortController(), budget = new AbortController();
    const signal = AbortSignal.any([caller, abort.signal, budget.signal, ...(lease ? [lease.signal] : [])]);
    const until = Math.min(performance.now() + this.timeout, deadlineAt ?? Number.POSITIVE_INFINITY);
    const timer = setTimeout(() => budget.abort(), Math.max(0, until - performance.now()));
    const assertAuthority = () => {
      if (this.closed || caller.aborted || abort.signal.aborted || lease?.signal.aborted) throw unavailable();
      lease?.assertOpen();
    };
    const budgetExpired = () => budget.signal.aborted || performance.now() >= until;
    const assertOpen = () => { assertAuthority(); if (budgetExpired()) throw unavailable(); };
    const authorizeWithinBudget = async () => {
      assertAuthority(); if (budgetExpired()) return false;
      // Do not catch an actual authorization rejection, even if our timer expires concurrently.
      await this.options.authorizeFleet(signal); assertAuthority(); if (budgetExpired()) return false;
      if (principal) await this.options.authorizeSubject?.(principal); else await this.options.authorizeTenant?.(tenantId);
      assertAuthority(); return !budgetExpired();
    };
    const authorize = async () => { if (!await authorizeWithinBudget()) throw unavailable(); };
    this.counts.set(countKey, count + 1);
    const operation = { abort, done: Promise.resolve<unknown>(undefined) }; this.pending.add(operation);
    operation.done = Promise.resolve().then(async () => {
      try {
        if (allowBudgetSettlement) await authorizeWithinBudget(); else await authorize();
        return await work({ signal, assertOpen, assertAuthority, authorize, authorizeWithinBudget, until });
      }
      catch (error) { throw fixedError(error); }
      finally {
        abort.abort(); budget.abort(); clearTimeout(timer); lease?.release(); this.pending.delete(operation);
        const remaining = (this.counts.get(countKey) ?? 1) - 1;
        if (remaining) this.counts.set(countKey, remaining); else this.counts.delete(countKey);
      }
    });
    return operation.done as Promise<T>;
  }
  private admin(tenantId: string, access: TenantWebhookAccess): void {
    if (assertTenantWebhookAccess(access, "admin").tenantId !== tenantId) throw unavailable();
  }
  async upsert(tenantId: string, input: { access: TenantWebhookAccess; name: string; expectedRevision: number; idempotencyKey: string;
    config: TenantWebhookConfig; signingKey: string; disclosureAck?: "tenant-admin-body-disclosure-v1" }, signal: AbortSignal): Promise<TenantWebhookRegistration> {
    this.admin(tenantId, input.access);
    return this.operation(tenantId, null, signal, async context => {
      if (!/^[a-f0-9]{64}$/.test(input.signingKey)) throw new ApiError("invalid_request", "Tenant hook request failed.");
      const checked = createMcpHttpFetch({ endpoint: input.config.endpoint, timeoutMs: this.timeout,
        maxRequestBytes: TENANT_WEBHOOK_MAX_REQUEST_BYTES, maxResponseBytes: TENANT_WEBHOOK_MAX_RESPONSE_BYTES,
        allowLoopbackForTests: this.options.allowLoopbackForTests });
      await checked.close(); context.assertOpen();
      const current = await this.options.store.getTenantWebhook({ access: input.access, name: input.name });
      const generation = !current ? 1 : current.slot.state === "deleted" ? current.slot.generation + 1 : current.slot.generation;
      const configVersionId = tenantWebhookVersionId(tenantId, input.name, input.expectedRevision, input.idempotencyKey);
      const version = { tenantId, webhookId: tenantWebhookId(tenantId, input.name), generation,
        configVersionId, keyVersionId: configVersionId, config: input.config };
      const signingKey = this.options.cipher.encrypt(tenantWebhookAad(version, "signing_key"), { purpose: "signing_key", signingKeyHex: input.signingKey });
      const admission = createTenantWebhookConfigAdmission({ access: input.access, name: input.name,
        expectedRevision: input.expectedRevision, generation, idempotencyKey: input.idempotencyKey, config: input.config,
        signingKey, keyCommitmentSha256: this.options.cipher.signingKeyCommitment(input.signingKey), disclosureAck: input.disclosureAck ?? null });
      await context.authorize();
      return this.options.store.upsertTenantWebhook({ access: input.access, name: input.name, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, admission });
    });
  }
  async list(tenantId: string, input: { access: TenantWebhookAccess; cursor?: string; limit?: number }, signal: AbortSignal) {
    this.admin(tenantId, input.access);
    return this.operation(tenantId, null, signal, async () => this.options.store.listTenantWebhooks({ access: input.access, cursor: input.cursor ?? null, limit: input.limit ?? 25 }));
  }
  async get(tenantId: string, name: string, input: { access: TenantWebhookAccess }, signal: AbortSignal) {
    this.admin(tenantId, input.access);
    return this.operation(tenantId, null, signal, async () => this.options.store.getTenantWebhook({ access: input.access, name }));
  }
  async setState(tenantId: string, name: string, input: { access: TenantWebhookAccess; expectedRevision: number; idempotencyKey: string; state: "enabled" | "disabled" | "deleted" }, signal: AbortSignal) {
    this.admin(tenantId, input.access);
    return this.operation(tenantId, null, signal, async () => this.options.store.setTenantWebhookState({ ...input, name }));
  }
  async listDeliveries(tenantId: string, name: string, input: { access: TenantWebhookAccess; cursor?: string; limit?: number }, signal: AbortSignal) {
    this.admin(tenantId, input.access);
    return this.operation(tenantId, null, signal, async () => this.options.store.listTenantWebhookDeliveries({ access: input.access, name, cursor: input.cursor ?? null, limit: input.limit ?? 25 }));
  }
  resolve(owner: Principal, signal: AbortSignal): Promise<string | undefined> {
    return this.operation(owner.tenantId, owner, signal, async () => {
      const policy = await this.options.store.getTenantWebhookRuntimePolicy({ access: createTenantWebhookRuntimeAccess(owner) });
      const versions = policy.map(item => ({ configVersionId: item.configVersionId, configSha256: item.configSha256, phase: item.phase }))
        .sort((left, right) => left.configVersionId.localeCompare(right.configVersionId));
      return versions.length ? tenantWebhookHash("tenant-webhook-owner-policy-v2", { owner, versions, identity: this.identity }) : undefined;
    });
  }
  readSource(owner: Principal, input: { sessionId: string; turnId: string; callItemId: string; fence: number }, signal: AbortSignal, proof: SessionLeaseProof): Promise<TenantWebhookSource> {
    return this.operation(owner.tenantId, owner, signal, async context => {
      const source = await this.options.store.readTenantWebhookSources(attachSessionWriteAdmission({ access: attachSessionWriteAdmission(createTenantWebhookRuntimeAccess(owner), proof), ...input }, proof));
      this.sourceDeadlines.set(source, context.until); return source;
    });
  }
  prepare(source: TenantWebhookSource, kind: TenantWebhookMilestonePlan["kind"], canonicalResult: TenantWebhookCanonicalResult | null = null): TenantWebhookMilestonePlan {
    const value = assertTenantWebhookSource(source), snapshots: TenantWebhookPreparedSnapshot[] = [], payloads: TenantWebhookPreparedPayload[] = [];
    const failures: Array<{ configVersionId: string; code: "observation_unavailable" }> = [];
    let projectionFailed = false;
    for (const registration of value.registrations) {
      const version = registration.version;
      if (!version || kind !== "post" && registration.slot.state !== "enabled"
        || version.config.phase !== (kind === "pre" ? "preToolUse" : "postToolUse")) continue;
      const aadContext = { principal: value.principal, sessionId: value.sessionId, turnId: value.turnId, callItemId: value.callItemId };
      try {
        if (kind !== "post" && value.observationUnavailable && version.config.bodyScopes.length) throw new TenantWebhookProjectionError();
        if (kind === "started") {
          const snapshot: Snapshot = { profile: "tenant-webhook-invocation-snapshot-v2",
            prompt: version.config.bodyScopes.includes("prompt") ? value.prompt : null,
            arguments: version.config.bodyScopes.includes("tool_arguments") ? value.arguments : null };
          let snapshotJson: string;
          try { snapshotJson = tenantWebhookCanonicalJson(snapshot); } catch { throw new TenantWebhookProjectionError(); }
          if (Buffer.byteLength(snapshotJson) > 60_000) throw new TenantWebhookProjectionError();
          snapshots.push({ configVersionId: version.configVersionId,
            plaintextSha256: tenantWebhookHash("tenant-webhook-invocation-snapshot-v2", snapshot),
            envelope: this.options.cipher.encrypt(tenantWebhookAad(version, "invocation_snapshot", aadContext), { purpose: "invocation_snapshot", snapshot }) });
          continue;
        }
        let snapshot: Snapshot = { profile: "tenant-webhook-invocation-snapshot-v2", prompt: value.prompt, arguments: value.arguments };
        if (kind === "post") {
          const prior = value.startedSnapshots.find(item => item.configVersionId === version.configVersionId);
          // A legacy/already-running call predating this policy has no disclosure snapshot.
          // Persist its real result, but never manufacture coverage or a new body delivery.
          if (!prior || !canonicalResult) continue;
          if (prior.availability === "unavailable") {
            failures.push({ configVersionId: version.configVersionId, code: "observation_unavailable" });
            projectionFailed = true; continue;
          }
          if (prior.envelope === null || prior.plaintextSha256 === null) throw unavailable();
          const decoded = this.options.cipher.open(tenantWebhookAad(version, "invocation_snapshot", aadContext), prior.envelope);
          if (decoded.purpose !== "invocation_snapshot" || tenantWebhookHash("tenant-webhook-invocation-snapshot-v2", decoded.snapshot) !== prior.plaintextSha256) throw unavailable();
          snapshot = decoded.snapshot as Snapshot;
          if (snapshot.profile !== "tenant-webhook-invocation-snapshot-v2") throw unavailable();
        }
        const opened = this.options.cipher.open(tenantWebhookAad(version, "signing_key"), version.signingKey);
        if (opened.purpose !== "signing_key") throw unavailable();
        const key = Buffer.from(opened.signingKeyHex, "hex");
        try {
          const body: Record<string, unknown> = {};
          if (version.config.bodyScopes.includes("prompt")) body.prompt = tenantWebhookPromptBody(snapshot.prompt as typeof value.prompt);
          if (version.config.bodyScopes.includes("tool_arguments")) body.tool_arguments = snapshot.arguments;
          if (version.config.bodyScopes.includes("tool_result")) body.tool_result = canonicalResult!.payload;
          const ref = (part: string, ids: string[]) => tenantWebhookOpaqueRef(key, part, ids);
          const owner = [value.principal.tenantId, value.principal.userId];
          const request = signTenantWebhookRequest({ schema: "agent-service-tenant-tool-hook-request-v2", webhookId: version.webhookId,
            configVersionId: version.configVersionId, configSha256: version.configSha256, phase: version.config.phase,
            invocationId: tenantWebhookIntentId(version.configVersionId, value.callItemId, version.config.phase),
            refs: { tenant: ref("tenant", [owner[0]!]), user: ref("user", owner), session: ref("session", [...owner, value.sessionId]),
              turn: ref("turn", [...owner, value.sessionId, value.turnId]), callItem: ref("call-item", [...owner, value.sessionId, value.turnId, value.callItemId]) },
            tool: { name: value.toolName, kind: value.toolKind }, isError: kind === "post" ? canonicalResult!.isError : null,
            bodyScopes: [...version.config.bodyScopes], ...(version.config.bodyScopes.length ? { body } : {}) }, key);
          const bytes = tenantWebhookCanonicalJson(request);
          payloads.push({ configVersionId: version.configVersionId, invocationId: request.invocationId, requestSha256: request.requestSha256,
            payloadSha256: rawSha(bytes), payloadBytes: Buffer.byteLength(bytes), envelope: this.options.cipher.encrypt(tenantWebhookAad(version, "delivery_payload", aadContext), { purpose: "delivery_payload", request }) });
        } finally { key.fill(0); }
      } catch (error) {
        if (!(error instanceof TenantWebhookProjectionError)) throw error;
        failures.push({ configVersionId: version.configVersionId, code: "observation_unavailable" });
        projectionFailed = true;
      }
    }
    return { source, kind, snapshots, payloads, failures, canonicalResult, projectionFailed, deadlineAt: this.sourceDeadlines.get(source) ?? performance.now() + this.timeout };
  }
  commit(batch: CommitBatch, plan: TenantWebhookMilestonePlan) {
    if (this.closed) return Promise.reject(unavailable());
    const authority = captureSessionWriteAdmission(batch);
    if (!authority) return Promise.reject(unavailable());
    const { source, kind, snapshots, payloads, failures, canonicalResult } = plan;
    const admission = createTenantWebhookMilestoneAdmission({ source, kind, batch, snapshots, payloads, failures, canonicalResult });
    const operation = { abort: new AbortController(), done: Promise.resolve<unknown>(undefined) }; this.pending.add(operation);
    const work = Promise.resolve().then(() => this.options.store.commitTenantWebhookMilestone(attachSessionWriteAdmission({ batch, admission }, authority)));
    operation.done = work.finally(() => this.pending.delete(operation));
    return operation.done as ReturnType<TenantWebhookStore["commitTenantWebhookMilestone"]>;
  }
  async dispatch(intents: readonly TenantWebhookIntent[], signal: AbortSignal, deadlineAt: number | undefined, proof: SessionLeaseProof): Promise<readonly TenantWebhookDispatchReport[]> {
    if (!intents.length) return [];
    const owner = intents[0]!.subject;
    return this.operation(owner.tenantId, owner, signal, async context => {
      const reports: TenantWebhookDispatchReport[] = [], access = attachSessionWriteAdmission(createTenantWebhookRuntimeAccess(owner), proof);
      for (const intent of intents) {
        if (intent.subject.tenantId !== owner.tenantId || intent.subject.userId !== owner.userId) throw unavailable();
        if (["acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(intent.state)) {
          // A current owner may inspect an older terminal receipt, but never claim/re-dispatch it.
          // The store independently validates the actual image and does not settleExpired here.
          const current = await this.options.store.getTenantWebhookDelivery(attachSessionWriteAdmission({ access, intentId: intent.intentId }, proof));
          context.assertAuthority();
          if (!current || !["acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(current.state)) throw unavailable();
          reports.push({ intentId: current.intentId, webhookId: current.webhookId, configVersionId: current.configVersionId,
            phase: current.phase, callItemId: current.callItemId, toolCallId: current.toolCallId, outcome: current.state as TenantWebhookDispatchReport["outcome"] });
          continue;
        }
        if (!await context.authorizeWithinBudget()) {
          // An exhausted observer phase cannot authorize more HTTP, but it must not turn an
          // unattempted observation into a tool denial. This CAS grants no execution authority.
          const current = await this.options.store.abandonPreparedTenantWebhookDelivery(attachSessionWriteAdmission({ access, intentId: intent.intentId }, proof));
          context.assertAuthority();
          if (current && ["acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(current.state)) {
            reports.push({ intentId: current.intentId, webhookId: current.webhookId, configVersionId: current.configVersionId,
              phase: current.phase, callItemId: current.callItemId, toolCallId: current.toolCallId, outcome: current.state as TenantWebhookDispatchReport["outcome"] });
          }
          continue;
        }
        const claim = await this.options.store.claimTenantWebhookDelivery(attachSessionWriteAdmission({ access, intentId: intent.intentId,
          timeoutMs: Math.max(1, Math.floor(context.until - performance.now())) }, proof));
        if (!claim) {
          const current = await this.options.store.getTenantWebhookDelivery(attachSessionWriteAdmission({ access, intentId: intent.intentId }, proof));
          context.assertAuthority();
          if (current && ["acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(current.state)) {
            reports.push({ intentId: current.intentId, webhookId: current.webhookId, configVersionId: current.configVersionId,
              phase: current.phase, callItemId: current.callItemId, toolCallId: current.toolCallId, outcome: current.state as TenantWebhookDispatchReport["outcome"] });
          }
          continue;
        }
        let resultSha256 = tenantWebhookHash("tenant-webhook-not-dispatched-v2", intent.intentId);
        let outcome: "acknowledged" | "failed_not_dispatched" | "outcome_unknown" = "failed_not_dispatched";
        const aadContext = { principal: owner, sessionId: intent.sessionId, turnId: intent.turnId, callItemId: intent.callItemId };
        const material = this.options.cipher.open(tenantWebhookAad(claim.registration, "delivery_payload", aadContext), claim.intent.payload);
        const signing = this.options.cipher.open(tenantWebhookAad(claim.registration, "signing_key"), claim.registration.signingKey);
        if (material.purpose !== "delivery_payload" || signing.purpose !== "signing_key") throw unavailable();
        const key = Buffer.from(signing.signingKeyHex, "hex");
        try {
          const request = validateTenantWebhookRequest(material.request, key), bytes = tenantWebhookCanonicalJson(request);
          if (rawSha(bytes) !== claim.intent.payloadSha256 || Buffer.byteLength(bytes) !== claim.intent.payloadBytes
            || request.requestSha256 !== claim.intent.requestSha256) throw unavailable();
          // Local/source/claim/cipher/fleet failures remain outside the observer HTTP catch.
          if (await context.authorizeWithinBudget()) {
            const owned = createMcpHttpFetch({ endpoint: claim.registration.config.endpoint,
              maxRequestBytes: TENANT_WEBHOOK_MAX_REQUEST_BYTES, maxResponseBytes: TENANT_WEBHOOK_MAX_RESPONSE_BYTES,
              timeoutMs: Math.max(1, Math.floor(context.until - performance.now())), allowLoopbackForTests: this.options.allowLoopbackForTests });
            try {
              outcome = "outcome_unknown";
              const response = await owned(claim.registration.config.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: bytes, signal: context.signal });
              if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) throw new TenantWebhookProjectionError();
              const body = new Uint8Array(await response.arrayBuffer());
              if (body.byteLength > TENANT_WEBHOOK_MAX_RESPONSE_BYTES) throw new TenantWebhookProjectionError();
              resultSha256 = verifyTenantWebhookResponse(new TextDecoder("utf-8", { fatal: true }).decode(body), request, key);
              outcome = "acknowledged";
            } catch { outcome = "outcome_unknown"; resultSha256 = tenantWebhookHash("tenant-webhook-unknown-v2", intent.intentId); }
            finally { await owned.close(); }
          }
          // A late ACK after stop/revocation is not a fresh successful observation.
          if (outcome === "acknowledged") try { context.assertOpen(); } catch { outcome = "outcome_unknown"; }
        } finally { key.fill(0); }
        const completed = await this.options.store.finishTenantWebhookDelivery(attachSessionWriteAdmission({ access, intentId: intent.intentId,
          claimToken: claim.claimToken, outcome, resultSha256 }, proof));
        context.assertAuthority();
        if (["acknowledged", "failed_not_dispatched", "outcome_unknown", "blocked"].includes(completed.state)) {
          reports.push({ intentId: completed.intentId, webhookId: completed.webhookId, configVersionId: completed.configVersionId,
            phase: completed.phase, callItemId: completed.callItemId, toolCallId: completed.toolCallId,
            outcome: completed.state as TenantWebhookDispatchReport["outcome"] });
        }
      }
      return reports;
    }, deadlineAt, true);
  }
  /** Process owner cancellation only: no cipher/coordination/SQL dependency is closed here. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const operation of this.pending) operation.abort.abort();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    this.closing = Promise.allSettled([...this.pending].map(operation => operation.done)).then(() => {});
    return this.closing;
  }
}
