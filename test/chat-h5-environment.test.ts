import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type OperationInput = { action: string; idempotencyKey: string };
type Controller = { status(): unknown | Promise<unknown>; act(input: OperationInput): unknown | Promise<unknown> };
type Proxy = { server: Server; url: string; close(): Promise<void> };
let chat: { createChatH5Server(options: { configPath: string; port: number; environmentController?: Controller }): Promise<Proxy> };
beforeAll(async () => {
  chat = await import(new URL("../scripts/ops/chat-h5.mjs", import.meta.url).href) as typeof chat;
});

const SECRET = "h5-environment-fixture-private-service-key";
const USER = "h5_environment_fixture_owner";
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SESSION = "sess_00000000-0000-7000-8000-000000000002";
const TURN = "turn_00000000-0000-7000-8000-000000000003";
const V4 = "00000000-0000-4000-8000-000000000001";
const V7 = "00000000-0000-7000-8000-000000000002";
const ACTIONS = ["start-services", "stop-services", "restart-services", "start-infrastructure", "stop-infrastructure", "restart-infrastructure"];
const LIMITS = { maxSteps: 6, maxToolCalls: 1, maxWallClockMs: 60_000, maxOutputTokensPerStep: 1024 };
const turnBody = () => ({ input: [{ type: "text", text: "合成环境边界测试，无模型请求" }], stream: false, busyPolicy: "reject", limits: { ...LIMITS } });
const turn = { id: TURN, sessionId: SESSION, status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 };
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
function memoryController() {
  const fixture = {
    value: { enabled: true, checkedAt: "2026-10-26T00:00:00.000Z", overall: "ready",
      components: [{ id: "owner", name: "OWNER", state: "ready", detail: "fixture" }],
      actions: ACTIONS.map(id => ({ id, label: id, enabled: true })), operation: null } as Json,
    calls: [] as OperationInput[], statusCalls: 0, statusError: null as unknown, actionError: null as unknown,
    controller: {} as Controller,
  };
  fixture.controller = {
    async status() {
      fixture.statusCalls++;
      if (fixture.statusError) throw fixture.statusError;
      return structuredClone(fixture.value);
    },
    async act(input) {
      fixture.calls.push(input);
      if (fixture.actionError) throw fixture.actionError;
      const operation = { id: input.idempotencyKey, action: input.action, state: "running", phase: "fixture",
        message: "合成管理操作", startedAt: "2026-10-26T00:00:00.000Z" };
      fixture.value.operation = operation;
      return { operation };
    },
  };
  return fixture;
}
type BrowserOptions = { body?: unknown; rawBody?: string; token?: boolean; origin?: string; headers?: Record<string, string> };
type BrowserResult = { status: number; headers: IncomingMessage["headers"]; text: string; body: unknown };
function browserRequest(origin: string, path: string, method: string, token: string, options: BrowserOptions = {}): Promise<BrowserResult> {
  const url = new URL(origin), payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((done, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: url.port, method, path, agent: false,
      headers: { Origin: options.origin ?? origin, ...(options.token === false ? {} : { "X-Chat-Token": token }),
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
        ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8"); let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        done({ status: response.statusCode ?? 0, headers: response.headers, text, body });
      });
    });
    outgoing.once("error", reject); outgoing.end(payload);
  });
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener missing");
  return `http://127.0.0.1:${address.port}`;
}
function trackSockets(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  };
}

/** In-memory controller and native fake router: no process, database, .env or provider mutation. */
async function fixture(controller?: Controller) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agent-chat-h5-environment-"))); await chmod(dir, 0o700);
  const requests: { method: string; path: string }[] = [], errors: unknown[] = [];
  const session = { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, status: { type: "idle" } };
  const upstream = createServer((incoming, response) => {
    void (async () => {
      for await (const chunk of incoming) { void chunk; }
      const path = incoming.url ?? "", url = new URL(path, "http://fixture");
      requests.push({ method: incoming.method ?? "", path });
      if (path === "/readyz") { json(response, 200, { ready: true }); return; }
      if (incoming.method === "POST" && path === "/v1/sessions") { json(response, 201, session); return; }
      if (incoming.method === "GET" && path === `/v1/sessions/${SESSION}`) { json(response, 200, session); return; }
      if (incoming.method === "GET" && url.pathname.endsWith("/events")) {
        const event = { type: "turn/completed", sessionId: SESSION, turnId: TURN, emittedAtMs: 2, seq: 2, turn, stopReason: "end_turn" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`id: 2\nevent: turn/completed\ndata: ${JSON.stringify(event)}\n\n`); return;
      }
      if (incoming.method === "GET") { json(response, 200, { data: [], nextCursor: null }); return; }
      if (incoming.method === "POST" && path.endsWith("/interrupt")) { json(response, 200, { status: "idle" }); return; }
      if (incoming.method === "POST" && path.endsWith("/turns")) { json(response, 202, { turn }); return; }
      json(response, 404, { error: "fixture_unknown_route" });
    })().catch(error => { errors.push(error); if (!response.headersSent) json(response, 500, { error: "fixture_failed" }); else response.destroy(); });
  });
  const closeUpstream = trackSockets(upstream), upstreamUrl = await listen(upstream);
  let proxy: Proxy | undefined, token = "";
  const f = {
    requests, errors,
    get url() { if (!proxy) throw new Error("proxy not started"); return proxy.url; },
    call(path: string, method = "GET", options: BrowserOptions = {}) { return browserRequest(f.url, path, method, token, options); },
    action(action = "start-services", key = V4, options: BrowserOptions = {}) {
      return f.call("/api/environment/actions", "POST", { body: { action }, ...options,
        headers: { "Idempotency-Key": key, ...options.headers } });
    },
    async close() { if (proxy) await proxy.close(); await closeUpstream(); await rm(dir, { recursive: true, force: true }); },
  };
  try {
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ BASE_URL: upstreamUrl, SERVICE_API_KEY: SECRET, USER_ID: USER,
      AGENT_ID: AGENT, AGENT_VERSION: "1", MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "1000", OPERATION_TIMEOUT_MS: "5000" }), { mode: 0o600 });
    proxy = await chat.createChatH5Server({ configPath, port: 0, environmentController: controller });
    const bootstrap = await f.call("/api/config", "GET", { token: false });
    expect(bootstrap.status).toBe(200); token = String((bootstrap.body as Json).csrfToken);
    return f;
  } catch (error) { await f.close(); throw error; }
}

describe("local H5 environment HTTP boundary", () => {
  it("serves its isolated panel script and reports an unconfigured manager without changing chat", async () => {
    const f = await fixture();
    try {
      const script = await f.call("/environment.js", "GET", { token: false });
      expect(script.status).toBe(200); expect(script.headers["content-type"]).toContain("javascript");
      const state = await f.call("/api/environment");
      expect(state.status).toBe(200); expect(state.body).toMatchObject({ enabled: false, overall: "unknown", actions: [], operation: null,
        components: [{ id: "owner", state: "unknown" }] });
      expect((state.body as Json).checkedAt).toEqual(expect.any(String));
      expect(f.requests).toEqual([]);
      expect((await f.action()).body).toEqual({ error: "environment_unavailable" });
      expect((await f.call("/api/sessions", "POST", { body: {} })).status).toBe(201);
      expect(state.text).not.toContain(SECRET); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps status reads read-only and returns the exact controller operation identifier", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (let count = 0; count < 3; count++) expect((await f.call("/api/environment")).body).toEqual(manager.value);
      expect(manager.statusCalls).toBe(3); expect(manager.calls).toEqual([]); expect(f.requests).toEqual([]);
      const accepted = await f.action("restart-services", V7);
      expect(accepted.status).toBe(202); expect(accepted.body).toMatchObject({ operation: { id: V7, action: "restart-services", state: "running" } });
      expect(manager.calls).toEqual([{ action: "restart-services", idempotencyKey: V7 }]);
      const resumed = await f.call("/api/environment");
      expect(resumed.body).toMatchObject({ operation: { id: V7, action: "restart-services" } });
      expect(manager.calls).toHaveLength(1); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("requires the existing CSRF token, local origin and exact Host before status or actions", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      const cases: BrowserOptions[] = [
        { token: false }, { headers: { "X-Chat-Token": "wrong" } }, { origin: "https://attacker.example" },
        { origin: "null" }, { headers: { Host: "localhost:58655" } }, { headers: { "Sec-Fetch-Site": "cross-site" } },
      ];
      for (const options of cases) {
        expect((await f.call("/api/environment", "GET", options)).status).toBe(403);
        expect((await f.action("stop-services", V4, options)).status).toBe(403);
      }
      expect(manager.statusCalls).toBe(0); expect(manager.calls).toEqual([]); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("closes environment paths to queries and incorrect HTTP methods", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const [path, method, status] of [
        ["/api/environment?refresh=1", "GET", 400], ["/api/environment/actions?action=stop-services", "POST", 400],
        ["/api/environment", "POST", 405], ["/api/environment", "PUT", 405],
        ["/api/environment/actions", "GET", 405], ["/api/environment/actions", "DELETE", 405],
        ["/api/environment/actions/stop-services", "POST", 404],
      ] as const) expect((await f.call(path, method, { body: { action: "stop-services" } })).status).toBe(status);
      expect(manager.statusCalls).toBe(0); expect(manager.calls).toEqual([]); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("accepts only the six fixed actions and UUID v4/v7 keys", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const [index, action] of ACTIONS.entries()) {
        const key = index % 2 === 0 ? V4 : V7;
        expect((await f.action(action, key)).status).toBe(202);
        expect(manager.calls.at(-1)).toEqual({ action, idempotencyKey: key });
      }
      expect(manager.calls).toHaveLength(6); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("rejects extra body keys, arbitrary targets, non-JSON and malformed keys before controller dispatch", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const body of [{}, [], null, { action: "shutdown" }, { action: ["stop-services"] },
        { action: "stop-services", pid: 123 }, { action: "stop-services", configPath: "/tmp/client.json" },
        { action: "stop-infrastructure", command: "rm -rf" }]) {
        const result = await f.action("stop-services", V4, { body });
        expect(result.status).toBe(400); expect(result.body).toEqual({ error: "invalid_action" });
      }
      for (const key of ["", "h5-any-string-key", "00000000-0000-1000-8000-000000000001", "00000000-0000-4000-0000-000000000001", `${V4},${V7}`]) {
        const result = await f.action("stop-services", key);
        expect(result.status).toBe(400); expect(result.body).toEqual({ error: "invalid_idempotency_key" });
      }
      expect((await f.call("/api/environment/actions", "POST", { body: { action: "stop-services" } })).body)
        .toEqual({ error: "invalid_idempotency_key" });
      expect((await f.action("stop-services", V4, { headers: { "Content-Type": "text/plain" } })).status).toBe(415);
      expect((await f.action("stop-services", V4, { rawBody: "{" })).body).toEqual({ error: "invalid_request" });
      expect(manager.calls).toEqual([]); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("maps controller failures to fixed safe codes and never returns raw errors", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const [code, status] of Object.entries({ invalid_action: 400, invalid_idempotency_key: 400, operation_conflict: 409,
        idempotency_conflict: 409, environment_not_ready: 409, environment_unavailable: 503, journal_unavailable: 503, controller_closed: 503 })) {
        manager.actionError = Object.assign(new Error(`private_path /tmp/not-public ${SECRET}`), { code, status: 200 });
        const result = await f.action();
        expect(result.status).toBe(status); expect(result.body).toEqual({ error: code });
        expect(result.text).not.toContain("private_path"); expect(result.text).not.toContain(SECRET);
      }
      manager.actionError = Object.assign(new Error("unrecognized private error"), { code: "private_secret_code", status: 418 });
      expect((await f.action()).body).toEqual({ error: "environment_unavailable" });
      manager.statusError = new Error("private_status_failure");
      const state = await f.call("/api/environment");
      expect(state.status).toBe(503); expect(state.body).toEqual({ error: "environment_unavailable" });
      expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it("blocks new session and turn writes during maintenance, unknown results and status failures", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const value of [
        { overall: "stopped", operation: null }, { overall: "partial", operation: null },
        { overall: "unknown", operation: null }, { overall: "transitioning", operation: null },
        { overall: "ready", operation: { state: "running" } }, { overall: "ready", operation: { state: "unknown" } },
        { overall: "ready", operation: { state: "invalid" } },
      ]) {
        manager.value = { ...manager.value, ...value };
        for (const [path, body, headers] of [
          ["/api/sessions", {}, {}], [`/api/sessions/${SESSION}/turns`, turnBody(), { "Idempotency-Key": "chat-maintenance-fixture" }],
        ] as const) {
          const result = await f.call(path, "POST", { body, headers });
          expect(result.status).toBe(503); expect(result.body).toEqual({ error: "environment_not_ready" });
        }
      }
      manager.statusError = new Error("cannot prove ready");
      expect((await f.call("/api/sessions", "POST", { body: {} })).body).toEqual({ error: "environment_not_ready" });
      expect(f.requests).toEqual([]); expect(manager.calls).toEqual([]);
    } finally { await f.close(); }
  });

  it("preserves history, SSE and interrupt access while maintenance status is unavailable", async () => {
    const manager = memoryController(); manager.statusError = new Error("manager unavailable during transition");
    const f = await fixture(manager.controller);
    try {
      for (const path of ["/api/sessions", `/api/sessions/${SESSION}`, `/api/sessions/${SESSION}/items?afterSeq=0&limit=200`,
        `/api/sessions/${SESSION}/turns?limit=20`, `/api/sessions/${SESSION}/turns/${TURN}`]) {
        expect((await f.call(path)).status).toBe(200);
      }
      const events = await f.call(`/api/sessions/${SESSION}/events?after=-1`);
      expect(events.status).toBe(200); expect(events.headers["content-type"]).toContain("text/event-stream");
      expect(events.text).toContain("event: turn/completed");
      const interrupt = await f.call(`/api/sessions/${SESSION}/turns/${TURN}/interrupt`, "POST", { body: {} });
      expect(interrupt.status).toBe(200);
      expect(f.requests.filter(value => value.method === "POST")).toEqual([{ method: "POST", path: `/v1/sessions/${SESSION}/turns/${TURN}/interrupt` }]);
      expect(manager.statusCalls).toBe(0); expect(manager.calls).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("permits new chat writes again when the manager proves ready after a terminal operation", async () => {
    const manager = memoryController(), f = await fixture(manager.controller);
    try {
      for (const state of ["succeeded", "failed"]) {
        manager.value.operation = { id: V4, action: "restart-services", state };
        expect((await f.call("/api/sessions", "POST", { body: {} })).status).toBe(201);
        expect((await f.call(`/api/sessions/${SESSION}/turns`, "POST", { body: turnBody(), headers: { "Idempotency-Key": `chat-ready-${state}` } })).status).toBe(202);
      }
      expect(f.requests.filter(value => value.method === "POST")).toHaveLength(4);
      expect(manager.statusCalls).toBe(4); expect(manager.calls).toEqual([]); expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});
