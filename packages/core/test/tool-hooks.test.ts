import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Principal } from "@agent-service/protocol";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import { ConfiguredToolHookService, createToolHookWebhookResponse, validateToolHookWebhookRequest } from "../src/hooks/service.js";
import type { ConfiguredToolHookServiceOptions, ToolHookContext, ToolHookDefinition,
  ToolHookPostContext, ToolHookWebhookRequest } from "../src/hooks/types.js";

const owner: Principal = { tenantId: "tenant-hook-canary", userId: "user-hook-canary" };
const foreignUser: Principal = { ...owner, userId: "foreign-user" };
const foreignTenant: Principal = { ...owner, tenantId: "foreign-tenant" };
const key = () => Buffer.alloc(32, 71);
const signal = () => new AbortController().signal;
const ctx = (p: Principal = owner): ToolHookContext => ({ owner: p, sessionId: "session-hook-canary",
  turnId: "turn-hook-canary", toolCallId: "call-hook-canary", tool: { name: "echo", kind: "builtin", readOnly: true } });
const post = (isError = false, p = owner): ToolHookPostContext => ({ ...ctx(p), isError });
const deny = (tools: string[] = ["write"]): ToolHookDefinition => ({ id: "deny", kind: "deny-tools",
  phase: "preToolUse", subjects: [owner], tools });
const observer = (): ToolHookDefinition => ({ id: "observer", kind: "observe-tool-result", phase: "postToolUse", subjects: [owner] });
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const cleanup: (() => Promise<unknown>)[] = [];
function service(hooks: readonly ToolHookDefinition[], extra: Partial<ConfiguredToolHookServiceOptions> = {}) {
  const value = new ConfiguredToolHookService({ enabled: true, hooks, ...extra });
  cleanup.push(() => value.close()); return value;
}
type Handler = (message: Readonly<ToolHookWebhookRequest>, request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
/** Anonymous, real JSON POST on a fixture-owned loopback socket, not a fetch mock.
 * Root alone executes this test file; no models or external network are involved. */
async function webhook(handler?: Handler) {
  const messages: Readonly<ToolHookWebhookRequest>[] = [], headers: IncomingMessage["headers"][] = [];
  let connections = 0, closed = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length;
        if (length > 16_384) { request.destroy(); return; } chunks.push(bytes); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const message = validateToolHookWebhookRequest(value, key()); messages.push(message); headers.push(request.headers);
      if (handler) { await handler(message, request, response); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createToolHookWebhookResponse(message, message.phase === "preToolUse" ? "allow" : "ack", key())));
    })().catch(() => response.destroy());
  });
  server.on("connection", socket => { connections++; socket.once("close", () => { closed++; }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const definition = (phase: "preToolUse" | "postToolUse" = "preToolUse", id = "remote"): ToolHookDefinition =>
    ({ id, kind: "webhook", phase, endpoint, subjects: [owner], signingKey: key() });
  return { messages, headers, endpoint, definition, connections: () => connections, closed: () => closed };
}
function remoteService(f: Awaited<ReturnType<typeof webhook>>, extra: Partial<ConfiguredToolHookServiceOptions> = {}) {
  return service([f.definition()], { allowLoopbackForTests: true, ...extra });
}
function jsonReply(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("fixed operator hook configuration and owner isolation", () => {
  it("is disabled by default and preserves the no-hooks owner epoch", async () => {
    const f = await webhook(), s = service([f.definition()], { enabled: false, allowLoopbackForTests: true });
    expect(s.enabled).toBe(false); expect(s.version(owner)).toBeUndefined();
    expect(await s.preToolUse(ctx(), signal())).toEqual({ allow: true, reports: [] });
    expect(await s.postToolUse(post(), signal())).toEqual([]); expect(f.connections()).toBe(0);
  });
  it.each([foreignUser, foreignTenant])("applies only exact tenant and user ACLs", async p => {
    const f = await webhook(), s = remoteService(f);
    expect(s.version(p)).toBeUndefined(); expect(await s.preToolUse(ctx(p), signal())).toEqual({ allow: true, reports: [] });
    expect(f.connections()).toBe(0); expect(s.version(owner)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("runs fixed deny-tools before execution even for read-only tools", async () => {
    const s = service([deny(["echo"])]), result = await s.preToolUse(ctx(), signal());
    expect(result.allow).toBe(false); expect(result.reports).toEqual([{ hookId: "deny", phase: "preToolUse", kind: "deny-tools",
      outcome: "denied", configSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.reports[0])).toBe(true);
    expect((await s.preToolUse({ ...ctx(), tool: { name: "other", kind: "mcp", readOnly: false } }, signal())).allow).toBe(true);
  });
  it("reports only content-free canonical result status, without changing the result", async () => {
    const s = service([observer()]);
    expect((await s.postToolUse(post(), signal()))[0]?.outcome).toBe("tool_success");
    const reports = await s.postToolUse(post(true), signal()); expect(reports[0]?.outcome).toBe("tool_error");
    expect(Object.keys(reports[0]!).sort()).toEqual(["configSha256", "hookId", "kind", "outcome", "phase"]);
    expect(JSON.stringify(reports)).not.toContain("canary");
  });
  it("snapshots config/subjects and binds owner, order and limits into the immutable version", async () => {
    const subjects = [{ ...owner }], tools = ["echo"];
    const hooks: ToolHookDefinition[] = [{ id: "deny", phase: "preToolUse", kind: "deny-tools", subjects, tools }, observer()];
    const s = service(hooks), version = s.version(owner); subjects[0]!.userId = "changed"; tools[0] = "other"; hooks.reverse();
    expect(s.version(owner)).toBe(version); expect((await s.preToolUse(ctx(), signal())).allow).toBe(false);
    expect(service([observer(), deny(["echo"])]).version(owner)).not.toBe(version);
    expect(service([deny(["echo"]), observer()], { timeoutMs: 1501 }).version(owner)).not.toBe(version);
  });
  it("canonicalizes ACL permutations by exact Unicode identity, not locale equivalence", () => {
    const a: Principal = { tenantId: "é", userId: "same-user" };
    const b: Principal = { tenantId: "e\u0301", userId: "same-user" };
    const c: Principal = { tenantId: "ASCII", userId: "same-user" };
    const variants = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const sources = variants.map(subjects => service([{ ...deny(), subjects }]));
    for (const subject of [a, b, c]) {
      const version = sources[0]!.version(subject); expect(version).toMatch(/^[a-f0-9]{64}$/);
      expect(sources.map(s => s.version(subject))).toEqual(Array(variants.length).fill(version));
    }
    expect(sources[0]!.version(a)).not.toBe(sources[0]!.version(b));
  });
  it.each([
    { hooks: [], enabled: true }, { hooks: [deny()], timeoutMs: 5001 }, { hooks: [deny()], timeoutMs: 0 },
    { hooks: [deny()], maxConcurrentPerUser: 9 }, { hooks: [deny(), deny()] },
    { hooks: [{ ...deny(), tools: ["echo", "echo"] }] }, { hooks: [{ ...deny(), subjects: [owner, owner] }] },
    { hooks: [{ ...observer(), phase: "preToolUse" }] }, { hooks: [{ ...deny(), headers: { authorization: "secret-canary" } }] },
    { hooks: [deny()], fetch: () => Promise.resolve() },
  ])("rejects invalid or extensible configuration without echoing input", options => {
    expect(() => new ConfiguredToolHookService(options as unknown as ConfiguredToolHookServiceOptions))
      .toThrowError(new ApiError("invalid_request", "Tool hook configuration is invalid."));
  });
  it("never evaluates configuration or context accessors", async () => {
    const read = vi.fn(() => "secret-canary"), invalid = { ...deny() }; Object.defineProperty(invalid, "id", { get: read, enumerable: true });
    expect(() => service([invalid])).toThrowError("Tool hook configuration is invalid.");
    const s = service([deny()]), value = { ...ctx() }; Object.defineProperty(value, "toolCallId", { get: read, enumerable: true });
    await expect(s.preToolUse(value, signal())).rejects.toMatchObject({ code: "invalid_request", message: "Tool hook request failed." });
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses overlong tool call metadata before any request", async () => {
    const f = await webhook(), s = remoteService(f);
    await expect(s.preToolUse({ ...ctx(), toolCallId: "x".repeat(257) }, signal())).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.connections()).toBe(0);
  });
  it("keeps policy applicable after close, and does not silently bypass it", async () => {
    const s = service([deny()]), version = s.version(owner); await s.close();
    expect(s.version(owner)).toBe(version); expect(s.enabled).toBe(true);
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
  });
});

describe("authenticated anonymous webhook wire", () => {
  it("uses real anonymous POST, independent copied key and opaque kind-separated owner refs", async () => {
    const f = await webhook(), configuredKey = key(), s = service([{ ...f.definition(), signingKey: configuredKey } as ToolHookDefinition], { allowLoopbackForTests: true });
    configuredKey.fill(0); const version = s.version(owner);
    const result = await s.preToolUse(ctx(), signal()); expect(result).toMatchObject({ allow: true, reports: [{ outcome: "allowed" }] });
    expect(f.messages).toHaveLength(1); const r = f.messages[0]!;
    expect(r.phase).toBe("preToolUse"); expect(r.isError).toBeNull(); expect(r.invocationId).toMatch(/^[a-f0-9]{32}$/);
    expect(Object.values(r.refs).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(new Set(Object.values(r.refs)).size).toBe(5); expect(Object.isFrozen(r.refs)).toBe(true);
    const wire = JSON.stringify(r); expect(wire).not.toContain("canary"); expect(wire).not.toContain("http");
    expect(wire).not.toContain("signingKey"); expect(Object.keys(r.tool).sort()).toEqual(["kind", "name", "readOnly"]);
    expect(f.headers[0]).toMatchObject({ "content-type": "application/json", accept: "application/json", "accept-encoding": "identity" });
    expect(f.headers[0]?.authorization).toBeUndefined(); expect(f.headers[0]?.cookie).toBeUndefined();
    expect(f.headers[0]?.["mcp-protocol-version"]).toBeUndefined(); expect(s.version(owner)).toBe(version);
  });
  it("accepts an authenticated deny and never dispatches the later hook", async () => {
    const f = await webhook((r, _req, res) => jsonReply(res, createToolHookWebhookResponse(r, "deny", key())));
    const s = service([f.definition(), f.definition("preToolUse", "later")], { allowLoopbackForTests: true });
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "denied" }, { outcome: "skipped" }] });
    expect(f.messages).toHaveLength(1);
  });
  it("post is only authenticated ACK/observation and includes only the error boolean", async () => {
    const f = await webhook(), s = service([f.definition("postToolUse"), observer()], { allowLoopbackForTests: true });
    expect(await s.postToolUse(post(true), signal())).toMatchObject([{ outcome: "acknowledged" }, { outcome: "tool_error" }]);
    expect(f.messages[0]?.isError).toBe(true); expect(f.messages[0]?.phase).toBe("postToolUse");
  });
  it("the operator helpers authenticate the entire closed request before signing any response", async () => {
    const f = await webhook(); await remoteService(f).preToolUse(ctx(), signal()); const r = f.messages[0]!;
    expect(validateToolHookWebhookRequest(r, key())).toEqual(r);
    for (const changed of [{ ...r, hookId: "changed" }, { ...r, refs: { ...r.refs, user: "0".repeat(64) } },
      { ...r, tool: { ...r.tool, readOnly: false } }, { ...r, unexpected: "secret-canary" }]) {
      expect(() => validateToolHookWebhookRequest(changed, key())).toThrowError("Tool hook message is invalid.");
      expect(() => createToolHookWebhookResponse(changed, "allow", key())).toThrowError("Tool hook message is invalid.");
    }
    expect(() => createToolHookWebhookResponse(r, "ack", key())).toThrowError("Tool hook message is invalid.");
    expect(() => validateToolHookWebhookRequest(r, Buffer.alloc(32, 72))).toThrowError("Tool hook message is invalid.");
    expect(() => validateToolHookWebhookRequest(r, Buffer.alloc(31))).toThrowError("Tool hook message is invalid.");
  });
  it.each(["schema", "hookId", "phase", "invocationId", "configSha256", "requestSha256", "decision", "macSha256", "extra"])
    ("rejects a changed response %s rather than allowing a tool", async field => {
      const f = await webhook((r, _req, res) => {
        const signed = createToolHookWebhookResponse(r, "allow", key()); jsonReply(res, { ...signed, [field]: "changed-canary" });
      });
      expect(await remoteService(f).preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
      expect(f.messages).toHaveLength(1);
    });
  it("rejects a valid MAC replayed from a different invocation", async () => {
    let previous: ReturnType<typeof createToolHookWebhookResponse> | undefined;
    const f = await webhook((r, _req, res) => { previous ??= createToolHookWebhookResponse(r, "allow", key()); jsonReply(res, previous); });
    const s = remoteService(f); expect((await s.preToolUse(ctx(), signal())).allow).toBe(true);
    expect((await s.preToolUse(ctx(), signal())).allow).toBe(false); expect(f.messages).toHaveLength(2);
    expect(f.messages[0]?.invocationId === f.messages[1]?.invocationId).toBe(false);
  });
  it.each(["duplicate", "escaped_duplicate", "non_json", "oversized", "utf8", "redirect", "status", "response_loss"])
    ("fails closed without retry on %s", async mode => {
      const f = await webhook((r, req, res) => {
        const signed = JSON.stringify(createToolHookWebhookResponse(r, "allow", key()));
        if (mode === "response_loss") { req.socket.destroy(); return; }
        if (mode === "redirect") { res.writeHead(302, { location: "/another" }); res.end(); return; }
        if (mode === "status") { res.writeHead(503); res.end("remote-secret-canary"); return; }
        res.writeHead(200, { "content-type": mode === "non_json" ? "text/plain" : "application/json" });
        if (mode === "duplicate") res.end(signed.slice(0, -1) + ',"decision":"allow"}');
        else if (mode === "escaped_duplicate") res.end(signed.slice(0, -1) + ',"decisi\\u006fn":"allow"}');
        else if (mode === "oversized") res.end("x".repeat(8193));
        else if (mode === "utf8") res.end(Buffer.from([0xff]));
        else res.end(signed);
      });
      const result = await remoteService(f).preToolUse(ctx(), signal()); expect(result.allow).toBe(false);
      expect(result.reports[0]?.outcome).toBe("failed"); expect(JSON.stringify(result)).not.toContain("canary"); expect(f.messages).toHaveLength(1);
    });
  it("post remote failure is fail-open and later local observers still run", async () => {
    const f = await webhook((_r, _req, res) => { res.writeHead(500); res.end("secret-canary"); });
    const s = service([f.definition("postToolUse"), observer()], { allowLoopbackForTests: true });
    expect(await s.postToolUse(post(), signal())).toMatchObject([{ outcome: "failed" }, { outcome: "tool_success" }]);
    expect(f.messages).toHaveLength(1);
  });
  it("requires both explicit fixture gates and does not accept auth/fetch injection", async () => {
    const f = await webhook(); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "0");
    expect(() => remoteService(f)).toThrowError("Tool hook configuration is invalid.");
    vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("NODE_ENV", "production");
    expect(() => remoteService(f)).toThrowError("Tool hook configuration is invalid."); expect(f.connections()).toBe(0);
  });
});

describe("whole-phase budget, authorization, cancellation and real runtime drain", () => {
  it("checks fresh subject authorization before and after webhook I/O", async () => {
    const f = await webhook(), authorize = vi.fn(async (_owner: Principal) => {}), s = remoteService(f, { authorizeSubject: authorize });
    expect((await s.preToolUse(ctx(), signal())).allow).toBe(true); expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(authorize.mock.calls.every(args => JSON.stringify(args[0]) === JSON.stringify(owner))).toBe(true);
    const denied = remoteService(f, { authorizeSubject: async () => { throw new Error("raw-key-canary"); } });
    const result = await denied.preToolUse(ctx(), signal()); expect(result).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
    expect(JSON.stringify(result)).not.toContain("canary"); expect(f.messages).toHaveLength(1);
  });
  it("does not allow a stale subject after a successful remote response", async () => {
    let active = true;
    const f = await webhook((r, _req, res) => { active = false; jsonReply(res, createToolHookWebhookResponse(r, "allow", key())); });
    const s = remoteService(f, { authorizeSubject: async () => { if (!active) throw new Error("subject unavailable"); } });
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] }); expect(f.messages).toHaveLength(1);
  });
  it("has one budget for all hooks rather than resetting a timeout per endpoint", async () => {
    const f = await webhook(async (r, _req, res) => { await pause(45); if (!res.destroyed) jsonReply(res, createToolHookWebhookResponse(r, "allow", key())); });
    const s = service([f.definition(), f.definition("preToolUse", "second"), f.definition("preToolUse", "third")],
      { allowLoopbackForTests: true, timeoutMs: 75 });
    const result = await s.preToolUse(ctx(), signal()); expect(result.allow).toBe(false);
    expect(result.reports.some(r => r.outcome === "timed_out")).toBe(true); expect(result.reports.at(-1)?.outcome).toBe("skipped");
    expect(f.messages.length).toBeLessThanOrEqual(2);
  });
  it("caller cancellation closes pending HTTP and never starts a later hook", async () => {
    const entered = deferred<void>(); const f = await webhook(() => { entered.resolve(); });
    const s = service([f.definition(), f.definition("preToolUse", "later")], { allowLoopbackForTests: true });
    const control = new AbortController(), work = s.preToolUse(ctx(), control.signal); await entered.promise; control.abort();
    expect(await work).toMatchObject({ allow: false, reports: [{ outcome: "cancelled" }, { outcome: "skipped" }] });
    await s.close(); expect(f.messages).toHaveLength(1);
  });
  it("bounds same-owner concurrency without limiting another authorized user", async () => {
    const entered = deferred<void>(), release = deferred<void>(); let blocked = true;
    const f = await webhook(async (r, _req, res) => { if (blocked) { entered.resolve(); await release.promise; }
      if (!res.destroyed) jsonReply(res, createToolHookWebhookResponse(r, "allow", key())); });
    const definition: ToolHookDefinition = { ...f.definition(), subjects: [owner, foreignUser] };
    const s = service([definition], { allowLoopbackForTests: true, maxConcurrentPerUser: 1 });
    const first = s.preToolUse(ctx(), signal()); await entered.promise;
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
    blocked = false; expect((await s.preToolUse(ctx(foreignUser), signal())).allow).toBe(true);
    release.resolve(); expect((await first).allow).toBe(true); expect(f.messages).toHaveLength(2);
  });
  it("retains its real operation lease until a non-cancellable authorization settles", async () => {
    const runtime = new TenantRuntimeCoordinator(); runtime.sealParticipants();
    const entered = deferred<void>(), release = deferred<void>(), f = await webhook();
    const s = remoteService(f, { tenantRuntime: runtime, authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const work = s.preToolUse(ctx(), signal()); await entered.promise;
    expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(1);
    let drained = false;
    const draining = runtime.drain({ tenantId: owner.tenantId, requestId: "request", subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 500)
      .then(value => { drained = true; return value; });
    await pause(10); expect(drained).toBe(false); expect(runtime.snapshot(owner.tenantId).providerOperations).toBe(1);
    release.resolve(); expect(await work).toMatchObject({ allow: false, reports: [{ outcome: "cancelled" }] });
    expect((await draining).activeOperationCountAfter).toBe(0); expect(f.connections()).toBe(0);
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
  });
  it("close fences new operations, aborts existing sockets and waits for actual auth settlement", async () => {
    const f = await webhook(), entered = deferred<void>(), release = deferred<void>();
    const s = remoteService(f, { authorizeSubject: async () => { entered.resolve(); await release.promise; } });
    const work = s.preToolUse(ctx(), signal()); await entered.promise;
    let finished = false; const closing = s.close().then(() => { finished = true; });
    expect(s.close()).toBe(s.close()); await pause(10); expect(finished).toBe(false);
    expect(await s.preToolUse(ctx(), signal())).toMatchObject({ allow: false, reports: [{ outcome: "failed" }] });
    release.resolve(); expect((await work).allow).toBe(false); await closing; expect(finished).toBe(true); expect(f.connections()).toBe(0);
  });
  it("does not reset post phase budget and skips remaining observers after cancellation", async () => {
    const entered = deferred<void>(), f = await webhook(() => { entered.resolve(); });
    const s = service([f.definition("postToolUse"), observer()], { allowLoopbackForTests: true });
    const control = new AbortController(), work = s.postToolUse(post(), control.signal); await entered.promise; control.abort();
    expect(await work).toMatchObject([{ outcome: "cancelled" }, { outcome: "skipped" }]); expect(f.messages).toHaveLength(1);
  });
});
