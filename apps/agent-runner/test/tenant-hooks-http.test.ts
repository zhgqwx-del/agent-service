import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, TenantHookResponse, TenantHookListResponse, TenantHookDeliveriesResponse } from "@agent-service/protocol";
import { RegisteredTenantWebhookService, TenantWebhookCipher } from "@agent-service/core";
import { MemorySessionStore, createTenantWebhookAdminAccess } from "@agent-service/store";
import { authMiddleware, hashApiKey, type AuthEnv } from "../src/auth.js";
import { registerTenantHooksRoutes } from "../src/tenant-hooks-routes.js";

// Real auth, core cipher/service and Memory transaction path; not a remote delivery/SQL proof.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const config = { endpoint: "https://observer.example.test/receive", phase: "preToolUse", bodyScopes: [] };
const signingKey = "a6".repeat(32);
async function fixture(enabled = true) {
  const store = new MemorySessionStore(); cleanup.push(() => store.close());
  for (const [tenant, key, scopes] of [["tenant-a", "runtime-a", ["runtime"]], ["tenant-a", "admin-a", ["admin"]],
    ["tenant-b", "admin-b", ["admin"]]] as const) await store.createApiKey(tenant, key, hashApiKey(key), [...scopes]);
  const cipher = new TenantWebhookCipher({ keyId: "fixture-hooks", key: Buffer.alloc(32, 83) });
  cleanup.push(async () => cipher.close());
  let fleetAvailable = true, fleetCalls = 0;
  const service = new RegisteredTenantWebhookService({ store, cipher,
    authorizeFleet: async signal => { fleetCalls++; signal.throwIfAborted(); if (!fleetAvailable) throw new ApiError("draining", "Tenant hooks are unavailable."); } });
  cleanup.push(() => service.close());
  const app = new Hono<AuthEnv>(), v1 = new Hono<AuthEnv>();
  app.onError((error, c) => error instanceof ApiError ? c.json(error.toBody(), error.status as 400)
    : c.json({ error: { code: "internal_error", message: "request failed" } }, 500));
  v1.use("*", authMiddleware({ store, decryptSecret: async () => "unused" }));
  registerTenantHooksRoutes(v1, { enabled, service }); app.route("/v1", v1);
  const request = (path: string, method = "GET", body?: unknown,
    options: { key?: string; user?: string; idem?: string } = {}) => app.request(path, {
    method, headers: { authorization: `Bearer ${options.key ?? "admin-a"}`,
      ...(options.user ? { "x-user-id": options.user } : {}), ...(options.idem ? { "idempotency-key": options.idem } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const upsert = (options: Parameters<typeof request>[3] = {}, extra = {}) => request("/v1/tenant-hooks", "POST",
    { name: "observer", expectedRevision: 0, config, signingKey, ...extra }, { idem: "create-observer", ...options });
  return { store, service, request, upsert, get fleetCalls() { return fleetCalls; }, disableFleet: () => { fleetAvailable = false; } };
}
describe("managed tenant observer HTTP authority and projection", () => {
  it("requires an actual admin API key on every operation, with no X-User-Id prerequisite", async () => {
    const f = await fixture(); expect((await f.upsert({ key: "runtime-a", user: "admin-a" })).status).toBe(403);
    const created = await f.upsert(); expect(created.status).toBe(201);
    expect(TenantHookResponse.parse(await created.json()).registration).toMatchObject({ name: "observer", revision: 1, state: "enabled" });
    const stored = await f.store.getTenantWebhook({ access: createTenantWebhookAdminAccess({ tenantId: "tenant-a", apiKeyId: "admin-a" }), name: "observer" });
    expect(stored?.version?.adminApiKeyId).toBe("admin-a");
    const requests: [string, string, unknown?][] = [["/v1/tenant-hooks", "GET"], ["/v1/tenant-hooks/observer", "GET"],
      ["/v1/tenant-hooks/observer/deliveries", "GET"], ["/v1/tenant-hooks/observer/state", "POST", { state: "disabled", expectedRevision: 1 }],
      ["/v1/tenant-hooks/observer", "DELETE", { expectedRevision: 1 }]];
    for (const [path, method, body] of requests) expect((await f.request(path, method, body, { key: "runtime-a", user: "admin-a", idem: "unauthorized" })).status).toBe(403);
    const before = await f.request("/v1/tenant-hooks/observer");
    expect(TenantHookResponse.parse(await before.json()).registration.revision).toBe(1);
  });
  it("isolates tenants and does not let asserted owner/admin fields grant disclosure", async () => {
    const f = await fixture(); expect((await f.upsert({ user: "other-user" })).status).toBe(201);
    expect((await f.request("/v1/tenant-hooks/observer", "GET", undefined, { key: "admin-b", user: "other-user" })).status).toBe(404);
    expect(TenantHookListResponse.parse(await (await f.request("/v1/tenant-hooks", "GET", undefined, { key: "admin-b" })).json()).data).toEqual([]);
    for (const field of ["tenantId", "userId", "apiKeyId", "adminApiKeyId", "scope", "configVersionId"]) {
      const response = await f.upsert({ idem: `forged-${field}` }, { [field]: "fixture-private-canary" });
      expect(response.status).toBe(400); expect(await response.text()).not.toContain("fixture-private-canary");
    }
  });
  it("persists exact idempotency and revision CAS without returning keys, ciphertext or administrator identity", async () => {
    const f = await fixture(), first = await f.upsert(); expect(first.status).toBe(201);
    const initial = await first.json(); const replay = await f.upsert(); expect(replay.status).toBe(201); expect(await replay.json()).toEqual(initial);
    const conflict = await f.upsert({ idem: "other-create" }); expect(conflict.status).toBe(409);
    const state = await f.request("/v1/tenant-hooks/observer/state", "POST", { state: "disabled", expectedRevision: 1 }, { idem: "disable" });
    expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ revision: 2, state: "disabled" });
    const read = await f.request("/v1/tenant-hooks/observer"); const text = await read.text();
    for (const value of [signingKey, "admin-a", "tenant-a", "ciphertext", "keyCommitmentSha256", "adminApiKeyId", "signingKey"])
      expect(text).not.toContain(value);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(TenantHookDeliveriesResponse.parse(await (await f.request("/v1/tenant-hooks/observer/deliveries")).json()).data).toEqual([]);
  });
  it("requires independently acknowledged body disclosure and never treats tool policy as consent", async () => {
    const f = await fixture(); const bodyConfig = { ...config, bodyScopes: ["prompt", "tool_arguments"] };
    expect((await f.upsert({}, { config: bodyConfig })).status).toBe(400);
    expect((await f.upsert({}, { config: bodyConfig, disclosureAck: "acceptForSession" })).status).toBe(400);
    const result = await f.upsert({}, { config: bodyConfig, disclosureAck: "tenant-admin-body-disclosure-v1" });
    expect(result.status).toBe(201); expect(TenantHookResponse.parse(await result.json()).version?.config.bodyScopes).toEqual(bodyConfig.bodyScopes);
  });
  it("fails closed while disabled or without the fresh configured-fleet gate", async () => {
    const off = await fixture(false); expect((await off.upsert()).status).toBe(503);
    const f = await fixture(); f.disableFleet(); expect((await f.upsert()).status).toBe(503);
    expect(f.fleetCalls).toBeGreaterThan(0);
    const noKey = await f.request("/v1/tenant-hooks", "POST", { name: "observer", expectedRevision: 0, config, signingKey });
    expect(noKey.status).toBe(400);
  });
  it("rejects duplicate/unknown queries and malformed mutation fields without reflecting their values", async () => {
    const f = await fixture();
    for (const path of ["/v1/tenant-hooks?limit=1&limit=2", "/v1/tenant-hooks?tenantId=fixture-private-canary",
      "/v1/tenant-hooks/observer?userId=fixture-private-canary"]) {
      const response = await f.request(path); expect(response.status).toBe(400); expect(await response.text()).not.toContain("fixture-private-canary");
    }
    const response = await f.upsert({}, { signingKey: "fixture-private-canary" });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("fixture-private-canary");
  });
});
