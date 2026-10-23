import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHost, StaticToolRegistry, newId, type AgentEngine } from "@agent-service/core";
import { MemoryEventBus, MemorySessionStore } from "@agent-service/store";
import { LocalAesGcmCipher, ProviderService } from "@agent-service/providers";
import { createRuntimeMetrics, RUNTIME_METRICS_CONTENT_TYPE } from "@agent-service/protocol";
import { createApp, type AppDeps } from "../src/app.js";
import { hashApiKey } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const TOKEN = "metrics-unit-runner-independent-token-0001";
const INTERNAL = "metrics-unit-runner-internal-token-000001";
const TENANT_KEY = "metrics-unit-ordinary-tenant-key-0000001";
const PRIVATE = "private-owner-provider-query-marker";
const hosts: SessionHost[] = [];
const processSnapshot = () => ({ uptimeSeconds: 1, residentMemoryBytes: 2, heapUsedBytes: 3,
  cpuUserSeconds: 4, cpuSystemSeconds: 5 });
const protectedBearerVariants = [false, true].flatMap((enabled) => [
  { label: "multiple spaces", authorization: `Bearer  ${TOKEN}`, scrapeStatus: 401 },
  { label: "tab", authorization: `Bearer\t${TOKEN}`, scrapeStatus: 401 },
  { label: "nonbreaking space", authorization: `Bearer\u00a0${TOKEN}`, scrapeStatus: 401 },
  { label: "mixed-case scheme", authorization: `bEaReR ${TOKEN}`, scrapeStatus: 200 },
  { label: "combined header protected last", authorization: `Bearer wrong, Bearer ${TOKEN}`, scrapeStatus: 401 },
  { label: "combined header protected first", authorization: `Bearer ${TOKEN}, Bearer wrong`, scrapeStatus: 401 },
].map((variant) => ({ enabled, ...variant })));

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.drain(100);
});

async function fixture(options: { enabled?: boolean; preStaged?: boolean; ready?: () => boolean } = {}) {
  const store = new MemorySessionStore();
  await store.createApiKey("metrics-private-tenant", "metrics-unit-key", hashApiKey(TENANT_KEY), ["runtime", "admin"]);
  const cipher = new LocalAesGcmCipher("33".repeat(32));
  const providers = new ProviderService({ store, cipher, platform: [], assertBaseUrl: async () => {} });
  const tools = new StaticToolRegistry([]);
  const engine: AgentEngine = { name: "unused-metrics-unit", start() { throw new Error("metrics tests never invoke a model"); } };
  const host = new SessionHost({ store, lease: store.sessionAuthority, bus: new MemoryEventBus(), engine,
    providers: { resolve: async () => { throw new Error("metrics tests never resolve a provider"); } }, tools,
    config: { runnerId: "metrics-unit-runner", runnerAddr: "127.0.0.1:8787", leaseHoldMs: 100 } });
  hosts.push(host);
  const registry = createRuntimeMetrics("runner", { now: () => 1_000, processSnapshot });
  const deps: AppDeps = { store, host, providers, tools, runnerId: "metrics-unit-runner",
    internalRouterToken: INTERNAL, heartbeatMs: 60_000, maxBodyBytes: 1_000_000,
    ready: options.ready ?? (() => true),
    decryptSecret: (secret) => cipher.decrypt(secret.ciphertext, secret.keyId),
    encryptSecret: async (plain) => ({ ciphertext: await cipher.encrypt(plain), keyId: cipher.keyId }),
    assertPublicUrl: async () => {},
    ...(options.enabled === false ? (options.preStaged ? { metrics: { bearerToken: TOKEN } } : {})
      : { metrics: { registry, bearerToken: TOKEN } }),
  };
  return { app: createApp(deps), deps, registry };
}

const auth = () => ({ authorization: `Bearer ${TOKEN}` });
async function scrape(app: ReturnType<typeof createApp>) {
  const response = await app.request("/metrics", { headers: auth() });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(RUNTIME_METRICS_CONTENT_TYPE);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.text();
}
function samples(text: string) {
  return text.split("\n").flatMap((line) => {
    const match = /^agent_service_http_requests_total\{([^}]+)\} ([0-9]+)$/.exec(line);
    if (!match) return [];
    const labels = Object.fromEntries([...match[1]!.matchAll(/([a-z_]+)="([^"]*)"/g)].map((entry) => [entry[1]!, entry[2]!]));
    return [{ labels, count: Number(match[2]) }];
  });
}

describe("runner private runtime metrics", () => {
  it.each(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"])("keeps disabled %s /metrics local and unavailable", async (method) => {
    const config = loadConfig({ SECRETS_MASTER_KEY: "11".repeat(32), METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: TOKEN });
    const { app } = await fixture({ enabled: config.METRICS_ENABLED, preStaged: true });
    expect((await app.request("/metrics", { method, headers: auth() })).status).toBe(404);
  });

  it("keeps all metrics methods unavailable when no descriptor is configured", async () => {
    const { app } = await fixture({ enabled: false });
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      expect((await app.request("/metrics", { method, headers: auth() })).status).toBe(404);
    }
  });

  it.each([false, true])("never uses the reserved ops credential for runtime access (enabled=%s)", async (enabled) => {
    const { app } = await fixture({ enabled, preStaged: true });
    for (const path of ["/v1/sessions", "/metrics/unknown", "/metrics/"]) {
      const response = await app.request(path, { headers: auth() });
      expect(response.status).toBe(path.startsWith("/metrics/") ? 404 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(TOKEN);
    }
  });

  it.each(protectedBearerVariants)("keeps protected bearer containment separate from scrape authentication: $label (enabled=$enabled)", async ({ enabled, authorization, scrapeStatus }) => {
    const { app } = await fixture({ enabled, preStaged: true });
    const headers = { authorization };
    const response = await app.request("/v1/agents", { headers });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(TOKEN);
    // Containment is deny-only. Scrape auth allows a case-insensitive scheme with exactly one
    // ASCII space, but not alternate whitespace/combined fields; pre-staging never activates it.
    const metric = await app.request("/metrics", { headers });
    expect(metric.status).toBe(enabled ? scrapeStatus : 404);
    expect(metric.headers.get("cache-control")).toBe("no-store");
  });

  it.each([undefined, "wrong-independent-token", TENANT_KEY, INTERNAL])("rejects absent, wrong, tenant and internal bearer credentials (%s)", async (token) => {
    const { app } = await fixture();
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await app.request("/metrics", { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(token ?? "undefined");
    }
  });

  it("requires the bearer header rather than a query credential and never reflects request data", async () => {
    const { app } = await fixture();
    expect((await app.request(`/metrics?token=${TOKEN}`)).status).toBe(401);
    const response = await app.request(`/metrics?tenant=${PRIVATE}&token=${TOKEN}`, {
      headers: { ...auth(), "x-user-id": PRIVATE, "x-session-id": PRIVATE, "x-provider": PRIVATE },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const secret of [TOKEN, TENANT_KEY, INTERNAL, PRIVATE]) expect(text).not.toContain(secret);
  });

  it("serves Prometheus text and authenticated HEAD without counting its own scrapes", async () => {
    const { app } = await fixture();
    expect((await app.request("/healthz")).status).toBe(200);
    const first = await scrape(app);
    expect(first).toContain("agent_service_http_requests_total");
    const head = await app.request("/metrics", { method: "HEAD", headers: auth() });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(RUNTIME_METRICS_CONTENT_TYPE);
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(await head.text()).toBe("");
    expect(await scrape(app)).toBe(first);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("authenticates before returning a local 405 for %s", async (method) => {
    const { app } = await fixture();
    const response = await app.request("/metrics", { method, headers: auth() });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("counts parallel responses and closed routes without retaining raw owner, URL, header or method", async () => {
    const { app } = await fixture({ ready: () => false });
    const health = await Promise.all(Array.from({ length: 12 }, () => app.request("/healthz")));
    expect(health.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect((await app.request("/readyz")).status).toBe(503);
    const session = newId("sess");
    expect((await app.request(`/v1/sessions/${session}/items?provider=${PRIVATE}`, {
      headers: { authorization: `Bearer ${TENANT_KEY}`, "x-user-id": PRIVATE },
    })).status).toBe(404);
    expect((await app.request(`/unknown/${PRIVATE}?secret=${TOKEN}`, { method: "PROPFIND", headers: { "x-owner": PRIVATE } })).status).toBe(404);
    const text = await scrape(app);
    const rows = samples(text);
    expect(rows.find((row) => row.labels.route === "health" && row.labels.status_class === "2xx")?.count).toBe(12);
    expect(rows.find((row) => row.labels.route === "ready" && row.labels.status_class === "5xx")?.count).toBe(1);
    expect(rows.find((row) => row.labels.route === "session_items" && row.labels.status_class === "4xx")?.count).toBe(1);
    expect(rows.find((row) => row.labels.route === "other" && row.labels.method === "other")?.count).toBe(1);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(15);
    for (const value of [PRIVATE, session, TOKEN, TENANT_KEY, "PROPFIND", "x-owner"]) expect(text).not.toContain(value);
    for (const row of rows) expect(Object.keys(row.labels).sort()).toEqual(["component", "method", "route", "status_class"]);
  });

  it("preserves ordinary 500 responses while metrics contain no raw error", async () => {
    const { app } = await fixture({ ready: () => { throw new Error(PRIVATE); } });
    const response = await app.request("/readyz");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(PRIVATE);
    const text = await scrape(app);
    expect(samples(text).find((row) => row.labels.route === "ready" && row.labels.status_class === "5xx")?.count).toBe(1);
    expect(text).not.toContain(PRIVATE);
  });

  it("fails only the scrape closed when rendering throws", async () => {
    const { app, registry } = await fixture();
    vi.spyOn(registry, "render").mockImplementation(() => { throw new Error(PRIVATE); });
    const response = await app.request("/metrics", { headers: auth() });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(PRIVATE);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("does not fail an ordinary request when starting its metric observation throws", async () => {
    const { app, registry } = await fixture();
    vi.spyOn(registry, "beginRequest").mockImplementation(() => { throw new Error(PRIVATE); });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("does not fail an ordinary response when its metric finish callback throws", async () => {
    const { app, registry } = await fixture();
    const finish = vi.fn((_status: number) => { throw new Error(PRIVATE); });
    vi.spyOn(registry, "beginRequest").mockReturnValue(finish);
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(finish).toHaveBeenCalledExactlyOnceWith(200);
  });

  it.each(["", "short", "x".repeat(257), "invalid token with whitespace", "非ASCII-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"])("rejects an invalid app descriptor token (%s)", async (token) => {
    const { deps, registry } = await fixture();
    expect(() => createApp({ ...deps, metrics: { registry, bearerToken: token } })).toThrow();
  });

  it("rejects reuse of the internal routing credential as app metrics authority", async () => {
    const { deps, registry } = await fixture();
    expect(() => createApp({ ...deps, metrics: { registry, bearerToken: INTERNAL } })).toThrow();
  });
});
