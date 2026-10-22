import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseRoleJson } from "./external-infra.mjs";

const KEYS = ["BASE_URL", "SERVICE_API_KEY", "USER_ID", "AGENT_ID", "AGENT_VERSION",
  "MODEL_CALL_ACK", "REQUEST_TIMEOUT_MS", "OPERATION_TIMEOUT_MS"];
const MAX_CONFIG = 65_536, MAX_BODY = 32_768, MAX_RESPONSE = 1_048_576;
const MAX_FRAME = 65_536, MAX_EVENTS = 512, MAX_TOTAL = 8_388_608;
const EXCLUDE = "item/agentMessage/delta,item/reasoning/delta,item/toolCall/argsDelta,item/mcpToolCall/progress,usage/updated,heartbeat";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CODES = new Set(["invalid", "cancelled", "request_timeout", "operation_timeout", "transport_failed",
  "http_rejected", "response_limit", "protocol_failed", "incomplete_stream", "persistence_failed"]);

export class HttpExperienceError extends Error {
  constructor(code = "invalid") {
    const safe = CODES.has(code) ? code : "invalid";
    super(`http_experience_${safe}`); this.name = "HttpExperienceError"; this.code = `http_experience_${safe}`;
  }
}
function fail(code = "invalid") { throw new HttpExperienceError(code); }
function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function canonical(prefix, value) { return typeof value === "string" && new RegExp(`^${prefix}_${UUID}$`).test(value); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function integer(value, min, max) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail();
  return Number(value);
}
function safeError(error) { return error instanceof HttpExperienceError ? error : new HttpExperienceError("transport_failed"); }

export function parseHttpExperienceArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) fail();
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  if (argv.length !== 5 || argv[0] !== "run") fail();
  const result = Object.create(null), names = { "--config": "config", "--output": "output" };
  for (let i = 1; i < argv.length; i += 2) {
    if (!Object.hasOwn(names, argv[i]) || Object.hasOwn(result, names[argv[i]])) fail();
    result[names[argv[i]]] = absolute(argv[i + 1]);
  }
  if (Object.keys(result).length !== 2) fail();
  return Object.freeze(result);
}

/** This ACK permits calls to the selected service; it does not attest a fake or free model. */
export function parseHttpExperienceConfig(text) {
  try {
    const values = parseRoleJson(text);
    if (Object.keys(values).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(values, key))) fail();
    for (const value of Object.values(values)) {
      if (!value || Buffer.byteLength(value) > 16_384 || /[\u0000-\u001f\u007f]/.test(value)) fail();
    }
    const origin = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([1-9][0-9]{0,4}))?\/?$/.exec(values.BASE_URL);
    if (!origin || origin[3] && Number(origin[3]) > 65_535) fail();
    const url = new URL(values.BASE_URL);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || url.protocol === "http:" && (!origin[3] || !["127.0.0.1", "[::1]"].includes(origin[2]))) fail();
    if (!/^[A-Za-z0-9._~-]{7,512}$/.test(values.SERVICE_API_KEY)
      || !/^[A-Za-z0-9._:@|-]{1,128}$/.test(values.USER_ID) || !canonical("agt", values.AGENT_ID)
      || values.MODEL_CALL_ACK !== "allow-model-calls-v1") fail();
    const requestTimeoutMs = integer(values.REQUEST_TIMEOUT_MS, 100, 120_000);
    const operationTimeoutMs = integer(values.OPERATION_TIMEOUT_MS, requestTimeoutMs, 600_000);
    return Object.freeze({ baseUrl: url.origin, serviceApiKey: values.SERVICE_API_KEY, userId: values.USER_ID,
      agentId: values.AGENT_ID, agentVersion: integer(values.AGENT_VERSION, 1, Number.MAX_SAFE_INTEGER),
      requestTimeoutMs, operationTimeoutMs });
  } catch { fail(); }
}

function identity(stat) { return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
async function privateDirectory(path) {
  absolute(path); const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) fail();
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
async function configFile(path) {
  absolute(path); const parent = await privateDirectory(dirname(path)), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || await realpath(path) !== path) fail();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1
      || stat.size < 2 || stat.size > MAX_CONFIG || identity(before) !== identity(stat)) fail();
    const bytes = Buffer.alloc(MAX_CONFIG + 1); let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    if (length !== stat.size || length > MAX_CONFIG || identity(stat) !== identity(await file.stat())
      || identity(stat) !== identity(await lstat(path)) || parent !== await privateDirectory(dirname(path))) fail();
    const data = bytes.subarray(0, length);
    if (!data.equals(Buffer.from(data.toString("utf8")))) fail();
    return { config: parseHttpExperienceConfig(data.toString("utf8")), sha256: digest(data) };
  } finally { await file.close(); }
}

async function outputWriter(path, serviceKey) {
  absolute(path); await privateDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 }); // Never reuse or resume an existing run directory.
  const witness = await privateDirectory(path);
  return async (name, value) => {
    let file;
    try {
      if (!/^[a-z0-9-]+\.json$/.test(name) || witness !== await privateDirectory(path)) fail("persistence_failed");
      // Even a malicious endpoint reflecting the bearer value cannot copy it to result JSON.
      const bytes = JSON.stringify(value, null, 2).replaceAll(serviceKey, "[redacted-service-key]") + "\n";
      file = await open(join(path, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const stat = await file.stat();
      if ((stat.mode & 0o7777) !== 0o600 || stat.uid !== process.getuid?.() || stat.nlink !== 1) fail("persistence_failed");
      await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
      const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
      if (witness !== await privateDirectory(path)) fail("persistence_failed");
    } catch { fail("persistence_failed"); }
    finally { if (file) await file.close().catch(() => {}); }
  };
}

/** Incremental SSE with complete-frame, fatal UTF-8, byte and event budgets. No raw diagnostics. */
async function readSse(response, sessionId, consumeBytes, stop) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data = [], event = "", eventId, frameBytes = 0, previous = -1;
  const frames = [];
  const line = value => {
    frameBytes += Buffer.byteLength(value) + 1;
    if (frameBytes > MAX_FRAME) fail("response_limit");
    if (value === "") {
      frameBytes = 0;
      if (!data.length) { event = ""; return; }
      let value;
      try { value = JSON.parse(data.join("\n")); } catch { fail("protocol_failed"); }
      data = [];
      if (!record(value) || value.sessionId !== sessionId || typeof value.type !== "string"
        || !Number.isSafeInteger(value.seq) || value.seq <= previous || eventId !== String(value.seq)
        || event && event !== value.type) fail("protocol_failed");
      previous = value.seq;
      const frame = { id: eventId, event: event || "message", data: value }; event = "";
      frames.push(frame); if (frames.length > MAX_EVENTS) fail("response_limit");
      return stop(value) ? frames : undefined;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1); if (content.startsWith(" ")) content = content.slice(1);
    if (field === "data") data.push(content);
    else if (field === "event") event = content;
    else if (field === "id") { if (content.includes("\0")) fail("protocol_failed"); eventId = content; }
  };
  for await (const chunk of response.iterator({ destroyOnReturn: false })) {
    consumeBytes(chunk.length); buffer += decoder.decode(chunk, { stream: true });
    let consumed = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
      if (buffer[i] === "\r" && i === buffer.length - 1) break;
      const value = buffer.slice(consumed, i);
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i++;
      consumed = i + 1; const done = line(value); if (done) return done;
    }
    buffer = buffer.slice(consumed);
    if (Buffer.byteLength(buffer) + frameBytes > MAX_FRAME) fail("response_limit");
  }
  decoder.decode(); // Detect a partial final UTF-8 scalar; EOF does not dispatch an unfinished event.
  fail("incomplete_stream");
}

function terminal(turn, sessionId) {
  if (!record(turn) || !canonical("turn", turn.id) || turn.sessionId !== sessionId
    || turn.status !== "completed" || turn.stopReason !== "end_turn") fail("protocol_failed");
  return turn;
}

/** Native requests use fresh sockets, explicit TLS verification and no ambient proxy/fetch client. */
function nativeClient(config, signal) {
  let totalBytes = 0;
  return async (path, { method = "GET", body, key, sse, replay = false } = {}) => {
    signal.throwIfAborted();
    const url = new URL(path, config.baseUrl);
    if (url.origin !== config.baseUrl || !path.startsWith("/v1/")) fail();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > MAX_BODY) fail("response_limit");
    let request, response, responseClosed = Promise.resolve(), lookupClosed = Promise.resolve(), timer;
    let requestClosed = Promise.resolve(), socketClosed = Promise.resolve(), timeoutError;
    const aborted = () => request?.destroy(timeoutError ?? signal.reason ?? new HttpExperienceError("cancelled"));
    try {
      const result = new Promise((resolveResult, rejectResult) => {
        const headers = { authorization: `Bearer ${config.serviceApiKey}`, "x-user-id": config.userId,
          accept: sse ? "text/event-stream" : "application/json", connection: "close",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(key ? { "idempotency-key": key } : {}) };
        request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method, headers, agent: false, rejectUnauthorized: true,
          lookup(hostname, options, callback) {
            lookupClosed = new Promise(done => lookup(hostname, options, (...args) => { try { callback(...args); } finally { done(); } }));
          },
        });
        requestClosed = new Promise(done => request.once("close", done));
        request.once("socket", socket => { socketClosed = new Promise(done => socket.once("close", done)); });
        request.on("error", () => rejectResult(timeoutError ?? (signal.aborted ? signal.reason : new HttpExperienceError("transport_failed"))));
        request.on("response", incoming => {
          response = incoming; responseClosed = new Promise(done => incoming.once("close", done));
          void (async () => {
            if (incoming.statusCode !== (method === "POST" && path === "/v1/sessions" ? 201 : 200)) fail("http_rejected");
            if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") fail("protocol_failed");
            const contentType = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
            if (replay && incoming.headers["idempotency-replayed"] !== "true") fail("protocol_failed");
            let size = 0;
            const consume = length => {
              size += length; totalBytes += length;
              if (size > MAX_RESPONSE || totalBytes > MAX_TOTAL) fail("response_limit");
            };
            if (sse) {
              if (contentType !== "text/event-stream") fail("protocol_failed");
              return readSse(incoming, sse.sessionId, consume, sse.stop);
            }
            if (contentType !== "application/json") fail("protocol_failed");
            const chunks = [];
            for await (const chunk of incoming) { consume(chunk.length); chunks.push(chunk); }
            const bytes = Buffer.concat(chunks);
            try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("protocol_failed"); }
          })().then(resolveResult, rejectResult);
        });
        signal.addEventListener("abort", aborted, { once: true });
        timer = setTimeout(() => { timeoutError = new HttpExperienceError("request_timeout"); aborted(); }, config.requestTimeoutMs);
        if (signal.aborted) aborted();
        request.end(payload);
      });
      return await result;
    } catch (error) { throw safeError(error); }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      response?.destroy(); request?.destroy();
      // Cancellation is cooperative. Never claim a hard return deadline while lookup/native close is pending.
      await requestClosed;
      await Promise.all([responseClosed, socketClosed, lookupClosed]);
    }
  };
}

export const HTTP_EXPERIENCE_HELP = "node scripts/ops/http-experience.mjs run --config ABS_JSON --output ABS_NEW_DIR\n"
  + "HTTP client only: existing fixed agent, one new session, three synthetic turns and one exact replay.\n"
  + "Config: BASE_URL, SERVICE_API_KEY, USER_ID, AGENT_ID, AGENT_VERSION, MODEL_CALL_ACK=allow-model-calls-v1, REQUEST_TIMEOUT_MS(100..120000), OPERATION_TIMEOUT_MS(request..600000); all strings.\n"
  + "Config is owned 0600 with owned 0700 parent, absolute/no symlinks. Output must be new under an owned 0700 parent.\n"
  + "HTTP requires literal loopback and explicit port; HTTPS requires explicit origin. No redirects, .env, startup, DDL, agent management or deletion.\n"
  + "No submission retry/resume. Unknown outcomes retain request identity for manual reconciliation. SSE disconnect does not cancel a server turn.\n"
  + "Results contain private synthetic requests/answers; no bearer key or response headers. Model ACK does not attest FakeVendor, free calls, model quality or production readiness.\n";

export async function runHttpExperience(options, dependencies = {}) {
  if (!record(options) || Object.keys(options).length !== 2 || !Object.hasOwn(options, "config") || !Object.hasOwn(options, "output")) fail();
  let loaded;
  try { loaded = await configFile(absolute(options.config)); } catch { fail(); }
  const config = loaded.config, controller = new AbortController(), outer = dependencies.signal;
  const abort = () => controller.abort(new HttpExperienceError("cancelled"));
  outer?.addEventListener("abort", abort, { once: true }); if (outer?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new HttpExperienceError("operation_timeout")), config.operationTimeoutMs);
  let write, pendingSubmission, sessionId;
  try {
    controller.signal.throwIfAborted();
    write = await outputWriter(absolute(options.output), config.serviceApiKey);
    const runId = randomUUID(), recordId = `record-${runId}`, topicId = `topic-${runId}`;
    await write("run.json", { schema: "http-experience-v1", runId, baseUrl: config.baseUrl, userId: config.userId,
      agentId: config.agentId, agentVersion: config.agentVersion, configSha256: loaded.sha256,
      requestTimeoutMs: config.requestTimeoutMs, operationTimeoutMs: config.operationTimeoutMs,
      expectedNewTurns: 3, modelCallsAcknowledged: true, fakeOrFreeModelAttested: false });
    const call = nativeClient(config, controller.signal);
    const submit = async (name, path, body, key, extra = {}) => {
      controller.signal.throwIfAborted();
      const request = { method: "POST", path, body, bodySha256: digest(JSON.stringify(body)), ...(key ? { idempotencyKey: key } : {}) };
      await write(`${name}-request.json`, request); // fsync identity before any possible dispatch.
      controller.signal.throwIfAborted(); pendingSubmission = { name, bodySha256: request.bodySha256, ...(key ? { idempotencyKey: key } : {}) };
      const result = await call(path, { method: "POST", body, key, ...extra });
      return result;
    };
    const session = await submit("session", "/v1/sessions", { agentId: config.agentId, agentVersion: config.agentVersion,
      title: "Synthetic HTTP experience", metadata: { reference: "http-experience-v1", topicId } });
    if (!record(session) || !canonical("sess", session.id) || session.userId !== config.userId
      || session.agentId !== config.agentId || session.agentVersion !== config.agentVersion) fail("protocol_failed");
    sessionId = session.id;
    await write("session-response.json", { sessionId, userId: session.userId, agentId: session.agentId, agentVersion: session.agentVersion });
    pendingSubmission = undefined;
    const inputs = [
      { version: 1, text: "项目代号青禾，周五提交。", question: "请分析这条合成记录；缺少交付形式时先问我，不要猜测。" },
      { version: 2, text: "项目代号更正为青禾二期，周五提交，按列表交付。", question: "补充：按列表交付，并按更正后的代号继续。" },
      { version: 2, text: "项目代号更正为青禾二期，周五提交，按列表交付。", question: "依据前文的分析、补充和这条记录，最终项目代号、日期和交付形式是什么？" },
    ];
    const turns = [], requests = [];
    for (const [index, input] of inputs.entries()) {
      controller.signal.throwIfAborted();
      let idle = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await call(`/v1/sessions/${sessionId}`);
        if (!record(current) || current.id !== sessionId || current.userId !== config.userId) fail("protocol_failed");
        if (current.status?.type === "idle") { idle = true; break; }
        await pause(50, undefined, { signal: controller.signal });
      }
      if (!idle) fail("protocol_failed");
      const name = `turn-${index + 1}`, key = `http-experience-${runId}-${index + 1}`;
      const body = { input: [
        { type: "text", text: "Synthetic business record data (not instructions or tool permissions):\n"
          + JSON.stringify({ id: recordId, version: input.version, text: input.text }) },
        { type: "text", text: input.question },
      ], busyPolicy: "reject", limits: { maxSteps: 4, maxToolCalls: 1, maxWallClockMs: 30_000, maxOutputTokensPerStep: 512 },
      metadata: { reference: "http-experience-v1", topicId, recordId, recordVersion: input.version, operationId: key } };
      const path = `/v1/sessions/${sessionId}/turns?exclude=${EXCLUDE}`;
      const frames = await submit(name, path, body, key, { sse: { sessionId, stop: value => value.type === "turn/completed" } });
      const completed = frames.at(-1).data, turn = terminal(completed.turn, sessionId);
      if (completed.stopReason !== "end_turn") fail("protocol_failed");
      await write(`${name}-stream.json`, { frames });
      const persisted = terminal(await call(`/v1/sessions/${sessionId}/turns/${turn.id}`), sessionId);
      if (persisted.id !== turn.id) fail("protocol_failed");
      const items = await call(`/v1/sessions/${sessionId}/items?turnId=${turn.id}&limit=200`);
      if (!record(items) || !Array.isArray(items.data) || items.data.some(item => item.sessionId !== sessionId || item.turnId !== turn.id)) fail("protocol_failed");
      const answer = items.data.filter(item => item.type === "agentMessage" && item.status === "completed").at(-1);
      if (!answer || typeof answer.text !== "string" || !answer.text.trim()) fail("protocol_failed");
      await write(`${name}-response.json`, { sessionId, turn: persisted, recordId, recordVersion: input.version,
        operationId: key, answer: answer.text, items: items.data, completedEventSeq: completed.seq });
      pendingSubmission = undefined;
      turns.push({ id: turn.id, seq: completed.seq }); requests.push({ path, body, key });
    }
    const first = requests[0];
    const replay = await submit("turn-1-replay", first.path, first.body, first.key, { replay: true });
    if (!record(replay) || terminal(replay.turn, sessionId).id !== turns[0].id) fail("protocol_failed");
    await write("turn-1-replay-response.json", { turn: replay.turn, exactRequest: true }); pendingSubmission = undefined;
    const listed = await call(`/v1/sessions/${sessionId}/turns?limit=100`);
    if (!record(listed) || !Array.isArray(listed.data) || listed.data.length !== 3 || new Set(listed.data.map(turn => turn.id)).size !== 3
      || listed.data.some(turn => !turns.some(expected => expected.id === turn.id) || turn.sessionId !== sessionId)) fail("protocol_failed");
    const after = turns[0].seq, through = turns[2].seq;
    const frames = await call(`/v1/sessions/${sessionId}/events?after=${after}&exclude=${EXCLUDE}`, {
      sse: { sessionId, stop: value => value.seq >= through },
    });
    if (frames.some(frame => frame.data.seq <= after || frame.data.seq > through)
      || turns.slice(1).some(turn => !frames.some(frame => frame.data.type === "turn/completed" && frame.data.turn?.id === turn.id))) fail("protocol_failed");
    await write("events-response.json", { after, through, frames });
    const summary = { schema: "http-experience-result-v1", status: "completed", sessionId, turnIds: turns.map(turn => turn.id),
      recordVersions: inputs.map(input => input.version), exactReplayConfirmed: true, persistedEventsConfirmed: true,
      noAdditionalTurnOnReplay: true, upstreamDispatchCountIndependentlyObserved: false,
      modelQualityOrBillingProven: false, appPersistenceProven: false, localNativeRequestsClosed: true };
    await write("result.json", summary); return summary;
  } catch (error) {
    const safe = controller.signal.aborted ? safeError(controller.signal.reason) : safeError(error);
    if (write) await write("failure.json", { schema: "http-experience-failure-v1", status: pendingSubmission ? "unknown" : "stopped",
      code: safe.code, ...(sessionId ? { sessionId } : {}), ...(pendingSubmission ? { pendingSubmission } : {}),
      automaticSubmissionRetry: false, serverTurnCancellationClaimed: false }).catch(() => {});
    throw safe;
  } finally { clearTimeout(timer); outer?.removeEventListener("abort", abort); }
}

async function main() {
  const controller = new AbortController(); let interrupted;
  const onInt = () => { interrupted = 130; controller.abort(); }, onTerm = () => { interrupted = 143; controller.abort(); };
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const options = parseHttpExperienceArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(HTTP_EXPERIENCE_HELP); return; }
    if (Number(process.versions.node.split(".")[0]) < 24) fail();
    await runHttpExperience(options, { signal: controller.signal });
    process.stdout.write("http_experience_completed\n"); process.exitCode = interrupted ?? 0;
  } catch (error) { process.stderr.write(`${safeError(error).code}\n`); process.exitCode = interrupted ?? 1; }
  finally { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
