import { randomUUID } from "node:crypto";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { Redis } from "ioredis";
import { describe, expect, it, type TestContext } from "vitest";
import { createRuntimeMetrics, guardRedisDatabaseSelection, type AgentDefinition } from "@agent-service/protocol";
import { MemoryEventBus, MemoryLeaseStore, MemorySessionStore, providerQuotaNamespaceSha256, RedisProviderPoolCoordinator, RedisProviderQuotaCoordinator } from "@agent-service/store";
import { createPersistedProviderFailureCapture, newId, PiEngine, PiSummariser, SessionHost, StaticToolRegistry, type SessionHostDeps } from "@agent-service/core";
import type { ProviderModelRequest } from "../../core/src/engine/types.js";
import { activateMemoryPersistedProviderCapture } from "../../core/test/persisted-provider-capture-fixture.js";
import { LocalAesGcmCipher, ProviderService } from "../src/index.js";

const owner = { tenantId: "chaos-tenant", userId: "chaos-user" }, reference = { provider: "chaos-provider", model: "chaos-model" };
const secret = "test-only-chaos-provider-key", fail = () => new Error("Gateway chaos fixture is unproven.");
type Domain = "quota" | "pool";
type Operation = { domain: Domain; mode: string; keys: string[]; member: string };
type Fault = { domain: Domain; mode: string; kind: "reject" | "lose" | "disconnect" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
function redisUrl(): URL {
  try {
    const raw = process.env.REDIS_TEST_URL;
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) throw fail();
    const url = new URL(raw);
    if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !/^[1-9][0-9]*$/.test(url.port) || Number(url.port) > 65535 || url.search || url.hash
      || !/^\/(?:0|[1-9][0-9]*)$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))) throw fail();
    return url;
  } catch { throw fail(); }
}
/** RESP2 framing only. Requests/replies are never executed as JS or printed on failure. */
function frame(bytes: Buffer, at = 0, depth = 0): { end: number; value: unknown } | undefined {
  if (depth > 8) throw fail(); const end = bytes.indexOf("\r\n", at); if (end < 0) return;
  const kind = bytes[at], word = bytes.subarray(at + 1, end).toString("utf8");
  if (kind === 43 || kind === 45 || kind === 58) return { end: end + 2, value: kind === 58 ? Number(word) : word };
  if (kind === 36) {
    if (!/^-?[0-9]+$/.test(word)) throw fail(); const length = Number(word);
    if (!Number.isSafeInteger(length) || length < -1 || length > 1_048_576) throw fail();
    if (length === -1) return { end: end + 2, value: null };
    if (bytes.length < end + length + 4) return;
    if (bytes.subarray(end + length + 2, end + length + 4).toString("ascii") !== "\r\n") throw fail();
    return { end: end + length + 4, value: bytes.subarray(end + 2, end + length + 2).toString("utf8") };
  }
  if (kind !== 42 || !/^[0-9]+$/.test(word) || Number(word) > 64) throw fail();
  let cursor = end + 2; const values: unknown[] = [];
  for (let index = 0; index < Number(word); index++) { const next = frame(bytes, cursor, depth + 1); if (!next) return;
    cursor = next.end; values.push(next.value); }
  return { end: cursor, value: values };
}
function operation(request: string[]): Operation | undefined {
  if (request[0]?.toLowerCase() !== "eval") return;
  const count = Number(request[2]); if (!Number.isSafeInteger(count) || count < 1 || count > 33) throw fail();
  const keys = request.slice(3, 3 + count), domain = keys[0]?.startsWith("provider-quota-v1:{") ? "quota"
    : keys[0]?.startsWith("provider-pool-v1:{") ? "pool" : undefined;
  if (!domain) throw fail(); const mode = request[3 + count]!;
  return { domain, mode, keys, member: request[4 + count] ?? "" };
}

async function proxy(target: URL, signal: AbortSignal, namespaceSha256: string) {
  const sockets = new Map<Socket, Promise<void>>(), fault = deferred<Operation>(), history: Operation[] = [];
  let armed: Fault | undefined, hit: Operation | undefined, applied = false, broken = false, closing: Promise<void> | undefined;
  const watch = (socket: Socket) => { sockets.set(socket, socket.closed ? Promise.resolve()
    : new Promise<void>(resolve => socket.once("close", () => resolve()))); };
  let cut: (() => void) | undefined;
  const server = createServer(front => {
    watch(front); if (signal.aborted || closing) { front.destroy(); return; }
    const back = createConnection({ host: target.hostname === "[::1]" ? "::1" : target.hostname, port: Number(target.port) }); watch(back);
    let incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0);
    const requests: { op?: Operation; held: boolean }[] = [];
    const stop = () => { front.destroy(); back.destroy(); };
    front.on("error", stop); back.on("error", stop); front.once("close", () => back.destroy()); back.once("close", () => front.destroy());
    front.on("data", bytes => {
      try {
        incoming = Buffer.concat([incoming, bytes]); if (incoming.length > 1_048_576) throw fail();
        while (incoming.length) {
          const next = frame(incoming); if (!next) break;
          if (!Array.isArray(next.value) || next.value.some(value => typeof value !== "string")) throw fail();
          const op = operation(next.value as string[]), selected = !hit && armed && op?.domain === armed.domain && op.mode === armed.mode;
          if (op && op.keys.some(key => !key.startsWith(`provider-${op.domain}-v1:{${namespaceSha256}}:`))) throw fail();
          const original = incoming.subarray(0, next.end); incoming = incoming.subarray(next.end);
          if (op) { if (history.length >= 256) throw fail(); history.push(op); }
          if (selected && armed?.kind === "reject") {
            // An explicitly injected wire error, not a claim about server ACL configuration.
            if (requests.length) throw fail(); hit = op; cut = stop;
            front.write("-NOPERM fixed gateway chaos rejection\r\n"); fault.resolve(op!); continue;
          }
          if (selected && armed?.kind === "disconnect") { hit = op; cut = stop; fault.resolve(op!); stop(); return; }
          const held = Boolean(selected && armed?.kind === "lose"); if (held) { hit = op; cut = stop; }
          if (requests.length >= 256) throw fail(); requests.push({ op, held }); back.write(original);
        }
      } catch { broken = true; stop(); fault.reject(fail()); }
    });
    back.on("data", bytes => {
      try {
        outgoing = Buffer.concat([outgoing, bytes]); if (outgoing.length > 1_048_576) throw fail();
        while (outgoing.length) {
          const next = frame(outgoing); if (!next) break; const request = requests.shift(); if (!request) throw fail();
          const original = outgoing.subarray(0, next.end); outgoing = outgoing.subarray(next.end);
          if (request.held) {
            if (!request.op || !Array.isArray(next.value) || next.value[0] !== 1) throw fail();
            applied = true; fault.resolve(request.op); continue; // Test reads actual Redis before discarding this acknowledged RESP.
          }
          front.write(original);
        }
      } catch { broken = true; stop(); fault.reject(fail()); }
    });
  });
  const listening = new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const close = () => closing ??= (async () => {
    fault.reject(fail()); for (const socket of sockets.keys()) socket.destroy();
    await Promise.allSettled([listening]);
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all(sockets.values()); signal.removeEventListener("abort", abort);
  })();
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await listening; signal.throwIfAborted(); const address = server.address(); if (!address || typeof address === "string") throw fail();
    const url = new URL(target); url.hostname = "127.0.0.1"; url.port = String(address.port);
    return { url: url.toString(), arm: (next: Fault) => { if (hit || armed) throw fail(); armed = next; }, fault: fault.promise,
      discard: () => { if (!hit || !cut) throw fail(); cut(); }, applied: () => applied, broken: () => broken,
      history, close, closed: () => [...sockets.keys()].every(socket => socket.closed) };
  } catch { await close(); throw fail(); }
}

type Network = Awaited<ReturnType<typeof proxy>>;
type HostBundle = { host: SessionHost; service: ProviderService; quota: RedisProviderQuotaCoordinator; pool: RedisProviderPoolCoordinator;
  requests: ProviderModelRequest[]; metrics: ReturnType<typeof createRuntimeMetrics>; captures: () => number; sessionId: string };
async function fixture(context: TestContext, body: (f: {
  store: MemorySessionStore; admin: Redis; network: Network; bundles: HostBundle[]; calls(): number;
  create(throughProxy?: boolean): Promise<HostBundle>;
  turn(bundle: HostBundle): Promise<{ turnId: string; result: Awaited<ReturnType<MemorySessionStore["getTurn"]>>;
    events: Awaited<ReturnType<MemorySessionStore["readEvents"]>>; items: Awaited<ReturnType<MemorySessionStore["listItems"]>> }>;
  onRequest(next: (response: ServerResponse) => void): void; peerClosed: Promise<void>;
}) => Promise<void>) {
  const target = redisUrl(), abort = new AbortController(), signal = AbortSignal.any([context.signal, abort.signal]);
  const prefix = `gateway-chaos-${randomUUID()}`, namespaceId = `gateway-chaos-${randomUUID()}`, opaqueRefKey = new Uint8Array(32).fill(61);
  const store = new MemorySessionStore({ now: () => Date.now() }, { tenantTelemetryRefKey: opaqueRefKey, tenantTelemetryPersistedProviderCaptureLocalOnly: true });
  const bundles: HostBundle[] = [], coordinators: (RedisProviderQuotaCoordinator | RedisProviderPoolCoordinator)[] = [];
  const buses: MemoryEventBus[] = [], leases: MemoryLeaseStore[] = [], pending = new Set<Promise<unknown>>();
  const sockets = new Map<Socket, Promise<void>>(), clients = new Set<Redis>(), responses = new Set<ServerResponse>();
  let reconnects = 0, callbackFailed = false;
  const peerClosed = deferred<void>(), fixtureDone = deferred<void>();
  let primary: unknown, cleanupFailed = false, completed = false, network: Network | undefined, closing: Promise<void> | undefined;
  let calls = 0, handler = (response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "chaos-completion", object: "chat.completion.chunk", created: 1, model: reference.model,
      choices: [{ index: 0, delta: { role: "assistant", content: "fixture success" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  };
  const watchSocket = (socket: Socket) => { if (!sockets.has(socket)) sockets.set(socket, socket.closed ? Promise.resolve()
    : new Promise<void>(resolve => socket.once("close", () => resolve()))); };
  const watchClient = (client: Redis) => {
    clients.add(client); const capture = () => { const stream = client.stream; if (stream) { watchSocket(stream); if (signal.aborted) stream.destroy(); } };
    for (const event of ["connect", "error", "close", "end"] as const) client.on(event, capture);
    client.on("reconnecting", () => { reconnects++; }); capture();
  };
  const admin = guardRedisDatabaseSelection(new Redis(target.toString(), { lazyConnect: true, retryStrategy: () => null,
    maxRetriesPerRequest: 0, enableReadyCheck: false, disableClientInfo: true, protocol: 2, connectTimeout: 1000, commandTimeout: 1000 }));
  watchClient(admin); let adminFailed = false; admin.on("error", () => { adminFailed = true; });
  const server = httpServer((_request, response) => {
    calls++; responses.add(response); response.once("close", () => { responses.delete(response); peerClosed.resolve(); });
    try { handler(response); } catch { callbackFailed = true; response.destroy(); }
  });
  server.on("connection", watchSocket);
  let listening: Promise<void> | undefined;
  const track = <T>(task: Promise<T>): Promise<T> => { pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task)); return task; };
  const close = () => closing ??= (async () => {
    abort.abort(); for (const response of responses) response.destroy(); for (const socket of sockets.keys()) socket.destroy();
    const draining = bundles.map(bundle => bundle.host.drain(2000));
    const coordinatorClose = coordinators.map(value => value.close());
    try { admin.disconnect(false); } catch { cleanupFailed = true; }
    const networkClose = network?.close();
    const ownedClosing = Promise.allSettled([...draining, ...coordinatorClose, ...(networkClose ? [networkClose] : []), ...(listening ? [listening] : [])]);
    while (pending.size) await Promise.allSettled([...pending]);
    const result = await ownedClosing;
    if (server.listening) { const stopped = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await stopped; }
    for (const socket of sockets.keys()) socket.destroy(); await Promise.all(sockets.values());
    const memory = await Promise.allSettled([...buses.map(bus => bus.close()), ...leases.map(lease => lease.close()), store.close()]);
    if ([...result, ...memory].some(value => value.status === "rejected") || [...sockets.keys()].some(socket => !socket.closed)
      || [...clients].some(client => client.status !== "end") || network?.closed() === false || adminFailed || reconnects !== 0 || callbackFailed) cleanupFailed = true;
  })();
  const onAbort = () => { void close().catch(() => { cleanupFailed = true; }); };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(async () => { if (!completed) onAbort(); await fixtureDone.promise; if (cleanupFailed) throw fail(); });
  try {
    signal.throwIfAborted(); await track(admin.connect()); signal.throwIfAborted();
    const info: unknown = await admin.client("INFO");
    if (typeof info !== "string" || Buffer.byteLength(info) > 16_384 || info.match(/(?:^|\s)db=([0-9]+)(?=\s|$)/)?.[1] !== target.pathname.slice(1)) throw fail();
    await activateMemoryPersistedProviderCapture(store); await store.createApiKey(owner.tenantId, "chaos-capture-key", "fixture-only-key-hash");
    signal.throwIfAborted(); network = await proxy(target, signal, providerQuotaNamespaceSha256({ prefix, namespaceId })); signal.throwIfAborted();
    listening = new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    await listening; signal.throwIfAborted(); const address = server.address(); if (!address || typeof address === "string") throw fail();
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    const create = async (throughProxy = true): Promise<HostBundle> => {
      signal.throwIfAborted(); const url = throughProxy ? network!.url : target.toString();
      const quota = new RedisProviderQuotaCoordinator({ url, prefix, namespaceId }); coordinators.push(quota);
      const pool = new RedisProviderPoolCoordinator({ url, prefix, namespaceId }); coordinators.push(pool);
      for (const value of [quota, pool]) watchClient((value as unknown as { port: { redis: Redis } }).port.redis);
      await track(Promise.all([quota.assertReady(), pool.assertReady()])); signal.throwIfAborted();
      const metrics = createRuntimeMetrics("runner");
      const service = new ProviderService({ store, cipher: new LocalAesGcmCipher("81".repeat(32)), assertBaseUrl: async () => {},
        platform: [{ config: { id: reference.provider, api: "openai-completions", baseUrl: endpoint, headers: {}, quota: {}, fallback: [],
          models: [{ id: reference.model, contextWindow: 32_000, maxOutputTokens: 100, input: ["text"], reasoning: false,
            price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] }, keyPool: [{ id: "slot", version: "v1", apiKey: secret }] }],
        quota: { coordinator: quota, tenant: { rpm: 10, concurrency: 1 }, user: {}, authorizeFleet: async proof => { proof.throwIfAborted(); } },
        keyPool: { coordinator: pool, policy: { threshold: 1 } }, gatewayObserver: metrics.providerGateway, persistedProviderFailureCaptureActive: true });
      const bus = new MemoryEventBus(), lease = new MemoryLeaseStore(); buses.push(bus); leases.push(lease);
      const requests: ProviderModelRequest[] = []; let captures = 0;
      const product = createPersistedProviderFailureCapture({ store, opaqueRefKey, requireFreshFleet: async proof => proof });
      const capture: NonNullable<SessionHostDeps["persistedProviderFailureCapture"]> = { commit: (batch, source) => { captures++; return product.commit(batch, source); } };
      const agent: AgentDefinition = { id: newId("agt"), tenantId: owner.tenantId, version: 1, name: "chaos fixture", instructions: "fixture",
        model: reference, tools: [], mcpServers: [], skills: [], limits: {}, approvalPolicy: "never", busyPolicy: "reject", sandbox: "none", metadata: {}, createdAtMs: Date.now() };
      await store.createAgent(agent); signal.throwIfAborted();
      const host = new SessionHost({ store, bus, lease, engine: new PiEngine(service.models), summariser: new PiSummariser(service.models),
        providers: { resolve: async (principal, ref) => { const resolved = await service.resolve(principal, ref); return { ...resolved,
          createRequest: (before?: () => Promise<void>) => { const request = resolved.createRequest!(before); requests.push(request); return request; } }; } },
        tools: new StaticToolRegistry([]), persistedProviderFailureCapture: capture, logger: { info() {}, warn() {}, error() {} },
        config: { runnerId: "gateway-chaos", runnerAddr: "127.0.0.1:1", leaseTtlMs: 5000, leaseHoldMs: 1 } });
      const bundle: HostBundle = { host, service, quota, pool, requests, metrics, captures: () => captures, sessionId: "" }; bundles.push(bundle);
      bundle.sessionId = (await host.createSession(owner, { agentId: agent.id, metadata: {} })).id; signal.throwIfAborted(); return bundle;
    };
    const turn = (bundle: HostBundle) => track((async () => {
      signal.throwIfAborted(); const begun = await bundle.host.beginTurn(owner, bundle.sessionId, { input: [{ type: "text", text: "fixture input" }], stream: true, metadata: {} });
      begun.run(); while (bundle.host.activeTurn(bundle.sessionId)) { signal.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
      return { turnId: begun.turn.id, result: await store.getTurn(bundle.sessionId, begun.turn.id), events: await store.readEvents(bundle.sessionId, 0, 1000),
        items: await store.listItems(bundle.sessionId, { afterSeq: 0, limit: 1000 }) };
    })());
    await body({ store, admin, network, bundles, calls: () => calls, create, turn, onRequest: next => { handler = next; }, peerClosed: peerClosed.promise });
    signal.throwIfAborted(); completed = true;
  } catch (error) { primary = error; }
  finally {
    try { await close(); } catch { cleanupFailed = true; }
    context.signal.removeEventListener("abort", onAbort); fixtureDone.resolve();
  }
  if (primary !== undefined) throw primary; if (cleanupFailed) throw fail();
}

type TurnResult = Awaited<ReturnType<Parameters<Parameters<typeof fixture>[1]>[0]["turn"]>>;
function metric(bundle: HostBundle, name: string, extra = ""): number {
  const prefix = `agent_service_provider_gateway_${name}{component="runner",scope="platform"${extra}} `;
  const line = bundle.metrics.render().split("\n").find(value => value.startsWith(prefix)); return line ? Number(line.slice(prefix.length)) : 0;
}
function transportClosed(bundle: HostBundle, domain: Domain): boolean {
  const client = (bundle[domain] as unknown as { port: { redis: Redis } }).port.redis;
  return client.status === "end" && client.stream?.closed === true;
}
function noAttempt(f: { store: MemorySessionStore; calls(): number }, bundle: HostBundle, result: TurnResult) {
  expect(result.result).toMatchObject({ status: "failed", error: { code: "draining" } });
  expect(result.items.filter(item => item.type === "agentMessage")).toEqual([]);
  expect(result.events.filter(event => event.type === "usage/updated")).toEqual([]);
  expect(f.store.usageLedger).toEqual([]); expect(f.store.billingUsageFacts.size).toBe(0);
  expect(bundle.captures()).toBe(0); expect(f.calls()).toBe(0);
  expect(metric(bundle, "attempts_total")).toBe(0); expect(metric(bundle, "attempts_in_progress")).toBe(0);
  expect(bundle.requests.length).toBe(1); expect(bundle.requests[0]!.wasDispatched()).toBe(false);
}
async function quotaState(admin: Redis, op: Operation, concurrency: boolean) {
  if (op.domain !== "quota" || op.keys.length !== 7 || !/^[a-f0-9]{64}$/.test(op.member)) throw fail();
  const rpm = await Promise.all([0, 2, 4].map(index => admin.zscore(op.keys[index]!, op.member)));
  const held = await Promise.all([1, 3, 5].map(index => admin.zscore(op.keys[index]!, op.member)));
  expect(rpm.every(value => value !== null)).toBe(true); expect(held.every(value => (value !== null) === concurrency)).toBe(true);
}
async function poolState(admin: Redis, op: Operation, state: number) {
  if (op.domain !== "pool" || op.keys.length !== 2 || !/^[a-f0-9]{64}$/.test(op.member)) throw fail();
  const raw = await admin.get(op.keys[1]!); if (raw === null) throw fail();
  const value: unknown = JSON.parse(raw); expect(Array.isArray(value) && value.length === 6 && value[0] === state).toBe(true);
}

// Test-only native RESP faults; no server CONFIG/ACL mutation, SQL, FLUSH or DEL. TTL state and
// immutable health evidence stay in these random namespaces. The fake vendor is real loopback HTTP,
// while canonical usage/billing and 0053 remain real Memory atomic paths, not a MySQL/cloud claim.
describe.skipIf(process.env.AGENT_SERVICE_INTEGRATION !== "1")("Gateway real Redis transport chaos through Host and Pi", () => {
  it("a native wire rejection stays pre-dispatch with no usage, billing fact or 0053 source", async context => fixture(context, async f => {
    const bundle = await f.create(); f.network.arm({ domain: "quota", mode: "enter", kind: "reject" });
    const result = await f.turn(bundle), op = await f.network.fault; noAttempt(f, bundle, result);
    expect(f.network.applied()).toBe(false); expect(f.network.broken()).toBe(false);
    expect(transportClosed(bundle, "quota")).toBe(true);
    expect((await Promise.all(op.keys.slice(0, 6).map(key => f.admin.exists(key)))).every(value => value === 0)).toBe(true);
    await expect(bundle.quota.assertReady()).rejects.toMatchObject({ reason: "unavailable" });
  }));

  it.for(["quota", "pool"] as const)("lost %s admission RESP cancels only that member and requires a new healthy Service to recover", async (domain, context) => fixture(context, async f => {
    const bundle = await f.create(); f.network.arm({ domain, mode: domain === "quota" ? "enter" : "acquire", kind: "lose" });
    const pending = f.turn(bundle); void pending.catch(() => {});
    try {
      const op = await f.network.fault; expect(f.network.applied()).toBe(true);
      if (domain === "quota") await quotaState(f.admin, op, true); else await poolState(f.admin, op, 0);
      f.network.discard(); const result = await pending; noAttempt(f, bundle, result);
      expect(transportClosed(bundle, domain)).toBe(true);
      if (domain === "quota") await quotaState(f.admin, op, false); else await poolState(f.admin, op, 2);
      expect(f.network.broken()).toBe(false);
      await expect((domain === "quota" ? bundle.quota : bundle.pool).assertReady()).rejects.toMatchObject({ reason: "unavailable" });
      const recovered = await f.create(false); expect(recovered.quota.namespaceSha256).toBe(bundle.quota.namespaceSha256);
      const success = await f.turn(recovered); expect(success.result?.status).toBe("completed"); expect(f.calls()).toBe(1);
      expect(f.store.usageLedger).toHaveLength(1); expect(f.store.billingUsageFacts.size).toBe(1);
      expect(f.store.usageLedger[0]!.usage.totalTokens).toBe(3); expect(f.store.usageLedger[0]!.usage.costCNY).toBeGreaterThan(0);
      expect(metric(recovered, "attempts_total")).toBe(1); expect(metric(recovered, "attempts_in_progress")).toBe(0);
      expect(bundle.captures() + recovered.captures()).toBe(0);
      const enter = f.network.history.find(value => value.domain === "quota" && value.mode === "enter"); if (!enter) throw fail();
      for (const key of [enter.keys[0]!, enter.keys[2]!, enter.keys[4]!]) expect(await f.admin.zcard(key)).toBe(2); // Unknown admission is never refunded.
      await expect((domain === "quota" ? bundle.quota : bundle.pool).assertReady()).rejects.toMatchObject({ reason: "unavailable" });
    } finally { if (f.network.applied()) f.network.discard(); await Promise.allSettled([pending]); }
  }));

  it("post-dispatch Redis disconnect cancels the actual vendor body and leaves unknown billing without forging 0053", async context => fixture(context, async f => {
    const bundle = await f.create();
    f.onRequest(response => { f.network.arm({ domain: "pool", mode: "renew", kind: "disconnect" });
      response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": held with no usage\n\n"); });
    const result = await f.turn(bundle); await f.network.fault; await f.peerClosed;
    expect(f.calls()).toBe(1); expect(f.network.broken()).toBe(false);
    expect(transportClosed(bundle, "pool")).toBe(true);
    expect(bundle.requests[0]!.wasDispatched()).toBe(true); expect(bundle.requests[0]!.hasLocalFailure?.()).toBe(true);
    expect(f.store.usageLedger).toHaveLength(1); expect(f.store.billingUsageFacts.size).toBe(1);
    expect(Object.hasOwn(f.store.usageLedger[0]!.usage, "costCNY")).toBe(false);
    expect(Object.hasOwn([...f.store.billingUsageFacts.values()][0]!, "costCNY")).toBe(false);
    expect(result.result?.status).toBe("failed"); expect(bundle.captures()).toBe(0);
    expect(metric(bundle, "attempts_total")).toBe(1); expect(metric(bundle, "attempts_in_progress")).toBe(0);
    expect(metric(bundle, "io_completions_total", ',outcome="local_abort"')).toBe(1);
    await expect(bundle.pool.assertReady()).rejects.toMatchObject({ reason: "unavailable" });
  }));

  it("a real vendor 503 remains the unknown-cost 0053 primary when its applied health-release RESP is lost", async context => fixture(context, async f => {
    const bundle = await f.create(); f.network.arm({ domain: "pool", mode: "release", kind: "lose" });
    f.onRequest(response => { response.writeHead(503); response.end("fixture provider unavailable"); });
    const pending = f.turn(bundle); void pending.catch(() => {});
    try {
      const op = await f.network.fault; expect(f.network.applied()).toBe(true); await poolState(f.admin, op, 1);
      f.network.discard(); const result = await pending;
      expect(transportClosed(bundle, "pool")).toBe(true);
      expect(f.calls()).toBe(1); expect(result.result).toMatchObject({ status: "failed", error: { code: "provider_error" } });
      expect(bundle.requests[0]!.wasDispatched()).toBe(true); expect(bundle.requests[0]!.hasLocalFailure?.()).toBe(false);
      expect(f.store.usageLedger).toHaveLength(1); expect(f.store.billingUsageFacts.size).toBe(1);
      expect(Object.hasOwn(f.store.usageLedger[0]!.usage, "costCNY")).toBe(false);
      expect(Object.hasOwn([...f.store.billingUsageFacts.values()][0]!, "costCNY")).toBe(false);
      expect(bundle.captures()).toBe(1); const failed = result.items.filter(item => item.type === "agentMessage" && item.status === "failed"); expect(failed).toHaveLength(1);
      expect(metric(bundle, "attempts_total")).toBe(1); expect(metric(bundle, "attempts_in_progress")).toBe(0);
      expect(metric(bundle, "io_completions_total", ',outcome="http_error"')).toBe(1);
      const proof = await f.store.getTenantTelemetryPersistedProviderCaptureBinding(); if (!proof) throw fail();
      expect(await f.store.verifyPersistedProviderStepFailureSource({ tenantId: owner.tenantId, sessionId: bundle.sessionId, turnId: result.turnId,
        itemId: failed[0]!.id, stepIndex: 1, freshProof: proof })).toMatchObject({ status: "source_verified_queued", sourceCount: 1, allDomainsComplete: false });
      await poolState(f.admin, op, 1); expect(f.network.broken()).toBe(false);
    } finally { if (f.network.applied()) f.network.discard(); await Promise.allSettled([pending]); }
  }));
});
