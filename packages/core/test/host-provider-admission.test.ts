import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, isPersistedEvent, type AgentDefinition, type Event, type SubagentPolicy } from "@agent-service/protocol";
import {
  MemoryEventBus, MemoryProviderQuotaCoordinator, MemorySessionStore,
  assertSubagentMemberAccess, createSubagentRootAccess,
  newUserDataExportRequestId, userDataExportAuthorization, userDataExportIdempotencyKeySha256, userDataExportRequestHash,
  type ProviderQuotaLease, type ProviderQuotaLimit,
} from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "../../providers/src/index.js";
import {
  PiEngine, PiSummariser, SessionHost, StaticToolRegistry, createPersistedProviderFailureCapture,
  newId, type RunnerTool, type SessionHostDeps,
} from "../src/index.js";
import { activateMemoryPersistedProviderCapture } from "./persisted-provider-capture-fixture.js";

const principal = { tenantId: "host-admission-tenant", userId: "host-admission-user" };
const providerId = "host-admission-provider";
const reference = { provider: providerId, model: "root-model" };
const privateKey = "test-only-host-provider-key";
const privateFailure = "private-upstream-admission-canary";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(close => close()));
  vi.restoreAllMocks();
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
});

type Answer = string | { name: "echo" | "task"; args: Record<string, string> };
function completion(answer: Answer) {
  const common = { id: "chatcmpl-host-admission", object: "chat.completion.chunk", created: 1, model: reference.model };
  const delta = typeof answer === "string" ? { role: "assistant", content: answer } : {
    role: "assistant", tool_calls: [{ index: 0, id: "call-host-admission", type: "function",
      function: { name: answer.name, arguments: JSON.stringify(answer.args) } }],
  };
  const chunks = [
    { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: typeof answer === "string" ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

async function fixture(options: {
  limit?: ProviderQuotaLimit; unpriced?: boolean; upstreamFailure?: boolean;
  family?: "task" | "echo"; answer?: (dispatch: number) => Answer;
  response?: (dispatch: number) => Response | Promise<Response>;
} = {}) {
  const refKey = new Uint8Array(32).fill(59);
  const store = new MemorySessionStore({ now: () => Date.now() }, {
    tenantTelemetryRefKey: refKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true,
  });
  const bus = new MemoryEventBus(), lease = store.sessionAuthority;
  const quota = new MemoryProviderQuotaCoordinator({ store: "memory", prefix: "host-admission", namespaceId: "fixture" });
  const held: ProviderQuotaLease[] = [], subscriptions: (() => void)[] = [];
  let host: SessionHost | undefined;
  cleanups.push(async () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    try { await host?.drain(2_000); }
    finally {
      const results = await Promise.allSettled(held.map(slot => slot.release()));
      const closed = await Promise.allSettled([quota.close(), lease.close(), bus.close(), store.close()]);
      const failed = [...results, ...closed].find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  });
  await activateMemoryPersistedProviderCapture(store);
  await store.createApiKey(principal.tenantId, "host-admission-capture-key", "fixture-only-key-hash");
  let dispatches = 0;
  const delegate = vi.fn<typeof fetch>(async () => {
    dispatches++;
    if (options.upstreamFailure) throw new Error(privateFailure);
    if (options.response) return options.response(dispatches);
    return completion(options.answer?.(dispatches) ?? "actual Pi response");
  });
  const service = new ProviderService({ store, cipher: new LocalAesGcmCipher("19".repeat(32)), fetch: delegate,
    assertBaseUrl: async () => {}, persistedProviderFailureCaptureActive: true,
    quota: { coordinator: quota, tenant: options.limit ?? {}, user: {} } });
  await service.upsertTenantProvider(principal.tenantId, {
    id: providerId, api: "openai-completions", baseUrl: "https://provider.example/v1", apiKey: privateKey,
    headers: {}, quota: {}, fallback: [], models: [reference.model, "child-model"].map(id => ({
      id, contextWindow: 32_000, maxOutputTokens: 100, input: ["text" as const], reasoning: false,
      ...(!options.unpriced ? { price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
    })),
  });
  const product = createPersistedProviderFailureCapture({ store, opaqueRefKey: refKey, requireFreshFleet: async proof => proof });
  const capture: NonNullable<SessionHostDeps["persistedProviderFailureCapture"]> = {
    commit: vi.fn((batch, source) => product.commit(batch, source)),
  };
  const echoCalls: unknown[] = [];
  const echo: RunnerTool = { name: "echo", kind: "builtin", readOnly: false, description: "echo fixture",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    execute: async args => { echoCalls.push(args); return { content: [{ type: "text", text: "echo result" }] }; } };
  const base = { tenantId: principal.tenantId, version: 1, mcpServers: [], skills: [], limits: {},
    approvalPolicy: "never" as const, busyPolicy: "reject" as const, sandbox: "none" as const, metadata: {}, createdAtMs: Date.now() };
  const child: AgentDefinition = { ...base, id: newId("agt"), name: "child", instructions: "child fixture",
    model: { provider: providerId, model: "child-model" }, tools: [] };
  const policy: SubagentPolicy = { allowSelf: false, targets: [{ name: "worker", agentId: child.id, agentVersion: 1 }],
    maxDepth: 3, maxConcurrent: 2, maxTasks: 8, limits: {}, context: "prompt" };
  const agent: AgentDefinition = { ...base, id: newId("agt"), name: "root", instructions: "root fixture", model: reference,
    tools: options.family === "echo" ? ["task", "echo"] : options.family ? ["task"] : [],
    ...(options.family ? { subagents: policy } : {}) };
  await store.createAgent(child); await store.createAgent(agent);
  const engine = new PiEngine(service.models);
  host = new SessionHost({ store, bus, lease, engine, summariser: new PiSummariser(service.models),
    providers: service, tools: new StaticToolRegistry([echo]), persistedProviderFailureCapture: capture,
    ...(options.family ? { subagents: { enabled: true, maxDepth: 3, maxConcurrent: 2, maxTasks: 8 },
      authorizeRuntimeExtensions: async (signal: AbortSignal) => { signal.throwIfAborted(); } } : {}),
    logger: { info() {}, warn() {}, error() {} },
    config: { runnerId: "host-admission", runnerAddr: "127.0.0.1:1", leaseTtlMs: 5_000, leaseHoldMs: 1 } });
  const session = await host.createSession(principal, { agentId: agent.id, metadata: {} });
  const live: Event[] = [];
  subscriptions.push(await host.subscribe(principal, session.id, 0, event => { live.push(structuredClone(event)); }));
  return { store, quota, host, session, live, capture, delegate, echoCalls, service, engine,
    reserve: async () => {
      const slot = await quota.enter({ ...principal, provider: { scope: "tenant", id: providerId },
        tenant: options.limit ?? {}, user: {}, providerLimit: {} }, new AbortController().signal);
      held.push(slot); return slot;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function turn(f: Fixture, text = "fixture input") {
  const begun = await f.host.beginTurn(principal, f.session.id, { input: [{ type: "text", text }], stream: true, metadata: {} });
  begun.run();
  await vi.waitFor(() => expect(f.host.activeTurn(f.session.id)).toBeUndefined());
  return { begun, result: await f.store.getTurn(f.session.id, begun.turn.id),
    events: await f.store.readEvents(f.session.id, 0, 1000),
    items: await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 }) };
}
async function family(f: Fixture, turnId: string) {
  const session = await f.store.getSession(principal.tenantId, f.session.id);
  expect(session).not.toBeNull();
  return f.store.getSubagentRoot({ access: createSubagentRootAccess({ principal, rootSessionId: f.session.id,
    rootTurnId: turnId, rootFence: session!.fenceToken }) });
}
function noPrivateOutput(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(privateKey); expect(text).not.toContain(privateFailure);
}

async function seedCompactionHistory(f: Fixture) {
  for (let index = 0; index < 3; index++) {
    expect((await turn(f, `history ${index} ` + "input ".repeat(80))).result?.status).toBe("completed");
  }
  return { items: await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 }),
    events: await f.store.readEvents(f.session.id, 0, 1000), usage: structuredClone(f.store.usageLedger),
    turns: await f.store.listTurns(f.session.id, { limit: 1000 }),
    session: (await f.store.getSession(principal.tenantId, f.session.id))! };
}

async function assertFailedCompaction(f: Fixture, before: Awaited<ReturnType<typeof seedCompactionHistory>>, knownCost = false) {
  expect(f.delegate).toHaveBeenCalledTimes(4);
  expect(f.capture.commit).not.toHaveBeenCalled();
  expect(await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 })).toEqual(before.items);
  const session = (await f.store.getSession(principal.tenantId, f.session.id))!;
  expect(session.lastCompactionSeq).toBe(before.session.lastCompactionSeq);
  expect(session.status).toEqual(before.session.status);
  expect(f.store.usageLedger).toHaveLength(before.usage.length + 1);
  const usage = f.store.usageLedger.at(-1)!;
  expect(usage).toMatchObject({ tenantId: principal.tenantId, userId: principal.userId, sessionId: f.session.id,
    step: 0, provider: `${principal.tenantId}:${providerId}`, model: reference.model });
  expect(usage.usageId).toBeDefined();
  if (knownCost) expect(usage.usage).toMatchObject({ inputTokens: 2, outputTokens: 1, totalTokens: 3, costCNY: 0 });
  else expect(Object.hasOwn(usage.usage, "costCNY")).toBe(false);
  const billed = f.store.billingUsageFacts.get(usage.usageId!);
  expect(billed).toMatchObject({ usageId: usage.usageId, tenantId: principal.tenantId, provider: usage.provider, model: usage.model });
  expect(Object.hasOwn(billed!, "costCNY")).toBe(knownCost);
  const failed = await f.store.getTurn(f.session.id, usage.turnId);
  expect(failed).toMatchObject({ sessionId: f.session.id, status: "failed", stopReason: "error", steps: 0, toolCalls: 0,
    model: { provider: usage.provider, model: usage.model }, usage: usage.usage,
    error: { code: "provider_error", message: "Provider request failed." } });
  expect((await f.store.listTurns(f.session.id, { limit: 1000 })).data).toHaveLength(before.turns.data.length + 1);
  const events = await f.store.readEvents(f.session.id, before.session.lastSeq, 1000);
  expect(events.map(event => event.type)).toEqual(["turn/started", "usage/updated", "error", "turn/completed"]);
  expect(events.find(event => event.type === "usage/updated")).toMatchObject({ turnId: usage.turnId, step: 0,
    stepUsage: usage.usage, turnUsage: usage.usage });
  expect(events.find(event => event.type === "error")).toMatchObject({ turnId: usage.turnId,
    code: "provider_error", message: "Provider request failed." });
  expect(failed!.seqStart).toBe(events[0]!.seq); expect(failed!.seqEnd).toBe(events.at(-1)!.seq);
  // Every event and ledger reference has a real canonical owner, rather than a summary-shaped orphan.
  for (const event of events) if ("turnId" in event && event.turnId) {
    expect(await f.store.getTurn(f.session.id, event.turnId)).not.toBeNull();
  }
  noPrivateOutput([session, failed, events, usage, billed]);
  return { session, failed, events, usage };
}

async function assertCompactionFailureExportOwner(f: Fixture, expectedTurns: number, expectedUsage: number) {
  await f.store.putRetentionPolicy({ tenantId: principal.tenantId, policyVersion: "compaction-export-v1", actorKeyId: "fixture-admin", atMs: Date.now(),
    policy: { sessionContentRetentionMs: 0, userErasureGraceMs: 0, operationalUsageRetentionMs: null,
      idempotencyReceiptRetentionMs: null, billingFactRetentionMs: null, lifecycleAuditRetentionMs: null, exportArtifactTtlMs: 60_000 } });
  await f.store.activateRetentionPolicy({ tenantId: principal.tenantId, policyVersion: "compaction-export-v1", expectedControlGeneration: 0,
    actorKeyId: "fixture-admin", atMs: Date.now() });
  const request = await f.store.requestUserDataExport({ ...principal, requestId: newUserDataExportRequestId(), requestedByKeyId: "fixture-admin",
    idempotencyKeySha256: userDataExportIdempotencyKeySha256("compaction-failure-owner"),
    requestHash: userDataExportRequestHash(principal.tenantId, principal.userId) });
  const [claim] = await f.store.claimUserDataExports({ limit: 1, leaseMs: 1_000, claimToken: "compaction-owner" });
  expect(claim?.requestId).toBe(request.requestId);
  const snapshot = await f.store.captureAndSealUserDataExportSnapshot(userDataExportAuthorization(claim!));
  expect(snapshot.counts.turn).toBe(expectedTurns); expect(snapshot.counts.operational_usage).toBe(expectedUsage);
}

// Actual Pi/OpenAI adapter -> ProviderService -> Memory quota -> Host/canonical Memory store.
// Synthetic SSE Response bytes are not native Redis, HTTP SSE, or real vendor billing proof.
describe("Host server-owned provider admission", () => {
  it("publishes a fixed quota denial without inventing usage, a failed assistant, or a 0053 source", async () => {
    const f = await fixture({ limit: { concurrency: 1 } });
    await f.reserve();
    const result = await turn(f);
    expect(result.result).toMatchObject({ status: "failed", stopReason: "error",
      error: { code: "quota_exceeded", message: "Provider quota exceeded." } });
    const expected = [{ code: "quota_exceeded", message: "Provider quota exceeded.", turnId: result.begun.turn.id }];
    expect(result.events.filter(event => event.type === "error")).toMatchObject(expected);
    expect(f.live.filter(event => event.type === "error")).toMatchObject(expected);
    expect(f.live.filter(isPersistedEvent).map(event => event.seq)).toEqual(result.events.map(event => event.seq));
    expect(result.items.filter(item => item.type === "agentMessage")).toEqual([]);
    expect(result.events.filter(event => event.type === "usage/updated")).toEqual([]);
    expect(f.live.filter(event => event.type === "usage/updated")).toEqual([]);
    expect(f.store.usageLedger).toEqual([]);
    expect(f.capture.commit).not.toHaveBeenCalled(); expect(f.delegate).not.toHaveBeenCalled();
    noPrivateOutput([result, f.live]);
  });

  it("retains real dispatched provider failure provenance, unknown cost, and the original atomic 0053 capture", async () => {
    const f = await fixture({ upstreamFailure: true, unpriced: true });
    const result = await turn(f);
    expect(f.delegate).toHaveBeenCalledOnce(); expect(f.capture.commit).toHaveBeenCalledOnce();
    expect(result.result).toMatchObject({ status: "failed", error: { code: "provider_error", message: "Provider request failed." } });
    const failed = result.items.filter(item => item.type === "agentMessage" && item.status === "failed");
    expect(failed).toHaveLength(1);
    expect(result.events.filter(event => event.type === "usage/updated")).toHaveLength(1);
    expect(f.store.usageLedger).toHaveLength(1);
    expect(Object.hasOwn(f.store.usageLedger[0]!.usage, "costCNY")).toBe(false);
    const proof = await f.store.getTenantTelemetryPersistedProviderCaptureBinding();
    expect(proof).not.toBeNull();
    expect(await f.store.verifyPersistedProviderStepFailureSource({ tenantId: principal.tenantId,
      sessionId: f.session.id, turnId: result.begun.turn.id, itemId: failed[0]!.id, stepIndex: 1, freshProof: proof! }))
      .toMatchObject({ status: "source_verified_queued", sourceCount: 1, executionReady: false, allDomainsComplete: false });
    noPrivateOutput([result, f.live]);
  });

  it("keeps compaction admission failure as fixed 429 rather than silently skipping it", async () => {
    const f = await fixture({ limit: { concurrency: 1 }, answer: () => "history answer ".repeat(80) });
    for (let index = 0; index < 3; index++) expect((await turn(f, `history ${index} ` + "input ".repeat(80))).result?.status).toBe("completed");
    const items = await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 });
    const events = await f.store.readEvents(f.session.id, 0, 1000), usage = structuredClone(f.store.usageLedger);
    expect(items.filter(item => item.type === "agentMessage")).toHaveLength(3);
    await f.reserve();
    await expect(f.host.compactSession(principal, f.session.id)).rejects.toMatchObject({
      name: "ApiError", code: "quota_exceeded", message: "Provider quota exceeded.", status: 429,
    } satisfies Partial<ApiError>);
    expect(f.delegate).toHaveBeenCalledTimes(3);
    expect(await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 })).toEqual(items);
    expect(await f.store.readEvents(f.session.id, 0, 1000)).toEqual(events);
    expect(f.store.usageLedger).toEqual(usage); expect(f.capture.commit).not.toHaveBeenCalled();
  });

  it("accounts for a dispatched manual compaction 503 with a real failed step0 turn and complete export ownership", async () => {
    const f = await fixture({ response: dispatch => dispatch <= 3 ? completion("history answer ".repeat(80))
      : new Response(privateFailure, { status: 503 }) });
    const before = await seedCompactionHistory(f);
    await expect(f.host.compactSession(principal, f.session.id)).rejects.toMatchObject({ code: "provider_error", message: "Provider request failed." });
    const result = await assertFailedCompaction(f, before);
    expect(result.usage.usage.totalTokens).toBe(0); expect(Object.hasOwn(result.session.usage, "costCNY")).toBe(false);
    await assertCompactionFailureExportOwner(f, 4, 4);
  });

  it("stops automatic main-turn admission after a dispatched compaction 503 rather than silently continuing", async () => {
    const f = await fixture({ response: dispatch => dispatch <= 3 ? completion("history answer ".repeat(80))
      : new Response(privateFailure, { status: 503 }) });
    const before = await seedCompactionHistory(f);
    const current = (await f.store.getProviderConfig(principal.tenantId, providerId))!.config;
    await f.service.upsertTenantProvider(principal.tenantId, { ...current,
      models: current.models.map(model => ({ ...model, contextWindow: 1_000 })) });
    const started = vi.spyOn(f.engine, "start");
    await expect(f.host.beginTurn(principal, f.session.id, { input: [{ type: "text", text: "new input after compaction" }],
      stream: true, metadata: {} })).rejects.toMatchObject({ code: "provider_error", message: "Provider request failed." });
    expect(started).not.toHaveBeenCalled();
    await assertFailedCompaction(f, before);
  });

  it("retains the legitimate configured estimate for a dispatched successful but empty compaction response", async () => {
    const f = await fixture({ response: dispatch => completion(dispatch <= 3 ? "history answer ".repeat(80) : "") });
    const before = await seedCompactionHistory(f);
    await expect(f.host.compactSession(principal, f.session.id)).rejects.toMatchObject({ code: "provider_error", message: "Provider request failed." });
    await assertFailedCompaction(f, before, true);
  });

  it("rolls failed compaction accounting back without dispatching or retrying a second vendor request", async () => {
    const f = await fixture({ response: dispatch => dispatch <= 3 ? completion("history answer ".repeat(80))
      : new Response(privateFailure, { status: 503 }) });
    const before = await seedCompactionHistory(f), billing = structuredClone([...f.store.billingUsageFacts]);
    const commit = f.store.commit.bind(f.store), failure = new Error("compaction-accounting-commit-fixture");
    const accounting = vi.spyOn(f.store, "commit").mockImplementation(async batch => {
      if (batch.usageEntries?.some(entry => entry.step === 0)) throw failure;
      return commit(batch);
    });
    await expect(f.host.compactSession(principal, f.session.id)).rejects.toBe(failure);
    expect(accounting.mock.calls.filter(([batch]) => batch.usageEntries?.some(entry => entry.step === 0))).toHaveLength(1);
    expect(f.delegate).toHaveBeenCalledTimes(4); expect(f.capture.commit).not.toHaveBeenCalled();
    expect(await f.store.listItems(f.session.id, { afterSeq: 0, limit: 1000 })).toEqual(before.items);
    expect(await f.store.readEvents(f.session.id, 0, 1000)).toEqual(before.events);
    expect(await f.store.listTurns(f.session.id, { limit: 1000 })).toEqual(before.turns);
    expect(f.store.usageLedger).toEqual(before.usage); expect([...f.store.billingUsageFacts]).toEqual(billing);
    const session = (await f.store.getSession(principal.tenantId, f.session.id))!;
    expect(session.lastSeq).toBe(before.session.lastSeq); expect(session.usage).toEqual(before.session.usage);
    expect(session.lastCompactionSeq).toBe(before.session.lastCompactionSeq);
  });

  it("denies a real delegated child before family provider admission and does not mark the unattempted child unknown", async () => {
    const f = await fixture({ family: "task", limit: { rpm: 1 }, answer: () => ({ name: "task", args: { target: "worker", prompt: "explicit child input" } }) });
    const admitted = vi.spyOn(f.store, "admitSubagentBudget");
    const result = await turn(f);
    const tasks = await f.host.listDelegatedTasks(principal, f.session.id, result.begun.turn.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.status).toBe("failed"); expect(task.childTurnId).toBeDefined();
    expect(await f.store.getTurn(task.childSessionId, task.childTurnId!)).toMatchObject({ status: "failed",
      error: { code: "quota_exceeded", message: "Provider quota exceeded." } });
    const providerAdmissions = admitted.mock.calls.map(([input]) => input).filter(input => input.kind === "provider_step");
    expect(providerAdmissions).toHaveLength(1);
    expect(providerAdmissions.map(input => ({ sessionId: assertSubagentMemberAccess(input.access).sessionId, step: input.step })))
      .toEqual([{ sessionId: f.session.id, step: 1 }]);
    expect(f.delegate).toHaveBeenCalledOnce();
    expect(f.store.usageLedger.filter(row => row.sessionId === task.childSessionId)).toEqual([]);
    expect((await f.store.readEvents(task.childSessionId, 0, 1000)).filter(event => event.type === "usage/updated")).toEqual([]);
    expect((await f.store.listItems(task.childSessionId, { afterSeq: 0, limit: 1000 })).filter(item => item.type === "agentMessage")).toEqual([]);
    expect(await family(f, result.begun.turn.id)).toMatchObject({ state: "terminal", steps: 1, taskCount: 1, activeTasks: 0 });
    expect(f.store.usageLedger).toHaveLength(1); expect(f.capture.commit).not.toHaveBeenCalled();
    noPrivateOutput([result, tasks]);
  });

  it("admits each actually dispatched step once in an ordinary two-step root family", async () => {
    const f = await fixture({ family: "echo", answer: dispatch => dispatch === 1
      ? { name: "echo", args: { value: "actual tool input" } } : "finished" });
    const admitted = vi.spyOn(f.store, "admitSubagentBudget");
    const result = await turn(f);
    expect(result.result?.status).toBe("completed"); expect(f.delegate).toHaveBeenCalledTimes(2);
    expect(f.echoCalls).toEqual([{ value: "actual tool input" }]);
    const providerCalls = admitted.mock.calls.map(([input], index) => ({ input, result: admitted.mock.results[index]! }))
      .filter(call => call.input.kind === "provider_step");
    expect(providerCalls.map(call => call.input.step)).toEqual([1, 2]);
    for (const call of providerCalls) {
      expect(call.result.type).toBe("return");
      await expect(call.result.value).resolves.toMatchObject({ admitted: true, replayed: false });
    }
    expect(await family(f, result.begun.turn.id)).toMatchObject({ state: "terminal", steps: 2, toolCalls: 1, taskCount: 0, familyUsage: { totalTokens: 6 } });
    expect(f.store.usageLedger.map(row => row.step)).toEqual([1, 2]);
    expect(result.events.filter(event => event.type === "usage/updated")).toHaveLength(2);
    expect(f.capture.commit).not.toHaveBeenCalled();
  });
});
