import { randomBytes } from "node:crypto";
import { expect, vi } from "vitest";
import {
  ConfiguredLifecycleHookService, ConfiguredMcpToolSource, PiEngine, SessionHost,
  StaticToolRegistry, TenantRuntimeCoordinator,
} from "@agent-service/core";
import {
  AgentDefinition, Approval, Event, Item, LifecycleHookPhase, Session, SubagentTaskStatusResponse, Turn,
  type PersistedEvent, type Principal, type Usage,
} from "@agent-service/protocol";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import {
  createSubagentRootAccess, attachSessionWriteAdmission, MemoryEventBus,
  type SessionStore, type SubjectLifecycleStore, type SubagentRootRecord, type SubagentTaskRecord,
} from "@agent-service/store";
import { FakeMcp, FakeVendor } from "@agent-service/testkit";
import { createApp } from "../../src/app.js";
import { hashApiKey } from "../../src/auth.js";
import { acquireFixedFixtureAuthority } from "./session-authority.js";

const PARENT_PROMPT = "PARENT_PRIVATE_PROMPT_NOT_CHILD_HISTORY";
const CHILD_PROMPT = "CHILD_EXPLICIT_TASK_PROMPT";
const ORIGINAL = "model-original-mcp-argument", EFFECTIVE = "middleware-effective-mcp-argument";
const DYNAMIC = "client_echo", OMITTED = "parent_only_client_tool";
const DYNAMIC_RESULT = "root-addressed-client-result";
const CHILD_FINAL = "Child used the actual MCP and client result.";
const PARENT_FINAL = "Parent resumed after the real child completed.";
const SHARED_CALL_ID = "same_model_call_id_in_parent_and_child";
const DYNAMIC_CALL_ID = "child_client_call";
const PARAMETERS = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
function failed(): never { throw new Error("Subagent source-App vertical failed."); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed(); return value as Record<string, unknown>;
}
const ERROR_NAMES = new Set(["Error", "TypeError", "AssertionError", "ApiError", "SubagentIntegrityError", "SubagentConflictError",
  "SubagentManagedSessionError", "SubagentLifecycleBlockedError", "LifecycleHookError", "SubjectDeletingError", "FenceError", "SessionAuthorityError", "SessionAuthorityConflictError"]);
const ERROR_CODES = new Set(["invalid_request", "internal_error", "state_conflict", "not_found", "draining", "session_lease_conflict",
  "subject_deleting", "forbidden", "cancelled", "timed_out", "invalid", "closed", "concurrency", "session_authority_unavailable",
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_SIGNAL_EXCEPTION", "ER_TABLEACCESS_DENIED_ERROR", "ER_PROCACCESS_DENIED_ERROR",
  "PROTOCOL_CONNECTION_LOST", "ETIMEDOUT", "ECONNRESET", "ER_QUERY_INTERRUPTED"]);
function closedFailure(error: unknown) {
  const value = error instanceof Error ? error : undefined;
  const code = value && "code" in value ? value.code : undefined;
  const frames: { file: string; line: number; column: number }[] = [];
  // No message/cause, absolute path, URL, args, headers or prompt enters this bounded diagnostic.
  for (const match of (value?.stack ?? "").slice(0, 32_768).matchAll(/[/\\](host|subagent-state|memory-subagents|subagents|memory|lifecycle|policy|subagents-vertical|store|session-authority|authority)\.ts:(\d{1,6}):(\d{1,6})/g)) {
    frames.push({ file: `${match[1]}.ts`, line: Number(match[2]), column: Number(match[3]) }); if (frames.length === 4) break;
  }
  return { name: value && ERROR_NAMES.has(value.name) ? value.name : "unknown", code: typeof code === "string" && ERROR_CODES.has(code) ? code : null, frames };
}
async function wait<T>(read: () => Promise<T | undefined> | T | undefined, signal: AbortSignal): Promise<T> {
  const until = performance.now() + 8_000;
  while (!signal.aborted && performance.now() < until) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  failed();
}
function tokenShape(value: Usage) {
  const { costCNY, ...tokens } = value; expect(costCNY).toBeGreaterThan(0); expect(Number.isFinite(costCNY)).toBe(true); return tokens;
}

export interface SubagentsVerticalOptions {
  /** Caller owns the store/database, including close and success-only physical cleanup. */
  store: SessionStore & SubjectLifecycleStore;
  profile: "source-app-memory" | "source-app-mysql";
  onOwnedServicesClosed?: () => void;
}
export interface SubagentsVerticalResult {
  profile: SubagentsVerticalOptions["profile"];
  owner: Principal;
  rootSessionId: string;
  rootTurnId: string;
  childSessionId: string;
  childTurnId: string;
  task: SubagentTaskRecord;
  family: SubagentRootRecord;
  /** Confirmed/released P2 observation owner, not the historical family root fence. */
  postTurnObservationFence: number;
  parentEvents: PersistedEvent[];
  childEvents: PersistedEvent[];
  parentItems: Item[];
  childItems: Item[];
  providerRequests: number;
  remoteCalls: number;
  fleetSeamAdmissions: number;
}

/** Real Hono auth/routes + SessionHost task producer + Pi + local HTTP model/MCP. App.request
 * dispatch and the explicit always-success fleet seam are NOT separate-process/router nonce proof.
 * No engine, tool executor, Store mutation or delegation producer is replaced by a test double. */
export async function runSubagentsVertical(options: SubagentsVerticalOptions): Promise<SubagentsVerticalResult> {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
  const nonce = randomBytes(12).toString("hex"), owner = { tenantId: `subagents_${nonce}`, userId: "actual-owner" };
  const otherTenant = `other_subagents_${nonce}`, key = randomBytes(32).toString("hex"), otherKey = randomBytes(32).toString("hex");
  const lifetime = new AbortController(), timer = setTimeout(() => lifetime.abort(), 25_000);
  const { store } = options, lease = store.sessionAuthority, bus = new MemoryEventBus(), runtime = new TenantRuntimeCoordinator();
  const providerKey = "owned-subagent-fake-vendor-key", vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey });
  const remote = new FakeMcp(); remote.responsePrefix = "real-mcp-result:";
  let host: SessionHost | undefined, mcp: ConfiguredMcpToolSource | undefined, lifecycle: ConfiguredLifecycleHookService | undefined;
  let rootSessionId = "", rootTurnId = "", stage = "setup", fleetSeamAdmissions = 0, passed = false, bodyFailed = false;
  let beginFailure: ReturnType<typeof closedFailure> | undefined, restoreBeginObserver: (() => void) | undefined;
  type CommitPhase = "approval_resolution" | "tool_started" | "tool_result" | "other";
  const commitTrace: { phase: CommitPhase; member: "root" | "child"; result: "pending" | "fulfilled" | "rejected" }[] = [];
  let operationFailure: { phase: CommitPhase; member: "root" | "child"; failure: ReturnType<typeof closedFailure> } | undefined;
  let renewalFailure: { result: "denied" | "rejected"; failure?: ReturnType<typeof closedFailure> } | undefined;
  const restoreOperationObservers: (() => void)[] = [];
  let lastHttpStatus: number | undefined, lastApiCode: string | null = null;
  const authorizeSubject = async (principal: Principal) => {
    expect(principal).toEqual(owner);
    expect((await store.getTenantRuntimeState(principal.tenantId)).state).toBe("active");
    const user = await store.getSubjectLifecycle(principal.tenantId, "user", principal.userId);
    expect(!user || user.state === "active").toBe(true);
  };
  // This seam proves that the source Host actually requests fresh authorization at admissions;
  // only the independent process test proves configured-runner nonce/fleet network agreement.
  const authorizeRuntimeExtensions = async (signal: AbortSignal) => {
    if (signal.aborted) failed(); await authorizeSubject(owner); fleetSeamAdmissions++;
  };
  try {
    // Instance-only observation: exact original batch/proof/ttl/receiver and original result/error.
    // No SQL, admission, lease, operation, assertion or timing result is substituted.
    const originalCommit = store.commit.bind(store);
    const commitObserver = vi.spyOn(store, "commit").mockImplementation(async batch => {
      const phase: CommitPhase = batch.approvals?.some(approval => approval.status === "resolved") ? "approval_resolution"
        : batch.items?.some(item => item.type === "toolCall" && item.startedAtMs !== undefined) ? "tool_started"
        : batch.items?.some(item => item.type === "toolResult") ? "tool_result" : "other";
      const trace = { phase, member: batch.sessionId === rootSessionId ? "root" as const : "child" as const, result: "pending" as "pending" | "fulfilled" | "rejected" };
      commitTrace.push(trace); if (commitTrace.length > 4) commitTrace.shift();
      try { const result = await originalCommit(batch); trace.result = "fulfilled"; return result; }
      catch (error) { trace.result = "rejected";
        try { operationFailure ??= { phase, member: trace.member, failure: closedFailure(error) }; } catch { /* Preserve the actual operation error. */ }
        throw error; }
    });
    restoreOperationObservers.push(() => commitObserver.mockRestore());
    const originalRenew = lease.renew.bind(lease);
    const renewObserver = vi.spyOn(lease, "renew").mockImplementation(async (proof, ttlMs) => {
      try { const result = await originalRenew(proof, ttlMs); if (!result) renewalFailure ??= { result: "denied" }; return result; }
      catch (error) {
        try { renewalFailure ??= { result: "rejected", failure: closedFailure(error) }; } catch { /* Preserve the actual renewal error. */ }
        throw error; }
    });
    restoreOperationObservers.push(() => renewObserver.mockRestore());
    await store.createApiKey(owner.tenantId, "owned-runtime", hashApiKey(key), ["runtime", "admin"]);
    await store.createApiKey(otherTenant, "owned-other", hashApiKey(otherKey), ["runtime"]);
    const endpoint = await remote.start();
    mcp = new ConfiguredMcpToolSource({ servers: [{ id: "owned", endpoint, subjects: [owner] }],
      timeoutMs: 3_000, allowLoopbackForTests: true, tenantRuntime: runtime, authorizeSubject });
    const discovered = await mcp.resolve(owner, ["owned"], lifetime.signal);
    expect(discovered).toHaveLength(1); const toolName = discovered[0]!.name;
    expect(discovered[0]).toMatchObject({ kind: "mcp", mandatoryApproval: true });
    lifecycle = new ConfiguredLifecycleHookService({ tenantRuntime: runtime, authorizeSubject, authorizeFleet: authorizeRuntimeExtensions,
      packages: [
        { id: "audit", package: "audit", subjects: [owner], phases: [...LifecycleHookPhase.options] },
        { id: "prompt", package: "prompt-policy", subjects: [owner], prependText: "effective-prefix", appendText: "effective-append",
          limits: { maxSteps: 8, maxToolCalls: 8, maxOutputTokensPerStep: 128 } },
        { id: "rewrite", package: "tool-policy", subjects: [owner], denyTools: [], rewrites: [{ tool: toolName, args: { text: EFFECTIVE } }] },
        { id: "memory", package: "memory-injection", subjects: [owner], prefix: "owned-memory-prefix", append: "owned-memory-append" },
      ] });
    const usage = { promptTokens: 10, completionTokens: 2 };
    vendor.script(
      { toolCalls: [{ id: SHARED_CALL_ID, name: "task", args: JSON.stringify({ target: "worker", prompt: CHILD_PROMPT }), argChunks: 3 }], usage },
      { toolCalls: [{ id: SHARED_CALL_ID, name: toolName, args: JSON.stringify({ text: ORIGINAL }), argChunks: 3 }], usage },
      { toolCalls: [{ id: DYNAMIC_CALL_ID, name: DYNAMIC, args: JSON.stringify({ value: "child-client-argument" }), argChunks: 3 }], usage },
      { text: CHILD_FINAL, usage }, { text: PARENT_FINAL, usage },
    );
    const vendorUrl = await vendor.start(), cipher = new LocalAesGcmCipher(randomBytes(32).toString("hex"));
    const preset = ProviderService.preset("deepseek", providerKey);
    const providers = new ProviderService({ store, cipher, tenantRuntime: runtime,
      platform: [{ ...preset, config: { ...preset.config, baseUrl: vendorUrl } }] });
    const tools = new StaticToolRegistry([]);
    host = new SessionHost({ store, lease, bus, providers, tools, mcp, lifecycleHooks: lifecycle,
      engine: new PiEngine(providers.models), tenantRuntime: runtime, authorizeRuntimeExtensions,
      subagents: { enabled: true, maxDepth: 3, maxConcurrent: 2, maxTasks: 4 },
      config: { runnerId: `subagents-${nonce}`, runnerAddr: "127.0.0.1:1", leaseTtlMs: 10_000, leaseHoldMs: 1,
        approvalTtlMs: 10_000, dynamicToolTimeoutMs: 10_000 }, logger: { info() {}, warn() {}, error() {} } });
    const originalBegin = host.beginTurn.bind(host);
    const beginObserver = vi.spyOn(host, "beginTurn").mockImplementation(async (...args: Parameters<SessionHost["beginTurn"]>) => {
      try { return await originalBegin(...args); }
      catch (error) { beginFailure = closedFailure(error); throw error; } // Same real call, result and original error.
    });
    restoreBeginObserver = () => beginObserver.mockRestore();
    const app = createApp({ store, host, providers, tools, runnerId: `subagents-${nonce}`, internalRouterToken: randomBytes(32).toString("hex"),
      subagentsEnabled: true, subagentControls: host, mcpEnabled: true, hooksEnabled: false,
      heartbeatMs: 60_000, maxBodyBytes: 400_000, ready: () => true, tenantRuntime: runtime,
      encryptSecret: async value => ({ ciphertext: await cipher.encrypt(value), keyId: cipher.keyId }),
      decryptSecret: value => cipher.decrypt(value.ciphertext, value.keyId) });
    const request = async (path: string, method = "GET", body?: unknown, auth: { key?: string; user?: string } = {}) => {
      const response = await app.request(`/v1${path}`, { method, signal: lifetime.signal,
        headers: { authorization: `Bearer ${auth.key ?? key}`, "x-user-id": auth.user ?? owner.userId,
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text(); if (Buffer.byteLength(raw) > 2_097_152) failed();
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      lastHttpStatus = response.status; lastApiCode = null;
      if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object" && "code" in parsed.error) {
        const code = parsed.error.code; if (typeof code === "string" && ERROR_CODES.has(code)) lastApiCode = code;
      }
      return { status: response.status, body: parsed };
    };
    const limits = { maxSteps: 8, maxToolCalls: 8, maxWallClockMs: 20_000, maxCostCNY: 1, maxOutputTokensPerStep: 128 };
    const childResponse = await request("/agents", "POST", { name: "Pinned child", instructions: "CHILD_SYSTEM_ONLY",
      model: { provider: "deepseek", model: "deepseek-chat" }, tools: [DYNAMIC], mcpServers: ["owned"], approvalPolicy: "never", limits });
    expect(childResponse.status).toBe(201); const childAgent = AgentDefinition.parse(childResponse.body);
    const parentResponse = await request("/agents", "POST", { name: "Root parent", instructions: "PARENT_SYSTEM_ONLY",
      model: { provider: "deepseek", model: "deepseek-chat" }, tools: ["task"], mcpServers: ["owned"], approvalPolicy: "never", limits,
      subagents: { allowSelf: false, targets: [{ name: "worker", agentId: childAgent.id, agentVersion: childAgent.version }],
        maxDepth: 2, maxConcurrent: 1, maxTasks: 2, context: "prompt", limits } });
    expect(parentResponse.status).toBe(201); const parentAgent = AgentDefinition.parse(parentResponse.body);
    const created = await request("/sessions", "POST", { agentId: parentAgent.id, userId: owner.userId, metadata: { parentOnly: "not-inherited" } });
    expect(created.status).toBe(201); rootSessionId = Session.parse(created.body).id;
    stage = "start_request";
    const started = await request(`/sessions/${rootSessionId}/turns`, "POST", { stream: false,
      input: [{ type: "text", text: PARENT_PROMPT }], dynamicTools: [DYNAMIC, OMITTED].map(name => ({ name, description: "Owned client tool", parameters: PARAMETERS })) });
    stage = "start_response"; expect(started.status).toBe(202); rootTurnId = Turn.parse(record(started.body).turn).id;
    stage = "child_reservation";
    const task = await wait(async () => (await store.listSubagentTasks({ principal: owner, rootSessionId, rootTurnId }))[0], lifetime.signal);
    expect(task).toMatchObject({ parentSessionId: rootSessionId, parentTurnId: rootTurnId, depth: 1,
      authority: { agentId: childAgent.id, agentVersion: childAgent.version, approvalPolicy: "on-request" } });
    const childSessionId = task.childSessionId, childTurnId = task.childTurnId;
    expect(childSessionId).not.toBe(rootSessionId); expect(childTurnId).not.toBe(rootTurnId);
    const statusPath = `/sessions/${rootSessionId}/subagents/${task.taskId}`;
    for (const auth of [{ user: "not-owner" }, { key: otherKey }]) {
      expect((await request(statusPath, "GET", undefined, auth)).status).toBe(404);
      expect((await request(`/sessions/${childSessionId}`, "GET", undefined, auth)).status).toBe(404);
      expect((await request(`/sessions/${rootSessionId}/subagents?rootTurnId=${rootTurnId}`, "GET", undefined, auth)).status).toBe(404);
    }
    expect(SubagentTaskStatusResponse.parse((await request(statusPath)).body).childSessionId).toBe(childSessionId);
    const listed = await request(`/sessions/${rootSessionId}/subagents?rootTurnId=${rootTurnId}`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: [expect.objectContaining({ taskId: task.taskId, rootSessionId, rootTurnId, childSessionId })], nextCursor: null });
    stage = "child_approval";
    const approval = await wait(async () => (await store.listApprovals(childSessionId, { pendingOnly: true }))[0], lifetime.signal);
    expect(Approval.parse(approval)).toMatchObject({ toolName, args: { text: EFFECTIVE }, turnId: childTurnId });
    expect(remote.calls).toEqual([]); expect(vendor.requests).toHaveLength(2);
    const before = await store.listItems(childSessionId, { limit: 200 });
    expect(before.find(item => item.type === "toolCall")).toMatchObject({ originalArgs: { text: ORIGINAL }, args: { text: EFFECTIVE } });
    expect(before.find(item => item.type === "toolCall")?.startedAtMs).toBeUndefined();
    const approvalCall = before.find(item => item.type === "toolCall" && item.turnId === childTurnId
      && item.toolCallId === approval.toolCallId && item.name === toolName);
    if (!approvalCall) failed();
    // The approval/requested commit becomes visible before its legitimate PermissionRequest
    // observer finishes. Establish the no-write baseline only after this exact call's audit.
    await wait(async () => (await store.readEvents(childSessionId, 0, 1000)).some(event =>
      event.type === "lifecycle-hook/completed" && event.phase === "PermissionRequest"
      && event.turnId === childTurnId && event.itemId === approvalCall.id
      && event.toolCallId === approval.toolCallId && event.approvalId === approval.id) ? true : undefined, lifetime.signal);
    const parentBefore = await store.listItems(rootSessionId, { limit: 200 });
    expect(parentBefore.find(item => item.type === "subagentActivity")).toMatchObject({ taskId: task.taskId, taskStatus: "reserved", status: "inProgress" });
    const rawPaths: [string, unknown][] = [
      [`/sessions/${childSessionId}/turns`, { stream: false, input: [{ type: "text", text: "raw child write forbidden" }] }],
      [`/sessions/${childSessionId}/turns/${childTurnId}/steer`, { input: [{ type: "text", text: "raw steer forbidden" }] }],
      [`/sessions/${childSessionId}/turns/${childTurnId}/interrupt`, {}],
      [`/sessions/${childSessionId}/approvals/${approval.id}`, { decision: "acceptForSession" }],
    ];
    const priorChild = await store.getSession(owner.tenantId, childSessionId);
    for (const [path, value] of rawPaths) expect((await request(path, "POST", value)).status).toBe(404);
    expect((await store.getSession(owner.tenantId, childSessionId))?.lastSeq).toBe(priorChild?.lastSeq);
    const approvalPath = `${statusPath}/approvals/${approval.id}`;
    for (const auth of [{ user: "not-owner" }, { key: otherKey }]) expect((await request(approvalPath, "POST", { decision: "acceptForSession" }, auth)).status).toBe(404);
    const accepted = await request(approvalPath, "POST", { decision: "acceptForSession" });
    expect(accepted.status).toBe(200); expect(accepted.body).toMatchObject({ id: approval.id, status: "resolved", decision: "acceptForSession" });
    expect(Object.hasOwn(record(accepted.body), "args")).toBe(false);
    stage = "child_dynamic";
    await wait(async () => (await store.listItems(childSessionId, { limit: 200 })).find(item => item.type === "toolCall"
      && item.name === DYNAMIC && item.startedAtMs !== undefined), lifetime.signal);
    expect(remote.calls).toEqual([{ name: "echo", arguments: { text: EFFECTIVE } }]);
    expect(vendor.requests).toHaveLength(3);
    const dynamicResult = { toolCallId: DYNAMIC_CALL_ID, content: [{ type: "text", text: DYNAMIC_RESULT }], isError: false };
    const dynamicPath = `${statusPath}/tool-results`;
    for (const auth of [{ user: "not-owner" }, { key: otherKey }]) expect((await request(dynamicPath, "POST", dynamicResult, auth)).status).toBe(404);
    expect((await request(`/sessions/${childSessionId}/turns/${childTurnId}/tool-results`, "POST", dynamicResult)).status).toBe(404);
    expect((await request(dynamicPath, "POST", dynamicResult)).status).toBe(200);
    stage = "completed";
    await wait(async () => { const turn = await store.getTurn(rootSessionId, rootTurnId); return turn?.status !== "inProgress" ? turn : undefined; }, lifetime.signal);
    // Stop/SubagentStop are real durable lifecycle callbacks, not a fabricated parentSessionId event.
    await wait(async () => {
      const events = await store.readEvents(rootSessionId, 0, 1000);
      return events.some(event => event.type === "lifecycle-hook/completed" && event.phase === "Stop" && event.turnId === rootTurnId) ? true : undefined;
    }, lifetime.signal);
    await wait(() => host!.activeTurn(rootSessionId) === undefined && host!.activeTurn(childSessionId) === undefined ? true : undefined, lifetime.signal);
    expect(await store.getTurn(rootSessionId, rootTurnId)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
    expect(await store.getTurn(childSessionId, childTurnId)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 3, toolCalls: 2 });
    const finalTask = (await store.getSubagentTask({ principal: owner, rootSessionId, taskId: task.taskId }))!;
    expect(finalTask).toMatchObject({ status: "completed", selectedPolicy: null, authority: { approvalRequiredTools: [toolName] } });
    expect([...finalTask.authority.toolNames].sort()).toEqual([toolName, DYNAMIC].sort());
    // Active-map absence is not the original finish/release receipt. Join actual old Host work
    // before a new, explicitly named internal observation ownership episode can start.
    await host.drain(0); await host.settle();
    const observation = await acquireFixedFixtureAuthority(store, { id: rootSessionId, ...owner }, finalTask.rootFence,
      { label: "subagents-post-turn-observation", ttlMs: 10_000 });
    let family: SubagentRootRecord | null;
    try {
      const access = attachSessionWriteAdmission(createSubagentRootAccess({ principal: owner, rootSessionId, rootTurnId,
        rootFence: observation.fence }), observation.proof);
      family = await store.getSubagentRoot({ access });
    } finally { await observation.release(); }
    if (!family) failed();
    expect(family).toMatchObject({ state: "terminal", steps: 5, toolCalls: 3, taskCount: 1, activeTasks: 0 });
    const parentSession = (await store.getSession(owner.tenantId, rootSessionId))!, childSession = (await store.getSession(owner.tenantId, childSessionId))!;
    expect(parentSession).toMatchObject({ status: { type: "idle" }, autoApprovedTools: [], metadata: { parentOnly: "not-inherited" } });
    expect(childSession).toMatchObject({ parentSessionId: rootSessionId, agentId: childAgent.id, agentVersion: childAgent.version, metadata: {} });
    const parentItems = await store.listItems(rootSessionId, { limit: 200 }), childItems = await store.listItems(childSessionId, { limit: 200 });
    expect(parentItems.find(item => item.type === "toolCall")).toMatchObject({ toolCallId: SHARED_CALL_ID, name: "task", status: "completed" });
    expect(childItems.find(item => item.type === "toolCall" && item.name === toolName)).toMatchObject({ toolCallId: SHARED_CALL_ID,
      originalArgs: { text: ORIGINAL }, args: { text: EFFECTIVE }, status: "completed", startedAtMs: expect.any(Number) });
    expect(parentItems.find(item => item.type === "subagentActivity")).toMatchObject({ taskId: task.taskId, taskStatus: "completed",
      status: "completed", parentCallItemId: finalTask.parentCallItemId, childSessionId, childTurnId, childUsage: finalTask.childUsage });
    expect(parentItems.filter(item => item.type === "subagentActivity")).toHaveLength(1);
    expect(childItems.filter(item => item.type === "toolResult")).toEqual([
      expect.objectContaining({ name: toolName, content: [{ type: "text", text: `real-mcp-result:${EFFECTIVE}` }], isError: false }),
      expect.objectContaining({ name: DYNAMIC, content: [{ type: "text", text: DYNAMIC_RESULT }], isError: false }),
    ]);
    const parentResult = parentItems.find(item => item.type === "toolResult");
    if (parentResult?.type !== "toolResult" || parentResult.content[0]?.type !== "text") failed();
    expect(JSON.parse(parentResult.content[0].text)).toMatchObject({ taskId: task.taskId, childSessionId, childTurnId, status: "completed", text: CHILD_FINAL });
    expect(childItems.find(item => item.type === "agentMessage" && item.text === CHILD_FINAL)).toBeDefined();
    expect(parentItems.find(item => item.type === "agentMessage" && item.text === PARENT_FINAL)).toBeDefined();
    for (const [items, original] of [[parentItems, PARENT_PROMPT], [childItems, CHILD_PROMPT]] as const) {
      const user = items.find(item => item.type === "userMessage");
      expect(user).toMatchObject({ content: [{ type: "text", text: original }], effectiveContent: [
        { type: "text", text: "effective-prefix" }, { type: "text", text: original }, { type: "text", text: "effective-append" },
      ] });
    }
    const parentEvents = await store.readEvents(rootSessionId, 0, 1000), childEvents = await store.readEvents(childSessionId, 0, 1000);
    for (const [events, session, items] of [[parentEvents, parentSession, parentItems], [childEvents, childSession, childItems]] as const) {
      expect(events.every(event => Event.safeParse(event).success && event.sessionId === session.id)).toBe(true);
      expect(events.map(event => event.seq)).toEqual(Array.from({ length: session.lastSeq }, (_, i) => i + 1));
      expect(items.every(item => Item.safeParse(item).success && item.sessionId === session.id && item.seq > 0)).toBe(true);
      expect(new Set(items.map(item => item.id)).size).toBe(items.length);
      expect(events.filter(event => event.type === "lifecycle-middleware/completed").map(event => event.stage)).toEqual(expect.arrayContaining(["prompt", "model", "tool"]));
    }
    expect(parentItems.some(item => childItems.some(child => child.id === item.id))).toBe(false);
    const delegatedPhases = parentEvents.filter((event): event is Extract<PersistedEvent, { type: "lifecycle-hook/completed" }> =>
      event.type === "lifecycle-hook/completed" && (event.phase === "SubagentStart" || event.phase === "SubagentStop"));
    expect(delegatedPhases.map(event => event.phase)).toEqual(["SubagentStart", "SubagentStop"]);
    expect(delegatedPhases).toEqual([
      expect.objectContaining({ taskId: task.taskId, childSessionId, childTurnId }),
      expect.objectContaining({ taskId: task.taskId, childSessionId, childTurnId }),
    ]);
    expect(childEvents.some(event => event.type === "lifecycle-hook/completed" && event.phase === "PermissionRequest")).toBe(true);
    expect(childEvents.filter(event => event.type === "item/toolCall/parametersChanged")).toHaveLength(1);
    expect(childEvents.findIndex(event => event.type === "item/toolCall/parametersChanged")).toBeLessThan(childEvents.findIndex(event => event.type === "approval/requested"));
    const rollup = await store.queryUsage(owner.tenantId, { userId: owner.userId, groupBy: "session", limit: 100 });
    expect(rollup.data.map(row => [row.key, row.turns, row.steps]).sort()).toEqual([[rootSessionId, 1, 2], [childSessionId, 1, 3]].sort());
    expect(tokenShape(family.familyUsage)).toEqual({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 60 });
    expect(tokenShape(parentSession.usage)).toMatchObject({ inputTokens: 20, outputTokens: 4, totalTokens: 24 });
    expect(tokenShape(childSession.usage)).toMatchObject({ inputTokens: 30, outputTokens: 6, totalTokens: 36 });
    expect(tokenShape(finalTask.childUsage)).toEqual(tokenShape(childSession.usage));
    expect(rollup.data.reduce((sum, row) => sum + row.steps, 0)).toBe(5); // Family projection must not bill another step.
    expect(vendor.requests).toHaveLength(5); expect(remote.calls).toHaveLength(1);
    const childRequest = JSON.stringify(vendor.requests[1]!.body);
    expect(childRequest).toContain(CHILD_PROMPT); expect(childRequest).not.toContain(PARENT_PROMPT);
    expect(childRequest).not.toContain("PARENT_SYSTEM_ONLY"); expect(childRequest).not.toContain("not-inherited");
    const advertised = (index: number) => (vendor.requests[index]!.body.tools as unknown[]).map(value => record(record(value).function).name);
    expect(advertised(0)).toEqual(expect.arrayContaining(["task", toolName, DYNAMIC, OMITTED]));
    for (const index of [1, 2, 3]) { expect(advertised(index).sort()).toEqual([toolName, DYNAMIC].sort()); }
    for (const request of vendor.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${providerKey}`);
      expect(request.body.max_tokens).toBe(128);
      const system = (request.body.messages as Record<string, unknown>[]).filter(message => message.role === "system").map(message => message.content).join("\n");
      expect(system.split("owned-memory-prefix")).toHaveLength(2); expect(system.split("owned-memory-append")).toHaveLength(2);
    }
    expect(JSON.stringify(vendor.requests[2]!.body.messages)).toContain(`real-mcp-result:${EFFECTIVE}`);
    expect(JSON.stringify(vendor.requests[3]!.body.messages)).toContain(DYNAMIC_RESULT);
    expect(JSON.stringify(vendor.requests[4]!.body.messages)).toContain(CHILD_FINAL);
    expect(fleetSeamAdmissions).toBeGreaterThan(5);
    passed = true;
    return { profile: options.profile, owner, rootSessionId, rootTurnId, childSessionId, childTurnId, task: finalTask, family,
      postTurnObservationFence: observation.fence, parentEvents, childEvents, parentItems, childItems, providerRequests: vendor.requests.length, remoteCalls: remote.calls.length, fleetSeamAdmissions };
  } catch (error) {
    bodyFailed = true;
    throw new Error(`Subagent source-App vertical failed: ${JSON.stringify({ stage, lastHttpStatus: lastHttpStatus ?? null,
      lastApiCode, failure: closedFailure(error), beginFailure: beginFailure ?? null, commitTrace,
      operationFailure: operationFailure ?? null, renewalFailure: renewalFailure ?? null })}`);
  }
  finally {
    lifetime.abort(); const failures: unknown[] = [];
    const close = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    if (host) await close(() => host!.drain(0));
    // Request native stop before joining users. Keep SQL and extension ciphers until original
    // Host work settles; this helper never closes the authority owned by the caller's store.
    await close(async () => { lifecycle?.stop(); }); await close(async () => { mcp?.stop(); });
    await close(() => remote.stop()); await close(() => vendor.stop());
    if (host) await close(() => host!.settle());
    await close(async () => { await lifecycle?.close(); });
    await close(async () => { await mcp?.close(); });
    await close(() => bus.close());
    await close(async () => { restoreBeginObserver?.(); });
    for (const restore of restoreOperationObservers.reverse()) await close(async () => restore());
    clearTimeout(timer); vi.unstubAllEnvs();
    if (failures.length || runtime.snapshot(owner.tenantId).activeTurns || runtime.snapshot(owner.tenantId).providerOperations || runtime.snapshot(owner.tenantId).authOperations) {
      try { console.error(JSON.stringify({ schema: "subagent-source-cleanup-failure-diagnostic-v1", count: failures.length,
        failure: failures.length ? closedFailure(failures[0]) : null })); } catch { /* Retain the first body/cleanup failure. */ }
      if (!bodyFailed) throw new Error("Subagent source-App owned cleanup failed.");
    }
    if (passed) options.onOwnedServicesClosed?.();
  }
}
