import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMcp, FakeProgressMcp, FakeStatefulMcp } from "@agent-service/testkit";
import { MemorySessionStore, createMcpRegistryAccess, mcpCoordinationSubjectSha256,
  type McpCoordination, type McpCoordinationLease, type McpRegistrationOwner } from "@agent-service/store";
import type { Principal } from "@agent-service/protocol";
import { McpCredentialCipher } from "../src/mcp/cipher.js";
import { RegisteredMcpService, type McpRegistrationRequest, type RegisteredMcpServiceOptions } from "../src/mcp/registered.js";
import { TenantRuntimeCoordinator } from "../src/lifecycle/tenant-runtime-coordinator.js";

const alice: Principal = { tenantId: "registered-mcp", userId: "alice" }, bob: Principal = { ...alice, userId: "bob" };
const tenant: McpRegistrationOwner = { scope: "tenant", tenantId: alice.tenantId, userId: null };
const ref = { scope: "tenant" as const, name: "echo" }, signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Invalidation = { registrationId: string | null; subjectSha256: string | null };
/** Actual in-memory quota ledger for Memory-only tests; not evidence of Redis. */
class MemoryCoordination implements McpCoordination {
  readonly namespaceSha256 = "c".repeat(64);
  readonly active = new Map<string, { subject: string; abort: AbortController }>();
  readonly outcomes: string[] = [];
  readonly listeners = new Set<(value: Invalidation) => void>();
  async enter(input: Parameters<McpCoordination["enter"]>[0], caller: AbortSignal): Promise<McpCoordinationLease> {
    const subject = JSON.stringify(input.subject), abort = new AbortController();
    if (caller.aborted || [...this.active.values()].filter(v => v.subject === subject).length >= input.maxConcurrent) throw new Error("Fixture quota denied.");
    this.active.set(input.operationId, { subject, abort });
    return { signal: abort.signal, assertOpen: async () => { if (abort.signal.aborted || !this.active.has(input.operationId)) throw new Error("Fixture quota closed."); },
      release: async outcome => { this.outcomes.push(outcome); this.active.delete(input.operationId); } };
  }
  async publishInvalidation(input: Parameters<McpCoordination["publishInvalidation"]>[0]) {
    for (const listener of this.listeners) listener({ registrationId: input.registrationId,
      subjectSha256: input.subject === null ? null : mcpCoordinationSubjectSha256(this.namespaceSha256, input.subject) });
  }
  onInvalidation(listener: (value: Invalidation) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() { for (const value of this.active.values()) value.abort.abort(); }
}
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function access(owner = tenant) { return createMcpRegistryAccess({ principal: alice, owner, authority: "tenant_admin", access: "manage" }); }
function setup(store = new MemorySessionStore(), coordination = new MemoryCoordination(), runtime?: TenantRuntimeCoordinator,
  observers: Pick<RegisteredMcpServiceOptions, "onProgress"> = {}) {
  const source = new RegisteredMcpService({ store, coordination, cipher: new McpCredentialCipher({ keyId: "fixture-v1", key: new Uint8Array(32).fill(7) }),
    callbackUrl: "http://127.0.0.1:1/v1/mcp/oauth/callback", allowLoopbackForTests: true, tenantRuntime: runtime,
    authorizeFleet: async () => {}, timeoutMs: 3000, ...observers }); cleanup.push(() => source.close()); return { source, store, coordination };
}
async function peer(options: { issuerAtOrigin?: boolean } = {}) {
  const mcp = new FakeMcp(), upstream = await mcp.start(); cleanup.push(() => mcp.stop());
  let origin = "", denyAfterEffect = false, refreshFailure = false, tokenGate: (() => Promise<void>) | undefined;
  let tokenCalls = 0, refreshCalls = 0, metadataCalls = 0, grantedScope = "echo";
  const metadataHeaders: (string | undefined)[] = [], resourceHeaders: (string | undefined)[] = [];
  const codes = new Map<string, { challenge: string; redirect: string }>(), issued = new Set<string>();
  const server: Server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, origin), issuer = origin + (options.issuerAtOrigin ? "" : "/oauth"), endpoint = origin + "/mcp";
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/oauth/.well-known/openid-configuration") {
      metadataCalls++; metadataHeaders.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(url.pathname.includes("oauth-protected-resource") ? { resource: endpoint, authorization_servers: [issuer] }
        : { issuer, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], authorization_response_iss_parameter_supported: true })); return;
    }
    if (url.pathname === "/authorize") {
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      const code = randomUUID(); codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")! });
      const callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", code); callback.searchParams.set("iss", issuer);
      response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (url.pathname === "/token") {
      const chunks: Buffer[] = []; let length = 0; for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 65_536) { request.destroy(); return; } chunks.push(bytes); }
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from("fixture-client:fixture-client-material").toString("base64")}`);
      expect(params.get("resource")).toBe(endpoint); expect(params.get("client_id")).toBe("fixture-client");
      tokenCalls++; if (params.get("grant_type") === "refresh_token") refreshCalls++;
      else { const entry = codes.get(params.get("code")!); expect(entry).toBeDefined(); expect(params.get("redirect_uri")).toBe(entry!.redirect);
        expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(entry!.challenge); codes.delete(params.get("code")!); }
      await tokenGate?.();
      if (refreshFailure) { response.destroy(); return; }
      const token = `fixture-resource-${tokenCalls}`; issued.add(token);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ token_type: "Bearer", access_token: token, refresh_token: `fixture-refresh-${tokenCalls}`, expires_in: 60, scope: grantedScope })); return;
    }
    if (url.pathname === "/mcp") {
      resourceHeaders.push(request.headers.authorization);
      if (!issued.has((request.headers.authorization ?? "").replace(/^Bearer /, "")) && issued.size) { response.writeHead(401); response.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
      const rpc = JSON.parse(body.toString("utf8"));
      await new Promise<void>((resolve, reject) => {
        const outbound = httpRequest(upstream, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
          "content-length": body.length, "mcp-protocol-version": "2026-07-28",
          ...(typeof request.headers["mcp-method"] === "string" ? { "mcp-method": request.headers["mcp-method"] } : {}),
          ...(typeof request.headers["mcp-name"] === "string" ? { "mcp-name": request.headers["mcp-name"] } : {}) } }, incoming => {
          if (denyAfterEffect && rpc.method === "tools/call") { incoming.resume(); incoming.once("end", () => { response.writeHead(401, { "www-authenticate": "Bearer error=invalid_token" }); response.end(); resolve(); }); return; }
          response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response); incoming.once("end", resolve);
        }); outbound.once("error", reject); outbound.end(body);
      }); return;
    }
    response.writeHead(404); response.end();
  })().catch(() => { response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { mcp, endpoint: origin + "/mcp", issuer: origin + (options.issuerAtOrigin ? "" : "/oauth"), metadataHeaders, resourceHeaders,
    counts: () => ({ tokenCalls, refreshCalls, metadataCalls }), setDeniedAfterEffect: () => { denyAfterEffect = true; },
    setTokenGate: (gate?: () => Promise<void>) => { tokenGate = gate; }, setRefreshFailure: () => { refreshFailure = true; },
    setGrantedScope: (value: string) => { grantedScope = value; } };
}
function config(p: Awaited<ReturnType<typeof peer>>, oauth = true): McpRegistrationRequest {
  return { endpoint: p.endpoint, description: "Fixture echo", protocolVersion: "2026-07-28", authentication: oauth ? { kind: "oauth", issuer: p.issuer,
    clientId: "fixture-client", clientAuthentication: "client_secret_basic", clientSecret: "fixture-client-material", scopes: ["echo"] } : { kind: "none" } };
}
async function install(source: RegisteredMcpService, remote: Awaited<ReturnType<typeof peer>>, oauth = true) {
  return source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-install", config: config(remote, oauth) }, signal());
}
async function authorize(source: RegisteredMcpService, p = alice, idempotencyKey = "fixture-begin") {
  const begin = await source.beginAuthorization(p, ref, { idempotencyKey }, signal());
  const browser = await fetch(begin.authorizationUrl, { redirect: "manual" }); expect(browser.status).toBe(302);
  const callback = new URL(browser.headers.get("location")!);
  return { begin, callback: { state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, iss: callback.searchParams.get("iss")! } };
}
const toolContext = (p = alice) => ({ principal: p, sessionId: "session-fixture", turnId: "turn-fixture", toolCallId: "call-fixture", signal: signal() });

describe("registered MCP actual Memory, official peer and OAuth HTTP", () => {
  it("rejects an old exact upsert receipt after a later revision instead of returning the current version", async () => {
    const p = await peer(), { source } = setup(), original = config(p, false);
    const first = await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "receipt-first", config: original }, signal());
    const second = await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 1, idempotencyKey: "receipt-second", config: { ...original, description: "Second immutable configuration" } }, signal());
    expect(first.slot.revision).toBe(1); expect(second.slot.revision).toBe(2);
    expect(first.version.configVersionId).not.toBe(second.version.configVersionId);
    await expect(source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "receipt-first", config: original }, signal())).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await source.getInstalled(tenant, "echo", { access: access() }, signal())).toEqual(second);
  });
  it("returns its atomic immutable version when another writer commits before the first upsert response", async () => {
    const committed = deferred<void>(), released = deferred<void>();
    class CommitBarrierStore extends MemorySessionStore {
      override async upsertMcpRegistration(input: Parameters<MemorySessionStore["upsertMcpRegistration"]>[0]) {
        const result = await super.upsertMcpRegistration(input);
        if (input.idempotencyKey === "interleave-first") { committed.resolve(); await released.promise; }
        return result;
      }
    }
    const p = await peer(), store = new CommitBarrierStore(), { source: a } = setup(store), { source: b } = setup(store), original = config(p, false);
    const pending = a.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "interleave-first", config: original }, signal());
    let later: Awaited<ReturnType<RegisteredMcpService["upsert"]>> | undefined;
    try {
      await Promise.race([committed.promise, pending.then(() => { throw new Error("Fixture commit barrier was not held."); }, () => { throw new Error("Fixture first commit failed."); })]);
      later = await b.upsert(tenant, { access: access(), name: "echo", expectedRevision: 1, idempotencyKey: "interleave-second", config: { ...original, description: "Concurrent immutable configuration" } }, signal());
    } finally { released.resolve(); }
    const first = await pending;
    if (!later) throw new Error("Fixture second commit failed.");
    expect(first.slot.revision).toBe(1); expect(first.version.revision).toBe(1);
    expect(first.slot.currentVersionId).toBe(first.version.configVersionId);
    expect(first.version.config).toEqual(original);
    expect(later.slot.revision).toBe(2); expect(first.version.configVersionId).not.toBe(later.version.configVersionId);
    expect(await a.getInstalled(tenant, "echo", { access: access() }, signal())).toEqual(later);
  });
  it("keeps anonymous registrations strongly approved, reuses actual clients and revokes old config", async () => {
    const p = await peer(), { source } = setup(); await install(source, p, false);
    const [first] = await source.discover(alice, ref, signal()), [same] = await source.discover(alice, ref, signal());
    expect(first).toMatchObject({ kind: "mcp", mandatoryApproval: true, readOnly: false, needsApproval: true });
    expect(first!.approvalScope).toBe(same!.approvalScope);
    expect(p.mcp.methodCounts.get("server/discover")).toBe(1);
    expect(await first!.execute({ text: "hello" }, toolContext())).toEqual({ content: [{ type: "text", text: "echo:hello" }] });
    expect(p.mcp.calls).toHaveLength(1);
    await source.setState(tenant, "echo", { access: access(), state: "disabled", expectedRevision: 1, idempotencyKey: "fixture-disable" }, signal());
    expect(await first!.execute({ text: "late" }, toolContext())).toMatchObject({ isError: true, details: { code: "mcp_request_failed" } });
    expect(p.mcp.calls).toHaveLength(1);
    await source.setState(tenant, "echo", { access: access(), state: "enabled", expectedRevision: 2, idempotencyKey: "fixture-enable" }, signal());
    const [enabled] = await source.discover(alice, ref, signal());
    expect(enabled!.approvalScope).not.toBe(first!.approvalScope);
    expect(await first!.execute({ text: "stale" }, toolContext())).toMatchObject({ isError: true, details: { code: "mcp_request_failed" } });
    expect(p.mcp.calls).toHaveLength(1);
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 3, idempotencyKey: "fixture-same-config", config: config(p, false) }, signal());
    const [republished] = await source.discover(alice, ref, signal());
    expect(republished!.approvalScope).not.toBe(enabled!.approvalScope);
    expect(await enabled!.execute({ text: "stale" }, toolContext())).toMatchObject({ isError: true, details: { code: "mcp_request_failed" } });
    expect(p.mcp.calls).toHaveLength(1);
  });
  it("pins the official 2025 stateless handshake without modern discovery or implicit fallback", async () => {
    const legacy = new FakeMcp({ legacyOnly: true }), endpoint = await legacy.start(); cleanup.push(() => legacy.stop());
    const { source } = setup();
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-legacy",
      config: { endpoint, description: "Legacy fixture", protocolVersion: "2025-11-25", authentication: { kind: "none" } } }, signal());
    const [tool] = await source.discover(alice, ref, signal());
    expect(tool).toMatchObject({ mandatoryApproval: true, kind: "mcp" });
    expect(await tool!.execute({ text: "legacy" }, toolContext())).toEqual({ content: [{ type: "text", text: "echo:legacy" }] });
    expect(legacy.methodCounts.get("initialize")).toBe(1); expect(legacy.methodCounts.get("server/discover") ?? 0).toBe(0);
    expect(legacy.methodCounts.get("notifications/initialized")).toBe(1); expect(legacy.calls).toHaveLength(1);
  });
  it("prefers the per-execution typed reporter over the compatibility observer without publishing text progress", async () => {
    const remote = new FakeProgressMcp(), endpoint = await remote.start(); cleanup.push(() => remote.stop());
    const observer = vi.fn(), typed = vi.fn(), text = vi.fn();
    const { source } = setup(undefined, undefined, undefined, { onProgress: observer });
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-progress",
      config: { endpoint, description: "Official typed progress", protocolVersion: "2026-07-28", authentication: { kind: "none" } } }, signal());
    const [tool] = await source.discover(alice, ref, signal());
    expect(await tool!.execute({ text: "registered-progress" }, { ...toolContext(), onMcpProgress: typed, onProgress: text }))
      .toEqual({ content: [{ type: "text", text: "echo:registered-progress" }] });
    expect(typed).toHaveBeenCalledExactlyOnceWith(remote.progress[0]); expect(observer).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
    expect(remote.calls).toHaveLength(1);
  });
  it("normally closes actual Memory-registered official stateful sessions using fresh per-owner authorization", async () => {
    const remote = new FakeStatefulMcp(), endpoint = await remote.start(); cleanup.push(() => remote.stop());
    const runtime = new TenantRuntimeCoordinator(), { source } = setup(undefined, undefined, runtime); runtime.sealParticipants();
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-stateful-close",
      config: { endpoint, description: "Official stateful peer", protocolVersion: "2025-11-25", authentication: { kind: "none" } } }, signal());
    const [tool] = await source.discover(alice, ref, signal()); await source.discover(bob, ref, signal());
    const typed = vi.fn(); expect(await tool!.execute({ text: "stateful" }, { ...toolContext(), onMcpProgress: typed }))
      .toEqual({ content: [{ type: "text", text: "echo:stateful" }] });
    expect(typed).toHaveBeenCalledExactlyOnceWith(remote.progress[0]); expect(remote.stats().sessionsCreated).toBe(2);
    await source.close();
    expect(remote.requests.filter(request => request.method === "DELETE")).toHaveLength(2);
    expect(new Set(remote.requests.filter(request => request.method === "DELETE").map(request => request.sessionId)).size).toBe(2);
    expect(remote.stats()).toMatchObject({ activeSessions: 0, sessionsTerminated: 2, calls: 1 });
    expect(runtime.snapshot(alice.tenantId)).toMatchObject({ providerOperations: 0, providerRegistrations: 0 });
    await expect(source.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
  });
  it.each(["disabled", "fenced"] as const)("never uses revoked %s stateful authority for shutdown DELETE", async mode => {
    const remote = new FakeStatefulMcp(), endpoint = await remote.start(); cleanup.push(() => remote.stop());
    const runtime = new TenantRuntimeCoordinator(), { source } = setup(undefined, undefined, runtime); runtime.sealParticipants();
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-stateful-revoke",
      config: { endpoint, description: "Official stateful peer", protocolVersion: "2025-11-25", authentication: { kind: "none" } } }, signal());
    await source.discover(alice, ref, signal());
    if (mode === "disabled") await source.setState(tenant, "echo", { access: access(), state: "disabled", expectedRevision: 1, idempotencyKey: "fixture-stateful-disabled" }, signal());
    else await runtime.drain({ tenantId: alice.tenantId, requestId: "fixture-stateful-fence", subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 3000);
    await source.close();
    expect(remote.requests.filter(request => request.method === "DELETE")).toEqual([]);
    expect(remote.stats()).toMatchObject({ sessionsCreated: 1, sessionsTerminated: 0, calls: 0 });
    expect(runtime.snapshot(alice.tenantId)).toMatchObject({ providerOperations: 0, providerRegistrations: 0 });
  });
  it("rechecks actual shared durable registration on a later active notification without relying on an invalidation hint", async () => {
    const remote = new FakeStatefulMcp(), endpoint = await remote.start(); cleanup.push(() => remote.stop());
    const store = new MemorySessionStore(), runtime = new TenantRuntimeCoordinator();
    // Both are real product services over the same durable Memory state. Separate
    // Memory-only coordination objects deliberately do not deliver B's hint to A:
    // the receive gate must read current authority, not depend on a cache message.
    const { source: a } = setup(store, new MemoryCoordination(), runtime), { source: b } = setup(store);
    runtime.sealParticipants();
    const firstProgress = deferred<void>(), heldResult = deferred<void>(), release = deferred<void>();
    remote.beforeReply = async () => { heldResult.resolve(); await release.promise; };
    await a.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "fixture-active-receive-revoke",
      config: { endpoint, description: "Official stateful held result", protocolVersion: "2025-11-25", authentication: { kind: "none" } } }, signal());
    const [tool] = await a.discover(alice, ref, signal());
    const observed = vi.fn(() => firstProgress.resolve());
    const executing = tool!.execute({ text: "once-before-revocation" }, { ...toolContext(), onMcpProgress: observed });
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([firstProgress.promise, heldResult.promise]), new Promise<never>((_resolve, reject) => {
        barrierTimer = setTimeout(() => reject(new Error("Fixture active notification barrier did not settle.")), 3000);
      })]);
      clearTimeout(barrierTimer);
      expect(observed).toHaveBeenCalledExactlyOnceWith(remote.progress[0]); expect(remote.calls).toHaveLength(1);
      expect(runtime.snapshot(alice.tenantId).providerOperations).toBeGreaterThan(0);
      await b.setState(tenant, "echo", { access: access(), state: "disabled", expectedRevision: 1, idempotencyKey: "fixture-active-disable" }, signal());
      expect((await b.getInstalled(tenant, "echo", { access: access() }, signal()))?.slot.state).toBe("disabled");
      await new Promise(resolve => setTimeout(resolve, 35)); // Satisfy the receive rate guard independently of revocation.
      await remote.notifyLastCall({ progress: 2, total: 2, message: "Must not become public after revocation." });
      expect(remote.progressSent).toHaveLength(2); // The official server really emitted both frames.
      release.resolve();
      expect(await executing).toMatchObject({ isError: true, details: { code: "mcp_outcome_unknown" } });
      await a.close(); await b.close();
      expect(observed).toHaveBeenCalledExactlyOnceWith(remote.progress[0]);
      expect(remote.calls).toHaveLength(1); expect(remote.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(1);
      expect(remote.requests.filter(request => request.method === "DELETE")).toEqual([]);
      expect(runtime.snapshot(alice.tenantId)).toMatchObject({ providerOperations: 0, providerRegistrations: 0 });
    } finally { clearTimeout(barrierTimer); release.resolve(); await executing; await a.close(); await b.close(); }
  });
  it("performs S256/basic authorization without putting user credentials on metadata or sharing tenant tokens", async () => {
    const p = await peer(), { source } = setup(), installed = await install(source, p);
    expect(JSON.stringify(installed)).not.toContain("fixture-client-material");
    const auth = await authorize(source), replay = await source.beginAuthorization(alice, ref, { idempotencyKey: "fixture-begin" }, signal());
    expect(replay).toEqual(auth.begin);
    expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "connected" });
    const [tool] = await source.discover(alice, ref, signal());
    expect(await tool!.execute({ text: "oauth" }, toolContext())).toEqual({ content: [{ type: "text", text: "echo:oauth" }] });
    await expect(source.discover(bob, ref, signal())).rejects.toMatchObject({ code: "draining" });
    expect(await source.getAuthorization(bob, ref, signal())).toBeNull();
    expect(p.metadataHeaders.length).toBeGreaterThanOrEqual(2); expect(p.metadataHeaders.every(header => header === undefined)).toBe(true);
    expect(p.resourceHeaders.every(header => header?.startsWith("Bearer fixture-resource-") === true)).toBe(true);
    expect(p.counts().tokenCalls).toBe(1);
    expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "reauthorization_required" });
    expect(p.counts().tokenCalls).toBe(1);
  });
  it("never refreshes or automatically retries a possible-effect tool after upstream 401", async () => {
    const p = await peer(), { source } = setup(); await install(source, p); const auth = await authorize(source);
    expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "connected" });
    const [tool] = await source.discover(alice, ref, signal()); p.setDeniedAfterEffect();
    expect(await tool!.execute({ text: "once" }, toolContext())).toMatchObject({ isError: true, details: { code: "mcp_outcome_unknown" } });
    expect(p.mcp.calls).toHaveLength(1); expect(p.counts()).toMatchObject({ tokenCalls: 1, refreshCalls: 0 });
  });
  it("preserves an origin issuer without a trailing slash and binds new authorization to the current registration revision", async () => {
    const p = await peer({ issuerAtOrigin: true }), { source } = setup(); await install(source, p);
    const old = await authorize(source); expect(new URL(old.begin.authorizationUrl).searchParams.get("resource")).toBe(p.endpoint);
    expect(await source.completeAuthorization(old.callback, signal())).toEqual({ status: "connected" });
    await source.setState(tenant, "echo", { access: access(), state: "disabled", expectedRevision: 1, idempotencyKey: "oauth-disable" }, signal());
    await source.setState(tenant, "echo", { access: access(), state: "enabled", expectedRevision: 2, idempotencyKey: "oauth-enable" }, signal());
    await expect(source.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
    expect(await source.completeAuthorization(old.callback, signal())).toEqual({ status: "reauthorization_required" });
    const fresh = await authorize(source, alice, "oauth-after-enable");
    expect(fresh.begin.authorizationId).not.toBe(old.begin.authorizationId);
    expect(await source.completeAuthorization(fresh.callback, signal())).toEqual({ status: "connected" });
    expect(await source.getAuthorization(alice, ref, signal())).toMatchObject({ state: "connected", registrationRevision: 3 });
    const [tool] = await source.discover(alice, ref, signal());
    expect(await tool!.execute({ text: "new-revision" }, toolContext())).toEqual({ content: [{ type: "text", text: "echo:new-revision" }] });
    expect(p.counts()).toMatchObject({ tokenCalls: 2, refreshCalls: 0 });
  });
  it.each([
    ["exchange", "echo"], ["exchange", "echo profile admin"],
    ["refresh", "echo"], ["refresh", "echo profile admin"],
  ] as const)("does not publish a narrowed or expanded scope set after %s (%s)", async (phase, granted) => {
    const p = await peer(), { source } = setup(), base = config(p);
    if (base.authentication.kind !== "oauth") throw new Error("Fixture configuration failed.");
    const requested: McpRegistrationRequest = { ...base, authentication: { ...base.authentication, scopes: ["echo", "profile"] } };
    await source.upsert(tenant, { access: access(), name: "echo", expectedRevision: 0, idempotencyKey: "scope-install", config: requested }, signal());
    p.setGrantedScope(phase === "refresh" ? "profile echo" : granted);
    const auth = await authorize(source);
    if (phase === "refresh") {
      expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "connected" });
      p.setGrantedScope(granted); vi.spyOn(Date, "now").mockReturnValue(Date.now() + 57_000);
      await expect(source.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
    } else expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "reauthorization_required" });
    expect(await source.getAuthorization(alice, ref, signal())).toMatchObject({ state: "outcome_unknown", credentialVersionId: null });
    await expect(source.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
    expect(await source.completeAuthorization(auth.callback, signal())).toEqual({ status: "reauthorization_required" });
    expect(p.counts()).toMatchObject({ tokenCalls: phase === "refresh" ? 2 : 1, refreshCalls: phase === "refresh" ? 1 : 0 });
    expect(p.mcp.calls).toHaveLength(0);
  });
  it("uses the real shared-store refresh CAS once across two service instances and keeps approval identity stable", async () => {
    const p = await peer(), store = new MemorySessionStore(), coordination = new MemoryCoordination();
    const { source: a } = setup(store, coordination), { source: b } = setup(store, coordination);
    await install(a, p); const auth = await authorize(a); expect(await a.completeAuthorization(auth.callback, signal())).toEqual({ status: "connected" });
    const [original] = await a.discover(alice, ref, signal());
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 57_000);
    const gate = deferred<void>(), entered = deferred<void>(); p.setTokenGate(async () => { entered.resolve(); await gate.promise; });
    const refreshing = a.discover(alice, ref, signal());
    try {
      await entered.promise;
      await expect(b.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
      expect(p.counts()).toMatchObject({ tokenCalls: 2, refreshCalls: 1 });
    } finally { gate.resolve(); }
    const [renewed] = await refreshing, [other] = await b.discover(alice, ref, signal());
    expect(renewed!.approvalScope).toBe(original!.approvalScope); expect(other!.approvalScope).toBe(original!.approvalScope);
    expect(await b.getAuthorization(alice, ref, signal())).toMatchObject({ authorizationEpoch: 1, tokenRevision: 2, state: "connected" });
    expect(p.counts()).toMatchObject({ tokenCalls: 2, refreshCalls: 1 });
    expect(await original!.execute({ text: "refreshed" }, toolContext())).toEqual({ content: [{ type: "text", text: "echo:refreshed" }] });
  });
  it("requires new authorization after unknown refresh rotation and never retries the old refresh token", async () => {
    const p = await peer(), store = new MemorySessionStore(), coordination = new MemoryCoordination();
    const { source: a } = setup(store, coordination), { source: b } = setup(store, coordination);
    await install(a, p); const auth = await authorize(a); expect(await a.completeAuthorization(auth.callback, signal())).toEqual({ status: "connected" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 57_000); p.setRefreshFailure();
    await expect(a.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
    expect(await b.getAuthorization(alice, ref, signal())).toMatchObject({ state: "outcome_unknown" });
    await expect(b.discover(alice, ref, signal())).rejects.toMatchObject({ code: "draining" });
    expect(p.counts()).toMatchObject({ tokenCalls: 2, refreshCalls: 1 }); expect(p.mcp.calls).toHaveLength(0);
  });
  it("does not publish a late exchange after real disconnect and waits for actual network close", async () => {
    const p = await peer(), { source, coordination } = setup(); await install(source, p); const auth = await authorize(source), gate = deferred<void>(), entered = deferred<void>();
    p.setTokenGate(async () => { entered.resolve(); await gate.promise; });
    const completed = source.completeAuthorization(auth.callback, signal()); await entered.promise;
    const pending = await source.getAuthorization(alice, ref, signal()); expect(pending?.authorizationEpoch).toBe(1);
    await source.disconnect(alice, ref, { expectedAuthorizationEpoch: 1, idempotencyKey: "fixture-disconnect" }, signal());
    gate.resolve(); expect(await completed).toEqual({ status: "reauthorization_required" });
    expect(await source.getAuthorization(alice, ref, signal())).toMatchObject({ state: "disconnected", credentialVersionId: null });
    expect(coordination.active.size).toBe(0); expect(p.mcp.calls).toHaveLength(0);
  });
  it("clears real pooled clients and provider leases on tenant fence", async () => {
    const p = await peer(), runtime = new TenantRuntimeCoordinator(), { source } = setup(undefined, undefined, runtime);
    await install(source, p, false); await source.discover(alice, ref, signal()); runtime.sealParticipants();
    expect(runtime.snapshot(alice.tenantId).providerRegistrations).toBe(1);
    expect(runtime.snapshot(alice.tenantId).providerOperations).toBe(1);
    const result = await runtime.drain({ tenantId: alice.tenantId, requestId: "fixture-drain", subjectGeneration: 1, t3aReceiptSha256: "a".repeat(64) }, 3000);
    expect(result.cacheEntryCountAfter).toBe(0); expect(result.activeOperationCountAfter).toBe(0);
    await expect(source.discover(alice, ref, signal())).rejects.toMatchObject({ code: "subject_deleting" });
  });
});
