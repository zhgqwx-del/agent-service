import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { createConnection as createSocket, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type QueryValues, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlSessionStore } from "../../packages/store/src/index.js";
import { hashApiKey } from "../../apps/agent-runner/src/auth.js";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../fixtures/mysql-runtime.mjs";
import { createMysqlSchemaCliExecutor } from "../fixtures/mysql-schema-cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MASTER = "82".repeat(32), INTERNAL = "first-admin-owned-internal-token-0001";
const TENANT = "first_admin_owned", REFUSED_TENANT = "first_admin_refused";
type OwnedProcess = { child: ChildProcess; pid: number; closed: Promise<void>; closeSeen: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null }; forced: boolean; failedSpawn: boolean; overflow: boolean; output: string };
type Query = (sql: string, values?: QueryValues) => Promise<RowDataPacket[]>;
function fail(): never { throw new Error("First-admin external infrastructure fixture is not proven."); }
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function targets() {
  try {
  const sql = new URL(process.env.CLUSTER_MYSQL_URL ?? "mysql://invalid/"), redis = new URL(process.env.CLUSTER_REDIS_URL ?? "redis://invalid/");
  const port = (value: string) => /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65_535;
  if (sql.protocol !== "mysql:" || sql.hostname !== "127.0.0.1" || !port(sql.port) || !sql.username || sql.search || sql.hash
    || !/(?:^|_)(?:test|cluster)(?:_|$)/i.test(decodeURIComponent(sql.pathname.slice(1)))
    || redis.protocol !== "redis:" || redis.hostname !== "127.0.0.1" || !port(redis.port) || redis.search || redis.hash
    || !/^\/(?:[0-9]|1[0-5])$/.test(redis.pathname)) fail();
  return { sql, redis };
  } catch { return fail(); }
}
function at(base: URL, database: string) { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }

// Same explicit native-close boundary as the external-infra cluster fixture; no retained hot pool.
async function native<T>(url: string, signal: AbortSignal, work: (query: Query) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); let connection: Connection | undefined, broken = false, result: { value: T } | undefined;
  const sockets = new Set<Socket>(), closes = new Set<Promise<void>>();
  const destroy = () => { try { connection?.destroy(); } catch { broken = true; } for (const socket of sockets) socket.destroy(); };
  const stream = ({ config }: { config: { socketPath?: string; host: string; port: number } }) => {
    const socket = config.socketPath ? createSocket(config.socketPath) : createSocket({ host: config.host, port: config.port });
    sockets.add(socket); const closed = new Promise<void>(done => socket.once("close", () => done()));
    closes.add(closed); void closed.then(() => { sockets.delete(socket); closes.delete(closed); });
    if (signal.aborted || broken) queueMicrotask(destroy); return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  let timer = setTimeout(() => { broken = true; destroy(); }, 10_000);
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: 10_000, stream }); clearTimeout(timer); signal.throwIfAborted();
    const query: Query = async (sql, values = []) => {
      signal.throwIfAborted(); const limit = setTimeout(() => { broken = true; destroy(); }, 10_000);
      try { const [rows] = await connection!.query<RowDataPacket[]>({ sql, timeout: 10_000 }, values); signal.throwIfAborted(); return rows; }
      finally { clearTimeout(limit); }
    };
    result = { value: await work(query) }; signal.throwIfAborted();
  } catch { broken = true;
  } finally {
    clearTimeout(timer); timer = setTimeout(() => { broken = true; destroy(); }, 10_000);
    try { await connection?.end(); } catch { broken = true; }
    finally { destroy(); while (closes.size) await Promise.all([...closes]); clearTimeout(timer); signal.removeEventListener("abort", destroy); }
  }
  if (broken || signal.aborted || !result) return fail(); return result.value;
}
async function port() {
  const listener = createServer();
  await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", done); });
  const address = listener.address(); if (!address || typeof address === "string") return fail();
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done())); return address.port;
}
async function portClosed(value: number) {
  const listener = createServer();
  try { await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(value, "127.0.0.1", done); });
    await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done())); return true; }
  catch { return false; }
}
function groupAlive(proc: OwnedProcess) {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) return fail();
  try { process.kill(-proc.pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return fail(); }
}
async function until(predicate: () => boolean | Promise<boolean>, signal: AbortSignal, milliseconds: number) {
  const end = performance.now() + milliseconds;
  do { signal.throwIfAborted(); if (await predicate()) return; await delay(25, undefined, { signal }); } while (performance.now() < end); fail();
}
function launch(file: string, args: string[], env: NodeJS.ProcessEnv): OwnedProcess {
  const child = spawn(file, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let done!: () => void;
  const proc: OwnedProcess = { child, pid: child.pid ?? 0, closed: new Promise<void>(resolveClosed => { done = resolveClosed; }),
    closeSeen: false, forced: false, failedSpawn: false, overflow: false, output: "" };
  const collect = (bytes: Buffer) => { if (Buffer.byteLength(proc.output) + bytes.length > 65_536) proc.overflow = true; else proc.output += bytes.toString("utf8"); };
  child.stdout?.on("data", collect); child.stderr?.on("data", collect);
  child.once("error", () => { proc.failedSpawn = true; });
  child.once("close", (code, signal) => { proc.exit = { code, signal }; proc.closeSeen = true; done(); }); return proc;
}
function terminate(proc: OwnedProcess) {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) return fail();
  if (!proc.closeSeen) proc.child.kill("SIGTERM");
}
async function stop(proc: OwnedProcess, signal: AbortSignal) {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 1 || proc.child.pid !== proc.pid) { await proc.closed; return fail(); }
  // Normal shutdown targets only the actual leader, proving the external supervisor's forwarding.
  terminate(proc);
  await until(() => proc.closeSeen && !groupAlive(proc), signal, 15_000); await proc.closed;
}
async function rescue(proc: OwnedProcess) {
  if (proc.pid <= 1) { await proc.closed; return; }
  if (proc.closeSeen && !groupAlive(proc)) { await proc.closed; return; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
  try { try { await stop(proc, controller.signal); } catch {
    proc.forced = true; // Failure-only owned-group fallback is never a successful shutdown oracle.
    if (groupAlive(proc)) process.kill(-proc.pid, "SIGKILL");
    await proc.closed; await until(() => !groupAlive(proc), controller.signal, 3_000);
  } } finally { clearTimeout(timer); }
}
async function ready(origin: string, proc: OwnedProcess, signal: AbortSignal, expected: string) {
  await until(async () => {
    if (proc.closeSeen || proc.failedSpawn || proc.overflow) return fail();
    try { const response = await fetch(origin + "/readyz", { signal: AbortSignal.any([signal, AbortSignal.timeout(500)]), redirect: "error" });
      return response.status === 200 && await response.text() === expected; }
    catch { signal.throwIfAborted(); return false; }
  }, signal, 10_000);
}
async function adminStatus(origin: string, key: string | undefined, signal: AbortSignal) {
  const headers: Record<string, string> = { "X-User-Id": "manual_verifier" };
  if (key !== undefined) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(origin + "/v1/tenant/api-keys", { headers, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
  await response.body?.cancel(); return response.status;
}
async function protectedKey(path: string) {
  const before = await lstat(path);
  expect(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600).toBe(true);
  expect(await realpath(path)).toBe(path); expect(before.size > 0 && before.size <= 4096).toBe(true);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const bytes = Buffer.alloc(4097), result = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
    expect([after.dev, after.ino, after.size, after.mode]).toEqual([before.dev, before.ino, before.size, before.mode]);
    const line = bytes.subarray(0, result.bytesRead).toString("utf8"); expect(/^ask_[A-Za-z0-9_-]{32}\n$/.test(line) && result.bytesRead === after.size).toBe(true);
    return { key: line.slice(0, -1), sha256: sha(line), dev: after.dev, ino: after.ino, size: after.size, mode: after.mode };
  } finally { await file.close(); }
}
async function ownedKeys(redis: Redis, prefix: string) {
  const keys = new Set<string>(); let cursor = "0", rounds = 0;
  do { const [next, found] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 100); cursor = next;
    if (++rounds > 100 || found.some(key => !key.startsWith(`${prefix}:`))) return fail();
    for (const key of found) keys.add(key); if (keys.size > 2000) return fail();
  } while (cursor !== "0"); return [...keys];
}

describe.skipIf(!process.env.AGENT_SERVICE_CLUSTER)("manual first-admin followed by real external-infra cold restart", () => {
  const lifetime = new AbortController(), processes = new Set<OwnedProcess>();
  const nonce = randomBytes(10).toString("hex"), database = `agent_adm_test_${nonce}`, prefix = `adm_${nonce}`, guard = `first_admin_guard_${nonce}`;
  let sql: URL, redisUrl: URL, appUrl = "", uuid = "", runtimeUser = "", scratch = "", outputFile = "", key = "";
  let handle: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let originalKey: Awaited<ReturnType<typeof protectedKey>> | undefined;
  let setupComplete = false, created = false, fixtureFailed = false, passed = 0, setupWork: Promise<void> | undefined, caseWork: Promise<void> | undefined;
  let redis: Redis | undefined, redisSocket: Redis["stream"] | undefined, redisClosed: Promise<void> | undefined;
  function serial(work: () => Promise<void>) { const previous = caseWork;
    caseWork = (async () => { await previous?.catch(() => {}); if (fixtureFailed) return fail(); await work(); })(); return caseWork; }
  async function noConsumers(signal: AbortSignal) {
    await native(at(sql, "mysql"), signal, async query => {
      expect((await query("SELECT @@server_uuid AS uuid"))[0]!.uuid).toBe(uuid);
      for (const [statement, values] of [
        ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]],
        ["SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX t JOIN information_schema.PROCESSLIST p ON p.ID=t.trx_mysql_thread_id WHERE BINARY p.DB=BINARY ?", [database]],
        ["SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE BINARY OBJECT_SCHEMA=BINARY ? OR (OBJECT_TYPE='SCHEMA' AND BINARY OBJECT_NAME=BINARY ?)", [database, database]],
        ["SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY USER=BINARY ?", [runtimeUser]],
      ] as const) { const rows = await query(statement, [...values]); expect(rows).toHaveLength(1); expect(Number(rows[0]!.n)).toBe(0); }
    });
  }
  function roles(runnerPort: number, routerPort: number) {
    if (!handle || !setupComplete || runnerPort === routerPort) return fail();
    const shared = { NODE_ENV: "test", REDIS_URL: redisUrl.toString(), REDIS_PREFIX: prefix, REDIS_NAMESPACE_ID: prefix,
      INTERNAL_ROUTER_TOKEN: INTERNAL, BLOB_STORE: "filesystem", BLOB_NAMESPACE_ID: `first-admin-${nonce}`,
      BLOB_FILESYSTEM_SINGLE_RUNNER: "1", BLOB_STORAGE_CONTROL_ENABLED: "0", BLOB_ATTACHMENTS_ENABLED: "0" };
    const runner = { ...shared, STORE: "mysql", ...handle.runtimeEnv, RUNNER_HOST: "127.0.0.1", RUNNER_PORT: String(runnerPort),
      RUNNER_ID: `first-admin-${nonce}`, RUNNER_ADDR: `127.0.0.1:${runnerPort}`, SECRETS_MASTER_KEY: MASTER,
      BLOB_DIR: join(scratch, "blobs"), BLOB_CLEANUP_ENABLED: "0" };
    return { runner, router: { ...shared, ROUTER_HOST: "127.0.0.1", ROUTER_PORT: String(routerPort), RUNNERS: `http://127.0.0.1:${runnerPort}` } };
  }
  async function configuration(name: string) {
    const directory = join(scratch, name); await mkdir(directory, { mode: 0o700 });
    const home = join(directory, "home"); await mkdir(home, { mode: 0o700 });
    const runnerPort = await port(), routerPort = await port(), selected = roles(runnerPort, routerPort);
    return { ...selected, directory, home, state: join(directory, "state"), runnerPort, routerPort,
      runnerOrigin: `http://127.0.0.1:${runnerPort}`, routerOrigin: `http://127.0.0.1:${routerPort}` };
  }
  function cleanOutput(proc: OwnedProcess) {
    const password = handle ? decodeURIComponent(new URL(handle.runtimeEnv.MYSQL_URL).password) : "";
    expect(!proc.overflow && !proc.failedSpawn && [MASTER, INTERNAL, key, password, handle?.runtimeEnv.MYSQL_URL ?? "", outputFile]
      .filter(Boolean).every(value => !proc.output.includes(value))).toBe(true);
  }
  async function privateJson(path: string, value: Record<string, string>) {
    const file = await open(path, "wx", 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  }

  beforeAll(() => {
    setupWork = (async () => {
      const timer = setTimeout(() => { fixtureFailed = true; lifetime.abort(); }, 110_000);
      try {
        ({ sql, redis: redisUrl } = targets()); appUrl = at(sql, database);
        expect(Buffer.byteLength(database.replace(/[%_]/g, "\\$&"))).toBeLessThanOrEqual(64);
        scratch = await realpath(await mkdtemp(join(tmpdir(), "agent-first-admin-external-"))); await chmod(scratch, 0o700);
        await mkdir(join(scratch, "blobs"), { mode: 0o700 }); outputFile = join(scratch, "first-admin-key");
        const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl: appUrl, applicationDatabase: database, operationAbortSignal: lifetime.signal });
        await native(at(sql, "mysql"), lifetime.signal, async query => { await query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`); created = true; });
        handle = await prepareMysqlRuntimeFixture(witness, { schemaExecutor: createMysqlSchemaCliExecutor({
          entrypoint: join(ROOT, "apps/agent-runner/src/main.ts"), mode: "source", cwd: ROOT }) });
        uuid = handle.serverUuid; runtimeUser = decodeURIComponent(new URL(handle.runtimeEnv.MYSQL_URL).username);
        redis = new Redis(redisUrl.toString(), { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null,
          connectionName: `first-admin-${nonce}`, commandTimeout: 5_000, connectTimeout: 5_000 });
        redis.on("error", () => { fixtureFailed = true; });
        lifetime.signal.addEventListener("abort", () => { redis?.disconnect(); redisSocket?.destroy(); }, { once: true });
        redis.on("connect", () => { redisSocket = redis!.stream; redisClosed = redisSocket.closed ? Promise.resolve() : new Promise<void>(done => redisSocket!.once("close", () => done()));
          if (lifetime.signal.aborted) { redis!.disconnect(); redisSocket.destroy(); } });
        await redis.connect(); if (!redisSocket || !redisClosed) return fail(); expect(await redis.ping()).toBe("PONG");
        expect(await ownedKeys(redis, prefix)).toEqual([]); expect(await redis.set(guard, nonce, "NX")).toBe("OK");
        await noConsumers(lifetime.signal); setupComplete = true;
      } catch (error) { fixtureFailed = true; throw error; } finally { clearTimeout(timer); }
    })(); return setupWork;
  }, 120_000);

  it("writes a protected one-line admin key in the ordinary runner and proves real admin authentication", context => serial(async () => {
    let proc: OwnedProcess | undefined;
    const cancel = () => { fixtureFailed = true; if (proc && !proc.closeSeen) { try { terminate(proc); } catch { /* Await failure-only rescue. */ } } };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      context.signal.throwIfAborted(); const config = await configuration("first-start"); context.signal.throwIfAborted();
      proc = launch(process.execPath, ["--import", "tsx", "apps/agent-runner/src/main.ts"], { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: config.home, TMPDIR: tmpdir(), ...config.runner, ADMIN_BOOTSTRAP_TENANT: TENANT, ADMIN_BOOTSTRAP_OUTPUT_FILE: outputFile });
      processes.add(proc); await ready(config.runnerOrigin, proc, context.signal, "ready");
      originalKey = await protectedKey(outputFile); key = originalKey.key;
      expect(await adminStatus(config.runnerOrigin, undefined, context.signal)).toBe(401);
      expect(await adminStatus(config.runnerOrigin, "not-the-owned-admin-key", context.signal)).toBe(401);
      expect(await adminStatus(config.runnerOrigin, key, context.signal)).toBe(200);
      expect(proc.output.includes('"code":"runner.bootstrap.admin_key_written"')).toBe(true); cleanOutput(proc);
      await stop(proc, context.signal); expect(proc.exit).toEqual({ code: 0, signal: null }); expect(proc.forced).toBe(false);
      expect(await portClosed(config.runnerPort)).toBe(true); await noConsumers(context.signal);
      const cold = await MysqlSessionStore.connect({ ...handle!.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: context.signal });
      try { const keys = await cold.listApiKeys(TENANT); expect(keys).toHaveLength(1); expect(keys[0]!.scopes).toEqual(["runtime", "admin"]);
        expect(await cold.resolveApiKey(hashApiKey(key))).toMatchObject({ tenantId: TENANT, scopes: ["runtime", "admin"] }); }
      finally { await cold.close(); }
      await noConsumers(context.signal); expect(await redis!.get(guard)).toBe(nonce); cleanOutput(proc); passed++;
    } catch (error) { fixtureFailed = true; throw error; }
    finally { context.signal.removeEventListener("abort", cancel); try { if (proc) await rescue(proc); } catch (error) { fixtureFailed = true; throw error; } }
  }), 45_000);

  it("removes the admin pair and cold-restarts both real roles with the same protected key and stable Blob root", context => serial(async () => {
    let proc: OwnedProcess | undefined;
    const cancel = () => { fixtureFailed = true; if (proc && !proc.closeSeen) { try { terminate(proc); } catch { /* Await failure-only rescue. */ } } };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      context.signal.throwIfAborted(); if (!originalKey || !key) return fail(); const config = await configuration("external-restart");
      const beforeBlob = await lstat(config.runner.BLOB_DIR), runnerPath = join(config.directory, "runner.json"), routerPath = join(config.directory, "router.json");
      expect(Object.keys(config.runner).some(name => /^(?:ADMIN_)?BOOTSTRAP_/.test(name))).toBe(false);
      await privateJson(runnerPath, config.runner); await privateJson(routerPath, config.router); context.signal.throwIfAborted();
      proc = launch("/bin/bash", [join(ROOT, "scripts/local-service.sh"), "--external-infra", "run", "--runner-env", runnerPath, "--router-env", routerPath, "--state-dir", config.state],
        { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir() });
      processes.add(proc); await ready(config.runnerOrigin, proc, context.signal, "ready"); await ready(config.routerOrigin, proc, context.signal, "ready (1 runners)");
      expect(await adminStatus(config.routerOrigin, key, context.signal)).toBe(200); expect(await adminStatus(config.routerOrigin, undefined, context.signal)).toBe(401);
      await stop(proc, context.signal); expect(proc.exit).toEqual({ code: 143, signal: null }); expect(proc.forced).toBe(false); cleanOutput(proc);
      expect(await portClosed(config.runnerPort)).toBe(true); expect(await portClosed(config.routerPort)).toBe(true); await noConsumers(context.signal);
      const currentKey = await protectedKey(outputFile); expect(currentKey.sha256 === originalKey.sha256 && currentKey.dev === originalKey.dev && currentKey.ino === originalKey.ino).toBe(true);
      const afterBlob = await lstat(config.runner.BLOB_DIR); expect([afterBlob.dev, afterBlob.ino]).toEqual([beforeBlob.dev, beforeBlob.ino]);
      for (const name of ["runner.log", "router.log"]) {
        const path = join(config.state, name), stat = await lstat(path);
        expect(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.size <= 65_536).toBe(true);
        const log = await readFile(path, "utf8");
        expect([key, MASTER, INTERNAL, handle!.runtimeEnv.MYSQL_URL, decodeURIComponent(new URL(handle!.runtimeEnv.MYSQL_URL).password)]
          .every(value => !log.includes(value))).toBe(true);
        expect(log.includes('"code":"runner.bootstrap.admin_key_written"')).toBe(false);
      }
      const cold = await MysqlSessionStore.connect({ ...handle!.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: context.signal });
      try { expect(await cold.listApiKeys(TENANT)).toHaveLength(1); expect(await cold.resolveApiKey(hashApiKey(key))).toMatchObject({ tenantId: TENANT }); }
      finally { await cold.close(); }
      await noConsumers(context.signal); expect(await redis!.get(guard)).toBe(nonce); passed++;
    } catch (error) { fixtureFailed = true; throw error; }
    finally { context.signal.removeEventListener("abort", cancel); try { if (proc) await rescue(proc); } catch (error) { fixtureFailed = true; throw error; } }
  }), 45_000);

  it("retains an existing output file on real create-only startup refusal without creating another tenant admin", context => serial(async () => {
    let proc: OwnedProcess | undefined;
    const cancel = () => { fixtureFailed = true; if (proc && !proc.closeSeen) { try { terminate(proc); } catch { /* Await failure-only rescue. */ } } };
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      context.signal.throwIfAborted(); const config = await configuration("existing-file-refusal"), occupied = join(config.directory, "reserved-admin-key");
      const file = await open(occupied, "wx", 0o600); try { await file.writeFile("owned-existing-output-retain\n"); await file.sync(); } finally { await file.close(); }
      const before = await lstat(occupied), beforeHash = sha(await readFile(occupied)), blob = await lstat(config.runner.BLOB_DIR);
      context.signal.throwIfAborted(); proc = launch(process.execPath, ["--import", "tsx", "apps/agent-runner/src/main.ts"], {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: config.home, TMPDIR: tmpdir(), ...config.runner,
        ADMIN_BOOTSTRAP_TENANT: REFUSED_TENANT, ADMIN_BOOTSTRAP_OUTPUT_FILE: occupied });
      processes.add(proc); await until(() => proc!.closeSeen && !groupAlive(proc!), context.signal, 15_000); await proc.closed;
      expect(proc.exit).toEqual({ code: 1, signal: null }); expect(proc.forced || proc.failedSpawn || proc.overflow).toBe(false);
      expect(proc.output.includes('"code":"runner.bootstrap.admin_key_output_rejected"')).toBe(true); cleanOutput(proc);
      expect(!proc.output.includes(occupied) && !proc.output.includes("owned-existing-output-retain")).toBe(true);
      const after = await lstat(occupied); expect([after.dev, after.ino, after.size, after.mode]).toEqual([before.dev, before.ino, before.size, before.mode]);
      expect(sha(await readFile(occupied))).toBe(beforeHash); expect(await portClosed(config.runnerPort)).toBe(true); await noConsumers(context.signal);
      const cold = await MysqlSessionStore.connect({ ...handle!.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: context.signal });
      try { expect(await cold.listApiKeys(REFUSED_TENANT)).toEqual([]); expect(await cold.listApiKeys(TENANT)).toHaveLength(1); }
      finally { await cold.close(); }
      await noConsumers(context.signal); expect(await redis!.get(guard)).toBe(nonce);
      const afterBlob = await lstat(config.runner.BLOB_DIR); expect([afterBlob.dev, afterBlob.ino]).toEqual([blob.dev, blob.ino]);
      expect((await lstat(config.directory)).mode & 0o777).toBe(0o700); passed++;
      // This proves an existing-file refusal, not a new-file-then-DB-failure or fsync syscall trace.
    } catch (error) { fixtureFailed = true; throw error; }
    finally { context.signal.removeEventListener("abort", cancel); try { if (proc) await rescue(proc); } catch (error) { fixtureFailed = true; throw error; } }
  }), 45_000);

  afterAll(async () => {
    const timer = setTimeout(() => { fixtureFailed = true; lifetime.abort(); }, 50_000);
    let cleaned = false, closedRedis = redis === undefined, cleanupFailed = false, cleanupError: unknown;
    const remember = (error: unknown) => { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } };
    try {
      await setupWork?.catch(() => { fixtureFailed = true; }); await caseWork?.catch(() => { fixtureFailed = true; });
      for (const proc of processes) { await rescue(proc); if (proc.forced || proc.failedSpawn || proc.overflow || !proc.closeSeen || groupAlive(proc)) fixtureFailed = true; }
      let successful = setupComplete && passed === 3 && !fixtureFailed && !lifetime.signal.aborted;
      if (successful) await noConsumers(lifetime.signal); successful = successful && !fixtureFailed && !lifetime.signal.aborted;
      await handle?.close({ successful });
      if (successful && created) {
        const keys = await ownedKeys(redis!, prefix); if (keys.length) await redis!.del(...keys); expect(await ownedKeys(redis!, prefix)).toEqual([]);
        expect(await redis!.get(guard)).toBe(nonce); expect(await redis!.del(guard)).toBe(1); await noConsumers(lifetime.signal);
        await native(at(sql, "mysql"), lifetime.signal, async query => {
          expect((await query("SELECT @@server_uuid AS uuid"))[0]!.uuid).toBe(uuid);
          if (fixtureFailed || lifetime.signal.aborted || !/^agent_adm_test_[a-f0-9]{20}$/.test(database)) fail();
          await query(`DROP DATABASE \`${database}\``);
          expect(await query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).toEqual([]);
        }); created = false; cleaned = true;
      }
    } catch (error) { remember(error);
    } finally {
      try {
        if (redis) {
          const client = redis, end = new Promise<void>(done => { if (client.status === "end") done(); else client.once("end", done); });
          const socket = redisSocket ?? client.stream, actualClose = redisClosed ?? (socket && !socket.closed ? new Promise<void>(done => socket.once("close", () => done())) : Promise.resolve());
          try { if (client.status !== "end") await client.quit(); } catch (error) { remember(error); }
          finally { try { client.disconnect(); } catch (error) { remember(error); } socket?.destroy(); await end; await actualClose; }
          closedRedis = true;
        }
      } catch (error) { remember(error);
      } finally {
        clearTimeout(timer); lifetime.abort();
        if (cleaned && closedRedis && !fixtureFailed && !cleanupFailed) { try { await rm(scratch, { recursive: true, force: true }); } catch (error) { remember(error); } }
        if ((!cleaned || !closedRedis || fixtureFailed || cleanupFailed) && scratch) {
          try { console.warn(JSON.stringify({ schema: "first-admin-external-fixture-retained-v1", directory: scratch, successful: false,
            cleanupComplete: false, resourcesRetainedOrUnknown: true })); } catch { /* Do not replace the original failure. */ }
        }
      }
    }
    if (cleanupFailed) throw cleanupError;
    if (passed === 3 && (!cleaned || !closedRedis || fixtureFailed)) fail();
  });
});
