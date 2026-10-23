import { randomBytes, randomUUID } from "node:crypto";
import { createConnection as createSocket, type Socket } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import mysql, { type Connection, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { Redis } from "ioredis";
import { describe, expect, it, vi, type TestContext } from "vitest";
import type { Session } from "@agent-service/protocol";
import {
  MysqlSessionStore, SessionAuthorityConflictError, SessionAuthorityError,
  attachSessionWriteAdmission, createSessionAcquireCommand, redisSessionKeys,
  type CommitBatch, type SessionAcquireCommand, type SessionAcquireResult, type SessionLeaseProof,
} from "../src/index.js";
import { mkSession } from "./conformance.js";
import { createMysqlSchemaCliExecutor } from "../../../test/fixtures/mysql-schema-cli.mjs";
import { createMysqlAuthorityCliExecutor } from "../../../test/fixtures/mysql-authority-cli.mjs";
import { prepareMysqlRuntimeFixture, witnessAbsentMysqlFixtureDatabase } from "../../../test/fixtures/mysql-runtime.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SOURCE_MAIN = fileURLToPath(new URL("../../../apps/agent-runner/src/main.ts", import.meta.url));
const schemaExecutor = createMysqlSchemaCliExecutor({ entrypoint: SOURCE_MAIN, mode: "source", cwd: ROOT });
const authorityExecutor = createMysqlAuthorityCliExecutor({ entrypoint: SOURCE_MAIN, mode: "source", cwd: ROOT });
const suite = process.env.AGENT_SERVICE_INTEGRATION ? describe : describe.skip;
type Grant = Extract<SessionAcquireResult, { ok: true }>;
type Rows = Record<string, unknown>[];
const TABLES = [
  ["sessions", "session_id"], ["events", "session_id,seq"], ["items", "item_id"], ["turns", "turn_id"],
  ["approvals", "approval_id"], ["usage_ledger", "id"], ["billing_usage_facts", "usage_id"],
  ["subagent_root_turns", "root_key"], ["subagent_tasks", "task_id"], ["subagent_budget_entries", "entry_id"],
] as const;

function baseUrl(name: "MYSQL_TEST_URL" | "REDIS_TEST_URL"): URL {
  let url: URL;
  try { url = new URL(process.env[name] ?? ""); } catch { throw Error("Authority integration needs explicit loopback test URLs"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search || url.hash
    || name === "MYSQL_TEST_URL" && (url.protocol !== "mysql:" || !url.username || !/^[A-Za-z0-9_]+$/.test(url.pathname.slice(1))
      || !/(?:^|_)test(?:_|$)/i.test(url.pathname.slice(1)))
    || name === "REDIS_TEST_URL" && (url.protocol !== "redis:" || !/^\/(?:[0-9]|1[0-5])$/.test(url.pathname))) {
    throw Error("Authority fixture target is not an explicit loopback test database");
  }
  return url;
}
function at(base: URL, database: string): string { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); }
function actualPool(store: MysqlSessionStore): Pool {
  const pool: unknown = Reflect.get(store, "pool");
  if (!pool || typeof (pool as Pool).getConnection !== "function") throw Error("Actual runtime pool unavailable");
  return pool as Pool;
}
function grant(result: SessionAcquireResult): Grant { expect(result.ok).toBe(true); if (!result.ok) throw Error("Fixture acquire was not confirmed"); return result; }
function command(session: Session, expectedFence: number, options: { runnerId?: string; bootId?: string; ttlMs?: number } = {}): SessionAcquireCommand {
  return createSessionAcquireCommand({ sessionId: session.id, principal: { tenantId: session.tenantId, userId: session.userId },
    runnerId: options.runnerId ?? "authority-native-a", runnerAddr: "http://127.0.0.1:10001", bootId: options.bootId ?? randomUUID(),
    acquisitionId: randomUUID(), expectedFence, ttlMs: options.ttlMs ?? 2_000 });
}
function batch(session: Session, fence: number, title = "native authority fixture"): CommitBatch {
  return { sessionId: session.id, fence, expectedLastSeq: 1, sessionPatch: { title },
    events: [{ type: "warning", sessionId: session.id, emittedAtMs: 1, code: "authority_fixture", message: title }] };
}
function admit<T extends object>(body: T, proof: SessionLeaseProof): T { return attachSessionWriteAdmission(body, proof); }
function nativeSocket(conn: PoolConnection): Socket {
  const raw: unknown = Reflect.get(conn, "connection");
  const stream: unknown = raw && typeof raw === "object" ? Reflect.get(raw, "stream") : undefined;
  if (!stream || typeof (stream as Socket).once !== "function" || typeof (stream as Socket).destroy !== "function") {
    throw Error("Actual mysql2 native socket unavailable");
  }
  return stream as Socket;
}
async function rows(conn: Connection | PoolConnection, sql: string, values: readonly unknown[] = []): Promise<Rows> {
  const [result] = await conn.query<RowDataPacket[]>({ sql, timeout: 5_000 }, [...values]); return result;
}
async function dbNow(conn: Connection | PoolConnection): Promise<number> {
  const result = await rows(conn, "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS now_ms");
  const now = Number(result[0]?.now_ms); if (result.length !== 1 || !Number.isSafeInteger(now) || now < 1) throw Error("Native DB time unavailable"); return now;
}
async function snapshot(conn: Connection | PoolConnection, database?: string): Promise<Record<string, Rows>> {
  const result: Record<string, Rows> = {};
  for (const [name, order] of TABLES) result[name] = await rows(conn,
    `SELECT * FROM ${database ? `${mysql.escapeId(database)}.` : ""}${mysql.escapeId(name)} ORDER BY ${order}`);
  return result;
}
function withoutLease(snapshotValue: Record<string, Rows>): Record<string, Rows> {
  return { ...snapshotValue, sessions: snapshotValue.sessions!.map(row => Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== "fence_token" && !key.startsWith("authority_")))) };
}

/** Track the actual standalone connector before its deferred first socket exists. */
function ownRedisSockets(client: Redis, signal: AbortSignal): { close(): Promise<void> } {
  const connector: unknown = Reflect.get(client, "connector");
  if (!connector || typeof connector !== "object" || typeof Reflect.get(connector, "connect") !== "function") throw Error("Actual Redis connector unavailable");
  const sockets = new Set<Socket>(), closes = new Set<Promise<void>>();
  let current: unknown = Reflect.get(connector, "stream"), stopping = false, closing: Promise<void> | undefined, opened = 0, closed = 0;
  const track = (value: unknown) => {
    if (!value || sockets.has(value as Socket)) return;
    const socket = value as Socket; if (typeof socket.once !== "function" || typeof socket.destroy !== "function") throw Error("Actual Redis socket unavailable");
    opened += 1; sockets.add(socket);
    const done = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => resolve()));
    closes.add(done); void done.then(() => { sockets.delete(socket); closes.delete(done); closed += 1; });
    if (stopping || signal.aborted) queueMicrotask(() => socket.destroy());
  };
  Object.defineProperty(connector, "stream", { configurable: true, enumerable: true, get: () => current,
    set: (socket: unknown) => { current = socket; track(socket); } }); track(current);
  const destroy = () => { client.disconnect(false); for (const socket of sockets) socket.destroy(); };
  signal.addEventListener("abort", destroy, { once: true });
  return { close: () => closing ??= (async () => {
    stopping = true; const end = client.status === "end" ? Promise.resolve() : new Promise<void>(resolve => client.once("end", () => resolve()));
    try { destroy(); await end; while (closes.size) await Promise.all([...closes]); expect(closed).toBe(opened); }
    finally { signal.removeEventListener("abort", destroy); }
  })() };
}

interface Fixture {
  readonly database: string; readonly uuid: string; readonly signal: AbortSignal; readonly admin: Connection;
  readonly a: MysqlSessionStore; readonly b: MysqlSessionStore; readonly session: Session;
  openRuntime(): Promise<MysqlSessionStore>;
  coldSnapshot(): Promise<Record<string, Rows>>;
  destroyAdmin(): void;
}

// Private to this suite: every case pays for its own schema, native CLI activation and cleanup.
// There is no hook preparation, shared mutable DB, arbitrary SQL-success mock or numeric proof map.
async function withFixture(context: TestContext, work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = baseUrl("MYSQL_TEST_URL"), database = `agent_service_test_authority_${randomBytes(10).toString("hex")}`;
  const signal = context.signal, sockets = new Set<Socket>(), closes = new Set<Promise<void>>(), stores: MysqlSessionStore[] = [];
  let admin: Connection | undefined, runtime: Awaited<ReturnType<typeof prepareMysqlRuntimeFixture>> | undefined;
  let uuid = "", createAttempted = false, created = false, passed = false, failed = false, firstError: unknown;
  const remember = (error: unknown) => { if (!failed) { failed = true; firstError = error; } };
  const active = () => { signal.throwIfAborted(); };
  const destroy = () => { try { admin?.destroy(); } catch { /* first error is retained by the owning work */ } for (const socket of sockets) socket.destroy(); };
  const stream = ({ config }: { config: { host: string; port: number; socketPath?: string } }): Socket => {
    active(); const socket = config.socketPath ? createSocket(config.socketPath) : createSocket(config.port, config.host);
    sockets.add(socket); const closed = new Promise<void>(resolve => socket.once("close", () => resolve())); closes.add(closed);
    void closed.then(() => { sockets.delete(socket); closes.delete(closed); });
    if (signal.aborted) queueMicrotask(() => socket.destroy()); return socket;
  };
  signal.addEventListener("abort", destroy, { once: true });
  try {
    active(); admin = await mysql.createConnection({ uri: at(base, "mysql"), connectTimeout: 5_000, stream }); active();
    const identity = await rows(admin, "SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
    if (identity.length !== 1 || identity[0]!.db !== "mysql" || typeof identity[0]!.uuid !== "string"
      || !/^[a-f0-9-]{36}$/i.test(identity[0]!.uuid)) throw Error("Authority fixture server identity unavailable");
    uuid = identity[0]!.uuid;
    const operatorUrl = at(base, database);
    const witness = await witnessAbsentMysqlFixtureDatabase({ operatorUrl, applicationDatabase: database, operationAbortSignal: signal });
    active(); createAttempted = true; await admin.query({ sql: `CREATE DATABASE ${mysql.escapeId(database)} CHARACTER SET utf8mb4`, timeout: 5_000 }); created = true;
    runtime = await prepareMysqlRuntimeFixture(witness, { schemaExecutor, authorityExecutor }); active();
    expect(runtime.serverUuid).toBe(uuid); expect(runtime.database).toBe(database);
    const openRuntime = async () => {
      active(); const store = await MysqlSessionStore.connect({ ...runtime!.runtimeStoreOptions, connectionLimit: 1, operationAbortSignal: signal });
      stores.push(store); active();
      const conn = await actualPool(store).getConnection();
      try {
        const info = await rows(conn, "SELECT CONNECTION_ID() AS id,CURRENT_USER() AS account,@@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
        expect(info).toHaveLength(1); expect(info[0]).toMatchObject({ uuid, db: database });
        expect(String(info[0]!.account)).not.toBe(`${decodeURIComponent(base.username)}@${base.hostname}`);
        expect(String(info[0]!.account)).toMatch(/^mrt_r_[a-f0-9]+@/);
      } finally { conn.release(); }
      return store;
    };
    const a = await openRuntime(), b = await openRuntime(), session = mkSession("authority_native_tenant", "authority_native_user");
    const ca = await actualPool(a).getConnection();
    try {
      const cb = await actualPool(b).getConnection();
      try { expect((await rows(ca, "SELECT CONNECTION_ID() AS id"))[0]!.id).not.toBe((await rows(cb, "SELECT CONNECTION_ID() AS id"))[0]!.id); }
      finally { cb.release(); }
    } finally { ca.release(); }
    await a.createSession(session);
    const coldSnapshot = async () => {
      const cold = await openRuntime();
      try {
        expect(await cold.getSession(session.tenantId, session.id)).toMatchObject({ id: session.id, tenantId: session.tenantId, userId: session.userId });
        expect(await cold.listItems(session.id, { limit: 100 })).toEqual([]);
        const events = await cold.readEvents(session.id, 0, 100); expect(events[0]).toMatchObject({ type: "session/created", seq: 1 });
        const conn = await actualPool(cold).getConnection(); try { return await snapshot(conn); } finally { conn.release(); }
      } finally { await cold.close(); }
    };
    await work({ database, uuid, signal, admin, a, b, session, openRuntime, coldSnapshot, destroyAdmin: destroy }); active(); passed = true;
  } catch (error) { remember(error); }
  finally {
    const settled = await Promise.allSettled(stores.map(store => store.close()));
    for (const result of settled) if (result.status === "rejected") remember(result.reason);
    if (runtime) try { await runtime.close({ successful: passed && !failed && !signal.aborted }); } catch (error) { remember(error); }
    if (passed && !failed && created && admin && !signal.aborted) {
      try {
        const identity = await rows(admin, "SELECT @@GLOBAL.server_uuid AS uuid,DATABASE() AS db");
        expect(identity).toEqual([expect.objectContaining({ uuid, db: "mysql" })]);
        const clients = await rows(admin, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE BINARY DB=BINARY ?", [database]);
        expect(Number(clients[0]!.n)).toBe(0);
        await admin.query({ sql: `DROP DATABASE ${mysql.escapeId(database)}`, timeout: 5_000 });
        expect(await rows(admin, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE BINARY SCHEMA_NAME=BINARY ?", [database])).toEqual([]);
      } catch (error) { remember(error); }
    }
    try { await admin?.end(); } catch (error) { remember(error); }
    finally {
      for (const socket of sockets) socket.destroy(); while (closes.size) await Promise.all([...closes]);
      signal.removeEventListener("abort", destroy);
    }
    if ((!passed || failed) && createAttempted) console.warn(JSON.stringify({ schema: "mysql-session-authority-retained-v1", database, serverUuid: uuid, createConfirmed: created }));
  }
  if (failed) throw firstError;
}

suite("single MySQL live session authority native substrate", () => {
  it("serializes two independent runtime owners and rejects equal numeric tokens without a genuine admission", async context => {
    await withFixture(context, async f => {
      const commands = [command(f.session, 0), command(f.session, 0, { runnerId: "authority-native-b" })];
      const results = await Promise.all([f.a.sessionAuthority.acquire(commands[0]!), f.b.sessionAuthority.acquire(commands[1]!)]);
      expect(results.filter(result => result.ok)).toHaveLength(1); expect(results.filter(result => !result.ok)).toHaveLength(1);
      const winner = grant(results.find(result => result.ok)!); expect(winner.fence).toBe(1);
      const before = await snapshot(f.admin, f.database);
      await expect(f.b.commit(batch(f.session, winner.fence))).rejects.toBeInstanceOf(SessionAuthorityError);
      expect(await snapshot(f.admin, f.database)).toEqual(before);
      expect(await f.coldSnapshot()).toEqual(before);
    });
  });

  it("confirms the exact original command from a second pool without extending expiry or changing durable rows", async context => {
    await withFixture(context, async f => {
      const fixed = command(f.session, 0), a = grant(await f.a.sessionAuthority.acquire(fixed)), before = await snapshot(f.admin, f.database);
      const b = grant(await f.b.sessionAuthority.confirm(fixed)); expect(b.fence).toBe(a.fence); expect(b.proof).not.toBe(a.proof);
      expect(await snapshot(f.admin, f.database)).toEqual(before);
      const owner = await f.b.sessionAuthority.getOwner(f.session.id);
      expect(owner).toMatchObject({ fence: 1, expiresAtDbMs: Number(before.sessions![0]!.authority_expires_at_db_ms) });
    });
  });

  it("uses natural DB-time expiry and fences late renew release and writes from the old boot of the same runner", async context => {
    await withFixture(context, async f => {
      const old = grant(await f.a.sessionAuthority.acquire(command(f.session, 0, { runnerId: "same-runner", ttlMs: 100 })));
      const current = (await snapshot(f.admin, f.database)).sessions![0]!;
      while (await dbNow(f.admin) <= Number(current.authority_expires_at_db_ms)) await delay(5, undefined, { signal: f.signal });
      const newer = grant(await f.b.sessionAuthority.acquire(command(f.session, 1, { runnerId: "same-runner" })));
      expect(newer.fence).toBe(2); const before = await snapshot(f.admin, f.database);
      expect(await f.a.sessionAuthority.renew(old.proof, 100)).toBe(false); await f.a.sessionAuthority.release(old.proof);
      await expect(f.a.commit(admit(batch(f.session, old.fence), old.proof))).rejects.toBeInstanceOf(SessionAuthorityConflictError);
      expect(await snapshot(f.admin, f.database)).toEqual(before);
    });
  });

  it("keeps same-runner new boots busy and never revives a released command or refreshes a stale predecessor", async context => {
    await withFixture(context, async f => {
      const fixed = command(f.session, 0, { runnerId: "same-runner" }), old = grant(await f.a.sessionAuthority.acquire(fixed));
      expect(await f.b.sessionAuthority.acquire(command(f.session, 1, { runnerId: "same-runner" }))).toMatchObject({ ok: false, reason: "busy" });
      await f.a.sessionAuthority.release(old.proof); const released = await snapshot(f.admin, f.database);
      expect(await f.b.sessionAuthority.confirm(fixed)).toMatchObject({ ok: false, reason: "lost" });
      expect(await f.b.sessionAuthority.acquire(command(f.session, 0))).toMatchObject({ ok: false, reason: "stale" });
      expect(await snapshot(f.admin, f.database)).toEqual(released);
      const newer = grant(await f.b.sessionAuthority.acquire(command(f.session, 1))); expect(newer.fence).toBe(2);
      const before = await snapshot(f.admin, f.database); await f.a.sessionAuthority.release(old.proof);
      expect(await f.a.sessionAuthority.renew(old.proof, 100)).toBe(false); expect(await snapshot(f.admin, f.database)).toEqual(before);
    });
  });

  it("keeps the MySQL tuple authoritative when only fresh owned Redis lease and counter keys are deleted", async context => {
    await withFixture(context, async f => {
      const prefix = `authority-native-${randomBytes(10).toString("hex")}`, keys = redisSessionKeys(f.session.id, prefix);
      const redis = new Redis(baseUrl("REDIS_TEST_URL").toString(), { lazyConnect: true, enableOfflineQueue: false,
        connectTimeout: 2_000, commandTimeout: 2_000, maxRetriesPerRequest: 0, retryStrategy: () => null });
      redis.on("error", () => {});
      const nativeOwner = ownRedisSockets(redis, f.signal);
      let ownedLease = false, ownedFence = false;
      let failed = false, firstError: unknown;
      const remember = (error: unknown) => { if (!failed) { failed = true; firstError = error; } };
      try {
        f.signal.throwIfAborted();
        await redis.connect();
        expect(await redis.exists(keys.lease, keys.fence)).toBe(0);
        const a = grant(await f.a.sessionAuthority.acquire(command(f.session, 0))), before = await snapshot(f.admin, f.database);
        ownedLease = await redis.set(keys.lease, "fixture-lease", "NX") === "OK"; expect(ownedLease).toBe(true);
        ownedFence = await redis.set(keys.fence, "1", "NX") === "OK"; expect(ownedFence).toBe(true);
        expect(await redis.del(keys.lease, keys.fence)).toBe(2); expect(await redis.exists(keys.lease, keys.fence)).toBe(0);
        expect(await snapshot(f.admin, f.database)).toEqual(before);
        expect(await f.b.sessionAuthority.acquire(command(f.session, 1, { runnerId: "redis-loss-b" }))).toMatchObject({ ok: false, reason: "busy" });
        expect(await f.a.sessionAuthority.renew(a.proof, 2_000)).toBe(true);
      } catch (error) { remember(error); }
      finally {
        try {
          const confirmedOwned = [...(ownedLease ? [keys.lease] : []), ...(ownedFence ? [keys.fence] : [])];
          if (redis.status === "ready" && confirmedOwned.length) await redis.del(...confirmedOwned);
        } catch (error) { remember(error); }
        try { await nativeOwner.close(); } catch (error) { remember(error); }
      }
      if (failed) throw firstError;
    });
  });

  it("returns no proof after a real successful COMMIT response is lost and confirms only the original command", async context => {
    await withFixture(context, async f => {
      const pool = actualPool(f.a), originalGet = pool.getConnection.bind(pool), before = await snapshot(f.admin, f.database);
      const fixed = command(f.session, 0), lost = Error("fixture response lost after native commit");
      let committed = false, commitSpy: ReturnType<typeof vi.spyOn> | undefined;
      const borrow = vi.spyOn(pool, "getConnection").mockImplementation(async () => {
        const conn = await originalGet(); const commit = conn.commit.bind(conn);
        commitSpy = vi.spyOn(conn, "commit").mockImplementationOnce(async () => { await commit(); committed = true; throw lost; }); return conn;
      });
      try { await expect(f.a.sessionAuthority.acquire(fixed)).rejects.toBe(lost); }
      finally { borrow.mockRestore(); commitSpy?.mockRestore(); }
      expect(committed).toBe(true); const unknown = await snapshot(f.admin, f.database);
      expect(Number(unknown.sessions![0]!.fence_token)).toBe(1); expect(withoutLease(unknown)).toEqual(withoutLease(before));
      const confirmed = grant(await f.b.sessionAuthority.confirm(fixed)); expect(confirmed.fence).toBe(1);
      expect(await snapshot(f.admin, f.database)).toEqual(unknown); expect(await f.coldSnapshot()).toEqual(unknown);
      expect(await f.b.sessionAuthority.confirm(command(f.session, 0))).toMatchObject({ ok: false, reason: "lost" });
    });
  });

  it("destroys and never releases a real uncommitted transaction after rollback rejects without sending ROLLBACK", async context => {
    await withFixture(context, async f => {
      const before = await snapshot(f.admin, f.database), pool = actualPool(f.a), originalGet = pool.getConnection.bind(pool);
      const failure = undefined, rollbackFailure = Error("fixture rollback not sent");
      let actualId = 0, preventedCommit = false, sawUncommittedFence = false, observedActiveTransaction = false, nativeClosed: Promise<void> | undefined;
      let closed = false;
      const spies: { mockRestore(): void }[] = []; let rollbackSpy: ReturnType<typeof vi.spyOn> | undefined;
      let destroySpy: ReturnType<typeof vi.spyOn> | undefined, releaseSpy: ReturnType<typeof vi.spyOn> | undefined;
      const borrow = vi.spyOn(pool, "getConnection").mockImplementation(async () => {
        const conn = await originalGet(), socket = nativeSocket(conn);
        actualId = Number((await rows(conn, "SELECT CONNECTION_ID() AS id"))[0]!.id);
        nativeClosed = socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once("close", () => { closed = true; resolve(); }));
        spies.push(vi.spyOn(conn, "commit").mockImplementationOnce(async () => {
          // This selected native method is deliberately never invoked. Every earlier
          // guard/query/UPDATE was real; the connection is still in its real TX.
          preventedCommit = true;
          sawUncommittedFence = Number((await rows(conn, "SELECT fence_token FROM sessions WHERE session_id=?", [f.session.id]))[0]!.fence_token) === 1;
          do {
            f.signal.throwIfAborted();
            observedActiveTransaction = Number((await rows(f.admin,
              "SELECT COUNT(*) AS n FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id=?", [actualId]))[0]!.n) === 1;
            if (!observedActiveTransaction) await delay(5, undefined, { signal: f.signal });
          } while (!observedActiveTransaction);
          throw failure;
        }));
        rollbackSpy = vi.spyOn(conn, "rollback").mockImplementationOnce(async () => { throw rollbackFailure; }); spies.push(rollbackSpy);
        destroySpy = vi.spyOn(conn, "destroy"); spies.push(destroySpy);
        releaseSpy = vi.spyOn(conn, "release"); spies.push(releaseSpy); return conn;
      });
      try {
        await expect(f.a.sessionAuthority.acquire(command(f.session, 0))).rejects.toBe(failure);
        expect(preventedCommit).toBe(true); expect(sawUncommittedFence).toBe(true); expect(observedActiveTransaction).toBe(true);
        expect(rollbackSpy).toHaveBeenCalledOnce(); expect(destroySpy).toHaveBeenCalledOnce(); expect(releaseSpy).not.toHaveBeenCalled();
        await f.a.close(); await nativeClosed; expect(closed).toBe(true);
      } finally { borrow.mockRestore(); for (const spy of spies) spy.mockRestore(); }
      expect(await snapshot(f.admin, f.database)).toEqual(before);
      const cold = await f.openRuntime(), conn = await actualPool(cold).getConnection();
      try { expect(Number((await rows(conn, "SELECT CONNECTION_ID() AS id"))[0]!.id)).not.toBe(actualId); expect(await snapshot(conn)).toEqual(before); }
      finally { conn.release(); await cold.close(); }
    });
  });

  it("resets a prior connection timestamp override on its next actual guarded checkout", async context => {
    await withFixture(context, async f => {
      const pool = actualPool(f.a), first = await pool.getConnection(); let id = 0;
      try { id = Number((await rows(first, "SELECT CONNECTION_ID() AS id"))[0]!.id); await first.query("SET SESSION timestamp=1000000000"); }
      finally { first.release(); }
      const before = await dbNow(f.admin), next = await pool.getConnection();
      try {
        expect(Number((await rows(next, "SELECT CONNECTION_ID() AS id"))[0]!.id)).toBe(id);
        const actual = await dbNow(next), after = await dbNow(f.admin); expect(actual).toBeGreaterThanOrEqual(before); expect(actual).toBeLessThanOrEqual(after);
        expect(actual).toBeGreaterThan(1_000_000_000_000);
      } finally { next.release(); }
    });
  });

  it("rejects a changed genuinely admitted body without mutation and permits a fresh unchanged body", async context => {
    await withFixture(context, async f => {
      const a = grant(await f.a.sessionAuthority.acquire(command(f.session, 0))), changed = admit(batch(f.session, a.fence), a.proof);
      const before = await snapshot(f.admin, f.database); changed.sessionPatch!.title = "changed after admission";
      expect(() => attachSessionWriteAdmission(changed, a.proof)).toThrow(SessionAuthorityError);
      await expect(f.a.commit(changed)).rejects.toBeInstanceOf(SessionAuthorityError); expect(await snapshot(f.admin, f.database)).toEqual(before);
      const result = await f.a.commit(admit(batch(f.session, a.fence, "unchanged admitted body"), a.proof)); expect(result.lastSeq).toBe(2);
      const cold = await f.coldSnapshot(); expect(cold.events).toHaveLength(2); expect(cold.turns).toEqual([]); expect(cold.usage_ledger).toEqual([]); expect(cold.billing_usage_facts).toEqual([]);
    });
  });

  it("takes fresh DB time only after a real canonical-row lock wait before setting expiry", async context => {
    await withFixture(context, async f => {
      const pool = actualPool(f.b), borrowed = await pool.getConnection(); let thread = 0;
      try { thread = Number((await rows(borrowed, "SELECT CONNECTION_ID() AS id"))[0]!.id); } finally { borrowed.release(); }
      const ttlMs = 100, fixed = command(f.session, 0, { ttlMs }); let pending: Promise<SessionAcquireResult> | undefined, released = false, settled = false;
      await f.admin.beginTransaction();
      try {
        await rows(f.admin, `SELECT session_id FROM ${mysql.escapeId(f.database)}.sessions WHERE session_id=? FOR UPDATE`, [f.session.id]);
        const lockTime = await dbNow(f.admin); pending = f.b.sessionAuthority.acquire(fixed); void pending.then(() => { settled = true; }, () => { settled = true; });
        for (;;) {
          f.signal.throwIfAborted();
          const waits = await rows(f.admin, `SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
            JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?`, [thread]);
          if (Number(waits[0]!.n) > 0) break;
          if (settled) throw Error("Acquire settled before reaching the owned lock wait"); await delay(5, undefined, { signal: f.signal });
        }
        while (await dbNow(f.admin) <= lockTime + ttlMs + 20) await delay(5, undefined, { signal: f.signal });
        const releasedAt = await dbNow(f.admin); await f.admin.commit(); released = true;
        const result = grant(await pending); expect(result.fence).toBe(1);
        const head = (await snapshot(f.admin, f.database)).sessions![0]!;
        expect(Number(head.authority_expires_at_db_ms)).toBeGreaterThanOrEqual(releasedAt + ttlMs);
      } finally {
        if (!released) try { await f.admin.rollback(); } catch { f.destroyAdmin(); }
        await pending?.catch(() => {});
      }
    });
  });
});
