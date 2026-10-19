import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { newId } from "@agent-service/core";
import { AgentDefinition, Capabilities, Event, Item, ResolvedSkillContext, ResumeSessionResponse, Session, Turn, type PersistedEvent } from "@agent-service/protocol";
import { FakeVendor } from "@agent-service/testkit";
import { startRouter } from "../../../agent-router/src/main.js";
import { hashApiKey } from "../../src/auth.js";
import { startRunner } from "../../src/main.js";

// Source bootstrap only: real runner/router/Pi/static source/auth plus local HTTP FakeVendor.
// Default stores/leases/bus are owned Memory implementations in this Vitest process. The explicit
// MySQL profile accepts only the wrapper's new random loopback fixture database; leases/bus remain
// Memory. Neither profile proves independent OS-process, dist, Redis, public TLS or cloud behavior.
const OWNER = { tenantId: "tenant_skills_vertical", userId: "owner-skills" };
const CALLER = { ...OWNER, userId: "trusted-caller-skills" };
const MOUNT_ID = "Operator_release-guide";
const SKILL_NAME = "release-guide";
const CALL_ID = "call_static_skill_vertical";
const BODY_MARKER = "STATIC_SKILL_VERIFIED_BODY_MARKER";
const REFERENCE_CONTENT = "REFERENCE_FILE_CONTENT_MUST_NOT_BE_MATERIALIZED";
const FINAL_TEXT = "The verified static skill result reached the second model request.";
const signals = ["SIGTERM", "SIGINT"] as const;
type Signal = (typeof signals)[number];
type SignalListeners = Map<Signal, NodeJS.SignalsListener[]>;
function signalListeners(): SignalListeners { return new Map(signals.map(signal => [signal, process.listeners(signal)])); }
function addedListeners(before: SignalListeners): SignalListeners {
  return new Map(signals.map(signal => [signal, process.listeners(signal).filter(listener => !before.get(signal)!.includes(listener))]));
}
function failed(): never { throw new Error("Static skills vertical fixture failed."); }
async function unusedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", () => reject(new Error("Skills fixture port unavailable."))); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); if (!address || typeof address === "string") failed();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(new Error("Skills fixture port unavailable.")) : resolve()));
  return address.port;
}
async function listeningUrl(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", error); resolve(); };
    const error = () => { server.off("listening", ready); reject(new Error("Skills fixture listener unavailable.")); };
    server.once("listening", ready); server.once("error", error);
  });
  const address = server.address(); if (!address || typeof address === "string") failed();
  return `http://127.0.0.1:${address.port}`;
}
function nativeClose(server: HttpServer): Promise<void> { return server.listening ? new Promise(resolve => server.once("close", () => resolve())) : Promise.resolve(); }
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal): Promise<T> {
  const until = Date.now() + 10_000;
  while (!signal.aborted && Date.now() < until) {
    const result = await read(); if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Static skills vertical fixture timed out.");
}

/** A bounded local HTTP gate, not a model/source/Host stub. It forwards only the fixed model path
 * to the real FakeVendor HTTP server. Holding the first request makes the public SSE disconnect
 * deterministic; all other paths are a canary for forbidden remote skill-resource materialization. */
class ModelGate {
  modelRequests = 0;
  resourceRequests = 0;
  private server?: HttpServer;
  private accepting = false;
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly exchanges = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private releaseFirst!: () => void;
  private readonly first = new Promise<void>(resolve => { this.releaseFirst = resolve; });
  constructor(private readonly vendorUrl: string, private readonly key: string, private readonly beforeSecond?: () => Promise<void>) {
    const url = new URL(vendorUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1" || url.username || url.password || url.hash || url.search) failed();
  }
  get closed(): boolean { return this.server === undefined && this.sockets.size === 0 && this.exchanges.size === 0 && this.controllers.size === 0; }
  release(): void { this.releaseFirst(); }
  async start(): Promise<string> {
    const server = createHttpServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 15_000 }, (request, response) => {
      const exchange = this.handle(request, response).catch(() => {
        if (!response.destroyed && !response.headersSent) { response.writeHead(500, { connection: "close" }); response.end(); }
        else response.destroy();
      }).finally(() => this.exchanges.delete(exchange));
      this.exchanges.add(exchange);
    });
    this.server = server;
    server.on("connection", socket => {
      const closed = new Promise<void>(resolve => socket.once("close", () => { this.sockets.delete(socket); resolve(); }));
      socket.on("error", () => {}); this.sockets.set(socket, closed);
    });
    await new Promise<void>((resolve, reject) => {
      const error = () => reject(new Error("Skills model gate listener failed.")); server.once("error", error);
      server.listen(0, "127.0.0.1", () => { server.off("error", error); resolve(); });
    });
    this.accepting = true; return listeningUrl(server);
  }
  async stop(): Promise<void> {
    this.accepting = false; this.release();
    const closed = this.server?.listening ? new Promise<void>(resolve => this.server!.close(() => resolve())) : Promise.resolve();
    for (const controller of this.controllers) controller.abort();
    const socketClosures = [...this.sockets.values()]; for (const socket of this.sockets.keys()) socket.destroy();
    await Promise.all([closed, ...socketClosures]);
    while (this.exchanges.size) await Promise.all([...this.exchanges]);
    this.server = undefined;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.shouldKeepAlive = false;
    if (!this.accepting) { response.writeHead(503, { connection: "close" }); response.end(); return; }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      this.resourceRequests++; response.writeHead(404, { connection: "close" }); response.end(); return;
    }
    if (request.headers.authorization !== `Bearer ${this.key}`) failed();
    const ordinal = ++this.modelRequests; if (ordinal > 2) failed();
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort(); const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    request.once("aborted", abort); request.once("error", abort); response.once("error", abort); response.once("close", disconnected);
    const timer = setTimeout(() => { controller.abort(); response.destroy(); }, 15_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > 262_144 || controller.signal.aborted) failed(); chunks.push(bytes); }
      if (ordinal === 1) {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(new Error("Skills model gate cancelled."));
          controller.signal.addEventListener("abort", cancel, { once: true });
          this.first.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancel)).catch(() => {});
          if (controller.signal.aborted) cancel();
        });
      }
      if (controller.signal.aborted) failed();
      if (ordinal === 2) await this.beforeSecond?.();
      if (controller.signal.aborted) failed();
      const upstream = await fetch(new URL("/v1/chat/completions", this.vendorUrl), { method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: new Uint8Array(Buffer.concat(chunks, size)), signal: controller.signal });
      if (!upstream.body) failed(); reader = upstream.body.getReader();
      const reply: Buffer[] = []; let received = 0;
      for (;;) { const next = await reader.read(); if (next.done) break; received += next.value.byteLength;
        if (received > 1_048_576) failed(); reply.push(Buffer.from(next.value)); }
      if (controller.signal.aborted || response.destroyed) return;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream", connection: "close" });
      response.end(Buffer.concat(reply, received));
    } finally {
      clearTimeout(timer); request.off("aborted", abort); request.off("error", abort);
      response.off("error", abort); response.off("close", disconnected); this.controllers.delete(controller);
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
    }
  }
}

interface Frame { id?: number; data: Event }
interface Sse { frames: Frame[]; ready: Promise<Response>; done: Promise<void>; healthy(): void; close(): Promise<void> }
function openSse(url: string, headers: RequestInit["headers"], lifetime: AbortSignal, init: RequestInit = {}): Sse {
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime]);
  const frames: Frame[] = []; let unhealthy = false;
  const ready = fetch(url, { ...init, headers, signal });
  const done = (async () => {
    const response = await ready;
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      await response.body?.cancel(); throw new Error("Skills fixture expected SSE.");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", bytes = 0;
    try { for (;;) {
      const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 1_048_576) failed();
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n"); let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = /^event: ?(.*)$/m.exec(block)?.[1];
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!kind || !data) continue; const event = Event.parse(JSON.parse(data));
        if (kind !== event.type || frames.length >= 256) failed();
        const id = /^id: ?(.*)$/m.exec(block)?.[1]; if (id !== undefined && !/^\d+$/.test(id)) failed();
        frames.push({ ...(id === undefined ? {} : { id: Number(id) }), data: event });
      }
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  })().catch(() => { if (!signal.aborted) unhealthy = true; });
  return { frames, ready, done, healthy: () => { if (unhealthy) throw new Error("Skills fixture SSE failed."); },
    close: async () => { abort.abort(); await done; if (unhealthy) throw new Error("Skills fixture SSE failed."); } };
}
function persisted(stream: Sse): PersistedEvent[] { return stream.frames.flatMap(frame => typeof frame.data.seq === "number" ? [frame.data as PersistedEvent] : []); }

export interface SkillsBeforeSecondModel {
  owner: typeof OWNER;
  sessionId: string;
  mountId: string;
  skillName: string;
  toolCallId: string;
  body: string;
  contentSha256: string;
}
export interface SkillsVerticalOptions {
  /** Only a fresh absent-checked database owned by the isolated MySQL wrapper. */
  mysqlUrl?: string;
  /** Prepared by the owning wrapper; never operator credentials or migration authority. */
  mysqlRuntimeEnv?: Readonly<Record<string, string>>;
  /** Runs before HTTP request 2 is forwarded to FakeVendor, with request 1 fully consumed. */
  onBeforeSecondModelRequest?: (expected: SkillsBeforeSecondModel) => Promise<void>;
  /** Called only after every owned listener, store, signal and exit-spy cleanup succeeds. */
  onOwnedServicesClosed?: () => void;
}
export interface SkillsVerticalResult {
  profile: "source-memory-only" | "source-mysql-only";
  owner: typeof OWNER;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  skillContext: ResolvedSkillContext;
  toolResultText: string;
  finalText: string;
  contentSha256: string;
  versionSha256: string;
  finalSeq: number;
}
function isolatedMysqlUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw), database = decodeURIComponent(url.pathname.slice(1));
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^agent_service_skills_vertical_test_[0-9a-f]{24}$/.test(database) || !url.username || url.search || url.hash) failed();
    return url.toString();
  } catch { throw new Error("Skills MySQL profile requires an owned isolated loopback fixture database."); }
}
export async function runSkillsVertical(options: SkillsVerticalOptions = {}): Promise<SkillsVerticalResult> {
  const mysqlUrl = isolatedMysqlUrl(options.mysqlUrl);
  const mysqlRuntimeEnv = options.mysqlRuntimeEnv;
  const runtimeKeys = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
  if ((mysqlUrl !== undefined) !== (mysqlRuntimeEnv !== undefined)
    || mysqlRuntimeEnv !== undefined && (Object.keys(mysqlRuntimeEnv).length !== runtimeKeys.length
      || Object.keys(mysqlRuntimeEnv).some(key => !runtimeKeys.includes(key))
      || runtimeKeys.some(key => typeof mysqlRuntimeEnv[key] !== "string" || !mysqlRuntimeEnv[key]))) {
    throw new Error("Skills MySQL vertical requires an explicit prepared runtime environment.");
  }
  vi.stubEnv("NODE_ENV", "test");
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const initialListeners = signalListeners(); let routerListeners: SignalListeners = new Map();
  const lifetime = new AbortController(), deadline = setTimeout(() => lifetime.abort(), 45_000);
  const bootstrapKey = `skills-vertical-${randomBytes(16).toString("hex")}`, otherKey = `skills-other-${randomBytes(16).toString("hex")}`;
  const providerKey = "skills-vertical-local-fake-provider-key", internalToken = `skills-internal-${randomBytes(24).toString("hex")}`;
  const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey });
  let gateway: ModelGate | undefined, scratch: string | undefined;
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined, router: Awaited<ReturnType<typeof startRouter>> | undefined;
  let sessionId: string | undefined, startupUncertain = false;
  let expectedDocument: { body: string; contentSha256: string } | undefined;
  const streams: Sse[] = [];
  const headers = (userId = OWNER.userId, key = bootstrapKey) => ({ authorization: `Bearer ${key}`, "x-user-id": userId, "content-type": "application/json" });
  const json = async (base: string, path: string, init: RequestInit = {}, userId = OWNER.userId, key = bootstrapKey) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: headers(userId, key), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) });
    const body: unknown = await response.json(); return { status: response.status, body };
  };
  try {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-service-skills-vertical-")));
    vendor.script({ toolCalls: [{ id: CALL_ID, name: "skill", args: JSON.stringify({ name: SKILL_NAME }), argChunks: 3 }] }, { text: FINAL_TEXT });
    const vendorUrl = await vendor.start();
    gateway = new ModelGate(vendorUrl, providerKey, async () => {
      if (!sessionId || !expectedDocument) failed();
      expect(vendor.requests.length).toBe(1);
      await options.onBeforeSecondModelRequest?.({ owner: { ...OWNER }, sessionId, mountId: MOUNT_ID,
        skillName: SKILL_NAME, toolCallId: CALL_ID, ...expectedDocument });
      expect(vendor.requests.length).toBe(1);
    });
    const gateUrl = await gateway.start();
    const directory = join(scratch, "operator-mounted"); await mkdir(directory, { mode: 0o700 });
    await mkdir(join(directory, "references"), { mode: 0o700 }); await mkdir(join(directory, "scripts"), { mode: 0o700 });
    const scriptMarker = join(scratch, "script-executed");
    await writeFile(join(directory, "references", "private.txt"), REFERENCE_CONTENT, { mode: 0o600, flag: "wx" });
    await writeFile(join(directory, "scripts", "must-not-run.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(scriptMarker)}, "unexpected execution");\n`, { mode: 0o600, flag: "wx" });
    const skillBody = `${BODY_MARKER}\nWrite a short release explanation.\n[Local reference](references/private.txt)\n[Remote reference](${gateUrl}/resources/private.txt)\n\n\`\`\`sh\nnode scripts/must-not-run.mjs\n\`\`\`\n`;
    const skillFile = `---\nname: ${SKILL_NAME}\ndescription: Explain a local release safely.\nwhenToUse: When asked for release guidance.\ndisable-model-invocation: false\nuser-invocable: true\ndependencies:\n  tools: []\n---\n${skillBody}`;
    const contentSha256 = createHash("sha256").update(skillFile).digest("hex");
    expectedDocument = { body: skillBody, contentSha256 };
    await writeFile(join(directory, "SKILL.md"), skillFile, { mode: 0o600, flag: "wx" });
    const runnerPort = await unusedLoopbackPort(); startupUncertain = true;
    runner = await startRunner({ NODE_ENV: "test", STORE: mysqlUrl ? "mysql" : "memory", ...mysqlRuntimeEnv,
      RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
      RUNNER_ADDR: `127.0.0.1:${runnerPort}`, RUNNER_ID: `skills-vertical-${randomBytes(6).toString("hex")}`,
      SECRETS_MASTER_KEY: randomBytes(32).toString("hex"), BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: OWNER.tenantId,
      INTERNAL_ROUTER_TOKEN: internalToken, PLATFORM_PROVIDER: "deepseek", DEFAULT_MODEL: "deepseek-chat", API_KEY: providerKey, API_BASE_URL: `${gateUrl}/v1`,
      BLOB_STORE: "filesystem", BLOB_DIR: join(scratch, "blobs"), BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      SKILLS_ENABLED: "1", SKILLS_CONFIG_JSON: JSON.stringify([{ id: MOUNT_ID, directory, subjects: [OWNER] }]),
      BLOB_CLEANUP_ENABLED: "0", ERASURE_WORKER_ENABLED: "0", LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "0",
      DATA_ERASURE_REQUESTS_ENABLED: "0", TENANT_ERASURE_REQUESTS_ENABLED: "0", CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "0",
      DATA_EXPORT_REQUESTS_ENABLED: "0", DATA_EXPORT_WORKER_ENABLED: "0", DATA_EXPORT_CLEANUP_ENABLED: "0",
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "0", PURGE_POLICY_EVALUATOR_ENABLED: "0",
      SESSION_DELETE_GRACE_RECOVERY_ENABLED: "0", SESSION_USAGE_RETENTION_WORKER_ENABLED: "0",
      TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: "0", TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED: "0",
      TENANT_RUNTIME_DRAIN_ENABLED: "0", TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "0", TENANT_CONTENT_INVENTORY_WORKER_ENABLED: "0",
      TENANT_PURGE_PLAN_WORKER_ENABLED: "0", TENANT_PURGE_EXECUTION_WORKER_ENABLED: "0", TENANT_DATABASE_PURGE_WORKER_ENABLED: "0",
      TENANT_REDIS_PURGE_WORKER_ENABLED: "0", TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "0", TENANT_TELEMETRY_WRITER_ENABLED: "0",
      PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "0", BLOB_STORAGE_CONTROL_ENABLED: "0", BLOB_ATTACHMENTS_ENABLED: "0",
      LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000" });
    startupUncertain = false; const runnerUrl = await listeningUrl(runner.server as HttpServer);
    expect(runnerUrl).toBe(`http://127.0.0.1:${runnerPort}`); expect(runner.cfg.STORE).toBe(mysqlUrl ? "mysql" : "memory");
    expect(runner.cfg.REDIS_URL).toBeUndefined(); expect(runner.cfg.skills.enabled).toBe(true); expect(runner.skills?.enabled).toBe(true);
    for (const enabled of [runner.cfg.BLOB_CLEANUP_ENABLED, runner.cfg.ERASURE_WORKER_ENABLED, runner.cfg.DATA_EXPORT_WORKER_ENABLED,
      runner.cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED, runner.cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED,
      runner.cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED, runner.cfg.TENANT_REDIS_PURGE_WORKER_ENABLED,
      runner.cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED]) expect(enabled).toBe(false);
    await runner.store.createApiKey("tenant_other_skills", "other-skills-key", hashApiKey(otherKey), ["runtime", "admin"]);
    const beforeRouter = signalListeners(); startupUncertain = true;
    router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: "0", RUNNERS: runnerUrl,
      INTERNAL_ROUTER_TOKEN: internalToken, HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0" });
    startupUncertain = false; routerListeners = addedListeners(beforeRouter); const routerUrl = await listeningUrl(router.server as HttpServer);
    expect(router.cfg.REDIS_URL).toBeUndefined();
    const capabilities = await json(routerUrl, "/v1/capabilities"); expect(capabilities.status).toBe(200);
    expect(Capabilities.parse(capabilities.body).features.skills).toBe(true);
    const defined = await json(routerUrl, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "Static skill vertical",
      instructions: "Load the matching static skill, then answer from the returned instructions.", model: { provider: "deepseek", model: "deepseek-chat" },
      tools: [], skills: [MOUNT_ID], approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 20000 } }) }, CALLER.userId);
    expect(defined.status).toBe(201); const agent = AgentDefinition.parse(defined.body); expect(agent.skills).toEqual([MOUNT_ID]);
    const created = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id, userId: OWNER.userId }) }, CALLER.userId);
    expect(created.status).toBe(201); const session = Session.parse(created.body); sessionId = session.id;
    expect(session.userId).toBe(OWNER.userId); expect(session.lastSeq).toBe(1); expect(gateway.modelRequests).toBe(0);
    expect((await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }, CALLER.userId)).status).toBe(404);
    const absent = await json(routerUrl, `/v1/sessions/${newId("sess")}`, {}, CALLER.userId);
    const hidden = await json(routerUrl, `/v1/sessions/${session.id}`, {}, CALLER.userId);
    expect(hidden.status).toBe(404); expect(hidden.body).toEqual(absent.body);
    for (const suffix of ["", "/items", "/events"]) {
      expect((await json(routerUrl, `/v1/sessions/${session.id}${suffix}`, {}, CALLER.userId)).status).toBe(404);
      expect((await json(routerUrl, `/v1/sessions/${session.id}${suffix}`, {}, OWNER.userId, otherKey)).status).toBe(404);
    }
    const first = openSse(`${routerUrl}/v1/sessions/${session.id}/turns`, headers(), lifetime.signal, { method: "POST",
      body: JSON.stringify({ input: [{ type: "text", text: "Use the configured release guide." }], stream: true }) });
    streams.push(first); expect((await first.ready).status).toBe(200);
    await waitFor(() => { first.healthy(); return gateway!.modelRequests === 1 && first.frames.some(frame => frame.data.type === "turn/started") ? true : undefined; }, lifetime.signal);
    expect(vendor.requests.length).toBe(0); expect(first.frames.some(frame => frame.data.type === "turn/completed")).toBe(false);
    await first.close(); const firstEvents = persisted(first), cursor = firstEvents.at(-1)!.seq;
    expect(cursor).toBeGreaterThanOrEqual(2); expect(vendor.requests.length).toBe(0);
    // Only after the real public disconnect do we release the model HTTP request; the turn must
    // continue, call the real static source, durably publish its result and execute model step 2.
    gateway.release();
    const turn = await waitFor(async () => {
      const turns = await json(routerUrl, `/v1/sessions/${session.id}/turns`); expect(turns.status).toBe(200);
      const values = (turns.body as { data: unknown[] }).data.map(value => Turn.parse(value)); expect(values.length).toBe(1);
      return values[0]!.status === "inProgress" ? undefined : values[0];
    }, lifetime.signal);
    expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
    expect(vendor.requests.length).toBe(2); expect(gateway.modelRequests).toBe(2); expect(gateway.resourceRequests).toBe(0);
    const advertised = vendor.requests[0]!.body.tools as { function?: { name?: string; parameters?: { properties?: { name?: { enum?: string[] } } } } }[];
    expect(Array.isArray(advertised)).toBe(true); expect(advertised.length).toBe(1);
    expect(advertised[0]?.function?.name).toBe("skill"); expect(advertised[0]?.function?.parameters?.properties?.name?.enum).toEqual([SKILL_NAME]);
    const initialModelBody = JSON.stringify(vendor.requests[0]!.body);
    expect(initialModelBody.includes("<available_skills>")).toBe(true); expect(initialModelBody.includes(SKILL_NAME)).toBe(true);
    expect(initialModelBody.includes(BODY_MARKER)).toBe(false); expect(initialModelBody.includes(REFERENCE_CONTENT)).toBe(false);
    const itemsResponse = await json(routerUrl, `/v1/sessions/${session.id}/items`); expect(itemsResponse.status).toBe(200);
    const items = (itemsResponse.body as { data: unknown[] }).data.map(value => Item.parse(value));
    const calls = items.filter(item => item.type === "toolCall"), results = items.filter(item => item.type === "toolResult");
    expect(calls.length).toBe(1); expect(calls[0]).toMatchObject({ name: "skill", kind: "skill", toolCallId: CALL_ID, status: "completed", startedAtMs: expect.any(Number) });
    expect(results.length).toBe(1); const result = results[0]!;
    expect(result).toMatchObject({ name: "skill", toolCallId: CALL_ID, isError: false, status: "completed" });
    if (result.type !== "toolResult" || !result.details || typeof result.details !== "object") failed();
    expect(Object.keys(result.details)).toEqual(["skillContext"]);
    const context = ResolvedSkillContext.parse((result.details as { skillContext: unknown }).skillContext);
    expect(context).toMatchObject({ id: MOUNT_ID, name: SKILL_NAME, body: skillBody, contentSha256 });
    expect(context.versionSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.content.length).toBe(1);
    const stored = await runner.store.listItems(session.id, { limit: 200 });
    const storedResult = stored.find(item => item.id === result.id);
    expect(storedResult?.type).toBe("toolResult");
    if (storedResult?.type !== "toolResult") failed();
    expect(storedResult.details).toEqual({ skillContext: context });
    expect(storedResult.content).toEqual(result.content); expect(storedResult.seq).toBe(result.seq);
    const text = result.content[0]; if (!text || text.type !== "text") failed();
    expect(text.text.includes(BODY_MARKER)).toBe(true); expect(text.text.includes(context.versionSha256)).toBe(true);
    expect(text.text.includes(contentSha256)).toBe(true); expect(text.text.includes(REFERENCE_CONTENT)).toBe(false);
    const messages = vendor.requests[1]!.body.messages as Record<string, unknown>[];
    const modelResults = messages.filter(message => message.role === "tool" && message.tool_call_id === CALL_ID);
    expect(modelResults.length).toBe(1); expect(modelResults[0]?.content).toBe(text.text);
    expect(vendor.requests.every(request => request.headers.authorization === `Bearer ${providerKey}`)).toBe(true);
    expect(JSON.stringify(vendor.requests.map(request => request.body)).includes(REFERENCE_CONTENT)).toBe(false);
    expect(items.filter(item => item.type === "agentMessage" && item.text === FINAL_TEXT && item.status === "completed").length).toBe(1);
    expect(items.some(item => item.type === "approvalRequest")).toBe(false);
    expect(await readFile(join(directory, "references", "private.txt"), "utf8")).toBe(REFERENCE_CONTENT);
    await expect(stat(scriptMarker)).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await json(routerUrl, `/v1/sessions/${session.id}/resume`, { method: "POST" }); expect(resumed.status).toBe(200);
    const resume = ResumeSessionResponse.parse(resumed.body); expect(resume.session.status).toEqual({ type: "idle" });
    expect(resume.pendingApprovalIds).toEqual([]); expect(resume.session.autoApprovedTools).toEqual([]);
    expect(resume.recentTurns.some(value => value.id === turn.id && value.status === "completed")).toBe(true); const finalSeq = resume.lastSeq;
    expect(finalSeq).toBeGreaterThan(cursor);
    const full = openSse(`${routerUrl}/v1/sessions/${session.id}/events?after=0`, headers(), lifetime.signal);
    const tail = openSse(`${routerUrl}/v1/sessions/${session.id}/events`, { ...headers(), "last-event-id": String(cursor) }, lifetime.signal);
    streams.push(full, tail); expect((await full.ready).status).toBe(200); expect((await tail.ready).status).toBe(200);
    await waitFor(() => { full.healthy(); tail.healthy(); return persisted(full).at(-1)?.seq === finalSeq && persisted(tail).at(-1)?.seq === finalSeq ? true : undefined; }, lifetime.signal);
    await Promise.all([full.close(), tail.close()]); const all = persisted(full), remainder = persisted(tail);
    expect(all.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
    expect(remainder).toEqual(all.filter(event => event.seq > cursor));
    expect([...firstEvents, ...remainder].map(event => event.seq)).toEqual(Array.from({ length: finalSeq - 1 }, (_, index) => index + 2));
    expect(remainder.some(event => event.type === "turn/completed" && event.turn.id === turn.id)).toBe(true);
    const replayedResults = all.filter(event => event.type === "item/completed" && event.item.type === "toolResult");
    expect(replayedResults.length).toBe(1);
    const replayedResult = replayedResults[0]; if (replayedResult?.type !== "item/completed" || replayedResult.item.type !== "toolResult") failed();
    expect(replayedResult.item.details).toEqual({ skillContext: context });
    for (const stream of streams) for (const frame of stream.frames) if (typeof frame.data.seq === "number") expect(frame.id).toBe(frame.data.seq);
    expect(gateway.resourceRequests).toBe(0); expect(gateway.modelRequests).toBe(2); expect(vendor.requests.length).toBe(2);
    return { profile: mysqlUrl ? "source-mysql-only" : "source-memory-only", owner: { ...OWNER }, sessionId: session.id,
      turnId: turn.id, toolCallId: CALL_ID, skillContext: context, toolResultText: text.text, finalText: FINAL_TEXT,
      contentSha256, versionSha256: context.versionSha256, finalSeq };
  } finally {
    gateway?.release(); clearTimeout(deadline); lifetime.abort(); const errors: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
    for (const stream of streams) await clean(() => stream.close());
    if (runner && sessionId) { const active = runner.host.activeTurn(sessionId);
      if (active) await clean(() => runner!.host.interrupt(OWNER, sessionId!, active.id)); }
    if (router) { const closed = nativeClose(router.server as HttpServer); await clean(() => router!.close()); await clean(() => closed); }
    if (runner) await clean(() => runner!.close());
    await clean(async () => { await gateway?.stop(); }); await clean(() => vendor.stop());
    for (const signal of signals) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
    if (scratch) await clean(() => rm(scratch!, { recursive: true, force: true }));
    let cleanupComplete = false;
    try {
      if (router) expect((router.server as HttpServer).listening).toBe(false);
      if (runner) expect((runner.server as HttpServer).listening).toBe(false);
      expect(gateway?.closed ?? true).toBe(true);
      for (const signal of signals) expect(process.listeners(signal)).toEqual(initialListeners.get(signal));
      if (router) expect(exit).toHaveBeenCalledWith(0);
      if (startupUncertain) errors.push(new Error("Skills fixture bootstrap ownership is uncertain."));
      if (errors.length) throw new Error("Static skills vertical owned-resource cleanup failed.");
      cleanupComplete = true;
    } finally { exit.mockRestore(); vi.unstubAllEnvs(); }
    if (cleanupComplete) options.onOwnedServicesClosed?.();
  }
}
