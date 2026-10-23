import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError, Principal } from "@agent-service/protocol";
import { createMcpHttpFetch, McpHttpError } from "../mcp/http.js";
import type { TenantRuntimeCoordinator } from "../lifecycle/tenant-runtime-coordinator.js";
import type {
  ConfiguredToolHookServiceOptions, ToolHookContext, ToolHookDefinition, ToolHookOutcome,
  ToolHookPhase, ToolHookPostContext, ToolHookPreResult, ToolHookReport, ToolHookService,
  ToolHookWebhookRequest, ToolHookWebhookResponse,
} from "./types.js";

const MESSAGE = "Tool hook request failed.";
const REQUEST_SCHEMA = "agent-service-tool-hook-request-v1";
const RESPONSE_SCHEMA = "agent-service-tool-hook-response-v1";
const MAX_REQUEST = 16_384, MAX_RESPONSE = 8_192;
const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS = ["builtin", "mcp", "dynamic", "skill"];
type Hook = ToolHookDefinition & { readonly configSha256: string };
type Operation = { abort: AbortController; done: Promise<unknown> };

function fail(): never { throw new Error(MESSAGE); }
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(d => !("value" in d) || !d.enumerable)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: readonly string[], optional: readonly string[] = []): void {
  if (Object.keys(value).some(name => !names.includes(name) && !optional.includes(name))
    || names.some(name => !Object.hasOwn(value, name))) fail();
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([name, d]) =>
      name !== "length" && (!("value" in d) || !d.enumerable))) fail();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString("utf8") !== value || /[\u0000-\u001f\u007f-\u009f]/.test(value)) fail();
  return value;
}
function name(value: unknown): string { const v = text(value, 64); if (!NAME.test(v)) fail(); return v; }
function digest(value: unknown): string { if (typeof value !== "string" || !DIGEST.test(value)) fail(); return value; }
function principal(value: unknown): Readonly<Principal> {
  const p = plain(value); keys(p, ["tenantId", "userId"]);
  // The shared wire limit is 128 UTF-16 code units, not 128 UTF-8 bytes.
  // Keep bounded, round-trippable text without narrowing valid Unicode tenants.
  const result = Principal.safeParse({ tenantId: text(p.tenantId, 512), userId: text(p.userId, 128) });
  if (!result.success) fail();
  return Object.freeze(result.data);
}
function ownerKey(p: Principal): string { return JSON.stringify([p.tenantId, p.userId]); }
function phase(value: unknown): ToolHookPhase {
  if (value !== "preToolUse" && value !== "postToolUse") fail(); return value;
}
function tool(value: unknown): ToolHookContext["tool"] {
  const t = plain(value); keys(t, ["name", "kind", "readOnly"]);
  if (typeof t.kind !== "string" || !KINDS.includes(t.kind) || typeof t.readOnly !== "boolean") fail();
  return Object.freeze({ name: name(t.name), kind: t.kind as ToolHookContext["tool"]["kind"], readOnly: t.readOnly });
}
function context(value: ToolHookContext | ToolHookPostContext, post: boolean): Readonly<ToolHookPostContext> {
  const c = plain(value); keys(c, ["owner", "sessionId", "turnId", "toolCallId", "tool", ...(post ? ["isError"] : [])]);
  if (post && typeof c.isError !== "boolean") fail();
  return Object.freeze({ owner: principal(c.owner), sessionId: text(c.sessionId, 256),
    turnId: text(c.turnId, 256), toolCallId: text(c.toolCallId, 256), tool: tool(c.tool), isError: post && c.isError === true });
}
function keyBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) fail();
  return Buffer.from(value);
}
function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}
function mac(key: Uint8Array, domain: string, value: unknown): string {
  return createHmac("sha256", key).update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}
function equal(a: string, b: string): boolean {
  return DIGEST.test(a) && DIGEST.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function requestPayload(value: unknown): Omit<ToolHookWebhookRequest, "requestSha256" | "macSha256"> {
  const r = plain(value); keys(r, ["schema", "hookId", "phase", "invocationId", "configSha256", "refs", "tool", "isError", "requestSha256", "macSha256"]);
  if (r.schema !== REQUEST_SCHEMA || typeof r.invocationId !== "string" || !/^[a-f0-9]{32}$/.test(r.invocationId)) fail();
  const p = phase(r.phase), refs = plain(r.refs); keys(refs, ["tenant", "user", "session", "turn", "toolCall"]);
  if ((p === "preToolUse" && r.isError !== null) || (p === "postToolUse" && typeof r.isError !== "boolean")) fail();
  return Object.freeze({ schema: REQUEST_SCHEMA, hookId: name(r.hookId), phase: p,
    invocationId: r.invocationId, configSha256: digest(r.configSha256),
    refs: Object.freeze({ tenant: digest(refs.tenant), user: digest(refs.user), session: digest(refs.session),
      turn: digest(refs.turn), toolCall: digest(refs.toolCall) }), tool: tool(r.tool), isError: r.isError as boolean | null });
}

/** Operator webhook helper. A wire receiver must also reject duplicate JSON keys before
 * passing a parsed object here; an object cannot retain that lexical information. */
export function validateToolHookWebhookRequest(value: unknown, signingKey: Uint8Array): Readonly<ToolHookWebhookRequest> {
  let key: Buffer | undefined;
  try {
    key = keyBytes(signingKey); const p = requestPayload(value), raw = plain(value);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST) fail();
    const requestSha256 = digest(raw.requestSha256), macSha256 = digest(raw.macSha256);
    if (!equal(requestSha256, hash("agent-service-tool-hook-request-digest-v1", p))
      || !equal(macSha256, mac(key, "agent-service-tool-hook-request-mac-v1", { ...p, requestSha256 }))) fail();
    return Object.freeze({ ...p, requestSha256, macSha256 });
  } catch { throw new Error("Tool hook message is invalid."); }
  finally { key?.fill(0); }
}
/** Signs only an already authenticated, closed request and a phase-appropriate decision. */
export function createToolHookWebhookResponse(request: unknown, decision: "allow" | "deny" | "ack", signingKey: Uint8Array): Readonly<ToolHookWebhookResponse> {
  let key: Buffer | undefined;
  try {
    const r = validateToolHookWebhookRequest(request, signingKey); key = keyBytes(signingKey);
    if (r.phase === "preToolUse" ? decision !== "allow" && decision !== "deny" : decision !== "ack") fail();
    const p = { schema: RESPONSE_SCHEMA, hookId: r.hookId, phase: r.phase, invocationId: r.invocationId,
      configSha256: r.configSha256, requestSha256: r.requestSha256, decision } as const;
    return Object.freeze({ ...p, macSha256: mac(key, "agent-service-tool-hook-response-mac-v1", p) });
  } catch { throw new Error("Tool hook message is invalid."); }
  finally { key?.fill(0); }
}

/** This wire profile is a single flat object of string values, not a general JSON
 * parser. JSON.parse remains syntax authority; the lexical pass rejects duplicate
 * and escaped-duplicate names before a MAC-bearing decision can be consumed. */
function responseObject(bytes: string): Record<string, unknown> {
  if (Buffer.byteLength(bytes) > MAX_RESPONSE) fail();
  const result = plain(JSON.parse(bytes));
  const tokens = bytes.match(/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}:,]|[^\s{}:,]+/g);
  if (!tokens || tokens[0] !== "{" || tokens.at(-1) !== "}") fail();
  const seen = new Set<string>(); let i = 1;
  while (i < tokens.length - 1) {
    const key = tokens[i++]; if (!key?.startsWith('"') || tokens[i++] !== ":") fail();
    const decoded: unknown = JSON.parse(key); if (typeof decoded !== "string" || seen.has(decoded)) fail(); seen.add(decoded);
    if (!tokens[i++]?.startsWith('"')) fail();
    if (i < tokens.length - 1 && tokens[i++] !== ",") fail();
  }
  if (i !== tokens.length - 1 || seen.size !== Object.keys(result).length) fail();
  return result;
}
function responseDecision(value: string, r: ToolHookWebhookRequest, key: Uint8Array): "allow" | "deny" | "ack" {
  const v = responseObject(value); keys(v, ["schema", "hookId", "phase", "invocationId", "configSha256", "requestSha256", "decision", "macSha256"]);
  if (v.schema !== RESPONSE_SCHEMA || v.hookId !== r.hookId || v.phase !== r.phase || v.invocationId !== r.invocationId
    || v.configSha256 !== r.configSha256 || v.requestSha256 !== r.requestSha256
    || (r.phase === "preToolUse" ? v.decision !== "allow" && v.decision !== "deny" : v.decision !== "ack")) fail();
  const p = { schema: RESPONSE_SCHEMA, hookId: r.hookId, phase: r.phase, invocationId: r.invocationId,
    configSha256: r.configSha256, requestSha256: r.requestSha256, decision: v.decision };
  if (!equal(digest(v.macSha256), mac(key, "agent-service-tool-hook-response-mac-v1", p))) fail();
  return v.decision as "allow" | "deny" | "ack";
}
function report(h: Hook, outcome: ToolHookOutcome): ToolHookReport {
  return Object.freeze({ hookId: h.id, phase: h.phase, kind: h.kind, outcome, configSha256: h.configSha256 });
}

/** Fixed operator policies, not tenant code or an extensible execution engine. Every
 * webhook owns anonymous HTTP and closes actual sockets before its runtime lease is released. */
export class ConfiguredToolHookService implements ToolHookService {
  readonly enabled: boolean;
  private readonly hooks: readonly Hook[];
  private readonly timeout: number;
  private readonly maximum: number;
  private readonly fixture: boolean;
  private readonly runtime?: TenantRuntimeCoordinator;
  private readonly authorize?: (principal: Principal) => Promise<void>;
  private readonly users = new Map<string, number>();
  private readonly operations = new Set<Operation>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: ConfiguredToolHookServiceOptions) {
    const copiedKeys: Buffer[] = [];
    try {
      const o = plain(options); keys(o, ["hooks"], ["enabled", "timeoutMs", "maxConcurrentPerUser", "tenantRuntime", "authorizeSubject", "allowLoopbackForTests"]);
      if (o.enabled !== undefined && typeof o.enabled !== "boolean"
        || o.allowLoopbackForTests !== undefined && typeof o.allowLoopbackForTests !== "boolean"
        || o.authorizeSubject !== undefined && typeof o.authorizeSubject !== "function") fail();
      this.timeout = options.timeoutMs ?? 1500; this.maximum = options.maxConcurrentPerUser ?? 2;
      if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 5000
        || !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 8) fail();
      this.fixture = o.allowLoopbackForTests === true; this.runtime = options.tenantRuntime; this.authorize = options.authorizeSubject;
      const raw = array(o.hooks); if (raw.length > 8 || o.enabled === true && !raw.length) fail();
      const ids = new Set<string>(); const hooks: Hook[] = [];
      for (const value of raw) {
        const h = plain(value); const id = name(h.id), p = phase(h.phase);
        if (ids.has(id)) fail(); ids.add(id);
        const subjects = array(h.subjects).map(principal); if (!subjects.length || subjects.length > 64
          || new Set(subjects.map(ownerKey)).size !== subjects.length) fail();
        // Identity is exact code units, not locale collation (which can equate
        // distinct Unicode spellings and leave ACL order in the signed digest).
        subjects.sort((a, b) => { const left = ownerKey(a), right = ownerKey(b); return left < right ? -1 : left > right ? 1 : 0; });
        const common = { id, phase: p, subjects: Object.freeze(subjects) };
        if (h.kind === "deny-tools") {
          keys(h, ["id", "phase", "subjects", "kind", "tools"]); if (p !== "preToolUse") fail();
          const tools = array(h.tools).map(name); if (!tools.length || tools.length > 64 || new Set(tools).size !== tools.length) fail();
          tools.sort(); const data = { ...common, phase: "preToolUse", kind: "deny-tools", tools: Object.freeze(tools) } as const;
          hooks.push(Object.freeze({ ...data, configSha256: hash("agent-service-tool-hook-config-v1", data) }));
        } else if (h.kind === "observe-tool-result") {
          keys(h, ["id", "phase", "subjects", "kind"]); if (p !== "postToolUse") fail();
          const data = { ...common, phase: "postToolUse", kind: "observe-tool-result" } as const;
          hooks.push(Object.freeze({ ...data, configSha256: hash("agent-service-tool-hook-config-v1", data) }));
        } else if (h.kind === "webhook") {
          keys(h, ["id", "phase", "subjects", "kind", "endpoint", "signingKey"]);
          const endpoint = new URL(text(h.endpoint, 2048)).href, key = keyBytes(h.signingKey); copiedKeys.push(key);
          // Validation has no I/O. The unchanged HTTP substrate also gates the actual request.
          const checked = createMcpHttpFetch({ endpoint, maxRequestBytes: MAX_REQUEST, maxResponseBytes: MAX_RESPONSE,
            timeoutMs: this.timeout, allowLoopbackForTests: this.fixture }); void checked.close();
          const data = { ...common, kind: "webhook", endpoint,
            signingKeySha256: hash("agent-service-tool-hook-key-pin-v1", key.toString("hex")) } as const;
          hooks.push(Object.freeze({ ...common, kind: "webhook", endpoint, signingKey: key,
            configSha256: hash("agent-service-tool-hook-config-v1", data) }));
        } else fail();
      }
      this.hooks = Object.freeze(hooks); this.enabled = o.enabled === true;
    } catch { copiedKeys.forEach(key => key.fill(0)); throw new ApiError("invalid_request", "Tool hook configuration is invalid."); }
  }

  version(owner: Principal): string | undefined {
    let p: Readonly<Principal>;
    try { p = principal(owner); } catch { throw new ApiError("invalid_request", MESSAGE); }
    const hooks = this.selection(p); if (!hooks.length) return undefined;
    return hash("agent-service-tool-hook-owner-version-v1", { owner: p,
      hooks: hooks.map(h => h.configSha256), timeoutMs: this.timeout, maxConcurrentPerUser: this.maximum });
  }
  private selection(owner: Principal): Hook[] {
    if (!this.enabled) return [];
    const key = ownerKey(owner); return this.hooks.filter(h => h.subjects.some(subject => ownerKey(subject) === key));
  }
  async preToolUse(value: ToolHookContext, signal: AbortSignal): Promise<ToolHookPreResult> {
    return this.run(value, signal, "preToolUse");
  }
  async postToolUse(value: ToolHookPostContext, signal: AbortSignal): Promise<readonly ToolHookReport[]> {
    return (await this.run(value, signal, "postToolUse")).reports;
  }
  private run(value: ToolHookContext | ToolHookPostContext, caller: AbortSignal, p: ToolHookPhase): Promise<ToolHookPreResult> {
    let ctx: Readonly<ToolHookPostContext>;
    try { ctx = context(value, p === "postToolUse"); if (!(caller instanceof AbortSignal)) fail(); }
    catch { return Promise.reject(new ApiError("invalid_request", MESSAGE)); }
    const selected = this.selection(ctx.owner).filter(h => h.phase === p);
    const result = (allow: boolean, reports: ToolHookReport[]): ToolHookPreResult => Object.freeze({ allow, reports: Object.freeze(reports) });
    if (!selected.length) return Promise.resolve(result(true, []));
    const rejected = (outcome: ToolHookOutcome) => result(false, selected.map((h, i) => report(h, i ? "skipped" : outcome)));
    const key = ownerKey(ctx.owner), active = this.users.get(key) ?? 0;
    if (caller.aborted) return Promise.resolve(rejected("cancelled"));
    if (this.closed || active >= this.maximum) return Promise.resolve(rejected("failed"));
    let lease: ReturnType<TenantRuntimeCoordinator["enter"]> | undefined;
    try { lease = this.runtime?.enter(ctx.owner.tenantId, "provider"); } catch { return Promise.resolve(rejected("failed")); }
    const abort = new AbortController(), signal = AbortSignal.any([caller, abort.signal, ...(lease ? [lease.signal] : [])]);
    const until = performance.now() + this.timeout; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeout);
    this.users.set(key, active + 1);
    const assertOpen = () => {
      if (performance.now() >= until) { timedOut = true; abort.abort(); }
      if (signal.aborted || this.closed) fail(); lease?.assertOpen();
    };
    const authorize = async () => {
      assertOpen(); if (this.authorize) await this.authorize(ctx.owner); assertOpen();
      // Authorization may be non-cancellable. Its actual promise is awaited even
      // after the deadline; no socket or lease is released while it is unsettled.
    };
    const op: Operation = { abort, done: Promise.resolve() }; this.operations.add(op);
    // Defer callbacks until op.done is assigned, so a synchronous callback calling
    // close() cannot escape the service's operation/drain accounting.
    const done = Promise.resolve().then(async () => {
      const reports: ToolHookReport[] = []; let allow = true;
      try {
        for (let i = 0; i < selected.length; i++) {
          const h = selected[i]!;
          try {
            await authorize(); let outcome: ToolHookOutcome;
            if (h.kind === "deny-tools") outcome = h.tools.includes(ctx.tool.name) ? "denied" : "allowed";
            else if (h.kind === "observe-tool-result") outcome = ctx.isError ? "tool_error" : "tool_success";
            else {
              const decision = await this.webhook(h, ctx, signal, until, authorize);
              outcome = decision === "ack" ? "acknowledged" : decision === "allow" ? "allowed" : "denied";
            }
            await authorize(); reports.push(report(h, outcome));
            if (p === "preToolUse" && outcome === "denied") { allow = false; break; }
          } catch (error) {
            const outcome: ToolHookOutcome = timedOut || performance.now() >= until
              || error instanceof McpHttpError && error.code === "deadline_exceeded" ? "timed_out" : signal.aborted ? "cancelled" : "failed";
            reports.push(report(h, outcome));
            if (p === "preToolUse") { allow = false; break; }
            if (signal.aborted || this.closed) break;
          }
        }
        for (let i = reports.length; i < selected.length; i++) reports.push(report(selected[i]!, "skipped"));
        return result(allow, reports);
      } finally {
        abort.abort(); clearTimeout(timer); lease?.release();
        const current = (this.users.get(key) ?? 1) - 1;
        if (current) this.users.set(key, current); else this.users.delete(key);
        this.operations.delete(op);
      }
    });
    op.done = done; return done;
  }
  private async webhook(h: Extract<Hook, { kind: "webhook" }>, ctx: Readonly<ToolHookPostContext>, signal: AbortSignal,
    until: number, authorize: () => Promise<void>): Promise<"allow" | "deny" | "ack"> {
    await authorize();
    const ref = (kind: string, identity: unknown) => mac(h.signingKey, `agent-service-tool-hook-ref-${kind}-v1`, identity);
    const base = { schema: REQUEST_SCHEMA, hookId: h.id, phase: h.phase, invocationId: randomBytes(16).toString("hex"),
      configSha256: h.configSha256,
      refs: { tenant: ref("tenant", [ctx.owner.tenantId]), user: ref("user", [ctx.owner.tenantId, ctx.owner.userId]),
        session: ref("session", [ctx.owner.tenantId, ctx.owner.userId, ctx.sessionId]),
        turn: ref("turn", [ctx.owner.tenantId, ctx.owner.userId, ctx.sessionId, ctx.turnId]),
        toolCall: ref("tool-call", [ctx.owner.tenantId, ctx.owner.userId, ctx.sessionId, ctx.turnId, ctx.toolCallId]) },
      tool: ctx.tool, isError: h.phase === "preToolUse" ? null : ctx.isError } as const;
    const signed = { ...base, requestSha256: hash("agent-service-tool-hook-request-digest-v1", base) };
    const request: ToolHookWebhookRequest = { ...signed, macSha256: mac(h.signingKey, "agent-service-tool-hook-request-mac-v1", signed) };
    const bytes = JSON.stringify(request); if (Buffer.byteLength(bytes) > MAX_REQUEST) fail();
    const owned = createMcpHttpFetch({ endpoint: h.endpoint, maxRequestBytes: MAX_REQUEST, maxResponseBytes: MAX_RESPONSE,
      timeoutMs: Math.max(1, Math.floor(until - performance.now())), allowLoopbackForTests: this.fixture });
    try {
      await authorize();
      const response = await owned(h.endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: bytes, signal });
      if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) fail();
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.byteLength > MAX_RESPONSE) fail();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      await authorize(); return responseDecision(text, request, h.signingKey);
    } finally { await owned.close(); }
  }
  /** Process owner cancellation only: no cipher/coordination/SQL dependency is closed here. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const op of this.operations) op.abort.abort();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stop(); const operations = [...this.operations];
    return this.closing = Promise.allSettled(operations.map(op => op.done)).then(() => {
      // Best effort on this service-owned copy only, not a zeroization claim.
      for (const h of this.hooks) if (h.kind === "webhook") h.signingKey.fill(0);
    });
  }
}
