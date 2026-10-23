import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import {
  AgentDefinition, Capabilities, Event, Item, Session, Turn, TenantRuntimeDrainReady,
  INTERNAL_ROUTER_TOKEN_HEADER, INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER,
  INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE, INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH,
  INTERNAL_RUNTIME_EXTENSIONS_READY_PATH, INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER,
  INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE, RuntimeExtensionsFleetResponse, RUNTIME_EXTENSIONS_V1,
  type RuntimeExtensionsIdentity, type ItemOf,
} from "../../packages/protocol/src/index.js";
import {
  MysqlSessionStore, redisSessionKeys, attachSubagentCommitAdmission, createSubagentRootAccess,
  createSubagentChildAccess, SessionAuthorityError,
} from "../../packages/store/src/index.js";
import { newId } from "../../packages/core/src/ids.js";
import { FakeMcp, FakeVendor } from "@agent-service/testkit";
import { buildClusterChildEnv, type ClusterChildRole } from "./harness.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../fixtures/mysql-runtime.mjs";
import { createMysqlAuthorityCliExecutor } from "../fixtures/mysql-authority-cli.mjs";

// Only the resource-free child-env helper is shared. Never use startCluster (DROP/FLUSHDB),
// inherited .env authority, a fake engine, an independent child lease, or a synthetic producer.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PARENT_CALL = "parent_task_call", CHILD_CALL = "child_mcp_effect";
const EFFECT = "one-real-child-effect", RECOVERY = "The old child outcome is unknown; it was not repeated.";
type Exit = { code: number | null; signal: NodeJS.Signals | null };
interface OwnedChild {
  label: string; port: number; url: string; child: ChildProcess; pid: number; closed: Promise<void>;
  exit?: Exit; closeSeen: boolean; spawnFailed: boolean; logFailed: boolean; logOverflow: boolean;
  crashed: boolean; hardCleanup: boolean;
}
function bases() {
  // Local runs receive root's separate private instances. CI URLs name that job's own services;
  // port numbers alone are not an ownership proof. There are deliberately no shared defaults.
  try {
    const sql = new URL(process.env.MYSQL_TEST_URL ?? process.env.CLUSTER_MYSQL_URL ?? ""),
      redis = new URL(process.env.REDIS_TEST_URL ?? process.env.CLUSTER_REDIS_URL ?? "");
    const local = (url: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.search && !url.hash;
    const name = decodeURIComponent(sql.pathname.slice(1));
    if (sql.protocol !== "mysql:" || !local(sql) || !sql.username || !/^[A-Za-z0-9_]+$/.test(name)
      || !/(?:^|_)(?:test|cluster)(?:$|_)/i.test(name) || redis.protocol !== "redis:" || !local(redis)
      || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) throw new Error();
    return { sql, redis };
  } catch { throw new Error("Subagent process test requires explicit loopback disposable MySQL and Redis URLs."); }
}
function sqlUrl(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Subagent owned listener port unavailable."); return address.port;
}
function ownedPid(proc: OwnedChild): number {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) throw new Error("Subagent process ownership is uncertain; signal refused.");
  return proc.pid;
}
function groupAlive(proc: OwnedChild): boolean {
  try { process.kill(-ownedPid(proc), 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function signalOwned(proc: OwnedChild, signal: NodeJS.Signals): void {
  const pid = ownedPid(proc); if (!groupAlive(proc)) return;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Subagent owned group signal was not confirmed."); }
}
async function settledWithin(proc: OwnedChild, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) { if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return true; } await sleep(10); }
  return proc.closeSeen && !groupAlive(proc);
}
async function stopOwned(proc: OwnedChild): Promise<void> {
  ownedPid(proc); if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return; }
  signalOwned(proc, "SIGTERM");
  if (!await settledWithin(proc, 5_000)) {
    proc.hardCleanup = true; signalOwned(proc, "SIGKILL");
    if (!await settledWithin(proc, 5_000)) throw new Error("Subagent owned process group did not close.");
  }
  await proc.closed;
}
function launch(label: string, role: ClusterChildRole, port: number, env: Record<string, string>, scratch: string): OwnedChild {
  const sink = createWriteStream(join(scratch, `${label}.log`), { flags: "wx", mode: 0o600 });
  // Native Node is the product process; no tsx CLI wrapper whose death could leave a server alive.
  const child = spawn(process.execPath, ["--import", "tsx", `apps/agent-${role}/src/main.ts`], {
    cwd: ROOT, env: buildClusterChildEnv(process.env, env, role), detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveClosed!: () => void; const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const proc: OwnedChild = { label, child, pid: child.pid ?? 0, port, url: `http://127.0.0.1:${port}`, closed,
    closeSeen: false, spawnFailed: false, logFailed: false, logOverflow: false, crashed: false, hardCleanup: false };
  let size = 0;
  const collect = (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) { proc.logOverflow = true; return; } if (!sink.destroyed) sink.write(chunk); };
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  sink.on("error", () => { proc.logFailed = true; }); child.once("error", () => { proc.spawnFailed = true; });
  child.once("exit", (code, signal) => { proc.exit = { code, signal }; });
  child.once("close", (code, signal) => {
    proc.exit ??= { code, signal }; proc.closeSeen = true;
    if (sink.closed) resolveClosed(); else { sink.once("close", resolveClosed); if (!sink.destroyed) sink.end(); }
  });
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1) { proc.spawnFailed = true; sink.end(); }
  return proc;
}
async function ownedKeys(redis: Redis, prefix: string): Promise<string[]> {
  const keys = new Set<string>(); let cursor = "0", rounds = 0;
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = next;
    for (const key of found) { if (!key.startsWith(`${prefix}:`)) throw new Error("Subagent Redis namespace ownership mismatch."); keys.add(key); }
    if (++rounds > 100 || keys.size > 2_000) throw new Error("Subagent Redis namespace exceeded bound.");
  } while (cursor !== "0"); return [...keys];
}
async function closeOwnedRedis(redis: Redis): Promise<void> {
  const ended = new Promise<void>(resolve => {
    if (redis.status === "end") resolve(); else redis.once("end", resolve);
  });
  const failures: unknown[] = [];
  if (redis.status !== "end") {
    try { await redis.quit(); }
    catch (error) {
      failures.push(error);
      try { redis.disconnect(); } catch (error) { failures.push(error); }
    }
  }
  await ended;
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Subagent owned Redis client did not close cleanly.");
}
function sqlObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Subagent native row shape invalid."); return parsed as Record<string, unknown>;
}

describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER)("cluster: real root-lease child process death and takeover", () => {
  it("seals the real held child unknown after root-owner SIGKILL without a child lease, late write or repeated effect", async context => {
    const base = bases(), nonce = randomBytes(12).toString("hex");
    const database = `agent_service_subagent_test_${nonce}`, prefix = `subagent_takeover_${nonce}`, namespace = `subagent_takeover_${nonce}`;
    // Exact schema grants escape underscores when partial_revokes=0; MySQL also
    // applies its identifier limit to that escaped pattern. Check before any I/O.
    expect(Buffer.byteLength(database.replace(/[%_]/g, "\\$&"))).toBeLessThanOrEqual(64);
    const owner = { tenantId: `t_subagent_takeover_${nonce}`, userId: "actual-owner" };
    const startedAt = performance.now(), expires = startedAt + 80_000, cleanupExpires = startedAt + 110_000;
    const lifetime = new AbortController(), timer = setTimeout(() => lifetime.abort(), 80_000);
    const fixtureAbort = new AbortController(), fixtureSignal = AbortSignal.any([fixtureAbort.signal, context.signal]);
    const fixtureTimer = setTimeout(() => fixtureAbort.abort(), Math.max(0, Math.ceil(cleanupExpires - performance.now())));
    const url = sqlUrl(base.sql, database), adminUrl = sqlUrl(base.sql, "mysql");
    const key = randomBytes(32).toString("hex"), internal = randomBytes(32).toString("hex"), master = randomBytes(32).toString("hex");
    const vendor = new FakeVendor({ cacheDialect: "deepseek", expectApiKey: "subagent-owned-fake-model-key" }), peer = new FakeMcp();
    peer.responsePrefix = "late-child-result:";
    let releaseReply!: () => void; const heldReply = new Promise<void>(resolve => { releaseReply = resolve; }); peer.beforeReply = () => heldReply;
    let admin: Connection | undefined, redis: Redis | undefined, reader: MysqlSessionStore | undefined, scratch: string | undefined;
    let mysqlRuntime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
    let runtimeReleased = false;
    let serverUuid = "", createAttempted = false, created = false, namespaceOwned = false, readerUncertain = false;
    let bodyPassed = false, childrenSettled = false, scratchSafe = false, cleanupComplete = false, stage = "preflight";
    const procs: OwnedChild[] = [], failures: unknown[] = [];
    const check = () => { if (context.signal.aborted || lifetime.signal.aborted || performance.now() >= expires) throw new Error("Subagent process body deadline expired; retain evidence."); };
    const wait = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string, budget = 15_000): Promise<T> => {
      const until = Math.min(expires, performance.now() + budget);
      while (performance.now() < until) { check(); const value = await read(); if (value !== undefined) return value; await sleep(25); }
      throw new Error(`Subagent process wait failed: ${label}`);
    };
    const json = async (origin: string, path: string, init: RequestInit = {}, privateRequest = false) => {
      check(); const headers = new Headers(privateRequest ? { [INTERNAL_ROUTER_TOKEN_HEADER]: internal } : { authorization: `Bearer ${key}`, "x-user-id": owner.userId });
      headers.set("content-type", "application/json"); new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      const response = await fetch(origin + path, { ...init, headers, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]) });
      const text = await response.text(); if (Buffer.byteLength(text) > 2_097_152) throw new Error("Subagent API response exceeded bound.");
      let body: unknown; try { body = text ? JSON.parse(text) : null; } catch { throw new Error("Subagent API response was not JSON."); }
      return { status: response.status, body, headers: response.headers };
    };
    const ready = (proc: OwnedChild) => wait(async () => {
      if (proc.spawnFailed || proc.closeSeen || proc.logFailed || proc.logOverflow) throw new Error("Subagent product child failed; inspect private log.");
      try { const response = await fetch(`${proc.url}/readyz`, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(500)]) }); await response.body?.cancel(); return response.status === 200 ? true : undefined; }
      catch { return undefined; }
    }, "product readiness", 25_000);
    const boot = async (proc: OwnedChild) => {
      const response = await json(proc.url, INTERNAL_TENANT_RUNTIME_DRAIN_READY_PATH, {}, true);
      expect(response.status).toBe(200); expect(response.headers.get(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_HEADER)).toBe(INTERNAL_TENANT_RUNTIME_DRAIN_ACK_VALUE);
      return TenantRuntimeDrainReady.parse(response.body);
    };
    const fleet = async (router: OwnedChild, identity: RuntimeExtensionsIdentity, expected: 200 | 503) => {
      const nonce = randomBytes(32).toString("hex"), response = await json(router.url, INTERNAL_RUNTIME_EXTENSIONS_READY_PATH,
        { method: "POST", body: JSON.stringify({ nonce, identity }) }, true);
      expect(response.status).toBe(expected);
      if (expected === 200) {
        expect(response.headers.get(INTERNAL_RUNTIME_EXTENSIONS_ACK_HEADER)).toBe(INTERNAL_RUNTIME_EXTENSIONS_ACK_VALUE);
        expect(RuntimeExtensionsFleetResponse.parse(response.body)).toEqual({ nonce, identity });
      }
    };
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("MCP_ALLOW_LOOPBACK_FOR_TESTS", "1");
    try {
      scratch = await mkdtemp(join(tmpdir(), "agent-service-subagent-takeover-"));
      admin = await mysql.createConnection({ uri: adminUrl, connectTimeout: 5_000 });
      const [identity] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
      serverUuid = String(identity[0]?.server_uuid); expect(identity).toHaveLength(1); expect(identity[0]?.db).toBe("mysql"); expect(serverUuid).toMatch(/^[a-f0-9-]{36}$/i);
      const [prior] = await admin.query<RowDataPacket[]>({ sql: "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=? AND BINARY SCHEMA_NAME=BINARY ?", timeout: 5_000 }, [database, database]);
      expect(prior).toHaveLength(0);
      redis = new Redis(base.redis.toString(), { lazyConnect: true, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 1 });
      redis.on("error", () => {}); await redis.connect(); expect(await redis.ping()).toBe("PONG"); expect(await ownedKeys(redis, prefix)).toEqual([]); namespaceOwned = true;
      check();
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: url,
        applicationDatabase: database, operationAbortSignal: fixtureSignal });
      check(); createAttempted = true; await admin.query({ sql: `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
      const authorityExecutor = createMysqlAuthorityCliExecutor({
        entrypoint: join(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT,
      });
      const preparedRuntime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: options => MysqlSessionStore.runSchemaOperation({
        ...options, operationAbortSignal: AbortSignal.any([options.operationAbortSignal, lifetime.signal]),
      }), authorityExecutor: options => authorityExecutor({
        ...options, operationAbortSignal: AbortSignal.any([options.operationAbortSignal, lifetime.signal]),
      }) });
      mysqlRuntime = preparedRuntime; check();
      const endpoint = await peer.start(), vendorUrl = await vendor.start();
      let toolName = "";
      vendor.script(
        { toolCalls: [{ id: PARENT_CALL, name: "task", args: JSON.stringify({ target: "worker", prompt: "Perform the one child effect, no inherited history." }) }], usage: { promptTokens: 10, completionTokens: 2 } },
        { get toolCalls() {
          const tools = vendor.requests[1]?.body.tools;
          if (!Array.isArray(tools) || tools.length !== 1) throw new Error("Actual child MCP catalog missing.");
          const item = sqlObject(sqlObject(tools[0]).function); if (typeof item.name !== "string" || !/^mcp__/.test(item.name)) throw new Error("Actual child tool identity missing.");
          toolName = item.name; return [{ id: CHILD_CALL, name: toolName, args: JSON.stringify({ text: EFFECT }) }];
        }, usage: { promptTokens: 10, completionTokens: 2 } },
        { text: RECOVERY, usage: { promptTokens: 10, completionTokens: 2 } },
      );
      const ports = new Set<number>(); while (ports.size < 3) ports.add(await freePort());
      const [onePort, twoPort, routerPort] = [...ports] as [number, number, number], routerUrl = `http://127.0.0.1:${routerPort}`;
      const packages = JSON.stringify([{ id: "audit", package: "audit", subjects: [owner], phases: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "Stop", "Interrupt"] }]);
      const common: Record<string, string> = { STORE: "mysql", ...preparedRuntime.runtimeEnv, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespace,
        SECRETS_MASTER_KEY: master, INTERNAL_ROUTER_TOKEN: internal, PLATFORM_PROVIDER: "deepseek", API_KEY: "subagent-owned-fake-model-key", API_BASE_URL: vendorUrl, DEFAULT_MODEL: "deepseek-chat",
        MCP_ENABLED: "1", MCP_ALLOW_LOOPBACK_FOR_TESTS: "1", MCP_SERVERS_JSON: JSON.stringify([{ id: "owned", endpoint, subjects: [owner] }]), MCP_TIMEOUT_MS: "30000",
        SUBAGENTS_ENABLED: "1", SUBAGENTS_MAX_DEPTH: "2", SUBAGENTS_MAX_CONCURRENT: "1", SUBAGENTS_MAX_TASKS: "2",
        LIFECYCLE_HOOKS_ENABLED: "1", LIFECYCLE_HOOKS_CONFIG_JSON: packages, LIFECYCLE_HOOKS_TIMEOUT_MS: "5000",
        LEASE_TTL_MS: "2000", LEASE_HOLD_MS: "200", APPROVAL_TTL_MS: "15000", SSE_HEARTBEAT_MS: "30000",
        ERASURE_ROUTER_URL: routerUrl, TENANT_RUNTIME_DRAIN_ENABLED: "1", BLOB_STORE: "filesystem", BLOB_FILESYSTEM_SINGLE_RUNNER: "1" };
      const runner = async (slot: number, port: number, replacement = false) => {
        check(); await preparedRuntime.assertReusable(url); check();
        const proc = launch(`runner-${slot}${replacement ? "-replacement" : ""}`, "runner", port, { ...common,
          RUNNER_ID: `subagent-takeover-${nonce}-${slot}`, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(port), RUNNER_ADDR: `127.0.0.1:${port}`,
          BLOB_DIR: join(scratch!, `blobs-${slot}`), ...(slot === 1 && !replacement ? { BOOTSTRAP_API_KEY: key, BOOTSTRAP_TENANT_ID: owner.tenantId } : {}) }, scratch!);
        procs.push(proc); await ready(proc); return proc;
      };
      stage = "start_products"; const one = await runner(1, onePort), two = await runner(2, twoPort);
      const router = launch("router", "router", routerPort, { ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: `${one.url},${two.url}`,
        INTERNAL_ROUTER_TOKEN: internal, REDIS_URL: base.redis.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: namespace,
        HEALTH_INTERVAL_MS: "300", SHUTDOWN_GRACE_MS: "0", SUBAGENTS_ENABLED: "1", LIFECYCLE_HOOKS_ENABLED: "1" }, scratch);
      procs.push(router); await ready(router);
      const cap = Capabilities.parse((await json(router.url, "/v1/capabilities")).body);
      expect(cap.features.runtimeExtensions).toEqual([RUNTIME_EXTENSIONS_V1]);
      const runtimeIdentity = cap.features.runtimeExtensionsIdentity; if (!runtimeIdentity) throw new Error("Actual extension fleet identity missing.");
      expect(runtimeIdentity.lifecycleHooksSha256).toMatch(/^[a-f0-9]{64}$/); expect(runtimeIdentity.subagentsSha256).toMatch(/^[a-f0-9]{64}$/);
      await fleet(router, runtimeIdentity, 200);
      const limits = { maxSteps: 8, maxToolCalls: 8, maxWallClockMs: 60_000, maxCostCNY: 1, maxOutputTokensPerStep: 128 };
      const childDef = await json(router.url, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "Pinned process child", instructions: "CHILD_SYSTEM",
        model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], mcpServers: ["owned"], approvalPolicy: "never", limits }) });
      expect(childDef.status).toBe(201); const target = AgentDefinition.parse(childDef.body);
      const parentDef = await json(router.url, "/v1/agents", { method: "POST", body: JSON.stringify({ name: "Root process parent", instructions: "Never repeat unknown task effects.",
        model: target.model, tools: ["task"], mcpServers: ["owned"], approvalPolicy: "never", limits,
        subagents: { targets: [{ name: "worker", agentId: target.id, agentVersion: target.version }], allowSelf: false, context: "prompt", maxDepth: 2, maxConcurrent: 1, maxTasks: 2, limits } }) });
      expect(parentDef.status).toBe(201); const agent = AgentDefinition.parse(parentDef.body);
      const createdSession = await json(router.url, "/v1/sessions", { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
      expect(createdSession.status).toBe(201); const session = Session.parse(createdSession.body), rootKeys = redisSessionKeys(session.id, prefix);
      readerUncertain = true; reader = await MysqlSessionStore.connect({ ...preparedRuntime.runtimeStoreOptions, connectionLimit: 2,
        operationAbortSignal: AbortSignal.any([lifetime.signal, context.signal]) }); readerUncertain = false;
      stage = "real_task";
      const accepted = await json(router.url, `/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "idempotency-key": "subagent-original-turn" },
        body: JSON.stringify({ stream: false, input: [{ type: "text", text: "Delegate the single effect to the permitted pinned child." }] }) });
      expect(accepted.status).toBe(202); const rootTurnId = Turn.parse(sqlObject(accepted.body).turn).id;
      const task = await wait(async () => (await reader!.listSubagentTasks({ principal: owner, rootSessionId: session.id, rootTurnId }))[0], "real child reservation");
      expect(task).toMatchObject({ parentSessionId: session.id, parentTurnId: rootTurnId, depth: 1, authority: { agentId: target.id, agentVersion: target.version } });
      const childKeys = redisSessionKeys(task.childSessionId, prefix);
      const childApproval = await wait(async () => (await reader!.listApprovals(task.childSessionId, { pendingOnly: true }))[0], "actual child mandatory approval");
      expect(childApproval).toMatchObject({ toolCallId: CHILD_CALL, toolName, args: { text: EFFECT } }); expect(peer.calls).toEqual([]);
      const control = `/v1/sessions/${session.id}/subagents/${task.taskId}`;
      const granted = await json(router.url, `${control}/approvals/${childApproval.id}`, { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) });
      expect(granted.status).toBe(200);
      await wait(() => peer.calls.length === 1 ? true : undefined, "one actual held HTTP effect");
      const parentItems = await reader.listItems(session.id, { limit: 100 }), childItems = await reader.listItems(task.childSessionId, { limit: 100 });
      const parentCall = parentItems.find((item): item is ItemOf<"toolCall"> => item.type === "toolCall" && item.toolCallId === PARENT_CALL);
      const childCall = childItems.find((item): item is ItemOf<"toolCall"> => item.type === "toolCall" && item.toolCallId === CHILD_CALL);
      expect(parentCall).toMatchObject({ name: "task", status: "inProgress", startedAtMs: expect.any(Number) });
      expect(childCall).toMatchObject({ name: toolName, kind: "mcp", args: { text: EFFECT }, status: "inProgress", startedAtMs: expect.any(Number) });
      expect(childItems.some(item => item.type === "toolResult")).toBe(false); expect(parentItems.some(item => item.type === "toolResult")).toBe(false);
      expect(parentItems.find(item => item.type === "subagentActivity")).toMatchObject({ taskId: task.taskId, parentCallItemId: parentCall!.id, taskStatus: "reserved" });
      expect(await redis.exists(childKeys.lease, childKeys.fence)).toBe(0);
      expect((await ownedKeys(redis, prefix)).filter(key => key.startsWith(`${prefix}:lease:`))).toEqual([]);
      const actualOwner = await reader.sessionAuthority.getOwner(session.id);
      expect(actualOwner).toMatchObject({ authority: "mysql-live-session-v1", fence: task.rootFence });
      expect(await reader.sessionAuthority.getOwner(task.childSessionId)).toBeNull();
      const [childTuples] = await admin.query<RowDataPacket[]>({ sql: `SELECT COUNT(*) AS total FROM \`${database}\`.sessions WHERE session_id=? AND
        (authority_binding_id IS NOT NULL OR authority_runner_id IS NOT NULL OR authority_runner_addr IS NOT NULL
          OR authority_boot_id IS NOT NULL OR authority_acquisition_sha256 IS NOT NULL OR authority_source_sha256 IS NOT NULL OR authority_expires_at_db_ms IS NOT NULL)`, timeout: 5_000 }, [task.childSessionId]);
      expect(Number(childTuples[0]?.total)).toBe(0);
      const address = actualOwner?.ownerAddr, original = [one, two].find(proc => proc.url === `http://${address}`);
      if (!original) throw new Error("Actual root lease owner missing.");
      const survivor = original === one ? two : one, slot = original === one ? 1 : 2, oldBoot = await boot(original);
      const fenceBefore = (await reader.getSession(owner.tenantId, session.id))!.fenceToken; expect(fenceBefore).toBe(task.rootFence); expect(fenceBefore).toBeGreaterThan(0);
      expect(vendor.requests).toHaveLength(2); expect(peer.calls).toEqual([{ name: "echo", arguments: { text: EFFECT } }]);
      // Kill the exact native PGID holding BOTH parent and child. No independent child process or
      // lease exists to keep executing after that root has disappeared.
      stage = "kill_root"; original.crashed = true; signalOwned(original, "SIGKILL");
      expect(await settledWithin(original, 5_000)).toBe(true); await original.closed;
      expect(original.exit).toEqual({ code: null, signal: "SIGKILL" });
      releaseReply(); await fleet(router, runtimeIdentity, 503); expect(peer.calls).toHaveLength(1);
      const replacement = await runner(slot, original.port, true), replacementBoot = await boot(replacement);
      expect(replacementBoot.runnerId).toBe(oldBoot.runnerId); expect(replacementBoot.bootId).not.toBe(oldBoot.bootId);
      await fleet(router, runtimeIdentity, 200); // Every exact configured URL has really restarted/ACKed.
      await wait(async () => await reader!.sessionAuthority.getOwner(session.id) === null ? true : undefined, "natural old root lease expiry");
      stage = "survivor_takeover";
      const recovery = await json(survivor.url, `/v1/sessions/${session.id}/turns`, { method: "POST", headers: { "idempotency-key": "subagent-recovery-turn" },
        body: JSON.stringify({ stream: false, input: [{ type: "text", text: "Report the previous unknown task; do not execute it again." }] }) });
      expect(recovery.status).toBe(202); const nextTurnId = Turn.parse(sqlObject(recovery.body).turn).id;
      await wait(async () => (await reader!.getTurn(session.id, nextTurnId))?.status === "completed" ? true : undefined, "survivor canonical completion");
      const fenceAfter = (await reader.getSession(owner.tenantId, session.id))!.fenceToken; expect(fenceAfter).toBeGreaterThan(fenceBefore);
      expect(await reader.getSession(owner.tenantId, session.id)).toMatchObject({ status: { type: "idle" }, fenceToken: fenceAfter, autoApprovedTools: [] });
      expect(await reader.getTurn(session.id, rootTurnId)).toMatchObject({ status: "interrupted", stopReason: "interrupted", error: { code: "owner_lost" } });
      expect(await reader.getTurn(task.childSessionId, task.childTurnId)).toMatchObject({ status: "interrupted", stopReason: "interrupted" });
      expect(await reader.getSession(owner.tenantId, task.childSessionId)).toMatchObject({ status: { type: "idle" }, fenceToken: fenceAfter });
      const unknown = await reader.getSubagentTask({ principal: owner, rootSessionId: session.id, taskId: task.taskId });
      expect(unknown).toMatchObject({ status: "outcome_unknown", rootFence: fenceBefore, childUsage: { totalTokens: 12 } });
      const [families] = await admin.query<RowDataPacket[]>({ sql: `SELECT record_json FROM \`${database}\`.subagent_root_turns WHERE root_session_id=? AND root_turn_id=?`, timeout: 5_000 }, [session.id, rootTurnId]);
      expect(families).toHaveLength(1); expect(sqlObject(families[0]!.record_json)).toMatchObject({ state: "outcome_unknown", stopReason: "interrupted", steps: 2, toolCalls: 2, taskCount: 1, activeTasks: 0, familyUsage: { totalTokens: 24 } });
      const [entries] = await admin.query<RowDataPacket[]>({ sql: `SELECT record_json FROM \`${database}\`.subagent_budget_entries WHERE root_key=(SELECT root_key FROM \`${database}\`.subagent_root_turns WHERE root_session_id=? AND root_turn_id=?) ORDER BY ordinal`, timeout: 5_000 }, [session.id, rootTurnId]);
      const budgets = entries.map(row => sqlObject(row.record_json));
      expect(budgets.map(entry => [entry.kind, entry.state])).toEqual([["provider_step", "settled"], ["tool_call", "outcome_unknown"], ["provider_step", "settled"], ["tool_call", "outcome_unknown"]]);
      expect(budgets.filter(entry => entry.state === "outcome_unknown").every(entry => entry.usageId === null && entry.usage === null)).toBe(true);
      const childAfter = await reader.listItems(task.childSessionId, { limit: 100 }), parentAfter = await reader.listItems(session.id, { limit: 100 });
      expect(childAfter.find(item => item.id === childCall!.id)).toMatchObject({ status: "failed", startedAtMs: childCall!.startedAtMs });
      expect(parentAfter.find(item => item.type === "subagentActivity")).toMatchObject({ id: task.activityItemId, status: "failed", taskStatus: "outcome_unknown" });
      expect(childAfter.some(item => item.type === "toolResult")).toBe(false); expect(parentAfter.some(item => item.type === "toolResult" && item.toolCallId === PARENT_CALL)).toBe(false);
      expect(childAfter.every(item => Item.safeParse(item).success && item.sessionId === task.childSessionId)).toBe(true);
      expect(parentAfter.every(item => Item.safeParse(item).success && item.sessionId === session.id)).toBe(true);
      expect(parentAfter.some(item => childAfter.some(child => child.id === item.id))).toBe(false);
      expect(vendor.requests).toHaveLength(3); expect(peer.calls).toHaveLength(1); expect(peer.methods.filter(method => method === "tools/call")).toHaveLength(1);
      const history = vendor.requests[2]!.body.messages as Record<string, unknown>[];
      expect(history.some(message => message.role === "tool" && message.tool_call_id === PARENT_CALL && typeof message.content === "string" && message.content.startsWith("TOOL_OUTCOME_UNKNOWN:"))).toBe(true);
      expect(history.some(message => message.role === "tool" && message.tool_call_id === PARENT_CALL && typeof message.content === "string" && message.content.startsWith("TOOL_NOT_STARTED:"))).toBe(false);
      expect(JSON.stringify(history)).not.toContain(`late-child-result:${EFFECT}`);
      stage = "late_write";
      const beforeLate = await reader.getSession(owner.tenantId, task.childSessionId);
      const childAccess = createSubagentChildAccess(createSubagentRootAccess({ principal: owner, rootSessionId: session.id, rootTurnId, rootFence: fenceBefore }),
        { taskId: task.taskId, childSessionId: task.childSessionId, childTurnId: task.childTurnId });
      const now = Date.now(), lateResult: ItemOf<"toolResult"> = { id: newId("item"), sessionId: task.childSessionId, turnId: task.childTurnId,
        seq: 0, step: childCall!.step, type: "toolResult", status: "completed", createdAtMs: now, completedAtMs: now,
        toolCallId: CHILD_CALL, name: toolName, content: [{ type: "text", text: `late-child-result:${EFFECT}` }], isError: false };
      const lateCall: ItemOf<"toolCall"> = { ...childCall!, status: "completed", completedAtMs: now };
      const lateBatch = attachSubagentCommitAdmission({ sessionId: task.childSessionId, fence: fenceBefore, items: [lateCall, lateResult], events: [
        { type: "item/completed", sessionId: task.childSessionId, emittedAtMs: now, item: lateCall },
        { type: "item/completed", sessionId: task.childSessionId, emittedAtMs: now, item: lateResult },
      ] }, { access: childAccess });
      // A numeric old rootFence/member access cannot reconstruct the killed process's opaque proof.
      // This is the exact missing-proof protocol negative, not fabricated evidence of a live old writer.
      const missingProofFailure: unknown = await reader.commit(lateBatch).then(() => undefined, failure => failure);
      expect(missingProofFailure).toBeInstanceOf(SessionAuthorityError);
      expect(missingProofFailure).toMatchObject({ code: "session_authority_unavailable" });
      expect((await reader.getSession(owner.tenantId, task.childSessionId))?.lastSeq).toBe(beforeLate?.lastSeq);
      expect(await reader.listItems(task.childSessionId, { limit: 100 })).toEqual(childAfter);
      expect((await json(router.url, `${control}/approvals/${childApproval.id}`, { method: "POST", body: JSON.stringify({ decision: "acceptForSession" }) })).status).toBe(409);
      expect((await json(router.url, `${control}/tool-results`, { method: "POST", body: JSON.stringify({ toolCallId: CHILD_CALL, content: [{ type: "text", text: "late-ack" }] }) })).status).toBe(409);
      const terminalInterrupt = await json(router.url, `${control}/interrupt`, { method: "POST", body: "{}" });
      expect(terminalInterrupt.status).toBe(200); expect(terminalInterrupt.body).toMatchObject({ id: task.childTurnId, status: "interrupted" });
      expect((await reader.getSession(owner.tenantId, task.childSessionId))?.lastSeq).toBe(beforeLate?.lastSeq);
      expect(await redis.exists(childKeys.lease, childKeys.fence)).toBe(0);
      expect((await ownedKeys(redis, prefix)).filter(key => key.startsWith(`${prefix}:fence:`))).toEqual([]);
      for (const [id, keys] of [[session.id, rootKeys], [task.childSessionId, childKeys]] as const) {
        const snapshot = await reader.getSession(owner.tenantId, id), events = await reader.readEvents(id, 0, 1000);
        expect(events.map(event => event.seq)).toEqual(Array.from({ length: snapshot!.lastSeq }, (_, index) => index + 1));
        expect(events.every(event => Event.safeParse(event).success && event.sessionId === id)).toBe(true);
        const hot = (await redis.xrange(keys.stream, "-", "+")).map(([, fields]) => { const at = fields.indexOf("e"); if (at < 0) throw new Error("Subagent Redis stream shape invalid."); return Event.parse(JSON.parse(fields[at + 1]!)); });
        expect(hot.map(event => [event.seq, event.type, event.sessionId])).toEqual(events.map(event => [event.seq, event.type, event.sessionId]));
        expect(events.some(event => event.type === "item/completed" && event.item.type === "toolResult" && event.item.toolCallId === CHILD_CALL)).toBe(false);
      }
      const parentEvents = await reader.readEvents(session.id, 0, 1000);
      expect(parentEvents.filter(event => event.type === "lifecycle-hook/completed" && event.phase === "SubagentStart")).toHaveLength(1);
      expect(parentEvents.filter(event => event.type === "lifecycle-hook/completed" && event.phase === "SubagentStop")).toHaveLength(0); // Crash repair never invents an observer delivery.
      const [ledger] = await admin.query<RowDataPacket[]>({ sql: `SELECT usage_id,session_id,turn_id,step FROM \`${database}\`.usage_ledger WHERE tenant_id=? ORDER BY id`, timeout: 5_000 }, [owner.tenantId]);
      const [facts] = await admin.query<RowDataPacket[]>({ sql: `SELECT usage_id,total_tokens FROM \`${database}\`.billing_usage_facts WHERE tenant_id=? ORDER BY usage_id`, timeout: 5_000 }, [owner.tenantId]);
      expect(ledger).toHaveLength(3); expect(facts).toHaveLength(3); expect(new Set(ledger.map(row => row.usage_id)).size).toBe(3);
      expect(ledger.map(row => row.usage_id).sort()).toEqual(facts.map(row => row.usage_id).sort()); expect(facts.reduce((sum, row) => sum + Number(row.total_tokens), 0)).toBe(36);
      expect(peer.calls).toHaveLength(1); expect(vendor.requests).toHaveLength(3); check(); bodyPassed = true;
    } catch (error) { failures.push(error); }
    finally {
      // Cleanup is inside this unchanged 120s it, including actual child close, not an afterAll escape.
      releaseReply(); clearTimeout(timer); lifetime.abort();
      await Promise.all(procs.map(async proc => {
        try {
          if (proc.pid > 1) await stopOwned(proc); else await proc.closed;
          if (proc.spawnFailed || proc.logFailed || proc.logOverflow || proc.hardCleanup || !proc.closeSeen || (proc.pid > 1 && groupAlive(proc))) throw new Error("Subagent owned process did not close cleanly.");
          expect(proc.exit).toEqual(proc.crashed ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null });
        } catch (error) { failures.push(error); }
      }));
      try { childrenSettled = procs.every(proc => proc.closeSeen && proc.pid > 1 && !groupAlive(proc)); } catch (error) { failures.push(error); }
      if (reader) { readerUncertain = true; try { await reader.close(); reader = undefined; readerUncertain = false; } catch (error) { failures.push(error); } }
      try { await peer.stop(); if (bodyPassed) expect(peer.calls).toHaveLength(1); } catch (error) { failures.push(error); }
      try { await vendor.stop(); } catch (error) { failures.push(error); } vi.unstubAllEnvs();
      if (scratch) {
        try { const metadata = await lstat(scratch); scratchSafe = metadata.isDirectory() && !metadata.isSymbolicLink()
          && /^agent-service-subagent-takeover-[A-Za-z0-9]+$/.test(basename(scratch)) && await realpath(dirname(scratch)) === await realpath(tmpdir()); }
        catch (error) { failures.push(error); }
      }
      if (mysqlRuntime) {
        const successful = bodyPassed && failures.length === 0 && childrenSettled && !readerUncertain && !reader
          && scratchSafe && !fixtureSignal.aborted && performance.now() < cleanupExpires;
        try { await mysqlRuntime.close({ successful }); runtimeReleased = successful; }
        catch (error) { failures.push(error); }
      }
      if (admin && created && bodyPassed && failures.length === 0 && runtimeReleased && childrenSettled && !readerUncertain && !reader && scratchSafe && redis && namespaceOwned) {
        try {
          if (context.signal.aborted || performance.now() >= cleanupExpires) throw new Error("Subagent cleanup deadline expired; retain scope.");
          const [same] = await admin.query<RowDataPacket[]>({ sql: "SELECT @@server_uuid AS server_uuid,DATABASE() AS db", timeout: 5_000 });
          expect(same).toHaveLength(1); expect(same[0]).toMatchObject({ server_uuid: serverUuid, db: "mysql" });
          const [connections] = await admin.query<RowDataPacket[]>({ sql: "SELECT ID FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (BINARY DB=BINARY ? OR LOCATE(?,COALESCE(INFO,''))>0)", timeout: 5_000 }, [database, database]);
          const [transactions] = await admin.query<RowDataPacket[]>({ sql: "SELECT t.trx_id FROM information_schema.innodb_trx t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ? OR LOCATE(?,COALESCE(t.trx_query,''))>0", timeout: 5_000 }, [database, database]);
          const [locks] = await admin.query<RowDataPacket[]>({ sql: "SELECT OWNER_THREAD_ID FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ?", timeout: 5_000 }, [database]);
          expect(connections).toHaveLength(0); expect(transactions).toHaveLength(0); expect(locks).toHaveLength(0);
          if (!/^agent_service_subagent_test_[a-f0-9]{24}$/.test(database) || database === decodeURIComponent(base.sql.pathname.slice(1))) throw new Error("Subagent exact DROP ownership invalid.");
          const keys = await ownedKeys(redis, prefix); for (let at = 0; at < keys.length; at += 100) await redis.unlink(...keys.slice(at, at + 100));
          expect(await ownedKeys(redis, prefix)).toEqual([]); await closeOwnedRedis(redis); redis = undefined;
          if (context.signal.aborted || performance.now() >= cleanupExpires) throw new Error("Subagent deadline before exact DROP; retain schema.");
          await admin.query({ sql: `DROP DATABASE \`${database}\``, timeout: 5_000 }); created = false;
          await rm(join(scratch!, "blobs-1"), { recursive: true, force: true }); await rm(join(scratch!, "blobs-2"), { recursive: true, force: true }); cleanupComplete = true;
        } catch (error) { failures.push(error); }
      }
      if (redis) {
        const closingRedis = redis;
        try { await closeOwnedRedis(closingRedis); } catch (error) { failures.push(error); }
        finally { if (closingRedis.status === "end") redis = undefined; }
      }
      if (admin) { try { await admin.end(); } catch (error) { failures.push(error); } }
      if (created || createAttempted && !bodyPassed) failures.push(new Error(`Subagent failed/uncertain owned scope retained: ${database}; ${prefix}`));
      if (scratchSafe && scratch) {
        try {
          await writeFile(join(scratch, "child-exits.json"), JSON.stringify({ schema: "root-subagent-process-takeover-v1", stage, bodyPassed, cleanupComplete,
            databaseRetained: created || createAttempted && !bodyPassed, namespace: prefix,
            children: procs.map(proc => ({ label: proc.label, pid: proc.pid, exit: proc.exit ?? null, nativeClosed: proc.closeSeen,
              groupGone: proc.pid > 1 && !groupAlive(proc), spawnFailed: proc.spawnFailed, logFailed: proc.logFailed, logOverflow: proc.logOverflow, hardCleanup: proc.hardCleanup })) }, null, 2), { flag: "wx", mode: 0o600 });
          console.info(JSON.stringify({ schema: "root-subagent-process-takeover-evidence-v1", directory: scratch, cleanupComplete }));
        } catch (error) { failures.push(error); }
      }
      clearTimeout(fixtureTimer);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Subagent process takeover or owned cleanup failed.");
  }, 120_000);
});
