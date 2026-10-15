import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeMetrics, RUNTIME_METRICS_CONTENT_TYPE } from "@agent-service/protocol";
import { createRouterApp, type RouterAppDeps } from "../src/app.js";
import { RunnerRegistry } from "../src/registry.js";
import { loadRouterConfig } from "../src/config.js";

const TOKEN = "metrics-unit-router-independent-token-0001";
const INTERNAL = "metrics-unit-router-internal-token-000001";
const ADMIN = "metrics-unit-router-admin-token-00000001";
const TENANT_KEY = "metrics-unit-ordinary-tenant-key-0000001";
const PRIVATE = "private-owner-provider-query-marker";
const registries: RunnerRegistry[] = [];
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
  for (const registry of registries.splice(0)) await registry.close();
});

function fixture(options: { enabled?: boolean; preStaged?: boolean; ready?: () => boolean } = {}) {
  // Use the real registry without starting probes or attaching Redis. Its real target is made
  // healthy so a mistaken metrics fallback would actually reach the intercepted fetch path.
  const registry = new RunnerRegistry({ runners: ["http://127.0.0.1:9"], internalRouterToken: INTERNAL });
  registry.list()[0]!.healthy = true;
  registries.push(registry);
  const metrics = createRuntimeMetrics("router", { now: () => 1_000, processSnapshot });
  const deps: RouterAppDeps = { registry, internalRunnerToken: INTERNAL, adminToken: ADMIN,
    ready: options.ready ?? (() => true),
    ...(options.enabled === false ? (options.preStaged ? { metrics: { bearerToken: TOKEN } } : {})
      : { metrics: { registry: metrics, bearerToken: TOKEN } }),
  };
  const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
  return { app: createRouterApp(deps), deps, metrics, upstream };
}

const auth = () => ({ authorization: `Bearer ${TOKEN}` });
async function scrape(app: ReturnType<typeof createRouterApp>) {
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

describe("router private runtime metrics", () => {
  it.each(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"])("keeps disabled %s metrics from reaching even a healthy runner", async (method) => {
    const config = loadRouterConfig({ RUNNERS: "http://127.0.0.1:9", METRICS_ENABLED: "0", METRICS_BEARER_TOKEN: TOKEN });
    const { app, upstream } = fixture({ enabled: config.METRICS_ENABLED, preStaged: true });
    expect((await app.request("/metrics", { method, headers: auth() })).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps unconfigured metrics methods local rather than invoking fallback", async () => {
    const { app, upstream } = fixture({ enabled: false });
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      expect((await app.request("/metrics", { method, headers: auth() })).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([false, true])("never forwards the ops bearer on other routes (enabled=%s)", async (enabled) => {
    const { app, upstream } = fixture({ enabled, preStaged: true });
    for (const path of ["/v1/sessions", "/metrics/unknown", "/metrics/"]) {
      const response = await app.request(path, { headers: auth() });
      expect(response.status).toBe(path.startsWith("/metrics/") ? 404 : 403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(TOKEN);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(protectedBearerVariants)("never forwards protected bearer variants: $label (enabled=$enabled)", async ({ enabled, authorization, scrapeStatus }) => {
    const { app, upstream } = fixture({ enabled, preStaged: true });
    const headers = { authorization };
    const response = await app.request("/v1/agents", { headers });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(TOKEN);
    // The separate scrape authenticator permits scheme case only: one ASCII space, no
    // alternate whitespace or combined credentials. A pre-staged token remains disabled.
    const metric = await app.request("/metrics", { headers });
    expect(metric.status).toBe(enabled ? scrapeStatus : 404);
    expect(metric.headers.get("cache-control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong-independent-token", TENANT_KEY, INTERNAL, ADMIN])("does not accept another authority for any metrics method (%s)", async (token) => {
    const { app, upstream } = fixture();
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await app.request("/metrics", { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain(token ?? "undefined");
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("ignores query credentials and never reflects or forwards metrics request values", async () => {
    const { app, upstream } = fixture();
    expect((await app.request(`/metrics?token=${TOKEN}`)).status).toBe(401);
    const response = await app.request(`/metrics?tenant=${PRIVATE}&token=${TOKEN}`, {
      headers: { ...auth(), "x-user-id": PRIVATE, "x-provider": PRIVATE },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const value of [TOKEN, INTERNAL, ADMIN, TENANT_KEY, PRIVATE]) expect(text).not.toContain(value);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("serves Prometheus text and protected HEAD without a scrape feedback loop or upstream request", async () => {
    const { app, upstream } = fixture();
    expect((await app.request("/healthz")).status).toBe(200);
    const first = await scrape(app);
    const response = await app.request("/metrics", { method: "HEAD", headers: auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(RUNTIME_METRICS_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
    expect(await scrape(app)).toBe(first);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("authenticates before local method denial for %s", async (method) => {
    const { app, upstream } = fixture();
    const response = await app.request("/metrics", { method, headers: auth() });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("counts concurrent ordinary responses with closed labels and no raw route data", async () => {
    const { app, upstream } = fixture({ ready: () => false });
    const responses = await Promise.all(Array.from({ length: 12 }, () => app.request("/healthz")));
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(200));
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request(`/unregistered/${PRIVATE}?key=${TOKEN}`, { method: "PROPFIND",
      headers: { authorization: `Bearer ${TENANT_KEY}`, "x-user-id": PRIVATE, "x-owner": PRIVATE } })).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
    const text = await scrape(app);
    const rows = samples(text);
    expect(rows.find((row) => row.labels.route === "health" && row.labels.status_class === "2xx")?.count).toBe(12);
    expect(rows.find((row) => row.labels.route === "ready" && row.labels.status_class === "5xx")?.count).toBe(1);
    expect(rows.find((row) => row.labels.route === "other" && row.labels.method === "other")?.count).toBe(1);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(14);
    for (const value of [PRIVATE, TOKEN, TENANT_KEY, "PROPFIND", "x-owner"]) expect(text).not.toContain(value);
    for (const row of rows) expect(Object.keys(row.labels).sort()).toEqual(["component", "method", "route", "status_class"]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("finishes the response-header metric while an upstream streaming body is still open", async () => {
    const { app, upstream } = fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    upstream.mockImplementation(async () => new Response(body, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }));
    let response: Response | undefined;
    try {
      response = await app.request("/v1/agents", { headers: { authorization: `Bearer ${TENANT_KEY}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.body).not.toBeNull();
      expect(cancelled).toBe(false);
      // No close(), body read, timer or network is needed to make these assertions pass.
      const text = await scrape(app);
      expect(samples(text).find((row) => row.labels.route === "agents" && row.labels.status_class === "2xx")?.count).toBe(1);
      expect(text).toContain('agent_service_http_handlers_in_progress{component="router",method="GET",route="agents"} 0');
      expect(text).toContain('agent_service_http_response_headers_duration_seconds_count{component="router",method="GET",route="agents",status_class="2xx"} 1');
      expect(cancelled).toBe(false);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      if (response?.body) await response.body.cancel();
      else await body.cancel();
    }
    expect(cancelled).toBe(true);
  });

  it("does not change ordinary error responses or expose a raw thrown error", async () => {
    const { app } = fixture({ ready: () => { throw new Error(PRIVATE); } });
    const response = await app.request("/readyz");
    expect(response.status).toBe(500);
    const text = await scrape(app);
    expect(samples(text).find((row) => row.labels.route === "ready" && row.labels.status_class === "5xx")?.count).toBe(1);
    expect(text).not.toContain(PRIVATE);
  });

  it("returns a fixed unavailable response only for a failing scrape renderer", async () => {
    const { app, metrics, upstream } = fixture();
    vi.spyOn(metrics, "render").mockImplementation(() => { throw new Error(PRIVATE); });
    const response = await app.request("/metrics", { headers: auth() });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(PRIVATE);
    expect((await app.request("/healthz")).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("leaves ordinary responses unchanged if metric observation itself throws", async () => {
    const { app, metrics, upstream } = fixture();
    vi.spyOn(metrics, "beginRequest").mockImplementation(() => { throw new Error(PRIVATE); });
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("preserves the ordinary response when its metric finish callback throws", async () => {
    const { app, metrics, upstream } = fixture();
    const finish = vi.fn((_status: number) => { throw new Error(PRIVATE); });
    vi.spyOn(metrics, "beginRequest").mockReturnValue(finish);
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(finish).toHaveBeenCalledExactlyOnceWith(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["", "short", "x".repeat(257), "invalid token with whitespace", "非ASCII-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"])("rejects invalid app metrics credentials (%s)", (token) => {
    const { deps, metrics } = fixture();
    expect(() => createRouterApp({ ...deps, metrics: { registry: metrics, bearerToken: token } })).toThrow();
  });

  it.each([INTERNAL, ADMIN])("rejects authority reuse in the direct app descriptor (%s)", (token) => {
    const { deps, metrics } = fixture();
    expect(() => createRouterApp({ ...deps, metrics: { registry: metrics, bearerToken: token } })).toThrow();
  });
});
