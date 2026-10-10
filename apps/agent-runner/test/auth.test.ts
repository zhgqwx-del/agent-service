import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, TenantAuthPolicy } from "@agent-service/protocol";
import {
  CredentialSourceConflictError,
  MemoryEventBus,
  MemoryLeaseStore,
  MemorySessionStore,
} from "@agent-service/store";
import { SessionHost, StaticToolRegistry, newId, type ResolvedModel } from "@agent-service/core";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";

/**
 * The two identity models from docs/design §5.1:
 *  - trusted_caller: the service key holder asserts the user with X-User-Id
 *  - end_user_token: the runner verifies the END USER's own token and derives the id from it
 */

const KEY = "66".repeat(32);
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

async function jwksServer(jwk: JWK): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
}

/** Minimal RFC 7662-ish introspection endpoint, recording what it was asked. */
async function introspectionServer(answer: (token: string) => Record<string, unknown> | number) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
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
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/introspect`, calls };
}

async function makeApp() {
  const store = new MemorySessionStore();
  await store.createApiKey("t_auth", "k1", hashApiKey("svc-key"), ["runtime", "admin"]);
  const cipher = new LocalAesGcmCipher(KEY);
  const providers = new ProviderService({ store, cipher, assertBaseUrl: async () => {} });
  const model: ResolvedModel = { handle: {}, provider: "fake", model: "fake", contextWindow: 1000, input: ["text"], apiKey: async () => "k" };
  const host = new SessionHost({
    store, lease: new MemoryLeaseStore(), bus: new MemoryEventBus(),
    engine: { name: "noop", start: () => ({ steer: () => {}, interrupt: () => {}, done: Promise.resolve({ steps: 0, aborted: false }) }) },
    providers: { resolve: async () => model }, tools: new StaticToolRegistry([]),
    config: { runnerId: "r", runnerAddr: "x", leaseHoldMs: 10 },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const app = createApp({
    store, host, providers, tools: new StaticToolRegistry([]), runnerId: "r",
    internalRouterToken: "auth-test-internal-router-token-01",
    heartbeatMs: 60_000, maxBodyBytes: 1_000_000, ready: () => true,
    decryptSecret: (s) => cipher.decrypt(s.ciphertext, s.keyId),
    encryptSecret: async (p) => ({ ciphertext: await cipher.encrypt(p), keyId: cipher.keyId }),
    // the test JWKS/introspection servers listen on 127.0.0.1; the strict default guard is covered by
    // its own test in auth-hardening.test.ts
    assertPublicUrl: async () => {},
  });
  const agent: AgentDefinition = {
    id: newId("agt"), tenantId: "t_auth", version: 1, name: "a", instructions: "", model: { provider: "fake", model: "fake" },
    tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "on-request", busyPolicy: "steer", sandbox: "none",
    metadata: {}, createdAtMs: Date.now(),
  };
  await store.createAgent(agent);
  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = {}) =>
    app.request(path, { ...init, headers: { authorization: "Bearer svc-key", "content-type": "application/json", ...headers } });
  const setPolicy = async (policy: TenantAuthPolicy, secret?: string) => {
    const r = await req("/v1/tenant/auth", { method: "PUT", body: JSON.stringify({ policy, secret }) });
    expect(r.status).toBe(200);
  };
  return { app, store, agent, req, setPolicy };
}

describe("trusted_caller mode (default)", () => {
  it("takes the user from X-User-Id and lets the caller act for any of its users", async () => {
    const h = await makeApp();
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id, userId: "u_someone_else" }) }, { "x-user-id": "u_backend" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { userId: string }).userId).toBe("u_someone_else");
  });

  it("still refuses a request with no user at all", async () => {
    const h = await makeApp();
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("X-User-Id");
  });
});

describe("end_user_token mode with a JWT", () => {
  const policy = (jwksUri: string): TenantAuthPolicy => ({
    mode: "end_user_token",
    tokenHeader: "x-end-user-token",
    verifier: { kind: "jwt", jwksUri, hs256: false, algorithms: ["RS256"], issuer: "https://auth.example", audience: "agent-api", subjectClaim: "sub", clockToleranceSec: 5 },
  });

  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwksUri = await jwksServer({ ...(await exportJWK(publicKey)), alg: "RS256", use: "sig" });
    const h = await makeApp();
    await h.setPolicy(policy(jwksUri));
    const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string | number } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setIssuer(opts.iss ?? "https://auth.example")
        .setAudience(opts.aud ?? "agent-api")
        .setExpirationTime(opts.exp ?? "5m")
        .sign(privateKey as KeyObject);
    return { ...h, sign, privateKey };
  }

  it("derives the user id from the verified token", async () => {
    const h = await setup();
    const token = await h.sign({ sub: "u_from_token" });
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { userId: string }).userId).toBe("u_from_token");
  });

  it("refuses X-User-Id on its own: no silent downgrade to an unverified identity", async () => {
    const h = await setup();
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u_claimed" });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("end-user token");
  });

  it("refuses a token whose subject disagrees with an asserted X-User-Id", async () => {
    const h = await setup();
    const token = await h.sign({ sub: "u_real" });
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token, "x-user-id": "u_other" });
    expect(r.status).toBe(403);
  });

  it("refuses a session created for a different user than the verified one", async () => {
    const h = await setup();
    const token = await h.sign({ sub: "u_real" });
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id, userId: "u_victim" }) }, { "x-end-user-token": token });
    expect(r.status).toBe(403);
  });

  it("rejects forged, expired, wrong-issuer, wrong-audience and wrong-algorithm tokens", async () => {
    const h = await setup();
    const bad: [string, string][] = [
      ["garbage", "not-a-jwt"],
      ["expired", await h.sign({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) - 600 })],
      ["wrong issuer", await h.sign({ sub: "u" }, { iss: "https://evil.example" })],
      ["wrong audience", await h.sign({ sub: "u" }, { aud: "another-api" })],
      // signed by a key the JWKS does not publish
      ["foreign key", await new SignJWT({ sub: "u" })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuedAt()
        .setIssuer("https://auth.example")
        .setAudience("agent-api")
        .setExpirationTime("5m")
        .sign((await generateKeyPair("RS256")).privateKey as KeyObject)],
    ];
    for (const [label, token] of bad) {
      const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token });
      expect(r.status, label).toBe(401);
      expect(JSON.stringify(await r.json()), label).not.toContain(token.slice(0, 24));
    }
  });

  it("rejects a token with no subject claim", async () => {
    const h = await setup();
    const token = await h.sign({ email: "nobody@example.com" });
    const r = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token });
    expect(r.status).toBe(401);
  });

  it("confines a verified user to their own sessions", async () => {
    const h = await setup();
    const a = await h.sign({ sub: "u_a" });
    const b = await h.sign({ sub: "u_b" });
    const created = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": a });
    const sid = ((await created.json()) as { id: string }).id;
    expect((await h.req(`/v1/sessions/${sid}`, {}, { "x-end-user-token": a })).status).toBe(200);
    expect((await h.req(`/v1/sessions/${sid}`, {}, { "x-end-user-token": b })).status).toBe(404);
  });
});

describe("end_user_token mode with HS256 and a stored secret", () => {
  it("verifies with the tenant's encrypted secret and never returns it", async () => {
    const h = await makeApp();
    const secret = "a-shared-secret-at-least-32-bytes-long";
    await h.setPolicy(
      { mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "uid", clockToleranceSec: 5 } },
      secret,
    );
    const shown = await (await h.req("/v1/tenant/auth")).json();
    expect(JSON.stringify(shown)).not.toContain(secret);
    expect((shown as { hasSecret: boolean }).hasSecret).toBe(true);

    const token = await new SignJWT({ uid: "u_hs" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));
    const ok = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": token });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { userId: string }).userId).toBe("u_hs");

    const forged = await new SignJWT({ uid: "u_hs" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("the-wrong-secret-padded-to-32-bytes!"));
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": forged })).status).toBe(401);
  });
});

describe("end_user_token mode with introspection", () => {
  it("accepts an active token, caches it, rejects an inactive one and fails closed when unreachable", async () => {
    const srv = await introspectionServer((token) => (token === "good" ? { active: true, sub: "u_opaque" } : { active: false }));
    const h = await makeApp();
    await h.setPolicy({
      mode: "end_user_token",
      tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: srv.url, method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 60_000, timeoutMs: 2_000 },
    });

    const first = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "good" });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { userId: string }).userId).toBe("u_opaque");
    const second = await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "good" });
    expect(second.status).toBe(201);
    expect(srv.calls.length).toBe(1); // cached, not one auth round trip per request

    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-end-user-token": "revoked" })).status).toBe(401);

    // auth service down -> requests are refused, never let through
    const dead = await makeApp();
    await dead.setPolicy({
      mode: "end_user_token",
      tokenHeader: "x-end-user-token",
      verifier: { kind: "introspection", endpoint: "http://127.0.0.1:1/introspect", method: "POST", tokenHeader: "authorization", activeField: "active", subjectField: "sub", useStoredSecret: false, cacheTtlMs: 0, timeoutMs: 300 },
    });
    const r = await dead.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: dead.agent.id }) }, { "x-end-user-token": "whatever" });
    expect(r.status).toBe(401);
  });
});

describe("policy administration", () => {
  it("is per tenant and takes effect for subsequent requests", async () => {
    const h = await makeApp();
    expect(((await (await h.req("/v1/tenant/auth")).json()) as { policy: { mode: string } }).policy.mode).toBe("trusted_caller");
    // trusted mode works now
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" })).status).toBe(201);
    await h.setPolicy({ mode: "end_user_token", tokenHeader: "x-end-user-token", verifier: { kind: "jwt", hs256: true, algorithms: ["HS256"], subjectClaim: "sub", clockToleranceSec: 5 } }, "shared-secret-value-32-bytes-min!!");
    // the same request is now refused: the switch is not advisory
    expect((await h.req("/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: h.agent.id }) }, { "x-user-id": "u1" })).status).toBe(401);
  });

  it("re-reads and retries auth CAS conflicts without exposing revisions or reviving an old secret", async () => {
    const h = await makeApp();
    await h.store.activateTenantCredentialTrackingCutover({ expectedControlGeneration: 0 });
    const policy: TenantAuthPolicy = {
      mode: "end_user_token",
      tokenHeader: "x-end-user-token",
      verifier: {
        kind: "jwt",
        hs256: true,
        algorithms: ["HS256"],
        subjectClaim: "uid",
        clockToleranceSec: 5,
      },
    };
    await h.setPolicy(policy, "first-shared-secret-at-least-32-bytes");

    const cipher = new LocalAesGcmCipher(KEY);
    const concurrentSecret = {
      ciphertext: await cipher.encrypt("concurrent-shared-secret-at-least-32"),
      keyId: cipher.keyId,
    };
    const delegate = h.store.setTenantAuth.bind(h.store);
    let injected = false;
    const write = vi.spyOn(h.store, "setTenantAuth").mockImplementation(async (
      tenantId,
      nextPolicy,
      secret,
      expectedSourceRevision,
    ) => {
      if (!injected) {
        injected = true;
        const winner = await delegate(
          tenantId,
          nextPolicy,
          concurrentSecret,
          expectedSourceRevision,
        );
        throw new CredentialSourceConflictError(
          "tenant_auth",
          expectedSourceRevision ?? null,
          winner.authCredentialSourceRevision ?? null,
        );
      }
      return delegate(tenantId, nextPolicy, secret, expectedSourceRevision);
    });

    const response = await h.req("/v1/tenant/auth", {
      method: "PUT",
      body: JSON.stringify({ policy }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ tenantId: "t_auth", policy, hasSecret: true });
    expect(JSON.stringify(body)).not.toContain("Revision");
    expect(write).toHaveBeenCalledTimes(2);
    const stored = await h.store.getTenant("t_auth");
    expect(await cipher.decrypt(stored!.authSecret!.ciphertext, stored!.authSecret!.keyId))
      .toBe("concurrent-shared-secret-at-least-32");
  });
});
