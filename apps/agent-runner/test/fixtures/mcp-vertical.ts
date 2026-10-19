import { randomBytes } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { ConfiguredMcpToolSource, newId } from "@agent-service/core";
import {
  AgentDefinition, Approval, Capabilities, Event, Item, ResumeSessionResponse, Session, Turn,
  CreateApiKeyResponse, McpRegistrationResponse, ToolListResponse, MANAGED_MCP_REGISTRY_V1,
  type PersistedEvent,
} from "@agent-service/protocol";
import { FakeMcp, FakeVendor } from "@agent-service/testkit";
import { startRouter } from "../../../agent-router/src/main.js";
import { startRunner } from "../../src/main.js";

// Real source bootstraps and four (managed: five) owned HTTP listeners in this Vitest process. Not
// proof of separate OS processes, public HTTPS/TLS, or an authenticated MCP server. Explicit managed
// mode adds a second runner plus real supplied MySQL/Redis under the caller's isolated ownership.
const owner = { tenantId: "t_mcp_vertical", userId: "u_owner" };
const caller = { ...owner, userId: "u_trusted_caller" };
// A priced preset is necessary: the product correctly stops unknown-cost models before tools.
// Its endpoint/key are still the entirely local FakeVendor fixture below.
const MODEL = "deepseek-chat";
const TOOL_ARGUMENT = "mcp-vertical-request";
const TOOL_RESULT = `mcp-result:${TOOL_ARGUMENT}`;
const FINAL_TEXT = "The real MCP result reached the second model request.";
const signals = ["SIGTERM", "SIGINT"] as const;
type Signal = (typeof signals)[number];
type SignalListeners = Map<Signal, NodeJS.SignalsListener[]>;

function signalListeners(): SignalListeners {
  return new Map(signals.map(signal => [signal, process.listeners(signal)]));
}
function addedListeners(before: SignalListeners): SignalListeners {
  return new Map(signals.map(signal => [signal, process.listeners(signal).filter(listener => !before.get(signal)!.includes(listener))]));
}
async function unusedLoopbackPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function listeningUrl(server: HttpServer): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    const ready = () => { server.off("error", failed); resolve(); };
    const failed = () => { server.off("listening", ready); reject(new Error("fixture listener failed")); };
    server.once("listening", ready);
    server.once("error", failed);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
function nativeClose(server: HttpServer): Promise<void> {
  return server.listening ? new Promise(resolve => server.once("close", () => resolve())) : Promise.resolve();
}
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (!signal.aborted && Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`MCP vertical timeout: ${label}`);
}

interface Frame { id?: number; data: Event }
interface Sse {
  readonly frames: Frame[];
  readonly ready: Promise<Response>;
  readonly done: Promise<void>;
  assertHealthy(): void;
  close(): Promise<void>;
}
function openSse(url: string, headers: RequestInit["headers"], lifetime: AbortSignal, init: RequestInit = {}): Sse {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, lifetime]);
  const frames: Frame[] = [];
  let failure: unknown;
  const ready = fetch(url, { ...init, headers, signal });
  const done = (async () => {
    const response = await ready;
    if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      await response.body?.cancel();
      throw new Error("MCP vertical expected SSE response");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1_048_576) throw new Error("MCP vertical SSE exceeded bound");
        buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n");
        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const kind = /^event: ?(.*)$/m.exec(block)?.[1];
          const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!kind || !data) continue;
          const event = Event.parse(JSON.parse(data));
          if (kind !== event.type || frames.length >= 256) throw new Error("MCP vertical invalid SSE frame");
          const id = /^id: ?(.*)$/m.exec(block)?.[1];
          if (id !== undefined && !/^\d+$/.test(id)) throw new Error("MCP vertical invalid SSE cursor");
          frames.push({ ...(id === undefined ? {} : { id: Number(id) }), data: event });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })().catch(error => { if (!signal.aborted) failure = error; });
  return {
    frames, ready, done,
    assertHealthy: () => { if (failure) throw failure; },
    close: async () => { abort.abort(); await done; if (failure) throw failure; },
  };
}
function persisted(stream: Sse): PersistedEvent[] {
  return stream.frames.flatMap(frame => typeof frame.data.seq === "number" ? [frame.data as PersistedEvent] : []);
}

export interface McpVerticalOptions {
  mysqlUrl?: string;
  /** Prepared by the owning wrapper; contains only the restricted runtime URL and metadata identity. */
  mysqlRuntimeEnv?: Readonly<Record<string, string>>;
  /** Explicit managed/no-auth profile, never an OAuth or anonymous registration substitute. */
  managed?: { redisUrl: string; redisPrefix: string; redisNamespaceId: string };
  approvalDecision?: "accept" | "acceptForSession";
  /** Called after known startup ownership and every service close settles. Managed scratch is
   * handed back to the caller for removal only after its independent cold verification. */
  onOwnedServicesClosed?: () => void;
  /** Failure evidence can include a protected test key; report only its directory, never bytes. */
  onRetainedScratch?: (directory: string) => void;
}
export interface McpVerticalResult {
  owner: typeof owner;
  sessionId: string;
  turnId: string;
  approvalId: string;
  toolName: string;
  approvalScope: string;
  approvalDecision: "accept" | "acceptForSession";
  toolResult: string;
  finalSeq: number;
  managedRegistrationVersionId?: string;
  managedScratchDirectory?: string;
}

export async function runMcpVertical(options: McpVerticalOptions = {}): Promise<McpVerticalResult> {
    // Source bootstraps receive a closed env object. The optional MySQL URL belongs to the
    // wrapper's absent-checked new database; no .env, shared Redis, cloud or real model is used.
    const approvalDecision = options.approvalDecision ?? "accept";
    if (options.managed && !options.mysqlUrl) throw new Error("Managed MCP vertical requires an independently owned MySQL database");
    const mysqlRuntimeEnv = options.mysqlRuntimeEnv;
    const runtimeKeys = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
    if ((options.mysqlUrl !== undefined) !== (mysqlRuntimeEnv !== undefined)
      || mysqlRuntimeEnv !== undefined && (Object.keys(mysqlRuntimeEnv).length !== runtimeKeys.length
        || Object.keys(mysqlRuntimeEnv).some(key => !runtimeKeys.includes(key))
        || runtimeKeys.some(key => typeof mysqlRuntimeEnv[key] !== "string" || !mysqlRuntimeEnv[key]))) {
      throw new Error("MCP MySQL vertical requires an explicit prepared runtime environment.");
    }
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const initialListeners = signalListeners();
    let routerListeners: SignalListeners = new Map();
    const lifetime = new AbortController();
    const deadline = setTimeout(() => lifetime.abort(), 45_000);
    let scratch: string | undefined;
    const bootstrapKey = `mcp-fixture-${randomBytes(16).toString("hex")}`;
    const providerKey = "mcp-vertical-fake-provider-key";
    const internalToken = `mcp-internal-fixture-${randomBytes(24).toString("hex")}`;
    const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey });
    const remote = new FakeMcp();
    remote.responsePrefix = "mcp-result:";
    let releaseReply!: () => void;
    const replyBarrier = new Promise<void>(resolve => { releaseReply = resolve; });
    if (approvalDecision === "acceptForSession") remote.beforeReply = () => replyBarrier;
    let discovery: ConfiguredMcpToolSource | undefined;
    let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
    let secondRunner: Awaited<ReturnType<typeof startRunner>> | undefined;
    let router: Awaited<ReturnType<typeof startRouter>> | undefined;
    let sessionId: string | undefined;
    let startupUncertain = false;
    let bodyPassed = false;
    let managedRegistrationVersionId: string | undefined;
    const streams: Sse[] = [];
    const headers = (userId = owner.userId) => ({ authorization: `Bearer ${bootstrapKey}`, "x-user-id": userId, "content-type": "application/json" });
    const json = async (base: string, path: string, init: RequestInit = {}, userId = owner.userId) => {
      const requestHeaders = new Headers(headers(userId));
      new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
      const response = await fetch(`${base}${path}`, { ...init, headers: requestHeaders,
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.managed ? 30_000 : 5_000)]) });
      const body: unknown = await response.json();
      return { status: response.status, body };
    };
    try {
      scratch = await mkdtemp(join(tmpdir(), "agent-service-mcp-vertical-"));
      const endpoint = await remote.start();
      const servers = [{ id: "alpha", endpoint, subjects: [owner] }];
      let toolName = "", approvalScope = "";
      if (!options.managed) {
        // Obtain the legacy product's stable name through real discovery, not a naming stub.
        discovery = new ConfiguredMcpToolSource({ servers, timeoutMs: 5_000, allowLoopbackForTests: true });
        const tools = await discovery.resolve(owner, ["alpha"], AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]));
        expect(tools).toHaveLength(1); toolName = tools[0]!.name;
        const exactScope = tools[0]!.approvalScope;
        if (typeof exactScope !== "string" || !exactScope) throw new Error("MCP vertical expected exact approval scope");
        approvalScope = exactScope;
        expect(toolName).toMatch(/^mcp__[A-Za-z0-9_-]+$/); expect(toolName.length).toBeLessThanOrEqual(64); expect(remote.calls).toEqual([]);
        await discovery.close(); discovery = undefined;
        vendor.script({ toolCalls: [{ id: "call_mcp_vertical", name: toolName, args: JSON.stringify({ text: TOOL_ARGUMENT }), argChunks: 3 }] }, { text: FINAL_TEXT });
      }
      const vendorUrl = await vendor.start();
      const runnerPort = await unusedLoopbackPort();
      let secondRunnerPort = await unusedLoopbackPort();
      while (secondRunnerPort === runnerPort) secondRunnerPort = await unusedLoopbackPort();
      let routerPort = await unusedLoopbackPort();
      while (routerPort === runnerPort || routerPort === secondRunnerPort) routerPort = await unusedLoopbackPort();
      const callbackUrl = `http://127.0.0.1:${routerPort}/v1/mcp/oauth/callback`;
      const keyFile = join(scratch, "mcp-credential-key");
      if (options.managed) {
        const key = randomBytes(32); let file: Awaited<ReturnType<typeof open>> | undefined;
        try { file = await open(keyFile, "wx", 0o600); await file.writeFile(key); await file.sync(); }
        finally { key.fill(0); await file?.close(); }
      }
      const masterKey = randomBytes(32).toString("hex");
      const runnerEnvironment: NodeJS.ProcessEnv = {
        NODE_ENV: "test", STORE: options.mysqlUrl ? "mysql" : "memory", ...mysqlRuntimeEnv,
        SECRETS_MASTER_KEY: masterKey, INTERNAL_ROUTER_TOKEN: internalToken,
        PLATFORM_PROVIDER: "deepseek", API_KEY: providerKey, API_BASE_URL: vendorUrl, DEFAULT_MODEL: MODEL,
        BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
        MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: options.managed ? "15000" : "5000",
        ...(options.managed ? { MCP_REGISTRY_ENABLED: "1", MCP_REGISTRY_CREDENTIAL_KEY_FILE: keyFile,
          MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-vertical-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl,
          REDIS_URL: options.managed.redisUrl, REDIS_PREFIX: options.managed.redisPrefix,
          REDIS_NAMESPACE_ID: options.managed.redisNamespaceId, ERASURE_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
        } : { MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify(servers) }),
        LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000",
      };
      startupUncertain = true;
      runner = await startRunner({
        ...runnerEnvironment,
        RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
        RUNNER_ADDR: `127.0.0.1:${runnerPort}`, RUNNER_ID: `mcp-vertical-${randomBytes(6).toString("hex")}`,
        BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: owner.tenantId, BLOB_DIR: join(scratch, "blobs"),
      });
      startupUncertain = false;
      const runnerUrl = await listeningUrl(runner.server as HttpServer);
      expect(runnerUrl).toBe(`http://127.0.0.1:${runnerPort}`);
      expect(runner.cfg.STORE).toBe(options.mysqlUrl ? "mysql" : "memory");
      if (options.managed) {
        expect(runner.cfg.REDIS_URL === options.managed.redisUrl).toBe(true);
        startupUncertain = true;
        secondRunner = await startRunner({ ...runnerEnvironment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(secondRunnerPort),
          RUNNER_ADDR: `127.0.0.1:${secondRunnerPort}`, RUNNER_ID: `mcp-vertical-second-${randomBytes(6).toString("hex")}`,
          BLOB_DIR: join(scratch, "second-blobs") });
        startupUncertain = false;
        expect(await listeningUrl(secondRunner.server as HttpServer)).toBe(`http://127.0.0.1:${secondRunnerPort}`);
      } else expect(runner.cfg.REDIS_URL).toBeUndefined();
      for (const current of [runner, ...(secondRunner ? [secondRunner] : [])]) for (const enabled of [current.cfg.BLOB_CLEANUP_ENABLED, current.cfg.ERASURE_WORKER_ENABLED,
        current.cfg.TENANT_CREDENTIAL_REVOCATION_WORKER_ENABLED, current.cfg.TENANT_PURGE_EXECUTION_WORKER_ENABLED,
        current.cfg.TENANT_DATABASE_PURGE_WORKER_ENABLED, current.cfg.TENANT_REDIS_PURGE_WORKER_ENABLED,
        current.cfg.SESSION_USAGE_RETENTION_WORKER_ENABLED, current.cfg.DATA_EXPORT_WORKER_ENABLED]) expect(enabled).toBe(false);
      const beforeRouter = signalListeners();
      startupUncertain = true;
      router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: options.managed ? String(routerPort) : "0",
        RUNNERS: secondRunner ? `${runnerUrl},http://127.0.0.1:${secondRunnerPort}` : runnerUrl,
        INTERNAL_ROUTER_TOKEN: internalToken, HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0",
        ...(options.managed ? { MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1",
          MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-vertical-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callbackUrl,
          REDIS_URL: options.managed.redisUrl, REDIS_PREFIX: options.managed.redisPrefix, REDIS_NAMESPACE_ID: options.managed.redisNamespaceId } : {}) });
      startupUncertain = false;
      routerListeners = addedListeners(beforeRouter);
      const routerUrl = await listeningUrl(router.server as HttpServer);
      if (options.managed) {
        expect(router.cfg.REDIS_URL === options.managed.redisUrl).toBe(true);
        expect(routerUrl).toBe(`http://127.0.0.1:${routerPort}`);
        expect(router.registry.list()).toEqual([expect.objectContaining({ url: runnerUrl, healthy: true }),
          expect.objectContaining({ url: `http://127.0.0.1:${secondRunnerPort}`, healthy: true })]);
      } else {
        expect(router.cfg.REDIS_URL).toBeUndefined();
        expect(router.registry.list()).toEqual([expect.objectContaining({ url: runnerUrl, healthy: true })]);
      }
      const capabilityResponse = await json(routerUrl, "/v1/capabilities");
      expect(capabilityResponse.status).toBe(200);
      const capabilities = Capabilities.parse(capabilityResponse.body);
      expect(capabilities.service).toBe("agent-router");
      if (options.managed) {
        expect(capabilities.features.mcpRegistry).toEqual([MANAGED_MCP_REGISTRY_V1]);
        expect(capabilities.features.mcpRegistryIdentity).toEqual(runner.mcpRegistry!.identity);
        expect(secondRunner!.mcpRegistry!.identity).toEqual(runner.mcpRegistry!.identity);
        const keyResponse = await json(routerUrl, "/v1/tenant/api-keys", { method: "POST", body: JSON.stringify({ keyId: "managed-mcp-runtime", scopes: ["runtime"] }) });
        expect(keyResponse.status).toBe(201);
        const runtimeKey = CreateApiKeyResponse.parse(keyResponse.body); expect(runtimeKey.scopes).toEqual(["runtime"]);
        const runtimeHeaders = { authorization: `Bearer ${runtimeKey.key}` };
        const registered = await json(routerUrl, "/v1/mcp-servers", { method: "POST", headers: { ...runtimeHeaders, "idempotency-key": "managed-register-alpha" },
          body: JSON.stringify({ scope: "user", name: "alpha", expectedRevision: 0, config: { endpoint, description: "Owned no-auth MCP fixture",
            protocolVersion: "2026-07-28", authentication: { kind: "none" } } }) });
        expect(registered.status).toBe(201);
        const registration = McpRegistrationResponse.parse(registered.body);
        expect(registration.registration).toMatchObject({ scope: "user", name: "alpha", state: "enabled", revision: 1 });
        expect(registration.version!.config.authentication).toEqual({ kind: "none" });
        managedRegistrationVersionId = registration.version!.configVersionId;
        const discovered = await json(routerUrl, "/v1/mcp-servers/alpha/tools?scope=user", { headers: runtimeHeaders });
        expect(discovered.status).toBe(200); const descriptors = ToolListResponse.parse(discovered.body); expect(descriptors.data).toHaveLength(1);
        const tools = await runner.mcpRegistry!.discover(owner, { scope: "user", name: "alpha" }, lifetime.signal);
        const secondTools = await secondRunner!.mcpRegistry!.discover(owner, { scope: "user", name: "alpha" }, lifetime.signal);
        expect(tools).toHaveLength(1); expect(secondTools).toHaveLength(1); toolName = tools[0]!.name;
        if (typeof tools[0]!.approvalScope !== "string" || !tools[0]!.approvalScope) throw new Error("Managed MCP vertical expected exact approval scope");
        approvalScope = tools[0]!.approvalScope; expect(secondTools[0]!.approvalScope).toBe(approvalScope);
        expect(descriptors.data[0]!.name).toBe(toolName); expect(secondTools[0]!.name).toBe(toolName);
        expect(remote.calls).toEqual([]); expect(vendor.requests).toEqual([]);
        expect((await json(routerUrl, "/v1/mcp-servers/alpha?scope=user", { headers: runtimeHeaders }, caller.userId)).status).toBe(404);
        vendor.script({ toolCalls: [{ id: "call_mcp_vertical", name: toolName, args: JSON.stringify({ text: TOOL_ARGUMENT }), argChunks: 3 }] }, { text: FINAL_TEXT });
      } else expect(capabilities.features.mcp).toEqual(["streamable-http"]);
      expect(toolName).toMatch(/^mcp__[A-Za-z0-9_-]+$/); expect(toolName.length).toBeLessThanOrEqual(64);

      const agentResponse = await json(routerUrl, "/v1/agents", { method: "POST", body: JSON.stringify({
        name: "MCP vertical", instructions: "Use the mounted tool, then answer from its result.",
        model: { provider: "deepseek", model: MODEL }, tools: [], ...(options.managed ? { mcpRegistrations: [{ scope: "user", name: "alpha" }] } : { mcpServers: ["alpha"] }),
        approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 15000 },
      }) }, caller.userId);
      expect(agentResponse.status).toBe(201);
      const agent = AgentDefinition.parse(agentResponse.body);
      if (options.managed) { expect(agent.mcpServers).toEqual([]); expect(agent.mcpRegistrations).toEqual([{ scope: "user", name: "alpha" }]); }
      else expect(agent.mcpServers).toEqual(["alpha"]);
      // Only u_owner is mounted. A trusted caller can delegate creation to that exact owner;
      // resolving the catalog as u_trusted_caller would make this real HTTP request fail.
      const created = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id, userId: owner.userId }) }, caller.userId);
      expect(created.status).toBe(201);
      const session = Session.parse(created.body);
      sessionId = session.id;
      expect(session.userId).toBe(owner.userId);
      expect(session.lastSeq).toBe(1);
      expect(remote.calls).toEqual([]);
      const forbiddenMount = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) }, caller.userId);
      expect(forbiddenMount.status).toBe(404);
      const hidden = await json(routerUrl, `/v1/sessions/${session.id}`, {}, caller.userId);
      const absent = await json(routerUrl, `/v1/sessions/${newId("sess")}`, {}, caller.userId);
      expect(hidden.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(hidden.body).toEqual(absent.body);

      const first = openSse(`${routerUrl}/v1/sessions/${session.id}/turns`, headers(), lifetime.signal, {
        method: "POST", body: JSON.stringify({ input: [{ type: "text", text: "Call the configured MCP echo tool." }], stream: true }),
      });
      streams.push(first);
      expect((await first.ready).status).toBe(200);
      const approvalEvent = await waitFor(() => {
        first.assertHealthy();
        const frame = first.frames.find(frame => frame.data.type === "approval/requested");
        if (!frame) {
          const completed = first.frames.find(frame => frame.data.type === "turn/completed");
          if (completed?.data.type === "turn/completed") {
            const advertised = vendor.requests[0]?.body.tools;
            const calls = first.frames.flatMap(frame =>
              (frame.data.type === "item/started" || frame.data.type === "item/completed") && frame.data.item.type === "toolCall"
                ? [frame.data.item] : []);
            // Only closed protocol enums, counts and name-equality booleans cross this diagnostic
            // boundary. Never print provider responses, messages, arguments, URLs or headers.
            throw new Error(`MCP vertical completed before approval: ${JSON.stringify({
              status: completed.data.turn.status,
              stopReason: completed.data.stopReason,
              hasTurnError: completed.data.turn.error !== undefined,
              eventKinds: [...new Set(first.frames.map(frame => frame.data.type))],
              vendorRequests: vendor.requests.length,
              advertisedToolCount: Array.isArray(advertised) ? advertised.length : 0,
              advertisedToolNamesMatch: Array.isArray(advertised) && advertised.length === 1 && advertised.every(tool =>
                typeof tool === "object" && tool !== null && "function" in tool &&
                typeof tool.function === "object" && tool.function !== null && "name" in tool.function && tool.function.name === toolName),
              observedToolCallItems: calls.length,
              callToolNamesMatch: calls.length > 0 && calls.every(call => call.name === toolName),
              remoteCalls: remote.calls.length,
            })}`);
          }
        }
        return frame?.data.type === "approval/requested" ? frame.data : undefined;
      }, lifetime.signal, "approval/requested");
      expect(approvalEvent.approval.toolName).toBe(toolName);
      expect(remote.calls).toEqual([]);
      expect(vendor.requests).toHaveLength(1);
      const itemsBefore = await json(routerUrl, `/v1/sessions/${session.id}/items`);
      expect(itemsBefore.status).toBe(200);
      const before = (itemsBefore.body as { data: unknown[] }).data.map(item => Item.parse(item));
      expect(before.find(item => item.type === "toolCall")).toMatchObject({ kind: "mcp", name: toolName, status: "inProgress" });
      expect(before.find(item => item.type === "toolCall")?.startedAtMs).toBeUndefined();
      // A real public SSE disconnect does not authorize the tool or interrupt the pending turn.
      await first.close();
      const firstPersisted = persisted(first);
      const cursor = firstPersisted.at(-1)!.seq;
      expect(cursor).toBeGreaterThanOrEqual(approvalEvent.seq);
      expect(remote.calls).toEqual([]);
      const approved = await json(routerUrl, `/v1/sessions/${session.id}/approvals/${approvalEvent.approval.id}`, {
        method: "POST", body: JSON.stringify({ decision: approvalDecision }),
      });
      expect(approved.status).toBe(200);
      expect(Approval.parse(approved.body)).toMatchObject({ status: "resolved", decision: approvalDecision });
      if (approvalDecision === "acceptForSession") {
        await waitFor(() => remote.calls.length === 1 ? true : undefined, lifetime.signal, "held MCP reply");
        // Supplement the public HTTP assertions with real store observations while the actual
        // server has received the effect but cannot return a successful result yet.
        const suspended = await runner.store.getSession(owner.tenantId, session.id);
        expect(suspended?.autoApprovedTools).toEqual([]);
        const inFlight = await runner.store.listItems(session.id, { limit: 100 });
        expect(inFlight.find(item => item.type === "toolCall")).toMatchObject({ kind: "mcp", name: toolName, startedAtMs: expect.any(Number) });
        expect(inFlight.some(item => item.type === "toolResult")).toBe(false);
        expect(vendor.requests).toHaveLength(1);
        releaseReply();
      }
      const turn = await waitFor(async () => {
        const result = await json(routerUrl, `/v1/sessions/${session.id}/turns/${approvalEvent.approval.turnId}`);
        expect(result.status).toBe(200);
        const parsed = Turn.parse(result.body);
        return parsed.status === "inProgress" ? undefined : parsed;
      }, lifetime.signal, "completed turn");
      expect(turn).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 2, toolCalls: 1 });
      expect(remote.calls).toEqual([{ name: "echo", arguments: { text: TOOL_ARGUMENT } }]);
      expect(remote.methods).toContain("server/discover");
      expect(remote.methods.filter(method => method === "tools/call")).toHaveLength(1);
      expect(remote.methods).not.toContain("other");
      expect(vendor.requests).toHaveLength(2);
      const secondMessages = vendor.requests[1]!.body.messages as Record<string, unknown>[];
      expect(secondMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "call_mcp_vertical", content: TOOL_RESULT }),
      ]));
      expect(vendor.requests[1]!.headers.authorization).toBe(`Bearer ${providerKey}`);
      const itemsResponse = await json(routerUrl, `/v1/sessions/${session.id}/items`);
      expect(itemsResponse.status).toBe(200);
      const items = (itemsResponse.body as { data: unknown[] }).data.map(item => Item.parse(item));
      expect(items.find(item => item.type === "toolCall")).toMatchObject({ kind: "mcp", name: toolName, status: "completed", startedAtMs: expect.any(Number) });
      expect(items.find(item => item.type === "toolResult")).toMatchObject({ name: toolName, isError: false, content: [{ type: "text", text: TOOL_RESULT }] });
      expect(items.find(item => item.type === "agentMessage" && item.text === FINAL_TEXT)).toBeDefined();
      const resumedResponse = await json(routerUrl, `/v1/sessions/${session.id}/resume`, { method: "POST" });
      expect(resumedResponse.status).toBe(200);
      const resumedSession = ResumeSessionResponse.parse(resumedResponse.body);
      expect(resumedSession.session.status).toEqual({ type: "idle" });
      expect(resumedSession.pendingApprovalIds).toEqual([]);
      expect(resumedSession.session.autoApprovedTools).toEqual(approvalDecision === "acceptForSession" ? [approvalScope] : []);
      expect(resumedSession.recentTurns).toEqual(expect.arrayContaining([expect.objectContaining({ id: turn.id, status: "completed" })]));
      const finalSeq = resumedSession.lastSeq;

      const tail = openSse(`${routerUrl}/v1/sessions/${session.id}/events`, { ...headers(), "last-event-id": String(cursor) }, lifetime.signal);
      const full = openSse(`${routerUrl}/v1/sessions/${session.id}/events?after=0`, headers(), lifetime.signal);
      streams.push(tail, full);
      expect((await tail.ready).status).toBe(200);
      expect((await full.ready).status).toBe(200);
      await waitFor(() => {
        tail.assertHealthy(); full.assertHealthy();
        return persisted(tail).at(-1)?.seq === finalSeq && persisted(full).at(-1)?.seq === finalSeq ? true : undefined;
      }, lifetime.signal, "durable SSE replay");
      await Promise.all([tail.close(), full.close()]);
      const fullEvents = persisted(full), tailEvents = persisted(tail);
      expect(fullEvents.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
      expect(tailEvents).toEqual(fullEvents.filter(event => event.seq > cursor));
      expect([...firstPersisted, ...tailEvents].map(event => event.seq)).toEqual(Array.from({ length: finalSeq - 1 }, (_, index) => index + 2));
      for (const stream of streams) for (const frame of stream.frames) {
        if (typeof frame.data.seq === "number") expect(frame.id).toBe(frame.data.seq);
      }
      expect(tailEvents.some(event => event.type === "approval/resolved")).toBe(true);
      expect(tailEvents.some(event => event.type === "turn/completed" && event.turn.id === turn.id)).toBe(true);
      expect(remote.calls).toHaveLength(1);
      expect(vendor.requests).toHaveLength(2);
      bodyPassed = true;
      return { owner: { ...owner }, sessionId: session.id, turnId: turn.id, approvalId: approvalEvent.approval.id,
        toolName, approvalScope, approvalDecision, toolResult: TOOL_RESULT, finalSeq,
        ...(managedRegistrationVersionId === undefined ? {} : { managedRegistrationVersionId, managedScratchDirectory: scratch }) };
    } finally {
      // Release our own test barrier even if an assertion fails; shutdown must never wait on it.
      releaseReply();
      clearTimeout(deadline);
      lifetime.abort();
      const errors: unknown[] = [];
      const clean = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
      for (const stream of streams) await clean(() => stream.close());
      await clean(async () => { await discovery?.close(); });
      // Only this fixture's session can be interrupted during failure cleanup. This cleanup
      // path is not a substitute for public HTTP observations or the explicit held-reply checks.
      for (const current of [runner, secondRunner]) if (current && sessionId) {
        const active = current.host.activeTurn(sessionId);
        if (active) await clean(() => current.host.interrupt(owner, sessionId!, active.id));
      }
      if (router) {
        const closed = nativeClose(router.server as HttpServer);
        await clean(() => router!.close());
        await clean(() => closed);
      }
      if (runner) {
        await clean(() => runner!.close());
      }
      if (secondRunner) await clean(() => secondRunner!.close());
      await clean(() => vendor.stop());
      await clean(() => remote.stop());
      for (const signal of signals) for (const listener of routerListeners.get(signal) ?? []) process.off(signal, listener);
      if (scratch && !options.managed) await clean(() => rm(scratch!, { recursive: true, force: true }));
      try {
        if (router) expect((router.server as HttpServer).listening).toBe(false);
        if (runner) expect((runner.server as HttpServer).listening).toBe(false);
        if (secondRunner) expect((secondRunner.server as HttpServer).listening).toBe(false);
        for (const signal of signals) expect(process.listeners(signal)).toEqual(initialListeners.get(signal));
        if (router) expect(exit).toHaveBeenCalledWith(0);
        if (startupUncertain) errors.push(new Error("MCP vertical bootstrap ownership is uncertain; retain the fixture database"));
        if (errors.length) throw new AggregateError(errors, "MCP vertical owned-resource cleanup failed");
        if (scratch && options.managed && !bodyPassed) options.onRetainedScratch?.(scratch);
        options.onOwnedServicesClosed?.();
      } catch (error) {
        if (scratch && options.managed) options.onRetainedScratch?.(scratch);
        throw error;
      } finally {
        exit.mockRestore();
        vi.unstubAllEnvs();
      }
    }
}
