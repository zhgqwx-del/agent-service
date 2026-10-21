import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeMcp } from "@agent-service/testkit";
import { MemorySessionStore, createMcpRegistryAccess, mcpCoordinationSubjectSha256,
  type McpCoordination, type McpCoordinationLease, type McpRegistrationOwner } from "@agent-service/store";
import type { Principal } from "@agent-service/protocol";
import { McpCredentialCipher } from "../src/mcp/cipher.js";
import { parseMcpDcrJson } from "../src/mcp/dcr-json.js";
import { RegisteredMcpService, type McpRegistrationRequest, type RegisteredMcpServiceOptions } from "../src/mcp/registered.js";

const alice: Principal = { tenantId: "dcr-tenant", userId: "alice" }, bob: Principal = { ...alice, userId: "bob" };
const tenant: McpRegistrationOwner = { scope: "tenant", tenantId: alice.tenantId, userId: null };
const ref = { scope: "tenant" as const, name: "echo" }, freshSignal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
class MemoryCoordination implements McpCoordination {
  readonly namespaceSha256 = "d".repeat(64);
  readonly listeners = new Set<(value: { registrationId: string | null; subjectSha256: string | null }) => void>();
  async enter(_input: Parameters<McpCoordination["enter"]>[0], caller: AbortSignal): Promise<McpCoordinationLease> {
    return { signal: caller, assertOpen: async () => { if (caller.aborted) throw new Error("Fixture closed."); }, release: async () => {} };
  }
  async publishInvalidation(input: Parameters<McpCoordination["publishInvalidation"]>[0]) {
    for (const listener of this.listeners) listener({ registrationId: input.registrationId,
      subjectSha256: input.subject === null ? null : mcpCoordinationSubjectSha256(this.namespaceSha256, input.subject) });
  }
  onInvalidation(listener: (value: { registrationId: string | null; subjectSha256: string | null }) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() {}
}
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => { vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function manage(owner = tenant, p = alice) { return createMcpRegistryAccess({ principal: p, owner,
  authority: owner.scope === "platform" ? "platform_operator" : owner.scope === "tenant" ? "tenant_admin" : "user_self", access: "manage" }); }
function setup(store = new MemorySessionStore(), overrides: Partial<RegisteredMcpServiceOptions> = {}) {
  const service = new RegisteredMcpService({ store, coordination: new MemoryCoordination(),
    cipher: new McpCredentialCipher({ keyId: "dcr-fixture-key", key: new Uint8Array(32).fill(5) }),
    callbackUrl: "http://127.0.0.1:1/v1/mcp/oauth/callback", allowLoopbackForTests: true,
    authorizeFleet: async () => {}, authorizeDcrFleet: async () => {}, timeoutMs: 2500, ...overrides });
  cleanup.push(() => service.close()); return { service, store };
}
async function peer() {
  const mcp = new FakeMcp(), upstream = await mcp.start(); cleanup.push(() => mcp.stop());
  let origin = "", registrationEndpoint = "/register", wrongIssuer = false, responseLoss = false, malformed = false;
  let responseTransform: ((value: Record<string, unknown>) => unknown) | undefined, registerGate: (() => Promise<void>) | undefined;
  let registrationWire: ((value: Record<string, unknown>) => string) | undefined, metadataWire: ((value: Record<string, unknown>) => string) | undefined;
  let secretExpiresAt = 0;
  const requests: { body: Record<string, unknown>; authorization: string | undefined }[] = [], errors: unknown[] = [];
  const clients = new Map<string, { method: string; secret: string | null }>(), codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  const issued = new Set<string>(), metadataHeaders: (string | undefined)[] = [], tokenHeaders: (string | undefined)[] = [], resourceHeaders: (string | undefined)[] = [];
  const server: Server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url!, origin), issuer = origin + "/oauth", endpoint = origin + "/mcp";
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/oauth/.well-known/openid-configuration") {
      metadataHeaders.push(request.headers.authorization); response.setHeader("content-type", "application/json");
      const metadata = url.pathname.includes("oauth-protected-resource") ? { resource: endpoint, authorization_servers: [issuer] }
        : { issuer: wrongIssuer ? origin + "/wrong" : issuer, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token",
          registration_endpoint: origin + registrationEndpoint, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], authorization_response_iss_parameter_supported: true };
      response.end(metadataWire && "issuer" in metadata ? metadataWire(metadata) : JSON.stringify(metadata)); return;
    }
    if (url.pathname === "/register" || url.pathname === "/register-other") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ body, authorization: request.headers.authorization });
      const clientId = `fixture-dynamic-client-${requests.length}`, method = String(body.token_endpoint_auth_method);
      const secret = method === "client_secret_basic" ? `fixture-dynamic-secret-${requests.length}` : null;
      clients.set(clientId, { method, secret });
      await registerGate?.();
      if (responseLoss) { response.destroy(); return; }
      response.writeHead(201, { "content-type": "application/json" });
      if (malformed) { response.end('{"client_id":'); return; }
      const value = { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: secretExpiresAt }) };
      response.end(registrationWire ? registrationWire(value) : JSON.stringify(responseTransform ? responseTransform(value) : value)); return;
    }
    if (url.pathname === "/authorize") {
      const code = randomUUID(); codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, clientId: url.searchParams.get("client_id")! });
      const callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", code); callback.searchParams.set("iss", issuer); response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    if (url.pathname === "/token") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8")), clientId = params.get("client_id")!, client = clients.get(clientId);
      tokenHeaders.push(request.headers.authorization); const code = codes.get(params.get("code")!);
      if (!client || params.get("resource") !== endpoint || client.method === "none" && request.headers.authorization !== undefined
        || client.method === "client_secret_basic" && request.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${client.secret}`).toString("base64")}`
        || params.get("grant_type") !== "refresh_token" && (!code || code.clientId !== clientId || params.get("redirect_uri") !== code.redirect
          || createHash("sha256").update(params.get("code_verifier")!).digest("base64url") !== code.challenge)) throw new Error("Fixture OAuth binding rejected.");
      codes.delete(params.get("code")!); const token = `fixture-dynamic-access-${tokenHeaders.length}`; issued.add(token);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ token_type: "Bearer", access_token: token,
        refresh_token: `fixture-dynamic-refresh-${tokenHeaders.length}`, expires_in: 60, scope: "echo" })); return;
    }
    if (url.pathname === "/mcp") {
      resourceHeaders.push(request.headers.authorization);
      if (!issued.has((request.headers.authorization ?? "").replace(/^Bearer /, ""))) { response.writeHead(401); response.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
      await new Promise<void>((resolve, reject) => {
        const outbound = httpRequest(upstream, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
          "content-length": bytes.length, "mcp-protocol-version": "2026-07-28",
          ...(typeof request.headers["mcp-method"] === "string" ? { "mcp-method": request.headers["mcp-method"] } : {}),
          ...(typeof request.headers["mcp-name"] === "string" ? { "mcp-name": request.headers["mcp-name"] } : {}) } }, incoming => {
          response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response); incoming.once("end", resolve);
        }); outbound.once("error", reject); outbound.end(bytes);
      }); return;
    }
    response.writeHead(404); response.end();
  })().catch(error => { errors.push(error); response.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { mcp, endpoint: origin + "/mcp", issuer: origin + "/oauth", requests, clients, errors, metadataHeaders, tokenHeaders, resourceHeaders,
    setEndpoint: (value: string) => { registrationEndpoint = value; }, setWrongIssuer: () => { wrongIssuer = true; },
    setResponseLoss: () => { responseLoss = true; }, setMalformed: () => { malformed = true; }, setExpiry: (value: number) => { secretExpiresAt = value; },
    setRegistrationWire: (value: typeof registrationWire) => { registrationWire = value; }, setMetadataWire: (value: typeof metadataWire) => { metadataWire = value; },
    setTransform: (value: typeof responseTransform) => { responseTransform = value; }, setGate: (value: typeof registerGate) => { registerGate = value; } };
}
function config(p: Awaited<ReturnType<typeof peer>>, method: "none" | "client_secret_basic" = "none"): McpRegistrationRequest {
  return { endpoint: p.endpoint, description: "DCR fixture", protocolVersion: "2026-07-28",
    authentication: { kind: "oauth_dynamic", issuer: p.issuer, clientAuthentication: method, scopes: ["echo"] } };
}
async function install(service: RegisteredMcpService, p: Awaited<ReturnType<typeof peer>>, method: "none" | "client_secret_basic" = "none", owner = tenant, expectedRevision = 0) {
  return service.upsert(owner, { access: manage(owner), name: "echo", expectedRevision, idempotencyKey: `install-${expectedRevision}`, config: config(p, method) }, freshSignal());
}
async function register(service: RegisteredMcpService, configVersionId: string, owner = tenant, idempotencyKey = "register", expectedRevision = 1, signal = freshSignal()) {
  return service.registerDynamicClient(owner, "echo", { access: manage(owner), configVersionId, expectedRevision, idempotencyKey }, signal);
}
async function status(service: RegisteredMcpService, configVersionId: string, owner = tenant) {
  return service.getDynamicClientStatus(owner, "echo", { access: manage(owner), configVersionId }, freshSignal());
}
async function authorize(service: RegisteredMcpService, p = alice, reference = ref, idempotencyKey = `begin-${p.userId}`) {
  const begin = await service.beginAuthorization(p, reference, { idempotencyKey }, freshSignal());
  const browser = await fetch(begin.authorizationUrl, { redirect: "manual" }); const callback = new URL(browser.headers.get("location")!);
  return { begin, callback: { state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, iss: callback.searchParams.get("iss")! } };
}

describe("MCP explicit DCR actual local HTTP and Memory sidecar", () => {
  it.each(["none", "client_secret_basic"] as const)("registers one %s config client then keeps actual users' S256/token/tool authority separate", async method => {
    const p = await peer(), { service } = setup(), installed = await install(service, p, method), id = installed.version.configVersionId;
    expect((await status(service, id)).registration.state).toBe("unregistered");
    await expect(service.beginAuthorization(alice, ref, { idempotencyKey: "before-ready" }, freshSignal())).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(p.requests).toHaveLength(0);
    const ready = await register(service, id); expect(ready.registration).toMatchObject({ state: "ready", manualReviewRequired: false, remoteRevocationSupported: false });
    expect(await register(service, id)).toEqual(ready); expect(p.requests).toHaveLength(1);
    expect(p.requests[0]!.authorization).toBeUndefined();
    expect(p.requests[0]!.body).toEqual({ redirect_uris: ["http://127.0.0.1:1/v1/mcp/oauth/callback"], token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "agent-service MCP", scope: "echo" });
    const a = await authorize(service), b = await authorize(service, bob);
    expect(a.callback.state).not.toBe(b.callback.state); expect(a.begin.authorizationId).not.toBe(b.begin.authorizationId);
    expect(await service.completeAuthorization(a.callback, freshSignal())).toEqual({ status: "connected" });
    await expect(service.discover(bob, ref, freshSignal())).rejects.toMatchObject({ code: "draining" });
    expect(await service.completeAuthorization(b.callback, freshSignal())).toEqual({ status: "connected" });
    const [tool] = await service.discover(alice, ref, freshSignal());
    expect(tool).toMatchObject({ needsApproval: true, mandatoryApproval: true });
    expect(await tool!.execute({ text: "dcr" }, { principal: alice, sessionId: "fixture-session", turnId: "fixture-turn", toolCallId: "fixture-call", signal: freshSignal() }))
      .toEqual({ content: [{ type: "text", text: "echo:dcr" }] });
    await service.discover(bob, ref, freshSignal());
    expect(new Set(p.resourceHeaders).size).toBe(2); expect(p.tokenHeaders).toHaveLength(2);
    expect(p.metadataHeaders.every(value => value === undefined)).toBe(true); expect(p.errors).toEqual([]);
    expect(JSON.stringify(ready)).not.toContain("fixture-dynamic-client"); expect(JSON.stringify(ready)).not.toContain("fixture-dynamic-secret");
    expect((await service.getInstalled(tenant, "echo", { access: manage() }, freshSignal()))!.version!.config.authentication.kind).toBe("oauth_dynamic");
  });
  it("supports a future basic-secret expiry and refuses fresh OAuth after expiry without re-registering", async () => {
    const p = await peer(), { service } = setup(); p.setExpiry(Math.floor(Date.now() / 1000) + 60);
    const installed = await install(service, p, "client_secret_basic"); await register(service, installed.version.configVersionId);
    const original = Date.now(); vi.spyOn(Date, "now").mockReturnValue(original + 61_000);
    await expect(service.beginAuthorization(alice, ref, { idempotencyKey: "expired" }, freshSignal())).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await status(service, installed.version.configVersionId)).registration.state).toBe("ready");
    expect(p.requests).toHaveLength(1); expect(p.tokenHeaders).toHaveLength(0);
  });
  it("preserves a legal opaque client ID containing a space through the ready receipt and authorization URL", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p);
    p.setTransform(value => ({ ...value, client_id: "fixture opaque client" }));
    expect((await register(service, installed.version.configVersionId)).registration.state).toBe("ready");
    const begin = await service.beginAuthorization(alice, ref, { idempotencyKey: "opaque-space-client" }, freshSignal());
    expect(new URL(begin.authorizationUrl).searchParams.get("client_id")).toBe("fixture opaque client"); expect(p.requests).toHaveLength(1);
  });
  it("creates separate clients for all three scopes and each immutable config version", async () => {
    const p = await peer(), { service } = setup();
    const owners: McpRegistrationOwner[] = [{ scope: "platform", tenantId: null, userId: null }, tenant, { scope: "user", tenantId: alice.tenantId, userId: alice.userId }];
    for (const owner of owners) { const value = await install(service, p, "none", owner); await register(service, value.version.configVersionId, owner); }
    const next = await install(service, p, "none", tenant, 1); await register(service, next.version.configVersionId, tenant, "register-next", 2);
    expect(p.requests).toHaveLength(4); expect(p.clients.size).toBe(4);
  });
  it("lets two services share one per-config CAS while only its first claimant sends", async () => {
    const p = await peer(), store = new MemorySessionStore(), { service: a } = setup(store), { service: b } = setup(store);
    const installed = await install(a, p), entered = deferred<void>(), release = deferred<void>(); p.setGate(async () => { entered.resolve(); await release.promise; });
    const pending = register(a, installed.version.configVersionId);
    try { await entered.promise; expect((await register(b, installed.version.configVersionId)).registration.state).toBe("sending"); expect(p.requests).toHaveLength(1); }
    finally { release.resolve(); }
    expect((await pending).registration.state).toBe("ready"); expect((await register(b, installed.version.configVersionId)).registration.state).toBe("ready"); expect(p.requests).toHaveLength(1);
  });
  it("keeps an unknown response-loss operation and never retries it under the same or a replacement key", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p); p.setResponseLoss();
    const result = await register(service, installed.version.configVersionId);
    expect(result.registration).toMatchObject({ state: "outcome_unknown", manualReviewRequired: true });
    expect(await register(service, installed.version.configVersionId)).toEqual(result);
    await expect(register(service, installed.version.configVersionId, tenant, "different-key")).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(p.requests).toHaveLength(1); expect((await status(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown");
  });
  it("rejects a changed metadata registration endpoint before dispatch and retains the exact failed operation", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p); p.setEndpoint("/register-other");
    const result = await register(service, installed.version.configVersionId); expect(result.registration.state).toBe("failed_not_dispatched");
    expect(await register(service, installed.version.configVersionId)).toEqual(result); expect(p.requests).toHaveLength(0);
  });
  it("rejects a mismatched AS issuer without publishing an intent or creating a client", async () => {
    const p = await peer(), { service } = setup(); p.setWrongIssuer();
    await expect(install(service, p)).rejects.toMatchObject({ code: "draining" }); expect(p.requests).toHaveLength(0);
    expect(await service.getInstalled(tenant, "echo", { access: manage() }, freshSignal())).toBeNull();
  });
  it.each([
    ["management-token", (value: Record<string, unknown>) => ({ ...value, registration_access_token: "must-not-escape" })],
    ["management-uri", (value: Record<string, unknown>) => ({ ...value, registration_client_uri: "https://private.example/client" })],
    ["wrong-redirect", (value: Record<string, unknown>) => ({ ...value, redirect_uris: ["https://wrong.example/callback"] })],
    ["wrong-auth", (value: Record<string, unknown>) => ({ ...value, token_endpoint_auth_method: "client_secret_post" })],
    ["missing-client", (value: Record<string, unknown>) => ({ ...value, client_id: "" })],
    ["public-secret", (value: Record<string, unknown>) => ({ ...value, client_secret: "unexpected", client_secret_expires_at: 0 })],
    ["oversized", (value: Record<string, unknown>) => ({ ...value, client_name: "x".repeat(66_000) })],
  ] as const)("preserves an unknown client after dispatched invalid %s response with no replay", async (_name, transform) => {
    const p = await peer(), { service } = setup(), installed = await install(service, p); p.setTransform(transform);
    const result = await register(service, installed.version.configVersionId); expect(result.registration.state).toBe("outcome_unknown");
    expect(await register(service, installed.version.configVersionId)).toEqual(result); expect(p.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });
  it("rejects an already expired basic secret and an incomplete JSON response as unknown after one native send", async () => {
    const p = await peer(), { service } = setup(); p.setExpiry(Math.floor(Date.now() / 1000) - 1);
    const first = await install(service, p, "client_secret_basic"); expect((await register(service, first.version.configVersionId)).registration.state).toBe("outcome_unknown");
    const second = await install(service, p, "none", tenant, 1); p.setMalformed();
    expect((await register(service, second.version.configVersionId, tenant, "register-second", 2)).registration.state).toBe("outcome_unknown"); expect(p.requests).toHaveLength(2);
  });
  it("cancels after durable preparation with zero native registration and safely settles the original operation", async () => {
    const p = await peer(), { service, store } = setup(), installed = await install(service, p), abort = new AbortController();
    const original = store.prepareMcpDynamicClient.bind(store);
    vi.spyOn(store, "prepareMcpDynamicClient").mockImplementationOnce(async input => { const result = await original(input); abort.abort(); return result; });
    await expect(register(service, installed.version.configVersionId, tenant, "register", 1, abort.signal)).rejects.toMatchObject({ code: "draining" });
    expect(p.requests).toHaveLength(0); expect((await status(service, installed.version.configVersionId)).registration.state).toBe("failed_not_dispatched");
  });
  it("cancels a native registration, joins it, and retains unknown even when a peer later returns success", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p), entered = deferred<void>(), release = deferred<void>(), abort = new AbortController();
    p.setGate(async () => { entered.resolve(); await release.promise; }); const pending = register(service, installed.version.configVersionId, tenant, "register", 1, abort.signal);
    try { await entered.promise; abort.abort(); await expect(pending).rejects.toMatchObject({ code: "draining" }); }
    finally { release.resolve(); }
    expect((await status(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown");
    expect((await register(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown"); expect(p.requests).toHaveLength(1);
  });
  it("refuses to publish a late registration after disable and preserves the historical operation", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p), entered = deferred<void>(), release = deferred<void>();
    p.setGate(async () => { entered.resolve(); await release.promise; }); const pending = register(service, installed.version.configVersionId);
    try { await entered.promise; await service.setState(tenant, "echo", { access: manage(), state: "disabled", expectedRevision: 1, idempotencyKey: "disable" }, freshSignal()); }
    finally { release.resolve(); }
    expect((await pending).registration.state).toBe("outcome_unknown"); expect((await status(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown");
    await expect(service.beginAuthorization(alice, ref, { idempotencyKey: "disabled" }, freshSignal())).rejects.toMatchObject({ code: "not_found" }); expect(p.requests).toHaveLength(1);
  });
  it("requires the independent fresh DCR fleet proof while preserving the pre-registered OAuth path", async () => {
    const p = await peer(), { service } = setup(undefined, { authorizeDcrFleet: undefined });
    await expect(install(service, p)).rejects.toMatchObject({ code: "draining" }); expect(p.requests).toHaveLength(0);
    const installed = await service.upsert(tenant, { access: manage(), name: "echo", expectedRevision: 0, idempotencyKey: "pre-registered",
      config: { ...config(p), authentication: { kind: "oauth", issuer: p.issuer, clientId: "existing-public", clientAuthentication: "none", scopes: ["echo"] } } }, freshSignal());
    expect(installed.version.config.authentication.kind).toBe("oauth");
    expect((await service.beginAuthorization(alice, ref, { idempotencyKey: "pre-registered-begin" }, freshSignal())).authorizationUrl).toContain("existing-public");
  });
  it("rechecks DCR capability when an old-registry probe succeeds after the preceding DCR proof has gone stale", async () => {
    const p = await peer(); let allowed = true, armed = false, sawDcrProof = false;
    const { service, store } = setup(undefined, {
      authorizeFleet: async () => { if (armed && sawDcrProof) allowed = false; },
      authorizeDcrFleet: async () => { if (!allowed) throw new Error("Fixture DCR fleet unavailable."); sawDcrProof = true; },
    });
    const installed = await install(service, p), original = store.prepareMcpDynamicClient.bind(store);
    vi.spyOn(store, "prepareMcpDynamicClient").mockImplementationOnce(async input => {
      const result = await original(input); armed = true; sawDcrProof = false; return result;
    });
    await expect(register(service, installed.version.configVersionId)).rejects.toMatchObject({ code: "draining" });
    expect(p.requests).toHaveLength(0); armed = false; allowed = true;
    expect((await status(service, installed.version.configVersionId)).registration.state).toBe("failed_not_dispatched");
  });
  it.each([
    ["client_id", "client_id", "none"], ["client_id", "client_\\u0069d", "none"],
    ["client_secret", "client_secret", "client_secret_basic"], ["client_secret", "client_\\u0073ecret", "client_secret_basic"],
  ] as const)("rejects duplicate wire result identity %s (%s) as unknown after exactly one native registration", async (field, duplicate, method) => {
    const p = await peer(), { service } = setup(), installed = await install(service, p, method);
    p.setRegistrationWire(value => `${JSON.stringify(value).slice(0, -1)},"${duplicate}":${JSON.stringify(value[field])}}`);
    expect((await register(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown");
    expect((await register(service, installed.version.configVersionId)).registration.state).toBe("outcome_unknown"); expect(p.requests).toHaveLength(1);
  });
  it.each([
    ["issuer", "issuer"], ["issuer", "iss\\u0075er"],
    ["registration_endpoint", "registration_endpoint"], ["registration_endpoint", "registration_endp\\u006fint"],
  ] as const)("rejects duplicate AS metadata %s (%s) before SDK parsing or intent publication", async (field, duplicate) => {
    const p = await peer(), { service } = setup();
    p.setMetadataWire(value => `${JSON.stringify(value).slice(0, -1)},"${duplicate}":${JSON.stringify(value[field])}}`);
    await expect(install(service, p)).rejects.toMatchObject({ code: "draining" }); expect(p.requests).toHaveLength(0);
    expect(await service.getInstalled(tenant, "echo", { access: manage() }, freshSignal())).toBeNull();
  });
  it("retains its known committed success when post-commit invalidation fails without attempting an unknown rewrite", async () => {
    const p = await peer(), coordination = new MemoryCoordination(), { service, store } = setup(undefined, { coordination });
    const installed = await install(service, p), finish = vi.spyOn(store, "finishMcpDynamicClient");
    vi.spyOn(coordination, "publishInvalidation").mockRejectedValueOnce(new Error("Fixture publish unavailable."));
    await expect(register(service, installed.version.configVersionId)).rejects.toMatchObject({ code: "draining" });
    expect(finish).toHaveBeenCalledTimes(1); expect(finish.mock.calls[0]![0].result.kind).toBe("success");
    expect((await status(service, installed.version.configVersionId)).registration.state).toBe("ready");
    expect((await register(service, installed.version.configVersionId)).registration.state).toBe("ready"); expect(p.requests).toHaveLength(1);
  });
  it("registers an untouched basic intent after disable/enable and preserves its client AAD across later user-OAuth revisions", async () => {
    const p = await peer(), { service } = setup(), installed = await install(service, p, "client_secret_basic");
    await service.setState(tenant, "echo", { access: manage(), state: "disabled", expectedRevision: 1, idempotencyKey: "before-register-disable" }, freshSignal());
    await service.setState(tenant, "echo", { access: manage(), state: "enabled", expectedRevision: 2, idempotencyKey: "before-register-enable" }, freshSignal());
    expect((await register(service, installed.version.configVersionId, tenant, "register-live-revision", 3)).registration.state).toBe("ready");
    const a = await authorize(service); expect(await service.completeAuthorization(a.callback, freshSignal())).toEqual({ status: "connected" });
    await service.setState(tenant, "echo", { access: manage(), state: "disabled", expectedRevision: 3, idempotencyKey: "after-register-disable" }, freshSignal());
    await service.setState(tenant, "echo", { access: manage(), state: "enabled", expectedRevision: 4, idempotencyKey: "after-register-enable" }, freshSignal());
    const next = await authorize(service, alice, ref, "after-enable-begin");
    expect(await service.completeAuthorization(next.callback, freshSignal())).toEqual({ status: "connected" });
    expect((await service.discover(alice, ref, freshSignal()))).toHaveLength(1); expect(p.requests).toHaveLength(1); expect(p.tokenHeaders).toHaveLength(2);
    expect((await service.getInstalled(tenant, "echo", { access: manage() }, freshSignal()))!.version!.configSha256).toBe(installed.version.configSha256);
  });
  it("refuses a native token send when its client secret expires while the final DCR proof is pending", async () => {
    const p = await peer(), entered = deferred<void>(), release = deferred<void>(); let nativeProofs = 0;
    const { service, store } = setup(undefined, { authorizeDcrFleet: async () => {
      if (nativeProofs > 0 && --nativeProofs === 0) { entered.resolve(); await release.promise; }
    } });
    p.setExpiry(Math.floor(Date.now() / 1000) + 60); const installed = await install(service, p, "client_secret_basic");
    await register(service, installed.version.configVersionId); const a = await authorize(service);
    let reads = 0; const original = store.getMcpAuthorizationContext.bind(store);
    vi.spyOn(store, "getMcpAuthorizationContext").mockImplementation(async input => {
      const current = await original(input);
      // First callback context locates the durable pending user; the next read
      // belongs to the token channel's trusted native beforeDispatch boundary.
      // Let its io postcheck pass, then hold the final version/expiry proof.
      if (++reads === 2) nativeProofs = 2; return current;
    });
    const completed = service.completeAuthorization(a.callback, freshSignal());
    try {
      await Promise.race([entered.promise, completed.then(() => { throw new Error("Fixture did not hold the native token proof."); })]);
      const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 61_000); release.resolve();
      expect(await completed).toEqual({ status: "reauthorization_required" });
      expect(p.tokenHeaders).toHaveLength(0); expect(p.requests).toHaveLength(1);
      expect((await status(service, installed.version.configVersionId)).registration.state).toBe("ready");
    } finally { release.resolve(); await completed; }
  });
  it.each([
    ["client_id", "high", "\ud800", "none"],
    ["client_secret", "low", "\udc00", "client_secret_basic"],
  ] as const)("preserves unknown after a native AS returns non-scalar %s (%s surrogate) without retrying", async (field, _label, invalid, method) => {
    const p = await peer(), { service } = setup(), installed = await install(service, p, method);
    p.setTransform(value => ({ ...value, [field]: invalid }));
    const result = await register(service, installed.version.configVersionId);
    expect(result.registration.state).toBe("outcome_unknown");
    expect(await register(service, installed.version.configVersionId)).toEqual(result); expect(p.requests).toHaveLength(1);
    await expect(service.beginAuthorization(alice, ref, { idempotencyKey: "non-scalar-result" }, freshSignal())).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(p.tokenHeaders).toHaveLength(0);
  });
  it.each([
    ["non-finite numeric extension", (value: Record<string, unknown>) => `${JSON.stringify(value).slice(0, -1)},"extension":1e400}`],
    ["non-scalar registration endpoint", (value: Record<string, unknown>) => JSON.stringify({ ...value, registration_endpoint: `${String(value.registration_endpoint)}\ud800` })],
    ["nested non-scalar extension key", (value: Record<string, unknown>) => JSON.stringify({ ...value, extension: { nested: [{ ["\udc00"]: "opaque" }] } })],
  ] as const)("rejects AS metadata %s on original wire before publishing an intent", async (_label, wire) => {
    const p = await peer(), { service } = setup(); p.setMetadataWire(wire);
    await expect(install(service, p)).rejects.toMatchObject({ code: "draining" }); expect(p.requests).toHaveLength(0);
    expect(await service.getInstalled(tenant, "echo", { access: manage() }, freshSignal())).toBeNull();
  });

});


describe("DCR-only JSON scalar identity", () => {
  it.each([
    ["root string lone high surrogate", String.raw`"\ud800"`],
    ["nested string lone low surrogate", String.raw`{"outer":[{"value":"\udc00"}]}`],
    ["object key lone high surrogate", String.raw`{"\ud800":"value"}`],
    ["nested object key lone low surrogate", String.raw`{"outer":[{"\udc00":"value"}]}`],
    ["non-finite root number", "1e400"],
    ["non-finite nested negative number", '{"extension":[-1e400]}'],
  ] as const)("rejects %s with one fixed error", (_label, wire) => {
    expect(() => parseMcpDcrJson(wire, 65_536)).toThrow("MCP JSON response is invalid.");
  });
  it("preserves legal escaped pairs and finite numeric boundaries", () => {
    const wire = String.raw`{"emoji":"\ud83d\ude00","nested":[{"\ud83d\ude00":"\ud83d\ude00"}],"finite":[1.7976931348623157e308,-1.7976931348623157e308,1e-400,0,-0]}`;
    expect(parseMcpDcrJson(wire, 65_536)).toEqual({ emoji: "😀", nested: [{ "😀": "😀" }], finite: [Number.MAX_VALUE, -Number.MAX_VALUE, 0, 0, -0] });
  });
  it("preserves direct Unicode scalar strings and opaque numeric-looking text", () => {
    const wire = '{"numericText":"1e400","emoji":"😀","finite":[0,1,-1,2.5,6.022e23]}';
    expect(parseMcpDcrJson(wire, 65_536)).toEqual({ numericText: "1e400", emoji: "😀", finite: [0, 1, -1, 2.5, 6.022e23] });
  });
});
