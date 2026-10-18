import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectionPool } from "../src/mcp/pool.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";
import type { McpPoolBinding, McpPoolOperation, McpRemoteProgress } from "../src/mcp/pool.js";
import { FakeProgressMcp, FakeStatefulMcp } from "@agent-service/testkit";

const servers: Server[] = [], pools: McpConnectionPool[] = [];
const peers: (FakeProgressMcp | FakeStatefulMcp)[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(peers.splice(0).map(peer => peer.stop()));
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function eventually(predicate: () => boolean): Promise<void> {
  const until = performance.now() + 3000;
  while (!predicate()) { if (performance.now() >= until) throw new Error("Fixture condition did not settle."); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function peerBinding(endpoint: string, protocolVersion: McpPoolBinding["protocolVersion"], userId = "alice", authorize: McpPoolBinding["authorize"] = async () => {}): McpPoolBinding {
  const principal = { tenantId: "official-pool-fixture", userId };
  return { key: JSON.stringify([endpoint, protocolVersion, userId]), principal, server: { id: "official", endpoint, subjects: [principal] },
    protocolVersion, authorize, accessToken: async () => undefined };
}
const echo = (pool: McpConnectionPool, binding: McpPoolBinding, operation: McpPoolOperation) => pool.use(binding, operation,
  async session => { const [tool] = await session.catalog(); return session.call(tool!, { text: "official" }); });

describe("official SDK stateful HTTP and typed progress", () => {
  it("retains one actual 2025 session/GET across completed operations and normally DELETEs it once", async () => {
    const peer = new FakeStatefulMcp(); peers.push(peer); const endpoint = await peer.start();
    const runtime = new TenantRuntimeCoordinator(), pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 4,
      allowLoopbackForTests: true, tenantRuntime: runtime }); pools.push(pool); runtime.sealParticipants();
    const binding = peerBinding(endpoint, "2025-11-25"), first = new AbortController(), onProgress = vi.fn();
    expect(await echo(pool, binding, { signal: first.signal, onProgress })).toEqual({ content: [{ type: "text", text: "echo:official" }] });
    await eventually(() => peer.requests.some(request => request.method === "GET"));
    first.abort(); // An already-completed operation no longer owns the entry's idle GET.
    expect(await echo(pool, binding, { signal: new AbortController().signal, onProgress })).toEqual({ content: [{ type: "text", text: "echo:official" }] });
    expect(peer.stats().sessionsCreated).toBe(1); expect(peer.calls).toHaveLength(2); expect(onProgress).toHaveBeenCalledTimes(2);
    const sid = peer.requests.find(request => request.rpcMethod === "notifications/initialized")!.sessionId;
    expect(sid).toEqual(expect.any(String));
    expect(peer.requests.filter(request => request.rpcMethod !== "initialize").every(request => request.sessionId === sid)).toBe(true);
    expect(runtime.snapshot(binding.principal.tenantId).providerOperations).toBe(1);
    await pool.close(); await eventually(() => peer.stats().openSockets === 0);
    expect(peer.requests.filter(request => request.method === "DELETE")).toEqual([{ method: "DELETE", rpcMethod: null, sessionId: sid }]);
    expect(peer.stats()).toMatchObject({ sessionsTerminated: 1, activeSessions: 0, calls: 2, openSockets: 0 });
    expect(runtime.snapshot(binding.principal.tenantId)).toMatchObject({ providerOperations: 0, providerRegistrations: 0 });
  });
  it("accepts an official peer's DELETE 405 without retrying or retaining native I/O", async () => {
    const peer = new FakeStatefulMcp(); peer.deleteStatus = 405; peers.push(peer); const endpoint = await peer.start();
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    await pool.use(peerBinding(endpoint, "2025-11-25"), { signal: new AbortController().signal }, session => session.catalog());
    await pool.close(); await eventually(() => peer.stats().openSockets === 0);
    expect(peer.requests.filter(request => request.method === "DELETE")).toHaveLength(1);
    expect(peer.stats()).toMatchObject({ sessionsTerminated: 0, activeSessions: 1, openSockets: 0 }); // Remote 405 is not a physical-termination receipt.
  });
  it("keeps an official 2025 session usable after its optional GET returns 405 without retrying GET", async () => {
    const peer = new FakeStatefulMcp(); peer.rejectNextRequest({ method: "GET", status: 405 }); peers.push(peer); const endpoint = await peer.start();
    const runtime = new TenantRuntimeCoordinator(), pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2,
      allowLoopbackForTests: true, tenantRuntime: runtime }); pools.push(pool); runtime.sealParticipants();
    const binding = peerBinding(endpoint, "2025-11-25"), onProgress = vi.fn();
    await pool.use(binding, { signal: new AbortController().signal }, session => session.catalog());
    // Wait for the real 405 exchange/socket to settle before the possible-effect POST.
    await eventually(() => peer.requests.some(request => request.method === "GET")
      && peer.stats().activeExchanges === 0 && peer.stats().openSockets === 0);
    const sid = peer.requests.find(request => request.rpcMethod === "notifications/initialized")!.sessionId;
    expect(sid).toEqual(expect.any(String));
    expect(await echo(pool, binding, { signal: new AbortController().signal, onProgress }))
      .toEqual({ content: [{ type: "text", text: "echo:official" }] });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(peer.progress[0]); expect(peer.calls).toHaveLength(1);
    expect(peer.requests.filter(request => request.method === "GET"))
      .toEqual([{ method: "GET", rpcMethod: null, sessionId: sid }]);
    expect(peer.requests.filter(request => request.rpcMethod === "initialize")).toHaveLength(1);
    expect(peer.requests.filter(request => request.rpcMethod === "tools/call"))
      .toEqual([{ method: "POST", rpcMethod: "tools/call", sessionId: sid }]);
    expect(runtime.snapshot(binding.principal.tenantId).providerOperations).toBe(1);
    await pool.close(); await eventually(() => peer.stats().openSockets === 0);
    expect(peer.requests.filter(request => request.method === "DELETE"))
      .toEqual([{ method: "DELETE", rpcMethod: null, sessionId: sid }]);
    expect(peer.requests.filter(request => request.rpcMethod !== "initialize").every(request => request.sessionId === sid)).toBe(true);
    expect(peer.stats()).toMatchObject({ sessionsCreated: 1, sessionsTerminated: 1, activeSessions: 0, activeExchanges: 0, calls: 1, progress: 1, openSockets: 0 });
    expect(runtime.snapshot(binding.principal.tenantId)).toMatchObject({ providerOperations: 0, providerRegistrations: 0 });
  });
  it("hard closes revoked stateful authority without sending DELETE or reinitializing", async () => {
    const peer = new FakeStatefulMcp(); peers.push(peer); const endpoint = await peer.start(); let revoked = false;
    const authorize = async () => { if (revoked) throw new Error("Fixture authority revoked."); };
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const binding = peerBinding(endpoint, "2025-11-25", "alice", authorize);
    await pool.use(binding, { signal: new AbortController().signal }, session => session.catalog());
    revoked = true; await pool.invalidate(() => true); await eventually(() => peer.stats().openSockets === 0);
    await expect(echo(pool, binding, { signal: new AbortController().signal })).rejects.toThrow();
    expect(peer.requests.filter(request => request.method === "DELETE")).toEqual([]);
    expect(peer.stats()).toMatchObject({ sessionsCreated: 1, sessionsTerminated: 0, calls: 0 });
  });
  it("does not retry an official stateful possible-effect call whose response is lost", async () => {
    const peer = new FakeStatefulMcp(); peer.dropNextCallResponse = true; peers.push(peer); const endpoint = await peer.start();
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    await expect(echo(pool, peerBinding(endpoint, "2025-11-25"), { signal: new AbortController().signal, onProgress: () => {} })).rejects.toThrow("MCP request failed.");
    expect(peer.calls).toHaveLength(1); expect(peer.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(1);
    expect(peer.requests.filter(request => request.method === "DELETE")).toEqual([]); expect(peer.stats().sessionsCreated).toBe(1);
  });
  it("fails a real expired-session 404 without an implicit initialize or tool replay", async () => {
    const peer = new FakeStatefulMcp(); peers.push(peer); const endpoint = await peer.start();
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const binding = peerBinding(endpoint, "2025-11-25");
    await pool.use(binding, { signal: new AbortController().signal }, session => session.catalog());
    peer.rejectNextRequest({ method: "POST", status: 404, rpcMethod: "tools/list" });
    await expect(pool.use(binding, { signal: new AbortController().signal }, session => session.catalog(true))).rejects.toThrow("MCP request failed.");
    expect(peer.requests.filter(request => request.rpcMethod === "initialize")).toHaveLength(1); expect(peer.calls).toEqual([]);
  });
  it.each([false, true])("keeps typed official modern progress observational and POST-only (observer throws=%s)", async throws => {
    const peer = new FakeProgressMcp(); peers.push(peer); const endpoint = await peer.start();
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const onProgress = vi.fn(() => { if (throws) throw new Error("Fixture observer failed."); });
    expect(await echo(pool, peerBinding(endpoint, "2026-07-28"), { signal: new AbortController().signal, onProgress }))
      .toEqual({ content: [{ type: "text", text: "echo:official" }] });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(peer.progress[0]); expect(peer.calls).toHaveLength(1);
    await pool.close(); expect(peer.requests.every(request => request.method === "POST")).toBe(true);
  });
  it("rejects decreasing actual official progress independently of the 25ms rate guard", async () => {
    const peer = new FakeProgressMcp(); peer.progress = []; peers.push(peer); const endpoint = await peer.start();
    peer.beforeReply = async () => {
      await peer.notifyLastCall({ progress: 2, total: 3 });
      await new Promise(resolve => setTimeout(resolve, 35));
      await peer.notifyLastCall({ progress: 1, total: 3 });
    };
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const onProgress = vi.fn();
    await expect(echo(pool, peerBinding(endpoint, "2026-07-28"), { signal: new AbortController().signal, onProgress })).rejects.toThrow("MCP request failed.");
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ progress: 2, total: 3 }); expect(peer.calls).toHaveLength(1);
  });
  it("rejects an official progress message over the UTF-8 byte limit without publishing it", async () => {
    const peer = new FakeProgressMcp(); peer.progress = [{ progress: 1, message: "界".repeat(171) }]; peers.push(peer); const endpoint = await peer.start();
    const pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const onProgress = vi.fn();
    await expect(echo(pool, peerBinding(endpoint, "2026-07-28"), { signal: new AbortController().signal, onProgress })).rejects.toThrow("MCP request failed.");
    expect(onProgress).not.toHaveBeenCalled(); expect(peer.calls).toHaveLength(1);
  });
  it("caps an actual official call at 64 progress frames even when every frame respects the interval", async () => {
    const peer = new FakeProgressMcp(); peer.progress = []; peers.push(peer); const endpoint = await peer.start();
    const observed = Array.from({ length: 64 }, () => deferred<void>());
    peer.beforeReply = async () => {
      for (let progress = 0; progress <= 64; progress++) {
        await peer.notifyLastCall({ progress, total: 65 });
        if (progress < 64) {
          // Waiting only at the producer cannot prove receiver spacing: native
          // buffering/GC can coalesce frames. Observe the actual accepted callback
          // first, then space the next send; no product clock or guard is mocked.
          await bounded(observed[progress]!.promise);
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
    };
    const pool = new McpConnectionPool({ timeoutMs: 3000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const onProgress = vi.fn((value: McpRemoteProgress) => { observed[value.progress]?.resolve(); });
    await expect(echo(pool, peerBinding(endpoint, "2026-07-28"), { signal: new AbortController().signal, onProgress })).rejects.toThrow("MCP request failed.");
    expect(onProgress).toHaveBeenCalledTimes(64); expect(onProgress.mock.calls[63]).toEqual([{ progress: 63, total: 65 }]);
    expect(peer.calls).toHaveLength(1); expect(peer.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(1);
  });
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture barrier did not settle.")), 3000); })]); }
  finally { clearTimeout(timer); }
}
/** Real wire fixture tests the raw notification guard; no Client or transport stub. */
async function fixture(wrongToken: boolean) {
  let calls = 0, tokenSeen: unknown;
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32_768) { request.destroy(); return; } chunks.push(bytes); }
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (rpc.method === "tools/call") {
      calls++; tokenSeen = rpc.params?._meta?.progressToken;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {
        progressToken: wrongToken ? "unrelated-fixture-token" : tokenSeen, progress: 1, total: 2, message: "fixture progress",
      } })}\n\n`);
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { resultType: "complete", content: [{ type: "text", text: "fixture result" }] } })}\n\n`); return;
    }
    const result = rpc.method === "server/discover" ? { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }
      : { tools: [{ name: "echo", description: "Fixture echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }], ttlMs: 0, cacheScope: "private" };
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { resultType: "complete", ...result } }));
  })().catch(() => { response.destroy(); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls: () => calls, token: () => tokenSeen };
}
/** Deliberately invalid peer: proves a pinned legacy request cannot negotiate another era/version. */
async function mismatchedLegacyFixture(protocolVersion: string) {
  const methods: string[] = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32_768) { request.destroy(); return; } chunks.push(bytes); }
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); methods.push(rpc.method);
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "invalid-version-fixture", version: "1" } } }));
  })().catch(() => { response.destroy(); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, methods };
}
describe("MCP pool progress request identity", () => {
  it.each(["abort", "close", "fence"] as const)("does not admit another entry when %s occurs during expired-entry real cleanup", async mode => {
    const runtime = new TenantRuntimeCoordinator(), pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 10, maxEntries: 2, allowLoopbackForTests: true, tenantRuntime: runtime });
    pools.push(pool); runtime.sealParticipants();
    const principal = { tenantId: "expired-pool-fixture", userId: "alice" }, initialized = deferred<void>(), closingEntered = deferred<void>(), release = deferred<void>(), checkout = deferred<void>();
    const secondAbort = new AbortController(), work = vi.fn(async () => undefined), unhandled = vi.fn(), accessToken = vi.fn(async () => undefined);
    let originalAuthorizations = 0, nextAuthorizations = 0, externalClose: Promise<unknown> | undefined;
    process.on("unhandledRejection", unhandled);
    const first = pool.use({ key: "expired-first", principal, server: { id: "first", endpoint: "http://127.0.0.1:1/mcp", subjects: [principal] },
      protocolVersion: "2026-07-28", accessToken,
      authorize: async signal => {
        if (++originalAuthorizations === 2) {
          // This is real entry.ready tracked I/O: cancellation fences it, but
          // cannot pretend its non-cancellable completion has already settled.
          signal.addEventListener("abort", () => closingEntered.resolve(), { once: true });
          initialized.resolve(); await release.promise;
        }
        if (signal.aborted) throw new Error("Fixture authorization was cancelled.");
      },
    }, { signal: new AbortController().signal }, work);
    const firstRejected = expect(first).rejects.toThrow("MCP request failed.");
    let secondRejected: Promise<void> | undefined;
    try {
      await bounded(initialized.promise); await bounded(closingEntered.promise); // Actual TTL closes the published entry.
      // The timer was installed just before the entry's monotonic expires value;
      // move past both without reaching into or rewriting private pool state.
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      expect(runtime.snapshot(principal.tenantId)).toMatchObject({ providerRegistrations: 1, providerOperations: 1 });
      const second = pool.use({ key: "expired-second", principal, server: { id: "second", endpoint: "http://127.0.0.1:1/mcp", subjects: [principal] },
        protocolVersion: "2026-07-28", accessToken,
        authorize: async () => { nextAuthorizations++; checkout.resolve(); },
      }, { signal: secondAbort.signal }, work);
      secondRejected = expect(second).rejects.toThrow("MCP request failed.");
      await bounded(checkout.promise); await new Promise<void>(resolve => setImmediate(resolve));
      if (mode === "abort") secondAbort.abort();
      else if (mode === "close") externalClose = pool.close();
      else externalClose = runtime.drain({ tenantId: principal.tenantId, requestId: "pool-fixture-drain", subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 3000);
      expect(runtime.snapshot(principal.tenantId).providerOperations).toBe(1); // No false drain before actual I/O returns.
      release.resolve();
      await bounded(Promise.all([firstRejected, secondRejected, ...(externalClose ? [externalClose] : [])]));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(nextAuthorizations).toBe(1); expect(originalAuthorizations).toBe(2); expect(work).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled(); expect(accessToken).not.toHaveBeenCalled();
      expect(runtime.snapshot(principal.tenantId)).toMatchObject({ providerRegistrations: 0, providerOperations: 0 });
    } finally {
      release.resolve(); secondAbort.abort();
      await Promise.allSettled([firstRejected, ...(secondRejected ? [secondRejected] : []), ...(externalClose ? [externalClose] : []), pool.close()]);
      process.removeListener("unhandledRejection", unhandled);
    }
  });
  it.each([false, true])("associates progress only with its actual SDK tools/call token (wrong=%s)", async wrong => {
    const f = await fixture(wrong), pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const principal = { tenantId: "pool-fixture", userId: "alice" }, onProgress = vi.fn(), onDispatched = vi.fn();
    const request = pool.use({ key: "fixture-key", principal, server: { id: "fixture", endpoint: f.endpoint, subjects: [principal] },
      protocolVersion: "2026-07-28", authorize: async () => {}, accessToken: async () => undefined },
    { signal: new AbortController().signal, onProgress, onDispatched }, async session => {
      const [tool] = await session.catalog(); return session.call(tool!, { text: "fixture" });
    });
    if (wrong) { await expect(request).rejects.toThrow("MCP request failed."); expect(onProgress).not.toHaveBeenCalled(); }
    else { await expect(request).resolves.toEqual({ content: [{ type: "text", text: "fixture result" }] });
      expect(onProgress).toHaveBeenCalledExactlyOnceWith({ progress: 1, total: 2, message: "fixture progress" }); }
    expect(f.token()).toEqual(expect.any(Number)); expect(f.calls()).toBe(1); expect(onDispatched).toHaveBeenCalledTimes(1);
  });
  it.each(["2024-11-05", "2026-07-28"])("rejects a 2025 initialize reply selecting %s without probing or dispatching a tool", async version => {
    const f = await mismatchedLegacyFixture(version), pool = new McpConnectionPool({ timeoutMs: 1000, ttlMs: 5000, maxEntries: 2, allowLoopbackForTests: true }); pools.push(pool);
    const principal = { tenantId: "legacy-pool-fixture", userId: "alice" }, onDispatched = vi.fn();
    await expect(pool.use({ key: "legacy-fixture-key", principal, server: { id: "fixture", endpoint: f.endpoint, subjects: [principal] },
      protocolVersion: "2025-11-25", authorize: async () => {}, accessToken: async () => undefined },
    { signal: new AbortController().signal, onDispatched }, session => session.catalog())).rejects.toThrow("MCP request failed.");
    expect(f.methods).toEqual(["initialize"]); expect(onDispatched).not.toHaveBeenCalled();
  });
});
