import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHttpExperienceConfig } from "./http-experience.mjs";
import { relayChatSse } from "./chat-h5-sse.mjs";

// A development client, outside the two product services and their release bundles.
// No .env discovery, provider calls, schema work or automatic POST retries.
export const CHAT_LIMITS = Object.freeze({ maxSteps: 6, maxToolCalls: 1,
  maxWallClockMs: 60_000, maxOutputTokensPerStep: 1024 });
const MAX_BODY = 32_768, MAX_RESPONSE = 4_194_304;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION = `sess_${ID}`, TURN = `turn_${ID}`;
const PUBLIC = new URL("./chat-h5/public/", import.meta.url);
const ASSETS = new Map([["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/environment.js", ["environment.js", "text/javascript; charset=utf-8"]]]);
const ENVIRONMENT_ACTIONS = new Set(["start-services", "stop-services", "restart-services",
  "start-infrastructure", "stop-infrastructure", "restart-infrastructure"]);
const ENVIRONMENT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_ERRORS = Object.freeze({ invalid_action: 400, invalid_idempotency_key: 400,
  operation_conflict: 409, idempotency_conflict: 409, environment_not_ready: 409,
  environment_unavailable: 503, journal_unavailable: 503, controller_closed: 503 });
class ChatError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new ChatError(status, code); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

function environmentError(error) {
  const code = typeof error?.code === "string" && Object.hasOwn(ENVIRONMENT_ERRORS, error.code)
    ? error.code : "environment_unavailable";
  fail(ENVIRONMENT_ERRORS[code], code);
}
function disconnectedEnvironment() {
  return { enabled: false, checkedAt: new Date().toISOString(), overall: "unknown",
    components: [{ id: "owner", name: "OWNER 管理器", state: "unknown", detail: "未连接本机管理器" }],
    actions: [], operation: null };
}
async function requireEnvironmentReady(environmentController) {
  if (!environmentController) return;
  let state;
  try { state = await environmentController.status(); }
  catch { fail(503, "environment_not_ready"); }
  if (!record(state) || state.enabled !== true || state.overall !== "ready"
    || state.operation !== null && (!record(state.operation)
      || !["succeeded", "failed"].includes(state.operation.state))) fail(503, "environment_not_ready");
}

async function loadConfig(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail(400, "invalid_config");
  const parent = dirname(path), parentStat = await lstat(parent), before = await lstat(path);
  if (!parentStat.isDirectory() || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o7777) !== 0o700
    || await realpath(parent) !== parent || !before.isFile() || before.isSymbolicLink() || await realpath(path) !== path)
    fail(400, "invalid_config");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600
      || stat.nlink !== 1 || stat.size < 2 || stat.size > 65_536 || identity(stat) !== identity(before)) fail(400, "invalid_config");
    const bytes = Buffer.alloc(stat.size + 1); let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const part = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!part.bytesRead) break; bytesRead += part.bytesRead;
    }
    if (bytesRead !== stat.size || identity(stat) !== identity(await file.stat()) || identity(stat) !== identity(await lstat(path))
      || identity(parentStat) !== identity(await lstat(parent)) || await realpath(path) !== path) fail(400, "invalid_config");
    return parseHttpExperienceConfig(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
  } finally { await file.close(); }
}

function headers(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
function json(response, status, value, secret) {
  if (response.destroyed) return;
  // Protect against an upstream reflecting the configured credential, even in object keys.
  const body = JSON.stringify(value).replaceAll(secret, "[redacted-service-key]");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(body);
}
async function readBody(request) {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || request.headers["content-encoding"]) fail(415, "json_required");
  if (Number(request.headers["content-length"]) > MAX_BODY) fail(413, "request_too_large");
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; if (size > MAX_BODY) fail(413, "request_too_large"); chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fail(400, "invalid_request"); }
}
function queryString(url, allowed) {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) fail(400, "invalid_query");
    const value = url.searchParams.get(name);
    if (name === "limit" && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200)
      || name === "afterSeq" && (!/^-?[0-9]{1,16}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < -1)
      || name === "after" && (!/^(?:-1|0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))
      || name === "turnId" && !new RegExp(`^${TURN}$`).test(value)
      || name === "cursor" && (!value || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value))) fail(400, "invalid_query");
  }
  return url.search;
}
function route(request, url) {
  const method = request.method, path = url.pathname.slice(4);
  if (path === "/sessions" && method === "GET") return { path: `/v1${path}${queryString(url, ["limit", "cursor"])}` };
  if (path === "/sessions" && method === "POST") { queryString(url, []); return { path: "/v1/sessions", write: "session" }; }
  if (new RegExp(`^/sessions/${SESSION}$`).test(path) && method === "GET") {
    queryString(url, []); return { path: `/v1${path}` };
  }
  if (new RegExp(`^/sessions/${SESSION}/items$`).test(path) && method === "GET")
    return { path: `/v1${path}${queryString(url, ["limit", "afterSeq", "turnId"])}` };
  if (new RegExp(`^/sessions/${SESSION}/events$`).test(path) && method === "GET") {
    if (!url.searchParams.has("after")) fail(400, "invalid_query");
    return { path: `/v1${path}${queryString(url, ["after"])}`, stream: true, streamSessionId: path.split("/")[2] };
  }
  if (new RegExp(`^/sessions/${SESSION}/turns$`).test(path)) {
    if (method === "GET") return { path: `/v1${path}${queryString(url, ["limit", "cursor"])}` };
    if (method === "POST") { queryString(url, []); return { path: `/v1${path}`, write: "turn", sessionId: path.split("/")[2] }; }
  }
  if (new RegExp(`^/sessions/${SESSION}/turns/${TURN}$`).test(path) && method === "GET") {
    queryString(url, []); return { path: `/v1${path}` };
  }
  if (new RegExp(`^/sessions/${SESSION}/turns/${TURN}/interrupt$`).test(path) && method === "POST") {
    queryString(url, []); return { path: `/v1${path}`, write: "interrupt", sessionId: path.split("/")[2] };
  }
  fail(404, "not_found");
}
function prepareBody(kind, body, config) {
  if (kind === "session") {
    if (!exactKeys(body, []) && !(exactKeys(body, ["title"]) && typeof body.title === "string"
      && body.title.trim() && body.title.length <= 120)) fail(400, "invalid_request");
    return { agentId: config.agentId, agentVersion: config.agentVersion, title: body.title ?? "H5 聊天体验" };
  }
  if (kind === "interrupt") { if (!exactKeys(body, [])) fail(400, "invalid_request"); return {}; }
  if (!exactKeys(body, ["input", "stream", "busyPolicy", "limits"]) || typeof body.stream !== "boolean" || body.busyPolicy !== "reject"
    || !Array.isArray(body.input) || body.input.length !== 1 || !exactKeys(body.input[0], ["type", "text"])
    || body.input[0].type !== "text" || typeof body.input[0].text !== "string" || !body.input[0].text.trim()
    || body.input[0].text.length > 16_000 || !exactKeys(body.limits, Object.keys(CHAT_LIMITS))
    || Object.entries(CHAT_LIMITS).some(([key, value]) => body.limits[key] !== value)) fail(400, "invalid_request");
  return { input: body.input, stream: body.stream, busyPolicy: "reject", limits: CHAT_LIMITS };
}

// Native HTTP never follows a redirect or picks up an ambient proxy. A POST is sent once.
function upstream(config, path, { method = "GET", body, key, signal, statusOnly = false, relayTo, sessionId } = {}) {
  return new Promise((done, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const url = new URL(path, config.baseUrl);
    const unknown = () => new ChatError(502, method === "POST" ? "upstream_outcome_unknown" : "upstream_unavailable");
    let request, timer;
    const stop = () => request?.destroy(unknown());
    request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method, agent: false, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${config.serviceApiKey}`, "x-user-id": config.userId, accept: relayTo ? "text/event-stream" : "application/json",
        ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}),
        ...(key ? { "idempotency-key": key } : {}) },
    }, response => {
      void (async () => {
        // Headers/body from rejected upstream requests are never forwarded to the browser.
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy(); return { status: response.statusCode, rejected: true };
        }
        if (statusOnly) return { status: response.statusCode, rejected: false };
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw unknown();
        const contentType = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (relayTo && contentType === "text/event-stream" && response.statusCode === 200) {
          clearTimeout(timer); timer = setTimeout(stop, config.operationTimeoutMs);
          await relayChatSse(response, relayTo, { sessionId, secret: config.serviceApiKey });
          return { streamed: true };
        }
        if (contentType !== "application/json" || relayTo && !(method === "POST" && response.statusCode === 200
          && response.headers["idempotency-replayed"] === "true")) throw unknown();
        const chunks = []; let size = 0;
        for await (const chunk of response) { size += chunk.length; if (size > MAX_RESPONSE) throw unknown(); chunks.push(chunk); }
        let value;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw unknown(); }
        if (relayTo && (!record(value?.turn) || value.turn.sessionId !== sessionId)) throw unknown();
        return { status: response.statusCode, body: value };
      })().then(done, () => reject(unknown())).finally(() => { response.destroy(); request.destroy(); });
    });
    request.on("error", () => reject(unknown()));
    timer = setTimeout(stop, config.requestTimeoutMs);
    request.once("close", () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    request.end(bytes);
  });
}

export async function createChatH5Server({ configPath, port = 0, environmentController }) {
  const config = await loadConfig(configPath);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(400, "invalid_port");
  if (environmentController !== undefined && (!record(environmentController)
    || typeof environmentController.status !== "function" || typeof environmentController.act !== "function")) fail(400, "invalid_environment_controller");
  const token = randomBytes(32).toString("hex"), controllers = new Set();
  let origin, activeChatWrites = 0, controlAdmitting = false;
  const server = createServer((request, response) => {
    headers(response);
    const controller = new AbortController(); controllers.add(controller);
    response.once("close", () => { controller.abort(); controllers.delete(controller); });
    let ownsWrite = false;
    void (async () => {
      if (!origin || request.headers.host !== new URL(origin).host
        || request.headers.origin && request.headers.origin !== origin
        || request.headers["sec-fetch-site"] === "cross-site") fail(403, "origin_rejected");
      const raw = request.url ?? "";
      if (!raw.startsWith("/") || raw.startsWith("//") || /[%\\#]/.test(raw.split("?", 1)[0])) fail(400, "invalid_path");
      const url = new URL(raw, origin);
      if (url.origin !== origin || raw.split("?", 1)[0] !== url.pathname) fail(400, "invalid_path");
      if (request.method === "GET" && ASSETS.has(url.pathname) && !url.search) {
        const [name, type] = ASSETS.get(url.pathname);
        const bytes = await readFile(new URL(name, PUBLIC));
        response.writeHead(200, { "Content-Type": type }); response.end(bytes); return;
      }
      if (request.method === "GET" && url.pathname === "/api/config" && !url.search) {
        json(response, 200, { baseUrl: config.baseUrl, userId: config.userId, agentId: config.agentId, agentVersion: config.agentVersion,
          requestTimeoutMs: config.requestTimeoutMs, operationTimeoutMs: config.operationTimeoutMs, csrfToken: token }, config.serviceApiKey); return;
      }
      const supplied = request.headers["x-chat-token"];
      if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) fail(403, "token_required");
      if (request.method === "GET" && url.pathname === "/api/health" && !url.search) {
        try { const result = await upstream(config, "/readyz", { signal: controller.signal, statusOnly: true });
          json(response, 200, { ready: result.status === 200 && !result.rejected }, config.serviceApiKey);
        } catch { json(response, 200, { ready: false }, config.serviceApiKey); } return;
      }
      if (url.pathname === "/api/environment") {
        queryString(url, []);
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); fail(405, "method_not_allowed"); }
        let status;
        try { status = environmentController ? await environmentController.status() : disconnectedEnvironment(); }
        catch (error) { environmentError(error); }
        json(response, 200, status, config.serviceApiKey); return;
      }
      if (url.pathname === "/api/environment/actions") {
        queryString(url, []);
        if (request.method !== "POST") { response.setHeader("Allow", "POST"); fail(405, "method_not_allowed"); }
        const body = await readBody(request);
        if (!exactKeys(body, ["action"]) || typeof body.action !== "string" || !ENVIRONMENT_ACTIONS.has(body.action)) fail(400, "invalid_action");
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !ENVIRONMENT_KEY.test(idempotencyKey)) fail(400, "invalid_idempotency_key");
        if (!environmentController) fail(503, "environment_unavailable");
        if (activeChatWrites || controlAdmitting) fail(409, "operation_conflict");
        let result;
        controlAdmitting = true;
        try { result = await environmentController.act({ action: body.action, idempotencyKey }); }
        catch (error) { environmentError(error); }
        finally { controlAdmitting = false; }
        json(response, 202, result, config.serviceApiKey); return;
      }
      if (!url.pathname.startsWith("/api/")) fail(404, "not_found");
      const selected = route(request, url);
      let body, key;
      if (selected.write) body = prepareBody(selected.write, await readBody(request), config);
      if (selected.write === "turn") {
        key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[A-Za-z0-9._~-]{8,128}$/.test(key)) fail(400, "idempotency_key_required");
      }
      if (selected.write && selected.write !== "interrupt") {
        if (controlAdmitting) fail(503, "environment_not_ready");
        activeChatWrites++; ownsWrite = true;
        await requireEnvironmentReady(environmentController);
      }
      if (selected.sessionId) {
        const notSubmitted = selected.write === "turn" ? "turn_not_submitted" : "interrupt_not_submitted";
        let check;
        try { check = await upstream(config, `/v1/sessions/${selected.sessionId}`, { signal: controller.signal }); }
        catch { fail(503, notSubmitted); }
        // An explicit pre-dispatch failure lets the user safely correct and submit later.
        // Failures after the POST below never receive this code.
        if (check.rejected) fail(503, notSubmitted);
        const session = check.body;
        if (!record(session) || session.id !== selected.sessionId || session.userId !== config.userId
          || session.agentId !== config.agentId || session.agentVersion !== config.agentVersion) fail(409, "session_profile_mismatch");
      }
      const streaming = selected.stream || selected.write === "turn" && body.stream;
      const result = await upstream(config, selected.path, { method: request.method, body, key, signal: controller.signal,
        ...(streaming ? { relayTo: response, sessionId: selected.streamSessionId || selected.sessionId } : {}) });
      if (result.streamed) return;
      if (result.rejected) json(response, result.status >= 400 ? result.status : 502,
        { error: "upstream_rejected", status: result.status }, config.serviceApiKey);
      else json(response, result.status, result.body, config.serviceApiKey);
    })().catch(error => {
      if (!response.headersSent) json(response, error instanceof ChatError ? error.status : 500,
        { error: error instanceof ChatError ? error.code : "local_request_failed" }, config.serviceApiKey);
      else response.destroy();
    }).finally(() => { if (ownsWrite) activeChatWrites--; });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  const address = server.address(); origin = `http://127.0.0.1:${address.port}`;
  return { server, url: origin, close: async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await new Promise(done => server.close(done));
  } };
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write("node scripts/ops/chat-h5.mjs --config /ABS/private/client.json [--port 58655] [--control-config /ABS/private/control.json]\n"
      + "Node24; owned 0600 client JSON with owned 0700 parent, using the HTTP experience eight-field contract.\n"
      + "Loopback only. Credentials stay in this process. Clicking Send uses the configured model and may incur fees.\n"
      + "Optional --control-config connects the explicit local OWNER management binding; no automatic service action.\n"
      + "No .env discovery, automatic POST retry, initialization, migration or service upgrade. Ctrl-C stops only this H5 tool.\n"); return;
  }
  const args = process.argv.slice(2), fields = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!["--config", "--port", "--control-config"].includes(args[index]) || Object.hasOwn(fields, args[index]) || !args[index + 1]) fail(400, "invalid_arguments");
    fields[args[index]] = args[index + 1];
  }
  if (!fields["--config"] || fields["--port"] !== undefined && !/^[1-9][0-9]{0,4}$/.test(fields["--port"])
    || Number(process.versions.node.split(".")[0]) < 24) fail(400, "invalid_arguments");
  let environmentController;
  if (fields["--control-config"]) {
    const { connectEnvironmentController } = await import("./local-environment-owner.mjs");
    environmentController = await connectEnvironmentController(fields["--control-config"]);
  }
  const app = await createChatH5Server({ configPath: fields["--config"], port: Number(fields["--port"] ?? 58655), environmentController });
  process.stdout.write(`Chat H5: ${app.url}\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    process.stderr.write(`chat_h5_${error instanceof ChatError ? error.code : "startup_failed"}\n`); process.exitCode = 1;
  }
}
