import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { createServer, createConnection as createSocket, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentDefinition, Event, Session } from "../../packages/protocol/src/index.js";
import { MysqlSessionStore, redisSessionKeys } from "../../packages/store/src/index.js";
import { hashApiKey } from "../../apps/agent-runner/src/auth.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../fixtures/mysql-schema-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "64".repeat(32); // Owned fixture material, not an operator or production credential.
const INTERNAL = "external-infra-owned-internal-token-0001";
const TENANT = "external_infra_fixture", OTHER_TENANT = "external_infra_other";
const KEY = "external-infra-fixture-api-key", OTHER_KEY = "external-infra-other-api-key";
type NativeExit = { code: number | null; signal: NodeJS.Signals | null };
type OwnedProcess = { child: ChildProcess; pid: number; closed: Promise<void>; closeSeen: boolean;
  exit?: NativeExit; forced: boolean; output: string; outputOverflow: boolean; spawnFailed: boolean };
type Query = (sql: string, values?: QueryValues) => Promise<RowDataPacket[]>;
function fail(): never { throw new Error("External infrastructure process fixture is not proven."); }
function bases(input: NodeJS.ProcessEnv = process.env) {
  const sql = new URL(input.CLUSTER_MYSQL_URL ?? "mysql://invalid/"), redis = new URL(input.CLUSTER_REDIS_URL ?? "redis://invalid/");
  const explicitPort = (value: string) => /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65_535;
  if (sql.protocol !== "mysql:" || sql.hostname !== "127.0.0.1" || !explicitPort(sql.port) || !sql.username || sql.search || sql.hash
    || !/(?:^|_)(?:test|cluster)(?:_|$)/i.test(decodeURIComponent(sql.pathname.slice(1)))
    || redis.protocol !== "redis:" || redis.hostname !== "127.0.0.1" || !explicitPort(redis.port) || redis.search || redis.hash
    || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) fail();
  return { sql, redis };
}
function at(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }

// Own the native stream before mysql2's handshake, including cancellation and failed connect.
async function native<T>(url: string, signal: AbortSignal, work: (query: Query) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let connection: Connection | undefined, broken = false, result: { value: T } | undefined;
  const sockets = new Set<Socket>(), closes = new Set<Promise<void>>();
  const destroy = () => { try { connection?.destroy(); } catch { broken = true; } for (const socket of sockets) socket.destroy(); };
  const stream = ({ config }: { config: { socketPath?: string; host: string; port: number } }) => {
    const socket = config.socketPath ? createSocket(config.socketPath) : createSocket({ host: config.host, port: config.port });
    sockets.add(socket); const closed = new Promise<void>(resolveClosed => { socket.once("close", () => resolveClosed()); });
    closes.add(closed); void closed.then(() => { sockets.delete(socket); closes.delete(closed); });
    if (signal.aborted || broken) queueMicrotask(destroy); return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  let timer = setTimeout(() => { broken = true; destroy(); }, 10_000);
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: 10_000, stream }); clearTimeout(timer);
    signal.throwIfAborted();
    const query: Query = async (sql, values = []) => {
      signal.throwIfAborted(); const queryTimer = setTimeout(() => { broken = true; destroy(); }, 10_000);
      try { const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 10_000 }, values); signal.throwIfAborted(); return rows; }
      finally { clearTimeout(queryTimer); }
    };
    result = { value: await work(query) }; signal.throwIfAborted();
  } catch { broken = true;
  } finally {
    clearTimeout(timer); timer = setTimeout(() => { broken = true; destroy(); }, 10_000);
    try { await connection?.end(); } catch { broken = true; } finally {
      destroy(); while (closes.size) await Promise.all([...closes]); clearTimeout(timer);
      signal.removeEventListener("abort", destroy);
    }
  }
  if (broken || signal.aborted || !result) return fail(); return result.value;
}
async function listen(port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveReady); });
  return server;
}
function portOf(server: Server) { const address = server.address(); if (!address || typeof address === "string") return fail(); return address.port; }
async function closeListener(server: Server) { await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())); }
async function freePort() { const server = await listen(); const port = portOf(server); await closeListener(server); return port; }
function groupAlive(proc: OwnedProcess): boolean {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) return fail();
  try { process.kill(-proc.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return fail(); }
}
async function until(predicate: () => boolean | Promise<boolean>, signal: AbortSignal, milliseconds: number) {
  const end = performance.now() + milliseconds;
  do { signal.throwIfAborted(); if (await predicate()) return; await delay(25, undefined, { signal }); } while (performance.now() < end);
  fail();
}
function launch(runner: string, router: string, state: string): OwnedProcess {
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir() };
  const child = spawn("/bin/bash", [join(ROOT, "scripts/local-service.sh"), "--external-infra", "run",
    "--runner-env", runner, "--router-env", router, "--state-dir", state],
  { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let resolveClosed!: () => void;
  const proc: OwnedProcess = { child, pid: child.pid ?? 0, closed: new Promise<void>(done => { resolveClosed = done; }),
    closeSeen: false, forced: false, output: "", outputOverflow: false, spawnFailed: false };
  const collect = (bytes: Buffer) => { if (Buffer.byteLength(proc.output) + bytes.length > 65_536) proc.outputOverflow = true;
    else proc.output += bytes.toString("utf8"); };
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  child.once("error", () => { proc.spawnFailed = true; });
  child.once("close", (code, signal) => { proc.exit = { code, signal }; proc.closeSeen = true; resolveClosed(); });
  return proc;
}
async function stop(proc: OwnedProcess, signal: AbortSignal) {
  if (proc.pid <= 1) { await proc.closed; return fail(); }
  // Only the supervisor receives normal TERM. Broadcasting to its group would mask broken forwarding.
  if (!proc.closeSeen) proc.child.kill("SIGTERM");
  // The unchanged real router has a ten-second drain grace; this remains inside the case's budget.
  await until(() => proc.closeSeen && !groupAlive(proc), signal, 15_000); await proc.closed;
}
async function rescue(proc: OwnedProcess) {
  if (proc.pid <= 1) { await proc.closed; return; }
  if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return; }
  const cleanup = new AbortController(), timer = setTimeout(() => cleanup.abort(), 20_000);
  try {
    try { await stop(proc, cleanup.signal); }
    catch {
      proc.forced = true;
      // Failure-only fallback, never a successful shutdown proof; identity is still this exact spawn.
      if (groupAlive(proc)) process.kill(-proc.pid, "SIGKILL");
      await proc.closed; await until(() => !groupAlive(proc), cleanup.signal, 3_000);
    }
  } finally { clearTimeout(timer); }
}
async function json(origin: string, path: string, signal: AbortSignal, init: RequestInit = {}, key = KEY, user = "owned-user") {
  const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${key}`); headers.set("x-user-id", user);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(origin + path, { ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}
async function ready(origin: string, proc: OwnedProcess, signal: AbortSignal, body: string) {
  await until(async () => {
    if (proc.spawnFailed || proc.closeSeen || proc.outputOverflow) return fail();
    try { const response = await fetch(origin + "/readyz", { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]) });
      const text = await response.text(); return response.status === 200 && text === body; }
    catch { signal.throwIfAborted(); return false; }
  }, signal, 10_000);
}
async function portClosed(port: number) {
  try { const server = await listen(port); await closeListener(server); return true; } catch { return false; }
}
async function ownedKeys(redis: Redis, prefix: string): Promise<string[]> {
  let cursor = "0", rounds = 0; const found = new Set<string>();
  do { const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = next;
    if (++rounds > 100 || keys.some(key => !key.startsWith(`${prefix}:`))) return fail();
    for (const key of keys) found.add(key); if (found.size > 2_000) return fail();
  } while (cursor !== "0");
  return [...found];
}

// Pure refusal checks only: no hooks, connection, witness or default-driver port resolution.
describe("external-infra process fixture target ports", () => {
  const input = { CLUSTER_MYSQL_URL: "mysql://fixture@127.0.0.1:62077/agent_service_cluster",
    CLUSTER_REDIS_URL: "redis://127.0.0.1:62078/3" };
  it("accepts independently explicit nonzero MySQL and Redis ports", () => {
    const result = bases(input); expect(result.sql.port).toBe("62077"); expect(result.redis.port).toBe("62078");
  });
  it("rejects MySQL zero or missing port before any driver can fall back to 3306", () => {
    for (const port of [":0", ""]) expect(() => bases({ ...input,
      CLUSTER_MYSQL_URL: `mysql://fixture@127.0.0.1${port}/agent_service_cluster` })).toThrow("External infrastructure process fixture is not proven.");
  });
  it("rejects Redis zero or missing port before any connection or witness", () => {
    for (const port of [":0", ""]) expect(() => bases({ ...input,
      CLUSTER_REDIS_URL: `redis://127.0.0.1${port}/3` })).toThrow("External infrastructure process fixture is not proven.");
  });
});

describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER)("external-infra foreground command with real MySQL and Redis", () => {
  const lifetime = new AbortController(), processes = new Set<OwnedProcess>();
  const fixtureNonce = randomBytes(12).toString("hex"), database = `agent_ext_test_${fixtureNonce}`;
  const redisGuard = `external_guard_${fixtureNonce}`;
  let sql: URL, redisUrl: URL, appUrl = "", uuid = "", scratch = "", runtimeUser = "";
  let handle: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let setupComplete = false, passed = 0, fixtureFailed = false, created = false;
  let setupWork: Promise<void> | undefined, caseWork: Promise<void> | undefined;
  let redis: Redis | undefined, redisSocket: Redis["stream"] | undefined, redisNativeClosed: Promise<void> | undefined;
  const prefixes = new Set<string>();
  function serialCase(work: () => Promise<void>) {
    const previous = caseWork;
    caseWork = (async () => { await previous?.catch(() => {}); if (fixtureFailed) return fail(); await work(); })();
    return caseWork;
  }

  async function noConsumers(signal: AbortSignal) {
    await native(at(sql, "mysql"), signal, async query => {
      const identity = await query("SELECT @@server_uuid AS uuid"); expect(identity).toHaveLength(1); expect(identity[0]!.uuid).toBe(uuid);
      for (const [statement, values] of [
        ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]],
        ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [database]],
        ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [database, database]],
        ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [runtimeUser]],
      ] as const) { const rows = await query(statement, [...values]); expect(rows).toHaveLength(1); expect(Number(rows[0]!.n)).toBe(0); }
    });
  }
  async function privateJson(path: string, value: Record<string, string>) {
    const file = await open(path, "wx", 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  }
  async function configuration(label: string, routerPort?: number) {
    if (!handle || !setupComplete) return fail();
    const directory = join(scratch, label); await mkdir(directory, { mode: 0o700 });
    const configDirectory = join(directory, "config"); await mkdir(configDirectory, { mode: 0o700 });
    const state = join(directory, "state"), runnerPort = await freePort(), selectedRouter = routerPort ?? await freePort();
    if (runnerPort === selectedRouter) return fail();
    const prefix = `ext_${randomBytes(12).toString("hex")}`; prefixes.add(prefix);
    expect(await ownedKeys(redis!, prefix)).toEqual([]);
    const shared = { NODE_ENV: "test", REDIS_URL: redisUrl.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: prefix,
      INTERNAL_ROUTER_TOKEN: INTERNAL, BLOB_STORE: "filesystem", BLOB_NAMESPACE_ID: `external-blob-${fixtureNonce}`,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_STORAGE_CONTROL_ENABLED: "0", BLOB_ATTACHMENTS_ENABLED: "0" };
    const runner = { ...shared, STORE: "mysql", ...handle.runtimeEnv, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
      RUNNER_ID: `ext-${prefix}`, RUNNER_ADDR: `127.0.0.1:${runnerPort}`, SECRETS_MASTER_KEY: SECRET,
      BLOB_DIR: join(scratch, "blobs"), BLOB_CLEANUP_ENABLED: "0", PLATFORM_PROVIDER: "deepseek", DEFAULT_MODEL: "deepseek-chat",
      API_KEY: "owned-unused-upstream-key", API_BASE_URL: "http://127.0.0.1:9/v1" };
    const router = { ...shared, ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(selectedRouter), RUNNERS: `http://127.0.0.1:${runnerPort}` };
    const runnerPath = join(configDirectory, "runner.json"), routerPath = join(configDirectory, "router.json");
    await privateJson(runnerPath, runner); await privateJson(routerPath, router);
    return { state, runnerPath, routerPath, runnerPort, routerPort: selectedRouter, prefix,
      runnerOrigin: `http://127.0.0.1:${runnerPort}`, routerOrigin: `http://127.0.0.1:${selectedRouter}` };
  }

  beforeAll(() => {
    setupWork = (async () => {
    const setupTimer = setTimeout(() => { fixtureFailed = true; lifetime.abort(); }, 110_000);
    try {
      ({ sql, redis: redisUrl } = bases()); appUrl = at(sql, database);
      expect(Buffer.byteLength(database.replace(/[%_]/g, "\\$&"))).toBeLessThanOrEqual(64);
      scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-service-external-infra-"))); await chmod(scratch, 0o700);
      await mkdir(join(scratch, "blobs"), { mode: 0o700 });
      const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: appUrl, applicationDatabase: database, operationAbortSignal: lifetime.signal });
      await native(at(sql, "mysql"), lifetime.signal, async query => { await query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true; });
      handle = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: createMysqlSchemaCliExecutor({
        entrypoint: join(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT }) });
      uuid = handle.serverUuid; runtimeUser = decodeURIComponent(new URL(handle.runtimeEnv.MYSQL_URL).username);
      const seed = await MysqlSessionStore.connect({ ...handle.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: lifetime.signal });
      try { await seed.createApiKey(TENANT, "owned-external", hashApiKey(KEY), ["runtime", "admin"]);
        await seed.createApiKey(OTHER_TENANT, "owned-other", hashApiKey(OTHER_KEY), ["runtime", "admin"]); }
      finally { await seed.close(); }
      redis = new Redis(redisUrl.toString(), { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
        retryStrategy: () => null, connectionName: `external-test-${fixtureNonce}`, commandTimeout: 5_000, connectTimeout: 5_000 });
      redis.on("error", () => { fixtureFailed = true; });
      lifetime.signal.addEventListener("abort", () => {
        try { redis?.disconnect(); } catch { fixtureFailed = true; } redisSocket?.destroy();
      }, { once: true });
      redis.on("connect", () => {
        redisSocket = redis!.stream;
        redisNativeClosed = redisSocket.closed ? Promise.resolve() : new Promise<void>(done => redisSocket!.once("close", () => done()));
        if (lifetime.signal.aborted) { redis!.disconnect(); redisSocket.destroy(); }
      });
      await redis.connect(); if (!redisSocket || !redisNativeClosed) return fail(); expect(await redis.ping()).toBe("PONG");
      expect(await redis.set(redisGuard, fixtureNonce, "NX")).toBe("OK");
      await noConsumers(lifetime.signal); setupComplete = true;
    } catch (error) { fixtureFailed = true; throw error; }
    finally { clearTimeout(setupTimer); }
    })();
    return setupWork;
  }, 120_000);

  it("runs the actual dual-service command with runtime-only authority and drains it after supervisor-only TERM", context => serialCase(async () => {
    let proc: OwnedProcess | undefined;
    const cancel = () => { fixtureFailed = true; if (proc && !proc.closeSeen) {
      try { proc.child.kill("SIGTERM"); } catch { /* The awaited failure-only rescue retains ownership. */ }
    } };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      context.signal.throwIfAborted();
      const config = await configuration("successful");
      context.signal.throwIfAborted();
      proc = launch(config.runnerPath, config.routerPath, config.state); processes.add(proc);
      await ready(config.runnerOrigin, proc, context.signal, "ready");
      await ready(config.routerOrigin, proc, context.signal, "ready (1 runners)");
      const unauthorized = await json(config.routerOrigin, "/v1/agents", context.signal, {}, "not-the-owned-key"); expect(unauthorized.status).toBe(401);
      const createdAgent = await json(config.routerOrigin, "/v1/agents", context.signal, { method: "POST", body: JSON.stringify({
        name: "External infrastructure fixture", instructions: "No provider request is needed for this storage/startup test.",
        model: { provider: "deepseek", model: "deepseek-chat" }, tools: [], approvalPolicy: "never" }) });
      expect(createdAgent.status).toBe(201); const agent = AgentDefinition.parse(createdAgent.body);
      const createdSession = await json(config.routerOrigin, "/v1/sessions", context.signal, { method: "POST", body: JSON.stringify({ agentId: agent.id }) });
      expect(createdSession.status).toBe(201); const session = Session.parse(createdSession.body);
      expect((await json(config.routerOrigin, `/v1/sessions/${session.id}`, context.signal)).status).toBe(200);
      expect((await json(config.routerOrigin, `/v1/sessions/${session.id}`, context.signal, {}, OTHER_KEY)).status).toBe(404);
      expect((await json(config.routerOrigin, `/v1/sessions/${session.id}`, context.signal, {}, KEY, "different-user")).status).toBe(404);
      expect((await json(config.routerOrigin, `/v1/agents/${agent.id}`, context.signal, {}, OTHER_KEY)).status).toBe(404);
      const stream = await redis!.xrange(redisSessionKeys(session.id, config.prefix).stream, "-", "+");
      expect(stream).toHaveLength(1); const fields = stream[0]![1], eventAt = fields.indexOf("e"); expect(eventAt).toBeGreaterThanOrEqual(0);
      expect(Event.parse(JSON.parse(fields[eventAt + 1]!))).toMatchObject({ type: "session/created", sessionId: session.id, seq: 1 });

      await stop(proc, context.signal); expect(proc.exit).toEqual({ code: 143, signal: null });
      expect(proc.forced || proc.spawnFailed || proc.outputOverflow).toBe(false); expect(proc.output).toBe("");
      expect(await portClosed(config.runnerPort)).toBe(true); expect(await portClosed(config.routerPort)).toBe(true);
      expect(await redis!.get(redisGuard)).toBe(fixtureNonce); // External Redis was not FLUSHed or replaced.
      await noConsumers(context.signal);
      // This is an independent cold, public verify-only Store connection, not a retained hot object.
      const cold = await MysqlSessionStore.connect({ ...handle!.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: context.signal });
      try { expect(await cold.getAgent(TENANT, agent.id)).toEqual(agent); expect(await cold.getSession(TENANT, session.id)).toEqual(session);
        expect(await cold.getSession(OTHER_TENANT, session.id)).toBeNull();
        expect(await cold.readEvents(session.id, 0, 10)).toEqual([{ type: "session/created", sessionId: session.id, emittedAtMs: session.createdAtMs, seq: 1 }]); }
      finally { await cold.close(); }
      await noConsumers(context.signal);
      for (const name of ["runner.log", "router.log"]) {
        const path = join(config.state, name); expect((await lstat(path)).mode & 0o777).toBe(0o600);
        const contents = await readFile(path, "utf8");
        // Compare in memory and report only a boolean, never the private runtime DSN/key.
        expect([SECRET, INTERNAL, KEY, OTHER_KEY, handle!.runtimeEnv.MYSQL_URL, "owned-unused-upstream-key"]
          .some(value => contents.includes(value))).toBe(false);
      }
    } catch (error) { fixtureFailed = true; throw error; }
    finally { context.signal.removeEventListener("abort", cancel);
      try { if (proc) await rescue(proc); } catch (error) { fixtureFailed = true; throw error; } }
    passed++;
  }), 45_000);

  it("rejects an occupied router port without taking over its listener or retaining any application consumer", context => serialCase(async () => {
    context.signal.throwIfAborted();
    const foreign = await listen(); const foreignPort = portOf(foreign); let proc: OwnedProcess | undefined;
    const cancel = () => { fixtureFailed = true; if (proc && !proc.closeSeen) {
      try { proc.child.kill("SIGTERM"); } catch { /* The awaited failure-only rescue retains ownership. */ }
    } };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      const config = await configuration("occupied", foreignPort);
      context.signal.throwIfAborted();
      proc = launch(config.runnerPath, config.routerPath, config.state); processes.add(proc);
      // Depending on preflight, the runner may never start. Only rejection, listener ownership
      // and absence of consumers are asserted; this is not a claim of a late-start race.
      await until(() => proc!.closeSeen && !groupAlive(proc!), context.signal, 15_000); await proc.closed;
      expect(proc.exit).toEqual({ code: 1, signal: null }); expect(proc.forced || proc.spawnFailed || proc.outputOverflow).toBe(false);
      expect(proc.output).toBe("external_infra_invalid\n");
      expect(foreign.listening).toBe(true); expect(portOf(foreign)).toBe(foreignPort);
      expect(await redis!.get(redisGuard)).toBe(fixtureNonce);
      expect(await portClosed(config.runnerPort)).toBe(true); await noConsumers(context.signal);
    } catch (error) { fixtureFailed = true; throw error; }
    finally {
      context.signal.removeEventListener("abort", cancel);
      try { try { if (proc) await rescue(proc); } finally { await closeListener(foreign); } }
      catch (error) { fixtureFailed = true; throw error; }
    }
    passed++;
  }), 45_000);

  afterAll(async () => {
    const cleanupTimer = setTimeout(() => { fixtureFailed = true; lifetime.abort(); }, 50_000);
    let cleaned = false, redisClosed = redis === undefined, cleanupFailed = false, cleanupError: unknown;
    const remember = (error: unknown) => { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } };
    try {
      // Vitest timeout reporting is not a native-I/O barrier. Join the original hook/case
      // work before cleaning resources or allowing a timed-out predecessor to overlap cleanup.
      await setupWork?.catch(() => { fixtureFailed = true; });
      await caseWork?.catch(() => { fixtureFailed = true; });
      for (const proc of processes) { await rescue(proc); if (proc.forced || proc.spawnFailed || proc.outputOverflow || !proc.closeSeen || groupAlive(proc)) fixtureFailed = true; }
      let successful = setupComplete && passed === 2 && !fixtureFailed && !lifetime.signal.aborted;
      if (successful) await noConsumers(lifetime.signal);
      successful = successful && !fixtureFailed && !lifetime.signal.aborted;
      await handle?.close({ successful });
      if (successful && created) {
        for (const prefix of prefixes) {
          const keys = await ownedKeys(redis!, prefix); if (keys.length) await redis!.del(...keys);
          expect(await ownedKeys(redis!, prefix)).toEqual([]);
        }
        expect(await redis!.get(redisGuard)).toBe(fixtureNonce); expect(await redis!.del(redisGuard)).toBe(1);
        await noConsumers(lifetime.signal);
        await native(at(sql, "mysql"), lifetime.signal, async query => {
          const rows = await query("SELECT @@server_uuid AS uuid"); expect(rows).toHaveLength(1); expect(rows[0]!.uuid).toBe(uuid);
          if (fixtureFailed || lifetime.signal.aborted || !/^agent_ext_test_[a-f0-9]{24}$/.test(database)) fail();
          await query(`DROP DATABASE \`${database}\``);
          expect(await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).toEqual([]);
        });
        created = false; cleaned = true;
      }
    } catch (error) { remember(error);
    } finally {
      try {
        if (redis) {
          const client = redis; const closed = new Promise<void>(done => { if (client.status === "end") done(); else client.once("end", done); });
          const socket = redisSocket ?? client.stream;
          const nativeClosed = redisNativeClosed ?? (socket && !socket.closed ? new Promise<void>(done => socket.once("close", () => done())) : Promise.resolve());
          try { if (client.status !== "end") await client.quit(); } catch (error) { remember(error); }
          finally {
            try { client.disconnect(); } catch (error) { remember(error); }
            try { socket?.destroy(); } catch (error) { remember(error); }
            await closed; await nativeClosed;
          }
          redisClosed = true;
        }
      } catch (error) { remember(error);
      } finally {
        clearTimeout(cleanupTimer); lifetime.abort();
        if (cleaned && redisClosed && !fixtureFailed && !cleanupFailed) {
          try { await rm(scratch, { recursive: true, force: true }); } catch (error) { remember(error); }
        }
        if ((!cleaned || !redisClosed || fixtureFailed || cleanupFailed) && scratch) {
          try { console.warn(JSON.stringify({ schema: "external-infra-fixture-retained-v1", directory: scratch,
            successful: false, cleanupComplete: false, resourcesRetainedOrUnknown: true })); } catch { /* Never replace the original failure. */ }
        }
      }
    }
    if (cleanupFailed) throw cleanupError;
    // A late observer/native-close fault must not turn two passing bodies into a green file.
    // Existing body failures keep their original errors; unknown/partial cleanup keeps scratch.
    if (passed === 2 && (!cleaned || !redisClosed || fixtureFailed)) fail();
  });
});
