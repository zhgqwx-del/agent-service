import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { ConfiguredMcpToolSource } from "@agent-service/core";
import {
  AgentDefinition, Approval, Capabilities, CreateApiKeyResponse, Event, Item,
  MANAGED_MCP_REGISTRY_V1, McpRegistrationResponse, ResumeSessionResponse, Session, Turn,
  type PersistedEvent,
} from "@agent-service/protocol";
import { FakeProgressMcp, FakeStatefulMcp, FakeVendor } from "@agent-service/testkit";
import {
  startTurnStream, subscribeSessionEvents, type EventStreamResult,
} from "../../../../packages/sdk/src/index.js";
import { startRouter } from "../../../agent-router/src/main.js";
import { startRunner } from "../../src/main.js";

// Same-process real main/router/Pi/SDK HTTP assembly, not proof of independent OS processes or TLS.
const OWNER = { tenantId: "t_mcp_progress_vertical", userId: "u_owner" };
const CALLER = { ...OWNER, userId: "u_other" };
const ARGUMENT = "progress-vertical-request";
const RESULT = `mcp-result:${ARGUMENT}`;
const FINAL_TEXT = "The final MCP result reached the second model request.";
const PROGRESS_MESSAGE = "The remote fixture has started its bounded work.";
const PROGRESS_TYPE = "item/mcpToolCall/progress";
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type Listeners = Map<(typeof SIGNALS)[number], NodeJS.SignalsListener[]>;
const listeners = (): Listeners => new Map(SIGNALS.map(signal => [signal, process.listeners(signal)]));
async function unusedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("MCP progress fixture port unavailable");
  return address.port;
}
async function origin(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", failed); resolve(); };
    const failed = () => { server.off("listening", ready); reject(new Error("MCP progress listener failed")); };
    server.once("listening", ready); server.once("error", failed);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP progress listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
const nativeClosed = (server: HttpServer) => server.listening
  ? new Promise<void>(resolve => server.once("close", () => resolve())) : Promise.resolve();
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal, label: string): Promise<T> {
  const deadline = performance.now() + 10_000;
  while (!signal.aborted && performance.now() < deadline) {
    const value = await read(); if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`MCP progress fixture wait failed: ${label}`);
}
interface Frame { readonly data: Event; readonly event: string; readonly id?: string }
function observe(stream: EventStreamResult, abort: AbortController) {
  const frames: Frame[] = []; let failed = false;
  const done = (async () => {
    try {
      for await (const frame of stream.events) {
        const data = Event.parse(frame.data);
        if (frame.event !== data.type || frames.length >= 256) throw new Error("Invalid fixture stream");
        frames.push({ data, event: frame.event, ...(frame.id === undefined ? {} : { id: frame.id }) });
      }
    } catch { if (!abort.signal.aborted) failed = true; }
  })();
  return { frames, healthy() { if (failed) throw new Error("MCP progress public SDK stream failed"); },
    async close() { abort.abort(); await done; if (failed) throw new Error("MCP progress public SDK stream failed"); } };
}
type Observation = ReturnType<typeof observe>;
function persisted(observation: Observation): PersistedEvent[] {
  return observation.frames.flatMap(frame => typeof frame.data.seq === "number" ? [frame.data as PersistedEvent] : []);
}
export interface McpProgressVerticalOptions {
  readonly mysqlUrl?: string;
  readonly mysqlRuntimeEnv?: Readonly<Record<string, string>>;
  readonly managed?: { readonly redisUrl: string; readonly redisPrefix: string; readonly redisNamespaceId: string };
  readonly onOwnedServicesClosed?: () => void;
  readonly onRetainedScratch?: (directory: string) => void;
  /** A real Redis subscriber supplied by the independently owned SQL wrapper, never a bus stub. */
  readonly beforeTurn?: (context: { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<void>;
  readonly afterProgress?: (context: { readonly sessionId: string; readonly signal: AbortSignal }) => Promise<void>;
}
export interface McpProgressVerticalResult {
  readonly owner: typeof OWNER;
  readonly sessionId: string;
  readonly turnId: string;
  readonly approvalId: string;
  readonly toolName: string;
  readonly callItemId: string;
  readonly approvalScope: string;
  readonly finalSeq: number;
  readonly toolResult: string;
  readonly managedRegistrationVersionId?: string;
  readonly scratchDirectory: string;
}

export async function runMcpProgressVertical(options: McpProgressVerticalOptions = {}): Promise<McpProgressVerticalResult> {
  if (!!options.mysqlUrl !== !!options.managed) throw new Error("Managed progress fixture requires both independently owned MySQL and Redis");
  const mysqlRuntimeEnv = options.mysqlRuntimeEnv;
  const runtimeKeys = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
  if ((options.mysqlUrl !== undefined) !== (mysqlRuntimeEnv !== undefined)
    || mysqlRuntimeEnv !== undefined && (Object.keys(mysqlRuntimeEnv).length !== runtimeKeys.length
      || Object.keys(mysqlRuntimeEnv).some(key => !runtimeKeys.includes(key))
      || runtimeKeys.some(key => typeof mysqlRuntimeEnv[key] !== "string" || !mysqlRuntimeEnv[key]))) {
    throw new Error("MCP progress MySQL vertical requires an explicit prepared runtime environment.");
  }
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const initialListeners = listeners(); let routerListeners: Listeners = new Map();
  const lifetime = new AbortController(), expires = performance.now() + 45_000;
  const timer = setTimeout(() => lifetime.abort(), 45_000);
  const checkTime = () => { if (lifetime.signal.aborted || performance.now() >= expires) throw new Error("MCP progress fixture operation deadline expired"); };
  const bootstrapKey = `mcp-progress-fixture-${randomBytes(16).toString("hex")}`;
  const providerKey = "mcp-progress-fake-provider-key";
  const internalToken = `mcp-progress-internal-${randomBytes(24).toString("hex")}`;
  const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey });
  const remote = options.managed ? new FakeStatefulMcp() : new FakeProgressMcp();
  remote.responsePrefix = "mcp-result:";
  remote.progress = [{ progress: 1, total: 2, message: PROGRESS_MESSAGE }];
  let releaseReply!: () => void;
  const reply = new Promise<void>(resolve => { releaseReply = resolve; });
  remote.beforeReply = () => reply;
  let scratch: string | undefined, sessionId: string | undefined;
  let discovery: ConfiguredMcpToolSource | undefined;
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  let secondRunner: Awaited<ReturnType<typeof startRunner>> | undefined;
  let router: Awaited<ReturnType<typeof startRouter>> | undefined;
  let startupUncertain = false, bodyPassed = false;
  const streams: Observation[] = [];
  const headers = (userId = OWNER.userId) => ({ authorization: `Bearer ${bootstrapKey}`, "x-user-id": userId, "content-type": "application/json" });
  const json = async (base: string, path: string, init: RequestInit = {}, userId = OWNER.userId) => {
    checkTime(); const requestHeaders = new Headers(headers(userId));
    new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
    const response = await fetch(`${base}${path}`, { ...init, headers: requestHeaders,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.managed ? 30_000 : 5_000)]) });
    return { status: response.status, body: await response.json() as unknown };
  };
  try {
    scratch = await mkdtemp(join(tmpdir(), "agent-service-mcp-progress-"));
    const endpoint = await remote.start(), servers = [{ id: "alpha", endpoint, subjects: [OWNER] }];
    let toolName = "", approvalScope = "", managedRegistrationVersionId: string | undefined;
    if (!options.managed) {
      discovery = new ConfiguredMcpToolSource({ servers, timeoutMs: 5_000, allowLoopbackForTests: true });
      const tools = await discovery.resolve(OWNER, ["alpha"], lifetime.signal);
      expect(tools).toHaveLength(1); toolName = tools[0]!.name; approvalScope = tools[0]!.approvalScope ?? "";
      expect(approvalScope.length > 0).toBe(true); expect(remote.calls).toHaveLength(0);
      await discovery.close(); discovery = undefined;
    }
    const vendorUrl = await vendor.start();
    const runnerPort = await unusedPort(); let secondPort = await unusedPort(), routerPort = await unusedPort();
    while (secondPort === runnerPort) secondPort = await unusedPort();
    while (routerPort === runnerPort || routerPort === secondPort) routerPort = await unusedPort();
    const callbackUrl = `http://127.0.0.1:${routerPort}/v1/mcp/oauth/callback`;
    const keyFile = join(scratch, "mcp-credential-key");
    if (options.managed) {
      const key = randomBytes(32); let file: Awaited<ReturnType<typeof open>> | undefined;
      try { file = await open(keyFile, "wx", 0o600); await file.writeFile(key); await file.sync(); }
      finally { key.fill(0); await file?.close(); }
    }
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test", STORE: options.mysqlUrl ? "mysql" : "memory", ...mysqlRuntimeEnv,
      SECRETS_MASTER_KEY: randomBytes(32).toString("hex"), INTERNAL_ROUTER_TOKEN: internalToken,
      PLATFORM_PROVIDER: "deepseek", API_KEY: providerKey, API_BASE_URL: vendorUrl, DEFAULT_MODEL: "deepseek-chat",
      BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: options.managed ? "15000" : "5000",
      ...(options.managed ? { MCP_REGISTRY_ENABLED: "1", MCP_REGISTRY_CREDENTIAL_KEY_FILE: keyFile,
        MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-progress-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl,
        REDIS_URL: options.managed.redisUrl, REDIS_PREFIX: options.managed.redisPrefix, REDIS_NAMESPACE_ID: options.managed.redisNamespaceId,
        ERASURE_ROUTER_URL: `http://127.0.0.1:${routerPort}` } : { MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify(servers) }),
      LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000",
    };
    startupUncertain = true;
    runner = await startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort), RUNNER_ADDR: `127.0.0.1:${runnerPort}`,
      RUNNER_ID: `mcp-progress-${randomBytes(6).toString("hex")}`, BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: OWNER.tenantId, BLOB_DIR: join(scratch, "blobs") });
    startupUncertain = false;
    const runnerUrl = await origin(runner.server as HttpServer);
    expect(runner.cfg.STORE).toBe(options.mysqlUrl ? "mysql" : "memory");
    if (options.managed) {
      startupUncertain = true;
      secondRunner = await startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(secondPort), RUNNER_ADDR: `127.0.0.1:${secondPort}`,
        RUNNER_ID: `mcp-progress-second-${randomBytes(6).toString("hex")}`, BLOB_DIR: join(scratch, "second-blobs") });
      startupUncertain = false; expect(await origin(secondRunner.server as HttpServer)).toBe(`http://127.0.0.1:${secondPort}`);
    } else expect(runner.cfg.REDIS_URL).toBeUndefined();
    for (const current of [runner, ...(secondRunner ? [secondRunner] : [])]) for (const enabled of [current.cfg.BLOB_CLEANUP_ENABLED, current.cfg.ERASURE_WORKER_ENABLED,
      current.cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED, current.cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED, current.cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED,
      current.cfg.TENANT_REDIS_PURGE_WORKER_ENABLED, current.cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED, current.cfg.DATA_EXPORT_WORKER_ENABLED]) expect(enabled).toBe(false);
    const beforeRouter = listeners(); startupUncertain = true;
    router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort),
      RUNNERS: secondRunner ? `${runnerUrl},http://127.0.0.1:${secondPort}` : runnerUrl,
      INTERNAL_ROUTER_TOKEN: internalToken, HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0",
      ...(options.managed ? { MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-progress-key-v1",
        MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl, REDIS_URL: options.managed.redisUrl, REDIS_PREFIX: options.managed.redisPrefix,
        REDIS_NAMESPACE_ID: options.managed.redisNamespaceId } : {}) });
    startupUncertain = false; routerListeners = new Map(SIGNALS.map(signal => [signal, process.listeners(signal).filter(listener => !beforeRouter.get(signal)!.includes(listener))]));
    const routerUrl = await origin(router.server as HttpServer);
    expect(routerUrl).toBe(`http://127.0.0.1:${routerPort}`);
    expect(router.registry.list().every(entry => entry.healthy)).toBe(true);
    expect(router.registry.list()).toHaveLength(options.managed ? 2 : 1);
    const cap = await json(routerUrl, "/v1/capabilities"); expect(cap.status).toBe(200);
    const capabilities = Capabilities.parse(cap.body);
    if (options.managed) {
      expect(capabilities.features.mcpRegistry).toEqual([MANAGED_MCP_REGISTRY_V1]);
      expect(capabilities.features.mcpRegistryIdentity).toEqual(runner.mcpRegistry!.identity);
      expect(secondRunner!.mcpRegistry!.identity).toEqual(runner.mcpRegistry!.identity);
      const runtime = await json(routerUrl, "/v1/tenant/api-keys", { method: "POST", body: JSON.stringify({ keyId: "mcp-progress-runtime", scopes: ["runtime"] }) });
      expect(runtime.status).toBe(201); const runtimeKey = CreateApiKeyResponse.parse(runtime.body);
      const runtimeHeaders = { authorization: `Bearer ${runtimeKey.key}` };
      const installed = await json(routerUrl, "/v1/mcp-servers", { method: "POST", headers: { ...runtimeHeaders, "idempotency-key": "progress-register-alpha" },
        body: JSON.stringify({ scope: "user", name: "alpha", expectedRevision: 0, config: { endpoint, description: "Owned stateful MCP fixture",
          protocolVersion: "2025-11-25", authentication: { kind: "none" } } }) });
      expect(installed.status).toBe(201); const registration = McpRegistrationResponse.parse(installed.body);
      managedRegistrationVersionId = registration.version!.configVersionId;
      expect(registration.version!.config.protocolVersion).toBe("2025-11-25");
      const [tool] = await runner.mcpRegistry!.discover(OWNER, { scope: "user", name: "alpha" }, lifetime.signal);
      const [secondTool] = await secondRunner!.mcpRegistry!.discover(OWNER, { scope: "user", name: "alpha" }, lifetime.signal);
      if (!tool?.approvalScope) throw new Error("MCP progress exact managed scope unavailable");
      toolName = tool.name; approvalScope = tool.approvalScope; expect(secondTool?.approvalScope).toBe(approvalScope);
      expect((await json(routerUrl, "/v1/mcp-servers/alpha?scope=user", { headers: runtimeHeaders }, CALLER.userId)).status).toBe(404);
    } else expect(capabilities.features.mcp).toEqual(["streamable-http"]);
    vendor.script({ toolCalls: [{ id: "call_mcp_progress", name: toolName, args: JSON.stringify({ text: ARGUMENT }), argChunks: 3 }] }, { text: FINAL_TEXT });
    const createdAgent = await json(routerUrl, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "MCP progress vertical", instructions: "Call the configured tool and answer from its final result.",
      model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], ...(options.managed ? { mcpRegistrations: [{ scope: "user", name: "alpha" }] } : { mcpServers: ["alpha"] }),
      approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 15000 } }) }, CALLER.userId);
    expect(createdAgent.status).toBe(201); const agent = AgentDefinition.parse(createdAgent.body);
    const created = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id, userId: OWNER.userId }) }, CALLER.userId);
    expect(created.status).toBe(201); const session = Session.parse(created.body); sessionId = session.id;
    expect(session.userId).toBe(OWNER.userId); expect(session.lastSeq).toBe(1);
    expect((await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }, CALLER.userId)).status).toBe(404);
    const sdkOptions = { baseUrl: routerUrl, serviceApiKey: bootstrapKey, userId: OWNER.userId };
    await expect(subscribeSessionEvents({ ...sdkOptions, userId: CALLER.userId, signal: lifetime.signal }, session.id)).rejects.toMatchObject({ response: { status: 404 }, body: { error: { code: "not_found" } } });
    const otherKey = `mcp-other-tenant-${randomBytes(16).toString("hex")}`;
    await runner.store.createApiKey("t_other_progress", "other-progress-key", createHash("sha256").update(otherKey).digest("hex"), ["runtime"]);
    await expect(subscribeSessionEvents({ ...sdkOptions, serviceApiKey: otherKey, signal: lifetime.signal }, session.id)).rejects.toMatchObject({ response: { status: 404 }, body: { error: { code: "not_found" } } });
    await options.beforeTurn?.({ sessionId: session.id, signal: lifetime.signal });
    const liveAbort = new AbortController(); lifetime.signal.addEventListener("abort", () => liveAbort.abort(), { once: true });
    const started = await startTurnStream({ ...sdkOptions, signal: liveAbort.signal }, session.id,
      { input: [{ type: "text", text: "Call the configured tool and report its final result." }] }, { idempotencyKey: "mcp-progress-turn" });
    if (started.kind !== "events") throw new Error("MCP progress expected a new real SDK turn stream");
    const live = observe(started, liveAbort); streams.push(live);
    const approval = await waitFor(() => {
      live.healthy(); const event = live.frames.find(frame => frame.data.type === "approval/requested")?.data;
      if (live.frames.some(frame => frame.data.type === "turn/completed")) throw new Error("MCP progress turn completed before required approval");
      return event?.type === "approval/requested" ? event.approval : undefined;
    }, lifetime.signal, "approval");
    expect(remote.calls).toHaveLength(0); expect(remote.progressSent).toHaveLength(0);
    expect(live.frames.some(frame => frame.data.type === PROGRESS_TYPE)).toBe(false);
    const before = await runner.store.listItems(session.id, { limit: 100 });
    expect(before.find(item => item.type === "toolCall")?.startedAtMs).toBeUndefined();
    const accepted = await json(routerUrl, `/v1/sessions/${session.id}/approvals/${approval.id}`, { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) });
    expect(accepted.status).toBe(200); expect(Approval.parse(accepted.body)).toMatchObject({ status: "resolved", decision: "acceptForSession" });
    const progressFrame = await waitFor(() => { live.healthy(); return live.frames.find(frame => frame.data.type === PROGRESS_TYPE); }, lifetime.signal, "live SDK progress");
    const progress = progressFrame.data;
    if (progress.type !== PROGRESS_TYPE) throw new Error("MCP progress event type unavailable");
    expect(progress).toMatchObject({ sessionId: session.id, turnId: approval.turnId, toolCallId: "call_mcp_progress", progress: 1, total: 2, message: PROGRESS_MESSAGE });
    expect(progress.seq).toBeUndefined();
    const inFlight = await runner.store.listItems(session.id, { limit: 100 });
    const call = inFlight.find(item => item.type === "toolCall");
    expect(call).toMatchObject({ kind: "mcp", name: toolName, status: "inProgress", startedAtMs: expect.any(Number) });
    expect(progress.itemId).toBe(call!.id); expect(inFlight.some(item => item.type === "toolResult")).toBe(false);
    expect(live.frames.some(frame => frame.data.type === "turn/completed")).toBe(false);
    expect(progressFrame.id).toBe(String(persisted(live).at(-1)!.seq));
    expect((await runner.store.getSession(OWNER.tenantId, session.id))?.autoApprovedTools).toEqual([]);
    expect(remote.calls).toHaveLength(1); expect(remote.progressSent).toHaveLength(1); expect(vendor.requests).toHaveLength(1);
    await options.afterProgress?.({ sessionId: session.id, signal: lifetime.signal });
    const cursor = persisted(live).at(-1)!.seq;
    await live.close(); expect(remote.calls).toHaveLength(1);
    releaseReply();
    const turn = await waitFor(async () => {
      const response = await json(routerUrl, `/v1/sessions/${session.id}/turns/${approval.turnId}`); expect(response.status).toBe(200);
      const value = Turn.parse(response.body); return value.status === "inProgress" ? undefined : value;
    }, lifetime.signal, "completed second model step");
    expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
    expect(remote.calls).toEqual([{ name: "echo", arguments: { text: ARGUMENT } }]); expect(vendor.requests).toHaveLength(2);
    const secondMessages = vendor.requests[1]!.body.messages as Record<string, unknown>[];
    expect(secondMessages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call_mcp_progress", content: RESULT })]));
    expect(JSON.stringify(secondMessages).includes(PROGRESS_MESSAGE)).toBe(false);
    expect(vendor.requests[1]!.headers.authorization === `Bearer ${providerKey}`).toBe(true);
    const finalItems = await runner.store.listItems(session.id, { limit: 100 });
    expect(finalItems.filter(item => item.type === "toolCall")).toEqual([expect.objectContaining({ id: call!.id, kind: "mcp", status: "completed", startedAtMs: expect.any(Number) })]);
    expect(finalItems.filter(item => item.type === "toolResult")).toEqual([expect.objectContaining({ name: toolName, isError: false, content: [{ type: "text", text: RESULT }] })]);
    const resumed = await json(routerUrl, `/v1/sessions/${session.id}/resume`, { method: "POST" }); expect(resumed.status).toBe(200);
    const snapshot = ResumeSessionResponse.parse(resumed.body); const finalSeq = snapshot.lastSeq;
    expect(snapshot.session.status).toEqual({ type: "idle" }); expect(snapshot.pendingApprovalIds).toEqual([]); expect(snapshot.session.autoApprovedTools).toEqual([approvalScope]);
    for (const query of [{ after: 0 }, { lastEventId: cursor }]) {
      const replayAbort = new AbortController(); lifetime.signal.addEventListener("abort", () => replayAbort.abort(), { once: true });
      const replay = observe(await subscribeSessionEvents({ ...sdkOptions, signal: replayAbort.signal }, session.id, query), replayAbort); streams.push(replay);
      await waitFor(() => { replay.healthy(); return persisted(replay).at(-1)?.seq === finalSeq ? true : undefined; }, lifetime.signal, "SDK durable replay");
      await replay.close();
      expect(replay.frames.some(frame => frame.data.type === PROGRESS_TYPE)).toBe(false);
      expect(persisted(replay).map(event => event.seq)).toEqual(Array.from({ length: finalSeq - ("after" in query ? 0 : cursor) }, (_, index) => index + 1 + ("after" in query ? 0 : cursor)));
      for (const frame of replay.frames) if (typeof frame.data.seq === "number") expect(frame.id).toBe(String(frame.data.seq));
    }
    const durableEvents = await runner.store.readEvents(session.id, 0, 100);
    expect(durableEvents.some(event => (event as { type: string }).type === PROGRESS_TYPE)).toBe(false);
    expect(durableEvents.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
    expect(remote.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(1);
    if (options.managed) {
      expect(remote.requests.some(request => request.method === "GET" && request.sessionId !== null)).toBe(true);
      expect(remote.requests.some(request => request.rpcMethod === "initialize")).toBe(true);
      expect(remote.requests.some(request => request.rpcMethod === "server/discover")).toBe(false);
    } else {
      expect(remote.requests.every(request => request.method === "POST" && request.sessionId === null)).toBe(true);
      expect(remote.requests.some(request => request.rpcMethod === "server/discover")).toBe(true);
    }
    checkTime(); bodyPassed = true;
    return { owner: { ...OWNER }, sessionId: session.id, turnId: turn.id, approvalId: approval.id, toolName, callItemId: call!.id, approvalScope, finalSeq, toolResult: RESULT,
      ...(managedRegistrationVersionId === undefined ? {} : { managedRegistrationVersionId }), scratchDirectory: scratch };
  } finally {
    releaseReply(); clearTimeout(timer); lifetime.abort();
    const errors: unknown[] = []; const clean = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
    for (const stream of streams) await clean(() => stream.close());
    await clean(async () => { await discovery?.close(); });
    for (const current of [runner, secondRunner]) if (current && sessionId) {
      const active = current.host.activeTurn(sessionId); if (active) await clean(() => current.host.interrupt(OWNER, sessionId!, active.id));
    }
    if (router) { const closed = nativeClosed(router.server as HttpServer); await clean(() => router!.close()); await clean(() => closed); }
    for (const current of [runner, secondRunner]) if (current) { const closed = nativeClosed(current.server as HttpServer); await clean(() => current.close()); await clean(() => closed); }
    await clean(() => vendor.stop()); await clean(() => remote.stop());
    for (const signal of SIGNALS) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
    try {
      for (const current of [runner, secondRunner]) if (current) expect((current.server as HttpServer).listening).toBe(false);
      if (router) { expect((router.server as HttpServer).listening).toBe(false); expect(exit).not.toHaveBeenCalled(); }
      expect(remote.stats().openSockets).toBe(0); expect(remote.stats().activeExchanges).toBe(0); expect(remote.stats().activeSessions).toBe(0);
      for (const signal of SIGNALS) expect(process.listeners(signal)).toEqual(initialListeners.get(signal));
      if (startupUncertain) errors.push(new Error("MCP progress bootstrap ownership is uncertain"));
      if (errors.length) throw new AggregateError(errors, "MCP progress owned-resource cleanup failed");
      if (scratch && !options.managed && bodyPassed) await rm(scratch, { recursive: true, force: true });
      if (scratch && !bodyPassed) options.onRetainedScratch?.(scratch);
      options.onOwnedServicesClosed?.();
    } catch (error) {
      if (scratch) options.onRetainedScratch?.(scratch);
      throw error;
    } finally { exit.mockRestore(); vi.unstubAllEnvs(); }
  }
}
