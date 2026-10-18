import { Hono, type Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, emptyUsage, SubagentTaskListResponse, SubagentApprovalResponse, SubagentInterruptResponse } from "@agent-service/protocol";
import type { Approval, ApprovalDecision, Principal, SubagentTaskStatusResponse, Turn } from "@agent-service/protocol";
import type { DelegatedToolResult, SubagentControlService } from "@agent-service/core";
import { MemorySessionStore } from "@agent-service/store";
import { authMiddleware, hashApiKey, type AuthEnv } from "../src/auth.js";
import { registerSubagentRoutes } from "../src/subagent-routes.js";

const ROOT = "sess_00000000-0000-7000-8000-000000000001";
const ROOT_TURN = "turn_00000000-0000-7000-8000-000000000002";
const TASK = "sat_00000000-0000-7000-8000-000000000003";
const CHILD = "sess_00000000-0000-7000-8000-000000000004";
const CHILD_TURN = "turn_00000000-0000-7000-8000-000000000005";
const ITEM = "item_00000000-0000-7000-8000-000000000006";
const APPROVAL = "apr_00000000-0000-7000-8000-000000000007";
const prefix = `/v1/sessions/${ROOT}/subagents`, taskPath = `${prefix}/${TASK}`;
const owner = { tenantId: "tenant-a", userId: "actual-user" };
const privateCanary = "fixture-private-prompt-key-canary";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const task = (): SubagentTaskStatusResponse => ({ taskId: TASK, rootSessionId: ROOT, rootTurnId: ROOT_TURN,
  parentSessionId: ROOT, parentTurnId: ROOT_TURN, parentCallItemId: ITEM, childSessionId: CHILD, childTurnId: CHILD_TURN,
  status: "running", depth: 1, createdAtMs: 1 });
const approval = (decision: ApprovalDecision = "accept"): Approval => ({ id: APPROVAL, sessionId: CHILD, turnId: CHILD_TURN,
  itemId: ITEM, status: "resolved", toolCallId: "model-call", toolName: "write", args: { prompt: privateCanary },
  reason: privateCanary, decidedBy: privateCanary, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  decision, createdAtMs: 1, expiresAtMs: 1000, resolvedAtMs: 2 });
const turn = (): Turn => ({ id: CHILD_TURN, sessionId: CHILD, status: "interrupted", stopReason: "interrupted", seqStart: 1,
  seqEnd: 2, steps: 1, toolCalls: 1, usage: emptyUsage(), startedAtMs: 1, completedAtMs: 2,
  partialText: privateCanary, metadata: { credential: privateCanary }, idempotencyKey: privateCanary,
  error: { code: "provider_error", message: privateCanary } });

// Real Hono + API-key/user middleware + Memory key lookup. The closed service spies below
// prove routing/projection only; they are not a coordinator, child producer or SQL delegation proof.
async function fixture(options: { enabled?: boolean; tombstoneEnabled?: boolean; noService?: boolean; maxBodyBytes?: number } = {}) {
  const store = new MemorySessionStore(); cleanup.push(() => store.close());
  for (const [tenant, key, scopes] of [["tenant-a", "runtime-a", ["runtime"]], ["tenant-a", "admin-a", ["admin"]],
    ["tenant-b", "admin-b", ["admin"]]] as const) await store.createApiKey(tenant, key, hashApiKey(key), [...scopes]);
  const own = (principal: Principal, root: string, id?: string) => {
    if (principal.tenantId !== owner.tenantId || principal.userId !== owner.userId || root !== ROOT || id !== undefined && id !== TASK)
      throw new ApiError("not_found", "Subagent not found.");
  };
  const methods = {
    list: vi.fn(async (principal: Principal, root: string, rootTurn: string) => { own(principal, root); return rootTurn === ROOT_TURN ? [task()] : []; }),
    get: vi.fn(async (principal: Principal, root: string, id: string) => { own(principal, root, id); return task(); }),
    approval: vi.fn(async (principal: Principal, root: string, id: string, approvalId: string, decision: ApprovalDecision) => {
      own(principal, root, id); if (approvalId !== APPROVAL) throw new ApiError("not_found", "Approval not found."); return approval(decision);
    }),
    result: vi.fn(async (principal: Principal, root: string, id: string, _call: string, _result: DelegatedToolResult) => { own(principal, root, id); }),
    interrupt: vi.fn(async (principal: Principal, root: string, id: string) => { own(principal, root, id); return turn(); }),
    delete: vi.fn(async (principal: Principal, root: string, id: string) => { own(principal, root, id); }),
  };
  const service: SubagentControlService = { listDelegatedTasks: methods.list, getDelegatedTask: methods.get,
    resolveDelegatedApproval: methods.approval, submitDelegatedToolResult: methods.result,
    interruptDelegatedTask: methods.interrupt, deleteDelegatedSession: methods.delete };
  const app = new Hono<AuthEnv>(), v1 = new Hono<AuthEnv>();
  app.onError((error, c) => error instanceof ApiError ? c.json(error.toBody(), error.status as 400)
    : c.json({ error: { code: "internal_error", message: "request failed" } }, 500));
  // Same pre-auth header placement required in the real app; helper also sets them after auth.
  const headers = async (c: Context<AuthEnv>, next: () => Promise<void>) => {
    c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); await next();
  };
  v1.use("/sessions/:id/subagents", headers); v1.use("/sessions/:id/subagents/*", headers);
  v1.use("*", authMiddleware({ store, decryptSecret: async () => "unused" }));
  registerSubagentRoutes(v1, { enabled: options.enabled ?? true, tombstoneEnabled: options.tombstoneEnabled ?? true,
    ...(options.noService ? {} : { service }), maxBodyBytes: options.maxBodyBytes });
  const ordinaryFallback = vi.fn(() => new Response("ordinary-fallback", { status: 200 }));
  v1.all("/sessions/*", ordinaryFallback); app.route("/v1", v1);
  const request = (path = taskPath, opts: { method?: string; body?: unknown; raw?: string; key?: string | null; user?: string | null } = {}) => app.request(path, {
    method: opts.method ?? "GET", headers: { ...(opts.key === null ? {} : { authorization: `Bearer ${opts.key ?? "runtime-a"}` }),
      ...(opts.user === null ? {} : { "x-user-id": opts.user ?? owner.userId }),
      ...(opts.raw !== undefined || opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(opts.raw !== undefined ? { body: opts.raw } : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { request, methods, ordinaryFallback };
}

describe("root-addressed subagent HTTP controls", () => {
  it("uses the actual authenticated principal, not a tenant admin literal, on all six operations", async () => {
    const f = await fixture();
    expect((await f.request(`${prefix}?rootTurnId=${ROOT_TURN}`)).status).toBe(200);
    expect((await f.request()).status).toBe(200);
    expect((await f.request(`${taskPath}/approvals/${APPROVAL}`, { method: "POST", body: { decision: "accept" } })).status).toBe(200);
    expect((await f.request(`${taskPath}/tool-results`, { method: "POST", body: { toolCallId: "model-call", content: [{ type: "text", text: "result" }] } })).status).toBe(200);
    expect((await f.request(`${taskPath}/interrupt`, { method: "POST", body: {} })).status).toBe(200);
    expect((await f.request(`${taskPath}/session`, { method: "DELETE" })).status).toBe(204);
    for (const fn of Object.values(f.methods)) expect(fn.mock.calls[0]?.[0]).toEqual(owner);
    expect(f.methods.list.mock.calls[0]).toEqual([owner, ROOT, ROOT_TURN]);
    expect(f.methods.result.mock.calls[0]).toEqual([owner, ROOT, TASK, "model-call", { content: [{ type: "text", text: "result" }], isError: false }]);
  });
  it("requires a user even for an admin key and returns private headers on authentication errors", async () => {
    const f = await fixture();
    for (const opts of [{ key: null }, { key: "not-a-key" }, { key: "admin-a", user: null }]) {
      const response = await f.request(taskPath, opts);
      expect([400, 401]).toContain(response.status); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(f.methods.get).not.toHaveBeenCalled();
  });
  it("passes the real tenant/user through and preserves owner-isolated 404s", async () => {
    const f = await fixture();
    for (const opts of [{ user: "other-user" }, { key: "admin-b" }]) {
      const response = await f.request(taskPath, opts); expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(privateCanary);
    }
    expect(f.methods.get.mock.calls.map(call => call[0])).toEqual([{ ...owner, userId: "other-user" }, { ...owner, tenantId: "tenant-b" }]);
  });
  it("lists one bounded immutable root-turn family with no cursor rather than global session history", async () => {
    const f = await fixture(), response = await f.request(`${prefix}?rootTurnId=${ROOT_TURN}`);
    expect(SubagentTaskListResponse.parse(await response.json())).toEqual({ data: [task()], nextCursor: null });
    f.methods.list.mockResolvedValueOnce(Array.from({ length: 65 }, task));
    const oversized = await f.request(`${prefix}?rootTurnId=${ROOT_TURN}`); expect(oversized.status).toBe(500);
    expect(await oversized.text()).not.toContain(TASK);
  });
  it("projects content-free control receipts after validating the full Host resources", async () => {
    const f = await fixture();
    const approved = await f.request(`${taskPath}/approvals/${APPROVAL}`, { method: "POST", body: { decision: "acceptForSession" } });
    const approvedText = await approved.text(); expect(approvedText).not.toContain(privateCanary);
    const parsedApproval = SubagentApprovalResponse.parse(JSON.parse(approvedText)); expect(parsedApproval.decision).toBe("acceptForSession");
    for (const field of ["args", "reason", "decidedBy"]) expect(Object.hasOwn(parsedApproval, field)).toBe(false);
    const interrupted = await f.request(`${taskPath}/interrupt`, { method: "POST", body: {} }), interruptedText = await interrupted.text();
    expect(interruptedText).not.toContain(privateCanary); const parsedTurn = SubagentInterruptResponse.parse(JSON.parse(interruptedText));
    expect(parsedTurn.id).toBe(CHILD_TURN);
    for (const field of ["metadata", "partialText", "error", "idempotencyKey"]) expect(Object.hasOwn(parsedTurn, field)).toBe(false);
  });
  it("rejects unknown private fields from service results rather than spreading them into HTTP", async () => {
    const f = await fixture();
    f.methods.get.mockResolvedValueOnce({ ...task(), rootFence: 1, prompt: privateCanary } as SubagentTaskStatusResponse);
    f.methods.approval.mockResolvedValueOnce({ ...approval(), claimToken: privateCanary } as Approval);
    f.methods.interrupt.mockResolvedValueOnce({ ...turn(), credential: privateCanary } as Turn);
    for (const response of [await f.request(), await f.request(`${taskPath}/approvals/${APPROVAL}`, { method: "POST", body: { decision: "accept" } }),
      await f.request(`${taskPath}/interrupt`, { method: "POST", body: {} })]) {
      expect(response.status).toBe(500); expect(await response.text()).not.toContain(privateCanary);
    }
  });
  it("rejects wrong-root, wrong-task, mixed-turn or duplicate status results without widening the request", async () => {
    const f = await fixture();
    f.methods.get.mockResolvedValueOnce({ ...task(), rootSessionId: CHILD });
    expect((await f.request()).status).toBe(500);
    f.methods.get.mockResolvedValueOnce({ ...task(), taskId: "sat_00000000-0000-7000-8000-000000000008" });
    expect((await f.request()).status).toBe(500);
    f.methods.list.mockResolvedValueOnce([{ ...task(), rootTurnId: CHILD_TURN }]);
    expect((await f.request(`${prefix}?rootTurnId=${ROOT_TURN}`)).status).toBe(500);
    f.methods.list.mockResolvedValueOnce([task(), task()]);
    expect((await f.request(`${prefix}?rootTurnId=${ROOT_TURN}`)).status).toBe(500);
  });
  it("rejects disabled/absent service and independently gates logical tombstones", async () => {
    for (const options of [{ enabled: false }, { noService: true }]) {
      const f = await fixture(options); expect((await f.request()).status).toBe(503); expect(f.methods.get).not.toHaveBeenCalled();
    }
    const f = await fixture({ tombstoneEnabled: false });
    expect((await f.request(`${taskPath}/session`, { method: "DELETE" })).status).toBe(503);
    expect(f.methods.delete).not.toHaveBeenCalled(); expect((await f.request()).status).toBe(200);
  });
  it.each([
    `${prefix}`, `${prefix}?rootTurnId=${ROOT_TURN}&rootTurnId=${ROOT_TURN}`, `${prefix}?rootTurnId=${ROOT_TURN}&limit=1`,
    `${prefix}?rootTurnId=invalid`, `${taskPath}?owner=${privateCanary}`, `${taskPath}?x=1&x=1`,
    `/v1/sessions/${ROOT.toUpperCase()}/subagents/${TASK}`, `/v1/sessions/${ROOT}/subagents/${TASK.toUpperCase()}`,
    `${taskPath}/approvals/${APPROVAL.toUpperCase()}`,
  ])("rejects malformed/noncanonical IDs and closed query violations (%#)", async path => {
    const f = await fixture(), response = await f.request(path, path.includes("/approvals/") ? { method: "POST", body: { decision: "accept" } } : {});
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(privateCanary);
    for (const method of Object.values(f.methods)) expect(method).not.toHaveBeenCalled();
  });
  it.each([
    { suffix: `/approvals/${APPROVAL}`, body: { decision: "accept", owner } },
    { suffix: `/approvals/${APPROVAL}`, body: { decision: "approve" } },
    { suffix: "/tool-results", body: { toolCallId: "call", content: [{ type: "text", text: "text", credential: privateCanary }] } },
    { suffix: "/tool-results", body: { toolCallId: "call", content: [{ type: "image", url: privateCanary }] } },
    { suffix: "/tool-results", body: { toolCallId: "call", content: [], rootFence: 1 } },
    { suffix: "/interrupt", body: { taskId: TASK } }, { suffix: "/interrupt", body: [] },
  ])("rejects closed mutation violations before service dispatch (%#)", async value => {
    const f = await fixture(), response = await f.request(`${taskPath}${value.suffix}`, { method: "POST", body: value.body });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(privateCanary);
    for (const method of Object.values(f.methods)) expect(method).not.toHaveBeenCalled();
  });
  it("rejects duplicate JSON keys including escaped decisions, oversized bytes and all DELETE bodies", async () => {
    const f = await fixture({ maxBodyBytes: 256 });
    for (const raw of ['{"decision":"accept","decision":"cancel"}', '{"decision":"accept","\\u0064ecision":"cancel"}']) {
      expect((await f.request(`${taskPath}/approvals/${APPROVAL}`, { method: "POST", raw })).status).toBe(400);
    }
    expect((await f.request(`${taskPath}/tool-results`, { method: "POST", body: { toolCallId: "call", content: [{ type: "text", text: "x".repeat(300) }] } })).status).toBe(400);
    for (const raw of ["{}", " ", "null"]) expect((await f.request(`${taskPath}/session`, { method: "DELETE", raw })).status).toBe(400);
    expect((await f.request(`${taskPath}/interrupt`, { method: "POST" })).status).toBe(400);
    for (const method of Object.values(f.methods)) expect(method).not.toHaveBeenCalled();
  });
  it("does not fall back unsupported subagent methods/paths to ordinary session control", async () => {
    const f = await fixture();
    for (const [path, method] of [[taskPath, "PUT"], [prefix, "POST"], [`${taskPath}/session`, "POST"], [`${taskPath}/unknown`, "GET"]]) {
      const response = await f.request(path, { method }); expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.ordinaryFallback).not.toHaveBeenCalled(); expect((await f.request(`/v1/sessions/${ROOT}`)).status).toBe(200);
    expect(f.ordinaryFallback).toHaveBeenCalledTimes(1);
  });
});
