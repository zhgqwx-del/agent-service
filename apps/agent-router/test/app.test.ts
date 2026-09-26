import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@agent-service/protocol";
import { createRouterApp } from "../src/app.js";
import type { RunnerRegistry, RunnerTarget } from "../src/registry.js";

/**
 * Router behaviour without a cluster: a fake registry plus small upstream servers cover the routing and
 * proxying rules in milliseconds. The cluster tests then prove the same rules hold across real processes.
 */

const SID = "sess_019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
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

interface Upstream {
  url: string;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  state: { abortedResponses: number };
}

/** A stand-in runner. `reply` decides the status/headers/body per request. */
async function upstream(reply: (req: { path: string; method: string; body: string; n: number }) => { status?: number; headers?: Record<string, string>; body?: string } | "hang" | "drop"): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const state = { abortedResponses: 0 };
  const server = createServer((req, res) => {
    res.on("close", () => {
      if (!res.writableEnded) state.abortedResponses += 1;
    });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body });
      const out = reply({ path: req.url ?? "", method: req.method ?? "", body, n: requests.length });
      if (out === "hang") return; // never respond: exercises the header timeout
      if (out === "drop") return res.destroy(); // transport failure after the server received the request
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body ?? "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state };
}

function fakeRegistry(targets: string[], opts: { owner?: string; healthy?: (url: string) => boolean } = {}): RunnerRegistry {
  const list = (): RunnerTarget[] => targets.map((url) => ({ url, healthy: opts.healthy ? opts.healthy(url) : true, lastCheckMs: Date.now(), consecutiveFailures: 0 }));
  let rr = 0;
  const reg = {
    list,
    owner: async () => opts.owner,
    candidate: () => list().find((t) => t.healthy)?.url,
    anyHealthy: () => {
      const healthy = list().filter((t) => t.healthy);
      return healthy.length ? healthy[rr++ % healthy.length]!.url : undefined;
    },
    toUrl: (addr: string) => targets.find((t) => t.replace(/^https?:\/\//, "") === addr.replace(/^https?:\/\//, "")),
    routeableUrl: (addr: string) => list().find((t) => t.healthy && t.url.replace(/^https?:\/\//, "") === addr.replace(/^https?:\/\//, ""))?.url,
    markFailure: () => {},
    start: () => {},
    close: async () => {},
    waitForFirstProbe: async () => {},
  };
  return reg as unknown as RunnerRegistry;
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("session routing", () => {
  it("sends a session request to the runner the directory names as owner", async () => {
    const a = await upstream(() => ({ body: '{"who":"a"}' }));
    const b = await upstream(() => ({ body: '{"who":"b"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: b.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(await res.json()).toEqual({ who: "b" });
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it("re-routes exactly once on 409 + X-Owner and does not leak the header onward", async () => {
    const owner = await upstream(() => ({ body: '{"ok":true}' }));
    let wrongCalls = 0;
    const wrong = await upstream(() => {
      wrongCalls += 1;
      return { status: 409, headers: { "x-owner": owner.url.replace("http://", "") }, body: '{"error":{"code":"session_lease_conflict"}}' };
    });
    const app = createRouterApp({ registry: fakeRegistry([wrong.url, owner.url], { owner: wrong.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "hi" }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(wrongCalls).toBe(1);
    expect(owner.requests).toHaveLength(1);
    expect(owner.requests[0]!.body).toContain("hi"); // the body was replayed
    expect(res.headers.get("x-owner")).toBeNull();
  });

  it("gives up after one re-route instead of ping-ponging", async () => {
    // both runners insist the other one owns it
    const pair: Upstream[] = [];
    const a = await upstream(() => ({ status: 409, headers: { "x-owner": pair[1]!.url.replace("http://", "") }, body: "{}" }));
    const b = await upstream(() => ({ status: 409, headers: { "x-owner": pair[0]!.url.replace("http://", "") }, body: "{}" }));
    pair.push(a, b);
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: a.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(409);
    expect(a.requests.length + b.requests.length).toBe(2);
  });

  it("treats a non-canonical session id as unroutable and lets the runner reject it", async () => {
    // the same session id in a different case must not become "no session", which would scatter a
    // session's requests across runners while the runner still resolved them to one row
    const a = await upstream(() => ({ body: '{"who":"a"}' }));
    const b = await upstream(() => ({ body: '{"who":"b"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url], { owner: b.url }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID.toUpperCase()}/items`);
    expect(res.status).toBe(200);
    // routed as a non-session request (round-robin), NOT to the owner: the runner will 404 it
    expect(a.requests.length + b.requests.length).toBe(1);
  });
});

describe("request and response handling", () => {
  it("strips hop-by-hop request headers and forwards auth and idempotency", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    await app.request("/v1/agents", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer k", "x-user-id": "u1", "idempotency-key": "idem-1", connection: "keep-alive", te: "trailers" },
    });
    const got = a.requests[0]!.headers;
    expect(got.authorization).toBe("Bearer k");
    expect(got["x-user-id"]).toBe("u1");
    expect(got["idempotency-key"]).toBe("idem-1");
    expect(got.te).toBeUndefined();
  });

  it("preserves the query string and the method", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    await app.request(`/v1/sessions/${SID}/events?after=42&exclude=heartbeat`, { method: "GET" });
    expect(a.requests[0]!.path).toBe(`/v1/sessions/${SID}/events?after=42&exclude=heartbeat`);
    expect(a.requests[0]!.method).toBe("GET");
  });

  it("marks SSE responses unbuffered and streams them through", async () => {
    const a = await upstream(() => ({ headers: { "content-type": "text/event-stream" }, body: "event: turn/started\ndata: {}\n\n" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toContain("turn/started");
  });

  it("refuses a body larger than the limit before forwarding anything", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), maxBodyBytes: 1_000, logger: silent });
    const res = await app.request("/v1/agents", { method: "POST", body: "x".repeat(5_000) });
    // Match the runner's public error contract: invalid_request maps to HTTP 400.
    expect(res.status).toBe(400);
    expect(a.requests).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("only retries the idempotent turn POST after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([dead, alive.url], { owner: dead }), logger: silent });

    const noKey = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}" });
    expect(noKey.status).toBe(502);
    expect(alive.requests).toHaveLength(0); // a second turn must not be started

    const withKey = await app.request(`/v1/sessions/${SID}/turns`, { method: "POST", body: "{}", headers: { "idempotency-key": "k1" } });
    expect(withKey.status).toBe(200);
    expect(alive.requests).toHaveLength(1);

    // Arbitrary POST endpoints do not implement idempotency. A caller adding the same header must
    // not make agent/API-key/session creation replayable.
    const otherAlive = await upstream(() => ({ body: '{"ok":true}' }));
    const other = createRouterApp({ registry: fakeRegistry([dead, otherAlive.url]), logger: silent });
    const agentPost = await other.request("/v1/agents", { method: "POST", body: "{}", headers: { "idempotency-key": "k1" } });
    expect(agentPost.status).toBe(502);
    expect(otherAlive.requests).toHaveLength(0);
  });

  it("treats maxAttempts as the total number of upstream sends", async () => {
    const a = await upstream(() => "drop");
    const b = await upstream(() => "drop");
    const c = await upstream(() => ({ body: '{"shouldNot":"be reached"}' }));
    const app = createRouterApp({ registry: fakeRegistry([a.url, b.url, c.url], { owner: a.url }), maxAttempts: 2, logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(502);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(0);
  });

  it("retries a GET on another runner after a transport failure", async () => {
    const dead = "http://127.0.0.1:1";
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([dead, alive.url], { owner: dead }), logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    expect(res.status).toBe(200);
    expect(alive.requests).toHaveLength(1);
  });

  it("503s when no runner is healthy", async () => {
    const app = createRouterApp({ registry: fakeRegistry(["http://127.0.0.1:1"], { healthy: () => false }), logger: silent });
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(503);
  });

  it("times out waiting for upstream headers without cutting a streaming body", async () => {
    const hang = await upstream(() => "hang");
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([hang.url, alive.url], { owner: hang.url }), upstreamHeaderTimeoutMs: 200, logger: silent });
    const res = await app.request(`/v1/sessions/${SID}/items`);
    // a GET may be retried, so it lands on the healthy one
    expect([200, 502]).toContain(res.status);
  });

  it("aborts a timed-out upstream request and does not replay an unsafe POST", async () => {
    const hang = await upstream(() => "hang");
    const alive = await upstream(() => ({ body: '{"ok":true}' }));
    const app = createRouterApp({ registry: fakeRegistry([hang.url, alive.url]), upstreamHeaderTimeoutMs: 50, logger: silent });
    const res = await app.request("/v1/agents", { method: "POST", body: "{}", headers: { "idempotency-key": "not-supported-here" } });
    expect(res.status).toBe(502);
    expect(alive.requests).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(hang.state.abortedResponses).toBe(1);
  });
});

describe("operational endpoints", () => {
  it("hides /_router/targets unless an admin token is configured, then requires it", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    const off = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    expect((await off.request("/_router/targets")).status).toBe(404);

    const on = createRouterApp({ registry: fakeRegistry([a.url]), adminToken: "sekret", logger: silent });
    expect((await on.request("/_router/targets")).status).toBe(401);
    const ok = await on.request("/_router/targets", { headers: { authorization: "Bearer sekret" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { runners: unknown[] }).runners).toHaveLength(1);
  });

  it("reports not-ready while draining", async () => {
    const a = await upstream(() => ({ body: "{}" }));
    let ready = true;
    const app = createRouterApp({ registry: fakeRegistry([a.url]), ready: () => ready, logger: silent });
    expect((await app.request("/readyz")).status).toBe(200);
    ready = false;
    expect((await app.request("/readyz")).status).toBe(503);
    expect((await app.request("/healthz")).status).toBe(200); // liveness stays up while draining
  });

  it("answers capabilities from a runner rather than inventing them", async () => {
    const a = await upstream(() => ({ body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, service: "agent-runner", features: { streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, dynamicTools: true, mcp: ["streamable-http"], skills: true, sandbox: ["none"], byok: true } }) }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    const caps = (await (await app.request("/v1/capabilities")).json()) as { service: string; features: { skills: boolean; mcp: string[] } };
    expect(caps.service).toBe("agent-router");
    expect(caps.features.skills).toBe(true);
    expect(caps.features.mcp).toEqual(["streamable-http"]);
  });

  it("does not publish capabilities from a runner on an older protocol contract", async () => {
    const a = await upstream(() => ({ body: JSON.stringify({ protocolVersion: "2026-09-22", service: "agent-runner", features: { streaming: true, replay: { persistedEvents: true, hotWindowMs: 1 }, approvals: true, dynamicTools: true, mcp: ["streamable-http"], skills: true, sandbox: ["none"], byok: true } }) }));
    const app = createRouterApp({ registry: fakeRegistry([a.url]), logger: silent });
    const response = await app.request("/v1/capabilities");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "draining", retryable: true },
    });
  });
});
