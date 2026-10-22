import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type Options = { config: string; output: string };
type Result = { status: string; sessionId: string; turnIds: string[]; recordVersions: number[];
  exactReplayConfirmed: boolean; upstreamDispatchCountIndependentlyObserved: boolean };
let experience: {
  parseHttpExperienceArgs(args: string[]): Options | { help: true };
  parseHttpExperienceConfig(text: string): { baseUrl: string; agentVersion: number; requestTimeoutMs: number; operationTimeoutMs: number };
  runHttpExperience(options: Options, dependencies?: { signal?: AbortSignal }): Promise<Result>;
};
const modulePath = fileURLToPath(new URL("../scripts/ops/http-experience.mjs", import.meta.url));
beforeAll(async () => { experience = await import(new URL("../scripts/ops/http-experience.mjs", import.meta.url).href) as typeof experience; });
const AGENT = "agt_00000000-0000-7000-8000-000000000001";
const SESSION = "sess_00000000-0000-7000-8000-000000000002";
const SECRET = "fixture-service-secret-never-print";
const USER = "http_fixture_user";
const turnId = (index: number) => `turn_00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body));
};
function config(baseUrl = "http://127.0.0.1:62001") {
  return { BASE_URL: baseUrl, SERVICE_API_KEY: SECRET, USER_ID: USER, AGENT_ID: AGENT, AGENT_VERSION: "1",
    MODEL_CALL_ACK: "allow-model-calls-v1", REQUEST_TIMEOUT_MS: "3000", OPERATION_TIMEOUT_MS: "15000" };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "agent-http-experience-")));
  await chmod(path, 0o700); return path;
}
async function readJson(path: string): Promise<Json> { return JSON.parse(await readFile(path, "utf8")) as Json; }

type Captured = { method: string; path: string; body: Json | undefined; key: string | undefined; authorization: string | undefined };
type Hook = (request: IncomingMessage, response: ServerResponse, body: Json | undefined) => boolean | Promise<boolean>;
async function nativeFixture(hook?: Hook) {
  const dir = await directory(), values = config(), options = { config: join(dir, "config.json"), output: join(dir, "output") };
  const requests: Captured[] = [], errors: unknown[] = [], sockets = new Set<Socket>(), responses = new Set<ServerResponse>();
  const completed: Json[] = [], events: Json[] = [], bodies = new Map<string, string>();
  let closing = false;
  const session = { id: SESSION, userId: USER, tenantId: "fixture-tenant", agentId: AGENT, agentVersion: 1, status: { type: "idle" } };
  const sse = async (response: ServerResponse, frames: Json[]) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    // Deliberately split UTF-8 and CRLF across native writes. Keep the response open after terminal.
    const wire = Buffer.from(": heartbeat\r\n\r\n" + frames.map(frame => `id: ${String(frame.seq)}\r\nevent: ${String(frame.type)}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join(""));
    for (let offset = 0; offset < wire.length && !response.destroyed; offset += 13) {
      response.write(wire.subarray(offset, offset + 13)); await new Promise<void>(done => setImmediate(done));
    }
  };
  const server = createServer((request, response) => {
    responses.add(response); response.once("close", () => responses.delete(response));
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json : undefined;
      const path = request.url ?? "", url = new URL(path, "http://fixture");
      requests.push({ method: request.method ?? "", path, body, key: request.headers["idempotency-key"] as string | undefined,
        authorization: request.headers.authorization });
      if (hook && await hook(request, response, body)) return;
      if (request.headers.authorization !== `Bearer ${SECRET}` || request.headers["x-user-id"] !== USER) {
        json(response, 401, { error: SECRET }); return;
      }
      if (request.method === "POST" && path === "/v1/sessions") { json(response, 201, session); return; }
      if (request.method === "GET" && path === `/v1/sessions/${SESSION}`) { json(response, 200, session); return; }
      if (request.method === "POST" && url.pathname === `/v1/sessions/${SESSION}/turns`) {
        const key = request.headers["idempotency-key"] as string;
        if (bodies.has(key)) {
          if (bodies.get(key) !== JSON.stringify(body)) { json(response, 409, { error: "idempotency_conflict" }); return; }
          const turn = completed.find(value => value.idempotencyKey === key);
          json(response, 200, { turn }, { "idempotency-replayed": "true" }); return;
        }
        bodies.set(key, JSON.stringify(body));
        const index = completed.length + 1, base = events.length;
        const turn = { id: turnId(index), sessionId: SESSION, status: "completed", stopReason: "end_turn",
          seqStart: base + 1, seqEnd: base + 3, steps: 1, toolCalls: 0, idempotencyKey: key, usage: {},
          [SECRET]: SECRET };
        const item = { id: `item_${index}`, sessionId: SESSION, turnId: turn.id, status: "completed", type: "agentMessage",
          text: `合成回答${index} 青禾二期`, [SECRET]: SECRET };
        completed.push(turn);
        const frames = [
          { sessionId: SESSION, seq: base + 1, type: "turn/started", turn: { ...turn, status: "inProgress" } },
          { sessionId: SESSION, seq: base + 2, type: "item/completed", item },
          { sessionId: SESSION, seq: base + 3, type: "turn/completed", stopReason: "end_turn", turn },
        ];
        events.push(...frames); await sse(response, frames); return;
      }
      if (request.method === "GET" && url.pathname === `/v1/sessions/${SESSION}/turns`) { json(response, 200, { data: completed, nextCursor: null }); return; }
      const turn = completed.find(value => path === `/v1/sessions/${SESSION}/turns/${String(value.id)}`);
      if (turn) { json(response, 200, turn); return; }
      if (request.method === "GET" && url.pathname === `/v1/sessions/${SESSION}/items`) {
        const selected = events.filter(value => value.type === "item/completed")
          .map(value => value.item as Json).filter(value => value.turnId === url.searchParams.get("turnId"));
        json(response, 200, { data: selected, nextCursor: null }); return;
      }
      if (request.method === "GET" && url.pathname === `/v1/sessions/${SESSION}/events`) {
        await sse(response, events.filter(value => Number(value.seq) > Number(url.searchParams.get("after")))); return;
      }
      json(response, 404, { error: "unexpected_endpoint" });
    })().catch(error => { if (!closing) errors.push(error); if (!response.headersSent) json(response, 500, { error: "fixture_failed" }); else response.destroy(); });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener not established");
  values.BASE_URL = `http://127.0.0.1:${address.port}`;
  const saveConfig = () => writeFile(options.config, JSON.stringify(values), { mode: 0o600 }); await saveConfig();
  return { dir, options, values, requests, completed, events, errors, saveConfig,
    async close() {
      closing = true;
      const closed = [...sockets].map(socket => new Promise<void>(done => { socket.once("close", () => done()); socket.destroy(); }));
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await Promise.all(closed); await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("HTTP experience protected client", () => {
  it("accepts only the explicit run shape or help, without a resume or inherited authority", () => {
    expect(experience.parseHttpExperienceArgs(["--help"])).toEqual({ help: true });
    expect(experience.parseHttpExperienceArgs(["run", "--config", "/private/config.json", "--output", "/private/new-run"]))
      .toEqual({ config: "/private/config.json", output: "/private/new-run" });
    for (const args of [[], ["inspect", "--output", "/private/run"], ["run", "--config", "relative.json", "--output", "/private/run"],
      ["run", "--config", "/private/config.json", "--config", "/private/other.json"],
      ["run", "--config", "/private/config.json", "--output", "/private/run", "--key", SECRET]])
      expect(() => experience.parseHttpExperienceArgs(args)).toThrow("http_experience_invalid");
  });

  it("requires a closed string-map with explicit origin, identity, fixed version, ACK and bounded deadlines", () => {
    expect(experience.parseHttpExperienceConfig(JSON.stringify(config()))).toMatchObject({ baseUrl: "http://127.0.0.1:62001", agentVersion: 1 });
    expect(experience.parseHttpExperienceConfig(JSON.stringify(config("https://service.example")))).toMatchObject({ baseUrl: "https://service.example" });
    expect(experience.parseHttpExperienceConfig(JSON.stringify(config("http://[::1]:62001")))).toMatchObject({ baseUrl: "http://[::1]:62001" });
    for (const patch of [{ BASE_URL: "http://127.0.0.1" }, { BASE_URL: "http://localhost:8080" }, { BASE_URL: "http://service.example:8080" },
      { BASE_URL: "https://user:pass@service.example" }, { BASE_URL: "https://service.example/v1" }, { BASE_URL: "https://service.example?" },
      { BASE_URL: "https://service.example/#" }, { BASE_URL: "http://127.0.0.1:0" }, { BASE_URL: "http://127.0.0.1:65536" },
      { SERVICE_API_KEY: "bad\r\nheader" }, { AGENT_ID: "../../agent" }, { AGENT_VERSION: "0" }, { AGENT_VERSION: "1.5" },
      { USER_ID: "wrong user" }, { MODEL_CALL_ACK: "fake-model" }, { REQUEST_TIMEOUT_MS: "99" }, { REQUEST_TIMEOUT_MS: "120001" },
      { OPERATION_TIMEOUT_MS: "600001" }, { OPERATION_TIMEOUT_MS: "100" }, { EXTRA_AUTHORITY: "" }])
      expect(() => experience.parseHttpExperienceConfig(JSON.stringify({ ...config(), ...patch }))).toThrow("http_experience_invalid");
    for (const input of ['{"BASE_URL":"a","BASE_URL":"b"}', '{"BASE_URL":1}', '[]', JSON.stringify({ ...config(), USER_ID: null }),
      JSON.stringify(Object.fromEntries(Object.entries(config()).filter(([key]) => key !== "SERVICE_API_KEY")))])
      expect(() => experience.parseHttpExperienceConfig(input)).toThrow("http_experience_invalid");
  });

  it.each(["file_mode", "parent_mode", "file_symlink", "ancestor_symlink", "existing_output", "hardlink"] as const)
    ("rejects %s before any HTTP and never overwrites existing evidence", async fault => {
      const f = await nativeFixture();
      try {
        if (fault === "file_mode") await chmod(f.options.config, 0o644);
        if (fault === "parent_mode") await chmod(f.dir, 0o755);
        if (fault === "file_symlink") { const target = join(f.dir, "secret.json"); await writeFile(target, JSON.stringify(f.values), { mode: 0o600 }); await rm(f.options.config); await symlink(target, f.options.config); }
        if (fault === "ancestor_symlink") { await symlink(f.dir, join(f.dir, "alias")); f.options.config = join(f.dir, "alias", "config.json"); }
        if (fault === "existing_output") { await mkdir(f.options.output, { mode: 0o700 }); await writeFile(join(f.options.output, "retained"), "retained", { mode: 0o600 }); }
        if (fault === "hardlink") { const { link } = await import("node:fs/promises"); await link(f.options.config, join(f.dir, "other.json")); }
        await expect(experience.runHttpExperience(f.options)).rejects.toMatchObject({ code: expect.stringMatching(/^http_experience_/) });
        expect(f.requests).toHaveLength(0);
        if (fault === "existing_output") expect(await readFile(join(f.options.output, "retained"), "utf8")).toBe("retained");
      } finally { await chmod(f.dir, 0o700); await f.close(); }
    });

  it("runs three native chunked SSE turns, confirms durable answers/exact replay and preserves only private redacted evidence", async context => {
    const f = await nativeFixture();
    try {
      const result = await experience.runHttpExperience(f.options, { signal: context.signal });
      expect(result).toMatchObject({ status: "completed", sessionId: SESSION, recordVersions: [1, 2, 2], exactReplayConfirmed: true,
        upstreamDispatchCountIndependentlyObserved: false });
      expect(result.turnIds).toEqual([turnId(1), turnId(2), turnId(3)]);
      expect(f.completed).toHaveLength(3);
      const posted = f.requests.filter(value => value.method === "POST"); expect(posted).toHaveLength(5);
      expect(posted[0]!.body).toMatchObject({ agentId: AGENT, agentVersion: 1 });
      expect(posted[4]!.key).toBe(posted[1]!.key); expect(posted[4]!.body).toEqual(posted[1]!.body);
      expect(new Set(posted.slice(1, 4).map(value => value.key)).size).toBe(3);
      expect(posted.slice(1).every(value => value.path.startsWith(`/v1/sessions/${SESSION}/turns?`))).toBe(true);
      expect(f.requests.some(value => value.path.startsWith("/v1/agents"))).toBe(false);
      expect(f.requests.every(value => value.authorization === `Bearer ${SECRET}`)).toBe(true);
      for (const [index, version] of [1, 2, 2].entries()) {
        const body = posted[index + 1]!.body!;
        expect(body.metadata).toMatchObject({ recordVersion: version });
        const input = body.input as { text: string }[];
        expect(JSON.parse(input[0]!.text.split("\n")[1]!)).toMatchObject({ version });
        const output = await readJson(join(f.options.output, `turn-${index + 1}-response.json`));
        expect(output).toMatchObject({ sessionId: SESSION, recordVersion: version, answer: `合成回答${index + 1} 青禾二期` });
      }
      const replay = await readJson(join(f.options.output, "events-response.json"));
      expect(replay).toMatchObject({ after: 3, through: 9 });
      const names = await readdir(f.options.output);
      expect(names).toContain("run.json"); expect(names).toContain("result.json"); expect(names).not.toContain("failure.json");
      expect((await lstat(f.options.output)).mode & 0o777).toBe(0o700);
      for (const name of names) {
        expect((await lstat(join(f.options.output, name))).mode & 0o777).toBe(0o600);
        const text = await readFile(join(f.options.output, name), "utf8");
        expect(text).not.toContain(SECRET); expect(text).not.toContain('"authorization"');
        expect(() => JSON.parse(text)).not.toThrow();
      }
      expect(await readFile(join(f.options.output, "turn-1-stream.json"), "utf8")).toContain("[redacted-service-key]");
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("fsyncs request identity before ambiguous session dispatch and never retries an unknown create", async context => {
    const f = await nativeFixture(async (request, response) => {
      if (request.method !== "POST") return false;
      const identity = await readJson(join(f.options.output, "session-request.json"));
      expect(identity).toMatchObject({ method: "POST", path: "/v1/sessions", body: { agentId: AGENT, agentVersion: 1 } });
      response.destroy(); return true;
    });
    try {
      await expect(experience.runHttpExperience(f.options, { signal: context.signal })).rejects.toMatchObject({ code: "http_experience_transport_failed" });
      expect(f.requests).toHaveLength(1);
      expect(await readJson(join(f.options.output, "failure.json"))).toMatchObject({ status: "unknown", pendingSubmission: { name: "session" }, automaticSubmissionRetry: false });
      await expect(experience.runHttpExperience(f.options)).rejects.toBeDefined(); expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  for (const fault of ["cut_stream", "missing_blank_line", "bad_utf8", "oversized_frame", "event_limit", "bad_terminal"] as const)
    it(`retains first-turn identity as unknown on ${fault} and does not submit a second turn`, async context => {
      const f = await nativeFixture((request, response) => {
        if (request.method !== "POST" || !request.url?.includes("/turns")) return false;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const base = { sessionId: SESSION, seq: 1, type: "turn/completed", stopReason: "end_turn",
          turn: { id: turnId(1), sessionId: SESSION, status: "completed", stopReason: "end_turn" } };
        if (fault === "cut_stream") { response.end('id: 1\ndata: {"secret":"upstream-sensitive-body'); }
        if (fault === "missing_blank_line") response.end(`id: 1\ndata: ${JSON.stringify(base)}\n`);
        if (fault === "bad_utf8") response.end(Buffer.from([0xc3, 0x28]));
        if (fault === "oversized_frame") response.end(`data: ${"x".repeat(70_000)}`);
        if (fault === "event_limit") response.end(Array.from({ length: 513 }, (_, index) => `id: ${index + 1}\ndata: ${JSON.stringify({ sessionId: SESSION, seq: index + 1, type: "session/status/changed", status: { type: "active" } })}\n\n`).join(""));
        if (fault === "bad_terminal") response.end(`id: 1\ndata: ${JSON.stringify({ ...base, turn: { ...base.turn, status: "failed" } })}\n\n`);
        return true;
      });
      try {
        await expect(experience.runHttpExperience(f.options, { signal: context.signal })).rejects.toMatchObject({ code: expect.stringMatching(/^http_experience_/) });
        expect(f.requests.filter(value => value.method === "POST" && value.path.includes("/turns"))).toHaveLength(1);
        expect(await readJson(join(f.options.output, "failure.json"))).toMatchObject({ status: "unknown", pendingSubmission: { name: "turn-1" } });
        expect(await readFile(join(f.options.output, "failure.json"), "utf8")).not.toContain("upstream-sensitive-body");
        expect(await readJson(join(f.options.output, "turn-1-request.json"))).toHaveProperty("idempotencyKey");
      } finally { await f.close(); }
    });

  it("rejects a native redirect without following or forwarding credentials to its target", async context => {
    let targetRequests = 0;
    const target = createServer((_request, response) => { targetRequests++; response.end("not allowed"); });
    await new Promise<void>(done => target.listen(0, "127.0.0.1", done));
    const address = target.address(); if (!address || typeof address === "string") throw new Error("target listener not established");
    const f = await nativeFixture((_request, response) => { response.writeHead(307, { location: `http://127.0.0.1:${address.port}/stolen` }); response.end(SECRET); return true; });
    try {
      await expect(experience.runHttpExperience(f.options, { signal: context.signal })).rejects.toMatchObject({ code: "http_experience_http_rejected" });
      expect(targetRequests).toBe(0); expect(f.requests).toHaveLength(1);
    } finally { await f.close(); await new Promise<void>(done => target.close(() => done())); }
  });

  it("bounds native JSON responses and retains unknown rather than trusting a truncated session result", async context => {
    const f = await nativeFixture((_request, response) => { response.writeHead(201, { "content-type": "application/json" }); response.end(JSON.stringify({ padding: "x".repeat(1_048_577) })); return true; });
    try {
      await expect(experience.runHttpExperience(f.options, { signal: context.signal })).rejects.toMatchObject({ code: "http_experience_response_limit" });
      expect(f.requests).toHaveLength(1); expect(await readJson(join(f.options.output, "failure.json"))).toMatchObject({ status: "unknown" });
    } finally { await f.close(); }
  });

  for (const kind of ["cancel", "request_timeout", "operation_timeout"] as const)
    it(`joins native HTTP close after ${kind} without claiming cancellation of a server turn`, async context => {
      const received = deferred(), remoteClosed = deferred();
      const f = await nativeFixture((_request, response) => { response.once("close", remoteClosed.resolve); received.resolve(); return true; });
      const controller = new AbortController(), cancel = () => controller.abort();
      context.signal.addEventListener("abort", cancel, { once: true });
      let pending: Promise<Result> | undefined;
      try {
        if (kind !== "cancel") {
          f.values.REQUEST_TIMEOUT_MS = kind === "operation_timeout" ? "1000" : "500";
          f.values.OPERATION_TIMEOUT_MS = kind === "operation_timeout" ? "1000" : "5000";
          await f.saveConfig();
        }
        pending = experience.runHttpExperience(f.options, { signal: controller.signal });
        const outcome = pending.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
        // If preparation fails or expires, fail this boundary instead of hanging on an unreceived request.
        expect(await Promise.race([received.promise.then(() => true), outcome.then(() => false)])).toBe(true);
        if (kind === "cancel") controller.abort();
        expect((await outcome).error).toMatchObject({ code: `http_experience_${kind === "cancel" ? "cancelled" : kind}` });
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([remoteClosed.promise, new Promise<void>((_done, reject) => {
            closeTimer = setTimeout(() => reject(new Error("native HTTP peer close was not observed")), 2_000);
          })]);
        } finally { clearTimeout(closeTimer); }
        expect(f.requests).toHaveLength(1);
        expect(await readJson(join(f.options.output, "failure.json"))).toMatchObject({ status: "unknown", serverTurnCancellationClaimed: false });
      } finally { context.signal.removeEventListener("abort", cancel); controller.abort(); await pending?.catch(() => {}); await f.close(); }
    });

  it("reports authentication failure with a closed CLI code and never prints key, response body or native error text", async context => {
    const f = await nativeFixture((_request, response) => { json(response, 401, { error: `${SECRET}: upstream-sensitive-body` }); return true; });
    let child: ReturnType<typeof spawn> | undefined;
    const cancel = () => { child?.kill("SIGTERM"); }; context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
        child = spawn(process.execPath, [modulePath, "run", "--config", f.options.config, "--output", f.options.output],
          { env: { PATH: process.env.PATH, HOME: f.dir }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout!.on("data", value => { stdout += String(value); }); child.stderr!.on("data", value => { stderr += String(value); });
        child.once("error", reject); child.once("close", code => done({ code, stdout, stderr }));
      });
      expect(output).toEqual({ code: 1, stdout: "", stderr: "http_experience_http_rejected\n" });
      expect(JSON.stringify(output)).not.toContain(SECRET); expect(JSON.stringify(output)).not.toContain("upstream-sensitive-body");
      expect(f.requests).toHaveLength(1);
    } finally { context.signal.removeEventListener("abort", cancel); child?.kill("SIGTERM"); await f.close(); }
  });

  it("rejects a wrong replay turn instead of claiming idempotence or automatically trying another key", async context => {
    let posts = 0;
    const f = await nativeFixture((request, response) => {
      if (request.method !== "POST" || !request.url?.includes("/turns")) return false;
      if (++posts !== 4) return false;
      json(response, 200, { turn: { id: turnId(99), sessionId: SESSION, status: "completed", stopReason: "end_turn" } }, { "idempotency-replayed": "true" }); return true;
    });
    try {
      await expect(experience.runHttpExperience(f.options, { signal: context.signal })).rejects.toMatchObject({ code: "http_experience_protocol_failed" });
      expect(posts).toBe(4); expect(f.completed).toHaveLength(3);
      expect(await readJson(join(f.options.output, "failure.json"))).toMatchObject({ status: "unknown", pendingSubmission: { name: "turn-1-replay" } });
      expect(await readdir(f.options.output)).not.toContain("result.json");
    } finally { await f.close(); }
  });
});
