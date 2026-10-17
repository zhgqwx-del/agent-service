import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpConnectionPool } from "../src/mcp/pool.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";

const servers: Server[] = [], pools: McpConnectionPool[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
