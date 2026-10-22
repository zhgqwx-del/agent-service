// Explicit, unpaid loopback fixture. Never imports application config, dotenv or a provider client.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPERIENCE_FIXTURE_TOKEN = "fixture-only-no-paid-provider-token";
export const EXPERIENCE_FIXTURE_REPLIES = Object.freeze([
  "Synthetic draft: the record describes a planned visit. What detail should we add?",
  "Synthetic follow-up: we keep the same record and add the supplied detail.",
  "Synthetic revision: the corrected record replaces the earlier version.",
]);
const NOTICE = "Scripted fixture replies do not demonstrate model understanding.";
const MAX_BODY_BYTES = 64 * 1_024;
const MAX_ACTIVE_REQUESTS = 4;
const invalid = () => new Error("experience_fixture_invalid");

export interface ExperienceFixtureDescriptor {
  version: 1;
  kind: "http-experience-fixture-v1";
  baseUrl: string;
  provider: "deepseek";
  model: "deepseek-chat";
  apiKey: typeof EXPERIENCE_FIXTURE_TOKEN;
  maxResponses: number;
  notice: string;
}

export function parseExperienceFixtureArgs(args: readonly string[]): { stateDir: string; maxResponses: number } {
  if ((args.length !== 2 && args.length !== 4) || args[0] !== "--state-dir" || !args[1]
    || !isAbsolute(args[1]) || resolve(args[1]) !== args[1]) throw invalid();
  let maxResponses = 3;
  if (args.length === 4) {
    if (args[2] !== "--max-responses" || !/^(?:3|6|9|12|15|18|21|24|27|30)$/.test(args[3] ?? "")) throw invalid();
    maxResponses = Number(args[3]);
  }
  return { stateDir: args[1], maxResponses };
}

function directoryIdentity(stat: { dev: number; ino: number; uid: number; mode: number }): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
}
async function privateDirectory(path: string): Promise<string> {
  const stat = await lstat(path), uid = process.getuid?.();
  if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
    || (stat.mode & 0o7777) !== 0o700 || await realpath(path) !== path) throw invalid();
  return directoryIdentity(stat);
}
async function newPrivateState(stateDir: string) {
  parseExperienceFixtureArgs(["--state-dir", stateDir]);
  const parent = dirname(stateDir);
  if (parent === stateDir) throw invalid();
  const parentIdentity = await privateDirectory(parent);
  // No recursive mkdir, reuse, overwrite or removal, including after a failed start.
  await mkdir(stateDir, { mode: 0o700 });
  const stateIdentity = await privateDirectory(stateDir);
  const unchanged = async () => {
    if (await privateDirectory(parent) !== parentIdentity || await privateDirectory(stateDir) !== stateIdentity) throw invalid();
  };
  await unchanged();
  return { stateIdentity, unchanged };
}

function json(res: ServerResponse, status: number, code: string) {
  if (res.destroyed) return;
  const body = JSON.stringify({ error: { code, message: code } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
  res.end(body);
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", aborted);
      signal.removeEventListener("abort", aborted);
      if (error) { chunks.length = 0; fail(error); return; }
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); chunks.length = 0;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
        done(body as Record<string, unknown>);
      } catch { fail(invalid()); }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { req.pause(); finish(new Error("body_too_large")); }
      else chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(new Error("request_closed"));
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); };
    const timer = setTimeout(finish, 20);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Same small OpenAI-compatible/deepseek SSE shape as FakeVendor, with no captured request bodies.
 * FakeVendor itself captures before authentication and keeps accepting after its script is empty;
 * wrapping its public API cannot bound those allocations without changing the shared testkit. */
export async function startExperienceFixture(stateDir: string, maxResponses = 3) {
  if (!Number.isInteger(maxResponses) || maxResponses < 3 || maxResponses > 30 || maxResponses % 3 !== 0) throw invalid();
  const stateWitness = await newPrivateState(stateDir);
  const sockets = new Map<Socket, Promise<void>>(), tasks = new Set<Promise<void>>();
  let closing = false, closePromise: Promise<void> | undefined;
  let acceptedRequests = 0, activeRequests = 0, completedResponses = 0, abortedResponses = 0;
  const snapshot = () => Object.freeze({ acceptedRequests, activeRequests, completedResponses, abortedResponses,
    sockets: sockets.size, pendingTasks: tasks.size, capturedRequests: 0 });
  const handle = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => {
    if (closing || activeRequests > MAX_ACTIVE_REQUESTS) return json(res, 503, "fixture_busy");
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, "fixture_not_found");
    if (req.headers.authorization !== `Bearer ${EXPERIENCE_FIXTURE_TOKEN}`) return json(res, 401, "fixture_token_required");
    if (acceptedRequests >= maxResponses) return json(res, 429, "fixture_budget_exhausted");
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return json(res, 400, "fixture_json_required");
    let body: Record<string, unknown>;
    try { body = await readBody(req, signal); }
    catch (error) {
      if (signal.aborted) return;
      res.once("finish", () => req.destroy());
      return json(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, "fixture_invalid_request");
    }
    if (signal.aborted || closing) return;
    if (body.model !== "deepseek-chat" || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 64
      || (body.stream !== undefined && typeof body.stream !== "boolean")) return json(res, 400, "fixture_invalid_request");
    // A concurrent body read may have consumed the final slot. Reservation is synchronous and final;
    // an interrupted response consumes its slot and is never implicitly replayed.
    if (acceptedRequests >= maxResponses) return json(res, 429, "fixture_budget_exhausted");
    const text = EXPERIENCE_FIXTURE_REPLIES[acceptedRequests++ % EXPERIENCE_FIXTURE_REPLIES.length]!;
    const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 };
    const common = { id: "chatcmpl-experience-fixture", created: 0, model: "deepseek-chat" };
    if (body.stream === false) {
      const value = JSON.stringify({ ...common, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(value), connection: "close" });
      res.end(value); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "close" });
    res.flushHeaders();
    const send = (value: unknown) => { if (!signal.aborted) res.write(`data: ${JSON.stringify(value)}\n\n`); };
    const delta = (value: unknown, finish: string | null = null) => send({ ...common, object: "chat.completion.chunk",
      choices: [{ index: 0, delta: value, finish_reason: finish }] });
    delta({ role: "assistant", content: "" });
    const width = Math.ceil(text.length / 4);
    for (let offset = 0; offset < text.length; offset += width) {
      await pause(signal); if (signal.aborted) return;
      delta({ content: text.slice(offset, offset + width) });
    }
    delta({}, "stop"); send({ ...common, object: "chat.completion.chunk", choices: [], usage });
    if (!signal.aborted) res.end("data: [DONE]\n\n");
  };
  const server = createServer({ maxHeaderSize: 8 * 1_024, requestTimeout: 5_000, headersTimeout: 5_000 }, (req, res) => {
    const controller = new AbortController(); activeRequests++;
    req.on("error", () => {});
    res.once("close", () => {
      controller.abort(); activeRequests--;
      if (res.writableFinished) completedResponses++; else abortedResponses++;
    });
    const task = handle(req, res, controller.signal).catch(() => { res.destroy(); });
    tasks.add(task); void task.then(() => tasks.delete(task));
  });
  server.maxConnections = 8;
  server.setTimeout(5_000, (socket) => socket.destroy());
  server.on("connection", (socket) => {
    const closed = new Promise<void>((done) => socket.once("close", () => { sockets.delete(socket); done(); }));
    sockets.set(socket, closed);
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connect", (_req, socket) => socket.destroy());
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    const native = new Promise<void>((done, fail) => server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") fail(error); else done();
    }));
    const nativeSockets = [...sockets.values()];
    for (const socket of sockets.keys()) socket.destroy();
    await Promise.all([native, ...nativeSockets]);
    await Promise.allSettled([...tasks]);
    if (sockets.size || tasks.size || activeRequests) throw new Error("experience_fixture_close_failed");
  })();
  const descriptorPath = join(stateDir, "fixture.json");
  try {
    await stateWitness.unchanged();
    await new Promise<void>((done, fail) => {
      const failed = (error: Error) => { server.off("listening", ready); fail(error); };
      const ready = () => { server.off("error", failed); done(); };
      server.once("error", failed); server.once("listening", ready); server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw invalid();
    const descriptor: Readonly<ExperienceFixtureDescriptor> = Object.freeze({ version: 1, kind: "http-experience-fixture-v1",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, provider: "deepseek", model: "deepseek-chat",
      apiKey: EXPERIENCE_FIXTURE_TOKEN, maxResponses, notice: NOTICE });
    await stateWitness.unchanged();
    const file = await open(descriptorPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) throw invalid();
      await file.writeFile(JSON.stringify(descriptor) + "\n"); await file.sync();
      const visible = await lstat(descriptorPath);
      if (visible.isSymbolicLink() || visible.dev !== stat.dev || visible.ino !== stat.ino || visible.nlink !== 1) throw invalid();
    }
    finally { await file.close(); }
    const directory = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (directoryIdentity(await directory.stat()) !== stateWitness.stateIdentity) throw invalid();
      await directory.sync();
    } finally { await directory.close(); }
    await stateWitness.unchanged();
    return Object.freeze({ descriptor, descriptorPath, snapshot, close });
  } catch (error) { await close(); throw error; }
}

export async function runExperienceFixture(args: readonly string[]): Promise<void> {
  const { stateDir, maxResponses } = parseExperienceFixtureArgs(args);
  let fixture: Awaited<ReturnType<typeof startExperienceFixture>> | undefined;
  let requested = false, stopping = false;
  let done!: () => void, fail!: (error: unknown) => void;
  const stopped = new Promise<void>((resolveDone, reject) => { done = resolveDone; fail = reject; });
  const stop = () => {
    requested = true;
    if (!fixture || stopping) return;
    stopping = true;
    void fixture.close().then(() => {
      process.stdout.write(JSON.stringify({ status: "closed", descriptorPath: fixture!.descriptorPath, ...fixture!.snapshot() }) + "\n"); done();
    }, fail);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    fixture = await startExperienceFixture(stateDir, maxResponses);
    if (requested) stop();
    else process.stdout.write(JSON.stringify({ status: "ready", descriptorPath: fixture.descriptorPath }) + "\n");
    await stopped;
  } finally {
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await fixture?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runExperienceFixture(process.argv.slice(2)).catch(() => {
    process.stderr.write("experience_fixture_failed\n"); process.exitCode = 1;
  });
}
