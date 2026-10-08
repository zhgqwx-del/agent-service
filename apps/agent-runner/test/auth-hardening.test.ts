import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition, TenantAuthPolicy } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore } from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type ResolvedModel } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp, type AppDeps } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { assertPublicUrlDefault, validateAuthPolicy } from "../src/auth-policy.js";

/**
 * Regression tests for a batch of authentication defects found by review. Each `it` is named after the
 * hole it closes; if one of these goes green-to-red, the corresponding attack is back.
 */

const KEY = "77".repeat(32);
let servers: Server[] = [];
afterEach(async () => {
  // closeAllConnections first: keep-alive sockets keep `close()` pending forever otherwise, and the
  // afterEach hook times out instead of the test failing.
  await Promise.all(
    servers.map((s) => {
      s.closeAllConnections?.();
      return new Promise<void>((r) => s.close(() => r()));
    }),
  );
  servers = [];
});

async function serve(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const jwksServer = (jwk: JWK) =>
  serve((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });

async function introspection(answer: (token: string) => Record<string, unknown> | number) {
  const calls: string[] = [];
  const base = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const token = new URLSearchParams(Buffer.concat(chunks).toString()).get("token") ?? "";
      calls.push(token);
      const out = answer(token);
      if (typeof out === "number") {
        res.writeHead(out);
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return { url: `${base}/introspect`, calls };
}

async function makeApp(opts: { scopes?: ("runtime" | "admin")[]; overrides?: Partial<AppDeps> } = {}) {
  const store = new MemorySessionStore();
  await store.createApiKey("t_h", "k1", hashApiKey("svc-key"), opts.scopes ?? ["runtime", "admin"]);
  await store.createApiKey("t_h", "k2", hashApiKey("runtime-only"), ["runtime"]);
  const cipher = new LocalAesGcmCipher(KEY);
  const providers = new ProviderService({ store, cipher, assertBaseUrl: async () => {} });
  const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 1000, apiKey: async () => "k" };
  const host = new SessionHost({
    store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(),
    engine: { name: "noop", start: () => ({ steer: () => {}, interrupt: () => {}, done: Promise.resolve({ steps: 0, aborted: false }) }) },
    providers: { resolve: async () => model }, tools: new StaticToolRegistry([]),
    config: { runnerId: "r", runnerAddr: "x", leaseHoldMs: 10 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const app = createApp({
    store, host, providers, tools: new StaticToolRegistry([]), runnerId: "r",
    internalRouterToken: "hardening-test-internal-token-01",
    heartbeatMs: 60_000, maxBodyBytes: 1_000_000, ready: () => true,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
    assertPublicUrl: async () => {},
    ...opts.overrides,
  });
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: "t_h", version: 1, name: "a", instructions: "", model: { provider: "fake", model: "fake" },
    tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none",
    metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}, key = "svc-key") =>
    app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers } });
  const setPolicy = async (policy: TenantAuthPolicy, secret?: string) =>
    req("/v1/tenant/auth", { method: "PUT", body: JSON.stringify({ policy, secret }) });
  return { app, store, agent, req, setPolicy };
}

async function jwtSetup() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwksUri = await jwksServer({ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" });
  const h = await makeApp();
  const policy: TenantAuthPolicy = {
    mode: "end_user_token",
    tokenHeader: "x-end-user-token",
    verifier: { kind: "jwt", jwksUri, hs256: false, algorithms: ["RS256"], issuer: "https://auth.example", audience: "agent-api", subjectClaim: "sub", clockToleranceSec: 5 },
  };
  expect((await h.setPolicy(policy)).status).toBe(200);
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer("https://auth.example").setAudience("agent-api").setExpirationTime("5m").sign(privateKey as KeyObject);
  return { ...h, sign, jwksUri };
}

describe("a missing user identity must never widen to tenant scope", () => {
  it("in end_user_token mode, the service key alone cannot read, delete or mutate another user's session", async () => {
    const h = await jwtSetup();
    const victim = await h.sign({ sub: "u_victim" });
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": victim });
    const sid = ((await created.json()) as { id: string }).id;

    // service key only: no end-user token, no X-User-Id
    for (const [method, path] of [
      ["GET", `/v1/sessions/${sid}`],
      ["GET", `/v1/sessions/${sid}/items`],
      ["GET", `/v1/sessions/${sid}/turns`],
      ["GET", `/v1/sessions/${sid}/approvals`],
      ["DELETE", `/v1/sessions/${sid}`],
      ["POST", `/v1/sessions/${sid}/resume`],
      ["POST", `/v1/sessions/${sid}/compact`],
    ] as const) {
      const r = await h.req(path, { method });
      expect([401, 403], `${method} ${path}`).toContain(r.status);
    }
    // and the session is still there
    expect((await h.req(`/v1/sessions/${sid}`, {}, { "x-end-user-token": victim })).status).toBe(200);
  });

  it("a blank or whitespace X-User-Id is not an identity", async () => {
    const h = await makeApp();
    const mine = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u_owner" });
    const sid = ((await mine.json()) as { id: string }).id;
    for (const value of ["", "   ", "\t"]) {
      const r = await h.req(`/v1/sessions/${sid}`, {}, { "x-user-id": value });
      expect([400, 401], `blank=${JSON.stringify(value)}`).toContain(r.status);
    }
  });

  it("mutating routes (interrupt, tool-results, steer) also require an identity", async () => {
    const h = await makeApp();
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u_owner" });
    const sid = ((await created.json()) as { id: string }).id;
    const turnId = newId("turn");
    for (const path of [`/v1/sessions/${sid}/turns/${turnId}/interrupt`, `/v1/sessions/${sid}/turns/${turnId}/tool-results`, `/v1/sessions/${sid}/turns/${turnId}/steer`]) {
      const r = await h.req(path, { method: "POST", body: JSON.stringify({ toolCallId: "c", content: [{ type: "text", text: "x" }], input: [{ type: "text", text: "x" }] }) });
      expect([400, 401], path).toContain(r.status);
    }
  });

  it("rejects a user id outside the allowed charset", async () => {
    const h = await makeApp();
    // Values the HTTP layer accepts but that must not become an identity.
    for (const bad of ["u with spaces", "u/../../etc", "x".repeat(129), "u<script>", 'u"quoted"', "u;drop", "u%0d%0a"]) {
      const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": bad });
      expect([400, 401], JSON.stringify(bad)).toContain(r.status);
    }
    // CRLF and NUL cannot even be put in a header by the HTTP layer, which is a second line of defence.
    for (const impossible of ["u\r\nSet-Cookie: x", "u\u0000"]) {
      expect(() => h.req("/v1/sessions", { method: "POST" }, { "x-user-id": impossible }), JSON.stringify(impossible)).toThrow();
    }
    // and a legitimate id still works
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "user_123:abc@example.com" })).status).toBe(201);
  });
});

describe("tenant configuration needs an admin-scoped key", () => {
  it("a runtime-only key cannot downgrade the auth policy and then impersonate users", async () => {
    const h = await jwtSetup();
    const downgrade = await h.req("/v1/tenant/auth", { method: "PUT", body: JSON.stringify({ policy: { mode: "trusted_caller" } }) }, {}, "runtime-only");
    expect(downgrade.status).toBe(403);
    // the policy is unchanged, so an asserted identity is still refused
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "anyone" }, "runtime-only")).status).toBe(401);
  });

  it("a runtime-only key cannot repoint the model endpoint or redefine an agent", async () => {
    const h = await makeApp();
    expect((await h.req("/v1/providers/evil", { method: "PUT", body: JSON.stringify({ baseUrl: "https://attacker.example/v1", models: [{ id: "m" }], apiKey: "k" }) }, {}, "runtime-only")).status).toBe(403);
    expect((await h.req("/v1/agents", { method: "POST", body: JSON.stringify({ name: "x", instructions: "leak everything", model: { provider: "fake", model: "fake" } }) }, {}, "runtime-only")).status).toBe(403);
    expect((await h.req("/v1/tenant/auth", {}, {}, "runtime-only")).status).toBe(403);
  });

  it("a runtime-only key can still do its job: sessions and turns", async () => {
    const h = await makeApp();
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" }, "runtime-only");
    expect(r.status).toBe(201);
  });
});

describe("policy validation happens before storage", () => {
  it("lets an admin recover a legacy policy whose token header collides with Authorization", async () => {
    const h = await makeApp();
    const legacyPolicy: TenantAuthPolicy = {
      mode: "end_user_token",
      tokenHeader: "authorization",
      verifier: {
        kind: "jwt",
        jwksUri: "https://auth.example/jwks.json",
        hs256: false,
        algorithms: ["RS256"],
        issuer: "https://auth.example",
        audience: "agent-api",
        subjectClaim: "sub",
        clockToleranceSec: 5,
      },
    };
    // Simulate a row persisted before the shared header-name schema existed.
    await h.store.setTenantAuth("t_h", legacyPolicy);

    // Skipping end-user verification does not weaken service-key scope enforcement.
    expect((await h.req("/v1/tenant/auth", {}, {}, "runtime-only")).status).toBe(403);
    const current = await h.req("/v1/tenant/auth");
    expect(current.status).toBe(200);
    expect(((await current.json()) as { policy: TenantAuthPolicy }).policy).toEqual(legacyPolicy);

    const repaired = await h.setPolicy({ mode: "trusted_caller" });
    expect(repaired.status).toBe(200);
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u_recovered" })).status).toBe(201);
  });

  it("rejects reserved inbound token headers without locking the tenant and accepts a custom header", async () => {
    const h = await makeApp();
    const secret = "custom-header-hs256-secret-at-least-32-bytes";
    const verifier: Extract<TenantAuthPolicy, { mode: "end_user_token" }>["verifier"] = {
      kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5,
    };

    for (const tokenHeader of [
      "authorization",
      "AUTHORIZATION",
      "x-user-id",
      "Host",
      "content-length",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      const rejected = await h.setPolicy({ mode: "end_user_token", tokenHeader, verifier }, secret);
      expect(rejected.status, tokenHeader).toBe(400);
    }

    // Failed validation happens before persistence, so the original trusted-caller policy still works.
    const unchanged = (await (await h.req("/v1/tenant/auth")).json()) as { policy: TenantAuthPolicy };
    expect(unchanged.policy).toEqual({ mode: "trusted_caller" });
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" })).status).toBe(201);

    // A syntactically valid, non-reserved custom header remains supported, including mixed-case input.
    expect((await h.setPolicy({ mode: "end_user_token", tokenHeader: "X-Tenant-End-User-Token", verifier }, secret)).status).toBe(200);
    const token = await new SignJWT({ sub: "u_custom" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));
    expect((await h.req(
      "/v1/sessions",
      { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) },
      { "x-tenant-end-user-token": token },
    )).status).toBe(201);
  });

  it("refuses hs256 with no secret instead of bricking every route", async () => {
    const h = await makeApp();
    const bad = await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5 } });
    expect(bad.status).toBe(400);
    // the tenant is untouched and still works
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" })).status).toBe(201);
  });

  it("refuses HS256 listed alongside a JWKS (algorithm confusion)", async () => {
    const h = await makeApp();
    const { publicKey } = await generateKeyPair("RS256");
    const jwksUri = await jwksServer({ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" });
    const r = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri, hs256: false, algorithms: ["RS256", "HS256"], issuer: "i", audience: "a", subjectClaim: "sub", clockToleranceSec: 5 },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/confusion|HS256/);
  });

  it("requires issuer and audience with a JWKS, so tokens minted for another relying party are not accepted", async () => {
    const h = await makeApp();
    const { publicKey } = await generateKeyPair("RS256");
    const jwksUri = await jwksServer({ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" });
    const r = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri, hs256: false, algorithms: ["RS256"], subjectClaim: "sub", clockToleranceSec: 5 },
    });
    expect(r.status).toBe(400);
  });

  it("switching the verifier clears the old secret rather than reusing it as a signing key", async () => {
    const h = await makeApp();
    const secret = "first-secret-value-at-least-32-b!";
    expect((await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5 } }, secret)).status).toBe(200);
    // switch to a verifier that needs no secret
    const srv = await introspection(() => ({ active: true, sub: "u_i" }));
    expect((await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "introspection", endpoint: srv.url, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 0, timeoutMs: 2_000 } })).status).toBe(200);
    expect(((await (await h.req("/v1/tenant/auth")).json()) as { hasSecret: boolean }).hasSecret).toBe(false);
    // going back to hs256 must demand a fresh secret, not resurrect the old one
    expect((await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5 } })).status).toBe(400);
  });

  it("refuses a jwksUri or introspection endpoint that is not a public address (SSRF)", async () => {
    // uses the REAL url guard, unlike the other cases here
    const h = await makeApp({ overrides: { assertPublicUrl: assertPublicUrlDefault } });
    const r1 = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri: "http://169.254.169.254/jwks.json", hs256: false, algorithms: ["RS256"], issuer: "i", audience: "a", subjectClaim: "sub", clockToleranceSec: 5 },
    });
    expect(r1.status).toBe(400);
    const r2 = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: "http://127.0.0.1:9/introspect", method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 0, timeoutMs: 500 },
    });
    expect(r2.status).toBe(400);
    await expect(validateAuthPolicy(
      { policy: { mode: "end_user_token", tokenHeader: "x", verifier: { kind: "jwt", jwksUri: "https://1.1.1.1/jwks.json", hs256: false, algorithms: ["RS256"], issuer: "i", audience: "a", subjectClaim: "sub", clockToleranceSec: 5 } } },
      false,
    )).resolves.toBeUndefined();
  });
});

describe("introspection verifier strictness", () => {
  it("only `active === true` authenticates", async () => {
    for (const body of [{ sub: "u" }, { active: "false", sub: "u" }, { active: 0, sub: "u" }, { active: "true", sub: "u" }, { active: 1, sub: "u" }, { active: true }]) {
      const srv = await introspection(() => body);
      const h = await makeApp();
      expect((await h.setPolicy({
        mode: "end_user_token", tokenHeader: "x-end-user-token",
        verifier: { kind: "introspection", endpoint: srv.url, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 0, timeoutMs: 2_000 },
      })).status).toBe(200);
      const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "t" });
      expect(r.status, JSON.stringify(body)).toBe(401);
    }
  });

  it("caches rejections so a flood of bad tokens is not a free DoS on the tenant's auth service", async () => {
    const srv = await introspection((t) => (t === "good" ? { active: true, sub: "u" } : { active: false }));
    const h = await makeApp();
    await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: srv.url, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 60_000, timeoutMs: 2_000 },
    });
    for (let i = 0; i < 5; i++) {
      const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "bad" });
      expect(r.status).toBe(401);
    }
    expect(srv.calls.filter((t) => t === "bad").length).toBe(1);
  });
});

describe("verifier lifecycle", () => {
  it("survives a policy cache expiry, so the JWKS is not refetched and the introspection cache is kept", async () => {
    let jwksHits = 0;
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" };
    const base = await serve((_q, res) => {
      jwksHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    const h = await makeApp({ overrides: { policyCacheMs: 1 } }); // expire the policy on every request
    await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri: `${base}/jwks.json`, hs256: false, algorithms: ["RS256"], issuer: "https://auth.example", audience: "agent-api", subjectClaim: "sub", clockToleranceSec: 5 },
    });
    const token = await new SignJWT({ sub: "u_j" }).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setIssuer("https://auth.example").setAudience("agent-api").setExpirationTime("5m").sign(privateKey as KeyObject);
    for (let i = 0; i < 4; i++) {
      const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token });
      expect(r.status).toBe(201);
    }
    expect(jwksHits).toBe(1);
  });

  it("rejects an oversized token before verifying it", async () => {
    const h = await jwtSetup();
    const huge = `a.${"b".repeat(9000)}.c`;
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": huge });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/too large/);
  });
});

describe("routes that previously widened to tenant scope", () => {
  it("listing sessions, reading usage and opening an event stream all need an identity or admin", async () => {
    const h = await jwtSetup();
    const victim = await h.sign({ sub: "u_victim" });
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": victim });
    const sid = ((await created.json()) as { id: string }).id;

    // a runtime-only key with no end-user identity must not enumerate or read anything
    for (const path of ["/v1/sessions", "/v1/usage", "/v1/usage?groupBy=user", `/v1/sessions/${sid}/events`]) {
      const r = await h.req(path, {}, {}, "runtime-only");
      expect([401, 403], path).toContain(r.status);
    }
    // an admin key may list across users (that is what admin is for), but still cannot open a user's stream
    expect((await h.req("/v1/sessions")).status).toBe(200);
    expect((await h.req("/v1/usage?groupBy=user")).status).toBe(200);
    expect([401, 403]).toContain((await h.req(`/v1/sessions/${sid}/events`)).status);
    // the owner can
    expect((await h.req(`/v1/sessions/${sid}`, {}, { "x-end-user-token": victim })).status).toBe(200);
  });

  it("agent definitions carry the system prompt, so reading them is admin-only", async () => {
    const h = await makeApp();
    expect((await h.req(`/v1/agents/${h.agent.id}`, {}, {}, "runtime-only")).status).toBe(403);
    expect((await h.req("/v1/agents", {}, {}, "runtime-only")).status).toBe(403);
    expect((await h.req(`/v1/agents/${h.agent.id}`)).status).toBe(200);
  });

  it("getSession refuses outright when no identity is present, rather than silently widening", async () => {
    const h = await makeApp();
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u_owner" });
    const sid = ((await created.json()) as { id: string }).id;
    const r = await h.req(`/v1/sessions/${sid}`);
    expect([400, 401]).toContain(r.status);
  });
});

describe("secret lifecycle across verifier changes", () => {
  it("an introspection credential cannot be reused as the HS256 signing key", async () => {
    const h = await makeApp();
    // only "issued" is a real token for this tenant, so a forged JWT is not silently accepted below
    const srv = await introspection((t) => (t === "issued" ? { active: true, sub: "u_i" } : { active: false }));
    const credential = "credential-the-auth-service-sees!";
    expect((await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: srv.url, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: true, cacheTtlMs: 0, timeoutMs: 2_000 },
    }, credential)).status).toBe(200);

    // switching to hs256 without a NEW secret must be refused: that credential is known to a third party
    const switched = await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5 } });
    expect(switched.status).toBe(400);
    expect(((await switched.json()) as { error: { message: string } }).error.message).toMatch(/NEW secret|different verifier/);

    // the policy is unchanged, so a JWT forged with that credential buys nothing
    const forged = await new SignJWT({ sub: "u_victim" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(credential));
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": forged });
    expect(r.status).toBe(401);
    // and the legitimate opaque token still works
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "issued" })).status).toBe(201);
  });

  it("only sends the stored credential when useStoredSecret is set", async () => {
    const seen: (string | undefined)[] = [];
    const base = await serve((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ active: true, sub: "u_i" }));
    });
    const h = await makeApp();
    await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: `${base}/introspect`, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 0, timeoutMs: 2_000 },
    }, "a-credential-that-must-not-leak!");
    await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "t" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });
});

describe("policy validation details", () => {
  it("requires https for a jwksUri and refuses an empty algorithm list", async () => {
    const h = await makeApp({ overrides: { assertPublicUrl: assertPublicUrlDefault } });
    const httpJwks = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri: "http://1.1.1.1/jwks.json", hs256: false, algorithms: ["RS256"], issuer: "i", audience: "a", subjectClaim: "sub", clockToleranceSec: 5 },
    });
    expect(httpJwks.status).toBe(400);
    expect(((await httpJwks.json()) as { error: { message: string } }).error.message).toMatch(/https/);

    const noAlgs = await h.setPolicy({
      mode: "end_user_token", tokenHeader: "x-end-user-token",
      verifier: { kind: "jwt", jwksUri: "https://1.1.1.1/jwks.json", hs256: false, algorithms: [], issuer: "i", audience: "a", subjectClaim: "sub", clockToleranceSec: 5 },
    });
    expect(noAlgs.status).toBe(400);
  });
});

describe("api key management", () => {
  it("mints a key once, lists it without the secret, and revokes it", async () => {
    const h = await makeApp();
    const created = await h.req("/v1/tenant/api-keys", { method: "POST", body: JSON.stringify({ keyId: "edge-1", scopes: ["runtime"] }) });
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: string };
    expect(key).toMatch(/^ask_/);

    // the new key works and is runtime-only
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" }, key)).status).toBe(201);
    expect((await h.req("/v1/tenant/auth", {}, {}, key)).status).toBe(403);

    // listing never returns the secret
    const listed = await (await h.req("/v1/tenant/api-keys")).json() as { data: { keyId: string }[] };
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(listed.data.map((k) => k.keyId)).toContain("edge-1");

    // a duplicate name is refused, and revocation takes effect immediately
    expect((await h.req("/v1/tenant/api-keys", { method: "POST", body: JSON.stringify({ keyId: "edge-1" }) })).status).toBe(400);
    expect((await h.req("/v1/tenant/api-keys/edge-1", { method: "DELETE" })).status).toBe(204);
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" }, key)).status).toBe(401);
  });

  it("refuses to revoke the key making the request", async () => {
    const h = await makeApp();
    expect((await h.req("/v1/tenant/api-keys/k1", { method: "DELETE" })).status).toBe(400);
  });
});
