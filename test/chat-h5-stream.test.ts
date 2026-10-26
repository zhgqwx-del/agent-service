import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

const SECRET = "h5-stream-fixture-key-never-in-browser";
const USER = "h5_stream_fixture_owner";
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SESSION = "sess_00000000-0000-7000-8000-000000000002";
const TURN = "turn_00000000-0000-7000-8000-000000000003";
const ITEM = "item_00000000-0000-7000-8000-000000000004";
const LIMITS = { maxSteps: 6, maxToolCalls: 1, maxWallClockMs: 60_000, maxOutputTokensPerStep: 1024 };
const TURN_PATH = `/api/sessions/${SESSION}/turns`;
const UPSTREAM_TURN_PATH = TURN_PATH.replace("/api/", "/v1/");
const turn = { id: TURN, sessionId: SESSION, status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 };
const turnBody = () => ({ input: [{ type: "text", text: "合成流式测试，无模型请求" }], stream: true, busyPolicy: "reject", limits: { ...LIMITS } });
const delta = (text: string): Json => ({ type: "item/agentMessage/delta", sessionId: SESSION, emittedAtMs: 1,
  turnId: TURN, itemId: ITEM, delta: text });
const terminal = (): Json => ({ type: "turn/completed", sessionId: SESSION, emittedAtMs: 2, seq: 2, turn, stopReason: "end_turn" });
function frame(value: Json, newline = "\n") {
  return `${value.seq === undefined ? "" : `id: ${String(value.seq)}${newline}`}event: ${String(value.type)}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
}
function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(value));
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>, label: string, milliseconds = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function listen(server: Server) {
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
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
type BrowserOptions = { body?: unknown; token?: boolean; origin?: string; headers?: Record<string, string> };
type BrowserResult = { status: number; headers: IncomingMessage["headers"]; text: string; ended: boolean };
/** Record bytes on arrival; tests can await a delta while the upstream terminal frame is gated. */
function observe(origin: string, path: string, method: string, token: string, options: BrowserOptions = {}) {
  const address = new URL(origin), payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const opened = deferred<{ status: number; headers: IncomingMessage["headers"] }>();
  const done = deferred<BrowserResult>(), chunks: Buffer[] = [], changed = new Set<() => void>();
  let incoming: IncomingMessage | undefined, status = 0, headers: IncomingMessage["headers"] = {}, settled = false;
  const text = () => Buffer.concat(chunks).toString("utf8");
  const finish = (ended: boolean) => {
    if (settled) return; settled = true;
    done.resolve({ status, headers, text: text(), ended });
    for (const notify of changed) notify();
  };
  const outgoing = request({ hostname: "127.0.0.1", port: address.port, method, path, agent: false,
    headers: { Origin: options.origin ?? origin, ...(options.token === false ? {} : { "X-Chat-Token": token }),
      ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
      ...options.headers } }, response => {
    incoming = response; status = response.statusCode ?? 0; headers = response.headers; opened.resolve({ status, headers });
    response.on("data", chunk => { chunks.push(Buffer.from(chunk)); for (const notify of changed) notify(); });
    response.once("end", () => finish(true)); response.once("aborted", () => finish(false));
    response.once("error", () => finish(false)); response.once("close", () => { if (!response.complete) finish(false); });
  });
  outgoing.once("error", () => { opened.resolve({ status, headers }); finish(false); }); outgoing.end(payload);
  return { opened: opened.promise, done: done.promise, text,
    async until(predicate: (value: string) => boolean) {
      if (predicate(text())) return;
      const arrived = deferred<void>();
      const notify = () => { if (predicate(text())) arrived.resolve(); };
      changed.add(notify);
      try { await deadline(arrived.promise, "expected SSE bytes were not delivered before the terminal gate"); }
      finally { changed.delete(notify); }
    },
    close() { incoming?.destroy(); outgoing.destroy(); },
  };
}
function parseFrames(text: string) {
  return text.replaceAll("\r\n", "\n").split("\n\n").filter(part => part.split("\n").some(line => line.startsWith("data:"))).map(part => {
    const lines = part.split("\n"), get = (name: string) => lines.filter(line => line.startsWith(`${name}:`)).map(line => line.slice(name.length + 1).trimStart());
    return { id: get("id")[0], event: get("event")[0], data: JSON.parse(get("data").join("\n")) as Json };
  });
}
type Captured = { method: string; path: string; headers: IncomingMessage["headers"]; body?: Json };
type Hook = (incoming: IncomingMessage, response: ServerResponse, body: Json | undefined) => boolean | Promise<boolean>;
/** No runner, database, ambient .env or provider is involved in these HTTP fixtures. */
async function fixture(hook: Hook) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agent-chat-h5-stream-"))); await chmod(dir, 0o700);
  const configPath = join(dir, "client.json"), requests: Captured[] = [], errors: unknown[] = [];
  const session: Json = { id: SESSION, userId: USER, agentId: AGENT, agentVersion: 1, status: { type: "idle" } };
  const upstream = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8"), body = raw ? JSON.parse(raw) as Json : undefined;
      requests.push({ method: incoming.method ?? "", path: incoming.url ?? "", headers: { ...incoming.headers }, body });
      if (incoming.headers.authorization !== `Bearer ${SECRET}` || incoming.headers["x-user-id"] !== USER) {
        json(response, 401, { error: "fixture_identity_rejected" }); return;
      }
      if (await hook(incoming, response, body)) return;
      if (incoming.method === "GET" && incoming.url === `/v1/sessions/${SESSION}`) { json(response, 200, session); return; }
      json(response, 404, { error: "fixture_unknown_route" });
    })().catch(error => { errors.push(error); if (!response.headersSent) json(response, 500, { error: "fixture_failed" }); else response.destroy(); });
  });
  const closeUpstream = trackSockets(upstream), upstreamUrl = await listen(upstream);
  let proxy: Proxy | undefined, token = "";
  const f = { requests, errors, session,
    get url() { if (!proxy) throw new Error("proxy not started"); return proxy.url; },
    stream(path = TURN_PATH, method = "POST", options: BrowserOptions = {}) {
      return observe(f.url, path, method, token, { ...(method === "POST" ? { body: turnBody() } : {}), ...options,
        headers: { ...(method === "POST" ? { "Idempotency-Key": "h5-stream-fixture-turn" } : {}), ...options.headers } });
    },
    async close() { if (proxy) await proxy.close(); await closeUpstream(); await rm(dir, { recursive: true, force: true }); },
  };
  try {
    await writeFile(configPath, JSON.stringify({ BASE_URL: upstreamUrl, SERVICE_API_KEY: SECRET, USER_ID: USER,
      AGENT_ID: AGENT, AGENT_VERSION: "1", MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "1000", OPERATION_TIMEOUT_MS: "5000" }), { mode: 0o600 });
    proxy = await chat.createChatH5Server({ configPath, port: 0 });
    const bootstrap = await observe(proxy.url, "/api/config", "GET", "", { token: false }).done;
    expect(bootstrap.status).toBe(200); token = String((JSON.parse(bootstrap.text) as Json).csrfToken);
    expect(token).toMatch(/^[0-9a-f]{64}$/); return f;
  } catch (error) { await f.close(); throw error; }
}
function beginSse(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "set-cookie": `reflected=${SECRET}`,
    "x-fixture-private": SECRET, "access-control-allow-origin": "*" }); response.flushHeaders();
}
async function writePieces(response: ServerResponse, bytes: Buffer) {
  // The selected boundaries split both a UTF-8 character and CRLF; remaining writes split JSON and credentials.
  const chinese = bytes.indexOf(Buffer.from("你"));
  const crlf = bytes.indexOf(Buffer.from("\r\n"));
  const reflected = bytes.indexOf(Buffer.from(SECRET.slice(1))), reflectedKey = bytes.lastIndexOf(Buffer.from(SECRET.slice(1)));
  const boundaries = [...new Set([1, crlf + 1, chinese + 1, chinese + 2, reflected + 6, reflectedKey + 6,
    Math.floor(bytes.length / 2), bytes.length - 1, bytes.length])]
    .filter(value => value > 0 && value <= bytes.length).sort((a, b) => a - b);
  let offset = 0;
  for (const end of boundaries) {
    response.write(bytes.subarray(offset, end)); offset = end;
    await new Promise<void>(done => setImmediate(done));
  }
}

describe("local H5 streaming HTTP boundary", () => {
  it("redacts a credential split across separate live delta events", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      beginSse(response);
      response.end(frame(delta(`开头${SECRET.slice(0, 9)}`)) + frame(delta(`${SECRET.slice(9)}结尾`)) + frame(terminal()));
      return true;
    });
    const browser = f.stream();
    try {
      const result = await deadline(browser.done, "split credential stream did not close");
      const text = parseFrames(result.text).filter(value => value.data.type === "item/agentMessage/delta").map(value => value.data.delta).join("");
      expect(result.status).toBe(200); expect(text).toBe("开头[redacted-service-key]结尾"); expect(text).not.toContain(SECRET);
    } finally { browser.close(); await f.close(); }
  });

  it("dispatches a complete event terminated by a final bare CR", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      beginSse(response); response.end(frame(delta("纯 CR 分隔"), "\r") + frame(terminal(), "\r")); return true;
    });
    const browser = f.stream();
    try {
      const result = await deadline(browser.done, "CR stream did not close");
      expect(result.status).toBe(200); expect(parseFrames(result.text).map(value => value.data.type)).toEqual(["item/agentMessage/delta", "turn/completed"]);
    } finally { browser.close(); await f.close(); }
  });

  it("delivers complete UTF-8/CRLF delta frames before completion, redacts parsed JSON and assigns only durable ids", async () => {
    const release = deferred<void>();
    const f = await fixture(async (incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      beginSse(response);
      const started = { type: "turn/started", sessionId: SESSION, emittedAtMs: 0, seq: 0, turn: { ...turn, status: "running" } };
      const reflected = { ...delta(`你好，${SECRET}。`), [SECRET]: SECRET };
      const encoded = (": fixture heartbeat\r\n\r\n" + frame(started, "\r\n") + frame(reflected, "\r\n")
        + frame(delta("分片二"), "\r\n") + frame({ type: "fixture/future", sessionId: SESSION, emittedAtMs: 1, safe: true }, "\r\n"))
        .replaceAll(SECRET, `\\u0068${SECRET.slice(1)}`);
      await writePieces(response, Buffer.from(encoded));
      await release.promise; if (!response.destroyed) response.end(frame(terminal())); return true;
    });
    const browser = f.stream(TURN_PATH, "POST", { headers: { Authorization: "Bearer browser-secret", Cookie: "browser=secret", "X-User-Id": "other_user" } });
    try {
      const opened = await deadline(browser.opened, "SSE response did not open");
      expect(opened.status).toBe(200); expect(opened.headers["content-type"]).toContain("text/event-stream");
      expect(opened.headers["cache-control"]).toContain("no-store");
      for (const header of ["set-cookie", "x-fixture-private", "access-control-allow-origin"]) expect(opened.headers[header]).toBeUndefined();
      await browser.until(text => text.endsWith("\n\n") && text.includes('"safe":true'));
      expect(browser.text()).not.toContain("turn/completed"); expect(browser.text()).not.toContain(SECRET);
      const live = parseFrames(browser.text());
      expect(live.map(value => value.event)).toEqual(["turn/started", "item/agentMessage/delta", "item/agentMessage/delta", "fixture/future"]);
      expect(live[0]?.id).toBe("0"); expect(live.slice(1).every(value => value.id === undefined)).toBe(true);
      expect(live[1]?.data.delta).toBe("你好，[redacted-service-key]。");
      expect(live[1]?.data["[redacted-service-key]"]).toBe("[redacted-service-key]");
      expect(live.every(value => value.event === value.data.type)).toBe(true);
      release.resolve(); const result = await deadline(browser.done, "SSE response did not complete");
      expect(result.ended).toBe(true); expect(parseFrames(result.text).at(-1)).toMatchObject({ id: "2", event: "turn/completed" });
      const submitted = f.requests.filter(value => value.method === "POST"); expect(submitted).toHaveLength(1);
      expect(submitted[0]?.body).toEqual(turnBody()); expect(submitted[0]?.headers["idempotency-key"]).toBe("h5-stream-fixture-turn");
      expect(submitted[0]?.headers.authorization).toBe(`Bearer ${SECRET}`); expect(submitted[0]?.headers["x-user-id"]).toBe(USER);
      expect(submitted[0]?.headers.cookie).toBeUndefined(); expect(submitted[0]?.headers["x-chat-token"]).toBeUndefined();
      expect(f.errors).toEqual([]);
    } finally { release.resolve(); browser.close(); await f.close(); }
  });

  it.each(["-1", "0", "9007199254740991"])("forwards read-only event observation after=%s without requiring the configured agent profile", async after => {
    const path = `/api/sessions/${SESSION}/events?after=${after}`;
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "GET" || incoming.url !== path.replace("/api/", "/v1/")) return false;
      beginSse(response); response.end(frame({ type: "heartbeat", sessionId: SESSION, emittedAtMs: 1 })); return true;
    });
    f.session.agentId = "agt_00000000-0000-7000-8000-000000000009"; f.session.agentVersion = 2;
    const browser = f.stream(path, "GET");
    try {
      const result = await deadline(browser.done, "read-only event observation did not finish");
      expect(result.status).toBe(200); expect(parseFrames(result.text)).toMatchObject([{ event: "heartbeat" }]);
      expect(f.requests.filter(value => value.path.includes("/events"))).toMatchObject([{ method: "GET", path: path.replace("/api/", "/v1/") }]);
      expect(f.requests.every(value => value.headers.authorization === `Bearer ${SECRET}` && value.headers["x-user-id"] === USER)).toBe(true);
      expect(f.requests.some(value => value.method === "POST")).toBe(false);
      expect(f.errors).toEqual([]);
    } finally { browser.close(); await f.close(); }
  });

  it.each(["after=-2", "after=1.5", "after=9007199254740992", "after=NaN", "after=1&after=2", "after=0&exclude=heartbeat", "after=0&extra=1"])
    ("rejects event query %s before any upstream observation", async query => {
      const f = await fixture(() => false), browser = f.stream(`/api/sessions/${SESSION}/events?${query}`, "GET");
      try { const result = await deadline(browser.done, "invalid query did not finish"); expect(result.status).toBe(400); expect(f.requests).toHaveLength(0); }
      finally { browser.close(); await f.close(); }
    });

  it("accepts a successful JSON idempotent replay even when stream:true was requested", async () => {
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      json(response, 200, { turn, reflected: SECRET }, { "Idempotency-Replayed": "true" }); return true;
    });
    const browser = f.stream();
    try {
      const result = await deadline(browser.done, "idempotent replay did not finish");
      expect(result.status).toBe(200); expect(result.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(result.text)).toMatchObject({ turn, reflected: "[redacted-service-key]" });
      expect(result.text).not.toContain(SECRET); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
    } finally { browser.close(); await f.close(); }
  });

  it.each(["missing_ack", "false_ack", "wrong_status", "wrong_session"] as const)
    ("rejects a JSON response that cannot prove a stream replay: %s", async fault => {
      const f = await fixture((incoming, response) => {
        if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
        const replayTurn = fault === "wrong_session" ? { ...turn, sessionId: "sess_00000000-0000-7000-8000-000000000009" } : turn;
        json(response, fault === "wrong_status" ? 202 : 200, { turn: replayTurn, reflected: SECRET },
          fault === "missing_ack" ? {} : { "Idempotency-Replayed": fault === "false_ack" ? "false" : "true" }); return true;
      });
      const browser = f.stream();
      try {
        const result = await deadline(browser.done, "invalid replay did not finish");
        expect(result.status).toBe(502); expect(result.text).not.toContain(SECRET); expect(result.text).not.toContain(TURN);
        expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
      } finally { browser.close(); await f.close(); }
    });

  it.each(["POST", "GET"])("rejects missing tokens and foreign origins for %s streaming before contacting upstream", async method => {
    const f = await fixture(() => false);
    try {
      for (const options of [{ token: false }, { headers: { "X-Chat-Token": "incorrect" } }, { origin: "https://attacker.example" }]) {
        const browser = f.stream(method === "POST" ? TURN_PATH : `/api/sessions/${SESSION}/events?after=-1`, method, options);
        try {
          const result = await deadline(browser.done, "unauthorized stream did not finish");
          expect(result.status).toBe(403); expect(result.text).not.toContain(SECRET);
          expect(result.headers["access-control-allow-origin"]).toBeUndefined();
        } finally { browser.close(); }
      }
      expect(f.requests).toHaveLength(0);
    } finally { await f.close(); }
  });

  it.each(["non_sse", "bad_json", "oversized_frame", "incomplete_frame", "wrong_session", "wrong_event_type", "invalid_seq", "encoded_response"] as const)
    ("rejects %s without leaking any rejected frame or fabricating a completed turn", async fault => {
      const marker = "rejected-frame-must-stay-private";
      const f = await fixture((incoming, response) => {
        if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
        if (fault === "non_sse") { response.writeHead(200, { "content-type": "text/plain" }); response.end(`${marker} ${SECRET}`); return true; }
        if (fault === "encoded_response") {
          response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); response.end(frame(delta(`${marker} ${SECRET}`))); return true;
        }
        beginSse(response);
        if (fault === "bad_json") response.end(`event: item/agentMessage/delta\ndata: {"private":"${marker} ${SECRET}",}\n\n`);
        if (fault === "oversized_frame") response.end(frame(delta(`${marker} ${SECRET}${"x".repeat(262_145)}`)));
        if (fault === "incomplete_frame") response.end(frame(delta(`${marker} ${SECRET}`)).slice(0, -1));
        if (fault === "wrong_session") response.end(frame({ ...delta(`${marker} ${SECRET}`), sessionId: "sess_00000000-0000-7000-8000-000000000009" }));
        if (fault === "wrong_event_type") response.end(frame(delta(`${marker} ${SECRET}`)).replace("event: item/agentMessage/delta", "event: heartbeat"));
        if (fault === "invalid_seq") response.end(frame({ ...delta(`${marker} ${SECRET}`), seq: -1 }));
        return true;
      });
      const browser = f.stream();
      try {
        const result = await deadline(browser.done, "rejected SSE response did not close");
        expect(result.status === 502 || result.status === 200).toBe(true);
        expect(result.text).not.toContain(marker); expect(result.text).not.toContain(SECRET); expect(result.text).not.toContain("turn/completed");
        expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
      } finally { browser.close(); await f.close(); }
    });

  it.each(["eof", "reset"] as const)("does not retry a POST after upstream %s without a terminal frame", async ending => {
    const release = deferred<void>();
    const f = await fixture(async (incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      beginSse(response); response.write(frame(delta("仅有部分回答")));
      await release.promise;
      if (ending === "reset") response.destroy(); else response.end(); return true;
    });
    const browser = f.stream();
    try {
      await browser.until(text => text.endsWith("\n\n") && text.includes("仅有部分回答")); release.resolve();
      const result = await deadline(browser.done, "truncated observation did not close");
      expect(result.status).toBe(200); expect(parseFrames(result.text)).toMatchObject([{ event: "item/agentMessage/delta", data: { delta: "仅有部分回答" } }]);
      expect(result.text).not.toContain("turn/completed"); expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
      expect(f.requests.some(value => value.path.endsWith("/interrupt"))).toBe(false);
    } finally { release.resolve(); browser.close(); await f.close(); }
  });

  it("cancels upstream observation when the browser disconnects without interrupting the running turn", async () => {
    const upstreamClosed = deferred<void>();
    const f = await fixture((incoming, response) => {
      if (incoming.method !== "POST" || incoming.url !== UPSTREAM_TURN_PATH) return false;
      response.once("close", () => upstreamClosed.resolve()); beginSse(response); response.write(frame(delta("等待断开观察"))); return true;
    });
    const browser = f.stream();
    try {
      await browser.until(text => text.includes("等待断开观察")); browser.close();
      await deadline(upstreamClosed.promise, "upstream observation survived browser disconnect");
      expect(f.requests.filter(value => value.method === "POST")).toHaveLength(1);
      expect(f.requests.some(value => value.path.endsWith("/interrupt"))).toBe(false);
    } finally { browser.close(); await f.close(); }
  });
});
