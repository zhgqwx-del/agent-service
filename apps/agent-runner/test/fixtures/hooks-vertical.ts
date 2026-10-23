import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { newId } from "@agent-service/core";
import type { ToolHookWebhookRequest } from "@agent-service/core";
import { AgentDefinition, Approval, Capabilities, Event, Item, ResumeSessionResponse, Session, Turn, type PersistedEvent } from "@agent-service/protocol";
import { FakeMcp, FakeVendor } from "@agent-service/testkit";
import { startRouter } from "../../../agent-router/src/main.js";
import { hashApiKey } from "../../src/auth.js";
import { startRunner } from "../../src/main.js";

// Real source runner/router, Pi, official MCP server, FakeVendor and signed local HTTP webhook.
// Default stores/leases/bus are owned Memory implementations. Explicit MySQL mode accepts only
// the wrapper's new random loopback test database; leases/bus remain Memory. Neither profile is
// Redis or OS-dist proof. No policy/source/provider/Host/auth method is replaced by a test double.
const OWNER = { tenantId: "tenant_hooks_vertical", userId: "owner-hooks" };
const CALLER = { ...OWNER, userId: "trusted-caller-hooks" };
const CALL_ALLOW = "call_hooks_allowed", CALL_DENY = "call_hooks_denied";
const ARG_ALLOW = "PRIVATE_ALLOWED_ARGUMENT_NOT_FOR_WEBHOOK", ARG_DENY = "PRIVATE_DENIED_ARGUMENT_NOT_FOR_WEBHOOK";
const RESULT = `PRIVATE_RESULT_NOT_FOR_WEBHOOK:${ARG_ALLOW}`;
const FINAL_ALLOW = "The approved real MCP result reached the model.";
const FINAL_DENY = "The current signed hook policy blocked this request.";
const DENIED = "Tool blocked by hook policy.";
const DIGEST = /^[a-f0-9]{64}$/;
const signals = ["SIGTERM", "SIGINT"] as const;
type SignalListeners = Map<(typeof signals)[number], NodeJS.SignalsListener[]>;
type Stage = "startup" | "agent" | "isolation" | "allow_approval" | "allow_result" | "deny_result" | "replay" | "cleanup";
function failed(): never { throw new Error("Tool hooks vertical fixture failed."); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failed(); return value as Record<string, unknown>;
}
function exactKeys(value: unknown, keys: readonly string[]) { expect(Object.keys(record(value)).sort()).toEqual([...keys].sort()); }
function digest(domain: string, value: unknown) { return createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex"); }
function mac(key: Uint8Array, domain: string, value: unknown) { return createHmac("sha256", key).update(domain).update("\0").update(JSON.stringify(value)).digest("hex"); }
function sameDigest(a: unknown, b: string): boolean { return typeof a === "string" && DIGEST.test(a) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")); }
function signalListeners(): SignalListeners { return new Map(signals.map(signal => [signal, process.listeners(signal)])); }
function addedListeners(before: SignalListeners): SignalListeners {
  return new Map(signals.map(signal => [signal, process.listeners(signal).filter(listener => !before.get(signal)!.includes(listener))]));
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new Error("Hook fixture port unavailable."))); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") failed();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error("Hook fixture port unavailable.")) : resolve()));
  return address.port;
}
async function listeningUrl(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", error); resolve(); };
    const error = () => { server.off("listening", ready); reject(new Error("Hook fixture listener unavailable.")); };
    server.once("listening", ready); server.once("error", error);
  });
  const address = server.address(); if (!address || typeof address === "string") failed();
  return `http://127.0.0.1:${address.port}`;
}
function nativeClose(server: HttpServer) { return server.listening ? new Promise<void>(resolve => server.once("close", () => resolve())) : Promise.resolve(); }
async function portClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port }); let refused = false;
    socket.setTimeout(1000, () => socket.destroy()); socket.once("connect", () => socket.destroy());
    socket.once("error", (error: NodeJS.ErrnoException) => { refused = error.code === "ECONNREFUSED"; });
    socket.once("close", () => resolve(refused));
  });
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal): Promise<T> {
  const until = performance.now() + 10_000;
  while (!signal.aborted && performance.now() < until) { const value = await read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Tool hooks vertical fixture timed out.");
}

/** A real anonymous HTTP peer. Independent wire MAC calculation deliberately does not call the
 * product signing helpers. Failures stay content-free; marker assertions outside this callback
 * prevent a post observer's legitimate fail-open behavior from swallowing a fixture oracle. */
class SignedWebhook {
  allow = true;
  failed = false;
  readonly requests: ToolHookWebhookRequest[] = [];
  private server?: HttpServer;
  private accepting = false;
  private readonly sockets = new Map<Socket, Promise<void>>();
  private readonly exchanges = new Set<Promise<void>>();
  constructor(private readonly key: Buffer, private readonly observe: (request: ToolHookWebhookRequest) => Promise<void>,
    private readonly forbidden: () => readonly string[]) {}
  get closed() { return this.server === undefined && this.sockets.size === 0 && this.exchanges.size === 0; }
  async start(): Promise<string> {
    const server = createHttpServer({ maxHeaderSize: 16_384, requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
      const work = this.handle(request, response).catch(() => {
        this.failed = true;
        if (!response.destroyed && !response.headersSent) { response.writeHead(500, { connection: "close" }); response.end(); }
        else response.destroy();
      }).finally(() => this.exchanges.delete(work));
      this.exchanges.add(work);
    });
    this.server = server;
    server.on("connection", socket => {
      const closed = new Promise<void>(resolve => socket.once("close", () => { this.sockets.delete(socket); resolve(); }));
      this.sockets.set(socket, closed);
    });
    await new Promise<void>((resolve, reject) => { const error = () => reject(new Error("Hook fixture listener unavailable."));
      server.once("error", error); server.listen(0, "127.0.0.1", () => { server.off("error", error); resolve(); }); });
    this.accepting = true; return `${await listeningUrl(server)}/hook`;
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.shouldKeepAlive = false;
    if (!this.accepting || request.url !== "/hook" || request.method !== "POST") failed();
    const timer = setTimeout(() => response.destroy(), 5_000);
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of request) { const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part); size += bytes.length;
        if (size > 16_384) failed(); chunks.push(bytes); }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      expect(this.forbidden().filter(value => value.length > 0).some(value => raw.includes(value))).toBe(false);
      exactKeys(request.headers, ["accept", "accept-encoding", "connection", "content-length", "content-type", "host"]);
      expect(request.headers["accept-encoding"]).toBe("identity");
      expect(request.headers.authorization === undefined && request.headers.cookie === undefined
        && request.headers["x-user-id"] === undefined && request.headers["x-internal-router-token"] === undefined).toBe(true);
      expect(request.headers["content-type"] === "application/json" && request.headers.accept === "application/json").toBe(true);
      const value = record(JSON.parse(raw));
      exactKeys(value, ["schema", "hookId", "phase", "invocationId", "configSha256", "refs", "tool", "isError", "requestSha256", "macSha256"]);
      exactKeys(value.refs, ["tenant", "user", "session", "turn", "toolCall"]); exactKeys(value.tool, ["name", "kind", "readOnly"]);
      expect(value.schema === "agent-service-tool-hook-request-v1").toBe(true);
      expect(value.phase === "preToolUse" || value.phase === "postToolUse").toBe(true);
      expect(typeof value.invocationId === "string" && /^[a-f0-9]{32}$/.test(value.invocationId)).toBe(true);
      expect(typeof value.configSha256 === "string" && DIGEST.test(value.configSha256)).toBe(true);
      expect(Object.values(record(value.refs)).every(ref => typeof ref === "string" && DIGEST.test(ref))).toBe(true);
      const refs = record(value.refs), tool = record(value.tool);
      const payload = { schema: value.schema, hookId: value.hookId, phase: value.phase, invocationId: value.invocationId,
        configSha256: value.configSha256,
        refs: { tenant: refs.tenant, user: refs.user, session: refs.session, turn: refs.turn, toolCall: refs.toolCall },
        tool: { name: tool.name, kind: tool.kind, readOnly: tool.readOnly }, isError: value.isError };
      expect(sameDigest(value.requestSha256, digest("agent-service-tool-hook-request-digest-v1", payload))).toBe(true);
      expect(sameDigest(value.macSha256, mac(this.key, "agent-service-tool-hook-request-mac-v1", { ...payload, requestSha256: value.requestSha256 }))).toBe(true);
      const authenticated = value as unknown as ToolHookWebhookRequest;
      this.requests.push(authenticated); await this.observe(authenticated);
      if (!this.accepting || response.destroyed) failed();
      const decision = authenticated.phase === "preToolUse" ? this.allow ? "allow" : "deny" : "ack";
      const signed = { schema: "agent-service-tool-hook-response-v1", hookId: authenticated.hookId, phase: authenticated.phase,
        invocationId: authenticated.invocationId, configSha256: authenticated.configSha256, requestSha256: authenticated.requestSha256, decision };
      const body = JSON.stringify({ ...signed, macSha256: mac(this.key, "agent-service-tool-hook-response-mac-v1", signed) });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
      response.end(body);
    } finally { clearTimeout(timer); }
  }
  async stop() {
    this.accepting = false; const server = this.server;
    const closed = server?.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    const socketsClosed = [...this.sockets.values()]; for (const socket of this.sockets.keys()) socket.destroy();
    await Promise.all([closed, ...socketsClosed]);
    while (this.exchanges.size) await Promise.all([...this.exchanges]);
    this.server = undefined;
  }
}

interface Frame { id?: number; data: Event }
interface Sse { frames: Frame[]; ready: Promise<Response>; healthy(): void; close(): Promise<void> }
function openSse(url: string, headers: Record<string, string>, lifetime: AbortSignal, init: RequestInit = {}): Sse {
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime]); const frames: Frame[] = []; let bad = false;
  const ready = fetch(url, { ...init, headers, signal });
  const done = (async () => {
    const response = await ready;
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) failed();
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 2_097_152) failed();
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n"); let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = /^event: ?(.*)$/m.exec(block)?.[1];
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!kind || !data) continue;
        const event = Event.parse(JSON.parse(data)), id = /^id: ?(.*)$/m.exec(block)?.[1];
        if (kind !== event.type || frames.length >= 500 || id !== undefined && !/^[0-9]+$/.test(id)) failed();
        if (id !== undefined) expect(Number(id)).toBe(event.seq);
        frames.push({ ...(id === undefined ? {} : { id: Number(id) }), data: event });
      }
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  })().catch(() => { if (!signal.aborted) bad = true; });
  return { frames, ready, healthy() { if (bad) failed(); }, async close() { abort.abort(); await done; if (bad) failed(); } };
}
const persisted = (stream: Sse) => stream.frames.flatMap(frame => typeof frame.data.seq === "number" ? [frame.data as PersistedEvent] : []);

export interface HooksBeforePostAck {
  owner: typeof OWNER; sessionId: string; turnId: string; toolCallId: string; toolName: string;
  approvalId: string; approvalScope: string; resultItemId: string; resultText: string; preConfigSha256: string;
}
export interface HooksVerticalOptions {
  mysqlUrl?: string;
  /** Prepared by the owning wrapper; never operator credentials or migration authority. */
  mysqlRuntimeEnv?: Readonly<Record<string, string>>;
  /** Runs inside the real webhook observer after its committed-store/API checks, before ACK.
   * A successful marker is set only after this callback and all actual reads/close have settled. */
  onBeforePostAck?: (expected: HooksBeforePostAck) => Promise<void>;
  /** Called only after every owned service/listener and cleanup assertion really settles. */
  onOwnedServicesClosed?: () => void;
}
export interface HooksVerticalResult {
  profile: "source-memory-only" | "source-mysql-only"; owner: typeof OWNER; sessionId: string;
  firstTurnId: string; secondTurnId: string; allowedToolCallId: string; deniedToolCallId: string; toolName: string;
  approvalId: string; approvalScope: string; resultText: string; deniedResultText: string;
  finalMessages: readonly string[]; hookEvents: readonly Extract<PersistedEvent, { type: "hook/completed" }>[];
  remoteCalls: number; webhookRequests: number; finalSeq: number;
}
function isolatedMysqlUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.username
      || url.href.includes("?") || url.href.includes("#")
      || !/^agent_service_hooks_vertical_test_[0-9a-f]{24}$/.test(decodeURIComponent(url.pathname.slice(1)))) failed();
    return url.toString();
  } catch { throw new Error("Hooks fixture requires its exact owned loopback test database."); }
}
export async function runHooksVertical(options: HooksVerticalOptions = {}): Promise<HooksVerticalResult> {
  const mysqlUrl = isolatedMysqlUrl(options.mysqlUrl);
  const mysqlRuntimeEnv = options.mysqlRuntimeEnv;
  const runtimeKeys = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
  if ((mysqlUrl !== undefined) !== (mysqlRuntimeEnv !== undefined)
    || mysqlRuntimeEnv !== undefined && (Object.keys(mysqlRuntimeEnv).length !== runtimeKeys.length
      || Object.keys(mysqlRuntimeEnv).some(key => !runtimeKeys.includes(key))
      || runtimeKeys.some(key => typeof mysqlRuntimeEnv[key] !== "string" || !mysqlRuntimeEnv[key]))) {
    throw new Error("Hooks MySQL vertical requires an explicit prepared runtime environment.");
  }
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1"); vi.stubEnv("HOOKS_ALLOW_LOOPBACK_FOR_TESTS", "1");
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const initialListeners = signalListeners(); let routerListeners: SignalListeners = new Map();
  const lifetime = new AbortController(), until = performance.now() + 45_000;
  const deadline = setTimeout(() => lifetime.abort(), 45_000);
  const key = Buffer.alloc(32, 0x73), providerKey = "hooks-vertical-fake-provider-key";
  const bootstrapKey = `hooks-fixture-${randomBytes(24).toString("hex")}`, otherKey = `hooks-other-${randomBytes(24).toString("hex")}`;
  const internalToken = randomBytes(32).toString("hex");
  const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey }), remote = new FakeMcp();
  remote.responsePrefix = "PRIVATE_RESULT_NOT_FOR_WEBHOOK:";
  let scratch: string | undefined, keyFile: string | undefined, sessionId: string | undefined, toolName: string | undefined;
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined, router: Awaited<ReturnType<typeof startRouter>> | undefined;
  let routerUrl = "", startupUncertain = false, stage: Stage = "startup", scope: string | undefined;
  let preAllowVerified = false, postVerified = false, preDenyVerified = false, actualDispatchVerified = false;
  const streams: Sse[] = [], ports = new Set<number>();
  const headers = (userId = OWNER.userId, apiKey = bootstrapKey) => ({ authorization: `Bearer ${apiKey}`, "x-user-id": userId, "content-type": "application/json" });
  const json = async (base: string, path: string, init: RequestInit = {}, userId = OWNER.userId, apiKey = bootstrapKey) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: headers(userId, apiKey),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) });
    const text = await response.text(); if (Buffer.byteLength(text) > 2_097_152) failed();
    const body: unknown = text ? JSON.parse(text) : null; return { status: response.status, body };
  };
  const webhook = new SignedWebhook(key, async request => {
    if (!runner || !sessionId || !toolName) failed();
    expect(request.tool).toEqual({ name: toolName, kind: "mcp", readOnly: false });
    const pre = request.phase === "preToolUse", callId = pre && !webhook.allow ? CALL_DENY : CALL_ALLOW;
    const items = await runner.store.listItems(sessionId, { limit: 200 });
    const call = items.find(item => item.type === "toolCall" && item.toolCallId === callId);
    if (!call || call.type !== "toolCall") failed();
    const refs = { tenant: [OWNER.tenantId], user: [OWNER.tenantId, OWNER.userId],
      session: [OWNER.tenantId, OWNER.userId, sessionId], turn: [OWNER.tenantId, OWNER.userId, sessionId, call.turnId],
      toolCall: [OWNER.tenantId, OWNER.userId, sessionId, call.turnId, callId] };
    for (const [name, identity] of Object.entries(refs)) expect(sameDigest(request.refs[name as keyof typeof refs],
      mac(key, `agent-service-tool-hook-ref-${name === "toolCall" ? "tool-call" : name}-v1`, identity))).toBe(true);
    const current = await runner.store.getSession(OWNER.tenantId, sessionId);
    expect(current?.userId).toBe(OWNER.userId);
    const approvals = await runner.store.listApprovals(sessionId, {}), events = await runner.store.readEvents(sessionId, 0, 200);
    if (pre) {
      expect(request.hookId).toBe("pre_policy"); expect(request.isError).toBeNull();
      expect(call.startedAtMs === undefined).toBe(true); expect(call.status).toBe("inProgress");
      expect(items.some(item => item.type === "toolResult" && item.toolCallId === callId)).toBe(false);
      expect(approvals.filter(approval => approval.turnId === call.turnId).length).toBe(0);
      expect(events.some(event => event.type === "hook/completed" && event.toolCallId === callId)).toBe(false);
      if (webhook.allow) {
        expect(remote.calls.length).toBe(0); expect(approvals.length).toBe(0); expect(vendor.requests.length).toBe(1);
        preAllowVerified = true;
      } else {
        expect(remote.calls.length).toBe(1); expect(approvals.length).toBe(1); expect(approvals[0]?.decision).toBe("acceptForSession");
        expect(current?.autoApprovedTools).toEqual([scope]); expect(vendor.requests.length).toBe(3);
        preDenyVerified = true;
      }
    } else {
      expect(request.hookId).toBe("post_observer"); expect(request.isError).toBe(false);
      expect(call).toMatchObject({ status: "completed", startedAtMs: expect.any(Number) });
      const result = items.find(item => item.type === "toolResult" && item.toolCallId === CALL_ALLOW);
      expect(result).toMatchObject({ status: "completed", isError: false, name: toolName, content: [{ type: "text", text: RESULT }] });
      const api = await json(routerUrl, `/v1/sessions/${sessionId}/items`); expect(api.status).toBe(200);
      const apiItems = (api.body as { data: unknown[] }).data.map(value => Item.parse(value));
      expect(apiItems.find(item => item.id === result?.id)).toEqual(result);
      expect(events.some(event => event.type === "item/completed" && event.item.id === result?.id)).toBe(true);
      expect(events.some(event => event.type === "hook/completed" && event.phase === "preToolUse" && event.outcome === "allowed")).toBe(true);
      expect(events.some(event => event.type === "hook/completed" && event.phase === "postToolUse")).toBe(false);
      expect(remote.calls.length).toBe(1); expect(vendor.requests.length).toBe(1);
      expect(current?.autoApprovedTools.length).toBe(1); scope = current!.autoApprovedTools[0];
      expect(typeof scope === "string" && scope.length > 0).toBe(true);
      const preReport = events.find(event => event.type === "hook/completed" && event.phase === "preToolUse" && event.toolCallId === CALL_ALLOW);
      if (!scope || !approvals[0] || !result || result.type !== "toolResult" || preReport?.type !== "hook/completed") failed();
      await options.onBeforePostAck?.({ owner: { ...OWNER }, sessionId, turnId: call.turnId, toolCallId: CALL_ALLOW,
        toolName, approvalId: approvals[0].id, approvalScope: scope, resultItemId: result.id, resultText: RESULT,
        preConfigSha256: preReport.configSha256 });
      expect(vendor.requests.length).toBe(1);
      postVerified = true;
    }
  }, () => [ARG_ALLOW, ARG_DENY, RESULT, FINAL_ALLOW, FINAL_DENY, OWNER.tenantId, OWNER.userId, CALLER.userId,
    sessionId ?? "", CALL_ALLOW, CALL_DENY, providerKey, bootstrapKey, otherKey, internalToken, key.toString("hex"),
    keyFile ?? "", scratch ?? "", "authorization", "cookie", "signingKeyFile"]);
  remote.beforeReply = async () => {
    if (!runner || !sessionId) failed();
    const current = await runner.store.getSession(OWNER.tenantId, sessionId), items = await runner.store.listItems(sessionId, { limit: 200 });
    expect(current?.autoApprovedTools).toEqual([]);
    expect(items.find(item => item.type === "toolCall" && item.toolCallId === CALL_ALLOW)).toMatchObject({ kind: "mcp", startedAtMs: expect.any(Number) });
    expect(items.some(item => item.type === "toolResult")).toBe(false); actualDispatchVerified = true;
  };
  try {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-service-hooks-vertical-"))); await chmod(scratch, 0o700);
    keyFile = join(scratch, "webhook-key.bin"); await writeFile(keyFile, key, { mode: 0o600, flag: "wx" });
    const keyStat = await lstat(keyFile); expect(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.nlink === 1
      && keyStat.size === 32 && (keyStat.mode & 0o777) === 0o600).toBe(true);
    const hookEndpoint = await webhook.start(), endpoint = await remote.start();
    const toolReply = (ordinal: number, callId: string, argument: string) => ({ get toolCalls() {
      const advertised = vendor.requests[ordinal]?.body.tools;
      if (!Array.isArray(advertised) || advertised.length !== 1) failed();
      const name = record(record(advertised[0]).function).name;
      expect(typeof name === "string" && /^mcp__[A-Za-z0-9_-]+$/.test(name) && name.length <= 64).toBe(true);
      if (typeof name !== "string") failed(); if (toolName !== undefined) expect(name).toBe(toolName); toolName = name;
      return [{ id: callId, name, args: JSON.stringify({ text: argument }), argChunks: 3 }];
    } });
    vendor.script(toolReply(0, CALL_ALLOW, ARG_ALLOW), { text: FINAL_ALLOW }, toolReply(2, CALL_DENY, ARG_DENY), { text: FINAL_DENY });
    const vendorUrl = await vendor.start();
    for (const url of [hookEndpoint, endpoint, vendorUrl]) ports.add(Number(new URL(url).port));
    const runnerPort = await unusedPort(); startupUncertain = true;
    runner = await startRunner({ NODE_ENV: "test", STORE: mysqlUrl ? "mysql" : "memory", ...mysqlRuntimeEnv,
      RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
      RUNNER_ADDR: `127.0.0.1:${runnerPort}`, RUNNER_ID: `hooks-vertical-${randomBytes(6).toString("hex")}`,
      SECRETS_MASTER_KEY: randomBytes(32).toString("hex"), BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: OWNER.tenantId,
      INTERNAL_ROUTER_TOKEN: internalToken, PLATFORM_PROVIDER: "deepseek", DEFAULT_MODEL: "deepseek-chat", API_KEY: providerKey, API_BASE_URL: vendorUrl,
      BLOB_STORE: "filesystem", BLOB_DIR: join(scratch, "blobs"), BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify([{ id: "alpha", endpoint, subjects: [OWNER] }]),
      MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: "5000", SKILLS_ENABLED: "0",
      HOOKS_ENABLED: "1", HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1", HOOKS_TIMEOUT_MS: "5000", HOOKS_CONFIG_JSON: JSON.stringify([
        { id: "pre_policy", kind: "webhook", phase: "preToolUse", endpoint: hookEndpoint, signingKeyFile: keyFile, subjects: [OWNER] },
        { id: "post_observer", kind: "webhook", phase: "postToolUse", endpoint: hookEndpoint, signingKeyFile: keyFile, subjects: [OWNER] }]),
      BLOB_CLEANUP_ENABLED: "0", ERASURE_WORKER_ENABLED: "0", LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "0",
      DATA_ERASURE_REQUESTS_ENABLED: "0", TENANT_ERASURE_REQUESTS_ENABLED: "0", CREDENTIAL_LIFECYCLE_TRACKING_ENABLED: "0",
      DATA_EXPORT_REQUESTS_ENABLED: "0", DATA_EXPORT_WORKER_ENABLED: "0", DATA_EXPORT_CLEANUP_ENABLED: "0",
      DATA_GOVERNANCE_MANAGEMENT_ENABLED: "0", PURGE_POLICY_EVALUATOR_ENABLED: "0", SESSION_DELETE_GRACE_RECOVERY_ENABLED: "0",
      SESSION_USAGE_RETENTION_WORKER_ENABLED: "0", TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED: "0", TENANT_CREDENTIAL_TARGET_EXECUTION_WORKER_ENABLED: "0",
      TENANT_RUNTIME_DRAIN_ENABLED: "0", TENANT_RUNTIME_REVOCATION_WORKER_ENABLED: "0", TENANT_CONTENT_INVENTORY_WORKER_ENABLED: "0",
      TENANT_PURGE_PLAN_WORKER_ENABLED: "0", TENANT_PURGE_EXECUTION_WORKER_ENABLED: "0", TENANT_DATABASE_PURGE_WORKER_ENABLED: "0",
      TENANT_REDIS_PURGE_WORKER_ENABLED: "0", TENANT_RESTORE_JOURNAL_WORKER_ENABLED: "0", TENANT_TELEMETRY_WRITER_ENABLED: "0",
      PERSISTED_PROVIDER_FAILURE_CAPTURE_ENABLED: "0", BLOB_STORAGE_CONTROL_ENABLED: "0", BLOB_ATTACHMENTS_ENABLED: "0",
      LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000" });
    startupUncertain = false; const runnerUrl = await listeningUrl(runner.server as HttpServer); ports.add(Number(new URL(runnerUrl).port));
    expect(runner.cfg.STORE).toBe(mysqlUrl ? "mysql" : "memory"); expect(runner.cfg.REDIS_URL).toBeUndefined(); expect(runner.hooks?.enabled).toBe(true);
    await runner.store.createApiKey("tenant_other_hooks", "other-hooks-key", hashApiKey(otherKey), ["runtime", "admin"]);
    const beforeRouter = signalListeners(); startupUncertain = true;
    router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: "0", RUNNERS: runnerUrl,
      INTERNAL_ROUTER_TOKEN: internalToken, HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0" });
    startupUncertain = false; routerListeners = addedListeners(beforeRouter); routerUrl = await listeningUrl(router.server as HttpServer); ports.add(Number(new URL(routerUrl).port));
    expect(router.cfg.REDIS_URL).toBeUndefined();
    const cap = await json(routerUrl, "/v1/capabilities"); expect(cap.status).toBe(200);
    const capabilities = Capabilities.parse(cap.body); expect(capabilities.features.hooks).toBe(true); expect(capabilities.features.mcp).toEqual(["streamable-http"]);
    stage = "agent";
    const defined = await json(routerUrl, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "Hooks vertical",
      instructions: "Use the configured echo tool and answer from its real outcome.", model: { provider: "deepseek", model: "deepseek-chat" },
      tools: [], mcpServers: ["alpha"], approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 20000 } }) }, CALLER.userId);
    expect(defined.status).toBe(201); const agent = AgentDefinition.parse(defined.body); expect(agent.approvalPolicy).toBe("never");
    const created = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id, userId: OWNER.userId }) }, CALLER.userId);
    expect(created.status).toBe(201); const session = Session.parse(created.body); sessionId = session.id;
    expect(session.userId).toBe(OWNER.userId); expect(session.lastSeq).toBe(1);
    stage = "isolation";
    expect((await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }, CALLER.userId)).status).toBe(404);
    const absent = await json(routerUrl, `/v1/sessions/${newId("sess")}`, {}, CALLER.userId), hidden = await json(routerUrl, `/v1/sessions/${session.id}`, {}, CALLER.userId);
    expect(hidden.status).toBe(404); expect(hidden.body).toEqual(absent.body);
    for (const suffix of ["", "/items", "/events"]) {
      expect((await json(routerUrl, `/v1/sessions/${session.id}${suffix}`, {}, CALLER.userId)).status).toBe(404);
      expect((await json(routerUrl, `/v1/sessions/${session.id}${suffix}`, {}, OWNER.userId, otherKey)).status).toBe(404);
    }
    expect(webhook.requests.length).toBe(0); expect(remote.calls.length).toBe(0);
    stage = "allow_approval";
    const first = openSse(`${routerUrl}/v1/sessions/${session.id}/turns`, headers(), lifetime.signal,
      { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "Run the configured echo tool." }], stream: true }) });
    streams.push(first); expect((await first.ready).status).toBe(200);
    const approvalEvent = await waitFor(() => { first.healthy();
      const event = persisted(first).find(event => event.type === "approval/requested");
      if (!event && first.frames.some(frame => frame.data.type === "turn/completed")) failed();
      return event?.type === "approval/requested" ? event : undefined; }, lifetime.signal);
    expect(preAllowVerified).toBe(true); expect(webhook.failed).toBe(false); expect(webhook.requests.length).toBe(1);
    expect(approvalEvent.approval.toolName).toBe(toolName); expect(approvalEvent.approval.toolCallId).toBe(CALL_ALLOW);
    expect(remote.calls.length).toBe(0); expect(vendor.requests.length).toBe(1);
    const before = await runner.store.listItems(session.id, { limit: 200 });
    expect(before.find(item => item.type === "toolCall")?.startedAtMs === undefined).toBe(true);
    await first.close(); const firstEvents = persisted(first), cursor = firstEvents.at(-1)!.seq;
    const accepted = await json(routerUrl, `/v1/sessions/${session.id}/approvals/${approvalEvent.approval.id}`,
      { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) });
    expect(accepted.status).toBe(200); expect(Approval.parse(accepted.body)).toMatchObject({ status: "resolved", decision: "acceptForSession" });
    stage = "allow_result";
    const complete = async (turnId: string) => waitFor(async () => {
      const response = await json(routerUrl, `/v1/sessions/${session.id}/turns/${turnId}`); expect(response.status).toBe(200);
      const turn = Turn.parse(response.body); return turn.status === "inProgress" ? undefined : turn;
    }, lifetime.signal);
    const firstTurn = await complete(approvalEvent.approval.turnId);
    expect(firstTurn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
    expect(postVerified).toBe(true); expect(actualDispatchVerified).toBe(true); expect(webhook.failed).toBe(false);
    expect(webhook.requests.length).toBe(2); expect(remote.calls).toEqual([{ name: "echo", arguments: { text: ARG_ALLOW } }]);
    expect(vendor.requests.length).toBe(2);
    const firstModelResults = (vendor.requests[1]!.body.messages as Record<string, unknown>[]).filter(value => value.role === "tool" && value.tool_call_id === CALL_ALLOW);
    expect(firstModelResults.length).toBe(1); expect(firstModelResults[0]?.content).toBe(RESULT);
    const granted = await runner.store.getSession(OWNER.tenantId, session.id); expect(granted?.autoApprovedTools).toEqual([scope]);
    expect(typeof scope === "string" && scope.length > 0).toBe(true);
    stage = "deny_result"; webhook.allow = false;
    const second = openSse(`${routerUrl}/v1/sessions/${session.id}/turns`, headers(), lifetime.signal,
      { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "Try the echo tool again under the current policy." }], stream: true }) });
    streams.push(second); expect((await second.ready).status).toBe(200);
    const secondCompleted = await waitFor(() => { second.healthy();
      expect(second.frames.some(frame => frame.data.type === "approval/requested")).toBe(false);
      const event = persisted(second).find(event => event.type === "turn/completed"); return event?.type === "turn/completed" ? event : undefined;
    }, lifetime.signal);
    const secondTurn = await complete(secondCompleted.turn.id);
    expect(secondTurn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
    await second.close(); expect(preDenyVerified).toBe(true); expect(webhook.failed).toBe(false);
    expect(webhook.requests.map(request => request.phase)).toEqual(["preToolUse", "postToolUse", "preToolUse"]);
    expect(new Set(webhook.requests.map(request => request.invocationId)).size).toBe(3);
    expect(webhook.requests[0]?.configSha256).toBe(webhook.requests[2]?.configSha256);
    expect(remote.calls.length).toBe(1); expect(remote.methods.filter(method => method === "tools/call").length).toBe(1); expect(vendor.requests.length).toBe(4);
    expect(vendor.requests.every(request => request.headers.authorization === `Bearer ${providerKey}`)).toBe(true);
    const itemsResponse = await json(routerUrl, `/v1/sessions/${session.id}/items`); expect(itemsResponse.status).toBe(200);
    const items = (itemsResponse.body as { data: unknown[] }).data.map(value => Item.parse(value));
    const deniedCall = items.find(item => item.type === "toolCall" && item.toolCallId === CALL_DENY);
    expect(deniedCall).toMatchObject({ name: toolName, kind: "mcp", status: "failed" });
    if (!deniedCall || deniedCall.type !== "toolCall") failed();
    expect(deniedCall.startedAtMs === undefined).toBe(true);
    const deniedResult = items.find(item => item.type === "toolResult" && item.toolCallId === CALL_DENY);
    expect(deniedResult).toMatchObject({ name: toolName, status: "failed", isError: true, content: [{ type: "text", text: DENIED }] });
    const denyMessages = (vendor.requests[3]!.body.messages as Record<string, unknown>[]).filter(value => value.role === "tool" && value.tool_call_id === CALL_DENY);
    expect(denyMessages.length).toBe(1); expect(denyMessages[0]?.content).toBe(DENIED);
    expect(items.filter(item => item.type === "approvalRequest").length).toBe(1);
    expect(items.filter(item => item.type === "agentMessage" && item.status === "completed" && [FINAL_ALLOW, FINAL_DENY].includes(item.text)).length).toBe(2);
    const resumed = await json(routerUrl, `/v1/sessions/${session.id}/resume`, { method: "POST" }); expect(resumed.status).toBe(200);
    const resume = ResumeSessionResponse.parse(resumed.body); expect(resume.session.status).toEqual({ type: "idle" });
    expect(resume.pendingApprovalIds).toEqual([]); expect(resume.session.autoApprovedTools).toEqual([scope]); const finalSeq = resume.lastSeq;
    stage = "replay";
    const full = openSse(`${routerUrl}/v1/sessions/${session.id}/events?after=0`, headers(), lifetime.signal);
    const tail = openSse(`${routerUrl}/v1/sessions/${session.id}/events`, { ...headers(), "last-event-id": String(cursor) }, lifetime.signal);
    streams.push(full, tail); expect((await full.ready).status).toBe(200); expect((await tail.ready).status).toBe(200);
    await waitFor(() => { full.healthy(); tail.healthy(); return persisted(full).at(-1)?.seq === finalSeq && persisted(tail).at(-1)?.seq === finalSeq ? true : undefined; }, lifetime.signal);
    await Promise.all([full.close(), tail.close()]); const all = persisted(full), remainder = persisted(tail);
    expect(all.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
    expect(remainder).toEqual(all.filter(event => event.seq > cursor));
    expect([...firstEvents, ...remainder].map(event => event.seq)).toEqual(Array.from({ length: finalSeq - 1 }, (_, index) => index + 2));
    const hookEvents = all.filter(event => event.type === "hook/completed"); expect(hookEvents.length).toBe(3);
    expect(hookEvents.map(event => [event.hookId, event.phase, event.kind, event.outcome, event.toolCallId])).toEqual([
      ["pre_policy", "preToolUse", "webhook", "allowed", CALL_ALLOW], ["post_observer", "postToolUse", "webhook", "acknowledged", CALL_ALLOW],
      ["pre_policy", "preToolUse", "webhook", "denied", CALL_DENY] ]);
    for (const event of hookEvents) exactKeys(event, ["type", "sessionId", "turnId", "toolCallId", "seq", "emittedAtMs", "hookId", "phase", "kind", "outcome", "configSha256"]);
    expect(hookEvents[0]!.seq).toBeLessThan(approvalEvent.seq);
    const resultEvent = all.find(event => event.type === "item/completed" && event.item.type === "toolResult" && event.item.toolCallId === CALL_ALLOW);
    const deniedEvent = all.find(event => event.type === "item/completed" && event.item.id === deniedResult?.id);
    if (!resultEvent || !deniedEvent) failed();
    expect(hookEvents[1]!.seq).toBeGreaterThan(resultEvent.seq); expect(hookEvents[2]!.seq).toBeLessThan(deniedEvent.seq);
    expect(all.filter(event => event.type === "approval/requested").length).toBe(1);
    expect(hookEvents.map(event => event.configSha256)).toEqual(webhook.requests.map(request => request.configSha256));
    for (const stream of streams) for (const frame of stream.frames) if (typeof frame.data.seq === "number") expect(frame.id).toBe(frame.data.seq);
    expect((await readFile(keyFile)).equals(key)).toBe(true); expect(webhook.requests.length).toBe(3); expect(remote.calls.length).toBe(1);
    expect(preAllowVerified && postVerified && preDenyVerified && actualDispatchVerified).toBe(true);
    expect(lifetime.signal.aborted || performance.now() >= until).toBe(false);
    if (!scope || !toolName) failed();
    return { profile: mysqlUrl ? "source-mysql-only" : "source-memory-only", owner: { ...OWNER }, sessionId: session.id,
      firstTurnId: firstTurn.id, secondTurnId: secondTurn.id, allowedToolCallId: CALL_ALLOW, deniedToolCallId: CALL_DENY, toolName,
      approvalId: approvalEvent.approval.id, approvalScope: scope, resultText: RESULT, deniedResultText: DENIED,
      finalMessages: [FINAL_ALLOW, FINAL_DENY], hookEvents, remoteCalls: remote.calls.length, webhookRequests: webhook.requests.length, finalSeq };
  } catch { throw new Error(`Tool hooks vertical failed at ${stage}.`); }
  finally {
    stage = "cleanup"; lifetime.abort(); const errors: boolean[] = [];
    const clean = async (work: () => Promise<unknown>) => { try { await work(); } catch { errors.push(true); } };
    for (const stream of streams) await clean(() => stream.close());
    if (runner && sessionId) { const active = runner.host.activeTurn(sessionId); if (active) await clean(() => runner!.host.interrupt(OWNER, sessionId!, active.id)); }
    if (router) { const closed = nativeClose(router.server as HttpServer); await clean(() => router!.close()); await clean(() => closed); }
    if (runner) await clean(() => runner!.close());
    await clean(() => webhook.stop()); await clean(() => vendor.stop()); await clean(() => remote.stop());
    await clean(async () => { expect((await Promise.all([...ports].map(portClosed))).every(Boolean)).toBe(true); });
    for (const signal of signals) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
    if (scratch) await clean(() => rm(scratch!, { recursive: true, force: true }));
    let cleanupComplete = false;
    try {
      if (router) expect((router.server as HttpServer).listening).toBe(false);
      if (runner) expect((runner.server as HttpServer).listening).toBe(false); expect(webhook.closed).toBe(true);
      for (const signal of signals) expect(process.listeners(signal)).toEqual(initialListeners.get(signal));
      if (router) expect(exit).not.toHaveBeenCalled();
      if (startupUncertain || errors.length || performance.now() >= until) throw new Error("Tool hooks vertical owned-resource cleanup failed.");
      cleanupComplete = true;
    } finally { clearTimeout(deadline); key.fill(0); exit.mockRestore(); vi.unstubAllEnvs(); }
    if (cleanupComplete) options.onOwnedServicesClosed?.();
  }
}
