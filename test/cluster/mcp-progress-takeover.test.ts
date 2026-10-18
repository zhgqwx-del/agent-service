import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import {
  AgentDefinition, Approval, Capabilities, Event, INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER,
  INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE, INTERNAL_MCP_REGISTRY_READY_PATH,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE, INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  MANAGED_MCP_REGISTRY_V1, McpRegistrationResponse, McpRegistryFleetResponse,
  Session, TenantRuntimeDrainReady, ToolListResponse, Turn, type McpRegistryIdentityCapability,
} from "../../packages/protocol/src/index.js";
import { MysqlSessionStore, redisSessionKeys } from "../../packages/store/src/index.js";
import { FakeStatefulMcp, FakeVendor } from "@agent-service/testkit";
import { startTurnStream, subscribeSessionEvents, type EventStreamResult } from "../../packages/sdk/src/index.js";
import { buildClusterChildEnv, type ClusterChildRole } from "./harness.js";

// Only the pure child-env helper is reused. Never call startCluster: it resets its configured DB
// and FLUSHes Redis. This case owns a fresh absent-checked schema and one random Redis prefix.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = { tenantId: "t_mcp_process_takeover", userId: "u_owner" };
const TOOL_CALL_ID = "call_mcp_takeover_effect";
const PROGRESS = "item/mcpToolCall/progress";
const RECOVERY_TEXT = "The previous tool outcome is unknown; no remote operation was repeated.";
type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
interface OwnedChild {
  readonly label: string; readonly url: string; readonly port: number; readonly child: ChildProcess;
  readonly closed: Promise<void>; readonly pid: number; exit?: Exit; closeSeen: boolean;
  spawnFailed: boolean; logFailed: boolean; logOverflow: boolean; hardCleanup: boolean; crashed: boolean;
}
function bases() {
  const rawSql = process.env.MYSQL_TEST_URL ?? process.env.CLUSTER_MYSQL_URL;
  const rawRedis = process.env.REDIS_TEST_URL ?? process.env.CLUSTER_REDIS_URL;
  if (!rawSql || !rawRedis) throw new Error("MCP process fixture requires explicit disposable MySQL and Redis URLs");
  let sql: URL, redis: URL;
  try { sql = new URL(rawSql); redis = new URL(rawRedis); } catch { throw new Error("MCP process fixture URLs invalid"); }
  const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
  const database = decodeURIComponent(sql.pathname.slice(1));
  if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(database) || !/(?:^|_)(?:test|cluster)(?:$|_)/i.test(database)
    || redis.protocol !== "redis:" || !local(redis) || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) throw new Error("MCP process fixture requires loopback disposable bases");
  return { sql, redis };
}
function sqlUrl(base: URL, database: string) { const value = new URL(base); value.pathname = `/${database}`; return value.toString(); }
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("MCP process fixture port unavailable");
  return address.port;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function ownedPid(proc: OwnedChild): number {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) throw new Error("MCP owned process identity is uncertain; no signal permitted");
  return proc.pid;
}
function groupAlive(proc: OwnedChild): boolean {
  const pid = ownedPid(proc);
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw new Error("MCP owned process-group state is uncertain"); }
}
function signalOwned(proc: OwnedChild, signal: NodeJS.Signals): void {
  // This is the exact PGID created by this spawn, never a name/port search or a shared parent group.
  const pid = ownedPid(proc);
  if (!groupAlive(proc)) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("MCP owned process signal was not confirmed"); }
}
async function settledWithin(proc: OwnedChild, milliseconds: number): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return true; }
    await sleep(10);
  }
  return proc.closeSeen && !groupAlive(proc);
}
async function stopOwned(proc: OwnedChild): Promise<void> {
  ownedPid(proc);
  if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return; }
  signalOwned(proc, "SIGTERM");
  if (!await settledWithin(proc, 5_000)) {
    proc.hardCleanup = true; signalOwned(proc, "SIGKILL");
    if (!await settledWithin(proc, 5_000)) throw new Error("MCP owned native process group did not settle");
  }
  await proc.closed;
}
function launch(label: string, role: ClusterChildRole, port: number, env: Record<string, string>, scratch: string): OwnedChild {
  const sink: WriteStream = createWriteStream(join(scratch, `${label}.log`), { flags: "wx", mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", `apps/agent-${role}/src/main.ts`], {
    cwd: ROOT, env: buildClusterChildEnv(process.env, env, role), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const proc: OwnedChild = { label, child, pid: child.pid ?? 0, port, url: `http://127.0.0.1:${port}`, closed,
    closeSeen: false, spawnFailed: false, logFailed: false, logOverflow: false, hardCleanup: false, crashed: false };
  let bytes = 0;
  const collect = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 1_048_576) { proc.logOverflow = true; return; }
    if (!sink.destroyed) sink.write(chunk);
  };
  sink.on("error", () => { proc.logFailed = true; });
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  child.once("error", () => { proc.spawnFailed = true; });
  child.once("exit", (code, signal) => { proc.exit = { code, signal }; });
  child.once("close", (code, signal) => {
    proc.exit ??= { code, signal }; proc.closeSeen = true;
    if (sink.closed) resolveClosed();
    else { sink.once("close", resolveClosed); if (!sink.destroyed) sink.end(); }
  });
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1) {
    // A spawn failure has no owned PGID. Never signal 0/the Vitest group.
    proc.spawnFailed = true; sink.end();
  }
  return proc;
}
async function ownedKeys(redis: Redis, prefix: string): Promise<string[]> {
  const keys = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = next;
    for (const key of found) { if (!key.startsWith(`${prefix}:`)) throw new Error("MCP process Redis ownership mismatch"); keys.add(key); }
    if (++rounds > 100 || keys.size > 2_000) throw new Error("MCP process Redis namespace exceeded bound");
  } while (cursor !== "0");
  return [...keys];
}
function observe(result: EventStreamResult, abort: AbortController) {
  const frames: { data: Event; id?: string }[] = []; let failed = false;
  const done = (async () => {
    try { for await (const frame of result.events) {
      const data = Event.parse(frame.data); if (data.type !== frame.event || frames.length >= 256) throw new Error("MCP process SDK frame invalid");
      frames.push({ data, ...(frame.id === undefined ? {} : { id: frame.id }) });
    } } catch { if (!abort.signal.aborted) failed = true; }
  })();
  return { frames, healthy() { if (failed) throw new Error("MCP process public SDK stream failed"); },
    async close() { abort.abort(); await done; if (failed) throw new Error("MCP process public SDK stream failed"); } };
}
function expectSameDurableEvents(hot: Event[], durable: Event[]): void {
  expect(hot).toHaveLength(durable.length);
  const comparable = structuredClone(hot);
  const bits = (value: number) => { const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, false); return view.getBigUint64(0, false); };
  for (let index = 0; index < comparable.length; index++) {
    const actual = comparable[index]!, expected = durable[index]!;
    if (actual.type !== "usage/updated" || expected.type !== "usage/updated") continue;
    for (const field of ["stepUsage", "turnUsage", "sessionUsage"] as const) {
      expect(Object.hasOwn(actual[field], "costCNY")).toBe(Object.hasOwn(expected[field], "costCNY"));
      if (!Object.hasOwn(actual[field], "costCNY")) continue;
      const a = actual[field].costCNY, b = expected[field].costCNY;
      if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) throw new Error("MCP process usage cost must remain finite and nonnegative");
      // Match the observed MySQL JSON round-trip boundary, not a general tolerance.
      const aBits = bits(a), bBits = bits(b), distance = aBits > bBits ? aBits - bBits : bBits - aBits;
      expect(distance <= 1n).toBe(true); actual[field].costCNY = b;
    }
  }
  expect(comparable).toEqual(durable);
}

describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER)("cluster: real stateful MCP effect, process death and fenced recovery", () => {
  it("never repeats an unknown tool effect after SIGKILL, fresh whole-fleet restart and survivor takeover", async context => {
    const base = bases(), suffix = randomBytes(12).toString("hex");
    const database = `agent_service_mcp_takeover_test_${suffix}`, prefix = `mcp_takeover_test_${suffix}`, namespace = `mcp_takeover_${suffix}`;
    const startedAt = performance.now(), url = sqlUrl(base.sql, database), expires = startedAt + 80_000;
    // Reserve 40 seconds of the unchanged 120-second case for native cleanup and evidence.
    const cleanupExpires = startedAt + 110_000;
    const lifetime = new AbortController(); const timer = setTimeout(() => lifetime.abort(), 80_000);
    const check = () => { if (lifetime.signal.aborted || context.signal.aborted || performance.now() >= expires) throw new Error("MCP process fixture deadline expired; retain owned evidence"); };
    const waitFor = async <T>(read: () => T | undefined | Promise<T | undefined>, label: string, budget = 15_000): Promise<T> => {
      const deadline = Math.min(expires, performance.now() + budget);
      while (performance.now() < deadline) { check(); const value = await read(); if (value !== undefined) return value; await sleep(25); }
      throw new Error(`MCP process fixture wait failed: ${label}`);
    };
    const key = `mcp-process-key-${randomBytes(16).toString("hex")}`, internal = `mcp-process-internal-${randomBytes(24).toString("hex")}`;
    const providerKey = "mcp-process-fake-provider-key", master = randomBytes(32).toString("hex");
    const peer = new FakeStatefulMcp(), vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: providerKey });
    peer.progress = [{ progress: 1, total: 2, message: "The one remote effect has started." }];
    let releaseReply!: () => void; const reply = new Promise<void>(resolve => { releaseReply = resolve; }); peer.beforeReply = () => reply;
    let admin: Connection | undefined, redis: Redis | undefined, subscriber: Redis | undefined, reader: MysqlSessionStore | undefined;
    let scratch: string | undefined, keyFile: string | undefined, serverUuid = "", createAttempted = false, created = false, namespaceOwned = false;
    let bodyPassed = false, readerUncertain = false, childrenSettled = false, scratchSafe = false, cleanupComplete = false;
    let watchedChannel: string | undefined, subscriberFailed = false, progressCount = 0;
    const procs: OwnedChild[] = [], streams: ReturnType<typeof observe>[] = [], failures: unknown[] = [];
    const json = async (origin: string, path: string, init: RequestInit = {}, privateRequest = false) => {
      check(); const headers = new Headers(privateRequest ? { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } : { authorization: `Bearer ${key}`, "x-user-id": OWNER.userId });
      headers.set("content-type", "application/json"); new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) });
      const text = await response.text(); let body: unknown;
      try { body = text ? JSON.parse(text) : undefined; } catch { throw new Error("MCP process API returned non-JSON"); }
      return { status: response.status, body, headers: response.headers };
    };
    const ready = async (proc: OwnedChild) => waitFor(async () => {
      if (proc.spawnFailed || proc.closeSeen || proc.logFailed || proc.logOverflow) throw new Error("MCP owned child failed before readiness; inspect its private log");
      try { const response = await fetch(`${proc.url}/readyz`, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(500)]) }); await response.body?.cancel(); return response.status === 200 ? true : undefined; }
      catch { return undefined; }
    }, "actual child readiness", 25_000);
    const boot = async (proc: OwnedChild) => {
      const result = await json(proc.url, INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {}, true); expect(result.status).toBe(200);
      expect(result.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE);
      return TenantRuntimeDrainReady.parse(result.body);
    };
    const fleet = async (router: OwnedChild, identity: McpRegistryIdentityCapability, expected: 200 | 503) => {
      const nonce = randomBytes(32).toString("hex");
      const result = await json(router.url, INTERNAL_MCP_REGISTRY_READY_PATH, { method: "POST", body: JSON.stringify({ nonce, identity }) }, true);
      expect(result.status).toBe(expected);
      if (expected === 200) { expect(result.headers.get(INTERNAL_MCP_REGISTRY_FLEET_ACK_HEADER)).toBe(INTERNAL_MCP_REGISTRY_FLEET_ACK_VALUE); expect(McpRegistryFleetResponse.parse(result.body)).toEqual({ nonce, identity }); }
    };
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
    try {
      scratch = await mkdtemp(join(tmpdir(), "agent-service-mcp-takeover-")); keyFile = join(scratch, "mcp-credential-key");
      const bytes = randomBytes(32); let handle: Awaited<ReturnType<typeof open>> | undefined;
      try { handle = await open(keyFile, "wx", 0o600); await handle.writeFile(bytes); await handle.sync(); } finally { bytes.fill(0); await handle?.close(); }
      admin = await mysql.createConnection({ uri: sqlUrl(base.sql, "mysql"), connectTimeout: 5_000 });
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
      serverUuid = String(identity[0]?.server_uuid); if (identity.length !== 1 || identity[0]?.db !== "mysql" || !/^[0-9a-f-]{36}$/i.test(serverUuid)) throw new Error("MCP process database identity unavailable");
      const [existing] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?", timeout: 5_000 }, [database]);
      if (existing.length) throw new Error("MCP process new owned database already exists");
      const redisOptions = { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 };
      redis = new Redis(base.redis.toString(), redisOptions); redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG");
      if ((await ownedKeys(redis, prefix)).length) throw new Error("MCP process new Redis namespace already exists"); namespaceOwned = true;
      subscriber = new Redis(base.redis.toString(), redisOptions); subscriber.on("error", () => { subscriberFailed = true; }); await subscriber.connect();
      subscriber.on("message", (channel, raw) => {
        if (channel !== watchedChannel || Buffer.byteLength(raw) > 131_072) { subscriberFailed = true; return; }
        try { if (Event.parse(JSON.parse(raw)).type === PROGRESS) progressCount++; } catch { subscriberFailed = true; }
      });
      check(); createAttempted = true; await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
      const endpoint = await peer.start(), vendorUrl = await vendor.start();
      const ports = new Set<number>(); while (ports.size < 3) ports.add(await freePort());
      const [onePort, twoPort, routerPort] = [...ports] as [number, number, number];
      const routerUrl = `http://127.0.0.1:${routerPort}`, callback = `${routerUrl}/v1/mcp/oauth/callback`;
      const common: Record<string, string> = { STORE: "mysql", MYSQL_URL: url, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespace,
        SECRETS_MASTER_KEY: master, INTERNAL_ROUTER_TOKEN: internal, PLATFORM_PROVIDER: "deepseek", API_KEY: providerKey, API_BASE_URL: vendorUrl, DEFAULT_MODEL: "deepseek-chat",
        MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_REGISTRY_CREDENTIAL_KEY_FILE: keyFile, MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-takeover-key-v1",
        MCP_REGISTRY_OAUTH_CALLBACK_URL: callback, MCP_TIMEOUT_MS: "30000", LEASE_TTL_MS: "2000", LEASE_HOLD_MS: "200", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "30000",
        ERASURE_ROUTER_URL: routerUrl, TENANT_RUNTIME_DRAIN_ENABLED: "1", BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1",
      };
      const launchRunner = async (slot: number, port: number, replacement = false) => {
        const proc = launch(`runner-${slot}${replacement ? "-replacement" : ""}`, "runner", port, { ...common,
          RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(port), RUNNER_ADDR: `127.0.0.1:${port}`, RUNNER_ID: `mcp-takeover-${suffix}-${slot}`,
          BLOB_DIR: join(scratch!, `blobs-${slot}`), ...(slot === 1 && !replacement ? { BOOTSTRAP_API_KEY: key, BOOTSTRAP_TENANT_ID: OWNER.tenantId } : {}) }, scratch!);
        procs.push(proc); await ready(proc); return proc;
      };
      const one = await launchRunner(1, onePort), two = await launchRunner(2, twoPort);
      const router = launch("router", "router", routerPort, { ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: `${one.url},${two.url}`,
        INTERNAL_ROUTER_TOKEN: internal, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespace, HEALTH_INTERVAL_MS: "300", SHUTDOWN_GRACE_MS: "0",
        MCP_REGISTRY_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_REGISTRY_CREDENTIAL_KEY_ID: "mcp-takeover-key-v1", MCP_REGISTRY_OAUTH_CALLBACK_URL: callback }, scratch);
      procs.push(router); await ready(router);
      const capability = await json(router.url, "/v1/capabilities"); expect(capability.status).toBe(200);
      const capabilities = Capabilities.parse(capability.body); expect(capabilities.features.mcpRegistry).toEqual([MANAGED_MCP_REGISTRY_V1]);
      const fleetIdentity = capabilities.features.mcpRegistryIdentity; if (!fleetIdentity) throw new Error("MCP process fleet identity absent"); await fleet(router, fleetIdentity, 200);
      const registration = await json(router.url, "/v1/mcp-servers", { method: "POST", headers: { "idempotency-key": "mcp-takeover-registration" },
        body: JSON.stringify({ scope: "user", name: "alpha", expectedRevision: 0, config: { endpoint, description: "Owned process-death MCP fixture", protocolVersion: "2025-11-25", authentication: { kind: "none" } } }) });
      expect(registration.status).toBe(201); expect(McpRegistrationResponse.parse(registration.body).version?.config.protocolVersion).toBe("2025-11-25");
      const directory = await json(router.url, "/v1/mcp-servers/alpha/tools?scope=user"); expect(directory.status).toBe(200);
      const tools = ToolListResponse.parse(directory.body); expect(tools.data).toHaveLength(1); const toolName = tools.data[0]!.name;
      vendor.script({ toolCalls: [{ id: TOOL_CALL_ID, name: toolName, args: JSON.stringify({ text: "one process-owned effect" }) }] }, { text: RECOVERY_TEXT });
      const definition = await json(router.url, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "MCP process takeover", instructions: "Do not repeat unknown side effects.",
        model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], mcpRegistrations: [{ scope: "user", name: "alpha" }], approvalPolicy: "never",
        limits: { maxSteps: 4, maxToolCalls: 2, maxWallClockMs: 60000 } }) });
      expect(definition.status).toBe(201); const agent = AgentDefinition.parse(definition.body);
      const createdSession = await json(router.url, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
      expect(createdSession.status).toBe(201); const session = Session.parse(createdSession.body);
      const keys = redisSessionKeys(session.id, prefix); watchedChannel = keys.eventChannel; await subscriber.subscribe(keys.eventChannel);
      readerUncertain = true; reader = await MysqlSessionStore.connect({ url, connectionLimit: 2, migrationMode: "verify" }); readerUncertain = false;
      const sdk = { baseUrl: router.url, serviceApiKey: key, userId: OWNER.userId };
      const streamAbort = new AbortController(); lifetime.signal.addEventListener("abort", () => streamAbort.abort(), { once: true });
      const started = await startTurnStream({ ...sdk, signal: streamAbort.signal }, session.id, { input: [{ type: "text", text: "Perform the one approved remote effect." }] }, { idempotencyKey: "mcp-takeover-first-turn" });
      if (started.kind !== "events") throw new Error("MCP process expected a new streaming turn"); const live = observe(started, streamAbort); streams.push(live);
      const approval = await waitFor(() => { live.healthy(); const value = live.frames.find(frame => frame.data.type === "approval/requested")?.data; return value?.type === "approval/requested" ? value.approval : undefined; }, "mandatory approval");
      expect(peer.calls).toHaveLength(0); expect(progressCount).toBe(0);
      const accepted = await json(router.url, `/v1/sessions/${session.id}/approvals/${approval.id}`, { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) });
      expect(accepted.status).toBe(200); expect(Approval.parse(accepted.body)).toMatchObject({ status: "resolved", decision: "acceptForSession" });
      const progress = await waitFor(() => { live.healthy(); return live.frames.find(frame => frame.data.type === PROGRESS)?.data; }, "public progress before kill");
      expect(progress).toMatchObject({ sessionId: session.id, turnId: approval.turnId, toolCallId: TOOL_CALL_ID, progress: 1, total: 2 }); expect(progress.seq).toBeUndefined();
      await waitFor(() => progressCount === 1 ? true : undefined, "actual Redis live progress"); expect(subscriberFailed).toBe(false);
      const originalItems = await reader.listItems(session.id, { limit: 100 }); const call = originalItems.find(item => item.type === "toolCall");
      expect(call).toMatchObject({ toolCallId: TOOL_CALL_ID, kind: "mcp", status: "inProgress", startedAtMs: expect.any(Number) });
      expect(originalItems.some(item => item.type === "toolResult")).toBe(false); expect((await reader.getSession(OWNER.tenantId, session.id))?.autoApprovedTools).toEqual([]);
      expect(peer.calls).toHaveLength(1); expect(vendor.requests).toHaveLength(1);
      const address = await redis.hget(keys.lease, "addr"); const owner = [one, two].find(proc => proc.url === `http://${address}`); if (!owner) throw new Error("MCP process actual lease owner unavailable");
      const survivor = owner === one ? two : one, slot = owner === one ? 1 : 2, oldBoot = await boot(owner);
      const fenceBefore = Number(await redis.get(keys.fence)); expect(Number.isSafeInteger(fenceBefore) && fenceBefore > 0).toBe(true);
      await live.close(); // Client disconnect alone cannot abort/repeat the real held tool.
      expect(peer.calls).toHaveLength(1); owner.crashed = true; signalOwned(owner, "SIGKILL");
      expect(await settledWithin(owner, 5_000)).toBe(true); await owner.closed; expect(owner.exit).toEqual({ code: null, signal: "SIGKILL" });
      releaseReply();
      await fleet(router, fleetIdentity, 503); expect(peer.calls).toHaveLength(1);
      const replacement = await launchRunner(slot, owner.port, true), replacementBoot = await boot(replacement);
      expect(replacementBoot.runnerId).toBe(oldBoot.runnerId); expect(replacementBoot.bootId === oldBoot.bootId).toBe(false);
      await fleet(router, fleetIdentity, 200); // Both exact configured URLs must acknowledge the new boot.
      await waitFor(async () => await redis!.exists(keys.lease) === 0 ? true : undefined, "natural old lease expiry");
      const recovered = await json(survivor.url, `/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "idempotency-key": "mcp-takeover-recovery" },
        body: JSON.stringify({ input: [{ type: "text", text: "Explain the previous unknown outcome without executing again." }], stream: false }) });
      expect(recovered.status).toBe(202); const nextTurnId = (recovered.body as { turn: { id: string } }).turn.id;
      const finished = await waitFor(async () => { const value = await reader!.getTurn(session.id, nextTurnId); return value?.status !== "inProgress" ? value ?? undefined : undefined; }, "survivor turn complete");
      expect(Turn.parse(finished)).toMatchObject({ status: "completed", stopReason: "end_turn", steps: 1, toolCalls: 0 });
      const fenceAfter = Number(await redis.get(keys.fence)); expect(fenceAfter).toBeGreaterThan(fenceBefore);
      const [fences] = await admin.query<RowDataPacket[]>({ sql: `SELECT fence_token FROM \`${database}\`.sessions WHERE session_id=?`, timeout: 5_000 }, [session.id]); expect(Number(fences[0]?.fence_token)).toBe(fenceAfter);
      expect(await reader.getTurn(session.id, approval.turnId)).toMatchObject({ status: "interrupted", stopReason: "interrupted", error: { code: "owner_lost" } });
      expect(vendor.requests).toHaveLength(2);
      const messages = vendor.requests[1]!.body.messages as Record<string, unknown>[];
      expect(messages.some(message => message.role === "tool" && message.tool_call_id === TOOL_CALL_ID && typeof message.content === "string" && message.content.startsWith("TOOL_OUTCOME_UNKNOWN:"))).toBe(true);
      expect(messages.some(message => message.role === "tool" && message.tool_call_id === TOOL_CALL_ID && typeof message.content === "string" && message.content.startsWith("TOOL_NOT_STARTED:"))).toBe(false);
      const snapshot = await reader.getSession(OWNER.tenantId, session.id); expect(snapshot).toMatchObject({ status: { type: "idle" }, autoApprovedTools: [] });
      const items = await reader.listItems(session.id, { limit: 100 }); expect(items.filter(item => item.type === "toolCall")).toHaveLength(1);
      expect(items.filter(item => item.type === "toolCall")[0]).toMatchObject({ id: call!.id, startedAtMs: call!.startedAtMs });
      expect(items.some(item => item.type === "toolResult" && item.toolCallId === TOOL_CALL_ID)).toBe(false);
      // Unknown is an honest projection into the new model history, not an invented durable result.
      expect(peer.calls).toHaveLength(1); expect(peer.requests.filter(request => request.rpcMethod === "tools/call")).toHaveLength(1);
      await peer.notifyLastCall({ progress: 2, total: 2, message: "Late old-owner progress must not appear." }).catch(() => {});
      const events = await reader.readEvents(session.id, 0, 100); const finalSeq = snapshot!.lastSeq;
      expect(events.map(event => event.seq)).toEqual(Array.from({ length: finalSeq }, (_, index) => index + 1));
      expect(events.some(event => (event as { type: string }).type === PROGRESS)).toBe(false);
      const hot = (await redis.xrange(keys.stream, "-", "+")).map(([, fields]) => { const at = fields.indexOf("e"); if (at < 0) throw new Error("MCP process Stream shape invalid"); return Event.parse(JSON.parse(fields[at + 1]!)); });
      expectSameDurableEvents(hot, events); expect(progressCount).toBe(1); expect(subscriberFailed).toBe(false);
      const otherFieldDrift = structuredClone(hot); otherFieldDrift[0]!.emittedAtMs++;
      expect(() => expectSameDurableEvents(otherFieldDrift, events)).toThrow();
      const usageIndex = events.findIndex(event => event.type === "usage/updated" && Object.hasOwn(event.turnUsage, "costCNY"));
      const usage = events[usageIndex];
      if (usage?.type !== "usage/updated" || typeof usage.turnUsage.costCNY !== "number" || !Number.isFinite(usage.turnUsage.costCNY) || usage.turnUsage.costCNY < 0) throw new Error("MCP process fixture requires a real known usage cost");
      const twoUlp = structuredClone(hot), missingCost = structuredClone(hot), changed = twoUlp[usageIndex], missing = missingCost[usageIndex];
      if (changed?.type !== "usage/updated" || missing?.type !== "usage/updated") throw new Error("MCP process usage event shape changed");
      const bits = new DataView(new ArrayBuffer(8)); bits.setFloat64(0, usage.turnUsage.costCNY, false); bits.setBigUint64(0, bits.getBigUint64(0, false) + 2n, false);
      changed.turnUsage.costCNY = bits.getFloat64(0, false); delete missing.turnUsage.costCNY;
      expect(() => expectSameDurableEvents(twoUlp, events)).toThrow(); expect(() => expectSameDurableEvents(missingCost, events)).toThrow();
      const replayAbort = new AbortController(); lifetime.signal.addEventListener("abort", () => replayAbort.abort(), { once: true });
      const replay = observe(await subscribeSessionEvents({ ...sdk, signal: replayAbort.signal }, session.id, { after: 0 }), replayAbort); streams.push(replay);
      await waitFor(() => { replay.healthy(); return replay.frames.filter(frame => typeof frame.data.seq === "number").at(-1)?.data.seq === finalSeq ? true : undefined; }, "public durable recovery replay");
      await replay.close(); expect(replay.frames.some(frame => frame.data.type === PROGRESS)).toBe(false);
      expect(replay.frames.map(frame => frame.data.seq)).toEqual(events.map(event => event.seq));
      expect(progressCount).toBe(1); expect(peer.calls).toHaveLength(1); check(); bodyPassed = true;
    } catch (error) { failures.push(error); }
    finally {
      releaseReply(); clearTimeout(timer); lifetime.abort();
      for (const stream of streams) { try { await stream.close(); } catch (error) { failures.push(error); } }
      // All exact owned groups get TERM concurrently; their individual TERM/KILL budgets do not
      // add up across four children. Each branch records its own failure and still joins close.
      await Promise.all(procs.map(async proc => {
        try {
          if (proc.pid > 1) await stopOwned(proc); else await proc.closed;
          if (proc.spawnFailed || proc.logFailed || proc.logOverflow || proc.hardCleanup || !proc.closeSeen || (proc.pid > 1 && groupAlive(proc))) throw new Error("MCP owned child did not close cleanly");
          expect(proc.exit).toEqual(proc.crashed ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null });
        } catch (error) { failures.push(error); }
      }));
      try { childrenSettled = procs.every(proc => proc.closeSeen && proc.pid > 1 && !groupAlive(proc)); }
      catch (error) { failures.push(error); }
      if (reader) { readerUncertain = true; try { await reader.close(); reader = undefined; readerUncertain = false; } catch (error) { failures.push(error); } }
      if (subscriber) { try {
        // PING is permitted in subscribed mode and orders all earlier Pub/Sub delivery on this
        // exact connection, after every writer process has actually exited.
        await subscriber.ping();
        if (bodyPassed) { expect(progressCount).toBe(1); expect(subscriberFailed).toBe(false); }
        if (watchedChannel) await subscriber.unsubscribe(watchedChannel); await subscriber.quit();
      } catch (error) { subscriber.disconnect(); failures.push(error); } }
      try { await peer.stop(); expect(peer.stats().openSockets).toBe(0); expect(peer.stats().activeExchanges).toBe(0); if (bodyPassed) expect(peer.calls).toHaveLength(1); } catch (error) { failures.push(error); }
      try { await vendor.stop(); } catch (error) { failures.push(error); }
      vi.unstubAllEnvs();
      if (scratch) {
        try { const metadata = await lstat(scratch); scratchSafe = metadata.isDirectory() && !metadata.isSymbolicLink() && /^agent-service-mcp-takeover-[A-Za-z0-9]+$/.test(basename(scratch)) && await realpath(dirname(scratch)) === await realpath(tmpdir()); }
        catch (error) { failures.push(error); }
      }
      if (admin && created && bodyPassed && failures.length === 0 && childrenSettled && !readerUncertain && !reader && scratchSafe) {
        try {
          if (context.signal.aborted || performance.now() >= cleanupExpires) throw new Error("MCP process cleanup deadline expired; retain owned scope");
          const [same] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
          if (same.length !== 1 || String(same[0]?.server_uuid) !== serverUuid || same[0]?.db !== "mysql") throw new Error("MCP process MySQL identity changed");
          const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE DB=?", timeout: 5_000 }, [database]);
          const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.TRX_ID FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.TRX_MYSQL_THREAD_ID WHERE p.DB=?", timeout: 5_000 }, [database]);
          const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA=?", timeout: 5_000 }, [database]);
          if (connections.length || transactions.length || locks.length || !/^agent_service_mcp_takeover_test_[0-9a-f]{24}$/.test(database) || !redis || !namespaceOwned) throw new Error("MCP process exact owned resources remain referenced");
          const keys = await ownedKeys(redis, prefix); for (let at = 0; at < keys.length; at += 100) await redis.unlink(...keys.slice(at, at + 100));
          if ((await ownedKeys(redis, prefix)).length) throw new Error("MCP process owned Redis namespace remained"); await redis.quit(); redis = undefined;
          if (context.signal.aborted || performance.now() >= cleanupExpires) throw new Error("MCP process deadline before exact DROP; retain owned schema");
          await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); created = false;
          if (!keyFile || dirname(keyFile) !== scratch) throw new Error("MCP process exact fixture key path unavailable");
          await unlink(keyFile); await rm(join(scratch!, "blobs-1"), { recursive: true, force: true }); await rm(join(scratch!, "blobs-2"), { recursive: true, force: true });
          cleanupComplete = true;
        } catch (error) { failures.push(error); }
      }
      if (redis) { try { await redis.quit(); } catch (error) { redis.disconnect(); failures.push(error); } }
      if (admin) { try { await admin.end(); } catch (error) { failures.push(error); } }
      if (created || createAttempted && !bodyPassed) failures.push(new Error(`MCP process failed/uncertain validation retained owned scope: ${database}; ${prefix}`));
      if (scratchSafe && scratch) {
        try {
          await writeFile(join(scratch, "child-exits.json"), JSON.stringify({ schema: "mcp-progress-process-takeover-v1", bodyPassed, cleanupComplete,
            databaseRetained: created || createAttempted && !bodyPassed, namespace: prefix,
            children: procs.map(proc => ({ label: proc.label, pid: proc.pid, exit: proc.exit ?? null, nativeClosed: proc.closeSeen,
              groupGone: proc.pid > 1 && !groupAlive(proc), spawnFailed: proc.spawnFailed, logFailed: proc.logFailed, logOverflow: proc.logOverflow, hardCleanup: proc.hardCleanup })) }, null, 2), { flag: "wx", mode: 0o600 });
          console.info(JSON.stringify({ schema: "mcp-progress-process-takeover-evidence-v1", directory: scratch, cleanupComplete }));
        } catch (error) { failures.push(error); }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "MCP process takeover or exact owned-resource cleanup failed");
  }, 120_000);
});
