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
let chat: { createChatH5Server(options: { configPath: string; port: number; environmentController: Controller }): Promise<Proxy> };
beforeAll(async () => {
  chat = await import(new URL("../scripts/ops/chat-h5.mjs", import.meta.url).href) as typeof chat;
});

const SECRET = "h5-maintenance-race-fixture-private-key";
const USER = "h5_maintenance_race_owner";
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SESSION = "sess_00000000-0000-7000-8000-000000000002";
const TURN = "turn_00000000-0000-7000-8000-000000000003";
const ITEM = "item_00000000-0000-7000-8000-000000000004";
const ACTION_KEY = "00000000-0000-4000-8000-000000000005";
const TURN_PATH = `/api/sessions/${SESSION}/turns`;
const LIMITS = { maxSteps: 6, maxToolCalls: 1, maxWallClockMs: 60_000, maxOutputTokensPerStep: 1024 };
const turn = { id: TURN, sessionId: SESSION, status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 };
const turnBody = (stream = false) => ({ input: [{ type: "text", text: "合成维护并发测试，无模型请求" }], stream, busyPolicy: "reject", limits: { ...LIMITS } });
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
function frame(value: Json) {
  return `${value.seq === undefined ? "" : `id: ${String(value.seq)}\n`}event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`;
}
const terminal = () => frame({ type: "turn/completed", sessionId: SESSION, emittedAtMs: 2, seq: 2, turn, stopReason: "end_turn" });
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function gate() { return { entered: deferred<void>(), release: deferred<void>() }; }
type Gate = ReturnType<typeof gate>;
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 3000); })]); }
  finally { clearTimeout(timer); }
}
function memoryController() {
  const manager = { calls: [] as OperationInput[], admission: null as Gate | null,
    value: { enabled: true, checkedAt: "2026-10-26T00:00:00.000Z", overall: "ready", components: [], actions: [], operation: null } as Json,
    controller: {} as Controller };
  manager.controller = {
    async status() { return structuredClone(manager.value); },
    async act(input) {
      manager.calls.push(input);
      const admission = manager.admission;
      if (admission) { admission.entered.resolve(); await admission.release.promise; }
      const operation = { id: input.idempotencyKey, action: input.action, state: "running", phase: "accepted",
        message: "合成维护操作", startedAt: "2026-10-26T00:00:00.000Z" };
      manager.value = { ...manager.value, overall: "transitioning", operation };
      return { operation };
    },
  };
  return manager;
}
type BrowserResult = { status: number; headers: IncomingMessage["headers"]; text: string; body: unknown };
type BrowserOptions = { body?: unknown; headers?: Record<string, string> };
function observe(origin: string, path: string, method: string, token: string, options: BrowserOptions = {}) {
  const url = new URL(origin), payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const received = deferred<void>(), finished = deferred<BrowserResult>(), chunks: Buffer[] = [];
  const outgoing = request({ hostname: "127.0.0.1", port: url.port, method, path, agent: false,
    headers: { Origin: origin, "X-Chat-Token": token,
      ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
      ...options.headers } }, response => {
    response.on("data", chunk => { chunks.push(Buffer.from(chunk)); received.resolve(); });
    response.once("error", error => finished.resolve({ status: response.statusCode ?? 0, headers: response.headers, text: String(error), body: undefined }));
    response.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8"); let body: unknown;
      try { body = JSON.parse(text); } catch { body = undefined; }
      finished.resolve({ status: response.statusCode ?? 0, headers: response.headers, text, body });
    });
  });
  outgoing.once("error", error => finished.resolve({ status: 0, headers: {}, text: String(error), body: undefined })); outgoing.end(payload);
  return { received: received.promise, done: finished.promise, text: () => Buffer.concat(chunks).toString("utf8"), close: () => outgoing.destroy() };
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

/** Explicit gates expose each admission race without processes, DB, .env or provider calls. */
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agent-chat-h5-maintenance-race-"))); await chmod(dir, 0o700);
  const manager = memoryController(), requests: { method: string; path: string }[] = [], errors: unknown[] = [];
  const gates = { create: null as Gate | null, preflight: null as Gate | null, stream: null as Gate | null };
  const session = { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, status: { type: "idle" } };
  const upstream = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8"), body = raw ? JSON.parse(raw) as Json : undefined;
      const path = incoming.url ?? "", url = new URL(path, "http://fixture");
      requests.push({ method: incoming.method ?? "", path });
      if (incoming.method === "POST" && path === "/v1/sessions") {
        if (gates.create) { gates.create.entered.resolve(); await gates.create.release.promise; }
        json(response, 201, session); return;
      }
      if (incoming.method === "GET" && path === `/v1/sessions/${SESSION}`) {
        if (gates.preflight) { gates.preflight.entered.resolve(); await gates.preflight.release.promise; }
        json(response, 200, session); return;
      }
      if (incoming.method === "POST" && path === TURN_PATH.replace("/api/", "/v1/")) {
        if (!body?.stream) { json(response, 202, { turn }); return; }
        response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
        response.write(frame({ type: "item/agentMessage/delta", sessionId: SESSION, emittedAtMs: 1,
          turnId: TURN, itemId: ITEM, delta: "正在生成的合成片段。".repeat(30) }));
        if (gates.stream) { gates.stream.entered.resolve(); await gates.stream.release.promise; }
        response.end(terminal()); return;
      }
      if (incoming.method === "GET" && url.pathname.endsWith("/events")) {
        response.writeHead(200, { "content-type": "text/event-stream" }); response.end(terminal()); return;
      }
      if (incoming.method === "GET") { json(response, 200, { data: [], nextCursor: null }); return; }
      if (incoming.method === "POST" && path.endsWith("/interrupt")) { json(response, 200, { status: "idle" }); return; }
      json(response, 404, { error: "fixture_unknown_route" });
    })().catch(error => { errors.push(error); if (!response.headersSent) json(response, 500, { error: "fixture_failed" }); else response.destroy(); });
  });
  const closeUpstream = trackSockets(upstream), upstreamUrl = await listen(upstream);
  let proxy: Proxy | undefined, token = "";
  const f = {
    manager, gates, requests, errors,
    get url() { if (!proxy) throw new Error("proxy not started"); return proxy.url; },
    observe(path: string, method = "GET", options: BrowserOptions = {}) { return observe(f.url, path, method, token, options); },
    call(path: string, method = "GET", options: BrowserOptions = {}) { return deadline(f.observe(path, method, options).done, "fixture HTTP request did not finish"); },
    action() { return f.call("/api/environment/actions", "POST", { body: { action: "stop-services" }, headers: { "Idempotency-Key": ACTION_KEY } }); },
    async close() {
      for (const pending of [...Object.values(gates), manager.admission]) pending?.release.resolve();
      if (proxy) await proxy.close(); await closeUpstream(); await rm(dir, { recursive: true, force: true });
    },
  };
  try {
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ BASE_URL: upstreamUrl, SERVICE_API_KEY: SECRET, USER_ID: USER,
      AGENT_ID: AGENT, AGENT_VERSION: "1", MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "5000", OPERATION_TIMEOUT_MS: "10000" }), { mode: 0o600 });
    proxy = await chat.createChatH5Server({ configPath, port: 0, environmentController: manager.controller });
    const bootstrap = await f.call("/api/config");
    expect(bootstrap.status).toBe(200); token = String((bootstrap.body as Json).csrfToken);
    return f;
  } catch (error) { await f.close(); throw error; }
}

async function expectReadAndInterruptAvailable(f: Awaited<ReturnType<typeof fixture>>) {
  expect((await f.call(`/api/sessions/${SESSION}/items?afterSeq=0&limit=200`)).status).toBe(200);
  const stream = await f.call(`/api/sessions/${SESSION}/events?after=-1`);
  expect(stream.status).toBe(200); expect(stream.text).toContain("event: turn/completed");
  expect((await f.call(`/api/sessions/${SESSION}/turns/${TURN}/interrupt`, "POST", { body: {} })).status).toBe(200);
}

describe("H5 maintenance admission races", () => {
  it("rejects control actions while session creation is in flight and releases the writer count afterward", async () => {
    const f = await fixture(); f.gates.create = gate();
    const creating = f.observe("/api/sessions", "POST", { body: {} });
    try {
      await deadline(f.gates.create.entered.promise, "session write did not reach its gate");
      const blocked = await f.action();
      expect(blocked.status).toBe(409); expect(blocked.body).toEqual({ error: "operation_conflict" });
      expect(f.manager.calls).toEqual([]);
      f.gates.create.release.resolve();
      expect((await deadline(creating.done, "session creation did not finish")).status).toBe(201);
      expect((await f.action()).status).toBe(202); expect(f.manager.calls).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally { creating.close(); await f.close(); }
  });

  it("covers the delayed turn preflight and live SSE lifetime without blocking reads or interrupt", async () => {
    const f = await fixture(); f.gates.preflight = gate(); f.gates.stream = gate();
    const streaming = f.observe(TURN_PATH, "POST", { body: turnBody(true), headers: { "Idempotency-Key": "maintenance-race-stream" } });
    try {
      await deadline(f.gates.preflight.entered.promise, "turn preflight did not reach its gate");
      const beforePost = await f.action();
      expect(beforePost.status).toBe(409); expect(beforePost.body).toEqual({ error: "operation_conflict" });
      expect(f.requests.some(value => value.method === "POST" && value.path.endsWith("/turns"))).toBe(false);
      f.gates.preflight.release.resolve();
      await deadline(f.gates.stream.entered.promise, "turn stream did not open");
      await deadline(streaming.received, "live delta did not reach the browser");
      expect(streaming.text()).toContain("item/agentMessage/delta");
      const duringStream = await f.action();
      expect(duringStream.status).toBe(409); expect(duringStream.body).toEqual({ error: "operation_conflict" });
      expect(f.manager.calls).toEqual([]);
      await expectReadAndInterruptAvailable(f);
      f.gates.stream.release.resolve();
      const completed = await deadline(streaming.done, "turn stream did not finish");
      expect(completed.status).toBe(200); expect(completed.text).toContain("event: turn/completed");
      expect((await f.action()).status).toBe(202); expect(f.manager.calls).toHaveLength(1);
      expect(f.errors).toEqual([]);
    } finally { streaming.close(); await f.close(); }
  });

  it("latches action admission before manager acceptance and keeps later running operations closed to chat writes", async () => {
    const f = await fixture(); f.manager.admission = gate();
    const accepting = f.observe("/api/environment/actions", "POST", { body: { action: "stop-services" }, headers: { "Idempotency-Key": ACTION_KEY } });
    try {
      await deadline(f.manager.admission.entered.promise, "manager admission did not reach its gate");
      // The fake manager intentionally still reports ready/null until it accepts.
      expect(f.manager.value).toMatchObject({ overall: "ready", operation: null });
      const assertClosed = async () => {
        const writes: { path: string; body: unknown; headers?: Record<string, string> }[] = [
          { path: "/api/sessions", body: {} },
          { path: TURN_PATH, body: turnBody(), headers: { "Idempotency-Key": "maintenance-race-submit" } },
        ];
        for (const { path, body, headers } of writes) {
          const result = await f.call(path, "POST", { body, headers });
          expect(result.status).toBe(503); expect(result.body).toEqual({ error: "environment_not_ready" });
        }
        expect(f.requests.filter(value => value.method === "POST" && !value.path.endsWith("/interrupt"))).toEqual([]);
      };
      await assertClosed();
      await expectReadAndInterruptAvailable(f);
      f.manager.admission.release.resolve();
      const accepted = await deadline(accepting.done, "manager acceptance did not finish");
      expect(accepted.status).toBe(202); expect(accepted.body).toMatchObject({ operation: { id: ACTION_KEY, state: "running" } });
      await assertClosed();
      expect(f.manager.calls).toHaveLength(1);
      f.manager.value = { ...f.manager.value, overall: "ready", operation: { id: ACTION_KEY, action: "stop-services", state: "succeeded" } };
      expect((await f.call("/api/sessions", "POST", { body: {} })).status).toBe(201);
      expect(f.errors).toEqual([]);
    } finally { accepting.close(); await f.close(); }
  });
});
