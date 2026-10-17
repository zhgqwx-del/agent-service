import { afterEach, describe, expect, it, vi } from "vitest";
import { Capabilities, PROTOCOL_VERSION, MANAGED_SKILL_REGISTRY_V1, INTERNAL_ROUTER_TOKEN_HEADER,
  INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX, INTERNAL_SKILL_REGISTRY_ACK_HEADER, INTERNAL_SKILL_REGISTRY_ACK_VALUE } from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";

const storage = { backend: "s3-v1-skills", shared: true, namespaceSha256: "4".repeat(64) };
const privateToken = "skill-registry-private-router-token-0001", operator = "skill-registry-platform-operator-token-0001";
const registries: RunnerRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map(r => r.close())); vi.unstubAllGlobals(); });
const document = (registry = true, actual = storage) => ({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: {
  streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true,
  sessionLifecycle: ["archive", "unarchive", "tombstone"], dynamicTools: true,
  mcp: [], skills: true, sandbox: ["none"], byok: true,
  ...(registry ? { skillRegistry: [MANAGED_SKILL_REGISTRY_V1], skillRegistryStorage: actual } : {}),
} });
const logger = { info() {}, warn() {}, error() {} };
describe("managed skill registry fresh complete fleet admission", () => {
  it("reprobes every configured destination and rejects legacy, unavailable or different namespaces", async () => {
    let state: "active" | "legacy" | "down" | "namespace" = "legacy", probes = 0, forwarded = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input), second = url.startsWith("http://b/");
      if (url.endsWith("/readyz")) { probes++; return new Response(null, { status: second && state === "down" ? 503 : 200 }); }
      if (url.endsWith("/v1/capabilities")) return Response.json(document(!second || state !== "legacy",
        second && state === "namespace" ? { ...storage, namespaceSha256: "5".repeat(64) } : storage));
      forwarded++; return Response.json({ data: [], nextCursor: null });
    }));
    const registry = new RunnerRegistry({ runners: ["http://a", "http://b"], skillRegistryStorage: storage }); registries.push(registry);
    await registry.refresh();
    const app = createRouterApp({ registry, logger, skillRegistryEnabled: () => true });
    for (const next of ["legacy", "active", "down", "namespace", "active"] as const) {
      state = next; const prior = probes, calls = forwarded;
      const response = await app.request("/v1/skills?scope=user", { headers: { authorization: "Bearer ordinary-key", "x-user-id": "alice" } });
      expect(probes).toBe(prior + 2); expect(response.status).toBe(next === "active" ? 200 : 503);
      expect(forwarded).toBe(calls + (next === "active" ? 1 : 0));
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(Capabilities.parse(await (await app.request("/v1/capabilities")).json()).features.skillRegistry).toEqual([MANAGED_SKILL_REGISTRY_V1]);
  });
  it("does not turn old skills=true or multi-runner filesystem declarations into registry authority", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => String(input).endsWith("/readyz")
      ? new Response(null, { status: 200 }) : Response.json(document(false))));
    const legacy = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: storage }); registries.push(legacy); await legacy.refresh();
    expect(legacy.allConfiguredSupportSkills()).toBe(true); expect(legacy.allConfiguredSupportSkillRegistry()).toBe(false);
    const fs = { backend: "filesystem-v1", shared: false, namespaceSha256: "4".repeat(64) };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => String(input).endsWith("/readyz")
      ? new Response(null, { status: 200 }) : Response.json(document(true, fs))));
    const multi = new RunnerRegistry({ runners: ["http://a", "http://b"], skillRegistryStorage: fs }); registries.push(multi); await multi.refresh();
    expect(multi.allConfiguredSupportSkillRegistry()).toBe(false);
    const single = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: fs }); registries.push(single); await single.refresh();
    expect(single.allConfiguredSupportSkillRegistry()).toBe(true);
  });
  it("fresh gates registry selectors, explicit overrides, and all session/turn admissions when enabled", async () => {
    let aware = true, probes = 0, forwarded = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input); if (url.endsWith("/readyz")) { probes++; return new Response(null, { status: 200 }); }
      if (url.endsWith("/v1/capabilities")) return Response.json(document(aware));
      forwarded++; return Response.json({ ok: true });
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: storage }); registries.push(registry); await registry.refresh();
    const app = createRouterApp({ registry, logger, skillRegistryEnabled: () => true });
    aware = false;
    for (const [path, body] of [["/v1/agents", { skills: ["registry:guide"] }], ["/v1/sessions", { agentId: "agt_fixture" }],
      ["/v1/sessions/sess_fixture/turns", { input: [{ type: "text", text: "hello" }] }],
      ["/v1/sessions/sess_fixture/turns", { skillOverrides: [] }]] as const) {
      const prior = probes; const response = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(503); expect(probes).toBe(prior + 1);
    }
    expect(forwarded).toBe(0);
    const off = createRouterApp({ registry, logger, skillRegistryEnabled: () => false });
    expect((await off.request("/v1/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skills: ["registry:guide"] }) })).status).toBe(503);
    expect((await off.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "agt_fixture" }) })).status).toBe(200);
    expect(forwarded).toBe(1);
  });
  it("consumes only the independent platform bearer, rewrites privately and never forwards ambient credentials", async () => {
    const forwarded: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input); if (url.endsWith("/readyz")) return new Response(null, { status: 200 });
      if (url.endsWith("/v1/capabilities")) return Response.json(document());
      forwarded.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ data: [], nextCursor: null }, { headers: { [INTERNAL_SKILL_REGISTRY_ACK_HEADER]: INTERNAL_SKILL_REGISTRY_ACK_VALUE } });
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: storage }); registries.push(registry); await registry.refresh();
    const app = createRouterApp({ registry, logger, internalRunnerToken: privateToken, skillRegistryOperatorToken: operator,
      tenantErasureOperatorToken: "separate-tenant-erasure-operator-token", skillRegistryEnabled: () => true });
    const allowed = await app.request("/v1/platform/skills", { headers: { authorization: `Bearer ${operator}`, cookie: "private-cookie", "x-user-id": "forged" } });
    expect(allowed.status).toBe(200); expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.url).toBe(`http://a${INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX}`);
    expect(forwarded[0]!.headers.get(INTERNAL_ROUTER_TOKEN_HEADER)).toBe(privateToken);
    expect(forwarded[0]!.headers.get("traceparent")).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/);
    for (const name of ["authorization", "cookie", "x-user-id"]) expect(forwarded[0]!.headers.get(name)).toBeNull();
    expect(allowed.headers.get(INTERNAL_SKILL_REGISTRY_ACK_HEADER)).toBeNull();
    for (const [path, token] of [["/v1/platform/skills", "separate-tenant-erasure-operator-token"], ["/v1/skills?scope=user", operator],
      ["/v1/sessions", operator], [INTERNAL_SKILL_REGISTRY_PLATFORM_PREFIX, privateToken]]) {
      expect((await app.request(path!, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    }
    expect(forwarded).toHaveLength(1);
  });
  it("requires the internal version ACK and never retries an uncertain platform mutation", async () => {
    let mutations = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = String(input); if (url.endsWith("/readyz")) return new Response(null, { status: 200 });
      if (url.endsWith("/v1/capabilities")) return Response.json(document());
      mutations++; return Response.json({ persisted: true });
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: storage }); registries.push(registry); await registry.refresh();
    const app = createRouterApp({ registry, logger, internalRunnerToken: privateToken, skillRegistryOperatorToken: operator, skillRegistryEnabled: () => true });
    expect((await app.request("/v1/platform/skills", { method: "POST", headers: { authorization: `Bearer ${operator}`, "content-type": "application/json", "idempotency-key": "one" },
      body: JSON.stringify({ document: "# fixture", expectedRevision: 0 }) })).status).toBe(503);
    expect(mutations).toBe(1);
  });
  it("rechecks close/gate after a fresh asynchronous probe and cannot admit using an older overlapping probe", async () => {
    let release!: () => void, ready = true, calls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input).endsWith("/readyz")) return new Response(null, { status: 200 });
      if (String(input).endsWith("/v1/capabilities")) { calls++; await new Promise<void>(resolve => { release = resolve; }); return Response.json(document()); }
      throw new Error("closed admission forwarded");
    }));
    const registry = new RunnerRegistry({ runners: ["http://a"], skillRegistryStorage: storage }); registries.push(registry);
    const periodic = registry.refresh(); await vi.waitFor(() => expect(calls).toBe(1));
    const app = createRouterApp({ registry, logger, ready: () => ready, skillRegistryEnabled: () => true });
    const pending = app.request("/v1/skills?scope=user"); await Promise.resolve(); expect(calls).toBe(1);
    release(); await periodic; await vi.waitFor(() => expect(calls).toBe(2));
    ready = false; release(); expect((await pending).status).toBe(503);
    expect(calls).toBe(2);
  });
});
