import { describe, expect, it, vi } from "vitest";
import { LifecycleHookPhase, LifecycleHookReport, LifecycleMiddlewareReport } from "@agent-service/protocol";
import { ConfiguredLifecycleHookService } from "../src/hooks/lifecycle.js";
import { LifecycleHookError, parseLifecyclePackageDefinitions } from "../src/hooks/middleware.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import type { LifecycleHookContext, LifecycleModelInput, LifecyclePackageDefinition } from "../src/hooks/lifecycle-types.js";

const owner = { tenantId: "lifecycle-tenant", userId: "lifecycle-user" };
const base = { owner, sessionId: "session", turnId: "turn", itemId: "item", step: 1 };
const signal = () => new AbortController().signal;
const audit = (): LifecyclePackageDefinition => ({ id: "audit", package: "audit", subjects: [owner], phases: [...LifecycleHookPhase.options] });
const pre = (): LifecycleHookContext & { phase: "PreToolUse" } => ({ ...base, phase: "PreToolUse", toolCallId: "tool-call",
  tool: { name: "write", kind: "mcp", readOnly: false } });
const model = (): LifecycleModelInput => ({ step: 1, modelRef: { provider: "original", model: "model" }, systemPrompt: "system",
  input: [{ role: "user", content: [{ type: "text", text: "original user" }] }],
  limits: { maxSteps: 10, maxToolCalls: 10, maxWallClockMs: 5000, maxCostCNY: 2, maxOutputTokensPerStep: 200 } });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve };
}

describe("fixed lifecycle package service", () => {
  it("takes a fresh fleet proof before each actual package operation and preserves its real abort signal", async () => {
    const fleet = vi.fn(async (s: AbortSignal) => { expect(s).toBeInstanceOf(AbortSignal); s.throwIfAborted(); });
    const service = new ConfiguredLifecycleHookService({ packages: [audit()], authorizeFleet: fleet });
    await service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    await service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    expect(fleet).toHaveBeenCalledTimes(2);
    const refusal = new Error("fleet-unavailable"); fleet.mockRejectedValueOnce(refusal);
    await expect(service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal())).rejects.toBe(refusal);
    await service.close();
  });
  it("emits one closed content-free audit report at each actual producer phase", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [audit()] });
    const contexts: LifecycleHookContext[] = [
      { owner, sessionId: "session", phase: "SessionStart" },
      { ...base, phase: "UserPromptSubmit", submission: "initial" }, pre(),
      { ...pre(), phase: "PostToolUse", isError: false },
      { ...pre(), phase: "PermissionRequest", approvalId: "approval" },
      { ...base, phase: "PreCompact", throughSeq: 10 }, { ...base, phase: "PostCompact", throughSeq: 10 },
      { ...base, phase: "SubagentStart", subagent: { taskId: "task", childSessionId: "child", childTurnId: "child-turn" } },
      { ...base, phase: "SubagentStop", subagent: { taskId: "task", childSessionId: "child", childTurnId: "child-turn" } },
      { ...base, phase: "Stop", outcome: "completed" }, { ...base, phase: "Interrupt" },
    ];
    expect(contexts.map(c => c.phase)).toEqual(LifecycleHookPhase.options);
    for (const context of contexts) {
      const reports = await service.observe(context, signal()); expect(reports).toHaveLength(1);
      expect(LifecycleHookReport.safeParse(reports[0]).success).toBe(true);
      expect(Object.keys(reports[0]!).sort()).toEqual(["configSha256", "kind", "outcome", "packageId", "phase"]);
      expect(reports[0]?.outcome).toBe("observed"); expect(Object.isFrozen(reports)).toBe(true);
    }
    await service.close();
    // This tests the service type/registry, not a Subagent producer or durable event delivery.
  });
  it("matches exact tenant AND user and leaves unmatched/disabled owners unchanged", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [audit()] });
    expect(service.version(owner)).toMatch(/^[a-f0-9]{64}$/);
    for (const other of [{ ...owner, userId: "other" }, { ...owner, tenantId: "other" }]) {
      expect(service.version(other)).toBeUndefined();
      expect(await service.observe({ owner: other, sessionId: "s", phase: "SessionStart" }, signal())).toEqual([]);
    }
    const disabled = new ConfiguredLifecycleHookService({ enabled: false, packages: [audit()] });
    expect(disabled.version(owner)).toBeUndefined(); expect(await disabled.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal())).toEqual([]);
    await Promise.all([service.close(), disabled.close()]);
  });
  it("copies and freezes configuration, including nested rewrite arguments", async () => {
    const definition = { id: "rewrite", package: "tool-policy" as const, subjects: [{ ...owner }], denyTools: [], rewrites: [{ tool: "write", args: { value: [1] } }] };
    const service = new ConfiguredLifecycleHookService({ packages: [definition] }); const version = service.version(owner);
    definition.subjects[0]!.userId = "other"; definition.rewrites[0]!.args.value[0] = 9;
    const result = await service.beforeTool(pre(), { args: { original: true } }, signal());
    expect(result.args).toEqual({ value: [1] }); expect(service.version(owner)).toBe(version);
    expect(Object.isFrozen(result.args)).toBe(true); expect(Object.isFrozen((result.args as { value: number[] }).value)).toBe(true);
    await service.close();
  });
  it("uses a Unicode total order for equivalent ACL permutations without broadening shared Principal grammar", async () => {
    const subjects = [{ tenantId: "é", userId: "same" }, { tenantId: "e\u0301", userId: "same" }, { tenantId: "a", userId: "same" }];
    const make = (values: typeof subjects) => new ConfiguredLifecycleHookService({ packages: [{ ...audit(), subjects: values }] });
    const a = make(subjects), b = make([...subjects].reverse()); expect(a.version(subjects[0]!)).toBe(b.version(subjects[0]!));
    expect(a.version(subjects[0]!)).not.toBe(a.version(subjects[1]!));
    const unicode = { tenantId: "中".repeat(100), userId: "user" };
    const c = new ConfiguredLifecycleHookService({ packages: [{ ...audit(), subjects: [unicode] }] });
    expect(await c.observe({ owner: unicode, sessionId: "s", phase: "SessionStart" }, signal())).toHaveLength(1);
    expect(() => c.version({ tenantId: "中".repeat(129), userId: "user" })).toThrow(LifecycleHookError);
    expect(() => c.version({ tenantId: "t", userId: "*" })).toThrow(LifecycleHookError);
    await Promise.all([a.close(), b.close(), c.close()]);
  });
  it("separates owner policy versions from the full fleet configuration and binds budgets", async () => {
    const a = new ConfiguredLifecycleHookService({ packages: [audit()] });
    const b = new ConfiguredLifecycleHookService({ packages: [audit(), { ...audit(), id: "other", subjects: [{ ...owner, userId: "other" }] }] });
    const c = new ConfiguredLifecycleHookService({ packages: [audit()], timeoutMs: 200 });
    expect(a.version(owner)).toBe(b.version(owner)); expect(a.version(owner)).not.toBe(c.version(owner));
    await Promise.all([a.close(), b.close(), c.close()]);
  });
  it("performs bounded prompt rewriting without changing the caller's original message", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [{ id: "prompt", package: "prompt-policy", subjects: [owner], prependText: "prefix", appendText: "append", maxPromptBytes: 200 }] });
    const input = { input: [{ type: "text" as const, text: "user" }] };
    const result = await service.beforePrompt(base, input, signal());
    expect(result.allow).toBe(true); expect(result.input).toEqual([{ type: "text", text: "prefix" }, ...input.input, { type: "text", text: "append" }]);
    expect(input.input).toEqual([{ type: "text", text: "user" }]);
    expect(LifecycleMiddlewareReport.safeParse(result.reports[0]).success).toBe(true); expect(result.reports[0]?.stage).toBe("prompt");
    const denied = await service.beforePrompt(base, { input: [{ type: "text", text: "x".repeat(250) }] }, signal());
    expect(denied.allow).toBe(false); expect(denied.reports[0]?.outcome).toBe("denied"); await service.close();
  });
  it("injects both memory slots and routes ModelRef while preserving all history and tightening limits", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [
      { id: "memory", package: "memory-injection", subjects: [owner], prefix: "before", append: "after" },
      { id: "policy", package: "prompt-policy", subjects: [owner], modelRef: { provider: "approved", model: "small" }, limits: { maxSteps: 100, maxCostCNY: 1, maxOutputTokensPerStep: 50 } },
    ] });
    const input = model(), result = await service.beforeModelStep(base, input, signal());
    expect(result.systemPrompt).toBe("before\nsystem\nafter"); expect(result.modelRef).toEqual({ provider: "approved", model: "small" });
    expect(result.limits).toEqual({ ...input.limits, maxCostCNY: 1, maxOutputTokensPerStep: 50 });
    expect(result.input).toEqual(input.input); expect(result.input).not.toBe(input.input); expect(input.systemPrompt).toBe("system");
    expect(result.reports.map(r => [r.stage, r.outcome])).toEqual([["model", "modified"], ["model", "modified"]]);
    await service.close();
  });
  it("cannot bypass an earlier prompt/system cap by appending in a later package", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [
      { id: "cap", package: "prompt-policy", subjects: [owner], maxPromptBytes: 80, maxSystemPromptBytes: 20 },
      { id: "append", package: "prompt-policy", subjects: [owner], appendText: "x".repeat(100) },
      { id: "memory", package: "memory-injection", subjects: [owner], prefix: "x".repeat(50), append: "" },
    ] });
    const prompt = await service.beforePrompt(base, { input: [{ type: "text", text: "user" }] }, signal());
    expect(prompt.allow).toBe(false); expect(prompt.reports.find(r => r.packageId === "cap")?.outcome).toBe("denied");
    const result = await service.beforeModelStep(base, model(), signal());
    expect(result.allow).toBe(false); expect(result.reports.find(r => r.packageId === "cap")?.outcome).toBe("denied");
    await service.close();
  });
  it("rejects missing effective limits and unknown model request fields rather than granting a fallback", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [audit()] });
    expect(() => service.beforeModelStep(base, { ...model(), limits: {} } as LifecycleModelInput, signal())).toThrow(LifecycleHookError);
    expect(() => service.beforeModelStep(base, { ...model(), headers: { authorization: "private" } } as LifecycleModelInput, signal())).toThrow(LifecycleHookError);
    expect(() => service.beforeModelStep(base, { ...model(), input: [{ role: "system", text: "system", secret: "private" }] } as unknown as LifecycleModelInput, signal())).toThrow(LifecycleHookError);
    await service.close();
  });
  it("rewrites only independent arguments or denies, never tool identity/approval fields", async () => {
    const service = new ConfiguredLifecycleHookService({ packages: [{ id: "tool", package: "tool-policy", subjects: [owner], denyTools: ["remove"], rewrites: [{ tool: "write", args: { permitted: true } }] }] });
    const original = { args: { permitted: false } }, context = pre();
    expect(await service.beforeTool(context, original, signal())).toMatchObject({ allow: true, args: { permitted: true } });
    expect(original.args).toEqual({ permitted: false }); expect(context.tool).toEqual({ name: "write", kind: "mcp", readOnly: false });
    expect(await service.beforeTool({ ...pre(), tool: { ...pre().tool, name: "remove" } }, original, signal())).toMatchObject({ allow: false });
    await service.close();
  });
  it("revalidates actual authority before and after every package operation without swallowing source failures", async () => {
    const authorization = vi.fn(async () => {}), service = new ConfiguredLifecycleHookService({ packages: [audit()], authorizeSubject: authorization });
    await service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    expect(authorization.mock.calls).toHaveLength(2); expect(authorization.mock.calls[0]).toEqual([owner]);
    const failure = new Error("source-fence-canary"); authorization.mockRejectedValueOnce(failure);
    await expect(service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal())).rejects.toBe(failure);
    await service.close();
  });
  it("retains the real runtime lease through a non-cancellable authorization on timeout and close", async () => {
    const runtime = new TenantRuntimeCoordinator(), entered = deferred(), release = deferred();
    const service = new ConfiguredLifecycleHookService({ packages: [audit()], timeoutMs: 100, tenantRuntime: runtime,
      authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const observed = service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    const rejection = expect(observed).rejects.toMatchObject({ code: "timed_out" }); await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 120)); let closed = false; const closing = service.close().then(() => { closed = true; });
    expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(1); await Promise.resolve(); expect(closed).toBe(false);
    release.resolve(); await rejection; await closing; expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(0);
  });
  it("fences new operations on close and keeps per-user concurrency independent", async () => {
    const entered = deferred(), release = deferred();
    const service = new ConfiguredLifecycleHookService({ packages: [audit()], maxConcurrentPerUser: 1,
      authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const work = service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    const rejection = expect(work).rejects.toMatchObject({ code: "closed" }); await entered.promise;
    await expect(service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal())).rejects.toMatchObject({ code: "concurrency" });
    const closing = service.close(); await expect(service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal())).rejects.toMatchObject({ code: "closed" });
    release.resolve(); await rejection; await closing;
  });
  it("does not convert a real caller abort into a package grant", async () => {
    const controller = new AbortController(), entered = deferred(), release = deferred();
    const service = new ConfiguredLifecycleHookService({ packages: [audit()], authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const work = service.beforePrompt(base, { input: [{ type: "text", text: "user" }] }, controller.signal);
    const rejection = expect(work).rejects.toMatchObject({ code: "cancelled" }); await entered.promise; controller.abort(); release.resolve(); await rejection; await service.close();
  });
  it("keeps a fenced tenant operation visible until its actual authorization query settles", async () => {
    const runtime = new TenantRuntimeCoordinator(); runtime.sealParticipants();
    const entered = deferred(), release = deferred();
    const service = new ConfiguredLifecycleHookService({ packages: [audit()], tenantRuntime: runtime,
      authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const work = service.observe({ owner, sessionId: "s", phase: "SessionStart" }, signal());
    const rejection = expect(work).rejects.toBeDefined(); await entered.promise;
    const identity = { requestId: "request", tenantId: owner.tenantId, subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) };
    let drained = false; const drain = runtime.drain(identity, 1000).then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(1);
    release.resolve(); await rejection; await drain; expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(0); await service.close();
  });
  it.each([
    { packageId: "audit", kind: "observer", phase: "ModelStep", outcome: "observed", configSha256: "a".repeat(64) },
    { packageId: "audit", kind: "observer", phase: "Stop", outcome: "observed", configSha256: "a".repeat(64), body: "private" },
    { packageId: "audit", kind: "observer", phase: "Stop", outcome: "observed", configSha256: "a".repeat(64), owner },
    { packageId: "audit", kind: "observer", phase: "Stop", outcome: "observed", configSha256: "a".repeat(64), error: "private" },
  ])("keeps the public observer report closed and distinct from model middleware (%#)", report => {
    expect(LifecycleHookReport.safeParse(report).success).toBe(false);
  });
  it.each([
    { package: "module", path: "/private/code.js" }, { ...audit(), headers: {} }, { ...audit(), fetch: () => {} },
    { ...audit(), phases: ["PreToolUse", "PreToolUse"] }, { ...audit(), subjects: [owner, owner] },
    { id: "policy", package: "prompt-policy", subjects: [owner], modelRef: { provider: "x", model: "y", headers: {} } },
    { id: "policy", package: "prompt-policy", subjects: [owner], limits: { maxSteps: 0 } },
    { id: "tool", package: "tool-policy", subjects: [owner], denyTools: ["write"], rewrites: [{ tool: "write", args: {} }] },
    { id: "memory", package: "memory-injection", subjects: [owner], prefix: "x\u0000", append: "" },
  ])("rejects unknown registry capabilities and malformed policy without echoing material (%#)", value => {
    expect(() => parseLifecyclePackageDefinitions([value])).toThrowError(new Error("Invalid lifecycle hooks operator configuration"));
  });
  it("rejects accessor, non-JSON and context extensions without invoking them", async () => {
    const getter = vi.fn(() => "secret"), service = new ConfiguredLifecycleHookService({ packages: [audit()] });
    const args = Object.defineProperty({}, "private", { enumerable: true, get: getter });
    expect(() => service.beforeTool(pre(), { args }, signal())).toThrow(LifecycleHookError); expect(getter).not.toHaveBeenCalled();
    expect(() => service.observe({ ...pre(), rawResult: "secret" } as LifecycleHookContext, signal())).toThrow(LifecycleHookError);
    expect(() => service.beforeTool(pre(), { args: NaN }, signal())).toThrow(LifecycleHookError); await service.close();
  });
});
