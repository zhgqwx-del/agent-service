import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type Proxy = { server: Server; url: string; close(): Promise<void> };
let chat: { createChatH5Server(options: { configPath: string; port: number }): Promise<Proxy> };
beforeAll(async () => {
  chat = await import(new URL("../scripts/ops/chat-h5.mjs", import.meta.url).href) as typeof chat;
});

const SECRET = "h5-fixture-service-key-never-in-browser";
const USER = "h5_fixture_owner";
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SESSION = "sess_00000000-0000-7000-8000-000000000002";
const TURN = "turn_00000000-0000-7000-8000-000000000003";
const LIMITS = { maxSteps: 6, maxToolCalls: 1, maxWallClockMs: 60_000, maxOutputTokensPerStep: 1024 };
function turnBody(text = "第一轮：项目代号青禾") {
  return { input: [{ type: "text", text }], stream: false, busyPolicy: "reject", limits: { ...LIMITS } };
}
function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body));
}
function config(baseUrl: string) {
  return { BASE_URL: baseUrl, SERVICE_API_KEY: SECRET, USER_ID: USER, AGENT_ID: AGENT, AGENT_VERSION: "1",
    MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "1000", OPERATION_TIMEOUT_MS: "5000" };
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

type Captured = { method: string; path: string; headers: IncomingMessage["headers"]; body?: Json };
type Hook = (request: IncomingMessage, response: ServerResponse, body: Json | undefined) => boolean | Promise<boolean>;
type BrowserResult = { status: number; headers: IncomingMessage["headers"]; text: string; body: unknown };
type BrowserOptions = { body?: unknown; rawBody?: string; token?: boolean; origin?: string | false; headers?: Record<string, string> };

/** Native HTTP deliberately preserves raw paths and Host headers for boundary tests. */
function browserRequest(origin: string, path: string, method: string, csrfToken: string, options: BrowserOptions = {}): Promise<BrowserResult> {
  const url = new URL(origin), payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((done, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: url.port, method, path, agent: false,
      headers: { ...(options.origin === false ? {} : { Origin: options.origin ?? origin }),
        ...(options.token === false ? {} : { "X-Chat-Token": csrfToken }),
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

/** The upstream is a deterministic HTTP service, with no runner, provider or ambient .env. */
async function fixture(hook?: Hook, start = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agent-chat-h5-"))); await chmod(dir, 0o700);
  const configPath = join(dir, "client.json"), requests: Captured[] = [], errors: unknown[] = [];
  const turns: Json[] = [], items: Json[] = [];
  const session = { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, title: "H5 fixture", status: { type: "idle" } };
  const upstream = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8"), body = text ? JSON.parse(text) as Json : undefined;
      const path = incoming.url ?? "", url = new URL(path, "http://fixture");
      requests.push({ method: incoming.method ?? "", path, headers: { ...incoming.headers }, body });
      if (hook && await hook(incoming, response, body)) return;
      if (url.pathname === "/readyz") { json(response, 200, { status: "ready" }); return; }
      if (incoming.headers.authorization !== `Bearer ${SECRET}` || incoming.headers["x-user-id"] !== USER) {
        json(response, 401, { error: "fixture_identity_rejected" }); return;
      }
      if (incoming.method === "POST" && path === "/v1/sessions") { json(response, 201, session); return; }
      if (incoming.method === "GET" && url.pathname === "/v1/sessions") { json(response, 200, { data: [session], nextCursor: null }); return; }
      if (incoming.method === "GET" && path === `/v1/sessions/${SESSION}`) { json(response, 200, session); return; }
      if (incoming.method === "POST" && path === `/v1/sessions/${SESSION}/turns`) {
        const id = `turn_00000000-0000-7000-8000-${String(turns.length + 3).padStart(12, "0")}`;
        const turn = { id, sessionId: SESSION, status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 };
        const input = body?.input as { type: string; text: string }[];
        const seq = items.length + 1, timestamp = 1_800_000_000_000 + seq;
        const itemBase = { sessionId: SESSION, turnId: id, status: "completed", createdAtMs: timestamp, completedAtMs: timestamp };
        items.push({ ...itemBase, id: `item_00000000-0000-7000-8000-${String(seq + 100).padStart(12, "0")}`,
          seq, type: "userMessage", content: input },
        { ...itemBase, id: `item_00000000-0000-7000-8000-${String(seq + 101).padStart(12, "0")}`,
          seq: seq + 1, type: "agentMessage", phase: "finalAnswer", text: `合成回答 ${turns.length + 1}` });
        turns.push(turn); json(response, 202, { turn }); return;
      }
      if (incoming.method === "GET" && url.pathname === `/v1/sessions/${SESSION}/items`) {
        const selected = items.filter(item => Number(item.seq) > Number(url.searchParams.get("afterSeq") ?? -1)
          && (!url.searchParams.has("turnId") || item.turnId === url.searchParams.get("turnId")))
          .slice(0, Number(url.searchParams.get("limit") ?? 200));
        json(response, 200, { data: selected }); return;
      }
      if (incoming.method === "GET" && url.pathname === `/v1/sessions/${SESSION}/turns`) {
        const offset = Number(url.searchParams.get("cursor")?.replace("fixture-turns-", "") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
        json(response, 200, { data: turns.slice(offset, offset + limit), nextCursor: offset + limit < turns.length ? `fixture-turns-${offset + limit}` : null }); return;
      }
      const turn = turns.find(value => path === `/v1/sessions/${SESSION}/turns/${String(value.id)}`);
      if (incoming.method === "GET" && turn) { json(response, 200, turn); return; }
      if (incoming.method === "POST" && path === `/v1/sessions/${SESSION}/turns/${TURN}/interrupt`) { json(response, 200, { status: "idle" }); return; }
      json(response, 404, { error: "fixture_unknown_route" });
    })().catch(error => { errors.push(error); if (!response.headersSent) json(response, 500, { error: "fixture_failed" }); else response.destroy(); });
  });
  const closeUpstream = trackSockets(upstream), upstreamUrl = await listen(upstream);
  const values = config(upstreamUrl); await writeFile(configPath, JSON.stringify(values), { mode: 0o600 });
  let proxy: Proxy | undefined, token = "";
  const f = { dir, configPath, values, upstreamUrl, requests, errors, turns, items, session,
    get url() { if (!proxy) throw new Error("proxy not started"); return proxy.url; },
    get server() { if (!proxy) throw new Error("proxy not started"); return proxy.server; },
    async start(path = configPath) {
      proxy = await chat.createChatH5Server({ configPath: path, port: 0 });
      const bootstrap = await browserRequest(proxy.url, "/api/config", "GET", "", { token: false });
      expect(bootstrap.status).toBe(200); token = String((bootstrap.body as Json).csrfToken);
      expect(token).not.toBe("undefined"); expect(token.length).toBeGreaterThanOrEqual(24); return proxy;
    },
    call(path: string, method = "GET", options: BrowserOptions = {}) { return browserRequest(f.url, path, method, token, options); },
    async close() { if (proxy) await proxy.close(); await closeUpstream(); await rm(dir, { recursive: true, force: true }); },
  };
  try { if (start) await f.start(); return f; } catch (error) { await f.close(); throw error; }
}

describe("local H5 chat HTTP boundary", () => {
  it.each(["file_mode", "parent_mode", "file_symlink", "ancestor_symlink", "hardlink", "invalid_config"] as const)
    ("rejects %s configuration before an upstream request", async fault => {
      const f = await fixture(undefined, false);
      try {
        let path = f.configPath;
        if (fault === "file_mode") await chmod(path, 0o644);
        if (fault === "parent_mode") await chmod(f.dir, 0o755);
        if (fault === "file_symlink") { const target = join(f.dir, "target.json"); await writeFile(target, JSON.stringify(f.values), { mode: 0o600 }); await rm(path); await symlink(target, path); }
        if (fault === "ancestor_symlink") { const alias = join(f.dir, "alias"); await symlink(f.dir, alias); path = join(alias, "client.json"); }
        if (fault === "hardlink") await link(path, join(f.dir, "linked.json"));
        if (fault === "invalid_config") await writeFile(path, JSON.stringify({ ...f.values, USER_ID: "wrong user" }), { mode: 0o600 });
        await expect(chat.createChatH5Server({ configPath: path, port: 0 })).rejects.toThrow();
        expect(f.requests).toHaveLength(0);
      } finally { await f.close(); }
    });

  it("serves a local page and public bootstrap without exposing its service credential", async () => {
    const f = await fixture();
    try {
      const address = f.server.address();
      expect(address && typeof address !== "string" && address.address).toBe("127.0.0.1");
      for (const path of ["/", "/api/config", "/api/health"]) {
        const response = await f.call(path);
        expect(response.status).toBe(200); expect(response.text).not.toContain(SECRET);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      }
      const page = await f.call("/"); expect(page.headers["content-type"]).toContain("text/html");
      const bootstrap = await f.call("/api/config");
      expect(bootstrap.headers["cache-control"]).toContain("no-store");
      expect(JSON.stringify(bootstrap.body)).not.toContain("SERVICE_API_KEY");
      expect(f.requests.some(value => value.path === "/readyz")).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("persists three turns in one session, restores items and forwards only the fixed identity", async () => {
    const f = await fixture();
    try {
      const created = await f.call("/api/sessions", "POST", { body: { title: "H5 三轮会话" } });
      expect(created.status).toBe(201); expect(created.body).toMatchObject({ id: SESSION });
      const creation = f.requests.find(value => value.method === "POST" && value.path === "/v1/sessions");
      expect(creation?.body).toEqual({ title: "H5 三轮会话", agentId: AGENT, agentVersion: 1 });
      for (const [index, text] of ["项目代号青禾", "更正为青禾二期", "最终项目代号是什么？"].entries()) {
        const response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", { body: turnBody(text), headers: { "Idempotency-Key": `h5-fixture-turn-${index}` } });
        expect(response.status).toBe(202); expect(response.body).toMatchObject({ turn: { sessionId: SESSION, status: "completed" } });
      }
      const history = await f.call(`/api/sessions/${SESSION}/items?afterSeq=0&limit=200`);
      expect(history.status).toBe(200); expect((history.body as { data: Json[] }).data).toHaveLength(6);
      expect((history.body as { data: Json[] }).data.filter(item => item.type === "userMessage").map(item => (item.content as { text: string }[])[0]?.text))
        .toEqual(["项目代号青禾", "更正为青禾二期", "最终项目代号是什么？"]);
      const pagePath = `/api/sessions/${SESSION}/items?afterSeq=2&limit=2`, page = await f.call(pagePath);
      expect(page.status).toBe(200); expect((page.body as { data: Json[] }).data.map(item => item.seq)).toEqual([3, 4]);
      expect(f.requests.at(-1)?.path).toBe(pagePath.replace("/api/", "/v1/"));
      const beginning = await f.call(`/api/sessions/${SESSION}/items?afterSeq=-1&limit=3`);
      expect((beginning.body as { data: Json[] }).data.map(item => item.seq)).toEqual([1, 2, 3]);
      const selected = await f.call(`/api/sessions/${SESSION}/items?turnId=${TURN}&afterSeq=1&limit=200`);
      expect((selected.body as { data: Json[] }).data.map(item => item.seq)).toEqual([2]);
      const firstTurns = await f.call(`/api/sessions/${SESSION}/turns?limit=1`);
      expect(firstTurns.body).toMatchObject({ data: [{ id: TURN }], nextCursor: "fixture-turns-1" });
      const nextPath = `/api/sessions/${SESSION}/turns?limit=1&cursor=fixture-turns-1`, next = await f.call(nextPath);
      expect((next.body as { data: Json[] }).data.map(turn => turn.id)).toEqual([f.turns[1]?.id]);
      expect(f.requests.at(-1)?.path).toBe(nextPath.replace("/api/", "/v1/"));
      for (const path of ["/api/sessions", `/api/sessions/${SESSION}`, `/api/sessions/${SESSION}/turns?limit=20`,
        `/api/sessions/${SESSION}/turns/${TURN}`, `/api/sessions/${SESSION}/items?turnId=${TURN}&limit=200`]) {
        expect((await f.call(path)).status).toBe(200);
      }
      const interruptPath = `/api/sessions/${SESSION}/turns/${TURN}/interrupt`;
      expect((await f.call(interruptPath, "POST", { body: {} })).status).toBe(200);
      expect(f.requests.at(-1)).toMatchObject({ method: "POST", path: interruptPath.replace("/api/", "/v1/"), body: {} });
      const submitted = f.requests.filter(value => value.method === "POST" && value.path.endsWith("/turns"));
      expect(submitted).toHaveLength(3);
      expect(submitted.map(value => value.headers["idempotency-key"])).toEqual(["h5-fixture-turn-0", "h5-fixture-turn-1", "h5-fixture-turn-2"]);
      expect(submitted.every(value => value.body?.stream === false && value.body.busyPolicy === "reject")).toBe(true);
      expect(submitted.every(value => JSON.stringify(value.body?.limits) === JSON.stringify(LIMITS))).toBe(true);
      expect(f.requests.filter(value => value.path.startsWith("/v1/")).every(value => value.headers.authorization === `Bearer ${SECRET}` && value.headers["x-user-id"] === USER)).toBe(true);
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not inherit browser authentication, owner, cookies or extra forwarding headers", async () => {
    const f = await fixture();
    try {
      const response = await f.call("/api/sessions", "GET", { headers: { Authorization: "Bearer browser-attacker", "X-User-Id": "other_user", Cookie: "auth=browser-secret", "X-Forwarded-For": "203.0.113.1" } });
      expect(response.status).toBe(200);
      const captured = f.requests.at(-1)!;
      expect(captured.headers.authorization).toBe(`Bearer ${SECRET}`); expect(captured.headers["x-user-id"]).toBe(USER);
      expect(captured.headers.cookie).toBeUndefined(); expect(captured.headers["x-forwarded-for"]).toBeUndefined();
      expect(captured.headers["x-chat-token"]).toBeUndefined(); expect(response.text).not.toContain(SECRET);
    } finally { await f.close(); }
  });

  it.each(["id", "userId", "agentId", "agentVersion"] as const)
    ("prevents turn and interrupt dispatch when restored session %s does not match the configured profile", async field => {
      const f = await fixture((incoming, response) => {
        if (incoming.method !== "GET" || incoming.url !== `/v1/sessions/${SESSION}`) return false;
        const session: Json = { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, status: { type: "idle" } };
        session[field] = field === "agentVersion" ? 2 : "another_identity";
        json(response, 200, session); return true;
      });
      try {
        const response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", { body: turnBody(), headers: { "Idempotency-Key": "h5-wrong-session-profile" } });
        expect(response.status).toBe(409); expect(response.body).toEqual({ error: "session_profile_mismatch" });
        expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
        expect(f.requests.filter(value => value.path === `/v1/sessions/${SESSION}`)).toHaveLength(1);
        const interrupt = await f.call(`/api/sessions/${SESSION}/turns/${TURN}/interrupt`, "POST", { body: {} });
        expect(interrupt.status).toBe(409); expect(interrupt.body).toEqual({ error: "session_profile_mismatch" });
        expect(f.requests.filter(value => value.method === "POST")).toHaveLength(0);
      } finally { await f.close(); }
    });

  it("rejects missing tokens, foreign origins and rebinding Host values before proxying", async () => {
    const f = await fixture();
    try {
      const cases: BrowserOptions[] = [
        { token: false }, { headers: { "X-Chat-Token": "incorrect" } }, { origin: "https://attacker.example" },
        { origin: "null" }, { headers: { Host: "attacker.example" } }, { headers: { Host: "localhost:58655" } },
        { headers: { Host: "127.0.0.1:1" } }, { headers: { Host: "127.0.0.1.attacker.example" } },
      ];
      for (const options of cases) {
        const before = f.requests.length, response = await f.call("/api/sessions", "GET", options);
        expect(response.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined(); expect(response.text).not.toContain(SECRET);
      }
      const bootstrap = await f.call("/api/config", "GET", { token: false, origin: "https://attacker.example" });
      expect(bootstrap.status).toBeGreaterThanOrEqual(400); expect(bootstrap.text).not.toContain("csrfToken");
      const preflight = await f.call("/api/sessions", "OPTIONS", { origin: "https://attacker.example" });
      expect(preflight.status).toBeGreaterThanOrEqual(400); expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    } finally { await f.close(); }
  });

  it("closes the route and query surface to management, traversal, deletion and arbitrary targets", async () => {
    const f = await fixture();
    try {
      const paths = ["/api/agents", "/api/keys", "/api/admin", "/api/proxy?url=http://attacker.example", "/v1/sessions",
        "/api/sessions/../agents", "/api/sessions/%2e%2e/agents", "/api/sessions/%252e%252e/agents", "/api/sessions/%2f%2fattacker.example",
        `/api/sessions/${SESSION}/events`, `/api/sessions/${SESSION}/items?userId=other_user`, `/api/sessions/${SESSION}/items?limit=0`,
        `/api/sessions/${SESSION}/items?limit=201`, `/api/sessions/${SESSION}/items?afterSeq=-2`, `/api/sessions/${SESSION}/items?afterSeq=1.5`,
        `/api/sessions/${SESSION}/items?turnId=../../keys`, `/api/sessions/${SESSION}/items?limit=1&limit=2`,
        `/api/sessions/${SESSION}/turns?exclude=heartbeat`, `/api/sessions/${SESSION}/turns?limit=0`,
        `/api/sessions/${SESSION}/turns?limit=201`, `/api/sessions/${SESSION}/turns?cursor=a&cursor=b`,
        `/api/sessions/${SESSION}?userId=other_user`, "/api/sessions?userId=other_user", "/api/config?url=http://attacker.example"];
      for (const path of paths) {
        const before = f.requests.length, response = await f.call(path);
        expect(response.status, path).toBeGreaterThanOrEqual(400); expect(f.requests, path).toHaveLength(before);
      }
      for (const method of ["DELETE", "PATCH", "PUT"]) {
        const before = f.requests.length, response = await f.call(`/api/sessions/${SESSION}`, method, { body: {} });
        expect(response.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
      }
      const before = f.requests.length, oldInterrupt = await f.call(`/api/sessions/${SESSION}/interrupt`, "POST", { body: {} });
      expect(oldInterrupt.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
    } finally { await f.close(); }
  });

  it("rejects identity or tool authority, altered budgets and malformed submissions before any dispatch", async () => {
    const f = await fixture();
    try {
      const sessionBodies = [{ agentId: AGENT }, { agentVersion: 2 }, { userId: USER }, { metadata: { tools: true } }, { title: 1 }, { title: "x".repeat(257) }];
      for (const body of sessionBodies) {
        const before = f.requests.length, response = await f.call("/api/sessions", "POST", { body });
        expect(response.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
      }
      const valid = turnBody(), turnBodies: unknown[] = [
        { ...valid, stream: "true" }, { ...valid, busyPolicy: "steer" }, { ...valid, limits: { ...LIMITS, maxSteps: 7 } },
        { ...valid, limits: { ...LIMITS, maxToolCalls: 2 } }, { ...valid, limits: { ...LIMITS, maxWallClockMs: 60_001 } },
        { ...valid, limits: { ...LIMITS, maxOutputTokensPerStep: 1025 } }, { ...valid, limits: { ...LIMITS, maxCostCNY: 1 } },
        { ...valid, dynamicTools: [] }, { ...valid, skillOverrides: {} }, { ...valid, model: { modelId: "other" } },
        { ...valid, metadata: {} }, { ...valid, userId: "other_user" }, { ...valid, input: [{ type: "text", text: "" }] },
        { ...valid, input: [{ type: "image", url: "https://attacker.example" }] }, { ...valid, input: [{ type: "text", text: "x", userId: USER }] },
        { input: valid.input }, null, [],
      ];
      for (const body of turnBodies) {
        const before = f.requests.length, response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", { body, headers: { "Idempotency-Key": "h5-rejected-input" } });
        expect(response.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
      }
      const invalidWire: BrowserOptions[] = [{ body: valid }, { rawBody: "{invalid", headers: { "Idempotency-Key": "h5-malformed-json" } },
        { body: valid, headers: { "Idempotency-Key": "h5-wrong-content-type", "Content-Type": "text/plain" } }];
      for (const options of invalidWire) {
        const before = f.requests.length, response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", options);
        expect(response.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
      }
      const before = f.requests.length, interrupt = await f.call(`/api/sessions/${SESSION}/turns/${TURN}/interrupt`, "POST", { body: { expectedTurnId: TURN } });
      expect(interrupt.status).toBeGreaterThanOrEqual(400); expect(f.requests).toHaveLength(before);
    } finally { await f.close(); }
  });

  it("redacts reflected service keys and returns only a generic upstream HTTP rejection", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.url === "/v1/sessions") {
        if (incoming.method === "GET") json(response, 200, { data: [], reflection: SECRET, [SECRET]: SECRET }, { "X-Upstream-Secret": SECRET });
        else json(response, 409, { error: SECRET, stack: "private upstream detail" }, { "X-Upstream-Secret": SECRET });
        return true;
      }
      return false;
    });
    try {
      const reflected = await f.call("/api/sessions");
      expect(reflected.status).toBe(200); expect(reflected.text).not.toContain(SECRET); expect(JSON.stringify(reflected.headers)).not.toContain(SECRET);
      const rejected = await f.call("/api/sessions", "POST", { body: {} });
      expect(rejected.status).toBeGreaterThanOrEqual(400); expect(rejected.body).toEqual({ error: "upstream_rejected", status: 409 });
      expect(rejected.text).not.toContain("private upstream detail"); expect(rejected.text).not.toContain(SECRET);
      expect(JSON.stringify(rejected.headers)).not.toContain(SECRET);
    } finally { await f.close(); }
  });

  it("does not follow upstream redirects or forward its identity to another origin", async () => {
    const redirected: IncomingMessage["headers"][] = [];
    const destination = createServer((incoming, response) => { redirected.push(incoming.headers); json(response, 200, {}); });
    const closeDestination = trackSockets(destination), destinationUrl = await listen(destination);
    const f = await fixture((incoming, response) => {
      if (incoming.url !== "/v1/sessions") return false;
      json(response, 307, { error: SECRET }, { Location: `${destinationUrl}/credential-sink` }); return true;
    });
    try {
      const response = await f.call("/api/sessions", "POST", { body: {} });
      expect(response.status).toBeGreaterThanOrEqual(400); expect(response.body).toEqual({ error: "upstream_rejected", status: 307 });
      expect(redirected).toHaveLength(0); expect(response.text).not.toContain(SECRET);
      expect(response.headers.location).toBeUndefined();
      expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
    } finally { await f.close(); await closeDestination(); }
  });

  it("accepts the real router's plain text readiness response", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.url !== "/readyz") return false;
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); response.end("ready (1 runners)"); return true;
    });
    try { expect((await f.call("/api/health")).body).toEqual({ ready: true }); }
    finally { await f.close(); }
  });

  it.each(["disconnect", "http_rejection"] as const)("identifies %s before turn dispatch as not submitted", async fault => {
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "GET" || incoming.url !== `/v1/sessions/${SESSION}`) return false;
      if (fault === "disconnect") response.destroy(); else json(response, 503, { error: "fixture_unavailable" });
      return true;
    });
    try {
      const response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", {
        body: turnBody(), headers: { "Idempotency-Key": "h5-preflight-failure" },
      });
      expect(response.status).toBe(503); expect(response.body).toEqual({ error: "turn_not_submitted" });
      expect(f.requests.some(value => value.method === "POST")).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps a failure returned after POST distinct from a pre-dispatch failure", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || !incoming.url?.endsWith("/turns")) return false;
      json(response, 503, { error: "fixture_failed_after_dispatch" }); return true;
    });
    try {
      const response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", {
        body: turnBody(), headers: { "Idempotency-Key": "h5-post-failure" },
      });
      expect(response.status).toBe(503); expect(response.body).toEqual({ error: "upstream_rejected", status: 503 });
      expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("reports an uncertain POST outcome once and never retries a disconnected upstream", async () => {
    let submissions = 0;
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || !incoming.url?.endsWith("/turns")) return false;
      submissions++; response.destroy(new Error(`private failure ${SECRET}`)); return true;
    });
    try {
      const response = await f.call(`/api/sessions/${SESSION}/turns`, "POST", { body: turnBody(), headers: { "Idempotency-Key": "h5-unknown-outcome" } });
      expect(response.status).toBeGreaterThanOrEqual(400); expect(response.body).toEqual({ error: "upstream_outcome_unknown" });
      expect(response.text).not.toContain(SECRET); expect(response.text).not.toContain("private failure");
      expect((await f.call(`/api/sessions/${SESSION}/turns`)).status).toBe(200); expect(submissions).toBe(1);
      expect(f.requests.filter(value => value.method === "POST" && value.path.endsWith("/turns"))).toHaveLength(1);
    } finally { await f.close(); }
  });
});
