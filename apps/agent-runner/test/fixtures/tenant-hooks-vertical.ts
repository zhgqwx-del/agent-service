import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection, createServer as netServer, type Socket } from "node:net";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { newId } from "@agent-service/core";
import { AgentDefinition, Approval, Capabilities, Event, Session, Turn, TenantHookResponse, TenantHookDeliveriesResponse,
  type PersistedEvent } from "@agent-service/protocol";
import { createTenantWebhookAdminAccess } from "@agent-service/store";
import { FakeMcp, FakeVendor } from "@agent-service/testkit";
import { startRouter } from "../../../agent-router/src/main.js";
import { startRunner } from "../../src/main.js";
import { hashApiKey } from "../../src/auth.js";

const OWNER = { tenantId: "tenant_managed_hook_fixture", userId: "actual-owner" };
const CALLER = { ...OWNER, userId: "trusted-caller" }, CALL = "reused-model-tool-call";
const ARGUMENTS = ["FIRST_DISCLOSED_TOOL_ARGUMENT", "SECOND_DISCLOSED_TOOL_ARGUMENT"];
const PROMPTS = ["FIRST_ORIGINAL_CURRENT_TURN_PROMPT", "SECOND_ORIGINAL_CURRENT_TURN_PROMPT"];
const FINALS = ["First real observer-backed tool completed.", "Second tool completed despite an unknown observer ACK."];
const signals = ["SIGINT", "SIGTERM"] as const;
function failed(): never { throw new Error("Managed tenant hooks vertical fixture failed."); }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) failed(); return value as Record<string, unknown>; };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const digest = (domain: string, value: unknown) => createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex");
const mac = (key: Buffer, domain: string, value: unknown) => createHmac("sha256", key).update(domain).update("\0").update(canonical(value)).digest("hex");
async function port() {
  const listener = netServer(); await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); if (!address || typeof address === "string") failed();
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); return address.port;
}
async function url(server: Server) {
  if (!server.listening) await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address(); if (!address || typeof address === "string") failed(); return `http://127.0.0.1:${address.port}`;
}
async function closedPort(value: number) {
  return new Promise<boolean>(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port: value }); let refused = false;
    socket.setTimeout(1000, () => socket.destroy()); socket.once("connect", () => socket.destroy());
    socket.once("error", (error: NodeJS.ErrnoException) => { refused = error.code === "ECONNREFUSED"; }); socket.once("close", () => resolve(refused));
  });
}
async function wait<T>(read: () => T | undefined | Promise<T | undefined>, signal: AbortSignal): Promise<T> {
  const end = performance.now() + 10_000;
  while (!signal.aborted && performance.now() < end) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  failed();
}
interface Stream { events: PersistedEvent[]; ready: Promise<Response>; close(): Promise<void>; healthy(): void }
function sse(endpoint: string, headers: Record<string, string>, lifetime: AbortSignal, init: RequestInit = {}): Stream {
  const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime]);
  const events: PersistedEvent[] = []; let failure = false;
  const ready = fetch(endpoint, { ...init, headers, signal });
  const done = (async () => {
    const response = await ready; if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) failed();
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", size = 0;
    try { for (;;) {
      const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2_097_152) failed();
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n"); let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const raw = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!raw) continue; const value = Event.parse(JSON.parse(raw));
        expect(/^event: ?(.*)$/m.exec(block)?.[1]).toBe(value.type);
        if (typeof value.seq === "number") { expect(Number(/^id: ?(.*)$/m.exec(block)?.[1])).toBe(value.seq); events.push(value as PersistedEvent); }
        if (events.length > 500) failed();
      }
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  })().catch(() => { if (!signal.aborted) failure = true; });
  return { events, ready, healthy() { if (failure) failed(); }, async close() { abort.abort(); await done; if (failure) failed(); } };
}
export interface TenantHooksVerticalOptions {
  mysqlUrl: string; redisUrl: string; redisPrefix: string; redisNamespaceId: string;
  mysqlRuntimeEnv?: Readonly<Record<string, string>>;
  onOwnedServicesClosed(): void; onRetainedScratch(directory: string): void;
}
export interface TenantHooksVerticalResult {
  owner: typeof OWNER; sessionId: string; turnIds: string[]; finalSeq: number; scratchDirectory: string;
  callItemIds: string[]; intentIds: string[]; toolName: string; approvalScope: string;
}
/** Real source runner/router processes in this Vitest OS process, not a dist/VM or cloud proof. */
export async function runTenantHooksVertical(options: TenantHooksVerticalOptions): Promise<TenantHooksVerticalResult> {
  const mysqlRuntimeEnv = options.mysqlRuntimeEnv;
  const runtimeKeys = ["MYSQL_URL", "MYSQL_SCHEMA_METADATA_SCHEMA", "MYSQL_SCHEMA_METADATA_DEFINER_USER", "MYSQL_SCHEMA_METADATA_DEFINER_HOST"];
  if (!mysqlRuntimeEnv || Object.keys(mysqlRuntimeEnv).length !== runtimeKeys.length
    || Object.keys(mysqlRuntimeEnv).some(key => !runtimeKeys.includes(key))
    || runtimeKeys.some(key => typeof mysqlRuntimeEnv[key] !== "string" || !mysqlRuntimeEnv[key])) {
    throw new Error("Managed tenant hooks vertical requires an explicit prepared runtime environment.");
  }
  for (const [name, value] of Object.entries({ NODE_ENV: "test", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1" })) vi.stubEnv(name, value);
  const before = new Map(signals.map(signal => [signal, process.listeners(signal)]));
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const lifetime = new AbortController(), deadlineAt = performance.now() + 45_000;
  const timer = setTimeout(() => lifetime.abort(), 45_000);
  const signingKey = Buffer.alloc(32, 0x65), masterKey = Buffer.alloc(32, 0x76), providerKey = "tenant-hooks-private-fake-model-key";
  const bootstrapKey = randomBytes(32).toString("hex"), runtimeKey = randomBytes(32).toString("hex"), otherKey = randomBytes(32).toString("hex"), internal = randomBytes(32).toString("hex");
  const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey }), remote = new FakeMcp(); remote.responsePrefix = "actual-echo:";
  const runners: Awaited<ReturnType<typeof startRunner>>[] = [], streams: Stream[] = [], ports = new Set<number>();
  const peerSockets = new Map<Socket, Promise<void>>(), peerOperations = new Set<Promise<void>>();
  let router: Awaited<ReturnType<typeof startRouter>> | undefined, peer: Server | undefined;
  let scratch = "", keyFile = "", sessionId = "", routerUrl = "", toolName = "", stage = "startup", passed = false, startupUncertain = false;
  let activeRound = 0, peerFailed = false, preVerified = 0, postVerified = 0;
  const requests: Record<string, unknown>[] = [], turnIds: string[] = [], callItemIds: string[] = [];
  const headers = (key = bootstrapKey, user = OWNER.userId) => ({ authorization: `Bearer ${key}`, "x-user-id": user, "content-type": "application/json" });
  const json = async (base: string, path: string, init: RequestInit = {}, key = bootstrapKey, user = OWNER.userId) => {
    const response = await fetch(base + path, { ...init, headers: { ...headers(key, user), ...Object.fromEntries(new Headers(init.headers)) },
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) });
    const text = await response.text(); if (Buffer.byteLength(text) > 2_097_152) failed();
    return { status: response.status, body: text ? JSON.parse(text) as unknown : null, text };
  };
  try {
    const sql = new URL(options.mysqlUrl);
    if (sql.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(sql.hostname)
      || !/^agent_service_tenant_hooks_test_[a-f0-9]{24}$/.test(sql.pathname.slice(1)) || sql.search || sql.hash) failed();
    scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-service-tenant-hooks-vertical-"))); await chmod(scratch, 0o700);
    keyFile = join(scratch, "master-key.bin"); await writeFile(keyFile, masterKey, { mode: 0o600, flag: "wx" });
    const endpoint = await remote.start(); ports.add(Number(new URL(endpoint).port));
    const reply = (ordinal: number) => ({ get toolCalls() {
      const advertised = vendor.requests[ordinal]?.body.tools; if (!Array.isArray(advertised) || advertised.length !== 1) failed();
      const name = object(object(advertised[0]).function).name; if (typeof name !== "string") failed();
      if (toolName) expect(name).toBe(toolName); toolName = name;
      return [{ id: CALL, name, args: JSON.stringify({ text: ARGUMENTS[ordinal / 2] }), argChunks: 3 }];
    } });
    vendor.script(reply(0), { text: FINALS[0] }, reply(2), { text: FINALS[1] });
    const vendorUrl = await vendor.start(); ports.add(Number(new URL(vendorUrl).port));
    peer = createServer((req, res) => {
      const operation = (async () => {
        if (req.url !== "/observe" || req.method !== "POST") failed();
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16_384) failed(); chunks.push(Buffer.from(chunk)); }
        const raw = Buffer.concat(chunks).toString("utf8"), value = object(JSON.parse(raw));
        for (const secret of [providerKey, bootstrapKey, runtimeKey, otherKey, internal, masterKey.toString("hex"), signingKey.toString("hex"), keyFile,
          OWNER.tenantId, OWNER.userId, CALLER.userId, sessionId, "SYSTEM_NOT_DISCLOSED"]) expect(raw).not.toContain(secret);
        expect(Object.keys(req.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "content-length", "content-type", "host"].sort());
        expect(req.headers["accept-encoding"]).toBe("identity");
        const { macSha256: sentMac, requestSha256: sentDigest, ...payload } = value;
        expect(sentDigest).toBe(digest("tenant-webhook-request-digest-v2", payload));
        expect(sentMac).toBe(mac(signingKey, "tenant-webhook-request-mac-v2", { ...payload, requestSha256: sentDigest }));
        expect(value.schema).toBe("agent-service-tenant-tool-hook-request-v2");
        expect(value.tool).toEqual({ name: toolName, kind: "mcp" });
        expect(Object.values(object(value.refs)).every(ref => typeof ref === "string" && /^[a-f0-9]{64}$/.test(ref))).toBe(true);
        expect(Object.keys(object(value.refs)).sort()).toEqual(["tenant", "user", "session", "turn", "callItem"].sort());
        const source = runners[1]!; // Different product store/pool than the session's initial creator.
        const items = await source.store.listItems(sessionId, { limit: 100 });
        const currentCall = items.filter(item => item.type === "toolCall" && item.toolCallId === CALL).at(-1);
        if (!currentCall || currentCall.type !== "toolCall") failed();
        const body = object(value.body); expect(body.prompt).toEqual({ profile: "current_turn_user_text_v1", textParts: [PROMPTS[activeRound]] });
        expect(body.tool_arguments).toEqual({ text: ARGUMENTS[activeRound] });
        const access = createTenantWebhookAdminAccess({ tenantId: OWNER.tenantId, apiKeyId: "bootstrap" });
        const intents = await source.store.listTenantWebhookDeliveries({ access, name: value.phase === "preToolUse" ? "before" : "after", cursor: null, limit: 100 });
        expect(intents.items.some(intent => intent.invocationId === value.invocationId && intent.state === "sending" && intent.callItemId === currentCall.id)).toBe(true);
        if (value.phase === "preToolUse") {
          expect(currentCall.startedAtMs).toBeUndefined(); expect(items.some(item => item.type === "toolResult" && item.turnId === currentCall.turnId)).toBe(false);
          expect((await source.store.listApprovals(sessionId, {})).filter(approval => approval.turnId === currentCall.turnId)).toEqual([]);
          expect(Object.keys(body).sort()).toEqual(["prompt", "tool_arguments"]); preVerified++;
        } else {
          const result = items.find(item => item.type === "toolResult" && item.turnId === currentCall.turnId);
          expect(currentCall).toMatchObject({ status: "completed", startedAtMs: expect.any(Number) });
          expect(result).toMatchObject({ isError: false, content: [{ type: "text", text: `actual-echo:${ARGUMENTS[activeRound]}` }] });
          expect(body.tool_result).toMatchObject({ content: [{ type: "text", text: `actual-echo:${ARGUMENTS[activeRound]}` }] });
          const events = await source.store.readEvents(sessionId, 0, 200);
          expect(events.some(event => event.type === "item/completed" && event.item.id === result?.id)).toBe(true);
          expect(events.some(event => event.type === "tenant-hook/completed" && event.callItemId === currentCall.id && event.phase === "postToolUse")).toBe(false);
          expect(vendor.requests.length).toBe(activeRound * 2 + 1); postVerified++;
        }
        requests.push(value);
        if (activeRound === 1 && value.phase === "postToolUse") { res.destroy(); return; }
        const response = { schema: "agent-service-tenant-tool-hook-response-v2", webhookId: value.webhookId,
          configVersionId: value.configVersionId, phase: value.phase, invocationId: value.invocationId, requestSha256: value.requestSha256, decision: "ack" };
        res.writeHead(200, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ...response, macSha256: mac(signingKey, "tenant-webhook-response-mac-v2", response) }));
      })().catch(() => { peerFailed = true; res.destroy(); }).finally(() => peerOperations.delete(operation));
      peerOperations.add(operation);
    });
    peer.on("connection", socket => { const done = new Promise<void>(resolve => socket.once("close", () => { peerSockets.delete(socket); resolve(); })); peerSockets.set(socket, done); });
    await new Promise<void>(resolve => peer!.listen(0, "127.0.0.1", resolve)); const hookUrl = `${await url(peer)}/observe`; ports.add(Number(new URL(hookUrl).port));
    const routerPort = await port(), runnerPorts = [await port(), await port()];
    if (new Set([routerPort, ...runnerPorts]).size !== 3) failed();
    routerUrl = `http://127.0.0.1:${routerPort}`;
    const environment = { NODE_ENV: "test", STORE: "mysql", ...mysqlRuntimeEnv, REDIS_URL: options.redisUrl,
      REDIS_PREFIX: options.redisPrefix, REDIS_NAMESPACE_ID: options.redisNamespaceId,
      SECRETS_MASTER_KEY: "94".repeat(32), INTERNAL_ROUTER_TOKEN: internal, ERASURE_ROUTER_URL: routerUrl,
      PLATFORM_PROVIDER: "deepseek", DEFAULT_MODEL: "deepseek-chat", API_KEY: providerKey, API_BASE_URL: vendorUrl,
      BLOB_STORE: "filesystem", BLOB_ATTACHMENTS_ENABLED: "0", BLOB_CLEANUP_ENABLED: "0", BLOB_STORAGE_CONTROL_ENABLED: "0",
      MCP_ENABLED: "1", MCP_SERVERS_JSON: JSON.stringify([{ id: "echo", endpoint, subjects: [OWNER] }]),
      MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_TIMEOUT_MS: "5000", HOOKS_ALLOW_LOOPBACK_FOR_TESTS: "1", HOOKS_TIMEOUT_MS: "5000",
      TENANT_HOOKS_ENABLED: "1", HOOKS_MASTER_KEY_FILE: keyFile, HOOKS_MASTER_KEY_ID: "fixture-master-v2",
      ERASURE_WORKER_ENABLED: "0", LEGACY_TOMBSTONE_COMPENSATION_ENABLED: "0", DATA_EXPORT_WORKER_ENABLED: "0",
      DATA_EXPORT_CLEANUP_ENABLED: "0", LEASE_TTL_MS: "10000", LEASE_HOLD_MS: "20", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "60000" };
    for (let index = 0; index < 2; index++) {
      startupUncertain = true;
      runners.push(await startRunner({ ...environment, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPorts[index]),
        RUNNER_ADDR: `127.0.0.1:${runnerPorts[index]}`, RUNNER_ID: `${options.redisNamespaceId}-${index}`,
        BLOB_DIR: join(scratch, `blobs-${index}`), ...(index === 0 ? { BOOTSTRAP_API_KEY: bootstrapKey, BOOTSTRAP_TENANT_ID: OWNER.tenantId } : {}) }));
      startupUncertain = false; ports.add(Number(new URL(await url(runners[index]!.server as Server)).port));
    }
    await runners[0]!.store.createApiKey(OWNER.tenantId, "runtime-only", hashApiKey(runtimeKey), ["runtime"]);
    await runners[0]!.store.createApiKey("tenant_other_hooks_fixture", "other-admin", hashApiKey(otherKey), ["admin", "runtime"]);
    startupUncertain = true;
    router = await startRouter({ NODE_ENV: "test", ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort),
      RUNNERS: runnerPorts.map(value => `http://127.0.0.1:${value}`).join(","), INTERNAL_ROUTER_TOKEN: internal,
      REDIS_URL: options.redisUrl, REDIS_PREFIX: options.redisPrefix, REDIS_NAMESPACE_ID: options.redisNamespaceId,
      TENANT_HOOKS_ENABLED: "1", HOOKS_MASTER_KEY_ID: "fixture-master-v2", HEALTH_INTERVAL_MS: "1000", SHUTDOWN_GRACE_MS: "0" });
    startupUncertain = false; ports.add(routerPort); await url(router.server as Server);
    stage = "configuration";
    const capabilities = Capabilities.parse((await json(routerUrl, "/v1/capabilities")).body);
    expect(capabilities.features.tenantHooks).toEqual(["managed-tenant-hooks-v1"]);
    expect(runners[0]!.tenantHooks?.identity).toEqual(runners[1]!.tenantHooks?.identity);
    for (const phase of ["preToolUse", "postToolUse"] as const) {
      const name = phase === "preToolUse" ? "before" : "after", bodyScopes = phase === "preToolUse" ? ["prompt", "tool_arguments"] : ["prompt", "tool_arguments", "tool_result"];
      const body = JSON.stringify({ name, expectedRevision: 0, signingKey: signingKey.toString("hex"), config: { endpoint: hookUrl, phase, bodyScopes }, disclosureAck: "tenant-admin-body-disclosure-v1" });
      expect((await json(routerUrl, "/v1/tenant-hooks", { method: "POST", headers: { "idempotency-key": `install-${name}` }, body }, runtimeKey)).status).toBe(403);
      const installed = await json(routerUrl, "/v1/tenant-hooks", { method: "POST", headers: { "idempotency-key": `install-${name}` }, body });
      expect(installed.status).toBe(201); TenantHookResponse.parse(installed.body);
      expect(installed.text).not.toContain(signingKey.toString("hex"));
      const cross = await json(routerUrl, `/v1/tenant-hooks/${name}`, {}, otherKey); expect(cross.status).toBe(404);
      expect((await json(await url(runners[1]!.server as Server), `/v1/tenant-hooks/${name}`)).status).toBe(200);
    }
    const defined = await json(routerUrl, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "Managed observer vertical",
      instructions: "SYSTEM_NOT_DISCLOSED Use the real echo tool.", model: { provider: "deepseek", model: "deepseek-chat" },
      tools: [], mcpServers: ["echo"], approvalPolicy: "never", limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 20000 } }) }, bootstrapKey, CALLER.userId);
    expect(defined.status).toBe(201); const agent = AgentDefinition.parse(defined.body);
    const created = await json(routerUrl, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id, userId: OWNER.userId }) }, bootstrapKey, CALLER.userId);
    expect(created.status).toBe(201); sessionId = Session.parse(created.body).id;
    for (const suffix of ["", "/items", "/events"]) {
      expect((await json(routerUrl, `/v1/sessions/${sessionId}${suffix}`, {}, bootstrapKey, CALLER.userId)).status).toBe(404);
      expect((await json(routerUrl, `/v1/sessions/${sessionId}${suffix}`, {}, otherKey)).status).toBe(404);
    }
    expect((await json(routerUrl, `/v1/sessions/${newId("sess")}`, {}, bootstrapKey, CALLER.userId)).status).toBe(404);
    let cursor = 1, approvalScope = "";
    for (activeRound = 0; activeRound < 2; activeRound++) {
      stage = `turn-${activeRound}`;
      const stream = sse(`${routerUrl}/v1/sessions/${sessionId}/turns`, headers(), lifetime.signal,
        { method: "POST", body: JSON.stringify({ input: [{ type: "text", text: PROMPTS[activeRound] }], stream: true }) });
      streams.push(stream); expect((await stream.ready).status).toBe(200);
      if (activeRound === 0) {
        const approval = await wait(() => { stream.healthy(); const event = stream.events.find(event => event.type === "approval/requested"); return event?.type === "approval/requested" ? event : undefined; }, lifetime.signal);
        expect(preVerified).toBe(1); expect(peerFailed).toBe(false); expect(remote.calls).toHaveLength(0);
        cursor = approval.seq; await stream.close();
        const accepted = await json(routerUrl, `/v1/sessions/${sessionId}/approvals/${approval.approval.id}`,
          { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) });
        expect(accepted.status).toBe(200); Approval.parse(accepted.body);
        const turn = await wait(async () => { const read = await json(routerUrl, `/v1/sessions/${sessionId}/turns/${approval.approval.turnId}`);
          const value = Turn.parse(read.body); return value.status === "inProgress" ? undefined : value; }, lifetime.signal);
        turnIds.push(turn.id); expect(turn).toMatchObject({ status: "completed", steps: 2, toolCalls: 1 });
      } else {
        const completed = await wait(() => { stream.healthy(); const event = stream.events.find(event => event.type === "turn/completed"); return event?.type === "turn/completed" ? event : undefined; }, lifetime.signal);
        expect(stream.events.some(event => event.type === "approval/requested")).toBe(false); turnIds.push(completed.turn.id); await stream.close();
      }
      expect(remote.calls).toHaveLength(activeRound + 1); expect(vendor.requests).toHaveLength((activeRound + 1) * 2);
      const resultMessages = vendor.requests[activeRound * 2 + 1]!.body.messages as Record<string, unknown>[];
      expect(resultMessages.filter(message => message.role === "tool" && message.tool_call_id === CALL).at(-1)?.content).toBe(`actual-echo:${ARGUMENTS[activeRound]}`);
    }
    stage = "replay"; expect(peerFailed).toBe(false); expect(preVerified).toBe(2); expect(postVerified).toBe(2); expect(requests).toHaveLength(4);
    const items = await runners[1]!.store.listItems(sessionId, { limit: 100 });
    for (const item of items) if (item.type === "toolCall") callItemIds.push(item.id);
    expect(new Set(callItemIds).size).toBe(2);
    const current = await runners[1]!.store.getSession(OWNER.tenantId, sessionId); if (!current) failed();
    expect(current.status).toEqual({ type: "idle" }); expect(current.autoApprovedTools).toHaveLength(1); approvalScope = current.autoApprovedTools[0]!;
    const all = await runners[1]!.store.readEvents(sessionId, 0, 200), finalSeq = current.lastSeq;
    expect(all.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
    const hooks = all.filter(event => event.type === "tenant-hook/completed"); expect(hooks).toHaveLength(4);
    expect(hooks.map(event => event.outcome)).toEqual(["acknowledged", "acknowledged", "acknowledged", "outcome_unknown"]);
    expect(new Set(hooks.map(event => event.intentId)).size).toBe(4);
    for (const callItemId of callItemIds) expect(hooks.filter(event => event.callItemId === callItemId)).toHaveLength(2);
    const full = sse(`${routerUrl}/v1/sessions/${sessionId}/events?after=0`, headers(), lifetime.signal);
    const tail = sse(`${routerUrl}/v1/sessions/${sessionId}/events`, { ...headers(), "last-event-id": String(cursor) }, lifetime.signal);
    streams.push(full, tail); await Promise.all([full.ready, tail.ready]);
    await wait(() => { full.healthy(); tail.healthy(); return full.events.at(-1)?.seq === finalSeq && tail.events.at(-1)?.seq === finalSeq ? true : undefined; }, lifetime.signal);
    await Promise.all([full.close(), tail.close()]); expect(full.events).toEqual(all); expect(tail.events).toEqual(all.filter(event => event.seq > cursor));
    const statuses = [];
    for (const name of ["before", "after"]) {
      const status = await json(await url(runners[1]!.server as Server), `/v1/tenant-hooks/${name}/deliveries`);
      expect(status.status).toBe(200); statuses.push(...TenantHookDeliveriesResponse.parse(status.body).data);
      for (const value of [PROMPTS[0]!, ARGUMENTS[0]!, signingKey.toString("hex"), masterKey.toString("hex"), OWNER.tenantId, OWNER.userId, "payload", "ciphertext"])
        expect(status.text).not.toContain(value);
    }
    expect(statuses.filter(status => status.state === "outcome_unknown")).toHaveLength(1);
    expect((await readFile(keyFile)).equals(masterKey)).toBe(true);
    expect(performance.now()).toBeLessThan(deadlineAt); passed = true;
    return { owner: OWNER, sessionId, turnIds, finalSeq, scratchDirectory: scratch, callItemIds,
      intentIds: hooks.map(event => event.intentId), toolName, approvalScope };
  } catch { throw new Error(`Managed tenant hooks vertical failed at ${stage}.`); }
  finally {
    lifetime.abort(); const failures: unknown[] = [];
    const cleanup = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { failures.push(error); } };
    for (const stream of streams) await cleanup(() => stream.close());
    for (const runner of runners) if (sessionId) { const active = runner.host.activeTurn(sessionId); if (active) await cleanup(() => runner.host.interrupt(OWNER, sessionId, active.id)); }
    if (router) await cleanup(() => router!.close());
    for (const runner of runners) await cleanup(() => runner.close());
    if (peer) {
      const closed = new Promise<void>(resolve => peer!.close(() => resolve()));
      const sockets = [...peerSockets.values()]; for (const socket of peerSockets.keys()) socket.destroy();
      await cleanup(() => Promise.all([closed, ...sockets]));
      while (peerOperations.size) await cleanup(() => Promise.all([...peerOperations]));
    }
    await cleanup(() => vendor.stop()); await cleanup(() => remote.stop());
    await cleanup(async () => expect((await Promise.all([...ports].map(closedPort))).every(Boolean)).toBe(true));
    for (const signal of signals) for (const listener of process.listeners(signal)) if (!before.get(signal)!.includes(listener)) process.off(signal, listener);
    try {
      for (const signal of signals) expect(process.listeners(signal)).toEqual(before.get(signal));
      expect(peerSockets.size).toBe(0); expect(peerOperations.size).toBe(0);
      expect(runners.every(runner => !(runner.server as Server).listening)).toBe(true);
      if (router) { expect((router.server as Server).listening).toBe(false); expect(exit).not.toHaveBeenCalled(); }
      if (failures.length || startupUncertain || performance.now() >= deadlineAt) failed();
      options.onOwnedServicesClosed();
    } catch { passed = false; throw new Error("Managed tenant hooks owned-service cleanup failed."); }
    finally { clearTimeout(timer); masterKey.fill(0); signingKey.fill(0); exit.mockRestore(); vi.unstubAllEnvs();
      if (!passed && scratch) options.onRetainedScratch(scratch); }
  }
}
