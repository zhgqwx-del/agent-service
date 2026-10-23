import { createHash } from "node:crypto";
import { LifecycleHookPhase } from "@agent-service/protocol";
import type { LifecycleHookReport, LifecycleMiddlewareReport, Principal } from "@agent-service/protocol";
import type {
  ConfiguredLifecycleHookServiceOptions, LifecycleHookContext, LifecycleHookService,
  LifecycleModelInput, LifecycleModelResult, LifecycleOperationContext, LifecyclePromptInput,
  LifecyclePromptResult, LifecycleToolInput, LifecycleToolResult,
} from "./lifecycle-types.js";
import {
  applyModelPackage, applyPromptPackage, applyToolPackage, copyLifecycleModel, copyLifecyclePrompt,
  copyLifecycleTool, finalModelDenial, finalPromptDenial, freezeLifecycle, LifecycleHookError, lifecycleKeys, lifecycleOwnerKey,
  lifecyclePrincipal, lifecycleText, normalizeLifecyclePackages, plainLifecycleObject,
} from "./middleware.js";
import type { RegisteredLifecyclePackage } from "./middleware.js";

function invalid(): never { throw new LifecycleHookError("invalid"); }
function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value;
}
function operationContext(value: LifecycleOperationContext): LifecycleOperationContext {
  const c = plainLifecycleObject(value); lifecycleKeys(c, ["owner", "sessionId"], ["turnId", "itemId", "step"]);
  return freezeLifecycle({ owner: lifecyclePrincipal(c.owner), sessionId: lifecycleText(c.sessionId, 256),
    ...(c.turnId === undefined ? {} : { turnId: lifecycleText(c.turnId, 256) }),
    ...(c.itemId === undefined ? {} : { itemId: lifecycleText(c.itemId, 256) }),
    ...(c.step === undefined ? {} : { step: natural(c.step) }) });
}
function hookContext(value: LifecycleHookContext): LifecycleHookContext {
  const c = plainLifecycleObject(value), parsed = LifecycleHookPhase.safeParse(c.phase); if (!parsed.success) invalid();
  const phase = parsed.data;
  const base = operationContext({ owner: c.owner as Principal, sessionId: c.sessionId as string,
    ...(c.turnId === undefined ? {} : { turnId: c.turnId as string }),
    ...(c.itemId === undefined ? {} : { itemId: c.itemId as string }),
    ...(c.step === undefined ? {} : { step: c.step as number }) });
  const required = ["phase", "owner", "sessionId"], optional = ["turnId", "itemId", "step"];
  if (phase === "UserPromptSubmit") {
    lifecycleKeys(c, [...required, "turnId", "itemId", "submission"], optional);
    if (c.submission !== "initial" && c.submission !== "steer") invalid();
    return freezeLifecycle({ ...base, phase, turnId: lifecycleText(c.turnId, 256), itemId: lifecycleText(c.itemId, 256), submission: c.submission });
  }
  if (phase === "PreToolUse" || phase === "PostToolUse" || phase === "PermissionRequest") {
    const extra = phase === "PostToolUse" ? ["isError"] : phase === "PermissionRequest" ? ["approvalId"] : [];
    lifecycleKeys(c, [...required, "turnId", "itemId", "toolCallId", "tool", ...extra], optional);
    const t = plainLifecycleObject(c.tool); lifecycleKeys(t, ["name", "kind", "readOnly"]);
    if (typeof t.kind !== "string" || !["builtin", "mcp", "dynamic", "skill"].includes(t.kind) || typeof t.readOnly !== "boolean") invalid();
    const tool = { name: lifecycleText(t.name, 512), kind: t.kind as "builtin" | "mcp" | "dynamic" | "skill", readOnly: t.readOnly };
    const common = { ...base, turnId: lifecycleText(c.turnId, 256), itemId: lifecycleText(c.itemId, 256),
      toolCallId: lifecycleText(c.toolCallId, 256), tool };
    if (phase === "PostToolUse") { if (typeof c.isError !== "boolean") invalid(); return freezeLifecycle({ ...common, phase, isError: c.isError }); }
    if (phase === "PermissionRequest") return freezeLifecycle({ ...common, phase, approvalId: lifecycleText(c.approvalId, 256) });
    return freezeLifecycle({ ...common, phase });
  }
  if (phase === "PreCompact" || phase === "PostCompact") {
    lifecycleKeys(c, [...required, "throughSeq"], optional); return freezeLifecycle({ ...base, phase, throughSeq: natural(c.throughSeq) });
  }
  if (phase === "SubagentStart" || phase === "SubagentStop") {
    lifecycleKeys(c, [...required, "turnId", "subagent"], optional);
    const s = plainLifecycleObject(c.subagent); lifecycleKeys(s, ["taskId", "childSessionId", "childTurnId"]);
    return freezeLifecycle({ ...base, phase, turnId: lifecycleText(c.turnId, 256), subagent: {
      taskId: lifecycleText(s.taskId, 256), childSessionId: lifecycleText(s.childSessionId, 256), childTurnId: lifecycleText(s.childTurnId, 256),
    } });
  }
  if (phase === "Stop") {
    lifecycleKeys(c, [...required, "turnId", "outcome"], optional);
    if (c.outcome !== "completed" && c.outcome !== "failed" && c.outcome !== "interrupted" && c.outcome !== "unknown") invalid();
    return freezeLifecycle({ ...base, phase, turnId: lifecycleText(c.turnId, 256), outcome: c.outcome });
  }
  if (phase === "Interrupt") {
    lifecycleKeys(c, [...required, "turnId"], optional); return freezeLifecycle({ ...base, phase, turnId: lifecycleText(c.turnId, 256) });
  }
  lifecycleKeys(c, required, optional); return freezeLifecycle({ ...base, phase: "SessionStart" });
}

type Operation = { readonly abort: AbortController; readonly done: Promise<void> };
/** Trusted fixed in-process packages only. No dynamic import, arbitrary handler, URL, network or secret interface. */
export class ConfiguredLifecycleHookService implements LifecycleHookService {
  readonly enabled: boolean;
  private readonly packages: readonly RegisteredLifecyclePackage[];
  private readonly timeout: number;
  private readonly maximum: number;
  private readonly runtime: ConfiguredLifecycleHookServiceOptions["tenantRuntime"];
  private readonly authorize: ConfiguredLifecycleHookServiceOptions["authorizeSubject"];
  private readonly authorizeFleet: ConfiguredLifecycleHookServiceOptions["authorizeFleet"];
  private readonly operations = new Set<Operation>();
  private readonly counts = new Map<string, number>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: ConfiguredLifecycleHookServiceOptions) {
    const raw = plainLifecycleObject(options); lifecycleKeys(raw, ["packages"], ["enabled", "timeoutMs", "maxConcurrentPerUser", "tenantRuntime", "authorizeSubject", "authorizeFleet"]);
    if (options.enabled !== undefined && typeof options.enabled !== "boolean"
      || options.authorizeSubject !== undefined && typeof options.authorizeSubject !== "function"
      || options.authorizeFleet !== undefined && typeof options.authorizeFleet !== "function") invalid();
    this.packages = normalizeLifecyclePackages(options.packages);
    this.enabled = options.enabled ?? true;
    if (this.enabled && this.packages.length === 0) invalid();
    this.timeout = options.timeoutMs ?? 1500; this.maximum = options.maxConcurrentPerUser ?? 2;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 5000
      || !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 8) invalid();
    this.runtime = options.tenantRuntime; this.authorize = options.authorizeSubject;
    this.authorizeFleet = options.authorizeFleet;
  }
  version(owner: Principal): string | undefined {
    const actual = lifecyclePrincipal(owner), selected = this.selected(actual);
    if (!this.enabled || !selected.length) return undefined;
    return createHash("sha256").update("lifecycle-policy-v1\0")
      .update(JSON.stringify({ owner: lifecycleOwnerKey(actual), timeoutMs: this.timeout,
        maxConcurrentPerUser: this.maximum, packages: selected.map(pkg => [pkg.id, pkg.configSha256]) })).digest("hex");
  }
  private selected(owner: Principal): readonly RegisteredLifecyclePackage[] {
    const key = lifecycleOwnerKey(owner);
    return this.packages.filter(pkg => pkg.subjects.some(subject => lifecycleOwnerKey(subject) === key));
  }
  private async run<T>(context: LifecycleOperationContext, signal: AbortSignal,
    work: (packages: readonly RegisteredLifecyclePackage[]) => T): Promise<T> {
    if (!(signal instanceof AbortSignal)) invalid();
    if (this.closed) throw new LifecycleHookError("closed");
    if (signal.aborted) throw new LifecycleHookError("cancelled");
    const selected = this.enabled ? this.selected(context.owner) : [];
    if (!selected.length) return work([]);
    const key = lifecycleOwnerKey(context.owner), count = this.counts.get(key) ?? 0;
    if (count >= this.maximum) throw new LifecycleHookError("concurrency");
    const lease = this.runtime?.enter(context.owner.tenantId, "provider"), abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true }); lease?.signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted || lease?.signal.aborted) abort.abort();
    let expired = false; const deadline = Date.now() + this.timeout;
    const timer = setTimeout(() => { expired = true; abort.abort(); }, this.timeout); timer.unref?.();
    const check = () => {
      lease?.assertOpen();
      if (expired || Date.now() >= deadline) throw new LifecycleHookError("timed_out");
      if (this.closed) throw new LifecycleHookError("closed");
      if (abort.signal.aborted) throw new LifecycleHookError("cancelled");
    };
    let resolveDone!: () => void;
    const operation: Operation = { abort, done: new Promise<void>(resolve => { resolveDone = resolve; }) };
    this.operations.add(operation); this.counts.set(key, count + 1);
    try {
      check(); await this.authorizeFleet?.(abort.signal); check();
      await this.authorize?.(context.owner); check();
      const result = work(selected); check();
      // These are actual promise waits: a slow non-cancellable authorization retains the lease.
      await this.authorize?.(context.owner); check();
      return result;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", cancel); lease?.signal.removeEventListener("abort", cancel);
      lease?.release(); this.operations.delete(operation);
      const remaining = (this.counts.get(key) ?? 1) - 1;
      if (remaining === 0) this.counts.delete(key); else this.counts.set(key, remaining);
      resolveDone();
    }
  }
  observe(context: LifecycleHookContext, signal: AbortSignal): Promise<readonly LifecycleHookReport[]> {
    const actual = hookContext(context);
    return this.run(actual, signal, packages => Object.freeze(packages.flatMap(pkg => {
      if (pkg.package !== "audit" || !pkg.phases.includes(actual.phase)) return [];
      // The built-in audit observer returns a bounded content-free fact; persistence is the Host's responsibility.
      return [Object.freeze({ packageId: pkg.id, kind: "observer" as const, phase: actual.phase,
        outcome: "observed" as const, configSha256: pkg.configSha256 })];
    })));
  }
  beforePrompt(context: LifecycleOperationContext, input: LifecyclePromptInput, signal: AbortSignal): Promise<LifecyclePromptResult> {
    const actual = operationContext(context), initial = copyLifecyclePrompt(input);
    return this.run(actual, signal, packages => {
      let value = initial; const reports: LifecycleMiddlewareReport[] = [];
      for (const pkg of packages) {
        const result = applyPromptPackage(pkg, value); if (result.report) reports.push(result.report);
        if (!result.allow) return freezeLifecycle({ ...initial, allow: false, reports }); value = result.value;
      }
      const denial = finalPromptDenial(packages, value);
      if (denial) return freezeLifecycle({ ...initial, allow: false,
        reports: reports.map(report => report.packageId === denial.packageId ? denial : report) });
      return freezeLifecycle({ ...value, allow: true, reports });
    });
  }
  beforeModelStep(context: LifecycleOperationContext, input: LifecycleModelInput, signal: AbortSignal): Promise<LifecycleModelResult> {
    const actual = operationContext(context), initial = copyLifecycleModel(input);
    return this.run(actual, signal, packages => {
      let value = initial; const reports: LifecycleMiddlewareReport[] = [];
      for (const pkg of packages) {
        const result = applyModelPackage(pkg, value); if (result.report) reports.push(result.report);
        if (!result.allow) return freezeLifecycle({ ...initial, allow: false, reports }); value = result.value;
      }
      const denial = finalModelDenial(packages, value);
      if (denial) return freezeLifecycle({ ...initial, allow: false,
        reports: reports.map(report => report.packageId === denial.packageId ? denial : report) });
      return freezeLifecycle({ ...value, allow: true, reports });
    });
  }
  beforeTool(context: LifecycleHookContext & { readonly phase: "PreToolUse" }, input: LifecycleToolInput,
    signal: AbortSignal): Promise<LifecycleToolResult> {
    const actual = hookContext(context); if (actual.phase !== "PreToolUse") invalid();
    const initial = copyLifecycleTool(input);
    return this.run(actual, signal, packages => {
      let value = initial; const reports: LifecycleMiddlewareReport[] = [];
      for (const pkg of packages) {
        const result = applyToolPackage(pkg, actual.tool.name, value); if (result.report) reports.push(result.report);
        if (!result.allow) return freezeLifecycle({ ...initial, allow: false, reports }); value = result.value;
      }
      return freezeLifecycle({ ...value, allow: true, reports });
    });
  }
  /** Process owner cancellation only: no cipher/coordination/SQL dependency is closed here. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const op of this.operations) op.abort.abort();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop();
    this.closing = (async () => {
      while (this.operations.size) await Promise.all([...this.operations].map(operation => operation.done));
    })();
    return this.closing;
  }
}
