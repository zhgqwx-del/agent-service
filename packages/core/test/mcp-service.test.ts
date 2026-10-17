import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Principal } from "@agent-service/protocol";
import { ConfiguredMcpToolSource } from "../src/mcp/service.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import type { RunnerTool, ToolExecutionContext } from "../src/tools/types.js";

const owner: Principal = { tenantId: "tenant-a", userId: "user-a" };
const otherUser: Principal = { tenantId: "tenant-a", userId: "user-b" };
const otherTenant: Principal = { tenantId: "tenant-b", userId: "user-a" };
const abort = () => new AbortController();
const context = (principal = owner, signal = abort().signal): ToolExecutionContext => ({
  principal, signal, sessionId: "session-fixture", turnId: "turn-fixture", toolCallId: "call-fixture",
});
function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
type Rpc = { id: string | number; method: string; params?: Record<string, unknown> };
type Reply = { result: unknown } | { error: { code: number; message: string; data?: unknown } };
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanup: (() => Promise<unknown>)[] = [];
const tool = (overrides: Record<string, unknown> = {}) => ({ name: "echo", description: "Untrusted echo",
  inputSchema: { type: "object", properties: { value: { type: "string", maxLength: 32 } }, required: ["value"], additionalProperties: false },
  ...overrides });

/** Real stateless modern JSON-RPC over HTTP, not an SDK/request result mock.
 * Only fixture-owned loopback ports are used when root executes this suite. */
async function fixture(handler?: (rpc: Rpc, request: IncomingMessage, response: ServerResponse) => Promise<Reply | undefined> | Reply | undefined) {
  const requests: Rpc[] = [], headers: IncomingMessage["headers"][] = [];
  let tools: unknown[] = [tool()];
  let capabilities: Record<string, unknown> = { tools: {} };
  let versions = ["2026-07-28"];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; let n = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); n += bytes.length;
        if (n > 131072) { request.destroy(); return; } chunks.push(bytes); }
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc;
      requests.push(rpc); headers.push(request.headers);
      const custom = await handler?.(rpc, request, response);
      if (response.writableEnded || response.destroyed) return;
      if (handler && custom === undefined && rpc.method === "tools/call") return;
      const result: Reply = custom ?? (rpc.method === "server/discover"
        ? { result: { supportedVersions: versions, capabilities } }
        : rpc.method === "tools/list" ? { result: { tools, ttlMs: 0, cacheScope: "private" } }
          : rpc.method === "tools/call" ? { result: { content: [{ type: "text", text: "fixture result" }] } }
            : { error: { code: -32601, message: "fixture method unavailable" } });
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      // The modern codec requires an explicit resultType on every normal result;
      // only its discovery probe has an absent-means-complete parse bridge.
      // List cache metadata is mandatory too, but the service never uses a cache.
      const wire = "result" in result ? { result: { resultType: "complete",
        ...(rpc.method === "tools/list" ? { ttlMs: 0, cacheScope: "private" } : {}),
        ...(result.result as Record<string, unknown>) } } : result;
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...wire }));
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { endpoint, requests, headers, setTools: (value: unknown[]) => { tools = value; },
    setCapabilities: (value: Record<string, unknown>) => { capabilities = value; },
    setVersions: (value: string[]) => { versions = value; } };
}
function source(f: Fixture, options: Partial<ConstructorParameters<typeof ConfiguredMcpToolSource>[0]> = {}) {
  const value = new ConfiguredMcpToolSource({ servers: [{ id: "alpha", endpoint: f.endpoint, subjects: [owner] }],
    allowLoopbackForTests: true, ...options });
  cleanup.push(() => value.close()); return value;
}
async function mounted(s: ConfiguredMcpToolSource, principal = owner) {
  const tools = await s.resolve(principal, ["alpha"], abort().signal);
  expect(tools).toHaveLength(1); return tools[0]!;
}
const scope = (value: RunnerTool): unknown => Object.getOwnPropertyDescriptor(value, "approvalScope")?.value;
const methods = (f: Fixture, name: string) => f.requests.filter(request => request.method === name);

beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("configured MCP mount boundaries", () => {
  it("allows empty disabled mounts without opening a connection", async () => {
    const s = new ConfiguredMcpToolSource({ servers: [] }); cleanup.push(() => s.close());
    expect(s.enabled).toBe(false); expect(() => s.validateMounts(owner, [])).not.toThrow();
    expect(await s.resolve(owner, [], abort().signal)).toEqual([]);
  });
  it("accepts a shared-Principal-valid 100-character Unicode tenant in configured mounts", async () => {
    const unicodeOwner = { ...owner, tenantId: "租".repeat(100) };
    expect(unicodeOwner.tenantId.length).toBe(100); expect(Buffer.byteLength(unicodeOwner.tenantId)).toBeGreaterThan(128);
    const f = await fixture(), s = source(f, { servers: [{ id: "alpha", endpoint: f.endpoint, subjects: [unicodeOwner] }] });
    expect(s.enabled).toBe(true); expect(() => s.validateMounts(unicodeOwner, ["alpha"])).not.toThrow();
    expect(await mounted(s, unicodeOwner)).toMatchObject({ kind: "mcp", mandatoryApproval: true });
    expect(methods(f, "server/discover")).toHaveLength(1); expect(methods(f, "tools/list")).toHaveLength(1);
    expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("does not reject a valid unmatched Unicode owner requesting no mounts by UTF-8 byte length", async () => {
    const unicodeOwner = { ...owner, tenantId: "租".repeat(100) }, f = await fixture(), s = source(f);
    expect(() => s.validateMounts(unicodeOwner, [])).not.toThrow();
    expect(await s.resolve(unicodeOwner, [], abort().signal)).toEqual([]);
    expect(f.requests).toHaveLength(0);
  });
  it.each([
    { ...owner, tenantId: "t".repeat(129) },
    { ...owner, userId: "*" },
  ])("enforces the shared Principal grammar at direct core configuration and empty-mount entry %#", async invalidOwner => {
    const f = await fixture(), s = source(f);
    expect(() => source(f, { servers: [{ id: "alpha", endpoint: f.endpoint, subjects: [invalidOwner] }] }))
      .toThrowError(new ApiError("invalid_request", "MCP configuration is invalid."));
    expect(() => s.validateMounts(invalidOwner, [])).toThrowError(new ApiError("not_found", "MCP mount not found."));
    await expect(s.resolve(invalidOwner, [], abort().signal)).rejects.toMatchObject({ code: "not_found", message: "MCP mount not found." });
    expect(f.requests).toHaveLength(0);
  });
  it.each([otherUser, otherTenant])("makes a foreign owner indistinguishable from a missing mount", async principal => {
    const f = await fixture(), s = source(f);
    for (const ids of [["alpha"], ["missing"]]) {
      expect(() => s.validateMounts(principal, ids)).toThrowError(new ApiError("not_found", "MCP mount not found."));
      await expect(s.resolve(principal, ids, abort().signal)).rejects.toMatchObject({ code: "not_found" });
    }
    expect(f.requests).toHaveLength(0);
  });
  it("rejects duplicate/unknown mounts and index accessors without evaluating them", async () => {
    const f = await fixture(), s = source(f), read = vi.fn(() => "alpha");
    const ids: string[] = []; Object.defineProperty(ids, "0", { get: read, enumerable: true }); ids.length = 1;
    expect(() => s.validateMounts(owner, ids)).toThrow(); expect(read).not.toHaveBeenCalled();
    expect(() => s.validateMounts(owner, ["alpha", "alpha"])).toThrow();
    expect(() => s.validateMounts(owner, ["missing"])).toThrow(); expect(f.requests).toHaveLength(0);
  });
  it("snapshots config/ACL before any async work and refuses injected auth options", async () => {
    const f = await fixture(); const subjects = [{ ...owner }]; const servers = [{ id: "alpha", endpoint: f.endpoint, subjects }];
    const s = source(f, { servers }); subjects[0]!.userId = "replaced"; servers[0]!.endpoint = "https://example.invalid/mcp";
    expect(await mounted(s)).toBeDefined();
    expect(() => new ConfiguredMcpToolSource({ servers: [], headers: { authorization: "canary" } } as unknown as ConstructorParameters<typeof ConfiguredMcpToolSource>[0])).toThrowError("MCP configuration is invalid.");
  });
  it("requires the explicit fixture gates for loopback HTTP", async () => {
    const f = await fixture(); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "0");
    expect(() => source(f)).toThrowError("MCP configuration is invalid."); expect(f.requests).toHaveLength(0);
  });
});

describe("real modern protocol and immutable mounted tools", () => {
  it("discovers, calls once, and forces owner-bound mandatory approval irrespective of hints", async () => {
    const f = await fixture(); f.setTools([tool({ annotations: { readOnlyHint: true, destructiveHint: false } })]);
    const s = source(f), mountedTool = await mounted(s);
    expect(mountedTool).toMatchObject({ kind: "mcp", readOnly: false, needsApproval: true, mandatoryApproval: true, concurrencySafe: false });
    expect(mountedTool.description).toContain("UNTRUSTED REMOTE MCP TOOL");
    expect(mountedTool.name).toMatch(/^mcp__alpha__echo_[0-9a-f]{32}$/); expect(mountedTool.name.length).toBeLessThanOrEqual(64);
    expect(scope(mountedTool)).toMatch(/^mcp_[0-9a-f]{64}$/);
    expect(Object.isFrozen(mountedTool)).toBe(true); expect(Object.isFrozen(mountedTool.parameters)).toBe(true);
    expect(await mountedTool.execute({ value: "hi" }, context())).toEqual({ content: [{ type: "text", text: "fixture result" }] });
    expect(methods(f, "server/discover")).toHaveLength(2); expect(methods(f, "tools/list")).toHaveLength(2);
    expect(methods(f, "tools/call")).toHaveLength(1); expect(methods(f, "initialize")).toHaveLength(0);
    expect(f.headers.every(header => header.authorization === undefined && header.cookie === undefined)).toBe(true);
  });
  it("separates sanitize collisions, long names, servers, and per-owner approval scopes", async () => {
    const f = await fixture(); f.setTools([tool({ name: "a.b" }), tool({ name: "a_b" }), tool({ name: "x".repeat(128) })]);
    const s = source(f, { servers: [{ id: "alpha", endpoint: f.endpoint, subjects: [owner, otherUser] },
      { id: "a".repeat(128), endpoint: f.endpoint, subjects: [owner] }] });
    const a = await s.resolve(owner, ["alpha", "a".repeat(128)], abort().signal);
    expect(a).toHaveLength(6); expect(new Set(a.map(t => t.name)).size).toBe(6);
    expect(a.every(t => t.name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(t.name))).toBe(true);
    const b = await s.resolve(otherUser, ["alpha"], abort().signal);
    expect(a[0]!.name).toBe(b[0]!.name); expect(scope(a[0]!)).not.toBe(scope(b[0]!));
  });
  it("revalidates exact schema and description before effectful dispatch", async () => {
    const f = await fixture(), s = source(f), t = await mounted(s);
    f.setTools([tool({ description: "changed" })]);
    expect(await t.execute({ value: "hi" }, context())).toMatchObject({ isError: true, content: [{ text: "MCP request failed." }] });
    expect(methods(f, "tools/call")).toHaveLength(0);
    const changed = await mounted(s); expect(scope(changed)).not.toBe(scope(t));
    f.setTools([tool({ description: "changed", inputSchema: { type: "object", properties: {}, additionalProperties: false } })]);
    expect((await changed.execute({ value: "hi" }, context())).isError).toBe(true); expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("does not let an approved closure execute under another user/tenant", async () => {
    const f = await fixture(), t = await mounted(source(f)); const before = f.requests.length;
    for (const p of [otherUser, otherTenant]) expect((await t.execute({ value: "hi" }, context(p))).isError).toBe(true);
    expect(f.requests).toHaveLength(before);
  });
  it("does not cache discovery between operations and does not follow resource results", async () => {
    const f = await fixture(rpc => rpc.method === "tools/call" ? { result: { content: [{ type: "resource_link", name: "secret", uri: "https://example.invalid/private" }] } } : undefined);
    const s = source(f), t = await mounted(s); await mounted(s);
    expect((await t.execute({ value: "hi" }, context())).isError).toBe(true);
    expect(methods(f, "server/discover")).toHaveLength(3); expect(methods(f, "resources/read")).toHaveLength(0);
  });
  it("serializes bounded structured output as text", async () => {
    const f = await fixture(rpc => rpc.method === "tools/call" ? { result: { content: [], structuredContent: { answer: 42 } } } : undefined);
    const t = await mounted(source(f)); expect(await t.execute({ value: "hi" }, context())).toEqual({ content: [{ type: "text", text: '{"answer":42}' }] });
  });
  it("uses the same strict raw-message boundary for modern POST SSE responses", async () => {
    const f = await fixture((rpc, _request, response) => {
      const result = rpc.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
        : rpc.method === "tools/list" ? { tools: [tool()], ttlMs: 0, cacheScope: "private" }
          : { content: [{ type: "text", text: "SSE fixture result" }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { resultType: "complete", ...result } })}\n\n`);
      return undefined;
    });
    const t = await mounted(source(f));
    expect(await t.execute({ value: "hi" }, context())).toEqual({ content: [{ type: "text", text: "SSE fixture result" }] });
    expect(methods(f, "tools/call")).toHaveLength(1); expect(methods(f, "initialize")).toHaveLength(0);
  });
  it("marks a dispatched response-loss outcome unknown and never retries it automatically", async () => {
    let executed = 0;
    const f = await fixture((rpc, request) => {
      if (rpc.method === "tools/call") { executed++; request.socket.destroy(); }
      return undefined;
    });
    const t = await mounted(source(f));
    expect(await t.execute({ value: "hi" }, context())).toEqual({ isError: true,
      content: [{ type: "text", text: "MCP tool outcome is unknown; do not retry without explicit user confirmation." }],
      details: { code: "mcp_outcome_unknown" } });
    expect(executed).toBe(1); expect(methods(f, "tools/call")).toHaveLength(1);
  });
});

describe("protocol/schema/resource limits", () => {
  it.each([
    { type: "object", properties: { path: { $ref: "https://example.invalid/schema" } } },
    { type: "object", properties: { value: { type: "string", pattern: "(a+)+$" } } },
    { type: "object", properties: { value: { type: "string", "x-mcp-header": "authorization" } } },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", anyOf: [{ type: "object" }] },
  ])("rejects unsupported schemas before exposing a tool", async inputSchema => {
    const f = await fixture(); f.setTools([tool({ inputSchema })]);
    await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toMatchObject({ message: "MCP request failed." });
    expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("rejects recursive/oversized schemas and oversized catalogs", async () => {
    const f = await fixture(); let nested: unknown = { type: "string" };
    for (let i = 0; i < 10; i++) nested = { type: "object", properties: { child: nested } };
    f.setTools([tool({ inputSchema: nested })]); await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    f.setTools(Array.from({ length: 65 }, (_, i) => tool({ name: `tool_${i}` })));
    await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
  });
  it("rejects invalid arguments before any further HTTP and caps result bytes", async () => {
    const f = await fixture(rpc => rpc.method === "tools/call" ? { result: { content: [{ type: "text", text: "x".repeat(65537) }] } } : undefined);
    const t = await mounted(source(f)); const before = f.requests.length;
    expect((await t.execute({ value: 7 }, context())).isError).toBe(true); expect(f.requests).toHaveLength(before);
    expect((await t.execute({ value: "ok" }, context())).isError).toBe(true); expect(methods(f, "tools/call")).toHaveLength(1);
  });
  it("accepts four finite pages and rejects repeated cursors or a fifth page", async () => {
    let cyclic = false, fifth = false;
    const f = await fixture(rpc => {
      if (rpc.method !== "tools/list") return undefined;
      const n = rpc.params?.cursor === undefined ? 0 : Number(rpc.params.cursor);
      return { result: { tools: [tool({ name: `page_${n}` })],
        ...(cyclic ? { nextCursor: "1" } : n < (fifth ? 4 : 3) ? { nextCursor: String(n + 1) } : {}) } };
    });
    expect(await source(f).resolve(owner, ["alpha"], abort().signal)).toHaveLength(4);
    cyclic = true; await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    cyclic = false; fifth = true; await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
  });
  it.each([{ tools: {}, tasks: {} }, { tools: {}, sampling: {} }, {}])("rejects unsupported capabilities", async capabilities => {
    const f = await fixture(); f.setCapabilities(capabilities);
    await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
  });
  it("rejects raw unknown tool fields instead of trusting SDK field stripping", async () => {
    const f = await fixture(); f.setTools([tool({ unrecognizedAuthority: true })]);
    await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("closes a malformed response promptly instead of waiting for its ten-second RPC budget", async () => {
    const f = await fixture(); f.setCapabilities({ tools: {}, unsupportedAuthority: {} });
    const s = source(f, { timeoutMs: 10_000 }); const started = performance.now();
    await expect(s.resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(methods(f, "server/discover")).toHaveLength(1); expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("rejects legacy negotiation without trying initialize", async () => {
    const f = await fixture(); f.setVersions(["2025-11-25"]);
    await expect(source(f).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect(methods(f, "initialize")).toHaveLength(0); expect(methods(f, "tools/call")).toHaveLength(0);
  });
  it("does not fulfil input_required, retry HEADER_MISMATCH, or expose remote errors", async () => {
    let kind = "input";
    const f = await fixture(rpc => rpc.method !== "tools/call" ? undefined : kind === "input"
      ? { result: { resultType: "input_required", inputRequests: { sample: { method: "sampling/createMessage", params: {} } }, requestState: "remote-state-canary" } }
      : { error: { code: -32020, message: "remote-error-body-canary https://example.invalid/private" } });
    const s = source(f), t = await mounted(s);
    for (const expectedCount of [1, 2]) {
      const result = await t.execute({ value: "hi" }, context());
      expect(result).toEqual({ content: [{ type: "text", text: "MCP tool outcome is unknown; do not retry without explicit user confirmation." }],
        isError: true, details: { code: "mcp_outcome_unknown" } });
      expect(methods(f, "tools/call")).toHaveLength(expectedCount); kind = "header";
    }
    expect(methods(f, "sampling/createMessage")).toHaveLength(0);
  });
});

describe("current authorization, cancellation, and owned lifecycle", () => {
  it("runs current authorization before actual sends and again after a call result", async () => {
    let revoked = false;
    const authorize = vi.fn(async () => { if (revoked) throw new Error("private-authority-canary"); });
    const f = await fixture(rpc => { if (rpc.method === "tools/call") { revoked = true; return { result: { content: [{ type: "text", text: "must not escape" }] } }; } return undefined; });
    const t = await mounted(source(f, { authorizeSubject: authorize }));
    expect((await t.execute({ value: "hi" }, context())).isError).toBe(true); expect(authorize.mock.calls.length).toBeGreaterThan(3);
    expect(methods(f, "tools/call")).toHaveLength(1);
  });
  it("enforces per-user concurrency and a finite short failure circuit", async () => {
    const called = deferred<void>();
    const f = await fixture(rpc => { if (rpc.method === "tools/call") called.resolve(); return undefined; });
    const s = source(f, { maxConcurrentPerUser: 1 }), t = await mounted(s), ac = abort();
    const pending = t.execute({ value: "hi" }, context(owner, ac.signal)); await called.promise;
    await expect(s.resolve(owner, ["alpha"], abort().signal)).rejects.toMatchObject({ code: "draining" });
    ac.abort(); expect((await pending).isError).toBe(true); expect(methods(f, "tools/call")).toHaveLength(1);
    f.setVersions(["2025-11-25"]);
    for (let i = 0; i < 2; i++) await expect(s.resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    const before = f.requests.length; await expect(s.resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect(f.requests).toHaveLength(before);
  });
  it("cancels a real pending socket on close and rejects later calls", async () => {
    const called = deferred<void>(), closed = deferred<void>();
    const f = await fixture((rpc, request) => {
      if (rpc.method === "tools/call") { request.socket.once("close", () => closed.resolve()); called.resolve(); }
      return undefined;
    });
    const s = source(f), t = await mounted(s), pending = t.execute({ value: "hi" }, context());
    await called.promise; await s.close(); await closed.promise;
    expect((await pending).isError).toBe(true); expect(s.enabled).toBe(false);
    await expect(s.resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect((await t.execute({ value: "hi" }, context())).isError).toBe(true);
  });
  it("holds the runtime lease until a cancelled authorization promise really settles", async () => {
    const entered = deferred<void>(), finish = deferred<void>(); const runtime = new TenantRuntimeCoordinator(); runtime.sealParticipants();
    const f = await fixture(); const ac = abort();
    const s = source(f, { tenantRuntime: runtime, authorizeSubject: async () => { entered.resolve(); await finish.promise; } });
    const pending = s.resolve(owner, ["alpha"], ac.signal); const observed = pending.catch(() => {});
    await entered.promise; ac.abort();
    let drained = false;
    const draining = runtime.drain({ tenantId: owner.tenantId, requestId: "fixture-request", subjectGeneration: 1,
      t3aReceiptSha256: "a".repeat(64) }, 1000).then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(f.requests).toHaveLength(0);
    finish.resolve(); await observed; await draining; expect(drained).toBe(true);
  });
  it("counts one whole operation deadline across discovery and catalog work", async () => {
    const f = await fixture(async rpc => {
      if (["server/discover", "tools/list"].includes(rpc.method)) await new Promise(resolve => setTimeout(resolve, 35));
      return undefined;
    });
    await expect(source(f, { timeoutMs: 50 }).resolve(owner, ["alpha"], abort().signal)).rejects.toThrow("MCP request failed.");
    expect(methods(f, "tools/call")).toHaveLength(0);
  });
});
