import type { Context, Hono } from "hono";
import {
  ApiError, Approval, Turn, SubagentRootParams, SubagentTaskParams, SubagentApprovalParams,
  SubagentEmptyQuery, SubagentListQuery, SubagentApprovalRequest, SubagentToolResultRequest,
  SubagentInterruptRequest, SubagentTaskStatusResponse, SubagentTaskListResponse,
  SubagentApprovalResponse, SubagentInterruptResponse, SubagentControlOkResponse,
} from "@agent-service/protocol";
import type { SubagentControlService } from "@agent-service/core";
import { requireUser, type AuthEnv } from "./auth.js";

export interface SubagentRouteDeps {
  readonly enabled: boolean;
  readonly tombstoneEnabled: boolean;
  readonly service?: SubagentControlService;
  readonly maxBodyBytes?: number;
}
function invalid(): never { throw new ApiError("invalid_request", "Subagent request failed."); }
function invalidResponse(): never { throw new ApiError("internal_error", "Subagent response unavailable."); }
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, response = false): T {
  const parsed = schema.safeParse(value); return parsed.success ? parsed.data : response ? invalidResponse() : invalid();
}
function query(c: Context): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (Object.hasOwn(result, key)) invalid(); Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}
function uniqueJsonKeys(raw: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{" || raw[i] === "[") { stack.push(raw[i] === "{" ? new Set() : null); if (stack.length > 32) invalid(); }
    else if (raw[i] === "}" || raw[i] === "]") stack.pop();
    else if (raw[i] === '"') {
      const start = i;
      for (i++; i < raw.length; i++) { if (raw[i] === "\\") i++; else if (raw[i] === '"') break; }
      let next = i + 1; while (next < raw.length && /[\x20\t\r\n]/.test(raw[next]!)) next++;
      if (raw[next] === ":") {
        const names = stack.at(-1), name: unknown = JSON.parse(raw.slice(start, i + 1));
        if (!names || typeof name !== "string" || names.has(name)) invalid(); names.add(name);
      }
    }
  }
}
async function bodyBytes(c: Context, maximum: number): Promise<Uint8Array> {
  const body = c.req.raw.body; if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); invalid(); } chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}
async function body(c: Context, maximum: number): Promise<unknown> {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(await bodyBytes(c, maximum));
    const value: unknown = JSON.parse(raw); uniqueJsonKeys(raw); return value;
  } catch { return invalid(); }
}
function privateHeaders(c: Context): void { c.header("Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff"); }

/** Register behind real v1 auth. The app also installs its existing privateResponseHeaders
 * for these two route prefixes before auth, so authentication failures have the same headers. */
export function registerSubagentRoutes(v1: Hono<AuthEnv>, deps: SubagentRouteDeps): void {
  const maximum = deps.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("Invalid subagent route configuration");
  const prefix = "/sessions/:id/subagents";
  v1.use(prefix, async (c, next) => { privateHeaders(c); await next(); });
  v1.use(`${prefix}/*`, async (c, next) => { privateHeaders(c); await next(); });
  const authority = (c: Context<AuthEnv>) => {
    privateHeaders(c); const principal = requireUser(c);
    if (!deps.enabled || !deps.service) throw new ApiError("draining", "Subagent control unavailable.");
    return { principal, service: deps.service };
  };
  v1.get(prefix, async c => {
    const auth = authority(c), p = parse(SubagentRootParams, c.req.param()), q = parse(SubagentListQuery, query(c));
    const tasks = await auth.service.listDelegatedTasks(auth.principal, p.id, q.rootTurnId);
    // Reject an invalid/oversized family. Never silently slice a result or spread a durable private record.
    const response = parse(SubagentTaskListResponse, { data: tasks, nextCursor: null }, true);
    if (response.data.some(task => task.rootSessionId !== p.id || task.rootTurnId !== q.rootTurnId)
      || new Set(response.data.map(task => task.taskId)).size !== response.data.length) invalidResponse();
    return c.json(response);
  });
  v1.get(`${prefix}/:taskId`, async c => {
    const auth = authority(c), p = parse(SubagentTaskParams, c.req.param()); parse(SubagentEmptyQuery, query(c));
    const task = parse(SubagentTaskStatusResponse, await auth.service.getDelegatedTask(auth.principal, p.id, p.taskId), true);
    if (task.rootSessionId !== p.id || task.taskId !== p.taskId) invalidResponse(); return c.json(task);
  });
  v1.post(`${prefix}/:taskId/approvals/:approvalId`, async c => {
    const auth = authority(c), p = parse(SubagentApprovalParams, c.req.param()); parse(SubagentEmptyQuery, query(c));
    const input = parse(SubagentApprovalRequest, await body(c, maximum));
    const full = parse(Approval.strict(), await auth.service.resolveDelegatedApproval(auth.principal, p.id, p.taskId, p.approvalId, input.decision), true);
    if (full.id !== p.approvalId) invalidResponse();
    const receipt = { id: full.id, sessionId: full.sessionId, turnId: full.turnId, itemId: full.itemId, status: full.status,
      toolCallId: full.toolCallId, toolName: full.toolName, availableDecisions: full.availableDecisions, decision: full.decision,
      createdAtMs: full.createdAtMs, expiresAtMs: full.expiresAtMs, resolvedAtMs: full.resolvedAtMs };
    return c.json(parse(SubagentApprovalResponse, receipt, true));
  });
  v1.post(`${prefix}/:taskId/tool-results`, async c => {
    const auth = authority(c), p = parse(SubagentTaskParams, c.req.param()); parse(SubagentEmptyQuery, query(c));
    const input = parse(SubagentToolResultRequest, await body(c, maximum));
    await auth.service.submitDelegatedToolResult(auth.principal, p.id, p.taskId, input.toolCallId, { content: input.content, isError: input.isError });
    return c.json(parse(SubagentControlOkResponse, { ok: true }, true));
  });
  v1.post(`${prefix}/:taskId/interrupt`, async c => {
    const auth = authority(c), p = parse(SubagentTaskParams, c.req.param()); parse(SubagentEmptyQuery, query(c));
    parse(SubagentInterruptRequest, await body(c, maximum));
    const full = parse(Turn.strict(), await auth.service.interruptDelegatedTask(auth.principal, p.id, p.taskId), true);
    const receipt = { id: full.id, sessionId: full.sessionId, status: full.status, stopReason: full.stopReason,
      model: full.model, seqStart: full.seqStart, seqEnd: full.seqEnd, steps: full.steps, toolCalls: full.toolCalls,
      usage: full.usage, startedAtMs: full.startedAtMs, completedAtMs: full.completedAtMs };
    return c.json(parse(SubagentInterruptResponse, receipt, true));
  });
  v1.delete(`${prefix}/:taskId/session`, async c => {
    const auth = authority(c), p = parse(SubagentTaskParams, c.req.param()); parse(SubagentEmptyQuery, query(c));
    if (!deps.tombstoneEnabled) throw new ApiError("draining", "Session tombstone control unavailable.");
    if ((await bodyBytes(c, maximum)).byteLength) invalid();
    await auth.service.deleteDelegatedSession(auth.principal, p.id, p.taskId); return c.body(null, 204);
  });
  const unsupported = (c: Context<AuthEnv>): never => { authority(c); throw new ApiError("not_found", "Subagent route not found."); };
  v1.all(prefix, unsupported); v1.all(`${prefix}/*`, unsupported);
}
